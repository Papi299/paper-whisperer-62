import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/hooks/use-toast";
import { isAiReasoningLevel, type AiReasoningLevel } from "@/lib/aiReasoning";

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
 *   • WRITE `set_current_user_ai_reasoning(p_reasoning_level)` — the only way
 *     to pin a manual reasoning level (AI-MULTI-PROVIDER-001C, C41). **STAGED:
 *     the migration that creates it grants EXECUTE to no role**, so every call
 *     currently fails at the database and this hook reports the failure rather
 *     than a success. That is the intended state until a separately authorized
 *     user-enablement migration grants it alongside flipping
 *     `reasoning_selectable`; the path in between is guarded by
 *     `reasoningSelectable`, which is `false` on every catalog row, so the UI
 *     never offers the choice that would make the call.
 *   • WRITE `clear_current_user_ai_reasoning()` — return to Automatic while
 *     keeping the saved model. Granted immediately, and deliberately not gated
 *     on entitlement or on `reasoning_selectable`: leaving a manual level must
 *     never be blocked by the flag that controls entering one.
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
 * `provider` column is intentionally unconstrained in the schema so a row can
 * be seeded ahead of its UI work — and until that work ships, offering such a
 * row here would promise routing that does not exist. Adding a provider is an
 * explicit feature change, made here.
 *
 * AI-MULTI-PROVIDER-001C added `anthropic` and `openai`, mirroring the Edge
 * runtime registry (`supabase/functions/_shared/aiProviderRegistry.ts`) that
 * registered their adapters in the same task. The two lists are two halves of
 * one decision and move together.
 *
 * This adds NO model option today, and cannot: there is no `anthropic/*` or
 * `openai/*` row in `ai_model_catalog`, and the catalog remains the only source
 * of models. What it changes is what would happen IF such a row were seeded —
 * it would be offered, instead of being silently filtered out by a UI that had
 * not caught up with the runtime.
 */
const SUPPORTED_PROVIDERS: readonly string[] = ["google", "anthropic", "openai"];

function isSupportedProvider(provider: string | null | undefined): boolean {
  return !!provider && SUPPORTED_PROVIDERS.includes(provider);
}

/**
 * Exactly the catalog columns this surface needs — no `provider_model`.
 *
 * The four reasoning columns (AI-MULTI-PROVIDER-001C) are product metadata in
 * the same sense as `display_name`: what a model offers and what PaperLume
 * chooses for it. `provider_model` still stays out, because the browser has no
 * use for the string that goes on the provider's wire.
 */
// One string literal, deliberately not a concatenation: supabase-js derives the
// row type from the literal type of this argument, and `"a" + "b"` widens to
// `string`, which silently turns the typed read into an untyped one.
const CATALOG_COLUMNS = "id, provider, display_name, enabled, selectable, sort_order, reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level, reasoning_selectable";

/** Raw catalog row shape for the projection above. */
interface AiModelCatalogRow {
  id: string;
  provider: string;
  display_name: string;
  enabled: boolean;
  selectable: boolean;
  sort_order: number;
  reasoning_levels: string[] | null;
  auto_analyze_reasoning_level: string | null;
  auto_suggest_reasoning_level: string | null;
  reasoning_selectable: boolean | null;
}

/** Raw preference row shape (singleton — at most one per user). */
interface AiPreferenceRow {
  preferred_model_id: string | null;
  preferred_reasoning_level: string | null;
}

/**
 * A catalog entry, normalized for the UI.
 *
 * `reasoningLevels` is the model's OWN list, in the catalog's order, filtered to
 * values this build can name. The filter is honesty rather than authorization:
 * a level this UI cannot label is one it cannot explain, so offering it would
 * let a user save a setting the screen could not describe back to them. The
 * DATABASE still decides which levels exist — dropping an unnameable one can
 * only ever narrow what is offered, never widen it.
 */
export interface AiModelOption {
  id: string;
  provider: string;
  displayName: string;
  enabled: boolean;
  selectable: boolean;
  reasoningLevels: AiReasoningLevel[];
  automaticAnalyzeReasoningLevel: AiReasoningLevel | null;
  automaticSuggestReasoningLevel: AiReasoningLevel | null;
  reasoningSelectable: boolean;
}

/** Normalize a catalog row's reasoning level list, dropping unnameable values. */
function readReasoningLevels(value: unknown): AiReasoningLevel[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isAiReasoningLevel);
}

