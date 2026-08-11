import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
import { ACCOUNT_DELETION_CONFIRMATION } from "@/lib/accountDeletion";

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

function deletionState(overrides: Record<string, unknown> = {}) {
  return { deleteAccount: vi.fn(), isDeleting: false, canDelete: true, ...overrides };
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
  mockUseAccountExport.mockReturnValue({
    exportAccountData: vi.fn(),
    isExporting: false,
    progress: null,
    canExport: true,
  });
  mockUseAccountDeletion.mockReturnValue(deletionState());
});

/** The Danger-zone trigger inside the Settings dialog (not the final action). */
function dangerZoneButton() {
  return screen.getByRole("button", { name: "Delete account" });
}

/** The destructive confirmation dialog, which is an `alertdialog`. */
function confirmDialog() {
  return screen.getByRole("alertdialog");
}

async function openConfirmDialog() {
  fireEvent.click(dangerZoneButton());
  await waitFor(() => expect(confirmDialog()).toBeInTheDocument());
  return confirmDialog();
}

describe("Settings → Danger zone", () => {
  it("renders a clearly separated Danger zone", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeInTheDocument();
    expect(dangerZoneButton()).toBeEnabled();
  });

  it("warns about permanence and recommends exporting first", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/exporting your account data first/i)).toBeInTheDocument();
  });

  it("keeps deletion separate from the export action", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    // Two distinct sections, two distinct actions — never one ambiguous group.
    expect(screen.getByRole("heading", { name: "Account data" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export account data/i })).toBeInTheDocument();
    expect(dangerZoneButton()).toBeInTheDocument();
  });

  it("does not delete anything on the first click — it only opens a dialog", async () => {
    const deleteAccount = vi.fn();
    mockUseAccountDeletion.mockReturnValue(deletionState({ deleteAccount }));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await openConfirmDialog();

    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("stays disabled during an auth transition", () => {
    mockUseAccountDeletion.mockReturnValue(deletionState({ canDelete: false }));
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(mockUseAccountDeletion).toHaveBeenLastCalledWith(undefined);
    expect(dangerZoneButton()).toBeDisabled();
  });
});

