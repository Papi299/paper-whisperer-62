-- CHROME-EXTENSION-IMPORT-001D suite 013: deterministic duplicate resolution
-- and additive taxonomy assignment.
--
-- Owns the database half of migration 20260903180000. Three claims are made
-- there, and all three are AUTHORIZATION or CORRECTNESS claims rather than
-- conveniences, so none of them is assumed here:
--
--   * safe_bulk_insert_papers names the existing paper a duplicate collided
--     with ONLY when exactly one row owned by the caller matches the attempted
--     PMID or DOI under the same semantics idx_papers_user_pmid_unique and
--     idx_papers_user_doi_unique enforce. Zero candidates and two-or-more
--     candidates both return no id, and no other column — least of all the
--     title — ever participates;
--
--   * a returned duplicate id is always the CALLER'S row. Two users may hold
--     the same PMID because uniqueness is per-user, and neither may ever be
--     handed the other's id;
--
--   * bulk_add_paper_projects / bulk_add_paper_tags ADD and only add. Every
--     membership a paper already had survives, a requested membership it
--     already had is a no-op rather than an error, and a single foreign or
--     unknown reference rejects the whole call BEFORE anything is written.
--
-- The ambiguous case is the reason this suite exists. When an incoming record
-- carries a PMID belonging to paper A and a DOI belonging to paper B, both
-- unique indexes are violated by different rows and there is no fact in the
-- database that says which one the user meant. Every available tie-break —
-- constraint evaluation order, id order, creation order, title similarity — is
-- an accident rather than an answer, and acting on one would silently file the
-- user's Projects and Tags against a paper they did not choose. That case must
-- resolve to nothing, and section 1 pins it in both directions: the ids really
-- do differ, and the result really does carry no id.
--
-- What is deliberately NOT covered here: which callers opt into acting on a
-- resolved duplicate. That is an application decision (the
-- `applyAssignmentsToResolvedDuplicates` option) and is owned by the importer's
-- Vitest coverage and by e2e/extension-import.spec.ts. This suite asserts only
-- what the database will and will not tell a caller, and what it will and will
-- not let a caller write.
--
-- The exhaustive SECURITY DEFINER inventory, the full EXECUTE matrix and the
-- caller-scope matrix live in 003_rpc_caller_scope_and_grants.test.sql, which
-- this change extends with the two new RPCs. Section 4 below re-checks only the
-- posture properties this migration itself claims, at the point of change.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the transaction
-- and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Same shape as 003_rpc_caller_scope_and_grants.test.sql: run a statement as a
-- given role with a given JWT claim set, and report only the SQLSTATE.
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

/** The JWT claim set for one user id. */
CREATE FUNCTION pg_temp.claims(p_user uuid) RETURNS text LANGUAGE sql AS $hlp$
  SELECT json_build_object('sub', p_user::text, 'role', 'authenticated')::text;
$hlp$;

/** Run a statement as an authenticated user, expecting it to succeed. */
CREATE FUNCTION pg_temp.exec_as(p_user uuid, p_sql text)
RETURNS void LANGUAGE plpgsql AS $hlp$
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.claims(p_user), true);
  SET LOCAL ROLE authenticated;
  EXECUTE p_sql;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
END;
$hlp$;

/** Call safe_bulk_insert_papers as `p_user` and return its raw jsonb result. */
CREATE FUNCTION pg_temp.insert_as(p_user uuid, p_papers jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $hlp$
DECLARE v_result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.claims(p_user), true);
  SET LOCAL ROLE authenticated;
  v_result := public.safe_bulk_insert_papers(p_user, p_papers);
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_result;
END;
$hlp$;

/** The first (and, in this suite, only) result row of a bulk insert. */
CREATE FUNCTION pg_temp.row0(p_user uuid, p_papers jsonb)
RETURNS jsonb LANGUAGE sql AS $hlp$
  SELECT pg_temp.insert_as(p_user, p_papers) -> 0;
$hlp$;

/** How many Projects / Tags a paper is filed under right now. */
CREATE FUNCTION pg_temp.project_ids(p_paper uuid) RETURNS uuid[] LANGUAGE sql AS $hlp$
  SELECT COALESCE(array_agg(project_id ORDER BY project_id), ARRAY[]::uuid[])
  FROM public.paper_projects WHERE paper_id = p_paper;
