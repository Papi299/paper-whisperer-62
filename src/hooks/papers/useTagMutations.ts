import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Tag } from "@/types/database";
import { queryKeys } from "@/lib/queryKeys";
import { usePaperCacheHelpers } from "./usePaperCacheHelpers";

export function useTagMutations(userId: string | undefined, tags: Tag[]) {
  const {
    snapshotCache,
    rollbackCache,
    cancelQueries,
    updatePapersCache,
    updateMetaCache,
    adjustCount,
  } = usePaperCacheHelpers(userId);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createTag = useCallback(
    async (name: string) => {
      if (!userId) return;

      const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        toast({ title: "Tag exists", description: `Using existing tag "${existing.name}".` });
        return;
      }

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
    },
    [userId, tags, updateMetaCache, toast],
  );

  const updateTag = useCallback(
    async (tagId: string, updates: Partial<Tag>) => {
      if (!userId) return;

      await cancelQueries();
      const snapshot = snapshotCache();

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
    },
    [userId, cancelQueries, snapshotCache, updateMetaCache, updatePapersCache, rollbackCache, toast],
  );

  const deleteTag = useCallback(
    async (tagId: string) => {
      if (!userId) return;

      await cancelQueries();
      const snapshot = snapshotCache();

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
    },
    [userId, cancelQueries, snapshotCache, updateMetaCache, updatePapersCache, rollbackCache, toast],
  );

  return { createTag, updateTag, deleteTag };
}
