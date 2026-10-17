/**
 * The typed client for the study-record RPCs (EVIDENCE-RECORDS-001B; 001A3).
 *
 * The ONLY module in the evidence library that calls `.rpc()`, and only with
 * seven literal names: PR-A2's lifecycle RPCs `evidence_create_study_from_paper`,
 * `evidence_update_study`, `evidence_set_link` and `evidence_delete_study`, and
 * PR-A3's field RPCs `evidence_save_changes`, `evidence_review_fields` and
 * `evidence_rebase_source` (`src/test/evidenceDomainBoundary.test.ts` enforces
 * this). It never writes a table, never calls an Edge Function, Storage, an AI
 * provider or any other RPC — the internal helpers such as
 * `evidence_locate_quote` are not callable by a client at all — and does
 * nothing on import or creation: a call happens only when the caller sends a
 * prepared request. Nothing in the application sends a PR-A3 request yet.
 *
 * The Supabase client is injected. This module imports no client, so it works
 * against the real one and against a test double alike.
 *
 * No optimistic behaviour and no automatic retry. Every outcome is reported as
 * it is: the server's status (`applied`, `replayed`, `unchanged`, `deleted`,
 * `already_absent`) or a classified error saying whether anything was applied
 * and what a retry must be. A retry is the caller's decision, and it resends
 * the SAME prepared request — never a fresh request id for an action that may
 * already have been applied.
 *
 * Responses are checked, not trusted: an answer that does not have exactly the
 * shape the RPC returns, or that names another study or paper, or whose version
 * does not follow from the expected one, is `malformed_response`.
 */

import { classifyLifecycleError, invalidRequestError, malformedResponseError, transportUncertainError, type EvidenceError } from "./errors";
import {
  EVIDENCE_FIELD_LIMITS,
  isPreparedFieldRequest,
  type FieldRequest,
  type RebaseSourceArgs,
  type RebaseSourceRequest,
  type ReviewFieldRequest,
  type ReviewFieldsArgs,
  type SaveChangesArgs,
  type SaveChangesRequest,
} from "./fieldRequests";
import {
  isCanonicalUuid,
  toArmId,
  toLinkId,
  toOutcomeId,
  toSnapshotId,
  toStudyId,
  toStudyVersion,
  type ArmId,
  type LinkId,
  type OutcomeId,
  type PaperId,
  type SnapshotId,
  type StudyId,
  type StudyVersion,
  type ValueId,
  type ValueVersion,
} from "./ids";
import {
  isPreparedRequest,
  type CreateStudyArgs,
  type CreateStudyRequest,
  type DeleteStudyArgs,
  type DeleteStudyRequest,
  type LifecycleRequest,
  type SetLinkArgs,
  type SetLinkRequest,
  type UpdateStudyArgs,
  type UpdateStudyRequest,
} from "./lifecycleRequests";
import type { LinkStatus } from "./types";

/** What supabase-js resolves an RPC call to. */
export interface EvidenceRpcResponse {
  readonly data: unknown;
  readonly error: unknown;
  readonly status?: number;
}

/** The part of a Supabase client this module uses: seven RPCs, nothing else. */
export interface EvidenceRpcClient {
  rpc(fn: "evidence_create_study_from_paper", args: CreateStudyArgs): PromiseLike<EvidenceRpcResponse>;
  rpc(fn: "evidence_update_study", args: UpdateStudyArgs): PromiseLike<EvidenceRpcResponse>;
  rpc(fn: "evidence_set_link", args: SetLinkArgs): PromiseLike<EvidenceRpcResponse>;
  rpc(fn: "evidence_delete_study", args: DeleteStudyArgs): PromiseLike<EvidenceRpcResponse>;
  rpc(fn: "evidence_save_changes", args: SaveChangesArgs): PromiseLike<EvidenceRpcResponse>;
  rpc(fn: "evidence_review_fields", args: ReviewFieldsArgs): PromiseLike<EvidenceRpcResponse>;
  rpc(fn: "evidence_rebase_source", args: RebaseSourceArgs): PromiseLike<EvidenceRpcResponse>;
}

export interface CreateStudyResult {
  readonly status: "applied" | "replayed";
  readonly studyId: StudyId;
  readonly studyVersion: StudyVersion;
  readonly linkId: LinkId;
  /** The saved abstract copy; null when the paper had no abstract, or one empty after v1. */
  readonly snapshotId: SnapshotId | null;
}

