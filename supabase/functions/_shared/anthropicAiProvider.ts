// The Anthropic (Claude Messages API) provider adapter — AI-MULTI-PROVIDER-001B.
//
// ## THIS ADAPTER IS DELIBERATELY NOT REGISTERED
//
// It implements a real, reviewed protocol, and nothing in PaperLume can reach
// it. `_shared/aiProviderRegistry.ts` still registers `google` and only
// `google`, so a catalog row naming `anthropic` still falls back to the system
// default with `unsupported_provider`, the Settings surface still offers Google
// models only, and no Anthropic credential exists on any server.
//
// That is a safety requirement, not unfinished work. Claude Sonnet 5 runs
// ADAPTIVE THINKING BY DEFAULT at effort `high` (Anthropic's Sonnet 5 migration
// guide: "adaptive thinking is on by default"), and `max_tokens` is a hard
// ceiling on thinking plus response text together. Registering this adapter
// before PaperLume has decided its own per-operation reasoning and output
// policy would not be "shipping a provider" — it would be adopting Anthropic's
// defaults as PaperLume's product policy by omission, and at the provisional
// ceiling below a long thinking pass could consume the budget the answer needs.
// Choosing that policy is AI-MULTI-PROVIDER-001C's job, and registration waits
// for it. This module therefore sends NO `thinking` key at all: 001B states no
// reasoning opinion, rather than encoding a guess at one.
//
// ## What this module owns, and only this module
//
// The endpoint, the POST, the `x-api-key` credential header, the
// `anthropic-version` header, the top-level `model` / `system` / `messages` /
// `max_tokens` envelope, Anthropic's structured-output vocabulary, its response
// envelope, its terminal-state field, and its own transport policy. C39's line
// holds: nothing here knows what a Project, a Tag, a TLDR or a study type is,
// nothing here touches quota, and nothing here picks a PaperLume HTTP status.
//
// ## Privacy boundary
//
// Nothing provider-shaped escapes. The URL, the headers, the request body, the
// raw `Response`, Anthropic's error envelope and any `request-id` all stay
// inside this module; callers get generated text or a bounded failure kind.
// That is what keeps a diagnostic log line incapable of carrying an API key, an
// Anthropic error body or a user's paper.
//
// ## No SDK
//
// Native `fetch`, exactly like the Google adapter — no `@anthropic-ai/sdk`.
// Four reasons, all repository-level: the Edge bundle stays small, the bytes on
// the wire stay reviewable in one file, the tests stay deterministic with an
// injected fetch, and no dependency or lockfile churn enters a task whose
// output ships nothing to Production. An SDK would also bring its own retry and
// timeout policy, which is precisely the thing C39 says must not be assumed
// shared between providers.
//
// Pure module (no Deno APIs, no remote imports): Vitest exercises the shipped
// code with an injected `fetch`.
//
// ## Official documentation this was written from
//
//   * Model `claude-sonnet-5` — active; adaptive thinking on by default;
//     `thinking: {type: "enabled", budget_tokens: N}` returns 400; sampling
//     parameters (`temperature`, `top_p`, `top_k`) set to non-default values
//     return 400; assistant prefill returns 400; effort defaults to `high`.
//   * Messages API — `POST https://api.anthropic.com/v1/messages`, headers
//     `x-api-key`, `anthropic-version: 2023-06-01`, `content-type`.
//   * Structured outputs — `output_config.format` with `type: "json_schema"`
//     and `schema`; supported on `claude-sonnet-5`; NO beta header required
//     (the legacy `structured-outputs-2025-11-13` header is accepted only for
//     transition, so this module does not send it); the schema must set
//     `additionalProperties: false` and list `required`; numeric and string
//     length constraints are not supported.
//   * Response — `content` is an ARRAY of blocks; the answer is in `text`
//     blocks; `thinking` blocks can precede the first `text` block, so reading
//     by position is explicitly called out as wrong.

import type {
  AiGenerationRequest,
  AiProviderAdapter,
  AiProviderCallDeps,
  AiProviderModel,
  AiProviderResult,
} from "./aiProvider.ts";

