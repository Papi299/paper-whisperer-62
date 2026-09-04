-- ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 suite 014: recoverable attachment cleanup.
--
-- Owns the database half of the durable cleanup queue. The claim under test is
-- narrow and load-bearing: **Postgres never removes the metadata that names a
-- Storage object without recording, in the same transaction, that the object
-- should be deleted.** Everything else here exists to make that claim safe —
-- ownership, path validation, idempotence, and the closed write surface that
-- stops a client manufacturing a deletion instruction of its own.
--
-- Asserted here:
--   * the queue table's shape, RLS (enabled AND forced), policy set, grants,
--     uniqueness, reason domain, auth cascade, and the deliberate ABSENCE of any
--     FK to papers/paper_attachments — a cleanup intent that cascaded away with
--     the paper would be destroyed by the statement it exists to survive;
--   * cross-account isolation on read and on acknowledgement;
--   * delete_attachment_with_cleanup: queue + metadata in one transaction, the
--     existing quota refund still firing, foreign/unknown/anonymous rejection,
--     idempotence, and fail-closed on an unsafe stored path;
--   * delete_papers_with_attachment_cleanup: all-ids-validated-before-mutation,
--     duplicate-id normalisation, papers with and without attachments, NULL
--     elements, and fail-closed on an unsafe path;
--   * queue_untracked_attachment_cleanup: the metadata-exists guard that stops a
--     valid attachment being scheduled for deletion, plus every path/ownership
--     rejection;
--   * the internal path helper's posture and its accept/reject matrix.
--
-- The EXECUTE/ownership matrix over the three new RPCs as part of the exhaustive
-- privileged surface is 003's remit, not this suite's; what is checked here is
-- their behaviour.
--
-- No Storage object is created, read or deleted by this suite — nothing in the
-- database can touch one, which is itself asserted below.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the transaction
-- and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.errcode_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := '00000';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state;
END;
$hlp$;

CREATE FUNCTION pg_temp.scalar_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_result text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  EXECUTE p_sql INTO v_result;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_result;
END;
$hlp$;

