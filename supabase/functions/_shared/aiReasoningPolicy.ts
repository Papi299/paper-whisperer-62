// PaperLume's reasoning policy — AI-MULTI-PROVIDER-001C (C41).
//
// ONE implementation, shared by `analyze-paper` and `suggest-paper-organization`,
// answering one question per request: **how hard should the model think, and who
// decided?**
//
// A second copy of this decision is the failure this module exists to prevent.
// The two operations would eventually disagree about what Automatic means, and
// the disagreement would be invisible — Analyze and Suggest would simply cost
// and behave differently for reasons nobody chose.
//
// ## Automatic is a PaperLume policy, not a provider default
//
// The load-bearing idea, and the reason this module exists rather than nothing
// existing. "Automatic" does NOT mean:
//
//     omit the provider's reasoning parameter and inherit whatever that
//     provider currently defaults to
//
// It means PaperLume explicitly chooses a level, per MODEL and per OPERATION,
// from the server-controlled `ai_model_catalog`, and sends it. Every provider
// default is a fact about that provider on a given day: Gemini's is `medium`,
// Sonnet 5 runs adaptive thinking at effort `high`, Terra's effort is `medium`.
// Any of them can move without warning, and none of them was ever a decision
// PaperLume made. Inheriting one by omission would make PaperLume's product
// behaviour a function of somebody else's release notes.
//
// The approved Automatic matrix for the models that exist today — analyze gets
// the cheaper setting because it extracts three short fields from an abstract,
// while organization suggestions must weigh a whole library:
//
//     model              analyze    organization suggestions
//     ---------------    -------    ------------------------
//     gemini-3.5-flash   minimal    medium
//     gemini-3.6-flash   minimal    medium
//     gemini-3.7-flash   low        medium
//     gemini-3.8-flash   low        medium
//
// Those values are NOT written here. They are catalog rows, for the same reason
// the model list is: a TypeScript copy would be a second authority that could
// disagree with the database, and adding a model would stop being a reviewed
// migration and start being a deployment.
//
// ## Manual applies to BOTH operations
//
// A user who picks a level picks it once. `Reasoning level = High` means
// Analyze at high and organization suggestions at high — deliberately simpler
// than two controls, and the reason this module takes the operation as an input
// yet ignores it on the manual path.
//
// ## The one thing that is NOT ordinary Automatic
//
// `provider_default` is a bounded EMERGENCY path for policy metadata that
// cannot be trusted — a failed catalog read, a missing row, an Automatic level
// its own model does not list. It preserves the feature rather than failing it,
// and it is a distinct `source` with its own reason precisely so it can never be
// reported, logged or reasoned about as though PaperLume deliberately selected
// the provider's default. It is a fail-open compatibility path, and the log
// line says so.
//
// Pure module: no Deno APIs and no remote imports, so Node/Vitest exercises the
// exact shipped policy with a fake client rather than a re-implementation.

import {
  isAiReasoningLevel,
  type AiCallPolicy,
  type AiReasoningLevel,
} from "./aiProvider.ts";
import type { AiModelSelection, AiModelSelectionClient } from "./aiModelSelection.ts";

/**
 * The two generation operations PaperLume runs.
 *
 * A closed union rather than a string, because every table in this module is
 * indexed by it: adding a third operation must force a decision about its
 * Automatic column and its output ceiling, not inherit one by accident.
 */
export type AiOperation = "analyze" | "suggest";

/**
 * PaperLume's per-operation hard output ceiling, in tokens.
 *
 * SAFETY CEILINGS, not expected usage. On every current provider this bound
 * covers reasoning AND answer together, so it is also the backstop that keeps
 * even `max` effort bounded — which is why the user-facing copy for Max says
 * "maximum reasoning effort within PaperLume's output limits" rather than
 * "unlimited".
 *
 * Analyze is 4096: it returns three short strings from one abstract, and a
 * larger ceiling would buy nothing but exposure. Suggest is 8192: it returns up
 * to three existing Projects, five existing Tags, two new Projects and three new
 * Tags, each with a reason of up to 400 characters, so its worst legitimate
 * answer is several times Analyze's.
 *
 * These replace the provisional flat 4096 the two 001B adapters carried as
 * their own constants. The number belonged to the OPERATION all along: an
 * adapter that picked it would have had to infer which Edge Function called it,
 * and the only available evidence would have been the prompt text.
 *
 * The Google adapter deliberately does not send a ceiling at all — see its
 * request builder. Gemini has always run against its own default output limit
 * here, 001C's Automatic levels move Analyze's reasoning DOWN rather than up,
 * and introducing an unmeasured ceiling on the one provider actually serving
 * Production traffic is a change 001D's usage telemetry should justify first.
 */
