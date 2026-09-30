-- SEARCH-MATCH-ATTRIBUTION-CROSS-FIELD-001 suite 027: search_papers' six
-- matched_* flags name every field that contributed a query term — contributing-
-- field attribution (C58).
--
-- Migration 20260930161651_fix_search_match_cross_field_attribution replaced
-- only the attribution inside search_papers. Membership and rank still use the
-- &-joined prefix query over the combined search_vector, so a row must hold
-- every effective query term somewhere in its six fields. Each flag now tests
-- its field's own vector against the |-joined query built from the same
-- tokens, so it is true iff that field contains at least one effective query
-- term. This suite owns that contract:
--
--   1. posture — one overload, owner, SECURITY INVOKER, VOLATILE, plpgsql,
--      search_path, result, arguments, the reviewed body digest, the exact ACL
--      and the effective EXECUTE of PUBLIC / anon / authenticated /
--      service_role; the body keeps the previous body's membership and rank
--      text verbatim, the six flags test v_ts_any, and the two stale comments
--      are gone;
--   2. the reference — the reviewed PREVIOUS body (md5 d4a5f3af…, whole-query
--      flags), created in pg_temp inside this transaction, is the "before"
--      every later section compares against;
--   3. cases A–G — terms split over fields now flag exactly their contributing
--      fields, where they used to flag nothing; a whole query in one field and
--      a single term flag exactly what they flagged before; a field holding
--      the whole query no longer hides the other contributing fields (G) —
--      intentional, not a regression to whole-query-only attribution;
--   4. query semantics — prefix, stemming, case, stopwords (they never flag a
--      field), repeated tokens, stripped operators, numbers, Unicode, an
--      apostrophe, a hyphen and a single-letter prefix token;
--   5. property — over a deterministic 240-paper corpus and 110 queries: rows
--      and ranks identical to the previous body, every previous flag kept,
--      single-effective-term flags unchanged, every returned row flagged, and
--      LIMIT/OFFSET unchanged;
--   6. KNOWN LIMITATION, characterized — a punctuation-joined token that
--      matches only across the seam between two fields still returns the row
--      (membership unchanged) with no flag. Pinned so a change to it is a
--      deliberate decision; it is NOT an accepted general zero-flag behaviour;
--   7. security — anon and service_role refused at the function ACL; the
--      identity guard; RLS isolation (attribution never describes another
--      account's row); RLS live inside the new body.
--
-- Deterministic UUIDs and corpus (md5-derived, no random()); explicit
-- fixtures; no TODO/SKIP; no remote calls; no Production data; no real
-- credentials. pgTAP is created inside the transaction and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;
-- A stopword-only query makes to_tsquery raise a NOTICE; keep the TAP stream clean.
SET LOCAL client_min_messages = warning;

-- ── The reference: the reviewed previous body ───────────────────────────────
-- Byte for byte the body 20260802025704 created and C49 made SECURITY INVOKER
-- (md5 asserted in section 2), with the same attributes. It flags a field only
-- when that field alone satisfies the whole query.
CREATE FUNCTION pg_temp.search_papers_whole_query(p_user_id uuid, p_query text, p_limit integer DEFAULT 1000, p_offset integer DEFAULT 0)
 RETURNS TABLE(paper_id uuid, rank real, matched_title boolean, matched_abstract boolean, matched_authors boolean, matched_journal boolean, matched_notes boolean, matched_keywords boolean)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ts_query_text TEXT;
  v_ts_query      tsquery;
BEGIN
  -- Ownership guard: defense-in-depth on top of RLS. SECURITY DEFINER
  -- bypasses table-level RLS, so we must verify the caller owns the
  -- requested user_id ourselves.
  IF p_user_id IS NULL
     OR auth.uid() IS NULL
     OR p_user_id <> auth.uid()
  THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  -- Sanitize + tokenize identically to migration 20260417030000:
  -- strip the ten tsquery operator/control characters, whitespace-split,
  -- append :* to each non-empty token, &-join. Unicode passes through.
  SELECT string_agg(tok || ':*', ' & ')
    INTO v_ts_query_text
    FROM (
      SELECT token AS tok
      FROM regexp_split_to_table(
        regexp_replace(
          COALESCE(p_query, ''),
          '[&|!():*<>''"\\]',
          ' ',
          'g'
        ),
        '\s+'
      ) AS t(token)
      WHERE length(token) > 0
    ) s;

  -- Guard: empty / whitespace-only / all-blacklisted input → zero rows.
  IF v_ts_query_text IS NULL OR v_ts_query_text = '' THEN
    RETURN;
  END IF;

  v_ts_query := to_tsquery('english', v_ts_query_text);

  RETURN QUERY
  SELECT
    p.id AS paper_id,
    ts_rank(p.search_vector, v_ts_query) AS rank,
    -- Per-field attribution: each field's own tsvector tested against the
    -- same prefix-aware tsquery. If `search_vector @@ tsq` is true (WHERE
    -- clause), at least one of these will also be true (search_vector is
    -- the union of these per-field weighted tsvectors).
    to_tsvector('english', coalesce(p.title, ''))            @@ v_ts_query AS matched_title,
    to_tsvector('english', coalesce(p.abstract, ''))         @@ v_ts_query AS matched_abstract,
    to_tsvector('english', coalesce(p.authors::text, ''))    @@ v_ts_query AS matched_authors,
    to_tsvector('english', coalesce(p.journal, ''))          @@ v_ts_query AS matched_journal,
    to_tsvector('english', coalesce(p.notes, ''))            @@ v_ts_query AS matched_notes,
    to_tsvector('english', coalesce(p.keywords::text, ''))   @@ v_ts_query AS matched_keywords
  FROM papers p
  WHERE p.user_id = p_user_id
    AND p.search_vector @@ v_ts_query
  ORDER BY rank DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;
GRANT EXECUTE ON FUNCTION pg_temp.search_papers_whole_query(uuid,text,integer,integer) TO authenticated;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Run p_sql as p_role with the given JWT claims; '<SQLSTATE> <message>'
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

CREATE FUNCTION pg_temp.claims(p_user uuid) RETURNS text LANGUAGE sql AS
  $$ SELECT json_build_object('sub', p_user, 'role', 'authenticated')::text $$;

-- One search exactly as the browser runs it — role authenticated, JWT sub =
-- p_user — through the migrated function ('new') or the reference ('old').
CREATE FUNCTION pg_temp.run(p_impl text, p_user uuid, p_query text, p_limit integer DEFAULT 1000, p_offset integer DEFAULT 0)
RETURNS TABLE(paper_id uuid, rank real, t boolean, ab boolean, au boolean, j boolean, n boolean, k boolean)
LANGUAGE plpgsql AS $hlp$
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.claims(p_user), true);
  SET LOCAL ROLE authenticated;
  IF p_impl = 'new' THEN
    RETURN QUERY SELECT s.* FROM public.search_papers(p_user, p_query, p_limit, p_offset) s;
  ELSIF p_impl = 'old' THEN
    RETURN QUERY SELECT s.* FROM pg_temp.search_papers_whole_query(p_user, p_query, p_limit, p_offset) s;
  ELSE
    RAISE EXCEPTION 'unknown implementation %', p_impl;
  END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
