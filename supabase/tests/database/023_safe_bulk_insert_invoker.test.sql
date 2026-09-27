-- DB-SAFE-BULK-INSERT-INVOKER-001 suite 023: the caller-owned bulk paper import
-- runs as SECURITY INVOKER, under the caller's table grants and RLS.
--
-- Migration 20260927123856_convert_safe_bulk_insert_security_invoker changed
-- exactly one attribute — prosecdef true → false — on:
--
--   safe_bulk_insert_papers(uuid,jsonb)
--
-- The body rejects the call unless p_user_id equals a non-NULL auth.uid(), then
-- per payload element INSERTs one `papers` row (RETURNING id) inside its own
-- exception block, and on unique_violation looks up the caller's own row by the
-- PMID / case-folded DOI it collided on. After the migration, `authenticated`'s
-- INSERT and SELECT grants on `papers`, its USAGE on papers_insert_order_seq and
-- the caller-owned RLS INSERT and SELECT policies are the PRIMARY database
-- boundary; the identity guard stays as defense-in-depth. This suite owns that
-- change end to end:
--
--   1. posture — one overload, owner, security mode, the C50 search_path
--      `public, pg_temp`, result, arguments, body digest, stored ACL and
--      effective EXECUTE (anon, service_role and PUBLIC refused); and the
--      boundary it relies on: papers' grants, RLS/FORCE RLS and four policies,
--      the sequence grant, the one INSERT-time trigger, and the two identifier
--      indexes the duplicate handler resolves against;
--   2. legitimate behavior — a minimal row (defaults and generated columns), a
--      full-metadata row, NULL optionals, a multi-row batch in payload order, a
--      mixed batch whose result keeps payload order and index values, and an
--      empty payload;
--   3. the identity guard — foreign, NULL and missing caller identities fail
--      the whole call with P0001, before any per-row handling, and write nothing;
--   4. duplicate resolution — owned PMID, owned DOI, DOI case folding, PMID and
--      DOI naming one row, PMID and DOI naming two rows, another account's
--      identifiers, an intra-batch duplicate, and the zero-candidate
--      unique_violation branch;
--   5. RLS IS THE PRIMARY BOUNDARY — a controlled copy of the body with the
--      identity guard removed still cannot write another account's row (G1) or
--      learn another account's paper id through the duplicate lookup (G2); the
--      INSERT and SELECT policies each block the foreign write alone; opening
--      only the new-row checks still hides the other account's rows from the
--      lookup (G5); opening both policies lets the crossing through (G6,
--      negative control), and so does the same guard-free body as SECURITY
--      DEFINER — the posture the migration left;
--   6. caller privilege drift — a revoked INSERT, SELECT, sequence USAGE or
--      generated-column / CHECK function EXECUTE fails closed as per-row
--      `error` at the INSERT and writes nothing (a transaction-local probe
--      column stands in for the generated-column function: since C54
--      search_vector calls only built-ins, and the import is shown to work
--      with the old wrappers retired (C55)); drift that strikes inside the
--      duplicate handler escapes it as an RPC-level error and rolls the whole
--      call back.
--
-- THE BROAD `WHEN OTHERS` HANDLER — kept, by decision (C53)
-- C53 changed the security mode only and deliberately preserves the body. So
-- an authorization or dependency failure that reaches the INSERT — a revoked
-- grant, a revoked EXECUTE, a policy that refuses the caller — is converted by
-- the per-row `WHEN OTHERS` into a `status:"error"` result object, where under
-- SECURITY DEFINER the same drift would have been invisible. That is accepted:
-- it fails closed (nothing is written), no other account's data is exposed,
-- legitimate behavior is unchanged, and the importer (processChunkedInsert /
-- useBulkMutations) already turns a failed RPC chunk into one failed row per
-- paper, so the user sees the same outcome either way. Section 6 pins those
-- semantics on purpose; it asserts SQLSTATEs and result classes, never
-- PostgreSQL's message wording. Narrowing the handler would be a separate body
-- and API change.
--
-- Every probe policy, revoke, grant, controlled copy, index, constraint and mode
-- flip is transaction-local and undone by the ROLLBACK. Deterministic UUIDs;
-- explicit fixtures; no TODO/SKIP; no remote calls; no Production data; no real
-- credentials. pgTAP is created inside the transaction and rolled back with it.
-- Duplicate-resolution coverage that 013 already owns is repeated here only as
-- far as the INVOKER boundary needs it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Run p_sql as p_role with the given JWT claims; return '<SQLSTATE> <message>'
-- ('00000 ' on success).
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

-- The JWT claims PostgREST would set for p_user ('' — no claims — for NULL).
CREATE FUNCTION pg_temp.claims(p_user uuid) RETURNS text LANGUAGE sql AS $hlp$
  SELECT CASE WHEN p_user IS NULL THEN ''
              ELSE json_build_object('sub', p_user, 'role', 'authenticated')::text END
$hlp$;

-- Call public.<p_fn>(p_user, p_payload) as `authenticated` carrying p_caller's
-- claims. Returns the function's jsonb result, or {"rpc_error": "<SQLSTATE>"}
-- when the call itself failed (which PostgREST would answer with an HTTP error
-- and no body rows).
CREATE FUNCTION pg_temp.call(p_fn text, p_caller uuid, p_user uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $hlp$
DECLARE v jsonb; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.claims(p_caller), true);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE format('SELECT public.%I($1, $2)', p_fn) INTO v USING p_user, p_payload;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v := jsonb_build_object('rpc_error', v_state);
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END;
$hlp$;

-- The real function, as caller A for A.
CREATE FUNCTION pg_temp.ins_a(p_payload jsonb) RETURNS jsonb LANGUAGE sql AS $hlp$
  SELECT pg_temp.call('safe_bulk_insert_papers', '23a00000-0000-0000-0000-00000000000a',
                      '23a00000-0000-0000-0000-00000000000a', p_payload)
$hlp$;

-- The guard-free controlled copy (section 5), as caller A, for p_user.
CREATE FUNCTION pg_temp.noguard_a_for(p_user uuid, p_payload jsonb) RETURNS jsonb LANGUAGE sql AS $hlp$
  SELECT pg_temp.call('zz_023_noguard', '23a00000-0000-0000-0000-00000000000a', p_user, p_payload)
$hlp$;

