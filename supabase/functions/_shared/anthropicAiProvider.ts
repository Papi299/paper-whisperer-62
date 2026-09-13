// The Anthropic (Claude Messages API) provider adapter — AI-MULTI-PROVIDER-001B.
//
// ## REGISTERED SINCE AI-MULTI-PROVIDER-001C — and still unreachable
//
// 001B implemented this protocol and deliberately left it out of the registry,
// because Claude Sonnet 5 runs ADAPTIVE THINKING BY DEFAULT at effort `high`
// and `max_tokens` is a hard ceiling on thinking plus response text together:
// registering it before PaperLume had decided its own reasoning and output
// policy would have adopted Anthropic's defaults as PaperLume's product policy
// by omission. 001C decides that policy (C41), so `anthropic` is now a
// registered provider in `_shared/aiProviderRegistry.ts`, every request this
// module builds carries an EXPLICIT PaperLume reasoning configuration, and the
// output ceiling arrives from the calling operation instead of being invented
// here.
//
// Registration is not the same as reachability, and nothing in Production can
// reach this yet. There is no `anthropic/*` row in `ai_model_catalog`, so model
// selection has nothing to route here; no `ANTHROPIC_API_KEY` exists on any
// server; and the Edge Functions that would import it are not deployed. Adding
// a catalog row, installing the secret and deploying the functions are three
// separate, separately authorized steps — see docs/deployment.md.
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
//   * Model `claude-sonnet-5` — active; thinking mode "adaptive only", ON by
//     default; `thinking: {type: "enabled", budget_tokens: N}` returns 400;
//     `thinking: {type: "disabled"}` IS accepted (the per-model configuration
//     table lists only `"enabled"` as rejected, and states that models marked
//     `On` "default to thinking but accept `thinking: {type: "disabled"}`");
//     sampling parameters (`temperature`, `top_p`, `top_k`) set to non-default
//     values return 400; assistant prefill returns 400; effort defaults to
//     `high`.
//   * Effort — `output_config.effort` is `low | medium | high | xhigh | max`,
//     all five supported on `claude-sonnet-5`, default `high`, and "effort
//     applies to every output token … it works whether or not thinking is
//     enabled". `adaptive` is explicitly NOT an effort value.
//   * `output_config` carries BOTH `effort` and `format` as sibling fields; the
//     Messages API request reference lists exactly those two.
//   * `max_tokens` — a hard ceiling on the whole turn, thinking included; a
//     long thinking pass that exhausts it returns `stop_reason: "max_tokens"`
//     with truncated or missing text.
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
  AiCallPolicy,
  AiGenerationRequest,
  AiProviderAdapter,
  AiProviderCallDeps,
  AiProviderModel,
  AiProviderResult,
  AiReasoningLevel,
} from "./aiProvider.ts";
import {
  AI_USAGE_INVALID,
  AI_USAGE_NOT_APPLICABLE,
  AI_USAGE_NOT_RETURNED,
  AI_USAGE_UNREPORTED,
  finalizeReportedUsage,
  readCountOrUnreported,
  readProviderTokenCount,
  reportedTokens,
  type AiProviderUsage,
} from "./aiUsage.ts";

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
 * The reasoning levels this adapter can express — AI-MULTI-PROVIDER-001C.
 *
 * Six, and they are two different Anthropic controls wearing one PaperLume
 * vocabulary:
 *
 *   * `off` is the THINKING control — `thinking: {type: "disabled"}`;
 *   * `low` … `max` are the EFFORT control — `output_config.effort`, whose five
 *     values Anthropic documents as exactly `low | medium | high | xhigh | max`
 *     on `claude-sonnet-5`.
 *
 * Google's `minimal` and OpenAI's `none` are absent because Anthropic has no
 * such values; an `AiCallPolicy<AnthropicReasoningLevel>` carrying either does
 * not compile, so the mistake cannot reach a request builder.
 */
export type AnthropicReasoningLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

