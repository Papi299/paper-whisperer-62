// @vitest-environment node
//
// Node, not jsdom: the adapter runs in Deno and uses the platform web APIs Deno
// provides (`Response`, `AbortSignal.timeout`). jsdom does not implement all of
// them, so under the project's default environment these assertions would be
// measuring jsdom rather than this module.
//
// AI-MULTI-PROVIDER-001B — the Anthropic (Claude Messages API) provider adapter.
//
// This is the ONE module allowed to know Anthropic, so this suite is where the
// wire contract is pinned: the exact URL, the exact method, the exact headers,
// the exact request envelope, the exact structured-output vocabulary, and the
// exact reading of the response envelope. It is also where the boundary is
// enforced in the other direction — nothing provider-shaped may come back out.
//
// TWO things this suite exists to keep true, beyond the protocol:
//
//   * The adapter is NOT REGISTERED. `aiProviderRegistry.test.ts` proves that
//     from the registry's side. Nothing here needs a registry entry: the module
//     is imported directly, which is the whole reason an unregistered adapter
//     can be reviewed this thoroughly before anyone can reach it.
//   * Reading `content[0]` is wrong. Claude Sonnet 5 runs adaptive thinking by
//     DEFAULT, so `thinking` blocks can precede the first `text` block today,
//     and AI-MULTI-PROVIDER-001C may deliberately turn thinking on for Suggest.
//     The extraction tests below are written against that future.
//
// No network: `fetchImpl` is injected everywhere, and one test proves the
// adapter never reaches for a global `fetch`. No real API key exists, is
// needed, or is used.
import { describe, it, expect, vi } from "vitest";
import {
  ANTHROPIC_AI_PROVIDER,
  ANTHROPIC_AI_PROVIDER_ADAPTER,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_PROVIDER_ATTEMPTS,
  ANTHROPIC_PROVIDER_TIMEOUT_MS,
  ANTHROPIC_PROVISIONAL_MAX_TOKENS,
  ANTHROPIC_VERSION,
  buildAnthropicRequestBody,
  buildAnthropicRequestInit,
  extractAnthropicText,
  type AnthropicAiProviderModel,
} from "../anthropicAiProvider.ts";
import { GEMINI_PROVIDER_TIMEOUT_MS } from "../geminiTransport.ts";
import type { AiGenerationRequest, AiProviderCallDeps } from "../aiProvider.ts";

// Sentinels: if any of these ever reaches a log line or a returned result, the
// assertion fails on the literal string rather than on a shape.
const API_KEY = "SENTINEL-ANTHROPIC-API-KEY";
const SYSTEM_INSTRUCTION = "SENTINEL-SYSTEM-INSTRUCTION: you are a test.";
const USER_CONTENT = "SENTINEL-USER-CONTENT: a paper title and abstract.";
const SCHEMA_NAME = "SENTINEL-SCHEMA-NAME";
const SCHEMA_PROPERTY = "SENTINEL_SCHEMA_PROPERTY";

// Typed as an Anthropic model: the adapter accepts nothing wider (C39).
const MODEL: AnthropicAiProviderModel = {
  provider: ANTHROPIC_AI_PROVIDER,
  providerModel: "claude-sonnet-5",
};

