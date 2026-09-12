// The OpenAI (Responses API) provider adapter — AI-MULTI-PROVIDER-001B.
//
// ## REGISTERED SINCE AI-MULTI-PROVIDER-001C — and still unreachable
//
// 001B implemented this protocol and deliberately left it out of the registry:
// GPT-5.6 Terra is a reasoning model whose `reasoning.effort` defaults to
// `medium`, and reasoning tokens are billed as output tokens and counted
// against `max_output_tokens`, so registering it before PaperLume had decided
// its own per-operation reasoning and output policy would have adopted OpenAI's
// default as PaperLume's product policy by omission. 001C decides that policy
// (C41), so `openai` is now a registered provider in
// `_shared/aiProviderRegistry.ts`, every request this module builds carries an
// EXPLICIT `reasoning.effort`, and the output ceiling arrives from the calling
// operation instead of being invented here.
//
// Registration is not the same as reachability, and nothing in Production can
// reach this yet. There is no `openai/*` row in `ai_model_catalog`, so model
// selection has nothing to route here; no `OPENAI_API_KEY` exists on any
// server; and the Edge Functions that would import it are not deployed. Adding
// a catalog row, installing the secret and deploying the functions are three
// separate, separately authorized steps — see docs/deployment.md.
//
// ## Responses API, not Chat Completions
//
// The current API, as OpenAI documents it for reasoning models. A legacy
// `/v1/chat/completions` integration would be a new implementation of an older
// contract on its first day, and would not express `store` at all.
//
// ## Privacy — `store: false` is the point, not a detail
//
// OpenAI's Responses API STORES responses by default: omit `store` and response
// objects are retained (30 days, visible in the dashboard) until explicitly
// disabled. PaperLume sends paper titles and abstracts, so every request this
// module builds sets `store: false` explicitly, and a permanent test asserts
// it. Nothing else identifying is sent either — no `metadata`, no
// `safety_identifier`, no `user`, no `conversation`, no `previous_response_id`.
// This is one stateless generation call and nothing more.
//
// ## What this module owns, and only this module
//
// The endpoint, the POST, the `Authorization: Bearer` header, the
// `model` / `instructions` / `input` envelope, OpenAI's structured-output
// vocabulary, its output-item traversal, its `status` field, and its own
// transport policy. C39's line holds: nothing here knows what a Project, a Tag,
// a TLDR or a study type is, nothing here touches quota, and nothing here picks
// a PaperLume HTTP status.
//
// ## No SDK
//
// Native `fetch`, exactly like the Google adapter — no `openai` package. The
// Edge bundle stays small, the bytes on the wire stay reviewable in one file,
// the tests stay deterministic with an injected fetch, and no dependency or
// lockfile churn enters a task whose output ships nothing to Production. An SDK
// would also bring its own retry and timeout policy, which is precisely the
// thing C39 says must not be assumed shared between providers.
//
// Pure module (no Deno APIs, no remote imports): Vitest exercises the shipped
// code with an injected `fetch`.
//
// ## Official documentation this was written from
//
//   * Model `gpt-5.6-terra` — current model id; a reasoning model whose model
//     page lists `reasoning.effort` as "none, low, medium (default), high,
//     xhigh, and max". Notably it does NOT offer the `minimal` that exists
//     elsewhere in the family, which is why this adapter's vocabulary is six
//     values and not seven. Supports the Responses API and structured outputs.
//   * Reasoning tokens "occupy space in the model's context window and are
//     billed as output tokens", and a response that exhausts `max_output_tokens`
//     returns `status: "incomplete"` with reason `max_output_tokens` — possibly
//     with no visible text at all.
//   * Responses API — `POST https://api.openai.com/v1/responses`, headers
//     `Authorization: Bearer …` and `Content-Type: application/json`;
//     `instructions`, `input`, `max_output_tokens`, `store`.
//   * `store` — responses are saved by default; "You can disable this behavior
//     by setting `store` to `false`".
//   * Structured outputs — `text.format` with `type: "json_schema"`, a required
//     `name`, `schema`, and `strict`; under `strict` the schema must set
//     `additionalProperties: false` and list every property in `required`;
//     `minItems`/`maxItems`/`minLength`/`maxLength`/`pattern` are not supported.
//   * Response — `output` is an ARRAY whose items include `reasoning` items
//     (which may precede the message) and `message` items whose `content`
//     carries `output_text` (and `refusal`); `status` is `completed` /
//     `incomplete` / `in_progress` / `queued`, with `incomplete_details.reason`
//     naming e.g. `max_output_tokens`.

