import { useState, useMemo, useCallback, useRef } from "react";
import { authorSearchMatches } from "@/lib/authorNames";
import {
  buildAuthorIdentityResolution,
  indexAuthorEntities,
  type AuthorIdentityDataset,
  type AuthorIdentityPaper,
} from "@/lib/authorIdentity";
import { reconcileAuthorSelections, toggleAuthorSelection } from "@/lib/authorSelection";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTouchSafeInitialFocus } from "@/hooks/useCoarsePointer";
import { MobileMultiSelectSheet } from "./MobileMultiSelectSheet";
import { ManageAuthorIdentitiesButton } from "./AuthorIdentityManager";
import type {
  AuthorIdentityReadState,
  useAuthorIdentities,
} from "@/hooks/useAuthorIdentities";
import { Paper } from "@/types/database";
import type { AnalyticsTargets } from "@/hooks/useAnalyticsTargets";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { X, Search, FileText, Users, Calendar, FlaskConical } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

/**
 * The analytics body — summary tiles, distributions and the target selectors.
 *
 * Extracted from `AnalyticsPanel` so the desktop inline Collapsible and the
 * mobile overlay render the SAME charts from the SAME computation. Nothing
 * statistical lives in the shells; every `useMemo` below is the original code,
 * moved rather than rewritten, so the numbers cannot diverge by presentation.
 *
 * The component is a pure function of `papers` and `targets`: it derives the
 * charts but owns no selection state, because it is mounted twice across a
 * session — once per responsive shell — and anything it owned would be
 * discarded at the breakpoint.
 */

interface AnalyticsContentProps {
  papers: Paper[];
  isLoading: boolean;
  /**
   * Selected target keywords/authors and their handlers.
   *
   * Controlled rather than internal: the desktop and mobile shells are separate
   * component instances chosen by viewport width, so state owned here would be
   * destroyed every time the user crossed 768px. See `useAnalyticsTargets`.
   */
  targets: AnalyticsTargets;
  /**
   * The signed-in user's author-identity decisions, or `null` when the identity
   * subsystem is not installed in this environment.
   *
   * `null` is not "no decisions" — it is "cannot know", and it is also the
   * default, which is what makes this additive. Without it every mention is
   * unresolved and the author story is exactly the 001A textual grouping this
   * component has always done. That is the behaviour a Vercel Preview gets while
   * Production still predates the 001C migration, and the behaviour every
   * pre-001C test of this component continues to assert.
   */
  identityDataset?: AuthorIdentityDataset | null;
  /**
   * The papers the identity graph links to, across the whole account.
   *
   * Not the same collection as `papers`, and deliberately so. `papers` is the
   * current Analytics filter and decides what is counted and charted;
   * `identityEvidencePapers` decides what an existing person IS — which
   * spellings the user accepted for them, which ORCIDs their linked papers
   * state, whether they have anything attached at all.
   *
   * Letting the filter supply both made a dropdown redefine the identity graph:
   * narrowing the view removed the paper carrying a person's ORCID, so the
   * exact-ORCID candidate that person exists to produce was never offered, their
   * linked spellings stopped being searchable, and an identity with links
   * elsewhere in the library rendered as empty. Omitted, it falls back to
   * `papers`, which is correct for any caller whose view IS the library.
   */
  identityEvidencePapers?: readonly AuthorIdentityPaper[];
  /**
   * Why `identityDataset` looks the way it does.
   *
   * `identityDataset === null` has two completely different meanings, and this
   * component cannot tell them apart on its own: the 001C subsystem is not
   * installed here (expected, and 001A grouping is the correct answer), or the
   * user's identity decisions FAILED TO LOAD. Treating the second as the first
   * is the quiet failure this prop exists to prevent — a user who has resolved
   * `Stuart M Phillips` and `S M Phillips` into one person would watch them
   * silently become two authors again and be told nothing.
   *
   * Defaults to `"ready"`, which is what every pure test of the charts wants:
   * the dataset it passes is the whole truth and no warning is warranted.
   */
  identityReadState?: AuthorIdentityReadState;
  /**
   * The identity read/write API, when the application supplies one.
   *
   * Separate from `identityDataset` on purpose. The dataset is all this
   * component needs to GROUP authors, so it stays a pure function of data and is
   * testable as one; the API is only needed to OPEN the management surface, and
   * omitting it simply means no manage button — which is what every unit test of
   * the charts wants.
   */
  identities?: ReturnType<typeof useAuthorIdentities>;
  /**
   * Narrow-viewport sizing. Purely dimensional: it shortens the category axis
   * (which is 320px wide on desktop and would leave almost no room for the bars
   * themselves at 390px) and drops the summary tiles to two columns. No series,
   * no filtering and no aggregate changes.
   */
  compact?: boolean;
}

