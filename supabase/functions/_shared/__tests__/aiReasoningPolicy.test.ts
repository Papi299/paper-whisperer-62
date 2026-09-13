// @vitest-environment node
//
// Node rather than jsdom: this module runs in Deno and wants no DOM.
//
// AI-MULTI-PROVIDER-001C (C41) — PaperLume's reasoning policy.
//
// The claim under test is one sentence: **Automatic is PaperLume's choice, per
// model and per operation, and it is always sent explicitly.** Everything below
// is that sentence taken apart.
//
// The approved matrix is asserted against FIXTURE catalog rows, never against a
// list inside the module: the catalog is the authority, and a TypeScript copy of
// it here would be a second one that could disagree. The Sonnet 5 and Terra rows
// are fixtures for models that do not exist in `ai_model_catalog` at all — they
// prove the policy layer is model-shaped rather than Google-shaped, and seeding
// them is a separate reviewed migration.
import { describe, it, expect } from "vitest";
import {
  AI_OPERATION_MAX_OUTPUT_TOKENS,
  formatReasoningPolicyLog,
  resolveAiReasoningPolicy,
  type AiOperation,
} from "../aiReasoningPolicy.ts";
import type { AiModelSelection, AiModelSelectionClient } from "../aiModelSelection.ts";
import type { AiReasoningLevel } from "../aiProvider.ts";

// ── Catalog fixtures, exactly as migration 20260912120000 seeds them ───────

const GEMINI_35 = {
  provider: "google",
  provider_model: "gemini-3.5-flash",
  reasoning_levels: ["minimal", "low", "medium", "high"],
  auto_analyze_reasoning_level: "minimal",
  auto_suggest_reasoning_level: "medium",
};
const GEMINI_36 = { ...GEMINI_35, provider_model: "gemini-3.6-flash" };
const GEMINI_37 = {
  provider: "google",
  provider_model: "gemini-3.7-flash",
  reasoning_levels: ["low", "medium", "high"],
  auto_analyze_reasoning_level: "low",
  auto_suggest_reasoning_level: "medium",
};
const GEMINI_38 = { ...GEMINI_37, provider_model: "gemini-3.8-flash" };

// FUTURE rows. No such catalog row exists; these are test fixtures carrying the
// metadata a later, separately authorized staging migration would seed.
const SONNET_5 = {
  provider: "anthropic",
  provider_model: "claude-sonnet-5",
  reasoning_levels: ["off", "low", "medium", "high", "xhigh", "max"],
  auto_analyze_reasoning_level: "off",
  auto_suggest_reasoning_level: "medium",
};
const TERRA = {
  provider: "openai",
  provider_model: "gpt-5.6-terra",
  reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max"],
  auto_analyze_reasoning_level: "none",
  auto_suggest_reasoning_level: "medium",
};

type Row = Record<string, unknown> | null;

interface Recorded {
  table: string;
  columns: string;
  filters: [string, string][];
}

interface HarnessOptions {
  row?: Row;
  error?: unknown;
  throws?: boolean;
}

function makeHarness(options: HarnessOptions) {
  const queries: Recorded[] = [];
  const warns: string[] = [];

  const client: AiModelSelectionClient = {
    from(table: string) {
      return {
        select(columns: string) {
          const recorded: Recorded = { table, columns, filters: [] };
          queries.push(recorded);
          const query = {
            eq(column: string, value: string) {
              recorded.filters.push([column, value]);
              return query;
            },
            maybeSingle() {
              if (options.throws) throw new Error("client exploded");
              return Promise.resolve({
                data: (options.row ?? null) as Record<string, unknown> | null,
                error: options.error ?? null,
              });
            },
          };
          return query;
        },
      };
    },
    rpc() {
      throw new Error("the reasoning policy must not call an RPC");
    },
  };

  return { client, queries, warns, logger: { warn: (m: string) => warns.push(m) } };
}

function selection(
  provider: string,
  providerModel: string,
  overrides: Partial<AiModelSelection> = {},
): AiModelSelection {
  return {
    provider: provider as AiModelSelection["provider"],
    providerModel,
    source: "user_preference",
    fallbackReason: null,
    reasoningPreference: null,
    ...overrides,
  };
}

async function resolve(
  operation: AiOperation,
  sel: AiModelSelection,
  options: HarnessOptions,
) {
  const harness = makeHarness(options);
  const decision = await resolveAiReasoningPolicy({
    client: harness.client,
    operation,
    selection: sel,
    label: "test-op",
    logger: harness.logger,
  });
  return { decision, ...harness };
}

const levelOf = (decision: Awaited<ReturnType<typeof resolve>>["decision"]) =>
  decision.policy.reasoning.kind === "level" ? decision.policy.reasoning.level : null;

