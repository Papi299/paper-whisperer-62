// @vitest-environment node
//
// Node, not jsdom: the adapter runs in Deno and uses the platform web APIs Deno
// provides (`Response`, `AbortSignal.timeout`). jsdom does not implement all of
// them, so under the project's default environment these assertions would be
// measuring jsdom rather than this module.
//
// AI-MULTI-PROVIDER-001B — the OpenAI (Responses API) provider adapter.
//
// This is the ONE module allowed to know OpenAI, so this suite is where the
// wire contract is pinned: the exact URL, the exact method, the exact headers,
// the exact request envelope, the exact structured-output vocabulary, and the
// exact traversal of the response envelope. It is also where the boundary is
// enforced in the other direction — nothing provider-shaped may come back out.
//
// THREE things this suite exists to keep true, beyond the protocol:
//
//   * `store: false` on every request. OpenAI's Responses API STORES responses
//     by default, and PaperLume sends paper titles and abstracts. This is the
//     privacy term of the whole integration, so it is asserted from several
//     directions rather than once.
//   * The adapter is NOT REGISTERED. Nothing here needs a registry entry: the
//     module is imported directly, which is the whole reason an unregistered
//     adapter can be reviewed this thoroughly before anyone can reach it.
//   * Reading `output[0]` is wrong. On a reasoning model a `reasoning` item can
//     precede the `message` item, and AI-MULTI-PROVIDER-001C may deliberately
//     raise reasoning effort. The extraction tests are written against that.
//
// No network: `fetchImpl` is injected everywhere, and one test proves the
// adapter never reaches for a global `fetch`. No real API key exists, is
// needed, or is used.
import { describe, it, expect, vi } from "vitest";
import {
  OPENAI_AI_PROVIDER,
  OPENAI_AI_PROVIDER_ADAPTER,
  OPENAI_PROVIDER_ATTEMPTS,
  OPENAI_PROVIDER_TIMEOUT_MS,
  OPENAI_REASONING_LEVELS,
  OPENAI_RESPONSES_URL,
  buildOpenAiRequestBody,
  buildOpenAiRequestInit,
  extractOpenAiText,
  type OpenAiProviderModel,
} from "../openAiProvider.ts";
import { GEMINI_PROVIDER_TIMEOUT_MS } from "../geminiTransport.ts";
import type {
  AiCallPolicy,
  AiGenerationRequest,
  AiProviderCallDeps,
} from "../aiProvider.ts";
import type { OpenAiReasoningLevel } from "../openAiProvider.ts";

// Sentinels: if any of these ever reaches a log line or a returned result, the
// assertion fails on the literal string rather than on a shape.
const API_KEY = "SENTINEL-OPENAI-API-KEY";
const SYSTEM_INSTRUCTION = "SENTINEL-SYSTEM-INSTRUCTION: you are a test.";
const USER_CONTENT = "SENTINEL-USER-CONTENT: a paper title and abstract.";
const SCHEMA_NAME = "sentinel_schema_name";
const SCHEMA_PROPERTY = "SENTINEL_SCHEMA_PROPERTY";

