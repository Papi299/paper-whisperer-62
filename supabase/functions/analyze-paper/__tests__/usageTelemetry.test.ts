// @vitest-environment node
//
// Node, not jsdom: this suite reads a committed source file and drives the real
// Google adapter, which needs the platform `Response` and `AbortSignal`.
//
// AI-MULTI-PROVIDER-001D — analyze-paper's provider-usage telemetry.
//
// Same split as `modelRouting.test.ts`, for the same reason: `index.ts` is a
// `Deno.serve` shell with remote imports that Vitest cannot run.
//
//   * The DECISION is executed. Everything that decides what is recorded lives in
//     `_shared/aiUsageTelemetry.ts`, and this suite drives it with analyze's own
//     inputs — its operation name, a real resolved selection and reasoning
//     decision, the real Google adapter behind an injected fetch, and analyze's
//     real prompt builder — through to the exact row that would be INSERTed.
//   * The WIRING is read: the shipped function records through that shared
//     recorder, once, only after a provider call, with the authoritative
//     identity, and without letting telemetry touch its outcome.
//
// No provider and no database is contacted.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GOOGLE_AI_PROVIDER_ADAPTER } from "../../_shared/googleAiProvider.ts";
import {
  AI_PROVIDER_USAGE_EVENTS_TABLE,
  recordAiProviderUsage,
  type AiUsageEventInsertClient,
} from "../../_shared/aiUsageTelemetry.ts";
import type { AiModelSelection } from "../../_shared/aiModelSelection.ts";
import type { AiReasoningPolicyDecision } from "../../_shared/aiReasoningPolicy.ts";
import type { AiProviderResult } from "../../_shared/aiProvider.ts";
import { buildAnalyzeGenerationRequest } from "../prompt.ts";

