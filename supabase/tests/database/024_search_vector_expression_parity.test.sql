-- DB-SEARCH-VECTOR-EXPRESSION-PARITY-001 suite 024: `papers.search_vector` has
-- exactly one generation expression — the direct built-in representation
-- (C54).
--
-- Migration 20260927161343_canonicalize_papers_search_vector_expression
-- accepts two starting representations and ends every database on one:
--
--   setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A')
--   || … abstract 'B' || journal 'C' || authors::text 'C' || keywords::text 'C'
--   || notes 'D'
--
-- rendered under `search_path = pg_catalog, pg_temp` as md5
-- 8ddd960b4f4b11dd7afd35485d01fd25 — the expression hosted Production has
-- stored since April 2026. A clean replay used to end on the equivalent
-- wrapper form (dd69f099a274a9cdc0f174ae0883ddb6, calling
-- immutable_english_tsvector_text/jsonb); the two differed because different
-- migration SQL text was executed, not because PostgreSQL "inlined" anything.
-- This suite owns the FINAL-STATE, single-representation contract:
--
--   1. shape — one nullable STORED generated tsvector column; the exact
--      expression text and digest; its complete dependency set (six input
--      columns, itself, the built-in `english` configuration — no function);
--      no column default depends on a wrapper; the calls in its node tree are
--      exactly setweight, to_tsvector(regconfig,text) and tsvector_concat, by
--      OID; each is a pg_catalog IMMUTABLE non-definer built-in `authenticated`
--      can EXECUTE; the jsonb fields reach it through two jsonb_out
--      coercions (IMMUTABLE); no to_tsvector(text,text) exists; the column's
--      only dependents are its default and idx_papers_search_vector, which is
--      present, valid, ready, live and GIN(search_vector);
--   2. weights — each field in isolation carries exactly its weight (title A,
--      abstract B, journal/authors/keywords C, notes D), all six together
--      carry A–D, and one small row equals its exact expected tsvector;
--   3. recomputation — a browser INSERT stores the canonical value, an UPDATE
--      of each of the six inputs recomputes it, and an UPDATE of another
--      column leaves it canonical;
--   4. semantics — a pinned, independent oracle: over a corpus of SQL NULL,
--      empty, whitespace, punctuation, case, prose, stopwords, numbers,
--      Unicode scripts, composed and decomposed accents, emoji/ZWJ, empty/
--      nested/scalar/mixed/null JSON, quotes and backslashes, SQL-like text,
--      swapped JSON order, over-long words, more than 16383 positions, large
--      text, the six isolated fields and all six together, the canonical
--      expression yields exactly each row's golden lexeme count and
--      md5(tsvectorsend(…)), and so does the vector stored in papers; one
--      over-limit input is refused by a real INSERT through the generated
--      column (54000) and leaves no row;
--   5. search — field-isolated matches rank A > B > C = C = C > D with exactly
--      the right matched_* flag; search_papers returns identical rows, ranks
--      and all six flags for 32 queries before and after the column is
--      rewritten to a function-wrapped form; the GIN index serves `@@`;
--   6. detection — a noncanonical expression (a function-wrapped form, or a
--      different configuration) is detected by the same shape checks,
--      RESTRICT refuses to drop a function the column depends on, and the
--      canonical form restores cleanly.
--
-- DB-IMMUTABLE-TSVECTOR-WRAPPER-RETIREMENT-001 (C55) retired the three
-- immutable_english_tsvector_* wrappers, so this suite asserts their absence
-- (as does 007) and no longer compares against them. Comparing the canonical
-- expression with a wrapper whose body was the same to_tsvector call was never
-- an independent check; the golden values in section 4 are. The wrapper-shaped
-- rewrite in sections 5 and 6 uses a test-only function,
-- public.zz_024_probe_tsvector(text), created and dropped inside this
-- transaction — never a retired name. Caller-EXECUTE on the expression's
-- functions for the INVOKER writes is also covered by 022/023.
--
-- Sections 5 and 6 rewrite papers (ALTER TABLE … SET EXPRESSION) inside this
-- suite's transaction; like every fixture here it is undone by the ROLLBACK.
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the
-- transaction and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;
-- to_tsvector reports an over-long word as a NOTICE; keep the TAP stream clean.
SET LOCAL client_min_messages = warning;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Every catalog rendering is taken under the migration's pinned path, so the
-- digests below are the ones the migration and Production use.

CREATE FUNCTION pg_temp.sv_attrdef_oid() RETURNS oid LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $hlp$
  SELECT d.oid FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector'
$hlp$;

CREATE FUNCTION pg_temp.sv_expr() RETURNS text LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $hlp$
  SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d WHERE d.oid = pg_temp.sv_attrdef_oid()
$hlp$;

CREATE FUNCTION pg_temp.sv_f1() RETURNS text LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $hlp$
  SELECT md5(pg_temp.sv_expr())
$hlp$;

-- Every pg_depend row of the column default, by name.
CREATE FUNCTION pg_temp.sv_deps() RETURNS text LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $hlp$
  SELECT string_agg(x.line, E'\n' ORDER BY x.line COLLATE "C")
    FROM (SELECT CASE dd.refclassid
                   WHEN 'pg_class'::regclass THEN 'pg_class:' || dd.refobjid::regclass::text || '.'
                        || coalesce((SELECT att.attname::text FROM pg_attribute att
                                      WHERE att.attrelid = dd.refobjid AND att.attnum = dd.refobjsubid), '#' || dd.refobjsubid::text)
                   WHEN 'pg_proc'::regclass THEN 'pg_proc:' || dd.refobjid::regprocedure::text
                   WHEN 'pg_ts_config'::regclass THEN 'pg_ts_config:' || dd.refobjid::regconfig::text
                   ELSE dd.refclassid::regclass::text || ':' || dd.refobjid::text
                 END || '|' || dd.deptype::text AS line
            FROM pg_depend dd
           WHERE dd.classid = 'pg_attrdef'::regclass AND dd.objid = pg_temp.sv_attrdef_oid()) x
