// @vitest-environment node
//
// AI-MULTI-PROVIDER-001C (C41) — which server-side credential each registered
// provider reads.
//
// The hazard this suite exists for is concrete: with three registered adapters,
// a request routed to one provider must never read — and therefore never send —
// another provider's secret. Before 001C both operations read `GEMINI_API_KEY`
// unconditionally; had that survived registration, a request routed to
// Anthropic would have carried PaperLume's Gemini key in an `x-api-key` header
// addressed to api.anthropic.com.
//
// Every assertion runs against the shipped mapping with an injected environment
// reader, so no real secret is anywhere near this process.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AI_PROVIDER_CREDENTIAL_ENV_NAMES,
  aiProviderCredentialEnvName,
  resolveAiProviderCredential,
} from "../aiProviderCredentials.ts";
import { registeredAiProviders } from "../aiProviderRegistry.ts";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../aiProviderCredentials.ts", import.meta.url)),
  "utf8",
);

/** An environment in which every provider's secret is installed and distinct. */
const FULL_ENV: Record<string, string> = {
  GEMINI_API_KEY: "SENTINEL-GOOGLE-SECRET",
  ANTHROPIC_API_KEY: "SENTINEL-ANTHROPIC-SECRET",
  OPENAI_API_KEY: "SENTINEL-OPENAI-SECRET",
  AI_API_KEY: "SENTINEL-GENERIC-SECRET-THAT-MUST-NEVER-BE-READ",
};

/** A reader that records every name it was asked for. */
function recordingReader(env: Record<string, string | undefined>) {
  const reads: string[] = [];
  return {
    reads,
    read: (name: string) => {
      reads.push(name);
      return env[name];
    },
  };
}

describe("the provider → credential-name mapping", () => {
  it("binds each registered provider to its own named secret", () => {
    expect(aiProviderCredentialEnvName("google")).toBe("GEMINI_API_KEY");
    expect(aiProviderCredentialEnvName("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(aiProviderCredentialEnvName("openai")).toBe("OPENAI_API_KEY");
  });

  it("covers exactly the registered providers — no more, no fewer", () => {
    // A mapped type enforces this at compile time; this is the runtime half, so
    // CI (which does not typecheck supabase/functions/**) would still notice.
    expect(Object.keys(AI_PROVIDER_CREDENTIAL_ENV_NAMES).sort()).toEqual(
      [...registeredAiProviders()].sort(),
    );
  });

  it("never maps two providers to the same secret", () => {
    const names = Object.values(AI_PROVIDER_CREDENTIAL_ENV_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has no generic AI_API_KEY anywhere", () => {
    // A value every provider accepts is the same hazard with a tidier name, and
    // it would make "which provider has a credential installed?" unanswerable.
    expect(Object.values(AI_PROVIDER_CREDENTIAL_ENV_NAMES)).not.toContain("AI_API_KEY");
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/["'`]AI_API_KEY["'`]/);
  });

  it("is frozen, so no caller can re-point a provider at another secret", () => {
    expect(Object.isFrozen(AI_PROVIDER_CREDENTIAL_ENV_NAMES)).toBe(true);
  });

  it("holds names only — no credential value, and no environment access", () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/Deno\.env/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/\b(sk|AIza)[A-Za-z0-9_-]{8,}/);
  });
});

describe("resolveAiProviderCredential", () => {
  it.each([
    ["google", "GEMINI_API_KEY", "SENTINEL-GOOGLE-SECRET"],
    ["anthropic", "ANTHROPIC_API_KEY", "SENTINEL-ANTHROPIC-SECRET"],
    ["openai", "OPENAI_API_KEY", "SENTINEL-OPENAI-SECRET"],
  ] as const)("%s reads %s and ONLY %s", (provider, envName, value) => {
    const reader = recordingReader(FULL_ENV);
    const result = resolveAiProviderCredential(provider, reader.read);

    expect(result).toEqual({ ok: true, envName, apiKey: value });
    // Exactly one read, of exactly its own variable. Every other secret is in
    // the environment and was never asked for.
    expect(reader.reads).toEqual([envName]);
  });

  it("never hands one provider another provider's secret, whatever else is installed", () => {
    for (const provider of ["google", "anthropic", "openai"] as const) {
      const result = resolveAiProviderCredential(provider, (name) => FULL_ENV[name]);
      if (!result.ok) throw new Error("expected a credential");
      const others = Object.entries(FULL_ENV)
        .filter(([name]) => name !== aiProviderCredentialEnvName(provider))
        .map(([, value]) => value);
      expect(others).not.toContain(result.apiKey);
    }
  });

  it("fails safely when the SELECTED provider's credential is missing", () => {
    // Anthropic selected, only Google's secret installed. The Google secret is
    // right there — and must not be used as a substitute.
    const reader = recordingReader({ GEMINI_API_KEY: "SENTINEL-GOOGLE-SECRET" });
    const result = resolveAiProviderCredential("anthropic", reader.read);

    expect(result).toEqual({ ok: false, envName: "ANTHROPIC_API_KEY" });
    expect(reader.reads).toEqual(["ANTHROPIC_API_KEY"]);
    // The failure carries the NAME, which is diagnosable and not secret, and
    // no value of any kind.
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace only", "   \n\t"],
  ])("treats a %s value as missing", (_label, value) => {
    const result = resolveAiProviderCredential("openai", () => value as string | null | undefined);
    expect(result).toEqual({ ok: false, envName: "OPENAI_API_KEY" });
  });

  it("returns the value exactly as installed, with no trimming or rewriting", () => {
    const result = resolveAiProviderCredential("google", () => "  padded-but-present  ");
    expect(result).toEqual({ ok: true, envName: "GEMINI_API_KEY", apiKey: "  padded-but-present  " });
  });

  it("cannot be steered by anything a request could carry", () => {
    // The only inputs are a REGISTERED provider id — which comes from the
    // server-side model decision, never from a request body — and a reader the
    // Edge shell supplies. There is no parameter through which a client could
    // name a credential, so "use this key" is unexpressible, not merely guarded.
    expect(resolveAiProviderCredential.length).toBe(2);
  });
});
