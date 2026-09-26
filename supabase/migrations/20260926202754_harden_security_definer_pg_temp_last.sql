-- DB-SECURITY-DEFINER-PG-TEMP-LAST-001 — retained SECURITY DEFINER functions
-- whose bodies resolve names through search_path place `pg_temp` last.
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly one catalog attribute on exactly 32 functions, `proconfig`:
--
--   {search_path=public}  →  {"search_path=public, pg_temp"}
--
-- via 32 exact-signature `ALTER FUNCTION ... SET search_path = public, pg_temp`
-- statements (section 2). Nothing else moves: not a body, signature, argument
-- name/mode/default, return type, language, volatility, parallel mode,
-- strictness, leakproofness, cost, security mode, owner or EXECUTE ACL of these
-- 32; not the three audited exceptions below, which are not touched at all; not
-- another function; not a trigger, policy, grant, relation or row. Section 3
-- proves every one of those facts before COMMIT, comparing each target's WHOLE
-- `pg_proc` row except `proconfig` — and each exception's whole row, `proconfig`
-- included — against its pre-change snapshot.
--
-- WHY — defense in depth, not incident remediation
-- ─────────────────────────────────────────────────────────────────────────────
-- The read-only DB-SECURITY-DEFINER-SEARCH-PATH-AUDIT-001 reviewed all 35
-- SECURITY DEFINER functions in `public`. They are SECURITY DEFINER on purpose
-- (C49 records the five that were not, and are no longer), and every one already
-- pins `search_path=public`. That pin is not the whole story, because of how
-- PostgreSQL 17 resolves an unqualified name (runtime-config-client.html,
-- `search_path`):
--
--   * `pg_catalog` is always searched, before the listed schemas unless listed;
--   * the session's temporary schema is ALSO always searched and, when it is not
--     listed explicitly, it is searched FIRST — before `pg_catalog` and before
--     `public`;
--   * that implicit temp lookup applies to relation (table, view, sequence, …)
--     and data-type names — never to function or operator names.
--
-- So under `search_path=public` an unqualified `papers`, `tags`, `paper_tags`,
-- `profiles`, a `%ROWTYPE` or a type name inside one of these bodies would
-- resolve to a same-named object in the CALLER's temporary schema if one
-- existed, and the function would then act on it with the owner's (`postgres`,
-- BYPASSRLS) authority. The CREATE FUNCTION reference ("Writing SECURITY
-- DEFINER Functions Safely") names exactly this and gives the remedy: write
-- `pg_temp` as the LAST entry, after the trusted schemas. With
-- `search_path = public, pg_temp`, every such name is found in `public` (which
-- untrusted roles cannot CREATE in — the other half of the safe arrangement,
-- re-verified read-only in Production: `anon`, `authenticated` and
-- `service_role` hold no CREATE on `public`) before the temp schema is reached.
--
-- The audit found NO confirmed exploitable path: no ordinary PaperLume caller
-- has a demonstrated route to run arbitrary SQL in a session and create the
-- shadow object first (PostgREST exposes RPC calls, not DDL). This migration
-- therefore closes a latent name-resolution surface as defense in depth. It is
-- not a response to an incident, and it does not change what any legitimate
-- call returns: with no temp shadow present, `public, pg_temp` and `public`
-- resolve every name identically.
--
-- THE 32 — every one has a path-resolved relation/type name or a
-- path-sensitive callee (the audit's Tier 1: unqualified relations on the
-- write boundary; Tier 2: types, %ROWTYPE and transitive resolution).
--
-- THE 3 AUDITED EXCEPTIONS — deliberately NOT altered
-- ─────────────────────────────────────────────────────────────────────────────
--   clear_author_identity_links_on_authors_change()   body md5 a14c92dbd8485afff4d1600684b37565
--   refund_storage_quota()                            body md5 3e20f43b80a908b309cb6335d8eb9360
--   reject_attachment_over_cleanup_intent()           body md5 494f7297c23991bc8d28d4f81906e059
--
-- All three are trigger functions whose audited bodies reference relations only
-- as `public.<name>` (in refund_storage_quota, `user_storage_usage.` is the
-- range-variable qualifier of the schema-qualified target, not a lookup), and
-- otherwise call only built-in functions, which the temp schema is never
-- searched for. Nothing in them is resolved through the path in a way the temp
-- schema could shadow, so they are SAFE UNDER CURRENT PRIVILEGES and stay at
-- `search_path=public`. That classification is for those exact bodies: section
-- 1 refuses to run if any of the three digests differs, and
-- supabase/tests/database/021_security_definer_search_path.test.sql pins
-- path AND digest together, so a later body change forces a re-review (keep the
-- exception, or move the function into the hardened group) rather than
-- inheriting an exemption by name. They are not normalised for uniformity.
--
-- OUT OF SCOPE — untouched and proven untouched by section 3
-- ─────────────────────────────────────────────────────────────────────────────
--   * C49's five SECURITY INVOKER read RPCs (search_papers, search_papers_short,
--     filter_papers_by_keywords, get_keyword_options, get_duplicate_papers);
--   * the `search_path=pg_catalog` helpers (set_updated_at,
--     immutable_english_tsvector_*, attachment_cleanup_path_is_safe);
--   * any SECURITY INVOKER conversion of bulk_update_keywords,
--     bulk_update_study_types or safe_bulk_insert_papers (hardened here because
--     they are SECURITY DEFINER today);
--   * database TEMP privilege (not revoked — a separate platform question).
--
-- CONCURRENCY AND ROLLOUT
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration-only. No Edge Function, client or generated type changes: no
-- signature changes. A call already executing when this commits finishes under
-- the configuration it started with; the next call applies the new one. Both
-- resolve every name identically unless a temp shadow exists, so no ordering or
-- lock barrier is needed. The file is explicitly transactional (see
-- 20260910212202 for why `supabase db reset` requires that): the
-- preconditions, the 32 ALTERs and the verification commit together or not at
-- all.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- Forward-fix preferred. The reviewed restoration is exactly the same 32
-- statements with `SET search_path = public`, which returns them to their
-- pre-change shape (bodies, ACLs and modes were never touched). It removes a
-- defense-in-depth layer; it does not open a boundary. See
-- docs/deployment.md §6.11.
--
-- Durable decision: C50.

