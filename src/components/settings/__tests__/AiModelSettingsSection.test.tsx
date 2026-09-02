import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { mockUseCurrentUserAccess, mockUseAiModelSettings } = vi.hoisted(() => ({
  mockUseCurrentUserAccess: vi.fn(),
  mockUseAiModelSettings: vi.fn(),
}));

vi.mock("@/hooks/useCurrentUserAccess", () => ({
  useCurrentUserAccess: mockUseCurrentUserAccess,
}));
vi.mock("@/hooks/useAiModelSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useAiModelSettings")>()),
  useAiModelSettings: mockUseAiModelSettings,
}));

import { AiModelSettingsSection } from "../AiModelSettingsSection";
import { PAPERLUME_DEFAULT_VALUE, type SavedModelState } from "@/hooks/useAiModelSettings";

// Radix Select relies on a few DOM APIs jsdom does not implement. Polyfilled
// locally (not in the shared setup) so this suite can open the listbox and
// drive real selections — the same pattern the Popover/cmdk suites use.
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

const GEMINI_35_ID = "google/gemini-3.5-flash";
const GEMINI_36_ID = "google/gemini-3.6-flash";

const OPTIONS = [
  { id: GEMINI_35_ID, provider: "google", displayName: "Gemini 3.5 Flash", enabled: true, selectable: true },
  { id: GEMINI_36_ID, provider: "google", displayName: "Gemini 3.6 Flash", enabled: true, selectable: true },
];

const saveModel = vi.fn();
const clearModel = vi.fn();
const refetchModel = vi.fn();
const refetchAccess = vi.fn();

function accessState(overrides: Record<string, unknown> = {}) {
  return {
    access: { canSelectAiModel: false },
    isLoading: false,
    isError: false,
    refetch: refetchAccess,
    ...overrides,
  };
}

function modelState(overrides: Record<string, unknown> = {}) {
  return {
    options: OPTIONS,
    saved: { status: "none" } as SavedModelState,
    isLoading: false,
    isError: false,
    refetch: refetchModel,
    saveModel,
    clearModel,
    isMutating: false,
    ...overrides,
  };
}

/** Render with an entitled/non-entitled access projection and a model state. */
function renderSection({
  entitled = true,
  access = {},
  model = {},
}: {
  entitled?: boolean;
  access?: Record<string, unknown>;
  model?: Record<string, unknown>;
} = {}) {
  mockUseCurrentUserAccess.mockReturnValue(
    accessState({ access: { canSelectAiModel: entitled }, ...access }),
  );
  mockUseAiModelSettings.mockReturnValue(modelState(model));
  return render(<AiModelSettingsSection userId="user-1" open={true} />);
}

/** Open the Radix Select and return its listbox. */
async function openSelect() {
  const trigger = screen.getByRole("combobox", { name: "AI model" });
  // Radix Select opens on pointerdown + Enter/Space/click; keyboard is the
  // form that works headlessly in jsdom.
  fireEvent.keyDown(trigger, { key: "Enter" });
  return await screen.findByRole("listbox");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AiModelSettingsSection — entitled, no preference", () => {
  it("renders the AI Model section with an enabled selector on Paperlume default", async () => {
    renderSection();

    expect(screen.getByRole("heading", { name: "AI Model" })).toBeInTheDocument();
    const trigger = screen.getByRole("combobox", { name: "AI model" });
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveTextContent("Paperlume default");
  });

  it("offers Paperlume default plus both seeded catalog models", async () => {
    renderSection();
    const listbox = await openSelect();

    expect(within(listbox).getByRole("option", { name: "Paperlume default" })).toBeInTheDocument();
    expect(within(listbox).getByRole("option", { name: "Gemini 3.5 Flash" })).toBeInTheDocument();
    expect(within(listbox).getByRole("option", { name: "Gemini 3.6 Flash" })).toBeInTheDocument();
  });

  it("explains the distinction between following the default and pinning a model", () => {
    renderSection();
    expect(
      screen.getByText(/Paperlume default follows Paperlume's currently recommended model/i),
    ).toBeInTheDocument();
  });

  it("writes nothing merely because Settings was opened", () => {
    renderSection();
    expect(saveModel).not.toHaveBeenCalled();
    expect(clearModel).not.toHaveBeenCalled();
  });
});