/**
 * One selectable option.
 *
 * `value` and `label` are separate because after 001C they genuinely differ for
 * authors: the value is a stable entity key (`identity:<root>` or
 * `mention:<key>`) and the label is what the user reads. Keeping them apart is
 * what lets an identity keep its selection across a rename, and what allows two
 * different people to legitimately share a display name without the selector
 * collapsing them — a real possibility now that identities do not enforce unique
 * preferred names.
 *
 * Keywords set both to the same string, which is exactly what they always were.
 */
interface SelectOption {
  value: string;
  label: string;
  /** Extra strings this option is findable by. See `MobileMultiSelectOption`. */
  searchTerms?: readonly string[];
}

/**
 * A target selector (keywords or authors).
 *
 * Desktop keeps the anchored popover. Below 768px it becomes a bottom sheet:
 * these two controls sit at the very end of the mobile Analytics overlay, so an
 * anchored panel opened into the last few pixels of the screen, and Radix
 * autofocused its search box — raising the software keyboard over the little
 * that was left. The author list in particular runs to hundreds of entries and
 * has to be genuinely scrollable to be usable at all.
 */
/**
 * Radix wraps a ScrollArea's children in an element styled
 * `display: table; min-width: 100%`. A table box is never laid out narrower
 * than its own min-content width, and `truncate` sets `white-space: nowrap`,
 * which makes a line's min-content width its FULL length. So a long label does
 * not get clipped by the viewport — it widens the wrapper past it, carrying the
 * rest of the row out of view. The viewport is `overflow-x: hidden` and
 * `ui/scroll-area` mounts only a vertical scrollbar, so what goes out there is
 * reachable by script and by nobody else.
 *
 * Forcing the wrapper to `block` makes it take the viewport's width, which is
 * what lets `truncate` do the clipping it was written to do. Local to this
 * surface on purpose — the shared ScrollArea is left alone. Tailwind v3, so the
 * `!block` prefix form is correct. Same fix as AUTHOR-IDENTITY-PICKER-USABILITY-001.
 */
const SCROLL_CONTENT_FITS_WIDTH = "[&_[data-radix-scroll-area-viewport]>div]:!block";

