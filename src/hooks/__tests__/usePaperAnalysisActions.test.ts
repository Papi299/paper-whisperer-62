import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * Hook tests for `usePaperAnalysisActions`.
 *
 * Cover the orchestration layer (state lifecycle, async sequence, toast
 * routing, per-paper failure isolation, cooldown control flow). The pure
 * merge / payload logic is already covered exhaustively by
 * `src/lib/__tests__/studyTypeUtils.test.ts` (PR #117) — these tests rely
 * on the real `buildAnalysisUpdates` and only verify a representative
 * `updates` shape and the `keptStudyType`-conditional toast description
 * once.
 *
 * Cooldown is tested via an injected `sleep` function (not `vi.useFakeTimers`),
 * which is faster and more deterministic. The injected `sleep` resolves
 * synchronously while the production default is a real 3-second
 * `setTimeout`-backed promise.
 */

// ── Supabase mock (hoisted) ───────────────────────────────────────────
const { mockInvoke, mockToast, mockInvalidateQueries, mockFetchAbstract, mockFetchAbstractsBatch } =
  vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockToast: vi.fn(),
    mockInvalidateQueries: vi.fn(),
    mockFetchAbstract: vi.fn(),
    mockFetchAbstractsBatch: vi.fn(),
  }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: mockInvoke } },
}));

// ── useToast mock ─────────────────────────────────────────────────────
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// ── TanStack Query mock ──────────────────────────────────────────────
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

// ── useAbstract mock ─────────────────────────────────────────────────
vi.mock("@/hooks/useAbstract", () => ({
  fetchAbstract: mockFetchAbstract,
  fetchAbstractsBatch: mockFetchAbstractsBatch,
}));

import { usePaperAnalysisActions } from "../usePaperAnalysisActions";
import type { PaperWithTags } from "@/types/database";

// ── Test fixtures ────────────────────────────────────────────────────

