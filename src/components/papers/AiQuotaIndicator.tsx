import { Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatResetDate } from "@/lib/analyzeError";
import type { AiQuotaStatus } from "@/hooks/useAiQuota";

interface AiQuotaIndicatorProps {
  status: AiQuotaStatus | null;
  isLoading: boolean;
  isError: boolean;
  /**
   * `full` — the desktop header presentation ("AI analyses: 7 of 15 · Lifetime").
   * `compact` — the same information reduced to a glyph and a number
   * ("✨ 7/15") for the mobile utility row, where the full sentence consumed
   * roughly a third of a 390px line.
   *
   * Only the VISIBLE text differs. The `role="status"`, the full descriptive
   * `aria-label` and the `title` are byte-identical across variants, so the
   * compact form is never the only carrier of the state, and no quota number
   * is computed differently.
   */
  variant?: "full" | "compact";
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
export function AiQuotaIndicator({
  status,
  isLoading,
  isError,
  variant = "full",
}: AiQuotaIndicatorProps) {
  const compact = variant === "compact";
  const shellClass = compact
    ? "flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm"
    : "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm";

  // Loading: fixed footprint to avoid layout shift.
  if (isLoading) {
    return (
      <Skeleton
        className={compact ? "h-8 w-14" : "h-8 w-32"}
        aria-busy="true"
        aria-label="Loading AI analysis quota"
      />
    );
  }

  // Fail soft: nothing to show on error or before the status resolves.
  if (isError || !status) return null;

  // Internal AI-quota exemption. Show "Unlimited" ONLY when the server is
  // authoritatively an ACTIVE exemption (isExempt + allowed + reason). An
  // inactive/missing entitlement with a stray isExempt must fall through to the
  // unavailable state, not read as Unlimited. Role-neutral wording (an explicit
  // exemption may also be granted to a manager). No fabricated number, no
  // Labs/Teams or checkout/upgrade copy.
  if (status.isExempt && status.allowed && status.reason === "quota_exempt") {
    const supporting =
      "Unlimited AI analyses — internal AI quota exemption. Paperlume's commercial quota is not enforced for your account; analyses are still recorded for operational usage.";
    return (
      <div
        className={`${shellClass} text-muted-foreground`}
        role="status"
        aria-label={supporting}
        title={supporting}
      >
        <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="whitespace-nowrap">
          {compact ? (
            <span className="font-medium">∞</span>
          ) : (
            <>
              AI analyses: <span className="font-medium">Unlimited</span>
            </>
          )}
        </span>
      </div>
    );
  }

  const periodLabel = status.periodType === "monthly" ? "This month" : "Lifetime";

  // No active AI bucket (inactive / missing entitlement, or a zero-AI plan).
  if (status.periodType === null) {
    return (
      <div
        className={`${shellClass} text-muted-foreground`}
        role="status"
        aria-label="AI analyses unavailable"
        title="AI analysis is not available on your current plan."
      >
        <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{compact ? "Unavailable" : "AI analyses: unavailable"}</span>
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
      className={`${shellClass} ${
        isEmpty ? "text-destructive border-destructive/40" : "text-muted-foreground"
      }`}
      role="status"
      aria-label={supporting}
      title={supporting}
    >
      <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
      {compact ? (
        <span className="whitespace-nowrap tabular-nums">
          {status.remaining}/{status.quota}
        </span>
      ) : (
        <>
          <span className="whitespace-nowrap">
            AI analyses: <span className="font-medium tabular-nums">{status.remaining}</span> of{" "}
            <span className="tabular-nums">{status.quota}</span>
            {isEmpty ? " — none left" : ""}
          </span>
          <span className="text-xs text-muted-foreground">· {periodLabel}</span>
        </>
      )}
    </div>
  );
}
