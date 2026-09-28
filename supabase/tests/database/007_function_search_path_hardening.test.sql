-- Suite 007: bounded search_path on the non-RPC helper functions (PFA-C08, C51,
-- C55).
--
-- Migration 20260810152125_harden_remaining_function_search_paths (PFA-C08)
-- pinned `search_path = pg_catalog` on the four functions that remained on the
-- Supabase Security Advisor's `function_search_path_mutable` list after the
-- C03B1 RPC hardening, and ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 later added a
-- fifth function of the same kind:
--
--   * public.set_updated_at()                                — plpgsql trigger fn
--   * public.immutable_english_tsvector_text(text)           — search-vector helper
--   * public.immutable_english_tsvector_textarr(text[])      — search-vector helper
--   * public.immutable_english_tsvector_jsonb(jsonb)         — search-vector helper
--   * public.attachment_cleanup_path_is_safe(uuid,text,uuid) — path predicate
--
-- Migration 20260927001229_harden_pg_catalog_helper_pg_temp_last (C51) then
-- moved the four whose bodies name built-in data types to
-- `search_path = pg_catalog, pg_temp`, so those names resolve deterministically
-- to `pg_catalog` in every session.
--
-- Migration 20260927214838_retire_immutable_english_tsvector_wrappers (C55)
-- then retired the three search-vector helpers: after C54 nothing called them.
-- The suite now pins two live groups and the retirement:
--
--   * hardened (1) — attachment_cleanup_path_is_safe: exactly
--     `pg_catalog, pg_temp`, in that order, nothing else;
--   * pg_catalog only (1) — set_updated_at(): its reviewed body names no data
--     type, so it deliberately stays at exactly `pg_catalog`. That is tied to
--     its body digest, so a body change fails here and forces a re-review;
--   * retired (3) — no immutable_english_tsvector_* function exists in any
--     schema. Their search_path hardening was correct while they were part of
--     the search boundary; the canonical search expression is owned by 024.
--
-- attachment_cleanup_path_is_safe is a non-RPC helper: SECURITY INVOKER, pure,
-- reading no table, callable by nobody but its owner, and used only from inside
-- the three cleanup RPCs. Its accept/refuse matrix is owned by
-- 014_attachment_cleanup_recovery.test.sql; section 6 here only confirms that
-- the hardened configuration still accepts an ordinary own path and refuses an
-- out-of-namespace one. Section 3 pins the retirement; sections 4–5 concern the
-- generated search column and set_updated_at specifically.
--
-- This suite pins that hardening and, just as importantly, pins that it stayed
-- execution-environment-only. The bounded RPC surface is not this suite's remit:
-- `search_papers`'s `search_path=public` and the least-privilege EXECUTE grants
-- are owned by 003_rpc_caller_scope_and_grants.test.sql, the Data API ACL matrix
-- by 015, and the SECURITY DEFINER `public, pg_temp` inventory (C50) by 021.
--
-- Asserted here:
--   * attachment_cleanup_path_is_safe carries exactly search_path=pg_catalog,
--     pg_temp — `pg_catalog` first, `pg_temp` last, no other schema, and no
--     second GUC in proconfig;
--   * set_updated_at() carries exactly search_path=pg_catalog, with its
--     reviewed body; and no other public function is pinned to pg_catalog;
--   * both remain SECURITY INVOKER with their original volatility, parallel
--     safety, language and return type, so a later "fix" cannot quietly promote
--     one to SECURITY DEFINER or relax IMMUTABLE/PARALLEL SAFE;
--   * the EXECUTE ACLs are exactly owner-only on both: the attachment helper
--     always was, and set_updated_at() is since C56
--     (20260928133918_harden_default_function_execute.sql), which revoked the
--     default posture it had carried until then (NULL on a clean replay,
--     explicit on hosted Production). Its callers and the rest of the function
--     EXECUTE posture are owned by 015, and the trigger-firing proof by 025;
--   * the three immutable_english_tsvector_* helpers are gone — no function of
--     those names exists in any schema — so a re-created one fails here;
--   * the generated `papers.search_vector` still populates, keeps its A/B/C/D
--     field weighting, and regenerates on UPDATE;
--   * `set_updated_at` still advances `papers.updated_at`, and every trigger in
--     public that uses it is discovered rather than assumed;
--   * attachment namespace validation is not weakened.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the transaction
-- and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- The C51-hardened function still live after C55, addressed by exact signature.
CREATE FUNCTION pg_temp.hardened_fns()
RETURNS TABLE (label text, oid oid) LANGUAGE sql AS $hlp$
  SELECT * FROM (VALUES
    ('attachment_cleanup_path_is_safe(uuid,text,uuid)',
       'public.attachment_cleanup_path_is_safe(uuid,text,uuid)'::regprocedure::oid)
  ) AS t(label, oid);
