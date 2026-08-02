-- Focused pgTAP regression coverage for the PFA-C03B1 pre-existing security
-- remediation (migration 20260802025704_harden_rpc_and_relational_ownership).
--
-- Every assertion pins a defect that reproduced on the unmodified base:
--   * least-privilege EXECUTE across the full SECURITY DEFINER surface;
--   * explicit NULL-auth rejection in the four read RPCs + safe_bulk_insert_papers;
--   * bounded search_path on search_papers;
--   * both-owner relational integrity for paper_projects / paper_tags;
--   * attachment↔paper ownership + quota defense.
--
-- Transaction-wrapped; deterministic UUIDs; no TODO/SKIP; no remote calls; no
-- Production access; no real user data. Role-switched calls run inside helper
-- functions that return the exact SQLSTATE so each assertion checks a specific
-- error code (ACL denial 42501, guard/trigger raise P0001, RLS violation 42501),
-- never a blanket "some exception".

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA public;

BEGIN;

-- ── Helpers ───────────────────────────────────────────────────────────────
-- Run p_sql as p_role with the given JWT claims; return the resulting SQLSTATE
-- ('00000' on success). Role/claims are restored before returning.
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

-- Run a single-scalar-returning p_sql as p_role; return the scalar as text.
-- Used only on success paths.
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

-- The complete directly-callable SECURITY DEFINER RPC surface (17).
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
    'public.set_paper_tags(uuid,uuid[])'
  ]);
$hlp$;

-- The four read RPCs, each called for VICTIM user A (same call string reused
-- across anon / null-auth / mismatch / valid scenarios — only role/claims vary).
CREATE FUNCTION pg_temp.read_rpc_calls() RETURNS TABLE(sql text, nm text) LANGUAGE sql AS $hlp$
  VALUES
    ($q$SELECT * FROM public.search_papers('00000000-0000-0000-0000-00000000000a'::uuid,'ZZALPHA',10,0)$q$, 'search_papers'),
    ($q$SELECT * FROM public.search_papers_short('00000000-0000-0000-0000-00000000000a'::uuid,'ZZALPHA')$q$, 'search_papers_short'),
    ($q$SELECT * FROM public.filter_papers_by_keywords('00000000-0000-0000-0000-00000000000a'::uuid, ARRAY['zzalpha'])$q$, 'filter_papers_by_keywords'),
    ($q$SELECT * FROM public.get_keyword_options('00000000-0000-0000-0000-00000000000a'::uuid)$q$, 'get_keyword_options');
$hlp$;

-- ── Fixtures (as superuser; RLS bypassed) ───────────────────────────────────
-- Inserting auth.users fires on_auth_user_created → handle_new_user, which
-- provisions user_entitlements (500MB storage) used by the valid-upload case.
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-00000000000a','regress-A@paperlume.test'),
  ('00000000-0000-0000-0000-00000000000b','regress-B@paperlume.test');

INSERT INTO public.papers (id, user_id, title, insert_order) VALUES
  ('10000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000a','ZZALPHA searchable paper A', 1),
  ('10000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000000b','ZZBETA paper B', 2);
INSERT INTO public.projects (id, user_id, name) VALUES
  ('20000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000a','Project A'),
  ('20000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000000b','Project B');
INSERT INTO public.tags (id, user_id, name) VALUES
  ('30000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000a','Tag A'),
  ('30000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000000b','Tag B');

SELECT plan(93);

-- ── 1. EXECUTE ACL matrix over the full directly-callable RPC surface ───────
SELECT ok(
  NOT has_function_privilege('anon', sig::regprocedure, 'EXECUTE'),
  'anon cannot execute ' || sig
) FROM pg_temp.client_rpcs() sig;

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = sig::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute ' || sig
) FROM pg_temp.client_rpcs() sig;

SELECT ok(
  has_function_privilege('authenticated', sig::regprocedure, 'EXECUTE'),
  'authenticated can execute ' || sig
) FROM pg_temp.client_rpcs() sig;