-- The id-free shape of a result: '0:inserted+id 1:error 2:duplicate', or
-- 'rpc_error <SQLSTATE>', or '<empty>'.
CREATE FUNCTION pg_temp.shape(p jsonb) RETURNS text LANGUAGE sql AS $hlp$
  SELECT CASE
           WHEN jsonb_typeof(p) = 'object' AND p ? 'rpc_error' THEN 'rpc_error ' || (p ->> 'rpc_error')
           ELSE coalesce((SELECT string_agg((e ->> 'index') || ':' || (e ->> 'status')
                                            || CASE WHEN e ? 'id' THEN '+id' ELSE '' END, ' ' ORDER BY o)
                            FROM jsonb_array_elements(p) WITH ORDINALITY AS t(e, o)), '<empty>')
         END
$hlp$;

-- Papers whose title starts with p_prefix, for any owner, read as the table
-- owner (RLS bypassed).
CREATE FUNCTION pg_temp.n(p_prefix text) RETURNS integer LANGUAGE sql AS $hlp$
  SELECT count(*)::int FROM public.papers WHERE starts_with(title, p_prefix)
$hlp$;

CREATE FUNCTION pg_temp.n_for(p_user uuid, p_prefix text) RETURNS integer LANGUAGE sql AS $hlp$
  SELECT count(*)::int FROM public.papers WHERE user_id = p_user AND starts_with(title, p_prefix)
$hlp$;

-- ── Fixtures (as the table owner; RLS bypassed) ──────────────────────────────
-- A owns A1–A4, B owns B1. B1 is the "other account's paper" every crossing
-- probe aims at; its PMID and DOI are what a leaked duplicate id would name.
INSERT INTO auth.users (id, email) VALUES
  ('23a00000-0000-0000-0000-00000000000a', 'c53-A@paperlume.test'),
  ('23b00000-0000-0000-0000-00000000000b', 'c53-B@paperlume.test');

INSERT INTO public.papers (id, user_id, title, pmid, doi) VALUES
  ('23a00000-0000-0000-0000-0000000000a1', '23a00000-0000-0000-0000-00000000000a', 'Zqc53 A1', 'PM-C53-A1',   '10.5555/C53-MiXeD-A1'),
  ('23a00000-0000-0000-0000-0000000000a2', '23a00000-0000-0000-0000-00000000000a', 'Zqc53 A2', 'PM-C53-A2',   NULL),
  ('23a00000-0000-0000-0000-0000000000a3', '23a00000-0000-0000-0000-00000000000a', 'Zqc53 A3', NULL,          '10.5555/c53-a3'),
  ('23a00000-0000-0000-0000-0000000000a4', '23a00000-0000-0000-0000-00000000000a', 'Zqc53 A4', 'PM-C53-BOTH', '10.5555/C53-BOTH'),
  ('23b00000-0000-0000-0000-0000000000b1', '23b00000-0000-0000-0000-00000000000b', 'Zqc53 B1', 'PM-C53-B1',   '10.5555/C53-B1');

CREATE TEMP TABLE c53_b1_before AS
  SELECT to_jsonb(p.*) AS row_j FROM public.papers p WHERE p.id = '23b00000-0000-0000-0000-0000000000b1';

SELECT plan(76);

-- ══ 1. Posture ══════════════════════════════════════════════════════════════
SELECT is(
  (SELECT (SELECT count(*) FROM pg_proc p2 WHERE p2.pronamespace = p.pronamespace AND p2.proname = p.proname) || ' overload'
          || ' | ' || pg_get_userbyid(p.proowner)
          || ' | ' || CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END
          || ' | ' || coalesce(p.proconfig::text, '<no config>')
          || ' | ' || l.lanname || ' ' || p.provolatile::text || p.proparallel::text
          || ' strict ' || p.proisstrict::text
          || ' | ' || pg_get_function_result(p.oid) || ' (' || pg_get_function_arguments(p.oid) || ')'
          || ' | body ' || md5(p.prosrc)
          || ' | acl ' || coalesce(p.proacl::text, 'NULL')
          || ' | exec ' || (SELECT coalesce(string_agg(r, ',' ORDER BY r COLLATE "C"), '<nobody>')
                              FROM unnest(ARRAY['PUBLIC','anon','authenticated','service_role']) r
                             WHERE CASE WHEN r = 'PUBLIC'
                                        THEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                                                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                                        ELSE has_function_privilege(r, p.oid, 'EXECUTE') END)
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.oid = 'public.safe_bulk_insert_papers(uuid,jsonb)'::regprocedure),
  '1 overload | postgres | SECURITY INVOKER | {"search_path=public, pg_temp"} | plpgsql vu strict false'
    || ' | jsonb (p_user_id uuid, p_papers jsonb) | body 119925245a5c3c8529ada3d2e10fba96'
    || ' | acl {postgres=X/postgres,authenticated=X/postgres} | exec authenticated',
  'posture: safe_bulk_insert_papers is SECURITY INVOKER, keeps public, pg_temp, its body, owner and authenticated-only EXECUTE');

SELECT is(pg_temp.err_as(r, '',
    $q$SELECT public.safe_bulk_insert_papers('23a00000-0000-0000-0000-00000000000a'::uuid, '[{"title":"Zqc53 acl"}]'::jsonb)$q$),
  '42501 permission denied for function safe_bulk_insert_papers',
  r || ' is refused at the function ACL')
FROM unnest(ARRAY['anon', 'service_role']) r ORDER BY r;

SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
     WHERE p.oid = 'public.safe_bulk_insert_papers(uuid,jsonb)'::regprocedure
       AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
  'PUBLIC holds no EXECUTE on safe_bulk_insert_papers');

-- papers: owner, RLS enabled and forced, authenticated's grant (direct and
-- effective — INSERT and SELECT are the two this function needs; DELETE and
-- TRUNCATE are absent) and anon's effective privileges.
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
          || ' | column grants ' ||
          (SELECT count(*) FROM pg_attribute att WHERE att.attrelid = c.oid AND att.attacl IS NOT NULL)
     FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
  'postgres | rls true | force true | authenticated direct INSERT,SELECT,UPDATE | authenticated effective INSERT,SELECT,UPDATE | anon effective <none> | column grants 0',
  'boundary: papers owner, RLS, FORCE RLS, client grants and no column grants');

-- Every policy on papers, exactly — the INSERT WITH CHECK and the SELECT USING
-- are this function's boundary now.
SELECT is(
  (SELECT string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                     || (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                           FROM unnest(pol.polroles) r) || '|'
                     || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>') || '|'
                     || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>'),
                     E'\n' ORDER BY pol.polname COLLATE "C")
     FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass),
  'Users can create their own papers|a|true|PUBLIC|<null>|(auth.uid() = user_id)' || E'\n' ||
  'Users can delete their own papers|d|true|PUBLIC|(auth.uid() = user_id)|<null>' || E'\n' ||
  'Users can update their own papers|w|true|PUBLIC|(auth.uid() = user_id)|<null>' || E'\n' ||
  'Users can view their own papers|r|true|PUBLIC|(auth.uid() = user_id)|<null>',
  'boundary: papers RLS policies are exactly the reviewed caller-owned four, none RESTRICTIVE');