// ══ 1. The approved Automatic matrix ═══════════════════════════════════════

describe("Automatic resolves to PaperLume's own level, per model and per operation", () => {
  it.each([
    ["gemini-3.5-flash", GEMINI_35, "minimal", "medium"],
    ["gemini-3.6-flash", GEMINI_36, "minimal", "medium"],
    ["gemini-3.7-flash", GEMINI_37, "low", "medium"],
    ["gemini-3.8-flash", GEMINI_38, "low", "medium"],
  ])("%s: analyze -> %s, suggest -> %s", async (model, row, analyze, suggest) => {
    const sel = selection("google", model);
    const a = await resolve("analyze", sel, { row });
    const s = await resolve("suggest", sel, { row });

    expect(levelOf(a.decision)).toBe(analyze);
    expect(a.decision.source).toBe("automatic");
    expect(a.decision.reason).toBeNull();
    expect(levelOf(s.decision)).toBe(suggest);
    expect(s.decision.source).toBe("automatic");
    expect(s.decision.reason).toBeNull();

    // No warning on the healthy path: Automatic is the ordinary state.
    expect(a.warns).toEqual([]);
    expect(s.warns).toEqual([]);
  });

  // FUTURE catalog rows. No `anthropic/*` or `openai/*` row exists today, so
  // these can only be reached once a separately authorized migration seeds one.
  // They are here because the policy layer must be model-shaped rather than
  // Google-shaped BEFORE that migration, not after it.
  it.each([
    ["claude-sonnet-5", SONNET_5, "off", "medium"],
    ["gpt-5.6-terra", TERRA, "none", "medium"],
  ])("future %s: analyze -> %s, suggest -> %s", async (model, row, analyze, suggest) => {
    const sel = selection(row.provider, model);
    expect(levelOf((await resolve("analyze", sel, { row })).decision)).toBe(analyze);
    expect(levelOf((await resolve("suggest", sel, { row })).decision)).toBe(suggest);
  });

  it("gives Analyze the cheaper level and Suggest the higher one, on every model", async () => {
    // The shape of the whole matrix, stated once: organization suggestions
    // weigh a library, Analyze extracts three fields from one abstract.
    for (const row of [GEMINI_35, GEMINI_36, GEMINI_37, GEMINI_38, SONNET_5, TERRA]) {
      const sel = selection(row.provider, row.provider_model);
      const analyze = levelOf((await resolve("analyze", sel, { row })).decision);
      const suggest = levelOf((await resolve("suggest", sel, { row })).decision);
      expect(suggest).toBe("medium");
      expect(analyze).not.toBe(suggest);
      expect(row.reasoning_levels.indexOf(analyze!)).toBeLessThan(
        row.reasoning_levels.indexOf(suggest!),
      );
    }
  });

  it("resolves by (provider, provider_model), the catalog's UNIQUE key", async () => {
    // Not by id: PaperLume's SYSTEM DEFAULT comes from the GEMINI_MODEL
    // environment and has no catalog id at all, so an id lookup would leave the
    // most common request in the repository with no Automatic policy.
    const { queries } = await resolve("analyze", selection("google", "gemini-3.8-flash"), {
      row: GEMINI_38,
    });
    expect(queries).toEqual([
      {
        table: "ai_model_catalog",
        columns:
          "provider,provider_model,reasoning_levels," +
          "auto_analyze_reasoning_level,auto_suggest_reasoning_level",
        filters: [
          ["provider", "google"],
          ["provider_model", "gemini-3.8-flash"],
        ],
      },
    ]);
  });

  it("works identically for the system default, which has no catalog id", async () => {
    const sel = selection("google", "gemini-3.5-flash", {
      source: "system_default",
      fallbackReason: "no_preference",
    });
    const { decision } = await resolve("analyze", sel, { row: GEMINI_35 });
    expect(levelOf(decision)).toBe("minimal");
    expect(decision.source).toBe("automatic");
  });
});

// ══ 2. Manual overrides Automatic, for BOTH operations ═════════════════════

