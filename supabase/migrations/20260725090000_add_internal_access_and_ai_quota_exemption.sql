-- OWNER-MANAGER-ACCESS-AND-GEMINI-QUOTA-001 — internal owner/manager access
-- and AI-quota exemption.
--
-- One additive migration in two sections:
--
--   Part A — internal access model:
--     * public.internal_user_access — a server-only role table (owner | manager)
--       with an explicit per-user `ai_quota_exempt` grant.
--     * public.get_current_user_access() — read-only SECURITY DEFINER RPC that
--       returns the CALLER's effective internal role + capability flags, deriving
--       identity from auth.uid() only (no arbitrary-user lookup).
--
--   Part B — AI-quota exemption:
--     * consume_ai_quota / refund_ai_quota / get_ai_quota_status learn about
--       `ai_quota_exempt` so an exempt internal user is never blocked by the
--       Paperlume commercial quota, while usage is still recorded and refunds
--       still reverse it. Adds an additive `is_exempt` field to
--       get_ai_quota_status; non-exempt behavior is otherwise unchanged.
--
-- Durable decision: internal role is SEPARATE from the commercial plan
-- (free/pro/labs_team). 'owner'/'manager' are operational roles, NOT commercial
-- plans and NOT 'labs_team'. Runtime authorization depends on the authenticated
-- UUID + server-controlled role record — never on an email comparison. See
-- docs/decisions-and-triggers.md C28.
--
-- This migration creates schema + functions only. It does NOT insert the owner
-- bootstrap row (that is a separately-authorized deployment-time transaction —
-- see docs/deployment.md), does NOT set any secret, and does NOT deploy any
-- Edge Function. It is additive and does not alter any existing table, policy,
-- RLS posture, or quota value for ordinary Free/Pro users.

-- ═════════════════════════════════════════════════════════════════════
-- Part A — internal owner/manager access
-- ═════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. internal_user_access — server-only internal role model
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.internal_user_access (
    user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    ai_quota_exempt BOOLEAN NOT NULL DEFAULT false,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT internal_user_access_role_check
        CHECK (role IN ('owner', 'manager'))
);

COMMENT ON TABLE public.internal_user_access IS
    'Server-only internal operational role model (owner | manager), decoupled '
    'from the commercial plan in user_entitlements. One row per internal user; '
    'ordinary users have NO row (implicit role ''user''). Holds NO email / API '
    'credential / Google secret / billing data. ENABLE + FORCE RLS with NO '
    'client policy: readable only via the SECURITY DEFINER get_current_user_'
    'access() RPC on the caller''s behalf — the same server-only pattern as '
    'usage_counters (20260521010000). See decisions C28.';

COMMENT ON COLUMN public.internal_user_access.role IS
    'owner | manager. Operational role only — NOT a commercial plan, NOT '
    'labs_team. Ordinary users have no row here.';

COMMENT ON COLUMN public.internal_user_access.ai_quota_exempt IS
    'Explicit grant: when true, the AI-quota RPCs never block this user on the '
    'Paperlume commercial quota (usage is still recorded and refundable). '
    'Managers are NOT exempt by default — exemption is an explicit per-user flag.';

-- Server-only posture: RLS enabled AND forced (the table owner is subject to
-- RLS too), with NO client SELECT/INSERT/UPDATE/DELETE policy. The client role
-- (authenticated/anon) can neither read nor write this table. Every read is via
-- a SECURITY DEFINER RPC whose owner role bypasses RLS. This intentionally hides
-- the owner/manager roster from ordinary users.
ALTER TABLE public.internal_user_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_user_access FORCE ROW LEVEL SECURITY;

CREATE TRIGGER update_internal_user_access_updated_at
    BEFORE UPDATE ON public.internal_user_access
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────
-- 2. get_current_user_access — read-only current-access RPC
-- ─────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_current_user_access();

