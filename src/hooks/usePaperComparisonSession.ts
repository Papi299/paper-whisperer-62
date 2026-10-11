import { useCallback, useEffect, useState } from "react";
import { buildComparisonRequest, normalizeComparisonUuid } from "@/lib/paperComparison/request";
import type { ComparisonRequest, ComparisonRequestOutcome } from "@/lib/paperComparison/types";

export interface PaperComparisonSession {
  /**
   * The open comparison's frozen request, or `null` when none is open. It is
   * `null` in the same render in which the signed-in user stops being the
   * request's owner, so a comparison never outlives the session it belongs to.
   */
  request: ComparisonRequest | null;
  /**
   * Freeze `selectedIds` into a new request and open it. A refused selection
   * (no user, fewer than 2 or more than 10 papers) opens nothing; the outcome
   * says why.
   */
  open: (selectedIds: Iterable<string>) => ComparisonRequestOutcome;
  /** Close the comparison. Its data goes with it (the read's `gcTime` is 0). */
  close: () => void;
}

/**
 * Which comparison is open, if any (EVIDENCE-MATRIX-001B).
 *
 * UI state only: it reads nothing and writes nothing. The read itself is
 * `usePaperComparison`, keyed by the request this hook holds.
 *
 * - The request is built only when the user asks to compare, from the ids
 *   selected at that moment, and is frozen: later selection, filter or sort
 *   changes never reach an open comparison.
 * - Every `open` is a new session, so reopening reads fresh data.
 * - The selection itself is never touched.
 * - Nothing is kept in browser storage or the URL.
 */
export function usePaperComparisonSession(currentUserId: string | null | undefined): PaperComparisonSession {
  const [request, setRequest] = useState<ComparisonRequest | null>(null);

  const owner = normalizeComparisonUuid(currentUserId);
  const active = request !== null && request.ownerUserId === owner ? request : null;

  // The owner check above already hides a request the moment the user
  // changes. This only drops the stale state, so the comparison stays closed
  // if the original user signs back in.
  useEffect(() => {
    if (request !== null && active === null) setRequest(null);
  }, [request, active]);

  const open = useCallback(
    (selectedIds: Iterable<string>) => {
      const outcome = buildComparisonRequest({ ownerUserId: currentUserId, selectedIds });
      if (outcome.ok) setRequest(outcome.request);
      return outcome;
    },
    [currentUserId],
  );

  const close = useCallback(() => setRequest(null), []);

  return { request: active, open, close };
}
