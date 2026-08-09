-- PUBMED-API-PUBLICATION-TYPE-STRUCTURE-001 suite 006: structured
-- publication-type provenance.
--
-- This suite owns the database contract for papers.raw_publication_types — the
-- column, its fail-closed CHECK, the safe_bulk_insert_papers input handling that
-- writes it, and the merge_exact_duplicates rule that keeps it coherent with
-- raw_study_type. Suite 003 keeps ownership of the least-privilege EXECUTE
-- surface across the whole SECURITY DEFINER inventory and suite 005 owns the
-- general successful-merge contract; only the invariants a careless change to
-- THESE two functions could break are re-asserted here, so a replacement that
-- widened either could not pass this suite either.
--
-- Why the column exists:
--   PubMed states publication types discretely, and an official one may contain
--   a comma of its own ("Clinical Trial, Phase II", "Research Support, N.I.H.,
--   Extramural"). raw_study_type stores the comma-joined flattening of those
--   values, which cannot be split back apart — "Clinical Trial, Phase II"
--   re-reads as the two false values "Clinical Trial" and "Phase II".
--
-- Proves:
--   * the column's shape: jsonb, nullable, no default, and a validated CHECK
--     that admits only NULL or a non-empty JSON array of strings;
--   * fail-closed direct writes: object, bare scalar, non-string element and
--     empty array all rejected at the column;
--   * safe_bulk_insert_papers canonicalization: a valid array is stored with
--     its boundaries, order and trimming; a missing key, JSON null and empty
--     array all become SQL NULL; every malformed shape yields a per-row 'error'
--     result while the rest of the batch still inserts;
--   * provenance is never manufactured: a payload carrying only the joined
--     raw_study_type stores NULL, never a split of it;
--   * both functions' unchanged security contract — one overload, signature,
--     SECURITY DEFINER, bounded search_path, owner, least-privilege EXECUTE,
--     null-auth and cross-user rejection;
--   * forward-compatible version skew: the PRE-migration function body ignores
--     an unrecognized raw_publication_types key rather than failing, so a merged
--     frontend deployed before the migration causes no import outage;
--   * merge_exact_duplicates provenance-pair coherence: raw_study_type and
--     raw_publication_types are always taken from ONE source row, never unioned
--     across duplicates, and a legacy keep row never borrows a foreign array;
--   * the merge's existing attachment / identifier-transfer / JSONB-list
--     behaviors still hold with the new column in the update list.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the transaction
-- and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Execute p_sql as p_role with p_claims; return the resulting SQLSTATE
-- ('00000' when the statement succeeded).
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

-- Call safe_bulk_insert_papers as U1 and return its jsonb result.
CREATE FUNCTION pg_temp.bulk_insert_u1(p_papers jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $hlp$
DECLARE v_out jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.claims_u1(), true);
  SET LOCAL ROLE authenticated;
  SELECT public.safe_bulk_insert_papers(
    '06000000-0000-0000-0000-000000000001'::uuid, p_papers) INTO v_out;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_out;
END;
$hlp$;

-- The per-row status the RPC reported for one payload index.
CREATE FUNCTION pg_temp.row_status(p_results jsonb, p_index int)
RETURNS text LANGUAGE sql AS
$hlp$ SELECT r->>'status' FROM jsonb_array_elements(p_results) r
      WHERE (r->>'index')::int = p_index $hlp$;

-- The stored provenance of a paper inserted under a known title.
CREATE FUNCTION pg_temp.stored_types(p_title text)
RETURNS jsonb LANGUAGE sql AS
$hlp$ SELECT raw_publication_types FROM public.papers WHERE title = p_title $hlp$;

CREATE FUNCTION pg_temp.claims_u1() RETURNS text LANGUAGE sql AS
$hlp$ SELECT '{"sub":"06000000-0000-0000-0000-000000000001","role":"authenticated"}'::text $hlp$;
CREATE FUNCTION pg_temp.claims_u2() RETURNS text LANGUAGE sql AS
$hlp$ SELECT '{"sub":"06000000-0000-0000-0000-000000000002","role":"authenticated"}'::text $hlp$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('06000000-0000-0000-0000-000000000001','pubtype-U1@paperlume.test'),
  ('06000000-0000-0000-0000-000000000002','pubtype-U2@paperlume.test');

-- A row written the way every pre-migration row was: raw_study_type only, the
-- new column never mentioned. It must read as NULL and stay re-evaluable.
INSERT INTO public.papers (id, user_id, title, raw_study_type, insert_order, created_at)
VALUES ('06000000-0000-0000-0000-0000000000a0','06000000-0000-0000-0000-000000000001',
        'Legacy row', 'Randomized Controlled Trial, Journal Article', 201, '2026-01-01T00:00:00Z');

SELECT plan(69);

-- ══ 1. Column shape ═════════════════════════════════════════════════════════

SELECT has_column('public', 'papers', 'raw_publication_types',
  'column: papers.raw_publication_types exists');
SELECT col_type_is('public', 'papers', 'raw_publication_types', 'jsonb',
  'column: stored as jsonb, matching the table''s list-metadata convention');
SELECT col_is_null('public', 'papers', 'raw_publication_types',
  'column: nullable — NULL is the representation of "no structured provenance"');
SELECT col_hasnt_default('public', 'papers', 'raw_publication_types',
  'column: no default, so an unmentioned column is SQL NULL');

SELECT ok(
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.papers'::regclass
            AND conname = 'papers_raw_publication_types_string_array_check'
            AND contype = 'c' AND convalidated),
  'column: the fail-closed CHECK exists and is validated');

