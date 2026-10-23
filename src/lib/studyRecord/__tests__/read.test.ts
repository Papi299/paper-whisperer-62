import { describe, expect, it } from "vitest";
import { toStudyId } from "@/lib/evidence/ids";
import { fetchStudyRecord, readAllPages, readFailure, StudyRecordReadError, READ_PAGE_SIZE } from "../read";
import { fakeSupabase, missingTableError } from "./fakeSupabase";
import {
  ABSTRACT,
  ARM_COMPARATOR,
  ARM_INTERVENTION,
  assemble,
  fullRows,
  OTHER_USER,
  PAPER_ID,
  PAPER_TITLE,
  quoteAnchorRow,
  reportRow,
  SECOND_PAPER_ID,
  snapshotRow,
  STUDY_ID,
  USER,
  uuid,
  valueRow,
  type FixtureRows,
} from "./fixtures";

/**
 * Reading one study record (EVIDENCE-RECORDS-001C1): owner-scoped SELECTs,
 * read in pages, mapped by PR-B and cross-checked — a refusal or a malformed
 * answer is an error, never "no record".
 */

const signal = new AbortController().signal;
const STUDY = toStudyId(STUDY_ID)!;

function tablesOf(rows: FixtureRows, papers = [{ id: PAPER_ID, user_id: USER, title: PAPER_TITLE }]) {
  return {
    evidence_studies: rows.study ? [rows.study] : [],
    evidence_study_reports: rows.reports,
    evidence_source_snapshots: rows.snapshots,
    evidence_arms: rows.arms,
    evidence_outcomes: rows.outcomes,
    evidence_field_values: rows.values,
    evidence_field_anchors: rows.anchors,
    papers,
  } as Record<string, Record<string, unknown>[]>;
}

describe("fetchStudyRecord", () => {
  it("reads and assembles the record exactly as the fixture assembles it", async () => {
    const { client } = fakeSupabase({ tables: tablesOf(fullRows()) });
    const record = await fetchStudyRecord(client, USER, STUDY, signal);
    expect(record).toEqual(assemble());
    expect(record?.links[0].currentCopy?.exactText).toBe(ABSTRACT);
    expect(record?.links[0].paperTitle).toBe(PAPER_TITLE);
    expect(record?.arms.map((arm) => arm.id)).toEqual([ARM_INTERVENTION, ARM_COMPARATOR]);
  });

  it("names the user in every query, and the study in every evidence query", async () => {
    const { client, requests } = fakeSupabase({ tables: tablesOf(fullRows()) });
    await fetchStudyRecord(client, USER, STUDY, signal);
    for (const request of requests) {
      expect(request.eq, request.table).toContainEqual(["user_id", USER]);
      expect(request.signal, request.table).toBe(true);
      if (request.table === "evidence_studies") expect(request.eq).toContainEqual(["id", STUDY_ID]);
      else if (request.table !== "papers") expect(request.eq).toContainEqual(["study_id", STUDY_ID]);
    }
  });

  it("reads the text of the current copy only; earlier copies are metadata", async () => {
    const rows = fullRows();
    const older = snapshotRow({ id: uuid("c", 9), seq: 1, exact_text: "Old abstract text.", char_count: 18 });
    rows.snapshots = [older, snapshotRow({ seq: 2 })];
    const { client, requests } = fakeSupabase({ tables: tablesOf(rows) });
    const record = await fetchStudyRecord(client, USER, STUDY, signal);
    expect(record?.links[0].snapshots.map((s) => s.seq)).toEqual([1, 2]);
    expect(record?.links[0].currentCopy?.seq).toBe(2);
    const textReads = requests.filter((r) => r.table === "evidence_source_snapshots" && r.columns.includes("exact_text"));
    expect(textReads).toHaveLength(1);
    expect(textReads[0].in).toEqual([["id", [rows.snapshots[1].id]]]);
  });

  it("resolves to null when the study does not exist for this user", async () => {
    const rows = fullRows();
    const { client } = fakeSupabase({ tables: tablesOf({ ...rows, study: null, reports: [], snapshots: [], arms: [], outcomes: [], values: [], anchors: [] }) });
    expect(await fetchStudyRecord(client, USER, STUDY, signal)).toBeNull();
  });

  it("is an error, never an empty record, when a read is refused", async () => {
    const { client } = fakeSupabase({
      tables: tablesOf(fullRows()),
      failures: { evidence_field_values: { error: { code: "42501", message: "permission denied for table evidence_field_values" }, status: 403 } },
    });
    await expect(fetchStudyRecord(client, USER, STUDY, signal)).rejects.toMatchObject({ name: "StudyRecordReadError", kind: "transport", transient: false });
  });

  it("is a transient error when the network fails", async () => {
    const { client } = fakeSupabase({ tables: tablesOf(fullRows()), failures: { evidence_arms: "throw" } });
    await expect(fetchStudyRecord(client, USER, STUDY, signal)).rejects.toMatchObject({ kind: "transport", transient: true });
  });

  it("never puts content, ids or SQL in an error message", async () => {
    const { client } = fakeSupabase({
      tables: tablesOf(fullRows()),
      failures: { evidence_studies: { error: { code: "XX000", message: `secret ${STUDY_ID} select * from evidence_studies` }, status: 500 } },
    });
    const error = await fetchStudyRecord(client, USER, STUDY, signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudyRecordReadError);
    expect((error as Error).message).toBe("study record read failed");
  });
});

