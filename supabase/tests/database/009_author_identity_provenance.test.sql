-- AUTHOR-IDENTITY-PROVENANCE-001B suite 009: structured authorship provenance.
--
-- This suite owns the database contract for papers.author_provenance — the
-- column, its fail-closed CHECK, the safe_bulk_insert_papers input handling
-- that writes it, and the merge_exact_duplicates rule that keeps it coherent
-- with authors. Suite 003 keeps ownership of the least-privilege EXECUTE
-- surface across the whole SECURITY DEFINER inventory and suite 005 owns the
-- general successful-merge contract; only the invariants a careless change to
-- THESE two functions could break are re-asserted here, so a replacement that
-- widened either could not pass this suite either.
--
-- Why the column exists:
--   papers.authors stores one author *mention* as a source wrote it. What the
--   source actually stated about that mention — personal vs collective
--   authorship, the given/family split, affiliations, an ORCID — is lost the
--   moment it is flattened to a display string, and no later parse of
--   "Ricardo Soto-Rifo" can recover it. Splitting that string is fabrication,
--   not recovery.
--
-- What it is NOT:
--   an identity model. Provenance records a source's statement. It does not
--   assert that two mentions are the same researcher, and a matching ORCID in
--   two rows does not assert it either. This suite therefore also proves the
--   *absence* of any person/alias/link table and of any global identifier
--   uniqueness — 001B must leave that design open, not pre-empt it.
--
-- Proves:
--   * the column's shape: jsonb, nullable, no default, and a validated CHECK;
--   * no historical backfill, and legacy NULL rows stay fully usable;
--   * fail-closed direct writes across every malformed shape: non-array,
--     scalar, empty array, non-object entry, unknown kind, missing/blank
--     source, missing/blank source_name, wrong affiliations type, non-string
--     affiliation, wrong identifiers type, identifier missing scheme or value,
--     non-boolean orcid_authenticated, non-canonical orcid, and — the
--     load-bearing one — a provenance length that differs from authors;
--   * that an ARRAY is never a legal spelling of a scalar member. SQL/JSON lax
--     mode unwraps an array before a filter evaluates, so a probe written as
--     `$[*].field ? (...)` silently tests the element instead of the array;
--     every optional scalar, the ORCID, the authenticated flag, an affiliation,
--     an identifier and a whole provenance entry are pinned against that;
--   * safe_bulk_insert_papers canonicalization: a valid aligned array is
--     stored intact; a missing key, JSON null and empty array all become SQL
--     NULL; a malformed value yields a per-row 'error' while the rest of the
--     batch still inserts;
--   * provenance is never manufactured: a payload carrying only authors stores
--     NULL, never a parse of those strings;
--   * both functions' unchanged security contract — one overload, signature,
--     SECURITY DEFINER, bounded search_path, owner, least-privilege EXECUTE,
--     null-auth and cross-user rejection;
--   * merge_exact_duplicates coherence: authors and author_provenance always
--     come from ONE source row, never unioned, and a winning row with NULL
--     provenance never borrows a discard's.
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

CREATE FUNCTION pg_temp.claims_u1() RETURNS text LANGUAGE sql AS
$hlp$ SELECT '{"sub":"09000000-0000-0000-0000-000000000001","role":"authenticated"}'::text $hlp$;
CREATE FUNCTION pg_temp.claims_u2() RETURNS text LANGUAGE sql AS
$hlp$ SELECT '{"sub":"09000000-0000-0000-0000-000000000002","role":"authenticated"}'::text $hlp$;

-- Call safe_bulk_insert_papers as U1 and return its jsonb result.
CREATE FUNCTION pg_temp.bulk_insert_u1(p_papers jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $hlp$
DECLARE v_out jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.claims_u1(), true);
  SET LOCAL ROLE authenticated;
  SELECT public.safe_bulk_insert_papers(
    '09000000-0000-0000-0000-000000000001'::uuid, p_papers) INTO v_out;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_out;
END;
$hlp$;

-- Call merge_exact_duplicates as U1.
CREATE FUNCTION pg_temp.merge_u1(p_keep uuid, p_discards uuid[])
RETURNS void LANGUAGE plpgsql AS $hlp$
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.claims_u1(), true);
  SET LOCAL ROLE authenticated;
  PERFORM public.merge_exact_duplicates(p_keep, p_discards);
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
END;
$hlp$;

