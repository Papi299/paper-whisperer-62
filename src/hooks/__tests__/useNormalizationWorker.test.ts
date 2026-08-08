import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Mock normalizePaperData (main-thread fallback) ───────────────────
const mockNormalizePaperData = vi.fn((...args: unknown[]) => args[0]);
vi.mock("@/lib/normalizePaperData", () => ({
  normalizePaperData: (...args: unknown[]) => mockNormalizePaperData(...args),
}));

// ── Mock Worker ──────────────────────────────────────────────────────
let capturedOnMessage: ((event: MessageEvent) => void) | null = null;
let capturedOnError: ((event: ErrorEvent) => void) | null = null;
const mockPostMessage = vi.fn();
const mockTerminate = vi.fn();

class MockWorker {
  postMessage = mockPostMessage;
  terminate = mockTerminate;
  set onmessage(fn: (event: MessageEvent) => void) {
    capturedOnMessage = fn;
  }
  set onerror(fn: (event: ErrorEvent) => void) {
    capturedOnError = fn;
  }
}

vi.stubGlobal("Worker", MockWorker);

// ── Import after mocks ──────────────────────────────────────────────
import { useNormalizationWorker } from "../useNormalizationWorker";
import type { NormalizationConfig } from "@/lib/normalizePaperData";

// ── Test helpers ────────────────────────────────────────────────────
function makeRawPaper(title: string) {
  return {
    title,
    authors: [],
    year: 2024,
    journal: null,
    pmid: null,
    doi: null,
    abstract: null,
    keywords: [],
    mesh_terms: [],
    substances: [],
    study_type: null,
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
  };
}

const dummyConfig: NormalizationConfig = {
  synonymLookup: {},
  poolStudyTypes: [],
  poolKeywords: [],
  synonymGroups: [],
};

describe("useNormalizationWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnMessage = null;
    capturedOnError = null;
  });

  it("uses synchronous main-thread path for small batches (<=10 papers)", async () => {
    const { result } = renderHook(() => useNormalizationWorker());
    const papers = [makeRawPaper("Paper 1")];

    await act(async () => {
      await result.current.normalize(papers, dummyConfig);
    });

    // normalizePaperData was called, Worker was NOT instantiated
    expect(mockNormalizePaperData).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("delegates to Worker for large batches (>10 papers)", async () => {
    const { result } = renderHook(() => useNormalizationWorker());
    const papers = Array.from({ length: 11 }, (_, i) => makeRawPaper(`Paper ${i}`));

    let normalizePromise: Promise<unknown>;
    act(() => {
      normalizePromise = result.current.normalize(papers, dummyConfig);
    });

    // Worker should have been instantiated and postMessage called
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockNormalizePaperData).not.toHaveBeenCalled();

    // Simulate worker response
    const postedMessage = mockPostMessage.mock.calls[0][0];
    act(() => {
      capturedOnMessage!({ data: { id: postedMessage.id, results: papers } } as MessageEvent);
    });

    const results = await normalizePromise!;
    expect(results).toEqual(papers);
  });

  it("rejects pending promises on worker error (not resolves with [])", async () => {
    const { result } = renderHook(() => useNormalizationWorker());
    const papers = Array.from({ length: 11 }, (_, i) => makeRawPaper(`Paper ${i}`));

    let normalizePromise: Promise<unknown>;
    act(() => {
      normalizePromise = result.current.normalize(papers, dummyConfig);
    });

    // Simulate worker error
    act(() => {
      capturedOnError!({ message: "Worker crashed" } as ErrorEvent);
    });

    await expect(normalizePromise!).rejects.toThrow("Normalization worker error: Worker crashed");
  });

  it("rejects all pending promises when worker errors with multiple in flight", async () => {
    const { result } = renderHook(() => useNormalizationWorker());
    const papers = Array.from({ length: 11 }, (_, i) => makeRawPaper(`Paper ${i}`));

    let promise1: Promise<unknown>;
    let promise2: Promise<unknown>;
    act(() => {
      promise1 = result.current.normalize(papers, dummyConfig);
      promise2 = result.current.normalize(papers, dummyConfig);
    });

    // Both should have been posted
    expect(mockPostMessage).toHaveBeenCalledTimes(2);

    // Simulate worker error — should reject both
    act(() => {
      capturedOnError!({ message: "Worker crashed" } as ErrorEvent);
    });

    await expect(promise1!).rejects.toThrow("Normalization worker error");
    await expect(promise2!).rejects.toThrow("Normalization worker error");
  });

  it("handles worker error with no message gracefully", async () => {
    const { result } = renderHook(() => useNormalizationWorker());
    const papers = Array.from({ length: 11 }, (_, i) => makeRawPaper(`Paper ${i}`));

    let normalizePromise: Promise<unknown>;
    act(() => {
      normalizePromise = result.current.normalize(papers, dummyConfig);
    });

    // Simulate worker error with no message
    act(() => {
      capturedOnError!({} as ErrorEvent);
    });

    await expect(normalizePromise!).rejects.toThrow("Normalization worker error: unknown error");
  });

  // ── Structured publication-type provenance across both paths ─────────
  //
  // Which path runs is a batch-size accident, so the structured publication
  // types have to reach normalization identically either side of the threshold.
  // Losing them above it would silently split an official comma-bearing type
  // for large imports only.

  const structuredPaper = {
    ...makeRawPaper("Structured Paper"),
    study_type: "Clinical Trial, Phase II, Multicenter Study",
    publication_types: ["Clinical Trial, Phase II", "Multicenter Study"],
  };

  it("keeps publication_types on the main-thread path (<= threshold)", async () => {
    const { result } = renderHook(() => useNormalizationWorker());

    await act(async () => {
      await result.current.normalize([structuredPaper], dummyConfig);
    });

    const [rawPaper] = mockNormalizePaperData.mock.calls[0] as [typeof structuredPaper];
    expect(rawPaper.publication_types).toEqual([
      "Clinical Trial, Phase II",
      "Multicenter Study",
    ]);
  });

  it("keeps publication_types in the worker message (> threshold)", async () => {
    const { result } = renderHook(() => useNormalizationWorker());
    const papers = Array.from({ length: 11 }, () => ({ ...structuredPaper }));

    let normalizePromise: Promise<unknown>;
    act(() => {
      normalizePromise = result.current.normalize(papers, dummyConfig);
    });

    const posted = mockPostMessage.mock.calls[0][0];
    expect(posted.papers).toHaveLength(11);
    for (const paper of posted.papers) {
      expect(paper.publication_types).toEqual([
        "Clinical Trial, Phase II",
        "Multicenter Study",
      ]);
    }

    // The posted payload must also survive structured clone, which is what the
    // real Worker boundary applies to it.
    const cloned = structuredClone(posted);
    expect(cloned.papers[0].publication_types).toEqual([
      "Clinical Trial, Phase II",
      "Multicenter Study",
    ]);

    act(() => {
      capturedOnMessage!({ data: { id: posted.id, results: papers } } as MessageEvent);
    });
    await normalizePromise!;
  });
});