// Typed as an OpenAI model: the adapter accepts nothing wider (C39).
const MODEL: OpenAiProviderModel = {
  provider: OPENAI_AI_PROVIDER,
  providerModel: "gpt-5.6-terra",
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

/** A Responses success envelope carrying the given output items. */
function openAiOk(output: unknown[], status: string | null = "completed"): Response {
  const body: Record<string, unknown> = {
    id: "resp_sentinel",
    object: "response",
    model: "gpt-5.6-terra",
    output,
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  };
  if (status !== null) body.status = status;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// AI-MULTI-PROVIDER-001D. Every result carries `usage`. A failure that produced no
// readable body — and any envelope without a usage block — carries this: unknown,
// never zero.
const NO_USAGE = { kind: "unavailable", reason: "not_returned" } as const;

// What `openAiOk`'s usage block ({ input_tokens: 10, output_tokens: 20,
// total_tokens: 30 }) reports. No breakdowns are sent, so cached, cache-write and
// reasoning counts are unreported rather than zero.
const FIXTURE_USAGE = {
  kind: "reported",
  dimensions: {
    inputTokens: { state: "reported", tokens: 10 },
    cachedInputTokens: { state: "unreported" },
    cacheWriteInputTokens: { state: "unreported" },
    outputTokens: { state: "reported", tokens: 20 },
    reasoningOutputTokens: { state: "unreported" },
    providerTotalTokens: { state: "reported", tokens: 30 },
  },
  unmodeledUsage: false,
} as const;

/** A `message` output item carrying one or more `output_text` blocks. */
const messageItem = (...texts: string[]) => ({
  id: "msg_sentinel",
  type: "message",
  role: "assistant",
  status: "completed",
  content: texts.map((text) => ({ type: "output_text", text, annotations: [] })),
});

/** A `reasoning` output item, which the adapter must ignore entirely. */
const reasoningItem = (text: string) => ({
  id: "rs_sentinel",
  type: "reasoning",
  summary: [{ type: "summary_text", text }],
  encrypted_content: `ENCRYPTED-${text}`,
});

/**
 * The default call policy for these tests — AI-MULTI-PROVIDER-001C.
 *
 * `low` rather than Terra's own `medium` default, so a request asserted while
 * sending an explicit effort can never be confused with one asserted while
 * sending nothing. Every effort assertion names its level, and the
 * provider-default case is exercised on its own.
 */
const POLICY: AiCallPolicy<OpenAiReasoningLevel> = {
  reasoning: { kind: "level", level: "low" },
  maxOutputTokens: 4096,
};

const PROVIDER_DEFAULT_POLICY: AiCallPolicy<OpenAiReasoningLevel> = {
  reasoning: { kind: "provider_default" },
  maxOutputTokens: 4096,
};

const generate = (
  harness: Harness,
  request: AiGenerationRequest = REQUEST,
  model = MODEL,
  policy: AiCallPolicy<OpenAiReasoningLevel> = POLICY,
) => OPENAI_AI_PROVIDER_ADAPTER.generate(model, request, policy, harness.deps);

async function captureRequest(
  request: AiGenerationRequest = REQUEST,
  model = MODEL,
  policy: AiCallPolicy<OpenAiReasoningLevel> = POLICY,
) {
  const harness = makeHarness([openAiOk([messageItem("{}")])]);
  const result = await generate(harness, request, model, policy);
  const [url, init] = harness.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)), raw: String(init.body), result, harness };
}

// ── 1. Provider identity ──────────────────────────────────────────────────

describe("the provider this adapter implements", () => {
  it("names openai, and is not another adapter wearing a label", () => {
    expect(OPENAI_AI_PROVIDER).toBe("openai");
    expect(OPENAI_AI_PROVIDER_ADAPTER.provider).toBe("openai");
  });

  it("accepts any OpenAI model string the catalog might one day authorize", async () => {
    // Deliberately NOT hard-coded to gpt-5.6-terra: `ai_model_catalog` is the
    // model allowlist (C33/C35/C39), and a TypeScript list here would be a
    // second authorization surface that could disagree with the database.
    for (const providerModel of [
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-future-unheard-of",
    ]) {
      const { body } = await captureRequest(REQUEST, {
        provider: OPENAI_AI_PROVIDER,
        providerModel,
      });
      expect(body.model).toBe(providerModel);
    }
  });

  it("puts the model in the BODY, never in the URL", async () => {
    const { url } = await captureRequest();
    expect(url).toBe(OPENAI_RESPONSES_URL);
    expect(url).not.toContain("gpt");
  });
});

// ── 2. The wire contract ──────────────────────────────────────────────────

