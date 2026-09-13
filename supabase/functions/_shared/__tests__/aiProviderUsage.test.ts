// @vitest-environment node
//
// AI-MULTI-PROVIDER-001D — each adapter's reading of its provider's usage.
//
// Two layers per provider: the pure reader, driven with hand-built payloads
// that follow the provider's documented shapes, and the real adapter, driven
// end to end with an injected `fetch`, to prove usage survives every outcome
// the provider actually answered — including an incomplete generation — and
// that no provider envelope comes back out. No real provider is contacted.
import { describe, it, expect } from "vitest";
import {
  AI_USAGE_INVALID,
  AI_USAGE_MAX_TOKENS,
  AI_USAGE_NOT_RETURNED,
  aiUsageStatus,
  type AiProviderUsage,
  type AiUsageCount,
} from "../aiUsage.ts";
import { GOOGLE_AI_PROVIDER_ADAPTER, readGeminiUsage } from "../googleAiProvider.ts";
import { ANTHROPIC_AI_PROVIDER_ADAPTER, readAnthropicUsage } from "../anthropicAiProvider.ts";
import { OPENAI_AI_PROVIDER_ADAPTER, readOpenAiUsage } from "../openAiProvider.ts";
import type { AiGenerationRequest, AiProviderCallDeps, AiProviderResult } from "../aiProvider.ts";

