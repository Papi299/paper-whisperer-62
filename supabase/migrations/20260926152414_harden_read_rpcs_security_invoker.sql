-- DB-INVOKER-EXECUTE-HARDENING-001A — the five caller-scoped read RPCs run as
-- SECURITY INVOKER.
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly one catalog attribute on exactly five functions, `prosecdef`
-- true → false:
--
--   public.search_papers(uuid,text,integer,integer)
--   public.search_papers_short(uuid,text)
--   public.filter_papers_by_keywords(uuid,text[])
--   public.get_keyword_options(uuid,uuid[],integer,integer,text[])
--   public.get_duplicate_papers()
--
-- Nothing else moves: not a body, signature, argument name or default, return
-- type, language, volatility, parallel mode, cost, `search_path`, owner or
-- EXECUTE ACL of these five; not another function; not a table ACL, RLS flag or
-- policy; not a row. `authenticated` keeps EXECUTE on all five, and `anon`,
-- `service_role` and PUBLIC still hold none. Section 3 proves every one of those
-- facts before COMMIT, comparing each function's whole `pg_proc` row except
-- `prosecdef` against its pre-change snapshot.
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- The DB-INVOKER-EXECUTE-HARDENING-001 design audit classified the 32
-- authenticated-callable SECURITY DEFINER functions in `public`: 24 need the
-- owner's authority (they write tables the browser cannot write, read tables the
-- browser cannot read, or are evaluated by a Storage policy) and 8 do not. These
-- five are the read-only part of the 8. Each reads only `public.papers` (and
-- `filter_papers_by_keywords` also `public.synonym_pool`), filtered to the
-- caller's own rows — which is exactly what `authenticated` can already read on
-- its own through its table SELECT grant and the caller-owned RLS SELECT
-- policies. Running them as the owner (`postgres`, which has BYPASSRLS) added
-- authority nothing in their contract needs, and made each body's own
-- `auth.uid()` predicate the ONLY database boundary between one account and
-- another's library. As SECURITY INVOKER the ordinary table ACL and RLS become
-- the primary boundary again; the body predicates stay as defense-in-depth.
--
-- The remaining three candidates of the 8 — `bulk_update_keywords`,
-- `bulk_update_study_types`, `safe_bulk_insert_papers` — write, and belong to
-- later, separately reviewed groups. The 24 intentional SECURITY DEFINER
-- functions are untouched, and section 3 proves it.
--
-- WHY THIS IS SAFE — the boundary the five now rely on
-- ─────────────────────────────────────────────────────────────────────────────
-- A SECURITY INVOKER function runs with the CALLER's privileges. Through
-- PostgREST that is `authenticated`, which is neither superuser nor BYPASSRLS,
-- so every row the bodies read is filtered by the caller's RLS. What they need:
--
--   * SELECT on `public.papers` and `public.synonym_pool` — table-level, so it
--     covers every column the bodies read, `search_vector` included;
--   * the caller-owned SELECT policies
--       papers        "Users can view their own papers"          USING (auth.uid() = user_id)
--       synonym_pool  "Users can view their own synonym groups"  USING (auth.uid() = user_id)
--     both PERMISSIVE, for PUBLIC, and no RESTRICTIVE policy beside them;
--   * USAGE on schemas `public` and `auth`, and EXECUTE on `auth.uid()` — the
--     RLS policies already need exactly these, so the browser has always held
--     them.
--
-- Section 1 refuses to run unless every one of those facts holds exactly — all
-- eight policies of both tables are pinned by name, command, mode, roles,
-- USING and WITH CHECK, and by digest — because after this migration a
-- broadened policy or a lost grant would change what these functions return.
--
-- The explicit identity logic in the bodies is intentionally KEPT:
--   * search_papers, search_papers_short, filter_papers_by_keywords and
--     get_keyword_options still raise 'Unauthorized: user mismatch' (P0001) for
--     a NULL p_user_id, a NULL auth.uid() or p_user_id <> auth.uid();
--   * get_duplicate_papers still derives v_user_id := auth.uid() and scopes to it.
-- Those are the product contract and defense-in-depth; RLS is now the primary
-- database enforcement layer beneath them. No caller-visible result changes:
-- for the caller's own id the body predicate and the RLS predicate select the
-- same rows, and every other input is refused before the first read, as today.
--
-- CONCURRENCY AND ROLLOUT
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration-only. No Edge Function calls these five and no client or type
-- change is needed (signatures are unchanged, so generated types are too). A
-- call already executing when this commits finishes under the mode it started
-- with; the next statement resolves the function afresh. Both modes return the
-- same rows to a legitimate caller, so no ordering or lock barrier is needed.
--
-- The file is explicitly transactional (see 20260910212202 for why
-- `supabase db reset` requires that): the preconditions, the five ALTERs and the
-- verification commit together or not at all.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- Forward-fix preferred. The reviewed restoration is exactly the five
--   ALTER FUNCTION ... SECURITY DEFINER;
-- statements, which returns them to their pre-change shape (bodies, ACL and
-- configuration were never touched). It re-adds authority, it does not remove a
-- boundary. See docs/deployment.md §6.10.
--
-- Durable decision: C49 (narrows the S1 inventory; S1 itself is unchanged).

