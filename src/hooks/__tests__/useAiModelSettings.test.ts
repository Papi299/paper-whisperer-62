import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));

import { useAiModelSettings, PAPERLUME_DEFAULT_VALUE } from "../useAiModelSettings";
import { queryKeys } from "@/lib/queryKeys";

const USER = "user-1";

/**
 * Catalog fixtures use the real catalog model ids on purpose: concrete ids
 * belong in a fixture, and the point of the suite is that the *hook* never
 * contains them. Nothing in `useAiModelSettings.ts` names a model.
 *
 * 3.5 and 3.6 come from migration `20260902120000`; 3.7 and 3.8 were added by
 * `20260903120000` (AI-MODEL-SELECTION-001D, C35) with **no change to the hook**
 * — which is exactly what the four-option assertions below demonstrate.
 */
const GEMINI_35 = {
  id: "google/gemini-3.5-flash",
  provider: "google",
  display_name: "Gemini 3.5 Flash",
  enabled: true,
  selectable: true,
  sort_order: 10,
  // AI-MULTI-PROVIDER-001C reasoning metadata, exactly as migration
  // `20260912120000` seeds it — including `reasoning_selectable: false`, the
  // staged state every Production row is in.
  reasoning_levels: ["minimal", "low", "medium", "high"],
  auto_analyze_reasoning_level: "minimal",
  auto_suggest_reasoning_level: "medium",
  reasoning_selectable: false,
};
const GEMINI_36 = {
  id: "google/gemini-3.6-flash",
  provider: "google",
  display_name: "Gemini 3.6 Flash",
  enabled: true,
  selectable: true,
  sort_order: 20,
  // AI-MULTI-PROVIDER-001C reasoning metadata, exactly as migration
  // `20260912120000` seeds it — including `reasoning_selectable: false`, the
  // staged state every Production row is in.
  reasoning_levels: ["minimal", "low", "medium", "high"],
  auto_analyze_reasoning_level: "minimal",
  auto_suggest_reasoning_level: "medium",
  reasoning_selectable: false,
};
const GEMINI_37 = {
  id: "google/gemini-3.7-flash",
  provider: "google",
  display_name: "Gemini 3.7 Flash",
  enabled: true,
  selectable: true,
  sort_order: 30,
  // AI-MULTI-PROVIDER-001C reasoning metadata, exactly as migration
  // `20260912120000` seeds it — including `reasoning_selectable: false`, the
  // staged state every Production row is in.
  reasoning_levels: ["low", "medium", "high"],
  auto_analyze_reasoning_level: "low",
  auto_suggest_reasoning_level: "medium",
  reasoning_selectable: false,
};
const GEMINI_38 = {
  id: "google/gemini-3.8-flash",
  provider: "google",
  display_name: "Gemini 3.8 Flash",
  enabled: true,
  selectable: true,
  sort_order: 40,
  // AI-MULTI-PROVIDER-001C reasoning metadata, exactly as migration
  // `20260912120000` seeds it — including `reasoning_selectable: false`, the
  // staged state every Production row is in.
  reasoning_levels: ["low", "medium", "high"],
  auto_analyze_reasoning_level: "low",
  auto_suggest_reasoning_level: "medium",
  reasoning_selectable: false,
};

type Result = { data: unknown; error: unknown };

/** `.select().order().order()` — thenable at the end of the chain. */
function catalogStub(result: Result) {
  const stub = {
    // Parameters are declared so the recorded calls stay typed: the projection
    // string and the ordering keys are the things this suite asserts on.
    select: vi.fn((_columns: string) => stub),
    order: vi.fn((_column: string, _opts?: { ascending?: boolean }) => stub),
    then: (resolve: (value: Result) => unknown) => Promise.resolve(result).then(resolve),
  };
  return stub;
}

/** `.select().eq().maybeSingle()`. */
function preferenceStub(result: Result) {
  const stub = {
    select: vi.fn((_columns: string) => stub),
    eq: vi.fn((_column: string, _value: string) => stub),
    maybeSingle: vi.fn(async () => result),
  };
  return stub;
}

type Stubs = {
  catalog: ReturnType<typeof catalogStub>;
  preference: ReturnType<typeof preferenceStub>;
  /** Every table name `supabase.from` was called with, in order. */
  tablesTouched: string[];
};

