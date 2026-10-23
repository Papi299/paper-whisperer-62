import { useId, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DESIGN_PROFILE_LABELS,
  DESIGN_PROFILE_LIMITATIONS,
  DESIGN_PROFILES,
  EVIDENCE_FIELDS,
  fieldKeysFor,
  fieldTier,
  type ArmRole,
  type DesignProfile,
  type FieldKey,
  type FieldSection,
} from "@/lib/evidence/fieldDictionary";
import { EVIDENCE_FIELD_LIMITS } from "@/lib/evidence/fieldRequests";
import {
  addArm,
  addOutcome,
  armTarget,
  changeArmRole,
  changeFamily,
  familyChangeImpact,
  isInterventionFamily,
  moveArm,
  moveOutcome,
  outcomeTarget,
  parseValueKey,
  removeArm,
  removeOutcome,
  restoreArm,
  restoreOutcome,
  STUDY_TARGET,
  updateArm,
  updateHeader,
  updateOutcome,
  valueKey,
  valuesDisallowedForRole,
  viewValue,
  type DraftArm,
  type DraftOutcome,
  type TargetKey,
} from "@/lib/studyRecord/draft";
import { useEditor, type EditorContextValue } from "./editorContext";
import { FieldEditor, FieldIssues } from "./FieldEditor";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** The record: its sections, in the order of Requirements-001 §E3. */
export function RecordPane() {
  const editor = useEditor();
  const intervention = isInterventionFamily(editor.draft.header.designProfile);
  const recordIssues = editor.issues.filter((issue) => issue.target.kind === "record");
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6" data-testid="study-record-record-pane">
      {recordIssues.length > 0 && (
        <div data-issue-target="record">
          <FieldIssues issues={recordIssues} />
        </div>
      )}
      <Section title={STUDY_RECORD_COPY.sections.study_design}>
        <StudyHeaderFields />
        <FieldList target={STUDY_TARGET} keys={studyKeys(editor, "study_design")} />
      </Section>
      <Section title={STUDY_RECORD_COPY.sections.participants}>
        <FieldList target={STUDY_TARGET} keys={studyKeys(editor, "participants")} />
      </Section>
      {intervention && (
        <Section title={STUDY_RECORD_COPY.sections.interventions}>
          <GroupsSection />
        </Section>
      )}
      <Section title={STUDY_RECORD_COPY.sections.outcomes}>
        <OutcomesSection />
      </Section>
      <Section title={STUDY_RECORD_COPY.sections.notes}>
        <NotesField />
      </Section>
    </div>
  );
}

function studyKeys(editor: EditorContextValue, section: FieldSection): FieldKey[] {
  return fieldKeysFor("study", editor.draft.header.designProfile).filter((key) => EVIDENCE_FIELDS[key].section === section);
}

/** A collapsible section. Collapsed content stays mounted, so nothing typed into it is lost. */
function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  const ids = useId();
  const [open, setOpen] = useState(true);
  return (
    <section aria-labelledby={`${ids}-heading`} className="rounded-lg border">
      <h3 id={`${ids}-heading`} className="text-sm font-semibold">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring coarse:min-h-10"
          aria-expanded={open}
          aria-controls={`${ids}-content`}
          onClick={() => setOpen((current) => !current)}
        >
          {title}
          {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
        </button>
      </h3>
      <div id={`${ids}-content`} hidden={!open} className="space-y-3 border-t p-3">
        {children}
      </div>
    </section>
  );
}

/** Whether a field holds anything worth keeping in view: a value, an edit or an issue. */
function inUse(editor: EditorContextValue, key: string): boolean {
  const { edit, touched, recorded } = viewValue(editor.baseValues, editor.draft, key);
  return touched || recorded !== null || edit.state !== null || editor.issues.some((issue) => issue.target.kind === "value" && issue.target.key === key);
}

/** Core fields first; optional ones behind "More details" unless they hold something. */
function FieldList({ target, keys }: { readonly target: TargetKey; readonly keys: readonly FieldKey[] }) {
  const editor = useEditor();
  const [more, setMore] = useState(false);
  const profile = editor.draft.header.designProfile;
  const core = keys.filter((key) => fieldTier(key, profile) === "core");
  const optional = keys.filter((key) => fieldTier(key, profile) === "optional");
  const kept = optional.filter((key) => inUse(editor, valueKey(target, key)));
  const hidden = optional.filter((key) => !kept.includes(key));
  const shown = [...core, ...kept, ...(more ? hidden : [])];
  return (
    <div className="space-y-3">
      {keys
        .filter((key) => shown.includes(key))
        .map((key) => (
          <FieldEditor key={key} target={target} fieldKey={key} />
        ))}
      {hidden.length > 0 && (
        <Button type="button" variant="link" className="h-auto p-0 text-sm coarse:min-h-10" aria-expanded={more} onClick={() => setMore((current) => !current)}>
          {more ? STUDY_RECORD_COPY.fewerDetails : `${STUDY_RECORD_COPY.moreDetails} (${hidden.length})`}
        </Button>
      )}
    </div>
  );
}

