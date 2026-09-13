// The Google (Gemini) provider adapter — AI-MULTI-PROVIDER-001A (C39).
//
// The ONE place in this repository that knows how to talk to Google: the
// `generateContent` endpoint, the model path, the `x-goog-api-key` credential
// header, the `system_instruction` / `contents` / `generationConfig` request
// envelope, and the `candidates[0].content.parts[0].text` response envelope.
// Everything it does was already being done — 001A moved it out of
// `analyze-paper/index.ts`, `suggest-paper-organization/handler.ts`,
// `suggest-paper-organization/prompt.ts` and `_shared/aiModelSelection.ts` and
// behind the provider-neutral contract in `aiProvider.ts`, without changing a byte of what went on the wire.
// AI-MULTI-PROVIDER-001C (C41) then made exactly one deliberate addition —
// `generationConfig.thinkingConfig.thinkingLevel`, PaperLume's explicit reasoning
// level — and the provider-default fallback still emits the pre-001C bytes.
//
// ## What this module deliberately does NOT own
//
//   * The transport policy. It calls `_shared/geminiTransport.ts`, which keeps
//     its own timeout/retry rules — currently the temporary 90 s / zero-retry
//     `AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A` policy, which 001A neither changes
//     nor generalises. A second provider may well need different status
//     semantics, `Retry-After` handling and idempotency rules, so a shared
//     ADAPTER contract is asserted here and a shared TRANSPORT policy is not.
//   * The prompts. Both come in already built, as two strings.
//   * The parsing. The generated text goes back to the operation's own strict
//     parser untouched — this module never learns what a TLDR, a study type, a
//     Project or a Tag is.
//   * The credential's NAME. The Edge Function shell reads `GEMINI_API_KEY`
//     from the environment and hands the value in, so this module performs no
//     I/O of its own and stays testable in Node.
//
// ## Privacy boundary
//
// Nothing provider-shaped escapes: the URL, the headers, the request body, the
// raw `Response` and the provider's error body all stay inside this module.
// Callers receive the generated text or a bounded failure kind, which is what
// keeps a routing/diagnostic log line incapable of carrying a Google error
// envelope, an API key or a user's paper.
//
// Pure module (no Deno APIs, no remote imports): the Edge Functions pass the
// real `fetch` and Vitest passes a fake one, so the shipped code is the tested
// code.

import { callGeminiWithRetry } from "./geminiTransport.ts";
import type {
  AiCallPolicy,
  AiGenerationRequest,
  AiProviderAdapter,
  AiProviderCallDeps,
  AiProviderModel,
  AiProviderResult,
  AiReasoningLevel,
} from "./aiProvider.ts";

/** The provider id used by `ai_model_catalog.provider` and by the registry. */
export const GOOGLE_AI_PROVIDER = "google";

/**
 * A model this adapter can serve: provider `google`, nothing wider. The
 * Google-only helpers below take this rather than a bare `AiProviderModel`, so
 * a model resolved for any other provider cannot reach a Gemini URL.
 */
export type GoogleAiProviderModel = AiProviderModel<typeof GOOGLE_AI_PROVIDER>;

/**
 * The reasoning levels Gemini's `thinkingLevel` accepts — AI-MULTI-PROVIDER-001C.
 *
 * Exactly four, and exactly the four Google publishes for the `generateContent`
 * API: `minimal`, `low`, `medium`, `high`. The canonical vocabulary's other
 * members are other providers' words — `off` and `none` are Anthropic's and
 * OpenAI's ways of saying "do not reason", and `xhigh`/`max` exist only on the
 * paid providers — and none of them is a value this endpoint would accept.
 *
 * Declared as a type as well as a list so the compiler enforces it: an
 * `AiCallPolicy<GoogleReasoningLevel>` carrying `off` does not type-check, so a
 * mapping mistake is caught before a request is ever built.
 *
 * Note that this is the PROTOCOL's vocabulary, not any model's capability.
 * `gemini-3.7-flash` and `gemini-3.8-flash` reject `minimal` specifically, which
 * is a per-MODEL fact and therefore lives in `ai_model_catalog.reasoning_levels`
 * — an adapter-level allowlist of model strings is exactly what C33/C35/C39
 * forbid, and a second copy of that per-model matrix here could disagree with
 * the database.
 */
