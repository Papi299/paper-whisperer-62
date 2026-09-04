import { useEffect, useRef } from "react";
import { drainAttachmentCleanupQueue } from "@/lib/attachmentCleanup";

/**
 * One bounded attempt to finish attachment cleanup that an earlier session left
 * pending.
 *
 * ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001. The common path already cleans up
 * immediately after the user's action; this hook exists for the uncommon one,
 * where Storage was unreachable at that moment and the durable queue kept the
 * intent. It is the *only* automatic retry in the product, and deliberately so:
 *
 *  * it runs at most once per signed-in user per mount, never on a timer;
 *  * it never blocks rendering — the drain is started and not awaited;
 *  * it raises no toast, however many historical jobs it finds. This is
 *    housekeeping the user did not ask for and cannot act on, and a startup
 *    toast about a file they deleted last week would be noise, not information.
 *    Failures during a user's *own* action are surfaced by that action;
 *  * it never retries within a session. If Storage is down, one refused pass is
 *    the whole cost, and the queue row simply waits for the next visit.
 *
 * Mount it in exactly ONE authenticated application location. Two mounts would
 * race for the same rows — harmlessly, since removal and acknowledgement are
 * both idempotent, but pointlessly.
 */
export function useAttachmentCleanupRecovery(userId: string | null | undefined): void {
  // Which user this mount has already swept. A ref, not state: changing it must
  // not re-render, and it must survive the effect re-running for an unrelated
  // reason. Keyed by user id so a sign-out/sign-in as somebody else still gets
  // its own single pass.
  const sweptFor = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    if (sweptFor.current === userId) return;
    sweptFor.current = userId;

    // Fire and forget. `drainAttachmentCleanupQueue` never throws — it reports
    // every failure through its result — so there is nothing here to catch and
    // nothing a rejected promise could surface.
    void drainAttachmentCleanupQueue(userId);
  }, [userId]);
}
