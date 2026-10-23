/**
 * Checking a draft before it is sent (EVIDENCE-RECORDS-001C1).
 *
 * Advisory, like the PR-B library it calls: the server's RPCs decide. This
 * runs the same rules in the browser so most problems are shown next to the
 * field before anything is sent:
 *
 *   * the study header — `validateStudyLabel` / `validateStudyNotes`;
 *   * group and outcome names (PR-A3: not blank after normalization v1, and
 *     at most 120 / 200 characters) and the accepted count limits;
 *   * every value the user touched — `validateValueDraft`, with the record's
 *     real context: the design family, the group's role, the study's links and
 *     their current saved copies, and the current copies' text so abstract
 *     quotes are matched in the browser too.
 *
 * Issues carry where they point (`IssueTarget`) so the editor can show each
 * one at its input and move focus to the first.
 */

import { fieldKeysFor, type FieldKey } from "@/lib/evidence/fieldDictionary";
import { ARM_LABEL_MAX_LENGTH, EVIDENCE_FIELD_LIMITS, OUTCOME_LABEL_MAX_LENGTH } from "@/lib/evidence/fieldRequests";
import { codePointLength, findPostgresTextProblem, isNormalizationEmpty } from "@/lib/evidence/normalization";
import type { RecordedValue } from "@/lib/evidence/types";
import {
  validateStudyLabel,
  validateStudyNotes,
  validateValueDraft,
  type IssuePath,
  type LinkSources,
  type ValueContext,
  type ValueTargetContext,
} from "@/lib/evidence/validation";
import {
  armTarget,
  isInterventionFamily,
  outcomeTarget,
  parseTargetKey,
  parseValueKey,
  STUDY_TARGET,
  toFieldContent,
  toReferenceDraft,
  valueKey,
  viewValue,
  type StudyRecordDraft,
} from "./draft";
import type { StudyRecordData } from "./read";

export type IssueTarget =
  | { readonly kind: "header"; readonly field: "label" | "notes" | "designProfile" }
  | { readonly kind: "arm"; readonly key: string }
  | { readonly kind: "outcome"; readonly key: string }
  | { readonly kind: "value"; readonly key: string }
  | { readonly kind: "record" };

export interface DraftIssue {
  readonly target: IssueTarget;
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  /** Inside a value: the validator's path (`["references", 1, "quoteText"]`). */
  readonly path: IssuePath;
}

/** The study's links as the validator needs them: each paper, its current copy and every copy. */
export function linkSourcesOf(base: StudyRecordData): LinkSources[] {
  return base.links.map((link) => ({
    paperId: link.link.paperId,
    currentSnapshotId: link.currentCopy?.id ?? null,
    snapshotIds: link.snapshots.map((snapshot) => snapshot.id),
  }));
}

/** The text of each link's current copy, by snapshot id, for matching quotes in the browser. */
export function copyTextsOf(base: StudyRecordData): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  for (const link of base.links) if (link.currentCopy) texts.set(link.currentCopy.id, link.currentCopy.exactText);
  return texts;
}

const isUsableLabel = (label: string) => !findPostgresTextProblem(label) && !isNormalizationEmpty(label);

export const ARM_LABEL_MESSAGES = {
  required: "Give the group a name.",
  tooLong: `Group names can be up to ${ARM_LABEL_MAX_LENGTH} characters.`,
} as const;
export const OUTCOME_LABEL_MESSAGES = {
  required: "Give the outcome a name.",
  tooLong: `Outcome names can be up to ${OUTCOME_LABEL_MAX_LENGTH} characters.`,
} as const;

/** The context `validateValueDraft` checks one target's values in. */
export function valueContextFor(base: StudyRecordData, draft: StudyRecordDraft, target: string): ValueContext | null {
  const parsed = parseTargetKey(target);
  let targetContext: ValueTargetContext;
  if (parsed.scope === "study") targetContext = { scope: "study" };
  else if (parsed.scope === "arm") {
    const arm = draft.arms.find((candidate) => candidate.key === parsed.key);
    if (!arm) return null;
    targetContext = { scope: "arm", armRole: arm.role };
  } else {
    if (!draft.outcomes.some((candidate) => candidate.key === parsed.key)) return null;
    targetContext = { scope: "outcome" };
  }
  return { designProfile: draft.header.designProfile, target: targetContext, links: linkSourcesOf(base), copyTexts: copyTextsOf(base) };
}

/** The fields the form shows for a target, in dictionary order. */
export function visibleFieldKeys(draft: StudyRecordDraft, target: string): FieldKey[] {
  const parsed = parseTargetKey(target);
  if (parsed.scope === "study") return fieldKeysFor("study", draft.header.designProfile);
  if (parsed.scope === "outcome") return fieldKeysFor("outcome", draft.header.designProfile);
  const arm = draft.arms.find((candidate) => candidate.key === parsed.key);
  return arm ? fieldKeysFor("arm", draft.header.designProfile, arm.role) : [];
}

