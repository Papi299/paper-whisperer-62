// Provider → server-side credential NAME — AI-MULTI-PROVIDER-001C (C41).
//
// One reviewed table answering one question: **which environment variable holds
// the credential for this provider?**
//
// It holds no credential VALUE, reads no environment and performs no I/O. It
// maps a registered provider id to the NAME of the Edge secret the shell should
// read, and stops there — which is what lets the real shipped mapping be
// exercised by Vitest in Node, with no secret anywhere near the test process.
//
// ## Why a per-provider name, and never a generic one
//
// Before 001C both generation operations read `GEMINI_API_KEY` unconditionally,
// because Google was the only routable provider. With three registered
// adapters that would be a real hazard rather than a tidiness problem: a
// request routed to Anthropic while still reading Google's variable would put
// PaperLume's Gemini key in an `x-api-key` header addressed to
// api.anthropic.com. Sending one provider a different provider's secret is the
// worst outcome available here, and it is precisely what a single shared
// credential lookup makes easy.
//
// So there is deliberately NO generic `AI_API_KEY`. A generic name would be a
// single value that every provider accepts, which is the same hazard wearing a
// tidier name — and it would make "which provider has a credential installed?"
// unanswerable, when that is exactly the question a staged rollout asks.
//
// ## Where a credential may and may not appear
//
//   * The VALUE lives only in the Edge Function environment and in the one
//     `deps.apiKey` field that carries it to the adapter for that provider.
//   * It is never in `ai_model_catalog` — the catalog is product metadata and a
//     migration self-check proves no column of it could hold credential
//     material (C33).
//   * It is never in a request body, a query parameter, a log line or a
//     provider-neutral result.
//   * The NAME may be logged. `OPENAI_API_KEY` is not a secret; "the selected
//     provider's credential is missing" is undiagnosable without it, and the
//     alternative — logging nothing — is what turns a misconfigured deployment
//     into an unexplained 500.
//
// Pure module: no Deno APIs, no remote imports, and no `Deno.env` access. The
// Edge Function shell owns environment reads.

import type { RegisteredAiProvider } from "./aiProviderRegistry.ts";

/**
 * The environment variable holding each registered provider's credential.
 *
 * A mapped type over `RegisteredAiProvider`, so registering a fourth provider
 * without binding it to a credential name does not compile. That is the
 * invariant worth enforcing in types: an adapter with no credential name has no
 * safe behaviour — it either reads nothing and fails at runtime, or reads
 * somebody else's variable.
 *
 * `GEMINI_API_KEY` keeps its historical name rather than being renamed to
 * `GOOGLE_API_KEY` for symmetry. It is an installed Production secret that all
 * four current Gemini models already share; renaming it would be a Production
 * secret rotation dressed up as a refactor, and this task ships no Production
 * change at all.
 */
export const AI_PROVIDER_CREDENTIAL_ENV_NAMES: {
  readonly [Provider in RegisteredAiProvider]: string;
} = Object.freeze({
  google: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
});

/**
 * The environment variable name for one registered provider.
 *
 * Total by construction: the parameter type admits only providers that have an
 * entry, so there is no lookup-failure branch for a caller to mishandle, and
 * the only runtime path to a provider id — `resolveEffectiveAiModel` — already
 * narrows through the registry.
 */
export function aiProviderCredentialEnvName(provider: RegisteredAiProvider): string {
  return AI_PROVIDER_CREDENTIAL_ENV_NAMES[provider];
}

/**
 * Resolve the credential for a provider from an injected environment reader.
 *
 * The reader is injected rather than reached for, exactly like `fetchImpl` in
 * the adapters, so the shipped resolution logic is what the tests exercise. It
 * is handed ONE name and can only answer about that name, so a test proving
 * "Anthropic never reads GEMINI_API_KEY" is a test of this function's real
 * behaviour rather than of a mock.
 *
 * A present-but-blank value is treated as missing. An empty secret is a
 * misconfiguration, and sending an empty `Authorization: Bearer ` header would
 * turn it into an unexplained provider 401.
 *
 * Returns the NAME alongside the outcome so the caller can log which variable
 * is missing without re-deriving it, and never returns the value on the failure
 * path.
 */
export function resolveAiProviderCredential(
  provider: RegisteredAiProvider,
  readEnv: (name: string) => string | undefined | null,
): { readonly ok: true; readonly envName: string; readonly apiKey: string }
  | { readonly ok: false; readonly envName: string } {
  const envName = aiProviderCredentialEnvName(provider);
  const value = readEnv(envName);
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, envName };
  }
  return { ok: true, envName, apiKey: value };
}
