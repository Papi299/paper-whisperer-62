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
import {
  PAPERLUME_DEFAULT_VALUE,
  type SavedModelState,
  type SavedReasoningState,
} from "@/hooks/useAiModelSettings";
import { AUTOMATIC_REASONING_VALUE } from "@/lib/aiReasoning";

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

// The catalog ids as fixture data. The component itself names no model — the
// static assertions at the end of this suite read its source and prove it — so
// the AI-MODEL-SELECTION-001D pair below arrives here and nowhere else in the
// frontend: the shipped UI discovers 3.7 and 3.8 from `ai_model_catalog`.
const GEMINI_35_ID = "google/gemini-3.5-flash";
const GEMINI_36_ID = "google/gemini-3.6-flash";
const GEMINI_37_ID = "google/gemini-3.7-flash";
const GEMINI_38_ID = "google/gemini-3.8-flash";

/**
 * A catalog option as the hook projects it — AI-MULTI-PROVIDER-001C.
 *
 * `reasoningSelectable` defaults to FALSE, which is the staged state of every
 * Production catalog row: the reasoning control is implemented and offers no
 * manual choice. Tests that exercise the manual path opt in explicitly, which
 * is what makes the staged default visible rather than incidental.
 */
function option(
  id: string,
  displayName: string,
  overrides: Partial<{
    provider: string;
    enabled: boolean;
    selectable: boolean;
    reasoningLevels: string[];
    automaticAnalyzeReasoningLevel: string | null;
    automaticSuggestReasoningLevel: string | null;
    reasoningSelectable: boolean;
  }> = {},
) {
  return {
    id,
    provider: "google",
    displayName,
    enabled: true,
    selectable: true,
    reasoningLevels: ["minimal", "low", "medium", "high"],
    automaticAnalyzeReasoningLevel: "minimal",
    automaticSuggestReasoningLevel: "medium",
    reasoningSelectable: false,
    ...overrides,
  };
}

const OPTIONS = [
  option(GEMINI_35_ID, "Gemini 3.5 Flash"),
  option(GEMINI_36_ID, "Gemini 3.6 Flash"),
  option(GEMINI_37_ID, "Gemini 3.7 Flash", {
    reasoningLevels: ["low", "medium", "high"],
    automaticAnalyzeReasoningLevel: "low",
  }),
  option(GEMINI_38_ID, "Gemini 3.8 Flash", {
    reasoningLevels: ["low", "medium", "high"],
    automaticAnalyzeReasoningLevel: "low",
  }),
];

const optionById = (id: string) => OPTIONS.find((o) => o.id === id)!;

const saveModel = vi.fn();
const clearModel = vi.fn();
const saveReasoning = vi.fn();
const clearReasoning = vi.fn();
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
    savedReasoning: { status: "automatic" } as SavedReasoningState,
    isLoading: false,
    isError: false,
    refetch: refetchModel,
    saveModel,
    clearModel,
    saveReasoning,
    clearReasoning,
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

  it("offers Paperlume default plus every catalog model, in catalog order", async () => {
    renderSection();
    const listbox = await openSelect();

    // The exact rendered list, not four separate presence checks: the sentinel
    // must come first, and the four models must arrive in the order the hook
    // handed them over (which is the catalog's own sort_order).
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Paperlume default",
      "Gemini 3.5 Flash",
      "Gemini 3.6 Flash",
      "Gemini 3.7 Flash",
      "Gemini 3.8 Flash",
    ]);
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
          option: optionById(GEMINI_35_ID),
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
          option: optionById(GEMINI_36_ID),
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

  // AI-MODEL-SELECTION-001D. Choosing either new model must call the existing
  // setter with the exact catalog id — the component neither rewrites the id nor
  // recognises it. These pass against unmodified production code, which is the
  // result the task is asserting.
  it.each([
    ["Gemini 3.7 Flash", GEMINI_37_ID],
    ["Gemini 3.8 Flash", GEMINI_38_ID],
  ])("saves %s with its exact catalog id", async (label, id) => {
    renderSection();
    const listbox = await openSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: label }));

    await waitFor(() => expect(saveModel).toHaveBeenCalledWith(id));
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
          option: optionById(GEMINI_36_ID),
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
          option: optionById(GEMINI_36_ID),
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
          option: optionById(GEMINI_35_ID),
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

// ══ Reasoning level — AI-MULTI-PROVIDER-001C (C41) ═════════════════════════