CREATE FUNCTION pg_temp.row_status(p_results jsonb, p_index int)
RETURNS text LANGUAGE sql AS
$hlp$ SELECT r->>'status' FROM jsonb_array_elements(p_results) r
      WHERE (r->>'index')::int = p_index $hlp$;

-- The stored provenance / authors of a paper inserted under a known title.
CREATE FUNCTION pg_temp.stored_prov(p_title text)
RETURNS jsonb LANGUAGE sql AS
$hlp$ SELECT author_provenance FROM public.papers WHERE title = p_title $hlp$;

CREATE FUNCTION pg_temp.stored_authors(p_title text)
RETURNS jsonb LANGUAGE sql AS
$hlp$ SELECT authors FROM public.papers WHERE title = p_title $hlp$;

-- One fully populated provenance entry, as the PubMed path emits it.
CREATE FUNCTION pg_temp.entry_full() RETURNS jsonb LANGUAGE sql AS $hlp$
  SELECT '{"source":"pubmed_api","source_field":"Author","kind":"personal",
           "source_name":"Ricardo Soto-Rifo","given_name":"Ricardo",
           "family_name":"Soto-Rifo","initials":"R","suffix":null,
           "collective_name":null,"affiliations":["Universidad de Chile"],
           "identifiers":[{"scheme":"ORCID","value":"0000-0003-0945-2970"}],
           "orcid":"0000-0003-0945-2970","orcid_authenticated":null}'::jsonb
$hlp$;

-- The minimal honest entry an unstructured source emits.
CREATE FUNCTION pg_temp.entry_unknown(p_name text) RETURNS jsonb LANGUAGE sql AS $hlp$
  SELECT jsonb_build_object(
    'source','manual','source_field','authors','kind','unknown',
    'source_name',p_name,'given_name',NULL,'family_name',NULL,'initials',NULL,
    'suffix',NULL,'collective_name',NULL,'affiliations','[]'::jsonb,
    'identifiers','[]'::jsonb,'orcid',NULL,'orcid_authenticated',NULL)
$hlp$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('09000000-0000-0000-0000-000000000001','authorprov-U1@paperlume.test'),
  ('09000000-0000-0000-0000-000000000002','authorprov-U2@paperlume.test');

-- A row written the way every pre-migration row was: authors only, the new
-- column never mentioned. It must read as NULL and stay fully usable.
INSERT INTO public.papers (id, user_id, title, authors, insert_order, created_at)
VALUES ('09000000-0000-0000-0000-0000000000a0','09000000-0000-0000-0000-000000000001',
        'Legacy row', '["S M Phillips"]'::jsonb, 301, '2026-01-01T00:00:00Z');

SELECT plan(111);

-- ══ 1. Column shape ═════════════════════════════════════════════════════════

SELECT has_column('public', 'papers', 'author_provenance',
  'column: papers.author_provenance exists');
SELECT col_type_is('public', 'papers', 'author_provenance', 'jsonb',
  'column: stored as jsonb, matching the table''s structured-metadata convention');
SELECT col_is_null('public', 'papers', 'author_provenance',
  'column: nullable — NULL is the representation of "no structured provenance"');
SELECT col_hasnt_default('public', 'papers', 'author_provenance',
  'column: no default, so an unmentioned column is SQL NULL');

SELECT ok(
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.papers'::regclass
            AND conname = 'papers_author_provenance_shape_check'
            AND contype = 'c' AND convalidated),
  'column: the fail-closed CHECK exists and is validated');

-- ══ 2. No identity model was introduced ═════════════════════════════════════
-- 001B stores provenance. Resolving mentions to people is a later decision, and
-- a table or a global uniqueness rule created now would pre-empt it.

SELECT ok(
  NOT EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public'
                AND table_name IN ('authors','people','person','author_identities',
                                   'author_aliases','author_identity_links')),
  'identity: 001B creates no author/person/alias/link table');

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.papers'::regclass
      AND i.indisunique
      AND pg_get_indexdef(i.indexrelid) LIKE '%author_provenance%'),
  'identity: no uniqueness is imposed on provenance, so no ORCID is global');

-- ══ 3. Existing rows are untouched ══════════════════════════════════════════

SELECT is(pg_temp.stored_prov('Legacy row'), NULL::jsonb,
  'legacy: a row written without the column reads NULL, not an empty array');

SELECT is(pg_temp.stored_authors('Legacy row'), '["S M Phillips"]'::jsonb,
  'legacy: authors is preserved and remains the display representation');

SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE author_provenance IS NOT NULL),
  0,
  'legacy: the migration backfilled no historical row');

-- ══ 4. Fail-closed direct writes ════════════════════════════════════════════
-- The column is the last line of defence: even a writer that bypasses the RPC
-- cannot store provenance that is not a complete, aligned, well-formed array.
-- 'Legacy row' has exactly one author, so a one-entry array is the aligned size.

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance = '{"source":"x"}'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a JSON object instead of an array is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance = '7'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a bare JSON number is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance = '"nope"'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a bare JSON string is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance = '[]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an empty array is rejected — NULL already means absence');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance = '[5]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an array holding a non-object entry is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"editor","source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an unknown kind is rejected');

-- kind is REQUIRED, not merely constrained when present, and it must be a
-- string. Independent review flagged this predicate; the cases below are the
-- ones a violation probe written as a bare comparison lets through, because a
-- SQL/JSON filter selects an item only when its predicate is TRUE:
--   * a non-string scalar compares *unknown* against "personal", so negating it
--     never yields TRUE and the probe reports no violation;
--   * lax mode unwraps an array before comparing, so ["personal"] compares TRUE
--     and an array spelling passes as though it were the scalar.
-- Each of these stores an entry whose kind cannot be read as one of the three
-- known values, which is exactly what the column contract forbids.

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an entry with NO kind key at all is rejected — kind is required');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":null,"source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a null kind is rejected — absence has no legal spelling');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":42,"source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a numeric kind is rejected — an incomparable type is a violation, not an unknown');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":true,"source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a boolean kind is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":["personal"],"source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an array-wrapped kind is rejected even though it wraps a legal value');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":["personal","editor"],"source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an array kind is rejected even when one member is legal');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":{"k":"personal"},"source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an object kind is rejected');

-- The three legal values still store, so the tightened guard did not overshoot.
SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '00000', 'check: kind "personal" is still accepted');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"collective","source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '00000', 'check: kind "collective" is still accepted');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '00000', 'check: kind "unknown" is still accepted');

-- …and the row is put back the way section 3 found it, so later sections that
-- read 'Legacy row' still see the untouched pre-migration state.
UPDATE public.papers SET author_provenance = NULL WHERE title = 'Legacy row';

-- ── Optional scalar members: an array is never a legal spelling ──────────────
-- Second independent review. Every predicate here used to be written as
-- `$[*].field ? (@.type() != ...)`, which selects the member and then filters
-- it — and in lax mode a filter unwraps an array operand BEFORE evaluating, so
-- each of these was tested as its own element and stored. The column is the
-- last line of defence for a writer that bypasses the RPC, and TypeScript
-- promises `string | null`, so an array here is a persisted contract violation.

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","source_field":["Author"],"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: source_field ["Author"] is rejected — an array is not a string');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","given_name":["Ada"],"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: given_name ["Ada"] is rejected — an array is not a string');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","family_name":["Lovelace"],"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: family_name ["Lovelace"] is rejected — an array is not a string');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","initials":["AL"],"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: initials ["AL"] is rejected — an array is not a string');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","suffix":["Jr."],"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: suffix ["Jr."] is rejected — an array is not a string');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"collective","source_name":"G","collective_name":["Study Group"],"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: collective_name ["Study Group"] is rejected — an array is not a string');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","orcid":["0000-0002-1825-0097"],"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: orcid ["0000-0002-1825-0097"] is rejected — an array never passes as canonical');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","orcid_authenticated":[true],"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: orcid_authenticated [true] is rejected — an array is not a boolean');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","orcid_authenticated":[false],"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: orcid_authenticated [false] is rejected too — the wrapper is what fails, not the value');

-- Non-array wrong types on the same members, so the repaired predicates are
-- pinned for every illegal shape rather than only the array one.
SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","given_name":{"first":"Ada"},"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an object given_name is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","given_name":42,"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a numeric given_name is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","orcid":123,"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a numeric orcid is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","orcid":{"value":"0000-0002-1825-0097"},"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an object orcid is rejected even when it wraps a canonical value');

-- The same unwrapping hid three more shapes that are not "optional scalars":
-- an affiliation, an identifier, and a whole provenance ENTRY could each be
-- array-wrapped and pass the rule meant to type them.
SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","affiliations":[["Nested"]],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a nested-array affiliation is rejected — elements are typed, not unwrapped');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"personal","source_name":"A","affiliations":[],"identifiers":[[{"scheme":"ORCID","value":"0000-0002-1825-0097"}]]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a nested-array identifier is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[[{"source":"csv","kind":"personal","source_name":"A","affiliations":[],"identifiers":[]}]]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an array-wrapped provenance ENTRY is rejected — entries are objects, not arrays');

