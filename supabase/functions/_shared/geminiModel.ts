// Paperlume's SYSTEM-DEFAULT Gemini model configuration.
//
// This is the model every AI request uses unless a *specific* authenticated,
// currently-entitled caller has a valid saved preference — see
// `_shared/aiModelSelection.ts` (AI-MODEL-SELECTION-001B, C33). It remains the
// authoritative system default and the safe fallback for every fallible step of
// that per-user resolution, so it is on the path of every AI request whether or
// not a preference is honoured.
//
// ## What changed about the old "can never disagree" invariant
//
// This module used to promise that `analyze-paper` and
// `get-gemini-provider-quota` "can never silently disagree about which model is
// in use". Half of that is still true and half of it is no longer:
//
//   * They can never disagree about the SYSTEM DEFAULT. All three callers
//     (`analyze-paper`, `suggest-paper-organization`, `get-gemini-provider-quota`)
//     still resolve it here, from the one `GEMINI_MODEL` value.
//
//   * They CAN now legitimately differ about the model a given generation
//     request actually used. An entitled user with a valid saved preference has
//     their Analyze/Suggest call routed to that model, while
//     `get-gemini-provider-quota` deliberately keeps reporting the configured
//     system default — it is system-wide provider monitoring, not a per-user
//     routing endpoint. That divergence is the feature, not drift.
//
// Pure module: no Deno APIs, no remote imports. The Deno callers read the
// environment (Deno.env.get("GEMINI_MODEL")) and pass the value to
// resolveGeminiModel(); Node/Vitest can import and test resolveGeminiModel
// directly without a Deno runtime.
//
// DEFAULT_GEMINI_MODEL is the exact behavioral fallback the code has always
// used, for when GEMINI_MODEL is unset. Production currently sets
// GEMINI_MODEL=gemini-3.6-flash, so the fallback is not the live value there.
// Note that a "-latest" alias does not permanently map to one concrete model;
// Monitoring reports the concrete model label separately (see
// geminiMonitoring.ts observedModels).

/** The exact model alias analyze-paper has always used. Behavioral fallback. */
export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

/**
 * Resolve the configured Gemini model from an optional env value, trimming
 * whitespace and falling back to DEFAULT_GEMINI_MODEL when unset/empty. Pure.
 */
export function resolveGeminiModel(envValue: string | undefined | null): string {
  if (typeof envValue === "string") {
    const trimmed = envValue.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return DEFAULT_GEMINI_MODEL;
}
