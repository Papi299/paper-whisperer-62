-- Commercial foundation — AI quota enforcement RPCs.
--
-- Adds two SECURITY DEFINER functions used by the analyze-paper Edge
-- Function to consume / refund one unit of the caller's AI analysis
-- quota atomically and server-side.
--
-- Why:
--   PR #142 created the `user_entitlements` / `usage_counters` schema
--   but did NOT enforce quotas. Any authenticated user can call
--   analyze-paper as fast as the client cooldown allows, with no
--   server-side cap on Gemini cost. This migration closes that gap by
--   shipping the two functions analyze-paper will call. The Edge
--   Function change lands alongside this migration in the same PR.
--
-- Quota selection rule (matches commercial-architecture.md §5):
--   - If `ai_monthly_quota > 0`, use the monthly bucket (Pro path).
--     period_start = first day of current UTC month, period_end =
--     period_start + 1 month.
--   - Else if `ai_lifetime_quota > 0`, use the lifetime bucket (Free).
--     period_start = 'epoch'::timestamptz sentinel, period_end = NULL.
--   - Else (both zero) → quota_exceeded, no AI access.
--
-- Atomicity:
--   The increment uses `UPDATE … WHERE used < quota RETURNING used`.
--   This is race-safe across two concurrent calls: even if both
--   sessions read the same `used` value, only one passes the WHERE
--   predicate on the actual UPDATE (Postgres row-level locking around
--   the UPDATE guarantees serializable behavior on the matched row).
--   The optional `SELECT ... FOR UPDATE` on user_entitlements at the
--   top also serializes quota consumption per-user against an
--   entitlement that might be mutating mid-flight (rare but possible
--   from a Stripe webhook recompute landing concurrently).
--
-- Refund semantics:
--   Best-effort. Used `used = GREATEST(used - 1, 0)` so an out-of-
--   sequence refund (e.g., counter row missing due to manual ops) is
--   never destructive. The Edge Function logs and swallows refund
--   errors rather than masking the original failure.
--
-- Security:
--   Both functions follow the S1 pattern from PR #130 — explicit
--   `auth.uid()` guard before any work. The functions are
--   SECURITY DEFINER + `SET search_path = public`. They are granted
--   only to the `authenticated` role; anon and public cannot execute.

-- ─────────────────────────────────────────────────────────────────────
-- consume_ai_quota
-- ─────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.consume_ai_quota(UUID);

CREATE FUNCTION public.consume_ai_quota(p_user_id UUID)
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
  v_period_type TEXT;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_quota INTEGER;
  v_new_used INTEGER;
  v_current_used INTEGER;