/** Open the reasoning dropdown by its accessible name. */
async function openReasoningSelect() {
  const trigger = screen.getByRole("combobox", { name: "Reasoning level" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  return await screen.findByRole("listbox");
}

/** The visible text the reasoning control points `aria-describedby` at. */
function reasoningDescription(): string {
  const trigger = screen.getByRole("combobox", { name: "Reasoning level" });
  const id = trigger.getAttribute("aria-describedby");
  expect(id).toBeTruthy();
  return document.getElementById(id!)?.textContent ?? "";
}

/** An active saved model, optionally with reasoning opened and a saved level. */
function namedModel(
  modelOption: ReturnType<typeof option>,
  savedReasoning: SavedReasoningState = { status: "automatic" },
) {
  return {
    saved: {
      status: "active",
      modelId: modelOption.id,
      displayName: modelOption.displayName,
      selectable: true,
      option: modelOption,
    } as SavedModelState,
    savedReasoning,
    options: OPTIONS.map((o) => (o.id === modelOption.id ? modelOption : o)),
  };
}

const SONNET = option("anthropic/claude-sonnet-5", "Claude Sonnet 5", {
  provider: "anthropic",
  reasoningLevels: ["off", "low", "medium", "high", "xhigh", "max"],
  automaticAnalyzeReasoningLevel: "off",
  automaticSuggestReasoningLevel: "medium",
});
const TERRA = option("openai/gpt-5.6-terra", "GPT-5.6 Terra", {
  provider: "openai",
  reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
  automaticAnalyzeReasoningLevel: "none",
  automaticSuggestReasoningLevel: "medium",
});

describe("AiModelSettingsSection — reasoning on PaperLume default", () => {
  it("shows Automatic (Recommended) with no manual choice to make", () => {
    renderSection();
    const trigger = screen.getByRole("combobox", { name: "Reasoning level" });
    expect(trigger).toHaveTextContent("Automatic (Recommended)");
    // Disabled: PaperLume may change its default model server-side, and a
    // level saved against "whatever the default is" could silently go invalid.
    expect(trigger).toBeDisabled();
  });

  it("explains, in visible and described-by text, what Automatic does here", () => {
    renderSection();
    const text = reasoningDescription();
    expect(text).toMatch(/Automatic \(Recommended\) is used with Paperlume default/);
    expect(text).toMatch(/Paperlume chooses the model and adjusts reasoning for each task/);
    expect(text).toMatch(/Analyze uses a lighter reasoning setting/);
    expect(text).toMatch(/organization suggestions use Medium/);
    expect(text).toMatch(/Choose a specific model to customize reasoning/);
  });

  it("names no provider parameter in the explanation", () => {
    renderSection();
    expect(reasoningDescription()).not.toMatch(/thinking_?level|effort|adaptive|budget/i);
  });
});

describe("AiModelSettingsSection — reasoning on a named model (Automatic)", () => {
  it("states the EXACT Automatic policy for Gemini 3.5, from catalog metadata", () => {
    renderSection({ model: namedModel(optionById(GEMINI_35_ID)) });
    const text = reasoningDescription();
    expect(text).toMatch(/Recommended\. Paperlume adjusts reasoning to the task\./);
    expect(text).toContain("Analyze: Minimal · Organization suggestions: Medium");
    expect(text).toMatch(/This balances quality, speed, and cost\./);
  });

  it("states the EXACT Automatic policy for Gemini 3.8, which has no Minimal", () => {
    renderSection({ model: namedModel(optionById(GEMINI_38_ID)) });
    expect(reasoningDescription()).toContain("Analyze: Low · Organization suggestions: Medium");
  });

  it("states the future Sonnet 5 policy from its fixture row", () => {
    renderSection({ model: namedModel(SONNET) });
    expect(reasoningDescription()).toContain("Analyze: Off · Organization suggestions: Medium");
  });

  it("states the future Terra policy from its fixture row", () => {
    renderSection({ model: namedModel(TERRA) });
    expect(reasoningDescription()).toContain("Analyze: None · Organization suggestions: Medium");
  });

  it("follows the catalog, not the model id — a changed row changes the text", () => {
    // Proof there is no per-model branch: the same id with different metadata
    // produces a different summary.
    const edited = { ...optionById(GEMINI_35_ID), automaticAnalyzeReasoningLevel: "low" };
    renderSection({ model: namedModel(edited) });
    expect(reasoningDescription()).toContain("Analyze: Low · Organization suggestions: Medium");
  });

  it("offers no manual choice while reasoning selection is staged off", async () => {
    // Every Production catalog row after the 001C migration.
    renderSection({ model: namedModel(optionById(GEMINI_35_ID)) });
    const trigger = screen.getByRole("combobox", { name: "Reasoning level" });
    expect(trigger).toBeDisabled();
    expect(reasoningDescription()).toMatch(
      /Choosing a reasoning level is not available for Gemini 3\.5 Flash/,
    );
    expect(saveReasoning).not.toHaveBeenCalled();
  });
});

describe("AiModelSettingsSection — reasoning options when selection is open", () => {
  const open = (o: ReturnType<typeof option>) => ({ ...o, reasoningSelectable: true });

  it("offers Automatic plus exactly Gemini 3.5's four levels", async () => {
    renderSection({ model: namedModel(open(optionById(GEMINI_35_ID))) });
    const listbox = await openReasoningSelect();
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Automatic (Recommended)",
      "Minimal",
      "Low",
      "Medium",
      "High",
    ]);
  });

  it("offers Gemini 3.8 no Minimal — not even disabled", async () => {
    renderSection({ model: namedModel(open(optionById(GEMINI_38_ID))) });
    const listbox = await openReasoningSelect();
    const labels = within(listbox).getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["Automatic (Recommended)", "Low", "Medium", "High"]);
    expect(labels).not.toContain("Minimal");
  });

  it("offers Sonnet 5's six levels, Off through Max", async () => {
    renderSection({ model: namedModel(open(SONNET)) });
    const listbox = await openReasoningSelect();
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Automatic (Recommended)",
      "Off",
      "Low",
      "Medium",
      "High",
      "Extra High",
      "Max",
    ]);
  });

  it("offers Terra's six levels, None through Max", async () => {
    renderSection({ model: namedModel(open(TERRA)) });
    const listbox = await openReasoningSelect();
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Automatic (Recommended)",
      "None",
      "Low",
      "Medium",
      "High",
      "Extra High",
      "Max",
    ]);
  });

  it("saves the chosen canonical level, never a label", async () => {
    renderSection({ model: namedModel(open(optionById(GEMINI_35_ID))) });
    const listbox = await openReasoningSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: "High" }));
    await waitFor(() => expect(saveReasoning).toHaveBeenCalledWith("high"));
    expect(clearReasoning).not.toHaveBeenCalled();
    expect(saveModel).not.toHaveBeenCalled();
  });

  it("clears — never calls the setter — when Automatic is chosen", async () => {
    renderSection({
      model: namedModel(open(optionById(GEMINI_35_ID)), { status: "manual", level: "high" }),
    });
    const listbox = await openReasoningSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: "Automatic (Recommended)" }));
    await waitFor(() => expect(clearReasoning).toHaveBeenCalledTimes(1));
    expect(saveReasoning).not.toHaveBeenCalled();
    expect(saveReasoning).not.toHaveBeenCalledWith(AUTOMATIC_REASONING_VALUE);
  });
});

