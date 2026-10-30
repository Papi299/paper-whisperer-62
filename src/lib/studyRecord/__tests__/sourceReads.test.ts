import { describe, expect, it } from "vitest";
import { toPaperId, toStudyId, type SnapshotId } from "@/lib/evidence/ids";
import { fetchLinkedPaperAbstract, fetchSavedCopy, StudyRecordReadError, type SnapshotInfo } from "../read";
import { fakeSupabase, missingTableError } from "./fakeSupabase";
import { ABSTRACT, OTHER_USER, PAPER_ID, SECOND_PAPER_ID, snapshotRow, STUDY_ID, USER, uuid } from "./fixtures";

/**
 * The Source pane's two reads (EVIDENCE-RECORDS-001C2C-A): one linked paper's
 * library abstract, and one saved copy's text. Owner-scoped SELECTs by every
 * identifier, checked against what was asked and what the record holds — a
 * refusal or a malformed answer is an error, never a stand-in.
 */

const signal = new AbortController().signal;
const STUDY = toStudyId(STUDY_ID)!;
const PAPER = toPaperId(PAPER_ID)!;
const OLD_COPY = uuid("c", 7) as SnapshotId;
const T_OLD = "2026-10-01T12:00:00.000Z";
const LONE_SURROGATE = String.fromCharCode(0xd800);

const paperRow = (overrides: Record<string, unknown> = {}) => ({ id: PAPER_ID, user_id: USER, title: "A title", abstract: ABSTRACT, notes: "private", ...overrides });

describe("fetchLinkedPaperAbstract", () => {
  it("asks for one paper of this user, by id, for its id, owner and abstract only — with the abort signal", async () => {
    const { client, requests } = fakeSupabase({ tables: { papers: [paperRow(), paperRow({ id: SECOND_PAPER_ID })] }, project: true });
    expect(await fetchLinkedPaperAbstract(client, USER, PAPER, signal)).toEqual({ paperId: PAPER_ID, abstract: ABSTRACT });
    expect(requests).toEqual([
      { table: "papers", columns: "id, user_id, abstract", eq: [["user_id", USER], ["id", PAPER_ID]], in: [], lt: [], gt: [], order: [], range: null, limit: null, signal: true },
    ]);
  });

  it("returns a paper without an abstract as null — never the saved copy in its place", async () => {
    const { client } = fakeSupabase({ tables: { papers: [paperRow({ abstract: null })] }, project: true });
    expect(await fetchLinkedPaperAbstract(client, USER, PAPER, signal)).toEqual({ paperId: PAPER_ID, abstract: null });
  });

  it("resolves to null when this user has no such paper (another user's paper is not theirs)", async () => {
    const { client } = fakeSupabase({ tables: { papers: [paperRow({ user_id: OTHER_USER })] }, project: true });
    expect(await fetchLinkedPaperAbstract(client, USER, PAPER, signal)).toBeNull();
  });

  it.each([
    ["a row of another user", [paperRow({ user_id: OTHER_USER })]],
    ["a row of another paper", [paperRow({ id: SECOND_PAPER_ID })]],
    ["two rows", [paperRow(), paperRow()]],
    ["an abstract that isn't text", [paperRow({ abstract: 42 })]],
    ["an abstract no database text can hold", [paperRow({ abstract: `broken ${LONE_SURROGATE} text` })]],
    ["an abstract with a NUL", [paperRow({ abstract: `a${String.fromCharCode(0)}b` })]],
    ["a row without its abstract column", [{ id: PAPER_ID, user_id: USER }]],
  ])("refuses %s as an integrity failure", async (_label, rows) => {
    // Answered as given, whatever was asked: what a broken or hostile response would be.
    const client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ abortSignal: async () => ({ data: rows, error: null, status: 200 }) }) }) }) }) };
    const error = await fetchLinkedPaperAbstract(client as never, USER, PAPER, signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StudyRecordReadError);
    expect(error).toMatchObject({ kind: "integrity", transient: false });
  });

  it("is a transport error when the read is refused or the network fails — transient only when trying again could help", async () => {
    const refused = fakeSupabase({ tables: {}, failures: { papers: { error: { code: "42501", message: "permission denied" }, status: 403 } } });
    await expect(fetchLinkedPaperAbstract(refused.client, USER, PAPER, signal)).rejects.toMatchObject({ kind: "transport", transient: false });
    const busy = fakeSupabase({ tables: {}, failures: { papers: { error: { code: "57014", message: "canceling statement" }, status: 500 } } });
    await expect(fetchLinkedPaperAbstract(busy.client, USER, PAPER, signal)).rejects.toMatchObject({ kind: "transport", transient: true });
    const offline = fakeSupabase({ tables: {}, failures: { papers: "throw" } });
    await expect(fetchLinkedPaperAbstract(offline.client, USER, PAPER, signal)).rejects.toMatchObject({ kind: "transport", transient: true });
  });
});

