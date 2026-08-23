import { describe, it, expect } from "vitest";
import {
  parseAnalyzeError,
  parseAiEdgeError,
  formatQuotaExceededMessage,
  formatResetDate,
} from "@/lib/analyzeError";

/** Build a FunctionsHttpError-like object with a Response `.context`. */
function httpError(status: number, body: string): unknown {
  return Object.assign(new Error("Edge Function returned a non-2xx status code"), {
    context: new Response(body, { status }),
  });
}

const validQuotaBody = JSON.stringify({
  error: "quota_exceeded",
  message: "AI analysis quota exceeded.",
  details: {
    plan: "free",
    period_type: "lifetime",
    used: 15,
    quota: 15,
    remaining: 0,
    reset_at: null,
  },
});

describe("parseAnalyzeError", () => {
  it("parses a valid structured 402 quota payload", async () => {
    const result = await parseAnalyzeError(httpError(402, validQuotaBody));
    expect(result.kind).toBe("quota_exceeded");
    if (result.kind !== "quota_exceeded") throw new Error("unreachable");
    expect(result.info).toMatchObject({
      plan: "free",
      periodType: "lifetime",
      used: 15,
      quota: 15,
      remaining: 0,
      resetAt: null,
      message: "AI analysis quota exceeded.",
    });
  });

  it("parses a monthly 402 with a reset_at", async () => {
    const body = JSON.stringify({
      error: "quota_exceeded",
      message: "AI analysis quota exceeded.",
      details: { plan: "pro", period_type: "monthly", used: 350, quota: 350, remaining: 0, reset_at: "2026-08-01T00:00:00Z" },
    });
    const result = await parseAnalyzeError(httpError(402, body));
    expect(result.kind).toBe("quota_exceeded");
    if (result.kind !== "quota_exceeded") throw new Error("unreachable");
    expect(result.info.periodType).toBe("monthly");
    expect(result.info.resetAt).toBe("2026-08-01T00:00:00Z");
  });

  it("falls back to 'other' for malformed 402 JSON", async () => {
    const result = await parseAnalyzeError(httpError(402, "not-json{{"));
    expect(result).toEqual({ kind: "other", message: "Edge Function returned a non-2xx status code" });
  });

  it("falls back to 'other' for a 402 whose body.error is not quota_exceeded", async () => {
    const result = await parseAnalyzeError(httpError(402, JSON.stringify({ error: "something_else" })));
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' for a non-402 status (does not string-match)", async () => {
    const result = await parseAnalyzeError(httpError(500, validQuotaBody));
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' for a plain Error with no context", async () => {
    const result = await parseAnalyzeError(new Error("upstream gemini timeout"));
    expect(result).toEqual({ kind: "other", message: "upstream gemini timeout" });
  });

  it("falls back to 'other' when the context body was already consumed / json throws", async () => {
    const err = { context: { status: 402, json: async () => { throw new Error("body already used"); } } };
    const result = await parseAnalyzeError(err);
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' for a non-Error, non-object value", async () => {
    const result = await parseAnalyzeError("boom");
    expect(result).toEqual({ kind: "other", message: "Unknown error" });
  });

  it("parses a valid non-exhausted lifetime payload", async () => {
    const body = JSON.stringify({
      error: "quota_exceeded",
      message: "x",
      details: { plan: "free", period_type: "lifetime", used: 3, quota: 15, remaining: 12, reset_at: null },
    });
    const result = await parseAnalyzeError(httpError(402, body));
    expect(result.kind).toBe("quota_exceeded");
    if (result.kind !== "quota_exceeded") throw new Error("unreachable");
    expect(result.info).toMatchObject({ used: 3, quota: 15, remaining: 12, periodType: "lifetime" });
  });

  // ── Strict details validation: a missing/malformed details object must NOT
  //    be coerced into an authoritative zero-quota response. ────────────────
  it("falls back to 'other' when details is missing", async () => {
    const result = await parseAnalyzeError(httpError(402, JSON.stringify({ error: "quota_exceeded", message: "x" })));
    expect(result).toEqual({ kind: "other", message: "Edge Function returned a non-2xx status code" });
  });

  it("falls back to 'other' when details is not an object", async () => {
    const result = await parseAnalyzeError(httpError(402, JSON.stringify({ error: "quota_exceeded", details: "nope" })));
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' when a numeric detail field is missing", async () => {
    const body = JSON.stringify({ error: "quota_exceeded", details: { plan: "free", period_type: "lifetime", quota: 15, remaining: 0, reset_at: null } });
    const result = await parseAnalyzeError(httpError(402, body));
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' for a negative numeric detail field", async () => {
    const body = JSON.stringify({ error: "quota_exceeded", details: { plan: "free", period_type: "lifetime", used: -1, quota: 15, remaining: 0, reset_at: null } });
    const result = await parseAnalyzeError(httpError(402, body));
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' for a non-finite numeric detail field", async () => {
    // JSON cannot carry Infinity, so emulate the parsed body via a fake context.
    const err = {
      context: {
        status: 402,
        clone: () => ({
          status: 402,
          json: async () => ({
            error: "quota_exceeded",
            details: { plan: "free", period_type: "lifetime", used: Number.POSITIVE_INFINITY, quota: 15, remaining: 0, reset_at: null },
          }),
        }),
        json: async () => ({}),
      },
    };
    const result = await parseAnalyzeError(err);
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' for a non-number (string) numeric detail field", async () => {
    const body = JSON.stringify({ error: "quota_exceeded", details: { plan: "free", period_type: "lifetime", used: "15", quota: 15, remaining: 0, reset_at: null } });
    const result = await parseAnalyzeError(httpError(402, body));
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' for an invalid period_type", async () => {
    const body = JSON.stringify({ error: "quota_exceeded", details: { plan: "free", period_type: "weekly", used: 1, quota: 15, remaining: 14, reset_at: null } });
    const result = await parseAnalyzeError(httpError(402, body));
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' for an invalid reset_at type", async () => {
    const body = JSON.stringify({ error: "quota_exceeded", details: { plan: "free", period_type: "monthly", used: 1, quota: 15, remaining: 14, reset_at: 123 } });
    const result = await parseAnalyzeError(httpError(402, body));
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' for an invalid plan type", async () => {
    const body = JSON.stringify({ error: "quota_exceeded", details: { plan: 7, period_type: "lifetime", used: 1, quota: 15, remaining: 14, reset_at: null } });
    const result = await parseAnalyzeError(httpError(402, body));
    expect(result.kind).toBe("other");
  });
});

