-- SEC-AI-QUOTA-REFUND-AUTHORITY-001 — make the AI-quota refund a server-only
-- operation.
--
-- WHAT WAS WRONG
-- ─────────────────────────────────────────────────────────────────────────────
-- `public.refund_ai_quota(uuid)` was executable by `authenticated`, and its only
-- check was `p_user_id = auth.uid()`. After that it decremented the caller's
-- `usage_counters.used` by one, unconditionally. Nothing tied a refund to a
-- consumption, to a failed provider call, or to anything else that happened
-- earlier — no reservation id, no provider event, no one-time token.
--
-- The grant existed because both generation Edge Functions called the RPC
-- through the CALLER-SCOPED client (anon key + the user's own bearer token), so
-- the RPC had to see the user's `auth.uid()`. But that same grant let any signed-
-- in browser call `POST /rest/v1/rpc/refund_ai_quota` directly with its own id
-- and hand itself back as many units as it liked: consume 15, refund 15, consume
-- 15 more, repeat. AI usage stopped being bounded (decision C3), and because
-- Analyze and organization suggestions share one `ai_analysis` counter and one
-- provider project, one account could spend the project's shared provider quota
-- for everyone. The prerequisite was an ordinary signed-up account; a Free
-- account sufficed. Reproduced on a disposable local replay whose function body
-- is byte-identical to Production (md5 of prosrc below); never reproduced
-- against Production.
--
-- WHAT THIS MIGRATION DOES
-- ─────────────────────────────────────────────────────────────────────────────
-- It moves the refund's AUTHORITY from the caller's identity to the server:
--
--   before:  EXECUTE = owner + authenticated;  body requires p_user_id = auth.uid()
--   after:   EXECUTE = owner + service_role;   body trusts the server-supplied id
--
-- Quota CONSUMPTION does not move. `consume_ai_quota` stays authenticated-only
-- with its auth.uid() guard, because spending your own unit is exactly the
-- capability a caller should have. Only the reversal — the operation that GIVES
-- a unit back — becomes something a browser cannot reach.
--
-- The target user id now comes from trusted server code: `analyze-paper` and
-- `suggest-paper-organization` call the RPC through a dedicated client built
-- from the platform-provided secret key (the same `selectEdgeSecretKey` rule the
-- telemetry writer and `delete-account` use), with NO caller Authorization
-- header, and pass the id their own `auth.getUser()` just authenticated — never
-- a request field. The `service_role` caller has no `auth.uid()`, which is why
-- the body cannot keep the old comparison: under the new authority it would
-- refuse every legitimate call.
--
-- WHY BODY AND ACL CHANGE IN ONE TRANSACTION
-- ─────────────────────────────────────────────────────────────────────────────
-- Either change alone is a defect:
--
--   * the new body with the OLD grant would let any browser refund ANY user's
--     counter — strictly worse than the bug being fixed;
--   * the new grant with the OLD body would refuse every server call (no
--     auth.uid()), so refunds would silently stop.
--
-- So the authority flips atomically: the file is explicitly transactional
-- (`supabase db reset` runs statements in autocommit; see the rationale in
-- 20260910212202), and inside the transaction `authenticated` loses EXECUTE
-- BEFORE the body is replaced and `service_role` gains it only AFTER. There is
-- no committed state, and not even an intermediate in-transaction state, in
-- which the server-style body is executable by `authenticated`.
--
-- WHAT IS PRESERVED EXACTLY
-- ─────────────────────────────────────────────────────────────────────────────
-- The signature `refund_ai_quota(p_user_id uuid) RETURNS TABLE(refunded boolean,
-- period_type text, used integer)` — so generated TypeScript types do not change
-- — and every accounting rule: the monthly bucket when `ai_monthly_quota > 0`,
-- else the lifetime bucket when `ai_lifetime_quota > 0` OR the user is
-- `ai_quota_exempt` (C28), feature `ai_analysis`, the current UTC month start,
-- `GREATEST(used - 1, 0)`, `(false, NULL, 0)` for a missing entitlement or no
-- configured bucket, and `(false, period_type, 0)` for a missing counter row.
-- The one behavioural change inside the body is the guard: a NULL target is
-- still refused with an exception (as before), and a non-NULL target is no
-- longer compared with `auth.uid()`.
--
-- WHAT THIS MIGRATION EXPLICITLY DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
--   * It does NOT change `consume_ai_quota` or `get_ai_quota_status` — body or
--     privileges. Both are pinned below and re-verified after the change.
--   * It does NOT change any quota number, plan, entitlement, counter, table,
--     column, policy, RLS setting or default privilege, and it writes no row.
--     Section 5 checks the counter and entitlement tables against this
--     transaction's own statistics, so it does not need, and does not ask for,
--     a pause in AI traffic while it runs.
--   * It does NOT grant `service_role` anything else. `service_role` held
--     EXECUTE on NO SECURITY DEFINER function in `public` before this
--     migration (20260802025704 removed it everywhere); after it, it holds
--     exactly this one. The verification block below fails if that is not so.
--   * It does NOT add a reservation token or tie a refund to a specific
--     consumption. The server is trusted to refund only after a unit it
--     consumed was not delivered; binding the two cryptographically is a
--     larger design the owner chose not to take now.
--
-- ROLLOUT ORDER (for the separate merge/deploy task; nothing here deploys)
-- ─────────────────────────────────────────────────────────────────────────────
-- Apply this migration FIRST, then deploy BOTH `analyze-paper` and
-- `suggest-paper-organization` from the same merge commit. In the interval, the
-- previously deployed functions' caller-scoped refund call is denied with
-- 42501; refund is best-effort and swallows its own failure, so the ORIGINAL
-- provider error still reaches the user and successful operations are
-- unaffected — the only cost is that a unit consumed by a failed attempt in
-- that window is not given back. No authenticated fallback is kept to cover the
-- window: that fallback would be the defect itself.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- Prefer fixing forward. Restoring the previous body and the `authenticated`
-- grant would deliberately RE-OPEN the self-refund defect, so it is a security
-- rollback, not a configuration toggle, and it needs the generation functions
-- rolled back too (they refund as service_role). The reviewed procedure is in
-- docs/deployment.md §6.8; it is not applied anywhere.
--
-- Durable decision: C47. Bucket-selection lineage: 20260521020000 (C8/C10),
-- 20260725090000 (C28 exemption), 20260802025704 (grant hardening).

BEGIN;


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context, and this transaction's own write counters
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only the grantor can revoke a grant, and every ACL entry on this function was
-- granted by `postgres`, which also owns it. Running as anything else would
-- turn the REVOKE below into a silent no-op.
--
-- Section 5 proves that THIS transaction inserted, updated or deleted no
-- `usage_counters` or `user_entitlements` row. It does so from PostgreSQL's
-- per-transaction table statistics (`pg_stat_get_xact_tuples_*`), which live in
-- this backend's own memory and count only this backend's work: another
-- session's writes, committed or not, never appear in them. Legitimate quota
-- traffic that runs while this migration does — a `consume_ai_quota` from a
-- live user — therefore cannot fail the check, which a row-timestamp or
-- row-count test could not promise (any snapshot taken after that session
-- commits would see its row).
--
-- The counters are captured HERE, before anything changes, and section 5
-- compares against this baseline rather than against zero: a backend keeps an
-- earlier, already-committed transaction's counts pending until its next
-- periodic flush, which happens only while idle and at most about once a
-- second, so a runner that wrote either table moments earlier on the same
-- connection would otherwise look like this file's write. Inside a transaction
-- nothing is flushed, so the baseline stays exact until COMMIT. It is kept with
-- set_config(..., true), which lasts exactly as long as this transaction; a
-- runner that stripped the BEGIN above would lose it, and section 5 fails
-- closed on that. With `track_counts` off every counter stays at zero and the
-- check would prove nothing, so that is refused up front (autovacuum needs
-- `track_counts` too, so a healthy database always has it on).

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'ai_quota_refund_authority: must run as postgres (current_user is %) — only the grantor can revoke the authenticated grant',
      current_user;
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: track_counts is off, so the no-write self-check could not observe anything';
  END IF;
  PERFORM set_config(
    'ai_quota_refund_authority.xact_writes_at_start',
    format('usage_counters=%s user_entitlements=%s',
      pg_stat_get_xact_tuples_inserted('public.usage_counters'::regclass)
        + pg_stat_get_xact_tuples_updated('public.usage_counters'::regclass)
        + pg_stat_get_xact_tuples_deleted('public.usage_counters'::regclass),
      pg_stat_get_xact_tuples_inserted('public.user_entitlements'::regclass)
        + pg_stat_get_xact_tuples_updated('public.user_entitlements'::regclass)
        + pg_stat_get_xact_tuples_deleted('public.user_entitlements'::regclass)),
    true);
END
$ctx$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Preconditions — the exact state this change was reviewed against
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Nothing here repairs unexpected state. If any check is false, the whole file
-- rolls back before a single privilege or body changes.

DO $pre$
DECLARE
  v_count INTEGER;
  v_fn    TEXT;
BEGIN
  -- ── Exactly one refund_ai_quota, and it is the (uuid) one ────────────────
  -- A second overload anywhere in `public` would be a second, unreviewed entry
  -- point with the same name that this migration would leave untouched.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'refund_ai_quota';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: % refund_ai_quota overload(s) in public; expected exactly 1', v_count;
  END IF;
  IF to_regprocedure('public.refund_ai_quota(uuid)') IS NULL THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: public.refund_ai_quota(uuid) does not exist';
  END IF;

  -- ── Its security shape and signature ─────────────────────────────────────
  PERFORM 1
  FROM pg_proc p
  WHERE p.oid = 'public.refund_ai_quota(uuid)'::regprocedure
    AND p.proowner = 'postgres'::regrole
    AND p.prosecdef
    AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
    AND p.proconfig = ARRAY['search_path=public']
    AND p.proretset
    AND p.proargnames = ARRAY['p_user_id','refunded','period_type','used']
    AND pg_get_function_result(p.oid) = 'TABLE(refunded boolean, period_type text, used integer)';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: refund_ai_quota is not the reviewed shape (owner postgres, SECURITY DEFINER, plpgsql, search_path=public, TABLE(refunded, period_type, used))';
  END IF;

  -- ── The body being replaced is exactly the reviewed caller-scoped body ────
  -- md5 of pg_proc.prosrc: the text between the `$$` tags of the
  -- CREATE OR REPLACE in 20260725090000, byte-identical in Production (verified
  -- read-only on 2026-09-24). It is the body with the `p_user_id = auth.uid()`
  -- guard and the C28 exempt-bucket selection this migration preserves. A body
  -- that drifted by any route is refused rather than overwritten unseen.
  IF (SELECT md5(p.prosrc) FROM pg_proc p
        WHERE p.oid = 'public.refund_ai_quota(uuid)'::regprocedure)
     IS DISTINCT FROM '36d1bdb04fc5d163a04cc32afce0ee66' THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: refund_ai_quota body is not the reviewed 20260725090000 definition';
  END IF;
  -- Restated as readable facts, so a failure says what is missing.
  IF position('ai_quota_exempt' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.refund_ai_quota(uuid)'::regprocedure)) = 0
     OR position('p_user_id <> auth.uid()' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.refund_ai_quota(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: refund_ai_quota lacks the exempt bucket or the caller guard it is expected to have';
  END IF;

  -- ── The accepted pre-state EXECUTE matrix: owner + authenticated, nobody else
  -- An allowlist judging every grantee, then each role by name so a failure
  -- names it. PUBLIC is grantee 0.
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.refund_ai_quota(uuid)'::regprocedure
      AND a.privilege_type = 'EXECUTE'
      AND a.grantee NOT IN (p.proowner, 'authenticated'::regrole::oid)
  ) THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: refund_ai_quota is executable by a role other than its owner and authenticated';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.refund_ai_quota(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: authenticated cannot execute refund_ai_quota — not the reviewed pre-state';
  END IF;
  IF has_function_privilege('anon', 'public.refund_ai_quota(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: anon can execute refund_ai_quota';
  END IF;
  IF has_function_privilege('service_role', 'public.refund_ai_quota(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: service_role can already execute refund_ai_quota';
  END IF;

  -- ── The new grantee exists ────────────────────────────────────────────────
  IF to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: role service_role does not exist';
  END IF;

  -- ── service_role reaches no SECURITY DEFINER function in public today ─────
  -- This migration is meant to add exactly ONE such grant. Starting from a
  -- non-empty set would make the postcondition's "exactly one" meaningless.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: service_role already executes % SECURITY DEFINER function(s) in public', v_count;
  END IF;

  -- ── The two sibling quota RPCs are the reviewed ones ──────────────────────
  -- The refund mirrors consume_ai_quota's bucket selection; if consume had
  -- changed, the preserved refund rules could target the wrong bucket. Both
  -- digests are byte-identical in Production (verified read-only 2026-09-24).
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.consume_ai_quota(uuid)'::regprocedure)
     IS DISTINCT FROM '8b3f8c3b380703c1ae8286db9745ad0d' THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: consume_ai_quota body is not the reviewed 20260725090000 definition';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_ai_quota_status(uuid)'::regprocedure)
     IS DISTINCT FROM '212b9a3ed220e347e8d8ca486b6d83a1' THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: get_ai_quota_status body is not the reviewed 20260725090000 definition';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.consume_ai_quota(uuid)', 'public.get_ai_quota_status(uuid)'] LOOP
    IF NOT has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'ai_quota_refund_authority: authenticated cannot execute %', v_fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = v_fn::regprocedure
        AND a.privilege_type = 'EXECUTE'
        AND a.grantee NOT IN (p.proowner, 'authenticated'::regrole::oid)
    ) THEN
      RAISE EXCEPTION 'ai_quota_refund_authority: % is executable by a role other than its owner and authenticated', v_fn;
    END IF;
  END LOOP;
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Close the browser path FIRST
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every non-owner grantee, including the ones the precondition proved absent,
-- so the statement means "only the owner" whatever the pre-state was.

REVOKE ALL ON FUNCTION public.refund_ai_quota(uuid) FROM PUBLIC, anon, authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. The server-only body — same signature, same accounting, new authority
-- ═════════════════════════════════════════════════════════════════════════════
--
-- CREATE OR REPLACE keeps the owner and the (now owner-only) ACL.

CREATE OR REPLACE FUNCTION public.refund_ai_quota(p_user_id UUID)
RETURNS TABLE(
  refunded BOOLEAN,
  period_type TEXT,
  used INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_entitlement public.user_entitlements%ROWTYPE;
  v_exempt BOOLEAN;
  v_period_type TEXT;
  v_period_start TIMESTAMPTZ;
  v_new_used INTEGER;
BEGIN
  -- SERVER-ONLY. Authority is the EXECUTE grant (service_role only), not the
  -- caller's identity: p_user_id is supplied by trusted server code that has
  -- already authenticated that user. There is deliberately no comparison with
  -- the caller's JWT subject — the server caller has none. A NULL target is a
  -- programming error and is refused, never treated as "nothing to refund".
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'refund_ai_quota: p_user_id is required';
  END IF;

  SELECT * INTO v_entitlement
  FROM public.user_entitlements
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::TEXT, 0;
    RETURN;
  END IF;

  SELECT ia.ai_quota_exempt INTO v_exempt
  FROM public.internal_user_access ia
  WHERE ia.user_id = p_user_id;
  v_exempt := COALESCE(v_exempt, false);

  -- Mirror consume_ai_quota's bucket selection EXACTLY, including the exempt
  -- lifetime fallback, so a refund always targets the bucket consume incremented.
  IF v_entitlement.ai_monthly_quota > 0 THEN
    v_period_type := 'monthly';
    v_period_start := date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC';
  ELSIF v_entitlement.ai_lifetime_quota > 0 OR v_exempt THEN
    v_period_type := 'lifetime';
    v_period_start := 'epoch'::TIMESTAMPTZ;
  ELSE
    RETURN QUERY SELECT FALSE, NULL::TEXT, 0;
    RETURN;
  END IF;

  -- Decrement floored at 0 (GREATEST) so a duplicate refund is never destructive.
  UPDATE public.usage_counters
  SET used = GREATEST(usage_counters.used - 1, 0),
      updated_at = now()
  WHERE usage_counters.user_id = p_user_id
    AND usage_counters.feature = 'ai_analysis'
    AND usage_counters.period_type = v_period_type
    AND usage_counters.period_start = v_period_start
  RETURNING usage_counters.used INTO v_new_used;

  IF v_new_used IS NULL THEN
    RETURN QUERY SELECT FALSE, v_period_type, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, v_period_type, v_new_used;
END;
$$;

COMMENT ON FUNCTION public.refund_ai_quota(UUID) IS
  'SERVER-ONLY best-effort reversal of one AI quota unit (feature ai_analysis). '
  'EXECUTE is granted to service_role ONLY — never to authenticated, anon or '
  'PUBLIC — so no browser or user JWT can call it; it is not a browser RPC. '
  'Called by the analyze-paper and suggest-paper-organization Edge Functions, '
  'through a dedicated client built from the platform-provided secret key with '
  'no caller Authorization header, only after an attempt whose unit '
  'consume_ai_quota already took failed to deliver a result. p_user_id is '
  'supplied by that trusted server code from its authoritative auth.getUser() '
  'identity, never from a request body; NULL is refused. Mirrors '
  'consume_ai_quota''s bucket selection, including the ai_quota_exempt lifetime '
  'fallback (C28). GREATEST(used - 1, 0), so a duplicate refund is never '
  'destructive; a missing entitlement, bucket or counter returns refunded = '
  'false. SECURITY DEFINER + fixed search_path. Made server-only by '
  'SEC-AI-QUOTA-REFUND-AUTHORITY-001 (decision C47).';


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Grant the server — and only the server
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WITHOUT grant option. `service_role` is what PostgREST assumes for a request
-- carrying the project's secret key; the Edge Functions hold that key from the
-- platform-injected environment, and browsers never do.

GRANT EXECUTE ON FUNCTION public.refund_ai_quota(uuid) TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Fail-closed self-check — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

DO $verify$
DECLARE
  v_count INTEGER;
  v_list  TEXT;
  v_fn    TEXT;
  v_base  TEXT;
  v_now   TEXT;
BEGIN
  -- ── Exact final EXECUTE matrix: owner + service_role, nobody else ────────
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.refund_ai_quota(uuid)'::regprocedure
      AND a.privilege_type = 'EXECUTE'
      AND a.grantee NOT IN (p.proowner, 'service_role'::regrole::oid)
  ) THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: refund_ai_quota is executable by a role other than its owner and service_role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.refund_ai_quota(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: service_role cannot execute refund_ai_quota';
  END IF;
  IF has_function_privilege('authenticated', 'public.refund_ai_quota(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: authenticated can still execute refund_ai_quota';
  END IF;
  IF has_function_privilege('anon', 'public.refund_ai_quota(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: anon can execute refund_ai_quota';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.refund_ai_quota(uuid)'::regprocedure
      AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: refund_ai_quota carries PUBLIC EXECUTE';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
    WHERE p.oid = 'public.refund_ai_quota(uuid)'::regprocedure
      AND a.grantee = 'service_role'::regrole::oid
      AND a.is_grantable
  ) THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: service_role holds EXECUTE on refund_ai_quota WITH GRANT OPTION';
  END IF;
  IF NOT has_function_privilege('postgres', 'public.refund_ai_quota(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: the owner lost EXECUTE on refund_ai_quota';
  END IF;

  -- ── Same object, same shape, the new body ────────────────────────────────
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'refund_ai_quota';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: % refund_ai_quota overload(s) after the change; expected exactly 1', v_count;
  END IF;
  PERFORM 1
  FROM pg_proc p
  WHERE p.oid = 'public.refund_ai_quota(uuid)'::regprocedure
    AND p.proowner = 'postgres'::regrole
    AND p.prosecdef
    AND p.proconfig = ARRAY['search_path=public']
    AND p.proretset
    AND p.proargnames = ARRAY['p_user_id','refunded','period_type','used']
    AND pg_get_function_result(p.oid) = 'TABLE(refunded boolean, period_type text, used integer)'
    AND md5(p.prosrc) = '4224750ddbff3651e7e0aaa2576f4de4';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: refund_ai_quota is not exactly the server-only definition in this file';
  END IF;
  -- The authority is the grant, not an identity comparison.
  IF position('auth.uid()' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.refund_ai_quota(uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: refund_ai_quota still consults auth.uid()';
  END IF;

  -- ── The ONE service_role grant this migration adds, and no other ─────────
  SELECT coalesce(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text), '')
    INTO v_list
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_list <> 'refund_ai_quota(uuid)' THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: service_role executes SECURITY DEFINER function(s) [%]; expected exactly refund_ai_quota(uuid)', v_list;
  END IF;

  -- ── Consumption and status are untouched: body and privileges ────────────
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.consume_ai_quota(uuid)'::regprocedure)
     IS DISTINCT FROM '8b3f8c3b380703c1ae8286db9745ad0d' THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: consume_ai_quota body changed';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_ai_quota_status(uuid)'::regprocedure)
     IS DISTINCT FROM '212b9a3ed220e347e8d8ca486b6d83a1' THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: get_ai_quota_status body changed';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.consume_ai_quota(uuid)', 'public.get_ai_quota_status(uuid)'] LOOP
    IF NOT has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'ai_quota_refund_authority: authenticated lost EXECUTE on %', v_fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = v_fn::regprocedure
        AND a.privilege_type = 'EXECUTE'
        AND a.grantee NOT IN (p.proowner, 'authenticated'::regrole::oid)
    ) THEN
      RAISE EXCEPTION 'ai_quota_refund_authority: % is executable by a role other than its owner and authenticated', v_fn;
    END IF;
  END LOOP;

  -- ── This transaction wrote no counter or entitlement row ──────────────────
  -- The migration changes authority; it never moves anyone's usage. Measured
  -- against the baseline section 0 took from this transaction's own statistics
  -- (see there for why this, and not row timestamps, is concurrency-safe).
  v_base := current_setting('ai_quota_refund_authority.xact_writes_at_start', true);
  IF coalesce(v_base, '') = '' THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  v_now := format('usage_counters=%s user_entitlements=%s',
    pg_stat_get_xact_tuples_inserted('public.usage_counters'::regclass)
      + pg_stat_get_xact_tuples_updated('public.usage_counters'::regclass)
      + pg_stat_get_xact_tuples_deleted('public.usage_counters'::regclass),
    pg_stat_get_xact_tuples_inserted('public.user_entitlements'::regclass)
      + pg_stat_get_xact_tuples_updated('public.user_entitlements'::regclass)
      + pg_stat_get_xact_tuples_deleted('public.user_entitlements'::regclass));
  IF v_now <> v_base THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: this transaction inserted, updated or deleted usage_counters/user_entitlements rows (row writes at start: %; now: %)', v_base, v_now;
  END IF;

  -- ── The browser roles still cannot write the counters directly ───────────
  IF has_table_privilege('authenticated', 'public.usage_counters', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('anon', 'public.usage_counters', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ai_quota_refund_authority: a browser role holds a privilege on usage_counters';
  END IF;
END
$verify$;

COMMIT;
