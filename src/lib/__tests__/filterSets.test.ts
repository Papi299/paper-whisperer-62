import { describe, it, expect } from "vitest";
import {
  dedupeIds,
  canonicalizeIds,
  intersectIdSets,
  resolveFilterPaperIds,
  resolveJunctionPaperIds,
  junctionQueryKey,
  type JunctionRow,
} from "../filterSets";

// ── dedupeIds ───────────────────────────────────────────────────────────

describe("dedupeIds", () => {
  it("collapses duplicate paper IDs (one paper in several selected projects)", () => {
    expect(dedupeIds(["p1", "p2", "p1", "p3", "p2"])).toEqual(["p1", "p2", "p3"]);
  });

  it("preserves first-seen order", () => {
    expect(dedupeIds(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });

  it("returns [] for an empty input", () => {
    expect(dedupeIds([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = ["p1", "p1", "p2"];
    dedupeIds(input);
    expect(input).toEqual(["p1", "p1", "p2"]);
  });
});

// ── canonicalizeIds ─────────────────────────────────────────────────────

describe("canonicalizeIds", () => {
  it("produces an identical key regardless of selection order", () => {
    expect(canonicalizeIds(["A", "B"])).toEqual(canonicalizeIds(["B", "A"]));
  });

  it("dedupes and sorts", () => {
    expect(canonicalizeIds(["B", "A", "B", "C"])).toEqual(["A", "B", "C"]);
  });

  it("does not mutate the input (safe on React state arrays)", () => {
    const input = ["C", "A", "B"];
    canonicalizeIds(input);
    expect(input).toEqual(["C", "A", "B"]);
  });

  it("returns [] for an empty input", () => {
    expect(canonicalizeIds([])).toEqual([]);
  });
});

// ── intersectIdSets ─────────────────────────────────────────────────────

describe("intersectIdSets", () => {
  it("returns the single set (deduped) when only one is given", () => {
    expect(intersectIdSets([["p1", "p2", "p2"]]).sort()).toEqual(["p1", "p2"]);
  });

  it("intersects two sets (AND across categories)", () => {
    expect(intersectIdSets([["p1", "p2", "p3"], ["p2", "p3", "p4"]]).sort()).toEqual([
      "p2",
      "p3",
    ]);
  });

  it("intersects three sets", () => {
    const result = intersectIdSets([
      ["p1", "p2", "p3"],
      ["p2", "p3", "p4"],
      ["p3", "p2"],
    ]).sort();
    expect(result).toEqual(["p2", "p3"]);
  });

  it("returns [] when the sets are disjoint", () => {
    expect(intersectIdSets([["p1"], ["p2"]])).toEqual([]);
  });

  it("returns [] for no sets", () => {
    expect(intersectIdSets([])).toEqual([]);
  });
});

// ── resolveFilterPaperIds (four-state model) ────────────────────────────

describe("resolveFilterPaperIds", () => {
  it("returns null when no category is active (no ID filtering)", () => {
    expect(
      resolveFilterPaperIds([
        { active: false, ids: undefined },
        { active: false, ids: ["p1"] },
      ]),
    ).toBeNull();
  });

  it("returns undefined when any active category is still loading", () => {
    expect(
      resolveFilterPaperIds([
        { active: true, ids: undefined },
        { active: true, ids: ["p1", "p2"] },
      ]),
    ).toBeUndefined();
  });

  it("returns the resolved set for a single active category (project union)", () => {
    expect(
      resolveFilterPaperIds([{ active: true, ids: ["p1", "p2"] }])?.sort(),
    ).toEqual(["p1", "p2"]);
  });

  it("intersects a project union with a tag union (AND across categories)", () => {
    const result = resolveFilterPaperIds([
      { active: true, ids: ["p1", "p2", "p3"] }, // projects OR-union
      { active: true, ids: ["p2", "p3", "p9"] }, // tags OR-union
    ]);
    expect(result?.sort()).toEqual(["p2", "p3"]);
  });

  it("intersects project/tag unions with a keyword/search set", () => {
    const result = resolveFilterPaperIds([
      { active: true, ids: ["p1", "p2", "p3"] },
      { active: true, ids: ["p2", "p3", "p4"] },
      { active: true, ids: ["p3"] }, // search matches
    ]);
    expect(result).toEqual(["p3"]);
  });

  it("returns [] (resolved, no match) when active sets are disjoint", () => {
    expect(
      resolveFilterPaperIds([
        { active: true, ids: ["p1"] },
        { active: true, ids: ["p2"] },
      ]),
    ).toEqual([]);
  });

  it("ignores inactive categories even when they carry ids", () => {
    const result = resolveFilterPaperIds([
      { active: true, ids: ["p1", "p2"] },
      { active: false, ids: ["p2"] }, // inactive — must not narrow the result
    ]);
    expect(result?.slice().sort()).toEqual(["p1", "p2"]);
  });
});

// ── resolveJunctionPaperIds (Any / All match modes) ─────────────────────

/** Build a project-shaped junction row. */
function projRow(paper_id: string, entity_id: string): JunctionRow {
  return { paper_id, entity_id };
}

describe("resolveJunctionPaperIds", () => {
  it("returns [] for Any with zero selected IDs", () => {
    expect(resolveJunctionPaperIds([projRow("pa", "e1")], [], "any")).toEqual([]);
  });

  it("returns [] for All with zero selected IDs (never trivially matches all)", () => {
    expect(resolveJunctionPaperIds([projRow("pa", "e1")], [], "all")).toEqual([]);
  });

  it("Any with one selected ID returns papers linked to it", () => {
    const rows = [projRow("pa", "e1"), projRow("pb", "e1"), projRow("pc", "e2")];
    expect(resolveJunctionPaperIds(rows, ["e1"], "any").sort()).toEqual(["pa", "pb"]);
  });

  it("Any with multiple selected IDs unions the matching papers", () => {
    const rows = [projRow("pa", "e1"), projRow("pb", "e2"), projRow("pc", "e3")];
    expect(resolveJunctionPaperIds(rows, ["e1", "e2"], "any").sort()).toEqual(["pa", "pb"]);
  });

  it("All with one selected ID matches the same papers as Any (equivalent)", () => {
    const rows = [projRow("pa", "e1"), projRow("pb", "e1")];
    const any = resolveJunctionPaperIds(rows, ["e1"], "any").sort();
    const all = resolveJunctionPaperIds(rows, ["e1"], "all").sort();
    expect(all).toEqual(any);
    expect(all).toEqual(["pa", "pb"]);
  });

  it("All with two selected IDs requires membership in both", () => {
    const rows = [
      projRow("pa", "e1"),
      projRow("pa", "e2"), // pa has both
      projRow("pb", "e1"), // pb has only e1
    ];
    expect(resolveJunctionPaperIds(rows, ["e1", "e2"], "all")).toEqual(["pa"]);
  });

  it("All excludes a paper matching only one of two selected IDs", () => {
    const rows = [projRow("pb", "e1")];
    expect(resolveJunctionPaperIds(rows, ["e1", "e2"], "all")).toEqual([]);
  });

  it("All includes a paper matching every selected ID", () => {
    const rows = [projRow("pa", "e1"), projRow("pa", "e2"), projRow("pa", "e3")];
    expect(resolveJunctionPaperIds(rows, ["e1", "e2", "e3"], "all")).toEqual(["pa"]);
  });

  it("duplicate junction rows do not inflate the All count", () => {
    const rows = [
      projRow("pa", "e1"),
      projRow("pa", "e1"), // duplicate pair
      projRow("pa", "e2"),
      projRow("pb", "e1"),
      projRow("pb", "e1"), // pb matches only e1, even twice
    ];
    expect(resolveJunctionPaperIds(rows, ["e1", "e2"], "all")).toEqual(["pa"]);
  });

  it("normalizes duplicate selected IDs (['e1','e1'] behaves as ['e1'])", () => {
    const rows = [projRow("pa", "e1"), projRow("pb", "e1")];
    expect(resolveJunctionPaperIds(rows, ["e1", "e1"], "all").sort()).toEqual(["pa", "pb"]);
  });

  it("ignores junction rows for unselected entities (Any)", () => {
    const rows = [projRow("pa", "e1"), projRow("pb", "e-unselected")];
    expect(resolveJunctionPaperIds(rows, ["e1"], "any")).toEqual(["pa"]);
  });

  it("ignores junction rows for unselected entities (All membership count)", () => {
    // pa is linked to e1 and an unselected entity; with two selected (e1,e2)
    // the unselected row must not count toward the required membership.
    const rows = [projRow("pa", "e1"), projRow("pa", "e-unselected"), projRow("pa", "e2")];
    expect(resolveJunctionPaperIds(rows, ["e1", "e2"], "all")).toEqual(["pa"]);
    const rowsShort = [projRow("pa", "e1"), projRow("pa", "e-unselected")];
    expect(resolveJunctionPaperIds(rowsShort, ["e1", "e2"], "all")).toEqual([]);
  });

  it("returns unique paper IDs (Any dedupes multi-membership)", () => {
    const rows = [projRow("pa", "e1"), projRow("pa", "e2")];
    const result = resolveJunctionPaperIds(rows, ["e1", "e2"], "any");
    expect(result).toEqual(["pa"]);
    expect(new Set(result).size).toBe(result.length);
  });

  it("does not mutate the rows or the selected IDs", () => {
    const rows = [projRow("pa", "e1"), projRow("pa", "e2")];
    const rowsSnapshot = JSON.stringify(rows);
    const selected = ["e1", "e2"];
    resolveJunctionPaperIds(rows, selected, "all");
    expect(JSON.stringify(rows)).toBe(rowsSnapshot);
    expect(selected).toEqual(["e1", "e2"]);
  });

  it("works identically for tag-shaped rows (entity_id = tag_id)", () => {
    const rows: JunctionRow[] = [
      { paper_id: "pa", entity_id: "omega" },
      { paper_id: "pa", entity_id: "muscle" },
      { paper_id: "pb", entity_id: "omega" },
      { paper_id: "pa", entity_id: "omega" }, // duplicate
    ];
    expect(resolveJunctionPaperIds(rows, ["omega", "muscle"], "all")).toEqual(["pa"]);
    expect(resolveJunctionPaperIds(rows, ["omega", "muscle"], "any").sort()).toEqual(["pa", "pb"]);
  });
});

// ── junctionQueryKey (mode-aware, canonical) ────────────────────────────

describe("junctionQueryKey", () => {
  it("includes the table, mode and canonical IDs", () => {
    expect(junctionQueryKey("paper_projects", "any", ["b", "a"])).toEqual([
      "junction",
      "paper_projects",
      "any",
      ["a", "b"],
    ]);
  });

  it("produces different keys for Any vs All (no shared cache entry)", () => {
    const anyKey = junctionQueryKey("paper_tags", "any", ["t1", "t2"]);
    const allKey = junctionQueryKey("paper_tags", "all", ["t1", "t2"]);
    expect(anyKey).not.toEqual(allKey);
  });

  it("reuses the same canonical key regardless of selection order", () => {
    expect(junctionQueryKey("paper_projects", "all", ["p2", "p1"])).toEqual(
      junctionQueryKey("paper_projects", "all", ["p1", "p2"]),
    );
  });

  it("dedupes IDs in the key and does not mutate the input", () => {
    const input = ["p1", "p1", "p2"];
    const key = junctionQueryKey("paper_projects", "any", input);
    expect(key[3]).toEqual(["p1", "p2"]);
    expect(input).toEqual(["p1", "p1", "p2"]);
  });
});
