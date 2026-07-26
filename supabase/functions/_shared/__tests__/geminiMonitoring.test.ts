import { describe, it, expect, vi } from "vitest";
import {
  normalizeMonitoringTimeSeries,
  mergeWindowedProviderQuota,
  newestCompleteMinutePoint,
  computeRemaining,
  inferWindow,
  unavailableProviderQuota,
  buildMetricTypes,
  buildTimeSeriesFilter,
  buildTimeSeriesQueryParams,
  fetchAllPagesForMetric,
  collectProviderQuota,
  classifyFetchFailure,
  normalizeCollectionFailure,
  parseTimeSeriesPage,
  MonitoringCollectionError,
  type RawTimeSeries,
  type RawPoint,
  type TimeSeriesFetcher,
  type TimeSeriesPage,
  type TimeSeriesRequest,
  type ProviderQuotaFailure,
} from "../geminiMonitoring.ts";

const BASE = "generativelanguage.googleapis.com/quota";
const REQ = `${BASE}/generate_content_free_tier_requests`;
const TOK = `${BASE}/generate_content_free_tier_input_token_count`;

const OPTS = { configuredModel: "gemini-flash-latest", collectedAt: "2026-07-25T12:00:00Z", metricsMayLagSeconds: 240 };
const NOW_MS = Date.UTC(2026, 6, 25, 12, 0, 0);

function pt(v: number): RawPoint {
  return { value: { int64Value: String(v) } };
}
/** A point covering the 60s bucket [NOW-startSecAgo, NOW-endSecAgo]. */
function mpt(v: number, startSecAgo: number, endSecAgo: number): RawPoint {
  return {
    value: { int64Value: String(v) },
    interval: {
      startTime: new Date(NOW_MS - startSecAgo * 1000).toISOString(),
      endTime: new Date(NOW_MS - endSecAgo * 1000).toISOString(),
    },
  };
}
function series(type: string, labels: Record<string, string>, points: RawPoint[]): RawTimeSeries {
  return { metric: { type, labels }, points };
}