-- Positive control: the repaired predicates did not overshoot. One complete
-- entry exercising every optional scalar in its legal form, stored and read
-- back byte-for-byte.
SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"pubmed_api","source_field":"Author","kind":"personal","source_name":"Ada Lovelace","given_name":"Ada","family_name":"Lovelace","initials":"AL","suffix":"Jr.","collective_name":null,"affiliations":["Analytical Engine Group"],"identifiers":[{"scheme":"ORCID","value":"0000-0002-1825-0097"}],"orcid":"0000-0002-1825-0097","orcid_authenticated":true}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '00000', 'check: a complete entry with every optional scalar in scalar form still stores');

SELECT is(pg_temp.stored_prov('Legacy row') -> 0 ->> 'orcid', '0000-0002-1825-0097',
  'check: the stored canonical ORCID reads back as a string, not an array');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"A","source_field":null,"given_name":null,"family_name":null,"initials":null,"suffix":null,"collective_name":null,"orcid":null,"orcid_authenticated":null,"affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '00000', 'check: every optional member explicitly null is still accepted');

UPDATE public.papers SET author_provenance = NULL WHERE title = 'Legacy row';

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"kind":"unknown","source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a missing source is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"   ","kind":"unknown","source_name":"A","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a blank source is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a missing source_name is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"  ","affiliations":[],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a blank source_name is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"A","affiliations":"Uni","identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: affiliations must be an array, not a string');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"A","affiliations":[1],"identifiers":[]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a non-string affiliation is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"A","affiliations":[],"identifiers":{}}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: identifiers must be an array, not an object');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"A","affiliations":[],"identifiers":[{"value":"v"}]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an identifier missing its scheme is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"A","affiliations":[],"identifiers":[{"scheme":"ORCID"}]}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an identifier missing its value is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"A","affiliations":[],"identifiers":[],"orcid_authenticated":"true"}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: orcid_authenticated must be a boolean, never the string "true"');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"A","affiliations":[],"identifiers":[],"orcid":"0000000218250097"}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: an unhyphenated 16-digit run is not a canonical ORCID');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"A","affiliations":[],"identifiers":[],"orcid":"https://orcid.org/0000-0002-1825-0097"}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a URI-form ORCID is rejected — storage keeps one spelling');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  $q$UPDATE public.papers SET author_provenance =
       '[{"source":"csv","kind":"unknown","source_name":"A","affiliations":[],"identifiers":[],"orcid":"0000-0002-1694-233x"}]'::jsonb
     WHERE title = 'Legacy row'$q$),
  '23514', 'check: a lowercase x check character is rejected');

-- The load-bearing rule. Once the indexes stop lining up, every entry describes
-- the WRONG mention — an ORCID attached to someone else's name.
SELECT is(pg_temp.errcode_as('postgres', NULL,
  format($q$UPDATE public.papers SET author_provenance = %L::jsonb
            WHERE title = 'Legacy row'$q$,
         jsonb_build_array(pg_temp.entry_unknown('A'), pg_temp.entry_unknown('B')))),
  '23514', 'check: provenance longer than authors is rejected');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  format($q$UPDATE public.papers SET authors = '["A","B"]'::jsonb,
                                     author_provenance = %L::jsonb
            WHERE title = 'Legacy row'$q$,
         jsonb_build_array(pg_temp.entry_unknown('A')))),
  '23514', 'check: provenance shorter than authors is rejected');

-- ...and the aligned equivalents are accepted, so the rule is a length rule and
-- not a blanket refusal.
SELECT is(pg_temp.errcode_as('postgres', NULL,
  format($q$UPDATE public.papers SET author_provenance = %L::jsonb
            WHERE title = 'Legacy row'$q$,
         jsonb_build_array(pg_temp.entry_unknown('S M Phillips')))),
  '00000', 'check: a correctly aligned one-entry array is accepted');

SELECT is(pg_temp.errcode_as('postgres', NULL,
  format($q$UPDATE public.papers SET author_provenance = %L::jsonb
            WHERE title = 'Legacy row'$q$, pg_temp.entry_full()::text)),
  '23514', 'check: a bare entry object (not wrapped in an array) is rejected');

