import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/hooks/use-toast";

/**
 * Data layer for the Settings → AI Model section (AI-MODEL-SELECTION-001C).
 *
 * Two read paths and two write paths, all of them the ones the 001A migration
 * (`20260902120000`) approved:
 *
 *   • READ  `ai_model_catalog` — the server-controlled allowlist of models
 *     Paperlume has approved. Read-only to clients by construction (SELECT
 *     policy + SELECT grant only). The frontend never hard-codes a model list;
 *     the catalog *is* the list.
 *   • READ  `user_ai_preferences` — the caller's own row, or its **absence**.
 *     Absence is meaningful and load-bearing: it means "no explicit choice —
 *     follow Paperlume's system default". It is therefore represented as a
 *     distinct `null`, never conflated with a failed read.
 *   • WRITE `set_current_user_ai_model(p_model_id)` — the only way to pin a
 *     model. It takes no user id: the row it writes is derived from
 *     `auth.uid()` server-side, so this hook cannot address another user's row
 *     even in principle.
 *   • WRITE `clear_current_user_ai_model()` — the only way to return to the
 *     system default. No arguments, and deliberately **not** gated on the
 *     model-selection entitlement, so a downgraded user can still drop a
 *     dormant preference.
 *
 * There is no direct INSERT / UPDATE / UPSERT / DELETE against either table
 * anywhere in this module, and none is possible: `user_ai_preferences` carries
 * no client write policy or grant, and `ai_model_catalog` carries neither.
 *
 * The setter re-checks entitlement and the catalog itself and returns a
 * structured rejection rather than raising. This hook maps those bounded
 * reasons onto stable user-facing messages; it never duplicates the
 * authorization decision, and it never reports a rejection as a success.
 */

/**
 * The Select value standing for "no saved preference — follow Paperlume's
 * default".
 *
 * Deliberately **not** a model id, and deliberately not the current default's
 * provider model: the browser must never become a second source of truth for
 * `GEMINI_MODEL`. Choosing it calls `clear_current_user_ai_model()`; it is
 * never passed to the setter.
 */
export const PAPERLUME_DEFAULT_VALUE = "__paperlume_default__";

/**
 * Provider families the *shipped UI and runtime* support today.
 *
 * This is a UI/provider boundary, not a duplicated model allowlist: it names
 * providers, never models, and the catalog still supplies every model id. The
 * `provider` column is intentionally unconstrained in the schema so an
 * Anthropic or OpenAI row can be seeded ahead of its UI work — and until that
 * work ships, offering such a row here would promise routing that does not
 * exist. Adding a provider is an explicit feature change, made here.
 */
const SUPPORTED_PROVIDERS: readonly string[] = ["google"];

function isSupportedProvider(provider: string | null | undefined): boolean {
  return !!provider && SUPPORTED_PROVIDERS.includes(provider);
}

/** Exactly the catalog columns this surface needs — no `provider_model`. */
const CATALOG_COLUMNS = "id, provider, display_name, enabled, selectable, sort_order";

/** Raw catalog row shape for the projection above. */
interface AiModelCatalogRow {
  id: string;
  provider: string;
  display_name: string;
  enabled: boolean;
  selectable: boolean;
  sort_order: number;
}

/** Raw preference row shape (singleton — at most one per user). */
interface AiPreferenceRow {
  preferred_model_id: string | null;
}

/** A catalog entry, normalized for the UI. */
export interface AiModelOption {
  id: string;
  provider: string;
  displayName: string;
  enabled: boolean;
  selectable: boolean;
}

/**
 * The saved preference resolved against the catalog.
 *
 * `none` is the *absence of a row*, not a failed read — a failed read leaves
 * `saved` null and raises `isError` instead.
 *
 * `active` means the deployed 001B runtime honours the choice: the catalog row
 * exists, is `enabled`, and belongs to a provider this build can route to.
 * `selectable` rides along because an `enabled = true, selectable = false` row
 * stays operational for whoever already saved it while being closed to new
 * selections — a state the UI has to represent truthfully rather than hide.
 *
 * `unavailable` means the runtime falls back to the system default: the row is
 * disabled, gone from the catalog, or from a provider this build cannot route
 * to. The preference is deliberately left alone — the UI reports the fallback
 * and offers a reset; it never silently rewrites the user's saved choice.
 */
export type SavedModelState =
  | { status: "none" }
  | { status: "active"; modelId: string; displayName: string; selectable: boolean }
  | { status: "unavailable"; modelId: string; displayName: string | null };

/** Bounded rejection classes the setter can return. */
type RejectionKind = "entitlement" | "catalog" | "unknown";

const ENTITLEMENT_REASONS: readonly string[] = [
  "missing_entitlement",
  "not_entitled",
  "inactive_entitlement",
];
const CATALOG_REASONS: readonly string[] = [
  "unknown_model",
  "model_disabled",
  "model_not_selectable",
];

