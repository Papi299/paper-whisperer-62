-- DB-SEARCH-VECTOR-EXPRESSION-PARITY-001 — one canonical generation expression
-- for `public.papers.search_vector`: the direct built-in representation that
-- hosted Production already stores.
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- Every database built from this repository ends with exactly one stored
-- generation expression for papers.search_vector:
--
--   setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A')
--   || setweight(to_tsvector('english'::regconfig, COALESCE(abstract, ''::text)), 'B')
--   || setweight(to_tsvector('english'::regconfig, COALESCE(journal, ''::text)), 'C')
--   || setweight(to_tsvector('english'::regconfig, COALESCE(authors::text, ''::text)), 'C')
--   || setweight(to_tsvector('english'::regconfig, COALESCE(keywords::text, ''::text)), 'C')
--   || setweight(to_tsvector('english'::regconfig, COALESCE(notes, ''::text)), 'D')
--
-- rendered by pg_get_expr under this file's pinned search_path as
-- md5 8ddd960b4f4b11dd7afd35485d01fd25. It calls only three built-ins,
-- setweight(tsvector,"char"), to_tsvector(regconfig,text) and
-- tsvector_concat(tsvector,tsvector); `authors::text` / `keywords::text` are
-- jsonb output-function coercions (jsonb_out, IMMUTABLE).
--
-- How a database gets there depends on where it starts. Exactly two starting
-- representations are accepted; any third is refused before anything moves:
--
--   DIRECT BUILT-IN  8ddd960b4f4b11dd7afd35485d01fd25 — hosted Production.
--     Already canonical. The file is a schema NO-OP here: no ALTER TABLE, no
--     explicit lock, no table rewrite, no index rebuild, no ANALYZE, no row
--     write. It performs validation reads only, and section 4 proves that the
--     table, its TOAST relation, every index and the column default kept their
--     physical identity and that no lock stronger than ACCESS SHARE was taken.
--     The only durable effect of deploying it there is its migration-ledger row.
--
--   CLEAN-REPLAY WRAPPER  dd69f099a274a9cdc0f174ae0883ddb6 — every
--     `supabase db reset`, CI run and rebuild from this repository. The same
--     six fields, weights and configuration, but written as calls to
--     public.immutable_english_tsvector_text(text) and
--     public.immutable_english_tsvector_jsonb(jsonb). Here, and only here, the
--     file takes ACCESS EXCLUSIVE on papers, re-checks every precondition under
--     the lock, and runs one
--       ALTER TABLE public.papers ALTER COLUMN search_vector SET EXPRESSION AS (…)
--     followed by ANALYZE public.papers (search_vector).
--
-- SET EXPRESSION (PostgreSQL 17+) keeps the column — same attnum, type, STORED
-- generation and nullability — so nothing that names the column breaks. It
-- rewrites the heap and every index (new relfilenodes), re-creates the one
-- index ON the column (idx_papers_search_vector gets a new OID, same
-- definition), fires no row trigger and clears the column's statistics — hence
-- the ANALYZE. PostgreSQL rewrites even when the new expression is identical,
-- which is why the direct representation must take a branch that never issues
-- it. DROP + ADD of the column is not used: it would append a new attnum and
-- drop the index with it.
--
-- WHY THERE WERE TWO REPRESENTATIONS — the corrected explanation
-- ─────────────────────────────────────────────────────────────────────────────
-- Different SQL text was executed, and nothing else.
--
--   * Hosted Production's column was created in April 2026 by the ORIGINAL
--     text of 20260420010000 (commit c6434de), which called
--     to_tsvector('english', coalesce(<field>, '')) directly (with ::text on
--     the two jsonb fields). Its
--     attrdef, attnum and GIN index all date from that one transaction.
--   * On 2026-05-18 (commit e4c5931) 20260305020000, 20260417020000 and
--     20260420010000 were rewritten to call the immutable_english_tsvector_*
--     wrappers so that a fresh replay would pass, and the already-applied April
--     versions were recorded in Production with `supabase migration repair`.
--     The ledger rows therefore store the rewritten statements, but that text
--     never ran on Production. The wrappers themselves first reached Production
--     with 20260331010000 in that same 2026-05-18 push, after the column
--     already existed.
--   * A clean replay executes the rewritten files, so it stores wrapper calls;
--     Production stores what its original text said.
--
-- PostgreSQL did not transform wrapper calls into built-in calls while
-- storing the expression. A generated-column expression is stored as parsed:
-- a wrapper call stays a function-call node with a pg_depend edge on the
-- wrapper, whatever the wrapper's proconfig. SQL-function inlining is a
-- different mechanism — a planner step at execution time — and never rewrites
-- a stored expression. Historical migration comments that describe
-- Production's form as "inlined", or say PostgreSQL inlines simple SQL
-- functions when it stores a generated-column expression (20260719162013,
-- 20260810152125 and 20260927001229), are wrong on that point. So is
-- 20260305020000's header on two facts: there is no to_tsvector(text,text)
-- overload (a 'english'::regconfig argument selects IMMUTABLE
-- to_tsvector(regconfig,text)), and jsonb_out is IMMUTABLE. Section 2
-- verifies both. The applied files are immutable history and are NOT edited;
-- decision C54 in docs/decisions-and-triggers.md records the correction.
--
-- WHY CONVERGE, AND WHY ON THE DIRECT FORM
-- ─────────────────────────────────────────────────────────────────────────────
-- C26 (2026-07-19) established that the two expressions produce identical
-- stored values and deliberately kept both rather than rewrite Production.
-- That finding still holds, and C26 is not reversed: C54 supersedes the
-- dual-representation posture from here on. Two shapes meant every later
-- migration and suite that touches papers had to accept both (C51–C53 did),
-- and the wrapper shape carries hazards the built-ins do not:
--   * DROP FUNCTION … CASCADE on a wrapper drops search_vector and its index;
--   * CREATE OR REPLACE of a wrapper body leaves every stored vector computed
--     by the old body, silently stale;
--   * revoking wrapper EXECUTE breaks every INSERT and UPDATE of papers,
--     because the expression is evaluated as the writing user.
-- The built-ins are owned by the bootstrap superuser and cannot be replaced,
-- dropped or revoked by the migration owner. Choosing Production's existing
-- form means the one environment with real data needs no rewrite at all.
--
-- The three wrappers are NOT dropped, altered or re-granted here. After this
-- file nothing in papers.search_vector depends on them; retiring them is a
-- separate, future decision.
--
-- SEMANTIC PRECONDITION — validation only
-- ─────────────────────────────────────────────────────────────────────────────
-- Before either branch proceeds, every stored search_vector must already equal
-- the canonical direct expression evaluated over the same row — as tsvector
-- values AND byte for byte (tsvectorsend). Nothing is modified to make that
-- hold. The file runs with row_security = off as a role that bypasses RLS, so
-- the check sees every row or fails loudly; it can never pass vacuously
-- because RLS hid rows. Suite 024 carries the corpus evidence that the two
-- expressions agree on NULL, empty, whitespace, punctuation, case, prose,
-- stopwords, numbers, Unicode, composed/decomposed accents, emoji/ZWJ,
-- empty/nested/scalar/mixed JSON, quotes, backslashes, SQL-like text, swapped
-- JSON ordering, large text and every field weight.
--
-- CONCURRENCY, LOCKS AND COST
-- ─────────────────────────────────────────────────────────────────────────────
-- Every lock this file waits for, it waits for at most lock_timeout = 5s; on
-- timeout the statement fails and the whole file rolls back with nothing
-- changed. The direct branch reads papers under ACCESS SHARE only, so it
-- neither blocks nor is blocked by ordinary reads and writes. The wrapper
-- branch holds ACCESS EXCLUSIVE on papers from section 1 to COMMIT; it runs
-- only where a database was replayed from this repository.
--
-- The file is explicitly transactional (see 20260910212202 for why
-- `supabase db reset` requires that): classification, lock, preconditions,
-- rewrite and verification commit together or not at all.
--
-- PRODUCTION PROJECTION
-- ─────────────────────────────────────────────────────────────────────────────
-- Verified read-only on 2026-09-27 (PostgreSQL 17.6; ledger 93, latest
-- 20260927123856): search_vector at 8ddd960b… (attnum 29, attrdef OID 59954),
-- its normal dependencies exactly the six input columns and pg_ts_config
-- english, idx_papers_search_vector (OID 61100) valid and ready, and the three
-- wrappers (OIDs 66407–66409) with zero dependents. A separately authorized
-- rollout is therefore expected to take the DIRECT branch: one ledger row, no
-- ALTER TABLE, no rewrite, no index rebuild, no ANALYZE, no application-data
-- write, and the expression unchanged.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- Forward-fix preferred. In Production nothing changes, so there is nothing to
-- roll back. On a replayed database the pre-change expression can be restored
-- with ALTER TABLE … SET EXPRESSION AS (the wrapper form in 20260420010000),
-- another rewrite with the same values. See docs/deployment.md §6.15.
--
-- Durable decision: C54.

