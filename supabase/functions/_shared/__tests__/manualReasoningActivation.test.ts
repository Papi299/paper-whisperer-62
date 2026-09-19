// @vitest-environment node
//
// Node rather than jsdom: this drives the real provider adapters, which want
// the platform `Response` and `AbortSignal`, and no DOM.
//
// AI-MANUAL-REASONING-001 — the already-deployed runtime, end to end, against
// the catalog as migration 20260919075655 leaves it.
//
// Activation changed no Edge source. What it changed is DATA: six catalog rows
// now accept a manual level, and users can now store one. This suite proves the
// shipped modules already carry such a level all the way to the wire, by
// composing them exactly as both generation functions do:
//
//   resolveEffectiveAiModel   — reads the entitlement and the saved preference
//     → resolveAiReasoningPolicy — decides manual vs Automatic, per operation
//     → generateWithRegisteredAiProvider — narrows the level to the adapter
//     → the provider's request body          (captured, never sent)
//     → buildAiProviderUsageEvent            (the telemetry row it would write)
//
// The unit suites for each module already pin its own contract; this one pins
// the seams between them, for every level of every activated model. Nothing is
// mocked but the network and the database: the fake client answers with the
// rows the final migration state holds, and fetch is an in-memory capture.
import { describe, it, expect } from "vitest";
import {
  resolveEffectiveAiModel,
  type AiModelSelectionClient,
} from "../aiModelSelection.ts";
import {
  formatReasoningPolicyLog,
  resolveAiReasoningPolicy,
  type AiOperation,
} from "../aiReasoningPolicy.ts";
import {
  generateWithRegisteredAiProvider,
  resolveSystemDefaultAiModel,
} from "../aiProviderRegistry.ts";
import { buildAiProviderUsageEvent } from "../aiUsageTelemetry.ts";
import type { AiGenerationRequest } from "../aiProvider.ts";
import { buildAnalyzeGenerationRequest } from "../../analyze-paper/prompt.ts";
import { buildSuggestGenerationRequest } from "../../suggest-paper-organization/prompt.ts";

const USER_ID = "11111111-2222-4333-8444-555555555555";

// ── The catalog after 20260919075655, row for row ──────────────────────────
// Fixture data mirroring the migration's own verify tuple. The runtime reads
// these; it holds no copy of them.
const CATALOG = [
  { id: "google/gemini-3.5-flash", provider: "google", provider_model: "gemini-3.5-flash",
    enabled: true, selectable: true, reasoning_selectable: true,
    reasoning_levels: ["minimal", "low", "medium", "high"],
    auto_analyze_reasoning_level: "minimal", auto_suggest_reasoning_level: "medium" },
  { id: "google/gemini-3.6-flash", provider: "google", provider_model: "gemini-3.6-flash",
    enabled: true, selectable: true, reasoning_selectable: true,
    reasoning_levels: ["minimal", "low", "medium", "high"],
    auto_analyze_reasoning_level: "minimal", auto_suggest_reasoning_level: "medium" },
  { id: "google/gemini-3.7-flash", provider: "google", provider_model: "gemini-3.7-flash",
    enabled: true, selectable: true, reasoning_selectable: true,
    reasoning_levels: ["low", "medium", "high"],
    auto_analyze_reasoning_level: "low", auto_suggest_reasoning_level: "medium" },
  { id: "google/gemini-3.8-flash", provider: "google", provider_model: "gemini-3.8-flash",
    enabled: true, selectable: true, reasoning_selectable: true,
    reasoning_levels: ["low", "medium", "high"],
    auto_analyze_reasoning_level: "low", auto_suggest_reasoning_level: "medium" },
  { id: "anthropic/claude-sonnet-5", provider: "anthropic", provider_model: "claude-sonnet-5",
    enabled: true, selectable: true, reasoning_selectable: true,
    reasoning_levels: ["off", "low", "medium", "high", "xhigh", "max"],
    auto_analyze_reasoning_level: "off", auto_suggest_reasoning_level: "medium" },
  { id: "openai/gpt-5.6-terra", provider: "openai", provider_model: "gpt-5.6-terra",
    enabled: true, selectable: true, reasoning_selectable: true,
    reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max"],
    auto_analyze_reasoning_level: "none", auto_suggest_reasoning_level: "medium" },
] as const;

type CatalogRow = (typeof CATALOG)[number];

/**
 * The caller-scoped client both functions pass to the two resolvers, answering
 * from the rows above: the access projection, the caller's own preference row,
 * and catalog lookups by whatever columns the resolver filters on.
 */
