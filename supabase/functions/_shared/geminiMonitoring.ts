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
//   - Daily usage sums DELTA points over the Pacific-day interval (unaligned).
//     MINUTE usage sums each series' newest COMPLETE 60-second bucket (requested
//     upstream with ALIGN_SUM, never ALIGN_DELTA) but ONLY across a bucket-end
//     timestamp every contributing series shares — different minutes are never
//     cross-summed; null when the series share no common complete bucket.
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
 * Map of `endMs → value` for each COMPLETE ~60-second bucket in one series. A
 * point qualifies only when it has a ~60s interval (50–70s tolerance) whose
 * endTime is at/earlier than `now` (i.e. not still forming). A still-forming or
 * non-60s point is omitted — never coerced to zero.
 */
function completeBucketMap(points: RawPoint[] | undefined, nowMs: number): Map<number, number> {
  const map = new Map<number, number>();
  if (!Array.isArray(points)) return map;
  for (const p of points) {
    const val = numericPoint(p);
    if (val === null) continue;
    const startMs = parseMs(p.interval?.startTime);
    const endMs = parseMs(p.interval?.endTime);
    if (startMs === null || endMs === null) continue;
    const dur = endMs - startMs;
    if (dur < 50_000 || dur > 70_000) continue; // ~60s bucket only
    if (endMs > nowMs) continue; // still forming → not complete
    map.set(endMs, val);
  }
  return map;
}

/**
 * Value of the newest COMPLETE 60-second bucket in a SINGLE series (or null when
 * none qualifies). Retained as a focused, directly-tested helper; the dimension
 * aggregation uses the synchronized total below so multiple series never mix
 * different minutes.
 */
export function newestCompleteMinutePoint(points: RawPoint[] | undefined, nowMs: number): number | null {
  const map = completeBucketMap(points, nowMs);
  if (map.size === 0) return null;
  return map.get(Math.max(...map.keys())) ?? null;
}

/**
 * Synchronized minute total across the series contributing to ONE dimension: sum
 * values only from the newest bucket-end timestamp that EVERY contributing
 * series reports a complete bucket for. Returns null when the series share no
 * common complete bucket — so a 12:03–12:04 value is never added to a 12:04–12:05
 * value, and an absent/forming series is never treated as zero. A single
 * contributing series reduces to its own newest complete bucket.
 */
function synchronizedMinuteTotal(seriesBuckets: Array<Map<number, number>>): number | null {
  if (seriesBuckets.length === 0) return null;
  let common: Set<number> | null = null;
  for (const m of seriesBuckets) {
    if (m.size === 0) return null; // a contributing series with no complete bucket
    if (common === null) {
      common = new Set(m.keys());
    } else {
      for (const k of [...common]) if (!m.has(k)) common.delete(k);
    }
    if (common.size === 0) return null; // no shared bucket → cannot synchronize
  }
  if (!common || common.size === 0) return null;
  const newest = Math.max(...common);
  let total = 0;
  for (const m of seriesBuckets) total += m.get(newest)!;
  return total;
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
  limit: number | null;
  // Daily "sum" mode: running totals across all contributing series.
  usedSum: number | null;
  exceededSum: number | null;
  // Minute "newest-minute" mode: one complete-bucket map per contributing series,
  // synchronized to a common bucket at finalization (never cross-summed).
  usageSeries: Array<Map<number, number>>;
  exceededSeries: Array<Map<number, number>>;
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
        limit: null,
        usedSum: null,
        exceededSum: null,
        usageSeries: [],
        exceededSeries: [],
      };
      dims.set(key, dim);
    }
    if (method) dim.methods.add(method);

    if (parsed.measure === "limit") {
      const v = latestPoint(ts.points);
      if (v !== null) dim.limit = dim.limit === null ? v : Math.max(dim.limit, v);
    } else if (config.usageMode === "newest-minute") {
      // Defer aggregation: keep each series' complete buckets so usage/exceeded
      // combine only across a shared bucket (never a cross-minute sum).
      const buckets = completeBucketMap(ts.points, config.nowMs ?? Number.MAX_SAFE_INTEGER);
      if (parsed.measure === "usage") dim.usageSeries.push(buckets);
      else dim.exceededSeries.push(buckets);
    } else if (parsed.measure === "usage") {
      dim.usedSum = addValue(dim.usedSum, sumPoints(ts.points));
    } else {
      dim.exceededSum = addValue(dim.exceededSum, sumPoints(ts.points));
    }
  }

  const dimensions: GeminiQuotaDimension[] = [...dims.values()]
    .map((d) => {
      const used =
        config.usageMode === "newest-minute" ? synchronizedMinuteTotal(d.usageSeries) : d.usedSum;
      const exceeded =
        config.usageMode === "newest-minute"
          ? synchronizedMinuteTotal(d.exceededSeries)
          : d.exceededSum;
      return {
        category: d.category,
        model: d.model,
        limitName: d.limitName,
        // One contributing method → show it; zero or several → null (aggregated),
        // never one arbitrary method as though it represented the whole aggregate.
        method: d.methods.size === 1 ? [...d.methods][0] : null,
        window: d.window,
        used,
        limit: d.limit,
        remaining: computeRemaining(d.limit, used, d.window),
        exceededAttempts: exceeded,
      };
    })
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

