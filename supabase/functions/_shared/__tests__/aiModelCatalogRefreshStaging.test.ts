// @vitest-environment node
//
// Node rather than jsdom: this drives the real provider adapters, which want
// the platform `Response` and `AbortSignal`, and no DOM.
//
// AI-MODEL-CATALOG-REFRESH-001A — the three staged replacement models, end to
// end, against the catalog as migration 20260930203613 leaves it.
//
// Staging changed no Edge request builder. What it changed is DATA: three new
// catalog rows that are `enabled` (the resolver routes a saved preference to
// them) but neither `selectable` nor `reasoning_selectable` (no user can choose
// them or a manual level for them). This suite proves the shipped runtime
// already handles those rows safely, by composing the modules exactly as both
// generation functions do:
//
//   resolveEffectiveAiModel            — entitlement + the saved preference
//     → resolveAiReasoningPolicy         — manual vs Automatic, per operation
//     → generateWithRegisteredAiProvider — narrows the level to the adapter
//     → the provider's request body       (captured, never sent)
//     → buildAiProviderUsageEvent         (the telemetry row it would write)
//
// The preferences below are the OPERATOR-written rows a Phase-C canary uses:
// the setter refuses to create them (pgTAP suite 028 proves that), so a staged
// model is reachable only this way. What this suite pins is that such a canary
// really reaches the staged model — never a silent fallback to Gemini — and
// that no real path can send a staged model a reasoning value it rejects.
//
// Nothing is mocked but the network and the database: the fake client answers
// with the rows the final migration state holds, and fetch is an in-memory
// capture that returns a provider-shaped success.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
const OCCURRED_AT = new Date("2026-10-01T12:00:00Z");

const STAGING_MIGRATION = readFileSync(
  fileURLToPath(
    new URL("../../../migrations/20260930203613_stage_ai_model_catalog_refresh.sql", import.meta.url),
  ),
  "utf8",
);

type CatalogRow = {
  readonly id: string;
  readonly provider: string;
  readonly provider_model: string;
  readonly display_name: string;
  readonly enabled: boolean;
  readonly selectable: boolean;
  readonly sort_order: number;
  readonly reasoning_selectable: boolean;
  readonly reasoning_levels: readonly string[];
  readonly auto_analyze_reasoning_level: string;
  readonly auto_suggest_reasoning_level: string;
};

// ── The catalog after 20260930203613, row for row ──────────────────────────
// The six current rows exactly as 20260919075655 left them, and the three
// staged rows. The runtime reads these; it holds no copy of them.
const CURRENT: readonly CatalogRow[] = [
  { id: "google/gemini-3.5-flash", provider: "google", provider_model: "gemini-3.5-flash",
    display_name: "Gemini 3.5 Flash", enabled: true, selectable: true, sort_order: 10,
    reasoning_selectable: true, reasoning_levels: ["minimal", "low", "medium", "high"],
    auto_analyze_reasoning_level: "minimal", auto_suggest_reasoning_level: "medium" },
  { id: "google/gemini-3.6-flash", provider: "google", provider_model: "gemini-3.6-flash",
    display_name: "Gemini 3.6 Flash", enabled: true, selectable: true, sort_order: 20,
    reasoning_selectable: true, reasoning_levels: ["minimal", "low", "medium", "high"],
    auto_analyze_reasoning_level: "minimal", auto_suggest_reasoning_level: "medium" },
  { id: "google/gemini-3.7-flash", provider: "google", provider_model: "gemini-3.7-flash",
    display_name: "Gemini 3.7 Flash", enabled: true, selectable: true, sort_order: 30,
    reasoning_selectable: true, reasoning_levels: ["low", "medium", "high"],
    auto_analyze_reasoning_level: "low", auto_suggest_reasoning_level: "medium" },
  { id: "google/gemini-3.8-flash", provider: "google", provider_model: "gemini-3.8-flash",
    display_name: "Gemini 3.8 Flash", enabled: true, selectable: true, sort_order: 40,
    reasoning_selectable: true, reasoning_levels: ["low", "medium", "high"],
    auto_analyze_reasoning_level: "low", auto_suggest_reasoning_level: "medium" },
  { id: "anthropic/claude-sonnet-5", provider: "anthropic", provider_model: "claude-sonnet-5",
    display_name: "Claude Sonnet 5", enabled: true, selectable: true, sort_order: 50,
    reasoning_selectable: true, reasoning_levels: ["off", "low", "medium", "high", "xhigh", "max"],
    auto_analyze_reasoning_level: "off", auto_suggest_reasoning_level: "medium" },
  { id: "openai/gpt-5.6-terra", provider: "openai", provider_model: "gpt-5.6-terra",
    display_name: "GPT-5.6 Terra", enabled: true, selectable: true, sort_order: 60,
    reasoning_selectable: true, reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max"],
    auto_analyze_reasoning_level: "none", auto_suggest_reasoning_level: "medium" },
];

