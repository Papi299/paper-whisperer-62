import { useState, useMemo, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { usePapers } from "@/hooks/usePapers";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { useStudyTypeReevaluation } from "@/hooks/useStudyTypeReevaluation";
import { useKeywordReevaluation } from "@/hooks/useKeywordReevaluation";
import { useFilterState } from "@/hooks/useFilterState";
import {
  useFilterPresets,
  applyPreset,
  arePresetPayloadsEqual,
  buildPresetPayload,
  type FilterPreset,
  type PresetPayload,
} from "@/hooks/useFilterPresets";
import { useExportPapers } from "@/hooks/useExportPapers";
import { useAnalyticsData } from "@/hooks/useAnalyticsData";
import { useAnalyticsTargets } from "@/hooks/useAnalyticsTargets";
import { useAuthorIdentities } from "@/hooks/useAuthorIdentities";
import { useBulkSelection } from "@/hooks/useBulkSelection";
import { Sidebar } from "@/components/layout/Sidebar";
import { PaperList } from "@/components/papers/PaperList";
import { BulkActionsToolbar } from "@/components/papers/BulkActionsToolbar";
import { AddPaperDialog } from "@/components/papers/AddPaperDialog";
import { EditPaperDialog } from "@/components/papers/EditPaperDialog";
import { EditProjectDialog } from "@/components/projects/EditProjectDialog";
import { EditTagDialog } from "@/components/tags/EditTagDialog";
import { SearchFilters } from "@/components/papers/SearchFilters";
import type { FilterPresetsMenuProps } from "@/components/papers/FilterPresetsMenu";
import { ColumnVisibilityDropdown } from "@/components/papers/ColumnVisibilityDropdown";
import { DeduplicationDialog } from "@/components/papers/DeduplicationDialog";
import { Button } from "@/components/ui/button";
import { PaperWithTags, PaperAttachment, Project, Tag } from "@/types/database";
import { Plus, Loader2, Layers } from "lucide-react";
import { NormalizationConfig } from "@/lib/normalizePaperData";
import { usePaperAnalysisActions } from "@/hooks/usePaperAnalysisActions";
import { useAiQuota } from "@/hooks/useAiQuota";
import { AnalyticsPanel } from "@/components/papers/AnalyticsPanel";
import { AiQuotaIndicator } from "@/components/papers/AiQuotaIndicator";
import { MobileDashboardControls } from "@/components/papers/MobileDashboardControls";
import { MobileAnalyticsSheet } from "@/components/papers/MobileAnalyticsSheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { PoolsProvider, usePools } from "@/contexts/PoolsContext";

/**
 * Outer Dashboard shell: handles auth redirect and provides PoolsProvider.
 */
export function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth", { replace: true });
    }
  }, [user, authLoading, navigate]);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <PoolsProvider userId={user.id}>
      <DashboardContent />
    </PoolsProvider>
  );
}

/**
 * Inner Dashboard content: consumes pool data from PoolsContext.
 */
