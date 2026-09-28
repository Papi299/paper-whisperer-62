-- DB-DEFAULT-FUNCTION-EXECUTE-HARDENING-001A — owner-only EXECUTE on the two
-- updated_at trigger functions, and a default-deny EXECUTE posture for every
-- function `postgres` creates from now on (C56).
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly four privilege statements (section 2), and nothing else:
--
--   REVOKE ALL ON FUNCTION public.set_updated_at()           FROM PUBLIC, anon, authenticated, service_role;
--   REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
--
-- Afterwards both trigger functions are `{postgres=X/postgres}`, no function in
-- `public` is executable through PUBLIC, and a function `postgres` creates
-- later reaches no client role until its migration GRANTs it. No function
-- body, owner, security mode, search_path or OID changes; no trigger, table,
-- policy, row, Edge Function, Auth or Storage setting is touched.
--
-- WHY — least privilege and default deny, not an exposure fix
-- ─────────────────────────────────────────────────────────────────────────────
-- Existing objects. The two functions only ever run as BEFORE UPDATE row
-- triggers (12 of them). PostgreSQL checks EXECUTE on a trigger function once,
-- when CREATE TRIGGER runs, and never again when the trigger fires; the
-- caller's EXECUTE is irrelevant to firing. That was proven on this repository's
-- exact PostgreSQL 17.6 image, and Production already relies on it: five other
-- `public` trigger functions (handle_new_user, clear_author_identity_links_on_
-- authors_change, …) are owner-only and fire for GoTrue and browser writes.
-- What the grant DID confer was nothing useful: a direct call raises 0A000
-- ("trigger functions can only be called as triggers"), and PostgREST drops
-- trigger functions from its schema cache (404 PGRST202 even while anon holds
-- EXECUTE — observed locally and in Production). Its only real capability was
-- letting a client attach set_updated_at() to a TEMP table of its own. So the
-- grant is surplus, and removing it is least privilege, not a breach response.
--
-- Where the grant came from. No migration ever granted it. PUBLIC comes from
-- PostgreSQL's built-in default for functions; anon, authenticated and
-- service_role come — on hosted Production only — from Supabase's per-schema
-- default entry for `postgres` in `public`, which a clean replay does not have.
-- Hosted Production therefore stores the explicit five-entry ACL and a clean
-- replay stores NULL. The effective posture is the same; section 1 accepts
-- both, and both converge on `{postgres=X/postgres}`.
--
-- Future functions. Today a function whose migration forgets its ACL is
-- executable by anon and authenticated everywhere, and a migration that revokes
-- only PUBLIC and anon leaves `authenticated` able to execute it in Production
-- but not on a clean replay — invisible to every test. Section 2's two
-- ALTER DEFAULT PRIVILEGES statements make both fail closed.
--
-- WHY THE PUBLIC DEFAULT CHANGE IS GLOBAL
-- ─────────────────────────────────────────────────────────────────────────────
-- Per-schema default privileges are ADDED to the global default. PostgreSQL 17
-- documents that a per-schema REVOKE "is only useful to reverse the effects of
-- a previous per-schema GRANT", so `… IN SCHEMA public REVOKE EXECUTE ON
-- FUNCTIONS FROM PUBLIC` changes nothing — including when it is run as part of
-- Supabase's documented opt-in (verified). The only default-privilege mechanism
-- that removes PUBLIC is the global form, PostgreSQL's own documented example.
-- The per-schema statement then removes Supabase's explicit anon/authenticated
-- entry.
--
-- Its reach is FUTURE functions created by `postgres`, in any schema:
--   * PaperLume migrations (all in `public`) — the intent;
--   * a function `postgres` creates by hand, e.g. in the SQL editor — it is
--     owner-only until granted;
--   * an extension `postgres` installs without superuser, whose member objects
--     it therefore owns. `pgmq` (Supabase Queues) is the proven example: under
--     this default 39 of its 40 functions lose PUBLIC EXECUTE. Enabling it, or
--     any similar feature, needs its execution surface reviewed and granted.
-- It does NOT reach existing objects (default privileges never do), objects
-- owned by another role, or supautils-privileged and trusted extensions, whose
-- member objects are created as `supabase_admin`: citext, pg_trgm, vector,
-- pg_cron, moddatetime, pg_jsonschema and lo were verified unchanged.
-- `postgres` cannot alter `supabase_admin`'s defaults, and this file does not
-- try.
--
-- SERVICE_ROLE
-- ─────────────────────────────────────────────────────────────────────────────
-- It is removed from the two EXISTING functions: no path needs it (its DML
-- fires the triggers without it), and 40 of the other 41 `public` functions
-- already exclude it. Its FUTURE-function default in `public` — present on
-- hosted Production, absent on a clean replay — is platform-maintained and is
-- deliberately preserved exactly as found (C38 precedent); narrowing it
-- belongs to the separate service-role least-privilege review. So the
-- `postgres`/`public` function entry legitimately ends as
-- `{postgres=X/postgres,service_role=X/postgres}` on hosted Production and
-- `{postgres=X/postgres}` on a clean replay.
--
-- SAFETY — fail closed
-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1 refuses, before anything changes, unless both functions are
-- exactly the reviewed ones (contract, body digest, search_path, one of the two
-- reviewed ACL forms), exactly the reviewed twelve triggers depend on them and
-- nothing else does, they are the only PUBLIC-executable functions in `public`,
-- `postgres` holds no global default entry, and its `public` function entry is
-- one of the two reviewed shapes judged whole. Supabase's documented opt-in
-- produces the clean-replay shape, so it composes. Anything else stops the
-- file. Section 3 proves the intended end state on the catalog AND on real
-- objects, proves both hardened trigger functions still fire for a caller
-- holding no EXECUTE, and proves nothing else moved.
--
-- PRODUCTION PROJECTION
-- ─────────────────────────────────────────────────────────────────────────────
-- Verified read-only on 2026-09-28 (PostgreSQL 17.6; ledger 95, latest
-- 20260927214838): both functions carry the explicit hosted ACL; 12 enabled
-- triggers; no global `postgres` default entry; the `postgres`/`public`
-- function entry is the hosted four-role shape. A separately authorized
-- rollout is expected to add one ledger row, change the two functions' ACLs,
-- add one global `pg_default_acl` row and narrow the `public` entry — catalog
-- writes only. Its in-transaction probes create and drop one scratch schema
-- and never touch `public` data: no application row is written and no lock is
-- taken on any `public` relation. PostgREST exposes neither function, so the
-- Data API surface does not change.
--
-- ROLLBACK — forward only
-- ─────────────────────────────────────────────────────────────────────────────
-- Do not edit this file after it has been applied. A reversal is a new forward
-- migration: re-GRANT the intended EXECUTE explicitly, and
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO
-- PUBLIC` (which deletes the global entry again), plus the per-schema GRANT to
-- anon and authenticated. See docs/deployment.md §6.17.
--
-- Durable decision: C56.

