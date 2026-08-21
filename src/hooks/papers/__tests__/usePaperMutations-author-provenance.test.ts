import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * Structured authorship provenance through the single-paper mutation paths.
 *
 * The correctness requirement these tests exist for: provenance describes the
 * exact author strings a source supplied, so once the user rewrites those
 * strings the old given/family components, affiliations and ORCID stop
 * describing what is stored. An ORCID left attached to a name the user changed
 * is a false claim about a person — the worst thing this column can produce.
 *
 * The opposite failure matters just as much. `EditPaperDialog` submits the
 * authors array on *every* save, so a naive "the key is present, rebuild it"
 * rule would destroy real PubMed provenance every time someone edited a note.
 * Both halves are pinned below.
 */

const {
  mockInsert,
  mockSelect,
  mockSingle,
  mockFrom,
  mockRpc,
  mockUpdate,
  mockUpdateEq,
  mockUpdateResolve,
  mockPreflightMaybeSingle,
} = vi.hoisted(() => {
  const mockSingle = vi.fn();
  const mockSelect = vi.fn(() => ({ single: mockSingle }));
  // Typed to accept the payload argument so `.mock.calls[n][0]` is the row the
  // hook actually wrote — that payload IS the assertion in these tests.
  const mockInsert = vi.fn((_row: Record<string, unknown>) => ({ select: mockSelect }));
  const mockRpc = vi.fn();
  const mockUpdateResolve = vi.fn();
  const mockUpdateEq: ReturnType<typeof vi.fn> = vi.fn((..._args: unknown[]) => ({
    eq: mockUpdateEq,
    then: (onResolve: unknown, onReject: unknown) =>
      (mockUpdateResolve() as Promise<unknown>).then(
        onResolve as (v: unknown) => unknown,
        onReject as (r: unknown) => unknown,
      ),
  }));
  const mockUpdate = vi.fn((_patch: Record<string, unknown>) => ({ eq: mockUpdateEq }));

  const mockPreflightMaybeSingle = vi.fn();
  const mockPreflightLimit = vi.fn(() => ({ maybeSingle: mockPreflightMaybeSingle }));
  const mockPreflightSecondEq = vi.fn(() => ({ limit: mockPreflightLimit }));
  const mockPreflightFirstEq = vi.fn(() => ({ eq: mockPreflightSecondEq }));
  const mockPreflightTopSelect = vi.fn(() => ({ eq: mockPreflightFirstEq }));

  const mockFrom = vi.fn(() => ({
    insert: mockInsert,
    update: mockUpdate,
    select: mockPreflightTopSelect,
  }));

  return {
    mockInsert, mockSelect, mockSingle, mockFrom, mockRpc,
    mockUpdate, mockUpdateEq, mockUpdateResolve, mockPreflightMaybeSingle,
  };
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
  }),
}));

vi.mock("@/hooks/useNormalizationWorker", () => ({
  useNormalizationWorker: () => ({
    normalize: vi.fn(async (papers: unknown[]) => papers),
  }),
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
    // 001C: a real change to the authors array makes the database clear that
    // paper's identity links in the same transaction, so the update path
    // invalidates the identity dataset alongside the provenance rebuild.
    authorIdentities: { all: (uid: string) => ["authorIdentities", uid] },
  },
}));

import { usePaperMutations } from "../usePaperMutations";
import type { AuthorProvenance } from "@/lib/authorProvenance";
import type { PaperWithTags, Project, Tag } from "@/types/database";
import type { ServerFilterParams, ServerSortParams } from "../types";

const userId = "user-1";
const paperId = "paper-1";
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

/** Rich PubMed provenance — exactly what must never survive an author rewrite. */
const PUBMED_PROVENANCE: AuthorProvenance[] = [
  {
    source: "pubmed_api",
    source_field: "Author",
    kind: "personal",
    source_name: "Stuart M Phillips",
    given_name: "Stuart M",
    family_name: "Phillips",
    initials: "SM",
    suffix: null,
    collective_name: null,
    affiliations: ["McMaster University"],
    identifiers: [{ scheme: "ORCID", value: "0000-0002-1825-0097" }],
    orcid: "0000-0002-1825-0097",
    orcid_authenticated: null,
  },
  {
    source: "pubmed_api",
    source_field: "Author",
    kind: "personal",
    source_name: "Jane Q Doe",
    given_name: "Jane Q",
    family_name: "Doe",
    initials: "JQ",
    suffix: null,
    collective_name: null,
    affiliations: [],
    identifiers: [],
    orcid: null,
    orcid_authenticated: null,
  },
];