CREATE FUNCTION pg_temp.claims(p_uid text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT '{"sub":"' || p_uid || '","role":"authenticated"}';
$hlp$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- A owns two papers and three attachments; B owns one paper and one attachment.
-- The attachment INSERTs run with A's / B's claims set because the hardened
-- check_and_consume_storage_quota trigger refuses a row whose declared owner is
-- not auth.uid().
INSERT INTO auth.users (id, email) VALUES
  ('aa000000-0000-0000-0000-0000000000a0','cleanup-A@paperlume.test'),
  ('bb000000-0000-0000-0000-0000000000b0','cleanup-B@paperlume.test');

INSERT INTO public.papers (id, user_id, title, insert_order) VALUES
  ('a1000000-0000-0000-0000-0000000000a1','aa000000-0000-0000-0000-0000000000a0','Cleanup A1',1),
  ('a2000000-0000-0000-0000-0000000000a2','aa000000-0000-0000-0000-0000000000a0','Cleanup A2',2),
  ('a3000000-0000-0000-0000-0000000000a3','aa000000-0000-0000-0000-0000000000a0','Cleanup A3 (no attachments)',3),
  ('b1000000-0000-0000-0000-0000000000b1','bb000000-0000-0000-0000-0000000000b0','Cleanup B1',4);

SELECT set_config('request.jwt.claims', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'), true);
INSERT INTO public.paper_attachments (id, paper_id, user_id, file_path, file_name, file_type, size_bytes) VALUES
  ('c1000000-0000-0000-0000-0000000000c1','a1000000-0000-0000-0000-0000000000a1','aa000000-0000-0000-0000-0000000000a0',
   'aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/one.pdf','one.pdf','application/pdf',1000),
  ('c2000000-0000-0000-0000-0000000000c2','a1000000-0000-0000-0000-0000000000a1','aa000000-0000-0000-0000-0000000000a0',
   'aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/two.png','two.png','image/png',2000),
  ('c3000000-0000-0000-0000-0000000000c3','a2000000-0000-0000-0000-0000000000a2','aa000000-0000-0000-0000-0000000000a0',
   'aa000000-0000-0000-0000-0000000000a0/a2000000-0000-0000-0000-0000000000a2/three.png','three.png','image/png',4000);

SELECT set_config('request.jwt.claims', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'), true);
INSERT INTO public.paper_attachments (id, paper_id, user_id, file_path, file_name, file_type, size_bytes) VALUES
  ('d1000000-0000-0000-0000-0000000000d1','b1000000-0000-0000-0000-0000000000b1','bb000000-0000-0000-0000-0000000000b0',
   'bb000000-0000-0000-0000-0000000000b0/b1000000-0000-0000-0000-0000000000b1/b.pdf','b.pdf','application/pdf',8000);
SELECT set_config('request.jwt.claims', '', true);

SELECT plan(95);

-- ═══ 1. Queue table shape and protection ════════════════════════════════════

SELECT has_table('public', 'attachment_cleanup_queue', 'attachment_cleanup_queue exists');
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.attachment_cleanup_queue'::regclass),
  'attachment_cleanup_queue has RLS enabled');
SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.attachment_cleanup_queue'::regclass),
  'attachment_cleanup_queue has RLS forced (the owner is not exempt)');

-- The write surface is closed by BOTH policy and grant. Either alone would be a
-- single control; a future migration adding an INSERT policy to a table that
-- already granted INSERT would silently open it.
SELECT is(
  (SELECT string_agg(cmd, ',' ORDER BY cmd) FROM pg_policies
    WHERE schemaname='public' AND tablename='attachment_cleanup_queue'),
  'DELETE,SELECT',
  'attachment_cleanup_queue has exactly one SELECT and one DELETE policy — no INSERT, no UPDATE');

SELECT ok(has_table_privilege('authenticated','public.attachment_cleanup_queue','SELECT'),
  'authenticated holds SELECT on attachment_cleanup_queue');
SELECT ok(has_table_privilege('authenticated','public.attachment_cleanup_queue','DELETE'),
  'authenticated holds DELETE on attachment_cleanup_queue (acknowledgement)');
SELECT ok(NOT has_table_privilege('authenticated','public.attachment_cleanup_queue','INSERT'),
  'authenticated does NOT hold INSERT on attachment_cleanup_queue');
SELECT ok(NOT has_table_privilege('authenticated','public.attachment_cleanup_queue','UPDATE'),
  'authenticated does NOT hold UPDATE on attachment_cleanup_queue');
SELECT ok(NOT has_table_privilege('anon','public.attachment_cleanup_queue','SELECT, INSERT, UPDATE, DELETE'),
  'anon holds nothing on attachment_cleanup_queue');
SELECT ok(NOT has_table_privilege('service_role','public.attachment_cleanup_queue','SELECT, INSERT, UPDATE, DELETE'),
  'service_role holds nothing on attachment_cleanup_queue');
SELECT is(
  (SELECT count(*)::int FROM pg_class c, aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid = 'public.attachment_cleanup_queue'::regclass AND a.grantee = 0),
  0, 'PUBLIC holds nothing on attachment_cleanup_queue');

SELECT is(
  (SELECT CASE confdeltype WHEN 'c' THEN 'cascade' ELSE confdeltype::text END
     FROM pg_constraint
    WHERE contype='f' AND conrelid='public.attachment_cleanup_queue'::regclass
      AND confrelid='auth.users'::regclass),
  'cascade', 'attachment_cleanup_queue.user_id cascades from auth.users');

-- The absence that matters most. A cleanup intent must outlive the paper whose
-- deletion created it.
SELECT is(
  (SELECT count(*)::int FROM pg_constraint
    WHERE contype='f' AND conrelid='public.attachment_cleanup_queue'::regclass
      AND confrelid IN ('public.papers'::regclass,'public.paper_attachments'::regclass)),
  0, 'attachment_cleanup_queue has NO foreign key to papers or paper_attachments');

SELECT ok(
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid='public.attachment_cleanup_queue'::regclass
             AND contype='u' AND conname='attachment_cleanup_queue_user_path_unique'),
  '(user_id, file_path) is UNIQUE — repeated intent is one job');

SELECT is(
  pg_temp.errcode_as('postgres','',
    $q$INSERT INTO public.attachment_cleanup_queue (user_id, file_path, reason)
       VALUES ('aa000000-0000-0000-0000-0000000000a0','aa000000-0000-0000-0000-0000000000a0/p/x','not_a_reason')$q$),
  '23514', 'reason is confined to the declared domain by a CHECK');

