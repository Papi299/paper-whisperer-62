import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Project } from "@/types/database";
import { usePaperCacheHelpers } from "./usePaperCacheHelpers";

export function useProjectMutations(userId: string | undefined, projects: Project[]) {
  const {
    snapshotCache,
    rollbackCache,
    cancelQueries,
    updatePapersCache,
    updateMetaCache,
  } = usePaperCacheHelpers(userId);
  const { toast } = useToast();

  const createProject = useCallback(
    async (name: string) => {
      if (!userId) return;

      const existing = projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        toast({ title: "Project exists", description: `Using existing project "${existing.name}".` });
        return;
      }

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
    },
    [userId, projects, updateMetaCache, toast],
  );

  const updateProject = useCallback(
    async (projectId: string, updates: Partial<Project>) => {
      if (!userId) return;

      await cancelQueries();
      const snapshot = snapshotCache();

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

      // Defense-in-depth: explicit `user_id` filter alongside the row
      // ID filter. RLS on `projects` is the primary boundary; this client
      // predicate makes ownership intent visible at the call site and
      // prevents an accidental cross-user write if RLS were ever loosened.
      // Follows the S2 client-side hardening pattern established by PR #133.
      const { error } = await supabase
        .from("projects")
        .update(dbUpdates)
        .eq("id", projectId)
        .eq("user_id", userId);
      if (error) {
        rollbackCache(snapshot);
        toast({ title: "Error updating project", description: error.message, variant: "destructive" });
      }
    },
    [userId, cancelQueries, snapshotCache, updateMetaCache, updatePapersCache, rollbackCache, toast],
  );

  const deleteProject = useCallback(
    async (projectId: string) => {
      if (!userId) return;

      await cancelQueries();
      const snapshot = snapshotCache();

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

      // Defense-in-depth: explicit `user_id` filter alongside the row ID
      // filter — same rationale as `updateProject` above.
      const { error } = await supabase
        .from("projects")
        .delete()
        .eq("id", projectId)
        .eq("user_id", userId);
      if (error) {
        rollbackCache(snapshot);
        toast({ title: "Error deleting project", description: error.message, variant: "destructive" });
      }
    },
    [userId, cancelQueries, snapshotCache, updateMetaCache, updatePapersCache, rollbackCache, toast],
  );

  return { createProject, updateProject, deleteProject };
}
