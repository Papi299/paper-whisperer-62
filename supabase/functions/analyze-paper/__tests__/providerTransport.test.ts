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
const PROMPT_SOURCE = readFileSync(
  fileURLToPath(new URL("../prompt.ts", import.meta.url)),
  "utf8",
);
const ADAPTER_SOURCE = readFileSync(
  fileURLToPath(new URL("../../_shared/googleAiProvider.ts", import.meta.url)),
  "utf8",
);

describe("analyze-paper is wired to the shared provider policy", () => {
  it("calls Gemini through the registered adapter, which calls the shared transport", () => {
    // AI-MULTI-PROVIDER-001A put the Google adapter between this function and
    // the transport. The policy is unchanged and still shared: the adapter
    // calls `callGeminiWithRetry` (pinned executably in
    // `_shared/__tests__/googleAiProvider.test.ts`), and this function calls
    // the adapter it was handed for the resolved provider.
    expect(SOURCE).toContain('from "../_shared/aiProviderRegistry.ts"');
    // AI-MULTI-PROVIDER-001C: the lookup-then-call pair became one shared
    // dispatch, so both generation operations reach a provider the same way and
    // the per-provider narrowing is reviewed in one place.
    expect(SOURCE).toContain("generateWithRegisteredAiProvider(");
    expect(SOURCE.match(/generateWithRegisteredAiProvider\(/g)?.length).toBe(1);
    expect(ADAPTER_SOURCE).toContain('from "./geminiTransport.ts"');
    expect(ADAPTER_SOURCE).toContain("callGeminiWithRetry(");
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

  it("TEMPORARY: inherits the 90-second single-attempt diagnostic policy", () => {
    // AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A. The established policy this
    // function inherits is 30_000 ms with 2 retries, to be restored when the
    // bounded Production experiment ends. What this assertion really protects
    // is that analyze-paper takes WHATEVER the shared policy is rather than
    // carrying its own — so it moves with the constant, in both directions.
    expect(GEMINI_PROVIDER_TIMEOUT_MS).toBe(90_000);
    expect(GEMINI_PROVIDER_MAX_RETRIES).toBe(0);
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
    // The body is read by the adapter, outside the transport, so a 200 whose
    // JSON is unusable still cannot re-enter the retry loop. The two 2xx
    // outcomes keep the classifications this function has always given them:
    //
    //   * a well-formed envelope with no text → `empty` → malformed_response;
    //   * a body that is not JSON at all → the historical catch-all →
    //     provider_unavailable. (suggest-paper-organization calls that second
    //     case malformed_response; the two have always differed here, and
    //     AI-MULTI-PROVIDER-001A deliberately preserves both rather than
    //     silently aligning them.)
    expect(SOURCE).toContain('classifyProviderError({ kind: "empty" })');
    expect(SOURCE).toContain('classifyProviderError({ kind: "parse" })');
    expect(SOURCE).toContain('providerCall.kind === "unreadable_response"');
    expect(SOURCE).toContain('classifyProviderError({ kind: "network" })');
    expect(classifyProviderError({ kind: "empty" })).toBe("malformed_response");
    expect(classifyProviderError({ kind: "parse" })).toBe("malformed_response");
    expect(classifyProviderError({ kind: "network" })).toBe("provider_unavailable");
  });
});

describe("analyze-paper names the 001B failure kind explicitly", () => {
  // AI-MULTI-PROVIDER-001B added `incomplete_response` to the provider-neutral
  // contract for the two UNREGISTERED adapters. Google cannot produce it, so
  // this branch is unreachable today — which is exactly why it is pinned here:
  // the tail below the branch treats every remaining kind as `empty`, and a new
  // kind falling into it would report a truncated generation as "the model
  // returned nothing".
  it("handles incomplete_response before the empty tail, classified malformed", () => {
    const branch = SOURCE.indexOf('providerCall.kind === "incomplete_response"');
    const branchThrow = SOURCE.indexOf('throw new Error("provider_incomplete_response")');
    const emptyTail = SOURCE.indexOf('throw new Error("gemini_empty")');
    expect(branch).toBeGreaterThan(-1);
    expect(branchThrow).toBeGreaterThan(branch);
    expect(branchThrow).toBeLessThan(emptyTail);
    expect(SOURCE.slice(branch, branchThrow)).toContain('classifyProviderError({ kind: "parse" })');
    expect(classifyProviderError({ kind: "parse" })).toBe("malformed_response");
  });

  it("does not label it a Gemini failure — Google cannot produce it", () => {
    expect(SOURCE).not.toContain("gemini_incomplete");
  });

  it("still makes exactly one provider call per request", () => {
    expect(SOURCE.match(/generateWithRegisteredAiProvider\(/g)?.length).toBe(1);
  });
});

describe("analyze-paper quota semantics are untouched", () => {
  it("consumes exactly one unit, from one call site, before the provider call", () => {
    // One `rpc("consume_ai_quota", …)` invocation — the other mentions in the
    // file are a comment and an error log.
    expect(SOURCE.match(/rpc\(\s*\n?\s*"consume_ai_quota"/g)?.length).toBe(1);
    expect(SOURCE.indexOf('"consume_ai_quota"')).toBeLessThan(
      SOURCE.indexOf("generateWithRegisteredAiProvider("),
    );
  });

  it("refunds best-effort on the provider-failure path", () => {
    expect(SOURCE).toContain("await safeRefundAiQuota(supabase, user.id)");
    // Once for the missing-key path, once for the provider-failure catch.
    expect(SOURCE.match(/safeRefundAiQuota\(supabase, user\.id\)/g)?.length).toBe(2);
  });

  it("does not refund per provider attempt — the retry budget is the transport's", () => {
    // The only refund call sites are the two above, both outside the transport.
    expect(SOURCE).not.toMatch(/safeRefundAiQuota[\s\S]{0,200}providerAdapter\.generate/);
  });

  it("keeps a provider failure a neutral 500, never a Paperlume 402", () => {
    expect(SOURCE).toContain("NEUTRAL_ANALYSIS_UNAVAILABLE_MESSAGE");
    expect(SOURCE).toContain('error: "analysis_unavailable"');
    // The single 402 in this file is the quota wall, and it sits above the
    // provider call.
    expect(SOURCE.match(/status: 402/g)?.length).toBe(1);
    expect(SOURCE.indexOf("status: 402")).toBeLessThan(
      SOURCE.indexOf("generateWithRegisteredAiProvider("),
    );
  });
});

describe("001A changes transport only", () => {
  it("keeps the system default coming from GEMINI_MODEL, with no literal of its own", () => {
    // Still 001A's non-goal: this function pins no model, keeps no fallback
    // list and does no failover. AI-MODEL-SELECTION-001B later added per-user
    // routing on top — GEMINI_MODEL remains the system default and the safe
    // fallback, and the routing itself lives in the shared module covered by
    // `modelRouting.test.ts` and `_shared/__tests__/aiModelSelection.test.ts`.
    expect(SOURCE).toContain('resolveSystemDefaultAiModel(Deno.env.get("GEMINI_MODEL"))');
    expect(SOURCE).not.toContain("gemini-3");
    expect(SOURCE).not.toContain("gemini-flash-latest");
  });

  it("keeps JSON response mode and sets no sampling override", () => {
    // AI-PROVIDER-REQUEST-CONTRACT-001A superseded 001A's deferral here: the
    // explicit sampling override is gone, so the request now inherits the
    // provider/model defaults. JSON response mode is NOT a sampling knob — the
    // parser depends on it, so it stays pinned.
    // Since AI-MULTI-PROVIDER-001A the mode is stated provider-neutrally by the
    // operation (`responseFormat: "json"`) and translated to Gemini's
    // `responseMimeType` by the adapter. Both halves are asserted, so the mode
    // cannot be lost in the hand-off.
    expect(PROMPT_SOURCE).toContain('responseFormat: "json"');
    expect(ADAPTER_SOURCE).toContain('json: "application/json"');
    // Any explicit temperature, at any value, on either spelling — in the
    // operation and in the adapter that now builds the body.
    expect(SOURCE).not.toMatch(/\btemperature\s*:/);
    expect(ADAPTER_SOURCE).not.toMatch(/\btemperature\s*:/);
    // And no sampling parameter smuggled in as a replacement.
    expect(SOURCE).not.toMatch(/\b(topP|topK|top_p|top_k)\s*:/);
    expect(ADAPTER_SOURCE).not.toMatch(/\b(topP|topK|top_p|top_k)\s*:/);
  });
});
