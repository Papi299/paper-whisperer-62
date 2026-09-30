-- SEARCH-MATCH-ATTRIBUTION-CROSS-FIELD-001 — search_papers' six matched_*
-- flags name every field that contributed a query term (C58).
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly one statement (section 2):
--
--   CREATE OR REPLACE FUNCTION public.search_papers(uuid,text,integer,integer)
--
-- Inside the body, and nowhere else:
--
--   * the existing token list is aggregated a second time, in the same query
--     and once per call, joined with ' | ' instead of ' & ', and parsed with
--     the same to_tsquery('english', …) into a new variable, v_ts_any;
--   * the six per-field attribution expressions test v_ts_any instead of the
--     membership query v_ts_query;
--   * two historical comments that are false today are corrected (see
--     COMMENTS below).
--
-- Everything that decides WHICH rows come back, and in what order, is kept
-- byte for byte: the ownership guard, the sanitizer and whitespace tokenizer,
-- the ':*' prefix operator, the ' & ' join, the empty-input early return,
-- `v_ts_query := to_tsquery('english', v_ts_query_text)`, the rank
-- `ts_rank(p.search_vector, v_ts_query)`, and
--   WHERE p.user_id = p_user_id AND p.search_vector @@ v_ts_query
--   ORDER BY rank DESC LIMIT p_limit OFFSET p_offset.
-- Section 3 proves each of those fragments is present, verbatim, in both the
-- reviewed previous body and the new one.
--
-- Not changed: the signature, argument names and defaults, the return
-- columns, LANGUAGE plpgsql, SECURITY INVOKER, VOLATILE, PARALLEL UNSAFE,
-- COST 100, ROWS 1000, `search_path=public`, the owner (postgres) and the
-- EXECUTE ACL {postgres=X/postgres,authenticated=X/postgres}. No GRANT or
-- REVOKE is issued: CREATE OR REPLACE keeps ownership and permissions. Not
-- touched at all: search_papers_short, every other function, papers and its
-- generated search_vector column, idx_papers_search_vector, every policy and
-- grant, and every row. The generated client types do not change.
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- SEARCH-MATCH-ATTRIBUTION-CROSS-FIELD-AUDIT-001 (2026-09-30, read-only) found
-- that unquoted full-text search returns a paper when its combined
-- search_vector holds every query term — which may be spread over several
-- fields — while each matched_* flag tested ONE field against the WHOLE
-- AND-query. A query such as `metformin smith` against a paper whose
-- Keywords hold "metformin" and whose Authors hold "Smith" therefore returned
-- the paper, correctly, with all six flags false, and PaperList rendered no
-- "Matched in:" line for it. The result set was right; only the explanation
-- was missing. That contradicted README.md and docs/architecture-read-path.md
-- ("each matching row"), and the comment the flags were written with
-- (20260420010000: "at least one of these will also be true").
--
-- The owner approved OPTION B, CONTRIBUTING-FIELD ATTRIBUTION (C58): a field
-- is marked as matched when it contains at least one effective query term.
--
-- SEMANTICS
-- ─────────────────────────────────────────────────────────────────────────────
-- T is the token list the existing sanitizer produces; q(t) is
-- to_tsquery('english', t || ':*'); a token is effective when q(t) is not
-- empty (English stopwords are not). V_f is
-- to_tsvector('english', coalesce(<field>, '')) — authors and keywords
-- through their jsonb text — exactly the per-field vectors search_vector
-- concatenates.
--
--   membership (unchanged): search_vector @@ (q(t1) & q(t2) & …)
--   rank       (unchanged): ts_rank(search_vector, q(t1) & q(t2) & …)
--   matched_f  (new)      : V_f @@ (q(t1) | q(t2) | …)
--
-- to_tsquery parses each operand independently of the operator between them,
-- so the OR-query carries exactly the membership query's terms: the same
-- prefixes, stems, lower-casing and compound/phrase structure, with
-- stopwords dropped from both alike. A stopword therefore never flags a
-- field, and a single-term query flags exactly the fields it flagged before.
-- Every flag that was true stays true. A flag does NOT mean the field alone
-- satisfies the whole query. Because search_vector is the concatenation of
-- the six V_f, every returned row has at least one true flag whenever at
-- least one effective term is a single lexeme.
--
-- KNOWN LIMITATION — characterized, not changed
-- ─────────────────────────────────────────────────────────────────────────────
-- Punctuation inside one whitespace token (e.g. `a,b`, `a;b`, `a+b`, and
-- digit-hyphen forms like `covid-19`) makes PostgreSQL's parser produce a
-- phrase, `'a':* <-> 'b':*`. tsvector concatenation shifts each field's
-- positions past the previous field's, so the last word of one field is
-- adjacent to the first word of the next, and such a phrase can match across
-- that seam. The row is returned (membership is unchanged) and, when every
-- effective term is such a phrase, no single field holds it, so all six flags
-- can still be false. Suite 027 pins one deterministic case. Fixing it would
-- change sanitizer or membership semantics and is out of scope here.
--
-- COMMENTS
-- ─────────────────────────────────────────────────────────────────────────────
-- The body carried two statements that are false today:
--   * "SECURITY DEFINER bypasses table-level RLS, so we must verify the caller
--     owns the requested user_id ourselves" (from 20260518010000). Since C49
--     (20260926152414) the function is SECURITY INVOKER; C49 recorded that the
--     sentence may be removed the next time the body is legitimately
--     recreated. This is that time.
--   * "at least one of these will also be true" (from 20260420010000). It was
--     false for multi-term queries; the new comment states the contributing-
--     field contract and its limitation.
-- The guard beneath the first comment is kept exactly.
--
-- SAFETY — fail closed on both sides of the replacement
-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1 refuses, before anything changes, unless search_papers is exactly
-- the reviewed function — one overload; owner, language, security mode,
-- volatility, parallel mode, strictness, leakproofness, cost, rows, result,
-- arguments with defaults, search_path, no comment, no dependent object, the
-- exact stored ACL and effective EXECUTE posture, and body md5
-- d4a5f3afdc485d5dfda8e0798c61cc48 — and unless the objects its attribution
-- relies on are the reviewed ones: papers.search_vector is C54's canonical
-- stored expression (8ddd960b4f4b11dd7afd35485d01fd25) with
-- idx_papers_search_vector a valid GIN index on it, and papers' owner, RLS,
-- FORCE RLS, grant and policies (07603cbe4e78a4d6097e7ec33bd1e6c8) are the
-- boundary C49 reviewed. Section 3 proves, before COMMIT, that the function
-- kept its OID and every pg_proc attribute except prosrc, that the new body
-- is exactly the reviewed one, that the membership and rank fragments are
-- unchanged, and that nothing else in `public`, on papers or in any row moved.
--
-- PRODUCTION PROJECTION
-- ─────────────────────────────────────────────────────────────────────────────
-- Verified read-only on 2026-09-30 (PostgreSQL 17.6; ledger 97, latest
-- 20260929084252): search_papers is in exactly the section 1 shape, with body
-- d4a5f3af…, identical to a clean local replay; search_vector 8ddd960b…;
-- idx_papers_search_vector valid, ready and live. A separately authorized
-- rollout is therefore expected to add one ledger row and replace one
-- function body — no table, index or policy change, no table rewrite and no
-- application-row write. The statement fires the platform's ddl_command_end
-- event triggers: pgrst_ddl_watch sends NOTIFY pgrst 'reload schema', so
-- PostgREST reloads its schema cache (the RPC name, arguments and result
-- shape it serves are unchanged); issue_pg_graphql_access matches the CREATE
-- FUNCTION tag but, in Production, returns at once unless the object is the
-- pg_graphql extension (verified read-only 2026-09-30). A clean local replay
-- also has graphql_watch_ddl, which increments the sequence
-- graphql.seq_schema_version — a sequence, not a table row. Migration-only:
-- no Edge Function and no frontend change is needed, because PaperList
-- already renders every true flag.
--
-- CONCURRENCY
-- ─────────────────────────────────────────────────────────────────────────────
-- Every lock is waited for at most lock_timeout = 5s; on timeout the file
-- rolls back with nothing changed. Replacing a function updates its pg_proc
-- row. A rolled-back local rehearsal of this file, inspected just before its
-- end, held only catalog locks (AccessShare on the catalogs it reads,
-- RowExclusive on pg_proc's TOAST table and index) plus the replay-only event
-- trigger's sequence lock — no lock of any mode on papers and no object lock
-- on the function. A call already executing finishes with the
-- body it started with, and the next call uses the new one. Both bodies
-- return the same rows and ranks, so no ordering barrier is needed. The file
-- is explicitly transactional (see 20260910212202 for why `supabase db reset`
-- requires that): preconditions, replacement and verification commit
-- together or not at all.
--
-- One observable difference beyond the flags: for a query made only of
-- stopwords, to_tsquery's NOTICE "text-search query contains only stop words
-- or doesn't contain lexemes, ignored" is now raised twice (once per parsed
-- query) instead of once. The result is still zero rows; PostgREST does not
-- forward NOTICEs.
--
-- ROLLBACK — forward only
-- ─────────────────────────────────────────────────────────────────────────────
-- Do not edit this file after it has been applied. To return to whole-query
-- attribution, write a NEW forward migration that re-creates the reviewed
-- previous body (md5 d4a5f3afdc485d5dfda8e0798c61cc48: the search_papers text
-- of 20260802025704, with every attribute stated as section 2 states it,
-- SECURITY INVOKER included) behind the same kind of preconditions. That
-- restores the zero-flag rows this file removes; it changes no result set.
--
-- Durable decision: C58.

