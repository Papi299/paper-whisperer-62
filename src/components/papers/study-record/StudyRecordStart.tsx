import { useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useAbstract } from "@/hooks/useAbstract";
import { useToast } from "@/hooks/use-toast";
import type { EvidenceError } from "@/lib/evidence/errors";
import { DESIGN_PROFILES, DESIGN_PROFILE_LABELS, DESIGN_PROFILE_LIMITATIONS, type DesignProfile } from "@/lib/evidence/fieldDictionary";
import { prepareCreateStudy, type CreateStudyRequest } from "@/lib/evidence/lifecycleRequests";
import { ABSTRACT_MAX_LENGTH, expectSourceCapture } from "@/lib/evidence/sources";
import type { LinkStatus } from "@/lib/evidence/types";
import { validateStudyLabel, VALIDATION_MESSAGES } from "@/lib/evidence/validation";
import { queryKeys } from "@/lib/queryKeys";
import type { StudyRecordWriteAccess } from "@/lib/studyRecord/access";
import { newStudyRecordRequestId, studyRecordClient } from "@/lib/studyRecord/client";
import { StatusFrame } from "./StudyRecordDialog";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

type Original = "yes" | "not_sure" | "no";
const ORIGINAL_CHOICES: readonly Original[] = ["yes", "not_sure", "no"];

/** "Yes" is a confirmed link; "Not sure" a provisional one. "No" creates nothing. */
const LINK_STATUS: Readonly<Record<Exclude<Original, "no">, LinkStatus>> = { yes: "user_confirmed", not_sure: "provisional" };

type CreateState =
  | { readonly status: "idle" }
  | { readonly status: "creating" }
  | { readonly status: "failed"; readonly error: EvidenceError }
  /** The outcome is unknown: "Try again" resends the same request, so nothing is created twice. */
  | { readonly status: "uncertain"; readonly error: EvidenceError };

export interface StudyRecordStartProps {
  readonly userId: string;
  readonly paperId: string;
  readonly paperTitle: string;
  readonly labelSuggestion: string;
  readonly access: StudyRecordWriteAccess;
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
 */
export function StudyRecordStart({
  userId,
  paperId,
  paperTitle,
  labelSuggestion,
  access,
  titleRef,
  onCreated,
  onCancel,
  onClose,
}: StudyRecordStartProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const ids = useId();
  const [original, setOriginal] = useState<Original | null>(null);
  const [family, setFamily] = useState<DesignProfile | null>(null);
  const [label, setLabel] = useState(labelSuggestion);
  const [showErrors, setShowErrors] = useState(false);
  const [state, setState] = useState<CreateState>({ status: "idle" });
  const requestRef = useRef<CreateStudyRequest | null>(null);
  const busyRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const abstract = useAbstract(paperId, userId);

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

  const locked = state.status === "creating" || state.status === "uncertain";
  const labelIssues = validateStudyLabel(label).issues;
  const errors = {
    original: original === null ? VALIDATION_MESSAGES["study.link_status_required"] : null,
    family: family === null && original !== "no" ? VALIDATION_MESSAGES["study.design_profile_required"] : null,
    label: original !== "no" && labelIssues.length > 0 ? labelIssues[0].message : null,
  };
  const capture = abstract.isPending ? null : abstract.isError ? null : expectSourceCapture(abstract.data ?? null);

  async function submit() {
    if (busyRef.current) return;
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
    busyRef.current = true;
    setState({ status: "creating" });
    try {
      const outcome = await studyRecordClient.createStudyFromPaper(request);
      if (outcome.ok) {
        requestRef.current = null;
        void queryClient.invalidateQueries({ queryKey: queryKeys.studyRecords.all(userId) });
        setState({ status: "idle" });
        onCreated(outcome.result.studyId);
        return;
      }
      if (outcome.error.retry === "same_request") setState({ status: "uncertain", error: outcome.error });
      else {
        requestRef.current = null;
        setState({ status: "failed", error: outcome.error });
      }
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      busyRef.current = false;
    }
  }

  const message =
    state.status === "failed" || state.status === "uncertain"
      ? state.error.kind === "records_not_enabled"
        ? STUDY_RECORD_COPY.notAvailable
        : state.error.userMessage
      : null;
  const shownErrors = showErrors ? [errors.original, errors.family, errors.label].filter((e): e is string => !!e) : [];

  return (
    <StatusFrame title={title} titleRef={titleRef}>
      <form
        className="mx-auto max-w-2xl space-y-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm">{STUDY_RECORD_COPY.explainer}</p>

        {(message || shownErrors.length > 0) && (
          <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm focus:outline-none">
            {message ? <p>{message}</p> : shownErrors.map((error) => <p key={error}>{error}</p>)}
          </div>
        )}

        <fieldset disabled={locked} className="space-y-2">
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
            <fieldset disabled={locked} className="space-y-2">
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
                disabled={locked}
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
          <Button type="button" variant="outline" className="coarse:min-h-10" onClick={onCancel} disabled={state.status === "creating"}>
            {STUDY_RECORD_COPY.cancel}
          </Button>
          <Button type="submit" className="coarse:min-h-10" disabled={state.status === "creating"} aria-busy={state.status === "creating" || undefined}>
            {state.status === "creating" && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {original === "no"
              ? STUDY_RECORD_COPY.closeWithoutCreating
              : state.status === "uncertain"
                ? STUDY_RECORD_COPY.tryAgain
                : STUDY_RECORD_COPY.createButton}
          </Button>
        </div>
      </form>
    </StatusFrame>
  );
}
