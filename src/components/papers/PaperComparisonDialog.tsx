import {
  Component,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePaperComparison } from "@/hooks/usePaperComparison";
import { COMPARISON_SORTS, DEFAULT_COMPARISON_SORT, sortComparisonRows, type ComparisonSort } from "@/lib/paperComparison/sort";
import type { ComparisonRequest, ComparisonResult } from "@/lib/paperComparison/types";
import { ComparisonCards, ComparisonMatrix } from "./comparison/ComparisonLayouts";
import {
  COMPARISON_GROUPS,
  DEFAULT_COMPARISON_GROUP,
  MISSING_VALUE_MEANING,
  SORT_LABELS,
  type ComparisonGroupId,
} from "./comparison/comparisonFields";

/**
 * Where focus goes when the comparison closes: the toolbar's Compare action,
 * else — if the selection emptied while the comparison was open — the table's
 * Select all checkbox, the same fallback the toolbar itself uses. Compare is
 * the only way to open the dialog, so this is also right when a tap did not
 * focus Compare (WebKit), where the shared dialog would restore to <body>.
 */
const CLOSE_FOCUS_TARGETS = ["[data-comparison-trigger]", '[role="checkbox"][aria-label="Select all"]'];

const ERROR_COPY = {
  transport: "The comparison could not be loaded. Try again, or close it and try again later.",
  integrity:
    "This comparison could not be shown because the data received did not pass a consistency check. Nothing from it is displayed.",
} as const;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "1 of the 3 selected papers is available." */
function availability(result: { availableCount: number; selectedCount: number }): string {
  return `${result.availableCount} of the ${result.selectedCount} selected papers ${result.availableCount === 1 ? "is" : "are"} available.`;
}

/** What the status region says once a comparison has settled. */
function readyAnnouncement(result: ComparisonResult): string {
  if (result.kind === "insufficient") return `This comparison needs at least 2 available papers. ${availability(result)}`;
  const comparing = `Comparing ${plural(result.rows.length, "paper", "papers")}.`;
  return result.unavailableCount > 0
    ? `${comparing} ${result.unavailableCount} of the ${plural(result.selectedCount, "selected paper", "selected papers")} could not be included.`
    : comparing;
}

/**
 * A render failure inside the comparison shows the same generic message as a
 * failed integrity check and nothing else — never the error's own text, which
 * could quote stored content.
 */
class ComparisonErrorBoundary extends Component<
  { children: ReactNode; onClose: () => void; onAnnounce: (message: string) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    // The failed body can no longer update the status region, which would
    // otherwise keep saying "Loading…" beside the alert.
    this.props.onAnnounce("");
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="mx-4 mb-4 space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm sm:mx-6">
        <p role="alert" className="font-medium">
          {ERROR_COPY.integrity}
        </p>
        <Button type="button" variant="outline" onClick={this.props.onClose}>
          Return to library
        </Button>
      </div>
    );
  }
}

interface ComparisonBodyProps {
  request: ComparisonRequest;
  currentUserId: string | null | undefined;
  onClose: () => void;
  onAnnounce: (message: string) => void;
  titleRef: RefObject<HTMLHeadingElement>;
}

/**
 * One comparison session. Mounted per session (keyed by its id), so sort,
 * field group and expanded values always start fresh, and unmounted when the
 * dialog finishes closing, which releases the read (its cache time is 0).
 * Nothing from the read is copied into state.
 */
