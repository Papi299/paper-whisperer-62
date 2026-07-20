import { describe, it, expect } from "vitest";
import { parseDuplicateGroups } from "../parseDuplicateGroups";
import { suggestKeepPaper, mergeOverlappingGroups } from "@/hooks/useDeduplication";
import type { Json } from "@/integrations/supabase/types";
import type { DuplicateGroup, DuplicatePaperInfo } from "@/types/database";

/** Build a raw RPC paper object with the given id and optional overrides. */
function rawPaper(id: string, overrides: Record<string, Json> = {}): Json {
  return {
    id,
    title: `Title ${id}`,
    authors: ["A"],
    year: 2020,
    journal: "J",
    pmid: null,
    doi: null,
    abstract: null,
    study_type: null,
    keywords: [],
    created_at: "2020-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("parseDuplicateGroups", () => {
  it("returns [] for non-array payloads", () => {
    expect(parseDuplicateGroups(null)).toEqual([]);
    expect(parseDuplicateGroups("nope" as Json)).toEqual([]);
    expect(parseDuplicateGroups(42 as Json)).toEqual([]);
    expect(parseDuplicateGroups({ match_type: "doi" } as Json)).toEqual([]);
  });

  it("discards a group whose `papers` is missing", () => {
    const data: Json = [{ match_type: "doi", match_value: "10.1/x" }];
    expect(parseDuplicateGroups(data)).toEqual([]);
  });

  it("discards a group with an empty `papers` array", () => {
    const data: Json = [{ match_type: "doi", match_value: "10.1/x", papers: [] }];
    expect(parseDuplicateGroups(data)).toEqual([]);
  });

  it("discards a group with only one valid paper", () => {
    const data: Json = [{ match_type: "pmid", match_value: "111", papers: [rawPaper("p1")] }];
    expect(parseDuplicateGroups(data)).toEqual([]);
  });

  it("discards a group with one valid paper plus malformed entries", () => {
    const data: Json = [
      {
        match_type: "doi",
        match_value: "10.1/x",
        papers: [rawPaper("p1"), { title: "no id" }, "not an object", 7, null],
      },
    ];
    expect(parseDuplicateGroups(data)).toEqual([]);
  });

  it("retains a group with two valid distinct papers", () => {
    const data: Json = [
      { match_type: "doi", match_value: "10.1/x", papers: [rawPaper("p1"), rawPaper("p2")] },
    ];
    const groups = parseDuplicateGroups(data);
    expect(groups).toHaveLength(1);
    expect(groups[0].match_type).toBe("doi");
    expect(groups[0].papers.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("retains three valid papers in RPC order", () => {
    const data: Json = [
      {
        match_type: "pmid",
        match_value: "222",
        papers: [rawPaper("p3"), rawPaper("p1"), rawPaper("p2")],
      },
    ];
    const groups = parseDuplicateGroups(data);
    expect(groups).toHaveLength(1);
    expect(groups[0].papers.map((p) => p.id)).toEqual(["p3", "p1", "p2"]);
  });

  it("discards a group whose two entries share the same paper id (dedup → one)", () => {
    const data: Json = [
      {
        match_type: "doi",
        match_value: "10.1/x",
        papers: [rawPaper("dup"), rawPaper("dup", { title: "Other" })],
      },
    ];
    expect(parseDuplicateGroups(data)).toEqual([]);
  });

  it("keeps exactly two papers when three entries hold two distinct ids", () => {
    const data: Json = [
      {
        match_type: "pmid",
        match_value: "333",
        papers: [rawPaper("a"), rawPaper("a", { title: "dup a" }), rawPaper("b")],
      },
    ];
    const groups = parseDuplicateGroups(data);
    expect(groups).toHaveLength(1);
    expect(groups[0].papers.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("discards a group with an empty or whitespace-only match_value", () => {
    const data: Json = [
      { match_type: "doi", match_value: "", papers: [rawPaper("p1"), rawPaper("p2")] },
      { match_type: "pmid", match_value: "   ", papers: [rawPaper("p3"), rawPaper("p4")] },
    ];
    expect(parseDuplicateGroups(data)).toEqual([]);
  });

  it("discards a raw group with match_type 'both' (RPC only emits doi/pmid)", () => {
    const data: Json = [
      { match_type: "both", match_value: "x", papers: [rawPaper("p1"), rawPaper("p2")] },
    ];
    expect(parseDuplicateGroups(data)).toEqual([]);
  });

  it("coerces malformed optional fields to safe defaults", () => {
    const data: Json = [
      {
        match_type: "doi",
        match_value: "10.2/y",
        papers: [
          { id: "p2", title: "Minimal" }, // missing optional fields
          rawPaper("p9"),
        ],
      },
    ];
    const groups = parseDuplicateGroups(data);
    expect(groups[0].papers[0]).toEqual({
      id: "p2",
      title: "Minimal",
      authors: [],
      year: null,
      journal: null,
      pmid: null,
      doi: null,
      abstract: null,
      study_type: null,
      keywords: [],
      created_at: "",
    });
  });

  it("filters non-string entries out of string-array fields", () => {
    const data: Json = [
      {
        match_type: "pmid",
        match_value: "444",
        papers: [
          rawPaper("p3", { authors: ["ok", 5, null], keywords: ["k", {}] }),
          rawPaper("p4"),
        ],
      },
    ];
    const groups = parseDuplicateGroups(data);
    expect(groups[0].papers[0].authors).toEqual(["ok"]);
    expect(groups[0].papers[0].keywords).toEqual(["k"]);
  });
});

describe("suggestKeepPaper over a parsed group", () => {
  it("picks the most complete paper from a valid at-least-two group", () => {
    const data: Json = [
      {
        match_type: "doi",
        match_value: "10.9/z",
        papers: [
          rawPaper("sparse", { authors: [], keywords: [], abstract: null }),
          rawPaper("rich", {
            authors: ["A", "B"],
            keywords: ["k1", "k2"],
            abstract: "full abstract",
            pmid: "999",
            doi: "10.9/z",
          }),
        ],
      },
    ];
    const groups = parseDuplicateGroups(data);
    expect(groups).toHaveLength(1);
    expect(suggestKeepPaper(groups[0])).toBe("rich");
  });
});

describe("mergeOverlappingGroups (DOI+PMID overlap)", () => {
  it("merges overlapping DOI and PMID groups into one 'both' group with no duplicate ids", () => {
    const doiGroup: DuplicateGroup = {
      match_type: "doi",
      match_value: "10.1/x",
      papers: [paper("p1"), paper("p2")],
    };
    const pmidGroup: DuplicateGroup = {
      match_type: "pmid",
      match_value: "555",
      papers: [paper("p2"), paper("p3")],
    };
    const merged = mergeOverlappingGroups([doiGroup, pmidGroup]);
    expect(merged).toHaveLength(1);
    expect(merged[0].match_type).toBe("both");
    const ids = merged[0].papers.map((p) => p.id);
    expect(ids).toEqual(["p1", "p2", "p3"]); // deterministic order preserved
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });

  it("keeps non-overlapping DOI and PMID groups separate", () => {
    const doiGroup: DuplicateGroup = {
      match_type: "doi",
      match_value: "10.1/x",
      papers: [paper("p1"), paper("p2")],
    };
    const pmidGroup: DuplicateGroup = {
      match_type: "pmid",
      match_value: "555",
      papers: [paper("p3"), paper("p4")],
    };
    const merged = mergeOverlappingGroups([doiGroup, pmidGroup]);
    expect(merged).toHaveLength(2);
    expect(merged.map((g) => g.match_type)).toEqual(["doi", "pmid"]);
  });
});

function paper(id: string): DuplicatePaperInfo {
  return {
    id,
    title: `Title ${id}`,
    authors: ["A"],
    year: 2020,
    journal: "J",
    pmid: null,
    doi: null,
    abstract: null,
    study_type: null,
    keywords: [],
    created_at: "2020-01-01T00:00:00Z",
  };
}
