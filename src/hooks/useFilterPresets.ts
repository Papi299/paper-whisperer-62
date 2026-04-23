import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";
import type { NotesPresence } from "@/hooks/papers/types";
import type { Project, Tag } from "@/types/database";
import { useToast } from "@/hooks/use-toast";

/**
 * Current payload schema version. Bump + branch in `parsePresetPayload`
 * if the persisted shape ever changes in a non-backward-compatible way.
 */
export const PRESET_PAYLOAD_VERSION = 1 as const;

/** Maximum allowed preset name length. */
export const PRESET_NAME_MAX_LENGTH = 80;

/**
 * The 8 filter fields we snapshot, plus a `version` sentinel. Saved verbatim:
 * `searchQuery` keeps its raw form including surrounding double-quotes, so
 * restoring `"muscle protein synthesis"` reproduces the exact quoted query
 * and thus the phrase-search routing. `yearFrom` / `yearTo` are kept as
 * strings (not parsed to numbers) to round-trip empty-string exactly.
 */
const notesPresenceSchema = z.enum(["all", "has", "none"]);

export const presetPayloadSchema = z.object({
  version: z.literal(PRESET_PAYLOAD_VERSION),
  searchQuery: z.string(),
  yearFrom: z.string(),
  yearTo: z.string(),
  studyType: z.string(),
  notesPresence: notesPresenceSchema,
  selectedKeywords: z.array(z.string()),
  selectedProjectId: z.string().nullable(),
  selectedTagId: z.string().nullable(),
});

export type PresetPayload = z.infer<typeof presetPayloadSchema>;

/** A single saved preset with server-provided metadata. */
export interface FilterPreset {
  id: string;
  name: string;
  payload: PresetPayload;
  created_at: string;
  updated_at: string;
}

/**
 * Safe-parse a JSONB `payload` read back from the DB. Returns null for
 * rows with a shape we cannot reconcile (future schema version, missing
 * fields, corrupted write) — the caller drops them from the menu and
 * warns to the console so the user still sees every preset we can load.
 */
export function parsePresetPayload(raw: unknown): PresetPayload | null {
  const parsed = presetPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    // Deliberately not a throw — invalid rows must not break the menu.
    console.warn("[useFilterPresets] Dropping invalid preset payload:", parsed.error.issues);
    return null;
  }
  return parsed.data;
}

/** Filter-state setter surface that `applyPreset` targets. */
export interface PresetSetters {
  setSearchQuery: (v: string) => void;
  setYearFrom: (v: string) => void;
  setYearTo: (v: string) => void;
  setStudyType: (v: string) => void;
  setNotesPresence: (v: NotesPresence) => void;
  setSelectedKeywords: (v: string[]) => void;
  setSelectedProjectId: (v: string | null) => void;
  setSelectedTagId: (v: string | null) => void;
}

/** Result of applying a preset — reports any stale references that were skipped. */
export interface ApplyPresetResult {
  droppedProjectId: boolean;
  droppedTagId: boolean;
}

/**
 * Restore a preset into the current filter state by invoking each setter
 * exactly once. Full-replacement semantics: every one of the 8 fields is
 * overwritten, deterministically, regardless of the pre-load state.
 *
 * Stale-ID guard: if the preset references a `selectedProjectId` or
 * `selectedTagId` that no longer exists in the current `projects` / `tags`
 * lists (e.g. the user deleted it since saving the preset), the field is
 * set to `null` and the result reports the drop so the caller can toast.
 *
 * Pure apart from the setter side-effects, so it is straightforward to
 * unit-test with jest/vitest mocks.
 */
export function applyPreset(
  payload: PresetPayload,
  setters: PresetSetters,
  projects: Pick<Project, "id">[],
  tags: Pick<Tag, "id">[],
): ApplyPresetResult {
  setters.setSearchQuery(payload.searchQuery);
  setters.setYearFrom(payload.yearFrom);
  setters.setYearTo(payload.yearTo);
  setters.setStudyType(payload.studyType);
  setters.setNotesPresence(payload.notesPresence);
  setters.setSelectedKeywords(payload.selectedKeywords);

  const projectExists =
    payload.selectedProjectId === null ||
    projects.some((p) => p.id === payload.selectedProjectId);
  const tagExists =
    payload.selectedTagId === null || tags.some((t) => t.id === payload.selectedTagId);

  setters.setSelectedProjectId(projectExists ? payload.selectedProjectId : null);
  setters.setSelectedTagId(tagExists ? payload.selectedTagId : null);

  return {
    droppedProjectId: !projectExists,
    droppedTagId: !tagExists,
  };
}