BEGIN;


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context, and this transaction's own write counters
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only a function's owner can change its configuration, and all 35 are owned by
-- `postgres`. Section 3 proves this transaction wrote no row to any table in
-- `public`, `auth` or `storage`, from PostgreSQL's per-transaction statistics
-- (see 20260924193915 §0 for why the baseline is taken here, and why it lives in
-- a transaction-local setting a runner without the BEGIN above would lose).

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'definer_pg_temp_last: must run as postgres (current_user is %) — only the owner can change the configuration of the 32 functions',
      current_user;
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'definer_pg_temp_last: track_counts is off, so the no-write self-check could not observe anything';
  END IF;

  PERFORM set_config(
    'paperlume.definer_pg_temp_last.xact_writes_at_start',
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
-- Verified read-only against Production on 2026-09-26 (PostgreSQL 17.6; ledger
-- 89, latest 20260926152414 harden_read_rpcs_security_invoker; 35 public
-- SECURITY DEFINER functions, 27 of them executable by authenticated, all 35 at
-- `{search_path=public}`) and byte-identical on a clean local replay. Nothing
-- here repairs unexpected state: any mismatch rolls the whole file back before a
-- single attribute changes. A function that appeared, disappeared or changed
-- since the audit invalidates the reviewed scope; it is never altered
-- automatically. The snapshots at the end of this block are what section 3
-- compares against.

DO $pre$
DECLARE
  v_count      INTEGER;
  v_text       TEXT;
  v_want       TEXT;
  -- The 32 hardening targets (audit Tier 1: 1–10; Tier 2: 11–32).
  v_targets    CONSTANT TEXT[] := ARRAY[
    'public.bulk_add_paper_projects(uuid[],uuid[])',
    'public.bulk_add_paper_tags(uuid[],uuid[])',
    'public.bulk_set_paper_projects(uuid[],uuid[])',
    'public.bulk_set_paper_tags(uuid[],uuid[])',
    'public.bulk_update_keywords(jsonb)',
    'public.bulk_update_study_types(jsonb)',
    'public.merge_exact_duplicates(uuid,uuid[])',
    'public.safe_bulk_insert_papers(uuid,jsonb)',
    'public.set_paper_projects(uuid,uuid[])',
    'public.set_paper_tags(uuid,uuid[])',
    'public.attachment_object_has_live_metadata(text)',
    'public.author_identity_effective_root(uuid,uuid)',
    'public.check_and_consume_storage_quota()',
    'public.clear_current_user_ai_model()',
    'public.clear_current_user_ai_reasoning()',
    'public.consume_ai_quota(uuid)',
    'public.create_author_identity_from_mention(uuid,integer,text,text,boolean)',
    'public.delete_attachment_with_cleanup(uuid)',
    'public.delete_empty_author_identity(uuid)',
    'public.delete_papers_with_attachment_cleanup(uuid[])',
    'public.finalize_attachment_upload(uuid,text,text,text,integer)',
    'public.get_ai_quota_status(uuid)',
    'public.get_current_user_access()',
    'public.handle_new_user()',
    'public.link_author_mention_to_identity(uuid,integer,text,uuid,text,boolean)',
    'public.merge_author_identities(uuid,uuid)',
    'public.refund_ai_quota(uuid)',
    'public.set_current_user_ai_model(text)',
    'public.set_current_user_ai_reasoning(text)',
    'public.unlink_author_mention_identity(uuid,integer)',
    'public.unmerge_author_identity(uuid)',
    'public.validate_author_mention_for_identity(uuid,uuid,integer,text)'];
  -- The 3 audited exceptions — never altered by this file.
  v_exceptions CONSTANT TEXT[] := ARRAY[
    'public.clear_author_identity_links_on_authors_change()',
    'public.refund_storage_quota()',
    'public.reject_attachment_over_cleanup_intent()'];
BEGIN
  -- ── 1a. Roles ───────────────────────────────────────────────────────────────
  IF to_regrole('authenticated') IS NULL OR to_regrole('anon') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'definer_pg_temp_last: one of the roles authenticated / anon / service_role does not exist';
  END IF;

  -- ── 1b. The two reviewed lists: 32 + 3, disjoint, every entry resolving ────
  IF cardinality(v_targets) <> 32 OR cardinality(v_exceptions) <> 3
     OR (SELECT count(DISTINCT s) FROM unnest(v_targets || v_exceptions) s) <> 35 THEN
    RAISE EXCEPTION 'definer_pg_temp_last: the reviewed lists are not 32 targets + 3 exceptions, disjoint';
  END IF;

  SELECT coalesce(string_agg(s, ', ' ORDER BY s), '') INTO v_text
  FROM unnest(v_targets || v_exceptions) s WHERE to_regprocedure(s) IS NULL;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'definer_pg_temp_last: reviewed function(s) missing: %', v_text;
  END IF;

  -- ── 1c. The SECURITY DEFINER inventory is exactly the audited 35 ──────────
  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef;
  IF v_count <> 35 THEN
    RAISE EXCEPTION 'definer_pg_temp_last: % SECURITY DEFINER functions in public; the audited inventory is 35', v_count;
  END IF;

  SELECT coalesce(string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text), '') INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
    AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_targets || v_exceptions) s);
  IF v_text <> '' THEN
    RAISE EXCEPTION 'definer_pg_temp_last: unaudited SECURITY DEFINER function(s) in public — re-review before any change: %', v_text;
  END IF;

  -- ── 1d. The three exceptions are exactly the audited bodies ────────────────
  -- Checked on its own, before the full shape, so drift here says what it means:
  -- the `search_path=public` exception was granted for these exact bodies only.
  SELECT coalesce(string_agg(e.sig || ' (found ' || coalesce(md5(p.prosrc), '<missing>') || ', audited ' || e.body_md5 || ')',
                             ', ' ORDER BY e.sig), '') INTO v_text
  FROM (VALUES
    ('public.clear_author_identity_links_on_authors_change()', 'a14c92dbd8485afff4d1600684b37565'),
    ('public.refund_storage_quota()',                          '3e20f43b80a908b309cb6335d8eb9360'),
    ('public.reject_attachment_over_cleanup_intent()',         '494f7297c23991bc8d28d4f81906e059')
  ) AS e(sig, body_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE md5(p.prosrc) IS DISTINCT FROM e.body_md5;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'definer_pg_temp_last: STOP — an audited search_path exception no longer has its audited body, so the exception no longer applies; re-audit its search-path requirements before changing or keeping it: %', v_text;
  END IF;

  -- ── 1e. All 35: exactly the reviewed shape ──────────────────────────────────
  -- One overload; owner postgres; SECURITY DEFINER; a plain function; the
  -- reviewed language, volatility, parallel mode (unsafe), strictness (not
  -- strict), leakproofness (not leakproof), SETOF posture, result, arguments with
  -- modes/defaults as rendered, `search_path=public` and nothing else, body
  -- digest, literal EXECUTE ACL, and the effective EXECUTE class across PUBLIC /
  -- anon / authenticated / service_role. One readable line per function, so a
  -- failure names the attribute that moved.
  WITH e(sig, exec, lang, vol, retset, result, args, body_md5) AS (VALUES
    -- Tier 1 — relation resolution on the write boundary
    ('public.bulk_add_paper_projects(uuid[],uuid[])', 'authenticated', 'plpgsql', 'v', false, 'void',
     'p_paper_ids uuid[], p_project_ids uuid[]', '1d1c91251a099af644cb9d416637e1cc'),
    ('public.bulk_add_paper_tags(uuid[],uuid[])', 'authenticated', 'plpgsql', 'v', false, 'void',
     'p_paper_ids uuid[], p_tag_ids uuid[]', '01da7404df6f887252f724c649d11fba'),
    ('public.bulk_set_paper_projects(uuid[],uuid[])', 'authenticated', 'plpgsql', 'v', false, 'void',
     'p_paper_ids uuid[], p_project_ids uuid[]', 'a348cebfcf3b393af9aff1b5a77cd1a6'),
    ('public.bulk_set_paper_tags(uuid[],uuid[])', 'authenticated', 'plpgsql', 'v', false, 'void',
     'p_paper_ids uuid[], p_tag_ids uuid[]', 'e3b6bcfec228d4cca4f52dc126765e32'),
    ('public.bulk_update_keywords(jsonb)', 'authenticated', 'plpgsql', 'v', false, 'void',
     'updates jsonb', 'c002702d05a14e7febd00feaf1e97786'),
    ('public.bulk_update_study_types(jsonb)', 'authenticated', 'plpgsql', 'v', false, 'void',
     'updates jsonb', '6086d69c0915c8a7c67089556b40041b'),
    ('public.merge_exact_duplicates(uuid,uuid[])', 'authenticated', 'plpgsql', 'v', false, 'void',
     'p_keep_id uuid, p_discard_ids uuid[]', 'b43400b3cdc51b5572efe81a80acdfab'),
    ('public.safe_bulk_insert_papers(uuid,jsonb)', 'authenticated', 'plpgsql', 'v', false, 'jsonb',
     'p_user_id uuid, p_papers jsonb', '119925245a5c3c8529ada3d2e10fba96'),
    ('public.set_paper_projects(uuid,uuid[])', 'authenticated', 'plpgsql', 'v', false, 'void',
     'p_paper_id uuid, p_project_ids uuid[]', '8104be4a8a25bfbca45b0aab4393d110'),
    ('public.set_paper_tags(uuid,uuid[])', 'authenticated', 'plpgsql', 'v', false, 'void',
     'p_paper_id uuid, p_tag_ids uuid[]', '8b0537b3964e5a1956a8d1e99bdaed82'),
    -- Tier 2 — type / transitive / path-resolution defense in depth
    ('public.attachment_object_has_live_metadata(text)', 'authenticated', 'sql', 's', false, 'boolean',
     'p_name text', '32b1776bcf781b7743ce09829aa4f2a8'),
    ('public.author_identity_effective_root(uuid,uuid)', '<nobody>', 'plpgsql', 's', false, 'uuid',
     'p_user_id uuid, p_identity_id uuid', '62e8bd4101b7a4e079dd1fcaf400bddf'),
    ('public.check_and_consume_storage_quota()', '<nobody>', 'plpgsql', 'v', false, 'trigger',
     '', 'be1c43f9f5ac9c8006958871b813364d'),
    ('public.clear_current_user_ai_model()', 'authenticated', 'plpgsql', 'v', true, 'TABLE(cleared boolean, reason text)',
     '', 'af5042ea3e29268fe4651826859a349c'),
    ('public.clear_current_user_ai_reasoning()', 'authenticated', 'plpgsql', 'v', true, 'TABLE(cleared boolean, reason text)',
     '', 'b73e9b41659169e052468338ef5b2960'),
    ('public.consume_ai_quota(uuid)', 'authenticated', 'plpgsql', 'v', true,
     'TABLE(allowed boolean, reason text, plan text, period_type text, used integer, quota integer, remaining integer, reset_at timestamp with time zone)',
     'p_user_id uuid', '8b3f8c3b380703c1ae8286db9745ad0d'),
    ('public.create_author_identity_from_mention(uuid,integer,text,text,boolean)', 'authenticated', 'plpgsql', 'v', false, 'jsonb',
     'p_paper_id uuid, p_author_index integer, p_expected_author text, p_preferred_name text DEFAULT NULL::text, p_replace_stale_existing boolean DEFAULT false',
     '463bd04a1e595edcb0a54445e6282f5d'),
    ('public.delete_attachment_with_cleanup(uuid)', 'authenticated', 'plpgsql', 'v', false, 'void',
     'p_attachment_id uuid', '23833e1f7971c8d68d118f546f9b86d5'),
    ('public.delete_empty_author_identity(uuid)', 'authenticated', 'plpgsql', 'v', false, 'boolean',
     'p_identity_id uuid', '0719dacc18c247d0c8a2e9abe49580e5'),
    ('public.delete_papers_with_attachment_cleanup(uuid[])', 'authenticated', 'plpgsql', 'v', true,
     'TABLE(deleted_count integer, queued_count integer)',
     'p_paper_ids uuid[]', '91bf1072ea5a3e19adbf7aa4b344c47f'),
    ('public.finalize_attachment_upload(uuid,text,text,text,integer)', 'authenticated', 'plpgsql', 'v', true,
     'TABLE(status text, attachment_id uuid, attachment_paper_id uuid, attachment_user_id uuid, attachment_file_path text, attachment_file_name text, attachment_file_type text, attachment_size_bytes integer, attachment_created_at timestamp with time zone)',
     'p_paper_id uuid, p_file_path text, p_file_name text, p_file_type text, p_size_bytes integer', '4bdcc81492bc35022f01c930fdb91521'),
    ('public.get_ai_quota_status(uuid)', 'authenticated', 'plpgsql', 's', true,
     'TABLE(allowed boolean, reason text, plan text, plan_status text, period_type text, used integer, quota integer, remaining integer, reset_at timestamp with time zone, is_exempt boolean)',
     'p_user_id uuid', '212b9a3ed220e347e8d8ca486b6d83a1'),
    ('public.get_current_user_access()', 'authenticated', 'plpgsql', 's', true,
     'TABLE(role text, is_internal boolean, can_view_provider_quota boolean, ai_quota_exempt boolean, plan text, plan_status text, premium_taxonomy_enabled boolean, labs_team_enabled boolean, can_select_ai_model boolean)',
     '', 'ae71f19d36042f6d3b5be43d0dda2556'),
    ('public.handle_new_user()', '<nobody>', 'plpgsql', 'v', false, 'trigger',
     '', 'ddda5e7ec243d95c05ec82a0d0755e2c'),
    ('public.link_author_mention_to_identity(uuid,integer,text,uuid,text,boolean)', 'authenticated', 'plpgsql', 'v', false, 'jsonb',
     'p_paper_id uuid, p_author_index integer, p_expected_author text, p_identity_id uuid, p_resolution_basis text DEFAULT ''manual''::text, p_replace_existing boolean DEFAULT false',
     '7c8280beb98b16e074e6b641ab7e8e32'),
    ('public.merge_author_identities(uuid,uuid)', 'authenticated', 'plpgsql', 'v', false, 'jsonb',
     'p_source_identity_id uuid, p_target_identity_id uuid', '882f92bd6c74f280e447c220bb1f7b3c'),
    -- C47: server-only; service_role is its sole non-owner grantee.
    ('public.refund_ai_quota(uuid)', 'service_role', 'plpgsql', 'v', true,
     'TABLE(refunded boolean, period_type text, used integer)',
     'p_user_id uuid', '4224750ddbff3651e7e0aaa2576f4de4'),
    ('public.set_current_user_ai_model(text)', 'authenticated', 'plpgsql', 'v', true,
     'TABLE(saved boolean, reason text, preferred_model_id text, provider text, display_name text, updated_at timestamp with time zone, reasoning_reset boolean)',
     'p_model_id text', '42dba7efec3f38d7fe80fcbd1d88c2b5'),
    ('public.set_current_user_ai_reasoning(text)', 'authenticated', 'plpgsql', 'v', true,
     'TABLE(saved boolean, reason text, preferred_model_id text, preferred_reasoning_level text, updated_at timestamp with time zone)',
     'p_reasoning_level text', '2f3db6644683273bb8e3bcea2b3f3811'),
    ('public.unlink_author_mention_identity(uuid,integer)', 'authenticated', 'plpgsql', 'v', false, 'boolean',
     'p_paper_id uuid, p_author_index integer', '4058975cc65a515329d814730b192490'),
    ('public.unmerge_author_identity(uuid)', 'authenticated', 'plpgsql', 'v', false, 'boolean',
     'p_source_identity_id uuid', '562aff7cf24759cb2e7fde9da277a2df'),
    ('public.validate_author_mention_for_identity(uuid,uuid,integer,text)', '<nobody>', 'plpgsql', 'v', false, 'text',
     'p_user_id uuid, p_paper_id uuid, p_author_index integer, p_expected_author text', '1451cca899a21ea4954b4b805129ce5d'),
    -- The 3 audited exceptions (bodies also pinned in 1d)
    ('public.clear_author_identity_links_on_authors_change()', '<nobody>', 'plpgsql', 'v', false, 'trigger',
     '', 'a14c92dbd8485afff4d1600684b37565'),
    ('public.refund_storage_quota()', '<nobody>', 'plpgsql', 'v', false, 'trigger',
     '', '3e20f43b80a908b309cb6335d8eb9360'),
    ('public.reject_attachment_over_cleanup_intent()', '<nobody>', 'plpgsql', 'v', false, 'trigger',
     '', '494f7297c23991bc8d28d4f81906e059')
  ),
  cmp AS (
    SELECT e.sig,
           (SELECT format('overloads=%s owner=%s secdef=%s kind=%s lang=%s vol=%s parallel=%s strict=%s leakproof=%s setof=%s result=%s args=[%s] config=%s acl=%s exec=%s body=%s',
                          (SELECT count(*) FROM pg_proc p2 WHERE p2.pronamespace = p.pronamespace AND p2.proname = p.proname),
                          pg_get_userbyid(p.proowner), p.prosecdef, p.prokind, l.lanname, p.provolatile, p.proparallel,
                          p.proisstrict, p.proleakproof, p.proretset,
                          pg_get_function_result(p.oid), pg_get_function_arguments(p.oid),
                          coalesce(p.proconfig::text, '<none>'), coalesce(p.proacl::text, '<default>'),
                          (SELECT coalesce(string_agg(r, ',' ORDER BY r COLLATE "C"), '<nobody>')
                             FROM unnest(ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']) r
                            WHERE CASE WHEN r = 'PUBLIC'
                                       THEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                                     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                                       ELSE has_function_privilege(r, p.oid, 'EXECUTE') END),
                          md5(p.prosrc))
              FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
             WHERE p.oid = to_regprocedure(e.sig)) AS found,
           -- (format's %s renders a boolean with its output function: t / f)
           format('overloads=1 owner=postgres secdef=t kind=f lang=%s vol=%s parallel=u strict=f leakproof=f setof=%s result=%s args=[%s] config={search_path=public} acl=%s exec=%s body=%s',
                  e.lang, e.vol, e.retset, e.result, e.args,
                  CASE e.exec WHEN 'authenticated' THEN '{postgres=X/postgres,authenticated=X/postgres}'
                              WHEN 'service_role'  THEN '{postgres=X/postgres,service_role=X/postgres}'
                              ELSE '{postgres=X/postgres}' END,
                  e.exec, e.body_md5) AS expected
      FROM e
  )
  SELECT (SELECT count(*) FROM e),
         coalesce(string_agg(cmp.sig || E'\n  found:    ' || coalesce(cmp.found, '<missing>')
                                     || E'\n  expected: ' || cmp.expected, E'\n' ORDER BY cmp.sig), '')
    INTO v_count, v_text
  FROM cmp WHERE cmp.found IS DISTINCT FROM cmp.expected;
  IF v_count <> 35 THEN
    RAISE EXCEPTION 'definer_pg_temp_last: the reviewed shape table has % rows, not 35', v_count;
  END IF;
  IF v_text <> '' THEN
    RAISE EXCEPTION E'definer_pg_temp_last: function(s) not in the audited shape:\n%', v_text;
  END IF;

  -- ── 1f. The execution matrix of the surface, as counts ──────────────────────
  -- Implied by 1e; restated as the numbers the audit and the Security Advisor use.
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND prosecdef AND has_function_privilege('authenticated', oid, 'EXECUTE');
  IF v_count <> 27 THEN
    RAISE EXCEPTION 'definer_pg_temp_last: % authenticated-executable SECURITY DEFINER functions in public; the audited inventory is 27', v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
                AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                     OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                 WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))) THEN
    RAISE EXCEPTION 'definer_pg_temp_last: anon or PUBLIC can execute a public SECURITY DEFINER function';
  END IF;
  SELECT coalesce(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text), '') INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_text IS DISTINCT FROM 'public.refund_ai_quota(uuid)'::regprocedure::text THEN
    RAISE EXCEPTION 'definer_pg_temp_last: service_role executes % among the SECURITY DEFINER functions; the audited set is refund_ai_quota(uuid) only', v_text;
  END IF;

  -- ── 1g. Where the 35 are bound: triggers and the Storage policy ─────────────
  -- Rendered without search_path-dependent text (schema.name from the catalogs),
  -- so the comparison reads the same under any runner. Five trigger bindings and
  -- one policy dependency — attachments_owner_delete on storage.objects calls
  -- attachment_object_has_live_metadata(text).
  SELECT coalesce(string_agg(x.line, E'\n' ORDER BY x.line), '') INTO v_text
  FROM (SELECT rn.nspname || '.' || c.relname || '|' || t.tgname || '|' || fn.nspname || '.' || f.proname
               || '|' || t.tgenabled::text || '|' || t.tgtype::text || '|' || t.tgnargs::text || '|' || (t.tgqual IS NULL)::text AS line
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace rn ON rn.oid = c.relnamespace
          JOIN pg_proc f ON f.oid = t.tgfoid JOIN pg_namespace fn ON fn.oid = f.pronamespace
         WHERE f.pronamespace = 'public'::regnamespace AND f.prosecdef AND NOT t.tgisinternal
        UNION ALL
        SELECT 'dep|' || d.classid::regclass::text || '|'
               || coalesce((SELECT pn.nspname || '.' || pc.relname || '.' || pol.polname || '|' || pol.polcmd::text
                              FROM pg_policy pol JOIN pg_class pc ON pc.oid = pol.polrelid
                              JOIN pg_namespace pn ON pn.oid = pc.relnamespace
                             WHERE d.classid = 'pg_policy'::regclass AND pol.oid = d.objid), '<non-policy>')
               || '|' || fn.nspname || '.' || f.proname || '|' || d.deptype::text
          FROM pg_depend d
          JOIN pg_proc f ON f.oid = d.refobjid JOIN pg_namespace fn ON fn.oid = f.pronamespace
         WHERE d.refclassid = 'pg_proc'::regclass AND d.classid <> 'pg_trigger'::regclass
           AND f.pronamespace = 'public'::regnamespace AND f.prosecdef) x;
  SELECT string_agg(w.line, E'\n' ORDER BY w.line) INTO v_want
  FROM (VALUES
    ('auth.users|on_auth_user_created|public.handle_new_user|O|5|0|true'),
    ('dep|pg_policy|storage.objects.attachments_owner_delete|d|public.attachment_object_has_live_metadata|n'),
    ('public.paper_attachments|trg_paper_attachments_block_cleanup_intent|public.reject_attachment_over_cleanup_intent|O|7|0|true'),
    ('public.paper_attachments|trg_paper_attachments_check_storage_quota|public.check_and_consume_storage_quota|O|7|0|true'),
    ('public.paper_attachments|trg_paper_attachments_refund_storage_quota|public.refund_storage_quota|O|9|0|true'),
    ('public.papers|papers_clear_author_identity_links_on_authors_change|public.clear_author_identity_links_on_authors_change|O|17|0|false')
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'definer_pg_temp_last: the trigger / policy bindings of the 35 are not the reviewed set.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  -- ── 1h. Snapshots for section 3 ────────────────────────────────────────────
  -- Transaction-local; read back in section 3.

  -- Each target as its WHOLE pg_proc row except proconfig — oid included, so a
  -- drop-and-recreate could not pass as an ALTER.
  PERFORM set_config('paperlume.definer_pg_temp_last.pre_targets',
    (SELECT string_agg(p.oid::regprocedure::text || '=' || md5((to_jsonb(p.*) - 'proconfig')::text), E'\n'
                       ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s)), true);

  -- Each exception as its WHOLE pg_proc row, proconfig included: nothing moves.
  PERFORM set_config('paperlume.definer_pg_temp_last.pre_exceptions',
    (SELECT string_agg(p.oid::regprocedure::text || '=' || md5(to_jsonb(p.*)::text), E'\n'
                       ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_exceptions) s)), true);

  -- Every OTHER function in public, whole rows: C49's five INVOKER read RPCs,
  -- the pg_catalog-pinned helpers and every remaining routine.
  PERFORM set_config('paperlume.definer_pg_temp_last.pre_others',
    (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_targets || v_exceptions) s)), true);

  -- The authenticated-executable SECURITY DEFINER set (27), by name.
  PERFORM set_config('paperlume.definer_pg_temp_last.pre_authenticated_definer',
    (SELECT string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')), true);

  -- Trigger bindings and pg_depend dependents, WITH their OIDs, and the full
  -- definition of every policy that depends on one of the 35.
  PERFORM set_config('paperlume.definer_pg_temp_last.pre_bindings',
    (SELECT coalesce(string_agg(x.line, E'\n' ORDER BY x.line), '')
       FROM (SELECT 'trg|' || t.oid::text || '|' || t.tgrelid::text || '|' || t.tgfoid::text || '|' || t.tgname
                    || '|' || t.tgenabled::text || '|' || md5(pg_get_triggerdef(t.oid)) AS line
               FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
              WHERE f.pronamespace = 'public'::regnamespace AND f.prosecdef AND NOT t.tgisinternal
             UNION ALL
             SELECT 'dep|' || d.classid::text || '|' || d.objid::text || '|' || d.objsubid::text || '|'
                    || d.refobjid::text || '|' || d.deptype::text
               FROM pg_depend d JOIN pg_proc f ON f.oid = d.refobjid
              WHERE d.refclassid = 'pg_proc'::regclass
                AND f.pronamespace = 'public'::regnamespace AND f.prosecdef
             UNION ALL
             SELECT 'pol|' || pol.oid::text || '|' || pol.polrelid::text || '|' || pol.polname || '|' || pol.polcmd::text
                    || '|' || pol.polpermissive::text || '|' || pol.polroles::text
                    || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>')
                    || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')
               FROM pg_policy pol
              WHERE pol.oid IN (SELECT d.objid FROM pg_depend d JOIN pg_proc f ON f.oid = d.refobjid
                                 WHERE d.classid = 'pg_policy'::regclass AND d.refclassid = 'pg_proc'::regclass
                                   AND f.pronamespace = 'public'::regnamespace AND f.prosecdef)) x), true);
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The change
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 32 statements, one attribute each, exact signatures. No CREATE OR REPLACE: the
-- reviewed bodies are kept byte-for-byte, and section 3 proves it. The three
-- audited exceptions have no statement here by design.

-- Tier 1 — relation resolution on the write boundary
ALTER FUNCTION public.bulk_add_paper_projects(uuid[],uuid[])
  SET search_path = public, pg_temp;
ALTER FUNCTION public.bulk_add_paper_tags(uuid[],uuid[])
  SET search_path = public, pg_temp;
ALTER FUNCTION public.bulk_set_paper_projects(uuid[],uuid[])
  SET search_path = public, pg_temp;
ALTER FUNCTION public.bulk_set_paper_tags(uuid[],uuid[])
  SET search_path = public, pg_temp;
ALTER FUNCTION public.bulk_update_keywords(jsonb)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.bulk_update_study_types(jsonb)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.merge_exact_duplicates(uuid,uuid[])
  SET search_path = public, pg_temp;
ALTER FUNCTION public.safe_bulk_insert_papers(uuid,jsonb)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.set_paper_projects(uuid,uuid[])
  SET search_path = public, pg_temp;
ALTER FUNCTION public.set_paper_tags(uuid,uuid[])
  SET search_path = public, pg_temp;

-- Tier 2 — type / transitive / path-resolution defense in depth
ALTER FUNCTION public.attachment_object_has_live_metadata(text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.author_identity_effective_root(uuid,uuid)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.check_and_consume_storage_quota()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.clear_current_user_ai_model()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.clear_current_user_ai_reasoning()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.consume_ai_quota(uuid)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.create_author_identity_from_mention(uuid,integer,text,text,boolean)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.delete_attachment_with_cleanup(uuid)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.delete_empty_author_identity(uuid)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.delete_papers_with_attachment_cleanup(uuid[])
  SET search_path = public, pg_temp;
ALTER FUNCTION public.finalize_attachment_upload(uuid,text,text,text,integer)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.get_ai_quota_status(uuid)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.get_current_user_access()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_user()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.link_author_mention_to_identity(uuid,integer,text,uuid,text,boolean)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.merge_author_identities(uuid,uuid)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.refund_ai_quota(uuid)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.set_current_user_ai_model(text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.set_current_user_ai_reasoning(text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.unlink_author_mention_identity(uuid,integer)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.unmerge_author_identity(uuid)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.validate_author_mention_for_identity(uuid,uuid,integer,text)
  SET search_path = public, pg_temp;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed verification — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

DO $verify$
DECLARE
  v_text       TEXT;
  v_base       TEXT;
  v_count      INTEGER;
  v_targets    CONSTANT TEXT[] := ARRAY[
    'public.bulk_add_paper_projects(uuid[],uuid[])',
    'public.bulk_add_paper_tags(uuid[],uuid[])',
    'public.bulk_set_paper_projects(uuid[],uuid[])',
    'public.bulk_set_paper_tags(uuid[],uuid[])',
    'public.bulk_update_keywords(jsonb)',
    'public.bulk_update_study_types(jsonb)',
    'public.merge_exact_duplicates(uuid,uuid[])',
    'public.safe_bulk_insert_papers(uuid,jsonb)',
    'public.set_paper_projects(uuid,uuid[])',
    'public.set_paper_tags(uuid,uuid[])',
    'public.attachment_object_has_live_metadata(text)',
    'public.author_identity_effective_root(uuid,uuid)',
    'public.check_and_consume_storage_quota()',
    'public.clear_current_user_ai_model()',
    'public.clear_current_user_ai_reasoning()',
    'public.consume_ai_quota(uuid)',
    'public.create_author_identity_from_mention(uuid,integer,text,text,boolean)',
    'public.delete_attachment_with_cleanup(uuid)',
    'public.delete_empty_author_identity(uuid)',
    'public.delete_papers_with_attachment_cleanup(uuid[])',
    'public.finalize_attachment_upload(uuid,text,text,text,integer)',
    'public.get_ai_quota_status(uuid)',
    'public.get_current_user_access()',
    'public.handle_new_user()',
    'public.link_author_mention_to_identity(uuid,integer,text,uuid,text,boolean)',
    'public.merge_author_identities(uuid,uuid)',
    'public.refund_ai_quota(uuid)',
    'public.set_current_user_ai_model(text)',
    'public.set_current_user_ai_reasoning(text)',
    'public.unlink_author_mention_identity(uuid,integer)',
    'public.unmerge_author_identity(uuid)',
    'public.validate_author_mention_for_identity(uuid,uuid,integer,text)'];
  v_exceptions CONSTANT TEXT[] := ARRAY[
    'public.clear_author_identity_links_on_authors_change()',
    'public.refund_storage_quota()',
    'public.reject_attachment_over_cleanup_intent()'];
BEGIN
  -- ── 3a. Exactly the 32 carry `public, pg_temp`, and exactly the 3 keep `public`
  -- Literal comparison of the whole array: `public` first, `pg_temp` present and
  -- last, no other schema, no second GUC.
  SELECT coalesce(string_agg(s || ' = ' || coalesce(p.proconfig::text, '<none>'), ', ' ORDER BY s), '') INTO v_text
  FROM unnest(v_targets) s LEFT JOIN pg_proc p ON p.oid = to_regprocedure(s)
  WHERE p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'];
  IF v_text <> '' THEN
    RAISE EXCEPTION 'definer_pg_temp_last: target(s) without exactly search_path=public, pg_temp: %', v_text;
  END IF;

  SELECT coalesce(string_agg(s || ' = ' || coalesce(p.proconfig::text, '<none>'), ', ' ORDER BY s), '') INTO v_text
  FROM unnest(v_exceptions) s LEFT JOIN pg_proc p ON p.oid = to_regprocedure(s)
  WHERE p.proconfig IS DISTINCT FROM ARRAY['search_path=public'];
  IF v_text <> '' THEN
    RAISE EXCEPTION 'definer_pg_temp_last: audited exception(s) no longer at exactly search_path=public: %', v_text;
  END IF;

  -- The distribution over the whole inventory: 32 + 3 = 35, nothing else.
  SELECT string_agg(cfg || '=' || n, ' ' ORDER BY cfg) INTO v_text
  FROM (SELECT coalesce(proconfig::text, '<none>') AS cfg, count(*) AS n FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace AND prosecdef GROUP BY 1) d;
  IF v_text IS DISTINCT FROM '{"search_path=public, pg_temp"}=32 {search_path=public}=3' THEN
    RAISE EXCEPTION 'definer_pg_temp_last: public SECURITY DEFINER search_path distribution is %, expected 32 hardened + 3 exceptions', v_text;
  END IF;

  -- ── 3b. Targets: the whole row except proconfig is unchanged ────────────────
  -- oid, body, signature, argument names/modes/defaults, result, language,
  -- volatility, parallel, strictness, leakproofness, SETOF, cost/rows, owner,
  -- SECURITY DEFINER and ACL all sit in that row.
  v_base := current_setting('paperlume.definer_pg_temp_last.pre_targets', true);
  SELECT string_agg(p.oid::regprocedure::text || '=' || md5((to_jsonb(p.*) - 'proconfig')::text), E'\n'
                    ORDER BY p.oid::regprocedure::text) INTO v_text
  FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s);
  IF coalesce(v_base, '') = '' OR v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION E'definer_pg_temp_last: an attribute other than proconfig changed on a target.\nbefore:\n%\nafter:\n%', v_base, v_text;
  END IF;

  -- ── 3c. Exceptions: the whole row, proconfig included, is unchanged ─────────
  v_base := current_setting('paperlume.definer_pg_temp_last.pre_exceptions', true);
  SELECT string_agg(p.oid::regprocedure::text || '=' || md5(to_jsonb(p.*)::text), E'\n'
                    ORDER BY p.oid::regprocedure::text) INTO v_text
  FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_exceptions) s);
  IF coalesce(v_base, '') = '' OR v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'definer_pg_temp_last: an audited exception changed (before: %; after: %)', v_base, v_text;
  END IF;

  -- Belt and braces on the fact review cares most about — no body was touched —
  -- restated literally: the three exception digests, and one digest over the
  -- 32 target body digests (identical in Production and on a replay).
  IF (SELECT string_agg(md5(prosrc), ',' ORDER BY md5(prosrc) COLLATE "C") FROM pg_proc
       WHERE oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_exceptions) s))
     IS DISTINCT FROM '3e20f43b80a908b309cb6335d8eb9360,494f7297c23991bc8d28d4f81906e059,a14c92dbd8485afff4d1600684b37565' THEN
    RAISE EXCEPTION 'definer_pg_temp_last: an audited exception body changed';
  END IF;
  IF (SELECT md5(string_agg(md5(prosrc), ',' ORDER BY md5(prosrc) COLLATE "C")) FROM pg_proc
       WHERE oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s))
     IS DISTINCT FROM '332e2da923c5f3689af28000dff0f952' THEN
    RAISE EXCEPTION 'definer_pg_temp_last: a target body changed';
  END IF;

  -- ── 3d. No other function in public moved ───────────────────────────────────
  v_base := current_setting('paperlume.definer_pg_temp_last.pre_others', true);
  IF coalesce(v_base, '') = ''
     OR (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_targets || v_exceptions) s)) IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'definer_pg_temp_last: a function outside the 35 changed';
  END IF;

  -- ── 3e. Inventory and execution matrix unchanged: 35 / 27 / anon 0 / PUBLIC 0
  --        / service_role = refund_ai_quota only ─────────────────────────────
  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef;
  IF v_count <> 35 THEN
    RAISE EXCEPTION 'definer_pg_temp_last: % SECURITY DEFINER functions in public after the change; expected 35', v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
                AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_targets || v_exceptions) s)) THEN
    RAISE EXCEPTION 'definer_pg_temp_last: the SECURITY DEFINER set changed';
  END IF;

  SELECT count(*), string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text) INTO v_count, v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_count <> 27 OR v_text IS DISTINCT FROM current_setting('paperlume.definer_pg_temp_last.pre_authenticated_definer', true) THEN
    RAISE EXCEPTION 'definer_pg_temp_last: the authenticated-executable SECURITY DEFINER set is not the unchanged 27 (count %)', v_count;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
                AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                     OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                 WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))) THEN
    RAISE EXCEPTION 'definer_pg_temp_last: anon or PUBLIC can execute a public SECURITY DEFINER function after the change';
  END IF;

  SELECT coalesce(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text), '') INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_text IS DISTINCT FROM 'public.refund_ai_quota(uuid)'::regprocedure::text
     OR (SELECT proacl::text FROM pg_proc WHERE oid = 'public.refund_ai_quota(uuid)'::regprocedure)
          IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'definer_pg_temp_last: the C47 service-role-only contract of refund_ai_quota changed';
  END IF;

  -- ── 3f. Trigger bindings, dependents and the Storage policy are unchanged ───
  IF (SELECT coalesce(string_agg(x.line, E'\n' ORDER BY x.line), '')
        FROM (SELECT 'trg|' || t.oid::text || '|' || t.tgrelid::text || '|' || t.tgfoid::text || '|' || t.tgname
                     || '|' || t.tgenabled::text || '|' || md5(pg_get_triggerdef(t.oid)) AS line
                FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
               WHERE f.pronamespace = 'public'::regnamespace AND f.prosecdef AND NOT t.tgisinternal
              UNION ALL
              SELECT 'dep|' || d.classid::text || '|' || d.objid::text || '|' || d.objsubid::text || '|'
                     || d.refobjid::text || '|' || d.deptype::text
                FROM pg_depend d JOIN pg_proc f ON f.oid = d.refobjid
               WHERE d.refclassid = 'pg_proc'::regclass
                 AND f.pronamespace = 'public'::regnamespace AND f.prosecdef
              UNION ALL
              SELECT 'pol|' || pol.oid::text || '|' || pol.polrelid::text || '|' || pol.polname || '|' || pol.polcmd::text
                     || '|' || pol.polpermissive::text || '|' || pol.polroles::text
                     || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>')
                     || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')
                FROM pg_policy pol
               WHERE pol.oid IN (SELECT d.objid FROM pg_depend d JOIN pg_proc f ON f.oid = d.refobjid
                                  WHERE d.classid = 'pg_policy'::regclass AND d.refclassid = 'pg_proc'::regclass
                                    AND f.pronamespace = 'public'::regnamespace AND f.prosecdef)) x)
     IS DISTINCT FROM current_setting('paperlume.definer_pg_temp_last.pre_bindings', true)
     OR coalesce(current_setting('paperlume.definer_pg_temp_last.pre_bindings', true), '') = '' THEN
    RAISE EXCEPTION 'definer_pg_temp_last: a trigger binding, dependency or the Storage policy of the 35 changed';
  END IF;

  -- ── 3g. Catalog-only: this transaction wrote no row ─────────────────────────
  v_base := current_setting('paperlume.definer_pg_temp_last.xact_writes_at_start', true);
  IF coalesce(v_base, '') = '' THEN
    RAISE EXCEPTION 'definer_pg_temp_last: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  SELECT string_agg(
           n.nspname || '.' || c.relname || '=' || (pg_stat_get_xact_tuples_inserted(c.oid)
                                                    + pg_stat_get_xact_tuples_updated(c.oid)
                                                    + pg_stat_get_xact_tuples_deleted(c.oid)),
           ' ' ORDER BY n.nspname, c.relname) INTO v_text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p');
  IF v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'definer_pg_temp_last: this transaction wrote application rows (row writes at start: %; now: %)', v_base, v_text;
  END IF;
END
$verify$;

COMMIT;