SELECT ok(
  (SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname = 'authenticated'),
  'boundary: authenticated is neither SUPERUSER nor BYPASSRLS');

-- The insert_order default calls nextval() as the caller.
SELECT is(
  format('authenticated=%s anon=%s',
    (SELECT coalesce(string_agg(pr, ',' ORDER BY pr), '') FROM unnest(ARRAY['SELECT','UPDATE','USAGE']) pr
      WHERE has_sequence_privilege('authenticated', 'public.papers_insert_order_seq', pr)),
    (SELECT coalesce(string_agg(pr, ',' ORDER BY pr), '') FROM unnest(ARRAY['SELECT','UPDATE','USAGE']) pr
      WHERE has_sequence_privilege('anon', 'public.papers_insert_order_seq', pr))),
  'authenticated=USAGE anon=',
  'boundary: authenticated holds exactly USAGE on papers_insert_order_seq, anon nothing');

-- No user-defined trigger fires on INSERT; the only INSERT-time trigger is the
-- internal papers.user_id → auth.users foreign-key check.
SELECT is(
  (SELECT string_agg(CASE WHEN t.tgisinternal
                          THEN 'internal ' || t.tgfoid::regprocedure::text || ' for ' || con.conname || ' -> ' || t.tgconstrrelid::regclass::text
                          ELSE 'user-defined ' || t.tgname END, E'\n' ORDER BY t.tgname COLLATE "C")
     FROM pg_trigger t LEFT JOIN pg_constraint con ON con.oid = t.tgconstraint
    WHERE t.tgrelid = 'public.papers'::regclass AND (t.tgtype & 4) <> 0),
  'internal "RI_FKey_check_ins"() for papers_user_id_fkey -> auth.users',
  'boundary: the only INSERT-time trigger on papers is the internal user_id foreign-key check');

-- PostgreSQL runs that check as the referenced table's owner, so the caller
-- needs nothing on auth.users — and holds nothing (section 2 inserts anyway).
SELECT is(
  (SELECT coalesce(string_agg(pr, ',' ORDER BY pr), '') FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pr
    WHERE has_table_privilege('authenticated', 'auth.users', pr)),
  '',
  'boundary: authenticated holds no privilege on auth.users');

-- The two per-user identifier indexes the duplicate handler resolves against.
SELECT is(
  (SELECT string_agg(ci.relname || ' valid=' || i.indisvalid::text || ' ready=' || i.indisready::text || ' | '
                     || pg_get_indexdef(i.indexrelid), E'\n' ORDER BY ci.relname COLLATE "C")
     FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid
    WHERE i.indrelid = 'public.papers'::regclass
      AND ci.relname IN ('idx_papers_user_doi_unique', 'idx_papers_user_pmid_unique')),
  'idx_papers_user_doi_unique valid=true ready=true | CREATE UNIQUE INDEX idx_papers_user_doi_unique ON public.papers USING btree (user_id, lower(doi)) WHERE (doi IS NOT NULL)'
  || E'\n' ||
  'idx_papers_user_pmid_unique valid=true ready=true | CREATE UNIQUE INDEX idx_papers_user_pmid_unique ON public.papers USING btree (user_id, pmid) WHERE (pmid IS NOT NULL)',
  'boundary: the PMID and folded-DOI unique indexes are the reviewed ones, valid and ready');

-- The body digest above pins every byte; this says what C53 kept, in words:
-- the identity guard runs once, before the per-row loop (so outside every
-- per-row exception block), and the handler is still unique_violation then
-- the broad WHEN OTHERS, with no narrower privilege clause.
SELECT ok(
  (SELECT position('Unauthorized: user mismatch' IN prosrc) > 0
          AND position('p_user_id <> auth.uid()' IN prosrc) < position('FOR v_paper IN' IN prosrc)
          AND position('WHEN unique_violation THEN' IN prosrc) < position('WHEN OTHERS THEN' IN prosrc)
          AND position('insufficient_privilege' IN prosrc) = 0
     FROM pg_proc WHERE oid = 'public.safe_bulk_insert_papers(uuid,jsonb)'::regprocedure),
  'defense-in-depth retained: the guard precedes the loop, and the per-row handler is unchanged (C53 is mode-only)');

-- ══ 2. Legitimate behavior ══════════════════════════════════════════════════
-- 2a. A minimal row: defaults and generated columns fill the rest.
CREATE TEMP TABLE c53_r (label text PRIMARY KEY, res jsonb);
INSERT INTO c53_r VALUES ('minimal', pg_temp.ins_a('[{"title":"Zqc53 minimal alphaword"}]'));

SELECT is(pg_temp.shape(res), '0:inserted+id', 'minimal: one inserted result with an id')
FROM c53_r WHERE label = 'minimal';
SELECT is((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(res -> 0) k), 'id,index,status',
  'minimal: the result object carries exactly index, status and id')
FROM c53_r WHERE label = 'minimal';
SELECT is(
  (SELECT p.user_id::text || ' | ' || p.title FROM public.papers p WHERE p.id = (res -> 0 ->> 'id')::uuid),
  '23a00000-0000-0000-0000-00000000000a | Zqc53 minimal alphaword',
  'minimal: the returned id is the stored row, owned by the caller')
FROM c53_r WHERE label = 'minimal';
SELECT is(
  (SELECT format('authors=%s keywords=%s mesh=%s substances=%s raw_keywords=%s created_now=%s updated_now=%s insert_order=%s has_abstract=%s nulls=%s',
                 p.authors, p.keywords, p.mesh_terms, p.substances, p.raw_keywords,
                 p.created_at = now(), p.updated_at = now(), p.insert_order IS NOT NULL, p.has_abstract,
                 num_nulls(p.year, p.journal, p.pmid, p.doi, p.abstract, p.study_type, p.raw_study_type,
                           p.raw_publication_types, p.statistical_methods, p.author_provenance,
                           p.pubmed_url, p.journal_url, p.drive_url, p.notes, p.tldr))
     FROM public.papers p WHERE p.id = (res -> 0 ->> 'id')::uuid),
  'authors=[] keywords=[] mesh=[] substances=[] raw_keywords=[] created_now=t updated_now=t insert_order=t has_abstract=f nulls=15',
  'minimal: empty lists, now() timestamps, a sequence insert_order, has_abstract false, every optional NULL')
