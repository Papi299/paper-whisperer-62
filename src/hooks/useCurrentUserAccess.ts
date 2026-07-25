import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The caller's effective internal role and capability flags.
 *
 * Sourced from the read-only `get_current_user_access` SECURITY DEFINER RPC
 * (migration `20260725090000`), which derives the caller from `auth.uid()`
 * (no arbitrary-user lookup) and returns a safe `user` default for anyone with
 * no internal-access row. This is the client's advisory view of internal
 * capability; the **server** remains the authorization boundary — the
 * `get-gemini-provider-quota` Edge Function re-checks the role itself and never
 * trusts a client-supplied role claim.
 */
export type InternalRole = "owner" | "manager" | "user";

export interface CurrentUserAccess {
  role: InternalRole;
  isInternal: boolean;
  canViewProviderQuota: boolean;
  aiQuotaExempt: boolean;
  plan: string | null;
  planStatus: string | null;
  premiumTaxonomyEnabled: boolean;
  labsTeamEnabled: boolean;
}

/** Raw row shape returned by the RPC (SETOF → array in supabase-js). */
interface CurrentUserAccessRow {
  role: string | null;
  is_internal: boolean | null;
  can_view_provider_quota: boolean | null;
  ai_quota_exempt: boolean | null;
  plan: string | null;
  plan_status: string | null;
  premium_taxonomy_enabled: boolean | null;
  labs_team_enabled: boolean | null;
}

/**
 * Safe default: an ordinary `user` with no internal capability. Returned while
 * signed-out, while loading, and — critically — whenever the access lookup
 * **fails**. A failed or pending access fetch must NEVER grant privileges.
 */
export const DEFAULT_USER_ACCESS: CurrentUserAccess = {
  role: "user",
  isInternal: false,
  canViewProviderQuota: false,
  aiQuotaExempt: false,
  plan: null,
  planStatus: null,
  premiumTaxonomyEnabled: false,
  labsTeamEnabled: false,
};

function normalizeRole(role: string | null | undefined): InternalRole {
  return role === "owner" || role === "manager" ? role : "user";
}

function normalize(row: CurrentUserAccessRow): CurrentUserAccess {
  const role = normalizeRole(row.role);
  // Re-derive capability from the resolved role AND the server flag: an
  // ordinary `user` can never be internal or view provider quota, regardless of
  // what any stray flag says. This keeps a malformed row from over-granting.
  const isInternal = role !== "user" && !!row.is_internal;
  return {
    role,
    isInternal,
    canViewProviderQuota: isInternal && !!row.can_view_provider_quota,
    aiQuotaExempt: !!row.ai_quota_exempt,
    plan: row.plan ?? null,
    planStatus: row.plan_status ?? null,
    premiumTaxonomyEnabled: !!row.premium_taxonomy_enabled,
    labsTeamEnabled: !!row.labs_team_enabled,
  };
}

export interface UseCurrentUserAccessResult {
  /** Always defined — falls back to `DEFAULT_USER_ACCESS` on load/error/signed-out. */
  access: CurrentUserAccess;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Read-only internal-access status for the signed-in user.
 *
 * - Disabled when `userId` is absent (auth transition / signed-out).
 * - The query key is scoped by `userId` so one user can never read another's
 *   cached access.
 * - **Fail-closed:** on error the hook returns the ordinary-`user` default and
 *   `isError: true`; a failed access fetch never grants owner/manager
 *   privileges. The Edge Function is the real authorization boundary regardless.
 */
export function useCurrentUserAccess(userId: string | null | undefined): UseCurrentUserAccessResult {
  const { data, isLoading, isError, refetch } = useQuery<CurrentUserAccess>({
    queryKey: queryKeys.access.current(userId ?? "anonymous"),
    queryFn: async () => {
      // No argument: the RPC derives the caller from auth.uid() server-side.
      const { data, error } = await supabase.rpc("get_current_user_access");
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as CurrentUserAccessRow | undefined | null;
      if (!row) return DEFAULT_USER_ACCESS;
      return normalize(row);
    },
    enabled: !!userId,
    staleTime: 60_000,
  });

  return {
    access: data ?? DEFAULT_USER_ACCESS,
    isLoading: !!userId && isLoading,
    isError,
    refetch,
  };
}