describe("the request that reaches OpenAI", () => {
  it("POSTs to the documented Responses endpoint — not Chat Completions", async () => {
    const { url, init } = await captureRequest();
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(url).not.toContain("chat/completions");
    expect(init.method).toBe("POST");
  });

  it("sends exactly two headers: JSON content type and a bearer credential", async () => {
    const { init } = await captureRequest();
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    });
  });

  it("carries the credential ONLY in the Authorization header", async () => {
    const { url, raw, init } = await captureRequest();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(url).not.toContain(API_KEY);
    expect(raw).not.toContain(API_KEY);
    // Not an Anthropic-shaped key header, and not a query parameter.
    expect(headers).not.toHaveProperty("x-api-key");
    expect(headers).not.toHaveProperty("OpenAI-Organization");
    expect(headers).not.toHaveProperty("OpenAI-Project");
  });

  it("sends the system instruction as `instructions` and the content as `input`", async () => {
    const { body } = await captureRequest();
    expect(body.instructions).toBe(SYSTEM_INSTRUCTION);
    expect(body.input).toBe(USER_CONTENT);
  });

  it("translates the operation's schema into text.format, with strict enforcement", async () => {
    const { body } = await captureRequest();
    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        name: SCHEMA_NAME,
        schema: REQUEST.jsonSchema.schema,
        strict: true,
      },
    });
  });

  it("passes the operation's schema through verbatim", async () => {
    const { body } = await captureRequest();
    const format = (body.text as Record<string, unknown>).format as Record<string, unknown>;
    expect(format.schema).toEqual(REQUEST.jsonSchema.schema);
    expect(JSON.stringify(format.schema)).toContain(SCHEMA_PROPERTY);
  });

  it("sends the OPERATION's output ceiling", async () => {
    // AI-MULTI-PROVIDER-001C replaced the 001B flat adapter constant with a
    // number the caller supplies, so the adapter cannot have an opinion about
    // which Edge Function called it. On a reasoning model this bound covers
    // reasoning AND answer, which is what keeps `max` effort bounded.
    const { body } = await captureRequest();
    expect(body.max_output_tokens).toBe(4096);
    for (const maxOutputTokens of [4096, 8192]) {
      const built = buildOpenAiRequestBody(MODEL, REQUEST, {
        reasoning: { kind: "level", level: "medium" },
        maxOutputTokens,
      });
      expect(built.max_output_tokens).toBe(maxOutputTokens);
    }
  });

  it("pins the whole envelope: these seven keys and no others", async () => {
    const { body } = await captureRequest();
    expect(Object.keys(body).sort()).toEqual([
      "input",
      "instructions",
      "max_output_tokens",
      "model",
      // AI-MULTI-PROVIDER-001C: PaperLume's explicit reasoning effort.
      "reasoning",
      "store",
      "text",
    ]);
  });
});

// ── 2b. PaperLume's explicit reasoning effort — AI-MULTI-PROVIDER-001C (C41) ──

describe("the reasoning effort that reaches OpenAI", () => {
  it("declares exactly the six efforts gpt-5.6-terra accepts, in OpenAI's order", () => {
    expect(OPENAI_AI_PROVIDER_ADAPTER.reasoningLevels).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(OPENAI_REASONING_LEVELS).toEqual(OPENAI_AI_PROVIDER_ADAPTER.reasoningLevels);
  });

  it("refuses the two canonical levels OpenAI does not have", () => {
    // `minimal` is not offered on gpt-5.6-terra, and `off` is Anthropic's word
    // for the idea OpenAI spells `none`. The two spellings stay two values so
    // neither adapter can be handed the other's and quietly send it.
    expect(OPENAI_AI_PROVIDER_ADAPTER.supportsReasoningLevel("minimal")).toBe(false);
    expect(OPENAI_AI_PROVIDER_ADAPTER.supportsReasoningLevel("off")).toBe(false);
    for (const level of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(OPENAI_AI_PROVIDER_ADAPTER.supportsReasoningLevel(level)).toBe(true);
    }
  });

  it.each([
    ["none"],
    ["low"],
    ["medium"],
    ["high"],
    ["xhigh"],
    ["max"],
  ] as const)("sends reasoning.effort %s, verbatim", async (level) => {
    const { body, raw } = await captureRequest(REQUEST, MODEL, {
      reasoning: { kind: "level", level },
      maxOutputTokens: 4096,
    });
    expect(body.reasoning).toEqual({ effort: level });
    expect(raw).toContain(`"effort":"${level}"`);
    // Still one stateless, unretained call at every effort.
    expect(body.store).toBe(false);
  });

  it("states `medium` explicitly even though it is Terra's own default", async () => {
    // The whole of C41 in one assertion. Omitting the key would produce the
    // same behaviour TODAY and would make PaperLume's product policy a function
    // of OpenAI's release notes the day that default moves.
    const { body } = await captureRequest(REQUEST, MODEL, {
      reasoning: { kind: "level", level: "medium" },
      maxOutputTokens: 4096,
    });
    expect(body).toHaveProperty("reasoning");
    expect(body.reasoning).toEqual({ effort: "medium" });
  });

  it("sends no reasoning key at all on the provider-default fallback", async () => {
    // The fail-open path for unusable policy metadata. `store: false`, the
    // ceiling and the structured-output format still go — none of them is
    // reasoning policy.
    const { body, raw } = await captureRequest(REQUEST, MODEL, PROVIDER_DEFAULT_POLICY);
    expect(body).not.toHaveProperty("reasoning");
    expect(raw).not.toContain("effort");
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(4096);
    expect((body.text as Record<string, unknown>).format).toMatchObject({
      type: "json_schema",
      strict: true,
    });
  });

  it("keeps structured output and identity-freedom at every effort", async () => {
    for (const level of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
      const { body } = await captureRequest(REQUEST, MODEL, {
        reasoning: { kind: "level", level },
        maxOutputTokens: 8192,
      });
      const format = (body.text as Record<string, unknown>).format as Record<string, unknown>;
      expect(format.type).toBe("json_schema");
      expect(format.strict).toBe(true);
      expect(format.schema).toEqual(REQUEST.jsonSchema.schema);
      expect(body.max_output_tokens).toBe(8192);
      for (const key of [
        "tools",
        "tool_choice",
        "metadata",
        "safety_identifier",
        "user",
        "prompt_cache_key",
        "conversation",
        "previous_response_id",
        "temperature",
        "top_p",
      ]) {
        expect(body).not.toHaveProperty(key);
      }
    }
  });
});

