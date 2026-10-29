/**
 * Reading one study record's history (EVIDENCE-RECORDS-001C2B).
 *
 * Plain SELECTs on `evidence_events` under its owner-only RLS policy — no RPC,
 * view, Edge Function or write — and, only to tell an empty answer apart, one
 * on `evidence_studies`. Like `read.ts`, every query also names the caller and
 * the study (`.eq("user_id", …)`, `.eq("study_id", …)`), so a loosened policy
 * could still not widen it. This is the one module that reads history; the UI
 * boundary (`src/test/studyRecordUiBoundary.test.ts`) refuses it anywhere else.
 *
 * PAGED BY COMMITTED OPERATION. A committed request wrote one header (ordinal
 * 0) and its change events (ordinals 1..n), all at the study version it
 * produced (PR-A2 §HISTORY). So:
 *   * a page of operations is a page of headers, newest first:
 *     `study_version < cursor`, by `study_version` descending, with one row of
 *     look-ahead to say whether older ones exist. The cursor is a version, never
 *     an offset, so a request committed while History is open can neither
 *     repeat nor push out an older operation; it appears when the first page is
 *     read again;
 *   * one operation's changes are read only when it is opened — the same user,
 *     study and version, `ordinal > cursor`, by ordinal — in pages with the same
 *     look-ahead, so a large save is shown in parts and never cut short.
 * The unique key `(user_id, study_id, study_version, ordinal)` serves both.
 *
 * AN EXPLICIT, MINIMAL PROJECTION. A header gives its version, operation and
 * time. Never `payload_sha256` or `result`, which exist for request
 * idempotency, and never `note`. Its `request_id` is read only to check that
 * every change shown under it belongs to it, and is never shown; `user_id`
 * only to check the row is the caller's. A change event adds its target, field
 * and before/after digests — bounded, text-free records (PR-A3
 * `evidence_value_digest`) that `historyModel.ts` interprets.
 *
 * NOTHING IS TRUSTED. Rows are mapped by PR-B's `mapEventRow`, which fails
 * closed, and then checked: the caller's and this study's rows only; headers at
 * ordinal 0, strictly older than the cursor and strictly descending; changes at
 * the operation's own version and request id, numbered from the cursor without
 * a gap. Any failure is a `StudyRecordReadError` of kind `integrity`. Messages
 * carry no content, ids or SQL.
 *
 * GONE. Every study has history from its creation, and events leave only with
 * their study (PR-A2 `evidence_delete_study`). So a read that finds nothing
 * where something must be asks whether the study still exists: if not, the
 * answer is `{ kind: "gone" }` — deleted, or never this user's; the two are not
 * told apart. If it does, an empty first page is reported as it is, and any
 * other empty answer is an integrity failure.
 */

import { MAX_POSTGRES_INTEGER, toRequestId, toStudyVersion, type EventId, type RequestId, type StudyId, type StudyVersion } from "@/lib/evidence/ids";
import { mapEventRow, type HistoryEventRow } from "@/lib/evidence/records";
import type { HistoryEvent, RequestOp } from "@/lib/evidence/types";
import { readFailure, StudyRecordReadError, type StudyRecordClient } from "./read";

/** Committed operations per page. */
export const HISTORY_PAGE_SIZE = 10;
/** Change events per page of one operation. A save can hold up to 200 changes. */
export const HISTORY_CHANGES_PAGE_SIZE = 50;

const HEADER_COLUMNS = "id, user_id, study_id, study_version, ordinal, event_type, request_id, op, occurred_at";
const CHANGE_COLUMNS = "id, user_id, study_id, study_version, ordinal, event_type, request_id, op, target_id, field_key, before, after, occurred_at";

type HeaderRow = Omit<HistoryEventRow, "target_id" | "field_key" | "before" | "after"> & { readonly user_id: string };
type ChangeRow = HistoryEventRow & { readonly user_id: string };

