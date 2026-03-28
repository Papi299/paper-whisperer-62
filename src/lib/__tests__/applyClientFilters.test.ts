import { describe, it, expect, vi } from "vitest";
import { applyClientFilters } from "../applyClientFilters";
import type { PaperWithTags } from "@/types/database";

function makePaper(overrides: Partial<PaperWithTags> = {}): PaperWithTags {
  return {
    id: "1",
    user_id: "u1",
    title: "Test Paper",
    authors: ["Smith J", "Doe A"],
    year: 2023,
    journal: "Nature",
    pmid: null,
    doi: null,
    abstract: "This is a test abstract about cancer treatment.",
    study_type: null,
    raw_study_type: null,
    statistical_methods: null,
    keywords: ["cancer", "treatment"],
    mesh_terms: ["Neoplasms"],
    substances: [],
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
    tldr: null,
    insert_order: 1,
    created_at: "2023-01-01",
    updated_at: "2023-01-01",
    tags: [],
    projects: [],
    ...overrides,
  };
}

const noOpFindMatchingKeywords = () => [] as string[];
const noSynonyms: Record<string, string> = {};

describe("applyClientFilters", () => {
  it("returns all papers when no filters are active", () => {
    const papers = [makePaper({ id: "1" }), makePaper({ id: "2" })];
    const result = applyClientFilters(papers, {
      debouncedSearchQuery: "",
      useServerSearch: false,
      selectedKeywords: [],
      synonymLookup: noSynonyms,
      findMatchingKeywords: noOpFindMatchingKeywords,
    });
    expect(result).toHaveLength(2);
  });

  it("filters by short search query (client-side substring match)", () => {
    const papers = [
      makePaper({ id: "1", title: "Cancer Treatment Study", abstract: null }),
      makePaper({ id: "2", title: "Heart Disease Overview", abstract: "Study of heart disease." }),
    ];
    const result = applyClientFilters(papers, {
      debouncedSearchQuery: "ca", // < 3 chars, client-side
      useServerSearch: false,
      selectedKeywords: [],
      synonymLookup: noSynonyms,
      findMatchingKeywords: noOpFindMatchingKeywords,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
  });

  it("skips client search when server search is active", () => {
    const papers = [
      makePaper({ id: "1", title: "Cancer Treatment Study" }),
      makePaper({ id: "2", title: "Heart Disease Overview" }),
    ];
    const result = applyClientFilters(papers, {
      debouncedSearchQuery: "cancer",
      useServerSearch: true, // server handles it
      selectedKeywords: [],
      synonymLookup: noSynonyms,
      findMatchingKeywords: noOpFindMatchingKeywords,
    });
    // Should return all papers — server search already filtered via filterPaperIds
    expect(result).toHaveLength(2);
  });

  it("filters by keyword selection", () => {
    const papers = [
      makePaper({ id: "1", keywords: ["cancer", "treatment"] }),
      makePaper({ id: "2", keywords: ["diabetes", "insulin"] }),
    ];
    const result = applyClientFilters(papers, {
      debouncedSearchQuery: "",
      useServerSearch: false,
      selectedKeywords: ["cancer"],
      synonymLookup: noSynonyms,
      findMatchingKeywords: noOpFindMatchingKeywords,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
  });

  it("requires ALL selected keywords to match", () => {
    const papers = [
      makePaper({ id: "1", keywords: ["cancer", "treatment", "therapy"] }),
      makePaper({ id: "2", keywords: ["cancer", "diagnosis"] }),
    ];
    const result = applyClientFilters(papers, {
      debouncedSearchQuery: "",
      useServerSearch: false,
      selectedKeywords: ["cancer", "treatment"],
      synonymLookup: noSynonyms,
      findMatchingKeywords: noOpFindMatchingKeywords,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
  });

  it("uses synonym lookup for keyword normalization", () => {
    const papers = [
      makePaper({ id: "1", keywords: ["neoplasm"] }), // synonym of cancer
    ];
    const result = applyClientFilters(papers, {
      debouncedSearchQuery: "",
      useServerSearch: false,
      selectedKeywords: ["cancer"],
      synonymLookup: { neoplasm: "cancer" },
      findMatchingKeywords: noOpFindMatchingKeywords,
    });
    expect(result).toHaveLength(1);
  });

  it("includes abstract-extracted keywords via findMatchingKeywords", () => {
    const papers = [
      makePaper({ id: "1", keywords: [], abstract: "This study examines cancer biomarkers." }),
    ];
    const result = applyClientFilters(papers, {
      debouncedSearchQuery: "",
      useServerSearch: false,
      selectedKeywords: ["cancer"],
      synonymLookup: noSynonyms,
      findMatchingKeywords: (abstract) =>
        abstract?.includes("cancer") ? ["cancer"] : [],
    });
    expect(result).toHaveLength(1);
  });

  it("preserves input order (does not sort)", () => {
    const papers = [
      makePaper({ id: "3", title: "Zebra" }),
      makePaper({ id: "1", title: "Alpha" }),
      makePaper({ id: "2", title: "Middle" }),
    ];
    const result = applyClientFilters(papers, {
      debouncedSearchQuery: "",
      useServerSearch: false,
      selectedKeywords: [],
      synonymLookup: noSynonyms,
      findMatchingKeywords: noOpFindMatchingKeywords,
    });
    expect(result.map((p) => p.id)).toEqual(["3", "1", "2"]);
  });

  it("searches across authors, journal, and abstract for short queries", () => {
    const papers = [
      makePaper({ id: "1", title: "Unrelated", authors: ["Smith"], journal: "Nature", abstract: null }),
      makePaper({ id: "2", title: "Unrelated", authors: ["Jones"], journal: "Science", abstract: "testing" }),
    ];

    // Match by author
    const byAuthor = applyClientFilters(papers, {
      debouncedSearchQuery: "sm",
      useServerSearch: false,
      selectedKeywords: [],
      synonymLookup: noSynonyms,
      findMatchingKeywords: noOpFindMatchingKeywords,
    });
    expect(byAuthor.map((p) => p.id)).toEqual(["1"]);

    // Match by journal
    const byJournal = applyClientFilters(papers, {
      debouncedSearchQuery: "sc",
      useServerSearch: false,
      selectedKeywords: [],
      synonymLookup: noSynonyms,
      findMatchingKeywords: noOpFindMatchingKeywords,
    });
    expect(byJournal.map((p) => p.id)).toEqual(["2"]);
  });
});