describe("assembled record integrity", () => {
  const fails = (mutate: (rows: FixtureRows) => void) => {
    const rows = fullRows();
    mutate(rows);
    expect(() => assemble(rows)).toThrow(expect.objectContaining({ kind: "integrity" }));
  };

  it("refuses a row of another user", () => {
    fails((rows) => (rows.values[0] = valueRow({ user_id: OTHER_USER })));
    fails((rows) => (rows.arms[0] = { ...rows.arms[0], user_id: OTHER_USER }));
  });

  it("refuses a value on a group the study does not have", () => {
    fails((rows) => (rows.values[1] = { ...rows.values[1], arm_id: uuid("d", 99) }));
  });

  it("refuses a reference to a paper the study is not linked to", () => {
    fails((rows) => (rows.anchors[0] = quoteAnchorRow({ paper_id: SECOND_PAPER_ID })));
  });

  it("refuses a reference whose copy belongs to another linked paper", () => {
    fails((rows) => {
      rows.reports.push(reportRow({ id: uuid("b", 2), paper_id: SECOND_PAPER_ID }));
      rows.snapshots.push(snapshotRow({ id: uuid("c", 2), paper_id: SECOND_PAPER_ID }));
      rows.anchors[0] = quoteAnchorRow({ snapshot_id: uuid("c", 2) });
    });
  });

  it("refuses two values for one field of one target", () => {
    fails((rows) => rows.values.push(valueRow({ id: uuid("f", 50) })));
  });

  it("refuses two copies with one sequence number, and a malformed copy", () => {
    fails((rows) => rows.snapshots.push(snapshotRow({ id: uuid("c", 5) })));
    fails((rows) => (rows.snapshots[0] = snapshotRow({ char_count: 3 })));
  });

  it("refuses a study row that is not this study", () => {
    fails((rows) => (rows.study = { ...rows.study!, id: uuid("5", 2) }));
  });

  it("keeps a missing paper title as unknown rather than failing", () => {
    expect(assemble(fullRows(), null).links[0].paperTitle).toBeNull();
  });
});

describe("readAllPages", () => {
  it("reads until a short page, so 1,000 rows are never mistaken for all of them", async () => {
    const total = READ_PAGE_SIZE * 2 + 1;
    const calls: [number, number][] = [];
    const rows = await readAllPages<number>(async (from, to) => {
      calls.push([from, to]);
      return { data: Array.from({ length: Math.max(0, Math.min(to + 1, total) - from) }, (_, i) => from + i), error: null };
    });
    expect(rows).toHaveLength(total);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("asks once more after an exactly full page", async () => {
    let calls = 0;
    const rows = await readAllPages<number>(async (from) => {
      calls += 1;
      return { data: from === 0 ? Array.from({ length: READ_PAGE_SIZE }, (_, i) => i) : [], error: null };
    });
    expect(rows).toHaveLength(READ_PAGE_SIZE);
    expect(calls).toBe(2);
  });

  it("refuses a malformed answer", async () => {
    await expect(readAllPages(async () => ({ data: { not: "rows" }, error: null }))).rejects.toMatchObject({ kind: "integrity" });
  });

  it("recognizes a missing evidence table only for the table it names", async () => {
    const error = missingTableError("evidence_study_reports");
    await expect(readAllPages(async () => ({ data: null, error, status: 404 }), "evidence_study_reports")).rejects.toMatchObject({ kind: "missing_schema" });
    await expect(readAllPages(async () => ({ data: null, error, status: 404 }), "evidence_studies")).rejects.toMatchObject({ kind: "transport" });
    await expect(readAllPages(async () => ({ data: null, error, status: 404 }))).rejects.toMatchObject({ kind: "transport" });
  });
});

describe("readFailure", () => {
  it.each([
    [{ message: "fetch failed" }, null, true],
    [{ code: "PGRST000", message: "x" }, 503, true],
    [{ code: "57014", message: "x" }, 500, true],
    [{ code: "XX", message: "x" }, 429, true],
    [{ code: "42501", message: "x" }, 403, false],
    [{ code: "PGRST116", message: "x" }, 406, false],
  ])("%j with status %s is transient: %s", (error, status, transient) => {
    expect(readFailure(error, status)).toMatchObject({ kind: "transport", transient });
  });
});
