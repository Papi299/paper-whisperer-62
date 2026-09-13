// @vitest-environment node
//
// AI-MULTI-PROVIDER-001D — the pure list-price cost estimate.
//
// No network, no database, no clock: every rule is exercised against injected
// price records and hand-built usage. The shipped Gemini book is used only where
// a test is about the shipped book.
import { describe, it, expect } from "vitest";
import {
  AI_COST_AMOUNT_DECIMALS,
  estimateAiListPriceCost,
  formatFemtoUsd,
  parseRateNanoUsdPerMTok,
  type AiCostEstimate,
} from "../aiCostEstimate.ts";
import {
  AI_USAGE_INVALID,
  AI_USAGE_NOT_APPLICABLE,
  AI_USAGE_NOT_RETURNED,
  AI_USAGE_UNREPORTED,
  finalizeReportedUsage,
  reportedTokens,
  type AiProviderUsage,
  type AiUsageDimensions,
} from "../aiUsage.ts";
import type { AiListPriceRecord } from "../aiPriceBook.ts";

const AT = new Date("2026-10-01T00:00:00Z");

function record(overrides: Partial<AiListPriceRecord> = {}): AiListPriceRecord {
  return {
    id: "acme/model-x@2026-09-13",
    provider: "acme",
    providerModel: "model-x",
    validFrom: "2026-09-13T00:00:00Z",
    validUntil: null,
    inputUsdPerMTok: "2",
    cachedInputUsdPerMTok: "0.2",
    cacheWriteInputUsdPerMTok: "2.5",
    outputUsdPerMTok: "10",
    maxInputTokens: null,
    sourceUrl: "https://example.test/pricing",
    verifiedOn: "2026-09-13",
    ...overrides,
  };
}

function usage(dims: Partial<AiUsageDimensions>, unmodeled = false): AiProviderUsage {
  const built = finalizeReportedUsage(
    {
      inputTokens: reportedTokens(0),
      cachedInputTokens: reportedTokens(0),
      cacheWriteInputTokens: reportedTokens(0),
      outputTokens: reportedTokens(0),
      reasoningOutputTokens: AI_USAGE_UNREPORTED,
      providerTotalTokens: AI_USAGE_NOT_APPLICABLE,
      ...dims,
    },
    unmodeled,
  );
  if (built.kind !== "reported") throw new Error("fixture usage failed validation");
  return built;
}

function estimate(
  u: AiProviderUsage,
  opts: Partial<Parameters<typeof estimateAiListPriceCost>[0]> = {},
): AiCostEstimate {
  return estimateAiListPriceCost({
    provider: "acme",
    providerModel: "model-x",
    at: AT,
    attempts: 1,
    usage: u,
    priceRecords: [record()],
    ...opts,
  });
}

describe("ordinary pricing", () => {
  it("prices input and output at their own rates", () => {
    // 1,000 x $2/M + 500 x $10/M = $0.002 + $0.005
    const e = estimate(usage({ inputTokens: reportedTokens(1000), outputTokens: reportedTokens(500) }));
    expect(e.status).toBe("estimated");
    expect(e.amountUsd).toBe("0.007000000000000");
    expect(e.lowerBoundReasons).toEqual([]);
  });

  it("prices cache reads at the cached rate, not the input rate", () => {
    // uncached 600 x $2/M + cached 400 x $0.2/M
    const e = estimate(
      usage({ inputTokens: reportedTokens(1000), cachedInputTokens: reportedTokens(400) }),
    );
    expect(e.amountUsd).toBe("0.001280000000000");
  });

  it("prices cache writes at the cache-write rate, disjoint from reads", () => {
    // uncached 500 x $2/M + cached 300 x $0.2/M + written 200 x $2.5/M
    const e = estimate(
      usage({
        inputTokens: reportedTokens(1000),
        cachedInputTokens: reportedTokens(300),
        cacheWriteInputTokens: reportedTokens(200),
      }),
    );
    expect(e.amountUsd).toBe("0.001560000000000");
  });

  it("carries a snapshot of exactly the rates it used", () => {
    const e = estimate(usage({ inputTokens: reportedTokens(10), outputTokens: reportedTokens(1) }));
    expect(e.prices).toEqual({
      recordId: "acme/model-x@2026-09-13",
      inputUsdPerMTok: "2",
      cachedInputUsdPerMTok: "0.2",
      cacheWriteInputUsdPerMTok: "2.5",
      outputUsdPerMTok: "10",
    });
  });
});

