// @vitest-environment node
//
// Node, not jsdom: the adapter runs in Deno and uses the platform web APIs Deno
// provides (`Request`, `Response`, `AbortSignal.timeout` through the transport).
// jsdom does not implement all of them, so under the project's default
// environment these assertions would be measuring jsdom rather than this module.
//
// AI-MULTI-PROVIDER-001A — the Google (Gemini) provider adapter.
//
// This is the ONE module allowed to know Gemini, so this suite is where the
// wire contract is pinned: the exact URL, the exact method, the exact headers,
// the exact request envelope, the exact JSON response mode, and the exact
// reading of the response envelope. It is also where the boundary is enforced
// in the other direction — nothing provider-shaped may come back out.
//
// No network: `fetchImpl` is injected everywhere, and one test proves the
// adapter never reaches for a global `fetch`.
import { describe, it, expect, vi } from "vitest";
import {
  buildGeminiGenerateContentUrl,
  buildGeminiRequestBody,
  buildGeminiRequestInit,
  extractGeminiText,
  GOOGLE_AI_PROVIDER,
  GOOGLE_AI_PROVIDER_ADAPTER,
  type GoogleAiProviderModel,
} from "../googleAiProvider.ts";
import {
  GEMINI_PROVIDER_MAX_RETRIES,
  GEMINI_PROVIDER_TIMEOUT_MS,
} from "../geminiTransport.ts";
import type {
  AiCallPolicy,
  AiGenerationRequest,
  AiProviderCallDeps,
} from "../aiProvider.ts";
import type { GoogleReasoningLevel } from "../googleAiProvider.ts";

// Sentinels: if any of these ever reaches a log line or a returned result, the
// assertion fails on the literal string rather than on a shape.
const API_KEY = "SENTINEL-GEMINI-API-KEY";
const SYSTEM_INSTRUCTION = "SENTINEL-SYSTEM-INSTRUCTION: you are a test.";
const USER_CONTENT = "SENTINEL-USER-CONTENT: a paper title and abstract.";
// Typed as a Google model: the adapter accepts nothing wider (C39).
const MODEL: GoogleAiProviderModel = {
  provider: GOOGLE_AI_PROVIDER,
  providerModel: "gemini-3.5-flash",
};

// A schema the Google adapter must IGNORE. AI-MULTI-PROVIDER-001B added
// `jsonSchema` to the provider-neutral request for the Anthropic and OpenAI
// structured-output APIs; Gemini keeps its `responseMimeType` behaviour, and
// the sentinel below is how the suite proves the schema never reaches the wire.
const SCHEMA_SENTINEL = "SENTINEL-JSON-SCHEMA-PROPERTY";
const REQUEST: AiGenerationRequest = {
  systemInstruction: SYSTEM_INSTRUCTION,
  userContent: USER_CONTENT,
  responseFormat: "json",
  jsonSchema: {
    name: "SENTINEL-JSON-SCHEMA-NAME",
    schema: {
      type: "object",
      properties: { [SCHEMA_SENTINEL]: { type: "string" } },
      required: [SCHEMA_SENTINEL],
      additionalProperties: false,
    },
  },
};

interface Harness {
  deps: AiProviderCallDeps;
  fetchImpl: ReturnType<typeof vi.fn>;
  warns: string[];
  sleeps: number[];
  signalTimeouts: number[];
}

function makeHarness(outcomes: Array<Response | Error>): Harness {
  const warns: string[] = [];
  const sleeps: number[] = [];
  const signalTimeouts: number[] = [];
  const queue = [...outcomes];

  const fetchImpl = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("no provider outcome configured");
    if (next instanceof Error) throw next;
    return next.clone();
  });

  return {
    deps: {
      apiKey: API_KEY,
      label: "test-op",
      fetchImpl: fetchImpl as unknown as AiProviderCallDeps["fetchImpl"],
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      createTimeoutSignal: (ms: number) => {
        signalTimeouts.push(ms);
        return new AbortController().signal;
      },
      logger: { warn: (m: string) => warns.push(m) },
    },
    fetchImpl,
    warns,
    sleeps,
    signalTimeouts,
  };
}