function fakeClient(opts: {
  entitled: boolean;
  preference: { preferred_model_id: string; preferred_reasoning_level: string | null } | null;
}): AiModelSelectionClient {
  return {
    rpc: async (fn: string) => {
      if (fn !== "get_current_user_access") throw new Error(`unexpected rpc ${fn}`);
      return { data: [{ can_select_ai_model: opts.entitled }], error: null };
    },
    from(table: string) {
      return {
        select() {
          const filters: Record<string, string> = {};
          const query = {
            eq(column: string, value: string) {
              filters[column] = value;
              return query;
            },
            async maybeSingle() {
              if (table === "user_ai_preferences") {
                return { data: opts.preference ? { ...opts.preference } : null, error: null };
              }
              if (table === "ai_model_catalog") {
                const row = CATALOG.find((r) =>
                  Object.entries(filters).every(
                    ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
                  ),
                );
                return {
                  data: row ? (JSON.parse(JSON.stringify(row)) as Record<string, unknown>) : null,
                  error: null,
                };
              }
              throw new Error(`unexpected table ${table}`);
            },
          };
          return query;
        },
      };
    },
  };
}

const REQUESTS: Record<AiOperation, AiGenerationRequest> = {
  analyze: buildAnalyzeGenerationRequest("SENTINEL TITLE", "SENTINEL ABSTRACT"),
  suggest: buildSuggestGenerationRequest('{"paper":"SENTINEL"}'),
};

type RequestBody = Record<string, unknown>;

/** One field out of a parsed request body, by path, without `any`. */
function at(body: RequestBody, ...path: string[]): string | null {
  let current: unknown = body;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

/**
 * The reasoning field(s) exactly as each provider's API receives them:
 *   google    — generationConfig.thinkingConfig.thinkingLevel
 *   anthropic — thinking.type / output_config.effort
 *   openai    — reasoning.effort
 */
function wireReasoning(provider: string, body: RequestBody): string | null {
  if (provider === "google") return at(body, "generationConfig", "thinkingConfig", "thinkingLevel");
  if (provider === "anthropic") {
    const thinking = at(body, "thinking", "type");
    const effort = at(body, "output_config", "effort");
    return thinking === null && effort === null ? null : `${thinking}/${effort}`;
  }
  if (provider === "openai") return at(body, "reasoning", "effort");
  throw new Error(`no wire mapping for ${provider}`);
}

/** What each provider's wire must carry for a canonical level. */
function expectedWire(provider: string, level: string): string {
  if (provider === "anthropic") return level === "off" ? "disabled/low" : `adaptive/${level}`;
  return level;
}

/** Run one operation through the real resolvers and the real adapter. */
async function runOperation(
  operation: AiOperation,
  client: AiModelSelectionClient,
) {
  const warns: string[] = [];
  const logger = { warn: (m: string) => warns.push(m) };
  const selection = await resolveEffectiveAiModel({
    client,
    userId: USER_ID,
    systemDefault: resolveSystemDefaultAiModel("gemini-3.6-flash"),
    label: "activation-test",
    logger,
  });
  const decision = await resolveAiReasoningPolicy({
    client,
    operation,
    selection,
    label: "activation-test",
    logger,
  });
  const bodies: RequestBody[] = [];
  const call = await generateWithRegisteredAiProvider(
    selection,
    REQUESTS[operation],
    decision.policy,
    {
      apiKey: "SENTINEL-TEST-KEY",
      label: "activation-test",
      fetchImpl: async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as RequestBody);
        // A provider-side failure: the request body is what is under test, and
        // a failed call still produces the telemetry row asserted below.
        return new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
      },
      sleep: async () => undefined,
      createTimeoutSignal: () => new AbortController().signal,
      logger,
    },
  );
  const event = buildAiProviderUsageEvent({
    userId: USER_ID,
    operation,
    selection,
    reasoning: decision,
    call,
    operationOutcome: "failed",
    occurredAt: new Date("2026-09-19T12:00:00Z"),
  });
  if (!event.ok) throw new Error("the telemetry row was refused");
  return { selection, decision, bodies, event: event.row, warns };
}

const EVERY_LEVEL: Array<[CatalogRow, string]> = CATALOG.flatMap((row) =>
  row.reasoning_levels.map((level) => [row, level] as [CatalogRow, string]),
);

