import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * bulkImportPapers reports every outcome under the identifier that was
 * REQUESTED.
 *
 * `fetch-paper-metadata` labels a record found on PubMed's path with its PMID
 * (`identifier: pmid`) even when a DOI was requested. Before the attribution
 * step, such a DOI was summarised under that PMID, was never released from a
 * Consensus selection, and was reported `failed` in `outcome.items` although
 * the paper was inserted — the status `/extension-import` acts on. The real
 * importer runs here; only its network and database seams are mocked.
 */

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: mockRpc, from: vi.fn(), storage: { from: () => ({ remove: vi.fn() }) } },
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

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

vi.mock("@/lib/queryKeys", () => ({
  queryKeys: {
    papers: {
      all: (uid: string) => ["papers", uid],
      abstract: (id: string) => ["papers", "abstract", id],
      count: (uid: string) => ["papers", "count", uid],
      list: (...args: unknown[]) => ["papers", "list", ...args],
    },
    projects: { all: (uid: string) => ["projects", uid] },
    tags: { all: (uid: string) => ["tags", uid] },
  },
}));

const mockFetchPaperMetadata = vi.fn();
vi.mock("@/lib/fetchPaperMetadataEdge", () => ({
  fetchPaperMetadata: (...args: unknown[]) => mockFetchPaperMetadata(...args),
}));

const mockProcessChunkedInsert = vi.fn();
vi.mock("@/lib/chunkedInsert", () => ({
  processChunkedInsert: (...args: unknown[]) => mockProcessChunkedInsert(...args),
}));

import { useBulkMutations } from "../useBulkMutations";
import type { ServerFilterParams, ServerSortParams } from "../types";

const emptyFilters: ServerFilterParams = {
  filterPaperIds: null,
  yearFrom: null,
  yearTo: null,
  studyTypes: null,
  notesPresence: "all",
};
const emptySort: ServerSortParams = { sortColumn: null, sortAscending: null };

function renderImporter() {
  return renderHook(() => useBulkMutations("user-1", [], [], [], undefined, emptyFilters, emptySort));
}

/** A record as `fetch-paper-metadata` returns it. */
function record(identifier: string, overrides: Record<string, unknown> = {}) {
  return {
    identifier,
    title: `Record ${identifier}`,
    authors: ["Author A"],
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
    ...overrides,
  };
}

/** A DOI the importer resolved on PubMed's path: labelled with the PMID. */
const pubmedPath = (pmid: string, doi: string) =>
  record(pmid, { pmid, doi, pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, source: "pubmed" });

/** A DOI resolved through Crossref: labelled with the DOI name. */
const crossrefPath = (doi: string) => record(doi, { doi, journal_url: `https://doi.org/${doi}`, source: "crossref" });

async function runImport(identifiers: string[]) {
  const progress: Array<{ added: string[]; skipped: string[]; failed: string[] }> = [];
  const { result } = renderImporter();
  let outcome: Awaited<ReturnType<typeof result.current.bulkImportPapers>>;
  await act(async () => {
    outcome = await result.current.bulkImportPapers(identifiers, (_current, _total, added, skipped, failed) => {
      progress.push({ added: [...added], skipped: [...skipped], failed: [...failed] });
    });
  });
  return { last: progress.at(-1)!, outcome: outcome! };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockResolvedValue({ data: null, error: null });
});

describe("bulkImportPapers — outcomes are reported under the requested identifier", () => {
  it("reports a DOI resolved through PubMed under the DOI, and marks it inserted", async () => {
    mockFetchPaperMetadata.mockResolvedValue([pubmedPath("31415926", "10.5555/consensus.1")]);
    mockProcessChunkedInsert.mockResolvedValue({ results: [{ index: 0, id: "paper-1", status: "inserted" }], lastError: null });

    const { last, outcome } = await runImport(["10.5555/consensus.1"]);

    expect(last).toEqual({ added: ["10.5555/consensus.1"], skipped: [], failed: [] });
    // Before the attribution step this was "failed" — the extension handoff bug.
    expect(outcome.items).toEqual([{ identifier: "10.5555/consensus.1", status: "inserted" }]);
  });

  it("reports a duplicate DOI resolved through PubMed under the DOI", async () => {
    mockFetchPaperMetadata.mockResolvedValue([pubmedPath("31415926", "10.5555/Consensus.1")]);
    mockProcessChunkedInsert.mockResolvedValue({ results: [{ index: 0, status: "duplicate" }], lastError: null });

    const { last, outcome } = await runImport(["10.5555/consensus.1"]);

    expect(last.skipped).toEqual(["10.5555/consensus.1"]);
    expect(outcome.items).toEqual([{ identifier: "10.5555/consensus.1", status: "duplicate-unresolved" }]);
  });

  it("attributes a mixed batch — PubMed path, Crossref path, a PMID and a failure — each to what was asked", async () => {
    mockFetchPaperMetadata.mockResolvedValue([
      pubmedPath("31415926", "10.5555/a"),
      crossrefPath("10.5555/b"),
      record("12345678", { pmid: "12345678" }),
      { identifier: "10.5555/missing", error: "Could not find paper metadata" },
    ]);
    mockProcessChunkedInsert.mockResolvedValue({
      results: [
        { index: 0, id: "paper-a", status: "inserted" },
        { index: 1, status: "duplicate" },
        { index: 2, id: "paper-p", status: "inserted" },
      ],
      lastError: null,
    });

    const { last, outcome } = await runImport(["10.5555/a", "10.5555/b", "12345678", "10.5555/missing"]);

    expect(last).toEqual({ added: ["10.5555/a", "12345678"], skipped: ["10.5555/b"], failed: ["10.5555/missing"] });
    expect(outcome.items).toEqual([
      { identifier: "10.5555/a", status: "inserted" },
      { identifier: "10.5555/b", status: "duplicate-unresolved" },
      { identifier: "12345678", status: "inserted" },
      { identifier: "10.5555/missing", status: "failed" },
    ]);
  });

  it("does not depend on the order results come back in", async () => {
    mockFetchPaperMetadata.mockResolvedValue([record("12345678", { pmid: "12345678" }), pubmedPath("31415926", "10.5555/a")]);
    mockProcessChunkedInsert.mockResolvedValue({
      results: [
        { index: 0, id: "paper-p", status: "inserted" },
        { index: 1, id: "paper-a", status: "inserted" },
      ],
      lastError: null,
    });

    const { outcome } = await runImport(["10.5555/a", "12345678"]);

    expect(outcome.items).toEqual([
      { identifier: "10.5555/a", status: "inserted" },
      { identifier: "12345678", status: "inserted" },
    ]);
  });

  it("leaves a title import resolved on PubMed reported under its PMID, as before", async () => {
    mockFetchPaperMetadata.mockResolvedValue([pubmedPath("31415926", "10.5555/a")]);
    mockProcessChunkedInsert.mockResolvedValue({ results: [{ index: 0, id: "paper-a", status: "inserted" }], lastError: null });

    const { last } = await runImport(["Creatine and cognition in healthy adults"]);

    expect(last.added).toEqual(["31415926"]);
  });
});