describe("no double counting", () => {
  it("never adds reasoning on top of output — it is already inside it", () => {
    const withReasoning = estimate(
      usage({ outputTokens: reportedTokens(1186), reasoningOutputTokens: reportedTokens(1024) }),
    );
    const withoutReasoning = estimate(usage({ outputTokens: reportedTokens(1186) }));
    expect(withReasoning.amountUsd).toBe(withoutReasoning.amountUsd);
    expect(withReasoning.amountUsd).toBe("0.011860000000000");
  });

  it("never prices the provider's own total", () => {
    const a = estimate(usage({ inputTokens: reportedTokens(75), outputTokens: reportedTokens(1186) }));
    const b = estimate(
      usage({
        inputTokens: reportedTokens(75),
        outputTokens: reportedTokens(1186),
        providerTotalTokens: reportedTokens(99_999),
      }),
    );
    expect(b.amountUsd).toBe(a.amountUsd);
  });

  it("does not price cached tokens as input AND as cached", () => {
    const allCached = estimate(
      usage({ inputTokens: reportedTokens(1000), cachedInputTokens: reportedTokens(1000) }),
    );
    // 1,000 x $0.2/M only — not 1,000 x $2/M on top.
    expect(allCached.amountUsd).toBe("0.000200000000000");
  });
});

describe("unknown is never zero", () => {
  it("returns no amount — not 0 — when the provider returned no usage", () => {
    const e = estimate(AI_USAGE_NOT_RETURNED);
    expect(e.status).toBe("usage_unavailable");
    expect(e.amountUsd).toBeNull();
    expect(e.prices).toBeNull();
  });

  it("returns no amount when the usage failed validation", () => {
    expect(estimate(AI_USAGE_INVALID)).toMatchObject({ status: "usage_unavailable", amountUsd: null });
  });

  it("prices a REPORTED zero as exactly zero", () => {
    const e = estimate(usage({ inputTokens: reportedTokens(0), outputTokens: reportedTokens(0) }));
    expect(e.status).toBe("estimated");
    expect(e.amountUsd).toBe("0.000000000000000");
  });

  it.each([
    ["inputTokens"],
    ["outputTokens"],
    ["cachedInputTokens"],
    ["cacheWriteInputTokens"],
  ] as const)("refuses to guess when %s — which has a price of its own — is unreported", (dim) => {
    const e = estimate(usage({ inputTokens: reportedTokens(100), [dim]: AI_USAGE_UNREPORTED }));
    expect(e.status).toBe("usage_incomplete");
    expect(e.amountUsd).toBeNull();
  });

  it("still estimates when only informational dimensions are unreported", () => {
    const e = estimate(
      usage({
        inputTokens: reportedTokens(100),
        outputTokens: reportedTokens(10),
        reasoningOutputTokens: AI_USAGE_UNREPORTED,
        providerTotalTokens: AI_USAGE_UNREPORTED,
      }),
    );
    expect(e.status).toBe("estimated");
  });

  it("treats a dimension the protocol does not have as zero, not unknown", () => {
    const e = estimate(
      usage({ inputTokens: reportedTokens(100), cacheWriteInputTokens: AI_USAGE_NOT_APPLICABLE }),
    );
    expect(e.status).toBe("estimated");
    expect(e.amountUsd).toBe("0.000200000000000");
  });
});