$hlp$;

CREATE FUNCTION pg_temp.tag_ids(p_paper uuid) RETURNS uuid[] LANGUAGE sql AS $hlp$
  SELECT COALESCE(array_agg(tag_id ORDER BY tag_id), ARRAY[]::uuid[])
  FROM public.paper_tags WHERE paper_id = p_paper;
$hlp$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- Three users. A and B deliberately hold the SAME PMID and the SAME DOI (in
-- different letter case), which is legal because both unique indexes are
-- per-user. C holds neither, and exists to prove that another account's
-- identifier is not a collision at all.
INSERT INTO auth.users (id, email) VALUES
  ('aa000000-0000-0000-0000-0000000000a0','dup-A@paperlume.test'),
  ('bb000000-0000-0000-0000-0000000000b0','dup-B@paperlume.test'),
  ('cc000000-0000-0000-0000-0000000000c0','dup-C@paperlume.test');

-- A's four papers, each isolating one identity shape.
INSERT INTO public.papers (id, user_id, title, pmid, doi, keywords, insert_order) VALUES
  ('aa000000-0000-0000-0000-00000000a001','aa000000-0000-0000-0000-0000000000a0',
     'A PMID only',      'PM-001D-ONLY', NULL,                    '[]'::jsonb, 1),
  ('aa000000-0000-0000-0000-00000000a002','aa000000-0000-0000-0000-0000000000a0',
     'A DOI only',       NULL,           '10.5555/001D-MiXeD',    '[]'::jsonb, 2),
  ('aa000000-0000-0000-0000-00000000a003','aa000000-0000-0000-0000-0000000000a0',
     'A both',           'PM-001D-BOTH', '10.5555/001d-both',     '[]'::jsonb, 3),
  ('aa000000-0000-0000-0000-00000000a004','aa000000-0000-0000-0000-0000000000a0',
     'A shared title',   NULL,            NULL,                   '[]'::jsonb, 4),
  -- Assignment fixture: already filed under one Project and one Tag that the
  -- import below never selects. Everything section 2 and 3 claim about
  -- preservation is measured against these two rows.
  ('aa000000-0000-0000-0000-00000000a005','aa000000-0000-0000-0000-0000000000a0',
     'A assignment target', NULL,         NULL,                   '[]'::jsonb, 5),
  ('aa000000-0000-0000-0000-00000000a006','aa000000-0000-0000-0000-0000000000a0',
     'A second target',  NULL,            NULL,                   '[]'::jsonb, 6);

-- B independently owns the same two identifiers as A's a001 and a002.
INSERT INTO public.papers (id, user_id, title, pmid, doi, keywords, insert_order) VALUES
  ('bb000000-0000-0000-0000-00000000b001','bb000000-0000-0000-0000-0000000000b0',
     'B PMID only',      'PM-001D-ONLY', NULL,                    '[]'::jsonb, 7),
  ('bb000000-0000-0000-0000-00000000b002','bb000000-0000-0000-0000-0000000000b0',
     'B DOI only',       NULL,           '10.5555/001d-mixed',    '[]'::jsonb, 8);

INSERT INTO public.projects (id, user_id, name) VALUES
  ('aa000000-0000-0000-0000-00000000c001','aa000000-0000-0000-0000-0000000000a0','A existing project'),
  ('aa000000-0000-0000-0000-00000000c002','aa000000-0000-0000-0000-0000000000a0','A selected project'),
  ('aa000000-0000-0000-0000-00000000c003','aa000000-0000-0000-0000-0000000000a0','A second project'),
  ('bb000000-0000-0000-0000-00000000c009','bb000000-0000-0000-0000-0000000000b0','B project');

INSERT INTO public.tags (id, user_id, name) VALUES
  ('aa000000-0000-0000-0000-00000000d001','aa000000-0000-0000-0000-0000000000a0','A existing tag'),
  ('aa000000-0000-0000-0000-00000000d002','aa000000-0000-0000-0000-0000000000a0','A selected tag'),
  ('aa000000-0000-0000-0000-00000000d003','aa000000-0000-0000-0000-0000000000a0','A second tag'),
  ('bb000000-0000-0000-0000-00000000d009','bb000000-0000-0000-0000-0000000000b0','B tag');

