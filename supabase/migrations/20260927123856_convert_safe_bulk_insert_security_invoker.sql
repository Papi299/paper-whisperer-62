-- DB-SAFE-BULK-INSERT-INVOKER-001 — the caller-owned bulk paper import runs as
-- SECURITY INVOKER.
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly one catalog attribute on exactly one function, `prosecdef`
-- true → false:
--
--   public.safe_bulk_insert_papers(uuid,jsonb)
--
-- Nothing else moves: not the body, OID, signature, argument names or defaults,
-- return type, language, volatility, parallel mode, cost, strictness, owner,
-- comment, EXECUTE ACL or `search_path` (it keeps exactly `public, pg_temp`,
-- from C50); not another function; not a table or sequence grant, RLS flag,
-- policy, trigger, constraint, default, generated column, index or row.
-- `authenticated` keeps EXECUTE, and `anon`, `service_role` and PUBLIC still
-- hold none. Section 3 proves every one of those facts before COMMIT, comparing
-- the function's whole `pg_proc` row except `prosecdef` against its pre-change
-- snapshot.
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- DB-SAFE-BULK-INSERT-INVOKER-AUDIT-001 classified it SAFE TO CONVERT TO
-- SECURITY INVOKER. The body rejects a call unless `p_user_id` is non-NULL and
-- equals a non-NULL `auth.uid()`, then, per payload element, canonicalizes three
-- JSON fields, INSERTs one `papers` row with `user_id = p_user_id` and
-- `RETURNING id`, and on `unique_violation` looks up the caller's own row by the
-- PMID / case-folded DOI it collided on. Every one of those operations is one
-- `authenticated` may already perform on its own rows, through its table INSERT
-- and SELECT grants, USAGE on `papers_insert_order_seq` and the caller-owned RLS
-- INSERT and SELECT policies. Running it as the owner (`postgres`, which has
-- BYPASSRLS) added authority nothing in its contract needs, and made the
-- identity guard the ONLY database boundary between one account and another's
-- library. As SECURITY INVOKER the ordinary table grants and RLS become the
-- primary boundary again: the INSERT policy's WITH CHECK refuses a row for
-- another user, and the SELECT policy both refuses to RETURN such a row and
-- hides other users' rows from the duplicate lookup. The guard stays unchanged,
-- outside the per-row exception block, as defense-in-depth. This is the last of
-- the eight SECURITY DEFINER candidates C49 identified (five read RPCs converted
-- by C49, two bulk metadata writes by C52).
--
-- WHY THIS IS SAFE — the boundary it now relies on
-- ─────────────────────────────────────────────────────────────────────────────
-- A SECURITY INVOKER function runs with the CALLER's privileges. Through
-- PostgREST that is `authenticated`, which is neither superuser nor BYPASSRLS.
-- What the body needs, and what section 1 refuses to run without:
--
--   * INSERT and SELECT on `public.papers` — table-level, so they cover the
--     INSERT column list, `RETURNING id` and the duplicate lookup's columns;
--   * the caller-owned policies
--       "Users can create their own papers"  FOR INSERT  WITH CHECK (auth.uid() = user_id)
--       "Users can view their own papers"    FOR SELECT  USING (auth.uid() = user_id)
--     both PERMISSIVE, for PUBLIC, and no RESTRICTIVE policy beside them;
--   * USAGE on `public.papers_insert_order_seq`, which the `insert_order`
--     default draws from as the current user;
--   * USAGE on schemas `public` and `auth`, and EXECUTE on every function the
--     INSERT evaluates as the current user: the column defaults
--     (gen_random_uuid, nextval, now), the generated `search_vector`
--     expression, the three CHECK constraints, the unique-index expression
--     `lower(doi)`, the RLS policy expressions (auth.uid, uuid_eq) — and every
--     function and operator the PL/pgSQL body itself calls. All are built-ins
--     or wrappers executable through PUBLIC; none is a new dependency, because
--     a direct browser INSERT of `papers` already carries every one except the
--     body's own.
--
-- The INSERT fires no user-defined trigger: both named `papers` triggers are
-- UPDATE-only. The one INSERT-time trigger is the internal foreign-key check
-- `papers.user_id → auth.users(id)`, which PostgreSQL runs as the referenced
-- table's owner, so `authenticated` needs no privilege on `auth.users` for it.
-- Section 1 pins all twelve triggers; none is modified.
--
-- Unchanged caller-visible contract: the same JSONB result — one
-- {index, status, id?, error_message?} object per element, in payload order;
-- `inserted` with the new id; `duplicate` with the caller's existing id only
-- when exactly one owned row matches the PMID or folded DOI it collided on;
-- `error` for a malformed element, while the rest of the batch still inserts;
-- and the guard's P0001 for a NULL, missing or foreign caller identity.
--
-- THE BROAD EXCEPTION HANDLER — kept, by decision
-- ─────────────────────────────────────────────────────────────────────────────
-- The body ends each element's block with `WHEN OTHERS` → a per-row `error`
-- object. That is not changed here. Under INVOKER, caller-specific drift that
-- cannot occur under DEFINER — a revoked table grant, sequence USAGE,
-- dependency EXECUTE, or a policy that refuses the caller — surfaces as
-- per-row `error` when it hits the INSERT, rather than as an RPC error. The
-- audit accepted that: it fails closed (nothing is written and no other
-- account's data is returned), legitimate behavior is identical, and the
-- importer already turns a failed RPC chunk into one failed row per paper, so
-- the user sees the same outcome either way. Drift that strikes inside the
-- duplicate handler itself escapes that handler and fails the whole call.
-- Narrowing the handler (for example `WHEN insufficient_privilege THEN RAISE`)
-- would be a body and API change, and is not part of C53.
--
-- ONE REVIEWED ENVIRONMENT DIFFERENCE — accepted in exactly two shapes
-- ─────────────────────────────────────────────────────────────────────────────
-- The `papers.search_vector` generation expression
-- (DB-SEARCH-VECTOR-EXPRESSION-PARITY-001, tracked separately and NOT resolved
-- here). Rendered under this file's pinned `search_path`, exactly as C51 and
-- C52 pin it:
--   clean replay  dd69f099a274a9cdc0f174ae0883ddb6  — calls the text and jsonb
--                 wrappers, setweight and tsvector_concat
--   hosted        8ddd960b4f4b11dd7afd35485d01fd25  — calls to_tsvector,
--                 setweight and tsvector_concat
-- In both shapes every called function must be executable by `authenticated`.
-- Any third shape is refused. The column, its expression, the stored tsvectors
-- and idx_papers_search_vector are not modified.
--
-- Every caller-EXECUTE check here works on function OIDs taken straight from
-- the catalog, or on one reviewed signature per row that must resolve. No list
-- of signatures is ever joined and split on commas: `(uuid,jsonb)` and
-- `setweight(tsvector,"char")` both contain one.
--
-- CONCURRENCY AND ROLLOUT
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration-only. No Edge Function calls it, and no client or generated type
-- change is needed: the browser (src/hooks/papers/useBulkMutations.ts) calls it
-- with an authenticated session and its own user id, in chunks of 50, and
-- `processChunkedInsert` already accounts for a failed chunk. A call already
-- executing when this commits finishes under the mode it started with; the next
-- call resolves the function afresh. For a legitimate caller both modes insert
-- the same rows and return the same result, so no ordering or lock barrier is
-- needed.
--
-- The file is explicitly transactional (see 20260910212202 for why
-- `supabase db reset` requires that): the preconditions, the ALTER and the
-- verification commit together or not at all.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- Forward-fix preferred. The reviewed restoration is exactly
--   ALTER FUNCTION public.safe_bulk_insert_papers(uuid,jsonb) SECURITY DEFINER;
-- which returns it to its pre-change shape (body, ACL and configuration were
-- never touched). It re-adds authority, it does not remove a boundary. See
-- docs/deployment.md §6.14.
--
-- Durable decision: C53 (narrows the S1 inventory; S1 itself is unchanged).

BEGIN;

-- Every catalog value this file renders and compares (signatures, policy,
-- constraint, index and trigger text, the generation expression) is computed
-- under one fixed path, so the comparison reads the same under any migration
-- runner. The ALTER statement below is fully qualified and unaffected.
-- Transaction-local: COMMIT restores the runner's own setting.
SET LOCAL search_path = pg_catalog, pg_temp;


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context, and this transaction's own write counters
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only a function's owner can change its security mode, and it is owned by
-- `postgres`. Section 3 proves this transaction wrote no row to any table in
-- `public`, `auth` or `storage`, from PostgreSQL's per-transaction statistics
-- (see 20260924193915 §0 for why the baseline is taken here).

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'safe_bulk_insert_invoker: must run as postgres (current_user is %) — only the owner can change the security mode of safe_bulk_insert_papers',
      current_user;
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: track_counts is off, so the no-write self-check could not observe anything';
  END IF;

  IF current_setting('search_path') IS DISTINCT FROM 'pg_catalog, pg_temp' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the pinned rendering path is not in effect (search_path is %) — this file must run as one transaction',
      current_setting('search_path');
  END IF;

  PERFORM set_config(
    'paperlume.safe_bulk_insert_invoker.xact_writes_at_start',
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
-- Verified read-only against Production on 2026-09-27 (PostgreSQL 17.6; ledger
-- 92, latest 20260927071803 convert_bulk_metadata_writes_security_invoker; 33
-- public SECURITY DEFINER functions, 25 of them executable by authenticated,
-- 30 at `public, pg_temp` and 3 at `public`; the target at OID 29057) and on a
-- clean local replay. OIDs differ between environments, so they are not pinned
-- here; section 3 proves the target keeps the OID it had when this file
-- started. Nothing here repairs unexpected state: any mismatch rolls the whole
-- file back before a single attribute changes. The snapshots at the end of this
-- block are what section 3 compares against.

DO $pre$
DECLARE
  v_count     INTEGER;
  v_text      TEXT;
  v_want      TEXT;
  v_expr_md5  TEXT;
  v_expr_deps TEXT;
  v_expr_fns  TEXT;
  v_all       CONSTANT TEXT[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
  v_target    CONSTANT TEXT   := 'public.safe_bulk_insert_papers(uuid,jsonb)';
  v_body_md5  CONSTANT TEXT   := '119925245a5c3c8529ada3d2e10fba96';
BEGIN
  -- ── 1a. Roles: the caller is an ordinary, RLS-subject role ──────────────────
  IF to_regrole('authenticated') IS NULL OR to_regrole('anon') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: one of the roles authenticated / anon / service_role does not exist';
  END IF;

  -- If `authenticated` could bypass RLS, SECURITY INVOKER would leave the
  -- identity guard as the only boundary again — the state this change removes.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: authenticated is SUPERUSER or BYPASSRLS, so RLS could not be its boundary';
  END IF;

  -- What the caller needs to run the body, its guard and its RLS predicates.
  IF NOT has_schema_privilege('authenticated', 'public', 'USAGE')
     OR NOT has_schema_privilege('authenticated', 'auth', 'USAGE')
     OR NOT has_function_privilege('authenticated', 'auth.uid()', 'EXECUTE') THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: authenticated lacks USAGE on public/auth or EXECUTE on auth.uid(), which the INVOKER body, its guard and its RLS predicates need';
  END IF;

  -- ── 1b. The target resolves, and its body is exactly the reviewed one ───────
  -- Checked on its own, before the full shape, so drift here says what it means.
  IF to_regprocedure(v_target) IS NULL THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: target function missing: %', v_target;
  END IF;

  SELECT md5(p.prosrc) INTO v_text FROM pg_proc p WHERE p.oid = to_regprocedure(v_target);
  IF v_text IS DISTINCT FROM v_body_md5 THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: STOP — the body has drifted (found %, reviewed %), so the audit''s SAFE classification no longer applies; re-audit before changing it',
      coalesce(v_text, '<missing>'), v_body_md5;
  END IF;

  -- ── 1c. The target: exactly the reviewed shape ──────────────────────────────
  -- One overload; owner postgres; SECURITY DEFINER; a plain plpgsql function;
  -- VOLATILE; PARALLEL UNSAFE; not strict, not leakproof, not SETOF; cost 100;
  -- `jsonb` result; the arguments `p_user_id uuid, p_papers jsonb` with no
  -- defaults; `search_path=public, pg_temp` and no other GUC; the literal
  -- EXECUTE ACL; exactly `authenticated` among PUBLIC / anon / authenticated /
  -- service_role; and the body digest — in one readable line, so a failure
  -- names the attribute that moved.
  SELECT format('overloads=%s owner=%s secdef=%s kind=%s lang=%s vol=%s parallel=%s strict=%s leakproof=%s setof=%s cost=%s result=%s args=[%s] argdefaults=%s config=%s acl=%s exec=%s body=%s',
                (SELECT count(*) FROM pg_proc p2 WHERE p2.pronamespace = p.pronamespace AND p2.proname = p.proname),
                pg_get_userbyid(p.proowner), p.prosecdef, p.prokind, l.lanname, p.provolatile, p.proparallel,
                p.proisstrict, p.proleakproof, p.proretset, p.procost,
                pg_get_function_result(p.oid), pg_get_function_arguments(p.oid), p.pronargdefaults,
                coalesce(p.proconfig::text, '<none>'), coalesce(p.proacl::text, '<default>'),
                (SELECT coalesce(string_agg(r, ',' ORDER BY r COLLATE "C"), '<nobody>')
                   FROM unnest(ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']) r
                  WHERE CASE WHEN r = 'PUBLIC'
                             THEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                           WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                             ELSE has_function_privilege(r, p.oid, 'EXECUTE') END),
                md5(p.prosrc))
    INTO v_text
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = to_regprocedure(v_target) AND p.pronamespace = 'public'::regnamespace;
  -- (format's %s renders a boolean with its output function: t / f)
  v_want := format('overloads=1 owner=postgres secdef=t kind=f lang=plpgsql vol=v parallel=u strict=f leakproof=f setof=f cost=100 result=jsonb args=[p_user_id uuid, p_papers jsonb] argdefaults=0 config={"search_path=public, pg_temp"} acl={postgres=X/postgres,authenticated=X/postgres} exec=authenticated body=%s',
                   v_body_md5);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'safe_bulk_insert_invoker: the target is not in the reviewed shape:\n  found:    %\n  expected: %',
      coalesce(v_text, '<missing>'), v_want;
  END IF;

  -- ── 1d. public.papers — the relation the body inserts into and reads ────────
  -- An ordinary postgres-owned table, RLS enabled AND forced. `authenticated`
  -- holds exactly its reviewed grant, direct and effective: INSERT and SELECT
  -- are the two this function needs, UPDATE is pinned so section 3 can prove
  -- nothing moved, and DELETE / TRUNCATE are absent (since 20260904120000).
  -- anon holds nothing, and nobody outside postgres / authenticated /
  -- service_role is a grantee (PUBLIC included). No column-level grant exists,
  -- so the table-level grants are the whole story. Checked by privilege rather
  -- than by the literal ACL text, because hosted Production and a replay reach
  -- this ACL from different starting states (see 20260910212202); section 3
  -- still proves the literal text did not move.
  IF NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = 'public.papers'::regclass AND c.relkind = 'r'
                    AND c.relowner = 'postgres'::regrole) THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: public.papers is not an ordinary table owned by postgres';
  END IF;

  IF (SELECT format('rls=%s force=%s', c.relrowsecurity, c.relforcerowsecurity)
        FROM pg_class c WHERE c.oid = 'public.papers'::regclass) IS DISTINCT FROM 'rls=t force=t' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: public.papers must have row level security ENABLED and FORCED (found %)',
      (SELECT format('rls=%s force=%s', c.relrowsecurity, c.relforcerowsecurity) FROM pg_class c WHERE c.oid = 'public.papers'::regclass);
  END IF;

  SELECT format('direct=%s effective=%s',
           (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
              FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             WHERE c.oid = 'public.papers'::regclass AND a.grantee = 'authenticated'::regrole),
           (SELECT coalesce(string_agg(pr, ',' ORDER BY pr), '')
              FROM unnest(v_all) pr WHERE has_table_privilege('authenticated', 'public.papers', pr)))
    INTO v_text;
  IF v_text IS DISTINCT FROM 'direct=INSERT,SELECT,UPDATE effective=INSERT,SELECT,UPDATE' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: authenticated''s privileges on public.papers are not the reviewed INSERT,SELECT,UPDATE (found %) — INSERT and SELECT are what the INVOKER body needs',
      v_text;
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(v_all) pr WHERE has_table_privilege('anon', 'public.papers', pr))
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                 WHERE c.oid = 'public.papers'::regclass
                   AND a.grantee NOT IN ('postgres'::regrole, 'authenticated'::regrole, 'service_role'::regrole))
     OR EXISTS (SELECT 1 FROM pg_attribute att WHERE att.attrelid = 'public.papers'::regclass AND att.attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: public.papers has an anon privilege, a grantee outside postgres/authenticated/service_role (PUBLIC included), or a column-level grant';
  END IF;

  -- ── 1e. The papers RLS policies are exactly the reviewed caller-owned four ──
  -- The INSERT and SELECT policies are now the primary boundary of this
  -- function, so a policy that was broadened, narrowed, renamed, re-targeted,
  -- made restrictive or joined by another is a reason to stop. A RESTRICTIVE
  -- policy is named on its own first, for a clear message; then the readable
  -- comparison; then the digest (identical in Production and on a replay).
  SELECT coalesce(string_agg(pol.polname || ' (' || pol.polcmd::text || ')', ', ' ORDER BY pol.polname), '') INTO v_text
  FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass AND NOT pol.polpermissive;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: unreviewed RESTRICTIVE polic(ies) on public.papers: %', v_text;
  END IF;

  SELECT coalesce(string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                             || (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                                   FROM unnest(pol.polroles) r) || '|'
                             || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>') || '|'
                             || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>'),
                             E'\n' ORDER BY pol.polname), '') INTO v_text
  FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass;
  SELECT string_agg(w.line, E'\n' ORDER BY w.line) INTO v_want
  FROM (VALUES
    ('Users can create their own papers|a|true|PUBLIC|<null>|(auth.uid() = user_id)'),
    ('Users can delete their own papers|d|true|PUBLIC|(auth.uid() = user_id)|<null>'),
    ('Users can update their own papers|w|true|PUBLIC|(auth.uid() = user_id)|<null>'),
    ('Users can view their own papers|r|true|PUBLIC|(auth.uid() = user_id)|<null>')
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'safe_bulk_insert_invoker: the public.papers RLS policies are not the reviewed caller-owned set.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  IF (SELECT md5(string_agg(format('%s|%s|%s|%s|%s|%s', pol.polname, pol.polcmd, pol.polpermissive,
                                   (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                                      FROM unnest(pol.polroles) r),
                                   coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>'),
                                   coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')),
                            E'\n' ORDER BY pol.polname))
        FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass)
     IS DISTINCT FROM '83aefa941c0457380be04b51c131ed5d' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the public.papers RLS policy digest is not the reviewed one';
  END IF;

  -- ── 1f. The insert_order sequence — drawn from as the caller ────────────────
  -- The `insert_order` default calls nextval() on it, which checks USAGE as the
  -- current user. `authenticated` holds exactly USAGE (no SELECT / UPDATE), anon
  -- nothing. Checked by privilege: service_role's entry differs legitimately
  -- between hosted Production (rwU) and a replay (wU); section 3 proves the
  -- literal ACL did not move.
  IF NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = to_regclass('public.papers_insert_order_seq') AND c.relkind = 'S'
                    AND c.relowner = 'postgres'::regrole) THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: public.papers_insert_order_seq is missing, not a sequence, or not owned by postgres';
  END IF;

  SELECT format('authenticated=%s anon=%s',
           (SELECT coalesce(string_agg(pr, ',' ORDER BY pr), '') FROM unnest(ARRAY['SELECT','UPDATE','USAGE']) pr
             WHERE has_sequence_privilege('authenticated', 'public.papers_insert_order_seq', pr)),
           (SELECT coalesce(string_agg(pr, ',' ORDER BY pr), '') FROM unnest(ARRAY['SELECT','UPDATE','USAGE']) pr
             WHERE has_sequence_privilege('anon', 'public.papers_insert_order_seq', pr)))
    INTO v_text;
  IF v_text IS DISTINCT FROM 'authenticated=USAGE anon=' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the sequence privileges on public.papers_insert_order_seq are not the reviewed ones (found %) — authenticated needs exactly USAGE for the insert_order default',
      v_text;
  END IF;

  -- ── 1g. Column defaults and generated columns the INSERT evaluates ──────────
  -- Every default on papers, by column name (column ORDER differs between
  -- hosted Production and a replay, the expressions do not), except the
  -- search_vector expression, which has exactly two reviewed shapes below.
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
    RAISE EXCEPTION E'safe_bulk_insert_invoker: the column defaults / generated columns of public.papers are not the reviewed set.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  IF (SELECT format('generated=%s type=%s notnull=%s dropped=%s', a.attgenerated, format_type(a.atttypid, a.atttypmod),
                    a.attnotnull, a.attisdropped)
        FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector')
     IS DISTINCT FROM 'generated=s type=tsvector notnull=f dropped=f' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: papers.search_vector is no longer the stored generated tsvector column';
  END IF;

  -- The expression digest, its recorded function dependencies, and every
  -- function (or operator function) its node tree actually calls. The last is
  -- only COMPARED as text here; the EXECUTE check in 1k works on OIDs.
  SELECT md5(pg_get_expr(d.adbin, d.adrelid)),
         (SELECT coalesce(string_agg(dd.refobjid::regprocedure::text || '|' || dd.deptype::text, ','
                                     ORDER BY dd.refobjid::regprocedure::text COLLATE "C"), '')
            FROM pg_depend dd
           WHERE dd.classid = 'pg_attrdef'::regclass AND dd.objid = d.oid AND dd.refclassid = 'pg_proc'::regclass),
         (SELECT coalesce(string_agg(f.oid::regprocedure::text, ',' ORDER BY f.oid::regprocedure::text COLLATE "C"), '')
            FROM (SELECT DISTINCT m[1]::oid AS fid
                    FROM regexp_matches(d.adbin::text, ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m) x
            JOIN pg_proc f ON f.oid = x.fid)
    INTO v_expr_md5, v_expr_deps, v_expr_fns
  FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector';
  IF NOT (   (v_expr_md5 = 'dd69f099a274a9cdc0f174ae0883ddb6'
              AND v_expr_deps = 'public.immutable_english_tsvector_jsonb(jsonb)|n,public.immutable_english_tsvector_text(text)|n'
              AND v_expr_fns = 'public.immutable_english_tsvector_jsonb(jsonb),public.immutable_english_tsvector_text(text),setweight(tsvector,"char"),tsvector_concat(tsvector,tsvector)')
          OR (v_expr_md5 = '8ddd960b4f4b11dd7afd35485d01fd25'
              AND v_expr_deps = ''
              AND v_expr_fns = 'setweight(tsvector,"char"),to_tsvector(regconfig,text),tsvector_concat(tsvector,tsvector)')) THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: STOP — papers.search_vector is an unreviewed shape (expression %, dependencies [%], calls [%]); reviewed: clean replay dd69f099… on the text+jsonb wrappers, or hosted 8ddd960b… on built-ins only (DB-SEARCH-VECTOR-EXPRESSION-PARITY-001)',
      coalesce(v_expr_md5, '<missing>'), coalesce(v_expr_deps, '<missing>'), coalesce(v_expr_fns, '<missing>');
  END IF;

  -- ── 1h. Constraints — the three CHECKs, the keys and the foreign key ─────────
  -- Every constraint on papers, by name, kind, validation and definition. The
  -- CHECKs are evaluated as the caller on every INSERT; the primary key, the
  -- (user_id, id) key and the two unique indexes in 1i are what a duplicate
  -- collides on; the foreign key is the one INSERT-time trigger in 1j.
  SELECT coalesce(string_agg(format('%s|%s|%s|%s', c.conname, c.contype, c.convalidated, md5(pg_get_constraintdef(c.oid))),
                             E'\n' ORDER BY c.conname COLLATE "C"), '') INTO v_text
  FROM pg_constraint c WHERE c.conrelid = 'public.papers'::regclass;
  SELECT string_agg(w.line, E'\n' ORDER BY w.line COLLATE "C") INTO v_want
  FROM (VALUES
    ('papers_author_provenance_shape_check|c|t|7d6ecbcf2630b9b552a577ef84e779a6'),
    ('papers_pkey|p|t|4c6419b3704337bbfe50f018842a9ad3'),                       -- PRIMARY KEY (id)
    ('papers_raw_publication_types_string_array_check|c|t|8d376404bf62f637eb5a09f1b56e09e6'),
    ('papers_statistical_methods_json_string_check|c|t|d6c44848ff8dd9a5df6eddae1a2a685d'),
    ('papers_user_id_fkey|f|t|85d8b2f5f0c0f6b4dcb854efb61a8cb1'),               -- FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
    ('papers_user_id_id_key|u|t|98e1fbc84debfcfd6796368ac10f703e')              -- UNIQUE (user_id, id)
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'safe_bulk_insert_invoker: the constraints on public.papers are not the reviewed set.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  -- ── 1i. Indexes — the uniqueness the duplicate handler resolves against ────
  -- All seven, by name, uniqueness, validity, readiness, liveness and
  -- definition. The duplicate handler looks up exactly what
  -- idx_papers_user_pmid_unique (user_id, pmid) and idx_papers_user_doi_unique
  -- (user_id, lower(doi)) enforce, so those two are also compared as text.
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
    RAISE EXCEPTION E'safe_bulk_insert_invoker: the indexes on public.papers are not the reviewed set.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  SELECT string_agg(pg_get_indexdef(i.indexrelid), E'\n' ORDER BY ci.relname COLLATE "C") INTO v_text
  FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid
  WHERE i.indrelid = 'public.papers'::regclass
    AND ci.relname IN ('idx_papers_user_doi_unique', 'idx_papers_user_pmid_unique');
  IF v_text IS DISTINCT FROM
       'CREATE UNIQUE INDEX idx_papers_user_doi_unique ON public.papers USING btree (user_id, lower(doi)) WHERE (doi IS NOT NULL)'
       || E'\n' || 'CREATE UNIQUE INDEX idx_papers_user_pmid_unique ON public.papers USING btree (user_id, pmid) WHERE (pmid IS NOT NULL)' THEN
    RAISE EXCEPTION E'safe_bulk_insert_invoker: the two identifier indexes the duplicate handler relies on are not the reviewed definitions:\n%', v_text;
  END IF;

  -- ── 1j. Triggers and the foreign key — exactly the reviewed twelve ──────────
  -- The two named triggers, by definition digest (timing, events, column list
  -- and WHEN clause) and bound column list; both are UPDATE-only, so an INSERT
  -- fires neither. The ten internal foreign-key triggers, whose names embed
  -- environment-specific OIDs, by kind, function and the relation at the other
  -- end; exactly one of them fires on INSERT — the papers.user_id → auth.users
  -- check, which PostgreSQL runs as the referenced table's owner.
  SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', t.tgname, t.tgenabled, t.tgtype, t.tgfoid::regprocedure,
                                    (SELECT coalesce(string_agg(a.attname, ',' ORDER BY a.attnum), '')
                                       FROM unnest(t.tgattr::int2[]) k
                                       JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k),
                                    md5(pg_get_triggerdef(t.oid))), E'\n' ORDER BY t.tgname), '') INTO v_text
  FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass AND NOT t.tgisinternal;
  v_want := 'papers_clear_author_identity_links_on_authors_change|O|17|public.clear_author_identity_links_on_authors_change()|authors|df324456e1798618b83342b7376698d9'
            || E'\n' || 'trg_papers_updated_at|O|19|public.set_updated_at()||64efa17c0852ae9a5d30cc42d2edbba2';
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'safe_bulk_insert_invoker: the named triggers on public.papers are not the reviewed two.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  -- tgtype bit 4 is INSERT. Said in words, beside the digests above.
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = 'public.papers'::regclass AND NOT t.tgisinternal AND (t.tgtype & 4) <> 0) THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: a user-defined trigger on public.papers fires on INSERT, so it would now run as the caller — re-review';
  END IF;

  SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', t.tgtype, t.tgfoid::regprocedure, t.tgconstrrelid::regclass,
                                    t.tgenabled, t.tgdeferrable, t.tginitdeferred), E'\n'
                             ORDER BY t.tgconstrrelid::regclass::text COLLATE "C", t.tgtype, t.tgfoid::regprocedure::text COLLATE "C"), '')
    INTO v_text
  FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass AND t.tgisinternal;
  SELECT string_agg(w.line, E'\n' ORDER BY w.ord) INTO v_want
  FROM (VALUES
    (1,  '5|"RI_FKey_check_ins"()|auth.users|O|f|f'),
    (2,  '17|"RI_FKey_check_upd"()|auth.users|O|f|f'),
    (3,  '9|"RI_FKey_cascade_del"()|public.author_identity_links|O|f|f'),
    (4,  '17|"RI_FKey_noaction_upd"()|public.author_identity_links|O|f|f'),
    (5,  '9|"RI_FKey_cascade_del"()|public.paper_attachments|O|f|f'),
    (6,  '17|"RI_FKey_noaction_upd"()|public.paper_attachments|O|f|f'),
    (7,  '9|"RI_FKey_cascade_del"()|public.paper_projects|O|f|f'),
    (8,  '17|"RI_FKey_noaction_upd"()|public.paper_projects|O|f|f'),
    (9,  '9|"RI_FKey_cascade_del"()|public.paper_tags|O|f|f'),
    (10, '17|"RI_FKey_noaction_upd"()|public.paper_tags|O|f|f')
  ) AS w(ord, line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'safe_bulk_insert_invoker: the internal foreign-key triggers on public.papers are not the reviewed ten.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  -- The INSERT-time check belongs to exactly the reviewed foreign key.
  IF (SELECT string_agg(format('%s|%s', con.conname, t.tgtype), ',')
        FROM pg_trigger t JOIN pg_constraint con ON con.oid = t.tgconstraint
       WHERE t.tgrelid = 'public.papers'::regclass AND t.tgisinternal AND (t.tgtype & 4) <> 0)
     IS DISTINCT FROM 'papers_user_id_fkey|5' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the only INSERT-time trigger on public.papers is not papers_user_id_fkey''s check';
  END IF;

  -- ── 1k. Everything the INSERT and the body evaluate as the caller ───────────
  -- (i) Every function or operator function in a node tree PostgreSQL evaluates
  -- for an INSERT of papers as the current user: every column default and
  -- generated expression, every CHECK constraint, every index expression and
  -- predicate, and every RLS policy expression. Read from the trees as OIDs, so
  -- it covers either search_vector shape, whatever it calls.
  SELECT coalesce(string_agg(f.oid::regprocedure::text, ', ' ORDER BY f.oid::regprocedure::text COLLATE "C"), '') INTO v_text
  FROM (SELECT DISTINCT m[1]::oid AS fid
          FROM pg_attrdef d, regexp_matches(d.adbin::text, ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m
         WHERE d.adrelid = 'public.papers'::regclass
        UNION
        SELECT DISTINCT m[1]::oid
          FROM pg_constraint c, regexp_matches(c.conbin::text, ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m
         WHERE c.conrelid = 'public.papers'::regclass AND c.contype = 'c'
        UNION
        SELECT DISTINCT m[1]::oid
          FROM pg_index i, regexp_matches(coalesce(i.indexprs::text, '') || coalesce(i.indpred::text, ''),
                                          ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m
         WHERE i.indrelid = 'public.papers'::regclass
        UNION
        SELECT DISTINCT m[1]::oid
          FROM pg_policy pol, regexp_matches(coalesce(pol.polqual::text, '') || coalesce(pol.polwithcheck::text, ''),
                                             ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m
         WHERE pol.polrelid = 'public.papers'::regclass) x
  JOIN pg_proc f ON f.oid = x.fid
  WHERE NOT has_function_privilege('authenticated', f.oid, 'EXECUTE');
  IF v_text <> '' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: authenticated cannot EXECUTE function(s) an INSERT of papers evaluates (a default, generated column, CHECK constraint, index expression or RLS policy), so every INVOKER import would fail: %', v_text;
  END IF;

  -- (ii) Every function and operator the PL/pgSQL body itself calls, as
  -- reviewed against body 11992524…. A body is text, not a node tree, so these
  -- are listed — ONE signature per row, each required to resolve: an entry that
  -- no longer resolves would otherwise make the privilege check vacuous.
  WITH dep(kind, sig) AS (VALUES
    ('function', 'auth.uid()'),
    ('function', 'pg_catalog.array_agg(anynonarray)'),
    ('function', 'pg_catalog.btrim(text)'),
    ('function', 'pg_catalog.cardinality(anyarray)'),
    ('function', 'pg_catalog.jsonb_agg(anyelement)'),
    ('function', 'pg_catalog.jsonb_array_elements(jsonb)'),
    ('function', 'pg_catalog.jsonb_array_elements_text(jsonb)'),
    ('function', 'pg_catalog.jsonb_array_length(jsonb)'),
    ('function', 'pg_catalog.jsonb_build_object("any")'),
    ('function', 'pg_catalog.jsonb_path_exists(jsonb,jsonpath,jsonb,boolean)'),
    ('function', 'pg_catalog.jsonb_typeof(jsonb)'),
    ('function', 'pg_catalog.lower(text)'),
    ('function', 'pg_catalog.string_agg(text,text)'),
    ('function', 'pg_catalog.to_jsonb(anyelement)'),
    ('operator', 'pg_catalog.#>>(jsonb,text[])'),
    ('operator', 'pg_catalog.+(integer,integer)'),
    ('operator', 'pg_catalog.->(jsonb,text)'),
    ('operator', 'pg_catalog.->>(jsonb,text)'),
    ('operator', 'pg_catalog.<>(text,text)'),
    ('operator', 'pg_catalog.<>(uuid,uuid)'),
    ('operator', 'pg_catalog.=(integer,integer)'),
    ('operator', 'pg_catalog.=(text,text)'),
    ('operator', 'pg_catalog.=(uuid,uuid)'),
    ('operator', 'pg_catalog.||(jsonb,jsonb)')
  ),
  resolved AS (
    SELECT dep.kind, dep.sig,
           CASE dep.kind WHEN 'function' THEN to_regprocedure(dep.sig)::oid
                         ELSE (SELECT o.oprcode::oid FROM pg_operator o WHERE o.oid = to_regoperator(dep.sig)) END AS fid
      FROM dep)
  SELECT count(*),
         coalesce(string_agg(r.kind || ' ' || r.sig, ', ' ORDER BY r.sig) FILTER (WHERE r.fid IS NULL OR r.fid = 0), ''),
         coalesce(string_agg(r.kind || ' ' || r.sig, ', ' ORDER BY r.sig)
                    FILTER (WHERE r.fid IS NOT NULL AND r.fid <> 0 AND NOT has_function_privilege('authenticated', r.fid, 'EXECUTE')), '')
    INTO v_count, v_text, v_want
  FROM resolved r;
  IF v_count <> 24 THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the reviewed body-dependency list has % entries, not 24', v_count;
  END IF;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: reviewed body dependenc(ies) no longer resolve, so the caller-EXECUTE check cannot vouch for them: %', v_text;
  END IF;
  IF v_want <> '' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: authenticated cannot EXECUTE what the body calls, so every INVOKER import would fail: %', v_want;
  END IF;

  -- ── 1l. The SECURITY DEFINER inventory this change is carved out of ─────────
  -- 33 in public, 25 of them authenticated-executable (the target among them,
  -- 1c), distributed 30 at C50's `public, pg_temp` (the target among them) and
  -- 3 audited exceptions at `public`. A different count means the surface
  -- drifted after the audit and must be re-reviewed before anything leaves it.
  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef;
  IF v_count <> 33 THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: % SECURITY DEFINER functions in public; the reviewed inventory is 33', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND prosecdef AND has_function_privilege('authenticated', oid, 'EXECUTE');
  IF v_count <> 25 THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: % authenticated-executable SECURITY DEFINER functions in public; the reviewed inventory is 25', v_count;
  END IF;
  SELECT string_agg(cfg || '=' || n, ' ' ORDER BY cfg) INTO v_text
  FROM (SELECT coalesce(proconfig::text, '<none>') AS cfg, count(*) AS n FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace AND prosecdef GROUP BY 1) d;
  IF v_text IS DISTINCT FROM '{"search_path=public, pg_temp"}=30 {search_path=public}=3' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the SECURITY DEFINER search_path distribution is % ; the reviewed one is 30 at public, pg_temp and 3 at public', v_text;
  END IF;

  -- ── 1m. Snapshots of everything this migration must NOT change ─────────────
  -- Transaction-local; read back in section 3.

  -- The target as its WHOLE pg_proc row except prosecdef — oid included, so a
  -- drop-and-recreate could not pass as an ALTER — and its comment.
  PERFORM set_config('paperlume.safe_bulk_insert_invoker.pre_target',
    (SELECT p.oid::text || '=' || md5((to_jsonb(p.*) - 'prosecdef')::text) || '=' || coalesce(md5(obj_description(p.oid, 'pg_proc')), '<no comment>')
       FROM pg_proc p WHERE p.oid = to_regprocedure(v_target)), true);

  -- Every OTHER function in public, whole rows, prosecdef included — the 24
  -- retained client definer RPCs, the server-only, trigger and internal
  -- functions, and every existing INVOKER routine.
  PERFORM set_config('paperlume.safe_bulk_insert_invoker.pre_others',
    (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> to_regprocedure(v_target)), true);

  -- The authenticated-executable SECURITY DEFINER functions that STAY (24),
  -- and the authenticated-executable SECURITY INVOKER routines that already
  -- exist. Newline-separated: a signature with more than one argument contains
  -- commas, and section 3 compares these lists, never splits them on commas.
  PERFORM set_config('paperlume.safe_bulk_insert_invoker.pre_retained_definer',
    (SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND p.oid <> to_regprocedure(v_target)), true);

  PERFORM set_config('paperlume.safe_bulk_insert_invoker.pre_invoker',
    (SELECT coalesce(string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text), '')
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND NOT p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')), true);

  -- The boundary: papers' own row (owner, RLS flags, the WHOLE ACL as stored,
  -- storage); every column as its whole pg_attribute row (column ACLs
  -- included); every default and generated expression, constraint, index,
  -- policy and trigger as its whole catalog row; and the insert_order
  -- sequence's owner, whole ACL and parameters.
  PERFORM set_config('paperlume.safe_bulk_insert_invoker.pre_boundary',
    (SELECT concat_ws(E'\n',
       (SELECT 'papers|' || c.oid::text || '|' || pg_get_userbyid(c.relowner) || '|' || c.relrowsecurity::text || '|'
               || c.relforcerowsecurity::text || '|' || coalesce(c.relacl::text, 'NULL') || '|' || c.relfilenode::text
          FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
       (SELECT 'att|' || md5(string_agg(md5(to_jsonb(a.*)::text), ',' ORDER BY a.attnum))
          FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass),
       (SELECT 'def|' || coalesce(string_agg(ad.oid::text || '=' || md5(to_jsonb(ad.*)::text), ',' ORDER BY ad.oid), '')
          FROM pg_attrdef ad WHERE ad.adrelid = 'public.papers'::regclass),
       (SELECT 'con|' || coalesce(string_agg(md5(to_jsonb(con.*)::text), ',' ORDER BY con.oid), '')
          FROM pg_constraint con WHERE con.conrelid = 'public.papers'::regclass),
       (SELECT 'idx|' || coalesce(string_agg(md5(to_jsonb(i.*)::text) || '|' || c.relfilenode::text || '|' || md5(pg_get_indexdef(i.indexrelid)),
                                             ',' ORDER BY i.indexrelid), '')
          FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = 'public.papers'::regclass),
       (SELECT 'pol|' || coalesce(string_agg(md5(to_jsonb(pol.*)::text), ',' ORDER BY pol.oid), '')
          FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass),
       (SELECT 'trg|' || coalesce(string_agg(md5(to_jsonb(t.*)::text), ',' ORDER BY t.oid), '')
          FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass),
       (SELECT 'seq|' || c.oid::text || '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(c.relacl::text, 'NULL') || '|'
               || md5(to_jsonb(s.*)::text)
          FROM pg_class c JOIN pg_sequence s ON s.seqrelid = c.oid
         WHERE c.oid = 'public.papers_insert_order_seq'::regclass))), true);
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The change
-- ═════════════════════════════════════════════════════════════════════════════
--
-- One statement, one attribute, exact signature. No CREATE OR REPLACE: the
-- reviewed body is kept byte-for-byte, and section 3 proves it.

ALTER FUNCTION public.safe_bulk_insert_papers(uuid,jsonb)
  SECURITY INVOKER;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed verification — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

DO $verify$
DECLARE
  v_text   TEXT;
  v_base   TEXT;
  v_count  INTEGER;
  v_target CONSTANT TEXT := 'public.safe_bulk_insert_papers(uuid,jsonb)';
BEGIN
  -- ── 3a. SECURITY INVOKER, with the EXECUTE posture unchanged ────────────────
  IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(v_target)) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: % is not SECURITY INVOKER after the change', v_target;
  END IF;

  IF (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure(v_target))
       IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres}'
     OR NOT has_function_privilege('postgres', to_regprocedure(v_target), 'EXECUTE')
     OR NOT has_function_privilege('authenticated', to_regprocedure(v_target), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure(v_target), 'EXECUTE')
     OR has_function_privilege('service_role', to_regprocedure(v_target), 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = to_regprocedure(v_target) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the EXECUTE ACL or effective posture of % changed', v_target;
  END IF;

  -- Restated literally, so a failure names the attribute rather than a digest.
  -- The C50 path stays exactly as it was: `public` first, `pg_temp` last.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure(v_target)
                    AND p.proowner = 'postgres'::regrole
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                    AND p.provolatile = 'v' AND p.proparallel = 'u' AND NOT p.proisstrict) THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the owner, search_path, language, volatility, parallel mode or strictness of % changed', v_target;
  END IF;

  -- ── 3b. OID, body, signature, result, arguments, volatility, parallel,
  --        strictness, cost, config, owner, ACL and comment: the whole row
  --        except prosecdef is unchanged ──────────────────────────────────────
  v_base := current_setting('paperlume.safe_bulk_insert_invoker.pre_target', true);
  SELECT p.oid::text || '=' || md5((to_jsonb(p.*) - 'prosecdef')::text) || '=' || coalesce(md5(obj_description(p.oid, 'pg_proc')), '<no comment>')
    INTO v_text
  FROM pg_proc p WHERE p.oid = to_regprocedure(v_target);
  IF coalesce(v_base, '') = '' OR v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION E'safe_bulk_insert_invoker: an attribute other than prosecdef changed on the target.\nbefore: %\nafter:  %', v_base, v_text;
  END IF;

  -- Belt and braces on the fact review cares most about.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(v_target))
     IS DISTINCT FROM '119925245a5c3c8529ada3d2e10fba96' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the function body changed';
  END IF;

  -- ── 3c. No other function in public moved — its security mode included ─────
  v_base := current_setting('paperlume.safe_bulk_insert_invoker.pre_others', true);
  IF coalesce(v_base, '') = ''
     OR (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> to_regprocedure(v_target)) IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: a function other than the target changed';
  END IF;

  -- ── 3d. The inventory moved by exactly this one: 33 → 32, 25 → 24,
  --        `public, pg_temp` definers 30 → 29, exceptions still 3 ─────────────
  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef;
  IF v_count <> 32 THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: % SECURITY DEFINER functions in public after the change; expected 32', v_count;
  END IF;

  SELECT count(*), string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text) INTO v_count, v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_count <> 24 OR v_text IS DISTINCT FROM current_setting('paperlume.safe_bulk_insert_invoker.pre_retained_definer', true) THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the authenticated-executable SECURITY DEFINER set is not exactly the 24 retained functions (count %)', v_count;
  END IF;

  SELECT string_agg(cfg || '=' || n, ' ' ORDER BY cfg) INTO v_text
  FROM (SELECT coalesce(proconfig::text, '<none>') AS cfg, count(*) AS n FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace AND prosecdef GROUP BY 1) d;
  IF v_text IS DISTINCT FROM '{"search_path=public, pg_temp"}=29 {search_path=public}=3' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the SECURITY DEFINER search_path distribution after the change is % ; expected 29 at public, pg_temp and 3 at public', v_text;
  END IF;

  -- The INVOKER set grew by exactly the target. Both sides are built as
  -- newline-joined text from whole signatures; nothing is split on commas.
  SELECT string_agg(s, E'\n' ORDER BY s) INTO v_base
  FROM (SELECT unnest(string_to_array(current_setting('paperlume.safe_bulk_insert_invoker.pre_invoker', true), E'\n')) AS s
        UNION
        SELECT to_regprocedure(v_target)::regprocedure::text) u
  WHERE s <> '';
  SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text) INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND NOT p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION E'safe_bulk_insert_invoker: the authenticated-executable SECURITY INVOKER set did not grow by exactly the target.\nexpected:\n%\nfound:\n%', v_base, v_text;
  END IF;

  -- ── 3e. The boundary it now relies on is unchanged ──────────────────────────
  v_base := current_setting('paperlume.safe_bulk_insert_invoker.pre_boundary', true);
  IF coalesce(v_base, '') = ''
     OR (SELECT concat_ws(E'\n',
          (SELECT 'papers|' || c.oid::text || '|' || pg_get_userbyid(c.relowner) || '|' || c.relrowsecurity::text || '|'
                  || c.relforcerowsecurity::text || '|' || coalesce(c.relacl::text, 'NULL') || '|' || c.relfilenode::text
             FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
          (SELECT 'att|' || md5(string_agg(md5(to_jsonb(a.*)::text), ',' ORDER BY a.attnum))
             FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass),
          (SELECT 'def|' || coalesce(string_agg(ad.oid::text || '=' || md5(to_jsonb(ad.*)::text), ',' ORDER BY ad.oid), '')
             FROM pg_attrdef ad WHERE ad.adrelid = 'public.papers'::regclass),
          (SELECT 'con|' || coalesce(string_agg(md5(to_jsonb(con.*)::text), ',' ORDER BY con.oid), '')
             FROM pg_constraint con WHERE con.conrelid = 'public.papers'::regclass),
          (SELECT 'idx|' || coalesce(string_agg(md5(to_jsonb(i.*)::text) || '|' || c.relfilenode::text || '|' || md5(pg_get_indexdef(i.indexrelid)),
                                                ',' ORDER BY i.indexrelid), '')
             FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = 'public.papers'::regclass),
          (SELECT 'pol|' || coalesce(string_agg(md5(to_jsonb(pol.*)::text), ',' ORDER BY pol.oid), '')
             FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass),
          (SELECT 'trg|' || coalesce(string_agg(md5(to_jsonb(t.*)::text), ',' ORDER BY t.oid), '')
             FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass),
          (SELECT 'seq|' || c.oid::text || '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(c.relacl::text, 'NULL') || '|'
                  || md5(to_jsonb(s.*)::text)
             FROM pg_class c JOIN pg_sequence s ON s.seqrelid = c.oid
            WHERE c.oid = 'public.papers_insert_order_seq'::regclass)))
        IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: papers'' owner, RLS flags, ACL, storage, a column, default, generated expression, constraint, index, policy or trigger, or the insert_order sequence, changed';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.papers', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.papers', 'SELECT')
     OR NOT has_sequence_privilege('authenticated', 'public.papers_insert_order_seq', 'USAGE') THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: authenticated lost INSERT or SELECT on papers, or USAGE on papers_insert_order_seq, which the INVOKER function now requires';
  END IF;

  IF (SELECT md5(string_agg(format('%s|%s|%s|%s|%s|%s', pol.polname, pol.polcmd, pol.polpermissive,
                                   (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                                      FROM unnest(pol.polroles) r),
                                   coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>'),
                                   coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')),
                            E'\n' ORDER BY pol.polname))
        FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass)
     IS DISTINCT FROM '83aefa941c0457380be04b51c131ed5d' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: an RLS policy on public.papers changed';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: authenticated became SUPERUSER or BYPASSRLS';
  END IF;

  -- ── 3f. Catalog-only: this transaction wrote no row ─────────────────────────
  v_base := current_setting('paperlume.safe_bulk_insert_invoker.xact_writes_at_start', true);
  IF coalesce(v_base, '') = '' THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  SELECT string_agg(
           n.nspname || '.' || c.relname || '=' || (pg_stat_get_xact_tuples_inserted(c.oid)
                                                    + pg_stat_get_xact_tuples_updated(c.oid)
                                                    + pg_stat_get_xact_tuples_deleted(c.oid)),
           ' ' ORDER BY n.nspname, c.relname) INTO v_text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p');
  IF v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'safe_bulk_insert_invoker: this transaction wrote application rows (row writes at start: %; now: %)', v_base, v_text;
  END IF;
END
$verify$;

COMMIT;