describe("parseAnalyzeError — structured provider failure (HTTP 500)", () => {
  const codes = ["provider_rate_limit", "provider_unavailable", "malformed_response", "unknown"] as const;

  for (const code of codes) {
    it(`parses a 500 analysis_unavailable with code '${code}'`, async () => {
      const body = JSON.stringify({ error: "analysis_unavailable", code, message: "AI analysis is temporarily unavailable. Please try again later." });
      const result = await parseAnalyzeError(httpError(500, body));
      expect(result.kind).toBe("provider_failure");
      if (result.kind !== "provider_failure") throw new Error("unreachable");
      expect(result.code).toBe(code);
      expect(result.message).toMatch(/temporarily unavailable/i);
      // Never leaks provider/Google detail.
      expect(result.message).not.toMatch(/google|gemini|quota|project|429/i);
    });
  }

  it("falls back to 'other' for a 500 with an unrecognized code", async () => {
    const body = JSON.stringify({ error: "analysis_unavailable", code: "meltdown", message: "x" });
    const result = await parseAnalyzeError(httpError(500, body));
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' for a 500 with a missing/empty message", async () => {
    expect((await parseAnalyzeError(httpError(500, JSON.stringify({ error: "analysis_unavailable", code: "unknown" })))).kind).toBe("other");
    expect((await parseAnalyzeError(httpError(500, JSON.stringify({ error: "analysis_unavailable", code: "unknown", message: "" })))).kind).toBe("other");
  });

  it("falls back to 'other' for a 500 whose error field is not analysis_unavailable", async () => {
    const result = await parseAnalyzeError(httpError(500, JSON.stringify({ error: "boom", code: "unknown", message: "x" })));
    expect(result.kind).toBe("other");
  });

  it("falls back to 'other' for a malformed 500 body", async () => {
    const result = await parseAnalyzeError(httpError(500, "not-json{{"));
    expect(result).toEqual({ kind: "other", message: "Edge Function returned a non-2xx status code" });
  });

  it("keeps the 402 quota path separate from the 500 provider path", async () => {
    const quota = await parseAnalyzeError(httpError(402, validQuotaBody));
    expect(quota.kind).toBe("quota_exceeded");
    // A provider 500 is NEVER a quota_exceeded.
    const provider = await parseAnalyzeError(httpError(500, JSON.stringify({ error: "analysis_unavailable", code: "provider_rate_limit", message: "unavailable" })));
    expect(provider.kind).toBe("provider_failure");
  });
});

