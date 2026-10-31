import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EvidenceError } from "@/lib/evidence/errors";
import {
  EVIDENCE_FIELD_LIMITS,
  prepareRebaseSource,
  prepareReviewField,
  prepareSaveChanges,
  type RebaseSourceRequest,
  type ReviewAction,
  type ReviewFieldRequest,
  type SaveChangesRequest,
} from "@/lib/evidence/fieldRequests";
import type { ArmId, OutcomeId, PaperId, StudyId, ValueId } from "@/lib/evidence/ids";
import type { EvidenceLifecycleClient, RebaseSourceResult } from "@/lib/evidence/lifecycleClient";
import {
  prepareDeleteStudy,
  prepareSetLink,
  prepareUpdateStudy,
  type DeleteStudyRequest,
  type SetLinkRequest,
  type UpdateStudyRequest,
} from "@/lib/evidence/lifecycleRequests";
import { checkFlag } from "@/lib/evidence/review";
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
import { buildReviewItems, describeRecordSources, reviewTargetState, type ReviewActivity } from "@/lib/studyRecord/reviewModel";
import { planSave, resolveBatchRefs, type SaveStep } from "@/lib/studyRecord/savePlan";
import { abstractSha256, checkSourceUpdateCandidate, type AbstractDigest, type SourceUpdateCandidate } from "@/lib/studyRecord/sourceUpdate";
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
 *
 * Review (EVIDENCE-RECORDS-001C2A) is one more write of this editor, under
 * the same rules. `review` Confirms or Flags ONE saved value at the
 * `value_version` its card showed, through `evidence_review_fields`:
 *   * it is offered only as `reviewItems` says (Review mode's model: the saved
 *     value, no unsaved edit or pending removal, PR-B's `checkConfirm` or
 *     `checkFlag`), and only while nothing else is in flight or in doubt;
 *   * the request is prepared once with one request id; while its outcome is
 *     unknown it is kept, every other write and edit waits, and "Try again"
 *     (`retryReview`) resends THAT request — the server replays it instead of
 *     recording it twice. Reloading abandons it;
 *   * on success the record is read back (`reconcile`, as after a link
 *     change). A review changes no `value_version`, so every unsaved edit
 *     stays exactly as it was.
 * An open Flag note lives here too (`flagNotes`, G3), not in its card: it
 * survives a mode switch and a filter that hides its card, and the editor can
 * see that it is open.
 *
 * "Use current abstract" (EVIDENCE-RECORDS-001C2C-B) is the third kind of
 * write, under the same rules again. `updateSource` saves the library abstract
 * the comparison displayed as a link's new saved copy — or its first — through
 * `evidence_rebase_source`:
 *   * it is offered only to a user who may write, with no unsaved edit, no
 *     open Flag note, nothing else in flight or in doubt and no sign of a
 *     change made elsewhere (`sourceUpdateHold`), and only for a candidate
 *     taken from the record as loaded (`checkSourceUpdateCandidate`); each is
 *     checked again here, at the write, whatever the button showed;
 *   * one confirmation is one request: the SHA-256 of the exact text displayed
 *     (`abstractSha256`), prepared once with one request id. Without Web
 *     Crypto, or when the digest fails, nothing is sent;
 *   * while its outcome is unknown the request is kept, every other write and
 *     edit waits, and "Try again" (`retrySourceUpdate`) resends THAT request —
 *     the server replays it instead of saving a second copy. Reloading abandons
 *     it, and the record read back shows whether it was saved;
 *   * a refusal is reported as the server classified it, and its request is
 *     retired. `source_changed_again` needs a fresh read of the library
 *     abstract and a new confirmation; a version conflict, a reload; any other
 *     refusal, a reload before another attempt;
 *   * on success the record is read back, checked against the server's answer,
 *     and the draft — which had no unsaved edit, and could take none while the
 *     write ran — starts again from it, so no reference to the old copy stays.
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

