import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toRequestId, toStudyVersion } from "@/lib/evidence/ids";
import { queryKeys } from "@/lib/queryKeys";
import { fakeSupabase } from "@/lib/studyRecord/__tests__/fakeSupabase";
import { OTHER_USER, STUDY_ID, studyRow, USER, uuid } from "@/lib/studyRecord/__tests__/fixtures";
import { changeRow, headerRow, historyRows, manyOperations, requestIdOf, type EventRow } from "@/lib/studyRecord/__tests__/historyFixtures";

/**
 * The History hooks' cache lifecycle (EVIDENCE-RECORDS-001C2B): read on
 * demand, scoped to the signed-in user, kept only while observed, read again
 * by every study-record write and by Refresh — and an operation's committed
 * changes read once.
 */

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("@/lib/studyRecord/__tests__/fakeSupabase").fakeSupabase>,
  tables: {} as Record<string, Record<string, unknown>[]>,
  failures: {} as Record<string, { error: unknown; status?: number }>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => (state.db.client.from as unknown as (name: string) => unknown)(table),
    rpc: () => {
      throw new Error("forbidden: rpc");
    },
    get functions() {
      throw new Error("forbidden: functions");
    },
    get storage() {
      throw new Error("forbidden: storage");
    },
  },
}));

import { useStudyRecordHistory, useStudyRecordHistoryChanges } from "../useStudyRecordHistory";

const DENIED = { error: { code: "42501", message: "permission denied" }, status: 403 };

function setTables(events: EventRow[], studies = [studyRow()]) {
  state.tables = { evidence_events: events, evidence_studies: studies };
  state.failures = {};
  state.db = fakeSupabase({ tables: state.tables, failures: state.failures, project: true });
}

const historyRequests = () => state.db.requests.filter((request) => request.table === "evidence_events");

function wrapperWith(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => setTables(historyRows()));
afterEach(() => vi.useRealTimers());

describe("reading on demand", () => {
  it("reads nothing until enabled, then the newest page", async () => {
    const client = newClient();
    const { result, rerender } = renderHook(({ enabled }) => useStudyRecordHistory(USER, STUDY_ID, enabled), {
      wrapper: wrapperWith(client),
      initialProps: { enabled: false },
    });
    expect(result.current.status).toBe("loading");
    expect(historyRequests()).toEqual([]);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.operations.map((operation) => operation.studyVersion)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(result.current.hasOlder).toBe(true);
    expect(historyRequests()).toHaveLength(1);
  });

  it("keeps nothing once the pane is gone: every opening reads afresh", async () => {
    const client = newClient();
    const first = renderHook(() => useStudyRecordHistory(USER, STUDY_ID, true), { wrapper: wrapperWith(client) });
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    first.unmount();
    await waitFor(() => expect(client.getQueryCache().find({ queryKey: queryKeys.studyRecords.history(USER, STUDY_ID) })).toBeUndefined());
    // A request committed meanwhile is there on the next opening.
    state.tables.evidence_events.push(headerRow(13, "save_changes"));
    const second = renderHook(() => useStudyRecordHistory(USER, STUDY_ID, true), { wrapper: wrapperWith(client) });
    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    expect(second.result.current.operations[0].studyVersion).toBe(13);
    expect(historyRequests()).toHaveLength(2);
  });
});

describe("one user's history", () => {
  it("switching the signed-in user reads that user's history, and never hands over the previous one's", async () => {
    const client = newClient();
    const { result, rerender } = renderHook(({ userId }) => useStudyRecordHistory(userId, STUDY_ID, true), {
      wrapper: wrapperWith(client),
      initialProps: { userId: USER },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ userId: OTHER_USER });
    // Never USER's operations under OTHER_USER, not even for a render.
    expect(result.current.operations).toEqual([]);
    await waitFor(() => expect(result.current.status).toBe("gone"));
    expect(result.current.operations).toEqual([]);
    const last = historyRequests().at(-1)!;
    expect(last.eq).toContainEqual(["user_id", OTHER_USER]);
    // Two keys, one per user: the cache never shares an entry between accounts.
    expect(client.getQueryCache().find({ queryKey: queryKeys.studyRecords.history(OTHER_USER, STUDY_ID) })).toBeDefined();
  });

  it("asks nothing for a signed-out session or a study id that isn't one", () => {
    const client = newClient();
    for (const [userId, studyId] of [
      [null, STUDY_ID],
      [undefined, STUDY_ID],
      [USER, "not-a-uuid"],
      [USER, null],
    ] as const) {
      const { result, unmount } = renderHook(() => useStudyRecordHistory(userId, studyId, true), { wrapper: wrapperWith(client) });
      expect(result.current.status).toBe("loading");
      unmount();
    }
    expect(historyRequests()).toEqual([]);
  });
});