BEGIN;

-- Transaction-local, so COMMIT restores the runner's own settings: one fixed
-- rendering path for every catalog value this file renders and compares, and
-- a bounded wait for every lock. Section 0 proves both took effect, which also
-- proves this file is running inside one transaction (outside one, SET LOCAL
-- only warns).
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context, and this transaction's own write counters
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only the owner (postgres) can replace search_papers. Section 3 proves this
-- transaction wrote no row to any table in `public`, `auth` or `storage`, from
-- PostgreSQL's per-transaction statistics (see 20260924193915 §0 for why the
-- baseline is taken here). Replacing a function writes only system catalogs.

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'search_attribution: must run as postgres (current_user is %) — only the owner of search_papers can replace it',
      current_user;
  END IF;

  IF current_setting('search_path') IS DISTINCT FROM 'pg_catalog, pg_temp'
     OR current_setting('lock_timeout') IS DISTINCT FROM '5s' THEN
    RAISE EXCEPTION 'search_attribution: the transaction-local settings are not in effect (search_path %, lock_timeout %) — this file must run as one transaction',
      current_setting('search_path'), current_setting('lock_timeout');
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'search_attribution: track_counts is off, so the no-write self-check could not observe anything';
  END IF;

  PERFORM set_config(
    'paperlume.search_attribution.xact_writes_at_start',
    (SELECT string_agg(
              n.nspname || '.' || c.relname || '=' || (pg_stat_get_xact_tuples_inserted(c.oid)
                                                       + pg_stat_get_xact_tuples_updated(c.oid)
                                                       + pg_stat_get_xact_tuples_deleted(c.oid)),
              ' ' ORDER BY n.nspname, c.relname)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p')),
    true);
END
$ctx$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Preconditions — the exact state this change was reviewed against
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Verified read-only against Production and on a clean local replay on
-- 2026-09-30. OIDs differ between environments, so they are resolved here and
-- recorded for section 3. Nothing here repairs unexpected state: any mismatch
-- rolls the whole file back before anything changes.

DO $pre$
DECLARE
  v_fn    CONSTANT TEXT := 'public.search_papers(uuid,text,integer,integer)';
  v_oid   OID;
  v_text  TEXT;
  v_want  TEXT;
BEGIN
  -- ── 1a. Roles: the caller is an ordinary, RLS-subject role ──────────────────
  IF to_regrole('authenticated') IS NULL OR to_regrole('anon') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'search_attribution: one of the roles authenticated / anon / service_role does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'search_attribution: authenticated is SUPERUSER or BYPASSRLS, so RLS would not be the boundary C49 reviewed';
  END IF;

  -- ── 1b. search_papers: exactly the reviewed function ─────────────────────────
  v_oid := to_regprocedure(v_fn);
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'search_attribution: % does not exist', v_fn;
  END IF;

  -- One readable line, so a refusal names the attribute that differs.
  SELECT (SELECT count(*) FROM pg_proc p2 WHERE p2.pronamespace = p.pronamespace AND p2.proname = p.proname)::text
         || '|' || p.pronamespace::regnamespace::text
         || '|' || pg_get_userbyid(p.proowner)
         || '|' || (SELECT l.lanname FROM pg_language l WHERE l.oid = p.prolang)
         || '|' || p.prokind::text
         || '|secdef=' || p.prosecdef::text
         || '|vol=' || p.provolatile::text
         || '|par=' || p.proparallel::text
         || '|strict=' || p.proisstrict::text
         || '|leakproof=' || p.proleakproof::text
         || '|retset=' || p.proretset::text
         || '|cost=' || p.procost::text
         || '|rows=' || p.prorows::text
         || '|' || coalesce(array_to_string(p.proconfig, ','), '<no config>')
         || '|' || pg_get_function_result(p.oid)
         || '|' || pg_get_function_arguments(p.oid)
         || '|comment=' || coalesce(obj_description(p.oid, 'pg_proc'), '<none>')
         || '|body=' || md5(p.prosrc)
         || '|acl=' || coalesce(p.proacl::text, 'NULL')
    INTO v_text
    FROM pg_proc p WHERE p.oid = v_oid;
  v_want := '1|public|postgres|plpgsql|f|secdef=false|vol=v|par=u|strict=false|leakproof=false|retset=true|cost=100|rows=1000'
         || '|search_path=public'
         || '|TABLE(paper_id uuid, rank real, matched_title boolean, matched_abstract boolean, matched_authors boolean, matched_journal boolean, matched_notes boolean, matched_keywords boolean)'
         || '|p_user_id uuid, p_query text, p_limit integer DEFAULT 1000, p_offset integer DEFAULT 0'
         || '|comment=<none>'
         || '|body=d4a5f3afdc485d5dfda8e0798c61cc48'
         || '|acl={postgres=X/postgres,authenticated=X/postgres}';
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'search_attribution: % is not the reviewed function.\nfound:    %\nexpected: %', v_fn, v_text, v_want;
  END IF;

  -- The effective posture, including PUBLIC (grantee 0) — not only the ACL text.
  IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'search_attribution: the effective EXECUTE posture of % is not authenticated-only', v_fn;
  END IF;

  -- Nothing depends on it (a view, a default, another routine's recorded
  -- dependency), so replacing its body cannot silently change another object.
  IF EXISTS (SELECT 1 FROM pg_depend d WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = v_oid) THEN
    RAISE EXCEPTION 'search_attribution: an object depends on %; re-review before replacing it', v_fn;
  END IF;

  -- ── 1c. The per-field vectors the flags test are search_vector's parts ───────
  -- The attribution contract (a returned row flags the fields its terms came
  -- from) holds because search_vector is exactly the concatenation of the six
  -- per-field to_tsvector('english', …) expressions the flags evaluate. Pin
  -- C54's canonical stored expression, rendered under this file's path, and
  -- its GIN index.
  SELECT a.attgenerated::text || '|' || format_type(a.atttypid, a.atttypmod) || '|'
         || md5(pg_get_expr(d.adbin, d.adrelid))
    INTO v_text
    FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector' AND NOT a.attisdropped;
  IF v_text IS DISTINCT FROM 's|tsvector|8ddd960b4f4b11dd7afd35485d01fd25' THEN
    RAISE EXCEPTION 'search_attribution: papers.search_vector is not C54''s canonical stored expression (found %)', coalesce(v_text, '<missing>');
  END IF;

  IF to_regclass('public.idx_papers_search_vector') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_index i
                     WHERE i.indexrelid = to_regclass('public.idx_papers_search_vector')
                       AND i.indrelid = 'public.papers'::regclass
                       AND i.indisvalid AND i.indisready AND i.indislive)
     OR pg_get_indexdef(to_regclass('public.idx_papers_search_vector'))
          IS DISTINCT FROM 'CREATE INDEX idx_papers_search_vector ON public.papers USING gin (search_vector)' THEN
    RAISE EXCEPTION 'search_attribution: idx_papers_search_vector is missing, not valid/ready/live, or not GIN(search_vector)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_ts_config c
                  WHERE c.cfgname = 'english' AND c.cfgnamespace = 'pg_catalog'::regnamespace) THEN
    RAISE EXCEPTION 'search_attribution: the built-in text search configuration pg_catalog.english does not exist';
  END IF;

  -- ── 1d. The boundary search_papers runs under (C49), unchanged ──────────────
  -- As SECURITY INVOKER it reads papers as the caller: table SELECT plus the
  -- caller-owned RLS policies. Same formula and digest C49 pinned.
  IF NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = 'public.papers'::regclass AND c.relkind = 'r'
                    AND c.relowner = 'postgres'::regrole
                    AND c.relrowsecurity AND c.relforcerowsecurity)
     OR NOT has_table_privilege('authenticated', 'public.papers', 'SELECT')
     OR has_table_privilege('anon', 'public.papers', 'SELECT') THEN
    RAISE EXCEPTION 'search_attribution: papers is not the reviewed RLS-forced, authenticated-readable table';
  END IF;

  IF (SELECT md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s',
                                   c.relname, pol.polname, pol.polcmd, pol.polpermissive,
                                   (SELECT string_agg(rr.rn, ',' ORDER BY rr.rn)
                                      FROM (SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END AS rn
                                              FROM unnest(pol.polroles) r) rr),
                                   coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>'),
                                   coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')),
                            E'\n' ORDER BY c.relname, pol.polname))
        FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
       WHERE pol.polrelid IN ('public.papers'::regclass, 'public.synonym_pool'::regclass))
     IS DISTINCT FROM '07603cbe4e78a4d6097e7ec33bd1e6c8' THEN
    RAISE EXCEPTION 'search_attribution: the papers / synonym_pool RLS policy digest is not the reviewed one';
  END IF;

  -- ── 1e. Snapshots for section 3 ──────────────────────────────────────────────
  -- Transaction-local; read back in section 3.

  -- The target: its OID, its whole pg_proc row except the body, and the body.
  PERFORM set_config('paperlume.search_attribution.pre_oid', v_oid::text, true);
  PERFORM set_config('paperlume.search_attribution.pre_row',
    (SELECT md5((to_jsonb(p.*) - 'prosrc')::text) FROM pg_proc p WHERE p.oid = v_oid), true);
  PERFORM set_config('paperlume.search_attribution.pre_src',
    (SELECT p.prosrc FROM pg_proc p WHERE p.oid = v_oid), true);

  -- Every OTHER function in public, whole rows — search_papers_short included.
  PERFORM set_config('paperlume.search_attribution.pre_others',
    (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> v_oid), true);

  -- papers: owner, RLS flags and the WHOLE stored ACL; its generated-column
  -- default; and every index on it, as stored.
  PERFORM set_config('paperlume.search_attribution.pre_papers',
    (SELECT pg_get_userbyid(c.relowner) || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text
            || '|' || coalesce(c.relacl::text, 'NULL')
            || '|' || (SELECT md5(string_agg(d.oid::text || '=' || md5(to_jsonb(d.*)::text), E'\n' ORDER BY d.oid))
                         FROM pg_attrdef d WHERE d.adrelid = c.oid)
            || '|' || (SELECT md5(string_agg(i.indexrelid::text || '=' || md5((to_jsonb(i.*) - 'indcheckxmin')::text)
                                             || '=' || pg_get_indexdef(i.indexrelid), E'\n' ORDER BY i.indexrelid))
                         FROM pg_index i WHERE i.indrelid = c.oid)
       FROM pg_class c WHERE c.oid = 'public.papers'::regclass), true);
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The change — one CREATE OR REPLACE
-- ═════════════════════════════════════════════════════════════════════════════
--
-- CREATE OR REPLACE keeps ownership and permissions, but every other
-- attribute takes the value this statement states or implies. Every one of
-- them is therefore stated explicitly, at its current value, and section 3
-- proves none moved.

