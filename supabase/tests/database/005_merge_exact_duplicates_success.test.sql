-- MERGE-EXACT-DUPLICATES-JSONB-REPAIR-001 suite 005: merge_exact_duplicates
-- successful path + data preservation.
--
-- This suite owns the *successful* duplicate-merge contract. Suite 003 keeps
-- ownership of the RPC's least-privilege EXECUTE surface and caller-scope
-- rejection posture across the whole SECURITY DEFINER inventory; only the
-- function-specific security invariants are re-asserted here, so that a repair
-- that silently broadened the RPC could not pass this suite either.
--
-- Proves:
--   * the complete input-validation contract, every case rejected before the
--     first persistent mutation (null auth, null/absent keep, null/empty/NULL-
--     bearing/duplicate discard arrays, keep listed as its own discard, unknown
--     discard, foreign keep, foreign discard);
--   * atomicity: after a full round of rejected calls every affected table is
--     row- and value-equivalent to its pre-call state;
--   * keep-paper identity invariants (id, user_id, title, created_at,
--     insert_order) survive a merge untouched;
--   * scalar coalescing — keep value wins, a NULL keep value is filled from the
--     earliest eligible discard by (created_at, id) — including tldr and notes,
--     which postdate the original RPC and were never merged before;
--   * authors as a whole-value choice: an empty keep list adopts the earliest
--     non-empty discard list, a non-empty keep list is preserved exactly;
--   * JSONB list union over keywords / raw_keywords / mesh_terms / substances
--     with exact deduplication and deterministic keep-first ordering (the defect
--     under repair: unnest(jsonb) does not exist);
--   * project/tag union: keep assignments preserved, discard-only assignments
--     transferred, overlapping assignments collapsed to one row;
--   * attachment preservation: every paper_attachments row survives the cascade
--     by being re-parented onto the keep paper, with id, user_id, file_path,
--     file_name, file_type, size_bytes and created_at untouched, and storage
--     usage accounting unchanged;
--   * discard deletion leaves no dangling junction or attachment reference;
--   * identifier transfer across the per-user partial unique indexes succeeds
--     with no transient collision (the old update-before-delete order).
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

-- Claims for the two synthetic callers.
CREATE FUNCTION pg_temp.claims_u1() RETURNS text LANGUAGE sql AS
$hlp$ SELECT '{"sub":"05000000-0000-0000-0000-000000000001","role":"authenticated"}'::text $hlp$;
CREATE FUNCTION pg_temp.claims_u2() RETURNS text LANGUAGE sql AS
$hlp$ SELECT '{"sub":"05000000-0000-0000-0000-000000000002","role":"authenticated"}'::text $hlp$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- U1 owns the merge scenario; U2 exists only to prove cross-owner rejection.
INSERT INTO auth.users (id, email) VALUES
  ('05000000-0000-0000-0000-000000000001','dedup-U1@paperlume.test'),
  ('05000000-0000-0000-0000-000000000002','dedup-U2@paperlume.test');

-- Scenario A — keep A0 with three-way complementary metadata.
--   A0 keeps: title, created_at, insert_order, notes; every other scalar NULL so
--     the coalescing rules are observable. authors '[]' so the fallback fires.
--     Its identifiers are NULL, so D1's pmid/doi must transfer — which under the
--     old update-before-delete order would have collided transiently against the
--     still-present D1 row on idx_papers_user_pmid_unique / _doi_unique.
--   A1 (earlier discard) supplies most scalars; A2 (later discard) supplies
--     values that must LOSE to A1 wherever both have one.
-- Scenario B — keep B0 already has authors, so B1's must not overwrite them.
INSERT INTO public.papers
  (id, user_id, title, pmid, doi, abstract, journal, year, study_type,
   statistical_methods, pubmed_url, journal_url, drive_url, raw_study_type,
   tldr, notes, authors, keywords, raw_keywords, mesh_terms, substances,
   insert_order, created_at)
