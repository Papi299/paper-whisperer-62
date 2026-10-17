/**
 * Requests for the four deployed lifecycle RPCs, prepared and validated
 * (EVIDENCE-RECORDS-001B; PR-A2 `20261016104232`; docs/evidence-records-lifecycle.md).
 *
 * A prepared request is a frozen object holding the RPC's exact arguments —
 * the deployed parameter names, typed by the generated Supabase function types
 * — including the caller's request id. Resending the SAME object is how a retry
 * of the same user action is made: identical arguments and the same request id
 * make the server replay its original answer instead of applying the action
 * twice (FK-PROOF-001 I-1). A different action, including the same edit after a
 * version conflict, needs a new request id and so a new prepared request.
 *
 * Nothing here can name a user, a history row, a fingerprint, a review time or
 * a match result: the RPCs take none of those, and these builders produce only
 * the parameters the RPCs declare. Preparing is pure; sending is
 * `lifecycleClient.ts`'s job.
 */

import type { Database } from "@/integrations/supabase/types";
import { isDesignProfile, type DesignProfile } from "./fieldDictionary";
import { toPaperId, toRequestId, toStudyId, toStudyVersion, type PaperId, type RequestId, type StudyId } from "./ids";
import { isLinkAction, isLinkStatus, type LinkAction, type LinkStatus } from "./types";
import { validateStudyLabel, validateStudyNotes, type ValidationIssue, VALIDATION_MESSAGES, type ValidationCode } from "./validation";

/** The four client RPCs, in the order the migration creates them. */
export const EVIDENCE_LIFECYCLE_RPCS = [
  "evidence_create_study_from_paper",
  "evidence_update_study",
  "evidence_set_link",
  "evidence_delete_study",
] as const;
export type EvidenceLifecycleRpc = (typeof EVIDENCE_LIFECYCLE_RPCS)[number];

type Functions = Database["public"]["Functions"];

export type CreateStudyArgs = Functions["evidence_create_study_from_paper"]["Args"];
/**
 * The generated type lists `p_notes` as a non-null string; the database takes
 * NULL for "no notes" (docs/evidence-records-lifecycle.md §9). This is the one
 * place the generated type is widened, and only for that parameter.
 */
export type UpdateStudyArgs = Omit<Functions["evidence_update_study"]["Args"], "p_notes"> & { p_notes: string | null };
export type SetLinkArgs = Functions["evidence_set_link"]["Args"];
export type DeleteStudyArgs = Functions["evidence_delete_study"]["Args"];

interface RequestBase<Op extends string, Rpc extends EvidenceLifecycleRpc, Args> {
  readonly op: Op;
  /** The RPC this request is for. */
  readonly functionName: Rpc;
  readonly requestId: RequestId;
  readonly args: Readonly<Args>;
}

export type CreateStudyRequest = RequestBase<"create_study", "evidence_create_study_from_paper", CreateStudyArgs>;
export type UpdateStudyRequest = RequestBase<"update_study", "evidence_update_study", UpdateStudyArgs> & {
  readonly studyId: StudyId;
  readonly expectedVersion: number;
};
export type SetLinkRequest = RequestBase<"set_link", "evidence_set_link", SetLinkArgs> & {
  readonly studyId: StudyId;
  readonly paperId: PaperId;
  readonly action: LinkAction;
  readonly expectedVersion: number;
};
export type DeleteStudyRequest = RequestBase<"delete_study", "evidence_delete_study", DeleteStudyArgs> & {
  readonly studyId: StudyId;
  readonly expectedVersion: number;
};
export type LifecycleRequest = CreateStudyRequest | UpdateStudyRequest | SetLinkRequest | DeleteStudyRequest;

export type Prepared<R> = { readonly ok: true; readonly request: R } | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

function issue(code: ValidationCode, field: string): ValidationIssue {
  return Object.freeze({ code, path: Object.freeze([field]), severity: "error", message: VALIDATION_MESSAGES[code] });
}

function finish<R>(issues: ValidationIssue[], build: () => R): Prepared<R> {
  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };
  const request = build() as R & { args: object };
  Object.freeze(request.args);
  return { ok: true, request: Object.freeze(request) };
}

function common(issues: ValidationIssue[], requestId: unknown): RequestId | null {
  const id = toRequestId(requestId);
  if (!id) issues.push(issue("request.request_id_invalid", "requestId"));
  return id;
}

function studyAndVersion(issues: ValidationIssue[], studyId: unknown, expectedVersion: unknown) {
  const study = toStudyId(studyId);
  const version = toStudyVersion(expectedVersion);
  if (!study) issues.push(issue("request.study_id_invalid", "studyId"));
  if (!version) issues.push(issue("request.expected_version_invalid", "expectedVersion"));
  return { study, version };
}

/** A new study from one of the caller's papers. Owner-gated on the server. */
export function prepareCreateStudy(input: {
  readonly paperId: string;
  readonly label: string;
  readonly designProfile: DesignProfile;
  readonly linkStatus: LinkStatus;
  readonly requestId: string;
}): Prepared<CreateStudyRequest> {
  const issues: ValidationIssue[] = [];
  const paperId = toPaperId(input.paperId);
  if (!paperId) issues.push(issue("request.paper_id_invalid", "paperId"));
  issues.push(...validateStudyLabel(input.label).issues);
  if (!isDesignProfile(input.designProfile)) issues.push(issue("study.design_profile_required", "designProfile"));
  if (!isLinkStatus(input.linkStatus)) issues.push(issue("study.link_status_required", "linkStatus"));
  const requestId = common(issues, input.requestId);
  return finish(issues, () => ({
    op: "create_study" as const,
    functionName: "evidence_create_study_from_paper" as const,
    requestId: requestId!,
    args: {
      p_paper_id: paperId!,
      p_label: input.label,
      p_design_profile: input.designProfile,
      p_link_status: input.linkStatus,
      p_request_id: requestId!,
    },
  }));
}