-- ══ 2. Existing rows are untouched ══════════════════════════════════════════

SELECT is(
  (SELECT raw_publication_types FROM public.papers WHERE title = 'Legacy row'),
  NULL::jsonb,
  'legacy: a row written without the column reads NULL, not an empty array');

SELECT is(
  (SELECT raw_study_type FROM public.papers WHERE title = 'Legacy row'),
  'Randomized Controlled Trial, Journal Article',
  'legacy: raw_study_type is preserved and remains the fallback representation');

SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE raw_publication_types IS NOT NULL),
  0,
  'legacy: the migration backfilled no historical row');

-- ══ 3. Fail-closed direct writes ════════════════════════════════════════════
-- The column is the last line of defence: even a writer that bypasses the RPC
-- cannot store provenance that is not a non-empty array of strings.

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET raw_publication_types = '{}'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a JSON object is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET raw_publication_types = '"Clinical Trial"'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a bare JSON string is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET raw_publication_types = '[123]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an array holding a non-string is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET raw_publication_types = '["Clinical Trial", 7]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a mixed array is rejected wholesale');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET raw_publication_types = '[]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an empty array is rejected — NULL is the single "none" form');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET raw_publication_types = '["Clinical Trial, Phase II"]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '00000', 'check: a non-empty array of strings is accepted');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET raw_publication_types = NULL
     WHERE title = 'Legacy row'$q$),
  '00000', 'check: NULL is always accepted');

-- The rejected UPDATEs above left the row exactly as it was.
SELECT is(
  (SELECT raw_publication_types FROM public.papers WHERE title = 'Legacy row'),
  NULL::jsonb,
  'check: rejected writes stored nothing');

-- ══ 4. safe_bulk_insert_papers input handling ═══════════════════════════════

CREATE TEMP TABLE bulk_results AS
SELECT pg_temp.bulk_insert_u1($json$[
  {"title":"PT structured",
   "raw_study_type":"Clinical Trial, Phase II, Multicenter Study",
   "raw_publication_types":["Clinical Trial, Phase II","  Multicenter Study  ",""]},
  {"title":"PT key absent",
   "raw_study_type":"Randomized Controlled Trial, Journal Article"},
  {"title":"PT json null","raw_publication_types":null},
  {"title":"PT empty array","raw_publication_types":[]},
  {"title":"PT object","raw_publication_types":{}},
  {"title":"PT scalar","raw_publication_types":"Clinical Trial"},
  {"title":"PT non-string element","raw_publication_types":[123]},
  {"title":"PT after malformed",
   "raw_publication_types":["Research Support, N.I.H., Extramural"]}
]$json$::jsonb) AS results;

SELECT is(pg_temp.row_status((SELECT results FROM bulk_results), 0), 'inserted',
  'rpc: a valid structured payload inserts');

SELECT is(pg_temp.stored_types('PT structured'),
  '["Clinical Trial, Phase II", "Multicenter Study"]'::jsonb,
  'rpc: boundaries, order and trimming preserved; blanks dropped');

SELECT is(
  (SELECT jsonb_array_length(pg_temp.stored_types('PT structured'))), 2,
  'rpc: two source values stored, not the three a comma split would produce');

SELECT is(
  (SELECT raw_study_type FROM public.papers WHERE title = 'PT structured'),
  'Clinical Trial, Phase II, Multicenter Study',
  'rpc: the legacy joined column is written unchanged alongside it');

