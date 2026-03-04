import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/errorUtils";
import { queryKeys } from "@/lib/queryKeys";

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

interface ExclusionData {
  excludedKeywords: ExcludedKeyword[];
  excludedStudyTypes: ExcludedStudyType[];
}

export function useExclusionPools(userId: string | undefined) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading: loading } = useQuery({
    queryKey: queryKeys.exclusions.all(userId!),
    queryFn: async (): Promise<ExclusionData> => {
      const [keywordsRes, studyTypesRes] = await Promise.all([
        supabase
          .from("keyword_exclusion_pool")
          .select("*")
          .eq("user_id", userId!)
          .order("keyword"),
        supabase
          .from("study_type_exclusion_pool")
          .select("*")
          .eq("user_id", userId!)
          .order("study_type"),
      ]);

      if (keywordsRes.error) throw keywordsRes.error;
      if (studyTypesRes.error) throw studyTypesRes.error;

      return {
        excludedKeywords: (keywordsRes.data as ExcludedKeyword[]) || [],
        excludedStudyTypes: (studyTypesRes.data as ExcludedStudyType[]) || [],
      };
    },
    enabled: !!userId,
  });

  const excludedKeywords = data?.excludedKeywords ?? [];
  const excludedStudyTypes = data?.excludedStudyTypes ?? [];

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
      const { data: insertedData, error } = await supabase
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

      queryClient.setQueryData(
        queryKeys.exclusions.all(userId),
        (old: ExclusionData | undefined) => ({
          excludedKeywords: [...(old?.excludedKeywords ?? []), insertedData as ExcludedKeyword].sort(
            (a, b) => a.keyword.localeCompare(b.keyword)
          ),
          excludedStudyTypes: old?.excludedStudyTypes ?? [],
        })
      );
      return true;
    } catch (error: unknown) {
      toast({
        title: "Error adding excluded keyword",
        description: getErrorMessage(error),
        variant: "destructive",
      });
      return false;
    }
  };

  const deleteExcludedKeyword = async (id: string) => {
    if (!userId) return;
    try {
      const { error } = await supabase
        .from("keyword_exclusion_pool")
        .delete()
        .eq("id", id);

      if (error) throw error;

      queryClient.setQueryData(
        queryKeys.exclusions.all(userId),
        (old: ExclusionData | undefined) => ({
          excludedKeywords: (old?.excludedKeywords ?? []).filter((ek) => ek.id !== id),
          excludedStudyTypes: old?.excludedStudyTypes ?? [],
        })
      );
    } catch (error: unknown) {
      toast({
        title: "Error removing excluded keyword",
        description: getErrorMessage(error),
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

      queryClient.setQueryData(
        queryKeys.exclusions.all(userId),
        (old: ExclusionData | undefined) => ({
          excludedKeywords: [],
          excludedStudyTypes: old?.excludedStudyTypes ?? [],
        })
      );
      toast({ title: "Keyword exclusions cleared" });
    } catch (error: unknown) {
      toast({
        title: "Error clearing keyword exclusions",
        description: getErrorMessage(error),
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
      const { data: insertedData, error } = await supabase
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

      queryClient.setQueryData(
        queryKeys.exclusions.all(userId),
        (old: ExclusionData | undefined) => ({
          excludedKeywords: old?.excludedKeywords ?? [],
          excludedStudyTypes: [...(old?.excludedStudyTypes ?? []), insertedData as ExcludedStudyType].sort(
            (a, b) => a.study_type.localeCompare(b.study_type)
          ),
        })
      );
      return true;
    } catch (error: unknown) {
      toast({
        title: "Error adding excluded study type",
        description: getErrorMessage(error),
        variant: "destructive",
      });
      return false;
    }
  };

  const deleteExcludedStudyType = async (id: string) => {
    if (!userId) return;
    try {
      const { error } = await supabase
        .from("study_type_exclusion_pool")
        .delete()
        .eq("id", id);

      if (error) throw error;

      queryClient.setQueryData(
        queryKeys.exclusions.all(userId),
        (old: ExclusionData | undefined) => ({
          excludedKeywords: old?.excludedKeywords ?? [],
          excludedStudyTypes: (old?.excludedStudyTypes ?? []).filter((est) => est.id !== id),
        })
      );
    } catch (error: unknown) {
      toast({
        title: "Error removing excluded study type",
        description: getErrorMessage(error),
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

      queryClient.setQueryData(
        queryKeys.exclusions.all(userId),
        (old: ExclusionData | undefined) => ({
          excludedKeywords: old?.excludedKeywords ?? [],
          excludedStudyTypes: [],
        })
      );
      toast({ title: "Study type exclusions cleared" });
    } catch (error: unknown) {
      toast({
        title: "Error clearing study type exclusions",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    }
  };

  // Get the set of excluded keywords for display filtering
  const getExcludedKeywordSet = useCallback(() => {
    return new Set(excludedKeywords.map((ek) => ek.keyword.toLowerCase()));
  }, [excludedKeywords]);

  // Get the set of excluded study types for display filtering
  const getExcludedStudyTypeSet = useCallback(() => {
    return new Set(excludedStudyTypes.map((est) => est.study_type.toLowerCase()));
  }, [excludedStudyTypes]);

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
    getExcludedKeywordSet,
    getExcludedStudyTypeSet,
    refetch: () => queryClient.invalidateQueries({ queryKey: queryKeys.exclusions.all(userId!) }),
  };
}
