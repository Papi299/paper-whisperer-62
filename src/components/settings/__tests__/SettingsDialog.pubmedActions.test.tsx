import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { mockUseSettings, mockUseStorageUsage, mockToast } = vi.hoisted(() => ({
  mockUseSettings: vi.fn(),
  mockUseStorageUsage: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/hooks/useSettings", () => ({ useSettings: mockUseSettings }));
vi.mock("@/hooks/useStorageUsage", () => ({ useStorageUsage: mockUseStorageUsage }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));
// The AI Model section owns its own React Query reads; this suite renders
// Settings without a provider, so both of its hooks are stubbed to an inert,
// non-entitled state. Their behaviour is covered by
// AiModelSettingsSection.test.tsx and SettingsDialog.aiModel.test.tsx.
vi.mock("@/hooks/useCurrentUserAccess", () => ({
  useCurrentUserAccess: () => ({
    access: { canSelectAiModel: false },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/useAiModelSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useAiModelSettings")>()),
  useAiModelSettings: () => ({
    options: [],
    saved: { status: "none" as const },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    saveModel: vi.fn(),
    clearModel: vi.fn(),
    isMutating: false,
  }),
}));

import { SettingsDialog } from "../SettingsDialog";

const MB = 1024 * 1024;

function settingsState(overrides: Record<string, unknown> = {}) {
  return {
    settings: { pubmedApiKey: null },
    loading: false,
    setPubmedApiKey: vi.fn().mockResolvedValue(null),
    clearPubmedApiKey: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSettings.mockReturnValue(settingsState());
  mockUseStorageUsage.mockReturnValue({
    status: {
      usedBytes: 124 * MB,
      quotaBytes: 500 * MB,
      remainingBytes: 376 * MB,
      percentUsed: 25,
      isAtOrOverQuota: false,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
});

/**
 * The structural container the PubMed field lives in. Reached from the field
 * itself, so the assertion is about real containment rather than a test-only
 * hook: if the actions ever drift back out of this element the query fails.
 */
function pubmedSection() {
  const field = screen.getByLabelText("PubMed API Key (NCBI)");
  const section = field.closest("section");
  expect(section).not.toBeNull();
  return section as HTMLElement;
}

function withKey(pubmedApiKey = "abc123") {
  mockUseSettings.mockReturnValue(settingsState({ settings: { pubmedApiKey } }));
}

describe("Settings → PubMed action grouping", () => {
  it("renders Save inside the PubMed API Key section", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(within(pubmedSection()).getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("renders Remove Key inside the PubMed API Key section when a key is stored", () => {
    withKey();
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(within(pubmedSection()).getByRole("button", { name: "Remove Key" })).toBeInTheDocument();
  });

  it("keeps both PubMed actions in the same container as the field they act on", () => {
    withKey();
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const section = pubmedSection();
    expect(within(section).getByLabelText("PubMed API Key (NCBI)")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Remove Key" })).toBeInTheDocument();
  });

  it("places the PubMed actions before the Storage section in DOM order", () => {
    withKey();
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const save = screen.getByRole("button", { name: "Save" });
    const storage = screen.getByRole("heading", { name: "Storage" });

    // Node.DOCUMENT_POSITION_FOLLOWING — Storage comes after the PubMed actions,
    // so tab order reaches Save/Remove Key straight after the field and its help.
    expect(save.compareDocumentPosition(storage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("no longer renders a dialog-level footer holding the PubMed actions", () => {
    withKey();
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    // Queried from the portalled dialog, not the render container — Radix
    // mounts the content outside it, so a container-scoped query would pass
    // vacuously. `flex-col-reverse` is DialogFooter's signature class and the
    // Settings dialog no longer has any other element using it.
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".flex-col-reverse")).toBeNull();

    for (const name of ["Save", "Remove Key"]) {
      const button = screen.getByRole("button", { name });
      expect(button.closest(".flex-col-reverse")).toBeNull();
      expect(button.closest("section")).toBe(pubmedSection());
    }
  });
});

describe("Settings holds application settings only", () => {
  it("renders the two configuration surfaces it owns", () => {
    withKey();
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("PubMed API Key (NCBI)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
  });

  it("no longer renders the Account data section", () => {
    withKey();
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.queryByRole("heading", { name: "Account data" })).toBeNull();
    expect(screen.queryByRole("button", { name: /export account data/i })).toBeNull();
  });

  it("no longer renders the Danger zone", () => {
    withKey();
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete account" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("owns no account-lifecycle state, not merely no account UI", () => {
    // A rendered-DOM assertion cannot see a hook that is mounted but renders
    // nothing, and that is exactly what would remain if only the JSX had been
    // deleted. So this reads the committed component instead — the same
    // source-inspection convention the extension boundary suites use.
    const source = readFileSync(
      resolve(process.cwd(), "src/components/settings/SettingsDialog.tsx"),
      "utf-8",
    );

    // Self-check: the read is real and the file is the one under test.
    expect(source).toContain("useStorageUsage");

    for (const account of [
      "useAccountExport",
      "useAccountDeletion",
      "AccountDataSection",
      "DeleteAccountSection",
    ]) {
      expect(source).not.toContain(account);
    }
  });

  it("keeps Remove Key as a PubMed action, not an account action", () => {
    withKey();
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    // The only destructive-looking control left in Settings clears one API key.
    const remove = within(pubmedSection()).getByRole("button", { name: "Remove Key" });
    expect(remove.closest("section")).toBe(pubmedSection());
  });
});

describe("Settings → PubMed action behavior is unchanged", () => {
  it("saves the trimmed key and closes the dialog", async () => {
    const setPubmedApiKey = vi.fn().mockResolvedValue(null);
    mockUseSettings.mockReturnValue(settingsState({ setPubmedApiKey }));
    const onOpenChange = vi.fn();
    render(<SettingsDialog open onOpenChange={onOpenChange} userId="user-1" />);

    fireEvent.change(screen.getByLabelText("PubMed API Key (NCBI)"), {
      target: { value: "  key-value  " },
    });
    fireEvent.click(within(pubmedSection()).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(setPubmedApiKey).toHaveBeenCalledExactlyOnceWith("key-value"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("still saves on Enter from the field", async () => {
    const setPubmedApiKey = vi.fn().mockResolvedValue(null);
    mockUseSettings.mockReturnValue(settingsState({ setPubmedApiKey }));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const field = screen.getByLabelText("PubMed API Key (NCBI)");
    fireEvent.change(field, { target: { value: "typed-key" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(setPubmedApiKey).toHaveBeenCalledExactlyOnceWith("typed-key"));
  });

  it("removes the stored key without closing the dialog", async () => {
    const clearPubmedApiKey = vi.fn().mockResolvedValue(null);
    mockUseSettings.mockReturnValue(
      settingsState({ settings: { pubmedApiKey: "abc123" }, clearPubmedApiKey }),
    );
    const onOpenChange = vi.fn();
    render(<SettingsDialog open onOpenChange={onOpenChange} userId="user-1" />);

    fireEvent.click(within(pubmedSection()).getByRole("button", { name: "Remove Key" }));

    await waitFor(() => expect(clearPubmedApiKey).toHaveBeenCalledOnce());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByLabelText("PubMed API Key (NCBI)")).toHaveValue(""));
  });

  it("hides Remove Key when no key is stored", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.queryByRole("button", { name: "Remove Key" })).toBeNull();
    expect(within(pubmedSection()).getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("disables Save while the field is empty or whitespace", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const save = within(pubmedSection()).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("PubMed API Key (NCBI)"), { target: { value: "   " } });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("PubMed API Key (NCBI)"), { target: { value: "k" } });
    expect(save).toBeEnabled();
  });

  it("disables both actions while a save is in flight", async () => {
    let release: (value: null) => void = () => {};
    const setPubmedApiKey = vi.fn(
      () => new Promise<null>((resolve) => { release = resolve; }),
    );
    mockUseSettings.mockReturnValue(
      settingsState({ settings: { pubmedApiKey: "abc123" }, setPubmedApiKey }),
    );
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    fireEvent.change(screen.getByLabelText("PubMed API Key (NCBI)"), { target: { value: "next" } });
    fireEvent.click(within(pubmedSection()).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(within(pubmedSection()).getByRole("button", { name: "Save" })).toBeDisabled();
    });
    expect(within(pubmedSection()).getByRole("button", { name: "Remove Key" })).toBeDisabled();
    expect(screen.getByLabelText("PubMed API Key (NCBI)")).toBeDisabled();

    release(null);
  });

  it("reports a failed save through the toast and keeps the dialog open", async () => {
    const setPubmedApiKey = vi.fn().mockResolvedValue(new Error("nope"));
    mockUseSettings.mockReturnValue(settingsState({ setPubmedApiKey }));
    const onOpenChange = vi.fn();
    render(<SettingsDialog open onOpenChange={onOpenChange} userId="user-1" />);

    fireEvent.change(screen.getByLabelText("PubMed API Key (NCBI)"), { target: { value: "k" } });
    fireEvent.click(within(pubmedSection()).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Error saving API key", variant: "destructive" }),
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("Settings → PubMed loading state", () => {
  it("renders no PubMed actions while the settings are loading", () => {
    mockUseSettings.mockReturnValue(
      settingsState({ loading: true, settings: { pubmedApiKey: "abc123" } }),
    );
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.queryByLabelText("PubMed API Key (NCBI)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Key" })).toBeNull();
  });

  it("keeps the Storage section mounted while the PubMed settings load", () => {
    mockUseSettings.mockReturnValue(settingsState({ loading: true }));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
  });
});