function mockTables(catalog: Result, preference: Result): Stubs {
  const stubs: Stubs = {
    catalog: catalogStub(catalog),
    preference: preferenceStub(preference),
    tablesTouched: [],
  };
  mockFrom.mockImplementation((table: string) => {
    stubs.tablesTouched.push(table);
    if (table === "ai_model_catalog") return stubs.catalog;
    if (table === "user_ai_preferences") return stubs.preference;
    throw new Error(`unexpected table read: ${table}`);
  });
  return stubs;
}

/**
 * The normalized shape the hook projects a Gemini fixture row into.
 *
 * A helper rather than four literals, so the reasoning metadata is asserted
 * from the fixture rather than retyped — a projection that dropped a field
 * would fail here instead of quietly agreeing with a copy of itself.
 */
function optionOf(row: {
  id: string;
  provider: string;
  display_name: string;
  enabled: boolean;
  selectable: boolean;
  reasoning_levels: string[];
  auto_analyze_reasoning_level: string | null;
  auto_suggest_reasoning_level: string | null;
  reasoning_selectable: boolean;
}) {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    enabled: row.enabled,
    selectable: row.selectable,
    reasoningLevels: row.reasoning_levels,
    automaticAnalyzeReasoningLevel: row.auto_analyze_reasoning_level,
    automaticSuggestReasoningLevel: row.auto_suggest_reasoning_level,
    reasoningSelectable: row.reasoning_selectable,
  };
}