/**
 * Aligners this plan may request. `ALIGN_SUM` totals DELTA counts within an
 * alignment period — correct for summing per-minute usage/exceeded. `ALIGN_NEXT_OLDER`
 * is the only GAUGE-safe aligner we'd consider for a limit. `ALIGN_DELTA` is
 * deliberately NOT offered: it computes differences between samples and is wrong
 * for totalling a count inside a minute bucket.
 */
export type MonitoringAligner = "ALIGN_SUM" | "ALIGN_NEXT_OLDER";

export interface TimeSeriesRequest {
  metricType: string;
  startTimeIso: string;
  endTimeIso: string;
  pageToken?: string;
  /** Alignment period (seconds). Only meaningful together with perSeriesAligner. */
  alignmentPeriodSeconds?: number;
  /** Explicit aligner chosen by the request plan (never defaulted to ALIGN_DELTA). */
  perSeriesAligner?: MonitoringAligner;
}

// A large, valid page size so a single metric/window rarely needs pagination
// (Monitoring caps the effective size at 100,000).
const TIME_SERIES_PAGE_SIZE = 10_000;

/**
 * The EXACT Monitoring `timeSeries.list` query parameters for one request. Pure,
 * so Vitest asserts precisely which filter + interval + aggregation reach Google.
 * The aligner is serialized verbatim from the request plan — this builder never
 * injects ALIGN_DELTA (or any aligner the plan did not choose), and it omits the
 * aggregation parameters entirely for an unaligned (daily / GAUGE-limit) request.
 */
export function buildTimeSeriesQueryParams(req: TimeSeriesRequest): Record<string, string> {
  const params: Record<string, string> = {
    filter: buildTimeSeriesFilter(req.metricType),
    "interval.startTime": req.startTimeIso,
    "interval.endTime": req.endTimeIso,
    view: "FULL",
    pageSize: String(TIME_SERIES_PAGE_SIZE),
  };
  if (req.alignmentPeriodSeconds && req.perSeriesAligner) {
    params["aggregation.alignmentPeriod"] = `${req.alignmentPeriodSeconds}s`;
    params["aggregation.perSeriesAligner"] = req.perSeriesAligner;
  }
  if (req.pageToken) params.pageToken = req.pageToken;
  return params;
}

/** One page of a Monitoring timeSeries.list response. */
export interface TimeSeriesPage {
  timeSeries: RawTimeSeries[];
  nextPageToken: string | null;
}

/** Injected fetcher — the Deno function supplies the real HTTP implementation. */
export type TimeSeriesFetcher = (req: TimeSeriesRequest) => Promise<TimeSeriesPage>;

const MAX_PAGES = 20;

/**
 * Follow nextPageToken until exhausted and concatenate all series. Bounded to
 * MAX_PAGES for safety; if a nextPageToken STILL remains at that bound we THROW
 * rather than return truncated data as though complete — the collector converts
 * that into the safe `unavailable` result. Never exposes the token or raw body.
 */
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
    if (!next) return all;
    pageToken = next;
  }
  // Bound reached with a token still pending: presenting `all` would be partial
  // data masquerading as complete. Fail so the outer collector goes unavailable.
  throw new Error("monitoring_pagination_overflow");
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
 * daily pass (sum) and the minute pass (synchronized newest 60s bucket) and merge.
 * DELTA usage/exceeded in the minute pass are requested with 60s ALIGN_SUM (never
 * ALIGN_DELTA); GAUGE limit series are fetched unaligned (aligning a gauge as
 * DELTA/SUM is invalid — its newest point is selected instead). Any failure —
 * including pagination overflow — yields the bounded unavailable result, so
 * partial data is never presented as complete and no raw Google body leaks.
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
        metricTypes.map((metricType) => {
          const isLimit = metricType.endsWith("/limit");
          return fetchAllPagesForMetric(fetcher, {
            metricType,
            startTimeIso: opts.minuteStartIso,
            endTimeIso: opts.endIso,
            // DELTA usage/exceeded: total within each 60s bucket (ALIGN_SUM, never
            // ALIGN_DELTA). GAUGE limit: unaligned — its newest point is selected.
            ...(isLimit
              ? {}
              : { alignmentPeriodSeconds: 60, perSeriesAligner: "ALIGN_SUM" as const }),
          });
        }),
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