CREATE OR REPLACE FUNCTION public.search_papers(p_user_id uuid, p_query text, p_limit integer DEFAULT 1000, p_offset integer DEFAULT 0)
 RETURNS TABLE(paper_id uuid, rank real, matched_title boolean, matched_abstract boolean, matched_authors boolean, matched_journal boolean, matched_notes boolean, matched_keywords boolean)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 PARALLEL UNSAFE
 COST 100
 ROWS 1000
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ts_query_text TEXT;
  v_ts_query      tsquery;
  v_ts_any_text   TEXT;
  v_ts_any        tsquery;
BEGIN
  -- Ownership guard: defense-in-depth. This function is SECURITY INVOKER
  -- (C49): it reads papers as the caller, under the caller's own RLS. The
  -- check below additionally refuses a missing or mismatched caller identity
  -- before any row is read.
  IF p_user_id IS NULL
     OR auth.uid() IS NULL
     OR p_user_id <> auth.uid()
  THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  -- Sanitize + tokenize identically to migration 20260417030000:
  -- strip the ten tsquery operator/control characters, whitespace-split,
  -- append :* to each non-empty token, &-join. Unicode passes through.
  -- The same tokens are also |-joined, in the same pass, for the per-field
  -- attribution below (C58).
  SELECT string_agg(tok || ':*', ' & '),
         string_agg(tok || ':*', ' | ')
    INTO v_ts_query_text, v_ts_any_text
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
  v_ts_any   := to_tsquery('english', v_ts_any_text);

  RETURN QUERY
  SELECT
    p.id AS paper_id,
    ts_rank(p.search_vector, v_ts_query) AS rank,
    -- Per-field attribution — contributing fields (C58). Membership and rank
    -- use v_ts_query: a row must hold EVERY effective query term somewhere in
    -- search_vector, possibly spread across fields. Each flag tests that
    -- field's own tsvector against v_ts_any — the same prefix-aware terms,
    -- OR-ed — so a flag is true iff that field contains at least one
    -- effective query term. It does not mean the field alone satisfies the
    -- whole query. Stopwords drop out of both queries alike, so they never
    -- flag a field. search_vector is the concatenation of these six vectors,
    -- so a returned row has at least one true flag unless every term is a
    -- punctuation-joined phrase (e.g. a,b → 'a' <-> 'b') that matched only
    -- across the seam between two fields (known limitation, C58).
    to_tsvector('english', coalesce(p.title, ''))            @@ v_ts_any AS matched_title,
    to_tsvector('english', coalesce(p.abstract, ''))         @@ v_ts_any AS matched_abstract,
    to_tsvector('english', coalesce(p.authors::text, ''))    @@ v_ts_any AS matched_authors,
    to_tsvector('english', coalesce(p.journal, ''))          @@ v_ts_any AS matched_journal,
    to_tsvector('english', coalesce(p.notes, ''))            @@ v_ts_any AS matched_notes,
    to_tsvector('english', coalesce(p.keywords::text, ''))   @@ v_ts_any AS matched_keywords
  FROM papers p
  WHERE p.user_id = p_user_id
    AND p.search_vector @@ v_ts_query
  ORDER BY rank DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed verification — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

