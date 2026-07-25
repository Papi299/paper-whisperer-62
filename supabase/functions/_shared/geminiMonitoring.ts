// Pure normalization of Google Cloud Monitoring `projects.timeSeries.list`
// results into a bounded, UI-safe shape describing the SHARED Gemini provider
// quota — Part C.
//
// Pure module (no Deno APIs, no remote imports): the get-gemini-provider-quota
// Edge Function (Deno) fetches Monitoring and calls normalizeMonitoringTimeSeries;
// Vitest (Node) imports and tests it directly with synthetic payloads (no Deno,
// no real Monitoring API). This is the file the "Monitoring payload
// normalization", "exact label-based joining", and "no fabricated remaining
// value" tests target.
//
// Hard rules encoded here:
//   - Only the official free-tier generate_content metric families are read;
//     *_internal metrics are ignored.
//   - Usage and limit are joined ONLY when the labels identify the same quota
//     dimension (family + model + limit_name).
//   - A missing metric is NEVER invented as zero (used/limit stay null).
//   - `remaining` is computed ONLY when both used and limit are known AND the
//     measurement window is reliably inferable; otherwise it is null.
//   - Unknown/unsupported limit_name → window "unknown" and remaining null.

// ── Public contract (mirrored on the client in src/lib/geminiProviderQuota.ts) ──

export type GeminiQuotaCategory = "requests" | "input_tokens";
export type GeminiQuotaWindow = "minute" | "day" | "unknown";