CREATE FUNCTION public.get_current_user_access()
RETURNS TABLE(
  role TEXT,
  is_internal BOOLEAN,
  can_view_provider_quota BOOLEAN,
  ai_quota_exempt BOOLEAN,
  plan TEXT,
  plan_status TEXT,
  premium_taxonomy_enabled BOOLEAN,
  labs_team_enabled BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_exempt BOOLEAN;
  v_entitlement public.user_entitlements%ROWTYPE;
BEGIN
  -- Null-auth rejection: no anonymous access. EXECUTE is also revoked from anon
  -- below; this guard additionally covers a null uid on a tokenless call.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no authenticated user';
  END IF;

  -- Effective internal role. No arbitrary-user lookup — keyed on auth.uid().
  -- SECURITY DEFINER lets this read the server-only internal_user_access table.
  SELECT ia.role, ia.ai_quota_exempt
    INTO v_role, v_exempt
  FROM public.internal_user_access ia
  WHERE ia.user_id = v_uid;

  IF v_role IS NULL THEN
    -- Ordinary user: safe default. No internal row → role 'user', not internal,
    -- cannot view provider quota, not exempt.
    v_role := 'user';
    v_exempt := false;
  END IF;

  -- Commercial context (plan/plan_status/flags). Absent entitlement → NULL plan
  -- and false flags via COALESCE.
  SELECT * INTO v_entitlement
  FROM public.user_entitlements
  WHERE user_id = v_uid;

  RETURN QUERY SELECT
    v_role,
    (v_role IN ('owner', 'manager')),
    (v_role IN ('owner', 'manager')),
    COALESCE(v_exempt, false),
    v_entitlement.plan,
    v_entitlement.plan_status,
    COALESCE(v_entitlement.premium_taxonomy_enabled, false),
    COALESCE(v_entitlement.labs_team_enabled, false);
END;
$$;

COMMENT ON FUNCTION public.get_current_user_access() IS
  'Read-only projection of the CALLER''s effective internal role (owner | '
  'manager | user) and capability flags (is_internal, can_view_provider_quota, '
  'ai_quota_exempt) plus commercial plan / plan_status and implemented feature '
  'flags. Derives identity from auth.uid() only (no p_user_id, no arbitrary '
  'lookup); rejects null auth. SECURITY DEFINER + STABLE + fixed search_path. '
  'Ordinary users with no internal row default to role ''user''. Never exposes '
  'the owner/manager roster. See decisions C28.';

REVOKE EXECUTE ON FUNCTION public.get_current_user_access() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_current_user_access() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_current_user_access() TO authenticated;


-- ═════════════════════════════════════════════════════════════════════
-- Part B — AI-quota exemption for exempt internal users
-- ═════════════════════════════════════════════════════════════════════
--
-- The three AI-quota RPCs learn about internal_user_access.ai_quota_exempt.
-- For an exempt user with an ACTIVE entitlement:
--   * consume_ai_quota is always permitted (never denied when used >= quota),
--     still increments the correct bucket atomically, and returns
--     reason = 'quota_exempt';
--   * refund_ai_quota selects the same bucket and safely decrements (floored at
--     zero) so a provider failure still reverses the recorded use;
--   * get_ai_quota_status returns allowed = true, reason = 'quota_exempt', and a
--     new additive is_exempt = true, with usage still visible.
--
-- Non-exempt Free/Pro behavior is UNCHANGED: same bucket selection, same
-- `used < quota` enforcement, same structured responses. The only change to the
-- get_ai_quota_status output for non-exempt users is the additive is_exempt
-- column (always false for them). The server remains the enforcement boundary.
--
-- SECURITY DEFINER lets these functions read the server-only internal_user_access
-- table on the caller's behalf (the client cannot). The exempt increment stays
-- S1-safe (auth.uid() guard unchanged) and race-safe (per-row UPDATE ... RETURNING
-- plus the existing entitlement FOR UPDATE serialize concurrent calls).

-- ─────────────────────────────────────────────────────────────────────
-- 3. consume_ai_quota — add the exempt path (signature unchanged)
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.consume_ai_quota(p_user_id UUID)
RETURNS TABLE(
  allowed BOOLEAN,
  reason TEXT,
  plan TEXT,
  period_type TEXT,
  used INTEGER,
  quota INTEGER,
  remaining INTEGER,
  reset_at TIMESTAMPTZ
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
  v_period_end TIMESTAMPTZ;
  v_quota INTEGER;
  v_new_used INTEGER;
  v_current_used INTEGER;
BEGIN
  -- S1 ownership guard.
  IF p_user_id IS NULL OR auth.uid() IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  -- Lock the entitlement row (serialize per-user consumption vs a concurrent
  -- webhook-driven entitlement mutation).
  SELECT * INTO v_entitlement
  FROM public.user_entitlements
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      FALSE, 'missing_entitlement'::TEXT, NULL::TEXT, NULL::TEXT, 0, 0, 0, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF v_entitlement.plan_status NOT IN ('active', 'trialing') THEN
    RETURN QUERY SELECT
      FALSE, 'inactive_entitlement'::TEXT, v_entitlement.plan, NULL::TEXT, 0, 0, 0, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Internal AI-quota exemption (explicit grant). SECURITY DEFINER reads the
  -- server-only internal_user_access table; NULL (no row) → false.
  SELECT ia.ai_quota_exempt INTO v_exempt
  FROM public.internal_user_access ia
  WHERE ia.user_id = p_user_id;
  v_exempt := COALESCE(v_exempt, false);

  -- Bucket selection — identical rule to the pre-exemption function. An exempt
  -- user with neither quota configured still records usage in the lifetime
  -- bucket (v_quota = 0, treated as unlimited below).
  IF v_entitlement.ai_monthly_quota > 0 THEN
    v_period_type := 'monthly';
    v_quota := v_entitlement.ai_monthly_quota;
    v_period_start := date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC';
    v_period_end := v_period_start + INTERVAL '1 month';
  ELSIF v_entitlement.ai_lifetime_quota > 0 THEN
    v_period_type := 'lifetime';
    v_quota := v_entitlement.ai_lifetime_quota;
    v_period_start := 'epoch'::TIMESTAMPTZ;
    v_period_end := NULL;
  ELSIF v_exempt THEN
    v_period_type := 'lifetime';
    v_quota := 0;
    v_period_start := 'epoch'::TIMESTAMPTZ;
    v_period_end := NULL;
  ELSE
    RETURN QUERY SELECT
      FALSE, 'quota_exceeded'::TEXT, v_entitlement.plan, NULL::TEXT, 0, 0, 0, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Ensure the counter row exists (idempotent).
  INSERT INTO public.usage_counters (
    user_id, feature, period_type, period_start, period_end, used
  )
  VALUES (
    p_user_id, 'ai_analysis', v_period_type, v_period_start, v_period_end, 0
  )
  ON CONFLICT (user_id, feature, period_type, period_start) DO NOTHING;

  IF v_exempt THEN
    -- Exempt: unconditional atomic increment (NO `used < quota` guard). Still
    -- race-safe — the per-row UPDATE ... RETURNING serializes concurrent calls,
    -- and the entitlement FOR UPDATE above serializes per user. Usage is
    -- recorded for operational context; the caller is always allowed.
    UPDATE public.usage_counters
    SET used = usage_counters.used + 1,
        updated_at = now()
    WHERE usage_counters.user_id = p_user_id
      AND usage_counters.feature = 'ai_analysis'
      AND usage_counters.period_type = v_period_type
      AND usage_counters.period_start = v_period_start
    RETURNING usage_counters.used INTO v_new_used;

    v_new_used := COALESCE(v_new_used, 1);
    RETURN QUERY SELECT
      TRUE,
      'quota_exempt'::TEXT,
      v_entitlement.plan,
      v_period_type,
      v_new_used,
      v_quota,
      GREATEST(v_quota - v_new_used, 0),
      v_period_end;
    RETURN;
  END IF;

  -- Non-exempt: atomic increment guarded by `used < quota`.
  UPDATE public.usage_counters
  SET used = usage_counters.used + 1,
      updated_at = now()
  WHERE usage_counters.user_id = p_user_id
    AND usage_counters.feature = 'ai_analysis'
    AND usage_counters.period_type = v_period_type
    AND usage_counters.period_start = v_period_start
    AND usage_counters.used < v_quota
  RETURNING usage_counters.used INTO v_new_used;

  IF v_new_used IS NULL THEN
    SELECT usage_counters.used INTO v_current_used
    FROM public.usage_counters
    WHERE usage_counters.user_id = p_user_id
      AND usage_counters.feature = 'ai_analysis'
      AND usage_counters.period_type = v_period_type
      AND usage_counters.period_start = v_period_start;

    RETURN QUERY SELECT
      FALSE,
      'quota_exceeded'::TEXT,
      v_entitlement.plan,
      v_period_type,
      COALESCE(v_current_used, v_quota),
      v_quota,
      0,
      v_period_end;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    TRUE,
    'ok'::TEXT,
    v_entitlement.plan,
    v_period_type,
    v_new_used,
    v_quota,
    v_quota - v_new_used,
    v_period_end;
END;
$$;

COMMENT ON FUNCTION public.consume_ai_quota(UUID) IS
  'Atomically consume one unit of the caller''s AI analysis quota. SECURITY '
  'DEFINER with auth.uid() guard. Monthly bucket when ai_monthly_quota > 0 '
  '(Pro); else lifetime (Free). An internal user with ai_quota_exempt = true is '
  'always allowed (reason = quota_exempt) and never blocked by the cap, but '
  'usage is still incremented for operational context. Called by analyze-paper '
  'before invoking Gemini. See docs/commercial-architecture.md §5 and C28.';

-- CREATE OR REPLACE preserves existing grants; re-affirm defensively.
REVOKE EXECUTE ON FUNCTION public.consume_ai_quota(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota(UUID) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────
-- 4. refund_ai_quota — mirror the exempt bucket selection (signature unchanged)
-- ─────────────────────────────────────────────────────────────────────

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
  -- S1 ownership guard.
  IF p_user_id IS NULL OR auth.uid() IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
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
  'Best-effort refund of one AI analysis quota unit after an upstream Gemini '
  'failure. SECURITY DEFINER with auth.uid() guard. GREATEST(used - 1, 0) so a '
  'duplicate refund is never destructive. Mirrors consume_ai_quota''s bucket '
  'selection, including the exempt lifetime fallback, so an exempt user''s '
  'recorded usage is reversed from the same bucket. See C28.';

REVOKE EXECUTE ON FUNCTION public.refund_ai_quota(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_ai_quota(UUID) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────
-- 5. get_ai_quota_status — add is_exempt (additive) + exempt projection
-- ─────────────────────────────────────────────────────────────────────
-- The RETURNS TABLE gains one additive column (is_exempt), so this must DROP +
-- CREATE (a return-type change can't use CREATE OR REPLACE). Non-exempt output
-- is bit-compatible except for the additive column (always false for them).

DROP FUNCTION IF EXISTS public.get_ai_quota_status(UUID);

CREATE FUNCTION public.get_ai_quota_status(p_user_id UUID)
RETURNS TABLE(
  allowed BOOLEAN,
  reason TEXT,
  plan TEXT,
  plan_status TEXT,
  period_type TEXT,
  used INTEGER,
  quota INTEGER,
  remaining INTEGER,
  reset_at TIMESTAMPTZ,
  is_exempt BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_entitlement public.user_entitlements%ROWTYPE;
  v_exempt BOOLEAN;
  v_period_type TEXT;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_quota INTEGER;
  v_used INTEGER;
  v_remaining INTEGER;
BEGIN
  -- S1 ownership guard.
  IF p_user_id IS NULL OR auth.uid() IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  SELECT * INTO v_entitlement
  FROM public.user_entitlements
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      FALSE, 'missing_entitlement'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      0, 0, 0, NULL::TIMESTAMPTZ, FALSE;
    RETURN;
  END IF;

  -- Exemption flag (read-only; drives the additive is_exempt output).
  SELECT ia.ai_quota_exempt INTO v_exempt
  FROM public.internal_user_access ia
  WHERE ia.user_id = p_user_id;
  v_exempt := COALESCE(v_exempt, false);

  IF v_entitlement.plan_status NOT IN ('active', 'trialing') THEN
    RETURN QUERY SELECT
      FALSE, 'inactive_entitlement'::TEXT, v_entitlement.plan, v_entitlement.plan_status,
      NULL::TEXT, 0, 0, 0, NULL::TIMESTAMPTZ, v_exempt;
    RETURN;
  END IF;

  -- Bucket selection — mirrors consume_ai_quota (incl. the exempt lifetime fallback).
  IF v_entitlement.ai_monthly_quota > 0 THEN
    v_period_type := 'monthly';
    v_quota := v_entitlement.ai_monthly_quota;
    v_period_start := date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC';
    v_period_end := v_period_start + INTERVAL '1 month';
  ELSIF v_entitlement.ai_lifetime_quota > 0 THEN
    v_period_type := 'lifetime';
    v_quota := v_entitlement.ai_lifetime_quota;
    v_period_start := 'epoch'::TIMESTAMPTZ;
    v_period_end := NULL;
  ELSIF v_exempt THEN
    v_period_type := 'lifetime';
    v_quota := 0;
    v_period_start := 'epoch'::TIMESTAMPTZ;
    v_period_end := NULL;
  ELSE
    RETURN QUERY SELECT
      FALSE, 'quota_exceeded'::TEXT, v_entitlement.plan, v_entitlement.plan_status,
      NULL::TEXT, 0, 0, 0, NULL::TIMESTAMPTZ, v_exempt;
    RETURN;
  END IF;

  SELECT usage_counters.used INTO v_used
  FROM public.usage_counters
  WHERE usage_counters.user_id = p_user_id
    AND usage_counters.feature = 'ai_analysis'
    AND usage_counters.period_type = v_period_type
    AND usage_counters.period_start = v_period_start;

  v_used := COALESCE(v_used, 0);
  v_remaining := GREATEST(v_quota - v_used, 0);

  IF v_exempt THEN
    -- Exempt: always allowed; usage stays visible; the nominal remaining is
    -- operational context only and must NOT be presented as an enforcement wall
    -- (the UI renders "Unlimited" off is_exempt / reason).
    RETURN QUERY SELECT
      TRUE, 'quota_exempt'::TEXT, v_entitlement.plan, v_entitlement.plan_status,
      v_period_type, v_used, v_quota, v_remaining, v_period_end, TRUE;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    (v_remaining > 0),
    CASE WHEN v_remaining > 0 THEN 'ok' ELSE 'quota_exceeded' END,
    v_entitlement.plan,
    v_entitlement.plan_status,
    v_period_type,
    v_used,
    v_quota,
    v_remaining,
    v_period_end,
    FALSE;
END;
$$;

COMMENT ON FUNCTION public.get_ai_quota_status(UUID) IS
  'Read-only projection of the caller''s current AI-analysis quota for the UI '
  'indicator (used / quota / remaining, lifetime vs monthly, reset_at, and the '
  'additive is_exempt). SECURITY DEFINER + STABLE + auth.uid() S1 guard. Mirrors '
  'consume_ai_quota''s bucket selection. An internal user with ai_quota_exempt = '
  'true returns allowed = true, reason = quota_exempt, is_exempt = true with '
  'usage still visible (the UI treats the allowance as Unlimited). Performs no '
  'write/lock/consume/refund and creates no counter row. usage_counters stays '
  'server-only. See 20260521010000 and C28.';

REVOKE EXECUTE ON FUNCTION public.get_ai_quota_status(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_ai_quota_status(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_ai_quota_status(UUID) TO authenticated;