$hlp$;

-- Every function and operator-function OID in the stored node tree.
CREATE FUNCTION pg_temp.sv_calls() RETURNS oid[] LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $hlp$
  SELECT array_agg(DISTINCT m[1]::oid ORDER BY m[1]::oid)
    FROM pg_attrdef d, regexp_matches(d.adbin::text, ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m
   WHERE d.oid = pg_temp.sv_attrdef_oid()
$hlp$;

-- The reviewed direct call set, resolved ONE signature per row; an entry that
-- did not resolve would make the array short, never silently vacuous.
CREATE FUNCTION pg_temp.direct_calls() RETURNS oid[] LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $hlp$
  SELECT CASE WHEN count(*) FILTER (WHERE to_regprocedure(s) IS NULL) = 0
              THEN array_agg(to_regprocedure(s)::oid ORDER BY to_regprocedure(s)::oid) END
    FROM (VALUES ('pg_catalog.setweight(tsvector,"char")'),
                 ('pg_catalog.to_tsvector(regconfig,text)'),
                 ('pg_catalog.tsvector_concat(tsvector,tsvector)')) AS w(s)
$hlp$;

CREATE FUNCTION pg_temp.direct_deps() RETURNS text LANGUAGE sql AS $hlp$
  SELECT 'pg_class:public.papers.abstract|n' || E'\n' || 'pg_class:public.papers.authors|n' || E'\n'
         || 'pg_class:public.papers.journal|n' || E'\n' || 'pg_class:public.papers.keywords|n' || E'\n'
         || 'pg_class:public.papers.notes|n' || E'\n' || 'pg_class:public.papers.search_vector|i' || E'\n'
         || 'pg_class:public.papers.title|n' || E'\n' || 'pg_ts_config:english|n'
$hlp$;

-- The whole single-representation check in one word, for section 6.
CREATE FUNCTION pg_temp.sv_shape() RETURNS text LANGUAGE sql AS $hlp$
  SELECT CASE WHEN pg_temp.sv_f1() = '8ddd960b4f4b11dd7afd35485d01fd25'
                   AND pg_temp.sv_deps() = pg_temp.direct_deps()
                   AND pg_temp.sv_calls() = pg_temp.direct_calls()
              THEN 'canonical'
              ELSE 'noncanonical ' || coalesce(pg_temp.sv_f1(), '<missing>') END
$hlp$;

-- The canonical direct expression over explicit inputs.
CREATE FUNCTION pg_temp.direct_sv(t text, ab text, j text, au jsonb, kw jsonb, n text)
RETURNS tsvector LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $hlp$
  SELECT setweight(to_tsvector('english'::regconfig, COALESCE(t, ''::text)), 'A')
         || setweight(to_tsvector('english'::regconfig, COALESCE(ab, ''::text)), 'B')
         || setweight(to_tsvector('english'::regconfig, COALESCE(j, ''::text)), 'C')
         || setweight(to_tsvector('english'::regconfig, COALESCE(au::text, ''::text)), 'C')
         || setweight(to_tsvector('english'::regconfig, COALESCE(kw::text, ''::text)), 'C')
         || setweight(to_tsvector('english'::regconfig, COALESCE(n, ''::text)), 'D')
$hlp$;

-- Exact equality: as tsvectors AND byte for byte.
CREATE FUNCTION pg_temp.same_sv(a tsvector, b tsvector) RETURNS boolean LANGUAGE sql AS $hlp$
  SELECT a IS NOT DISTINCT FROM b AND tsvectorsend(a) IS NOT DISTINCT FROM tsvectorsend(b)
$hlp$;

-- Stored vector of one paper vs the canonical expression over its own row.
CREATE FUNCTION pg_temp.stored_is_canonical(p_id uuid) RETURNS boolean LANGUAGE sql AS $hlp$
  SELECT coalesce((SELECT pg_temp.same_sv(p.search_vector,
                                          pg_temp.direct_sv(p.title, p.abstract, p.journal, p.authors, p.keywords, p.notes))
                     FROM public.papers p WHERE p.id = p_id), false)
$hlp$;

-- Distinct weights present in a vector, e.g. 'A,B,C,D'.
CREATE FUNCTION pg_temp.weights(v tsvector) RETURNS text LANGUAGE sql AS $hlp$
  SELECT coalesce(string_agg(DISTINCT w, ',' ORDER BY w), '') FROM unnest(v) AS u(lexeme, positions, weights), unnest(u.weights) AS w
$hlp$;

-- '<SQLSTATE> <message>' of evaluating a tsvector expression ('00000 ' on success).
CREATE FUNCTION pg_temp.err_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text; v_msg text;
BEGIN
  EXECUTE p_sql;
  RETURN '00000 ';
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  RETURN v_state || ' ' || v_msg;
END;
$hlp$;

-- '<SQLSTATE> <detail>' of a statement expected to fail, rendered under the
-- pinned path so object names are schema-qualified.
CREATE FUNCTION pg_temp.err_detail_of(p_sql text) RETURNS text LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $hlp$
DECLARE v_state text; v_detail text;
BEGIN
  EXECUTE p_sql;
  RETURN '00000 ';
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
  RETURN v_state || ' ' || v_detail;
END;
$hlp$;

-- Run p_sql as `authenticated` carrying p_user's claims; '<SQLSTATE> <message>'.
CREATE FUNCTION pg_temp.err_as(p_user uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text; v_msg text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql;
    v_state := '00000'; v_msg := '';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state || ' ' || v_msg;
END;
$hlp$;

-- search_papers as the fixture owner, rendered as one comparable line:
-- '<id>:<rank>:<six flags>' per row in result order.
CREATE FUNCTION pg_temp.search_as_owner(p_query text) RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"24a00000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT coalesce(string_agg(s.paper_id::text || ':' || s.rank::text || ':'
                             || s.matched_title::int || s.matched_abstract::int || s.matched_authors::int
                             || s.matched_journal::int || s.matched_notes::int || s.matched_keywords::int,
                             ',' ORDER BY s.rank DESC, s.paper_id), '<none>')
    INTO v
    FROM public.search_papers('24a00000-0000-0000-0000-00000000000a', p_query, 1000, 0) s;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END;
