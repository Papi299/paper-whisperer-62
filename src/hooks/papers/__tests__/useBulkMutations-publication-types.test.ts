import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * Structured publication-type provenance through the bulk paths.
 *
 * PubMed states publication types discretely and an official one may contain a
 * comma ("Clinical Trial, Phase II"), so the joined `raw_study_type` cannot be
 * split back apart. These tests pin the three places that would otherwise lose
 * the boundaries: what the identifier/API import writes, what the file import
 * writes, and what a later study-type pool re-evaluation reads.
 */

// ── Supabase mock (hoisted) ───────────────────────────────────────────
//
// reevaluateStudyTypes reads its own rows via
// `.from("papers").select(<columns>).eq("user_id", …)`. The response is keyed
// on the *select string* so a test can make the structured read fail while the
// legacy read succeeds — which is exactly the pre-migration schema.
type SelectResult = { data: unknown; error: unknown };

const { mockRpc, mockFrom, mockPapersSelect, papersSelectResponder } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const papersSelectResponder: { respond: (select: string) => SelectResult } = {
    respond: () => ({ data: [], error: null }),
  };
  const mockPapersSelect = vi.fn((select: string) => ({
    eq: vi.fn(async () => papersSelectResponder.respond(select)),
  }));
  const mockFrom = vi.fn(() => ({
    select: mockPapersSelect,
    insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn() })) })),
    delete: vi.fn(() => ({ in: vi.fn(() => ({ eq: vi.fn() })) })),
  }));
  return { mockRpc, mockFrom, mockPapersSelect, papersSelectResponder };
});

/** The two selects the re-evaluation path may issue. */
const STRUCTURED_SELECT =
  "id, title, abstract, study_type, raw_study_type, raw_publication_types";
const LEGACY_SELECT = "id, title, abstract, study_type, raw_study_type";

/**
 * The exact PostgREST error a pre-migration database returns for the structured
 * select, captured from a local stack with the column dropped:
 *   HTTP 400 {"code":"42703", …,"message":"column papers.raw_publication_types does not exist"}
 */