const REQUEST: AiGenerationRequest = {
  systemInstruction: "SENTINEL-SYSTEM",
  userContent: "SENTINEL-USER-CONTENT",
  responseFormat: "json",
  jsonSchema: { name: "x", schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
};

const R = (tokens: number): AiUsageCount => ({ state: "reported", tokens });
const UNREPORTED: AiUsageCount = { state: "unreported" };
const NA: AiUsageCount = { state: "not_applicable" };

function dims(usage: AiProviderUsage) {
  if (usage.kind !== "reported") throw new Error(`expected reported usage, got ${usage.reason}`);
  return usage.dimensions;
}

function deps(outcome: Response | Error): AiProviderCallDeps {
  return {
    apiKey: "SENTINEL-API-KEY",
    label: "test",
    fetchImpl: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome.clone();
    },
    sleep: async () => undefined,
    createTimeoutSignal: () => new AbortController().signal,
    logger: { warn: () => undefined },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function timeoutError(): Error {
  const error = new Error("The operation timed out.");
  error.name = "TimeoutError";
  return error;
}

/** The invariants every reported usage must satisfy, whichever provider sent it. */
function expectNestingHolds(usage: AiProviderUsage) {
  if (usage.kind !== "reported") return;
  const d = usage.dimensions;
  const n = (c: AiUsageCount) => (c.state === "reported" ? c.tokens : null);
  const input = n(d.inputTokens);
  const cached = n(d.cachedInputTokens) ?? 0;
  const write = n(d.cacheWriteInputTokens) ?? 0;
  if (input !== null) expect(cached + write).toBeLessThanOrEqual(input);
  const output = n(d.outputTokens);
  const reasoning = n(d.reasoningOutputTokens);
  if (output !== null && reasoning !== null) expect(reasoning).toBeLessThanOrEqual(output);
}

/** No provider usage vocabulary may appear in a provider-neutral result. */
function expectNoEnvelope(result: AiProviderResult) {
  const serialized = JSON.stringify(result);
  for (const leak of [
    "usageMetadata",
    "promptTokenCount",
    "candidates",
    "cache_creation_input_tokens",
    "input_tokens_details",
    "output_tokens_details",
    "stop_reason",
    "SENTINEL",
  ]) {
    expect(serialized).not.toContain(leak);
  }
}

// ── Google ────────────────────────────────────────────────────────────────

describe("Google usageMetadata", () => {
  it("maps every dimension, with thoughts counted inside output exactly once", () => {
    const usage = readGeminiUsage({
      usageMetadata: {
        promptTokenCount: 1200,
        cachedContentTokenCount: 300,
        candidatesTokenCount: 150,
        thoughtsTokenCount: 40,
        totalTokenCount: 1390,
      },
    });
    expect(dims(usage)).toEqual({
      inputTokens: R(1200),
      cachedInputTokens: R(300),
      cacheWriteInputTokens: NA,
      outputTokens: R(190),
      reasoningOutputTokens: R(40),
      providerTotalTokens: R(1390),
    });
    expect(aiUsageStatus(usage)).toBe("reported");
    expectNestingHolds(usage);
  });

  it("accepts a total that excludes thoughts — Google's own sources disagree on it", () => {
    const usage = readGeminiUsage({
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 150, thoughtsTokenCount: 40, totalTokenCount: 1350 },
    });
    expect(dims(usage).outputTokens).toEqual(R(190));
    expect(dims(usage).providerTotalTokens).toEqual(R(1350));
  });

  it("reads an omitted proto3 count as a real zero, inside a present usageMetadata", () => {
    const usage = readGeminiUsage({
      usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, totalTokenCount: 520 },
    });
    expect(dims(usage).cachedInputTokens).toEqual(R(0));
    expect(dims(usage).reasoningOutputTokens).toEqual(R(0));
    expect(dims(usage).outputTokens).toEqual(R(20));
  });

  it("records a blocked prompt's input with zero output", () => {
    const usage = readGeminiUsage({ usageMetadata: { promptTokenCount: 80, totalTokenCount: 80 } });
    expect(dims(usage).inputTokens).toEqual(R(80));
    expect(dims(usage).outputTokens).toEqual(R(0));
  });

  it("is no report at all when usageMetadata is missing — never zeros", () => {
    expect(readGeminiUsage({ candidates: [] })).toBe(AI_USAGE_NOT_RETURNED);
    expect(readGeminiUsage({ usageMetadata: null })).toBe(AI_USAGE_NOT_RETURNED);
    expect(readGeminiUsage("not an object")).toBe(AI_USAGE_NOT_RETURNED);
  });

  it("refuses a missing or renamed output count that would otherwise read as a false zero", () => {
    // 120 output tokens exist (the total says so) but not under the field name
    // this reader knows. Reading absence as zero here would under-count; the
    // total check refuses instead.
    expect(
      readGeminiUsage({ usageMetadata: { promptTokenCount: 500, responseTokenCount: 120, totalTokenCount: 620 } }),
    ).toBe(AI_USAGE_INVALID);
  });

  it.each([
    ["an empty usageMetadata", {}],
    ["a zero prompt", { promptTokenCount: 0, totalTokenCount: 10, candidatesTokenCount: 10 }],
    ["a negative count", { promptTokenCount: 10, candidatesTokenCount: -1, totalTokenCount: 9 }],
    ["a string count", { promptTokenCount: "10", totalTokenCount: 10 }],
    ["a fractional count", { promptTokenCount: 10.5, totalTokenCount: 10.5 }],
    ["a count past the bound", { promptTokenCount: AI_USAGE_MAX_TOKENS + 1, totalTokenCount: AI_USAGE_MAX_TOKENS + 1 }],
    ["cached content larger than the prompt", { promptTokenCount: 10, cachedContentTokenCount: 11, totalTokenCount: 10 }],
    ["an inconsistent total", { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 99 }],
  ])("rejects %s", (_label, metadata) => {
    expect(readGeminiUsage({ usageMetadata: metadata })).toBe(AI_USAGE_INVALID);
  });

  it("rejects a usageMetadata that is not an object", () => {
    expect(readGeminiUsage({ usageMetadata: [1, 2] })).toBe(AI_USAGE_INVALID);
    expect(readGeminiUsage({ usageMetadata: "1200" })).toBe(AI_USAGE_INVALID);
  });

  it("flags tool-use prompt tokens as unmodeled — PaperLume sends no tools", () => {
    const usage = readGeminiUsage({
      usageMetadata: { promptTokenCount: 100, toolUsePromptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 110 },
    });
    expect(usage).toMatchObject({ kind: "reported", unmodeledUsage: true });
  });
});

