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
 * Catalog fixtures use the two real Production model ids on purpose: concrete
 * ids belong in a fixture, and the point of the suite is that the *hook* never
 * contains them. Nothing in `useAiModelSettings.ts` names a model.
 */
const GEMINI_35 = {
  id: "google/gemini-3.5-flash",
  provider: "google",
  display_name: "Gemini 3.5 Flash",
  enabled: true,
  selectable: true,
  sort_order: 10,
};
const GEMINI_36 = {
  id: "google/gemini-3.6-flash",
  provider: "google",
  display_name: "Gemini 3.6 Flash",
  enabled: true,
  selectable: true,
  sort_order: 20,
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

function rows(...list: unknown[]): Result {
  return { data: list, error: null };
}
function prefRow(modelId: string | null): Result {
  return { data: modelId === null ? null : { preferred_model_id: modelId }, error: null };
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
      "id, provider, display_name, enabled, selectable, sort_order",
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

    expect(stubs.preference.select).toHaveBeenCalledWith("preferred_model_id");
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

  it("offers only enabled + selectable + supported-provider rows, in catalog order", async () => {
    mockTables(
      rows(
        GEMINI_35,
        GEMINI_36,
        { ...GEMINI_35, id: "google/disabled", display_name: "Disabled", enabled: false },
        { ...GEMINI_35, id: "google/locked", display_name: "Locked", selectable: false },
        {
          ...GEMINI_35,
          id: "anthropic/claude",
          provider: "anthropic",
          display_name: "Claude",
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

  it("resolves an explicit preference to an active saved model", async () => {
    mockTables(rows(GEMINI_35, GEMINI_36), prefRow(GEMINI_36.id));
    const { result } = await renderLoaded();

    expect(result.current.saved).toEqual({
      status: "active",
      modelId: GEMINI_36.id,
      displayName: "Gemini 3.6 Flash",
      selectable: true,
    });
  });

  it("keeps an enabled-but-unselectable saved model active, flagged unselectable", async () => {
    mockTables(rows({ ...GEMINI_35, selectable: false }, GEMINI_36), prefRow(GEMINI_35.id));
    const { result } = await renderLoaded();

    expect(result.current.saved).toEqual({
      status: "active",
      modelId: GEMINI_35.id,
      displayName: "Gemini 3.5 Flash",
      selectable: false,
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
      rows({ ...GEMINI_35, id: "anthropic/claude", provider: "anthropic", display_name: "Claude" }),
      prefRow("anthropic/claude"),
    );
    const { result } = await renderLoaded();

    expect(result.current.saved).toEqual({
      status: "unavailable",
      modelId: "anthropic/claude",
      displayName: "Claude",
    });
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
    expect(rpcNames.sort()).toEqual([
      "clear_current_user_ai_model",
      "set_current_user_ai_model",
    ]);
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
