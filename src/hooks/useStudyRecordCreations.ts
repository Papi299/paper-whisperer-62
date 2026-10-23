import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { studyRecordClient } from "@/lib/studyRecord/client";
import { createPendingCreateStore, type PendingCreate, type PendingCreateStore } from "@/lib/studyRecord/pendingCreates";

/**
 * The creates whose outcome is not known yet (C1-R1; `pendingCreates.ts`), for
 * the Study Record dialog. The dialog calls this once, in its outer component —
 * mounted once by the Dashboard, so the store outlives every opening — and
 * hands the store down to the views that start and retry a create.
 *
 * Isolation: an attempt is found only by the user who made it, and every
 * other user's attempts are forgotten as soon as the signed-in user changes
 * or signs out. A reload forgets them all.
 */
export function useStudyRecordCreationStore(userId: string | null | undefined): PendingCreateStore {
  const queryClient = useQueryClient();
  const [store] = useState(() =>
    createPendingCreateStore({
      send: (request) => studyRecordClient.createStudyFromPaper(request),
      // Whatever the answer, the server may now hold a study the cached lists don't show.
      onSettled: (owner) => void queryClient.invalidateQueries({ queryKey: queryKeys.studyRecords.all(owner) }),
    }),
  );
  const owner = userId ?? null;
  useEffect(() => store.forgetOtherUsers(owner), [store, owner]);
  useEffect(() => () => store.clear(), [store]);
  return store;
}

/** The unresolved create of `paperId` by `userId`, if any. */
export function usePendingStudyCreate(store: PendingCreateStore, userId: string | null | undefined, paperId: string | null | undefined): PendingCreate | null {
  return useSyncExternalStore(store.subscribe, () => (userId && paperId ? store.get(userId, paperId) : null));
}
