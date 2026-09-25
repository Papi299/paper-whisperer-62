-- DB-JUNCTION-DML-GRANT-HARDENING-001 — the paper↔Project and paper↔Tag
-- assignment junctions become read-only to the browser.
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly one privilege statement:
--
--   REVOKE INSERT, DELETE ON TABLE public.paper_projects, public.paper_tags
--     FROM authenticated;
--
--   paper_projects  authenticated  SELECT, INSERT, DELETE  →  SELECT
--   paper_tags      authenticated  SELECT, INSERT, DELETE  →  SELECT
--
-- Nothing else moves: no other role, no other table, no policy, no RLS flag, no
-- function, no column, no default privilege, and no row.
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- Decision C38 (20260910212202) stated the Data API matrix in full but kept
-- `SELECT, INSERT, DELETE` on these two junctions, noting that the browser
-- already only READ them and that narrowing was out of that initiative's scope.
-- The follow-up audit for this change confirmed it across the whole
-- repository: every live assignment write — Edit Paper, AI-suggestion
-- acceptance, bulk actions, file/identifier import, extension import, resolved
-- duplicate imports, and duplicate merge — reaches the junctions only through a
-- SECURITY DEFINER RPC:
--
--   set_paper_projects(uuid,uuid[])        set_paper_tags(uuid,uuid[])
--   bulk_set_paper_projects(uuid[],uuid[]) bulk_set_paper_tags(uuid[],uuid[])
--   bulk_add_paper_projects(uuid[],uuid[]) bulk_add_paper_tags(uuid[],uuid[])
--   merge_exact_duplicates(uuid,uuid[])
--
-- So the direct INSERT/DELETE grants were an unused second write path. Its RLS
-- policies required both-owner semantics, so it could not cross accounts — but
-- it could bypass the RPCs' own contracts (all-or-nothing validation, NULL-id
-- refusal, replace-vs-add semantics), and least privilege says a capability no
-- product path uses should not be held. This is hardening, not an incident fix.
--
-- WHY THE RPCs KEEP WORKING
-- ─────────────────────────────────────────────────────────────────────────────
-- All seven routines above are SECURITY DEFINER and owned by `postgres`. A
-- SECURITY DEFINER function executes with its OWNER's privileges, so their
-- INSERT/DELETE on the junctions is checked against `postgres` — the tables'
-- owner, holding `arwdDxtm` — never against the calling `authenticated` role.
-- `authenticated` needs only EXECUTE on the function, which is unchanged. The
-- caller's identity still reaches the body as `auth.uid()` (a JWT claim, not
-- the session role), so every ownership check the bodies perform is unchanged.
-- Section 1 refuses to run unless each routine is still exactly that reviewed
-- shape, and section 3 re-proves the owner can still write both junctions.
--
-- The same holds for FK cascades. Deleting a Project, a Tag or a paper removes
-- its junction rows through `ON DELETE CASCADE`; PostgreSQL runs a referential
-- action as the owner of the REFERENCING table (`postgres`), so it never needed
-- `authenticated`'s DELETE on the junction and does not lose anything here.
--
-- WHAT IS DELIBERATELY UNCHANGED, AND PROVEN UNCHANGED
-- ─────────────────────────────────────────────────────────────────────────────
--   * `projects` and `tags` — the ENTITY tables. `authenticated` keeps
--     `SELECT, INSERT, UPDATE, DELETE` on both. Creating a Project or Tag —
--     including the AI suggestion flow's "Create & select", which inserts the
--     new row directly and then stages only its id for the paper's assignment —
--     is a normal browser write and must stay one. Their full ACLs are
--     snapshotted before the REVOKE and required to be byte-identical after it.
--   * Junction SELECT. The dashboard list, Project/Tag filtering, CSV/BibTeX
--     export and the full account export all read the junctions directly.
--   * The junction RLS policies — SELECT, INSERT and DELETE, each requiring that
--     both the paper and the referenced Project/Tag belong to `auth.uid()`. The
--     INSERT/DELETE policies become DORMANT: unreachable by any browser role,
--     because the object privilege now refuses first. They are kept on purpose
--     as defense-in-depth, so a future re-grant — accidental or deliberate —
--     lands on a both-owner boundary instead of an open table. Suite 002 proves
--     them by re-granting inside a rolled-back test transaction only.
--   * `service_role`, `postgres`, `anon` and PUBLIC. `service_role` is snapshot-
--     compared, not hardcoded: its posture is preserved, never converged (C38).
--   * RLS and FORCE RLS on all four tables; every column ACL; every function.
--
-- CONCURRENCY AND ROLLOUT
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration-only. No Edge Function or frontend deploy, and no ordering between
-- them: the shipped bundle issues no direct junction write, so no legitimate
-- in-flight request can lose a privilege it was using. A hand-written direct
-- junction INSERT/DELETE from a browser session fails with 42501 afterwards —
-- the intended outcome. No lock barrier is needed for the same reason C38 gave.
--
-- The file is explicitly transactional (see 20260910212202 for why
-- `supabase db reset` requires that): the preconditions, the REVOKE and the
-- verification commit together or not at all.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- Forward-fix preferred. If a product path turns out to need direct junction
-- writes after all, the reviewed restoration is exactly
--   GRANT INSERT, DELETE ON TABLE public.paper_projects, public.paper_tags TO authenticated;
-- which re-exposes only a both-owner-RLS-guarded path (the dormant policies
-- above are what make that safe). See docs/deployment.md §6.9.
--
-- Durable decision: C48 (follow-up to C38).