const STORED_AUTHORS = ["Stuart M Phillips", "Jane Q Doe"];

function loadedPaper(): PaperWithTags {
  return {
    id: paperId,
    user_id: userId,
    title: "A Great Paper",
    authors: [...STORED_AUTHORS],
    author_provenance: PUBMED_PROVENANCE,
    year: 2024,
    journal: "Nature",
    pmid: "1",
    doi: null,
    study_type: null,
    raw_study_type: null,
    statistical_methods: null,
    keywords: [],
    raw_keywords: null,
    mesh_terms: [],
    substances: [],
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
    tldr: null,
    notes: null,
    insert_order: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    tags: [],
    projects: [],
  };
}

/** The payload handed to `.update(...)` by the last updatePaper call. */
function lastUpdatePayload(): Record<string, unknown> {
  const call = mockUpdate.mock.calls.at(-1);
  if (!call) throw new Error("updatePaper issued no papers-row update");
  return call[0];
}

/** The row handed to `.insert(...)` by the last addPaperManually call. */
function lastInsertPayload(): Record<string, unknown> {
  const call = mockInsert.mock.calls.at(-1);
  if (!call) throw new Error("addPaperManually issued no papers-row insert");
  return call[0];
}

function renderMutations(papers: PaperWithTags[]) {
  return renderHook(() =>
    usePaperMutations(userId, papers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateResolve.mockResolvedValue({ error: null });
  mockRpc.mockResolvedValue({ error: null });
  mockSingle.mockResolvedValue({ data: { id: paperId }, error: null });
  mockPreflightMaybeSingle.mockResolvedValue({ data: null, error: null });
});

describe("updatePaper – provenance is preserved when authors do not change", () => {
  it("leaves provenance untouched when only an unrelated field is edited", async () => {
    const { result } = renderMutations([loadedPaper()]);

    await act(async () => {
      await result.current.updatePaper(paperId, { notes: "a new note" });
    });

    const payload = lastUpdatePayload();
    expect(payload).toEqual({ notes: "a new note" });
    // The key must be entirely absent — not null, not rebuilt.
    expect("author_provenance" in payload).toBe(false);
  });

  it("leaves provenance untouched when the SAME authors array is resubmitted", async () => {
    // The realistic Edit-dialog save: every field comes back, authors included
    // and unchanged. This is the case a presence-based rule would corrupt.
    const { result } = renderMutations([loadedPaper()]);

    await act(async () => {
      await result.current.updatePaper(paperId, {
        authors: [...STORED_AUTHORS],
        year: 2025,
        notes: "edited",
      });
    });

    const payload = lastUpdatePayload();
    expect(payload.authors).toEqual(STORED_AUTHORS);
    expect("author_provenance" in payload).toBe(false);
  });
});

describe("updatePaper – provenance is replaced when authors change", () => {
  /** Every rebuilt entry must be honest manual/unknown with nothing carried over. */
  function expectRebuiltAs(payload: Record<string, unknown>, names: string[]) {
    const provenance = payload.author_provenance as AuthorProvenance[] | null;
    expect(provenance).not.toBeNull();
    expect(provenance).toHaveLength(names.length);
    provenance!.forEach((entry, index) => {
      expect(entry.source).toBe("manual");
      expect(entry.source_field).toBe("authors");
      expect(entry.kind).toBe("unknown");
      expect(entry.source_name).toBe(names[index]);
      expect(entry.given_name).toBeNull();
      expect(entry.family_name).toBeNull();
      expect(entry.initials).toBeNull();
      expect(entry.suffix).toBeNull();
      expect(entry.collective_name).toBeNull();
      expect(entry.affiliations).toEqual([]);
      expect(entry.identifiers).toEqual([]);
      expect(entry.orcid).toBeNull();
      expect(entry.orcid_authenticated).toBeNull();
    });
  }

  it("rebuilds on a spelling change, dropping the previous ORCID", async () => {
    const { result } = renderMutations([loadedPaper()]);
    const edited = ["Stuart Phillips", "Jane Q Doe"];

    await act(async () => {
      await result.current.updatePaper(paperId, { authors: edited });
    });

    const payload = lastUpdatePayload();
    expectRebuiltAs(payload, edited);
    // The precise failure this guard exists to prevent.
    expect(JSON.stringify(payload.author_provenance)).not.toContain("0000-0002-1825-0097");
  });

  it("rebuilds on a punctuation-only change", async () => {
    const { result } = renderMutations([loadedPaper()]);
    const edited = ["Stuart M. Phillips", "Jane Q Doe"];

    await act(async () => {
      await result.current.updatePaper(paperId, { authors: edited });
    });

    // 001A would call these two spellings the same *mention*; provenance is
    // bound to the literal string a source supplied, so it is still stale.
    expectRebuiltAs(lastUpdatePayload(), edited);
  });

  it("rebuilds on a reorder, and does not merely reorder the old objects", async () => {
    const { result } = renderMutations([loadedPaper()]);
    const edited = ["Jane Q Doe", "Stuart M Phillips"];

    await act(async () => {
      await result.current.updatePaper(paperId, { authors: edited });
    });

    const payload = lastUpdatePayload();
    expectRebuiltAs(payload, edited);
    expect(JSON.stringify(payload.author_provenance)).not.toContain("0000-0002-1825-0097");
  });

  it("rebuilds when an author is added", async () => {
    const { result } = renderMutations([loadedPaper()]);
    const edited = [...STORED_AUTHORS, "New Person"];

    await act(async () => {
      await result.current.updatePaper(paperId, { authors: edited });
    });

    expectRebuiltAs(lastUpdatePayload(), edited);
  });

  it("rebuilds when an author is deleted", async () => {
    const { result } = renderMutations([loadedPaper()]);
    const edited = ["Jane Q Doe"];

    await act(async () => {
      await result.current.updatePaper(paperId, { authors: edited });
    });

    expectRebuiltAs(lastUpdatePayload(), edited);
  });

  it("stores NULL — never an empty array — when every author is deleted", async () => {
    const { result } = renderMutations([loadedPaper()]);

    await act(async () => {
      await result.current.updatePaper(paperId, { authors: [] });
    });

    const payload = lastUpdatePayload();
    expect(payload.authors).toEqual([]);
    expect(payload.author_provenance).toBeNull();
  });

  it("writes authors and provenance in ONE update, so they cannot half-apply", async () => {
    const { result } = renderMutations([loadedPaper()]);

    await act(async () => {
      await result.current.updatePaper(paperId, { authors: ["Someone Else"] });
    });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const payload = lastUpdatePayload();
    expect(payload).toHaveProperty("authors");
    expect(payload).toHaveProperty("author_provenance");
  });

  it("fails closed when the paper is not in the loaded list", async () => {
    // Unable to prove the authors are unchanged, so it rebuilds. Safe in this
    // direction: the rebuilt value is truthful (the user did submit these
    // strings through the edit form), whereas keeping unproven provenance
    // risks a stale ORCID on a changed name.
    const { result } = renderMutations([]);

    await act(async () => {
      await result.current.updatePaper(paperId, { authors: [...STORED_AUTHORS] });
    });

    expectRebuiltAs(lastUpdatePayload(), STORED_AUTHORS);
  });
});

describe("addPaperManually – provenance for hand-typed authors", () => {
  function manualData(authors: string) {
    return {
      title: "Manual Paper",
      authors,
      year: "2024",
      journal: "",
      pmid: "",
      doi: "",
      abstract: "",
      keywords: "",
      driveUrl: "",
    };
  }

  it("records each typed name as an unknown manual mention", async () => {
    const { result } = renderMutations([]);

    await act(async () => {
      await result.current.addPaperManually(manualData("Smith, John; Jones"));
    });

    const inserted = lastInsertPayload();
    const provenance = inserted.author_provenance as AuthorProvenance[];
    // The existing comma split is untouched, and no entry is classified or
    // decomposed — "Smith" and "John; Jones" are just two typed strings.
    expect(inserted.authors).toEqual(["Smith", "John; Jones"]);
    expect(provenance).toHaveLength(2);
    expect(provenance.every((entry) => entry.kind === "unknown")).toBe(true);
    expect(provenance.every((entry) => entry.source === "manual")).toBe(true);
    expect(provenance.every((entry) => entry.family_name === null)).toBe(true);
    expect(provenance.every((entry) => entry.orcid === null)).toBe(true);
    expect(provenance.map((entry) => entry.source_name)).toEqual([
      "Smith",
      "John; Jones",
    ]);
  });

  it("stores NULL when no authors were entered", async () => {
    const { result } = renderMutations([]);

    await act(async () => {
      await result.current.addPaperManually(manualData("   "));
    });

    const inserted = lastInsertPayload();
    expect(inserted.authors).toEqual([]);
    expect(inserted.author_provenance).toBeNull();
  });
});