-- A consequence of the length rule worth naming: because a non-null value must
-- be non-empty AND the same length as authors, a paper with no authors can only
-- ever have NULL provenance. "Provenance describing nobody" is unrepresentable.
SELECT is(pg_temp.errcode_as('postgres', NULL,
  format($q$UPDATE public.papers SET authors = '[]'::jsonb,
                                     author_provenance = %L::jsonb
            WHERE title = 'Legacy row'$q$,
         jsonb_build_array(pg_temp.entry_full()))),
  '23514', 'check: an empty authors array forces NULL provenance');

-- Restore the legacy row to its NULL state for the remaining sections.
UPDATE public.papers SET author_provenance = NULL WHERE title = 'Legacy row';

-- ══ 5. safe_bulk_insert_papers input handling ═══════════════════════════════

-- A valid aligned array survives intact, order and structure included.
SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk valid',
    'authors', '["Ricardo Soto-Rifo"]'::jsonb,
    'author_provenance', jsonb_build_array(pg_temp.entry_full())))), 0),
  'inserted', 'bulk: a valid aligned provenance array inserts');

SELECT is(pg_temp.stored_prov('Bulk valid'),
  jsonb_build_array(pg_temp.entry_full()),
  'bulk: the stored value is byte-for-byte what the caller supplied');

SELECT is(
  pg_temp.stored_prov('Bulk valid') -> 0 ->> 'orcid',
  '0000-0003-0945-2970',
  'bulk: the canonical ORCID is preserved as provenance, not as an identity');

-- Absence, in each of its three incoming spellings, is one stored state.
SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk omitted', 'authors','["A B"]'::jsonb))), 0),
  'inserted', 'bulk: an older caller that omits the key still inserts');

SELECT is(pg_temp.stored_prov('Bulk omitted'), NULL::jsonb,
  'bulk: an omitted key stores SQL NULL');

SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk json null', 'authors','["A B"]'::jsonb,
    'author_provenance', NULL))), 0),
  'inserted', 'bulk: an explicit JSON null inserts');

SELECT is(pg_temp.stored_prov('Bulk json null'), NULL::jsonb,
  'bulk: JSON null is normalized to SQL NULL, never stored ambiguously');

SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk empty array', 'authors','["A B"]'::jsonb,
    'author_provenance', '[]'::jsonb))), 0),
  'inserted', 'bulk: an empty array inserts');

SELECT is(pg_temp.stored_prov('Bulk empty array'), NULL::jsonb,
  'bulk: an empty array collapses to SQL NULL');

-- Provenance is never manufactured from the author strings.
SELECT is(pg_temp.stored_prov('Bulk omitted'), NULL::jsonb,
  'bulk: authors alone never produce provenance — no name is parsed');

-- Malformed input fails its own row and only its own row.
SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk object prov', 'authors','["A B"]'::jsonb,
    'author_provenance', '{"source":"x"}'::jsonb))), 0),
  'error', 'bulk: a JSON object for provenance fails the row');

SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk bad kind', 'authors','["A B"]'::jsonb,
    'author_provenance','[{"source":"csv","kind":"editor","source_name":"A B","affiliations":[],"identifiers":[]}]'::jsonb))), 0),
  'error', 'bulk: an unknown kind fails the row via the column CHECK');

-- The same required-kind rule reached through the RPC, which is the path the
-- application actually writes on. The arrays here are correctly ALIGNED, so
-- nothing but the kind guard can fail these rows.
SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk no kind', 'authors','["A B"]'::jsonb,
    'author_provenance','[{"source":"csv","source_name":"A B","affiliations":[],"identifiers":[]}]'::jsonb))), 0),
  'error', 'bulk: an entry with no kind key fails the row — kind is required, not optional');

SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk array kind', 'authors','["A B"]'::jsonb,
    'author_provenance','[{"source":"csv","kind":["personal"],"source_name":"A B","affiliations":[],"identifiers":[]}]'::jsonb))), 0),
  'error', 'bulk: an array-wrapped kind fails the row despite wrapping a legal value');

SELECT is(
  (SELECT count(*)::int FROM public.papers
   WHERE title IN ('Bulk no kind','Bulk array kind')),
  0, 'bulk: no row is persisted with an unreadable kind');

