/**
 * Pure, testable parser for `analyze-paper` Edge Function failures.
 *
 * `supabase.functions.invoke` surfaces a non-2xx response as a
 * `FunctionsHttpError` whose `.context` is the raw `Response`. Its `.message`
 * is the generic *"Edge Function returned a non-2xx status code."* — so the
 * structured quota body the Edge Function returns on HTTP 402 is only
 * reachable by reading `error.context`.
 *
 * This helper recognizes the structured **HTTP 402** quota payload shape
 *   `{ error: "quota_exceeded", message, details: { plan, period_type,
 *      used, quota, remaining, reset_at } }`
 * emitted by `supabase/functions/analyze-paper/index.ts`, using the machine
 * `status === 402` + `error === "quota_exceeded"` fields — never an English
 * error-string match. Every failure mode (no context, non-Response context,
 * already-consumed body, malformed JSON, non-402 status, unexpected shape)
 * falls back to a generic `{ kind: "other" }` result that preserves the
 * pre-existing generic error message.
 */

export interface QuotaExceededInfo {
  /** Plan slug from the server (e.g. "free"). Null when the server omitted it. */
  plan: string | null;
  /** "lifetime" | "monthly" | null (null when the server omitted it). */
  periodType: string | null;
  used: number;
  quota: number;
  remaining: number;
  /** ISO timestamp when a monthly quota resets; null for lifetime / unknown. */
  resetAt: string | null;
  /** Human-readable message the server provided (already non-commercial). */
  message: string;
}

export type ParsedAnalyzeError =
  | { kind: "quota_exceeded"; info: QuotaExceededInfo }
  | { kind: "other"; message: string };

/** True only for an actual finite, non-negative JS number (not a numeric string). */
function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** True for the allowed nullable-string fields (`plan`, `reset_at`). */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** True for the allowed `period_type` values. */
function isValidPeriodType(value: unknown): value is "monthly" | "lifetime" | null {
  return value === "monthly" || value === "lifetime" || value === null;
}

/** Coerce an unknown value to a non-empty string, or null. */
function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Structural shape of the `error.context` we care about (a `Response`). */
interface ResponseLike {
  status?: number;
  clone?: () => ResponseLike;
  json?: () => Promise<unknown>;
}

function getContext(error: unknown): ResponseLike | null {
  if (!error || typeof error !== "object") return null;
  const ctx = (error as { context?: unknown }).context;
  if (!ctx || typeof ctx !== "object") return null;
  return ctx as ResponseLike;
}

/**
 * Parse an `analyze-paper` invoke error.
 *
 * Returns `{ kind: "quota_exceeded", info }` only for a well-formed HTTP 402
 * `quota_exceeded` payload; otherwise `{ kind: "other", message }` with the
 * best available generic message (identical to the previous behavior).
 */
export async function parseAnalyzeError(error: unknown): Promise<ParsedAnalyzeError> {
  const fallback: ParsedAnalyzeError = {
    kind: "other",
    message: error instanceof Error ? error.message : "Unknown error",
  };

  const ctx = getContext(error);
  // Only an HTTP 402 is the quota wall; anything else is a generic failure.
  if (!ctx || ctx.status !== 402 || typeof ctx.json !== "function") {
    return fallback;
  }

  let body: unknown;
  try {
    // Clone when possible so a caller that later reads the body isn't blocked
    // by a "body already used" error; tolerate fakes without `clone`.
    const source = typeof ctx.clone === "function" ? ctx.clone() : ctx;
    if (typeof source.json !== "function") return fallback;
    body = await source.json();
  } catch {
    // Malformed JSON or already-consumed body → generic fallback.
    return fallback;
  }

  if (!body || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  // Validate the machine field, not English prose.
  if (record.error !== "quota_exceeded") return fallback;

  // Strict `details` validation. A missing or malformed `details` object must
  // NOT be silently coerced into an authoritative zero-quota response — that
  // would fabricate a quota wall the server never asserted. Any shape that
  // fails these checks falls through to the generic `{ kind: "other" }`.
  if (!record.details || typeof record.details !== "object") return fallback;
  const details = record.details as Record<string, unknown>;

  const { used, quota, remaining, period_type, reset_at, plan } = details;
  if (
    !isNonNegativeFiniteNumber(used) ||
    !isNonNegativeFiniteNumber(quota) ||
    !isNonNegativeFiniteNumber(remaining) ||
    !isValidPeriodType(period_type) ||
    !isNullableString(reset_at) ||
    !isNullableString(plan)
  ) {
    return fallback;
  }

  return {
    kind: "quota_exceeded",
    info: {
      plan,
      periodType: period_type,
      used,
      quota,
      remaining,
      resetAt: reset_at,
      message: toStringOrNull(record.message) ?? "AI analysis quota exceeded.",
    },
  };
}

/**
 * Format an absolute reset timestamp as its **UTC** calendar date.
 *
 * Quota periods roll over at UTC month boundaries (see `consume_ai_quota` /
 * `get_ai_quota_status`), so the reset date must be rendered in UTC — a naive
 * local-timezone render would shift `2026-08-01T00:00:00Z` back to July 31 for
 * viewers in negative UTC offsets. Returns `null` for absent/invalid input so
 * callers can omit the reset clause entirely rather than print "Invalid Date".
 * Shared by `formatQuotaExceededMessage` and `AiQuotaIndicator` so the two
 * surfaces never diverge. The locale is left to the runtime (not hard-coded).
 */
export function formatResetDate(resetAt: string | null | undefined): string | null {
  if (typeof resetAt !== "string" || resetAt.length === 0) return null;
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      timeZone: "UTC",
    }).format(d);
  } catch {
    return null;
  }
}

/**
 * Build the user-facing quota-exhausted toast copy from parsed 402 info.
 *
 * Intentionally contains **no** upgrade / purchase / billing / paywall
 * language — it explains the limit and (for monthly plans) when it resets.
 * Shared by the single and bulk analysis paths so the wording stays
 * consistent and testable.
 */
export function formatQuotaExceededMessage(info: Pick<QuotaExceededInfo, "periodType" | "used" | "quota" | "resetAt">): string {
  // No active AI bucket (period_type null) → neutral "unavailable" wording,
  // consistent with the indicator. Do NOT describe a null-period allowance as
  // "lifetime" — there is no lifetime bucket to have exhausted.
  if (info.periodType === null) {
    return "AI analysis is currently unavailable.";
  }
  const periodLabel = info.periodType === "monthly" ? "monthly" : "lifetime";
  const base =
    info.quota > 0
      ? `You've used all ${info.quota} of your ${periodLabel} AI analyses.`
      : `You have no AI analyses remaining on your ${periodLabel} allowance.`;
  if (info.periodType === "monthly") {
    const reset = formatResetDate(info.resetAt);
    if (reset) return `${base} Your quota resets on ${reset}.`;
  }
  return base;
}