BEGIN;


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context, and this transaction's own write counters
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only a function's owner can change its security mode, and all five are owned
-- by `postgres`. Section 3 proves this transaction wrote no row to the two
-- tables the five read, from PostgreSQL's per-transaction statistics (see
-- 20260924193915 §0 for why the baseline is taken here, and why it lives in a
-- transaction-local setting a runner without the BEGIN above would lose).

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'read_rpc_invoker: must run as postgres (current_user is %) — only the owner can change the security mode of the five read RPCs',
      current_user;
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'read_rpc_invoker: track_counts is off, so the no-write self-check could not observe anything';
  END IF;

  PERFORM set_config(
    'paperlume.read_rpc_invoker.xact_writes_at_start',
    (SELECT string_agg(
              t || '=' || (pg_stat_get_xact_tuples_inserted(t::regclass)
                           + pg_stat_get_xact_tuples_updated(t::regclass)
                           + pg_stat_get_xact_tuples_deleted(t::regclass)),
              ' ' ORDER BY t)
       FROM unnest(ARRAY['public.papers', 'public.synonym_pool']) AS t),
    true);
END
$ctx$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Preconditions — the exact state this change was reviewed against
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Verified read-only against Production on 2026-09-26 (ledger 88, latest
-- 20260925134526; 40 public SECURITY DEFINER functions, 32 of them executable
-- by authenticated) and byte-identical on a clean local replay (PostgreSQL
-- 17.6). Nothing here repairs unexpected state: any mismatch rolls the whole
-- file back before a single attribute changes. The snapshots at the end of this
-- block are what section 3 compares against.

