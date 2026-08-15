import type { NotesPresence } from "@/hooks/papers/types";

/**
 * Active-filter *category* accounting for the mobile Filters trigger badge.
 *
 * The badge answers "how many kinds of filtering are hiding inside that sheet",
 * not "how many values are selected" — two selected projects are still one
 * Project filter, and a From/To pair is still one Year filter. Counting values
 * would make the badge read `5` for a single conceptual constraint.
 *
 * `searchQuery` is deliberately excluded: the search field stays permanently
 * visible on mobile, so its state is already on screen and counting it would
 * badge the Filters button for something the sheet does not contain.
 *
 * This is intentionally separate from `useFilterState.hasActiveFilters` (which
 * DOES include search and is used to switch the header count to "N of M" and to
 * show the Clear action). Both remain true at the same time; they answer
 * different questions.
 */

export const FILTER_CATEGORY_IDS = [
  "year",
  "studyType",
  "notes",
  "projects",
  "tags",
  "keywords",
] as const;

export type FilterCategoryId = (typeof FILTER_CATEGORY_IDS)[number];

export interface FilterCategoryState {
  yearFrom: string;
  yearTo: string;
  studyType: string;
  notesPresence: NotesPresence;
  selectedKeywords: string[];
  selectedProjectIds: string[];
  selectedTagIds: string[];
}

/** Which filter categories currently constrain the library, in stable order. */
export function activeFilterCategories(state: FilterCategoryState): FilterCategoryId[] {
  const active: FilterCategoryId[] = [];
  // From and To are two inputs but one conceptual constraint.
  if (state.yearFrom !== "" || state.yearTo !== "") active.push("year");
  if (state.studyType !== "all") active.push("studyType");
  if (state.notesPresence !== "all") active.push("notes");
  if (state.selectedProjectIds.length > 0) active.push("projects");
  if (state.selectedTagIds.length > 0) active.push("tags");
  if (state.selectedKeywords.length > 0) active.push("keywords");
  return active;
}

/** How many filter categories are active. Drives the Filters badge. */
export function countActiveFilterCategories(state: FilterCategoryState): number {
  return activeFilterCategories(state).length;
}

/**
 * Accessible name for the mobile Filters trigger.
 *
 * The visible badge is a bare number, which conveys nothing on its own to a
 * screen reader, so the state is spelled out here. The name keeps "Filters" as
 * its first word so it still matches the visible label.
 */
export function describeFiltersTrigger(activeCount: number): string {
  if (activeCount <= 0) return "Filters";
  if (activeCount === 1) return "Filters, 1 active filter category";
  return `Filters, ${activeCount} active filter categories`;
}
