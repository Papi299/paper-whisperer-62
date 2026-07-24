import { describe, it, expect } from "vitest";
import {
  dedupeIds,
  canonicalizeIds,
  intersectIdSets,
  resolveFilterPaperIds,
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
