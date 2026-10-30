import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { useStudyRecordData } from "@/hooks/useStudyRecords";
import { useStudyRecordEditor } from "@/hooks/useStudyRecordEditor";
import { DESIGN_PROFILE_LABELS, EVIDENCE_FIELDS } from "@/lib/evidence/fieldDictionary";
import { toStudyId, type PaperId, type SnapshotId, type StudyId } from "@/lib/evidence/ids";
import { IDENTITY_CAVEAT, LINK_STATUS_LABELS } from "@/lib/evidence/identity";
import { NOT_REPORTED_EXPLANATION } from "@/lib/evidence/states";
import { parseTargetKey, parseValueKey, setValueEdit, viewValue } from "@/lib/studyRecord/draft";
import { StudyRecordReadError, type StudyRecordData } from "@/lib/studyRecord/read";
import type { ReviewItem } from "@/lib/studyRecord/reviewModel";
import { hasErrors, type IssueTarget } from "@/lib/studyRecord/validateDraft";
import {
  EditorContext,
  focusOpenedSourceView,
  issueTargetKey,
  useEditor,
  type ConfirmRequest,
  type EditorContextValue,
  type EditorMode,
  type RevealRequest,
  type SourceView,
} from "./editorContext";
import { HISTORY_COPY } from "./historyCopy";
import { HistoryPane } from "./HistoryPane";
import { RecordPane } from "./RecordPane";
import { REVIEW_COPY, reviewErrorText } from "./reviewCopy";
import { ReviewPane } from "./ReviewPane";
import { SourcePane, type SourceDisplay } from "./SourcePane";
import { StatusFrame } from "./StudyRecordDialog";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";
import { useReviewFlow, type ReviewFlow } from "./useReviewFlow";

/** What a field's first control is, for focusing it: its chosen state, else its first input. */
const FOCUSABLE =
  "[role='radio'][data-state='checked']:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex='-1']";

/**
 * Focus the element marked `data-issue-target="<key>"` once it is on screen:
 * the mode switch and the reveal its section and field list make take a
 * render or two, so this waits up to a few frames, never longer.
 */
function focusWhenShown(container: React.RefObject<HTMLElement>, key: string, framesLeft = 6) {
  requestAnimationFrame(() => {
    const host = container.current?.querySelector<HTMLElement>(`[data-issue-target="${key}"]`);
    if (!host || host.closest("[hidden], [data-state='inactive']")) {
      if (framesLeft > 0) focusWhenShown(container, key, framesLeft - 1);
      return;
    }
    host.scrollIntoView({ block: "nearest" });
    const focusable = host.matches("input, textarea, select, button") ? host : host.querySelector<HTMLElement>(FOCUSABLE);
    focusable?.focus();
  });
}

export interface StudyRecordEditorProps {
  readonly userId: string;
  readonly studyId: string;
  /** The paper the dialog was opened from: its saved abstract is shown first. */
  readonly paperId: string;
  readonly canWrite: boolean;
  readonly titleRef: React.RefObject<HTMLHeadingElement>;
  readonly studyCount: number;
  readonly onShowList?: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onDeleted: () => void;
  readonly onRequestClose: () => void;
}

/**
 * The Study Record editor (Requirements-001 §E3–§E7, §E10–§E11). Loads one
 * record through the owner-scoped read (`useStudyRecordData`) and, once it is
 * there, hands it to the workspace; until then it says truthfully that it is
 * loading, failed, or that the record no longer exists.
 */
