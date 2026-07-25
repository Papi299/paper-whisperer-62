import { describe, it, expect } from "vitest";
import {
  normalizeProviderQuotaResponse,
  categoryLabel,
  windowLabel,
} from "@/lib/geminiProviderQuota";

const okPayload = {
  status: "ok",
  configuredModel: "gemini-flash-latest",
  observedModels: ["gemini-flash-latest"],
  providerTier: "free",
  sharedScope: true,
  collectedAt: "2026-07-25T12:00:00Z",
  metricsMayLagSeconds: 240,
  dimensions: [
    {
      category: "requests",
      model: "gemini-flash-latest",
      limitName: "PerDay",
      method: "GenerateContent",
      window: "day",
      used: 50,
      limit: 200,
      remaining: 150,
      exceededAttempts: 0,
    },
  ],
};

describe("normalizeProviderQuotaResponse", () => {
  it("passes through a well-formed ok payload", () => {
    const res = normalizeProviderQuotaResponse(okPayload);
    expect(res).not.toBeNull();
    expect(res!.status).toBe("ok");
    expect(res!.dimensions).toHaveLength(1);
    expect(res!.dimensions[0]).toMatchObject({ category: "requests", used: 50, limit: 200, remaining: 150 });
  });

  it("accepts an unavailable payload with a message", () => {
    const res = normalizeProviderQuotaResponse({ status: "unavailable", configuredModel: "m", dimensions: [], message: "creds absent" });
    expect(res!.status).toBe("unavailable");
    expect(res!.message).toBe("creds absent");
    expect(res!.dimensions).toEqual([]);
  });

  it("returns null for a non-object or missing status", () => {
    expect(normalizeProviderQuotaResponse(null)).toBeNull();
    expect(normalizeProviderQuotaResponse("nope")).toBeNull();
    expect(normalizeProviderQuotaResponse({ dimensions: [] })).toBeNull();
    expect(normalizeProviderQuotaResponse({ status: "weird" })).toBeNull();
  });

  it("coerces missing usage/limit to null and never fabricates remaining", () => {
    const res = normalizeProviderQuotaResponse({
      status: "ok",
      dimensions: [{ category: "input_tokens", model: "m", limitName: "X", window: "unknown", used: null, limit: 5, remaining: null, exceededAttempts: null }],
    });
    const d = res!.dimensions[0];
    expect(d.used).toBeNull();
    expect(d.limit).toBe(5);
    expect(d.remaining).toBeNull();
    expect(d.exceededAttempts).toBeNull();
  });

  it("drops malformed dimensions (bad category) but keeps valid ones", () => {
    const res = normalizeProviderQuotaResponse({
      status: "ok",
      dimensions: [
        { category: "bogus", model: "m", limitName: "X", window: "day", used: 1, limit: 2, remaining: 1, exceededAttempts: 0 },
        okPayload.dimensions[0],
      ],
    });
    expect(res!.dimensions).toHaveLength(1);
    expect(res!.dimensions[0].category).toBe("requests");
  });

  it("defaults an unknown window and non-finite numbers safely", () => {
    const res = normalizeProviderQuotaResponse({
      status: "ok",
      dimensions: [{ category: "requests", model: "m", limitName: "X", window: "century", used: Infinity, limit: "200", remaining: 10, exceededAttempts: 2 }],
    });
    const d = res!.dimensions[0];
    expect(d.window).toBe("unknown");
    expect(d.used).toBeNull(); // Infinity is not finite
    expect(d.limit).toBeNull(); // "200" is a string, not a number
    expect(d.remaining).toBe(10);
    expect(d.exceededAttempts).toBe(2);
  });
});

describe("labels", () => {
  it("categoryLabel", () => {
    expect(categoryLabel("requests")).toBe("Requests");
    expect(categoryLabel("input_tokens")).toBe("Input tokens");
  });
  it("windowLabel", () => {
    expect(windowLabel("minute")).toMatch(/minute/i);
    expect(windowLabel("day")).toMatch(/day/i);
    expect(windowLabel("unknown")).toMatch(/unknown/i);
  });
});
