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
  generateWithRegisteredAiProvider,
  getAiProviderAdapter,
  isRegisteredAiProvider,
  registeredAiProviders,
  resolveSystemDefaultAiModel,
} from "../aiProviderRegistry.ts";
import { ANTHROPIC_AI_PROVIDER_ADAPTER } from "../anthropicAiProvider.ts";
import { GOOGLE_AI_PROVIDER_ADAPTER } from "../googleAiProvider.ts";
import { OPENAI_AI_PROVIDER_ADAPTER } from "../openAiProvider.ts";
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
  it("is exactly google, anthropic and openai", () => {
    // AI-MULTI-PROVIDER-001C registered the two adapters 001B deliberately left
    // out. The set is asserted EXACTLY, not as a superset: an unreviewed fourth
    // provider appearing here is the single easiest way to widen what PaperLume
    // can speak to without anyone noticing.
    expect(registeredAiProviders()).toEqual(["google", "anthropic", "openai"]);
    expect(registeredAiProviders()).toHaveLength(3);
  });

  it("resolves each provider to its OWN adapter", () => {
    expect(getAiProviderAdapter("google")).toBe(GOOGLE_AI_PROVIDER_ADAPTER);
    expect(getAiProviderAdapter("anthropic")).toBe(ANTHROPIC_AI_PROVIDER_ADAPTER);
    expect(getAiProviderAdapter("openai")).toBe(OPENAI_AI_PROVIDER_ADAPTER);
  });

  it("keys every adapter under its own provider id", () => {
    // A mismatch would route one provider's requests through another's
    // protocol, which no type would catch.
    for (const provider of registeredAiProviders()) {
      expect(getAiProviderAdapter(provider).provider).toBe(provider);
    }
  });

  it.each(["google", "anthropic", "openai"])("accepts %s", (provider) => {
    expect(isRegisteredAiProvider(provider)).toBe(true);
  });

  it("gives every registered provider its own reasoning vocabulary", () => {
    // The key ↔ adapter invariant extended to reasoning: each entry declares
    // exactly the levels ITS protocol accepts, and no two are the same list.
    expect(getAiProviderAdapter("google").reasoningLevels).toEqual([
      "minimal", "low", "medium", "high",
    ]);
    expect(getAiProviderAdapter("anthropic").reasoningLevels).toEqual([
      "off", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(getAiProviderAdapter("openai").reasoningLevels).toEqual([
      "none", "low", "medium", "high", "xhigh", "max",
    ]);
  });
});