/** The study's name and design family (PR-A2's header, saved by `evidence_update_study`). */
function StudyHeaderFields() {
  const editor = useEditor();
  const ids = useId();
  const { header } = editor.draft;
  const disabled = !editor.canEdit;
  const labelIssues = editor.issues.filter((issue) => issue.target.kind === "header" && issue.target.field === "label");
  const familyIssues = editor.issues.filter((issue) => issue.target.kind === "header" && issue.target.field === "designProfile");

  const chooseFamily = (profile: DesignProfile) => {
    const impact = familyChangeImpact(editor.baseValues, editor.draft, profile);
    if (impact.groups > 0 || impact.numberRandomized) {
      editor.confirm({
        title: STUDY_RECORD_COPY.familyChangeTitle,
        body: STUDY_RECORD_COPY.familyChangeBody(impact.groups, impact.groupValues, impact.numberRandomized),
        confirmLabel: STUDY_RECORD_COPY.familyChangeConfirm,
        onConfirm: () => editor.update((draft) => changeFamily(editor.baseValues, draft, profile)),
      });
      return;
    }
    editor.update((draft) => updateHeader(draft, { designProfile: profile }));
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1" data-issue-target="header:label">
        <Label htmlFor={`${ids}-label`}>{STUDY_RECORD_COPY.labelLabel}</Label>
        <Input
          id={`${ids}-label`}
          value={header.label}
          disabled={disabled}
          aria-invalid={labelIssues.some((issue) => issue.severity === "error") || undefined}
          onChange={(event) => editor.update((draft) => updateHeader(draft, { label: event.target.value }))}
        />
        <FieldIssues issues={labelIssues} />
      </div>
      <div className="space-y-1" data-issue-target="header:designProfile">
        <Label htmlFor={`${ids}-family`}>{STUDY_RECORD_COPY.familyLabel}</Label>
        <select
          id={`${ids}-family`}
          className={SELECT_CLASS}
          value={header.designProfile}
          disabled={disabled}
          aria-describedby={`${ids}-family-help`}
          onChange={(event) => chooseFamily(event.target.value as DesignProfile)}
        >
          {DESIGN_PROFILES.map((profile) => (
            <option key={profile} value={profile}>
              {DESIGN_PROFILE_LABELS[profile]}
            </option>
          ))}
        </select>
        <p id={`${ids}-family-help`} className="text-xs text-muted-foreground">
          {STUDY_RECORD_COPY.familyHelp}
          {DESIGN_PROFILE_LIMITATIONS[header.designProfile] ? ` ${DESIGN_PROFILE_LIMITATIONS[header.designProfile]}` : ""}
        </p>
        <FieldIssues issues={familyIssues} />
      </div>
    </div>
  );
}

function NotesField() {
  const editor = useEditor();
  const ids = useId();
  const issues = editor.issues.filter((issue) => issue.target.kind === "header" && issue.target.field === "notes");
  return (
    <div className="space-y-1" data-issue-target="header:notes">
      <Label htmlFor={`${ids}-notes`}>{STUDY_RECORD_COPY.notesLabel}</Label>
      <Textarea
        id={`${ids}-notes`}
        rows={4}
        value={editor.draft.header.notes}
        disabled={!editor.canEdit}
        aria-describedby={`${ids}-notes-help`}
        onChange={(event) => editor.update((draft) => updateHeader(draft, { notes: event.target.value }))}
      />
      <p id={`${ids}-notes-help`} className="text-xs text-muted-foreground">
        {STUDY_RECORD_COPY.notesHelp}
      </p>
      <FieldIssues issues={issues} />
    </div>
  );
}

/** How many values a group or outcome holds now (saved, or entered in this draft). */
function recordedValueCount(editor: EditorContextValue, target: TargetKey): number {
  let count = 0;
  for (const key of new Set([...editor.baseValues.keys(), ...editor.draft.values.keys()])) {
    if (parseValueKey(key).target !== target) continue;
    const { edit } = viewValue(editor.baseValues, editor.draft, key);
    if (!edit.cleared && edit.state !== null) count += 1;
  }
  return count;
}

