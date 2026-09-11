-- DATA-API-ACL-RECONCILIATION-001 suite 015: the Data API object-privilege matrix.
--
-- Owns the client-role half of `20260910212202_reconcile_data_api_acls.sql`, and
-- it is deliberately an EXACT-MATCH suite rather than a "can the app still work"
-- suite. Under-grant and OVER-grant both fail here: a privilege nobody intended
-- is the defect this whole initiative exists to remove, and a subset test would
-- have passed against every state it was meant to catch.
--
-- Four properties make this suite different from the ACL assertions already in
-- 003 and 014, which pin four tables between them:
--
--   * it is CATALOG-DRIVEN. It enumerates `public` and requires every relation it
--     finds to be classified, so a future migration that adds a table, view,
--     materialized view, partitioned table or foreign table and forgets its ACLs
--     fails CI instead of inheriting whatever the platform default grants. The
--     exception allowlist is explicit, named, and EMPTY.
--   * it asserts DIRECT and EFFECTIVE privileges separately. They answer
--     different questions: the catalog says what was granted to this role, and
--     `has_*_privilege` additionally sees anything inherited through PUBLIC.
--     PUBLIC is `grantee = 0` in `aclexplode`; `pg_get_userbyid(0)` returns the
--     string 'unknown (OID=0)' rather than NULL, so a `coalesce(...,'PUBLIC')`
--     idiom matches nothing and quietly passes. This suite never uses it.
--   * it pins the FUTURE-OBJECT defaults, and proves them on real objects rather
--     than only reading `pg_default_acl`.
--   * it checks ALLOWLISTS, not only named roles. Besides pinning PUBLIC, anon,
--     authenticated and service_role by name, it requires that NO OTHER role
--     holds anything on a public relation or in `postgres`'s public default
--     entries (ACL-B6, ACL-G6, and the real-object probes in G4/G5b): a grantee
--     nobody named is exactly what a list of named roles cannot see.
--
-- What this suite deliberately does NOT assert, because this initiative
-- deliberately did not change it:
--
--   * `service_role` is pinned to its CURRENT posture — the one the migration
--     preserved — and never to a narrower "target". Its sequence privileges
--     differ legitimately between hosted Production (`rwU`) and a clean replay
--     (`wU`), so only the lane-invariant part is asserted here; the exact
--     pre/post equality is proven by the migration's own verification block and
--     by the hosted-parity lane in `scripts/e2e-local.mjs`.
--   * function EXECUTE privileges are not changed. Section H is an INVENTORY
--     guard only: a new SECURITY INVOKER routine must be classified rather than
--     silently inherit the PUBLIC EXECUTE that PostgreSQL's built-in global
--     default gives every new function.

