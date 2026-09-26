-- DB-INVOKER-EXECUTE-HARDENING-001A suite 020: the five caller-scoped read RPCs
-- run as SECURITY INVOKER, under the caller's table grants and RLS.
--
-- Migration 20260926152414_harden_read_rpcs_security_invoker changed exactly
-- one attribute — prosecdef true → false — on:
--
--   search_papers(uuid,text,integer,integer)
--   search_papers_short(uuid,text)
--   filter_papers_by_keywords(uuid,text[])
--   get_keyword_options(uuid,uuid[],integer,integer,text[])
--   get_duplicate_papers()
--
-- After it, `authenticated`'s SELECT grant on `papers` / `synonym_pool` and the
-- caller-owned RLS SELECT policies are the PRIMARY database boundary of all
-- five; the explicit auth.uid() logic in the bodies stays as defense-in-depth
-- and as the product contract. This suite owns that change end to end:
--
--   1. posture — signature (one overload), owner, security mode, search_path,
--      body digest, stored ACL and effective EXECUTE for every relevant role;
--      and the boundary they now rely on: both tables' owner, RLS/FORCE RLS,
--      authenticated grant, all eight policies exactly, and an RLS-subject
--      `authenticated`;
--   2. anon is refused at the function ACL;
--   3. the owner gets exactly their own results (search, attribution, keyword
--      filter incl. synonym expansion, keyword options, duplicate groups);
--   4/5. the existing contract is unchanged: a cross-user p_user_id, missing
--      claims and a NULL p_user_id raise 'Unauthorized: user mismatch';
--      get_duplicate_papers without claims returns [];
--   6. another user's ids, keywords, text and synonyms never yield data;
--   7. the explicit identity logic is still in each body;
--   8. RLS IS LIVE: a transaction-local RESTRICTIVE deny policy empties every
--      result, on `papers` for all five and on `synonym_pool` for the synonym
--      expansion. As SECURITY DEFINER the owner (`postgres`, BYPASSRLS) would
--      ignore both policies and these assertions would FAIL;
--   9. THE GRANT IS LIVE: revoking `authenticated`'s SELECT makes the functions
--      that read the table fail with "permission denied for table", and only
--      those. As SECURITY DEFINER they would keep succeeding.
--
-- Sections 8 and 9 are the ones that distinguish INVOKER from DEFINER by
-- behaviour rather than by reading the catalog, so a revert is caught twice.
-- Every probe policy and revoke is transaction-local and undone by the ROLLBACK.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the transaction
-- and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Run p_sql as p_role with the given JWT claims; return '<SQLSTATE> <message>'
-- ('00000 ' on success). An EXECUTE refusal, a table-privilege refusal and an
-- RLS refusal can share SQLSTATE 42501; the message says which layer answered.
CREATE FUNCTION pg_temp.err_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text; v_msg text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := '00000';
    v_msg := '';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state || ' ' || v_msg;
END;
$hlp$;

-- Run a single-scalar-returning p_sql as p_role; return the scalar as text.
-- An error is RETURNED as '<error SQLSTATE message>' rather than raised, so a
-- regression that makes a call fail (a revoked grant, a dropped function) is
-- reported by every assertion it affects instead of aborting the whole suite.
CREATE FUNCTION pg_temp.scalar_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_result text; v_state text; v_msg text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  BEGIN
    EXECUTE p_sql INTO v_result;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_result := '<error ' || v_state || ' ' || v_msg || '>';
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_result;
END;
$hlp$;

CREATE FUNCTION pg_temp.claims_a() RETURNS text LANGUAGE sql AS
  $$ SELECT '{"sub":"20a00000-0000-0000-0000-00000000000a","role":"authenticated"}' $$;
CREATE FUNCTION pg_temp.claims_b() RETURNS text LANGUAGE sql AS
  $$ SELECT '{"sub":"20b00000-0000-0000-0000-00000000000b","role":"authenticated"}' $$;