VALUES
  ('05000000-0000-0000-0000-0000000000a0','05000000-0000-0000-0000-000000000001',
   'Keep A', NULL, NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   NULL, 'keep-notes', '[]'::jsonb, '["alpha","beta"]'::jsonb, '["rk-keep"]'::jsonb,
   '["MeshA"]'::jsonb, '["SubA"]'::jsonb, 101, '2026-01-01T00:00:00Z'),
  ('05000000-0000-0000-0000-0000000000a1','05000000-0000-0000-0000-000000000001',
   'Discard A1', 'PM_05_X', '10.5555/x', 'abs-d1', 'Journal One', 2020, 'st-d1',
   '"chi-square"'::jsonb, 'https://pubmed.test/d1', 'https://journal.test/d1',
   'https://drive.test/d1', 'raw-st-d1',
   'tldr-d1', 'notes-d1', '["Ann Author"]'::jsonb, '["beta","gamma"]'::jsonb,
   '["rk-d1"]'::jsonb, '["MeshB"]'::jsonb, '["SubA","SubB"]'::jsonb,
   102, '2026-01-02T00:00:00Z'),
  ('05000000-0000-0000-0000-0000000000a2','05000000-0000-0000-0000-000000000001',
   'Discard A2', NULL, NULL, 'abs-d2', 'Journal Two', 2021, 'st-d2',
   '"t-test"'::jsonb, 'https://pubmed.test/d2', 'https://journal.test/d2',
   'https://drive.test/d2', 'raw-st-d2',
   'tldr-d2', 'notes-d2', '["Bob Later"]'::jsonb, '["delta","alpha"]'::jsonb,
   '["rk-d2"]'::jsonb, '["MeshA","MeshC"]'::jsonb, '["SubC"]'::jsonb,
   103, '2026-01-03T00:00:00Z'),
  ('05000000-0000-0000-0000-0000000000b0','05000000-0000-0000-0000-000000000001',
   'Keep B', NULL, NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, '["Keep Author"]'::jsonb, '[]'::jsonb, '[]'::jsonb,
   '[]'::jsonb, '[]'::jsonb, 104, '2026-01-04T00:00:00Z'),
  ('05000000-0000-0000-0000-0000000000b1','05000000-0000-0000-0000-000000000001',
   'Discard B1', NULL, NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, '["Other Author"]'::jsonb, '[]'::jsonb, '[]'::jsonb,
   '[]'::jsonb, '[]'::jsonb, 105, '2026-01-05T00:00:00Z'),
  ('05000000-0000-0000-0000-0000000000f9','05000000-0000-0000-0000-000000000002',
   'Foreign paper', NULL, NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
   '[]'::jsonb, '[]'::jsonb, 106, '2026-01-06T00:00:00Z');

INSERT INTO public.projects (id, user_id, name) VALUES
  ('05000000-0000-0000-0000-0000000000c1','05000000-0000-0000-0000-000000000001','Project One'),
  ('05000000-0000-0000-0000-0000000000c2','05000000-0000-0000-0000-000000000001','Project Two');
INSERT INTO public.tags (id, user_id, name) VALUES
  ('05000000-0000-0000-0000-0000000000e1','05000000-0000-0000-0000-000000000001','Tag One'),
  ('05000000-0000-0000-0000-0000000000e2','05000000-0000-0000-0000-000000000001','Tag Two');

-- Project One is held by both the keep paper and a discard (must collapse to one
-- row); Project Two only by a discard (must transfer).
INSERT INTO public.paper_projects (paper_id, project_id) VALUES
  ('05000000-0000-0000-0000-0000000000a0','05000000-0000-0000-0000-0000000000c1'),
  ('05000000-0000-0000-0000-0000000000a1','05000000-0000-0000-0000-0000000000c1'),
  ('05000000-0000-0000-0000-0000000000a2','05000000-0000-0000-0000-0000000000c2');
