import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useAbstract } from "@/hooks/useAbstract";
import { useToast } from "@/hooks/use-toast";
import { usePendingStudyCreate } from "@/hooks/useStudyRecordCreations";
import type { EvidenceError } from "@/lib/evidence/errors";
import { DESIGN_PROFILES, DESIGN_PROFILE_LABELS, DESIGN_PROFILE_LIMITATIONS, type DesignProfile } from "@/lib/evidence/fieldDictionary";
import { prepareCreateStudy, type CreateStudyRequest } from "@/lib/evidence/lifecycleRequests";
import { ABSTRACT_MAX_LENGTH, expectSourceCapture } from "@/lib/evidence/sources";
import type { LinkStatus } from "@/lib/evidence/types";
import { validateStudyLabel, VALIDATION_MESSAGES } from "@/lib/evidence/validation";
import type { StudyRecordWriteAccess } from "@/lib/studyRecord/access";
import { newStudyRecordRequestId } from "@/lib/studyRecord/client";
import type { PaperStudySummary } from "@/lib/studyRecord/paperLinks";
import type { CreateAttempt, PendingCreate, PendingCreateStore } from "@/lib/studyRecord/pendingCreates";
import { StatusFrame } from "./StudyRecordDialog";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

type Original = "yes" | "not_sure" | "no";
const ORIGINAL_CHOICES: readonly Original[] = ["yes", "not_sure", "no"];

/** "Yes" is a confirmed link; "Not sure" a provisional one. "No" creates nothing. */
const LINK_STATUS: Readonly<Record<Exclude<Original, "no">, LinkStatus>> = { yes: "user_confirmed", not_sure: "provisional" };
const originalOf = (linkStatus: string): Exclude<Original, "no"> => (linkStatus === "provisional" ? "not_sure" : "yes");

export interface StudyRecordStartProps {
  readonly userId: string;
  readonly paperId: string;
  readonly paperTitle: string;
  readonly labelSuggestion: string;
  readonly access: StudyRecordWriteAccess;
  /** The creates whose outcome is not known yet, kept beyond this view (C1-R1). */
  readonly creations: PendingCreateStore;
  /** The paper's studies as read during this opening of the dialog; null until that read has answered. */
  readonly existing: readonly PaperStudySummary[] | null;
  /** That read failed: nothing may be created until it succeeds. */
  readonly existingFailed: boolean;
  /** Read the paper's studies again. */
  readonly onRefreshExisting: () => Promise<unknown>;
  readonly titleRef: React.RefObject<HTMLHeadingElement>;
  readonly onCreated: (studyId: string) => void;
  readonly onCancel: () => void;
  readonly onClose: () => void;
}

/**
 * "Start a study record" (Requirements-001 §E2). Asks whether the paper
 * reports an original study — never inferred from `study_type`, AI analysis
 * or metadata — which design family's form to use, and a name. Creating calls
 * PR-A2's `evidence_create_study_from_paper` through PR-B's client; the server
 * copies the abstract itself. "No" creates nothing and remembers nothing.
 *
 * The attempt itself lives in the dialog's store of unresolved creates
 * (`pendingCreates.ts`), not here: when its answer is lost, closing and
 * reopening the dialog finds it again, and the only way forward for this
 * paper is to retry that same request — the recovery panel below — until its
 * outcome is known. A creation is offered only after this opening has read
 * the paper's studies from the server, and names those that already exist.
 */
