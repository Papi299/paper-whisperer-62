// Structured classification of an upstream Gemini/provider failure — Part F.
//
// Pure module (no Deno APIs, no remote imports): the analyze-paper Edge Function
// (Deno) and Vitest (Node) both import it. The goal is a machine-readable class
// the server can log/return WITHOUT leaking Google project details or raw
// provider bodies, and WITHOUT converting a provider rate-limit/quota event into
// a Paperlume commercial 402. A provider 429 is NOT user-plan exhaustion.

export type ProviderErrorClass =
  | "provider_rate_limit" // Google 429 / RESOURCE_EXHAUSTED — shared project limit, transient
  | "provider_unavailable" // 5xx, network, or timeout — retry later
  | "malformed_response" // 2xx but empty / unparseable / no JSON object
  | "unknown"; // anything else

export interface ProviderErrorInput {
  /** HTTP status from the provider call, when the failure was an HTTP response. */
  status?: number | null;
  /**
   * How the failure surfaced:
   *  - "http"    → a non-OK HTTP response (use `status`)
   *  - "network" → fetch threw / connection failure
   *  - "timeout" → request aborted on timeout
   *  - "empty"   → OK response but no candidates/text
   *  - "parse"   → OK response but JSON parse / shape failure
   */
  kind?: "http" | "network" | "timeout" | "empty" | "parse" | null;
}

/**
 * Classify a provider failure into a bounded machine class. Never includes any
 * provider text/credentials — callers pass only a status code and a coarse kind.
 */
export function classifyProviderError(input: ProviderErrorInput): ProviderErrorClass {
  const { status, kind } = input;

  if (kind === "empty" || kind === "parse") return "malformed_response";
  if (kind === "network" || kind === "timeout") return "provider_unavailable";

  if (typeof status === "number") {
    if (status === 429) return "provider_rate_limit";
    if (status >= 500) return "provider_unavailable";
    // 4xx other than 429: some providers use 403 RESOURCE_EXHAUSTED for quota.
    // Treat as a provider-side limit, still NOT a Paperlume plan exhaustion.
    if (status === 403) return "provider_rate_limit";
    if (status >= 400) return "unknown";
  }

  return "unknown";
}

/**
 * Neutral, non-operational user-facing message. The SAME wording for every
 * provider failure class so ordinary users never see Google/project detail; the
 * class is for logs/telemetry and the manager panel only.
 */
export const NEUTRAL_ANALYSIS_UNAVAILABLE_MESSAGE =
  "AI analysis is temporarily unavailable. Please try again later.";

/** True when the class is a provider-side limit (rate/quota), not a plan wall. */
export function isProviderLimit(cls: ProviderErrorClass): boolean {
  return cls === "provider_rate_limit";
}
