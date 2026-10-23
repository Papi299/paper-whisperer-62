import { describe, expect, it, vi } from "vitest";
import { classifyLifecycleError, malformedResponseError, transportUncertainError } from "@/lib/evidence/errors";
import { toLinkId, toSnapshotId, toStudyId, toStudyVersion } from "@/lib/evidence/ids";
import type { CreateStudyResult, LifecycleOutcome } from "@/lib/evidence/lifecycleClient";
import { prepareCreateStudy, type CreateStudyRequest } from "@/lib/evidence/lifecycleRequests";
import { createPendingCreateStore, type CreateAttempt } from "../pendingCreates";
import { OTHER_USER, PAPER_ID, SECOND_PAPER_ID, USER, uuid } from "./fixtures";

/**
 * The store of creates whose outcome is unknown (C1-R1). Every answer is a
 * controlled promise the test settles, so ordering is exact and nothing
 * depends on timing.
 */

type Outcome = LifecycleOutcome<CreateStudyResult>;

function request(paperId = PAPER_ID, requestId = uuid("7", 1), label = "Doe 2024"): CreateStudyRequest {
  const prepared = prepareCreateStudy({ paperId, label, designProfile: "rct_parallel", linkStatus: "user_confirmed", requestId });
  if (!prepared.ok) throw new Error("fixture request is invalid");
  return prepared.request;
}

const created = (status: "applied" | "replayed" = "applied"): Outcome => ({
  ok: true,
  result: Object.freeze({ status, studyId: toStudyId(uuid("5", 1))!, studyVersion: toStudyVersion(1)!, linkId: toLinkId(uuid("b", 1))!, snapshotId: toSnapshotId(uuid("c", 1)) }),
});
const refused = (error: ReturnType<typeof transportUncertainError>): Outcome => ({ ok: false, error });
const RPC = "evidence_create_study_from_paper";
/** Refusals with nothing applied: the server answered with a SQLSTATE, so the transaction rolled back. */
const notApplied = classifyLifecycleError({ code: "40001", message: "could not serialize access", details: null, hint: null }, 500, RPC);
const notEnabled = classifyLifecycleError({ code: "42501", message: "evidence_records_not_enabled", details: null, hint: null }, 403, RPC);