describe("providers PaperLume has no REGISTERED adapter for", () => {
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

  it("carries no endpoint or credential for any provider", () => {
    // The registry names providers; it never names how to reach one or what to
    // authenticate with. The provider→credential NAME mapping is a separate
    // reviewed module (`aiProviderCredentials.ts`) and the VALUE never leaves
    // the Edge environment.
    expect(REGISTRY_CODE).not.toMatch(/https?:\/\//);
    expect(REGISTRY_CODE).not.toMatch(/API_KEY/);
    expect(REGISTRY_CODE).not.toMatch(/x-api-key/i);
    expect(REGISTRY_CODE).not.toMatch(/Bearer/);
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


// ── The 001C registration gate ────────────────────────────────────────────

describe("registration is a protocol decision, not a route — AI-MULTI-PROVIDER-001C", () => {
  // 001B implemented two real provider protocols and deliberately did not
  // register them, because registering before PaperLume had its own reasoning
  // and output policy would have adopted each provider's current default as
  // PaperLume's product policy by omission. 001C decided that policy (C41), so
  // registration became correct — and these assertions are about what
  // registration does and does NOT mean.

  it("registers all three reviewed adapters, and nothing else", () => {
    expect(registeredAiProviders()).toEqual(["google", "anthropic", "openai"]);
    expect(getAiProviderAdapter("anthropic")).toBe(ANTHROPIC_AI_PROVIDER_ADAPTER);
    expect(getAiProviderAdapter("openai")).toBe(OPENAI_AI_PROVIDER_ADAPTER);
  });

  it("keys every adapter under its own provider id, for all three", () => {
    // A mismatch would route one provider's requests through another's
    // protocol — with the other's credential — and no type would catch it if
    // the registry object were built by hand.
    for (const provider of registeredAiProviders()) {
      expect(getAiProviderAdapter(provider).provider).toBe(provider);
    }
  });

  it("still hands back nothing for a provider it does not register", () => {
    // `getAiProviderAdapter` is total over REGISTERED providers by construction
    // and the type refuses anything else; this is the runtime half of that.
    //
    // Inherited property names are deliberately NOT probed here: a raw lookup
    // of `constructor` on any object literal yields `Object`, which is exactly
    // why the gate is `isRegisteredAiProvider` (hasOwnProperty) and why that
    // guard has its own test above. Nothing reaches this function without
    // passing through it first.
    for (const provider of ["azure", "google-vertex", "cohere", "anthropic-vertex"]) {
      expect(
        (getAiProviderAdapter as unknown as (p: string) => unknown)(provider),
      ).toBeUndefined();
    }
  });

  it("declares its adapter table from the three provider constants", () => {
    // Widening `RegisteredAiProvider` is the explicit act of registering a
    // provider, and `AI_PROVIDER_ADAPTERS` will not type-check until a real
    // adapter — with the right provider AND the right reasoning vocabulary — is
    // supplied for the new member.
    expect(REGISTRY_CODE).toMatch(/typeof GOOGLE_AI_PROVIDER/);
    expect(REGISTRY_CODE).toMatch(/typeof ANTHROPIC_AI_PROVIDER/);
    expect(REGISTRY_CODE).toMatch(/typeof OPENAI_AI_PROVIDER/);
    expect(REGISTRY_CODE).toMatch(/\[GOOGLE_AI_PROVIDER\]: GOOGLE_AI_PROVIDER_ADAPTER,/);
    expect(REGISTRY_CODE).toMatch(/\[ANTHROPIC_AI_PROVIDER\]: ANTHROPIC_AI_PROVIDER_ADAPTER,/);
    expect(REGISTRY_CODE).toMatch(/\[OPENAI_AI_PROVIDER\]: OPENAI_AI_PROVIDER_ADAPTER,/);
    // Exactly three entries in the frozen table — no fourth, no duplicate.
    const table = REGISTRY_CODE.slice(
      REGISTRY_CODE.indexOf("Object.freeze<AiProviderAdapterRegistry>({"),
    );
    const entries = table.slice(0, table.indexOf("});")).match(/_AI_PROVIDER_ADAPTER,/g);
    expect(entries).toHaveLength(3);
  });

  it("still holds no model string for any provider", () => {
    // Registration widened the PROTOCOL set and nothing else. The database
    // catalog remains the model allowlist (C33/C35/C39), and there is no
    // `anthropic/*` or `openai/*` row in it — so registering these two adds no
    // route to anything today.
    expect(REGISTRY_CODE).not.toMatch(/claude-sonnet/i);
    expect(REGISTRY_CODE).not.toMatch(/gpt-5/i);
    expect(REGISTRY_CODE).not.toMatch(/gemini-3/);
  });
});

// ── The provider-neutral dispatch ─────────────────────────────────────────

describe("generateWithRegisteredAiProvider", () => {
  const REQUEST = {
    systemInstruction: "SYS",
    userContent: "USER",
    responseFormat: "json",
    jsonSchema: { name: "n", schema: { type: "object" } },
  } as const;

  function deps(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
    return {
      apiKey: "KEY",
      label: "test",
      fetchImpl,
      sleep: async () => {},
      createTimeoutSignal: () => AbortSignal.timeout(60_000),
      logger: { warn: () => {} },
    };
  }

  const OK_BY_PROVIDER: Record<string, () => Response> = {
    google: () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }), {
        status: 200,
      }),
    anthropic: () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" }),
        { status: 200 },
      ),
    openai: () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
        }),
        { status: 200 },
      ),
  };

  it.each([
    ["google", "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent"],
    ["anthropic", "https://api.anthropic.com/v1/messages"],
    ["openai", "https://api.openai.com/v1/responses"],
  ])("routes %s to that provider's own endpoint", async (provider, url) => {
    const calls: string[] = [];
    const result = await generateWithRegisteredAiProvider(
      { provider: provider as "google" | "anthropic" | "openai", providerModel: "m" },
      REQUEST,
      { reasoning: { kind: "level", level: "medium" }, maxOutputTokens: 4096 },
      deps(async (requestUrl) => {
        calls.push(requestUrl);
        return OK_BY_PROVIDER[provider]();
      }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual([url]);
  });

  it("narrows a level the target provider cannot express to provider_default", async () => {
    // Policy resolution already refuses a level the CATALOG does not list, so
    // reaching this means the catalog and the provider disagree — corrupt
    // metadata, a hand-edited row, or a provider that withdrew a level. Sending
    // it would spend the user's quota unit on a 400.
    const warnings: string[] = [];
    let body = "";
    await generateWithRegisteredAiProvider(
      { provider: "google", providerModel: "m" },
      REQUEST,
      // `xhigh` is real and canonical, and Gemini has no such thing.
      { reasoning: { kind: "level", level: "xhigh" }, maxOutputTokens: 4096 },
      {
        ...deps(async (_url, init) => {
          body = String(init.body);
          return OK_BY_PROVIDER.google();
        }),
        logger: { warn: (m: string) => warnings.push(m) },
      },
    );
    expect(body).not.toContain("thinking");
    expect(body).not.toContain("xhigh");
    expect(warnings).toEqual([
      "test reasoning_level_rejected_by_adapter provider=google level=xhigh",
    ]);
  });

  it("passes an accepted level straight through, with no warning", async () => {
    const warnings: string[] = [];
    let body = "";
    await generateWithRegisteredAiProvider(
      { provider: "anthropic", providerModel: "m" },
      REQUEST,
      { reasoning: { kind: "level", level: "xhigh" }, maxOutputTokens: 8192 },
      {
        ...deps(async (_url, init) => {
          body = String(init.body);
          return OK_BY_PROVIDER.anthropic();
        }),
        logger: { warn: (m: string) => warnings.push(m) },
      },
    );
    expect(JSON.parse(body).output_config.effort).toBe("xhigh");
    expect(JSON.parse(body).max_tokens).toBe(8192);
    expect(warnings).toEqual([]);
  });

  it("carries the output ceiling to each provider that has a place for it", async () => {
    const bodies: Record<string, string> = {};
    for (const provider of ["google", "anthropic", "openai"] as const) {
      await generateWithRegisteredAiProvider(
        { provider, providerModel: "m" },
        REQUEST,
        { reasoning: { kind: "level", level: "medium" }, maxOutputTokens: 8192 },
        deps(async (_url, init) => {
          bodies[provider] = String(init.body);
          return OK_BY_PROVIDER[provider]();
        }),
      );
    }
    expect(JSON.parse(bodies.anthropic).max_tokens).toBe(8192);
    expect(JSON.parse(bodies.openai).max_output_tokens).toBe(8192);
    // Google deliberately gets none — see the Google adapter's request builder.
    expect(bodies.google).not.toContain("8192");
  });
});