describe("AiModelSettingsSection — manual reasoning explanations", () => {
  it.each([
    ["medium", /Medium applies to both Analyze and organization suggestions/, /balanced trade-off between quality, speed, and cost/],
    ["high", /High applies to both Analyze and organization suggestions/, /may be slower and more expensive/],
    ["max", /Max applies maximum reasoning effort within PaperLume's output limits/, /highest expected latency and cost/],
    ["low", /Low applies to both Analyze and organization suggestions/, /faster and typically less expensive/],
    ["minimal", /Minimal applies to both Analyze and organization suggestions/, /prioritizes speed/],
  ] as const)("explains %s visibly and through aria-describedby", (level, first, second) => {
    const model = level === "minimal" ? optionById(GEMINI_35_ID) : { ...SONNET, reasoningLevels: [...SONNET.reasoningLevels, "minimal"] };
    renderSection({
      model: namedModel({ ...model, reasoningSelectable: true }, { status: "manual", level }),
    });
    const text = reasoningDescription();
    expect(text).toMatch(first);
    expect(text).toMatch(second);
    // No estimated dollar amount anywhere.
    expect(text).not.toMatch(/\$\s*\d/);
  });

  it("explains Off and None as disabled reasoning", () => {
    renderSection({ model: namedModel({ ...SONNET, reasoningSelectable: true }, { status: "manual", level: "off" }) });
    expect(reasoningDescription()).toMatch(/Thinking is disabled for both Analyze and organization suggestions/);
  });

  it("explains None as disabled reasoning", () => {
    renderSection({ model: namedModel({ ...TERRA, reasoningSelectable: true }, { status: "manual", level: "none" }) });
    expect(reasoningDescription()).toMatch(/Reasoning is disabled for both Analyze and organization suggestions/);
  });
});

describe("AiModelSettingsSection — a saved level while selection is closed", () => {
  it("shows it truthfully and permits returning to Automatic only", async () => {
    // Mirrors an `enabled, not selectable` MODEL: switching away is permitted,
    // switching sideways is not.
    renderSection({
      model: namedModel(optionById(GEMINI_35_ID), { status: "manual", level: "high" }),
    });
    const trigger = screen.getByRole("combobox", { name: "Reasoning level" });
    expect(trigger).toHaveTextContent("High");
    expect(trigger).not.toBeDisabled();
    // Read BEFORE opening: Radix marks everything outside an open listbox
    // aria-hidden, which would make the trigger itself unreachable by role.
    expect(reasoningDescription()).toMatch(/no longer accepting new reasoning choices/);

    const listbox = await openReasoningSelect();
    const optionsShown = within(listbox).getAllByRole("option");
    expect(optionsShown.map((o) => o.textContent)).toEqual(["Automatic (Recommended)", "High"]);
    // The saved level is shown but cannot be re-chosen, and no other level is offered.
    expect(within(listbox).getByRole("option", { name: "High" })).toHaveAttribute("aria-disabled", "true");
  });

  it("reports a saved level the model no longer supports, and offers the way back", () => {
    renderSection({
      model: namedModel(optionById(GEMINI_38_ID), { status: "unsupported", level: "minimal" }),
    });
    const text = reasoningDescription();
    expect(text).toMatch(/Minimal is saved but Gemini 3\.8 Flash no longer supports it/);
    expect(text).toMatch(/Paperlume is choosing a reasoning level for each task instead/);
    expect(text).toContain("Analyze: Low · Organization suggestions: Medium");
  });
});

describe("AiModelSettingsSection — reasoning accessibility", () => {
  it("labels the reasoning control with visible text, not a tooltip", () => {
    renderSection({ model: namedModel(optionById(GEMINI_35_ID)) });
    const trigger = screen.getByRole("combobox", { name: "Reasoning level" });
    const labelId = trigger.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const label = document.getElementById(labelId!);
    expect(label?.textContent).toBe("Reasoning level");
    // Visible, not visually hidden.
    expect(label?.className ?? "").not.toMatch(/sr-only/);
  });

  it("describes the control with the same visible status text a sighted user reads", () => {
    renderSection({ model: namedModel(optionById(GEMINI_35_ID)) });
    const text = reasoningDescription();
    expect(text.length).toBeGreaterThan(0);
    // The described-by target is rendered in the document, not in a tooltip.
    expect(screen.getByText(/Analyze: Minimal · Organization suggestions: Medium/)).toBeVisible();
  });

  it("does not render the reasoning control at all for a non-entitled account", () => {
    renderSection({ entitled: false });
    expect(screen.queryByRole("combobox", { name: "Reasoning level" })).toBeNull();
    // …but still says, in text, what the account is getting.
    expect(screen.getByText(/Reasoning level: Automatic \(Recommended\)/)).toBeInTheDocument();
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
    expect(code).not.toMatch(/claude-sonnet|gpt-5/);
    expect(code).not.toMatch(/GEMINI_MODEL/);
    expect(code).not.toMatch(/GEMINI_API_KEY/);
  });

  it("derives the Automatic policy from catalog metadata, never from a model id", () => {
    // AI-MULTI-PROVIDER-001C. The summary line is built from the option's own
    // auto_* fields; there is no branch on which model is selected.
    expect(code).toContain("automaticAnalyzeReasoningLevel");
    expect(code).toContain("automaticSuggestReasoningLevel");
    expect(code).not.toMatch(/modelId\s*===\s*["']/);
    expect(code).not.toMatch(/provider\s*===\s*["']/);
  });

  it("uses product words for reasoning, never provider parameter names", () => {
    expect(code).not.toMatch(/thinking_?[Ll]evel|output_config|reasoning\.effort|budget_tokens/);
  });

  it("performs no table write and no direct RPC of its own", () => {
    expect(code).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    expect(code).not.toMatch(/supabase\./);
  });
});
