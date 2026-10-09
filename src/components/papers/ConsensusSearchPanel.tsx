/**
 * CONSENSUS-SEARCH-MVP-001A — the owner-only Consensus discovery surface inside
 * Add Papers → Search.
 *
 * Presentation only. Every piece of state it renders is owned by
 * `useConsensusSearch` in `AddPaperDialog`, which is what lets the owner switch
 * between the PubMed and Consensus sources without losing either one's work.
 *
 * ## The architectural boundary this component sits on
 *
 * Consensus Search **discovers DOIs**. The existing identifier importer
 * **imports DOIs**. Nothing rendered here is metadata that gets stored: the only
 * thing that leaves is a list of selected, validated DOI strings, which
 * `AddPaperDialog` hands to the same `onBulkImport` the Import IDs tab uses.
 * Title, authors, journal, year, study type, citation count, abstract and the
 * Consensus takeaway are display-only discovery data; the canonical importer
 * fetches each paper's authoritative record from PubMed/Crossref itself. A
 * result without a validated DOI stays a valid discovery result but is not
 * selectable — it shows "No importable DOI available" instead of a checkbox.
 *
 * ## Quota-conscious
 *
 * The connected Consensus allowance is small, so the only control that can
 * cause a request is the Search button (or Enter in the query field, which is
 * the same form submission). There is one result page and no pagination, no
 * search-as-you-type, and nothing here runs on mount, on selection or on a
 * source switch. No remaining-call figure is shown: PaperLume has no source of
 * truth for the owner's remaining allowance and does not invent one.
 *
 * ## Layout rules carried over from `PubMedSearchPanel`
 *
 * The result row has the shape PRs #233–#236 fixed reachability defects in — a
 * fixed-size control beside variable-length external text — so it follows the
 * same rules: a plain bounded `overflow-y-auto` list rather than a Radix
 * `ScrollArea`; `break-words` on every text run and no `truncate` or
 * `whitespace-nowrap` on a flex child; a `shrink-0` checkbox first and a
 * `min-w-0 flex-1` text column; the external link inside the text column; the
 * row itself is not a click target, so the checkbox and the link are never
 * nested; and the checkbox carries the same 44×44 transparent touch halo.
 */

import { useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ExternalLink, Loader2, Search } from "lucide-react";
import {
  CONSENSUS_SEARCH_MAX_QUERY_LENGTH,
  consensusSelectionKey,
  toImportableDoi,
  toSafeConsensusUrl,
  type ConsensusSearchResult,
} from "@/lib/searchConsensusEdge";
import type { ConsensusSearchActions, ConsensusSearchState } from "@/hooks/useConsensusSearch";

/** How many authors are named before the row switches to a "+N" summary. */
const AUTHOR_PREVIEW_COUNT = 3;

/** Longest abstract excerpt a card shows, in characters, before an ellipsis. */
const ABSTRACT_EXCERPT_LENGTH = 280;

/** Shown in place of a title the Consensus result did not supply. */
const MISSING_TITLE_LABEL = "Title unavailable in Consensus result";

/**
 * Roles of the structural containers focus falls back to inside Add Papers —
 * the dialog shell (Radix's focus trap) and the mode's tab panel. Focus resting
 * on one of them is not focus the owner placed on a control.
 */
const FOCUS_CONTAINER_ROLES: ReadonlySet<string> = new Set(["dialog", "tabpanel"]);

/** The owner-facing quota and privacy note. Stays true on any Consensus plan. */
export const CONSENSUS_QUOTA_NOTE =
  "Consensus searches use your connected API allowance and run only when you press Search. Your question is sent to Consensus.";

/**
 * The same transparent 44×44 hit region `PubMedSearchPanel` gives its 16×16
 * checkbox (see `CHECKBOX_TOUCH_TARGET_CLASS` there for the measurements and
 * why it is a pseudo-element rather than a wrapper or a `coarse:` variant).
 */
const CHECKBOX_TOUCH_TARGET_CLASS = "relative before:absolute before:-inset-3.5 before:content-['']";

interface ConsensusSearchPanelProps {
  state: ConsensusSearchState;
  actions: ConsensusSearchActions;
  /**
   * True while the canonical import of this source's selection is running.
   * Search and selection are frozen so a running library mutation cannot have
   * its input changed underneath it.
   */
  importing: boolean;
}