$hlp$;

-- Both bounded helpers: the one above plus the pg_catalog-only one.
CREATE FUNCTION pg_temp.helper_fns()
RETURNS TABLE (label text, oid oid) LANGUAGE sql AS $hlp$
  SELECT 'set_updated_at()', 'public.set_updated_at()'::regprocedure::oid
  UNION ALL
  SELECT * FROM pg_temp.hardened_fns();
$hlp$;

-- 6 (search_path) + 6 (posture + ACL) + 1 (retired helpers)
--   + 12 (generated search_vector) + 3 (set_updated_at) + 2 (attachment path) = 30
SELECT plan(30);

-- ══ 1. Bounded search_path ══════════════════════════════════════════════════
-- ── 1a. The hardened helper — exactly `pg_catalog, pg_temp` ──────────────────
SELECT is(
  (SELECT array_to_string(p.proconfig, ',') FROM pg_proc p WHERE p.oid = f.oid),
  'search_path=pg_catalog, pg_temp',
  'search_path: ' || f.label || ' is pinned to exactly pg_catalog, pg_temp'
) FROM pg_temp.hardened_fns() f;

-- proconfig must carry the search_path and nothing more — a second GUC here
-- would be an unreviewed execution-environment change.
SELECT is(
  (SELECT cardinality(p.proconfig) FROM pg_proc p WHERE p.oid = f.oid),
  1,
  'search_path: ' || f.label || ' sets no other GUC'
) FROM pg_temp.hardened_fns() f;

-- The configured schema list, parsed: `pg_catalog` first, `pg_temp` last, and
-- no other schema between or around them.
SELECT is(
  (SELECT string_to_array(substr(p.proconfig[1], length('search_path=') + 1), ', ')
     FROM pg_proc p WHERE p.oid = f.oid AND p.proconfig[1] LIKE 'search_path=%'),
  ARRAY['pg_catalog', 'pg_temp'],
  'search_path: ' || f.label || ' lists pg_catalog first and pg_temp last, nothing else'
) FROM pg_temp.hardened_fns() f;

-- ── 1b. set_updated_at() — deliberately exactly `pg_catalog` ─────────────────
SELECT is(
  (SELECT p.proconfig FROM pg_proc p WHERE p.oid = 'public.set_updated_at()'::regprocedure),
  ARRAY['search_path=pg_catalog'],
  'search_path: set_updated_at() is pinned to exactly pg_catalog and sets no other GUC');

-- Its pg_catalog-only classification holds for this reviewed body only: a body
-- change must be re-reviewed (keep it here, or move it to the hardened group).
SELECT is(
  (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.set_updated_at()'::regprocedure),
  '301a884953d37769916294bb60562e05',
  'search_path: set_updated_at() still has the reviewed body its classification is for');

-- ── 1c. Every pg_catalog-pinned public function is classified ────────────────
SELECT is(
  (SELECT string_agg(p.oid::regprocedure::text || ' = ' || array_to_string(p.proconfig, ','), '; '
                     ORDER BY p.oid::regprocedure::text COLLATE "C")
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND array_to_string(p.proconfig, ',') LIKE '%pg_catalog%'),
  'attachment_cleanup_path_is_safe(uuid,text,uuid) = search_path=pg_catalog, pg_temp; '
  || 'set_updated_at() = search_path=pg_catalog',
  'search_path: the pg_catalog-pinned public functions are exactly the classified 1 + 1');

-- ══ 2. The hardening stayed execution-environment-only ══════════════════════
SELECT ok(
  NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f.oid),
  'posture: ' || f.label || ' is still SECURITY INVOKER'
) FROM pg_temp.helper_fns() f;