BEGIN;

-- Transaction-local, so COMMIT restores the runner's own settings: one fixed
-- rendering path for every catalog value this file renders and compares, and
-- a bounded wait for every lock. Section 0 proves both took effect, which also
-- proves this file is running inside one transaction.
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context, and this transaction's own write counters
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only the owner (postgres) can revoke on the two functions, and
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` must run as postgres. The role
-- setting in force now is recorded so section 3 can return to it after the
-- trigger probe — `RESET ROLE` would return to the session user, which under
-- the linked CLI is a login role, not postgres.

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'default_function_execute: must run as postgres (current_user is %)', current_user;
  END IF;

  IF current_setting('search_path') IS DISTINCT FROM 'pg_catalog, pg_temp'
     OR current_setting('lock_timeout') IS DISTINCT FROM '5s' THEN
    RAISE EXCEPTION 'default_function_execute: the transaction-local settings are not in effect (search_path %, lock_timeout %) — this file must run as one transaction',
      current_setting('search_path'), current_setting('lock_timeout');
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'default_function_execute: track_counts is off, so the no-write self-check could not observe anything';
  END IF;

  PERFORM set_config('paperlume.default_function_execute.role_at_start', current_setting('role'), true);
  PERFORM set_config(
    'paperlume.default_function_execute.xact_writes_at_start',
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
-- 1. Preconditions — the exact state this hardening was reviewed against
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Re-derived read-only from Production and from a clean local replay on
-- 2026-09-28. OIDs differ between environments, so they are resolved here —
-- one complete signature per VALUES row — and recorded for section 3. Nothing
-- here repairs unexpected state: any mismatch rolls the whole file back before
-- anything changes.

DO $pre$
DECLARE
  v_targets   OID[];
  v_text      TEXT;
  v_want      TEXT;
  v_count     INTEGER;
  v_entry     TEXT;
  -- The two reviewed representations of the functions' starting ACL: NULL on
  -- a clean replay (PostgreSQL's default of owner plus PUBLIC), and the
  -- explicit hosted form, which adds Supabase's schema-default grantees.
  c_acl_hosted  CONSTANT TEXT := '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
  -- The two reviewed shapes of `postgres`'s `public` FUNCTION default entry,
  -- each judged whole: hosted Production, and a clean replay — which is also
  -- what Supabase's documented opt-in leaves behind.
  c_def_hosted  CONSTANT TEXT := '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
  c_def_replay  CONSTANT TEXT := '{postgres=X/postgres}';
  -- Everything section 3 must find unchanged, one line per category. The
  -- query text is stored and re-executed verbatim there, so both sides measure
  -- exactly the same thing. $1 is the target OID array.
  c_snapshot  CONSTANT TEXT := $snap$
    SELECT string_agg(x.cat || '|' || coalesce(x.digest, '-'), E'\n' ORDER BY x.cat COLLATE "C")
    FROM (
      -- The two targets, every column except the ACL this file changes.
      SELECT 'fn_targets_minus_acl' AS cat,
             string_agg(p.oid::text || '=' || md5((to_jsonb(p.*) - 'proacl')::text) || '='
                        || coalesce(md5(obj_description(p.oid, 'pg_proc')), '-'), ',' ORDER BY p.oid) AS digest
        FROM pg_proc p WHERE p.oid = ANY ($1)
      UNION ALL
      -- Every other public function: its whole catalog row, ACL included.
      SELECT 'fn_public_others',
             count(*)::text || ':' || md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text) || '='
                            || coalesce(md5(obj_description(p.oid, 'pg_proc')), '-'), E'\n' ORDER BY p.oid))
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> ALL ($1)
      UNION ALL
      -- Every other function in the database: identity and ACL. No other
      -- function anywhere gains or loses a grant.
      SELECT 'fn_all_others_acl',
             count(*)::text || ':' || md5(string_agg(p.oid::text || '=' || coalesce(p.proacl::text, 'NULL'), ',' ORDER BY p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.oid <> ALL ($1) AND n.nspname !~ '^pg_(toast_)?temp_'
      UNION ALL
      -- Relation identities, owners, ACLs, RLS flags, options, comments.
      SELECT 'rel',
             md5(string_agg(concat_ws('|', c.oid, c.relname, c.relkind, pg_get_userbyid(c.relowner), c.relfilenode,
                                      c.relrowsecurity, c.relforcerowsecurity, c.relhastriggers,
                                      coalesce(c.relacl::text, 'NULL'), coalesce(c.reloptions::text, 'NULL'),
                                      coalesce(md5(obj_description(c.oid, 'pg_class')), '-')),
                            E'\n' ORDER BY c.oid))
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'att', md5(string_agg(md5(to_jsonb(a.*)::text), ',' ORDER BY a.attrelid, a.attnum))
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'policy', md5(string_agg(md5(to_jsonb(pol.*)::text), ',' ORDER BY pol.oid))
        FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      -- Every trigger in `public`, as its whole row (enabled state included).
      SELECT 'trigger', md5(string_agg(md5(to_jsonb(t.*)::text), ',' ORDER BY t.oid))
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      -- Every default-privilege entry except the two this file changes:
      -- postgres's global function entry, and postgres's `public` function entry.
      SELECT 'default_acl_others', md5(string_agg(md5(to_jsonb(da.*)::text), ',' ORDER BY da.oid))
        FROM pg_default_acl da
       WHERE NOT (da.defaclrole = 'postgres'::regrole AND da.defaclobjtype = 'f'
                  AND da.defaclnamespace IN (0, 'public'::regnamespace))
      UNION ALL
      -- service_role's grants inside postgres's `public` function entry:
      -- preserved exactly, present or absent.
      SELECT 'default_public_f_service_role',
             coalesce((SELECT string_agg(a.privilege_type || ':' || a.is_grantable::text, ',' ORDER BY a.privilege_type)
                         FROM pg_default_acl d, aclexplode(d.defaclacl) a
                        WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace
                          AND d.defaclobjtype = 'f' AND a.grantee = 'service_role'::regrole), '<none>')
      UNION ALL
      -- Every schema, its owner and ACL: the probe schema must be gone again.
      SELECT 'namespace', md5(string_agg(concat_ws('|', n.oid, n.nspname, pg_get_userbyid(n.nspowner), coalesce(n.nspacl::text, 'NULL')),
                                         ',' ORDER BY n.oid))
        FROM pg_namespace n WHERE n.nspname !~ '^pg_(toast_)?temp_'
      UNION ALL
      SELECT 'role_membership', md5(string_agg(concat_ws('|', m.roleid, m.member, m.admin_option, m.inherit_option, m.set_option),
                                               ',' ORDER BY m.roleid, m.member, m.grantor))
        FROM pg_auth_members m
      UNION ALL
      SELECT 'event_trigger', md5(string_agg(md5(to_jsonb(e.*)::text), ',' ORDER BY e.oid))
        FROM pg_event_trigger e
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
  FROM (VALUES ('public.set_updated_at()'),
               ('public.update_updated_at_column()')) AS w(sig)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.sig)
  LEFT JOIN pg_language l ON l.oid = p.prolang;
  SELECT string_agg(w.line, E'\n' ORDER BY w.line COLLATE "C") INTO v_want
  FROM (VALUES
    ('public.set_updated_at()|resolved=t|owner=postgres|lang=plpgsql|kind=f|secdef=f|vol=v|parallel=u|strict=f|leakproof=f'
     || '|retset=f|result=trigger|args=[]|config={search_path=pg_catalog}|body=301a884953d37769916294bb60562e05|sqlbody=f|cost=100|rows=0|support=0|comment=-'),
    ('public.update_updated_at_column()|resolved=t|owner=postgres|lang=plpgsql|kind=f|secdef=f|vol=v|parallel=u|strict=f|leakproof=f'
     || '|retset=f|result=trigger|args=[]|config={search_path=public}|body=ef6b2d76360a727c9d6479352655b7ba|sqlbody=f|cost=100|rows=0|support=0|comment=-')
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'default_function_execute: STOP — the two trigger functions are not exactly the reviewed ones; nothing was changed.\nfound:\n%\nexpected:\n%',
      coalesce(v_text, '<missing>'), v_want;
  END IF;

  SELECT array_agg(to_regprocedure(s)::oid ORDER BY to_regprocedure(s)::oid) INTO v_targets
  FROM (VALUES ('public.set_updated_at()'), ('public.update_updated_at_column()')) AS w(s);
  IF cardinality(v_targets) IS DISTINCT FROM 2 OR array_position(v_targets, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'default_function_execute: the two target signatures did not resolve to two functions';
  END IF;

  -- ── 1b. No overload of either name in `public` ──────────────────────────────
  -- (Supabase's own storage.update_updated_at_column() lives in `storage`; it
  -- is not a target, is not addressed by this file, and is left alone.)
  SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text COLLATE "C") INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('set_updated_at', 'update_updated_at_column')
    AND p.oid <> ALL (v_targets);
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION E'default_function_execute: STOP — unexpected overload(s) of a target name in public:\n%', v_text;
  END IF;

  -- ── 1c. The EXECUTE ACL is one reviewed representation, shared by both ─────
  SELECT count(DISTINCT coalesce(p.proacl::text, '<default>')), min(coalesce(p.proacl::text, '<default>')) INTO v_count, v_text
  FROM pg_proc p WHERE p.oid = ANY (v_targets);
  IF v_count <> 1 OR v_text NOT IN ('<default>', c_acl_hosted) THEN
    RAISE EXCEPTION 'default_function_execute: STOP — the targets'' EXECUTE ACLs are not one of the two reviewed representations (% distinct; %)',
      v_count, v_text;
  END IF;

  -- ── 1d. Exactly the reviewed twelve triggers use them ───────────────────────
  -- Rendered under this file's pg_catalog search_path, so every name is
  -- schema-qualified. Each line pins table, name, timing, event, level, WHEN
  -- clause (none), arguments (none) and function, plus enabled state and
  -- internal flag.
  SELECT string_agg(pg_get_triggerdef(t.oid) || '|enabled=' || t.tgenabled::text || '|internal=' || t.tgisinternal::text,
                    E'\n' ORDER BY pg_get_triggerdef(t.oid) COLLATE "C") INTO v_text
  FROM pg_trigger t WHERE t.tgfoid = ANY (v_targets);
  SELECT string_agg(w.line, E'\n' ORDER BY w.line COLLATE "C") INTO v_want
  FROM (VALUES
    ('CREATE TRIGGER trg_papers_updated_at BEFORE UPDATE ON public.papers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()|enabled=O|internal=false'),
    ('CREATE TRIGGER update_ai_model_catalog_updated_at BEFORE UPDATE ON public.ai_model_catalog FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()|enabled=O|internal=false'),
    ('CREATE TRIGGER update_author_identities_updated_at BEFORE UPDATE ON public.author_identities FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()|enabled=O|internal=false'),
    ('CREATE TRIGGER update_filter_presets_updated_at BEFORE UPDATE ON public.filter_presets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()|enabled=O|internal=false'),
    ('CREATE TRIGGER update_internal_user_access_updated_at BEFORE UPDATE ON public.internal_user_access FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()|enabled=O|internal=false'),
    ('CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()|enabled=O|internal=false'),
    ('CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()|enabled=O|internal=false'),
    ('CREATE TRIGGER update_usage_counters_updated_at BEFORE UPDATE ON public.usage_counters FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()|enabled=O|internal=false'),
    ('CREATE TRIGGER update_usage_credits_updated_at BEFORE UPDATE ON public.usage_credits FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()|enabled=O|internal=false'),
    ('CREATE TRIGGER update_user_ai_preferences_updated_at BEFORE UPDATE ON public.user_ai_preferences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()|enabled=O|internal=false'),
    ('CREATE TRIGGER update_user_entitlements_updated_at BEFORE UPDATE ON public.user_entitlements FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()|enabled=O|internal=false'),
    ('CREATE TRIGGER update_user_storage_usage_updated_at BEFORE UPDATE ON public.user_storage_usage FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()|enabled=O|internal=false')
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'default_function_execute: STOP — the triggers using the two functions are not the reviewed twelve.\nfound:\n%\nexpected:\n%',
      coalesce(v_text, '<none>'), v_want;
  END IF;

  -- ── 1e. Nothing but those twelve triggers depends on them ───────────────────
  SELECT string_agg(pg_describe_object(d.classid, d.objid, d.objsubid) || ' (' || d.deptype::text || ')', E'\n'
                    ORDER BY pg_describe_object(d.classid, d.objid, d.objsubid) COLLATE "C") INTO v_text
  FROM pg_depend d
  WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = ANY (v_targets)
    AND NOT (d.classid = 'pg_trigger'::regclass AND d.deptype = 'n'
             AND d.objid IN (SELECT t.oid FROM pg_trigger t WHERE t.tgfoid = ANY (v_targets)));
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION E'default_function_execute: STOP — unreviewed dependent(s) on a target:\n%', v_text;
  END IF;
  SELECT count(*) INTO v_count
  FROM pg_depend d WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = ANY (v_targets);
  IF v_count <> 12 THEN
    RAISE EXCEPTION 'default_function_execute: STOP — % dependency rows on the targets; the reviewed state has exactly the 12 trigger rows', v_count;
  END IF;

  -- ── 1f. The reviewed `public` function inventory ────────────────────────────
  -- 43 functions, of which exactly the two targets carry PUBLIC EXECUTE.
  SELECT count(*) INTO v_count FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
  IF v_count <> 43 THEN
    RAISE EXCEPTION 'default_function_execute: STOP — public holds % functions; the reviewed state holds 43', v_count;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text COLLATE "C") INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                 WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE');
  IF v_text IS DISTINCT FROM 'public.set_updated_at()' || E'\n' || 'public.update_updated_at_column()' THEN
    RAISE EXCEPTION E'default_function_execute: STOP — the PUBLIC-executable functions in public are not exactly the two targets:\n%',
      coalesce(v_text, '<none>');
  END IF;

  -- ── 1g. postgres holds NO global default-privilege entry ────────────────────
  -- Neither environment has one. An existing global entry would mean someone
  -- changed the database-wide defaults already — an unreviewed state.
  SELECT string_agg(d.defaclobjtype::text || '=' || d.defaclacl::text, ', ' ORDER BY d.defaclobjtype::text) INTO v_text
  FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'default_function_execute: STOP — postgres already holds GLOBAL default privileges (%); unreviewed', v_text;
  END IF;

  -- ── 1h. postgres's `public` FUNCTION default entry is a reviewed shape ─────
  -- Judged WHOLE, as its exact literal: owner plus anon, authenticated and
  -- service_role (hosted), or owner only (clean replay, and Supabase's
  -- documented opt-in). So anon and authenticated are both present or both
  -- absent, no PUBLIC entry and no other grantee can exist, and a shape nobody
  -- reviewed — e.g. anon without authenticated, or an extra grantee — stops
  -- the file instead of being normalised by section 2's name-based REVOKE.
  SELECT d.defaclacl::text INTO v_entry
  FROM pg_default_acl d
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'f';
  IF v_entry IS NULL OR v_entry NOT IN (c_def_hosted, c_def_replay) THEN
    RAISE EXCEPTION 'default_function_execute: STOP — postgres''s public FUNCTION default entry is % — neither reviewed shape (hosted % or clean replay %)',
      coalesce(v_entry, '<absent>'), c_def_hosted, c_def_replay;
  END IF;

  -- ── 1i. Record the targets, the starting entry and the snapshot ─────────────
  PERFORM set_config('paperlume.default_function_execute.targets', v_targets::text, true);
  PERFORM set_config('paperlume.default_function_execute.public_f_entry_before', v_entry, true);
  PERFORM set_config('paperlume.default_function_execute.snapshot_sql', c_snapshot, true);
  EXECUTE c_snapshot INTO v_text USING v_targets;
  PERFORM set_config('paperlume.default_function_execute.snapshot', v_text, true);
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The change — exactly four privilege statements
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The two REVOKEs name the ROLES, not privileges, so they converge both
-- starting representations (NULL and the explicit hosted form) on
-- `{postgres=X/postgres}`. The global default statement removes PUBLIC from
-- every function postgres creates hereafter; the per-schema one removes
-- Supabase's anon and authenticated entry in `public`. service_role's default
-- entry is deliberately not named.

REVOKE ALL ON FUNCTION public.set_updated_at()           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed verification — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 3a–3d. The catalog end state ─────────────────────────────────────────────
DO $verify$
DECLARE
  v_targets  OID[];
  v_before   TEXT;
  v_text     TEXT;
BEGIN
  v_targets := nullif(current_setting('paperlume.default_function_execute.targets', true), '')::oid[];
  v_before  := current_setting('paperlume.default_function_execute.public_f_entry_before', true);
  IF cardinality(v_targets) IS DISTINCT FROM 2 OR coalesce(v_before, '') = ''
     OR coalesce(current_setting('paperlume.default_function_execute.snapshot', true), '') = '' THEN
    RAISE EXCEPTION 'default_function_execute: the state recorded in section 1 is missing — this file must run as one transaction';
  END IF;

  -- 3a. Both targets are owner-only, directly and effectively.
  SELECT string_agg(p.oid::regprocedure::text || ' = ' || coalesce(p.proacl::text, '<default>'), ', ' ORDER BY p.oid) INTO v_text
  FROM pg_proc p WHERE p.oid = ANY (v_targets) AND p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}';
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'default_function_execute: a target is not exactly owner-only: %', v_text;
  END IF;
  SELECT string_agg(r || ' -> ' || t::regprocedure::text, ', ' ORDER BY r, t) INTO v_text
  FROM unnest(v_targets) AS t,
       unnest(ARRAY['anon', 'authenticated', 'service_role', 'authenticator']) AS r
  WHERE to_regrole(r) IS NOT NULL AND has_function_privilege(to_regrole(r), t, 'EXECUTE');
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'default_function_execute: an API role can still execute a target: %', v_text;
  END IF;

  -- 3b. No function in `public` is executable through PUBLIC any more.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C") INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0);
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'default_function_execute: still PUBLIC-executable in public: %', v_text;
  END IF;

  -- 3c. postgres's global entry is exactly the one this file created.
  SELECT string_agg(d.defaclobjtype::text || '=' || d.defaclacl::text, ', ' ORDER BY d.defaclobjtype::text) INTO v_text
  FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0;
  IF v_text IS DISTINCT FROM 'f={postgres=X/postgres}' THEN
    RAISE EXCEPTION 'default_function_execute: postgres''s GLOBAL default entries are %, expected exactly f={postgres=X/postgres}',
      coalesce(v_text, '<none>');
  END IF;

  -- 3d. postgres's `public` function entry lost anon and authenticated and
  -- nothing else: the owner, plus service_role exactly where it was.
  SELECT d.defaclacl::text INTO v_text
  FROM pg_default_acl d
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'f';
  -- (The CASE is parenthesised: PL/pgSQL ends an IF condition at the first
  -- unparenthesised THEN.)
  IF v_text IS DISTINCT FROM (CASE v_before
                                WHEN '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
                                  THEN '{postgres=X/postgres,service_role=X/postgres}'
                                WHEN '{postgres=X/postgres}' THEN '{postgres=X/postgres}'
                              END) THEN
    RAISE EXCEPTION 'default_function_execute: postgres''s public FUNCTION default entry went from % to % — not the reviewed transition',
      v_before, coalesce(v_text, '<absent>');
  END IF;
  -- Allowlist form of the same claim: no grantee but the owner and service_role.
  SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ') INTO v_text
  FROM pg_default_acl d, aclexplode(d.defaclacl) a
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'f'
    AND a.grantee NOT IN ('postgres'::regrole, 'service_role'::regrole);
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'default_function_execute: postgres''s public FUNCTION default entry still names %', v_text;
  END IF;
END
$verify$;

-- ── 3e. The defaults, proved on real objects, and the triggers, proved firing ─
-- A function created now in `public` and one in a fresh schema show what the
-- next migration's functions will inherit. Two scratch tables, each carrying a
-- BEFORE UPDATE trigger on one hardened function, are then updated as
-- `authenticated` — which holds no EXECUTE on either — and each updated_at must
-- advance to this transaction's now(), while a direct call of either function
-- by that same role must be refused with 42501. Everything lives in one
-- scratch schema that is dropped again before this block ends; no `public`
-- relation is touched.
DO $probe$
DECLARE
  v_role_at_start TEXT := current_setting('paperlume.default_function_execute.role_at_start', true);
  v_svc_default   BOOLEAN;
  v_text          TEXT;
  v_denied        INTEGER := 0;
  v_ts_set        TIMESTAMPTZ;
  v_ts_upd        TIMESTAMPTZ;
BEGIN
  IF v_role_at_start IS NULL OR v_role_at_start = '' THEN
    RAISE EXCEPTION 'default_function_execute: the role recorded in section 0 is missing';
  END IF;
  IF to_regnamespace('zz_c56_default_probe') IS NOT NULL
     OR to_regprocedure('public.zz_c56_default_probe()') IS NOT NULL THEN
    RAISE EXCEPTION 'default_function_execute: a probe object name is already taken';
  END IF;

  -- Does postgres's public entry (still) give service_role EXECUTE by default?
  SELECT EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
                  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace
                    AND d.defaclobjtype = 'f' AND a.grantee = 'service_role'::regrole)
    INTO v_svc_default;

  EXECUTE 'CREATE SCHEMA zz_c56_default_probe';
  EXECUTE $q$CREATE FUNCTION public.zz_c56_default_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'$q$;
  EXECUTE $q$CREATE FUNCTION zz_c56_default_probe.zz_c56_default_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'$q$;

  -- A new public function reaches no one but its owner — and service_role
  -- exactly when the preserved platform entry says so.
  SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ', ') INTO v_text
  FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  WHERE p.oid = 'public.zz_c56_default_probe()'::regprocedure
    AND a.grantee NOT IN ('postgres'::regrole, 'service_role'::regrole);
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'default_function_execute: a new public function still reaches %', v_text;
  END IF;
  IF has_function_privilege('anon', 'public.zz_c56_default_probe()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.zz_c56_default_probe()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'default_function_execute: anon or authenticated can execute a new public function';
  END IF;
  IF has_function_privilege('service_role', 'public.zz_c56_default_probe()'::regprocedure, 'EXECUTE') IS DISTINCT FROM v_svc_default THEN
    RAISE EXCEPTION 'default_function_execute: service_role''s EXECUTE on a new public function (%) does not match its preserved default entry (%)',
      has_function_privilege('service_role', 'public.zz_c56_default_probe()'::regprocedure, 'EXECUTE'), v_svc_default;
  END IF;

  -- A new function in any other schema is owner-only.
  SELECT coalesce(p.proacl::text, '<default>') INTO v_text
  FROM pg_proc p WHERE p.oid = 'zz_c56_default_probe.zz_c56_default_probe()'::regprocedure;
  IF v_text IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'default_function_execute: a new function outside public carries %, expected {postgres=X/postgres}', v_text;
  END IF;

  -- The two hardened functions still fire for a caller with no EXECUTE.
  EXECUTE 'CREATE TABLE zz_c56_default_probe.t_set (id integer PRIMARY KEY, updated_at timestamptz NOT NULL)';
  EXECUTE 'CREATE TABLE zz_c56_default_probe.t_upd (id integer PRIMARY KEY, updated_at timestamptz NOT NULL)';
  EXECUTE 'CREATE TRIGGER t_set_updated_at BEFORE UPDATE ON zz_c56_default_probe.t_set FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
  EXECUTE 'CREATE TRIGGER t_upd_updated_at BEFORE UPDATE ON zz_c56_default_probe.t_upd FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()';
  EXECUTE $q$INSERT INTO zz_c56_default_probe.t_set VALUES (1, '2001-01-01 00:00:00+00')$q$;
  EXECUTE $q$INSERT INTO zz_c56_default_probe.t_upd VALUES (1, '2001-01-01 00:00:00+00')$q$;
  EXECUTE 'GRANT USAGE ON SCHEMA zz_c56_default_probe TO authenticated';
  EXECUTE 'GRANT SELECT, UPDATE ON zz_c56_default_probe.t_set, zz_c56_default_probe.t_upd TO authenticated';

  PERFORM set_config('role', 'authenticated', true);
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'default_function_execute: could not switch to authenticated for the trigger probe';
  END IF;
  EXECUTE 'UPDATE zz_c56_default_probe.t_set SET id = id';
  EXECUTE 'UPDATE zz_c56_default_probe.t_upd SET id = id';
  BEGIN
    PERFORM public.set_updated_at();
  EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
  END;
  BEGIN
    PERFORM public.update_updated_at_column();
  EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
  END;
  PERFORM set_config('role', v_role_at_start, true);
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'default_function_execute: could not return to postgres after the trigger probe (current_user %)', current_user;
  END IF;

  EXECUTE 'SELECT updated_at FROM zz_c56_default_probe.t_set WHERE id = 1' INTO v_ts_set;
  EXECUTE 'SELECT updated_at FROM zz_c56_default_probe.t_upd WHERE id = 1' INTO v_ts_upd;
  IF v_ts_set IS DISTINCT FROM now() OR v_ts_upd IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'default_function_execute: an owner-only trigger function did not fire for a caller without EXECUTE (set_updated_at %, update_updated_at_column %)',
      v_ts_set, v_ts_upd;
  END IF;
  IF v_denied <> 2 THEN
    RAISE EXCEPTION 'default_function_execute: a direct call of a hardened function by authenticated was not refused with 42501 (% of 2 refused)', v_denied;
  END IF;

  -- Clean up: every probe object, by name, RESTRICT.
  EXECUTE 'DROP TABLE zz_c56_default_probe.t_set RESTRICT';
  EXECUTE 'DROP TABLE zz_c56_default_probe.t_upd RESTRICT';
  EXECUTE 'DROP FUNCTION zz_c56_default_probe.zz_c56_default_probe() RESTRICT';
  EXECUTE 'DROP FUNCTION public.zz_c56_default_probe() RESTRICT';
  EXECUTE 'DROP SCHEMA zz_c56_default_probe RESTRICT';
  IF to_regnamespace('zz_c56_default_probe') IS NOT NULL
     OR to_regprocedure('public.zz_c56_default_probe()') IS NOT NULL THEN
    RAISE EXCEPTION 'default_function_execute: a probe object survived its clean-up';
  END IF;
END
$probe$;

-- ── 3f–3h. Nothing else moved ────────────────────────────────────────────────
DO $still$
DECLARE
  v_targets  OID[];
  v_before   TEXT;
  v_after    TEXT;
  v_text     TEXT;
  v_count    INTEGER;
BEGIN
  v_targets := nullif(current_setting('paperlume.default_function_execute.targets', true), '')::oid[];
  v_before  := current_setting('paperlume.default_function_execute.snapshot', true);

  -- 3f. The snapshot: the targets minus their ACL, every other function (whole
  -- rows in public, identity and ACL database-wide), public relations, columns,
  -- policies and triggers, every other default-privilege entry, service_role's
  -- default grant in public, every schema, role memberships and event triggers.
  -- The failure names each category that moved.
  EXECUTE current_setting('paperlume.default_function_execute.snapshot_sql', true) INTO v_after USING v_targets;
  SELECT string_agg(coalesce(b.cat, a.cat), ', ' ORDER BY coalesce(b.cat, a.cat)) INTO v_text
  FROM (SELECT split_part(l, '|', 1) AS cat, l FROM unnest(string_to_array(v_before, E'\n')) AS l) b
  FULL JOIN (SELECT split_part(l, '|', 1) AS cat, l FROM unnest(string_to_array(v_after, E'\n')) AS l) a USING (cat)
  WHERE b.l IS DISTINCT FROM a.l;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'default_function_execute: something besides the reviewed privileges changed: %', v_text;
  END IF;

  SELECT count(*) INTO v_count FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
  IF v_count <> 43 THEN
    RAISE EXCEPTION 'default_function_execute: public holds % functions afterwards; expected 43', v_count;
  END IF;

  -- 3g. No relation in `public` was locked at all.
  SELECT coalesce(string_agg(DISTINCT l.relation::regclass::text || ' ' || l.mode, ', '), '') INTO v_text
  FROM pg_locks l
  WHERE l.locktype = 'relation' AND l.pid = pg_backend_pid()
    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND l.relation IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace);
  IF v_text <> '' THEN
    RAISE EXCEPTION 'default_function_execute: this transaction holds a lock on a relation in public: %', v_text;
  END IF;

  -- 3h. This transaction wrote no row in public, auth or storage.
  v_before := current_setting('paperlume.default_function_execute.xact_writes_at_start', true);
  IF coalesce(v_before, '') = '' THEN
    RAISE EXCEPTION 'default_function_execute: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  SELECT string_agg(
           n.nspname || '.' || c.relname || '=' || (pg_stat_get_xact_tuples_inserted(c.oid)
                                                    + pg_stat_get_xact_tuples_updated(c.oid)
                                                    + pg_stat_get_xact_tuples_deleted(c.oid)),
           ' ' ORDER BY n.nspname, c.relname) INTO v_text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p');
  IF v_text IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'default_function_execute: this transaction wrote application rows (row writes at start: %; now: %)', v_before, v_text;
  END IF;
END
$still$;

COMMIT;
