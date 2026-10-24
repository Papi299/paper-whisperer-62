import { useId, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { useStudyRecordEditor } from "@/hooks/useStudyRecordEditor";
import { REVIEW_STATUS_LABELS } from "@/lib/evidence/review";
import { NOT_REPORTED_EXPLANATION } from "@/lib/evidence/states";
import type { ReviewStatus } from "@/lib/evidence/types";
import { filterReviewItems, reviewSummary, type ReviewFilter, type ReviewItem } from "@/lib/studyRecord/reviewModel";
import { linkSourcesOf } from "@/lib/studyRecord/validateDraft";
import { useEditor } from "./editorContext";
import { REVIEW_COPY } from "./reviewCopy";
import { ReviewCard } from "./ReviewCard";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";
import type { ReviewFlow } from "./useReviewFlow";

type Editor = ReturnType<typeof useStudyRecordEditor>;

const STATUS_ORDER: readonly ReviewStatus[] = ["unreviewed", "user_reviewed", "disputed", "needs_rereview"];

interface ReviewPaneProps {
  readonly editor: Editor;
  readonly flow: ReviewFlow;
  /** Whether the user may review at all (the owner pilot, mirrored). */
  readonly canWrite: boolean;
  /** A card was focused or pressed: its source goes beside it. */
  readonly onFocusItem: (item: ReviewItem) => void;
  readonly onReload: () => void;
}

/**
 * Review mode (EVIDENCE-RECORDS-001C2A; Requirements-001A §I): one card per
 * SAVED value, grouped as the record is — the study's sections, then each
 * group and outcome in saved order — under a summary that counts values by
 * their own review status and never judges the record as a whole. The filter
 * changes only what is shown.
 *
 * Every Confirm is its own press, for one value. After one is recorded, focus
 * moves to the next value that needs review (`useReviewFlow`).
 */
export function ReviewPane({ editor, flow, canWrite, onFocusItem, onReload }: ReviewPaneProps) {
  const context = useEditor();
  const ids = useId();
  const items = editor.reviewItems;
  const [filter, setFilter] = useState<ReviewFilter>("needs_review");
  const shown = filterReviewItems(items, filter);
  const summary = reviewSummary(items);
  const needing = items.filter((item) => item.needsReview).length;
  const linkSources = useMemo(() => linkSourcesOf(context.base), [context.base]);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6" data-testid="study-record-review-pane">
      <section aria-labelledby={`${ids}-summary`} className="space-y-2 rounded-md border p-3" data-testid="review-summary">
        <h3 id={`${ids}-summary`} ref={flow.summaryRef} tabIndex={-1} className="rounded-sm text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {REVIEW_COPY.summaryHeading}
        </h3>
        <p className="text-sm">{REVIEW_COPY.summaryRecorded(summary.recorded)}</p>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4" data-testid="review-summary-counts">
          {STATUS_ORDER.map((status) => (
            <li key={status}>
              {REVIEW_STATUS_LABELS[status]}: {summary.counts[status]}
            </li>
          ))}
        </ul>
        {canWrite && summary.cannotConfirmYet > 0 && <p className="text-xs">{REVIEW_COPY.summaryCannotConfirm(summary.cannotConfirmYet)}</p>}
        <p className="text-xs text-muted-foreground">{REVIEW_COPY.standing}</p>
        <p className="text-xs text-muted-foreground">{NOT_REPORTED_EXPLANATION}</p>
        {!canWrite && (
          <p className="rounded-md border bg-muted/40 p-2 text-sm" data-testid="review-read-only">
            {REVIEW_COPY.readOnly}
          </p>
        )}
      </section>

      {summary.recorded > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium">{REVIEW_COPY.filterLabel}</legend>
          <RadioGroup value={filter} onValueChange={(value) => setFilter(value as ReviewFilter)} className="flex flex-wrap gap-x-4 gap-y-1">
            <div className="flex items-center gap-2 coarse:min-h-10">
              <RadioGroupItem id={`${ids}-needs`} value="needs_review" />
              <Label htmlFor={`${ids}-needs`} className="cursor-pointer text-sm font-normal">
                {REVIEW_COPY.filterNeedsReview} ({needing})
              </Label>
            </div>
            <div className="flex items-center gap-2 coarse:min-h-10">
              <RadioGroupItem id={`${ids}-all`} value="all" />
              <Label htmlFor={`${ids}-all`} className="cursor-pointer text-sm font-normal">
                {REVIEW_COPY.filterAll} ({summary.recorded})
              </Label>
            </div>
          </RadioGroup>
        </fieldset>
      )}

      {summary.recorded === 0 && <p className="text-sm">{REVIEW_COPY.emptyNothingRecorded}</p>}
      {summary.recorded > 0 && shown.length === 0 && <p className="text-sm">{REVIEW_COPY.emptyAllReviewed}</p>}

      {groupsOf(shown).map((group) => (
        <section key={group.section} aria-labelledby={`${ids}-${group.section}`} className="space-y-3">
          <h3 id={`${ids}-${group.section}`} className="text-sm font-semibold">
            {STUDY_RECORD_COPY.sections[group.section]}
          </h3>
          {group.targets.map((target) => (
            <div key={target.groupId} className="space-y-3">
              {target.name && <h4 className="break-words text-sm font-medium [overflow-wrap:anywhere]">{target.name}</h4>}
              {target.items.map((item) => (
                <ReviewCard
                  key={item.key}
                  item={item}
                  level={target.name ? 5 : 4}
                  isMobile={context.isMobile}
                  links={context.links}
                  linkSources={linkSources}
                  action={editor.reviewAction}
                  registerHeading={flow.registerHeading}
                  registerStatus={flow.registerStatus}
                  onFocusItem={onFocusItem}
                  onConfirm={(chosen) => void flow.confirm(chosen)}
                  onFlag={flow.flag}
                  onEdit={(chosen) => context.focusTarget({ kind: "value", key: chosen.key })}
                  onReload={onReload}
                  onDismiss={editor.clearReviewError}
                />
              ))}
            </div>
          ))}
        </section>
      ))}

      <p role="status" aria-live="polite" className="sr-only" data-testid="review-announcement">
        {flow.announcement}
      </p>
    </div>
  );
}

interface TargetGroup {
  readonly groupId: string;
  /** A group's or outcome's saved name with its kind; null for the study's own fields. */
  readonly name: string | null;
  readonly items: ReviewItem[];
}

/** The shown items by dictionary section, then by target, keeping their order. */
function groupsOf(items: readonly ReviewItem[]): { readonly section: ReviewItem["section"]; readonly targets: TargetGroup[] }[] {
  const sections: { section: ReviewItem["section"]; targets: TargetGroup[] }[] = [];
  for (const item of items) {
    let section = sections[sections.length - 1];
    if (!section || section.section !== item.section) {
      section = { section: item.section, targets: [] };
      sections.push(section);
    }
    let target = section.targets[section.targets.length - 1];
    if (!target || target.groupId !== item.groupId) {
      const name =
        item.target.scope === "arm"
          ? `${STUDY_RECORD_COPY.groupRole[item.target.role]}: ${item.target.name}`
          : item.target.scope === "outcome"
            ? `Outcome: ${item.target.name}`
            : null;
      target = { groupId: item.groupId, name, items: [] };
      section.targets.push(target);
    }
    target.items.push(item);
  }
  return sections;
}
