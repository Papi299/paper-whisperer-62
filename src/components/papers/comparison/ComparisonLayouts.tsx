import { useLayoutEffect, useRef } from "react";
import type { ComparisonSort } from "@/lib/paperComparison/sort";
import type { ComparisonRow } from "@/lib/paperComparison/types";
import { cn } from "@/lib/utils";
import { ComparisonValue } from "./ComparisonValue";
import { MISSING_TITLE_TEXT, SORT_LABELS, fieldCaveat, identityLine, type ComparisonGroupDef } from "./comparisonFields";

/**
 * The two presentations of one comparison (EVIDENCE-MATRIX-001B): a matrix
 * from `md` up and paper cards below it. Both render the same rows, the same
 * field group and the same values, in the same order, from the same field
 * definitions — only the arrangement differs.
 *
 * A row is keyed by its paper id, never by position or title, so sorting moves
 * whole papers and a value can never end up beside another paper's title.
 */

export interface ComparisonLayoutProps {
  group: ComparisonGroupDef;
  /** Rows in display order. */
  rows: readonly ComparisonRow[];
  sort: ComparisonSort;
  /** DOM id prefix for one paper: `${paperDomId(id)}-title`, `-meta`, `-<field>`. */
  paperDomId: (paperId: string) => string;
  isExpanded: (paperId: string, fieldId: string) => boolean;
  onToggle: (paperId: string, fieldId: string) => void;
}

function PaperTitle({ row }: { row: ComparisonRow }) {
  const title = row.title.value;
  return title.kind === "present" ? (
    <>{title.value}</>
  ) : (
    <span className="italic text-muted-foreground" data-value-state={title.kind}>
      {MISSING_TITLE_TEXT[title.kind]}
    </span>
  );
}

/** The ids that name a paper: its title, plus its author/year/journal line when there is one. */
function paperDescribedBy(row: ComparisonRow, domId: string): string {
  return identityLine(row) ? `${domId}-title ${domId}-meta` : `${domId}-title`;
}

/**
 * The `md`+ matrix: one row per paper, one column per field of the active
 * group. It scrolls inside the tab panel — never the page — with the paper
 * column and the header row (and its caveats) kept in view.
 *
 * Each column header's accessible name is the exact field label alone, so a
 * screen reader does not repeat a caveat on every cell; the caveat is shown
 * under the label and said once, before the table, in the field notes.
 */
export function ComparisonMatrix({ group, rows, sort, paperDomId, isExpanded, onToggle }: ComparisonLayoutProps) {
  const headRef = useRef<HTMLTableSectionElement>(null);

  // The header row is sticky and its height depends on how its caveats wrap.
  // Its scroll container keeps that much scroll padding at the top, so a
  // control brought into view by Tab never lands underneath it. (The paper
  // column's width is fixed, so its padding is plain CSS on the container.)
  useLayoutEffect(() => {
    const head = headRef.current;
    const scroller = head?.closest<HTMLElement>('[role="tabpanel"]');
    if (!head || !scroller || typeof ResizeObserver === "undefined") return;
    const update = () => {
      scroller.style.scrollPaddingTop = `${head.offsetHeight + 8}px`;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(head);
    return () => {
      observer.disconnect();
      scroller.style.scrollPaddingTop = "";
    };
  }, [group]);

  return (
    <>
      <div className="sr-only">
        <h3>Where these values come from</h3>
        <dl>
          {group.fields.map((field) => (
            <div key={field.id}>
              <dt>{field.label}</dt>
              <dd>{fieldCaveat(field)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <table className="w-max min-w-full border-separate border-spacing-0 text-left align-top text-sm">
        <caption className="sr-only">
          {group.label} for {rows.length} papers, sorted by {SORT_LABELS[sort].toLowerCase()}
        </caption>
        <thead ref={headRef}>
          <tr>
            <th
              scope="col"
              className="sticky left-0 top-0 z-30 w-60 min-w-60 max-w-60 border-b border-r bg-background px-3 py-2 align-bottom font-medium lg:w-72 lg:min-w-72 lg:max-w-72"
            >
              Paper
            </th>
            {group.fields.map((field) => (
              <th
                key={field.id}
                scope="col"
                className={cn(
                  "sticky top-0 z-20 border-b bg-background px-3 py-2 align-bottom font-medium",
                  field.long ? "w-96 min-w-96 max-w-96" : field.id === "year" ? "w-24 min-w-24" : "w-56 min-w-56 max-w-56",
                )}
              >
                <span className="block">{field.label}</span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground" aria-hidden="true">
                  {fieldCaveat(field)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const domId = paperDomId(row.paperId);
            const line = identityLine(row);
            const describedBy = paperDescribedBy(row, domId);
            return (
              <tr key={row.paperId}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 w-60 min-w-60 max-w-60 border-b border-r bg-background px-3 py-2 align-top font-normal lg:w-72 lg:min-w-72 lg:max-w-72"
                >
                  <span id={`${domId}-title`} className="block [overflow-wrap:anywhere] font-medium">
                    <PaperTitle row={row} />
                  </span>
                  {line && (
                    <span id={`${domId}-meta`} className="mt-0.5 block [overflow-wrap:anywhere] text-xs text-muted-foreground">
                      {line}
                    </span>
                  )}
                </th>
                {group.fields.map((field) => (
                  <td key={field.id} className="border-b px-3 py-2 align-top">
                    <ComparisonValue
                      field={field}
                      content={field.read(row)}
                      expanded={isExpanded(row.paperId, field.id)}
                      onToggle={() => onToggle(row.paperId, field.id)}
                      valueId={`${domId}-${field.id}`}
                      paperDescribedBy={describedBy}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/**
 * Below `md`: one card per paper, each listing the active group's fields in
 * the same order, so moving down the cards compares like with like. Every
 * field carries its caveat in every card: a classification is never shown
 * without "not independently verified" beside it.
 */
export function ComparisonCards({ group, rows, sort, paperDomId, isExpanded, onToggle }: ComparisonLayoutProps) {
  return (
    <ol className="space-y-3" aria-label={`${group.label} for ${rows.length} papers, sorted by ${SORT_LABELS[sort].toLowerCase()}`}>
      {rows.map((row) => {
        const domId = paperDomId(row.paperId);
        const line = identityLine(row);
        const describedBy = paperDescribedBy(row, domId);
        return (
          <li key={row.paperId}>
            <article aria-labelledby={describedBy} className="rounded-md border p-3">
              <h3 id={`${domId}-title`} className="[overflow-wrap:anywhere] text-sm font-semibold">
                <PaperTitle row={row} />
              </h3>
              {line && (
                <p id={`${domId}-meta`} className="mt-0.5 [overflow-wrap:anywhere] text-xs text-muted-foreground">
                  {line}
                </p>
              )}
              <dl className="mt-3 space-y-3">
                {group.fields.map((field) => (
                  <div key={field.id}>
                    <dt className="text-xs font-medium">
                      {field.label}
                      <span className="block font-normal text-muted-foreground">{fieldCaveat(field)}</span>
                    </dt>
                    <dd className="mt-1">
                      <ComparisonValue
                        field={field}
                        content={field.read(row)}
                        expanded={isExpanded(row.paperId, field.id)}
                        onToggle={() => onToggle(row.paperId, field.id)}
                        valueId={`${domId}-${field.id}`}
                        paperDescribedBy={describedBy}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            </article>
          </li>
        );
      })}
    </ol>
  );
}