SELECT is(pg_temp.stored_types('PT key absent'), NULL::jsonb,
  'rpc: a missing key stores NULL');

SELECT is(
  (SELECT raw_study_type FROM public.papers WHERE title = 'PT key absent'),
  'Randomized Controlled Trial, Journal Article',
  'rpc: provenance is never manufactured by splitting raw_study_type');

SELECT is(pg_temp.stored_types('PT json null'), NULL::jsonb,
  'rpc: JSON null stores NULL');

SELECT is(pg_temp.row_status((SELECT results FROM bulk_results), 3), 'inserted',
  'rpc: an empty array inserts rather than failing the row');
SELECT is(pg_temp.stored_types('PT empty array'), NULL::jsonb,
  'rpc: an empty array normalizes to NULL, carrying no provenance');

SELECT is(pg_temp.row_status((SELECT results FROM bulk_results), 4), 'error',
  'rpc: a JSON object yields a per-row error');
SELECT is(pg_temp.row_status((SELECT results FROM bulk_results), 5), 'error',
  'rpc: a bare scalar yields a per-row error');
SELECT is(pg_temp.row_status((SELECT results FROM bulk_results), 6), 'error',
  'rpc: an array holding a non-string yields a per-row error');

SELECT is(
  (SELECT count(*)::int FROM public.papers
   WHERE title IN ('PT object','PT scalar','PT non-string element')),
  0,
  'rpc: no malformed row was stored with corrupted provenance');

SELECT is(pg_temp.row_status((SELECT results FROM bulk_results), 7), 'inserted',
  'rpc: the batch continues past a malformed row');
SELECT is(pg_temp.stored_types('PT after malformed'),
  '["Research Support, N.I.H., Extramural"]'::jsonb,
  'rpc: a multi-comma official type survives the batch whole');

-- ══ 5. safe_bulk_insert_papers security contract unchanged ══════════════════

SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers'),
  1, 'security: exactly one safe_bulk_insert_papers overload — no bypass variant');

