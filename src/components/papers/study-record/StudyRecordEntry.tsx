import { BookOpenCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePaperStudyRecords, useStudyRecordWriteAccess } from "@/hooks/useStudyRecords";
import { canOfferStudyRecordWrites } from "@/lib/studyRecord/access";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

export interface StudyRecordEntryProps {
  readonly userId: string | null | undefined;
  readonly paperId: string;
  /** Read the paper's studies only while the entry is on screen. */
  readonly enabled: boolean;
  readonly onOpen: () => void;
  /** Shown under the button, e.g. that opening closes Edit Paper. */
  readonly note?: string;
  /** Classes of the entry's own container, which exists only when the entry is shown. */
  readonly className?: string;
}

/**
 * "Study records — None / 1 / 2" and the way in (Requirements-001 §E1, §E9).
 *
 * Shown inside a paper's expanded details and in Edit Paper — never as another
 * icon in the row's action cluster. What it offers follows the owner-only
 * pilot, mirrored from the server's gate:
 *
 *   * the pilot owner always sees it, and can start a record;
 *   * anyone who holds study records for this paper sees it and can open them
 *     (view and delete stay available after the pilot role is removed);
 *   * everyone else sees nothing — unless the read failed, which is said, never
 *     shown as "None".
 */
export function StudyRecordEntry({ userId, paperId, enabled, onOpen, note, className }: StudyRecordEntryProps) {
  const access = useStudyRecordWriteAccess(userId);
  const canWrite = canOfferStudyRecordWrites(access);
  const studies = usePaperStudyRecords(userId, paperId, enabled);
  if (!userId) return null;

  const count = studies.data?.length ?? null;
  const failed = studies.isError && count === null;
  if (!canWrite && !failed && !(count !== null && count > 0)) return null;

  const status = failed ? STUDY_RECORD_COPY.entryFailed : count === null ? STUDY_RECORD_COPY.entryChecking : STUDY_RECORD_COPY.entryCount(count);
  return (
    <div className={`space-y-1 ${className ?? ""}`} data-testid="study-record-entry">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground" data-testid="study-record-entry-status">
          {STUDY_RECORD_COPY.entryLabel} — <span className="normal-case">{status}</span>
        </p>
        {count !== null && count > 0 && (
          <Button type="button" variant="outline" size="sm" className="h-8 coarse:min-h-10" onClick={onOpen}>
            <BookOpenCheck className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {STUDY_RECORD_COPY.entryOpen}
          </Button>
        )}
        {count === 0 && canWrite && (
          <Button type="button" variant="outline" size="sm" className="h-8 coarse:min-h-10" onClick={onOpen}>
            <BookOpenCheck className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {STUDY_RECORD_COPY.entryStart}
          </Button>
        )}
        {failed && (
          <Button type="button" variant="ghost" size="sm" className="h-8 coarse:min-h-10" onClick={() => void studies.refetch()}>
            {STUDY_RECORD_COPY.tryAgain}
          </Button>
        )}
      </div>
      {note && (count !== null || canWrite) && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
