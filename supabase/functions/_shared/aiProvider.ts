// The provider-neutral AI generation contract — AI-MULTI-PROVIDER-001A (C39).
//
// One seam, shared by `analyze-paper` and `suggest-paper-organization`, between
// PaperLume's PRODUCT semantics and a provider's PROTOCOL. Before this module
// both operations spoke Gemini directly: each built the `generateContent` URL,
// the Gemini request envelope, the `x-goog-api-key` header, and each reached
// into `candidates[0].content.parts[0].text` itself. That is four places a
// second provider would have had to be threaded through, in two functions that
// must not drift apart.
//
// ## The division of labour, stated once
//
//   * The ADAPTER knows the provider protocol: the endpoint, the request
//     envelope, the credential header, the response envelope, and how that
//     provider's outcomes map onto the bounded result below. Nothing else in
//     the repository may know those things.
//
//   * The OPERATION knows PaperLume: which prompt to send, what a usable answer
//     looks like, how to parse it, what a failure costs the user (quota,
//     refund, status code) and what the user is told. Nothing in an adapter may
//     know those things — no Project/Tag logic, no TLDR/study-type extraction,
//     no quota, no HTTP status this product returns.
//
// A useful test of a change against that line: "would a second provider need
// its own copy of this?" — if yes it belongs to the adapter, if no it belongs
// to the operation.
//
// ## What deliberately does NOT cross this boundary
//
// Into the adapter: no user id, no email, no bearer token, no database model
// id, no request body from the browser, no Projects/Tags structure — only the
// two prompt strings the operation built, the public model metadata, and the
// credential for that provider.
//
// Out of the adapter: no `Response`, no provider headers, no provider error
// body, no provider-specific success envelope, and no provider error message.
// A failure crosses as a bounded `kind` plus, for an HTTP failure, the status
// code — because a provider's error envelope can echo request content and name
// the caller's project, and a result shape that carried it would make logging
// it the easy thing to do. Success crosses as the generated TEXT, which is
// exactly what the operation's existing strict parser already expects.
//
// Pure module: no Deno APIs, no remote imports, no I/O of its own. It declares
// types and nothing else, so Node/Vitest exercises the real shipped contract.

/**
 * A provider and the public model string that provider knows it by.
 *
 * `providerModel` is what goes on the wire; it originates only in trusted
 * server configuration or in the server-controlled `ai_model_catalog`, never in
 * anything a client sent. The type parameter lets the model-selection layer
 * narrow `provider` to the set of providers that actually have an adapter (see
 * `aiProviderRegistry.ts`), while an adapter itself takes the widest form.
 *
 * Deliberately carries no database id, no display name, no credential and no
 * per-user anything: a routing log line built from this object cannot become a
 * privacy problem.
 */
export interface AiProviderModel<Provider extends string = string> {
  readonly provider: Provider;
  readonly providerModel: string;
}

/**
 * One generation request, expressed without naming any provider.
 *
 * Both operations send exactly this shape today: a fixed system instruction, a
 * single user-content part, and a demand for JSON. `responseFormat` is a
 * one-member union rather than a boolean because it is a contract term the
 * operations' parsers depend on — an adapter that cannot honour it must fail
 * rather than silently send prose.
 *
 * There is deliberately NO reasoning/thinking budget, temperature, token
 * ceiling, tool list or streaming flag here. PaperLume sets none of those today
 * (see `AI-PROVIDER-REQUEST-CONTRACT-001A`), and inventing fields for a
 * provider we have not implemented would be guessing at someone else's API.
 */
export interface AiGenerationRequest {
  readonly systemInstruction: string;
  readonly userContent: string;
  readonly responseFormat: "json";
}

/**
 * Why a generation did not produce usable text. Bounded, provider-neutral, and
 * safe to log as-is.
 *
 *   * `http`    — the provider answered with a non-2xx status (carried).
 *   * `network` — the request never produced a response.
 *   * `timeout` — our own per-attempt ceiling ended the attempt. Distinct from
 *                 `network` on purpose: only this one means "we stopped waiting
 *                 while the provider may still have been generating".
 *   * `unreadable_response` — a 2xx whose body could not be read as this
 *                 provider's response envelope at all.
 *   * `empty`   — a well-formed 2xx envelope carrying no generated text (a
 *                 blocked candidate, an empty candidate list, a missing text
 *                 part).
 *
 * The two 2xx kinds are separate because the two operations classify them
 * differently today and 001A preserves that exactly.
 */
export type AiProviderFailureKind =
  | "http"
  | "network"
  | "timeout"
  | "unreadable_response"
  | "empty";

/**
 * The outcome of one provider-call sequence.
 *
 * `attempts` is how many requests the provider actually received for this one
 * user action — the number both operations log, and the number that made the
 * duplicate-request incident behind `AI-PROVIDER-RESILIENCE-001A` visible. It
 * is present on success and failure alike.
 *
 * `text` is the model's generated text exactly as the provider returned it,
 * with no trimming, unwrapping or repair: deciding whether a blank or
 * unparseable answer is usable is the operation's judgement, not the adapter's.
 * An absent or non-textual answer is `empty` instead, so `text` is always a
 * non-empty string.
 */
export type AiProviderResult =
  | { readonly ok: true; readonly text: string; readonly attempts: number }
  | {
      readonly ok: false;
      readonly kind: AiProviderFailureKind;
      /** Present only for `kind: "http"`. */
      readonly status?: number;
      readonly attempts: number;
    };

/**
 * Runtime the adapter is given, rather than reaches for.
 *
 * Nothing here is read from the environment by the adapter itself: the Edge
 * Function shell owns environment access, which is what lets Vitest exercise
 * the real adapter with an injected `fetch` and an injected clock instead of a
 * re-implementation.
 */
export interface AiProviderCallDeps {
  /**
   * The credential for the provider being called, and for no other.
   *
   * 001A registers exactly one adapter (Google) and both operations supply the
   * one existing `GEMINI_API_KEY`, so a credential cannot reach the wrong
   * provider. **A task that registers a second adapter owns binding each
   * provider to its own server-side credential name before it can route to
   * one** — that is why this is a per-call value rather than a bag of secrets,
   * and why no generic `AI_API_KEY` exists.
   */
  readonly apiKey: string;
  /** Log prefix, e.g. `"analyze-paper"` or `"suggest-organization"`. */
  readonly label: string;
  /** Injected so the retry/backoff policy is exercised by tests, not mocked around. */
  fetchImpl(url: string, init: RequestInit): Promise<Response>;
  /** Injected so tests never spend real wall-clock time on backoff. */
  sleep(ms: number): Promise<void>;
  /** Injected so a test can assert the configured timeout without waiting for it. */
  createTimeoutSignal?(ms: number): AbortSignal;
  logger?: { warn(message: string): void };
}

/**
 * One reviewed provider protocol implementation.
 *
 * `provider` is the id the `ai_model_catalog.provider` column uses, and it is
 * what the registry keys on — so "does PaperLume have an adapter for this
 * catalog row?" is answered by the existence of an object satisfying this
 * interface, not by a second list of model strings.
 *
 * `generate` must not throw: every provider-side outcome is a value above, so a
 * transport problem can never become an unhandled rejection in an operation
 * that has already consumed a quota unit.
 */
export interface AiProviderAdapter<Provider extends string = string> {
  readonly provider: Provider;
  generate(
    model: AiProviderModel,
    request: AiGenerationRequest,
    deps: AiProviderCallDeps,
  ): Promise<AiProviderResult>;
}
