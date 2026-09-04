-- PFA-C03B1 comprehensive database-security suite 003: RPC caller scope + grants.
--
-- Inventories the complete public SECURITY DEFINER surface and pins least-
-- privilege EXECUTE and caller-identity boundaries:
--   * exactly 37 SECURITY DEFINER functions (30 directly callable + 5 trigger-
--     only + 2 internal-only); no unexpected privileged function or overload;
--   * directly-callable RPCs: {authenticated} EXECUTE only — no PUBLIC / anon /
--     service_role; owner retained;
--   * trigger-only functions: not client-executable and not service_role-
--     executable; owner retained;
--   * caller identity: null-auth and mismatched caller rejected, valid caller
--     accepted, for the four read RPCs, safe_bulk_insert_papers, and the three
--     AI-quota RPCs;
--   * representative caller/ownership boundaries for the setter, bulk-update,
--     dedup, and access RPCs;
--   * search_papers bounded search_path; exactly one overload of each hardened
--     RPC (no bypass overload).
--
-- merge_exact_duplicates is exercised here ONLY for its authenticated posture,
-- null-auth rejection, caller/ownership rejection, and no-unauthorized-mutation,
-- which is this suite's remit. Its successful merge path — data preservation,
-- JSONB list union, attachment re-parenting and the full input-validation
-- contract — is owned by 005_merge_exact_duplicates_success.test.sql.
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

-- The complete directly-callable SECURITY DEFINER RPC surface (30).
CREATE FUNCTION pg_temp.client_rpcs() RETURNS SETOF text LANGUAGE sql AS $hlp$
  SELECT unnest(ARRAY[
    'public.bulk_set_paper_projects(uuid[],uuid[])',
    'public.bulk_set_paper_tags(uuid[],uuid[])',
    'public.bulk_update_keywords(jsonb)',
    'public.bulk_update_study_types(jsonb)',
    'public.consume_ai_quota(uuid)',
    'public.filter_papers_by_keywords(uuid,text[])',
    'public.get_ai_quota_status(uuid)',
    'public.get_current_user_access()',
    'public.get_duplicate_papers()',
    'public.get_keyword_options(uuid,uuid[],integer,integer,text[])',
    'public.merge_exact_duplicates(uuid,uuid[])',
    'public.refund_ai_quota(uuid)',
    'public.safe_bulk_insert_papers(uuid,jsonb)',
    'public.search_papers(uuid,text,integer,integer)',
    'public.search_papers_short(uuid,text)',
    'public.set_paper_projects(uuid,uuid[])',
    'public.set_paper_tags(uuid,uuid[])',
    -- AUTHOR-IDENTITY-RESOLUTION-001C. Every identity decision that must be
    -- validated against current paper state or the merge graph is an RPC, so all
    -- six belong in this matrix.
    'public.create_author_identity_from_mention(uuid,integer,text,text,boolean)',
    'public.link_author_mention_to_identity(uuid,integer,text,uuid,text,boolean)',
    'public.unlink_author_mention_identity(uuid,integer)',
    'public.merge_author_identities(uuid,uuid)',
    'public.unmerge_author_identity(uuid)',
    'public.delete_empty_author_identity(uuid)',
    -- AI-MODEL-SELECTION-001A. Both derive the caller from auth.uid() and take
    -- no user id at all, so they belong to the same least-privilege matrix.
    'public.set_current_user_ai_model(text)',
    'public.clear_current_user_ai_model()',
    -- CHROME-EXTENSION-IMPORT-001D. The additive counterparts to the two
    -- bulk_set_* setters, for papers that already exist. Same least-privilege
    -- posture as every other client RPC; their additive/idempotent/fail-closed
    -- behaviour is owned by 013_import_duplicate_resolution.test.sql.
    'public.bulk_add_paper_projects(uuid[],uuid[])',
    'public.bulk_add_paper_tags(uuid[],uuid[])',
    -- ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001. All three derive the caller from
    -- auth.uid(), take no user id at all, and write the durable cleanup queue in
    -- the same transaction as the logical deletion — or, for
    -- finalize_attachment_upload, the rejected metadata insert — that made the
    -- object garbage. Their behaviour is owned by
    -- 014_attachment_cleanup_recovery.test.sql; what they owe this suite is the
    -- same least-privilege posture as every other client RPC.
    'public.delete_attachment_with_cleanup(uuid)',
    'public.delete_papers_with_attachment_cleanup(uuid[])',
    'public.finalize_attachment_upload(uuid,text,text,text,integer)'
  ]);
