import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockUseAccountExport, mockUseAccountDeletion } = vi.hoisted(() => ({
  mockUseAccountExport: vi.fn(),
  mockUseAccountDeletion: vi.fn(),
}));

vi.mock("@/hooks/useAccountExport", () => ({ useAccountExport: mockUseAccountExport }));
vi.mock("@/hooks/useAccountDeletion", () => ({ useAccountDeletion: mockUseAccountDeletion }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { AccountDialog } from "../AccountDialog";

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
  mockUseAccountExport.mockReturnValue(exportState());
  mockUseAccountDeletion.mockReturnValue({
    deleteAccount: vi.fn(),
    isDeleting: false,
    canDelete: true,
  });
});

describe("AccountDialog — Account data section (PFA-C02)", () => {
  it("renders the Account data section", () => {
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("heading", { name: "Account data" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /export account data/i }),
    ).toBeInTheDocument();
    // The description states the exclusion the user cares about.
    expect(screen.getByText(/API keys and credentials are never included/i)).toBeInTheDocument();
  });

  it("enables the export action for an authenticated user", () => {
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("button", { name: /export account data/i })).toBeEnabled();
    expect(mockUseAccountExport).toHaveBeenLastCalledWith("user-1");
  });

  it("starts an export on click", async () => {
    const exportAccountData = vi.fn();
    mockUseAccountExport.mockReturnValue(exportState({ exportAccountData }));
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    fireEvent.click(screen.getByRole("button", { name: /export account data/i }));

    expect(exportAccountData).toHaveBeenCalledTimes(1);
  });

  it("does not attempt an export during a nullable auth transition", async () => {
    const exportAccountData = vi.fn();
    mockUseAccountExport.mockReturnValue(
      exportState({ exportAccountData, canExport: false }),
    );
    render(<AccountDialog open onOpenChange={vi.fn()} />);

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
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

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
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Downloading attachments 3 of 12…");
  });

  it("hides the progress status when idle", () => {
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("returns the button to a usable state after a failure", async () => {
    const exportAccountData = vi.fn();
    // A failed run resets the hook to idle; the section must be usable again.
    mockUseAccountExport.mockReturnValue(exportState({ exportAccountData }));
    const { rerender } = render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    mockUseAccountExport.mockReturnValue(exportState({ exportAccountData, isExporting: true }));
    rerender(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);
    expect(screen.getByRole("button", { name: /export account data/i })).toBeDisabled();

    mockUseAccountExport.mockReturnValue(exportState({ exportAccountData }));
    rerender(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const button = screen.getByRole("button", { name: /export account data/i });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(exportAccountData).toHaveBeenCalledTimes(1);
  });
});

describe("AccountDialog — section independence", () => {
  it("keeps the Danger zone rendered and usable during an export", () => {
    mockUseAccountExport.mockReturnValue(exportState({ isExporting: true }));
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeInTheDocument();
    // Neither section gates the other: the export is not a prerequisite for
    // deletion and an in-flight export does not disable it.
    expect(screen.getByRole("button", { name: "Delete account" })).toBeEnabled();
  });

  it("keeps the export available while a deletion request is in flight", () => {
    mockUseAccountDeletion.mockReturnValue({
      deleteAccount: vi.fn(),
      isDeleting: true,
      canDelete: true,
    });
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByRole("button", { name: /export account data/i })).toBeEnabled();
  });
});

describe("AccountDialog — PFA-C02 scope boundaries", () => {
  it("shows no upgrade, checkout or paywall path", () => {
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    expect(
      screen.queryByRole("button", { name: /upgrade|buy|subscribe|checkout|plan/i }),
    ).toBeNull();
    expect(screen.queryByText(/upgrade|pro plan|paywall|billing/i)).toBeNull();
  });

  it("keeps export itself non-destructive and separate from deletion", () => {
    // PFA-C04 added account deletion, but it lives in its own Danger zone with
    // its own typed confirmation — the export action must never acquire
    // destructive semantics or a destructive confirmation of its own.
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const exportButton = screen.getByRole("button", { name: /export account data/i });
    expect(exportButton).toBeEnabled();
    expect(exportButton).not.toHaveAccessibleName(/delete|remove|erase/i);

    // The destructive action is a separate control in a separate section, and
    // no confirmation dialog is open merely because Account is open.
    const deleteButton = screen.getByRole("button", { name: "Delete account" });
    expect(deleteButton).not.toBe(exportButton);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("reads the non-destructive section before the destructive one", () => {
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const accountData = screen.getByRole("heading", { name: "Account data" });
    const dangerZone = screen.getByRole("heading", { name: "Danger zone" });

    // Node.DOCUMENT_POSITION_FOLLOWING — the export the Danger zone tells the
    // user to run first is also the one they reach first.
    expect(
      accountData.compareDocumentPosition(dangerZone) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("AccountDialog — dialog semantics", () => {
  it("gives the dialog an accessible title and description", () => {
    render(<AccountDialog open onOpenChange={vi.fn()} userId="user-1" />);

    const dialog = screen.getByRole("dialog", { name: "Account" });
    expect(dialog).toHaveAccessibleDescription(
      /export or permanently delete your paperlume account/i,
    );
  });

  it("renders no dialog or account sections while closed", () => {
    render(<AccountDialog open={false} onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Account data" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
  });
});
