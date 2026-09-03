import { useState, useCallback, useRef, type DragEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
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
import { Loader2, Link as LinkIcon, Upload, PenLine, CheckCircle2, AlertTriangle, XCircle, FileUp, FolderOpen, Tags, Check, ChevronsUpDown, FileText, X, Search } from "lucide-react";
import { Project, Tag } from "@/types/database";
import { RawPaperData } from "@/lib/normalizePaperData";
import { parseFile, FileParseResult } from "@/lib/importParsers";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileMultiSelectSheet } from "./MobileMultiSelectSheet";
import { AssignOnImportSection } from "./AssignOnImportSection";
import { useTouchSafeInitialFocus } from "@/hooks/useCoarsePointer";
import { PubMedSearchPanel } from "./PubMedSearchPanel";
import { usePubMedSearch, type PubMedSearchFn } from "@/hooks/usePubMedSearch";

interface ManualPaperData {
  title: string;
  authors: string;
  year: string;
  journal: string;
  pmid: string;
  doi: string;
  abstract: string;
  keywords: string;
  driveUrl: string;
  pubmedUrl: string;
}

interface AddPaperDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitManual?: (
    paperData: ManualPaperData,
    options?: { targetProjectIds?: string[]; targetTagIds?: string[] }
  ) => Promise<boolean>;
  /**
   * The canonical identifier importer.
   *
   * Resolves to `unknown` rather than `void` because the importer now returns a
   * terminal result describing what happened to each identifier after its
   * assignment phase. This dialog reports progress from `onProgress` and has no
   * use for that result, so it accepts and ignores whatever comes back instead
   * of forcing the importer to narrow its contract to this one caller.
   */
  onBulkImport?: (
    identifiers: string[],
    onProgress?: (current: number, total: number, addedIds: string[], skippedIds: string[], failedIds: string[]) => void,
    options?: { targetProjectIds?: string[]; targetTagIds?: string[] }
  ) => Promise<unknown>;
  onFileImport?: (
    papers: RawPaperData[],
    onProgress?: (current: number, total: number, added: number, skipped: number, failed: number) => void,
    options?: { targetProjectIds?: string[]; targetTagIds?: string[] }
  ) => Promise<void>;
  /**
   * PubMed discovery search. Deliberately a callback like every other data
   * concern here: the dialog never talks to Supabase itself. Absent (in tests,
   * or if the Dashboard stops wiring it) the PubMed tab still renders and
   * explains that search is unavailable — no other import mode is affected.
   */
  onPubMedSearch?: PubMedSearchFn;
  /**
   * The current user's Study Type Exclusion Pool, passed straight through to
   * the PubMed tab so discovery cards stop showing publication types the user
   * has already hidden. Data, like every other concern here, arrives as a prop:
   * the dialog owns no Supabase access of its own. Absent means "no exclusions
   * configured", which renders the raw PubMed types — the prior behaviour.
   */
  excludedStudyTypes?: ReadonlySet<string>;
  projects?: Project[];
  tags?: Tag[];
}

// Parse bulk input: split on commas, newlines, or whitespace (but preserve DOIs with dots)
function parseBulkIdentifiers(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .flatMap((line) => line.trim().split(/\s+/))
    .map((id) => id.trim())
    .filter((id) => id.length > 0); // only reject empty-after-trim; no heuristic rejection
}

const emptyManualData: ManualPaperData = {
  title: "",
  authors: "",
  year: "",
  journal: "",
  pmid: "",
  doi: "",
  abstract: "",
  keywords: "",
  driveUrl: "",
  pubmedUrl: "",
};

// The formats `parseFile` has a dedicated parser for. Single source for the
// picker's filter and for the rejection message, so the copy cannot drift back
// out of step with what the importer actually reads.
//
// Exported (and `as const`) so the first-run onboarding copy in
// `PaperListEmptyState` is keyed off this exact list: adding a parser here
// without naming the format for new users is a `typecheck` failure, not a
// silently stale empty state.
export const ACCEPTED_FILE_EXTENSIONS = [".bib", ".ris", ".nbib", ".enw", ".csv"] as const;

export type AcceptedFileExtension = (typeof ACCEPTED_FILE_EXTENSIONS)[number];

/**
 * One class for all four mode triggers.
 *
 * `min-h-10` is the load-bearing part. Releasing the tab list's fixed `h-10` for
 * the phone's two-row grid also released the triggers' height: at 390×844 they
 * collapse to their 32px content box, below the 40px coarse-pointer target this
 * repository holds elsewhere. `sm:min-h-0` hands the height back to the
 * `sm:h-10` list above, so the desktop row is byte-identical to what the
 * three-tab layout produced.
 *
 * `e2e/pubmed-search.spec.ts` measures the settled height against 40 exactly,
 * and a negative control there suppresses this minimum and proves the triggers
 * fall to 32px without it. (An earlier note here recorded 30.5px; that reading
 * was taken while the dialog was still running its `zoom-in-95` open animation,
 * which scales every length inside it by 0.95 — 32 × 0.95 = 30.4.)
 */
