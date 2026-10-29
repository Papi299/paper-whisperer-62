import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUserAccess } from "@/hooks/useCurrentUserAccess";
import { toStudyId } from "@/lib/evidence/ids";
import { queryKeys } from "@/lib/queryKeys";
import { studyRecordWriteAccess, type StudyRecordWriteAccess } from "@/lib/studyRecord/access";
import { fetchPaperStudies, fetchPaperStudyLinks, fetchPaperTitles, type PaperStudySummary } from "@/lib/studyRecord/paperLinks";
import { fetchStudyRecord, StudyRecordReadError, type StudyRecordData } from "@/lib/studyRecord/read";

/**
 * Study-record reads (EVIDENCE-RECORDS-001C1). Owner-scoped SELECTs only —
 * see `src/lib/studyRecord/read.ts` and `paperLinks.ts`. Every key is
 * user-scoped and nothing is read until a surface asks for it: the studies of
 * one paper when its details are expanded or Edit Paper is open, one record
 * when the Study Record dialog shows it, and the links of a selection when a
 * delete or a merge is about to happen.
 */

/** One automatic retry, only for a failure that could be transient. Shared with the History reads. */
export function retryTransient(failureCount: number, error: Error): boolean {
  return error instanceof StudyRecordReadError && error.transient && failureCount < 1;
}

/** What the signed-in user may be offered: create and edit only for exactly `owner`. */
export function useStudyRecordWriteAccess(userId: string | null | undefined): StudyRecordWriteAccess {
  return studyRecordWriteAccess(useCurrentUserAccess(userId));
}

/**
 * The studies `paperId` reports, while `enabled`. With `freshOnMount`, every
 * mount reads the server again however recent the cached list is — what the
 * Study Record dialog needs before it offers to create a record (C1-R1): a
 * cached "none" may predate a create that committed.
 */
export function usePaperStudyRecords(
  userId: string | null | undefined,
  paperId: string | null | undefined,
  enabled: boolean,
  { freshOnMount = false }: { readonly freshOnMount?: boolean } = {},
) {
  return useQuery<readonly PaperStudySummary[], Error>({
    queryKey: queryKeys.studyRecords.paper(userId ?? "anonymous", paperId ?? "none"),
    queryFn: ({ signal }) => fetchPaperStudies(supabase, userId!, paperId!, signal),
    enabled: enabled && !!userId && !!paperId,
    staleTime: 30_000,
    refetchOnMount: freshOnMount ? "always" : true,
    retry: retryTransient,
  });
}

/**
 * One study record. Never refetched in the background — not on focus, not on
 * reconnect, not by an invalidation (`staleTime: "static"`): the editor's
 * draft is checked against the version it was built on, so the record under it
 * changes only when the editor asks (`refetch`, after its own writes or an
 * explicit Reload). Nor is it kept once the editor closes (`gcTime: 0`), so
 * every opening reads the record as it is now. Resolves to null when the
 * study no longer exists.
 */
export function useStudyRecordData(userId: string | null | undefined, studyId: string | null | undefined) {
  const id = toStudyId(studyId);
  return useQuery<StudyRecordData | null, Error>({
    queryKey: queryKeys.studyRecords.study(userId ?? "anonymous", id ?? "none"),
    queryFn: ({ signal }) => fetchStudyRecord(supabase, userId!, id!, signal),
    enabled: !!userId && !!id,
    staleTime: "static",
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: retryTransient,
  });
}

export interface HeldPaper {
  readonly paperId: string;
  /** Null when the title could not be read (the paper is still named by count). */
  readonly title: string | null;
}

export type PaperLinkCheck =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "clear" }
  | { readonly status: "held"; readonly held: readonly HeldPaper[] }
  | { readonly status: "error" };

/**
 * Whether any of `paperIds` has a study record — checked fresh every time a
 * delete or merge is about to be offered (no cache reuse: `staleTime` and
 * `gcTime` are 0), with the titles of the held papers. Advisory: the database
 * key refuses a link made after the check.
 */
export function usePaperLinkCheck(
  userId: string | null | undefined,
  paperIds: readonly string[],
  enabled: boolean,
  knownTitles?: ReadonlyMap<string, string>,
): { readonly check: PaperLinkCheck; readonly retry: () => void } {
  const ids = [...new Set(paperIds.map((id) => id.toLowerCase()))].sort();
  const query = useQuery<readonly HeldPaper[], Error>({
    queryKey: queryKeys.studyRecords.paperLinks(userId ?? "anonymous", ids),
    queryFn: async ({ signal }) => {
      const { studiesByPaper } = await fetchPaperStudyLinks(supabase, userId!, ids, signal);
      const held = [...studiesByPaper.keys()];
      const missing = held.filter((id) => !knownTitles?.has(id));
      const fetched = missing.length > 0 ? await fetchPaperTitles(supabase, userId!, missing, signal).catch(() => new Map<string, string>()) : new Map<string, string>();
      return held.map((paperId) => ({ paperId, title: knownTitles?.get(paperId) ?? fetched.get(paperId) ?? null }));
    },
    enabled: enabled && !!userId && ids.length > 0,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  let check: PaperLinkCheck;
  if (!enabled || !userId || ids.length === 0) check = { status: "idle" };
  else if (query.isFetching || query.isPending) check = { status: "checking" };
  else if (query.isError) check = { status: "error" };
  else if (query.data && query.data.length > 0) check = { status: "held", held: query.data };
  else check = { status: "clear" };
  return { check, retry: () => void query.refetch() };
}
