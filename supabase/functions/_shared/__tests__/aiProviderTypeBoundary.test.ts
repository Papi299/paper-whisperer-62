// @vitest-environment node
//
// Node rather than jsdom: this module runs in Deno and wants no DOM, and the
// last block reads committed source files (see the sibling Edge suites).
//
// AI-MULTI-PROVIDER-001A — an adapter is bound to its OWN provider at the type
// boundary (C39).
//
// `aiProviderRegistry.test.ts` proves at runtime that every adapter is keyed
// under its own provider id. This suite proves what a runtime test cannot see:
// that the types refuse to pair the Google adapter with a model resolved for
// any other provider. Before a second provider exists, that mismatch has to be
// a compile error, because at runtime it would be a Gemini request carrying
// another provider's model name.
//
// How each block is enforced:
//
//   * The two compile-time blocks are checked by `tsc` run directly over the
//     Edge code — `npm run typecheck` does not cover `supabase/functions/**`.
//     Each `@ts-expect-error` fails that check (TS2578) the moment the error it
//     expects stops occurring. Under Vitest they are inert: the negative calls
//     sit in a function that is never invoked, so no request is ever built.
//   * The last block pins, as source text, the signatures that carry the
//     invariant. That is the part CI enforces.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AiCallPolicy,
  AiGenerationRequest,
  AiProviderAdapter,
  AiProviderCallDeps,
  AiProviderModel,
  AiReasoningLevel,
} from "../aiProvider.ts";
import { getAiProviderAdapter, type RegisteredAiProvider } from "../aiProviderRegistry.ts";
import {
  buildGeminiGenerateContentUrl,
  GOOGLE_AI_PROVIDER_ADAPTER,
  type GoogleAiProviderModel,
  type GoogleReasoningLevel,
} from "../googleAiProvider.ts";
import {
  ANTHROPIC_AI_PROVIDER_ADAPTER,
  buildAnthropicRequestBody,
  type AnthropicAiProviderModel,
  type AnthropicReasoningLevel,
} from "../anthropicAiProvider.ts";
import {
  OPENAI_AI_PROVIDER_ADAPTER,
  buildOpenAiRequestBody,
  type OpenAiProviderModel,
  type OpenAiReasoningLevel,
} from "../openAiProvider.ts";

/** `true` only when A and B are the same type, not merely assignable one way. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * A committed source file with its comments removed: the pins below are about
 * signatures, and prose describing them must not be able to satisfy (or trip)
 * an assertion.
 */