/** The provider id `ai_model_catalog.provider` would use for Anthropic. */
export const ANTHROPIC_AI_PROVIDER = "anthropic";

/**
 * A model this adapter can serve: provider `anthropic`, nothing wider.
 *
 * Deliberately NOT narrowed to `claude-sonnet-5`. Which Anthropic model strings
 * PaperLume authorizes is the DATABASE's decision (`ai_model_catalog`), exactly
 * as it is for Gemini — a TypeScript allowlist here would be a second
 * authorization surface that could disagree with the first (C33/C35/C39). The
 * adapter sends whatever trusted `providerModel` it is handed.
 */
export type AnthropicAiProviderModel = AiProviderModel<typeof ANTHROPIC_AI_PROVIDER>;

/** The one Anthropic endpoint this repository would call. */
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** The API version header value Anthropic's current documentation requires. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * 001B PROVISIONAL ADAPTER CEILING — not a product budget.
 *
 * Anthropic's Messages API requires `max_tokens`, so this adapter cannot avoid
 * naming a number. 4096 is a conservative value chosen only to exercise the
 * protocol; it is NOT a considered per-operation output budget, and it is one
 * of the reasons this adapter must not be registered: with adaptive thinking on
 * by default, `max_tokens` bounds thinking and answer TOGETHER.
 * AI-MULTI-PROVIDER-001C replaces this with an explicit per-operation
 * output/reasoning policy.
 */
export const ANTHROPIC_PROVISIONAL_MAX_TOKENS = 4096;

/**
 * Per-attempt ceiling — this adapter's own, not the Gemini transport's.
 *
 * Chosen rather than copied. `_shared/geminiTransport.ts` currently runs a
 * TEMPORARY 90 s Production diagnostic value, and C39's whole point is that one
 * provider's transport constants are not evidence about another's.
 *
 * 60 s, because the generation here is hard-bounded: `max_tokens` above caps
 * thinking and answer together at 4096 tokens, so a Sonnet 5 call cannot run
 * long the way an unbounded one could. Supabase documents a 150 s wall-clock
 * and idle limit for hosted Edge Functions, and with a single attempt (below)
 * the worst case is exactly one 60 s wait — leaving 90 s of that envelope for
 * everything else the request does. AI-MULTI-PROVIDER-001F may tune it against
 * a real Production canary; until then nothing measured justifies a larger one.
 */
export const ANTHROPIC_PROVIDER_TIMEOUT_MS = 60_000;

/**
 * Attempts per user action. ONE — no automatic retry.
 *
 * The conservative baseline for a protocol that has never run against the real
 * provider: a retry cannot duplicate a paid request if there is no retry.
 * Gemini's bounded 429/5xx retry budget exists because Production evidence
 * shaped it; this adapter has no such evidence, and inventing a retry policy
 * from another provider's incident history is exactly the assumption C39
 * rejects. `Retry-After` is deliberately not read, and no backoff is slept.
 */
export const ANTHROPIC_PROVIDER_ATTEMPTS = 1;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PaperLume's `responseFormat` expressed in Anthropic's vocabulary.
 *
 * A lookup rather than a literal, mirroring the Google adapter: a future format
 * has to be given an Anthropic spelling here instead of silently inheriting
 * `json_schema`.
 */
const ANTHROPIC_OUTPUT_FORMAT_TYPE: Record<AiGenerationRequest["responseFormat"], string> = {
  json: "json_schema",
};

/**
 * The Anthropic request body.
 *
 * What is present is the documented minimum for one stateless generation. What
 * is ABSENT is the reviewed part:
 *
 *   * no `thinking` — 001B states no reasoning policy (see the header);
 *   * no `temperature`, `top_p` or `top_k` — Sonnet 5 returns 400 for a
 *     non-default value, and PaperLume sets no sampling parameters anywhere;
 *   * no assistant prefill — Sonnet 5 returns 400, and the schema below is the
 *     documented replacement for prefill-as-JSON-coercion;
 *   * no `tools`, no `tool_choice` — this is a text generation, not an agent;
 *   * no `cache_control` — prompt caching is deliberately out of 001B's scope;
 *   * no `metadata`, no `user_id` — no user-identifying field is sent at all;
 *   * no `stream`, no `service_tier`, no beta header.
 *
 * `system` is the top-level string field rather than a message, which is where
 * Anthropic puts a system instruction, and the user content is the single
 * message of the conversation.
 */
