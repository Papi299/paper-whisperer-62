import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";
import {
  normalizeProviderQuotaResponse,
  type GeminiProviderQuotaResponse,
} from "@/lib/geminiProviderQuota";

/**
 * Manager-only SHARED Google Gemini provider quota.
 *
 * - **Gated:** enabled ONLY when `canViewProviderQuota` is true (and a user is
 *   present). Ordinary users never invoke the `get-gemini-provider-quota` Edge
 *   Function — the query stays disabled, so no request is made. The server
 *   re-checks the role regardless (defense-in-depth).
 * - Query key is distinct from the per-user AI quota (`aiQuota`) so the shared
 *   provider metric and the personal allowance never collide.
 * - `staleTime` ≈ 2 minutes, matching the Edge Function's ~120s server cache so
 *   the panel doesn't poll aggressively.
 * - **Fail-soft:** on invoke error / malformed payload the hook reports
 *   `isError` and `data: null`; the card renders a bounded "unavailable" state
 *   and ordinary analysis is unaffected (this panel is observational only).
 * - `refresh()` is a no-op while a request is already in flight (prevents
 *   refresh spam from repeated clicks).
 */
export interface UseGeminiProviderQuotaResult {
  data: GeminiProviderQuotaResponse | null;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refresh: () => void;
}

export function useGeminiProviderQuota(
  userId: string | null | undefined,
  canViewProviderQuota: boolean,
): UseGeminiProviderQuotaResult {
  const enabled = !!userId && !!canViewProviderQuota;

  const query = useQuery<GeminiProviderQuotaResponse>({
    queryKey: queryKeys.geminiProviderQuota.all(userId ?? "anonymous"),
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("get-gemini-provider-quota");
      if (error) throw error;
      const normalized = normalizeProviderQuotaResponse(data);
      if (!normalized) throw new Error("Malformed provider-quota response");
      return normalized;
    },
    enabled,
    staleTime: 120_000,
    gcTime: 300_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const { isFetching, refetch } = query;
  const refresh = useCallback(() => {
    // Prevent refresh spam while a request is pending.
    if (!isFetching) refetch();
  }, [isFetching, refetch]);

  return {
    data: query.data ?? null,
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    isFetching,
    refresh,
  };
}
