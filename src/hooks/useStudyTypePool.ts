import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface PoolStudyType {
  id: string;
  user_id: string;
  study_type: string;
  created_at: string;
}

export function useStudyTypePool(userId: string | undefined) {
  const [poolStudyTypes, setPoolStudyTypes] = useState<PoolStudyType[]>([]);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const fetchPoolStudyTypes = useCallback(async () => {
    if (!userId) return;

    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("study_type_pool")
        .select("*")
        .eq("user_id", userId)
        .order("study_type");

      if (error) throw error;

      setPoolStudyTypes((data as PoolStudyType[]) || []);
    } catch (error: any) {
      toast({
        title: "Error loading study type pool",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [userId, toast]);

  useEffect(() => {
    fetchPoolStudyTypes();
  }, [fetchPoolStudyTypes]);

  const addStudyType = async (studyType: string) => {
    if (!userId) return false;

    const trimmed = studyType.trim();
    if (!trimmed) return false;

    // Check if already exists
    if (poolStudyTypes.some((st) => st.study_type.toLowerCase() === trimmed.toLowerCase())) {
      toast({
        title: "Study type exists",
        description: `"${trimmed}" is already in your pool.`,
        variant: "destructive",
      });
      return false;
    }

    try {
      const { data, error } = await supabase
        .from("study_type_pool")
        .insert({ user_id: userId, study_type: trimmed })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast({
            title: "Study type exists",
            description: `"${trimmed}" is already in your pool.`,
            variant: "destructive",
          });
        } else {
          throw error;
        }
        return false;
      }

      setPoolStudyTypes((prev) =>
        [...prev, data as PoolStudyType].sort((a, b) =>
          a.study_type.localeCompare(b.study_type)
        )
      );
      return true;
    } catch (error: any) {
      toast({
        title: "Error adding study type",
        description: error.message,
        variant: "destructive",
      });
      return false;
    }
  };

  const addMultipleStudyTypes = async (studyTypes: string[]) => {
    if (!userId) return 0;

    const existingLower = new Set(poolStudyTypes.map((st) => st.study_type.toLowerCase()));
    const uniqueNew = studyTypes
      .map((st) => st.trim())
      .filter((st) => st && !existingLower.has(st.toLowerCase()));

    if (uniqueNew.length === 0) {
      toast({
        title: "No new study types",
        description: "All study types are already in your pool.",
      });
      return 0;
    }

    try {
      const { data, error } = await supabase
        .from("study_type_pool")
        .insert(uniqueNew.map((study_type) => ({ user_id: userId, study_type })))
        .select();

      if (error) throw error;

      setPoolStudyTypes((prev) =>
        [...prev, ...((data as PoolStudyType[]) || [])].sort((a, b) =>
          a.study_type.localeCompare(b.study_type)
        )
      );

      toast({
        title: "Study types added",
        description: `Added ${(data as PoolStudyType[])?.length || 0} study type(s) to your pool.`,
      });

      return (data as PoolStudyType[])?.length || 0;
    } catch (error: any) {
      toast({
        title: "Error adding study types",
        description: error.message,
        variant: "destructive",
      });
      return 0;
    }
  };

  const deleteStudyType = async (id: string) => {
    try {
      const { error } = await supabase
        .from("study_type_pool")
        .delete()
        .eq("id", id);

      if (error) throw error;

      setPoolStudyTypes((prev) => prev.filter((st) => st.id !== id));
    } catch (error: any) {
      toast({
        title: "Error deleting study type",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const deleteAllStudyTypes = async () => {
    if (!userId) return;

    try {
      const { error } = await supabase
        .from("study_type_pool")
        .delete()
        .eq("user_id", userId);

      if (error) throw error;

      setPoolStudyTypes([]);
      toast({ title: "Study type pool cleared" });
    } catch (error: any) {
      toast({
        title: "Error clearing study type pool",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  // Find study types from the pool that appear in a paper title
  const findMatchingStudyTypes = useCallback(
    (title: string): string[] => {
      if (!title) return [];
      const lowerTitle = title.toLowerCase();
      return poolStudyTypes
        .filter((st) => lowerTitle.includes(st.study_type.toLowerCase()))
        .map((st) => st.study_type);
    },
    [poolStudyTypes]
  );

  return {
    poolStudyTypes,
    loading,
    addStudyType,
    addMultipleStudyTypes,
    deleteStudyType,
    deleteAllStudyTypes,
    findMatchingStudyTypes,
    refetch: fetchPoolStudyTypes,
  };
}
