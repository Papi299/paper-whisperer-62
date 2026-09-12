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
// ## Registered providers: `google`, `anthropic`, `openai`
//
// AI-MULTI-PROVIDER-001C (C41) registered the two adapters 001B implemented and
// deliberately left out. Registration became correct at exactly the moment
// PaperLume had its own reasoning and output policy to send: before that, a
// registered Anthropic or OpenAI adapter would have inherited that provider's
// current reasoning default as PaperLume's product policy by omission, which is
// the specific harm 001B refused.
//
// Registration is a statement about PROTOCOLS, and it is still not a route to
// anything. Three separate things must also be true before a request can reach
// a non-Google provider, and none of them is true today:
//
//   * `ai_model_catalog` must hold an enabled row naming that provider — there
//     is no `anthropic/*` or `openai/*` row, and adding one is a reviewed
//     migration;
//   * that provider's credential must exist in the Edge environment — see
//     `./aiProviderCredentials.ts`; neither secret is installed;
//   * the Edge Functions must be deployed — Production still runs the pre-001A
//     runtime.
//
// An unimplemented provider is still absent rather than stubbed: there is no
// placeholder that throws "not implemented", because a stub is something a
// future edit can accidentally complete, while an absent adapter fails the
// registry lookup and falls back by construction.
//
// The Settings surface keeps its own provider-family filter
// (`src/hooks/useAiModelSettings.ts`), which names providers rather than models
// for the same reason. It mirrors this registry and moved with it.
//
// Pure module: no Deno APIs, no remote imports.

import {
  ANTHROPIC_AI_PROVIDER,
  ANTHROPIC_AI_PROVIDER_ADAPTER,
  type AnthropicReasoningLevel,
} from "./anthropicAiProvider.ts";
import {
  GOOGLE_AI_PROVIDER,
  GOOGLE_AI_PROVIDER_ADAPTER,
  type GoogleReasoningLevel,
} from "./googleAiProvider.ts";
import {
  OPENAI_AI_PROVIDER,
  OPENAI_AI_PROVIDER_ADAPTER,
  type OpenAiReasoningLevel,
} from "./openAiProvider.ts";
import { resolveGeminiModel } from "./geminiModel.ts";
import type {
  AiCallPolicy,
  AiGenerationRequest,
  AiProviderAdapter,
  AiProviderCallDeps,
  AiProviderModel,
  AiProviderResult,
  AiReasoningLevel,
} from "./aiProvider.ts";

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
export type RegisteredAiProvider =
  | typeof GOOGLE_AI_PROVIDER
  | typeof ANTHROPIC_AI_PROVIDER
  | typeof OPENAI_AI_PROVIDER;

/**
 * Which slice of PaperLume's canonical reasoning vocabulary each registered
 * provider's PROTOCOL can express.
 *
 * The binding lives here rather than in `aiProvider.ts` on purpose: the
 * contract module names no provider, and this module already imports all three
 * adapters, so this is the one place where "which provider" and "which levels"
 * are both already in scope. Each union is re-exported from the adapter that
 * owns it, so there is no second declaration of any provider's vocabulary.
 *
 * The mapped registry type below reads this, which is what makes "the Google
 * entry is an adapter that speaks Google's levels" a compile-time fact rather
 * than a convention.
 */
export interface RegisteredAiProviderReasoningLevel {
  readonly google: GoogleReasoningLevel;
  readonly anthropic: AnthropicReasoningLevel;
  readonly openai: OpenAiReasoningLevel;
}

// The keys of the interface above must be exactly the registered providers —
// no more, no fewer. Both directions are checked, so a provider added to the
// union without a level row, or a level row left behind by a provider that was
// removed, is a compile error in this file rather than a silent `never`.
type _ReasoningLevelKeysCoverProviders =
  Exclude<RegisteredAiProvider, keyof RegisteredAiProviderReasoningLevel> extends never ? true : never;
type _ReasoningLevelKeysAreProviders =
  Exclude<keyof RegisteredAiProviderReasoningLevel, RegisteredAiProvider> extends never ? true : never;
const _REASONING_LEVEL_KEYS_COVER_PROVIDERS: _ReasoningLevelKeysCoverProviders = true;
const _REASONING_LEVEL_KEYS_ARE_PROVIDERS: _ReasoningLevelKeysAreProviders = true;
void _REASONING_LEVEL_KEYS_COVER_PROVIDERS;
void _REASONING_LEVEL_KEYS_ARE_PROVIDERS;

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
  readonly [Provider in RegisteredAiProvider]: AiProviderAdapter<
    Provider,
    RegisteredAiProviderReasoningLevel[Provider]
  >;
};