-- The history that must survive every additive call.
INSERT INTO public.paper_projects (paper_id, project_id) VALUES
  ('aa000000-0000-0000-0000-00000000a005','aa000000-0000-0000-0000-00000000c001');
INSERT INTO public.paper_tags (paper_id, tag_id) VALUES
  ('aa000000-0000-0000-0000-00000000a005','aa000000-0000-0000-0000-00000000d001');

SELECT plan(77);

-- ══ 1. safe_bulk_insert_papers — the resolution matrix ══════════════════════

-- 1a. A genuinely new row is unaffected: still inserted, still with its own id.
SELECT is(
  pg_temp.row0('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"001D brand new","pmid":"PM-001D-NEW"}]'::jsonb) ->> 'status',
  'inserted', 'insert: a new row is still reported as inserted');
SELECT is(
  (SELECT count(*)::int FROM public.papers
    WHERE user_id = 'aa000000-0000-0000-0000-0000000000a0' AND pmid = 'PM-001D-NEW'),
  1, 'insert: the new row really exists and belongs to the caller');

-- 1b. PMID duplicate → the exact existing row.
SELECT is(
  pg_temp.row0('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"001D pmid dup","pmid":"PM-001D-ONLY"}]'::jsonb) ->> 'status',
  'duplicate', 'pmid: a colliding PMID is still reported as a duplicate');
SELECT is(
  pg_temp.row0('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"001D pmid dup","pmid":"PM-001D-ONLY"}]'::jsonb) ->> 'id',
  'aa000000-0000-0000-0000-00000000a001',
  'pmid: the duplicate names the exact existing owned row');
SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE title = '001D pmid dup'),
  0, 'pmid: the duplicate inserted nothing');

-- 1c. DOI duplicate, resolved case-insensitively exactly as the index folds it.
-- The stored value is '10.5555/001D-MiXeD'; the import supplies all-lowercase.
SELECT is(
  pg_temp.row0('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"001D doi dup","doi":"10.5555/001d-mixed"}]'::jsonb) ->> 'status',
  'duplicate', 'doi: a colliding DOI is still reported as a duplicate');
SELECT is(
  pg_temp.row0('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"001D doi dup","doi":"10.5555/001d-mixed"}]'::jsonb) ->> 'id',
  'aa000000-0000-0000-0000-00000000a002',
  'doi: resolution folds case exactly as idx_papers_user_doi_unique does');
SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE title = '001D doi dup'),
  0, 'doi: the duplicate inserted nothing');

-- 1d. Both identifiers, one row. DISTINCT collapses the two matches to one
-- candidate rather than reading them as an ambiguity.
SELECT is(
  pg_temp.row0('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"001D both dup","pmid":"PM-001D-BOTH","doi":"10.5555/001D-BOTH"}]'::jsonb) ->> 'id',
  'aa000000-0000-0000-0000-00000000a003',
  'both: a PMID and a DOI naming the SAME row resolve to that one row');

-- 1e. The ambiguity. First prove the premise — the two identifiers really do
-- belong to two different rows — then prove the refusal.
SELECT isnt(
  'aa000000-0000-0000-0000-00000000a001'::uuid,
  'aa000000-0000-0000-0000-00000000a002'::uuid,
  'ambiguity premise: the PMID row and the DOI row are genuinely different rows');
SELECT is(
  pg_temp.row0('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"001D ambiguous","pmid":"PM-001D-ONLY","doi":"10.5555/001d-mixed"}]'::jsonb) ->> 'status',
  'duplicate', 'ambiguity: still reported as a duplicate — it genuinely is one');
SELECT ok(
  NOT (pg_temp.row0('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"001D ambiguous","pmid":"PM-001D-ONLY","doi":"10.5555/001d-mixed"}]'::jsonb) ? 'id'),
  'ambiguity: NO id is returned when two distinct owned rows match');
SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE title = '001D ambiguous'),
  0, 'ambiguity: nothing was inserted either');