export function buildAnthropicRequestBody(
  model: AnthropicAiProviderModel,
  request: AiGenerationRequest,
): Record<string, unknown> {
  return {
    model: model.providerModel,
    max_tokens: ANTHROPIC_PROVISIONAL_MAX_TOKENS,
    system: request.systemInstruction,
    messages: [{ role: "user", content: request.userContent }],
    output_config: {
      format: {
        type: ANTHROPIC_OUTPUT_FORMAT_TYPE[request.responseFormat],
        // The operation's schema, passed through verbatim. This module does not
        // inspect, extend or repair it: what the fields MEAN is PaperLume
        // product semantics and stays on the operation's side of C39's line.
        schema: request.jsonSchema.schema,
      },
    },
  };
}

/**
 * The exact `RequestInit`. The credential appears in `x-api-key` and nowhere
 * else — not in the URL, not in a query parameter, not in the body. The
 * caller's own Supabase bearer token is never anywhere near this.
 */
export function buildAnthropicRequestInit(
  model: AnthropicAiProviderModel,
  request: AiGenerationRequest,
  apiKey: string,
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(buildAnthropicRequestBody(model, request)),
  };
}

/**
 * The `stop_reason` that means "Claude finished the answer it was asked for".
 *
 * Every other documented value is a real outcome this request shape should not
 * treat as a completed answer: `max_tokens` means the ceiling truncated it,
 * `refusal` means a safeguard declined it, and `stop_sequence` / `tool_use`
 * cannot arise from a request that sends neither. Gating on the one expected
 * value fails closed on anything new, which is the right default for a protocol
 * that has never run against the real provider.
 */
const ANTHROPIC_COMPLETE_STOP_REASON = "end_turn";

/**
 * Pull the model's generated text out of an Anthropic Messages payload.
 *
 * `content` is an ARRAY of blocks and this walks all of it, because reading
 * `content[0]` is wrong on Sonnet 5 today and will be wronger later:
 *
 *   * `thinking` blocks can precede the first `text` block whenever thinking is
 *     on — which is Sonnet 5's DEFAULT — so position means nothing;
 *   * only `type: "text"` blocks are collected, in the order Anthropic returned
 *     them, and concatenated;
 *   * every other block kind is ignored. A `thinking` block is never returned
 *     as the generated answer, so a future 001C decision to enable thinking for
 *     Suggest cannot start leaking reasoning into a user-visible suggestion.
 *
 * Returns `null` when there is no generated text, which the caller reports as
 * `empty`; returns `undefined` when the payload is not an Anthropic response
 * envelope at all, which the caller reports as `unreadable_response`. Each step
 * is checked structurally rather than with optional chaining, so an envelope
 * that merely resembles Anthropic's cannot be read as one.
 *
 * A whitespace-only string is deliberately RETURNED rather than treated as
 * absent, exactly as in the Google adapter: "the provider generated nothing
 * usable" is the operation's judgement, and this module answers only "did the
 * provider return generated text".
 */
export function extractAnthropicText(payload: unknown): string | null | undefined {
  if (!isPlainObject(payload)) return undefined;
  const content = payload.content;
  if (!Array.isArray(content)) return undefined;

  let text = "";
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type !== "text") continue;
    if (typeof block.text !== "string") continue;
    text += block.text;
  }

  return text === "" ? null : text;
}

/**
 * Send one generation request to Anthropic and normalize the outcome.
 *
 * Never throws: every provider-side outcome — transport, HTTP, unreadable body,
 * unfinished generation, no text — is a value, so an operation that has already
 * consumed a quota unit always reaches its own refund path.
 *
 * The transport is deliberately written here rather than shared. C39 rejected
 * the assumption that two providers have the same timeout, retry and
 * idempotency semantics, so this is a single attempt under this adapter's own
 * ceiling with no backoff — not a call into `geminiTransport.ts`, and not a new
 * "universal AI transport" that would quietly assert the equivalence C39 denies.
 */
