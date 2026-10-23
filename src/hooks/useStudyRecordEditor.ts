import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EvidenceError } from "@/lib/evidence/errors";
import { EVIDENCE_FIELD_LIMITS, prepareSaveChanges, type SaveChangesRequest } from "@/lib/evidence/fieldRequests";
import type { ArmId, OutcomeId, StudyId } from "@/lib/evidence/ids";
import type { EvidenceLifecycleClient } from "@/lib/evidence/lifecycleClient";
import {
  prepareDeleteStudy,
  prepareSetLink,
  prepareUpdateStudy,
  type DeleteStudyRequest,
  type SetLinkRequest,
  type UpdateStudyRequest,
} from "@/lib/evidence/lifecycleRequests";
import type { LinkAction } from "@/lib/evidence/types";
import { queryKeys } from "@/lib/queryKeys";
import {
  buildChanges,
  createDraft,
  headerChanged,
  indexBaseValues,
  isDraftDirty,
  rebaseAfterSave,
  type ChangeOrigin,
  type StudyRecordDraft,
} from "@/lib/studyRecord/draft";
import { newStudyRecordRequestId, studyRecordClient } from "@/lib/studyRecord/client";
import { jsonbTextByteLength } from "@/lib/studyRecord/jsonbSize";
import type { StudyRecordData } from "@/lib/studyRecord/read";
import { planSave, resolveBatchRefs, type SaveStep } from "@/lib/studyRecord/savePlan";
import { hasErrors, validateDraft, type DraftIssue, type IssueTarget } from "@/lib/studyRecord/validateDraft";

/**
 * The Study Record editor's state and its writes (EVIDENCE-RECORDS-001C1).
 *
 * Every write goes through PR-B's typed client (`createEvidenceLifecycleClient`)
 * and its `prepare*` builders — this hook names no RPC and touches no table.
 *
 * Saving is explicit and in memory (no autosave, no browser storage). One
 * press of Save runs the steps `planSave` gives, one after another; each step
 * is atomic on the server, and the UI says when there is more than one. The
 * rules that keep a retry from ever applying anything twice:
 *
 *   * each step has one request id, generated once with the plan; a step is
 *     prepared once, and "Try again" resends THAT prepared request — the server
 *     replays an applied request instead of applying it again;
 *   * nothing is retried automatically;
 *   * while a step's outcome is unknown, the draft is locked: the user can try
 *     again or reload, and nothing else can be sent;
 *   * a version conflict keeps every edit on screen and offers a reload; it
 *     never rebases the user's edits onto someone else's changes.
 *
 * `knownVersion` is the study version the draft is based on: the loaded one,
 * then each of this editor's own successful writes. It is what every write
 * sends as its expected version, so a change made in another tab is refused
 * rather than overwritten, even after this editor reloads the record.
 */


export type EditorSaveState =
  | { readonly status: "idle" }
  /** The browser's own checks failed; nothing was sent. */
  | { readonly status: "invalid"; readonly issues: readonly DraftIssue[] }
  | { readonly status: "saving"; readonly step: number; readonly total: number }
  | { readonly status: "saved"; readonly total: number }
  /** The server refused a step; earlier steps (`applied`) stay saved. Edits are kept. */
  | { readonly status: "failed"; readonly error: EvidenceError; readonly target: IssueTarget; readonly applied: number; readonly total: number }
  /** A step's outcome is unknown, or it failed for a reason worth retrying as is. */
  | { readonly status: "uncertain"; readonly error: EvidenceError; readonly applied: number; readonly total: number }
  /** Someone else changed the record (another tab or window). */
  | { readonly status: "conflict"; readonly applied: number; readonly total: number }
  /** The account may no longer create or edit study records (`evidence_records_not_enabled`). */
  | { readonly status: "not_enabled"; readonly applied: number; readonly total: number }
  /** The study no longer exists. */
  | { readonly status: "gone" }
  /** Saved, but the saved record could not be read back: reload before going on. */
  | { readonly status: "reload_failed"; readonly applied: number; readonly total: number };

export type WriteActionState =
  | { readonly status: "idle" }
  | { readonly status: "working" }
  | { readonly status: "failed"; readonly error: EvidenceError }
  /** The outcome is unknown: retry resends the same request. */
  | { readonly status: "uncertain"; readonly error: EvidenceError };

interface SaveRun {
  readonly steps: readonly SaveStep[];
  next: number;
  version: number;
  readonly prepared: Map<number, UpdateStudyRequest | SaveChangesRequest>;
  readonly armIds: Map<string, ArmId>;
  readonly outcomeIds: Map<string, OutcomeId>;
  readonly saved: ChangeOrigin[];
}