describe("fetchSavedCopy", () => {
  const oldRow = () => snapshotRow({ id: OLD_COPY, seq: 1, captured_at: T_OLD, exact_text: "An earlier abstract.", char_count: 20 });
  const info = (overrides: Partial<SnapshotInfo> = {}): SnapshotInfo => ({ id: OLD_COPY, paperId: PAPER, seq: 1, capturedAt: T_OLD, charCount: 20, ...overrides });

  it("asks for one copy by user, study, paper and id — and returns it mapped", async () => {
    const { client, requests } = fakeSupabase({ tables: { evidence_source_snapshots: [oldRow(), snapshotRow({ seq: 2 })] }, project: true });
    const copy = await fetchSavedCopy(client, USER, STUDY, info(), signal);
    expect(copy).toMatchObject({ id: OLD_COPY, studyId: STUDY_ID, paperId: PAPER_ID, seq: 1, exactText: "An earlier abstract.", charCount: 20, capturedAt: T_OLD });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      table: "evidence_source_snapshots",
      eq: [["user_id", USER], ["study_id", STUDY_ID], ["paper_id", PAPER_ID], ["id", OLD_COPY]],
      in: [],
      signal: true,
    });
    expect(requests[0].columns.split(", ")).toContain("exact_text");
  });

  it("resolves to null when the copy no longer exists", async () => {
    const { client } = fakeSupabase({ tables: { evidence_source_snapshots: [] } });
    expect(await fetchSavedCopy(client, USER, STUDY, info(), signal)).toBeNull();
  });

  it.each([
    ["another sequence number", info({ seq: 2 })],
    ["another capture time", info({ capturedAt: "2026-10-02T12:00:00.000Z" })],
    ["another length", info({ charCount: 21 })],
  ])("refuses a copy that isn't the one the record holds: %s", async (_label, expected) => {
    const { client } = fakeSupabase({ tables: { evidence_source_snapshots: [oldRow()] } });
    await expect(fetchSavedCopy(client, USER, STUDY, expected, signal)).rejects.toMatchObject({ kind: "integrity" });
  });

  it.each([
    ["a row of another user", { user_id: OTHER_USER }],
    ["a row of another study", { study_id: uuid("5", 9) }],
    ["a row of another paper", { paper_id: SECOND_PAPER_ID }],
    ["a malformed copy", { char_count: 999 }],
  ])("refuses %s, whatever was asked", async (_label, overrides) => {
    const rows = [{ ...oldRow(), ...overrides }];
    const client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ abortSignal: async () => ({ data: rows, error: null, status: 200 }) }) }) }) }) }) }) };
    await expect(fetchSavedCopy(client as never, USER, STUDY, info(), signal)).rejects.toMatchObject({ kind: "integrity" });
  });

  it("tells a missing evidence schema apart, and is transient when the network fails", async () => {
    const missing = fakeSupabase({ tables: {}, failures: { evidence_source_snapshots: { error: missingTableError("evidence_source_snapshots"), status: 404 } } });
    await expect(fetchSavedCopy(missing.client, USER, STUDY, info(), signal)).rejects.toMatchObject({ kind: "missing_schema" });
    const offline = fakeSupabase({ tables: {}, failures: { evidence_source_snapshots: "throw" } });
    await expect(fetchSavedCopy(offline.client, USER, STUDY, info(), signal)).rejects.toMatchObject({ kind: "transport", transient: true });
  });
});
