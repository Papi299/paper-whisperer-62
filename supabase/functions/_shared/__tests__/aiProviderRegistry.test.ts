// @vitest-environment node
//
// Node rather than jsdom: this module runs in Deno and wants no DOM, and one
// assertion reads a committed source file (see the sibling Edge suites).
//
// AI-MULTI-PROVIDER-001A — which provider PROTOCOLS PaperLume can speak.
//
// The registry is the answer to "do we have a reviewed adapter for provider X?"
// and to nothing else. So this suite is mostly about what it REFUSES: a
// provider nobody implemented, a provider whose name is an inherited JavaScript
// property, and any suggestion that a catalog row alone is sufficient to make
// PaperLume send a request somewhere.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getAiProviderAdapter,
  isRegisteredAiProvider,
  registeredAiProviders,
  resolveSystemDefaultAiModel,
} from "../aiProviderRegistry.ts";
import { GOOGLE_AI_PROVIDER_ADAPTER } from "../googleAiProvider.ts";
import { DEFAULT_GEMINI_MODEL, resolveGeminiModel } from "../geminiModel.ts";

const REGISTRY_SOURCE = readFileSync(
  fileURLToPath(new URL("../aiProviderRegistry.ts", import.meta.url)),
  "utf8",
);

/**
 * The registry with its comments removed.
 *
 * The assertions below are about what the module can DO, and prose describing
 * what it deliberately does not do ("no placeholder that throws …") must not
 * read as evidence that it does. Comments are not an authorization surface.
 */
const REGISTRY_CODE = REGISTRY_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

describe("the registered provider set", () => {
  it("is exactly google", () => {
    expect(registeredAiProviders()).toEqual(["google"]);
  });

  it("resolves google to the Google adapter", () => {
    expect(getAiProviderAdapter("google")).toBe(GOOGLE_AI_PROVIDER_ADAPTER);
  });

  it("keys every adapter under its own provider id", () => {
    // A mismatch would route one provider's requests through another's
    // protocol, which no type would catch.
    for (const provider of registeredAiProviders()) {
      expect(getAiProviderAdapter(provider).provider).toBe(provider);
    }
  });

  it("accepts google", () => {
    expect(isRegisteredAiProvider("google")).toBe(true);
  });
});

describe("providers PaperLume has no REGISTERED adapter for", () => {
  // Anthropic and OpenAI. Since AI-MULTI-PROVIDER-001B both have a real,
  // reviewed adapter module in this repository — and NEITHER is registered, so
  // neither is reachable. That distinction is the whole point of 001B and is
  // asserted directly in the dedicated block at the end of this file.
  it.each(["anthropic", "openai"])("refuses the unregistered provider %s", (provider) => {
    expect(isRegisteredAiProvider(provider)).toBe(false);
    expect(registeredAiProviders()).not.toContain(provider);
  });

  it.each([
    "azure",
    "google-vertex",
    "GOOGLE",
    "Google",
    " google",
    "google ",
    "googl",
    "x",
    "",
  ])("refuses the unknown or near-miss provider %j", (provider) => {
    expect(isRegisteredAiProvider(provider)).toBe(false);
  });

  // `provider` arrives from a database column, so the guard must not be
  // fooled by a value that happens to name an inherited property of an object
  // literal. `"constructor" in ADAPTERS` is true; hasOwnProperty is not.
  it.each(["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"])(
    "refuses the inherited property name %j",
    (provider) => {
      expect(isRegisteredAiProvider(provider)).toBe(false);
    },
  );

  it.each([null, undefined, 7, true, {}, [], { provider: "google" }])(
    "refuses the non-string %j",
    (provider) => {
      expect(isRegisteredAiProvider(provider)).toBe(false);
    },
  );
});