describe("the Google adapter carries usage on every outcome that has it", () => {
  const model = { provider: "google" as const, providerModel: "gemini-3.5-flash" };
  const policy = { reasoning: { kind: "level" as const, level: "minimal" as const }, maxOutputTokens: 4096 };
  const usageMetadata = { promptTokenCount: 900, candidatesTokenCount: 60, totalTokenCount: 960 };

  it("on success", async () => {
    const result = await GOOGLE_AI_PROVIDER_ADAPTER.generate(
      model,
      REQUEST,
      policy,
      deps(json({ candidates: [{ content: { parts: [{ text: '{"tldr":"x"}' }] } }], usageMetadata })),
    );
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(dims(result.usage).inputTokens).toEqual(R(900));
    expectNoEnvelope(result);
  });

  it("on an empty (blocked) answer — the prompt was still processed", async () => {
    const result = await GOOGLE_AI_PROVIDER_ADAPTER.generate(
      model,
      REQUEST,
      policy,
      deps(json({ candidates: [], usageMetadata: { promptTokenCount: 900, totalTokenCount: 900 } })),
    );
    expect(result).toMatchObject({ ok: false, kind: "empty" });
    expect(dims(result.usage).inputTokens).toEqual(R(900));
  });

  it("as no report when the body carried none", async () => {
    const result = await GOOGLE_AI_PROVIDER_ADAPTER.generate(
      model,
      REQUEST,
      policy,
      deps(json({ candidates: [{ content: { parts: [{ text: "{}" }] } }] })),
    );
    expect(result).toMatchObject({ ok: true, usage: AI_USAGE_NOT_RETURNED });
  });

  it.each([
    ["an HTTP error", json({ error: { message: "SENTINEL" } }, 503)],
    ["a network failure", new TypeError("fetch failed")],
    ["a timeout", timeoutError()],
    ["an unreadable 2xx", new Response("<html>SENTINEL</html>", { status: 200 })],
  ])("as unknown — never zero — on %s", async (_label, outcome) => {
    const result = await GOOGLE_AI_PROVIDER_ADAPTER.generate(model, REQUEST, policy, deps(outcome));
    expect(result.ok).toBe(false);
    expect(result.usage).toBe(AI_USAGE_NOT_RETURNED);
    expectNoEnvelope(result);
  });
});

// ── Anthropic ─────────────────────────────────────────────────────────────

describe("Anthropic usage", () => {
  it("sums the three documented input classes into one total, and keeps them apart", () => {
    // Anthropic's own worked example: a cache write, then a cache read.
    const write = readAnthropicUsage({
      usage: { input_tokens: 15, cache_creation_input_tokens: 3546, cache_read_input_tokens: 0, output_tokens: 1033 },
    });
    expect(dims(write)).toMatchObject({
      inputTokens: R(3561),
      cachedInputTokens: R(0),
      cacheWriteInputTokens: R(3546),
      outputTokens: R(1033),
      providerTotalTokens: NA,
    });
    const read = readAnthropicUsage({
      usage: { input_tokens: 1062, cache_creation_input_tokens: 0, cache_read_input_tokens: 3546, output_tokens: 1630 },
    });
    expect(dims(read)).toMatchObject({ inputTokens: R(4608), cachedInputTokens: R(3546), cacheWriteInputTokens: R(0) });
    expectNestingHolds(write);
    expectNestingHolds(read);
  });

  it("takes output_tokens as the inclusive billed total and thinking as a subset of it", () => {
    const usage = readAnthropicUsage({
      usage: {
        input_tokens: 25,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 348,
        output_tokens_details: { thinking_tokens: 312 },
      },
    });
    expect(dims(usage)).toMatchObject({ outputTokens: R(348), reasoningOutputTokens: R(312) });
    expect(aiUsageStatus(usage)).toBe("reported");
  });

  it("leaves thinking unreported, not zero, when no breakdown is given", () => {
    const usage = readAnthropicUsage({
      usage: { input_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 30 },
    });
    expect(dims(usage).reasoningOutputTokens).toEqual(UNREPORTED);
    expect(aiUsageStatus(usage)).toBe("partial");
  });

  it.each([["absent", undefined], ["null", null]])(
    "leaves the input total unknown when the cache counts are %s — absence is not zero here",
    (_label, value) => {
      const usage = readAnthropicUsage({
        usage: { input_tokens: 25, cache_creation_input_tokens: value, cache_read_input_tokens: value, output_tokens: 30 },
      });
      expect(dims(usage)).toMatchObject({
        inputTokens: UNREPORTED,
        cachedInputTokens: UNREPORTED,
        cacheWriteInputTokens: UNREPORTED,
        outputTokens: R(30),
      });
    },
  );

  it("flags a 1-hour cache write as unmodeled, and a 5-minute one as modeled", () => {
    const base = { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 };
    const oneHour = readAnthropicUsage({
      usage: { ...base, cache_creation_input_tokens: 248, cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 } },
    });
    expect(oneHour).toMatchObject({ kind: "reported", unmodeledUsage: true });
    const fiveMinute = readAnthropicUsage({
      usage: { ...base, cache_creation_input_tokens: 148, cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 0 } },
    });
    expect(fiveMinute).toMatchObject({ kind: "reported", unmodeledUsage: false });
  });

  it("flags a server-side tool use as unmodeled — PaperLume sends no tools", () => {
    const usage = readAnthropicUsage({
      usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1, server_tool_use: { web_search_requests: 1 } },
    });
    expect(usage).toMatchObject({ unmodeledUsage: true });
  });

  it("is no report when usage is missing", () => {
    expect(readAnthropicUsage({ content: [] })).toBe(AI_USAGE_NOT_RETURNED);
    expect(readAnthropicUsage({ usage: null })).toBe(AI_USAGE_NOT_RETURNED);
  });

  it.each([
    ["usage that is not an object", "900"],
    ["a string count", { input_tokens: "900", output_tokens: 1 }],
    ["a negative count", { input_tokens: -1, output_tokens: 1 }],
    ["thinking larger than output", { input_tokens: 1, output_tokens: 10, output_tokens_details: { thinking_tokens: 11 } }],
    ["a non-object breakdown", { input_tokens: 1, output_tokens: 1, output_tokens_details: 5 }],
    ["a malformed cache bucket", { input_tokens: 1, output_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: -3 } }],
  ])("rejects %s", (_label, usage) => {
    expect(readAnthropicUsage({ usage })).toBe(AI_USAGE_INVALID);
  });
});

