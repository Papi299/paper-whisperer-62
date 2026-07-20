import { describe, it, expect } from "vitest";
import { parseDuplicateGroups } from "../parseDuplicateGroups";
import type { Json } from "@/integrations/supabase/types";

describe("parseDuplicateGroups", () => {
  it("returns [] for non-array payloads", () => {
    expect(parseDuplicateGroups(null)).toEqual([]);
    expect(parseDuplicateGroups("nope" as Json)).toEqual([]);
    expect(parseDuplicateGroups({ match_type: "doi" } as Json)).toEqual([]);
    expect(parseDuplicateGroups(42 as Json)).toEqual([]);
  });

  it("parses a well-formed group into the typed domain shape", () => {
    const data: Json = [
      {
        match_type: "doi",
        match_value: "10.1/x",
        papers: [
          {
            id: "p1",
            title: "Paper One",
            authors: ["A", "B"],
            year: 2020,
            journal: "J",
            pmid: "111",
            doi: "10.1/x",
            abstract: "abs",
            study_type: "RCT",
            keywords: ["k1"],
            created_at: "2020-01-01T00:00:00Z",
          },
        ],
      },
    ];
    const groups = parseDuplicateGroups(data);
    expect(groups).toHaveLength(1);
    expect(groups[0].match_type).toBe("doi");
    expect(groups[0].match_value).toBe("10.1/x");
    expect(groups[0].papers[0]).toEqual({
      id: "p1",
      title: "Paper One",
      authors: ["A", "B"],
      year: 2020,
      journal: "J",
      pmid: "111",
      doi: "10.1/x",
      abstract: "abs",
      study_type: "RCT",
      keywords: ["k1"],
      created_at: "2020-01-01T00:00:00Z",
    });
  });

  it("skips groups with an invalid match_type or missing match_value", () => {
    const data: Json = [
      { match_type: "both", match_value: "x", papers: [] },
      { match_type: "doi", papers: [] },
      { match_type: "pmid", match_value: "222", papers: [] },
    ];
    const groups = parseDuplicateGroups(data);
    expect(groups).toHaveLength(1);
    expect(groups[0].match_type).toBe("pmid");
  });

  it("coerces missing/malformed paper fields to safe defaults and drops shapeless papers", () => {
    const data: Json = [
      {
        match_type: "doi",
        match_value: "10.2/y",
        papers: [
          { id: "p2", title: "Minimal" }, // missing optional fields
          { title: "no id" }, // dropped: no id
          "not an object", // dropped
        ],
      },
    ];
    const groups = parseDuplicateGroups(data);
    expect(groups[0].papers).toHaveLength(1);
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
        match_value: "333",
        papers: [
          { id: "p3", title: "T", authors: ["ok", 5, null], keywords: ["k", {}] },
        ],
      },
    ];
    const groups = parseDuplicateGroups(data);
    expect(groups[0].papers[0].authors).toEqual(["ok"]);
    expect(groups[0].papers[0].keywords).toEqual(["k"]);
  });
});
