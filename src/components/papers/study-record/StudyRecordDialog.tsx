import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
import { useToast } from "@/hooks/use-toast";
import { useStudyRecordCreationStore } from "@/hooks/useStudyRecordCreations";
import { usePaperStudyRecords, useStudyRecordWriteAccess } from "@/hooks/useStudyRecords";
import { canOfferStudyRecordWrites, type StudyRecordWriteAccess } from "@/lib/studyRecord/access";
import type { PendingCreateStore } from "@/lib/studyRecord/pendingCreates";
import { StudyRecordList } from "./StudyRecordList";
import { StudyRecordStart } from "./StudyRecordStart";
import { StudyRecordEditor } from "./StudyRecordEditor";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

/** What the dialog is opened for: one paper, and optionally one of its studies. */
export interface StudyRecordTarget {
  /** A new number every time the dialog is opened, so each opening starts fresh. */
  readonly session: number;
  readonly paperId: string;
  readonly paperTitle: string;
  /** The study name to suggest when a record is started ("Smith 2021"). */
  readonly labelSuggestion: string;
  /** Open this study directly. */
  readonly studyId?: string | null;
}

type View = { readonly kind: "auto" } | { readonly kind: "start" } | { readonly kind: "list" } | { readonly kind: "study"; readonly studyId: string };

export interface StudyRecordDialogProps {
  readonly target: StudyRecordTarget | null;
  readonly userId: string | null | undefined;
  readonly onClose: () => void;
}

/**
 * The Study Record dialog (EVIDENCE-RECORDS-001C1; Requirements-001 §E1–§E3).
 *
 * Mounted once by the Dashboard, beside Compare, and opened from a paper's
 * expanded details or from Edit Paper — never stacked on another dialog. It
 * holds the whole flow for one paper: starting a record, choosing among the
 * studies the paper reports, and the editor. Full height on a desktop, full
 * screen on a phone.
 *
 * Closing with unsaved changes asks first. Nothing is kept after it closes:
 * no draft survives in memory or in browser storage. The one exception is a
 * create whose outcome is unknown (C1-R1): this component keeps it, in memory
 * and for the signed-in user only, across openings — so that reopening the
 * paper retries that same request instead of offering a new one. Leaving
 * while such an attempt is open is allowed, and says so.
 */
