-- PFA-C08 suite 007: bounded search_path on the non-RPC helper functions.
--
-- Migration 20260810152125_harden_remaining_function_search_paths pinned
-- `search_path = pg_catalog` on the four functions that remained on the Supabase
-- Security Advisor's `function_search_path_mutable` list after the C03B1 RPC
-- hardening:
--
--   * public.set_updated_at()                           — plpgsql trigger fn
--   * public.immutable_english_tsvector_text(text)      — search-vector helper
--   * public.immutable_english_tsvector_textarr(text[]) — search-vector helper
--   * public.immutable_english_tsvector_jsonb(jsonb)    — search-vector helper
--
-- ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 later added a fifth function of the
-- same kind, and it joins sections 1 and 2 for the same reason the original four
-- are there:
--
--   * public.attachment_cleanup_path_is_safe(uuid,text,uuid) — path predicate
--
-- It is a non-RPC helper: SECURITY INVOKER, pure, reading no table, callable by
-- nobody but its owner, and used only from inside the three cleanup RPCs. Its
-- BEHAVIOUR — which paths it accepts and refuses — is owned by
-- 014_attachment_cleanup_recovery.test.sql; what it owes this suite is the same
-- execution-environment pinning as its four predecessors. Sections 3–5 below
-- concern the search-vector wrappers specifically and do not apply to it.
--
-- This suite pins that hardening and, just as importantly, pins that it stayed
-- execution-environment-only. The bounded RPC surface is not this suite's remit:
-- `search_papers`'s `search_path=public` and the least-privilege EXECUTE grants
-- are owned by 003_rpc_caller_scope_and_grants.test.sql.
--
-- Asserted here:
--   * all four carry exactly search_path=pg_catalog — no wider value, and no
--     second GUC smuggled into proconfig;
--   * all four remain SECURITY INVOKER with their original volatility, parallel
--     safety, language and return type, so a later "fix" cannot quietly promote
--     one to SECURITY DEFINER or relax IMMUTABLE/PARALLEL SAFE;
--   * pg_catalog is *sufficient*: each wrapper still equals the raw
--     `to_tsvector('english', COALESCE(…))` form it wraps across NULL, empty,
--     English prose, punctuation, unicode, text[] and jsonb shapes — a resolution
--     failure under the pinned path would surface here rather than silently;
--   * the generated `papers.search_vector` still populates, keeps its A/B/C/D
--     field weighting, and regenerates on UPDATE;
--   * `set_updated_at` still advances `papers.updated_at`, and every trigger in
--     public that uses it is discovered rather than assumed.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the transaction
-- and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- The four hardened functions, addressed by exact signature.
CREATE FUNCTION pg_temp.hardened_fns()
RETURNS TABLE (label text, oid oid) LANGUAGE sql AS $hlp$
  SELECT * FROM (VALUES
    ('set_updated_at()',
       'public.set_updated_at()'::regprocedure::oid),
    ('immutable_english_tsvector_text(text)',
       'public.immutable_english_tsvector_text(text)'::regprocedure::oid),
    ('immutable_english_tsvector_textarr(text[])',
       'public.immutable_english_tsvector_textarr(text[])'::regprocedure::oid),
    ('immutable_english_tsvector_jsonb(jsonb)',
       'public.immutable_english_tsvector_jsonb(jsonb)'::regprocedure::oid),
    ('attachment_cleanup_path_is_safe(uuid,text,uuid)',
       'public.attachment_cleanup_path_is_safe(uuid,text,uuid)'::regprocedure::oid)
  ) AS t(label, oid);
$hlp$;

-- 10 (search_path) + 10 (posture) + 24 (wrapper equivalence)
--   + 12 (generated search_vector) + 3 (set_updated_at) = 59
SELECT plan(59);

-- ══ 1. Bounded search_path — exactly pg_catalog, nothing else ═══════════════
SELECT is(
  (SELECT array_to_string(p.proconfig, ',') FROM pg_proc p WHERE p.oid = f.oid),
  'search_path=pg_catalog',
  'search_path: ' || f.label || ' is pinned to exactly pg_catalog'
) FROM pg_temp.hardened_fns() f;

-- proconfig must carry the search_path and nothing more — a second GUC here
-- would be an unreviewed execution-environment change.
SELECT is(
  (SELECT cardinality(p.proconfig) FROM pg_proc p WHERE p.oid = f.oid),
  1,
  'search_path: ' || f.label || ' sets no other GUC'
) FROM pg_temp.hardened_fns() f;