/** Replace a study's label, design family and notes (null = no notes) at an expected version. */
export function prepareUpdateStudy(input: {
  readonly studyId: string;
  readonly expectedVersion: number;
  readonly label: string;
  readonly designProfile: DesignProfile;
  readonly notes: string | null;
  readonly requestId: string;
}): Prepared<UpdateStudyRequest> {
  const issues: ValidationIssue[] = [];
  const { study, version } = studyAndVersion(issues, input.studyId, input.expectedVersion);
  issues.push(...validateStudyLabel(input.label).issues);
  if (!isDesignProfile(input.designProfile)) issues.push(issue("study.design_profile_required", "designProfile"));
  // undefined is not "no notes": the caller must say null explicitly.
  if (input.notes === undefined) issues.push(issue("request.notes_missing", "notes"));
  else issues.push(...validateStudyNotes(input.notes).issues);
  const requestId = common(issues, input.requestId);
  return finish(issues, () => ({
    op: "update_study" as const,
    functionName: "evidence_update_study" as const,
    requestId: requestId!,
    studyId: study!,
    expectedVersion: version!,
    args: {
      p_study_id: study!,
      p_expected_version: version!,
      p_label: input.label,
      p_design_profile: input.designProfile,
      p_notes: input.notes,
      p_request_id: requestId!,
    },
  }));
}

/** Confirm, mark provisional or remove one EXISTING link of a study. There is no add. */
export function prepareSetLink(input: {
  readonly studyId: string;
  readonly paperId: string;
  readonly action: LinkAction;
  readonly expectedVersion: number;
  readonly requestId: string;
}): Prepared<SetLinkRequest> {
  const issues: ValidationIssue[] = [];
  const { study, version } = studyAndVersion(issues, input.studyId, input.expectedVersion);
  const paperId = toPaperId(input.paperId);
  if (!paperId) issues.push(issue("request.paper_id_invalid", "paperId"));
  if (!isLinkAction(input.action)) issues.push(issue("request.link_action_invalid", "action"));
  const requestId = common(issues, input.requestId);
  return finish(issues, () => ({
    op: "set_link" as const,
    functionName: "evidence_set_link" as const,
    requestId: requestId!,
    studyId: study!,
    paperId: paperId!,
    action: input.action,
    expectedVersion: version!,
    args: {
      p_study_id: study!,
      p_paper_id: paperId!,
      p_action: input.action,
      p_expected_version: version!,
      p_request_id: requestId!,
    },
  }));
}

/**
 * Delete a study and everything it holds. Not gated: any owner of a study can
 * delete it. The request id is validated by the server but not remembered —
 * a retry after a lost response answers `already_absent`.
 */
export function prepareDeleteStudy(input: {
  readonly studyId: string;
  readonly expectedVersion: number;
  readonly requestId: string;
}): Prepared<DeleteStudyRequest> {
  const issues: ValidationIssue[] = [];
  const { study, version } = studyAndVersion(issues, input.studyId, input.expectedVersion);
  const requestId = common(issues, input.requestId);
  return finish(issues, () => ({
    op: "delete_study" as const,
    functionName: "evidence_delete_study" as const,
    requestId: requestId!,
    studyId: study!,
    expectedVersion: version!,
    args: { p_study_id: study!, p_expected_version: version!, p_request_id: requestId! },
  }));
}

/**
 * Whether `request` is exactly what the matching `prepare*` builds from its own
 * arguments — so a hand-built object with an extra, missing or unvalidated
 * argument is never sent.
 */
export function isPreparedRequest(request: unknown): request is LifecycleRequest {
  if (!request || typeof request !== "object") return false;
  const r = request as LifecycleRequest;
  const args = r.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return false;
  let rebuilt: Prepared<LifecycleRequest>;
  switch (r.op) {
    case "create_study":
      rebuilt = prepareCreateStudy({
        paperId: args.p_paper_id as string,
        label: args.p_label as string,
        designProfile: args.p_design_profile as DesignProfile,
        linkStatus: args.p_link_status as LinkStatus,
        requestId: args.p_request_id as string,
      });
      break;
    case "update_study":
      rebuilt = prepareUpdateStudy({
        studyId: args.p_study_id as string,
        expectedVersion: args.p_expected_version as number,
        label: args.p_label as string,
        designProfile: args.p_design_profile as DesignProfile,
        notes: args.p_notes as string | null,
        requestId: args.p_request_id as string,
      });
      break;
    case "set_link":
      rebuilt = prepareSetLink({
        studyId: args.p_study_id as string,
        paperId: args.p_paper_id as string,
        action: args.p_action as LinkAction,
        expectedVersion: args.p_expected_version as number,
        requestId: args.p_request_id as string,
      });
      break;
    case "delete_study":
      rebuilt = prepareDeleteStudy({
        studyId: args.p_study_id as string,
        expectedVersion: args.p_expected_version as number,
        requestId: args.p_request_id as string,
      });
      break;
    default:
      return false;
  }
  return rebuilt.ok && JSON.stringify(rebuilt.request) === JSON.stringify(request);
}
