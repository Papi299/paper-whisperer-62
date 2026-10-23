import { useId } from "react";
import { AlertCircle, Plus, Undo2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { CODE_LABELS, EVIDENCE_FIELDS, type FieldDefinition, type FieldKey } from "@/lib/evidence/fieldDictionary";
import { suggestCount } from "@/lib/evidence/numbers";
import { CHANGED_AFTER_REVIEW_LABEL, REVIEW_STATUS_LABELS } from "@/lib/evidence/review";
import { VALUE_STATE_CHOICE_LABELS } from "@/lib/evidence/states";
import { STATE_REASONS, VALUE_STATES, type StateReason, type ValueState } from "@/lib/evidence/types";
import { trimListEntries } from "@/lib/evidence/validation";
import {
  emptyContent,
  NOT_RECORDED_EDIT,
  revertValue,
  valueKey,
  viewValue,
  type DraftContent,
  type TargetKey,
} from "@/lib/studyRecord/draft";
import type { DraftIssue } from "@/lib/studyRecord/validateDraft";
import { useEditor } from "./editorContext";
import { FieldSources } from "./FieldSources";
import { FIELD_HINTS, STUDY_RECORD_COPY } from "./studyRecordCopy";

const ROWS_BY_LENGTH = (max: number) => (max >= 2000 ? 4 : max >= 1000 ? 3 : 2);

/** One field of the record: its state, its value, its note and its sources (Requirements-001 §E3). */
export function FieldEditor({ target, fieldKey }: { readonly target: TargetKey; readonly fieldKey: FieldKey }) {
  const editor = useEditor();
  const ids = useId();
  const key = valueKey(target, fieldKey);
  const { edit, recorded, touched } = viewValue(editor.baseValues, editor.draft, key);
  const definition: FieldDefinition = EVIDENCE_FIELDS[fieldKey];
  const issues = editor.issues.filter((issue) => issue.target.kind === "value" && issue.target.key === key);
  const refusal = editor.refusal && editor.refusal.target.kind === "value" && editor.refusal.target.key === key ? editor.refusal.message : null;
  const disabled = !editor.canEdit;
  const state = edit.cleared ? null : edit.state;
  const labelId = `${ids}-label`;
  const hint = FIELD_HINTS[fieldKey];
  const reviewed = recorded && recorded.review.status !== "unreviewed" ? recorded.review.status : null;

  const setState = (next: ValueState) =>
    editor.updateValue(key, (current) => ({
      ...current,
      cleared: false,
      state: next,
      content: next === "reported" ? current.content ?? emptyContent(fieldKey) : current.content,
    }));
  const setContent = (content: DraftContent) => editor.updateValue(key, (current) => ({ ...current, content }));
  const setNote = (note: string) => editor.updateValue(key, (current) => ({ ...current, note }));
  const setReason = (stateReason: StateReason) => editor.updateValue(key, (current) => ({ ...current, stateReason }));
  const clear = () => editor.updateValue(key, () => ({ ...NOT_RECORDED_EDIT, cleared: recorded !== null }));
  const undo = () => editor.update((draft) => revertValue(draft, key));

  return (
    <div
      className="space-y-3 rounded-md border p-3"
      data-issue-target={`value:${key}`}
      data-testid={`field-${key}`}
      onFocusCapture={() => editor.setLastFocusedKey(key)}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p id={labelId} className="text-sm font-medium">
            {definition.label}
          </p>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {reviewed && (
            <Badge variant="outline" className="font-normal">
              {touched ? CHANGED_AFTER_REVIEW_LABEL : REVIEW_STATUS_LABELS[reviewed]}
            </Badge>
          )}
          {!disabled && touched && (
            <Button type="button" variant="ghost" size="sm" className="h-8 coarse:min-h-10" onClick={undo} aria-label={`${STUDY_RECORD_COPY.revertField}: ${definition.label}`}>
              <Undo2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      {edit.cleared ? (
        <p className="text-sm">{STUDY_RECORD_COPY.willBeCleared}</p>
      ) : (
        <>
          <RadioGroup
            aria-labelledby={labelId}
            aria-describedby={`${ids}-state-help`}
            value={state ?? ""}
            onValueChange={(value) => setState(value as ValueState)}
            disabled={disabled}
            className="flex flex-wrap gap-x-4 gap-y-2"
          >
            {VALUE_STATES.map((option) => (
              <label key={option} className="flex cursor-pointer items-center gap-2 text-sm coarse:min-h-10">
                <RadioGroupItem value={option} />
                {VALUE_STATE_CHOICE_LABELS[option]}
              </label>
            ))}
          </RadioGroup>
          <p id={`${ids}-state-help`} className="text-xs text-muted-foreground">
            {state === null ? STUDY_RECORD_COPY.notYetRecorded : ""}
          </p>
        </>
      )}

      {state === "reported" && edit.content && (
        <ValueInput fieldKey={fieldKey} definition={definition} content={edit.content} disabled={disabled} onChange={setContent} labelledBy={labelId} />
      )}

      {state === "unclear" && (
        <fieldset disabled={disabled} className="space-y-1">
          <legend className="text-xs font-medium">{STUDY_RECORD_COPY.reasonLegend}</legend>
          <RadioGroup value={edit.stateReason ?? ""} onValueChange={(value) => setReason(value as StateReason)} className="flex flex-wrap gap-x-4 gap-y-2">
            {STATE_REASONS.map((reason) => (
              <label key={reason} className="flex cursor-pointer items-center gap-2 text-sm coarse:min-h-10">
                <RadioGroupItem value={reason} />
                {STUDY_RECORD_COPY.reasons[reason]}
              </label>
            ))}
          </RadioGroup>
        </fieldset>
      )}

      {state !== null && (
        <div className="space-y-1">
          <Label htmlFor={`${ids}-note`} className="text-xs">
            {state === "unclear" || state === "not_applicable" ? STUDY_RECORD_COPY.noteLabel : STUDY_RECORD_COPY.noteOptional}
          </Label>
          <Textarea id={`${ids}-note`} rows={2} value={edit.note} disabled={disabled} onChange={(event) => setNote(event.target.value)} />
        </div>
      )}

      {state !== null && <FieldSources valueKey={key} fieldKey={fieldKey} edit={edit} />}

      {reviewed && touched && <p className="text-xs">{STUDY_RECORD_COPY.reviewChangeWarning}</p>}

      <FieldIssues issues={issues} refusal={refusal} />

      {!disabled && !edit.cleared && state !== null && (
        <Button type="button" variant="link" className="h-auto p-0 text-xs coarse:min-h-10" onClick={clear}>
          {STUDY_RECORD_COPY.clearField}
        </Button>
      )}
    </div>
  );
}

/** A value's issues, worded by the validator; never conveyed by colour alone. */
export function FieldIssues({ issues, refusal }: { readonly issues: readonly DraftIssue[]; readonly refusal?: string | null }) {
  if (issues.length === 0 && !refusal) return null;
  return (
    <ul className="space-y-1 text-xs">
      {refusal && (
        <li className="flex items-start gap-1 text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="sr-only">Not saved: </span>
            {refusal}
          </span>
        </li>
      )}
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className={`flex items-start gap-1 ${issue.severity === "error" ? "text-destructive" : "text-amber-700 dark:text-amber-400"}`}>
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="sr-only">{issue.severity === "error" ? "Error: " : "Note: "}</span>
            {issue.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface ValueInputProps {
  readonly fieldKey: FieldKey;
  readonly definition: FieldDefinition;
  readonly content: DraftContent;
  readonly disabled: boolean;
  readonly labelledBy: string;
  readonly onChange: (content: DraftContent) => void;
}

/** The value of a Reported field, in the input its shape needs. Nothing is rewritten. */
function ValueInput({ fieldKey, definition, content, disabled, labelledBy, onChange }: ValueInputProps) {
  const ids = useId();
  switch (content.shape) {
    case "text":
      return (
        <div className="space-y-1">
          <Label htmlFor={`${ids}-value`} className="text-xs">
            {STUDY_RECORD_COPY.valueLabel}
          </Label>
          <Textarea
            id={`${ids}-value`}
            rows={definition.shape === "text" ? ROWS_BY_LENGTH(definition.text.maxLength) : 2}
            value={content.text}
            disabled={disabled}
            aria-describedby={labelledBy}
            onChange={(event) => onChange({ shape: "text", text: event.target.value })}
          />
        </div>
      );
    case "code": {
      const labels = CODE_LABELS[fieldKey] ?? {};
      const codes = definition.shape === "code" ? definition.codes : [];
      return (
        <div className="space-y-1">
          <Label htmlFor={`${ids}-value`} className="text-xs">
            {STUDY_RECORD_COPY.valueLabel}
          </Label>
          <select
            id={`${ids}-value`}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            value={content.code}
            disabled={disabled}
            aria-describedby={labelledBy}
            onChange={(event) => onChange({ shape: "code", code: event.target.value })}
          >
            <option value="">{STUDY_RECORD_COPY.chooseCode}</option>
            {codes.map((code) => (
              <option key={code} value={code}>
                {labels[code] ?? code}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case "integer_with_reported_text": {
      const suggestion = suggestCount(content.reportedText);
      const showSuggestion = suggestion.kind === "suggestion" && content.valueText === "";
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${ids}-reported`} className="text-xs">
              {STUDY_RECORD_COPY.reportedTextLabel}
            </Label>
            <Input
              id={`${ids}-reported`}
              value={content.reportedText}
              disabled={disabled}
              aria-describedby={`${ids}-reported-help`}
              onChange={(event) => onChange({ ...content, reportedText: event.target.value })}
            />
            <p id={`${ids}-reported-help`} className="text-xs text-muted-foreground">
              {STUDY_RECORD_COPY.reportedTextHelp}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-number`} className="text-xs">
              {STUDY_RECORD_COPY.confirmedNumberLabel}
            </Label>
            <Input
              id={`${ids}-number`}
              inputMode="numeric"
              value={content.valueText}
              disabled={disabled}
              aria-describedby={`${ids}-number-help`}
              onChange={(event) => onChange({ ...content, valueText: event.target.value })}
            />
            <p id={`${ids}-number-help`} className="text-xs text-muted-foreground">
              {STUDY_RECORD_COPY.confirmedNumberHelp}
            </p>
            {showSuggestion && suggestion.kind === "suggestion" && (
              <div className="flex flex-wrap items-center gap-2 text-xs" role="status">
                <span>{STUDY_RECORD_COPY.suggestion(suggestion.value)}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 coarse:min-h-10"
                  disabled={disabled}
                  onClick={() => onChange({ ...content, valueText: String(suggestion.value) })}
                >
                  {STUDY_RECORD_COPY.applySuggestion(suggestion.value)}
                </Button>
              </div>
            )}
          </div>
        </div>
      );
    }
    case "text_list": {
      const { changed } = trimListEntries(content.entries);
      const max = definition.shape === "text_list" ? definition.list.maxEntries : 1;
      return (
        <div className="space-y-2">
          <p className="text-xs font-medium">{STUDY_RECORD_COPY.valueLabel}</p>
          <ul className="space-y-2">
            {content.entries.map((entry, index) => (
              <li key={index} className="flex items-center gap-2">
                <Input
                  aria-label={`${definition.label} — ${STUDY_RECORD_COPY.listEntry(index + 1)}`}
                  value={entry}
                  disabled={disabled}
                  onChange={(event) => {
                    const entries = [...content.entries];
                    entries[index] = event.target.value;
                    onChange({ shape: "text_list", entries });
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 shrink-0"
                  disabled={disabled || content.entries.length <= 1}
                  aria-label={STUDY_RECORD_COPY.removeEntry(index + 1)}
                  onClick={() => onChange({ shape: "text_list", entries: content.entries.filter((_, i) => i !== index) })}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="coarse:min-h-10"
              disabled={disabled || content.entries.length >= max}
              onClick={() => onChange({ shape: "text_list", entries: [...content.entries, ""] })}
            >
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              {STUDY_RECORD_COPY.addEntry}
            </Button>
            {changed.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="coarse:min-h-10"
                disabled={disabled}
                onClick={() => onChange({ shape: "text_list", entries: [...trimListEntries(content.entries).entries] })}
              >
                {STUDY_RECORD_COPY.trimEntries}
              </Button>
            )}
          </div>
        </div>
      );
    }
  }
}

