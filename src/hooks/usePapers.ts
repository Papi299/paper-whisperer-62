import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Paper, PaperWithTags, Project, Tag } from "@/types/database";
import { useToast } from "@/hooks/use-toast";
import { normalizePaperData, NormalizationConfig, RawPaperData } from "@/lib/normalizePaperData";

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

      // Fetch papers with their tags
      const { data: papersData, error: papersError } = await supabase
        .from("papers")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (papersError) throw papersError;

      // Fetch paper_tags
      const { data: paperTagsData, error: paperTagsError } = await supabase
        .from("paper_tags")
        .select("*");

      if (paperTagsError) throw paperTagsError;

      // Combine papers with their tags and projects
      const papersWithTags: PaperWithTags[] = ((papersData as Paper[]) || []).map((paper) => {
        const paperTagIds = (paperTagsData || [])
          .filter((pt: { paper_id: string; tag_id: string }) => pt.paper_id === paper.id)
          .map((pt: { tag_id: string }) => pt.tag_id);
        const paperTags = (tagsData as Tag[] || []).filter((t) => paperTagIds.includes(t.id));
        const project = (projectsData as Project[] || []).find((p) => p.id === paper.project_id) || null;
        return { ...paper, tags: paperTags, project };
      });

      setPapers(papersWithTags);
    } catch (error: any) {
      toast({
        title: "Error loading data",
        description: error.message,
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
    const { error } = await supabase
      .from("projects")
      .update(updates)
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
      prev.map((p) =>
        p.project_id === projectId ? { ...p, project: updatedProject } : p
      )
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
      prev.map((p) =>
        p.project_id === projectId ? { ...p, project_id: null, project: null } : p
      )
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
    // Propagate to embedded paper references
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
      const { data, error } = await supabase.functions.invoke("fetch-paper-metadata", {
        body: { identifiers },
      });

      if (error) throw error;

      const fetchedPapers = data.results || [];
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

        // Notify user if data came from Crossref fallback
        if (result.source === "crossref") {
          toast({
            title: "Paper fetched via Crossref",
            description: `"${result.title}" — PubMed unavailable. Some metadata (MeSH terms, keywords) may be limited.`,
          });
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
          drive_url: driveUrl || null,
        };

        const normalized = normalizationConfig
          ? normalizePaperData(rawPaper, normalizationConfig)
          : rawPaper;

        const paperData = {
          user_id: userId,
          ...normalized,
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

        successfulPapers.push({ ...(insertedPaper as Paper), tags: [], project: null });
      }

      setPapers((prev) => [...successfulPapers, ...prev]);

      if (successfulPapers.length > 0) {
        toast({
          title: "Papers added",
          description: `Successfully added ${successfulPapers.length} paper(s).`,
        });
      }
    } catch (error: any) {
      toast({
        title: "Error fetching papers",
        description: error.message,
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

    const rawPaper: RawPaperData = {
      title: paperData.title.trim(),
      authors: authorsArray,
      year: yearNum,
      journal: paperData.journal.trim() || null,
      pmid: paperData.pmid.trim() || null,
      doi: paperData.doi.trim() || null,
      abstract: paperData.abstract.trim() || null,
      keywords: keywordsArray,
      mesh_terms: [],
      substances: [],
      study_type: null,
      pubmed_url: paperData.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paperData.pmid.trim()}/` : null,
      journal_url: null,
      drive_url: paperData.driveUrl.trim() || null,
    };

    const normalized = normalizationConfig
      ? normalizePaperData(rawPaper, normalizationConfig)
      : rawPaper;

    const insertData = {
      user_id: userId,
      ...normalized,
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

    setPapers((prev) => [{ ...(insertedPaper as Paper), tags: [], project: null }, ...prev]);
    toast({ title: "Paper added manually" });
  };

  const updatePaper = async (
    paperId: string,
    updates: Partial<Paper> & { tagIds?: string[] }
  ) => {
    const { tagIds, ...paperUpdates } = updates;

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

    // Update tags if provided
    if (tagIds !== undefined) {
      // Delete existing tags
      await supabase.from("paper_tags").delete().eq("paper_id", paperId);

      // Insert new tags
      if (tagIds.length > 0) {
        await supabase.from("paper_tags").insert(
          tagIds.map((tagId) => ({ paper_id: paperId, tag_id: tagId }))
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
        const project =
          paperUpdates.project_id !== undefined
            ? projects.find((pr) => pr.id === paperUpdates.project_id) || null
            : p.project;
        return { ...p, ...paperUpdates, tags: updatedTags, project };
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

  // Extract all unique keywords from papers
  const allKeywords = useMemo(() => {
    const keywordSet = new Set<string>();
    papers.forEach((paper) => {
      paper.keywords.forEach((kw) => keywordSet.add(kw));
    });
    return Array.from(keywordSet).sort();
  }, [papers]);

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
    updatePaper,
    deletePaper,
    refetch: fetchData,
  };
}