-- One call of each of the five for victim/owner A. Only role and claims vary
-- between the scenarios that reuse these.
CREATE FUNCTION pg_temp.five_calls() RETURNS TABLE(sql text, nm text) LANGUAGE sql AS $hlp$
  VALUES
    ($q$SELECT count(*) FROM public.search_papers('20a00000-0000-0000-0000-00000000000a'::uuid,'zqinvoker',10,0)$q$, 'search_papers'),
    ($q$SELECT count(*) FROM public.search_papers_short('20a00000-0000-0000-0000-00000000000a'::uuid,'zq')$q$, 'search_papers_short'),
    ($q$SELECT count(*) FROM public.filter_papers_by_keywords('20a00000-0000-0000-0000-00000000000a'::uuid, ARRAY['zqkw-shared'])$q$, 'filter_papers_by_keywords'),
    ($q$SELECT count(*) FROM public.get_keyword_options('20a00000-0000-0000-0000-00000000000a'::uuid)$q$, 'get_keyword_options'),
    ($q$SELECT public.get_duplicate_papers()$q$, 'get_duplicate_papers');
$hlp$;

-- The four that take a user id, for the unchanged identity contract.
CREATE FUNCTION pg_temp.user_id_calls(p_user text) RETURNS TABLE(sql text, nm text) LANGUAGE sql AS $hlp$
  VALUES
    (format($q$SELECT count(*) FROM public.search_papers(%s,'zqinvoker',10,0)$q$, p_user), 'search_papers'),
    (format($q$SELECT count(*) FROM public.search_papers_short(%s,'zq')$q$, p_user), 'search_papers_short'),
    (format($q$SELECT count(*) FROM public.filter_papers_by_keywords(%s, ARRAY['zqkw-shared'])$q$, p_user), 'filter_papers_by_keywords'),
    (format($q$SELECT count(*) FROM public.get_keyword_options(%s)$q$, p_user), 'get_keyword_options');
$hlp$;

-- get_duplicate_papers() flattened to 'type:value:id,id;…' with ids sorted, so
-- equal-timestamp fixtures cannot make the comparison order-dependent.
CREATE FUNCTION pg_temp.dup_groups_sql() RETURNS text LANGUAGE sql AS $hlp$
  SELECT $q$SELECT coalesce((SELECT string_agg(g->>'match_type' || ':' || (g->>'match_value') || ':'
                    || (SELECT string_agg(pp->>'id', ',' ORDER BY pp->>'id' COLLATE "C")
                          FROM jsonb_array_elements(g->'papers') pp), ';' ORDER BY g->>'match_value' COLLATE "C")
                  FROM jsonb_array_elements(public.get_duplicate_papers()) g), '')$q$
$hlp$;

-- ── Fixtures (as the table owner; RLS bypassed) ──────────────────────────────
-- A owns A1 and A2; B owns B1. The three share one DOI and A1/B1 share one PMID
-- ACROSS accounts. A1 and A2 are A's own DOI duplicate pair — possible despite
-- the per-user unique index on lower(doi) because A2's DOI carries a leading
-- space, and get_duplicate_papers groups on lower(trim(doi)). So A has exactly
-- one duplicate group, B has none, and a function that grouped or searched
-- across accounts would surface B1 to A or A1/A2 to B.
INSERT INTO auth.users (id, email) VALUES
  ('20a00000-0000-0000-0000-00000000000a','invoker-A@paperlume.test'),
  ('20b00000-0000-0000-0000-00000000000b','invoker-B@paperlume.test');

INSERT INTO public.papers
  (id, user_id, title, abstract, journal, notes, authors, keywords, mesh_terms, substances, year, study_type, pmid, doi)
VALUES
  ('20a00000-0000-0000-0000-0000000000a1','20a00000-0000-0000-0000-00000000000a',
   'Zqinvoker randomized cardiology trial', 'Zqinvoker abstract text', 'Zq Journal', 'zqnote reviewer remark',
   '["Zqauthor A"]'::jsonb, '["zqkw-alpha","zqkw-shared"]'::jsonb, '["Heart Attack"]'::jsonb, '["Zqsubstance"]'::jsonb,
   2020, 'RCT', 'ZQ020PMID', '10.5555/zq-invoker-dup'),
  ('20a00000-0000-0000-0000-0000000000a2','20a00000-0000-0000-0000-00000000000a',
   'Zqinvoker observational cohort', NULL, NULL, NULL,
   '[]'::jsonb, '["zqkw-beta"]'::jsonb, '[]'::jsonb, NULL,
   2022, 'Cohort', NULL, ' 10.5555/zq-invoker-dup'),
  ('20b00000-0000-0000-0000-0000000000b1','20b00000-0000-0000-0000-00000000000b',
   'Zqinvoker foreign cardiology trial', 'Zqinvoker foreign abstract', 'Zq Journal', 'zqnote foreign remark',
   '["Zqauthor B"]'::jsonb, '["zqkw-bravo","zqkw-shared"]'::jsonb, '["Heart Attack"]'::jsonb, NULL,
   2020, 'RCT', 'ZQ020PMID', '10.5555/zq-invoker-dup');

