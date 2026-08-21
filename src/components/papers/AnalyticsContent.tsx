import { useState, useMemo, useCallback, useRef } from "react";
import { authorSearchMatches } from "@/lib/authorNames";
import {
  buildAuthorIdentityResolution,
  indexAuthorEntities,
  toAuthorEntityKey,
  type AuthorIdentityDataset,
} from "@/lib/authorIdentity";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTouchSafeInitialFocus } from "@/hooks/useCoarsePointer";
import { MobileMultiSelectSheet } from "./MobileMultiSelectSheet";
import { ManageAuthorIdentitiesButton } from "./AuthorIdentityManager";
import type { useAuthorIdentities } from "@/hooks/useAuthorIdentities";
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
function MultiSelectPopover({
  label,
  options,
  selected,
  onToggle,
  onClear,
  fullWidth,
  matchesSearch,
}: {
  label: string;
  options: SelectOption[];
  /** Selected option VALUES, not labels. */
  selected: string[];
  onToggle: (value: string) => void;
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

  /** Selected values resolved to the label currently representing them. */
  const labelByValue = useMemo(
    () => new Map(options.map((option) => [option.value, option.label])),
    [options]
  );

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

  const selectedBadges = selected.length > 0 && (
    <div className="flex flex-wrap gap-1">
      {selected.map((value) => {
        // A selection whose option is no longer on offer (its papers filtered
        // away, or the identity deleted) still needs a badge the user can
        // remove, so the value stands in for a label rather than vanishing.
        const text = labelByValue.get(value) ?? value;
        return (
          <Badge key={value} variant="secondary" className="text-xs pr-1">
            <span className="truncate max-w-[120px]">{text}</span>
            <button
              onClick={() => onToggle(value)}
              aria-label={`Remove ${text}`}
              className="ml-1 hover:text-destructive"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </Badge>
        );
      })}
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
          onToggle={onToggle}
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
            <ScrollArea className="max-h-[300px] overflow-y-auto">
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
                      onCheckedChange={() => onToggle(option.value)}
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
  identities,
  compact = false,
}: AnalyticsContentProps) {
  const {
    selectedKeywords,
    selectedAuthors,
    onToggleKeyword,
    onToggleAuthor,
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
    () => buildAuthorIdentityResolution(papers, identityDataset),
    [papers, identityDataset]
  );

  const authorEntities = useMemo(
    () => indexAuthorEntities(papers, identityResolution),
    [papers, identityResolution]
  );

  const authorsByKey = useMemo(
    () => new Map(authorEntities.map((entity) => [entity.key, entity])),
    [authorEntities]
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

  /**
   * Selections as stable entity keys, whatever form they were stored in.
   *
   * Selection state lives above the responsive breakpoint in `useAnalyticsTargets`
   * and is not persisted anywhere, so there is no stored history to migrate — but
   * a value CAN predate the identity dataset finishing its load, or a component
   * remount at 768px. `toAuthorEntityKey` folds any such legacy raw label into
   * the mention key it used to mean, so a selection made a moment ago keeps
   * meaning the same author afterwards.
   *
   * Deduplicated, because two legacy spellings of one canonical mention must not
   * become two selections of the same author.
   */
  const selectedAuthorKeys = useMemo(() => {
    const seen = new Set<string>();
    for (const selected of selectedAuthors) {
      const key = toAuthorEntityKey(selected);
      if (key) seen.add(key);
    }
    return [...seen];
  }, [selectedAuthors]);

  /**
   * Toggling stores the entity key, not the label.
   *
   * That is what keeps a selection alive across a rename, and across the option
   * coming to be represented by a different source spelling — the two ways a
   * label can change under a selection that was never meant to move.
   */
  const handleToggleAuthor = useCallback(
    (entityKey: string) => {
      const existing = selectedAuthors.find(
        (selected) => toAuthorEntityKey(selected) === entityKey
      );
      onToggleAuthor(existing ?? entityKey);
    },
    [selectedAuthors, onToggleAuthor]
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
    if (selectedAuthorKeys.length === 0) return [];
    return selectedAuthorKeys
      .map((key) => {
        const entity = authorsByKey.get(key);
        return { name: entity?.label ?? key, count: entity?.documentCount ?? 0 };
      })
      .sort((a, b) => b.count - a.count);
  }, [selectedAuthorKeys, authorsByKey]);

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
            onToggle={onToggleKeyword}
            onClear={onClearKeywords}
            fullWidth={compact}
          />
          <MultiSelectPopover
            label="Target Authors"
            options={availableAuthors}
            selected={selectedAuthorKeys}
            onToggle={handleToggleAuthor}
            onClear={onClearAuthors}
            fullWidth={compact}
            matchesSearch={authorSearchMatches}
          />
        </div>

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