describe("the Anthropic adapter carries usage on every outcome that has it", () => {
  const model = { provider: "anthropic" as const, providerModel: "claude-sonnet-5" };
  const policy = { reasoning: { kind: "level" as const, level: "medium" as const }, maxOutputTokens: 4096 };
  const usage = { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4096 };

  it("on success", async () => {
    const result = await ANTHROPIC_AI_PROVIDER_ADAPTER.generate(
      model,
      REQUEST,
      policy,
      deps(json({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { ...usage, output_tokens: 20 } })),
    );
    expect(result).toMatchObject({ ok: true });
    expect(dims(result.usage).outputTokens).toEqual(R(20));
    expectNoEnvelope(result);
  });

  it.each([["max_tokens"], ["refusal"]])(
    "on an incomplete generation (stop_reason %s) — the truncated work was billed",
    async (stopReason) => {
      const result = await ANTHROPIC_AI_PROVIDER_ADAPTER.generate(
        model,
        REQUEST,
        policy,
        deps(json({ content: [{ type: "text", text: '{"tldr":' }], stop_reason: stopReason, usage })),
      );
      expect(result).toMatchObject({ ok: false, kind: "incomplete_response" });
      expect(dims(result.usage)).toMatchObject({ inputTokens: R(400), outputTokens: R(4096) });
      expectNoEnvelope(result);
    },
  );

  it.each([
    ["an HTTP error", json({ error: { message: "SENTINEL" } }, 429)],
    ["a timeout", timeoutError()],
    ["an envelope without stop_reason", json({ content: [], usage })],
  ])("as unknown on %s", async (_label, outcome) => {
    const result = await ANTHROPIC_AI_PROVIDER_ADAPTER.generate(model, REQUEST, policy, deps(outcome));
    expect(result.ok).toBe(false);
    expect(result.usage).toBe(AI_USAGE_NOT_RETURNED);
  });
});

// ── OpenAI ────────────────────────────────────────────────────────────────

