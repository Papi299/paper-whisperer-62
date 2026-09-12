// Server-enforced per-user AI model routing — AI-MODEL-SELECTION-001B (C33).
//
// ONE implementation, shared by `analyze-paper` and `suggest-paper-organization`,
// so the authorization and fallback behaviour of the two AI operations cannot
// drift apart. A second copy of this decision is the failure mode this module
// exists to prevent: the two functions would eventually disagree about who is
// entitled, and the disagreement would be silent.
//
// ## What this module decides, and what it refuses to decide
//
// It decides ONLY which provider model string the caller's request should be
// sent to. It never decides identity, never decides quota, and never decides
// whether the AI feature is available at all — a caller who cannot be routed to
// their saved preference still gets the ordinary feature on Paperlume's system
// default model.
//
// ## The two — and only two — sources of a model string
//
//   1. Paperlume's system default, resolved by the Edge Function and handed in
//      as `systemDefault` — provider AND model metadata, not a bare string.
//   2. The server-controlled `public.ai_model_catalog`, reached only after the
//      caller's CURRENT entitlement has been proven server-side.
//
// A model string never originates in a request body, a query parameter, a
// header, `localStorage` or any other client-controlled surface. Nothing in this
// module accepts a model name as an argument, so "the client asked for
// gemini-x" is unexpressible rather than merely guarded.
//
// ## Fail closed on the capability, fail OPEN on the feature
//
// Every metadata problem — an access RPC error, a malformed row, a preference
// read failure, a missing/disabled catalog row, a provider we have no adapter
// for — resolves to the system default. That is fail-closed with respect to the
// *paid* model-selection capability (an unproven entitlement never routes) while
// preserving availability of the ordinary AI feature (nobody loses Analyze
// because a metadata read hiccuped). Deliberately, none of these become a
// Paperlume quota error, and none of them refund a unit: the system-default
// provider call still happens and still succeeds.
//
// ## `enabled` vs `selectable` — intentionally different for a SAVED preference
//
//   * `enabled = false` RETIRES a model. A saved preference pointing at it is no
//     longer honoured and the caller falls back to the system default.
//   * `selectable = false` only removes a model from NEW choices. An already
//     saved, still-enabled preference IS honoured — that is the whole point of
//     having two flags, and it lets a model be closed to new selection without
//     yanking it out from under the users who already chose it.
//
// Requiring both flags is the SETTER's job (`set_current_user_ai_model`, at the
// moment a choice is made). Runtime requires `enabled` only.
//
// ## Reasoning preference travels with the model decision
//
// AI-MULTI-PROVIDER-001C. The preference row now also carries a manual
// reasoning level, so this module reads it in the same round trip rather than
// making the reasoning layer perform a second identical query. It does NOT
// decide anything about it: whether that level is usable depends on the
// effective model's catalog capability metadata, which is
// `_shared/aiReasoningPolicy.ts`'s business. All this module does is refuse to
// carry the level across a fallback, because a fallback means the model the
// level was chosen for is not the model being called.
//
// ## Provider adapter boundary
//
// The catalog's `provider` column is deliberately unconstrained so a future
// Anthropic/OpenAI model is a seed row plus an adapter rather than a schema
// change — but until that adapter exists, a row naming any other provider must
// NOT be called. This module asks `_shared/aiProviderRegistry.ts` whether a
// reviewed adapter exists for the row's provider and falls back when none does,
// rather than routing to a provider whose credentials, request contract, error
// semantics and privacy review do not exist. Since AI-MULTI-PROVIDER-001A (C39)
// the registry is that authority; since AI-MULTI-PROVIDER-001C (C41) it holds
// three entries — `google`, `anthropic` and `openai` — so a valid, enabled
// catalog row naming any of them is now honoured rather than falling back on
// provider family alone. Nothing else changed here: an unregistered provider
// still falls back with `unsupported_provider`, and no `anthropic/*` or
// `openai/*` catalog row exists for this to route.
//
// This module decides WHICH model; it no longer knows how to REACH one. It
// builds no URL, sets no header and names no provider of its own — the Google
// endpoint now lives behind the Google adapter, which is why a second provider
// does not mean a second copy of the decision below.
//
// ## No TypeScript allowlist
//
// There is deliberately no hard-coded list of model strings here. The DATABASE
// catalog is the allowlist; duplicating it in TypeScript would create a second
// authorization surface that could disagree with the first. Tests use seeded
// ids as fixtures — that is fixture data, not a runtime rule.
//
// Pure module: no Deno APIs and no remote imports, so Node/Vitest exercises the
// exact shipped code with a fake client rather than a re-implementation.