FROM c53_r WHERE label = 'minimal';
SELECT ok(
  (SELECT p.search_vector @@ plainto_tsquery('english', 'alphaword') FROM public.papers p WHERE p.id = (res -> 0 ->> 'id')::uuid),
  'minimal: the generated search_vector was computed from the title, as the caller')
FROM c53_r WHERE label = 'minimal';

-- 2b. A full-metadata row, canonicalized exactly as before.
INSERT INTO c53_r VALUES ('full', pg_temp.ins_a($j$[{
  "title": "Zqc53 full metadata",
  "authors": ["Ada Zqcauthor"],
  "author_provenance": [{"source":"manual","source_field":"authors","kind":"unknown","source_name":"Ada Zqcauthor",
                         "given_name":null,"family_name":null,"initials":null,"suffix":null,"collective_name":null,
                         "affiliations":[],"identifiers":[],"orcid":null,"orcid_authenticated":null}],
  "year": 2024, "journal": "Zqcjournal", "pmid": "PM-C53-FULL", "doi": "10.5555/C53-FULL",
  "abstract": "Zqcabstractword text", "study_type": "RCT", "raw_study_type": "Randomized Controlled Trial",
  "raw_publication_types": ["  Randomized Controlled Trial ", "", "Clinical Trial, Phase II"],
  "statistical_methods": ["t-test", "ANOVA"],
  "keywords": ["zqckeyword"], "raw_keywords": ["Zqckeyword"], "mesh_terms": ["Zqcmesh"], "substances": ["Zqcsubstance"],
  "pubmed_url": "https://pubmed.ncbi.nlm.nih.gov/0/", "journal_url": "https://example.org/j", "drive_url": "https://example.org/d"
}]$j$));

SELECT is(pg_temp.shape(res), '0:inserted+id', 'full: one inserted result with an id')
FROM c53_r WHERE label = 'full';
SELECT is(
  (SELECT to_jsonb(p.*) - ARRAY['id', 'user_id', 'created_at', 'updated_at', 'insert_order', 'search_vector', 'notes', 'tldr']
     FROM public.papers p WHERE p.id = (res -> 0 ->> 'id')::uuid),
  $j${"doi": "10.5555/C53-FULL", "pmid": "PM-C53-FULL", "year": 2024, "title": "Zqc53 full metadata",
      "authors": ["Ada Zqcauthor"], "journal": "Zqcjournal", "abstract": "Zqcabstractword text",
      "keywords": ["zqckeyword"], "drive_url": "https://example.org/d", "mesh_terms": ["Zqcmesh"],
      "pubmed_url": "https://pubmed.ncbi.nlm.nih.gov/0/", "study_type": "RCT", "substances": ["Zqcsubstance"],
      "journal_url": "https://example.org/j", "has_abstract": true, "raw_keywords": ["Zqckeyword"],
      "raw_study_type": "Randomized Controlled Trial",
      "author_provenance": [{"kind": "unknown", "orcid": null, "source": "manual", "suffix": null, "initials": null,
                             "given_name": null, "family_name": null, "identifiers": [], "source_name": "Ada Zqcauthor",
                             "affiliations": [], "source_field": "authors", "collective_name": null,
                             "orcid_authenticated": null}],
      "statistical_methods": "t-test, ANOVA",
      "raw_publication_types": ["Randomized Controlled Trial", "Clinical Trial, Phase II"]}$j$::jsonb,
  'full: every supplied column is stored — provenance intact, publication types trimmed, statistical methods joined')
FROM c53_r WHERE label = 'full';
SELECT ok(
  (SELECT p.search_vector @@ plainto_tsquery('english', 'zqcabstractword')
          AND p.search_vector @@ plainto_tsquery('english', 'zqcjournal')
          AND p.search_vector @@ plainto_tsquery('english', 'zqckeyword')
     FROM public.papers p WHERE p.id = (res -> 0 ->> 'id')::uuid),
  'full: search_vector covers the abstract, journal and keywords')
FROM c53_r WHERE label = 'full';

-- 2c. Explicit NULL optionals: all stored as SQL NULL.
INSERT INTO c53_r VALUES ('nulls', pg_temp.ins_a(
  '[{"title":"Zqc53 nulls","year":null,"journal":null,"pmid":null,"doi":null,"abstract":null,"study_type":null,'
  '"raw_study_type":null,"raw_publication_types":null,"statistical_methods":null,"author_provenance":null,'
  '"pubmed_url":null,"journal_url":null,"drive_url":null}]'));
SELECT is(pg_temp.shape(res), '0:inserted+id', 'nulls: one inserted result with an id')
FROM c53_r WHERE label = 'nulls';
SELECT is(
  (SELECT num_nulls(p.year, p.journal, p.pmid, p.doi, p.abstract, p.study_type, p.raw_study_type,
                    p.raw_publication_types, p.statistical_methods, p.author_provenance,
                    p.pubmed_url, p.journal_url, p.drive_url)
     FROM public.papers p WHERE p.id = (res -> 0 ->> 'id')::uuid),
  13, 'nulls: every explicit JSON null is stored as SQL NULL')
FROM c53_r WHERE label = 'nulls';

-- 2d. A multi-row batch: payload order, one id each, insert_order ascending.
INSERT INTO c53_r VALUES ('batch', pg_temp.ins_a(
  '[{"title":"Zqc53 batch 0"},{"title":"Zqc53 batch 1"},{"title":"Zqc53 batch 2"}]'));
SELECT is(pg_temp.shape(res), '0:inserted+id 1:inserted+id 2:inserted+id', 'batch: three inserted results, in payload order')
FROM c53_r WHERE label = 'batch';
SELECT is(
  (SELECT string_agg(p.title, ',' ORDER BY e.o)
     FROM jsonb_array_elements(res) WITH ORDINALITY AS e(r, o)
     JOIN public.papers p ON p.id = (e.r ->> 'id')::uuid
                         AND p.user_id = '23a00000-0000-0000-0000-00000000000a'),
  'Zqc53 batch 0,Zqc53 batch 1,Zqc53 batch 2',
  'batch: each returned id is the caller''s row for the element at that index')
