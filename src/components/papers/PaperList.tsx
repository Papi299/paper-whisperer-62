import { useRef, useCallback, useState, useEffect, useMemo, ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PaperWithTags } from "@/types/database";
import type { PoolStudyType } from "@/hooks/useStudyTypePool";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { ExternalLink, Pencil, Trash2, X, ChevronRight, ChevronDown, Loader2, Paperclip, FileText, Sparkles, StickyNote } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import { QuickAddDriveLink } from "./QuickAddDriveLink";
import { PaperListEmptyState } from "./PaperListEmptyState";
import { ColumnId } from "@/hooks/useColumnVisibility";
import { getDefaultColumnWidth } from "@/lib/columnWidths";
import { ResizableTableHeader, SortDirection } from "./ResizableTableHeader";
import { escapeRegExp } from "@/lib/textUtils";
import { toSafeExternalHref } from "@/lib/externalUrl";
import { useAbstract } from "@/hooks/useAbstract";
import type { MatchFlags } from "@/hooks/papers/types";

/**
 * Fixed UI order for the "Matched in:" badge row, paired with the boolean
 * field on `MatchFlags`. Mirrors the FTS weight order (A→D) plus keywords
 * appended at the end so they read after the existing fields.
 */
const MATCH_FIELD_ORDER: Array<{ key: keyof MatchFlags; label: string }> = [
  { key: "matched_title", label: "Title" },
  { key: "matched_abstract", label: "Abstract" },
  { key: "matched_authors", label: "Authors" },
  { key: "matched_journal", label: "Journal" },
  { key: "matched_notes", label: "Notes" },
  { key: "matched_keywords", label: "Keywords" },
];

/** Decode HTML entities (e.g. &#xf8; → ø) using a temporary textarea */
function decodeHtml(html: string): string {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

/** Renders abstract text with matched keywords highlighted. */
function HighlightedAbstract({ text, keywords }: { text: string; keywords: string[] }) {
  if (keywords.length === 0) return <>{text}</>;

  // Build a single regex that matches any keyword (case-insensitive, word-boundary-aware)
  const pattern = keywords
    .map(kw => escapeRegExp(kw))
    .sort((a, b) => b.length - a.length) // longest first to avoid partial matches
    .join("|");
  const regex = new RegExp(`(${pattern})`, "gi");

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    // Highlighted match
    parts.push(
      <mark key={match.index} className="bg-yellow-200/60 rounded-sm px-0.5">
        {match[0]}
      </mark>
    );
    lastIndex = regex.lastIndex;
  }
  // Remaining text after last match
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}

/**
 * Badge "exclude" affordance. It stays hidden until hover on pointer-sized
 * screens so the dense table keeps its compact look, but it is *always* visible
 * below `md` (touch devices have no hover at all) and always visible while it
 * holds keyboard focus — a focusable control that is invisible when focused is
 * the defect this replaces. The `md:` prefixes on the reveal rules are load-
 * bearing: an unprefixed `focus-visible:opacity-100` would be emitted before
 * the `md` media query and so lose to `md:opacity-0`.
 */
const EXCLUDE_BUTTON_CLASS =
  "ml-1 rounded-sm transition-opacity hover:text-destructive " +
  "opacity-100 md:opacity-0 md:group-hover/badge:opacity-100 md:focus:opacity-100 md:focus-visible:opacity-100 " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const SIGNED_URL_EXPIRY = 3600; // 1 hour