// ── 3. store: false — the privacy term ────────────────────────────────────

describe("store: false, on every single request", () => {
  it("sends store as the boolean false, not a string and not omitted", async () => {
    const { body } = await captureRequest();
    expect(body).toHaveProperty("store");
    expect(body.store).toBe(false);
    expect(body.store).not.toBe("false");
  });

  it("appears in the serialized bytes that actually go on the wire", async () => {
    const { raw } = await captureRequest();
    expect(raw).toContain('"store":false');
  });

  it("is unconditional — the same for every model and every request", async () => {
    for (const providerModel of ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-future"]) {
      for (const userContent of ["", "a", USER_CONTENT]) {
        const { body } = await captureRequest(
          { ...REQUEST, userContent },
          { provider: OPENAI_AI_PROVIDER, providerModel },
        );
        expect(body.store).toBe(false);
      }
    }
  });

  it("is present in the helper-built body too, not only the adapter path", () => {
    expect(buildOpenAiRequestBody(MODEL, REQUEST, POLICY).store).toBe(false);
    expect(String(buildOpenAiRequestInit(MODEL, REQUEST, POLICY, API_KEY).body)).toContain(
      '"store":false',
    );
  });
});

// ── 4. What is deliberately NOT sent ──────────────────────────────────────

describe("fields this adapter never sends", () => {
  it.each([
    // No user identity of any kind reaches OpenAI.
    "metadata",
    "safety_identifier",
    "user",
    "prompt_cache_key",
    // No conversation state: this is one stateless call.
    "conversation",
    "previous_response_id",
    // No agent features.
    "tools",
    "tool_choice",
    "include",
    // No sampling override anywhere in PaperLume.
    "temperature",
    "top_p",
    // Not a streaming, background or tiered call.
    "stream",
    "background",
    "service_tier",
    "truncation",
  ])("never sends %s", async (key) => {
    const { body } = await captureRequest();
    expect(body).not.toHaveProperty(key);
  });

  it("sends no reasoning SUMMARY or verbosity configuration", async () => {
    // `reasoning.effort` is now sent deliberately (see the mapping tests); what
    // stays absent is everything that would ask OpenAI to RETURN reasoning, or
    // that would steer output length outside PaperLume's own ceiling.
    const { body, raw } = await captureRequest();
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(Object.keys(body.reasoning as Record<string, unknown>)).toEqual(["effort"]);
    for (const term of ["summary", "verbosity", "generate_summary"]) {
      expect(raw).not.toContain(term);
    }
  });

  it("sends no tool of any kind — not file search, web search or computer use", async () => {
    const { raw } = await captureRequest();
    for (const term of ["file_search", "web_search", "computer_use", "code_interpreter"]) {
      expect(raw).not.toContain(term);
    }
  });

  it("carries no user-identifying value even when one appears in the prompt", async () => {
    // The only place user data may legitimately appear is `input` — the prompt
    // the operation built. It must not be duplicated into an identity field.
    const { body, raw } = await captureRequest();
    expect(body.input).toBe(USER_CONTENT);
    const withoutInput = { ...body };
    delete withoutInput.input;
    expect(JSON.stringify(withoutInput)).not.toContain("SENTINEL-USER-CONTENT");
    expect(raw).not.toContain("@");
  });

  it("uses only the injected fetch, never a global one", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const harness = makeHarness([openAiOk([messageItem("{}")])]);
    await generate(harness);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    globalFetch.mockRestore();
  });
});