describe("refresh, older pages and failures", () => {
  it("Refresh keeps only the newest page and reads it again — one request — and a request committed elsewhere appears once", async () => {
    setTables(manyOperations(25));
    const client = newClient();
    const { result } = renderHook(() => useStudyRecordHistory(USER, STUDY_ID, true), { wrapper: wrapperWith(client) });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.loadOlder();
    });
    // TanStack notifies observers on a later task: wait for the render, not the promise.
    await waitFor(() => expect(result.current.operations).toHaveLength(20));
    state.tables.evidence_events.push(headerRow(26, "save_changes"));
    const before = historyRequests().length;
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.operations.map((operation) => operation.studyVersion)).toEqual([26, 25, 24, 23, 22, 21, 20, 19, 18, 17]));
    expect(historyRequests().length - before).toBe(1);
    expect(historyRequests().at(-1)!.lt).toEqual([]);
  });

  it("after a failed Load older, what is shown stays, and trying again asks for the same page — nothing twice", async () => {
    const client = newClient();
    const { result } = renderHook(() => useStudyRecordHistory(USER, STUDY_ID, true), { wrapper: wrapperWith(client) });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    state.failures.evidence_events = DENIED;
    await act(async () => {
      expect(await result.current.loadOlder()).toBe(false);
    });
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", olderFailed: true, hasOlder: true }));
    expect(result.current.operations).toHaveLength(10);
    delete state.failures.evidence_events;
    await act(async () => {
      expect(await result.current.loadOlder()).toBe(true);
    });
    await waitFor(() => expect(result.current.operations.map((operation) => operation.studyVersion)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]));
    expect(result.current.olderFailed).toBe(false);
    expect(historyRequests().slice(1).map((request) => request.lt)).toEqual([[["study_version", 3]], [["study_version", 3]]]);
  });

  it("a failed first read is an error — never an empty history — and a failed refresh keeps what was read, flagged", async () => {
    state.failures.evidence_events = DENIED;
    const client = newClient();
    const { result } = renderHook(() => useStudyRecordHistory(USER, STUDY_ID, true), { wrapper: wrapperWith(client) });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.operations).toEqual([]);
    expect(result.current.error).toMatchObject({ kind: "transport", transient: false });
    delete state.failures.evidence_events;
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    state.failures.evidence_events = DENIED;
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", refreshFailed: true }));
    expect(result.current.operations).toHaveLength(10);
  });

  it("a read that finds the study gone — or an operation's details that do — shows nothing read before", async () => {
    const client = newClient();
    const { result } = renderHook(() => useStudyRecordHistory(USER, STUDY_ID, true), { wrapper: wrapperWith(client) });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.markGone());
    expect(result.current).toMatchObject({ status: "gone", operations: [], hasOlder: false });
  });
});

describe("study-record writes", () => {
  it("every write's invalidation reads the list again, but never an open operation's committed changes", async () => {
    const client = newClient();
    const operation = { studyVersion: toStudyVersion(2)!, requestId: toRequestId(requestIdOf(2))! };
    const { result } = renderHook(
      () => ({ list: useStudyRecordHistory(USER, STUDY_ID, true), changes: useStudyRecordHistoryChanges(USER, STUDY_ID, operation, true) }),
      { wrapper: wrapperWith(client) },
    );
    await waitFor(() => expect(result.current.list.status).toBe("ready"));
    await waitFor(() => expect(result.current.changes.status).toBe("ready"));
    expect(result.current.changes.changes).toHaveLength(6);
    const lists = () => historyRequests().filter((request) => request.eq.some(([column]) => column === "ordinal")).length;
    const details = () => historyRequests().filter((request) => request.eq.some(([column]) => column === "study_version")).length;
    expect([lists(), details()]).toEqual([1, 1]);
    // What useStudyRecordEditor does after each of its writes.
    state.tables.evidence_events.push(headerRow(13, "review_fields"), changeRow(13, 1, "outcome_added", { target: uuid("e", 50), after: { display_label: "X", position: 1 } }));
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.studyRecords.all(USER) });
    });
    await waitFor(() => expect(result.current.list.operations[0].studyVersion).toBe(13));
    expect([lists(), details()]).toEqual([2, 1]);
  });
});