function MultiSelectPopover({
  label,
  options,
  selected,
  selectedBadges: selectedBadgeItems,
  onToggle,
  onClear,
  fullWidth,
  matchesSearch,
}: {
  label: string;
  options: SelectOption[];
  /** Selected option VALUES, not labels. */
  selected: string[];
  /**
   * What to render as removable badges, each already carrying its own display
   * text.
   *
   * Separate from `selected` because a value is not always printable. An author
   * selection is an internal entity key (`identity:<uuid>`, `mention:<001A
   * key>`), and the previous "fall back to the value when no option matches it"
   * rule put exactly those keys on screen the moment a selection left the
   * current view. The caller knows how to describe its own selections — and for
   * authors, remembers how — so it supplies the text rather than this component
   * guessing at it.
   */
  selectedBadges: readonly { value: string; label: string }[];
  onToggle: (value: string, label: string) => void;
  onClear: () => void;
  fullWidth?: boolean;
  /**
   * How a query is matched against one searchable term of an option. Omit for
   * the default — case-insensitive substring on the label — which is what
   * Keywords use and must keep using: a keyword is a literal string, so folding
   * its punctuation would change which keywords a search finds.
   *
   * Authors override it because their options are grouped canonically and must
   * stay reachable by any spelling that groups into them — including, for a
   * resolved identity, its aliases and every linked source spelling.
   */
  matchesSearch?: (term: string, search: string) => boolean;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // A tablet keeps the anchored popover (>=768px is still the desktop
  // composition) but is driven by a finger, so opening it must not autofocus
  // the search box and raise the software keyboard over the option list — the
  // author list in particular runs to hundreds of entries. Focus goes to the
  // popover panel, which Radix already renders with `tabIndex={-1}`: inside the
  // surface and dismissable, just not a text field. Each Target selector is its
  // own `MultiSelectPopover` instance, so Keywords and Authors get independent
  // refs without any extra plumbing. Mouse behaviour is unchanged.
  const { focusRef: popoverRef, onOpenAutoFocus } =
    useTouchSafeInitialFocus<HTMLDivElement>();
  const filtered = useMemo(
    () =>
      options.filter((option) =>
        matchesSearch
          ? (option.searchTerms ?? [option.label]).some((term) => matchesSearch(term, search))
          : option.label.toLowerCase().includes(search.toLowerCase())
      ),
    [options, search, matchesSearch]
  );

  /**
   * The text for a value the sheet reported back.
   *
   * The sheet can only toggle something it rendered, which is either a current
   * option or a current selection — so one of the two lookups always answers,
   * and an internal author key never reaches the label through here.
   */
  const labelFor = (value: string) =>
    options.find((option) => option.value === value)?.label ??
    selectedBadgeItems.find((item) => item.value === value)?.label ??
    value;

  const triggerContent = (
    <>
      {label}
      {selected.length > 0 && (
        <Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0">
          {selected.length}
        </Badge>
      )}
    </>
  );

  const selectedBadges = selectedBadgeItems.length > 0 && (
    <div className="flex flex-wrap gap-1">
      {selectedBadgeItems.map((item) => (
        // A selection whose option is no longer on offer — its papers filtered
        // away, the person deleted — still needs a badge the user can see and
        // remove. It carries its own text, so nothing here has to invent one.
        <Badge key={item.value} variant="secondary" className="text-xs pr-1">
          <span className="truncate max-w-[120px]">{item.label}</span>
          <button
            onClick={() => onToggle(item.value, item.label)}
            aria-label={`Remove ${item.label}`}
            className="ml-1 hover:text-destructive"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </Badge>
      ))}
    </div>
  );

  if (isMobile) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Button
            ref={triggerRef}
            variant="outline"
            size="sm"
            className={fullWidth ? "h-8 flex-1 text-xs" : "h-8 text-xs"}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            {triggerContent}
          </Button>
          {selected.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-muted-foreground"
              onClick={onClear}
            >
              Clear
            </Button>
          )}
        </div>
        <MobileMultiSelectSheet
          open={open}
          onOpenChange={setOpen}
          title={label}
          triggerRef={triggerRef}
          options={options}
          selectedValues={selected}
          onToggle={(value) => onToggle(value, labelFor(value))}
          onClear={onClear}
          searchPlaceholder={`Search ${label.toLowerCase()}...`}
          searchLabel={`Search ${label.toLowerCase()}`}
          emptyMessage="No matches"
          matchesSearch={matchesSearch}
        />
        {selectedBadges}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={fullWidth ? "h-8 flex-1 text-xs" : "h-8 text-xs"}
            >
              {triggerContent}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            ref={popoverRef}
            onOpenAutoFocus={onOpenAutoFocus}
            className="w-72 max-w-[calc(100vw-2rem)] p-2"
            align="start"
          >
            <div className="relative mb-2">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={`Search ${label.toLowerCase()}...`}
                aria-label={`Search ${label.toLowerCase()}`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-7 text-sm"
              />
            </div>
            <ScrollArea className={cn("max-h-[300px] overflow-y-auto", SCROLL_CONTENT_FITS_WIDTH)}>
              <div className="space-y-0.5">
                {filtered.length === 0 && (
                  <p className="text-xs text-muted-foreground py-2 px-2">No matches</p>
                )}
                {filtered.map((option) => (
                  <label
                    key={option.value}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer text-sm"
                  >
                    <Checkbox
                      checked={selected.includes(option.value)}
                      onCheckedChange={() => onToggle(option.value, option.label)}
                    />
                    <span className="truncate">{option.label}</span>
                  </label>
                ))}
              </div>
            </ScrollArea>
          </PopoverContent>
        </Popover>
        {selected.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs text-muted-foreground"
            onClick={onClear}
          >
            Clear
          </Button>
        )}
      </div>
      {selectedBadges}
    </div>
  );
}

const CHART_COLORS = [
  "hsl(222, 47%, 31%)",
  "hsl(210, 60%, 45%)",
  "hsl(190, 50%, 40%)",
  "hsl(160, 45%, 40%)",
  "hsl(140, 40%, 45%)",
  "hsl(40, 70%, 50%)",
  "hsl(20, 65%, 50%)",
  "hsl(0, 60%, 50%)",
];