-- ═══ 2. Cross-account isolation on the queue ════════════════════════════════
-- Two rows planted as the owner (the only writer), one per account.

INSERT INTO public.attachment_cleanup_queue (id, user_id, file_path, reason) VALUES
  ('e1000000-0000-0000-0000-0000000000e1','aa000000-0000-0000-0000-0000000000a0',
   'aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/planted-a.pdf','paper_delete'),
  ('e2000000-0000-0000-0000-0000000000e2','bb000000-0000-0000-0000-0000000000b0',
   'bb000000-0000-0000-0000-0000000000b0/b1000000-0000-0000-0000-0000000000b1/planted-b.pdf','paper_delete');

SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT count(*)::text FROM public.attachment_cleanup_queue$q$),
  '1', 'A sees exactly its own queue row');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT count(*)::text FROM public.attachment_cleanup_queue
        WHERE user_id = 'bb000000-0000-0000-0000-0000000000b0'$q$),
  '0', 'A cannot read B''s queue row (no cross-account file paths)');
SELECT is(
  pg_temp.errcode_as('anon','', $q$SELECT count(*) FROM public.attachment_cleanup_queue$q$),
  '42501', 'anon is denied at the ACL, before any policy is consulted');

-- A direct INSERT is refused at the grant, so a client cannot manufacture a
-- deletion instruction for a path it merely knows.
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$INSERT INTO public.attachment_cleanup_queue (user_id, file_path, reason)
       VALUES ('aa000000-0000-0000-0000-0000000000a0',
               'aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/one.pdf','paper_delete')$q$),
  '42501', 'authenticated cannot INSERT a queue row directly — not even for its own live attachment');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$UPDATE public.attachment_cleanup_queue SET file_path = 'x' WHERE user_id = 'aa000000-0000-0000-0000-0000000000a0'$q$),
  '42501', 'authenticated cannot UPDATE a queue row directly');

-- Acknowledgement is scoped: B deleting "everything" removes only B's row.
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'),
    $q$DELETE FROM public.attachment_cleanup_queue$q$),
  '00000', 'B may acknowledge its own queue rows');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue WHERE id='e1000000-0000-0000-0000-0000000000e1'),
  1, 'B''s unrestricted DELETE left A''s queue row untouched');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue WHERE id='e2000000-0000-0000-0000-0000000000e2'),
  0, 'B''s own queue row really was acknowledged');

DELETE FROM public.attachment_cleanup_queue;

-- ═══ 3. delete_attachment_with_cleanup ══════════════════════════════════════

SELECT is(
  (SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='aa000000-0000-0000-0000-0000000000a0'),
  '7000', 'baseline: A''s storage usage reflects its three attachments');

SELECT is(
  pg_temp.errcode_as('authenticated','',
    $q$SELECT public.delete_attachment_with_cleanup('c1000000-0000-0000-0000-0000000000c1'::uuid)$q$),
  'P0001', 'delete_attachment_with_cleanup: null-auth caller rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'),
    $q$SELECT public.delete_attachment_with_cleanup('c1000000-0000-0000-0000-0000000000c1'::uuid)$q$),
  'P0001', 'delete_attachment_with_cleanup: foreign attachment id rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT public.delete_attachment_with_cleanup('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)$q$),
  'P0001', 'delete_attachment_with_cleanup: unknown attachment id fails closed');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT public.delete_attachment_with_cleanup(NULL::uuid)$q$),
  'P0001', 'delete_attachment_with_cleanup: NULL attachment id rejected');
SELECT is(
  (SELECT count(*)::int FROM public.paper_attachments),
  4, 'every rejected call deleted nothing');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue),
  0, 'every rejected call queued nothing');

-- The success path.
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT public.delete_attachment_with_cleanup('c1000000-0000-0000-0000-0000000000c1'::uuid)$q$),
  '00000', 'delete_attachment_with_cleanup: owned attachment accepted');
SELECT is(
  (SELECT count(*)::int FROM public.paper_attachments WHERE id='c1000000-0000-0000-0000-0000000000c1'),
  0, 'the metadata row is gone');
SELECT is(
  (SELECT user_id::text || '|' || file_path || '|' || reason FROM public.attachment_cleanup_queue),
  'aa000000-0000-0000-0000-0000000000a0|aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/one.pdf|attachment_delete',
  'exactly one queue row, owned by the caller, naming that path, reason attachment_delete');