-- A's synonym group maps "heart attack" to "myocardial infarction"; B maps the
-- same synonym to a canonical term of its own. filter_papers_by_keywords reads
-- synonym_pool, so this is its second relation boundary.
INSERT INTO public.synonym_pool (user_id, canonical_term, synonyms) VALUES
  ('20a00000-0000-0000-0000-00000000000a', 'myocardial infarction', ARRAY['heart attack']),
  ('20b00000-0000-0000-0000-00000000000b', 'zqb-canonical',         ARRAY['heart attack']);

SELECT plan(67);

-- ══ 1. Posture ══════════════════════════════════════════════════════════════
-- One readable line per function, so a failure names what moved: overload
-- count, owner, security mode, search_path, body digest, stored ACL, and which
-- of PUBLIC / anon / authenticated / service_role can execute it.
SELECT is(
  (SELECT (SELECT count(*) FROM pg_proc p2 WHERE p2.pronamespace = p.pronamespace AND p2.proname = p.proname) || ' overload'
          || ' | ' || pg_get_userbyid(p.proowner)
          || ' | ' || CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END
          || ' | ' || coalesce(array_to_string(p.proconfig, ','), '<no config>')
          || ' | body ' || md5(p.prosrc)
          || ' | acl ' || coalesce(p.proacl::text, 'NULL')
          || ' | exec ' || (SELECT coalesce(string_agg(r, ',' ORDER BY r COLLATE "C"), '<nobody>')
                              FROM unnest(ARRAY['PUBLIC','anon','authenticated','service_role']) r
                             WHERE CASE WHEN r = 'PUBLIC'
                                        THEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                                                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                                        ELSE has_function_privilege(r, p.oid, 'EXECUTE') END)
     FROM pg_proc p WHERE p.oid = to_regprocedure(e.sig)),
  '1 overload | postgres | SECURITY INVOKER | search_path=public | body ' || e.body_md5
    || ' | acl {postgres=X/postgres,authenticated=X/postgres} | exec authenticated',
  'posture: ' || e.sig)
FROM (VALUES
  ('public.search_papers(uuid,text,integer,integer)',                  'd4a5f3afdc485d5dfda8e0798c61cc48'),
  ('public.search_papers_short(uuid,text)',                            'ce353564edcb73a5466092e84d0b8d1b'),
  ('public.filter_papers_by_keywords(uuid,text[])',                    'b2f5a8e58589a5a094a7074c5ed9bb2d'),
  ('public.get_keyword_options(uuid,uuid[],integer,integer,text[])',   '531010c10d84ee94c7c1e00d65a2e7f5'),
  ('public.get_duplicate_papers()',                                    '3c914811a9b8c75b9df834e1cf51e1e0')
) AS e(sig, body_md5);

-- The two relations: owner, RLS enabled and forced, authenticated's grant
-- (direct and effective) and anon's effective privileges.
SELECT is(
  (SELECT pg_get_userbyid(c.relowner) || ' | rls ' || c.relrowsecurity::text || ' | force ' || c.relforcerowsecurity::text
          || ' | authenticated direct ' ||
          (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type COLLATE "C"), '')
             FROM aclexplode(coalesce(c.relacl, acldefault('r'::"char", c.relowner))) a
            WHERE a.grantee = 'authenticated'::regrole)
          || ' | authenticated effective ' ||
          (SELECT coalesce(string_agg(pr, ',' ORDER BY pr COLLATE "C"), '')
             FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) pr
            WHERE has_table_privilege('authenticated', c.oid, pr))
          || ' | anon effective ' ||
          (SELECT coalesce(string_agg(pr, ',' ORDER BY pr COLLATE "C"), '<none>')
             FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) pr
            WHERE has_table_privilege('anon', c.oid, pr))
     FROM pg_class c WHERE c.oid = to_regclass(e.rel)),
  e.expected,
  'boundary: ' || e.rel || ' owner, RLS, FORCE RLS and client grants')
