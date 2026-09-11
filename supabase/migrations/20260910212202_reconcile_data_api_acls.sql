-- DATA-API-ACL-RECONCILIATION-001 — complete the Data API client-role ACL matrix
-- for public relations and sequences.
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────────────────────────────────────────────────────────
-- `20260731162729_reconcile_data_api_grants.sql` made the Data API surface
-- REPRODUCIBLE on a clean replay, and it was deliberately additive: GRANT only,
-- no REVOKE. That was the right call for its own scope, and it is not rewritten
-- here. What it could not do is REMOVE anything, so on hosted Production the
-- privileges that predate the tracked chain are still standing:
--
--   * 17 of the 28 ordinary `public` tables still carry `anon=arwdDxtm` — every
--     privilege PostgreSQL defines — granted by a platform default, not by this
--     repository;
--   * `authenticated` carries the same blanket ACL on those 17, which is wider
--     than any policy on them exposes;
--   * `public.papers_insert_order_seq` carries `rwU` for `anon`.
--
-- A clean replay does not reproduce that, so no test in this repository could
-- see it. `20260904120000` converged exactly two tables (`papers`,
-- `paper_attachments`) because that feature's invariant required it. This
-- migration finishes the job for every remaining client-role privilege on the
-- Data API relation and sequence surface. Function EXECUTE is a different
-- surface and is deliberately not part of it (see SCOPE below).
--
-- WHY RLS IS NOT ALREADY THE ANSWER
-- ─────────────────────────────────────────────────────────────────────────────
-- For SELECT/INSERT/UPDATE/DELETE it very nearly is: every policy on these
-- tables requires `auth.uid() = user_id`, which is NULL in an anonymous session,
-- and three of them have no policy at all. No anonymous row exposure through the
-- Data API was demonstrated, and none is claimed here.
--
-- But **row-level security does not govern TRUNCATE, and it never has.** Policies
-- exist for SELECT, INSERT, UPDATE and DELETE; TRUNCATE is gated by the object
-- privilege alone. A role holding `TRUNCATE` on an RLS-enabled, RLS-FORCED table
-- it cannot read one row of can still empty it. `TRIGGER` is the same shape: it
-- lets a role attach a trigger to a table it does not own (and then not drop it,
-- because DROP TRIGGER requires ownership). `MAINTAIN` permits VACUUM/ANALYZE/
-- REINDEX/CLUSTER on someone else's table. `REFERENCES` is inert only for as long
-- as the client roles hold no CREATE anywhere.
--
-- None of that is reachable through PostgREST, which exposes no TRUNCATE verb and
-- no DDL. It is reachable by anything that can open a SQL session as one of these
-- roles. So this is a least-privilege and defense-in-depth defect with a latent
-- destructive capability behind it — not an active data-exposure incident, and it
-- should not be described as one.
--
-- SCOPE — WHAT THIS MIGRATION DOES AND DOES NOT TOUCH
-- ─────────────────────────────────────────────────────────────────────────────
-- Converged: `PUBLIC`, `anon`, `authenticated` — on every ordinary table in
-- `public` and on the one sequence.
--
-- Deliberately NOT touched, each its own separate question:
--   * `service_role` — table privileges, sequence privileges, AND its default
--     privileges. Its TABLE privileges were already aligned between hosted
--     Production and a clean replay; its sequence and default postures are
--     environment-dependent (hosted vs clean replay: `rwU` vs `wU` on the
--     sequence, ALL vs `Dxtm` on table defaults, `rwU` vs `w` on sequence
--     defaults). So this migration deliberately PRESERVES the exact
--     pre-migration `service_role` posture rather than converging or narrowing
--     it. It is the server boundary and it bypasses RLS; narrowing it would be a
--     new decision, taken without the evidence that would justify it. It is
--     deliberately REFERENCED by the preconditions (section 2) and the
--     verification (section 4), but it is not named in any privilege-mutating
--     GRANT, REVOKE or ALTER DEFAULT PRIVILEGES statement: section 2 accepts
--     only its recognised platform shapes and snapshots them, and section 4
--     proves the exact observed posture did not move.
--   * Function EXECUTE privileges and function default privileges. The
--     SECURITY DEFINER surface is already least-privilege and pinned by suite
--     003. The residual question is the five SECURITY INVOKER helpers that carry
--     PUBLIC EXECUTE, and it cannot be answered by revoking: PUBLIC EXECUTE on a
--     new function comes from PostgreSQL's built-in GLOBAL default, which
--     `ALTER DEFAULT PRIVILEGES ... IN SCHEMA public` cannot revoke (verified
--     locally). Removing it needs a global, cross-schema default change that
--     would also affect functions `postgres` creates in `extensions`, where the
--     installed extensions live. Out of scope; suite 015 adds a fail-closed
--     inventory guard so a NEW invoker function cannot inherit it unnoticed.
--   * `supabase_admin` default privileges — `postgres` is not a superuser and is
--     not a member of `supabase_admin`, so it has no authority to change them
--     (`permission denied to change default privileges`, verified locally). No
--     object in `public` is owned by `supabase_admin`.
--   * `paper_tags` / `paper_projects` keep the repository's established
--     SELECT/INSERT/DELETE contract even though today's browser only reads them.
--   * RLS, policies, FORCE-RLS flags, functions, triggers, columns, data.
--
-- TWO SUPPORTED STARTING HISTORIES
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration must converge BOTH, and section 2 refuses anything else:
--
--   H1 "hosted"   — Production as audited: `anon`/`authenticated` hold ALL on the
--                   17, the sequence is `rwU` for both, and `postgres`'s default
--                   privileges in `public` still grant ALL on TABLES and `rwU` on
--                   SEQUENCES to the three API roles.
--   H2 "narrowed" — a clean replay under the Supabase CLI's current behaviour,
--                   which is also what Supabase's own documented revoke produces:
--                   the four DML privileges are gone, `Dxtm` (TRUNCATE,
--                   REFERENCES, TRIGGER, MAINTAIN) remains, and sequences keep
--                   `w`. Supabase states this becomes the platform default for
--                   existing projects on 2026-10-30, with existing table grants
--                   retained — so Production may legitimately be in H2 by the
--                   time this is applied, and that must not fail the migration.
--
-- The default-privilege entries `postgres` holds in `public` are judged WHOLE,
-- every grantee included. Section 3e revokes by NAME, so a grantee it does not
-- name would pass straight through it and survive:
--
--                  TABLES                        SEQUENCES
--   postgres       all eight (the owner's own)   SELECT, UPDATE, USAGE
--   anon           H1: all eight | H2: Dxtm      H1: rwU | H2: UPDATE
--   authenticated  checked on its own, never inferred from anon — and anon and
--                  authenticated must BOTH be H1 or BOTH be H2, on tables and
--                  sequences alike
--   service_role   a recognised H1 or H2 shape per object type; not converged,
--                  so not tied to the client roles' history — snapshotted, and
--                  proven unchanged
--   PUBLIC         none (no audited history has a direct entry)
--   anyone else    none — refused before any change, never silently preserved
--
-- Existing objects and default privileges are classified separately: Supabase
-- keeps existing table grants, so after 2026-10-30 Production can hold H1
-- tables under H2 defaults, and each is accepted on its own terms.
--
-- Both converge to one end state, and section 4 asserts that end state rather
-- than either starting point.
--
-- WHY THE REVOKE NAMES THE ROLE
-- ─────────────────────────────────────────────────────────────────────────────
-- H1 and H2 do not disagree about one privilege; they disagree about the whole
-- ACL. `REVOKE SELECT, INSERT, UPDATE, DELETE` would converge H2 and leave `anon`
-- holding `Dxtm` on Production. Naming the ROLE removes whatever it was given, by
-- whichever default, and is idempotent across both histories. `authenticated` is
-- then re-granted its exact intended surface, restated in full so a revoke can
-- never take a live product capability with it.
--
-- WHY THERE IS NO CUTOVER BARRIER, AND NO WEB-FIRST ORDERING
-- ─────────────────────────────────────────────────────────────────────────────
-- `20260904120000` opened with a three-table lock barrier, and this migration
-- deliberately does not copy it. That barrier existed because the cutover removed
-- privileges the SHIPPED BROWSER BUNDLE WAS ACTIVELY USING, so a statement
-- permission-checked before the revoke could commit after it and slip past the
-- Storage fence. Nothing of that shape is true here. Every privilege removed
-- below is one of:
--
--   * a client-role privilege on a table whose RLS denies that role every row
--     anyway (no policy at all, or a policy the role can never satisfy), so no
--     in-flight statement using it can be doing legitimate work;
--   * a non-DML privilege (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) that no
--     application path in this repository exercises at all.
--
-- The DML surface `authenticated` actually uses is IDENTICAL before and after:
-- the re-GRANTs restate it. So there is no window in which a legitimate request
-- loses a privilege it had, no operator drain, no phase gate, no Edge deploy, and
-- no frontend-before-database ordering. A hand-written request that today returns
-- "0 rows affected" (RLS filtered it) will return `42501` instead, which is a
-- clearer answer to an operation that never succeeded. See deployment.md §6.5.
--
-- WHY THE FILE IS EXPLICITLY TRANSACTIONAL
-- ─────────────────────────────────────────────────────────────────────────────
-- `supabase start` sends a migration as one batch, which Postgres runs as an
-- implicit transaction; `supabase db reset` splits it and runs each statement in
-- AUTOCOMMIT. Under the latter a closing verification block does not mean
-- "produce the reviewed posture or refuse to commit" — it aborts with every
-- earlier statement already committed, which for this migration would mean
-- leaving `authenticated` revoked and not yet re-granted. The explicit
-- BEGIN/COMMIT makes both runners atomic. `20260904120000` is the only other
-- migration that does this, for the same reason.

BEGIN;


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only the grantor can revoke a grant. Every ACL entry on these objects was
-- granted by `postgres`, which is also the owner of all 28 tables, the sequence
-- and all 44 routines — and the role `supabase db push` acts as. Running as
-- anything else would make the REVOKEs below silently no-ops.

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'data-api-acl: must run as postgres (current_user is %) — every ACL entry on these objects was granted by postgres, and only the grantor can revoke it',
      current_user;
  END IF;
END
$ctx$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The intended matrix, as data
-- ═════════════════════════════════════════════════════════════════════════════
--
-- One registry, used by the preconditions AND by the final verification, so the
-- two can never drift apart. `grp` is the convergence group:
--
--   G1  the 17 tables carrying the legacy client-role ACL
--   G2  papers / paper_attachments — DML already converged by 20260904120000,
--       but `authenticated` still holds REFERENCES/TRIGGER/MAINTAIN there
--   G3  the 9 already-narrow tables — PUBLIC/anon swept defensively, and
--       `authenticated` deliberately NOT re-issued, because
--       `REVOKE ALL ... FROM authenticated` would take the column-level
--       `author_identities.preferred_name` grant with it (verified locally).

CREATE TEMP TABLE acl_target (
  relname    text PRIMARY KEY,
  grp        text NOT NULL CHECK (grp IN ('G1','G2','G3')),
  auth_privs text[] NOT NULL
) ON COMMIT DROP;

INSERT INTO acl_target (relname, grp, auth_privs) VALUES
  -- G1 — the legacy 17.
  ('filter_presets',             'G1', ARRAY['SELECT','INSERT','UPDATE','DELETE']),
  ('keyword_exclusion_pool',     'G1', ARRAY['SELECT','INSERT','DELETE']),
  ('keyword_pool',               'G1', ARRAY['SELECT','INSERT','DELETE']),
  ('paper_projects',             'G1', ARRAY['SELECT','INSERT','DELETE']),
  ('paper_tags',                 'G1', ARRAY['SELECT','INSERT','DELETE']),
  ('profiles',                   'G1', ARRAY['SELECT','INSERT','UPDATE']),
  ('projects',                   'G1', ARRAY['SELECT','INSERT','UPDATE','DELETE']),
  ('study_type_exclusion_pool',  'G1', ARRAY['SELECT','INSERT','DELETE']),
  ('study_type_pool',            'G1', ARRAY['SELECT','INSERT','UPDATE','DELETE']),
  ('subscription_events',        'G1', ARRAY[]::text[]),
  ('subscriptions',              'G1', ARRAY[]::text[]),
  ('synonym_pool',               'G1', ARRAY['SELECT','INSERT','UPDATE','DELETE']),
  ('tags',                       'G1', ARRAY['SELECT','INSERT','UPDATE','DELETE']),
  ('usage_counters',             'G1', ARRAY[]::text[]),
  ('usage_credits',              'G1', ARRAY['SELECT']),
  ('user_entitlements',          'G1', ARRAY['SELECT']),
  ('user_storage_usage',         'G1', ARRAY['SELECT']),
  -- G2 — the attachment-lifecycle pair.
  ('paper_attachments',          'G2', ARRAY['SELECT']),
  ('papers',                     'G2', ARRAY['SELECT','INSERT','UPDATE']),
  -- G3 — already narrow; PUBLIC/anon sweep only.
  ('ai_model_catalog',           'G3', ARRAY['SELECT']),
  ('attachment_cleanup_queue',   'G3', ARRAY['SELECT','DELETE']),
  ('attachment_cleanup_tombstone','G3', ARRAY[]::text[]),
  ('author_identities',          'G3', ARRAY['SELECT']),
  ('author_identity_aliases',    'G3', ARRAY['SELECT','INSERT','DELETE']),
  ('author_identity_links',      'G3', ARRAY['SELECT']),
  ('author_identity_merges',     'G3', ARRAY['SELECT']),
  ('internal_user_access',       'G3', ARRAY[]::text[]),
  ('user_ai_preferences',        'G3', ARRAY['SELECT']);


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Fail-closed preconditions, and the service-role snapshot
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Refuse an unexpected schema rather than mutating it. A table or sequence that
-- appeared between the audit and this migration is exactly the case that must
-- stop the run: its intended surface has never been reviewed.
--
-- The default-privilege check accepts H1 and H2 (see the header) and NOTHING
-- else, judged on the whole entry rather than on `anon` alone. It must not fail
-- merely because Supabase already performed, on its own schedule, a revoke this
-- repository also intends — but an unrecognised shape, an `authenticated` shape
-- that differs from `anon`'s history, a direct PUBLIC entry, any grantee outside
-- the reviewed four, or a GLOBAL default entry (which `IN SCHEMA public` could
-- not override) is a reason to stop and re-audit.

DO $pre$
DECLARE
  v_all      CONSTANT text[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
  v_nondml   CONSTANT text[] := ARRAY['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
  v_seq_all  CONSTANT text[] := ARRAY['SELECT','UPDATE','USAGE'];
  v_seq_upd  CONSTANT text[] := ARRAY['UPDATE'];
  v_anon     oid := to_regrole('anon');
  v_auth     oid := to_regrole('authenticated');
  v_svc      oid := to_regrole('service_role');
  v_pg       oid := to_regrole('postgres');
  r          record;
  v_txt      text;
  v_n        integer;
  v_anon_p   text[];
  v_auth_p   text[];
  v_hosted   boolean;
  v_def_pg_r   text[];
  v_def_anon_r text[];
  v_def_auth_r text[];
  v_def_svc_r  text[];
  v_def_pg_s   text[];
  v_def_anon_s text[];
  v_def_auth_s text[];
  v_def_svc_s  text[];
  v_hist_r     text;
  v_hist_s     text;
BEGIN
  IF v_anon IS NULL OR v_auth IS NULL OR v_svc IS NULL OR v_pg IS NULL THEN
    RAISE EXCEPTION 'data-api-acl: anon / authenticated / service_role / postgres must all exist';
  END IF;

  -- ── 2a. The relation inventory is exactly the audited one ──────────────────
  SELECT string_agg(c.relname, ',' ORDER BY c.relname) INTO v_txt
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r';
  IF v_txt IS DISTINCT FROM (SELECT string_agg(relname, ',' ORDER BY relname) FROM acl_target) THEN
    RAISE EXCEPTION
      'data-api-acl: the ordinary public table set is not the audited 28 — a table was added or removed, and its intended Data API surface has not been reviewed. Found: %', v_txt;
  END IF;

  -- Data-API-reachable relations that are NOT ordinary tables. There are none
  -- today; one appearing means a surface nobody classified.
  SELECT count(*), coalesce(string_agg(c.relname || ' (' || c.relkind::text || ')', ', ' ORDER BY c.relname), '')
    INTO v_n, v_txt
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('p','v','m','f');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'data-api-acl: unclassified Data API relation(s) in public: %', v_txt;
  END IF;

  -- Exactly one sequence, and it is the papers insert-order sequence.
  SELECT count(*), coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') INTO v_n, v_txt
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S';
  IF v_n <> 1 OR v_txt <> 'papers_insert_order_seq' THEN
    RAISE EXCEPTION 'data-api-acl: expected exactly one public sequence (papers_insert_order_seq), found: %', v_txt;
  END IF;

  -- ── 2b. Ownership — the REVOKEs only bite if postgres granted them ─────────
  SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') INTO v_txt
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','S') AND c.relowner <> v_pg;
  IF v_txt <> '' THEN
    RAISE EXCEPTION 'data-api-acl: not owned by postgres: %', v_txt;
  END IF;

  -- ── 2c. No grantee outside the four expected roles, and no direct PUBLIC ───
  -- PUBLIC is grantee 0 in aclexplode. `pg_get_userbyid(0)` returns the string
  -- 'unknown (OID=0)', never NULL, so a coalesce(...,'PUBLIC') idiom silently
  -- matches nothing — this asks for grantee = 0 directly.
  SELECT coalesce(string_agg(DISTINCT c.relname || ':' || a.grantee::text, ', '), '') INTO v_txt
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
   WHERE n.nspname = 'public' AND c.relkind IN ('r','S')
     AND a.grantee NOT IN (v_pg, v_anon, v_auth, v_svc);
  IF v_txt <> '' THEN
    RAISE EXCEPTION 'data-api-acl: unexpected grantee(s) — including PUBLIC (grantee 0) — on public relations: %', v_txt;
  END IF;

  -- ── 2d. Per-table client-role classification (H1 or H2, per table) ─────────
  FOR r IN SELECT t.relname, t.grp, t.auth_privs, c.oid
             FROM acl_target t
             JOIN pg_class c ON c.oid = ('public.' || quote_ident(t.relname))::regclass
            ORDER BY t.relname
  LOOP
    SELECT coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type), ARRAY[]::text[]) INTO v_anon_p
      FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid = r.oid), acldefault('r'::"char", v_pg))) a
     WHERE a.grantee = v_anon;
    SELECT coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type), ARRAY[]::text[]) INTO v_auth_p
      FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid = r.oid), acldefault('r'::"char", v_pg))) a
     WHERE a.grantee = v_auth;

    IF r.grp = 'G1' THEN
      -- H1: anon and authenticated both hold everything.
      -- H2: anon holds the non-DML residue; authenticated holds its intended
      --     surface plus that same residue.
      v_hosted := (v_anon_p @> v_all AND v_anon_p <@ v_all);
      IF v_hosted THEN
        IF NOT (v_auth_p @> v_all AND v_auth_p <@ v_all) THEN
          RAISE EXCEPTION 'data-api-acl: %: anon holds the hosted legacy ACL but authenticated does not (found %)', r.relname, v_auth_p;
        END IF;
      ELSIF (v_anon_p @> v_nondml AND v_anon_p <@ v_nondml) THEN
        IF NOT (v_auth_p @> (r.auth_privs || v_nondml) AND v_auth_p <@ (r.auth_privs || v_nondml)) THEN
          RAISE EXCEPTION 'data-api-acl: %: clean-replay shape expected authenticated = intended + non-DML residue, found %', r.relname, v_auth_p;
        END IF;
      ELSE
        RAISE EXCEPTION 'data-api-acl: %: anon ACL matches neither supported starting history (found %)', r.relname, v_anon_p;
      END IF;

    ELSIF r.grp = 'G2' THEN
      -- Converged by 20260904120000 in both histories: anon holds nothing and
      -- authenticated holds its DML surface plus the non-DML residue.
      IF array_length(v_anon_p, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'data-api-acl: %: anon must already hold nothing here (found %)', r.relname, v_anon_p;
      END IF;
      IF NOT (v_auth_p @> (r.auth_privs || ARRAY['REFERENCES','TRIGGER','MAINTAIN'])
              AND v_auth_p <@ (r.auth_privs || ARRAY['REFERENCES','TRIGGER','MAINTAIN'])) THEN
        RAISE EXCEPTION 'data-api-acl: %: expected authenticated = intended + REFERENCES/TRIGGER/MAINTAIN, found %', r.relname, v_auth_p;
      END IF;

    ELSE
      -- G3 — already exactly right, in both histories.
      IF array_length(v_anon_p, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'data-api-acl: %: anon must already hold nothing here (found %)', r.relname, v_anon_p;
      END IF;
      IF NOT (v_auth_p @> r.auth_privs AND v_auth_p <@ r.auth_privs) THEN
        RAISE EXCEPTION 'data-api-acl: %: authenticated is not the intended set (expected %, found %)', r.relname, r.auth_privs, v_auth_p;
      END IF;
    END IF;
  END LOOP;

  -- ── 2e. The one column-level grant ─────────────────────────────────────────
  SELECT coalesce(string_agg(c.relname || '.' || att.attname || ':' || a.grantee::regrole::text || ':' || a.privilege_type, ', '
                             ORDER BY c.relname, att.attname, a.privilege_type), '')
    INTO v_txt
    FROM pg_attribute att
    JOIN pg_class c ON c.oid = att.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(att.attacl) a
   WHERE n.nspname = 'public' AND att.attacl IS NOT NULL;
  IF v_txt <> 'author_identities.preferred_name:authenticated:UPDATE' THEN
    RAISE EXCEPTION 'data-api-acl: unexpected column-level ACL inventory: [%]', v_txt;
  END IF;

  -- ── 2f. The sequence, in either history ───────────────────────────────────
  SELECT coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type), ARRAY[]::text[]) INTO v_anon_p
    FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('s'::"char", c.relowner))) a
   WHERE c.oid = 'public.papers_insert_order_seq'::regclass AND a.grantee = v_anon;
  SELECT coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type), ARRAY[]::text[]) INTO v_auth_p
    FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('s'::"char", c.relowner))) a
   WHERE c.oid = 'public.papers_insert_order_seq'::regclass AND a.grantee = v_auth;
  IF (v_anon_p @> v_seq_all AND v_anon_p <@ v_seq_all) THEN
    IF NOT (v_auth_p @> v_seq_all AND v_auth_p <@ v_seq_all) THEN
      RAISE EXCEPTION 'data-api-acl: sequence: anon holds the hosted ACL but authenticated holds %', v_auth_p;
    END IF;
  ELSIF (v_anon_p @> ARRAY['UPDATE'] AND v_anon_p <@ ARRAY['UPDATE']) THEN
    IF NOT (v_auth_p @> ARRAY['UPDATE','USAGE'] AND v_auth_p <@ ARRAY['UPDATE','USAGE']) THEN
      RAISE EXCEPTION 'data-api-acl: sequence: clean-replay shape expected authenticated = UPDATE+USAGE, found %', v_auth_p;
    END IF;
  ELSE
    RAISE EXCEPTION 'data-api-acl: sequence: anon ACL matches neither supported starting history (found %)', v_anon_p;
  END IF;

  -- ── 2g. postgres default privileges in public — the WHOLE entry ───────────
  -- Section 3e revokes by name from PUBLIC, anon and authenticated, so a grantee
  -- it does not name would survive it untouched, and a client-role shape nobody
  -- audited would be silently normalized. Every grantee is validated here,
  -- before anything changes — see the table in the header.

  -- A GLOBAL default-privilege entry cannot be revoked by an `IN SCHEMA public`
  -- statement, so one would make section 3e's hardening silently incomplete.
  SELECT count(*) INTO v_n
    FROM pg_default_acl d
   WHERE d.defaclnamespace = 0 AND d.defaclrole = v_pg AND d.defaclobjtype IN ('r','S');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'data-api-acl: postgres holds GLOBAL default privileges on tables/sequences; `IN SCHEMA public` could not override them';
  END IF;

  -- No grantee outside the reviewed four, and no direct PUBLIC entry. No audited
  -- history has either, and section 3e would leave a third party in place.
  SELECT coalesce(string_agg(DISTINCT d.defaclobjtype::text || ':' ||
                             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', '), '')
    INTO v_txt
    FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
   WHERE n.nspname = 'public' AND d.defaclrole = v_pg AND d.defaclobjtype IN ('r','S')
     AND a.grantee NOT IN (v_pg, v_anon, v_auth, v_svc);
  IF v_txt <> '' THEN
    RAISE EXCEPTION
      'data-api-acl: unexpected default-privilege grantee(s) on postgres/public tables or sequences: % — no audited history has one, and section 3e would leave it in place',
      v_txt;
  END IF;

  -- Each reviewed grantee's shape, per object type. A missing entry reads as
  -- empty and so matches no history.
  SELECT coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type) FILTER (WHERE a.grantee = v_pg),   ARRAY[]::text[]),
         coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type) FILTER (WHERE a.grantee = v_anon), ARRAY[]::text[]),
         coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type) FILTER (WHERE a.grantee = v_auth), ARRAY[]::text[]),
         coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type) FILTER (WHERE a.grantee = v_svc),  ARRAY[]::text[])
    INTO v_def_pg_r, v_def_anon_r, v_def_auth_r, v_def_svc_r
    FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
   WHERE n.nspname = 'public' AND d.defaclrole = v_pg AND d.defaclobjtype = 'r';

  SELECT coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type) FILTER (WHERE a.grantee = v_pg),   ARRAY[]::text[]),
         coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type) FILTER (WHERE a.grantee = v_anon), ARRAY[]::text[]),
         coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type) FILTER (WHERE a.grantee = v_auth), ARRAY[]::text[]),
         coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type) FILTER (WHERE a.grantee = v_svc),  ARRAY[]::text[])
    INTO v_def_pg_s, v_def_anon_s, v_def_auth_s, v_def_svc_s
    FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
   WHERE n.nspname = 'public' AND d.defaclrole = v_pg AND d.defaclobjtype = 'S';

  -- The owner's own entry is the same in both histories.
  IF NOT (v_def_pg_r @> v_all AND v_def_pg_r <@ v_all)
     OR NOT (v_def_pg_s @> v_seq_all AND v_def_pg_s <@ v_seq_all) THEN
    RAISE EXCEPTION 'data-api-acl: postgres''s own default entry in public is not the audited owner set (tables %, sequences %)',
      v_def_pg_r, v_def_pg_s;
  END IF;

  -- anon AND authenticated, each checked on its own: both H1 or both H2, on
  -- tables and sequences alike. authenticated is never inferred from anon.
  v_hist_r := CASE
    WHEN (v_def_anon_r @> v_all    AND v_def_anon_r <@ v_all)    AND (v_def_auth_r @> v_all    AND v_def_auth_r <@ v_all)    THEN 'H1'
    WHEN (v_def_anon_r @> v_nondml AND v_def_anon_r <@ v_nondml) AND (v_def_auth_r @> v_nondml AND v_def_auth_r <@ v_nondml) THEN 'H2'
  END;
  v_hist_s := CASE
    WHEN (v_def_anon_s @> v_seq_all AND v_def_anon_s <@ v_seq_all) AND (v_def_auth_s @> v_seq_all AND v_def_auth_s <@ v_seq_all) THEN 'H1'
    WHEN (v_def_anon_s @> v_seq_upd AND v_def_anon_s <@ v_seq_upd) AND (v_def_auth_s @> v_seq_upd AND v_def_auth_s <@ v_seq_upd) THEN 'H2'
  END;
  IF v_hist_r IS NULL OR v_hist_s IS NULL OR v_hist_r <> v_hist_s THEN
    RAISE EXCEPTION
      'data-api-acl: postgres/public client-role default privileges match neither audited starting history as a whole (tables: anon %, authenticated %; sequences: anon %, authenticated %)',
      v_def_anon_r, v_def_auth_r, v_def_anon_s, v_def_auth_s;
  END IF;

  -- service_role is preserved, not converged, so it is not tied to the client
  -- roles' history — but it must be a shape the platform is known to produce.
  -- Section 4 then proves this exact observed shape is what remains.
  IF NOT ((v_def_svc_r @> v_all AND v_def_svc_r <@ v_all) OR (v_def_svc_r @> v_nondml AND v_def_svc_r <@ v_nondml))
     OR NOT ((v_def_svc_s @> v_seq_all AND v_def_svc_s <@ v_seq_all) OR (v_def_svc_s @> v_seq_upd AND v_def_svc_s <@ v_seq_upd)) THEN
    RAISE EXCEPTION 'data-api-acl: service_role''s postgres/public default privileges are not a recognised platform shape (tables %, sequences %)',
      v_def_svc_r, v_def_svc_s;
  END IF;

  -- ── 2h. Snapshots of everything this migration must NOT change ────────────
  -- Transaction-local settings, read back in section 4. service_role is the
  -- important one: the proof that it did not move is a comparison against its
  -- own pre-state, never against a hardcoded narrower target.
  PERFORM set_config('paperlume.acl_pre_service_role',
    (SELECT coalesce(md5(string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type)), '')
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
            aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','S') AND a.grantee = v_svc), true);

  PERFORM set_config('paperlume.acl_pre_service_role_n',
    (SELECT count(*)::text
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
            aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','S') AND a.grantee = v_svc), true);

  PERFORM set_config('paperlume.acl_pre_defaults_kept',
    (SELECT coalesce(md5(string_agg(pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text || ':' ||
                                    a.grantee::text || ':' || a.privilege_type, ','
                                    ORDER BY pg_get_userbyid(d.defaclrole), d.defaclobjtype::text, a.grantee::text, a.privilege_type)), '')
       FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
      WHERE (n.nspname = 'public' OR d.defaclnamespace = 0)
        AND (d.defaclrole <> v_pg                        -- supabase_admin's defaults
             OR d.defaclobjtype = 'f'                    -- function defaults
             OR a.grantee IN (v_svc, v_pg))), true);     -- service_role's, and the owner's own
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3a. G1 — the 17 tables carrying the legacy client-role ACL
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Revoked BY ROLE, then `authenticated` re-granted its exact surface. The three
-- server-only tables (`usage_counters`, `subscriptions`, `subscription_events`)
-- get no re-grant at all: they have no client policy of any kind, so every
-- privilege the client roles hold on them is unreachable by design and merely
-- widens what a leaked client credential could touch.

REVOKE ALL ON TABLE
  public.filter_presets,
  public.keyword_exclusion_pool,
  public.keyword_pool,
  public.paper_projects,
  public.paper_tags,
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
  FROM PUBLIC, anon, authenticated;

-- Fully user-mutable entities (SELECT/INSERT/UPDATE/DELETE policies).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.projects,
  public.tags,
  public.filter_presets,
  public.study_type_pool,
  public.synonym_pool
  TO authenticated;

-- `profiles` is user-owned but never client-deleted: its row lifecycle follows
-- auth.users through ON DELETE CASCADE, and it has no DELETE policy. The
-- Settings screen upserts (INSERT + ON CONFLICT DO UPDATE) and updates.
GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;

-- Append/remove relations and pools: rows are added and removed, never edited in
-- place, and none of them has an UPDATE policy.
GRANT SELECT, INSERT, DELETE ON TABLE
  public.keyword_pool,
  public.keyword_exclusion_pool,
  public.study_type_exclusion_pool,
  public.paper_tags,
  public.paper_projects
  TO authenticated;

-- Read-only server-maintained projections (SELECT policy only; every write is a
-- SECURITY DEFINER RPC or the service role).
GRANT SELECT ON TABLE
  public.user_entitlements,
  public.usage_credits,
  public.user_storage_usage
  TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3b. G2 — papers and paper_attachments
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `20260904120000` converged the DML here and named `anon`/`PUBLIC` by role, but
-- it revoked from `authenticated` by privilege name — correctly, for the
-- privileges that feature was about. What it did not name, `authenticated` still
-- holds: REFERENCES, TRIGGER and MAINTAIN. TRIGGER is the one that matters —
-- it lets a signed-in client attach a trigger to `papers` and then not remove it.
-- The DML sets are restated exactly as that migration left them, so nothing
-- about the attachment lifecycle changes.

REVOKE ALL ON TABLE public.papers, public.paper_attachments FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.papers TO authenticated;
GRANT SELECT ON TABLE public.paper_attachments TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3c. G3 — the nine already-narrow tables
-- ═════════════════════════════════════════════════════════════════════════════
--
-- These were created after the repository adopted REVOKE-first, so their client
-- surface is already exact and `authenticated` is deliberately NOT touched:
-- `REVOKE ALL ... FROM authenticated` on `author_identities` would also drop the
-- column-level `UPDATE (preferred_name)` grant, which a table-level re-GRANT
-- cannot restore. The PUBLIC/anon sweep is defensive and idempotent — it is a
-- no-op today, and it means the end state is uniform across all 28 tables rather
-- than true for 19 of them and merely believed for the rest.

REVOKE ALL ON TABLE
  public.ai_model_catalog,
  public.attachment_cleanup_queue,
  public.attachment_cleanup_tombstone,
  public.author_identities,
  public.author_identity_aliases,
  public.author_identity_links,
  public.author_identity_merges,
  public.internal_user_access,
  public.user_ai_preferences
  FROM PUBLIC, anon;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3d. The sequence
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `papers_insert_order_seq` backs `papers.insert_order`. A direct client INSERT
-- into `papers` evaluates its `nextval()` default, and USAGE is the minimum
-- privilege for that. SELECT (currval / reading the sequence) and UPDATE are not
-- needed — and UPDATE is what permits `setval()`, i.e. rewriting the library's
-- insert ordering. `service_role` is deliberately absent from the REVOKE and
-- GRANT below: its posture here is environment-dependent (`rwU` on Production,
-- `wU` on a clean replay), it is preserved exactly, and narrowing it belongs to
-- the separate service-role question.

REVOKE ALL ON SEQUENCE public.papers_insert_order_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.papers_insert_order_seq TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3e. D1a — future objects created by postgres in public
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Everything above is about objects that exist. This is about the next one.
--
-- In BOTH histories a new table arrives already granted to the client roles —
-- everything on Production today, the non-DML residue on a clean replay — so an
-- author who creates a table and forgets its ACLs ships a reachable table. These
-- two statements make the omission fail CLOSED instead: a new table, view or
-- sequence created by `postgres` in `public` reaches no client role until a
-- migration says so.
--
-- This does NOT replace the repository's REVOKE-first rule (D2). D1a covers only
-- objects created by `postgres`, only in `public`, and only tables and sequences;
-- it cannot cover functions (see the header), and a project-level setting could
-- re-grant these defaults at any time. Every migration still states its own
-- surface explicitly, and suite 015 fails on any relation that does not.
--
-- Compatibility with Supabase's own rollout: their documented statements revoke
-- SELECT/INSERT/UPDATE/DELETE on tables and USAGE/SELECT on sequences from the
-- three API roles. Those are REVOKEs, and a REVOKE cannot restore a privilege, so
-- running them after these lines — which is what 2026-10-30 does — cannot undo
-- anything here. The reverse is also handled: if Supabase has already run them,
-- section 2g accepts that shape and these statements simply remove the remainder.
-- `service_role` is absent from both ALTER DEFAULT PRIVILEGES statements below,
-- so its default privileges are left exactly as the platform maintains them.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Fail-closed self-verification
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Produce the reviewed posture or refuse to commit. Every claim this migration
-- makes is asserted here, over the live catalog, for BOTH the direct ACL and the
-- effective privilege — they are not the same question, and only the second one
-- notices a privilege inherited through PUBLIC.

DO $verify$
DECLARE
  v_all    CONSTANT text[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
  v_anon   oid := to_regrole('anon');
  v_auth   oid := to_regrole('authenticated');
  v_svc    oid := to_regrole('service_role');
  v_pg     oid := to_regrole('postgres');
  r        record;
  v_txt    text;
  v_n      integer;
  v_privs  text[];
  v_probe  regclass;
  v_obj    text;
BEGIN
  -- ── 4a. PUBLIC and anon reach nothing, directly or effectively ────────────
  FOR r IN SELECT c.oid, c.relname, c.relkind
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
            ORDER BY c.relname
  LOOP
    SELECT coalesce(string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.privilege_type), '')
      INTO v_txt
      FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid = r.oid),
                               acldefault(CASE WHEN r.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, v_pg))) a
     WHERE a.grantee IN (0, v_anon);
    IF v_txt <> '' THEN
      RAISE EXCEPTION 'data-api-acl: % still carries a direct PUBLIC/anon privilege: %', r.relname, v_txt;
    END IF;

    IF r.relkind = 'S' THEN
      IF has_sequence_privilege(v_anon, r.oid, 'USAGE')
         OR has_sequence_privilege(v_anon, r.oid, 'SELECT')
         OR has_sequence_privilege(v_anon, r.oid, 'UPDATE') THEN
        RAISE EXCEPTION 'data-api-acl: anon retains an effective privilege on sequence %', r.relname;
      END IF;
    ELSE
      SELECT coalesce(string_agg(p, ',' ORDER BY p), '') INTO v_txt
        FROM unnest(v_all) p WHERE has_table_privilege(v_anon, r.oid, p);
      IF v_txt <> '' THEN
        RAISE EXCEPTION 'data-api-acl: anon retains effective privilege(s) on %: %', r.relname, v_txt;
      END IF;
    END IF;
  END LOOP;

  -- ...and no role outside the owner, authenticated and service_role holds
  -- anything on a public relation or sequence. An allowlist, not a list of the
  -- roles section 3 named, for the same reason as 4f.
  SELECT coalesce(string_agg(DISTINCT c.relname || ':' ||
                             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', '), '')
    INTO v_txt
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
     AND a.grantee NOT IN (v_pg, v_auth, v_svc);
  IF v_txt <> '' THEN
    RAISE EXCEPTION 'data-api-acl: a role other than the owner, authenticated and service_role holds a privilege on a public relation or sequence: %', v_txt;
  END IF;

  -- ── 4b. authenticated holds exactly the intended matrix ───────────────────
  FOR r IN SELECT t.relname, t.auth_privs, c.oid
             FROM acl_target t
             JOIN pg_class c ON c.oid = ('public.' || quote_ident(t.relname))::regclass
            ORDER BY t.relname
  LOOP
    SELECT coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type), ARRAY[]::text[]) INTO v_privs
      FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid = r.oid), acldefault('r'::"char", v_pg))) a
     WHERE a.grantee = v_auth;
    IF NOT (v_privs @> r.auth_privs AND v_privs <@ r.auth_privs) THEN
      RAISE EXCEPTION 'data-api-acl: %: authenticated DIRECT privileges are % but the intended set is %',
        r.relname, v_privs, r.auth_privs;
    END IF;

    SELECT coalesce(array_agg(p ORDER BY p), ARRAY[]::text[]) INTO v_privs
      FROM unnest(v_all) p WHERE has_table_privilege(v_auth, r.oid, p);
    IF NOT (v_privs @> r.auth_privs AND v_privs <@ r.auth_privs) THEN
      RAISE EXCEPTION 'data-api-acl: %: authenticated EFFECTIVE privileges are % but the intended set is %',
        r.relname, v_privs, r.auth_privs;
    END IF;
  END LOOP;

  -- ── 4c. The one column grant survived, and gained no company ──────────────
  SELECT coalesce(string_agg(c.relname || '.' || att.attname || ':' || a.grantee::regrole::text || ':' || a.privilege_type, ', '
                             ORDER BY c.relname, att.attname, a.privilege_type), '')
    INTO v_txt
    FROM pg_attribute att
    JOIN pg_class c ON c.oid = att.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(att.attacl) a
   WHERE n.nspname = 'public' AND att.attacl IS NOT NULL;
  IF v_txt <> 'author_identities.preferred_name:authenticated:UPDATE' THEN
    RAISE EXCEPTION 'data-api-acl: the column-level ACL inventory is now [%]', v_txt;
  END IF;
  IF NOT has_column_privilege(v_auth, 'public.author_identities'::regclass, 'preferred_name', 'UPDATE') THEN
    RAISE EXCEPTION 'data-api-acl: authenticated lost UPDATE (preferred_name) on author_identities';
  END IF;
  IF has_column_privilege(v_auth, 'public.author_identities'::regclass, 'user_id', 'UPDATE') THEN
    RAISE EXCEPTION 'data-api-acl: authenticated can UPDATE author_identities.user_id — the column grant is not narrow';
  END IF;

  -- ── 4d. The sequence ──────────────────────────────────────────────────────
  SELECT coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type), ARRAY[]::text[]) INTO v_privs
    FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('s'::"char", c.relowner))) a
   WHERE c.oid = 'public.papers_insert_order_seq'::regclass AND a.grantee = v_auth;
  IF NOT (v_privs @> ARRAY['USAGE'] AND v_privs <@ ARRAY['USAGE']) THEN
    RAISE EXCEPTION 'data-api-acl: sequence: authenticated holds % but must hold USAGE only', v_privs;
  END IF;
  IF NOT has_sequence_privilege(v_auth, 'public.papers_insert_order_seq'::regclass, 'USAGE') THEN
    RAISE EXCEPTION 'data-api-acl: sequence: authenticated lost USAGE — direct paper INSERT would fail';
  END IF;
  IF has_sequence_privilege(v_auth, 'public.papers_insert_order_seq'::regclass, 'UPDATE') THEN
    RAISE EXCEPTION 'data-api-acl: sequence: authenticated retains UPDATE (setval)';
  END IF;

  -- ── 4e. service_role did not move ─────────────────────────────────────────
  SELECT coalesce(md5(string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type)), ''),
         count(*)
    INTO v_txt, v_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
   WHERE n.nspname = 'public' AND c.relkind IN ('r','S') AND a.grantee = v_svc;
  IF v_txt <> current_setting('paperlume.acl_pre_service_role')
     OR v_n::text <> current_setting('paperlume.acl_pre_service_role_n') THEN
    RAISE EXCEPTION 'data-api-acl: service_role relation privileges changed (digest %/% vs pre %/%) — this migration must not touch them',
      v_txt, v_n, current_setting('paperlume.acl_pre_service_role'), current_setting('paperlume.acl_pre_service_role_n');
  END IF;

  -- ── 4f. Default privileges: only the owner and service_role remain ───────
  -- An ALLOWLIST over the whole entry, not a check of the three roles section 3e
  -- named: a grantee nobody named is exactly what a name-list check would miss.
  SELECT coalesce(string_agg(d.defaclobjtype::text || ':' ||
                             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ', '
                             ORDER BY d.defaclobjtype::text, a.grantee::text, a.privilege_type), '')
    INTO v_txt
    FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
   WHERE n.nspname = 'public' AND d.defaclrole = v_pg AND d.defaclobjtype IN ('r','S')
     AND a.grantee NOT IN (v_pg, v_svc);
  IF v_txt <> '' THEN
    RAISE EXCEPTION 'data-api-acl: postgres/public table/sequence defaults still grant a role other than the owner and service_role: %', v_txt;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_default_acl d
   WHERE d.defaclnamespace = 0 AND d.defaclrole = v_pg AND d.defaclobjtype IN ('r','S');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'data-api-acl: postgres now holds GLOBAL table/sequence default privileges';
  END IF;

  -- service_role's exact observed defaults, the owner's own entry, function
  -- defaults and supabase_admin's defaults: all equal to the section-2 snapshot.
  SELECT coalesce(md5(string_agg(pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text || ':' ||
                                 a.grantee::text || ':' || a.privilege_type, ','
                                 ORDER BY pg_get_userbyid(d.defaclrole), d.defaclobjtype::text, a.grantee::text, a.privilege_type)), '')
    INTO v_txt
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
   WHERE (n.nspname = 'public' OR d.defaclnamespace = 0)
     AND (d.defaclrole <> v_pg OR d.defaclobjtype = 'f' OR a.grantee IN (v_svc, v_pg));
  IF v_txt <> current_setting('paperlume.acl_pre_defaults_kept') THEN
    RAISE EXCEPTION 'data-api-acl: default privileges outside this migration''s scope changed (service_role, the owner''s own entry, function or supabase_admin defaults)';
  END IF;

  -- ── 4g. D1a proved on a real object, not only in the catalog ──────────────
  -- The catalog check above reads the stored default ACL. This creates the kind
  -- of object the next migration will create and asks what it actually inherited
  -- — which is the only way to be sure no other default-privilege entry applies.
  -- Anything granted to a role other than the owner and service_role fails it.
  -- Both objects are dropped again before this block ends; the transaction
  -- commits with the schema exactly as section 2 found it.
  CREATE TABLE public._acl_d1a_probe_tbl (id bigserial PRIMARY KEY);
  CREATE VIEW public._acl_d1a_probe_view AS SELECT 1 AS one;

  FOREACH v_obj IN ARRAY ARRAY['public._acl_d1a_probe_tbl', 'public._acl_d1a_probe_view', 'public._acl_d1a_probe_tbl_id_seq']
  LOOP
    v_probe := v_obj::regclass;
    SELECT coalesce(string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ','
                               ORDER BY a.grantee::text, a.privilege_type), '')
      INTO v_txt
      FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
     WHERE c.oid = v_probe AND a.grantee NOT IN (v_pg, v_svc);
    IF v_txt <> '' THEN
      RAISE EXCEPTION 'data-api-acl: a newly created % inherits privileges for a role other than its owner and service_role: %', v_probe, v_txt;
    END IF;
  END LOOP;

  DROP VIEW public._acl_d1a_probe_view;
  DROP TABLE public._acl_d1a_probe_tbl;

  -- ── 4h. The schema this migration was reviewed against is intact ──────────
  SELECT count(*) INTO v_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f');
  IF v_n <> (SELECT count(*) FROM acl_target) THEN
    RAISE EXCEPTION 'data-api-acl: the public relation inventory changed during this migration (% relations)', v_n;
  END IF;
END
$verify$;

COMMIT;
