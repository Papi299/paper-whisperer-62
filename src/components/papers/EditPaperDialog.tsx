import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useAbstract } from "@/hooks/useAbstract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { PaperWithTags, Project, Tag } from "@/types/database";
import { isGenericStudyType } from "@/lib/studyTypeUtils";
import { toSafeExternalHref } from "@/lib/externalUrl";
import { Loader2, X, Link as LinkIcon, Check, ChevronsUpDown, FolderOpen, Tags, Trash2, FileText, Upload, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAttachments, OnAttachmentsChange } from "@/hooks/useAttachments";
import { useTouchSafeInitialFocus } from "@/hooks/useCoarsePointer";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { PaperOrganizationSuggestions } from "@/components/papers/PaperOrganizationSuggestions";
import { parseAnalyzeError, formatQuotaExceededMessage } from "@/lib/analyzeError";
import type { AiQuotaStatus } from "@/hooks/useAiQuota";

interface EditPaperDialogProps {
  paper: PaperWithTags | null;
  projects: Project[];
  tags: Tag[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Persist the edits. Must resolve to `true` only when every requested write
   * has succeeded — the dialog closes on `true` and stays open with the
   * user's edited form values preserved on `false`. The downstream
   * `usePaperMutations.updatePaper` already owns rollback + destructive-toast
   * surfacing for each failure path, so this dialog only needs to read the
   * boolean and decide whether to close.
   */
  onSave: (paper: Partial<PaperWithTags> & { tagIds: string[]; projectIds: string[] }) => Promise<boolean>;
  userId?: string | null;
  onAttachmentsChange?: OnAttachmentsChange;
  /**
   * Read-only AI-request quota status. Advisory only: a known zero intercepts
   * a click before it becomes a doomed request, and an exempt user is never
   * intercepted. Unknown status (loading / failed) never blocks — the server's
   * HTTP 402 is the enforcement boundary for both AI actions in this dialog.
   */
  aiQuotaStatus?: AiQuotaStatus | null;
  /** Re-read the shared quota after an actual invocation (consume or refund). */
  onAiQuotaRefresh?: () => void;
  /**
   * The existing Project/Tag creation mutations, threaded through so
   * "Create & select" reuses the domain authority instead of inserting rows
   * from a suggestion component. Resolve to the entity so the new id can enter
   * this dialog's LOCAL selection; `null` means nothing was created.
   */
  onCreateProject?: (name: string, description?: string | null) => Promise<Project | null>;
  onCreateTag?: (name: string) => Promise<Tag | null>;
}

export function EditPaperDialog({
  paper,
  projects,
  tags,
  open,
  onOpenChange,
  onSave,
  userId,
  onAttachmentsChange,
  aiQuotaStatus,
  onAiQuotaRefresh,
  onCreateProject,
  onCreateTag,
}: EditPaperDialogProps) {
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState("");
  const [year, setYear] = useState("");
  const [journal, setJournal] = useState("");
  const [pmid, setPmid] = useState("");
  const [doi, setDoi] = useState("");
  const [abstract, setAbstract] = useState("");
  const [studyType, setStudyType] = useState("");
  const [statisticalMethods, setStatisticalMethods] = useState("");
  const [keywords, setKeywords] = useState("");
  const [driveUrl, setDriveUrl] = useState("");
  const [pubmedUrl, setPubmedUrl] = useState("");
  const [tldr, setTldr] = useState("");
  const [notes, setNotes] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  /**
   * True while a Project/Tag the user asked the suggestion surface to create is
   * still being inserted.
   *
   * It exists to serialize Save behind that insert. "Create & select" cannot add
   * the new id to `selectedProjectIds` until the mutation resolves with a real
   * row, so a Save dispatched inside that window would capture the selection as
   * it was *before* the creation and persist a paper that is not assigned to the
   * Project the user just made — with both clicks having happened in the right
   * order. Network timing must not change what the user's actions meant.
   */
  const [creatingTaxonomy, setCreatingTaxonomy] = useState(false);
  /**
   * Which creation currently holds {@link creatingTaxonomy}.
   *
   * One boolean is shared by every creation the user starts, and this dialog
   * outlives the suggestion surface — Edit Paper stays mounted across a
   * close/reopen while that surface unmounts and remounts. So a creation
   * started for a previous paper, by a previous instance, can still settle
   * after a newer creation has taken the interlock. Without an owner recorded
   * here its release would be indistinguishable from the current creation's,
   * and Save would come back while the newer insert was still in flight —
   * exactly the race the interlock exists to prevent, re-entering through the
   * unlock path instead of the lock path.
   */
  const creationOwnerTokenRef = useRef<number | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Edit Paper is opened to read a paper at least as often as to retitle it,
  // and Title is the first tabbable element — so on a finger the keyboard
  // covered the form the instant the dialog opened. The heading takes initial
  // focus on a coarse pointer; a mouse still lands in Title.
  const { focusRef: headingRef, onOpenAutoFocus: onDialogAutoFocus } =
    useTouchSafeInitialFocus<HTMLHeadingElement>();
  // Projects and Tags are two Popovers rendered at the same time, so they need
  // two independent refs — one shared ref would point at whichever mounted
  // last. Each focuses its own panel (already `tabIndex={-1}`) on a coarse
  // pointer, leaving the option list readable, and falls through to Radix's
  // CommandInput autofocus on a mouse.
  const { focusRef: projectPopoverRef, onOpenAutoFocus: onProjectPopoverAutoFocus } =
    useTouchSafeInitialFocus<HTMLDivElement>();
  const { focusRef: tagPopoverRef, onOpenAutoFocus: onTagPopoverAutoFocus } =
    useTouchSafeInitialFocus<HTMLDivElement>();

  const { toast } = useToast();

  // Fetch abstract on demand — only when dialog is open
  const { data: fetchedAbstract, isLoading: abstractLoading } = useAbstract(open && paper ? paper.id : null, userId);

  /**
   * True while a *saved* abstract this paper is known to have has not yet been
   * loaded into the draft.
   *
   * The AI organization request is built from the draft, and the effect below
   * writes the fetched abstract into it — so a request dispatched during this
   * window is sent without an abstract the paper actually has, and the arriving
   * text then changes the semantic fingerprint and invalidates the answer. The
   * user would have paid one AI request for a result the dialog itself knew it
   * was about to discard. The eligibility rule cannot catch this on its own:
   * keywords or a study type alone already satisfy it, so the action would look
   * perfectly available.
   *
   * Deliberately three conditions, not one:
   *   - `has_abstract` — a paper with no saved abstract has nothing to wait for,
   *     so it is never gated by this (the query still runs and resolves to
   *     `null`, and blocking on that would be waiting for nothing);
   *   - `!paper.abstract` — when the text is already on the paper object the
   *     draft was seeded with it, and the value that lands is the same column,
   *     so there is nothing to wait for either;
   *   - `abstractLoading` — the initial load only. A background refetch cannot
   *     hold the action, and a failed fetch clears it rather than waiting
   *     forever.
   *
   * This is draft hydration specifically — not Save, not generation, not quota.
   */
  const abstractHydrating = !!paper?.has_abstract && !paper?.abstract && abstractLoading;

  const { attachments, uploading, uploadAttachments, deleteAttachment } = useAttachments(
    paper?.id,
    userId,
    onAttachmentsChange,
  );

  useEffect(() => {
    if (paper) {
      setTitle(paper.title);
      setAuthors(paper.authors.join(", "));
      setYear(paper.year?.toString() || "");
      setJournal(paper.journal || "");
      setPmid(paper.pmid || "");
      setDoi(paper.doi || "");
      // abstract is loaded on demand via useAbstract; use paper.abstract as fallback
      // if it's already available (e.g. from a previous fetch cached on the paper object)
      setAbstract(paper.abstract || "");
      setStudyType(paper.study_type || "");
      setStatisticalMethods(paper.statistical_methods || "");
      setKeywords(paper.keywords.join(", "));
      setDriveUrl(paper.drive_url || "");
      setPubmedUrl(paper.pubmed_url || "");
      setTldr(paper.tldr || "");
      setNotes(paper.notes || "");
      setSelectedProjectIds(paper.projects.map((p) => p.id));
      setSelectedTagIds(paper.tags.map((t) => t.id));
    }
  }, [paper]);

  // When the on-demand abstract arrives, populate the form field
  useEffect(() => {
    if (fetchedAbstract !== undefined && fetchedAbstract !== null && paper) {
      setAbstract(fetchedAbstract);
    }
  }, [fetchedAbstract, paper]);

  /**
   * Apply an interlock transition, but only from the creation entitled to make
   * it.
   *
   * Acquiring is unconditional: a newer creation always takes ownership, which
   * is what makes a superseded one's later release a no-op. Releasing is
   * conditional on still being the owner — a stale `false` is dropped rather
   * than obeyed.
   *
   * Stable by construction (no dependencies), so the child can hold it in a ref
   * and call it straight from a click handler.
   */
  const handleCreationPendingChange = useCallback((pending: boolean, token: number) => {
    if (pending) {
      creationOwnerTokenRef.current = token;
      setCreatingTaxonomy(true);
      return;
    }
    if (creationOwnerTokenRef.current !== token) return;
    creationOwnerTokenRef.current = null;
    setCreatingTaxonomy(false);
  }, []);

  const handleSave = async () => {
    if (!paper) return;
    // The Save button is already disabled here; this keeps the invariant local
    // to the function that persists, so no future caller can bypass it.
    if (creatingTaxonomy) return;

    setLoading(true);
    try {
      // Close the dialog only after the update actually succeeds. On any
      // failure path (papers row update, set_paper_tags, set_paper_projects,
      // or missing userId), `onSave` resolves to `false` — the dialog stays
      // open and every edited form field is preserved so the user can
      // correct the issue and retry. The destructive toast is already
      // surfaced by `usePaperMutations.updatePaper`.
      const success = await onSave({
        id: paper.id,
        title,
        authors: authors.split(",").map((a) => a.trim()).filter(Boolean),
        year: year ? parseInt(year) : null,
        journal: journal || null,
        pmid: pmid || null,
        doi: doi || null,
        abstract: abstract || null,
        study_type: studyType || null,
        statistical_methods: statisticalMethods || null,
        keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
        drive_url: driveUrl || null,
        pubmed_url: pubmedUrl || null,
        tldr: tldr || null,
        notes: notes || null,
        tagIds: selectedTagIds,
        projectIds: selectedProjectIds,
      });
      if (success) {
        onOpenChange(false);
      }
    } finally {
      setLoading(false);
    }
  };

  /**
   * Positively known to have nothing left. Exempt internal users are NEVER
   * known-zero — their commercial `remaining` can read 0 while the server still
   * allows every request — and an unknown status (loading / failed) is not
   * known-zero either. Shared by both AI actions in this dialog so they cannot
   * disagree about the same allowance.
   */
  const knownZeroAiQuota =
    !!aiQuotaStatus && !aiQuotaStatus.isExempt && aiQuotaStatus.remaining <= 0;

  const toastAiQuotaExhausted = (info: {
    periodType: string | null;
    used: number;
    quota: number;
    resetAt: string | null;
  }) => {
    toast({
      title: "AI requests used up",
      description: formatQuotaExceededMessage(info),
      variant: "destructive",
    });
  };

  /**
   * Local-draft AI analysis. The smart merge below is unchanged: a specific
   * PubMed study type still wins over a generic AI guess, and statistical
   * methods / TLDR still populate the form without saving.
   *
   * What AI-PROJECT-TAG-SUGGESTIONS-001B added is only quota coherence with
   * the suggestion button that now sits in the same dialog and spends the same
   * allowance — a known-zero intercept, a parsed 402, a provider failure kept
   * distinct from a plan wall, and a refresh of the shared indicator after any
   * actual invocation. It is deliberately NOT a rewrite of the analysis path.
   */
  const handleAnalyze = async () => {
    if (!abstract.trim()) return;

    // Known-zero convenience intercept: no request, and no quota refresh —
    // nothing was spent. The server stays authoritative when status is unknown.
    if (knownZeroAiQuota && aiQuotaStatus) {
      toastAiQuotaExhausted(aiQuotaStatus);
      return;
    }

    setAnalyzing(true);
    // Only a real invocation may have consumed or refunded a unit.
    let attempted = false;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      attempted = true;
      const { data, error } = await supabase.functions.invoke("analyze-paper", {
        body: { title, abstract },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (error) throw error;

      // Smart Merge: preserve high-quality PubMed study type over AI guess
      const existingStudyType = paper?.study_type ?? studyType;
      const keptExisting = !isGenericStudyType(existingStudyType);

      if (keptExisting) {
        // Keep existing specific study type from PubMed — don't overwrite
      } else if (data.studyType && data.studyType !== "Not specified") {
        setStudyType(data.studyType);
      }

      if (data.statisticalMethods && data.statisticalMethods !== "Not specified") {
        setStatisticalMethods(data.statisticalMethods);
      }
      if (data.tldr) setTldr(data.tldr);

      toast({
        title: "AI analysis complete",
        description: keptExisting
          ? `TLDR updated. Kept existing study type from PubMed.`
          : undefined,
      });
    } catch (err: unknown) {
      // Read the structured body rather than the generic non-2xx string, so an
      // authoritative 402 and an upstream provider failure stay separable.
      const parsed = await parseAnalyzeError(err);
      if (parsed.kind === "quota_exceeded") {
        toastAiQuotaExhausted(parsed.info);
      } else if (parsed.kind === "provider_failure") {
        // A Gemini 429/503 is NOT the user's plan running out.
        toast({
          title: "AI analysis unavailable",
          description: parsed.message,
          variant: "destructive",
        });
      } else {
        toast({ title: "AI analysis failed", description: parsed.message, variant: "destructive" });
      }
    } finally {
      if (attempted) onAiQuotaRefresh?.();
      setAnalyzing(false);
    }
  };

  const toggleProject = (projectId: string) => {
    setSelectedProjectIds((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId]
    );
  };

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  };

  // Add-only counterparts for accepting a suggestion. Deliberately not
  // `toggleProject`: accepting a recommendation the user has already selected
  // would otherwise *remove* it, turning "Select" into an unselect.
  const addProject = (projectId: string) => {
    setSelectedProjectIds((prev) => (prev.includes(projectId) ? prev : [...prev, projectId]));
  };

  const addTag = (tagId: string) => {
    setSelectedTagIds((prev) => (prev.includes(tagId) ? prev : [...prev, tagId]));
  };

  // The keywords the suggestion request carries, parsed exactly as `handleSave`
  // parses them, so what the model sees is what a save would store.
  const parsedKeywords = useMemo(
    () => keywords.split(",").map((k) => k.trim()).filter(Boolean),
    [keywords],
  );

  /**
   * The unsaved draft the suggestion surface reasons about — the four semantic
   * fields the Edge contract accepts and nothing else. Memoized so the
   * staleness fingerprint changes only when one of those four changes, not on
   * every keystroke in Notes.
   */
  const organizationDraft = useMemo(
    () => ({ title, abstract, keywords: parsedKeywords, studyType }),
    [title, abstract, parsedKeywords, studyType],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Scroll ownership. Previously the shell itself was the scroll owner
        (`max-h-[90vh] overflow-y-auto`), which is unreliable on a phone or
        tablet: `vh` resolves against the *large* viewport, so with the browser
        chrome on screen the shell could be taller than the visible area while
        the element still believed its contents fitted — leaving the bottom of
        the form under the toolbar with little or no scroll range to recover it.

        Now the shell is bounded to the *dynamic* viewport and clips, and one
        deliberate region inside it scrolls. `minmax(0, 1fr)` on the second grid
        row is what lets that region shrink below its content instead of
        overflowing the clip. `90vh` stays in the class as the fallback for
        engines without `dvh`; the inline `90dvh` wins wherever it is supported
        and is simply dropped where it is not.
      */}
      <DialogContent
        className="sm:max-w-4xl max-h-[90vh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
        style={{ maxHeight: "90dvh" }}
        onOpenAutoFocus={onDialogAutoFocus}
      >
        <DialogHeader>
          <DialogTitle ref={headingRef} tabIndex={-1} className="outline-none">
            Edit Paper
          </DialogTitle>
        </DialogHeader>

        {/*
          The single vertical scroll owner: the whole long form, the attachments
          and the actions, so no section can become unreachable and the page
          behind the modal is never needed to scroll. `overscroll-contain` stops
          a pan that runs past the end from chaining out to that locked page,
          and `touch-pan-y` states the gesture the region accepts.
        */}
        <div
          data-testid="edit-paper-scroll"
          className="min-h-0 space-y-4 overflow-y-auto overscroll-contain touch-pan-y pr-1"
        >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* ── Column 1: Metadata ── */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="authors">Authors (comma-separated)</Label>
                <Input
                  id="authors"
                  value={authors}
                  onChange={(e) => setAuthors(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="year">Year</Label>
                <Input
                  id="year"
                  type="number"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="journal">Journal</Label>
              <Input
                id="journal"
                value={journal}
                onChange={(e) => setJournal(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="pmid">PMID</Label>
                <Input
                  id="pmid"
                  value={pmid}
                  onChange={(e) => setPmid(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="doi">DOI</Label>
                <Input
                  id="doi"
                  value={doi}
                  onChange={(e) => setDoi(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pubmedUrl">PubMed URL</Label>
              <Input
                id="pubmedUrl"
                value={pubmedUrl}
                onChange={(e) => setPubmedUrl(e.target.value)}
                placeholder="https://pubmed.ncbi.nlm.nih.gov/..."
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="driveUrl" className="flex items-center gap-2">
                <LinkIcon className="h-4 w-4" />
                Cloud Storage URL
              </Label>
              <Input
                id="driveUrl"
                value={driveUrl}
                onChange={(e) => setDriveUrl(e.target.value)}
                placeholder="https://drive.google.com/..., https://dropbox.com/..."
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="keywords">Keywords (comma-separated)</Label>
              <Input
                id="keywords"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                disabled={loading}
              />
            </div>
          </div>

          {/* ── Column 2: Categorization ── */}
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="abstract">Abstract</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5"
                  disabled={!abstract.trim() || analyzing || loading}
                  onClick={handleAnalyze}
                >
                  {analyzing ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Analyzing...</>
                  ) : (
                    <><Sparkles className="h-3.5 w-3.5" /> AI Analyze</>
                  )}
                </Button>
              </div>
              <Textarea
                id="abstract"
                value={abstract}
                onChange={(e) => setAbstract(e.target.value)}
                rows={5}
                disabled={loading || abstractLoading}
                placeholder={abstractLoading ? "Loading abstract…" : ""}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tldr">TL;DR</Label>
              <Input
                id="tldr"
                value={tldr}
                onChange={(e) => setTldr(e.target.value)}
                placeholder="AI-generated summary..."
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder="Personal notes, observations, follow-up questions…"
                disabled={loading}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="studyType">Study Type</Label>
                <Input
                  id="studyType"
                  value={studyType}
                  onChange={(e) => setStudyType(e.target.value)}
                  placeholder="e.g., RCT, Meta-analysis"
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="statisticalMethods">Statistical Methods</Label>
                <Input
                  id="statisticalMethods"
                  value={statisticalMethods}
                  onChange={(e) => setStatisticalMethods(e.target.value)}
                  placeholder="e.g., ANOVA, Regression"
                  disabled={loading}
                />
              </div>
            </div>

            {/*
              AI organization suggestions sit immediately above the Projects
              selector — the categorization controls they feed. Deliberately
              inside this column and inside `edit-paper-scroll`: it introduces
              no second scroll owner, no nested dialog, and no Paper List row
              action. Generation happens only on an explicit click.
            */}
            {paper && (
              <PaperOrganizationSuggestions
                paperId={paper.id}
                draft={organizationDraft}
                projects={projects}
                tags={tags}
                selectedProjectIds={selectedProjectIds}
                selectedTagIds={selectedTagIds}
                onSelectProject={addProject}
                onSelectTag={addTag}
                onCreateProject={onCreateProject}
                onCreateTag={onCreateTag}
                onCreationPendingChange={handleCreationPendingChange}
                quotaStatus={aiQuotaStatus}
                onQuotaRefresh={onAiQuotaRefresh}
                draftHydrating={abstractHydrating}
                disabled={loading}
              />
            )}

            {/* Projects — Searchable Combobox */}
            <div className="space-y-2 relative">
              <Label>Projects</Label>
              <Popover open={projectOpen} onOpenChange={setProjectOpen} modal={true}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-between h-9" disabled={loading}>
                    <span className="flex items-center gap-1.5">
                      <FolderOpen className="h-3.5 w-3.5" />
                      {selectedProjectIds.length > 0
                        ? `${selectedProjectIds.length} project${selectedProjectIds.length !== 1 ? "s" : ""} selected`
                        : "Select projects..."}
                    </span>
                    <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                {/*
                  Collision avoidance is on: measured at a 1024x768 landscape
                  tablet, the Tags panel below opened at y=732..819 against a
                  768px viewport — 51px of it off the bottom edge — because
                  `avoidCollisions={false}` pinned it under its trigger.
                */}
                <PopoverContent ref={projectPopoverRef} onOpenAutoFocus={onProjectPopoverAutoFocus} className="w-[--radix-popover-trigger-width] p-0" side="bottom" align="start" sideOffset={4} collisionPadding={8} style={{ pointerEvents: 'auto' }}>
                  <Command filter={(value, search) => value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0}>
                    <CommandInput placeholder="Search projects..." aria-label="Search projects" />
                    <CommandList>
                      <CommandEmpty>No projects found.</CommandEmpty>
                      <CommandGroup>
                        {projects.map((project) => (
                          <CommandItem
                            key={project.id}
                            value={project.name}
                            onSelect={() => toggleProject(project.id)}
                          >
                            <Check className={cn("mr-2 h-4 w-4", selectedProjectIds.includes(project.id) ? "opacity-100" : "opacity-0")} />
                            <span className="w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: project.color }} />
                            {project.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {selectedProjectIds.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {selectedProjectIds.map((id) => {
                    const project = projects.find((p) => p.id === id);
                    return project ? (
                      <Badge key={id} variant="outline" className="text-xs flex items-center gap-1 pr-1">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />
                        {project.name}
                        <button
                          type="button"
                          onClick={() => toggleProject(id)}
                          aria-label={`Remove project "${project.name}"`}
                          className="hover:bg-muted rounded p-0.5"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ) : null;
                  })}
                </div>
              )}
            </div>

            {/* Tags — Searchable Combobox */}
            <div className="space-y-2 relative">
              <Label>Tags</Label>
              <Popover open={tagOpen} onOpenChange={setTagOpen} modal={true}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-between h-9" disabled={loading}>
                    <span className="flex items-center gap-1.5">
                      <Tags className="h-3.5 w-3.5" />
                      {selectedTagIds.length > 0
                        ? `${selectedTagIds.length} tag${selectedTagIds.length !== 1 ? "s" : ""} selected`
                        : "Select tags..."}
                    </span>
                    <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent ref={tagPopoverRef} onOpenAutoFocus={onTagPopoverAutoFocus} className="w-[--radix-popover-trigger-width] p-0" side="bottom" align="start" sideOffset={4} collisionPadding={8} style={{ pointerEvents: 'auto' }}>
                  <Command filter={(value, search) => value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0}>
                    <CommandInput placeholder="Search tags..." aria-label="Search tags" />
                    <CommandList>
                      <CommandEmpty>No tags found.</CommandEmpty>
                      <CommandGroup>
                        {tags.map((tag) => (
                          <CommandItem
                            key={tag.id}
                            value={tag.name}
                            onSelect={() => toggleTag(tag.id)}
                          >
                            <Check className={cn("mr-2 h-4 w-4", selectedTagIds.includes(tag.id) ? "opacity-100" : "opacity-0")} />
                            <span className="w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: tag.color }} />
                            {tag.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {selectedTagIds.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {selectedTagIds.map((id) => {
                    const tag = tags.find((t) => t.id === id);
                    return tag ? (
                      <Badge key={id} variant="secondary" className="text-xs flex items-center gap-1 pr-1">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />
                        {tag.name}
                        <button
                          type="button"
                          onClick={() => toggleTag(id)}
                          aria-label={`Remove tag "${tag.name}"`}
                          className="hover:bg-muted rounded p-0.5"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ) : null;
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Visuals & Attachments (full width) ── */}
        {userId && paper && (
          <div className="space-y-3">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <Upload className="h-4 w-4" />
              Visuals &amp; Attachments
            </Label>

            {/* Drop zone */}
            <div
              className={cn(
                "flex flex-col items-center justify-center rounded-md border-2 border-dashed p-6 text-center text-sm text-muted-foreground cursor-pointer transition-colors",
                dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                uploading && "pointer-events-none opacity-60",
              )}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const files = Array.from(e.dataTransfer.files);
                if (files.length > 0) uploadAttachments(files);
              }}
            >
              {uploading ? (
                <><Loader2 className="mb-2 h-5 w-5 animate-spin" /> Uploading…</>
              ) : (
                <>
                  <Upload className="mb-2 h-5 w-5" />
                  <span>Drop files here or <span className="text-primary underline">browse</span></span>
                  <span className="mt-1 text-xs">Images &amp; PDFs · Max 20 MB each</span>
                </>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) uploadAttachments(files);
                e.target.value = "";
              }}
            />

            {/* Thumbnail grid */}
            {attachments.length > 0 && (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                {attachments.map((att) => {
                  // `publicUrl` is a Supabase Storage signed URL, but it falls
                  // back to "" when signing fails; run it through the same
                  // allowlist so only a real http(s) URL becomes a link.
                  const attachmentHref = toSafeExternalHref(att.publicUrl);
                  const thumbnail = att.file_type.startsWith("image/") ? (
                    <img
                      src={att.publicUrl}
                      alt={att.file_name}
                      className="h-20 w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-20 w-full items-center justify-center">
                      <FileText className="h-8 w-8 text-muted-foreground" />
                    </div>
                  );
                  return (
                  <div key={att.id} className="group relative rounded-md border overflow-hidden bg-muted">
                    {attachmentHref ? (
                      <a href={attachmentHref} target="_blank" rel="noopener noreferrer" className="block">
                        {thumbnail}
                      </a>
                    ) : (
                      <div className="block">{thumbnail}</div>
                    )}
                    <p className="truncate px-1 py-0.5 text-[10px] text-muted-foreground">{att.file_name}</p>
                    <button
                      onClick={() => deleteAttachment(att)}
                      className="absolute right-1 top-1 hidden rounded bg-destructive p-0.5 text-destructive-foreground group-hover:flex"
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          {/*
            Save waits for an in-flight "Create & select". Cancel deliberately
            does not: creation is an explicit, immediate mutation the user has
            already committed to, and trapping them in the dialog until a
            network call returns would be worse than letting them leave. Nothing
            can be persisted by leaving — `handleSave` is the only path that
            writes the paper, and the creation's completion only touches this
            dialog's local selection, which is re-seeded from the paper on the
            next open.
          */}
          <Button onClick={handleSave} disabled={loading || creatingTaxonomy}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
