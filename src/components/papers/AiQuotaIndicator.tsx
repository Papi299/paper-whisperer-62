import { Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatResetDate } from "@/lib/analyzeError";
import type { AiQuotaStatus } from "@/hooks/useAiQuota";

interface AiQuotaIndicatorProps {
  status: AiQuotaStatus | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Compact, accessible AI-analysis quota indicator for the Dashboard header.
 *
 * Shows remaining / total AI analyses before the user starts an analysis, the
 * lifetime-vs-monthly semantics, and (for monthly plans) the reset date —
 * all as accessible supporting text via `aria-label` + `title`, not color
 * alone. It renders a fixed-size skeleton while loading (no layout shift) and
 * **fails soft**: on error, or when the status has not resolved, it renders
 * nothing so the rest of the header is unaffected.
 *
 * It contains NO upgrade / purchase / checkout / pricing / billing / paywall
 * call to action — quota transparency only. The server remains the
 * enforcement boundary; this display can be momentarily stale.
 */
export function AiQuotaIndicator({ status, isLoading, isError }: AiQuotaIndicatorProps) {
  // Loading: fixed footprint to avoid layout shift.
  if (isLoading) {
    return <Skeleton className="h-8 w-32" aria-busy="true" aria-label="Loading AI analysis quota" />;
  }

  // Fail soft: nothing to show on error or before the status resolves.
  if (isError || !status) return null;

  // Internal AI-quota exemption (owner / granted manager). Show "Unlimited" —
  // never a fabricated number — with an accessible explanation. No Labs/Teams
  // wording, no checkout/upgrade CTA.
  if (status.isExempt) {
    const supporting =
      "Unlimited AI analyses — internal owner access. Paperlume's commercial quota is not enforced for your account; analyses are still recorded for operational usage.";
    return (
      <div
        className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm text-muted-foreground"
        role="status"
        aria-label={supporting}
        title={supporting}
      >
        <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="whitespace-nowrap">
          AI analyses: <span className="font-medium">Unlimited</span>
        </span>
      </div>
    );
  }

  const periodLabel = status.periodType === "monthly" ? "This month" : "Lifetime";

  // No active AI bucket (inactive / missing entitlement, or a zero-AI plan).
  if (status.periodType === null) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm text-muted-foreground"
        role="status"
        aria-label="AI analyses unavailable"
        title="AI analysis is not available on your current plan."
      >
        <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>AI analyses: unavailable</span>
      </div>
    );
  }

  const isEmpty = status.remaining <= 0;

  let resetText = "";
  if (status.periodType === "monthly") {
    const reset = formatResetDate(status.resetAt);
    if (reset) resetText = ` Resets ${reset}.`;
  }

  const supporting = `${periodLabel} AI analysis allowance: ${status.remaining} of ${status.quota} remaining.${resetText}`;

  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm ${
        isEmpty ? "text-destructive border-destructive/40" : "text-muted-foreground"
      }`}
      role="status"
      aria-label={supporting}
      title={supporting}
    >
      <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="whitespace-nowrap">
        AI analyses: <span className="font-medium tabular-nums">{status.remaining}</span> of{" "}
        <span className="tabular-nums">{status.quota}</span>
        {isEmpty ? " — none left" : ""}
      </span>
      <span className="text-xs text-muted-foreground">· {periodLabel}</span>
    </div>
  );
}
