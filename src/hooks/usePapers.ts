import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Paper, PaperWithTags, Project, Tag } from "@/types/database";
import { useToast } from "@/hooks/use-toast";
import { normalizePaperData, NormalizationConfig, RawPaperData } from "@/lib/normalizePaperData";
import { evaluateStudyType, StudyTypePoolEntry } from "@/lib/evaluateStudyType";
import { fetchPaperMetadata } from "@/lib/fetchPaperMetadata";
import { getErrorMessage } from "@/lib/errorUtils";

export function usePapers(userId: string | undefined, normalizationConfig?: NormalizationConfig) {
  const [papers, setPapers] = useState<PaperWithTags[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const fetchData = async () => {
    if (!userId) return;

    setLoading(true);
    try {
      // Fetch projects
      const { data: projectsData, error: projectsError } = await supabase
        .from("projects")
        .select("*")
        .eq("user_id", userId)
        .order("name");

      if (projectsError) throw projectsError;
      setProjects((projectsData as Project[]) || []);

      // Fetch tags
      const { data: tagsData, error: tagsError } = await supabase
        .from("tags")
        .select("*")
        .eq("user_id", userId)
        .order("name");

      if (tagsError) throw tagsError;
      setTags((tagsData as Tag[]) || []);

      // Fetch papers
      const { data: papersData, error: papersError } = await supabase
        .from("papers")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (papersError) throw papersError;

      // Fetch paper_tags and paper_projects scoped to this user's papers
      const paperIds = ((papersData as Paper[]) || []).map(p => p.id);

      const [paperTagsResult, paperProjectsResult] = paperIds.length > 0
        ? await Promise.all([
            supabase.from("paper_tags").select("*").in("paper_id", paperIds),
            supabase.from("paper_projects").select("*").in("paper_id", paperIds),
          ])
        : [{ data: [], error: null }, { data: [], error: null }];

      if (paperTagsResult.error) throw paperTagsResult.error;
      if (paperProjectsResult.error) throw paperProjectsResult.error;

      const paperTagsData = paperTagsResult.data;
      const paperProjectsData = paperProjectsResult.data;

      // Combine papers with their tags and projects
      const papersWithTags: PaperWithTags[] = ((papersData as Paper[]) || []).map((paper) => {
        const paperTagIds = (paperTagsData || [])
          .filter((pt: { paper_id: string; tag_id: string }) => pt.paper_id === paper.id)
          .map((pt: { tag_id: string }) => pt.tag_id);
        const paperTags = (tagsData as Tag[] || []).filter((t) => paperTagIds.includes(t.id));
        
        const paperProjectIds = (paperProjectsData || [])
          .filter((pp: { paper_id: string; project_id: string }) => pp.paper_id === paper.id)
          .map((pp: { project_id: string }) => pp.project_id);
        const paperProjects = (projectsData as Project[] || []).filter((p) => paperProjectIds.includes(p.id));
        
        return { ...paper, tags: paperTags, projects: paperProjects };
      });

      setPapers(papersWithTags);
    } catch (error: unknown) {
      toast({
        title: "Error loading data",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [userId]);

  const createProject = async (name: string) => {
    if (!userId) return;

    const { data, error } = await supabase
      .from("projects")
      .insert({ user_id: userId, name })
      .select()
      .single();

    if (error) {
      toast({
        title: "Error creating project",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setProjects((prev) => [...prev, data as Project]);
  };

  const updateProject = async (projectId: string, updates: Partial<Project>) => {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.color !== undefined) dbUpdates.color = updates.color;

    const { error } = await supabase
      .from("projects")
      .update(dbUpdates)
      .eq("id", projectId);

    if (error) {
      toast({
        title: "Error updating project",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    const updatedProject = { ...projects.find(p => p.id === projectId)!, ...updates };
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? updatedProject : p))
    );
    // Propagate to embedded paper references
    setPapers((prev) =>
      prev.map((p) => ({
        ...p,
        projects: p.projects.map((proj) => proj.id === projectId ? updatedProject : proj),
      }))
    );
  };

  const deleteProject = async (projectId: string) => {
    const { error } = await supabase
      .from("projects")
      .delete()
      .eq("id", projectId);

    if (error) {
      toast({
        title: "Error deleting project",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    setPapers((prev) =>
      prev.map((p) => ({
        ...p,
        projects: p.projects.filter((proj) => proj.id !== projectId),
      }))
    );
  };

  const createTag = async (name: string) => {
    if (!userId) return;

    const { data, error } = await supabase
      .from("tags")
      .insert({ user_id: userId, name })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        toast({
          title: "Tag exists",
          description: "A tag with this name already exists.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Error creating tag",
          description: error.message,
          variant: "destructive",
        });
      }
      return;
    }

    setTags((prev) => [...prev, data as Tag]);
  };

  const updateTag = async (tagId: string, updates: Partial<Tag>) => {
    const { error } = await supabase.from("tags").update(updates).eq("id", tagId);

    if (error) {
      toast({
        title: "Error updating tag",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    const updatedTag = { ...tags.find(t => t.id === tagId)!, ...updates };
    setTags((prev) => prev.map((t) => (t.id === tagId ? updatedTag : t)));
    setPapers((prev) =>
      prev.map((p) => ({
        ...p,
        tags: p.tags.map((t) => (t.id === tagId ? updatedTag : t)),
      }))
    );
  };

  const deleteTag = async (tagId: string) => {
    const { error } = await supabase.from("tags").delete().eq("id", tagId);

    if (error) {
      toast({
        title: "Error deleting tag",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setTags((prev) => prev.filter((t) => t.id !== tagId));
    setPapers((prev) =>
      prev.map((p) => ({ ...p, tags: p.tags.filter((t) => t.id !== tagId) }))
    );
  };

  const addPapers = async (identifiers: string[], driveUrl?: string) => {
    if (!userId) return;

    try {
      const fetchedPapers = await fetchPaperMetadata(identifiers);
      const successfulPapers: PaperWithTags[] = [];

      for (const result of fetchedPapers) {
        if (result.error) {
          toast({
            title: "Could not fetch paper",
            description: `${result.identifier}: ${result.error}`,
            variant: "destructive",
          });
          continue;
        }

        // Duplicate check against current local state
        const isDuplicate = papers.some(existing => {
          if (result.pmid && existing.pmid && result.pmid === existing.pmid) return true;
          if (result.doi && existing.doi && result.doi.toLowerCase() === existing.doi.toLowerCase()) return true;
          if (result.title && existing.title && result.title.replace(/\.\s*$/, '').trim().toLowerCase() === existing.title.toLowerCase()) return true;
          return false;
        });

        if (isDuplicate) {
          toast({
            title: "Duplicate paper",
            description: `"${result.title}" already exists in the index.`,
            variant: "destructive",
          });
          continue;
        }

        // Notify user if data came from Crossref fallback
        if (result.source === "crossref") {
          toast({
            title: "Paper fetched via Crossref",
            description: `"${result.title}" — PubMed unavailable. Some metadata (MeSH terms, keywords) may be limited.`,
          });
        }

        // Combine author keywords + MeSH terms + substances into one array for normalization
        const combinedKeywords = [
          ...(result.keywords || []),
          ...(result.mesh_terms || []),
          ...(result.substances || []),
        ];

        const rawPaper: RawPaperData = {
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
        };

        const normalized = normalizationConfig
          ? normalizePaperData(rawPaper, normalizationConfig)
          : rawPaper;

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
          toast({
            title: "Error saving paper",
            description: insertError.message,
            variant: "destructive",
          });
          continue;
        }

        successfulPapers.push({ ...(insertedPaper as Paper), tags: [], projects: [] });
      }

      setPapers((prev) => [...successfulPapers, ...prev]);

      if (successfulPapers.length > 0) {
        toast({
          title: "Papers added",
          description: `Successfully added ${successfulPapers.length} paper(s).`,
        });
      }
    } catch (error: unknown) {
      toast({
        title: "Error fetching papers",
        description: getErrorMessage(error),
        variant: "destructive",
      });
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
  }) => {
    if (!userId) return;

    const authorsArray = paperData.authors
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);

    const keywordsArray = paperData.keywords
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    const yearNum = paperData.year ? parseInt(paperData.year) : null;

    // Duplicate check for manual entry
    const manualTitle = paperData.title.trim();
    const manualPmid = paperData.pmid.trim();
    const manualDoi = paperData.doi.trim();
    const isDuplicate = papers.some(existing => {
      if (manualPmid && existing.pmid && manualPmid === existing.pmid) return true;
      if (manualDoi && existing.doi && manualDoi.toLowerCase() === existing.doi.toLowerCase()) return true;
      if (manualTitle && existing.title && manualTitle.toLowerCase() === existing.title.toLowerCase()) return true;
      return false;
    });

    if (isDuplicate) {
      toast({
        title: "Duplicate paper",
        description: `"${manualTitle}" already exists in the index.`,
        variant: "destructive",
      });
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
      pubmed_url: manualPmid ? `https://pubmed.ncbi.nlm.nih.gov/${manualPmid}/` : null,
      journal_url: null,
      drive_url: paperData.driveUrl.trim() || null,
    };

    const normalized = normalizationConfig
      ? normalizePaperData(rawPaper, normalizationConfig)
      : rawPaper;

    const insertData = {
      user_id: userId,
      ...normalized,
      raw_study_type: null,
    };

    const { data: insertedPaper, error } = await supabase
      .from("papers")
      .insert(insertData)
      .select()
      .single();

    if (error) {
      toast({
        title: "Error adding paper",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setPapers((prev) => [{ ...(insertedPaper as Paper), tags: [], projects: [] }, ...prev]);
    toast({ title: "Paper added manually" });
  };

  const updatePaper = async (
    paperId: string,
    updates: Partial<Paper> & { tagIds?: string[]; projectIds?: string[] }
  ) => {
    const { tagIds, projectIds, ...paperUpdates } = updates;

    // Only send paper column updates if there are any
    if (Object.keys(paperUpdates).length > 0) {
      const { error } = await supabase
        .from("papers")
        .update(paperUpdates)
        .eq("id", paperId);

      if (error) {
        toast({
          title: "Error updating paper",
          description: error.message,
          variant: "destructive",
        });
        return;
      }
    }

    // Update tags if provided
    if (tagIds !== undefined) {
      await supabase.from("paper_tags").delete().eq("paper_id", paperId);
      if (tagIds.length > 0) {
        await supabase.from("paper_tags").insert(
          tagIds.map((tagId) => ({ paper_id: paperId, tag_id: tagId }))
        );
      }
    }

    // Update projects if provided
    if (projectIds !== undefined) {
      await supabase.from("paper_projects").delete().eq("paper_id", paperId);
      if (projectIds.length > 0) {
        await supabase.from("paper_projects").insert(
          projectIds.map((projId) => ({ paper_id: paperId, project_id: projId }))
        );
      }
    }

    // Update local state
    setPapers((prev) =>
      prev.map((p) => {
        if (p.id !== paperId) return p;
        const updatedTags = tagIds
          ? tags.filter((t) => tagIds.includes(t.id))
          : p.tags;
        const updatedProjects = projectIds !== undefined
          ? projects.filter((pr) => projectIds.includes(pr.id))
          : p.projects;
        return { ...p, ...paperUpdates, tags: updatedTags, projects: updatedProjects };
      })
    );

    toast({ title: "Paper updated" });
  };

  const deletePaper = async (paperId: string) => {
    const { error } = await supabase.from("papers").delete().eq("id", paperId);

    if (error) {
      toast({
        title: "Error deleting paper",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setPapers((prev) => prev.filter((p) => p.id !== paperId));
    toast({ title: "Paper deleted" });
  };

  const bulkImportPapers = async (
    identifiers: string[],
    onProgress?: (
      current: number,
      total: number,
      addedIds: string[],
      skippedIds: string[],
      failedIds: string[]
    ) => void
  ) => {
    if (!userId || identifiers.length === 0) return;

    const addedIds: string[] = [];
    const skippedIds: string[] = [];
    const failedIds: string[] = [];
    const total = identifiers.length;
    const newPapers: PaperWithTags[] = [];

    for (let i = 0; i < identifiers.length; i++) {
      const id = identifiers[i];
      onProgress?.(i + 1, total, addedIds, skippedIds, failedIds);

      // Pre-fetch dedup check (local state + freshly added in this batch)
      const allCurrent = [...papers, ...newPapers];
      const alreadyExists = allCurrent.some(existing => {
        const trimmedId = id.trim();
        if (/^\d+$/.test(trimmedId) && existing.pmid === trimmedId) return true;
        if (trimmedId.startsWith("10.") && existing.doi?.toLowerCase() === trimmedId.toLowerCase()) return true;
        if (existing.title?.replace(/\.\s*$/, '').trim().toLowerCase() === trimmedId.toLowerCase()) return true;
        return false;
      });

      if (alreadyExists) {
        skippedIds.push(id);
        continue;
      }

      try {
        const fetchedPapers = await fetchPaperMetadata([id]);
        const result = fetchedPapers[0];

        if (!result || result.error) {
          failedIds.push(id);
          continue;
        }

        // Post-fetch dedup check
        const allCurrentPost = [...papers, ...newPapers];
        const isDupPost = allCurrentPost.some(existing => {
          if (result.pmid && existing.pmid && result.pmid === existing.pmid) return true;
          if (result.doi && existing.doi && result.doi.toLowerCase() === existing.doi.toLowerCase()) return true;
          if (result.title && existing.title && result.title.replace(/\.\s*$/, '').trim().toLowerCase() === existing.title.toLowerCase()) return true;
          return false;
        });

        if (isDupPost) {
          skippedIds.push(id);
          continue;
        }

        const rawPaper: RawPaperData = {
          title: result.title,
          authors: result.authors || [],
          year: result.year,
          journal: result.journal,
          pmid: result.pmid,
          doi: result.doi,
          abstract: result.abstract,
          keywords: result.keywords || [],
          mesh_terms: result.mesh_terms || [],
          substances: result.substances || [],
          study_type: result.study_type || null,
          pubmed_url: result.pubmed_url,
          journal_url: result.journal_url,
          drive_url: null,
        };

        const normalized = normalizationConfig
          ? normalizePaperData(rawPaper, normalizationConfig)
          : rawPaper;

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
          failedIds.push(id);
          continue;
        }

        const newPaper: PaperWithTags = { ...(insertedPaper as Paper), tags: [], projects: [] };
        newPapers.push(newPaper);
        addedIds.push(id);
      } catch {
        failedIds.push(id);
      }
    }

    // Final progress callback
    onProgress?.(total, total, addedIds, skippedIds, failedIds);

    if (newPapers.length > 0) {
      setPapers((prev) => [...newPapers, ...prev]);
    }

    toast({
      title: "Bulk import complete",
      description: `${addedIds.length} added, ${skippedIds.length} skipped (duplicates), ${failedIds.length} failed.`,
    });
  };

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
   * Updates local state immediately and persists changes to DB.
   */
  const reevaluateStudyTypes = useCallback(async (pool: StudyTypePoolEntry[], deletedTypeNames?: string[]) => {
    if (papers.length === 0) return;

    const updates: { id: string; newType: string }[] = [];

    for (const paper of papers) {
      // Use the preserved raw_study_type (original PubMed value) for re-evaluation fallback
      const rawFallback = (paper as any).raw_study_type ?? paper.study_type;

      const newType = evaluateStudyType(
        paper.title,
        paper.abstract,
        rawFallback,
        pool
      );

      const current = (paper.study_type || "").trim();
      const evaluated = (newType || "").trim();

      if (current !== evaluated) {
        updates.push({ id: paper.id, newType: evaluated });
      }
    }

    if (updates.length === 0) return;

    // Update local state immediately
    setPapers(prev =>
      prev.map(p => {
        const upd = updates.find(u => u.id === p.id);
        return upd ? { ...p, study_type: upd.newType || null } : p;
      })
    );

    // Persist to DB
    try {
      await Promise.all(
        updates.map(({ id, newType }) =>
          supabase
            .from("papers")
            .update({ study_type: newType || null } as any)
            .eq("id", id)
        )
      );
      toast({
        title: "Study types updated",
        description: `Re-classified ${updates.length} paper(s) based on updated pool.`,
      });
    } catch (err: any) {
      toast({
        title: "Error saving study type updates",
        description: err.message,
        variant: "destructive",
      });
    }
  }, [papers, toast]);

  const bulkDeletePapers = async (paperIds: string[]) => {
    if (paperIds.length === 0) return;
    const { error } = await supabase.from("papers").delete().in("id", paperIds);
    if (error) {
      toast({ title: "Error deleting papers", description: error.message, variant: "destructive" });
      return;
    }
    const idSet = new Set(paperIds);
    setPapers(prev => prev.filter(p => !idSet.has(p.id)));
    toast({ title: `Deleted ${paperIds.length} paper(s)` });
  };

  const bulkSetProjects = async (paperIds: string[], projectIds: string[]) => {
    if (paperIds.length === 0) return;
    try {
      // Remove existing project links for selected papers
      await supabase.from("paper_projects").delete().in("paper_id", paperIds);
      // Insert new links
      if (projectIds.length > 0) {
        const rows = paperIds.flatMap(paperId =>
          projectIds.map(projectId => ({ paper_id: paperId, project_id: projectId }))
        );
        const { error } = await supabase.from("paper_projects").insert(rows);
        if (error) throw error;
      }
      // Update local state
      const newProjects = projects.filter(p => projectIds.includes(p.id));
      setPapers(prev => prev.map(p => {
        if (!paperIds.includes(p.id)) return p;
        return { ...p, projects: newProjects };
      }));
      toast({ title: `Updated projects for ${paperIds.length} paper(s)` });
    } catch (err: any) {
      toast({ title: "Error setting projects", description: err.message, variant: "destructive" });
    }
  };

  const bulkSetTags = async (paperIds: string[], tagIds: string[]) => {
    if (paperIds.length === 0) return;
    try {
      await supabase.from("paper_tags").delete().in("paper_id", paperIds);
      if (tagIds.length > 0) {
        const rows = paperIds.flatMap(paperId =>
          tagIds.map(tagId => ({ paper_id: paperId, tag_id: tagId }))
        );
        const { error } = await supabase.from("paper_tags").insert(rows);
        if (error) throw error;
      }
      const newTags = tags.filter(t => tagIds.includes(t.id));
      setPapers(prev => prev.map(p => {
        if (!paperIds.includes(p.id)) return p;
        return { ...p, tags: newTags };
      }));
      toast({ title: `Updated tags for ${paperIds.length} paper(s)` });
    } catch (err: any) {
      toast({ title: "Error setting tags", description: err.message, variant: "destructive" });
    }
  };

  return {
    papers,
    projects,
    tags,
    loading,
    allKeywords,
    createProject,
    updateProject,
    deleteProject,
    createTag,
    updateTag,
    deleteTag,
    addPapers,
    addPaperManually,
    bulkImportPapers,
    updatePaper,
    deletePaper,
    bulkDeletePapers,
    bulkSetProjects,
    bulkSetTags,
    reevaluateStudyTypes,
    refetch: fetchData,
  };
}
