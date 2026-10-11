import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Trash2, FolderOpen, Tags, X, Loader2, FolderMinus, TagsIcon, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Project, Tag } from "@/types/database";

/**
 * Where the floating toolbar may sit: inside the viewport on every side, and
 * clear of the device's safe areas.
 *
 * The toolbar used to be a centred row with no width bound at all. It measured
 * about 1,122px at every viewport, so on any narrower screen both of its ends
 * were cut off by the screen edge. Nothing could scroll them back: 1 of 8
 * controls was reachable at 320px, 2 at 390px, 5 at 768px and 6 at 1,024px.
 *
 * `left`/`right` bound the width, and `md:w-fit` with `mx-auto` centres the
 * panel within those bounds, as `<dialog>` does. `maxHeight` keeps the expanded
 * phone list on screen in a short landscape viewport; the list scrolls inside
 * the panel instead. These values sit inline because they need `env()`, the
 * same way `MobileMultiSelectSheet` keeps its safe-area padding inline. The
 * insets are 0 until the page opts into `viewport-fit=cover`.
 */
const PANEL_BOUNDS: CSSProperties = {
  left: "max(1rem, env(safe-area-inset-left))",
  right: "max(1rem, env(safe-area-inset-right))",
  bottom: "calc(1.5rem + env(safe-area-inset-bottom))",
  maxHeight: "calc(100dvh - 3rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
};

/**
 * Every bulk action shares one presentation. Below `md` it is a full-width row
 * in the expanded list, 40px tall like the narrow-screen sidebar rows. From
 * `md` up it is the original compact button, which grows back to the 40px
 * minimum on a coarse pointer. `shrink-0` stops a height-capped list from
 * squashing its rows instead of scrolling them.
 */
const ACTION_BUTTON = "h-10 w-full shrink-0 justify-start md:h-9 md:w-auto md:justify-center coarse:min-h-10";

/**
 * Where focus goes if the toolbar disappears while it holds focus and the
 * control that focus came from is gone too. That happens after a bulk delete,
 * which removes the row checkbox that completed the selection. The table's own
 * "Select all" checkbox is the one selection control that survives every bulk
 * action.
 */
const SELECTION_FALLBACK_FOCUS = '[role="checkbox"][aria-label="Select all"]';

interface BulkActionsToolbarProps {
  selectedCount: number;
  onClearSelection: () => void;
  onBulkDelete: () => Promise<void>;
  onBulkSetProjects: (projectIds: string[]) => Promise<void>;
  onBulkSetTags: (tagIds: string[]) => Promise<void>;
  onBulkAnalyze?: () => Promise<void>;
  bulkAnalyzing?: boolean;
  bulkAnalyzeProgress?: { current: number; total: number };
  projects: Project[];
  tags: Tag[];
}