describe("normalizeMonitoringTimeSeries — daily (sum) mode", () => {
  it("joins usage + limit for the same (category, model, limit_name) and sums daily usage", () => {
    const model = "gemini-flash-latest";
    const limitName = "GenerateContentRequestsPerDayPerProjectPerModel-FreeTier";
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model, limit_name: limitName }, [pt(200)]),
        series(`${REQ}/usage`, { model, limit_name: limitName }, [pt(20), pt(30)]),
        series(`${REQ}/exceeded`, { model, limit_name: limitName }, [pt(1), pt(2)]),
      ],
      OPTS,
    );
    expect(res.status).toBe("ok");
    const d = res.dimensions[0];
    expect(d).toMatchObject({ category: "requests", window: "day", used: 50, limit: 200, remaining: 150, exceededAttempts: 3 });
  });

  it("does NOT fabricate usage or remaining when the usage metric is absent", () => {
    const res = normalizeMonitoringTimeSeries([series(`${REQ}/limit`, { model: "m", limit_name: "XPerDayY" }, [pt(100)])], OPTS);
    const d = res.dimensions[0];
    expect(d.limit).toBe(100);
    expect(d.used).toBeNull();
    expect(d.remaining).toBeNull();
    expect(d.exceededAttempts).toBeNull();
  });

  it("returns remaining null for an unknown/unsupported limit_name window", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model: "m", limit_name: "MysteryLimit" }, [pt(100)]),
        series(`${REQ}/usage`, { model: "m", limit_name: "MysteryLimit" }, [pt(10)]),
      ],
      OPTS,
    );
    const d = res.dimensions[0];
    expect(d.window).toBe("unknown");
    expect(d.remaining).toBeNull();
  });

  it("joins ONLY on matching labels — different models stay separate", () => {
    const limitName = "GenerateContentRequestsPerDayPerProjectPerModel-FreeTier";
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/usage`, { model: "model-a", limit_name: limitName }, [pt(5)]),
        series(`${REQ}/limit`, { model: "model-b", limit_name: limitName }, [pt(200)]),
      ],
      OPTS,
    );
    expect(res.dimensions).toHaveLength(2);
    expect(res.dimensions.find((d) => d.model === "model-a")!.remaining).toBeNull();
    expect(res.dimensions.find((d) => d.model === "model-b")!.used).toBeNull();
    expect(res.observedModels).toEqual(["model-a", "model-b"]);
  });

  it("ignores *_internal metrics", () => {
    const res = normalizeMonitoringTimeSeries(
      [series(`${BASE}/generate_content_free_tier_requests_internal/usage`, { model: "m", limit_name: "XPerDay" }, [pt(99)])],
      OPTS,
    );
    expect(res.status).toBe("unavailable");
    expect(res.dimensions).toHaveLength(0);
  });

  it("reports unavailable (with a message) for empty or missing input", () => {
    for (const input of [[], undefined, null]) {
      const res = normalizeMonitoringTimeSeries(input as RawTimeSeries[], OPTS);
      expect(res.status).toBe("unavailable");
      expect(res.providerTier).toBe("unknown");
      expect(typeof res.message).toBe("string");
    }
  });
});

describe("normalizeMonitoringTimeSeries — minute mode (newest complete 60s bucket)", () => {
  const model = "m";
  const limitName = "GenerateContentRequestsPerMinutePerProjectPerModel-FreeTier";
  const tokLimit = "GenerateContentInputTokensPerMinutePerProjectPerModel-FreeTier";
  const minuteCfg = { usageMode: "newest-minute" as const, nowMs: NOW_MS };

  it("uses ONLY the newest complete minute bucket (never a multi-minute sum)", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model, limit_name: limitName }, [pt(15)]),
        series(`${REQ}/usage`, { model, limit_name: limitName }, [mpt(5, 180, 120), mpt(8, 120, 60)]),
      ],
      OPTS,
      minuteCfg,
    );
    const d = res.dimensions[0];
    expect(d.window).toBe("minute");
    expect(d.used).toBe(8); // newest complete bucket, NOT 13
    expect(d.remaining).toBe(7);
  });

  it("excludes a still-forming (delayed) newest point and uses the newest complete one", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model, limit_name: limitName }, [pt(15)]),
        series(`${REQ}/usage`, { model, limit_name: limitName }, [mpt(8, 120, 60), mpt(99, 0, -60)]),
      ],
      OPTS,
      minuteCfg,
    );
    // mpt(99, 0, -60) => [NOW, NOW+60], endTime in the future → not complete.
    expect(res.dimensions[0].used).toBe(8);
  });

  it("yields null usage when there is no complete 60s bucket", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model, limit_name: limitName }, [pt(15)]),
        series(`${REQ}/usage`, { model, limit_name: limitName }, [mpt(99, 0, -60), pt(7)]),
      ],
      OPTS,
      minuteCfg,
    );
    // forming bucket excluded; pt(7) has no interval → not a complete bucket.
    expect(res.dimensions[0].used).toBeNull();
    expect(res.dimensions[0].remaining).toBeNull();
  });

  it("usage without a matching limit → remaining null", () => {
    const res = normalizeMonitoringTimeSeries(
      [series(`${REQ}/usage`, { model, limit_name: limitName }, [mpt(4, 120, 60)])],
      OPTS,
      minuteCfg,
    );
    const d = res.dimensions[0];
    expect(d.used).toBe(4);
    expect(d.limit).toBeNull();
    expect(d.remaining).toBeNull();
  });

  it("limit without usage → used null", () => {
    const res = normalizeMonitoringTimeSeries(
      [series(`${REQ}/limit`, { model, limit_name: limitName }, [pt(15)])],
      OPTS,
      minuteCfg,
    );
    expect(res.dimensions[0].used).toBeNull();
    expect(res.dimensions[0].limit).toBe(15);
  });

  it("keeps multiple models and multiple limit_names as distinct dimensions", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/usage`, { model: "model-a", limit_name: limitName }, [mpt(2, 120, 60)]),
        series(`${TOK}/usage`, { model: "model-b", limit_name: tokLimit }, [mpt(1000, 120, 60)]),
      ],
      OPTS,
      minuteCfg,
    );
    expect(res.dimensions).toHaveLength(2);
    expect(res.observedModels).toEqual(["model-a", "model-b"]);
    expect(res.dimensions.map((d) => d.category).sort()).toEqual(["input_tokens", "requests"]);
  });
});

