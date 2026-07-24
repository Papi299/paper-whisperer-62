import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";
import type { NotesPresence } from "@/hooks/papers/types";
import type { Project, Tag } from "@/types/database";
import { useToast } from "@/hooks/use-toast";

/**
 * Current payload schema version. Bumped 1 → 2 by PROJECT-TAG-SELECTOR-UX-001
 * when the dashboard Project/Tag filters became multi-select: the scalar
 * `selectedProjectId` / `selectedTagId` fields were replaced by the
 * `selectedProjectIds` / `selectedTagIds` string arrays. Version-1 payloads
 * still on disk are read via `presetPayloadV1Schema` and normalized up to the
 * current shape by `parsePresetPayload` — no automatic DB rewrite happens.
 */
export const PRESET_PAYLOAD_VERSION = 2 as const;

/** Maximum allowed preset name length. */
export const PRESET_NAME_MAX_LENGTH = 80;

/**
 * The 8 filter fields we snapshot, plus a `version` sentinel. Saved verbatim:
 * `searchQuery` keeps its raw form including surrounding double-quotes, so
 * restoring `"muscle protein synthesis"` reproduces the exact quoted query
 * and thus the phrase-search routing. `yearFrom` / `yearTo` are kept as
 * strings (not parsed to numbers) to round-trip empty-string exactly.
 *
 * `selectedProjectIds` / `selectedTagIds` are order-insensitive sets — the
 * dirty-check comparator treats them as such (see `arePresetPayloadsEqual`).
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
  selectedProjectIds: z.array(z.string()),
  selectedTagIds: z.array(z.string()),
});

export type PresetPayload = z.infer<typeof presetPayloadSchema>;

/**
 * Legacy version-1 payload shape (scalar Project/Tag). Retained for READS only
 * so existing saved presets keep loading. `parsePresetPayload` upgrades a
 * matched v1 row into the current in-memory `PresetPayload` (v2) — it is never
 * written back to the DB by the read path; a v1 row is persisted as v2 only
 * when the user explicitly re-saves or updates the preset through the normal
 * product workflow.
 */
export const presetPayloadV1Schema = z.object({
  version: z.literal(1),
  searchQuery: z.string(),
  yearFrom: z.string(),
  yearTo: z.string(),
  studyType: z.string(),
  notesPresence: notesPresenceSchema,
  selectedKeywords: z.array(z.string()),
  selectedProjectId: z.string().nullable(),
  selectedTagId: z.string().nullable(),
});

/** Normalize a nullable scalar ID into a 0-or-1-element array. */
function scalarToArray(id: string | null): string[] {
  return id === null ? [] : [id];
}

/** A single saved preset with server-provided metadata. */
export interface FilterPreset {
  id: string;
  name: string;
  payload: PresetPayload;
  created_at: string;
  updated_at: string;
}

/**
 * Safe-parse a JSONB `payload` read back from the DB into the current
 * (version-2) in-memory shape. Returns null for rows with a shape we cannot
 * reconcile (unknown/future version, missing fields, corrupted write) — the
 * caller drops them from the menu and warns to the console so the user still
 * sees every preset we can load.
 *
 * Backward compatibility: a valid version-1 payload (scalar Project/Tag) is
 * accepted and normalized up to version 2 in memory. The scalar
 * `selectedProjectId` / `selectedTagId` become 0-or-1-element arrays. This
 * upgrade is read-only — nothing is written back to the DB here.
 */
export function parsePresetPayload(raw: unknown): PresetPayload | null {
  const parsed = presetPayloadSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  // Not a v2 row — try the legacy v1 shape and normalize it forward.
  const v1 = presetPayloadV1Schema.safeParse(raw);
  if (v1.success) {
    const { selectedProjectId, selectedTagId, version: _v1version, ...rest } = v1.data;
    return {
      ...rest,
      version: PRESET_PAYLOAD_VERSION,
      selectedProjectIds: scalarToArray(selectedProjectId),
      selectedTagIds: scalarToArray(selectedTagId),
    };
  }

  // Deliberately not a throw — invalid rows must not break the menu.
  console.warn("[useFilterPresets] Dropping invalid preset payload:", parsed.error.issues);
  return null;
}

/** Filter-state setter surface that `applyPreset` targets. */
export interface PresetSetters {
  setSearchQuery: (v: string) => void;
  setYearFrom: (v: string) => void;
  setYearTo: (v: string) => void;
  setStudyType: (v: string) => void;
  setNotesPresence: (v: NotesPresence) => void;
  setSelectedKeywords: (v: string[]) => void;
  setSelectedProjectIds: (v: string[]) => void;
  setSelectedTagIds: (v: string[]) => void;
}

/**
 * Result of applying a preset — reports how many stale references were skipped
 * per category so the caller can build an accurately-pluralized toast. Zero
 * means nothing was dropped for that category.
 */
export interface ApplyPresetResult {
  droppedProjectCount: number;
  droppedTagCount: number;
}