$hlp$;

-- The five trigger-only SECURITY DEFINER functions.
-- Internal 001C helpers: called only from inside other SECURITY DEFINER
-- functions, which execute as the owner, so no role needs EXECUTE on them. Same
-- required posture as a trigger-only function, different reason for it.
CREATE FUNCTION pg_temp.internal_fns() RETURNS SETOF text LANGUAGE sql AS $hlp$
  SELECT * FROM (VALUES
    ('public.author_identity_effective_root(uuid,uuid)'),
    ('public.validate_author_mention_for_identity(uuid,uuid,integer,text)')
  ) v(sig)
$hlp$;

CREATE FUNCTION pg_temp.trigger_fns() RETURNS SETOF text LANGUAGE sql AS $hlp$
  SELECT unnest(ARRAY[
    'public.check_and_consume_storage_quota()',
    'public.handle_new_user()',
    'public.refund_storage_quota()',
    -- ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001-CORRECTION-01 tombstone. SECURITY
    -- DEFINER so the cleanup queue is fully visible whichever role is inserting,
    -- which is exactly why no role may call it directly.
    'public.reject_attachment_over_cleanup_intent()',
    -- 001C stale-link invalidation. SECURITY DEFINER because clients hold no
    -- DELETE on author_identity_links, so no role may be able to call it as a
    -- general-purpose privileged delete.
    'public.clear_author_identity_links_on_authors_change()'
  ]);
$hlp$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('aa000000-0000-0000-0000-000000000001','rpc-A@paperlume.test'),
  ('bb000000-0000-0000-0000-000000000002','rpc-B@paperlume.test');
-- Papers for A (a1, a5) and B (b1). A1 and B1 deliberately share the SAME non-null
-- PMID ('PM_SHARED_C03B1'); this is valid because the unique pmid index is PER
-- USER, so it never collides across owners. A correct caller-scoped
-- get_duplicate_papers groups only within the caller's own papers, so this shared
-- cross-user PMID must NOT form a duplicate group for either caller — an isolation
-- detector: a globally-grouping implementation would surface the shared-PMID group
-- and one caller would receive the other's paper. Exactly one PMID-bearing paper
-- per user (a5 keeps pmid NULL).
INSERT INTO public.papers (id, user_id, title, pmid, keywords, study_type, insert_order) VALUES
  ('a0000000-0000-0000-0000-0000000000a1','aa000000-0000-0000-0000-000000000001','Paper A1','PM_SHARED_C03B1','[]'::jsonb,NULL,1),
  ('a0000000-0000-0000-0000-0000000000a5','aa000000-0000-0000-0000-000000000001','Paper A2',NULL,'[]'::jsonb,NULL,2),
  ('b0000000-0000-0000-0000-0000000000b1','bb000000-0000-0000-0000-000000000002','Paper B','PM_SHARED_C03B1',' ["original"]'::jsonb,'orig',3);
INSERT INTO public.projects (id, user_id, name) VALUES
  ('a0000000-0000-0000-0000-0000000000a2','aa000000-0000-0000-0000-000000000001','Project A'),
  ('b0000000-0000-0000-0000-0000000000b2','bb000000-0000-0000-0000-000000000002','Project B');
INSERT INTO public.tags (id, user_id, name) VALUES
  ('a0000000-0000-0000-0000-0000000000a3','aa000000-0000-0000-0000-000000000001','Tag A'),
  ('b0000000-0000-0000-0000-0000000000b3','bb000000-0000-0000-0000-000000000002','Tag B');

SELECT plan(241);