export function StudyRecordDialog({ target, userId, onClose }: StudyRecordDialogProps) {
  const open = target !== null && !!userId;
  // While the closing animation plays, keep showing what was open.
  const [shown, setShown] = useState<StudyRecordTarget | null>(target);
  if (target !== null && target !== shown) setShown(target);
  const session = target ?? shown;

  const { toast } = useToast();
  const creations = useStudyRecordCreationStore(userId);
  const [dirty, setDirty] = useState(false);
  // Where the user asked to go while the draft had unsaved changes: closing,
  // or another view of this paper's studies. It happens only once they discard.
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const paperId = session?.paperId ?? null;
  const close = useCallback(() => {
    if (userId && paperId && creations.get(userId, paperId)) {
      toast({ title: STUDY_RECORD_COPY.unconfirmedTitle, description: STUDY_RECORD_COPY.unconfirmedBody });
    }
    onClose();
  }, [creations, onClose, paperId, toast, userId]);

  const requestLeave = useCallback(
    (leave: () => void) => {
      if (dirty) setPendingLeave(() => leave);
      else leave();
    },
    [dirty],
  );
  const requestClose = useCallback(() => requestLeave(close), [requestLeave, close]);

  const discard = useCallback(() => {
    const leave = pendingLeave;
    setPendingLeave(null);
    setDirty(false);
    leave?.();
  }, [pendingLeave]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DialogContent
        data-testid="study-record-dialog"
        className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden p-0 sm:rounded-none md:h-[calc(100dvh-2rem)] md:w-[calc(100vw-2rem)] md:max-w-6xl md:rounded-lg [&>button:last-child]:right-2 [&>button:last-child]:top-2 [&>button:last-child]:flex [&>button:last-child]:h-10 [&>button:last-child]:w-10 [&>button:last-child]:items-center [&>button:last-child]:justify-center"
        onOpenAutoFocus={(event) => {
          // The title first: a screen reader says where it is, and no stray key activates anything.
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        {session && userId && (
          <StudyRecordBody
            key={session.session}
            target={session}
            userId={userId}
            creations={creations}
            titleRef={titleRef}
            onClose={close}
            onRequestClose={requestClose}
            onRequestLeave={requestLeave}
            onDirtyChange={setDirty}
          />
        )}
        <AlertDialog open={pendingLeave !== null} onOpenChange={(next) => !next && setPendingLeave(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{STUDY_RECORD_COPY.discardTitle}</AlertDialogTitle>
              <AlertDialogDescription>{STUDY_RECORD_COPY.discardBody}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{STUDY_RECORD_COPY.keepEditing}</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={discard}>
                {STUDY_RECORD_COPY.discardConfirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

interface StudyRecordBodyProps {
  readonly target: StudyRecordTarget;
  readonly userId: string;
  readonly creations: PendingCreateStore;
  readonly titleRef: React.RefObject<HTMLHeadingElement>;
  readonly onClose: () => void;
  readonly onRequestClose: () => void;
  /** Leave the current view; asks first when the draft has unsaved changes. */
  readonly onRequestLeave: (leave: () => void) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}

/** One opening of the dialog. Keyed by the session, so its state never carries over. */
function StudyRecordBody({ target, userId, creations, titleRef, onClose, onRequestClose, onRequestLeave, onDirtyChange }: StudyRecordBodyProps) {
  const { toast } = useToast();
  const access = useStudyRecordWriteAccess(userId);
  const canWrite = canOfferStudyRecordWrites(access);
  // A paper whose earlier create is unresolved opens on that attempt's recovery (C1-R1).
  const [view, setView] = useState<View>(() =>
    target.studyId ? { kind: "study", studyId: target.studyId } : creations.get(userId, target.paperId) ? { kind: "start" } : { kind: "auto" },
  );
  // Read afresh on every opening: a cached "none" may predate a create that committed.
  const studies = usePaperStudyRecords(userId, target.paperId, true, { freshOnMount: true });
  const freshStudies = studies.isFetchedAfterMount && studies.isSuccess ? studies.data : null;

  const show = useCallback(
    (next: View) => {
      onDirtyChange(false);
      setView(next);
      // The new view's title takes focus once it is on screen.
      requestAnimationFrame(() => titleRef.current?.focus());
    },
    [onDirtyChange, titleRef],
  );

  // "auto" resolves once, from this opening's own read of the server (never
  // from a cached list), and is then pinned: a later refetch of the paper's
  // studies must never swap the view under an open editor — that would
  // unmount a draft without asking.
  const resolvedCount = view.kind === "auto" && freshStudies && !studies.isFetching ? freshStudies.length : null;
  const onlyStudy = resolvedCount === 1 ? freshStudies![0].studyId : null;
  useEffect(() => {
    if (resolvedCount === null) return;
    setView(resolvedCount === 1 && onlyStudy ? { kind: "study", studyId: onlyStudy } : resolvedCount === 0 ? { kind: "start" } : { kind: "list" });
  }, [resolvedCount, onlyStudy]);

  const handleDeleted = useCallback(
    (remaining: number) => {
      onDirtyChange(false);
      toast({ title: STUDY_RECORD_COPY.deleted });
      if (remaining > 0) show({ kind: "list" });
      else onClose();
    },
    [onClose, onDirtyChange, show, toast],
  );

  if (view.kind === "study") {
    const count = studies.data?.length ?? 0;
    return (
      <StudyRecordEditor
        userId={userId}
        studyId={view.studyId}
        paperId={target.paperId}
        canWrite={canWrite}
        titleRef={titleRef}
        studyCount={count}
        // The list is where another study is chosen — or, for the pilot owner,
        // added (one paper can report several). Leaving a draft asks first.
        onShowList={count > 1 || canWrite ? () => onRequestLeave(() => show({ kind: "list" })) : undefined}
        onDirtyChange={onDirtyChange}
        onDeleted={() => handleDeleted(Math.max(0, count - 1))}
        onRequestClose={onRequestClose}
      />
    );
  }

  if (view.kind === "start") {
    return (
      <StudyRecordStart
        userId={userId}
        paperId={target.paperId}
        paperTitle={target.paperTitle}
        labelSuggestion={target.labelSuggestion}
        access={access}
        creations={creations}
        existing={freshStudies}
        existingFailed={studies.isError}
        onRefreshExisting={studies.refetch}
        titleRef={titleRef}
        onCreated={(studyId) => show({ kind: "study", studyId })}
        onCancel={(studies.data?.length ?? 0) > 0 ? () => show({ kind: "list" }) : onClose}
        onClose={onClose}
      />
    );
  }

  // Until this opening's read answers, a cached list is not shown as the paper's studies.
  if (!studies.isError && (studies.isPending || view.kind === "auto" || (studies.isFetching && !studies.data))) {
    return (
      <StatusFrame title={STUDY_RECORD_COPY.listTitle(target.paperTitle)} titleRef={titleRef}>
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading…
        </p>
      </StatusFrame>
    );
  }
  if (studies.isError || !studies.data) {
    return (
      <StatusFrame title={STUDY_RECORD_COPY.listTitle(target.paperTitle)} titleRef={titleRef}>
        <p role="alert" className="text-sm">
          {STUDY_RECORD_COPY.loadFailed}
        </p>
        <Button type="button" variant="outline" className="mt-3 coarse:min-h-10" onClick={() => void studies.refetch()}>
          {STUDY_RECORD_COPY.tryAgain}
        </Button>
      </StatusFrame>
    );
  }

  const list = studies.data;
  return (
    <StudyRecordList
      paperTitle={target.paperTitle}
      studies={list}
      canWrite={canWrite}
      titleRef={titleRef}
      onOpen={(studyId) => show({ kind: "study", studyId })}
      onAddAnother={() => show({ kind: "start" })}
      onClose={onClose}
    />
  );
}

/** The frame of a simple state: a title and a message. */
export function StatusFrame({
  title,
  titleRef,
  children,
}: {
  readonly title: string;
  readonly titleRef: React.RefObject<HTMLHeadingElement>;
  readonly children: React.ReactNode;
}) {
  return (
    <>
      <div className="shrink-0 border-b py-3 pl-4 pr-14 sm:pl-6">
        <DialogTitle ref={titleRef} tabIndex={-1} className="break-words leading-7 focus:outline-none [overflow-wrap:anywhere]">
          {title}
        </DialogTitle>
        <DialogDescription className="sr-only">{STUDY_RECORD_COPY.explainer}</DialogDescription>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">{children}</div>
    </>
  );
}

export type { StudyRecordWriteAccess };
