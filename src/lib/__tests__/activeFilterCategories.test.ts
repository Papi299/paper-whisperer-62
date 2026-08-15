import { describe, expect, it } from "vitest";
import {
  FILTER_CATEGORY_IDS,
  activeFilterCategories,
  countActiveFilterCategories,
  describeFiltersTrigger,
  type FilterCategoryState,
} from "@/lib/activeFilterCategories";

/**
 * The badge on the mobile Filters trigger counts filter *categories*, not
 * selected values. These pin the distinction that makes the badge meaningful:
 * a From/To year pair is one constraint, and five selected projects are still
 * one Project filter.
 */

const NONE: FilterCategoryState = {
  yearFrom: "",
  yearTo: "",
  studyType: "all",
  notesPresence: "all",
  selectedKeywords: [],
  selectedProjectIds: [],
  selectedTagIds: [],
};

const state = (over: Partial<FilterCategoryState> = {}): FilterCategoryState => ({
  ...NONE,
  ...over,
});

describe("activeFilterCategories", () => {
  it("counts nothing when the library is unfiltered", () => {
    expect(activeFilterCategories(NONE)).toEqual([]);
    expect(countActiveFilterCategories(NONE)).toBe(0);
  });

  it("treats From and To as a single Year category", () => {
    expect(countActiveFilterCategories(state({ yearFrom: "2015" }))).toBe(1);
    expect(countActiveFilterCategories(state({ yearTo: "2020" }))).toBe(1);
    // The regression this pins: two inputs must not read as two filters.
    expect(countActiveFilterCategories(state({ yearFrom: "2015", yearTo: "2020" }))).toBe(1);
    expect(activeFilterCategories(state({ yearFrom: "2015", yearTo: "2020" }))).toEqual(["year"]);
  });

  it("counts multi-select categories once regardless of how many values", () => {
    expect(countActiveFilterCategories(state({ selectedProjectIds: ["a"] }))).toBe(1);
    expect(countActiveFilterCategories(state({ selectedProjectIds: ["a", "b", "c"] }))).toBe(1);
    expect(countActiveFilterCategories(state({ selectedTagIds: ["t1", "t2"] }))).toBe(1);
    expect(countActiveFilterCategories(state({ selectedKeywords: ["k1", "k2", "k3"] }))).toBe(1);
  });

  it("treats the 'all' sentinel as inactive for study type and notes", () => {
    expect(countActiveFilterCategories(state({ studyType: "all" }))).toBe(0);
    expect(countActiveFilterCategories(state({ notesPresence: "all" }))).toBe(0);
    expect(countActiveFilterCategories(state({ studyType: "RCT" }))).toBe(1);
    expect(countActiveFilterCategories(state({ notesPresence: "has" }))).toBe(1);
    expect(countActiveFilterCategories(state({ notesPresence: "none" }))).toBe(1);
  });

  it("never counts the search query, which stays permanently visible", () => {
    // `searchQuery` is deliberately absent from the state shape: the sheet does
    // not contain the search field, so badging it would be a lie.
    expect(Object.keys(NONE)).not.toContain("searchQuery");
    expect(countActiveFilterCategories(NONE)).toBe(0);
  });

  it("sums independent categories and never exceeds the declared set", () => {
    const everything = state({
      yearFrom: "2000",
      yearTo: "2024",
      studyType: "RCT",
      notesPresence: "has",
      selectedKeywords: ["k"],
      selectedProjectIds: ["p"],
      selectedTagIds: ["t"],
    });
    expect(countActiveFilterCategories(everything)).toBe(FILTER_CATEGORY_IDS.length);
    expect(new Set(activeFilterCategories(everything))).toEqual(new Set(FILTER_CATEGORY_IDS));
  });

  it("returns categories in a stable order", () => {
    const a = activeFilterCategories(
      state({ selectedTagIds: ["t"], yearFrom: "1999", studyType: "RCT" }),
    );
    expect(a).toEqual(["year", "studyType", "tags"]);
  });
});

describe("describeFiltersTrigger", () => {
  it("says just 'Filters' when nothing is active", () => {
    expect(describeFiltersTrigger(0)).toBe("Filters");
    expect(describeFiltersTrigger(-1)).toBe("Filters");
  });

  it("spells the state out so the numeric badge is not its only carrier", () => {
    expect(describeFiltersTrigger(1)).toBe("Filters, 1 active filter category");
    expect(describeFiltersTrigger(3)).toBe("Filters, 3 active filter categories");
  });

  it("always begins with the visible label", () => {
    for (const n of [0, 1, 2, 6]) {
      expect(describeFiltersTrigger(n).startsWith("Filters")).toBe(true);
    }
  });
});