-- ══ 1. Inventory: exactly 36 SECURITY DEFINER functions, none unexpected ═════
-- 20 before AUTHOR-IDENTITY-RESOLUTION-001C, which added six client RPCs, two
-- internal helpers and one trigger function; 31 after AI-MODEL-SELECTION-001A
-- added set_current_user_ai_model and clear_current_user_ai_model; 33 after
-- CHROME-EXTENSION-IMPORT-001D added bulk_add_paper_projects and
-- bulk_add_paper_tags; 36 after ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 added
-- delete_attachment_with_cleanup, delete_papers_with_attachment_cleanup and one
-- upload RPC; 37 after its CORRECTION-01 added the
-- reject_attachment_over_cleanup_intent trigger function. The directly-callable
-- count is still 30: the upload RPC was REPLACED, not added to —
-- queue_untracked_attachment_cleanup gave way to finalize_attachment_upload,
-- whose atomic, serialized contract the old one could not provide. That
-- feature's remaining function, attachment_cleanup_path_is_safe, is deliberately
-- NOT here: it is SECURITY INVOKER and reads nothing, so it is out of this
-- inventory's remit by definition — its posture is pinned by suites 007 and 014.
-- The count is deliberately exact: a new definer function that nobody registered
-- here is the single easiest way to widen the privileged surface unnoticed.
SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prosecdef),
  37, 'exactly 37 SECURITY DEFINER functions in public');
SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prosecdef
     AND p.oid NOT IN (
       'public.bulk_set_paper_projects(uuid[],uuid[])'::regprocedure,
       'public.bulk_set_paper_tags(uuid[],uuid[])'::regprocedure,
       'public.bulk_update_keywords(jsonb)'::regprocedure,
       'public.bulk_update_study_types(jsonb)'::regprocedure,
       'public.consume_ai_quota(uuid)'::regprocedure,
       'public.filter_papers_by_keywords(uuid,text[])'::regprocedure,
       'public.get_ai_quota_status(uuid)'::regprocedure,
       'public.get_current_user_access()'::regprocedure,
       'public.get_duplicate_papers()'::regprocedure,
       'public.get_keyword_options(uuid,uuid[],integer,integer,text[])'::regprocedure,
       'public.merge_exact_duplicates(uuid,uuid[])'::regprocedure,
       'public.refund_ai_quota(uuid)'::regprocedure,
       'public.safe_bulk_insert_papers(uuid,jsonb)'::regprocedure,
       'public.search_papers(uuid,text,integer,integer)'::regprocedure,
       'public.search_papers_short(uuid,text)'::regprocedure,
       'public.set_paper_projects(uuid,uuid[])'::regprocedure,
       'public.set_paper_tags(uuid,uuid[])'::regprocedure,
       'public.check_and_consume_storage_quota()'::regprocedure,
       'public.handle_new_user()'::regprocedure,
       'public.refund_storage_quota()'::regprocedure,
       'public.create_author_identity_from_mention(uuid,integer,text,text,boolean)'::regprocedure,
       'public.link_author_mention_to_identity(uuid,integer,text,uuid,text,boolean)'::regprocedure,
       'public.unlink_author_mention_identity(uuid,integer)'::regprocedure,
       'public.merge_author_identities(uuid,uuid)'::regprocedure,
       'public.unmerge_author_identity(uuid)'::regprocedure,
       'public.delete_empty_author_identity(uuid)'::regprocedure,
       'public.author_identity_effective_root(uuid,uuid)'::regprocedure,
       'public.validate_author_mention_for_identity(uuid,uuid,integer,text)'::regprocedure,
       'public.clear_author_identity_links_on_authors_change()'::regprocedure,
       'public.set_current_user_ai_model(text)'::regprocedure,
       'public.clear_current_user_ai_model()'::regprocedure,
       'public.bulk_add_paper_projects(uuid[],uuid[])'::regprocedure,
       'public.bulk_add_paper_tags(uuid[],uuid[])'::regprocedure,
       'public.delete_attachment_with_cleanup(uuid)'::regprocedure,
       'public.delete_papers_with_attachment_cleanup(uuid[])'::regprocedure,
       'public.finalize_attachment_upload(uuid,text,text,text,integer)'::regprocedure,
       'public.reject_attachment_over_cleanup_intent()'::regprocedure
     )),
  0, 'no unexpected/unclassified SECURITY DEFINER function or overload in public');

-- ══ 2. EXECUTE matrix over the 30 directly-callable RPCs ═════════════════════
SELECT ok(NOT has_function_privilege('anon', sig::regprocedure, 'EXECUTE'),
  'anon cannot execute ' || sig) FROM pg_temp.client_rpcs() sig;
SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = sig::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
  'PUBLIC cannot execute ' || sig) FROM pg_temp.client_rpcs() sig;