const MISSING_COLUMN_ERROR = {
  code: "42703",
  details: null,
  hint: null,
  message: "column papers.raw_publication_types does not exist",
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

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

// The normalization boundary: record exactly what the hook hands over, so the
// structured values are provably not stripped before normalization runs.
const mockNormalize = vi.fn(async (papers: unknown[]) => papers);
vi.mock("@/hooks/useNormalizationWorker", () => ({
  useNormalizationWorker: () => ({ normalize: mockNormalize }),
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

// evaluateStudyType is spied on rather than reimplemented: the assertion of
// interest is which arguments re-evaluation supplies, and argument #5 is the
// structured provenance. Hoisted with the real signature so the recorded calls
// stay typed.
const { mockEvaluateStudyType } = vi.hoisted(() => ({
  mockEvaluateStudyType: vi.fn(
    (
      _title: string,
      _abstract: string | null,
      _rawStudyType: string | null,
      _pool: unknown[],
      _publicationTypes?: string[],
    ): string => "",
  ),
}));
vi.mock("@/lib/evaluateStudyType", () => ({
  evaluateStudyType: mockEvaluateStudyType,
}));

import { useBulkMutations } from "../useBulkMutations";
import type { PaperWithTags, Project, Tag } from "@/types/database";
import type { NormalizationConfig, RawPaperData } from "@/lib/normalizePaperData";
import type { ServerFilterParams, ServerSortParams } from "../types";

// ── Fixtures ──────────────────────────────────────────────────────────

const userId = "user-1";
const emptyProjects: Project[] = [];
const emptyTags: Tag[] = [];
const emptyFilters: ServerFilterParams = {
  filterPaperIds: null,
  yearFrom: null,
  yearTo: null,
  studyTypes: null,
  notesPresence: "all",
};
const emptySort: ServerSortParams = { sortColumn: null, sortAscending: null };

/**
 * A config must be present for the hook to route through `normalize` at all,
 * which is the boundary these tests watch. `papers` is only used as a non-empty
 * guard by reevaluateStudyTypes.
 */
const normalizationConfig: NormalizationConfig = {
  synonymLookup: {},
  poolStudyTypes: [],
  poolKeywords: [],
  synonymGroups: [],
};

function renderBulkHook(papers: PaperWithTags[] = []) {
  return renderHook(() =>
    useBulkMutations(
      userId,
      papers,
      emptyProjects,
      emptyTags,
      normalizationConfig,
      emptyFilters,
      emptySort,
    ),
  );
}

/** The single row `papers.length > 0` needs; its content is never read. */
const cachedPaper = { id: "paper-1" } as unknown as PaperWithTags;

function insertPayloadRow(index = 0): Record<string, unknown> {
  const chunk = mockProcessChunkedInsert.mock.calls[0][0] as Record<string, unknown>[];
  return chunk[index];
}

function parsedPaper(overrides: Partial<RawPaperData> = {}): RawPaperData {
  return {
    title: "Test Paper",
    authors: ["Author"],
    year: 2024,
    journal: null,
    pmid: "12345",
    doi: null,
    abstract: null,
    keywords: [],
    mesh_terms: [],
    substances: [],
    study_type: null,
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNormalize.mockImplementation(async (papers: unknown[]) => papers);
  mockProcessChunkedInsert.mockResolvedValue({
    results: [{ index: 0, id: "paper-id-1", status: "inserted" }],
    lastError: null,
  });
  mockRpc.mockResolvedValue({ data: null, error: null });
  papersSelectResponder.respond = () => ({ data: [], error: null });
  mockEvaluateStudyType.mockReturnValue("Clinical Trial, Phase II");
});

/** Every select returns the same rows — the normal, post-migration case. */
function respondWithRows(rows: unknown[]) {
  papersSelectResponder.respond = () => ({ data: rows, error: null });
}

// ── Identifier / API import ───────────────────────────────────────────

describe("bulkImportPapers — PubMed API structured publication types", () => {
  function metadata(overrides: Record<string, unknown> = {}) {
    return {
      identifier: "12345",
      title: "Test Paper",
      authors: ["Author"],
      year: 2024,
      journal: null,
      pmid: "12345",
      doi: null,
      abstract: null,
      keywords: [],
      mesh_terms: [],
      substances: [],
      study_type: "Clinical Trial, Phase II, Multicenter Study",
      publication_types: ["Clinical Trial, Phase II", "Multicenter Study"],
      pubmed_url: null,
      journal_url: null,
      ...overrides,
    };
  }

  it("forwards the structured values to normalization without stripping them", async () => {
    mockFetchPaperMetadata.mockResolvedValue([metadata()]);
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"]);
    });

    const [rawPapers] = mockNormalize.mock.calls[0] as [RawPaperData[]];
    expect(rawPapers[0].publication_types).toEqual([
      "Clinical Trial, Phase II",
      "Multicenter Study",
    ]);
  });

  it("persists the structured values alongside the legacy joined string", async () => {
    mockFetchPaperMetadata.mockResolvedValue([metadata()]);
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"]);
    });

    const row = insertPayloadRow();
    expect(row.raw_publication_types).toEqual([
      "Clinical Trial, Phase II",
      "Multicenter Study",
    ]);
    // Two source values, not the three splitting the joined string produces.
    expect(row.raw_publication_types).toHaveLength(2);
    // The legacy column is unchanged and still carries the joined form.
    expect(row.raw_study_type).toBe("Clinical Trial, Phase II, Multicenter Study");
  });

  it("sends null when the deployed function returned no structured values", async () => {
    // An Edge version predating the field: the joined string is all there is,
    // and it is never split to manufacture provenance.
    mockFetchPaperMetadata.mockResolvedValue([
      metadata({ publication_types: undefined, study_type: "Randomized Controlled Trial, Journal Article" }),
    ]);
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"]);
    });

    const row = insertPayloadRow();
    expect(row.raw_publication_types).toBeNull();
    expect(row.raw_study_type).toBe("Randomized Controlled Trial, Journal Article");
  });

  it("sends null for a Crossref-only result", async () => {
    mockFetchPaperMetadata.mockResolvedValue([
      metadata({ publication_types: undefined, study_type: "Journal Article", source: "crossref" }),
    ]);
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["10.1000/xyz"]);
    });

    expect(insertPayloadRow().raw_publication_types).toBeNull();
  });

  it("sends null rather than an empty array when the list is empty", async () => {
    mockFetchPaperMetadata.mockResolvedValue([metadata({ publication_types: [] })]);
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"]);
    });

    expect(insertPayloadRow().raw_publication_types).toBeNull();
  });
});