import {
  isRegisteredAiProvider,
  type RegisteredAiProvider,
} from "./aiProviderRegistry.ts";
import { isAiReasoningLevel, type AiProviderModel, type AiReasoningLevel } from "./aiProvider.ts";

/** Where the effective model came from. */
export type AiModelSelectionSource = "system_default" | "user_preference";

/**
 * Bounded, non-sensitive reason a saved preference was not honoured.
 *
 * `not_entitled` and `no_preference` are ORDINARY states — the overwhelming
 * majority of requests — and are never logged as warnings. Everything else is
 * unexpected and emits exactly one bounded diagnostic line.
 */
export type AiModelFallbackReason =
  // Expected, quiet.
  | "not_entitled"
  | "no_preference"
  // Unexpected; each emits one bounded, non-sensitive warning.
  | "access_lookup_failed"
  | "invalid_access_row"
  | "preference_lookup_failed"
  | "invalid_preference"
  | "catalog_lookup_failed"
  | "model_missing"
  | "model_disabled"
  | "invalid_catalog_row"
  | "unsupported_provider";

/**
 * The routing decision. Carries no database id, no user id and nothing else
 * that could turn a routing log line into a privacy problem: `providerModel` is
 * a public model name and `fallbackReason` is one of the bounded literals above.
 *
 * `provider` is narrowed to a REGISTERED provider, so "the decision names a
 * provider we have a reviewed adapter for" is a property of the type: a caller
 * can hand this straight to `getAiProviderAdapter` with no failure branch.
 */
export interface AiModelSelection extends AiProviderModel<RegisteredAiProvider> {
  source: AiModelSelectionSource;
  /** `null` exactly when the saved preference was honoured. */
  fallbackReason: AiModelFallbackReason | null;
  /**
   * The caller's saved MANUAL reasoning level, and `null` for Automatic —
   * AI-MULTI-PROVIDER-001C (C41).
   *
   * `null` on EVERY fallback path, deliberately and without exception. A manual
   * level was chosen for one specific model; when this decision falls back to
   * PaperLume's system default — a lapsed entitlement, a retired model, an
   * unreadable preference, a provider with no adapter — the model being called
   * is not the model that level was chosen for, and carrying it across would
   * apply a setting to something the user never saw. Automatic is the honest
   * answer for a model they did not pick.
   *
   * A bounded canonical literal or `null`, never raw database text: a value
   * that is not one of PaperLume's eight reasoning levels is read as no
   * preference, so a malformed row cannot reach a provider request or a log
   * line. It is deliberately NOT logged from here — `aiReasoningPolicy.ts` logs
   * the RESOLVED level, which is the one that was actually sent.
   */
  reasoningPreference: AiReasoningLevel | null;
}

// ── The minimal database surface this module is allowed to reach ───────────
//
// `select` + `eq` + `maybeSingle` + `rpc`, and nothing else. There is no
// `insert`, `update`, `upsert` or `delete` in this interface, so an edit that
// tried to write entitlement, preference or catalog state from the routing path
// would not type-check. The real caller-scoped clients in both Edge Functions
// satisfy this structurally.

export interface AiModelSelectionQuery {
  eq(column: string, value: string): AiModelSelectionQuery;
  maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
}