describe("pricing availability", () => {
  const u = usage({ inputTokens: reportedTokens(100), outputTokens: reportedTokens(10) });

  it("is unpriced for a model with no record", () => {
    const e = estimate(u, { providerModel: "model-y" });
    expect(e).toMatchObject({ status: "unpriced", amountUsd: null, prices: null });
  });

  it("is unpriced before a record's validity starts", () => {
    expect(estimate(u, { at: new Date("2026-09-12T23:59:59Z") }).status).toBe("unpriced");
  });

  it("is unpriced when two records overlap — a lookup is never a choice", () => {
    const e = estimate(u, { priceRecords: [record(), record({ id: "acme/model-x@2026-09-20" })] });
    expect(e.status).toBe("unpriced");
  });

  it("never prices cache reads at another rate when the record has none", () => {
    const cached = usage({ inputTokens: reportedTokens(100), cachedInputTokens: reportedTokens(1) });
    expect(estimate(cached, { priceRecords: [record({ cachedInputUsdPerMTok: null })] }).status).toBe("unpriced");
    // …but a record without the rate still prices a request that had none.
    const none = estimate(u, { priceRecords: [record({ cachedInputUsdPerMTok: null })] });
    expect(none.status).toBe("estimated");
    expect(none.prices?.cachedInputUsdPerMTok).toBeNull();
  });

  it("never prices cache writes at another rate when the record has none", () => {
    const written = usage({ inputTokens: reportedTokens(100), cacheWriteInputTokens: reportedTokens(1) });
    expect(
      estimate(written, { priceRecords: [record({ cacheWriteInputUsdPerMTok: null })] }).status,
    ).toBe("unpriced");
  });

  it("is unpriced above a record's prompt-size tier, and priced at it", () => {
    const tiered = [record({ maxInputTokens: 100 })];
    expect(estimate(u, { priceRecords: tiered }).status).toBe("estimated");
    const over = usage({ inputTokens: reportedTokens(101) });
    expect(estimate(over, { priceRecords: tiered }).status).toBe("unpriced");
  });

  it.each(["1e-3", "-1", ".5", "1.", "01.5", "0.1234567891", "", " 2"])(
    "prices nothing from a malformed rate %j",
    (rate) => {
      expect(estimate(u, { priceRecords: [record({ inputUsdPerMTok: rate })] }).status).toBe("unpriced");
    },
  );

  it("decides usage before pricing — no record is consulted for missing usage", () => {
    expect(estimate(AI_USAGE_NOT_RETURNED, { providerModel: "model-y" }).status).toBe("usage_unavailable");
  });
});

describe("prices that change over time", () => {
  const u = usage({ inputTokens: reportedTokens(1_000_000), outputTokens: reportedTokens(1_000_000) });
  const book = [
    record({ id: "acme/model-x@2026-09-13", validUntil: "2027-01-01T00:00:00Z" }),
    record({
      id: "acme/model-x@2027-01-01",
      validFrom: "2027-01-01T00:00:00Z",
      inputUsdPerMTok: "4",
      outputUsdPerMTok: "20",
    }),
  ];

  it("uses the record in effect at the event's instant", () => {
    expect(estimate(u, { priceRecords: book, at: new Date("2026-12-31T23:59:59Z") })).toMatchObject({
      amountUsd: "12.000000000000000",
      prices: { recordId: "acme/model-x@2026-09-13" },
    });
    expect(estimate(u, { priceRecords: book, at: new Date("2027-01-01T00:00:00Z") })).toMatchObject({
      amountUsd: "24.000000000000000",
      prices: { recordId: "acme/model-x@2027-01-01" },
    });
  });

  it("leaves an earlier estimate's snapshot untouched when a later record is added", () => {
    const at = new Date("2026-10-01T00:00:00Z");
    const before = estimate(u, { priceRecords: [book[0]], at });
    const after = estimate(u, { priceRecords: book, at });
    expect(after).toEqual(before);
  });

  it("prices the shipped Gemini 3.6 Flash change on each side and not inside the timezone gap", () => {
    const gemini = usage({ inputTokens: reportedTokens(1_000_000), outputTokens: reportedTokens(1_000_000) });
    const at = (iso: string) =>
      estimateAiListPriceCost({
        provider: "google",
        providerModel: "gemini-3.6-flash",
        at: new Date(iso),
        attempts: 1,
        usage: gemini,
      });
    expect(at("2026-10-01T00:00:00Z").amountUsd).toBe("4.500000000000000"); // 0.75 + 3.75
    expect(at("2026-12-31T12:00:00Z").status).toBe("unpriced");
    expect(at("2027-02-01T00:00:00Z").amountUsd).toBe("9.000000000000000"); // 1.50 + 7.50
  });
});