describe("the registry is not a second model allowlist", () => {
  it("names no model string at all", () => {
    // The database catalog is the model allowlist (C33/C35). A model name here
    // would be a second authorization surface that could disagree with it.
    expect(REGISTRY_CODE).not.toMatch(/gemini-3/);
    expect(REGISTRY_CODE).not.toMatch(/gemini-flash-latest/);
    expect(REGISTRY_CODE).not.toMatch(/\bclaude\b/i);
    expect(REGISTRY_CODE).not.toMatch(/\bgpt-/i);
  });

  it("carries no endpoint, credential or secret name for any provider", () => {
    expect(REGISTRY_CODE).not.toMatch(/https?:\/\//);
    expect(REGISTRY_CODE).not.toMatch(/API_KEY/);
    expect(REGISTRY_CODE).not.toMatch(/ANTHROPIC|OPENAI/);
  });

  it("contains no placeholder adapter waiting to be completed", () => {
    // An unimplemented provider is ABSENT, not stubbed: a stub is something a
    // later edit can finish by accident.
    expect(REGISTRY_CODE).not.toMatch(/not[_ ]implemented/i);
    expect(REGISTRY_CODE).not.toMatch(/\bTODO\b/);
    expect(REGISTRY_CODE).not.toMatch(/\bthrow\b/);
  });
});

describe("the system default", () => {
  it("is Google on the configured GEMINI_MODEL", () => {
    expect(resolveSystemDefaultAiModel("gemini-3.6-flash")).toEqual({
      provider: "google",
      providerModel: "gemini-3.6-flash",
    });
  });

  it("falls back to the historical default model when GEMINI_MODEL is unset", () => {
    expect(resolveSystemDefaultAiModel(undefined)).toEqual({
      provider: "google",
      providerModel: DEFAULT_GEMINI_MODEL,
    });
  });

  it.each([undefined, null, "", "   ", "gemini-3.5-flash", "  gemini-x  "])(
    "resolves the model exactly as the shared resolver does (%j)",
    (envValue) => {
      // The property that matters is that this cannot drift from what
      // `get-gemini-provider-quota` reports as the configured default.
      expect(resolveSystemDefaultAiModel(envValue).providerModel).toBe(
        resolveGeminiModel(envValue),
      );
    },
  );

  it("always names a provider that actually has an adapter", () => {
    // The safe fallback for every routing failure has to be callable, or
    // failing closed on the capability would fail the feature too.
    const systemDefault = resolveSystemDefaultAiModel("gemini-3.5-flash");
    expect(isRegisteredAiProvider(systemDefault.provider)).toBe(true);
    expect(getAiProviderAdapter(systemDefault.provider).provider).toBe(systemDefault.provider);
  });
});


// ── The 001B registration gate ────────────────────────────────────────────

describe("an implemented adapter is NOT a registered adapter — AI-MULTI-PROVIDER-001B", () => {
  // The single most important acceptance criterion of 001B. Two real provider
  // protocols now exist in `supabase/functions/_shared/`, fully tested, and
  // PaperLume must still be unable to send a single request to either. The
  // registry is the activation boundary; writing an adapter does not cross it.

  it("registers exactly google, and nothing 001B added", () => {
    expect(registeredAiProviders()).toEqual(["google"]);
    expect(registeredAiProviders()).toHaveLength(1);
  });

  it("has real adapters for anthropic and openai that are NOT in the registry", async () => {
    // Imported directly, which is exactly how they are tested: an adapter never
    // needs a registry entry to be exercised. If it ever seemed to, the design
    // would be wrong.
    const { ANTHROPIC_AI_PROVIDER_ADAPTER } = await import("../anthropicAiProvider.ts");
    const { OPENAI_AI_PROVIDER_ADAPTER } = await import("../openAiProvider.ts");

    // They exist, and they are complete.
    expect(ANTHROPIC_AI_PROVIDER_ADAPTER.provider).toBe("anthropic");
    expect(OPENAI_AI_PROVIDER_ADAPTER.provider).toBe("openai");
    expect(typeof ANTHROPIC_AI_PROVIDER_ADAPTER.generate).toBe("function");
    expect(typeof OPENAI_AI_PROVIDER_ADAPTER.generate).toBe("function");

    // And they are unreachable.
    expect(isRegisteredAiProvider("anthropic")).toBe(false);
    expect(isRegisteredAiProvider("openai")).toBe(false);
    expect(registeredAiProviders()).not.toContain("anthropic");
    expect(registeredAiProviders()).not.toContain("openai");
  });

  it("never hands back an adapter for an unregistered provider at runtime", () => {
    // `getAiProviderAdapter` is total over REGISTERED providers by construction
    // and the type refuses anything else; this is the runtime half of that.
    for (const provider of ["anthropic", "openai"]) {
      expect(
        (getAiProviderAdapter as unknown as (p: string) => unknown)(provider),
      ).toBeUndefined();
    }
  });

  it("does not import either new adapter module", () => {
    // A registry that merely IMPORTED them would be one edit away from
    // registering them, and the import itself would be the misleading signal.
    expect(REGISTRY_CODE).not.toMatch(/anthropicAiProvider/);
    expect(REGISTRY_CODE).not.toMatch(/openAiProvider/i);
    expect(REGISTRY_CODE).not.toMatch(/ANTHROPIC_AI_PROVIDER/);
    expect(REGISTRY_CODE).not.toMatch(/OPENAI_AI_PROVIDER/);
  });

  it("declares its adapter table from the Google constant alone", () => {
    // `RegisteredAiProvider` is `typeof GOOGLE_AI_PROVIDER`. Widening it is the
    // explicit act of registering a provider, and `AI_PROVIDER_ADAPTERS` will
    // not type-check until a real adapter is supplied for the new member.
    expect(REGISTRY_CODE).toMatch(
      /export type RegisteredAiProvider = typeof GOOGLE_AI_PROVIDER;/,
    );
    expect(REGISTRY_CODE).toMatch(/\[GOOGLE_AI_PROVIDER\]: GOOGLE_AI_PROVIDER_ADAPTER,/);
    // Exactly one entry in the frozen table.
    const table = REGISTRY_CODE.slice(
      REGISTRY_CODE.indexOf("Object.freeze<AiProviderAdapterRegistry>({"),
    );
    const entries = table.slice(0, table.indexOf("});")).match(/GOOGLE_AI_PROVIDER_ADAPTER/g);
    expect(entries).toHaveLength(1);
  });
});