/** Popover body that lazily generates signed URLs for a paper's attachments. */
function AttachmentPopoverBody({ attachments }: { attachments: { id: string; file_name: string; file_path: string; file_type: string }[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const paths = attachments.map((a) => a.file_path);
    supabase.storage
      .from("attachments")
      .createSignedUrls(paths, SIGNED_URL_EXPIRY)
      .then(({ data }) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        data?.forEach((entry, i) => {
          if (entry.signedUrl) map[attachments[i].id] = entry.signedUrl;
        });
        setUrls(map);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [attachments]);

  return (
    <>
      <p className="text-xs font-medium text-muted-foreground mb-1.5">Attachments</p>
      <div className="max-h-[200px] overflow-y-auto overscroll-contain space-y-0.5">
        {attachments.map((att) => {
          // Signed URLs are generated by Supabase Storage, but they still go
          // through the same allowlist so every anchor in this file has one
          // source of truth for what is navigable.
          const url = toSafeExternalHref(urls[att.id]);
          const inner = (
            <span className="flex items-center gap-2">
              {att.file_type.startsWith("image/") && url ? (
                <img src={url} alt="" className="h-6 w-6 rounded object-cover flex-shrink-0" />
              ) : (
                <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{att.file_name}</span>
            </span>
          );
          return url ? (
            <a
              key={att.id}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              {inner}
            </a>
          ) : (
            <span key={att.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground">
              {inner}
              {loading && <Loader2 className="h-3 w-3 animate-spin ml-auto" />}
            </span>
          );
        })}
      </div>
    </>
  );
}

interface PaperListProps {
  papers: PaperWithTags[];
  /**
   * Authenticated user id, threaded into `useAbstract` for defense-in-depth
   * ownership scoping on the underlying Supabase query. See
   * `src/hooks/useAbstract.ts` JSDoc for the rationale (S2 client-side
   * hardening pattern from PRs #133 / #134).
   */
  userId: string | null | undefined;
  onEdit: (paper: PaperWithTags) => void;
  onDelete: (paperId: string) => void;
  findMatchingKeywords: (abstract: string | null) => string[];
  findMatchingStudyTypes?: undefined;
  poolStudyTypes?: undefined;
  /** Pool keywords for highlighting in expanded abstract view. */
  poolKeywordStrings?: string[];
  visibleColumns: ColumnId[];
  columnWidths: { [key: string]: number };
  onColumnResize: (columnId: ColumnId, width: number) => void;
  normalizeKeyword: (keyword: string) => string;
  excludedKeywords: Set<string>;
  excludedStudyTypes: Set<string>;
  onExcludeStudyType: (studyType: string) => Promise<boolean>;
  onExcludeKeyword: (keyword: string) => Promise<boolean>;
  onUpdateDriveUrl: (paperId: string, driveUrl: string) => Promise<void>;
  selectedPaperIds: Set<string>;
  onToggleSelect: (paperId: string) => void;
  onToggleSelectAll: () => void;
  /** Whether the full filtered ID set is loaded (disables select-all checkbox until ready). */
  isSelectAllReady?: boolean;
  sortKey?: ColumnId | null;
  sortDirection?: SortDirection | null;
  onSort?: (columnId: ColumnId) => void;
  onAnalyzePaper?: (paper: PaperWithTags) => Promise<void>;
  analyzingPaperId?: string | null;
  /** Whether more pages are available for lazy loading. */
  hasNextPage?: boolean;
  /** Whether the next page is currently being fetched. */
  isFetchingNextPage?: boolean;
  /** Callback to load the next page (triggered by scroll sentinel). */
  onLoadMore?: () => void;
  /**
   * Authoritative per-paper match attribution from the active search RPC,
   * keyed by paper_id. Null when no search query is active or results have
   * not yet resolved. When non-null, each row renders a "Matched in:" sub-
   * line in its title cell from the flags for its own id.
   */
  searchMatchFlags?: Map<string, MatchFlags> | null;
  /**
   * Papers the user owns, independent of the active filters. Required so the
   * empty branch can tell a genuinely empty library (first-run onboarding) from
   * a filter that matched nothing — `papers.length === 0` alone cannot.
   */
  totalCount: number;
  /**
   * Whether `totalCount` is a real answer from the unfiltered count query rather
   * than a fallback. Only an authoritative zero may select first-run onboarding.
   */
  isTotalCountAuthoritative: boolean;
  /** Whether any search/filter is currently narrowing the list. */
  hasActiveFilters: boolean;
  /** Opens the existing AddPaperDialog from the first-run empty state. */
  onAddPapers: () => void;
  /** Dashboard's `handleClearFilters`, offered from the no-results state. */
  onClearFilters: () => void;
}

const BASE_ROW_HEIGHT = 52;
const EXPANDED_ROW_HEIGHT = 220;

/**
 * What `PaperList` remembers, at the moment a deletion is *confirmed*, about
 * where the deleted paper sat — captured before it is dispatched, because
 * afterwards the answer is unrecoverable.
 */
interface PendingDeleteFocus {
  deletedId: string;
  /** The deleted paper's index in the pre-deletion `papers` array. */
  originalIndex: number;
  /** The paper immediately after it in the pre-deletion visible order. */
  nextId: string | null;
  /** The paper immediately before it in the pre-deletion visible order. */
  previousId: string | null;
}

/**
 * Which row should take focus once the deleted paper is gone, as an index into
 * the *current* `papers` array — or `null` when no row survives.
 *
 * Both captured neighbours are re-checked against live data rather than
 * trusted, because an unrelated refetch or a second mutation can remove them
 * between confirmation and removal. The clamped-slot rule is the deterministic
 * answer for that case: it keeps the user where they were looking, and it is
 * still derived from data order, not from the DOM.
 */
function resolvePostDeleteIndex(
  papers: PaperWithTags[],
  pending: PendingDeleteFocus,
): number | null {
  if (papers.length === 0) return null;
  if (pending.nextId) {
    const next = papers.findIndex((p) => p.id === pending.nextId);
    if (next !== -1) return next;
  }
  if (pending.previousId) {
    const previous = papers.findIndex((p) => p.id === pending.previousId);
    if (previous !== -1) return previous;
  }
  return Math.min(pending.originalIndex, papers.length - 1);
}

// mergeStudyTypesByWeight and findMatchingStudyTypes removed — flat multi-select now

export function PaperList({
  papers,
  userId,
  onEdit,
  onDelete,
  findMatchingKeywords,
  findMatchingStudyTypes,
  poolStudyTypes,
  poolKeywordStrings,
  visibleColumns,
  columnWidths,
  onColumnResize,
  normalizeKeyword,
  excludedKeywords,
  excludedStudyTypes,
  onExcludeStudyType,
  onExcludeKeyword,
  onUpdateDriveUrl,
  selectedPaperIds,
  onToggleSelect,
  onToggleSelectAll,
  isSelectAllReady = true,
  sortKey,
  sortDirection,
  onSort,
  onAnalyzePaper,
  analyzingPaperId,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  searchMatchFlags,
  totalCount,
  isTotalCountAuthoritative,
  hasActiveFilters,
  onAddPapers,
  onClearFilters,
}: PaperListProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // IntersectionObserver sentinel for lazy loading
  useEffect(() => {
    if (!onLoadMore || !hasNextPage || isFetchingNextPage) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) onLoadMore();
      },
      { root: scrollContainerRef.current, rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onLoadMore, hasNextPage, isFetchingNextPage]);

  const toggleRow = useCallback((paperId: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(paperId)) {
        next.delete(paperId);
      } else {
        next.add(paperId);
      }
      return next;
    });
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: papers.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: useCallback(
      (index: number) => {
        if (expandedRows.has(papers[index]?.id)) return EXPANDED_ROW_HEIGHT;
        return BASE_ROW_HEIGHT;
      },
      [expandedRows, papers]
    ),
    overscan: 10,
    measureElement: useCallback((el: HTMLElement) => {
      return el.getBoundingClientRect().height;
    }, []),
  });

  // ── Post-deletion focus continuity ────────────────────────────────────────
  //
  // Dismissing this confirmation is already solved centrally: the opener is
  // still mounted, so `useDialogFocusRestore` puts focus back on it. Confirming
  // is the case that layer cannot serve. `deletePaper` removes the paper from
  // the cache optimistically, which unmounts the row *and* the Delete button
  // that opened the confirmation, so there is no opener left to restore and
  // focus falls to `<body>`.
  //
  // The replacement target is positional and comes entirely from this
  // component's own `papers` array: the paper that followed the deleted one,
  // else the one that preceded it, else whatever now occupies the same slot,
  // else the empty-state heading. Papers are identified by id and reached
  // through refs registered by the rows themselves — the table is virtualized,
  // sorted and filtered, so no DOM search could name the right button.

  /** Every mounted row's Delete button, keyed by paper id. */
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  /** Armed only by the confirmation's Action; never by Cancel or Escape. */
  const pendingDeleteFocusRef = useRef<PendingDeleteFocus | null>(null);
  /** A resolved target that was virtualized out, awaiting its row's mount. */
  const pendingFocusIdRef = useRef<string | null>(null);
  /** The confirmation panel, so "focus is still inside it" is a ref test. */
  const confirmContentRef = useRef<HTMLDivElement>(null);
  /** The empty-state heading, focused only as a deliberate delete handoff. */
  const emptyStateHeadingRef = useRef<HTMLHeadingElement>(null);

  /**
   * Whether focus actually needs repairing right now.
   *
   * This is the guard against stealing focus the user chose. Deletion is
   * asynchronous, so between confirming and the row disappearing they may have
   * moved on deliberately; if something connected and unrelated holds focus,
   * the handoff stands down. Focus is only claimed when it has nowhere to be:
   *
   *  - `<body>` (or nothing) — the row that held focus was removed;
   *  - a detached element — same thing, observed a moment earlier;
   *  - still inside the confirmation — Radix keeps the panel mounted through
   *    its close animation and the optimistic removal normally lands inside
   *    that window, so focus is on the Action button and about to be dropped.
   *    Taking it there is the handoff, not a theft.
   */
  const focusNeedsRecovery = useCallback(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return true;
    if (!active.isConnected) return true;
    const confirmContent = confirmContentRef.current;
    return confirmContent !== null && confirmContent.contains(active);
  }, []);

  const registerDeleteButton = useCallback(
    (paperId: string, el: HTMLButtonElement | null) => {
      const refs = deleteButtonRefs.current;
      if (!el) {
        refs.delete(paperId);
        return;
      }
      refs.set(paperId, el);
      // The row was scrolled back into the render window for a pending handoff
      // and has just mounted. Re-check the guard: the scroll is not instant and
      // the user may have moved focus in the meantime.
      if (pendingFocusIdRef.current === paperId) {
        pendingFocusIdRef.current = null;
        if (focusNeedsRecovery()) el.focus();
      }
    },
    [focusNeedsRecovery],
  );

  const handleConfirmDelete = useCallback(() => {
    const paperId = deleteConfirmId;
    if (!paperId) return;
    const index = papers.findIndex((p) => p.id === paperId);
    pendingDeleteFocusRef.current =
      index === -1
        ? null
        : {
            deletedId: paperId,
            originalIndex: index,
            nextId: papers[index + 1]?.id ?? null,
            previousId: papers[index - 1]?.id ?? null,
          };
    onDelete(paperId);
    setDeleteConfirmId(null);
  }, [deleteConfirmId, papers, onDelete]);

  useEffect(() => {
    const pending = pendingDeleteFocusRef.current;
    if (!pending) return;
    // The optimistic removal is the signal. Any earlier `papers` update — a
    // background refetch, someone else's mutation — is not, so stay armed.
    if (papers.some((p) => p.id === pending.deletedId)) return;
    // Single-shot: the first render without the deleted paper either performs
    // the handoff or deliberately declines it. Nothing stays armed after that,
    // so no later list change can trigger a surprise focus move.
    pendingDeleteFocusRef.current = null;
    if (!focusNeedsRecovery()) return;

    const targetIndex = resolvePostDeleteIndex(papers, pending);
    if (targetIndex === null) {
      // Nothing survives: `PaperListEmptyState` is rendering by now, and its
      // heading tells the user what state they are in without consuming the
      // Clear filters / Add papers action that should be their next Tab stop.
      emptyStateHeadingRef.current?.focus();
      return;
    }

    const targetId = papers[targetIndex].id;
    const button = deleteButtonRefs.current.get(targetId);
    if (button?.isConnected) {
      button.focus();
      return;
    }
    // The target exists in the data but is outside the virtualizer's render
    // window. Bring it in through the virtualizer that already owns scrolling
    // and let its own ref registration complete the handoff on mount.
    pendingFocusIdRef.current = targetId;
    rowVirtualizer.scrollToIndex(targetIndex);
  }, [papers, rowVirtualizer, focusNeedsRecovery]);

  const generateGoogleScholarUrl = (title: string) => {
    return `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`;
  };

  const isVisible = (columnId: ColumnId) => visibleColumns?.includes(columnId) ?? true;
  const getWidth = (columnId: ColumnId) => columnWidths?.[columnId] || getDefaultColumnWidth(columnId);

  // Count visible columns for the abstract row colspan
  const visibleColumnCount = useMemo(() => {
    const cols: ColumnId[] = ["title", "authors", "year", "journal", "studyType", "statisticalMethods", "tags", "keywords", "links"];
    return cols.filter(c => isVisible(c)).length + 3; // +3 for checkbox col, expand chevron col and actions col
  }, [visibleColumns]);

  const allSelected = papers.length > 0 && papers.every(p => selectedPaperIds.has(p.id));
  const someSelected = papers.some(p => selectedPaperIds.has(p.id));

  const getCombinedKeywords = useCallback((paper: PaperWithTags, matchedPoolKeywords: string[]) => {
    const seenNormalized = new Set<string>();
    const result: { keyword: string; displayName: string; source: 'pool' | 'pubmed' | 'mesh' | 'substance' }[] = [];
    
    const isExcluded = (kw: string) => excludedKeywords?.has(kw.toLowerCase()) ?? false;
    
    matchedPoolKeywords.forEach(kw => {
      if (isExcluded(kw)) return;
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'pool' });
      }
    });
    
    (paper.keywords || []).forEach(kw => {
      if (isExcluded(kw)) return;
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'pubmed' });
      }
    });
    
    (paper.mesh_terms || []).forEach(kw => {
      if (isExcluded(kw)) return;
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'mesh' });
      }
    });
    
    (paper.substances || []).forEach(kw => {
      if (isExcluded(kw)) return;
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'substance' });
      }
    });
    
    result.sort((a, b) => a.displayName.localeCompare(b.displayName));
    
    return result;
  }, [excludedKeywords, normalizeKeyword]);

  // Early render path before the virtualized table: which empty state applies is
  // decided inside PaperListEmptyState from `totalCount` and whether that count
  // is authoritative.
  if (papers.length === 0) {
    return (
      <PaperListEmptyState
        totalCount={totalCount}
        isTotalCountAuthoritative={isTotalCountAuthoritative}
        hasActiveFilters={hasActiveFilters}
        onAddPapers={onAddPapers}
        onClearFilters={onClearFilters}
        headingRef={emptyStateHeadingRef}
      />
    );
  }

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div
      ref={scrollContainerRef}
      className="rounded-md border overflow-auto flex-1 min-h-0 h-full"
    >
      <Table style={{ tableLayout: "fixed" }}>
        <TableHeader className="sticky top-0 z-20 bg-background shadow-[0_1px_0_0_hsl(var(--border))]">
          <TableRow>
            <ResizableTableHeader columnId="checkbox" label="" width={getWidth("checkbox")} onResize={onColumnResize} className="px-1">
              <Checkbox
                checked={allSelected}
                disabled={!isSelectAllReady}
                ref={(el: HTMLButtonElement | null) => {
                  if (el) {
                    const input = el.querySelector("input");
                    if (input) input.indeterminate = someSelected && !allSelected;
                  }
                }}
                onCheckedChange={onToggleSelectAll}
                aria-label="Select all"
              />
            </ResizableTableHeader>
            <TableHead className="w-[36px] px-1"></TableHead>
            {isVisible("title") && (
              <ResizableTableHeader columnId="title" label="Title" width={getWidth("title")} onResize={onColumnResize} sortable onSort={onSort} sortDirection={sortKey === "title" ? sortDirection : null} />
            )}
            {isVisible("authors") && (
              <ResizableTableHeader columnId="authors" label="Authors" width={getWidth("authors")} onResize={onColumnResize} sortable onSort={onSort} sortDirection={sortKey === "authors" ? sortDirection : null} />
            )}
            {isVisible("year") && (
              <ResizableTableHeader columnId="year" label="Year" width={getWidth("year")} onResize={onColumnResize} sortable onSort={onSort} sortDirection={sortKey === "year" ? sortDirection : null} />
            )}
            {isVisible("journal") && (
              <ResizableTableHeader columnId="journal" label="Journal" width={getWidth("journal")} onResize={onColumnResize} sortable onSort={onSort} sortDirection={sortKey === "journal" ? sortDirection : null} />
            )}
            {isVisible("studyType") && (
              <ResizableTableHeader columnId="studyType" label="Study Type" width={getWidth("studyType")} onResize={onColumnResize} sortable onSort={onSort} sortDirection={sortKey === "studyType" ? sortDirection : null} />
            )}
            {isVisible("statisticalMethods") && (
              <ResizableTableHeader columnId="statisticalMethods" label="Statistical Methods" width={getWidth("statisticalMethods")} onResize={onColumnResize} />
            )}
            {isVisible("tags") && (
              <ResizableTableHeader columnId="tags" label="Tags" width={getWidth("tags")} onResize={onColumnResize} />
            )}
            {isVisible("keywords") && (
              <ResizableTableHeader columnId="keywords" label="Keywords" width={getWidth("keywords")} onResize={onColumnResize} />
            )}
            {isVisible("links") && (
              <ResizableTableHeader columnId="links" label="Links" width={getWidth("links")} onResize={onColumnResize} />
            )}
            {/* The column is `table-layout: fixed`, so this width is the hard
                content box the action buttons get, and it has to fit the
                worst case of four actions at whatever size that pointer gets.

                Fine pointer: four 32px buttons with the compact 2px gaps, plus
                the cell's own `p-4` (4×32 + 3×2 + 32 = 166), rounded up to 176
                for slack. The old 80px left only 48px of content box, which is
                why the buttons compressed to their 16px icon.

                Coarse pointer: four 40px targets 8px apart (4×40 + 3×8 + 32 =
                216), rounded up to 224.

                Either way the table's own horizontal scroll absorbs the extra
                width, which is already the responsive contract here — the
                document itself never scrolls sideways. */}
            <TableHead className="w-[176px] coarse:w-[224px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        {/* Spacer for items before visible window */}
        {virtualItems.length > 0 && virtualItems[0].start > 0 && (
          <tbody aria-hidden="true">
            <tr style={{ height: `${virtualItems[0].start}px` }}>
              <td />
            </tr>
          </tbody>
        )}
        {virtualItems.map((virtualRow) => {
          const paper = papers[virtualRow.index];
          const isExpanded = expandedRows.has(paper.id);
          // Pool keywords are already persisted into paper.keywords via enrichment.
          // Pass [] for matchedPoolKeywords in collapsed view (no runtime abstract scan).
          const combinedKeywords = getCombinedKeywords(paper, []);
          return (
            <PaperRow
              key={paper.id}
              paper={paper}
              userId={userId}
              virtualIndex={virtualRow.index}
              measureElement={rowVirtualizer.measureElement}
              isExpanded={isExpanded}
              onToggleExpand={toggleRow}
              poolKeywordStrings={poolKeywordStrings ?? []}
              combinedKeywords={combinedKeywords}
              isVisible={isVisible}
              getWidth={getWidth}
              visibleColumnCount={visibleColumnCount}
              onEdit={onEdit}
              onRequestDelete={setDeleteConfirmId}
              registerDeleteButton={registerDeleteButton}
              excludedStudyTypes={excludedStudyTypes}
              onExcludeStudyType={onExcludeStudyType}
              onExcludeKeyword={onExcludeKeyword}
              onUpdateDriveUrl={onUpdateDriveUrl}
              generateGoogleScholarUrl={generateGoogleScholarUrl}
              isSelected={selectedPaperIds.has(paper.id)}
              onToggleSelect={onToggleSelect}
              onAnalyzePaper={onAnalyzePaper}
              isAnalyzing={analyzingPaperId === paper.id}
              searchMatchFlags={searchMatchFlags}
            />
          );
        })}
        {/* Spacer for items after visible window */}
        {virtualItems.length > 0 && (
          <tbody aria-hidden="true">
            <tr
              style={{
                height: `${rowVirtualizer.getTotalSize() - (virtualItems[virtualItems.length - 1].end)}px`,
              }}
            >
              <td />
            </tr>
          </tbody>
        )}
      </Table>
      {/* Sentinel for infinite scroll — triggers onLoadMore when visible */}
      {hasNextPage && <div ref={sentinelRef} className="h-1" />}
      {isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {/* Cancel and Escape both close through `onOpenChange`, which only clears
          the id — they never arm a post-deletion handoff, so their restoration
          behaviour is exactly what it was. */}
      <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => !open && setDeleteConfirmId(null)}>
        <AlertDialogContent ref={confirmContentRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Paper</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this paper? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Extracted row component to keep PaperList lean
interface PaperRowProps {
  paper: PaperWithTags;
  /**
   * Authenticated user id, threaded into `useAbstract` for defense-in-
   * depth ownership scoping on the underlying Supabase query. See
   * `src/hooks/useAbstract.ts` JSDoc.
   */
  userId: string | null | undefined;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  /** Pool keyword strings for highlighting in expanded abstract. */
  poolKeywordStrings: string[];
  combinedKeywords: { keyword: string; displayName: string; source: 'pool' | 'pubmed' | 'mesh' | 'substance' }[];
  isVisible: (col: ColumnId) => boolean;
  getWidth: (col: ColumnId) => number;
  visibleColumnCount: number;
  onEdit: (paper: PaperWithTags) => void;
  onRequestDelete: (paperId: string) => void;
  /**
   * Publishes this row's Delete button to `PaperList` under the paper's id, so
   * a post-deletion focus handoff can reach it without searching the DOM.
   * Called with `null` when the row unmounts (scrolled out, or deleted).
   */
  registerDeleteButton: (paperId: string, el: HTMLButtonElement | null) => void;
  excludedStudyTypes: Set<string>;
  onExcludeStudyType: (studyType: string) => Promise<boolean>;
  onExcludeKeyword: (keyword: string) => Promise<boolean>;
  onUpdateDriveUrl: (paperId: string, driveUrl: string) => Promise<void>;
  generateGoogleScholarUrl: (title: string) => string;
  virtualIndex: number;
  measureElement: (el: HTMLElement | null) => void;
  isSelected: boolean;
  onToggleSelect: (paperId: string) => void;
  onAnalyzePaper?: (paper: PaperWithTags) => Promise<void>;
  isAnalyzing?: boolean;
  /**
   * Authoritative per-paper match attribution from the active search RPC,
   * keyed by paper_id. When non-null and this row's id is present, the title
   * cell renders a "Matched in:" sub-line listing the matching fields.
   */
  searchMatchFlags?: Map<string, MatchFlags> | null;
}

function PaperRow({
  paper,
  userId,
  isExpanded,
  onToggleExpand,
  poolKeywordStrings,
  combinedKeywords,
  isVisible,
  getWidth,
  visibleColumnCount,
  onEdit,
  onRequestDelete,
  registerDeleteButton,
  excludedStudyTypes,
  onExcludeStudyType,
  onExcludeKeyword,
  onUpdateDriveUrl,
  generateGoogleScholarUrl,
  virtualIndex,
  measureElement,
  isSelected,
  onToggleSelect,
  onAnalyzePaper,
  isAnalyzing,
  searchMatchFlags,
}: PaperRowProps) {
  // On-demand abstract: only fetch when the row is expanded
  const { data: fetchedAbstract, isLoading: abstractLoading } = useAbstract(isExpanded ? paper.id : null, userId);

  // Stored link fields are free text (typed in the add/edit dialogs, or read
  // verbatim out of an imported RIS/CSV file), so they only become anchors
  // once they pass the http(s) allowlist. The Scholar URL is generated here
  // and always valid, but shares the same gate so there is no unchecked path.
  const pubmedHref = toSafeExternalHref(paper.pubmed_url);
  const journalHref = toSafeExternalHref(paper.journal_url);
  const scholarHref = toSafeExternalHref(generateGoogleScholarUrl(paper.title));

  /** Stable id for the expanded-abstract region, wired to `aria-controls`. */
  const abstractRegionId = `paper-abstract-${paper.id}`;

  // Memoized on the paper id so the callback identity survives re-renders and
  // the registry is not churned (unregister/re-register) on every commit.
  const setDeleteButtonRef = useCallback(
    (el: HTMLButtonElement | null) => registerDeleteButton(paper.id, el),
    [registerDeleteButton, paper.id],
  );

  return (
    <tbody ref={measureElement} data-index={virtualIndex}>
      <TableRow className={isSelected ? "bg-orange-100/50" : "group hover:bg-orange-600 hover:text-white transition-colors cursor-default"}>
        {/* Selection checkbox */}
        <TableCell className="px-1" style={{ width: getWidth("checkbox"), minWidth: getWidth("checkbox"), maxWidth: getWidth("checkbox") }}>
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelect(paper.id)}
            aria-label={`Select ${paper.title}`}
            className="group-hover:border-white"
          />
        </TableCell>
        {/* Expand/Collapse chevron */}
        <TableCell className="w-[36px] px-1">
          {paper.has_abstract ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 group-hover:text-white group-hover:hover:bg-white/20"
              onClick={() => onToggleExpand(paper.id)}
              aria-expanded={isExpanded}
              // Only referenced while the region exists, so the IDREF never dangles.
              aria-controls={isExpanded ? abstractRegionId : undefined}
              aria-label={`${isExpanded ? "Collapse" : "Expand"} abstract for ${paper.title}`}
              title={isExpanded ? "Collapse abstract" : "Expand abstract"}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
          ) : (
            <div className="h-7 w-7" />
          )}
        </TableCell>
        {isVisible("title") && (
          <TableCell style={{ width: getWidth("title"), minWidth: getWidth("title"), maxWidth: getWidth("title") }}>
            <div className="space-y-1">
              <p className="font-medium whitespace-normal break-words leading-snug">{paper.title}</p>
              {paper.tldr && (
                <p className="text-xs text-muted-foreground group-hover:text-orange-50 italic whitespace-normal break-words leading-snug">{paper.tldr}</p>
              )}
              {paper.projects.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {paper.projects.map((proj) => (
                    <Badge key={proj.id} variant="outline" className="text-xs group-hover:!border-white group-hover:!text-white">
                      <div
                        className="w-2 h-2 rounded-full mr-1 bg-[var(--proj-color)] group-hover:bg-white"
                        style={{ "--proj-color": proj.color } as React.CSSProperties}
                      />
                      {proj.name}
                    </Badge>
                  ))}
                </div>
              )}
              {searchMatchFlags && (() => {
                const flags = searchMatchFlags.get(paper.id);
                if (!flags) return null;
                const matched = MATCH_FIELD_ORDER.filter((f) => flags[f.key]);
                if (matched.length === 0) return null;
                return (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-xs text-muted-foreground group-hover:text-orange-50">Matched in:</span>
                    {matched.map((f) => (
                      <Badge
                        key={f.key}
                        variant="outline"
                        className="text-xs font-normal group-hover:!border-white group-hover:!text-white"
                      >
                        {f.label}
                      </Badge>
                    ))}
                  </div>
                );
              })()}
            </div>
          </TableCell>
        )}
        {isVisible("authors") && (
          <TableCell
            className="text-sm text-muted-foreground group-hover:text-orange-50"
            style={{ width: getWidth("authors"), minWidth: getWidth("authors"), maxWidth: getWidth("authors") }}
          >
            <div className="truncate">
              {paper.authors.slice(0, 3).map(a => decodeHtml(a)).join(", ")}
              {paper.authors.length > 3 && " et al."}
            </div>
          </TableCell>
        )}
        {isVisible("year") && (
          <TableCell style={{ width: getWidth("year"), minWidth: getWidth("year"), maxWidth: getWidth("year") }}>
            {paper.year || "-"}
          </TableCell>
        )}
        {isVisible("journal") && (
          <TableCell
            className="text-sm text-muted-foreground group-hover:text-orange-50"
            style={{ width: getWidth("journal"), minWidth: getWidth("journal"), maxWidth: getWidth("journal") }}
          >
            <div className="truncate">{paper.journal || "-"}</div>
          </TableCell>
        )}
        {isVisible("studyType") && (
          <TableCell
            className="text-sm"
            style={{ width: getWidth("studyType"), minWidth: getWidth("studyType"), maxWidth: getWidth("studyType") }}
          >
            {(() => {
              const studyTypeValue = (paper.study_type || "").trim();
              if (!studyTypeValue) return <span>-</span>;
              
              const excludedSet = excludedStudyTypes ?? new Set<string>();
              if (Array.from(excludedSet).some(ex => studyTypeValue.toLowerCase() === ex)) return <span>-</span>;
              
              return (
                <div className="flex items-center gap-1">
                  <Badge variant="outline" className="text-xs group/badge whitespace-normal break-words text-center leading-tight group-hover:!border-white group-hover:!text-white">
                    <span>{studyTypeValue}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onExcludeStudyType(studyTypeValue);
                      }}
                      className={EXCLUDE_BUTTON_CLASS}
                      aria-label={`Exclude study type ${studyTypeValue}`}
                      title={`Exclude "${studyTypeValue}"`}
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </Badge>
                </div>
              );
            })()}
          </TableCell>
        )}
        {isVisible("statisticalMethods") && (
          <TableCell
            className="text-sm text-muted-foreground group-hover:text-orange-50"
            style={{ width: getWidth("statisticalMethods"), minWidth: getWidth("statisticalMethods"), maxWidth: getWidth("statisticalMethods") }}
          >
            {(() => {
              const raw = (paper.statistical_methods ?? "").trim();
              if (!raw || raw.toLowerCase() === "not specified") return <span>-</span>;
              const methods = raw.split(",").map(m => m.trim()).filter(Boolean);
              return (
                <div className="flex flex-wrap gap-1">
                  {methods.map((method, i) => (
                    <Badge key={i} variant="secondary" className="text-xs whitespace-nowrap group-hover:!bg-transparent group-hover:!text-white group-hover:!border-white">
                      {method}
                    </Badge>
                  ))}
                </div>
              );
            })()}
          </TableCell>
        )}
        {isVisible("tags") && (
          <TableCell style={{ width: getWidth("tags"), minWidth: getWidth("tags"), maxWidth: getWidth("tags") }}>
            <div className="flex flex-wrap gap-1">
              {paper.tags.slice(0, 3).map((tag) => (
                <Badge
                  key={tag.id}
                  variant="secondary"
                  className="text-xs group-hover:!bg-transparent group-hover:!text-white group-hover:!border-white"
                  style={{ borderColor: tag.color }}
                >
                  {tag.name}
                </Badge>
              ))}
              {paper.tags.length > 3 && (
                <Badge variant="secondary" className="text-xs group-hover:!bg-transparent group-hover:!text-white group-hover:!border-white">
                  +{paper.tags.length - 3}
                </Badge>
              )}
            </div>
          </TableCell>
        )}
        {isVisible("keywords") && (
          <TableCell style={{ width: getWidth("keywords"), minWidth: getWidth("keywords"), maxWidth: getWidth("keywords") }}>
            <div className="flex flex-wrap gap-1">
              {combinedKeywords.map(({ keyword, displayName, source }) => (
                <Badge
                  key={`${source}-${keyword}`}
                  variant="outline"
                  className="text-xs group/badge group-hover:!border-white group-hover:!text-white"
                >
                  {displayName}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onExcludeKeyword(keyword);
                    }}
                    className={EXCLUDE_BUTTON_CLASS}
                    aria-label={`Exclude keyword ${displayName}`}
                    title={`Exclude "${keyword}"`}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </Badge>
              ))}
            </div>
          </TableCell>
        )}
        {isVisible("links") && (
          <TableCell style={{ width: getWidth("links"), minWidth: getWidth("links"), maxWidth: getWidth("links") }}>
            <div className="flex gap-1">
              <QuickAddDriveLink
                paperId={paper.id}
                driveUrl={paper.drive_url}
                onSave={onUpdateDriveUrl}
                paperTitle={paper.title}
              />
              {pubmedHref && (
                <Button variant="ghost" size="icon" className="h-8 w-8 group-hover:text-white group-hover:hover:bg-white/20" asChild>
                  {/* `aria-label` wins over the visible "J"/"GS" glyphs below,
                      which on their own were the whole accessible name. */}
                  <a
                    href={pubmedHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open PubMed for ${paper.title}`}
                    title="PubMed"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  </a>
                </Button>
              )}
              {journalHref && (
                <Button variant="ghost" size="icon" className="h-8 w-8 group-hover:text-white group-hover:hover:bg-white/20" asChild>
                  <a
                    href={journalHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open journal link for ${paper.title}`}
                    title="Journal"
                  >
                    <span className="text-xs font-bold" aria-hidden="true">J</span>
                  </a>
                </Button>
              )}
              {scholarHref && (
                <Button variant="ghost" size="icon" className="h-8 w-8 group-hover:text-white group-hover:hover:bg-white/20" asChild>
                  <a
                    href={scholarHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Search ${paper.title} on Google Scholar`}
                    title="Search on Google Scholar"
                  >
                    <span className="text-xs font-bold" aria-hidden="true">GS</span>
                  </a>
                </Button>
              )}
              {(paper.paper_attachments?.length ?? 0) > 0 && (
                <Popover modal={true}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 relative group-hover:text-white group-hover:hover:bg-white/20"
                      aria-label={`View ${paper.paper_attachments!.length} attachment${paper.paper_attachments!.length === 1 ? "" : "s"} for ${paper.title}`}
                      title="Attachments"
                    >
                      <Paperclip className="h-4 w-4" aria-hidden="true" />
                      <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                        {paper.paper_attachments!.length}
                      </span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-2" side="bottom" align="start" style={{ pointerEvents: 'auto' }}>
                    <AttachmentPopoverBody attachments={paper.paper_attachments!} />
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </TableCell>
        )}
        <TableCell>
          {/* `shrink-0` is the actual defect fix: these buttons declare a size
              but sit in a fixed-width column, so flex was free to shrink them
              down to their 16px icon. It is unconditional because the pressure
              is geometric, not a property of the pointer — a mouse user got the
              same 16px-wide control the finger did. Paired with the column
              widths above, each pointer now keeps its declared box: 32px under
              a mouse, 2px apart, and 40px under a finger, 8px apart. The icons
              themselves stay `h-4 w-4` at every size. */}
          <div className="flex items-center gap-0.5 coarse:gap-2">
            {onAnalyzePaper && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 coarse:h-10 coarse:w-10 group-hover:text-white group-hover:hover:bg-white/20"
                onClick={() => onAnalyzePaper(paper)}
                disabled={isAnalyzing || !paper.has_abstract}
                aria-label={
                  paper.has_abstract
                    ? `Analyze ${paper.title} with AI`
                    : `No abstract to analyze for ${paper.title}`
                }
                aria-busy={isAnalyzing || undefined}
                title={paper.has_abstract ? "AI Analyze" : "No abstract to analyze"}
              >
                {isAnalyzing ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            )}
            {paper.notes?.trim() && (
              <Popover modal={true}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 coarse:h-10 coarse:w-10 group-hover:text-white group-hover:hover:bg-white/20"
                    aria-label={`View notes for ${paper.title}`}
                    title="View notes"
                  >
                    <StickyNote className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-3" side="bottom" align="start" style={{ pointerEvents: 'auto' }}>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">Notes</p>
                  <div className="max-h-48 overflow-y-auto">
                    <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
                      {paper.notes}
                    </p>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 coarse:h-10 coarse:w-10 group-hover:text-white group-hover:hover:bg-white/20"
              onClick={() => onEdit(paper)}
              aria-label={`Edit ${paper.title}`}
              title="Edit"
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              ref={setDeleteButtonRef}
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 coarse:h-10 coarse:w-10 text-destructive group-hover:text-red-200 hover:!text-red-100 group-hover:hover:bg-white/20 transition-colors"
              onClick={() => onRequestDelete(paper.id)}
              aria-label={`Delete ${paper.title}`}
              title="Delete"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {/* Expanded abstract row — abstract loaded on demand */}
      {isExpanded && (
        <tr>
          <td colSpan={visibleColumnCount}>
            <div id={abstractRegionId} className="px-6 py-4 bg-muted/50 border-t border-border">
              <p className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">Abstract</p>
              {abstractLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading abstract…
                </div>
              ) : fetchedAbstract ? (
                <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
                  <HighlightedAbstract text={fetchedAbstract} keywords={poolKeywordStrings} />
                </p>
              ) : (
                <p className="text-sm text-muted-foreground italic">No abstract available.</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </tbody>
  );
}