const FIVE_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const STAGED: readonly CatalogRow[] = [
  { id: "anthropic/claude-sonnet-5-5", provider: "anthropic", provider_model: "claude-sonnet-5-5",
    display_name: "Claude Sonnet 5.5", enabled: true, selectable: false, sort_order: 70,
    reasoning_selectable: false, reasoning_levels: FIVE_LEVELS,
    auto_analyze_reasoning_level: "low", auto_suggest_reasoning_level: "medium" },
  { id: "anthropic/claude-opus-5-5", provider: "anthropic", provider_model: "claude-opus-5-5",
    display_name: "Claude Opus 5.5", enabled: true, selectable: false, sort_order: 80,
    reasoning_selectable: false, reasoning_levels: FIVE_LEVELS,
    auto_analyze_reasoning_level: "low", auto_suggest_reasoning_level: "medium" },
  { id: "openai/gpt-6.1-sol", provider: "openai", provider_model: "gpt-6.1-sol",
    display_name: "GPT-6.1 Sol", enabled: true, selectable: false, sort_order: 90,
    reasoning_selectable: false, reasoning_levels: FIVE_LEVELS,
    auto_analyze_reasoning_level: "low", auto_suggest_reasoning_level: "medium" },
];

const CATALOG: readonly CatalogRow[] = [...CURRENT, ...STAGED];

/** Each staged model's shipped price record, and what 1,000 in / 200 out costs. */
const STAGED_PRICING: Record<string, { recordId: string; amountUsd: string }> = {
  // 1,000 x $2/M + 200 x $10/M
  "claude-sonnet-5-5": { recordId: "anthropic/claude-sonnet-5-5@2026-09-30", amountUsd: "0.004000000000000" },
  // 1,000 x $4/M + 200 x $20/M
  "claude-opus-5-5": { recordId: "anthropic/claude-opus-5-5@2026-09-30", amountUsd: "0.008000000000000" },
  // 1,000 x $2/M + 200 x $10/M
  "gpt-6.1-sol": { recordId: "openai/gpt-6.1-sol@2026-09-30", amountUsd: "0.004000000000000" },
};

/**
 * The caller-scoped client both functions pass to the two resolvers, answering
 * from `catalog`: the access projection, the caller's own preference row, and
 * catalog lookups by whatever columns the resolver filters on.
 *
 * `failReasoningLookup` makes only the reasoning policy's (provider,
 * provider_model) lookup fail, which is how the provider-default fail-open path
 * is reached without disturbing model selection's lookup by id.
 */
