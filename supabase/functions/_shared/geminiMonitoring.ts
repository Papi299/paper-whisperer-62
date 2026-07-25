// Pure normalization + request-planning for Google Cloud Monitoring
// `projects.timeSeries.list` describing the SHARED Gemini provider quota — Part C.
//
// Pure module (no Deno APIs, no remote imports): the get-gemini-provider-quota
// Edge Function (Deno) supplies a `fetch`-shaped dependency; Vitest (Node) tests
// this directly with synthetic payloads and a fake fetcher (no Deno, no real
// Monitoring API). This is the file the "Monitoring payload normalization",
// "exact label-based joining", "no fabricated remaining value", "one metric type
// per request", and "minute-window aggregation" tests target.
//
// Hard rules encoded here:
//   - Each Monitoring request queries EXACTLY ONE metric type (Monitoring
//     rejects `metric.type = A OR metric.type = B`). See buildTimeSeriesFilter.
//   - Only the official free-tier generate_content metric families are read;
//     *_internal metrics are ignored.
//   - Usage and limit are joined ONLY when the labels identify the same quota
//     dimension (category + model + limit_name).
//   - A missing metric is NEVER invented as zero (used/limit stay null).
//   - `remaining` is computed ONLY when both used and limit are known AND the
//     measurement window is reliably inferable; otherwise it is null.
//   - Daily usage sums DELTA points over the Pacific-day interval; MINUTE usage
//     is the value of the newest COMPLETE 60-second bucket (never a multi-minute
//     sum), or null when no complete bucket exists.
//   - If several usage series with different `method` labels aggregate into one
//     dimension, `method` is set to null (aggregated) — never one arbitrary value.

// ── Public contract (mirrored on the client in src/lib/geminiProviderQuota.ts) ──

export type GeminiQuotaCategory = "requests" | "input_tokens";
export type GeminiQuotaWindow = "minute" | "day" | "unknown";

export interface GeminiQuotaDimension {
  category: GeminiQuotaCategory;
  model: string;
  limitName: string;
  /** Single contributing method, or null when absent OR when >1 method aggregated. */
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

/** The two families (base metric-type prefixes) we read. */
export const GEMINI_QUOTA_METRIC_FAMILIES: readonly string[] = [
  `generativelanguage.googleapis.com/quota/${FAMILY_REQUESTS}`,
  `generativelanguage.googleapis.com/quota/${FAMILY_INPUT_TOKENS}`,
];

type Measure = "limit" | "usage" | "exceeded";
const MEASURES: readonly Measure[] = ["limit", "usage", "exceeded"];

/** The six concrete metric types (2 families × 3 measures) we query, one per request. */
export function buildMetricTypes(): string[] {
  return GEMINI_QUOTA_METRIC_FAMILIES.flatMap((f) => MEASURES.map((m) => `${f}/${m}`));
}

/** A Monitoring filter selecting EXACTLY ONE metric type — never an OR of several. */
export function buildTimeSeriesFilter(metricType: string): string {
  return `metric.type = "${metricType}"`;
}

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

/** How to aggregate DELTA usage/exceeded points. */
export type UsageMode = "sum" | "newest-minute";
export interface NormalizeConfig {
  usageMode: UsageMode;
  /** Required for "newest-minute": the current instant (ms) for completeness. */
  nowMs?: number;
}

/** Parse a metric type into (category, measure), or null if not a family we read. */
function parseMetricType(type: string): ParsedMetric | null {
  if (!type || !type.includes("/quota/")) return null;
  if (type.includes("_internal")) return null; // never interpret internal metrics

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

function parseMs(iso: string | undefined): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
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

/**
 * Value of the newest COMPLETE 60-second bucket. A point qualifies only when it
 * has a ~60s interval (50–70s tolerance) whose endTime is at/earlier than `now`
 * (i.e. not still forming). Returns null when no bucket qualifies — never a
 * multi-minute sum and never a fabricated zero.
 */
export function newestCompleteMinutePoint(points: RawPoint[] | undefined, nowMs: number): number | null {
  if (!Array.isArray(points)) return null;
  let best: number | null = null;
  let bestEnd = -Infinity;
  for (const p of points) {
    const val = numericPoint(p);
    if (val === null) continue;
    const startMs = parseMs(p.interval?.startTime);
    const endMs = parseMs(p.interval?.endTime);
    if (startMs === null || endMs === null) continue;
    const dur = endMs - startMs;
    if (dur < 50_000 || dur > 70_000) continue; // ~60s bucket only
    if (endMs > nowMs) continue; // still forming → not complete
    if (endMs > bestEnd) {
      bestEnd = endMs;
      best = val;
    }
  }
  return best;
}

function aggregateUsage(points: RawPoint[] | undefined, config: NormalizeConfig): number | null {
  if (config.usageMode === "newest-minute") {
    return newestCompleteMinutePoint(points, config.nowMs ?? Number.MAX_SAFE_INTEGER);
  }
  return sumPoints(points);
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
  methods: Set<string>;
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
 * series only combine when they describe the SAME quota dimension. `config`
 * controls DELTA aggregation: "sum" (daily) or "newest-minute" (per-minute).
 */
export function normalizeMonitoringTimeSeries(
  timeSeries: RawTimeSeries[] | undefined | null,
  opts: NormalizeOptions,
  config: NormalizeConfig = { usageMode: "sum" },
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
        methods: new Set<string>(),
        window: inferWindow(limitName),
        used: null,
        limit: null,
        exceeded: null,
      };
      dims.set(key, dim);
    }
    if (method) dim.methods.add(method);

    if (parsed.measure === "limit") {
      const v = latestPoint(ts.points);
      if (v !== null) dim.limit = dim.limit === null ? v : Math.max(dim.limit, v);
    } else if (parsed.measure === "usage") {
      dim.used = addValue(dim.used, aggregateUsage(ts.points, config));
    } else {
      dim.exceeded = addValue(dim.exceeded, aggregateUsage(ts.points, config));
    }
  }

