import { transportUncertainError, type EvidenceError } from "@/lib/evidence/errors";
import type { CreateStudyResult, LifecycleOutcome } from "@/lib/evidence/lifecycleClient";
import type { CreateStudyRequest } from "@/lib/evidence/lifecycleRequests";

/**
 * Creates whose outcome is not known yet (EVIDENCE-RECORDS-001C1-REVIEW-FIX-001,
 * finding C1-R1).
 *
 * A create can reach the server, commit, and lose its answer on the way back.
 * Its request id is then the only thing that can find out what happened: the
 * server replays the original answer to the same id and arguments
 * (docs/evidence-records-lifecycle.md §5). A new id would create a second
 * study. So an attempt is kept here, with its exact prepared request — user,
 * paper, arguments and id — from the moment it is sent until its outcome is
 * known, outliving the dialog that started it:
 *
 *   * `start` sends a new attempt. While another attempt for the same user and
 *     paper is unresolved it sends nothing and returns null: that paper's next
 *     create can only be a `retry`.
 *   * `retry` resends the stored request object itself — never a rebuilt one,
 *     never a new id. While an attempt is on its way it returns that attempt
 *     and sends nothing.
 *   * An attempt is retired when its outcome is known: created (applied or
 *     replayed), or refused with nothing applied. Only an answer that leaves
 *     it unknown (`applied: "unknown"` — a lost or unreadable response) keeps
 *     it, as `unresolved`, until the user retries. Nothing retries on its own.
 *
 * Memory only: no browser storage, no URL, no database. The owner — the Study
 * Record dialog, mounted once by the Dashboard — keeps one store for the
 * signed-in user and forgets every other user's attempts the moment the
 * account changes. A reload forgets everything; the dialog then reads the
 * paper's studies afresh before it offers a creation.
 */

export type CreateSender = (request: CreateStudyRequest) => PromiseLike<LifecycleOutcome<CreateStudyResult>>;

export type CreateAttempt =
  | { readonly kind: "created"; readonly result: CreateStudyResult }
  /** Refused with nothing applied. `request` may be resent while the answers stay the same. */
  | { readonly kind: "failed"; readonly error: EvidenceError; readonly request: CreateStudyRequest }
  /** Still unknown: the attempt stays, and only a retry of the same request can settle it. */
  | { readonly kind: "unresolved"; readonly error: EvidenceError };

export interface PendingCreate {
  readonly userId: string;
  /** Lower-case, as the request carries it. */
  readonly paperId: string;
  /** The exact prepared request every retry resends. */
  readonly request: CreateStudyRequest;
  readonly status: "sending" | "unresolved";
  /** Why the last attempt's outcome is unknown; null before any answer. */
  readonly error: EvidenceError | null;
  /** How many times the request has been sent. */
  readonly attempts: number;
  /** While sending: the outcome of that attempt. */
  readonly inflight: Promise<CreateAttempt> | null;
}

export interface PendingCreateStore {
  get(userId: string, paperId: string): PendingCreate | null;
  subscribe(listener: () => void): () => void;
  start(userId: string, request: CreateStudyRequest): Promise<CreateAttempt> | null;
  retry(userId: string, paperId: string): Promise<CreateAttempt> | null;
  /** Forget every attempt that is not `userId`'s (all of them for null). */
  forgetOtherUsers(userId: string | null): void;
  clear(): void;
}

export interface PendingCreateStoreOptions {
  readonly send: CreateSender;
  /** After every answer, retired or not: the server may hold a new study. */
  readonly onSettled?: (userId: string, attempt: CreateAttempt) => void;
}

const keyOf = (userId: string, paperId: string) => `${userId.toLowerCase()} ${paperId.toLowerCase()}`;

function toAttempt(outcome: LifecycleOutcome<CreateStudyResult>, request: CreateStudyRequest): CreateAttempt {
  if (outcome.ok) return { kind: "created", result: outcome.result };
  if (outcome.error.applied === "unknown") return { kind: "unresolved", error: outcome.error };
  return { kind: "failed", error: outcome.error, request };
}

export function createPendingCreateStore({ send, onSettled }: PendingCreateStoreOptions): PendingCreateStore {
  const entries = new Map<string, PendingCreate>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  function attempt(userId: string, request: CreateStudyRequest, previous: PendingCreate | null): Promise<CreateAttempt> {
    const key = keyOf(userId, request.args.p_paper_id);
    let settle!: (attempt: CreateAttempt) => void;
    const inflight = new Promise<CreateAttempt>((resolve) => (settle = resolve));
    const entry: PendingCreate = Object.freeze({
      userId,
      paperId: request.args.p_paper_id.toLowerCase(),
      request,
      status: "sending",
      error: previous?.error ?? null,
      attempts: (previous?.attempts ?? 0) + 1,
      inflight,
    });
    entries.set(key, entry);
    notify();
    void Promise.resolve()
      .then(() => send(request))
      .then(
        (outcome) => toAttempt(outcome, request),
        // The client reports every failure as an outcome; anything thrown is unknown too.
        (): CreateAttempt => ({ kind: "unresolved", error: transportUncertainError() }),
      )
      .then((result) => {
        // Settle first, so whoever awaits this attempt hears it before the store moves on.
        settle(result);
        // Cleared or replaced meanwhile (an account change): leave the store as it is.
        if (entries.get(key) === entry) {
          if (result.kind === "unresolved") entries.set(key, Object.freeze({ ...entry, status: "unresolved", error: result.error, inflight: null }));
          else entries.delete(key);
          notify();
        }
        onSettled?.(userId, result);
      });
    return inflight;
  }

  return Object.freeze({
    get(userId: string, paperId: string) {
      const entry = entries.get(keyOf(userId, paperId));
      return entry && entry.userId === userId ? entry : null;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start(userId: string, request: CreateStudyRequest) {
      const existing = entries.get(keyOf(userId, request.args.p_paper_id)) ?? null;
      if (existing) {
        // The same action again (a double click): the same attempt, nothing new sent.
        if (existing.request.requestId === request.requestId) return existing.inflight ?? attempt(userId, existing.request, existing);
        return null;
      }
      return attempt(userId, request, null);
    },
    retry(userId: string, paperId: string) {
      const existing = entries.get(keyOf(userId, paperId)) ?? null;
      if (!existing || existing.userId !== userId) return null;
      return existing.inflight ?? attempt(userId, existing.request, existing);
    },
    forgetOtherUsers(userId: string | null) {
      let changed = false;
      for (const [key, entry] of entries) {
        if (entry.userId !== userId) {
          entries.delete(key);
          changed = true;
        }
      }
      if (changed) notify();
    },
    clear() {
      if (entries.size === 0) return;
      entries.clear();
      notify();
    },
  });
}