BEGIN;


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context, and this transaction's own write counters
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only the grantor can revoke a grant, and every client-role entry on these
-- tables was granted by `postgres`, which also owns them. Run as anything else,
-- the REVOKE below would be a silent no-op with a warning.
--
-- Section 3 proves this transaction wrote no row to the five tables this
-- change is about. It reads PostgreSQL's per-transaction statistics
-- (`pg_stat_get_xact_tuples_*`), which count only THIS backend's work, so live
-- assignment traffic committing concurrently can neither fail nor satisfy the
-- check — unlike any row-timestamp or row-count comparison. The baseline is
-- taken here, before anything changes, because a backend may still hold an
-- earlier transaction's unflushed counts (see 20260924193915 §0 for the full
-- argument); it lives in a transaction-local setting, so a runner that stripped
-- the BEGIN above loses it and section 3 fails closed.

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'junction_dml_hardening: must run as postgres (current_user is %) — only the grantor can revoke the authenticated grants',
      current_user;
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'junction_dml_hardening: track_counts is off, so the no-write self-check could not observe anything';
  END IF;

  PERFORM set_config(
    'paperlume.junction_dml.xact_writes_at_start',
    (SELECT string_agg(
              t || '=' || (pg_stat_get_xact_tuples_inserted(t::regclass)
                           + pg_stat_get_xact_tuples_updated(t::regclass)
                           + pg_stat_get_xact_tuples_deleted(t::regclass)),
              ' ' ORDER BY t)
       FROM unnest(ARRAY['public.paper_projects', 'public.paper_tags',
                         'public.papers', 'public.projects', 'public.tags']) AS t),
    true);
END
$ctx$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Preconditions — the exact state this change was reviewed against
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Verified read-only against Production on 2026-09-25 (ledger 87, latest
-- 20260924193915) and byte-identical on a clean local replay. Nothing here
-- repairs unexpected state: any mismatch rolls the whole file back before a
-- single privilege changes. The snapshots taken at the end of this block are
-- what section 3 compares against.