-- ── 2. Trigger-only functions are not directly client-executable ────────────
SELECT ok(
  NOT has_function_privilege('authenticated', sig::regprocedure, 'EXECUTE')
  AND NOT has_function_privilege('anon', sig::regprocedure, 'EXECUTE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = sig::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ),
  'trigger-only function not client-executable (PUBLIC/anon/authenticated): ' || sig
) FROM unnest(ARRAY[
  'public.check_and_consume_storage_quota()',
  'public.handle_new_user()',
  'public.refund_storage_quota()'
]) sig;

-- ── 3. search_papers has a bounded search_path ──────────────────────────────
SELECT ok(
  (SELECT proconfig FROM pg_proc WHERE oid = 'public.search_papers(uuid,text,integer,integer)'::regprocedure)
    @> ARRAY['search_path=public'],
  'search_papers has bounded search_path=public'
);

-- ── 4. No unexpected overload of any hardened RPC provides a bypass ──────────
SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = nm),
  1,
  'exactly one overload of ' || nm
) FROM unnest(ARRAY[
  'search_papers','search_papers_short','filter_papers_by_keywords',
  'get_keyword_options','safe_bulk_insert_papers'
]) nm;

-- ── 5. Read RPCs: anon caller denied at the ACL (no data path) ──────────────
SELECT is(pg_temp.errcode_as('anon', '', sql), '42501',
  'anon caller denied at ACL (no victim data returned): ' || nm)
FROM pg_temp.read_rpc_calls();

-- ── 6. Read RPCs: null-auth caller rejected by the guard ────────────────────
SELECT is(pg_temp.errcode_as('authenticated', '', sql), 'P0001',
  'null-auth caller rejected by ownership guard: ' || nm)
FROM pg_temp.read_rpc_calls();

-- ── 7. Read RPCs: authenticated mismatched user_id rejected by the guard ────
SELECT is(pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', sql), 'P0001',
  'authenticated mismatched user_id rejected by ownership guard: ' || nm)
FROM pg_temp.read_rpc_calls();

-- ── 8. Read RPCs: valid authenticated call succeeds ─────────────────────────
SELECT is(pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', sql), '00000',
  'valid authenticated call succeeds: ' || nm)
FROM pg_temp.read_rpc_calls();

-- ── 9. Valid read returns the caller's own matching paper (data preserved) ──
SELECT is(
  pg_temp.scalar_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
    $q$SELECT count(*)::text FROM public.search_papers_short('00000000-0000-0000-0000-00000000000a'::uuid,'ZZALPHA')$q$),
  '1',
  'valid authenticated search_papers_short returns the caller''s own matching paper'
);

-- ── 10. safe_bulk_insert_papers write-path guard + ACL ──────────────────────
SELECT is(
  pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
    $q$SELECT public.safe_bulk_insert_papers('00000000-0000-0000-0000-00000000000a'::uuid, '[{"title":"ZZBULK_VALID_A"}]'::jsonb)$q$),
  '00000',
  'valid authenticated safe_bulk_insert_papers call succeeds'
);
SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE title = 'ZZBULK_VALID_A'
     AND user_id = '00000000-0000-0000-0000-00000000000a'::uuid),
  1,
  'valid bulk import created exactly one paper row for the caller'
);
SELECT is(
  pg_temp.errcode_as('anon', '',
    $q$SELECT public.safe_bulk_insert_papers('00000000-0000-0000-0000-00000000000a'::uuid, '[{"title":"ZZINJECT_ANON_TEST"}]'::jsonb)$q$),
  '42501',
  'anon safe_bulk_insert_papers denied at the ACL'
);
SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE title = 'ZZINJECT_ANON_TEST'),
  0,
  'anon bulk import created zero paper rows'
);
SELECT is(
  pg_temp.errcode_as('authenticated', '',
    $q$SELECT public.safe_bulk_insert_papers('00000000-0000-0000-0000-00000000000a'::uuid, '[{"title":"ZZNULLAUTH"}]'::jsonb)$q$),
  'P0001',
  'null-auth safe_bulk_insert_papers rejected by ownership guard'
);
SELECT is(
  pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}',
    $q$SELECT public.safe_bulk_insert_papers('00000000-0000-0000-0000-00000000000a'::uuid, '[{"title":"ZZMISMATCH"}]'::jsonb)$q$),
  'P0001',
  'mismatched authenticated safe_bulk_insert_papers rejected by ownership guard'
);