SELECT is(
  (SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='aa000000-0000-0000-0000-0000000000a0'),
  '6000', 'the existing AFTER DELETE refund trigger still fired — quota semantics unchanged');
SELECT is(
  (SELECT count(*)::int FROM public.paper_attachments WHERE id IN
     ('c2000000-0000-0000-0000-0000000000c2','c3000000-0000-0000-0000-0000000000c3','d1000000-0000-0000-0000-0000000000d1')),
  3, 'unrelated attachments — the caller''s and B''s — are untouched');

-- Idempotence of the intent: a second attachment sharing the SAME path (which
-- the product never creates, but which the queue must survive) adds no second
-- job. Inserted with A's claims so the ownership trigger accepts it.
SELECT set_config('request.jwt.claims', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'), true);
INSERT INTO public.paper_attachments (id, paper_id, user_id, file_path, file_name, file_type, size_bytes) VALUES
  ('c4000000-0000-0000-0000-0000000000c4','a1000000-0000-0000-0000-0000000000a1','aa000000-0000-0000-0000-0000000000a0',
   'aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/one.pdf','one.pdf','application/pdf',1000);
SELECT set_config('request.jwt.claims', '', true);
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT public.delete_attachment_with_cleanup('c4000000-0000-0000-0000-0000000000c4'::uuid)$q$),
  '00000', 'delete_attachment_with_cleanup: repeated intent for the same path is accepted');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue),
  1, 'repeated intent produced no duplicate job');

DELETE FROM public.attachment_cleanup_queue;

-- Fail-closed on an unsafe stored path. Planted directly as the owner, because
-- no client path can create one.
SELECT set_config('request.jwt.claims', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'), true);
INSERT INTO public.paper_attachments (id, paper_id, user_id, file_path, file_name, file_type, size_bytes) VALUES
  ('c5000000-0000-0000-0000-0000000000c5','a1000000-0000-0000-0000-0000000000a1','aa000000-0000-0000-0000-0000000000a0',
   'bb000000-0000-0000-0000-0000000000b0/b1000000-0000-0000-0000-0000000000b1/stolen.pdf','stolen.pdf','application/pdf',1);
SELECT set_config('request.jwt.claims', '', true);
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT public.delete_attachment_with_cleanup('c5000000-0000-0000-0000-0000000000c5'::uuid)$q$),
  'P0001', 'delete_attachment_with_cleanup: a stored path in ANOTHER user''s namespace is refused');
SELECT is(
  (SELECT count(*)::int FROM public.paper_attachments WHERE id='c5000000-0000-0000-0000-0000000000c5'),
  1, 'the refused call committed no metadata deletion');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue),
  0, 'the refused call queued nothing — no cross-user path can enter the queue');

DELETE FROM public.paper_attachments WHERE id='c5000000-0000-0000-0000-0000000000c5';
DELETE FROM public.attachment_cleanup_queue;

-- ═══ 4. delete_papers_with_attachment_cleanup ═══════════════════════════════

SELECT is(
  pg_temp.errcode_as('authenticated','',
    $q$SELECT * FROM public.delete_papers_with_attachment_cleanup(ARRAY['a1000000-0000-0000-0000-0000000000a1']::uuid[])$q$),
  'P0001', 'delete_papers_with_attachment_cleanup: null-auth caller rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT * FROM public.delete_papers_with_attachment_cleanup(NULL::uuid[])$q$),
  'P0001', 'delete_papers_with_attachment_cleanup: NULL array rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT * FROM public.delete_papers_with_attachment_cleanup(ARRAY['a1000000-0000-0000-0000-0000000000a1',NULL]::uuid[])$q$),
  'P0001', 'delete_papers_with_attachment_cleanup: a NULL element is malformed input, not "no paper"');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT * FROM public.delete_papers_with_attachment_cleanup(ARRAY['a1000000-0000-0000-0000-0000000000a1','b1000000-0000-0000-0000-0000000000b1']::uuid[])$q$),
  'P0001', 'delete_papers_with_attachment_cleanup: one foreign id among owned ids rejects the whole call');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT * FROM public.delete_papers_with_attachment_cleanup(ARRAY['ffffffff-ffff-ffff-ffff-ffffffffffff']::uuid[])$q$),
  'P0001', 'delete_papers_with_attachment_cleanup: an unknown id fails closed');