FROM c53_r WHERE label = 'batch';
SELECT ok(
  (SELECT bool_and(a.insert_order < b.insert_order)
     FROM jsonb_array_elements(res) WITH ORDINALITY AS e1(r, o)
     JOIN jsonb_array_elements(res) WITH ORDINALITY AS e2(r, o) ON e2.o = e1.o + 1
     JOIN public.papers a ON a.id = (e1.r ->> 'id')::uuid
     JOIN public.papers b ON b.id = (e2.r ->> 'id')::uuid),
  'batch: insert_order ascends in payload order')
FROM c53_r WHERE label = 'batch';

-- 2e. A mixed batch keeps payload order and index values: a malformed element
-- fails alone and an owned duplicate resolves, while the valid rows around them
-- still insert.
INSERT INTO c53_r VALUES ('mixed', pg_temp.ins_a(
  '[{"title":"Zqc53 mixed 0"},{"title":"Zqc53 mixed 1","statistical_methods":42},'
  '{"title":"Zqc53 mixed 2","pmid":"PM-C53-A2"},{"title":"Zqc53 mixed 3"}]'));
SELECT is(pg_temp.shape(res), '0:inserted+id 1:error 2:duplicate+id 3:inserted+id',
  'mixed: results keep payload order and index values')
FROM c53_r WHERE label = 'mixed';
SELECT ok(res -> 1 ? 'error_message' AND NOT (res -> 1 ? 'id'), 'mixed: the malformed element reports an error_message and no id')
FROM c53_r WHERE label = 'mixed';
SELECT is(pg_temp.n_for('23a00000-0000-0000-0000-00000000000a', 'Zqc53 mixed'), 2,
  'mixed: exactly the two valid rows were stored')
FROM c53_r WHERE label = 'mixed';

-- 2f. An empty payload.
SELECT is(pg_temp.ins_a('[]'), '[]'::jsonb, 'empty: an empty payload returns an empty result');

-- ══ 3. The identity guard (defense-in-depth, unchanged) ═════════════════════
SELECT is(pg_temp.err_as('authenticated', pg_temp.claims('23a00000-0000-0000-0000-00000000000a'),
    $q$SELECT public.safe_bulk_insert_papers('23b00000-0000-0000-0000-00000000000b'::uuid, '[{"title":"Zqc53 guard foreign"}]'::jsonb)$q$),
  'P0001 Unauthorized: user mismatch', 'guard: a foreign p_user_id is rejected with P0001');
SELECT is(pg_temp.err_as('authenticated', pg_temp.claims('23a00000-0000-0000-0000-00000000000a'),
    $q$SELECT public.safe_bulk_insert_papers(NULL::uuid, '[{"title":"Zqc53 guard null user"}]'::jsonb)$q$),
  'P0001 Unauthorized: user mismatch', 'guard: a NULL p_user_id is rejected with P0001');
SELECT is(pg_temp.err_as('authenticated', '',
    $q$SELECT public.safe_bulk_insert_papers('23a00000-0000-0000-0000-00000000000a'::uuid, '[{"title":"Zqc53 guard no claims"}]'::jsonb)$q$),
  'P0001 Unauthorized: user mismatch', 'guard: a call without auth claims is rejected with P0001');
SELECT is(pg_temp.err_as('authenticated', '',
    $q$SELECT public.safe_bulk_insert_papers(NULL::uuid, '[{"title":"Zqc53 guard nothing"}]'::jsonb)$q$),
  'P0001 Unauthorized: user mismatch', 'guard: no claims and a NULL p_user_id is rejected with P0001');
-- The guard is outside the per-row handler, so even a payload whose rows would
-- each have failed is refused as a whole, not row by row.
SELECT is(pg_temp.shape(pg_temp.call('safe_bulk_insert_papers', '23a00000-0000-0000-0000-00000000000a',
                                     '23b00000-0000-0000-0000-00000000000b',
                                     '[{"title":"Zqc53 guard malformed","statistical_methods":42}]')),
  'rpc_error P0001', 'guard: a foreign call fails as a whole before any per-row handling');
SELECT is(pg_temp.n('Zqc53 guard'), 0, 'guard: no rejected call created a paper for anyone');

-- ══ 4. Duplicate resolution (the caller's own rows only) ════════════════════
SELECT is((SELECT pg_temp.shape(r) || ' ' || (r -> 0 ->> 'id')
             FROM pg_temp.ins_a('[{"title":"Zqc53 dup pmid","pmid":"PM-C53-A2"}]') r),
  '0:duplicate+id 23a00000-0000-0000-0000-0000000000a2', 'duplicate: an owned PMID resolves to the caller''s row');
SELECT is((SELECT pg_temp.shape(r) || ' ' || (r -> 0 ->> 'id')
             FROM pg_temp.ins_a('[{"title":"Zqc53 dup doi","doi":"10.5555/c53-a3"}]') r),
  '0:duplicate+id 23a00000-0000-0000-0000-0000000000a3', 'duplicate: an owned DOI resolves to the caller''s row');
SELECT is((SELECT pg_temp.shape(r) || ' ' || (r -> 0 ->> 'id')
             FROM pg_temp.ins_a('[{"title":"Zqc53 dup folded","doi":"10.5555/c53-mixed-a1"}]') r),
  '0:duplicate+id 23a00000-0000-0000-0000-0000000000a1', 'duplicate: DOI resolution folds case exactly as the index does');
SELECT is((SELECT pg_temp.shape(r) || ' ' || (r -> 0 ->> 'id')
             FROM pg_temp.ins_a('[{"title":"Zqc53 dup both","pmid":"PM-C53-BOTH","doi":"10.5555/c53-both"}]') r),
  '0:duplicate+id 23a00000-0000-0000-0000-0000000000a4', 'duplicate: a PMID and a DOI naming the same row resolve once, to it');
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 dup ambiguous","pmid":"PM-C53-A2","doi":"10.5555/c53-a3"}]')),
  '0:duplicate', 'duplicate: a PMID and a DOI naming two different rows return no id');
SELECT is(pg_temp.n('Zqc53 dup'), 0, 'duplicate: no duplicate call inserted a row');

-- Another account's identifiers are not a collision for this caller, and are
-- never consulted: the row inserts with a new id of the caller's own.
INSERT INTO c53_r VALUES ('foreign_ids', pg_temp.ins_a('[{"title":"Zqc53 foreign ids","pmid":"PM-C53-B1","doi":"10.5555/C53-B1"}]'));
SELECT is(pg_temp.shape(res) || ' ' || ((res -> 0 ->> 'id') <> '23b00000-0000-0000-0000-0000000000b1')::text
          || ' ' || (SELECT p.user_id::text FROM public.papers p WHERE p.id = (res -> 0 ->> 'id')::uuid),
  '0:inserted+id true 23a00000-0000-0000-0000-00000000000a',
  'isolation: another account''s PMID and DOI insert a new row of the caller''s own, never naming B1')
