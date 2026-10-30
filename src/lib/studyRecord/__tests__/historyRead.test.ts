import { describe, expect, it } from "vitest";
import { toRequestId, toStudyId, toStudyVersion, type StudyVersion } from "@/lib/evidence/ids";
import {
  fetchHistoryChanges,
  fetchHistoryPage,
  HISTORY_CHANGES_PAGE_SIZE,
  HISTORY_PAGE_SIZE,
  mergeHistoryPages,
  type HistoryPageRead,
} from "../historyRead";
import { StudyRecordReadError, type StudyRecordClient } from "../read";
import { fakeSupabase, missingTableError } from "./fakeSupabase";
import { OTHER_USER, STUDY_ID, studyRow, USER, uuid } from "./fixtures";
import { changeRow, headerRow, historyRows, largeSave, manyOperations, requestIdOf, type EventRow } from "./historyFixtures";

/**
 * Reading history (EVIDENCE-RECORDS-001C2B): headers paged by study version,
 * an operation's changes paged by ordinal, each answer checked — a refusal or a
 * malformed answer is an error, never an empty history, and never another
 * operation's events.
 */

const signal = new AbortController().signal;
const STUDY = toStudyId(STUDY_ID)!;
const v = (n: number) => toStudyVersion(n)!;
const HEADER_COLUMNS = "id, user_id, study_id, study_version, ordinal, event_type, request_id, op, occurred_at";
const CHANGE_COLUMNS = "id, user_id, study_id, study_version, ordinal, event_type, request_id, op, target_id, field_key, before, after, occurred_at";

function db(events: EventRow[], studies = [studyRow()], options: Parameters<typeof fakeSupabase>[0]["failures"] = {}) {
  return fakeSupabase({ tables: { evidence_events: events, evidence_studies: studies }, failures: options, project: true });
}

/** A server that ignores every filter and answers `rows` for `table`: what a broken or hostile response looks like. */
function answering(rows: Record<string, unknown[]>): StudyRecordClient {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    for (const method of ["select", "eq", "lt", "gt", "order", "limit", "range", "abortSignal"]) self[method] = () => self;
    self.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows[table] ?? [], error: null, status: 200 });
    return self;
  };
  return { from: chain } as unknown as StudyRecordClient;
}

const versions = (page: HistoryPageRead) => (page.kind === "page" ? page.operations.map((operation) => operation.studyVersion) : page.kind);