function classifyReason(reason: unknown): RejectionKind {
  if (typeof reason !== "string") return "unknown";
  if (ENTITLEMENT_REASONS.includes(reason)) return "entitlement";
  if (CATALOG_REASONS.includes(reason)) return "catalog";
  // `invalid_model_id` lands here on purpose: an empty/blank id is a client
  // bug, not something to explain to the user in catalog or access terms.
  return "unknown";
}

/** Structured setter row (SETOF → array in supabase-js). */
interface SetModelRow {
  saved: boolean | null;
  reason: string | null;
  display_name: string | null;
}
/** Structured clear row. */
interface ClearModelRow {
  cleared: boolean | null;
  reason: string | null;
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] ?? null) as T | null;
  return (data ?? null) as T | null;
}

type SaveOutcome =
  | { ok: true; displayName: string | null }
  | { ok: false; kind: RejectionKind };

export interface UseAiModelSettingsOptions {
  /** Gate the reads on the consuming surface being visible (Settings open). */
  enabled?: boolean;
}

export interface UseAiModelSettingsResult {
  /**
   * Models a user may newly choose: `enabled` AND `selectable` AND from a
   * provider this build supports, in the catalog's own deterministic order.
   */
  options: AiModelOption[];
  /** The saved preference resolved against the catalog; null while unresolved. */
  saved: SavedModelState | null;
  isLoading: boolean;
  /** True when the catalog OR the preference read failed. Never "no preference". */
  isError: boolean;
  /** Refetch both reads — the retry affordance for the error state. */
  refetch: () => void;
  /** Pin a catalog model. Never called with {@link PAPERLUME_DEFAULT_VALUE}. */
  saveModel: (modelId: string) => void;
  /** Return to Paperlume's system default. */
  clearModel: () => void;
  /** True while either write is in flight — the control must be disabled. */
  isMutating: boolean;
}

/**
 * Read + write access to the signed-in user's AI model preference.
 *
 * - Both reads are disabled without a `userId` and without the caller enabling
 *   them, so nothing is fetched while Settings is closed.
 * - The preference read runs regardless of entitlement: a downgraded user still
 *   holds a dormant row and must be able to see and clear it.
 * - S2 defense-in-depth: the preference read carries an explicit
 *   `.eq("user_id", userId)` on top of the SELECT-own RLS policy.
 * - **No optimistic update.** A model change is one small round trip, and the
 *   saved preference is authoritative server state — the UI waits for the
 *   server and then refetches it rather than guessing.
 */