const REQUEST: AiGenerationRequest = {
  systemInstruction: SYSTEM_INSTRUCTION,
  userContent: USER_CONTENT,
  responseFormat: "json",
  jsonSchema: {
    name: SCHEMA_NAME,
    schema: {
      type: "object",
      properties: { [SCHEMA_PROPERTY]: { type: "string" } },
      required: [SCHEMA_PROPERTY],
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

/** An Anthropic Messages success envelope carrying the given content blocks. */
function anthropicOk(
  content: unknown[],
  stopReason: string | null = "end_turn",
): Response {
  const body: Record<string, unknown> = {
    id: "msg_sentinel",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  if (stopReason !== null) body.stop_reason = stopReason;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const textBlock = (text: string) => ({ type: "text", text });

const generate = (harness: Harness, request: AiGenerationRequest = REQUEST, model = MODEL) =>
  ANTHROPIC_AI_PROVIDER_ADAPTER.generate(model, request, harness.deps);

async function captureRequest(request: AiGenerationRequest = REQUEST, model = MODEL) {
  const harness = makeHarness([anthropicOk([textBlock("{}")])]);
  const result = await generate(harness, request, model);
  const [url, init] = harness.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)), raw: String(init.body), result, harness };
}

// ── 1. Provider identity ──────────────────────────────────────────────────

describe("the provider this adapter implements", () => {
  it("names anthropic, and is not the Google adapter wearing a label", () => {
    expect(ANTHROPIC_AI_PROVIDER).toBe("anthropic");
    expect(ANTHROPIC_AI_PROVIDER_ADAPTER.provider).toBe("anthropic");
  });

  it("accepts any Anthropic model string the catalog might one day authorize", async () => {
    // Deliberately NOT hard-coded to claude-sonnet-5: `ai_model_catalog` is the
    // model allowlist (C33/C35/C39), and a TypeScript list here would be a
    // second authorization surface that could disagree with the database.
    for (const providerModel of [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5",
      "claude-future-unheard-of",
    ]) {
      const { body } = await captureRequest(REQUEST, {
        provider: ANTHROPIC_AI_PROVIDER,
        providerModel,
      });
      expect(body.model).toBe(providerModel);
    }
  });

  it("puts the model in the BODY, never in the URL", async () => {
    // Unlike Gemini, Anthropic's endpoint is constant. A model in the path
    // would be a different protocol.
    const { url } = await captureRequest();
    expect(url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(url).not.toContain("claude");
  });
});

// ── 2. The wire contract ──────────────────────────────────────────────────

describe("the request that reaches Anthropic", () => {
  it("POSTs to the documented Messages endpoint", async () => {
    const { url, init } = await captureRequest();
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
  });

  it("sends exactly three headers: JSON content type, the key, and the API version", async () => {
    const { init } = await captureRequest();
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    });
    expect(ANTHROPIC_VERSION).toBe("2023-06-01");
  });

  it("sends no beta header — current structured outputs require none", async () => {
    const { init } = await captureRequest();
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain("anthropic-beta");
  });

  it("carries the credential ONLY in x-api-key", async () => {
    const { url, raw, init } = await captureRequest();
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(API_KEY);
    expect(url).not.toContain(API_KEY);
    expect(raw).not.toContain(API_KEY);
    // Not an OpenAI-shaped Authorization header, and not a query parameter.
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("authorization");
  });

  it("sends the system instruction top-level and the user content as one message", async () => {
    const { body } = await captureRequest();
    expect(body.system).toBe(SYSTEM_INSTRUCTION);
    expect(body.messages).toEqual([{ role: "user", content: USER_CONTENT }]);
  });

  it("sends exactly one message — no prefill, no assistant turn", async () => {
    // Sonnet 5 returns 400 for an assistant prefill, and structured outputs are
    // the documented replacement for prefill-as-JSON-coercion.
    const { body } = await captureRequest();
    expect(body.messages).toHaveLength(1);
    expect(JSON.stringify(body.messages)).not.toContain("assistant");
  });

  it("translates the operation's schema into output_config.format", async () => {
    const { body } = await captureRequest();
    expect(body.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: REQUEST.jsonSchema.schema,
      },
    });
  });

  it("passes the operation's schema through verbatim, and drops its name", async () => {
    // Anthropic's format takes no name; OpenAI's requires one. The adapter
    // translates rather than invents, so the name simply does not appear.
    const { body, raw } = await captureRequest();
    const format = (body.output_config as Record<string, unknown>).format as Record<
      string,
      unknown
    >;
    expect(format.schema).toEqual(REQUEST.jsonSchema.schema);
    expect(JSON.stringify(format.schema)).toContain(SCHEMA_PROPERTY);
    expect(format).not.toHaveProperty("name");
    expect(raw).not.toContain(SCHEMA_NAME);
  });

  it("sends the 001B provisional output ceiling, which Anthropic requires", async () => {
    const { body } = await captureRequest();
    expect(body.max_tokens).toBe(ANTHROPIC_PROVISIONAL_MAX_TOKENS);
    expect(ANTHROPIC_PROVISIONAL_MAX_TOKENS).toBe(4096);
  });

  it("pins the whole envelope: these five keys and no others", async () => {
    const { body } = await captureRequest();
    expect(Object.keys(body).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "output_config",
      "system",
    ]);
  });

  it.each([
    // 001B decides no reasoning policy — AI-MULTI-PROVIDER-001C owns it. The
    // adapter stays unregistered precisely BECAUSE omitting this key leaves
    // Sonnet 5's adaptive-thinking default in force.
    "thinking",
    // Sonnet 5 returns 400 for a non-default sampling parameter, and PaperLume
    // sets none anywhere.
    "temperature",
    "top_p",
    "top_k",
    // Not an agent call.
    "tools",
    "tool_choice",
    // Prompt caching is deliberately out of 001B's scope.
    "cache_control",
    // No user-identifying field of any kind.
    "metadata",
    "user",
    "user_id",
    // Not a streaming or tiered call.
    "stream",
    "service_tier",
    "stop_sequences",
  ])("never sends %s", async (key) => {
    const { body } = await captureRequest();
    expect(body).not.toHaveProperty(key);
  });

  it("sends no reasoning/effort configuration of any kind", async () => {
    const { raw } = await captureRequest();
    for (const term of ["effort", "budget_tokens", "adaptive", "reasoning"]) {
      expect(raw).not.toContain(term);
    }
  });

  it("builds the same body through the exported helper as it sends", async () => {
    const { body } = await captureRequest();
    expect(buildAnthropicRequestBody(MODEL, REQUEST)).toEqual(body);
    expect(String(buildAnthropicRequestInit(MODEL, REQUEST, API_KEY).body)).toBe(
      JSON.stringify(body),
    );
  });

  it("uses only the injected fetch, never a global one", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const harness = makeHarness([anthropicOk([textBlock("{}")])]);
    await generate(harness);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    globalFetch.mockRestore();
  });
});