-- Tag Two is held by BOTH discards, so the transfer must also collapse duplicates
-- arising within a single INSERT ... SELECT.
INSERT INTO public.paper_tags (paper_id, tag_id) VALUES
  ('05000000-0000-0000-0000-0000000000a0','05000000-0000-0000-0000-0000000000e1'),
  ('05000000-0000-0000-0000-0000000000a1','05000000-0000-0000-0000-0000000000e2'),
  ('05000000-0000-0000-0000-0000000000a2','05000000-0000-0000-0000-0000000000e2');

-- Attachments: one on the keep paper, one on each discard. The BEFORE INSERT
-- storage-quota trigger requires a matching auth.uid(), so claims are set for
-- the fixture inserts and cleared immediately afterwards.
SELECT set_config('request.jwt.claims', pg_temp.claims_u1(), true);
INSERT INTO public.paper_attachments (id, paper_id, user_id, file_path, file_name, file_type, size_bytes) VALUES
  ('05000000-0000-0000-0000-0000000000d1','05000000-0000-0000-0000-0000000000a0',
   '05000000-0000-0000-0000-000000000001','u1/keep.pdf','keep.pdf','application/pdf',1000),
  ('05000000-0000-0000-0000-0000000000d2','05000000-0000-0000-0000-0000000000a1',
   '05000000-0000-0000-0000-000000000001','u1/d1.pdf','d1.pdf','application/pdf',2000),
  ('05000000-0000-0000-0000-0000000000d3','05000000-0000-0000-0000-0000000000a2',
   '05000000-0000-0000-0000-000000000001','u1/d2.pdf','d2.pdf','application/pdf',3000);
SELECT set_config('request.jwt.claims', '', true);

-- Pre-call baselines used by the atomicity proof and the storage-accounting proof.
CREATE TEMP TABLE dedup_baseline_attachments AS
  SELECT id, paper_id, user_id, file_path, file_name, file_type, size_bytes, created_at
  FROM public.paper_attachments;
CREATE TEMP TABLE dedup_baseline_papers AS
  SELECT * FROM public.papers;
CREATE TEMP TABLE dedup_baseline_usage AS
  SELECT user_id, used_bytes FROM public.user_storage_usage;

SELECT plan(77);

-- ══ 1. Input-validation contract: every case rejected ════════════════════════
-- All ten reject before the first persistent mutation; section 2 proves that.
SELECT is(pg_temp.errcode_as('authenticated', NULL,
  $q$SELECT public.merge_exact_duplicates('05000000-0000-0000-0000-0000000000a0'::uuid,
       ARRAY['05000000-0000-0000-0000-0000000000a1']::uuid[])$q$),
  'P0001', 'validation: null auth rejected');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates(NULL::uuid,
       ARRAY['05000000-0000-0000-0000-0000000000a1']::uuid[])$q$),
  'P0001', 'validation: NULL keep id rejected');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('05000000-0000-0000-0000-0000000000a0'::uuid,
       NULL::uuid[])$q$),
  'P0001', 'validation: NULL discard array rejected');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('05000000-0000-0000-0000-0000000000a0'::uuid,
       ARRAY[]::uuid[])$q$),
  'P0001', 'validation: empty discard array rejected');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('05000000-0000-0000-0000-0000000000a0'::uuid,
       ARRAY['05000000-0000-0000-0000-0000000000a1', NULL]::uuid[])$q$),
  'P0001', 'validation: NULL element in discard array rejected');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('05000000-0000-0000-0000-0000000000a0'::uuid,
       ARRAY['05000000-0000-0000-0000-0000000000a1','05000000-0000-0000-0000-0000000000a1']::uuid[])$q$),
  'P0001', 'validation: repeated discard ids rejected');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('05000000-0000-0000-0000-0000000000a0'::uuid,
       ARRAY['05000000-0000-0000-0000-0000000000a1','05000000-0000-0000-0000-0000000000a0']::uuid[])$q$),
  'P0001', 'validation: keep paper listed as its own discard rejected');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('05000000-0000-0000-0000-0000000000a0'::uuid,
       ARRAY['05000000-0000-0000-0000-0000000000de']::uuid[])$q$),
  'P0001', 'validation: unknown discard id rejected');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('05000000-0000-0000-0000-0000000000f9'::uuid,
       ARRAY['05000000-0000-0000-0000-0000000000a1']::uuid[])$q$),
  'P0001', 'validation: keep paper owned by another user rejected');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('05000000-0000-0000-0000-0000000000a0'::uuid,
       ARRAY['05000000-0000-0000-0000-0000000000f9']::uuid[])$q$),
  'P0001', 'validation: discard paper owned by another user rejected');

