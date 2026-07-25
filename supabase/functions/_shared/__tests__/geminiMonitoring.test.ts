import { describe, it, expect } from "vitest";
import {
  normalizeMonitoringTimeSeries,
  mergeWindowedProviderQuota,
  computeRemaining,
  inferWindow,
  unavailableProviderQuota,
  type RawTimeSeries,
} from "../geminiMonitoring.ts";

const BASE = "generativelanguage.googleapis.com/quota";
const REQ = `${BASE}/generate_content_free_tier_requests`;
const TOK = `${BASE}/generate_content_free_tier_input_token_count`;

const OPTS = { configuredModel: "gemini-flash-latest", collectedAt: "2026-07-25T12:00:00Z", metricsMayLagSeconds: 240 };

function pt(v: number): { value: { int64Value: string } } {
  return { value: { int64Value: String(v) } };
}
function series(type: string, labels: Record<string, string>, points: RawTimeSeries["points"]): RawTimeSeries {
  return { metric: { type, labels }, points };
}

describe("normalizeMonitoringTimeSeries", () => {
  it("joins usage + limit for the same (category, model, limit_name) and computes remaining", () => {
    const model = "gemini-flash-latest";
    const limitName = "GenerateContentRequestsPerDayPerProjectPerModel-FreeTier";
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model, limit_name: limitName }, [pt(200)]),
        series(`${REQ}/usage`, { model, limit_name: limitName }, [pt(50)]),
        series(`${REQ}/exceeded`, { model, limit_name: limitName }, [pt(3)]),
      ],
      OPTS,
    );
    expect(res.status).toBe("ok");
    expect(res.providerTier).toBe("free");
    expect(res.sharedScope).toBe(true);
    expect(res.configuredModel).toBe("gemini-flash-latest");
    expect(res.metricsMayLagSeconds).toBe(240);
    expect(res.observedModels).toEqual([model]);
    expect(res.dimensions).toHaveLength(1);
    const d = res.dimensions[0];
    expect(d).toMatchObject({
      category: "requests",
      model,
      limitName,
      window: "day",
      used: 50,
      limit: 200,
      remaining: 150,
      exceededAttempts: 3,
    });
  });

  it("handles input-token minute limits", () => {
    const model = "gemini-flash-latest";
    const limitName = "GenerateContentInputTokensPerMinutePerProjectPerModel-FreeTier";
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${TOK}/limit`, { model, limit_name: limitName }, [pt(1000000)]),
        series(`${TOK}/usage`, { model, limit_name: limitName }, [pt(250000)]),
      ],
      OPTS,
    );
    const d = res.dimensions.find((x) => x.category === "input_tokens")!;
    expect(d.window).toBe("minute");
    expect(d.used).toBe(250000);
    expect(d.limit).toBe(1000000);
    expect(d.remaining).toBe(750000);
  });

  it("does NOT fabricate usage or remaining when the usage metric is absent", () => {
    const res = normalizeMonitoringTimeSeries(
      [series(`${REQ}/limit`, { model: "m", limit_name: "XPerDayY" }, [pt(100)])],
      OPTS,
    );
    const d = res.dimensions[0];
    expect(d.limit).toBe(100);
    expect(d.used).toBeNull(); // NOT 0
    expect(d.remaining).toBeNull(); // cannot compute without usage
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
    expect(d.used).toBe(10);
    expect(d.limit).toBe(100);
    expect(d.remaining).toBeNull(); // window unreliable → no precise remaining
  });

  it("joins ONLY on matching labels — different models stay separate (no cross-join)", () => {
    const limitName = "GenerateContentRequestsPerDayPerProjectPerModel-FreeTier";
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/usage`, { model: "model-a", limit_name: limitName }, [pt(5)]),
        series(`${REQ}/limit`, { model: "model-b", limit_name: limitName }, [pt(200)]),
      ],
      OPTS,
    );
    expect(res.dimensions).toHaveLength(2);
    const a = res.dimensions.find((d) => d.model === "model-a")!;
    const b = res.dimensions.find((d) => d.model === "model-b")!;
    expect(a.used).toBe(5);
    expect(a.limit).toBeNull();
    expect(a.remaining).toBeNull(); // no limit for model-a → not invented from model-b
    expect(b.limit).toBe(200);
    expect(b.used).toBeNull();
    expect(res.observedModels).toEqual(["model-a", "model-b"]);
  });

  it("ignores *_internal metrics", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${BASE}/generate_content_free_tier_requests_internal/usage`, { model: "m", limit_name: "XPerDay" }, [pt(99)]),
      ],
      OPTS,
    );
    expect(res.status).toBe("unavailable");
    expect(res.dimensions).toHaveLength(0);
  });

  it("sums DELTA usage points across the window", () => {
    const limitName = "GenerateContentRequestsPerMinutePerProjectPerModel-FreeTier";
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model: "m", limit_name: limitName }, [pt(30)]),
        series(`${REQ}/usage`, { model: "m", limit_name: limitName }, [pt(2), pt(3), pt(5)]),
      ],
      OPTS,
    );
    const d = res.dimensions[0];
    expect(d.used).toBe(10);
    expect(d.remaining).toBe(20);
  });

  it("preserves the method label when present", () => {
    const res = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/usage`, { model: "m", limit_name: "XPerDay", method: "GenerateContent" }, [pt(1)]),
      ],
      OPTS,
    );
    expect(res.dimensions[0].method).toBe("GenerateContent");
  });

  it("reports unavailable (with a message) for empty or missing input", () => {
    for (const input of [[], undefined, null]) {
      const res = normalizeMonitoringTimeSeries(input as RawTimeSeries[], OPTS);
      expect(res.status).toBe("unavailable");
      expect(res.providerTier).toBe("unknown");
      expect(res.dimensions).toEqual([]);
      expect(typeof res.message).toBe("string");
    }
  });
});