FROM (VALUES
  ('public.papers',       'postgres | rls true | force true | authenticated direct INSERT,SELECT,UPDATE | authenticated effective INSERT,SELECT,UPDATE | anon effective <none>'),
  ('public.synonym_pool', 'postgres | rls true | force true | authenticated direct DELETE,INSERT,SELECT,UPDATE | authenticated effective DELETE,INSERT,SELECT,UPDATE | anon effective <none>')
) AS e(rel, expected);

-- Every policy on each table, exactly: name, command, permissive, roles, USING,
-- WITH CHECK. A broadened, narrowed, restrictive, re-targeted or extra policy
-- fails here by value.
SELECT is(
  (SELECT string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                     || (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                           FROM unnest(pol.polroles) r) || '|'
                     || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>') || '|'
                     || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>'),
                     E'\n' ORDER BY pol.polname COLLATE "C")
     FROM pg_policy pol WHERE pol.polrelid = to_regclass(e.rel)),
  e.expected,
  'boundary: ' || e.rel || ' RLS policies are exactly the reviewed caller-owned four')
FROM (VALUES
  ('public.papers',
   'Users can create their own papers|a|true|PUBLIC|<null>|(auth.uid() = user_id)' || E'\n' ||
   'Users can delete their own papers|d|true|PUBLIC|(auth.uid() = user_id)|<null>' || E'\n' ||
   'Users can update their own papers|w|true|PUBLIC|(auth.uid() = user_id)|<null>' || E'\n' ||
   'Users can view their own papers|r|true|PUBLIC|(auth.uid() = user_id)|<null>'),
  ('public.synonym_pool',
   'Users can create their own synonym groups|a|true|PUBLIC|<null>|(auth.uid() = user_id)' || E'\n' ||
   'Users can delete their own synonym groups|d|true|PUBLIC|(auth.uid() = user_id)|<null>' || E'\n' ||
   'Users can update their own synonym groups|w|true|PUBLIC|(auth.uid() = user_id)|<null>' || E'\n' ||
   'Users can view their own synonym groups|r|true|PUBLIC|(auth.uid() = user_id)|<null>')
) AS e(rel, expected);

-- The same eight as one digest — the formula the migration pins them with.
SELECT is(
  (SELECT md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s',
                                c.relname, pol.polname, pol.polcmd, pol.polpermissive,
                                (SELECT string_agg(rr.rn, ',' ORDER BY rr.rn)
                                   FROM (SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END AS rn
                                           FROM unnest(pol.polroles) r) rr),
                                coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>'),
                                coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')),
                         E'\n' ORDER BY c.relname, pol.polname))
     FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
    WHERE pol.polrelid IN ('public.papers'::regclass, 'public.synonym_pool'::regclass)),
  '07603cbe4e78a4d6097e7ec33bd1e6c8',
  'boundary: papers + synonym_pool policy digest is the reviewed one');

-- RLS can only be the boundary for a role that cannot bypass it.
SELECT ok(
  (SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname = 'authenticated'),
  'boundary: authenticated is neither SUPERUSER nor BYPASSRLS');

-- ══ 2. anon is refused at the function ACL ══════════════════════════════════
SELECT is(pg_temp.err_as('anon', '', sql), '42501 permission denied for function ' || nm,
  'anon refused at the function ACL: ' || nm)
FROM pg_temp.five_calls();