SELECT ok(NOT has_function_privilege('service_role', sig::regprocedure, 'EXECUTE'),
  'service_role cannot execute ' || sig) FROM pg_temp.client_rpcs() sig;
SELECT ok(has_function_privilege('authenticated', sig::regprocedure, 'EXECUTE'),
  'authenticated can execute ' || sig) FROM pg_temp.client_rpcs() sig;

-- ══ 3. Trigger-only functions: not client- or service_role-executable; owner kept ══
SELECT ok(
  NOT has_function_privilege('authenticated', sig::regprocedure, 'EXECUTE')
  AND NOT has_function_privilege('anon', sig::regprocedure, 'EXECUTE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = sig::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
  'trigger-only not client-executable (PUBLIC/anon/authenticated): ' || sig
) FROM pg_temp.trigger_fns() sig;
SELECT ok(NOT has_function_privilege('service_role', sig::regprocedure, 'EXECUTE'),
  'trigger-only not service_role-executable: ' || sig) FROM pg_temp.trigger_fns() sig;
SELECT ok(has_function_privilege(
    (SELECT p.proowner::regrole::text FROM pg_proc p WHERE p.oid = sig::regprocedure),
    sig::regprocedure, 'EXECUTE'),
  'trigger-only owner execution preserved: ' || sig) FROM pg_temp.trigger_fns() sig;

-- ══ 3c. Internal-only helpers: reachable by nobody but their owner ══════════
-- These exist so the write paths agree on one definition of "effective identity"
-- and one definition of "is this mention still what the user read". Neither is a
-- product API, and `validate_author_mention_for_identity` in particular takes a
-- caller-supplied user id — granting it would hand any client a way to probe
-- another account's papers.
SELECT ok(
  NOT has_function_privilege('authenticated', sig::regprocedure, 'EXECUTE')
  AND NOT has_function_privilege('anon', sig::regprocedure, 'EXECUTE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = sig::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
  'internal-only not client-executable (PUBLIC/anon/authenticated): ' || sig
) FROM pg_temp.internal_fns() sig;
SELECT ok(NOT has_function_privilege('service_role', sig::regprocedure, 'EXECUTE'),
  'internal-only not service_role-executable: ' || sig) FROM pg_temp.internal_fns() sig;
SELECT ok(has_function_privilege(
    (SELECT p.proowner::regrole::text FROM pg_proc p WHERE p.oid = sig::regprocedure),
    sig::regprocedure, 'EXECUTE'),
  'internal-only owner execution preserved: ' || sig) FROM pg_temp.internal_fns() sig;

-- ══ 3b. Directly-callable RPCs: owner execution preserved (all 30) ═══════════
-- Completes the EXECUTE matrix: for every direct RPC the defining owner retains
-- EXECUTE (owner true; authenticated true above; PUBLIC/anon/service_role false).
SELECT ok(
  has_function_privilege(
    (SELECT p.proowner::regrole::text FROM pg_proc p WHERE p.oid = sig::regprocedure),
    sig::regprocedure, 'EXECUTE'),
  'directly-callable owner execution preserved: ' || sig
) FROM pg_temp.client_rpcs() sig;

-- ══ 4. Caller identity: read RPCs (null-auth / mismatch reject, valid ok) ════
-- null-auth
SELECT is(pg_temp.errcode_as('authenticated','', sql), 'P0001',
  'null-auth rejected: ' || nm) FROM (VALUES
   ($q$SELECT * FROM public.search_papers('aa000000-0000-0000-0000-000000000001'::uuid,'x',10,0)$q$,'search_papers'),
   ($q$SELECT * FROM public.search_papers_short('aa000000-0000-0000-0000-000000000001'::uuid,'x')$q$,'search_papers_short'),
   ($q$SELECT * FROM public.filter_papers_by_keywords('aa000000-0000-0000-0000-000000000001'::uuid, ARRAY['x'])$q$,'filter_papers_by_keywords'),
   ($q$SELECT * FROM public.get_keyword_options('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'get_keyword_options')
  ) v(sql,nm);
-- mismatch (caller B, target A)
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}', sql), 'P0001',
  'mismatched caller rejected: ' || nm) FROM (VALUES
   ($q$SELECT * FROM public.search_papers('aa000000-0000-0000-0000-000000000001'::uuid,'x',10,0)$q$,'search_papers'),
   ($q$SELECT * FROM public.search_papers_short('aa000000-0000-0000-0000-000000000001'::uuid,'x')$q$,'search_papers_short'),
   ($q$SELECT * FROM public.filter_papers_by_keywords('aa000000-0000-0000-0000-000000000001'::uuid, ARRAY['x'])$q$,'filter_papers_by_keywords'),
   ($q$SELECT * FROM public.get_keyword_options('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'get_keyword_options')
  ) v(sql,nm);
-- valid caller A
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}', sql), '00000',
  'valid caller accepted: ' || nm) FROM (VALUES
   ($q$SELECT * FROM public.search_papers('aa000000-0000-0000-0000-000000000001'::uuid,'x',10,0)$q$,'search_papers'),
   ($q$SELECT * FROM public.search_papers_short('aa000000-0000-0000-0000-000000000001'::uuid,'x')$q$,'search_papers_short'),
   ($q$SELECT * FROM public.filter_papers_by_keywords('aa000000-0000-0000-0000-000000000001'::uuid, ARRAY['x'])$q$,'filter_papers_by_keywords'),
   ($q$SELECT * FROM public.get_keyword_options('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'get_keyword_options')
  ) v(sql,nm);

-- ── safe_bulk_insert_papers ───────────────────────────────────────────────
SELECT is(pg_temp.errcode_as('authenticated','',
  $q$SELECT public.safe_bulk_insert_papers('aa000000-0000-0000-0000-000000000001'::uuid,'[{"title":"NULLAUTH"}]'::jsonb)$q$),
  'P0001', 'safe_bulk_insert_papers: null-auth rejected');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT public.safe_bulk_insert_papers('aa000000-0000-0000-0000-000000000001'::uuid,'[{"title":"MISMATCH"}]'::jsonb)$q$),
  'P0001', 'safe_bulk_insert_papers: mismatched caller rejected');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.safe_bulk_insert_papers('aa000000-0000-0000-0000-000000000001'::uuid,'[{"title":"VALID"}]'::jsonb)$q$),
  '00000', 'safe_bulk_insert_papers: valid caller accepted');

