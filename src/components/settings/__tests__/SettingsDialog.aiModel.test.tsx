import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { mockFrom, mockRpc, mockUseSettings, mockUseStorageUsage, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockUseSettings: vi.fn(),
  mockUseStorageUsage: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
}));
vi.mock("@/hooks/useSettings", () => ({ useSettings: mockUseSettings }));
vi.mock("@/hooks/useStorageUsage", () => ({ useStorageUsage: mockUseStorageUsage }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));

import { SettingsDialog } from "../SettingsDialog";

/**
 * Settings ↔ AI Model integration (AI-MODEL-SELECTION-001C).
 *
 * Unlike AiModelSettingsSection.test.tsx, nothing about the model data layer is
 * stubbed here: the real `useCurrentUserAccess` and `useAiModelSettings` run
 * against a mocked Supabase client, so this suite proves what the composed
 * dialog actually does to the backend — including what it does *not* do.
 */

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const USER = "user-1";
const GEMINI_35_ID = "google/gemini-3.5-flash";
const GEMINI_36_ID = "google/gemini-3.6-flash";

const CATALOG = [
  {
    id: GEMINI_35_ID,
    provider: "google",
    display_name: "Gemini 3.5 Flash",
    enabled: true,
    selectable: true,
    sort_order: 10,
  },
  {
    id: GEMINI_36_ID,
    provider: "google",
    display_name: "Gemini 3.6 Flash",
    enabled: true,
    selectable: true,
    sort_order: 20,
  },
];

/** Records every PostgREST verb the dialog invokes, per table. */
const calls: { table: string; verb: string }[] = [];

function tableStub(table: string, preferenceRow: unknown) {
  const record = (verb: string) => calls.push({ table, verb });
  const stub: Record<string, unknown> = {
    select: vi.fn(() => (record("select"), stub)),
    order: vi.fn(() => stub),
    eq: vi.fn(() => stub),
    maybeSingle: vi.fn(async () => ({ data: preferenceRow, error: null })),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: CATALOG, error: null }).then(resolve),
    // Present but forbidden: if the dialog ever reached for a write verb the
    // call would be recorded here instead of failing silently.
    insert: vi.fn(() => (record("insert"), stub)),
    update: vi.fn(() => (record("update"), stub)),
    upsert: vi.fn(() => (record("upsert"), stub)),
    delete: vi.fn(() => (record("delete"), stub)),
  };
  return stub;
}

function accessRow(canSelectAiModel: boolean) {
  return {
    role: "user",
    is_internal: false,
    can_view_provider_quota: false,
    ai_quota_exempt: false,
    plan: canSelectAiModel ? "pro" : "free",
    plan_status: "active",
    premium_taxonomy_enabled: false,
    labs_team_enabled: false,
    can_select_ai_model: canSelectAiModel,
  };
}

function setup({
  entitled = true,
  preferredModelId = null as string | null,
}: { entitled?: boolean; preferredModelId?: string | null } = {}) {
  const preferenceRow = preferredModelId === null ? null : { preferred_model_id: preferredModelId };
  mockFrom.mockImplementation((table: string) => tableStub(table, preferenceRow));
  mockRpc.mockImplementation(async (fn: string) => {
    if (fn === "get_current_user_access") return { data: [accessRow(entitled)], error: null };
    if (fn === "set_current_user_ai_model") {
      return {
        data: [{ saved: true, reason: "ok", display_name: "Gemini 3.6 Flash" }],
        error: null,
      };
    }
    if (fn === "clear_current_user_ai_model") {
      return { data: [{ cleared: true, reason: "ok" }], error: null };
    }
    throw new Error(`unexpected rpc: ${fn}`);
  });
}

function renderDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = render(<SettingsDialog open={true} onOpenChange={onOpenChange} userId={USER} />, {
    wrapper,
  });
  return { ...view, onOpenChange };
}

async function trigger() {
  return await screen.findByRole("combobox", { name: "AI model" });
}