-- 1f. Title is never identity. A record whose title exactly equals an existing
-- paper's, with no shared identifier, is not a duplicate at all.
SELECT is(
  pg_temp.row0('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"A shared title"}]'::jsonb) ->> 'status',
  'inserted', 'title: an identical title is not a duplicate');
SELECT is(
  (SELECT count(*)::int FROM public.papers
    WHERE user_id = 'aa000000-0000-0000-0000-0000000000a0' AND title = 'A shared title'),
  2, 'title: both rows exist — title equality resolved nothing and merged nothing');

-- A title match cannot smuggle itself in through the duplicate path either: a
-- PMID collision whose title equals a DIFFERENT paper's still resolves to the
-- PMID row, not the title-matching one.
SELECT is(
  pg_temp.row0('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"A shared title","pmid":"PM-001D-ONLY"}]'::jsonb) ->> 'id',
  'aa000000-0000-0000-0000-00000000a001',
  'title: resolution follows the identifier, never the matching title');

-- 1g. No cross-user leakage. B holds the same PMID; B's import must resolve to
-- B's own row and can never be handed A's.
SELECT is(
  pg_temp.row0('bb000000-0000-0000-0000-0000000000b0'::uuid,
    '[{"title":"001D B pmid dup","pmid":"PM-001D-ONLY"}]'::jsonb) ->> 'id',
  'bb000000-0000-0000-0000-00000000b001',
  'isolation: B resolves the shared PMID to B''s own row');
SELECT isnt(
  pg_temp.row0('bb000000-0000-0000-0000-0000000000b0'::uuid,
    '[{"title":"001D B pmid dup","pmid":"PM-001D-ONLY"}]'::jsonb) ->> 'id',
  'aa000000-0000-0000-0000-00000000a001',
  'isolation: B is never handed A''s paper id');
SELECT is(
  pg_temp.row0('bb000000-0000-0000-0000-0000000000b0'::uuid,
    '[{"title":"001D B doi dup","doi":"10.5555/001D-MIXED"}]'::jsonb) ->> 'id',
  'bb000000-0000-0000-0000-00000000b002',
  'isolation: the same holds for the case-folded DOI');

-- C owns neither identifier, so another account holding them is not a collision
-- at all — the row inserts, and no foreign id is consulted or returned.
SELECT is(
  pg_temp.row0('cc000000-0000-0000-0000-0000000000c0'::uuid,
    '[{"title":"001D C copy","pmid":"PM-001D-ONLY","doi":"10.5555/001d-mixed"}]'::jsonb) ->> 'status',
  'inserted', 'isolation: a third user importing both identifiers simply inserts');
SELECT is(
  (SELECT user_id::text FROM public.papers WHERE title = '001D C copy'),
  'cc000000-0000-0000-0000-0000000000c0',
  'isolation: and the row it created belongs to that third user');

-- 1h. The caller guard is untouched.
SELECT is(
  pg_temp.errcode_as('authenticated', '',
    $q$SELECT public.safe_bulk_insert_papers('aa000000-0000-0000-0000-0000000000a0'::uuid, '[]'::jsonb)$q$),
  'P0001', 'guard: a null-auth caller is still rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('bb000000-0000-0000-0000-0000000000b0'::uuid),
    $q$SELECT public.safe_bulk_insert_papers('aa000000-0000-0000-0000-0000000000a0'::uuid, '[]'::jsonb)$q$),
  'P0001', 'guard: a p_user_id that is not auth.uid() is still rejected');
SELECT is(
  pg_temp.errcode_as('anon', '',
    $q$SELECT public.safe_bulk_insert_papers('aa000000-0000-0000-0000-0000000000a0'::uuid, '[]'::jsonb)$q$),
  '42501', 'guard: anon is still denied at the ACL, before any data path');

-- 1i. Everything the insert path already did, it still does. A resolution
-- change that quietly dropped provenance or canonicalization would be a far
-- worse regression than the feature is worth.
SELECT is(
  pg_temp.row0('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"001D provenance","pmid":"PM-001D-PROV","authors":["Solo, S"],
        "statistical_methods":["ANOVA","t-test"],
        "raw_publication_types":["  Journal Article  ",""],
        "author_provenance":[{"source":"pubmed_api","source_name":"PubMed","kind":"personal",
                              "family_name":"Solo","given_name":"S","affiliations":[],"identifiers":[]}]}]'::jsonb) ->> 'status',
  'inserted', 'preserved: a fully-specified provenance row still inserts');
