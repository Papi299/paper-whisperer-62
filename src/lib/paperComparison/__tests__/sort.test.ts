import { describe, expect, it } from "vitest";
import { mapComparisonRow } from "../mapRow";
import { COMPARISON_SORTS, DEFAULT_COMPARISON_SORT, sortComparisonRows } from "../sort";
import type { ComparisonRow } from "../types";
import { OWNER_ID, makePaperRow, paperId } from "./fixtures";

function row(n: number, title: unknown, year: unknown): ComparisonRow {
  return mapComparisonRow(makePaperRow(paperId(n), { title, year }), OWNER_ID);
}

const order = (rows: readonly ComparisonRow[]) => rows.map((r) => Number(r.paperId.slice(-12)));

/** Deterministic permutations, so the test needs no randomness. */
function permutations<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let shift = 0; shift < items.length; shift += 1) {
    const rotated = [...items.slice(shift), ...items.slice(0, shift)];
    out.push(rotated, [...rotated].reverse());
  }
  return out;
}

describe("sortComparisonRows", () => {
  const rows = [
    row(1, "Synthetic B", 2019),
    row(2, "Synthetic A", 2021),
    row(3, "Synthetic C", null),
    row(4, "Synthetic D", 2020),
    row(5, "Synthetic E", "2022"), // unreadable year
  ];

  it("defaults to year, newest first, with missing and unreadable years last", () => {
    expect(DEFAULT_COMPARISON_SORT).toBe("year_desc");
    expect(order(sortComparisonRows(rows))).toEqual([2, 4, 1, 3, 5]);
  });

  it("sorts by year, oldest first, still with missing and unreadable years last", () => {
    expect(order(sortComparisonRows(rows, "year_asc"))).toEqual([1, 4, 2, 3, 5]);
  });

  it("sorts titles A to Z, ignoring case and comparing numbers numerically", () => {
    const titled = [row(1, "synthetic trial 10", 2020), row(2, "Synthetic trial 2", 2020), row(3, "Another synthetic", 2020)];
    expect(order(sortComparisonRows(titled, "title_asc"))).toEqual([3, 2, 1]);
  });

  it("puts a blank or unreadable title last in title order", () => {
    const titled = [row(1, "   ", 2020), row(2, "Synthetic Z", 2020), row(3, 42, 2020), row(4, "Synthetic A", 2020)];
    expect(order(sortComparisonRows(titled, "title_asc"))).toEqual([4, 2, 1, 3]);
  });

  it("breaks year ties by title, then title ties by year, then by paper id", () => {
    const tied = [row(4, "Synthetic same", 2020), row(3, "synthetic SAME", 2020), row(2, "Synthetic other", 2020), row(1, "Synthetic same", 2021)];
    expect(order(sortComparisonRows(tied, "year_desc"))).toEqual([1, 2, 3, 4]);
    expect(order(sortComparisonRows(tied, "title_asc"))).toEqual([2, 1, 3, 4]);
  });

  it.each(COMPARISON_SORTS)("produces one order for %s regardless of input order", (sort) => {
    const expected = order(sortComparisonRows(rows, sort));
    for (const permutation of permutations(rows)) {
      expect(order(sortComparisonRows(permutation, sort))).toEqual(expected);
    }
  });

  it("returns a new frozen array and leaves the input untouched", () => {
    const input = [...rows];
    const sorted = sortComparisonRows(input, "title_asc");
    expect(sorted).not.toBe(input);
    expect(Object.isFrozen(sorted)).toBe(true);
    expect(order(input)).toEqual([1, 2, 3, 4, 5]);
  });
});