describe("AiModelSettingsSection — explicit preferences", () => {
  it("shows an explicit Gemini 3.5 pin as selected, distinct from Paperlume default", () => {
    renderSection({
      model: {
        saved: {
          status: "active",
          modelId: GEMINI_35_ID,
          displayName: "Gemini 3.5 Flash",
          selectable: true,
        },
      },
    });

    const trigger = screen.getByRole("combobox", { name: "AI model" });
    expect(trigger).toHaveTextContent("Gemini 3.5 Flash");
    expect(trigger).not.toHaveTextContent("Paperlume default");
    expect(screen.getByText(/Gemini 3.5 Flash is saved for this account/i)).toBeInTheDocument();
  });

  it("shows an explicit Gemini 3.6 pin as selected", () => {
    renderSection({
      model: {
        saved: {
          status: "active",
          modelId: GEMINI_36_ID,
          displayName: "Gemini 3.6 Flash",
          selectable: true,
        },
      },
    });
    expect(screen.getByRole("combobox", { name: "AI model" })).toHaveTextContent(
      "Gemini 3.6 Flash",
    );
  });
});

describe("AiModelSettingsSection — changing the model", () => {
  it("saves google/gemini-3.6-flash when Gemini 3.6 Flash is chosen", async () => {
    renderSection();
    const listbox = await openSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: "Gemini 3.6 Flash" }));

    await waitFor(() => expect(saveModel).toHaveBeenCalledWith(GEMINI_36_ID));
    expect(clearModel).not.toHaveBeenCalled();
  });

  it("saves google/gemini-3.5-flash when Gemini 3.5 Flash is chosen explicitly", async () => {
    renderSection({
      model: {
        saved: {
          status: "active",
          modelId: GEMINI_36_ID,
          displayName: "Gemini 3.6 Flash",
          selectable: true,
        },
      },
    });
    const listbox = await openSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: "Gemini 3.5 Flash" }));

    await waitFor(() => expect(saveModel).toHaveBeenCalledWith(GEMINI_35_ID));
    expect(clearModel).not.toHaveBeenCalled();
  });

  it("clears — never calls the setter — when Paperlume default is chosen", async () => {
    renderSection({
      model: {
        saved: {
          status: "active",
          modelId: GEMINI_36_ID,
          displayName: "Gemini 3.6 Flash",
          selectable: true,
        },
      },
    });
    const listbox = await openSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: "Paperlume default" }));

    await waitFor(() => expect(clearModel).toHaveBeenCalled());
    expect(saveModel).not.toHaveBeenCalled();
    // The sentinel is a UI value only; it must never travel to the setter.
    expect(saveModel).not.toHaveBeenCalledWith(PAPERLUME_DEFAULT_VALUE);
  });

  it("disables the control and reports busy state while a write is in flight", () => {
    renderSection({ model: { isMutating: true } });

    expect(screen.getByRole("combobox", { name: "AI model" })).toBeDisabled();
    // Busy is stated in text, not by the disabled outline alone.
    expect(screen.getByText(/Saving your model preference/i)).toBeInTheDocument();
  });
});

describe("AiModelSettingsSection — entitlement gating", () => {
  it("renders no selector at all for a non-entitled user", () => {
    renderSection({ entitled: false });

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Paperlume is using its default model.")).toBeInTheDocument();
    expect(
      screen.getByText("Model selection is available on eligible plans."),
    ).toBeInTheDocument();
  });

  it("offers no purchase, checkout or upgrade affordance to a non-entitled user", () => {
    renderSection({ entitled: false });
    expect(
      screen.queryByRole("button", { name: /upgrade|buy|subscribe|checkout|pricing/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /upgrade|buy|subscribe/i })).not.toBeInTheDocument();
  });

  it("never flashes an enabled control while access is still loading", () => {
    renderSection({ entitled: true, access: { isLoading: true } });

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Loading AI model settings")).toBeInTheDocument();
  });

  it("fails closed when the access lookup errors", () => {
    // Note the access projection still claims entitlement: an errored lookup
    // must not be trusted even so.
    renderSection({ entitled: true, access: { isError: true } });

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.getByText("Unable to verify model-selection access right now."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetchAccess).toHaveBeenCalled();
  });
});

describe("AiModelSettingsSection — downgraded user with a dormant preference", () => {
  const dormant = {
    entitled: false,
    model: {
      saved: {
        status: "active" as const,
        modelId: GEMINI_36_ID,
        displayName: "Gemini 3.6 Flash",
        selectable: true,
      },
    },
  };

  it("reports the saved model as inactive and the default as in use", () => {
    renderSection(dormant);

    expect(screen.getByText("Paperlume is using its default model.")).toBeInTheDocument();
    expect(
      screen.getByText(/Your saved model \(Gemini 3.6 Flash\) is inactive/i),
    ).toBeInTheDocument();
  });

  it("lets the dormant preference be cleared", () => {
    renderSection(dormant);

    fireEvent.click(screen.getByRole("button", { name: /Reset to Paperlume default/i }));
    expect(clearModel).toHaveBeenCalled();
    expect(saveModel).not.toHaveBeenCalled();
  });

  it("offers no way to choose a different model", () => {
    renderSection(dormant);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Gemini 3.5 Flash")).not.toBeInTheDocument();
  });
});