FROM c53_r WHERE label = 'foreign_ids';
SELECT is((SELECT to_jsonb(p.*) FROM public.papers p WHERE p.id = '23b00000-0000-0000-0000-0000000000b1'),
          (SELECT row_j FROM c53_b1_before),
  'isolation: the other account''s paper is byte-for-byte unchanged');
SELECT is((SELECT pg_temp.shape(r) || ' ' || (r -> 0 ->> 'id')
             FROM pg_temp.call('safe_bulk_insert_papers', '23b00000-0000-0000-0000-00000000000b', '23b00000-0000-0000-0000-00000000000b',
                               '[{"title":"Zqc53 B own dup","pmid":"PM-C53-B1"}]') r),
  '0:duplicate+id 23b00000-0000-0000-0000-0000000000b1',
  'isolation: the owner of that PMID still resolves it to its own row');

-- An intra-batch duplicate resolves to the row inserted earlier in the batch.
SELECT is((SELECT pg_temp.shape(r) || ' ' || ((r -> 0 ->> 'id') = (r -> 1 ->> 'id'))::text
             FROM pg_temp.ins_a('[{"title":"Zqc53 intra first","pmid":"PM-C53-INTRA"},{"title":"Zqc53 intra second","pmid":"PM-C53-INTRA"}]') r),
  '0:inserted+id 1:duplicate+id true',
  'intra-batch: a repeated PMID resolves to the row the same batch inserted first');

-- The zero-candidate branch: a unique_violation on a constraint that is not a
-- PMID/DOI one (a transaction-local probe index) finds no candidate and returns
-- a duplicate with no id.
CREATE UNIQUE INDEX zz_023_title_probe ON public.papers (user_id, title) WHERE (starts_with(title, 'Zqc53 zero'));
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 zero candidate"}]')), '0:inserted+id',
  'zero candidates: the first row under the probe index inserts');
SELECT is((SELECT pg_temp.shape(r) || ' ' || (r -> 0 ? 'error_message')::text
             FROM pg_temp.ins_a('[{"title":"Zqc53 zero candidate"}]') r),
  '0:duplicate true', 'zero candidates: a unique_violation with no PMID/DOI candidate is a duplicate with no id');
DROP INDEX public.zz_023_title_probe;

-- ══ 5. RLS, not the identity guard, is the primary boundary ═════════════════
-- A controlled copy of the body with the guard removed — byte-for-byte the real
-- body otherwise — created as SECURITY INVOKER with the same path and the same
-- authenticated-only EXECUTE. Transaction-local.
DO $mk$
DECLARE v_body text;
BEGIN
  SELECT replace(prosrc,
                 E'  IF p_user_id IS NULL\n     OR auth.uid() IS NULL\n     OR p_user_id <> auth.uid()\n  THEN\n'
                 || E'    RAISE EXCEPTION ''Unauthorized: user mismatch'';\n  END IF;\n', '')
    INTO v_body
    FROM pg_proc WHERE oid = 'public.safe_bulk_insert_papers(uuid,jsonb)'::regprocedure;
  EXECUTE format('CREATE FUNCTION public.zz_023_noguard(p_user_id uuid, p_papers jsonb) RETURNS jsonb LANGUAGE plpgsql '
                 'SECURITY INVOKER SET search_path = public, pg_temp AS %L', v_body);
  REVOKE ALL ON FUNCTION public.zz_023_noguard(uuid, jsonb) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.zz_023_noguard(uuid, jsonb) TO authenticated;
END
$mk$;

SELECT is(
  (SELECT CASE WHEN c.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || '|' || position('Unauthorized' IN c.prosrc)::text
          || '|' || (length(o.prosrc) - length(c.prosrc) > 0)::text
          || '|' || (replace(o.prosrc,
                             E'  IF p_user_id IS NULL\n     OR auth.uid() IS NULL\n     OR p_user_id <> auth.uid()\n  THEN\n'
                             || E'    RAISE EXCEPTION ''Unauthorized: user mismatch'';\n  END IF;\n', '') = c.prosrc)::text
     FROM pg_proc c, pg_proc o
    WHERE c.oid = 'public.zz_023_noguard(uuid,jsonb)'::regprocedure
      AND o.oid = 'public.safe_bulk_insert_papers(uuid,jsonb)'::regprocedure),
  'INVOKER|0|true|true',
  'control: zz_023_noguard is the real body minus the identity guard, as SECURITY INVOKER');

-- G1. Guard removed, RLS intact: a row for another account is refused (the
-- WITH CHECK violation is caught per row) and nothing is written.
SELECT is(pg_temp.shape(pg_temp.noguard_a_for('23b00000-0000-0000-0000-00000000000b', '[{"title":"Zqc53 G1 forged"}]')),
  '0:error', 'G1: without the guard, a row for another account fails per row');
SELECT is(pg_temp.n('Zqc53 G1'), 0, 'G1: RLS alone kept the foreign row from being written');

-- G2. Guard removed, RLS intact: another account's PMID cannot be turned into
-- its paper id — the insert is refused before any unique check, so the
-- duplicate lookup never runs and no id is returned.
SELECT is(pg_temp.shape(pg_temp.noguard_a_for('23b00000-0000-0000-0000-00000000000b',
                                              '[{"title":"Zqc53 G2 probe","pmid":"PM-C53-B1","doi":"10.5555/C53-B1"}]')),
  '0:error', 'G2: without the guard, another account''s identifiers disclose no paper id');

-- Each policy blocks alone. SELECT opened: the INSERT policy's WITH CHECK still
-- refuses. INSERT opened: the SELECT policy, applied to the new row because of
-- RETURNING, still refuses.
CREATE POLICY zz_023_open_select ON public.papers AS PERMISSIVE FOR SELECT TO authenticated USING (true);
SELECT is(pg_temp.shape(pg_temp.noguard_a_for('23b00000-0000-0000-0000-00000000000b', '[{"title":"Zqc53 G3 forged"}]'))
          || ' ' || pg_temp.n('Zqc53 G3'),
  '0:error 0', 'SELECT policy opened: the INSERT policy alone still blocks the foreign row');
DROP POLICY zz_023_open_select ON public.papers;

CREATE POLICY zz_023_open_insert ON public.papers AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (true);
SELECT is(pg_temp.shape(pg_temp.noguard_a_for('23b00000-0000-0000-0000-00000000000b', '[{"title":"Zqc53 G4 forged"}]'))
          || ' ' || pg_temp.n('Zqc53 G4'),
  '0:error 0', 'INSERT policy opened: the SELECT policy (through RETURNING) alone still blocks the foreign row');