END;
$hlp$;

-- The flags as PaperList labels them, in MATCH_FIELD_ORDER.
CREATE FUNCTION pg_temp.labels(t boolean, ab boolean, au boolean, j boolean, n boolean, k boolean)
RETURNS text LANGUAGE sql AS $hlp$
  SELECT coalesce(nullif(concat_ws('+', CASE WHEN t THEN 'Title' END, CASE WHEN ab THEN 'Abstract' END,
                                        CASE WHEN au THEN 'Authors' END, CASE WHEN j THEN 'Journal' END,
                                        CASE WHEN n THEN 'Notes' END, CASE WHEN k THEN 'Keywords' END), ''), '<none>')
$hlp$;

-- Every row of one search as '<last two id chars>:<labels>', by paper id.
CREATE FUNCTION pg_temp.attr(p_impl text, p_query text, p_user uuid DEFAULT '27a00000-0000-0000-0000-00000000000a')
RETURNS text LANGUAGE sql AS $hlp$
  SELECT coalesce(string_agg(right(r.paper_id::text, 2) || ':' || pg_temp.labels(r.t, r.ab, r.au, r.j, r.n, r.k),
                             ',' ORDER BY r.paper_id), '<no rows>')
    FROM pg_temp.run(p_impl, p_user, p_query) r
$hlp$;

-- Every row of one search as '<id>:<rank>', by paper id.
CREATE FUNCTION pg_temp.ranks(p_impl text, p_query text, p_user uuid DEFAULT '27a00000-0000-0000-0000-00000000000a')
RETURNS text LANGUAGE sql AS $hlp$
  SELECT coalesce(string_agg(r.paper_id::text || ':' || r.rank::text, ',' ORDER BY r.paper_id), '<no rows>')
    FROM pg_temp.run(p_impl, p_user, p_query) r
$hlp$;

-- How many times p_needle occurs in p_haystack.
CREATE FUNCTION pg_temp.occurrences(p_haystack text, p_needle text) RETURNS integer LANGUAGE sql AS $hlp$
  SELECT (length(p_haystack) - length(replace(p_haystack, p_needle, ''))) / length(p_needle)
$hlp$;

-- The effective terms of a query: each whitespace token the search's own
-- sanitizer produces, parsed alone exactly as the search parses it, minus the
-- ones that parse to nothing (stopwords). Used only to CLASSIFY queries in
-- section 5; the function under test never calls it.
CREATE FUNCTION pg_temp.effective_terms(p_query text) RETURNS text[] LANGUAGE sql AS $hlp$
  SELECT coalesce(array_agg(DISTINCT q ORDER BY q), '{}')
    FROM (SELECT to_tsquery('english', tok || ':*')::text AS q
            FROM regexp_split_to_table(regexp_replace(COALESCE(p_query, ''), '[&|!():*<>''"\\]', ' ', 'g'), '\s+') AS t(tok)
           WHERE length(tok) > 0) s
   WHERE q <> ''
