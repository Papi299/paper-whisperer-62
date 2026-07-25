/**
 * Client-side contract for the manager-only Google Gemini provider-quota panel.
 *
 * Mirrors the shape produced by the `get-gemini-provider-quota` Edge Function
 * (see `supabase/functions/_shared/geminiMonitoring.ts`). The Edge/Deno and
 * client/Node module boundaries can't share a file, so — like `analyzeError.ts`
 * re-declares the 402 body — this re-declares the response shape and adds a
 * defensive, fail-soft normalizer for the invoke result.
 *
 * This is the SHARED, project-level provider quota, distinct from the per-user
 * Paperlume allowance (`useAiQuota`). The two must never be combined into one
 * "remaining" number.
 */

export type GeminiQuotaCategory = "requests" | "input_tokens";
export type GeminiQuotaWindow = "minute" | "day" | "unknown";

export interface GeminiQuotaDimension {
  category: GeminiQuotaCategory;
  model: string;
  limitName: string;
  method: string | null;
  window: GeminiQuotaWindow;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  exceededAttempts: number | null;
}

export interface GeminiProviderQuotaResponse {
  status: "ok" | "unavailable";
  configuredModel: string;
  observedModels: string[];
  providerTier: "free" | "unknown";
  sharedScope: true;
  collectedAt: string;
  metricsMayLagSeconds: number;
  dimensions: GeminiQuotaDimension[];
  message?: string;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isCategory(v: unknown): v is GeminiQuotaCategory {
  return v === "requests" || v === "input_tokens";
}

function isWindow(v: unknown): v is GeminiQuotaWindow {
  return v === "minute" || v === "day" || v === "unknown";
}

function normalizeDimension(raw: unknown): GeminiQuotaDimension | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isCategory(r.category)) return null;
  const window = isWindow(r.window) ? r.window : "unknown";
  return {
    category: r.category,
    model: typeof r.model === "string" && r.model ? r.model : "unknown",
    limitName: typeof r.limitName === "string" && r.limitName ? r.limitName : "unknown",
    method: typeof r.method === "string" && r.method ? r.method : null,
    window,
    used: numberOrNull(r.used),
    limit: numberOrNull(r.limit),
    remaining: numberOrNull(r.remaining),
    exceededAttempts: numberOrNull(r.exceededAttempts),
  };
}

/**
 * Defensively normalize the Edge invoke result into a well-formed response, or
 * `null` when the payload is unusable. Fail-soft: callers render the
 * "unavailable" state rather than crash on a malformed/absent payload.
 */
export function normalizeProviderQuotaResponse(raw: unknown): GeminiProviderQuotaResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = r.status === "ok" || r.status === "unavailable" ? r.status : null;
  if (!status) return null;

  const dimensions = Array.isArray(r.dimensions)
    ? r.dimensions.map(normalizeDimension).filter((d): d is GeminiQuotaDimension => d !== null)
    : [];

  return {
    status,
    configuredModel: typeof r.configuredModel === "string" ? r.configuredModel : "unknown",
    observedModels: Array.isArray(r.observedModels)
      ? r.observedModels.filter((m): m is string => typeof m === "string")
      : [],
    providerTier: r.providerTier === "free" ? "free" : "unknown",
    sharedScope: true,
    collectedAt: typeof r.collectedAt === "string" ? r.collectedAt : "",
    metricsMayLagSeconds: numberOrNull(r.metricsMayLagSeconds) ?? 0,
    dimensions,
    ...(typeof r.message === "string" ? { message: r.message } : {}),
  };
}

/** Human labels for the two quota categories. */
export function categoryLabel(category: GeminiQuotaCategory): string {
  return category === "requests" ? "Requests" : "Input tokens";
}

/** Human labels for the measurement window. */
export function windowLabel(window: GeminiQuotaWindow): string {
  if (window === "minute") return "per minute";
  if (window === "day") return "per day (Pacific)";
  return "window unknown";
}
