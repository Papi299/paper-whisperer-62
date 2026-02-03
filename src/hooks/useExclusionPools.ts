import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface ExcludedKeyword {
  id: string;
  user_id: string;
  keyword: string;
  created_at: string;
}

export interface ExcludedStudyType {
  id: string;
  user_id: string;
  study_type: string;
  created_at: string;
}

export function useExclusionPools(userId: string | undefined) {
  const [excludedKeywords, setExcludedKeywords] = useState<ExcludedKeyword[]>([]);
  const [excludedStudyTypes, setExcludedStudyTypes] = useState<ExcludedStudyType[]>([]);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const fetchExclusions = useCallback(async () => {
    if (!userId) return;

    setLoading(true);
    try {
      const [keywordsRes, studyTypesRes] = await Promise.all([
        supabase
          .from("keyword_exclusion_pool")
          .select("*")
          .eq("user_id", userId)
          .order("keyword"),
        supabase
          .from("study_type_exclusion_pool")
          .select("*")
          .eq("user_id", userId)
          .order("study_type"),
      ]);

      if (keywordsRes.error) throw keywordsRes.error;
      if (studyTypesRes.error) throw studyTypesRes.error;

      setExcludedKeywords((keywordsRes.data as ExcludedKeyword[]) || []);
      setExcludedStudyTypes((studyTypesRes.data as ExcludedStudyType[]) || []);
    } catch (error: any) {
      toast({
        title: "Error loading exclusions",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [userId, toast]);

  useEffect(() => {
    fetchExclusions();
  }, [fetchExclusions]);

  // Keyword exclusion methods
  const addExcludedKeyword = async (keyword: string) => {
    if (!userId) return false;

    const trimmed = keyword.trim().toLowerCase();
    if (!trimmed) return false;

    if (excludedKeywords.some((ek) => ek.keyword.toLowerCase() === trimmed)) {
      toast({
        title: "Keyword already excluded",
        description: `"${trimmed}" is already in your exclusion list.`,
        variant: "destructive",
      });
      return false;
    }

    try {
      const { data, error } = await supabase
        .from("keyword_exclusion_pool")
        .insert({ user_id: userId, keyword: trimmed })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast({
            title: "Keyword already excluded",
            description: `"${trimmed}" is already in your exclusion list.`,
            variant: "destructive",
          });
        } else {
          throw error;
        }
        return false;
      }

      setExcludedKeywords((prev) =>
        [...prev, data as ExcludedKeyword].sort((a, b) =>
          a.keyword.localeCompare(b.keyword)
        )
      );
      return true;
    } catch (error: any) {
      toast({
        title: "Error adding excluded keyword",
        description: error.message,
        variant: "destructive",
      });
      return false;
    }
  };

  const deleteExcludedKeyword = async (id: string) => {
    try {
      const { error } = await supabase
        .from("keyword_exclusion_pool")
        .delete()
        .eq("id", id);

      if (error) throw error;

      setExcludedKeywords((prev) => prev.filter((ek) => ek.id !== id));
    } catch (error: any) {
      toast({
        title: "Error removing excluded keyword",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const clearExcludedKeywords = async () => {
    if (!userId) return;

    try {
      const { error } = await supabase
        .from("keyword_exclusion_pool")
        .delete()
        .eq("user_id", userId);

      if (error) throw error;

      setExcludedKeywords([]);
      toast({ title: "Keyword exclusions cleared" });
    } catch (error: any) {
      toast({
        title: "Error clearing keyword exclusions",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  // Study type exclusion methods
  const addExcludedStudyType = async (studyType: string) => {
    if (!userId) return false;

    const trimmed = studyType.trim();
    if (!trimmed) return false;

    if (excludedStudyTypes.some((est) => est.study_type.toLowerCase() === trimmed.toLowerCase())) {
      toast({
        title: "Study type already excluded",
        description: `"${trimmed}" is already in your exclusion list.`,
        variant: "destructive",
      });
      return false;
    }

    try {
      const { data, error } = await supabase
        .from("study_type_exclusion_pool")
        .insert({ user_id: userId, study_type: trimmed })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast({
            title: "Study type already excluded",
            description: `"${trimmed}" is already in your exclusion list.`,
            variant: "destructive",
          });
        } else {
          throw error;
        }
        return false;
      }

      setExcludedStudyTypes((prev) =>
        [...prev, data as ExcludedStudyType].sort((a, b) =>
          a.study_type.localeCompare(b.study_type)
        )
      );
      return true;
    } catch (error: any) {
      toast({
        title: "Error adding excluded study type",
        description: error.message,
        variant: "destructive",
      });
      return false;
    }
  };

  const deleteExcludedStudyType = async (id: string) => {
    try {
      const { error } = await supabase
        .from("study_type_exclusion_pool")
        .delete()
        .eq("id", id);

      if (error) throw error;

      setExcludedStudyTypes((prev) => prev.filter((est) => est.id !== id));
    } catch (error: any) {
      toast({
        title: "Error removing excluded study type",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const clearExcludedStudyTypes = async () => {
    if (!userId) return;

    try {
      const { error } = await supabase
        .from("study_type_exclusion_pool")
        .delete()
        .eq("user_id", userId);

      if (error) throw error;

      setExcludedStudyTypes([]);
      toast({ title: "Study type exclusions cleared" });
    } catch (error: any) {
      toast({
        title: "Error clearing study type exclusions",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  // Check if a paper should be excluded
  const shouldExcludePaper = useCallback(
    (keywords: string[], studyType: string | null): boolean => {
      // Check keyword exclusions
      const excludedKeywordSet = new Set(excludedKeywords.map((ek) => ek.keyword.toLowerCase()));
      const hasExcludedKeyword = keywords.some((kw) =>
        excludedKeywordSet.has(kw.toLowerCase())
      );
      if (hasExcludedKeyword) return true;

      // Check study type exclusions
      if (studyType) {
        const isStudyTypeExcluded = excludedStudyTypes.some(
          (est) => est.study_type.toLowerCase() === studyType.toLowerCase()
        );
        if (isStudyTypeExcluded) return true;
      }

      return false;
    },
    [excludedKeywords, excludedStudyTypes]
  );

  return {
    excludedKeywords,
    excludedStudyTypes,
    loading,
    addExcludedKeyword,
    deleteExcludedKeyword,
    clearExcludedKeywords,
    addExcludedStudyType,
    deleteExcludedStudyType,
    clearExcludedStudyTypes,
    shouldExcludePaper,
    refetch: fetchExclusions,
  };
}