-- ── AI-quota RPCs (S1 guard: null-auth / mismatch → P0001) ─────────────────
SELECT is(pg_temp.errcode_as('authenticated','', sql), 'P0001',
  'null-auth rejected: ' || nm) FROM (VALUES
   ($q$SELECT * FROM public.consume_ai_quota('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'consume_ai_quota'),
   ($q$SELECT * FROM public.refund_ai_quota('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'refund_ai_quota'),
   ($q$SELECT * FROM public.get_ai_quota_status('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'get_ai_quota_status')
  ) v(sql,nm);
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}', sql), 'P0001',
  'mismatched caller rejected: ' || nm) FROM (VALUES
   ($q$SELECT * FROM public.consume_ai_quota('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'consume_ai_quota'),
   ($q$SELECT * FROM public.refund_ai_quota('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'refund_ai_quota'),
   ($q$SELECT * FROM public.get_ai_quota_status('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'get_ai_quota_status')
  ) v(sql,nm);
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}', sql), '00000',
  'valid caller accepted: ' || nm) FROM (VALUES
   ($q$SELECT * FROM public.consume_ai_quota('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'consume_ai_quota'),
   ($q$SELECT * FROM public.refund_ai_quota('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'refund_ai_quota'),
   ($q$SELECT * FROM public.get_ai_quota_status('aa000000-0000-0000-0000-000000000001'::uuid)$q$,'get_ai_quota_status')
  ) v(sql,nm);

-- ══ 5. Setter RPCs (representative caller/ownership boundary) ════════════════
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.set_paper_tags('a0000000-0000-0000-0000-0000000000a1'::uuid, ARRAY['a0000000-0000-0000-0000-0000000000a3']::uuid[])$q$),
  '00000', 'set_paper_tags: own paper + own tag succeeds');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.set_paper_tags('a0000000-0000-0000-0000-0000000000a1'::uuid, ARRAY['b0000000-0000-0000-0000-0000000000b3']::uuid[])$q$),
  'P0001', 'set_paper_tags: foreign tag rejected');
SELECT is(pg_temp.errcode_as('authenticated','',
  $q$SELECT public.set_paper_tags('a0000000-0000-0000-0000-0000000000a1'::uuid, ARRAY['a0000000-0000-0000-0000-0000000000a3']::uuid[])$q$),
  'P0001', 'set_paper_tags: null-auth rejected');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.set_paper_projects('a0000000-0000-0000-0000-0000000000a1'::uuid, ARRAY['a0000000-0000-0000-0000-0000000000a2']::uuid[])$q$),
  '00000', 'set_paper_projects: own paper + own project succeeds');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.set_paper_projects('a0000000-0000-0000-0000-0000000000a1'::uuid, ARRAY['b0000000-0000-0000-0000-0000000000b2']::uuid[])$q$),
  'P0001', 'set_paper_projects: foreign project rejected');
SELECT is(pg_temp.errcode_as('authenticated','',
  $q$SELECT public.set_paper_projects('a0000000-0000-0000-0000-0000000000a1'::uuid, ARRAY['a0000000-0000-0000-0000-0000000000a2']::uuid[])$q$),
  'P0001', 'set_paper_projects: null-auth rejected');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.bulk_set_paper_tags(ARRAY['a0000000-0000-0000-0000-0000000000a1']::uuid[], ARRAY['a0000000-0000-0000-0000-0000000000a3']::uuid[])$q$),
  '00000', 'bulk_set_paper_tags: all-own succeeds');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.bulk_set_paper_tags(ARRAY['a0000000-0000-0000-0000-0000000000a1']::uuid[], ARRAY['b0000000-0000-0000-0000-0000000000b3']::uuid[])$q$),
  'P0001', 'bulk_set_paper_tags: foreign tag rejects whole call');