import type {
  AiCallPolicy,
  AiGenerationRequest,
  AiProviderAdapter,
  AiProviderCallDeps,
  AiProviderModel,
  AiProviderResult,
  AiReasoningLevel,
} from "./aiProvider.ts";

/** The provider id `ai_model_catalog.provider` would use for OpenAI. */
export const OPENAI_AI_PROVIDER = "openai";

/**
 * A model this adapter can serve: provider `openai`, nothing wider.
 *
 * Deliberately NOT narrowed to `gpt-5.6-terra`. Which OpenAI model strings
 * PaperLume authorizes is the DATABASE's decision (`ai_model_catalog`), exactly
 * as it is for Gemini — a TypeScript allowlist here would be a second
 * authorization surface that could disagree with the first (C33/C35/C39). The
 * adapter sends whatever trusted `providerModel` it is handed.
 */
export type OpenAiProviderModel = AiProviderModel<typeof OPENAI_AI_PROVIDER>;

/** The one OpenAI endpoint this repository would call. */
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

/**
 * The reasoning levels this adapter can express — AI-MULTI-PROVIDER-001C.
 *
 * Exactly the six `reasoning.effort` values `gpt-5.6-terra` documents, in
 * OpenAI's own order. Google's `minimal` is absent because Terra does not offer
 * it, and Anthropic's `off` is absent because OpenAI spells the same idea
 * `none` — two providers' words for "do not reason" stay two values in
 * PaperLume's canonical vocabulary rather than being collapsed, so neither
 * adapter can be handed the other's spelling and quietly send it.
 */
export type OpenAiReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** In OpenAI's own order of increasing effort. */
export const OPENAI_REASONING_LEVELS: readonly OpenAiReasoningLevel[] = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);

export function isOpenAiReasoningLevel(level: AiReasoningLevel): level is OpenAiReasoningLevel {
  return (OPENAI_REASONING_LEVELS as readonly string[]).includes(level);
}

/**
 * Per-attempt ceiling — this adapter's own, not the Gemini transport's and not
 * the Anthropic adapter's.
 *
 * Chosen rather than copied. `_shared/geminiTransport.ts` currently runs a
 * TEMPORARY 90 s Production diagnostic value, and C39's whole point is that one
 * provider's transport constants are not evidence about another's. That it
 * currently equals the Anthropic value is a coincidence of two similar bounds,
 * not a shared decision — they are two constants in two modules precisely so
 * either can move without the other.
 *
 * 60 s, because the generation is hard-bounded: `max_output_tokens` above caps
 * reasoning and answer together at 4096 tokens. Supabase documents a 150 s
 * wall-clock and idle limit for hosted Edge Functions, and with a single
 * attempt (below) the worst case is exactly one 60 s wait — leaving 90 s of
 * that envelope for everything else the request does. AI-MULTI-PROVIDER-001F
 * may tune it against a real Production canary; until then nothing measured
 * justifies a larger one.
 */
export const OPENAI_PROVIDER_TIMEOUT_MS = 60_000;

/**
 * Attempts per user action. ONE — no automatic retry.
 *
 * The conservative baseline for a protocol that has never run against the real
 * provider: a retry cannot duplicate a paid request if there is no retry.
 * `Retry-After` is deliberately not read, and no backoff is slept.
 */
export const OPENAI_PROVIDER_ATTEMPTS = 1;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PaperLume's `responseFormat` expressed in OpenAI's vocabulary.
 *
 * A lookup rather than a literal, mirroring the Google adapter: a future format
 * has to be given an OpenAI spelling here instead of silently inheriting
 * `json_schema`.
 */
const OPENAI_TEXT_FORMAT_TYPE: Record<AiGenerationRequest["responseFormat"], string> = {
  json: "json_schema",
};

