import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Toaster } from "@/components/ui/sonner";
import { TOAST_DURATION_MS } from "@/lib/toastPolicy";

/**
 * UI-TOAST-LIFECYCLE-CONSISTENCY-001 — the three owner-reported notifications,
 * from the real hooks to the one real toaster.
 *
 * "Bulk import complete", "Keywords updated" and "Paper deleted" were each seen
 * to stay until clicked. The hook suites already pin WHAT these paths report,
 * through a mocked `useToast`. This suite deliberately does not mock it: each
 * path runs through the real `useToast()`, lands in the single mounted
 * `<Toaster />`, and must close on its own at the policy interval. Only the
 * data boundaries (Supabase, the metadata fetch, the paginated read, the cache
 * helpers) are stubbed.
 */

const { mockRpc, state } = vi.hoisted(() => {
  const state = {
    rpcError: null as unknown,
    cleanupStatus: "completed" as "completed" | "pending",
    schemaMissing: false,
  };
  const mockRpc = vi.fn(async () => ({ data: [{ deleted_count: 1, queued_count: 0 }], error: state.rpcError }));
  return { mockRpc, state };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: mockRpc,
    // Only ever used to build the query handed to the (mocked) paginated read.
    from: () => ({ select: () => ({ eq: () => ({}) }) }),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("../usePaperCacheHelpers", () => ({
  usePaperCacheHelpers: () => ({
    snapshotCache: vi.fn(() => ({})),
    rollbackCache: vi.fn(),
    cancelQueries: vi.fn(),
    updatePapersCache: vi.fn(),
    adjustCount: vi.fn(),
    adjustFilteredCount: vi.fn(),
    removeStaleListCaches: vi.fn(),
    invalidateAndRefetch: vi.fn(),
    invalidateJunctionCaches: vi.fn(),
  }),
}));

vi.mock("@/hooks/useNormalizationWorker", () => ({
  useNormalizationWorker: () => ({ normalize: vi.fn(async (papers: unknown[]) => papers) }),
}));

vi.mock("@/lib/fetchPaperMetadataEdge", () => ({
  fetchPaperMetadata: vi.fn(async (identifiers: string[]) =>
    identifiers.map((identifier) => ({ identifier, error: "Not found" })),
  ),
}));

vi.mock("@/lib/fetchAllPages", () => ({
  fetchAllPages: vi.fn(async () => [
    { id: "p1", raw_keywords: [], title: "A paper", abstract: null, keywords: ["stale keyword"] },
  ]),
}));

vi.mock("@/lib/attachmentCleanup", () => ({
  drainAttachmentCleanupQueue: vi.fn(async () => ({ status: state.cleanupStatus, removed: 0, pending: null })),
}));

vi.mock("@/lib/attachmentCleanupAvailability", () => ({
  isAttachmentCleanupSchemaMissing: () => state.schemaMissing,
  noteAttachmentCleanupObjectPresent: vi.fn(),
}));

vi.mock("../deletePapersCompat", () => ({
  legacyDeletePapersWithBestEffortCleanup: vi.fn(async () => ({ ok: true, message: "", cleanupFailed: true })),
}));

import { useBulkMutations } from "../useBulkMutations";
import { usePaperMutations } from "../usePaperMutations";

/** Sonner keeps a closed toast mounted this long for its exit transition (sonner 1.7.4). */
const EXIT_MS = 200;

const EMPTY_CONFIG = { synonymLookup: {}, poolStudyTypes: [], poolKeywords: [], synonymGroups: [] };
const FILTERS = {} as never;
const SORT = {} as never;

beforeEach(() => {
  vi.useFakeTimers();
  state.rpcError = null;
  state.cleanupStatus = "completed";
  state.schemaMissing = false;
  mockRpc.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function notification(title: string): HTMLElement | null {
  return screen.queryByText(title, { exact: true })?.closest<HTMLElement>("[data-sonner-toast]") ?? null;
}

/** Run one hook operation, then let Sonner hand the notification to React. */
async function run(operation: () => Promise<unknown>) {
  await act(async () => {
    await operation();
  });
  advance(0);
}

/** The notification is in the one toaster, stays for the full interval, then closes itself. */
function expectOwnLifecycle(title: string, durationMs: number) {
  const item = notification(title);
  expect(item).not.toBeNull();
  expect(item?.closest("[data-sonner-toaster]")).not.toBeNull();

  advance(durationMs - 1);
  expect(notification(title)).toHaveAttribute("data-removed", "false");

  advance(1 + EXIT_MS);
  expect(notification(title)).toBeNull();
}

describe("owner-reported notifications close on their own", () => {
  it("Bulk import complete (the zero-success outcome)", async () => {
    render(<Toaster />);
    const { result } = renderHook(() => useBulkMutations("user-1", [], [], [], EMPTY_CONFIG, FILTERS, SORT));

    await run(() => result.current.bulkImportPapers(["123"]));

    expect(screen.getByText("0 added, 0 skipped (duplicates), 1 failed.")).toBeInTheDocument();
    expectOwnLifecycle("Bulk import complete", TOAST_DURATION_MS.default);
  });

  it("Keywords updated (the follow-up re-evaluation after a pool change)", async () => {
    render(<Toaster />);
    const { result } = renderHook(() => useBulkMutations("user-1", [], [], [], EMPTY_CONFIG, FILTERS, SORT));

    await run(() => result.current.reevaluateKeywords(EMPTY_CONFIG));

    expect(mockRpc).toHaveBeenCalledWith("bulk_update_keywords", expect.anything());
    expect(screen.getByText("Updated keywords for 1 paper(s).")).toBeInTheDocument();
    expectOwnLifecycle("Keywords updated", TOAST_DURATION_MS.default);
  });

  it.each([
    ["the durable path", () => {}, null],
    ["cleanup still pending", () => (state.cleanupStatus = "pending"), "Attachment file cleanup is pending and will retry automatically."],
    ["the pre-migration fallback", () => {
      state.rpcError = { code: "PGRST202", message: "missing" };
      state.schemaMissing = true;
    }, "One or more attachment files could not be removed."],
  ])("Paper deleted — %s", async (_label, arrange, description) => {
    arrange();
    render(<Toaster />);
    const { result } = renderHook(() => usePaperMutations("user-1", [], [], [], EMPTY_CONFIG, FILTERS, SORT));

    await run(() => result.current.deletePaper("paper-1"));

    if (description) expect(screen.getByText(description)).toBeInTheDocument();
    expectOwnLifecycle("Paper deleted", TOAST_DURATION_MS.default);
  });
});