export function BulkActionsToolbar({
  selectedCount,
  onClearSelection,
  onBulkDelete,
  onBulkSetProjects,
  onBulkSetTags,
  onBulkAnalyze,
  bulkAnalyzing = false,
  bulkAnalyzeProgress = { current: 0, total: 0 },
  projects,
  tags,
}: BulkActionsToolbarProps) {
  const [loading, setLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [clearProjectsConfirmOpen, setClearProjectsConfirmOpen] = useState(false);
  const [clearTagsConfirmOpen, setClearTagsConfirmOpen] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  // Below `md` the actions sit behind a "More actions" disclosure. From `md`
  // up they are always shown, so this state only matters on a narrow screen.
  const [actionsExpanded, setActionsExpanded] = useState(false);
  const actionsId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  // The focus bookkeeping that lets the toolbar give focus back when it
  // disappears (see the layout effect below).
  const focusWithinRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const isVisible = selectedCount > 0;

  /**
   * The toolbar leaves the DOM as soon as the selection empties: Clear
   * Selection, or a bulk action finishing. Its open dialog leaves with it. If
   * focus was in either, it would otherwise drop to `<body>` and the next Tab
   * would restart at the top of the page.
   *
   * Focus goes back to the control it came from. If that control is gone too,
   * it goes to the table's Select all checkbox. Focus that the user has already
   * moved somewhere real is never touched.
   *
   * This is a layout effect so the move happens in the same commit as the
   * removal. Radix's delayed focus restore then targets the detached toolbar
   * button, which is a no-op.
   */
  useLayoutEffect(() => {
    if (isVisible) return;
    const hadFocus = focusWithinRef.current;
    const cameFrom = returnFocusRef.current;
    focusWithinRef.current = false;
    returnFocusRef.current = null;
    if (!hadFocus) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    // `focus()` is a no-op on a detached, disabled or unrendered element, so
    // the first candidate that actually takes focus wins.
    for (const target of [cameFrom, document.querySelector<HTMLElement>(SELECTION_FALLBACK_FOCUS)]) {
      target?.focus();
      if (target && document.activeElement === target) return;
    }
  }, [isVisible]);

  const handleToolbarFocus = (event: FocusEvent<HTMLDivElement>) => {
    focusWithinRef.current = true;
    const from = event.relatedTarget;
    // Remember where focus entered from. Moves inside the toolbar, and focus
    // handed back by one of its own dialogs, are not entries.
    if (from instanceof HTMLElement && !event.currentTarget.contains(from) && !from.closest('[role="dialog"]')) {
      returnFocusRef.current = from;
    }
  };

  const handleToolbarBlur = (event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget;
    // `null` covers focus dropping out with a removed control, and the window
    // losing focus. Neither means the user moved on. A move into one of the
    // toolbar's own modal dialogs does not either: that focus comes back, or
    // leaves together with the toolbar.
    if (!(to instanceof Element) || event.currentTarget.contains(to) || to.closest('[role="dialog"]')) return;
    focusWithinRef.current = false;
  };

  const toggleActions = () => {
    // Collapsing must not leave focus on a control it is about to hide. A
    // pointer press does not move focus to the toggle in every browser.
    if (actionsExpanded && actionsRef.current?.contains(document.activeElement)) {
      toggleRef.current?.focus();
    }
    setActionsExpanded((expanded) => !expanded);
  };

  const handleDelete = async () => {
    setLoading(true);
    try {
      await onBulkDelete();
    } finally {
      setLoading(false);
      setDeleteConfirmOpen(false);
    }
  };

  const handleSetProjects = async () => {
    setLoading(true);
    try {
      await onBulkSetProjects(selectedProjectIds);
    } finally {
      setLoading(false);
      setProjectDialogOpen(false);
      setSelectedProjectIds([]);
    }
  };

  const handleClearProjects = async () => {
    setLoading(true);
    try {
      await onBulkSetProjects([]);
    } finally {
      setLoading(false);
      setClearProjectsConfirmOpen(false);
    }
  };

  const handleSetTags = async () => {
    setLoading(true);
    try {
      await onBulkSetTags(selectedTagIds);
    } finally {
      setLoading(false);
      setTagDialogOpen(false);
      setSelectedTagIds([]);
    }
  };

  const handleClearTags = async () => {
    setLoading(true);
    try {
      await onBulkSetTags([]);
    } finally {
      setLoading(false);
      setClearTagsConfirmOpen(false);
    }
  };

  const toggleProject = (id: string) => {
    setSelectedProjectIds(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  const toggleTag = (id: string) => {
    setSelectedTagIds(prev =>
      prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]
    );
  };

  // A new selection always starts with the phone actions collapsed.
  if (!isVisible && actionsExpanded) setActionsExpanded(false);

  if (!isVisible) return null;

  return (
    <>
      {/*
        One panel and one set of controls at every width. Only the arrangement
        changes, so no action is ever rendered twice.

        - From `md` up the panel is a centred flex row: badge | the six actions,
          wrapping inside their own box | Clear Selection. Because the wrapping
          happens inside a box, a separator can never end up alone at the start
          or end of a line.
        - Below `md` it is a two-row grid. The bottom row holds the count and
          the "More actions" toggle. The expanded list opens above that row, so
          the toggle stays under the thumb, and the list is the row that
          scrolls when the height cap binds.

        The badge must stay a direct child of this div, with Delete inside it:
        the E2E cleanup helpers find Delete through the badge's parent.
      */}
      <div
        role="region"
        aria-label="Bulk actions"
        className="fixed z-50 mx-auto grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border bg-background/95 px-3 py-2 shadow-2xl backdrop-blur md:flex md:w-fit md:px-4 md:py-2.5"
        style={PANEL_BOUNDS}
        onFocus={handleToolbarFocus}
        onBlur={handleToolbarBlur}
      >
        <Badge variant="secondary" className="row-start-2 shrink-0 justify-self-start whitespace-nowrap text-sm font-medium">
          {selectedCount} selected
        </Badge>

        <div className="hidden h-5 w-px shrink-0 bg-border md:block" />

        <Button
          ref={toggleRef}
          variant="outline"
          size="sm"
          className="row-start-2 h-10 justify-self-end md:hidden"
          aria-expanded={actionsExpanded}
          aria-controls={actionsId}
          onClick={toggleActions}
        >
          {actionsExpanded ? <ChevronDown className="h-4 w-4 mr-1" /> : <ChevronUp className="h-4 w-4 mr-1" />}
          {actionsExpanded ? "Fewer actions" : "More actions"}
        </Button>

        {/*
          Below `md` this div is the disclosed list: `display: none` while
          collapsed, so its controls are neither shown nor tabbable. Its padding
          and matching scroll padding leave room for the buttons' 4px focus
          rings, including on a row that Tab has just scrolled into view.
          From `md` up it is `display: contents`, so its children join the row
          above. That is also why it carries no role: older engines drop a role
          from a `display: contents` element.
        */}
        <div
          ref={actionsRef}
          id={actionsId}
          className={cn(
            actionsExpanded ? "flex" : "hidden",
            "col-span-2 row-start-1 -mx-1.5 -mt-1.5 mb-1 min-h-0 scroll-py-1.5 flex-col gap-2 self-stretch overflow-y-auto overscroll-contain p-1.5 md:contents",
          )}
        >
          <div className="flex shrink-0 flex-col gap-2 md:min-w-0 md:flex-1 md:flex-row md:flex-wrap md:items-center md:gap-x-3 md:gap-y-2">
            {onBulkAnalyze && (
              <Button
                variant="outline"
                size="sm"
                className={ACTION_BUTTON}
                disabled={loading || bulkAnalyzing}
                onClick={onBulkAnalyze}
              >
                {bulkAnalyzing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    Analyzing {bulkAnalyzeProgress.current} of {bulkAnalyzeProgress.total}...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-1" />
                    AI Analyze ({selectedCount})
                  </>
                )}
              </Button>
            )}

            <Button
              variant="destructive"
              size="sm"
              className={ACTION_BUTTON}
              disabled={loading || bulkAnalyzing}
              onClick={() => setDeleteConfirmOpen(true)}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Trash2 className="h-4 w-4 mr-1" />}
              Delete
            </Button>

            <Button
              variant="outline"
              size="sm"
              className={ACTION_BUTTON}
              disabled={loading || bulkAnalyzing}
              onClick={() => { setSelectedProjectIds([]); setProjectDialogOpen(true); }}
            >
              <FolderOpen className="h-4 w-4 mr-1" />
              Set Project
            </Button>

            <Button
              variant="outline"
              size="sm"
              className={ACTION_BUTTON}
              disabled={loading || bulkAnalyzing}
              onClick={() => setClearProjectsConfirmOpen(true)}
            >
              <FolderMinus className="h-4 w-4 mr-1" />
              Clear Projects
            </Button>

            <Button
              variant="outline"
              size="sm"
              className={ACTION_BUTTON}
              disabled={loading || bulkAnalyzing}
              onClick={() => { setSelectedTagIds([]); setTagDialogOpen(true); }}
            >
              <Tags className="h-4 w-4 mr-1" />
              Set Tags
            </Button>

            <Button
              variant="outline"
              size="sm"
              className={ACTION_BUTTON}
              disabled={loading || bulkAnalyzing}
              onClick={() => setClearTagsConfirmOpen(true)}
            >
              <X className="h-4 w-4 mr-1" />
              Clear Tags
            </Button>
          </div>

          <div className="h-px w-full shrink-0 bg-border md:h-5 md:w-px" />

          <Button variant="ghost" size="sm" className={ACTION_BUTTON} onClick={onClearSelection} disabled={loading || bulkAnalyzing}>
            <X className="h-4 w-4 mr-1" />
            Clear Selection
          </Button>
        </div>
      </div>

      {/* Delete confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedCount} paper{selectedCount !== 1 ? "s" : ""}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)} disabled={loading}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear Projects confirmation */}
      <Dialog open={clearProjectsConfirmOpen} onOpenChange={setClearProjectsConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear projects from {selectedCount} paper{selectedCount !== 1 ? "s" : ""}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">All project assignments will be removed from the selected papers.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearProjectsConfirmOpen(false)} disabled={loading}>Cancel</Button>
            <Button variant="destructive" onClick={handleClearProjects} disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Clear Projects
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear Tags confirmation */}
      <Dialog open={clearTagsConfirmOpen} onOpenChange={setClearTagsConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear tags from {selectedCount} paper{selectedCount !== 1 ? "s" : ""}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">All tag assignments will be removed from the selected papers.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearTagsConfirmOpen(false)} disabled={loading}>Cancel</Button>
            <Button variant="destructive" onClick={handleClearTags} disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Clear Tags
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set Project dialog */}
      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Projects for {selectedCount} paper{selectedCount !== 1 ? "s" : ""}</DialogTitle>
          </DialogHeader>
          <div className="max-h-60 overflow-y-auto space-y-2">
            {projects.length === 0 && <p className="text-sm text-muted-foreground">No projects available.</p>}
            {projects.map(p => (
              <label key={p.id} className="flex items-center gap-2 cursor-pointer py-1">
                <Checkbox
                  checked={selectedProjectIds.includes(p.id)}
                  onCheckedChange={() => toggleProject(p.id)}
                />
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: p.color }} />
                <span className="text-sm">{p.name}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProjectDialogOpen(false)} disabled={loading}>Cancel</Button>
            <Button onClick={handleSetProjects} disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set Tags dialog */}
      <Dialog open={tagDialogOpen} onOpenChange={setTagDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Tags for {selectedCount} paper{selectedCount !== 1 ? "s" : ""}</DialogTitle>
          </DialogHeader>
          <div className="max-h-60 overflow-y-auto space-y-2">
            {tags.length === 0 && <p className="text-sm text-muted-foreground">No tags available.</p>}
            {tags.map(t => (
              <label key={t.id} className="flex items-center gap-2 cursor-pointer py-1">
                <Checkbox
                  checked={selectedTagIds.includes(t.id)}
                  onCheckedChange={() => toggleTag(t.id)}
                />
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.color }} />
                <span className="text-sm">{t.name}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTagDialogOpen(false)} disabled={loading}>Cancel</Button>
            <Button onClick={handleSetTags} disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