-- The same array-shaped scalars through the RPC, which is the path the
-- application writes on. The RPC keeps no validation of its own — the column
-- CHECK is the single deep-shape authority — so these prove the authority is
-- actually reached and that a malformed row is failed, not stored.
SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk array given_name', 'authors','["Ada Lovelace"]'::jsonb,
    'author_provenance','[{"source":"csv","kind":"personal","source_name":"Ada Lovelace","given_name":["Ada"],"affiliations":[],"identifiers":[]}]'::jsonb))), 0),
  'error', 'bulk: an array given_name fails the row');

SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk array orcid_auth', 'authors','["Ada Lovelace"]'::jsonb,
    'author_provenance','[{"source":"csv","kind":"personal","source_name":"Ada Lovelace","orcid_authenticated":[true],"affiliations":[],"identifiers":[]}]'::jsonb))), 0),
  'error', 'bulk: an array orcid_authenticated fails the row');

SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk array orcid', 'authors','["Ada Lovelace"]'::jsonb,
    'author_provenance','[{"source":"csv","kind":"personal","source_name":"Ada Lovelace","orcid":["0000-0002-1825-0097"],"affiliations":[],"identifiers":[]}]'::jsonb))), 0),
  'error', 'bulk: an array orcid fails the row — it never passes as canonical');

SELECT is(
  (SELECT count(*)::int FROM public.papers
   WHERE title IN ('Bulk array given_name','Bulk array orcid_auth','Bulk array orcid')),
  0, 'bulk: no row is persisted with an array-shaped provenance scalar');

SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(jsonb_build_object(
    'title','Bulk misaligned', 'authors','["A B","C D"]'::jsonb,
    'author_provenance', jsonb_build_array(pg_temp.entry_unknown('A B'))))), 0),
  'error', 'bulk: a provenance/authors length mismatch fails the row');

SELECT is(
  (SELECT count(*)::int FROM public.papers
   WHERE title IN ('Bulk object prov','Bulk bad kind','Bulk misaligned')),
  0, 'bulk: no row is stored with corrupted or misaligned provenance');

-- A malformed row does not take the batch down with it.
SELECT is(
  pg_temp.row_status(pg_temp.bulk_insert_u1(jsonb_build_array(
    jsonb_build_object('title','Batch bad','authors','["A B"]'::jsonb,
      'author_provenance','[7]'::jsonb),
    jsonb_build_object('title','Batch good','authors','["C D"]'::jsonb,
      'author_provenance', jsonb_build_array(pg_temp.entry_unknown('C D'))))), 1),
  'inserted', 'bulk: a later valid row still inserts after a malformed one');

SELECT is(pg_temp.stored_prov('Batch good'),
  jsonb_build_array(pg_temp.entry_unknown('C D')),
  'bulk: the surviving row keeps its own provenance intact');

-- ══ 6. safe_bulk_insert_papers security contract is unchanged ═══════════════

SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='safe_bulk_insert_papers'),
  1, 'security: exactly one safe_bulk_insert_papers overload');

SELECT ok(
  (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=public']
          AND pg_get_userbyid(p.proowner)='postgres'
          AND pg_get_function_result(p.oid)='jsonb'
          AND pg_get_function_identity_arguments(p.oid)='p_user_id uuid, p_papers jsonb'
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='safe_bulk_insert_papers'),
  'security: safe_bulk_insert_papers keeps SECURITY DEFINER, search_path, owner, signature');

SELECT ok(
  NOT has_function_privilege('anon','public.safe_bulk_insert_papers(uuid,jsonb)','EXECUTE')
  AND NOT has_function_privilege('service_role','public.safe_bulk_insert_papers(uuid,jsonb)','EXECUTE')
  AND has_function_privilege('authenticated','public.safe_bulk_insert_papers(uuid,jsonb)','EXECUTE'),
  'security: safe_bulk_insert_papers EXECUTE surface is unwidened');

SELECT is(pg_temp.errcode_as('authenticated', NULL,
  $q$SELECT public.safe_bulk_insert_papers(
       '09000000-0000-0000-0000-000000000001'::uuid, '[]'::jsonb)$q$),
  'P0001', 'security: a null-auth caller is still rejected');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u2(),
  $q$SELECT public.safe_bulk_insert_papers(
       '09000000-0000-0000-0000-000000000001'::uuid,
       '[{"title":"Cross user","authors":["A B"]}]'::jsonb)$q$),
  'P0001', 'security: inserting for another user is still rejected');

SELECT is((SELECT count(*)::int FROM public.papers WHERE title='Cross user'), 0,
  'security: the rejected cross-user call was side-effect free');

