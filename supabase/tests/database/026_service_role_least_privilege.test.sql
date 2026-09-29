-- Suite 026: service_role's whole application-owned surface
-- (SERVICE-ROLE-LEAST-PRIVILEGE-HARDENING-001, C57).
--
-- `20260929084252_harden_service_role_least_privilege.sql` removed every
-- service_role privilege on application-owned objects in `public` that no
-- server path uses, and removed its default privileges on future tables,
-- sequences and functions. This suite owns the resulting invariant: the
-- secret key's database role can do exactly two things with PaperLume's own
-- objects — append an AI usage telemetry row and refund one unit of AI quota —
-- and nothing a later migration forgets to lock down.
--
-- service_role has BYPASSRLS, so object grants are the only database control on
-- what the secret key can do. That is why every assertion here is about
-- grants, and why the real-attempt probes matter: a catalog read says what is
-- stored, a refused statement proves what the key can actually do.
--
-- Asserted here, each so a failure names what broke:
--   A. the whole surface, catalog-driven over every relation, column, sequence
--      and function in `public` and postgres's default entries: stored AND
--      effective privileges, no column grant, no grant option, no inheritance,
--      USAGE without CREATE on the schema;
--   B. the defaults, proved on objects created now: a new table, identity
--      sequence, view and function grant service_role nothing, and each is
--      refused at run time;
--   C. real attempts on existing objects, one per privilege class the
--      hardening removed — every one refused with 42501, and no row changed;
--   D. positive controls, so the suite cannot pass by stripping everything:
--      the telemetry INSERT and the quota refund still work as service_role,
--      and the refund stays closed to anon, authenticated and PUBLIC;
--   E. account deletion needs no API-role grant: the only AFTER triggers on
--      the auth.users cascade path run as SECURITY DEFINER (the Auth Admin API
--      deletes as supabase_auth_admin, and AFTER triggers run as the deleting
--      role — an INVOKER one touching a table would abort the deletion);
--   F. the platform-owned surfaces delete-account uses are untouched.
--
-- The relation matrix for the client roles is owned by 015, the refund's
-- caller-scope contract by 003/004, and the telemetry table's full contract by
-- 017; this suite does not repeat them.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials; no provider request. Everything rolls
-- back with the transaction.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- The SQLSTATE of one statement run as p_role with the given JWT claims.
CREATE FUNCTION pg_temp.errcode_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := '00000';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state;
END;
$hlp$;

-- Refund the way the Edge Functions do since C47: as service_role, with no
-- caller claims, naming the user the server authenticated.
CREATE FUNCTION pg_temp.refund_as_server(p_user uuid)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  SET LOCAL ROLE service_role;
  SELECT refunded::text || '|' || coalesce(period_type, '') || '|' || used::text INTO v
  FROM public.refund_ai_quota(p_user);
  RESET ROLE;
  RETURN v;
END;
$hlp$;