describe("a manual level overrides Automatic on both operations", () => {
  it.each([
    ["google", GEMINI_35, "high"],
    ["google", GEMINI_38, "low"],
    ["anthropic", SONNET_5, "low"],
    ["anthropic", SONNET_5, "max"],
    ["openai", TERRA, "max"],
    ["openai", TERRA, "none"],
  ])("%s %s -> %s on analyze AND suggest", async (_provider, row, level) => {
    const sel = selection(row.provider, row.provider_model, {
      reasoningPreference: level as AiReasoningLevel,
    });
    const a = await resolve("analyze", sel, { row });
    const s = await resolve("suggest", sel, { row });

    expect(levelOf(a.decision)).toBe(level);
    expect(levelOf(s.decision)).toBe(level);
    expect(a.decision.source).toBe("manual");
    expect(s.decision.source).toBe("manual");
    expect(a.decision.reason).toBeNull();
    expect(a.warns).toEqual([]);
  });

  it("is one control, not two: the operation is ignored on the manual path", async () => {
    // The product decision this test pins. Analyze and Suggest have DIFFERENT
    // Automatic levels; a manual choice collapses that difference on purpose.
    const sel = selection("google", "gemini-3.5-flash", { reasoningPreference: "medium" });
    for (const operation of ["analyze", "suggest"] as const) {
      const { decision } = await resolve(operation, sel, { row: GEMINI_35 });
      expect(levelOf(decision)).toBe("medium");
    }
  });

  it("ignores a manual level when model selection FELL BACK", async () => {
    // A manual level was chosen for one specific model. On a fallback the model
    // being called is not that model, so Automatic is the honest answer. The
    // model layer already nulls the preference; this proves the policy layer
    // does not reinstate it even if handed one.
    const sel = selection("google", "gemini-3.5-flash", {
      source: "system_default",
      fallbackReason: "model_disabled",
      reasoningPreference: "high",
    });
    const { decision, warns } = await resolve("analyze", sel, { row: GEMINI_35 });
    expect(levelOf(decision)).toBe("minimal");
    expect(decision.source).toBe("automatic");
    expect(decision.reason).toBeNull();
    expect(warns).toEqual([]);
  });
});

// ══ 3. A saved level the model no longer supports ══════════════════════════

describe("an invalid saved manual level", () => {
  const sel = selection("google", "gemini-3.8-flash", { reasoningPreference: "minimal" });

  it("is never sent", async () => {
    // `minimal` is canonical and real — and Gemini 3.8 Flash rejects it with a
    // 400. Sending it would cost the user a quota unit for a failed request.
    const { decision } = await resolve("analyze", sel, { row: GEMINI_38 });
    expect(levelOf(decision)).not.toBe("minimal");
  });

  it("falls back to THAT MODEL's Automatic policy, not to a provider default", async () => {
    const analyze = await resolve("analyze", sel, { row: GEMINI_38 });
    const suggest = await resolve("suggest", sel, { row: GEMINI_38 });
    expect(levelOf(analyze.decision)).toBe("low");
    expect(levelOf(suggest.decision)).toBe("medium");
    expect(analyze.decision.source).toBe("automatic");
    expect(analyze.decision.policy.reasoning.kind).toBe("level");
  });

  it("emits exactly one bounded, non-sensitive warning", async () => {
    const { warns } = await resolve("analyze", sel, { row: GEMINI_38 });
    expect(warns).toEqual([
      "test-op reasoning_policy_fallback reason=manual_level_unsupported " +
        "provider=google model=gemini-3.8-flash",
    ]);
  });

  it("writes nothing — the runtime path does not own the user's settings", async () => {
    // `rpc` throws in the harness and the client interface has no insert,
    // update, upsert or delete, so a write is unexpressible rather than merely
    // absent. A stale choice is corrected by a Settings visit, not behind the
    // user's back mid-request.
    const { queries } = await resolve("analyze", sel, { row: GEMINI_38 });
    expect(queries.every((q) => q.table === "ai_model_catalog")).toBe(true);
    expect(queries).toHaveLength(1);
  });
});

// ══ 4. Unusable metadata — the fail-open compatibility path ════════════════