// The explicit type argument is deliberate: it checks the object literal itself
// against the mapped type, so an extra entry is rejected as an excess property.
// An annotation on the const alone would only check the frozen result, and an
// extra key would pass unnoticed.
const AI_PROVIDER_ADAPTERS = Object.freeze<AiProviderAdapterRegistry>({
  [GOOGLE_AI_PROVIDER]: GOOGLE_AI_PROVIDER_ADAPTER,
  [ANTHROPIC_AI_PROVIDER]: ANTHROPIC_AI_PROVIDER_ADAPTER,
  [OPENAI_AI_PROVIDER]: OPENAI_AI_PROVIDER_ADAPTER,
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
 * Generic so that provider identity survives the lookup, in BOTH dimensions:
 * `getAiProviderAdapter("google")` is an
 * `AiProviderAdapter<"google", GoogleReasoningLevel>`, whose `generate` accepts
 * Google models and Google reasoning levels only.
 *
 * For DISPATCH on a provider that is only known at runtime, use
 * `generateWithRegisteredAiProvider` below rather than this: a value of the
 * whole `RegisteredAiProvider` union instantiates `Level` to the union of every
 * provider's levels, which is exactly the precision the second type parameter
 * exists to keep.
 */
export function getAiProviderAdapter<Provider extends RegisteredAiProvider>(
  provider: Provider,
): AiProviderAdapter<Provider, RegisteredAiProviderReasoningLevel[Provider]> {
  return AI_PROVIDER_ADAPTERS[provider];
}

/**
 * Narrow a provider-neutral call policy to ONE adapter's reasoning vocabulary.
 *
 * The last structural guard before a request is built. Policy resolution has
 * already refused any level the CATALOG does not list for this model, so
 * reaching the rejection branch below means the catalog and the provider
 * disagree — a hand-edited row, a stale seed, or a provider that withdrew a
 * level. Sending it anyway would spend the user's quota unit on a 400.
 *
 * The refusal degrades to `provider_default` rather than failing the request,
 * for the same reason every other metadata problem does: a policy outage must
 * not become a feature outage. It emits one bounded line naming the provider
 * and the public level, and nothing else.
 */
function narrowCallPolicy<Level extends AiReasoningLevel>(
  adapter: { readonly supportsReasoningLevel: (level: AiReasoningLevel) => level is Level },
  provider: RegisteredAiProvider,
  policy: AiCallPolicy<AiReasoningLevel>,
  deps: AiProviderCallDeps,
): AiCallPolicy<Level> {
  if (policy.reasoning.kind === "level") {
    const level = policy.reasoning.level;
    if (adapter.supportsReasoningLevel(level)) {
      return { reasoning: { kind: "level", level }, maxOutputTokens: policy.maxOutputTokens };
    }
    deps.logger?.warn(
      `${deps.label} reasoning_level_rejected_by_adapter provider=${provider} level=${level}`,
    );
  }
  return { reasoning: { kind: "provider_default" }, maxOutputTokens: policy.maxOutputTokens };
}

/**
 * Send one generation through the adapter for a resolved provider.
 *
 * The ONE place a provider-neutral decision becomes a provider-specific call,
 * shared by both generation operations so they cannot drift in how they
 * dispatch. It exists because the per-provider reasoning types deliberately do
 * not unify: an `AiCallPolicy<AiReasoningLevel>` is not an
 * `AiCallPolicy<GoogleReasoningLevel>`, and the narrowing that bridges them is
 * a runtime check. Written once here, that check is reviewed once; written at
 * each call site it would be two copies of a security-shaped decision.
 *
 * The `switch` is exhaustive over `RegisteredAiProvider` and the default branch
 * assigns to `never`, so registering a fourth provider without teaching this
 * function about it is a compile error rather than a silent fallthrough.
 *
 * The model is rebuilt per branch with a literal provider rather than passed
 * through, which is what narrows `AiProviderModel<RegisteredAiProvider>` to the
 * branch's own `AiProviderModel<"google">`. `providerModel` is carried
 * unchanged: it originates only in trusted server configuration or the
 * server-controlled catalog.
 */
export function generateWithRegisteredAiProvider(
  model: AiProviderModel<RegisteredAiProvider>,
  request: AiGenerationRequest,
  policy: AiCallPolicy<AiReasoningLevel>,
  deps: AiProviderCallDeps,
): Promise<AiProviderResult> {
  switch (model.provider) {
    case GOOGLE_AI_PROVIDER: {
      const adapter = AI_PROVIDER_ADAPTERS[GOOGLE_AI_PROVIDER];
      return adapter.generate(
        { provider: GOOGLE_AI_PROVIDER, providerModel: model.providerModel },
        request,
        narrowCallPolicy(adapter, GOOGLE_AI_PROVIDER, policy, deps),
        deps,
      );
    }
    case ANTHROPIC_AI_PROVIDER: {
      const adapter = AI_PROVIDER_ADAPTERS[ANTHROPIC_AI_PROVIDER];
      return adapter.generate(
        { provider: ANTHROPIC_AI_PROVIDER, providerModel: model.providerModel },
        request,
        narrowCallPolicy(adapter, ANTHROPIC_AI_PROVIDER, policy, deps),
        deps,
      );
    }
    case OPENAI_AI_PROVIDER: {
      const adapter = AI_PROVIDER_ADAPTERS[OPENAI_AI_PROVIDER];
      return adapter.generate(
        { provider: OPENAI_AI_PROVIDER, providerModel: model.providerModel },
        request,
        narrowCallPolicy(adapter, OPENAI_AI_PROVIDER, policy, deps),
        deps,
      );
    }
    default: {
      const unreachable: never = model.provider;
      return unreachable;
    }
  }
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