describe("a saved manual level reaches the provider on BOTH operations", () => {
  it("covers every level of every activated model — 26 pairs", () => {
    expect(EVERY_LEVEL).toHaveLength(4 + 4 + 3 + 3 + 6 + 6);
  });

  it.each(EVERY_LEVEL.map(([row, level]) => [row.id, level, row] as const))(
    "%s + manual %s",
    async (_id, level, row) => {
      const client = fakeClient({
        entitled: true,
        preference: { preferred_model_id: row.id, preferred_reasoning_level: level },
      });
      for (const operation of ["analyze", "suggest"] as const) {
        const { selection, decision, bodies, event, warns } = await runOperation(operation, client);

        // The pinned model was honoured, and the level travelled with it.
        expect(selection).toMatchObject({
          provider: row.provider,
          providerModel: row.provider_model,
          source: "user_preference",
          reasoningPreference: level,
        });
        // Manual outranks this operation's Automatic level.
        expect(decision.source).toBe("manual");
        expect(decision.reason).toBeNull();
        expect(decision.policy.reasoning).toEqual({ kind: "level", level });

        // Exactly one request, carrying the provider's own spelling of it.
        expect(bodies).toHaveLength(1);
        expect(wireReasoning(row.provider, bodies[0])).toBe(expectedWire(row.provider, level));

        // One bounded log line naming the decider and the public level only.
        expect(formatReasoningPolicyLog("activation-test", operation, decision)).toBe(
          `activation-test reasoning_policy operation=${operation} source=manual ` +
            `level=${level} max_output_tokens=${operation === "analyze" ? 4096 : 8192}`,
        );
        // The adapter accepted the level: no narrowing fallback, no warning.
        expect(warns.filter((w) => /reasoning/.test(w))).toEqual([]);

        // Telemetry records it as the user's choice, not as Automatic.
        expect(event).toMatchObject({
          operation,
          provider: row.provider,
          provider_model: row.provider_model,
          model_selection_source: "user_preference",
          reasoning_source: "manual",
          resolved_reasoning_level: level,
        });
      }
    },
  );
});

describe("Automatic is unchanged for every activated model", () => {
  it.each(CATALOG.map((row) => [row.id, row] as const))("%s on Automatic", async (_id, row) => {
    const client = fakeClient({
      entitled: true,
      preference: { preferred_model_id: row.id, preferred_reasoning_level: null },
    });
    for (const operation of ["analyze", "suggest"] as const) {
      const { decision, bodies, event } = await runOperation(operation, client);
      const level =
        operation === "analyze" ? row.auto_analyze_reasoning_level : row.auto_suggest_reasoning_level;
      expect(decision.source).toBe("automatic");
      expect(decision.policy.reasoning).toEqual({ kind: "level", level });
      expect(wireReasoning(row.provider, bodies[0])).toBe(expectedWire(row.provider, level));
      expect(event).toMatchObject({ reasoning_source: "automatic", resolved_reasoning_level: level });
    }
  });
});

describe("a manual level never outlives the model it was chosen for", () => {
  it("is dropped when entitlement is gone — the system default runs on Automatic", async () => {
    // A downgraded account still holds Claude + manual max. Routing re-checks
    // entitlement, falls back to the system default, and the level does not
    // follow the request onto a model nobody chose it for.
    const client = fakeClient({
      entitled: false,
      preference: { preferred_model_id: "anthropic/claude-sonnet-5", preferred_reasoning_level: "max" },
    });
    for (const operation of ["analyze", "suggest"] as const) {
      const { selection, decision, bodies, event } = await runOperation(operation, client);
      expect(selection).toMatchObject({
        provider: "google",
        providerModel: "gemini-3.6-flash",
        source: "system_default",
        reasoningPreference: null,
      });
      expect(decision.source).toBe("automatic");
      const level = operation === "analyze" ? "minimal" : "medium";
      expect(wireReasoning("google", bodies[0])).toBe(level);
      expect(JSON.stringify(bodies[0])).not.toContain("max");
      expect(event).toMatchObject({
        model_selection_source: "system_default",
        reasoning_source: "automatic",
        resolved_reasoning_level: level,
      });
    }
  });

  it("falls back to the model's Automatic level when the saved level is unsupported", async () => {
    // A stale row: Gemini 3.8 with `minimal`, which that model rejects. The
    // setter can no longer produce this, but the runtime must still never send it.
    const client = fakeClient({
      entitled: true,
      preference: { preferred_model_id: "google/gemini-3.8-flash", preferred_reasoning_level: "minimal" },
    });
    for (const operation of ["analyze", "suggest"] as const) {
      const { decision, bodies, event, warns } = await runOperation(operation, client);
      const level = operation === "analyze" ? "low" : "medium";
      expect(decision).toMatchObject({ source: "automatic", reason: "manual_level_unsupported" });
      expect(wireReasoning("google", bodies[0])).toBe(level);
      expect(event).toMatchObject({ reasoning_source: "automatic", resolved_reasoning_level: level });
      expect(warns).toContain(
        "activation-test reasoning_policy_fallback reason=manual_level_unsupported " +
          "provider=google model=gemini-3.8-flash",
      );
    }
  });
});