// ── 3. Transport policy ───────────────────────────────────────────────────

describe("this adapter's own transport policy", () => {
  it("makes exactly ONE attempt and never sleeps a backoff", async () => {
    const harness = makeHarness([
      new Response("busy", { status: 429, headers: { "Retry-After": "1" } }),
    ]);
    const result = await generate(harness);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
    expect(result).toEqual({ ok: false, kind: "http", status: 429, attempts: 1 });
    expect(ANTHROPIC_PROVIDER_ATTEMPTS).toBe(1);
  });

  it("applies its OWN timeout, not the Gemini transport's", async () => {
    const harness = makeHarness([anthropicOk([textBlock("{}")])]);
    await generate(harness);
    expect(harness.signalTimeouts).toEqual([ANTHROPIC_PROVIDER_TIMEOUT_MS]);
    expect(ANTHROPIC_PROVIDER_TIMEOUT_MS).toBe(60_000);
    // C39: a second provider's transport constants are not inherited. The
    // Gemini value is currently a temporary 90 s Production diagnostic.
    expect(ANTHROPIC_PROVIDER_TIMEOUT_MS).not.toBe(GEMINI_PROVIDER_TIMEOUT_MS);
  });

  it("passes the timeout signal to fetch", async () => {
    const harness = makeHarness([anthropicOk([textBlock("{}")])]);
    await generate(harness);
    const [, init] = harness.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeDefined();
  });

  it("stays inside the documented Supabase Edge request envelope", () => {
    // One attempt at the ceiling above is the worst case, and it must leave
    // room inside the 150 s hosted-function limit.
    expect(ANTHROPIC_PROVIDER_TIMEOUT_MS * ANTHROPIC_PROVIDER_ATTEMPTS).toBeLessThan(150_000);
  });
});

// ── 4. Reading the response ───────────────────────────────────────────────