describe("lower bounds", () => {
  const u = usage({ inputTokens: reportedTokens(100), outputTokens: reportedTokens(10) });

  it("is a lower bound when more than one provider attempt happened", () => {
    const e = estimate(u, { attempts: 2 });
    expect(e.status).toBe("estimated_lower_bound");
    expect(e.lowerBoundReasons).toEqual(["multiple_attempts"]);
    // The amount itself is still exact for the usage that was reported.
    expect(e.amountUsd).toBe(estimate(u).amountUsd);
  });

  it("is a lower bound when the provider reported unmodeled billable usage", () => {
    const e = estimate(usage({ inputTokens: reportedTokens(100) }, true));
    expect(e.status).toBe("estimated_lower_bound");
    expect(e.lowerBoundReasons).toEqual(["unmodeled_usage"]);
  });

  it("names both reasons when both hold", () => {
    expect(estimate(usage({}, true), { attempts: 3 }).lowerBoundReasons).toEqual([
      "multiple_attempts",
      "unmodeled_usage",
    ]);
  });
});

describe("exact decimal arithmetic", () => {
  it("has no floating-point drift where floats do", () => {
    // 3 x $0.1/M is 3e-7 exactly; in binary floating point it is not.
    expect((3 * 0.1) / 1_000_000).not.toBe(3e-7);
    const e = estimate(usage({ inputTokens: reportedTokens(3) }), {
      priceRecords: [record({ inputUsdPerMTok: "0.1" })],
    });
    expect(e.amountUsd).toBe("0.000000300000000");
  });

  it("represents the smallest rate on a single token", () => {
    const e = estimate(usage({ inputTokens: reportedTokens(1) }), {
      priceRecords: [record({ inputUsdPerMTok: "0.000000001" })],
    });
    expect(e.amountUsd).toBe("0.000000000000001");
  });

  it("stays exact at the largest accepted usage and a nine-decimal rate", () => {
    const e = estimate(
      usage({ inputTokens: reportedTokens(100_000_000), outputTokens: reportedTokens(100_000_000) }),
      { priceRecords: [record({ inputUsdPerMTok: "999.999999999", outputUsdPerMTok: "0.000000003" })] },
    );
    // 1e8 x 999.999999999 / 1e6 = 99,999.9999999 and 1e8 x 3e-9 / 1e6 = 3e-7:
    // the sum carries across every digit and is still exact.
    expect(e.amountUsd).toBe("100000.000000200000000");
  });

  it("always formats exactly fifteen decimals", () => {
    expect(AI_COST_AMOUNT_DECIMALS).toBe(15);
    expect(formatFemtoUsd(0n)).toBe("0.000000000000000");
    expect(formatFemtoUsd(1n)).toBe("0.000000000000001");
    expect(formatFemtoUsd(1234567890123456789n)).toBe("1234.567890123456789");
    expect(() => formatFemtoUsd(-1n)).toThrow(RangeError);
  });

  it("parses rates into exact integer nano-dollars per million tokens", () => {
    expect(parseRateNanoUsdPerMTok("0.075")).toBe(75_000_000n);
    expect(parseRateNanoUsdPerMTok("1.50")).toBe(1_500_000_000n);
    expect(parseRateNanoUsdPerMTok("9")).toBe(9_000_000_000n);
    expect(parseRateNanoUsdPerMTok("0.000000001")).toBe(1n);
    for (const bad of ["01.5", ".5", "1.", "-1", "1e3", "0.1234567890", "NaN", "Infinity"]) {
      expect(parseRateNanoUsdPerMTok(bad)).toBeNull();
    }
  });
});

describe("free tier is not a price", () => {
  it("prices a shipped Gemini request above zero — the estimate never reads account status", () => {
    const e = estimateAiListPriceCost({
      provider: "google",
      providerModel: "gemini-3.5-flash",
      at: AT,
      attempts: 1,
      usage: usage({
        inputTokens: reportedTokens(2000),
        outputTokens: reportedTokens(300),
        cacheWriteInputTokens: AI_USAGE_NOT_APPLICABLE,
      }),
    });
    // 2,000 x $1.50/M + 300 x $9.00/M
    expect(e).toMatchObject({ status: "estimated", amountUsd: "0.005700000000000" });
    expect(e.prices?.recordId).toBe("google/gemini-3.5-flash@2026-09-13");
  });
});