describe("formatQuotaExceededMessage", () => {
  it("describes a lifetime allowance without a reset date", () => {
    const msg = formatQuotaExceededMessage({ periodType: "lifetime", used: 15, quota: 15, resetAt: null });
    expect(msg).toContain("lifetime");
    expect(msg).toContain("15");
    expect(msg).not.toMatch(/upgrade|pay|billing|purchase|subscri/i);
  });

  it("includes the reset date for a monthly allowance", () => {
    const msg = formatQuotaExceededMessage({ periodType: "monthly", used: 350, quota: 350, resetAt: "2026-08-01T00:00:00Z" });
    expect(msg).toMatch(/monthly/);
    expect(msg).toMatch(/resets/i);
  });

  it("handles a zero-quota allowance without crashing", () => {
    const msg = formatQuotaExceededMessage({ periodType: "lifetime", used: 0, quota: 0, resetAt: null });
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toMatch(/upgrade|paywall/i);
  });

  it("uses neutral 'unavailable' wording when periodType is null (never 'lifetime')", () => {
    const msg = formatQuotaExceededMessage({ periodType: null, used: 0, quota: 0, resetAt: null });
    expect(msg).toMatch(/unavailable/i);
    expect(msg).not.toMatch(/lifetime/i);
  });

  it("renders the monthly reset date in UTC (Aug 1)", () => {
    const aug1 = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 7, 1)));
    const msg = formatQuotaExceededMessage({ periodType: "monthly", used: 350, quota: 350, resetAt: "2026-08-01T00:00:00Z" });
    expect(msg).toContain(aug1);
  });
});

describe("parseAiEdgeError — one parser, two functions, no cross-talk", () => {
  const providerBody = (error: string) =>
    JSON.stringify({ error, code: "provider_rate_limit", message: "temporarily unavailable" });

  it("reads a suggestions_unavailable 500 when asked for that discriminator", async () => {
    const result = await parseAiEdgeError(
      httpError(500, providerBody("suggestions_unavailable")),
      "suggestions_unavailable",
    );
    expect(result.kind).toBe("provider_failure");
  });

  it("does NOT read an analysis 500 as a suggestion provider failure", async () => {
    const result = await parseAiEdgeError(
      httpError(500, providerBody("analysis_unavailable")),
      "suggestions_unavailable",
    );
    expect(result.kind).toBe("other");
  });

  it("does NOT read a suggestion 500 as an analysis provider failure", async () => {
    const result = await parseAiEdgeError(
      httpError(500, providerBody("suggestions_unavailable")),
      "analysis_unavailable",
    );
    expect(result.kind).toBe("other");
  });

  it("shares the 402 quota branch across both functions", async () => {
    for (const code of ["analysis_unavailable", "suggestions_unavailable"] as const) {
      const result = await parseAiEdgeError(httpError(402, validQuotaBody), code);
      expect(result.kind).toBe("quota_exceeded");
    }
  });
});

describe("shared allowance wording is 'AI requests'", () => {
  // One `ai_analysis` counter is spent by paper analysis AND by organization
  // suggestions, so the wall cannot be described as "analyses" — a user who
  // ran out on suggestions would be told they were out of the wrong thing.
  it("names the lifetime allowance 'AI requests', not 'AI analyses'", () => {
    const msg = formatQuotaExceededMessage({
      periodType: "lifetime",
      used: 15,
      quota: 15,
      resetAt: null,
    });
    expect(msg).toContain("AI requests");
    expect(msg).not.toContain("AI analyses");
  });

  it("names the monthly allowance 'AI requests' too", () => {
    const msg = formatQuotaExceededMessage({
      periodType: "monthly",
      used: 350,
      quota: 350,
      resetAt: "2026-08-01T00:00:00Z",
    });
    expect(msg).toContain("AI requests");
    expect(msg).not.toContain("AI analyses");
  });

  it("uses AI-request wording for a zero-quota allowance", () => {
    const msg = formatQuotaExceededMessage({
      periodType: "lifetime",
      used: 0,
      quota: 0,
      resetAt: null,
    });
    expect(msg).toContain("AI requests");
  });

  it("uses AI-request wording for the no-bucket unavailable state", () => {
    const msg = formatQuotaExceededMessage({
      periodType: null,
      used: 0,
      quota: 0,
      resetAt: null,
    });
    expect(msg).toContain("AI requests");
    expect(msg).not.toContain("AI analysis");
  });

  it("still carries no upgrade or paywall language", () => {
    const msg = formatQuotaExceededMessage({
      periodType: "lifetime",
      used: 15,
      quota: 15,
      resetAt: null,
    });
    expect(msg).not.toMatch(/upgrade|pay|billing|purchase|subscri|checkout/i);
  });
});

describe("formatResetDate", () => {
  it("renders the UTC calendar date (Aug 1, not the timezone-shifted Jul 31)", () => {
    const aug1 = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 7, 1)));
    const jul31 = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 6, 31)));
    expect(formatResetDate("2026-08-01T00:00:00Z")).toBe(aug1);
    expect(formatResetDate("2026-08-01T00:00:00Z")).not.toBe(jul31);
  });

  it("fails soft (null) for invalid, empty, or absent input", () => {
    expect(formatResetDate("not-a-date")).toBeNull();
    expect(formatResetDate("")).toBeNull();
    expect(formatResetDate(null)).toBeNull();
    expect(formatResetDate(undefined)).toBeNull();
  });
});