function PercentTooltip({ active, payload, total }: {
  active?: boolean;
  payload?: Array<{ value: number; name: string }>;
  total: number;
}) {
  if (!active || !payload?.[0]) return null;
  const value = payload[0].value;
  const pct = total > 0 ? ((value / total) * 100).toFixed(1) : "0";
  return (
    <div className="bg-popover border border-border rounded-md px-3 py-2 text-xs shadow">
      <span className="font-medium">{value}</span>
      <span className="text-muted-foreground ml-1">({pct}%)</span>
    </div>
  );
}

export function AnalyticsContent({
  papers,
  isLoading,
  targets,
  identityDataset = null,
  identityEvidencePapers,
  identityReadState = "ready",
  identities,
  compact = false,
}: AnalyticsContentProps) {
  const {
    selectedKeywords,
    selectedAuthors,
    onToggleKeyword,
    onSetAuthors,
    onClearKeywords,
    onClearAuthors,
  } = targets;

  /**
   * Every author in the current papers, grouped into effective author entities.
   *
   * One pass is the whole author story: the option list, the summary tile and
   * the per-author paper counts all read from this, so they cannot disagree
   * about what counts as one author.
   *
   * The grouping is deliberately mixed, and honest about it:
   *
   *   • a mention the user has explicitly resolved counts as the PERSON it
   *     resolves to, collapsing every spelling they linked — so `Stuart M
   *     Phillips` and `S M Phillips` become one author once, and only once, the
   *     user says they are one;
   *   • a mention they have not resolved counts as the 001A textual mention it
   *     has always counted as. `Stuart M. Phillips` and `Stuart M Phillips`
   *     still group as one spelling written twice; `S M Phillips` and `Stuart
   *     Phillips` still stay apart, and a shared ORCID does NOT bring them
   *     together, because a matching identifier is something a source stated,
   *     not a decision this user made.
   *
   * See `lib/authorIdentity` and `lib/authorNames`.
   */
  const identityResolution = useMemo(
    () => buildAuthorIdentityResolution(papers, identityDataset, identityEvidencePapers),
    [papers, identityDataset, identityEvidencePapers]
  );

  const authorEntities = useMemo(
    () => indexAuthorEntities(papers, identityResolution),
    [papers, identityResolution]
  );

  // Summary stats
  const summaryStats = useMemo(() => {
    const years = papers.map(p => p.year).filter((y): y is number => y != null);
    const minYear = years.length > 0 ? Math.min(...years) : null;
    const maxYear = years.length > 0 ? Math.max(...years) : null;
    const uniqueStudyTypes = new Set(
      papers.map(p => p.study_type).filter((st): st is string => !!st)
    );
    return {
      totalPapers: papers.length,
      // Distinct effective author entities: one per identity the user has
      // resolved, one per unresolved canonical mention. Not "verified people" —
      // an unresolved mention is still just a string, and is counted as one.
      uniqueAuthors: authorEntities.length,
      yearRange: minYear && maxYear
        ? minYear === maxYear ? `${minYear}` : `${minYear}–${maxYear}`
        : "N/A",
      studyTypesCount: uniqueStudyTypes.size,
    };
  }, [papers, authorEntities]);

  // Study type distribution (auto, no selection needed)
  // Exclude: empty/generic types, PubMed funding tags, excluded/rejected papers
  const studyTypeStats = useMemo(() => {
    const genericTypes = new Set(["not specified", "journal article"]);
    const isNoise = (st: string) => {
      const lower = st.toLowerCase();
      return genericTypes.has(lower)
        || lower.includes("research support")
        || lower.includes("gov't");
    };
    const counts: Record<string, number> = {};
    papers.forEach(p => {
      const st = p.study_type?.trim();
      if (st && !isNoise(st)) counts[st] = (counts[st] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([type, count]) => ({
        name: type.length > 35 ? type.substring(0, 35) + "…" : type,
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [papers]);

  // Year distribution
  const yearStats = useMemo(() => {
    const counts: Record<number, number> = {};
    papers.forEach(p => {
      if (p.year) counts[p.year] = (counts[p.year] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([year, count]) => ({ name: year, count }))
      .sort((a, b) => Number(a.name) - Number(b.name));
  }, [papers]);

  // Extract unique keywords and authors from current filtered papers
  const availableKeywords = useMemo(() => {
    const set = new Set<string>();
    papers.forEach((p) => {
      p.keywords?.forEach((k) => set.add(k));
      p.mesh_terms?.forEach((k) => set.add(k));
    });
    return Array.from(set).sort();
  }, [papers]);

  /**
   * One option per effective author entity: a resolved identity is labelled with
   * its preferred name, an unresolved mention with the representative source
   * spelling 001A always chose.
   *
   * Sorting by label no longer risks merging options, because the option's
   * identity is now its `value` — an entity key — rather than its text. That
   * matters: two identities may legitimately carry the same preferred name, and
   * before 001C the label WAS the key, so this list could not have represented
   * them as two options at all.
   */
  const availableAuthors = useMemo(
    () =>
      authorEntities
        .map((entity) => ({
          value: entity.key,
          label: entity.label,
          searchTerms: entity.searchTerms,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [authorEntities]
  );

  const availableKeywordOptions = useMemo(
    () => availableKeywords.map((keyword) => ({ value: keyword, label: keyword })),
    [availableKeywords]
  );

  // A keyword IS its own label — the string the user selected is the string they
  // read — so nothing has to be remembered or reconciled for it.
  const selectedKeywordBadges = useMemo(
    () => selectedKeywords.map((keyword) => ({ value: keyword, label: keyword })),
    [selectedKeywords]
  );

  /**
   * What the stored author selections mean right now.
   *
   * The identity graph moves while the user is looking at it — a mention becomes
   * a person, two people become one, either is undone — and a selection stored as
   * a bare key survives none of that. All of the reconciliation rules live in
   * `lib/authorSelection`, computed on read rather than written back to state,
   * which is what lets undoing a merge restore the earlier selection with no undo
   * bookkeeping anywhere. This component only presents the result.
   */
  const authorSelections = useMemo(
    () => reconcileAuthorSelections(selectedAuthors, authorEntities, identityResolution),
    [selectedAuthors, authorEntities, identityResolution]
  );

  const selectedAuthorKeys = useMemo(
    () => authorSelections.map((selection) => selection.entityKey),
    [authorSelections]
  );

  const selectedAuthorBadges = useMemo(
    () =>
      authorSelections.map((selection) => ({
        value: selection.entityKey,
        label: selection.label,
      })),
    [authorSelections]
  );

  /**
   * Toggling stores the entity key AND the label the user just read.
   *
   * The key is what keeps a selection alive across a rename or a merge; the
   * label is the last-resort way to describe it if its entity later leaves the
   * view entirely. Removal can touch several stored entries at once, so the whole
   * computation is delegated rather than approximated here.
   */
  const handleToggleAuthor = useCallback(
    (entityKey: string, label: string) => {
      onSetAuthors(
        toggleAuthorSelection(selectedAuthors, authorSelections, { key: entityKey, label })
      );
    },
    [selectedAuthors, authorSelections, onSetAuthors]
  );

  // Compute keyword stats
  const keywordStats = useMemo(() => {
    if (selectedKeywords.length === 0) return [];
    return selectedKeywords.map((kw) => {
      const kwLower = kw.toLowerCase();
      const count = papers.filter((p) => {
        const allKw = [...(p.keywords || []), ...(p.mesh_terms || [])];
        return allKw.some((k) => k.toLowerCase() === kwLower);
      }).length;
      return { name: kw, count };
    }).sort((a, b) => b.count - a.count);
  }, [selectedKeywords, papers]);

  // Counts come from the shared entity index, so a selected author is credited
  // with every spelling that groups into it — formatting-equivalent variants for
  // an unresolved mention, and every linked spelling across the merged cluster
  // for a resolved identity. Each paper is credited at most once, including a
  // paper that lists two spellings resolving to the same person.
  const authorStats = useMemo(() => {
    if (authorSelections.length === 0) return [];
    return authorSelections
      .map((selection) => ({ name: selection.label, count: selection.documentCount }))
      .sort((a, b) => b.count - a.count);
  }, [authorSelections]);

  const chartHeight = (dataLength: number) =>
    Math.max(150, Math.min(dataLength * 28 + 40, 400));

  /** Category-axis width. 320px leaves no room for bars on a 390px screen. */
  const categoryAxisWidth = compact ? 120 : 320;
  const narrowAxisWidth = compact ? 90 : 120;

  return (
    <div className="relative">
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 rounded-lg">
          <p className="text-sm text-muted-foreground animate-pulse">Loading analytics data…</p>
        </div>
      )}
      <div className="space-y-4">
        {/* Summary stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="flex items-center gap-2 rounded-md border p-2.5">
            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-lg font-semibold leading-none">{summaryStats.totalPapers}</p>
              <p className="text-xs text-muted-foreground">Papers</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-md border p-2.5">
            <Users className="h-4 w-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-lg font-semibold leading-none">{summaryStats.uniqueAuthors}</p>
              <p className="text-xs text-muted-foreground">Authors</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-md border p-2.5">
            <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-lg font-semibold leading-none">{summaryStats.yearRange}</p>
              <p className="text-xs text-muted-foreground">Year Range</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-md border p-2.5">
            <FlaskConical className="h-4 w-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-lg font-semibold leading-none">{summaryStats.studyTypesCount}</p>
              <p className="text-xs text-muted-foreground">Study Types</p>
            </div>
          </div>
        </div>

        {/* Study type distribution (automatic) */}
        {studyTypeStats.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Study Type Distribution</h4>
            <div style={{ height: chartHeight(studyTypeStats.length) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={studyTypeStats} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" allowDecimals={false} className="text-xs" />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={categoryAxisWidth}
                    tick={{ fontSize: 11 }}
                    className="text-xs"
                  />
                  <RechartsTooltip content={<PercentTooltip total={papers.length} />} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {studyTypeStats.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Year distribution (automatic) */}
        {yearStats.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Publication Year Distribution</h4>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={yearStats} margin={{ left: 10, right: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="name" className="text-xs" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} className="text-xs" />
                  <RechartsTooltip content={<PercentTooltip total={papers.length} />} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {yearStats.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Keyword / Author selectors */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <MultiSelectPopover
            label="Target Keywords"
            options={availableKeywordOptions}
            selected={selectedKeywords}
            selectedBadges={selectedKeywordBadges}
            onToggle={onToggleKeyword}
            onClear={onClearKeywords}
            fullWidth={compact}
          />
          <MultiSelectPopover
            label="Target Authors"
            options={availableAuthors}
            selected={selectedAuthorKeys}
            selectedBadges={selectedAuthorBadges}
            onToggle={handleToggleAuthor}
            onClear={onClearAuthors}
            fullWidth={compact}
            matchesSearch={authorSearchMatches}
          />
        </div>

        {/* The author story is only trustworthy when the identity read was.
            Analytics keeps working either way — the keyword, year and study-type
            charts never depended on identities at all — but a user whose saved
            people failed to load must not be quietly handed 001A grouping and
            left to conclude their decisions vanished. */}
        {(identityReadState === "failed" || identityReadState === "stale") && (
          <div className="space-y-1.5 rounded-md border border-dashed p-2.5">
            <p className="text-xs font-medium">
              {identityReadState === "failed"
                ? "Author identities could not be loaded."
                : "Showing the last author identities that loaded successfully."}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {identityReadState === "failed"
                ? "Your saved people and links are unchanged. Until they load, authors below are grouped by name spelling, so someone you resolved may appear more than once."
                : "A refresh failed, so the author grouping below may be out of date."}
            </p>
            {identities && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={identities.retry}
              >
                Try again
              </Button>
            )}
          </div>
        )}

        {/* Sited with Target Authors because this is the screen where a user
            notices one researcher showing up as three. */}
        {identities && (
          <div className="flex justify-end">
            <ManageAuthorIdentitiesButton
              papers={papers}
              identities={identities}
              compact={compact}
            />
          </div>
        )}

        {keywordStats.length === 0 && authorStats.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-2">
            Select target keywords or authors above to compare their distribution.
          </p>
        )}

        {keywordStats.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Keyword Distribution</h4>
            <div style={{ height: chartHeight(keywordStats.length) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={keywordStats} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" allowDecimals={false} className="text-xs" />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={narrowAxisWidth}
                    tick={{ fontSize: 11 }}
                    className="text-xs"
                  />
                  <RechartsTooltip content={<PercentTooltip total={papers.length} />} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {keywordStats.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {authorStats.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Author Distribution</h4>
            <div style={{ height: chartHeight(authorStats.length) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={authorStats} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" allowDecimals={false} className="text-xs" />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={narrowAxisWidth}
                    tick={{ fontSize: 11 }}
                    className="text-xs"
                  />
                  <RechartsTooltip content={<PercentTooltip total={papers.length} />} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {authorStats.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