describe("Delete-account confirmation dialog", () => {
  it("states exactly what is removed and that it is irreversible", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    const dialog = await openConfirmDialog();

    expect(within(dialog).getByRole("heading", { name: /delete your account\?/i })).toBeInTheDocument();
    for (const mention of [
      /papers and notes/i,
      /projects/i,
      /tags/i,
      /saved searches/i,
      /pools/i,
      /settings/i,
      /attached to a paper/i,
    ]) {
      expect(within(dialog).getByText(mention, { exact: false })).toBeInTheDocument();
    }
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot restore a deleted account/i)).toBeInTheDocument();
  });

  it("points the user at the export before deleting", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    const dialog = await openConfirmDialog();

    expect(within(dialog).getByText(/export account data/i)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/deleting does not export anything for you/i),
    ).toBeInTheDocument();
  });

  it("disables the final action until the phrase is typed", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    const dialog = await openConfirmDialog();

    expect(within(dialog).getByRole("button", { name: "Delete my account" })).toBeDisabled();
  });

  it.each([
    "DELETE",
    "delete my account",
    "Delete My Account",
    "DELETE MY ACCOUNT ",
    "DELETE  MY ACCOUNT",
  ])("keeps the final action disabled for the wrong phrase %j", async (phrase) => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    const dialog = await openConfirmDialog();

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: phrase } });

    expect(within(dialog).getByRole("button", { name: "Delete my account" })).toBeDisabled();
  });

  it("enables the final action only for the exact phrase", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    const dialog = await openConfirmDialog();

    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: ACCOUNT_DELETION_CONFIRMATION },
    });

    expect(within(dialog).getByRole("button", { name: "Delete my account" })).toBeEnabled();
  });

  it("invokes deletion with the typed phrase", async () => {
    const deleteAccount = vi.fn();
    mockUseAccountDeletion.mockReturnValue(deletionState({ deleteAccount }));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    const dialog = await openConfirmDialog();

    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: ACCOUNT_DELETION_CONFIRMATION },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete my account" }));

    expect(deleteAccount).toHaveBeenCalledExactlyOnceWith(ACCOUNT_DELETION_CONFIRMATION);
  });

  it("cancels without invoking deletion", async () => {
    const deleteAccount = vi.fn();
    mockUseAccountDeletion.mockReturnValue(deletionState({ deleteAccount }));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    const dialog = await openConfirmDialog();

    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: ACCOUNT_DELETION_CONFIRMATION },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("forgets a previously typed phrase when reopened", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    let dialog = await openConfirmDialog();

    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: ACCOUNT_DELETION_CONFIRMATION },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    dialog = await openConfirmDialog();
    expect(within(dialog).getByRole("textbox")).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "Delete my account" })).toBeDisabled();
  });

  it("blocks duplicate submissions while the request is in flight", async () => {
    const deleteAccount = vi.fn();
    mockUseAccountDeletion.mockReturnValue(deletionState({ deleteAccount }));
    const { rerender } = render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const dialog = await openConfirmDialog();
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: ACCOUNT_DELETION_CONFIRMATION },
    });

    // Transition to the in-flight state the way the real hook does.
    mockUseAccountDeletion.mockReturnValue(deletionState({ deleteAccount, isDeleting: true }));
    rerender(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const action = within(confirmDialog()).getByRole("button", { name: /deleting account/i });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-busy", "true");
    fireEvent.click(action);
    fireEvent.click(action);
    expect(deleteAccount).not.toHaveBeenCalled();

    // The cancel affordance is also inert mid-flight, so the dialog cannot be
    // dismissed out from under an in-progress destructive request.
    expect(within(confirmDialog()).getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("keeps the account UI usable after a failed deletion", async () => {
    const deleteAccount = vi.fn();
    mockUseAccountDeletion.mockReturnValue(deletionState({ deleteAccount }));
    const { rerender } = render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    const dialog = await openConfirmDialog();

    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: ACCOUNT_DELETION_CONFIRMATION },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete my account" }));

    // The hook resolves back to idle after a failure; the dialog and the
    // Settings sections behind it stay interactive.
    mockUseAccountDeletion.mockReturnValue(deletionState({ deleteAccount, isDeleting: false }));
    rerender(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(within(confirmDialog()).getByRole("button", { name: "Delete my account" })).toBeEnabled();
    expect(screen.getByLabelText("PubMed API Key (NCBI)")).toBeEnabled();
  });

  it("never renders raw backend error text", async () => {
    // The section renders no error surface of its own; failures reach the user
    // only through the toast, whose copy the hook normalizes.
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    await openConfirmDialog();

    expect(screen.queryByText(/permission denied|storage_cleanup_failed|sb_secret|service_role/i))
      .toBeNull();
  });
});

describe("Danger zone — section independence", () => {
  it("keeps the PubMed controls usable while a deletion is in flight", () => {
    mockUseAccountDeletion.mockReturnValue(deletionState({ isDeleting: true }));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByLabelText("PubMed API Key (NCBI)")).toBeEnabled();
  });

  it("keeps the Storage gauge rendered while a deletion is in flight", () => {
    mockUseAccountDeletion.mockReturnValue(deletionState({ isDeleting: true }));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("124 MB of 500 MB used")).toBeInTheDocument();
  });

  it("keeps the full account export available while a deletion is in flight", () => {
    mockUseAccountDeletion.mockReturnValue(deletionState({ isDeleting: true }));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("button", { name: /export account data/i })).toBeEnabled();
  });

  it("renders the Danger zone even when the PubMed settings are still loading", () => {
    mockUseSettings.mockReturnValue(settingsState(true));
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.queryByLabelText("PubMed API Key (NCBI)")).toBeNull();
    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeInTheDocument();
  });

  it("adds no upgrade, checkout, or paywall path", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} userId="user-1" />);
    await openConfirmDialog();

    expect(
      screen.queryByRole("button", { name: /upgrade|buy|subscribe|checkout|downgrade/i }),
    ).toBeNull();
    expect(screen.queryByText(/upgrade|pro plan|paywall|billing|refund/i)).toBeNull();
  });
});
