import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockUseSettings, mockUseStorageUsage } = vi.hoisted(() => ({
  mockUseSettings: vi.fn(),
  mockUseStorageUsage: vi.fn(),
}));

vi.mock("@/hooks/useSettings", () => ({ useSettings: mockUseSettings }));
vi.mock("@/hooks/useStorageUsage", () => ({ useStorageUsage: mockUseStorageUsage }));
// The Danger zone's hook reaches for the React Query client; this suite renders
// Settings without a provider, so it is stubbed out. Its own behaviour is
// covered by SettingsDialog.accountDeletion.test.tsx.
vi.mock("@/hooks/useAccountDeletion", () => ({
  useAccountDeletion: () => ({ deleteAccount: vi.fn(), isDeleting: false, canDelete: true }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
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

const NORMAL_STATUS = {
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

function storageState(overrides: Record<string, unknown> = {}) {
  return { status: null, isLoading: false, isError: false, refetch: vi.fn(), ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSettings.mockReturnValue(settingsState());
  mockUseStorageUsage.mockReturnValue(storageState({ status: NORMAL_STATUS }));
});

describe("SettingsDialog — Storage section", () => {
  it("renders the Storage gauge alongside the unchanged PubMed control", () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByLabelText("PubMed API Key (NCBI)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("124 MB of 500 MB used")).toBeInTheDocument();
    expect(screen.getByText("376 MB remaining")).toBeInTheDocument();
  });

  it("queries storage for the passed-in user only while the dialog is open", () => {
    const { rerender } = render(
      <SettingsDialog open={true} onOpenChange={vi.fn()} userId="user-1" />,
    );
    expect(mockUseStorageUsage).toHaveBeenLastCalledWith("user-1", { enabled: true });

    rerender(<SettingsDialog open={false} onOpenChange={vi.fn()} userId="user-1" />);
    expect(mockUseStorageUsage).toHaveBeenLastCalledWith("user-1", { enabled: false });
  });

  it("stays nullable-safe during an auth transition (no user id asserted)", () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    expect(mockUseStorageUsage).toHaveBeenLastCalledWith(undefined, { enabled: true });
  });

  it("keeps the PubMed control usable while storage is still loading", () => {
    mockUseStorageUsage.mockReturnValue(storageState({ isLoading: true }));
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByLabelText("Loading storage usage")).toBeInTheDocument();
    const input = screen.getByLabelText("PubMed API Key (NCBI)");
    expect(input).toBeInTheDocument();
    expect(input).toBeEnabled();
  });

  it("keeps the PubMed control usable when storage is unavailable", () => {
    mockUseStorageUsage.mockReturnValue(storageState({ isError: true }));
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} userId="user-1" />);

    expect(screen.getByText("Storage usage unavailable.")).toBeInTheDocument();
    expect(screen.getByLabelText("PubMed API Key (NCBI)")).toBeEnabled();
  });

  it("shows the Storage section even while the PubMed settings are still loading", () => {
    mockUseSettings.mockReturnValue(settingsState(true));
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} userId="user-1" />);

    // The PubMed loader must not replace the whole dialog body.
    expect(screen.queryByLabelText("PubMed API Key (NCBI)")).toBeNull();
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("124 MB of 500 MB used")).toBeInTheDocument();
  });
});