interface Response {
  readonly data: unknown;
  readonly error: unknown;
  readonly status?: number;
}

/** One committed request, as History lists it. */
export interface HistoryOperation {
  readonly id: EventId;
  /** The study version the request produced: its place in History, and the cursor. */
  readonly studyVersion: StudyVersion;
  readonly op: RequestOp;
  readonly occurredAt: string;
  /** Checked against every change shown under this operation; never shown. */
  readonly requestId: RequestId;
}

export type HistoryPageRead =
  /** Newest first. `olderThan` is the cursor for the next page; null when there is none. */
  | { readonly kind: "page"; readonly operations: readonly HistoryOperation[]; readonly olderThan: StudyVersion | null }
  /** The study does not exist for this user. */
  | { readonly kind: "gone" };

export type HistoryChangesRead =
  /** In ordinal order. `after` is the cursor for the next page; null when there is none. */
  | { readonly kind: "page"; readonly changes: readonly HistoryEvent[]; readonly after: number | null }
  | { readonly kind: "gone" };

const integrity = () => new StudyRecordReadError("integrity", false);

async function send(request: () => PromiseLike<Response>): Promise<unknown[]> {
  let response: Response;
  try {
    response = await request();
  } catch {
    throw new StudyRecordReadError("transport", true);
  }
  if (response.error) throw readFailure(response.error, response.status, "evidence_events");
  if (!Array.isArray(response.data)) throw integrity();
  return response.data;
}

/** Whether the study exists for this user — asked only to explain an empty answer. */
async function studyExists(client: StudyRecordClient, userId: string, studyId: StudyId, signal: AbortSignal): Promise<boolean> {
  let response: Response;
  try {
    response = await client.from("evidence_studies").select("id, user_id").eq("user_id", userId).eq("id", studyId).abortSignal(signal);
  } catch {
    throw new StudyRecordReadError("transport", true);
  }
  if (response.error) throw readFailure(response.error, response.status, "evidence_studies");
  if (!Array.isArray(response.data) || response.data.length > 1) throw integrity();
  const row = response.data[0] as { id?: unknown; user_id?: unknown } | undefined;
  if (row && (row.id !== studyId || row.user_id !== userId)) throw integrity();
  return row !== undefined;
}

/**
 * One page of `studyId`'s committed operations, newest first: those older than
 * `olderThan`, or the newest when it is null.
 */
export async function fetchHistoryPage(
  client: StudyRecordClient,
  userId: string,
  studyId: StudyId,
  olderThan: StudyVersion | null,
  signal: AbortSignal,
): Promise<HistoryPageRead> {
  // The cursor is checked before any query is built from it.
  if (olderThan !== null && toStudyVersion(olderThan) === null) throw integrity();
  const rows = await send(() => {
    let query = client.from("evidence_events").select(HEADER_COLUMNS).eq("user_id", userId).eq("study_id", studyId).eq("ordinal", 0);
    if (olderThan !== null) query = query.lt("study_version", olderThan);
    return query.order("study_version", { ascending: false }).limit(HISTORY_PAGE_SIZE + 1).abortSignal(signal);
  });
  if (rows.length > HISTORY_PAGE_SIZE + 1) throw integrity();

  if (rows.length === 0) {
    const exists = await studyExists(client, userId, studyId, signal);
    if (!exists) return { kind: "gone" };
    // A first page may be empty; an older page was asked for because a row was there.
    if (olderThan !== null) throw integrity();
    return { kind: "page", operations: Object.freeze([]), olderThan: null };
  }

  const operations: HistoryOperation[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") throw integrity();
    const row = raw as HeaderRow;
    if (row.user_id !== userId) throw integrity();
    // A header carries no change (`evidence_events_header_shape_check`), so those columns are not read.
    const mapped = mapEventRow({ ...row, target_id: null, field_key: null, before: null, after: null });
    if (!mapped.ok) throw integrity();
    const event = mapped.value;
    if (event.studyId !== studyId || event.ordinal !== 0 || event.op === null || Number.isNaN(Date.parse(event.occurredAt))) throw integrity();
    const newer = operations.length > 0 ? operations[operations.length - 1].studyVersion : olderThan;
    if (newer !== null && event.studyVersion >= newer) throw integrity();
    operations.push(Object.freeze({ id: event.id, studyVersion: event.studyVersion, op: event.op, occurredAt: event.occurredAt, requestId: event.requestId }));
  }
  const more = operations.length > HISTORY_PAGE_SIZE;
  const page = operations.slice(0, HISTORY_PAGE_SIZE);
  return { kind: "page", operations: Object.freeze(page), olderThan: more ? page[page.length - 1].studyVersion : null };
}