-- ══ 3. The owner gets exactly their own results ═════════════════════════════
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT coalesce(string_agg(paper_id::text, ',' ORDER BY paper_id), '')
         FROM public.search_papers('20a00000-0000-0000-0000-00000000000a'::uuid, 'zqinvoker', 10, 0)$q$),
  '20a00000-0000-0000-0000-0000000000a1,20a00000-0000-0000-0000-0000000000a2',
  'own-user: search_papers returns both of A''s matching papers and not B''s');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT string_agg(paper_id::text || '|' || matched_title || matched_abstract || matched_authors
                         || matched_journal || matched_notes || matched_keywords, ',')
         FROM public.search_papers('20a00000-0000-0000-0000-00000000000a'::uuid, 'cardiology', 10, 0)$q$),
  '20a00000-0000-0000-0000-0000000000a1|truefalsefalsefalsefalsefalse',
  'own-user: search_papers matched-field attribution (title only)');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT coalesce(string_agg(paper_id::text, ',' ORDER BY paper_id), '')
         FROM public.search_papers_short('20a00000-0000-0000-0000-00000000000a'::uuid, 'zq')$q$),
  '20a00000-0000-0000-0000-0000000000a1,20a00000-0000-0000-0000-0000000000a2',
  'own-user: search_papers_short returns both of A''s matching papers and not B''s');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT string_agg(paper_id::text || '|' || matched_title || matched_abstract || matched_authors
                         || matched_journal || matched_notes || matched_keywords, ',')
         FROM public.search_papers_short('20a00000-0000-0000-0000-00000000000a'::uuid, 'zqnote')$q$),
  '20a00000-0000-0000-0000-0000000000a1|falsefalsefalsefalsetruefalse',
  'own-user: search_papers_short matched-field attribution (notes only)');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT coalesce(string_agg(paper_id::text, ',' ORDER BY paper_id), '')
         FROM public.filter_papers_by_keywords('20a00000-0000-0000-0000-00000000000a'::uuid, ARRAY['zqkw-shared'])$q$),
  '20a00000-0000-0000-0000-0000000000a1',
  'own-user: filter_papers_by_keywords matches A''s keyword, not B''s paper carrying the same keyword');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT coalesce(string_agg(paper_id::text, ',' ORDER BY paper_id), '')
         FROM public.filter_papers_by_keywords('20a00000-0000-0000-0000-00000000000a'::uuid, ARRAY['myocardial infarction'])$q$),
  '20a00000-0000-0000-0000-0000000000a1',
  'own-user: filter_papers_by_keywords expands mesh_terms through A''s own synonym pool');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT coalesce(string_agg(keyword, ',' ORDER BY keyword COLLATE "C"), '')
         FROM public.get_keyword_options('20a00000-0000-0000-0000-00000000000a'::uuid)$q$),
  'Heart Attack,Zqsubstance,zqkw-alpha,zqkw-beta,zqkw-shared',
  'own-user: get_keyword_options returns exactly A''s keywords, MeSH terms and substances');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT coalesce(string_agg(keyword, ',' ORDER BY keyword COLLATE "C"), '')
         FROM public.get_keyword_options('20a00000-0000-0000-0000-00000000000a'::uuid,
                                         ARRAY['20a00000-0000-0000-0000-0000000000a2']::uuid[])$q$),
  'zqkw-beta',
  'own-user: get_keyword_options narrows to the requested own paper');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(), pg_temp.dup_groups_sql()),
  'doi:10.5555/zq-invoker-dup:20a00000-0000-0000-0000-0000000000a1,20a00000-0000-0000-0000-0000000000a2',
  'own-user: get_duplicate_papers returns A''s one DOI group, without B''s paper and without a cross-user PMID group');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_b(), $q$SELECT public.get_duplicate_papers()::text$q$),
  '[]',
  'own-user: get_duplicate_papers gives B no group despite the DOI and PMID B shares with A');

-- ══ 4. Cross-user p_user_id: the existing contract, unchanged ═══════════════
SELECT is(pg_temp.err_as('authenticated', pg_temp.claims_b(), sql), 'P0001 Unauthorized: user mismatch',
  'cross-user: B asking for A''s data is refused by the explicit guard: ' || nm)
FROM pg_temp.user_id_calls($q$'20a00000-0000-0000-0000-00000000000a'::uuid$q$);

-- ══ 5. Missing auth and a NULL user id: the existing contract, unchanged ════
SELECT is(pg_temp.err_as('authenticated', '', sql), 'P0001 Unauthorized: user mismatch',
  'null-auth: no claims is refused by the explicit guard: ' || nm)