export interface UpdateStudyResult {
  readonly status: "applied" | "replayed" | "unchanged";
  readonly studyId: StudyId;
  readonly studyVersion: StudyVersion;
}

export interface SetLinkResult {
  readonly status: "applied" | "replayed" | "unchanged";
  readonly studyId: StudyId;
  readonly studyVersion: StudyVersion;
  readonly paperId: PaperId;
  readonly linkId: LinkId;
  /** Null after a remove. */
  readonly linkStatus: LinkStatus | null;
}

export interface DeleteStudyResult {
  readonly status: "deleted" | "already_absent";
}

export interface SaveChangesResult {
  /** `unchanged`: nothing differed, nothing was written, and the request id was not used. */
  readonly status: "applied" | "replayed" | "unchanged";
  readonly studyId: StudyId;
  readonly studyVersion: StudyVersion;
  /** The id the server gave each group the batch added, by its batch ref. */
  readonly armIds: Readonly<Record<string, ArmId>>;
  readonly outcomeIds: Readonly<Record<string, OutcomeId>>;
}

export interface ReviewFieldResult {
  readonly status: "applied" | "replayed" | "unchanged";
  readonly studyId: StudyId;
  readonly studyVersion: StudyVersion;
  readonly valueId: ValueId;
  /** A review never changes `value_version`: it is the version reviewed. */
  readonly valueVersion: ValueVersion;
  readonly reviewStatus: "user_reviewed" | "disputed";
}

export interface RebaseSourceResult {
  /** `unchanged`: the library abstract is the current copy's text, byte for byte. */
  readonly status: "applied" | "replayed" | "unchanged";
  readonly studyId: StudyId;
  readonly studyVersion: StudyVersion;
  readonly paperId: PaperId;
  /** The link's current copy afterwards: the new one, or (unchanged) the existing one. */
  readonly snapshotId: SnapshotId;
  /** The copy it replaced; null for a first capture and when unchanged. */
  readonly previousSnapshotId: SnapshotId | null;
  readonly seq: number;
  /** Abstract quotes re-pointed to the new copy (exactly one occurrence there). */
  readonly rematched: number;
  /** Quotes that stayed on their earlier copy: not found, or found several times. */
  readonly notFound: number;
  readonly ambiguous: number;
  /** Values moved to Needs re-review — even where every quote was found again. */
  readonly needsRereview: number;
}

export type LifecycleOutcome<R> = { readonly ok: true; readonly result: R } | { readonly ok: false; readonly error: EvidenceError };

type Body = Record<string, unknown>;

function hasExactKeys(data: unknown, keys: readonly string[]): data is Body {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const present = Object.keys(data).sort();
  return present.length === keys.length && [...keys].sort().every((key, i) => key === present[i]);
}

const sameId = (a: unknown, b: string) => isCanonicalUuid(a) && a.toLowerCase() === b;

function parseCreate(request: CreateStudyRequest, data: unknown): CreateStudyResult | null {
  if (!hasExactKeys(data, ["status", "study_id", "study_version", "link_id", "snapshot_id"])) return null;
  const status = data.status;
  const studyId = toStudyId(data.study_id);
  const linkId = toLinkId(data.link_id);
  const snapshotId = data.snapshot_id === null ? null : toSnapshotId(data.snapshot_id);
  if ((status !== "applied" && status !== "replayed") || !studyId || !linkId) return null;
  if (data.snapshot_id !== null && !snapshotId) return null;
  // Creation is always study version 1, and a replay returns the creation's answer.
  if (data.study_version !== 1) return null;
  return Object.freeze({ status, studyId, studyVersion: toStudyVersion(1)!, linkId, snapshotId });
}

function parseUpdate(request: UpdateStudyRequest, data: unknown): UpdateStudyResult | null {
  if (!hasExactKeys(data, ["status", "study_id", "study_version"])) return null;
  const status = data.status;
  if (status !== "applied" && status !== "replayed" && status !== "unchanged") return null;
  if (!sameId(data.study_id, request.studyId)) return null;
  const expected = status === "unchanged" ? request.expectedVersion : request.expectedVersion + 1;
  if (data.study_version !== expected) return null;
  return Object.freeze({ status, studyId: request.studyId, studyVersion: toStudyVersion(expected)! });
}

const ACTION_STATUS: Readonly<Record<SetLinkRequest["action"], LinkStatus | null>> = Object.freeze({
  confirm: "user_confirmed",
  mark_provisional: "provisional",
  remove: null,
});