BEGIN;

-- Transaction-local, so COMMIT restores the runner's own settings:
--   * one fixed rendering path, so every catalog value this file renders and
--     compares (the expression, dependencies, signatures, index, constraint,
--     policy and trigger text) reads the same under any migration runner, and
--     the canonical expression below resolves only built-ins;
--   * a bounded wait for every lock;
--   * RLS that fails loudly instead of filtering, so a semantic check can
--     never pass because rows were hidden from it.
-- Section 0 proves all three took effect, which also proves this file is
-- running inside one transaction (outside one, SET LOCAL only warns).
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context, and this transaction's own write counters
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only the table owner (postgres) can change a column's generation expression
-- or ANALYZE it, and the semantic precondition must read every row. Section 4
-- proves this transaction wrote no row to any table in `public`, `auth` or
-- `storage`, from PostgreSQL's per-transaction statistics (see 20260924193915
-- §0 for why the baseline is taken here). A table rewrite is not a row write:
-- it does not move these counters.

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'search_vector_parity: must run as postgres (current_user is %) — only the owner of public.papers can change its generation expression',
      current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'search_vector_parity: % does not bypass RLS, so the semantic precondition could not read every row of public.papers',
      current_user;
  END IF;

  IF current_setting('search_path') IS DISTINCT FROM 'pg_catalog, pg_temp'
     OR current_setting('lock_timeout') IS DISTINCT FROM '5s'
     OR current_setting('row_security') IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'search_vector_parity: the transaction-local settings are not in effect (search_path %, lock_timeout %, row_security %) — this file must run as one transaction',
      current_setting('search_path'), current_setting('lock_timeout'), current_setting('row_security');
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'search_vector_parity: track_counts is off, so the no-write self-check could not observe anything';
  END IF;

  PERFORM set_config(
    'paperlume.search_vector_parity.xact_writes_at_start',
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
-- 1. Classify the starting representation; lock only for the rewrite
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A catalog read of the stored expression's digest, before any table lock.
-- The direct representation takes the no-op branch and never asks for a
-- stronger lock. The wrapper representation takes ACCESS EXCLUSIVE here —
-- waiting at most lock_timeout — so that EVERY precondition in section 2 is
-- evaluated while it is held. A third digest is refused before any lock.

DO $classify$
DECLARE
  v_md5 TEXT;
BEGIN
  SELECT md5(pg_get_expr(d.adbin, d.adrelid)) INTO v_md5
  FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector' AND NOT a.attisdropped;

  IF v_md5 = '8ddd960b4f4b11dd7afd35485d01fd25' THEN
    PERFORM set_config('paperlume.search_vector_parity.branch', 'noop', true);
  ELSIF v_md5 = 'dd69f099a274a9cdc0f174ae0883ddb6' THEN
    PERFORM set_config('paperlume.search_vector_parity.branch', 'rewrite', true);
    LOCK TABLE public.papers IN ACCESS EXCLUSIVE MODE;
  ELSE
    RAISE EXCEPTION 'search_vector_parity: STOP — papers.search_vector is neither reviewed representation (expression md5 %); reviewed: direct built-in 8ddd960b… (hosted Production) or clean-replay wrapper dd69f099… (DB-SEARCH-VECTOR-EXPRESSION-PARITY-001)',
      coalesce(v_md5, '<missing>');
  END IF;
END
$classify$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Preconditions — the exact state this change was reviewed against
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Verified read-only against Production and on a clean local replay on
-- 2026-09-27. OIDs and attnums differ between environments, so they are not
-- pinned; section 4 proves they were preserved. Nothing here repairs
-- unexpected state: any mismatch rolls the whole file back before anything
-- changes. The snapshots at the end of this block are what section 4
-- compares against.

DO $pre$
DECLARE
  v_branch         CONSTANT TEXT := current_setting('paperlume.search_vector_parity.branch', true);
  v_text           TEXT;
  v_want           TEXT;
  v_count          INTEGER;
  v_md5            TEXT;
  v_deps           TEXT;
  v_calls          OID[];
  v_direct_calls   OID[];
  v_wrapper_calls  OID[];
  v_shape          TEXT;
  v_all            CONSTANT TEXT[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
BEGIN
  IF v_branch IS NULL OR v_branch NOT IN ('noop', 'rewrite') THEN
    RAISE EXCEPTION 'search_vector_parity: section 1 did not classify the representation (branch %) — this file must run as one transaction',
      coalesce(v_branch, '<unset>');
  END IF;

  -- ── 2a. The lock posture of each branch ─────────────────────────────────────
  -- The rewrite branch really holds ACCESS EXCLUSIVE before any check below;
  -- the no-op branch holds nothing stronger than ACCESS SHARE on papers or any
  -- of its indexes (section 4 repeats this after every read).
  IF v_branch = 'rewrite' AND NOT EXISTS (
       SELECT 1 FROM pg_locks l
        WHERE l.locktype = 'relation' AND l.pid = pg_backend_pid() AND l.granted
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.relation = 'public.papers'::regclass AND l.mode = 'AccessExclusiveLock') THEN
    RAISE EXCEPTION 'search_vector_parity: the rewrite branch does not hold ACCESS EXCLUSIVE on public.papers';
  END IF;

  IF v_branch = 'noop' THEN
    SELECT coalesce(string_agg(DISTINCT l.relation::regclass::text || ' ' || l.mode, ', '), '') INTO v_text
    FROM pg_locks l
    WHERE l.locktype = 'relation' AND l.pid = pg_backend_pid()
      AND l.relation IN (SELECT 'public.papers'::regclass UNION ALL
                         SELECT i.indexrelid FROM pg_index i WHERE i.indrelid = 'public.papers'::regclass)
      AND l.mode <> 'AccessShareLock';
    IF v_text <> '' THEN
      RAISE EXCEPTION 'search_vector_parity: the no-op branch holds a lock stronger than ACCESS SHARE: %', v_text;
    END IF;
  END IF;

  -- ── 2b. Roles ───────────────────────────────────────────────────────────────
  -- `authenticated` evaluates the expression on every direct and RPC write of
  -- papers, so it must exist and be an ordinary, RLS-subject role.
  IF to_regrole('authenticated') IS NULL OR to_regrole('anon') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'search_vector_parity: one of the roles authenticated / anon / service_role does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'search_vector_parity: authenticated is SUPERUSER or BYPASSRLS';
  END IF;

  -- ── 2c. The built-ins the canonical expression calls ────────────────────────
  -- One reviewed signature per row, each required to resolve — never a list
  -- joined and split on commas (`setweight(tsvector,"char")` contains one).
  -- Each must be a pg_catalog IMMUTABLE, non-SECURITY-DEFINER function that
  -- `authenticated` can EXECUTE; jsonb_out is the output function behind
  -- `authors::text` / `keywords::text` and must be IMMUTABLE too.
  SELECT string_agg(format('%s|resolved=%s|schema=%s|vol=%s|secdef=%s|authenticated=%s',
                           w.sig, (p.oid IS NOT NULL)::text, coalesce(p.pronamespace::regnamespace::text, '-'),
                           coalesce(p.provolatile::text, '-'), coalesce(p.prosecdef::text, '-'),
                           coalesce(has_function_privilege('authenticated', p.oid, 'EXECUTE')::text, '-')),
                    E'\n' ORDER BY w.sig COLLATE "C") INTO v_text
  FROM (VALUES ('pg_catalog.jsonb_out(jsonb)'),
               ('pg_catalog.setweight(tsvector,"char")'),
               ('pg_catalog.to_tsvector(regconfig,text)'),
               ('pg_catalog.tsvector_concat(tsvector,tsvector)')) AS w(sig)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.sig);
  SELECT string_agg(w.line, E'\n' ORDER BY w.line COLLATE "C") INTO v_want
  FROM (VALUES
    ('pg_catalog.jsonb_out(jsonb)|resolved=true|schema=pg_catalog|vol=i|secdef=false|authenticated=true'),
    ('pg_catalog.setweight(tsvector,"char")|resolved=true|schema=pg_catalog|vol=i|secdef=false|authenticated=true'),
    ('pg_catalog.to_tsvector(regconfig,text)|resolved=true|schema=pg_catalog|vol=i|secdef=false|authenticated=true'),
    ('pg_catalog.tsvector_concat(tsvector,tsvector)|resolved=true|schema=pg_catalog|vol=i|secdef=false|authenticated=true')
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'search_vector_parity: the built-ins of the canonical expression are not the reviewed ones.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  -- The two facts 20260305020000's header got wrong, verified rather than
  -- assumed: no to_tsvector(text,text) overload exists, and `english` is the
  -- pg_catalog text-search configuration.
  IF to_regprocedure('pg_catalog.to_tsvector(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'search_vector_parity: an unreviewed pg_catalog.to_tsvector(text,text) overload exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'english' AND cfgnamespace = 'pg_catalog'::regnamespace) THEN
    RAISE EXCEPTION 'search_vector_parity: the pg_catalog.english text-search configuration is missing';
  END IF;

  -- The two reviewed call sets, as OIDs resolved one signature per row.
  SELECT array_agg(to_regprocedure(s)::oid ORDER BY to_regprocedure(s)::oid), count(*) FILTER (WHERE to_regprocedure(s) IS NULL)
    INTO v_direct_calls, v_count
  FROM (VALUES ('pg_catalog.setweight(tsvector,"char")'),
               ('pg_catalog.to_tsvector(regconfig,text)'),
               ('pg_catalog.tsvector_concat(tsvector,tsvector)')) AS w(s);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'search_vector_parity: % reviewed direct-expression callee(s) do not resolve', v_count;
  END IF;
  SELECT array_agg(to_regprocedure(s)::oid ORDER BY to_regprocedure(s)::oid), count(*) FILTER (WHERE to_regprocedure(s) IS NULL)
    INTO v_wrapper_calls, v_count
  FROM (VALUES ('public.immutable_english_tsvector_jsonb(jsonb)'),
               ('public.immutable_english_tsvector_text(text)'),
               ('pg_catalog.setweight(tsvector,"char")'),
               ('pg_catalog.tsvector_concat(tsvector,tsvector)')) AS w(s);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'search_vector_parity: % reviewed wrapper-expression callee(s) do not resolve', v_count;
  END IF;

  -- ── 2d. The three wrappers — exactly the reviewed functions ─────────────────
  -- On the wrapper branch their bodies ARE the stored values' definition, so a
  -- drifted body (which CREATE OR REPLACE would allow without touching a
  -- stored vector) must stop the rewrite. On the direct branch they are
  -- unreferenced but still pinned, and section 4 proves they did not move.
  -- Both of their reviewed EXECUTE ACL representations are accepted — NULL on
  -- a replay, the explicit hosted form in Production (C51) — provided all
  -- three share one.
  SELECT string_agg(format('%s|owner=%s|lang=%s|vol=%s|parallel=%s|secdef=%s|strict=%s|leakproof=%s|result=%s|args=[%s]|config=%s|body=%s',
                           w.sig, pg_get_userbyid(p.proowner), l.lanname, p.provolatile, p.proparallel, p.prosecdef,
                           p.proisstrict, p.proleakproof, pg_get_function_result(p.oid), pg_get_function_arguments(p.oid),
                           p.proconfig::text, md5(p.prosrc)),
                    E'\n' ORDER BY w.sig COLLATE "C") INTO v_text
  FROM (VALUES ('public.immutable_english_tsvector_jsonb(jsonb)'),
               ('public.immutable_english_tsvector_text(text)'),
               ('public.immutable_english_tsvector_textarr(text[])')) AS w(sig)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.sig)
  LEFT JOIN pg_language l ON l.oid = p.prolang;
  SELECT string_agg(w.line, E'\n' ORDER BY w.line COLLATE "C") INTO v_want
  FROM (VALUES
    ('public.immutable_english_tsvector_jsonb(jsonb)|owner=postgres|lang=sql|vol=i|parallel=s|secdef=f|strict=f|leakproof=f|result=tsvector|args=[j jsonb]|config={"search_path=pg_catalog, pg_temp"}|body=30c015cd34f5ed6cbe9b1e8f0626cd5e'),
    ('public.immutable_english_tsvector_text(text)|owner=postgres|lang=sql|vol=i|parallel=s|secdef=f|strict=f|leakproof=f|result=tsvector|args=[t text]|config={"search_path=pg_catalog, pg_temp"}|body=26edc211280ccfa3050b5d16f3caa75d'),
    ('public.immutable_english_tsvector_textarr(text[])|owner=postgres|lang=sql|vol=i|parallel=s|secdef=f|strict=f|leakproof=f|result=tsvector|args=[arr text[]]|config={"search_path=pg_catalog, pg_temp"}|body=19261084e62e923f83ab83abb7d5ed66')
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'search_vector_parity: the immutable_english_tsvector_* wrappers are not the reviewed functions.\nfound:\n%\nexpected:\n%',
      coalesce(v_text, '<missing>'), v_want;
  END IF;

  SELECT count(DISTINCT coalesce(p.proacl::text, '<default>')), min(coalesce(p.proacl::text, '<default>')) INTO v_count, v_text
  FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.immutable_english_tsvector_jsonb(jsonb)'),
                  to_regprocedure('public.immutable_english_tsvector_text(text)'),
                  to_regprocedure('public.immutable_english_tsvector_textarr(text[])'));
  IF v_count <> 1 OR v_text NOT IN ('<default>',
       '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'search_vector_parity: the wrappers'' EXECUTE ACLs are not one of the two reviewed representations (% distinct; %)', v_count, v_text;
  END IF;

  -- ── 2e. The stored expression: digest, dependencies and actual calls ────────
  -- All three must match ONE reviewed representation, and it must be the one
  -- section 1 classified. Dependencies are every pg_depend row of the column
  -- default, rendered by name under the pinned path; calls are every function
  -- or operator-function OID in the stored node tree, compared as OIDs.
  SELECT md5(pg_get_expr(d.adbin, d.adrelid)),
         (SELECT string_agg(x.line, E'\n' ORDER BY x.line COLLATE "C")
            FROM (SELECT CASE dd.refclassid
                           WHEN 'pg_class'::regclass THEN 'pg_class:' || dd.refobjid::regclass::text || '.'
                                || coalesce((SELECT att.attname::text FROM pg_attribute att
                                              WHERE att.attrelid = dd.refobjid AND att.attnum = dd.refobjsubid), '#' || dd.refobjsubid::text)
                           WHEN 'pg_proc'::regclass THEN 'pg_proc:' || dd.refobjid::regprocedure::text
                           WHEN 'pg_ts_config'::regclass THEN 'pg_ts_config:' || dd.refobjid::regconfig::text
                           ELSE dd.refclassid::regclass::text || ':' || dd.refobjid::text || '.' || dd.refobjsubid::text
                         END || '|' || dd.deptype::text AS line
                    FROM pg_depend dd
                   WHERE dd.classid = 'pg_attrdef'::regclass AND dd.objid = d.oid) x),
         (SELECT array_agg(DISTINCT m[1]::oid ORDER BY m[1]::oid)
            FROM regexp_matches(d.adbin::text, ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m)
    INTO v_md5, v_deps, v_calls
  FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector';

  IF v_md5 = '8ddd960b4f4b11dd7afd35485d01fd25'
     AND v_deps = 'pg_class:public.papers.abstract|n' || E'\n' || 'pg_class:public.papers.authors|n' || E'\n'
                  || 'pg_class:public.papers.journal|n' || E'\n' || 'pg_class:public.papers.keywords|n' || E'\n'
                  || 'pg_class:public.papers.notes|n' || E'\n' || 'pg_class:public.papers.search_vector|i' || E'\n'
                  || 'pg_class:public.papers.title|n' || E'\n' || 'pg_ts_config:english|n'
     AND v_calls = v_direct_calls THEN
    v_shape := 'direct';
  ELSIF v_md5 = 'dd69f099a274a9cdc0f174ae0883ddb6'
     AND v_deps = 'pg_class:public.papers.abstract|n' || E'\n' || 'pg_class:public.papers.authors|n' || E'\n'
                  || 'pg_class:public.papers.journal|n' || E'\n' || 'pg_class:public.papers.keywords|n' || E'\n'
                  || 'pg_class:public.papers.notes|n' || E'\n' || 'pg_class:public.papers.search_vector|i' || E'\n'
                  || 'pg_class:public.papers.title|n' || E'\n' || 'pg_proc:public.immutable_english_tsvector_jsonb(jsonb)|n' || E'\n'
                  || 'pg_proc:public.immutable_english_tsvector_text(text)|n'
     AND v_calls = v_wrapper_calls THEN
    v_shape := 'wrapper';
  ELSE
    RAISE EXCEPTION E'search_vector_parity: STOP — papers.search_vector is an unreviewed representation.\nexpression md5: %\ndependencies:\n%\ncalls: %',
      coalesce(v_md5, '<missing>'), coalesce(v_deps, '<none>'),
      coalesce((SELECT string_agg(c::regprocedure::text, ', ' ORDER BY c) FROM unnest(v_calls) AS c), '<none>');
  END IF;

  IF (v_shape = 'direct') IS DISTINCT FROM (v_branch = 'noop') THEN
    RAISE EXCEPTION 'search_vector_parity: the representation changed after section 1 classified it (now %, branch %)', v_shape, v_branch;
  END IF;

  -- Every function the canonical expression calls must be executable by the
  -- role that writes papers, whatever the starting shape. Checked by OID.
  SELECT coalesce(string_agg(c::regprocedure::text, ', ' ORDER BY c), '') INTO v_text
  FROM unnest(v_direct_calls) AS c WHERE NOT has_function_privilege('authenticated', c, 'EXECUTE');
  IF v_text <> '' THEN
    RAISE EXCEPTION 'search_vector_parity: authenticated cannot EXECUTE function(s) the canonical expression calls, so every papers write would fail: %', v_text;
  END IF;

  -- ── 2f. The column, and everything that depends on it ───────────────────────
  IF (SELECT format('generated=%s type=%s notnull=%s dropped=%s identity=%s', a.attgenerated, format_type(a.atttypid, a.atttypmod),
                    a.attnotnull, a.attisdropped, a.attidentity)
        FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector')
     IS DISTINCT FROM 'generated=s type=tsvector notnull=f dropped=f identity=' THEN
    RAISE EXCEPTION 'search_vector_parity: papers.search_vector is not the nullable stored generated tsvector column';
  END IF;

  -- Exactly its own default and idx_papers_search_vector depend on the column:
  -- no view, rule, statistics object or second index would be silently
  -- affected by the rewrite.
  SELECT string_agg(x.line, E'\n' ORDER BY x.line COLLATE "C") INTO v_text
  FROM (SELECT CASE dd.classid WHEN 'pg_attrdef'::regclass THEN 'default'
                               WHEN 'pg_class'::regclass THEN 'pg_class:' || dd.objid::regclass::text
                               ELSE dd.classid::regclass::text || ':' || dd.objid::text END || '|' || dd.deptype::text AS line
          FROM pg_depend dd
         WHERE dd.refclassid = 'pg_class'::regclass AND dd.refobjid = 'public.papers'::regclass
           AND dd.refobjsubid = (SELECT a.attnum FROM pg_attribute a
                                  WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector')) x;
  IF v_text IS DISTINCT FROM 'default|i' || E'\n' || 'pg_class:public.idx_papers_search_vector|a' THEN
    RAISE EXCEPTION E'search_vector_parity: the objects depending on papers.search_vector are not exactly its default and idx_papers_search_vector:\n%',
      coalesce(v_text, '<none>');
  END IF;

  -- ── 2g. public.papers — the table and its reviewed structure ────────────────
  -- An ordinary, permanent, unpartitioned postgres-owned table with RLS
  -- enabled and forced, no rule, no inheritance, and exactly the reviewed
  -- columns (by name, type, nullability, generation, default, column ACL and
  -- collation — identical in Production and on a replay, though column ORDER
  -- is not).
  IF NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = 'public.papers'::regclass AND c.relkind = 'r' AND c.relpersistence = 'p'
                    AND c.relowner = 'postgres'::regrole AND c.relrowsecurity AND c.relforcerowsecurity
                    AND NOT c.relhasrules AND NOT c.relispartition) THEN
    RAISE EXCEPTION 'search_vector_parity: public.papers is not the ordinary postgres-owned table with RLS enabled and forced';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = 'public.papers'::regclass OR inhparent = 'public.papers'::regclass) THEN
    RAISE EXCEPTION 'search_vector_parity: public.papers takes part in inheritance';
  END IF;

  SELECT md5(string_agg(a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|'
                        || a.attgenerated::text || '|' || a.atthasdef::text || '|' || coalesce(a.attacl::text, '-') || '|'
                        || a.attcollation::text, E'\n' ORDER BY a.attname COLLATE "C"))
    INTO v_text
  FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_text IS DISTINCT FROM 'ec0b8b919d1a685b79bba27c0d120c9f' THEN
    RAISE EXCEPTION 'search_vector_parity: the columns of public.papers are not the reviewed set (digest %)', v_text;
  END IF;

  -- Grants, by privilege (the literal ACL is preserved, section 4): the
  -- browser role writes papers, so it must keep exactly INSERT, SELECT and
  -- UPDATE; anon holds nothing; no other grantee; no column grant.
  SELECT format('direct=%s effective=%s',
           (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
              FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             WHERE c.oid = 'public.papers'::regclass AND a.grantee = 'authenticated'::regrole),
           (SELECT coalesce(string_agg(pr, ',' ORDER BY pr), '')
              FROM unnest(v_all) pr WHERE has_table_privilege('authenticated', 'public.papers', pr)))
    INTO v_text;
  IF v_text IS DISTINCT FROM 'direct=INSERT,SELECT,UPDATE effective=INSERT,SELECT,UPDATE' THEN
    RAISE EXCEPTION 'search_vector_parity: authenticated''s privileges on public.papers are not the reviewed INSERT,SELECT,UPDATE (found %)', v_text;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_all) pr WHERE has_table_privilege('anon', 'public.papers', pr))
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                 WHERE c.oid = 'public.papers'::regclass
                   AND a.grantee NOT IN ('postgres'::regrole, 'authenticated'::regrole, 'service_role'::regrole)) THEN
    RAISE EXCEPTION 'search_vector_parity: public.papers has an anon privilege or a grantee outside postgres/authenticated/service_role (PUBLIC included)';
  END IF;

  -- Column defaults and generated columns other than search_vector, by name
  -- (the same reviewed set C53 pinned).
  SELECT coalesce(string_agg(a.attname || '|' || a.attgenerated::text || '|' || md5(pg_get_expr(d.adbin, d.adrelid)),
                             E'\n' ORDER BY a.attname COLLATE "C"), '') INTO v_text
  FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'public.papers'::regclass AND a.attname <> 'search_vector';
  SELECT string_agg(w.line, E'\n' ORDER BY w.line COLLATE "C") INTO v_want
  FROM (VALUES
    ('authors||8b4b2df56ad0773943ef9179742da01b'),       -- '[]'::jsonb
    ('created_at||75230039beb12ce952f24927f2bfa2f2'),    -- now()
    ('has_abstract|s|7d672129a95756d03abf1ed12a790364'), -- (abstract IS NOT NULL), stored
    ('id||f3b72bb359a50b640590970a2ab8e514'),            -- gen_random_uuid()
    ('insert_order||be9086f0ddeff7e68be0a777409ec9a8'),  -- nextval('public.papers_insert_order_seq'::regclass)
    ('keywords||8b4b2df56ad0773943ef9179742da01b'),      -- '[]'::jsonb
    ('mesh_terms||8b4b2df56ad0773943ef9179742da01b'),    -- '[]'::jsonb
    ('raw_keywords||8b4b2df56ad0773943ef9179742da01b'),  -- '[]'::jsonb
    ('substances||8b4b2df56ad0773943ef9179742da01b'),    -- '[]'::jsonb
    ('updated_at||75230039beb12ce952f24927f2bfa2f2')     -- now()
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'search_vector_parity: the other column defaults / generated columns of public.papers are not the reviewed set.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  -- Constraints, by name, kind, validation and definition.
  SELECT coalesce(string_agg(format('%s|%s|%s|%s', c.conname, c.contype, c.convalidated, md5(pg_get_constraintdef(c.oid))),
                             E'\n' ORDER BY c.conname COLLATE "C"), '') INTO v_text
  FROM pg_constraint c WHERE c.conrelid = 'public.papers'::regclass;
  SELECT string_agg(w.line, E'\n' ORDER BY w.line COLLATE "C") INTO v_want
  FROM (VALUES
    ('papers_author_provenance_shape_check|c|t|7d6ecbcf2630b9b552a577ef84e779a6'),
    ('papers_pkey|p|t|4c6419b3704337bbfe50f018842a9ad3'),
    ('papers_raw_publication_types_string_array_check|c|t|8d376404bf62f637eb5a09f1b56e09e6'),
    ('papers_statistical_methods_json_string_check|c|t|d6c44848ff8dd9a5df6eddae1a2a685d'),
    ('papers_user_id_fkey|f|t|85d8b2f5f0c0f6b4dcb854efb61a8cb1'),
    ('papers_user_id_id_key|u|t|98e1fbc84debfcfd6796368ac10f703e')
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'search_vector_parity: the constraints on public.papers are not the reviewed set.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  -- All seven indexes, by name, uniqueness, validity, readiness, liveness and
  -- definition; the search index also by its literal definition.
  SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', ci.relname, i.indisunique, i.indisvalid, i.indisready, i.indislive,
                                    md5(pg_get_indexdef(i.indexrelid))),
                             E'\n' ORDER BY ci.relname COLLATE "C"), '') INTO v_text
  FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid
  WHERE i.indrelid = 'public.papers'::regclass;
  SELECT string_agg(w.line, E'\n' ORDER BY w.line COLLATE "C") INTO v_want
  FROM (VALUES
    ('idx_papers_search_vector|f|t|t|t|447b923097a20e377d6b1b6e74760783'),
    ('idx_papers_user_created|f|t|t|t|4c2903053f89545d950858cfc500ab93'),
    ('idx_papers_user_doi_unique|t|t|t|t|ae2e2e495e1ccf7b0fde23b37b059ea7'),
    ('idx_papers_user_insert_order|f|t|t|t|399798800e9a41bed4bce908e33081b5'),
    ('idx_papers_user_pmid_unique|t|t|t|t|be79920b6bd06d24800ca77d0853aeaf'),
    ('papers_pkey|t|t|t|t|ea233b98024e5d85945da90943c498ce'),
    ('papers_user_id_id_key|t|t|t|t|e0e361ac8308142c69d5a3441e389163')
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'search_vector_parity: the indexes on public.papers are not the reviewed set (missing, invalid, not ready or redefined).\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;
  IF (SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i
       WHERE i.indexrelid = to_regclass('public.idx_papers_search_vector') AND i.indrelid = 'public.papers'::regclass)
     IS DISTINCT FROM 'CREATE INDEX idx_papers_search_vector ON public.papers USING gin (search_vector)' THEN
    RAISE EXCEPTION 'search_vector_parity: idx_papers_search_vector is not GIN(search_vector) on public.papers';
  END IF;

  -- The two named triggers (both UPDATE-only, as C53 pinned them) and the RLS
  -- policy digest. The internal foreign-key triggers are preserved whole by
  -- the section 4 comparison.
  SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s', t.tgname, t.tgenabled, t.tgtype, t.tgfoid::regprocedure,
                                    md5(pg_get_triggerdef(t.oid))), E'\n' ORDER BY t.tgname), '') INTO v_text
  FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass AND NOT t.tgisinternal;
  IF v_text IS DISTINCT FROM
       'papers_clear_author_identity_links_on_authors_change|O|17|public.clear_author_identity_links_on_authors_change()|df324456e1798618b83342b7376698d9'
       || E'\n' || 'trg_papers_updated_at|O|19|public.set_updated_at()|64efa17c0852ae9a5d30cc42d2edbba2' THEN
    RAISE EXCEPTION E'search_vector_parity: the named triggers on public.papers are not the reviewed two:\n%', v_text;
  END IF;

  IF (SELECT md5(string_agg(format('%s|%s|%s|%s|%s|%s', pol.polname, pol.polcmd, pol.polpermissive,
                                   (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                                      FROM unnest(pol.polroles) r),
                                   coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>'),
                                   coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')),
                            E'\n' ORDER BY pol.polname))
        FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass)
     IS DISTINCT FROM '83aefa941c0457380be04b51c131ed5d' THEN
    RAISE EXCEPTION 'search_vector_parity: the public.papers RLS policies are not the reviewed caller-owned four';
  END IF;

  -- ── 2h. Semantic precondition — stored values already canonical ─────────────
  -- Validation only. Each stored vector must equal the canonical direct
  -- expression over its own row, as a tsvector AND byte for byte.
  SELECT count(*) INTO v_count
  FROM public.papers p
  CROSS JOIN LATERAL (SELECT
      setweight(to_tsvector('english'::regconfig, COALESCE(p.title, ''::text)), 'A')
      || setweight(to_tsvector('english'::regconfig, COALESCE(p.abstract, ''::text)), 'B')
      || setweight(to_tsvector('english'::regconfig, COALESCE(p.journal, ''::text)), 'C')
      || setweight(to_tsvector('english'::regconfig, COALESCE(p.authors::text, ''::text)), 'C')
      || setweight(to_tsvector('english'::regconfig, COALESCE(p.keywords::text, ''::text)), 'C')
      || setweight(to_tsvector('english'::regconfig, COALESCE(p.notes, ''::text)), 'D') AS v) canon
  WHERE p.search_vector IS DISTINCT FROM canon.v
     OR tsvectorsend(p.search_vector) IS DISTINCT FROM tsvectorsend(canon.v);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'search_vector_parity: STOP — % row(s) of public.papers store a search_vector that differs from the canonical direct expression; nothing was changed',
      v_count;
  END IF;

  -- ── 2i. Snapshots of everything this migration must preserve ────────────────
  -- Transaction-local; read back in section 4.

  -- The column's position.
  PERFORM set_config('paperlume.search_vector_parity.attnum',
    (SELECT a.attnum::text FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector'), true);

  -- LOGICAL state — must be identical after either branch. Volatile storage
  -- statistics (relpages, reltuples, relallvisible, frozen xids) and physical
  -- file identity are excluded here and handled below.
  PERFORM set_config('paperlume.search_vector_parity.logical',
    (SELECT concat_ws(E'\n',
       (SELECT 'papers|' || c.oid::text || '|' || pg_get_userbyid(c.relowner) || '|' || c.relkind::text || '|' || c.relpersistence::text
               || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|' || coalesce(c.relacl::text, 'NULL')
               || '|' || coalesce(c.reloptions::text, 'NULL') || '|' || c.relchecks::text || '|' || c.relhastriggers::text
               || '|' || c.relreplident::text || '|' || c.relnatts::text || '|' || coalesce(md5(obj_description(c.oid, 'pg_class')), '-')
          FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
       (SELECT 'att|' || md5(string_agg(md5(to_jsonb(a.*)::text), ',' ORDER BY a.attnum))
          FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass),
       (SELECT 'coldesc|' || coalesce(string_agg(ds.objsubid::text || '=' || md5(ds.description), ',' ORDER BY ds.objsubid), '')
          FROM pg_description ds WHERE ds.classoid = 'pg_class'::regclass AND ds.objoid = 'public.papers'::regclass),
       (SELECT 'def|' || coalesce(string_agg(ad.oid::text || '=' || md5(to_jsonb(ad.*)::text), ',' ORDER BY ad.adnum), '')
          FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
         WHERE ad.adrelid = 'public.papers'::regclass AND a.attname <> 'search_vector'),
       (SELECT 'con|' || coalesce(string_agg(md5(to_jsonb(con.*)::text), ',' ORDER BY con.oid), '')
          FROM pg_constraint con WHERE con.conrelid = 'public.papers'::regclass OR con.confrelid = 'public.papers'::regclass),
       (SELECT 'idx|' || coalesce(string_agg(ci.relname || '=' || md5(pg_get_indexdef(i.indexrelid)) || '=' || md5((to_jsonb(i.*) - 'indexrelid')::text)
                                             || '=' || ci.relam::text || '=' || pg_get_userbyid(ci.relowner) || '=' || coalesce(ci.reloptions::text, 'NULL')
                                             || '=' || ci.relpersistence::text,
                                             ',' ORDER BY ci.relname COLLATE "C"), '')
          FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid WHERE i.indrelid = 'public.papers'::regclass),
       (SELECT 'pol|' || coalesce(string_agg(md5(to_jsonb(pol.*)::text), ',' ORDER BY pol.oid), '')
          FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass),
       (SELECT 'trg|' || coalesce(string_agg(md5(to_jsonb(t.*)::text), ',' ORDER BY t.oid), '')
          FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass),
       (SELECT 'seq|' || c.oid::text || '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(c.relacl::text, 'NULL') || '|'
               || c.relfilenode::text || '|' || md5(to_jsonb(s.*)::text)
          FROM pg_class c JOIN pg_sequence s ON s.seqrelid = c.oid
         WHERE c.oid = 'public.papers_insert_order_seq'::regclass),
       (SELECT 'fn|' || md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text) || '=' || coalesce(md5(obj_description(p.oid, 'pg_proc')), '-'),
                                       E'\n' ORDER BY p.oid))
          FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
       (SELECT 'rel|' || md5(string_agg(c.oid::text || '=' || c.relfilenode::text || '=' || coalesce(c.relacl::text, 'NULL'),
                                        ',' ORDER BY c.oid))
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.oid <> 'public.papers'::regclass
           AND c.oid NOT IN (SELECT i.indexrelid FROM pg_index i WHERE i.indrelid = 'public.papers'::regclass)))), true);

  -- PHYSICAL identity — must be identical after the no-op branch; the rewrite
  -- legitimately moves it. The heap and TOAST files, every index's OID and
  -- file, the search_vector default's whole row (OID included) and its
  -- dependency rows.
  PERFORM set_config('paperlume.search_vector_parity.physical',
    (SELECT concat_ws(E'\n',
       (SELECT 'papers|' || c.relfilenode::text || '|' || c.reltoastrelid::text || '|'
               || coalesce((SELECT t.relfilenode::text FROM pg_class t WHERE t.oid = c.reltoastrelid), '-')
          FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
       (SELECT 'idx|' || string_agg(ci.relname || '=' || ci.oid::text || '=' || ci.relfilenode::text, ',' ORDER BY ci.relname COLLATE "C")
          FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid WHERE i.indrelid = 'public.papers'::regclass),
       (SELECT 'sv|' || d.oid::text || '=' || md5(to_jsonb(d.*)::text) || '=' ||
               (SELECT md5(string_agg(to_jsonb(dd.*)::text, ',' ORDER BY dd.refclassid, dd.refobjid, dd.refobjsubid))
                  FROM pg_depend dd WHERE dd.classid = 'pg_attrdef'::regclass AND dd.objid = d.oid)
          FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
         WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector'))), true);

  -- DATA — only on the rewrite branch, where the ACCESS EXCLUSIVE lock makes
  -- a before/after comparison exact. (The no-op branch writes nothing and
  -- issues no DDL; concurrent application writes are legitimately visible to
  -- its later reads.) Row count; every column except search_vector, row by
  -- row; and every stored vector, byte for byte.
  IF v_branch = 'rewrite' THEN
    PERFORM set_config('paperlume.search_vector_parity.data',
      (SELECT count(*)::text || '|'
              || coalesce(md5(string_agg(p.id::text || '=' || md5((to_jsonb(p.*) - 'search_vector')::text), ',' ORDER BY p.id)), '-') || '|'
              || coalesce(md5(string_agg(p.id::text || '=' || md5(tsvectorsend(p.search_vector)), ',' ORDER BY p.id)), '-')
         FROM public.papers p), true);
  END IF;
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. The change — the wrapper representation only
-- ═════════════════════════════════════════════════════════════════════════════
--
-- On the direct representation this block executes nothing. On the wrapper
-- representation: one SET EXPRESSION (a real rewrite, under the ACCESS
-- EXCLUSIVE lock taken in section 1), then ANALYZE of the one column whose
-- statistics the rewrite cleared. The expression is the canonical text from
-- the header, resolved under the pinned path to pg_catalog built-ins.

DO $change$
BEGIN
  IF current_setting('paperlume.search_vector_parity.branch', true) = 'rewrite' THEN
    ALTER TABLE public.papers
      ALTER COLUMN search_vector
      SET EXPRESSION AS (
        setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A')
        || setweight(to_tsvector('english'::regconfig, COALESCE(abstract, ''::text)), 'B')
        || setweight(to_tsvector('english'::regconfig, COALESCE(journal, ''::text)), 'C')
        || setweight(to_tsvector('english'::regconfig, COALESCE(authors::text, ''::text)), 'C')
        || setweight(to_tsvector('english'::regconfig, COALESCE(keywords::text, ''::text)), 'C')
        || setweight(to_tsvector('english'::regconfig, COALESCE(notes, ''::text)), 'D')
      );

    ANALYZE public.papers (search_vector);
  END IF;
END
$change$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Fail-closed verification — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

DO $verify$
DECLARE
  v_branch        CONSTANT TEXT := current_setting('paperlume.search_vector_parity.branch', true);
  v_text          TEXT;
  v_base          TEXT;
  v_count         INTEGER;
  v_md5           TEXT;
  v_deps          TEXT;
  v_calls         OID[];
  v_direct_calls  OID[];
BEGIN
  IF v_branch IS NULL OR v_branch NOT IN ('noop', 'rewrite') THEN
    RAISE EXCEPTION 'search_vector_parity: the branch recorded in section 1 is missing — this file must run as one transaction';
  END IF;

  -- ── 4a. Exactly one representation: the canonical direct built-in one ───────
  SELECT array_agg(to_regprocedure(s)::oid ORDER BY to_regprocedure(s)::oid)
    INTO v_direct_calls
  FROM (VALUES ('pg_catalog.setweight(tsvector,"char")'),
               ('pg_catalog.to_tsvector(regconfig,text)'),
               ('pg_catalog.tsvector_concat(tsvector,tsvector)')) AS w(s);

  SELECT md5(pg_get_expr(d.adbin, d.adrelid)),
         (SELECT string_agg(x.line, E'\n' ORDER BY x.line COLLATE "C")
            FROM (SELECT CASE dd.refclassid
                           WHEN 'pg_class'::regclass THEN 'pg_class:' || dd.refobjid::regclass::text || '.'
                                || coalesce((SELECT att.attname::text FROM pg_attribute att
                                              WHERE att.attrelid = dd.refobjid AND att.attnum = dd.refobjsubid), '#' || dd.refobjsubid::text)
                           WHEN 'pg_proc'::regclass THEN 'pg_proc:' || dd.refobjid::regprocedure::text
                           WHEN 'pg_ts_config'::regclass THEN 'pg_ts_config:' || dd.refobjid::regconfig::text
                           ELSE dd.refclassid::regclass::text || ':' || dd.refobjid::text || '.' || dd.refobjsubid::text
                         END || '|' || dd.deptype::text AS line
                    FROM pg_depend dd
                   WHERE dd.classid = 'pg_attrdef'::regclass AND dd.objid = d.oid) x),
         (SELECT array_agg(DISTINCT m[1]::oid ORDER BY m[1]::oid)
            FROM regexp_matches(d.adbin::text, ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m)
    INTO v_md5, v_deps, v_calls
  FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector';

  IF v_md5 IS DISTINCT FROM '8ddd960b4f4b11dd7afd35485d01fd25' THEN
    RAISE EXCEPTION 'search_vector_parity: papers.search_vector is not the canonical direct expression after the change (md5 %)',
      coalesce(v_md5, '<missing>');
  END IF;
  -- No project-owned function remains in its dependencies: only its six input
  -- columns, itself and the built-in `english` configuration.
  IF v_deps IS DISTINCT FROM
       'pg_class:public.papers.abstract|n' || E'\n' || 'pg_class:public.papers.authors|n' || E'\n'
       || 'pg_class:public.papers.journal|n' || E'\n' || 'pg_class:public.papers.keywords|n' || E'\n'
       || 'pg_class:public.papers.notes|n' || E'\n' || 'pg_class:public.papers.search_vector|i' || E'\n'
       || 'pg_class:public.papers.title|n' || E'\n' || 'pg_ts_config:english|n' THEN
    RAISE EXCEPTION E'search_vector_parity: the dependencies of papers.search_vector are not the canonical set after the change:\n%', v_deps;
  END IF;
  IF v_calls IS DISTINCT FROM v_direct_calls OR cardinality(v_direct_calls) <> 3 THEN
    RAISE EXCEPTION 'search_vector_parity: papers.search_vector does not call exactly setweight, to_tsvector(regconfig,text) and tsvector_concat after the change';
  END IF;
  SELECT coalesce(string_agg(c::regprocedure::text, ', ' ORDER BY c), '') INTO v_text
  FROM unnest(v_calls) AS c WHERE NOT has_function_privilege('authenticated', c, 'EXECUTE');
  IF v_text <> '' THEN
    RAISE EXCEPTION 'search_vector_parity: authenticated cannot EXECUTE function(s) papers.search_vector calls: %', v_text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_depend dd
              WHERE dd.refclassid = 'pg_proc'::regclass AND dd.deptype = 'n'
                AND dd.refobjid IN (to_regprocedure('public.immutable_english_tsvector_jsonb(jsonb)'),
                                    to_regprocedure('public.immutable_english_tsvector_text(text)'),
                                    to_regprocedure('public.immutable_english_tsvector_textarr(text[])'))
                AND dd.classid = 'pg_attrdef'::regclass
                AND dd.objid IN (SELECT ad.oid FROM pg_attrdef ad WHERE ad.adrelid = 'public.papers'::regclass)) THEN
    RAISE EXCEPTION 'search_vector_parity: a papers column default still depends on an immutable_english_tsvector_* wrapper';
  END IF;

  -- ── 4b. The same column: attnum, type, STORED generation, nullability ───────
  IF (SELECT format('attnum=%s generated=%s type=%s notnull=%s dropped=%s', a.attnum, a.attgenerated,
                    format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attisdropped)
        FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector')
     IS DISTINCT FROM format('attnum=%s generated=s type=tsvector notnull=f dropped=f',
                             current_setting('paperlume.search_vector_parity.attnum', true)) THEN
    RAISE EXCEPTION 'search_vector_parity: papers.search_vector is no longer the same nullable stored generated tsvector column (attnum %)',
      current_setting('paperlume.search_vector_parity.attnum', true);
  END IF;

  SELECT string_agg(x.line, E'\n' ORDER BY x.line COLLATE "C") INTO v_text
  FROM (SELECT CASE dd.classid WHEN 'pg_attrdef'::regclass THEN 'default'
                               WHEN 'pg_class'::regclass THEN 'pg_class:' || dd.objid::regclass::text
                               ELSE dd.classid::regclass::text || ':' || dd.objid::text END || '|' || dd.deptype::text AS line
          FROM pg_depend dd
         WHERE dd.refclassid = 'pg_class'::regclass AND dd.refobjid = 'public.papers'::regclass
           AND dd.refobjsubid = current_setting('paperlume.search_vector_parity.attnum', true)::int2) x;
  IF v_text IS DISTINCT FROM 'default|i' || E'\n' || 'pg_class:public.idx_papers_search_vector|a' THEN
    RAISE EXCEPTION E'search_vector_parity: the objects depending on papers.search_vector changed:\n%', coalesce(v_text, '<none>');
  END IF;

  -- ── 4c. The search index: present, valid, ready, live, GIN(search_vector) ───
  -- Its OID may change on the rewrite branch (PostgreSQL re-creates an index
  -- on a rewritten generated column); its definition may not.
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indexrelid = to_regclass('public.idx_papers_search_vector') AND i.indrelid = 'public.papers'::regclass
                    AND i.indisvalid AND i.indisready AND i.indislive
                    AND pg_get_indexdef(i.indexrelid) = 'CREATE INDEX idx_papers_search_vector ON public.papers USING gin (search_vector)') THEN
    RAISE EXCEPTION 'search_vector_parity: idx_papers_search_vector is missing, invalid, not ready, not live or no longer GIN(search_vector)';
  END IF;

  -- ── 4d. Logical state identical — both branches ─────────────────────────────
  -- Table identity, owner, ACL, RLS/FORCE, options and comment; every column
  -- as its whole pg_attribute row (column ACLs included) and its comment;
  -- every other default and generated column; every constraint on or
  -- referencing papers (so each unique/primary key still binds the same
  -- index); every index by name, definition, pg_index row (minus its own OID),
  -- access method, owner and options; every policy and trigger; the
  -- insert_order sequence; every public function (the wrappers, every RPC
  -- body and signature); and every other public relation's OID, file and ACL.
  v_base := current_setting('paperlume.search_vector_parity.logical', true);
  IF coalesce(v_base, '') = ''
     OR (SELECT concat_ws(E'\n',
          (SELECT 'papers|' || c.oid::text || '|' || pg_get_userbyid(c.relowner) || '|' || c.relkind::text || '|' || c.relpersistence::text
                  || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|' || coalesce(c.relacl::text, 'NULL')
                  || '|' || coalesce(c.reloptions::text, 'NULL') || '|' || c.relchecks::text || '|' || c.relhastriggers::text
                  || '|' || c.relreplident::text || '|' || c.relnatts::text || '|' || coalesce(md5(obj_description(c.oid, 'pg_class')), '-')
             FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
          (SELECT 'att|' || md5(string_agg(md5(to_jsonb(a.*)::text), ',' ORDER BY a.attnum))
             FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass),
          (SELECT 'coldesc|' || coalesce(string_agg(ds.objsubid::text || '=' || md5(ds.description), ',' ORDER BY ds.objsubid), '')
             FROM pg_description ds WHERE ds.classoid = 'pg_class'::regclass AND ds.objoid = 'public.papers'::regclass),
          (SELECT 'def|' || coalesce(string_agg(ad.oid::text || '=' || md5(to_jsonb(ad.*)::text), ',' ORDER BY ad.adnum), '')
             FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
            WHERE ad.adrelid = 'public.papers'::regclass AND a.attname <> 'search_vector'),
          (SELECT 'con|' || coalesce(string_agg(md5(to_jsonb(con.*)::text), ',' ORDER BY con.oid), '')
             FROM pg_constraint con WHERE con.conrelid = 'public.papers'::regclass OR con.confrelid = 'public.papers'::regclass),
          (SELECT 'idx|' || coalesce(string_agg(ci.relname || '=' || md5(pg_get_indexdef(i.indexrelid)) || '=' || md5((to_jsonb(i.*) - 'indexrelid')::text)
                                                || '=' || ci.relam::text || '=' || pg_get_userbyid(ci.relowner) || '=' || coalesce(ci.reloptions::text, 'NULL')
                                                || '=' || ci.relpersistence::text,
                                                ',' ORDER BY ci.relname COLLATE "C"), '')
             FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid WHERE i.indrelid = 'public.papers'::regclass),
          (SELECT 'pol|' || coalesce(string_agg(md5(to_jsonb(pol.*)::text), ',' ORDER BY pol.oid), '')
             FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass),
          (SELECT 'trg|' || coalesce(string_agg(md5(to_jsonb(t.*)::text), ',' ORDER BY t.oid), '')
             FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass),
          (SELECT 'seq|' || c.oid::text || '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(c.relacl::text, 'NULL') || '|'
                  || c.relfilenode::text || '|' || md5(to_jsonb(s.*)::text)
             FROM pg_class c JOIN pg_sequence s ON s.seqrelid = c.oid
            WHERE c.oid = 'public.papers_insert_order_seq'::regclass),
          (SELECT 'fn|' || md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text) || '=' || coalesce(md5(obj_description(p.oid, 'pg_proc')), '-'),
                                          E'\n' ORDER BY p.oid))
             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
          (SELECT 'rel|' || md5(string_agg(c.oid::text || '=' || c.relfilenode::text || '=' || coalesce(c.relacl::text, 'NULL'),
                                           ',' ORDER BY c.oid))
             FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.oid <> 'public.papers'::regclass
              AND c.oid NOT IN (SELECT i.indexrelid FROM pg_index i WHERE i.indrelid = 'public.papers'::regclass))))
        IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'search_vector_parity: papers'' identity, owner, ACL, RLS flags, a column, comment, default, constraint, index definition, policy or trigger, the insert_order sequence, a public function, or another public relation changed';
  END IF;

  -- ── 4e. Physical identity — the no-op branch moved NOTHING ──────────────────
  -- Same heap file, same TOAST relation and file, every index with the same
  -- OID and file, the same search_vector default row and dependency rows, and
  -- still no lock stronger than ACCESS SHARE on papers or its indexes. A
  -- rewrite, an index rebuild or any ALTER TABLE would move at least one.
  IF v_branch = 'noop' THEN
    v_base := current_setting('paperlume.search_vector_parity.physical', true);
    IF coalesce(v_base, '') = ''
       OR (SELECT concat_ws(E'\n',
            (SELECT 'papers|' || c.relfilenode::text || '|' || c.reltoastrelid::text || '|'
                    || coalesce((SELECT t.relfilenode::text FROM pg_class t WHERE t.oid = c.reltoastrelid), '-')
               FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
            (SELECT 'idx|' || string_agg(ci.relname || '=' || ci.oid::text || '=' || ci.relfilenode::text, ',' ORDER BY ci.relname COLLATE "C")
               FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid WHERE i.indrelid = 'public.papers'::regclass),
            (SELECT 'sv|' || d.oid::text || '=' || md5(to_jsonb(d.*)::text) || '=' ||
                    (SELECT md5(string_agg(to_jsonb(dd.*)::text, ',' ORDER BY dd.refclassid, dd.refobjid, dd.refobjsubid))
                       FROM pg_depend dd WHERE dd.classid = 'pg_attrdef'::regclass AND dd.objid = d.oid)
               FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
              WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector')))
          IS DISTINCT FROM v_base THEN
      RAISE EXCEPTION E'search_vector_parity: the no-op branch moved the physical identity of papers, its TOAST, an index or the search_vector default.\nbefore:\n%', v_base;
    END IF;

    SELECT coalesce(string_agg(DISTINCT l.relation::regclass::text || ' ' || l.mode, ', '), '') INTO v_text
    FROM pg_locks l
    WHERE l.locktype = 'relation' AND l.pid = pg_backend_pid()
      AND l.relation IN (SELECT 'public.papers'::regclass UNION ALL
                         SELECT i.indexrelid FROM pg_index i WHERE i.indrelid = 'public.papers'::regclass)
      AND l.mode <> 'AccessShareLock';
    IF v_text <> '' THEN
      RAISE EXCEPTION 'search_vector_parity: the no-op branch took a lock stronger than ACCESS SHARE: %', v_text;
    END IF;
  END IF;

  -- ── 4f. The rewrite preserved every row — the rewrite branch ────────────────
  -- Same row count, every other column identical row by row, every stored
  -- vector byte-identical, and fresh statistics for the column when it has
  -- rows (the ANALYZE ran).
  IF v_branch = 'rewrite' THEN
    v_base := current_setting('paperlume.search_vector_parity.data', true);
    SELECT count(*)::text || '|'
           || coalesce(md5(string_agg(p.id::text || '=' || md5((to_jsonb(p.*) - 'search_vector')::text), ',' ORDER BY p.id)), '-') || '|'
           || coalesce(md5(string_agg(p.id::text || '=' || md5(tsvectorsend(p.search_vector)), ',' ORDER BY p.id)), '-')
      INTO v_text
    FROM public.papers p;
    IF coalesce(v_base, '') = '' OR v_text IS DISTINCT FROM v_base THEN
      RAISE EXCEPTION E'search_vector_parity: the rewrite changed application data (rows | other columns | stored vectors).\nbefore: %\nafter:  %', v_base, v_text;
    END IF;

    IF split_part(v_text, '|', 1)::bigint > 0
       AND NOT EXISTS (SELECT 1 FROM pg_statistic s
                        WHERE s.starelid = 'public.papers'::regclass
                          AND s.staattnum = current_setting('paperlume.search_vector_parity.attnum', true)::int2) THEN
      RAISE EXCEPTION 'search_vector_parity: papers.search_vector has rows but no statistics after the rewrite — ANALYZE did not run';
    END IF;
  END IF;

  -- ── 4g. The canonical expression reproduces every stored value ──────────────
  SELECT count(*) INTO v_count
  FROM public.papers p
  CROSS JOIN LATERAL (SELECT
      setweight(to_tsvector('english'::regconfig, COALESCE(p.title, ''::text)), 'A')
      || setweight(to_tsvector('english'::regconfig, COALESCE(p.abstract, ''::text)), 'B')
      || setweight(to_tsvector('english'::regconfig, COALESCE(p.journal, ''::text)), 'C')
      || setweight(to_tsvector('english'::regconfig, COALESCE(p.authors::text, ''::text)), 'C')
      || setweight(to_tsvector('english'::regconfig, COALESCE(p.keywords::text, ''::text)), 'C')
      || setweight(to_tsvector('english'::regconfig, COALESCE(p.notes, ''::text)), 'D') AS v) canon
  WHERE p.search_vector IS DISTINCT FROM canon.v
     OR tsvectorsend(p.search_vector) IS DISTINCT FROM tsvectorsend(canon.v);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'search_vector_parity: % row(s) store a search_vector the canonical expression does not reproduce', v_count;
  END IF;

  -- ── 4h. This transaction wrote no row ────────────────────────────────────────
  v_base := current_setting('paperlume.search_vector_parity.xact_writes_at_start', true);
  IF coalesce(v_base, '') = '' THEN
    RAISE EXCEPTION 'search_vector_parity: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  SELECT string_agg(
           n.nspname || '.' || c.relname || '=' || (pg_stat_get_xact_tuples_inserted(c.oid)
                                                    + pg_stat_get_xact_tuples_updated(c.oid)
                                                    + pg_stat_get_xact_tuples_deleted(c.oid)),
           ' ' ORDER BY n.nspname, c.relname) INTO v_text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p');
  IF v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'search_vector_parity: this transaction wrote application rows (row writes at start: %; now: %)', v_base, v_text;
  END IF;
END
$verify$;

COMMIT;
