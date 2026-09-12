// The Google (Gemini) provider adapter — AI-MULTI-PROVIDER-001A (C39).
//
// The ONE place in this repository that knows how to talk to Google: the
// `generateContent` endpoint, the model path, the `x-goog-api-key` credential
// header, the `system_instruction` / `contents` / `generationConfig` request
// envelope, and the `candidates[0].content.parts[0].text` response envelope.
// Everything it does was already being done — 001A moved it out of
// `analyze-paper/index.ts`, `suggest-paper-organization/handler.ts`,
// `suggest-paper-organization/prompt.ts` and `_shared/aiModelSelection.ts` and
// behind the provider-neutral contract in `aiProvider.ts`, without changing a
// byte of what goes on the wire.
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
  AiGenerationRequest,
  AiProviderAdapter,
  AiProviderCallDeps,
  AiProviderModel,
  AiProviderResult,
} from "./aiProvider.ts";

/** The provider id used by `ai_model_catalog.provider` and by the registry. */
export const GOOGLE_AI_PROVIDER = "google";

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
 * Takes the resolved model object rather than a bare string: the only way to
 * obtain one is `resolveEffectiveAiModel` (or the trusted system default it
 * falls back to), and neither reads request input at all — so "send this user's
 * request to an arbitrary model" stays unexpressible. The model component is
 * the ONLY part of the provider call that per-user selection changes.
 */
export function buildGeminiGenerateContentUrl(model: AiProviderModel): string {
  return `${GEMINI_GENERATE_CONTENT_BASE}/${model.providerModel}:generateContent`;
}

/**
 * The Gemini request body.
 *
 * PaperLume sets no sampling parameters: temperature, top-p and top-k are left
 * at the provider/model defaults and only the JSON response mode is pinned,
 * because that is the part the operations' parsers actually depend on. Keeping
 * the request free of sampling overrides is what makes it portable across
 * Gemini model versions (`AI-PROVIDER-REQUEST-CONTRACT-001A`).
 *
 * Key order is load-bearing for nothing except reviewability, but it is the
 * historical order — `system_instruction`, `contents`, `generationConfig` — so
 * the serialized body is byte-identical to what both functions sent before.
 */
export function buildGeminiRequestBody(request: AiGenerationRequest): Record<string, unknown> {
  return {
    system_instruction: { parts: [{ text: request.systemInstruction }] },
    contents: [{ parts: [{ text: request.userContent }] }],
    generationConfig: {
      responseMimeType: GEMINI_RESPONSE_MIME_TYPE[request.responseFormat],
    },
  };
}

/**
 * The exact `RequestInit` both functions have always sent: POST, JSON content
 * type, and the one shared server-side key in `x-goog-api-key`. The caller's
 * own bearer token is never anywhere near this.
 */
export function buildGeminiRequestInit(
  request: AiGenerationRequest,
  apiKey: string,
): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(buildGeminiRequestBody(request)),
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
  model: AiProviderModel,
  request: AiGenerationRequest,
  deps: AiProviderCallDeps,
): Promise<AiProviderResult> {
  // The retry/timeout policy is the transport's, not this adapter's, and not
  // this adapter's to generalise to other providers.
  const call = await callGeminiWithRetry(
    buildGeminiGenerateContentUrl(model),
    buildGeminiRequestInit(request, deps.apiKey),
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

/** The single real provider adapter PaperLume implements. */
export const GOOGLE_AI_PROVIDER_ADAPTER: AiProviderAdapter<typeof GOOGLE_AI_PROVIDER> = {
  provider: GOOGLE_AI_PROVIDER,
  generate,
};
