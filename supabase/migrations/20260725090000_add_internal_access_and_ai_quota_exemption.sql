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
