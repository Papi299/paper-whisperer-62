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
import { queryKeys } from "@/lib/queryKeys";
import type { AiQuotaStatus } from "@/hooks/useAiQuota";
import type { PaperWithTags } from "@/types/database";

/** Build a FunctionsHttpError-like value carrying a structured 402 quota body. */
function quota402(overrides: Partial<{ used: number; quota: number; remaining: number; period_type: string; reset_at: string | null }> = {}) {
  const details = { plan: "free", period_type: "lifetime", used: 15, quota: 15, remaining: 0, reset_at: null, ...overrides };
  return Object.assign(new Error("Edge Function returned a non-2xx status code"), {
    context: new Response(JSON.stringify({ error: "quota_exceeded", message: "AI analysis quota exceeded.", details }), { status: 402 }),
  });
}

/** Build a FunctionsHttpError-like value carrying a structured 500 provider-failure body. */
function provider500(code = "provider_rate_limit", message = "AI analysis is temporarily unavailable. Please try again later.") {
  return Object.assign(new Error("Edge Function returned a non-2xx status code"), {
    context: new Response(JSON.stringify({ error: "analysis_unavailable", code, message }), { status: 500 }),
  });
}

/** Minimal AiQuotaStatus fixture. */
function makeQuota(overrides: Partial<AiQuotaStatus> = {}): AiQuotaStatus {
  return { allowed: true, reason: "ok", plan: "free", planStatus: "active", periodType: "lifetime", used: 3, quota: 15, remaining: 12, resetAt: null, isExempt: false, ...overrides };
}

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

  it("single: handles fetchAbstract rejection, shows generic failure, and clears state", async () => {
    // The whole operation (fetchAbstract → invoke → update) is inside one
    // failure boundary. A `fetchAbstract` rejection must NOT leak out of the
    // handler, must show one generic destructive failure toast (preserving the
    // original message), must not invoke `analyze-paper` or update the paper,
    // must NOT sync the quota query (no server attempt occurred), and must
    // always clear `analyzingPaperId`.
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paper = makePaper({ id: "p-fetch-reject" });
    mockFetchAbstract.mockRejectedValue(new Error("network down fetching abstract"));

    const { result } = renderHook(() =>
      usePaperAnalysisActions({ papers: [paper], selectedPaperIds: new Set<string>(), userId: "user-1", updatePaper, sleep }),
    );

    // The handler must not reject.
    await act(async () => {
      await expect(result.current.handleAnalyzePaper(paper)).resolves.toBeUndefined();
    });

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(updatePaper).not.toHaveBeenCalled();
    // Exactly one destructive failure toast, carrying the original message.
    const failureToasts = mockToast.mock.calls.filter((c) => (c[0] as { title?: string }).title === "AI Analysis failed");
    expect(failureToasts).toHaveLength(1);
    expect(failureToasts[0][0]).toMatchObject({ description: "network down fetching abstract", variant: "destructive" });
    // No server attempt → no quota invalidation.
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
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

describe("usePaperAnalysisActions — null/undefined userId (auth-transition hotfix)", () => {
  // Regression coverage for the post-PR-#135 dashboard crash hotfix:
  // `useAuth()` can yield `user === null` on an intermediate render during
  // sign-out / sign-in transitions, which threads a null/undefined
  // `userId` into this hook. Both handlers must short-circuit BEFORE
  // calling `fetchAbstract`, `fetchAbstractsBatch`, or the
  // `analyze-paper` Edge Function. The single-paper handler is a silent
  // no-op (UI button is gated by `has_abstract`); the bulk handler
  // surfaces a destructive "Not signed in" toast.

  it("handleAnalyzePaper is a no-op when userId is null — no fetch, no invoke, no update, no toast", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paper = makePaper({ id: "p-1" }); // has_abstract: true by default

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [paper],
        selectedPaperIds: new Set<string>(),
        userId: null,
        updatePaper,
        sleep,
      }),
    );

    await act(async () => {
      await result.current.handleAnalyzePaper(paper);
    });

    expect(mockFetchAbstract).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(updatePaper).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
    expect(result.current.analyzingPaperId).toBeNull();
  });

  it("handleAnalyzePaper is a no-op when userId is undefined", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paper = makePaper({ id: "p-1" });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [paper],
        selectedPaperIds: new Set<string>(),
        userId: undefined,
        updatePaper,
        sleep,
      }),
    );

    await act(async () => {
      await result.current.handleAnalyzePaper(paper);
    });

    expect(mockFetchAbstract).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(updatePaper).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("handleBulkAnalyze short-circuits with destructive toast when userId is null — no batch-fetch, no invoke, no update, no sleep", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const p1 = makePaper({ id: "p1" });
    const p2 = makePaper({ id: "p2" });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [p1, p2],
        selectedPaperIds: new Set(["p1", "p2"]),
        userId: null,
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
      title: "Not signed in",
      description: "Please wait for sign-in to complete, then try again.",
      variant: "destructive",
    });
    expect(result.current.bulkAnalyzing).toBe(false);
    expect(result.current.bulkAnalyzeProgress).toEqual({ current: 0, total: 0 });
  });
});