/** A sender whose every answer the test gives by hand. */
function scriptedSender() {
  const calls: CreateStudyRequest[] = [];
  const answers: ((outcome: Outcome) => void)[] = [];
  const send = vi.fn((sent: CreateStudyRequest) => {
    calls.push(sent);
    return new Promise<Outcome>((resolve) => answers.push(resolve));
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    send,
    calls,
    /** Answer the oldest unanswered call. */
    async answer(outcome: Outcome) {
      await flush();
      const resolve = answers.shift();
      if (!resolve) throw new Error("no call is waiting for an answer");
      resolve(outcome);
      await flush();
    },
    flush,
  };
}

describe("an attempt is kept, exactly, until its outcome is known", () => {
  it("holds the user, the paper and the very request object while it is on its way", async () => {
    const sender = scriptedSender();
    const store = createPendingCreateStore({ send: sender.send });
    const sent = request();
    const attempt = store.start(USER, sent);
    expect(attempt).not.toBeNull();
    const pending = store.get(USER, PAPER_ID)!;
    expect(pending).toMatchObject({ userId: USER, paperId: PAPER_ID, status: "sending", attempts: 1, error: null });
    expect(pending.request).toBe(sent);
    expect(Object.isFrozen(pending)).toBe(true);
    await sender.flush();
    expect(sender.calls).toEqual([sent]);
    expect(sender.calls[0]).toBe(sent);

    await sender.answer(created());
    await expect(attempt!).resolves.toMatchObject({ kind: "created" });
    expect(store.get(USER, PAPER_ID)).toBeNull();
  });

  it("keeps an attempt whose answer was lost, and a retry resends the same request object — never a new id", async () => {
    const sender = scriptedSender();
    const store = createPendingCreateStore({ send: sender.send });
    const sent = request();
    const first = store.start(USER, sent)!;
    await sender.answer(refused(transportUncertainError()));
    await expect(first).resolves.toMatchObject({ kind: "unresolved", error: { kind: "transport_uncertain" } });
    expect(store.get(USER, PAPER_ID)).toMatchObject({ status: "unresolved", attempts: 1, inflight: null, error: { kind: "transport_uncertain" } });

    const second = store.retry(USER, PAPER_ID)!;
    expect(store.get(USER, PAPER_ID)).toMatchObject({ status: "sending", attempts: 2 });
    await sender.answer(refused(malformedResponseError(200)));
    await expect(second).resolves.toMatchObject({ kind: "unresolved", error: { kind: "malformed_response" } });

    const third = store.retry(USER, PAPER_ID)!;
    await sender.answer(created("replayed"));
    await expect(third).resolves.toMatchObject({ kind: "created", result: { status: "replayed" } });
    expect(sender.calls).toHaveLength(3);
    for (const call of sender.calls) expect(call).toBe(sent);
    expect(store.get(USER, PAPER_ID)).toBeNull();
  });

  it("refuses a different request for a paper whose attempt is unresolved, and sends nothing", async () => {
    const sender = scriptedSender();
    const store = createPendingCreateStore({ send: sender.send });
    store.start(USER, request());
    await sender.answer(refused(transportUncertainError()));
    expect(store.start(USER, request(PAPER_ID, uuid("7", 2)))).toBeNull();
    expect(store.start(USER, request(PAPER_ID, uuid("7", 3), "Another name"))).toBeNull();
    await sender.flush();
    expect(sender.calls).toHaveLength(1);
    expect(store.get(USER, PAPER_ID)!.request.requestId).toBe(uuid("7", 1));
  });

  it("sends nothing twice while an attempt is on its way: a retry or the same start returns that attempt", async () => {
    const sender = scriptedSender();
    const store = createPendingCreateStore({ send: sender.send });
    const sent = request();
    const first = store.start(USER, sent)!;
    expect(store.retry(USER, PAPER_ID)).toBe(first);
    expect(store.start(USER, sent)).toBe(first);
    await sender.flush();
    expect(sender.calls).toHaveLength(1);
    await sender.answer(created());
  });

  it("never retries on its own", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => refused(transportUncertainError()));
      const store = createPendingCreateStore({ send });
      await store.start(USER, request());
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(send).toHaveBeenCalledTimes(1);
      expect(store.get(USER, PAPER_ID)).toMatchObject({ status: "unresolved" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires an attempt the server refused with nothing applied, returning the request the same answers may resend", async () => {
    const sender = scriptedSender();
    const store = createPendingCreateStore({ send: sender.send });
    const sent = request();
    const busy = store.start(USER, sent)!;
    await sender.answer(refused(notApplied));
    await expect(busy).resolves.toEqual({ kind: "failed", error: notApplied, request: sent });
    expect(store.get(USER, PAPER_ID)).toBeNull();

    const blocked = store.start(USER, request(PAPER_ID, uuid("7", 2)))!;
    await sender.answer(refused(notEnabled));
    await expect(blocked).resolves.toMatchObject({ kind: "failed", error: { kind: "records_not_enabled" } });
    expect(store.get(USER, PAPER_ID)).toBeNull();
  });

  it("treats a sender that throws as an unknown outcome, and keeps the attempt", async () => {
    const store = createPendingCreateStore({
      send: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(store.start(USER, request())).resolves.toMatchObject({ kind: "unresolved", error: { kind: "transport_uncertain", applied: "unknown" } });
    expect(store.get(USER, PAPER_ID)).toMatchObject({ status: "unresolved" });
  });

  it("reports every answer, retired or not, and settles the attempt before the store moves on", async () => {
    const sender = scriptedSender();
    const order: string[] = [];
    const onSettled = vi.fn((_user: string, attempt: CreateAttempt) => order.push(`settled:${attempt.kind}`));
    const store = createPendingCreateStore({ send: sender.send, onSettled });
    store.subscribe(() => order.push(`store:${store.get(USER, PAPER_ID)?.status ?? "none"}`));
    const attempt = store.start(USER, request())!;
    void attempt.then((result) => order.push(`heard:${result.kind}`));
    await sender.answer(refused(transportUncertainError()));
    const retried = store.retry(USER, PAPER_ID)!;
    void retried.then((result) => order.push(`heard:${result.kind}`));
    await sender.answer(created());
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled.mock.calls.map(([user]) => user)).toEqual([USER, USER]);
    expect(order).toEqual([
      "store:sending",
      "store:unresolved",
      "settled:unresolved",
      "heard:unresolved",
      "store:sending",
      "store:none",
      "settled:created",
      "heard:created",
    ]);
  });
});

describe("attempts are separate per paper and per user", () => {
  it("lets another paper start while one is unresolved", async () => {
    const sender = scriptedSender();
    const store = createPendingCreateStore({ send: sender.send });
    store.start(USER, request());
    await sender.answer(refused(transportUncertainError()));
    const other = store.start(USER, request(SECOND_PAPER_ID, uuid("7", 2)));
    expect(other).not.toBeNull();
    await sender.answer(created());
    await expect(other!).resolves.toMatchObject({ kind: "created" });
    expect(store.get(USER, PAPER_ID)).toMatchObject({ status: "unresolved" });
    expect(store.get(USER, SECOND_PAPER_ID)).toBeNull();
  });

  it("shows an attempt only to its user, and forgets the others when the user changes", async () => {
    const sender = scriptedSender();
    const listener = vi.fn();
    const store = createPendingCreateStore({ send: sender.send });
    store.subscribe(listener);
    store.start(USER, request());
    await sender.answer(refused(transportUncertainError()));
    expect(store.get(OTHER_USER, PAPER_ID)).toBeNull();
    expect(store.retry(OTHER_USER, PAPER_ID)).toBeNull();
    // Another user may create for their own paper of that id.
    expect(store.start(OTHER_USER, request(PAPER_ID, uuid("7", 9)))).not.toBeNull();
    await sender.answer(created());

    listener.mockClear();
    store.forgetOtherUsers(OTHER_USER);
    expect(store.get(USER, PAPER_ID)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    store.forgetOtherUsers(OTHER_USER);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("forgets everything when signed out, and an answer arriving afterwards brings nothing back", async () => {
    const sender = scriptedSender();
    const onSettled = vi.fn();
    const store = createPendingCreateStore({ send: sender.send, onSettled });
    const attempt = store.start(USER, request())!;
    store.forgetOtherUsers(null);
    expect(store.get(USER, PAPER_ID)).toBeNull();
    await sender.answer(refused(transportUncertainError()));
    await expect(attempt).resolves.toMatchObject({ kind: "unresolved" });
    expect(store.get(USER, PAPER_ID)).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);

    const again = store.start(USER, request(PAPER_ID, uuid("7", 2)))!;
    store.clear();
    await sender.answer(created());
    await expect(again).resolves.toMatchObject({ kind: "created" });
    expect(store.get(USER, PAPER_ID)).toBeNull();
  });

  it("finds a paper whatever the case of its id", async () => {
    const sender = scriptedSender();
    const store = createPendingCreateStore({ send: sender.send });
    store.start(USER, request());
    expect(store.get(USER, PAPER_ID.toUpperCase())).not.toBeNull();
    await sender.answer(created());
  });
});