$hlp$;

-- ── Fixtures (as the table owner; RLS bypassed) ──────────────────────────────
-- A owns every case below; B owns an exact copy of case A plus one row only B
-- holds; P owns the section 5 corpus. `neutral` is a filler title (title is
-- NOT NULL) that no query targets.
INSERT INTO auth.users (id, email) VALUES
  ('27a00000-0000-0000-0000-00000000000a', 'attribution-A@paperlume.test'),
  ('27b00000-0000-0000-0000-00000000000b', 'attribution-B@paperlume.test'),
  ('27c00000-0000-0000-0000-00000000000c', 'attribution-P@paperlume.test');

INSERT INTO public.papers (id, user_id, title, abstract, journal, authors, keywords, notes) VALUES
  -- Cases A–G
  ('27a00000-0000-0000-0000-000000000001', '27a00000-0000-0000-0000-00000000000a', 'zqxalpha', 'zqxbeta', NULL, '[]', '[]', NULL),
  ('27a00000-0000-0000-0000-000000000002', '27a00000-0000-0000-0000-00000000000a', 'zqxone', NULL, 'zqxtwo', '[]', '[]', 'zqxthree'),
  ('27a00000-0000-0000-0000-000000000003', '27a00000-0000-0000-0000-00000000000a', 'zqxgamma', NULL, NULL, '["Zqxdelta J"]', '[]', NULL),
  ('27a00000-0000-0000-0000-000000000004', '27a00000-0000-0000-0000-00000000000a', 'neutral', 'zqxepsilon', NULL, '[]', '["zqxzeta"]', NULL),
  ('27a00000-0000-0000-0000-000000000005', '27a00000-0000-0000-0000-00000000000a', 'neutral', NULL, NULL, '["Zqxlambda M"]', '["zqxmu"]', NULL),
  ('27a00000-0000-0000-0000-000000000006', '27a00000-0000-0000-0000-00000000000a', 'neutral', NULL, NULL, '["Smith J"]', '["metformin"]', NULL),
  ('27a00000-0000-0000-0000-000000000007', '27a00000-0000-0000-0000-00000000000a', 'zqxnu zqxxi', NULL, NULL, '[]', '[]', NULL),
  ('27a00000-0000-0000-0000-000000000008', '27a00000-0000-0000-0000-00000000000a', 'neutral', NULL, NULL, '[]', '[]', 'zqxrho'),
  ('27a00000-0000-0000-0000-000000000009', '27a00000-0000-0000-0000-00000000000a', 'zqxomicron', 'zqxomicron zqxpi', NULL, '[]', '[]', 'zqxpi'),
  -- Query semantics
  ('27a00000-0000-0000-0000-000000000010', '27a00000-0000-0000-0000-00000000000a', 'Running economy', 'zqxchi trials', NULL, '[]', '[]', NULL),
  ('27a00000-0000-0000-0000-000000000011', '27a00000-0000-0000-0000-00000000000a', 'зкхальфа', NULL, NULL, '[]', '["研究心臓"]', NULL),
  ('27a00000-0000-0000-0000-000000000012', '27a00000-0000-0000-0000-00000000000a', 'neutral 918273', '564738', NULL, '[]', '[]', NULL),
  ('27a00000-0000-0000-0000-000000000013', '27a00000-0000-0000-0000-00000000000a', 'zqxpsi x-ray', NULL, NULL, '["O''Zqxbrien T"]', '[]', NULL),
  ('27a00000-0000-0000-0000-000000000014', '27a00000-0000-0000-0000-00000000000a', 'zqxsigma', 'The study of the', NULL, '[]', '[]', 'the'),
  ('27a00000-0000-0000-0000-000000000015', '27a00000-0000-0000-0000-00000000000a', 'neutral', NULL, 'Journal of Zqxcardio', '["Zqxsmith J"]', '[]', NULL),
  -- Known limitation and its controls
  ('27a00000-0000-0000-0000-000000000016', '27a00000-0000-0000-0000-00000000000a', 'Study of zqxaa', 'zqxbb results', NULL, '[]', '[]', NULL),
  ('27a00000-0000-0000-0000-000000000017', '27a00000-0000-0000-0000-00000000000a', 'zqxcc zqxdd', NULL, NULL, '[]', '[]', NULL),
  ('27a00000-0000-0000-0000-000000000018', '27a00000-0000-0000-0000-00000000000a', 'zqxee', 'filler zqxff', NULL, '[]', '[]', NULL),
  -- The other account
  ('27b00000-0000-0000-0000-0000000000b1', '27b00000-0000-0000-0000-00000000000b', 'zqxalpha', 'zqxbeta', NULL, '[]', '[]', NULL),
  ('27b00000-0000-0000-0000-0000000000b2', '27b00000-0000-0000-0000-00000000000b', 'zqxforeign', NULL, 'zqxforeignjournal', '["Zqxforeign B"]', '["zqxforeign"]', 'zqxforeign');