function rows(...list: unknown[]): Result {
  return { data: list, error: null };
}
function prefRow(modelId: string | null, reasoningLevel: string | null = null): Result {
  return {
    data:
      modelId === null
        ? null
        : { preferred_model_id: modelId, preferred_reasoning_level: reasoningLevel },
    error: null,
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}
function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

async function renderLoaded(client = makeClient()) {
  const view = renderHook(() => useAiModelSettings(USER), { wrapper: wrapper(client) });
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return { ...view, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useAiModelSettings — reads", () => {
  it("issues no query at all without a userId", () => {
    mockTables(rows(), prefRow(null));
    const { result } = renderHook(() => useAiModelSettings(undefined), {
      wrapper: wrapper(makeClient()),
    });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it("issues no query while the consuming surface is closed", () => {
    mockTables(rows(), prefRow(null));
    renderHook(() => useAiModelSettings(USER, { enabled: false }), {
      wrapper: wrapper(makeClient()),
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("reads only the approved catalog columns — never provider_model", async () => {
    const stubs = mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
    await renderLoaded();

    expect(stubs.catalog.select).toHaveBeenCalledWith(
      "id, provider, display_name, enabled, selectable, sort_order, " +
        "reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level, " +
        "reasoning_selectable",
    );
    const projection = stubs.catalog.select.mock.calls[0][0];
    expect(projection).not.toContain("provider_model");
    expect(projection).not.toContain("*");
  });

  it("orders the catalog deterministically by sort_order then id", async () => {
    const stubs = mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
    await renderLoaded();

    expect(stubs.catalog.order.mock.calls).toEqual([
      ["sort_order", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("scopes the preference read to the authenticated user id and reads one row", async () => {
    const stubs = mockTables(rows(GEMINI_35), prefRow(null));
    await renderLoaded();

    expect(stubs.preference.select).toHaveBeenCalledWith(
      "preferred_model_id, preferred_reasoning_level",
    );
    expect(stubs.preference.eq).toHaveBeenCalledWith("user_id", USER);
    expect(stubs.preference.maybeSingle).toHaveBeenCalled();
  });

  it("scopes both caches by user id", async () => {
    const client = makeClient();
    mockTables(rows(GEMINI_35), prefRow(null));
    await renderLoaded(client);

    const keys = client.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toContainEqual([...queryKeys.aiModelSettings.catalog(USER)]);
    expect(keys).toContainEqual([...queryKeys.aiModelSettings.preference(USER)]);
  });

  it("represents a missing preference row as an explicit 'none', distinct from failure", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
    const { result } = await renderLoaded();

    expect(result.current.isError).toBe(false);
    expect(result.current.saved).toEqual({ status: "none" });
  });

  it("never reports a failed preference read as 'no preference'", async () => {
    mockTables(rows(GEMINI_35), { data: null, error: { message: "boom" } });
    const { result } = await renderLoaded();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.saved).toBeNull();
  });

  it("never reports a failed catalog read as an empty model list with no preference", async () => {
    mockTables({ data: null, error: { message: "boom" } }, prefRow(null));
    const { result } = await renderLoaded();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.saved).toBeNull();
    expect(result.current.options).toEqual([]);
  });

  // AI-MODEL-SELECTION-001D. A catalog response carrying four supported,
  // enabled, selectable Google rows must produce four choices with their display
  // names and ids intact. The hook is unmodified; only the server response grew.
  it("exposes every supported catalog row, including models it has never heard of", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36, GEMINI_37, GEMINI_38), prefRow(null));
    const { result } = await renderLoaded();

    expect(result.current.options).toEqual([
      optionOf(GEMINI_35),
      optionOf(GEMINI_36),
      optionOf(GEMINI_37),
      optionOf(GEMINI_38),
    ]);
  });

  // The same filtering rules apply to the new rows as to the old ones — there is
  // no per-model exemption anywhere in the hook.
  it("filters a newly added model out on the same rules as any other", async () => {
    mockTables(
      rows(
        GEMINI_35,
        { ...GEMINI_37, enabled: false },
        { ...GEMINI_38, selectable: false },
      ),
      prefRow(null),
    );
    const { result } = await renderLoaded();

    expect(result.current.options.map((o) => o.id)).toEqual([GEMINI_35.id]);
  });

  it("resolves a saved 3.8 preference to an active saved model", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36, GEMINI_37, GEMINI_38), prefRow(GEMINI_38.id));
    const { result } = await renderLoaded();

    expect(result.current.saved).toEqual({
      status: "active",
      modelId: GEMINI_38.id,
      displayName: "Gemini 3.8 Flash",
      selectable: true,
      option: optionOf(GEMINI_38),
    });
    // No manual level saved — Automatic.
    expect(result.current.savedReasoning).toEqual({ status: "automatic" });
  });

  it("offers only enabled + selectable + supported-provider rows, in catalog order", async () => {
    mockTables(
      rows(
        GEMINI_35,
        GEMINI_36,
        { ...GEMINI_35, id: "google/disabled", display_name: "Disabled", enabled: false },
        { ...GEMINI_35, id: "google/locked", display_name: "Locked", selectable: false },
        {
          ...GEMINI_35,
          id: "azure/some-model",
          provider: "azure",
          display_name: "Azure",
        },
      ),
      prefRow(null),
    );
    const { result } = await renderLoaded();

    expect(result.current.options.map((o) => o.id)).toEqual([
      GEMINI_35.id,
      GEMINI_36.id,
    ]);
  });

  it("WOULD offer an Anthropic or OpenAI row — AI-MULTI-PROVIDER-001C", async () => {
    // 001B added real Anthropic and OpenAI adapter modules and registered
    // neither, so this filter excluded both. 001C registered them, so the
    // filter moved with the runtime: a row for either provider would now be
    // offered, because the runtime really can route it.
    //
    // These are FIXTURES and nothing else. No `anthropic/*` or `openai/*` row
    // exists in `ai_model_catalog`, so this adds no option to anyone's Settings
    // today — what it changes is that the UI would no longer silently hide a
    // model the server had been told to serve.
    mockTables(
      rows(
        GEMINI_35,
        {
          ...GEMINI_35,
          id: "anthropic/claude-sonnet-5",
          provider: "anthropic",
          display_name: "Claude Sonnet 5",
          reasoning_levels: ["off", "low", "medium", "high", "xhigh", "max"],
          auto_analyze_reasoning_level: "off",
        },
        {
          ...GEMINI_35,
          id: "openai/gpt-5.6-terra",
          provider: "openai",
          display_name: "GPT-5.6 Terra",
          reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max"],
          auto_analyze_reasoning_level: "none",
        },
      ),
      prefRow(null),
    );
    const { result } = await renderLoaded();

    expect(result.current.options.map((o) => o.id)).toEqual([
      GEMINI_35.id,
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.6-terra",
    ]);
  });

  it("still offers nothing from a provider the runtime cannot route", async () => {
    mockTables(
      rows(GEMINI_35, {
        ...GEMINI_35,
        id: "azure/some-model",
        provider: "azure",
        display_name: "Azure Model",
      }),
      prefRow(null),
    );
    const { result } = await renderLoaded();
    expect(result.current.options.map((o) => o.id)).toEqual([GEMINI_35.id]);
  });

  it("reports a saved model from an unroutable provider as unavailable", async () => {
    mockTables(
      rows({
        ...GEMINI_35,
        id: "azure/some-model",
        provider: "azure",
        display_name: "Azure Model",
      }),
      prefRow("azure/some-model"),
    );
    const { result } = await renderLoaded();

    expect(result.current.saved).toEqual({
      status: "unavailable",
      modelId: "azure/some-model",
      displayName: "Azure Model",
    });
    // An unavailable model carries no reasoning choice in force.
    expect(result.current.savedReasoning).toEqual({ status: "automatic" });
  });

  it("resolves an explicit preference to an active saved model", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(GEMINI_36.id));
    const { result } = await renderLoaded();

    expect(result.current.saved).toEqual({
      status: "active",
      modelId: GEMINI_36.id,
      displayName: "Gemini 3.6 Flash",
      selectable: true,
      option: optionOf(GEMINI_36),
    });
  });

  it("keeps an enabled-but-unselectable saved model active, flagged unselectable", async () => {
    const locked = { ...GEMINI_35, selectable: false };
    mockTables(rows(locked, GEMINI_36), prefRow(GEMINI_35.id));
    const { result } = await renderLoaded();

    expect(result.current.saved).toEqual({
      status: "active",
      modelId: GEMINI_35.id,
      displayName: "Gemini 3.5 Flash",
      selectable: false,
      option: optionOf(locked),
    });
    // …and it is not offered as a NEW choice.
    expect(result.current.options.map((o) => o.id)).toEqual([GEMINI_36.id]);
  });

  it("reports a disabled saved model as unavailable (runtime falls back to default)", async () => {
    mockTables(rows({ ...GEMINI_35, enabled: false }, GEMINI_36), prefRow(GEMINI_35.id));
    const { result } = await renderLoaded();

    expect(result.current.saved).toEqual({
      status: "unavailable",
      modelId: GEMINI_35.id,
      displayName: "Gemini 3.5 Flash",
    });
  });

  it("reports a saved model missing from the catalog as unavailable, without a name", async () => {
    mockTables(rows(GEMINI_36), prefRow("google/retired-model"));
    const { result } = await renderLoaded();

    expect(result.current.saved).toEqual({
      status: "unavailable",
      modelId: "google/retired-model",
      displayName: null,
    });
  });

  it("reports a saved unsupported-provider model as unavailable", async () => {
    mockTables(
      rows({ ...GEMINI_35, id: "azure/model", provider: "azure", display_name: "Azure Model" }),
      prefRow("azure/model"),
    );
    const { result } = await renderLoaded();

    expect(result.current.saved).toEqual({
      status: "unavailable",
      modelId: "azure/model",
      displayName: "Azure Model",
    });
  });

  // ── Reasoning preference — AI-MULTI-PROVIDER-001C (C41) ──────────────────

  it("reads a NULL reasoning level as Automatic, distinct from a failed read", async () => {
    mockTables(rows(GEMINI_35), prefRow(GEMINI_35.id, null));
    const { result } = await renderLoaded();
    expect(result.current.savedReasoning).toEqual({ status: "automatic" });
    expect(result.current.isError).toBe(false);
  });

  it("resolves a saved manual level the model still supports", async () => {
    mockTables(rows(GEMINI_35), prefRow(GEMINI_35.id, "high"));
    const { result } = await renderLoaded();
    expect(result.current.savedReasoning).toEqual({ status: "manual", level: "high" });
  });

  it("reports a saved level the model no longer supports as unsupported", async () => {
    // `minimal` is real, canonical and genuinely unavailable on 3.7/3.8 — the
    // exact shape of the state a catalog change or a hand-written row produces.
    // The runtime independently falls back to that model's Automatic policy and
    // never sends the value; the UI reports the truth and offers the way back.
    mockTables(rows(GEMINI_38), prefRow(GEMINI_38.id, "minimal"));
    const { result } = await renderLoaded();
    expect(result.current.savedReasoning).toEqual({ status: "unsupported", level: "minimal" });
  });

  it("fails closed to Automatic on a reasoning value this build cannot name", async () => {
    mockTables(rows(GEMINI_35), prefRow(GEMINI_35.id, "ludicrous"));
    const { result } = await renderLoaded();
    expect(result.current.savedReasoning).toEqual({ status: "automatic" });
  });

  it("never reports a manual level while the account is on PaperLume default", async () => {
    // There is no row to hold one, by construction; this pins the consequence.
    mockTables(rows(GEMINI_35), prefRow(null));
    const { result } = await renderLoaded();
    expect(result.current.saved).toEqual({ status: "none" });
    expect(result.current.savedReasoning).toEqual({ status: "automatic" });
  });

  it("leaves reasoning unresolved — not Automatic — when a read fails", async () => {
    mockTables({ data: null, error: { message: "boom" } }, prefRow(null));
    const { result } = await renderLoaded();
    expect(result.current.isError).toBe(true);
    expect(result.current.saved).toBeNull();
    expect(result.current.savedReasoning).toBeNull();
  });

  it("projects each model's own reasoning metadata, from the catalog alone", async () => {
    mockTables(rows(GEMINI_35, GEMINI_38), prefRow(null));
    const { result } = await renderLoaded();
    const [g35, g38] = result.current.options;
    expect(g35.reasoningLevels).toEqual(["minimal", "low", "medium", "high"]);
    expect(g35.automaticAnalyzeReasoningLevel).toBe("minimal");
    expect(g35.automaticSuggestReasoningLevel).toBe("medium");
    expect(g38.reasoningLevels).toEqual(["low", "medium", "high"]);
    expect(g38.automaticAnalyzeReasoningLevel).toBe("low");
    // The staged state: no model offers a manual choice yet.
    expect(result.current.options.every((o) => o.reasoningSelectable === false)).toBe(true);
  });

  it("drops a catalog level this build cannot name, rather than offering it", async () => {
    mockTables(
      rows({ ...GEMINI_35, reasoning_levels: ["low", "ludicrous", "high"] }),
      prefRow(null),
    );
    const { result } = await renderLoaded();
    expect(result.current.options[0].reasoningLevels).toEqual(["low", "high"]);
  });
});

describe("useAiModelSettings — writes", () => {
  it("saves through set_current_user_ai_model with only p_model_id", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
    mockRpc.mockResolvedValue({
      data: [{ saved: true, reason: "ok", display_name: "Gemini 3.6 Flash" }],
      error: null,
    });
    const { result } = await renderLoaded();

    await act(async () => {
      result.current.saveModel(GEMINI_36.id);
    });
    await waitFor(() => expect(mockRpc).toHaveBeenCalled());

    expect(mockRpc).toHaveBeenCalledWith("set_current_user_ai_model", {
      p_model_id: GEMINI_36.id,
    });
    // Exactly one argument object, and no user id anywhere in it.
    const args = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(["p_model_id"]);
    expect(JSON.stringify(args)).not.toContain(USER);
  });

  it("saves an explicit Gemini 3.5 pin with that exact catalog id", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(GEMINI_36.id));
    mockRpc.mockResolvedValue({
      data: [{ saved: true, reason: "ok", display_name: "Gemini 3.5 Flash" }],
      error: null,
    });
    const { result } = await renderLoaded();

    await act(async () => {
      result.current.saveModel(GEMINI_35.id);
    });
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith("set_current_user_ai_model", {
        p_model_id: GEMINI_35.id,
      }),
    );
  });

  // The exact catalog id reaches the setter for each newly approved model — not
  // a bare provider model string, and not a value the hook invented.
  it.each([
    ["Gemini 3.7 Flash", GEMINI_37],
    ["Gemini 3.8 Flash", GEMINI_38],
  ])("saves %s through set_current_user_ai_model with that exact catalog id", async (label, model) => {
    mockTables(rows(GEMINI_35, GEMINI_36, GEMINI_37, GEMINI_38), prefRow(null));
    mockRpc.mockResolvedValue({
      data: [{ saved: true, reason: "ok", display_name: label }],
      error: null,
    });
    const { result } = await renderLoaded();

    await act(async () => {
      result.current.saveModel(model.id);
    });
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith("set_current_user_ai_model", { p_model_id: model.id }),
    );
    // One argument object, and still no user id in it.
    const args = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(["p_model_id"]);
    expect(JSON.stringify(args)).not.toContain(USER);
  });

  it("refetches the authoritative preference after a successful save", async () => {
    const client = makeClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
    mockRpc.mockResolvedValue({
      data: [{ saved: true, reason: "ok", display_name: "Gemini 3.6 Flash" }],
      error: null,
    });
    const { result } = await renderLoaded(client);

    await act(async () => {
      result.current.saveModel(GEMINI_36.id);
    });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.aiModelSettings.preference(USER),
      }),
    );
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "AI model updated" }),
    );
  });

  it("refuses to send the Paperlume-default sentinel to the setter", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
    const { result } = await renderLoaded();

    await act(async () => {
      result.current.saveModel(PAPERLUME_DEFAULT_VALUE);
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not update AI model" }),
      ),
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("clears through clear_current_user_ai_model with no arguments", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(GEMINI_36.id));
    mockRpc.mockResolvedValue({ data: [{ cleared: true, reason: "ok" }], error: null });
    const { result } = await renderLoaded();

    await act(async () => {
      result.current.clearModel();
    });
    await waitFor(() => expect(mockRpc).toHaveBeenCalled());

    expect(mockRpc).toHaveBeenCalledWith("clear_current_user_ai_model");
    // No second argument at all — no user id can be smuggled in.
    expect(mockRpc.mock.calls[0]).toHaveLength(1);
  });

  it("treats an idempotent no_preference clear as a successful default state", async () => {
    const client = makeClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
    mockRpc.mockResolvedValue({ data: [{ cleared: false, reason: "no_preference" }], error: null });
    const { result } = await renderLoaded(client);

    await act(async () => {
      result.current.clearModel();
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Using Paperlume default" }),
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.aiModelSettings.preference(USER),
    });
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("never writes to either table directly", async () => {
    const stubs = mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
    mockRpc.mockResolvedValue({
      data: [{ saved: true, reason: "ok", display_name: "Gemini 3.6 Flash" }],
      error: null,
    });
    const { result } = await renderLoaded();

    await act(async () => {
      result.current.saveModel(GEMINI_36.id);
    });
    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    await act(async () => {
      result.current.clearModel();
    });

    // Only the two read tables were ever addressed…
    expect(new Set(stubs.tablesTouched)).toEqual(
      new Set(["ai_model_catalog", "user_ai_preferences"]),
    );
    // …and neither builder was ever asked for a write verb.
    for (const stub of [stubs.catalog, stubs.preference] as unknown as Record<string, unknown>[]) {
      for (const verb of ["insert", "update", "upsert", "delete"]) {
        expect(stub[verb]).toBeUndefined();
      }
    }
  });

  it("reads no write verb out of the module source", () => {
    // Resolved from the working directory, not through `new URL(..., import.meta.url)`:
    // jsdom substitutes the global `URL` and resolves a relative reference
    // against the document base, which yields an http: URL `readFileSync`
    // rejects. This matches how SettingsDialog.pubmedActions.test.tsx reads
    // committed source.
    const source = readFileSync(resolve(process.cwd(), "src/hooks/useAiModelSettings.ts"), "utf-8");
    expect(source).not.toMatch(/\.insert\(/);
    expect(source).not.toMatch(/\.update\(/);
    expect(source).not.toMatch(/\.upsert\(/);
    expect(source).not.toMatch(/\.delete\(/);
    // Exactly the two approved RPCs, and no third.
    const rpcNames = [...source.matchAll(/supabase\.rpc\(\s*"([^"]+)"/g)].map((m) => m[1]);
    // Exactly the four approved RPCs, and no fifth. The two reasoning ones were
    // added by AI-MULTI-PROVIDER-001C; `set_current_user_ai_reasoning` is
    // deliberately ungranted in the database, so calling it currently fails —
    // which is why the UI never offers the choice that would call it.
    expect(rpcNames.sort()).toEqual([
      "clear_current_user_ai_model",
      "clear_current_user_ai_reasoning",
      "set_current_user_ai_model",
      "set_current_user_ai_reasoning",
    ]);
  });

  it("keeps the provider-family filter exactly level with the Edge registry", () => {
    // This list mirrors the REGISTERED providers, and must move together with
    // the Edge registry — never ahead of it. The next ordinary Vercel deploy
    // ships this file, so a premature widening here would expose a provider the
    // server cannot route. AI-MULTI-PROVIDER-001C moved both in one task.
    const source = readFileSync(resolve(process.cwd(), "src/hooks/useAiModelSettings.ts"), "utf-8");
    expect(source).toMatch(
      /const SUPPORTED_PROVIDERS: readonly string\[\] = \["google", "anthropic", "openai"\];/,
    );
    // And still no model string anywhere: the catalog is the model allowlist.
    expect(source).not.toMatch(/gemini-3/);
    expect(source).not.toMatch(/claude-sonnet/);
    expect(source).not.toMatch(/gpt-5/);
  });
});

describe("useAiModelSettings — reasoning writes (AI-MULTI-PROVIDER-001C)", () => {
  /** A catalog row whose reasoning control is OPEN — never the case in Production today. */
  const OPEN_35 = { ...GEMINI_35, reasoning_selectable: true };

  it("preserves a compatible level across a model change, with the ordinary toast", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(GEMINI_35.id, "high"));
    mockRpc.mockResolvedValue({
      data: [{ saved: true, reason: "ok", display_name: "Gemini 3.6 Flash", reasoning_reset: false }],
      error: null,
    });
    const { result } = await renderLoaded();

    await act(async () => {
      result.current.saveModel(GEMINI_36.id);
    });

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: "AI model updated",
        description: "Paperlume will use Gemini 3.6 Flash for this account.",
      }),
    );
    // The model setter is still the only call: preservation happened server-side
    // in the same transaction, and the hook did not second-guess it.
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("set_current_user_ai_model", { p_model_id: GEMINI_36.id });
  });

  it("tells the user, in product words, when the server reset reasoning", async () => {
    mockTables(rows(GEMINI_35, GEMINI_38), prefRow(GEMINI_35.id, "minimal"));
    mockRpc.mockResolvedValue({
      data: [{ saved: true, reason: "ok", display_name: "Gemini 3.8 Flash", reasoning_reset: true }],
      error: null,
    });
    const { result } = await renderLoaded();

    await act(async () => {
      result.current.saveModel(GEMINI_38.id);
    });

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: "AI model updated",
        description:
          "Reasoning was reset to Automatic because the new model does not support your " +
          "previous level.",
      }),
    );
    // No provider vocabulary, and the dropped value is not named.
    const description = String(mockToast.mock.calls.at(-1)?.[0]?.description);
    expect(description).not.toMatch(/thinking|effort|minimal/i);
  });

  it("reports no reset when the flag is absent — nothing was reset", async () => {
    // A database that predates the migration returns no `reasoning_reset`.
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(GEMINI_35.id));
    mockRpc.mockResolvedValue({
      data: [{ saved: true, reason: "ok", display_name: "Gemini 3.6 Flash" }],
      error: null,
    });
    const { result } = await renderLoaded();
    await act(async () => {
      result.current.saveModel(GEMINI_36.id);
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(String(mockToast.mock.calls.at(-1)?.[0]?.description)).not.toContain("reset");
  });

  it("never calls the reasoning setter while the account is on PaperLume default", async () => {
    mockTables(rows(OPEN_35), prefRow(null));
    const { result } = await renderLoaded();
    await act(async () => {
      result.current.saveReasoning("high");
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("never calls the reasoning setter while reasoning selection is staged off", async () => {
    // The state of every Production catalog row after the 001C migration.
    mockTables(rows(GEMINI_35), prefRow(GEMINI_35.id));
    const { result } = await renderLoaded();
    await act(async () => {
      result.current.saveReasoning("high");
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("never calls the reasoning setter with a level the model does not list", async () => {
    mockTables(rows({ ...OPEN_35, id: GEMINI_38.id, reasoning_levels: ["low", "medium", "high"] }),
      prefRow(GEMINI_38.id));
    const { result } = await renderLoaded();
    await act(async () => {
      result.current.saveReasoning("minimal");
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("saves through set_current_user_ai_reasoning with only p_reasoning_level", async () => {
    mockTables(rows(OPEN_35), prefRow(GEMINI_35.id));
    mockRpc.mockResolvedValue({
      data: [{ saved: true, reason: "ok", preferred_model_id: GEMINI_35.id, preferred_reasoning_level: "high" }],
      error: null,
    });
    const { result } = await renderLoaded();
    await act(async () => {
      result.current.saveReasoning("high");
    });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    // No user id, no model id, no provider: the server derives all of it.
    expect(mockRpc).toHaveBeenCalledWith("set_current_user_ai_reasoning", {
      p_reasoning_level: "high",
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Reasoning level updated" }),
      ),
    );
  });

  it.each([
    ["reasoning_not_selectable"],
    ["reasoning_level_not_supported"],
    ["model_required"],
    ["model_disabled"],
    ["model_missing"],
  ])("reports '%s' as a reasoning problem, never as 'pick another model'", async (reason) => {
    mockTables(rows(OPEN_35), prefRow(GEMINI_35.id));
    mockRpc.mockResolvedValue({ data: [{ saved: false, reason }], error: null });
    const { result } = await renderLoaded();
    await act(async () => {
      result.current.saveReasoning("high");
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: "Reasoning unchanged",
        description:
          "That reasoning level is not available for your current model. Refresh and try again.",
        variant: "destructive",
      }),
    );
  });

  it.each([["missing_entitlement"], ["not_entitled"], ["inactive_entitlement"]])(
    "reports '%s' as an access problem",
    async (reason) => {
      mockTables(rows(OPEN_35), prefRow(GEMINI_35.id));
      mockRpc.mockResolvedValue({ data: [{ saved: false, reason }], error: null });
      const { result } = await renderLoaded();
      await act(async () => {
        result.current.saveReasoning("high");
      });
      await waitFor(() =>
        expect(mockToast).toHaveBeenCalledWith({
          title: "Reasoning unchanged",
          description: "Reasoning selection is not available for this account.",
          variant: "destructive",
        }),
      );
    },
  );

  it("never reports a success for a missing or malformed setter row", async () => {
    mockTables(rows(OPEN_35), prefRow(GEMINI_35.id));
    mockRpc.mockResolvedValue({ data: [], error: null });
    const { result } = await renderLoaded();
    await act(async () => {
      result.current.saveReasoning("high");
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Reasoning level updated" }),
    );
  });

  it("clears reasoning through clear_current_user_ai_reasoning, with no arguments", async () => {
    // Deliberately allowed even while reasoning selection is staged off:
    // leaving a manual level must never be blocked by the flag that controls
    // entering one.
    mockTables(rows(GEMINI_35), prefRow(GEMINI_35.id, "high"));
    mockRpc.mockResolvedValue({ data: [{ cleared: true, reason: "ok" }], error: null });
    const { result } = await renderLoaded();
    await act(async () => {
      result.current.clearReasoning();
    });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("clear_current_user_ai_reasoning"));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: "Using automatic reasoning",
        description: "Paperlume will choose a reasoning level for each task.",
      }),
    );
  });

  it("treats an idempotent clear ('no_reasoning_preference') as success", async () => {
    mockTables(rows(GEMINI_35), prefRow(GEMINI_35.id));
    mockRpc.mockResolvedValue({
      data: [{ cleared: false, reason: "no_reasoning_preference" }],
      error: null,
    });
    const { result } = await renderLoaded();
    await act(async () => {
      result.current.clearReasoning();
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Using automatic reasoning" }),
      ),
    );
  });
});

describe("useAiModelSettings — structured rejections", () => {
  const entitlementReasons = ["missing_entitlement", "not_entitled", "inactive_entitlement"];
  const catalogReasons = ["unknown_model", "model_disabled", "model_not_selectable"];

  for (const reason of entitlementReasons) {
    it(`fails closed on '${reason}': access is refreshed and no success is reported`, async () => {
      const client = makeClient();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
      mockRpc.mockResolvedValue({ data: [{ saved: false, reason }], error: null });
      const { result } = await renderLoaded(client);

      await act(async () => {
        result.current.saveModel(GEMINI_36.id);
      });
      await waitFor(() => expect(mockToast).toHaveBeenCalled());

      expect(mockToast).toHaveBeenCalledWith({
        title: "Model unchanged",
        description: "AI model selection is not available for this account.",
        variant: "destructive",
      });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.access.current(USER) });
      expect(mockToast).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "AI model updated" }),
      );
    });
  }

  for (const reason of catalogReasons) {
    it(`refreshes stale catalog + preference on '${reason}'`, async () => {
      const client = makeClient();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
      mockRpc.mockResolvedValue({ data: [{ saved: false, reason }], error: null });
      const { result } = await renderLoaded(client);

      await act(async () => {
        result.current.saveModel(GEMINI_36.id);
      });
      await waitFor(() => expect(mockToast).toHaveBeenCalled());

      expect(mockToast).toHaveBeenCalledWith({
        title: "Model unchanged",
        description:
          "That model is no longer available for selection. Refresh and choose another model.",
        variant: "destructive",
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.aiModelSettings.catalog(USER),
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.aiModelSettings.preference(USER),
      });
      expect(invalidate).not.toHaveBeenCalledWith({
        queryKey: queryKeys.access.current(USER),
      });
    });
  }

  it("does not report success for a malformed setter result", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
    mockRpc.mockResolvedValue({ data: [], error: null });
    const { result } = await renderLoaded();

    await act(async () => {
      result.current.saveModel(GEMINI_36.id);
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not update AI model" }),
      ),
    );
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "AI model updated" }),
    );
  });

  it("never surfaces a raw backend error message", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(null));
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'permission denied for table user_ai_preferences' },
    });
    const { result } = await renderLoaded();

    await act(async () => {
      result.current.saveModel(GEMINI_36.id);
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalled());

    const shown = JSON.stringify(mockToast.mock.calls);
    expect(shown).not.toContain("permission denied");
    expect(mockToast).toHaveBeenCalledWith({
      title: "Could not update AI model",
      description: "Please try again.",
      variant: "destructive",
    });
  });
});
