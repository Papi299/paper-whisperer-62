import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/errorUtils";
import { queryKeys } from "@/lib/queryKeys";

export interface PoolStudyType {
  id: string;
  user_id: string;
  study_type: string;
  specificity_weight: number;
  group_name: string | null;
  hierarchy_rank: number;
  created_at: string;
}

export function useStudyTypePool(userId: string | undefined) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const {
    data: poolStudyTypes = [],
    isLoading: loading,
  } = useQuery({
    queryKey: queryKeys.studyTypePool.all(userId!),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("study_type_pool")
        .select("*")
        .eq("user_id", userId!)
        .order("study_type");
      if (error) throw error;
      return (data as PoolStudyType[]) || [];
    },
    enabled: !!userId,
  });

  const addStudyType = async (studyType: string, groupName?: string | null, hierarchyRank?: number) => {
    if (!userId) return false;
    const trimmed = studyType.trim();
    if (!trimmed) return false;

    if (poolStudyTypes.some((st) => st.study_type.toLowerCase() === trimmed.toLowerCase())) {
      toast({ title: "Study type exists", description: `"${trimmed}" is already in your pool.`, variant: "destructive" });
      return false;
    }

    try {
      const insertData: { user_id: string; study_type: string; group_name?: string | null; hierarchy_rank?: number } = { user_id: userId, study_type: trimmed };
      if (groupName !== undefined) insertData.group_name = groupName;
      if (hierarchyRank !== undefined) insertData.hierarchy_rank = hierarchyRank;

      const { data, error } = await supabase
        .from("study_type_pool")
        .insert(insertData)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast({ title: "Study type exists", description: `"${trimmed}" is already in your pool.`, variant: "destructive" });
        } else throw error;
        return false;
      }

      queryClient.setQueryData(
        queryKeys.studyTypePool.all(userId),
        (old: PoolStudyType[] = []) =>
          [...old, data as PoolStudyType].sort((a, b) => a.study_type.localeCompare(b.study_type))
      );
      return true;
    } catch (error: unknown) {
      toast({ title: "Error adding study type", description: getErrorMessage(error), variant: "destructive" });
      return false;
    }
  };

  const addMultipleStudyTypes = async (studyTypes: string[]) => {
    if (!userId) return 0;
    const existingLower = new Set(poolStudyTypes.map((st) => st.study_type.toLowerCase()));
    const uniqueNew = studyTypes.map((st) => st.trim()).filter((st) => st && !existingLower.has(st.toLowerCase()));
    if (uniqueNew.length === 0) {
      toast({ title: "No new study types", description: "All study types are already in your pool." });
      return 0;
    }
    try {
      const { data, error } = await supabase
        .from("study_type_pool")
        .insert(uniqueNew.map((study_type) => ({ user_id: userId, study_type })))
        .select();
      if (error) throw error;

      queryClient.setQueryData(
        queryKeys.studyTypePool.all(userId),
        (old: PoolStudyType[] = []) =>
          [...old, ...((data as PoolStudyType[]) || [])].sort((a, b) => a.study_type.localeCompare(b.study_type))
      );
      toast({ title: "Study types added", description: `Added ${(data as PoolStudyType[])?.length || 0} study type(s).` });
      return (data as PoolStudyType[])?.length || 0;
    } catch (error: unknown) {
      toast({ title: "Error adding study types", description: getErrorMessage(error), variant: "destructive" });
      return 0;
    }
  };

  const updateStudyType = async (id: string, updates: Partial<Pick<PoolStudyType, "study_type" | "group_name" | "hierarchy_rank">>) => {
    if (!userId) return;
    try {
      const { error } = await supabase
        .from("study_type_pool")
        .update(updates)
        .eq("id", id);
      if (error) throw error;

      queryClient.setQueryData(
        queryKeys.studyTypePool.all(userId),
        (old: PoolStudyType[] = []) =>
          old.map((st) => (st.id === id ? { ...st, ...updates } : st))
      );
    } catch (error: unknown) {
      toast({ title: "Error updating study type", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  const deleteStudyType = async (id: string) => {
    if (!userId) return;
    try {
      const { error } = await supabase.from("study_type_pool").delete().eq("id", id);
      if (error) throw error;

      queryClient.setQueryData(
        queryKeys.studyTypePool.all(userId),
        (old: PoolStudyType[] = []) => old.filter((st) => st.id !== id)
      );
    } catch (error: unknown) {
      toast({ title: "Error deleting study type", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  const deleteAllStudyTypes = async () => {
    if (!userId) return;
    try {
      const { error } = await supabase.from("study_type_pool").delete().eq("user_id", userId);
      if (error) throw error;

      queryClient.setQueryData(queryKeys.studyTypePool.all(userId), []);
      toast({ title: "Study type pool cleared" });
    } catch (error: unknown) {
      toast({ title: "Error clearing study type pool", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  const renameGroup = async (oldName: string, newName: string, newRank?: number) => {
    if (!userId) return;
    try {
      const updateData: { group_name: string; hierarchy_rank?: number } = { group_name: newName };
      if (newRank !== undefined) updateData.hierarchy_rank = newRank;

      const { error } = await supabase
        .from("study_type_pool")
        .update(updateData)
        .eq("user_id", userId)
        .eq("group_name", oldName);
      if (error) throw error;

      queryClient.setQueryData(
        queryKeys.studyTypePool.all(userId),
        (old: PoolStudyType[] = []) =>
          old.map((st) =>
            st.group_name === oldName
              ? { ...st, group_name: newName, ...(newRank !== undefined ? { hierarchy_rank: newRank } : {}) }
              : st
          )
      );
      toast({ title: "Group updated" });
    } catch (error: unknown) {
      toast({ title: "Error updating group", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  const deleteGroup = async (groupName: string) => {
    if (!userId) return;
    try {
      const { error } = await supabase
        .from("study_type_pool")
        .update({ group_name: null, hierarchy_rank: 99 })
        .eq("user_id", userId)
        .eq("group_name", groupName);
      if (error) throw error;

      queryClient.setQueryData(
        queryKeys.studyTypePool.all(userId),
        (old: PoolStudyType[] = []) =>
          old.map((st) =>
            st.group_name === groupName ? { ...st, group_name: null, hierarchy_rank: 99 } : st
          )
      );
      toast({ title: "Group deleted", description: "Study types moved to standalone (rank 99)." });
    } catch (error: unknown) {
      toast({ title: "Error deleting group", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  return {
    poolStudyTypes,
    loading,
    addStudyType,
    addMultipleStudyTypes,
    updateStudyType,
    deleteStudyType,
    deleteAllStudyTypes,
    renameGroup,
    deleteGroup,
    refetch: () => queryClient.invalidateQueries({ queryKey: queryKeys.studyTypePool.all(userId!) }),
  };
}
