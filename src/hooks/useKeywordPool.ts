import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { extractContextualKeywords } from "@/lib/textUtils";
import { getErrorMessage } from "@/lib/errorUtils";

export interface PoolKeyword {
  id: string;
  user_id: string;
  keyword: string;
  created_at: string;
}

export function useKeywordPool(userId: string | undefined) {
  const [poolKeywords, setPoolKeywords] = useState<PoolKeyword[]>([]);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const fetchKeywords = useCallback(async () => {
    if (!userId) return;

    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("keyword_pool")
        .select("*")
        .eq("user_id", userId)
        .order("keyword");

      if (error) throw error;
      setPoolKeywords((data as PoolKeyword[]) || []);
    } catch (error: unknown) {
      toast({
        title: "Error loading keyword pool",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [userId, toast]);

  useEffect(() => {
    fetchKeywords();
  }, [fetchKeywords]);

  const addKeyword = async (keyword: string) => {
    if (!userId) return false;

    const trimmed = keyword.trim().toLowerCase();
    if (!trimmed) return false;

    // Check if already exists locally
    if (poolKeywords.some((pk) => pk.keyword.toLowerCase() === trimmed)) {
      toast({
        title: "Keyword exists",
        description: `"${trimmed}" is already in your pool.`,
        variant: "destructive",
      });
      return false;
    }

    try {
      const { data, error } = await supabase
        .from("keyword_pool")
        .insert({ user_id: userId, keyword: trimmed })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast({
            title: "Keyword exists",
            description: `"${trimmed}" is already in your pool.`,
            variant: "destructive",
          });
        } else {
          throw error;
        }
        return false;
      }

      setPoolKeywords((prev) =>
        [...prev, data as PoolKeyword].sort((a, b) =>
          a.keyword.localeCompare(b.keyword)
        )
      );
      return true;
    } catch (error: unknown) {
      toast({
        title: "Error adding keyword",
        description: getErrorMessage(error),
        variant: "destructive",
      });
      return false;
    }
  };

  const addMultipleKeywords = async (keywords: string[]) => {
    if (!userId) return 0;

    const uniqueKeywords = [...new Set(keywords.map((k) => k.trim().toLowerCase()))].filter(
      (k) => k && !poolKeywords.some((pk) => pk.keyword.toLowerCase() === k)
    );

    if (uniqueKeywords.length === 0) {
      toast({
        title: "No new keywords",
        description: "All keywords are already in your pool.",
      });
      return 0;
    }

    try {
      const { data, error } = await supabase
        .from("keyword_pool")
        .insert(uniqueKeywords.map((keyword) => ({ user_id: userId, keyword })))
        .select();

      if (error) throw error;

      setPoolKeywords((prev) =>
        [...prev, ...((data as PoolKeyword[]) || [])].sort((a, b) =>
          a.keyword.localeCompare(b.keyword)
        )
      );

      toast({
        title: "Keywords added",
        description: `Added ${data?.length || 0} keyword(s) to your pool.`,
      });

      return data?.length || 0;
    } catch (error: unknown) {
      toast({
        title: "Error adding keywords",
        description: getErrorMessage(error),
        variant: "destructive",
      });
      return 0;
    }
  };

  const deleteKeyword = async (keywordId: string) => {
    try {
      const { error } = await supabase
        .from("keyword_pool")
        .delete()
        .eq("id", keywordId);

      if (error) throw error;

      setPoolKeywords((prev) => prev.filter((pk) => pk.id !== keywordId));
    } catch (error: unknown) {
      toast({
        title: "Error deleting keyword",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    }
  };

  const deleteAllKeywords = async () => {
    if (!userId) return;

    try {
      const { error } = await supabase
        .from("keyword_pool")
        .delete()
        .eq("user_id", userId);

      if (error) throw error;

      setPoolKeywords([]);
      toast({ title: "Keyword pool cleared" });
    } catch (error: unknown) {
      toast({
        title: "Error clearing keyword pool",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    }
  };

  // Context-aware keyword scanner with negation detection
  const findMatchingKeywords = useCallback(
    (abstract: string | null): string[] => {
      if (!abstract) return [];
      return extractContextualKeywords(abstract, poolKeywords.map(pk => pk.keyword));
    },
    [poolKeywords]
  );

  return {
    poolKeywords,
    loading,
    addKeyword,
    addMultipleKeywords,
    deleteKeyword,
    deleteAllKeywords,
    findMatchingKeywords,
    refetch: fetchKeywords,
  };
}
