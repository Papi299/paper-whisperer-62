-- OWNER-MANAGER-ACCESS-AND-GEMINI-QUOTA-001L
--
-- public.internal_user_access remains protected by ENABLE + FORCE RLS with
-- no client policies (default-deny row access). This additional boundary
-- removes direct Data API table privileges from the public client roles as
-- defense in depth: even the object-permission layer no longer exposes the
-- server-only owner/manager roster. Authenticated clients continue to obtain
-- ONLY their own effective role projection through the SECURITY DEFINER
-- public.get_current_user_access() RPC (its EXECUTE grant is unchanged).
--
-- Privilege-only migration: no schema shape, function body, policy, owner row,
-- entitlement, or default-privilege change. usage_counters is intentionally
-- untouched here. Idempotent with respect to privilege state.

REVOKE ALL PRIVILEGES
ON TABLE public.internal_user_access
FROM PUBLIC;

REVOKE ALL PRIVILEGES
ON TABLE public.internal_user_access
FROM anon;

REVOKE ALL PRIVILEGES
ON TABLE public.internal_user_access
FROM authenticated;

-- Preserve an explicit server-side administrative path (service role bypasses
-- RLS and performs the bounded owner/manager bootstrap transactions).
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.internal_user_access
TO service_role;

COMMENT ON TABLE public.internal_user_access IS
    'Server-only internal operational role model (owner | manager), '
    'decoupled from commercial entitlements. Direct table privileges are '
    'revoked from PUBLIC, anon, and authenticated. ENABLE + FORCE RLS remains '
    'active with no client policy. Authenticated callers obtain only their '
    'own effective access projection through the SECURITY DEFINER '
    'get_current_user_access() RPC. Holds no email, credential, secret, or '
    'billing data. See decision C28.';