$hlp$;

CREATE FUNCTION pg_temp.plan_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE r record; v text := '';
BEGIN
  FOR r IN EXECUTE 'EXPLAIN (COSTS OFF) ' || p_sql LOOP
    v := v || r."QUERY PLAN" || E'\n';
  END LOOP;
  RETURN v;
END;
$hlp$;

-- ── Corpus ──────────────────────────────────────────────────────────────────
CREATE TEMP TABLE c54_corpus (
  ord int PRIMARY KEY, label text NOT NULL,
  title text, abstract text, journal text, authors jsonb, keywords jsonb, notes text
);
INSERT INTO c54_corpus VALUES
  ( 1, 'SQL NULL in every field',       NULL, NULL, NULL, NULL, NULL, NULL),
  ( 2, 'empty strings and empty arrays', '', '', '', '[]', '[]', ''),
  ( 3, 'whitespace only',                '   ', E'\t\n  ', ' ', '[" "]', '["  "]', E'\n'),
  ( 4, 'punctuation only',               '!!! ... ??? ---', ';;; ,,, :::', '()', '["-"]', '["?!"]', '...'),
  ( 5, 'mixed case',                     'RUNNING Runner runs', 'MiXeD CaSe Abstract', 'JOURNAL of CARDIOLOGY', '["SMITH J","smith j"]', '["Exercise","EXERCISE"]', 'Case NOTES'),
  ( 6, 'English prose',                  'Randomized controlled trial of running therapy in patients with heart failure',
        'Patients were studied over twelve months; the meta-analysis pooled 14 cohorts and found reduced mortality.',
        'Journal of Cardiovascular Prevention', '["Smith J","Müller K","O''Brien T"]', '["cardiology","exercise therapy","RCT"]',
        'Reviewer notes: check the statistical methods and the follow-up period.'),
  ( 7, 'stopwords only',                 'the and of a an to in is was it', 'a the of and', 'The', '["The"]', '["and","or"]', 'it is'),
  ( 8, 'numbers, units and versions',    'COVID-19 in 2020: 3.5% of 1,000 patients; p<0.05; n=42', 'IL-6 and TNF-α; 10mg/kg; v2.1.3', 'Vol 12(3):45-67',
        '["2020","3.14",42,true]', '[1,2.5,-3,1e10]', 'ISBN 978-3-16-148410-0'),
  ( 9, 'Unicode scripts',                '日本語の論文 中文标题 한국어 제목', 'Ελληνικά κείμενο русский текст עברית العربية', 'हिन्दी पत्रिका',
        '["山田太郎","Иванов И"]', '["心臓","кардиология"]', 'ไทย'),
  (10, 'accents, composed (NFC)',        'Ångström café naïve façade', 'Über Straße Größe', 'Revista Española de Cardiología',
        '["Müller K","Ångström A","Dvořák A"]', '["café","naïve"]', 'Zürich résumé'),
  (11, 'accents, decomposed (NFD)',      E'cafe\u0301 nai\u0308ve', E'A\u030Angstro\u0308m', E'Espan\u0303ola', E'["Mu\u0308ller K"]', E'["cafe\u0301"]', E're\u0301sume\u0301'),
  (12, 'emoji, ZWJ sequences, flags',    E'Emoji \U0001F9EC study \U0001F52C of \U0001F469\u200D\U0001F52C scientists',
        E'Flags \U0001F1FA\U0001F1F8 and skin \U0001F44D\U0001F3FD', E'\U0001FAC0 Heart', E'["\U0001F469\u200D\u2695\uFE0F Dr Who"]',
        E'["\U0001F9EA","\u2764\uFE0F"]', E'zero\u200Bwidth\u200Cjoiner\u200Dtest'),
  (13, 'JSON: empty array and object',   'Empty JSON', NULL, NULL, '[]', '{}', NULL),
  (14, 'JSON: nested',                   'Nested JSON', NULL, NULL, '[{"name":"Smith J","affiliation":{"org":"Oxford","dept":["Cardio","Genetics"]}},{"b":2}]',
        '[["a","b"],{"k":"v"},null]', NULL),
  (15, 'JSON: scalars',                  'Scalar JSON', NULL, NULL, '"just a string author"', '42', NULL),
  (16, 'JSON: mixed element types',      'Mixed JSON', NULL, NULL, '["Smith J", 1, null, {"x":"y"}, ["z"]]', '{"primary":"cardiology","secondary":["exercise"]}', NULL),
  (17, 'JSON: null literal and "null"',  'Null JSON', NULL, NULL, 'null', '"null"', NULL),
  (18, 'JSON: escaped Unicode',          'Escaped JSON', NULL, NULL, '["\u00e9t\u00e9","\u6f22\u5b57"]', '["tab\there","new\nline"]', NULL),
  (19, 'quotes and backslashes',         'He said "hello" and ''goodbye''', E'back\\slash C:\\path\\to\\file \\n not newline', 'Quote "Journal"',
        E'["O''Brien T","\\"Quoted\\" Name","back\\\\slash"]', E'["it''s","\\"q\\""]', E'tab\there'),
  (20, 'SQL-like and tsquery-like text', 'Robert''); DROP TABLE papers;--', 'SELECT * FROM users WHERE 1=1 OR ''a''=''a''', '/* comment */ -- line',
        '["1; DELETE FROM x"]', '["UNION SELECT"]', 'a & b | !c <-> d:* ''e'' (f) <2>'),
  (21, 'URLs, e-mail, hyphenation',      'e-mail user@example.org about well-known self-report', 'https://doi.org/10.1000/xyz-123 and http://example.com/a?b=c', 'J. Clin. Invest.',
        '["van der Berg-Smith A"]', '["X-ray","co-operation"]', 'see ftp://files.example.net/x.pdf'),
  (22, 'JSON order A (authors/keywords)', 'Swapped order', NULL, NULL, '["Alpha A","Beta B"]', '["first","second"]', NULL),
  (23, 'JSON order B (swapped)',          'Swapped order', NULL, NULL, '["Beta B","Alpha A"]', '["second","first"]', NULL),
  (24, 'over-long word (not indexed)',    repeat('x', 3000) || ' short', NULL, NULL, NULL, NULL, NULL),
  (25, 'more than 16383 positions and 255 per lexeme', repeat('trial ', 1000), (SELECT string_agg('w' || i, ' ') FROM generate_series(1, 20000) i),
        NULL, NULL, NULL, repeat('note ', 20000)),
  (26, 'large text (~200 KB)',            'Large text', repeat('Cardiology exercise randomized trial outcome measures mortality hospitalization. ', 2500), NULL, NULL, NULL, NULL),
  (27, 'title only',                      'zqcweight title', NULL, NULL, NULL, NULL, NULL),
  (28, 'abstract only',                   NULL, 'zqcweight abstract', NULL, NULL, NULL, NULL),
  (29, 'journal only',                    NULL, NULL, 'zqcweight journal', NULL, NULL, NULL),
  (30, 'authors only',                    NULL, NULL, NULL, '["zqcweight author"]', NULL, NULL),
  (31, 'keywords only',                   NULL, NULL, NULL, NULL, '["zqcweight keyword"]', NULL),
  (32, 'notes only',                      NULL, NULL, NULL, NULL, NULL, 'zqcweight notes'),
  (33, 'all six fields populated',        'zqcall title words', 'zqcall abstract words', 'zqcall journal', '["zqcall author"]', '["zqcall keyword"]', 'zqcall notes');