// ── 5. Transport policy ───────────────────────────────────────────────────

describe("this adapter's own transport policy", () => {
  it("makes exactly ONE attempt and never sleeps a backoff", async () => {
    const harness = makeHarness([
      new Response("busy", { status: 429, headers: { "Retry-After": "1" } }),
    ]);
    const result = await generate(harness);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
    expect(result).toEqual({ ok: false, kind: "http", status: 429, attempts: 1, usage: NO_USAGE });
    expect(OPENAI_PROVIDER_ATTEMPTS).toBe(1);
  });

  it("applies its OWN timeout, not the Gemini transport's", async () => {
    const harness = makeHarness([openAiOk([messageItem("{}")])]);
    await generate(harness);
    expect(harness.signalTimeouts).toEqual([OPENAI_PROVIDER_TIMEOUT_MS]);
    expect(OPENAI_PROVIDER_TIMEOUT_MS).toBe(60_000);
    // C39: a second provider's transport constants are not inherited. The
    // Gemini value is currently a temporary 90 s Production diagnostic.
    expect(OPENAI_PROVIDER_TIMEOUT_MS).not.toBe(GEMINI_PROVIDER_TIMEOUT_MS);
  });

  it("stays inside the documented Supabase Edge request envelope", () => {
    expect(OPENAI_PROVIDER_TIMEOUT_MS * OPENAI_PROVIDER_ATTEMPTS).toBeLessThan(150_000);
  });
});

// ── 6. Reading the response ───────────────────────────────────────────────