export const AI_OPERATION_MAX_OUTPUT_TOKENS: Readonly<Record<AiOperation, number>> = Object.freeze({
  analyze: 4096,
  suggest: 8192,
});

/** Which catalog column holds the Automatic level for each operation. */
const AI_OPERATION_AUTOMATIC_COLUMN: Readonly<Record<AiOperation, string>> = Object.freeze({
  analyze: "auto_analyze_reasoning_level",
  suggest: "auto_suggest_reasoning_level",
});

/** Who decided the reasoning level on this request. */
export type AiReasoningPolicySource = "automatic" | "manual" | "provider_default_fallback";

/**
 * Bounded, non-sensitive reason the ordinary path was not taken.
 *
 * `null` on a healthy request. Everything here is a fixed literal safe to log
 * beside the operation name — none of it names a user, a paper or a row.
 *
 *   * `manual_level_unsupported` — the caller has a saved manual level the
 *     effective model does not list. The request still succeeds, at that
 *     model's Automatic policy. The saved preference is deliberately NOT
 *     rewritten from here: the runtime path does not own the user's settings,
 *     and a Settings visit is where a stale choice gets corrected.
 *   * `catalog_lookup_failed` / `metadata_missing` / `invalid_metadata` /
 *     `no_automatic_policy` — the four ways policy metadata can be unusable.
 *     Each resolves to `provider_default`, the fail-open path.
 */
export type AiReasoningPolicyReason =
  | "manual_level_unsupported"
  | "catalog_lookup_failed"
  | "metadata_missing"
  | "invalid_metadata"
  | "no_automatic_policy";

/**
 * The reasoning decision, plus how it was reached.
 *
 * `policy` is what an adapter receives. `source` and `reason` are what a log
 * line and a future telemetry record receive, and are carried separately
 * precisely because the adapter must NOT be able to behave differently
 * depending on who chose the level: Automatic `medium` and manual `medium` are
 * the same bytes on the wire, and a provider that could tell them apart would
 * be an invitation to make them differ.
 */
export interface AiReasoningPolicyDecision {
  readonly policy: AiCallPolicy<AiReasoningLevel>;
  readonly source: AiReasoningPolicySource;
  /** `null` exactly when the ordinary path was taken with no complaint. */
  readonly reason: AiReasoningPolicyReason | null;
}