describe("extracting the generated text", () => {
  it("returns the text of a single text block", async () => {
    const harness = makeHarness([anthropicOk([textBlock('{"tldr":"x"}')])]);
    expect(await generate(harness)).toEqual({ ok: true, text: '{"tldr":"x"}', attempts: 1 });
  });

  it("concatenates multiple text blocks in the order returned", async () => {
    const harness = makeHarness([
      anthropicOk([textBlock('{"a":'), textBlock('1,"b":'), textBlock("2}")]),
    ]);
    expect(await generate(harness)).toEqual({
      ok: true,
      text: '{"a":1,"b":2}',
      attempts: 1,
    });
  });

  it("ignores a thinking block BEFORE the text — Sonnet 5's default shape", async () => {
    const harness = makeHarness([
      anthropicOk([
        { type: "thinking", thinking: "LEAKED-REASONING", signature: "sig" },
        textBlock('{"ok":true}'),
      ]),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({ ok: true, text: '{"ok":true}', attempts: 1 });
    expect(JSON.stringify(result)).not.toContain("LEAKED-REASONING");
  });

  it("ignores a thinking block AFTER the text too", async () => {
    const harness = makeHarness([
      anthropicOk([
        textBlock('{"ok":true}'),
        { type: "thinking", thinking: "LEAKED-REASONING", signature: "sig" },
      ]),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({ ok: true, text: '{"ok":true}', attempts: 1 });
    expect(JSON.stringify(result)).not.toContain("LEAKED-REASONING");
  });

  it("ignores thinking blocks interleaved between text blocks", async () => {
    const harness = makeHarness([
      anthropicOk([
        { type: "thinking", thinking: "LEAKED-A", signature: "s" },
        textBlock('{"a":'),
        { type: "redacted_thinking", data: "LEAKED-B" },
        textBlock("1}"),
      ]),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({ ok: true, text: '{"a":1}', attempts: 1 });
    expect(JSON.stringify(result)).not.toContain("LEAKED-");
  });

  it("ignores every other block kind, including ones that do not exist yet", async () => {
    const harness = makeHarness([
      anthropicOk([
        { type: "tool_use", id: "t", name: "n", input: { LEAKED: 1 } },
        { type: "some_future_block", text: "LEAKED-FUTURE" },
        textBlock("real"),
      ]),
    ]);
    const result = await generate(harness);
    // The future block carries a `text` field and is STILL ignored: the filter
    // is on `type`, not on the presence of a text-shaped property.
    expect(result).toEqual({ ok: true, text: "real", attempts: 1 });
    expect(JSON.stringify(result)).not.toContain("LEAKED");
  });

  it("returns the text exactly as sent — no trimming, unwrapping or repair", async () => {
    const raw = '  ```json\n{"tldr":"x"}\n```  ';
    const harness = makeHarness([anthropicOk([textBlock(raw)])]);
    expect(await generate(harness)).toEqual({ ok: true, text: raw, attempts: 1 });
  });

  it("hands back whitespace-only text rather than judging it empty", async () => {
    // Same contract as the Google adapter: whether a blank answer is usable is
    // the operation's judgement, not the adapter's.
    const harness = makeHarness([anthropicOk([textBlock("   ")])]);
    expect(await generate(harness)).toEqual({ ok: true, text: "   ", attempts: 1 });
  });

  it("reads the envelope structurally, through the exported helper", () => {
    expect(extractAnthropicText({ content: [textBlock("a"), textBlock("b")] })).toBe("ab");
    expect(extractAnthropicText({ content: [textBlock("")] })).toBeNull();
    expect(extractAnthropicText({ content: [] })).toBeNull();
    expect(extractAnthropicText({ content: [{ type: "text", text: 42 }] })).toBeNull();
    // Not an envelope at all.
    expect(extractAnthropicText({})).toBeUndefined();
    expect(extractAnthropicText({ content: "not an array" })).toBeUndefined();
    expect(extractAnthropicText(null)).toBeUndefined();
    expect(extractAnthropicText([])).toBeUndefined();
    expect(extractAnthropicText("string")).toBeUndefined();
  });
});

// ── 5. Failure normalization ──────────────────────────────────────────────

describe("normalizing provider failures", () => {
  it.each([400, 401, 403, 404, 413, 429, 500, 503, 529])(
    "reports HTTP %s as kind=http with the status and nothing else",
    async (status) => {
      const harness = makeHarness([
        new Response(JSON.stringify({ error: { message: "PROVIDER-ERROR-BODY" } }), { status }),
      ]);
      const result = await generate(harness);
      expect(result).toEqual({ ok: false, kind: "http", status, attempts: 1 });
      expect(JSON.stringify(result)).not.toContain("PROVIDER-ERROR-BODY");
    },
  );

  it("normalizes a network failure", async () => {
    const harness = makeHarness([new TypeError("fetch failed for https://api.anthropic.com")]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "network", attempts: 1 });
  });

  it("normalizes a timeout, and keeps it distinct from a network failure", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const timeoutError = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const harness = makeHarness([timeoutError]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "timeout", attempts: 1 });
  });

  it("treats an AbortError raised on OUR aborted signal as a timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    });
    const result = await ANTHROPIC_AI_PROVIDER_ADAPTER.generate(MODEL, REQUEST, {
      apiKey: API_KEY,
      label: "test-op",
      fetchImpl: fetchImpl as unknown as AiProviderCallDeps["fetchImpl"],
      sleep: async () => {},
      createTimeoutSignal: () => controller.signal,
    });
    expect(result).toEqual({ ok: false, kind: "timeout", attempts: 1 });
  });

  it("reports a 2xx whose body is not JSON as unreadable, not as empty", async () => {
    const harness = makeHarness([
      new Response("<html>PROVIDER-HTML-BODY</html>", { status: 200 }),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({ ok: false, kind: "unreadable_response", attempts: 1 });
    expect(JSON.stringify(result)).not.toContain("PROVIDER-HTML-BODY");
  });

  it.each([
    ["a JSON array", JSON.stringify([{ type: "text", text: "x" }])],
    ["a JSON string", JSON.stringify("just a string")],
    ["a JSON null", "null"],
    ["an object with no content", JSON.stringify({ stop_reason: "end_turn" })],
    ["content that is not an array", JSON.stringify({ content: { type: "text" } })],
  ])("reports %s as unreadable rather than empty", async (_label, body) => {
    const harness = makeHarness([
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    ]);
    expect(await generate(harness)).toEqual({
      ok: false,
      kind: "unreadable_response",
      attempts: 1,
    });
  });

  it("reports a missing or non-string stop_reason as unreadable", async () => {
    for (const stopReason of [null, 42 as unknown as string]) {
      const harness = makeHarness([
        stopReason === null
          ? anthropicOk([textBlock("x")], null)
          : new Response(JSON.stringify({ content: [textBlock("x")], stop_reason: 42 }), {
              status: 200,
            }),
      ]);
      expect(await generate(harness)).toEqual({
        ok: false,
        kind: "unreadable_response",
        attempts: 1,
      });
    }
  });

  it("reports an empty content array as empty", async () => {
    const harness = makeHarness([anthropicOk([])]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "empty", attempts: 1 });
  });

  it("reports content with no TEXT block as empty", async () => {
    const harness = makeHarness([
      anthropicOk([{ type: "thinking", thinking: "only reasoning", signature: "s" }]),
    ]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "empty", attempts: 1 });
  });

  it("reports an empty-string text block as empty", async () => {
    const harness = makeHarness([anthropicOk([textBlock("")])]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "empty", attempts: 1 });
  });

  it("never throws, whatever the provider does", async () => {
    const outcomes: Array<Response | Error> = [
      new Response("nope", { status: 500 }),
      new Response("{", { status: 200 }),
      new TypeError("boom"),
      anthropicOk([]),
      anthropicOk([textBlock("x")], "max_tokens"),
    ];
    for (const outcome of outcomes) {
      const harness = makeHarness([outcome]);
      await expect(generate(harness)).resolves.toBeDefined();
    }
  });
});

// ── 6. A generation the provider itself says did not finish ───────────────

describe("a 200 whose stop_reason is not end_turn", () => {
  it.each([
    // Our own 4096 ceiling truncated the answer. With adaptive thinking on by
    // default, this is a REALISTIC outcome at the provisional ceiling — one of
    // the reasons this adapter stays unregistered until 001C sets a real one.
    ["max_tokens"],
    // A Sonnet 5 safeguard declined. Documented as HTTP 200, not an error.
    ["refusal"],
    // Impossible for this request shape, which sends neither. Still refused
    // rather than silently accepted.
    ["stop_sequence"],
    ["tool_use"],
    ["some_future_stop_reason"],
  ])("reports stop_reason=%s as incomplete_response", async (stopReason) => {
    const harness = makeHarness([anthropicOk([textBlock('{"tldr":"trunc')], stopReason)]);
    expect(await generate(harness)).toEqual({
      ok: false,
      kind: "incomplete_response",
      attempts: 1,
    });
  });

  it("does NOT return the truncated text as a successful answer", async () => {
    const harness = makeHarness([
      anthropicOk([textBlock('{"tldr":"a half-written ans')], "max_tokens"),
    ]);
    const result = await generate(harness);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("half-written");
  });

  it("does NOT report it as empty, even when there is no text at all", async () => {
    // The distinction this kind exists for: "the model answered with nothing"
    // and "the model was cut off before answering" are different diagnoses.
    const harness = makeHarness([anthropicOk([], "max_tokens")]);
    expect(await generate(harness)).toEqual({
      ok: false,
      kind: "incomplete_response",
      attempts: 1,
    });
  });

  it("leaks no stop_reason and no refusal text across the boundary", async () => {
    const harness = makeHarness([
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "REFUSAL-PROSE-ABOUT-THE-PROMPT" }],
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: "LEAKED-EXPLANATION" },
        }),
        { status: 200 },
      ),
    ]);
    const result = await generate(harness);
    const asText = JSON.stringify(result);
    expect(asText).not.toContain("REFUSAL-PROSE-ABOUT-THE-PROMPT");
    expect(asText).not.toContain("LEAKED-EXPLANATION");
    expect(asText).not.toContain("refusal");
    expect(asText).not.toContain("cyber");
  });
});

