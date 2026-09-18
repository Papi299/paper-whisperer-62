/**
 * analyze-paper's operational log lines, in one testable place —
 * EDGE-LOG-PRIVACY-HARDENING-001.
 *
 * ## Why this module exists
 *
 * `index.ts` is a `Deno.serve` shell with remote (`https://esm.sh/…`) imports,
 * so Vitest cannot import it; the repository's standing position is that only
 * pure modules are Node-importable. Before this task the two failure log lines
 * were built inline there, which meant the security property — *no arbitrary
 * throwable text reaches a log* — could only ever be asserted by reading the
 * source, never by executing it.
 *
 * The decision now lives here, so the shipped line is produced by code a test
 * can call with a hostile `Error` and inspect. This is deliberately the
 * smallest surface that makes that possible: formatting only. No routing, no
 * classification, no refund, no telemetry, no response construction moved.
 *
 * ## The rule these functions encode
 *
 * A log line may contain server-generated bounded facts only:
 *
 *   * the operation label;
 *   * the `ProviderErrorClass` the function already computed;
 *   * one of the fixed `AnalyzeProviderFailureReason` literals below;
 *   * a `BoundedErrorName` from the shared allowlist.
 *
 * It may never contain `message`, `stack`, `cause`, a serialization of the
 * throwable, generated model text, request input, or a URL.
 */

import { boundedErrorName } from "../_shared/boundedLogging.ts";
import type { ProviderErrorClass } from "../_shared/providerError.ts";

/**
 * Every reason a provider call can fail, as this function reports it.
 *
 * Provider-neutral by name (AI-MULTI-PROVIDER-001C registered three providers;
 * a Claude or OpenAI parse failure must not be logged as a "Gemini" failure),
 * and closed: `provider_http_${number}` admits a status code and nothing else,
 * so no branch can widen these into free text.
 *
 * `provider_json_parse_failed` is the one that used to carry content. The
 * parser's own exception quoted the generated answer; the fact worth keeping is
 * that the answer did not parse, which this literal states.
 */
export type AnalyzeProviderFailureReason =
  | `provider_http_${number}`
  /**
   * `AiProviderResult.status` is optional on the failure variant (it is
   * documented as "present only for `kind: http`"), so the type permits an
   * HTTP failure that carries no status. The previous string concatenation
   * would have logged the literal text `gemini_http_undefined`; this states
   * the case instead. No adapter produces it today.
   */
  | "provider_http_unknown"
  | "provider_network"
  | "provider_timeout"
  | "provider_unreadable_response"
  | "provider_incomplete_response"
  | "provider_empty_response"
  | "provider_no_json"
  | "provider_json_parse_failed"
  | "provider_unknown";

/** Runtime-required variables this function reads by name. */
export type AnalyzeRequiredEnvName = "SUPABASE_URL" | "SUPABASE_ANON_KEY";

/**
 * The provider-failure line: which class, and which bounded reason.
 *
 * Replaces `console.error("analyze-paper provider failure:", providerErrorClass,
 * geminiErr.message)`, whose third argument was the throwable's own text.
 */
export function analyzeProviderFailureLog(
  providerClass: ProviderErrorClass,
  reason: AnalyzeProviderFailureReason,
): string {
  return `analyze-paper provider_failure class=${providerClass} reason=${reason}`;
}

/**
 * The outer request-failure line.
 *
 * Takes the throwable — so the call site cannot be tempted to reach into it —
 * and reduces it to an allow-listed name. This is the catch that a malformed
 * `req.json()` body reaches, so before this change a caller could put a
 * fragment of their own request into the Edge log by sending broken JSON.
 */
export function analyzeRequestFailureLog(error: unknown): string {
  return `analyze-paper request_failed error=${boundedErrorName(error)}`;
}

/**
 * A runtime-required variable is missing.
 *
 * The variable's NAME is the whole diagnostic value here, and a name is not a
 * secret — docs/deployment.md §10.2 treats "the actionable message naming the
 * variable goes to its Edge log" as the documented operator behaviour. Stating
 * it as its own bounded line keeps that property while the outer catch stops
 * logging `requireEdgeEnv`'s thrown message.
 */
export function analyzeEnvMissingLog(envName: AnalyzeRequiredEnvName): string {
  return `analyze-paper env_missing env=${envName}`;
}