SELECT is(pg_temp.errcode_as('authenticated','',
  $q$SELECT public.bulk_set_paper_tags(ARRAY['a0000000-0000-0000-0000-0000000000a1']::uuid[], ARRAY['a0000000-0000-0000-0000-0000000000a3']::uuid[])$q$),
  'P0001', 'bulk_set_paper_tags: null-auth rejected');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.bulk_set_paper_projects(ARRAY['a0000000-0000-0000-0000-0000000000a1']::uuid[], ARRAY['a0000000-0000-0000-0000-0000000000a2']::uuid[])$q$),
  '00000', 'bulk_set_paper_projects: all-own succeeds');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.bulk_set_paper_projects(ARRAY['a0000000-0000-0000-0000-0000000000a1']::uuid[], ARRAY['b0000000-0000-0000-0000-0000000000b2']::uuid[])$q$),
  'P0001', 'bulk_set_paper_projects: foreign project rejects whole call');
SELECT is(pg_temp.errcode_as('authenticated','',
  $q$SELECT public.bulk_set_paper_projects(ARRAY['a0000000-0000-0000-0000-0000000000a1']::uuid[], ARRAY['a0000000-0000-0000-0000-0000000000a2']::uuid[])$q$),
  'P0001', 'bulk_set_paper_projects: null-auth rejected');

-- ══ 6. bulk_update_keywords / bulk_update_study_types (owner-scoped effect) ══
-- Neither raises: each UPDATEs papers WHERE user_id = auth.uid(), so a foreign
-- paper is simply never matched. The call returns void (00000) and the effect is
-- scoped to the caller; foreign rows are unchanged.
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.bulk_update_keywords('[{"id":"a0000000-0000-0000-0000-0000000000a1","keywords":["k1"]}]'::jsonb)$q$),
  '00000', 'bulk_update_keywords: caller call on own paper returns void');
SELECT is(
  (SELECT keywords::text FROM public.papers WHERE id='a0000000-0000-0000-0000-0000000000a1'),
  '["k1"]', 'bulk_update_keywords: own paper keywords updated (effect)');
SELECT is(
  (SELECT keywords::text FROM public.papers WHERE id='b0000000-0000-0000-0000-0000000000b1'),
  '["original"]', 'bulk_update_keywords baseline: B''s paper starts as ["original"]');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.bulk_update_keywords('[{"id":"b0000000-0000-0000-0000-0000000000b1","keywords":["hacked"]}]'::jsonb)$q$),
  '00000', 'bulk_update_keywords: cross-user call returns void (no error)');