/** In Anthropic's own order of increasing reasoning. */
export const ANTHROPIC_REASONING_LEVELS: readonly AnthropicReasoningLevel[] = Object.freeze([
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);

export function isAnthropicReasoningLevel(
  level: AiReasoningLevel,
): level is AnthropicReasoningLevel {
  return (ANTHROPIC_REASONING_LEVELS as readonly string[]).includes(level);
}

/**
 * The effort PaperLume pairs with DISABLED thinking.
 *
 * `off` means "do not think", and Anthropic's effort parameter is a separate
 * control that "applies to every output token … whether or not thinking is
 * enabled". Sending `thinking: {type: "disabled"}` and nothing else would
 * therefore leave effort at its `high` default: PaperLume would have turned
 * thinking off while silently keeping the most expensive output policy the API
 * has, which is the opposite of what a user choosing "Off" asked for.
 *
 * `low` is the documented floor and the semantically right partner for it.
 *
 * It is also the safe one. Anthropic documents that disabling thinking at
 * effort `xhigh` or `max` is a 400 on Claude Opus 5 "and later models"; pairing
 * `off` with the LOWEST effort keeps this mapping valid under that rule however
 * it is extended, rather than depending on Sonnet 5 being outside it.
 */
const ANTHROPIC_DISABLED_THINKING_EFFORT = "low";

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
 * What is present is the documented minimum for one stateless generation, plus
 * PaperLume's explicit reasoning and output policy. What is ABSENT is still the
 * reviewed part:
 *
 *   * no `temperature`, `top_p` or `top_k` — Sonnet 5 returns 400 for a
 *     non-default value, and PaperLume sets no sampling parameters anywhere;
 *   * no assistant prefill — Sonnet 5 returns 400, and the schema below is the
 *     documented replacement for prefill-as-JSON-coercion;
 *   * no `budget_tokens` and no `thinking: {type: "enabled"}` — Sonnet 5
 *     rejects manual extended thinking with a 400, and a token budget would be
 *     a second, drifting expression of a policy the catalog states in words;
 *   * no `tools`, no `tool_choice` — this is a text generation, not an agent;
 *   * no `cache_control` — prompt caching is deliberately out of scope;
 *   * no `metadata`, no `user_id` — no user-identifying field is sent at all;
 *   * no `stream`, no `service_tier`, no beta header.
 *
 * `system` is the top-level string field rather than a message, which is where
 * Anthropic puts a system instruction, and the user content is the single
 * message of the conversation.
 *
 * ## The reasoning mapping — AI-MULTI-PROVIDER-001C (C41)
 *
 *     off    ->  thinking: {type: "disabled"}, output_config.effort: "low"
 *     low    ->  thinking: {type: "adaptive"},  output_config.effort: "low"
 *     medium ->  thinking: {type: "adaptive"},  output_config.effort: "medium"
 *     high   ->  thinking: {type: "adaptive"},  output_config.effort: "high"
 *     xhigh  ->  thinking: {type: "adaptive"},  output_config.effort: "xhigh"
 *     max    ->  thinking: {type: "adaptive"},  output_config.effort: "max"
 *
 * `thinking` is stated EXPLICITLY on every level, including the adaptive ones
 * where it happens to match Sonnet 5's current default. That is the entire
 * point of C41: a provider default is a fact about the provider on a given day,
 * not PaperLume's product policy, and the day Anthropic changes it this request
 * must not change with it.
 *
 * `output_config` carries `format` AND `effort` as siblings — the two fields
 * the Messages API reference lists for that object. The format object is built
 * once and the effort key is added beside it, never over it: overwriting
 * `output_config` to set effort would silently drop structured output, and the
 * operations' parsers would then be the only thing standing between a prose
 * answer and the user.
 *
 * A `provider_default` directive sends NEITHER `thinking` NOR `effort` — the
 * fail-open path for unusable policy metadata. `format` and `max_tokens` still
 * go, because they are not reasoning policy: the operation's output contract
 * and PaperLume's safety ceiling hold regardless of what the catalog could tell
 * us about reasoning.
 */
export function buildAnthropicRequestBody(
  model: AnthropicAiProviderModel,
  request: AiGenerationRequest,
  policy: AiCallPolicy<AnthropicReasoningLevel>,
): Record<string, unknown> {
  const outputConfig: Record<string, unknown> = {
    format: {
      type: ANTHROPIC_OUTPUT_FORMAT_TYPE[request.responseFormat],
      // The operation's schema, passed through verbatim. This module does not
      // inspect, extend or repair it: what the fields MEAN is PaperLume
      // product semantics and stays on the operation's side of C39's line.
      schema: request.jsonSchema.schema,
    },
  };

  const body: Record<string, unknown> = {
    model: model.providerModel,
    // PaperLume's hard ceiling for THIS operation, bounding thinking and answer
    // together. It arrives from the caller rather than being a constant here,
    // because how much room an answer needs is the operation's knowledge and an
    // adapter that guessed would be guessing about Projects and Tags.
    max_tokens: policy.maxOutputTokens,
    system: request.systemInstruction,
    messages: [{ role: "user", content: request.userContent }],
    output_config: outputConfig,
  };

  if (policy.reasoning.kind === "level") {
    const level = policy.reasoning.level;
    body.thinking = { type: level === "off" ? "disabled" : "adaptive" };
    outputConfig.effort = level === "off" ? ANTHROPIC_DISABLED_THINKING_EFFORT : level;
  }

  return body;
}

/**
 * The exact `RequestInit`. The credential appears in `x-api-key` and nowhere
 * else — not in the URL, not in a query parameter, not in the body. The
 * caller's own Supabase bearer token is never anywhere near this.
 */
export function buildAnthropicRequestInit(
  model: AnthropicAiProviderModel,
  request: AiGenerationRequest,
  policy: AiCallPolicy<AnthropicReasoningLevel>,
  apiKey: string,
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(buildAnthropicRequestBody(model, request, policy)),
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
 * The one cache-write retention bucket a single cache-write rate can price:
 * Anthropic's default 5-minute write (1.25x base input). A 1-hour write costs
 * 2x, so any tokens in another bucket are unmodeled usage.
 */
const ANTHROPIC_DEFAULT_CACHE_WRITE_BUCKET = "ephemeral_5m_input_tokens";

/**
 * Report whether `usage` carries billable work outside the canonical
 * dimensions, or `null` if a count in it is malformed.
 *
 * Only numeric members are counts; a member of some other shape is a field this
 * reader does not know and is left alone rather than guessed at.
 */
function readAnthropicUnmodeledUsage(usage: Record<string, unknown>): boolean | null {
  let unmodeled = false;
  const scan = (value: unknown, modeledKey: string | null): boolean => {
    if (value === undefined || value === null) return true;
    if (!isPlainObject(value)) return false;
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw !== "number") continue;
      const read = readProviderTokenCount(raw);
      if (read.kind === "invalid") return false;
      if (read.kind === "value" && read.tokens > 0 && key !== modeledKey) unmodeled = true;
    }
    return true;
  };
  if (!scan(usage.cache_creation, ANTHROPIC_DEFAULT_CACHE_WRITE_BUCKET)) return null;
  if (!scan(usage.server_tool_use, null)) return null;
  return unmodeled;
}

