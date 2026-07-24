import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Normalized, UI-facing AI-analysis quota status.
 *
 * Sourced from the read-only `get_ai_quota_status` SECURITY DEFINER RPC
 * (migration `20260724120000`). The client never reads `usage_counters`
 * directly — that table is server-only (FORCE RLS, no client SELECT policy).
 * This is advisory display only; the server (`analyze-paper` +
 * `consume_ai_quota`) remains the authoritative enforcement boundary.
 */
export interface AiQuotaStatus {
  /** true when the user has AI analyses remaining in the active bucket. */
  allowed: boolean;
  /** 'ok' | 'quota_exceeded' | 'inactive_entitlement' | 'missing_entitlement'. */
  reason: string;
  plan: string | null;
  planStatus: string | null;
  /** 'lifetime' | 'monthly' | null (null when no active AI bucket). */
  periodType: string | null;
  used: number;
  quota: number;
  remaining: number;
  /** ISO reset timestamp for monthly plans; null for lifetime / unavailable. */
  resetAt: string | null;
}

/** Raw row shape returned by the RPC (SETOF → array in supabase-js). */
interface AiQuotaStatusRow {
  allowed: boolean;
  reason: string;
  plan: string | null;
  plan_status: string | null;
  period_type: string | null;
  used: number;
  quota: number;
  remaining: number;
  reset_at: string | null;
}

function normalize(row: AiQuotaStatusRow): AiQuotaStatus {
  return {
    allowed: !!row.allowed,
    reason: row.reason,
    plan: row.plan,
    planStatus: row.plan_status,
    periodType: row.period_type,
    used: row.used ?? 0,
    quota: row.quota ?? 0,
    remaining: row.remaining ?? 0,
    resetAt: row.reset_at,
  };
}

export interface UseAiQuotaResult {
  status: AiQuotaStatus | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Read-only AI-analysis quota status for the signed-in user.
 *
 * - Disabled when `userId` is absent (auth transition / signed-out).
 * - The query key is scoped by `userId` so one user can never read another
 *   user's cached quota.
 * - Fails **softly**: on error the hook returns `status: null` and
 *   `isError: true`; callers must NOT block AI analysis merely because the
 *   status query failed (the server stays authoritative).
 */
export function useAiQuota(userId: string | null | undefined): UseAiQuotaResult {
  const { data, isLoading, isError, refetch } = useQuery<AiQuotaStatus | null>({
    queryKey: queryKeys.aiQuota.status(userId ?? "anonymous"),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_ai_quota_status", {
        p_user_id: userId!,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as AiQuotaStatusRow | undefined | null;
      if (!row) return null;
      return normalize(row);
    },
    enabled: !!userId,
    staleTime: 30_000,
  });

  return {
    status: data ?? null,
    // `isLoading` is only meaningful while enabled; a disabled query is not loading.
    isLoading: !!userId && isLoading,
    isError,
    refetch,
  };
}