describe("usePaperAnalysisActions — AI quota UX (PFA-C01)", () => {
  it("single: shows the specific quota message on a 402, does NOT update, and syncs the quota query", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paper = makePaper({ id: "p-402" });
    mockFetchAbstract.mockResolvedValue("abstract text");
    mockInvoke.mockResolvedValue({ data: null, error: quota402() });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({ papers: [paper], selectedPaperIds: new Set<string>(), userId: "user-1", updatePaper, sleep }),
    );

    await act(async () => {
      await result.current.handleAnalyzePaper(paper);
    });

    // No paper update on quota exhaustion.
    expect(updatePaper).not.toHaveBeenCalled();
    // Specific quota toast (NOT the generic non-2xx message).
    const titles = mockToast.mock.calls.map((c) => (c[0] as { title?: string }).title);
    expect(titles).toContain("AI requests used up");
    expect(titles).not.toContain("AI Analysis failed");
    // Message carries the authoritative allowance and no upgrade wording.
    const quotaCall = mockToast.mock.calls.find((c) => (c[0] as { title?: string }).title === "AI requests used up");
    expect((quotaCall![0] as { description: string }).description).not.toMatch(/upgrade|pay|billing|purchase/i);
    // Quota query invalidated after the attempt.
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.aiQuota.status("user-1") });
    await waitFor(() => expect(result.current.analyzingPaperId).toBeNull());
  });

  it("single: intercepts before invoking when quotaStatus is known-zero", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paper = makePaper({ id: "p-zero" });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [paper],
        selectedPaperIds: new Set<string>(),
        userId: "user-1",
        updatePaper,
        sleep,
        quotaStatus: makeQuota({ remaining: 0, used: 15, allowed: false, reason: "quota_exceeded" }),
      }),
    );

    await act(async () => {
      await result.current.handleAnalyzePaper(paper);
    });

    expect(mockFetchAbstract).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(updatePaper).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "AI requests used up", variant: "destructive" }));
  });

  it("single: does NOT intercept an exempt user whose remaining reads 0 — proceeds to invoke", async () => {
    // An AI-quota-exempt owner past the nominal cap has remaining 0 but is still
    // allowed by the server. The known-zero convenience intercept must be
    // skipped for exempt users so the analysis proceeds.
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paper = makePaper({ id: "p-exempt" });
    mockFetchAbstract.mockResolvedValue("abstract text");
    mockInvoke.mockResolvedValue({ data: { tldr: "t", studyType: "RCT", statisticalMethods: "ANOVA" }, error: null });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [paper],
        selectedPaperIds: new Set<string>(),
        userId: "owner-1",
        updatePaper,
        sleep,
        quotaStatus: makeQuota({ isExempt: true, reason: "quota_exempt", plan: "pro", periodType: "monthly", used: 412, quota: 350, remaining: 0 }),
      }),
    );

    await act(async () => {
      await result.current.handleAnalyzePaper(paper);
    });

    // Not intercepted: the abstract is fetched and the Edge Function is invoked.
    expect(mockFetchAbstract).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(updatePaper).toHaveBeenCalledTimes(1);
    // No "used up" toast for an exempt user.
    const titles = mockToast.mock.calls.map((c) => (c[0] as { title?: string }).title);
    expect(titles).not.toContain("AI requests used up");
  });

  it("single: does NOT block when quotaStatus is unknown (undefined) — server stays authoritative", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paper = makePaper({ id: "p-unknown" });
    mockFetchAbstract.mockResolvedValue("abstract text");
    mockInvoke.mockResolvedValue({ data: { tldr: "t", studyType: "RCT", statisticalMethods: "ANOVA" }, error: null });

    const { result } = renderHook(() =>
      // no quotaStatus passed → unknown
      usePaperAnalysisActions({ papers: [paper], selectedPaperIds: new Set<string>(), userId: "user-1", updatePaper, sleep }),
    );

    await act(async () => {
      await result.current.handleAnalyzePaper(paper);
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(updatePaper).toHaveBeenCalledTimes(1);
  });

  it("bulk: stops after a mid-run 402 — one success, quota-denied counts as failed, rest unattempted, ONE quota toast", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const p1 = makePaper({ id: "p1", title: "One", study_type: null });
    const p2 = makePaper({ id: "p2", title: "Two", study_type: null });
    const p3 = makePaper({ id: "p3", title: "Three", study_type: null });
    mockFetchAbstractsBatch.mockResolvedValue(new Map<string, string | null>([["p1", "a1"], ["p2", "a2"], ["p3", "a3"]]));

    // p1 succeeds; p2 hits the quota wall (402) → terminal; p3 never attempted.
    mockInvoke.mockImplementation(async (_fn: string, opts: { body: { title: string } }) => {
      if (opts.body.title === "One") return { data: { tldr: "t1", studyType: "RCT", statisticalMethods: "ANOVA" }, error: null };
      if (opts.body.title === "Two") return { data: null, error: quota402() };
      return { data: { tldr: "t3", studyType: "Cohort", statisticalMethods: "regression" }, error: null };
    });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({ papers: [p1, p2, p3], selectedPaperIds: new Set(["p1", "p2", "p3"]), userId: "user-1", updatePaper, sleep }),
    );

    await act(async () => {
      await result.current.handleBulkAnalyze();
    });

    // Only two Edge Function invocations (p1, p2); p3 NOT invoked (terminal break).
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    const invokedTitles = mockInvoke.mock.calls.map((c) => (c[1] as { body: { title: string } }).body.title);
    expect(invokedTitles).toEqual(["One", "Two"]);
    // Only p1 analyzed.
    expect(updatePaper).toHaveBeenCalledTimes(1);
    expect(updatePaper).toHaveBeenCalledWith("p1", expect.objectContaining({ tldr: "t1" }));

    // EXACTLY ONE quota notification for the whole run.
    const quotaToasts = mockToast.mock.calls.filter((c) => (c[0] as { title?: string }).title === "AI requests used up");
    expect(quotaToasts).toHaveLength(1);
    // It carries authoritative allowance detail plus complete run accounting:
    //   1 analyzed (p1), 1 failed (p2 quota-denied), 1 not attempted (p3).
    const desc = (quotaToasts[0][0] as { description: string }).description;
    expect(desc).toMatch(/1 analyzed/);
    expect(desc).toMatch(/1 failed/);
    expect(desc).toMatch(/1 not attempted/);
    // successCount + failCount + unattempted === total (1 + 1 + 1 === 3).
    const [analyzed] = desc.match(/(\d+) analyzed/)!.slice(1).map(Number);
    const [failed] = desc.match(/(\d+) failed/)!.slice(1).map(Number);
    const [notAttempted] = desc.match(/(\d+) not attempted/)!.slice(1).map(Number);
    expect(analyzed + failed + notAttempted).toBe(3);
    // No billing/upgrade language.
    expect(desc).not.toMatch(/upgrade|pay|billing|purchase|checkout/i);

    // Exactly one cooldown — from p1's success; none after the quota response.
    expect(sleep).toHaveBeenCalledTimes(1);
    // Quota query synced once after the run.
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.aiQuota.status("user-1") });
    await waitFor(() => expect(result.current.bulkAnalyzing).toBe(false));
  });

  it("bulk: 402 on the very first paper — 0 analyzed, 1 failed, rest unattempted, one invoke, zero cooldowns", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const p1 = makePaper({ id: "p1", title: "One", study_type: null });
    const p2 = makePaper({ id: "p2", title: "Two", study_type: null });
    const p3 = makePaper({ id: "p3", title: "Three", study_type: null });
    mockFetchAbstractsBatch.mockResolvedValue(new Map<string, string | null>([["p1", "a1"], ["p2", "a2"], ["p3", "a3"]]));

    // First paper immediately hits the quota wall → terminal before any success.
    mockInvoke.mockResolvedValue({ data: null, error: quota402() });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({ papers: [p1, p2, p3], selectedPaperIds: new Set(["p1", "p2", "p3"]), userId: "user-1", updatePaper, sleep }),
    );

    await act(async () => {
      await result.current.handleBulkAnalyze();
    });

    // Exactly one invocation (p1); p2 and p3 never attempted.
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(updatePaper).not.toHaveBeenCalled();
    // Zero cooldowns (terminal break preceded the sleep).
    expect(sleep).not.toHaveBeenCalled();

    const quotaToasts = mockToast.mock.calls.filter((c) => (c[0] as { title?: string }).title === "AI requests used up");
    expect(quotaToasts).toHaveLength(1);
    const desc = (quotaToasts[0][0] as { description: string }).description;
    expect(desc).toMatch(/0 analyzed/);
    expect(desc).toMatch(/1 failed/);
    expect(desc).toMatch(/2 not attempted/);
    const analyzed = Number(desc.match(/(\d+) analyzed/)![1]);
    const failed = Number(desc.match(/(\d+) failed/)![1]);
    const notAttempted = Number(desc.match(/(\d+) not attempted/)![1]);
    expect(analyzed + failed + notAttempted).toBe(3);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.aiQuota.status("user-1") });
    await waitFor(() => expect(result.current.bulkAnalyzing).toBe(false));
  });

  it("single: a provider 500 shows the neutral provider message, no update, and is NOT a quota wall", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const paper = makePaper({ id: "p-prov" });
    mockFetchAbstract.mockResolvedValue("abstract text");
    mockInvoke.mockResolvedValue({ data: null, error: provider500("provider_rate_limit") });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({ papers: [paper], selectedPaperIds: new Set<string>(), userId: "user-1", updatePaper, sleep }),
    );

    await act(async () => {
      await result.current.handleAnalyzePaper(paper);
    });

    expect(updatePaper).not.toHaveBeenCalled();
    const titles = mockToast.mock.calls.map((c) => (c[0] as { title?: string }).title);
    // Neutral provider message, NOT a quota-wall toast.
    expect(titles).toContain("AI analysis unavailable");
    expect(titles).not.toContain("AI requests used up");
    const call = mockToast.mock.calls.find((c) => (c[0] as { title?: string }).title === "AI analysis unavailable");
    const desc = (call![0] as { description: string }).description;
    expect(desc).toMatch(/temporarily unavailable/i);
    expect(desc).not.toMatch(/google|gemini|quota|project/i);
    // A server attempt occurred → quota query invalidated.
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.aiQuota.status("user-1") });
  });

  it("bulk: a provider 500 on one paper is a NON-terminal failure — the run continues", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const p1 = makePaper({ id: "p1", title: "One", study_type: null });
    const p2 = makePaper({ id: "p2", title: "Two", study_type: null });
    mockFetchAbstractsBatch.mockResolvedValue(new Map<string, string | null>([["p1", "a1"], ["p2", "a2"]]));

    mockInvoke.mockImplementation(async (_fn: string, opts: { body: { title: string } }) => {
      if (opts.body.title === "One") return { data: null, error: provider500("provider_unavailable") };
      return { data: { tldr: "t2", studyType: "Cohort", statisticalMethods: "regression" }, error: null };
    });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({ papers: [p1, p2], selectedPaperIds: new Set(["p1", "p2"]), userId: "user-1", updatePaper, sleep }),
    );

    await act(async () => {
      await result.current.handleBulkAnalyze();
    });

    // Both papers attempted (provider failure is non-terminal); p2 succeeds.
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(updatePaper).toHaveBeenCalledTimes(1);
    expect(updatePaper).toHaveBeenCalledWith("p2", expect.objectContaining({ tldr: "t2" }));
    // Cooldown runs after the non-terminal failure AND the success.
    expect(sleep).toHaveBeenCalledTimes(2);
    // Exactly one per-item neutral failure toast; NO quota-wall toast.
    const failToasts = mockToast.mock.calls.filter((c) => String((c[0] as { title?: string }).title).startsWith("Failed:"));
    expect(failToasts).toHaveLength(1);
    const titles = mockToast.mock.calls.map((c) => (c[0] as { title?: string }).title);
    expect(titles).not.toContain("AI requests used up");
    // Ends with the normal completion summary (1 succeeded, 1 failed).
    expect(mockToast).toHaveBeenLastCalledWith({
      title: "Bulk analysis complete",
      description: "1 succeeded, 1 failed out of 2 papers.",
    });
  });

  it("bulk: intercepts before batch-fetch when quotaStatus is known-zero", async () => {
    const updatePaper = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const p1 = makePaper({ id: "p1" });

    const { result } = renderHook(() =>
      usePaperAnalysisActions({
        papers: [p1],
        selectedPaperIds: new Set(["p1"]),
        userId: "user-1",
        updatePaper,
        sleep,
        quotaStatus: makeQuota({ remaining: 0, allowed: false }),
      }),
    );

    await act(async () => {
      await result.current.handleBulkAnalyze();
    });

    expect(mockFetchAbstractsBatch).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "AI requests used up" }));
  });
});