function ComparisonBody({ request, currentUserId, onClose, onAnnounce, titleRef }: ComparisonBodyProps) {
  const { status, result, errorKind, retry } = usePaperComparison(request, currentUserId);
  const isMobile = useIsMobile();
  const [sort, setSort] = useState<ComparisonSort>(DEFAULT_COMPARISON_SORT);
  const [groupId, setGroupId] = useState<ComparisonGroupId>(DEFAULT_COMPARISON_GROUP);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const idBase = useId();
  const tabListRef = useRef<HTMLDivElement>(null);

  const rows = result?.kind === "comparable" ? result.rows : null;
  // Local and deterministic: re-sorting never reads anything again.
  const sortedRows = useMemo(() => (rows ? sortComparisonRows(rows, sort) : null), [rows, sort]);
  // DOM ids come from each row's position in the session's own result, which
  // never changes while it is open — never from the paper id itself.
  const rowIndex = useMemo(() => new Map((rows ?? []).map((row, index) => [row.paperId, index])), [rows]);
  const paperDomId = useCallback((paperId: string) => `${idBase}-p${rowIndex.get(paperId)}`, [idBase, rowIndex]);
  const isExpanded = useCallback((paperId: string, fieldId: string) => expanded.has(`${paperId}:${fieldId}`), [expanded]);
  const onToggle = useCallback((paperId: string, fieldId: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      const key = `${paperId}:${fieldId}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const requestedCount = request.selectedIds.length;
  const group = COMPARISON_GROUPS.find((candidate) => candidate.id === groupId) ?? COMPARISON_GROUPS[0];

  let announcement = "";
  if (status === "loading") announcement = `Loading ${plural(requestedCount, "paper", "papers")}…`;
  else if (status === "ready" && result) announcement = readyAnnouncement(result);
  useEffect(() => {
    onAnnounce(announcement);
  }, [announcement, onAnnounce]);

  // Crossing 768px swaps the matrix for the cards (or back). If that removed
  // the focused control, focus goes to the active field-group tab rather than
  // falling to the dialog itself.
  const previousIsMobile = useRef(isMobile);
  useLayoutEffect(() => {
    if (previousIsMobile.current === isMobile) return;
    previousIsMobile.current = isMobile;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && active.getAttribute("role") !== "dialog") return;
    tabListRef.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')?.focus();
  }, [isMobile]);

  const handleRetry = () => {
    // The error block, and the focused Try again button in it, leave as soon
    // as the read restarts; the title is a stable place to wait.
    titleRef.current?.focus();
    retry();
  };

  return (
    <>
      {status === "loading" && (
        <div className="space-y-2 px-4 pb-4 sm:px-6 md:min-h-0 md:overflow-hidden" aria-hidden="true">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading {plural(requestedCount, "paper", "papers")}…
          </p>
          {Array.from({ length: requestedCount }, (_, index) => (
            <div key={index} className="h-10 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      )}

      {status === "error" && errorKind && (
        <div className="mx-4 mb-4 space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm sm:mx-6">
          <p role="alert" className="flex items-start gap-2 font-medium">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            {ERROR_COPY[errorKind]}
          </p>
          <div className="flex flex-wrap gap-2">
            {/* The same response would fail the same check again, so an
                integrity failure offers no retry; reopening Compare is a new
                session and a new read. */}
            {errorKind === "transport" && (
              <Button type="button" onClick={handleRetry}>
                Try again
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              Return to library
            </Button>
          </div>
        </div>
      )}

      {status === "ready" && result?.kind === "insufficient" && (
        <div className="mx-4 mb-4 space-y-3 rounded-md border p-4 text-sm sm:mx-6">
          <p className="font-medium">A comparison needs at least 2 available papers.</p>
          <p className="text-muted-foreground">
            {availability(result)} The others may have been deleted or are no longer in your library.
          </p>
          <Button type="button" onClick={onClose}>
            Return to library
          </Button>
        </div>
      )}

      {status === "ready" && result?.kind === "comparable" && sortedRows && (
        <Tabs
          value={group.id}
          onValueChange={(value) => setGroupId(value as ComparisonGroupId)}
          className="md:flex md:min-h-0 md:flex-1 md:flex-col"
        >
          <div className="flex shrink-0 flex-col gap-3 px-4 pb-3 sm:px-6 md:flex-row md:flex-wrap md:items-end md:justify-between">
            {/*
              Four groups do not fit one phone row without clipping a label, so
              below 480px they form a 2×2 grid (the Add Papers precedent), with
              full labels and 40px targets. From `md` up they share one row,
              at desktop density only for a fine pointer.
            */}
            <TabsList
              ref={tabListRef}
              aria-label="Field groups"
              className="grid h-auto w-full grid-cols-2 gap-1 min-[480px]:grid-cols-4 md:inline-grid md:w-auto md:[@media(pointer:fine)]:h-10"
            >
              {COMPARISON_GROUPS.map((candidate) => (
                <TabsTrigger
                  key={candidate.id}
                  value={candidate.id}
                  className="min-h-10 whitespace-normal text-center leading-tight md:whitespace-nowrap md:[@media(pointer:fine)]:min-h-0"
                >
                  {candidate.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="flex items-center gap-2">
              <label htmlFor={`${idBase}-sort`} className="shrink-0 text-sm font-medium">
                Sort papers
              </label>
              {/* Native, so it opens no second modal layer inside the dialog
                  and uses the platform picker on touch. */}
              <select
                id={`${idBase}-sort`}
                value={sort}
                onChange={(event) => {
                  const next = COMPARISON_SORTS.find((option) => option === event.target.value);
                  if (next) setSort(next);
                }}
                className="h-10 min-w-0 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {COMPARISON_SORTS.map((option) => (
                  <option key={option} value={option}>
                    {SORT_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {result.unavailableCount > 0 && (
            <p className="mx-4 mb-3 shrink-0 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm sm:mx-6">
              {result.unavailableCount} of the {plural(result.selectedCount, "selected paper", "selected papers")} could not
              be included: {result.unavailableCount === 1 ? "it may have" : "they may have"} been deleted or{" "}
              {result.unavailableCount === 1 ? "is" : "are"} no longer in your library. This comparison shows{" "}
              {plural(sortedRows.length, "paper", "papers")}.
            </p>
          )}

          <p className="mx-4 mb-3 shrink-0 text-xs text-muted-foreground sm:mx-6">{MISSING_VALUE_MEANING}</p>

          {/*
            From `md` up the tab panel is the matrix's one scroll container: a
            single tab stop, named by its tab, scrollable from the keyboard,
            with the header row and paper column sticky inside it. The scroll
            padding keeps a focused cell clear of both: the paper column's
            fixed width plus room for a focus ring on the left, and the header
            row's measured height at the top (set by the matrix). Below `md`
            the whole dialog body scrolls instead.

            `relative` makes the panel the containing block of the visually
            hidden texts inside it (they are absolutely positioned). Otherwise
            their containing block is the fixed dialog, they escape the
            panel's clipping, and the dialog gains sideways overflow that
            focusing a link in a far column would scroll.
          */}
          <TabsContent
            value={group.id}
            className="relative mt-0 px-4 pb-4 focus-visible:ring-inset focus-visible:ring-offset-0 sm:px-6 md:min-h-0 md:flex-1 md:overflow-auto md:border-t md:p-0 md:scroll-pl-[15.5rem] lg:scroll-pl-[18.5rem]"
          >
            {isMobile ? (
              <ComparisonCards
                group={group}
                rows={sortedRows}
                sort={sort}
                paperDomId={paperDomId}
                isExpanded={isExpanded}
                onToggle={onToggle}
              />
            ) : (
              <ComparisonMatrix
                group={group}
                rows={sortedRows}
                sort={sort}
                paperDomId={paperDomId}
                isExpanded={isExpanded}
                onToggle={onToggle}
              />
            )}
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}

export interface PaperComparisonDialogProps {
  /** The open comparison, or `null` when closed. */
  request: ComparisonRequest | null;
  currentUserId: string | null | undefined;
  onClose: () => void;
}

/**
 * The read-only multi-paper comparison (EVIDENCE-MATRIX-001B).
 *
 * Mounted by the Dashboard beside its other dialogs — never inside the bulk
 * toolbar, which unmounts when the selection empties — and driven entirely by
 * `request`: open while there is one, closed when it is `null`. The data comes
 * from `usePaperComparison` alone; this component reads nothing itself and
 * writes nothing anywhere. It shows stored values under their provenance and
 * never generates, infers or verifies a finding.
 */
export function PaperComparisonDialog({ request, currentUserId, onClose }: PaperComparisonDialogProps) {
  const open = request !== null;
  const [announcement, setAnnouncement] = useState("");
  // While Radix plays the closing animation the body keeps the session it
  // showed, rather than flashing an empty state. The read itself still gates
  // on the signed-in user, so an owner change empties it at once.
  const [shown, setShown] = useState<ComparisonRequest | null>(request);
  if (request !== null && request !== shown) {
    setShown(request);
    setAnnouncement("");
  }
  // Closing — including an owner change — silences the status region in the
  // same render, so nothing about the previous session is left to be read.
  if (request === null && announcement !== "") setAnnouncement("");
  const session = request ?? shown;
  const titleRef = useRef<HTMLHeadingElement>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden p-0 sm:rounded-none md:h-[calc(100dvh-2rem)] md:w-[calc(100vw-2rem)] md:max-w-[96rem] md:rounded-lg [&>button:last-child]:right-2 [&>button:last-child]:top-2 [&>button:last-child]:flex [&>button:last-child]:h-10 [&>button:last-child]:w-10 [&>button:last-child]:items-center [&>button:last-child]:justify-center"
        onOpenAutoFocus={(event) => {
          // Start at the title: a screen reader says where it is first, and a
          // stray Enter cannot activate anything.
          event.preventDefault();
          titleRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          for (const selector of CLOSE_FOCUS_TARGETS) {
            const target = document.querySelector<HTMLElement>(selector);
            if (!target) continue;
            target.focus();
            if (document.activeElement === target) {
              event.preventDefault();
              return;
            }
          }
        }}
      >
        <div className="shrink-0 border-b py-3 pl-4 pr-14 sm:pl-6">
          <DialogTitle ref={titleRef} tabIndex={-1} className="leading-7 focus:outline-none">
            Compare papers
          </DialogTitle>
        </div>
        <p role="status" className="sr-only">
          {announcement}
        </p>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
          <DialogDescription className="shrink-0 px-4 py-3 sm:px-6">
            A read-only view of what your library had stored for these papers when you opened this comparison. It
            creates nothing new and checks nothing against the papers; some stored values were written by AI analysis,
            as their labels say.
          </DialogDescription>
          {session && (
            <ComparisonErrorBoundary key={session.sessionId} onClose={onClose} onAnnounce={setAnnouncement}>
              <ComparisonBody
                request={session}
                currentUserId={currentUserId}
                onClose={onClose}
                onAnnounce={setAnnouncement}
                titleRef={titleRef}
              />
            </ComparisonErrorBoundary>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
