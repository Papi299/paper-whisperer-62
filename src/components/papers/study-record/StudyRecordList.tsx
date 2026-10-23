import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DESIGN_PROFILE_LABELS } from "@/lib/evidence/fieldDictionary";
import { LINK_STATUS_LABELS } from "@/lib/evidence/identity";
import type { PaperStudySummary } from "@/lib/studyRecord/paperLinks";
import { StatusFrame } from "./StudyRecordDialog";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

export interface StudyRecordListProps {
  readonly paperTitle: string;
  readonly studies: readonly PaperStudySummary[];
  readonly canWrite: boolean;
  readonly titleRef: React.RefObject<HTMLHeadingElement>;
  readonly onOpen: (studyId: string) => void;
  readonly onAddAnother: () => void;
  readonly onClose: () => void;
}

/**
 * The studies one paper reports (Requirements-001 §G2: one paper can report
 * several studies). Each is a separate record; nothing here suggests two of
 * them are the same study. "Add another study" only for the owner pilot.
 */
export function StudyRecordList({ paperTitle, studies, canWrite, titleRef, onOpen, onAddAnother, onClose }: StudyRecordListProps) {
  return (
    <StatusFrame title={STUDY_RECORD_COPY.listTitle(paperTitle)} titleRef={titleRef}>
      <div className="mx-auto max-w-2xl space-y-4">
        {studies.length === 0 ? (
          <p className="text-sm">{STUDY_RECORD_COPY.noRecordForPaper}</p>
        ) : (
          <ul className="space-y-2" aria-label={STUDY_RECORD_COPY.entryLabel}>
            {studies.map((study) => (
              <li key={study.studyId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words [overflow-wrap:anywhere]">{study.label}</p>
                  <p className="text-xs text-muted-foreground">{DESIGN_PROFILE_LABELS[study.designProfile]}</p>
                  {study.linkStatus === "provisional" && (
                    <Badge variant="outline" className="mt-1 text-xs font-normal">
                      {LINK_STATUS_LABELS.provisional}
                    </Badge>
                  )}
                </div>
                <Button type="button" variant="outline" className="coarse:min-h-10" onClick={() => onOpen(study.studyId)} aria-label={`${STUDY_RECORD_COPY.openButton} ${study.label}`}>
                  {STUDY_RECORD_COPY.openButton}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <div className="space-y-1">
            <Button type="button" variant="outline" className="coarse:min-h-10" onClick={onAddAnother}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              {STUDY_RECORD_COPY.addAnotherStudy}
            </Button>
            <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.addAnotherHelp}</p>
          </div>
        )}
        <div className="flex justify-end">
          <Button type="button" variant="ghost" className="coarse:min-h-10" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </StatusFrame>
  );
}