describe("computeRemaining / inferWindow", () => {
  it("computeRemaining requires used, limit, and a reliable window; floors at 0", () => {
    expect(computeRemaining(100, 30, "day")).toBe(70);
    expect(computeRemaining(100, 130, "minute")).toBe(0); // floored
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

describe("mergeWindowedProviderQuota", () => {
  const model = "gemini-flash-latest";
  const dayLimit = "GenerateContentRequestsPerDayPerProjectPerModel-FreeTier";
  const minLimit = "GenerateContentRequestsPerMinutePerProjectPerModel-FreeTier";

  it("takes day/unknown dims from the daily result and minute dims from the minute result", () => {
    const daily = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model, limit_name: dayLimit }, [pt(200)]),
        series(`${REQ}/usage`, { model, limit_name: dayLimit }, [pt(120)]),
        // A minute series ALSO returned in the daily window (over-summed) must be dropped.
        series(`${REQ}/usage`, { model, limit_name: minLimit }, [pt(999)]),
      ],
      OPTS,
    );
    const minute = normalizeMonitoringTimeSeries(
      [
        series(`${REQ}/limit`, { model, limit_name: minLimit }, [pt(30)]),
        series(`${REQ}/usage`, { model, limit_name: minLimit }, [pt(4)]),
      ],
      OPTS,
    );
    const merged = mergeWindowedProviderQuota(daily, minute);
    const day = merged.dimensions.find((d) => d.window === "day")!;
    const min = merged.dimensions.find((d) => d.window === "minute")!;
    expect(day.used).toBe(120);
    expect(day.remaining).toBe(80);
    // Minute usage comes from the minute query (4), NOT the daily over-sum (999).
    expect(min.used).toBe(4);
    expect(min.remaining).toBe(26);
    expect(merged.observedModels).toEqual([model]);
    expect(merged.status).toBe("ok");
  });

  it("reports unavailable when neither window produced dimensions", () => {
    const empty = normalizeMonitoringTimeSeries([], OPTS);
    const merged = mergeWindowedProviderQuota(empty, empty);
    expect(merged.status).toBe("unavailable");
    expect(merged.dimensions).toEqual([]);
    expect(typeof merged.message).toBe("string");
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
