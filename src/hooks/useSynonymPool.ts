import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { queryKeys } from "@/lib/queryKeys";

export interface Synonym {
  id: string;
  canonical_term: string;
  synonyms: string[];
  user_id: string;
  created_at: string;
}

export function useSynonymPool(userId: string | undefined) {
  const queryClient = useQueryClient();

  const {
    data: synonymGroups = [],
    isLoading: loading,
  } = useQuery({
    queryKey: queryKeys.synonymPool.all(userId!),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("synonym_pool")
        .select("*")
        .eq("user_id", userId!)
        .order("canonical_term", { ascending: true });
      if (error) throw error;
      return (data as Synonym[]) ?? [];
    },
    enabled: !!userId,
  });

  const addSynonymGroup = useCallback(
    async (canonicalTerm: string, synonyms: string[]) => {
      if (!userId) return;

      // Client-side uniqueness check
      const exists = synonymGroups.some(
        (g) => g.canonical_term.toLowerCase() === canonicalTerm.toLowerCase()
      );
      if (exists) {
        toast.error("A synonym group with this canonical term already exists");
        return;
      }

      try {
        const { error } = await supabase.from("synonym_pool").insert({
          user_id: userId,
          canonical_term: canonicalTerm,
          synonyms: synonyms.map((s) => s.toLowerCase()),
        });

        if (error) {
          // Handle DB unique constraint violation gracefully
          if (error.code === "23505") {
            toast.error("A synonym group with this canonical term already exists");
            return;
          }
          throw error;
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.synonymPool.all(userId) });
        toast.success(`Synonym group "${canonicalTerm}" added`);
      } catch (error) {
        console.error("Error adding synonym group:", error);
        toast.error("Failed to add synonym group");
      }
    },
    [userId, queryClient, synonymGroups]
  );

  const updateSynonymGroup = useCallback(
    async (id: string, canonicalTerm: string, synonyms: string[]) => {
      if (!userId) return;

      // Client-side uniqueness check (exclude current group)
      const exists = synonymGroups.some(
        (g) => g.id !== id && g.canonical_term.toLowerCase() === canonicalTerm.toLowerCase()
      );
      if (exists) {
        toast.error("A synonym group with this canonical term already exists");
        return;
      }

      try {
        const { error } = await supabase
          .from("synonym_pool")
          .update({
            canonical_term: canonicalTerm,
            synonyms: synonyms.map((s) => s.toLowerCase()),
          })
          .eq("id", id)
          .eq("user_id", userId);

        if (error) {
          if (error.code === "23505") {
            toast.error("A synonym group with this canonical term already exists");
            return;
          }
          throw error;
        }

        queryClient.setQueryData(
          queryKeys.synonymPool.all(userId),
          (old: Synonym[] = []) =>
            old.map((sg) =>
              sg.id === id
                ? { ...sg, canonical_term: canonicalTerm, synonyms: synonyms.map((s) => s.toLowerCase()) }
                : sg
            )
        );
        toast.success(`Synonym group "${canonicalTerm}" updated`);
      } catch (error) {
        console.error("Error updating synonym group:", error);
        toast.error("Failed to update synonym group");
      }
    },
    [userId, queryClient, synonymGroups]
  );

  const deleteSynonymGroup = useCallback(
    async (id: string) => {
      if (!userId) return;
      try {
        const { error } = await supabase
          .from("synonym_pool")
          .delete()
          .eq("id", id)
          .eq("user_id", userId);

        if (error) throw error;

        // Optimistic update — remove from cache
        queryClient.setQueryData(
          queryKeys.synonymPool.all(userId),
          (old: Synonym[] = []) => old.filter((sg) => sg.id !== id)
        );
        toast.success("Synonym group deleted");
      } catch (error) {
        console.error("Error deleting synonym group:", error);
        toast.error("Failed to delete synonym group");
      }
    },
    [userId, queryClient]
  );

  // Build a lookup map from synonyms -> canonical term
  const synonymLookup = useMemo(() => {
    const lookup: Record<string, string> = {};
    synonymGroups.forEach((group) => {
      // The canonical term maps to itself
      lookup[group.canonical_term.toLowerCase()] = group.canonical_term;
      // Each synonym maps to the canonical term
      group.synonyms.forEach((syn) => {
        lookup[syn.toLowerCase()] = group.canonical_term;
      });
    });
    return lookup;
  }, [synonymGroups]);

  // Function to normalize a keyword using the synonym lookup
  const normalizeKeyword = useCallback(
    (keyword: string): string => {
      const normalized = synonymLookup[keyword.toLowerCase()];
      return normalized || keyword;
    },
    [synonymLookup]
  );

  return {
    synonymGroups,
    loading,
    addSynonymGroup,
    updateSynonymGroup,
    deleteSynonymGroup,
    normalizeKeyword,
    synonymLookup,
  };
}