/** Groups of the intervention families (Requirements-001 §E3, §H4). */
function GroupsSection() {
  const editor = useEditor();
  const { draft } = editor;
  const disabled = !editor.canEdit;
  const atLimit = draft.arms.length >= EVIDENCE_FIELD_LIMITS.armsPerStudy;

  const add = (role: ArmRole) => {
    const n = draft.arms.filter((arm) => arm.role === role).length + 1;
    const label = role === "intervention" ? STUDY_RECORD_COPY.newInterventionLabel(n) : STUDY_RECORD_COPY.newComparatorLabel(n);
    const result = addArm(draft, role, label);
    editor.update(() => result.draft);
    editor.focusTarget({ kind: "arm", key: result.key });
  };

  return (
    <div className="space-y-3">
      {draft.arms.length === 0 && <p className="text-sm text-muted-foreground">{STUDY_RECORD_COPY.groupsEmpty}</p>}
      {draft.arms.length < 2 && <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.fewGroups}</p>}
      {draft.arms.map((arm, index) => (
        <GroupCard key={arm.key} arm={arm} index={index} count={draft.arms.length} />
      ))}
      <RemovedList
        entries={draft.removedArms.map((entry) => ({ id: entry.id, label: entry.displayLabel }))}
        disabled={disabled}
        onUndo={(id) => editor.update((current) => restoreArm(editor.base, current, id as never))}
      />
      {!disabled && (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" disabled={atLimit} onClick={() => add("intervention")}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              {STUDY_RECORD_COPY.addIntervention}
            </Button>
            <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" disabled={atLimit} onClick={() => add("comparator")}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              {STUDY_RECORD_COPY.addComparator}
            </Button>
          </div>
          {atLimit && <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.groupLimit}</p>}
        </div>
      )}
    </div>
  );
}

function GroupCard({ arm, index, count }: { readonly arm: DraftArm; readonly index: number; readonly count: number }) {
  const editor = useEditor();
  const ids = useId();
  const disabled = !editor.canEdit;
  const target = armTarget(arm.key);
  const issues = editor.issues.filter((issue) => issue.target.kind === "arm" && issue.target.key === arm.key);
  const name = arm.displayLabel || STUDY_RECORD_COPY.groupRole[arm.role];

  const setRole = (role: ArmRole) => {
    if (valuesDisallowedForRole(editor.baseValues, editor.draft, arm.key, role).length > 0) {
      editor.confirm({
        title: STUDY_RECORD_COPY.roleChangeTitle,
        body: STUDY_RECORD_COPY.roleChangeBody(name),
        confirmLabel: STUDY_RECORD_COPY.roleChangeConfirm,
        onConfirm: () => editor.update((draft) => changeArmRole(editor.baseValues, draft, arm.key, role)),
      });
      return;
    }
    editor.update((draft) => updateArm(draft, arm.key, { role }));
  };
  const remove = () => {
    const values = recordedValueCount(editor, target);
    if (values === 0) {
      editor.update((draft) => removeArm(draft, arm.key));
      return;
    }
    editor.confirm({
      title: STUDY_RECORD_COPY.removeGroupTitle(name),
      body: STUDY_RECORD_COPY.removeWithValues(values),
      confirmLabel: STUDY_RECORD_COPY.removeGroup(name),
      onConfirm: () => editor.update((draft) => removeArm(draft, arm.key)),
    });
  };

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid={`group-${arm.key}`}>
      <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor={`${ids}-role`} className="text-xs">
            Role
          </Label>
          <select id={`${ids}-role`} className={SELECT_CLASS} value={arm.role} disabled={disabled} onChange={(event) => setRole(event.target.value as ArmRole)}>
            <option value="intervention">{STUDY_RECORD_COPY.groupRole.intervention}</option>
            <option value="comparator">{STUDY_RECORD_COPY.groupRole.comparator}</option>
          </select>
        </div>
        <div className="space-y-1" data-issue-target={`arm:${arm.key}`}>
          <Label htmlFor={`${ids}-name`} className="text-xs">
            {STUDY_RECORD_COPY.groupName}
          </Label>
          <Input
            id={`${ids}-name`}
            value={arm.displayLabel}
            disabled={disabled}
            aria-invalid={issues.some((issue) => issue.severity === "error") || undefined}
            onChange={(event) => editor.update((draft) => updateArm(draft, arm.key, { displayLabel: event.target.value }))}
          />
        </div>
      </div>
      <FieldIssues issues={issues} />
      {!disabled && (
        <OrderControls
          label={name}
          canUp={index > 0}
          canDown={index < count - 1}
          onUp={() => editor.update((draft) => moveArm(draft, arm.key, -1))}
          onDown={() => editor.update((draft) => moveArm(draft, arm.key, 1))}
          onRemove={remove}
        />
      )}
      <FieldList target={target} keys={fieldKeysFor("arm", editor.draft.header.designProfile, arm.role)} />
    </div>
  );
}