/** Build a minimal PaperWithTags fixture — only the fields the hook reads. */
function makePaper(overrides: Partial<PaperWithTags> = {}): PaperWithTags {
  return {
    id: "paper-1",
    user_id: "user-1",
    title: "Sample paper title",
    authors: [],
    year: 2024,
    journal: null,
    pmid: null,
    doi: null,
    has_abstract: true,
    study_type: null,
    raw_study_type: null,
    statistical_methods: null,
    keywords: [],
    raw_keywords: [],
    mesh_terms: [],
    substances: [],
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
    tldr: null,
    notes: null,
    insert_order: 0,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    tags: [],
    projects: [],
    paper_attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePaperAnalysisActions — single-paper", () => {
  it("skips papers without an abstract — no fetch, no invoke, no update, no toast", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paperNoAbstract = makePaper({ id: "p-no-abs", has_abstract: false });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [paperNoAbstract],
        selectedPaperIds: new Set<string>(),
        userId: "user-1",
        updatePaper,
        sleep,
      }),
    );

    await act(async () => {
      await result.current.handleAnalyzePaper(paperNoAbstract);
    });

    expect(mockFetchAbstract).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(updatePaper).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
    expect(result.current.analyzingPaperId).toBeNull();
  });

  it("analyzes one paper successfully and saves updates", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paper = makePaper({
      id: "p-1",
      title: "RCT of Drug X",
      study_type: null, // generic → AI value adopted
      tldr: null,
      statistical_methods: null,
    });
    mockFetchAbstract.mockResolvedValue("the abstract text");
    mockInvoke.mockResolvedValue({
      data: { tldr: "new tldr", studyType: "Randomized Controlled Trial", statisticalMethods: "ANOVA" },
      error: null,
    });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [paper],
        selectedPaperIds: new Set<string>(),
        userId: "user-1",
        updatePaper,
        sleep,
      }),
    );

    await act(async () => {
      await result.current.handleAnalyzePaper(paper);
    });

    expect(mockFetchAbstract).toHaveBeenCalledTimes(1);
    expect(mockFetchAbstract).toHaveBeenCalledWith("p-1", "user-1", expect.any(Object));
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("analyze-paper", {
      body: { title: "RCT of Drug X", abstract: "the abstract text" },
    });
    expect(updatePaper).toHaveBeenCalledTimes(1);
    expect(updatePaper).toHaveBeenCalledWith(
      "p-1",
      expect.objectContaining({
        tldr: "new tldr",
        study_type: "Randomized Controlled Trial",
        statistical_methods: "ANOVA",
      }),
    );
    // Default success-toast description (existing study_type was generic, so nothing was kept).
    expect(mockToast).toHaveBeenCalledWith({
      title: "Analysis complete and saved",
      description: "TLDR, study type, and statistical methods updated.",
    });
    await waitFor(() => expect(result.current.analyzingPaperId).toBeNull());
  });

  it("shows the 'No abstract' destructive toast when fetchAbstract returns null and does not invoke or update", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paper = makePaper({ id: "p-null-abs" });
    mockFetchAbstract.mockResolvedValue(null);

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [paper],
        selectedPaperIds: new Set<string>(),
        userId: "user-1",
        updatePaper,
        sleep,
      }),
    );

    await act(async () => {
      await result.current.handleAnalyzePaper(paper);
    });

    expect(mockFetchAbstract).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(updatePaper).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith({
      title: "No abstract",
      description: "Paper has no abstract to analyze.",
      variant: "destructive",
    });
    // The `finally` clears the analyzing state.
    await waitFor(() => expect(result.current.analyzingPaperId).toBeNull());
  });

  it("handles invoke error, surfaces 'AI Analysis failed' toast, and clears analyzing state", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paper = makePaper({ id: "p-err" });
    mockFetchAbstract.mockResolvedValue("abstract text");
    mockInvoke.mockResolvedValue({
      data: null,
      error: new Error("upstream gemini timeout"),
    });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [paper],
        selectedPaperIds: new Set<string>(),
        userId: "user-1",
        updatePaper,
        sleep,
      }),
    );

    await act(async () => {
      await result.current.handleAnalyzePaper(paper);
    });

    expect(updatePaper).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith({
      title: "AI Analysis failed",
      description: "upstream gemini timeout",
      variant: "destructive",
    });
    await waitFor(() => expect(result.current.analyzingPaperId).toBeNull());
  });
});

