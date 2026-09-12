// The runtime provider-adapter registry — AI-MULTI-PROVIDER-001A (C39).
//
// Answers exactly one question: **does PaperLume have a real, reviewed adapter
// for provider X?**
//
// ## This is NOT a second model allowlist
//
// The database stays the authority on MODELS. `public.ai_model_catalog` decides
// which models a user may be routed to, and adding one for a provider that is
// already registered here remains a reviewed migration with no code change
// (C33/C35); a model from a NEW provider first needs a reviewed adapter here and
// that provider's own credential (C39). This registry decides which provider
// PROTOCOLS the server can speak at all — a different question with a different
// answer and a different review. A catalog row naming a provider that has no
// entry here is not called; it falls back to the system default with
// `unsupported_provider` (see `aiModelSelection.ts`).
//
// Keeping the two apart is the whole point:
//
//   * a TypeScript list of model strings would duplicate the catalog and could
//     disagree with it — that is forbidden, and no such list exists here;
//   * a database row alone must never be sufficient to make PaperLume send a
//     request to a provider whose credentials, request contract, error
//     semantics and privacy review do not exist yet.
//
// ## Registered providers: `google`, and nothing else
//
// There is deliberately no Anthropic entry, no OpenAI entry, no placeholder
// that throws "not implemented", no endpoint and no credential accessor for
// either. An unimplemented provider is absent, not stubbed: a stub is something
// a future edit can accidentally complete, while an absent adapter fails the
// registry lookup and falls back by construction.
//
// The Settings surface keeps its own provider-family filter
// (`src/hooks/useAiModelSettings.ts`), which names providers rather than models
// for the same reason. It mirrors this registry, and a task that registers a
// second adapter must move both.
//
// Pure module: no Deno APIs, no remote imports.

import { GOOGLE_AI_PROVIDER, GOOGLE_AI_PROVIDER_ADAPTER } from "./googleAiProvider.ts";
import { resolveGeminiModel } from "./geminiModel.ts";
import type { AiProviderAdapter, AiProviderModel } from "./aiProvider.ts";

/**
 * The providers PaperLume can actually call. Widening this union is the
 * explicit act of registering a provider protocol, and `AI_PROVIDER_ADAPTERS`
 * below will not type-check until a real adapter is supplied for the new
 * member.
 *
 * Declared from the adapter's own provider constant rather than derived from
 * the registry object, because the registry's type below is written in terms of
 * it. The two still cannot disagree: a missing, extra or mismatched registry
 * entry is a compile error.
 */
export type RegisteredAiProvider = typeof GOOGLE_AI_PROVIDER;

/**
 * Each registered provider id, mapped to the adapter FOR THAT provider.
 *
 * This mapped type is the key/adapter invariant stated as a type: the entry
 * under `google` must be an `AiProviderAdapter<"google">`, so registering one
 * provider's adapter under another's id does not compile. It is also what lets
 * `getAiProviderAdapter` hand back an adapter typed for exactly the provider it
 * was asked for, with no cast.
 */
type AiProviderAdapterRegistry = {
  readonly [Provider in RegisteredAiProvider]: AiProviderAdapter<Provider>;
};

// The explicit type argument is deliberate: it checks the object literal itself
// against the mapped type, so an extra entry is rejected as an excess property.
// An annotation on the const alone would only check the frozen result, and an
// extra key would pass unnoticed.
const AI_PROVIDER_ADAPTERS = Object.freeze<AiProviderAdapterRegistry>({
  [GOOGLE_AI_PROVIDER]: GOOGLE_AI_PROVIDER_ADAPTER,
});

/**
 * Is this provider id one PaperLume has an adapter for?
 *
 * `hasOwnProperty` rather than `in` or a truthiness check on the lookup:
 * `"constructor"`, `"toString"` and `"__proto__"` are all inherited properties
 * of an object literal, and a registry that answered `true` for them would let
 * a catalog row named `constructor` pass the adapter check.
 */
export function isRegisteredAiProvider(provider: unknown): provider is RegisteredAiProvider {
  return (
    typeof provider === "string" &&
    Object.prototype.hasOwnProperty.call(AI_PROVIDER_ADAPTERS, provider)
  );
}

/**
 * The adapter for a registered provider, typed for exactly that provider.
 *
 * Total by construction: the parameter type admits only providers that have an
 * entry, so there is no lookup-failure branch for a caller to mishandle after
 * it has already consumed a quota unit. Reaching this function with an
 * unregistered provider is a compile error, and the only runtime path to a
 * provider id — `resolveEffectiveAiModel` — narrows through
 * `isRegisteredAiProvider` first.
 *
 * Generic so that provider identity survives the lookup:
 * `getAiProviderAdapter("google")` is an `AiProviderAdapter<"google">`, whose
 * `generate` accepts Google models only.
 */
export function getAiProviderAdapter<Provider extends RegisteredAiProvider>(
  provider: Provider,
): AiProviderAdapter<Provider> {
  return AI_PROVIDER_ADAPTERS[provider];
}

/** Every registered provider id, for tests and diagnostics. */
export function registeredAiProviders(): RegisteredAiProvider[] {
  return Object.keys(AI_PROVIDER_ADAPTERS) as RegisteredAiProvider[];
}

/**
 * PaperLume's SYSTEM DEFAULT model, as provider/model metadata.
 *
 * Today that is Google Gemini on the `GEMINI_MODEL` environment configuration,
 * resolved through the same `_shared/geminiModel.ts` all three Gemini callers
 * use, so `analyze-paper` and `suggest-paper-organization` still cannot
 * disagree about the default. It lives here rather than inside the model
 * resolver because the resolver must not assume "system default" means Google
 * forever — it treats this as opaque provider/model metadata and never
 * manufactures a provider of its own.
 *
 * The return type is narrowed to a REGISTERED provider, which is what makes
 * "the safe fallback is a provider we can actually call" a property of the
 * types rather than an assumption.
 */
export function resolveSystemDefaultAiModel(
  geminiModelEnvValue: string | undefined | null,
): AiProviderModel<RegisteredAiProvider> {
  return {
    provider: GOOGLE_AI_PROVIDER,
    providerModel: resolveGeminiModel(geminiModelEnvValue),
  };
}
