import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const {
  mockToast,
  mockFetchData,
  mockBuildArchive,
  mockTriggerDownload,
  mockCreateDownloader,
} = vi.hoisted(() => ({
  mockToast: vi.fn(),
  mockFetchData: vi.fn(),
  mockBuildArchive: vi.fn(),
  mockTriggerDownload: vi.fn(),
  mockCreateDownloader: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock("@/lib/accountExport/fetchAccountExportData", () => ({
  fetchAccountExportData: mockFetchData,
}));
vi.mock("@/lib/accountExport/buildAccountExportArchive", () => ({
  buildAccountExportArchive: mockBuildArchive,
}));
vi.mock("@/lib/accountExport/fetchAttachmentBinaries", () => ({
  createAttachmentDownloader: mockCreateDownloader,
}));
vi.mock("@/lib/accountExport/downloadAccountExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountExport/downloadAccountExport")>();
  return { ...actual, triggerArchiveDownload: mockTriggerDownload };
});

import { useAccountExport } from "../useAccountExport";
import { AccountExportError } from "@/lib/accountExport/types";

const USER = "user-a";
const FAKE_DATA = { papers: [], paper_attachments: [] };
const FAKE_BLOB = new Blob(["zip"], { type: "application/zip" });

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchData.mockResolvedValue(FAKE_DATA);
  mockBuildArchive.mockResolvedValue({ blob: FAKE_BLOB, manifest: { version: 1 } });
  mockCreateDownloader.mockReturnValue(vi.fn());
});

describe("useAccountExport", () => {
  it("runs the full pipeline and downloads exactly one archive", async () => {
    const { result } = renderHook(() => useAccountExport(USER));

    await act(async () => {
      await result.current.exportAccountData();
    });

    expect(mockFetchData).toHaveBeenCalledExactlyOnceWith(USER);
    expect(mockBuildArchive).toHaveBeenCalledTimes(1);
    expect(mockTriggerDownload).toHaveBeenCalledTimes(1);

    const [blob, fileName] = mockTriggerDownload.mock.calls[0];
    expect(blob).toBe(FAKE_BLOB);
    expect(fileName).toMatch(/^paperlume-account-export-.+Z\.zip$/);

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Account data exported" }),
    );
    expect(result.current.isExporting).toBe(false);
  });

  it("uses one instant for the manifest and the filename", async () => {
    const { result } = renderHook(() => useAccountExport(USER));

    await act(async () => {
      await result.current.exportAccountData();
    });

    const { generatedAt, userId } = mockBuildArchive.mock.calls[0][0];
    const expectedName = `paperlume-account-export-${generatedAt
      .toISOString()
      .slice(0, 19)
      .replace(/:/g, "-")}Z.zip`;

    expect(userId).toBe(USER);
    expect(mockTriggerDownload.mock.calls[0][1]).toBe(expectedName);
  });

  it("does not attempt an export during a nullable auth transition", async () => {
    const { result } = renderHook(() => useAccountExport(undefined));

    expect(result.current.canExport).toBe(false);

    await act(async () => {
      await result.current.exportAccountData();
    });

    expect(mockFetchData).not.toHaveBeenCalled();
    expect(mockBuildArchive).not.toHaveBeenCalled();
    expect(mockTriggerDownload).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("prevents a concurrent second run", async () => {
    let release: (value: unknown) => void = () => {};
    mockFetchData.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const { result } = renderHook(() => useAccountExport(USER));

    let firstRun: Promise<void> | undefined;
    act(() => {
      firstRun = result.current.exportAccountData();
    });

    await waitFor(() => expect(result.current.isExporting).toBe(true));

    // A second click while the first run is still in flight.
    await act(async () => {
      await result.current.exportAccountData();
    });
    expect(mockFetchData).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(FAKE_DATA);
      await firstRun;
    });

    expect(mockTriggerDownload).toHaveBeenCalledTimes(1);
  });

  it("exposes bounded progress while running and clears it afterwards", async () => {
    let release: (value: unknown) => void = () => {};
    mockBuildArchive.mockImplementation(
      async ({ onProgress }: { onProgress?: (p: unknown) => void }) => {
        onProgress?.({ stage: "attachments", current: 1, total: 4 });
        await new Promise((resolve) => { release = resolve; });
        return { blob: FAKE_BLOB, manifest: { version: 1 } };
      },
    );

    const { result } = renderHook(() => useAccountExport(USER));

    let run: Promise<void> | undefined;
    act(() => {
      run = result.current.exportAccountData();
    });

    // Mid-run the UI can render a concrete stage, not just a spinner.
    await waitFor(() =>
      expect(result.current.progress).toEqual({ stage: "attachments", current: 1, total: 4 }),
    );
    expect(result.current.isExporting).toBe(true);

    await act(async () => {
      release(undefined);
      await run;
    });

    expect(result.current.progress).toBeNull();
    expect(result.current.isExporting).toBe(false);
  });

  it("reports a safe message and resets when a category read fails", async () => {
    mockFetchData.mockRejectedValue(
      new AccountExportError("collecting", "Could not read your account data.", {
        cause: new Error("permission denied for relation papers"),
      }),
    );

    const { result } = renderHook(() => useAccountExport(USER));

    await act(async () => {
      await result.current.exportAccountData();
    });

    expect(mockBuildArchive).not.toHaveBeenCalled();
    // No archive download and no success toast on the failure path.
    expect(mockTriggerDownload).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledExactlyOnceWith({
      title: "Export failed",
      description: "Could not read your account data.",
      variant: "destructive",
    });
    expect(result.current.isExporting).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it("reports a safe message and downloads nothing when an attachment fails", async () => {
    mockBuildArchive.mockRejectedValue(
      new AccountExportError("attachments", "Could not download one of your attachments.", {
        cause: new Error("Object not found in bucket attachments"),
      }),
    );

    const { result } = renderHook(() => useAccountExport(USER));

    await act(async () => {
      await result.current.exportAccountData();
    });

    expect(mockTriggerDownload).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledExactlyOnceWith({
      title: "Export failed",
      description: "Could not download one of your attachments.",
      variant: "destructive",
    });
  });

  it("never leaks raw error detail from an unexpected failure", async () => {
    mockFetchData.mockRejectedValue(
      new Error("FetchError: https://xyz.supabase.co/rest/v1/papers?apikey=SECRET"),
    );

    const { result } = renderHook(() => useAccountExport(USER));

    await act(async () => {
      await result.current.exportAccountData();
    });

    const description = mockToast.mock.calls[0][0].description as string;
    expect(description).toBe("Could not export your account data.");
    expect(description).not.toContain("apikey");
    expect(description).not.toContain("supabase.co");
  });

  it("becomes usable again after a failure", async () => {
    mockFetchData.mockRejectedValueOnce(
      new AccountExportError("collecting", "Could not read your account data."),
    );

    const { result } = renderHook(() => useAccountExport(USER));

    await act(async () => {
      await result.current.exportAccountData();
    });
    expect(result.current.isExporting).toBe(false);

    await act(async () => {
      await result.current.exportAccountData();
    });
    expect(mockTriggerDownload).toHaveBeenCalledTimes(1);
  });
});