const SOURCE = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
/** The shipped source without comments, so prose cannot satisfy an assertion. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

const USER_ID = "11111111-2222-4333-8444-555555555555";
const TITLE = "SENTINEL-PAPER-TITLE";
const ABSTRACT = "SENTINEL-PAPER-ABSTRACT about a randomized trial.";
const NOW = new Date("2026-10-01T12:00:00Z");

const SELECTION: AiModelSelection = {
  provider: "google",
  providerModel: "gemini-3.6-flash",
  source: "user_preference",
  fallbackReason: null,
  reasoningPreference: null,
};
const REASONING: AiReasoningPolicyDecision = {
  policy: { reasoning: { kind: "level", level: "minimal" }, maxOutputTokens: 4096 },
  source: "automatic",
  reason: null,
};

async function callGoogle(outcome: Response | Error): Promise<AiProviderResult> {
  return GOOGLE_AI_PROVIDER_ADAPTER.generate(
    { provider: "google", providerModel: SELECTION.providerModel },
    buildAnalyzeGenerationRequest(TITLE, ABSTRACT),
    { reasoning: { kind: "level", level: "minimal" }, maxOutputTokens: 4096 },
    {
      apiKey: "SENTINEL-GEMINI-KEY",
      label: "analyze-paper",
      fetchImpl: async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome.clone();
      },
      sleep: async () => undefined,
      createTimeoutSignal: () => new AbortController().signal,
    },
  );
}

function harness(write: "ok" | "rejected" = "ok") {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const client: AiUsageEventInsertClient = {
    from: (table) => ({
      insert: async (row) => {
        inserts.push({ table, row: { ...row } });
        return write === "ok"
          ? { error: null }
          : { error: { code: "23514", message: `Failing row contains (${USER_ID}, …)` } };
      },
    }),
  };
  const deps = {
    label: "analyze-paper",
    logger: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) },
    createClient: () => client,
    now: () => NOW,
  };
  return { inserts, logs, errors, deps };
}

const geminiOk = (text: string, usageMetadata?: Record<string, number>) =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], ...(usageMetadata ? { usageMetadata } : {}) }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const USAGE = {
  promptTokenCount: 1200,
  cachedContentTokenCount: 300,
  candidatesTokenCount: 150,
  thoughtsTokenCount: 40,
  totalTokenCount: 1390,
};

describe("analyze-paper records what the provider reported, with analyze's own inputs", () => {
  it("records a success with the right operation, provider, model, policy, usage and estimate", async () => {
    const call = await callGoogle(geminiOk('{"tldr":"t","studyType":"s","statisticalMethods":"m"}', USAGE));
    const h = harness();
    const outcome = await recordAiProviderUsage(
      { userId: USER_ID, operation: "analyze", selection: SELECTION, reasoning: REASONING, call, operationOutcome: "succeeded" },
      h.deps,
    );
    expect(outcome).toBe("recorded");
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].table).toBe(AI_PROVIDER_USAGE_EVENTS_TABLE);
    expect(h.inserts[0].row).toMatchObject({
      user_id: USER_ID,
      operation: "analyze",
      provider: "google",
      provider_model: "gemini-3.6-flash",
      model_selection_source: "user_preference",
      reasoning_source: "automatic",
      resolved_reasoning_level: "minimal",
      provider_outcome: "completed",
      provider_attempts: 1,
      operation_outcome: "succeeded",
      input_tokens: 1200,
      cached_input_tokens: 300,
      cache_write_input_tokens: null,
      output_tokens: 190,
      reasoning_output_tokens: 40,
      provider_total_tokens: 1390,
      cost_status: "estimated",
      // 900 x 0.75 + 300 x 0.075 + 190 x 3.75, per million.
      list_price_estimate_usd: "0.001410000000000",
      price_record_id: "google/gemini-3.6-flash@2026-09-13",
    });
  });

  it("records the provider's usage even when analyze could not use the answer", async () => {
    // Case E: the provider completed and was paid for; PaperLume's parser
    // rejected the text. The event is a failure for the user and still carries
    // the provider's work.
    const call = await callGoogle(geminiOk("no json here at all", USAGE));
    expect(call.ok).toBe(true);
    const h = harness();
    await recordAiProviderUsage(
      { userId: USER_ID, operation: "analyze", selection: SELECTION, reasoning: REASONING, call, operationOutcome: "failed" },
      h.deps,
    );
    expect(h.inserts[0].row).toMatchObject({
      provider_outcome: "completed",
      operation_outcome: "failed",
      input_tokens: 1200,
      cost_status: "estimated",
    });
  });

  it("records a timeout as unknown work — no tokens and no amount, never zero", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const call = await callGoogle(timeout);
    const h = harness();
    await recordAiProviderUsage(
      { userId: USER_ID, operation: "analyze", selection: SELECTION, reasoning: REASONING, call, operationOutcome: "failed" },
      h.deps,
    );
    expect(h.inserts[0].row).toMatchObject({
      provider_outcome: "timeout",
      usage_status: "absent",
      input_tokens: null,
      output_tokens: null,
      cost_status: "usage_unavailable",
      list_price_estimate_usd: null,
    });
  });

  it("puts no paper content, prompt, key or answer in the row or the log", async () => {
    const call = await callGoogle(geminiOk("SENTINEL-GENERATED-ANSWER", USAGE));
    const h = harness();
    await recordAiProviderUsage(
      { userId: USER_ID, operation: "analyze", selection: SELECTION, reasoning: REASONING, call, operationOutcome: "failed" },
      h.deps,
    );
    const persisted = JSON.stringify(h.inserts);
    const logged = [...h.logs, ...h.errors].join("\n");
    for (const sentinel of ["SENTINEL-PAPER-TITLE", "SENTINEL-PAPER-ABSTRACT", "SENTINEL-GEMINI-KEY", "SENTINEL-GENERATED-ANSWER"]) {
      expect(persisted).not.toContain(sentinel);
      expect(logged).not.toContain(sentinel);
    }
    expect(logged).not.toContain(USER_ID);
  });

  it("returns — never throws — when the telemetry write is refused", async () => {
    const call = await callGoogle(geminiOk("{}", USAGE));
    const h = harness("rejected");
    await expect(
      recordAiProviderUsage(
        { userId: USER_ID, operation: "analyze", selection: SELECTION, reasoning: REASONING, call, operationOutcome: "succeeded" },
        h.deps,
      ),
    ).resolves.toBe("write_rejected");
    expect(h.errors.join("\n")).toContain("code=23514");
    expect(h.errors.join("\n")).not.toContain(USER_ID);
  });
});

describe("analyze-paper is wired to the shared recorder", () => {
  it("records through the one shared recorder, from one closure, as the analyze operation", () => {
    expect(SOURCE).toContain('from "../_shared/aiUsageTelemetry.ts"');
    expect(CODE.match(/recordAiProviderUsage\(/g)?.length).toBe(1);
    expect(CODE).toContain('operation: "analyze",');
  });

  it("records once on the success path and once on the provider-failure path, and nowhere else", () => {
    expect(CODE.match(/recordProviderUsage\(/g)?.length).toBe(2);
    const success = CODE.indexOf('await recordProviderUsage("succeeded");');
    const failure = CODE.indexOf('await recordProviderUsage("failed");');
    expect(success).toBeGreaterThan(CODE.indexOf("parsed = JSON.parse(cleanText);"));
    expect(success).toBeLessThan(CODE.indexOf("{ status: 200, headers: jsonHeaders }"));
    expect(failure).toBeGreaterThan(CODE.indexOf("} catch (geminiErr) {"));
    expect(failure).toBeLessThan(CODE.indexOf('error: "analysis_unavailable"'));
    // The refund on that path is unchanged and still comes first.
    expect(CODE.lastIndexOf("await safeRefundAiQuota(supabase, user.id);", failure)).toBeGreaterThan(
      CODE.indexOf("} catch (geminiErr) {"),
    );
  });

  it("records only a provider call that happened", () => {
    expect(CODE).toContain("let dispatchedCall: AiProviderResult | null = null;");
    expect(CODE).toContain("if (dispatchedCall === null) return;");
    expect(CODE.match(/dispatchedCall = providerCall;/g)?.length).toBe(1);
    expect(CODE.indexOf("dispatchedCall = providerCall;")).toBeGreaterThan(
      CODE.indexOf("await generateWithRegisteredAiProvider("),
    );
  });

  it("records nothing for a request refused before the provider", () => {
    const dispatch = CODE.indexOf("await generateWithRegisteredAiProvider(");
    for (const refusal of ["status: 401", "status: 400", "status: 402", "not configured in Supabase secrets"]) {
      expect(CODE.indexOf(refusal)).toBeGreaterThan(-1);
      expect(CODE.indexOf(refusal)).toBeLessThan(dispatch);
    }
    // The outer catch — reached by a missing credential and by anything before
    // the provider — records nothing.
    const outerCatch = CODE.lastIndexOf("} catch (err) {");
    expect(CODE.slice(outerCatch)).not.toContain("recordProviderUsage");
  });

  it("uses the authoritative identity and the server-side decisions, never the request body", () => {
    expect(CODE).toContain("userId: user.id,");
    expect(CODE).toContain("selection: modelSelection,");
    expect(CODE).toContain("reasoning: reasoningDecision,");
    expect(CODE).toContain("call: dispatchedCall,");
    expect(CODE.match(/await req\.json\(\)/g)?.length).toBe(1);
  });

  it("builds the telemetry client from the platform key, never from the caller's client or header", () => {
    const at = CODE.indexOf("createAiUsageEventInsertClient({");
    expect(at).toBeGreaterThan(-1);
    const factoryCall = CODE.slice(at, CODE.indexOf("}),", at));
    expect(factoryCall).toContain("readEnv: (name) => Deno.env.get(name),");
    expect(factoryCall).not.toContain("authHeader");
    expect(factoryCall).not.toContain("Authorization");
    // The key names live in the shared factory, not here.
    expect(CODE).not.toMatch(/SUPABASE_SECRET_KEYS|SERVICE_ROLE/);
    // Quota and routing still use the caller-scoped client alone.
    expect(CODE.match(/const supabase = createClient\(/g)?.length).toBe(1);
  });

  it("never branches on the telemetry outcome", () => {
    expect(CODE).not.toMatch(/=\s*await recordAiProviderUsage/);
    expect(CODE).not.toMatch(/=\s*await recordProviderUsage/);
    expect(CODE).not.toMatch(/if\s*\(\s*await recordProviderUsage/);
  });

  it("leaves the quota and refund call sites exactly as they were", () => {
    expect(SOURCE.match(/rpc\(\s*\n?\s*"consume_ai_quota"/g)?.length).toBe(1);
    expect(SOURCE.match(/safeRefundAiQuota\(supabase, user\.id\)/g)?.length).toBe(2);
  });
});