describe("minute mode — synchronized bucket aggregation across contributing series", () => {
  const model = "m";
  const limitName = "GenerateContentRequestsPerMinutePerProjectPerModel-FreeTier";
  const minuteCfg = { usageMode: "newest-minute" as const, nowMs: NOW_MS };

  it("sums two methods that share the same latest complete bucket", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/usage`, { model, limit_name: limitName, method: "GenerateContent" }, [mpt(3, 120, 60)]),
        series(`${REQ}/usage`, { model, limit_name: limitName, method: "StreamGenerateContent" }, [mpt(5, 120, 60)]),
      ],
      OPTS,
      minuteCfg,
    );
    expect(res.dimensions).toHaveLength(1);
    expect(res.dimensions[0].used).toBe(8); // both at bucket ending NOW-60
    expect(res.dimensions[0].method).toBeNull(); // aggregated across methods
  });

  it("does NOT cross-sum methods whose newest points end in different minutes", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/usage`, { model, limit_name: limitName, method: "A" }, [mpt(3, 120, 60)]), // ends NOW-60
        series(`${REQ}/usage`, { model, limit_name: limitName, method: "B" }, [mpt(5, 180, 120)]), // ends NOW-120
      ],
      OPTS,
      minuteCfg,
    );
    // No common bucket end → cannot synchronize → null (never 8 from mixed minutes).
    expect(res.dimensions[0].used).toBeNull();
    expect(res.dimensions[0].remaining).toBeNull();
  });

  it("uses the newest COMMON older bucket when the freshest bucket is not shared", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        // A has both NOW-120 and NOW-60; B only has NOW-120.
        series(`${REQ}/usage`, { model, limit_name: limitName, method: "A" }, [mpt(3, 180, 120), mpt(4, 120, 60)]),
        series(`${REQ}/usage`, { model, limit_name: limitName, method: "B" }, [mpt(5, 180, 120)]),
      ],
      OPTS,
      minuteCfg,
    );
    // Newest bucket present in BOTH is NOW-120 → 3 + 5 (never A's fresher 4).
    expect(res.dimensions[0].used).toBe(8);
  });

  it("returns null when a contributing series has no complete bucket at all", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/usage`, { model, limit_name: limitName, method: "A" }, [mpt(4, 120, 60)]), // complete
        series(`${REQ}/usage`, { model, limit_name: limitName, method: "B" }, [mpt(9, 0, -60)]), // still forming
      ],
      OPTS,
      minuteCfg,
    );
    expect(res.dimensions[0].used).toBeNull(); // B absent for every complete bucket
  });

  it("applies the same synchronized rule to exceeded attempts", () => {
    const shared = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/exceeded`, { model, limit_name: limitName, method: "A" }, [mpt(1, 120, 60)]),
        series(`${REQ}/exceeded`, { model, limit_name: limitName, method: "B" }, [mpt(2, 120, 60)]),
      ],
      OPTS,
      minuteCfg,
    );
    expect(shared.dimensions[0].exceededAttempts).toBe(3); // shared bucket → summed

    const mixed = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/exceeded`, { model, limit_name: limitName, method: "A" }, [mpt(1, 120, 60)]),
        series(`${REQ}/exceeded`, { model, limit_name: limitName, method: "B" }, [mpt(2, 180, 120)]),
      ],
      OPTS,
      minuteCfg,
    );
    expect(mixed.dimensions[0].exceededAttempts).toBeNull(); // different minutes → null
  });

  it("a single contributing series still reduces to its own newest complete bucket", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model, limit_name: limitName }, [pt(15)]),
        series(`${REQ}/usage`, { model, limit_name: limitName, method: "A" }, [mpt(5, 180, 120), mpt(8, 120, 60)]),
      ],
      OPTS,
      minuteCfg,
    );
    expect(res.dimensions[0].used).toBe(8);
    expect(res.dimensions[0].remaining).toBe(7);
  });
});

describe("newestCompleteMinutePoint", () => {
  it("returns the value of the newest complete 60s bucket", () => {
    expect(newestCompleteMinutePoint([mpt(5, 180, 120), mpt(8, 120, 60)], NOW_MS)).toBe(8);
  });
  it("returns null when no bucket qualifies", () => {
    expect(newestCompleteMinutePoint([pt(7)], NOW_MS)).toBeNull(); // no interval
    expect(newestCompleteMinutePoint([mpt(9, 0, -60)], NOW_MS)).toBeNull(); // future/forming
    expect(newestCompleteMinutePoint([mpt(9, 300, 60)], NOW_MS)).toBeNull(); // 240s bucket, not 60s
    expect(newestCompleteMinutePoint(undefined, NOW_MS)).toBeNull();
  });
});

describe("method aggregation", () => {
  const limitName = "XPerDay";
  it("preserves a single contributing method", () => {
    const res = normalizeMonitoringTimeSeries(
      [series(`${REQ}/usage`, { model: "m", limit_name: limitName, method: "GenerateContent" }, [pt(1)])],
      OPTS,
    );
    expect(res.dimensions[0].method).toBe("GenerateContent");
  });
  it("sets method to null when several methods aggregate into one dimension", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/usage`, { model: "m", limit_name: limitName, method: "GenerateContent" }, [pt(1)]),
        series(`${REQ}/usage`, { model: "m", limit_name: limitName, method: "StreamGenerateContent" }, [pt(2)]),
      ],
      OPTS,
    );
    expect(res.dimensions).toHaveLength(1);
    expect(res.dimensions[0].method).toBeNull(); // never one arbitrary method
  });
});

describe("mergeWindowedProviderQuota", () => {
  const model = "gemini-flash-latest";
  const dayLimit = "GenerateContentRequestsPerDayPerProjectPerModel-FreeTier";
  const minLimit = "GenerateContentRequestsPerMinutePerProjectPerModel-FreeTier";

  it("returns day + minute dimensions together, each from its correct pass", () => {
    const daily = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model, limit_name: dayLimit }, [pt(200)]),
        series(`${REQ}/usage`, { model, limit_name: dayLimit }, [pt(120)]),
        // A minute series over-summed in the daily pass must be dropped by merge.
        series(`${REQ}/usage`, { model, limit_name: minLimit }, [pt(999)]),
      ],
      OPTS,
      { usageMode: "sum" },
    );
    const minute = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model, limit_name: minLimit }, [pt(15)]),
        series(`${REQ}/usage`, { model, limit_name: minLimit }, [mpt(4, 120, 60)]),
      ],
      OPTS,
      { usageMode: "newest-minute", nowMs: NOW_MS },
    );
    const merged = mergeWindowedProviderQuota(daily, minute);
    expect(merged.dimensions.find((d) => d.window === "day")!.used).toBe(120);
    expect(merged.dimensions.find((d) => d.window === "minute")!.used).toBe(4); // not 999
    expect(merged.status).toBe("ok");
  });
});

