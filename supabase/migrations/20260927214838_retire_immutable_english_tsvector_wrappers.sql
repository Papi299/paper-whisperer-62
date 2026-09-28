-- DB-IMMUTABLE-TSVECTOR-WRAPPER-RETIREMENT-001 — retire the three obsolete
-- immutable_english_tsvector_* helper functions (C55).
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly three functions are dropped, each by its complete signature and
-- with RESTRICT:
--
--   public.immutable_english_tsvector_text(text)
--   public.immutable_english_tsvector_textarr(text[])
--   public.immutable_english_tsvector_jsonb(jsonb)
--
-- Nothing else changes: no table, column, index, default, constraint, policy,
-- trigger, grant, default privilege or other function. The `public` function
-- inventory goes from 46 to 43, and the functions in `public` that carry
-- PUBLIC EXECUTE go from five to exactly the two live trigger functions,
-- set_updated_at() and update_updated_at_column(), which are out of scope and
-- untouched.
--
-- WHY — obsolete surface, not a vulnerability
-- ─────────────────────────────────────────────────────────────────────────────
-- The three are SECURITY INVOKER, IMMUTABLE, table-independent SQL functions:
-- each only evaluates to_tsvector('english'::regconfig, COALESCE(<arg>, ''))
-- (text[] and jsonb through their text output). They read no table, have no
-- side effect and cannot bypass RLS. They are retired because nothing uses
-- them any more:
--   * no database object depends on them — since C54 papers.search_vector calls
--     only setweight(tsvector,"char"), to_tsvector(regconfig,text) and
--     tsvector_concat(tsvector,tsvector), and no routine body names them;
--   * no application, Edge Function or extension code calls them, and they
--     were never a documented API;
--   * yet PUBLIC EXECUTE made all three callable by anon as Data API RPCs
--     (/rest/v1/rpc/immutable_english_tsvector_*), and they appear in the
--     generated client types — an obsolete, callable surface.
-- Retiring them simplifies the function and ACL inventory. This is cleanup,
-- not a breach response or a privilege-escalation fix.
--
-- CHRONOLOGY (none of it is revised by this file)
-- ─────────────────────────────────────────────────────────────────────────────
--   * 20260305020000 / 20260331010000 created the wrappers for the stored
--     search expression; after the 2026-05-18 rewrite of the search migrations
--     every clean replay stored papers.search_vector as wrapper calls, while
--     hosted Production kept its original direct built-in expression (C26,
--     C54).
--   * 20260810152125 (PFA-C08) and 20260927001229 (C51) pinned their
--     search_path — correct hardening while they were part of the search and
--     replay boundary.
--   * 20260927161343 (C54) converged every environment on the direct built-in
--     expression and left the wrappers present but unreferenced, deferring
--     their retirement to a separate decision.
--   * This file (C55) makes that decision. The applied historical files that
--     create, use and harden the wrappers stay as written: a clean replay
--     creates them, C54 removes the last dependency, and C55 drops them.
--
-- SAFETY — two independent gates
-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1 refuses, before anything changes, unless every target is exactly
-- the reviewed function (signature, owner, language, security mode,
-- volatility, parallel safety, strictness, leakproofness, result, argument
-- names, proconfig, body digest and one of the two reviewed EXECUTE ACL
-- forms), no other function anywhere shares one of their names, nothing
-- depends on or refers to them — pg_depend, every stored expression node
-- tree, every function-OID catalog column, every routine body's text — and
-- papers.search_vector is still C54's canonical direct expression with its
-- GIN index valid. Section 2 then drops each target with RESTRICT, so
-- PostgreSQL itself refuses if a dependency exists that the diagnostics
-- missed. CASCADE, IF EXISTS and name-only or discovered drops are never used.
--
-- PRODUCTION PROJECTION
-- ─────────────────────────────────────────────────────────────────────────────
-- Verified read-only on 2026-09-28 (PostgreSQL 17.6; ledger 94, latest
-- 20260927161343): the three targets are OIDs 66407–66409 with the reviewed
-- contract, the explicit ACL
--   {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- (a clean replay stores NULL, the same default posture) and zero dependents;
-- search_vector at 8ddd960b…; idx_papers_search_vector valid, ready and live;
-- 46 functions in `public`, five with PUBLIC EXECUTE. A separately authorized
-- rollout is therefore expected to: add one ledger row; drop exactly these
-- three functions; take ACCESS EXCLUSIVE on the three function objects only —
-- no lock on papers or any other relation, no table rewrite, no index
-- rebuild, no application-data write. The DROP fires the platform's sql_drop
-- event trigger, so PostgREST reloads its schema cache; afterwards the three
-- RPC names no longer resolve.
--
-- CONCURRENCY
-- ─────────────────────────────────────────────────────────────────────────────
-- Every lock is waited for at most lock_timeout = 5s; on timeout the file
-- rolls back with nothing changed. Executing a function takes no lock on it,
-- so a DROP neither waits for nor blocks ordinary reads and writes of papers.
-- The file is explicitly transactional (see 20260910212202 for why
-- `supabase db reset` requires that): preconditions, drops and verification
-- commit together or not at all.
--
-- ROLLBACK — forward only
-- ─────────────────────────────────────────────────────────────────────────────
-- Do not edit this file after it has been applied, and do not
-- `migration repair` a legitimate application of it. If an unforeseen
-- consumer appears, write a NEW forward migration that re-creates the exact
-- reviewed definitions (bodies and attributes in 20260331010000, search_path
-- per 20260927001229) and restates the intended EXECUTE ACL explicitly rather
-- than relying on default privileges. See docs/deployment.md §6.16.
--
-- Durable decision: C55.

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
-- Only the owner (postgres) can drop the targets. Section 3 proves this
-- transaction wrote no row to any table in `public`, `auth` or `storage`, from
-- PostgreSQL's per-transaction statistics (see 20260924193915 §0 for why the
-- baseline is taken here). Dropping a function writes only system catalogs.

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: must run as postgres (current_user is %) — only the owner of the three functions can drop them',
      current_user;
  END IF;

  IF current_setting('search_path') IS DISTINCT FROM 'pg_catalog, pg_temp'
     OR current_setting('lock_timeout') IS DISTINCT FROM '5s' THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: the transaction-local settings are not in effect (search_path %, lock_timeout %) — this file must run as one transaction',
      current_setting('search_path'), current_setting('lock_timeout');
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: track_counts is off, so the no-write self-check could not observe anything';
  END IF;

  PERFORM set_config(
    'paperlume.retire_tsvector_wrappers.xact_writes_at_start',
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
-- 1. Preconditions — the exact state this retirement was reviewed against
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Verified read-only against Production and on a clean local replay on
-- 2026-09-28. OIDs differ between environments, so they are not pinned; they
-- are resolved here, one complete signature per VALUES row — never a list
-- joined and split on commas — and recorded for section 3. Nothing here
-- repairs unexpected state: any mismatch rolls the whole file back before
-- anything changes.

DO $pre$
DECLARE
  v_targets   OID[];
  v_text      TEXT;
  v_want      TEXT;
  v_count     INTEGER;
  v_re        TEXT;
  v_md5       TEXT;
  v_deps      TEXT;
  v_calls     OID[];
  v_direct    OID[];
  -- Everything section 3 must find unchanged, as one line per category. The
  -- query text is stored and re-executed verbatim there, so the two sides
  -- measure exactly the same thing. $1 is the target OID array. Volatile
  -- storage statistics (relpages, reltuples, relallvisible, frozen xids) are
  -- deliberately excluded: autovacuum may update them at any moment.
  c_snapshot  CONSTANT TEXT := $snap$
    SELECT string_agg(x.cat || '|' || coalesce(x.digest, '-'), E'\n' ORDER BY x.cat COLLATE "C")
    FROM (
      -- Every other public function: its whole catalog row (body, ACL,
      -- config, security mode, owner…) and its comment.
      SELECT 'fn_public_others' AS cat,
             md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text) || '='
                            || coalesce(md5(obj_description(p.oid, 'pg_proc')), '-'), E'\n' ORDER BY p.oid)) AS digest
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> ALL ($1)
      UNION ALL
      -- Every other function in the database, by OID: no overload anywhere
      -- disappears with the targets.
      SELECT 'fn_all_others',
             count(*)::text || ':' || md5(string_agg(p.oid::text, ',' ORDER BY p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.oid <> ALL ($1) AND n.nspname !~ '^pg_(toast_)?temp_'
      UNION ALL
      -- Relation identities, owners, files, ACLs, RLS flags, options, comments.
      SELECT 'rel',
             md5(string_agg(concat_ws('|', c.oid, c.relname, c.relkind, pg_get_userbyid(c.relowner), c.relfilenode,
                                      c.reltoastrelid, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
                                      c.relhastriggers, c.relhasrules, c.relnatts, c.relchecks, c.relreplident,
                                      c.relispartition, coalesce(c.relacl::text, 'NULL'), coalesce(c.reloptions::text, 'NULL'),
                                      coalesce(md5(obj_description(c.oid, 'pg_class')), '-')),
                            E'\n' ORDER BY c.oid))
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      -- Every column, as its whole row (column ACLs, generation, defaults flag).
      SELECT 'att', md5(string_agg(md5(to_jsonb(a.*)::text), ',' ORDER BY a.attrelid, a.attnum))
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'attrdef', md5(string_agg(md5(to_jsonb(d.*)::text), ',' ORDER BY d.oid))
        FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'constraint', md5(string_agg(md5(to_jsonb(k.*)::text), ',' ORDER BY k.oid))
        FROM pg_constraint k WHERE k.connamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'index', md5(string_agg(md5(to_jsonb(i.*)::text) || '=' || md5(pg_get_indexdef(i.indexrelid)), ',' ORDER BY i.indexrelid))
        FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'policy', md5(string_agg(md5(to_jsonb(pol.*)::text), ',' ORDER BY pol.oid))
        FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'trigger', md5(string_agg(md5(to_jsonb(t.*)::text), ',' ORDER BY t.oid))
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'rule', md5(string_agg(md5(to_jsonb(r.*)::text), ',' ORDER BY r.oid))
        FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'type', md5(string_agg(md5(to_jsonb(ty.*)::text), ',' ORDER BY ty.oid))
        FROM pg_type ty WHERE ty.typnamespace = 'public'::regnamespace
      UNION ALL
      -- Default privileges, every role and schema: this file changes none.
      SELECT 'default_acl', md5(string_agg(md5(to_jsonb(da.*)::text), ',' ORDER BY da.oid))
        FROM pg_default_acl da
      UNION ALL
      SELECT 'schema_public', md5(to_jsonb(n.*)::text) FROM pg_namespace n WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'event_trigger', md5(string_agg(md5(to_jsonb(e.*)::text), ',' ORDER BY e.oid))
        FROM pg_event_trigger e
      UNION ALL
      -- The C54 search column and its index, spelled out for a precise report.
      SELECT 'search_vector',
             d.oid::text || '=' || md5(to_jsonb(d.*)::text) || '='
             || (SELECT md5(string_agg(to_jsonb(dd.*)::text, ',' ORDER BY dd.refclassid, dd.refobjid, dd.refobjsubid))
                   FROM pg_depend dd WHERE dd.classid = 'pg_attrdef'::regclass AND dd.objid = d.oid)
        FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector'
      UNION ALL
      SELECT 'search_index',
             concat_ws('|', i.indexrelid, ci.relfilenode, i.indisvalid, i.indisready, i.indislive, pg_get_indexdef(i.indexrelid))
        FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid
       WHERE i.indexrelid = to_regclass('public.idx_papers_search_vector')
    ) x
  $snap$;
BEGIN
  -- ── 1a. Each target is exactly the reviewed function ────────────────────────
  -- A missing target renders as resolved=false and fails the comparison.
  SELECT string_agg(format('%s|resolved=%s|owner=%s|lang=%s|kind=%s|secdef=%s|vol=%s|parallel=%s|strict=%s|leakproof=%s'
                           || '|retset=%s|result=%s|args=[%s]|config=%s|body=%s|sqlbody=%s|cost=%s|rows=%s|support=%s|comment=%s',
                           w.sig, (p.oid IS NOT NULL), pg_get_userbyid(p.proowner), l.lanname, p.prokind, p.prosecdef,
                           p.provolatile, p.proparallel, p.proisstrict, p.proleakproof, p.proretset,
                           pg_get_function_result(p.oid), pg_get_function_arguments(p.oid), p.proconfig::text,
                           md5(p.prosrc), (p.prosqlbody IS NOT NULL), p.procost, p.prorows, p.prosupport::oid,
                           coalesce(md5(obj_description(p.oid, 'pg_proc')), '-')),
                    E'\n' ORDER BY w.sig COLLATE "C") INTO v_text
  FROM (VALUES ('public.immutable_english_tsvector_jsonb(jsonb)'),
               ('public.immutable_english_tsvector_text(text)'),
               ('public.immutable_english_tsvector_textarr(text[])')) AS w(sig)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.sig)
  LEFT JOIN pg_language l ON l.oid = p.prolang;
  SELECT string_agg(w.line, E'\n' ORDER BY w.line COLLATE "C") INTO v_want
  FROM (VALUES
    ('public.immutable_english_tsvector_jsonb(jsonb)|resolved=t|owner=postgres|lang=sql|kind=f|secdef=f|vol=i|parallel=s|strict=f|leakproof=f'
     || '|retset=f|result=tsvector|args=[j jsonb]|config={"search_path=pg_catalog, pg_temp"}|body=30c015cd34f5ed6cbe9b1e8f0626cd5e|sqlbody=f|cost=100|rows=0|support=0|comment=-'),
    ('public.immutable_english_tsvector_text(text)|resolved=t|owner=postgres|lang=sql|kind=f|secdef=f|vol=i|parallel=s|strict=f|leakproof=f'
     || '|retset=f|result=tsvector|args=[t text]|config={"search_path=pg_catalog, pg_temp"}|body=26edc211280ccfa3050b5d16f3caa75d|sqlbody=f|cost=100|rows=0|support=0|comment=-'),
    ('public.immutable_english_tsvector_textarr(text[])|resolved=t|owner=postgres|lang=sql|kind=f|secdef=f|vol=i|parallel=s|strict=f|leakproof=f'
     || '|retset=f|result=tsvector|args=[arr text[]]|config={"search_path=pg_catalog, pg_temp"}|body=19261084e62e923f83ab83abb7d5ed66|sqlbody=f|cost=100|rows=0|support=0|comment=-')
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'retire_tsvector_wrappers: STOP — the three targets are not exactly the reviewed functions; nothing was dropped.\nfound:\n%\nexpected:\n%',
      coalesce(v_text, '<missing>'), v_want;
  END IF;

  SELECT array_agg(to_regprocedure(s)::oid ORDER BY to_regprocedure(s)::oid) INTO v_targets
  FROM (VALUES ('public.immutable_english_tsvector_jsonb(jsonb)'),
               ('public.immutable_english_tsvector_text(text)'),
               ('public.immutable_english_tsvector_textarr(text[])')) AS w(s);
  IF cardinality(v_targets) IS DISTINCT FROM 3 OR array_position(v_targets, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: the three target signatures did not resolve to three functions';
  END IF;

  -- ── 1b. No other function shares a target name, in any schema ───────────────
  -- An unexpected overload (or a same-named function elsewhere) means this is
  -- not the reviewed state; it is never dropped and never ignored.
  SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text COLLATE "C") INTO v_text
  FROM pg_proc p
  WHERE p.proname IN ('immutable_english_tsvector_text', 'immutable_english_tsvector_textarr', 'immutable_english_tsvector_jsonb')
    AND p.oid <> ALL (v_targets);
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION E'retire_tsvector_wrappers: STOP — unexpected function(s) share a target name:\n%', v_text;
  END IF;

  -- ── 1c. The EXECUTE ACL is one reviewed representation ──────────────────────
  -- NULL on a clean replay (PostgreSQL's default: owner and PUBLIC), or the
  -- explicit hosted form in Production — and all three share it.
  SELECT count(DISTINCT coalesce(p.proacl::text, '<default>')), min(coalesce(p.proacl::text, '<default>')) INTO v_count, v_text
  FROM pg_proc p WHERE p.oid = ANY (v_targets);
  IF v_count <> 1 OR v_text NOT IN ('<default>',
       '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: the targets'' EXECUTE ACLs are not one of the two reviewed representations (% distinct; %)',
      v_count, v_text;
  END IF;

  -- ── 1d. Nothing depends on a target — pg_depend ─────────────────────────────
  SELECT string_agg(pg_describe_object(d.classid, d.objid, d.objsubid) || ' -> ' || d.refobjid::regprocedure::text
                    || ' (' || d.deptype::text || ')', E'\n' ORDER BY 1) INTO v_text
  FROM pg_depend d WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = ANY (v_targets);
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION E'retire_tsvector_wrappers: STOP — database objects depend on a target:\n%', v_text;
  END IF;

  -- ── 1e. Nothing refers to a target — stored node trees ──────────────────────
  -- Independent of pg_depend: every stored expression tree that can call a
  -- function — column defaults and generated columns, CHECK constraints, index
  -- expressions and predicates, view and rule actions, policies, trigger WHEN
  -- clauses, extended statistics, publication row filters and SQL-standard
  -- routine bodies — scanned for a call node on a target OID.
  SELECT ':(?:funcid|opfuncid|aggfnoid|winfnoid) (?:' || array_to_string(v_targets, '|') || ')[ }]' INTO v_re;
  SELECT string_agg(x.what, E'\n' ORDER BY x.what) INTO v_text
  FROM (
    SELECT 'column default ' || d.adrelid::regclass::text || '.' || d.adnum::text AS what FROM pg_attrdef d WHERE d.adbin::text ~ v_re
    UNION ALL SELECT 'constraint ' || k.conname FROM pg_constraint k WHERE k.conbin::text ~ v_re
    UNION ALL SELECT 'index ' || i.indexrelid::regclass::text FROM pg_index i WHERE i.indexprs::text ~ v_re OR i.indpred::text ~ v_re
    UNION ALL SELECT 'rule ' || r.rulename || ' on ' || r.ev_class::regclass::text FROM pg_rewrite r WHERE r.ev_action::text ~ v_re OR r.ev_qual::text ~ v_re
    UNION ALL SELECT 'policy ' || pol.polname FROM pg_policy pol WHERE pol.polqual::text ~ v_re OR pol.polwithcheck::text ~ v_re
    UNION ALL SELECT 'trigger ' || t.tgname FROM pg_trigger t WHERE t.tgqual::text ~ v_re
    UNION ALL SELECT 'statistics ' || s.stxname FROM pg_statistic_ext s WHERE s.stxexprs::text ~ v_re
    UNION ALL SELECT 'publication filter ' || pr.oid::text FROM pg_publication_rel pr WHERE pr.prqual::text ~ v_re
    UNION ALL SELECT 'routine ' || p.oid::regprocedure::text FROM pg_proc p WHERE p.prosqlbody::text ~ v_re
  ) x;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION E'retire_tsvector_wrappers: STOP — stored expressions call a target:\n%', v_text;
  END IF;

  -- ── 1f. Nothing refers to a target — function-OID catalog columns ───────────
  SELECT string_agg(x.what, E'\n' ORDER BY x.what) INTO v_text
  FROM (
    SELECT 'trigger ' || t.tgname AS what FROM pg_trigger t WHERE t.tgfoid = ANY (v_targets)
    UNION ALL SELECT 'event trigger ' || e.evtname FROM pg_event_trigger e WHERE e.evtfoid = ANY (v_targets)
    UNION ALL SELECT 'cast ' || c.oid::text FROM pg_cast c WHERE c.castfunc = ANY (v_targets)
    UNION ALL SELECT 'operator ' || o.oid::regoperator::text FROM pg_operator o
               WHERE o.oprcode = ANY (v_targets) OR o.oprrest = ANY (v_targets) OR o.oprjoin = ANY (v_targets)
    UNION ALL SELECT 'aggregate ' || a.aggfnoid::regprocedure::text FROM pg_aggregate a
               WHERE ARRAY[a.aggfnoid, a.aggtransfn, a.aggfinalfn, a.aggcombinefn, a.aggserialfn, a.aggdeserialfn,
                           a.aggmtransfn, a.aggminvtransfn, a.aggmfinalfn]::oid[] && v_targets
    UNION ALL SELECT 'type ' || ty.oid::regtype::text FROM pg_type ty
               WHERE ARRAY[ty.typinput, ty.typoutput, ty.typreceive, ty.typsend, ty.typmodin, ty.typmodout,
                           ty.typanalyze, ty.typsubscript]::oid[] && v_targets
    UNION ALL SELECT 'range ' || rg.rngtypid::regtype::text FROM pg_range rg
               WHERE rg.rngcanonical = ANY (v_targets) OR rg.rngsubdiff = ANY (v_targets)
    UNION ALL SELECT 'language ' || lg.lanname FROM pg_language lg
               WHERE ARRAY[lg.lanplcallfoid, lg.laninline, lg.lanvalidator]::oid[] && v_targets
    UNION ALL SELECT 'transform ' || tf.oid::text FROM pg_transform tf
               WHERE tf.trffromsql = ANY (v_targets) OR tf.trftosql = ANY (v_targets)
    UNION ALL SELECT 'support function of ' || p.oid::regprocedure::text FROM pg_proc p WHERE p.prosupport = ANY (v_targets)
    UNION ALL SELECT 'operator-class support ' || ap.oid::text FROM pg_amproc ap WHERE ap.amproc = ANY (v_targets)
  ) x;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION E'retire_tsvector_wrappers: STOP — catalog entries reference a target:\n%', v_text;
  END IF;

  -- ── 1g. No routine body names a target ──────────────────────────────────────
  -- A PL/pgSQL, SQL or dynamic-SQL body is text and records no dependency, so
  -- every routine's source is searched by name, as is pg_cron's job table
  -- where that extension exists (neither environment has it today).
  SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text COLLATE "C") INTO v_text
  FROM pg_proc p
  WHERE p.oid <> ALL (v_targets)
    AND (p.prosrc ~* 'immutable_english_tsvector_(text|textarr|jsonb)'
         OR coalesce(pg_get_function_sqlbody(p.oid), '') ~* 'immutable_english_tsvector_(text|textarr|jsonb)');
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION E'retire_tsvector_wrappers: STOP — routine bodies name a target:\n%', v_text;
  END IF;
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM cron.job WHERE command ~* 'immutable_english_tsvector_(text|textarr|jsonb)'$q$ INTO v_count;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'retire_tsvector_wrappers: STOP — % pg_cron job(s) name a target', v_count;
    END IF;
  END IF;

  -- ── 1h. papers.search_vector is still C54's canonical direct expression ─────
  -- Its digest, its complete dependency set and the calls in its node tree
  -- (compared as OIDs, one resolved signature per row). The wrapper form would
  -- have failed 1d/1e already; this names the reason precisely.
  SELECT array_agg(to_regprocedure(s)::oid ORDER BY to_regprocedure(s)::oid), count(*) FILTER (WHERE to_regprocedure(s) IS NULL)
    INTO v_direct, v_count
  FROM (VALUES ('pg_catalog.setweight(tsvector,"char")'),
               ('pg_catalog.to_tsvector(regconfig,text)'),
               ('pg_catalog.tsvector_concat(tsvector,tsvector)')) AS w(s);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: % reviewed search_vector callee(s) do not resolve', v_count;
  END IF;

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
  WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector' AND NOT a.attisdropped;

  IF v_md5 IS DISTINCT FROM '8ddd960b4f4b11dd7afd35485d01fd25'
     OR v_deps IS DISTINCT FROM
          'pg_class:public.papers.abstract|n' || E'\n' || 'pg_class:public.papers.authors|n' || E'\n'
          || 'pg_class:public.papers.journal|n' || E'\n' || 'pg_class:public.papers.keywords|n' || E'\n'
          || 'pg_class:public.papers.notes|n' || E'\n' || 'pg_class:public.papers.search_vector|i' || E'\n'
          || 'pg_class:public.papers.title|n' || E'\n' || 'pg_ts_config:english|n'
     OR v_calls IS DISTINCT FROM v_direct THEN
    RAISE EXCEPTION E'retire_tsvector_wrappers: STOP — papers.search_vector is not C54''s canonical direct expression (8ddd960b…); retirement is only reviewed on top of it.\nexpression md5: %\ndependencies:\n%\ncalls: %',
      coalesce(v_md5, '<missing>'), coalesce(v_deps, '<none>'),
      coalesce((SELECT string_agg(c::regprocedure::text, ', ' ORDER BY c) FROM unnest(v_calls) AS c), '<none>');
  END IF;

  -- ── 1i. The search index: GIN(search_vector), valid, ready, live ────────────
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indexrelid = to_regclass('public.idx_papers_search_vector') AND i.indrelid = 'public.papers'::regclass
                    AND i.indisvalid AND i.indisready AND i.indislive
                    AND pg_get_indexdef(i.indexrelid) = 'CREATE INDEX idx_papers_search_vector ON public.papers USING gin (search_vector)') THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: STOP — idx_papers_search_vector is missing, invalid, not ready, not live or no longer GIN(search_vector)';
  END IF;

  -- ── 1j. The reviewed function inventory of `public` ─────────────────────────
  -- 46 functions, of which exactly these five carry PUBLIC EXECUTE.
  SELECT count(*) INTO v_count FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
  IF v_count <> 46 THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: STOP — public holds % functions; the reviewed state holds 46', v_count;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text COLLATE "C") INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                 WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE');
  IF v_text IS DISTINCT FROM
       'public.immutable_english_tsvector_jsonb(jsonb)' || E'\n' || 'public.immutable_english_tsvector_text(text)' || E'\n'
       || 'public.immutable_english_tsvector_textarr(text[])' || E'\n' || 'public.set_updated_at()' || E'\n'
       || 'public.update_updated_at_column()' THEN
    RAISE EXCEPTION E'retire_tsvector_wrappers: STOP — the PUBLIC-executable functions in public are not the reviewed five:\n%',
      coalesce(v_text, '<none>');
  END IF;

  -- ── 1k. Record the targets and the snapshot for section 3 ───────────────────
  PERFORM set_config('paperlume.retire_tsvector_wrappers.targets', v_targets::text, true);
  PERFORM set_config('paperlume.retire_tsvector_wrappers.snapshot_sql', c_snapshot, true);
  EXECUTE c_snapshot INTO v_text USING v_targets;
  PERFORM set_config('paperlume.retire_tsvector_wrappers.snapshot', v_text, true);
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The change — three exact drops, RESTRICT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The targets are independent of one another, so the order is not semantic;
-- it is fixed here for determinism. RESTRICT is PostgreSQL's own dependency
-- gate: had anything depended on a target, the statement would fail with
-- 2BP01 and the whole file would roll back.

