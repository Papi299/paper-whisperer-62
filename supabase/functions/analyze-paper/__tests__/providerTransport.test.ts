// @vitest-environment node
//
// Node, not jsdom, for two reasons: this suite reads a committed source file,
// and jsdom substitutes the global `URL` so that a relative reference resolves
// against the document base rather than `import.meta.url` (see the sibling Edge
// suites, which take the same pragma for the same family of reason).
//
// AI-PROVIDER-RESILIENCE-001A — analyze-paper's provider transport contract.
//
// analyze-paper is a single `Deno.serve` shell with remote (`https://esm.sh/…`)
// imports, so Vitest cannot import and execute it the way it executes
// `suggest-paper-organization/handler.ts`. Making it executable would mean
// extracting its whole request path — a redesign this task explicitly excludes.
//
// The transport itself, which is the part 001A actually changes, IS executed:
// it now lives in `_shared/geminiTransport.ts` and is covered end to end by
// `_shared/__tests__/geminiTransport.test.ts` with an injected fetch, an
// injected sleep and an injected signal factory. What remains to pin down here
// is that the shipped Edge Function is wired to that policy and to nothing else
// — no second copy of the retry loop, no 15-second ceiling, no change to the
// model or the request contract.
//
// Reading the committed source as a contract is an existing convention in this
// repository (the extension's manifest-permission and no-network boundary
// suites do the same). These assertions are about wiring, not about strings:
// each one fails if the behaviour it names is removed or duplicated.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyProviderError } from "../../_shared/providerError.ts";
import {
  GEMINI_PROVIDER_BASE_DELAY_MS,
  GEMINI_PROVIDER_MAX_RETRIES,
  GEMINI_PROVIDER_TIMEOUT_MS,
} from "../../_shared/geminiTransport.ts";

// Resolved from this file, not from the Vitest working directory.
const INDEX_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const SOURCE = readFileSync(INDEX_PATH, "utf8");

describe("analyze-paper is wired to the shared provider policy", () => {
  it("calls Gemini through the shared transport", () => {
    expect(SOURCE).toContain('from "../_shared/geminiTransport.ts"');
    expect(SOURCE).toContain("callGeminiWithRetry(");
  });

  it("keeps no second copy of the retry loop", () => {
    // The old private `fetchWithRetry` is gone; if it (or any local retry
    // scheduling) came back, the two functions could drift again.
    expect(SOURCE).not.toContain("fetchWithRetry");
    expect(SOURCE).not.toMatch(/AbortSignal\.timeout/);
    expect(SOURCE).not.toMatch(/Math\.pow\(2, attempt\)/);
  });

  it("no longer carries the 15-second ceiling that cut Production responses short", () => {
    expect(SOURCE).not.toContain("15_000");
    expect(SOURCE).not.toContain("15000");
  });

  it("inherits a 30-second attempt timeout and the existing bounded retry budget", () => {
    expect(GEMINI_PROVIDER_TIMEOUT_MS).toBe(30_000);
    expect(GEMINI_PROVIDER_MAX_RETRIES).toBe(2);
    expect(GEMINI_PROVIDER_BASE_DELAY_MS).toBe(2_000);
  });
});

describe("analyze-paper maps a transport failure the way it always did", () => {
  it("distinguishes a timeout from a generic network failure internally", () => {
    // §7: the kind is passed through rather than collapsed into "network", so a
    // future incident can tell "we stopped waiting" from "the connection died".
    expect(SOURCE).toContain("classifyProviderError({ kind: providerCall.kind })");
    expect(SOURCE).toContain('throw new Error("gemini_" + providerCall.kind)');
  });

  it("still resolves both of them to the same externally visible class", () => {
    // Nothing the user, the client, or the manager-only provider panel sees
    // changes as a result of the finer internal distinction.
    expect(classifyProviderError({ kind: "timeout" })).toBe("provider_unavailable");
    expect(classifyProviderError({ kind: "network" })).toBe("provider_unavailable");
  });

  it("still classifies a non-OK HTTP response by its status", () => {
    expect(SOURCE).toContain('classifyProviderError({ kind: "http", status: providerCall.status })');
    expect(classifyProviderError({ kind: "http", status: 429 })).toBe("provider_rate_limit");
    expect(classifyProviderError({ kind: "http", status: 503 })).toBe("provider_unavailable");
  });

  it("still treats an unusable 2xx body as malformed, without a retry", () => {
    // The body is read by this function, outside the transport, so a 200 whose
    // JSON is unusable cannot re-enter the retry loop.
    expect(SOURCE).toContain("await providerCall.response.json()");
    expect(SOURCE).toContain('classifyProviderError({ kind: "empty" })');
    expect(SOURCE).toContain('classifyProviderError({ kind: "parse" })');
  });
});

describe("analyze-paper quota semantics are untouched", () => {
  it("consumes exactly one unit, from one call site, before the provider call", () => {
    // One `rpc("consume_ai_quota", …)` invocation — the other mentions in the
    // file are a comment and an error log.
    expect(SOURCE.match(/rpc\(\s*\n?\s*"consume_ai_quota"/g)?.length).toBe(1);
    expect(SOURCE.indexOf('"consume_ai_quota"')).toBeLessThan(SOURCE.indexOf("callGeminiWithRetry("));
  });

  it("refunds best-effort on the provider-failure path", () => {
    expect(SOURCE).toContain("await safeRefundAiQuota(supabase, user.id)");
    // Once for the missing-key path, once for the provider-failure catch.
    expect(SOURCE.match(/safeRefundAiQuota\(supabase, user\.id\)/g)?.length).toBe(2);
  });

  it("does not refund per provider attempt — the retry budget is the transport's", () => {
    // The only refund call sites are the two above, both outside the transport.
    expect(SOURCE).not.toMatch(/safeRefundAiQuota[\s\S]{0,200}callGeminiWithRetry/);
  });

  it("keeps a provider failure a neutral 500, never a Paperlume 402", () => {
    expect(SOURCE).toContain("NEUTRAL_ANALYSIS_UNAVAILABLE_MESSAGE");
    expect(SOURCE).toContain('error: "analysis_unavailable"');
    // The single 402 in this file is the quota wall, and it sits above the
    // provider call.
    expect(SOURCE.match(/status: 402/g)?.length).toBe(1);
    expect(SOURCE.indexOf("status: 402")).toBeLessThan(SOURCE.indexOf("callGeminiWithRetry("));
  });
});

describe("001A changes transport only", () => {
  it("leaves model selection alone", () => {
    // Non-goal: no GEMINI_MODEL pin, no fallback list, no failover.
    expect(SOURCE).toContain('resolveGeminiModel(Deno.env.get("GEMINI_MODEL"))');
    expect(SOURCE).not.toContain("gemini-3");
    expect(SOURCE).not.toContain("gemini-flash-latest");
  });

  it("leaves the generation config alone", () => {
    // Non-goal: the Gemini 3.x sampling-parameter migration is a separate task.
    expect(SOURCE).toContain("temperature: 0.1");
    expect(SOURCE).toContain('responseMimeType: "application/json"');
  });
});