SELECT is(
  (SELECT statistical_methods #>> '{}' FROM public.papers WHERE title = '001D provenance'),
  'ANOVA, t-test', 'preserved: statistical_methods array is still canonicalized to one string');
SELECT is(
  (SELECT raw_publication_types FROM public.papers WHERE title = '001D provenance'),
  '["Journal Article"]'::jsonb,
  'preserved: raw_publication_types is still trimmed and blank-filtered');
SELECT is(
  (SELECT jsonb_array_length(author_provenance) FROM public.papers WHERE title = '001D provenance'),
  1, 'preserved: author_provenance is still stored as stated');

-- A malformed row still fails as an error rather than being coerced, and still
-- fails ONLY itself — the surrounding rows in the same batch are unaffected.
SELECT is(
  (pg_temp.insert_as('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"001D batch ok","pmid":"PM-001D-BATCH1"},
      {"title":"001D batch bad","statistical_methods":42},
      {"title":"001D batch dup","pmid":"PM-001D-ONLY"}]'::jsonb)
   -> 1 ->> 'status'),
  'error', 'preserved: a malformed row is still an error, not a duplicate');
SELECT is(
  (pg_temp.insert_as('aa000000-0000-0000-0000-0000000000a0'::uuid,
    '[{"title":"001D batch2 ok","pmid":"PM-001D-BATCH2"},
      {"title":"001D batch2 bad","statistical_methods":42},
      {"title":"001D batch2 dup","pmid":"PM-001D-ONLY"}]'::jsonb)
   -> 2 ->> 'id'),
  'aa000000-0000-0000-0000-00000000a001',
  'preserved: per-row isolation and index alignment survive resolution');

-- ══ 2. bulk_add_paper_projects — additive, idempotent, fail-closed ══════════

-- 2a. The requested Project is added and the pre-existing one is kept. This is
-- the single property the replace-all setter could not provide.
SELECT lives_ok(
  $q$SELECT pg_temp.exec_as('aa000000-0000-0000-0000-0000000000a0'::uuid,
       $s$SELECT public.bulk_add_paper_projects(
            ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
            ARRAY['aa000000-0000-0000-0000-00000000c002']::uuid[])$s$)$q$,
  'add project: an owned paper and an owned Project are accepted');
SELECT is(
  pg_temp.project_ids('aa000000-0000-0000-0000-00000000a005'::uuid),
  ARRAY['aa000000-0000-0000-0000-00000000c001',
        'aa000000-0000-0000-0000-00000000c002']::uuid[],
  'add project: the selection was added AND the pre-existing Project survived');

-- 2b. Idempotent. The same call again, and a call naming a membership the paper
-- already has, both succeed and change nothing.
SELECT lives_ok(
  $q$SELECT pg_temp.exec_as('aa000000-0000-0000-0000-0000000000a0'::uuid,
       $s$SELECT public.bulk_add_paper_projects(
            ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
            ARRAY['aa000000-0000-0000-0000-00000000c002',
                  'aa000000-0000-0000-0000-00000000c001',
                  'aa000000-0000-0000-0000-00000000c002']::uuid[])$s$)$q$,
  'add project: repeating a membership that exists is a no-op, not an error');
SELECT is(
  pg_temp.project_ids('aa000000-0000-0000-0000-00000000a005'::uuid),
  ARRAY['aa000000-0000-0000-0000-00000000c001',
        'aa000000-0000-0000-0000-00000000c002']::uuid[],
  'add project: a repeated id produced no duplicate junction row');

-- 2c. Several papers and several Projects in one call.
SELECT lives_ok(
  $q$SELECT pg_temp.exec_as('aa000000-0000-0000-0000-0000000000a0'::uuid,
       $s$SELECT public.bulk_add_paper_projects(
            ARRAY['aa000000-0000-0000-0000-00000000a005',
                  'aa000000-0000-0000-0000-00000000a006']::uuid[],
            ARRAY['aa000000-0000-0000-0000-00000000c003']::uuid[])$s$)$q$,
  'add project: multiple owned papers are accepted');
SELECT is(
  pg_temp.project_ids('aa000000-0000-0000-0000-00000000a006'::uuid),
  ARRAY['aa000000-0000-0000-0000-00000000c003']::uuid[],
  'add project: the second paper gained exactly the requested Project');
SELECT is(
  pg_temp.project_ids('aa000000-0000-0000-0000-00000000a005'::uuid),
  ARRAY['aa000000-0000-0000-0000-00000000c001',
        'aa000000-0000-0000-0000-00000000c002',
        'aa000000-0000-0000-0000-00000000c003']::uuid[],
  'add project: the first paper kept everything and gained the new one');

-- 2d. Fail-closed references. Each rejects the WHOLE call, which the state
-- assertion after them proves rather than assumes.
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_projects(
         ARRAY['aa000000-0000-0000-0000-00000000a005','bb000000-0000-0000-0000-00000000b001']::uuid[],
         ARRAY['aa000000-0000-0000-0000-00000000c002']::uuid[])$q$),
  'P0001', 'add project: a foreign paper rejects the call');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_projects(
         ARRAY['aa000000-0000-0000-0000-00000000a005','00000000-0000-0000-0000-0000deadbeef']::uuid[],
         ARRAY['aa000000-0000-0000-0000-00000000c002']::uuid[])$q$),
  'P0001', 'add project: an unknown paper rejects the call');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_projects(
         ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
         ARRAY['bb000000-0000-0000-0000-00000000c009']::uuid[])$q$),
  'P0001', 'add project: a foreign Project rejects the call');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_projects(
         ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
         ARRAY['00000000-0000-0000-0000-0000deadbeef']::uuid[])$q$),
  'P0001', 'add project: an unknown Project rejects the call');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_projects(
         ARRAY[NULL]::uuid[], ARRAY['aa000000-0000-0000-0000-00000000c002']::uuid[])$q$),
  'P0001', 'add project: a NULL paper id is malformed input and is rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_projects(
         ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[], ARRAY[NULL]::uuid[])$q$),
  'P0001', 'add project: a NULL Project id is malformed input and is rejected');