describe("a page of operations", () => {
  it("reads the newest headers first, scoped to the caller and the study, with one row of look-ahead and the minimal projection", async () => {
    const { client, requests } = db(historyRows());
    const page = await fetchHistoryPage(client, USER, STUDY, null, signal);
    expect(versions(page)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(page.kind === "page" && page.olderThan).toBe(3);
    expect(requests).toEqual([
      {
        table: "evidence_events",
        columns: HEADER_COLUMNS,
        eq: [
          ["user_id", USER],
          ["study_id", STUDY_ID],
          ["ordinal", 0],
        ],
        in: [],
        lt: [],
        gt: [],
        order: ["study_version desc"],
        range: null,
        limit: HISTORY_PAGE_SIZE + 1,
        signal: true,
      },
    ]);
    // Never the request's fingerprint, its stored result or a note.
    expect(HEADER_COLUMNS.split(", ")).not.toEqual(expect.arrayContaining(["payload_sha256"]));
    for (const column of ["payload_sha256", "result", "note", "before", "after"]) expect(HEADER_COLUMNS.split(", ")).not.toContain(column);
  });

  it("maps each header to its version, op, time and request id — nothing else", async () => {
    const { client } = db(historyRows());
    const page = await fetchHistoryPage(client, USER, STUDY, null, signal);
    expect(page.kind === "page" && page.operations[0]).toEqual({
      id: uuid("8", 12000),
      studyVersion: 12,
      op: "save_changes",
      occurredAt: "2026-10-20T22:00:00.000Z",
      requestId: requestIdOf(12),
    });
  });

  it("reads older pages below the cursor, never by offset, until the first operation", async () => {
    const { client, requests } = db(historyRows());
    const older = await fetchHistoryPage(client, USER, STUDY, v(3), signal);
    expect(versions(older)).toEqual([2, 1]);
    expect(older.kind === "page" && older.olderThan).toBeNull();
    expect(requests[0].lt).toEqual([["study_version", 3]]);
    expect(requests[0].range).toBeNull();
  });

  it("says there is nothing older when a page is exactly full, and something older when one more exists", async () => {
    const exact = await fetchHistoryPage(db(manyOperations(HISTORY_PAGE_SIZE)).client, USER, STUDY, null, signal);
    expect(versions(exact)).toHaveLength(HISTORY_PAGE_SIZE);
    expect(exact.kind === "page" && exact.olderThan).toBeNull();
    const plusOne = await fetchHistoryPage(db(manyOperations(HISTORY_PAGE_SIZE + 1)).client, USER, STUDY, null, signal);
    expect(versions(plusOne)).toHaveLength(HISTORY_PAGE_SIZE);
    expect(plusOne.kind === "page" && plusOne.olderThan).toBe(2);
    const last = await fetchHistoryPage(db(manyOperations(HISTORY_PAGE_SIZE + 1)).client, USER, STUDY, v(2), signal);
    expect(versions(last)).toEqual([1]);
  });

  it("pages through 25 operations without a duplicate or a gap", async () => {
    const { client } = db(manyOperations(25));
    const seen: number[] = [];
    let cursor: StudyVersion | null = null;
    for (let guard = 0; guard < 5; guard += 1) {
      const page = await fetchHistoryPage(client, USER, STUDY, cursor, signal);
      if (page.kind !== "page") throw new Error("gone");
      seen.push(...page.operations.map((operation) => operation.studyVersion));
      cursor = page.olderThan;
      if (cursor === null) break;
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => 25 - i));
  });

  it("neither repeats nor skips an older operation when newer ones are committed between pages", async () => {
    const rows = manyOperations(12);
    const { client } = db(rows);
    const first = await fetchHistoryPage(client, USER, STUDY, null, signal);
    expect(versions(first)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    // Two requests commit while the user reads.
    rows.push(headerRow(13, "save_changes"), changeRow(13, 1, "outcome_added", { target: uuid("e", 13), after: { display_label: "Outcome 13", position: 0 } }));
    rows.push(headerRow(14, "review_fields"));
    const older = await fetchHistoryPage(client, USER, STUDY, first.kind === "page" ? first.olderThan : null, signal);
    expect(versions(older)).toEqual([2, 1]);
    // They appear when the newest page is read again.
    expect(versions(await fetchHistoryPage(client, USER, STUDY, null, signal))).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
  });

  it("reports an empty history as empty only when the study exists, and asks only then", async () => {
    const { client, requests } = db([]);
    const page = await fetchHistoryPage(client, USER, STUDY, null, signal);
    expect(page).toEqual({ kind: "page", operations: [], olderThan: null });
    expect(requests.map((request) => request.table)).toEqual(["evidence_events", "evidence_studies"]);
    expect(requests[1]).toMatchObject({ columns: "id, user_id", eq: [["user_id", USER], ["id", STUDY_ID]] });
  });

  it("says gone — the same for a deleted study and someone else's — and shows nothing of theirs", async () => {
    // Another user's study with the same id and history: filtered out by user, so indistinguishable from none.
    const theirs = historyRows().map((row) => ({ ...row, user_id: OTHER_USER }));
    const answers = await Promise.all([
      fetchHistoryPage(db([], []).client, USER, STUDY, null, signal),
      fetchHistoryPage(db(theirs, [studyRow({ user_id: OTHER_USER })]).client, USER, STUDY, null, signal),
    ]);
    expect(answers).toEqual([{ kind: "gone" }, { kind: "gone" }]);
  });

  it("says gone when an older page finds nothing because the study was deleted; an integrity failure when the study is still there", async () => {
    await expect(fetchHistoryPage(db([], []).client, USER, STUDY, v(5), signal)).resolves.toEqual({ kind: "gone" });
    await expect(fetchHistoryPage(db([], [studyRow()]).client, USER, STUDY, v(5), signal)).rejects.toMatchObject({ kind: "integrity" });
  });

  it.each([0, -1, 1.5, Number.NaN, 2147483648, "3" as unknown as number])("refuses the cursor %s before sending anything", async (cursor) => {
    const { client, requests } = db(historyRows());
    await expect(fetchHistoryPage(client, USER, STUDY, cursor as StudyVersion, signal)).rejects.toMatchObject({ kind: "integrity" });
    expect(requests).toEqual([]);
  });

  it.each<[string, unknown[]]>([
    ["a row of another user", [{ ...headerRow(3, "save_changes"), user_id: OTHER_USER }]],
    ["a row of another study", [{ ...headerRow(3, "save_changes"), study_id: uuid("5", 2) }]],
    ["a change event among the headers", [changeRow(3, 1, "outcome_added", { target: uuid("e", 1) })]],
    ["a header without its op", [{ ...headerRow(3, "save_changes"), op: null }]],
    ["an unknown op", [{ ...headerRow(3, "save_changes"), op: "confirm_all" }]],
    ["a time that isn't one", [{ ...headerRow(3, "save_changes"), occurred_at: "yesterday" }]],
    ["a duplicated version", [headerRow(3, "save_changes"), headerRow(3, "save_changes")]],
    ["versions out of order", [headerRow(2, "save_changes"), headerRow(3, "save_changes")]],
    ["a version at the cursor", [headerRow(5, "save_changes")]],
    ["more rows than asked for", manyOperations(HISTORY_PAGE_SIZE + 2).filter((row) => row.ordinal === 0)],
    ["a row that isn't an object", ["header"]],
  ])("refuses %s as an integrity failure", async (_label, rows) => {
    await expect(fetchHistoryPage(answering({ evidence_events: rows }), USER, STUDY, v(5), signal)).rejects.toMatchObject({ kind: "integrity" });
  });

  it("is a transport failure, never an empty history, when the read fails", async () => {
    const thrown = fetchHistoryPage(db(historyRows(), [studyRow()], { evidence_events: "throw" }).client, USER, STUDY, null, signal);
    await expect(thrown).rejects.toBeInstanceOf(StudyRecordReadError);
    await expect(thrown).rejects.toMatchObject({ kind: "transport", transient: true });
    await expect(
      fetchHistoryPage(db(historyRows(), [studyRow()], { evidence_events: { error: { code: "PGRST000", message: "x" }, status: 503 } }).client, USER, STUDY, null, signal),
    ).rejects.toMatchObject({ kind: "transport", transient: true });
    await expect(
      fetchHistoryPage(db(historyRows(), [studyRow()], { evidence_events: { error: { code: "42501", message: "permission denied" }, status: 403 } }).client, USER, STUDY, null, signal),
    ).rejects.toMatchObject({ kind: "transport", transient: false });
    await expect(
      fetchHistoryPage(db(historyRows(), [studyRow()], { evidence_events: { error: missingTableError("evidence_events"), status: 404 } }).client, USER, STUDY, null, signal),
    ).rejects.toMatchObject({ kind: "missing_schema" });
    // An empty answer whose existence check fails is a failure too.
    await expect(fetchHistoryPage(db([], [studyRow()], { evidence_studies: "throw" }).client, USER, STUDY, null, signal)).rejects.toMatchObject({ kind: "transport" });
  });
});

describe("an operation's changes", () => {
  const operation = (version: number) => ({ studyVersion: v(version), requestId: toRequestId(requestIdOf(version))! });

  it("reads one operation's change events in order, scoped to the caller, the study and the version, with its own projection", async () => {
    const { client, requests } = db(historyRows());
    const page = await fetchHistoryChanges(client, USER, STUDY, operation(2), 0, signal);
    expect(page.kind === "page" && page.changes.map((change) => [change.ordinal, change.type])).toEqual([
      [1, "arm_added"],
      [2, "arm_added"],
      [3, "outcome_added"],
      [4, "value_saved"],
      [5, "value_saved"],
      [6, "value_saved"],
    ]);
    expect(page.kind === "page" && page.after).toBeNull();
    expect(requests).toEqual([
      {
        table: "evidence_events",
        columns: CHANGE_COLUMNS,
        eq: [
          ["user_id", USER],
          ["study_id", STUDY_ID],
          ["study_version", 2],
        ],
        in: [],
        lt: [],
        gt: [["ordinal", 0]],
        order: ["ordinal"],
        range: null,
        limit: HISTORY_CHANGES_PAGE_SIZE + 1,
        signal: true,
      },
    ]);
    for (const column of ["payload_sha256", "result", "note"]) expect(CHANGE_COLUMNS.split(", ")).not.toContain(column);
  });

  it("never receives the stored note, the request fingerprint or the result: the planted note stays in the table", async () => {
    const { client } = db(historyRows());
    const page = await fetchHistoryChanges(client, USER, STUDY, operation(12), 0, signal);
    expect(JSON.stringify(page)).not.toMatch(/PLANTED-NOTE|payload|\\\\xabab/);
  });

  it("pages a large save — 120 changes — in parts of 50, contiguous, none twice, none cut off", async () => {
    const { client, requests } = db(largeSave(3, 120));
    const ordinals: number[] = [];
    let after = 0;
    for (let guard = 0; guard < 5; guard += 1) {
      const page = await fetchHistoryChanges(client, USER, STUDY, operation(3), after, signal);
      if (page.kind !== "page") throw new Error("gone");
      ordinals.push(...page.changes.map((change) => change.ordinal));
      if (page.after === null) break;
      after = page.after;
    }
    expect(ordinals).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(requests.map((request) => request.gt)).toEqual([[["ordinal", 0]], [["ordinal", 50]], [["ordinal", 100]]]);
  });

  it("says there are no more changes when a page is exactly full", async () => {
    const page = await fetchHistoryChanges(db(largeSave(3, HISTORY_CHANGES_PAGE_SIZE)).client, USER, STUDY, operation(3), 0, signal);
    expect(page.kind === "page" && [page.changes.length, page.after]).toEqual([HISTORY_CHANGES_PAGE_SIZE, null]);
  });

  it.each<[string, unknown[]]>([
    ["another request's event at this version", [changeRow(2, 1, "arm_added", { target: uuid("d", 1) }, { request_id: requestIdOf(3) })]],
    ["a neighbouring operation's event", [changeRow(3, 1, "review_confirmed", { target: uuid("f", 1), fieldKey: "condition" })]],
    ["a gap in the ordinals", [changeRow(2, 1, "arm_added", { target: uuid("d", 1) }), changeRow(2, 3, "outcome_added", { target: uuid("e", 1) })]],
    ["a repeated ordinal", [changeRow(2, 1, "arm_added", { target: uuid("d", 1) }), changeRow(2, 1, "arm_added", { target: uuid("d", 1) })]],
    ["a first change that isn't ordinal 1", [changeRow(2, 2, "arm_added", { target: uuid("d", 1) })]],
    ["the header among its changes", [headerRow(2, "save_changes")]],
    ["a row of another user", [{ ...changeRow(2, 1, "arm_added", { target: uuid("d", 1) }), user_id: OTHER_USER }]],
    ["an event type the schema doesn't know", [{ ...changeRow(2, 1, "arm_added", { target: uuid("d", 1) }), event_type: "value_verified" }]],
    ["more rows than asked for", largeSave(2, HISTORY_CHANGES_PAGE_SIZE + 2).slice(1)],
  ])("refuses %s as an integrity failure — never shown under this operation", async (_label, rows) => {
    await expect(fetchHistoryChanges(answering({ evidence_events: rows }), USER, STUDY, operation(2), 0, signal)).rejects.toMatchObject({ kind: "integrity" });
  });

  it("says gone when the operation's events vanished with the study; an integrity failure when the study is still there", async () => {
    await expect(fetchHistoryChanges(db([], []).client, USER, STUDY, operation(2), 0, signal)).resolves.toEqual({ kind: "gone" });
    await expect(fetchHistoryChanges(db([headerRow(2, "save_changes")], [studyRow()]).client, USER, STUDY, operation(2), 0, signal)).rejects.toMatchObject({ kind: "integrity" });
  });

  it.each<[string, { studyVersion: number; requestId: string }, number]>([
    ["a version that isn't one", { studyVersion: 0, requestId: requestIdOf(2) }, 0],
    ["a request id that isn't one", { studyVersion: 2, requestId: "not-a-uuid" }, 0],
    ["a negative cursor", { studyVersion: 2, requestId: requestIdOf(2) }, -1],
    ["a fractional cursor", { studyVersion: 2, requestId: requestIdOf(2) }, 1.5],
  ])("refuses %s before sending anything", async (_label, given, after) => {
    const { client, requests } = db(historyRows());
    await expect(fetchHistoryChanges(client, USER, STUDY, given as never, after, signal)).rejects.toMatchObject({ kind: "integrity" });
    expect(requests).toEqual([]);
  });
});

describe("merging pages", () => {
  const page = (...nums: number[]): HistoryPageRead => ({
    kind: "page",
    operations: nums.map((n) => ({ id: uuid("8", n) as never, studyVersion: v(n), op: "save_changes", occurredAt: "2026-10-20T10:00:00.000Z", requestId: requestIdOf(n) as never })),
    olderThan: null,
  });

  it("joins pages newest first", () => {
    const merged = mergeHistoryPages([page(9, 8), page(7, 6), page()]);
    expect(merged.kind === "operations" && merged.operations.map((operation) => operation.studyVersion)).toEqual([9, 8, 7, 6]);
  });

  it("is gone when any page found the study gone — nothing read before is shown", () => {
    expect(mergeHistoryPages([page(9, 8), { kind: "gone" }])).toEqual({ kind: "gone" });
  });

  it.each([
    ["a repeat across pages", [page(9, 8), page(8, 7)]],
    ["pages out of order", [page(5, 4), page(9, 8)]],
  ])("refuses %s rather than show an operation twice", (_label, pages) => {
    expect(() => mergeHistoryPages(pages as HistoryPageRead[])).toThrow(StudyRecordReadError);
  });
});