async function openSelect() {
  fireEvent.keyDown(await trigger(), { key: "Enter" });
  return await screen.findByRole("listbox");
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mockUseSettings.mockReturnValue({
    settings: { pubmedApiKey: null },
    loading: false,
    setPubmedApiKey: vi.fn(),
    clearPubmedApiKey: vi.fn(),
  });
  mockUseStorageUsage.mockReturnValue({
    status: null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
});

describe("SettingsDialog — AI Model section composition", () => {
  it("renders the AI Model section alongside the untouched PubMed and Storage sections", async () => {
    setup();
    renderDialog();

    expect(await screen.findByRole("heading", { name: "AI Model" })).toBeInTheDocument();
    expect(screen.getByLabelText("PubMed API Key (NCBI)")).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
  });

  it("creates no preference row merely by opening Settings", async () => {
    setup();
    renderDialog();
    await trigger();

    // Reads only, and no preference RPC of any kind.
    expect(calls.filter((c) => c.verb !== "select")).toEqual([]);
    const rpcNames = mockRpc.mock.calls.map((c) => c[0]);
    expect(rpcNames).toContain("get_current_user_access");
    expect(rpcNames).not.toContain("set_current_user_ai_model");
    expect(rpcNames).not.toContain("clear_current_user_ai_model");
  });

  it("scopes the preference read to the signed-in user", async () => {
    setup();
    renderDialog();
    await trigger();

    const prefStub = mockFrom.mock.results
      .map((r) => r.value as Record<string, { mock?: { calls: unknown[][] } }>)
      .find((stub) => (stub.eq as unknown as { mock: { calls: unknown[][] } }).mock.calls.length > 0);
    expect(
      (prefStub!.eq as unknown as { mock: { calls: unknown[][] } }).mock.calls,
    ).toContainEqual(["user_id", USER]);
  });

  it("keeps Settings open after a model is saved", async () => {
    setup();
    const { onOpenChange } = renderDialog();

    const listbox = await openSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: "Gemini 3.6 Flash" }));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith("set_current_user_ai_model", {
        p_model_id: GEMINI_36_ID,
      }),
    );
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "AI model updated" }),
      ),
    );
    // The PubMed save path is the only thing that closes this dialog.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps Settings open after resetting to Paperlume default", async () => {
    setup({ preferredModelId: GEMINI_36_ID });
    const { onOpenChange } = renderDialog();

    const listbox = await openSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: "Paperlume default" }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("clear_current_user_ai_model"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not submit the PubMed key when the model is changed", async () => {
    const setPubmedApiKey = vi.fn();
    mockUseSettings.mockReturnValue({
      settings: { pubmedApiKey: null },
      loading: false,
      setPubmedApiKey,
      clearPubmedApiKey: vi.fn(),
    });
    setup();
    renderDialog();

    fireEvent.change(screen.getByLabelText("PubMed API Key (NCBI)"), {
      target: { value: "typed-but-not-saved" },
    });
    const listbox = await openSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: "Gemini 3.6 Flash" }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("set_current_user_ai_model", {
      p_model_id: GEMINI_36_ID,
    }));
    expect(setPubmedApiKey).not.toHaveBeenCalled();
  });

  it("keeps the PubMed Enter handler scoped to the PubMed field", async () => {
    const setPubmedApiKey = vi.fn().mockResolvedValue(null);
    mockUseSettings.mockReturnValue({
      settings: { pubmedApiKey: null },
      loading: false,
      setPubmedApiKey,
      clearPubmedApiKey: vi.fn(),
    });
    setup();
    renderDialog();

    fireEvent.change(screen.getByLabelText("PubMed API Key (NCBI)"), {
      target: { value: "a-key" },
    });
    // Enter on the model control must not reach the PubMed save handler.
    fireEvent.keyDown(await trigger(), { key: "Enter" });
    expect(setPubmedApiKey).not.toHaveBeenCalled();
  });

  it("gives a non-entitled user a read-only default state and no selector", async () => {
    setup({ entitled: false });
    renderDialog();

    expect(await screen.findByRole("heading", { name: "AI Model" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Paperlume is using its default model.")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("combobox", { name: "AI model" })).not.toBeInTheDocument();
    expect(screen.getByText("Model selection is available on eligible plans.")).toBeInTheDocument();
  });

  it("lets a non-entitled user with a dormant preference clear it, but not change it", async () => {
    setup({ entitled: false, preferredModelId: GEMINI_35_ID });
    renderDialog();

    const reset = await screen.findByRole("button", { name: /Reset to Paperlume default/i });
    expect(screen.queryByRole("combobox", { name: "AI model" })).not.toBeInTheDocument();

    fireEvent.click(reset);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("clear_current_user_ai_model"));
    expect(mockRpc).not.toHaveBeenCalledWith(
      "set_current_user_ai_model",
      expect.anything(),
    );
  });

  it("never issues a direct write against either AI-model table", async () => {
    setup({ preferredModelId: GEMINI_35_ID });
    renderDialog();

    const listbox = await openSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: "Gemini 3.6 Flash" }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("set_current_user_ai_model", {
      p_model_id: GEMINI_36_ID,
    }));

    expect(calls.filter((c) => c.verb !== "select")).toEqual([]);
    expect(new Set(calls.map((c) => c.table))).toEqual(
      new Set(["ai_model_catalog", "user_ai_preferences"]),
    );
  });
});