function DashboardContent() {
  const { user } = useAuth();
  // `user` from `useAuth()` is `User | null`. The outer `Dashboard` component
  // already short-circuits with `if (!user) return null;` before mounting
  // `DashboardContent`, but `useAuth()` can yield `user === null` on an
  // intermediate render during a sign-out / sign-in transition. Every read
  // inside this component MUST go through `userId` (the nullable-safe
  // alias) — never `user.id` or `user!.id` — so transient null values are
  // handled gracefully instead of crashing the page. Hotfix for the
  // `Cannot read properties of null (reading 'id')` crash introduced by
  // PR #135's two direct `user.id` reads (the analyze hook + PaperList).
  const userId = user?.id;
  const { toast } = useToast();

  // Pool data from context
  const {
    poolKeywords,
    findMatchingKeywords,
    synonymGroups,
    normalizeKeyword,
    synonymLookup,
    poolStudyTypes,
    deleteStudyType: deletePoolStudyType,
    deleteAllStudyTypes: deleteAllPoolStudyTypes,
    excludedKeywords,
    addExcludedKeyword,
    addExcludedStudyType,
    getExcludedKeywordSet,
    getExcludedStudyTypeSet,
  } = usePools();

  // Build normalization config from pool data
  const normalizationConfig = useMemo<NormalizationConfig>(() => ({
    synonymLookup: synonymLookup || {},
    poolStudyTypes: poolStudyTypes.map(st => ({
      study_type: st.study_type,
      specificity_weight: st.specificity_weight,
      hierarchy_rank: st.hierarchy_rank,
    })),
    poolKeywords: poolKeywords.map(pk => pk.keyword),
    synonymGroups: synonymGroups.map(sg => ({
      canonical_term: sg.canonical_term,
      synonyms: sg.synonyms,
    })),
  }), [synonymLookup, poolStudyTypes, poolKeywords, synonymGroups]);

  // ── Step 1: Filter state (no papers dependency) ──
  const {
    serverFilterParams,
    serverSortParams,
    searchQuery,
    setSearchQuery,
    yearFrom,
    setYearFrom,
    yearTo,
    setYearTo,
    studyType,
    setStudyType,
    notesPresence,
    setNotesPresence,
    selectedKeywords,
    setSelectedKeywords,
    selectedProjectIds,
    replaceSelectedProjectIds,
    handleProjectToggle,
    clearProjects,
    projectMatchMode,
    setProjectMatchMode,
    selectedTagIds,
    replaceSelectedTagIds,
    handleTagToggle,
    clearTags,
    tagMatchMode,
    setTagMatchMode,
    studyTypeFilterOptions,
    sortKey,
    sortDirection,
    handleSort,
    handleKeywordToggle,
    clearFilters,
    hasActiveFilters,
    searchMatchFlags,
  } = useFilterState({ poolStudyTypes, userId: user?.id });

  // ── Step 2: Papers (receives server params — already sorted by server) ──
  const {
    papers,
    projects,
    tags,
    loading,
    tagsLoading,
    projectsLoading,
    allKeywords,
    allStudyTypes,
    totalCount,
    isTotalCountAuthoritative,
    filteredCount,
    allFilteredIds,
    serverKeywordOptions,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    createProject,
    updateProject,
    deleteProject,
    createTag,
    updateTag,
    deleteTag,
    addPaperManually,
    bulkImportPapers,
    bulkImportFromParsedData,
    updatePaper,
    deletePaper,
    bulkDeletePapers,
    bulkSetProjects,
    bulkSetTags,
    reevaluateStudyTypes,
    reevaluateKeywords,
    updatePapersCache,
  } = usePapers(user?.id, serverFilterParams, serverSortParams, normalizationConfig);

  // ── Step 3: Dedicated export fetch (bypasses paginated display query) ──
  const { exportPapers, isExporting, isExportReady } = useExportPapers({
    userId: user?.id,
    serverFilterParams,
    serverSortParams,
    tags,
    projects,
    tagsLoading,
    projectsLoading,
  });

  // ── Saved Searches / Filter Presets (list + create + delete + update + rename) ──
  const {
    presets,
    isLoading: presetsLoading,
    isSaving: presetsSaving,
    isUpdating: presetsUpdating,
    isRenaming: presetsRenaming,
    savePreset,
    deletePreset,
    updatePreset,
    renamePreset,
  } = useFilterPresets({ userId: user?.id });

  /**
   * Tracks which preset (if any) is currently "loaded" — i.e. which preset
   * the user most recently restored or just created. Powers the Update action
   * in the Presets menu so it always targets a specific preset by id (never
   * by name lookup, which could collide). Cleared when the user clears
   * filters or deletes the loaded preset.
   *
   * Intentionally NOT cleared when the user edits filters after loading —
   * the whole point of Update is to re-save those edits into the same row.
   */
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null);
  const loadedPreset = useMemo(
    () => (loadedPresetId ? presets.find((p) => p.id === loadedPresetId) ?? null : null),
    [loadedPresetId, presets],
  );

  /** Build the payload to persist from the current filter state. */
  const getCurrentPresetPayload = useCallback((): PresetPayload => {
    return buildPresetPayload({
      searchQuery,
      yearFrom,
      yearTo,
      studyType,
      notesPresence,
      selectedKeywords,
      selectedProjectIds,
      selectedTagIds,
      projectMatchMode,
      tagMatchMode,
    });
  }, [
    searchQuery,
    yearFrom,
    yearTo,
    studyType,
    notesPresence,
    selectedKeywords,
    selectedProjectIds,
    selectedTagIds,
    projectMatchMode,
    tagMatchMode,
  ]);

  /**
   * Derived "unsaved changes relative to the loaded preset" signal. `true`
   * when a preset is loaded AND the current filter state differs from that
   * preset's stored payload (`selectedKeywords`, `selectedProjectIds` and
   * `selectedTagIds` are compared with order-insensitive, duplicate-insensitive
   * set semantics; the scalar fields are compared exactly). Purely derived —
   * no new state, no effects.
   *
   * When no preset is loaded, this is `false` by definition (there is
   * nothing to be dirty relative to). The Presets dropdown uses this to
   * render a dot on its trigger and to disable `Update "<name>"` when clean.
   */
  const isLoadedPresetDirty = useMemo(
    () =>
      loadedPreset ? !arePresetPayloadsEqual(loadedPreset.payload, getCurrentPresetPayload()) : false,
    [loadedPreset, getCurrentPresetPayload],
  );

  /**
   * Full-replacement preset load. Runs the stale-ID guard in `applyPreset`
   * and surfaces a toast if the saved project or tag no longer exists.
   * Sort state is intentionally left untouched — it is a view concern.
   * Marks this preset as the currently-loaded one so the Update action knows
   * which row to overwrite when the user re-saves after tweaking filters.
   */
  const handleLoadPreset = useCallback(
    (preset: FilterPreset) => {
      const result = applyPreset(
        preset.payload,
        {
          setSearchQuery,
          setYearFrom,
          setYearTo,
          setStudyType,
          setNotesPresence,
          setSelectedKeywords,
          setSelectedProjectIds: replaceSelectedProjectIds,
          setSelectedTagIds: replaceSelectedTagIds,
          setProjectMatchMode,
          setTagMatchMode,
        },
        projects,
        tags,
      );

      setLoadedPresetId(preset.id);

      if (result.droppedProjectCount > 0 || result.droppedTagCount > 0) {
        const parts: string[] = [];
        if (result.droppedProjectCount > 0) {
          parts.push(`${result.droppedProjectCount} project${result.droppedProjectCount !== 1 ? "s" : ""}`);
        }
        if (result.droppedTagCount > 0) {
          parts.push(`${result.droppedTagCount} tag${result.droppedTagCount !== 1 ? "s" : ""}`);
        }
        toast({
          title: "Preset loaded with missing references",
          description: `${parts.join(" and ")} saved in "${preset.name}" no longer ${
            result.droppedProjectCount + result.droppedTagCount === 1 ? "exists" : "exist"
          } — skipped.`,
        });
      } else {
        toast({
          title: "Preset loaded",
          description: `"${preset.name}" is now active.`,
        });
      }
    },
    [
      projects,
      tags,
      setSearchQuery,
      setYearFrom,
      setYearTo,
      setStudyType,
      setNotesPresence,
      setSelectedKeywords,
      replaceSelectedProjectIds,
      replaceSelectedTagIds,
      setProjectMatchMode,
      setTagMatchMode,
      toast,
    ],
  );

  /**
   * Wrap `savePreset` so the newly-created preset becomes the currently-loaded
   * one. This makes the create → tweak → update flow work without an extra
   * Load click. Returns the same boolean shape the dialog already expects.
   */
  const handleSavePreset = useCallback(
    async (name: string, payload: PresetPayload): Promise<boolean> => {
      const created = await savePreset(name, payload);
      if (!created) return false;
      setLoadedPresetId(created.id);
      return true;
    },
    [savePreset],
  );

  /**
   * Wrap `deletePreset` so deleting the currently-loaded preset clears the
   * loaded-id state — otherwise the Update action would point at a row that
   * no longer exists.
   */
  const handleDeletePreset = useCallback(
    async (preset: Pick<FilterPreset, "id" | "name">): Promise<void> => {
      await deletePreset(preset);
      setLoadedPresetId((current) => (current === preset.id ? null : current));
    },
    [deletePreset],
  );

  /**
   * Update the currently-loaded preset's payload with the current dashboard
   * state. No-op if nothing is loaded (the menu item is also hidden in that
   * case, so this is a defensive guard).
   */
  const handleUpdateLoadedPreset = useCallback(async (): Promise<boolean> => {
    if (!loadedPreset) return false;
    return await updatePreset(
      { id: loadedPreset.id, name: loadedPreset.name },
      getCurrentPresetPayload(),
    );
  }, [loadedPreset, updatePreset, getCurrentPresetPayload]);

  /**
   * Wrap `clearFilters` so clearing the dashboard also clears the
   * "currently loaded" pointer — once the filters are zeroed out, no preset
   * is meaningfully "loaded" anymore.
   */
  const handleClearFilters = useCallback(() => {
    clearFilters();
    setLoadedPresetId(null);
  }, [clearFilters]);

  // ── Step 4: Dedicated analytics fetch (bypasses paginated display query) ──
  const [isAnalyticsOpen, setIsAnalyticsOpen] = useState(false);
  const { papers: analyticsPapers, isLoading: isAnalyticsLoading } = useAnalyticsData({
    userId: user?.id,
    serverFilterParams,
    serverSortParams,
    enabled: isAnalyticsOpen,
  });
  /**
   * Analytics target selections live here, alongside `isAnalyticsOpen`, for the
   * same reason: analytics is rendered by two mutually exclusive shells chosen
   * by viewport width, so anything either shell owned would be thrown away the
   * moment the user crossed 768px. Both receive this one state.
   */
  const analyticsTargets = useAnalyticsTargets();

  /**
   * The user's author-identity decisions (AUTHOR-IDENTITY-RESOLUTION-001C).
   *
   * Owned here for the same reason the target selections are: both analytics
   * shells must group authors identically, and a dataset fetched inside either
   * one would be refetched — and could momentarily differ — across the 768px
   * breakpoint. It is also what the identity manager reads and writes.
   *
   * `dataset` is `null` when the 001C schema is not installed in this
   * environment, which every consumer treats as "no identity information" and
   * falls back to 001A textual grouping for. Nothing else on the dashboard
   * depends on it, so an unavailable identity subsystem costs the user the
   * identity features and nothing more.
   */
  const authorIdentities = useAuthorIdentities(userId);

  // Study type re-evaluation on pool changes
  const {
    handleStudyTypePoolModalClose,
    handleDeletePoolStudyType,
    handleDeleteAllPoolStudyTypes,
  } = useStudyTypeReevaluation({
    poolStudyTypes,
    reevaluateStudyTypes,
    deleteStudyType: deletePoolStudyType,
    deleteAllStudyTypes: deleteAllPoolStudyTypes,
  });

  // Keyword re-evaluation on keyword/synonym pool changes (dirty-flag gated)
  const {
    markDirty: markKeywordPoolDirty,
    handlePoolModalClose: handleKeywordPoolModalClose,
  } = useKeywordReevaluation({
    normalizationConfig,
    reevaluateKeywords,
  });

  // Column visibility & widths
  const { visibleColumns, toggleColumn, availableColumns } = useColumnVisibility();
  const { columnWidths, setColumnWidth } = useColumnWidths();

  /**
   * Which control layout the Dashboard composes.
   *
   * Mobile and desktop are composed conditionally rather than both being
   * rendered with one hidden by CSS: the two layouts contain the same search
   * field, the same Add action and the same filter controls, so rendering both
   * would put duplicate ids and duplicate controls in the DOM.
   */
  const isMobile = useIsMobile();

  // Filter available keywords: server-side keyword options + pool keywords, apply synonym mapping, exclude, deduplicate
  const filteredKeywords = useMemo(() => {
    const allTerms = [
      ...(serverKeywordOptions ?? []),
      ...poolKeywords.map(pk => pk.keyword),
    ];

    const mappedTerms = allTerms.map(term => {
      const canonical = synonymLookup[term.toLowerCase()];
      return canonical || term;
    });

    const excludedSet = new Set(excludedKeywords.map(ek => ek.keyword.toLowerCase()));

    return Array.from(new Set(mappedTerms))
      .filter(kw => !excludedSet.has(kw.toLowerCase()))
      .sort();
  }, [serverKeywordOptions, excludedKeywords, synonymLookup, poolKeywords]);

  // Bulk selection (server-sorted + server-filtered)
  const {
    selectedPaperIds,
    isSelectAllReady,
    handleToggleSelect,
    handleToggleSelectAll,
    handleClearSelection,
    handleBulkDelete,
    handleBulkSetProjects,
    handleBulkSetTags,
  } = useBulkSelection({
    papers: papers,
    allFilteredIds,
    bulkDeletePapers,
    bulkSetProjects,
    bulkSetTags,
  });

  // Dialog state
  const [addPaperOpen, setAddPaperOpen] = useState(false);
  const [dedupOpen, setDedupOpen] = useState(false);
  /**
   * Whether the deduplication dialog has ever been opened.
   *
   * It is mounted lazily (it auto-scans on open, so mounting it up front would
   * be wasted work) but, once mounted, it STAYS mounted. Unmounting it the
   * instant `open` flipped to false — which is what `{dedupOpen && …}` did —
   * tore the Radix content out of the tree before its close lifecycle could
   * run, so `onCloseAutoFocus` never fired, the focus-restore helper never got
   * its turn, and focus fell to `<body>`. Keeping it mounted costs nothing: the
   * scan effect is gated on `open`.
   */
  const [dedupMounted, setDedupMounted] = useState(false);
  const openDedup = useCallback(() => {
    setDedupMounted(true);
    setDedupOpen(true);
  }, []);
  /**
   * Narrow-screen navigation drawer. Owned here rather than inside `Sidebar`
   * because the trigger has to live in this header — below `md` the rail is
   * `display:none` and cannot host a control of its own.
   */
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [editingPaper, setEditingPaper] = useState<PaperWithTags | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  // AI-analysis orchestration extracted into a dedicated hook in PR #119.
  // The hook owns state (`analyzingPaperId`, `bulkAnalyzing`,
  // `bulkAnalyzeProgress`) and both async handlers (`handleAnalyzePaper`,
  // `handleBulkAnalyze`); pure merge / payload logic lives in
  // `src/lib/studyTypeUtils.ts` (PR #117).
  // Read-only AI-analysis quota status (used/remaining, lifetime vs monthly).
  // Fails soft: if this query errors the indicator hides and analysis is NOT
  // blocked — the server 402 remains the enforcement boundary.
  const {
    status: aiQuotaStatus,
    isLoading: aiQuotaLoading,
    isError: aiQuotaError,
  } = useAiQuota(userId);

  // The manager-facing Gemini provider-quota panel is deferred under owner
  // decision C29 (Gemini Free Tier during development; automatic provider-quota
  // monitoring paused until commercialization). The Dashboard therefore neither
  // renders the card nor invokes the provider-quota Edge Function. That deployed
  // function and the `useCurrentUserAccess` role model remain as deferred
  // infrastructure for reactivation. See docs/decisions-and-triggers.md (C29).

  const {
    analyzingPaperId,
    bulkAnalyzing,
    bulkAnalyzeProgress,
    handleAnalyzePaper,
    handleBulkAnalyze,
  } = usePaperAnalysisActions({
    papers,
    selectedPaperIds,
    userId,
    updatePaper,
    quotaStatus: aiQuotaStatus,
  });

  const handleAttachmentsChange = useCallback((paperId: string, atts: PaperAttachment[]) => {
    updatePapersCache((all) =>
      all.map((p) => (p.id === paperId ? { ...p, paper_attachments: atts } : p))
    );
  }, [updatePapersCache]);

  const handleSavePaper = async (
    updates: Partial<PaperWithTags> & { tagIds: string[] }
  ): Promise<boolean> => {
    // Forward the boolean from `usePaperMutations.updatePaper` so
    // `EditPaperDialog` can keep the dialog open + preserve edited values
    // when any underlying write fails. If there is no `editingPaper` we have
    // nothing to persist; resolving `false` here keeps the dialog open
    // defensively (the menu UX should never reach this state).
    if (!editingPaper) return false;
    if (updates.keywords && Array.isArray(updates.keywords)) {
      const mapped = updates.keywords.map(kw => {
        const canonical = synonymLookup[kw.toLowerCase()];
        return canonical || kw;
      });
      const seen = new Set<string>();
      updates.keywords = mapped.filter(kw => {
        const lower = kw.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    }
    return await updatePaper(editingPaper.id, updates);
  };

  if (loading && papers.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Saved Searches / Filter Presets bundle — passed as a single prop to
  // <SearchFilters /> which spreads it into <FilterPresetsMenu />. Typed
  // against `FilterPresetsMenuProps` so TS enforces field-for-field
  // alignment with the menu's contract. The five rename mappings
  // (e.g. `isLoading: presetsLoading`, `getCurrentPayload:
  // getCurrentPresetPayload`) live here in one place rather than being
  // duplicated across SearchFilters' prop interface and JSX.
  const filterPresets: FilterPresetsMenuProps = {
    presets,
    isLoading: presetsLoading,
    isSaving: presetsSaving,
    isUpdating: presetsUpdating,
    isRenaming: presetsRenaming,
    loadedPreset,
    isLoadedPresetDirty,
    getCurrentPayload: getCurrentPresetPayload,
    onSave: handleSavePreset,
    onLoad: handleLoadPreset,
    onDelete: handleDeletePreset,
    onUpdateLoaded: handleUpdateLoadedPreset,
    onRename: renamePreset,
  };

  // Every non-search filter control, in one bundle. The desktop toolbar and the
  // mobile Filters sheet both render `<FilterControls>` from exactly this
  // object, so neither presentation can offer a filter the other lacks or wire
  // one to a different handler.
  const filterControlProps = {
    yearFrom,
    yearTo,
    onYearFromChange: setYearFrom,
    onYearToChange: setYearTo,
    studyType,
    onStudyTypeChange: setStudyType,
    studyTypeFilterOptions,
    notesPresence,
    onNotesPresenceChange: setNotesPresence,
    selectedKeywords,
    availableKeywords: filteredKeywords,
    onKeywordToggle: handleKeywordToggle,
    projects,
    tags,
    selectedProjectIds,
    selectedTagIds,
    onProjectToggle: handleProjectToggle,
    onTagToggle: handleTagToggle,
    onClearProjects: clearProjects,
    onClearTags: clearTags,
    projectMatchMode,
    tagMatchMode,
    onProjectMatchModeChange: setProjectMatchMode,
    onTagMatchModeChange: setTagMatchMode,
  };

  const countLabel = hasActiveFilters
    ? `${filteredCount} of ${totalCount} papers`
    : `${totalCount} paper${totalCount !== 1 ? "s" : ""}`;

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <Sidebar
        projects={projects}
        tags={tags}
        onCreateProject={createProject}
        onCreateTag={createTag}
        onEditProject={(p) => setEditingProject(p)}
        onDeleteProject={deleteProject}
        onEditTag={(t) => setEditingTag(t)}
        onDeleteTag={deleteTag}
        availableKeywords={allKeywords}
        availableStudyTypes={allStudyTypes}
        onDeletePoolStudyType={handleDeletePoolStudyType}
        onDeleteAllPoolStudyTypes={handleDeleteAllPoolStudyTypes}
        onStudyTypePoolModalClose={handleStudyTypePoolModalClose}
        onKeywordPoolChange={markKeywordPoolDirty}
        onKeywordPoolModalClose={handleKeywordPoolModalClose}
        mobileNavOpen={mobileNavOpen}
        onMobileNavOpenChange={setMobileNavOpen}
      />
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
        {/* This region is `shrink-0` inside an `overflow-hidden` main, so
            until now nothing in the ancestor chain owned a vertical scroll:
            once it grew past the viewport — which only the expanded Analytics
            Collapsible does — the excess was simply clipped and unreachable.
            Measured on this branch's parent at 1024×768: the region wanted
            822px of a 768px main, and the whole paper table sat below the fold
            with no way to scroll to any of it.

            `max-h-[85%] overflow-y-auto` makes it an explicit, bounded scroll
            owner: expanded Analytics is always reachable by scrolling *within*
            the header region, the document itself still never scrolls, and the
            15% floor keeps the table it belongs to on screen instead of being
            pushed to zero height. Below 85% — every viewport with Analytics
            collapsed, and every desktop tall enough to fit it expanded — no
            scrollbar appears and nothing about the layout changes.

            Mobile (<768px) renders `MobileDashboardControls` here and puts
            Analytics in `MobileAnalyticsSheet`, which owns its own bounded
            scroll region; this compact stack never approaches 85%. */}
        <div
          data-testid="dashboard-controls"
          className="flex flex-col gap-4 bg-background border-b px-4 py-3 sm:px-6 sm:py-4 shadow-sm shrink-0 min-h-0 max-h-[85%] overflow-y-auto z-10"
        >
          {isMobile ? (
            /* Three compact levels. Everything else is one tap away behind
               Filters / More, so the table keeps the viewport. */
            <MobileDashboardControls
              countLabel={countLabel}
              onOpenNav={() => setMobileNavOpen(true)}
              navOpen={mobileNavOpen}
              onAddPapers={() => setAddPaperOpen(true)}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              aiQuotaStatus={aiQuotaStatus}
              aiQuotaLoading={aiQuotaLoading}
              aiQuotaError={aiQuotaError}
              onClearFilters={handleClearFilters}
              hasActiveFilters={hasActiveFilters}
              filterPresets={filterPresets}
              availableColumns={availableColumns}
              visibleColumns={visibleColumns}
              onToggleColumn={toggleColumn}
              onFindDuplicates={openDedup}
              onOpenAnalytics={() => setIsAnalyticsOpen(true)}
              onExport={exportPapers}
              isExportReady={isExportReady}
              isExporting={isExporting}
              {...filterControlProps}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="min-w-0">
                    <h1 className="text-2xl font-bold">Papers</h1>
                    <p className="text-muted-foreground">{countLabel}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <AiQuotaIndicator
                    status={aiQuotaStatus}
                    isLoading={aiQuotaLoading}
                    isError={aiQuotaError}
                  />
                  <ColumnVisibilityDropdown
                    availableColumns={availableColumns}
                    visibleColumns={visibleColumns}
                    onToggleColumn={toggleColumn}
                  />
                  <Button variant="outline" onClick={openDedup}>
                    <Layers className="mr-2 h-4 w-4" aria-hidden="true" />
                    Find Duplicates
                  </Button>
                  <Button onClick={() => setAddPaperOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                    Add Papers
                  </Button>
                </div>
              </div>
              <SearchFilters
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onClearFilters={handleClearFilters}
                onExport={exportPapers}
                hasActiveFilters={hasActiveFilters}
                isExportReady={isExportReady}
                isExporting={isExporting}
                filterPresets={filterPresets}
                {...filterControlProps}
              />
              <AnalyticsPanel
                papers={analyticsPapers}
                isLoading={isAnalyticsLoading}
                isOpen={isAnalyticsOpen}
                onOpenChange={setIsAnalyticsOpen}
                targets={analyticsTargets}
                identityDataset={authorIdentities.dataset}
                identities={authorIdentities}
              />
            </>
          )}
          {/* Manager-facing Gemini provider-quota panel deferred under C29 —
              intentionally not rendered during the Free Tier development phase. */}
        </div>

        <div className="flex-1 flex flex-col p-3 sm:p-6 min-h-0 min-w-0 overflow-hidden">
          <PaperList
            papers={papers}
            userId={userId}
            onEdit={setEditingPaper}
            onDelete={deletePaper}
            findMatchingKeywords={findMatchingKeywords}
            visibleColumns={visibleColumns}
            columnWidths={columnWidths}
            onColumnResize={setColumnWidth}
            normalizeKeyword={normalizeKeyword}
            excludedKeywords={getExcludedKeywordSet()}
            excludedStudyTypes={getExcludedStudyTypeSet()}
            onExcludeStudyType={addExcludedStudyType}
            onExcludeKeyword={addExcludedKeyword}
            onUpdateDriveUrl={async (paperId, driveUrl) => {
              await updatePaper(paperId, { drive_url: driveUrl });
            }}
            selectedPaperIds={selectedPaperIds}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            isSelectAllReady={isSelectAllReady}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={handleSort}
            poolKeywordStrings={poolKeywords.map(pk => pk.keyword)}
            onAnalyzePaper={handleAnalyzePaper}
            analyzingPaperId={analyzingPaperId}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onLoadMore={fetchNextPage}
            searchMatchFlags={searchMatchFlags}
            totalCount={totalCount}
            isTotalCountAuthoritative={isTotalCountAuthoritative}
            hasActiveFilters={hasActiveFilters}
            onAddPapers={() => setAddPaperOpen(true)}
            onClearFilters={handleClearFilters}
          />

          <BulkActionsToolbar
            selectedCount={selectedPaperIds.size}
            onClearSelection={handleClearSelection}
            onBulkDelete={handleBulkDelete}
            onBulkSetProjects={handleBulkSetProjects}
            onBulkSetTags={handleBulkSetTags}
            onBulkAnalyze={handleBulkAnalyze}
            bulkAnalyzing={bulkAnalyzing}
            bulkAnalyzeProgress={bulkAnalyzeProgress}
            projects={projects}
            tags={tags}
          />
        </div>
      </main>

      <AddPaperDialog
        open={addPaperOpen}
        onOpenChange={setAddPaperOpen}
        onSubmitManual={addPaperManually}
        onBulkImport={bulkImportPapers}
        onFileImport={bulkImportFromParsedData}
        projects={projects}
        tags={tags}
      />

      <EditPaperDialog
        paper={editingPaper}
        projects={projects}
        tags={tags}
        open={!!editingPaper}
        onOpenChange={(open) => !open && setEditingPaper(null)}
        onSave={handleSavePaper}
        userId={user?.id}
        onAttachmentsChange={handleAttachmentsChange}
      />

      <EditProjectDialog
        project={editingProject}
        open={!!editingProject}
        onOpenChange={(open) => !open && setEditingProject(null)}
        onSave={updateProject}
      />

      <EditTagDialog
        tag={editingTag}
        open={!!editingTag}
        onOpenChange={(open) => !open && setEditingTag(null)}
        onSave={updateTag}
      />

      {dedupMounted && userId && (
        <DeduplicationDialog
          open={dedupOpen}
          onOpenChange={setDedupOpen}
          userId={userId}
        />
      )}

      {/* Mobile analytics is an overlay, not an inline panel: expanding it must
          not push the paper table out of the viewport. It shares the single
          `isAnalyticsOpen` state (and therefore the same gated analytics query)
          AND the single `analyticsTargets` selection state with the desktop
          Collapsible, so crossing the breakpoint while open simply swaps the
          shell rather than resetting what the user was looking at. */}
      {isMobile && (
        <MobileAnalyticsSheet
          papers={analyticsPapers}
          isLoading={isAnalyticsLoading}
          open={isAnalyticsOpen}
          onOpenChange={setIsAnalyticsOpen}
          targets={analyticsTargets}
          identityDataset={authorIdentities.dataset}
          identities={authorIdentities}
        />
      )}
    </div>
  );
}

export default Dashboard;
