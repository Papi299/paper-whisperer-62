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

describe("providers PaperLume has no adapter for", () => {
  // The two providers the owner intends to add LATER. 001A must not be able to
  // route to either, and these are the assertions that would fail the moment a
  // half-finished adapter or a placeholder appeared.
  it.each(["anthropic", "openai"])("refuses the unimplemented provider %s", (provider) => {
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