/**
 * One page of the change events of `operation`: those after ordinal `after`
 * (0 for the first page), in order.
 */
export async function fetchHistoryChanges(
  client: StudyRecordClient,
  userId: string,
  studyId: StudyId,
  operation: Pick<HistoryOperation, "studyVersion" | "requestId">,
  after: number,
  signal: AbortSignal,
): Promise<HistoryChangesRead> {
  if (toStudyVersion(operation.studyVersion) === null || toRequestId(operation.requestId) === null) throw integrity();
  if (!Number.isInteger(after) || after < 0 || after >= MAX_POSTGRES_INTEGER) throw integrity();
  const rows = await send(() =>
    client
      .from("evidence_events")
      .select(CHANGE_COLUMNS)
      .eq("user_id", userId)
      .eq("study_id", studyId)
      .eq("study_version", operation.studyVersion)
      .gt("ordinal", after)
      .order("ordinal", { ascending: true })
      .limit(HISTORY_CHANGES_PAGE_SIZE + 1)
      .abortSignal(signal),
  );
  if (rows.length > HISTORY_CHANGES_PAGE_SIZE + 1) throw integrity();

  if (rows.length === 0) {
    // Every committed request recorded at least one change, and the next page was asked for because a row was there.
    if (!(await studyExists(client, userId, studyId, signal))) return { kind: "gone" };
    throw integrity();
  }

  const changes: HistoryEvent[] = [];
  for (const [index, raw] of rows.entries()) {
    if (!raw || typeof raw !== "object") throw integrity();
    const row = raw as ChangeRow;
    if (row.user_id !== userId) throw integrity();
    const mapped = mapEventRow(row);
    if (!mapped.ok) throw integrity();
    const event = mapped.value;
    // Only this operation's own events, in their own order, with none missing.
    if (
      event.studyId !== studyId ||
      event.studyVersion !== operation.studyVersion ||
      event.requestId !== operation.requestId ||
      event.type === "request" ||
      event.ordinal !== after + 1 + index
    ) {
      throw integrity();
    }
    changes.push(event);
  }
  const more = changes.length > HISTORY_CHANGES_PAGE_SIZE;
  const page = changes.slice(0, HISTORY_CHANGES_PAGE_SIZE);
  return { kind: "page", changes: Object.freeze(page), after: more ? page[page.length - 1].ordinal : null };
}

/**
 * The operations of every page read so far, newest first. Each page was read
 * below the previous page's cursor, so versions only ever go down; anything
 * else is refused rather than shown twice or out of order.
 */
export function mergeHistoryPages(pages: readonly HistoryPageRead[]): { readonly kind: "gone" } | { readonly kind: "operations"; readonly operations: readonly HistoryOperation[] } {
  const operations: HistoryOperation[] = [];
  for (const page of pages) {
    if (page.kind === "gone") return { kind: "gone" };
    for (const operation of page.operations) {
      const newer = operations[operations.length - 1];
      if (newer && operation.studyVersion >= newer.studyVersion) throw integrity();
      operations.push(operation);
    }
  }
  return { kind: "operations", operations: Object.freeze(operations) };
}
