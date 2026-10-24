import { createContext, useContext } from "react";
import type { FieldKey } from "@/lib/evidence/fieldDictionary";
import type { RecordedValue } from "@/lib/evidence/types";
import type { DraftValueEdit, StudyRecordDraft } from "@/lib/studyRecord/draft";
import type { StudyRecordData, StudyRecordLink } from "@/lib/studyRecord/read";
import type { DraftIssue, IssueTarget } from "@/lib/studyRecord/validateDraft";

/** A question to confirm before a change that removes or clears something. */
export interface ConfirmRequest {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}

/** Edit holds the draft; Review shows the saved values, one card each (EVIDENCE-RECORDS-001C2A). */
export type EditorMode = "edit" | "review";

/**
 * A request to open what holds a target — its collapsed section, and "More
 * details" for an optional field — so it can take focus. `nonce` makes a
 * repeated request for the same target a new one.
 */
export interface RevealRequest {
  readonly target: IssueTarget;
  readonly nonce: number;
}

/** What every part of the Study Record editor reads and changes. */
export interface EditorContextValue {
  readonly base: StudyRecordData;
  readonly baseValues: ReadonlyMap<string, RecordedValue>;
  readonly draft: StudyRecordDraft;
  readonly issues: readonly DraftIssue[];
  /** Whether inputs accept edits (the owner pilot, and no save in progress or in doubt). */
  readonly canEdit: boolean;
  /** The server's refusal of the last save, where it pointed. */
  readonly refusal: { readonly target: IssueTarget; readonly message: string } | null;
  readonly update: (change: (draft: StudyRecordDraft) => StudyRecordDraft) => void;
  /** Replace one value's edit, computed from its current view. */
  readonly updateValue: (key: string, change: (edit: DraftValueEdit) => Omit<DraftValueEdit, "expectedValueVersion">) => void;
  /** Every paper the study is linked to. */
  readonly links: readonly StudyRecordLink[];
  /** The linked paper whose saved abstract the Source pane shows, and new references name by default. */
  readonly sourceLink: StudyRecordLink | null;
  readonly setSourcePaperId: (paperId: string) => void;
  /** The field that last had focus: the default target of "Use as quote". */
  readonly lastFocusedKey: string | null;
  readonly setLastFocusedKey: (key: string) => void;
  /**
   * Move to a field in Edit (after "Use as quote" on a phone, from an error,
   * or from a Review card): switches to Edit, opens what holds it, focuses it.
   */
  readonly focusTarget: (target: IssueTarget) => void;
  /** The last reveal `focusTarget` asked for; sections and field lists open for it. */
  readonly revealRequest: RevealRequest | null;
  readonly mode: EditorMode;
  readonly confirm: (request: ConfirmRequest) => void;
  readonly newLocalId: () => string;
  /** A field's label, with its group or outcome name when it has one. */
  readonly describeField: (key: string) => string;
  readonly isMobile: boolean;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const context = useContext(EditorContext);
  if (!context) throw new Error("Study record editor context is missing");
  return context;
}

/** Whether `request` asks to reveal `target`. */
export function revealsTarget(request: RevealRequest | null, target: IssueTarget): boolean {
  return request !== null && issueTargetKey(request.target) === issueTargetKey(target);
}

/** The DOM key of an issue target, for `data-issue-target` and focusing. */
export function issueTargetKey(target: IssueTarget): string {
  switch (target.kind) {
    case "header":
      return `header:${target.field}`;
    case "arm":
      return `arm:${target.key}`;
    case "outcome":
      return `outcome:${target.key}`;
    case "value":
      return `value:${target.key}`;
    case "record":
      return "record";
  }
}

export type { FieldKey };
