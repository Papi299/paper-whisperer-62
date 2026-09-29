-- SERVICE-ROLE-LEAST-PRIVILEGE-HARDENING-001 — remove service_role's unused
-- authority over application-owned objects in `public`, and make every object
-- `postgres` creates there later grant it nothing until a migration says so
-- (C57).
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly five privilege statements (section 2), and nothing else:
--
--   REVOKE ALL ON TABLE <the 20 reviewed tables>            FROM service_role;
--   REVOKE ALL ON SEQUENCE public.papers_insert_order_seq    FROM service_role;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM service_role;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM service_role;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM service_role;
--
-- Afterwards the whole application-owned surface of service_role is:
--
--   * USAGE on schema `public` (granted by the platform; not touched here);
--   * INSERT on public.ai_provider_usage_events (AI usage telemetry);
--   * EXECUTE on public.refund_ai_quota(uuid) (AI quota refund, C47);
--
-- and nothing else — no other relation, sequence, column or function, and no
-- default privilege on any table, sequence or function `postgres` creates in
-- `public` from now on. No row, table definition, column, constraint, index,
-- policy, trigger, function body, security mode, search_path, owner, role
-- attribute, role membership, schema grant or platform schema changes.
--
-- WHY — least privilege on a role that bypasses RLS
-- ─────────────────────────────────────────────────────────────────────────────
-- service_role is the role behind the project's secret key and has BYPASSRLS,
-- so object grants are the only database control on what that key can do:
-- a grant it holds is reachable in full, for every user's rows, by anyone who
-- holds the key. SERVICE-ROLE-LEAST-PRIVILEGE-AUDIT-001 (2026-09-29, read-only)
-- enumerated every consumer of the key — the six deployed Edge Function
-- bundles and their import closures, the database (no cron, no pg_net, no
-- webhooks, no Vault secrets), CI, and the operator runbooks — and found that
-- the live runtime uses exactly the two grants kept above:
--
--   * analyze-paper and suggest-paper-organization append one telemetry row
--     (INSERT without RETURNING — PostgREST's default for supabase-js insert)
--     and, when a provider call fails, call refund_ai_quota;
--   * delete-account never touches a `public` object. It lists and removes the
--     user's Storage objects through the Storage API (which runs as
--     service_role on the platform-owned `storage` schema, whose grants this
--     file does not touch) and deletes the user through the Auth Admin API
--     (authorised by the key's role claim; its SQL runs as
--     supabase_auth_admin). The ON DELETE CASCADE / SET NULL actions then run
--     as each referencing table's owner, and the only AFTER DELETE trigger on
--     that path, refund_storage_quota(), is SECURITY DEFINER.
--
-- Nothing else used the rest: SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES, TRIGGER and MAINTAIN on twenty tables, the insert-order
-- sequence, and the platform's default privileges that hand service_role
-- every new table, sequence and function. Owner/manager administration is a
-- SQL transaction as `postgres` (docs/deployment.md §13.3), not a secret-key
-- client. The only real consumers were the local E2E fixtures, which this
-- change moves to the local database-owner connection. The future billing
-- webhook (C27, paused) is not served by a standing grant: its own migration
-- grants the minimum it needs when that work resumes.
--
-- A leaked secret key still reaches Auth administration and Storage — those
-- are what a secret key is for — but it can no longer read every user's
-- library and profile, rewrite entitlements, internal access, usage counters
-- or subscriptions, empty tables, attach triggers, take ACCESS EXCLUSIVE
-- locks, or inherit whatever a future migration forgets to lock down.
--
-- STARTING SHAPES — judged by privilege state, never by date
-- ─────────────────────────────────────────────────────────────────────────────
-- Every relation and function ACL outside service_role, and service_role's
-- grants on the twenty tables, the telemetry table and the refund function,
-- are identical in every environment. Three reviewed shapes differ only in
-- the sequence ACL and in `postgres`'s `public` default entries:
--
--   shape      sequence           TABLES default       SEQUENCES default   FUNCTIONS default
--   H hosted   service_role=rwU   service_role=arwdDxtm service_role=rwU   service_role=X
--   R replay   service_role=wU    service_role=Dxtm     service_role=w     (none)
--   P platform service_role=rwU   service_role=Dxtm     service_role=w     service_role=X
--
-- H is hosted Production (verified read-only 2026-09-29). R is a clean local
-- replay under the pinned CLI. P is hosted Production after Supabase applies
-- its announced default-privilege revoke to existing projects
-- (supabase/supabase discussion #45329), which removes SELECT, INSERT, UPDATE,
-- DELETE from the TABLES default and USAGE, SELECT from the SEQUENCES default
-- for anon, authenticated and service_role, and leaves existing objects and
-- the FUNCTIONS default alone. Each shape is recognised as a whole; any other
-- combination stops the file. All three converge on the same end state.
--
-- SAFETY — fail closed
-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1 refuses, before anything changes, unless: `public` holds exactly
-- the reviewed 29 tables and one sequence, all owned by postgres; service_role
-- belongs to no role; its grants are exactly the reviewed ones, granted by
-- postgres without grant option; it holds no column grant; it can execute
-- exactly refund_ai_quota(uuid), which is exactly the reviewed function; the
-- anon, authenticated and PUBLIC matrix is exactly the reviewed one; it has
-- USAGE and no CREATE on `public`; and the default entries are one reviewed
-- shape. A new application object or an unexpected grant therefore stops the
-- file instead of being silently revoked. Section 3 proves the end state on
-- the catalog AND on newly created objects, and proves nothing else moved:
-- every other grant, every default-privilege entry not changed here, every
-- relation, column, constraint, index, policy, trigger and function, every
-- schema, role and membership, no lock on any `public` relation and no row
-- written.
--
-- PRODUCTION PROJECTION
-- ─────────────────────────────────────────────────────────────────────────────
-- Verified read-only on 2026-09-29 (PostgreSQL 17.6; ledger 96, latest
-- 20260928133918): shape H. A separately authorised rollout is expected to add
-- one ledger row and change 21 relation ACLs and three `pg_default_acl` rows —
-- catalog writes only. GRANT/REVOKE lock catalog rows, not the tables. The
-- in-transaction probes create and drop one table, its sequence and one
-- function in `public` and never touch existing data. No Edge Function change
-- is required: the two grants the runtime uses are kept exactly.
--
-- ROLLBACK — forward only
-- ─────────────────────────────────────────────────────────────────────────────
-- Do not edit this file after it has been applied. A reversal is a new forward
-- migration that re-GRANTs exactly the authority a named server path needs.
-- The pre-change effective posture can be restored with
-- `GRANT ALL ON TABLE <the 20> TO service_role`, `GRANT USAGE, SELECT, UPDATE
-- ON SEQUENCE public.papers_insert_order_seq TO service_role` and the matching
-- `ALTER DEFAULT PRIVILEGES … GRANT` statements; the ACL text may list entries
-- in a different order, which is not a difference in privilege.
--
-- Durable decision: C57.

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
-- Only the owner (postgres) can revoke what postgres granted, and
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` must run as postgres. The role
-- setting in force now is recorded so section 3 can return to it after the
-- service_role probe — `RESET ROLE` would return to the session user, which
-- under the linked CLI is a login role, not postgres.

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role_least_privilege: must run as postgres (current_user is %)', current_user;
  END IF;

  IF current_setting('search_path') IS DISTINCT FROM 'pg_catalog, pg_temp'
     OR current_setting('lock_timeout') IS DISTINCT FROM '5s' THEN
    RAISE EXCEPTION 'service_role_least_privilege: the transaction-local settings are not in effect (search_path %, lock_timeout %) — this file must run as one transaction',
      current_setting('search_path'), current_setting('lock_timeout');
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'service_role_least_privilege: track_counts is off, so the no-write self-check could not observe anything';
  END IF;

  PERFORM set_config('paperlume.service_role_least_privilege.role_at_start', current_setting('role'), true);
  PERFORM set_config(
    'paperlume.service_role_least_privilege.xact_writes_at_start',
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
-- 2026-09-29. Every privilege list is rendered from aclexplode and sorted, so
-- the order in which PostgreSQL happens to store ACL entries never matters.
-- Nothing here repairs unexpected state: any mismatch rolls the whole file
-- back before anything changes.

DO $pre$
DECLARE
  v_text      TEXT;
  v_want      TEXT;
  v_count     INTEGER;
  v_shape     TEXT;
  -- Everything section 3 must find unchanged, one line per category. The
  -- query text is stored and re-executed verbatim there, so both sides
  -- measure exactly the same thing. service_role's own grants on the 21
  -- relations this file changes are the only thing excluded, and section 3
  -- pins their end state separately.
  c_snapshot  CONSTANT TEXT := $snap$
    WITH targets AS (
      SELECT to_regclass('public.' || t) AS oid
        FROM unnest(ARRAY['filter_presets', 'internal_user_access', 'keyword_exclusion_pool', 'keyword_pool',
                          'paper_attachments', 'paper_projects', 'paper_tags', 'papers', 'profiles', 'projects',
                          'study_type_exclusion_pool', 'study_type_pool', 'subscription_events', 'subscriptions',
                          'synonym_pool', 'tags', 'usage_counters', 'usage_credits', 'user_entitlements',
                          'user_storage_usage', 'papers_insert_order_seq']) AS t
    ),
    rel_acl AS (
      SELECT c.oid, a.grantee,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type
             || ':' || a.is_grantable::text || ':' || pg_get_userbyid(a.grantor) AS line
        FROM pg_class c,
             aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
       WHERE c.relnamespace = 'public'::regnamespace
    ),
    def_acl AS (
      SELECT d.oid, a.grantee,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type
             || ':' || a.is_grantable::text AS line
        FROM pg_default_acl d, aclexplode(d.defaclacl) a
       WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace
         AND d.defaclobjtype IN ('r', 'S', 'f')
    )
    SELECT string_agg(x.cat || '|' || coalesce(x.digest, '-'), E'\n' ORDER BY x.cat COLLATE "C")
    FROM (
      -- Every public relation: identity, owner, storage, RLS flags, options,
      -- comment — and every ACL entry except service_role's.
      SELECT 'rel' AS cat,
             count(*)::text || ':' || md5(string_agg(concat_ws('|', c.oid, c.relname, c.relkind, pg_get_userbyid(c.relowner),
                                      c.relfilenode, c.relrowsecurity, c.relforcerowsecurity, c.relhastriggers,
                                      coalesce(c.reloptions::text, 'NULL'),
                                      coalesce(md5(obj_description(c.oid, 'pg_class')), '-'),
                                      (SELECT coalesce(string_agg(r.line, ',' ORDER BY r.line COLLATE "C"), '')
                                         FROM rel_acl r WHERE r.oid = c.oid AND r.grantee <> 'service_role'::regrole)),
                            E'\n' ORDER BY c.oid)) AS digest
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      -- service_role's grants on every public relation this file does NOT
      -- change (the telemetry INSERT among them): exactly as they were.
      SELECT 'rel_service_role_untouched',
             coalesce(string_agg(c.relname || '=' || r.line, ',' ORDER BY c.relname COLLATE "C", r.line COLLATE "C"), '<none>')
        FROM rel_acl r JOIN pg_class c ON c.oid = r.oid
       WHERE r.grantee = 'service_role'::regrole AND r.oid NOT IN (SELECT oid FROM targets)
      UNION ALL
      -- Relations in every other schema (auth, storage, realtime, vault, …):
      -- identity, owner and ACL. No platform object gains or loses a grant.
      SELECT 'rel_other_schemas_acl',
             count(*)::text || ':' || md5(string_agg(c.oid::text || '=' || pg_get_userbyid(c.relowner) || '=' || coalesce(c.relacl::text, 'NULL'),
                                                     ',' ORDER BY c.oid))
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname <> 'public' AND n.nspname !~ '^pg_(toast_)?temp_' AND c.relpersistence <> 't'
      UNION ALL
      -- Columns, including their ACLs.
      SELECT 'att', md5(string_agg(md5(to_jsonb(a.*)::text), ',' ORDER BY a.attrelid, a.attnum))
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'constraint', md5(string_agg(md5(to_jsonb(k.*)::text), ',' ORDER BY k.oid))
        FROM pg_constraint k WHERE k.connamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'index', md5(string_agg(md5(to_jsonb(i.*)::text), ',' ORDER BY i.indexrelid))
        FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'policy', md5(string_agg(md5(to_jsonb(pol.*)::text), ',' ORDER BY pol.oid))
        FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'trigger', md5(string_agg(md5(to_jsonb(t.*)::text), ',' ORDER BY t.oid))
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      -- Every public function as its whole catalog row, ACL included: no
      -- function body, security mode, search_path, owner or grant changes.
      SELECT 'fn_public',
             count(*)::text || ':' || md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text) || '='
                            || coalesce(md5(obj_description(p.oid, 'pg_proc')), '-'), E'\n' ORDER BY p.oid))
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'fn_all_acl',
             count(*)::text || ':' || md5(string_agg(p.oid::text || '=' || coalesce(p.proacl::text, 'NULL'), ',' ORDER BY p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname !~ '^pg_(toast_)?temp_'
      UNION ALL
      SELECT 'type_public', md5(string_agg(t.oid::text || '=' || coalesce(t.typacl::text, 'NULL'), ',' ORDER BY t.oid))
        FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace
      UNION ALL
      -- Every default-privilege entry except the three this file changes —
      -- supabase_admin's, the `storage` and global entries among them.
      SELECT 'default_acl_others', md5(string_agg(md5(to_jsonb(da.*)::text), ',' ORDER BY da.oid))
        FROM pg_default_acl da
       WHERE NOT (da.defaclrole = 'postgres'::regrole AND da.defaclnamespace = 'public'::regnamespace
                  AND da.defaclobjtype IN ('r', 'S', 'f'))
      UNION ALL
      -- ...and inside those three, every grantee but service_role.
      SELECT 'default_public_others',
             coalesce(string_agg(d.defaclobjtype::text || '=' || da.line, ',' ORDER BY d.defaclobjtype::text, da.line COLLATE "C"), '<none>')
        FROM def_acl da JOIN pg_default_acl d ON d.oid = da.oid
       WHERE da.grantee <> 'service_role'::regrole
      UNION ALL
      SELECT 'namespace', md5(string_agg(concat_ws('|', n.oid, n.nspname, pg_get_userbyid(n.nspowner), coalesce(n.nspacl::text, 'NULL')),
                                         ',' ORDER BY n.oid))
        FROM pg_namespace n WHERE n.nspname !~ '^pg_(toast_)?temp_'
      UNION ALL
      SELECT 'database', coalesce(d.datacl::text, 'NULL') FROM pg_database d WHERE d.datname = current_database()
      UNION ALL
      SELECT 'role', md5(string_agg(concat_ws('|', r.oid, r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb,
                                              r.rolcanlogin, r.rolreplication, r.rolbypassrls, r.rolconnlimit,
                                              coalesce(r.rolconfig::text, 'NULL')), ',' ORDER BY r.oid))
        FROM pg_roles r
      UNION ALL
      SELECT 'role_membership', md5(string_agg(concat_ws('|', m.roleid, m.member, m.grantor, m.admin_option, m.inherit_option, m.set_option),
                                               ',' ORDER BY m.roleid, m.member, m.grantor))
        FROM pg_auth_members m
      UNION ALL
      SELECT 'event_trigger', md5(string_agg(md5(to_jsonb(e.*)::text), ',' ORDER BY e.oid))
        FROM pg_event_trigger e
    ) x
  $snap$;
BEGIN
  -- ── 1a. The reviewed relation inventory, owner and matrix ─────────────────
  -- One row per public relation: its kind, owner, and the sorted privileges of
  -- authenticated, anon, PUBLIC and service_role. Twenty tables carry the
  -- broad service_role grant this file removes; the telemetry table carries
  -- INSERT; eight tables and the sequence's client roles are as reviewed. The
  -- sequence's service_role grant is checked with the shape in 1e.
  SELECT string_agg(format('%s|%s|owner=%s|authenticated=%s|anon=%s|PUBLIC=%s|service_role=%s',
                           c.relname, c.relkind, pg_get_userbyid(c.relowner),
                           (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
                              FROM aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
                             WHERE a.grantee = 'authenticated'::regrole),
                           (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
                              FROM aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
                             WHERE a.grantee = 'anon'::regrole),
                           (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
                              FROM aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
                             WHERE a.grantee = 0),
                           CASE WHEN c.relkind = 'S' THEN '<shape>' ELSE
                           (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
                              FROM aclexplode(coalesce(c.relacl, acldefault('r'::"char", c.relowner))) a
                             WHERE a.grantee = 'service_role'::regrole) END),
                    E'\n' ORDER BY c.relname COLLATE "C") INTO v_text
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S');

  SELECT string_agg(w.rel || '|' || w.kind || '|owner=postgres|authenticated=' || w.auth || '|anon=|PUBLIC=|service_role=' || w.svc,
                    E'\n' ORDER BY w.rel COLLATE "C") INTO v_want
  FROM (VALUES
    ('ai_model_catalog',             'r', 'SELECT',                      ''),
    ('ai_provider_usage_events',     'r', '',                            'INSERT'),
    ('attachment_cleanup_queue',     'r', 'DELETE,SELECT',               ''),
    ('attachment_cleanup_tombstone', 'r', '',                            ''),
    ('author_identities',            'r', 'SELECT',                      ''),
    ('author_identity_aliases',      'r', 'DELETE,INSERT,SELECT',        ''),
    ('author_identity_links',        'r', 'SELECT',                      ''),
    ('author_identity_merges',       'r', 'SELECT',                      ''),
    ('filter_presets',               'r', 'DELETE,INSERT,SELECT,UPDATE', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('internal_user_access',         'r', '',                            'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('keyword_exclusion_pool',       'r', 'DELETE,INSERT,SELECT',        'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('keyword_pool',                 'r', 'DELETE,INSERT,SELECT',        'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('paper_attachments',            'r', 'SELECT',                      'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('paper_projects',               'r', 'SELECT',                      'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('paper_tags',                   'r', 'SELECT',                      'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('papers',                       'r', 'INSERT,SELECT,UPDATE',        'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('papers_insert_order_seq',      'S', 'USAGE',                       '<shape>'),
    ('profiles',                     'r', 'INSERT,SELECT,UPDATE',        'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('projects',                     'r', 'DELETE,INSERT,SELECT,UPDATE', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('study_type_exclusion_pool',    'r', 'DELETE,INSERT,SELECT',        'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('study_type_pool',              'r', 'DELETE,INSERT,SELECT,UPDATE', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('subscription_events',          'r', '',                            'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('subscriptions',                'r', '',                            'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('synonym_pool',                 'r', 'DELETE,INSERT,SELECT,UPDATE', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('tags',                         'r', 'DELETE,INSERT,SELECT,UPDATE', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('usage_counters',               'r', '',                            'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('usage_credits',                'r', 'SELECT',                      'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('user_ai_preferences',          'r', 'SELECT',                      ''),
    ('user_entitlements',            'r', 'SELECT',                      'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('user_storage_usage',           'r', 'SELECT',                      'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE')
  ) AS w(rel, kind, auth, svc);

  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'service_role_least_privilege: STOP — the public relations, their owner or their privilege matrix are not the reviewed ones; nothing was changed.\nfound:\n%\nexpected:\n%',
      coalesce(v_text, '<none>'), v_want;
  END IF;

  -- ── 1b. Nobody else holds anything, and nothing is delegable ──────────────
  -- The allowlist form of 1a: a grantee nobody named is exactly what a list
  -- of named roles cannot see.
  SELECT string_agg(c.relname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type,
                    ', ' ORDER BY c.relname COLLATE "C", a.privilege_type) INTO v_text
  FROM pg_class c,
       aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
  WHERE c.relnamespace = 'public'::regnamespace
    AND a.grantee NOT IN ('postgres'::regrole, 'authenticated'::regrole, 'service_role'::regrole);
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: STOP — an unreviewed grantee holds a privilege on a public relation: %', v_text;
  END IF;

  -- Every service_role entry was granted by postgres (so postgres's REVOKE
  -- removes it) and none carries a grant option.
  SELECT string_agg(c.relname || ':' || a.privilege_type || ' by ' || pg_get_userbyid(a.grantor)
                    || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END,
                    ', ' ORDER BY c.relname COLLATE "C", a.privilege_type) INTO v_text
  FROM pg_class c,
       aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
  WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'service_role'::regrole
    AND (a.grantor <> 'postgres'::regrole OR a.is_grantable);
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: STOP — a service_role grant was not made by postgres, or is delegable: %', v_text;
  END IF;

  -- ── 1c. Columns: the one reviewed grant, and nothing for service_role ─────
  SELECT string_agg(c.relname || '.' || att.attname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                    || ':' || a.privilege_type, ', ' ORDER BY c.relname COLLATE "C", att.attname COLLATE "C", a.privilege_type) INTO v_text
  FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid, aclexplode(att.attacl) a
  WHERE c.relnamespace = 'public'::regnamespace AND att.attacl IS NOT NULL;
  IF v_text IS DISTINCT FROM 'author_identities.preferred_name:authenticated:UPDATE' THEN
    RAISE EXCEPTION 'service_role_least_privilege: STOP — the column-level grants in public are not the one reviewed grant: %', coalesce(v_text, '<none>');
  END IF;

  -- ── 1d. Functions: service_role executes exactly the reviewed refund ──────
  SELECT count(*) INTO v_count FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
  IF v_count <> 43 THEN
    RAISE EXCEPTION 'service_role_least_privilege: STOP — public holds % functions; the reviewed state holds 43', v_count;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C") INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_text IS DISTINCT FROM 'public.refund_ai_quota(uuid)' THEN
    RAISE EXCEPTION 'service_role_least_privilege: STOP — service_role can execute % in public; the reviewed state is exactly public.refund_ai_quota(uuid)',
      coalesce(v_text, '<nothing>');
  END IF;

  SELECT format('owner=%s|lang=%s|kind=%s|secdef=%s|vol=%s|retset=%s|result=%s|args=[%s]|config=%s|body=%s|sqlbody=%s|acl=%s',
                pg_get_userbyid(p.proowner), l.lanname, p.prokind, p.prosecdef, p.provolatile, p.proretset,
                pg_get_function_result(p.oid), pg_get_function_arguments(p.oid), p.proconfig::text, md5(p.prosrc),
                (p.prosqlbody IS NOT NULL), coalesce(p.proacl::text, 'NULL')) INTO v_text
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = to_regprocedure('public.refund_ai_quota(uuid)');
  v_want := 'owner=postgres|lang=plpgsql|kind=f|secdef=t|vol=v|retset=t|result=TABLE(refunded boolean, period_type text, used integer)'
            || '|args=[p_user_id uuid]|config={"search_path=public, pg_temp"}|body=4224750ddbff3651e7e0aaa2576f4de4|sqlbody=f'
            || '|acl={postgres=X/postgres,service_role=X/postgres}';
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'service_role_least_privilege: STOP — refund_ai_quota(uuid) is not exactly the reviewed function.\nfound:    %\nexpected: %',
      coalesce(v_text, '<missing>'), v_want;
  END IF;

  -- No function in public is executable through PUBLIC or by anon (C56 / C38).
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C") INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0));
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: STOP — a public function is executable by PUBLIC or anon: %', v_text;
  END IF;

  -- ── 1e. The starting shape, judged whole ─────────────────────────────────
  -- postgres's three `public` default entries (each as its exact literal, so
  -- no other grantee and no grant option can hide in them), no other
  -- `postgres`/`public` entry, and the sequence's service_role grant.
  SELECT string_agg(d.defaclobjtype::text || '=' || d.defaclacl::text, ' ' ORDER BY d.defaclobjtype::text COLLATE "C") INTO v_text
  FROM pg_default_acl d
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace;
  v_text := coalesce(v_text, '<none>') || ' seq:service_role='
            || (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
                  FROM pg_class c, aclexplode(c.relacl) a
                 WHERE c.oid = 'public.papers_insert_order_seq'::regclass AND a.grantee = 'service_role'::regrole);

  v_shape := CASE v_text
    WHEN 'S={postgres=rwU/postgres,service_role=rwU/postgres} f={postgres=X/postgres,service_role=X/postgres} '
         || 'r={postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres} seq:service_role=SELECT,UPDATE,USAGE'
      THEN 'H'
    WHEN 'S={postgres=rwU/postgres,service_role=w/postgres} f={postgres=X/postgres} '
         || 'r={postgres=arwdDxtm/postgres,service_role=Dxtm/postgres} seq:service_role=UPDATE,USAGE'
      THEN 'R'
    WHEN 'S={postgres=rwU/postgres,service_role=w/postgres} f={postgres=X/postgres,service_role=X/postgres} '
         || 'r={postgres=arwdDxtm/postgres,service_role=Dxtm/postgres} seq:service_role=SELECT,UPDATE,USAGE'
      THEN 'P'
  END;
  IF v_shape IS NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: STOP — postgres''s public default entries and the sequence''s service_role grant (%) match none of the reviewed starting shapes (hosted, clean replay, hosted after the platform default revoke)',
      v_text;
  END IF;

  -- postgres's global default entry is exactly C56's, and names no one else.
  SELECT string_agg(d.defaclobjtype::text || '=' || d.defaclacl::text, ', ' ORDER BY d.defaclobjtype::text) INTO v_text
  FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0;
  IF v_text IS DISTINCT FROM 'f={postgres=X/postgres}' THEN
    RAISE EXCEPTION 'service_role_least_privilege: STOP — postgres''s GLOBAL default entries are %, expected exactly f={postgres=X/postgres} (C56)',
      coalesce(v_text, '<none>');
  END IF;

  -- ── 1f. The role and schema facts the end state depends on ───────────────
  -- service_role belongs to no role, so what it holds directly (plus PUBLIC)
  -- is everything it can do; it can use `public` and create nothing there.
  SELECT string_agg(pg_get_userbyid(m.roleid), ', ' ORDER BY pg_get_userbyid(m.roleid) COLLATE "C") INTO v_text
  FROM pg_auth_members m WHERE m.member = 'service_role'::regrole;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: STOP — service_role is a member of % and would inherit privileges this file cannot see', v_text;
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'service_role_least_privilege: STOP — service_role is a superuser; object grants would not bind it';
  END IF;
  IF NOT has_schema_privilege('service_role', 'public', 'USAGE') OR has_schema_privilege('service_role', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'service_role_least_privilege: STOP — service_role''s schema privileges on public are not USAGE-without-CREATE (usage %, create %)',
      has_schema_privilege('service_role', 'public', 'USAGE'), has_schema_privilege('service_role', 'public', 'CREATE');
  END IF;

  -- ── 1g. Record the shape and the snapshot ─────────────────────────────────
  PERFORM set_config('paperlume.service_role_least_privilege.shape', v_shape, true);
  PERFORM set_config('paperlume.service_role_least_privilege.snapshot_sql', c_snapshot, true);
  EXECUTE c_snapshot INTO v_text;
  PERFORM set_config('paperlume.service_role_least_privilege.snapshot', v_text, true);
  RAISE NOTICE 'service_role_least_privilege: preconditions hold; starting shape %', v_shape;
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The change — exactly five privilege statements
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Each names the ROLE, never a privilege list, so every reviewed starting
-- shape converges: whatever service_role held on these objects and in these
-- default entries, it holds nothing afterwards. anon, authenticated and PUBLIC
-- are not named. The telemetry table and the refund function are not named,
-- so their service_role grants stay exactly as they are.

REVOKE ALL ON TABLE
  public.filter_presets,
  public.internal_user_access,
  public.keyword_exclusion_pool,
  public.keyword_pool,
  public.paper_attachments,
  public.paper_projects,
  public.paper_tags,
  public.papers,
  public.profiles,
  public.projects,
  public.study_type_exclusion_pool,
  public.study_type_pool,
  public.subscription_events,
  public.subscriptions,
  public.synonym_pool,
  public.tags,
  public.usage_counters,
  public.usage_credits,
  public.user_entitlements,
  public.user_storage_usage
  FROM service_role;

REVOKE ALL ON SEQUENCE public.papers_insert_order_seq FROM service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed verification — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 3a–3e. The catalog end state: service_role's whole application surface ──
DO $verify$
DECLARE
  v_text TEXT;
BEGIN
  IF coalesce(current_setting('paperlume.service_role_least_privilege.shape', true), '') = ''
     OR coalesce(current_setting('paperlume.service_role_least_privilege.snapshot', true), '') = '' THEN
    RAISE EXCEPTION 'service_role_least_privilege: the state recorded in section 1 is missing — this file must run as one transaction';
  END IF;

  -- 3a. Relations, as stored: one entry, the telemetry INSERT.
  SELECT string_agg(c.relname || ':' || a.privilege_type || ':' || a.is_grantable::text || ':' || pg_get_userbyid(a.grantor),
                    ', ' ORDER BY c.relname COLLATE "C", a.privilege_type) INTO v_text
  FROM pg_class c,
       aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
  WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'service_role'::regrole;
  IF v_text IS DISTINCT FROM 'ai_provider_usage_events:INSERT:false:postgres' THEN
    RAISE EXCEPTION 'service_role_least_privilege: service_role''s stored relation grants in public are %, expected exactly ai_provider_usage_events:INSERT',
      coalesce(v_text, '<none>');
  END IF;

  -- 3b. Relations and sequences, as EFFECTIVE privileges (PUBLIC included).
  SELECT string_agg(c.relname || '=' || x.privs, ', ' ORDER BY c.relname COLLATE "C") INTO v_text
  FROM pg_class c
  CROSS JOIN LATERAL (
    SELECT string_agg(p, ',' ORDER BY p) AS privs
      FROM unnest(CASE WHEN c.relkind = 'S' THEN ARRAY['SELECT', 'UPDATE', 'USAGE']
                       ELSE ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] END) p
     WHERE CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('service_role', c.oid, p)
                ELSE has_table_privilege('service_role', c.oid, p) END) x
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND x.privs IS NOT NULL;
  IF v_text IS DISTINCT FROM 'ai_provider_usage_events=INSERT' THEN
    RAISE EXCEPTION 'service_role_least_privilege: service_role''s effective relation privileges in public are %, expected exactly ai_provider_usage_events=INSERT',
      coalesce(v_text, '<none>');
  END IF;

  -- 3c. Columns: no column grant, and no column reachable beyond the
  -- telemetry table's INSERT.
  SELECT string_agg(c.relname || '.' || att.attname || ':' || p, ', ' ORDER BY c.relname COLLATE "C", att.attname COLLATE "C", p) INTO v_text
  FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid,
       unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND att.attnum > 0 AND NOT att.attisdropped
    AND has_column_privilege('service_role', c.oid, att.attnum, p)
    AND NOT (c.oid = 'public.ai_provider_usage_events'::regclass AND p = 'INSERT');
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: service_role still reaches public columns: %', v_text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid, aclexplode(att.attacl) a
              WHERE c.relnamespace = 'public'::regnamespace AND att.attacl IS NOT NULL AND a.grantee = 'service_role'::regrole) THEN
    RAISE EXCEPTION 'service_role_least_privilege: service_role holds a column-level grant in public';
  END IF;

  -- 3d. Functions: exactly the refund, with its reviewed ACL.
  SELECT string_agg(p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, 'NULL'), ', '
                    ORDER BY p.oid::regprocedure::text COLLATE "C") INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_text IS DISTINCT FROM 'public.refund_ai_quota(uuid)={postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'service_role_least_privilege: service_role''s executable public functions are %, expected exactly refund_ai_quota(uuid) with its reviewed ACL',
      coalesce(v_text, '<none>');
  END IF;

  -- 3e. Default privileges: postgres's three `public` entries name the owner
  -- alone — the same literals whichever shape the file started from — and
  -- postgres's global entry is still exactly C56's.
  SELECT string_agg(d.defaclobjtype::text || '=' || d.defaclacl::text, ' ' ORDER BY d.defaclobjtype::text COLLATE "C") INTO v_text
  FROM pg_default_acl d
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace;
  IF v_text IS DISTINCT FROM 'S={postgres=rwU/postgres} f={postgres=X/postgres} r={postgres=arwdDxtm/postgres}' THEN
    RAISE EXCEPTION 'service_role_least_privilege: postgres''s public default entries are %, expected exactly S={postgres=rwU/postgres} f={postgres=X/postgres} r={postgres=arwdDxtm/postgres}',
      coalesce(v_text, '<none>');
  END IF;
  SELECT string_agg(d.defaclobjtype::text || '=' || d.defaclacl::text, ', ' ORDER BY d.defaclobjtype::text) INTO v_text
  FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0;
  IF v_text IS DISTINCT FROM 'f={postgres=X/postgres}' THEN
    RAISE EXCEPTION 'service_role_least_privilege: postgres''s GLOBAL default entries are %, expected exactly f={postgres=X/postgres}',
      coalesce(v_text, '<none>');
  END IF;

  -- The schema grant is the platform's and is unchanged: USAGE, no CREATE.
  IF NOT has_schema_privilege('service_role', 'public', 'USAGE') OR has_schema_privilege('service_role', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'service_role_least_privilege: service_role''s schema privileges on public changed';
  END IF;
END
$verify$;

-- ── 3f. The defaults, proved on real objects, and refused as service_role ───
-- A table (with its identity sequence) and a function created now show what
-- the next migration's objects will inherit: nothing for service_role — and,
-- as C38 and C56 already guarantee, nothing for anon, authenticated or PUBLIC.
-- Then, as service_role, a read of the table, a nextval of the sequence and a
-- call of the function must each be refused with 42501. The probe objects are
-- dropped again before this block ends; no existing relation is touched.
DO $probe$
DECLARE
  v_role_at_start TEXT := current_setting('paperlume.service_role_least_privilege.role_at_start', true);
  v_text          TEXT;
  v_denied        TEXT := '';
BEGIN
  IF v_role_at_start IS NULL OR v_role_at_start = '' THEN
    RAISE EXCEPTION 'service_role_least_privilege: the role recorded in section 0 is missing';
  END IF;
  IF to_regclass('public.zz_c57_probe_t') IS NOT NULL
     OR to_regclass('public.zz_c57_probe_t_id_seq') IS NOT NULL
     OR to_regprocedure('public.zz_c57_probe_f()') IS NOT NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: a probe object name is already taken';
  END IF;

  EXECUTE 'CREATE TABLE public.zz_c57_probe_t (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, v text)';
  EXECUTE $q$CREATE FUNCTION public.zz_c57_probe_f() RETURNS integer LANGUAGE sql AS 'SELECT 1'$q$;
  IF to_regclass('public.zz_c57_probe_t_id_seq') IS NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: the probe table''s identity sequence is not public.zz_c57_probe_t_id_seq';
  END IF;

  -- Stored grants: owner only, on all three.
  SELECT string_agg(o.what || ':' || CASE WHEN o.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(o.grantee) END || ':' || o.privilege_type, ', ') INTO v_text
  FROM (
    SELECT 'table' AS what, a.grantee, a.privilege_type
      FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     WHERE c.oid = 'public.zz_c57_probe_t'::regclass
    UNION ALL
    SELECT 'sequence', a.grantee, a.privilege_type
      FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) a
     WHERE c.oid = 'public.zz_c57_probe_t_id_seq'::regclass
    UNION ALL
    SELECT 'function', a.grantee, a.privilege_type
      FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = 'public.zz_c57_probe_f()'::regprocedure
  ) o
  WHERE o.grantee <> 'postgres'::regrole;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: a new public object still grants %', v_text;
  END IF;

  -- Effective, for the three API roles.
  SELECT string_agg(r || ' -> ' || w, ', ' ORDER BY r, w) INTO v_text
  FROM unnest(ARRAY['service_role', 'anon', 'authenticated']) r,
       unnest(ARRAY['table', 'sequence', 'function']) w
  WHERE CASE w
          WHEN 'table'    THEN has_table_privilege(r, 'public.zz_c57_probe_t'::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          WHEN 'sequence' THEN has_sequence_privilege(r, 'public.zz_c57_probe_t_id_seq'::regclass, 'SELECT,UPDATE,USAGE')
          ELSE                 has_function_privilege(r, 'public.zz_c57_probe_f()'::regprocedure, 'EXECUTE')
        END;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: an API role reaches a new public object: %', v_text;
  END IF;

  -- Real attempts, as service_role. Each runs in its own subtransaction and
  -- must fail with insufficient_privilege and nothing else.
  PERFORM set_config('role', 'service_role', true);
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_least_privilege: could not switch to service_role for the probe';
  END IF;
  BEGIN
    EXECUTE 'SELECT count(*) FROM public.zz_c57_probe_t';
    v_denied := v_denied || ' table:ALLOWED';
  EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied || ' table:42501';
  END;
  BEGIN
    EXECUTE $q$SELECT nextval('public.zz_c57_probe_t_id_seq')$q$;
    v_denied := v_denied || ' sequence:ALLOWED';
  EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied || ' sequence:42501';
  END;
  BEGIN
    EXECUTE 'SELECT public.zz_c57_probe_f()';
    v_denied := v_denied || ' function:ALLOWED';
  EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied || ' function:42501';
  END;
  PERFORM set_config('role', v_role_at_start, true);
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role_least_privilege: could not return to postgres after the probe (current_user %)', current_user;
  END IF;
  IF v_denied IS DISTINCT FROM ' table:42501 sequence:42501 function:42501' THEN
    RAISE EXCEPTION 'service_role_least_privilege: service_role was not refused on every new object:%', v_denied;
  END IF;

  -- Clean up: every probe object, by name, RESTRICT.
  EXECUTE 'DROP FUNCTION public.zz_c57_probe_f() RESTRICT';
  EXECUTE 'DROP TABLE public.zz_c57_probe_t RESTRICT';
  IF to_regclass('public.zz_c57_probe_t') IS NOT NULL
     OR to_regclass('public.zz_c57_probe_t_id_seq') IS NOT NULL
     OR to_regprocedure('public.zz_c57_probe_f()') IS NOT NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: a probe object survived its clean-up';
  END IF;
END
$probe$;

-- ── 3g–3i. Nothing else moved ────────────────────────────────────────────────
DO $still$
DECLARE
  v_before TEXT;
  v_after  TEXT;
  v_text   TEXT;
  v_count  INTEGER;
BEGIN
  v_before := current_setting('paperlume.service_role_least_privilege.snapshot', true);

  -- 3g. The snapshot: every public relation (identity, storage, RLS flags,
  -- and every grant but service_role's on the 21 changed relations),
  -- service_role's grants everywhere else in public, every relation ACL in
  -- every other schema, columns, constraints, indexes, policies, triggers,
  -- every function (whole rows in public, ACLs database-wide), public types,
  -- every default-privilege entry this file does not change and every other
  -- grantee inside the three it does, schemas, the database ACL, roles,
  -- memberships and event triggers. The failure names each category that
  -- moved.
  EXECUTE current_setting('paperlume.service_role_least_privilege.snapshot_sql', true) INTO v_after;
  SELECT string_agg(coalesce(b.cat, a.cat), ', ' ORDER BY coalesce(b.cat, a.cat)) INTO v_text
  FROM (SELECT split_part(l, '|', 1) AS cat, l FROM unnest(string_to_array(v_before, E'\n')) AS l) b
  FULL JOIN (SELECT split_part(l, '|', 1) AS cat, l FROM unnest(string_to_array(v_after, E'\n')) AS l) a USING (cat)
  WHERE b.l IS DISTINCT FROM a.l;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'service_role_least_privilege: something besides the reviewed privileges changed: %', v_text;
  END IF;

  SELECT count(*) INTO v_count FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
  IF v_count <> 43 THEN
    RAISE EXCEPTION 'service_role_least_privilege: public holds % functions afterwards; expected 43', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S');
  IF v_count <> 30 THEN
    RAISE EXCEPTION 'service_role_least_privilege: public holds % relations afterwards; expected 30', v_count;
  END IF;

  -- 3h. No existing relation in `public` was locked at all.
  SELECT coalesce(string_agg(DISTINCT l.relation::regclass::text || ' ' || l.mode, ', '), '') INTO v_text
  FROM pg_locks l
  WHERE l.locktype = 'relation' AND l.pid = pg_backend_pid()
    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND l.relation IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace);
  IF v_text <> '' THEN
    RAISE EXCEPTION 'service_role_least_privilege: this transaction holds a lock on a relation in public: %', v_text;
  END IF;

  -- 3i. This transaction wrote no row in public, auth or storage.
  v_before := current_setting('paperlume.service_role_least_privilege.xact_writes_at_start', true);
  IF coalesce(v_before, '') = '' THEN
    RAISE EXCEPTION 'service_role_least_privilege: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  SELECT string_agg(
           n.nspname || '.' || c.relname || '=' || (pg_stat_get_xact_tuples_inserted(c.oid)
                                                    + pg_stat_get_xact_tuples_updated(c.oid)
                                                    + pg_stat_get_xact_tuples_deleted(c.oid)),
           ' ' ORDER BY n.nspname, c.relname) INTO v_text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p');
  IF v_text IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'service_role_least_privilege: this transaction wrote application rows (row writes at start: %; now: %)', v_before, v_text;
  END IF;

  RAISE NOTICE 'service_role_least_privilege: converged from starting shape %',
    current_setting('paperlume.service_role_least_privilege.shape', true);
END
$still$;

COMMIT;
