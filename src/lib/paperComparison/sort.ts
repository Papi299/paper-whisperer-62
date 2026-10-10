import type { ComparisonRow } from "./types";

export type ComparisonSort = "year_desc" | "year_asc" | "title_asc";

export const COMPARISON_SORTS: readonly ComparisonSort[] = Object.freeze(["year_desc", "year_asc", "title_asc"]);

export const DEFAULT_COMPARISON_SORT: ComparisonSort = "year_desc";

/**
 * Title order in a fixed locale, so it does not vary with the browser's: base
 * letters only (case and accents tie, then fall through to the next key) and
 * numeric runs compared as numbers, so "Trial 2" sorts before "Trial 10".
 */
const titleCollator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

type Comparator = (a: ComparisonRow, b: ComparisonRow) => number;

function yearOf(row: ComparisonRow): number | null {
  return row.year.value.kind === "present" ? row.year.value.value : null;
}

function titleOf(row: ComparisonRow): string | null {
  return row.title.value.kind === "present" ? row.title.value.value.trim() : null;
}

/** Missing or unreadable values sort last whatever the direction. */
function compareMissingLast<T>(a: T | null, b: T | null, compare: (x: T, y: T) => number): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return compare(a, b);
}

const byYearDesc: Comparator = (a, b) => compareMissingLast(yearOf(a), yearOf(b), (x, y) => y - x);
const byYearAsc: Comparator = (a, b) => compareMissingLast(yearOf(a), yearOf(b), (x, y) => x - y);
const byTitle: Comparator = (a, b) => compareMissingLast(titleOf(a), titleOf(b), titleCollator.compare);
/** The final tie-breaker: ids are unique, so no two rows ever compare equal. */
const byPaperId: Comparator = (a, b) => (a.paperId < b.paperId ? -1 : a.paperId > b.paperId ? 1 : 0);

const COMPARATORS: Record<ComparisonSort, readonly Comparator[]> = {
  year_desc: [byYearDesc, byTitle, byPaperId],
  year_asc: [byYearAsc, byTitle, byPaperId],
  title_asc: [byTitle, byYearDesc, byPaperId],
};

/**
 * Rows in `sort` order, as a new frozen array (the input is not modified).
 * The order is total — every mode ends on the paper id — so the same rows
 * always come out in the same order, whatever order they went in.
 */
export function sortComparisonRows(
  rows: readonly ComparisonRow[],
  sort: ComparisonSort = DEFAULT_COMPARISON_SORT,
): readonly ComparisonRow[] {
  const comparators = COMPARATORS[sort];
  const sorted = [...rows].sort((a, b) => {
    for (const compare of comparators) {
      const order = compare(a, b);
      if (order !== 0) return order;
    }
    return 0;
  });
  return Object.freeze(sorted);
}