export type GoogleReasoningLevel = "minimal" | "low" | "medium" | "high";

/** In Google's own order of increasing thinking. */
export const GOOGLE_REASONING_LEVELS: readonly GoogleReasoningLevel[] = Object.freeze([
  "minimal",
  "low",
  "medium",
  "high",
] as const);

export function isGoogleReasoningLevel(level: AiReasoningLevel): level is GoogleReasoningLevel {
  return (GOOGLE_REASONING_LEVELS as readonly string[]).includes(level);
}

/** The one Gemini endpoint this repository calls. */
const GEMINI_GENERATE_CONTENT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * PaperLume's `responseFormat` expressed in Gemini's vocabulary.
 *
 * A lookup rather than a literal so a future format has to be given a Gemini
 * spelling here, instead of silently inheriting `application/json`.
 */
const GEMINI_RESPONSE_MIME_TYPE: Record<AiGenerationRequest["responseFormat"], string> = {
  json: "application/json",
};

/**
 * Build the Gemini `generateContent` URL for a resolved model.
 *
 * Takes the resolved Google model object rather than a bare string: the only
 * way to obtain one is `resolveEffectiveAiModel` (or the trusted system default
 * it falls back to), and neither reads request input at all — so "send this
 * user's request to an arbitrary model" stays unexpressible, and a model
 * resolved for another provider does not type-check here. The model component
 * is the ONLY part of the provider call that per-user selection changes.
 */
export function buildGeminiGenerateContentUrl(model: GoogleAiProviderModel): string {
  return `${GEMINI_GENERATE_CONTENT_BASE}/${model.providerModel}:generateContent`;
}

/**
 * The Gemini request body.
 *
 * PaperLume sets no sampling parameters: temperature, top-p and top-k are left
 * at the provider/model defaults and only the JSON response mode and the
 * reasoning level are pinned. Keeping the request free of sampling overrides is
 * what makes it portable across Gemini model versions
 * (`AI-PROVIDER-REQUEST-CONTRACT-001A`).
 *
 * Key order is load-bearing for nothing except reviewability, but it is the
 * historical order — `system_instruction`, `contents`, `generationConfig` — and
 * `responseMimeType` still comes first inside `generationConfig`, so the only
 * difference from the pre-001C body is the added `thinkingConfig`.
 *
 * ## `thinkingConfig.thinkingLevel` — AI-MULTI-PROVIDER-001C (C41)
 *
 * The one field 001C adds, and the whole of what it adds. Google's current
 * `generateContent` documentation puts the reasoning control at
 * `generationConfig.thinkingConfig.thinkingLevel` with lowercase string values,
 * so PaperLume's canonical spelling passes through verbatim rather than through
 * a translation table — there is nothing to translate.
 *
 * The LEGACY `thinkingBudget` is deliberately not used and must not be added:
 * it is the Gemini 2.5-era numeric control, Google documents `thinkingLevel` as
 * the control for these models, and sending both in one request is a documented
 * 400. A numeric budget would also be a second, drifting expression of a policy
 * the catalog already states in words.
 *
 * A `provider_default` directive omits `thinkingConfig` ENTIRELY — no key, not
 * a null, not an empty object. That is the fail-open path for unusable policy
 * metadata, and it must produce exactly the request PaperLume sent before 001C
 * so that a metadata outage degrades to the previously shipped behaviour rather
 * than to some third thing.
 *
 * `maxOutputTokens` is deliberately NOT sent, even though the policy carries a
 * ceiling. Google's default output limit already bounds these models, this
 * adapter has never sent one, and 001C's reasoning levels move Analyze DOWN
 * (to `minimal`/`low`), so nothing about this change makes an explicit Gemini
 * ceiling necessary for correctness. Adding one would be an unmeasured
 * behaviour change to the one provider PaperLume actually serves traffic with;
 * the usage telemetry that would justify a number belongs to 001D.
 */