-- ══ 2. Atomicity: the rejected round mutated nothing ═════════════════════════
SELECT is((SELECT count(*)::int FROM public.papers p
           JOIN dedup_baseline_papers b USING (id)
           WHERE p.* IS DISTINCT FROM b.*),
  0, 'atomicity: no papers row changed during the rejected calls');
SELECT is((SELECT count(*)::int FROM public.papers), 6,
  'atomicity: no paper was deleted or created by the rejected calls');
SELECT is((SELECT count(*)::int FROM public.paper_projects), 3,
  'atomicity: paper_projects unchanged by the rejected calls');
SELECT is((SELECT count(*)::int FROM public.paper_tags), 3,
  'atomicity: paper_tags unchanged by the rejected calls');
SELECT is((SELECT count(*)::int FROM public.paper_attachments a
           JOIN dedup_baseline_attachments b USING (id)
           WHERE a.* IS DISTINCT FROM b.*),
  0, 'atomicity: no paper_attachments row changed during the rejected calls');
SELECT is((SELECT count(*)::int FROM public.paper_attachments), 3,
  'atomicity: no attachment was deleted or created by the rejected calls');
SELECT is((SELECT used_bytes::text FROM public.user_storage_usage
           WHERE user_id='05000000-0000-0000-0000-000000000001'),
  '6000', 'atomicity: storage usage unchanged by the rejected calls');

-- ══ 3. The successful multi-discard merge ════════════════════════════════════
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('05000000-0000-0000-0000-0000000000a0'::uuid,
       ARRAY['05000000-0000-0000-0000-0000000000a1',
             '05000000-0000-0000-0000-0000000000a2']::uuid[])$q$),
  '00000', 'merge: authenticated owner merges two discards successfully');

-- ══ 4. Keep-paper identity invariants ════════════════════════════════════════
SELECT is((SELECT count(*)::int FROM public.papers
           WHERE id='05000000-0000-0000-0000-0000000000a0'),
  1, 'identity: keep paper still exists under its original id');