export interface UseStudyRecordEditorArgs {
  readonly userId: string;
  readonly studyId: StudyId;
  readonly base: StudyRecordData;
  /** Re-read the record. Resolves to the fresh record, null when it is gone, undefined on failure. */
  readonly refetch: () => Promise<StudyRecordData | null | undefined>;
  /** Whether create and edit are offered (the owner-only pilot, mirrored). */
  readonly canWrite: boolean;
  readonly client?: EvidenceLifecycleClient;
  readonly newRequestId?: () => string;
}

/** Where a server refusal points: the input it is about, when it names one. */
export function refusalTarget(error: EvidenceError, step: SaveStep | undefined): IssueTarget {
  const detail = error.detail;
  if (!detail || !step) return { kind: "record" };
  if (step.kind === "update_study") {
    if (detail.parameter === "label" || detail.parameter === "notes" || detail.parameter === "designProfile") {
      return { kind: "header", field: detail.parameter };
    }
    return { kind: "record" };
  }
  const index = detail.parameter === "changes" ? detail.path[0] : undefined;
  const origin = typeof index === "number" ? step.changes[index]?.origin : undefined;
  if (!origin) return { kind: "record" };
  return origin.kind === "value" ? { kind: "value", key: origin.key } : { kind: origin.kind, key: origin.key };
}