describe("traversing the output array", () => {
  it("returns the text of an ordinary message/output_text response", async () => {
    const harness = makeHarness([openAiOk([messageItem('{"tldr":"x"}')])]);
    expect(await generate(harness)).toEqual({ ok: true, text: '{"tldr":"x"}', attempts: 1, usage: FIXTURE_USAGE });
  });

  it("ignores a reasoning item BEFORE the message — the reasoning-model shape", async () => {
    const harness = makeHarness([
      openAiOk([reasoningItem("LEAKED-REASONING"), messageItem('{"ok":true}')]),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({ ok: true, text: '{"ok":true}', attempts: 1, usage: FIXTURE_USAGE });
    expect(JSON.stringify(result)).not.toContain("LEAKED-REASONING");
    expect(JSON.stringify(result)).not.toContain("ENCRYPTED-");
  });

  it("ignores a reasoning item AFTER the message too", async () => {
    const harness = makeHarness([
      openAiOk([messageItem('{"ok":true}'), reasoningItem("LEAKED-REASONING")]),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({ ok: true, text: '{"ok":true}', attempts: 1, usage: FIXTURE_USAGE });
    expect(JSON.stringify(result)).not.toContain("LEAKED-REASONING");
  });

  it("ignores reasoning items interleaved among several message items", async () => {
    const harness = makeHarness([
      openAiOk([
        reasoningItem("LEAKED-A"),
        messageItem('{"a":'),
        reasoningItem("LEAKED-B"),
        messageItem("1}"),
        reasoningItem("LEAKED-C"),
      ]),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({ ok: true, text: '{"a":1}', attempts: 1, usage: FIXTURE_USAGE });
    expect(JSON.stringify(result)).not.toContain("LEAKED-");
  });

  it("concatenates multiple output_text blocks within one message", async () => {
    const harness = makeHarness([openAiOk([messageItem('{"a":', '1,"b":', "2}")])]);
    expect(await generate(harness)).toEqual({ ok: true, text: '{"a":1,"b":2}', attempts: 1, usage: FIXTURE_USAGE });
  });

  it("ignores non-output_text content, including a refusal block", async () => {
    // A refusal is provider-authored prose about PaperLume's own prompt. It is
    // ignored rather than surfaced, so it cannot cross the boundary as if it
    // were the model's answer.
    const harness = makeHarness([
      openAiOk([
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "refusal", refusal: "LEAKED-REFUSAL-PROSE" },
            { type: "output_text", text: "real" },
          ],
        },
      ]),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({ ok: true, text: "real", attempts: 1, usage: FIXTURE_USAGE });
    expect(JSON.stringify(result)).not.toContain("LEAKED-REFUSAL-PROSE");
  });

  it("reports a refusal-only response as empty, carrying no refusal text", async () => {
    const harness = makeHarness([
      openAiOk([
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "LEAKED-REFUSAL-PROSE" }],
        },
      ]),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({ ok: false, kind: "empty", attempts: 1, usage: FIXTURE_USAGE });
    expect(JSON.stringify(result)).not.toContain("LEAKED-REFUSAL-PROSE");
  });

  it("ignores every other item kind, including ones that do not exist yet", async () => {
    const harness = makeHarness([
      openAiOk([
        { type: "function_call", name: "n", arguments: '{"LEAKED":1}' },
        { type: "web_search_call", status: "completed" },
        { type: "some_future_item", content: [{ type: "output_text", text: "LEAKED-FUTURE" }] },
        messageItem("real"),
      ]),
    ]);
    const result = await generate(harness);
    // The future item carries an output_text-shaped block and is STILL ignored:
    // the filter is on the ITEM type first.
    expect(result).toEqual({ ok: true, text: "real", attempts: 1, usage: FIXTURE_USAGE });
    expect(JSON.stringify(result)).not.toContain("LEAKED");
  });

  it("preserves the text exactly — no trimming, unwrapping or repair", async () => {
    const raw = '  ```json\n{"tldr":"x"}\n```  ';
    const harness = makeHarness([openAiOk([messageItem(raw)])]);
    expect(await generate(harness)).toEqual({ ok: true, text: raw, attempts: 1, usage: FIXTURE_USAGE });
  });

  it("hands back whitespace-only text rather than judging it empty", async () => {
    const harness = makeHarness([openAiOk([messageItem("   ")])]);
    expect(await generate(harness)).toEqual({ ok: true, text: "   ", attempts: 1, usage: FIXTURE_USAGE });
  });

  it("never uses a flattened top-level output_text convenience field", async () => {
    // `output_text` as a single string is an SDK helper, not a raw-HTTP
    // guarantee. If the adapter read it, this response would look successful.
    const harness = makeHarness([
      new Response(
        JSON.stringify({
          status: "completed",
          output: [reasoningItem("r")],
          output_text: "SDK-ONLY-CONVENIENCE-FIELD",
        }),
        { status: 200 },
      ),
    ]);
    const result = await generate(harness);
    // This hand-built envelope carries no usage block, so none is reported.
    expect(result).toEqual({ ok: false, kind: "empty", attempts: 1, usage: NO_USAGE });
    expect(JSON.stringify(result)).not.toContain("SDK-ONLY-CONVENIENCE-FIELD");
  });

  it("reads the envelope structurally, through the exported helper", () => {
    expect(extractOpenAiText({ output: [messageItem("a"), messageItem("b")] })).toBe("ab");
    expect(extractOpenAiText({ output: [messageItem("")] })).toBeNull();
    expect(extractOpenAiText({ output: [] })).toBeNull();
    expect(extractOpenAiText({ output: [reasoningItem("r")] })).toBeNull();
    expect(
      extractOpenAiText({ output: [{ type: "message", content: [{ type: "output_text", text: 1 }] }] }),
    ).toBeNull();
    expect(extractOpenAiText({ output: [{ type: "message", content: "not an array" }] })).toBeNull();
    // Not an envelope at all.
    expect(extractOpenAiText({})).toBeUndefined();
    expect(extractOpenAiText({ output: "not an array" })).toBeUndefined();
    expect(extractOpenAiText(null)).toBeUndefined();
    expect(extractOpenAiText([])).toBeUndefined();
    expect(extractOpenAiText("string")).toBeUndefined();
  });
});

// ── 7. Failure normalization ──────────────────────────────────────────────

describe("normalizing provider failures", () => {
  it.each([400, 401, 403, 404, 413, 429, 500, 502, 503])(
    "reports HTTP %s as kind=http with the status and nothing else",
    async (status) => {
      const harness = makeHarness([
        new Response(JSON.stringify({ error: { message: "PROVIDER-ERROR-BODY" } }), { status }),
      ]);
      const result = await generate(harness);
      expect(result).toEqual({ ok: false, kind: "http", status, attempts: 1, usage: NO_USAGE });
      expect(JSON.stringify(result)).not.toContain("PROVIDER-ERROR-BODY");
    },
  );

  it("normalizes a network failure", async () => {
    const harness = makeHarness([new TypeError("fetch failed for https://api.openai.com")]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "network", attempts: 1, usage: NO_USAGE });
  });

  it("normalizes a timeout, and keeps it distinct from a network failure", async () => {
    const timeoutError = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const harness = makeHarness([timeoutError]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "timeout", attempts: 1, usage: NO_USAGE });
  });

  it("treats an AbortError raised on OUR aborted signal as a timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    });
    const result = await OPENAI_AI_PROVIDER_ADAPTER.generate(MODEL, REQUEST, POLICY, {
      apiKey: API_KEY,
      label: "test-op",
      fetchImpl: fetchImpl as unknown as AiProviderCallDeps["fetchImpl"],
      sleep: async () => {},
      createTimeoutSignal: () => controller.signal,
    });
    expect(result).toEqual({ ok: false, kind: "timeout", attempts: 1, usage: NO_USAGE });
  });

  it("reports a 2xx whose body is not JSON as unreadable, not as empty", async () => {
    const harness = makeHarness([
      new Response("<html>PROVIDER-HTML-BODY</html>", { status: 200 }),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({ ok: false, kind: "unreadable_response", attempts: 1, usage: NO_USAGE });
    expect(JSON.stringify(result)).not.toContain("PROVIDER-HTML-BODY");
  });

  it.each([
    ["a JSON array", JSON.stringify([{ type: "message" }])],
    ["a JSON string", JSON.stringify("just a string")],
    ["a JSON null", "null"],
    ["an object with no output", JSON.stringify({ status: "completed" })],
    ["output that is not an array", JSON.stringify({ status: "completed", output: {} })],
  ])("reports %s as unreadable rather than empty", async (_label, body) => {
    const harness = makeHarness([
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    ]);
    expect(await generate(harness)).toEqual({
      ok: false,
      kind: "unreadable_response",
      attempts: 1,
      usage: NO_USAGE,
    });
  });

  it("reports a missing or non-string status as unreadable", async () => {
    const missing = makeHarness([openAiOk([messageItem("x")], null)]);
    expect(await generate(missing)).toEqual({
      ok: false,
      kind: "unreadable_response",
      attempts: 1,
      usage: NO_USAGE,
    });
    const nonString = makeHarness([
      new Response(JSON.stringify({ output: [messageItem("x")], status: 42 }), { status: 200 }),
    ]);
    expect(await generate(nonString)).toEqual({
      ok: false,
      kind: "unreadable_response",
      attempts: 1,
      usage: NO_USAGE,
    });
  });

  it("reports an empty output array as empty", async () => {
    const harness = makeHarness([openAiOk([])]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "empty", attempts: 1, usage: FIXTURE_USAGE });
  });

  it("reports a reasoning-only response as empty", async () => {
    const harness = makeHarness([openAiOk([reasoningItem("only reasoning")])]);
    expect(await generate(harness)).toEqual({ ok: false, kind: "empty", attempts: 1, usage: FIXTURE_USAGE });
  });

  it("never throws, whatever the provider does", async () => {
    const outcomes: Array<Response | Error> = [
      new Response("nope", { status: 500 }),
      new Response("{", { status: 200 }),
      new TypeError("boom"),
      openAiOk([]),
      openAiOk([messageItem("x")], "incomplete"),
    ];
    for (const outcome of outcomes) {
      const harness = makeHarness([outcome]);
      await expect(generate(harness)).resolves.toBeDefined();
    }
  });
});

// ── 8. Official non-completed synchronous response states ─────────────────

describe("a 200 whose status is not completed", () => {
  it.each([
    // Our own 4096 ceiling stopped the generation. On a reasoning model this
    // can be reached during reasoning, before any visible text exists — one of
    // the reasons this adapter stays unregistered until 001C sets a real
    // output/reasoning policy.
    ["incomplete"],
    // Documented response states that a synchronous call should never treat as
    // a finished answer.
    ["in_progress"],
    ["queued"],
    ["failed"],
    ["cancelled"],
    ["some_future_status"],
  ])("reports status=%s as incomplete_response", async (status) => {
    const harness = makeHarness([openAiOk([messageItem('{"tldr":"trunc')], status)]);
    expect(await generate(harness)).toEqual({
      ok: false,
      kind: "incomplete_response",
      attempts: 1,
      usage: FIXTURE_USAGE,
    });
  });

  it("does NOT return the truncated text as a successful answer", async () => {
    const harness = makeHarness([
      openAiOk([messageItem('{"tldr":"a half-written ans')], "incomplete"),
    ]);
    const result = await generate(harness);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("half-written");
  });

  it("does NOT report it as empty, even when there is no output text at all", async () => {
    // The distinction this kind exists for: "the model answered with nothing"
    // and "the model was cut off before answering" are different diagnoses.
    // A reasoning model hitting the ceiling mid-reasoning looks exactly like
    // this, and calling it `empty` would send someone looking in the wrong
    // place.
    const harness = makeHarness([openAiOk([reasoningItem("cut off")], "incomplete")]);
    expect(await generate(harness)).toEqual({
      ok: false,
      kind: "incomplete_response",
      attempts: 1,
      usage: FIXTURE_USAGE,
    });
  });

  it("leaks neither the status, incomplete_details nor an error object", async () => {
    const harness = makeHarness([
      new Response(
        JSON.stringify({
          status: "failed",
          output: [],
          incomplete_details: { reason: "max_output_tokens" },
          error: { code: "server_error", message: "LEAKED-ERROR-MESSAGE" },
        }),
        { status: 200 },
      ),
    ]);
    const result = await generate(harness);
    const asText = JSON.stringify(result);
    // This hand-built envelope carries no usage block, so none is reported.
    expect(result).toEqual({ ok: false, kind: "incomplete_response", attempts: 1, usage: NO_USAGE });
    expect(asText).not.toContain("LEAKED-ERROR-MESSAGE");
    expect(asText).not.toContain("max_output_tokens");
    expect(asText).not.toContain("server_error");
    expect(asText).not.toContain("failed");
  });
});

// ── 9. The privacy boundary ───────────────────────────────────────────────

describe("nothing provider-shaped or sensitive escapes", () => {
  const SENSITIVE = [
    API_KEY,
    SYSTEM_INSTRUCTION,
    USER_CONTENT,
    "SENTINEL",
    "api.openai.com",
    "Bearer",
    "Authorization",
    "PROVIDER-ERROR-BODY",
  ];

  it("returns no provider body, header, URL or envelope on failure", async () => {
    const outcomes: Array<Response | Error> = [
      new Response(JSON.stringify({ error: { message: "PROVIDER-ERROR-BODY" } }), {
        status: 429,
        headers: { "retry-after": "30", "x-request-id": "req_LEAKED" },
      }),
      new Response("PROVIDER-ERROR-BODY", { status: 500 }),
      new Response("PROVIDER-ERROR-BODY", { status: 200 }),
      openAiOk([]),
      openAiOk([messageItem("x")], "incomplete"),
      new TypeError(`failed to reach https://api.openai.com with ${API_KEY}`),
    ];
    for (const outcome of outcomes) {
      const harness = makeHarness([outcome]);
      const result = await generate(harness);
      expect(result.ok).toBe(false);
      const asText = JSON.stringify(result);
      for (const secret of SENSITIVE) expect(asText).not.toContain(secret);
      expect(asText).not.toContain("req_LEAKED");
      expect(asText).not.toContain("retry-after");
      // `usage` joined the bounded shape in AI-MULTI-PROVIDER-001D, as the
      // sanitized provider-neutral vocabulary — never OpenAI's own usage object.
      expect(Object.keys(result).sort().join(",")).toMatch(
        /^(attempts,kind,ok,usage|attempts,kind,ok,status,usage)$/,
      );
    }
  });

  it("leaks nothing through a Project or Tag name in the prompt", async () => {
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
      new TypeError(`https://api.openai.com ${API_KEY}`),
    ];
    for (const outcome of outcomes) {
      const harness = makeHarness([outcome]);
      await generate(harness);
      for (const line of harness.warns) {
        for (const secret of SENSITIVE) expect(line).not.toContain(secret);
        expect(line).toMatch(/^test-op provider_[a-z_]+(=\d+)? attempt=1 retry=0$/);
      }
    }
  });

  it("is silent when no logger is supplied", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 500 }));
    const result = await OPENAI_AI_PROVIDER_ADAPTER.generate(MODEL, REQUEST, POLICY, {
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
      openAiOk([messageItem('{"existingProjects":[],"existingTags":[]}')]),
    ]);
    const result = await generate(harness);
    expect(result).toEqual({
      ok: true,
      text: '{"existingProjects":[],"existingTags":[]}',
      attempts: 1,
      usage: FIXTURE_USAGE,
    });
    expect(result).not.toHaveProperty("existingProjects");
    expect(result).not.toHaveProperty("suggestions");
  });
});