-- Validation really did happen BEFORE the write: neither the owned paper in the
-- rejected batch nor the foreign paper changed.
SELECT is(
  pg_temp.project_ids('aa000000-0000-0000-0000-00000000a005'::uuid),
  ARRAY['aa000000-0000-0000-0000-00000000c001',
        'aa000000-0000-0000-0000-00000000c002',
        'aa000000-0000-0000-0000-00000000c003']::uuid[],
  'add project: no rejected call partially mutated the owned paper');
SELECT is(
  pg_temp.project_ids('bb000000-0000-0000-0000-00000000b001'::uuid),
  ARRAY[]::uuid[],
  'add project: no rejected call touched the foreign paper');

-- 2e. Authorization.
SELECT is(
  pg_temp.errcode_as('authenticated', '',
    $q$SELECT public.bulk_add_paper_projects(
         ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
         ARRAY['aa000000-0000-0000-0000-00000000c002']::uuid[])$q$),
  'P0001', 'add project: a null-auth caller is rejected');
SELECT is(
  pg_temp.errcode_as('anon', '',
    $q$SELECT public.bulk_add_paper_projects(
         ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
         ARRAY['aa000000-0000-0000-0000-00000000c002']::uuid[])$q$),
  '42501', 'add project: anon is denied at the ACL');

-- 2f. Empty and absent selections are a no-op, never an error and never a wipe.
SELECT lives_ok(
  $q$SELECT pg_temp.exec_as('aa000000-0000-0000-0000-0000000000a0'::uuid,
       $s$SELECT public.bulk_add_paper_projects(
            ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[], ARRAY[]::uuid[])$s$)$q$,
  'add project: an empty Project selection is accepted');
SELECT is(
  pg_temp.project_ids('aa000000-0000-0000-0000-00000000a005'::uuid),
  ARRAY['aa000000-0000-0000-0000-00000000c001',
        'aa000000-0000-0000-0000-00000000c002',
        'aa000000-0000-0000-0000-00000000c003']::uuid[],
  'add project: an empty selection removed nothing — there is no DELETE here');