export function useAiModelSettings(
  userId: string | null | undefined,
  options?: UseAiModelSettingsOptions,
): UseAiModelSettingsResult {
  const enabled = !!userId && (options?.enabled ?? true);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const scopeId = userId ?? "anonymous";

  const catalogQuery = useQuery<AiModelOption[]>({
    queryKey: queryKeys.aiModelSettings.catalog(scopeId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_model_catalog")
        .select(CATALOG_COLUMNS)
        // Deterministic two-key ordering. `sort_order` is sparse and could in
        // principle tie; `id` is the primary key, so the second key makes the
        // rendered order total and stable across reads.
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as AiModelCatalogRow[]).map((row) => ({
        id: row.id,
        provider: row.provider,
        displayName: row.display_name,
        enabled: !!row.enabled,
        selectable: !!row.selectable,
      }));
    },
    enabled,
    staleTime: 60_000,
  });

  const preferenceQuery = useQuery<string | null>({
    queryKey: queryKeys.aiModelSettings.preference(scopeId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_ai_preferences")
        .select("preferred_model_id")
        // Defense in depth on top of the SELECT-own policy. RLS remains the
        // authorization boundary; this makes the intent explicit at the call
        // site and keeps a policy regression from widening the read.
        .eq("user_id", userId!)
        .maybeSingle();
      if (error) throw error;
      // `null` is the documented "no explicit preference" state. It is reached
      // only when the read SUCCEEDED and returned no row — a failure throws
      // above and surfaces as `isError`, never as "no preference".
      const row = (data ?? null) as AiPreferenceRow | null;
      return row?.preferred_model_id ?? null;
    },
    enabled,
    // Deliberately 0 (the app default is 5 minutes): reopening Settings must
    // show the authoritative saved choice, not a stale one.
    staleTime: 0,
  });

  const isLoading = enabled && (catalogQuery.isLoading || preferenceQuery.isLoading);
  const isError = catalogQuery.isError || preferenceQuery.isError;

  const catalog = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);

  const optionsList = useMemo(
    () =>
      catalog.filter(
        (entry) => entry.enabled && entry.selectable && isSupportedProvider(entry.provider),
      ),
    [catalog],
  );

  const saved = useMemo<SavedModelState | null>(() => {
    // Unresolved: either read still pending or failed. The caller must not
    // read this as "no preference".
    if (isError) return null;
    if (catalogQuery.data === undefined || preferenceQuery.data === undefined) return null;

    const modelId = preferenceQuery.data;
    if (modelId === null) return { status: "none" };

    const entry = catalog.find((candidate) => candidate.id === modelId);
    if (!entry) return { status: "unavailable", modelId, displayName: null };
    if (!entry.enabled || !isSupportedProvider(entry.provider)) {
      return { status: "unavailable", modelId, displayName: entry.displayName };
    }
    return {
      status: "active",
      modelId,
      displayName: entry.displayName,
      selectable: entry.selectable,
    };
  }, [catalog, catalogQuery.data, preferenceQuery.data, isError]);

  const invalidatePreference = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.aiModelSettings.preference(scopeId) });
  const invalidateCatalog = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.aiModelSettings.catalog(scopeId) });
  const invalidateAccess = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.access.current(scopeId) });

  /**
   * Present a bounded rejection. Raw server reasons and raw Supabase errors are
   * never rendered; each class also refreshes whatever state it implies is
   * stale, because the rejection is evidence the client's view is out of date.
   */
  const reportRejection = (kind: RejectionKind) => {
    if (kind === "entitlement") {
      // Entitlement may have lapsed since the dialog opened — re-read the
      // authoritative projection rather than keeping a stale "entitled" view.
      void invalidateAccess();
      void invalidatePreference();
      toast({
        title: "Model unchanged",
        description: "AI model selection is not available for this account.",
        variant: "destructive",
      });
      return;
    }
    if (kind === "catalog") {
      void invalidateCatalog();
      void invalidatePreference();
      toast({
        title: "Model unchanged",
        description:
          "That model is no longer available for selection. Refresh and choose another model.",
        variant: "destructive",
      });
      return;
    }
    void invalidatePreference();
    toast({
      title: "Could not update AI model",
      description: "Please try again.",
      variant: "destructive",
    });
  };

  const saveMutation = useMutation<SaveOutcome, unknown, string>({
    mutationFn: async (modelId: string) => {
      // Structural guard, not an authorization check: the sentinel is a UI
      // value with no server meaning and must never reach the setter.
      if (modelId === PAPERLUME_DEFAULT_VALUE) {
        throw new Error("The Paperlume-default sentinel is not a catalog model id.");
      }
      const { data, error } = await supabase.rpc("set_current_user_ai_model", {
        p_model_id: modelId,
      });
      if (error) throw error;
      const row = firstRow<SetModelRow>(data);
      // A missing/malformed row is NOT a success. Failing here keeps a silent
      // "saved" from being reported for a write that may not have happened.
      if (!row || row.saved !== true) {
        return { ok: false, kind: classifyReason(row?.reason) };
      }
      return { ok: true, displayName: row.display_name };
    },
    onSuccess: (outcome) => {
      if (!outcome.ok) {
        reportRejection(outcome.kind);
        return;
      }
      void invalidatePreference();
      toast({
        title: "AI model updated",
        description: outcome.displayName
          ? `Paperlume will use ${outcome.displayName} for this account.`
          : "Your model preference has been saved.",
      });
    },
    onError: () => {
      toast({
        title: "Could not update AI model",
        description: "Please try again.",
        variant: "destructive",
      });
    },
  });

  const clearMutation = useMutation<boolean, unknown, void>({
    mutationFn: async () => {
      // No arguments: the row cleared is the caller's, derived from auth.uid().
      const { data, error } = await supabase.rpc("clear_current_user_ai_model");
      if (error) throw error;
      const row = firstRow<ClearModelRow>(data);
      // Both outcomes mean "this account is on the system default":
      // `cleared = true` removed a row, and `no_preference` found none to
      // remove. The clear RPC is intentionally idempotent.
      return row?.cleared === true || row?.reason === "no_preference";
    },
    onSuccess: (ok) => {
      if (!ok) {
        void invalidatePreference();
        toast({
          title: "Could not update AI model",
          description: "Please try again.",
          variant: "destructive",
        });
        return;
      }
      void invalidatePreference();
      toast({
        title: "Using Paperlume default",
        description: "Paperlume will use its default model for this account.",
      });
    },
    onError: () => {
      toast({
        title: "Could not update AI model",
        description: "Please try again.",
        variant: "destructive",
      });
    },
  });

  const isMutating = saveMutation.isPending || clearMutation.isPending;

  return {
    options: optionsList,
    saved,
    isLoading,
    isError,
    refetch: () => {
      void catalogQuery.refetch();
      void preferenceQuery.refetch();
    },
    saveModel: (modelId: string) => {
      if (isMutating) return;
      saveMutation.mutate(modelId);
    },
    clearModel: () => {
      if (isMutating) return;
      clearMutation.mutate();
    },
    isMutating,
  };
}