DROP FUNCTION public.immutable_english_tsvector_text(text) RESTRICT;
DROP FUNCTION public.immutable_english_tsvector_textarr(text[]) RESTRICT;
DROP FUNCTION public.immutable_english_tsvector_jsonb(jsonb) RESTRICT;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed verification — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

DO $verify$
DECLARE
  v_targets  OID[];
  v_before   TEXT;
  v_after    TEXT;
  v_text     TEXT;
  v_count    INTEGER;
BEGIN
  v_targets := nullif(current_setting('paperlume.retire_tsvector_wrappers.targets', true), '')::oid[];
  v_before  := current_setting('paperlume.retire_tsvector_wrappers.snapshot', true);
  IF cardinality(v_targets) IS DISTINCT FROM 3 OR coalesce(v_before, '') = '' THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: the targets or snapshot recorded in section 1 are missing — this file must run as one transaction';
  END IF;

  -- ── 3a. The three targets are gone, by signature, by OID and by name ────────
  SELECT string_agg(w.sig, ', ' ORDER BY w.sig) INTO v_text
  FROM (VALUES ('public.immutable_english_tsvector_jsonb(jsonb)'),
               ('public.immutable_english_tsvector_text(text)'),
               ('public.immutable_english_tsvector_textarr(text[])')) AS w(sig)
  WHERE to_regprocedure(w.sig) IS NOT NULL;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: still present after the drop: %', v_text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid = ANY (v_targets)
                 OR p.proname IN ('immutable_english_tsvector_text', 'immutable_english_tsvector_textarr', 'immutable_english_tsvector_jsonb')) THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: a function with a target OID or name still exists after the drop';
  END IF;

  -- ── 3b. Everything else is exactly as section 1 found it ───────────────────
  -- Every other function (public rows whole; database-wide by OID, so no
  -- overload elsewhere was removed), every public relation, column, default,
  -- constraint, index, policy, trigger, rule and type, every default
  -- privilege, the public schema, the event triggers, the search column and
  -- its index. The failure names each category that moved.
  EXECUTE current_setting('paperlume.retire_tsvector_wrappers.snapshot_sql', true) INTO v_after USING v_targets;
  SELECT string_agg(coalesce(b.cat, a.cat), ', ' ORDER BY coalesce(b.cat, a.cat)) INTO v_text
  FROM (SELECT split_part(l, '|', 1) AS cat, l FROM unnest(string_to_array(v_before, E'\n')) AS l) b
  FULL JOIN (SELECT split_part(l, '|', 1) AS cat, l FROM unnest(string_to_array(v_after, E'\n')) AS l) a USING (cat)
  WHERE b.l IS DISTINCT FROM a.l;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: something besides the three targets changed: %', v_text;
  END IF;

  -- ── 3c. The inventory moved by exactly the three targets ────────────────────
  SELECT count(*) INTO v_count FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
  IF v_count <> 43 THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: public holds % functions after the drop; expected 43', v_count;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text COLLATE "C") INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                 WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE');
  IF v_text IS DISTINCT FROM 'public.set_updated_at()' || E'\n' || 'public.update_updated_at_column()' THEN
    RAISE EXCEPTION E'retire_tsvector_wrappers: the PUBLIC-executable functions in public are not exactly set_updated_at() and update_updated_at_column():\n%',
      coalesce(v_text, '<none>');
  END IF;

  -- ── 3d. The search column and index are still canonical and usable ─────────
  IF (SELECT md5(pg_get_expr(d.adbin, d.adrelid))
        FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector')
     IS DISTINCT FROM '8ddd960b4f4b11dd7afd35485d01fd25' THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: papers.search_vector is no longer the canonical direct expression';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indexrelid = to_regclass('public.idx_papers_search_vector')
                    AND i.indisvalid AND i.indisready AND i.indislive) THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: idx_papers_search_vector is no longer valid, ready and live';
  END IF;

  -- ── 3e. No relation in `public` was locked at all ───────────────────────────
  -- DROP FUNCTION locks only the three function objects (ACCESS EXCLUSIVE),
  -- and every check above reads system catalogs only. So this transaction
  -- holds no lock of any mode on papers, its indexes or any other relation in
  -- `public`.
  SELECT coalesce(string_agg(DISTINCT l.relation::regclass::text || ' ' || l.mode, ', '), '') INTO v_text
  FROM pg_locks l
  WHERE l.locktype = 'relation' AND l.pid = pg_backend_pid()
    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND l.relation IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace);
  IF v_text <> '' THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: this transaction holds a lock on a relation in public: %', v_text;
  END IF;

  -- ── 3f. This transaction wrote no row ────────────────────────────────────────
  v_before := current_setting('paperlume.retire_tsvector_wrappers.xact_writes_at_start', true);
  IF coalesce(v_before, '') = '' THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  SELECT string_agg(
           n.nspname || '.' || c.relname || '=' || (pg_stat_get_xact_tuples_inserted(c.oid)
                                                    + pg_stat_get_xact_tuples_updated(c.oid)
                                                    + pg_stat_get_xact_tuples_deleted(c.oid)),
           ' ' ORDER BY n.nspname, c.relname) INTO v_text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p');
  IF v_text IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'retire_tsvector_wrappers: this transaction wrote application rows (row writes at start: %; now: %)', v_before, v_text;
  END IF;
END
$verify$;

COMMIT;
