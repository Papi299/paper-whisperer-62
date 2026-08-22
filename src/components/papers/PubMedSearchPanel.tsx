/**
 * PUBMED-IN-APP-SEARCH-001 — the PubMed discovery surface inside Add Papers.
 *
 * Presentation only. Every piece of state it renders is owned by
 * `usePubMedSearch` in `AddPaperDialog`, which is what lets Radix unmount this
 * tab without losing the query, the page or the selection.
 *
 * ## The architectural boundary this component sits on
 *
 * PubMed Search **discovers PMIDs**. The existing identifier importer
 * **imports PMIDs**. Nothing rendered here is metadata that gets stored: the
 * only thing that leaves this component is a list of selected PMID strings,
 * which `AddPaperDialog` hands to the same `onBulkImport` callback the Import
 * IDs tab uses. Titles, authors, journals and DOIs shown below are display-only
 * discovery summaries; the canonical importer fetches the authoritative record
 * for each selected PMID and owns normalization, authorship provenance,
 * publication types, deduplication and assignment.
 *
 * A DOI is shown when PubMed states one, and it is deliberately *not* the
 * import identifier. The discovery source is PubMed, so the PMID is what gets
 * imported even for a record that also carries a DOI — otherwise a search
 * result's incidental metadata would silently change which provider
 * authenticates the paper.
 *
 * ## Layout rules that are load-bearing, not cosmetic
 *
 * PRs #233–#236 fixed real reachability defects in this repository, and the
 * result row is exactly the shape that produced them: a fixed-size control next
 * to variable-length external text.
 *
 * - The results list is a **plain bounded `overflow-y-auto` element**, not a
 *   Radix `ScrollArea`. Radix wraps its viewport's children in a
 *   `display: table; min-width: 100%` box whose min-content width can exceed
 *   the viewport on an axis that mounts no scrollbar, and putting the height cap
 *   on a `ScrollArea` root leaves the viewport sized to its content so nothing
 *   scrolls at all. A plain element has neither failure mode: one box owns both
 *   the bound and the scrolling.
 * - Every text run uses `break-words`. There is **no `truncate` and no
 *   `whitespace-nowrap`** on any flex child in a row, because a nowrap line's
 *   min-content width is its full length, which widens the row past the
 *   viewport and carries the trailing controls out of reach.
 * - The checkbox is `shrink-0` and comes first; the text column is
 *   `min-w-0 flex-1`, so a 300-character title shrinks the text and never the
 *   control.
 * - The "Open in PubMed" link sits inside the text column, below the metadata,
 *   so it wraps with the text instead of being pinned to a row edge that long
 *   content can push offscreen.
 *
 * ## Selection
 *
 * The checkbox is the selection control and the only selection control. The row
 * is deliberately not a click target: a row-wide toggle that also contains an
 * external link is how a click meant for "Open in PubMed" ends up selecting a
 * paper instead. The checkbox carries a touch-sized padded hit area and an
 * accessible name that names the PMID first, so two records with identical
 * titles remain distinguishable by name alone.
 */

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Search,
} from "lucide-react";
import { canonicalPubMedUrl } from "@/lib/pubmedIdentifiers";
import { PUBMED_SEARCH_MAX_REACHABLE, type PubMedSearchResult } from "@/lib/searchPubMedEdge";
import type { PubMedSearchActions, PubMedSearchState } from "@/hooks/usePubMedSearch";

/** How many authors are named before the row switches to a "+N" summary. */
const AUTHOR_PREVIEW_COUNT = 3;

/** Shown in place of a title PubMed's summary did not supply. */
const MISSING_TITLE_LABEL = "Title unavailable in PubMed summary";

interface PubMedSearchPanelProps {
  state: PubMedSearchState;
  actions: PubMedSearchActions;
  /** False when the Dashboard wired no search callback — Search is then disabled. */
  searchAvailable: boolean;
  /**
   * True while the canonical import for this tab is running. Search and
   * selection are frozen for its duration so a running library mutation cannot
   * have its input changed underneath it.
   */
  importing: boolean;
}

/**
 * Compact display authors: `Author A, Author B, Author C +5`.
 *
 * A consortium paper can list hundreds of names, and a discovery card must stay
 * a card. This is explicitly a preview of what PubMed's *summary* stated — the
 * persisted author list and its provenance come from the canonical import.
 */
function formatAuthors(authors: string[]): string | null {
  if (authors.length === 0) return null;
  if (authors.length <= AUTHOR_PREVIEW_COUNT) return authors.join(", ");
  const shown = authors.slice(0, AUTHOR_PREVIEW_COUNT).join(", ");
  return `${shown} +${authors.length - AUTHOR_PREVIEW_COUNT}`;
}