DROP POLICY zz_023_open_insert ON public.papers;

-- G5. Open ONLY the new-row checks: both policies admit exactly the forged
-- rows (by title), not the other account's existing ones. The forged insert
-- now passes RLS and collides on B1's PMID — and the duplicate lookup, still
-- under the SELECT policy, cannot see B1, so no id comes back.
CREATE POLICY zz_023_g5_insert ON public.papers AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (starts_with(title, 'Zqc53 G5'));
CREATE POLICY zz_023_g5_select ON public.papers AS PERMISSIVE FOR SELECT TO authenticated USING (starts_with(title, 'Zqc53 G5'));
SELECT is(pg_temp.shape(pg_temp.noguard_a_for('23b00000-0000-0000-0000-00000000000b',
                                              '[{"title":"Zqc53 G5 collide","pmid":"PM-C53-B1"}]')),
  '0:duplicate', 'G5: with only new-row checks opened, the lookup still cannot see the other account''s paper — no id');
SELECT is(pg_temp.n('Zqc53 G5 collide'), 0, 'G5: the colliding forged row was not written');
-- The control that makes G5 meaningful: the same opened checks really do let
-- a forged row through, so the missing id above is SELECT visibility at work.
SELECT is(pg_temp.shape(pg_temp.noguard_a_for('23b00000-0000-0000-0000-00000000000b', '[{"title":"Zqc53 G5 fresh"}]'))
          || ' ' || pg_temp.n_for('23b00000-0000-0000-0000-00000000000b', 'Zqc53 G5 fresh'),
  '0:inserted+id 1', 'G5 control: the opened new-row checks admit a non-colliding forged row');
DROP POLICY zz_023_g5_insert ON public.papers;
DROP POLICY zz_023_g5_select ON public.papers;

-- G6. NEGATIVE CONTROL — both policies opened fully: now, and only now, the
-- guard-free INVOKER body names the other account's paper and writes rows
-- into its library. So it was RLS that held the boundary in G1–G5.
CREATE POLICY zz_023_open_insert ON public.papers AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY zz_023_open_select ON public.papers AS PERMISSIVE FOR SELECT TO authenticated USING (true);
SELECT is((SELECT pg_temp.shape(r) || ' ' || (r -> 0 ->> 'id')
             FROM pg_temp.noguard_a_for('23b00000-0000-0000-0000-00000000000b', '[{"title":"Zqc53 G6 collide","pmid":"PM-C53-B1"}]') r),
  '0:duplicate+id 23b00000-0000-0000-0000-0000000000b1',
  'G6 negative control: with both policies opened the lookup discloses the other account''s paper id');
SELECT is(pg_temp.shape(pg_temp.noguard_a_for('23b00000-0000-0000-0000-00000000000b', '[{"title":"Zqc53 G6 forged"}]'))
          || ' ' || pg_temp.n_for('23b00000-0000-0000-0000-00000000000b', 'Zqc53 G6 forged'),
  '0:inserted+id 1', 'G6 negative control: with both policies opened a row is written into the other account''s library');
DROP POLICY zz_023_open_insert ON public.papers;
DROP POLICY zz_023_open_select ON public.papers;

-- The posture the migration left: with RLS back in place, the same guard-free
-- body as SECURITY DEFINER runs as `postgres` (BYPASSRLS) and crosses anyway.
-- Under DEFINER the guard was the ONLY boundary; under INVOKER it is
-- defense-in-depth.
ALTER FUNCTION public.zz_023_noguard(uuid, jsonb) SECURITY DEFINER;
SELECT is(pg_temp.shape(pg_temp.noguard_a_for('23b00000-0000-0000-0000-00000000000b', '[{"title":"Zqc53 G7 forged"}]'))
          || ' ' || pg_temp.n_for('23b00000-0000-0000-0000-00000000000b', 'Zqc53 G7 forged'),
  '0:inserted+id 1', 'DEFINER contrast: without its guard the body writes into another account''s library despite RLS');
SELECT is((SELECT pg_temp.shape(r) || ' ' || (r -> 0 ->> 'id')
             FROM pg_temp.noguard_a_for('23b00000-0000-0000-0000-00000000000b', '[{"title":"Zqc53 G7 collide","pmid":"PM-C53-B1"}]') r),
  '0:duplicate+id 23b00000-0000-0000-0000-0000000000b1',
  'DEFINER contrast: without its guard the body discloses another account''s paper id despite RLS');
DROP FUNCTION public.zz_023_noguard(uuid, jsonb);

-- The real function keeps the guard, so the same crossing never gets that far.
SELECT is(pg_temp.shape(pg_temp.call('safe_bulk_insert_papers', '23a00000-0000-0000-0000-00000000000a',
                                     '23b00000-0000-0000-0000-00000000000b', '[{"title":"Zqc53 G8 forged","pmid":"PM-C53-B1"}]')),
  'rpc_error P0001', 'defense-in-depth: the real function still refuses the crossing at its guard');

-- ══ 6. Caller privilege drift: fails closed ═════════════════════════════════
-- Each revoke is transaction-local. Failures that reach the INSERT are caught
-- by the per-row WHEN OTHERS (accepted by C53, see the header): the call
-- returns normally with one `error` per element and writes nothing.
REVOKE INSERT ON public.papers FROM authenticated;
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 drift insert 0"},{"title":"Zqc53 drift insert 1"}]'))
          || ' ' || pg_temp.n('Zqc53 drift insert'),
  '0:error 1:error 0', 'drift: without the caller''s INSERT every element fails per row and nothing is written');
-- Under SECURITY DEFINER the same drift was invisible: the owner's INSERT was used.
ALTER FUNCTION public.safe_bulk_insert_papers(uuid,jsonb) SECURITY DEFINER;
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 drift definer"}]')), '0:inserted+id',
  'DEFINER contrast: the same call as SECURITY DEFINER ignores the caller''s missing INSERT');
ALTER FUNCTION public.safe_bulk_insert_papers(uuid,jsonb) SECURITY INVOKER;
GRANT INSERT ON public.papers TO authenticated;
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.safe_bulk_insert_papers(uuid,jsonb)'::regprocedure), false,
  'DEFINER contrast undone: safe_bulk_insert_papers is SECURITY INVOKER again');

