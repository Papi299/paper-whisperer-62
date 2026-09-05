-- PFA-C03B1 comprehensive database-security suite 002: relational RLS isolation.
--
-- Proves both-owner integrity and per-user isolation on the relationship tables:
--   paper_projects · paper_tags · paper_attachments
--
-- The full ownership matrix (own/own, own/foreign, foreign/own, foreign/foreign)
-- is exercised per table with deterministic own and foreign objects for users A
-- and B. paper_projects / paper_tags reject a cross-owner INSERT at the both-
-- owner RLS WITH CHECK (42501); paper_attachments rejects a mismatched owner or
-- foreign referenced paper at the BEFORE-INSERT ownership trigger (P0001), before
-- any storage quota is consumed. Cross-owner rows are invisible, undeletable, and
-- (for the junctions) not updatable by another user.
--
-- This overlaps the accepted focused suite 000 only where needed to keep suite
-- 002 independently understandable; it does not copy the full 139-assertion file.
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

CREATE FUNCTION pg_temp.rowcount_as(p_role text, p_claims text, p_sql text)
RETURNS integer LANGUAGE plpgsql AS $hlp$
DECLARE v_rows integer;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  EXECUTE p_sql;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_rows;
END;
$hlp$;

-- ── Fixtures (as superuser) ──────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('aa000000-0000-0000-0000-000000000001','rel-A@paperlume.test'),
  ('bb000000-0000-0000-0000-000000000002','rel-B@paperlume.test');
INSERT INTO public.papers (id, user_id, title, insert_order) VALUES
  ('a0000000-0000-0000-0000-0000000000a1','aa000000-0000-0000-0000-000000000001','Paper A',1),
  ('b0000000-0000-0000-0000-0000000000b1','bb000000-0000-0000-0000-000000000002','Paper B',2);
INSERT INTO public.projects (id, user_id, name) VALUES
  ('a0000000-0000-0000-0000-0000000000a2','aa000000-0000-0000-0000-000000000001','Project A'),
  ('b0000000-0000-0000-0000-0000000000b2','bb000000-0000-0000-0000-000000000002','Project B');
INSERT INTO public.tags (id, user_id, name) VALUES
  ('a0000000-0000-0000-0000-0000000000a3','aa000000-0000-0000-0000-000000000001','Tag A'),
  ('b0000000-0000-0000-0000-0000000000b3','bb000000-0000-0000-0000-000000000002','Tag B');

SELECT plan(29);

-- ══ paper_projects (both-owner RLS) ══════════════════════════════════════════
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_projects(paper_id,project_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2')$q$),
  '00000', 'paper_projects: own paper + own project allowed (positive control)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_projects(paper_id,project_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','b0000000-0000-0000-0000-0000000000b2')$q$),
  '42501', 'paper_projects: own paper + foreign project rejected');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_projects(paper_id,project_id) VALUES ('b0000000-0000-0000-0000-0000000000b1','a0000000-0000-0000-0000-0000000000a2')$q$),
  '42501', 'paper_projects: foreign paper + own project rejected');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_projects(paper_id,project_id) VALUES ('b0000000-0000-0000-0000-0000000000b1','b0000000-0000-0000-0000-0000000000b2')$q$),
  '42501', 'paper_projects: foreign paper + foreign project rejected');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '1', 'paper_projects: A sees own relationship (positive control)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '0', 'paper_projects: B cannot see A''s cross-owner relationship');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  0, 'paper_projects: B cannot delete A''s relationship (0 rows)');
SELECT is(
  (SELECT count(*)::int FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'),
  1, 'paper_projects: A''s relationship survives B''s delete attempt');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$UPDATE public.paper_projects SET project_id='b0000000-0000-0000-0000-0000000000b2' WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501', 'paper_projects: another user cannot UPDATE/replace ownership indirectly (no privilege)');

-- ══ paper_tags (both-owner RLS, symmetric) ═══════════════════════════════════
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_tags(paper_id,tag_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a3')$q$),
  '00000', 'paper_tags: own paper + own tag allowed (positive control)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_tags(paper_id,tag_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','b0000000-0000-0000-0000-0000000000b3')$q$),
  '42501', 'paper_tags: own paper + foreign tag rejected');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_tags(paper_id,tag_id) VALUES ('b0000000-0000-0000-0000-0000000000b1','a0000000-0000-0000-0000-0000000000a3')$q$),
  '42501', 'paper_tags: foreign paper + own tag rejected');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_tags(paper_id,tag_id) VALUES ('b0000000-0000-0000-0000-0000000000b1','b0000000-0000-0000-0000-0000000000b3')$q$),
  '42501', 'paper_tags: foreign paper + foreign tag rejected');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '1', 'paper_tags: A sees own relationship (positive control)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '0', 'paper_tags: B cannot see A''s cross-owner relationship');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  0, 'paper_tags: B cannot delete A''s relationship (0 rows)');
