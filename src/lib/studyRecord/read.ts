/**
 * Reading one study record (EVIDENCE-RECORDS-001C1).
 *
 * Plain SELECTs on the eight evidence tables under their owner-only RLS
 * policies — no RPC, view, Edge Function or write. Every query also names the
 * caller (`.eq("user_id", …)`, the S2 defense in depth) and the study, so a
 * loosened policy could still not widen it. PostgREST answers at most 1,000
 * rows per request, so every table is read in pages until a short page; a
 * truncated read can never pass for a complete one.
 *
 * Saved abstract copies can be long (up to 50,000 characters, up to 20 per
 * link), and the editor needs the text of each link's CURRENT copy only — the
 * one new quotes must name. Superseded copies are read as metadata: their ids
 * and sequence numbers are what a kept reference is checked against. The text
 * of an earlier copy is read only when the user asks to see it, one copy at a
 * time (`fetchSavedCopy`, EVIDENCE-RECORDS-001C2C-A), and so is the library
 * abstract a link's copy is compared with (`fetchLinkedPaperAbstract`).
 *
 * Nothing is trusted. Every row is mapped by the PR-B mappers
 * (`src/lib/evidence/records.ts`), which fail closed, and then checked against
 * the rest of the record: it belongs to this user and this study, a value
 * names one of the study's groups or outcomes, a reference names one of the
 * study's linked papers and one of that link's copies. Any failure is a
 * `StudyRecordReadError` of kind `integrity`, and nothing of the record is
 * shown. Error messages carry no content, ids or SQL.
 */

import type { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { isEvidenceRecordsTableMissing, type EvidenceRecordsTable } from "@/lib/evidenceRecordsAvailability";
import { FIELD_KEYS } from "@/lib/evidence/fieldDictionary";
import { toPaperId, toSnapshotId, type PaperId, type SnapshotId, type StudyId } from "@/lib/evidence/ids";
import { findPostgresTextProblem } from "@/lib/evidence/normalization";
import {
  mapArmRow,
  mapFieldAnchorRow,
  mapFieldValueRow,
  mapOutcomeRow,
  mapSourceSnapshotRow,
  mapStudyReportRow,
  mapStudyRow,
} from "@/lib/evidence/records";
import type {
  Arm,
  Outcome,
  RecordedValue,
  SourceSnapshot,
  StoredReference,
  StudyHeader,
  StudyReportLink,
} from "@/lib/evidence/types";

export type StudyRecordClient = typeof supabase;
type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

/** PostgREST's default `max_rows`: a page this long may not be the last. */
export const READ_PAGE_SIZE = 1000;

/** Why a study record could not be shown. The message never carries content. */
export class StudyRecordReadError extends Error {
  constructor(
    /**
     * `transport` — the read failed; `integrity` — the answer did not pass a
     * consistency check; `missing_schema` — the evidence tables do not exist in
     * this environment (only ever reported for a table the caller named).
     */
    readonly kind: "transport" | "integrity" | "missing_schema",
    /** Whether trying again could help. */
    readonly transient: boolean,
  ) {
    super(
      kind === "integrity"
        ? "study record failed an integrity check"
        : kind === "missing_schema"
          ? "study records are not installed"
          : "study record read failed",
    );
    this.name = "StudyRecordReadError";
  }
}

const integrity = () => new StudyRecordReadError("integrity", false);

/**
 * A PostgREST failure: transient when no answer came back, or the server was
 * unavailable or busy. When `table` is named, an error saying that table does
 * not exist is `missing_schema` — and nothing else is (a permission or RLS
 * failure stays a real failure).
 */
export function readFailure(error: unknown, status: number | null | undefined, table?: EvidenceRecordsTable): StudyRecordReadError {
  if (table && isEvidenceRecordsTableMissing(error, table)) return new StudyRecordReadError("missing_schema", false);
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const httpStatus = typeof status === "number" ? status : 0;
  const transient = !code || httpStatus === 0 || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
  return new StudyRecordReadError("transport", transient);
}

interface PageResponse {
  readonly data: unknown;
  readonly error: unknown;
  readonly status?: number;
}

/**
 * Every row of a paged read, in the query's order. `page(from, to)` builds one
 * request. `table` lets a missing evidence table be told apart (see `readFailure`).
 */
export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResponse>,
  table?: EvidenceRecordsTable,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += READ_PAGE_SIZE) {
    let response: PageResponse;
    try {
      response = await page(from, from + READ_PAGE_SIZE - 1);
    } catch {
      throw new StudyRecordReadError("transport", true);
    }
    if (response.error) throw readFailure(response.error, response.status, table);
    if (!Array.isArray(response.data)) throw integrity();
    rows.push(...(response.data as T[]));
    if (response.data.length < READ_PAGE_SIZE) return rows;
  }
}

