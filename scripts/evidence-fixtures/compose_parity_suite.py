"""Compose supabase/tests/database/032_evidence_normalization_parity.test.sql.

The block between the two $fixture$ tags is the fixture file, byte for byte.
Run: python3 -I scripts/evidence-fixtures/compose_parity_suite.py <fixture.json> <out.sql>
"""
import sys

HEADER = """-- EVIDENCE-RECORDS-001B suite 032: match normalization v1 - parity with the
-- shared golden fixture; since EVIDENCE-RECORDS-001A3, the server's quote
-- location too.
--
-- WHAT THIS PROVES
-- The deployed public.evidence_normalize_v1(text) (20261016104232, PR-A2) and
-- the TypeScript normalizeEvidenceV1 (src/lib/evidence/normalization.ts) answer
-- the SAME vectors identically, and so do public.evidence_locate_quote
-- (20261017155445, PR-A3) and the TypeScript locateQuote
-- (src/lib/evidence/matcher.ts). All read one fixture:
--
--   src/lib/evidence/__tests__/fixtures/normalizationV1.vectors.json
--
-- The text between the two dollar-quote tags below is that file, byte for byte;
-- src/lib/evidence/__tests__/normalization.parity.test.ts fails if the two ever
-- differ. To change a vector, edit the JSON file, then replace everything
-- between the tags with its exact contents (scripts/evidence-fixtures/ holds
-- the generator and this suite's composer). The file is printable ASCII: every
-- other character is a JSON \\u escape, which PostgreSQL's jsonb decodes, so
-- this suite holds no invisible character either.
--
-- The expected values were computed OUTSIDE both implementations - Python's
-- unicodedata NFC plus the six REQUIREMENTS-001 section I3 steps, identical
-- under Unicode 13.0 and 16.0 - and agree with the 30 vectors and SHA-256s
-- suite 031 already pins (the fixture carries those 30 as N01-N30, plus the
-- migration's own $verify$ checks as V01-V06).
--
-- Per normalization vector:
--   * the JSON input decodes to exactly the recorded code points (so jsonb
--     decoding is itself checked, not assumed);
--   * the installed function's output equals the expected text;
--   * the SHA-256 of that output, as a saved copy's normalized_sha256 is
--     computed, equals the expected digest;
--   * for the non-idempotent vectors, a SECOND pass gives the recorded second-
--     pass text - documenting why every input must be normalized exactly once.
-- Per matching vector:
--   * the normalized quote's length in characters (code points, as
--     char_length counts them - two emoji are two, not four UTF-16 units);
--   * every occurrence of the normalized quote in the normalized copy,
--     overlapping ones included, as 0-based half-open character ranges.
--
-- The occurrence query in section M is a TEST ORACLE over built-in substr and
-- char_length, independent of any matcher. It pins the offset convention -
-- 0-based, half-open PostgreSQL character positions of the v1-normalized copy -
-- on the real server. Section L then runs the installed evidence_locate_quote
-- on every matching vector: its kind (invalid, not_found, unique, multiple),
-- its count, its problems for an invalid quote (letter or digit: Unicode
-- Alphabetic or an ASCII digit, by the builtin pg_c_utf8 collation), and every
-- occurrence at the oracle's offsets - none for an invalid quote, which is
-- never located even where the oracle finds it, and none beyond the cap of
-- 100 occurrences (too_many), which M50 and M51 pin. This suite creates no
-- function.
--
-- Runs as the database owner (both functions are owner-only), in one transaction
-- that rolls back. Synthetic data only; no remote calls.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- The shared fixture, verbatim ----------------------------------------------

CREATE TEMP TABLE fixture ON COMMIT DROP AS
SELECT $fixture$"""

