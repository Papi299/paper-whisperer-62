import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Normalized, UI-facing attachment-storage usage status.
 *
 * Sourced from two SELECT-own client reads: `user_storage_usage.used_bytes`
 * (the running accounting total maintained by the server-side
 * check-and-consume / refund triggers on `paper_attachments`) and
 * `user_entitlements.storage_quota_bytes` (the enforced quota). Both tables
 * are `FORCE ROW LEVEL SECURITY` with a SELECT-own policy and **no** client
 * write policy or grant — this hook is read-only by construction.
 *
 * This is advisory display only. The `check_and_consume_storage_quota`
 * BEFORE INSERT trigger remains the authoritative enforcement boundary; a
 * momentarily stale gauge never permits or blocks an upload.
 */
export interface StorageUsageStatus {
  /** Bytes consumed by the user's attachments. Missing usage row ⇒ 0. */
  usedBytes: number;
  /** The user's enforced `storage_quota_bytes`. */
  quotaBytes: number;
  /** `max(quota - used, 0)` — never negative, even past the cap. */
  remainingBytes: number;
  /**
   * Finite percentage clamped to the Progress component's valid 0–100 range.
   * A quota of 0 (or an over-quota total) reads 100: no space is available.
   * This is the **bar** value only — `usedBytes`/`quotaBytes` stay truthful.
   */
  percentUsed: number;
  /** True when `usedBytes >= quotaBytes` (at the cap, or historically past it). */
  isAtOrOverQuota: boolean;
}

/** Raw row shapes for the two SELECT-own projections. */
interface StorageUsageRow {
  used_bytes: number | null;
}
interface StorageQuotaRow {
  storage_quota_bytes: number | null;
}

function toNonNegative(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalize(usedBytes: number, quotaBytes: number): StorageUsageStatus {
  const used = toNonNegative(usedBytes);
  const quota = toNonNegative(quotaBytes);
  const remainingBytes = Math.max(quota - used, 0);

  // Division safety: a zero quota has no ratio to compute. Nothing can be
  // stored against it, so the bar reads full — while the text still reports
  // the real `used of quota` values.
  const percentUsed =
    quota <= 0 ? 100 : Math.min(100, Math.max(0, Math.round((used / quota) * 100)));

  return {
    usedBytes: used,
    quotaBytes: quota,
    remainingBytes,
    percentUsed,
    isAtOrOverQuota: used >= quota,
  };
}

export interface UseStorageUsageResult {
  status: StorageUsageStatus | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export interface UseStorageUsageOptions {
  /**
   * Gate the fetch on the consuming surface being visible (Settings open).
   * Defaults to `true`; combined with a present `userId`.
   */
  enabled?: boolean;
}

/**
 * Read-only attachment-storage usage for the signed-in user.
 *
 * - Disabled unless a `userId` exists **and** the caller enables it, so no
 *   background storage query runs while Settings is closed.
 * - `staleTime: 0` overrides the app-wide 5-minute default so reopening
 *   Settings refetches, reflecting attachment activity since the last visit.
 * - S2 defense-in-depth: **both** reads carry an explicit
 *   `.eq("user_id", userId)` predicate in addition to RLS.
 * - The query key is scoped by `userId` so one user can never read another
 *   user's cached storage figures.
 * - Missing `user_storage_usage` row ⇒ `usedBytes: 0`. The signup trigger does
 *   not create one; it is guaranteed lazily by the first upload, so its absence
 *   means "no attachments yet", not an error.
 * - Missing entitlement row ⇒ `status: null` (unavailable). No Free 500 MB
 *   fallback is invented — the server owns the quota.
 * - Fails **softly**: on a read error the hook returns `status: null` and
 *   `isError: true`; the rest of Settings stays usable.
 */
export function useStorageUsage(
  userId: string | null | undefined,
  options?: UseStorageUsageOptions,
): UseStorageUsageResult {
  const enabled = !!userId && (options?.enabled ?? true);

  const { data, isLoading, isError, refetch } = useQuery<StorageUsageStatus | null>({
    queryKey: queryKeys.storageUsage.status(userId ?? "anonymous"),
    queryFn: async () => {
      const [usageResult, entitlementResult] = await Promise.all([
        supabase
          .from("user_storage_usage")
          .select("used_bytes")
          .eq("user_id", userId!)
          .maybeSingle(),
        supabase
          .from("user_entitlements")
          .select("storage_quota_bytes")
          .eq("user_id", userId!)
          .maybeSingle(),
      ]);

      if (usageResult.error) throw usageResult.error;
      if (entitlementResult.error) throw entitlementResult.error;

      const entitlement = entitlementResult.data as StorageQuotaRow | null;
      // No entitlement ⇒ no quota to render against. Report unavailable rather
      // than fabricating a plan baseline.
      if (!entitlement) return null;

      const usage = usageResult.data as StorageUsageRow | null;
      return normalize(usage?.used_bytes ?? 0, entitlement.storage_quota_bytes ?? 0);
    },
    enabled,
    // Deliberately 0 (the app default is 5 minutes): the gauge must be fresh
    // each time Settings is opened.
    staleTime: 0,
  });

  return {
    status: data ?? null,
    // A disabled query is not loading.
    isLoading: enabled && isLoading,
    isError,
    refetch,
  };
}