/** One copy of a link's abstract, without its text. */
export interface SnapshotInfo {
  readonly id: SnapshotId;
  readonly paperId: PaperId;
  readonly seq: number;
  readonly capturedAt: string;
  readonly charCount: number;
}

/** One paper this study is linked to, with its saved copies. */
export interface StudyRecordLink {
  readonly link: StudyReportLink;
  /** The paper's title in the library, or null when the paper could not be read. */
  readonly paperTitle: string | null;
  /** Every copy of this link, oldest first. */
  readonly snapshots: readonly SnapshotInfo[];
  /** The highest-`seq` copy, with its text; null when the link has no copy. */
  readonly currentCopy: SourceSnapshot | null;
}

export interface StudyRecordData {
  readonly header: StudyHeader;
  /** In the order the links were created. */
  readonly links: readonly StudyRecordLink[];
  /** By position. */
  readonly arms: readonly Arm[];
  readonly outcomes: readonly Outcome[];
  readonly values: readonly RecordedValue[];
}

const STUDY_COLUMNS = "id, user_id, label, design_profile, notes, row_version, created_at, updated_at";
const REPORT_COLUMNS = "id, user_id, study_id, paper_id, link_status, link_basis, created_at, updated_at";
const SNAPSHOT_INFO_COLUMNS = "id, user_id, study_id, paper_id, seq, source_kind, char_count, normalization_version, captured_at";
const SNAPSHOT_COLUMNS =
  "id, user_id, study_id, paper_id, seq, source_kind, exact_text, exact_sha256, normalized_sha256, normalization_version, char_count, captured_at";
const ARM_COLUMNS = "id, user_id, study_id, arm_role, display_label, position, created_at, updated_at";
const OUTCOME_COLUMNS = "id, user_id, study_id, display_label, position, created_at, updated_at";
const VALUE_COLUMNS =
  "id, user_id, study_id, arm_id, outcome_id, field_key, value_state, state_reason, value_text, value_code, value_int, value_list, note, " +
  "extraction_method, review_status, review_reason, review_note, reviewed_at, reviewed_version, value_version, created_at, updated_at";
const ANCHOR_COLUMNS =
  "id, user_id, study_id, value_id, paper_id, snapshot_id, purpose, source_kind, position, quote_text, match_start, match_end, " +
  "match_occurrence, match_count, normalization_version, matched_at, locator_kind, locator_text, created_at";

type SnapshotInfoRow = Pick<Row<"evidence_source_snapshots">, "id" | "user_id" | "study_id" | "paper_id" | "seq" | "source_kind" | "char_count" | "normalization_version" | "captured_at">;

/** The rows of one study's tables, as read. */
interface StudyRows {
  readonly study: Row<"evidence_studies"> | null;
  readonly reports: Row<"evidence_study_reports">[];
  readonly snapshots: SnapshotInfoRow[];
  readonly arms: Row<"evidence_arms">[];
  readonly outcomes: Row<"evidence_outcomes">[];
  readonly values: Row<"evidence_field_values">[];
  readonly anchors: Row<"evidence_field_anchors">[];
}