async function generate(
  model: AnthropicAiProviderModel,
  request: AiGenerationRequest,
  deps: AiProviderCallDeps,
): Promise<AiProviderResult> {
  const attempts = ANTHROPIC_PROVIDER_ATTEMPTS;
  const createTimeoutSignal =
    deps.createTimeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const signal = createTimeoutSignal(ANTHROPIC_PROVIDER_TIMEOUT_MS);

  let response: Response;
  try {
    response = await deps.fetchImpl(ANTHROPIC_MESSAGES_URL, {
      ...buildAnthropicRequestInit(model, request, deps.apiKey),
      signal,
    });
  } catch (error) {
    // Our own ceiling ending the attempt is reported as `timeout`, which means
    // "we stopped waiting while the provider may still have been generating".
    // Anything else is an ordinary transport failure. The thrown value itself
    // is discarded: a fetch error's message can quote the URL.
    const kind = isTimeout(error, signal) ? "timeout" : "network";
    deps.logger?.warn(`${deps.label} provider_${kind} attempt=${attempts} retry=0`);
    return { ok: false, kind, attempts };
  }

  if (!response.ok) {
    // Status and attempt count only. The body is never read, so an Anthropic
    // error envelope — which can echo request content — cannot be logged, and
    // `request-id` and rate-limit headers are never touched.
    deps.logger?.warn(
      `${deps.label} provider_status=${response.status} attempt=${attempts} retry=0`,
    );
    return { ok: false, kind: "http", status: response.status, attempts };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A 2xx whose body is not JSON at all. The parse error's message can quote
    // the body, so it is discarded rather than returned or logged.
    return { ok: false, kind: "unreadable_response", attempts };
  }

  if (!isPlainObject(payload) || !Array.isArray(payload.content)) {
    return { ok: false, kind: "unreadable_response", attempts };
  }

  const stopReason = payload.stop_reason;
  if (typeof stopReason !== "string") {
    // A 200 that does not carry Anthropic's terminal-state field is not an
    // Anthropic response envelope this module knows how to trust.
    return { ok: false, kind: "unreadable_response", attempts };
  }
  if (stopReason !== ANTHROPIC_COMPLETE_STOP_REASON) {
    // Checked BEFORE the text is read, on purpose: a `max_tokens` response
    // still carries text, and that text is a truncated answer. Returning it
    // would hand the operation's parser a half-written JSON object and call it
    // a successful generation. The reason itself does not cross the boundary —
    // only the bounded kind does.
    return { ok: false, kind: "incomplete_response", attempts };
  }

  const text = extractAnthropicText(payload);
  if (text === undefined) return { ok: false, kind: "unreadable_response", attempts };
  if (text === null) return { ok: false, kind: "empty", attempts };

  return { ok: true, text, attempts };
}

/**
 * Read a throwable's `name` without assuming it is an `Error`.
 *
 * `AbortSignal.timeout` rejects with a `DOMException`, whose relationship to
 * `Error` has varied across runtimes and spec revisions, so the check is
 * structural — the same reasoning as `_shared/geminiTransport.ts`.
 */
function throwableName(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

/**
 * Did this attempt end at our own ceiling? The signal passed to `fetchImpl` is
 * the only abort source in this module, so an `AbortError` raised while that
 * signal is aborted is our timeout wearing another runtime's name.
 */
function isTimeout(error: unknown, signal: AbortSignal): boolean {
  const name = throwableName(error);
  if (name === "TimeoutError") return true;
  return name === "AbortError" && signal.aborted;
}

/**
 * The Anthropic adapter — implemented, reviewed, and NOT registered.
 *
 * `_shared/aiProviderRegistry.ts` does not import this constant, and
 * AI-MULTI-PROVIDER-001B must not make it do so. Tests import this module
 * directly; a registry entry is never needed to exercise an adapter, and if it
 * ever seemed to be, the design would be wrong.
 */
export const ANTHROPIC_AI_PROVIDER_ADAPTER: AiProviderAdapter<typeof ANTHROPIC_AI_PROVIDER> = {
  provider: ANTHROPIC_AI_PROVIDER,
  generate,
};