// ── Parsed file import ────────────────────────────────────────────────

describe("bulkImportFromParsedData — native NBIB structured publication types", () => {
  it("persists repeated PT values as discrete provenance", async () => {
    // The shape `parseNBIB` produces for:
    //   PT  - Clinical Trial, Phase II
    //   PT  - Multicenter Study
    const nbibPaper = parsedPaper({
      study_type: "Clinical Trial, Phase II, Multicenter Study",
      publication_types: ["Clinical Trial, Phase II", "Multicenter Study"],
    });

    const { result } = renderBulkHook();
    await act(async () => {
      await result.current.bulkImportFromParsedData([nbibPaper]);
    });

    const row = insertPayloadRow();
    expect(row.raw_publication_types).toEqual([
      "Clinical Trial, Phase II",
      "Multicenter Study",
    ]);
    expect(row.raw_study_type).toBe("Clinical Trial, Phase II, Multicenter Study");
  });

  it("sends null for formats that state no publication-type boundaries", async () => {
    // RIS / BibTeX / CSV / EndNote supply a string at most, so they keep the
    // legacy representation alone rather than acquiring invented structure.
    const risPaper = parsedPaper({ study_type: "Randomized Controlled Trial, Journal Article" });

    const { result } = renderBulkHook();
    await act(async () => {
      await result.current.bulkImportFromParsedData([risPaper]);
    });

    const row = insertPayloadRow();
    expect(row.raw_publication_types).toBeNull();
    expect(row.raw_study_type).toBe("Randomized Controlled Trial, Journal Article");
  });

  it("hands the structured values to normalization unchanged", async () => {
    const nbibPaper = parsedPaper({
      study_type: "Clinical Trial, Phase II",
      publication_types: ["Clinical Trial, Phase II"],
    });

    const { result } = renderBulkHook();
    await act(async () => {
      await result.current.bulkImportFromParsedData([nbibPaper]);
    });

    const [rawPapers] = mockNormalize.mock.calls[0] as [RawPaperData[]];
    expect(rawPapers[0].publication_types).toEqual(["Clinical Trial, Phase II"]);
  });
});

// ── Later study-type pool re-evaluation ───────────────────────────────