DO $pre$
DECLARE
  v_count  INTEGER;
  v_text   TEXT;
  v_want   TEXT;
  v_all    CONSTANT TEXT[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
  v_five   CONSTANT TEXT[] := ARRAY[
    'public.search_papers(uuid,text,integer,integer)',
    'public.search_papers_short(uuid,text)',
    'public.filter_papers_by_keywords(uuid,text[])',
    'public.get_keyword_options(uuid,uuid[],integer,integer,text[])',
    'public.get_duplicate_papers()'];
BEGIN
  -- ── 1a. Roles: the caller is an ordinary, RLS-subject role ──────────────────
  IF to_regrole('authenticated') IS NULL OR to_regrole('anon') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'read_rpc_invoker: one of the roles authenticated / anon / service_role does not exist';
  END IF;

  -- If `authenticated` could bypass RLS, SECURITY INVOKER would leave the body
  -- predicates as the only boundary again — the state this change removes.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'read_rpc_invoker: authenticated is SUPERUSER or BYPASSRLS, so RLS could not be its boundary';
  END IF;

  -- What the caller needs to run the bodies and their RLS predicate at all.
  IF NOT has_schema_privilege('authenticated', 'public', 'USAGE')
     OR NOT has_schema_privilege('authenticated', 'auth', 'USAGE')
     OR NOT has_function_privilege('authenticated', 'auth.uid()', 'EXECUTE') THEN
    RAISE EXCEPTION 'read_rpc_invoker: authenticated lacks USAGE on public/auth or EXECUTE on auth.uid(), which the INVOKER bodies and their RLS predicate need';
  END IF;

  -- ── 1b. The five functions: exactly the reviewed shape ──────────────────────
  -- One overload each; owner postgres; SECURITY DEFINER; plpgsql; the reviewed
  -- volatility, parallel mode, result, arguments with defaults and body (md5 of
  -- prosrc, identical in Production); search_path=public and nothing else; the
  -- exact EXECUTE ACL; and the effective posture of every relevant grantee.
  SELECT coalesce(string_agg(e.sig, ', ' ORDER BY e.sig), '') INTO v_text
  FROM (VALUES
    ('public.search_papers(uuid,text,integer,integer)', 'v', true,
     'TABLE(paper_id uuid, rank real, matched_title boolean, matched_abstract boolean, matched_authors boolean, matched_journal boolean, matched_notes boolean, matched_keywords boolean)',
     'p_user_id uuid, p_query text, p_limit integer DEFAULT 1000, p_offset integer DEFAULT 0',
     'd4a5f3afdc485d5dfda8e0798c61cc48'),
    ('public.search_papers_short(uuid,text)', 's', true,
     'TABLE(paper_id uuid, matched_title boolean, matched_abstract boolean, matched_authors boolean, matched_journal boolean, matched_notes boolean, matched_keywords boolean)',
     'p_user_id uuid, p_query text',
     'ce353564edcb73a5466092e84d0b8d1b'),
    ('public.filter_papers_by_keywords(uuid,text[])', 's', true,
     'TABLE(paper_id uuid)',
     'p_user_id uuid, p_keywords text[]',
     'b2f5a8e58589a5a094a7074c5ed9bb2d'),
    ('public.get_keyword_options(uuid,uuid[],integer,integer,text[])', 's', true,
     'TABLE(keyword text)',
     'p_user_id uuid, p_paper_ids uuid[] DEFAULT NULL::uuid[], p_year_from integer DEFAULT NULL::integer, p_year_to integer DEFAULT NULL::integer, p_study_types text[] DEFAULT NULL::text[]',
     '531010c10d84ee94c7c1e00d65a2e7f5'),
    ('public.get_duplicate_papers()', 'v', false,
     'jsonb',
     '',
     '3c914811a9b8c75b9df834e1cf51e1e0')
  ) AS e(sig, volatility, retset, result, args, body_md5)
  WHERE to_regprocedure(e.sig) IS NULL
     OR (SELECT count(*) FROM pg_proc p2
          WHERE p2.pronamespace = 'public'::regnamespace
            AND p2.proname = (SELECT proname FROM pg_proc WHERE oid = to_regprocedure(e.sig))) <> 1
     OR NOT EXISTS (
          SELECT 1 FROM pg_proc p
          WHERE p.oid = to_regprocedure(e.sig)
            AND p.pronamespace = 'public'::regnamespace
            AND p.proowner = 'postgres'::regrole
            AND p.prosecdef
            AND p.prokind = 'f'
            AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
            AND p.provolatile::text = e.volatility
            AND p.proparallel = 'u'
            AND NOT p.proisstrict
            AND NOT p.proleakproof
            AND p.proretset = e.retset
            AND pg_get_function_result(p.oid) = e.result
            AND pg_get_function_arguments(p.oid) = e.args
            AND p.proconfig = ARRAY['search_path=public']
            AND md5(p.prosrc) = e.body_md5
            AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres}')
     OR NOT has_function_privilege('postgres', to_regprocedure(e.sig), 'EXECUTE')
     OR NOT has_function_privilege('authenticated', to_regprocedure(e.sig), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure(e.sig), 'EXECUTE')
     OR has_function_privilege('service_role', to_regprocedure(e.sig), 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = to_regprocedure(e.sig) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE');
  IF v_text <> '' THEN
    RAISE EXCEPTION 'read_rpc_invoker: read RPC(s) not in the reviewed shape (missing/overloaded, owner, SECURITY DEFINER, language, volatility, parallel, result, arguments, search_path, body digest or EXECUTE ACL/posture): %', v_text;
  END IF;

  -- ── 1c. The two relations the bodies read ───────────────────────────────────
  -- Ordinary postgres-owned tables, RLS enabled AND forced. `authenticated`
  -- holds exactly its reviewed grant, direct and effective — SELECT is the one
  -- the five need; the rest is pinned so section 3 can prove nothing moved.
  -- anon holds nothing, PUBLIC nothing, and nobody outside postgres /
  -- authenticated / service_role is a grantee. No column-level grant exists on
  -- either (Production: none), so the table-level SELECT is the whole story.
  SELECT coalesce(string_agg(r.rel, ', ' ORDER BY r.rel), '') INTO v_text
  FROM (VALUES ('public.papers', 'INSERT,SELECT,UPDATE'),
               ('public.synonym_pool', 'DELETE,INSERT,SELECT,UPDATE')) AS r(rel, auth_privs)
  WHERE to_regclass(r.rel) IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_class c
                     WHERE c.oid = to_regclass(r.rel) AND c.relkind = 'r'
                       AND c.relowner = 'postgres'::regrole
                       AND c.relrowsecurity AND c.relforcerowsecurity)
     OR (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
           FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
          WHERE c.oid = to_regclass(r.rel) AND a.grantee = 'authenticated'::regrole) <> r.auth_privs
     OR (SELECT coalesce(string_agg(p, ',' ORDER BY p), '')
           FROM unnest(v_all) p WHERE has_table_privilege('authenticated', to_regclass(r.rel), p)) <> r.auth_privs
     OR EXISTS (SELECT 1 FROM unnest(v_all) p WHERE has_table_privilege('anon', to_regclass(r.rel), p))
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                 WHERE c.oid = to_regclass(r.rel)
                   AND a.grantee NOT IN ('postgres'::regrole, 'authenticated'::regrole, 'service_role'::regrole))
     OR EXISTS (SELECT 1 FROM pg_attribute att WHERE att.attrelid = to_regclass(r.rel) AND att.attacl IS NOT NULL);
  IF v_text <> '' THEN
    RAISE EXCEPTION 'read_rpc_invoker: relation(s) not in the reviewed shape (owner, RLS/FORCE RLS, authenticated direct/effective grant, anon/PUBLIC/unknown grantee, or a column-level grant): %', v_text;
  END IF;

  -- ── 1d. The eight RLS policies are exactly the reviewed caller-owned set ────
  -- These are now the primary boundary of all five functions, so a policy that
  -- was broadened, narrowed, renamed, made restrictive, re-targeted or joined by
  -- another is a reason to stop. Readable comparison first, so a failure says
  -- what differs; then the digest (identical in Production and on a replay),
  -- which is the same formula the C48 migration pinned its junction policies with.
  SELECT coalesce(string_agg(x.line, E'\n' ORDER BY x.line), '') INTO v_text
  FROM (SELECT c.relname || '|' || pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
               || (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                     FROM unnest(pol.polroles) r) || '|'
               || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>') || '|'
               || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>') AS line
          FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
         WHERE pol.polrelid IN ('public.papers'::regclass, 'public.synonym_pool'::regclass)) x;
  SELECT string_agg(w.line, E'\n' ORDER BY w.line) INTO v_want
  FROM (VALUES
    ('papers|Users can create their own papers|a|true|PUBLIC|<null>|(auth.uid() = user_id)'),
    ('papers|Users can delete their own papers|d|true|PUBLIC|(auth.uid() = user_id)|<null>'),
    ('papers|Users can update their own papers|w|true|PUBLIC|(auth.uid() = user_id)|<null>'),
    ('papers|Users can view their own papers|r|true|PUBLIC|(auth.uid() = user_id)|<null>'),
    ('synonym_pool|Users can create their own synonym groups|a|true|PUBLIC|<null>|(auth.uid() = user_id)'),
    ('synonym_pool|Users can delete their own synonym groups|d|true|PUBLIC|(auth.uid() = user_id)|<null>'),
    ('synonym_pool|Users can update their own synonym groups|w|true|PUBLIC|(auth.uid() = user_id)|<null>'),
    ('synonym_pool|Users can view their own synonym groups|r|true|PUBLIC|(auth.uid() = user_id)|<null>')
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'read_rpc_invoker: the papers / synonym_pool RLS policies are not the reviewed caller-owned set.\nfound:\n%\nexpected:\n%', v_text, v_want;
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
    RAISE EXCEPTION 'read_rpc_invoker: the papers / synonym_pool RLS policy digest is not the reviewed one';
  END IF;

  -- ── 1e. The SECURITY DEFINER inventory this change is carved out of ─────────
  -- 40 in public, 32 of them authenticated-executable, and the five are among
  -- the 32 (1b). A different count means the surface drifted after the audit
  -- and must be re-reviewed before anything leaves it.
  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef;
  IF v_count <> 40 THEN
    RAISE EXCEPTION 'read_rpc_invoker: % SECURITY DEFINER functions in public; the reviewed inventory is 40', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND prosecdef AND has_function_privilege('authenticated', oid, 'EXECUTE');
  IF v_count <> 32 THEN
    RAISE EXCEPTION 'read_rpc_invoker: % authenticated-executable SECURITY DEFINER functions in public; the reviewed inventory is 32', v_count;
  END IF;

  -- ── 1f. Snapshots of everything this migration must NOT change ─────────────
  -- Transaction-local; read back in section 3.

  -- Each of the five, as its WHOLE pg_proc row except prosecdef — oid included,
  -- so a drop-and-recreate could not pass as an ALTER.
  PERFORM set_config('paperlume.read_rpc_invoker.pre_five',
    (SELECT string_agg(p.oid::regprocedure::text || '=' || md5((to_jsonb(p.*) - 'prosecdef')::text), E'\n'
                       ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_five) s)), true);

  -- Every OTHER function in public, whole rows, prosecdef included — the 24
  -- retained definer RPCs, the 3 later INVOKER candidates, the server-only,
  -- trigger and internal functions, and every existing INVOKER routine.
  PERFORM set_config('paperlume.read_rpc_invoker.pre_others',
    (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_five) s)), true);

  -- The authenticated-executable SECURITY DEFINER functions that STAY (27).
  PERFORM set_config('paperlume.read_rpc_invoker.pre_retained_definer',
    (SELECT string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_five) s)), true);

  -- The authenticated-executable SECURITY INVOKER routines that already exist.
  PERFORM set_config('paperlume.read_rpc_invoker.pre_invoker',
    (SELECT coalesce(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text), '')
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND NOT p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')), true);

  -- Both relations: owner, RLS flags and the WHOLE ACL as stored.
  PERFORM set_config('paperlume.read_rpc_invoker.pre_relations',
    (SELECT string_agg(c.relname || '|' || pg_get_userbyid(c.relowner) || '|' || c.relrowsecurity::text || '|'
                       || c.relforcerowsecurity::text || '|' || coalesce(c.relacl::text, 'NULL'), E'\n' ORDER BY c.relname)
       FROM pg_class c WHERE c.oid IN ('public.papers'::regclass, 'public.synonym_pool'::regclass)), true);
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The change
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Five statements, one attribute each. No CREATE OR REPLACE: the reviewed
-- bodies are kept byte-for-byte, and section 3 proves it.
--
-- A note on search_papers' stored body. It still carries its historical inline
-- comment, written by 20260518010000:
--   "Ownership guard: defense-in-depth on top of RLS. SECURITY DEFINER
--    bypasses table-level RLS, so we must verify the caller owns the
--    requested user_id ourselves."
-- THIS MIGRATION SUPERSEDES THAT COMMENT. From here on search_papers is
-- SECURITY INVOKER: table-level RLS applies to it as the caller, and the guard
-- beneath the comment is defense-in-depth. The body is deliberately not
-- recreated just to edit a comment — the objective is a change to `prosecdef`
-- alone. The historical sentence may be removed the next time the function body
-- is legitimately recreated; until then docs/decisions-and-triggers.md (C49)
-- and docs/architecture-read-path.md describe the current security mode.

ALTER FUNCTION public.search_papers(uuid,text,integer,integer)
  SECURITY INVOKER;

ALTER FUNCTION public.search_papers_short(uuid,text)
  SECURITY INVOKER;

ALTER FUNCTION public.filter_papers_by_keywords(uuid,text[])
  SECURITY INVOKER;

ALTER FUNCTION public.get_keyword_options(uuid,uuid[],integer,integer,text[])
  SECURITY INVOKER;

ALTER FUNCTION public.get_duplicate_papers()
  SECURITY INVOKER;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed verification — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

DO $verify$
DECLARE
  v_sig   TEXT;
  v_text  TEXT;
  v_base  TEXT;
  v_count INTEGER;
  v_five  CONSTANT TEXT[] := ARRAY[
    'public.search_papers(uuid,text,integer,integer)',
    'public.search_papers_short(uuid,text)',
    'public.filter_papers_by_keywords(uuid,text[])',
    'public.get_keyword_options(uuid,uuid[],integer,integer,text[])',
    'public.get_duplicate_papers()'];
BEGIN
  -- ── 3a. All five are SECURITY INVOKER, with the EXECUTE posture unchanged ───
  FOREACH v_sig IN ARRAY v_five LOOP
    IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(v_sig)) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'read_rpc_invoker: % is not SECURITY INVOKER after the change', v_sig;
    END IF;

    IF (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure(v_sig))
         IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres}'
       OR NOT has_function_privilege('postgres', to_regprocedure(v_sig), 'EXECUTE')
       OR NOT has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE')
       OR has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
       OR has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = to_regprocedure(v_sig) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'read_rpc_invoker: the EXECUTE ACL or effective posture of % changed', v_sig;
    END IF;

    -- Restated literally, so a failure names the attribute rather than a digest.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = to_regprocedure(v_sig)
                      AND p.proowner = 'postgres'::regrole
                      AND p.proconfig = ARRAY['search_path=public']
                      AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')) THEN
      RAISE EXCEPTION 'read_rpc_invoker: the owner, search_path or language of % changed', v_sig;
    END IF;
  END LOOP;

  -- ── 3b. Body, signature, result, arguments/defaults, volatility, parallel,
  --        config, owner and ACL: the whole row except prosecdef is unchanged ──
  v_base := current_setting('paperlume.read_rpc_invoker.pre_five', true);
  SELECT string_agg(p.oid::regprocedure::text || '=' || md5((to_jsonb(p.*) - 'prosecdef')::text), E'\n'
                    ORDER BY p.oid::regprocedure::text) INTO v_text
  FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_five) s);
  IF coalesce(v_base, '') = '' OR v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'read_rpc_invoker: an attribute other than prosecdef changed on one of the five (before: %; after: %)', v_base, v_text;
  END IF;

  -- Belt and braces on the two facts review cares most about.
  IF (SELECT string_agg(md5(prosrc), ',' ORDER BY md5(prosrc) COLLATE "C") FROM pg_proc
       WHERE oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_five) s))
     IS DISTINCT FROM '3c914811a9b8c75b9df834e1cf51e1e0,531010c10d84ee94c7c1e00d65a2e7f5,b2f5a8e58589a5a094a7074c5ed9bb2d,ce353564edcb73a5466092e84d0b8d1b,d4a5f3afdc485d5dfda8e0798c61cc48' THEN
    RAISE EXCEPTION 'read_rpc_invoker: a function body changed';
  END IF;

  -- ── 3c. No other function in public moved ───────────────────────────────────
  v_base := current_setting('paperlume.read_rpc_invoker.pre_others', true);
  IF coalesce(v_base, '') = ''
     OR (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_five) s)) IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'read_rpc_invoker: a function outside the five changed';
  END IF;

  -- ── 3d. The inventory moved by exactly these five: 40 → 35, 32 → 27 ─────────
  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef;
  IF v_count <> 35 THEN
    RAISE EXCEPTION 'read_rpc_invoker: % SECURITY DEFINER functions in public after the change; expected 35', v_count;
  END IF;

  SELECT count(*), string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text) INTO v_count, v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_count <> 27 OR v_text IS DISTINCT FROM current_setting('paperlume.read_rpc_invoker.pre_retained_definer', true) THEN
    RAISE EXCEPTION 'read_rpc_invoker: the authenticated-executable SECURITY DEFINER set is not exactly the 27 retained functions (count %)', v_count;
  END IF;

  SELECT string_agg(s, ',' ORDER BY s) INTO v_base
  FROM (SELECT unnest(string_to_array(current_setting('paperlume.read_rpc_invoker.pre_invoker', true), ',')) AS s
        UNION
        SELECT to_regprocedure(f)::regprocedure::text FROM unnest(v_five) f) u
  WHERE s <> '';
  SELECT string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text) INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND NOT p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'read_rpc_invoker: the authenticated-executable SECURITY INVOKER set did not grow by exactly the five (expected %; found %)', v_base, v_text;
  END IF;

  -- ── 3e. The boundary the five now rely on is unchanged ──────────────────────
  IF (SELECT string_agg(c.relname || '|' || pg_get_userbyid(c.relowner) || '|' || c.relrowsecurity::text || '|'
                        || c.relforcerowsecurity::text || '|' || coalesce(c.relacl::text, 'NULL'), E'\n' ORDER BY c.relname)
        FROM pg_class c WHERE c.oid IN ('public.papers'::regclass, 'public.synonym_pool'::regclass))
     IS DISTINCT FROM current_setting('paperlume.read_rpc_invoker.pre_relations', true) THEN
    RAISE EXCEPTION 'read_rpc_invoker: the owner, RLS flags or ACL of papers / synonym_pool changed';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.papers', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.synonym_pool', 'SELECT') THEN
    RAISE EXCEPTION 'read_rpc_invoker: authenticated lost SELECT on papers or synonym_pool, which the INVOKER functions now require';
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
    RAISE EXCEPTION 'read_rpc_invoker: an RLS policy on papers / synonym_pool changed';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'read_rpc_invoker: authenticated became SUPERUSER or BYPASSRLS';
  END IF;

  -- ── 3f. Catalog-only: this transaction wrote no row ─────────────────────────
  v_base := current_setting('paperlume.read_rpc_invoker.xact_writes_at_start', true);
  IF coalesce(v_base, '') = '' THEN
    RAISE EXCEPTION 'read_rpc_invoker: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  SELECT string_agg(
           t || '=' || (pg_stat_get_xact_tuples_inserted(t::regclass)
                        + pg_stat_get_xact_tuples_updated(t::regclass)
                        + pg_stat_get_xact_tuples_deleted(t::regclass)),
           ' ' ORDER BY t) INTO v_text
  FROM unnest(ARRAY['public.papers', 'public.synonym_pool']) AS t;
  IF v_text <> v_base THEN
    RAISE EXCEPTION 'read_rpc_invoker: this transaction wrote application rows (row writes at start: %; now: %)', v_base, v_text;
  END IF;
END
$verify$;

COMMIT;