export function useStudyRecordEditor({
  userId,
  studyId,
  base,
  refetch,
  canWrite,
  client = studyRecordClient,
  newRequestId = newStudyRecordRequestId,
}: UseStudyRecordEditorArgs) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<StudyRecordDraft>(() => createDraft(base));
  const [knownVersion, setKnownVersion] = useState<number>(base.header.version);
  const [save, setSave] = useState<EditorSaveState>({ status: "idle" });
  const [externalChange, setExternalChange] = useState(false);
  const [linkAction, setLinkAction] = useState<WriteActionState>({ status: "idle" });
  const [deletion, setDeletion] = useState<WriteActionState>({ status: "idle" });
  const runRef = useRef<SaveRun | null>(null);
  const busyRef = useRef(false);
  const linkRequestRef = useRef<SetLinkRequest | null>(null);
  const deleteRequestRef = useRef<DeleteStudyRequest | null>(null);

  const baseValues = useMemo(() => indexBaseValues(base), [base]);
  const issues = useMemo(() => validateDraft(base, baseValues, draft), [base, baseValues, draft]);
  const dirty = useMemo(() => isDraftDirty(base, draft), [base, draft]);

  const locked =
    save.status === "saving" ||
    save.status === "uncertain" ||
    save.status === "gone" ||
    save.status === "not_enabled" ||
    save.status === "reload_failed" ||
    linkAction.status === "working" ||
    deletion.status === "working";
  const canEdit = canWrite && !locked;

  const invalidateSummaries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.studyRecords.all(userId) });
  }, [queryClient, userId]);

  /** Apply a draft change. Refused while the editor is locked or the user may not edit. */
  const update = useCallback(
    (change: (draft: StudyRecordDraft) => StudyRecordDraft) => {
      if (!canEdit) return;
      setDraft((current) => change(current));
      setSave((current) => (current.status === "saved" || current.status === "invalid" ? { status: "idle" } : current));
    },
    [canEdit],
  );

  /** Read the record back after this editor's own writes; flag a change made elsewhere. */
  const reconcile = useCallback(
    async (version: number, saved: readonly ChangeOrigin[], armIds: ReadonlyMap<string, ArmId>, outcomeIds: ReadonlyMap<string, OutcomeId>) => {
      setKnownVersion(version);
      invalidateSummaries();
      const fresh = await refetch();
      if (fresh === undefined) return "reload_failed" as const;
      if (fresh === null) return "gone" as const;
      if (fresh.header.version !== version) setExternalChange(true);
      setDraft((current) => rebaseAfterSave(current, saved, armIds, outcomeIds));
      return "ok" as const;
    },
    [invalidateSummaries, refetch],
  );

  /** After a failure at step `failedAt`: reconcile whatever the earlier steps saved. */
  const finishPartial = useCallback(
    async (run: SaveRun, failedAt: number): Promise<"ok" | "gone" | "reload_failed"> => {
      if (failedAt === 0) return "ok";
      const settled = await reconcile(run.version, run.saved, run.armIds, run.outcomeIds);
      if (settled === "gone") setSave({ status: "gone" });
      if (settled === "reload_failed") setSave({ status: "reload_failed", applied: failedAt, total: run.steps.length });
      return settled;
    },
    [reconcile],
  );

  const runSave = useCallback(async () => {
    if (busyRef.current || !canWrite) return;
    busyRef.current = true;
    try {
      let run = runRef.current;
      if (!run) {
        const currentIssues = validateDraft(base, baseValues, draft);
        if (hasErrors(currentIssues)) {
          setSave({ status: "invalid", issues: currentIssues });
          return;
        }
        const header = headerChanged(base, draft)
          ? { label: draft.header.label, designProfile: draft.header.designProfile, notes: draft.header.notes === "" ? null : draft.header.notes }
          : null;
        const plan = planSave({ header, changes: buildChanges(base, draft), newRequestId });
        if (!plan.ok) {
          if (plan.reason === "nothing_to_save") setSave({ status: "idle" });
          else setSave({ status: "invalid", issues: [{ target: { kind: "record" }, code: `plan.${plan.reason}`, message: PLAN_MESSAGES[plan.reason], severity: "error", path: [] }] });
          return;
        }
        run = { steps: plan.steps, next: 0, version: knownVersion, prepared: new Map(), armIds: new Map(), outcomeIds: new Map(), saved: [] };
        runRef.current = run;
      }

      const total = run.steps.length;
      for (; run.next < total; run.next += 1) {
        const index = run.next;
        const step = run.steps[index];
        setSave({ status: "saving", step: index + 1, total });

        let request = run.prepared.get(index);
        if (!request) {
          const prepared = prepareStep(step, studyId, run);
          if (!prepared) {
            runRef.current = null;
            setSave({ status: "invalid", issues: [{ target: { kind: "record" }, code: "plan.invalid_change", message: PLAN_MESSAGES.invalid_change, severity: "error", path: [] }] });
            await finishPartial(run, index);
            return;
          }
          request = prepared;
          run.prepared.set(index, request);
        }

        let outcome: { readonly ok: true; readonly version: number; readonly armIds?: Readonly<Record<string, ArmId>>; readonly outcomeIds?: Readonly<Record<string, OutcomeId>> } | { readonly ok: false; readonly error: EvidenceError };
        if (request.op === "update_study") {
          const sent = await client.updateStudy(request);
          outcome = sent.ok ? { ok: true, version: sent.result.studyVersion } : sent;
        } else {
          const sent = await client.saveChanges(request);
          outcome = sent.ok ? { ok: true, version: sent.result.studyVersion, armIds: sent.result.armIds, outcomeIds: sent.result.outcomeIds } : sent;
        }
        if (!outcome.ok) {
          const { error } = outcome;
          if (error.retry === "same_request") {
            // Keep the run and this prepared request: "Try again" resends it.
            setSave({ status: "uncertain", error, applied: index, total });
            return;
          }
          runRef.current = null;
          const settled = await finishPartial(run, index);
          if (settled !== "ok") return;
          if (error.kind === "version_conflict") setSave({ status: "conflict", applied: index, total });
          else if (error.kind === "records_not_enabled") setSave({ status: "not_enabled", applied: index, total });
          else if (error.kind === "study_not_found") setSave({ status: "gone" });
          else setSave({ status: "failed", error, target: refusalTarget(error, step), applied: index, total });
          return;
        }
        run.version = outcome.version;
        for (const [ref, id] of Object.entries(outcome.armIds ?? {})) run.armIds.set(ref, id);
        for (const [ref, id] of Object.entries(outcome.outcomeIds ?? {})) run.outcomeIds.set(ref, id);
        if (step.kind === "save_changes") run.saved.push(...step.changes.map((change) => change.origin));
      }

      runRef.current = null;
      const settled = await reconcile(run.version, run.saved, run.armIds, run.outcomeIds);
      if (settled === "ok") setSave({ status: "saved", total });
      else if (settled === "gone") setSave({ status: "gone" });
      else setSave({ status: "reload_failed", applied: total, total });
    } finally {
      busyRef.current = false;
    }
  }, [base, baseValues, canWrite, client, draft, finishPartial, knownVersion, newRequestId, reconcile, studyId]);

  /** Re-read the record and start the draft again from it. Edits are discarded: the caller confirms first. */
  const reload = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      runRef.current = null;
      const fresh = await refetch();
      if (fresh === undefined) {
        setSave({ status: "reload_failed", applied: 0, total: 0 });
        return;
      }
      if (fresh === null) {
        setSave({ status: "gone" });
        return;
      }
      setDraft(createDraft(fresh));
      setKnownVersion(fresh.header.version);
      setExternalChange(false);
      setSave({ status: "idle" });
      invalidateSummaries();
    } finally {
      busyRef.current = false;
    }
  }, [invalidateSummaries, refetch]);

  /** Confirm or mark provisional the link to `paperId`. Retrying an unknown outcome resends the same request. */
  const changeLinkStatus = useCallback(
    async (paperId: string, action: Exclude<LinkAction, "remove">) => {
      if (busyRef.current || !canWrite || dirtyLocked(save)) return;
      busyRef.current = true;
      try {
        let request = linkRequestRef.current;
        if (!request || request.paperId !== paperId || request.action !== action || request.expectedVersion !== knownVersion) {
          const prepared = prepareSetLink({ studyId, paperId, action, expectedVersion: knownVersion, requestId: newRequestId() });
          if (!prepared.ok) return;
          request = prepared.request;
          linkRequestRef.current = request;
        }
        setLinkAction({ status: "working" });
        const outcome = await client.setLink(request);
        if (!outcome.ok) {
          if (outcome.error.retry === "same_request") setLinkAction({ status: "uncertain", error: outcome.error });
          else {
            linkRequestRef.current = null;
            setLinkAction({ status: "failed", error: outcome.error });
            if (outcome.error.kind === "version_conflict") setSave({ status: "conflict", applied: 0, total: 0 });
            if (outcome.error.kind === "records_not_enabled") setSave({ status: "not_enabled", applied: 0, total: 0 });
          }
          return;
        }
        linkRequestRef.current = null;
        const settled = await reconcile(outcome.result.studyVersion, [], new Map(), new Map());
        setLinkAction({ status: "idle" });
        if (settled === "gone") setSave({ status: "gone" });
        if (settled === "reload_failed") setSave({ status: "reload_failed", applied: 0, total: 0 });
      } finally {
        busyRef.current = false;
      }
    },
    [canWrite, client, knownVersion, newRequestId, reconcile, save, studyId],
  );

  /**
   * Delete the study record. Not gated: whoever owns it can always delete it.
   * Resolves to true when it is gone (deleted now, or already absent).
   */
  const deleteStudy = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    try {
      let request = deleteRequestRef.current;
      if (!request || request.expectedVersion !== knownVersion) {
        const prepared = prepareDeleteStudy({ studyId, expectedVersion: knownVersion, requestId: newRequestId() });
        if (!prepared.ok) return false;
        request = prepared.request;
        deleteRequestRef.current = request;
      }
      setDeletion({ status: "working" });
      const outcome = await client.deleteStudy(request);
      if (!outcome.ok) {
        if (outcome.error.retry === "same_request") setDeletion({ status: "uncertain", error: outcome.error });
        else {
          deleteRequestRef.current = null;
          setDeletion({ status: "failed", error: outcome.error });
        }
        return false;
      }
      deleteRequestRef.current = null;
      setDeletion({ status: "idle" });
      queryClient.removeQueries({ queryKey: queryKeys.studyRecords.study(userId, studyId) });
      invalidateSummaries();
      return true;
    } finally {
      busyRef.current = false;
    }
  }, [client, invalidateSummaries, knownVersion, newRequestId, queryClient, studyId, userId]);

  const clearDeletionError = useCallback(() => setDeletion({ status: "idle" }), []);
  const clearLinkError = useCallback(() => setLinkAction({ status: "idle" }), []);

  return {
    draft,
    baseValues,
    issues,
    dirty,
    knownVersion,
    save,
    externalChange,
    linkAction,
    deletion,
    /** Whether inputs accept edits right now. */
    canEdit,
    update,
    runSave,
    reload,
    changeLinkStatus,
    deleteStudy,
    clearDeletionError,
    clearLinkError,
  };
}

