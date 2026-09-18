// @vitest-environment node
//
// AI-MULTI-PROVIDER-001D — the shipped list-price book and its lookup.
//
// The book is data, so these tests are its schema: every record obeys the rules
// the module header states, the seeded set is exactly what was verified, and no
// record can make a lookup ambiguous.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AI_LIST_PRICE_BASIS,
  AI_LIST_PRICE_RECORDS,
  findAiListPriceRecord,
  type AiListPriceRecord,
} from "../aiPriceBook.ts";
import { parseRateNanoUsdPerMTok } from "../aiCostEstimate.ts";

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL("../../../migrations/20260913120000_add_ai_provider_usage_telemetry.sql", import.meta.url),
  ),
  "utf8",
);

// The exact pattern the table's `price_record_shape` CHECK uses.
const PRICE_RECORD_ID_SQL_PATTERN =
  "^[a-z][a-z0-9_-]{0,31}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}@[0-9]{4}-[0-9]{2}-[0-9]{2}$";

function rates(r: AiListPriceRecord): Array<string | null> {
  return [r.inputUsdPerMTok, r.cachedInputUsdPerMTok, r.cacheWriteInputUsdPerMTok, r.outputUsdPerMTok];
}

describe("every shipped record", () => {
  it.each(AI_LIST_PRICE_RECORDS.map((r) => [r.id, r] as const))("%s obeys the book's rules", (_id, r) => {
    expect(r.id.startsWith(`${r.provider}/${r.providerModel}@`)).toBe(true);
    expect(r.id).toMatch(new RegExp(PRICE_RECORD_ID_SQL_PATTERN));
    expect(Number.isNaN(Date.parse(r.validFrom))).toBe(false);
    if (r.validUntil !== null) expect(Date.parse(r.validUntil)).toBeGreaterThan(Date.parse(r.validFrom));
    for (const rate of rates(r)) {
      if (rate === null) continue;
      const nano = parseRateNanoUsdPerMTok(rate);
      expect(nano).not.toBeNull();
      // Within the table's rate CHECK, with a wide margin.
      expect(nano! <= 1_000n * 1_000_000_000n).toBe(true);
    }
    expect(r.sourceUrl).toMatch(/^https:\/\//);
    expect(r.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("has a unique id — an id is never reused", () => {
    const ids = AI_LIST_PRICE_RECORDS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never overlaps another record for the same model", () => {
    const byModel = new Map<string, AiListPriceRecord[]>();
    for (const r of AI_LIST_PRICE_RECORDS) {
      const key = `${r.provider}/${r.providerModel}`;
      byModel.set(key, [...(byModel.get(key) ?? []), r]);
    }
    for (const records of byModel.values()) {
      const sorted = [...records].sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom));
      for (let i = 1; i < sorted.length; i++) {
        const previousEnd = sorted[i - 1].validUntil;
        expect(previousEnd).not.toBeNull();
        expect(Date.parse(previousEnd!)).toBeLessThanOrEqual(Date.parse(sorted[i].validFrom));
      }
    }
  });

  it("matches the id shape the database enforces", () => {
    expect(MIGRATION).toContain(`'${PRICE_RECORD_ID_SQL_PATTERN}'`);
  });

  it("states one basis for every rate", () => {
    expect(AI_LIST_PRICE_BASIS).toBe("provider_standard_paid_tier_list_price");
  });
});

describe("the seeded set is exactly what was verified", () => {
  it("prices the four routable Gemini models and the two staged paid models", () => {
    expect(AI_LIST_PRICE_RECORDS.map((r) => r.id)).toEqual([
      "google/gemini-3.5-flash@2026-09-13",
      "google/gemini-3.6-flash@2026-09-13",
      "google/gemini-3.6-flash@2027-01-01",
      "google/gemini-3.7-flash@2026-09-13",
      "google/gemini-3.7-flash@2027-01-01",
      "google/gemini-3.8-flash@2026-09-13",
      "google/gemini-3.8-flash@2027-01-01",
      "anthropic/claude-sonnet-5@2026-09-17",
      "openai/gpt-5.6-terra@2026-09-17",
    ]);
  });

  it("prices exactly one record per paid model — no duplicate and no second tier", () => {
    // The uniqueness and non-overlap suites above run over the whole book, so
    // this is the narrower claim they cannot make: each paid model got ONE
    // record, so a lookup at any instant is never a choice between two rates.
    for (const [provider, model] of [
      ["anthropic", "claude-sonnet-5"],
      ["openai", "gpt-5.6-terra"],
    ]) {
      const matches = AI_LIST_PRICE_RECORDS.filter(
        (r) => r.provider === provider && r.providerModel === model,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].validUntil).toBeNull();
      expect(matches[0].verifiedOn).toBe("2026-09-17");
      expect(matches[0].validFrom).toBe("2026-09-17T00:00:00Z");
    }
  });

  it("carries Google's published rates, read 2026-09-13", () => {
    const at = (model: string, iso: string) => findAiListPriceRecord("google", model, new Date(iso));
    expect(at("gemini-3.5-flash", "2026-10-01T00:00:00Z")).toMatchObject({
      inputUsdPerMTok: "1.50",
      cachedInputUsdPerMTok: "0.15",
      outputUsdPerMTok: "9.00",
    });
    for (const model of ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"]) {
      expect(at(model, "2026-10-01T00:00:00Z")).toMatchObject({
        inputUsdPerMTok: "0.75",
        cachedInputUsdPerMTok: "0.075",
        outputUsdPerMTok: "3.75",
      });
      expect(at(model, "2027-02-01T00:00:00Z")).toMatchObject({
        inputUsdPerMTok: "1.50",
        cachedInputUsdPerMTok: "0.15",
        outputUsdPerMTok: "7.50",
      });
    }
    // Scoped to the Google records: the book now holds paid-provider records
    // read from other pages on another day. The claim itself is unweakened —
    // every Google record still has to carry Google's page and Google's date.
    const googleRecords = AI_LIST_PRICE_RECORDS.filter((r) => r.provider === "google");
    expect(googleRecords).toHaveLength(7);
    for (const r of googleRecords) {
      expect(r.sourceUrl).toBe("https://ai.google.dev/gemini-api/docs/pricing");
      expect(r.verifiedOn).toBe("2026-09-13");
      // Google's usage has no cache-write dimension; there is no rate to hold.
      expect(r.cacheWriteInputUsdPerMTok).toBeNull();
      // No prompt-size tier is published for these models.
      expect(r.maxInputTokens).toBeNull();
    }
  });

  it("carries Anthropic's published Claude Sonnet 5 rates, read 2026-09-17", () => {
    const record = findAiListPriceRecord(
      "anthropic",
      "claude-sonnet-5",
      new Date("2026-10-01T00:00:00Z"),
    );
    expect(record).toMatchObject({
      id: "anthropic/claude-sonnet-5@2026-09-17",
      inputUsdPerMTok: "2.00",
      // Cache hits and refreshes: one rate whatever the write's TTL was.
      cachedInputUsdPerMTok: "0.20",
      outputUsdPerMTok: "10.00",
      sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
    });
    // THE decision this record turns on. Anthropic publishes $2.50 for a
    // 5-minute cache write and $4.00 for a 1-hour one; the adapter maps the
    // FLAT `cache_creation_input_tokens` sum into one dimension, and the
    // per-bucket breakdown that would split them is only conditionally present.
    // One field cannot hold two rates honestly, so it holds neither.
    expect(record!.cacheWriteInputUsdPerMTok).toBeNull();
    // Anthropic prices the full 1M context window at standard rates.
    expect(record!.maxInputTokens).toBeNull();
  });

  it("carries OpenAI's published GPT-5.6 Terra rates, read 2026-09-17", () => {
    const record = findAiListPriceRecord(
      "openai",
      "gpt-5.6-terra",
      new Date("2026-10-01T00:00:00Z"),
    );
    expect(record).toMatchObject({
      id: "openai/gpt-5.6-terra@2026-09-17",
      inputUsdPerMTok: "2.00",
      cachedInputUsdPerMTok: "0.20",
      // OpenAI publishes ONE cache-write rate — 1.25x uncached input — and the
      // Responses API reports the dimension in its own field, so unlike
      // Anthropic this one can be priced truthfully.
      cacheWriteInputUsdPerMTok: "2.50",
      outputUsdPerMTok: "12.00",
      sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
    });
    // The documented long-context threshold: above 272K input tokens OpenAI
    // applies 2x input AND 1.5x output to the whole request, which this
    // four-rate shape cannot express.
    expect(record!.maxInputTokens).toBe(272_000);
  });

  it("gives the two paid models different rates — neither was copied from the other", () => {
    // They happen to share an input and a cached-input rate, which is exactly
    // the coincidence that would hide a copy-paste. Output and cache-write are
    // where they differ, so those are what this pins.
    const sonnet = findAiListPriceRecord(
      "anthropic",
      "claude-sonnet-5",
      new Date("2026-10-01T00:00:00Z"),
    )!;
    const terra = findAiListPriceRecord(
      "openai",
      "gpt-5.6-terra",
      new Date("2026-10-01T00:00:00Z"),
    )!;
    expect(sonnet.outputUsdPerMTok).not.toBe(terra.outputUsdPerMTok);
    expect(sonnet.cacheWriteInputUsdPerMTok).not.toBe(terra.cacheWriteInputUsdPerMTok);
    expect(sonnet.maxInputTokens).not.toBe(terra.maxInputTokens);
    expect(sonnet.sourceUrl).not.toBe(terra.sourceUrl);
  });

  it("is unpriced for either paid model before its rates were verified", () => {
    // A record never predates the day somebody read the page it cites.
    const before = new Date("2026-09-16T23:59:59Z");
    expect(findAiListPriceRecord("anthropic", "claude-sonnet-5", before)).toBeNull();
    expect(findAiListPriceRecord("openai", "gpt-5.6-terra", before)).toBeNull();
  });

  it("prices no paid model PaperLume did not stage", () => {
    // The catalog is the allowlist, and the book must not quietly imply a
    // wider one: a sibling model of either provider has no record here.
    const at = new Date("2026-10-01T00:00:00Z");
    expect(findAiListPriceRecord("anthropic", "claude-opus-5", at)).toBeNull();
    expect(findAiListPriceRecord("anthropic", "claude-sonnet-4-6", at)).toBeNull();
    expect(findAiListPriceRecord("openai", "gpt-5.6", at)).toBeNull();
    expect(findAiListPriceRecord("openai", "gpt-5.6-terra-mini", at)).toBeNull();
  });

  it("never records a free tier as a zero price", () => {
    for (const r of AI_LIST_PRICE_RECORDS) {
      expect(parseRateNanoUsdPerMTok(r.inputUsdPerMTok)).toBeGreaterThan(0n);
      expect(parseRateNanoUsdPerMTok(r.outputUsdPerMTok)).toBeGreaterThan(0n);
    }
  });

  it("leaves the undated 2026→2027 switch unpriced rather than guessing a timezone", () => {
    for (const model of ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"]) {
      const records = AI_LIST_PRICE_RECORDS.filter((r) => r.providerModel === model);
      expect(records.map((r) => [r.validFrom, r.validUntil])).toEqual([
        ["2026-09-13T00:00:00Z", "2026-12-31T10:00:00Z"],
        ["2027-01-01T12:00:00Z", null],
      ]);
    }
  });
});

describe("findAiListPriceRecord", () => {
  it("matches the exact provider and model only — no alias, prefix or case folding", () => {
    const at = new Date("2026-10-01T00:00:00Z");
    expect(findAiListPriceRecord("google", "gemini-3.5-flash", at)?.id).toBe("google/gemini-3.5-flash@2026-09-13");
    for (const model of ["gemini-flash-latest", "gemini-3.5", "Gemini-3.5-Flash", "gemini-3.5-flash ", "models/gemini-3.5-flash"]) {
      expect(findAiListPriceRecord("google", model, at)).toBeNull();
    }
    expect(findAiListPriceRecord("anthropic", "gemini-3.5-flash", at)).toBeNull();
  });

  it("treats validFrom as inclusive and validUntil as exclusive", () => {
    expect(findAiListPriceRecord("google", "gemini-3.6-flash", new Date("2026-09-13T00:00:00Z"))?.id).toBe(
      "google/gemini-3.6-flash@2026-09-13",
    );
    expect(findAiListPriceRecord("google", "gemini-3.6-flash", new Date("2026-12-31T09:59:59.999Z"))?.id).toBe(
      "google/gemini-3.6-flash@2026-09-13",
    );
    expect(findAiListPriceRecord("google", "gemini-3.6-flash", new Date("2026-12-31T10:00:00Z"))).toBeNull();
    expect(findAiListPriceRecord("google", "gemini-3.6-flash", new Date("2027-01-01T12:00:00Z"))?.id).toBe(
      "google/gemini-3.6-flash@2027-01-01",
    );
  });

  it("returns nothing before verification and for an invalid instant", () => {
    expect(findAiListPriceRecord("google", "gemini-3.5-flash", new Date("2026-09-12T23:59:59Z"))).toBeNull();
    expect(findAiListPriceRecord("google", "gemini-3.5-flash", new Date(Number.NaN))).toBeNull();
  });
});

describe("the price book decides nothing", () => {
  it("is imported by the cost estimate and by no routing, selection or credential module", () => {
    const dir = fileURLToPath(new URL("../", import.meta.url));
    for (const file of [
      "aiModelSelection.ts",
      "aiProviderRegistry.ts",
      "aiProviderCredentials.ts",
      "aiReasoningPolicy.ts",
      "googleAiProvider.ts",
      "anthropicAiProvider.ts",
      "openAiProvider.ts",
    ]) {
      expect(readFileSync(`${dir}${file}`, "utf8")).not.toContain("aiPriceBook");
    }
  });
});