CREATE FUNCTION pg_temp.claims(p_uid text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT '{"sub":"' || p_uid || '","role":"authenticated"}'
$hlp$;

-- One valid telemetry event for the fixture user (suite 017's base row), with
-- an optional suffix such as a RETURNING clause.
CREATE FUNCTION pg_temp.telemetry_insert_sql(p_suffix text DEFAULT '') RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT $q$
    INSERT INTO public.ai_provider_usage_events
      (occurred_at, user_id, telemetry_version, operation, provider, provider_model,
       model_selection_source, reasoning_source, resolved_reasoning_level,
       provider_outcome, provider_http_status, provider_attempts, operation_outcome,
       usage_status, input_tokens, cached_input_tokens, cache_write_input_tokens,
       output_tokens, reasoning_output_tokens, provider_total_tokens, has_unmodeled_usage,
       cost_status, list_price_estimate_usd, price_record_id, input_usd_per_mtok,
       cached_input_usd_per_mtok, cache_write_input_usd_per_mtok, output_usd_per_mtok)
    VALUES
      ('2026-10-01T12:00:00Z', '02600000-0000-0000-0000-000000000001', 1, 'analyze', 'google', 'gemini-3.6-flash',
       'system_default', 'automatic', 'minimal',
       'completed', NULL, 1, 'succeeded',
       'reported', 1200, 300, NULL,
       190, 40, 1390, false,
       'estimated', 0.001410000000000, 'google/gemini-3.6-flash@2026-09-13', 0.75,
       0.075, NULL, 3.75)$q$ || p_suffix
$hlp$;

-- Everything the fixture rows below hold, as one comparable value.
CREATE FUNCTION pg_temp.fixture_state() RETURNS text LANGUAGE sql AS $hlp$
  SELECT concat_ws(' | ',
    (SELECT 'paper=' || title FROM public.papers WHERE id = '02600000-0000-0000-0000-0000000000a1'),
    (SELECT 'preset=' || count(*) FROM public.filter_presets WHERE user_id = '02600000-0000-0000-0000-000000000001'),
    (SELECT 'model_selection=' || ai_model_selection_enabled FROM public.user_entitlements WHERE user_id = '02600000-0000-0000-0000-000000000001'),
    (SELECT 'access=' || count(*) FROM public.internal_user_access WHERE user_id = '02600000-0000-0000-0000-000000000001'),
    (SELECT 'subscriptions=' || count(*) FROM public.subscriptions WHERE user_id = '02600000-0000-0000-0000-000000000001'),
    (SELECT 'ai_used=' || used FROM public.usage_counters
      WHERE user_id = '02600000-0000-0000-0000-000000000001' AND feature = 'ai_analysis' AND period_type = 'lifetime'),
    (SELECT 'events=' || count(*) FROM public.ai_provider_usage_events WHERE user_id = '02600000-0000-0000-0000-000000000001'));
$hlp$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- handle_new_user() creates the user's profile, Free entitlement and lifetime
-- ai_analysis counter. The counter is set to 1 so a refund has a unit to return.
INSERT INTO auth.users (id, email) VALUES ('02600000-0000-0000-0000-000000000001', 'c57-u1@paperlume.test');
INSERT INTO public.papers (id, user_id, title) VALUES
  ('02600000-0000-0000-0000-0000000000a1', '02600000-0000-0000-0000-000000000001', 'C57 paper');
INSERT INTO public.filter_presets (id, user_id, name, payload) VALUES
  ('02600000-0000-0000-0000-0000000000f1', '02600000-0000-0000-0000-000000000001', 'C57 preset', '{}'::jsonb);
UPDATE public.usage_counters SET used = 1
 WHERE user_id = '02600000-0000-0000-0000-000000000001' AND feature = 'ai_analysis' AND period_type = 'lifetime';

-- The fixture state every refused statement in section C must leave alone.
CREATE TEMP TABLE t026_before AS SELECT pg_temp.fixture_state() AS s;

-- 12 (A) + 5 (B) + 17 (C) + 5 (D) + 1 (E) + 2 (F) = 42
SELECT plan(42);

-- ══ A. The whole surface, catalog-driven ═════════════════════════════════════
SELECT is(
  (SELECT coalesce(string_agg(c.relname || ':' || a.privilege_type || ':' || a.is_grantable::text || ':' || pg_get_userbyid(a.grantor),
                              ', ' ORDER BY c.relname COLLATE "C", a.privilege_type), '')
     FROM pg_class c,
          aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
    WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'service_role'::regrole),
  'ai_provider_usage_events:INSERT:false:postgres',
  'A1 service_role''s only stored grant on any public relation or sequence is INSERT on ai_provider_usage_events (by postgres, not delegable)');

SELECT is(
  (SELECT coalesce(string_agg(c.relname || '=' || x.privs, ', ' ORDER BY c.relname COLLATE "C"), '')
     FROM pg_class c
     CROSS JOIN LATERAL (
       SELECT string_agg(p, ',' ORDER BY p) AS privs
         FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
        WHERE has_table_privilege('service_role', c.oid, p)) x
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND x.privs IS NOT NULL),
  'ai_provider_usage_events=INSERT',
  'A2 service_role''s EFFECTIVE privileges over every public table, view and foreign table are INSERT on ai_provider_usage_events alone');

SELECT is(
  (SELECT coalesce(string_agg(c.relname || '=' || x.privs, ', ' ORDER BY c.relname COLLATE "C"), '')
     FROM pg_class c
     CROSS JOIN LATERAL (
       SELECT string_agg(p, ',' ORDER BY p) AS privs
         FROM unnest(ARRAY['SELECT','UPDATE','USAGE']) p
        WHERE has_sequence_privilege('service_role', c.oid, p)) x
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S' AND x.privs IS NOT NULL),
  '',
  'A3 service_role holds no EFFECTIVE privilege on any public sequence (no nextval, setval or currval)');

SELECT is(
  (SELECT coalesce(string_agg(c.relname || '.' || att.attname || ':' || p, ', ' ORDER BY c.relname COLLATE "C", att.attname COLLATE "C", p), '')
     FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid,
          unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','f')
      AND att.attnum > 0 AND NOT att.attisdropped
      AND has_column_privilege('service_role', c.oid, att.attnum, p)
      AND NOT (c.oid = 'public.ai_provider_usage_events'::regclass AND p = 'INSERT'))
  || ' / ' ||
  (SELECT count(*)::text
     FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid, aclexplode(att.attacl) a
    WHERE c.relnamespace = 'public'::regnamespace AND att.attacl IS NOT NULL AND a.grantee = 'service_role'::regrole),
  ' / 0',
  'A4 service_role reaches no public column beyond the telemetry INSERT, and holds no column-level grant');

SELECT is(
  (SELECT coalesce(string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C"), '')
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('service_role', p.oid, 'EXECUTE')),
  'refund_ai_quota(uuid)',
  'A5 the only public routine service_role can EXECUTE is refund_ai_quota(uuid)');

SELECT is(
  (SELECT coalesce(p.proacl::text, '<default>') FROM pg_proc p WHERE p.oid = to_regprocedure('public.refund_ai_quota(uuid)')),
  '{postgres=X/postgres,service_role=X/postgres}',
  'A6 refund_ai_quota(uuid) is executable by its owner and service_role, and stored exactly so');

SELECT is(
  (SELECT coalesce(string_agg(d.defaclobjtype::text || ':' || a.privilege_type, ', ' ORDER BY d.defaclobjtype::text, a.privilege_type), '')
     FROM pg_default_acl d, aclexplode(d.defaclacl) a
    WHERE d.defaclrole = to_regrole('postgres')::oid
      AND d.defaclnamespace IN (0, 'public'::regnamespace)
      AND a.grantee = 'service_role'::regrole),
  '',
  'A7 no default-privilege entry of postgres — global or in public — grants service_role anything on future objects');

SELECT is(
  (SELECT coalesce(string_agg(d.defaclobjtype::text || '=' || d.defaclacl::text, ' ' ORDER BY d.defaclobjtype::text COLLATE "C"), '<none>')
     FROM pg_default_acl d
    WHERE d.defaclrole = to_regrole('postgres')::oid AND d.defaclnamespace = 'public'::regnamespace),
  'S={postgres=rwU/postgres} f={postgres=X/postgres} r={postgres=arwdDxtm/postgres}',
  'A8 postgres''s public default entries name the owner alone, for tables, sequences and functions');

SELECT is(
  has_schema_privilege('service_role', 'public', 'USAGE')::text || '/' || has_schema_privilege('service_role', 'public', 'CREATE')::text,
  'true/false',
  'A9 service_role keeps USAGE on schema public (the platform grant) and has no CREATE');

SELECT is(
  (SELECT coalesce(string_agg(pg_get_userbyid(m.roleid), ', ' ORDER BY pg_get_userbyid(m.roleid) COLLATE "C"), '')
     FROM pg_auth_members m WHERE m.member = 'service_role'::regrole),
  '',
  'A10 service_role is a member of no role, so what A1-A8 show is everything it holds');

SELECT is(
  (SELECT count(*)::int FROM (
     SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'service_role'::regrole AND a.is_grantable
     UNION ALL
     SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.pronamespace = 'public'::regnamespace AND a.grantee = 'service_role'::regrole AND a.is_grantable) g),
  0,
  'A11 service_role can delegate nothing in public (no grant option on any relation or routine)');

SELECT is(
  (SELECT coalesce(string_agg(t.typname, ', ' ORDER BY t.typname COLLATE "C"), '')
     FROM pg_type t, aclexplode(t.typacl) a
    WHERE t.typnamespace = 'public'::regnamespace AND t.typacl IS NOT NULL AND a.grantee = 'service_role'::regrole),
  '',
  'A12 no public type carries an explicit service_role grant');

-- ══ B. The defaults, proved on objects created now ══════════════════════════
-- What the next migration's objects actually inherit. Dropped by the ROLLBACK.
CREATE TABLE public.zz_026_probe_t (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, v text);
CREATE VIEW public.zz_026_probe_v AS SELECT 1 AS one;
CREATE FUNCTION public.zz_026_probe_f() RETURNS integer LANGUAGE sql AS 'SELECT 1';

SELECT is(
  (SELECT coalesce(string_agg(o.what || ':' || o.privilege_type, ', ' ORDER BY o.what, o.privilege_type), '')
     FROM (SELECT c.relname AS what, a.grantee, a.privilege_type
             FROM pg_class c,
                  aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
            WHERE c.oid IN ('public.zz_026_probe_t'::regclass, 'public.zz_026_probe_t_id_seq'::regclass, 'public.zz_026_probe_v'::regclass)
           UNION ALL
           SELECT 'zz_026_probe_f', a.grantee, a.privilege_type
             FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
            WHERE p.oid = 'public.zz_026_probe_f()'::regprocedure) o
    WHERE o.grantee = 'service_role'::regrole),
  '',
  'B1 a new public table, identity sequence, view and function store no grant for service_role');

SELECT is(
  (SELECT coalesce(string_agg(w, ', ' ORDER BY w), '')
     FROM unnest(ARRAY['table','sequence','view','function']) w
    WHERE CASE w
            WHEN 'table'    THEN has_table_privilege('service_role', 'public.zz_026_probe_t'::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            WHEN 'sequence' THEN has_sequence_privilege('service_role', 'public.zz_026_probe_t_id_seq'::regclass, 'SELECT,UPDATE,USAGE')
            WHEN 'view'     THEN has_table_privilege('service_role', 'public.zz_026_probe_v'::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            ELSE                 has_function_privilege('service_role', 'public.zz_026_probe_f()'::regprocedure, 'EXECUTE')
          END),
  '',
  'B2 service_role holds no EFFECTIVE privilege on any of the new objects');

SELECT is(pg_temp.errcode_as('service_role', NULL, 'SELECT count(*) FROM public.zz_026_probe_t'), '42501',
  'B3 service_role cannot read a new public table');
SELECT is(pg_temp.errcode_as('service_role', NULL, $q$SELECT nextval('public.zz_026_probe_t_id_seq')$q$), '42501',
  'B4 service_role cannot draw from a new public sequence');
SELECT is(pg_temp.errcode_as('service_role', NULL, 'SELECT public.zz_026_probe_f()'), '42501',
  'B5 service_role cannot execute a new public function');

-- ══ C. Real attempts on existing objects, one per removed privilege class ═══
SELECT is(pg_temp.errcode_as('service_role', NULL, 'SELECT email, pubmed_api_key FROM public.profiles'), '42501',
  'C1 SELECT: service_role cannot read profiles (email, PubMed API key)');
SELECT is(pg_temp.errcode_as('service_role', NULL, 'SELECT count(*) FROM public.papers'), '42501',
  'C2 SELECT: service_role cannot read any user''s library');
SELECT is(pg_temp.errcode_as('service_role', NULL,
  $q$UPDATE public.papers SET title = 'rewritten' WHERE id = '02600000-0000-0000-0000-0000000000a1'$q$), '42501',
  'C3 UPDATE: service_role cannot rewrite a paper');
SELECT is(pg_temp.errcode_as('service_role', NULL,
  $q$DELETE FROM public.papers WHERE id = '02600000-0000-0000-0000-0000000000a1'$q$), '42501',
  'C4 DELETE: service_role cannot delete a user''s paper');
SELECT is(pg_temp.errcode_as('service_role', NULL,
  $q$DELETE FROM public.filter_presets WHERE user_id = '02600000-0000-0000-0000-000000000001'$q$), '42501',
  'C5 DELETE: service_role cannot delete a user''s saved searches');
SELECT is(pg_temp.errcode_as('service_role', NULL,
  $q$UPDATE public.user_entitlements SET ai_model_selection_enabled = true WHERE user_id = '02600000-0000-0000-0000-000000000001'$q$), '42501',
  'C6 UPDATE: service_role cannot flip a paid-model entitlement');
SELECT is(pg_temp.errcode_as('service_role', NULL,
  $q$INSERT INTO public.internal_user_access (user_id, role, ai_quota_exempt) VALUES ('02600000-0000-0000-0000-000000000001', 'owner', true)$q$), '42501',
  'C7 INSERT: service_role cannot grant itself owner access or a quota exemption');
SELECT is(pg_temp.errcode_as('service_role', NULL,
  $q$INSERT INTO public.subscriptions (user_id, provider, status) VALUES ('02600000-0000-0000-0000-000000000001', 'manual', 'active')$q$), '42501',
  'C8 INSERT: service_role cannot forge a subscription');
SELECT is(pg_temp.errcode_as('service_role', NULL,
  $q$UPDATE public.usage_counters SET used = 0 WHERE user_id = '02600000-0000-0000-0000-000000000001'$q$), '42501',
  'C9 UPDATE: service_role cannot reset a usage counter directly (only the refund RPC moves it, by one)');
SELECT is(pg_temp.errcode_as('service_role', NULL, 'TRUNCATE public.usage_counters'), '42501',
  'C10 TRUNCATE: service_role cannot empty a table (TRUNCATE is not governed by RLS)');
SELECT is(pg_temp.errcode_as('service_role', NULL, $q$SELECT nextval('public.papers_insert_order_seq')$q$), '42501',
  'C11 sequence USAGE: service_role cannot draw from papers_insert_order_seq');
SELECT is(pg_temp.errcode_as('service_role', NULL, $q$SELECT setval('public.papers_insert_order_seq', 1)$q$), '42501',
  'C12 sequence UPDATE: service_role cannot rewind papers_insert_order_seq');
SELECT is(pg_temp.errcode_as('service_role', NULL, 'LOCK TABLE public.papers IN ACCESS EXCLUSIVE MODE'), '42501',
  'C13 MAINTAIN: service_role cannot take an ACCESS EXCLUSIVE lock on papers');
SELECT is(pg_temp.errcode_as('service_role', NULL,
  'CREATE TRIGGER zz_026_planted BEFORE UPDATE ON public.papers FOR EACH ROW EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger()'), '42501',
  'C14 TRIGGER: service_role cannot attach a trigger to papers, even with a function it may execute');
SELECT is(pg_temp.errcode_as('service_role', NULL, 'CREATE TABLE public.zz_026_svc_owned (id int)'), '42501',
  'C15 CREATE: service_role cannot create objects in public (so REFERENCES could not be used either)');
SELECT is(pg_temp.errcode_as('service_role', NULL, pg_temp.telemetry_insert_sql(' RETURNING id')), '42501',
  'C16 SELECT via RETURNING: service_role cannot read back the telemetry row it inserts');

SELECT is(pg_temp.fixture_state(), (SELECT s FROM t026_before),
  'C17 none of the refused statements changed a single fixture row');

-- ══ D. Positive controls: the two server paths still work ═══════════════════
SELECT is(pg_temp.errcode_as('service_role', NULL, pg_temp.telemetry_insert_sql()), '00000',
  'D1 telemetry: service_role can append a usage event (INSERT without RETURNING, as supabase-js sends it)');
SELECT is(
  (SELECT count(*)::int FROM public.ai_provider_usage_events WHERE user_id = '02600000-0000-0000-0000-000000000001'),
  1,
  'D2 telemetry: the event service_role appended is stored');
SELECT is(pg_temp.refund_as_server('02600000-0000-0000-0000-000000000001'), 'true|lifetime|0',
  'D3 refund: service_role returns the unit to the user''s lifetime bucket (used 1 -> 0)');
SELECT is(
  pg_temp.errcode_as('anon', NULL, $q$SELECT * FROM public.refund_ai_quota('02600000-0000-0000-0000-000000000001')$q$) || ' '
  || pg_temp.errcode_as('authenticated', pg_temp.claims('02600000-0000-0000-0000-000000000001'),
                        $q$SELECT * FROM public.refund_ai_quota('02600000-0000-0000-0000-000000000001')$q$),
  '42501 42501',
  'D4 refund: anon and authenticated (even for their own id) are refused at the ACL');
SELECT is(
  (SELECT count(*)::int FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
    WHERE p.oid = to_regprocedure('public.refund_ai_quota(uuid)') AND a.grantee = 0),
  0,
  'D5 refund: PUBLIC holds no EXECUTE');

-- ══ E. Account deletion needs no API-role grant ═════════════════════════════
-- Every AFTER trigger on a public table that the auth.users ON DELETE CASCADE /
-- SET NULL graph reaches, with the security mode of its function. Such
-- triggers run as the role that deleted the user (supabase_auth_admin, which
-- holds nothing in public), so each must be SECURITY DEFINER.
SELECT is(
  (WITH RECURSIVE closure(rel, via) AS (
     SELECT k.conrelid, k.confdeltype::text FROM pg_constraint k
      WHERE k.contype = 'f' AND k.confrelid = 'auth.users'::regclass AND k.confdeltype IN ('c','n','d')
     UNION
     SELECT k.conrelid, k.confdeltype::text FROM pg_constraint k JOIN closure cl ON k.confrelid = cl.rel AND cl.via = 'c'
      WHERE k.contype = 'f' AND k.confdeltype IN ('c','n','d'))
   SELECT coalesce(string_agg(DISTINCT c.relname || '.' || t.tgname || '=' || p.oid::regprocedure::text
                              || CASE WHEN p.prosecdef THEN ':definer' ELSE ':INVOKER' END, ', '), '')
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_proc p ON p.oid = t.tgfoid
     JOIN closure cl ON cl.rel = t.tgrelid
    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
      AND (t.tgtype & 2) = 0 AND (t.tgtype & 64) = 0),
  'paper_attachments.trg_paper_attachments_refund_storage_quota=refund_storage_quota():definer, '
  || 'papers.papers_clear_author_identity_links_on_authors_change=clear_author_identity_links_on_authors_change():definer',
  'E1 the only AFTER triggers on the account-deletion cascade path are the two reviewed SECURITY DEFINER ones');

-- ══ F. The platform surfaces delete-account uses are untouched ══════════════
-- The Storage API runs as service_role on the platform-owned `storage` schema;
-- these grants are the platform's, and C57 does not touch them.
SELECT ok(
  has_schema_privilege('service_role', 'storage', 'USAGE')
  AND has_table_privilege('service_role', 'storage.objects', 'SELECT')
  AND has_table_privilege('service_role', 'storage.objects', 'DELETE')
  AND has_table_privilege('service_role', 'storage.buckets', 'SELECT'),
  'F1 service_role keeps the platform Storage grants account deletion uses (list and remove objects)');
SELECT is(
  (SELECT format('super=%s login=%s bypassrls=%s', rolsuper, rolcanlogin, rolbypassrls) FROM pg_roles WHERE rolname = 'service_role'),
  'super=f login=f bypassrls=t',
  'F2 service_role''s role attributes are the platform''s, unchanged');

SELECT * FROM finish();
ROLLBACK;