FROM pg_temp.user_id_calls($q$'20a00000-0000-0000-0000-00000000000a'::uuid$q$);
SELECT is(pg_temp.err_as('authenticated', pg_temp.claims_a(), sql), 'P0001 Unauthorized: user mismatch',
  'null user id: a NULL p_user_id is refused by the explicit guard: ' || nm)
FROM pg_temp.user_id_calls('NULL::uuid');
SELECT is(
  pg_temp.scalar_as('authenticated', '', $q$SELECT public.get_duplicate_papers()::text$q$),
  '[]',
  'null-auth: get_duplicate_papers without claims returns [] (derives the caller from auth.uid())');

-- ══ 6. Another user's ids, keywords, text and synonyms never yield data ═════
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT coalesce(string_agg(keyword, ',' ORDER BY keyword COLLATE "C"), '')
         FROM public.get_keyword_options('20a00000-0000-0000-0000-00000000000a'::uuid,
                                         ARRAY['20b00000-0000-0000-0000-0000000000b1']::uuid[])$q$),
  '',
  'foreign ids: get_keyword_options for B''s paper id yields nothing to A');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT coalesce(string_agg(keyword, ',' ORDER BY keyword COLLATE "C"), '')
         FROM public.get_keyword_options('20a00000-0000-0000-0000-00000000000a'::uuid,
                                         ARRAY['20a00000-0000-0000-0000-0000000000a2',
                                               '20b00000-0000-0000-0000-0000000000b1']::uuid[])$q$),
  'zqkw-beta',
  'foreign ids: a mixed own/foreign id list yields only the own paper''s keywords');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT count(*)::text FROM public.filter_papers_by_keywords('20a00000-0000-0000-0000-00000000000a'::uuid, ARRAY['zqkw-bravo'])$q$),
  '0',
  'foreign data: filtering by a keyword only B''s paper has yields nothing to A');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT count(*)::text FROM public.filter_papers_by_keywords('20a00000-0000-0000-0000-00000000000a'::uuid, ARRAY['zqb-canonical'])$q$),
  '0',
  'foreign data: B''s synonym canonical never expands A''s MeSH terms');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT count(*)::text FROM public.search_papers('20a00000-0000-0000-0000-00000000000a'::uuid, 'foreign', 10, 0)$q$),
  '0',
  'foreign data: search_papers for text only B''s paper contains yields nothing to A');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT count(*)::text FROM public.search_papers_short('20a00000-0000-0000-0000-00000000000a'::uuid, 'foreign')$q$),
  '0',
  'foreign data: search_papers_short for text only B''s paper contains yields nothing to A');

-- ══ 7. The explicit identity logic is still there (defense-in-depth) ════════
-- The body digests in section 1 already pin every byte; these say WHY in words.
SELECT ok(
  position('p_user_id IS NULL' IN p.prosrc) > 0
  AND position('auth.uid() IS NULL' IN p.prosrc) > 0
  AND position('p_user_id <> auth.uid()' IN p.prosrc) > 0
  AND position('Unauthorized: user mismatch' IN p.prosrc) > 0,
  'identity guard retained: ' || p.oid::regprocedure::text)
FROM pg_proc p
WHERE p.oid IN ('public.search_papers(uuid,text,integer,integer)'::regprocedure,
                'public.search_papers_short(uuid,text)'::regprocedure,
                'public.filter_papers_by_keywords(uuid,text[])'::regprocedure,
                'public.get_keyword_options(uuid,uuid[],integer,integer,text[])'::regprocedure);
SELECT ok(
  (SELECT position('v_user_id uuid := auth.uid()' IN prosrc) > 0
      AND position('WHERE p.user_id = v_user_id' IN prosrc) > 0
     FROM pg_proc WHERE oid = 'public.get_duplicate_papers()'::regprocedure),
  'identity derivation retained: get_duplicate_papers scopes to v_user_id := auth.uid()');

