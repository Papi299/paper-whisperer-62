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
 * anything a client sent. The type parameter is what binds a model to a
 * provider: the model-selection layer narrows `provider` to the set of
 * providers that actually have an adapter (see `aiProviderRegistry.ts`), and an
 * `AiProviderAdapter<P>` accepts only an `AiProviderModel<P>` — its own
 * provider's models, never another's.
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
 * The JSON shape an operation requires back, in the one vocabulary every
 * current provider's structured-output API speaks: a name and a JSON Schema.
 *
 * AI-MULTI-PROVIDER-001B. `responseFormat: "json"` alone says only "valid
 * JSON"; Anthropic and OpenAI both offer native SCHEMA enforcement, and using
 * prose instructions instead where the provider documents a real mechanism
 * would be choosing the weaker contract on purpose.
 *
 * The schema belongs to the OPERATION, not to an adapter, and that is the whole
 * reason it travels here. `tldr`, `studyType`, `ref`, `newTags` — those are
 * PaperLume product semantics, and C39 keeps them out of provider modules.
 * Adapters only translate this object into their provider's vocabulary.
 *
 * `name` exists because OpenAI's `text.format` requires one; Anthropic's
 * `output_config.format` takes only the schema and ignores it. It is a fixed
 * server-side label, never anything a user typed.
 *
 * A schema is NOT a second parser. Both operations keep their own strict
 * parsers as the final authority on a response, because a provider's
 * schema-compliance claim is a claim about syntax and because the dialects
 * cannot express every PaperLume rule (see the suggestion caps).
 */
