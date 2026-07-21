import { describe, it, expect } from "vitest";
import { mergeOverlappingGroups } from "@/hooks/useDeduplication";
import type { DuplicateGroup, DuplicatePaperInfo } from "@/types/database";

/**
 * Adversarial coverage for `mergeOverlappingGroups()` as a true
 * connected-component consolidation.
 *
 * The RPC emits PMID groups before DOI groups, so a later group can bridge two
 * components that were already discovered independently. A correct
 * implementation must:
 *   1. merge every directly or transitively connected group into ONE output
 *      group (connected-component completeness);
 *   2. emit every paper ID exactly once across the WHOLE output (global
 *      uniqueness — not merely per-group dedup);
 *   3. preserve the at-least-two `DuplicatePaperSet` invariant;
 *   4. keep deterministic paper order (first appearance) and component order
 *      (first appearance);
 *   5. derive match_type ("doi" / "pmid" / "both") from the constituent groups;
 *   6. retain the earliest component group's match_value;
 *   7. never mutate its input.
 */

/** A DuplicatePaperInfo with the given id (other fields fixed/benign). */
function paper(id: string, overrides: Partial<DuplicatePaperInfo> = {}): DuplicatePaperInfo {
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

function grp(
  match_type: DuplicateGroup["match_type"],
  match_value: string,
  ids: string[],
): DuplicateGroup {
  const papers = ids.map((id) => paper(id));
  // Cast is safe in tests: every fixture below supplies ≥2 ids.
  return { match_type, match_value, papers: papers as DuplicateGroup["papers"] };
}

/** Global assertion: no paper ID appears in more than one output group. */
function expectGloballyDisjoint(result: DuplicateGroup[]): void {
  const allIds = result.flatMap((group) => group.papers.map((p) => p.id));
  expect(new Set(allIds).size).toBe(allIds.length);
}

/** Every output group must remain a valid at-least-two set. */
function expectAtLeastTwo(result: DuplicateGroup[]): void {
  for (const group of result) {
    expect(group.papers.length).toBeGreaterThanOrEqual(2);
  }
}

describe("mergeOverlappingGroups — connected components", () => {
  it("(1) merges a simple direct overlap: [A,B] + [B,C] -> [A,B,C]", () => {
    const result = mergeOverlappingGroups([
      grp("doi", "10.1/x", ["A", "B"]),
      grp("pmid", "111", ["B", "C"]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].papers.map((p) => p.id)).toEqual(["A", "B", "C"]);
    expect(result[0].match_type).toBe("both");
    expectGloballyDisjoint(result);
    expectAtLeastTwo(result);
  });

  it("(2) BRIDGE: a later group joins two already-existing components -> one component", () => {
    // PMID groups precede the DOI bridge, matching the RPC ordering.
    const result = mergeOverlappingGroups([
      grp("pmid", "111", ["A", "B"]),
      grp("pmid", "222", ["C", "D"]),
      grp("doi", "10.1/x", ["B", "C"]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].papers.map((p) => p.id)).toEqual(["A", "B", "C", "D"]);
    expect(result[0].match_type).toBe("both");
    // The earliest component group supplies the match_value.
    expect(result[0].match_value).toBe("111");
    expectGloballyDisjoint(result);
    expectAtLeastTwo(result);
  });

  it("(3) longer transitive chain collapses to a single component", () => {
    const result = mergeOverlappingGroups([
      grp("pmid", "111", ["A", "B"]),
      grp("pmid", "222", ["C", "D"]),
      grp("pmid", "333", ["E", "F"]),
      grp("doi", "10.1/x", ["B", "C"]),
      grp("doi", "10.1/y", ["D", "E"]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].papers.map((p) => p.id)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(result[0].match_type).toBe("both");
    expectGloballyDisjoint(result);
    expectAtLeastTwo(result);
  });

  it("(4) independent components remain separate", () => {
    const result = mergeOverlappingGroups([
      grp("doi", "10.1/x", ["A", "B"]),
      grp("pmid", "111", ["C", "D"]),
      grp("doi", "10.1/z", ["E", "F"]),
    ]);
    expect(result).toHaveLength(3);
    expect(result.map((g) => g.papers.map((p) => p.id))).toEqual([
      ["A", "B"],
      ["C", "D"],
      ["E", "F"],
    ]);
    expectGloballyDisjoint(result);
    expectAtLeastTwo(result);
  });

  it("(5) one group overlapping THREE previously discovered components merges all four", () => {
    const result = mergeOverlappingGroups([
      grp("pmid", "111", ["A", "B"]),
      grp("pmid", "222", ["C", "D"]),
      grp("pmid", "333", ["E", "F"]),
      grp("doi", "10.1/x", ["B", "D", "F"]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].papers.map((p) => p.id)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(result[0].match_type).toBe("both");
    expectGloballyDisjoint(result);
    expectAtLeastTwo(result);
  });

  it("(6) repeated paper IDs across several input groups appear once globally", () => {
    const result = mergeOverlappingGroups([
      grp("pmid", "111", ["A", "B"]),
      grp("doi", "10.1/x", ["A", "B"]), // same pair, both identifiers
      grp("pmid", "222", ["B", "C"]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].papers.map((p) => p.id)).toEqual(["A", "B", "C"]);
    expectGloballyDisjoint(result);
    expectAtLeastTwo(result);
  });

  it("(7) a mixed DOI+PMID component becomes 'both'", () => {
    const result = mergeOverlappingGroups([
      grp("doi", "10.1/x", ["A", "B"]),
      grp("pmid", "111", ["B", "C"]),
    ]);
    expect(result[0].match_type).toBe("both");
  });

  it("(8) a DOI-only component remains 'doi'", () => {
    const result = mergeOverlappingGroups([
      grp("doi", "10.1/x", ["A", "B"]),
      grp("doi", "10.1/y", ["B", "C"]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].match_type).toBe("doi");
  });

  it("(9) a PMID-only component remains 'pmid'", () => {
    const result = mergeOverlappingGroups([
      grp("pmid", "111", ["A", "B"]),
      grp("pmid", "222", ["B", "C"]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].match_type).toBe("pmid");
  });

  it("(10) earliest-group match_value is retained deterministically", () => {
    const result = mergeOverlappingGroups([
      grp("pmid", "EARLIEST", ["A", "B"]),
      grp("doi", "later-1", ["B", "C"]),
      grp("doi", "later-2", ["C", "D"]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].match_value).toBe("EARLIEST");
  });

  it("(11) paper order follows first appearance across the component", () => {
    const result = mergeOverlappingGroups([
      grp("pmid", "111", ["B", "A"]), // B seen before A
      grp("doi", "10.1/x", ["A", "C"]),
    ]);
    expect(result[0].papers.map((p) => p.id)).toEqual(["B", "A", "C"]);
  });

  it("(12) component order follows first appearance in the input", () => {
    const result = mergeOverlappingGroups([
      grp("pmid", "first", ["A", "B"]),
      grp("pmid", "second", ["C", "D"]),
      grp("doi", "bridge-second", ["C", "D"]), // strengthens the 2nd component
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].papers.map((p) => p.id)).toEqual(["A", "B"]);
    expect(result[1].papers.map((p) => p.id)).toEqual(["C", "D"]);
  });

  it("(13) does not mutate its input (groups or paper tuples are deeply unchanged)", () => {
    const input: DuplicateGroup[] = [
      grp("pmid", "111", ["A", "B"]),
      grp("pmid", "222", ["C", "D"]),
      grp("doi", "10.1/x", ["B", "C"]),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const inputArrayRef = input;
    const firstGroupRef = input[0];
    const firstPapersRef = input[0].papers;
    const firstPaperRef = input[0].papers[0];

    mergeOverlappingGroups(input);

    expect(input).toEqual(snapshot);
    expect(input).toBe(inputArrayRef);
    expect(input[0]).toBe(firstGroupRef);
    expect(input[0].papers).toBe(firstPapersRef);
    expect(input[0].papers[0]).toBe(firstPaperRef);
    expect(input).toHaveLength(3);
    expect(input[0].match_type).toBe("pmid"); // not rewritten to "both"
  });

  it("(14) empty input returns []", () => {
    expect(mergeOverlappingGroups([])).toEqual([]);
  });

  it("(15) one valid input group is returned as an equivalent, newly allocated group", () => {
    const only = grp("doi", "10.1/x", ["A", "B"]);
    const result = mergeOverlappingGroups([only]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(only);
    expect(result[0]).not.toBe(only); // new object
    expect(result[0].papers).not.toBe(only.papers); // new array
    expect(result[0].papers[0]).not.toBe(only.papers[0]); // new paper object
  });

  it("(16) all output groups satisfy the at-least-two invariant (many components)", () => {
    const result = mergeOverlappingGroups([
      grp("pmid", "111", ["A", "B"]),
      grp("doi", "10.1/x", ["B", "C"]),
      grp("pmid", "222", ["D", "E"]),
      grp("doi", "10.1/z", ["F", "G"]),
    ]);
    expectAtLeastTwo(result);
    expectGloballyDisjoint(result);
  });

  it("treats an application-synthesized 'both' input group as mixed evidence", () => {
    // A pre-merged "both" group bridged by a later pmid group stays "both".
    const result = mergeOverlappingGroups([
      grp("both", "10.1/x", ["A", "B"]),
      grp("pmid", "111", ["B", "C"]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].match_type).toBe("both");
    expect(result[0].papers.map((p) => p.id)).toEqual(["A", "B", "C"]);
  });
});