describe("computeRemaining / inferWindow", () => {
  it("computeRemaining requires used, limit, and a reliable window; floors at 0", () => {
    expect(computeRemaining(100, 30, "day")).toBe(70);
    expect(computeRemaining(100, 130, "minute")).toBe(0);
    expect(computeRemaining(null, 5, "day")).toBeNull();
    expect(computeRemaining(100, null, "day")).toBeNull();
    expect(computeRemaining(100, 5, "unknown")).toBeNull();
  });
  it("inferWindow reads Per(Minute|Day) case-insensitively, else unknown", () => {
    expect(inferWindow("FooPerMinuteBar")).toBe("minute");
    expect(inferWindow("foo_per_day_bar")).toBe("day");
    expect(inferWindow("Whatever")).toBe("unknown");
  });
});

describe("request plan — one metric type per request", () => {
  it("buildMetricTypes returns exactly the six supported metric types", () => {
    const types = buildMetricTypes();
    expect(types).toEqual([
      `${REQ}/limit`, `${REQ}/usage`, `${REQ}/exceeded`,
      `${TOK}/limit`, `${TOK}/usage`, `${TOK}/exceeded`,
    ]);
  });

  it("buildTimeSeriesFilter selects exactly one metric.type and never ORs types", () => {
    for (const t of buildMetricTypes()) {
      const f = buildTimeSeriesFilter(t);
      expect(f).toBe(`metric.type = "${t}"`);
      expect((f.match(/metric\.type/g) || []).length).toBe(1);
      expect(f).not.toContain(" OR metric.type");
    }
  });

  it("fetchAllPagesForMetric follows nextPageToken and concatenates pages", async () => {
    const fetcher: TimeSeriesFetcher = vi.fn(async (req): Promise<TimeSeriesPage> => {
      if (!req.pageToken) return { timeSeries: [series(`${REQ}/usage`, { model: "m", limit_name: "XPerDay" }, [pt(1)])], nextPageToken: "p2" };
      return { timeSeries: [series(`${REQ}/usage`, { model: "m2", limit_name: "XPerDay" }, [pt(2)])], nextPageToken: null };
    });
    const all = await fetchAllPagesForMetric(fetcher, { metricType: `${REQ}/usage`, startTimeIso: "s", endTimeIso: "e" });
    expect(all).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("collectProviderQuota requests all six metric types per window, single-metric each, and combines results", async () => {
    const requested: string[] = [];
    const fetcher: TimeSeriesFetcher = async (req): Promise<TimeSeriesPage> => {
      requested.push(req.metricType);
      const model = "gemini-flash-latest";
      if (req.metricType === `${REQ}/limit`) {
        return { timeSeries: [series(`${REQ}/limit`, { model, limit_name: "ReqPerDay" }, [pt(200)])], nextPageToken: null };
      }
      if (req.metricType === `${REQ}/usage`) {
        return { timeSeries: [series(`${REQ}/usage`, { model, limit_name: "ReqPerDay" }, [pt(50)])], nextPageToken: null };
      }
      return { timeSeries: [], nextPageToken: null };
    };
    const res = await collectProviderQuota(fetcher, {
      configuredModel: "gemini-flash-latest",
      collectedAtIso: OPTS.collectedAt,
      nowMs: NOW_MS,
      dayStartIso: new Date(NOW_MS - 3600_000).toISOString(),
      minuteStartIso: new Date(NOW_MS - 300_000).toISOString(),
      endIso: OPTS.collectedAt,
      metricsMayLagSeconds: 240,
    });
    // Six metric types, requested for BOTH windows (12 requests total).
    const uniq = [...new Set(requested)].sort();
    expect(uniq).toEqual(buildMetricTypes().slice().sort());
    expect(requested).toHaveLength(12);
    // Day dimension combined from independent limit + usage requests.
    const day = res.dimensions.find((d) => d.window === "day")!;
    expect(day.used).toBe(50);
    expect(day.limit).toBe(200);
    expect(day.remaining).toBe(150);
  });

  it("collectProviderQuota returns a bounded unavailable result on an HTTP failure (no raw body)", async () => {
    const fetcher: TimeSeriesFetcher = async () => {
      throw new Error("monitoring_error status=403"); // bounded; NOT a raw Google body
    };
    const res = await collectProviderQuota(fetcher, {
      configuredModel: "gemini-flash-latest",
      collectedAtIso: OPTS.collectedAt,
      nowMs: NOW_MS,
      dayStartIso: "s",
      minuteStartIso: "s",
      endIso: "e",
      metricsMayLagSeconds: 240,
      unavailableMessage: "Gemini provider quota is temporarily unavailable.",
    });
    expect(res.status).toBe("unavailable");
    expect(res.dimensions).toEqual([]);
    expect(res.message).toBe("Gemini provider quota is temporarily unavailable.");
    expect(JSON.stringify(res)).not.toMatch(/status=403|google|monitoring_error/i);
  });
});

describe("buildTimeSeriesQueryParams — exact query parameters", () => {
  it("serializes 60s ALIGN_SUM aggregation when the plan chose it", () => {
    const p = buildTimeSeriesQueryParams({
      metricType: `${REQ}/usage`,
      startTimeIso: "2026-07-25T11:55:00Z",
      endTimeIso: "2026-07-25T12:00:00Z",
      alignmentPeriodSeconds: 60,
      perSeriesAligner: "ALIGN_SUM",
    });
    expect(p.filter).toBe(`metric.type = "${REQ}/usage"`);
    expect(p["interval.startTime"]).toBe("2026-07-25T11:55:00Z");
    expect(p["interval.endTime"]).toBe("2026-07-25T12:00:00Z");
    expect(p["aggregation.perSeriesAligner"]).toBe("ALIGN_SUM");
    expect(p["aggregation.alignmentPeriod"]).toBe("60s");
  });

  it("omits aggregation entirely for an unaligned request (daily / GAUGE limit)", () => {
    const p = buildTimeSeriesQueryParams({
      metricType: `${REQ}/limit`,
      startTimeIso: "s",
      endTimeIso: "e",
    });
    expect(p["aggregation.perSeriesAligner"]).toBeUndefined();
    expect(p["aggregation.alignmentPeriod"]).toBeUndefined();
  });

  it("never serializes ALIGN_DELTA", () => {
    const p = buildTimeSeriesQueryParams({
      metricType: `${REQ}/usage`,
      startTimeIso: "s",
      endTimeIso: "e",
      alignmentPeriodSeconds: 60,
      perSeriesAligner: "ALIGN_SUM",
    });
    expect(Object.values(p)).not.toContain("ALIGN_DELTA");
  });

  it("includes a bounded positive pageSize and threads a pageToken when present", () => {
    const p = buildTimeSeriesQueryParams({
      metricType: `${REQ}/usage`,
      startTimeIso: "s",
      endTimeIso: "e",
      pageToken: "tok-2",
    });
    expect(Number(p.pageSize)).toBeGreaterThan(0);
    expect(p.pageToken).toBe("tok-2");
  });
});

describe("collectProviderQuota — aligner per window/metric", () => {
  const dayStartIso = new Date(NOW_MS - 3600_000).toISOString();
  const minuteStartIso = new Date(NOW_MS - 300_000).toISOString();

  async function captureRequests(): Promise<TimeSeriesRequest[]> {
    const seen: TimeSeriesRequest[] = [];
    const fetcher: TimeSeriesFetcher = async (req): Promise<TimeSeriesPage> => {
      seen.push(req);
      return { timeSeries: [], nextPageToken: null };
    };
    await collectProviderQuota(fetcher, {
      configuredModel: "gemini-flash-latest",
      collectedAtIso: OPTS.collectedAt,
      nowMs: NOW_MS,
      dayStartIso,
      minuteStartIso,
      endIso: OPTS.collectedAt,
      metricsMayLagSeconds: 240,
    });
    return seen;
  }

  it("uses 60s ALIGN_SUM for minute usage/exceeded, and no alignment for minute limits", async () => {
    const seen = await captureRequests();
    const minuteReqs = seen.filter((r) => r.startTimeIso === minuteStartIso);
    expect(minuteReqs).toHaveLength(6);
    for (const r of minuteReqs) {
      if (r.metricType.endsWith("/limit")) {
        expect(r.perSeriesAligner).toBeUndefined();
        expect(r.alignmentPeriodSeconds).toBeUndefined();
      } else {
        expect(r.perSeriesAligner).toBe("ALIGN_SUM");
        expect(r.alignmentPeriodSeconds).toBe(60);
      }
    }
  });

  it("leaves ALL daily requests unaligned (raw DELTA sum)", async () => {
    const seen = await captureRequests();
    const dayReqs = seen.filter((r) => r.startTimeIso === dayStartIso);
    expect(dayReqs).toHaveLength(6);
    for (const r of dayReqs) {
      expect(r.perSeriesAligner).toBeUndefined();
      expect(r.alignmentPeriodSeconds).toBeUndefined();
    }
  });

  it("never requests ALIGN_DELTA anywhere and still queries the six types per window", async () => {
    const seen = await captureRequests();
    // Nothing anywhere uses ALIGN_DELTA (the type doesn't even permit it).
    for (const r of seen) expect(r.perSeriesAligner).not.toBe("ALIGN_DELTA");
    // Six metric types, each independent, in both windows.
    expect(seen).toHaveLength(12);
    expect([...new Set(seen.map((r) => r.metricType))].sort()).toEqual(buildMetricTypes().slice().sort());
  });
});

describe("fetchAllPagesForMetric — pagination integrity", () => {
  const base = { metricType: `${REQ}/usage`, startTimeIso: "s", endTimeIso: "e" };
  const page = (v: number, token: string | null): TimeSeriesPage => ({
    timeSeries: [series(`${REQ}/usage`, { model: "m", limit_name: "XPerDay" }, [pt(v)])],
    nextPageToken: token,
  });

  it("completes normally on a single page", async () => {
    const fetcher: TimeSeriesFetcher = async () => page(1, null);
    expect(await fetchAllPagesForMetric(fetcher, base)).toHaveLength(1);
  });

  it("completes normally across multiple pages", async () => {
    let calls = 0;
    const fetcher: TimeSeriesFetcher = async () => {
      calls++;
      return page(calls, calls < 3 ? `p${calls}` : null);
    };
    expect(await fetchAllPagesForMetric(fetcher, base)).toHaveLength(3);
  });

  it("THROWS (→ unavailable upstream) when a nextPageToken remains at the page bound", async () => {
    // Always returns a token → never terminates within MAX_PAGES.
    const fetcher: TimeSeriesFetcher = async () => page(1, "always-more");
    await expect(fetchAllPagesForMetric(fetcher, base)).rejects.toThrow();
  });

  it("collectProviderQuota converts a pagination overflow into a bounded unavailable result", async () => {
    const fetcher: TimeSeriesFetcher = async () => ({
      timeSeries: [series(`${REQ}/usage`, { model: "m", limit_name: "ReqPerDay" }, [pt(1)])],
      nextPageToken: "more", // never terminates
    });
    const res = await collectProviderQuota(fetcher, {
      configuredModel: "gemini-flash-latest",
      collectedAtIso: OPTS.collectedAt,
      nowMs: NOW_MS,
      dayStartIso: "s",
      minuteStartIso: "s",
      endIso: "e",
      metricsMayLagSeconds: 240,
      unavailableMessage: "Gemini provider quota is temporarily unavailable.",
    });
    expect(res.status).toBe("unavailable");
    expect(res.dimensions).toEqual([]);
  });
});

describe("unavailableProviderQuota", () => {
  it("builds a soft-unavailable response carrying the reason", () => {
    const res = unavailableProviderQuota("gemini-flash-latest", "2026-07-25T12:00:00Z", "credentials not configured");
    expect(res.status).toBe("unavailable");
    expect(res.dimensions).toEqual([]);
    expect(res.message).toBe("credentials not configured");
    expect(res.sharedScope).toBe(true);
  });
});

// ── Bounded collection-failure diagnostics (Part C) ─────────────────────
// Sensitive-looking material a failure/response must NEVER carry.
const SENSITIVE_STRINGS = [
  "-----BEGIN PRIVATE KEY-----",
  "Bearer abc",
  "access_token",
  "client_email",
  "nextPageToken-secret-value",
  "raw-google-body",
  "gen-lang-client-0227754673",
] as const;
const SENSITIVE_BLOB = SENSITIVE_STRINGS.join(" ");

function assertNoSensitive(serialized: string) {
  for (const s of SENSITIVE_STRINGS) expect(serialized).not.toContain(s);
}

const COLLECT_OPTS = {
  configuredModel: "gemini-flash-latest",
  collectedAtIso: OPTS.collectedAt,
  nowMs: NOW_MS,
  dayStartIso: "s",
  minuteStartIso: "s",
  endIso: "e",
  metricsMayLagSeconds: 240,
  unavailableMessage: "Gemini provider quota is temporarily unavailable.",
};

// The exact fail-soft client response the collector returns on ANY failure.
const EXPECTED_FAILSOFT = {
  status: "unavailable",
  configuredModel: "gemini-flash-latest",
  observedModels: [],
  providerTier: "unknown",
  sharedScope: true,
  collectedAt: OPTS.collectedAt,
  metricsMayLagSeconds: 0,
  dimensions: [],
  message: "Gemini provider quota is temporarily unavailable.",
};

describe("normalizeCollectionFailure — bounded taxonomy", () => {
  it("classifies a non-2xx Monitoring HTTP failure and preserves the exact numeric status", () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const f = normalizeCollectionFailure(new MonitoringCollectionError("monitoring_http", status));
      expect(f).toEqual({ code: "monitoring_http", status });
    }
  });

  it("omits status for monitoring_http when it is missing or out of the 100–599 integer range", () => {
    for (const bad of [undefined, 0, 99, 600, 700, 200.5, Number.NaN]) {
      const f = normalizeCollectionFailure(new MonitoringCollectionError("monitoring_http", bad as number | undefined));
      expect(f).toEqual({ code: "monitoring_http" });
      expect("status" in f).toBe(false);
    }
  });

  it("classifies timeouts structurally (TimeoutError / AbortError), never by message text", () => {
    expect(normalizeCollectionFailure(new DOMException("timed out", "TimeoutError"))).toEqual({ code: "monitoring_timeout" });
    const aborted = new Error("whatever"); aborted.name = "AbortError";
    expect(normalizeCollectionFailure(aborted)).toEqual({ code: "monitoring_timeout" });
    expect(classifyFetchFailure({ name: "TimeoutError" }).code).toBe("monitoring_timeout");
  });

  it("classifies a fetch network failure (TypeError) as monitoring_network", () => {
    expect(normalizeCollectionFailure(new TypeError("Failed to fetch"))).toEqual({ code: "monitoring_network" });
    expect(classifyFetchFailure(new TypeError("network down")).code).toBe("monitoring_network");
  });

  it("passes through typed pagination_overflow and invalid_monitoring_payload codes", () => {
    expect(normalizeCollectionFailure(new MonitoringCollectionError("pagination_overflow"))).toEqual({ code: "pagination_overflow" });
    expect(normalizeCollectionFailure(new MonitoringCollectionError("invalid_monitoring_payload"))).toEqual({ code: "invalid_monitoring_payload" });
  });

  it("maps any other thrown value to unknown", () => {
    expect(normalizeCollectionFailure(new Error("boom"))).toEqual({ code: "unknown" });
    expect(normalizeCollectionFailure("a string")).toEqual({ code: "unknown" });
    expect(normalizeCollectionFailure({ nope: true })).toEqual({ code: "unknown" });
    expect(normalizeCollectionFailure(null)).toEqual({ code: "unknown" });
  });

  it("never lets an arbitrary/sensitive exception message enter the bounded failure object", () => {
    const f = normalizeCollectionFailure(new Error(SENSITIVE_BLOB));
    expect(f).toEqual({ code: "unknown" });
    assertNoSensitive(JSON.stringify(f));
    // A sensitive-looking message must not be reinterpreted as a richer code.
    const httpish = new Error(`monitoring_error status=403 ${SENSITIVE_BLOB}`);
    expect(normalizeCollectionFailure(httpish)).toEqual({ code: "unknown" });
  });

  it("produces only the bounded keys {code[, status]}", () => {
    expect(Object.keys(normalizeCollectionFailure(new MonitoringCollectionError("monitoring_timeout"))).sort()).toEqual(["code"]);
    expect(Object.keys(normalizeCollectionFailure(new MonitoringCollectionError("monitoring_http", 500))).sort()).toEqual(["code", "status"]);
  });
});