const TAB_TRIGGER_CLASS = "flex items-center gap-1.5 min-h-10 sm:min-h-0";

export function AddPaperDialog({ open, onOpenChange, onSubmitManual, onBulkImport, onFileImport, onPubMedSearch, excludedStudyTypes, projects = [], tags = [] }: AddPaperDialogProps) {
  // The default mode is unchanged by the addition of PubMed Search: a user who
  // opens Add Papers to paste identifiers still lands where they always did.
  const [activeTab, setActiveTab] = useState<"pubmed" | "import" | "file" | "manual">("import");

  // Manual mode state
  const [manualData, setManualData] = useState<ManualPaperData>(emptyManualData);
  const [loading, setLoading] = useState(false);

  // Import state (identifier-based)
  const [bulkInput, setBulkInput] = useState("");
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });
  const [bulkResults, setBulkResults] = useState<{ addedIds: string[]; skippedIds: string[]; failedIds: string[] }>({ addedIds: [], skippedIds: [], failedIds: [] });
  const [isDragging, setIsDragging] = useState(false);

  // File import state
  const [parsedFile, setParsedFile] = useState<FileParseResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileImportRunning, setFileImportRunning] = useState(false);
  const [fileImportProgress, setFileImportProgress] = useState({ current: 0, total: 0, added: 0, skipped: 0, failed: 0 });
  const [fileImportComplete, setFileImportComplete] = useState(false);
  const [isFileDragging, setIsFileDragging] = useState(false);

  // PubMed discovery state. Owned here, not inside `PubMedSearchPanel`, because
  // Radix unmounts an inactive TabsContent — the same reason the identifier and
  // file runs keep their state at this level. Switching to Import IDs and back
  // therefore preserves the query, the page and the selection; closing the
  // dialog resets all of it.
  const pubmedSearch = usePubMedSearch(onPubMedSearch);
  const [pubmedRunning, setPubmedRunning] = useState(false);
  const [pubmedProgress, setPubmedProgress] = useState({ current: 0, total: 0 });
  const [pubmedResults, setPubmedResults] = useState<{ addedIds: string[]; skippedIds: string[]; failedIds: string[] }>({ addedIds: [], skippedIds: [], failedIds: [] });
  const [pubmedComplete, setPubmedComplete] = useState(false);
  const [pubmedImportError, setPubmedImportError] = useState<string | null>(null);

  // Project/Tag assignment state (shared between ALL FOUR tabs). PubMed Search
  // deliberately has no assignment state of its own: one Add Papers dialog
  // means one assignment intent, whichever mode produced the papers.
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  // Refs used only to restore focus after a continuation transition
  // (Import More / Import Another File) — never for reading/writing values.
  const bulkInputRef = useRef<HTMLTextAreaElement>(null);
  const fileDropzoneRef = useRef<HTMLDivElement>(null);

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

  const getImportOptions = () => {
    const opts: { targetProjectIds?: string[]; targetTagIds?: string[] } = {};
    if (selectedProjectIds.length > 0) opts.targetProjectIds = selectedProjectIds;
    if (selectedTagIds.length > 0) opts.targetTagIds = selectedTagIds;
    return Object.keys(opts).length > 0 ? opts : undefined;
  };

  // ── Identifier import drag handlers ──

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    const isValid = file.name.endsWith(".txt") || file.name.endsWith(".csv");
    if (!isValid) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result;
      if (typeof text === "string") {
        setBulkInput((prev) => (prev ? prev + "\n" + text : text));
      }
    };
    reader.readAsText(file);
  }, []);

  // ── File import drag handlers ──

  const handleFileDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsFileDragging(true);
  }, []);

  const handleFileDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsFileDragging(false);
  }, []);

  const handleFileDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsFileDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    processImportFile(file);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processImportFile(file);
    // Reset the input so the same file can be re-selected
    e.target.value = "";
  }, []);

  // The hidden native <input type="file"> remains the authoritative picker; the
  // dropzone (mouse or keyboard) just forwards to it.
  const openFilePicker = useCallback(() => {
    document.getElementById("file-import-input")?.click();
  }, []);

  const processImportFile = (file: File) => {
    const ext = "." + file.name.split(".").pop()?.toLowerCase();
    if (!(ACCEPTED_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
      setParsedFile({ papers: [], warnings: [`Unsupported format: ${ext}. Supported: ${ACCEPTED_FILE_EXTENSIONS.join(", ")}`] });
      setFileName(file.name);
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result;
      if (typeof text === "string") {
        const result = parseFile(text, file.name);
        setParsedFile(result);
        setFileName(file.name);
      }
    };
    reader.readAsText(file);
  };

  // ── Handlers ──

  const handleManualSubmit = async () => {
    if (!manualData.title.trim()) return;
    if (!onSubmitManual) return;

    setLoading(true);
    try {
      const success = await onSubmitManual(manualData, getImportOptions());
      if (success) {
        resetAndClose();
      }
    } finally {
      setLoading(false);
    }
  };

  const handleBulkImport = async () => {
    if (!onBulkImport) return;
    // Defensive: a completed run must first return to the ready state via
    // "Import More" before another import can begin, so the already-processed
    // identifier batch can never be re-imported by an unexpected re-invocation.
    if (bulkComplete) return;
    const ids = parseBulkIdentifiers(bulkInput);
    if (ids.length === 0) return;

    setBulkResults({ addedIds: [], skippedIds: [], failedIds: [] });
    setBulkRunning(true);
    setBulkProgress({ current: 0, total: ids.length });

    try {
      await onBulkImport(ids, (current, total, addedIds, skippedIds, failedIds) => {
        setBulkProgress({ current, total });
        setBulkResults({ addedIds: [...addedIds], skippedIds: [...skippedIds], failedIds: [...failedIds] });
      }, getImportOptions());
    } finally {
      setBulkRunning(false);
    }
  };

  const handleFileImport = async () => {
    if (!onFileImport || !parsedFile || parsedFile.papers.length === 0) return;

    setFileImportRunning(true);
    setFileImportComplete(false);
    setFileImportProgress({ current: 0, total: parsedFile.papers.length, added: 0, skipped: 0, failed: 0 });

    try {
      await onFileImport(parsedFile.papers, (current, total, added, skipped, failed) => {
        setFileImportProgress({ current, total, added, skipped, failed });
      }, getImportOptions());
      // Only a run that resolved without throwing reaches the completed
      // continuation state. If the callback throws, completion is skipped so a
      // partial run is never presented as successful and the parsed file and
      // assignment selections are preserved for a retry.
      setFileImportComplete(true);
    } finally {
      setFileImportRunning(false);
    }
  };

  /**
   * Import the PubMed records the user selected.
   *
   * This is the whole architectural boundary in one function: the ONLY thing
   * that crosses from discovery into persistence is a list of PMID strings, and
   * they go into the exact `onBulkImport` callback the Import IDs tab calls,
   * with the exact same shared assignment options. No search-summary object,
   * no ESummary field and no discovery title is ever handed to the importer —
   * it fetches the authoritative record for each PMID itself. There is no
   * second insert path, no second normalization and no second duplicate check.
   *
   * A result carrying a DOI still imports by PMID: the discovery source is
   * PubMed, and letting incidental metadata pick the provider would change
   * which record is authenticated.
   */
  const handlePubMedImport = async () => {
    if (!onBulkImport) return;
    if (pubmedRunning) return;
    // A copy taken before the await: the run is defined by what was selected
    // when the user pressed Import, not by whatever the selection becomes while
    // it is in flight.
    const pmids = [...pubmedSearch.selectedPmids];
    if (pmids.length === 0) return;

    setPubmedResults({ addedIds: [], skippedIds: [], failedIds: [] });
    setPubmedComplete(false);
    setPubmedImportError(null);
    setPubmedRunning(true);
    setPubmedProgress({ current: 0, total: pmids.length });

    try {
      await onBulkImport(pmids, (current, total, addedIds, skippedIds, failedIds) => {
        setPubmedProgress({ current, total });
        setPubmedResults({ addedIds: [...addedIds], skippedIds: [...skippedIds], failedIds: [...failedIds] });
      }, getImportOptions());
      // Only a run that resolved without throwing reaches the completed state.
      // The just-imported PMIDs leave the selection so they cannot be submitted
      // twice by accident, while the query, the results page and the shared
      // Project/Tag choices all stay — so the user can pick the next few papers
      // from the same search and import again.
      pubmedSearch.clearImported(pmids);
      setPubmedComplete(true);
    } catch {
      // A run that threw is caught HERE rather than escaping the click handler
      // as an unhandled rejection: the selection, the results and the assignment
      // choices are all still intact, so the honest outcome is to say the run
      // failed and leave everything ready for another attempt. The thrown value
      // is deliberately not shown — it comes from the insert path and is not
      // user-facing copy.
      setPubmedImportError(
        "The import could not be completed. Your selection was kept — you can try again.",
      );
    } finally {
      setPubmedRunning(false);
    }
  };

  /**
   * A completed summary must never become a state the user is stuck in.
   * Committing a new search dismisses it, exactly as pressing Import again
   * replaces it, and "Dismiss" clears it by hand.
   */
  const clearPubMedRunSummary = () => {
    setPubmedComplete(false);
    setPubmedImportError(null);
    setPubmedProgress({ current: 0, total: 0 });
    setPubmedResults({ addedIds: [], skippedIds: [], failedIds: [] });
  };

  const pubmedActions = {
    ...pubmedSearch,
    submitSearch: () => {
      clearPubMedRunSummary();
      pubmedSearch.submitSearch();
    },
  };

  const resetAndClose = () => {
    setBulkInput("");
    setBulkRunning(false);
    setBulkProgress({ current: 0, total: 0 });
    setBulkResults({ addedIds: [], skippedIds: [], failedIds: [] });
    setManualData(emptyManualData);
    setParsedFile(null);
    setFileName(null);
    setFileImportRunning(false);
    setFileImportComplete(false);
    setFileImportProgress({ current: 0, total: 0, added: 0, skipped: 0, failed: 0 });
    setSelectedProjectIds([]);
    setSelectedTagIds([]);
    // Transient interaction state must not survive a close/reopen: clear both
    // drop-zone drag overlays so the reopened dialog is in a clean, non-dragging
    // state. Each `AssignmentSelector` owns its own open/search state and is
    // unmounted with the dialog, so it starts closed and unfiltered by itself.
    setIsDragging(false);
    setIsFileDragging(false);
    // Every ephemeral PubMed value: the draft and committed query, the results
    // page, the offset, the total, the selected PMIDs, the search error and the
    // search loading flag (`reset`), plus this tab's import progress and
    // summary. `reset` also bumps the request generation, so a search still in
    // flight when the dialog closes cannot repopulate the reopened dialog.
    pubmedSearch.reset();
    setPubmedRunning(false);
    clearPubMedRunSummary();
    setActiveTab("import");
    onOpenChange(false);
  };

  // ── Continuation resets (per-run only; assignments and tab preserved) ──

  // Identifier-run reset — used by "Import More". Clears only the identifier
  // run so the user can enter a fresh batch. Selected Projects/Tags, the active
  // tab, the manual form and any parsed-file state are intentionally preserved.
  const resetBulkImport = () => {
    setBulkInput("");
    setBulkRunning(false);
    setBulkProgress({ current: 0, total: 0 });
    setBulkResults({ addedIds: [], skippedIds: [], failedIds: [] });
    setIsDragging(false);
  };

  const handleImportMore = () => {
    resetBulkImport();
    // Return focus to the identifier textarea once the ready state re-renders.
    setTimeout(() => bulkInputRef.current?.focus(), 0);
  };

  // File-run reset — used by "Import Another File" and the file-change/Back
  // action. Clears only the file run; selected Projects/Tags and the active tab
  // are preserved.
  const resetFileImport = () => {
    setParsedFile(null);
    setFileName(null);
    setFileImportRunning(false);
    setFileImportComplete(false);
    setFileImportProgress({ current: 0, total: 0, added: 0, skipped: 0, failed: 0 });
    setIsFileDragging(false);
  };

  const handleImportAnotherFile = () => {
    resetFileImport();
    // Return focus to the dropzone once it re-renders.
    setTimeout(() => fileDropzoneRef.current?.focus(), 0);
  };

  const updateManualField = (field: keyof ManualPaperData, value: string) => {
    setManualData((prev) => ({ ...prev, [field]: value }));
  };

  const bulkIds = parseBulkIdentifiers(bulkInput);
  const progressPercent = bulkProgress.total > 0 ? Math.round((bulkProgress.current / bulkProgress.total) * 100) : 0;
  const bulkComplete = !bulkRunning && bulkProgress.total > 0 && bulkProgress.current === bulkProgress.total;
  const fileProgressPercent = fileImportProgress.total > 0 ? Math.round((fileImportProgress.current / fileImportProgress.total) * 100) : 0;
  const pubmedProgressPercent = pubmedProgress.total > 0 ? Math.round((pubmedProgress.current / pubmedProgress.total) * 100) : 0;
  const pubmedSelectedCount = pubmedSearch.selectedPmids.length;
  // A PubMed-selected import is a real library mutation, so it locks the dialog
  // exactly like the identifier and file runs: tabs disabled, close disabled.
  // A read-only PubMed *search* does not — it mutates nothing, and its
  // stale-response guard makes a late response harmless.
  const isAnyRunning = bulkRunning || fileImportRunning || pubmedRunning;

  /**
   * The identifier-run outcome summary, in the ONE vocabulary this application
   * has for an import: Added / Skipped — Duplicates / Failed, each listing the
   * identifiers it applies to.
   *
   * Shared by the Import IDs tab and the PubMed Search tab so a PubMed-selected
   * import can never grow a second, incompatible status vocabulary. Duplicate
   * classification is not decided here or anywhere in the UI: the canonical
   * insert path decides whether a paper was inserted, skipped as a duplicate or
   * failed, and this only reports what it said. Identifiers alone are shown —
   * a failed PMID is never re-labelled with a title taken from stale search
   * results, which could name the wrong paper.
   */
  const renderIdentifierRunSummary = (
    heading: string,
    results: { addedIds: string[]; skippedIds: string[]; failedIds: string[] },
  ) => (
    <div className="rounded-md border border-border bg-muted/50 p-4 space-y-3 max-h-60 overflow-y-auto">
      <p className="font-medium text-sm">{heading}</p>

      {results.addedIds.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" />
            Added ({results.addedIds.length})
          </div>
          <ul className="ml-6 text-xs text-muted-foreground space-y-0.5">
            {results.addedIds.map((id) => (
              <li key={id} className="font-mono">{id}</li>
            ))}
          </ul>
        </div>
      )}

      {results.skippedIds.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-yellow-700 dark:text-yellow-400">
            <AlertTriangle className="h-4 w-4" />
            Skipped — Duplicates ({results.skippedIds.length})
          </div>
          <ul className="ml-6 text-xs text-muted-foreground space-y-0.5">
            {results.skippedIds.map((id) => (
              <li key={id} className="font-mono">{id}</li>
            ))}
          </ul>
        </div>
      )}

      {results.failedIds.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
            <XCircle className="h-4 w-4" />
            Failed ({results.failedIds.length})
          </div>
          <ul className="ml-6 text-xs text-muted-foreground space-y-0.5">
            {results.failedIds.map((id) => (
              <li key={id} className="font-mono">{id}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  // Shared assign-to section rendered in all tabs. The `context` distinguishes
  // configuring the imminent run ("current-import") from configuring the *next*
  // run while a completed run's summary is shown ("next-import"). The selector
  // implementation is identical in both cases — only the heading and helper copy
  // change — so the Project/Tag controls are never duplicated.
  /**
   * The shared assign-on-import section, rendered identically by all four tabs.
   *
   * The section itself now lives in `AssignOnImportSection.tsx` so the
   * `/extension-import` handoff page renders the same selector — same desktop
   * popover, same mobile sheet, same touch-safe focus, same selection
   * semantics. This wrapper only supplies the dialog's own state.
   */
  const renderAssignSection = (context: "current-import" | "next-import") => (
    <AssignOnImportSection
      projects={projects}
      tags={tags}
      selectedProjectIds={selectedProjectIds}
      selectedTagIds={selectedTagIds}
      onToggleProject={toggleProject}
      onToggleTag={toggleTag}
      context={context}
    />
  );

  return (
    <Dialog open={open} onOpenChange={isAnyRunning ? undefined : resetAndClose}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Papers</DialogTitle>
          <DialogDescription>
            Search PubMed, import by identifier, upload a file, or add manually.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "pubmed" | "import" | "file" | "manual")}>
          {/*
            Four modes do not fit one 390px row without either clipping a label
            or hiding one behind a scrollbar nobody can see, so below `sm` the
            list becomes a 2×2 grid instead: `h-auto` releases the primitive's
            fixed `h-10`, every mode keeps its full label and its full-height
            touch target, and no horizontal scrolling is required at any width.
            PubMed Search leads the grid — top-left on a phone, first on a
            desktop — because discovery precedes import, while the DEFAULT tab
            stays Import IDs.
          */}
          <TabsList className="grid w-full h-auto grid-cols-2 gap-1 sm:h-10 sm:grid-cols-4">
            <TabsTrigger
              value="pubmed"
              className={TAB_TRIGGER_CLASS}
              disabled={isAnyRunning}
              // The visible label is already the full one at every width; the
              // explicit accessible name pins it so a future shortening cannot
              // silently rename the mode for assistive technology.
              aria-label="PubMed Search"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
              PubMed Search
            </TabsTrigger>
            <TabsTrigger value="import" className={TAB_TRIGGER_CLASS} disabled={isAnyRunning} aria-label="Import IDs">
              <Upload className="h-4 w-4" aria-hidden="true" />
              Import IDs
            </TabsTrigger>
            <TabsTrigger value="file" className={TAB_TRIGGER_CLASS} disabled={isAnyRunning} aria-label="Import File">
              <FileText className="h-4 w-4" aria-hidden="true" />
              Import File
            </TabsTrigger>
            <TabsTrigger value="manual" className={TAB_TRIGGER_CLASS} disabled={isAnyRunning} aria-label="Manual">
              <PenLine className="h-4 w-4" aria-hidden="true" />
              Manual
            </TabsTrigger>
          </TabsList>

          {/* ── PubMed Search Tab ── */}
          <TabsContent value="pubmed" className="space-y-4 mt-4">
            <PubMedSearchPanel
              state={pubmedSearch}
              actions={pubmedActions}
              searchAvailable={Boolean(onPubMedSearch)}
              importing={pubmedRunning}
              excludedStudyTypes={excludedStudyTypes}
            />

            {/* The SAME shared assign section every other tab renders, driven by
                the SAME `selectedProjectIds` / `selectedTagIds`. After a
                completed run it configures the next one, matching Import IDs. */}
            {!pubmedRunning && renderAssignSection(pubmedComplete ? "next-import" : "current-import")}

            {pubmedRunning && (
              <div className="space-y-3">
                <Progress value={pubmedProgressPercent} className="h-2" />
                <p className="text-sm text-muted-foreground text-center">
                  Processing {pubmedProgress.current} of {pubmedProgress.total}…
                  {pubmedResults.addedIds.length > 0 && <span className="text-foreground"> · {pubmedResults.addedIds.length} added</span>}
                  {pubmedResults.skippedIds.length > 0 && <span className="text-muted-foreground"> · {pubmedResults.skippedIds.length} skipped</span>}
                  {pubmedResults.failedIds.length > 0 && <span className="text-destructive"> · {pubmedResults.failedIds.length} failed</span>}
                </p>
              </div>
            )}

            {pubmedImportError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm font-medium text-destructive"
              >
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 break-words">{pubmedImportError}</span>
              </div>
            )}

            {pubmedComplete && renderIdentifierRunSummary("PubMed Import Results", pubmedResults)}

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={resetAndClose} disabled={pubmedRunning}>
                {pubmedRunning ? "Running…" : "Close"}
              </Button>
              {(pubmedComplete || pubmedImportError) && (
                <Button variant="ghost" onClick={clearPubMedRunSummary}>
                  Dismiss results
                </Button>
              )}
              {/* The canonical handoff. Only `pubmedSearch.selectedPmids` — the
                  PMID strings — reach `onBulkImport`, together with the shared
                  assignment options. */}
              <Button
                onClick={handlePubMedImport}
                disabled={pubmedRunning || pubmedSelectedCount === 0 || !onBulkImport}
              >
                {pubmedRunning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import {pubmedSelectedCount > 0 ? `${pubmedSelectedCount} Selected` : "Selected"}
              </Button>
            </div>
          </TabsContent>

          {/* ── Import IDs Tab ── */}
          <TabsContent value="import" className="space-y-4 mt-4">
            {/* Source input — hidden in completed state so the already-processed
                identifier batch cannot be accidentally re-imported. */}
            {!bulkComplete && (
            <div className="space-y-2">
              <Label htmlFor="bulk-identifiers">
                Paste PMIDs or DOIs, or drop a .txt/.csv file
              </Label>
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`relative rounded-md transition-colors ${
                  isDragging
                    ? "ring-2 ring-primary bg-primary/5"
                    : ""
                }`}
              >
                {isDragging && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/10 pointer-events-none">
                    <FileUp className="h-8 w-8 text-primary mb-1" />
                    <span className="text-sm font-medium text-primary">Drop .txt or .csv file</span>
                  </div>
                )}
                <Textarea
                  ref={bulkInputRef}
                  id="bulk-identifiers"
                  placeholder={`Paste your list of identifiers here, or drag & drop a .txt/.csv file:
38237512
37654321, 36543210
10.1000/xyz123
https://doi.org/10.1016/j.example.2024.01.001`}
                  value={bulkInput}
                  onChange={(e) => setBulkInput(e.target.value)}
                  rows={6}
                  disabled={bulkRunning}
                />
              </div>
              {bulkIds.length > 0 && !bulkRunning && !bulkComplete && (
                <p className="text-sm text-muted-foreground">
                  {bulkIds.length} identifier{bulkIds.length !== 1 ? "s" : ""} detected
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Title-based import may match the wrong paper. PMID/DOI import is more reliable.
              </p>
            </div>
            )}

            {/* Assign to project/tags — configures the imminent run */}
            {!bulkRunning && !bulkComplete && renderAssignSection("current-import")}

            {bulkRunning && (
              <div className="space-y-3">
                <Progress value={progressPercent} className="h-2" />
                <p className="text-sm text-muted-foreground text-center">
                  Processing {bulkProgress.current} of {bulkProgress.total}…
                  {bulkResults.addedIds.length > 0 && <span className="text-foreground"> · {bulkResults.addedIds.length} added</span>}
                  {bulkResults.skippedIds.length > 0 && <span className="text-muted-foreground"> · {bulkResults.skippedIds.length} skipped</span>}
                  {bulkResults.failedIds.length > 0 && <span className="text-destructive"> · {bulkResults.failedIds.length} failed</span>}
                </p>
              </div>
            )}

            {bulkComplete && renderIdentifierRunSummary("Import Results Summary", bulkResults)}

            {/* After completion the assignment controls configure the NEXT run,
                not the completed one. */}
            {bulkComplete && renderAssignSection("next-import")}

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={resetAndClose} disabled={bulkRunning}>
                {bulkRunning ? "Running…" : (bulkComplete ? "Close" : "Cancel")}
              </Button>
              {bulkComplete ? (
                <Button onClick={handleImportMore}>Import More</Button>
              ) : (
                <Button
                  onClick={handleBulkImport}
                  disabled={bulkRunning || bulkIds.length === 0 || !onBulkImport}
                >
                  {bulkRunning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Import {bulkIds.length > 0 ? `${bulkIds.length} Paper${bulkIds.length !== 1 ? "s" : ""}` : "Papers"}
                </Button>
              )}
            </div>
          </TabsContent>

          {/* ── Import File Tab ── */}
          <TabsContent value="file" className="space-y-4 mt-4">
            {!parsedFile && !fileImportRunning && (
              <div
                ref={fileDropzoneRef}
                role="button"
                tabIndex={0}
                aria-label="Choose a file to import"
                onDragOver={handleFileDragOver}
                onDragLeave={handleFileDragLeave}
                onDrop={handleFileDrop}
                className={cn(
                  "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors cursor-pointer",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  isFileDragging
                    ? "border-primary bg-primary/5"
                    : "border-muted-foreground/25 hover:border-muted-foreground/50"
                )}
                onClick={openFilePicker}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openFilePicker();
                  }
                }}
              >
                <FileUp className={cn("h-10 w-10 mb-3", isFileDragging ? "text-primary" : "text-muted-foreground")} />
                <p className="text-sm font-medium mb-1">
                  {isFileDragging ? "Drop your file here" : "Drop a file or click to browse"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Supports .bib (BibTeX), .ris (RIS), .nbib (PubMed), .enw (EndNote), .csv
                </p>
                <input
                  id="file-import-input"
                  type="file"
                  accept={ACCEPTED_FILE_EXTENSIONS.join(",")}
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </div>
            )}

            {/* Parsed file preview */}
            {parsedFile && !fileImportRunning && !fileImportComplete && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{fileName}</span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={resetFileImport} className="h-7 text-xs">
                    Change file
                  </Button>
                </div>

                {parsedFile.papers.length > 0 && (
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="text-sm font-medium text-green-700 dark:text-green-400 mb-2">
                      <CheckCircle2 className="h-4 w-4 inline mr-1" />
                      Found {parsedFile.papers.length} paper{parsedFile.papers.length !== 1 ? "s" : ""}
                    </p>

                    {/* Preview table — first 5 papers */}
                    <div className="rounded border bg-background max-h-40 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b bg-muted/50">
                            <th className="text-left p-1.5 font-medium">#</th>
                            <th className="text-left p-1.5 font-medium">Title</th>
                            <th className="text-left p-1.5 font-medium">Year</th>
                            <th className="text-left p-1.5 font-medium">Authors</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parsedFile.papers.slice(0, 5).map((p, i) => (
                            <tr key={i} className="border-b last:border-0">
                              <td className="p-1.5 text-muted-foreground">{i + 1}</td>
                              <td className="p-1.5 max-w-[200px] truncate">{p.title}</td>
                              <td className="p-1.5 text-muted-foreground">{p.year ?? "—"}</td>
                              <td className="p-1.5 text-muted-foreground max-w-[120px] truncate">
                                {p.authors.length > 0 ? p.authors[0] + (p.authors.length > 1 ? ` +${p.authors.length - 1}` : "") : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {parsedFile.papers.length > 5 && (
                        <p className="text-xs text-muted-foreground text-center py-1.5">
                          … and {parsedFile.papers.length - 5} more
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Warnings */}
                {parsedFile.warnings.length > 0 && (
                  <div className="rounded-md border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/30 p-3 space-y-1">
                    <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400 flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4" />
                      {parsedFile.warnings.length} warning{parsedFile.warnings.length !== 1 ? "s" : ""}
                    </p>
                    <ul className="text-xs text-yellow-600 dark:text-yellow-500 space-y-0.5 ml-5 list-disc">
                      {parsedFile.warnings.slice(0, 5).map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                      {parsedFile.warnings.length > 5 && (
                        <li className="text-muted-foreground">… and {parsedFile.warnings.length - 5} more</li>
                      )}
                    </ul>
                  </div>
                )}

                {/* Assign to project/tags */}
                {parsedFile.papers.length > 0 && renderAssignSection("current-import")}
              </div>
            )}

            {/* Progress during import */}
            {fileImportRunning && (
              <div className="space-y-3">
                <Progress value={fileProgressPercent} className="h-2" />
                <p className="text-sm text-muted-foreground text-center">
                  Importing {fileImportProgress.current} of {fileImportProgress.total}…
                  {fileImportProgress.added > 0 && <span className="text-foreground"> · {fileImportProgress.added} added</span>}
                  {fileImportProgress.skipped > 0 && <span className="text-muted-foreground"> · {fileImportProgress.skipped} skipped</span>}
                  {fileImportProgress.failed > 0 && <span className="text-destructive"> · {fileImportProgress.failed} failed</span>}
                </p>
              </div>
            )}

            {/* Import complete summary */}
            {fileImportComplete && (
              <div className="rounded-md border border-border bg-muted/50 p-4 space-y-2">
                <p className="font-medium text-sm">File Import Results</p>
                <div className="flex items-center gap-4 text-sm">
                  {fileImportProgress.added > 0 && (
                    <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
                      <CheckCircle2 className="h-4 w-4" />
                      {fileImportProgress.added} added
                    </span>
                  )}
                  {fileImportProgress.skipped > 0 && (
                    <span className="flex items-center gap-1 text-yellow-700 dark:text-yellow-400">
                      <AlertTriangle className="h-4 w-4" />
                      {fileImportProgress.skipped} skipped
                    </span>
                  )}
                  {fileImportProgress.failed > 0 && (
                    <span className="flex items-center gap-1 text-destructive">
                      <XCircle className="h-4 w-4" />
                      {fileImportProgress.failed} failed
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* After completion the assignment controls configure the NEXT file
                import, not the completed one. */}
            {fileImportComplete && renderAssignSection("next-import")}

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={fileImportComplete ? resetAndClose : (parsedFile ? resetFileImport : resetAndClose)} disabled={fileImportRunning}>
                {fileImportRunning ? "Running…" : (fileImportComplete ? "Close" : (parsedFile ? "Back" : "Cancel"))}
              </Button>
              {fileImportComplete ? (
                <Button onClick={handleImportAnotherFile}>Import Another File</Button>
              ) : (
                parsedFile && parsedFile.papers.length > 0 && (
                  <Button
                    onClick={handleFileImport}
                    disabled={fileImportRunning || !onFileImport}
                  >
                    {fileImportRunning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Import {parsedFile.papers.length} Paper{parsedFile.papers.length !== 1 ? "s" : ""}
                  </Button>
                )
              )}
            </div>
          </TabsContent>

          {/* ── Manual Tab — 2-Column Layout ── */}
          <TabsContent value="manual" className="space-y-4 mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Column 1: Metadata */}
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="manual-title">Title *</Label>
                  <Input
                    id="manual-title"
                    placeholder="Paper title"
                    value={manualData.title}
                    onChange={(e) => updateManualField("title", e.target.value)}
                    disabled={loading}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="manual-authors">Authors (comma-separated)</Label>
                    <Input
                      id="manual-authors"
                      placeholder="Smith J, Doe A"
                      value={manualData.authors}
                      onChange={(e) => updateManualField("authors", e.target.value)}
                      disabled={loading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="manual-year">Year</Label>
                    <Input
                      id="manual-year"
                      placeholder="2024"
                      value={manualData.year}
                      onChange={(e) => updateManualField("year", e.target.value)}
                      disabled={loading}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="manual-journal">Journal</Label>
                  <Input
                    id="manual-journal"
                    placeholder="Journal of Example Studies"
                    value={manualData.journal}
                    onChange={(e) => updateManualField("journal", e.target.value)}
                    disabled={loading}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="manual-pmid">PMID</Label>
                    <Input
                      id="manual-pmid"
                      placeholder="12345678"
                      value={manualData.pmid}
                      onChange={(e) => updateManualField("pmid", e.target.value)}
                      disabled={loading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="manual-doi">DOI</Label>
                    <Input
                      id="manual-doi"
                      placeholder="10.1000/xyz123"
                      value={manualData.doi}
                      onChange={(e) => updateManualField("doi", e.target.value)}
                      disabled={loading}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="manual-keywords">Keywords (comma-separated)</Label>
                  <Input
                    id="manual-keywords"
                    placeholder="keyword1, keyword2, keyword3"
                    value={manualData.keywords}
                    onChange={(e) => updateManualField("keywords", e.target.value)}
                    disabled={loading}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="manual-drive" className="flex items-center gap-2">
                    <LinkIcon className="h-4 w-4" />
                    Google Drive Link (optional)
                  </Label>
                  <Input
                    id="manual-drive"
                    placeholder="https://drive.google.com/file/d/..."
                    value={manualData.driveUrl}
                    onChange={(e) => updateManualField("driveUrl", e.target.value)}
                    disabled={loading}
                  />
                </div>
              </div>

              {/* Column 2: Categorization */}
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="manual-abstract">Abstract</Label>
                  <Textarea
                    id="manual-abstract"
                    placeholder="Paper abstract..."
                    value={manualData.abstract}
                    onChange={(e) => updateManualField("abstract", e.target.value)}
                    rows={5}
                    disabled={loading}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="manual-pubmedUrl">PubMed URL</Label>
                  <Input
                    id="manual-pubmedUrl"
                    placeholder="https://pubmed.ncbi.nlm.nih.gov/..."
                    value={manualData.pubmedUrl}
                    onChange={(e) => updateManualField("pubmedUrl", e.target.value)}
                    disabled={loading}
                  />
                </div>

                {/* Assign to project/tags */}
                {renderAssignSection("current-import")}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={resetAndClose} disabled={loading}>
                Cancel
              </Button>
              <Button onClick={handleManualSubmit} disabled={loading || !manualData.title.trim() || !onSubmitManual}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Paper
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