export interface AiReasoningPolicyInput {
  /**
   * The CALLER-authenticated client. The catalog read below therefore runs
   * under the caller's own RLS, through the same structurally read-only surface
   * `resolveEffectiveAiModel` uses — there is no `insert`, `update` or `delete`
   * on that interface, so this module cannot write the metadata it reads.
   */
  client: AiModelSelectionClient;
  operation: AiOperation;
  /**
   * The already-resolved model decision, from `resolveEffectiveAiModel`.
   *
   * Deliberately the whole decision rather than a provider/model pair: this
   * module needs `source` as well, because a manual reasoning level is only
   * meaningful for the model the user actually chose.
   */
  selection: AiModelSelection;
  /** Log prefix, e.g. `"analyze-paper"`. */
  label: string;
  logger?: { warn(message: string): void };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read a catalog row's level list, or `null` if it is not a usable list. */
function readReasoningLevels(value: unknown): AiReasoningLevel[] | null {
  if (!Array.isArray(value)) return null;
  const levels: AiReasoningLevel[] = [];
  for (const entry of value) {
    // A single uncanonical member invalidates the whole list rather than being
    // skipped. A silently shortened capability list is a worse failure than an
    // obviously unusable one: it would quietly reclassify a user's valid saved
    // level as unsupported.
    if (!isAiReasoningLevel(entry)) return null;
    levels.push(entry);
  }
  return levels;
}

/**
 * Resolve the reasoning policy for one request.
 *
 * Never throws and never rejects: every failure mode below returns a usable
 * policy, because an exception escaping here would convert a metadata problem
 * into a failed AI request — and, in `analyze-paper`, into a refunded quota unit
 * for a user whose paper was perfectly fine.
 */
export async function resolveAiReasoningPolicy(
  input: AiReasoningPolicyInput,
): Promise<AiReasoningPolicyDecision> {
  const { client, operation, selection, label, logger } = input;
  const maxOutputTokens = AI_OPERATION_MAX_OUTPUT_TOKENS[operation];

  const warn = (reason: AiReasoningPolicyReason): void => {
    // Bounded and non-sensitive by construction: a fixed label, the operation,
    // one of the literals above, and the public provider/model names. Never a
    // user id, an email, a token, a key or a database error body.
    logger?.warn(
      `${label} reasoning_policy_fallback reason=${reason} ` +
        `provider=${selection.provider} model=${selection.providerModel}`,
    );
  };

  const providerDefault = (reason: AiReasoningPolicyReason): AiReasoningPolicyDecision => {
    warn(reason);
    return {
      policy: { reasoning: { kind: "provider_default" }, maxOutputTokens },
      source: "provider_default_fallback",
      reason,
    };
  };

  // The saved manual level, and the one condition under which it counts.
  //
  // `resolveEffectiveAiModel` already clears the preference on every fallback
  // path, so this re-check is defence in depth rather than the guard — but it
  // is the check that states the rule, and the rule matters: a manual level was
  // chosen FOR a specific model. When selection fell back to PaperLume's system
  // default (a downgrade, a retired model, a malformed row, a metadata failure),
  // the model the user reasoned about is not the model being called, and their
  // level must not follow the request onto it.
  const manualLevel =
    selection.source === "user_preference" ? selection.reasoningPreference : null;

  // Resolve this model's reasoning metadata. The catalog's (provider,
  // provider_model) UNIQUE constraint is what makes this a lookup rather than a
  // search, and it works for BOTH selection sources: PaperLume's system default
  // has no catalog id to look up by, only a provider and a model string.
  let row: Record<string, unknown> | null;
  try {
    const { data, error } = await client
      .from("ai_model_catalog")
      .select(
        "provider,provider_model,reasoning_levels," +
          "auto_analyze_reasoning_level,auto_suggest_reasoning_level",
      )
      .eq("provider", selection.provider)
      .eq("provider_model", selection.providerModel)
      .maybeSingle();
    if (error) return providerDefault("catalog_lookup_failed");
    row = data;
  } catch {
    return providerDefault("catalog_lookup_failed");
  }

  if (row === null || row === undefined) {
    // No catalog row for the effective model. Reachable today without anything
    // being broken: PaperLume's system default comes from the GEMINI_MODEL
    // environment, which is not required to name a catalogued model.
    return providerDefault("metadata_missing");
  }
  if (!isRecord(row)) return providerDefault("invalid_metadata");

  // The row we got back must be the row we asked for. A filter that silently
  // stopped filtering would otherwise apply some other model's reasoning policy.
  if (row.provider !== selection.provider || row.provider_model !== selection.providerModel) {
    return providerDefault("invalid_metadata");
  }

  const levels = readReasoningLevels(row.reasoning_levels);
  if (levels === null) return providerDefault("invalid_metadata");

  // Manual first: it is the user's explicit instruction and outranks the
  // operation's Automatic level for BOTH operations.
  if (manualLevel !== null && levels.includes(manualLevel)) {
    return {
      policy: { reasoning: { kind: "level", level: manualLevel }, maxOutputTokens },
      source: "manual",
      reason: null,
    };
  }

  const autoRaw = row[AI_OPERATION_AUTOMATIC_COLUMN[operation]];
  if (autoRaw === null || autoRaw === undefined) {
    // The row exists and is well formed, but states no PaperLume policy for
    // this operation. Distinct from `invalid_metadata` because nothing is
    // wrong — the catalog simply has no opinion, and fail-open is the answer.
    return providerDefault("no_automatic_policy");
  }
  if (!isAiReasoningLevel(autoRaw) || !levels.includes(autoRaw)) {
    // An Automatic level its OWN model does not support. A database CHECK
    // forbids this, so reaching it means the constraint is gone or the row was
    // written around it — either way the value must not be sent, because the
    // provider would reject the request and the user would pay for it.
    return providerDefault("invalid_metadata");
  }

  if (manualLevel !== null) {
    // A saved manual level the effective model no longer lists. The feature
    // still works, at this model's Automatic policy, and the invalid value is
    // never sent. One bounded line says so; the user's stored preference is
    // left exactly as they set it.
    warn("manual_level_unsupported");
    return {
      policy: { reasoning: { kind: "level", level: autoRaw }, maxOutputTokens },
      source: "automatic",
      reason: "manual_level_unsupported",
    };
  }

  return {
    policy: { reasoning: { kind: "level", level: autoRaw }, maxOutputTokens },
    source: "automatic",
    reason: null,
  };
}

/**
 * The one bounded reasoning line a provider-bound request may log.
 *
 * Public policy metadata only: which operation, who decided, and the concrete
 * public level. No user id, no email, no token, no key, no preference row, no
 * paper title or abstract, and no Projects or Tags.
 *
 * The level is printed as `provider_default` on the emergency path rather than
 * as a level, so a reader can never mistake the fail-open case for a level
 * PaperLume chose.
 */
export function formatReasoningPolicyLog(
  label: string,
  operation: AiOperation,
  decision: AiReasoningPolicyDecision,
): string {
  const level =
    decision.policy.reasoning.kind === "level"
      ? decision.policy.reasoning.level
      : "provider_default";
  return (
    `${label} reasoning_policy operation=${operation} source=${decision.source} ` +
    `level=${level} max_output_tokens=${decision.policy.maxOutputTokens}`
  );
}