describe("OpenAI Responses usage", () => {
  it("keeps reasoning inside output, never adds it", () => {
    // OpenAI's own reasoning-guide example: 75 + 1186 = 1261, with 1024 of the
    // 1186 output tokens being reasoning.
    const usage = readOpenAiUsage({
      usage: {
        input_tokens: 75,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1186,
        output_tokens_details: { reasoning_tokens: 1024 },
        total_tokens: 1261,
      },
    });
    expect(dims(usage)).toEqual({
      inputTokens: R(75),
      cachedInputTokens: R(0),
      cacheWriteInputTokens: UNREPORTED,
      outputTokens: R(1186),
      reasoningOutputTokens: R(1024),
      providerTotalTokens: R(1261),
    });
    expectNestingHolds(usage);
  });

  it("maps cached and cache-write input as disjoint subsets", () => {
    const usage = readOpenAiUsage({
      usage: {
        input_tokens: 1500,
        input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 200 },
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 1510,
      },
    });
    expect(dims(usage)).toMatchObject({ cachedInputTokens: R(1000), cacheWriteInputTokens: R(200) });
    expect(aiUsageStatus(usage)).toBe("reported");
  });

  it("leaves a missing breakdown unreported rather than zero", () => {
    const usage = readOpenAiUsage({ usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
    expect(dims(usage)).toMatchObject({
      cachedInputTokens: UNREPORTED,
      cacheWriteInputTokens: UNREPORTED,
      reasoningOutputTokens: UNREPORTED,
    });
    expect(aiUsageStatus(usage)).toBe("partial");
  });

  it("is no report when usage is missing or null", () => {
    expect(readOpenAiUsage({ output: [] })).toBe(AI_USAGE_NOT_RETURNED);
    expect(readOpenAiUsage({ usage: null })).toBe(AI_USAGE_NOT_RETURNED);
  });

  it.each([
    ["cache reads and writes exceeding input", { input_tokens: 10, input_tokens_details: { cached_tokens: 6, cache_write_tokens: 5 }, output_tokens: 1 }],
    ["reasoning exceeding output", { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 6 } }],
    ["a string count", { input_tokens: 10, output_tokens: "5" }],
    ["an array breakdown", { input_tokens: 10, output_tokens: 5, input_tokens_details: [1] }],
    ["usage that is not an object", 42],
  ])("rejects %s", (_label, usage) => {
    expect(readOpenAiUsage({ usage })).toBe(AI_USAGE_INVALID);
  });
});

describe("the OpenAI adapter carries usage on every outcome that has it", () => {
  const model = { provider: "openai" as const, providerModel: "gpt-5.6-terra" };
  const policy = { reasoning: { kind: "level" as const, level: "medium" as const }, maxOutputTokens: 4096 };
  const usage = {
    input_tokens: 300,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 4096,
    output_tokens_details: { reasoning_tokens: 4096 },
    total_tokens: 4396,
  };
  const message = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });

  it("on success", async () => {
    const result = await OPENAI_AI_PROVIDER_ADAPTER.generate(
      model,
      REQUEST,
      policy,
      deps(json({ status: "completed", output: [message("{}")], usage })),
    );
    expect(result).toMatchObject({ ok: true });
    expect(dims(result.usage).reasoningOutputTokens).toEqual(R(4096));
    expectNoEnvelope(result);
  });

  it("on an incomplete response — reasoning can exhaust the ceiling before any text", async () => {
    const result = await OPENAI_AI_PROVIDER_ADAPTER.generate(
      model,
      REQUEST,
      policy,
      deps(json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage })),
    );
    expect(result).toMatchObject({ ok: false, kind: "incomplete_response" });
    expect(dims(result.usage)).toMatchObject({ inputTokens: R(300), outputTokens: R(4096) });
    expectNoEnvelope(result);
  });

  it("on a completed response that carried only a refusal", async () => {
    const result = await OPENAI_AI_PROVIDER_ADAPTER.generate(
      model,
      REQUEST,
      policy,
      deps(json({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], usage })),
    );
    expect(result).toMatchObject({ ok: false, kind: "empty" });
    expect(result.usage.kind).toBe("reported");
  });

  it.each([
    ["a network failure", new TypeError("fetch failed")],
    ["an HTTP error", json({ error: { message: "SENTINEL" } }, 500)],
  ])("as unknown on %s", async (_label, outcome) => {
    const result = await OPENAI_AI_PROVIDER_ADAPTER.generate(model, REQUEST, policy, deps(outcome));
    expect(result.usage).toBe(AI_USAGE_NOT_RETURNED);
  });
});