function formatAuthors(authors: string[]): string | null {
  if (authors.length === 0) return null;
  if (authors.length <= AUTHOR_PREVIEW_COUNT) return authors.join(", ");
  return `${authors.slice(0, AUTHOR_PREVIEW_COUNT).join(", ")} +${authors.length - AUTHOR_PREVIEW_COUNT}`;
}

/** Consensus sends lower-case design labels (`rct`, `meta-analysis`); display them readably. */
function formatStudyType(value: string): string {
  const withAcronym = value.replace(/\brct\b/gi, "RCT");
  return withAcronym.charAt(0).toUpperCase() + withAcronym.slice(1);
}

function formatCitations(count: number): string {
  return `${count.toLocaleString()} citation${count === 1 ? "" : "s"}`;
}

/** A compact excerpt that ends on a word boundary when one is near. */
function excerpt(text: string): string {
  if (text.length <= ABSTRACT_EXCERPT_LENGTH) return text;
  const cut = text.slice(0, ABSTRACT_EXCERPT_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > ABSTRACT_EXCERPT_LENGTH * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function ResultRow({
  result,
  importDoi,
  selected,
  onToggle,
  disabled,
}: {
  result: ConsensusSearchResult;
  /** Already re-validated by the panel; `null` means discovery-only. */
  importDoi: string | null;
  selected: boolean;
  onToggle(): void;
  disabled: boolean;
}) {
  const title = result.title ?? MISSING_TITLE_LABEL;
  const authors = formatAuthors(result.authors);
  // Validated again at the point of rendering: an href is only ever the
  // parser-normalized form of an allow-listed consensus.app paper URL.
  const consensusUrl = toSafeConsensusUrl(result.consensusUrl);
  const metadata = [
    result.journal,
    result.year !== null ? String(result.year) : null,
    result.citationCount !== null ? formatCitations(result.citationCount) : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <li className="border-b last:border-b-0">
      <div className="flex items-start gap-3 p-3">
        {importDoi ? (
          // The DOI leads the accessible name, so two results sharing a title
          // stay distinguishable by name alone.
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            disabled={disabled}
            aria-label={`Select DOI ${importDoi} — ${title}`}
            className={`mt-0.5 shrink-0 ${CHECKBOX_TOUCH_TARGET_CLASS}`}
          />
        ) : (
          // Keeps the text column aligned with selectable rows. Not a control.
          <span className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        )}

        <div className="min-w-0 flex-1 space-y-1">
          <p className={`text-sm font-medium break-words ${result.title ? "" : "italic text-muted-foreground"}`}>
            {title}
          </p>

          {authors && <p className="text-xs text-muted-foreground break-words">{authors}</p>}

          {metadata.length > 0 && <p className="text-xs text-muted-foreground break-words">{metadata.join(" · ")}</p>}

          {result.studyType && (
            <div className="flex flex-wrap gap-1">
              <Badge variant="secondary" className="text-[10px] font-normal break-words">
                <span className="sr-only">Study type: </span>
                {formatStudyType(result.studyType)}
              </Badge>
            </div>
          )}

          {result.takeaway && (
            <p className="text-xs break-words">
              <span className="font-medium">Consensus takeaway</span>{" "}
              <span className="text-muted-foreground">(generated by Consensus · not saved):</span>{" "}
              {result.takeaway}
            </p>
          )}

          {result.abstract && (
            <p className="text-xs text-muted-foreground break-words">{excerpt(result.abstract)}</p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {importDoi ? (
              <span className="font-mono break-all">DOI {importDoi}</span>
            ) : (
              <span className="italic">No importable DOI available</span>
            )}
            {consensusUrl && (
              <a
                href={consensusUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary underline underline-offset-2 hover:no-underline"
              >
                Open in Consensus
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export function ConsensusSearchPanel({ state, actions, importing }: ConsensusSearchPanelProps) {
  const { results, selectedDois, loading, error, committedQuery, draftQuery } = state;

  const resultsHeadingRef = useRef<HTMLParagraphElement>(null);
  const queryInputRef = useRef<HTMLInputElement>(null);

  const selectedKeys = useMemo(() => new Set(selectedDois.map(consensusSelectionKey)), [selectedDois]);
  const rows = useMemo(
    () => (results ?? []).map((result) => ({ result, importDoi: toImportableDoi(result.importDoi) })),
    [results],
  );
  const importableKeys = useMemo(
    () => new Set(rows.flatMap(({ importDoi }) => (importDoi ? [consensusSelectionKey(importDoi)] : []))),
    [rows],
  );
  const allImportableSelected =
    importableKeys.size > 0 && [...importableKeys].every((key) => selectedKeys.has(key));

  const trimmedLength = draftQuery.trim().length;
  const overLimit = trimmedLength > CONSENSUS_SEARCH_MAX_QUERY_LENGTH;
  const submitDisabled = loading || importing || trimmedLength === 0 || overLimit;

  /**
   * Keep keyboard focus somewhere predictable after a search. Pressing Search
   * disables the button for the request's duration, and a disabled button drops
   * focus onto `<body>`. Inside the Add Papers dialog it rarely stays there:
   * Radix's focus trap parks it on the dialog shell once the loading line is
   * removed, and the Search mode's tab panel is itself focusable. Focus resting
   * on `<body>` or on one of those structural containers therefore counts as
   * lost. When the request settles with focus lost, focus moves to the results
   * heading (`tabIndex={-1}`, never a Tab stop) or back to the query field.
   * Focus on any control the owner moved to is never stolen.
   */
  useEffect(() => {
    if (loading) return;
    const active = document.activeElement;
    const focusLost =
      active === null ||
      active === document.body ||
      (active instanceof HTMLElement && FOCUS_CONTAINER_ROLES.has(active.getAttribute("role") ?? ""));
    if (!focusLost) return;
    if (results && results.length > 0) resultsHeadingRef.current?.focus();
    else if (committedQuery) queryInputRef.current?.focus();
  }, [loading, results, committedQuery]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (submitDisabled) return;
    actions.submitSearch();
  };

  const showEmptyState = Boolean(committedQuery) && !loading && !error && results !== null && results.length === 0;
  const selectedCount = selectedDois.length;

  return (
    <div className="space-y-4">
      {/* ── Search form ── */}
      <form onSubmit={handleSubmit} className="space-y-2">
        <Label htmlFor="consensus-search-query">Search Consensus</Label>
        <div className="flex flex-wrap items-start gap-2">
          <Input
            ref={queryInputRef}
            id="consensus-search-query"
            type="text"
            placeholder="e.g. Does creatine improve cognition in healthy adults?"
            value={draftQuery}
            onChange={(event) => actions.setDraftQuery(event.target.value)}
            disabled={importing}
            className="min-w-0 flex-1"
            autoComplete="off"
            aria-describedby="consensus-search-note"
            aria-invalid={overLimit || undefined}
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
        <p id="consensus-search-note" className="text-xs text-muted-foreground">
          {CONSENSUS_QUOTA_NOTE}
        </p>
        {overLimit && (
          <p className="text-xs font-medium text-destructive">
            {`Shorten the question to ${CONSENSUS_SEARCH_MAX_QUERY_LENGTH} characters or fewer (currently ${trimmedLength}).`}
          </p>
        )}
      </form>

      {/* ── Error ── */}
      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="flex items-start gap-2 font-medium text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{error.message}</span>
          </p>
          {results !== null && (
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
          Searching Consensus…
        </p>
      )}

      {/* ── Empty result set ── A valid answer, not an error. */}
      {showEmptyState && (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          No Consensus results found. Try rephrasing your question.
        </p>
      )}

      {/* ── Results ── */}
      {results !== null && results.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p
              ref={resultsHeadingRef}
              tabIndex={-1}
              aria-live="polite"
              className="text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {`Showing ${results.length} Consensus result${results.length === 1 ? "" : "s"}`}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              disabled={importing || importableKeys.size === 0 || allImportableSelected}
              onClick={actions.selectAllImportable}
            >
              Select all importable results
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Results are for discovery only. Importing a result sends just its DOI to PaperLume&apos;s importer, which
            fetches the paper&apos;s details itself.
          </p>

          {/* One bounded scroll owner: `max-h` and `overflow-y-auto` on the SAME element. */}
          <ul aria-label="Consensus search results" className="max-h-[45vh] overflow-y-auto overscroll-contain rounded-md border">
            {rows.map(({ result, importDoi }) => (
              <ResultRow
                key={result.rank}
                result={result}
                importDoi={importDoi}
                selected={importDoi !== null && selectedKeys.has(consensusSelectionKey(importDoi))}
                onToggle={() => {
                  if (importDoi) actions.toggleSelection(importDoi);
                }}
                disabled={importing}
              />
            ))}
          </ul>
        </div>
      )}

      {/* ── Selection summary ── */}
      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/50 p-3">
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