SELECT is(
  (SELECT p.provolatile::text || '/' || p.proparallel::text || '/' ||
          l.lanname || '/' || pg_catalog.format_type(p.prorettype, NULL)
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.oid = f.oid),
  f.expected,
  'posture: ' || f.label || ' kept volatility/parallel/language/return type'
) FROM (
  SELECT h.label, h.oid, v.expected
    FROM pg_temp.helper_fns() h
    JOIN (VALUES
      ('set_updated_at()',                           'v/u/plpgsql/trigger'),
      -- IMMUTABLE and PARALLEL SAFE are load-bearing, not incidental: the helper
      -- is a pure predicate over its arguments, and anything that made it read
      -- state would have to change one of them.
      ('attachment_cleanup_path_is_safe(uuid,text,uuid)', 'i/s/sql/boolean')
    ) AS v(label, expected) ON v.label = h.label
) f;

-- EXECUTE ACLs. The attachment helper is owner-only everywhere.
SELECT is(
  (SELECT p.proacl::text FROM pg_proc p
    WHERE p.oid = 'public.attachment_cleanup_path_is_safe(uuid,text,uuid)'::regprocedure),
  '{postgres=X/postgres}',
  'acl: attachment_cleanup_path_is_safe(uuid,text,uuid) is still exactly owner-only');

-- set_updated_at() is exactly owner-only since C56, in every environment: the
-- migration converged both of its earlier reviewed forms (NULL on a clean
-- replay, the explicit five-entry form on hosted Production) on this one.
-- Section 5 below still proves the trigger fires; 025 proves it fires for a
-- caller holding no EXECUTE.
SELECT is(
  (SELECT coalesce(p.proacl::text, '<default>') FROM pg_proc p WHERE p.oid = f.oid),
  '{postgres=X/postgres}',
  'acl: ' || f.label || ' is exactly owner-only'
) FROM pg_temp.helper_fns() f
 WHERE f.label <> 'attachment_cleanup_path_is_safe(uuid,text,uuid)';

-- ══ 3. The three search-vector helpers are retired (C55) ═══════════════════
-- Not ignored: absent by name in every schema, so a re-created helper (at its
-- old signature or any other), an overload or a same-named function elsewhere
-- fails here, and the failure lists what it found.
SELECT is(
  (SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C")
     FROM pg_proc p
    WHERE p.proname IN ('immutable_english_tsvector_text', 'immutable_english_tsvector_textarr',
                        'immutable_english_tsvector_jsonb')),
  NULL,
  'retired: no immutable_english_tsvector_* function exists in any schema (C55)');

-- ══ 4. The generated papers.search_vector still works end to end ════════════
INSERT INTO auth.users (id, email) VALUES
  ('07000000-0000-0000-0000-000000000001','c08-U1@paperlume.test');

INSERT INTO public.papers (id, user_id, title, abstract, journal, notes, authors, keywords)
VALUES ('07000000-0000-0000-0000-0000000000a1',
        '07000000-0000-0000-0000-000000000001',
        'Randomized controlled trial of running therapy',
        'Patients were studied over twelve months with meta-analysis.',
        'Journal of Cardiovascular Prevention',
        'Reviewer notes: check the statistical methods.',
        '["Smith J","Müller K"]'::jsonb,
        '["cardiology","exercise"]'::jsonb);

SELECT isnt(
  (SELECT search_vector FROM public.papers
    WHERE id = '07000000-0000-0000-0000-0000000000a1'),
  NULL, 'search_vector: generated column populated');