describe("usePaperAnalysisActions — bulk", () => {
  it("exits early with destructive toast when no selected papers have abstracts", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const p1 = makePaper({ id: "p1", has_abstract: false });
    const p2 = makePaper({ id: "p2", has_abstract: false });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [p1, p2],
        selectedPaperIds: new Set(["p1", "p2"]),
        userId: "user-1",
        updatePaper,
        sleep,
      }),
    );

    await act(async () => {
      await result.current.handleBulkAnalyze();
    });

    expect(mockFetchAbstractsBatch).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(updatePaper).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith({
      title: "No papers to analyze",
      description: "Selected papers have no abstracts.",
      variant: "destructive",
    });
    expect(result.current.bulkAnalyzing).toBe(false);
  });

  it("analyzes 2 selected papers successfully, sleeps once per success, and reports final counts", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const p1 = makePaper({ id: "p1", title: "Paper One", study_type: null });
    const p2 = makePaper({ id: "p2", title: "Paper Two", study_type: null });
    mockFetchAbstractsBatch.mockResolvedValue(
      new Map<string, string | null>([
        ["p1", "abs-one"],
        ["p2", "abs-two"],
      ]),
    );
    mockInvoke.mockResolvedValue({
      data: { tldr: "ai tldr", studyType: "Cohort Study", statisticalMethods: "regression" },
      error: null,
    });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [p1, p2],
        selectedPaperIds: new Set(["p1", "p2"]),
        userId: "user-1",
        updatePaper,
        sleep,
      }),
    );

    await act(async () => {
      await result.current.handleBulkAnalyze();
    });

    expect(mockFetchAbstractsBatch).toHaveBeenCalledTimes(1);
    expect(mockFetchAbstractsBatch).toHaveBeenCalledWith(["p1", "p2"], "user-1", expect.any(Object));
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(updatePaper).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 3000);
    expect(sleep).toHaveBeenNthCalledWith(2, 3000);
    // Final summary toast.
    expect(mockToast).toHaveBeenLastCalledWith({
      title: "Bulk analysis complete",
      description: "2 succeeded, 0 failed out of 2 papers.",
    });
    await waitFor(() => expect(result.current.bulkAnalyzing).toBe(false));
    expect(result.current.bulkAnalyzeProgress).toEqual({ current: 0, total: 0 });
  });

  it("continues after caught failure — cooldown runs after success and after caught failure, but NOT after missing-abstract skip", async () => {
    // 3 selected papers, all has_abstract: true.
    //   p1 — abstract present in batch map → success
    //   p2 — abstract MISSING from batch map (race / deleted) → failCount++, continue (skips cooldown)
    //   p3 — abstract present, but invoke returns { error } → caught failure (cooldown still runs)
    // Expected sleep call count: 2 (after p1 success, after p3 caught failure).
    // Expected updatePaper call count: 1 (p1 only).
    // Expected per-paper failure toast for p3 only.
    // Expected final summary: "1 succeeded, 2 failed out of 3 papers."

    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const p1 = makePaper({ id: "p1", title: "Paper One", study_type: null });
    const p2 = makePaper({ id: "p2", title: "Paper Two", study_type: null });
    const p3 = makePaper({ id: "p3", title: "Paper Three", study_type: null });

    // p2 is intentionally missing from the map — abstractMap.get("p2") returns undefined.
    mockFetchAbstractsBatch.mockResolvedValue(
      new Map<string, string | null>([
        ["p1", "abs-one"],
        ["p3", "abs-three"],
      ]),
    );

    // p1 → success; p3 → upstream error.
    mockInvoke.mockImplementation(async (_fn: string, opts: { body: { title: string } }) => {
      if (opts.body.title === "Paper One") {
        return {
          data: { tldr: "tldr1", studyType: "RCT", statisticalMethods: "ANOVA" },
          error: null,
        };
      }
      // p3
      return { data: null, error: new Error("rate limit") };
    });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [p1, p2, p3],
        selectedPaperIds: new Set(["p1", "p2", "p3"]),
        userId: "user-1",
        updatePaper,
        sleep,
      }),
    );

    await act(async () => {
      await result.current.handleBulkAnalyze();
    });

    // p1 + p3 invoke (p2 skipped before invoke).
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    // Only p1 succeeded → updatePaper called once.
    expect(updatePaper).toHaveBeenCalledTimes(1);
    expect(updatePaper).toHaveBeenCalledWith("p1", expect.objectContaining({ tldr: "tldr1" }));

    // Cooldown control flow: 2 sleeps (p1 success + p3 caught failure), NOT after p2's missing-abstract continue.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 3000);
    expect(sleep).toHaveBeenNthCalledWith(2, 3000);

    // Per-paper failure toast for p3 only — p2's silent skip increments failCount but doesn't toast.
    const failureToastCalls = mockToast.mock.calls.filter((args) => {
      const arg = args[0] as { title?: string; variant?: string };
      return typeof arg.title === "string" && arg.title.startsWith("Failed:");
    });
    expect(failureToastCalls).toHaveLength(1);
    expect(failureToastCalls[0][0]).toMatchObject({
      title: expect.stringMatching(/^Failed: Paper Three/),
      variant: "destructive",
    });

    // Final summary reflects 1 success + 2 failures (p2 missing-abstract + p3 caught error).
    expect(mockToast).toHaveBeenLastCalledWith({
      title: "Bulk analysis complete",
      description: "1 succeeded, 2 failed out of 3 papers.",
    });

    await waitFor(() => expect(result.current.bulkAnalyzing).toBe(false));
    expect(result.current.bulkAnalyzeProgress).toEqual({ current: 0, total: 0 });
  });
});