FOOTER = """$fixture$::jsonb AS doc;

CREATE TEMP VIEW nv AS
SELECT e.v->>'id' AS id, e.v->>'title' AS title, e.v->>'input' AS input,
       e.v->>'input_code_points' AS input_code_points, e.v->>'expected' AS expected,
       e.v->>'expected_sha256' AS expected_sha256, e.v->>'second_pass' AS second_pass, e.ord
  FROM fixture, jsonb_array_elements(fixture.doc->'normalization') WITH ORDINALITY AS e(v, ord);

CREATE TEMP VIEW mv AS
SELECT e.v->>'id' AS id, e.v->>'title' AS title, e.v->>'quote' AS quote, e.v->>'snapshot' AS snapshot,
       (e.v->>'normalized_quote_length')::integer AS normalized_quote_length,
       e.v->'expected_normalized' AS expected_normalized,
       e.v->>'expected_kind' AS expected_kind, e.v->'invalid_problems' AS invalid_problems, e.ord
  FROM fixture, jsonb_array_elements(fixture.doc->'matching') WITH ORDINALITY AS e(v, ord);

SELECT plan(
  4
  + (SELECT 3 * count(*)::integer + count(second_pass)::integer FROM nv)
  + (SELECT 4 * count(*)::integer FROM mv));

-- F. The fixture itself -----------------------------------------------------

SELECT is((SELECT doc->>'fixture' FROM fixture), 'evidence-normalization-v1',
  'F1 the embedded document is the evidence normalization v1 fixture');
SELECT is((SELECT doc->>'normalization_version' FROM fixture), 'v1',
  'F2 its vectors are for normalization version v1');
SELECT is((SELECT count(DISTINCT id)::integer FROM (SELECT id FROM nv UNION ALL SELECT id FROM mv) AS ids),
          (SELECT count(*)::integer FROM nv) + (SELECT count(*)::integer FROM mv),
  'F3 every vector id is unique');
SELECT is((SELECT count(*)::integer FROM nv WHERE id ~ '^N(0[1-9]|[12][0-9]|30)$'), 30,
  'F4 the thirty golden vectors of suite 031 are in the fixture');

-- N. Normalization vectors --------------------------------------------------

-- lpad truncates a longer string, so pad to at least four digits, never fewer.
SELECT is(coalesce((SELECT string_agg(lpad(h.hex, greatest(4, char_length(h.hex)), '0'), ' ' ORDER BY i)
                      FROM generate_series(1, char_length(nv.input)) AS i,
                           LATERAL (SELECT upper(to_hex(ascii(substr(nv.input, i, 1)))) AS hex) AS h), ''),
          nv.input_code_points,
          nv.id || ' ' || nv.title || ': the input decodes to its recorded code points')
  FROM nv ORDER BY nv.ord;

SELECT is(public.evidence_normalize_v1(nv.input), nv.expected,
          nv.id || ' ' || nv.title || ': output')
  FROM nv ORDER BY nv.ord;

SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(nv.input), 'UTF8')), 'hex'), nv.expected_sha256,
          nv.id || ' ' || nv.title || ': SHA-256 of the output')
  FROM nv ORDER BY nv.ord;

SELECT is(public.evidence_normalize_v1(public.evidence_normalize_v1(nv.input)), nv.second_pass,
          nv.id || ' ' || nv.title || ': a second pass differs, so each input is normalized once')
  FROM nv WHERE nv.second_pass IS NOT NULL ORDER BY nv.ord;

-- M. Matching vectors: lengths and offsets in characters --------------------

SELECT is(char_length(public.evidence_normalize_v1(mv.quote)), mv.normalized_quote_length,
          mv.id || ' ' || mv.title || ': normalized quote length in characters')
  FROM mv ORDER BY mv.ord;

SELECT is((SELECT coalesce(jsonb_agg(jsonb_build_array(i - 1, i - 1 + char_length(q.nq)) ORDER BY i), '[]'::jsonb)
             FROM (SELECT public.evidence_normalize_v1(mv.quote) AS nq,
                          public.evidence_normalize_v1(mv.snapshot) AS ns) AS q,
                  generate_series(1, greatest(char_length(q.ns) - char_length(q.nq) + 1, 0)) AS i
            WHERE char_length(q.nq) > 0 AND substr(q.ns, i, char_length(q.nq)) = q.nq),
          mv.expected_normalized,
          mv.id || ' ' || mv.title || ': every occurrence as 0-based character ranges of the normalized copy')
  FROM mv ORDER BY mv.ord;

-- L. The server's quote location (EVIDENCE-RECORDS-001A3) -------------------

SELECT is((SELECT l.status || ' ' || coalesce(l.match_count::text, '-') || ' ' || array_to_string(l.problems, ',')
             FROM public.evidence_locate_quote(ARRAY[mv.quote], mv.snapshot) AS l),
          mv.expected_kind || ' '
          || CASE WHEN mv.expected_kind IN ('invalid', 'too_many') THEN '-' ELSE jsonb_array_length(mv.expected_normalized)::text END || ' '
          || (SELECT coalesce(string_agg(p.x, ',' ORDER BY p.o), '')
                FROM jsonb_array_elements_text(mv.invalid_problems) WITH ORDINALITY AS p(x, o)),
          mv.id || ' ' || mv.title || ': evidence_locate_quote gives the kind, count and problems')
  FROM mv ORDER BY mv.ord;

SELECT is((SELECT coalesce(jsonb_agg(jsonb_build_array(u.s, u.s + l.normalized_length) ORDER BY u.i), '[]'::jsonb)
             FROM public.evidence_locate_quote(ARRAY[mv.quote], mv.snapshot) AS l,
                  unnest(l.starts) WITH ORDINALITY AS u(s, i)),
          CASE WHEN mv.expected_kind IN ('invalid', 'too_many') THEN '[]'::jsonb ELSE mv.expected_normalized END,
          mv.id || ' ' || mv.title || ': evidence_locate_quote gives every occurrence at the oracle''s offsets'
          || CASE mv.expected_kind WHEN 'invalid' THEN ' (none: an invalid quote is not located)'
                                   WHEN 'too_many' THEN ' (none: too many to enumerate)' ELSE '' END)
  FROM mv ORDER BY mv.ord;

SELECT * FROM finish();
ROLLBACK;
"""


def main():
    fixture_path, out_path = sys.argv[1], sys.argv[2]
    with open(fixture_path, encoding="ascii") as f:
        fixture = f.read()
    sql = HEADER + fixture + FOOTER
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(sql)
    print("wrote", out_path, len(sql), "bytes")


main()