-- ── 11. paper_projects both-owner relational integrity ──────────────────────
SELECT is(
  pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
    $q$INSERT INTO public.paper_projects(paper_id, project_id) VALUES ('10000000-0000-0000-0000-0000000000a1','20000000-0000-0000-0000-0000000000a1')$q$),
  '00000',
  'paper_projects: own paper + own project allowed'
);
SELECT is(
  pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
    $q$INSERT INTO public.paper_projects(paper_id, project_id) VALUES ('10000000-0000-0000-0000-0000000000a1','20000000-0000-0000-0000-0000000000b1')$q$),
  '42501',
  'paper_projects: own paper + foreign project rejected'
);
SELECT is(
  pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
    $q$INSERT INTO public.paper_projects(paper_id, project_id) VALUES ('10000000-0000-0000-0000-0000000000b1','20000000-0000-0000-0000-0000000000a1')$q$),
  '42501',
  'paper_projects: foreign paper + own project rejected'
);

-- ── 12. paper_tags both-owner relational integrity ──────────────────────────
SELECT is(
  pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
    $q$INSERT INTO public.paper_tags(paper_id, tag_id) VALUES ('10000000-0000-0000-0000-0000000000a1','30000000-0000-0000-0000-0000000000a1')$q$),
  '00000',
  'paper_tags: own paper + own tag allowed'
);
SELECT is(
  pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
    $q$INSERT INTO public.paper_tags(paper_id, tag_id) VALUES ('10000000-0000-0000-0000-0000000000a1','30000000-0000-0000-0000-0000000000b1')$q$),
  '42501',
  'paper_tags: own paper + foreign tag rejected'
);
SELECT is(
  pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
    $q$INSERT INTO public.paper_tags(paper_id, tag_id) VALUES ('10000000-0000-0000-0000-0000000000b1','30000000-0000-0000-0000-0000000000a1')$q$),
  '42501',
  'paper_tags: foreign paper + own tag rejected'
);

-- ── 13. paper_attachments ownership + quota defense ─────────────────────────
SELECT is(
  pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
    $q$INSERT INTO public.paper_attachments(paper_id, user_id, file_path, file_name, file_type, size_bytes)
       VALUES ('10000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000a','a/ok.pdf','ok.pdf','application/pdf',12345)$q$),
  '00000',
  'paper_attachments: own attachment on own paper allowed'
);
SELECT is(
  pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
    $q$INSERT INTO public.paper_attachments(paper_id, user_id, file_path, file_name, file_type, size_bytes)
       VALUES ('10000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000000a','a/x.pdf','x.pdf','application/pdf',100)$q$),
  'P0001',
  'paper_attachments: own attachment pointing at a foreign paper rejected'
);
SELECT is(
  pg_temp.errcode_as('authenticated', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
    $q$INSERT INTO public.paper_attachments(paper_id, user_id, file_path, file_name, file_type, size_bytes)
       VALUES ('10000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000b','a/y.pdf','y.pdf','application/pdf',100)$q$),
  'P0001',
  'paper_attachments: attachment declaring a foreign user_id rejected'
);
SELECT is(
  (SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id = '00000000-0000-0000-0000-00000000000a'::uuid),
  '12345',
  'rejected attachment inserts did not consume storage quota'
);

SELECT * FROM finish();
ROLLBACK;