-- ── Golden oracle ───────────────────────────────────────────────────────────
-- For each corpus row, what the canonical expression must produce: its lexeme
-- count and md5(tsvectorsend(…)) — the exact binary form, so every lexeme,
-- position and weight is covered. Pinned on 2026-09-28 and identical, row for
-- row, on a clean local replay and in hosted Production (both PostgreSQL 17.6).
-- Rows 1–4 and 7 are legitimately the empty vector. A change here means
-- PostgreSQL's text-search output itself changed — a new release (17.11, for
-- example, hardens tsvector length limits) or a new snowball stemmer or
-- dictionary; update deliberately by recomputing
--   SELECT c.ord, length(v), md5(tsvectorsend(v)) FROM c54_corpus c,
--     LATERAL pg_temp.direct_sv(c.title, c.abstract, c.journal, c.authors, c.keywords, c.notes) v
--    ORDER BY c.ord;
-- and review every row that moved before accepting it.
CREATE TEMP TABLE c54_golden (ord int PRIMARY KEY, lexemes int NOT NULL, tsvectorsend_md5 text NOT NULL);
INSERT INTO c54_golden VALUES
  ( 1,     0, 'f1d3ff8443297732862df21dc4e57262'),
  ( 2,     0, 'f1d3ff8443297732862df21dc4e57262'),
  ( 3,     0, 'f1d3ff8443297732862df21dc4e57262'),
  ( 4,     0, 'f1d3ff8443297732862df21dc4e57262'),
  ( 5,    11, '5a43db0f26a4e4c2a17cd3bcf616bfa8'),
  ( 6,    40, '17e7da846240473a3c40144a4d42a8f6'),
  ( 7,     0, 'f1d3ff8443297732862df21dc4e57262'),
  ( 8,    33, '1b79eed8ad65ceccb00bf8f87de11598'),
  ( 9,    18, 'fe8cc6ff7d4e52f07258e6c1cf000367'),
  (10,    16, '9fdc5a0c65fa2f8927ca2e3fb6d1c4d8'),
  (11,     7, '8cc27426be4148a820decb2468eaa693'),
  (12,     8, 'a69cc7c0ac02cc05126bf8b93ab330c7'),
  (13,     2, '62d5c724dab4e9d014a354e94e98668b'),
  (14,    16, 'c47ca7ca807c0513de0366d7b03652f9'),
  (15,     5, '781adbb3ce7a35ca3dac8beb89e1f633'),
  (16,    13, '6ab64955efaec83ff00a706d80777b25'),
  (17,     2, 'a83eeb14e4380e03c4eb7b6749398f7c'),
  (18,     7, '7335a268a0819fde2d71a1e6d56e1cb4'),
  (19,    17, '737457eea9c8c81d6266d2bcf81a065b'),
  (20,    18, '76c6d2632cab986c4273aa0ab2ef6686'),
  (21,    34, '6b031fdf547506d7a4d78f40468c9518'),
  (22,     7, '35d669159589a0dacb34798521e54088'),
  (23,     7, '026fb5f1b9b40acd6f4ee0eb3d05b0fa'),
  (24,     1, '949b38eff8702d3e04bf49debeec7f58'),
  (25, 20002, '462d20111353e8f15a5dbd0aa5d9988c'),
  (26,    10, '8241819a6e48316da4ce0d2b133db3eb'),
  (27,     2, 'f6375938fa0d49b6a81d59f6e3202271'),
  (28,     2, '3347d4abeab94365ce8e01b6a1bbbeb7'),
  (29,     2, 'd3deba0121d64904bb071cb66c49779f'),
  (30,     2, '28fc0543fd4304c3a3c4d16a4c69ea70'),
  (31,     2, 'a504438e2e1d602664b7a95912234abd'),
  (32,     2, 'f920b7dcb78e627e1755ca4fedf4e27b'),
  (33,     8, '9d96fdb8520c7e749efbcfad94ce6197');