/** Every issue of the draft, errors and warnings, in a stable order. */
export function validateDraft(base: StudyRecordData, baseValues: ReadonlyMap<string, RecordedValue>, draft: StudyRecordDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const push = (target: IssueTarget, code: string, message: string, severity: "error" | "warning" = "error", path: IssuePath = []) =>
    issues.push(Object.freeze({ target, code, message, severity, path }));

  for (const issue of validateStudyLabel(draft.header.label).issues) push({ kind: "header", field: "label" }, issue.code, issue.message);
  for (const issue of validateStudyNotes(draft.header.notes === "" ? null : draft.header.notes).issues) {
    push({ kind: "header", field: "notes" }, issue.code, issue.message);
  }

  const intervention = isInterventionFamily(draft.header.designProfile);
  if (!intervention && draft.arms.length > 0) {
    push({ kind: "header", field: "designProfile" }, "study.groups_not_allowed", "A study without an assigned intervention has no groups. Remove the groups first.");
  }
  if (draft.arms.length > EVIDENCE_FIELD_LIMITS.armsPerStudy) {
    push({ kind: "record" }, "limit.arms", `A study record can have up to ${EVIDENCE_FIELD_LIMITS.armsPerStudy} groups.`);
  }
  if (draft.outcomes.length > EVIDENCE_FIELD_LIMITS.outcomesPerStudy) {
    push({ kind: "record" }, "limit.outcomes", `A study record can have up to ${EVIDENCE_FIELD_LIMITS.outcomesPerStudy} outcomes.`);
  }
  for (const arm of draft.arms) {
    if (!isUsableLabel(arm.displayLabel)) push({ kind: "arm", key: arm.key }, "arm.label_required", ARM_LABEL_MESSAGES.required);
    else if (codePointLength(arm.displayLabel) > ARM_LABEL_MAX_LENGTH) push({ kind: "arm", key: arm.key }, "arm.label_too_long", ARM_LABEL_MESSAGES.tooLong);
  }
  for (const outcome of draft.outcomes) {
    if (!isUsableLabel(outcome.displayLabel)) push({ kind: "outcome", key: outcome.key }, "outcome.label_required", OUTCOME_LABEL_MESSAGES.required);
    else if (codePointLength(outcome.displayLabel) > OUTCOME_LABEL_MAX_LENGTH) {
      push({ kind: "outcome", key: outcome.key }, "outcome.label_too_long", OUTCOME_LABEL_MESSAGES.tooLong);
    }
  }

  // Values that will exist after the save, and the touched ones to check.
  const liveTargets = new Set<string>([
    STUDY_TARGET,
    ...draft.arms.map((arm) => armTarget(arm.key)),
    ...draft.outcomes.map((outcome) => outcomeTarget(outcome.key)),
  ]);
  let recordedAfterSave = 0;
  for (const key of new Set([...baseValues.keys(), ...draft.values.keys()])) {
    const { target, fieldKey } = parseValueKey(key);
    if (!liveTargets.has(target)) continue;
    const { edit, touched } = viewValue(baseValues, draft, key);
    if (edit.cleared || edit.state === null) continue;
    recordedAfterSave += 1;

    const context = valueContextFor(base, draft, target);
    if (!context) continue;
    const visible = visibleFieldKeys(draft, target).includes(fieldKey);
    if (!touched) {
      // A stored value the new family or role no longer allows must be resolved, not hidden.
      if (!visible) push({ kind: "value", key }, "field.not_allowed_for_design", "This field no longer applies to this study record. Clear it first.");
      continue;
    }
    const result = validateValueDraft(
      {
        fieldKey,
        state: edit.state,
        stateReason: edit.state === "unclear" ? edit.stateReason : null,
        content: edit.state === "reported" && edit.content ? toFieldContent(edit.content) : null,
        note: edit.note === "" ? null : edit.note,
        references: edit.references.map(toReferenceDraft),
      },
      context,
    );
    for (const issue of result.issues) push({ kind: "value", key }, issue.code, issue.message, issue.severity, issue.path);
  }
  if (recordedAfterSave > EVIDENCE_FIELD_LIMITS.valuesPerStudy) {
    push({ kind: "record" }, "limit.values", `A study record can hold up to ${EVIDENCE_FIELD_LIMITS.valuesPerStudy} recorded fields.`);
  }
  // The number randomized exists only in the intervention families.
  if (!intervention) {
    const { edit } = viewValue(baseValues, draft, valueKey(STUDY_TARGET, "n_randomized"));
    if (!edit.cleared && edit.state !== null) {
      push({ kind: "header", field: "designProfile" }, "study.n_randomized_not_allowed", "Clear ‘Number randomized’ before changing to a study without an assigned intervention.");
    }
  }
  return issues;
}

export const hasErrors = (issues: readonly DraftIssue[]): boolean => issues.some((issue) => issue.severity === "error");