/**
 * Validate and normalize a user-supplied preset name. Returns the trimmed
 * name on success, or an error message on failure (empty after trim, or
 * over `PRESET_NAME_MAX_LENGTH` chars).
 */
export function validatePresetName(name: string): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Please enter a name for this preset." };
  }
  if (trimmed.length > PRESET_NAME_MAX_LENGTH) {
    return { ok: false, error: `Name must be ${PRESET_NAME_MAX_LENGTH} characters or fewer.` };
  }
  return { ok: true, name: trimmed };
}

/** Build the payload we persist from the current filter-state fields. */
export function buildPresetPayload(fields: Omit<PresetPayload, "version">): PresetPayload {
  return { version: PRESET_PAYLOAD_VERSION, ...fields };
}

interface UseFilterPresetsArgs {
  userId: string | undefined;
}

export function useFilterPresets({ userId }: UseFilterPresetsArgs) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  /** List all presets for this user, alphabetical by name (case-insensitive). */
  const { data: presets = [], isLoading } = useQuery<FilterPreset[]>({
    queryKey: userId ? queryKeys.filterPresets.all(userId) : ["filterPresets", "anon"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("filter_presets")
        .select("id, name, payload, created_at, updated_at")
        .order("name", { ascending: true });
      if (error) throw error;

      const rows = (data ?? []) as Array<{
        id: string;
        name: string;
        payload: unknown;
        created_at: string;
        updated_at: string;
      }>;

      const parsed: FilterPreset[] = [];
      for (const row of rows) {
        const payload = parsePresetPayload(row.payload);
        if (!payload) continue; // drop silently-warned invalid rows
        parsed.push({
          id: row.id,
          name: row.name,
          payload,
          created_at: row.created_at,
          updated_at: row.updated_at,
        });
      }
      // Case-insensitive sort to match the per-user unique-index collation.
      parsed.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      return parsed;
    },
    enabled: !!userId,
    staleTime: 60_000,
  });

  const invalidate = useCallback(() => {
    if (!userId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.filterPresets.all(userId) });
  }, [queryClient, userId]);

  const createPresetMutation = useMutation({
    mutationFn: async ({ name, payload }: { name: string; payload: PresetPayload }) => {
      if (!userId) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("filter_presets")
        .insert({ user_id: userId, name, payload })
        .select("id, name, payload, created_at, updated_at")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      invalidate();
    },
    onError: (error: unknown, variables) => {
      // 23505 = per-user unique-index violation on (user_id, lower(name)).
      const pgError = error as { code?: string; message?: string };
      if (pgError?.code === "23505") {
        toast({
          title: "Name already taken",
          description: `A preset named "${variables.name}" already exists.`,
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Could not save preset",
        description: pgError?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const deletePresetMutation = useMutation({
    mutationFn: async ({ id }: { id: string; name: string }) => {
      const { error } = await supabase.from("filter_presets").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      invalidate();
      toast({ title: "Preset deleted", description: `"${variables.name}" was removed.` });
    },
    onError: (error: unknown) => {
      const pgError = error as { message?: string };
      toast({
        title: "Could not delete preset",
        description: pgError?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  /** Promise-returning save that resolves to true on success, false on error (duplicate etc). */
  const savePreset = useCallback(
    async (name: string, payload: PresetPayload): Promise<boolean> => {
      try {
        await createPresetMutation.mutateAsync({ name, payload });
        toast({ title: "Preset saved", description: `"${name}" is now in your saved searches.` });
        return true;
      } catch {
        // Error already surfaced by the mutation's onError handler.
        return false;
      }
    },
    [createPresetMutation, toast],
  );

  const deletePreset = useCallback(
    async (preset: Pick<FilterPreset, "id" | "name">): Promise<void> => {
      await deletePresetMutation.mutateAsync({ id: preset.id, name: preset.name });
    },
    [deletePresetMutation],
  );

  return useMemo(
    () => ({
      presets,
      isLoading,
      isSaving: createPresetMutation.isPending,
      isDeleting: deletePresetMutation.isPending,
      savePreset,
      deletePreset,
    }),
    [presets, isLoading, createPresetMutation.isPending, deletePresetMutation.isPending, savePreset, deletePreset],
  );
}