-- One assertion per indexed field, so a regression names the field it broke.
SELECT ok(
  (SELECT search_vector FROM public.papers
    WHERE id = '07000000-0000-0000-0000-0000000000a1') @@ to_tsquery('english', q.term),
  'search_vector: ' || q.label || ' is indexed'
) FROM (VALUES
  ('title',            'randomized'),
  ('abstract',         'patient'),
  ('journal',          'cardiovascular'),
  ('notes',            'statistical'),
  ('authors (jsonb)',  'Smith'),
  ('keywords (jsonb)', 'cardiology'),
  ('english stemming', 'run')
) AS q(label, term);

SELECT ok(
  NOT ((SELECT search_vector FROM public.papers
         WHERE id = '07000000-0000-0000-0000-0000000000a1')
       @@ to_tsquery('english', 'nonexistentterm')),
  'search_vector: an absent term does not match');

-- Field weighting must survive: title A, abstract B, journal/authors/keywords C,
-- notes D. A collapsed weight set would silently change search ranking.
SELECT is(
  (SELECT string_agg(DISTINCT w, ',' ORDER BY w)
     FROM public.papers p,
          unnest(p.search_vector) AS u(lexeme, positions, weights),
          unnest(u.weights) AS w
    WHERE p.id = '07000000-0000-0000-0000-0000000000a1'),
  'A,B,C,D', 'search_vector: A/B/C/D field weighting preserved');

UPDATE public.papers SET title = 'Observational cohort of swimming therapy'
 WHERE id = '07000000-0000-0000-0000-0000000000a1';

SELECT ok(
  (SELECT search_vector FROM public.papers
    WHERE id = '07000000-0000-0000-0000-0000000000a1') @@ to_tsquery('english','swim'),
  'search_vector: regenerates on UPDATE (new title indexed)');

SELECT ok(
  NOT ((SELECT search_vector FROM public.papers
         WHERE id = '07000000-0000-0000-0000-0000000000a1')
       @@ to_tsquery('english','randomized')),
  'search_vector: regenerates on UPDATE (old title dropped)');

-- ══ 5. set_updated_at still fires ═══════════════════════════════════════════
-- Discovered, not assumed: whatever public triggers use the function must all
-- still be attached BEFORE UPDATE ... FOR EACH ROW.
SELECT is(
  (SELECT count(*)::int FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND t.tgfoid = 'public.set_updated_at()'::regprocedure
      AND NOT t.tgisinternal),
  1, 'set_updated_at: exactly one public trigger uses it');

SELECT is(
  (SELECT c.relname || '.' || t.tgname FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND t.tgfoid = 'public.set_updated_at()'::regprocedure
      AND NOT t.tgisinternal),
  'papers.trg_papers_updated_at', 'set_updated_at: still attached to papers');

-- The trigger must overwrite a caller-supplied updated_at with now().
UPDATE public.papers SET updated_at = '2020-01-01T00:00:00Z'
 WHERE id = '07000000-0000-0000-0000-0000000000a1';

SELECT ok(
  (SELECT updated_at FROM public.papers
    WHERE id = '07000000-0000-0000-0000-0000000000a1') > '2020-01-02T00:00:00Z'::timestamptz,
  'set_updated_at: overwrites a caller-supplied updated_at under the pinned path');

-- ══ 6. Attachment namespace validation is not weakened ══════════════════════
-- Two ordinary cases from 014's fixtures, which owns the full matrix: the
-- caller's own canonical path is still accepted, and another account's
-- namespace is still refused, under the hardened configuration.
SELECT is(
  public.attachment_cleanup_path_is_safe('aa000000-0000-0000-0000-0000000000a0'::uuid,
    'aa000000-0000-0000-0000-0000000000a0/a1000000-0000-0000-0000-0000000000a1/f.png', NULL::uuid),
  true, 'attachment path: the caller''s own canonical path is still accepted');

SELECT is(
  public.attachment_cleanup_path_is_safe('aa000000-0000-0000-0000-0000000000a0'::uuid,
    'bb000000-0000-0000-0000-0000000000b0/a1000000-0000-0000-0000-0000000000a1/f.png', NULL::uuid),
  false, 'attachment path: another account''s namespace is still refused');

SELECT * FROM finish();
ROLLBACK;