SELECT is(
  (SELECT keywords::text FROM public.papers WHERE id='b0000000-0000-0000-0000-0000000000b1'),
  '["original"]', 'bulk_update_keywords: A cannot change B''s paper keywords (unchanged)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.bulk_update_study_types('[{"id":"a0000000-0000-0000-0000-0000000000a1","study_type":"RCT"}]'::jsonb)$q$),
  '00000', 'bulk_update_study_types: caller call on own paper returns void');
SELECT is(
  (SELECT study_type FROM public.papers WHERE id='a0000000-0000-0000-0000-0000000000a1'),
  'RCT', 'bulk_update_study_types: own paper study_type updated (effect)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.bulk_update_study_types('[{"id":"b0000000-0000-0000-0000-0000000000b1","study_type":"hacked"}]'::jsonb)$q$),
  '00000', 'bulk_update_study_types: cross-user call returns void (no error)');
SELECT is(
  (SELECT study_type FROM public.papers WHERE id='b0000000-0000-0000-0000-0000000000b1'),
  'orig', 'bulk_update_study_types: A cannot change B''s paper study_type (unchanged)');

-- ══ 7. get_duplicate_papers (caller-scoped isolation under a shared PMID) ═════
-- A1 and B1 share PMID 'PM_SHARED_C03B1' (see fixtures). A correct caller-scoped
-- implementation groups only the caller's own papers, so each caller sees []; a
-- globally-grouping implementation would surface the shared-PMID group and one
-- caller would receive the other user's paper ID. The two exact-empty results are
-- therefore sufficient to detect cross-user grouping.
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.get_duplicate_papers()::text$q$),
  '[]', 'get_duplicate_papers: caller A sees no duplicate group despite the shared cross-user PMID');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT public.get_duplicate_papers()::text$q$),
  '[]', 'get_duplicate_papers: caller B sees no duplicate group despite the shared cross-user PMID');
SELECT is(pg_temp.scalar_as('authenticated','',
  $q$SELECT public.get_duplicate_papers()::text$q$),
  '[]', 'get_duplicate_papers: authenticated caller with missing claims receives no duplicate data');

-- ══ 8. get_current_user_access (valid vs null-auth) ═════════════════════════
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT role FROM public.get_current_user_access()$q$),
  'user', 'get_current_user_access: ordinary caller resolves to role user');
SELECT is(pg_temp.errcode_as('authenticated','',
  $q$SELECT * FROM public.get_current_user_access()$q$),
  'P0001', 'get_current_user_access: null-auth rejected');

-- ══ 9. merge_exact_duplicates (guards only; success path owned by suite 005) ═
SELECT is(pg_temp.errcode_as('authenticated','',
  $q$SELECT public.merge_exact_duplicates('a0000000-0000-0000-0000-0000000000a1'::uuid, ARRAY['a0000000-0000-0000-0000-0000000000a5']::uuid[])$q$),
  'P0001', 'merge_exact_duplicates: null-auth rejected');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.merge_exact_duplicates('b0000000-0000-0000-0000-0000000000b1'::uuid, ARRAY['a0000000-0000-0000-0000-0000000000a5']::uuid[])$q$),
  'P0001', 'merge_exact_duplicates: foreign keep paper rejected');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.merge_exact_duplicates('a0000000-0000-0000-0000-0000000000a1'::uuid, ARRAY['b0000000-0000-0000-0000-0000000000b1']::uuid[])$q$),
  'P0001', 'merge_exact_duplicates: foreign discard paper rejected');
SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE id IN
     ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a5','b0000000-0000-0000-0000-0000000000b1')),
  3, 'merge_exact_duplicates: rejected calls performed no unauthorized deletion');

-- ══ 10. search_path + overload uniqueness ═══════════════════════════════════
SELECT ok(
  (SELECT proconfig FROM pg_proc WHERE oid='public.search_papers(uuid,text,integer,integer)'::regprocedure)
    @> ARRAY['search_path=public'],
  'search_papers has bounded search_path=public');
SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname = nm),
  1, 'exactly one overload of ' || nm) FROM unnest(ARRAY[
   'search_papers','search_papers_short','filter_papers_by_keywords','get_keyword_options',
   'safe_bulk_insert_papers','set_paper_tags','set_paper_projects','bulk_set_paper_tags',
   'bulk_set_paper_projects','consume_ai_quota','refund_ai_quota','get_ai_quota_status','merge_exact_duplicates'
  ]) nm;

SELECT * FROM finish();
ROLLBACK;
