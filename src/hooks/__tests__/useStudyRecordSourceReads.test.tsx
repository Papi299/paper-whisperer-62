import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toPaperId, toSnapshotId } from "@/lib/evidence/ids";
import { queryKeys } from "@/lib/queryKeys";
import type { SnapshotInfo } from "@/lib/studyRecord/read";
import { fakeSupabase } from "@/lib/studyRecord/__tests__/fakeSupabase";
import { OTHER_USER, PAPER_ID, SECOND_PAPER_ID, snapshotRow, STUDY_ID, USER, uuid } from "@/lib/studyRecord/__tests__/fixtures";

/**
 * The Source pane's reads (EVIDENCE-RECORDS-001C2C-A) as the cache keeps
 * them: per user, per paper and per copy; never fresh, never kept once
 * nothing shows them; read only while enabled; and never the shared abstract
 * cache, which other screens fill.
 */

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("@/lib/studyRecord/__tests__/fakeSupabase").fakeSupabase>,
  tables: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => (state.db.client.from as unknown as (name: string) => unknown)(table),
    rpc: () => {
      throw new Error("forbidden: rpc");
    },
  },
}));
vi.mock("@/hooks/useCurrentUserAccess", () => ({ useCurrentUserAccess: () => ({ access: null, isLoading: false, isError: false }) }));

import { useLinkedPaperAbstract, useSavedCopy } from "../useStudyRecords";

const MINE = "My library's abstract.";
const THEIRS = "Another account's abstract.";
const OLD_COPY = uuid("c", 7);

function setTables() {
  state.tables = {
    papers: [
      { id: PAPER_ID, user_id: USER, title: "Mine", abstract: MINE },
      { id: SECOND_PAPER_ID, user_id: OTHER_USER, title: "Theirs", abstract: THEIRS },
    ],
    evidence_source_snapshots: [snapshotRow({ id: OLD_COPY, seq: 1, exact_text: "An earlier copy.", char_count: 16 })],
  };
  state.db = fakeSupabase({ tables: state.tables, project: true });
}

const abstractReads = () => state.db.requests.filter((request) => request.table === "papers");
const wrapperWith = (client: QueryClient) => ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(setTables);

describe("useLinkedPaperAbstract", () => {
  it("reads nothing until enabled — the Source pane on screen — then this user's paper only", async () => {
    const client = newClient();
    const { result, rerender } = renderHook(({ enabled }) => useLinkedPaperAbstract(USER, PAPER_ID, enabled), { wrapper: wrapperWith(client), initialProps: { enabled: false } });
    expect(abstractReads()).toEqual([]);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toEqual({ paperId: PAPER_ID, abstract: MINE }));
    expect(abstractReads().map((request) => request.eq)).toEqual([[["user_id", USER], ["id", PAPER_ID]]]);
  });

  it("never shows one account's abstract to another: per-user keys, and another user's paper is not theirs", async () => {
    const client = newClient();
    const { result, rerender } = renderHook(({ userId, paperId }) => useLinkedPaperAbstract(userId, paperId, true), {
      wrapper: wrapperWith(client),
      initialProps: { userId: USER, paperId: PAPER_ID },
    });
    await waitFor(() => expect(result.current.data?.abstract).toBe(MINE));
    // Another account signs in on the same tab and the pane asks for a paper id it doesn't own.
    rerender({ userId: OTHER_USER, paperId: PAPER_ID });
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(result.current.data).not.toEqual(expect.objectContaining({ abstract: MINE }));
    rerender({ userId: OTHER_USER, paperId: SECOND_PAPER_ID });
    await waitFor(() => expect(result.current.data?.abstract).toBe(THEIRS));
    // The first user's answer was dropped as soon as nothing showed it.
    expect(client.getQueryData(queryKeys.studyRecords.libraryAbstract(USER, PAPER_ID))).toBeUndefined();
    // Nothing went into the shared, not-per-user abstract cache.
    expect(client.getQueryData(queryKeys.papers.abstract(PAPER_ID))).toBeUndefined();
  });

  it("reads again whenever the pane shows it again, and keeps nothing once it is closed", async () => {
    const client = newClient();
    const { result, rerender, unmount } = renderHook(({ enabled }) => useLinkedPaperAbstract(USER, PAPER_ID, enabled), { wrapper: wrapperWith(client), initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.data?.abstract).toBe(MINE));
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(abstractReads()).toHaveLength(2));
    // A study-record write marks it stale, and the pane on screen reads it again.
    await client.invalidateQueries({ queryKey: queryKeys.studyRecords.all(USER) });
    await waitFor(() => expect(abstractReads()).toHaveLength(3));
    unmount();
    await waitFor(() => expect(client.getQueryCache().find({ queryKey: queryKeys.studyRecords.libraryAbstract(USER, PAPER_ID) })).toBeUndefined());
  });
});

describe("useSavedCopy", () => {
  const info: SnapshotInfo = { id: toSnapshotId(OLD_COPY)!, paperId: toPaperId(PAPER_ID)!, seq: 1, capturedAt: "2026-10-20T10:00:00.000Z", charCount: 16 };

  it("reads one copy when it is opened, never again while it is shown, and keeps nothing once it is closed", async () => {
    const client = newClient();
    const { result, unmount } = renderHook(() => useSavedCopy(USER, STUDY_ID, info), { wrapper: wrapperWith(client) });
    await waitFor(() => expect(result.current.data?.exactText).toBe("An earlier copy."));
    const reads = () => state.db.requests.filter((request) => request.table === "evidence_source_snapshots");
    expect(reads()).toHaveLength(1);
    await client.invalidateQueries({ queryKey: queryKeys.studyRecords.all(USER) });
    expect(reads()).toHaveLength(1);
    unmount();
    await waitFor(() => expect(client.getQueryCache().find({ queryKey: queryKeys.studyRecords.savedCopy(USER, STUDY_ID, OLD_COPY) })).toBeUndefined());
  });

  it("reads nothing without a copy to show", () => {
    renderHook(() => useSavedCopy(USER, STUDY_ID, null), { wrapper: wrapperWith(newClient()) });
    expect(state.db.requests).toEqual([]);
  });

  it("is per user: another account's key never holds this one's copy", async () => {
    const client = newClient();
    const { result, rerender } = renderHook(({ userId }) => useSavedCopy(userId, STUDY_ID, info), { wrapper: wrapperWith(client), initialProps: { userId: USER } });
    await waitFor(() => expect(result.current.data?.exactText).toBe("An earlier copy."));
    rerender({ userId: OTHER_USER });
    // The fake answers by user: the other account has no such copy.
    await waitFor(() => expect(result.current.data).toBeNull());
  });
});