SELECT is(
  (SELECT pg_get_function_identity_arguments(p.oid)
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers'),
  'p_user_id uuid, p_papers jsonb', 'security: signature unchanged');

SELECT is(
  (SELECT pg_get_function_result(p.oid)
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers'),
  'jsonb', 'security: return type unchanged');

SELECT ok(
  (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers'),
  'security: SECURITY DEFINER retained');

SELECT is(
  (SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers'),
  ARRAY['search_path=public'], 'security: bounded search_path retained');

SELECT is(
  (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers'),
  'postgres', 'security: owner retained');

SELECT ok(
  has_function_privilege('authenticated','public.safe_bulk_insert_papers(uuid,jsonb)','EXECUTE')
  AND NOT has_function_privilege('anon','public.safe_bulk_insert_papers(uuid,jsonb)','EXECUTE')
  AND NOT has_function_privilege('service_role','public.safe_bulk_insert_papers(uuid,jsonb)','EXECUTE'),
  'security: EXECUTE remains {authenticated} only');

SELECT is(pg_temp.errcode_as('anon', NULL,
  $q$SELECT public.safe_bulk_insert_papers('06000000-0000-0000-0000-000000000001'::uuid,
       '[{"title":"unauth","raw_publication_types":["Clinical Trial"]}]'::jsonb)$q$),
  '42501', 'security: an unauthenticated caller cannot reach the function');

SELECT is(pg_temp.errcode_as('authenticated', NULL,
  $q$SELECT public.safe_bulk_insert_papers('06000000-0000-0000-0000-000000000001'::uuid,
       '[{"title":"null auth","raw_publication_types":["Clinical Trial"]}]'::jsonb)$q$),
  'P0001', 'security: a null-auth caller is rejected by the ownership guard');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u2(),
  $q$SELECT public.safe_bulk_insert_papers('06000000-0000-0000-0000-000000000001'::uuid,
       '[{"title":"cross user","raw_publication_types":["Clinical Trial"]}]'::jsonb)$q$),
  'P0001', 'security: a caller writing for another user is rejected');

SELECT is(
  (SELECT count(*)::int FROM public.papers
   WHERE title IN ('unauth','null auth','cross user')),
  0, 'security: no rejected call created a row');

-- ══ 6. Forward-compatible version skew ══════════════════════════════════════
-- Merging the frontend auto-deploys it while Production may still hold the
-- pre-migration function. The claim that the extra JSON key is simply ignored
-- is proven, not assumed: this is the body installed by
-- 20260802025704_harden_rpc_and_relational_ownership.sql, copied verbatim apart
-- from its name and security context (neither of which affects how it reads
-- keys), fed the new payload shape.
CREATE FUNCTION pg_temp.pre_migration_bulk_insert(p_user_id uuid, p_papers jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $legacy$
DECLARE
  v_paper jsonb;
  v_index int := 0;
  v_results jsonb := '[]'::jsonb;
  v_inserted_id uuid;
  v_statistical_methods jsonb;
BEGIN
  IF p_user_id IS NULL
     OR auth.uid() IS NULL
     OR p_user_id <> auth.uid()
  THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  FOR v_paper IN SELECT jsonb_array_elements(p_papers)
  LOOP
    BEGIN
      v_statistical_methods := v_paper->'statistical_methods';
      IF v_statistical_methods IS NULL
         OR jsonb_typeof(v_statistical_methods) = 'null' THEN
        v_statistical_methods := NULL;
      ELSIF jsonb_typeof(v_statistical_methods) = 'string' THEN
        NULL;
      ELSIF jsonb_typeof(v_statistical_methods) = 'array' THEN
        SELECT to_jsonb(COALESCE(string_agg(e.elem #>> '{}', ', ' ORDER BY e.ord), ''))
        INTO v_statistical_methods
        FROM jsonb_array_elements(v_statistical_methods) WITH ORDINALITY AS e(elem, ord);
      ELSE
        RAISE EXCEPTION 'statistical_methods must be null, a JSON string, or a JSON array; got %',
          jsonb_typeof(v_statistical_methods);
      END IF;

      INSERT INTO public.papers (
        user_id, title, authors, year, journal, pmid, doi,
        abstract, study_type, raw_study_type, statistical_methods,
        keywords, raw_keywords, mesh_terms, substances,
        pubmed_url, journal_url, drive_url
      ) VALUES (
        p_user_id,
        v_paper->>'title',
        COALESCE(v_paper->'authors', '[]'::jsonb),
        (v_paper->>'year')::int,
        v_paper->>'journal',
        v_paper->>'pmid',
        v_paper->>'doi',
        v_paper->>'abstract',
        v_paper->>'study_type',
        v_paper->>'raw_study_type',
        v_statistical_methods,
        COALESCE(v_paper->'keywords', '[]'::jsonb),
        COALESCE(v_paper->'raw_keywords', '[]'::jsonb),
        COALESCE(v_paper->'mesh_terms', '[]'::jsonb),
        COALESCE(v_paper->'substances', '[]'::jsonb),
        v_paper->>'pubmed_url',
        v_paper->>'journal_url',
        v_paper->>'drive_url'
      )
      RETURNING id INTO v_inserted_id;

      v_results := v_results || jsonb_build_object(
        'index', v_index, 'id', v_inserted_id, 'status', 'inserted');
    EXCEPTION
      WHEN unique_violation THEN
        v_results := v_results || jsonb_build_object(
          'index', v_index, 'status', 'duplicate', 'error_message', SQLERRM);
      WHEN OTHERS THEN
        v_results := v_results || jsonb_build_object(
          'index', v_index, 'status', 'error', 'error_message', SQLERRM);
    END;
    v_index := v_index + 1;
  END LOOP;

  RETURN v_results;
END;
$legacy$;

SELECT set_config('request.jwt.claims', pg_temp.claims_u1(), true);
CREATE TEMP TABLE skew_results AS
SELECT pg_temp.pre_migration_bulk_insert(
  '06000000-0000-0000-0000-000000000001'::uuid,
  $json$[{"title":"Skew payload",
          "raw_study_type":"Clinical Trial, Phase II",
          "raw_publication_types":["Clinical Trial, Phase II"]}]$json$::jsonb) AS results;
SELECT set_config('request.jwt.claims', '', true);

SELECT is(pg_temp.row_status((SELECT results FROM skew_results), 0), 'inserted',
  'skew: the pre-migration body ignores the unrecognized key — no import outage');

SELECT is(pg_temp.stored_types('Skew payload'), NULL::jsonb,
  'skew: the old body simply stores no structured provenance');

SELECT is(
  (SELECT raw_study_type FROM public.papers WHERE title = 'Skew payload'),
  'Clinical Trial, Phase II',
  'skew: the legacy representation is written exactly as before');

-- ══ 7. merge_exact_duplicates provenance-pair coherence ═════════════════════
-- Three scenarios, each a keep paper plus its discards. raw_study_type and
-- raw_publication_types describe the same source statement, so they must always
-- be adopted together from one row.
INSERT INTO public.papers
  (id, user_id, title, pmid, doi, raw_study_type, raw_publication_types,
   keywords, mesh_terms, insert_order, created_at)
VALUES
  -- Scenario A: the keep paper has its own (legacy) raw_study_type.
  ('06000000-0000-0000-0000-0000000000a1','06000000-0000-0000-0000-000000000001',
   'Merge keep A', NULL, NULL, 'Legacy joined, string', NULL,
   '["alpha"]'::jsonb, '["MeshA"]'::jsonb, 211, '2026-02-01T00:00:00Z'),
  ('06000000-0000-0000-0000-0000000000a2','06000000-0000-0000-0000-000000000001',
   'Merge discard A', 'PM_06_A', '10.6666/a', 'Clinical Trial, Phase II',
   '["Clinical Trial, Phase II"]'::jsonb,
   '["beta"]'::jsonb, '["MeshB"]'::jsonb, 212, '2026-02-02T00:00:00Z'),
  -- Scenario B: the keep paper has none; two discards do, earliest must win.
  ('06000000-0000-0000-0000-0000000000b1','06000000-0000-0000-0000-000000000001',
   'Merge keep B', NULL, NULL, NULL, NULL,
   '[]'::jsonb, '[]'::jsonb, 213, '2026-02-01T00:00:00Z'),
  ('06000000-0000-0000-0000-0000000000b2','06000000-0000-0000-0000-000000000001',
   'Merge discard B early', NULL, NULL, 'Clinical Trial, Phase II, Multicenter Study',
   '["Clinical Trial, Phase II", "Multicenter Study"]'::jsonb,
   '[]'::jsonb, '[]'::jsonb, 214, '2026-02-02T00:00:00Z'),
  ('06000000-0000-0000-0000-0000000000b3','06000000-0000-0000-0000-000000000001',
   'Merge discard B late', NULL, NULL, 'Case Report', '["Case Report"]'::jsonb,
   '[]'::jsonb, '[]'::jsonb, 215, '2026-02-03T00:00:00Z'),
  -- Scenario C: no row anywhere carries raw study-type provenance.
  ('06000000-0000-0000-0000-0000000000c1','06000000-0000-0000-0000-000000000001',
   'Merge keep C', NULL, NULL, NULL, NULL, '[]'::jsonb, '[]'::jsonb, 216, '2026-02-01T00:00:00Z'),
  ('06000000-0000-0000-0000-0000000000c2','06000000-0000-0000-0000-000000000001',
   'Merge discard C', NULL, NULL, NULL, NULL, '[]'::jsonb, '[]'::jsonb, 217, '2026-02-02T00:00:00Z');

-- One attachment on a discard: the merge must re-parent it rather than let the
-- cascade destroy it, exactly as suite 005 requires, with the new column in the
-- update list.
SELECT set_config('request.jwt.claims', pg_temp.claims_u1(), true);
INSERT INTO public.paper_attachments (id, paper_id, user_id, file_path, file_name, file_type, size_bytes)
VALUES ('06000000-0000-0000-0000-0000000000d1','06000000-0000-0000-0000-0000000000a2',
        '06000000-0000-0000-0000-000000000001','u1/a2.pdf','a2.pdf','application/pdf',4000);
SELECT set_config('request.jwt.claims', '', true);

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('06000000-0000-0000-0000-0000000000a1'::uuid,
       ARRAY['06000000-0000-0000-0000-0000000000a2']::uuid[])$q$),
  '00000', 'merge A: the merge succeeds');

SELECT is(
  (SELECT raw_study_type FROM public.papers WHERE id = '06000000-0000-0000-0000-0000000000a1'),
  'Legacy joined, string',
  'merge A: the keep paper''s own raw_study_type wins, as before');

SELECT is(
  (SELECT raw_publication_types FROM public.papers WHERE id = '06000000-0000-0000-0000-0000000000a1'),
  NULL::jsonb,
  'merge A: a legacy keep row does NOT borrow the discard''s array — the pair stays coherent');

SELECT is(
  (SELECT pmid FROM public.papers WHERE id = '06000000-0000-0000-0000-0000000000a1'),
  'PM_06_A',
  'merge A: identifier transfer across the unique index still works');

SELECT is(
  (SELECT keywords FROM public.papers WHERE id = '06000000-0000-0000-0000-0000000000a1'),
  '["alpha", "beta"]'::jsonb,
  'merge A: JSONB list union is unaffected by the new column');

SELECT is(
  (SELECT paper_id FROM public.paper_attachments WHERE id = '06000000-0000-0000-0000-0000000000d1'),
  '06000000-0000-0000-0000-0000000000a1'::uuid,
  'merge A: the discard''s attachment was re-parented, not cascaded away');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('06000000-0000-0000-0000-0000000000b1'::uuid,
       ARRAY['06000000-0000-0000-0000-0000000000b2',
             '06000000-0000-0000-0000-0000000000b3']::uuid[])$q$),
  '00000', 'merge B: the merge succeeds');

SELECT is(
  (SELECT raw_study_type FROM public.papers WHERE id = '06000000-0000-0000-0000-0000000000b1'),
  'Clinical Trial, Phase II, Multicenter Study',
  'merge B: the earliest discard by (created_at, id) supplies raw_study_type');

SELECT is(
  (SELECT raw_publication_types FROM public.papers WHERE id = '06000000-0000-0000-0000-0000000000b1'),
  '["Clinical Trial, Phase II", "Multicenter Study"]'::jsonb,
  'merge B: its OWN array comes with it — never the later discard''s');

SELECT is(
  (SELECT jsonb_array_length(raw_publication_types) FROM public.papers
   WHERE id = '06000000-0000-0000-0000-0000000000b1'),
  2,
  'merge B: publication types are not unioned across duplicates');

SELECT ok(
  NOT (SELECT raw_publication_types @> '["Case Report"]'::jsonb FROM public.papers
       WHERE id = '06000000-0000-0000-0000-0000000000b1'),
  'merge B: the losing discard contributes nothing to the array');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('06000000-0000-0000-0000-0000000000c1'::uuid,
       ARRAY['06000000-0000-0000-0000-0000000000c2']::uuid[])$q$),
  '00000', 'merge C: the merge succeeds');

SELECT is(
  (SELECT raw_study_type FROM public.papers WHERE id = '06000000-0000-0000-0000-0000000000c1'),
  NULL::text,
  'merge C: no source had provenance, so raw_study_type stays NULL');

SELECT is(
  (SELECT raw_publication_types FROM public.papers WHERE id = '06000000-0000-0000-0000-0000000000c1'),
  NULL::jsonb,
  'merge C: and nothing is invented for the structured column either');

SELECT is(
  (SELECT count(*)::int FROM public.papers
   WHERE id IN ('06000000-0000-0000-0000-0000000000a2',
                '06000000-0000-0000-0000-0000000000b2',
                '06000000-0000-0000-0000-0000000000b3',
                '06000000-0000-0000-0000-0000000000c2')),
  0, 'merge: every discard row was deleted');

-- ══ 8. merge_exact_duplicates security contract unchanged ═══════════════════

SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates'),
  1, 'security: exactly one merge_exact_duplicates overload');