SELECT is((SELECT user_id::text FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  '05000000-0000-0000-0000-000000000001', 'identity: keep user_id unchanged');
SELECT is((SELECT title FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  'Keep A', 'identity: keep title unchanged');
SELECT is((SELECT created_at FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  '2026-01-01T00:00:00Z'::timestamptz, 'identity: keep created_at unchanged');
SELECT is((SELECT insert_order FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  101::bigint, 'identity: keep insert_order unchanged');

-- ══ 5. Scalar coalescing ═════════════════════════════════════════════════════
-- Keep value wins.
SELECT is((SELECT notes FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  'keep-notes', 'scalar: existing keep notes preserved, not overwritten by a discard');
-- NULL keep value filled from the EARLIEST eligible discard by (created_at, id):
-- A1 (2026-01-02) must win over A2 (2026-01-03) for every field both supply.
SELECT is((SELECT abstract FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  'abs-d1', 'scalar: NULL keep abstract filled from the earliest discard');
SELECT is((SELECT journal FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  'Journal One', 'scalar: NULL keep journal filled from the earliest discard');
SELECT is((SELECT year FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  2020, 'scalar: NULL keep year filled from the earliest discard');
SELECT is((SELECT study_type FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  'st-d1', 'scalar: NULL keep study_type filled from the earliest discard');
SELECT is((SELECT raw_study_type FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  'raw-st-d1', 'scalar: NULL keep raw_study_type filled from the earliest discard');
SELECT is((SELECT statistical_methods::text FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  '"chi-square"', 'scalar: NULL keep statistical_methods filled from the earliest discard');
SELECT is((SELECT pubmed_url || '|' || journal_url || '|' || drive_url
           FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  'https://pubmed.test/d1|https://journal.test/d1|https://drive.test/d1',
  'scalar: NULL keep pubmed_url / journal_url / drive_url filled from the earliest discard');
-- tldr and notes postdate the original RPC and were never merged before.
SELECT is((SELECT tldr FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  'tldr-d1', 'scalar: NULL keep tldr filled from the earliest discard (never merged before)');
SELECT is((SELECT count(*)::int FROM public.papers
           WHERE id='05000000-0000-0000-0000-0000000000a0'
             AND notes NOT LIKE '%notes-d1%' AND notes NOT LIKE '%notes-d2%'),
  1, 'scalar: notes are chosen, never concatenated');

-- ══ 6. Authors: a whole-value choice, never a union ══════════════════════════
SELECT is((SELECT authors::text FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  '["Ann Author"]',
  'authors: empty keep list adopts the earliest non-empty discard list');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates('05000000-0000-0000-0000-0000000000b0'::uuid,
       ARRAY['05000000-0000-0000-0000-0000000000b1']::uuid[])$q$),
  '00000', 'authors: scenario-B merge succeeds');
SELECT is((SELECT authors::text FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000b0'),
  '["Keep Author"]',
  'authors: non-empty keep list preserved exactly, not replaced or unioned');

-- ══ 7. JSONB list union — the defect under repair ════════════════════════════
-- Order is first-occurrence in (keep, then discards by created_at/id, then JSON
-- ordinality); duplicates keep only their first occurrence.
SELECT is((SELECT keywords::text FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  '["alpha", "beta", "gamma", "delta"]',
  'lists: keywords unioned, exactly deduplicated, keep-first deterministic order');
SELECT is((SELECT raw_keywords::text FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  '["rk-keep", "rk-d1", "rk-d2"]',
  'lists: raw_keywords unioned in deterministic order (never merged before)');
SELECT is((SELECT mesh_terms::text FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  '["MeshA", "MeshB", "MeshC"]',
  'lists: mesh_terms unioned and exactly deduplicated');
SELECT is((SELECT substances::text FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  '["SubA", "SubB", "SubC"]',
  'lists: substances unioned and exactly deduplicated');
SELECT is((SELECT jsonb_typeof(keywords) || '/' || jsonb_typeof(raw_keywords) || '/' ||
                  jsonb_typeof(mesh_terms) || '/' || jsonb_typeof(substances)
           FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  'array/array/array/array', 'lists: every merged list is a JSON array');
SELECT is((SELECT keywords::text FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000b0'),
  '[]', 'lists: merging two empty lists yields an empty JSON array, never NULL');

-- ══ 8. Project / tag union ═══════════════════════════════════════════════════
SELECT is((SELECT string_agg(pr.name, ',' ORDER BY pr.name)
           FROM public.paper_projects pp JOIN public.projects pr ON pr.id = pp.project_id
           WHERE pp.paper_id='05000000-0000-0000-0000-0000000000a0'),
  'Project One,Project Two',
  'junctions: keep project preserved and discard-only project transferred');
SELECT is((SELECT count(*)::int FROM public.paper_projects
           WHERE paper_id='05000000-0000-0000-0000-0000000000a0'
             AND project_id='05000000-0000-0000-0000-0000000000c1'),
  1, 'junctions: an assignment held by both keep and discard collapses to one row');
SELECT is((SELECT string_agg(t.name, ',' ORDER BY t.name)
           FROM public.paper_tags pt JOIN public.tags t ON t.id = pt.tag_id
           WHERE pt.paper_id='05000000-0000-0000-0000-0000000000a0'),
  'Tag One,Tag Two',
  'junctions: keep tag preserved and discard-only tag transferred');
SELECT is((SELECT count(*)::int FROM public.paper_tags
           WHERE paper_id='05000000-0000-0000-0000-0000000000a0'
             AND tag_id='05000000-0000-0000-0000-0000000000e2'),
  1, 'junctions: a tag held by BOTH discards collapses to one row');
SELECT is((SELECT count(*)::int FROM public.paper_projects
           WHERE paper_id IN ('05000000-0000-0000-0000-0000000000a1',
                              '05000000-0000-0000-0000-0000000000a2')),
  0, 'junctions: no paper_projects row still references a deleted discard');
SELECT is((SELECT count(*)::int FROM public.paper_tags
           WHERE paper_id IN ('05000000-0000-0000-0000-0000000000a1',
                              '05000000-0000-0000-0000-0000000000a2')),
  0, 'junctions: no paper_tags row still references a deleted discard');
SELECT is((SELECT count(*)::int FROM public.paper_projects pp
           JOIN public.papers p ON p.id = pp.paper_id
           JOIN public.projects pr ON pr.id = pp.project_id
           WHERE p.user_id <> pr.user_id),
  0, 'junctions: the merge created no cross-owner project assignment');
SELECT is((SELECT count(*)::int FROM public.paper_tags pt
           JOIN public.papers p ON p.id = pt.paper_id
           JOIN public.tags t ON t.id = pt.tag_id
           WHERE p.user_id <> t.user_id),
  0, 'junctions: the merge created no cross-owner tag assignment');

-- ══ 9. Attachment preservation ═══════════════════════════════════════════════
SELECT is((SELECT count(*)::int FROM public.paper_attachments), 3,
  'attachments: every attachment row survived the merge');
SELECT is((SELECT string_agg(id::text, ',' ORDER BY id::text) FROM public.paper_attachments),
  '05000000-0000-0000-0000-0000000000d1,'
  '05000000-0000-0000-0000-0000000000d2,'
  '05000000-0000-0000-0000-0000000000d3',
  'attachments: the exact original attachment ids survived');
SELECT is((SELECT count(*)::int FROM public.paper_attachments
           WHERE paper_id='05000000-0000-0000-0000-0000000000a0'),
  3, 'attachments: all three are now parented to the keep paper');
SELECT is((SELECT count(*)::int FROM public.paper_attachments
           WHERE paper_id IN ('05000000-0000-0000-0000-0000000000a1',
                              '05000000-0000-0000-0000-0000000000a2')),
  0, 'attachments: none still references a deleted discard');
-- Only paper_id may differ from the pre-merge baseline.
SELECT is((SELECT count(*)::int FROM public.paper_attachments a
           JOIN dedup_baseline_attachments b USING (id)
           WHERE (a.user_id, a.file_path, a.file_name, a.file_type, a.size_bytes, a.created_at)
              IS DISTINCT FROM
                 (b.user_id, b.file_path, b.file_name, b.file_type, b.size_bytes, b.created_at)),
  0, 'attachments: user_id, file_path, file_name, file_type, size_bytes and created_at all unchanged');
SELECT is((SELECT string_agg(file_path, ',' ORDER BY file_path) FROM public.paper_attachments),
  'u1/d1.pdf,u1/d2.pdf,u1/keep.pdf',
  'attachments: Storage object paths are untouched by re-parenting');
-- Re-parenting is an UPDATE, so neither quota trigger fires.
SELECT is((SELECT used_bytes::text FROM public.user_storage_usage
           WHERE user_id='05000000-0000-0000-0000-000000000001'),
  '6000', 'attachments: storage usage accounting is unchanged by the merge');
SELECT is((SELECT count(*)::int FROM public.user_storage_usage u
           JOIN dedup_baseline_usage b USING (user_id)
           WHERE u.used_bytes IS DISTINCT FROM b.used_bytes),
  0, 'attachments: no user''s storage usage moved as a result of the merge');

-- ══ 10. Discard deletion ═════════════════════════════════════════════════════
SELECT is((SELECT count(*)::int FROM public.papers
           WHERE id IN ('05000000-0000-0000-0000-0000000000a1',
                        '05000000-0000-0000-0000-0000000000a2',
                        '05000000-0000-0000-0000-0000000000b1')),
  0, 'deletion: every validated discard paper is gone');
SELECT is((SELECT count(*)::int FROM public.papers
           WHERE user_id='05000000-0000-0000-0000-000000000001'),
  2, 'deletion: exactly the two keep papers remain for the caller');
SELECT is((SELECT count(*)::int FROM public.papers
           WHERE user_id='05000000-0000-0000-0000-000000000002'),
  1, 'deletion: the other user''s paper is untouched');

-- ══ 11. Identifier transfer across the per-user partial unique indexes ═══════
-- Under the old update-before-delete order this pair would have collided
-- transiently with the still-present discard row.
SELECT is((SELECT pmid FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  'PM_05_X', 'identifiers: pmid transferred from the discard with no unique violation');
SELECT is((SELECT doi FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  '10.5555/x', 'identifiers: doi transferred from the discard with no unique violation');
SELECT is((SELECT count(*)::int FROM public.papers
           WHERE user_id='05000000-0000-0000-0000-000000000001' AND pmid='PM_05_X'),
  1, 'identifiers: exactly one paper holds the transferred pmid');
-- The unique indexes are still enforcing after the transfer.
SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$INSERT INTO public.papers (id,user_id,title,pmid,insert_order)
     VALUES ('05000000-0000-0000-0000-0000000000cc','05000000-0000-0000-0000-000000000001',
             'Collide','PM_05_X',107)$q$),
  '23505', 'identifiers: the per-user unique pmid index still rejects a genuine duplicate');

-- ══ 12. Derived columns update themselves ════════════════════════════════════
SELECT is((SELECT has_abstract FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  true, 'generated: has_abstract recomputed from the merged abstract');
SELECT isnt((SELECT search_vector::text FROM public.papers WHERE id='05000000-0000-0000-0000-0000000000a0'),
  '', 'generated: search_vector recomputed from the merged sources');

-- ══ 13. The repair preserved the RPC security contract ═══════════════════════
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='merge_exact_duplicates'),
  1, 'security: exactly one merge_exact_duplicates overload (no bypass overload)');
SELECT is((SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p
           JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='merge_exact_duplicates'),
  'p_keep_id uuid, p_discard_ids uuid[]', 'security: signature unchanged');
SELECT is((SELECT pg_get_function_result(p.oid) FROM pg_proc p
           JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='merge_exact_duplicates'),
  'void', 'security: return type still void');
SELECT is((SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='merge_exact_duplicates'),
  true, 'security: still SECURITY DEFINER');
SELECT is((SELECT array_to_string(p.proconfig, ',') FROM pg_proc p
           JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='merge_exact_duplicates'),
  'search_path=public', 'security: bounded search_path retained');
SELECT is((SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
           JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='merge_exact_duplicates'),
  'postgres', 'security: defining owner retained');
SELECT ok(has_function_privilege('authenticated','public.merge_exact_duplicates(uuid,uuid[])','EXECUTE'),
  'security: authenticated retains EXECUTE');
SELECT ok(NOT has_function_privilege('anon','public.merge_exact_duplicates(uuid,uuid[])','EXECUTE'),
  'security: anon has no EXECUTE');
SELECT ok(NOT has_function_privilege('service_role','public.merge_exact_duplicates(uuid,uuid[])','EXECUTE'),
  'security: service_role has no EXECUTE');
SELECT is((SELECT p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='merge_exact_duplicates'),
  '{postgres=X/postgres,authenticated=X/postgres}',
  'security: EXECUTE surface is exactly {owner, authenticated} — no PUBLIC grant');

SELECT finish();
ROLLBACK;
