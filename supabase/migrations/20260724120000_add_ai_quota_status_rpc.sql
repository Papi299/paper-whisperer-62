-- PFA-C01 — read-only AI quota status RPC.
--
-- Adds one SECURITY DEFINER, READ-ONLY function the client calls to render
-- the AI-analysis quota indicator (used / quota / remaining, lifetime vs
-- monthly, monthly reset date). It is the read-side companion to the
-- write-side `consume_ai_quota` / `refund_ai_quota` RPCs from
-- `20260521020000_add_ai_quota_rpcs.sql`.
--
-- Why a SECURITY DEFINER RPC (and NOT a direct client SELECT):
--   `usage_counters` is intentionally server-only — it has FORCE ROW LEVEL
--   SECURITY and NO client SELECT policy (see
--   `20260521010000_add_entitlement_usage_schema.sql`, which explicitly
--   states quota usage should be exposed "by a SECURITY DEFINER RPC that
--   reads on the user's behalf, not by a direct client SELECT"). This
--   migration honors that decision: it does NOT add a SELECT policy to
--   `usage_counters`, does NOT weaken FORCE RLS, and does NOT let the client
--   compute authoritative usage locally. The function reads the counter on
--   the caller's behalf and returns a bounded, non-sensitive projection.
--
-- Read-only contract:
--   This function performs NO INSERT / UPDATE / DELETE / lock / reservation /
--   consumption / refund, and does NOT create a missing counter row. A
--   missing counter is treated as used = 0. It is declared STABLE to make
--   the read-only intent explicit and to reject any accidental future write.
--
-- Bucket selection mirrors `consume_ai_quota` exactly so the indicator and
-- the enforcement path never disagree about which bucket is active:
--   - monthly  when ai_monthly_quota > 0 (current UTC month boundaries);
--   - else lifetime when ai_lifetime_quota > 0 (epoch sentinel period_start);
--   - else neither → quota unavailable (treated as quota_exceeded for UI).
--
-- Enforcement boundary is unchanged: the server (analyze-paper +
-- consume_ai_quota) remains authoritative. This function is advisory display
-- only; a stale `remaining` here can never grant or deny an analysis.
--
-- Security:
--   - S1 ownership guard: p_user_id non-null, auth.uid() non-null, and
--     p_user_id = auth.uid() — identical to consume_ai_quota / refund_ai_quota.
--   - SECURITY DEFINER + SET search_path = public.
--   - Execute revoked from PUBLIC and anon; granted only to authenticated.
--   - Returns no billing_customer_id / billing_subscription_id / provider
--     metadata / tokens / secrets — only plan, plan_status, and the quota
--     counters needed to render the indicator.

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
  reset_at TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_entitlement public.user_entitlements%ROWTYPE;
  v_period_type TEXT;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_quota INTEGER;
  v_used INTEGER;
  v_remaining INTEGER;
BEGIN
  -- The `#variable_conflict use_column` directive mirrors the write-side
  -- RPCs: it resolves any bare-identifier ambiguity between this function's
  -- OUT parameters (used / period_type / plan / …) and the usage_counters
  -- columns of the same name in favor of the table columns. All such
  -- references below are additionally table-qualified, so this is
  -- belt-and-suspenders; the OUT parameters are only ever populated via the
  -- final RETURN QUERY SELECT.

  -- S1 ownership guard. SECURITY DEFINER bypasses RLS, so the function must
  -- verify the caller owns the requested user_id itself.
  IF p_user_id IS NULL OR auth.uid() IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  -- Read-only lookup (no FOR UPDATE, no lock).
  SELECT * INTO v_entitlement
  FROM public.user_entitlements
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    -- No entitlement row. Explicit non-success state; should not happen for
    -- a legitimate user (handle_new_user seeds one on signup).
    RETURN QUERY SELECT
      FALSE,
      'missing_entitlement'::TEXT,
      NULL::TEXT,
      NULL::TEXT,
      NULL::TEXT,
      0, 0, 0,
      NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF v_entitlement.plan_status NOT IN ('active', 'trialing') THEN
    RETURN QUERY SELECT
      FALSE,
      'inactive_entitlement'::TEXT,
      v_entitlement.plan,
      v_entitlement.plan_status,
      NULL::TEXT,
      0, 0, 0,
      NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Bucket selection — identical rule to consume_ai_quota.
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
  ELSE
    -- Plan exposes neither monthly nor lifetime AI quota → no AI access.
    RETURN QUERY SELECT
      FALSE,
      'quota_exceeded'::TEXT,
      v_entitlement.plan,
      v_entitlement.plan_status,
      NULL::TEXT,
      0, 0, 0,
      NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Read the counter for the active bucket. A missing row means the user has
  -- not consumed any quota yet in this bucket → used = 0. NO row is created.
  SELECT usage_counters.used INTO v_used
  FROM public.usage_counters
  WHERE usage_counters.user_id = p_user_id
    AND usage_counters.feature = 'ai_analysis'
    AND usage_counters.period_type = v_period_type
    AND usage_counters.period_start = v_period_start;

  v_used := COALESCE(v_used, 0);
  -- Clamp remaining to zero (a counter can never legitimately exceed quota,
  -- but a manual/ops edit or a lowered plan quota must never yield negative
  -- remaining in the UI).
  v_remaining := GREATEST(v_quota - v_used, 0);

  RETURN QUERY SELECT
    (v_remaining > 0),
    CASE WHEN v_remaining > 0 THEN 'ok' ELSE 'quota_exceeded' END,
    v_entitlement.plan,
    v_entitlement.plan_status,
    v_period_type,
    v_used,
    v_quota,
    v_remaining,
    v_period_end;
END;
$$;

COMMENT ON FUNCTION public.get_ai_quota_status(UUID) IS
  'Read-only projection of the caller''s current AI-analysis quota for the '
  'UI indicator (used / quota / remaining, lifetime vs monthly, reset_at). '
  'SECURITY DEFINER + STABLE + auth.uid() S1 guard. Mirrors consume_ai_quota''s '
  'bucket selection. Performs no write/lock/consume/refund and creates no '
  'counter row (missing counter → used 0). Exists because usage_counters is '
  'server-only (FORCE RLS, no client SELECT policy) by decision in '
  '20260521010000; the client must never read usage_counters directly. '
  'Advisory display only — the server remains the enforcement boundary.';

REVOKE EXECUTE ON FUNCTION public.get_ai_quota_status(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_ai_quota_status(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_ai_quota_status(UUID) TO authenticated;