-- ── Fixtures (as the table owner; RLS bypassed) ──────────────────────────────
-- The owner holds one paper per corpus row (papers.title is NOT NULL, so a
-- NULL title is stored as ''), plus one row the browser writes in section 3.
INSERT INTO auth.users (id, email) VALUES
  ('24a00000-0000-0000-0000-00000000000a', 'c54-A@paperlume.test'),
  ('24b00000-0000-0000-0000-00000000000b', 'c54-B@paperlume.test');

INSERT INTO public.papers (id, user_id, title, abstract, journal, authors, keywords, notes)
SELECT ('24a00000-0000-0000-0000-' || lpad(c.ord::text, 12, '0'))::uuid, '24a00000-0000-0000-0000-00000000000a',
       coalesce(c.title, ''), c.abstract, c.journal, c.authors, c.keywords, c.notes
  FROM c54_corpus c;

-- Another account's paper that matches the same terms (search must not see it).
INSERT INTO public.papers (id, user_id, title, abstract, journal, authors, keywords, notes) VALUES
  ('24b00000-0000-0000-0000-0000000000b1', '24b00000-0000-0000-0000-00000000000b',
   'zqcweight zqcall foreign title', 'Randomized running', 'Journal of Cardiovascular Prevention', '["Smith J"]', '["cardiology"]', 'foreign');

SELECT plan(90);