DO $verify$
DECLARE
  v_fn    CONSTANT TEXT := 'public.search_papers(uuid,text,integer,integer)';
  v_oid   OID;
  v_old   TEXT;
  v_new   TEXT;
  v_text  TEXT;
  v_base  TEXT;
  v_frag  TEXT;
  v_field TEXT;
  v_expr  TEXT;
BEGIN
  -- ── 3a. Replaced in place: same OID, same row except the body ───────────────
  v_oid := to_regprocedure(v_fn);
  IF v_oid IS NULL OR v_oid::text IS DISTINCT FROM current_setting('paperlume.search_attribution.pre_oid', true) THEN
    RAISE EXCEPTION 'search_attribution: % was not replaced in place (OID before %, after %)',
      v_fn, current_setting('paperlume.search_attribution.pre_oid', true), v_oid;
  END IF;

  -- Signature, argument names and defaults, result, language, owner, security
  -- mode, volatility, parallel mode, strictness, leakproofness, cost, rows,
  -- search_path and ACL: the whole pg_proc row except prosrc is unchanged.
  IF (SELECT md5((to_jsonb(p.*) - 'prosrc')::text) FROM pg_proc p WHERE p.oid = v_oid)
       IS DISTINCT FROM current_setting('paperlume.search_attribution.pre_row', true)
     OR coalesce(current_setting('paperlume.search_attribution.pre_row', true), '') = '' THEN
    RAISE EXCEPTION 'search_attribution: an attribute of % other than its body changed', v_fn;
  END IF;

  -- The same facts restated literally, so a failure names the attribute.
  SELECT (SELECT count(*) FROM pg_proc p2 WHERE p2.pronamespace = p.pronamespace AND p2.proname = p.proname)::text
         || '|' || pg_get_userbyid(p.proowner)
         || '|' || (SELECT l.lanname FROM pg_language l WHERE l.oid = p.prolang)
         || '|secdef=' || p.prosecdef::text || '|vol=' || p.provolatile::text || '|par=' || p.proparallel::text
         || '|' || coalesce(array_to_string(p.proconfig, ','), '<no config>')
         || '|' || pg_get_function_result(p.oid)
         || '|' || pg_get_function_arguments(p.oid)
         || '|acl=' || coalesce(p.proacl::text, 'NULL')
    INTO v_text
    FROM pg_proc p WHERE p.oid = v_oid;
  IF v_text IS DISTINCT FROM
       '1|postgres|plpgsql|secdef=false|vol=v|par=u|search_path=public'
       || '|TABLE(paper_id uuid, rank real, matched_title boolean, matched_abstract boolean, matched_authors boolean, matched_journal boolean, matched_notes boolean, matched_keywords boolean)'
       || '|p_user_id uuid, p_query text, p_limit integer DEFAULT 1000, p_offset integer DEFAULT 0'
       || '|acl={postgres=X/postgres,authenticated=X/postgres}' THEN
    RAISE EXCEPTION 'search_attribution: % is not in the reviewed shape after the change: %', v_fn, v_text;
  END IF;

  IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'search_attribution: the effective EXECUTE posture of % changed', v_fn;
  END IF;

  -- ── 3b. The body is exactly the reviewed one ────────────────────────────────
  v_old := current_setting('paperlume.search_attribution.pre_src', true);
  SELECT p.prosrc INTO v_new FROM pg_proc p WHERE p.oid = v_oid;
  IF md5(coalesce(v_old, '')) IS DISTINCT FROM 'd4a5f3afdc485d5dfda8e0798c61cc48' THEN
    RAISE EXCEPTION 'search_attribution: the recorded previous body is not the reviewed one';
  END IF;
  IF md5(v_new) IS DISTINCT FROM '1a72d57a585779644c00636f0da3b253' THEN
    RAISE EXCEPTION 'search_attribution: the new body of % is not the reviewed one (md5 %)', v_fn, md5(v_new);
  END IF;

  -- ── 3c. Membership and rank: the same text before and after ─────────────────
  -- Each fragment below decides which rows come back or their order. Each must
  -- occur exactly once in the reviewed previous body AND in the new one.
  FOREACH v_frag IN ARRAY ARRAY[
    $frag$  IF p_user_id IS NULL
     OR auth.uid() IS NULL
     OR p_user_id <> auth.uid()
  THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;$frag$,
    $frag$SELECT string_agg(tok || ':*', ' & ')$frag$,
    $frag$    FROM (
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
    ) s;$frag$,
    $frag$  IF v_ts_query_text IS NULL OR v_ts_query_text = '' THEN
    RETURN;
  END IF;$frag$,
    $frag$  v_ts_query := to_tsquery('english', v_ts_query_text);$frag$,
    $frag$    p.id AS paper_id,
    ts_rank(p.search_vector, v_ts_query) AS rank,$frag$,
    $frag$  FROM papers p
  WHERE p.user_id = p_user_id
    AND p.search_vector @@ v_ts_query
  ORDER BY rank DESC
  LIMIT p_limit OFFSET p_offset;
END;$frag$
  ] LOOP
    IF (length(v_old) - length(replace(v_old, v_frag, ''))) / length(v_frag) <> 1
       OR (length(v_new) - length(replace(v_new, v_frag, ''))) / length(v_frag) <> 1 THEN
      RAISE EXCEPTION E'search_attribution: a membership/rank fragment is not present exactly once in both bodies:\n%', v_frag;
    END IF;
  END LOOP;

  -- The membership query is used exactly twice — rank and WHERE — and the
  -- attribution query only in the six flags.
  IF (length(v_new) - length(replace(v_new, 'v_ts_query)', ''))) / length('v_ts_query)') <> 1
     OR (length(v_new) - length(replace(v_new, '@@ v_ts_query', ''))) / length('@@ v_ts_query') <> 1
     OR (length(v_new) - length(replace(v_new, '@@ v_ts_any AS matched_', ''))) / length('@@ v_ts_any AS matched_') <> 6
     OR position('v_ts_any   := to_tsquery(''english'', v_ts_any_text);' IN v_new) = 0
     OR position('string_agg(tok || '':*'', '' | '')' IN v_new) = 0 THEN
    RAISE EXCEPTION 'search_attribution: the membership and attribution queries are not used exactly where reviewed';
  END IF;

  -- ── 3d. Only the attribution query changed in the six flags ─────────────────
  -- For each field, the previous body tested exactly this per-field vector
  -- against v_ts_query, and the new body tests the identical vector against
  -- v_ts_any.
  FOR v_field, v_expr IN
    SELECT f.fld, f.expr FROM (VALUES
      ('title',    $e$to_tsvector('english', coalesce(p.title, ''))            @@ $e$),
      ('abstract', $e$to_tsvector('english', coalesce(p.abstract, ''))         @@ $e$),
      ('authors',  $e$to_tsvector('english', coalesce(p.authors::text, ''))    @@ $e$),
      ('journal',  $e$to_tsvector('english', coalesce(p.journal, ''))          @@ $e$),
      ('notes',    $e$to_tsvector('english', coalesce(p.notes, ''))            @@ $e$),
      ('keywords', $e$to_tsvector('english', coalesce(p.keywords::text, ''))   @@ $e$)) AS f(fld, expr)
  LOOP
    IF position(v_expr || 'v_ts_query AS matched_' || v_field IN v_old) = 0
       OR position(v_expr || 'v_ts_any AS matched_' || v_field IN v_new) = 0
       OR position('AS matched_' || v_field IN v_new) = 0 THEN
      RAISE EXCEPTION 'search_attribution: the % flag is not the reviewed per-field expression', v_field;
    END IF;
  END LOOP;

  -- ── 3e. The two stale statements are gone ───────────────────────────────────
  IF position('DEFINER' IN v_new) > 0
     OR position('bypasses table-level RLS' IN v_new) > 0
     OR position('at least one of these will also be true' IN v_new) > 0 THEN
    RAISE EXCEPTION 'search_attribution: the new body still carries a stale security or attribution comment';
  END IF;

  -- ── 3f. Nothing else in public moved ─────────────────────────────────────────
  v_base := current_setting('paperlume.search_attribution.pre_others', true);
  IF coalesce(v_base, '') = ''
     OR (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> v_oid) IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'search_attribution: a function other than search_papers changed';
  END IF;

  IF (SELECT md5(p.prosrc) || '|' || p.provolatile::text || '|' || p.prosecdef::text
        FROM pg_proc p WHERE p.oid = 'public.search_papers_short(uuid,text)'::regprocedure)
     IS DISTINCT FROM 'ce353564edcb73a5466092e84d0b8d1b|s|false' THEN
    RAISE EXCEPTION 'search_attribution: search_papers_short is not its reviewed, untouched self';
  END IF;

  -- ── 3g. search_vector, its index and the papers boundary are unchanged ──────
  IF (SELECT pg_get_userbyid(c.relowner) || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text
             || '|' || coalesce(c.relacl::text, 'NULL')
             || '|' || (SELECT md5(string_agg(d.oid::text || '=' || md5(to_jsonb(d.*)::text), E'\n' ORDER BY d.oid))
                          FROM pg_attrdef d WHERE d.adrelid = c.oid)
             || '|' || (SELECT md5(string_agg(i.indexrelid::text || '=' || md5((to_jsonb(i.*) - 'indcheckxmin')::text)
                                              || '=' || pg_get_indexdef(i.indexrelid), E'\n' ORDER BY i.indexrelid))
                          FROM pg_index i WHERE i.indrelid = c.oid)
        FROM pg_class c WHERE c.oid = 'public.papers'::regclass)
     IS DISTINCT FROM current_setting('paperlume.search_attribution.pre_papers', true)
     OR coalesce(current_setting('paperlume.search_attribution.pre_papers', true), '') = '' THEN
    RAISE EXCEPTION 'search_attribution: papers'' owner, RLS flags, ACL, column defaults or indexes changed';
  END IF;

  IF (SELECT md5(pg_get_expr(d.adbin, d.adrelid))
        FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector')
     IS DISTINCT FROM '8ddd960b4f4b11dd7afd35485d01fd25' THEN
    RAISE EXCEPTION 'search_attribution: papers.search_vector is no longer C54''s canonical expression';
  END IF;

  IF (SELECT md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s',
                                   c.relname, pol.polname, pol.polcmd, pol.polpermissive,
                                   (SELECT string_agg(rr.rn, ',' ORDER BY rr.rn)
                                      FROM (SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END AS rn
                                              FROM unnest(pol.polroles) r) rr),
                                   coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>'),
                                   coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')),
                            E'\n' ORDER BY c.relname, pol.polname))
        FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
       WHERE pol.polrelid IN ('public.papers'::regclass, 'public.synonym_pool'::regclass))
     IS DISTINCT FROM '07603cbe4e78a4d6097e7ec33bd1e6c8' THEN
    RAISE EXCEPTION 'search_attribution: an RLS policy on papers / synonym_pool changed';
  END IF;

  -- ── 3h. Catalog-only: this transaction wrote no row ─────────────────────────
  v_base := current_setting('paperlume.search_attribution.xact_writes_at_start', true);
  IF coalesce(v_base, '') = '' THEN
    RAISE EXCEPTION 'search_attribution: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  SELECT string_agg(
           n.nspname || '.' || c.relname || '=' || (pg_stat_get_xact_tuples_inserted(c.oid)
                                                    + pg_stat_get_xact_tuples_updated(c.oid)
                                                    + pg_stat_get_xact_tuples_deleted(c.oid)),
           ' ' ORDER BY n.nspname, c.relname)
    INTO v_text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p');
  IF v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'search_attribution: this transaction wrote rows to a public/auth/storage table';
  END IF;
END
$verify$;

COMMIT;