-- ══ 2. The hardening stayed execution-environment-only ══════════════════════
SELECT ok(
  NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f.oid),
  'posture: ' || f.label || ' is still SECURITY INVOKER'
) FROM pg_temp.hardened_fns() f;

SELECT is(
  (SELECT p.provolatile::text || '/' || p.proparallel::text || '/' ||
          l.lanname || '/' || pg_catalog.format_type(p.prorettype, NULL)
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.oid = f.oid),
  f.expected,
  'posture: ' || f.label || ' kept volatility/parallel/language/return type'
) FROM (
  SELECT h.label, h.oid, v.expected
    FROM pg_temp.hardened_fns() h
    JOIN (VALUES
      ('set_updated_at()',                           'v/u/plpgsql/trigger'),
      ('immutable_english_tsvector_text(text)',      'i/s/sql/tsvector'),
      ('immutable_english_tsvector_textarr(text[])', 'i/s/sql/tsvector'),
      ('immutable_english_tsvector_jsonb(jsonb)',    'i/s/sql/tsvector'),
      -- IMMUTABLE and PARALLEL SAFE are load-bearing, not incidental: the helper
      -- is a pure predicate over its arguments, and anything that made it read
      -- state would have to change one of them.
      ('attachment_cleanup_path_is_safe(uuid,text,uuid)', 'i/s/sql/boolean')
    ) AS v(label, expected) ON v.label = h.label
) f;

-- ══ 3. pg_catalog is sufficient — wrappers still equal what they wrap ═══════
-- Each wrapper is `to_tsvector('english'::regconfig, COALESCE(<arg>, ''))`. If
-- the pinned path could not resolve to_tsvector or the `english` configuration,
-- these would error rather than return; if it silently changed tokenization,
-- they would differ. Both failure modes are caught here.
SELECT is(
  public.immutable_english_tsvector_text(v.val),
  to_tsvector('english'::regconfig, COALESCE(v.val, '')),
  'text wrapper: ' || v.label || ' matches the raw built-in form'
) FROM (VALUES
  ('null',      NULL::text),
  ('empty',     ''),
  ('whitespace','   '),
  ('prose',     'The running dogs quickly jumped over lazy foxes'),
  ('stemming',  'Randomized controlled trials studying immunotherapies'),
  ('punctuation','COVID-19: a meta-analysis (2021) — n=1,234; p<0.05'),
  ('stopwords', 'the a an of and or but in on at to'),
  ('unicode',   'Étude sur les protéines β-amyloïdes'),
  ('numeric',   '10.1000/example 41912805')
) AS v(label, val);

SELECT is(
  public.immutable_english_tsvector_textarr(v.val),
  to_tsvector('english'::regconfig, COALESCE(v.val::text, '')),
  'text[] wrapper: ' || v.label || ' matches the raw built-in form'
) FROM (VALUES
  ('null',        NULL::text[]),
  ('empty array', ARRAY[]::text[]),
  ('one element', ARRAY['Smith J']),
  ('many',        ARRAY['Smith J','Doe A','O''Brien P']),
  ('null element',ARRAY['Smith J', NULL]),
  ('unicode',     ARRAY['Müller K','Ångström A'])
) AS v(label, val);

SELECT is(
  public.immutable_english_tsvector_jsonb(v.val),
  to_tsvector('english'::regconfig, COALESCE(v.val::text, '')),
  'jsonb wrapper: ' || v.label || ' matches the raw built-in form'
) FROM (VALUES
  ('sql null',    NULL::jsonb),
  ('json null',   'null'::jsonb),
  ('empty array', '[]'::jsonb),
  ('string array','["Smith J","Doe A"]'::jsonb),
  ('empty object','{}'::jsonb),
  ('object',      '{"name":"Smith J","affiliation":"Oxford"}'::jsonb),
  ('nested',      '[{"a":["deep","values"]},{"b":2}]'::jsonb),
  ('unicode',     '["Müller K","Ångström A"]'::jsonb),
  ('empty string','[""]'::jsonb)
) AS v(label, val);

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
  NULL, 'search_vector: generated column populated under the pinned path');

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

SELECT * FROM finish();
ROLLBACK;