-- ══ 7. merge_exact_duplicates — authors and provenance are one pair ═════════
-- Fixtures. In each group the keep row is 'K…' and the discards 'D…'; created_at
-- fixes the (created_at, id) ordering the function already uses.

-- Group A: keep wins authors AND has provenance.
INSERT INTO public.papers (id, user_id, title, authors, author_provenance, insert_order, created_at)
VALUES
 ('09000000-0000-0000-0000-0000000000b1','09000000-0000-0000-0000-000000000001',
  'KA', '["Ricardo Soto-Rifo"]'::jsonb, jsonb_build_array(pg_temp.entry_full()), 311, '2026-02-01T00:00:00Z'),
 ('09000000-0000-0000-0000-0000000000b2','09000000-0000-0000-0000-000000000001',
  'DA', '["Other Person"]'::jsonb, jsonb_build_array(pg_temp.entry_unknown('Other Person')), 312, '2026-02-02T00:00:00Z');

-- Group B: keep wins authors but has NULL provenance; the discard has some.
INSERT INTO public.papers (id, user_id, title, authors, author_provenance, insert_order, created_at)
VALUES
 ('09000000-0000-0000-0000-0000000000c1','09000000-0000-0000-0000-000000000001',
  'KB', '["Legacy Name"]'::jsonb, NULL, 321, '2026-03-01T00:00:00Z'),
 ('09000000-0000-0000-0000-0000000000c2','09000000-0000-0000-0000-000000000001',
  'DB', '["Ricardo Soto-Rifo"]'::jsonb, jsonb_build_array(pg_temp.entry_full()), 322, '2026-03-02T00:00:00Z');

-- Group C: keep has an EMPTY authors array, so the existing rule takes the
-- earliest discard's authors — and must take that same discard's provenance.
INSERT INTO public.papers (id, user_id, title, authors, author_provenance, insert_order, created_at)
VALUES
 ('09000000-0000-0000-0000-0000000000d1','09000000-0000-0000-0000-000000000001',
  'KC', '[]'::jsonb, NULL, 331, '2026-04-01T00:00:00Z'),
 ('09000000-0000-0000-0000-0000000000d2','09000000-0000-0000-0000-000000000001',
  'DC1', '["Ricardo Soto-Rifo"]'::jsonb, jsonb_build_array(pg_temp.entry_full()), 332, '2026-04-02T00:00:00Z'),
 ('09000000-0000-0000-0000-0000000000d3','09000000-0000-0000-0000-000000000001',
  'DC2', '["Second Author","Third Author"]'::jsonb,
  jsonb_build_array(pg_temp.entry_unknown('Second Author'), pg_temp.entry_unknown('Third Author')),
  333, '2026-04-03T00:00:00Z');

-- Group D: keep has empty authors; the EARLIEST discard has authors but NULL
-- provenance, while a LATER discard has rich provenance. The winning row is the
-- earliest discard, so the result must take its authors AND its NULL — never
-- reaching past it for the other discard's provenance, and never unioning them.
INSERT INTO public.papers (id, user_id, title, authors, author_provenance, insert_order, created_at)
VALUES
 ('09000000-0000-0000-0000-0000000000e1','09000000-0000-0000-0000-000000000001',
  'KD', '[]'::jsonb, NULL, 341, '2026-05-01T00:00:00Z'),
 ('09000000-0000-0000-0000-0000000000e2','09000000-0000-0000-0000-000000000001',
  'DD1', '["Plain Name"]'::jsonb, NULL, 342, '2026-05-02T00:00:00Z'),
 ('09000000-0000-0000-0000-0000000000e3','09000000-0000-0000-0000-000000000001',
  'DD2', '["Ricardo Soto-Rifo"]'::jsonb, jsonb_build_array(pg_temp.entry_full()), 343, '2026-05-03T00:00:00Z');

SELECT lives_ok(
  $q$SELECT pg_temp.merge_u1('09000000-0000-0000-0000-0000000000b1'::uuid,
       ARRAY['09000000-0000-0000-0000-0000000000b2'::uuid])$q$,
  'merge A: a merge whose keep row wins authors succeeds');

SELECT is(pg_temp.stored_authors('KA'), '["Ricardo Soto-Rifo"]'::jsonb,
  'merge A: the keep row''s authors are preserved exactly');

SELECT is(pg_temp.stored_prov('KA'), jsonb_build_array(pg_temp.entry_full()),
  'merge A: provenance comes from the same row the authors did');

