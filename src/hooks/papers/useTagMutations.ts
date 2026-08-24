import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Tag } from "@/types/database";
import { usePaperCacheHelpers } from "./usePaperCacheHelpers";
import type { ServerFilterParams, ServerSortParams } from "./types";

export function useTagMutations(
  userId: string | undefined,
  tags: Tag[],
  serverFilterParams: ServerFilterParams,
  serverSortParams: ServerSortParams,
) {
  const {
    snapshotCache,
    rollbackCache,
    cancelQueries,
    updatePapersCache,
    updateMetaCache,
  } = usePaperCacheHelpers(userId, serverFilterParams, serverSortParams);
  const { toast } = useToast();

  /**
   * Create a Tag, or resolve to the existing one under this hook's established
   * duplicate rule.
   *
   * **Return contract (added for AI-PROJECT-TAG-SUGGESTIONS-001B).** Mirrors
   * `createProject`: resolves to the Tag a caller may act on, or `null` when
   * nothing was proven to exist. Existing callers pass a name and ignore the
   * result; their behaviour is unchanged. Edit Paper's "Create & select" needs
   * the returned `id` to add it to the dialog's LOCAL selection, and `null` on
   * the error paths is what stops it selecting an id that may not exist.
   */
  const createTag = useCallback(
    async (name: string): Promise<Tag | null> => {
      if (!userId) return null;

      const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        toast({ title: "Tag exists", description: `Using existing tag "${existing.name}".` });
        // Deterministic under this hook's own rule — see `createProject` for
        // why returning it is safe and why ambiguity is reconciled by the
        // caller, before the call.
        return existing;
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
        return null;
      }

      updateMetaCache((oldProjects, oldTags) => ({
        projects: oldProjects,
        tags: [...oldTags, newTag as Tag],
      }));
      return newTag as Tag;
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

      // Defense-in-depth: explicit `user_id` filter alongside the row
      // ID filter. RLS on `tags` is the primary boundary; this client
      // predicate makes ownership intent visible at the call site and
      // prevents an accidental cross-user write if RLS were ever loosened.
      // Follows the S2 client-side hardening pattern established by PR #133.
      const { error } = await supabase
        .from("tags")
        .update(updates)
        .eq("id", tagId)
        .eq("user_id", userId);
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

      // Defense-in-depth: explicit `user_id` filter alongside the row ID
      // filter — same rationale as `updateTag` above.
      const { error } = await supabase
        .from("tags")
        .delete()
        .eq("id", tagId)
        .eq("user_id", userId);
      if (error) {
        rollbackCache(snapshot);
        toast({ title: "Error deleting tag", description: error.message, variant: "destructive" });
      }
    },
    [userId, cancelQueries, snapshotCache, updateMetaCache, updatePapersCache, rollbackCache, toast],
  );

  return { createTag, updateTag, deleteTag };
}