export interface AiModelSelectionClient {
  from(table: string): { select(columns: string): AiModelSelectionQuery };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface AiModelSelectionLogger {
  warn(message: string): void;
}

export interface AiModelSelectionInput {
  /**
   * The CALLER-authenticated client (anon key + the caller's own bearer token).
   * Every read below therefore runs under the caller's own RLS, and the access
   * RPC sees the caller's `auth.uid()`. No elevated key is used or accepted.
   */
  client: AiModelSelectionClient;
  /**
   * The authoritative authenticated user id, from the endpoint's own
   * `auth.getUser()`. This module deliberately does NOT authenticate: doing so
   * twice would create a second identity source that could disagree with the
   * first. A user id from a request body must never reach this parameter.
   */
  userId: string;
  /**
   * Paperlume's system default, already resolved by the caller, as provider
   * AND model metadata — the safe fallback for every failure mode below.
   *
   * Deliberately not a bare model string and deliberately not assumed to be
   * Google: this module never manufactures a provider id, it only ever returns
   * the one it was given or one a catalog row named and the registry accepted.
   * Today every caller supplies `resolveSystemDefaultAiModel(GEMINI_MODEL)`.
   */
  systemDefault: AiProviderModel<RegisteredAiProvider>;
  /** Log prefix, e.g. `"analyze-paper"`. */
  label: string;
  logger?: AiModelSelectionLogger;
}

/** Reasons that describe an ordinary, uninteresting request. */
const QUIET_REASONS: ReadonlySet<AiModelFallbackReason> = new Set<AiModelFallbackReason>([
  "not_entitled",
  "no_preference",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Non-empty and already trimmed — the same rule the catalog CHECK constraints enforce. */
function isTrimmedNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/**
 * Resolve the model this request should actually be sent to.
 *
 * Never throws and never rejects: every failure mode below returns the system
 * default, because an exception escaping here would convert a metadata problem
 * into a failed AI request.
 */
export async function resolveEffectiveAiModel(
  input: AiModelSelectionInput,
): Promise<AiModelSelection> {
  const { client, userId, systemDefault, label, logger } = input;

  // Step 1 — the safe value, available from the first line onward.
  const fallback = (reason: AiModelFallbackReason): AiModelSelection => {
    if (!QUIET_REASONS.has(reason)) {
      // Bounded and non-sensitive by construction: a fixed label, one of the
      // literals above, and nothing else. Never a user id, an email, a token,
      // an API key or a database error body.
      logger?.warn(`${label} model_selection_fallback reason=${reason}`);
    }
    return {
      provider: systemDefault.provider,
      providerModel: systemDefault.providerModel,
      source: "system_default",
      fallbackReason: reason,
      // Automatic. See the field's own documentation: a fallback model is never
      // the model a saved manual level was chosen for.
      reasoningPreference: null,
    };
  };

  // Step 2 — current entitlement, from the database's own access projection.
  //
  // `get_current_user_access()` is SECURITY DEFINER and derives the caller from
  // `auth.uid()`; it takes no user-id argument, so this cannot ask about anyone
  // else. Commercial plan arithmetic is NOT re-implemented here: there is no
  // `plan === "pro"` comparison, no email check and no internal-role check in
  // this file. A saved preference survives a downgrade deliberately (it stays
  // dormant), which is exactly why entitlement is re-proven on EVERY operation
  // rather than inferred from the preference row existing.
  let accessData: unknown;
  try {
    const { data, error } = await client.rpc("get_current_user_access", {});
    if (error) return fallback("access_lookup_failed");
    accessData = data;
  } catch {
    return fallback("access_lookup_failed");
  }

  // SETOF-returning RPC — supabase-js surfaces it as an array. Same defensive
  // read `get-gemini-provider-quota` uses.
  const accessRow = Array.isArray(accessData) ? accessData[0] : accessData;
  if (!isRecord(accessRow)) return fallback("invalid_access_row");
  if (accessRow.can_select_ai_model !== true) return fallback("not_entitled");

  // Step 3 — the caller's saved preference.
  //
  // `.eq("user_id", userId)` is defence in depth, not the guard: the SELECT-own
  // RLS policy already makes a foreign row unreachable through this anon-key
  // client. Both have to fail before another user's preference could be read.
  let preferenceRow: Record<string, unknown> | null;
  try {
    const { data, error } = await client
      .from("user_ai_preferences")
      // `preferred_reasoning_level` joins an explicit projection rather than a
      // `select("*")`: the columns this routing path reads are stated, so a
      // future column on this table has to be admitted deliberately.
      .select("preferred_model_id,preferred_reasoning_level")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return fallback("preference_lookup_failed");
    preferenceRow = data;
  } catch {
    return fallback("preference_lookup_failed");
  }

  // `user_id` is the primary key, so "no row" is a first-class state meaning
  // "this user has expressed no preference" — not an error, and not noisy.
  if (preferenceRow === null || preferenceRow === undefined) return fallback("no_preference");
  if (!isRecord(preferenceRow)) return fallback("invalid_preference");

  const preferredModelId = preferenceRow.preferred_model_id;
  // Trimmed-non-empty mirrors the catalog's `id = btrim(id) AND id <> ''`
  // CHECK: a value that could not legally be a catalog id is malformed here
  // rather than something to go looking for.
  if (!isTrimmedNonEmpty(preferredModelId)) return fallback("invalid_preference");

  // The saved manual reasoning level, read defensively.
  //
  // NULL is the ordinary and overwhelmingly common state, and it MEANS
  // Automatic — it is not a missing value to go looking for. A non-null value
  // that is not one of PaperLume's canonical literals is treated as Automatic
  // too rather than failing the request: a malformed reasoning level is not a
  // reason to deny someone their analysis, and the value must not reach a
  // provider or a log line either way. The level is NOT validated against the
  // model here — that needs the catalog's reasoning metadata, which is
  // `aiReasoningPolicy.ts`'s read, and duplicating it would create the second
  // authority this module exists to avoid.
  const rawReasoning = preferenceRow.preferred_reasoning_level;
  const reasoningPreference: AiReasoningLevel | null = isAiReasoningLevel(rawReasoning)
    ? rawReasoning
    : null;

  // Step 4 — authoritative catalog resolution. The catalog IS the allowlist.
  let catalogRow: Record<string, unknown> | null;
  try {
    const { data, error } = await client
      .from("ai_model_catalog")
      .select("id,provider,provider_model,enabled,selectable")
      .eq("id", preferredModelId)
      .maybeSingle();
    if (error) return fallback("catalog_lookup_failed");
    catalogRow = data;
  } catch {
    return fallback("catalog_lookup_failed");
  }

  if (catalogRow === null || catalogRow === undefined) return fallback("model_missing");
  if (!isRecord(catalogRow)) return fallback("invalid_catalog_row");

  // The row we got back must be the row we asked for. A filter that silently
  // stopped filtering would otherwise route this user to whatever came first.
  if (catalogRow.id !== preferredModelId) return fallback("invalid_catalog_row");

  if (typeof catalogRow.enabled !== "boolean") return fallback("invalid_catalog_row");
  // `enabled` is required; `selectable` deliberately is NOT — see the header.
  // A retired model (`enabled = false`) falls back; a model merely closed to
  // new choices (`selectable = false`) keeps working for whoever already saved
  // it.
  if (catalogRow.enabled !== true) return fallback("model_disabled");

  // Step 5 — provider adapter boundary. The runtime registry is asked whether a
  // reviewed adapter exists for this row's provider; today exactly one does.
  // A row naming anything else is refused HERE, before any URL, credential or
  // request for that provider could be constructed.
  if (!isTrimmedNonEmpty(catalogRow.provider)) return fallback("invalid_catalog_row");
  if (!isRegisteredAiProvider(catalogRow.provider)) return fallback("unsupported_provider");

  // Whatever this string is goes verbatim into the provider URL, so it must be
  // exactly what the catalog's own CHECK guarantees: non-empty and trimmed.
  if (!isTrimmedNonEmpty(catalogRow.provider_model)) return fallback("invalid_catalog_row");

  return {
    provider: catalogRow.provider,
    providerModel: catalogRow.provider_model,
    source: "user_preference",
    fallbackReason: null,
    // Reached only when the saved preference was honoured in full, which is
    // exactly the condition under which a manual reasoning level is meaningful.
    reasoningPreference,
  };
}

/**
 * The one bounded routing line a provider-bound request may log.
 *
 * Public model metadata only: which operation, where the choice came from,
 * which provider, which model. No user id, no email, no token, no key, no
 * preference row id, no paper title/abstract and no Projects/Tags.
 */
export function formatModelRoutingLog(label: string, selection: AiModelSelection): string {
  return (
    `${label} model_routing source=${selection.source} ` +
    `provider=${selection.provider} model=${selection.providerModel}`
  );
}