SELECT is(
  (SELECT count(*)::int FROM public.papers), 4,
  'no rejected call deleted a paper');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue), 0,
  'no rejected call queued anything');

-- Empty selection is a no-op, not an error.
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT deleted_count::text || '|' || queued_count::text
         FROM public.delete_papers_with_attachment_cleanup(ARRAY[]::uuid[])$q$),
  '0|0', 'delete_papers_with_attachment_cleanup: an empty selection deletes and queues nothing');

-- A paper with no attachments.
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT deleted_count::text || '|' || queued_count::text
         FROM public.delete_papers_with_attachment_cleanup(ARRAY['a3000000-0000-0000-0000-0000000000a3']::uuid[])$q$),
  '1|0', 'a paper with no attachments deletes and queues nothing');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue), 0,
  'no phantom queue row for an attachment-free paper');

-- Several papers at once, with a duplicate id in the request.
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT deleted_count::text || '|' || queued_count::text
         FROM public.delete_papers_with_attachment_cleanup(
           ARRAY['a1000000-0000-0000-0000-0000000000a1',
                 'a1000000-0000-0000-0000-0000000000a1',
                 'a2000000-0000-0000-0000-0000000000a2']::uuid[])$q$),
  '2|2', 'duplicate ids normalise: two papers deleted, their two remaining attachment paths queued');
-- Two, not three: section 3 already deleted `one.pdf`'s metadata (twice — the
-- original and the same-path duplicate), so paper A1 carries only `two.png` by
-- the time this runs. Spelling the survivors out is the point: the queue must
-- name exactly the paths the cascade is about to make unreachable, and no more.
SELECT is(
  (SELECT string_agg(file_path, ',' ORDER BY file_path) FROM public.attachment_cleanup_queue),
  'aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/two.png,'
  'aa000000-0000-0000-0000-0000000000a0/a2000000-0000-0000-0000-0000000000a2/three.png',
  'every attachment path of every deleted paper is queued, exactly once each');
SELECT is(
  (SELECT count(DISTINCT reason)::int || ':' || max(reason) FROM public.attachment_cleanup_queue),
  '1:paper_delete', 'all of them carry reason paper_delete');
SELECT is(
  (SELECT count(*)::int FROM public.paper_attachments WHERE user_id='aa000000-0000-0000-0000-0000000000a0'),
  0, 'attachment metadata cascaded away with the papers');
SELECT is(
  (SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='aa000000-0000-0000-0000-0000000000a0'),
  '0', 'the cascade still refunded storage quota through the existing trigger');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue WHERE user_id <> 'aa000000-0000-0000-0000-0000000000a0'),
  0, 'no queue row belongs to anyone but the caller');
SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE user_id='bb000000-0000-0000-0000-0000000000b0'),
  1, 'B''s paper is untouched');

DELETE FROM public.attachment_cleanup_queue;

-- Fail-closed on an unsafe attachment path anywhere in the selection.
SELECT set_config('request.jwt.claims', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'), true);
INSERT INTO public.paper_attachments (id, paper_id, user_id, file_path, file_name, file_type, size_bytes) VALUES
  ('d2000000-0000-0000-0000-0000000000d2','b1000000-0000-0000-0000-0000000000b1','bb000000-0000-0000-0000-0000000000b0',
   'bb000000-0000-0000-0000-0000000000b0/../escape.pdf','escape.pdf','application/pdf',1);
SELECT set_config('request.jwt.claims', '', true);
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'),
    $q$SELECT * FROM public.delete_papers_with_attachment_cleanup(ARRAY['b1000000-0000-0000-0000-0000000000b1']::uuid[])$q$),
  'P0001', 'delete_papers_with_attachment_cleanup: a traversal path anywhere in the set refuses the whole call');
SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE id='b1000000-0000-0000-0000-0000000000b1'),
  1, 'the refused call committed no paper deletion');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue), 0,
  'the refused call queued nothing');

DELETE FROM public.paper_attachments WHERE id='d2000000-0000-0000-0000-0000000000d2';

-- ═══ 5. queue_untracked_attachment_cleanup ══════════════════════════════════