/** `1–20 of 2,509` style range text, computed from the page actually shown. */
function formatRange(offset: number, shown: number, total: number): string {
  const first = offset + 1;
  const last = offset + shown;
  return `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`;
}

function ResultRow({
  result,
  selected,
  onToggle,
  disabled,
}: {
  result: PubMedSearchResult;
  selected: boolean;
  onToggle(): void;
  disabled: boolean;
}) {
  const title = result.title ?? MISSING_TITLE_LABEL;
  const authors = formatAuthors(result.authors);
  // The PMID leads the accessible name so two records sharing a title are still
  // told apart by name alone — a screen-reader user must never have to rely on
  // visual ordering to know which paper a checkbox belongs to.
  const accessibleName = `Select PMID ${result.pmid} — ${title}`;

  return (
    <li className="border-b last:border-b-0">
      <div className="flex items-start gap-3 p-3">
        {/* `shrink-0` + padded hit area: the control keeps its size and its
            touch target no matter how long the text beside it is. */}
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          disabled={disabled}
          aria-label={accessibleName}
          className="mt-0.5 shrink-0"
        />

        {/* `min-w-0` is what makes the text column shrinkable: without it a long
            unbroken run sets the row's min-content width and pushes everything
            else out of the viewport. */}
        <div className="min-w-0 flex-1 space-y-1">
          <p className={`text-sm font-medium break-words ${result.title ? "" : "italic text-muted-foreground"}`}>
            {title}
          </p>

          {authors && (
            <p className="text-xs text-muted-foreground break-words">{authors}</p>
          )}

          <p className="text-xs text-muted-foreground break-words">
            {[result.journal, result.publicationDate ?? (result.year !== null ? String(result.year) : null)]
              .filter((part): part is string => Boolean(part))
              .join(" · ")}
          </p>

          {result.publicationTypes.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {result.publicationTypes.map((type) => (
                <Badge key={type} variant="secondary" className="text-[10px] font-normal break-words">
                  {type}
                </Badge>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono break-all">PMID {result.pmid}</span>
            {result.doi && <span className="font-mono break-all">DOI {result.doi}</span>}
            {/* Built from the PMID, never from an upstream URL field: the record
                the PMID names is the record this link must open. */}
            <a
              href={canonicalPubMedUrl(result.pmid)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline underline-offset-2 hover:no-underline"
            >
              Open in PubMed
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </div>
        </div>
      </div>
    </li>
  );
}

export function PubMedSearchPanel({
  state,
  actions,
  searchAvailable,
  importing,
}: PubMedSearchPanelProps) {
  const { page, selectedPmids, loading, error, committedQuery } = state;

  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const resultsHeadingRef = useRef<HTMLParagraphElement>(null);

  const selectedCount = selectedPmids.length;
  const selectedSet = new Set(selectedPmids);

  const pageResults = page?.results ?? [];
  const pagePmids = pageResults.map((result) => result.pmid);
  // Drives one tri-state control: "Select all on this page" until every result
  // on the page is chosen, then "Clear page selection". Current page ONLY — it
  // never implies PaperLume is selecting all of PubMed's matches.
  const allOnPageSelected = pagePmids.length > 0 && pagePmids.every((pmid) => selectedSet.has(pmid));

  const idle = !loading && !importing;
  const nextOffset = page ? page.offset + page.limit : 0;
  const canGoPrevious = page !== null && page.offset > 0 && idle;
  const canGoNext =
    page !== null &&
    nextOffset < page.total &&
    // PubMed pages only through its first 9,999 matches. Beyond that the button
    // would produce a rejected request, so it is disabled and the cap is stated
    // in words below rather than left for the user to discover by failing.
    nextOffset < PUBMED_SEARCH_MAX_REACHABLE &&
    idle;

  /**
   * Keep keyboard focus somewhere predictable after a page change.
   *
   * Pressing Next on the second-to-last page disables Next, and a disabled
   * button drops focus onto `<body>` — the user's place in the dialog would
   * simply vanish. When that happens focus moves to the other pagination
   * control, or to the results heading (`tabIndex={-1}`, never a Tab stop) when
   * neither control is usable. When the pressed button stays enabled nothing is
   * touched, so focus is never stolen from a user who moved on.
   */
  useEffect(() => {
    if (loading) return;
    const active = document.activeElement;
    if (active !== document.body && active !== null) return;
    if (!page) return;
    if (canGoNext) nextRef.current?.focus();
    else if (canGoPrevious) previousRef.current?.focus();
    else resultsHeadingRef.current?.focus();
  }, [loading, page, canGoNext, canGoPrevious]);

  const submitDisabled = !searchAvailable || loading || importing || state.draftQuery.trim() === "";

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (submitDisabled) return;
    actions.submitSearch();
  };

  const showEmptyState = Boolean(committedQuery) && !loading && !error && page !== null && page.results.length === 0;

  return (
    <div className="space-y-4">
      {/* ── Search form ── */}
      <form onSubmit={handleSubmit} className="space-y-2">
        <Label htmlFor="pubmed-search-query">Search PubMed</Label>
        <div className="flex flex-wrap items-start gap-2">
          <Input
            id="pubmed-search-query"
            // A plain text input inside a form: Enter submits natively, so
            // Enter-to-search needs no key handler and cannot drift from what
            // the Search button does.
            type="text"
            placeholder='e.g. resistance training hypertrophy'
            value={state.draftQuery}
            onChange={(event) => actions.setDraftQuery(event.target.value)}
            disabled={importing}
            className="min-w-0 flex-1"
            autoComplete="off"
          />
          <Button type="submit" disabled={submitDisabled} className="shrink-0">
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Search className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            Search
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Full PubMed search syntax is supported — field tags, quoted phrases and Boolean
          operators are sent to PubMed exactly as you type them, for example{" "}
          <span className="font-mono break-all">(&quot;resistance training&quot;[Title/Abstract]) AND muscle</span>.
        </p>
        {!searchAvailable && (
          <p className="text-xs text-muted-foreground">PubMed search is unavailable right now.</p>
        )}
      </form>

      {/* ── Error ── */}
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <p className="flex items-start gap-2 font-medium text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{error.message}</span>
          </p>
          {page !== null && (
            <p className="mt-1 pl-6 text-xs text-muted-foreground">
              The results below are still from your last successful search.
            </p>
          )}
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Searching PubMed…
        </p>
      )}

      {/* ── Empty result set ── A valid answer, not an error. */}
      {showEmptyState && (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          No PubMed results found. Try different terms or fewer filters.
        </p>
      )}

      {/* ── Results ── */}
      {page !== null && page.results.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p
              ref={resultsHeadingRef}
              tabIndex={-1}
              // Announced when the range changes, so a page move is perceivable
              // without sight of the list.
              aria-live="polite"
              className="text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Showing <span className="font-medium text-foreground">{formatRange(page.offset, page.results.length, page.total)}</span>{" "}
              matching papers
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              disabled={importing}
              onClick={() => (allOnPageSelected ? actions.clearPageSelection() : actions.selectAllOnPage())}
            >
              {allOnPageSelected ? "Clear page selection" : "Select all on this page"}
            </Button>
          </div>

          {page.total > PUBMED_SEARCH_MAX_REACHABLE && (
            <p className="text-xs text-muted-foreground">
              PubMed pages through the first {PUBMED_SEARCH_MAX_REACHABLE.toLocaleString()} matches
              only. Narrow the search to reach the rest.
            </p>
          )}

          {/*
            One bounded scroll owner: `max-h` and `overflow-y-auto` are on the
            SAME element, so `scrollHeight > clientHeight` whenever the list is
            taller than the cap and the wheel/touch/keyboard all reach the last
            row. `overscroll-contain` keeps a phone pan inside the list instead
            of chaining to the dialog behind it.
          */}
          <ul
            aria-label="PubMed search results"
            className="max-h-[45vh] overflow-y-auto overscroll-contain rounded-md border"
          >
            {pageResults.map((result) => (
              // PMID, never the array index: the identity of a search result is
              // the record it names, so a row keeps its checkbox state when the
              // page re-renders and two identically titled records stay
              // separate rows.
              <ResultRow
                key={result.pmid}
                result={result}
                selected={selectedSet.has(result.pmid)}
                onToggle={() => actions.toggleSelection(result.pmid)}
                disabled={importing}
              />
            ))}
          </ul>

          {/* ── Pagination ── */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              ref={previousRef}
              type="button"
              variant="outline"
              size="sm"
              disabled={!canGoPrevious}
              onClick={() => actions.goToPage(-1)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />
              Previous
            </Button>
            <Button
              ref={nextRef}
              type="button"
              variant="outline"
              size="sm"
              disabled={!canGoNext}
              onClick={() => actions.goToPage(1)}
            >
              Next
              <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Selection summary ──
          Rendered whenever anything is selected, including PMIDs chosen on a
          page that is no longer on screen: the count is global, and Clear works
          globally, so nobody has to walk back through pages to undo a
          selection. */}
      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/50 p-3">
          {/* One contiguous text node on purpose: a count split across elements
              reads as three fragments to a screen reader announcing the live
              region, and cannot be matched as a sentence by a test either. */}
          <p className="text-sm font-medium" aria-live="polite">
            {`${selectedCount} paper${selectedCount === 1 ? "" : "s"} selected`}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            disabled={importing}
            onClick={actions.clearSelection}
          >
            Clear selection
          </Button>
        </div>
      )}
    </div>
  );
}
