import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";
import { COMPARISON_RETRY_DELAY_MS } from "@/lib/paperComparison/constants";
import { ComparisonIntegrityError, ComparisonTransportError } from "@/lib/paperComparison/errors";
import { buildComparisonQuery } from "@/lib/paperComparison/query";
import { normalizeComparisonUuid } from "@/lib/paperComparison/request";
import { buildComparisonResult } from "@/lib/paperComparison/result";
import type { ComparisonRequest, ComparisonResult } from "@/lib/paperComparison/types";

export type PaperComparisonStatus = "idle" | "loading" | "ready" | "error";

export interface UsePaperComparisonResult {
  /**
   * - `idle` — no request, or the signed-in user is not the request's owner.
   * - `loading` — the read (or its single retry) is in flight.
   * - `ready` — `result` holds a comparable or insufficient result.
   * - `error` — the read failed; nothing from it is available.
   */
  status: PaperComparisonStatus;
  result: ComparisonResult | null;
  /** Set only in `error`. `integrity` failures are never retried automatically. */
  errorKind: "transport" | "integrity" | null;
  /**
   * Re-run the same frozen request — the error state's "Try again". It does
   * nothing in any other state, so a loaded comparison is never re-read.
   */
  retry: () => void;
}

async function fetchComparison(request: ComparisonRequest, signal: AbortSignal): Promise<ComparisonResult> {
  const { data, error, status } = await buildComparisonQuery(supabase, request, signal);
  if (error) throw new ComparisonTransportError(status);
  return buildComparisonResult(request, data);
}

/** One automatic retry, and only for a transient transport failure. */
function shouldRetry(failureCount: number, error: Error): boolean {
  return error instanceof ComparisonTransportError && error.transient && failureCount < 1;
}

/**
 * Read-only comparison of the papers in a frozen `ComparisonRequest`
 * (EVIDENCE-MATRIX-001A). There is no UI caller yet.
 *
 * - **One query per session.** A single `papers` SELECT with the projects,
 *   tags and attachment metadata embedded (`buildComparisonQuery`), repeated
 *   only by the one automatic retry of a transient failure or by `retry` after
 *   an error; no RPC, Edge Function, Storage call, provider call or write.
 * - **Owner-bound.** Nothing is fetched or returned unless `currentUserId` is
 *   the request's owner, so a session switch can never surface another user's
 *   comparison — not even one still in the cache. The key carries the owner.
 * - **A stable snapshot.** `staleTime: "static"` exempts the query from every
 *   `invalidateQueries`/`refetchQueries` (even an unfiltered one), and window
 *   focus and reconnect never refetch it, so a loaded comparison never changes
 *   under the reader.
 * - **Fresh on every open, gone on close.** Each request carries its own
 *   `sessionId`, so reopening is a new key and a new read; `gcTime: 0` drops a
 *   session's data as soon as nothing observes it. Unmounting while the read
 *   is in flight aborts it (the signal is passed to the request).
 * - **No dependency on the library list.** The request's ids are read
 *   directly, so papers on unloaded pages or hidden by filters are included,
 *   and nothing is taken from the list cache.
 * - A request with no well-formed ids is answered without a read: it is
 *   `insufficient` by construction.
 */
export function usePaperComparison(
  request: ComparisonRequest | null,
  currentUserId: string | null | undefined,
): UsePaperComparisonResult {
  const ownerMatches = request !== null && normalizeComparisonUuid(currentUserId) === request.ownerUserId;
  const needsRead = ownerMatches && request.queryIds.length > 0;

  const query = useQuery<ComparisonResult, Error>({
    queryKey: request
      ? queryKeys.paperComparison.session(request.ownerUserId, request.sessionId, request.queryIds)
      : queryKeys.paperComparison.inactive(),
    queryFn: ({ signal }) => fetchComparison(request!, signal),
    enabled: needsRead,
    staleTime: "static",
    gcTime: 0,
    retry: shouldRetry,
    retryDelay: COMPARISON_RETRY_DELAY_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const emptyResult = useMemo(
    () => (request && request.queryIds.length === 0 ? buildComparisonResult(request, []) : null),
    [request],
  );

  const { refetch } = query;
  const canRetry = needsRead && query.isError && !query.isFetching;
  const retry = useCallback(() => {
    if (canRetry) void refetch();
  }, [canRetry, refetch]);

  if (!ownerMatches) return { status: "idle", result: null, errorKind: null, retry };
  if (emptyResult) return { status: "ready", result: emptyResult, errorKind: null, retry };
  if (query.data !== undefined) return { status: "ready", result: query.data, errorKind: null, retry };
  if (query.isError && !query.isFetching) {
    const errorKind = query.error instanceof ComparisonIntegrityError ? "integrity" : "transport";
    return { status: "error", result: null, errorKind, retry };
  }
  return { status: "loading", result: null, errorKind: null, retry };
}