describe("AiModelSettingsSection — catalog lifecycle", () => {
  it("keeps an enabled-but-unselectable saved model as the current choice, not newly selectable", async () => {
    renderSection({
      model: {
        // The saved model is absent from `options` — that is what
        // `selectable = false` produces.
        options: [OPTIONS[1]],
        saved: {
          status: "active",
          modelId: GEMINI_35_ID,
          displayName: "Gemini 3.5 Flash",
          selectable: false,
        },
      },
    });

    const trigger = screen.getByRole("combobox", { name: "AI model" });
    expect(trigger).toHaveTextContent("Gemini 3.5 Flash");
    expect(
      screen.getByText(/is your saved model and is still in use.*no longer offered for new selections/is),
    ).toBeInTheDocument();

    const listbox = await openSelect();
    const savedOption = within(listbox).getByRole("option", { name: "Gemini 3.5 Flash" });
    expect(savedOption).toHaveAttribute("data-disabled");
    // Still able to move to a currently selectable model, or back to default.
    expect(within(listbox).getByRole("option", { name: "Gemini 3.6 Flash" })).toBeInTheDocument();
    expect(within(listbox).getByRole("option", { name: "Paperlume default" })).toBeInTheDocument();
  });

  it("reports a disabled saved model as unavailable with the default in use", () => {
    renderSection({
      model: {
        saved: { status: "unavailable", modelId: GEMINI_35_ID, displayName: "Gemini 3.5 Flash" },
      },
    });

    expect(
      screen.getByText(
        "Your saved model is no longer available. Paperlume is using the default model.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "AI model" })).toHaveTextContent(
      "Gemini 3.5 Flash (unavailable)",
    );
    expect(clearModel).not.toHaveBeenCalled();
  });

  it("reports a saved model missing from the catalog without crashing", async () => {
    renderSection({
      model: {
        saved: { status: "unavailable", modelId: "google/retired", displayName: null },
      },
    });

    expect(
      screen.getByText(
        "Your saved model is no longer available. Paperlume is using the default model.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "AI model" })).toHaveTextContent(
      "Saved model (unavailable)",
    );
    // And the user can still recover in both directions.
    const listbox = await openSelect();
    expect(within(listbox).getByRole("option", { name: "Paperlume default" })).toBeInTheDocument();
    expect(within(listbox).getByRole("option", { name: "Gemini 3.6 Flash" })).toBeInTheDocument();
  });

  it("offers only what the hook exposes — nothing disabled, unselectable or unsupported", async () => {
    // `options` is the hook's already-filtered list; the component adds no
    // models of its own beyond the sentinel and the saved row.
    renderSection({ model: { options: [OPTIONS[0]] } });
    const listbox = await openSelect();

    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Paperlume default",
      "Gemini 3.5 Flash",
    ]);
  });
});

describe("AiModelSettingsSection — read failures", () => {
  it("disables model changes and offers a retry when a read fails", () => {
    renderSection({ model: { isError: true, saved: null } });

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("AI model settings are unavailable right now.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetchModel).toHaveBeenCalled();
  });

  it("does not treat an unresolved read as 'no preference'", () => {
    renderSection({ model: { saved: null } });

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Paperlume default")).not.toBeInTheDocument();
  });

  it("renders no raw backend error text", () => {
    renderSection({ model: { isError: true, saved: null } });
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/permission denied|PGRST|relation .* does not exist|supabase/i);
  });
});

describe("AiModelSettingsSection — static guarantees", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/components/settings/AiModelSettingsSection.tsx"),
    "utf-8",
  );
  /**
   * Comments stripped: the file's documentation deliberately *names* the
   * boundaries it refuses to cross (`GEMINI_MODEL` stays server-side, the plan
   * name is not the gate). Prose explaining a rule must not read as a
   * violation of it, so the negative assertions below run against code only.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("gates on the server capability only — no plan name, email or role check", () => {
    expect(code).toContain("canSelectAiModel");
    expect(code).not.toMatch(/plan\s*===/);
    expect(code).not.toMatch(/"pro"|'pro'/);
    expect(code).not.toMatch(/labs_team/);
    expect(code).not.toMatch(/\brole\s*===/);
    expect(code).not.toMatch(/@[\w.-]+\.\w+/);
    expect(code).not.toMatch(/localStorage|sessionStorage/);
  });

  it("hard-codes no model id and no GEMINI_MODEL authority", () => {
    expect(code).not.toMatch(/gemini-3\.\d/);
    expect(code).not.toMatch(/GEMINI_MODEL/);
    expect(code).not.toMatch(/GEMINI_API_KEY/);
  });

  it("performs no table write and no direct RPC of its own", () => {
    expect(code).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    expect(code).not.toMatch(/supabase\./);
  });
});