export function StudyRecordEditor(props: StudyRecordEditorProps) {
  const { userId, studyId, titleRef } = props;
  const record = useStudyRecordData(userId, studyId);
  const refetch = useCallback(async () => {
    const result = await record.refetch();
    if (result.isError) return undefined;
    return result.data ?? null;
  }, [record]);
  const id = toStudyId(studyId);

  if (record.isPending) {
    return (
      <StatusFrame title={STUDY_RECORD_COPY.editorTitle("…")} titleRef={titleRef}>
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading…
        </p>
      </StatusFrame>
    );
  }
  if (record.isError || !id) {
    const integrity = record.error instanceof StudyRecordReadError && record.error.kind === "integrity";
    return (
      <StatusFrame title={STUDY_RECORD_COPY.editorTitle("…")} titleRef={titleRef}>
        <p role="alert" className="text-sm">
          {integrity ? STUDY_RECORD_COPY.recordIntegrity : STUDY_RECORD_COPY.recordLoadFailed}
        </p>
        <Button type="button" variant="outline" className="mt-3 coarse:min-h-10" onClick={() => void record.refetch()}>
          {STUDY_RECORD_COPY.tryAgain}
        </Button>
      </StatusFrame>
    );
  }
  if (record.data === null) {
    return (
      <StatusFrame title={STUDY_RECORD_COPY.editorTitle("…")} titleRef={titleRef}>
        <p className="text-sm">{STUDY_RECORD_COPY.recordGone}</p>
        <div className="mt-3 flex gap-2">
          {props.onShowList && (
            <Button type="button" variant="outline" className="coarse:min-h-10" onClick={props.onShowList}>
              {STUDY_RECORD_COPY.backToList}
            </Button>
          )}
          <Button type="button" variant="ghost" className="coarse:min-h-10" onClick={props.onRequestClose}>
            Close
          </Button>
        </div>
      </StatusFrame>
    );
  }
  return <EditorWorkspace {...props} studyId={id} base={record.data} refetch={refetch} />;
}

interface WorkspaceProps extends Omit<StudyRecordEditorProps, "studyId"> {
  readonly studyId: StudyId;
  readonly base: StudyRecordData;
  readonly refetch: () => Promise<StudyRecordData | null | undefined>;
}