-- Section 5 corpus for P: 240 papers over 16 synthetic words zqpwa … zqpwp.
-- One md5 byte per (paper, word) decides both whether the word is present
-- (probability 1/4) and in which of the six fields.
INSERT INTO public.papers (id, user_id, title, abstract, journal, authors, keywords, notes)
SELECT ('27c00000-0000-0000-0000-' || lpad(to_hex(x.i), 12, '0'))::uuid,
       '27c00000-0000-0000-0000-00000000000c',
       coalesce(string_agg(x.w, ' ' ORDER BY x.w) FILTER (WHERE x.f = 0), 'untitled'),
       string_agg(x.w, ' ' ORDER BY x.w) FILTER (WHERE x.f = 1),
       string_agg(x.w, ' ' ORDER BY x.w) FILTER (WHERE x.f = 2),
       coalesce(jsonb_agg(initcap(x.w) || ' A' ORDER BY x.w) FILTER (WHERE x.f = 3), '[]'),
       coalesce(jsonb_agg(x.w ORDER BY x.w) FILTER (WHERE x.f = 4), '[]'),
       string_agg(x.w, ' ' ORDER BY x.w) FILTER (WHERE x.f = 5)
  FROM (SELECT i, 'zqpw' || chr(96 + wk) AS w,
               CASE WHEN get_byte(decode(md5('027:' || i || ':' || wk), 'hex'), 0) < 64
                    THEN get_byte(decode(md5('027:' || i || ':' || wk), 'hex'), 0) % 6 END AS f
          FROM generate_series(1, 240) i, generate_series(1, 16) wk) x
 GROUP BY x.i;

SELECT plan(105);

-- ══ 1. Posture ══════════════════════════════════════════════════════════════
SELECT is(
  (SELECT (SELECT count(*) FROM pg_proc p2 WHERE p2.pronamespace = p.pronamespace AND p2.proname = p.proname) || ' overload'
          || ' | ' || pg_get_userbyid(p.proowner)
          || ' | ' || (SELECT l.lanname FROM pg_language l WHERE l.oid = p.prolang)
          || ' | ' || CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END
          || ' | vol ' || p.provolatile::text || ' | par ' || p.proparallel::text
          || ' | ' || coalesce(array_to_string(p.proconfig, ','), '<no config>')
          || ' | body ' || md5(p.prosrc)
          || ' | acl ' || coalesce(p.proacl::text, 'NULL')
          || ' | exec ' || (SELECT coalesce(string_agg(r, ',' ORDER BY r COLLATE "C"), '<nobody>')
                              FROM unnest(ARRAY['PUBLIC','anon','authenticated','service_role']) r
                             WHERE CASE WHEN r = 'PUBLIC'
                                        THEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                                                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                                        ELSE has_function_privilege(r, p.oid, 'EXECUTE') END)
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.search_papers(uuid,text,integer,integer)')),
  '1 overload | postgres | plpgsql | SECURITY INVOKER | vol v | par u | search_path=public'
    || ' | body 1a72d57a585779644c00636f0da3b253'
    || ' | acl {postgres=X/postgres,authenticated=X/postgres} | exec authenticated',
  'posture: search_papers — owner, INVOKER, VOLATILE, search_path, reviewed C58 body, authenticated-only EXECUTE');

SELECT is(
  (SELECT pg_get_function_result(p.oid) || ' | ' || pg_get_function_arguments(p.oid)
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.search_papers(uuid,text,integer,integer)')),
  'TABLE(paper_id uuid, rank real, matched_title boolean, matched_abstract boolean, matched_authors boolean, matched_journal boolean, matched_notes boolean, matched_keywords boolean)'
    || ' | p_user_id uuid, p_query text, p_limit integer DEFAULT 1000, p_offset integer DEFAULT 0',
  'posture: the return columns and arguments (with their defaults) are unchanged');

SELECT is(
  (SELECT md5(p.prosrc) || ' | ' || CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END || ' | ' || p.provolatile::text
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.search_papers_short(uuid,text)')),
  'ce353564edcb73a5466092e84d0b8d1b | SECURITY INVOKER | s',
  'posture: search_papers_short is untouched');

-- The body: what decides membership and order is the previous body's text,
-- verbatim; only the flags moved to the attribution query.
SELECT is(
  (SELECT string_agg(f.ord || ':' || coalesce(pg_temp.occurrences(n.prosrc, f.frag)::text, 'missing')
                     || '/' || coalesce(pg_temp.occurrences(o.prosrc, f.frag)::text, 'missing'), ' ' ORDER BY f.ord)
     FROM (VALUES
       (1, $frag$  IF p_user_id IS NULL
     OR auth.uid() IS NULL
     OR p_user_id <> auth.uid()
  THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;$frag$),
       (2, $frag$SELECT string_agg(tok || ':*', ' & ')$frag$),
       (3, $frag$          COALESCE(p_query, ''),
          '[&|!():*<>''"\\]',
          ' ',
          'g'
        ),
        '\s+'
      ) AS t(token)
      WHERE length(token) > 0
    ) s;$frag$),
       (4, $frag$  IF v_ts_query_text IS NULL OR v_ts_query_text = '' THEN
    RETURN;
  END IF;$frag$),
       (5, $frag$  v_ts_query := to_tsquery('english', v_ts_query_text);$frag$),
       (6, $frag$    ts_rank(p.search_vector, v_ts_query) AS rank,$frag$),
       (7, $frag$  FROM papers p
  WHERE p.user_id = p_user_id
    AND p.search_vector @@ v_ts_query
  ORDER BY rank DESC
  LIMIT p_limit OFFSET p_offset;$frag$)) AS f(ord, frag)
     LEFT JOIN pg_proc n ON n.oid = to_regprocedure('public.search_papers(uuid,text,integer,integer)')
     LEFT JOIN pg_proc o ON o.oid = to_regprocedure('pg_temp.search_papers_whole_query(uuid,text,integer,integer)')),
  '1:1/1 2:1/1 3:1/1 4:1/1 5:1/1 6:1/1 7:1/1',
  'body: the guard, sanitizer, &-join, empty-input return, membership query, rank and WHERE/ORDER/LIMIT each occur exactly once in the new body and in the previous one');

