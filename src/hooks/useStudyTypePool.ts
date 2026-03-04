import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/errorUtils";

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
    } catch (error: unknown) {
      toast({ title: "Error loading study type pool", description: getErrorMessage(error), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [userId, toast]);

  useEffect(() => { fetchPoolStudyTypes(); }, [fetchPoolStudyTypes]);

  const addStudyType = async (studyType: string, groupName?: string | null, hierarchyRank?: number) => {
    if (!userId) return false;
    const trimmed = studyType.trim();
    if (!trimmed) return false;

    if (poolStudyTypes.some(st => st.study_type.toLowerCase() === trimmed.toLowerCase())) {
      toast({ title: "Study type exists", description: `"${trimmed}" is already in your pool.`, variant: "destructive" });
      return false;
    }

    try {
      const insertData: any = { user_id: userId, study_type: trimmed };
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
      setPoolStudyTypes(prev => [...prev, data as PoolStudyType].sort((a, b) => a.study_type.localeCompare(b.study_type)));
      return true;
    } catch (error: unknown) {
      toast({ title: "Error adding study type", description: getErrorMessage(error), variant: "destructive" });
      return false;
    }
  };

  const addMultipleStudyTypes = async (studyTypes: string[]) => {
    if (!userId) return 0;
    const existingLower = new Set(poolStudyTypes.map(st => st.study_type.toLowerCase()));
    const uniqueNew = studyTypes.map(st => st.trim()).filter(st => st && !existingLower.has(st.toLowerCase()));
    if (uniqueNew.length === 0) {
      toast({ title: "No new study types", description: "All study types are already in your pool." });
      return 0;
    }
    try {
      const { data, error } = await supabase
        .from("study_type_pool")
        .insert(uniqueNew.map(study_type => ({ user_id: userId, study_type })) as any)
        .select();
      if (error) throw error;
      setPoolStudyTypes(prev => [...prev, ...((data as PoolStudyType[]) || [])].sort((a, b) => a.study_type.localeCompare(b.study_type)));
      toast({ title: "Study types added", description: `Added ${(data as PoolStudyType[])?.length || 0} study type(s).` });
      return (data as PoolStudyType[])?.length || 0;
    } catch (error: unknown) {
      toast({ title: "Error adding study types", description: getErrorMessage(error), variant: "destructive" });
      return 0;
    }
  };

  const updateStudyType = async (id: string, updates: Partial<Pick<PoolStudyType, 'study_type' | 'group_name' | 'hierarchy_rank'>>) => {
    try {
      const { error } = await supabase
        .from("study_type_pool")
        .update(updates as any)
        .eq("id", id);
      if (error) throw error;
      setPoolStudyTypes(prev => prev.map(st => st.id === id ? { ...st, ...updates } : st));
    } catch (error: unknown) {
      toast({ title: "Error updating study type", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  const deleteStudyType = async (id: string) => {
    try {
      const { error } = await supabase.from("study_type_pool").delete().eq("id", id);
      if (error) throw error;
      setPoolStudyTypes(prev => prev.filter(st => st.id !== id));
    } catch (error: unknown) {
      toast({ title: "Error deleting study type", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  const deleteAllStudyTypes = async () => {
    if (!userId) return;
    try {
      const { error } = await supabase.from("study_type_pool").delete().eq("user_id", userId);
      if (error) throw error;
      setPoolStudyTypes([]);
      toast({ title: "Study type pool cleared" });
    } catch (error: unknown) {
      toast({ title: "Error clearing study type pool", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  // Rename a group: cascade update group_name and hierarchy_rank for all members
  const renameGroup = async (oldName: string, newName: string, newRank?: number) => {
    if (!userId) return;
    try {
      const updateData: any = { group_name: newName };
      if (newRank !== undefined) updateData.hierarchy_rank = newRank;

      const { error } = await (supabase
        .from("study_type_pool")
        .update(updateData)
        .eq("user_id", userId) as any)
        .eq("group_name", oldName);
      if (error) throw error;

      setPoolStudyTypes(prev =>
        prev.map(st => st.group_name === oldName ? { ...st, group_name: newName, ...(newRank !== undefined ? { hierarchy_rank: newRank } : {}) } : st)
      );
      toast({ title: "Group updated" });
    } catch (error: unknown) {
      toast({ title: "Error updating group", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  // Delete a group: set group_name=null, hierarchy_rank=99
  const deleteGroup = async (groupName: string) => {
    if (!userId) return;
    try {
      const { error } = await (supabase
        .from("study_type_pool")
        .update({ group_name: null, hierarchy_rank: 99 } as any)
        .eq("user_id", userId) as any)
        .eq("group_name", groupName);
      if (error) throw error;

      setPoolStudyTypes(prev =>
        prev.map(st => st.group_name === groupName ? { ...st, group_name: null, hierarchy_rank: 99 } : st)
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
    refetch: fetchPoolStudyTypes,
  };
}