SELECT lives_ok(
  $q$SELECT pg_temp.merge_u1('09000000-0000-0000-0000-0000000000c1'::uuid,
       ARRAY['09000000-0000-0000-0000-0000000000c2'::uuid])$q$,
  'merge B: a merge whose keep row has NULL provenance succeeds');

SELECT is(pg_temp.stored_authors('KB'), '["Legacy Name"]'::jsonb,
  'merge B: the keep row''s authors still win');

SELECT is(pg_temp.stored_prov('KB'), NULL::jsonb,
  'merge B: a legacy keep row NEVER borrows a discard''s provenance');

SELECT lives_ok(
  $q$SELECT pg_temp.merge_u1('09000000-0000-0000-0000-0000000000d1'::uuid,
       ARRAY['09000000-0000-0000-0000-0000000000d2'::uuid,
             '09000000-0000-0000-0000-0000000000d3'::uuid])$q$,
  'merge C: a merge that adopts a discard''s authors succeeds');

SELECT is(pg_temp.stored_authors('KC'), '["Ricardo Soto-Rifo"]'::jsonb,
  'merge C: the earliest non-empty discard''s authors are adopted, as before');

SELECT is(pg_temp.stored_prov('KC'), jsonb_build_array(pg_temp.entry_full()),
  'merge C: provenance comes from THAT discard — not the other, not a union');

SELECT is(jsonb_array_length(pg_temp.stored_prov('KC')),
          jsonb_array_length(pg_temp.stored_authors('KC')),
  'merge C: the merged pair is still index-aligned');

SELECT lives_ok(
  $q$SELECT pg_temp.merge_u1('09000000-0000-0000-0000-0000000000e1'::uuid,
       ARRAY['09000000-0000-0000-0000-0000000000e2'::uuid,
             '09000000-0000-0000-0000-0000000000e3'::uuid])$q$,
  'merge D: a multi-discard merge whose winning row has NULL provenance succeeds');

SELECT is(pg_temp.stored_authors('KD'), '["Plain Name"]'::jsonb,
  'merge D: the earliest non-empty discard''s authors are adopted');

SELECT is(pg_temp.stored_prov('KD'), NULL::jsonb,
  'merge D: the later discard''s provenance is NOT borrowed and NOT unioned');

-- ══ 8. merge_exact_duplicates security contract is unchanged ════════════════

SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='merge_exact_duplicates'),
  1, 'security: exactly one merge_exact_duplicates overload');

SELECT ok(
  (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=public']
          AND pg_get_userbyid(p.proowner)='postgres'
          AND pg_get_function_result(p.oid)='void'
          AND pg_get_function_identity_arguments(p.oid)='p_keep_id uuid, p_discard_ids uuid[]'
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='merge_exact_duplicates'),
  'security: merge_exact_duplicates keeps SECURITY DEFINER, search_path, owner, signature');

SELECT ok(
  NOT has_function_privilege('anon','public.merge_exact_duplicates(uuid,uuid[])','EXECUTE')
  AND NOT has_function_privilege('service_role','public.merge_exact_duplicates(uuid,uuid[])','EXECUTE')
  AND has_function_privilege('authenticated','public.merge_exact_duplicates(uuid,uuid[])','EXECUTE'),
  'security: merge_exact_duplicates EXECUTE surface is unwidened');

-- A foreign-ownership request must fail before any mutation, provenance
-- included.
INSERT INTO public.papers (id, user_id, title, authors, author_provenance, insert_order, created_at)
VALUES ('09000000-0000-0000-0000-0000000000f1','09000000-0000-0000-0000-000000000002',
        'Foreign paper', '["Foreign Author"]'::jsonb,
        jsonb_build_array(pg_temp.entry_unknown('Foreign Author')), 351, '2026-06-01T00:00:00Z');

SELECT isnt(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_exact_duplicates(
       '09000000-0000-0000-0000-0000000000a0'::uuid,
       ARRAY['09000000-0000-0000-0000-0000000000f1'::uuid])$q$),
  '00000', 'security: merging a paper owned by another user is rejected');

SELECT is(pg_temp.stored_prov('Foreign paper'),
  jsonb_build_array(pg_temp.entry_unknown('Foreign Author')),
  'security: the rejected merge left the foreign row''s provenance untouched');

SELECT is(pg_temp.stored_prov('Legacy row'), NULL::jsonb,
  'security: the rejected merge left the caller''s own row untouched too');

SELECT * FROM finish();
ROLLBACK;