export function StudyRecordStart({
  userId,
  paperId,
  paperTitle,
  labelSuggestion,
  access,
  creations,
  existing,
  existingFailed,
  onRefreshExisting,
  titleRef,
  onCreated,
  onCancel,
  onClose,
}: StudyRecordStartProps) {
  const { toast } = useToast();
  const ids = useId();
  const pending = usePendingStudyCreate(creations, userId, paperId);
  // A form shown once an earlier attempt is settled keeps that attempt's answers.
  const [initial] = useState(() => pending?.request.args ?? null);
  const [original, setOriginal] = useState<Original | null>(initial ? originalOf(initial.p_link_status) : null);
  const [family, setFamily] = useState<DesignProfile | null>(initial ? (initial.p_design_profile as DesignProfile) : null);
  const [label, setLabel] = useState(initial ? initial.p_label : labelSuggestion);
  const [showErrors, setShowErrors] = useState(false);
  const [failure, setFailure] = useState<EvidenceError | null>(null);
  /** The request id this view sent first, so its own first attempt shows as "Creating…", not as a recovery. */
  const [startedId, setStartedId] = useState<string | null>(null);
  const requestRef = useRef<CreateStudyRequest | null>(pending?.request ?? null);
  const watched = useRef<Promise<CreateAttempt> | null>(null);
  const mounted = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const abstract = useAbstract(paperId, userId);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const settle = useCallback(
    (attempt: CreateAttempt) => {
      if (!mounted.current) return;
      if (attempt.kind === "created") {
        onCreated(attempt.result.studyId);
        return;
      }
      if (attempt.kind === "failed") {
        // Nothing was applied. The same answers may resend the same request; other answers are a new action.
        requestRef.current = attempt.error.retry === "same_request" ? attempt.request : null;
        setFailure(attempt.error);
      }
      requestAnimationFrame(() => errorRef.current?.focus());
    },
    [onCreated],
  );

  /** Hear the outcome of `inflight` once, whoever sent it — this view, or one closed before it. */
  const watch = useCallback(
    (inflight: Promise<CreateAttempt>) => {
      if (watched.current === inflight) return;
      watched.current = inflight;
      void inflight.then(settle);
    },
    [settle],
  );
  const inflight = pending?.status === "sending" ? pending.inflight : null;
  useEffect(() => {
    if (inflight) watch(inflight);
  }, [inflight, watch]);

  const title = STUDY_RECORD_COPY.startTitle(paperTitle);
  if (access !== "allowed") {
    return (
      <StatusFrame title={title} titleRef={titleRef}>
        {access === "checking" ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Checking…
          </p>
        ) : (
          <p className="text-sm">
            {access === "unknown" ? STUDY_RECORD_COPY.accessUnknown : `${STUDY_RECORD_COPY.noRecordForPaper} ${STUDY_RECORD_COPY.notAvailable}`}
          </p>
        )}
        <Button type="button" variant="outline" className="mt-4 coarse:min-h-10" onClick={onClose}>
          Close
        </Button>
      </StatusFrame>
    );
  }

  const firstAttemptHere = pending !== null && pending.status === "sending" && pending.attempts === 1 && pending.request.requestId === startedId;
  if (pending && !firstAttemptHere) {
    return (
      <StatusFrame title={title} titleRef={titleRef}>
        <CreateRecovery
          pending={pending}
          existing={existing}
          existingFailed={existingFailed}
          onRefreshExisting={onRefreshExisting}
          errorRef={errorRef}
          onRetry={() => {
            const started = creations.retry(userId, paperId);
            if (started) watch(started);
          }}
          onClose={onClose}
        />
      </StatusFrame>
    );
  }

  const creating = firstAttemptHere;
  const labelIssues = validateStudyLabel(label).issues;
  const errors = {
    original: original === null ? VALIDATION_MESSAGES["study.link_status_required"] : null,
    family: family === null && original !== "no" ? VALIDATION_MESSAGES["study.design_profile_required"] : null,
    label: original !== "no" && labelIssues.length > 0 ? labelIssues[0].message : null,
  };
  const capture = abstract.isPending ? null : abstract.isError ? null : expectSourceCapture(abstract.data ?? null);
  // Creating waits for this opening's read of the paper's studies.
  const readMissing = original !== "no" && existing === null;

  function submit() {
    // An attempt for this paper is on its way or unresolved: only its retry may follow.
    if (pending) return;
    if (original === "no") {
      toast({ title: STUDY_RECORD_COPY.noRecordCreated });
      onClose();
      return;
    }
    if (errors.original || errors.family || errors.label) {
      setShowErrors(true);
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    if (readMissing) return;
    const linkStatus = LINK_STATUS[original as Exclude<Original, "no">];
    // The same answers are the same action: resend the same request (and id).
    let request = requestRef.current;
    const same =
      request &&
      request.args.p_paper_id === paperId.toLowerCase() &&
      request.args.p_label === label &&
      request.args.p_design_profile === family &&
      request.args.p_link_status === linkStatus;
    if (!request || !same) {
      const prepared = prepareCreateStudy({ paperId, label, designProfile: family as DesignProfile, linkStatus, requestId: newStudyRecordRequestId() });
      if (!prepared.ok) {
        setShowErrors(true);
        return;
      }
      request = prepared.request;
      requestRef.current = request;
    }
    setFailure(null);
    setStartedId(request.requestId);
    const started = creations.start(userId, request);
    if (started) watch(started);
  }

  const message = failure ? (failure.kind === "records_not_enabled" ? STUDY_RECORD_COPY.notAvailable : failure.userMessage) : null;
  const shownErrors = showErrors ? [errors.original, errors.family, errors.label].filter((e): e is string => !!e) : [];

  return (
    <StatusFrame title={title} titleRef={titleRef}>
      <form
        className="mx-auto max-w-2xl space-y-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="text-sm">{STUDY_RECORD_COPY.explainer}</p>

        {existingFailed ? (
          <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p>{STUDY_RECORD_COPY.existingFailed}</p>
            <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" onClick={() => void onRefreshExisting()}>
              {STUDY_RECORD_COPY.tryAgain}
            </Button>
          </div>
        ) : existing === null ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {STUDY_RECORD_COPY.existingChecking}
          </p>
        ) : existing.length > 0 ? (
          <p data-testid="study-record-existing-notice" className="rounded-md border bg-muted/40 p-3 text-sm break-words [overflow-wrap:anywhere]">
            {STUDY_RECORD_COPY.existingNotice(existing.map((study) => study.label))}
          </p>
        ) : null}

        {(message || shownErrors.length > 0) && (
          <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm focus:outline-none">
            {message ? <p>{message}</p> : shownErrors.map((error) => <p key={error}>{error}</p>)}
          </div>
        )}

        <fieldset disabled={creating} className="space-y-2">
          <legend id={`${ids}-original`} className="text-sm font-medium">
            {STUDY_RECORD_COPY.originalQuestion}
          </legend>
          <RadioGroup
            aria-labelledby={`${ids}-original`}
            value={original ?? ""}
            onValueChange={(value) => setOriginal(value as Original)}
            className="gap-2"
          >
            {ORIGINAL_CHOICES.map((choice) => (
              <label key={choice} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 coarse:min-h-10">
                <RadioGroupItem value={choice} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{STUDY_RECORD_COPY.originalChoices[choice].label}</span>
                  <span className="block text-xs text-muted-foreground">{STUDY_RECORD_COPY.originalChoices[choice].hint}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          {original === "no" && <p className="text-sm">{STUDY_RECORD_COPY.originalNoExplanation}</p>}
        </fieldset>

        {original !== "no" && (
          <>
            <fieldset disabled={creating} className="space-y-2">
              <legend id={`${ids}-family`} className="text-sm font-medium">
                {STUDY_RECORD_COPY.familyQuestion}
              </legend>
              <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.familyHelp}</p>
              <RadioGroup aria-labelledby={`${ids}-family`} value={family ?? ""} onValueChange={(value) => setFamily(value as DesignProfile)} className="gap-2">
                {DESIGN_PROFILES.map((profile) => (
                  <label key={profile} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 coarse:min-h-10">
                    <RadioGroupItem value={profile} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{DESIGN_PROFILE_LABELS[profile]}</span>
                      {DESIGN_PROFILE_LIMITATIONS[profile] && (
                        <span className="block text-xs text-muted-foreground">{DESIGN_PROFILE_LIMITATIONS[profile]}</span>
                      )}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </fieldset>

            <div className="space-y-2">
              <Label htmlFor={`${ids}-label`}>{STUDY_RECORD_COPY.labelLabel}</Label>
              <Input
                id={`${ids}-label`}
                value={label}
                disabled={creating}
                aria-describedby={`${ids}-label-help`}
                aria-invalid={showErrors && !!errors.label}
                onChange={(event) => setLabel(event.target.value)}
              />
              <p id={`${ids}-label-help`} className="text-xs text-muted-foreground">
                {STUDY_RECORD_COPY.labelHelp}
              </p>
            </div>

            <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="study-record-source-notice">
              {capture === null ? (
                <p className="text-muted-foreground">{abstract.isError ? STUDY_RECORD_COPY.sourceUnknown : STUDY_RECORD_COPY.sourceCheckingAbstract}</p>
              ) : capture.kind === "copy" ? (
                <p>{STUDY_RECORD_COPY.sourceWithAbstract}</p>
              ) : capture.kind === "refused" ? (
                <p>{`This paper's abstract is longer than ${ABSTRACT_MAX_LENGTH.toLocaleString("en-US")} characters, so a study record can't save a copy of it.`}</p>
              ) : (
                <p>{STUDY_RECORD_COPY.sourceNoAbstract}</p>
              )}
            </div>
          </>
        )}

        <div className="flex flex-wrap justify-end gap-2 pb-[env(safe-area-inset-bottom)]">
          <Button type="button" variant="outline" className="coarse:min-h-10" onClick={onCancel} disabled={creating}>
            {STUDY_RECORD_COPY.cancel}
          </Button>
          <Button type="submit" className="coarse:min-h-10" disabled={creating || readMissing} aria-busy={creating || undefined}>
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {original === "no" ? STUDY_RECORD_COPY.closeWithoutCreating : STUDY_RECORD_COPY.createButton}
          </Button>
        </div>
      </form>
    </StatusFrame>
  );
}

interface CreateRecoveryProps {
  readonly pending: PendingCreate;
  readonly existing: readonly PaperStudySummary[] | null;
  readonly existingFailed: boolean;
  readonly onRefreshExisting: () => Promise<unknown>;
  readonly errorRef: React.RefObject<HTMLDivElement>;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

/**
 * An earlier create of this paper whose outcome is unknown (C1-R1). It says
 * what that attempt was, that it may already have created the record, and that
 * trying again resends the very same request — which the server answers with
 * the original record if it was created, and creates it otherwise. A fresh
 * look at the paper's studies is offered, but proves nothing on its own: an
 * empty list is not evidence that the attempt failed. Nothing here starts a
 * new request, and nothing is retried without the user.
 */
function CreateRecovery({ pending, existing, existingFailed, onRefreshExisting, errorRef, onRetry, onClose }: CreateRecoveryProps) {
  const ids = useId();
  const [check, setCheck] = useState<"idle" | "checking" | "done">("idle");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const args = pending.request.args;
  const sending = pending.status === "sending";
  const checkResult =
    check !== "done"
      ? null
      : existingFailed || existing === null
        ? STUDY_RECORD_COPY.recoveryCheckFailed
        : existing.length === 0
          ? STUDY_RECORD_COPY.recoveryCheckNone
          : STUDY_RECORD_COPY.recoveryCheckSome(existing.map((study) => study.label));

  return (
    <section data-testid="study-record-create-recovery" aria-labelledby={`${ids}-heading`} className="mx-auto max-w-2xl space-y-4">
      <h3 id={`${ids}-heading`} className="text-base font-semibold">
        {STUDY_RECORD_COPY.recoveryHeading}
      </h3>
      <p className="text-sm">{STUDY_RECORD_COPY.recoveryBody}</p>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
        <dt className="text-muted-foreground">{STUDY_RECORD_COPY.recoveryName}</dt>
        <dd className="break-words [overflow-wrap:anywhere]">{args.p_label}</dd>
        <dt className="text-muted-foreground">{STUDY_RECORD_COPY.recoveryFamily}</dt>
        <dd>{DESIGN_PROFILE_LABELS[args.p_design_profile as DesignProfile]}</dd>
        <dt className="text-muted-foreground">{STUDY_RECORD_COPY.recoveryOriginal}</dt>
        <dd>{STUDY_RECORD_COPY.originalChoices[originalOf(args.p_link_status)].label}</dd>
      </dl>

      {sending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {STUDY_RECORD_COPY.recoveryWaiting}
        </p>
      ) : (
        pending.error && (
          <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm focus:outline-none">
            <p>{pending.error.userMessage}</p>
          </div>
        )
      )}

      {checkResult && (
        <p aria-live="polite" data-testid="study-record-recovery-check" className="text-sm break-words [overflow-wrap:anywhere]">
          {checkResult}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2 pb-[env(safe-area-inset-bottom)]">
        <Button type="button" variant="ghost" className="coarse:min-h-10" onClick={onClose}>
          Close
        </Button>
        <Button
          type="button"
          variant="outline"
          className="coarse:min-h-10"
          disabled={check === "checking"}
          onClick={() => {
            setCheck("checking");
            void onRefreshExisting().finally(() => {
              if (mounted.current) setCheck("done");
            });
          }}
        >
          {STUDY_RECORD_COPY.recoveryCheck}
        </Button>
        <Button type="button" className="coarse:min-h-10" disabled={sending} aria-busy={sending || undefined} onClick={onRetry}>
          {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {STUDY_RECORD_COPY.tryAgain}
        </Button>
      </div>
    </section>
  );
}
