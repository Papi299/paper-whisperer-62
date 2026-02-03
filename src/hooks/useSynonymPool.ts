import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface Synonym {
  id: string;
  canonical_term: string;
  synonyms: string[];
  user_id: string;
  created_at: string;
}

interface SynonymPoolRow {
  id: string;
  canonical_term: string;
  synonyms: string[];
  user_id: string;
  created_at: string;
}

export function useSynonymPool(userId: string | undefined) {
  const [synonymGroups, setSynonymGroups] = useState<Synonym[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchSynonymGroups = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("synonym_pool" as any)
        .select("*")
        .eq("user_id", userId)
        .order("canonical_term", { ascending: true });

      if (error) throw error;
      setSynonymGroups((data as unknown as SynonymPoolRow[]) || []);
    } catch (error) {
      console.error("Error fetching synonym groups:", error);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    fetchSynonymGroups();
  }, [userId, fetchSynonymGroups]);

  const addSynonymGroup = useCallback(
    async (canonicalTerm: string, synonyms: string[]) => {
      if (!userId) return;
      try {
        const { error } = await supabase.from("synonym_pool" as any).insert({
          user_id: userId,
          canonical_term: canonicalTerm,
          synonyms: synonyms.map((s) => s.toLowerCase()),
        } as any);

        if (error) throw error;
        await fetchSynonymGroups();
        toast.success(`Synonym group "${canonicalTerm}" added`);
      } catch (error) {
        console.error("Error adding synonym group:", error);
        toast.error("Failed to add synonym group");
      }
    },
    [userId, fetchSynonymGroups]
  );

  const updateSynonymGroup = useCallback(
    async (id: string, canonicalTerm: string, synonyms: string[]) => {
      if (!userId) return;
      try {
        const { error } = await supabase
          .from("synonym_pool" as any)
          .update({
            canonical_term: canonicalTerm,
            synonyms: synonyms.map((s) => s.toLowerCase()),
          } as any)
          .eq("id", id)
          .eq("user_id", userId);

        if (error) throw error;
        await fetchSynonymGroups();
        toast.success(`Synonym group "${canonicalTerm}" updated`);
      } catch (error) {
        console.error("Error updating synonym group:", error);
        toast.error("Failed to update synonym group");
      }
    },
    [userId, fetchSynonymGroups]
  );

  const deleteSynonymGroup = useCallback(
    async (id: string) => {
      if (!userId) return;
      try {
        const { error } = await supabase
          .from("synonym_pool" as any)
          .delete()
          .eq("id", id)
          .eq("user_id", userId);

        if (error) throw error;
        await fetchSynonymGroups();
        toast.success("Synonym group deleted");
      } catch (error) {
        console.error("Error deleting synonym group:", error);
        toast.error("Failed to delete synonym group");
      }
    },
    [userId, fetchSynonymGroups]
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
