import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * Structured authorship provenance through the bulk import paths.
 *
 * Two things are pinned here: that provenance actually reaches the insert
 * payload from both the API path and the file path, and that it is aligned
 * against the SAME authors array being stored — degrading to NULL rather than
 * being written misaligned, because a misaligned array attaches every mention's
 * structure to the wrong name.
 */

const { mockRpc, mockFrom } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockFrom = vi.fn(() => ({
    select: vi.fn(() => ({ eq: vi.fn(async () => ({ data: [], error: null })) })),
    insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn() })) })),
    delete: vi.fn(() => ({ in: vi.fn(() => ({ eq: vi.fn() })) })),
  }));
  return { mockRpc, mockFrom };
});

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

import { useBulkMutations } from "../useBulkMutations";
import {
  buildUnstructuredAuthorProvenance,
  makeAuthorProvenance,
  type AuthorProvenance,
} from "@/lib/authorProvenance";
import type { PaperWithTags, Project, Tag } from "@/types/database";
import type { NormalizationConfig, RawPaperData } from "@/lib/normalizePaperData";
import type { ServerFilterParams, ServerSortParams } from "../types";
import { VALID_ORCID } from "@/lib/__tests__/fixtures/orcidVectors";

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
const normalizationConfig: NormalizationConfig = {
  synonymLookup: {},
  poolStudyTypes: [],
  poolKeywords: [],
  synonymGroups: [],
};

function renderBulkHook() {
  return renderHook(() =>
    useBulkMutations(
      userId,
      [],
      emptyProjects,
      emptyTags,
      normalizationConfig,
      emptyFilters,
      emptySort,
    ),
  );
}

function insertPayloadRow(index = 0): Record<string, unknown> {
  const chunk = mockProcessChunkedInsert.mock.calls[0][0] as Record<string, unknown>[];
  return chunk[index];
}

const PUBMED_PROVENANCE: AuthorProvenance[] = [
  makeAuthorProvenance({
    source: "pubmed_api",
    source_field: "Author",
    kind: "personal",
    source_name: "Ricardo Soto-Rifo",
    given_name: "Ricardo",
    family_name: "Soto-Rifo",
    affiliations: ["Universidad de Chile"],
    identifiers: [{ scheme: "ORCID", value: VALID_ORCID }],
  }),
];

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    identifier: "12345",
    title: "Test Paper",
    authors: ["Ricardo Soto-Rifo"],
    author_provenance: PUBMED_PROVENANCE,
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
    ...overrides,
  };
}

function parsedPaper(overrides: Partial<RawPaperData> = {}): RawPaperData {
  return {
    title: "Test Paper",
    authors: ["Author One"],
    author_provenance: buildUnstructuredAuthorProvenance(["Author One"], "csv", "authors"),
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
});

describe("bulkImportPapers — provenance from the metadata Edge response", () => {
  it("hands provenance to normalization and on into the insert payload", async () => {
    mockFetchPaperMetadata.mockResolvedValue([metadata()]);
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"]);
    });

    // It survives the normalization boundary...
    const normalized = (mockNormalize.mock.calls[0][0] as RawPaperData[])[0];
    expect(normalized.author_provenance).toEqual(PUBMED_PROVENANCE);

    // ...and reaches storage intact, ORCID included.
    const row = insertPayloadRow();
    expect(row.authors).toEqual(["Ricardo Soto-Rifo"]);
    expect(row.author_provenance).toEqual(PUBMED_PROVENANCE);
    expect((row.author_provenance as AuthorProvenance[])[0].orcid).toBe(VALID_ORCID);
  });

  it("writes NULL when an older deployed Edge Function omits the field", async () => {
    // Rollout skew: the frontend merges before the function is deployed. A
    // missing field must mean "no provenance", never a failed import.
    mockFetchPaperMetadata.mockResolvedValue([metadata({ author_provenance: undefined })]);
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"]);
    });

    const row = insertPayloadRow();
    expect(row.authors).toEqual(["Ricardo Soto-Rifo"]);
    expect(row.author_provenance).toBeNull();
  });

  it("degrades to NULL rather than storing an array misaligned with authors", async () => {
    mockFetchPaperMetadata.mockResolvedValue([
      metadata({ authors: ["Ricardo Soto-Rifo", "Second Author"] }),
    ]);
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"]);
    });

    const row = insertPayloadRow();
    expect(row.authors).toHaveLength(2);
    // One entry for two authors would put Soto-Rifo's ORCID beside whichever
    // name landed at index 0 downstream. Absence is the only safe alternative.
    expect(row.author_provenance).toBeNull();
  });
});

describe("bulkImportFromParsedData — provenance from file parsers", () => {
  it("carries parser provenance through to the insert payload", async () => {
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportFromParsedData([parsedPaper()]);
    });

    const row = insertPayloadRow();
    expect(row.authors).toEqual(["Author One"]);
    const provenance = row.author_provenance as AuthorProvenance[];
    expect(provenance).toHaveLength(1);
    expect(provenance[0].source).toBe("csv");
    expect(provenance[0].kind).toBe("unknown");
  });

  it("writes NULL for a parser that produced no authors", async () => {
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportFromParsedData([
        parsedPaper({ authors: [], author_provenance: null }),
      ]);
    });

    expect(insertPayloadRow().author_provenance).toBeNull();
  });

  it("degrades to NULL when a parser array does not match its authors", async () => {
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportFromParsedData([
        parsedPaper({
          authors: ["Author One", "Author Two"],
          author_provenance: buildUnstructuredAuthorProvenance(["Author One"], "csv", "authors"),
        }),
      ]);
    });

    expect(insertPayloadRow().author_provenance).toBeNull();
  });
});