describe("parseTimeSeriesPage — structural validation", () => {
  it("parses a valid page (timeSeries array + string nextPageToken)", () => {
    const page = parseTimeSeriesPage(JSON.stringify({
      timeSeries: [series(`${REQ}/usage`, { model: "m", limit_name: "XPerDay" }, [pt(1)])],
      nextPageToken: "tok",
    }));
    expect(page.timeSeries).toHaveLength(1);
    expect(page.nextPageToken).toBe("tok");
  });

  it("treats a missing timeSeries as [] and an absent/empty nextPageToken as null when the rest is valid", () => {
    expect(parseTimeSeriesPage(JSON.stringify({}))).toEqual({ timeSeries: [], nextPageToken: null });
    expect(parseTimeSeriesPage(JSON.stringify({ nextPageToken: "" }))).toEqual({ timeSeries: [], nextPageToken: null });
    expect(parseTimeSeriesPage(JSON.stringify({ timeSeries: [], nextPageToken: null }))).toEqual({ timeSeries: [], nextPageToken: null });
  });

  it("rejects invalid JSON as invalid_monitoring_payload", () => {
    expect(() => parseTimeSeriesPage("{not json")).toThrow(MonitoringCollectionError);
    try { parseTimeSeriesPage("{not json"); } catch (e) {
      expect((e as MonitoringCollectionError).code).toBe("invalid_monitoring_payload");
    }
  });

  it("rejects a non-object top level (array / number / string / null)", () => {
    for (const raw of ["[]", "3", '"x"', "null"]) {
      expect(() => parseTimeSeriesPage(raw)).toThrow(MonitoringCollectionError);
      try { parseTimeSeriesPage(raw); } catch (e) {
        expect((e as MonitoringCollectionError).code).toBe("invalid_monitoring_payload");
      }
    }
  });

  it("rejects a non-array timeSeries or non-string nextPageToken", () => {
    expect(() => parseTimeSeriesPage(JSON.stringify({ timeSeries: "nope" }))).toThrow(/invalid_monitoring_payload/);
    expect(() => parseTimeSeriesPage(JSON.stringify({ timeSeries: {} }))).toThrow(/invalid_monitoring_payload/);
    expect(() => parseTimeSeriesPage(JSON.stringify({ nextPageToken: 42 }))).toThrow(/invalid_monitoring_payload/);
    expect(() => parseTimeSeriesPage(JSON.stringify({ timeSeries: [], nextPageToken: {} }))).toThrow(/invalid_monitoring_payload/);
  });

  it("never retains the malformed payload in the thrown error", () => {
    try {
      parseTimeSeriesPage(JSON.stringify({ timeSeries: "nope", secret: SENSITIVE_BLOB }));
    } catch (e) {
      const err = e as MonitoringCollectionError;
      expect(err.code).toBe("invalid_monitoring_payload");
      assertNoSensitive(err.message);
      assertNoSensitive(JSON.stringify(normalizeCollectionFailure(err)));
    }
  });
});