/**
 * Read Anthropic's `usage` into PaperLume's usage vocabulary —
 * AI-MULTI-PROVIDER-001D.
 *
 * Absent or `null` is UNREPORTED here, never zero: this is a JSON API, not
 * proto3, so absence has no wire meaning of its own.
 *
 * ## Mapping (Anthropic prompt-caching and thinking documentation)
 *
 *     input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *                                  -> inputTokens. Anthropic's `input_tokens` is
 *                                     only the input AFTER the last cache
 *                                     breakpoint, and its documented total is
 *                                     the sum of the three — so they are summed,
 *                                     and only when all three are reported.
 *     cache_read_input_tokens      -> cachedInputTokens
 *     cache_creation_input_tokens  -> cacheWriteInputTokens
 *     output_tokens                -> outputTokens — "the inclusive,
 *                                     authoritative total used for billing",
 *                                     thinking included
 *     output_tokens_details.thinking_tokens
 *                                  -> reasoningOutputTokens (≤ output_tokens)
 *     (no total field)             -> providerTotalTokens: not applicable
 *
 * Unmodeled usage is a cache write outside the default 5-minute bucket, or any
 * positive server-tool count. PaperLume sends no `cache_control` and no tools,
 * and Anthropic caching is opt-in, so both should read zero; if they do not,
 * the estimate says it is a lower bound.
 */