describe("unusable policy metadata degrades to provider_default", () => {
  const sel = selection("google", "gemini-3.5-flash");

  it.each([
    ["a catalog read error", { row: null, error: { message: "boom" } }, "catalog_lookup_failed"],
    ["a throwing client", { throws: true }, "catalog_lookup_failed"],
    ["a missing catalog row", { row: null }, "metadata_missing"],
    [
      "a malformed level list",
      { row: { ...GEMINI_35, reasoning_levels: "minimal,low" } },
      "invalid_metadata",
    ],
    [
      "an uncanonical member in the level list",
      { row: { ...GEMINI_35, reasoning_levels: ["minimal", "ludicrous"] } },
      "invalid_metadata",
    ],
    [
      "an Automatic level its own model does not support",
      { row: { ...GEMINI_38, auto_analyze_reasoning_level: "minimal" } },
      "invalid_metadata",
    ],
    [
      "an uncanonical Automatic level",
      { row: { ...GEMINI_35, auto_analyze_reasoning_level: "ludicrous" } },
      "invalid_metadata",
    ],
    [
      "a row the filter did not actually filter",
      { row: { ...GEMINI_35, provider_model: "some-other-model" } },
      "invalid_metadata",
    ],
    [
      "no stated Automatic policy for this operation",
      { row: { ...GEMINI_35, auto_analyze_reasoning_level: null } },
      "no_automatic_policy",
    ],
  ])("on %s", async (_label, options, reason) => {
    const { decision, warns } = await resolve("analyze", sel, options as HarnessOptions);

    expect(decision.policy.reasoning).toEqual({ kind: "provider_default" });
    expect(decision.source).toBe("provider_default_fallback");
    expect(decision.reason).toBe(reason);
    // Exactly one bounded line, naming only public metadata.
    expect(warns).toEqual([
      `test-op reasoning_policy_fallback reason=${reason} provider=google model=gemini-3.5-flash`,
    ]);
  });

  it("is NOT the same thing as Automatic, and never reports itself as one", async () => {
    // The distinction the whole design rests on. `provider_default` means
    // PaperLume chose NOTHING and the adapter omits the parameter; Automatic
    // means PaperLume chose a level and sent it. Collapsing them would let a
    // metadata outage be read as a product decision.
    const broken = await resolve("analyze", sel, { row: null });
    const healthy = await resolve("analyze", sel, { row: GEMINI_35 });
    expect(broken.decision.source).not.toBe(healthy.decision.source);
    expect(broken.decision.policy.reasoning.kind).toBe("provider_default");
    expect(healthy.decision.policy.reasoning.kind).toBe("level");
  });

  it("never fails the request — the feature survives a metadata outage", async () => {
    for (const options of [{ throws: true }, { row: null }, { error: { message: "x" } }]) {
      const { decision } = await resolve("suggest", sel, options as HarnessOptions);
      expect(decision.policy.maxOutputTokens).toBe(AI_OPERATION_MAX_OUTPUT_TOKENS.suggest);
    }
  });
});

// ══ 5. Output ceilings ═════════════════════════════════════════════════════

describe("the per-operation output ceiling", () => {
  it("is 4096 for analyze and 8192 for suggest", () => {
    expect(AI_OPERATION_MAX_OUTPUT_TOKENS.analyze).toBe(4096);
    expect(AI_OPERATION_MAX_OUTPUT_TOKENS.suggest).toBe(8192);
  });

  it("rides on every decision, whatever the reasoning outcome", async () => {
    const sel = selection("google", "gemini-3.5-flash");
    for (const [operation, expected] of [
      ["analyze", 4096],
      ["suggest", 8192],
    ] as const) {
      for (const options of [{ row: GEMINI_35 }, { row: null }]) {
        const { decision } = await resolve(operation, sel, options);
        expect(decision.policy.maxOutputTokens).toBe(expected);
      }
    }
  });
});

// ══ 6. The bounded log line ════════════════════════════════════════════════

describe("formatReasoningPolicyLog", () => {
  it("names the operation, the decider, the concrete level and the ceiling", () => {
    expect(
      formatReasoningPolicyLog("analyze-paper", "analyze", {
        policy: { reasoning: { kind: "level", level: "minimal" }, maxOutputTokens: 4096 },
        source: "automatic",
        reason: null,
      }),
    ).toBe(
      "analyze-paper reasoning_policy operation=analyze source=automatic " +
        "level=minimal max_output_tokens=4096",
    );
  });

  it("prints provider_default rather than a level on the fail-open path", () => {
    // So a reader can never mistake the emergency path for a level PaperLume
    // chose — which is the one thing this log line must not be ambiguous about.
    expect(
      formatReasoningPolicyLog("suggest-organization", "suggest", {
        policy: { reasoning: { kind: "provider_default" }, maxOutputTokens: 8192 },
        source: "provider_default_fallback",
        reason: "metadata_missing",
      }),
    ).toBe(
      "suggest-organization reasoning_policy operation=suggest " +
        "source=provider_default_fallback level=provider_default max_output_tokens=8192",
    );
  });

  it("carries nothing sensitive, on any decision this module can produce", async () => {
    const sel = selection("google", "gemini-3.5-flash", { reasoningPreference: "high" });
    for (const options of [{ row: GEMINI_35 }, { row: null }, { row: GEMINI_38 }]) {
      const { decision, warns } = await resolve("analyze", sel, options as HarnessOptions);
      const line = formatReasoningPolicyLog("analyze-paper", "analyze", decision);
      for (const text of [...warns, line]) {
        // No email, no UUID-shaped identifier, and nothing credential-shaped.
        // `max_output_tokens` is a legitimate field name in this line, so the
        // credential check targets credential SHAPES rather than the substring
        // "token".
        expect(text).not.toMatch(/@/);
        expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
        expect(text).not.toMatch(/api[_-]?key|secret|password|bearer|authorization/i);
        expect(text).not.toMatch(/\b(sk|AIza)[A-Za-z0-9_-]{8,}/);
      }
    }
  });
});
