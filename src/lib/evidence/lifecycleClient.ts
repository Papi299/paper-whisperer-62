/**
 * The typed client for the four deployed lifecycle RPCs (EVIDENCE-RECORDS-001B).
 *
 * The ONLY module in the evidence library that calls `.rpc()`, and only with
 * the four literal names `evidence_create_study_from_paper`,
 * `evidence_update_study`, `evidence_set_link` and `evidence_delete_study`
 * (`src/test/evidenceDomainBoundary.test.ts` enforces this). It never writes a
 * table, never calls an Edge Function, Storage, an AI provider or any other
 * RPC, and does nothing on import or creation: a call happens only when the
 * caller sends a prepared request.
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
import { isCanonicalUuid, toLinkId, toSnapshotId, toStudyId, toStudyVersion, type LinkId, type PaperId, type SnapshotId, type StudyId, type StudyVersion } from "./ids";
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

/** The part of a Supabase client this module uses: four RPCs, nothing else. */
export interface EvidenceRpcClient {
  rpc(fn: "evidence_create_study_from_paper", args: CreateStudyArgs): PromiseLike<EvidenceRpcResponse>;
  rpc(fn: "evidence_update_study", args: UpdateStudyArgs): PromiseLike<EvidenceRpcResponse>;
  rpc(fn: "evidence_set_link", args: SetLinkArgs): PromiseLike<EvidenceRpcResponse>;
  rpc(fn: "evidence_delete_study", args: DeleteStudyArgs): PromiseLike<EvidenceRpcResponse>;
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

/** The lifecycle client over an injected Supabase client. Creating it calls nothing. */
export function createEvidenceLifecycleClient(client: EvidenceRpcClient) {
  async function call(request: LifecycleRequest): Promise<EvidenceRpcResponse> {
    switch (request.op) {
      case "create_study":
        return client.rpc("evidence_create_study_from_paper", request.args);
      case "update_study":
        return client.rpc("evidence_update_study", request.args);
      case "set_link":
        return client.rpc("evidence_set_link", request.args);
      case "delete_study":
        return client.rpc("evidence_delete_study", request.args);
    }
  }

  async function send<R extends LifecycleRequest, T>(
    request: R,
    op: R["op"],
    parse: (request: R, data: unknown) => T | null,
  ): Promise<LifecycleOutcome<T>> {
    if (!isPreparedRequest(request) || request.op !== op) return { ok: false, error: invalidRequestError() };
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
  });
}

export type EvidenceLifecycleClient = ReturnType<typeof createEvidenceLifecycleClient>;
