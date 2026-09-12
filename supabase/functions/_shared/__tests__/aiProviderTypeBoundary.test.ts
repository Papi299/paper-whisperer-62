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
  AiGenerationRequest,
  AiProviderAdapter,
  AiProviderCallDeps,
  AiProviderModel,
} from "../aiProvider.ts";
import { getAiProviderAdapter, type RegisteredAiProvider } from "../aiProviderRegistry.ts";
import {
  buildGeminiGenerateContentUrl,
  GOOGLE_AI_PROVIDER_ADAPTER,
  type GoogleAiProviderModel,
} from "../googleAiProvider.ts";

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
  it("types the google lookup as exactly AiProviderAdapter<'google'>", () => {
    const google = getAiProviderAdapter("google");

    const lookupIsExact: Equal<typeof google, AiProviderAdapter<"google">> = true;
    const registeredIsGoogleOnly: Equal<RegisteredAiProvider, "google"> = true;
    const googleModelIsGoogleOnly: Equal<GoogleAiProviderModel, AiProviderModel<"google">> = true;

    expect([lookupIsExact, registeredIsGoogleOnly, googleModelIsGoogleOnly]).toEqual([
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

      // @ts-expect-error -- the Google adapter cannot be handed an OpenAI-provider model.
      void GOOGLE_AI_PROVIDER_ADAPTER.generate(otherProviderModel, request, deps);
      // @ts-expect-error -- nor can the adapter the registry returns for "google".
      void getAiProviderAdapter("google").generate(otherProviderModel, request, deps);
      // @ts-expect-error -- nor a model whose provider was never narrowed at all.
      void GOOGLE_AI_PROVIDER_ADAPTER.generate(unnarrowedModel, request, deps);
      // @ts-expect-error -- the Google URL helper is Google-only too.
      void buildGeminiGenerateContentUrl(otherProviderModel);
      // @ts-expect-error -- an unregistered provider has no adapter to look up.
      void getAiProviderAdapter("openai");
      // @ts-expect-error -- a Google adapter cannot be widened into one that accepts any provider.
      const widenedToAny: AiProviderAdapter<string> = GOOGLE_AI_PROVIDER_ADAPTER;
      // @ts-expect-error -- nor into one for a provider union it does not serve.
      const widenedToUnion: AiProviderAdapter<"google" | "openai"> = GOOGLE_AI_PROVIDER_ADAPTER;
      // @ts-expect-error -- and no provider-agnostic adapter type exists at all.
      type Unparameterized = AiProviderAdapter;

      // Positive controls: a Google model is accepted, directly and through the
      // registry, so the errors above are about the provider and nothing else.
      const googleModel: GoogleAiProviderModel = {
        provider: "google",
        providerModel: "hypothetical-model",
      };
      void GOOGLE_AI_PROVIDER_ADAPTER.generate(googleModel, request, deps);
      void getAiProviderAdapter("google").generate(googleModel, request, deps);
      void buildGeminiGenerateContentUrl(googleModel);

      return [widenedToAny, widenedToUnion];
    };

    expect(typeof neverCalled).toBe("function");
  });
});

describe("the signatures that carry the invariant (pinned for CI)", () => {
  // CI never type-checks `supabase/functions/**`, so without these a revert to
  // a provider-agnostic signature would keep every CI job green.
  it("binds generate's model to the adapter's own provider, as a property", () => {
    const contract = codeOf("../aiProvider.ts");
    expect(contract).toMatch(/export interface AiProviderAdapter<Provider extends string> \{/);
    expect(contract).toMatch(/readonly generate: \(\s*model: AiProviderModel<Provider>,/);
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
      /GOOGLE_AI_PROVIDER_ADAPTER: AiProviderAdapter<typeof GOOGLE_AI_PROVIDER> = \{/,
    );
  });

  it("keys the registry by provider and returns that provider's adapter, with no cast", () => {
    const registry = codeOf("../aiProviderRegistry.ts");
    expect(registry).toMatch(/\[Provider in RegisteredAiProvider\]: AiProviderAdapter<Provider>/);
    // The explicit type argument is load-bearing: it checks the object literal
    // itself against the mapped type, so an extra entry is an excess-property
    // error. An annotation on the const alone would let one through.
    expect(registry).toMatch(/Object\.freeze<AiProviderAdapterRegistry>\(\{/);
    expect(registry).toMatch(
      /getAiProviderAdapter<Provider extends RegisteredAiProvider>\(\s*provider: Provider,\s*\): AiProviderAdapter<Provider>/,
    );
    expect(registry).not.toMatch(/\bas\s+(?:unknown|AiProviderAdapter)\b/);
  });
});
