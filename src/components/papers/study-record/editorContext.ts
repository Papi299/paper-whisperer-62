import { createContext, useContext } from "react";
import type { SourceUpdateHold, SourceUpdateOutcome, SourceUpdateState } from "@/hooks/useStudyRecordEditor";
import type { FieldKey } from "@/lib/evidence/fieldDictionary";
import type { PaperId, SnapshotId } from "@/lib/evidence/ids";
import type { RecordedValue } from "@/lib/evidence/types";
import type { DraftValueEdit, StudyRecordDraft } from "@/lib/studyRecord/draft";
import type { StudyRecordData, StudyRecordLink } from "@/lib/studyRecord/read";
import type { ReviewItem } from "@/lib/studyRecord/reviewModel";
import type { SourceUpdateCandidate } from "@/lib/studyRecord/sourceUpdate";
import type { DraftIssue, IssueTarget } from "@/lib/studyRecord/validateDraft";

/** A question to confirm before a change that removes or clears something. */
export interface ConfirmRequest {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}

/**
 * Edit holds the draft; Review shows the saved values, one card each
 * (EVIDENCE-RECORDS-001C2A); History lists the committed operations, read-only
 * (EVIDENCE-RECORDS-001C2B).
 */
export type EditorMode = "edit" | "review" | "history";

/**
 * What the Source pane shows (EVIDENCE-RECORDS-001C2C-A): the shown link's
 * current saved copy — the one new quotes come from, and the only one "Use as
 * quote" works on — its comparison with the library abstract, or one of the
 * link's saved copies, read-only.
 */
export type SourceView =
  | { readonly kind: "current" }
  | { readonly kind: "compare" }
  | { readonly kind: "copy"; readonly snapshotId: SnapshotId };

/**
 * "Use current abstract" as the Source pane reaches it (EVIDENCE-RECORDS-001C2C-B):
 * the editor hook's rebase — its state, why it waits, and the calls that start,
 * retry or dismiss it. The pane prepares and sends nothing itself.
 */
export interface SourceUpdateControls {
  readonly state: SourceUpdateState;
  /** Whether it may be offered at all: the owner pilot, mirrored, and a record still writable. */
  readonly writable: boolean;
  /** Why it waits now; null when it may start. */
  readonly hold: SourceUpdateHold | null;
  /** The study version the editor writes against: a candidate is taken at it. */
  readonly knownVersion: number;
  /** One per saved value, as Review names it: the confirmation lists the fields whose reviews change. */
  readonly reviewItems: readonly ReviewItem[];
  readonly start: (candidate: SourceUpdateCandidate) => Promise<SourceUpdateOutcome>;
  readonly retry: () => Promise<SourceUpdateOutcome>;
  readonly dismiss: () => void;
  /** Reload the record — asking first when the draft has unsaved changes. */
  readonly reload: () => void;
}

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
  /** The signed-in user the record is read for: every read the editor makes is theirs. */
  readonly userId: string;
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
  /** Show another linked paper's current copy. */
  readonly setSourcePaperId: (paperId: string) => void;
  readonly sourceView: SourceView;
  readonly setSourceView: (view: SourceView) => void;
  /** Show one saved copy of a linked paper's abstract — on a phone, in the Source tab. Read-only, and reads nothing but that copy. */
  readonly showSavedCopy: (paperId: PaperId, snapshotId: SnapshotId) => void;
  /** "Use current abstract" (C2C-B). */
  readonly sourceUpdate: SourceUpdateControls;
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

/**
 * Focus the heading of a Source-pane view the user has just opened (C2C-A) —
 * the comparison or a saved copy — once it is on screen: a tab switch on a
 * phone can take a frame or two, so this waits up to a few frames. Only an
 * explicit opening moves focus; a view shown again after a mode switch keeps
 * focus where the user put it.
 */
export function focusOpenedSourceView(root: () => HTMLElement | null | undefined, framesLeft = 6) {
  focusWhenShown(() => root()?.querySelector<HTMLElement>("[data-source-view-heading]"), framesLeft);
}

/**
 * Focus an element once it is on screen — rendered, and not inside a hidden
 * part or an inactive tab — waiting up to a few frames, never longer. Used for
 * what "Use current abstract" answered (C2C-B), which can land after a view or
 * tab change.
 */
export function focusWhenShown(element: () => HTMLElement | null | undefined, framesLeft = 6) {
  requestAnimationFrame(() => {
    const target = element();
    if (!target || target.closest("[hidden], [data-state='inactive']")) {
      if (framesLeft > 0) focusWhenShown(element, framesLeft - 1);
      return;
    }
    target.focus();
  });
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
