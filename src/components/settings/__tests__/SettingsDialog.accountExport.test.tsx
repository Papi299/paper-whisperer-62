import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockUseSettings, mockUseStorageUsage, mockUseAccountExport, mockUseAccountDeletion } =
  vi.hoisted(() => ({
    mockUseSettings: vi.fn(),
    mockUseStorageUsage: vi.fn(),
    mockUseAccountExport: vi.fn(),
    mockUseAccountDeletion: vi.fn(),
  }));

vi.mock("@/hooks/useSettings", () => ({ useSettings: mockUseSettings }));
vi.mock("@/hooks/useStorageUsage", () => ({ useStorageUsage: mockUseStorageUsage }));
vi.mock("@/hooks/useAccountExport", () => ({ useAccountExport: mockUseAccountExport }));
vi.mock("@/hooks/useAccountDeletion", () => ({ useAccountDeletion: mockUseAccountDeletion }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { SettingsDialog } from "../SettingsDialog";

const MB = 1024 * 1024;

const NORMAL_STORAGE = {
  usedBytes: 124 * MB,
  quotaBytes: 500 * MB,
  remainingBytes: 376 * MB,
  percentUsed: 25,
  isAtOrOverQuota: false,
};

function settingsState(loading = false) {
  return {
    settings: { pubmedApiKey: null },
    loading,
    setPubmedApiKey: vi.fn(),
    clearPubmedApiKey: vi.fn(),
  };
}

function exportState(overrides: Record<string, unknown> = {}) {
  return {
    exportAccountData: vi.fn(),
    isExporting: false,
    progress: null,
    canExport: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSettings.mockReturnValue(settingsState());
  mockUseStorageUsage.mockReturnValue({
    status: NORMAL_STORAGE,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUseAccountExport.mockReturnValue(exportState());
  mockUseAccountDeletion.mockReturnValue({
    deleteAccount: vi.fn(),
    isDeleting: false,
    canDelete: true,
  });
});

describe("SettingsDialog — Account data section (PFA-C02)", () => {
  it("renders the Account data section", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("heading", { name: "Account data" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /export account data/i }),
    ).toBeInTheDocument();
    // The description states the exclusion the user cares about.
    expect(screen.getByText(/API keys and credentials are never included/i)).toBeInTheDocument();
  });

  it("enables the export action for an authenticated user", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("button", { name: /export account data/i })).toBeEnabled();
    expect(mockUseAccountExport).toHaveBeenLastCalledWith("user-1");
  });

  it("starts an export on click", async () => {
    const exportAccountData = vi.fn();
    mockUseAccountExport.mockReturnValue(exportState({ exportAccountData }));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    fireEvent.click(screen.getByRole("button", { name: /export account data/i }));

    expect(exportAccountData).toHaveBeenCalledTimes(1);
  });

  it("does not attempt an export during a nullable auth transition", async () => {
    const exportAccountData = vi.fn();
    mockUseAccountExport.mockReturnValue(
      exportState({ exportAccountData, canExport: false }),
    );
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(mockUseAccountExport).toHaveBeenLastCalledWith(undefined);
    const button = screen.getByRole("button", { name: /export account data/i });
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(exportAccountData).not.toHaveBeenCalled();
  });

  it("prevents duplicate starts while a run is in progress", async () => {
    const exportAccountData = vi.fn();
    mockUseAccountExport.mockReturnValue(
      exportState({ exportAccountData, isExporting: true, progress: { stage: "collecting" } }),
    );
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const button = screen.getByRole("button", { name: /export account data/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");

    fireEvent.click(button);
    fireEvent.click(button);
    expect(exportAccountData).not.toHaveBeenCalled();
  });

  it("shows a bounded progress status while running", () => {
    mockUseAccountExport.mockReturnValue(
      exportState({ isExporting: true, progress: { stage: "attachments", current: 2, total: 12 } }),
    );
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Downloading attachments 3 of 12…");
  });

  it("hides the progress status when idle", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("returns the button to a usable state after a failure", async () => {
    const exportAccountData = vi.fn();
    // A failed run resets the hook to idle; the section must be usable again.
    mockUseAccountExport.mockReturnValue(exportState({ exportAccountData }));
    const { rerender } = render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    mockUseAccountExport.mockReturnValue(exportState({ exportAccountData, isExporting: true }));
    rerender(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    expect(screen.getByRole("button", { name: /export account data/i })).toBeDisabled();

    mockUseAccountExport.mockReturnValue(exportState({ exportAccountData }));
    rerender(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const button = screen.getByRole("button", { name: /export account data/i });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(exportAccountData).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsDialog — section independence", () => {
  it("keeps the PubMed API-key controls independent of an export in progress", () => {
    mockUseAccountExport.mockReturnValue(exportState({ isExporting: true }));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByLabelText("PubMed API Key (NCBI)")).toBeEnabled();
  });

  it("keeps the Storage section independent of an export in progress", () => {
    mockUseAccountExport.mockReturnValue(exportState({ isExporting: true }));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("124 MB of 500 MB used")).toBeInTheDocument();
  });

  it("renders Account data even when the PubMed settings are still loading", () => {
    mockUseSettings.mockReturnValue(settingsState(true));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.queryByLabelText("PubMed API Key (NCBI)")).toBeNull();
    expect(screen.getByRole("heading", { name: "Account data" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export account data/i })).toBeEnabled();
  });

  it("renders Account data even when the Storage gauge is unavailable", () => {
    mockUseStorageUsage.mockReturnValue({
      status: null,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByText("Storage usage unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export account data/i })).toBeEnabled();
  });
});

describe("SettingsDialog — PFA-C02 scope boundaries", () => {
  it("shows no upgrade, checkout or paywall path", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(
      screen.queryByRole("button", { name: /upgrade|buy|subscribe|checkout|plan/i }),
    ).toBeNull();
    expect(screen.queryByText(/upgrade|pro plan|paywall|billing/i)).toBeNull();
  });

  it("keeps export itself non-destructive and separate from deletion", () => {
    // PFA-C04 added account deletion, but it lives in its own Danger zone with
    // its own typed confirmation — the export action must never acquire
    // destructive semantics or a destructive confirmation of its own.
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const exportButton = screen.getByRole("button", { name: /export account data/i });
    expect(exportButton).toBeEnabled();
    expect(exportButton).not.toHaveAccessibleName(/delete|remove|erase/i);

    // The destructive action is a separate control in a separate section, and
    // no confirmation dialog is open merely because Settings is open.
    const deleteButton = screen.getByRole("button", { name: "Delete account" });
    expect(deleteButton).not.toBe(exportButton);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