export function buildGeminiRequestBody(
  request: AiGenerationRequest,
  policy: AiCallPolicy<GoogleReasoningLevel>,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: GEMINI_RESPONSE_MIME_TYPE[request.responseFormat],
  };
  if (policy.reasoning.kind === "level") {
    generationConfig.thinkingConfig = { thinkingLevel: policy.reasoning.level };
  }
  return {
    system_instruction: { parts: [{ text: request.systemInstruction }] },
    contents: [{ parts: [{ text: request.userContent }] }],
    generationConfig,
  };
}

/**
 * The exact `RequestInit` both functions have always sent: POST, JSON content
 * type, and the one shared server-side key in `x-goog-api-key`. The caller's
 * own bearer token is never anywhere near this.
 */
export function buildGeminiRequestInit(
  request: AiGenerationRequest,
  policy: AiCallPolicy<GoogleReasoningLevel>,
  apiKey: string,
): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(buildGeminiRequestBody(request, policy)),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull the model's text out of a Gemini `generateContent` payload.
 *
 * Returns `null` for every shape that carries no text — a blocked candidate, an
 * empty candidate list, a malformed envelope, a non-string `text` — which the
 * caller reports as `empty`. Each step is checked structurally rather than with
 * optional chaining, so an envelope that merely resembles Gemini's cannot be
 * read as one.
 *
 * A whitespace-only string is deliberately RETURNED rather than treated as
 * absent: "the provider generated nothing usable" is the operation's judgement
 * (and `suggest-paper-organization` still makes exactly that call), while this
 * module answers only "did the provider return generated text".
 */
export function extractGeminiText(payload: unknown): string | null {
  if (!isPlainObject(payload)) return null;
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0];
  if (!isPlainObject(first)) return null;
  const content = first.content;
  if (!isPlainObject(content)) return null;
  const parts = content.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const text = isPlainObject(parts[0]) ? parts[0].text : null;
  if (typeof text !== "string" || text === "") return null;
  return text;
}

/**
 * Send one generation request to Gemini and normalize the outcome.
 *
 * Never throws: a transport failure is already a value from
 * `callGeminiWithRetry`, and the body read — the one remaining throwing step —
 * is caught here. An operation that has consumed a quota unit therefore always
 * reaches its own refund path.
 */
async function generate(
  model: GoogleAiProviderModel,
  request: AiGenerationRequest,
  policy: AiCallPolicy<GoogleReasoningLevel>,
  deps: AiProviderCallDeps,
): Promise<AiProviderResult> {
  // The retry/timeout policy is the transport's, not this adapter's, and not
  // this adapter's to generalise to other providers.
  const call = await callGeminiWithRetry(
    buildGeminiGenerateContentUrl(model),
    buildGeminiRequestInit(request, policy, deps.apiKey),
    {
      label: deps.label,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      createTimeoutSignal: deps.createTimeoutSignal,
      logger: deps.logger,
    },
  );

  if (!call.ok) {
    // Only the coarse kind and the status cross the boundary — never the
    // provider's body, headers or URL.
    return call.kind === "http"
      ? { ok: false, kind: "http", status: call.status, attempts: call.attempts }
      : { ok: false, kind: call.kind, attempts: call.attempts };
  }

  let payload: unknown;
  try {
    payload = await call.response.json();
  } catch {
    // A 2xx whose body is not Gemini JSON at all. The parse error's message can
    // quote the body, so it is discarded here rather than returned or logged.
    return { ok: false, kind: "unreadable_response", attempts: call.attempts };
  }

  const text = extractGeminiText(payload);
  if (text === null) return { ok: false, kind: "empty", attempts: call.attempts };

  return { ok: true, text, attempts: call.attempts };
}

/** The Google adapter — registered since AI-MULTI-PROVIDER-001A. */
export const GOOGLE_AI_PROVIDER_ADAPTER: AiProviderAdapter<
  typeof GOOGLE_AI_PROVIDER,
  GoogleReasoningLevel
> = {
  provider: GOOGLE_AI_PROVIDER,
  reasoningLevels: GOOGLE_REASONING_LEVELS,
  supportsReasoningLevel: isGoogleReasoningLevel,
  generate,
};