-- ══ 3. bulk_add_paper_tags — the same contract over the Tag taxonomy ════════

SELECT lives_ok(
  $q$SELECT pg_temp.exec_as('aa000000-0000-0000-0000-0000000000a0'::uuid,
       $s$SELECT public.bulk_add_paper_tags(
            ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
            ARRAY['aa000000-0000-0000-0000-00000000d002']::uuid[])$s$)$q$,
  'add tag: an owned paper and an owned Tag are accepted');
SELECT is(
  pg_temp.tag_ids('aa000000-0000-0000-0000-00000000a005'::uuid),
  ARRAY['aa000000-0000-0000-0000-00000000d001',
        'aa000000-0000-0000-0000-00000000d002']::uuid[],
  'add tag: the selection was added AND the pre-existing Tag survived');

SELECT lives_ok(
  $q$SELECT pg_temp.exec_as('aa000000-0000-0000-0000-0000000000a0'::uuid,
       $s$SELECT public.bulk_add_paper_tags(
            ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
            ARRAY['aa000000-0000-0000-0000-00000000d002',
                  'aa000000-0000-0000-0000-00000000d001']::uuid[])$s$)$q$,
  'add tag: repeating memberships that exist is a no-op, not an error');
SELECT is(
  pg_temp.tag_ids('aa000000-0000-0000-0000-00000000a005'::uuid),
  ARRAY['aa000000-0000-0000-0000-00000000d001',
        'aa000000-0000-0000-0000-00000000d002']::uuid[],
  'add tag: no duplicate junction row was created');

SELECT lives_ok(
  $q$SELECT pg_temp.exec_as('aa000000-0000-0000-0000-0000000000a0'::uuid,
       $s$SELECT public.bulk_add_paper_tags(
            ARRAY['aa000000-0000-0000-0000-00000000a005',
                  'aa000000-0000-0000-0000-00000000a006']::uuid[],
            ARRAY['aa000000-0000-0000-0000-00000000d003']::uuid[])$s$)$q$,
  'add tag: multiple owned papers are accepted');
SELECT is(
  pg_temp.tag_ids('aa000000-0000-0000-0000-00000000a006'::uuid),
  ARRAY['aa000000-0000-0000-0000-00000000d003']::uuid[],
  'add tag: the second paper gained exactly the requested Tag');

SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_tags(
         ARRAY['aa000000-0000-0000-0000-00000000a005','bb000000-0000-0000-0000-00000000b001']::uuid[],
         ARRAY['aa000000-0000-0000-0000-00000000d002']::uuid[])$q$),
  'P0001', 'add tag: a foreign paper rejects the call');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_tags(
         ARRAY['00000000-0000-0000-0000-0000deadbeef']::uuid[],
         ARRAY['aa000000-0000-0000-0000-00000000d002']::uuid[])$q$),
  'P0001', 'add tag: an unknown paper rejects the call');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_tags(
         ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
         ARRAY['bb000000-0000-0000-0000-00000000d009']::uuid[])$q$),
  'P0001', 'add tag: a foreign Tag rejects the call');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_tags(
         ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
         ARRAY['00000000-0000-0000-0000-0000deadbeef']::uuid[])$q$),
  'P0001', 'add tag: an unknown Tag rejects the call');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_tags(
         ARRAY[NULL]::uuid[], ARRAY['aa000000-0000-0000-0000-00000000d002']::uuid[])$q$),
  'P0001', 'add tag: a NULL paper id is malformed input and is rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('aa000000-0000-0000-0000-0000000000a0'::uuid),
    $q$SELECT public.bulk_add_paper_tags(
         ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[], ARRAY[NULL]::uuid[])$q$),
  'P0001', 'add tag: a NULL Tag id is malformed input and is rejected');
SELECT is(
  pg_temp.errcode_as('authenticated', '',
    $q$SELECT public.bulk_add_paper_tags(
         ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
         ARRAY['aa000000-0000-0000-0000-00000000d002']::uuid[])$q$),
  'P0001', 'add tag: a null-auth caller is rejected');