function fakeClient(opts: {
  entitled: boolean;
  preference: { preferred_model_id: string; preferred_reasoning_level: string | null } | null;
  catalog?: readonly CatalogRow[];
  failReasoningLookup?: boolean;
}): AiModelSelectionClient {
  const catalog = opts.catalog ?? CATALOG;
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
                if (opts.failReasoningLookup && "provider_model" in filters) {
                  return { data: null, error: { message: "simulated catalog outage" } };
                }
                const row = catalog.find((r) =>
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

function at(body: RequestBody, ...path: string[]): unknown {
  let current: unknown = body;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** The reasoning field(s) exactly as each provider's API receives them. */
function wireReasoning(provider: string, body: RequestBody): string | null {
  if (provider === "google") return (at(body, "generationConfig", "thinkingConfig", "thinkingLevel") as string) ?? null;
  if (provider === "anthropic") {
    const thinking = at(body, "thinking", "type") as string | undefined;
    const effort = at(body, "output_config", "effort") as string | undefined;
    return thinking === undefined && effort === undefined ? null : `${thinking}/${effort}`;
  }
  if (provider === "openai") return (at(body, "reasoning", "effort") as string) ?? null;
  throw new Error(`no wire mapping for ${provider}`);
}

const HIDDEN_REASONING = "SENTINEL-HIDDEN-REASONING-TEXT";
const ANSWER = '{"sentinel":"answer"}';

/**
 * A provider-shaped SUCCESS whose hidden reasoning precedes the answer — the
 * shape both Claude 5.5 models and Sol return — with usage that prices.
 */
function successFor(provider: string): Response {
  const body =
    provider === "anthropic"
      ? {
          type: "message",
          role: "assistant",
          content: [
            { type: "thinking", thinking: HIDDEN_REASONING, signature: "sig" },
            { type: "text", text: ANSWER },
          ],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 200,
            output_tokens_details: { thinking_tokens: 50 },
          },
        }
      : {
          status: "completed",
          output: [
            { type: "reasoning", summary: [{ type: "summary_text", text: HIDDEN_REASONING }] },
            { type: "message", content: [{ type: "output_text", text: ANSWER }] },
          ],
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 200,
            output_tokens_details: { reasoning_tokens: 50 },
            total_tokens: 1200,
          },
        };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Run one operation through the real resolvers, adapter and telemetry builder. */
async function runOperation(operation: AiOperation, client: AiModelSelectionClient) {
  const warns: string[] = [];
  const logger = { warn: (m: string) => warns.push(m) };
  const selection = await resolveEffectiveAiModel({
    client,
    userId: USER_ID,
    systemDefault: resolveSystemDefaultAiModel("gemini-3.6-flash"),
    label: "staging-test",
    logger,
  });
  const decision = await resolveAiReasoningPolicy({
    client,
    operation,
    selection,
    label: "staging-test",
    logger,
  });
  const bodies: RequestBody[] = [];
  const raws: string[] = [];
  const urls: string[] = [];
  const call = await generateWithRegisteredAiProvider(selection, REQUESTS[operation], decision.policy, {
    apiKey: "SENTINEL-TEST-KEY",
    label: "staging-test",
    fetchImpl: async (url: string, init: RequestInit) => {
      urls.push(url);
      raws.push(String(init.body));
      bodies.push(JSON.parse(String(init.body)) as RequestBody);
      return successFor(selection.provider);
    },
    sleep: async () => undefined,
    createTimeoutSignal: () => new AbortController().signal,
    logger,
  });
  const event = buildAiProviderUsageEvent({
    userId: USER_ID,
    operation,
    selection,
    reasoning: decision,
    call,
    operationOutcome: call.ok ? "succeeded" : "failed",
    occurredAt: OCCURRED_AT,
  });
  if (!event.ok) throw new Error("the telemetry row was refused");
  return { selection, decision, call, bodies, raws, urls, event: event.row, warns };
}

const operatorPreference = (row: CatalogRow, level: string | null) =>
  fakeClient({
    entitled: true,
    preference: { preferred_model_id: row.id, preferred_reasoning_level: level },
  });

const expectedWire = (provider: string, level: string) =>
  provider === "anthropic" ? `adaptive/${level}` : level;

// Anthropic spellings that must never reach a staged Claude model, and
// OpenAI's that must never reach Sol. Checked against the raw body so a value
// cannot hide in some other key either.
function expectNoRejectedReasoning(provider: string, raw: string) {
  expect(raw).not.toContain('"disabled"');
  expect(raw).not.toContain("between_tools");
  expect(raw).not.toContain('"minimal"');
  if (provider === "anthropic") expect(raw).not.toContain('"budget_tokens"');
  if (provider === "openai") expect(raw).not.toContain('"none"');
}

// ── 1. The fixture IS the migration ────────────────────────────────────────

describe("the staged rows this suite routes are the rows the migration inserts", () => {
  const normalized = STAGING_MIGRATION.replace(/\s+/g, " ");
  it.each(STAGED.map((row) => [row.id, row] as const))("%s", (_id, row) => {
    const levels = row.reasoning_levels.map((l) => `'${l}'`).join(",");
    const tuple =
      `('${row.id}', '${row.provider}', '${row.provider_model}', '${row.display_name}', ` +
      `true, false, ${row.sort_order}, ARRAY[${levels}], ` +
      `'${row.auto_analyze_reasoning_level}', '${row.auto_suggest_reasoning_level}', false)`;
    // Once in the INSERT, once in the verify block.
    expect(normalized.split(tuple).length - 1).toBe(2);
  });

  it("stages exactly three rows, none of them selectable or open to manual reasoning", () => {
    expect(STAGED).toHaveLength(3);
    for (const row of STAGED) {
      expect(row.enabled).toBe(true);
      expect(row.selectable).toBe(false);
      expect(row.reasoning_selectable).toBe(false);
      expect(row.reasoning_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });
});

// ── 2. An operator-written preference really routes to the staged model ─────

describe("Automatic on each staged model — the Phase-C canary path", () => {
  it.each(STAGED.map((row) => [row.id, row] as const))("%s on Automatic", async (_id, row) => {
    const client = operatorPreference(row, null);
    for (const operation of ["analyze", "suggest"] as const) {
      const { selection, decision, call, bodies, raws, event, warns } = await runOperation(operation, client);

      // Routed to the staged model itself — NOT a silent fallback to Gemini.
      expect(selection).toMatchObject({
        provider: row.provider,
        providerModel: row.provider_model,
        source: "user_preference",
        reasoningPreference: null,
      });

      // PaperLume's own Automatic policy, not the provider's default.
      const level = operation === "analyze" ? "low" : "medium";
      expect(decision).toEqual({
        policy: {
          reasoning: { kind: "level", level },
          maxOutputTokens: operation === "analyze" ? 4096 : 8192,
        },
        source: "automatic",
        reason: null,
      });
      expect(formatReasoningPolicyLog("staging-test", operation, decision)).toBe(
        `staging-test reasoning_policy operation=${operation} source=automatic ` +
          `level=${level} max_output_tokens=${operation === "analyze" ? 4096 : 8192}`,
      );

      // Exactly one request, to the exact provider model, at that level.
      expect(bodies).toHaveLength(1);
      expect(bodies[0].model).toBe(row.provider_model);
      expect(wireReasoning(row.provider, bodies[0])).toBe(expectedWire(row.provider, level));
      expectNoRejectedReasoning(row.provider, raws[0]);
      expect(warns).toEqual([]);

      // Hidden reasoning never becomes the answer.
      expect(call).toMatchObject({ ok: true, text: ANSWER, attempts: 1 });
      expect(JSON.stringify(call)).not.toContain(HIDDEN_REASONING);

      // Telemetry names the exact staged model and prices it by its own record.
      expect(event).toMatchObject({
        operation,
        provider: row.provider,
        provider_model: row.provider_model,
        model_selection_source: "user_preference",
        reasoning_source: "automatic",
        resolved_reasoning_level: level,
        provider_outcome: "completed",
        provider_attempts: 1,
        operation_outcome: "succeeded",
        usage_status: "reported",
        input_tokens: 1000,
        output_tokens: 200,
        reasoning_output_tokens: 50,
        cost_status: "estimated",
        price_record_id: STAGED_PRICING[row.provider_model].recordId,
        list_price_estimate_usd: STAGED_PRICING[row.provider_model].amountUsd,
      });
      // Content-free: nothing from the prompt, the answer or the reasoning.
      const serialized = JSON.stringify(event);
      for (const sentinel of ["SENTINEL TITLE", "SENTINEL ABSTRACT", ANSWER, HIDDEN_REASONING, "SENTINEL-TEST-KEY"]) {
        expect(serialized).not.toContain(sentinel);
      }
    }
  });
});

// ── 3. Every staged level reaches the wire exactly ─────────────────────────

const STAGED_LEVELS: Array<[CatalogRow, string]> = STAGED.flatMap((row) =>
  row.reasoning_levels.map((level) => [row, level] as [CatalogRow, string]),
);

describe("an operator-written manual level reaches a staged model exactly, on BOTH operations", () => {
  it("covers every level of every staged model — 15 pairs", () => {
    expect(STAGED_LEVELS).toHaveLength(3 * 5);
  });

  it.each(STAGED_LEVELS.map(([row, level]) => [row.id, level, row] as const))(
    "%s + manual %s",
    async (_id, level, row) => {
      const client = operatorPreference(row, level);
      for (const operation of ["analyze", "suggest"] as const) {
        const { selection, decision, bodies, raws, event, warns } = await runOperation(operation, client);
        expect(selection).toMatchObject({ providerModel: row.provider_model, source: "user_preference" });
        expect(decision).toMatchObject({ source: "manual", reason: null });
        expect(decision.policy.reasoning).toEqual({ kind: "level", level });

        expect(bodies).toHaveLength(1);
        if (row.provider === "anthropic") {
          // Adaptive thinking at EVERY exposed level — never disabled, never
          // between_tools — with effort beside the structured-output format.
          expect(bodies[0].thinking).toEqual({ type: "adaptive" });
          expect(bodies[0].output_config).toEqual({
            format: { type: "json_schema", schema: REQUESTS[operation].jsonSchema.schema },
            effort: level,
          });
          expect(bodies[0].max_tokens).toBe(operation === "analyze" ? 4096 : 8192);
        } else {
          expect(bodies[0].reasoning).toEqual({ effort: level });
          expect(bodies[0].store).toBe(false);
          expect(bodies[0].max_output_tokens).toBe(operation === "analyze" ? 4096 : 8192);
        }
        expectNoRejectedReasoning(row.provider, raws[0]);
        expect(warns).toEqual([]);
        expect(event).toMatchObject({
          provider_model: row.provider_model,
          reasoning_source: "manual",
          resolved_reasoning_level: level,
        });
      }
    },
  );
});

// ── 4. No real path sends a staged model a value it rejects ────────────────

describe("the fail-safe contract holds for the staged models", () => {
  // Each value is a real canonical level a stale or hand-written preference
  // could hold, and each is one the staged model's provider rejects.
  const UNSUPPORTED: Array<[CatalogRow, string]> = STAGED.flatMap((row) =>
    (row.provider === "anthropic" ? ["off", "none", "minimal"] : ["none", "off", "minimal"]).map(
      (level) => [row, level] as [CatalogRow, string],
    ),
  );

  it.each(UNSUPPORTED.map(([row, level]) => [row.id, level, row] as const))(
    "%s with a saved `%s` runs at Automatic instead",
    async (_id, level, row) => {
      const client = operatorPreference(row, level);
      for (const operation of ["analyze", "suggest"] as const) {
        const { selection, decision, bodies, raws, event, warns } = await runOperation(operation, client);
        const automatic = operation === "analyze" ? "low" : "medium";
        // Still the staged model: an unsupported LEVEL never moves the MODEL.
        expect(selection).toMatchObject({ providerModel: row.provider_model, source: "user_preference" });
        expect(decision).toMatchObject({ source: "automatic", reason: "manual_level_unsupported" });
        expect(wireReasoning(row.provider, bodies[0])).toBe(expectedWire(row.provider, automatic));
        expectNoRejectedReasoning(row.provider, raws[0]);
        expect(warns).toContain(
          "staging-test reasoning_policy_fallback reason=manual_level_unsupported " +
            `provider=${row.provider} model=${row.provider_model}`,
        );
        expect(event).toMatchObject({ reasoning_source: "automatic", resolved_reasoning_level: automatic });
      }
    },
  );

  it.each(STAGED.map((row) => [row.id, row] as const))(
    "%s sends no reasoning field at all when policy metadata is unusable",
    async (_id, row) => {
      // The bounded fail-open path: the catalog read for reasoning fails, so
      // PaperLume chose nothing and sends nothing. On all three staged models
      // that means adaptive thinking / the provider's effort default — never a
      // disabled or rejected configuration.
      const client = fakeClient({
        entitled: true,
        preference: { preferred_model_id: row.id, preferred_reasoning_level: null },
        failReasoningLookup: true,
      });
      for (const operation of ["analyze", "suggest"] as const) {
        const { selection, decision, bodies, raws, event } = await runOperation(operation, client);
        expect(selection).toMatchObject({ providerModel: row.provider_model, source: "user_preference" });
        expect(decision).toMatchObject({ source: "provider_default_fallback", reason: "catalog_lookup_failed" });
        expect(wireReasoning(row.provider, bodies[0])).toBeNull();
        if (row.provider === "anthropic") {
          expect(bodies[0]).not.toHaveProperty("thinking");
          expect(bodies[0].output_config).toEqual({
            format: { type: "json_schema", schema: REQUESTS[operation].jsonSchema.schema },
          });
        } else {
          expect(bodies[0]).not.toHaveProperty("reasoning");
          expect(bodies[0].store).toBe(false);
        }
        expectNoRejectedReasoning(row.provider, raws[0]);
        expect(event).toMatchObject({
          provider_model: row.provider_model,
          reasoning_source: "provider_default_fallback",
          resolved_reasoning_level: null,
        });
      }
    },
  );

  it("refuses another provider's spelling at the adapter even if a drifted row listed it", async () => {
    // The last structural guard. A hand-edited Sol row that listed Anthropic's
    // `off` would pass policy resolution (the catalog is the authority), and
    // the OpenAI adapter must still refuse to send it.
    const drifted = STAGED.map((row) =>
      row.id === "openai/gpt-6.1-sol" ? { ...row, reasoning_levels: ["off", ...row.reasoning_levels] } : row,
    );
    const client = fakeClient({
      entitled: true,
      preference: { preferred_model_id: "openai/gpt-6.1-sol", preferred_reasoning_level: "off" },
      catalog: [...CURRENT, ...drifted],
    });
    const { decision, bodies, raws, warns } = await runOperation("analyze", client);
    expect(decision).toMatchObject({ source: "manual" });
    expect(bodies[0]).not.toHaveProperty("reasoning");
    expect(raws[0]).not.toContain('"off"');
    expect(warns).toContain("staging-test reasoning_level_rejected_by_adapter provider=openai level=off");
  });
});

// ── 5. What staging does not change ────────────────────────────────────────

describe("the two models being replaced keep working exactly as before", () => {
  it.each([
    ["anthropic/claude-sonnet-5", "disabled/low", "anthropic/claude-sonnet-5@2026-09-17"],
    ["openai/gpt-5.6-terra", "none", "openai/gpt-5.6-terra@2026-09-17"],
  ] as const)("%s on Automatic Analyze", async (id, wire, recordId) => {
    const row = CURRENT.find((r) => r.id === id)!;
    const { selection, bodies, event } = await runOperation("analyze", operatorPreference(row, null));
    expect(selection).toMatchObject({ providerModel: row.provider_model, source: "user_preference" });
    // Sonnet 5 still accepts `off` → disabled thinking, and Terra still `none`:
    // the adapters' provider-level vocabularies were deliberately not narrowed.
    expect(wireReasoning(row.provider, bodies[0])).toBe(wire);
    expect(event).toMatchObject({ provider_model: row.provider_model, price_record_id: recordId });
  });

  it.each([
    ["anthropic/claude-sonnet-5", "xhigh", "adaptive/xhigh"],
    ["openai/gpt-5.6-terra", "none", "none"],
  ] as const)("%s with a saved manual %s", async (id, level, wire) => {
    const row = CURRENT.find((r) => r.id === id)!;
    for (const operation of ["analyze", "suggest"] as const) {
      const { decision, bodies } = await runOperation(operation, operatorPreference(row, level));
      expect(decision).toMatchObject({ source: "manual", reason: null });
      expect(wireReasoning(row.provider, bodies[0])).toBe(wire);
    }
  });
});

describe("staging grants nobody a model", () => {
  it.each(STAGED.map((row) => [row.id, row] as const))(
    "an unentitled account holding a %s preference still runs on the system default",
    async (_id, row) => {
      const client = fakeClient({
        entitled: false,
        preference: { preferred_model_id: row.id, preferred_reasoning_level: "max" },
      });
      for (const operation of ["analyze", "suggest"] as const) {
        const { selection, decision, urls, event } = await runOperation(operation, client);
        expect(selection).toMatchObject({
          provider: "google",
          providerModel: "gemini-3.6-flash",
          source: "system_default",
          reasoningPreference: null,
        });
        expect(decision.source).toBe("automatic");
        expect(urls.every((u) => u.includes("generativelanguage.googleapis.com"))).toBe(true);
        expect(event).toMatchObject({ provider: "google", model_selection_source: "system_default" });
      }
    },
  );
});