SELECT is(
  (SELECT pg_temp.occurrences(p.prosrc, '@@ v_ts_any AS matched_') || ' flags on v_ts_any | '
          || pg_temp.occurrences(p.prosrc, '@@ v_ts_query AS matched_') || ' flags on v_ts_query | '
          || pg_temp.occurrences(p.prosrc, '@@ v_ts_query') || ' membership test | '
          || pg_temp.occurrences(p.prosrc, 'v_ts_query)') || ' rank | '
          || pg_temp.occurrences(p.prosrc, 'string_agg(tok || '':*'', '' | '')') || ' |-join'
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.search_papers(uuid,text,integer,integer)')),
  '6 flags on v_ts_any | 0 flags on v_ts_query | 1 membership test | 1 rank | 1 |-join',
  'body: all six flags test the |-joined attribution query, and the membership query is used only for WHERE and rank');

SELECT is(
  (SELECT (position('DEFINER' IN p.prosrc) > 0)::text || ' | '
          || (position('bypasses table-level RLS' IN p.prosrc) > 0)::text || ' | '
          || (position('at least one of these will also be true' IN p.prosrc) > 0)::text
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.search_papers(uuid,text,integer,integer)')),
  'false | false | false',
  'body: the stale SECURITY DEFINER comment and the false "at least one will be true" comment are gone');

-- ══ 2. The reference is the reviewed previous body ══════════════════════════
SELECT is(
  (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('pg_temp.search_papers_whole_query(uuid,text,integer,integer)')),
  'd4a5f3afdc485d5dfda8e0798c61cc48',
  'reference: the pg_temp comparison body is byte for byte the previous search_papers body');

-- ══ 3 + 4. Cases A–G and query semantics ════════════════════════════════════
-- `before` is the reference body's answer, `after` the migrated function's;
-- each row also has its rows and ranks compared between the two.
CREATE TEMP TABLE c58_cases (ord int PRIMARY KEY, label text NOT NULL, q text NOT NULL, before text NOT NULL, after text NOT NULL);
INSERT INTO c58_cases VALUES
  ( 1, 'A two scalar fields (title + abstract)',        'zqxalpha zqxbeta',            '01:<none>',    '01:Title+Abstract'),
  ( 2, 'B three scalar fields (title + journal + notes)', 'zqxone zqxtwo zqxthree',    '02:<none>',    '02:Title+Journal+Notes'),
  ( 3, 'C scalar + JSON (title + authors)',             'zqxgamma zqxdelta',           '03:<none>',    '03:Title+Authors'),
  ( 4, 'C scalar + JSON (abstract + keywords)',         'zqxepsilon zqxzeta',          '04:<none>',    '04:Abstract+Keywords'),
  ( 5, 'D two JSON fields (authors + keywords)',        'zqxlambda zqxmu',             '05:<none>',    '05:Authors+Keywords'),
  ( 6, 'D the approved example: metformin smith',       'metformin smith',             '06:<none>',    '06:Authors+Keywords'),
  ( 7, 'E every term in one field',                     'zqxnu zqxxi',                 '07:Title',     '07:Title'),
  ( 8, 'F one term (notes)',                            'zqxrho',                      '08:Notes',     '08:Notes'),
  ( 9, 'F one term (title)',                            'zqxalpha',                    '01:Title',     '01:Title'),
  (10, 'G whole query in abstract, parts in title and notes — all contributing fields flagged (intentional)',
                                                        'zqxomicron zqxpi',            '09:Abstract',  '09:Title+Abstract+Notes'),
  (11, 'semantics: prefix tokens',                      'zqxalp zqxbe',                '01:<none>',    '01:Title+Abstract'),
  (12, 'semantics: stemming (runs → run matches Running)', 'runs zqxchi',              '10:<none>',    '10:Title+Abstract'),
  (13, 'semantics: case',                               'ZQXALPHA ZqxBeta',            '01:<none>',    '01:Title+Abstract'),
  (14, 'semantics: stopword + term — the stopword flags nothing, although abstract and notes contain "the"',
                                                        'the zqxsigma',                '14:Title',     '14:Title'),
  (15, 'semantics: stopwords only — no rows, as before', 'the of and',                 '<no rows>',    '<no rows>'),
  (16, 'semantics: repeated token',                     'zqxalpha zqxalpha',           '01:Title',     '01:Title'),
  (17, 'semantics: repeated token + split term',        'zqxalpha zqxalpha zqxbeta',   '01:<none>',    '01:Title+Abstract'),
  (18, 'semantics: stripped & and | still mean AND',    'zqxalpha | zqxone',           '<no rows>',    '<no rows>'),
  (19, 'semantics: stripped operators around split terms', 'zqxalpha & (zqxbeta)',     '01:<none>',    '01:Title+Abstract'),
  (20, 'semantics: numbers',                            '918273 564738',               '12:<none>',    '12:Title+Abstract'),
  (21, 'semantics: Unicode (Cyrillic title + CJK keyword prefix)', 'зкхальфа 研究',     '11:<none>',    '11:Title+Keywords'),
  (22, 'semantics: apostrophe (o''zqxbrien → o + zqxbrien)', 'o''zqxbrien zqxpsi',    '13:<none>',    '13:Title+Authors'),
  (23, 'semantics: hyphenated compound',                'x-ray zqxbrien',              '13:<none>',    '13:Title+Authors'),
  (24, 'semantics: a single-letter token is an ordinary prefix term (j:* also matches "Journal")',
                                                        'zqxsmith j',                  '15:Authors',   '15:Authors+Journal');

SELECT is(pg_temp.attr('new', c.q), c.after, 'after: ' || c.label || ' — ' || c.q)
  FROM c58_cases c ORDER BY c.ord;
SELECT is(pg_temp.attr('old', c.q), c.before, 'before (reference body): ' || c.label || ' — ' || c.q)
  FROM c58_cases c ORDER BY c.ord;
SELECT is(pg_temp.ranks('new', c.q), pg_temp.ranks('old', c.q), 'rows and ranks unchanged: ' || c.label)
  FROM c58_cases c ORDER BY c.ord;

-- Why the stopword case holds: the attribution query is parsed exactly like
-- the membership query, so a stopword operand disappears from both.
SELECT is(to_tsquery('english', 'the:* | zqxsigma:*')::text || ' / ' || to_tsquery('english', 'the:* & zqxsigma:*')::text,
  '''zqxsigma'':* / ''zqxsigma'':*',
  'semantics (control): a stopword drops out of the |-joined query exactly as it drops out of the &-joined one');

-- ══ 5. Property: deterministic corpus, previous body as the oracle ══════════
CREATE TEMP TABLE c58_q (qid int PRIMARY KEY, q text NOT NULL);
INSERT INTO c58_q
  SELECT wk, 'zqpw' || chr(96 + wk) FROM generate_series(1, 16) wk            -- 16 one-word queries
  UNION ALL
  SELECT 100 + n,                                                             -- 84 queries of 2–4 words (repeats allowed)
         (SELECT string_agg('zqpw' || chr(97 + get_byte(decode(md5('027q:' || n || ':' || j), 'hex'), 0) % 16), ' ' ORDER BY j)
            FROM generate_series(1, 2 + n % 3) j)
    FROM generate_series(1, 84) n
  UNION ALL
  SELECT * FROM (VALUES                                                        -- 10 shaped queries
    (201, 'the zqpwa zqpwb'), (202, 'zqpw'), (203, 'zqpwa zqpw'), (204, 'ZQPWC zqpWd'), (205, 'zqpwe & zqpwf'),
    (206, 'of zqpwg and'), (207, 'zqpwh zqpwh'), (208, 'zqpwi | zqpwj zqpwk'), (209, 'zqpw zqpw'), (210, 'the and of')) v;

CREATE TEMP TABLE c58_new AS
  SELECT q.qid, r.* FROM c58_q q, LATERAL pg_temp.run('new', '27c00000-0000-0000-0000-00000000000c', q.q) r;
CREATE TEMP TABLE c58_old AS
  SELECT q.qid, r.* FROM c58_q q, LATERAL pg_temp.run('old', '27c00000-0000-0000-0000-00000000000c', q.q) r;

SELECT is(
  (SELECT count(*)::int FROM c58_new n FULL JOIN c58_old o USING (qid, paper_id) WHERE n.rank IS NULL OR o.rank IS NULL),
  0, 'property: every query returns exactly the rows the previous body returned');
SELECT is(
  (SELECT count(*)::int FROM c58_new n JOIN c58_old o USING (qid, paper_id) WHERE n.rank IS DISTINCT FROM o.rank),
  0, 'property: every returned row has exactly the rank the previous body gave it');
SELECT is(
  (SELECT count(*)::int FROM c58_new n JOIN c58_old o USING (qid, paper_id)
    WHERE (o.t AND NOT n.t) OR (o.ab AND NOT n.ab) OR (o.au AND NOT n.au)
       OR (o.j AND NOT n.j) OR (o.n AND NOT n.n) OR (o.k AND NOT n.k)),
  0, 'property: every flag the previous body set is still set (monotonic)');
SELECT is(
  (SELECT count(*)::int FROM c58_new n JOIN c58_old o USING (qid, paper_id) JOIN c58_q q USING (qid)
    WHERE cardinality(pg_temp.effective_terms(q.q)) = 1
      AND (n.t, n.ab, n.au, n.j, n.n, n.k) IS DISTINCT FROM (o.t, o.ab, o.au, o.j, o.n, o.k)),
  0, 'property: a query with one effective term flags exactly what the previous body flagged');
SELECT is(
  (SELECT count(*)::int FROM c58_new WHERE NOT (t OR ab OR au OR j OR n OR k)),
  0, 'property: every returned row of an ordinary multi-term AND query has at least one contributing field flagged');
SELECT is(
  (SELECT count(*)::int FROM c58_new n JOIN c58_q q USING (qid) JOIN public.papers p ON p.id = n.paper_id
    WHERE (n.t  AND NOT to_tsvector('english', coalesce(p.title, ''))          @@ to_tsquery('english', array_to_string(pg_temp.effective_terms(q.q), ' | ')))
       OR (n.ab AND NOT to_tsvector('english', coalesce(p.abstract, ''))       @@ to_tsquery('english', array_to_string(pg_temp.effective_terms(q.q), ' | ')))
       OR (n.au AND NOT to_tsvector('english', coalesce(p.authors::text, ''))  @@ to_tsquery('english', array_to_string(pg_temp.effective_terms(q.q), ' | ')))
       OR (n.j  AND NOT to_tsvector('english', coalesce(p.journal, ''))        @@ to_tsquery('english', array_to_string(pg_temp.effective_terms(q.q), ' | ')))
       OR (n.n  AND NOT to_tsvector('english', coalesce(p.notes, ''))          @@ to_tsquery('english', array_to_string(pg_temp.effective_terms(q.q), ' | ')))
       OR (n.k  AND NOT to_tsvector('english', coalesce(p.keywords::text, '')) @@ to_tsquery('english', array_to_string(pg_temp.effective_terms(q.q), ' | ')))),
  0, 'property: a flagged field really contains at least one effective term of the query');

-- The corpus is not vacuous: it exercises the defect, the fix, every shape.
SELECT ok(
  (SELECT count(*) FROM c58_old WHERE NOT (t OR ab OR au OR j OR n OR k)) >= 100
  AND (SELECT count(*) FROM c58_new) >= 1000
  AND (SELECT count(DISTINCT qid) FROM c58_new WHERE qid BETWEEN 100 AND 199) >= 40
  AND (SELECT count(*) FROM c58_q q WHERE cardinality(pg_temp.effective_terms(q.q)) = 1) >= 20
  AND (SELECT count(*) FROM c58_new WHERE qid = 210) = 0,
  'property (control): the previous body left >= 100 corpus rows unflagged, >= 1000 rows and >= 40 multi-word queries are compared, >= 20 queries have one effective term, and the stopword-only query returns nothing');

SELECT diag(format('property corpus: %s queries, %s returned rows compared; previous body left %s rows unflagged, the migrated body %s; %s rows gained a flag; %s queries have one effective term',
  (SELECT count(*) FROM c58_q), (SELECT count(*) FROM c58_new),
  (SELECT count(*) FROM c58_old WHERE NOT (t OR ab OR au OR j OR n OR k)),
  (SELECT count(*) FROM c58_new WHERE NOT (t OR ab OR au OR j OR n OR k)),
  (SELECT count(*) FROM c58_new n JOIN c58_old o USING (qid, paper_id)
    WHERE (n.t, n.ab, n.au, n.j, n.n, n.k) IS DISTINCT FROM (o.t, o.ab, o.au, o.j, o.n, o.k)),
  (SELECT count(*) FROM c58_q q WHERE cardinality(pg_temp.effective_terms(q.q)) = 1)));

-- LIMIT / OFFSET: the same window of the same ranking.
SELECT is(
  (SELECT count(*)::text || ' | ' || string_agg(r.rank::text, ',' ORDER BY r.rank DESC)
     FROM pg_temp.run('new', '27c00000-0000-0000-0000-00000000000c', 'zqpw', 7, 3) r),
  (SELECT count(*)::text || ' | ' || string_agg(r.rank::text, ',' ORDER BY r.rank DESC)
     FROM pg_temp.run('old', '27c00000-0000-0000-0000-00000000000c', 'zqpw', 7, 3) r),
  'property: p_limit / p_offset return the same window of the same ranking as before');

-- ══ 6. KNOWN LIMITATION — characterization, not a contract ══════════════════
-- `zqxaa,zqxbb` is ONE whitespace token. PostgreSQL's parser turns it into the
-- phrase 'zqxaa':* <-> 'zqxbb':*. search_vector concatenates the fields with
-- shifted positions, so the title's last word (zqxaa:3) is adjacent to the
-- abstract's first (zqxbb:4) and the phrase matches across that seam. The row
-- is returned — membership is unchanged by design — but neither field holds
-- the phrase, so no flag is set. C58 does not redesign phrase positions or the
-- sanitizer. If this test starts failing because the row gains a flag or stops
-- being returned, that is a deliberate semantic change: record it in C58.
SELECT is(to_tsquery('english', 'zqxaa,zqxbb:*')::text,
  '''zqxaa'':* <-> ''zqxbb'':*',
  'KNOWN LIMITATION (characterization): a comma-joined token parses to a phrase');
SELECT is((SELECT p.search_vector::text FROM public.papers p WHERE p.id = '27a00000-0000-0000-0000-000000000016'),
  '''result'':5B ''studi'':1A ''zqxaa'':3A ''zqxbb'':4B',
  'KNOWN LIMITATION (characterization): the combined vector puts the title''s last word next to the abstract''s first');
SELECT is(pg_temp.attr('new', 'zqxaa,zqxbb'), '16:<none>',
  'KNOWN LIMITATION (characterization): a phrase matched only across the title/abstract seam is returned with no flag');
SELECT is(pg_temp.ranks('new', 'zqxaa,zqxbb'), pg_temp.ranks('old', 'zqxaa,zqxbb'),
  'KNOWN LIMITATION (characterization): its row and rank are exactly what the previous body returned');
SELECT is(pg_temp.attr('new', 'zqxaa,zqxbb results'), '16:Abstract',
  'KNOWN LIMITATION (scope): with one ordinary term beside the phrase, that term''s field is flagged');
SELECT is(pg_temp.attr('new', 'zqxcc,zqxdd'), '17:Title',
  'KNOWN LIMITATION (control): the same phrase inside one field flags that field');
SELECT is(pg_temp.attr('new', 'zqxee,zqxff'), '<no rows>',
  'KNOWN LIMITATION (control): the same shape across a seam that is not adjacent does not match');

-- ══ 7. Security ═════════════════════════════════════════════════════════════
SELECT is(pg_temp.err_as(r, '', $q$SELECT * FROM public.search_papers('27a00000-0000-0000-0000-00000000000a'::uuid, 'zqxalpha zqxbeta', 10, 0)$q$),
  '42501 permission denied for function search_papers',
  'security: ' || r || ' is refused at the function ACL')
  FROM unnest(ARRAY['anon', 'service_role']) r ORDER BY r;

SELECT is(pg_temp.err_as('authenticated', pg_temp.claims('27a00000-0000-0000-0000-00000000000a'),
    $q$SELECT * FROM public.search_papers('27b00000-0000-0000-0000-00000000000b'::uuid, 'zqxalpha zqxbeta', 10, 0)$q$),
  'P0001 Unauthorized: user mismatch', 'security: A asking for B''s library is refused by the identity guard');
SELECT is(pg_temp.err_as('authenticated', '',
    $q$SELECT * FROM public.search_papers('27a00000-0000-0000-0000-00000000000a'::uuid, 'zqxalpha zqxbeta', 10, 0)$q$),
  'P0001 Unauthorized: user mismatch', 'security: a caller without an identity is refused');
SELECT is(pg_temp.err_as('authenticated', pg_temp.claims('27a00000-0000-0000-0000-00000000000a'),
    $q$SELECT * FROM public.search_papers(NULL::uuid, 'zqxalpha zqxbeta', 10, 0)$q$),
  'P0001 Unauthorized: user mismatch', 'security: a NULL p_user_id is refused');

SELECT is(pg_temp.attr('new', 'zqxalpha zqxbeta', '27b00000-0000-0000-0000-00000000000b'), 'b1:Title+Abstract',
  'isolation: B, searching the same terms, gets only B''s own copy, attributed');
SELECT is(pg_temp.attr('new', 'zqxforeign'), '<no rows>',
  'isolation: a term only B''s row holds — in all six fields — returns nothing to A, so no field of it is described');
SELECT is(
  (SELECT count(*)::int FROM c58_cases c, LATERAL pg_temp.run('new', '27a00000-0000-0000-0000-00000000000a', c.q) r
    WHERE r.paper_id::text LIKE '27b%' OR r.paper_id::text LIKE '27c%'),
  0, 'isolation: no case query returns, or attributes, a row of another account');

-- RLS is live inside the new body: a transaction-local RESTRICTIVE policy that
-- admits nothing empties the result. (A SECURITY DEFINER body run by postgres,
-- which has BYPASSRLS, would ignore it.)
CREATE POLICY zz_027_rls_probe_deny ON public.papers AS RESTRICTIVE FOR SELECT TO authenticated USING (false);
SELECT is(pg_temp.attr('new', 'zqxalpha zqxbeta'), '<no rows>',
  'security: RLS applies inside search_papers — a deny-all policy empties the result');
DROP POLICY zz_027_rls_probe_deny ON public.papers;
SELECT is(pg_temp.attr('new', 'zqxalpha zqxbeta'), '01:Title+Abstract',
  'security (control): without the probe policy the same search returns A''s row');

SELECT * FROM finish();
ROLLBACK;