BEGIN;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Direct = what the object's own ACL grants this grantee (0 = PUBLIC).
CREATE FUNCTION pg_temp.direct_privs(p_rel regclass, p_grantee oid) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
    FROM pg_class c,
         aclexplode(coalesce(c.relacl,
           acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
   WHERE c.oid = p_rel AND a.grantee = p_grantee;
$fn$;

-- Effective = what the role can actually do, PUBLIC-inherited privileges included.
CREATE FUNCTION pg_temp.eff_table_privs(p_rel regclass, p_role oid) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(string_agg(p, ',' ORDER BY p), '')
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
   WHERE has_table_privilege(p_role, p_rel, p);
$fn$;

CREATE FUNCTION pg_temp.eff_seq_privs(p_rel regclass, p_role oid) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(string_agg(p, ',' ORDER BY p), '')
    FROM unnest(ARRAY['SELECT','UPDATE','USAGE']) p
   WHERE has_sequence_privilege(p_role, p_rel, p);
$fn$;

-- Every direct entry whose grantee is NOT in p_allowed, as 'role:PRIVILEGE'.
-- The allowlist form of the question: it also sees a role nobody thought to name.
CREATE FUNCTION pg_temp.grants_outside(p_rel regclass, p_allowed oid[]) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type,
                             ',' ORDER BY a.grantee::text, a.privilege_type), '')
    FROM pg_class c,
         aclexplode(coalesce(c.relacl,
           acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
   WHERE c.oid = p_rel AND a.grantee <> ALL (p_allowed);
$fn$;

-- ── The intended matrix, as data ────────────────────────────────────────────
-- `auth_privs` / `svc_privs` are alphabetically ordered comma lists, matching
-- what the helpers above produce. `svc_privs` is a description of what
-- `service_role` holds TODAY, preserved by the migration — not a target.
CREATE TEMP TABLE acl_expected (relname text PRIMARY KEY, auth_privs text NOT NULL, svc_privs text NOT NULL);
INSERT INTO acl_expected (relname, auth_privs, svc_privs) VALUES
  ('ai_model_catalog',            'SELECT',                            ''),
  ('attachment_cleanup_queue',    'DELETE,SELECT',                     ''),
  ('attachment_cleanup_tombstone','',                                  ''),
  ('author_identities',           'SELECT',                            ''),
  ('author_identity_aliases',     'DELETE,INSERT,SELECT',              ''),
  ('author_identity_links',       'SELECT',                            ''),
  ('author_identity_merges',      'SELECT',                            ''),
  ('filter_presets',              'DELETE,INSERT,SELECT,UPDATE',       'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('internal_user_access',        '',                                  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('keyword_exclusion_pool',      'DELETE,INSERT,SELECT',              'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('keyword_pool',                'DELETE,INSERT,SELECT',              'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('paper_attachments',           'SELECT',                            'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('paper_projects',              'DELETE,INSERT,SELECT',              'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('paper_tags',                  'DELETE,INSERT,SELECT',              'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('papers',                      'INSERT,SELECT,UPDATE',              'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('profiles',                    'INSERT,SELECT,UPDATE',              'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('projects',                    'DELETE,INSERT,SELECT,UPDATE',       'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('study_type_exclusion_pool',   'DELETE,INSERT,SELECT',              'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('study_type_pool',             'DELETE,INSERT,SELECT,UPDATE',       'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('subscription_events',         '',                                  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('subscriptions',               '',                                  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('synonym_pool',                'DELETE,INSERT,SELECT,UPDATE',       'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('tags',                        'DELETE,INSERT,SELECT,UPDATE',       'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('usage_counters',              '',                                  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('usage_credits',               'SELECT',                            'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('user_ai_preferences',         'SELECT',                            ''),
  ('user_entitlements',           'SELECT',                            'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
  ('user_storage_usage',          'SELECT',                            'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE');

-- The explicit, named exception allowlist for the future-relation guard.
-- It is EMPTY. A Data API relation that is not an ordinary table in
-- `acl_expected` must be classified deliberately, not accommodated here.
CREATE TEMP TABLE acl_relation_allowlist (relname text PRIMARY KEY, why text NOT NULL);

-- SECURITY INVOKER routines whose PUBLIC EXECUTE is a KNOWN, deliberately
-- out-of-scope exception (see the suite header and decision C38). Removing it
-- requires a GLOBAL default-privilege change that would reach other schemas, so
-- it belongs to the separate function-privilege initiative. Listing them by name
-- is what makes a SIXTH such routine fail CI.
CREATE TEMP TABLE acl_invoker_public_exec_allowlist (sig text PRIMARY KEY, why text NOT NULL);
INSERT INTO acl_invoker_public_exec_allowlist VALUES
  ('immutable_english_tsvector_jsonb(jsonb)',   'tsvector wrapper used by the papers search_vector generation expression'),
  ('immutable_english_tsvector_text(text)',     'tsvector wrapper used by the papers search_vector generation expression'),
  ('immutable_english_tsvector_textarr(text[])','tsvector wrapper used by the papers search_vector generation expression'),
  ('set_updated_at()',                          'updated_at trigger function'),
  ('update_updated_at_column()',                'updated_at trigger function');

SELECT plan(88);

-- ══ A. Inventory and classification guards ══════════════════════════════════
SELECT is(
  (SELECT string_agg(c.relname, ',' ORDER BY c.relname)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'),
  (SELECT string_agg(relname, ',' ORDER BY relname) FROM acl_expected),
  'ACL-A1 the ordinary public tables are exactly the classified set');

SELECT is(
  (SELECT coalesce(string_agg(c.relname || ' (' || c.relkind::text || ')', ', ' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('p','v','m','f')
      AND c.relname NOT IN (SELECT relname FROM acl_relation_allowlist)),
  '',
  'ACL-A2 no unclassified Data API relation (partitioned table, view, matview, foreign table) in public');

SELECT is(
  (SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'),
  'papers_insert_order_seq',
  'ACL-A3 exactly one public sequence, and it is the papers insert-order sequence');

SELECT is(
  (SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
      AND c.relowner <> to_regrole('postgres')::oid),
  '',
  'ACL-A4 every public relation and sequence is owned by postgres');

-- ══ B. PUBLIC, anon — and any unreviewed role — reach nothing ═══════════════
SELECT is(
  (SELECT coalesce(string_agg(c.relname || '=' || pg_temp.direct_privs(c.oid, 0), ', ' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
      AND pg_temp.direct_privs(c.oid, 0) <> ''),
  '',
  'ACL-B1 PUBLIC (grantee 0) holds no direct privilege on any public relation or sequence');

SELECT is(
  (SELECT coalesce(string_agg(c.relname || '=' || pg_temp.direct_privs(c.oid, to_regrole('anon')::oid), ', ' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
      AND pg_temp.direct_privs(c.oid, to_regrole('anon')::oid) <> ''),
  '',
  'ACL-B2 anon holds no direct privilege on any public relation or sequence');

SELECT is(
  (SELECT coalesce(string_agg(c.relname || '=' || pg_temp.eff_table_privs(c.oid, to_regrole('anon')::oid), ', ' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
      AND pg_temp.eff_table_privs(c.oid, to_regrole('anon')::oid) <> ''),
  '',
  'ACL-B3 anon holds no EFFECTIVE privilege on any public relation (PUBLIC inheritance included)');

SELECT is(
  (SELECT coalesce(string_agg(c.relname || '=' || pg_temp.eff_seq_privs(c.oid, to_regrole('anon')::oid), ', ' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
      AND pg_temp.eff_seq_privs(c.oid, to_regrole('anon')::oid) <> ''),
  '',
  'ACL-B4 anon holds no EFFECTIVE privilege on any public sequence');

SELECT is(
  (SELECT coalesce(string_agg(c.relname || '.' || att.attname || ':' || a.privilege_type, ', '), '')
     FROM pg_attribute att
     JOIN pg_class c ON c.oid = att.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace,
          aclexplode(att.attacl) a
    WHERE n.nspname = 'public' AND att.attacl IS NOT NULL
      AND a.grantee IN (0, to_regrole('anon')::oid)),
  '',
  'ACL-B5 no column-level privilege is granted to PUBLIC or anon');

SELECT is(
  (SELECT coalesce(string_agg(c.relname || '=' || pg_temp.grants_outside(c.oid,
             ARRAY[to_regrole('postgres')::oid, to_regrole('authenticated')::oid, to_regrole('service_role')::oid]),
             '; ' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
      AND pg_temp.grants_outside(c.oid,
            ARRAY[to_regrole('postgres')::oid, to_regrole('authenticated')::oid, to_regrole('service_role')::oid]) <> ''),
  '',
  'ACL-B6 no role outside the owner, authenticated and service_role holds a privilege on any public relation or sequence');

-- ══ C. authenticated holds exactly the intended matrix ══════════════════════
SELECT is(
  pg_temp.direct_privs(('public.' || quote_ident(e.relname))::regclass, to_regrole('authenticated')::oid),
  e.auth_privs,
  'ACL-C1 authenticated DIRECT privileges on ' || e.relname
) FROM acl_expected e ORDER BY e.relname;

SELECT is(
  pg_temp.eff_table_privs(('public.' || quote_ident(e.relname))::regclass, to_regrole('authenticated')::oid),
  e.auth_privs,
  'ACL-C2 authenticated EFFECTIVE privileges on ' || e.relname
) FROM acl_expected e ORDER BY e.relname;

-- ══ D. The single column-level grant ════════════════════════════════════════
SELECT is(
  (SELECT coalesce(string_agg(c.relname || '.' || att.attname || ':' || a.grantee::regrole::text || ':' || a.privilege_type, ', '
                              ORDER BY c.relname, att.attname, a.privilege_type), '')
     FROM pg_attribute att
     JOIN pg_class c ON c.oid = att.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace,
          aclexplode(att.attacl) a
    WHERE n.nspname = 'public' AND att.attacl IS NOT NULL),
  'author_identities.preferred_name:authenticated:UPDATE',
  'ACL-D1 the column-level ACL inventory is exactly the one intended grant');

SELECT ok(
  has_column_privilege(to_regrole('authenticated')::oid, 'public.author_identities'::regclass, 'preferred_name', 'UPDATE'),
  'ACL-D2 authenticated can still UPDATE author_identities.preferred_name (renaming an identity needs no RPC)');

SELECT is(
  (SELECT coalesce(string_agg(att.attname, ',' ORDER BY att.attname), '')
     FROM pg_attribute att
    WHERE att.attrelid = 'public.author_identities'::regclass AND att.attnum > 0 AND NOT att.attisdropped
      AND att.attname <> 'preferred_name'
      AND has_column_privilege(to_regrole('authenticated')::oid, att.attrelid, att.attname, 'UPDATE')),
  '',
  'ACL-D3 no other author_identities column is updatable by authenticated');

-- ══ E. The sequence ═════════════════════════════════════════════════════════
SELECT is(
  pg_temp.direct_privs('public.papers_insert_order_seq'::regclass, to_regrole('authenticated')::oid),
  'USAGE',
  'ACL-E1 authenticated holds USAGE and only USAGE on papers_insert_order_seq (nextval, never setval)');

SELECT is(
  pg_temp.eff_seq_privs('public.papers_insert_order_seq'::regclass, to_regrole('authenticated')::oid),
  'USAGE',
  'ACL-E2 authenticated EFFECTIVE sequence privileges are USAGE only');

-- service_role is intentionally untouched by this initiative, and its sequence
-- posture is environment-dependent: `rwU` on hosted Production, `wU` on a clean
-- replay. Only the lane-invariant part is asserted; exact preservation is proven
-- against the pre-migration snapshot by the migration itself.
SELECT ok(
  has_sequence_privilege(to_regrole('service_role')::oid, 'public.papers_insert_order_seq'::regclass, 'USAGE')
  AND has_sequence_privilege(to_regrole('service_role')::oid, 'public.papers_insert_order_seq'::regclass, 'UPDATE')
  AND pg_temp.direct_privs('public.papers_insert_order_seq'::regclass, to_regrole('service_role')::oid)
      IN ('SELECT,UPDATE,USAGE', 'UPDATE,USAGE'),
  'ACL-E3 service_role keeps its existing sequence posture (not narrowed by this initiative)');

-- ══ F. service_role table privileges are preserved, not narrowed ════════════
SELECT is(
  (SELECT coalesce(string_agg(e.relname || ' expected[' || e.svc_privs || '] actual['
                              || pg_temp.direct_privs(('public.' || quote_ident(e.relname))::regclass, to_regrole('service_role')::oid) || ']',
                              '; ' ORDER BY e.relname), '')
     FROM acl_expected e
    WHERE pg_temp.direct_privs(('public.' || quote_ident(e.relname))::regclass, to_regrole('service_role')::oid)
          IS DISTINCT FROM e.svc_privs),
  '',
  'ACL-F1 service_role table privileges are exactly the posture this initiative preserved');

-- ══ G. Future-object defaults (D1a) ═════════════════════════════════════════
SELECT is(
  (SELECT coalesce(string_agg(d.defaclobjtype::text || ':' || a.grantee::text || ':' || a.privilege_type, ', '
                              ORDER BY d.defaclobjtype::text, a.grantee::text, a.privilege_type), '')
     FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
    WHERE n.nspname = 'public' AND d.defaclrole = to_regrole('postgres')::oid
      AND d.defaclobjtype IN ('r','S')
      AND a.grantee IN (0, to_regrole('anon')::oid, to_regrole('authenticated')::oid)),
  '',
  'ACL-G1 postgres table/sequence defaults in public grant nothing to PUBLIC, anon or authenticated');

SELECT is(
  (SELECT count(*)::int FROM pg_default_acl d
    WHERE d.defaclnamespace = 0 AND d.defaclrole = to_regrole('postgres')::oid AND d.defaclobjtype IN ('r','S')),
  0,
  'ACL-G2 postgres holds no GLOBAL table/sequence default privileges (an IN SCHEMA revoke could not override one)');

SELECT ok(
  (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
     FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
    WHERE n.nspname = 'public' AND d.defaclrole = to_regrole('postgres')::oid AND d.defaclobjtype = 'r'
      AND a.grantee = to_regrole('service_role')::oid)
  IN ('DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE', 'MAINTAIN,REFERENCES,TRIGGER,TRUNCATE'),
  'ACL-G3 service_role table defaults are left exactly as the platform maintains them (broad, or narrowed by Supabase)');

-- G1 names the client roles. G6 is the allowlist over the whole entry, and it is
-- the assertion that catches a default grantee nobody named (NC6c in the
-- hosted-parity lane proves G1 alone would not).
SELECT is(
  (SELECT coalesce(string_agg(d.defaclobjtype::text || ':' ||
                              CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ', '
                              ORDER BY d.defaclobjtype::text, a.grantee::text, a.privilege_type), '')
     FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
    WHERE n.nspname = 'public' AND d.defaclrole = to_regrole('postgres')::oid
      AND d.defaclobjtype IN ('r','S')
      AND a.grantee NOT IN (to_regrole('postgres')::oid, to_regrole('service_role')::oid)),
  '',
  'ACL-G6 postgres table/sequence defaults in public name no grantee but the owner and service_role');

-- ══ H. SECURITY INVOKER routine inventory (guard only; no grant is changed) ══
SELECT is(
  (SELECT coalesce(string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text), '')
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND NOT p.prosecdef),
  'attachment_cleanup_path_is_safe(uuid,text,uuid), immutable_english_tsvector_jsonb(jsonb), '
  || 'immutable_english_tsvector_text(text), immutable_english_tsvector_textarr(text[]), '
  || 'set_updated_at(), update_updated_at_column()',
  'ACL-H1 the SECURITY INVOKER routine inventory in public is exactly the classified six');

SELECT is(
  (SELECT coalesce(string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text), '')
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND NOT p.prosecdef
      AND has_function_privilege(to_regrole('anon')::oid, p.oid, 'EXECUTE')
      AND p.oid::regprocedure::text NOT IN (SELECT sig FROM acl_invoker_public_exec_allowlist)),
  '',
  'ACL-H2 no unallowlisted SECURITY INVOKER routine is executable by anon');

SELECT is(
  (SELECT coalesce(string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text), '')
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND NOT p.prosecdef
      AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                   WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
      AND p.oid::regprocedure::text NOT IN (SELECT sig FROM acl_invoker_public_exec_allowlist)),
  '',
  'ACL-H3 no unallowlisted SECURITY INVOKER routine carries PUBLIC EXECUTE');

SELECT is(
  (SELECT coalesce(string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text), '')
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND (has_function_privilege(to_regrole('anon')::oid, p.oid, 'EXECUTE')
           OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))),
  '',
  'ACL-H4 no SECURITY DEFINER routine in public is executable by anon or PUBLIC');

-- ══ G4. The defaults, proved on real objects ════════════════════════════════
-- Reading `pg_default_acl` says what is stored. This says what a new object
-- actually inherits, which is the question a future migration author cares
-- about. Every relation class ALTER DEFAULT PRIVILEGES ... ON TABLES governs is
-- covered except foreign tables, which need an FDW server to create — the
-- catalog guard in ACL-A2 covers those instead. All probes are dropped by the
-- suite's ROLLBACK.
CREATE TABLE public.zz_acl_probe_tbl (id bigserial PRIMARY KEY, v text);
CREATE VIEW public.zz_acl_probe_view AS SELECT 1 AS one;
CREATE MATERIALIZED VIEW public.zz_acl_probe_matview AS SELECT 1 AS one;
CREATE TABLE public.zz_acl_probe_part (id int NOT NULL) PARTITION BY RANGE (id);

SELECT is(
  pg_temp.grants_outside(('public.' || probe)::regclass, ARRAY[to_regrole('postgres')::oid, to_regrole('service_role')::oid]),
  '',
  'ACL-G4 a newly created ' || probe || ' inherits nothing for any role but its owner and service_role'
) FROM unnest(ARRAY['zz_acl_probe_tbl','zz_acl_probe_view','zz_acl_probe_matview','zz_acl_probe_part','zz_acl_probe_tbl_id_seq']) probe;

-- ══ G5. Supabase's own documented revoke cannot undo D1a ════════════════════
-- First-party guidance for existing projects, and what Supabase states it will
-- apply to all existing projects on 2026-10-30. It is NARROWER than D1a: it
-- removes the four DML privileges from tables and USAGE/SELECT from sequences,
-- leaving TRUNCATE/REFERENCES/TRIGGER/MAINTAIN behind. Running it here proves
-- the interaction is safe in the only direction that matters: a REVOKE cannot
-- restore a privilege, so the platform's rollout cannot re-open what D1a closed.
-- (It also revokes from service_role, which is the platform's business, not this
-- initiative's; the assertions below deliberately look only at client roles.)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM anon, authenticated, service_role;

SELECT is(
  (SELECT coalesce(string_agg(d.defaclobjtype::text || ':' || a.grantee::text || ':' || a.privilege_type, ', '), '')
     FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
    WHERE n.nspname = 'public' AND d.defaclrole = to_regrole('postgres')::oid
      AND d.defaclobjtype IN ('r','S')
      AND a.grantee IN (0, to_regrole('anon')::oid, to_regrole('authenticated')::oid)),
  '',
  'ACL-G5a Supabase''s documented default-privilege revoke restores nothing for PUBLIC, anon or authenticated');

CREATE TABLE public.zz_acl_probe_after_platform (id bigserial PRIMARY KEY);
SELECT is(
  pg_temp.grants_outside('public.zz_acl_probe_after_platform'::regclass, ARRAY[to_regrole('postgres')::oid, to_regrole('service_role')::oid]),
  '',
  'ACL-G5b a table created after that platform revoke still reaches no role but its owner and service_role');

DROP TABLE public.zz_acl_probe_after_platform;
DROP TABLE public.zz_acl_probe_part;
DROP MATERIALIZED VIEW public.zz_acl_probe_matview;
DROP VIEW public.zz_acl_probe_view;
DROP TABLE public.zz_acl_probe_tbl;

SELECT * FROM finish();
ROLLBACK;