export interface GeminiQuotaDimension {
  category: GeminiQuotaCategory;
  model: string;
  limitName: string;
  /** method label (RPC), preserved when present; null otherwise. */
  method: string | null;
  window: GeminiQuotaWindow;
  used: number | null;
  limit: number | null;
  /** Only set when used+limit known AND window reliable; else null (never faked). */
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

// ── Official free-tier generate_content metric families ─────────────────
// generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/{limit,usage,exceeded}
// generativelanguage.googleapis.com/quota/generate_content_free_tier_input_token_count/{limit,usage,exceeded}
const FAMILY_REQUESTS = "generate_content_free_tier_requests";
const FAMILY_INPUT_TOKENS = "generate_content_free_tier_input_token_count";

/** Metric families we query (limit + usage + exceeded for each). */
export const GEMINI_QUOTA_METRIC_FAMILIES: readonly string[] = [
  `generativelanguage.googleapis.com/quota/${FAMILY_REQUESTS}`,
  `generativelanguage.googleapis.com/quota/${FAMILY_INPUT_TOKENS}`,
];

type Measure = "limit" | "usage" | "exceeded";

interface ParsedMetric {
  category: GeminiQuotaCategory;
  measure: Measure;
}

/** Loose shapes for defensive parsing of the Monitoring response. */
export interface RawPointValue {
  int64Value?: string | number;
  doubleValue?: number;
}
export interface RawPoint {
  value?: RawPointValue;
  interval?: { startTime?: string; endTime?: string };
}
export interface RawTimeSeries {
  metric?: { type?: string; labels?: Record<string, unknown> };
  resource?: { type?: string; labels?: Record<string, unknown> };
  metricKind?: string;
  valueType?: string;
  points?: RawPoint[];
}

export interface NormalizeOptions {
  configuredModel: string;
  collectedAt: string;
  metricsMayLagSeconds: number;
}

/** Parse a metric type into (category, measure), or null if not a family we read. */
function parseMetricType(type: string): ParsedMetric | null {
  if (!type || !type.includes("/quota/")) return null;
  // Never query or interpret internal metrics.
  if (type.includes("_internal")) return null;

  let category: GeminiQuotaCategory | null = null;
  if (type.includes(FAMILY_INPUT_TOKENS)) category = "input_tokens";
  else if (type.includes(FAMILY_REQUESTS)) category = "requests";
  if (!category) return null;

  let measure: Measure | null = null;
  if (type.endsWith("/limit")) measure = "limit";
  else if (type.endsWith("/usage")) measure = "usage";
  else if (type.endsWith("/exceeded")) measure = "exceeded";
  if (!measure) return null;

  return { category, measure };
}

/** Infer the measurement window from the limit_name label. */
export function inferWindow(limitName: string): GeminiQuotaWindow {
  const n = (limitName || "").toLowerCase();
  if (n.includes("perminute") || n.includes("per_minute")) return "minute";
  if (n.includes("perday") || n.includes("per_day")) return "day";
  return "unknown";
}

function numericPoint(p: RawPoint): number | null {
  const v = p?.value;
  if (!v) return null;
  if (typeof v.int64Value === "number" && Number.isFinite(v.int64Value)) return v.int64Value;
  if (typeof v.int64Value === "string") {
    const n = Number(v.int64Value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v.doubleValue === "number" && Number.isFinite(v.doubleValue)) return v.doubleValue;
  return null;
}

/** Sum all numeric points (DELTA usage/exceeded over the query window). null if none. */
function sumPoints(points: RawPoint[] | undefined): number | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  let total = 0;
  let seen = false;
  for (const p of points) {
    const n = numericPoint(p);
    if (n !== null) {
      total += n;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** Most recent numeric point (GAUGE limit). Monitoring returns points newest-first. */
function latestPoint(points: RawPoint[] | undefined): number | null {
  if (!Array.isArray(points)) return null;
  for (const p of points) {
    const n = numericPoint(p);
    if (n !== null) return n;
  }
  return null;
}

function labelString(labels: Record<string, unknown> | undefined, key: string): string | null {
  const v = labels?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** remaining only when used+limit known AND window reliable; never fabricated. */
export function computeRemaining(
  limit: number | null,
  used: number | null,
  window: GeminiQuotaWindow,
): number | null {
  if (limit === null || used === null) return null;
  if (window === "unknown") return null;
  return Math.max(limit - used, 0);
}

interface DimAccumulator {
  category: GeminiQuotaCategory;
  model: string;
  limitName: string;
  method: string | null;
  window: GeminiQuotaWindow;
  used: number | null;
  limit: number | null;
  exceeded: number | null;
}

function addValue(current: number | null, next: number | null): number | null {
  if (next === null) return current;
  return (current ?? 0) + next;
}

/** Deterministic dimension ordering for stable rendering + tests. */
function compareDimensions(a: GeminiQuotaDimension, b: GeminiQuotaDimension): number {
  if (a.category !== b.category) return a.category.localeCompare(b.category);
  if (a.model !== b.model) return a.model.localeCompare(b.model);
  return a.limitName.localeCompare(b.limitName);
}

/**
 * Normalize a Monitoring timeSeries array into the bounded provider-quota shape.
 * Dimensions are keyed by (category, model, limit_name) so usage/limit/exceeded
 * series only combine when they describe the SAME quota dimension.
 */
export function normalizeMonitoringTimeSeries(
  timeSeries: RawTimeSeries[] | undefined | null,
  opts: NormalizeOptions,
): GeminiProviderQuotaResponse {
  const dims = new Map<string, DimAccumulator>();
  const observedModels = new Set<string>();

  for (const ts of Array.isArray(timeSeries) ? timeSeries : []) {
    const parsed = parseMetricType(ts?.metric?.type ?? "");
    if (!parsed) continue;

    const labels = ts?.metric?.labels;
    const modelLabel = labelString(labels, "model");
    const model = modelLabel ?? "unknown";
    const limitName = labelString(labels, "limit_name") ?? "unknown";
    const method = labelString(labels, "method");
    if (modelLabel) observedModels.add(modelLabel);

    const key = `${parsed.category}::${model}::${limitName}`;
    let dim = dims.get(key);
    if (!dim) {
      dim = {
        category: parsed.category,
        model,
        limitName,
        method,
        window: inferWindow(limitName),
        used: null,
        limit: null,
        exceeded: null,
      };
      dims.set(key, dim);
    } else if (method && !dim.method) {
      dim.method = method;
    }

    if (parsed.measure === "limit") {
      // GAUGE: latest value. If multiple limit series map here, keep the max.
      const v = latestPoint(ts.points);
      if (v !== null) dim.limit = dim.limit === null ? v : Math.max(dim.limit, v);
    } else if (parsed.measure === "usage") {
      dim.used = addValue(dim.used, sumPoints(ts.points));
    } else {
      dim.exceeded = addValue(dim.exceeded, sumPoints(ts.points));
    }
  }

  const dimensions: GeminiQuotaDimension[] = [...dims.values()]
    .map((d) => ({
      category: d.category,
      model: d.model,
      limitName: d.limitName,
      method: d.method,
      window: d.window,
      used: d.used,
      limit: d.limit,
      remaining: computeRemaining(d.limit, d.used, d.window),
      exceededAttempts: d.exceeded,
    }))
    .sort(compareDimensions);

  const hasData = dimensions.length > 0;
  return {
    status: hasData ? "ok" : "unavailable",
    configuredModel: opts.configuredModel,
    observedModels: [...observedModels].sort(),
    providerTier: hasData ? "free" : "unknown",
    sharedScope: true,
    collectedAt: opts.collectedAt,
    metricsMayLagSeconds: opts.metricsMayLagSeconds,
    dimensions,
    ...(hasData ? {} : { message: "No Gemini provider-quota metrics were returned." }),
  };
}

/**
 * Merge a daily-window query result with a minute-window query result.
 *
 * Daily and minute usage need different Monitoring intervals (DELTA usage is
 * summed over the query window), so the Edge Function runs two timeSeries.list
 * calls and normalizes each. This picks day + unknown-window dimensions from the
 * daily result and minute-window dimensions from the minute result, so each
 * dimension's `used` reflects the correct window. Pure and order-independent.
 */
export function mergeWindowedProviderQuota(
  daily: GeminiProviderQuotaResponse,
  minute: GeminiProviderQuotaResponse,
): GeminiProviderQuotaResponse {
  const dimensions = [
    ...daily.dimensions.filter((d) => d.window === "day" || d.window === "unknown"),
    ...minute.dimensions.filter((d) => d.window === "minute"),
  ].sort(compareDimensions);

  const observedModels = [...new Set([...daily.observedModels, ...minute.observedModels])].sort();
  const hasData = dimensions.length > 0;
  return {
    status: hasData ? "ok" : "unavailable",
    configuredModel: daily.configuredModel,
    observedModels,
    providerTier: hasData ? "free" : "unknown",
    sharedScope: true,
    collectedAt: daily.collectedAt,
    metricsMayLagSeconds: Math.max(daily.metricsMayLagSeconds, minute.metricsMayLagSeconds),
    dimensions,
    ...(hasData ? {} : { message: "No Gemini provider-quota metrics were returned." }),
  };
}

/** The soft-unavailable response used when Monitoring can't be reached/authorized. */
export function unavailableProviderQuota(
  configuredModel: string,
  collectedAt: string,
  message: string,
): GeminiProviderQuotaResponse {
  return {
    status: "unavailable",
    configuredModel,
    observedModels: [],
    providerTier: "unknown",
    sharedScope: true,
    collectedAt,
    metricsMayLagSeconds: 0,
    dimensions: [],
    message,
  };
}
