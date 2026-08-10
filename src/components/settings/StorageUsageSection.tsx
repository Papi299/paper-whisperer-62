import { HardDrive } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/formatBytes";
import type { StorageUsageStatus } from "@/hooks/useStorageUsage";

interface StorageUsageSectionProps {
  status: StorageUsageStatus | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Read-only attachment-storage gauge for Settings.
 *
 * Shows how much of the account's storage quota is consumed before an upload
 * is attempted — quota transparency only. There is **no** upgrade, checkout,
 * pricing, or paywall call to action, and no client-side enforcement: the
 * `check_and_consume_storage_quota` trigger remains authoritative.
 *
 * Every state is communicated in text as well as by the bar, so the gauge is
 * never color- or width-only. It fails soft (a small "unavailable" line) so a
 * failed read never blocks the rest of Settings.
 */
export function StorageUsageSection({ status, isLoading, isError }: StorageUsageSectionProps) {
  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium">Storage</h3>
      </div>
      <StorageUsageBody status={status} isLoading={isLoading} isError={isError} />
    </div>
  );
}

function StorageUsageBody({ status, isLoading, isError }: StorageUsageSectionProps) {
  // Loading: a small placeholder scoped to this section only — the PubMed
  // controls above stay rendered and usable.
  if (isLoading) {
    return <Skeleton className="h-9 w-full" aria-busy="true" aria-label="Loading storage usage" />;
  }

  // Fail soft: a read error, a missing entitlement, or a signed-out/transitional
  // user all render the same neutral line. Raw Postgres/Supabase errors are
  // never surfaced in this gauge.
  if (isError || !status) {
    return <p className="text-sm text-muted-foreground">Storage usage unavailable.</p>;
  }

  // Truthful even past the cap: an over-quota account reads e.g. "512 MB of
  // 500 MB used" while the bar is clamped to full.
  const usageText = `${formatBytes(status.usedBytes)} of ${formatBytes(status.quotaBytes)} used`;

  return (
    <>
      <p className="text-sm tabular-nums">{usageText}</p>
      {/*
        `aria-valuenow` is set explicitly: the shadcn `Progress` wrapper consumes
        `value` for the indicator transform and does not forward it to the Radix
        root, which would otherwise expose the bar as indeterminate. The value
        text carries the same information for screen readers as the lines above
        and below the bar do visually.
      */}
      <Progress
        value={status.percentUsed}
        className="h-2"
        aria-label="Storage usage"
        aria-valuenow={status.percentUsed}
        aria-valuetext={usageText}
      />
      {status.isAtOrOverQuota ? (
        <p className="text-sm text-destructive">
          Storage limit reached. Delete attachments to free space.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground tabular-nums">
          {formatBytes(status.remainingBytes)} remaining
        </p>
      )}
    </>
  );
}