-- ══ 1. One representation: the canonical direct built-in expression ════════
SELECT is(
  (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector' AND NOT a.attisdropped),
  1, 'shape: papers has exactly one search_vector column');

SELECT is(
  (SELECT format('generated=%s type=%s notnull=%s identity=%s', a.attgenerated, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity)
     FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector'),
  'generated=s type=tsvector notnull=f identity=',
  'shape: search_vector is a nullable STORED generated tsvector');

SELECT is(pg_temp.sv_expr(),
  '(((((setweight(to_tsvector(''english''::regconfig, COALESCE(title, ''''::text)), ''A''::"char") || '
  || 'setweight(to_tsvector(''english''::regconfig, COALESCE(abstract, ''''::text)), ''B''::"char")) || '
  || 'setweight(to_tsvector(''english''::regconfig, COALESCE(journal, ''''::text)), ''C''::"char")) || '
  || 'setweight(to_tsvector(''english''::regconfig, COALESCE((authors)::text, ''''::text)), ''C''::"char")) || '
  || 'setweight(to_tsvector(''english''::regconfig, COALESCE((keywords)::text, ''''::text)), ''C''::"char")) || '
  || 'setweight(to_tsvector(''english''::regconfig, COALESCE(notes, ''''::text)), ''D''::"char"))',
  'shape: the stored expression is exactly the canonical direct built-in text');

SELECT is(pg_temp.sv_f1(), '8ddd960b4f4b11dd7afd35485d01fd25',
  'shape: the expression digest (F1) is 8ddd960b… — hosted Production''s');

SELECT isnt(pg_temp.sv_f1(), 'dd69f099a274a9cdc0f174ae0883ddb6',
  'shape: the former clean-replay wrapper representation is gone');

SELECT is(pg_temp.sv_deps(), pg_temp.direct_deps(),
  'shape: its dependencies are exactly its six input columns, itself and the built-in english configuration');

SELECT is(
  (SELECT count(*)::int FROM pg_depend dd
    WHERE dd.classid = 'pg_attrdef'::regclass AND dd.objid = pg_temp.sv_attrdef_oid() AND dd.refclassid = 'pg_proc'::regclass),
  0, 'shape: it depends on no function at all');

SELECT is(
  (SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C")
     FROM pg_proc p
    WHERE p.proname IN ('immutable_english_tsvector_text', 'immutable_english_tsvector_textarr',
                        'immutable_english_tsvector_jsonb')),
  NULL, 'shape: the retired immutable_english_tsvector_* wrappers exist nowhere (C55)');

SELECT ok(pg_temp.direct_calls() IS NOT NULL AND cardinality(pg_temp.direct_calls()) = 3,
  'calls: the three reviewed built-in signatures each resolve');

SELECT is(pg_temp.sv_calls(), pg_temp.direct_calls(),
  'calls: the stored node tree calls exactly setweight, to_tsvector(regconfig,text) and tsvector_concat (by OID)');

SELECT is(
  (SELECT coalesce(string_agg(c::regprocedure::text, ', '), '')
     FROM unnest(pg_temp.sv_calls()) AS c WHERE NOT has_function_privilege('authenticated', c, 'EXECUTE')),
  '', 'calls: authenticated can EXECUTE every function the expression calls');

SELECT is(
  (SELECT string_agg(format('%s:%s:%s:%s', p.proname, p.pronamespace::regnamespace, p.provolatile, p.prosecdef), ', ' ORDER BY p.proname)
     FROM pg_proc p WHERE p.oid = ANY (pg_temp.sv_calls() || 'pg_catalog.jsonb_out(jsonb)'::regprocedure::oid)),
  'jsonb_out:pg_catalog:i:f, setweight:pg_catalog:i:f, to_tsvector:pg_catalog:i:f, tsvector_concat:pg_catalog:i:f',
  'calls: every callee, and jsonb_out behind authors::text / keywords::text, is an IMMUTABLE non-definer pg_catalog built-in');

SELECT is(
  (SELECT count(*)::int FROM pg_attrdef d, regexp_matches(d.adbin::text, '\{COERCEVIAIO :arg \{VAR :varno 1 :varattno [0-9]+ :vartype 3802 ', 'g') AS m
    WHERE d.oid = pg_temp.sv_attrdef_oid()),
  2, 'calls: authors and keywords reach it through exactly two jsonb-to-text output coercions');

SELECT ok(to_regprocedure('pg_catalog.to_tsvector(text,text)') IS NULL,
  'calls: there is no to_tsvector(text,text) overload (the 20260305020000 header was wrong)');

SELECT is(
  (SELECT string_agg(x.line, ', ' ORDER BY x.line COLLATE "C")
     FROM (SELECT CASE dd.classid WHEN 'pg_attrdef'::regclass THEN 'default'
                                  WHEN 'pg_class'::regclass THEN dd.objid::regclass::text
                                  ELSE dd.classid::regclass::text END || '|' || dd.deptype::text AS line
             FROM pg_depend dd
            WHERE dd.refclassid = 'pg_class'::regclass AND dd.refobjid = 'public.papers'::regclass
              AND dd.refobjsubid = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.papers'::regclass AND attname = 'search_vector')) x),
  'default|i, idx_papers_search_vector|a',
  'shape: the column''s only dependents are its default and idx_papers_search_vector');

SELECT is(
  (SELECT format('valid=%s ready=%s live=%s %s', i.indisvalid, i.indisready, i.indislive, pg_get_indexdef(i.indexrelid))
     FROM pg_index i WHERE i.indexrelid = 'public.idx_papers_search_vector'::regclass AND i.indrelid = 'public.papers'::regclass),
  'valid=t ready=t live=t CREATE INDEX idx_papers_search_vector ON public.papers USING gin (search_vector)',
  'index: idx_papers_search_vector is present, valid, ready, live and GIN(search_vector)');

-- ══ 2. Field weights ════════════════════════════════════════════════════════
SELECT is(pg_temp.weights(p.search_vector), w.want,
  'weights: ' || c.label || ' is weighted ' || w.want)
  FROM c54_corpus c
  JOIN (VALUES (27, 'A'), (28, 'B'), (29, 'C'), (30, 'C'), (31, 'C'), (32, 'D'), (33, 'A,B,C,D')) AS w(ord, want) ON w.ord = c.ord
  JOIN public.papers p ON p.id = ('24a00000-0000-0000-0000-' || lpad(c.ord::text, 12, '0'))::uuid
 ORDER BY c.ord;

SELECT is(
  pg_temp.direct_sv('Running trials', 'Patients ran', 'Heart Journal', '["Smith J"]', '["cardio"]', 'check notes')::text,
  '''cardio'':9C ''check'':10 ''heart'':5C ''j'':8C ''journal'':6C ''note'':11 ''patient'':3B ''ran'':4B ''run'':1A ''smith'':7C ''trial'':2A',
  'weights: a small row yields exactly the expected tsvector (positions continue across fields; D is unmarked)');

-- ══ 3. Recomputation on INSERT and UPDATE ═══════════════════════════════════
SELECT is(pg_temp.err_as('24a00000-0000-0000-0000-00000000000a',
    $q$INSERT INTO public.papers (id, user_id, title, abstract, journal, authors, keywords, notes)
       VALUES ('24a00000-0000-0000-0000-0000000000f1', '24a00000-0000-0000-0000-00000000000a',
               'Inserted title', 'Inserted abstract', 'Inserted journal', '["Inserted Author"]', '["inserted"]', 'inserted note')$q$),
  '00000 ', 'recompute: the browser inserts a paper directly');
SELECT ok(pg_temp.stored_is_canonical('24a00000-0000-0000-0000-0000000000f1'),
  'recompute: the INSERT stored exactly the canonical vector');

SELECT is(pg_temp.err_as('24a00000-0000-0000-0000-00000000000a',
    format('UPDATE public.papers SET %I = %s WHERE id = %L', f.col, f.val, '24a00000-0000-0000-0000-0000000000f1'))
  || pg_temp.stored_is_canonical('24a00000-0000-0000-0000-0000000000f1')::text,
  '00000 true', 'recompute: an UPDATE of ' || f.col || ' recomputes the canonical vector')
  FROM (VALUES (1, 'title', '''Updated zqcupdtitle'''), (2, 'abstract', '''Updated zqcupdabstract'''), (3, 'journal', '''Updated zqcupdjournal'''),
               (4, 'authors', '''["Updated zqcupdauthor"]''::jsonb'), (5, 'keywords', '''["zqcupdkeyword"]''::jsonb'), (6, 'notes', '''zqcupdnote''')) AS f(o, col, val)
 ORDER BY f.o;

SELECT ok((SELECT p.search_vector @@ to_tsquery('english', 'zqcupdtitle & zqcupdabstract & zqcupdjournal & zqcupdauthor & zqcupdkeyword & zqcupdnote')
             AND NOT p.search_vector @@ to_tsquery('english', 'inserted')
             FROM public.papers p WHERE p.id = '24a00000-0000-0000-0000-0000000000f1'),
  'recompute: all six new values are indexed and the old ones are gone');

SELECT is(pg_temp.err_as('24a00000-0000-0000-0000-00000000000a',
    $q$UPDATE public.papers SET study_type = 'Cohort' WHERE id = '24a00000-0000-0000-0000-0000000000f1'$q$)
  || pg_temp.stored_is_canonical('24a00000-0000-0000-0000-0000000000f1')::text,
  '00000 true', 'recompute: an UPDATE of a non-input column leaves the vector canonical');

-- ══ 4. Semantics — the canonical expression against the golden oracle ══════
SELECT is(format('lexemes=%s md5=%s', length(x.v), md5(tsvectorsend(x.v))),
          format('lexemes=%s md5=%s', g.lexemes, g.tsvectorsend_md5),
  'corpus: ' || c.label || ' — the canonical expression yields its golden value')
  FROM c54_corpus c
  LEFT JOIN c54_golden g USING (ord)
  CROSS JOIN LATERAL (SELECT pg_temp.direct_sv(c.title, c.abstract, c.journal, c.authors, c.keywords, c.notes) AS v) x
 ORDER BY c.ord;

SELECT is(
  (SELECT count(*)::int FROM c54_golden g FULL JOIN c54_corpus c USING (ord) WHERE g.ord IS NULL OR c.ord IS NULL),
  0, 'corpus (control): every corpus row has exactly one golden value and no golden value is orphaned');

SELECT isnt(pg_temp.direct_sv('A', 'B', 'C', '["D"]', '["E"]', 'F'), pg_temp.direct_sv('B', 'A', 'C', '["D"]', '["E"]', 'F'),
  'corpus (control): moving text between fields changes the vector, so the golden values are not vacuous');

SELECT isnt(tsvectorsend(pg_temp.direct_sv(NULL, NULL, NULL, '["Alpha A","Beta B"]', NULL, NULL)),
            tsvectorsend(pg_temp.direct_sv(NULL, NULL, NULL, '["Beta B","Alpha A"]', NULL, NULL)),
  'corpus (control): swapped JSON order changes positions (rows 22 and 23 carry different golden values)');

SELECT is(
  (SELECT count(*)::int FROM c54_corpus c
     JOIN c54_golden g USING (ord)
     JOIN public.papers p ON p.id = ('24a00000-0000-0000-0000-' || lpad(c.ord::text, 12, '0'))::uuid
    WHERE NOT pg_temp.same_sv(p.search_vector, pg_temp.direct_sv(p.title, p.abstract, p.journal, p.authors, p.keywords, p.notes))
       OR md5(tsvectorsend(p.search_vector)) IS DISTINCT FROM g.tsvectorsend_md5),
  0, 'corpus: every stored corpus vector equals the canonical expression over its row and its golden value, byte for byte');

SELECT is(
  (SELECT max(pos) || ' ' || max(cardinality(u.positions))
     FROM public.papers p, unnest(p.search_vector) AS u(lexeme, positions, weights), unnest(u.positions) AS pos
    WHERE p.id = '24a00000-0000-0000-0000-000000000025'),
  '16383 255',
  'corpus (control): row 25 really reaches the position clamp (16383) and the per-lexeme cap (255)');

-- Over the tsvector size limit: the canonical expression refuses the input,
-- and so does a real browser INSERT through the generated column — which
-- therefore leaves no row behind.
SELECT alike(
  pg_temp.err_of($q$SELECT pg_temp.direct_sv((SELECT string_agg(md5(i::text), ' ') FROM generate_series(1, 40000) i), NULL, NULL, NULL, NULL, NULL)$q$),
  '54000 string is too long for tsvector%',
  'corpus (control): that input really is over the tsvector limit');
SELECT alike(
  pg_temp.err_as('24a00000-0000-0000-0000-00000000000a',
    $q$INSERT INTO public.papers (id, user_id, title)
       VALUES ('24a00000-0000-0000-0000-0000000000e1', '24a00000-0000-0000-0000-00000000000a',
               (SELECT string_agg(md5(i::text), ' ') FROM generate_series(1, 40000) i))$q$),
  '54000 string is too long for tsvector%',
  'corpus: an over-limit title is refused by a real INSERT through the generated column (54000)');
SELECT is((SELECT count(*)::int FROM public.papers WHERE id = '24a00000-0000-0000-0000-0000000000e1'), 0,
  'corpus: and the refused INSERT left no row');

-- ══ 5. Search behavior ══════════════════════════════════════════════════════
-- Field-isolated matches: one row per field carries `zqcweight`.
SELECT is(pg_temp.search_as_owner('zqcweight'),
  (SELECT string_agg(r, ',' ORDER BY o) FROM (VALUES
     (1, '24a00000-0000-0000-0000-000000000027:0.607927:100000'),
     (2, '24a00000-0000-0000-0000-000000000028:0.243171:010000'),
     (3, '24a00000-0000-0000-0000-000000000029:0.121585:000100'),
     (4, '24a00000-0000-0000-0000-000000000030:0.121585:001000'),
     (5, '24a00000-0000-0000-0000-000000000031:0.121585:000001'),
     (6, '24a00000-0000-0000-0000-000000000032:0.0607927:000010')) AS x(o, r)),
  'search: title (A) > abstract (B) > journal = authors = keywords (C) > notes (D), each with exactly its own matched_* flag');

SELECT is(pg_temp.search_as_owner('zqcall'),
  '24a00000-0000-0000-0000-000000000033:' || (SELECT ts_rank(p.search_vector, to_tsquery('english', 'zqcall:*'))::text FROM public.papers p WHERE p.id = '24a00000-0000-0000-0000-000000000033')
  || ':111111',
  'search: a term in all six fields sets all six flags, and the other account''s row is not returned');

-- The same searches, and the corpus searches, before and after the column is
-- rewritten to a function-wrapped form — the shape C54 removed — through a
-- test-only probe with the same body the retired text wrapper had:
-- identical rows, ranks and flags.
CREATE TEMP TABLE c54_queries (o int PRIMARY KEY, q text NOT NULL);
INSERT INTO c54_queries VALUES
  (1, 'zqcweight'), (2, 'zqcall'), (3, 'running'), (4, 'run'), (5, 'cardiology'), (6, 'cardio'), (7, 'smith'),
  (8, 'müller'), (9, 'café'), (10, 'naïve'), (11, 'exercise therapy'), (12, 'covid'), (13, '2020'), (14, 'tnf'),
  (15, '日本語'), (16, 'кардиология'), (17, 'o''brien'), (18, 'quoted'), (19, 'drop table'), (20, 'union select'),
  (21, 'alpha'), (22, 'first second'), (23, 'oxford genetics'), (24, 'trial outcome'), (25, 'mortality hospitalization'),
  (26, 'doi.org'), (27, 'x-ray'), (28, 'the'), (29, ''), (30, 'a & b'), (31, 'zqcupdtitle'), (32, 'swapped');
CREATE TEMP TABLE c54_search_canonical AS SELECT q.o, pg_temp.search_as_owner(q.q) AS r FROM c54_queries q;

CREATE FUNCTION public.zz_024_probe_tsvector(p text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
AS $$ SELECT to_tsvector('english'::regconfig, COALESCE(p, '')) $$;
ALTER TABLE public.papers ALTER COLUMN search_vector SET EXPRESSION AS (
    setweight(public.zz_024_probe_tsvector(title), 'A') ||
    setweight(public.zz_024_probe_tsvector(abstract), 'B') ||
    setweight(public.zz_024_probe_tsvector(journal), 'C') ||
    setweight(public.zz_024_probe_tsvector(authors::text), 'C') ||
    setweight(public.zz_024_probe_tsvector(keywords::text), 'C') ||
    setweight(public.zz_024_probe_tsvector(notes), 'D'));
SELECT ok(pg_temp.sv_f1() <> '8ddd960b4f4b11dd7afd35485d01fd25'
          AND 'public.zz_024_probe_tsvector(text)'::regprocedure::oid = ANY (pg_temp.sv_calls()),
  'search: (rewritten in this transaction to a function-wrapped form through the test-only probe)');
CREATE TEMP TABLE c54_search_wrapped AS SELECT q.o, pg_temp.search_as_owner(q.q) AS r FROM c54_queries q;

SELECT is(
  (SELECT count(*)::int FROM c54_search_canonical c FULL JOIN c54_search_wrapped w USING (o) WHERE c.r IS DISTINCT FROM w.r),
  0, 'search: search_papers rows, ranks and all six matched_* flags are identical for 32 queries under both forms');
SELECT ok((SELECT count(*) FROM c54_search_canonical WHERE r <> '<none>') >= 25,
  'search (control): most of those queries return rows, so the comparison is not vacuous');

-- ══ 6. Detection of a noncanonical expression, and restoration ═════════════
SELECT ok(pg_temp.sv_shape() LIKE 'noncanonical %',
  'detect: the function-wrapped form is flagged as noncanonical');
SELECT is(pg_temp.sv_deps(),
  'pg_class:public.papers.abstract|n' || E'\n' || 'pg_class:public.papers.authors|n' || E'\n'
  || 'pg_class:public.papers.journal|n' || E'\n' || 'pg_class:public.papers.keywords|n' || E'\n'
  || 'pg_class:public.papers.notes|n' || E'\n' || 'pg_class:public.papers.search_vector|i' || E'\n'
  || 'pg_class:public.papers.title|n' || E'\n' || 'pg_proc:public.zz_024_probe_tsvector(text)|n',
  'detect: in that form the column depends on a project function — the kind of dependency C54 removed');
-- The gate C55's migration relies on: while a generated column depends on a
-- function, DROP FUNCTION … RESTRICT refuses and names the column.
SELECT is(pg_temp.err_detail_of('DROP FUNCTION public.zz_024_probe_tsvector(text) RESTRICT'),
  '2BP01 column search_vector of table public.papers depends on function public.zz_024_probe_tsvector(text)',
  'detect: DROP FUNCTION … RESTRICT refuses to drop a function the generated column depends on, and names the column');

ALTER TABLE public.papers ALTER COLUMN search_vector SET EXPRESSION AS (
    setweight(to_tsvector('simple'::regconfig, COALESCE(title, ''::text)), 'A')
    || setweight(to_tsvector('english'::regconfig, COALESCE(abstract, ''::text)), 'B')
    || setweight(to_tsvector('english'::regconfig, COALESCE(journal, ''::text)), 'C')
    || setweight(to_tsvector('english'::regconfig, COALESCE(authors::text, ''::text)), 'C')
    || setweight(to_tsvector('english'::regconfig, COALESCE(keywords::text, ''::text)), 'C')
    || setweight(to_tsvector('english'::regconfig, COALESCE(notes, ''::text)), 'D'));
SELECT ok(pg_temp.sv_shape() LIKE 'noncanonical %' AND pg_temp.sv_calls() = pg_temp.direct_calls(),
  'detect: a built-in-only expression with the wrong configuration is still flagged (the digest, not the call set, catches it)');
SELECT ok(NOT pg_temp.stored_is_canonical('24a00000-0000-0000-0000-000000000006'),
  'detect: and its stored values really differ from the canonical expression');

ALTER TABLE public.papers ALTER COLUMN search_vector SET EXPRESSION AS (
    setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A')
    || setweight(to_tsvector('english'::regconfig, COALESCE(abstract, ''::text)), 'B')
    || setweight(to_tsvector('english'::regconfig, COALESCE(journal, ''::text)), 'C')
    || setweight(to_tsvector('english'::regconfig, COALESCE(authors::text, ''::text)), 'C')
    || setweight(to_tsvector('english'::regconfig, COALESCE(keywords::text, ''::text)), 'C')
    || setweight(to_tsvector('english'::regconfig, COALESCE(notes, ''::text)), 'D'));
SELECT is(pg_temp.sv_shape(), 'canonical', 'detect: the canonical text restores the canonical shape');
SELECT is(
  (SELECT count(*)::int FROM public.papers p WHERE p.user_id = '24a00000-0000-0000-0000-00000000000a'
      AND NOT pg_temp.stored_is_canonical(p.id)),
  0, 'detect: after restoration every fixture row stores the canonical vector again');
SELECT is(
  (SELECT count(*)::int FROM c54_search_canonical c
    WHERE c.r IS DISTINCT FROM pg_temp.search_as_owner((SELECT q.q FROM c54_queries q WHERE q.o = c.o))),
  0, 'detect: and search_papers returns exactly what it returned before either rewrite');

-- The GIN index serves the search predicate.
SET LOCAL enable_seqscan = off;
SELECT alike(pg_temp.plan_of($q$SELECT id FROM public.papers WHERE search_vector @@ to_tsquery('english', 'zqcweight')$q$),
  '%idx_papers_search_vector%', 'index: a search_vector @@ query is planned on idx_papers_search_vector');
SELECT is(
  (SELECT string_agg(right(p.id::text, 2), ',' ORDER BY p.id) FROM public.papers p WHERE p.search_vector @@ to_tsquery('english', 'zqcweight')),
  '27,28,29,30,31,32,b1', 'index: and it returns exactly the rows carrying the term');
SET LOCAL enable_seqscan = on;

SELECT * FROM finish();
ROLLBACK;