describe("collectProviderQuota — bounded failure callback + preserved fail-soft response", () => {
  it("invokes the callback exactly once with {code:monitoring_http,status} on an HTTP failure and preserves the fail-soft response", async () => {
    const onFailure = vi.fn();
    const fetcher: TimeSeriesFetcher = async () => { throw new MonitoringCollectionError("monitoring_http", 403); };
    const res = await collectProviderQuota(fetcher, COLLECT_OPTS, onFailure);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({ code: "monitoring_http", status: 403 });
    expect(res).toEqual(EXPECTED_FAILSOFT);
  });

  it("passes the callback only bounded fields (keys ⊆ {code,status})", async () => {
    const seen: ProviderQuotaFailure[] = [];
    const fetcher: TimeSeriesFetcher = async () => { throw new MonitoringCollectionError("monitoring_http", 500); };
    await collectProviderQuota(fetcher, COLLECT_OPTS, (f) => seen.push(f));
    expect(seen).toHaveLength(1);
    for (const key of Object.keys(seen[0])) expect(["code", "status"]).toContain(key);
  });

  it("classifies timeout, network, pagination overflow, and invalid payload through the callback", async () => {
    const cases: Array<{ thrown: unknown; code: string }> = [
      { thrown: new DOMException("t", "TimeoutError"), code: "monitoring_timeout" },
      { thrown: new TypeError("Failed to fetch"), code: "monitoring_network" },
      { thrown: new MonitoringCollectionError("invalid_monitoring_payload"), code: "invalid_monitoring_payload" },
    ];
    for (const c of cases) {
      const onFailure = vi.fn();
      const fetcher: TimeSeriesFetcher = async () => { throw c.thrown; };
      const res = await collectProviderQuota(fetcher, COLLECT_OPTS, onFailure);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0][0].code).toBe(c.code);
      expect(res).toEqual(EXPECTED_FAILSOFT);
    }
  });

  it("reports pagination_overflow when a nextPageToken never terminates", async () => {
    const onFailure = vi.fn();
    const fetcher: TimeSeriesFetcher = async () => ({
      timeSeries: [series(`${REQ}/usage`, { model: "m", limit_name: "ReqPerDay" }, [pt(1)])],
      nextPageToken: "always-more",
    });
    const res = await collectProviderQuota(fetcher, COLLECT_OPTS, onFailure);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({ code: "pagination_overflow" });
    expect(res).toEqual(EXPECTED_FAILSOFT);
  });

  it("does NOT invoke the callback for a valid empty-metrics result", async () => {
    const onFailure = vi.fn();
    const fetcher: TimeSeriesFetcher = async () => ({ timeSeries: [], nextPageToken: null });
    const res = await collectProviderQuota(fetcher, COLLECT_OPTS, onFailure);
    expect(onFailure).not.toHaveBeenCalled();
    expect(res.status).toBe("unavailable");
    expect(res.message).toBe("No Gemini provider-quota metrics were returned.");
  });

  it("swallows a throwing callback and still returns the fail-soft response", async () => {
    const fetcher: TimeSeriesFetcher = async () => { throw new MonitoringCollectionError("monitoring_http", 503); };
    const res = await collectProviderQuota(fetcher, COLLECT_OPTS, () => { throw new Error("logger blew up"); });
    expect(res).toEqual(EXPECTED_FAILSOFT);
  });

  it("keeps arbitrary/sensitive exception text out of BOTH the failure object and the client response", async () => {
    let captured: ProviderQuotaFailure | undefined;
    const fetcher: TimeSeriesFetcher = async () => { throw new Error(SENSITIVE_BLOB); };
    const res = await collectProviderQuota(fetcher, COLLECT_OPTS, (f) => { captured = f; });
    expect(captured).toEqual({ code: "unknown" });
    assertNoSensitive(JSON.stringify(captured));
    assertNoSensitive(JSON.stringify(res));
    expect(res).toEqual(EXPECTED_FAILSOFT);
  });

  it("still returns the fail-soft response when no callback is supplied (no regression)", async () => {
    const fetcher: TimeSeriesFetcher = async () => { throw new MonitoringCollectionError("monitoring_http", 403); };
    const res = await collectProviderQuota(fetcher, COLLECT_OPTS);
    expect(res).toEqual(EXPECTED_FAILSOFT);
  });
});