/**
 * Restore a preset into the current filter state by invoking each setter
 * exactly once. Full-replacement semantics: every one of the 8 fields is
 * overwritten, deterministically, regardless of the pre-load state.
 *
 * Stale-ID guard (partial): each `selectedProjectIds` / `selectedTagIds`
 * member that no longer exists in the current `projects` / `tags` lists (e.g.
 * the user deleted it since saving the preset) is dropped individually —
 * valid sibling selections are kept. The result reports the per-category drop
 * count so the caller can toast "1 project" vs "2 projects", etc.
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

  const projectIdSet = new Set(projects.map((p) => p.id));
  const tagIdSet = new Set(tags.map((t) => t.id));

  const keptProjectIds = payload.selectedProjectIds.filter((id) => projectIdSet.has(id));
  const keptTagIds = payload.selectedTagIds.filter((id) => tagIdSet.has(id));

  setters.setSelectedProjectIds(keptProjectIds);
  setters.setSelectedTagIds(keptTagIds);

  return {
    droppedProjectCount: payload.selectedProjectIds.length - keptProjectIds.length,
    droppedTagCount: payload.selectedTagIds.length - keptTagIds.length,
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

/**
 * Decide what should happen when the user submits a Rename. Pure function,
 * isolated for unit testing — the hook just maps the result to side effects.
 *
 *   • `invalid` — fails `validatePresetName` (empty after trim, or too long).
 *     Hook surfaces a destructive toast and skips the network.
 *   • `noop`    — trimmed new name is byte-identical to the current preset
 *     name. Hook returns success without calling the mutation, without
 *     invalidating the list query, and without firing a toast — closing the
 *     dialog as if a normal success happened, while skipping the empty UPDATE.
 *   • `ok`      — trimmed new name differs from the current name. Hook calls
 *     the rename mutation with `{ id, name: trimmedName }`.
 *
 * Case-only differences are NOT a no-op (`"Foo"` vs `"foo"` are distinct
 * strings) — the user retains the ability to fix capitalization.
 */
export function prepareRename(
  preset: Pick<FilterPreset, "name">,
  newName: string,
):
  | { kind: "invalid"; error: string }
  | { kind: "noop" }
  | { kind: "ok"; trimmedName: string } {
  const validation = validatePresetName(newName);
  if (!validation.ok) return { kind: "invalid", error: validation.error };
  if (validation.name === preset.name) return { kind: "noop" };
  return { kind: "ok", trimmedName: validation.name };
}

/** Build the payload we persist from the current filter-state fields. */
export function buildPresetPayload(fields: Omit<PresetPayload, "version">): PresetPayload {
  return { version: PRESET_PAYLOAD_VERSION, ...fields };
}

/**
 * Deep-ish equality for two `PresetPayload` objects. Used to derive the
 * "currently loaded preset has unsaved changes" signal — when this returns
 * `false`, the UI surfaces a dot on the Presets trigger and enables the
 * `Update "<name>"` action.
 *
 * Scalar fields compare with strict `===`. `selectedKeywords`,
 * `selectedProjectIds` and `selectedTagIds` compare **order-insensitively**
 * (same length + same set of members), because each is semantically "match
 * any of these" — toggling a member off and back on, or selecting in a
 * different order, should not read as dirty. `applyPreset` still restores the
 * saved order on load; only this comparator is order-insensitive.
 *
 * A `version` mismatch (future schema bump) reads as not-equal, which
 * correctly surfaces a dirty signal so the user can re-save under the
 * current schema.
 */
export function arePresetPayloadsEqual(a: PresetPayload, b: PresetPayload): boolean {
  if (a.version !== b.version) return false;
  if (a.searchQuery !== b.searchQuery) return false;
  if (a.yearFrom !== b.yearFrom) return false;
  if (a.yearTo !== b.yearTo) return false;
  if (a.studyType !== b.studyType) return false;
  if (a.notesPresence !== b.notesPresence) return false;
  return (
    areStringSetsEqual(a.selectedKeywords, b.selectedKeywords) &&
    areStringSetsEqual(a.selectedProjectIds, b.selectedProjectIds) &&
    areStringSetsEqual(a.selectedTagIds, b.selectedTagIds)
  );
}

/**
 * Order-insensitive set equality for two string arrays. Lengths must match,
 * then a one-way membership check suffices (every member of `a` present in
 * `b`, with equal lengths, implies equal sets). Duplicate members are not
 * expected in these filter arrays, so length + one-way membership is exact.
 */
function areStringSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  for (const value of a) {
    if (!bSet.has(value)) return false;
  }
  return true;
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
      // Defense-in-depth: explicit `user_id` filter alongside the row
      // ID filter so a hypothetical RLS regression cannot allow a
      // cross-user delete. Matches the existing `createPresetMutation`
      // guard pattern.
      if (!userId) throw new Error("Not signed in");
      const { error } = await supabase
        .from("filter_presets")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);
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

  /**
   * Overwrite an existing preset's `payload` with the current dashboard state.
   * Targets the preset by `id` (never by name) so a rename or duplicate-name
   * scenario can never silently overwrite the wrong row. The DB `updated_at`
   * trigger refreshes the timestamp; the unique-index on (user_id, lower(name))
   * is unaffected because we deliberately do not touch the name here.
   */
  const updatePresetMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; name: string; payload: PresetPayload }) => {
      // Defense-in-depth: explicit `user_id` filter alongside the row
      // ID filter — same rationale as `deletePresetMutation` above.
      if (!userId) throw new Error("Not signed in");
      const { error } = await supabase
        .from("filter_presets")
        .update({ payload })
        .eq("id", id)
        .eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      invalidate();
      toast({
        title: "Preset updated",
        description: `"${variables.name}" now reflects the current filters.`,
      });
    },
    onError: (error: unknown) => {
      const pgError = error as { message?: string };
      toast({
        title: "Could not update preset",
        description: pgError?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  /**
   * Rename an existing preset. Targets by `id`, never by old name text — so
   * a duplicate-name scenario can never silently rename the wrong row. Only
   * the `name` column is touched; `payload`, `created_at`, and `id` are
   * preserved. The DB `updated_at` trigger refreshes the timestamp.
   *
   * The 23505 → "Name already taken" branch mirrors the create flow exactly
   * (same per-user case-insensitive unique index governs both).
   */
  const renamePresetMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      // Defense-in-depth: explicit `user_id` filter alongside the row
      // ID filter — same rationale as `deletePresetMutation` above.
      if (!userId) throw new Error("Not signed in");
      const { error } = await supabase
        .from("filter_presets")
        .update({ name })
        .eq("id", id)
        .eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      invalidate();
      toast({
        title: "Preset renamed",
        description: `"${variables.name}" is now the preset name.`,
      });
    },
    onError: (error: unknown, variables) => {
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
        title: "Could not rename preset",
        description: pgError?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  /**
   * Create a new preset. Resolves to the created `FilterPreset` (with its
   * server-assigned id) on success or `null` on error. Returning the row lets
   * the caller mark the new preset as "currently loaded" so the user can
   * immediately tweak filters and click Update without an extra Load step.
   */
  const savePreset = useCallback(
    async (name: string, payload: PresetPayload): Promise<FilterPreset | null> => {
      try {
        const created = await createPresetMutation.mutateAsync({ name, payload });
        toast({ title: "Preset saved", description: `"${name}" is now in your saved searches.` });
        // The insert SELECT returns the same shape as a list row; reuse the
        // schema parser so the in-memory preset matches what the list query
        // would produce (and so a future schema bump is caught here too).
        const parsedPayload = parsePresetPayload(created.payload);
        if (!parsedPayload) return null;
        return {
          id: created.id,
          name: created.name,
          payload: parsedPayload,
          created_at: created.created_at,
          updated_at: created.updated_at,
        };
      } catch {
        // Error already surfaced by the mutation's onError handler.
        return null;
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

  /**
   * Update an already-loaded preset's payload. Pass the full preset (or at
   * least `id` + `name`) so the success toast can name the preset and so the
   * mutation cannot accidentally target a different row by name lookup.
   */
  const updatePreset = useCallback(
    async (preset: Pick<FilterPreset, "id" | "name">, payload: PresetPayload): Promise<boolean> => {
      try {
        await updatePresetMutation.mutateAsync({ id: preset.id, name: preset.name, payload });
        return true;
      } catch {
        return false;
      }
    },
    [updatePresetMutation],
  );

  /**
   * Rename an existing preset by id. Validates the new name and short-circuits
   * a no-op (trimmed-equal to current name) without hitting the network — see
   * `prepareRename` for the decision logic. Returns `true` for both real
   * renames and no-ops (so the caller can close the dialog uniformly), and
   * `false` for validation failure or mutation rejection.
   */
  const renamePreset = useCallback(
    async (preset: Pick<FilterPreset, "id" | "name">, newName: string): Promise<boolean> => {
      const decision = prepareRename(preset, newName);
      if (decision.kind === "invalid") {
        toast({ title: "Invalid name", description: decision.error, variant: "destructive" });
        return false;
      }
      if (decision.kind === "noop") {
        // Nothing to send, nothing to invalidate, nothing to toast — the
        // dialog still closes via the `true` return.
        return true;
      }
      try {
        await renamePresetMutation.mutateAsync({ id: preset.id, name: decision.trimmedName });
        return true;
      } catch {
        return false;
      }
    },
    [renamePresetMutation, toast],
  );

  return useMemo(
    () => ({
      presets,
      isLoading,
      isSaving: createPresetMutation.isPending,
      isDeleting: deletePresetMutation.isPending,
      isUpdating: updatePresetMutation.isPending,
      isRenaming: renamePresetMutation.isPending,
      savePreset,
      deletePreset,
      updatePreset,
      renamePreset,
    }),
    [
      presets,
      isLoading,
      createPresetMutation.isPending,
      deletePresetMutation.isPending,
      updatePresetMutation.isPending,
      renamePresetMutation.isPending,
      savePreset,
      deletePreset,
      updatePreset,
      renamePreset,
    ],
  );
}
