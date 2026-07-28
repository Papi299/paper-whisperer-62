// Centralized Gemini model configuration — shared by analyze-paper and
// get-gemini-provider-quota so the two functions can never silently disagree
// about which model is in use.
//
// Pure module: no Deno APIs, no remote imports. The Deno callers read the
// environment (Deno.env.get("GEMINI_MODEL")) and pass the value to
// resolveGeminiModel(); Node/Vitest can import and test resolveGeminiModel
// directly without a Deno runtime.
//
// This does NOT change the production model choice — DEFAULT_GEMINI_MODEL is the
// exact behavioral fallback the code has always used. A future GEMINI_MODEL
// secret can override it without touching either function. Note that a "-latest"
// alias does not permanently map to one concrete model; Monitoring reports the
// concrete model label separately (see geminiMonitoring.ts observedModels).

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