BEGIN
  -- The `#variable_conflict use_column` directive above resolves any
  -- bare-identifier ambiguity between this function's OUT parameters
  -- (period_type / used / etc. from the RETURNS TABLE clause) and the
  -- usage_counters table columns of the same name in favor of the
  -- table columns. Without it, INSERT … ON CONFLICT (period_type, …)
  -- raises 'column reference "period_type" is ambiguous'. The OUT
  -- parameters are only ever assigned via RETURN QUERY SELECT below,
  -- never read as bare identifiers — so use_column is safe.

  -- S1 ownership guard. SECURITY DEFINER bypasses RLS, so we must
  -- verify the caller owns the requested user_id ourselves.
  IF p_user_id IS NULL OR auth.uid() IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  -- Lock the entitlement row to serialize quota consumption per user
  -- against a concurrent webhook-driven entitlement mutation. This is
  -- a row-level lock; reads of other users' entitlements are
  -- unaffected.
  SELECT * INTO v_entitlement
  FROM public.user_entitlements
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- No entitlement row at all. Should never happen for a legitimate
    -- user (handle_new_user trigger creates one on signup; the PR
    -- #142 backfill created one for every existing auth.users row).
    RETURN QUERY SELECT
      FALSE,
      'missing_entitlement'::TEXT,
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
      NULL::TEXT,
      0, 0, 0,
      NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Choose the quota bucket. Pro path uses monthly; Free path uses
  -- lifetime; both-zero (current Free post-AI-teaser-exhaustion when
  -- a future "Free with zero AI" variant ships) is quota_exceeded.
  IF v_entitlement.ai_monthly_quota > 0 THEN
    v_period_type := 'monthly';
    v_quota := v_entitlement.ai_monthly_quota;
    -- UTC month boundaries. Storing as timestamptz; the at-time-zone
    -- dance normalizes the truncation to UTC regardless of session
    -- timezone, which keeps period boundaries consistent across
    -- Edge runtime + Studio + future cron job invocations.
    v_period_start := date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC';
    v_period_end := v_period_start + INTERVAL '1 month';
  ELSIF v_entitlement.ai_lifetime_quota > 0 THEN
    v_period_type := 'lifetime';
    v_quota := v_entitlement.ai_lifetime_quota;
    v_period_start := 'epoch'::TIMESTAMPTZ;
    v_period_end := NULL;
  ELSE
    -- Plan exposes neither monthly nor lifetime AI quota → no AI
    -- access at all (treated as quota_exceeded for UI consistency).
    RETURN QUERY SELECT
      FALSE,
      'quota_exceeded'::TEXT,
      v_entitlement.plan,
      NULL::TEXT,
      0, 0, 0,
      NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Ensure the counter row exists. Idempotent — the PR #142 trigger /
  -- backfill created lifetime rows for every existing user; this
  -- INSERT only fires for the first monthly call of a new period on
  -- Pro.
  INSERT INTO public.usage_counters (
    user_id, feature, period_type, period_start, period_end, used
  )
  VALUES (
    p_user_id, 'ai_analysis', v_period_type, v_period_start, v_period_end, 0
  )
  ON CONFLICT (user_id, feature, period_type, period_start) DO NOTHING;

  -- Atomic increment guarded by `used < quota`. RETURNING populates
  -- v_new_used on the success path; the variable stays NULL when the
  -- counter is at-or-above the cap (UPDATE matched zero rows).
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
    -- Quota exhausted. Read current used value to surface in the
    -- response for UI display.
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
  'Atomically consume one unit of the caller''s AI analysis quota. '
  'SECURITY DEFINER with auth.uid() guard. Selects monthly bucket when '
  'ai_monthly_quota > 0 (Pro); else lifetime bucket (Free). Returns a '
  'structured row with allowed/reason/plan/period_type/used/quota/'
  'remaining/reset_at. Called by analyze-paper Edge Function before '
  'invoking Gemini. See docs/commercial-architecture.md §5.';

REVOKE EXECUTE ON FUNCTION public.consume_ai_quota(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota(UUID) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────
-- refund_ai_quota
-- ─────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.refund_ai_quota(UUID);

CREATE FUNCTION public.refund_ai_quota(p_user_id UUID)
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
  v_period_type TEXT;
  v_period_start TIMESTAMPTZ;
  v_new_used INTEGER;
BEGIN
  -- See the matching note in consume_ai_quota above for the
  -- `#variable_conflict use_column` rationale.

  -- S1 ownership guard.
  IF p_user_id IS NULL OR auth.uid() IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  SELECT * INTO v_entitlement
  FROM public.user_entitlements
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    -- No entitlement: nothing to refund. Best-effort no-op.
    RETURN QUERY SELECT FALSE, NULL::TEXT, 0;
    RETURN;
  END IF;

  -- Mirror consume_ai_quota's bucket selection so a refund always
  -- targets the bucket that was most likely just decremented.
  IF v_entitlement.ai_monthly_quota > 0 THEN
    v_period_type := 'monthly';
    v_period_start := date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC';
  ELSIF v_entitlement.ai_lifetime_quota > 0 THEN
    v_period_type := 'lifetime';
    v_period_start := 'epoch'::TIMESTAMPTZ;
  ELSE
    -- Neither bucket exists in entitlement. Best-effort no-op.
    RETURN QUERY SELECT FALSE, NULL::TEXT, 0;
    RETURN;
  END IF;

  -- Decrement floored at 0. GREATEST avoids accidental negative
  -- counters if a refund is called twice (e.g., retry after a
  -- network blip in the Edge Function).
  UPDATE public.usage_counters
  SET used = GREATEST(usage_counters.used - 1, 0),
      updated_at = now()
  WHERE usage_counters.user_id = p_user_id
    AND usage_counters.feature = 'ai_analysis'
    AND usage_counters.period_type = v_period_type
    AND usage_counters.period_start = v_period_start
  RETURNING usage_counters.used INTO v_new_used;

  IF v_new_used IS NULL THEN
    -- Counter row missing (unexpected for a successful prior consume).
    -- Best-effort no-op rather than raising; the Edge Function should
    -- still return the upstream Gemini error to the user.
    RETURN QUERY SELECT FALSE, v_period_type, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, v_period_type, v_new_used;
END;
$$;

COMMENT ON FUNCTION public.refund_ai_quota(UUID) IS
  'Best-effort refund of one AI analysis quota unit when the upstream '
  'Gemini call or response parsing fails after a successful consume. '
  'SECURITY DEFINER with auth.uid() guard. Uses GREATEST(used - 1, 0) '
  'so a duplicate refund is never destructive. Mirrors '
  'consume_ai_quota''s bucket selection. See '
  'docs/commercial-architecture.md §5.';

REVOKE EXECUTE ON FUNCTION public.refund_ai_quota(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_ai_quota(UUID) TO authenticated;