describe("reevaluateStudyTypes — persisted structured provenance", () => {
  const pool = [{ study_type: "Clinical Trial, Phase II", specificity_weight: 1, hierarchy_rank: 1 }];

  /** The fifth evaluator argument: the structured publication types. */
  function structuredArgOfCall(index = 0) {
    return mockEvaluateStudyType.mock.calls[index][4];
  }

  it("reads raw_publication_types in the fetch", async () => {
    const { result } = renderBulkHook([cachedPaper]);

    await act(async () => {
      await result.current.reevaluateStudyTypes(pool);
    });

    expect(mockPapersSelect).toHaveBeenCalledWith(STRUCTURED_SELECT);
  });

  it("passes the stored boundaries as the evaluator's structured argument", async () => {
    respondWithRows([
        {
          id: "p1",
          title: "Stored paper",
          abstract: null,
          study_type: "Journal Article",
          raw_study_type: "Clinical Trial, Phase II, Journal Article",
          raw_publication_types: ["Clinical Trial, Phase II", "Journal Article"],
        },
    ]);

    const { result } = renderBulkHook([cachedPaper]);
    await act(async () => {
      await result.current.reevaluateStudyTypes(pool);
    });

    expect(structuredArgOfCall()).toEqual([
      "Clinical Trial, Phase II",
      "Journal Article",
    ]);
    // The legacy fallback is still supplied as argument #3, unchanged.
    expect(mockEvaluateStudyType.mock.calls[0][2]).toBe(
      "Clinical Trial, Phase II, Journal Article",
    );
  });

  it("falls back to the legacy string for a row predating the column", async () => {
    respondWithRows([
        {
          id: "legacy",
          title: "Legacy paper",
          abstract: null,
          study_type: "Journal Article",
          raw_study_type: "Randomized Controlled Trial, Journal Article",
          raw_publication_types: null,
        },
    ]);

    const { result } = renderBulkHook([cachedPaper]);
    await act(async () => {
      await result.current.reevaluateStudyTypes(pool);
    });

    // undefined — the exact condition under which evaluateStudyType keeps its
    // pre-existing joined-string behavior.
    expect(structuredArgOfCall()).toBeUndefined();
    expect(mockEvaluateStudyType.mock.calls[0][2]).toBe(
      "Randomized Controlled Trial, Journal Article",
    );
  });

  it("falls back when the stored value is empty or unusable", async () => {
    respondWithRows([
      { id: "a", title: "A", abstract: null, study_type: null, raw_study_type: "Case Report", raw_publication_types: [] },
      { id: "b", title: "B", abstract: null, study_type: null, raw_study_type: "Case Report", raw_publication_types: {} },
      { id: "c", title: "C", abstract: null, study_type: null, raw_study_type: "Case Report", raw_publication_types: [123] },
    ]);

    const { result } = renderBulkHook([cachedPaper]);
    await act(async () => {
      await result.current.reevaluateStudyTypes(pool);
    });

    expect(mockEvaluateStudyType).toHaveBeenCalledTimes(3);
    expect(structuredArgOfCall(0)).toBeUndefined();
    expect(structuredArgOfCall(1)).toBeUndefined();
    expect(structuredArgOfCall(2)).toBeUndefined();
    // Every row still re-evaluates; none is skipped or made unevaluable.
    for (const call of mockEvaluateStudyType.mock.calls) {
      expect(call[2]).toBe("Case Report");
    }
  });
});

// ── Read-path version skew: new frontend against a pre-migration database ──
//
// Merging auto-deploys this frontend through Vercel, while applying the
// migration is a separate later owner decision. For that interval the
// structured column does not exist, and re-evaluation must keep working
// rather than take the whole study-type pool feature down.