export interface AiJsonOutputSchema {
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

/**
 * One generation request, expressed without naming any provider.
 *
 * Both operations send exactly this shape today: a fixed system instruction, a
 * single user-content part, a demand for JSON, and the JSON Schema that demand
 * means. `responseFormat` is a one-member union rather than a boolean because
 * it is a contract term the operations' parsers depend on — an adapter that
 * cannot honour it must fail rather than silently send prose.
 *
 * `jsonSchema` is REQUIRED rather than optional, so that "this operation never
 * said what shape it wanted" is unexpressible: an operation that gains a
 * provider call has to state its output contract. An adapter whose provider has
 * no native schema mechanism may ignore it — the Google adapter does exactly
 * that, deliberately: a Google request carries no schema at all.
 *
 * There is deliberately NO temperature, top-p, tool list or streaming flag
 * here. PaperLume sets none of those (`AI-PROVIDER-REQUEST-CONTRACT-001A`).
 *
 * Reasoning is deliberately NOT here either, and that is a boundary rather than
 * an omission: this type is what the OPERATION asks for, and reasoning is what
 * PAPERLUME'S POLICY decided. They have different authors, different authorities
 * and different lifetimes — the prompt and schema come from the operation's own
 * modules, while the reasoning level comes from the server-controlled catalog
 * and the user's saved preference. Merging them would let an operation state a
 * reasoning opinion it has no business having. Reasoning travels beside this, in
 * `AiCallPolicy` below (AI-MULTI-PROVIDER-001C, C41).
 */
export interface AiGenerationRequest {
  readonly systemInstruction: string;
  readonly userContent: string;
  readonly responseFormat: "json";
  readonly jsonSchema: AiJsonOutputSchema;
}

/**
 * PaperLume's canonical reasoning vocabulary — AI-MULTI-PROVIDER-001C (C41).
 *
 * The UNION of what every reviewed adapter can express, not any one provider's
 * list, and the exact set `ai_model_catalog` may store. Each member exists
 * because some provider PaperLume has reviewed has it:
 *
 *   * `minimal`       — Google's lowest thinking level; no other provider has it.
 *   * `off`           — Anthropic's thinking disabled.
 *   * `none`          — OpenAI's zero-reasoning effort.
 *   * `low` … `high`  — all three.
 *   * `xhigh`, `max`  — the two paid providers only.
 *
 * `automatic` is deliberately NOT a member. Automatic is PaperLume's POLICY —
 * "choose a level from the catalog for this model and this operation" — and it
 * always resolves to one of the levels above before anything reaches a
 * provider. Making it a reasoning value would erase the difference between
 * "PaperLume chose medium" and "the user chose medium", which is the whole
 * distinction the reasoning design is built on.
 *
 * Which subset a given provider accepts is that ADAPTER's business (each
 * declares its own narrowing of this union), and which subset a given MODEL
 * offers is the database's.
 */
export type AiReasoningLevel =
  | "minimal"
  | "off"
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Every canonical level, in the order the vocabulary is documented. */
export const AI_REASONING_LEVELS: readonly AiReasoningLevel[] = Object.freeze([
  "minimal",
  "off",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);

/** Is this value one of PaperLume's canonical reasoning levels? */
export function isAiReasoningLevel(value: unknown): value is AiReasoningLevel {
  return typeof value === "string" && (AI_REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * What an adapter is told to do about reasoning on ONE request.
 *
 * Two members, and the second is not a third reasoning level:
 *
 *   * `level` — send this provider's expression of this level, explicitly. This
 *     is the ordinary case and covers BOTH Automatic (PaperLume chose it from
 *     the catalog) and manual (the user chose it). The adapter is not told
 *     which, because the wire bytes are identical and the distinction is a
 *     product fact that belongs in the policy log, not in the request.
 *
 *   * `provider_default` — send NO reasoning parameter at all, for this request
 *     only. This is the fail-open compatibility path for unusable policy
 *     metadata (a catalog lookup that failed, a row that is missing, an
 *     Automatic level its own model does not support). It deliberately does not
 *     mean "PaperLume chose the provider's default": PaperLume chose nothing,
 *     which is exactly why it is a distinct member with its own bounded log
 *     reason rather than an absent `level`.
 *
 * `Level` is the ADAPTER's own narrowing of `AiReasoningLevel`, so a directive
 * carrying `off` does not type-check against the Google adapter and one
 * carrying `minimal` does not type-check against Anthropic's.
 */
export type AiReasoningDirective<Level extends AiReasoningLevel> =
  | { readonly kind: "level"; readonly level: Level }
  | { readonly kind: "provider_default" };

/**
 * The per-request policy an operation hands to an adapter alongside the prompt.
 *
 * Everything here is PaperLume's decision about HOW to spend a request, as
 * opposed to `AiGenerationRequest`, which is WHAT to ask. Keeping them apart is
 * what lets an adapter stay ignorant of the operation: no adapter has to infer
 * from prompt text whether it is serving Analyze or Suggest, because the one
 * thing that differs between them arrives as a number.
 *
 * `maxOutputTokens` is a hard PaperLume safety ceiling, not an expected usage
 * figure. On every current provider it bounds reasoning AND answer together, so
 * it is the backstop that keeps even `max` effort from running unbounded. An
 * adapter whose protocol has no place for it — or which has a reviewed reason
 * not to send one — documents that decision in its own module.
 */
export interface AiCallPolicy<Level extends AiReasoningLevel> {
  readonly reasoning: AiReasoningDirective<Level>;
  readonly maxOutputTokens: number;
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
 *   * `incomplete_response` — a readable 2xx envelope in which the provider
 *                 ITSELF reports the generation did not complete.
 *
 * The first two 2xx kinds are separate because the two operations classify them
 * differently today and 001A preserves that exactly.
 *
 * ## Why `incomplete_response` was added (AI-MULTI-PROVIDER-001B)
 *
 * Adding a member to this union is not free, so it was done only after the
 * alternative was checked and found dishonest. Both new provider protocols
 * report a terminal state of their own INSIDE a 200 response:
 *
 *   * OpenAI's Responses API returns `status` — `"incomplete"` with
 *     `incomplete_details.reason` (e.g. our own output ceiling), not only
 *     `"completed"`.
 *   * Anthropic's Messages API returns `stop_reason` — `"max_tokens"` when the
 *     ceiling truncated the answer, `"refusal"` when a safeguard declined.
 *
 * None of the existing kinds describes that truthfully. It is not `http` (the
 * status was 200), not `network` or `timeout` (ours is the only clock in this
 * module), and not `unreadable_response` (the envelope read perfectly — it is
 * the GENERATION that did not finish). The tempting one is `empty`, and that is
 * the one worth refusing: `empty` means the model answered with nothing, while
 * this means the model was cut off, declined, or failed part-way — frequently
 * with truncated text still attached. Reporting a truncated answer as "the
 * model returned nothing" would misdescribe the failure in exactly the logs
 * someone would use to diagnose it.
 *
 * Google cannot produce it: its envelope has no such field. Anthropic and OpenAI
 * can, and both have been REGISTERED since AI-MULTI-PROVIDER-001C (C41) — but no
 * `anthropic/*` or `openai/*` catalog row exists, so no request can reach either
 * yet. The original note, kept for history: when it was written, Google was the
 * only registered
 * adapter and its envelope has no such field, so its behaviour is unchanged and
 * both operations' existing classifications are untouched. The two operations
 * nonetheless classify this kind explicitly, so the branch exists before the
 * provider that needs it is ever routeable.
 */
export type AiProviderFailureKind =
  | "http"
  | "network"
  | "timeout"
  | "unreadable_response"
  | "empty"
  | "incomplete_response";

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
   * Since AI-MULTI-PROVIDER-001C (C41) each registered provider is bound to its
   * OWN server-side credential name by `aiProviderCredentials.ts` — `google` →
   * `GEMINI_API_KEY`, `anthropic` → `ANTHROPIC_API_KEY`, `openai` →
   * `OPENAI_API_KEY` — and each operation reads exactly the selected provider's
   * variable. That is why this is a per-call value rather than a bag of secrets,
   * and why no generic `AI_API_KEY` exists: a credential can only ever reach the
   * provider whose adapter the request was dispatched to.
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
 * One reviewed provider protocol implementation, bound to its own provider.
 *
 * `provider` is the id the `ai_model_catalog.provider` column uses, and it is
 * what the registry keys on — so "does PaperLume have an adapter for this
 * catalog row?" is answered by the existence of an object satisfying this
 * interface, not by a second list of model strings.
 *
 * `generate` accepts only models of THIS adapter's provider AND only reasoning
 * levels of this adapter's own vocabulary: handing the Google adapter an
 * `AiProviderModel<"openai">` is a compile error, not a Gemini request carrying
 * another provider's model name, and handing it a directive for `off`, `none`,
 * `xhigh` or `max` is a compile error rather than a 400 from Google. Two
 * details make that hold, and both are deliberate:
 *
 *   * `Provider` has no default, and neither does `Level`. No provider-agnostic
 *     adapter exists, so no type should describe one — and a `Level` default of
 *     the full canonical union would silently re-admit every combination the
 *     second parameter exists to reject.
 *   * `generate` is a function-typed PROPERTY, not a method. TypeScript checks
 *     method parameters bivariantly even under `strictFunctionTypes`, which
 *     would let an `AiProviderAdapter<"google">` be widened to
 *     `AiProviderAdapter<string>` and then called with any provider's model. A
 *     property's parameters are checked contravariantly, so that widening is
 *     refused.
 *
 * `generate` must not throw: every provider-side outcome is a value above, so a
 * transport problem can never become an unhandled rejection in an operation
 * that has already consumed a quota unit.
 */
export interface AiProviderAdapter<Provider extends string, Level extends AiReasoningLevel> {
  readonly provider: Provider;
  /**
   * Exactly the canonical reasoning levels this PROVIDER'S PROTOCOL accepts, in
   * the provider's own order of increasing effort.
   *
   * This is not a second model allowlist and not a product decision: it is what
   * the wire format can express, which is why it lives beside the code that
   * writes the wire format. The DATABASE still decides which levels a given
   * MODEL offers a user (`ai_model_catalog.reasoning_levels`), and that set is
   * necessarily a subset of this one — a catalog row that promised more would
   * be caught by `supportsReasoningLevel` below rather than sent.
   */
  readonly reasoningLevels: readonly Level[];
  /**
   * Narrow a canonical level to one this adapter can actually send.
   *
   * The structural guard between PaperLume's vocabulary and this provider's.
   * Policy resolution already refuses a level the CATALOG does not list; this
   * catches the remaining case — catalog metadata that lists a level the
   * PROVIDER does not have (corrupt data, a hand-edited row, a provider that
   * removed a level) — so the failure is a bounded fallback rather than a 400
   * on a request the user has already paid a quota unit for.
   */
  readonly supportsReasoningLevel: (level: AiReasoningLevel) => level is Level;
  readonly generate: (
    model: AiProviderModel<Provider>,
    request: AiGenerationRequest,
    policy: AiCallPolicy<Level>,
    deps: AiProviderCallDeps,
  ) => Promise<AiProviderResult>;
}