SELECT is(
  pg_temp.errcode_as('authenticated','',
    $q$SELECT public.queue_untracked_attachment_cleanup('b1000000-0000-0000-0000-0000000000b1'::uuid,
      'bb000000-0000-0000-0000-0000000000b0/b1000000-0000-0000-0000-0000000000b1/new.pdf')$q$),
  'P0001', 'queue_untracked_attachment_cleanup: null-auth caller rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'),
    $q$SELECT public.queue_untracked_attachment_cleanup('b1000000-0000-0000-0000-0000000000b1'::uuid,
      'aa000000-0000-0000-0000-0000000000a0/b1000000-0000-0000-0000-0000000000b1/new.pdf')$q$),
  'P0001', 'queue_untracked_attachment_cleanup: a foreign paper is rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'),
    $q$SELECT public.queue_untracked_attachment_cleanup('b1000000-0000-0000-0000-0000000000b1'::uuid,
      'aa000000-0000-0000-0000-0000000000a0/b1000000-0000-0000-0000-0000000000b1/new.pdf')$q$),
  'P0001', 'queue_untracked_attachment_cleanup: a path in another user''s namespace is rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'),
    $q$SELECT public.queue_untracked_attachment_cleanup('b1000000-0000-0000-0000-0000000000b1'::uuid,
      'bb000000-0000-0000-0000-0000000000b0/a1000000-0000-0000-0000-0000000000a1/new.pdf')$q$),
  'P0001', 'queue_untracked_attachment_cleanup: a path under a DIFFERENT paper than the one named is rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'),
    $q$SELECT public.queue_untracked_attachment_cleanup('b1000000-0000-0000-0000-0000000000b1'::uuid,
      'bb000000-0000-0000-0000-0000000000b0/b1000000-0000-0000-0000-0000000000b1/../../escape.pdf')$q$),
  'P0001', 'queue_untracked_attachment_cleanup: a traversal path is rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'),
    $q$SELECT public.queue_untracked_attachment_cleanup('b1000000-0000-0000-0000-0000000000b1'::uuid, '')$q$),
  'P0001', 'queue_untracked_attachment_cleanup: an empty path is rejected');
SELECT is(
  pg_temp.errcode_as('anon','',
    $q$SELECT public.queue_untracked_attachment_cleanup('b1000000-0000-0000-0000-0000000000b1'::uuid,
      'bb000000-0000-0000-0000-0000000000b0/b1000000-0000-0000-0000-0000000000b1/new.pdf')$q$),
  '42501', 'queue_untracked_attachment_cleanup: anon is denied at the ACL');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue), 0,
  'no rejected compensation call queued anything');

-- The metadata-exists guard: this path IS a live attachment, so nothing queues.
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'),
    $q$SELECT public.queue_untracked_attachment_cleanup('b1000000-0000-0000-0000-0000000000b1'::uuid,
      'bb000000-0000-0000-0000-0000000000b0/b1000000-0000-0000-0000-0000000000b1/b.pdf')$q$),
  'metadata_present',
  'queue_untracked_attachment_cleanup: a path with a live metadata row reports metadata_present');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue), 0,
  'and queues NOTHING — a valid attachment is never scheduled for deletion');

-- The genuine compensation case.
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'),
    $q$SELECT public.queue_untracked_attachment_cleanup('b1000000-0000-0000-0000-0000000000b1'::uuid,
      'bb000000-0000-0000-0000-0000000000b0/b1000000-0000-0000-0000-0000000000b1/orphan.pdf')$q$),
  'queued', 'queue_untracked_attachment_cleanup: an untracked path is queued');
SELECT is(
  (SELECT user_id::text || '|' || file_path || '|' || reason FROM public.attachment_cleanup_queue),
  'bb000000-0000-0000-0000-0000000000b0|bb000000-0000-0000-0000-0000000000b0/b1000000-0000-0000-0000-0000000000b1/orphan.pdf|upload_compensation',
  'the row is owned by the caller and carries reason upload_compensation');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'),
    $q$SELECT public.queue_untracked_attachment_cleanup('b1000000-0000-0000-0000-0000000000b1'::uuid,
      'bb000000-0000-0000-0000-0000000000b0/b1000000-0000-0000-0000-0000000000b1/orphan.pdf')$q$),
  'queued', 'a repeated compensation call still reports queued');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue), 1,
  'and remains exactly one row — idempotent through the uniqueness');

-- ═══ 6. The internal path helper ════════════════════════════════════════════