/** Why a review was not recorded. */
export type ReviewFailure =
  /** The server refused it; nothing was applied. */
  | { readonly kind: "refused"; readonly error: EvidenceError }
  /** Not sent: the saved value is no longer the version the card showed, or no longer exists. */
  | { readonly kind: "stale_version" }
  | { readonly kind: "not_recorded" };

export type ReviewActionState =
  | { readonly status: "idle" }
  | { readonly status: "working"; readonly valueId: ValueId; readonly action: ReviewAction }
  | { readonly status: "failed"; readonly valueId: ValueId; readonly action: ReviewAction; readonly failure: ReviewFailure }
  /** The outcome is unknown, or the request failed for a reason worth resending as is: Try again resends the SAME request. */
  | { readonly status: "uncertain"; readonly valueId: ValueId; readonly action: ReviewAction; readonly error: EvidenceError };

/** What became of one press of Confirm or Flag (or of Try again). */
export type ReviewOutcome =
  /** The server answered: the value now holds this review. `unchanged`: it already did, and nothing was written. */
  | { readonly kind: "done"; readonly status: "applied" | "replayed" | "unchanged"; readonly reviewStatus: "user_reviewed" | "disputed" }
  /** Sent, and not recorded, or not known to be: `reviewAction` says which. */
  | { readonly kind: "failed" }
  /** Nothing was sent: the action was not offered for this value right now. */
  | { readonly kind: "not_sent" };

/** The value a card showed: its id, and the `value_version` on screen when the user pressed. */
export interface ReviewTarget {
  readonly valueId: ValueId;
  readonly shownVersion: number;
}

/** Why "Use current abstract" sent nothing. */
export type SourceUpdateNotSent =
  /** The record, the link or its copy changed since the abstract was shown, or the library was not read again after it changed. */
  | "stale"
  /** The abstract can't be a saved copy (too long, empty, the copy limit). */
  | "ineligible"
  /** This browser has no Web Crypto digest. */
  | "digest_unavailable"
  | "digest_failed"
  /** The request could not be prepared. */
  | "invalid_request";

/**
 * "Use current abstract" — the rebase — from confirmation to its answer
 * (EVIDENCE-RECORDS-001C2C-B). `paperId` is the link it is for.
 */
export type SourceUpdateState =
  | { readonly status: "idle" }
  /** Computing the SHA-256 of the confirmed text: nothing is sent yet. */
  | { readonly status: "preparing"; readonly paperId: PaperId }
  | { readonly status: "working"; readonly paperId: PaperId }
  /** The server answered — `result.status` says how — and the record was read back. */
  | { readonly status: "done"; readonly paperId: PaperId; readonly result: RebaseSourceResult }
  /** The server answered, but the record couldn't be read back as it said: the copy is saved — reload to see it. */
  | { readonly status: "reload_failed"; readonly paperId: PaperId; readonly result: RebaseSourceResult }
  /** Nothing was sent. */
  | { readonly status: "not_sent"; readonly paperId: PaperId; readonly reason: SourceUpdateNotSent }
  /** The library abstract is no longer the text the user saw: read it again, then confirm again. */
  | { readonly status: "source_changed"; readonly paperId: PaperId; readonly error: EvidenceError }
  /** The record changed elsewhere: reload. */
  | { readonly status: "conflict"; readonly paperId: PaperId; readonly error: EvidenceError }
  /** The account may no longer write study records. */
  | { readonly status: "not_enabled"; readonly paperId: PaperId; readonly error: EvidenceError }
  /** Any other refusal: nothing was saved, and another attempt waits for a reload. */
  | { readonly status: "failed"; readonly paperId: PaperId; readonly error: EvidenceError }
  /** The outcome is unknown, or the request failed for a reason worth resending as is: Try again resends the SAME request. */
  | { readonly status: "uncertain"; readonly paperId: PaperId; readonly error: EvidenceError };

/** Why "Use current abstract" waits, in the order it is checked. */
export type SourceUpdateHold =
  /** Another write is in flight. */
  | "busy"
  /** An earlier action's outcome is unknown, or the record must be reloaded. */
  | "unresolved"
  /** The record was changed elsewhere: reload first. */
  | "changed_elsewhere"
  /** The draft has unsaved edits: save or undo them first. */
  | "unsaved_changes"
  /** A Flag note is open in Review: send or cancel it first. */
  | "flag_open"
  /** The last attempt was refused for a reason a reload must clear. */
  | "refused";

