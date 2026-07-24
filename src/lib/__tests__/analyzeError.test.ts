import { describe, it, expect } from "vitest";
import { parseAnalyzeError, formatQuotaExceededMessage } from "@/lib/analyzeError";

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

  it("tolerates missing details (defaults numbers to 0, strings to null)", async () => {
    const result = await parseAnalyzeError(httpError(402, JSON.stringify({ error: "quota_exceeded", message: "x" })));
    expect(result.kind).toBe("quota_exceeded");
    if (result.kind !== "quota_exceeded") throw new Error("unreachable");
    expect(result.info).toMatchObject({ used: 0, quota: 0, remaining: 0, plan: null, periodType: null, resetAt: null });
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
});