SELECT ok(
  NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.attachment_cleanup_path_is_safe(uuid,text,uuid)'::regprocedure),
  'attachment_cleanup_path_is_safe is SECURITY INVOKER — it reads nothing and needs no privilege');
SELECT ok(
  NOT has_function_privilege('authenticated','public.attachment_cleanup_path_is_safe(uuid,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.attachment_cleanup_path_is_safe(uuid,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('service_role','public.attachment_cleanup_path_is_safe(uuid,text,uuid)','EXECUTE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid='public.attachment_cleanup_path_is_safe(uuid,text,uuid)'::regprocedure
       AND a.grantee=0 AND a.privilege_type='EXECUTE'),
  'attachment_cleanup_path_is_safe is callable by nobody but its owner');

-- The accept/reject matrix, stated as data. `expected` is what a correct
-- implementation must answer for a caller whose id is …a0.
SELECT is(
  public.attachment_cleanup_path_is_safe('aa000000-0000-0000-0000-0000000000a0'::uuid, v.path, v.paper),
  v.expected,
  'path helper: ' || v.label
) FROM (VALUES
  ('canonical product path',
   'aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/f.png', NULL::uuid, true),
  ('canonical path with the paper pinned',
   'aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/f.png',
   'a1000000-0000-0000-0000-0000000000a1'::uuid, true),
  ('a name containing spaces and unicode is still a valid object key',
   'aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/holiday photo é.png', NULL::uuid, true),
  ('another user''s namespace',
   'bb000000-0000-0000-0000-0000000000b0/a1000000-0000-0000-0000-0000000000a1/f.png', NULL::uuid, false),
  ('a different paper than the one pinned',
   'aa000000-0000-0000-0000-0000000000a0/a2000000-0000-0000-0000-0000000000a2/f.png',
   'a1000000-0000-0000-0000-0000000000a1'::uuid, false),
  ('parent traversal',
   'aa000000-0000-0000-0000-0000000000a0/../f.png', NULL::uuid, false),
  ('current-directory segment',
   'aa000000-0000-0000-0000-0000000000a0/./f.png', NULL::uuid, false),
  ('absolute path',
   '/aa000000-0000-0000-0000-0000000000a0/a1/f.png', NULL::uuid, false),
  ('collapsed empty segment',
   'aa000000-0000-0000-0000-0000000000a0//f.png', NULL::uuid, false),
  ('trailing separator',
   'aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/', NULL::uuid, false),
  ('backslash separator trick',
   'aa000000-0000-0000-0000-0000000000a0/a1\..\..\f.png', NULL::uuid, false),
  ('newline injected into the key',
   E'aa000000-0000-0000-0000-0000000000a0/a1/f\n.png', NULL::uuid, false),
  ('too few segments',
   'aa000000-0000-0000-0000-0000000000a0/f.png', NULL::uuid, false),
  ('too many segments',
   'aa000000-0000-0000-0000-0000000000a0/a1/b/f.png', NULL::uuid, false),
  ('empty string',
   '', NULL::uuid, false),
  ('a prefix that merely STARTS with the caller id',
   'aa000000-0000-0000-0000-0000000000a0x/a1/f.png', NULL::uuid, false)
) AS v(label, path, paper, expected);

SELECT is(
  public.attachment_cleanup_path_is_safe(NULL::uuid,
    'aa000000-0000-0000-0000-0000000000a0/a1/f.png', NULL::uuid),
  false, 'path helper: a NULL caller id is never safe');
SELECT is(
  public.attachment_cleanup_path_is_safe('aa000000-0000-0000-0000-0000000000a0'::uuid, NULL, NULL::uuid),
  false, 'path helper: a NULL path is never safe');

-- ═══ 7. Nothing in the database can reach Storage ═══════════════════════════
-- The architectural claim the whole design rests on: physical removal belongs to
-- the authenticated browser session, never to a privileged database function.
SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN ('delete_attachment_with_cleanup',
                        'delete_papers_with_attachment_cleanup',
                        'queue_untracked_attachment_cleanup',
                        'attachment_cleanup_path_is_safe')
      AND p.prosrc ~* '(\mstorage[[:space:]]*\.|"storage"[[:space:]]*\.)'),
  0, 'no attachment-cleanup function references the storage schema');

SELECT * FROM finish();
ROLLBACK;