// ── 7. The privacy boundary ───────────────────────────────────────────────

describe("nothing provider-shaped or sensitive escapes", () => {
  const SENSITIVE = [
    API_KEY,
    SYSTEM_INSTRUCTION,
    USER_CONTENT,
    "SENTINEL",
    "api.anthropic.com",
    "x-api-key",
    "anthropic-version",
    "PROVIDER-ERROR-BODY",
  ];

  it("returns no provider body, header, URL or envelope on failure", async () => {
    const outcomes: Array<Response | Error> = [
      new Response(JSON.stringify({ error: { message: "PROVIDER-ERROR-BODY" } }), {
        status: 429,
        headers: { "retry-after": "30", "request-id": "req_LEAKED" },
      }),
      new Response("PROVIDER-ERROR-BODY", { status: 500 }),
      new Response("PROVIDER-ERROR-BODY", { status: 200 }),
      anthropicOk([]),
      anthropicOk([textBlock("x")], "max_tokens"),
      new TypeError(`failed to reach https://api.anthropic.com with ${API_KEY}`),
    ];
    for (const outcome of outcomes) {
      const harness = makeHarness([outcome]);
      const result = await generate(harness);
      expect(result.ok).toBe(false);
      const asText = JSON.stringify(result);
      for (const secret of SENSITIVE) expect(asText).not.toContain(secret);
      expect(asText).not.toContain("req_LEAKED");
      expect(asText).not.toContain("retry-after");
      // The bounded shape, and nothing else.
      expect(Object.keys(result).sort().join(",")).toMatch(
        /^(attempts,kind,ok|attempts,kind,ok,status)$/,
      );
    }
  });

  it("leaks nothing through a Project or Tag name in the prompt", async () => {
    // The Suggest payload is the operation's serialized taxonomy, so it is the
    // realistic carrier of user data into this module.
    const taxonomy = JSON.stringify({
      paper: { title: "PRIVATE-PAPER-TITLE", abstract: "PRIVATE-ABSTRACT" },
      existingProjects: [{ ref: "P1", name: "PRIVATE-PROJECT-NAME", alreadySelected: false }],
      existingTags: [{ ref: "T1", name: "PRIVATE-TAG-NAME", alreadySelected: false }],
    });
    const request: AiGenerationRequest = { ...REQUEST, userContent: taxonomy };
    const harness = makeHarness([new Response("nope", { status: 500 })]);
    const result = await generate(harness, request);
    const everythingReturned = JSON.stringify(result) + harness.warns.join("|");
    for (const secret of [
      "PRIVATE-PAPER-TITLE",
      "PRIVATE-ABSTRACT",
      "PRIVATE-PROJECT-NAME",
      "PRIVATE-TAG-NAME",
    ]) {
      expect(everythingReturned).not.toContain(secret);
    }
  });

  it("logs no key, prompt, paper content, URL or provider body", async () => {
    const outcomes: Array<Response | Error> = [
      new Response(JSON.stringify({ error: "PROVIDER-ERROR-BODY" }), { status: 429 }),
      new Response("PROVIDER-ERROR-BODY", { status: 500 }),
      new TypeError(`https://api.anthropic.com ${API_KEY}`),
    ];
    for (const outcome of outcomes) {
      const harness = makeHarness([outcome]);
      await generate(harness);
      for (const line of harness.warns) {
        for (const secret of SENSITIVE) expect(line).not.toContain(secret);
        // Bounded: a label, a coarse cause, a status, an attempt count.
        expect(line).toMatch(/^test-op provider_[a-z_]+(=\d+)? attempt=1 retry=0$/);
      }
    }
  });

  it("is silent when no logger is supplied", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 500 }));
    const result = await ANTHROPIC_AI_PROVIDER_ADAPTER.generate(MODEL, REQUEST, {
      apiKey: API_KEY,
      label: "test-op",
      fetchImpl: fetchImpl as unknown as AiProviderCallDeps["fetchImpl"],
      sleep: async () => {},
      createTimeoutSignal: () => new AbortController().signal,
    });
    expect(result.ok).toBe(false);
  });

  it("keeps operation semantics out: it returns text, never a parsed product shape", async () => {
    const harness = makeHarness([
      anthropicOk([textBlock('{"tldr":"t","studyType":"s","statisticalMethods":"m"}')]),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({
      ok: true,
      text: '{"tldr":"t","studyType":"s","statisticalMethods":"m"}',
      attempts: 1,
    });
    expect(result).not.toHaveProperty("tldr");
    expect(result).not.toHaveProperty("suggestions");
  });
});