/** Link changes wait while a save's outcome is unknown or the record must be reloaded. */
function dirtyLocked(save: EditorSaveState): boolean {
  return save.status === "saving" || save.status === "uncertain" || save.status === "reload_failed" || save.status === "gone";
}

export const PLAN_MESSAGES = {
  invalid_change: "Couldn't send these changes. Reload the study record and try again.",
  too_large: `This change is larger than one save can hold (${EVIDENCE_FIELD_LIMITS.changesPerSave} changes or 64 KB). Save fewer changes at a time.`,
  nothing_to_save: "There are no changes to save.",
} as const;

/** The prepared request for one step, at the run's current version; null when it cannot be built or is too large. */
function prepareStep(step: SaveStep, studyId: StudyId, run: SaveRun): UpdateStudyRequest | SaveChangesRequest | null {
  if (step.kind === "update_study") {
    const prepared = prepareUpdateStudy({
      studyId,
      expectedVersion: run.version,
      label: step.label,
      designProfile: step.designProfile,
      notes: step.notes,
      requestId: step.requestId,
    });
    return prepared.ok ? prepared.request : null;
  }
  const changes = resolveBatchRefs(
    step.changes.map((change) => change.change),
    run.armIds,
    run.outcomeIds,
  );
  if (!changes) return null;
  const prepared = prepareSaveChanges({ studyId, expectedVersion: run.version, changes, requestId: step.requestId });
  if (!prepared.ok) return null;
  // The planner measured this batch; refuse to send one the server would refuse for its size.
  if (jsonbTextByteLength(prepared.request.args.p_changes) > EVIDENCE_FIELD_LIMITS.saveBytes) return null;
  return prepared.request;
}