/** What became of one confirmation of "Use current abstract" (or of Try again). */
export type SourceUpdateOutcome =
  | { readonly kind: "done"; readonly status: RebaseSourceResult["status"] }
  | { readonly kind: "failed" }
  | { readonly kind: "not_sent" };

const NOT_SENT: ReviewOutcome = Object.freeze({ kind: "not_sent" });
const FAILED: ReviewOutcome = Object.freeze({ kind: "failed" });
const SOURCE_NOT_SENT: SourceUpdateOutcome = Object.freeze({ kind: "not_sent" });
const SOURCE_FAILED: SourceUpdateOutcome = Object.freeze({ kind: "failed" });

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
  /** The SHA-256 of an abstract as displayed (Web Crypto). */
  readonly digest?: (text: string) => Promise<AbstractDigest>;
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
  digest = abstractSha256,
}: UseStudyRecordEditorArgs) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<StudyRecordDraft>(() => createDraft(base));
  const [knownVersion, setKnownVersion] = useState<number>(base.header.version);
  const [save, setSave] = useState<EditorSaveState>({ status: "idle" });
  const [externalChange, setExternalChange] = useState(false);
  const [linkAction, setLinkAction] = useState<WriteActionState>({ status: "idle" });
  const [deletion, setDeletion] = useState<WriteActionState>({ status: "idle" });
  const [reviewAction, setReviewAction] = useState<ReviewActionState>({ status: "idle" });
  const [sourceUpdate, setSourceUpdate] = useState<SourceUpdateState>({ status: "idle" });
  // G3: each open Flag note, by value — kept across a mode switch and a filter that hides its card.
  const [flagNotes, setFlagNotes] = useState<ReadonlyMap<ValueId, string>>(() => new Map());
  const runRef = useRef<SaveRun | null>(null);
  const busyRef = useRef(false);
  const linkRequestRef = useRef<SetLinkRequest | null>(null);
  const deleteRequestRef = useRef<DeleteStudyRequest | null>(null);
  const reviewRequestRef = useRef<ReviewFieldRequest | null>(null);
  const sourceRequestRef = useRef<RebaseSourceRequest | null>(null);
  // Set the moment a rebase starts, cleared only once its outcome is known: no edit or write slips in before a render.
  const sourceLockRef = useRef(false);
  // When the server last said the library abstract changed again: a new attempt needs a read finished after it.
  const sourceChangedAtRef = useRef(0);

  const baseValues = useMemo(() => indexBaseValues(base), [base]);
  const issues = useMemo(() => validateDraft(base, baseValues, draft), [base, baseValues, draft]);
  const dirty = useMemo(() => isDraftDirty(base, draft), [base, draft]);
  /** The open Flag notes of values the record still has. */
  const openFlagIds = useMemo(() => base.values.filter((value) => flagNotes.has(value.id)).map((value) => value.id), [base.values, flagNotes]);

  const reviewPending = reviewAction.status === "working" || reviewAction.status === "uncertain";
  const sourceUpdatePending = sourceUpdate.status === "preparing" || sourceUpdate.status === "working" || sourceUpdate.status === "uncertain";
  const locked =
    save.status === "saving" ||
    save.status === "uncertain" ||
    save.status === "gone" ||
    save.status === "not_enabled" ||
    save.status === "reload_failed" ||
    linkAction.status === "working" ||
    deletion.status === "working" ||
    reviewPending ||
    sourceUpdatePending;
  const canEdit = canWrite && !locked;

  // Whether a review may start (Review mode's model, §E5 rows 1–3): every other
  // write in flight or in doubt, and every sign the record changed elsewhere,
  // holds it. A review in doubt holds the others in turn, through `locked`.
  const reviewActivity: ReviewActivity =
    save.status === "saving" ||
    linkAction.status === "working" ||
    deletion.status === "working" ||
    reviewAction.status === "working" ||
    sourceUpdate.status === "preparing" ||
    sourceUpdate.status === "working"
      ? "busy"
      : save.status === "uncertain" ||
          save.status === "reload_failed" ||
          linkAction.status === "uncertain" ||
          deletion.status === "uncertain" ||
          reviewAction.status === "uncertain" ||
          sourceUpdate.status === "uncertain" ||
          sourceUpdate.status === "reload_failed"
        ? "unresolved"
        : save.status === "conflict" || externalChange || (deletion.status === "failed" && deletion.error.kind === "version_conflict")
          ? "changed_elsewhere"
          : "idle";
  const reviewWritable = canWrite && save.status !== "not_enabled" && save.status !== "gone";
  const reviewSources = useMemo(() => describeRecordSources(base), [base]);
  const reviewItems = useMemo(
    () => buildReviewItems(base, draft, { canWrite: reviewWritable, activity: reviewActivity }, reviewSources),
    [base, draft, reviewActivity, reviewSources, reviewWritable],
  );

  // Whether "Use current abstract" may start (C2C-B): the review's holds, then
  // an unsaved edit, an open Flag note, and a refusal only a reload clears.
  const sourceUpdateHold: SourceUpdateHold | null =
    reviewActivity !== "idle"
      ? reviewActivity
      : dirty
        ? "unsaved_changes"
        : openFlagIds.length > 0
          ? "flag_open"
          : sourceUpdate.status === "failed"
            ? "refused"
            : null;

  const invalidateSummaries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.studyRecords.all(userId) });
  }, [queryClient, userId]);

  /** Apply a draft change. Refused while the editor is locked or the user may not edit. */
  const update = useCallback(
    (change: (draft: StudyRecordDraft) => StudyRecordDraft) => {
      if (!canEdit || sourceLockRef.current) return;
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
    if (busyRef.current || sourceLockRef.current || !canWrite || reviewPending || sourceUpdatePending) return;
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
  }, [base, baseValues, canWrite, client, draft, finishPartial, knownVersion, newRequestId, reconcile, reviewPending, sourceUpdatePending, studyId]);

  /**
   * Re-read the record and start the draft again from it. Edits are discarded:
   * the caller confirms first. A review or a rebase whose outcome is in doubt
   * is abandoned: the record read back shows whether it was recorded. An open
   * Flag note is kept.
   */
  const reload = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      runRef.current = null;
      reviewRequestRef.current = null;
      sourceRequestRef.current = null;
      sourceLockRef.current = false;
      setReviewAction({ status: "idle" });
      setSourceUpdate({ status: "idle" });
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
      if (busyRef.current || sourceLockRef.current || !canWrite || dirtyLocked(save) || reviewPending || sourceUpdatePending) return;
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
    [canWrite, client, knownVersion, newRequestId, reconcile, reviewPending, save, sourceUpdatePending, studyId],
  );

  /**
   * Delete the study record. Not gated: whoever owns it can always delete it.
   * It waits only while a review or a rebase is in flight or in doubt (try that
   * again or reload first). Resolves to true when it is gone (deleted now, or
   * already absent).
   */
  const deleteStudy = useCallback(async (): Promise<boolean> => {
    if (busyRef.current || sourceLockRef.current || reviewPending || sourceUpdatePending) return false;
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
  }, [client, invalidateSummaries, knownVersion, newRequestId, queryClient, reviewPending, sourceUpdatePending, studyId, userId]);

  const clearDeletionError = useCallback(() => setDeletion({ status: "idle" }), []);
  const clearLinkError = useCallback(() => setLinkAction({ status: "idle" }), []);

  /** G3: open the Flag note of one saved value — starting from its current flag's note, if it has one. A note already open is kept as typed. */
  const openFlag = useCallback(
    (valueId: ValueId) => {
      const value = base.values.find((candidate) => candidate.id === valueId);
      if (!value) return;
      const start = value.review.status === "disputed" ? value.review.note ?? "" : "";
      setFlagNotes((current) => (current.has(valueId) ? current : new Map(current).set(valueId, start)));
    },
    [base.values],
  );
  /** G3: the note as the user types it. Only an open note changes. */
  const editFlagNote = useCallback((valueId: ValueId, note: string) => {
    setFlagNotes((current) => (current.has(valueId) && current.get(valueId) !== note ? new Map(current).set(valueId, note) : current));
  }, []);
  /** G3: close a Flag note — after Cancel, or once the flag is recorded. */
  const closeFlag = useCallback((valueId: ValueId) => {
    setFlagNotes((current) => {
      if (!current.has(valueId)) return current;
      const next = new Map(current);
      next.delete(valueId);
      return next;
    });
  }, []);

  /** Send one prepared review and route its answer. The request is kept only while its outcome is in doubt. */
  const sendReview = useCallback(
    async (request: ReviewFieldRequest): Promise<ReviewOutcome> => {
      const subject = { valueId: request.valueId, action: request.action };
      setReviewAction({ status: "working", ...subject });
      const outcome = await client.reviewField(request);
      if (!outcome.ok) {
        const { error } = outcome;
        if (error.retry === "same_request") {
          // Keep the prepared request: Try again resends it, and the server replays it if it was applied.
          setReviewAction({ status: "uncertain", ...subject, error });
          return FAILED;
        }
        reviewRequestRef.current = null;
        setReviewAction({ status: "failed", ...subject, failure: { kind: "refused", error } });
        if (error.kind === "version_conflict") setSave({ status: "conflict", applied: 0, total: 0 });
        else if (error.kind === "records_not_enabled") setSave({ status: "not_enabled", applied: 0, total: 0 });
        else if (error.kind === "study_not_found") setSave({ status: "gone" });
        return FAILED;
      }
      reviewRequestRef.current = null;
      // A recorded flag closes its note — whether the first press or Try again recorded it.
      if (request.action === "flag") closeFlag(request.valueId);
      // A review changes no value_version, so reading back keeps every unsaved edit as it is.
      const settled = await reconcile(outcome.result.studyVersion, [], new Map(), new Map());
      setReviewAction({ status: "idle" });
      if (settled === "gone") setSave({ status: "gone" });
      if (settled === "reload_failed") setSave({ status: "reload_failed", applied: 0, total: 0 });
      return Object.freeze({ kind: "done", status: outcome.result.status, reviewStatus: outcome.result.reviewStatus });
    },
    [client, closeFlag, reconcile],
  );

  /**
   * Confirm or Flag one saved value, as its card showed it. Sends nothing unless
   * Review mode's model offers the action for that value now; Flag also needs a
   * note `checkFlag` allows that differs from the value's current flag. One
   * press is one request with a new request id; nothing is retried.
   */
  const review = useCallback(
    async (target: ReviewTarget, action: ReviewAction, note: string | null): Promise<ReviewOutcome> => {
      if (busyRef.current || sourceLockRef.current || !reviewWritable || reviewActivity !== "idle") return NOT_SENT;
      const state = reviewTargetState(reviewItems, target.valueId, target.shownVersion);
      if (state.kind !== "current") {
        // The card no longer shows the saved value: send nothing, and say a reload is needed.
        setReviewAction({ status: "failed", valueId: target.valueId, action, failure: { kind: state.kind } });
        return NOT_SENT;
      }
      const { item } = state;
      if (action === "confirm" && item.confirm.kind !== "offered") return NOT_SENT;
      if (action === "flag") {
        if (item.flag.kind !== "offered" || note === null || checkFlag(item.value, target.shownVersion, note).kind !== "allowed") return NOT_SENT;
        if (item.value.review.status === "disputed" && item.value.review.note === note) return NOT_SENT;
      }
      busyRef.current = true;
      try {
        const prepared = prepareReviewField({
          studyId,
          expectedVersion: knownVersion,
          valueId: item.value.id,
          expectedValueVersion: target.shownVersion,
          action,
          note,
          requestId: newRequestId(),
        });
        if (!prepared.ok) return NOT_SENT;
        reviewRequestRef.current = prepared.request;
        return await sendReview(prepared.request);
      } finally {
        busyRef.current = false;
      }
    },
    [knownVersion, newRequestId, reviewActivity, reviewItems, reviewWritable, sendReview, studyId],
  );

  /** Resend the review whose outcome is in doubt: the SAME prepared request, never a new request id. */
  const retryReview = useCallback(async (): Promise<ReviewOutcome> => {
    const request = reviewRequestRef.current;
    if (busyRef.current || !request || reviewAction.status !== "uncertain") return NOT_SENT;
    busyRef.current = true;
    try {
      return await sendReview(request);
    } finally {
      busyRef.current = false;
    }
  }, [reviewAction.status, sendReview]);

  /** Dismiss a refused review. A review in doubt is not dismissed: try it again or reload. */
  const clearReviewError = useCallback(() => setReviewAction((current) => (current.status === "failed" ? { status: "idle" } : current)), []);

  /**
   * Send one prepared rebase and route its answer (C2C-B). The request is kept
   * only while its outcome is in doubt; on any answer the record is read back
   * and checked against it, and the draft starts again from the record.
   */
  const sendSourceUpdate = useCallback(
    async (request: RebaseSourceRequest): Promise<SourceUpdateOutcome> => {
      const { paperId } = request;
      setSourceUpdate({ status: "working", paperId });
      const outcome = await client.rebaseSource(request);
      if (!outcome.ok) {
        const { error } = outcome;
        if (error.retry === "same_request") {
          // Keep the prepared request — and the lock: Try again resends it, and the server replays it if it was applied.
          setSourceUpdate({ status: "uncertain", paperId, error });
          return SOURCE_FAILED;
        }
        sourceRequestRef.current = null;
        sourceLockRef.current = false;
        if (error.kind === "source_changed_again") {
          sourceChangedAtRef.current = Date.now();
          setSourceUpdate({ status: "source_changed", paperId, error });
        } else if (error.kind === "version_conflict") {
          setSourceUpdate({ status: "conflict", paperId, error });
          setSave({ status: "conflict", applied: 0, total: 0 });
        } else if (error.kind === "records_not_enabled") {
          setSourceUpdate({ status: "not_enabled", paperId, error });
          setSave({ status: "not_enabled", applied: 0, total: 0 });
        } else {
          setSourceUpdate({ status: "failed", paperId, error });
          if (error.kind === "study_not_found") setSave({ status: "gone" });
        }
        return SOURCE_FAILED;
      }
      sourceRequestRef.current = null;
      const { result } = outcome;
      setKnownVersion(result.studyVersion);
      invalidateSummaries();
      const fresh = await refetch();
      sourceLockRef.current = false;
      if (fresh === null) {
        setSourceUpdate({ status: "done", paperId, result });
        setSave({ status: "gone" });
        return Object.freeze({ kind: "done", status: result.status });
      }
      // The record read back must hold what the server reported: at its version, the link's current copy is the answer's.
      const sameVersion = fresh !== undefined && fresh.header.version === result.studyVersion;
      const current = fresh?.links.find((link) => link.link.paperId === paperId)?.currentCopy ?? null;
      if (fresh === undefined || (sameVersion && (current?.id !== result.snapshotId || current.seq !== result.seq))) {
        setSourceUpdate({ status: "reload_failed", paperId, result });
        setSave({ status: "reload_failed", applied: 0, total: 0 });
        return Object.freeze({ kind: "done", status: result.status });
      }
      if (!sameVersion) setExternalChange(true);
      // Sent only with no unsaved edit, and no edit could start while it ran: the draft starts again from the record read back.
      setDraft(createDraft(fresh));
      setSourceUpdate({ status: "done", paperId, result });
      return Object.freeze({ kind: "done", status: result.status });
    },
    [client, invalidateSummaries, refetch],
  );

  /**
   * "Use current abstract": save `candidate` — the library abstract exactly as
   * the comparison displayed it — as its link's new saved copy. Sends nothing
   * unless the action is offered now and the candidate was taken from the
   * record as loaded (and, after the server said the library changed again,
   * from a read finished since). One confirmation is one request, with a new
   * request id; nothing is retried by itself.
   */
  const updateSource = useCallback(
    async (candidate: SourceUpdateCandidate): Promise<SourceUpdateOutcome> => {
      if (busyRef.current || sourceLockRef.current || !reviewWritable || sourceUpdateHold !== null) return SOURCE_NOT_SENT;
      const check = checkSourceUpdateCandidate(base, knownVersion, candidate);
      if (check.kind !== "ready" || candidate.readAt <= sourceChangedAtRef.current) {
        setSourceUpdate({ status: "not_sent", paperId: candidate.paperId, reason: check.kind === "ineligible" ? "ineligible" : "stale" });
        return SOURCE_NOT_SENT;
      }
      busyRef.current = true;
      sourceLockRef.current = true;
      try {
        setSourceUpdate({ status: "preparing", paperId: candidate.paperId });
        const sha = await digest(candidate.text);
        if (!sha.ok) {
          sourceLockRef.current = false;
          setSourceUpdate({ status: "not_sent", paperId: candidate.paperId, reason: sha.reason === "unavailable" ? "digest_unavailable" : "digest_failed" });
          return SOURCE_NOT_SENT;
        }
        const prepared = prepareRebaseSource({
          studyId,
          paperId: candidate.paperId,
          expectedVersion: knownVersion,
          expectedAbstractSha256: sha.sha256,
          requestId: newRequestId(),
        });
        if (!prepared.ok) {
          sourceLockRef.current = false;
          setSourceUpdate({ status: "not_sent", paperId: candidate.paperId, reason: "invalid_request" });
          return SOURCE_NOT_SENT;
        }
        sourceRequestRef.current = prepared.request;
        return await sendSourceUpdate(prepared.request);
      } finally {
        busyRef.current = false;
      }
    },
    [base, digest, knownVersion, newRequestId, reviewWritable, sendSourceUpdate, sourceUpdateHold, studyId],
  );

  /** Resend the rebase whose outcome is in doubt: the SAME prepared request, never a new request id or another digest. */
  const retrySourceUpdate = useCallback(async (): Promise<SourceUpdateOutcome> => {
    const request = sourceRequestRef.current;
    if (busyRef.current || !request || sourceUpdate.status !== "uncertain" || !reviewWritable) return SOURCE_NOT_SENT;
    busyRef.current = true;
    try {
      return await sendSourceUpdate(request);
    } finally {
      busyRef.current = false;
    }
  }, [reviewWritable, sendSourceUpdate, sourceUpdate.status]);

  /**
   * Dismiss what "Use current abstract" last said. A rebase in flight or in
   * doubt is not dismissed (try it again, or reload), and neither is a refusal
   * that waits for a reload.
   */
  const clearSourceUpdate = useCallback(
    () =>
      setSourceUpdate((current) =>
        current.status === "done" || current.status === "not_sent" || current.status === "source_changed" ? { status: "idle" } : current,
      ),
    [],
  );

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
    /** Review mode (EVIDENCE-RECORDS-001C2A): one item per saved value, and what each offers now. */
    reviewItems,
    reviewActivity,
    reviewAction,
    /** Whether a review is in flight or in doubt: every other write waits. */
    reviewPending,
    review,
    retryReview,
    clearReviewError,
    /** G3: each open Flag note by value, and the values whose notes are open. */
    flagNotes,
    openFlagIds,
    openFlag,
    editFlagNote,
    closeFlag,
    /** "Use current abstract" (EVIDENCE-RECORDS-001C2C-B). */
    sourceUpdate,
    /** Whether the user may be offered it at all (the owner pilot, mirrored, and a record still writable). */
    sourceUpdateWritable: reviewWritable,
    /** Why it waits now; null when it may start. */
    sourceUpdateHold,
    /** Whether a rebase is in flight or in doubt: every other write waits. */
    sourceUpdatePending,
    updateSource,
    retrySourceUpdate,
    clearSourceUpdate,
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