-- SELECT revoked: `RETURNING id` needs it, so the INSERT itself is refused.
REVOKE SELECT ON public.papers FROM authenticated;
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 drift select"}]')) || ' ' || pg_temp.n('Zqc53 drift select'),
  '0:error 0', 'drift: without the caller''s SELECT the INSERT ... RETURNING fails per row and nothing is written');
GRANT SELECT ON public.papers TO authenticated;

-- Sequence USAGE revoked: the insert_order default's nextval() is refused.
REVOKE USAGE ON SEQUENCE public.papers_insert_order_seq FROM authenticated;
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 drift sequence"}]')) || ' ' || pg_temp.n('Zqc53 drift sequence'),
  '0:error 0', 'drift: without USAGE on papers_insert_order_seq the INSERT fails per row and nothing is written');
GRANT USAGE ON SEQUENCE public.papers_insert_order_seq TO authenticated;

-- The old search_vector wrappers are not on the INSERT path: since C54 the
-- expression calls only built-ins, and C55 retired the wrappers (007 and 024
-- pin their absence), so the import and a direct browser INSERT both work
-- without them.
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 no wrapper import","authors":["Zqc Author"],"keywords":["zqckw"]}]'))
          || ' ' || pg_temp.n('Zqc53 no wrapper import'),
  '0:inserted+id 1', 'no wrapper dependency: with the old wrappers retired the import inserts');
SELECT is(pg_temp.err_as('authenticated', pg_temp.claims('23a00000-0000-0000-0000-00000000000a'),
            $q$INSERT INTO public.papers (user_id, title, keywords) VALUES ('23a00000-0000-0000-0000-00000000000a', 'Zqc53 no wrapper direct', '["zqcdirect"]')$q$),
  '00000 ', 'no wrapper dependency: a direct browser INSERT works without them too');
-- (Read in a later statement: a subquery in the INSERT's own statement would
-- share its pre-INSERT snapshot.)
SELECT ok((SELECT p.search_vector IS NOT DISTINCT FROM (
                    setweight(to_tsvector('english'::regconfig, COALESCE(p.title, ''::text)), 'A')
                    || setweight(to_tsvector('english'::regconfig, COALESCE(p.abstract, ''::text)), 'B')
                    || setweight(to_tsvector('english'::regconfig, COALESCE(p.journal, ''::text)), 'C')
                    || setweight(to_tsvector('english'::regconfig, COALESCE(p.authors::text, ''::text)), 'C')
                    || setweight(to_tsvector('english'::regconfig, COALESCE(p.keywords::text, ''::text)), 'C')
                    || setweight(to_tsvector('english'::regconfig, COALESCE(p.notes, ''::text)), 'D'))
                  AND p.search_vector @@ plainto_tsquery('english', 'zqcdirect')
             FROM public.papers p WHERE p.title = 'Zqc53 no wrapper direct'),
  'no wrapper dependency: that row stores the canonical direct vector');

-- A generated-column function's EXECUTE revoked. papers' own search_vector
-- calls only built-ins this role cannot revoke, so a transaction-local probe
-- generated column on a probe function stands in for it. A direct browser
-- INSERT carries the same dependency.
CREATE FUNCTION public.zz_023_gen_probe(p_title text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
REVOKE ALL ON FUNCTION public.zz_023_gen_probe(text) FROM PUBLIC;
ALTER TABLE public.papers ADD COLUMN zz_023_gen boolean GENERATED ALWAYS AS (public.zz_023_gen_probe(title)) STORED;
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 drift generated"}]')) || ' ' || pg_temp.n('Zqc53 drift generated'),
  '0:error 0', 'drift: without EXECUTE on a generated-column function the INSERT fails per row and nothing is written');
SELECT is((SELECT left(e, 5) || ' ' || (position('zz_023_gen_probe' IN e) > 0)::text
             FROM pg_temp.err_as('authenticated', pg_temp.claims('23a00000-0000-0000-0000-00000000000a'),
                    $q$INSERT INTO public.papers (user_id, title) VALUES ('23a00000-0000-0000-0000-00000000000a', 'Zqc53 drift direct')$q$) e),
  '42501 true',
  'drift: a direct browser INSERT carries the same generated-column dependency (not introduced by INVOKER)');
ALTER TABLE public.papers DROP COLUMN zz_023_gen;
DROP FUNCTION public.zz_023_gen_probe(text);

-- A CHECK constraint's function EXECUTE revoked. papers' own CHECKs call only
-- built-ins this role cannot revoke, so a transaction-local probe constraint on
-- a probe function stands in for them.
CREATE FUNCTION public.zz_023_check_probe(p_title text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS 'BEGIN RETURN true; END';
REVOKE ALL ON FUNCTION public.zz_023_check_probe(text) FROM PUBLIC;
ALTER TABLE public.papers ADD CONSTRAINT zz_023_check_probe CHECK (public.zz_023_check_probe(title)) NOT VALID;
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 drift check"}]')) || ' ' || pg_temp.n('Zqc53 drift check'),
  '0:error 0', 'drift: without EXECUTE on a CHECK constraint''s function the INSERT fails per row and nothing is written');
ALTER TABLE public.papers DROP CONSTRAINT zz_023_check_probe;
DROP FUNCTION public.zz_023_check_probe(text);

-- Drift that strikes INSIDE the duplicate handler is not caught by that same
-- block: it escapes as an RPC-level error and the whole call — including a row
-- inserted earlier in it — rolls back. Column SELECT narrowed to (id, user_id):
-- `RETURNING id` still works, but the handler's lookup reads pmid and doi.
REVOKE SELECT ON public.papers FROM authenticated;
GRANT SELECT (id, user_id) ON public.papers TO authenticated;
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 drift handler alone"}]')), '0:inserted+id',
  'handler drift: a row that never reaches the handler still inserts');
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 drift handler first"},{"title":"Zqc53 drift handler dup","pmid":"PM-C53-A2"}]')),
  'rpc_error 42501', 'handler drift: a failure inside the duplicate handler escapes it as an RPC-level 42501');
SELECT is(pg_temp.n('Zqc53 drift handler first'), 0,
  'handler drift: the whole call rolled back, including the row inserted before the duplicate');
REVOKE SELECT (id, user_id) ON public.papers FROM authenticated;
GRANT SELECT ON public.papers TO authenticated;

-- Everything restored: the real function inserts and resolves again.
SELECT is(pg_temp.shape(pg_temp.ins_a('[{"title":"Zqc53 restored"},{"title":"Zqc53 restored dup","pmid":"PM-C53-A2"}]')),
  '0:inserted+id 1:duplicate+id', 'restored: with every grant back the function inserts and resolves duplicates again');

SELECT * FROM finish();
ROLLBACK;