SELECT is(
  (SELECT pg_get_function_identity_arguments(p.oid)
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates'),
  'p_keep_id uuid, p_discard_ids uuid[]', 'security: merge signature unchanged');

SELECT ok(
  (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates'),
  'security: merge SECURITY DEFINER retained');

SELECT is(
  (SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates'),
  ARRAY['search_path=public'], 'security: merge bounded search_path retained');

SELECT is(
  (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates'),
  'postgres', 'security: merge owner retained');

SELECT ok(
  has_function_privilege('authenticated','public.merge_exact_duplicates(uuid,uuid[])','EXECUTE')
  AND NOT has_function_privilege('anon','public.merge_exact_duplicates(uuid,uuid[])','EXECUTE')
  AND NOT has_function_privilege('service_role','public.merge_exact_duplicates(uuid,uuid[])','EXECUTE'),
  'security: merge EXECUTE remains {authenticated} only');

SELECT is(pg_temp.errcode_as('authenticated', NULL,
  $q$SELECT public.merge_exact_duplicates('06000000-0000-0000-0000-0000000000a1'::uuid,
       ARRAY['06000000-0000-0000-0000-0000000000a0']::uuid[])$q$),
  'P0001', 'security: merge rejects a null-auth caller');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u2(),
  $q$SELECT public.merge_exact_duplicates('06000000-0000-0000-0000-0000000000a1'::uuid,
       ARRAY['06000000-0000-0000-0000-0000000000a0']::uuid[])$q$),
  'P0001', 'security: merge rejects a caller who owns neither paper');

SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE id = '06000000-0000-0000-0000-0000000000a0'),
  1, 'security: no rejected merge deleted the legacy row');

SELECT * FROM finish();
ROLLBACK;