function EditorWorkspace({
  userId,
  studyId,
  paperId,
  base,
  refetch,
  canWrite,
  titleRef,
  studyCount,
  onShowList,
  onDirtyChange,
  onDeleted,
  onRequestClose,
}: WorkspaceProps) {
  const editor = useStudyRecordEditor({ userId, studyId, base, refetch, canWrite });
  const { draft, baseValues, issues, save, dirty, canEdit, update } = editor;
  const isMobile = useIsMobile();
  const [mode, setMode] = useState<EditorMode>("edit");
  const [tab, setTab] = useState<"record" | "source">("record");
  const [sourcePaperId, setSourcePaperId] = useState<string>(() =>
    base.links.some((link) => link.link.paperId === paperId.toLowerCase()) ? paperId.toLowerCase() : base.links[0]?.link.paperId ?? paperId,
  );
  const [lastFocusedKey, setLastFocusedKey] = useState<string | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reloadOpen, setReloadOpen] = useState(false);
  const [revealRequest, setRevealRequest] = useState<RevealRequest | null>(null);
  // The Review card whose source the Source pane shows (desktop).
  const [selectedReviewKey, setSelectedReviewKey] = useState<string | null>(null);
  // What the Source pane shows of the link (C2C-A): its current copy, the comparison, or one saved copy.
  const [sourceView, setSourceView] = useState<SourceView>({ kind: "current" });
  const containerRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const localIdRef = useRef(0);
  const revealNonce = useRef(0);
  const flow = useReviewFlow(editor, titleRef);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // After a refusal, focus moves to the message (Requirements-001 §E11).
  useEffect(() => {
    if (["invalid", "failed", "conflict", "uncertain", "not_enabled", "gone", "reload_failed"].includes(save.status)) {
      alertRef.current?.focus();
    }
  }, [save]);
  // And after a review whose outcome is unknown (C2A): the alert with Try again and Reload.
  useEffect(() => {
    if (editor.reviewAction.status === "uncertain") alertRef.current?.focus();
  }, [editor.reviewAction]);

  const sourceLink = base.links.find((link) => link.link.paperId === sourcePaperId) ?? base.links[0] ?? null;
  const reviewItem =
    editor.reviewItems.find((item) => item.key === selectedReviewKey) ?? editor.reviewItems.find((item) => item.needsReview) ?? editor.reviewItems[0] ?? null;
  const sourceDisplay: SourceDisplay = mode === "review" ? { mode: "review", item: reviewItem } : { mode: "edit" };

  const shownReviewKey = reviewItem?.key ?? null;
  const focusReviewItem = useCallback(
    (item: ReviewItem) => {
      // Another card: the pane goes back to the current copy, where that card's source is.
      if (item.key !== shownReviewKey) setSourceView({ kind: "current" });
      setSelectedReviewKey(item.key);
      if (item.abstractPaperIds.length > 0 && !item.abstractPaperIds.some((id) => id === sourcePaperId)) {
        setSourcePaperId(item.abstractPaperIds[0]);
        setSourceView({ kind: "current" });
      }
    },
    [shownReviewKey, sourcePaperId],
  );

  // Another paper's copy: whatever was open of the last one — a comparison, an earlier copy — closes.
  const chooseSourcePaper = useCallback((nextPaperId: string) => {
    setSourcePaperId(nextPaperId);
    setSourceView({ kind: "current" });
  }, []);

  const showSavedCopy = useCallback(
    (copyPaperId: PaperId, snapshotId: SnapshotId) => {
      const link = base.links.find((candidate) => candidate.link.paperId === copyPaperId);
      if (!link || !link.snapshots.some((snapshot) => snapshot.id === snapshotId)) return;
      setSourcePaperId(copyPaperId);
      setSourceView(link.currentCopy?.id === snapshotId ? { kind: "current" } : { kind: "copy", snapshotId });
      if (isMobile) setTab("source");
      focusOpenedSourceView(() => containerRef.current?.querySelector<HTMLElement>("[data-testid='study-record-source-pane']"));
    },
    [base.links, isMobile],
  );

  const updateValue = useCallback<EditorContextValue["updateValue"]>(
    (key, change) => update((current) => setValueEdit(baseValues, current, key, change(viewValue(baseValues, current, key).edit))),
    [baseValues, update],
  );

  const describeField = useCallback(
    (key: string) => {
      const { target, fieldKey } = parseValueKey(key);
      const label = EVIDENCE_FIELDS[fieldKey].label;
      const parsed = parseTargetKey(target);
      if (parsed.scope === "arm") {
        const arm = draft.arms.find((candidate) => candidate.key === parsed.key);
        return arm ? `${arm.displayLabel}: ${label}` : label;
      }
      if (parsed.scope === "outcome") {
        const outcome = draft.outcomes.find((candidate) => candidate.key === parsed.key);
        return outcome ? `${outcome.displayLabel}: ${label}` : label;
      }
      return label;
    },
    [draft.arms, draft.outcomes],
  );

  const focusTarget = useCallback<EditorContextValue["focusTarget"]>(
    (target: IssueTarget) => {
      setMode("edit");
      if (isMobile) setTab("record");
      // Open the collapsed section and "More details" that hold it (C2 audit K4), then focus it.
      setRevealRequest({ target, nonce: ++revealNonce.current });
      focusWhenShown(containerRef, issueTargetKey(target));
    },
    [isMobile],
  );

  const refusal = useMemo(
    () => (save.status === "failed" ? { target: save.target, message: save.error.userMessage } : null),
    [save],
  );

  const context = useMemo<EditorContextValue>(
    () => ({
      userId,
      base,
      baseValues,
      draft,
      issues,
      canEdit,
      refusal,
      update,
      updateValue,
      links: base.links,
      sourceLink,
      setSourcePaperId: chooseSourcePaper,
      sourceView,
      setSourceView,
      showSavedCopy,
      lastFocusedKey,
      setLastFocusedKey,
      focusTarget,
      revealRequest,
      mode,
      confirm: setConfirmRequest,
      newLocalId: () => `ref_${++localIdRef.current}`,
      describeField,
      isMobile,
    }),
    [
      userId,
      base,
      baseValues,
      draft,
      issues,
      canEdit,
      refusal,
      update,
      updateValue,
      sourceLink,
      chooseSourcePaper,
      sourceView,
      showSavedCopy,
      lastFocusedKey,
      focusTarget,
      revealRequest,
      mode,
      describeField,
      isMobile,
    ],
  );

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const saving = save.status === "saving";

  const requestReload = () => {
    if (dirty) setReloadOpen(true);
    else void editor.reload();
  };

  return (
    <EditorContext.Provider value={context}>
      <Tabs
        ref={containerRef}
        value={mode}
        onValueChange={(value) => setMode(value as EditorMode)}
        className="flex min-h-0 flex-1 flex-col"
        data-testid="study-record-editor"
        data-mode={mode}
      >
        <div className="shrink-0 border-b py-3 pl-4 pr-14 sm:pl-6">
          <DialogTitle ref={titleRef} tabIndex={-1} className="break-words leading-7 focus:outline-none [overflow-wrap:anywhere]">
            {STUDY_RECORD_COPY.editorTitle(base.header.label)}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            {DESIGN_PROFILE_LABELS[draft.header.designProfile]}
            {studyCount > 1 && ` · ${studyCount} studies from this paper`}
          </DialogDescription>
          {onShowList && (
            <Button type="button" variant="link" className="h-auto p-0 text-xs coarse:min-h-10" onClick={onShowList}>
              {STUDY_RECORD_COPY.backToList}
            </Button>
          )}
          {/*
            Edit holds the draft; Review shows the saved values (C2A). Both stay mounted, so
            switching keeps a draft, an open Flag note and the source selection. History (C2B)
            mounts only while chosen: each opening reads it afresh, and it holds nothing to keep.
          */}
          <TabsList className="mt-2 grid w-full grid-cols-3 sm:w-96" aria-label={REVIEW_COPY.modeLabel}>
            <TabsTrigger value="edit" className="coarse:min-h-10">
              {REVIEW_COPY.editMode}
            </TabsTrigger>
            <TabsTrigger value="review" className="coarse:min-h-10" data-testid="study-record-review-tab">
              {REVIEW_COPY.reviewMode}
            </TabsTrigger>
            <TabsTrigger value="history" className="coarse:min-h-10" data-testid="study-record-history-tab">
              {HISTORY_COPY.mode}
            </TabsTrigger>
          </TabsList>
        </div>

        {isMobile ? (
          <>
            <TabsContent value="edit" forceMount className="mt-0 flex min-h-0 flex-1 flex-col focus-visible:ring-inset data-[state=inactive]:hidden">
              <Tabs value={tab} onValueChange={(value) => setTab(value as "record" | "source")} className="flex min-h-0 flex-1 flex-col">
                <TabsList className="mx-4 mt-2 grid shrink-0 grid-cols-2" aria-label="Study record view">
                  <TabsTrigger value="record" className="coarse:min-h-10">
                    {STUDY_RECORD_COPY.recordPane}
                  </TabsTrigger>
                  <TabsTrigger value="source" className="coarse:min-h-10">
                    {STUDY_RECORD_COPY.sourcePane}
                  </TabsTrigger>
                </TabsList>
                {/* Both stay mounted so switching keeps what each holds (a selection, an open form). */}
                <TabsContent value="record" forceMount className="relative mt-0 min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:ring-inset data-[state=inactive]:hidden">
                  <RecordFacts editor={editor} canWrite={canWrite} />
                  <RecordPane />
                </TabsContent>
                <TabsContent value="source" forceMount className="relative mt-0 min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:ring-inset data-[state=inactive]:hidden">
                  {/* The library abstract is read only while this tab is on screen (C2C-A). */}
                  <SourcePane onQuoteAdded={(key) => focusTarget({ kind: "value", key })} active={mode === "edit" && tab === "source"} />
                </TabsContent>
              </Tabs>
            </TabsContent>
            {/* On a phone each card shows its own source (001A §I3), so Review needs no Source tab. */}
            <TabsContent value="review" forceMount className="relative mt-0 min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:ring-inset data-[state=inactive]:hidden">
              <ReviewPane editor={editor} flow={flow} canWrite={canWrite} onFocusItem={focusReviewItem} onReload={requestReload} />
            </TabsContent>
            <TabsContent value="history" className="relative mt-0 min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:ring-inset">
              <HistoryPane userId={userId} studyId={studyId} base={base} />
            </TabsContent>
          </>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-2">
            {/* History cites no source text: it takes the full width, and the Source pane is hidden — still mounted, so its selection is kept. */}
            <section
              aria-label={STUDY_RECORD_COPY.sourcePane}
              className={`relative min-h-0 overflow-y-auto overscroll-contain border-r${mode === "history" ? " hidden" : ""}`}
            >
              <SourcePane onQuoteAdded={() => undefined} display={sourceDisplay} active={mode !== "history"} />
            </section>
            <TabsContent value="edit" forceMount className="relative mt-0 min-h-0 overflow-y-auto overscroll-contain focus-visible:ring-inset data-[state=inactive]:hidden">
              <section aria-label={STUDY_RECORD_COPY.recordPane}>
                <RecordFacts editor={editor} canWrite={canWrite} />
                <RecordPane />
              </section>
            </TabsContent>
            <TabsContent value="review" forceMount className="relative mt-0 min-h-0 overflow-y-auto overscroll-contain focus-visible:ring-inset data-[state=inactive]:hidden">
              <ReviewPane editor={editor} flow={flow} canWrite={canWrite} onFocusItem={focusReviewItem} onReload={requestReload} />
            </TabsContent>
            <TabsContent value="history" className="relative col-span-2 mt-0 min-h-0 overflow-y-auto overscroll-contain focus-visible:ring-inset">
              <HistoryPane userId={userId} studyId={studyId} base={base} />
            </TabsContent>
          </div>
        )}

        <SaveMessages
          editor={editor}
          flow={flow}
          alertRef={alertRef}
          errorCount={errorCount}
          onReload={requestReload}
          onFocusTarget={focusTarget}
          onClose={onRequestClose}
        />

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <Button
            type="button"
            variant="outline"
            className="text-destructive coarse:min-h-10"
            onClick={() => setDeleteOpen(true)}
            disabled={saving || save.status === "uncertain" || editor.reviewPending}
          >
            <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
            {STUDY_RECORD_COPY.deleteButton}
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground" data-testid="study-record-save-status">
              {saving
                ? STUDY_RECORD_COPY.saving(save.step, save.total)
                : editor.reviewAction.status === "working"
                  ? REVIEW_COPY.working
                  : save.status === "saved"
                    ? STUDY_RECORD_COPY.saved
                    : canWrite
                      ? dirty
                        ? STUDY_RECORD_COPY.unsavedChanges
                        : STUDY_RECORD_COPY.noChanges
                      : ""}
            </p>
            {canWrite && (
              <Button
                type="button"
                className="relative coarse:min-h-10"
                aria-disabled={saving || !canEdit || undefined}
                aria-busy={saving || undefined}
                onClick={() => {
                  if (saving || !canEdit) return;
                  void editor.runSave();
                }}
                data-testid="study-record-save"
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {STUDY_RECORD_COPY.saveDraft}
                {dirty && !saving && (
                  <span aria-hidden="true" className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-background bg-amber-500" />
                )}
              </Button>
            )}
          </div>
        </footer>
      </Tabs>

      <DeleteStudyRecordDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        label={base.header.label}
        dirty={dirty}
        state={editor.deletion}
        onDelete={async () => {
          const gone = await editor.deleteStudy();
          if (gone) {
            setDeleteOpen(false);
            onDeleted();
          }
        }}
        onReload={() => {
          setDeleteOpen(false);
          editor.clearDeletionError();
          requestReload();
        }}
      />

      <AlertDialog open={reloadOpen} onOpenChange={setReloadOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{STUDY_RECORD_COPY.reloadConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{STUDY_RECORD_COPY.reloadConfirmBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{STUDY_RECORD_COPY.keepEditing}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void editor.reload()}>{STUDY_RECORD_COPY.reload}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRequest !== null} onOpenChange={(open) => !open && setConfirmRequest(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmRequest?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmRequest?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{STUDY_RECORD_COPY.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                confirmRequest?.onConfirm();
                setConfirmRequest(null);
              }}
            >
              {confirmRequest?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </EditorContext.Provider>
  );
}

type Editor = ReturnType<typeof useStudyRecordEditor>;

/** The record's standing facts: who may edit, the linked papers, and what the record does and doesn't claim. */
function RecordFacts({ editor, canWrite }: { readonly editor: Editor; readonly canWrite: boolean }) {
  const { base } = useEditor();
  const linkBusy = editor.linkAction.status === "working";
  return (
    <div className="space-y-3 border-b px-4 py-4 sm:px-6">
      {!canWrite && <ReadOnlyNotice />}
      <ul className="space-y-2" aria-label={STUDY_RECORD_COPY.linkStatusLabel}>
        {base.links.map((link) => (
          <li key={link.link.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">{link.paperTitle ?? STUDY_RECORD_COPY.thisPaper}</span>
            <Badge variant="outline" className="font-normal">
              {LINK_STATUS_LABELS[link.link.status]}
            </Badge>
            {editor.canEdit && (
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs coarse:min-h-10"
                disabled={linkBusy}
                onClick={() =>
                  void editor.changeLinkStatus(link.link.paperId, link.link.status === "provisional" ? "confirm" : "mark_provisional")
                }
              >
                {link.link.status === "provisional" ? STUDY_RECORD_COPY.markConfirmed : STUDY_RECORD_COPY.markProvisional}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {(editor.linkAction.status === "failed" || editor.linkAction.status === "uncertain") && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm">
          <span>{editor.linkAction.error.userMessage}</span>
          <Button type="button" variant="ghost" size="sm" className="coarse:min-h-10" onClick={editor.clearLinkError}>
            Dismiss
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{IDENTITY_CAVEAT}</p>
      <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.interpretationNotice}</p>
      <p className="text-xs text-muted-foreground">{NOT_REPORTED_EXPLANATION}</p>
    </div>
  );
}

function ReadOnlyNotice() {
  return (
    <p className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="study-record-read-only">
      {STUDY_RECORD_COPY.readOnlyNotice}
    </p>
  );
}

interface SaveMessagesProps {
  readonly editor: Editor;
  readonly flow: ReviewFlow;
  readonly alertRef: React.RefObject<HTMLDivElement>;
  readonly errorCount: number;
  readonly onReload: () => void;
  readonly onFocusTarget: EditorContextValue["focusTarget"];
  readonly onClose: () => void;
}

/**
 * The outcome of the last save — or of a review whose outcome is unknown,
 * which holds every write until it is tried again or abandoned by a reload —
 * as a message with its next step. Shown above the footer, in both modes.
 */
function SaveMessages({ editor, flow, alertRef, errorCount, onReload, onFocusTarget, onClose }: SaveMessagesProps) {
  const { save, externalChange, issues, reviewAction } = editor;
  const box = "mx-4 mb-2 shrink-0 rounded-md border p-3 text-sm focus:outline-none sm:mx-6";
  const firstError = issues.find((issue) => issue.severity === "error");
  if (reviewAction.status === "uncertain") {
    return (
      <div ref={alertRef} tabIndex={-1} role="alert" className={`${box} border-amber-500/50 bg-amber-50 dark:bg-amber-950/30`} data-testid="review-uncertain-alert">
        <p>{reviewErrorText(reviewAction.error)}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" size="sm" className="coarse:min-h-10" onClick={() => void flow.retry()}>
            {REVIEW_COPY.tryAgain}
          </Button>
          <Button type="button" size="sm" variant="outline" className="coarse:min-h-10" onClick={onReload}>
            {REVIEW_COPY.reload}
          </Button>
        </div>
      </div>
    );
  }
  if (save.status === "invalid") {
    const count = hasErrors(save.issues) ? save.issues.filter((issue) => issue.severity === "error").length : errorCount;
    const first = save.issues.find((issue) => issue.severity === "error") ?? firstError;
    return (
      <div ref={alertRef} tabIndex={-1} role="alert" className={`${box} border-destructive/40 bg-destructive/5`}>
        <p className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {STUDY_RECORD_COPY.invalidSummary(Math.max(count, 1))}
        </p>
        {first && (
          <p className="mt-1">
            {first.message}{" "}
            {first.target.kind !== "record" && (
              <Button type="button" variant="link" className="h-auto p-0 coarse:min-h-10" onClick={() => onFocusTarget(first.target)}>
                Go to the field
              </Button>
            )}
          </p>
        )}
      </div>
    );
  }
  if (save.status === "failed") {
    return (
      <div ref={alertRef} tabIndex={-1} role="alert" className={`${box} border-destructive/40 bg-destructive/5`}>
        <p>
          {save.error.userMessage}
          {STUDY_RECORD_COPY.partialSaved(save.applied, save.total)}
        </p>
        {save.target.kind !== "record" && (
          <Button type="button" variant="link" className="h-auto p-0 coarse:min-h-10" onClick={() => onFocusTarget(save.target)}>
            Go to the field
          </Button>
        )}
      </div>
    );
  }
  if (save.status === "uncertain") {
    return (
      <div ref={alertRef} tabIndex={-1} role="alert" className={`${box} border-amber-500/50 bg-amber-50 dark:bg-amber-950/30`}>
        <p>
          {save.error.userMessage}
          {STUDY_RECORD_COPY.partialSaved(save.applied, save.total)}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" size="sm" className="coarse:min-h-10" onClick={() => void editor.runSave()}>
            {STUDY_RECORD_COPY.tryAgain}
          </Button>
          <Button type="button" size="sm" variant="outline" className="coarse:min-h-10" onClick={onReload}>
            {STUDY_RECORD_COPY.reload}
          </Button>
        </div>
      </div>
    );
  }
  if (save.status === "conflict" || save.status === "reload_failed" || externalChange) {
    // A review refused for a version conflict recorded nothing, and touched no draft: it says so in its own words.
    const reviewConflict = reviewAction.status === "failed" && reviewAction.failure.kind === "refused" && reviewAction.failure.error.kind === "version_conflict" ? reviewAction.failure.error : null;
    const message =
      save.status === "conflict"
        ? reviewConflict
          ? reviewErrorText(reviewConflict)
          : `${STUDY_RECORD_COPY.conflict}${STUDY_RECORD_COPY.partialSaved(save.applied, save.total)}`
        : save.status === "reload_failed"
          ? STUDY_RECORD_COPY.reloadFailed
          : STUDY_RECORD_COPY.externalChange;
    return (
      <div ref={alertRef} tabIndex={-1} role="alert" className={`${box} border-amber-500/50 bg-amber-50 dark:bg-amber-950/30`}>
        <p>{message}</p>
        <Button type="button" size="sm" variant="outline" className="mt-2 coarse:min-h-10" onClick={onReload}>
          {STUDY_RECORD_COPY.reload}
        </Button>
      </div>
    );
  }
  if (save.status === "not_enabled") {
    return (
      <div ref={alertRef} tabIndex={-1} role="alert" className={`${box} border-destructive/40 bg-destructive/5`}>
        <p>
          {STUDY_RECORD_COPY.notEnabledNotice}
          {STUDY_RECORD_COPY.partialSaved(save.applied, save.total)}
        </p>
      </div>
    );
  }
  if (save.status === "gone") {
    return (
      <div ref={alertRef} tabIndex={-1} role="alert" className={`${box} border-destructive/40 bg-destructive/5`}>
        <p>{STUDY_RECORD_COPY.gone}</p>
        <Button type="button" size="sm" variant="outline" className="mt-2 coarse:min-h-10" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }
  return null;
}

interface DeleteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly label: string;
  readonly dirty: boolean;
  readonly state: Editor["deletion"];
  readonly onDelete: () => Promise<void>;
  readonly onReload: () => void;
}

/**
 * "Delete study record" (Requirements-001 §E10). Says exactly what goes —
 * values, sources, saved copies, history, the study and its links — and that
 * the paper stays. Ungated on the server, so it works for a former pilot owner.
 */
function DeleteStudyRecordDialog({ open, onOpenChange, label, dirty, state, onDelete, onReload }: DeleteDialogProps) {
  const working = state.status === "working";
  return (
    <AlertDialog open={open} onOpenChange={(next) => !working && onOpenChange(next)}>
      <AlertDialogContent data-testid="study-record-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words [overflow-wrap:anywhere]">{STUDY_RECORD_COPY.deleteTitle(label)}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{STUDY_RECORD_COPY.deleteIntro}</p>
              <ul className="list-disc space-y-1 pl-5">
                {STUDY_RECORD_COPY.deleteItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className="font-medium text-foreground">{STUDY_RECORD_COPY.deletePaperStays}</p>
              {dirty && <p>{STUDY_RECORD_COPY.deleteUnsaved}</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {(state.status === "failed" || state.status === "uncertain") && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p>
              {state.status === "uncertain"
                ? STUDY_RECORD_COPY.deleteUncertain
                : state.error.kind === "version_conflict"
                  ? STUDY_RECORD_COPY.deleteConflict
                  : state.error.userMessage}
            </p>
            {state.status === "failed" && state.error.kind === "version_conflict" && (
              <Button type="button" size="sm" variant="outline" className="mt-2 coarse:min-h-10" onClick={onReload}>
                {STUDY_RECORD_COPY.reload}
              </Button>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={working}>{STUDY_RECORD_COPY.cancel}</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            className="coarse:min-h-10"
            disabled={working || (state.status === "failed" && state.error.kind === "version_conflict")}
            aria-busy={working || undefined}
            onClick={() => void onDelete()}
          >
            {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {working ? STUDY_RECORD_COPY.deleting : state.status === "uncertain" ? STUDY_RECORD_COPY.tryAgain : STUDY_RECORD_COPY.deleteConfirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

