import { useMemo, useCallback } from "react";
import { useQuery, useInfiniteQuery, useQueryClient, InfiniteData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { Paper, PaperWithTags, Project, Tag, BulkInsertResult } from "@/types/database";
import { useToast } from "@/hooks/use-toast";
import { NormalizationConfig, RawPaperData } from "@/lib/normalizePaperData";
import { evaluateStudyType, StudyTypePoolEntry } from "@/lib/evaluateStudyType";
import { fetchPaperMetadata } from "@/lib/fetchPaperMetadataEdge";
import { getErrorMessage } from "@/lib/errorUtils";
import { queryKeys } from "@/lib/queryKeys";
import { useNormalizationWorker } from "@/hooks/useNormalizationWorker";

const PAGE_SIZE = 100;

/** Data returned per page of the infinite query. */
interface PapersPage {
  papers: PaperWithTags[];
  projects: Project[];
  tags: Tag[];
  hasMore: boolean;
}

export function usePapers(userId: string | undefined, normalizationConfig?: NormalizationConfig) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { normalize } = useNormalizationWorker();

  // ── Infinite query: papers (paginated) + projects + tags ──
  const {
    data,
    isLoading: loading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<PapersPage, Error>({
    queryKey: queryKeys.papers.all(userId!),
    queryFn: async ({ pageParam }): Promise<PapersPage> => {
      const page = pageParam as number;
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      // Projects and tags: always fetch all (they're small)
      const [projectsResult, tagsResult] = await Promise.all([
        supabase.from("projects").select("*").eq("user_id", userId!).order("name"),
        supabase.from("tags").select("*").eq("user_id", userId!).order("name"),
      ]);
      if (projectsResult.error) throw projectsResult.error;
      if (tagsResult.error) throw tagsResult.error;

      const fetchedProjects = (projectsResult.data as Project[]) || [];
      const fetchedTags = (tagsResult.data as Tag[]) || [];

      // Papers: paginated
      const { data: papersData, error: papersError } = await supabase
        .from("papers")
        .select("*, paper_attachments(id, file_name, file_path, file_type)")
        .eq("user_id", userId!)
        .order("created_at", { ascending: false })
        .range(from, to);
      if (papersError) throw papersError;

      const rawPapers = (papersData as Paper[]) || [];
      const paperIds = rawPapers.map((p) => p.id);

      // Fetch junction tables for this page's papers
      const [paperTagsResult, paperProjectsResult] =
        paperIds.length > 0
          ? await Promise.all([
              supabase.from("paper_tags").select("*").in("paper_id", paperIds),
              supabase.from("paper_projects").select("*").in("paper_id", paperIds),
            ])
          : [{ data: [], error: null }, { data: [], error: null }];

      if (paperTagsResult.error) throw paperTagsResult.error;
      if (paperProjectsResult.error) throw paperProjectsResult.error;

      const paperTagsData = paperTagsResult.data;
      const paperProjectsData = paperProjectsResult.data;

      // Assemble PaperWithTags
      const assembledPapers: PaperWithTags[] = rawPapers.map((paper) => {
        const paperTagIds = (paperTagsData || [])
          .filter((pt: { paper_id: string; tag_id: string }) => pt.paper_id === paper.id)
          .map((pt: { tag_id: string }) => pt.tag_id);
        const paperTags = fetchedTags.filter((t) => paperTagIds.includes(t.id));

        const paperProjectIds = (paperProjectsData || [])
          .filter((pp: { paper_id: string; project_id: string }) => pp.paper_id === paper.id)
          .map((pp: { project_id: string }) => pp.project_id);
        const paperProjects = fetchedProjects.filter((p) => paperProjectIds.includes(p.id));

        return { ...paper, tags: paperTags, projects: paperProjects };
      });

      return {
        papers: assembledPapers,
        projects: fetchedProjects,
        tags: fetchedTags,
        hasMore: rawPapers.length === PAGE_SIZE,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return (lastPageParam as number) + 1;
    },
    enabled: !!userId,
  });

  // ── Total paper count (separate lightweight query) ──
  const { data: totalCount } = useQuery({
    queryKey: queryKeys.papers.count(userId!),
    queryFn: async () => {
      const { count, error } = await supabase
        .from("papers")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId!);
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!userId,
  });

  // Flatten pages into single arrays
  const papers = useMemo(
    () => data?.pages.flatMap((p) => p.papers) ?? [],
    [data],
  );
  const projects = data?.pages[0]?.projects ?? [];
  const tags = data?.pages[0]?.tags ?? [];

  // ── Cache helpers ──

  /** Snapshot both papers infinite data and count for optimistic rollback. */
  type CacheSnapshot = {
    papers: InfiniteData<PapersPage> | undefined;
    count: number | undefined;
  };

  const snapshotCache = useCallback((): CacheSnapshot => {
    if (!userId) return { papers: undefined, count: undefined };
    return {
      papers: queryClient.getQueryData<InfiniteData<PapersPage>>(queryKeys.papers.all(userId)),
      count: queryClient.getQueryData<number>(queryKeys.papers.count(userId)),
    };
  }, [userId, queryClient]);

  const rollbackCache = useCallback(
    (snapshot: CacheSnapshot) => {
      if (!userId) return;
      if (snapshot.papers !== undefined) {
        queryClient.setQueryData(queryKeys.papers.all(userId), snapshot.papers);
      }
      if (snapshot.count !== undefined) {
        queryClient.setQueryData(queryKeys.papers.count(userId), snapshot.count);
      }
    },
    [userId, queryClient],
  );

  /** Cancel in-flight queries to prevent them from overwriting optimistic state. */
  const cancelQueries = useCallback(async () => {
    if (!userId) return;
    await queryClient.cancelQueries({ queryKey: queryKeys.papers.all(userId) });
  }, [userId, queryClient]);

  /** Update the infinite query cache (papers). */
  const updatePapersCache = useCallback(
    (updater: (papers: PaperWithTags[]) => PaperWithTags[]) => {
      if (!userId) return;
      queryClient.setQueryData(
        queryKeys.papers.all(userId),
        (old: InfiniteData<PapersPage> | undefined) => {
          if (!old) return old;
          const allPapers = old.pages.flatMap((p) => p.papers);
          const updated = updater(allPapers);
          // Consolidate into first page for simplicity
          return {
            ...old,
            pages: old.pages.map((page, i) =>
              i === 0
                ? { ...page, papers: updated }
                : { ...page, papers: [] },
            ),
          };
        },
      );
    },
    [userId, queryClient],
  );

  /** Update the projects/tags metadata in all pages. */
  const updateMetaCache = useCallback(
    (updater: (projects: Project[], tags: Tag[]) => { projects: Project[]; tags: Tag[] }) => {
      if (!userId) return;
      queryClient.setQueryData(
        queryKeys.papers.all(userId),
        (old: InfiniteData<PapersPage> | undefined) => {
          if (!old) return old;
          const { projects: newProjects, tags: newTags } = updater(
            old.pages[0]?.projects ?? [],
            old.pages[0]?.tags ?? [],
          );
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              projects: newProjects,
              tags: newTags,
            })),
          };
        },
      );
    },
    [userId, queryClient],
  );

  /** Optimistically adjust the paper count cache. */
  const adjustCount = useCallback(
    (delta: number) => {
      if (!userId) return;
      queryClient.setQueryData(
        queryKeys.papers.count(userId),
        (old: number | undefined) => Math.max(0, (old ?? 0) + delta),
      );
    },
    [userId, queryClient],
  );

  // ── Project mutations (optimistic for update/delete, post-confirm for create) ──

  const createProject = async (name: string) => {
    if (!userId) return;

    // Case-insensitive find-or-create: if "CVD" exists and user types "cvd", select existing
    const existing = projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      toast({ title: "Project exists", description: `Using existing project "${existing.name}".` });
      return;
    }

    // Create cannot be optimistic (we need the server-generated ID)
    const { data: newProject, error } = await supabase
      .from("projects")
      .insert({ user_id: userId, name })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        toast({ title: "Project exists", description: "A project with this name already exists." });
      } else {
        toast({ title: "Error creating project", description: error.message, variant: "destructive" });
      }
      return;
    }

    updateMetaCache((oldProjects, oldTags) => ({
      projects: [...oldProjects, newProject as Project],
      tags: oldTags,
    }));
  };

  const updateProject = async (projectId: string, updates: Partial<Project>) => {
    if (!userId) return;

    await cancelQueries();
    const snapshot = snapshotCache();

    // Optimistic: apply update immediately
    updateMetaCache((oldProjects, oldTags) => {
      const existing = oldProjects.find((p) => p.id === projectId);
      if (!existing) return { projects: oldProjects, tags: oldTags };
      return {
        projects: oldProjects.map((p) => (p.id === projectId ? { ...existing, ...updates } : p)),
        tags: oldTags,
      };
    });
    updatePapersCache((allPapers) =>
      allPapers.map((p) => ({
        ...p,
        projects: p.projects.map((proj) =>
          proj.id === projectId ? { ...proj, ...updates } : proj,
        ),
      })),
    );

    const dbUpdates: Record<string, unknown> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.color !== undefined) dbUpdates.color = updates.color;

    const { error } = await supabase.from("projects").update(dbUpdates).eq("id", projectId);
    if (error) {
      rollbackCache(snapshot);
      toast({ title: "Error updating project", description: error.message, variant: "destructive" });
    }
  };

  const deleteProject = async (projectId: string) => {
    if (!userId) return;

    await cancelQueries();
    const snapshot = snapshotCache();

    // Optimistic: remove project immediately
    updateMetaCache((oldProjects, oldTags) => ({
      projects: oldProjects.filter((p) => p.id !== projectId),
      tags: oldTags,
    }));
    updatePapersCache((allPapers) =>
      allPapers.map((p) => ({
        ...p,
        projects: p.projects.filter((proj) => proj.id !== projectId),
      })),
    );

    const { error } = await supabase.from("projects").delete().eq("id", projectId);
    if (error) {
      rollbackCache(snapshot);
      toast({ title: "Error deleting project", description: error.message, variant: "destructive" });
    }
  };

  // ── Tag mutations (optimistic for update/delete, post-confirm for create) ──

  const createTag = async (name: string) => {
    if (!userId) return;

    // Case-insensitive find-or-create: if "CVD" exists and user types "cvd", select existing
    const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      toast({ title: "Tag exists", description: `Using existing tag "${existing.name}".` });
      return;
    }

    // Create cannot be optimistic (server generates ID, may reject duplicates)
    const { data: newTag, error } = await supabase
      .from("tags")
      .insert({ user_id: userId, name })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        toast({ title: "Tag exists", description: "A tag with this name already exists." });
      } else {
        toast({ title: "Error creating tag", description: error.message, variant: "destructive" });
      }
      return;
    }

    updateMetaCache((oldProjects, oldTags) => ({
      projects: oldProjects,
      tags: [...oldTags, newTag as Tag],
    }));
  };

  const updateTag = async (tagId: string, updates: Partial<Tag>) => {
    if (!userId) return;

    await cancelQueries();
    const snapshot = snapshotCache();

    // Optimistic: apply update immediately
    updateMetaCache((oldProjects, oldTags) => {
      const existing = oldTags.find((t) => t.id === tagId);
      if (!existing) return { projects: oldProjects, tags: oldTags };
      return {
        projects: oldProjects,
        tags: oldTags.map((t) => (t.id === tagId ? { ...existing, ...updates } : t)),
      };
    });
    updatePapersCache((allPapers) =>
      allPapers.map((p) => ({
        ...p,
        tags: p.tags.map((t) =>
          t.id === tagId ? { ...t, ...updates } : t,
        ),
      })),
    );

    const { error } = await supabase.from("tags").update(updates).eq("id", tagId);
    if (error) {
      rollbackCache(snapshot);
      toast({ title: "Error updating tag", description: error.message, variant: "destructive" });
    }
  };

  const deleteTag = async (tagId: string) => {
    if (!userId) return;

    await cancelQueries();
    const snapshot = snapshotCache();

    // Optimistic: remove tag immediately
    updateMetaCache((oldProjects, oldTags) => ({
      projects: oldProjects,
      tags: oldTags.filter((t) => t.id !== tagId),
    }));
    updatePapersCache((allPapers) =>
      allPapers.map((p) => ({ ...p, tags: p.tags.filter((t) => t.id !== tagId) })),
    );

    const { error } = await supabase.from("tags").delete().eq("id", tagId);
    if (error) {
      rollbackCache(snapshot);
      toast({ title: "Error deleting tag", description: error.message, variant: "destructive" });
    }
  };

  // ── Paper mutations ──

  const addPapers = async (identifiers: string[], driveUrl?: string) => {
    if (!userId) return;

    try {
      const fetchedPapers = await fetchPaperMetadata(identifiers);
      const successfulPapers: PaperWithTags[] = [];

      // Collect non-duplicate, successfully-fetched raw papers for batch normalization
      const rawPapersForNormalization: { raw: RawPaperData; result: typeof fetchedPapers[number] }[] = [];

      for (const result of fetchedPapers) {
        if (result.error) {
          toast({ title: "Could not fetch paper", description: `${result.identifier}: ${result.error}`, variant: "destructive" });
          continue;
        }

        const isDuplicate = papers.some((existing) => {
          if (result.pmid && existing.pmid && result.pmid === existing.pmid) return true;
          if (result.doi && existing.doi && result.doi.toLowerCase() === existing.doi.toLowerCase()) return true;
          if (result.title && existing.title && result.title.replace(/\.\s*$/, "").trim().toLowerCase() === existing.title.toLowerCase()) return true;
          return false;
        });

        if (isDuplicate) {
          toast({ title: "Duplicate paper", description: `"${result.title}" already exists in the index.`, variant: "destructive" });
          continue;
        }

        if (result.source === "crossref") {
          toast({ title: "Paper fetched via Crossref", description: `"${result.title}" — PubMed unavailable. Some metadata (MeSH terms, keywords) may be limited.` });
        }

        const combinedKeywords = [...(result.keywords || []), ...(result.mesh_terms || []), ...(result.substances || [])];

        rawPapersForNormalization.push({
          result,
          raw: {
            title: result.title,
            authors: result.authors || [],
            year: result.year,
            journal: result.journal,
            pmid: result.pmid,
            doi: result.doi,
            abstract: result.abstract,
            keywords: combinedKeywords,
            mesh_terms: result.mesh_terms || [],
            substances: result.substances || [],
            study_type: result.study_type || null,
            pubmed_url: result.pubmed_url,
            journal_url: result.journal_url,
            drive_url: driveUrl || null,
          },
        });
      }

      // Batch normalize via Web Worker (falls back to main thread for small batches)
      const normalizedPapers = normalizationConfig
        ? await normalize(rawPapersForNormalization.map((r) => r.raw), normalizationConfig)
        : rawPapersForNormalization.map((r) => r.raw);

      // Insert each normalized paper
      for (let i = 0; i < normalizedPapers.length; i++) {
        const normalized = normalizedPapers[i];
        const { result } = rawPapersForNormalization[i];

        const paperData = {
          user_id: userId,
          ...normalized,
          raw_study_type: result.study_type || null,
          mesh_terms: normalized.mesh_terms || [],
          substances: normalized.substances || [],
        };

        const { data: insertedPaper, error: insertError } = await supabase
          .from("papers")
          .insert(paperData)
          .select()
          .single();

        if (insertError) {
          if (insertError.code === "23505") {
            toast({ title: "Duplicate paper", description: `"${result.title}" already exists (duplicate PMID or DOI).`, variant: "destructive" });
          } else {
            toast({ title: "Error saving paper", description: insertError.message, variant: "destructive" });
          }
          continue;
        }

        successfulPapers.push({ ...(insertedPaper as Paper), tags: [], projects: [] });
      }

      if (successfulPapers.length > 0) {
        updatePapersCache((old) => [...successfulPapers, ...old]);
        queryClient.invalidateQueries({ queryKey: queryKeys.papers.count(userId) });
        toast({ title: "Papers added", description: `Successfully added ${successfulPapers.length} paper(s).` });
      }
    } catch (error: unknown) {
      toast({ title: "Error fetching papers", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  const addPaperManually = async (paperData: {
    title: string;
    authors: string;
    year: string;
    journal: string;
    pmid: string;
    doi: string;
    abstract: string;
    keywords: string;
    driveUrl: string;
    pubmedUrl?: string;
  }, options?: { targetProjectIds?: string[]; targetTagIds?: string[] }) => {
    if (!userId) return;

    const authorsArray = paperData.authors.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
    const keywordsArray = paperData.keywords.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
    const yearNum = paperData.year ? parseInt(paperData.year) : null;

    const manualTitle = paperData.title.trim();
    const manualPmid = paperData.pmid.trim();
    const manualDoi = paperData.doi.trim();
    const isDuplicate = papers.some((existing) => {
      if (manualPmid && existing.pmid && manualPmid === existing.pmid) return true;
      if (manualDoi && existing.doi && manualDoi.toLowerCase() === existing.doi.toLowerCase()) return true;
      if (manualTitle && existing.title && manualTitle.toLowerCase() === existing.title.toLowerCase()) return true;
      return false;
    });

    if (isDuplicate) {
      toast({ title: "Duplicate paper", description: `"${manualTitle}" already exists in the index.`, variant: "destructive" });
      return;
    }

    const rawPaper: RawPaperData = {
      title: manualTitle,
      authors: authorsArray,
      year: yearNum,
      journal: paperData.journal.trim() || null,
      pmid: manualPmid || null,
      doi: manualDoi || null,
      abstract: paperData.abstract.trim() || null,
      keywords: keywordsArray,
      mesh_terms: [],
      substances: [],
      study_type: null,
      pubmed_url: paperData.pubmedUrl?.trim() || (manualPmid ? `https://pubmed.ncbi.nlm.nih.gov/${manualPmid}/` : null),
      journal_url: null,
      drive_url: paperData.driveUrl.trim() || null,
    };

    const [normalized] = normalizationConfig
      ? await normalize([rawPaper], normalizationConfig)
      : [rawPaper];

    const insertData = { user_id: userId, ...normalized, raw_study_type: null };

    const { data: insertedPaper, error } = await supabase.from("papers").insert(insertData).select().single();

    if (error) {
      if (error.code === "23505") {
        toast({ title: "Duplicate paper", description: `"${manualTitle}" already exists (duplicate PMID or DOI).`, variant: "destructive" });
      } else {
        toast({ title: "Error adding paper", description: error.message, variant: "destructive" });
      }
      return;
    }

    const paperId = (insertedPaper as Paper).id;
    let assignedProjects: Project[] = [];
    let assignedTags: Tag[] = [];

    // Assign project/tags if specified
    if (options?.targetProjectIds && options.targetProjectIds.length > 0) {
      await supabase.rpc("set_paper_projects", { p_paper_id: paperId, p_project_ids: options.targetProjectIds });
      assignedProjects = projects.filter((p) => options.targetProjectIds!.includes(p.id));
    }
    if (options?.targetTagIds && options.targetTagIds.length > 0) {
      await supabase.rpc("set_paper_tags", { p_paper_id: paperId, p_tag_ids: options.targetTagIds });
      assignedTags = tags.filter((t) => options.targetTagIds!.includes(t.id));
    }

    updatePapersCache((old) => [{ ...(insertedPaper as Paper), tags: assignedTags, projects: assignedProjects }, ...old]);
    queryClient.invalidateQueries({ queryKey: queryKeys.papers.count(userId) });
    toast({ title: "Paper added manually" });
  };

  const updatePaper = async (
    paperId: string,
    updates: Partial<Paper> & { tagIds?: string[]; projectIds?: string[] },
  ) => {
    if (!userId) return;
    const { tagIds, projectIds, ...paperUpdates } = updates;

    await cancelQueries();
    const snapshot = snapshotCache();

    // Optimistic: apply all changes immediately
    updatePapersCache((allPapers) =>
      allPapers.map((p) => {
        if (p.id !== paperId) return p;
        const updatedTags = tagIds ? tags.filter((t) => tagIds.includes(t.id)) : p.tags;
        const updatedProjects = projectIds !== undefined ? projects.filter((pr) => projectIds.includes(pr.id)) : p.projects;
        return { ...p, ...paperUpdates, tags: updatedTags, projects: updatedProjects };
      }),
    );

    // Persist to DB
    if (Object.keys(paperUpdates).length > 0) {
      const { error } = await supabase.from("papers").update(paperUpdates).eq("id", paperId);
      if (error) {
        rollbackCache(snapshot);
        toast({ title: "Error updating paper", description: error.message, variant: "destructive" });
        return;
      }
    }

    if (tagIds !== undefined) {
      const { error: tagError } = await supabase.rpc("set_paper_tags", { p_paper_id: paperId, p_tag_ids: tagIds });
      if (tagError) {
        rollbackCache(snapshot);
        toast({ title: "Error updating tags", description: tagError.message, variant: "destructive" });
        return;
      }
    }

    if (projectIds !== undefined) {
      const { error: projError } = await supabase.rpc("set_paper_projects", { p_paper_id: paperId, p_project_ids: projectIds });
      if (projError) {
        rollbackCache(snapshot);
        toast({ title: "Error updating projects", description: projError.message, variant: "destructive" });
        return;
      }
    }

    toast({ title: "Paper updated" });
  };

  const deletePaper = async (paperId: string) => {
    if (!userId) return;

    await cancelQueries();
    const snapshot = snapshotCache();

    // Optimistic: remove paper and decrement count immediately
    updatePapersCache((old) => old.filter((p) => p.id !== paperId));
    adjustCount(-1);

    const { error } = await supabase.from("papers").delete().eq("id", paperId);
    if (error) {
      rollbackCache(snapshot);
      toast({ title: "Error deleting paper", description: error.message, variant: "destructive" });
      return;
    }

    toast({ title: "Paper deleted" });
  };

  const bulkImportPapers = useCallback(
    async (
      identifiers: string[],
      onProgress?: (current: number, total: number, addedIds: string[], skippedIds: string[], failedIds: string[]) => void,
      options?: { targetProjectIds?: string[]; targetTagIds?: string[] }
    ) => {
      if (!userId || identifiers.length === 0) return;

      const addedIds: string[] = [];
      const skippedIds: string[] = [];
      const failedIds: string[] = [];
      const total = identifiers.length;

      // Phase 1: Batch fetch all metadata via edge function
      // (fetchPaperMetadata already batches by EDGE_BATCH_SIZE=10 internally)
      onProgress?.(0, total, addedIds, skippedIds, failedIds);
      const allMetadata = await fetchPaperMetadata(identifiers);

      // Separate successful fetches from failures
      const successfulResults: { identifier: string; meta: typeof allMetadata[0] }[] = [];
      for (const meta of allMetadata) {
        if (meta.error || !meta.title) {
          failedIds.push(meta.identifier);
        } else {
          successfulResults.push({ identifier: meta.identifier, meta });
        }
      }

      // Report after fetch phase
      onProgress?.(Math.ceil(total * 0.6), total, addedIds, skippedIds, failedIds);

      if (successfulResults.length === 0) {
        onProgress?.(total, total, addedIds, skippedIds, failedIds);
        toast({
          title: "Bulk import complete",
          description: `0 added, 0 skipped (duplicates), ${failedIds.length} failed.`,
        });
        return;
      }

      // Phase 2: Batch normalize all successful results
      const rawPapers: RawPaperData[] = successfulResults.map(({ meta }) => ({
        title: meta.title!,
        authors: meta.authors || [],
        year: meta.year ?? null,
        journal: meta.journal ?? null,
        pmid: meta.pmid ?? null,
        doi: meta.doi ?? null,
        abstract: meta.abstract ?? null,
        keywords: meta.keywords || [],
        mesh_terms: meta.mesh_terms || [],
        substances: meta.substances || [],
        study_type: meta.study_type || null,
        pubmed_url: meta.pubmed_url ?? null,
        journal_url: meta.journal_url ?? null,
        drive_url: null,
      }));

      const normalizedPapers = normalizationConfig
        ? await normalize(rawPapers, normalizationConfig)
        : rawPapers;

      // Phase 3: Build payload and call safe_bulk_insert_papers RPC
      // Build plain objects with only the fields the SQL function reads.
      // This avoids any extra properties from normalize() leaking in.
      const insertPayload = normalizedPapers.map((normalized, i) => ({
        title: normalized.title,
        authors: normalized.authors || [],
        year: normalized.year ?? null,
        journal: normalized.journal ?? null,
        pmid: normalized.pmid ?? null,
        doi: normalized.doi ?? null,
        abstract: normalized.abstract ?? null,
        study_type: normalized.study_type ?? null,
        raw_study_type: successfulResults[i].meta.study_type || null,
        statistical_methods: null,
        keywords: normalized.keywords || [],
        mesh_terms: normalized.mesh_terms || [],
        substances: normalized.substances || [],
        pubmed_url: normalized.pubmed_url ?? null,
        journal_url: normalized.journal_url ?? null,
        drive_url: normalized.drive_url ?? null,
      }));

      const { data: rpcResult, error: rpcError } = await supabase.rpc(
        "safe_bulk_insert_papers",
        {
          p_user_id: userId,
          p_papers: insertPayload as unknown as Json,
        }
      );

      if (rpcError) {
        // Fallback: mark all as failed
        for (const { identifier } of successfulResults) {
          failedIds.push(identifier);
        }
        onProgress?.(total, total, addedIds, skippedIds, failedIds);
        toast({
          title: "Bulk import failed",
          description: rpcError.message,
          variant: "destructive",
        });
        return;
      }

      // Phase 4: Process RPC results
      const results = (typeof rpcResult === "string" ? JSON.parse(rpcResult) : rpcResult) as BulkInsertResult[];
      const newPapers: PaperWithTags[] = [];

      for (const row of results) {
        const { identifier } = successfulResults[row.index];
        if (row.status === "inserted" && row.id) {
          addedIds.push(identifier);
          // Build a PaperWithTags from the normalized data + returned id
          const norm = normalizedPapers[row.index];
          newPapers.push({
            id: row.id,
            user_id: userId,
            title: norm.title,
            authors: norm.authors,
            year: norm.year,
            journal: norm.journal,
            pmid: norm.pmid,
            doi: norm.doi,
            abstract: norm.abstract,
            study_type: norm.study_type,
            raw_study_type: successfulResults[row.index].meta.study_type || null,
            statistical_methods: null,
            keywords: norm.keywords,
            mesh_terms: norm.mesh_terms || [],
            substances: norm.substances || [],
            pubmed_url: norm.pubmed_url,
            journal_url: norm.journal_url,
            drive_url: norm.drive_url,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            tags: [],
            projects: [],
          });
        } else if (row.status === "duplicate") {
          skippedIds.push(identifier);
        } else {
          failedIds.push(identifier);
        }
      }

      onProgress?.(total, total, addedIds, skippedIds, failedIds);

      // Phase 5: Assign project/tags to newly inserted papers
      const insertedPaperIds = newPapers.map((p) => p.id);
      if (insertedPaperIds.length > 0) {
        const projectIds = options?.targetProjectIds;
        const tagIds = options?.targetTagIds;

        if (projectIds && projectIds.length > 0) {
          await supabase.rpc("bulk_set_paper_projects", {
            p_paper_ids: insertedPaperIds,
            p_project_ids: projectIds,
          });
          // Update cache with project info
          const allProjects = queryClient.getQueryData<InfiniteData<PapersPage>>(queryKeys.papers.all(userId))
            ?.pages.flatMap((p) => p.projects) ?? [];
          const matchedProjects = allProjects.filter((p) => projectIds.includes(p.id));
          if (matchedProjects.length > 0) {
            newPapers.forEach((p) => { p.projects = matchedProjects; });
          }
        }

        if (tagIds && tagIds.length > 0) {
          await supabase.rpc("bulk_set_paper_tags", {
            p_paper_ids: insertedPaperIds,
            p_tag_ids: tagIds,
          });
          // Update cache with tag info
          const allTags = queryClient.getQueryData<InfiniteData<PapersPage>>(queryKeys.papers.all(userId))
            ?.pages.flatMap((p) => p.tags) ?? [];
          const matchedTags = allTags.filter((t) => tagIds.includes(t.id));
          if (matchedTags.length > 0) {
            newPapers.forEach((p) => { p.tags = matchedTags; });
          }
        }

        updatePapersCache((old) => [...newPapers, ...old]);
        queryClient.invalidateQueries({ queryKey: queryKeys.papers.count(userId) });
      }

      toast({
        title: "Bulk import complete",
        description: `${addedIds.length} added, ${skippedIds.length} skipped (duplicates), ${failedIds.length} failed.`,
      });
    },
    [userId, queryClient, normalizationConfig, normalize, toast, updatePapersCache],
  );

  /**
   * Import pre-parsed papers (from .bib, .ris, .csv file parsers).
   * Skips the metadata fetch phase — goes directly to normalize → RPC → cache.
   */
  const bulkImportFromParsedData = useCallback(
    async (
      parsedPapers: RawPaperData[],
      onProgress?: (current: number, total: number, added: number, skipped: number, failed: number) => void,
      options?: { targetProjectIds?: string[]; targetTagIds?: string[] }
    ) => {
      if (!userId || parsedPapers.length === 0) return;

      const total = parsedPapers.length;
      let addedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;

      onProgress?.(0, total, 0, 0, 0);

      // Phase 1: Normalize via Web Worker
      const normalizedPapers = normalizationConfig
        ? await normalize(parsedPapers, normalizationConfig)
        : parsedPapers.map((p) => ({
            ...p,
            mesh_terms: p.mesh_terms || [],
            substances: p.substances || [],
          }));

      onProgress?.(Math.ceil(total * 0.3), total, 0, 0, 0);

      // Phase 2: Build payload and call safe_bulk_insert_papers RPC
      const insertPayload = normalizedPapers.map((normalized, i) => ({
        title: normalized.title,
        authors: normalized.authors || [],
        year: normalized.year ?? null,
        journal: normalized.journal ?? null,
        pmid: normalized.pmid ?? null,
        doi: normalized.doi ?? null,
        abstract: normalized.abstract ?? null,
        study_type: normalized.study_type ?? null,
        raw_study_type: parsedPapers[i].study_type || null,
        statistical_methods: null,
        keywords: normalized.keywords || [],
        mesh_terms: normalized.mesh_terms || [],
        substances: normalized.substances || [],
        pubmed_url: normalized.pubmed_url ?? null,
        journal_url: normalized.journal_url ?? null,
        drive_url: normalized.drive_url ?? null,
      }));

      const { data: rpcResult, error: rpcError } = await supabase.rpc(
        "safe_bulk_insert_papers",
        {
          p_user_id: userId,
          p_papers: insertPayload as unknown as Json,
        }
      );

      if (rpcError) {
        onProgress?.(total, total, 0, 0, total);
        toast({
          title: "File import failed",
          description: rpcError.message,
          variant: "destructive",
        });
        return;
      }

      // Phase 3: Process RPC results
      const results = (typeof rpcResult === "string" ? JSON.parse(rpcResult) : rpcResult) as BulkInsertResult[];
      const newPapers: PaperWithTags[] = [];

      for (const row of results) {
        if (row.status === "inserted" && row.id) {
          addedCount++;
          const norm = normalizedPapers[row.index];
          newPapers.push({
            id: row.id,
            user_id: userId,
            title: norm.title,
            authors: norm.authors,
            year: norm.year,
            journal: norm.journal,
            pmid: norm.pmid,
            doi: norm.doi,
            abstract: norm.abstract,
            study_type: norm.study_type,
            raw_study_type: parsedPapers[row.index].study_type || null,
            statistical_methods: null,
            keywords: norm.keywords,
            mesh_terms: norm.mesh_terms || [],
            substances: norm.substances || [],
            pubmed_url: norm.pubmed_url,
            journal_url: norm.journal_url,
            drive_url: norm.drive_url,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            tags: [],
            projects: [],
          });
        } else if (row.status === "duplicate") {
          skippedCount++;
        } else {
          failedCount++;
        }
      }

      onProgress?.(total, total, addedCount, skippedCount, failedCount);

      // Phase 4: Assign project/tags to newly inserted papers
      const insertedPaperIds = newPapers.map((p) => p.id);
      if (insertedPaperIds.length > 0) {
        const projectIds = options?.targetProjectIds;
        const tagIds = options?.targetTagIds;

        if (projectIds && projectIds.length > 0) {
          await supabase.rpc("bulk_set_paper_projects", {
            p_paper_ids: insertedPaperIds,
            p_project_ids: projectIds,
          });
          const allProjects = queryClient.getQueryData<InfiniteData<PapersPage>>(queryKeys.papers.all(userId))
            ?.pages.flatMap((p) => p.projects) ?? [];
          const matchedProjects = allProjects.filter((p) => projectIds.includes(p.id));
          if (matchedProjects.length > 0) {
            newPapers.forEach((p) => { p.projects = matchedProjects; });
          }
        }

        if (tagIds && tagIds.length > 0) {
          await supabase.rpc("bulk_set_paper_tags", {
            p_paper_ids: insertedPaperIds,
            p_tag_ids: tagIds,
          });
          const allTags = queryClient.getQueryData<InfiniteData<PapersPage>>(queryKeys.papers.all(userId))
            ?.pages.flatMap((p) => p.tags) ?? [];
          const matchedTags = allTags.filter((t) => tagIds.includes(t.id));
          if (matchedTags.length > 0) {
            newPapers.forEach((p) => { p.tags = matchedTags; });
          }
        }

        updatePapersCache((old) => [...newPapers, ...old]);
        queryClient.invalidateQueries({ queryKey: queryKeys.papers.count(userId) });
      }

      toast({
        title: "File import complete",
        description: `${addedCount} added, ${skippedCount} skipped (duplicates), ${failedCount} failed.`,
      });
    },
    [userId, queryClient, normalizationConfig, normalize, toast, updatePapersCache],
  );

  // Extract all unique keywords from papers
  const allKeywords = useMemo(() => {
    const keywordSet = new Set<string>();
    papers.forEach((paper) => {
      paper.keywords.forEach((kw) => keywordSet.add(kw));
    });
    return Array.from(keywordSet).sort();
  }, [papers]);

  /**
   * Re-evaluate study types for all papers against the given pool.
   * Updates cache immediately and persists changes to DB.
   */
  const reevaluateStudyTypes = useCallback(
    async (pool: StudyTypePoolEntry[]) => {
      if (!userId || papers.length === 0) return;

      const updates: { id: string; newType: string }[] = [];

      for (const paper of papers) {
        const rawFallback = paper.raw_study_type ?? paper.study_type;
        const newType = evaluateStudyType(paper.title, paper.abstract, rawFallback, pool);
        const current = (paper.study_type || "").trim();
        const evaluated = (newType || "").trim();
        if (current !== evaluated) {
          updates.push({ id: paper.id, newType: evaluated });
        }
      }

      if (updates.length === 0) return;

      updatePapersCache((allPapers) =>
        allPapers.map((p) => {
          const upd = updates.find((u) => u.id === p.id);
          return upd ? { ...p, study_type: upd.newType || null } : p;
        }),
      );

      try {
        const payload = updates.map(({ id, newType }) => ({ id, study_type: newType || null }));
        const { error } = await supabase.rpc("bulk_update_study_types", { updates: payload });
        if (error) throw error;
        toast({ title: "Study types updated", description: `Re-classified ${updates.length} paper(s) based on updated pool.` });
      } catch (err: unknown) {
        toast({ title: "Error saving study type updates", description: getErrorMessage(err), variant: "destructive" });
      }
    },
    [userId, papers, updatePapersCache, toast],
  );

  const bulkDeletePapers = async (paperIds: string[]) => {
    if (!userId || paperIds.length === 0) return;

    await cancelQueries();
    const snapshot = snapshotCache();

    // Optimistic: remove papers and adjust count immediately
    const idSet = new Set(paperIds);
    updatePapersCache((old) => old.filter((p) => !idSet.has(p.id)));
    adjustCount(-paperIds.length);

    const { error } = await supabase.from("papers").delete().in("id", paperIds);
    if (error) {
      rollbackCache(snapshot);
      toast({ title: "Error deleting papers", description: error.message, variant: "destructive" });
      return;
    }

    toast({ title: `Deleted ${paperIds.length} paper(s)` });
  };

  const bulkSetProjects = async (paperIds: string[], projectIds: string[]) => {
    if (!userId || paperIds.length === 0) return;

    await cancelQueries();
    const snapshot = snapshotCache();

    // Optimistic: assign projects immediately
    const newProjects = projects.filter((p) => projectIds.includes(p.id));
    updatePapersCache((allPapers) =>
      allPapers.map((p) => (paperIds.includes(p.id) ? { ...p, projects: newProjects } : p)),
    );

    const { error } = await supabase.rpc("bulk_set_paper_projects", { p_paper_ids: paperIds, p_project_ids: projectIds });
    if (error) {
      rollbackCache(snapshot);
      toast({ title: "Error setting projects", description: getErrorMessage(error), variant: "destructive" });
      return;
    }

    toast({ title: `Updated projects for ${paperIds.length} paper(s)` });
  };

  const bulkSetTags = async (paperIds: string[], tagIds: string[]) => {
    if (!userId || paperIds.length === 0) return;

    await cancelQueries();
    const snapshot = snapshotCache();

    // Optimistic: assign tags immediately
    const newTags = tags.filter((t) => tagIds.includes(t.id));
    updatePapersCache((allPapers) =>
      allPapers.map((p) => (paperIds.includes(p.id) ? { ...p, tags: newTags } : p)),
    );

    const { error } = await supabase.rpc("bulk_set_paper_tags", { p_paper_ids: paperIds, p_tag_ids: tagIds });
    if (error) {
      rollbackCache(snapshot);
      toast({ title: "Error setting tags", description: getErrorMessage(error), variant: "destructive" });
      return;
    }

    toast({ title: `Updated tags for ${paperIds.length} paper(s)` });
  };

  return {
    papers,
    projects,
    tags,
    loading,
    allKeywords,
    totalCount: totalCount ?? papers.length,
    fetchNextPage,
    hasNextPage: hasNextPage ?? false,
    isFetchingNextPage,
    createProject,
    updateProject,
    deleteProject,
    createTag,
    updateTag,
    deleteTag,
    addPapers,
    addPaperManually,
    bulkImportPapers,
    bulkImportFromParsedData,
    updatePaper,
    deletePaper,
    bulkDeletePapers,
    bulkSetProjects,
    bulkSetTags,
    reevaluateStudyTypes,
    refetch: () => queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(userId!) }),
  };
}