function parseSetLink(request: SetLinkRequest, data: unknown): SetLinkResult | null {
  if (!hasExactKeys(data, ["status", "study_id", "study_version", "paper_id", "link_id", "link_status"])) return null;
  const status = data.status;
  if (status !== "applied" && status !== "replayed" && status !== "unchanged") return null;
  if (!sameId(data.study_id, request.studyId) || !sameId(data.paper_id, request.paperId)) return null;
  const linkId = toLinkId(data.link_id);
  if (!linkId) return null;
  const linkStatus = ACTION_STATUS[request.action];
  // A remove is never "unchanged": the link is gone, or the request was refused.
  if (status === "unchanged" && linkStatus === null) return null;
  if (data.link_status !== linkStatus) return null;
  const expected = status === "unchanged" ? request.expectedVersion : request.expectedVersion + 1;
  if (data.study_version !== expected) return null;
  return Object.freeze({
    status,
    studyId: request.studyId,
    studyVersion: toStudyVersion(expected)!,
    paperId: request.paperId,
    linkId,
    linkStatus,
  });
}

function parseDelete(_request: DeleteStudyRequest, data: unknown): DeleteStudyResult | null {
  if (!hasExactKeys(data, ["status"])) return null;
  return data.status === "deleted" || data.status === "already_absent" ? Object.freeze({ status: data.status }) : null;
}

type WriteStatus = "applied" | "replayed" | "unchanged";
const isWriteStatus = (status: unknown): status is WriteStatus => status === "applied" || status === "replayed" || status === "unchanged";
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 2147483647;

/** The study version a write answer must carry: unchanged keeps it, anything else is the next one. */
function nextVersion(request: { readonly expectedVersion: number }, status: WriteStatus): StudyVersion | null {
  return toStudyVersion(status === "unchanged" ? request.expectedVersion : request.expectedVersion + 1);
}

/** `{ ref: id }` holding exactly `refs`, every id distinct; null otherwise. */
function parseIdMap<T extends string>(data: unknown, refs: readonly string[], toId: (value: unknown) => T | null): Readonly<Record<string, T>> | null {
  if (!hasExactKeys(data, refs)) return null;
  const out: Record<string, T> = {};
  for (const ref of refs) {
    const id = toId(data[ref]);
    if (!id) return null;
    out[ref] = id;
  }
  return new Set(Object.values(out)).size === refs.length ? Object.freeze(out) : null;
}

function parseSaveChanges(request: SaveChangesRequest, data: unknown): SaveChangesResult | null {
  if (!hasExactKeys(data, ["status", "study_id", "study_version", "arm_ids", "outcome_ids"])) return null;
  const status = data.status;
  if (!isWriteStatus(status) || !sameId(data.study_id, request.studyId)) return null;
  const version = nextVersion(request, status);
  if (!version || data.study_version !== version) return null;
  // Adding a group or an outcome always changes something, so `unchanged` adds none.
  const armRefs = status === "unchanged" ? [] : request.armRefs;
  const outcomeRefs = status === "unchanged" ? [] : request.outcomeRefs;
  if (status === "unchanged" && (request.armRefs.length > 0 || request.outcomeRefs.length > 0)) return null;
  const armIds = parseIdMap(data.arm_ids, armRefs, toArmId);
  const outcomeIds = parseIdMap(data.outcome_ids, outcomeRefs, toOutcomeId);
  if (!armIds || !outcomeIds) return null;
  return Object.freeze({ status, studyId: request.studyId, studyVersion: version, armIds, outcomeIds });
}

function parseReviewField(request: ReviewFieldRequest, data: unknown): ReviewFieldResult | null {
  if (!hasExactKeys(data, ["status", "study_id", "study_version", "value_id", "value_version", "review_status"])) return null;
  const status = data.status;
  if (!isWriteStatus(status) || !sameId(data.study_id, request.studyId) || !sameId(data.value_id, request.valueId)) return null;
  const version = nextVersion(request, status);
  if (!version || data.study_version !== version) return null;
  if (data.value_version !== request.expectedValueVersion) return null;
  const reviewStatus = request.action === "confirm" ? "user_reviewed" : "disputed";
  if (data.review_status !== reviewStatus) return null;
  return Object.freeze({
    status,
    studyId: request.studyId,
    studyVersion: version,
    valueId: request.valueId,
    valueVersion: request.expectedValueVersion as ValueVersion,
    reviewStatus,
  });
}