SELECT is(
  (SELECT count(*)::int FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'),
  1, 'paper_tags: A''s relationship survives B''s delete attempt');

-- ══ paper_attachments (ownership trigger + storage accounting) ═══════════════
--
-- The four write cases below run as `postgres`, not as `authenticated`. Since
-- migration 20260904120000 no browser role holds INSERT/UPDATE/DELETE here, so a
-- direct client write is refused at the ACL before the ownership trigger is
-- consulted — these cases would then pass while testing nothing. The writer that
-- remains is the table owner, which is who the SECURITY DEFINER lifecycle RPCs
-- execute as, so it is exactly who the trigger has to hold against now. The two
-- client-facing assertions that follow them are new: the ACL boundary itself,
-- and cross-user isolation re-proved through the RPC that replaced the direct
-- DELETE.
SELECT is(pg_temp.errcode_as('postgres','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('a0000000-0000-0000-0000-0000000000a1','aa000000-0000-0000-0000-000000000001','a/ok.pdf','ok.pdf','application/pdf',1000)$q$),
  '00000', 'paper_attachments: own attachment on own paper allowed (positive control)');
SELECT is(pg_temp.errcode_as('postgres','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('b0000000-0000-0000-0000-0000000000b1','aa000000-0000-0000-0000-000000000001','a/x.pdf','x.pdf','application/pdf',100)$q$),
  'P0001', 'paper_attachments: own user_id + foreign paper_id rejected (trigger)');
SELECT is(pg_temp.errcode_as('postgres','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('a0000000-0000-0000-0000-0000000000a1','bb000000-0000-0000-0000-000000000002','a/y.pdf','y.pdf','application/pdf',100)$q$),
  'P0001', 'paper_attachments: foreign user_id + own paper rejected (trigger)');
SELECT is(pg_temp.errcode_as('postgres','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('b0000000-0000-0000-0000-0000000000b1','bb000000-0000-0000-0000-000000000002','a/z.pdf','z.pdf','application/pdf',100)$q$),
  'P0001', 'paper_attachments: foreign user_id + foreign paper rejected (trigger)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_attachments WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '1', 'paper_attachments: A views own attachment metadata (positive control)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_attachments WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '0', 'paper_attachments: B cannot view A''s attachment metadata');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.paper_attachments WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501', 'paper_attachments: B cannot delete A''s attachment metadata — no browser role holds DELETE at all');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.paper_attachments WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501', 'paper_attachments: nor can A, on her own row — deletion is the lifecycle RPC''s to perform');
-- Cross-user isolation, re-proved on the path that replaced the direct DELETE.
-- The grant boundary above refuses everyone equally, which is a weaker statement
-- than the one this suite exists to make; the RPC is where owner separation now
-- lives, so that is where it is asserted.
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT public.delete_attachment_with_cleanup(
       (SELECT id FROM public.paper_attachments WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'))$q$),
  'P0001', 'paper_attachments: B cannot delete A''s attachment through the lifecycle RPC either');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue), 0,
  'paper_attachments: B''s refused RPC call queued no cleanup for A''s object');
SELECT is(
  (SELECT count(*)::int FROM public.paper_attachments WHERE user_id='aa000000-0000-0000-0000-000000000001'),
  1, 'paper_attachments: rejected combinations created no row (only the one valid attachment exists)');
SELECT is(
  (SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='aa000000-0000-0000-0000-000000000001'),
  '1000', 'paper_attachments: rejected combinations did not change storage accounting');

SELECT * FROM finish();
ROLLBACK;