DO $pre$
DECLARE
  v_rel     TEXT;
  v_count   INTEGER;
  v_text    TEXT;
  v_all     CONSTANT TEXT[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
BEGIN
  -- ── 1a. Roles ────────────────────────────────────────────────────────────
  IF to_regrole('authenticated') IS NULL OR to_regrole('anon') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'junction_dml_hardening: one of the roles authenticated / anon / service_role does not exist';
  END IF;

  -- ── 1b. The four tables: one ordinary table each, owned by postgres, RLS on
  --        and forced ────────────────────────────────────────────────────────
  FOREACH v_rel IN ARRAY ARRAY['paper_projects', 'paper_tags', 'projects', 'tags'] LOOP
    SELECT count(*) INTO v_count
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_rel;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'junction_dml_hardening: % relation(s) named public.% — expected exactly one', v_count, v_rel;
    END IF;

    PERFORM 1
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_rel
      AND c.relkind = 'r'
      AND c.relowner = 'postgres'::regrole
      AND c.relrowsecurity
      AND c.relforcerowsecurity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'junction_dml_hardening: public.% is not an ordinary postgres-owned table with RLS enabled and forced', v_rel;
    END IF;
  END LOOP;

  -- ── 1c. The junctions' authenticated grant: SELECT, INSERT, DELETE — direct
  --        AND effective, with no grant option ───────────────────────────────
  FOREACH v_rel IN ARRAY ARRAY['public.paper_projects', 'public.paper_tags'] LOOP
    SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '') INTO v_text
    FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid = v_rel::regclass AND a.grantee = 'authenticated'::regrole;
    IF v_text <> 'DELETE,INSERT,SELECT' THEN
      RAISE EXCEPTION 'junction_dml_hardening: authenticated DIRECT privileges on % are [%]; reviewed pre-state is [DELETE,INSERT,SELECT]', v_rel, v_text;
    END IF;

    SELECT coalesce(string_agg(p, ',' ORDER BY p), '') INTO v_text
    FROM unnest(v_all) p WHERE has_table_privilege('authenticated', v_rel::regclass, p);
    IF v_text <> 'DELETE,INSERT,SELECT' THEN
      RAISE EXCEPTION 'junction_dml_hardening: authenticated EFFECTIVE privileges on % are [%]; reviewed pre-state is [DELETE,INSERT,SELECT] (no UPDATE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN)', v_rel, v_text;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
               WHERE c.oid = v_rel::regclass AND a.grantee = 'authenticated'::regrole AND a.is_grantable) THEN
      RAISE EXCEPTION 'junction_dml_hardening: authenticated holds a privilege on % WITH GRANT OPTION', v_rel;
    END IF;
  END LOOP;

  -- ── 1d. The entity tables' authenticated grant: the full user-mutable set ─
  -- This is what "Create & select" and the Projects/Tags management UI use. It
  -- is pinned here and snapshotted below so section 3 can prove the REVOKE on
  -- the junctions did not reach it.
  FOREACH v_rel IN ARRAY ARRAY['public.projects', 'public.tags'] LOOP
    SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '') INTO v_text
    FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid = v_rel::regclass AND a.grantee = 'authenticated'::regrole;
    IF v_text <> 'DELETE,INSERT,SELECT,UPDATE' THEN
      RAISE EXCEPTION 'junction_dml_hardening: authenticated DIRECT privileges on % are [%]; reviewed state is [DELETE,INSERT,SELECT,UPDATE]', v_rel, v_text;
    END IF;

    SELECT coalesce(string_agg(p, ',' ORDER BY p), '') INTO v_text
    FROM unnest(v_all) p WHERE has_table_privilege('authenticated', v_rel::regclass, p);
    IF v_text <> 'DELETE,INSERT,SELECT,UPDATE' THEN
      RAISE EXCEPTION 'junction_dml_hardening: authenticated EFFECTIVE privileges on % are [%]; reviewed state is [DELETE,INSERT,SELECT,UPDATE]', v_rel, v_text;
    END IF;
  END LOOP;

  -- ── 1e. anon and PUBLIC hold nothing on any of the four; no unknown grantee
  -- PUBLIC is grantee 0 in aclexplode. Only postgres, authenticated and
  -- service_role may appear at all.
  SELECT coalesce(string_agg(x.entry, ', ' ORDER BY x.entry), '') INTO v_text
  FROM (SELECT c.relname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
               || ':' || a.privilege_type AS entry
          FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         WHERE c.oid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass,
                         'public.projects'::regclass, 'public.tags'::regclass)
           AND a.grantee NOT IN ('postgres'::regrole, 'authenticated'::regrole, 'service_role'::regrole)) x;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'junction_dml_hardening: unexpected grantee(s) on the junction/entity tables: %', v_text;
  END IF;

  FOREACH v_rel IN ARRAY ARRAY['public.paper_projects', 'public.paper_tags', 'public.projects', 'public.tags'] LOOP
    SELECT coalesce(string_agg(p, ',' ORDER BY p), '') INTO v_text
    FROM unnest(v_all) p WHERE has_table_privilege('anon', v_rel::regclass, p);
    IF v_text <> '' THEN
      RAISE EXCEPTION 'junction_dml_hardening: anon holds EFFECTIVE privileges [%] on %', v_text, v_rel;
    END IF;
  END LOOP;

  -- ── 1f. No browser-role column-level grant on any of the four ─────────────
  -- A column-level INSERT grant would survive a table-level REVOKE and keep
  -- the write path open, so its absence is a precondition, not a nicety.
  SELECT coalesce(string_agg(x.entry, ', ' ORDER BY x.entry), '') INTO v_text
  FROM (SELECT c.relname || '.' || att.attname || ':' || a.privilege_type AS entry
          FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid, aclexplode(att.attacl) a
         WHERE att.attrelid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass,
                                'public.projects'::regclass, 'public.tags'::regclass)
           AND att.attacl IS NOT NULL
           AND a.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)) x;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'junction_dml_hardening: browser-role column-level grant(s) exist: %', v_text;
  END IF;

  -- ── 1g. The six junction policies are exactly the reviewed both-owner set ─
  -- Three per junction — SELECT, INSERT, DELETE — each requiring that BOTH the
  -- paper and the referenced Project/Tag belong to auth.uid(). The digest is
  -- md5 over name, command, permissiveness, roles and the deparsed USING /
  -- WITH CHECK of all six, ordered by table then policy name; it is identical
  -- in Production and on a clean replay (PostgreSQL 17.6). The readable checks
  -- after it say which fact is missing when the digest alone would not.
  SELECT count(*) INTO v_count FROM pg_policy
  WHERE polrelid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass);
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'junction_dml_hardening: % policies on the junctions; expected exactly 6', v_count;
  END IF;

  FOREACH v_rel IN ARRAY ARRAY['public.paper_projects', 'public.paper_tags'] LOOP
    SELECT string_agg(polcmd::text, '' ORDER BY polcmd::text) INTO v_text
    FROM pg_policy WHERE polrelid = v_rel::regclass;
    IF v_text <> 'adr' THEN   -- a = INSERT, d = DELETE, r = SELECT
      RAISE EXCEPTION 'junction_dml_hardening: policy commands on % are [%]; expected exactly one each of SELECT, INSERT, DELETE', v_rel, v_text;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_policy pol
    WHERE pol.polrelid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass)
      AND (NOT pol.polpermissive
           OR position('auth.uid()' IN coalesce(pg_get_expr(pol.polqual, pol.polrelid), pg_get_expr(pol.polwithcheck, pol.polrelid))) = 0
           OR position('FROM papers p' IN coalesce(pg_get_expr(pol.polqual, pol.polrelid), pg_get_expr(pol.polwithcheck, pol.polrelid))) = 0)
  ) THEN
    RAISE EXCEPTION 'junction_dml_hardening: a junction policy is restrictive or does not check paper ownership against auth.uid()';
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
       WHERE pol.polrelid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass))
     IS DISTINCT FROM '04b973b09f1aadcd8a5389b8899818b7' THEN
    RAISE EXCEPTION 'junction_dml_hardening: the junction RLS policies are not the reviewed both-owner definitions';
  END IF;

  -- ── 1h. The assignment write authority is exactly the reviewed RPC surface
  -- Seven routines, one overload each, each: owner postgres, SECURITY DEFINER,
  -- plpgsql, search_path=public, RETURNS void, the reviewed argument names and
  -- body (md5 of prosrc, byte-identical in Production), and EXECUTE held by the
  -- owner and authenticated ONLY — never anon, PUBLIC or service_role.
  SELECT coalesce(string_agg(e.sig, ', ' ORDER BY e.sig), '') INTO v_text
  FROM (VALUES
    ('public.set_paper_projects(uuid,uuid[])',        '{p_paper_id,p_project_ids}',  '8104be4a8a25bfbca45b0aab4393d110'),
    ('public.set_paper_tags(uuid,uuid[])',            '{p_paper_id,p_tag_ids}',      '8b0537b3964e5a1956a8d1e99bdaed82'),
    ('public.bulk_set_paper_projects(uuid[],uuid[])', '{p_paper_ids,p_project_ids}', 'a348cebfcf3b393af9aff1b5a77cd1a6'),
    ('public.bulk_set_paper_tags(uuid[],uuid[])',     '{p_paper_ids,p_tag_ids}',     'e3b6bcfec228d4cca4f52dc126765e32'),
    ('public.bulk_add_paper_projects(uuid[],uuid[])', '{p_paper_ids,p_project_ids}', '1d1c91251a099af644cb9d416637e1cc'),
    ('public.bulk_add_paper_tags(uuid[],uuid[])',     '{p_paper_ids,p_tag_ids}',     '01da7404df6f887252f724c649d11fba'),
    ('public.merge_exact_duplicates(uuid,uuid[])',    '{p_keep_id,p_discard_ids}',   'b43400b3cdc51b5572efe81a80acdfab')
  ) AS e(sig, argnames, body_md5)
  WHERE to_regprocedure(e.sig) IS NULL
     OR (SELECT count(*) FROM pg_proc p2
          WHERE p2.pronamespace = 'public'::regnamespace
            AND p2.proname = (SELECT proname FROM pg_proc WHERE oid = to_regprocedure(e.sig))) <> 1
     OR NOT EXISTS (
          SELECT 1 FROM pg_proc p
          WHERE p.oid = to_regprocedure(e.sig)
            AND p.proowner = 'postgres'::regrole
            AND p.prosecdef
            AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
            AND p.proconfig = ARRAY['search_path=public']
            AND NOT p.proretset
            AND pg_get_function_result(p.oid) = 'void'
            AND p.proargnames::text = e.argnames
            AND md5(p.prosrc) = e.body_md5)
     OR EXISTS (
          SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.oid = to_regprocedure(e.sig) AND a.privilege_type = 'EXECUTE'
            AND a.grantee NOT IN (p.proowner, 'authenticated'::regrole::oid))
     OR NOT has_function_privilege('authenticated', to_regprocedure(e.sig), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure(e.sig), 'EXECUTE')
     OR has_function_privilege('service_role', to_regprocedure(e.sig), 'EXECUTE');
  IF v_text <> '' THEN
    RAISE EXCEPTION 'junction_dml_hardening: assignment RPC(s) not in the reviewed shape (missing/overloaded, owner, SECURITY DEFINER, language, search_path, result, arguments, body digest or EXECUTE ACL): %', v_text;
  END IF;

  -- ── 1i. Snapshots of everything this migration must NOT change ────────────
  -- Transaction-local; read back in section 3.

  -- Every junction ACL entry that is NOT authenticated's (owner + service_role
  -- today), direct, with grantor and grant option.
  PERFORM set_config('paperlume.junction_dml.pre_non_auth_acl',
    (SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '')
       FROM (SELECT c.relname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                    || ':' || a.privilege_type || ':' || pg_get_userbyid(a.grantor) || ':' || a.is_grantable::text AS entry
               FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
              WHERE c.oid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass)
                AND a.grantee <> 'authenticated'::regrole) x), true);

  -- service_role on the junctions, DIRECT and EFFECTIVE, captured on its own so
  -- a failure names it. Production today: all eight, direct and effective.
  PERFORM set_config('paperlume.junction_dml.pre_service_role',
    (SELECT string_agg(v.rel || ' direct[' ||
              (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
                 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                WHERE c.oid = v.rel::regclass AND a.grantee = 'service_role'::regrole)
              || '] effective[' ||
              (SELECT coalesce(string_agg(p, ',' ORDER BY p), '')
                 FROM unnest(v_all) p WHERE has_table_privilege('service_role', v.rel::regclass, p))
              || ']', '; ' ORDER BY v.rel)
       FROM unnest(ARRAY['public.paper_projects', 'public.paper_tags']) AS v(rel)), true);

  -- The entity tables' WHOLE ACL — every grantee — as stored.
  PERFORM set_config('paperlume.junction_dml.pre_entity_acl',
    (SELECT string_agg(c.relname || '=' || coalesce(c.relacl::text, 'NULL'), '; ' ORDER BY c.relname)
       FROM pg_class c
      WHERE c.oid IN ('public.projects'::regclass, 'public.tags'::regclass)), true);

  -- RLS / FORCE RLS on all four.
  PERFORM set_config('paperlume.junction_dml.pre_rls',
    (SELECT string_agg(c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text, ',' ORDER BY c.relname)
       FROM pg_class c
      WHERE c.oid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass,
                      'public.projects'::regclass, 'public.tags'::regclass)), true);

  -- Every policy on all four tables (the entity tables' own policies included).
  PERFORM set_config('paperlume.junction_dml.pre_policies',
    (SELECT md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s',
                                  c.relname, pol.polname, pol.polcmd, pol.polpermissive,
                                  (SELECT string_agg(rr.rn, ',' ORDER BY rr.rn)
                                     FROM (SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END AS rn
                                             FROM unnest(pol.polroles) r) rr),
                                  coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>'),
                                  coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')),
                           E'\n' ORDER BY c.relname, pol.polname))
       FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
      WHERE pol.polrelid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass,
                             'public.projects'::regclass, 'public.tags'::regclass)), true);

  -- The seven routines, whole: identity, security shape, body and ACL.
  PERFORM set_config('paperlume.junction_dml.pre_rpcs',
    (SELECT string_agg(p.oid::regprocedure::text || '|' || pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|'
                       || coalesce(p.proconfig::text, 'NULL') || '|' || md5(p.prosrc) || '|' || coalesce(p.proacl::text, 'NULL'),
                       E'\n' ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('set_paper_projects', 'set_paper_tags', 'bulk_set_paper_projects', 'bulk_set_paper_tags',
                          'bulk_add_paper_projects', 'bulk_add_paper_tags', 'merge_exact_duplicates')), true);
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The change
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Named privileges, not REVOKE ALL: SELECT is still required by the dashboard,
-- filtering and export, and section 1 already proved `authenticated` holds
-- nothing on these tables beyond SELECT, INSERT and DELETE — so this statement
-- IS the complete intended delta, and nothing broader is needed to reach it.
-- `projects` and `tags` are deliberately not named.

REVOKE INSERT, DELETE ON TABLE public.paper_projects, public.paper_tags FROM authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed verification — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

DO $verify$
DECLARE
  v_rel   TEXT;
  v_priv  TEXT;
  v_text  TEXT;
  v_base  TEXT;
  v_all   CONSTANT TEXT[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
BEGIN
  -- ── 3a. Junctions: authenticated is SELECT-only, direct and effective ─────
  FOREACH v_rel IN ARRAY ARRAY['public.paper_projects', 'public.paper_tags'] LOOP
    SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '') INTO v_text
    FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid = v_rel::regclass AND a.grantee = 'authenticated'::regrole;
    IF v_text <> 'SELECT' THEN
      RAISE EXCEPTION 'junction_dml_hardening: authenticated DIRECT privileges on % are [%] after the change; expected [SELECT]', v_rel, v_text;
    END IF;

    -- Every privilege by name, so a failure says exactly which one is wrong.
    FOREACH v_priv IN ARRAY v_all LOOP
      IF has_table_privilege('authenticated', v_rel::regclass, v_priv) IS DISTINCT FROM (v_priv = 'SELECT') THEN
        RAISE EXCEPTION 'junction_dml_hardening: authenticated EFFECTIVE % on % is %; expected %',
          v_priv, v_rel, has_table_privilege('authenticated', v_rel::regclass, v_priv), (v_priv = 'SELECT');
      END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
               WHERE c.oid = v_rel::regclass AND a.grantee = 'authenticated'::regrole AND a.is_grantable) THEN
      RAISE EXCEPTION 'junction_dml_hardening: authenticated holds a privilege on % WITH GRANT OPTION', v_rel;
    END IF;

    -- The owner — the role every assignment RPC and every FK cascade writes
    -- as — can still read, insert and delete. Checked one privilege at a time:
    -- a comma list in has_table_privilege means "any of", not "all of".
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'DELETE'] LOOP
      IF NOT has_table_privilege('postgres', v_rel::regclass, v_priv) THEN
        RAISE EXCEPTION 'junction_dml_hardening: the owner lost % on %, which would break every assignment RPC', v_priv, v_rel;
      END IF;
    END LOOP;
  END LOOP;

  -- ── 3b. Nothing else on the junctions moved (owner + service_role entries)
  IF (SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '')
        FROM (SELECT c.relname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                     || ':' || a.privilege_type || ':' || pg_get_userbyid(a.grantor) || ':' || a.is_grantable::text AS entry
                FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
               WHERE c.oid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass)
                 AND a.grantee <> 'authenticated'::regrole) x)
     IS DISTINCT FROM current_setting('paperlume.junction_dml.pre_non_auth_acl', true) THEN
    RAISE EXCEPTION 'junction_dml_hardening: a junction ACL entry other than authenticated''s changed';
  END IF;

  SELECT string_agg(v.rel || ' direct[' ||
           (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
              FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             WHERE c.oid = v.rel::regclass AND a.grantee = 'service_role'::regrole)
           || '] effective[' ||
           (SELECT coalesce(string_agg(p, ',' ORDER BY p), '')
              FROM unnest(v_all) p WHERE has_table_privilege('service_role', v.rel::regclass, p))
           || ']', '; ' ORDER BY v.rel) INTO v_text
  FROM unnest(ARRAY['public.paper_projects', 'public.paper_tags']) AS v(rel);
  v_base := current_setting('paperlume.junction_dml.pre_service_role', true);
  IF coalesce(v_base, '') = '' OR v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'junction_dml_hardening: service_role junction privileges changed (before: %; after: %)', v_base, v_text;
  END IF;

  -- ── 3c. anon / PUBLIC / unknown grantees / column grants — still nothing ──
  SELECT coalesce(string_agg(x.entry, ', ' ORDER BY x.entry), '') INTO v_text
  FROM (SELECT c.relname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
               || ':' || a.privilege_type AS entry
          FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         WHERE c.oid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass,
                         'public.projects'::regclass, 'public.tags'::regclass)
           AND a.grantee NOT IN ('postgres'::regrole, 'authenticated'::regrole, 'service_role'::regrole)) x;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'junction_dml_hardening: unexpected grantee(s) after the change: %', v_text;
  END IF;

  FOREACH v_rel IN ARRAY ARRAY['public.paper_projects', 'public.paper_tags', 'public.projects', 'public.tags'] LOOP
    SELECT coalesce(string_agg(p, ',' ORDER BY p), '') INTO v_text
    FROM unnest(v_all) p WHERE has_table_privilege('anon', v_rel::regclass, p);
    IF v_text <> '' THEN
      RAISE EXCEPTION 'junction_dml_hardening: anon holds EFFECTIVE privileges [%] on % after the change', v_text, v_rel;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
    WHERE att.attrelid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass,
                           'public.projects'::regclass, 'public.tags'::regclass)
      AND att.attacl IS NOT NULL
      AND a.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)
  ) THEN
    RAISE EXCEPTION 'junction_dml_hardening: a browser-role column-level grant exists after the change';
  END IF;

  -- ── 3d. Projects and Tags are exactly as they were — still user-mutable ───
  IF (SELECT string_agg(c.relname || '=' || coalesce(c.relacl::text, 'NULL'), '; ' ORDER BY c.relname)
        FROM pg_class c WHERE c.oid IN ('public.projects'::regclass, 'public.tags'::regclass))
     IS DISTINCT FROM current_setting('paperlume.junction_dml.pre_entity_acl', true) THEN
    RAISE EXCEPTION 'junction_dml_hardening: the projects/tags ACL changed (before: %)',
      current_setting('paperlume.junction_dml.pre_entity_acl', true);
  END IF;

  FOREACH v_rel IN ARRAY ARRAY['public.projects', 'public.tags'] LOOP
    SELECT coalesce(string_agg(p, ',' ORDER BY p), '') INTO v_text
    FROM unnest(v_all) p WHERE has_table_privilege('authenticated', v_rel::regclass, p);
    IF v_text <> 'DELETE,INSERT,SELECT,UPDATE' THEN
      RAISE EXCEPTION 'junction_dml_hardening: authenticated EFFECTIVE privileges on % are [%]; Projects/Tags must stay [DELETE,INSERT,SELECT,UPDATE]', v_rel, v_text;
    END IF;
  END LOOP;

  -- ── 3e. RLS, FORCE RLS and every policy are unchanged ─────────────────────
  IF (SELECT string_agg(c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text, ',' ORDER BY c.relname)
        FROM pg_class c
       WHERE c.oid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass,
                       'public.projects'::regclass, 'public.tags'::regclass))
     IS DISTINCT FROM current_setting('paperlume.junction_dml.pre_rls', true)
     OR current_setting('paperlume.junction_dml.pre_rls', true)
        <> 'paper_projects:true:true,paper_tags:true:true,projects:true:true,tags:true:true' THEN
    RAISE EXCEPTION 'junction_dml_hardening: RLS / FORCE RLS changed on the junction or entity tables';
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
       WHERE pol.polrelid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass,
                              'public.projects'::regclass, 'public.tags'::regclass))
     IS DISTINCT FROM current_setting('paperlume.junction_dml.pre_policies', true) THEN
    RAISE EXCEPTION 'junction_dml_hardening: an RLS policy on the junction or entity tables changed';
  END IF;

  -- ── 3f. The seven write-authority routines are unchanged ──────────────────
  IF (SELECT string_agg(p.oid::regprocedure::text || '|' || pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|'
                        || coalesce(p.proconfig::text, 'NULL') || '|' || md5(p.prosrc) || '|' || coalesce(p.proacl::text, 'NULL'),
                        E'\n' ORDER BY p.oid::regprocedure::text)
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('set_paper_projects', 'set_paper_tags', 'bulk_set_paper_projects', 'bulk_set_paper_tags',
                           'bulk_add_paper_projects', 'bulk_add_paper_tags', 'merge_exact_duplicates'))
     IS DISTINCT FROM current_setting('paperlume.junction_dml.pre_rpcs', true) THEN
    RAISE EXCEPTION 'junction_dml_hardening: an assignment RPC''s identity, security shape, body or EXECUTE ACL changed';
  END IF;

  -- ── 3g. ACL-only: this transaction wrote no row ───────────────────────────
  -- Against the baseline section 0 took from this transaction's own statistics.
  v_base := current_setting('paperlume.junction_dml.xact_writes_at_start', true);
  IF coalesce(v_base, '') = '' THEN
    RAISE EXCEPTION 'junction_dml_hardening: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  SELECT string_agg(
           t || '=' || (pg_stat_get_xact_tuples_inserted(t::regclass)
                        + pg_stat_get_xact_tuples_updated(t::regclass)
                        + pg_stat_get_xact_tuples_deleted(t::regclass)),
           ' ' ORDER BY t) INTO v_text
  FROM unnest(ARRAY['public.paper_projects', 'public.paper_tags',
                    'public.papers', 'public.projects', 'public.tags']) AS t;
  IF v_text <> v_base THEN
    RAISE EXCEPTION 'junction_dml_hardening: this transaction wrote application rows (row writes at start: %; now: %)', v_base, v_text;
  END IF;
END
$verify$;

COMMIT;
