import { MIN_COMPARISON_PAPERS } from "./constants";
import { ComparisonIntegrityError } from "./errors";
import { mapComparisonRow } from "./mapRow";
import { DEFAULT_COMPARISON_SORT, sortComparisonRows } from "./sort";
import type { ComparisonRequest, ComparisonResult, ComparisonRow } from "./types";

/**
 * Turn the read's response into a comparison result for `request`.
 *
 * The response as a whole is either trusted or rejected. It is rejected —
 * `ComparisonIntegrityError`, nothing shown — when it is not an array of
 * rows, or holds a row the request did not ask for, the same paper twice, or
 * a row or nested record owned by someone else (see `mapComparisonRow`).
 *
 * A requested paper that produced no row is NOT an error: it is unavailable,
 * and the result says how many without saying why (deleted, nonexistent, not
 * the user's, or never queried because its id was malformed).
 *
 * Fewer than `MIN_COMPARISON_PAPERS` available rows is `insufficient`, which
 * carries no rows at all, so a "comparison" of one paper cannot be rendered.
 * Otherwise rows come back in the default sort order, which depends only on
 * the rows' values and ids — never on the order the database returned them.
 */
export function buildComparisonResult(request: ComparisonRequest, data: unknown): ComparisonResult {
  if (!Array.isArray(data)) throw new ComparisonIntegrityError("malformed_response");

  const requested = new Set(request.queryIds);
  const returned = new Set<string>();
  const rows: ComparisonRow[] = [];

  for (const raw of data) {
    const id = typeof raw === "object" && raw !== null ? (raw as { id?: unknown }).id : undefined;
    if (typeof id !== "string") throw new ComparisonIntegrityError("malformed_response");
    if (!requested.has(id)) throw new ComparisonIntegrityError("unrequested_paper");
    if (returned.has(id)) throw new ComparisonIntegrityError("duplicate_paper");
    returned.add(id);
    rows.push(mapComparisonRow(raw, request.ownerUserId));
  }

  const unavailablePaperIds = Object.freeze(request.selectedIds.filter((id) => !returned.has(id)));
  const selectedCount = request.selectedIds.length;
  const unavailableCount = unavailablePaperIds.length;

  if (rows.length < MIN_COMPARISON_PAPERS) {
    return Object.freeze({
      kind: "insufficient",
      selectedCount,
      availableCount: rows.length,
      unavailableCount,
      unavailablePaperIds,
    });
  }

  return Object.freeze({
    kind: "comparable",
    rows: sortComparisonRows(rows, DEFAULT_COMPARISON_SORT),
    selectedCount,
    unavailableCount,
    unavailablePaperIds,
  });
}