/**
 * The OpenAI request body.
 *
 * What is present is the documented minimum for one stateless generation, plus
 * the one privacy-load-bearing field and PaperLume's explicit reasoning and
 * output policy. What is ABSENT is still the reviewed part:
 *
 *   * no `tools`, no `tool_choice` — no function calling, no file search, no
 *     web search, no computer use;
 *   * no `conversation`, no `previous_response_id` — no conversation state;
 *   * no `metadata`, no `safety_identifier`, no `user` — no user-identifying
 *     field of any kind reaches OpenAI: not an email, not a Supabase user id,
 *     not a paper id;
 *   * no `prompt_cache_key` and no cache breakpoints — prompt caching is
 *     deliberately out of 001B's scope;
 *   * no `temperature` or `top_p` — PaperLume sets no sampling parameters
 *     anywhere, and Terra's documented contract requires none;
 *   * no `stream`, no `background`, no `service_tier`.
 *
 * `store: false` is not optional and not conditional. Omitting it would mean
 * OpenAI retains every paper title and abstract PaperLume sends.
 *
 * ## The reasoning mapping — AI-MULTI-PROVIDER-001C (C41)
 *
 * One field, and a direct one: PaperLume's canonical level IS OpenAI's effort
 * value, so `none | low | medium | high | xhigh | max` pass through verbatim
 * with nothing to translate. `reasoning.effort` is stated EXPLICITLY on every
 * level, including `medium` where it happens to match Terra's current default,
 * because a provider default is a fact about the provider on a given day and
 * not PaperLume's product policy.
 *
 * A `provider_default` directive sends no `reasoning` key at all — the fail-open
 * path for unusable policy metadata. `max_output_tokens`, `store: false` and
 * the structured-output format still go: none of them is reasoning policy.
 */
export function buildOpenAiRequestBody(
  model: OpenAiProviderModel,
  request: AiGenerationRequest,
  policy: AiCallPolicy<OpenAiReasoningLevel>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.providerModel,
    instructions: request.systemInstruction,
    input: request.userContent,
    // PaperLume's hard ceiling for THIS operation. On a reasoning model it
    // bounds reasoning and answer together, so it is also what keeps `max`
    // effort from running unbounded. It arrives from the caller rather than
    // being a constant here, because how much room an answer needs is the
    // operation's knowledge.
    max_output_tokens: policy.maxOutputTokens,
    // The privacy term of this request. See the module header.
    store: false,
    text: {
      format: {
        type: OPENAI_TEXT_FORMAT_TYPE[request.responseFormat],
        // Required by OpenAI; a fixed server-side label the operation owns.
        name: request.jsonSchema.name,
        // The operation's schema, passed through verbatim. This module does not
        // inspect, extend or repair it: what the fields MEAN is PaperLume
        // product semantics and stays on the operation's side of C39's line.
        schema: request.jsonSchema.schema,
        // OpenAI documents strict mode as the recommended setting; it is what
        // makes the schema an enforced contract rather than a suggestion.
        strict: true,
      },
    },
  };

  if (policy.reasoning.kind === "level") {
    body.reasoning = { effort: policy.reasoning.level };
  }

  return body;
}

/**
 * The exact `RequestInit`. The credential appears in `Authorization` and
 * nowhere else — not in the URL, not in a query parameter, not in the body. The
 * caller's own Supabase bearer token is never anywhere near this.
 */
export function buildOpenAiRequestInit(
  model: OpenAiProviderModel,
  request: AiGenerationRequest,
  policy: AiCallPolicy<OpenAiReasoningLevel>,
  apiKey: string,
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildOpenAiRequestBody(model, request, policy)),
  };
}

/**
 * The `status` that means "OpenAI finished the answer it was asked for".
 *
 * Every other documented value is a real outcome this request shape must not
 * treat as a completed answer: `incomplete` means the generation stopped early
 * (our own `max_output_tokens` ceiling is a documented reason, and on a
 * reasoning model it can be reached before any visible text exists), while
 * `queued` and `in_progress` describe a response that is not finished at all.
 * Gating on the one expected value fails closed on anything new, which is the
 * right default for a protocol that has never run against the real provider.
 */
const OPENAI_COMPLETE_STATUS = "completed";