export function readAnthropicUsage(payload: unknown): AiProviderUsage {
  if (!isPlainObject(payload)) return AI_USAGE_NOT_RETURNED;
  const usage = payload.usage;
  if (usage === undefined || usage === null) return AI_USAGE_NOT_RETURNED;
  if (!isPlainObject(usage)) return AI_USAGE_INVALID;

  const afterBreakpoint = readCountOrUnreported(usage.input_tokens);
  const cacheWrite = readCountOrUnreported(usage.cache_creation_input_tokens);
  const cacheRead = readCountOrUnreported(usage.cache_read_input_tokens);
  const output = readCountOrUnreported(usage.output_tokens);
  if (afterBreakpoint === null || cacheWrite === null || cacheRead === null || output === null) {
    return AI_USAGE_INVALID;
  }

  let thinking = AI_USAGE_UNREPORTED;
  const details = usage.output_tokens_details;
  if (details !== undefined && details !== null) {
    if (!isPlainObject(details)) return AI_USAGE_INVALID;
    const read = readCountOrUnreported(details.thinking_tokens);
    if (read === null) return AI_USAGE_INVALID;
    thinking = read;
  }

  const unmodeled = readAnthropicUnmodeledUsage(usage);
  if (unmodeled === null) return AI_USAGE_INVALID;

  const input =
    afterBreakpoint.state === "reported" &&
    cacheWrite.state === "reported" &&
    cacheRead.state === "reported"
      ? reportedTokens(afterBreakpoint.tokens + cacheWrite.tokens + cacheRead.tokens)
      : AI_USAGE_UNREPORTED;

  return finalizeReportedUsage(
    {
      inputTokens: input,
      cachedInputTokens: cacheRead,
      cacheWriteInputTokens: cacheWrite,
      outputTokens: output,
      reasoningOutputTokens: thinking,
      providerTotalTokens: AI_USAGE_NOT_APPLICABLE,
    },
    unmodeled,
  );
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
  policy: AiCallPolicy<AnthropicReasoningLevel>,
  deps: AiProviderCallDeps,
): Promise<AiProviderResult> {
  const attempts = ANTHROPIC_PROVIDER_ATTEMPTS;
  const createTimeoutSignal =
    deps.createTimeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const signal = createTimeoutSignal(ANTHROPIC_PROVIDER_TIMEOUT_MS);

  let response: Response;
  try {
    response = await deps.fetchImpl(ANTHROPIC_MESSAGES_URL, {
      ...buildAnthropicRequestInit(model, request, policy, deps.apiKey),
      signal,
    });
  } catch (error) {
    // Our own ceiling ending the attempt is reported as `timeout`, which means
    // "we stopped waiting while the provider may still have been generating".
    // Anything else is an ordinary transport failure. The thrown value itself
    // is discarded: a fetch error's message can quote the URL.
    const kind = isTimeout(error, signal) ? "timeout" : "network";
    deps.logger?.warn(`${deps.label} provider_${kind} attempt=${attempts} retry=0`);
    return { ok: false, kind, attempts, usage: AI_USAGE_NOT_RETURNED };
  }

  if (!response.ok) {
    // Status and attempt count only. The body is never read, so an Anthropic
    // error envelope — which can echo request content — cannot be logged, and
    // `request-id` and rate-limit headers are never touched.
    deps.logger?.warn(
      `${deps.label} provider_status=${response.status} attempt=${attempts} retry=0`,
    );
    return {
      ok: false,
      kind: "http",
      status: response.status,
      attempts,
      usage: AI_USAGE_NOT_RETURNED,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A 2xx whose body is not JSON at all. The parse error's message can quote
    // the body, so it is discarded rather than returned or logged.
    return { ok: false, kind: "unreadable_response", attempts, usage: AI_USAGE_NOT_RETURNED };
  }

  if (!isPlainObject(payload) || !Array.isArray(payload.content)) {
    return { ok: false, kind: "unreadable_response", attempts, usage: AI_USAGE_NOT_RETURNED };
  }

  const stopReason = payload.stop_reason;
  if (typeof stopReason !== "string") {
    // A 200 that does not carry Anthropic's terminal-state field is not an
    // Anthropic response envelope this module knows how to trust.
    return { ok: false, kind: "unreadable_response", attempts, usage: AI_USAGE_NOT_RETURNED };
  }
  if (stopReason !== ANTHROPIC_COMPLETE_STOP_REASON) {
    // Checked BEFORE the text is read, on purpose: a `max_tokens` response
    // still carries text, and that text is a truncated answer. Returning it
    // would hand the operation's parser a half-written JSON object and call it
    // a successful generation. The reason itself does not cross the boundary —
    // only the bounded kind does.
    // Its usage IS returned: a truncated or declined generation was still
    // billed, and a truthful cost record needs the numbers.
    return { ok: false, kind: "incomplete_response", attempts, usage: readAnthropicUsage(payload) };
  }

  const usage = readAnthropicUsage(payload);
  const text = extractAnthropicText(payload);
  if (text === undefined) {
    return { ok: false, kind: "unreadable_response", attempts, usage: AI_USAGE_NOT_RETURNED };
  }
  if (text === null) return { ok: false, kind: "empty", attempts, usage };

  return { ok: true, text, attempts, usage };
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
 * The Anthropic adapter — implemented, reviewed, and registered since
 * AI-MULTI-PROVIDER-001C.
 *
 * `_shared/aiProviderRegistry.ts` imports this constant, so a valid enabled
 * `anthropic` catalog row would now be honoured rather than falling back with
 * `unsupported_provider`. No such row exists, and creating one is a separate
 * reviewed migration.
 */
export const ANTHROPIC_AI_PROVIDER_ADAPTER: AiProviderAdapter<
  typeof ANTHROPIC_AI_PROVIDER,
  AnthropicReasoningLevel
> = {
  provider: ANTHROPIC_AI_PROVIDER,
  reasoningLevels: ANTHROPIC_REASONING_LEVELS,
  supportsReasoningLevel: isAnthropicReasoningLevel,
  generate,
};