function OrderControls({
  label,
  canUp,
  canDown,
  onUp,
  onDown,
  onRemove,
}: {
  readonly label: string;
  readonly canUp: boolean;
  readonly canDown: boolean;
  readonly onUp: () => void;
  readonly onDown: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" disabled={!canUp} onClick={onUp} aria-label={STUDY_RECORD_COPY.moveUp(label)}>
        <ArrowUp className="mr-1 h-4 w-4" aria-hidden="true" />
        Move up
      </Button>
      <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" disabled={!canDown} onClick={onDown} aria-label={STUDY_RECORD_COPY.moveDown(label)}>
        <ArrowDown className="mr-1 h-4 w-4" aria-hidden="true" />
        Move down
      </Button>
      <Button type="button" variant="outline" size="sm" className="text-destructive coarse:min-h-10" onClick={onRemove} aria-label={STUDY_RECORD_COPY.removeGroup(label)}>
        <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
        Remove
      </Button>
    </div>
  );
}

function RemovedList({
  entries,
  disabled,
  onUndo,
}: {
  readonly entries: readonly { readonly id: string; readonly label: string }[];
  readonly disabled: boolean;
  readonly onUndo: (id: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <ul className="space-y-1">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2 text-sm">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{STUDY_RECORD_COPY.removedPending(entry.label)}</span>
          {!disabled && (
            <Button type="button" variant="link" className="h-auto p-0 coarse:min-h-10" onClick={() => onUndo(entry.id)}>
              {STUDY_RECORD_COPY.undo}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Outcomes, in every design family (Requirements-001 §H5). */
function OutcomesSection() {
  const editor = useEditor();
  const { draft } = editor;
  const disabled = !editor.canEdit;
  const atLimit = draft.outcomes.length >= EVIDENCE_FIELD_LIMITS.outcomesPerStudy;
  const add = () => {
    const result = addOutcome(draft, STUDY_RECORD_COPY.newOutcomeLabel(draft.outcomes.length + 1));
    editor.update(() => result.draft);
    editor.focusTarget({ kind: "outcome", key: result.key });
  };
  return (
    <div className="space-y-3">
      {draft.outcomes.length === 0 && <p className="text-sm text-muted-foreground">{STUDY_RECORD_COPY.outcomesEmpty}</p>}
      {draft.outcomes.map((outcome, index) => (
        <OutcomeCard key={outcome.key} outcome={outcome} index={index} count={draft.outcomes.length} />
      ))}
      <RemovedList
        entries={draft.removedOutcomes.map((entry) => ({ id: entry.id, label: entry.displayLabel }))}
        disabled={disabled}
        onUndo={(id) => editor.update((current) => restoreOutcome(editor.base, current, id as never))}
      />
      {!disabled && (
        <div className="space-y-1">
          <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" disabled={atLimit} onClick={add}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            {STUDY_RECORD_COPY.addOutcome}
          </Button>
          {atLimit && <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.outcomeLimit}</p>}
        </div>
      )}
    </div>
  );
}

function OutcomeCard({ outcome, index, count }: { readonly outcome: DraftOutcome; readonly index: number; readonly count: number }) {
  const editor = useEditor();
  const ids = useId();
  const disabled = !editor.canEdit;
  const target = outcomeTarget(outcome.key);
  const issues = editor.issues.filter((issue) => issue.target.kind === "outcome" && issue.target.key === outcome.key);
  const name = outcome.displayLabel || "Outcome";
  const remove = () => {
    const values = recordedValueCount(editor, target);
    if (values === 0) {
      editor.update((draft) => removeOutcome(draft, outcome.key));
      return;
    }
    editor.confirm({
      title: STUDY_RECORD_COPY.removeGroupTitle(name),
      body: STUDY_RECORD_COPY.removeWithValues(values),
      confirmLabel: STUDY_RECORD_COPY.removeGroup(name),
      onConfirm: () => editor.update((draft) => removeOutcome(draft, outcome.key)),
    });
  };
  return (
    <div className="space-y-3 rounded-md border p-3" data-testid={`outcome-${outcome.key}`}>
      <div className="space-y-1" data-issue-target={`outcome:${outcome.key}`}>
        <Label htmlFor={`${ids}-name`} className="text-xs">
          {STUDY_RECORD_COPY.outcomeName}
        </Label>
        <Input
          id={`${ids}-name`}
          value={outcome.displayLabel}
          disabled={disabled}
          aria-invalid={issues.some((issue) => issue.severity === "error") || undefined}
          onChange={(event) => editor.update((draft) => updateOutcome(draft, outcome.key, { displayLabel: event.target.value }))}
        />
      </div>
      <FieldIssues issues={issues} />
      {!disabled && (
        <OrderControls
          label={name}
          canUp={index > 0}
          canDown={index < count - 1}
          onUp={() => editor.update((draft) => moveOutcome(draft, outcome.key, -1))}
          onDown={() => editor.update((draft) => moveOutcome(draft, outcome.key, 1))}
          onRemove={remove}
        />
      )}
      <FieldList target={target} keys={fieldKeysFor("outcome", editor.draft.header.designProfile)} />
    </div>
  );
}