/** A Gemini `generateContent` success envelope carrying `text`. */
function geminiOk(text: string): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// AI-MULTI-PROVIDER-001D. Every result carries `usage`. A failure that produced no
// readable body — and any envelope without a usage block — carries this: unknown,
// never zero.
const NO_USAGE = { kind: "unavailable", reason: "not_returned" } as const;

/**
 * The default call policy for these tests — AI-MULTI-PROVIDER-001C.
 *
 * `medium` is deliberately NOT special: it is Gemini's own default level, so a
 * test that asserted the request while sending `medium` and a test that
 * asserted it while sending nothing would look identical on the wire if the
 * adapter quietly stopped sending the field. Every reasoning assertion below
 * therefore names its level explicitly, and the provider-default case is
 * exercised separately.
 *
 * `maxOutputTokens` is carried and deliberately never expected in the body —
 * see the dedicated test.
 */
const POLICY: AiCallPolicy<GoogleReasoningLevel> = {
  reasoning: { kind: "level", level: "medium" },
  maxOutputTokens: 4096,
};

const PROVIDER_DEFAULT_POLICY: AiCallPolicy<GoogleReasoningLevel> = {
  reasoning: { kind: "provider_default" },
  maxOutputTokens: 4096,
};

const generate = (
  harness: Harness,
  request: AiGenerationRequest = REQUEST,
  model = MODEL,
  policy: AiCallPolicy<GoogleReasoningLevel> = POLICY,
) => GOOGLE_AI_PROVIDER_ADAPTER.generate(model, request, policy, harness.deps);

// ── 1. The wire contract ──────────────────────────────────────────────────