function parseRebaseSource(request: RebaseSourceRequest, data: unknown): RebaseSourceResult | null {
  const keys = ["status", "study_id", "study_version", "paper_id", "snapshot_id", "previous_snapshot_id", "seq", "rematched", "not_found", "ambiguous", "needs_rereview"];
  if (!hasExactKeys(data, keys)) return null;
  const status = data.status;
  if (!isWriteStatus(status) || !sameId(data.study_id, request.studyId) || !sameId(data.paper_id, request.paperId)) return null;
  const version = nextVersion(request, status);
  if (!version || data.study_version !== version) return null;
  const snapshotId = toSnapshotId(data.snapshot_id);
  const previousSnapshotId = data.previous_snapshot_id === null ? null : toSnapshotId(data.previous_snapshot_id);
  const { seq, rematched, not_found: notFound, ambiguous, needs_rereview: needsRereview } = data;
  if (!snapshotId || (data.previous_snapshot_id !== null && !previousSnapshotId) || previousSnapshotId === snapshotId) return null;
  if (!Number.isInteger(seq) || (seq as number) < 1 || (seq as number) > EVIDENCE_FIELD_LIMITS.copiesPerLink) return null;
  if (![rematched, notFound, ambiguous, needsRereview].every(isCount)) return null;
  if (status === "unchanged") {
    // Nothing was saved, so nothing moved.
    if (previousSnapshotId !== null || rematched !== 0 || notFound !== 0 || ambiguous !== 0 || needsRereview !== 0) return null;
  } else if ((seq === 1) !== (previousSnapshotId === null)) {
    // A first capture replaces nothing; every later copy replaces one.
    return null;
  }
  return Object.freeze({
    status,
    studyId: request.studyId,
    studyVersion: version,
    paperId: request.paperId,
    snapshotId,
    previousSnapshotId,
    seq: seq as number,
    rematched: rematched as number,
    notFound: notFound as number,
    ambiguous: ambiguous as number,
    needsRereview: needsRereview as number,
  });
}

/** The study-record client over an injected Supabase client. Creating it calls nothing. */
export function createEvidenceLifecycleClient(client: EvidenceRpcClient) {
  async function call(request: LifecycleRequest | FieldRequest): Promise<EvidenceRpcResponse> {
    switch (request.op) {
      case "create_study":
        return client.rpc("evidence_create_study_from_paper", request.args);
      case "update_study":
        return client.rpc("evidence_update_study", request.args);
      case "set_link":
        return client.rpc("evidence_set_link", request.args);
      case "delete_study":
        return client.rpc("evidence_delete_study", request.args);
      case "save_changes":
        return client.rpc("evidence_save_changes", request.args);
      case "review_fields":
        return client.rpc("evidence_review_fields", request.args);
      case "rebase_source":
        return client.rpc("evidence_rebase_source", request.args);
    }
  }

  const isPrepared = (request: LifecycleRequest | FieldRequest) =>
    request?.op === "save_changes" || request?.op === "review_fields" || request?.op === "rebase_source"
      ? isPreparedFieldRequest(request)
      : isPreparedRequest(request);

  async function send<R extends LifecycleRequest | FieldRequest, T>(
    request: R,
    op: R["op"],
    parse: (request: R, data: unknown) => T | null,
  ): Promise<LifecycleOutcome<T>> {
    if (!isPrepared(request) || request.op !== op) return { ok: false, error: invalidRequestError() };
    let response: EvidenceRpcResponse;
    try {
      response = await call(request);
    } catch {
      return { ok: false, error: transportUncertainError() };
    }
    const status = typeof response?.status === "number" ? response.status : null;
    if (response?.error) return { ok: false, error: classifyLifecycleError(response.error, status, request.functionName) };
    const result = parse(request, response?.data);
    return result ? { ok: true, result } : { ok: false, error: malformedResponseError(status) };
  }

  return Object.freeze({
    createStudyFromPaper: (request: CreateStudyRequest) => send(request, "create_study", parseCreate),
    updateStudy: (request: UpdateStudyRequest) => send(request, "update_study", parseUpdate),
    setLink: (request: SetLinkRequest) => send(request, "set_link", parseSetLink),
    deleteStudy: (request: DeleteStudyRequest) => send(request, "delete_study", parseDelete),
    saveChanges: (request: SaveChangesRequest) => send(request, "save_changes", parseSaveChanges),
    reviewField: (request: ReviewFieldRequest) => send(request, "review_fields", parseReviewField),
    rebaseSource: (request: RebaseSourceRequest) => send(request, "rebase_source", parseRebaseSource),
  });
}

export type EvidenceLifecycleClient = ReturnType<typeof createEvidenceLifecycleClient>;