function codeOf(relativePath: string): string {
  const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("provider identity survives the registry lookup (compile time)", () => {
  it("types the google lookup as exactly the Google adapter, levels included", () => {
    const google = getAiProviderAdapter("google");

    const lookupIsExact: Equal<
      typeof google,
      AiProviderAdapter<"google", GoogleReasoningLevel>
    > = true;
    const registeredIsTheThree: Equal<
      RegisteredAiProvider,
      "google" | "anthropic" | "openai"
    > = true;
    const googleModelIsGoogleOnly: Equal<GoogleAiProviderModel, AiProviderModel<"google">> = true;

    expect([lookupIsExact, registeredIsTheThree, googleModelIsGoogleOnly]).toEqual([
      true,
      true,
      true,
    ]);
    expect(google).toBe(GOOGLE_AI_PROVIDER_ADAPTER);
    expect(google.provider).toBe("google");
  });
});

describe("the Google adapter refuses another provider's model (compile time)", () => {
  it("rejects every mismatched pairing — checked by tsc, never executed", () => {
    // Declared, never called. Each line exists for the TypeScript checker: if
    // one of them ever stops being an error, the Edge typecheck fails on its
    // now-unused `@ts-expect-error`.
    const neverCalled = (request: AiGenerationRequest, deps: AiProviderCallDeps) => {
      const otherProviderModel: AiProviderModel<"openai"> = {
        provider: "openai",
        providerModel: "hypothetical-model",
      };
      const unnarrowedModel: AiProviderModel<string> = {
        provider: "google",
        providerModel: "hypothetical-model",
      };
      const googlePolicy: AiCallPolicy<GoogleReasoningLevel> = {
        reasoning: { kind: "level", level: "medium" },
        maxOutputTokens: 4096,
      };

      // @ts-expect-error -- the Google adapter cannot be handed an OpenAI-provider model.
      void GOOGLE_AI_PROVIDER_ADAPTER.generate(otherProviderModel, request, googlePolicy, deps);
      void getAiProviderAdapter("google").generate(
        // @ts-expect-error -- nor can the adapter the registry returns for "google".
        otherProviderModel,
        request,
        googlePolicy,
        deps,
      );
      // @ts-expect-error -- nor a model whose provider was never narrowed at all.
      void GOOGLE_AI_PROVIDER_ADAPTER.generate(unnarrowedModel, request, googlePolicy, deps);
      // @ts-expect-error -- the Google URL helper is Google-only too.
      void buildGeminiGenerateContentUrl(otherProviderModel);
      // @ts-expect-error -- a Google adapter cannot be widened into one that accepts any provider.
      const widenedToAny: AiProviderAdapter<string, AiReasoningLevel> = GOOGLE_AI_PROVIDER_ADAPTER;
      // @ts-expect-error -- nor into one for a provider union it does not serve.
      const widenedToUnion: AiProviderAdapter<"google" | "openai", GoogleReasoningLevel> =
        GOOGLE_AI_PROVIDER_ADAPTER;
      // @ts-expect-error -- and no provider-agnostic adapter type exists at all.
      type Unparameterized = AiProviderAdapter;

      // ── The reasoning half of the same boundary — AI-MULTI-PROVIDER-001C ──
      //
      // Each of these is a REAL canonical level that this provider does not
      // have. They are the mistakes worth making unexpressible: Gemini answers
      // `off`, `none`, `xhigh` and `max` with a 400, after the caller has
      // already spent a quota unit.
      const offForGoogle: AiCallPolicy<GoogleReasoningLevel> = {
        // @ts-expect-error -- `off` is Anthropic's disabled thinking, not a Gemini level.
        reasoning: { kind: "level", level: "off" },
        maxOutputTokens: 4096,
      };
      const noneForGoogle: AiCallPolicy<GoogleReasoningLevel> = {
        // @ts-expect-error -- `none` is OpenAI's zero effort, not a Gemini level.
        reasoning: { kind: "level", level: "none" },
        maxOutputTokens: 4096,
      };
      const xhighForGoogle: AiCallPolicy<GoogleReasoningLevel> = {
        // @ts-expect-error -- `xhigh` exists on the two paid providers only.
        reasoning: { kind: "level", level: "xhigh" },
        maxOutputTokens: 4096,
      };
      const maxForGoogle: AiCallPolicy<GoogleReasoningLevel> = {
        // @ts-expect-error -- and so does `max`.
        reasoning: { kind: "level", level: "max" },
        maxOutputTokens: 4096,
      };
      void GOOGLE_AI_PROVIDER_ADAPTER.generate(
        { provider: "google", providerModel: "m" },
        request,
        // @ts-expect-error -- an unnarrowed canonical policy is not a Google policy either.
        { reasoning: { kind: "level", level: "medium" as AiReasoningLevel }, maxOutputTokens: 1 },
        deps,
      );

      // Positive controls: a Google model is accepted, directly and through the
      // registry, so the errors above are about the provider and nothing else.
      const googleModel: GoogleAiProviderModel = {
        provider: "google",
        providerModel: "hypothetical-model",
      };
      void GOOGLE_AI_PROVIDER_ADAPTER.generate(googleModel, request, googlePolicy, deps);
      void getAiProviderAdapter("google").generate(googleModel, request, googlePolicy, deps);
      void buildGeminiGenerateContentUrl(googleModel);
      // And every level Gemini really does have type-checks.
      for (const level of ["minimal", "low", "medium", "high"] as const) {
        const ok: AiCallPolicy<GoogleReasoningLevel> = {
          reasoning: { kind: "level", level },
          maxOutputTokens: 4096,
        };
        void ok;
      }

      return [widenedToAny, widenedToUnion, offForGoogle, noneForGoogle, xhighForGoogle, maxForGoogle];
    };

    expect(typeof neverCalled).toBe("function");
  });
});

describe("all three adapters are bound to their own providers (compile time)", () => {
  it("types each adapter for exactly its own provider and its own levels", () => {
    const anthropicIsExact: Equal<
      typeof ANTHROPIC_AI_PROVIDER_ADAPTER,
      AiProviderAdapter<"anthropic", AnthropicReasoningLevel>
    > = true;
    const openAiIsExact: Equal<
      typeof OPENAI_AI_PROVIDER_ADAPTER,
      AiProviderAdapter<"openai", OpenAiReasoningLevel>
    > = true;
    const anthropicModelIsExact: Equal<AnthropicAiProviderModel, AiProviderModel<"anthropic">> =
      true;
    const openAiModelIsExact: Equal<OpenAiProviderModel, AiProviderModel<"openai">> = true;
    // AI-MULTI-PROVIDER-001C registered both.
    const allThreeRegistered: Equal<
      RegisteredAiProvider,
      "google" | "anthropic" | "openai"
    > = true;
    // The three reasoning vocabularies are genuinely different types. If two of
    // them ever unified, the cross-provider negative controls below would start
    // passing for the wrong reason.
    const googleIsNotAnthropic: Equal<GoogleReasoningLevel, AnthropicReasoningLevel> = false;
    const anthropicIsNotOpenAi: Equal<AnthropicReasoningLevel, OpenAiReasoningLevel> = false;

    expect([
      anthropicIsExact,
      openAiIsExact,
      anthropicModelIsExact,
      openAiModelIsExact,
      allThreeRegistered,
      googleIsNotAnthropic,
      anthropicIsNotOpenAi,
    ]).toEqual([true, true, true, true, true, false, false]);
  });

  it("rejects every cross-provider pairing — checked by tsc, never executed", () => {
    const neverCalled = (request: AiGenerationRequest, deps: AiProviderCallDeps) => {
      const googleModel: GoogleAiProviderModel = { provider: "google", providerModel: "m" };
      const anthropicModel: AnthropicAiProviderModel = {
        provider: "anthropic",
        providerModel: "m",
      };
      const openAiModel: OpenAiProviderModel = { provider: "openai", providerModel: "m" };
      const unnarrowedModel: AiProviderModel<string> = { provider: "anthropic", providerModel: "m" };
      const anthropicPolicy: AiCallPolicy<AnthropicReasoningLevel> = {
        reasoning: { kind: "level", level: "medium" },
        maxOutputTokens: 4096,
      };
      const openAiPolicy: AiCallPolicy<OpenAiReasoningLevel> = {
        reasoning: { kind: "level", level: "medium" },
        maxOutputTokens: 4096,
      };
      const googlePolicy: AiCallPolicy<GoogleReasoningLevel> = {
        reasoning: { kind: "level", level: "medium" },
        maxOutputTokens: 4096,
      };

      // @ts-expect-error -- the Anthropic adapter cannot be handed a Google model.
      void ANTHROPIC_AI_PROVIDER_ADAPTER.generate(googleModel, request, anthropicPolicy, deps);
      // @ts-expect-error -- nor an OpenAI model.
      void ANTHROPIC_AI_PROVIDER_ADAPTER.generate(openAiModel, request, anthropicPolicy, deps);
      // @ts-expect-error -- nor a model whose provider was never narrowed.
      void ANTHROPIC_AI_PROVIDER_ADAPTER.generate(unnarrowedModel, request, anthropicPolicy, deps);
      // @ts-expect-error -- the OpenAI adapter cannot be handed a Google model.
      void OPENAI_AI_PROVIDER_ADAPTER.generate(googleModel, request, openAiPolicy, deps);
      // @ts-expect-error -- nor an Anthropic model.
      void OPENAI_AI_PROVIDER_ADAPTER.generate(anthropicModel, request, openAiPolicy, deps);
      // @ts-expect-error -- nor a model whose provider was never narrowed.
      void OPENAI_AI_PROVIDER_ADAPTER.generate(unnarrowedModel, request, openAiPolicy, deps);
      // @ts-expect-error -- the Google adapter cannot be handed an Anthropic model.
      void GOOGLE_AI_PROVIDER_ADAPTER.generate(anthropicModel, request, googlePolicy, deps);
      // @ts-expect-error -- the Anthropic body builder is Anthropic-only.
      void buildAnthropicRequestBody(openAiModel, request, anthropicPolicy);
      // @ts-expect-error -- the OpenAI body builder is OpenAI-only.
      void buildOpenAiRequestBody(anthropicModel, request, openAiPolicy);
      // @ts-expect-error -- neither adapter widens into one that accepts any provider.
      const anthropicWidened: AiProviderAdapter<string, AiReasoningLevel> =
        ANTHROPIC_AI_PROVIDER_ADAPTER;
      // @ts-expect-error -- nor into one for a union it does not serve.
      const openAiWidened: AiProviderAdapter<"openai" | "google", OpenAiReasoningLevel> =
        OPENAI_AI_PROVIDER_ADAPTER;

      // ── Cross-provider REASONING, which is now the easier mistake ─────────
      //
      // Each provider spells "do not reason" differently and only two have
      // `xhigh`/`max`. A policy built for one provider must not satisfy
      // another's adapter, or a level would reach an API that rejects it.
      void ANTHROPIC_AI_PROVIDER_ADAPTER.generate(anthropicModel, request, {
        // @ts-expect-error -- `minimal` is Google's; Anthropic has no such effort.
        reasoning: { kind: "level", level: "minimal" },
        maxOutputTokens: 4096,
      }, deps);
      void ANTHROPIC_AI_PROVIDER_ADAPTER.generate(anthropicModel, request, {
        // @ts-expect-error -- `none` is OpenAI's word; Anthropic's is `off`.
        reasoning: { kind: "level", level: "none" },
        maxOutputTokens: 4096,
      }, deps);
      void OPENAI_AI_PROVIDER_ADAPTER.generate(openAiModel, request, {
        // @ts-expect-error -- `off` is Anthropic's word; OpenAI's is `none`.
        reasoning: { kind: "level", level: "off" },
        maxOutputTokens: 4096,
      }, deps);
      void OPENAI_AI_PROVIDER_ADAPTER.generate(openAiModel, request, {
        // @ts-expect-error -- `minimal` is not offered on gpt-5.6-terra.
        reasoning: { kind: "level", level: "minimal" },
        maxOutputTokens: 4096,
      }, deps);
      // @ts-expect-error -- an Anthropic policy is not an OpenAI policy, even at a shared level.
      const crossedPolicy: AiCallPolicy<OpenAiReasoningLevel> = anthropicPolicy as AiCallPolicy<
        AnthropicReasoningLevel
      >;

      // Positive controls: each adapter accepts its own provider's model and its
      // own levels, so the errors above are about identity and nothing else.
      void ANTHROPIC_AI_PROVIDER_ADAPTER.generate(anthropicModel, request, anthropicPolicy, deps);
      void OPENAI_AI_PROVIDER_ADAPTER.generate(openAiModel, request, openAiPolicy, deps);
      void buildAnthropicRequestBody(anthropicModel, request, anthropicPolicy);
      void buildOpenAiRequestBody(openAiModel, request, openAiPolicy);
      for (const level of ["off", "low", "medium", "high", "xhigh", "max"] as const) {
        const ok: AiCallPolicy<AnthropicReasoningLevel> = {
          reasoning: { kind: "level", level },
          maxOutputTokens: 4096,
        };
        void ok;
      }
      for (const level of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
        const ok: AiCallPolicy<OpenAiReasoningLevel> = {
          reasoning: { kind: "level", level },
          maxOutputTokens: 4096,
        };
        void ok;
      }
      // And the provider-default directive is valid for every provider, since
      // it names no level at all.
      void GOOGLE_AI_PROVIDER_ADAPTER.generate(googleModel, request, {
        reasoning: { kind: "provider_default" },
        maxOutputTokens: 4096,
      }, deps);

      return [anthropicWidened, openAiWidened, crossedPolicy];
    };

    expect(typeof neverCalled).toBe("function");
  });

  it("requires every generation request to carry the operation's schema", () => {
    const neverCalled = () => {
      // @ts-expect-error -- `jsonSchema` is required: an operation must state its output contract.
      const missingSchema: AiGenerationRequest = {
        systemInstruction: "s",
        userContent: "u",
        responseFormat: "json",
      };
      return missingSchema;
    };
    expect(typeof neverCalled).toBe("function");
  });
});

describe("the signatures that carry the invariant (pinned for CI)", () => {
  // CI never type-checks `supabase/functions/**`, so without these a revert to
  // a provider-agnostic signature would keep every CI job green.
  it("binds generate's model to the adapter's own provider, as a property", () => {
    const contract = codeOf("../aiProvider.ts");
    expect(contract).toMatch(
      /export interface AiProviderAdapter<Provider extends string, Level extends AiReasoningLevel> \{/,
    );
    expect(contract).toMatch(/readonly generate: \(\s*model: AiProviderModel<Provider>,/);
    // AI-MULTI-PROVIDER-001C: the reasoning half of the same invariant. `Level`
    // has no default, so a provider-agnostic policy cannot be handed to an
    // adapter, and the narrowing guard is part of the contract rather than a
    // convention each adapter opts into.
    expect(contract).toMatch(/policy: AiCallPolicy<Level>,/);
    expect(contract).toMatch(
      /readonly supportsReasoningLevel: \(level: AiReasoningLevel\) => level is Level;/,
    );
    expect(contract).toMatch(/readonly reasoningLevels: readonly Level\[\];/);
  });

  it("keeps every Google-only helper Google-only", () => {
    const adapter = codeOf("../googleAiProvider.ts");
    expect(adapter).toMatch(
      /export type GoogleAiProviderModel = AiProviderModel<typeof GOOGLE_AI_PROVIDER>;/,
    );
    expect(adapter).toMatch(
      /export function buildGeminiGenerateContentUrl\(model: GoogleAiProviderModel\)/,
    );
    expect(adapter).toMatch(/async function generate\(\s*model: GoogleAiProviderModel,/);
    expect(adapter).toMatch(
      /GOOGLE_AI_PROVIDER_ADAPTER: AiProviderAdapter<\s*typeof GOOGLE_AI_PROVIDER,\s*GoogleReasoningLevel\s*> = \{/,
    );
    // The Google adapter's own reasoning vocabulary — four values, and none of
    // the other providers'. `AiCallPolicy<GoogleReasoningLevel>` carrying `off`
    // does not compile.
    expect(adapter).toMatch(
      /export type GoogleReasoningLevel = "minimal" \| "low" \| "medium" \| "high";/,
    );
  });

  it("keeps the Anthropic and OpenAI adapters bound to their own providers", () => {
    const anthropic = codeOf("../anthropicAiProvider.ts");
    expect(anthropic).toMatch(
      /export type AnthropicAiProviderModel = AiProviderModel<typeof ANTHROPIC_AI_PROVIDER>;/,
    );
    expect(anthropic).toMatch(/async function generate\(\s*model: AnthropicAiProviderModel,/);
    expect(anthropic).toMatch(
      /ANTHROPIC_AI_PROVIDER_ADAPTER: AiProviderAdapter<\s*typeof ANTHROPIC_AI_PROVIDER,\s*AnthropicReasoningLevel\s*> = \{/,
    );
    expect(anthropic).toMatch(
      /export type AnthropicReasoningLevel = "off" \| "low" \| "medium" \| "high" \| "xhigh" \| "max";/,
    );
    const openai = codeOf("../openAiProvider.ts");
    expect(openai).toMatch(
      /export type OpenAiProviderModel = AiProviderModel<typeof OPENAI_AI_PROVIDER>;/,
    );
    expect(openai).toMatch(/async function generate\(\s*model: OpenAiProviderModel,/);
    expect(openai).toMatch(
      /OPENAI_AI_PROVIDER_ADAPTER: AiProviderAdapter<\s*typeof OPENAI_AI_PROVIDER,\s*OpenAiReasoningLevel\s*> = \{/,
    );
    expect(openai).toMatch(
      /export type OpenAiReasoningLevel = "none" \| "low" \| "medium" \| "high" \| "xhigh" \| "max";/,
    );
  });

  it("keeps jsonSchema a REQUIRED member of the generation request", () => {
    const contract = codeOf("../aiProvider.ts");
    expect(contract).toMatch(/readonly jsonSchema: AiJsonOutputSchema;/);
    expect(contract).not.toMatch(/readonly jsonSchema\?:/);
  });

  it("keys the registry by provider and returns that provider's adapter, with no cast", () => {
    const registry = codeOf("../aiProviderRegistry.ts");
    expect(registry).toMatch(
      /\[Provider in RegisteredAiProvider\]: AiProviderAdapter<\s*Provider,\s*RegisteredAiProviderReasoningLevel\[Provider\]\s*>/,
    );
    // The explicit type argument is load-bearing: it checks the object literal
    // itself against the mapped type, so an extra entry is an excess-property
    // error. An annotation on the const alone would let one through.
    expect(registry).toMatch(/Object\.freeze<AiProviderAdapterRegistry>\(\{/);
    expect(registry).toMatch(
      /getAiProviderAdapter<Provider extends RegisteredAiProvider>\(\s*provider: Provider,\s*\): AiProviderAdapter<Provider, RegisteredAiProviderReasoningLevel\[Provider\]>/,
    );
    expect(registry).not.toMatch(/\bas\s+(?:unknown|AiProviderAdapter)\b/);
    // The dispatch's default branch assigns to `never`, so registering a fourth
    // provider without teaching it about that provider is a compile error
    // rather than a silent fallthrough to nothing.
    expect(registry).toMatch(/const unreachable: never = model\.provider;/);
  });
});