describe("the request that reaches Google", () => {
  it("names the provider it implements", () => {
    expect(GOOGLE_AI_PROVIDER_ADAPTER.provider).toBe("google");
    expect(GOOGLE_AI_PROVIDER).toBe("google");
  });

  it.each([
    ["gemini-flash-latest"],
    ["gemini-3.5-flash"],
    ["gemini-3.6-flash"],
    ["gemini-3.7-flash"],
    ["gemini-3.8-flash"],
    ["gemini-future-unheard-of"],
  ])("POSTs to the exact generateContent URL for %s", async (providerModel) => {
    const harness = makeHarness([geminiOk("{}")]);
    await generate(harness, REQUEST, { provider: GOOGLE_AI_PROVIDER, providerModel });
    expect(harness.fetchImpl.mock.calls[0][0]).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${providerModel}:generateContent`,
    );
  });

  it("swaps ONLY the model component between two models", () => {
    const a = buildGeminiGenerateContentUrl({ provider: "google", providerModel: "model-a" });
    const b = buildGeminiGenerateContentUrl({ provider: "google", providerModel: "model-b" });
    expect(a.replace("model-a", "M")).toBe(b.replace("model-b", "M"));
    expect(a.startsWith("https://generativelanguage.googleapis.com/v1beta/models/")).toBe(true);
    expect(a.endsWith(":generateContent")).toBe(true);
  });

  it("sends POST with exactly two headers: JSON content type and the API key", async () => {
    const harness = makeHarness([geminiOk("{}")]);
    await generate(harness);
    const init = harness.fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["Content-Type", "x-goog-api-key"]);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-goog-api-key"]).toBe(API_KEY);
    // The credential travels in the header and nowhere else.
    expect(String(harness.fetchImpl.mock.calls[0][0])).not.toContain(API_KEY);
    expect(String(init.body)).not.toContain(API_KEY);
  });

  it("sends the Gemini envelope with the two prompt strings and JSON response mode", async () => {
    const harness = makeHarness([geminiOk("{}")]);
    await generate(harness);
    const body = JSON.parse(String((harness.fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({
      system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ parts: [{ text: USER_CONTENT }] }],
      generationConfig: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: "medium" },
      },
    });
  });

  it("serializes the envelope in the historical key order, byte for byte", () => {
    // The exact string that goes on the wire, not a deep-equal of a parse.
    expect(buildGeminiRequestInit(REQUEST, POLICY, API_KEY).body).toBe(
      `{"system_instruction":{"parts":[{"text":${JSON.stringify(SYSTEM_INSTRUCTION)}}]},` +
        `"contents":[{"parts":[{"text":${JSON.stringify(USER_CONTENT)}}]}],` +
        `"generationConfig":{"responseMimeType":"application/json",` +
        `"thinkingConfig":{"thinkingLevel":"medium"}}}`,
    );
  });

  it("pins JSON response mode and sets no sampling override of any kind", () => {
    const generationConfig = buildGeminiRequestBody(REQUEST, POLICY).generationConfig as Record<
      string,
      unknown
    >;
    expect(generationConfig).toEqual({
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: "medium" },
    });
    // `toEqual` above already forbids extras; named explicitly because these
    // are the knobs AI-PROVIDER-REQUEST-CONTRACT-001A removed.
    for (const key of ["temperature", "topP", "topK", "top_p", "top_k", "seed", "candidateCount"]) {
      expect(generationConfig).not.toHaveProperty(key);
    }
    // The LEGACY numeric control, named explicitly: `thinkingBudget` is the
    // Gemini 2.5-era parameter, Google documents sending it alongside
    // `thinkingLevel` as a 400, and a numeric budget would be a second
    // expression of a policy the catalog already states in words.
    for (const key of ["thinkingBudget", "thinking_budget", "maxOutputTokens"]) {
      expect(generationConfig).not.toHaveProperty(key);
    }
    expect(generationConfig.thinkingConfig).not.toHaveProperty("thinkingBudget");
    expect(generationConfig.thinkingConfig).not.toHaveProperty("includeThoughts");
  });

  it("ignores the operation's JSON schema entirely — AI-MULTI-PROVIDER-001B", async () => {
    // Google's structured-output story is `responseMimeType`, and 001B did not
    // change it. The schema exists for the Anthropic and OpenAI adapters; if it
    // ever leaked into Gemini's envelope, the golden request hash in
    // `analyze-paper/__tests__/geminiRequestGolden.test.ts` would move and
    // PaperLume's live provider request would have changed under a task that
    // promised it would not.
    const body = buildGeminiRequestBody(REQUEST, POLICY);
    expect(body).not.toHaveProperty("output_config");
    expect(body).not.toHaveProperty("text");
    expect(body).not.toHaveProperty("jsonSchema");
    expect(JSON.stringify(body)).not.toContain(SCHEMA_SENTINEL);
    expect(JSON.stringify(body)).not.toContain("SENTINEL-JSON-SCHEMA-NAME");
    expect(JSON.stringify(body)).not.toContain("json_schema");

    // And the same, measured on the bytes that actually reach the transport.
    const harness = makeHarness([geminiOk("{}")]);
    await generate(harness);
    const [url, init] = harness.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).not.toContain(SCHEMA_SENTINEL);
    expect(String(init.body)).not.toContain("SENTINEL-JSON-SCHEMA-NAME");
    expect(url).not.toContain(SCHEMA_SENTINEL);
  });

  it("builds the same bytes with or without a schema on the request", () => {
    // The strongest form of "ignores": a request carrying a schema and one that
    // could not carry one serialize identically.
    const withSchema = buildGeminiRequestInit(REQUEST, POLICY, API_KEY).body;
    const withOther = buildGeminiRequestInit(
      { ...REQUEST, jsonSchema: { name: "other", schema: { type: "object" } } },
      POLICY,
      API_KEY,
    ).body;
    expect(withSchema).toBe(withOther);
  });

  // ── PaperLume's explicit reasoning level — AI-MULTI-PROVIDER-001C (C41) ──

  it.each([
    ["minimal"],
    ["low"],
    ["medium"],
    ["high"],
  ] as const)("sends thinkingLevel %s at generationConfig.thinkingConfig", async (level) => {
    const harness = makeHarness([geminiOk("{}")]);
    await generate(harness, REQUEST, MODEL, {
      reasoning: { kind: "level", level },
      maxOutputTokens: 4096,
    });
    const body = JSON.parse(String((harness.fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: level });
    // Lowercase on the wire, exactly as Google's REST examples show, and
    // exactly PaperLume's own canonical spelling — there is no translation.
    expect(String((harness.fetchImpl.mock.calls[0][1] as RequestInit).body)).toContain(
      `"thinkingLevel":"${level}"`,
    );
  });

  it("declares exactly the four levels Gemini accepts, in Google's order", () => {
    expect(GOOGLE_AI_PROVIDER_ADAPTER.reasoningLevels).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("refuses every canonical level Gemini does not have", () => {
    for (const level of ["off", "none", "xhigh", "max"] as const) {
      expect(GOOGLE_AI_PROVIDER_ADAPTER.supportsReasoningLevel(level)).toBe(false);
    }
    for (const level of ["minimal", "low", "medium", "high"] as const) {
      expect(GOOGLE_AI_PROVIDER_ADAPTER.supportsReasoningLevel(level)).toBe(true);
    }
  });

  it("omits thinkingConfig ENTIRELY on the provider-default fallback", async () => {
    // The fail-open path for unusable policy metadata. It must produce exactly
    // the request PaperLume sent before 001C — not a null, not an empty object,
    // not a third shape — so a metadata outage degrades to the previously
    // shipped behaviour and nothing else.
    const harness = makeHarness([geminiOk("{}")]);
    await generate(harness, REQUEST, MODEL, PROVIDER_DEFAULT_POLICY);
    const raw = String((harness.fetchImpl.mock.calls[0][1] as RequestInit).body);
    expect(raw).toBe(
      `{"system_instruction":{"parts":[{"text":${JSON.stringify(SYSTEM_INSTRUCTION)}}]},` +
        `"contents":[{"parts":[{"text":${JSON.stringify(USER_CONTENT)}}]}],` +
        `"generationConfig":{"responseMimeType":"application/json"}}`,
    );
    expect(raw).not.toContain("thinking");
  });

  it("never sends PaperLume's output ceiling to Google", () => {
    // 001C deliberately leaves Gemini's output limit exactly where it has always
    // been: unstated by PaperLume. The policy still CARRIES a ceiling, because
    // the type is provider-neutral and the paid adapters need it — this proves
    // the Google adapter does not act on it.
    for (const maxOutputTokens of [1, 4096, 8192, 65536]) {
      const body = buildGeminiRequestBody(REQUEST, {
        reasoning: { kind: "level", level: "low" },
        maxOutputTokens,
      });
      const generationConfig = body.generationConfig as Record<string, unknown>;
      expect(generationConfig).not.toHaveProperty("maxOutputTokens");
      expect(generationConfig).not.toHaveProperty("max_output_tokens");
      expect(JSON.stringify(body)).not.toContain(String(maxOutputTokens));
    }
  });

  it("changes NOTHING but thinkingConfig between two reasoning levels", () => {
    // The 001C claim, measured: the only delta in the bytes is the level.
    const low = String(buildGeminiRequestInit(REQUEST, {
      reasoning: { kind: "level", level: "low" },
      maxOutputTokens: 4096,
    }, API_KEY).body);
    const high = String(buildGeminiRequestInit(REQUEST, {
      reasoning: { kind: "level", level: "high" },
      maxOutputTokens: 4096,
    }, API_KEY).body);
    expect(low.replace('"thinkingLevel":"low"', "X")).toBe(
      high.replace('"thinkingLevel":"high"', "X"),
    );
  });

  it("adds nothing of its own to the prompt strings", () => {
    const body = buildGeminiRequestBody(REQUEST, POLICY);
    const contents = body.contents as Array<{ parts: Array<{ text: string }> }>;
    const system = body.system_instruction as { parts: Array<{ text: string }> };
    expect(system.parts).toHaveLength(1);
    expect(system.parts[0].text).toBe(SYSTEM_INSTRUCTION);
    expect(contents).toHaveLength(1);
    expect(contents[0].parts).toHaveLength(1);
    expect(contents[0].parts[0].text).toBe(USER_CONTENT);
  });

  it("uses only the injected fetch, never a global one", async () => {
    const globalFetch = vi.fn(() => {
      throw new Error("the adapter reached for a global fetch");
    });
    vi.stubGlobal("fetch", globalFetch);
    try {
      const harness = makeHarness([geminiOk("{}")]);
      const result = await generate(harness);
      expect(result.ok).toBe(true);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── 2. Reading the response envelope ──────────────────────────────────────

describe("extracting the generated text", () => {
  it("returns the model's text from a well-formed envelope", async () => {
    const harness = makeHarness([geminiOk('{"tldr":"x"}')]);
    expect(await generate(harness)).toEqual({ ok: true, text: '{"tldr":"x"}', attempts: 1, usage: NO_USAGE });
  });

  it("returns the text exactly as sent — no trimming, unwrapping or repair", async () => {
    const fenced = '```json\n{"a":1}\n```';
    const harness = makeHarness([geminiOk(fenced)]);
    const result = await generate(harness);
    expect(result).toMatchObject({ ok: true, text: fenced });
  });

  it("hands back whitespace-only text rather than judging it empty", async () => {
    // "is this answer usable?" is the operation's call, and the two operations
    // answer it differently today. The adapter answers only "did the provider
    // return generated text?".
    const harness = makeHarness([geminiOk("   ")]);
    expect(await generate(harness)).toEqual({ ok: true, text: "   ", attempts: 1, usage: NO_USAGE });
  });

  it.each([
    ["a non-object payload", '"nope"'],
    ["a missing candidate list", "{}"],
    ["an empty candidate list", '{"candidates":[]}'],
    ["a candidate with no content", '{"candidates":[{}]}'],
    ["a blocked candidate", '{"candidates":[{"finishReason":"SAFETY"}]}'],
    ["a candidate with no parts", '{"candidates":[{"content":{}}]}'],
    ["an empty parts array", '{"candidates":[{"content":{"parts":[]}}]}'],
    ["a non-string text", '{"candidates":[{"content":{"parts":[{"text":5}]}}]}'],
    ["an empty-string text", '{"candidates":[{"content":{"parts":[{"text":""}]}}]}'],
    ["a part with no text", '{"candidates":[{"content":{"parts":[{"thought":true}]}}]}'],
    ["a null payload", "null"],
  ])("reports %s as empty", async (_label, body) => {
    const harness = makeHarness([new Response(body, { status: 200 })]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "empty", attempts: 1, usage: NO_USAGE });
  });

  it("reads only the first candidate and the first part, as it always has", () => {
    expect(
      extractGeminiText({
        candidates: [
          { content: { parts: [{ text: "first" }, { text: "second" }] } },
          { content: { parts: [{ text: "other candidate" }] } },
        ],
      }),
    ).toBe("first");
  });

  it("reports a 2xx whose body is not JSON as unreadable, not as empty", async () => {
    // Distinct kinds because the two operations classify them differently, and
    // 001A preserves both classifications exactly.
    const harness = makeHarness([new Response("<html>not json</html>", { status: 200 })]);
    expect(await generate(harness)).toEqual({
      ok: false,
      kind: "unreadable_response",
      attempts: 1,
      usage: NO_USAGE,
    });
  });
});

// ── 3. Normalizing failure ────────────────────────────────────────────────

describe("normalizing a provider failure", () => {
  it.each([400, 401, 403, 404, 429, 500, 503])("carries the status of an HTTP %d", async (status) => {
    const harness = makeHarness([new Response("provider error body", { status })]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "http", status, attempts: 1, usage: NO_USAGE });
  });

  it("normalizes a network failure", async () => {
    const harness = makeHarness([new Error("connection reset")]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "network", attempts: 1, usage: NO_USAGE });
  });

  it("normalizes a timeout, and keeps it distinct from a network failure", async () => {
    const harness = makeHarness([
      Object.assign(new Error("Signal timed out."), { name: "TimeoutError" }),
    ]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "timeout", attempts: 1, usage: NO_USAGE });
  });

  it("never throws, whatever the provider does", async () => {
    for (const outcome of [
      new Response("", { status: 500 }),
      new Response("not json", { status: 200 }),
      new Error("boom"),
      Object.assign(new Error("t"), { name: "TimeoutError" }),
    ]) {
      const result = await generate(makeHarness([outcome]));
      expect(result.ok).toBe(false);
    }
  });

  it("propagates the attempt count the transport reports", async () => {
    const harness = makeHarness([geminiOk("{}")]);
    const result = await generate(harness);
    expect(result.attempts).toBe(GEMINI_PROVIDER_MAX_RETRIES + 1);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("inherits the shared transport policy rather than pinning its own", async () => {
    // TEMPORARY, per AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A: 90 s, zero retries.
    // What this really asserts is that the adapter takes WHATEVER the shared
    // constants are, so it moves with them in both directions.
    const harness = makeHarness([new Response("", { status: 503 }), geminiOk("{}")]);
    await generate(harness);
    expect(harness.signalTimeouts).toEqual([GEMINI_PROVIDER_TIMEOUT_MS]);
    expect(harness.signalTimeouts).toEqual([90_000]);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
  });
});

// ── 4. The boundary holds in the outward direction ────────────────────────

describe("nothing provider-shaped escapes the adapter", () => {
  const PROVIDER_BODY = "Google says: project 12345 quota exhausted for model X";

  it("returns no provider body, header, URL or envelope on failure", async () => {
    for (const outcome of [
      new Response(PROVIDER_BODY, { status: 429 }),
      new Response(`<html>${PROVIDER_BODY}</html>`, { status: 200 }),
      new Response(JSON.stringify({ error: { message: PROVIDER_BODY } }), { status: 200 }),
    ]) {
      const result = await generate(makeHarness([outcome]));
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("Google says");
      expect(serialized).not.toContain("project 12345");
      expect(serialized).not.toContain("generativelanguage");
      expect(serialized).not.toContain(API_KEY);
      // Only the bounded fields the contract names.
      expect(Object.keys(result).sort()).toEqual(
        result.ok ? ["attempts", "ok", "text", "usage"] : expect.arrayContaining(["attempts", "kind", "ok", "usage"]),
      );
    }
  });

  it("logs no key, prompt, paper content, URL or provider body", async () => {
    for (const outcome of [
      new Response(PROVIDER_BODY, { status: 429 }),
      new Response(PROVIDER_BODY, { status: 503 }),
      new Error("connection reset"),
      Object.assign(new Error("t"), { name: "TimeoutError" }),
      new Response("<html>not json</html>", { status: 200 }),
      geminiOk("SENTINEL-GENERATED-ANSWER"),
    ]) {
      const harness = makeHarness([outcome]);
      await generate(harness);
      const logged = harness.warns.join("\n");
      for (const secret of [
        API_KEY,
        SYSTEM_INSTRUCTION,
        USER_CONTENT,
        "SENTINEL-GENERATED-ANSWER",
        "Google says",
        "project 12345",
        "generativelanguage.googleapis.com",
        "x-goog-api-key",
      ]) {
        expect(logged).not.toContain(secret);
      }
    }
  });

  it("is silent when no logger is supplied", async () => {
    const harness = makeHarness([geminiOk("{}")]);
    const result = await GOOGLE_AI_PROVIDER_ADAPTER.generate(MODEL, REQUEST, POLICY, {
      ...harness.deps,
      logger: undefined,
    });
    expect(result.ok).toBe(true);
  });

  it("keeps operation semantics out: it returns text, never a parsed product shape", async () => {
    // The adapter must not learn what a TLDR, a study type, a Project or a Tag
    // is — the operations' own parsers own that.
    const harness = makeHarness([geminiOk('{"tldr":"t","studyType":"s","statisticalMethods":"m"}')]);
    const result = await generate(harness);
    expect(result).toEqual({
      ok: true,
      text: '{"tldr":"t","studyType":"s","statisticalMethods":"m"}',
      attempts: 1,
      usage: NO_USAGE,
    });
  });
});