  const dimensions: GeminiQuotaDimension[] = [...dims.values()]
    .map((d) => ({
      category: d.category,
      model: d.model,
      limitName: d.limitName,
      // One contributing method → show it; zero or several → null (aggregated),
      // never one arbitrary method as though it represented the whole aggregate.
      method: d.methods.size === 1 ? [...d.methods][0] : null,
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
 * Merge a daily-window query result with a minute-window query result. Daily and
 * minute usage need different intervals + aggregation, so the collector runs two
 * passes. This keeps day + unknown-window dimensions from the daily result and
 * minute-window dimensions from the minute result, so each dimension's `used`
 * reflects the correct window. Pure and order-independent.
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

// ── Request plan (dependency-injected; no Deno / no network here) ────────

export interface TimeSeriesRequest {
  metricType: string;
  startTimeIso: string;
  endTimeIso: string;
  pageToken?: string;
  /** When set, the caller should request DELTA data aligned to this period (s). */
  alignmentPeriodSeconds?: number;
}

/** One page of a Monitoring timeSeries.list response. */
export interface TimeSeriesPage {
  timeSeries: RawTimeSeries[];
  nextPageToken: string | null;
}

/** Injected fetcher — the Deno function supplies the real HTTP implementation. */
export type TimeSeriesFetcher = (req: TimeSeriesRequest) => Promise<TimeSeriesPage>;

const MAX_PAGES = 20;

/** Follow nextPageToken until exhausted (bounded) and concatenate all series. */
export async function fetchAllPagesForMetric(
  fetcher: TimeSeriesFetcher,
  base: Omit<TimeSeriesRequest, "pageToken">,
): Promise<RawTimeSeries[]> {
  const all: RawTimeSeries[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetcher({ ...base, pageToken });
    if (Array.isArray(res?.timeSeries)) all.push(...res.timeSeries);
    const next = res?.nextPageToken;
    if (!next) break;
    pageToken = next;
  }
  return all;
}

export interface CollectOptions {
  configuredModel: string;
  collectedAtIso: string;
  nowMs: number;
  dayStartIso: string;
  minuteStartIso: string;
  endIso: string;
  metricsMayLagSeconds: number;
  /** Bounded, non-sensitive message used if collection fails. */
  unavailableMessage?: string;
}

/**
 * Run the full request plan with the injected fetcher: one request per metric
 * type per window, each single-metric and page-followed; then normalize the
 * daily pass (sum) and the minute pass (newest complete 60s bucket) and merge.
 * DELTA usage/exceeded in the minute pass are requested with 60s alignment;
 * GAUGE limit series are fetched unaligned (aligning a gauge as DELTA is invalid).
 * Any failure yields the bounded unavailable result — no raw Google body leaks.
 */
export async function collectProviderQuota(
  fetcher: TimeSeriesFetcher,
  opts: CollectOptions,
): Promise<GeminiProviderQuotaResponse> {
  const metricTypes = buildMetricTypes();
  const normOpts: NormalizeOptions = {
    configuredModel: opts.configuredModel,
    collectedAt: opts.collectedAtIso,
    metricsMayLagSeconds: opts.metricsMayLagSeconds,
  };
  try {
    const daySeries = (
      await Promise.all(
        metricTypes.map((metricType) =>
          fetchAllPagesForMetric(fetcher, {
            metricType,
            startTimeIso: opts.dayStartIso,
            endTimeIso: opts.endIso,
          }),
        ),
      )
    ).flat();

    const minuteSeries = (
      await Promise.all(
        metricTypes.map((metricType) =>
          fetchAllPagesForMetric(fetcher, {
            metricType,
            startTimeIso: opts.minuteStartIso,
            endTimeIso: opts.endIso,
            // Align DELTA usage/exceeded to 60s; leave GAUGE limits unaligned.
            alignmentPeriodSeconds: metricType.endsWith("/limit") ? undefined : 60,
          }),
        ),
      )
    ).flat();

    const dayResp = normalizeMonitoringTimeSeries(daySeries, normOpts, { usageMode: "sum" });
    const minuteResp = normalizeMonitoringTimeSeries(minuteSeries, normOpts, {
      usageMode: "newest-minute",
      nowMs: opts.nowMs,
    });
    return mergeWindowedProviderQuota(dayResp, minuteResp);
  } catch {
    return unavailableProviderQuota(
      opts.configuredModel,
      opts.collectedAtIso,
      opts.unavailableMessage ?? "Gemini provider quota is temporarily unavailable.",
    );
  }
}