SELECT is(
  pg_temp.errcode_as('anon', '',
    $q$SELECT public.bulk_add_paper_tags(
         ARRAY['aa000000-0000-0000-0000-00000000a005']::uuid[],
         ARRAY['aa000000-0000-0000-0000-00000000d002']::uuid[])$q$),
  '42501', 'add tag: anon is denied at the ACL');

SELECT is(
  pg_temp.tag_ids('aa000000-0000-0000-0000-00000000a005'::uuid),
  ARRAY['aa000000-0000-0000-0000-00000000d001',
        'aa000000-0000-0000-0000-00000000d002',
        'aa000000-0000-0000-0000-00000000d003']::uuid[],
  'add tag: no rejected call partially mutated the owned paper');
SELECT is(
  pg_temp.tag_ids('bb000000-0000-0000-0000-00000000b001'::uuid),
  ARRAY[]::uuid[],
  'add tag: no rejected call touched the foreign paper');

-- ══ 4. Posture at the point of change ═══════════════════════════════════════
-- The exhaustive definer inventory and EXECUTE matrix are suite 003's remit;
-- these pin the specific properties migration 20260903180000 claims.

SELECT ok(
  (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = sig::regprocedure),
  'posture: ' || sig || ' is SECURITY DEFINER'
) FROM unnest(ARRAY[
  'public.bulk_add_paper_projects(uuid[],uuid[])',
  'public.bulk_add_paper_tags(uuid[],uuid[])'
]) sig;

SELECT ok(
  (SELECT p.proconfig FROM pg_proc p WHERE p.oid = sig::regprocedure)
    @> ARRAY['search_path=public'],
  'posture: ' || sig || ' pins search_path=public'
) FROM unnest(ARRAY[
  'public.bulk_add_paper_projects(uuid[],uuid[])',
  'public.bulk_add_paper_tags(uuid[],uuid[])'
]) sig;

-- The additive functions must contain no DELETE. This is the mechanical form of
-- the guarantee every "existing Projects and Tags are preserved" claim rests on,
-- and it survives a later edit that a state assertion above might not reach.
SELECT ok(
  (SELECT p.prosrc !~* '\mdelete\M' AND p.prosrc !~* '\mtruncate\M'
     FROM pg_proc p WHERE p.oid = sig::regprocedure),
  'additive: ' || sig || ' contains no delete or truncate'
) FROM unnest(ARRAY[
  'public.bulk_add_paper_projects(uuid[],uuid[])',
  'public.bulk_add_paper_tags(uuid[],uuid[])'
]) sig;

-- …and the replace-all setters still do, because their semantics are the right
-- ones for a newly inserted row and this change must not have altered them.
SELECT ok(
  (SELECT p.prosrc ~* '\mdelete\M' FROM pg_proc p WHERE p.oid = sig::regprocedure),
  'unchanged: ' || sig || ' still replaces rather than adds'
) FROM unnest(ARRAY[
  'public.bulk_set_paper_projects(uuid[],uuid[])',
  'public.bulk_set_paper_tags(uuid[],uuid[])'
]) sig;

-- The identity contract the resolver mirrors, asserted as the exact index
-- definitions rather than merely by name — a redefinition that dropped the
-- lower() or widened the scope past user_id would silently change what a
-- duplicate id means.
SELECT is(
  (SELECT indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='papers' AND indexname='idx_papers_user_pmid_unique'),
  'CREATE UNIQUE INDEX idx_papers_user_pmid_unique ON public.papers USING btree (user_id, pmid) WHERE (pmid IS NOT NULL)',
  'identity: the per-user PMID unique index is exactly what the resolver mirrors');
SELECT is(
  (SELECT indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='papers' AND indexname='idx_papers_user_doi_unique'),
  'CREATE UNIQUE INDEX idx_papers_user_doi_unique ON public.papers USING btree (user_id, lower(doi)) WHERE (doi IS NOT NULL)',
  'identity: the per-user DOI unique index is exactly what the resolver mirrors');

-- Exactly one overload of each new RPC — a second signature would be an
-- unreviewed bypass of the ownership validation above.
SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = nm),
  1, 'overloads: exactly one ' || nm
) FROM unnest(ARRAY['bulk_add_paper_projects','bulk_add_paper_tags']) nm;

SELECT * FROM finish();
ROLLBACK;