/** Normalize a nullable canonical level, failing closed on anything unknown. */
function readReasoningLevel(value: unknown): AiReasoningLevel | null {
  return isAiReasoningLevel(value) ? value : null;
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
  | {
      status: "active";
      modelId: string;
      displayName: string;
      selectable: boolean;
      /**
       * The whole catalog entry for the saved model — AI-MULTI-PROVIDER-001C.
       *
       * The reasoning control needs this model's OWN level list and its OWN
       * Automatic policy, and a saved model is not always among `options` (an
       * `enabled = true, selectable = false` row is honoured but not offered).
       * Carrying the entry here is what lets the component describe the account's
       * real state without looking a model up by id or, worse, hard-coding what a
       * given model's Automatic policy is.
       */
      option: AiModelOption;
    }
  | { status: "unavailable"; modelId: string; displayName: string | null };

/**
 * The saved reasoning preference, resolved against the effective model.
 *
 * `automatic` is a `null` column value and MEANS PaperLume chooses per model and
 * per operation — it is not "unset" and not a failed read. A failed read leaves
 * `saved` null and raises `isError`, exactly as for the model.
 *
 * `manual` is a level the saved model still lists: what the runtime will
 * actually send, for both operations.
 *
 * `unsupported` is a level the saved model no longer lists — reachable after a
 * model change the server did not have to reset (it does reset incompatible
 * levels atomically), or after a catalog row's capability list narrowed. The
 * runtime falls back to that model's Automatic policy and never sends the
 * invalid value; the UI reports that truthfully and offers the way back, and
 * deliberately does not rewrite the user's saved choice behind their back.
 */
export type SavedReasoningState =
  | { status: "automatic" }
  | { status: "manual"; level: AiReasoningLevel }
  | { status: "unsupported"; level: AiReasoningLevel };

/** Bounded rejection classes the MODEL setter can return. */
type RejectionKind = "entitlement" | "catalog" | "unknown";

/** Bounded rejection classes the REASONING setter can return. */
type ReasoningRejectionKind = "entitlement" | "reasoning" | "unknown";

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

/**
 * The reasoning setter's own model- and level-specific refusals
 * (AI-MULTI-PROVIDER-001C).
 *
 * A SEPARATE function rather than more entries in `classifyReason`, because the
 * two setters share reason STRINGS that do not share meanings.
 * `model_disabled` from the model setter means "the model you just picked is
 * retired — pick another"; from the reasoning setter it means "your saved
 * model is retired, so your reasoning choice does not apply". Folding them
 * together would send a user to fix the wrong control, and did exactly that
 * until a test caught it.
 *
 * `model_required` is here for the same kind of reason: it means the account is
 * on PaperLume's default model, where reasoning is Automatic by design — a
 * state the UI should never have let the user act from, so it reads as a stale
 * view rather than an unavailable model.
 */
const REASONING_REASONS: readonly string[] = [
  "model_required",
  "model_missing",
  "model_disabled",
  "reasoning_not_selectable",
  "reasoning_level_not_supported",
];

function classifyReasoningReason(reason: unknown): ReasoningRejectionKind {
  if (typeof reason !== "string") return "unknown";
  if (ENTITLEMENT_REASONS.includes(reason)) return "entitlement";
  if (REASONING_REASONS.includes(reason)) return "reasoning";
  // `invalid_reasoning_level` lands here on purpose: a value outside the
  // canonical vocabulary is a client bug, not something to explain to the user.
  return "unknown";
}

/** Structured setter row (SETOF → array in supabase-js). */
interface SetModelRow {
  saved: boolean | null;
  reason: string | null;
  display_name: string | null;
  /**
   * AI-MULTI-PROVIDER-001C. `true` when the SAME transaction that saved the
   * model also reset an incompatible manual reasoning level to Automatic.
   * Absent on a database that predates the migration, which reads as `false` —
   * nothing was reset, because there was nothing to reset.
   */
  reasoning_reset?: boolean | null;
}
/** Structured clear row. */
interface ClearModelRow {
  cleared: boolean | null;
  reason: string | null;
}
/** Structured reasoning setter row. */
interface SetReasoningRow {
  saved: boolean | null;
  reason: string | null;
}
/** Structured reasoning clear row. */
interface ClearReasoningRow {
  cleared: boolean | null;
  reason: string | null;
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] ?? null) as T | null;
  return (data ?? null) as T | null;
}

type SaveOutcome =
  | { ok: true; displayName: string | null; reasoningReset: boolean }
  | { ok: false; kind: RejectionKind };

/**
 * The reasoning setter's outcome.
 *
 * Carries the RAW reason rather than a pre-classified kind, unlike
 * `SaveOutcome`, because the reasoning reporter classifies with a different
 * precedence: `model_disabled` appears in both vocabularies and means "pick
 * another model" for one control and "your reasoning choice no longer applies"
 * for the other.
 */