/**
 * Pull the model's generated text out of a Responses payload.
 *
 * `output` is an ARRAY of ITEMS and this walks all of it, because reading
 * `output[0]` is wrong on a reasoning model:
 *
 *   * a `reasoning` item can precede the `message` item, so position means
 *     nothing;
 *   * only items of `type: "message"` are considered, and within them only
 *     content blocks of `type: "output_text"`, concatenated in the order OpenAI
 *     returned them;
 *   * every other item and content kind is ignored. A `reasoning` item is never
 *     returned as the generated answer, so a future 001C decision to raise
 *     reasoning effort cannot start leaking reasoning into a user-visible
 *     suggestion. A `refusal` block is ignored for a second reason as well: it
 *     is provider-authored prose about PaperLume's own prompt, and the boundary
 *     in `aiProvider.ts` exists so that no such text crosses it. A refusal
 *     therefore surfaces as `empty` — a response that completed and carried no
 *     answer — which is what it is.
 *
 * There is deliberately NO use of a top-level convenience field: `output_text`
 * as a single flattened string is an SDK helper, not something the raw HTTP API
 * guarantees, and depending on it would make this module correct only against a
 * library it does not use.
 *
 * Returns `null` when there is no generated text, which the caller reports as
 * `empty`; returns `undefined` when the payload is not a Responses envelope at
 * all, which the caller reports as `unreadable_response`. Each step is checked
 * structurally rather than with optional chaining.
 *
 * Text is preserved exactly: no trimming, unwrapping or repair, exactly as in
 * the Google and Anthropic adapters.
 */
export function extractOpenAiText(payload: unknown): string | null | undefined {
  if (!isPlainObject(payload)) return undefined;
  const output = payload.output;
  if (!Array.isArray(output)) return undefined;

  let text = "";
  for (const item of output) {
    if (!isPlainObject(item)) continue;
    if (item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isPlainObject(block)) continue;
      if (block.type !== "output_text") continue;
      if (typeof block.text !== "string") continue;
      text += block.text;
    }
  }

  return text === "" ? null : text;
}

/**
 * Send one generation request to OpenAI and normalize the outcome.
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
  model: OpenAiProviderModel,
  request: AiGenerationRequest,
  policy: AiCallPolicy<OpenAiReasoningLevel>,
  deps: AiProviderCallDeps,
): Promise<AiProviderResult> {
  const attempts = OPENAI_PROVIDER_ATTEMPTS;
  const createTimeoutSignal =
    deps.createTimeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const signal = createTimeoutSignal(OPENAI_PROVIDER_TIMEOUT_MS);

  let response: Response;
  try {
    response = await deps.fetchImpl(OPENAI_RESPONSES_URL, {
      ...buildOpenAiRequestInit(model, request, policy, deps.apiKey),
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
    // Status and attempt count only. The body is never read, so an OpenAI error
    // envelope — which can echo request content — cannot be logged, and
    // `x-request-id` and rate-limit headers are never touched.
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

  if (!isPlainObject(payload) || !Array.isArray(payload.output)) {
    return { ok: false, kind: "unreadable_response", attempts };
  }

  const status = payload.status;
  if (typeof status !== "string") {
    // A 200 that does not carry the Responses terminal-state field is not a
    // Responses envelope this module knows how to trust.
    return { ok: false, kind: "unreadable_response", attempts };
  }
  if (status !== OPENAI_COMPLETE_STATUS) {
    // Checked BEFORE the text is read, on purpose: an `incomplete` response can
    // still carry text, and that text is a truncated answer. Returning it would
    // hand the operation's parser a half-written JSON object and call it a
    // successful generation; reporting it as `empty` would describe a cut-off
    // generation as "the model answered with nothing". Neither `status` nor
    // `incomplete_details` crosses the boundary — only the bounded kind does.
    return { ok: false, kind: "incomplete_response", attempts };
  }

  const text = extractOpenAiText(payload);
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
 * The OpenAI adapter — implemented, reviewed, and registered since
 * AI-MULTI-PROVIDER-001C.
 *
 * `_shared/aiProviderRegistry.ts` imports this constant, so a valid enabled
 * `openai` catalog row would now be honoured rather than falling back with
 * `unsupported_provider`. No such row exists, and creating one is a separate
 * reviewed migration.
 */
export const OPENAI_AI_PROVIDER_ADAPTER: AiProviderAdapter<
  typeof OPENAI_AI_PROVIDER,
  OpenAiReasoningLevel
> = {
  provider: OPENAI_AI_PROVIDER,
  reasoningLevels: OPENAI_REASONING_LEVELS,
  supportsReasoningLevel: isOpenAiReasoningLevel,
  generate,
};