-- ══ 8. RLS is live inside the functions ═════════════════════════════════════
-- A transaction-local RESTRICTIVE policy that admits nothing to
-- `authenticated`. An INVOKER function runs as `authenticated`, so it sees no
-- row at all, even of the caller's own papers. A DEFINER function runs as
-- `postgres`, which has BYPASSRLS, and would return the same rows as in
-- section 3 — so every assertion below fails if any of the five is reverted.
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(), $q$SELECT count(*)::text FROM public.papers$q$),
  '2', 'control: before the probe, A reads exactly A''s two papers directly');

CREATE POLICY zz_020_rls_probe_deny ON public.papers AS RESTRICTIVE FOR SELECT TO authenticated USING (false);

SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(), $q$SELECT count(*)::text FROM public.papers$q$),
  '0', 'control: the probe policy hides A''s own papers from A''s direct read');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims_a(), sql), CASE WHEN nm = 'get_duplicate_papers' THEN '[]' ELSE '0' END,
  'RLS is live: the papers probe empties ' || nm || ' for its own caller (a DEFINER owner would bypass it)')
FROM pg_temp.five_calls();

DROP POLICY zz_020_rls_probe_deny ON public.papers;

-- The synonym expansion reads synonym_pool under the caller's RLS too. With A's
-- synonyms hidden, the MeSH-only match disappears while the direct keyword
-- match — which never consults synonym_pool — still works.
CREATE POLICY zz_020_rls_probe_deny ON public.synonym_pool AS RESTRICTIVE FOR SELECT TO authenticated USING (false);

SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT count(*)::text FROM public.filter_papers_by_keywords('20a00000-0000-0000-0000-00000000000a'::uuid, ARRAY['myocardial infarction'])$q$),
  '0',
  'RLS is live: the synonym_pool probe removes A''s synonym expansion from filter_papers_by_keywords');
SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT coalesce(string_agg(paper_id::text, ','), '') FROM public.filter_papers_by_keywords('20a00000-0000-0000-0000-00000000000a'::uuid, ARRAY['zqkw-shared'])$q$),
  '20a00000-0000-0000-0000-0000000000a1',
  'RLS is live: a direct keyword match does not depend on synonym_pool and still works');

DROP POLICY zz_020_rls_probe_deny ON public.synonym_pool;

SELECT is(
  pg_temp.scalar_as('authenticated', pg_temp.claims_a(),
    $q$SELECT coalesce(string_agg(paper_id::text, ',' ORDER BY paper_id), '')
         FROM public.filter_papers_by_keywords('20a00000-0000-0000-0000-00000000000a'::uuid, ARRAY['myocardial infarction'])$q$),
  '20a00000-0000-0000-0000-0000000000a1',
  'RLS is live: with the probes dropped the synonym expansion is back (the probe, nothing else, was the cause)');

-- ══ 9. The table grant is live inside the functions ═════════════════════════
-- Revoked inside this transaction only. An INVOKER function needs the CALLER's
-- SELECT; a DEFINER function would use the owner's and keep succeeding. Only
-- filter_papers_by_keywords reads synonym_pool, and only it may be affected.
REVOKE SELECT ON public.synonym_pool FROM authenticated;

SELECT is(
  pg_temp.err_as('authenticated', pg_temp.claims_a(),
    $q$SELECT count(*) FROM public.filter_papers_by_keywords('20a00000-0000-0000-0000-00000000000a'::uuid, ARRAY['zqkw-shared'])$q$),
  '42501 permission denied for table synonym_pool',
  'grant is live: filter_papers_by_keywords needs the caller''s SELECT on synonym_pool');
SELECT is(
  pg_temp.err_as('authenticated', pg_temp.claims_a(),
    $q$SELECT count(*) FROM public.search_papers('20a00000-0000-0000-0000-00000000000a'::uuid,'zqinvoker',10,0)$q$),
  '00000 ',
  'grant is live: search_papers does not read synonym_pool and is unaffected');

-- Restored before the next probe, so each refusal below can only name papers.
GRANT SELECT ON public.synonym_pool TO authenticated;
REVOKE SELECT ON public.papers FROM authenticated;

SELECT is(pg_temp.err_as('authenticated', pg_temp.claims_a(), sql), '42501 permission denied for table papers',
  'grant is live: ' || nm || ' needs the caller''s SELECT on papers (a DEFINER owner would not)')
FROM pg_temp.five_calls();

SELECT * FROM finish();
ROLLBACK;