type ReasoningOutcome = { ok: true } | { ok: false; reason: unknown };

/** Both halves of the caller's saved preference row, or their absence. */
interface PreferenceSnapshot {
  modelId: string | null;
  reasoningLevel: AiReasoningLevel | null;
}

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
  /** The saved reasoning choice resolved against that model; null while unresolved. */
  savedReasoning: SavedReasoningState | null;
  isLoading: boolean;
  /** True when the catalog OR the preference read failed. Never "no preference". */
  isError: boolean;
  /** Refetch both reads — the retry affordance for the error state. */
  refetch: () => void;
  /** Pin a catalog model. Never called with {@link PAPERLUME_DEFAULT_VALUE}. */
  saveModel: (modelId: string) => void;
  /** Return to Paperlume's system default. */
  clearModel: () => void;
  /**
   * Save a manual reasoning level for the currently saved model.
   *
   * Never called with {@link AUTOMATIC_REASONING_VALUE}, and refused outright
   * unless a named model is saved AND that model's reasoning control is open to
   * new selections. Those are the server's own preconditions, mirrored here so
   * the UI does not make a request it knows will be rejected — the server
   * re-checks both regardless, and its answer is the authoritative one.
   */
  saveReasoning: (level: AiReasoningLevel) => void;
  /** Return reasoning to Automatic, keeping the saved model. */
  clearReasoning: () => void;
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
        reasoningLevels: readReasoningLevels(row.reasoning_levels),
        automaticAnalyzeReasoningLevel: readReasoningLevel(row.auto_analyze_reasoning_level),
        automaticSuggestReasoningLevel: readReasoningLevel(row.auto_suggest_reasoning_level),
        reasoningSelectable: !!row.reasoning_selectable,
      }));
    },
    enabled,
    staleTime: 60_000,
  });

  const preferenceQuery = useQuery<PreferenceSnapshot>({
    queryKey: queryKeys.aiModelSettings.preference(scopeId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_ai_preferences")
        // Explicit projection, extended with the reasoning column rather than
        // widened to `*`: every column this surface reads is stated, so a future
        // column on this table has to be admitted deliberately.
        .select("preferred_model_id, preferred_reasoning_level")
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
      return {
        modelId: row?.preferred_model_id ?? null,
        // Unknown values fail closed to Automatic. A level this build cannot
        // name is one it cannot explain, and rendering it would be inventing a
        // setting; the runtime independently refuses to send it.
        reasoningLevel: readReasoningLevel(row?.preferred_reasoning_level),
      };
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

    const modelId = preferenceQuery.data.modelId;
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
      option: entry,
    };
  }, [catalog, catalogQuery.data, preferenceQuery.data, isError]);

  /**
   * The reasoning half of the same row, resolved against the saved model.
   *
   * `null` while unresolved, exactly like `saved`, and for exactly the same
   * reason: a failed read must never be rendered as "Automatic", because
   * Automatic is a real state the user may be in and the two would be
   * indistinguishable.
   *
   * A manual level is only ever reported against an ACTIVE saved model.
   * PaperLume's default model carries no reasoning choice by construction (the
   * row that would hold one does not exist), and an unavailable model is one
   * the runtime is already routing around — its reasoning level is not what is
   * being applied, so showing it as in force would be a lie.
   */
  const savedReasoning = useMemo<SavedReasoningState | null>(() => {
    if (isError) return null;
    if (catalogQuery.data === undefined || preferenceQuery.data === undefined) return null;
    if (saved === null) return null;

    const level = preferenceQuery.data.reasoningLevel;
    if (level === null) return { status: "automatic" };
    if (saved.status !== "active") return { status: "automatic" };
    return saved.option.reasoningLevels.includes(level)
      ? { status: "manual", level }
      : { status: "unsupported", level };
  }, [saved, catalogQuery.data, preferenceQuery.data, isError]);

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
      return {
        ok: true,
        displayName: row.display_name,
        // Strictly `true`: a missing or malformed flag means nothing was reset,
        // and claiming a reset that did not happen would misreport the account.
        reasoningReset: row.reasoning_reset === true,
      };
    },
    onSuccess: (outcome) => {
      if (!outcome.ok) {
        reportRejection(outcome.kind);
        return;
      }
      void invalidatePreference();
      if (outcome.reasoningReset) {
        // The server already reset the level atomically with the model change;
        // this only tells the user it happened, in product words. Nothing here
        // names a provider parameter or the level that was dropped.
        toast({
          title: "AI model updated",
          description:
            "Reasoning was reset to Automatic because the new model does not support your " +
            "previous level.",
        });
        return;
      }
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

  /**
   * Present a bounded reasoning rejection.
   *
   * Deliberately a separate reporter from the model one. The reasons overlap
   * (entitlement is checked the same way) but the remedies do not: a reasoning
   * rejection never means "choose another model", and telling a user to refresh
   * and pick a different model because their reasoning level was refused would
   * send them to fix the wrong control.
   */
  const reportReasoningRejection = (reason: unknown) => {
    const kind = classifyReasoningReason(reason);
    if (kind === "entitlement") {
      void invalidateAccess();
      void invalidatePreference();
      toast({
        title: "Reasoning unchanged",
        description: "Reasoning selection is not available for this account.",
        variant: "destructive",
      });
      return;
    }
    if (kind === "reasoning") {
      // The model changed, was retired, or its reasoning control closed since
      // this dialog opened. Both reads are stale evidence at this point.
      void invalidateCatalog();
      void invalidatePreference();
      toast({
        title: "Reasoning unchanged",
        description:
          "That reasoning level is not available for your current model. Refresh and try again.",
        variant: "destructive",
      });
      return;
    }
    void invalidatePreference();
    toast({
      title: "Could not update reasoning level",
      description: "Please try again.",
      variant: "destructive",
    });
  };

  const saveReasoningMutation = useMutation<ReasoningOutcome, unknown, AiReasoningLevel>({
    mutationFn: async (level: AiReasoningLevel) => {
      const { data, error } = await supabase.rpc("set_current_user_ai_reasoning", {
        p_reasoning_level: level,
      });
      if (error) throw error;
      const row = firstRow<SetReasoningRow>(data);
      // A missing/malformed row is NOT a success, for the same reason it is not
      // one for the model setter: reporting "saved" for a write that may not
      // have happened is the single worst outcome available here.
      if (!row || row.saved !== true) {
        return { ok: false, reason: row?.reason };
      }
      return { ok: true };
    },
    onSuccess: (outcome, level) => {
      if (!outcome.ok) {
        reportReasoningRejection(outcome.reason);
        return;
      }
      void invalidatePreference();
      toast({
        title: "Reasoning level updated",
        description: `Paperlume will use ${level} reasoning for Analyze and organization suggestions.`,
      });
    },
    onError: () => {
      toast({
        title: "Could not update reasoning level",
        description: "Please try again.",
        variant: "destructive",
      });
    },
  });

  const clearReasoningMutation = useMutation<boolean, unknown, void>({
    mutationFn: async () => {
      // No arguments: the row updated is the caller's, derived from auth.uid().
      const { data, error } = await supabase.rpc("clear_current_user_ai_reasoning");
      if (error) throw error;
      const row = firstRow<ClearReasoningRow>(data);
      // Both outcomes mean "this account is on Automatic": `cleared = true`
      // removed a manual level, and `no_reasoning_preference` found none to
      // remove. The clear RPC is intentionally idempotent.
      return row?.cleared === true || row?.reason === "no_reasoning_preference";
    },
    onSuccess: (ok) => {
      void invalidatePreference();
      if (!ok) {
        toast({
          title: "Could not update reasoning level",
          description: "Please try again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Using automatic reasoning",
        description: "Paperlume will choose a reasoning level for each task.",
      });
    },
    onError: () => {
      toast({
        title: "Could not update reasoning level",
        description: "Please try again.",
        variant: "destructive",
      });
    },
  });

  const isMutating =
    saveMutation.isPending ||
    clearMutation.isPending ||
    saveReasoningMutation.isPending ||
    clearReasoningMutation.isPending;

  return {
    options: optionsList,
    saved,
    savedReasoning,
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
    saveReasoning: (level: AiReasoningLevel) => {
      if (isMutating) return;
      // The server's own preconditions, checked here so the UI never issues a
      // request it already knows is refused. Both are mirrors, never the gate:
      // `set_current_user_ai_reasoning` re-derives the caller, re-reads the
      // saved model and re-checks `reasoning_selectable` itself, and until a
      // separately authorized user-enablement migration grants EXECUTE it is
      // not callable at all.
      if (saved?.status !== "active") return;
      if (!saved.option.reasoningSelectable) return;
      if (!saved.option.reasoningLevels.includes(level)) return;
      saveReasoningMutation.mutate(level);
    },
    clearReasoning: () => {
      if (isMutating) return;
      // Deliberately NOT gated on `reasoningSelectable`: leaving a manual level
      // must never be blocked by the flag that controls entering one, or a
      // staged-off model would trap whoever already chose a level. The RPC
      // makes the same choice, and requires no entitlement either.
      clearReasoningMutation.mutate();
    },
    isMutating,
  };
}