describe("reevaluateStudyTypes — pre-migration schema compatibility", () => {
  const pool = [{ study_type: "Clinical Trial, Phase II", specificity_weight: 1, hierarchy_rank: 1 }];

  const legacyRow = {
    id: "legacy-1",
    title: "Legacy paper",
    abstract: null,
    study_type: "Journal Article",
    raw_study_type: "Randomized Controlled Trial, Journal Article",
  };

  /** Structured select fails as a pre-migration database does; legacy succeeds. */
  function respondAsPreMigrationSchema(legacyResult?: SelectResult) {
    papersSelectResponder.respond = (select) =>
      select === STRUCTURED_SELECT
        ? { data: null, error: MISSING_COLUMN_ERROR }
        : (legacyResult ?? { data: [legacyRow], error: null });
  }

  it("issues exactly one query when the structured column exists", async () => {
    respondWithRows([{ ...legacyRow, raw_publication_types: ["Clinical Trial, Phase II"] }]);

    const { result } = renderBulkHook([cachedPaper]);
    await act(async () => {
      await result.current.reevaluateStudyTypes(pool);
    });

    // No speculative retry on the happy path.
    expect(mockPapersSelect).toHaveBeenCalledTimes(1);
    expect(mockPapersSelect).toHaveBeenCalledWith(STRUCTURED_SELECT);
    expect(mockEvaluateStudyType.mock.calls[0][4]).toEqual(["Clinical Trial, Phase II"]);
  });

  it("retries once with the legacy select when the column is absent", async () => {
    respondAsPreMigrationSchema();

    const { result } = renderBulkHook([cachedPaper]);
    await act(async () => {
      await result.current.reevaluateStudyTypes(pool);
    });

    // Exactly two queries: the structured attempt, then the legacy one.
    expect(mockPapersSelect).toHaveBeenCalledTimes(2);
    expect(mockPapersSelect).toHaveBeenNthCalledWith(1, STRUCTURED_SELECT);
    expect(mockPapersSelect).toHaveBeenNthCalledWith(2, LEGACY_SELECT);
    // The bounded query survives the fallback — never widened to "*".
    expect(mockPapersSelect).not.toHaveBeenCalledWith("*");

    // Evaluation proceeds: no structured values invented, legacy fallback intact.
    expect(mockEvaluateStudyType).toHaveBeenCalledTimes(1);
    expect(mockEvaluateStudyType.mock.calls[0][4]).toBeUndefined();
    expect(mockEvaluateStudyType.mock.calls[0][2]).toBe(
      "Randomized Controlled Trial, Journal Article",
    );
  });

  it("persists the re-evaluated types through the legacy path", async () => {
    // The whole point of the fallback: the feature still completes its work.
    respondAsPreMigrationSchema();
    mockEvaluateStudyType.mockReturnValue("Randomized Controlled Trial");

    const { result } = renderBulkHook([cachedPaper]);
    await act(async () => {
      await result.current.reevaluateStudyTypes(pool);
    });

    expect(mockRpc).toHaveBeenCalledWith("bulk_update_study_types", {
      updates: [{ id: "legacy-1", study_type: "Randomized Controlled Trial" }],
    });
  });

  // Nothing here is evidence that the column is absent, so none of it may
  // trigger the compatibility retry — a second query would not fix any of them,
  // it would only hide the real failure. The first case is the sharp one: the
  // same SQLSTATE as the compatibility condition, naming a different column.
  it.each([
    ["an unrelated missing column", { code: "42703", message: "column papers.some_other_column does not exist" }],
    ["a permission/RLS error", { code: "42501", message: "permission denied for table papers" }],
    ["an expired JWT", { code: "PGRST301", message: "JWT expired" }],
    ["a network failure", { message: "TypeError: Failed to fetch" }],
    ["a statement timeout", { code: "57014", message: "canceling statement due to statement timeout" }],
  ])("does not retry or swallow %s", async (_label, error) => {
    papersSelectResponder.respond = () => ({ data: null, error });

    const { result } = renderBulkHook([cachedPaper]);
    await expect(
      act(async () => {
        await result.current.reevaluateStudyTypes(pool);
      }),
    ).rejects.toMatchObject(error);

    // One attempt only, and nothing was evaluated or written.
    expect(mockPapersSelect).toHaveBeenCalledTimes(1);
    expect(mockEvaluateStudyType).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("surfaces a failure of the legacy retry itself", async () => {
    const legacyFailure = { code: "42501", message: "permission denied for table papers" };
    respondAsPreMigrationSchema({ data: null, error: legacyFailure });

    const { result } = renderBulkHook([cachedPaper]);
    await expect(
      act(async () => {
        await result.current.reevaluateStudyTypes(pool);
      }),
    ).rejects.toMatchObject(legacyFailure);

    // Two attempts, then it stops — the retry is not itself retried.
    expect(mockPapersSelect).toHaveBeenCalledTimes(2);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