/** Ids for `.in()` lists: at most this many per request keeps a URL well under any proxy limit. */
export const IN_LIST_CHUNK = 100;

export function chunk<T>(items: readonly T[], size = IN_LIST_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Read one study record of `userId`. Resolves to null when the study does not
 * exist for this user (deleted, or never theirs — the two are not told apart).
 */
export async function fetchStudyRecord(
  client: StudyRecordClient,
  userId: string,
  studyId: StudyId,
  signal: AbortSignal,
): Promise<StudyRecordData | null> {
  type StudyChildTable =
    | "evidence_study_reports"
    | "evidence_source_snapshots"
    | "evidence_arms"
    | "evidence_outcomes"
    | "evidence_field_values"
    | "evidence_field_anchors";
  const scoped = <T>(table: StudyChildTable, columns: string, order: readonly string[]) =>
    readAllPages<T>((from, to) => {
      let query = client.from(table).select(columns).eq("user_id", userId).eq("study_id", studyId);
      for (const column of order) query = query.order(column, { ascending: true });
      return query.range(from, to).abortSignal(signal);
    });

  const studyRead = (async () => {
    let response: PageResponse;
    try {
      response = await client.from("evidence_studies").select(STUDY_COLUMNS).eq("user_id", userId).eq("id", studyId).abortSignal(signal);
    } catch {
      throw new StudyRecordReadError("transport", true);
    }
    if (response.error) throw readFailure(response.error, response.status);
    if (!Array.isArray(response.data) || response.data.length > 1) throw integrity();
    return (response.data[0] as Row<"evidence_studies"> | undefined) ?? null;
  })();

  const [study, reports, snapshots, arms, outcomes, values, anchors] = await Promise.all([
    studyRead,
    scoped<Row<"evidence_study_reports">>("evidence_study_reports", REPORT_COLUMNS, ["created_at", "id"]),
    scoped<SnapshotInfoRow>("evidence_source_snapshots", SNAPSHOT_INFO_COLUMNS, ["paper_id", "seq"]),
    scoped<Row<"evidence_arms">>("evidence_arms", ARM_COLUMNS, ["position", "id"]),
    scoped<Row<"evidence_outcomes">>("evidence_outcomes", OUTCOME_COLUMNS, ["position", "id"]),
    scoped<Row<"evidence_field_values">>("evidence_field_values", VALUE_COLUMNS, ["id"]),
    scoped<Row<"evidence_field_anchors">>("evidence_field_anchors", ANCHOR_COLUMNS, ["id"]),
  ]);
  if (study === null) return null;

  const rows: StudyRows = { study, reports, snapshots, arms, outcomes, values, anchors };
  const currentIds = currentSnapshotIds(userId, studyId, rows);
  const paperIds = [...new Set(reports.map((report) => report.paper_id))];

  const [copies, papers] = await Promise.all([
    Promise.all(
      chunk(currentIds).map((ids) =>
        readAllPages<Row<"evidence_source_snapshots">>((from, to) =>
          client
            .from("evidence_source_snapshots")
            .select(SNAPSHOT_COLUMNS)
            .eq("user_id", userId)
            .eq("study_id", studyId)
            .in("id", ids)
            .order("id", { ascending: true })
            .range(from, to)
            .abortSignal(signal),
        ),
      ),
    ).then((parts) => parts.flat()),
    Promise.all(
      chunk(paperIds).map((ids) =>
        readAllPages<Pick<Row<"papers">, "id" | "user_id" | "title">>((from, to) =>
          client
            .from("papers")
            .select("id, user_id, title")
            .eq("user_id", userId)
            .in("id", ids)
            .order("id", { ascending: true })
            .range(from, to)
            .abortSignal(signal),
        ),
      ),
    ).then((parts) => parts.flat()),
  ]);

  return assembleStudyRecord(userId, studyId, rows, copies, papers);
}

/** The id of each link's highest-`seq` copy. Checks the copy rows on the way. */
function currentSnapshotIds(userId: string, studyId: string, rows: StudyRows): string[] {
  const linked = new Set(rows.reports.map((report) => report.paper_id));
  const highest = new Map<string, SnapshotInfoRow>();
  const seen = new Set<string>();
  for (const row of rows.snapshots) {
    if (row.user_id !== userId || row.study_id !== studyId || !linked.has(row.paper_id)) throw integrity();
    if (!toSnapshotId(row.id) || seen.has(row.id) || !Number.isInteger(row.seq) || row.seq < 1) throw integrity();
    seen.add(row.id);
    const current = highest.get(row.paper_id);
    if (current && current.seq === row.seq) throw integrity();
    if (!current || row.seq > current.seq) highest.set(row.paper_id, row);
  }
  return [...highest.values()].map((row) => row.id);
}

/**
 * Map and cross-check the rows of one study. Exported for its tests; every
 * caller goes through `fetchStudyRecord`.
 */
export function assembleStudyRecord(
  userId: string,
  studyId: string,
  rows: StudyRows,
  copies: readonly Row<"evidence_source_snapshots">[],
  papers: readonly Pick<Row<"papers">, "id" | "user_id" | "title">[],
): StudyRecordData {
  const { study } = rows;
  if (!study || study.user_id !== userId || study.id !== studyId) throw integrity();
  const header = mapStudyRow(study);
  if (!header.ok) throw integrity();

  const owned = <R extends { user_id: string; study_id: string }>(row: R) => row.user_id === userId && row.study_id === studyId;

  // Links: one per paper (evidence_study_reports_link_key).
  const links = new Map<PaperId, StudyReportLink>();
  for (const row of rows.reports) {
    const mapped = mapStudyReportRow(row);
    if (!owned(row) || !mapped.ok || links.has(mapped.value.paperId)) throw integrity();
    links.set(mapped.value.paperId, mapped.value);
  }

  // Copies, per link, oldest first. `currentSnapshotIds` already checked them.
  const snapshotsByPaper = new Map<PaperId, SnapshotInfo[]>();
  const snapshotPaper = new Map<string, PaperId>();
  for (const row of rows.snapshots) {
    const paperId = toPaperId(row.paper_id);
    const id = toSnapshotId(row.id);
    if (!paperId || !id || !links.has(paperId) || typeof row.captured_at !== "string" || !Number.isInteger(row.char_count)) throw integrity();
    const list = snapshotsByPaper.get(paperId) ?? [];
    list.push(Object.freeze({ id, paperId, seq: row.seq, capturedAt: row.captured_at, charCount: row.char_count }));
    snapshotsByPaper.set(paperId, list);
    snapshotPaper.set(id, paperId);
  }
  for (const list of snapshotsByPaper.values()) list.sort((a, b) => a.seq - b.seq);

  const currentByPaper = new Map<PaperId, SourceSnapshot>();
  for (const row of copies) {
    const mapped = mapSourceSnapshotRow(row);
    if (row.user_id !== userId || !mapped.ok) throw integrity();
    const list = snapshotsByPaper.get(mapped.value.paperId);
    const newest = list?.[list.length - 1];
    if (!newest || newest.id !== mapped.value.id || newest.seq !== mapped.value.seq || currentByPaper.has(mapped.value.paperId)) throw integrity();
    currentByPaper.set(mapped.value.paperId, mapped.value);
  }
  for (const [paperId, list] of snapshotsByPaper) {
    if (list.length > 0 && !currentByPaper.has(paperId)) throw integrity();
  }

  const titles = new Map<string, string>();
  for (const paper of papers) {
    if (paper.user_id !== userId || typeof paper.title !== "string") throw integrity();
    titles.set(paper.id, paper.title);
  }

  const arms: Arm[] = rows.arms.map((row) => {
    const mapped = mapArmRow(row);
    if (!owned(row) || !mapped.ok) throw integrity();
    return mapped.value;
  });
  const outcomes: Outcome[] = rows.outcomes.map((row) => {
    const mapped = mapOutcomeRow(row);
    if (!owned(row) || !mapped.ok) throw integrity();
    return mapped.value;
  });
  const armIds = new Set<string>(arms.map((arm) => arm.id));
  const outcomeIds = new Set<string>(outcomes.map((outcome) => outcome.id));
  if (armIds.size !== arms.length || outcomeIds.size !== outcomes.length) throw integrity();

  // References, grouped by value: supporting ones by position, then the
  // assessments in a fixed order.
  const valueIds = new Set(rows.values.map((row) => row.id));
  const referencesByValue = new Map<string, StoredReference[]>();
  for (const row of rows.anchors) {
    const mapped = mapFieldAnchorRow(row);
    if (!owned(row) || !mapped.ok || !valueIds.has(mapped.value.valueId)) throw integrity();
    const reference = mapped.value.reference;
    if (!links.has(reference.paperId)) throw integrity();
    if ("snapshotId" in reference && snapshotPaper.get(reference.snapshotId) !== reference.paperId) throw integrity();
    const list = referencesByValue.get(mapped.value.valueId) ?? [];
    list.push(reference);
    referencesByValue.set(mapped.value.valueId, list);
  }

  const values: RecordedValue[] = rows.values.map((row) => {
    const references = (referencesByValue.get(row.id) ?? []).sort(compareReferences);
    const mapped = mapFieldValueRow(row, references);
    if (!owned(row) || !mapped.ok) throw integrity();
    const { target } = mapped.value;
    if (target.scope === "arm" && !armIds.has(target.armId)) throw integrity();
    if (target.scope === "outcome" && !outcomeIds.has(target.outcomeId)) throw integrity();
    return mapped.value;
  });
  const valueKeys = new Set(values.map((value) => `${targetIdOf(value)}|${value.fieldKey}`));
  if (valueKeys.size !== values.length) throw integrity();

  const orderedLinks = [...links.values()].map(
    (link): StudyRecordLink =>
      Object.freeze({
        link,
        paperTitle: titles.get(link.paperId) ?? null,
        snapshots: Object.freeze(snapshotsByPaper.get(link.paperId) ?? []),
        currentCopy: currentByPaper.get(link.paperId) ?? null,
      }),
  );

  return Object.freeze({
    header: header.value,
    links: Object.freeze(orderedLinks),
    arms: Object.freeze([...arms].sort(byPosition)),
    outcomes: Object.freeze([...outcomes].sort(byPosition)),
    values: Object.freeze([...values].sort((a, b) => FIELD_KEYS.indexOf(a.fieldKey) - FIELD_KEYS.indexOf(b.fieldKey))),
  });
}

function byPosition<T extends { position: number; id: string }>(a: T, b: T): number {
  return a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const PURPOSE_ORDER = { supports: 0, examined: 1, unavailable: 2 } as const;
const KIND_ORDER = { abstract: 0, full_text: 1 } as const;

function compareReferences(a: StoredReference, b: StoredReference): number {
  const byPurpose = PURPOSE_ORDER[a.purpose] - PURPOSE_ORDER[b.purpose];
  if (byPurpose !== 0) return byPurpose;
  if (a.purpose === "supports" && b.purpose === "supports") return a.position - b.position;
  return KIND_ORDER[a.sourceKind] - KIND_ORDER[b.sourceKind] || (a.paperId < b.paperId ? -1 : a.paperId > b.paperId ? 1 : 0);
}

/** The abstract one linked paper has in the library now (EVIDENCE-RECORDS-001C2C-A). */
export interface LibraryAbstract {
  readonly paperId: PaperId;
  /** Null when the paper has no abstract. */
  readonly abstract: string | null;
}

/** One paper's id, owner and abstract — nothing else of the paper. */
const LIBRARY_ABSTRACT_COLUMNS = "id, user_id, abstract";

/**
 * The library abstract of `paperId`, as it is now, for comparing with a saved
 * copy (EVIDENCE-RECORDS-001C2C-A). One owner-scoped SELECT of one paper, by
 * id. Resolves to null when this user has no such paper — a linked paper
 * cannot be deleted (the link's foreign key refuses it), so null means it
 * could not be read, never that its abstract was removed. Informational: the
 * text can change the moment after it is read, and nothing is decided by it.
 */
export async function fetchLinkedPaperAbstract(
  client: StudyRecordClient,
  userId: string,
  paperId: PaperId,
  signal: AbortSignal,
): Promise<LibraryAbstract | null> {
  let response: PageResponse;
  try {
    response = await client.from("papers").select(LIBRARY_ABSTRACT_COLUMNS).eq("user_id", userId).eq("id", paperId).abortSignal(signal);
  } catch {
    throw new StudyRecordReadError("transport", true);
  }
  if (response.error) throw readFailure(response.error, response.status);
  if (!Array.isArray(response.data) || response.data.length > 1) throw integrity();
  const row = response.data[0] as Pick<Row<"papers">, "id" | "user_id" | "abstract"> | undefined;
  if (!row) return null;
  if (row.user_id !== userId || row.id !== paperId) throw integrity();
  const { abstract } = row;
  // Text no PostgreSQL value can hold is not an abstract from the database.
  if (abstract !== null && (typeof abstract !== "string" || findPostgresTextProblem(abstract) !== null)) throw integrity();
  return Object.freeze({ paperId, abstract });
}

/**
 * The text of one saved copy of a link's abstract — any copy, the current one
 * or an earlier one — read when the user asks to see it
 * (EVIDENCE-RECORDS-001C2C-A). One SELECT naming the user, the study, the
 * paper and the copy; the answer must be exactly the copy `expected`
 * describes, as the record already loaded it — same paper, sequence number,
 * capture time and length — or it is an integrity failure. Resolves to null
 * when the copy no longer exists (its link or study was removed since the
 * record was read).
 */
export async function fetchSavedCopy(
  client: StudyRecordClient,
  userId: string,
  studyId: StudyId,
  expected: SnapshotInfo,
  signal: AbortSignal,
): Promise<SourceSnapshot | null> {
  let response: PageResponse;
  try {
    response = await client
      .from("evidence_source_snapshots")
      .select(SNAPSHOT_COLUMNS)
      .eq("user_id", userId)
      .eq("study_id", studyId)
      .eq("paper_id", expected.paperId)
      .eq("id", expected.id)
      .abortSignal(signal);
  } catch {
    throw new StudyRecordReadError("transport", true);
  }
  if (response.error) throw readFailure(response.error, response.status, "evidence_source_snapshots");
  if (!Array.isArray(response.data) || response.data.length > 1) throw integrity();
  const row = response.data[0] as Row<"evidence_source_snapshots"> | undefined;
  if (!row) return null;
  const mapped = mapSourceSnapshotRow(row);
  if (row.user_id !== userId || !mapped.ok) throw integrity();
  const copy = mapped.value;
  if (
    copy.studyId !== studyId ||
    copy.paperId !== expected.paperId ||
    copy.id !== expected.id ||
    copy.seq !== expected.seq ||
    copy.capturedAt !== expected.capturedAt ||
    copy.charCount !== expected.charCount
  ) {
    throw integrity();
  }
  return copy;
}

/** "study", or the group or outcome id a value describes. */
export function targetIdOf(value: Pick<RecordedValue, "target">): string {
  const { target } = value;
  return target.scope === "study" ? "study" : target.scope === "arm" ? `arm:${target.armId}` : `outcome:${target.outcomeId}`;
}
