import { MAX_COMPARISON_PAPERS, MIN_COMPARISON_PAPERS } from "./constants";
import type { ComparisonRequest, ComparisonRequestOutcome } from "./types";

/**
 * The canonical textual UUID form only: 8-4-4-4-12 hex digits, no braces, no
 * URN prefix, no surrounding whitespace once trimmed. Postgres accepts more
 * spellings than this; the request deliberately does not, so an unusual one
 * is never sent to the database at all.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Trimmed and lowercased — the form ids are compared and deduplicated in. */
function normalizeId(value: string): string {
  return String(value).trim().toLowerCase();
}

/** The canonical lowercase UUID, or `null` when `value` is not one. */
export function normalizeComparisonUuid(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeId(value);
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

let lastSessionId = 0;

/**
 * Freeze a selection into a comparison request, or refuse it.
 *
 * - No request without a well-formed owner id (`no_user`).
 * - Ids are normalized and deduplicated *before* the size is judged, so the
 *   same paper selected twice, or in two letter cases, counts once.
 * - Fewer than 2 distinct ids is `too_few`; more than 10 is `too_many`. A
 *   large selection is refused outright, never truncated.
 * - Malformed ids still count as selected — they are part of what the user
 *   chose — but are never queried; they surface later as unavailable.
 * - Ids are sorted, so the same selection always produces the same query and
 *   the same cache key.
 * - Every successful call gets a new `sessionId`: opening Compare twice on the
 *   same selection is two sessions, and the second never reuses the first's
 *   data.
 * - The result is deeply frozen and copied from `selectedIds`, so later
 *   changes to the live selection cannot reach it.
 */
export function buildComparisonRequest(input: {
  ownerUserId: string | null | undefined;
  selectedIds: Iterable<string>;
}): ComparisonRequestOutcome {
  const ownerUserId = normalizeComparisonUuid(input.ownerUserId);
  if (!ownerUserId) return { ok: false, reason: "no_user", selectedCount: 0 };

  const distinct = new Set<string>();
  for (const id of input.selectedIds) distinct.add(normalizeId(id));
  const selectedCount = distinct.size;

  if (selectedCount < MIN_COMPARISON_PAPERS) return { ok: false, reason: "too_few", selectedCount };
  if (selectedCount > MAX_COMPARISON_PAPERS) return { ok: false, reason: "too_many", selectedCount };

  const selectedIds = [...distinct].sort();
  const queryIds = selectedIds.filter((id) => UUID_PATTERN.test(id));

  lastSessionId += 1;
  const request: ComparisonRequest = Object.freeze({
    ownerUserId,
    sessionId: lastSessionId,
    selectedIds: Object.freeze(selectedIds),
    queryIds: Object.freeze(queryIds),
  });
  return { ok: true, request };
}
