import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCurrentUserAccess } from "@/hooks/useCurrentUserAccess";
import {
  PAPERLUME_DEFAULT_VALUE,
  useAiModelSettings,
  type SavedModelState,
  type SavedReasoningState,
} from "@/hooks/useAiModelSettings";
import {
  AUTOMATIC_REASONING_LABEL,
  AUTOMATIC_REASONING_VALUE,
  formatAutomaticReasoningSummary,
  isAiReasoningLevel,
  reasoningLevelDescription,
  reasoningLevelLabel,
} from "@/lib/aiReasoning";

interface AiModelSettingsSectionProps {
  /**
   * Authenticated user id, threaded from the dialog rather than resolved from a
   * second auth source. The RPCs derive the write identity from `auth.uid()`
   * regardless; this only scopes the reads and their caches.
   */
  userId?: string | null;
  /** Settings is open — gates the reads so nothing is fetched while closed. */
  open: boolean;
}

const SELECT_ID = "ai-model-select";
const STATUS_ID = "ai-model-status";
const REASONING_SELECT_ID = "ai-reasoning-select";
const REASONING_LABEL_ID = "ai-reasoning-label";
const REASONING_STATUS_ID = "ai-reasoning-status";

/**
 * Settings → AI Model (AI-MODEL-SELECTION-001C).
 *
 * Lets an entitled user follow Paperlume's system default or pin one of the
 * models the server-controlled catalog offers. Two things it deliberately is
 * not:
 *
 *   • It is not an authorization boundary. `access.canSelectAiModel` — the
 *     server's own `can_select_ai_model` projection — decides what is rendered,
 *     and `set_current_user_ai_model` re-checks the same entitlement anyway.
 *     There is no plan-name, email, role or storage-based substitute gate.
 *   • It is not a source of truth for what the default *is*. "Paperlume
 *     default" is a sentinel meaning "no saved preference"; the running model
 *     is resolved from server-side `GEMINI_MODEL`, so a future default switch
 *     never depends on a frontend deploy.
 *
 * Every state is carried in text as well as by control state, so nothing here
 * is communicated by colour or by a disabled outline alone. There is no
 * upgrade, checkout or pricing affordance.
 */
export function AiModelSettingsSection({ userId, open }: AiModelSettingsSectionProps) {
  const access = useCurrentUserAccess(userId);
  const model = useAiModelSettings(userId, { enabled: open });

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium">AI Model</h3>
      </div>
      <AiModelSettingsBody access={access} model={model} />
    </div>
  );
}

type AccessResult = ReturnType<typeof useCurrentUserAccess>;
type ModelResult = ReturnType<typeof useAiModelSettings>;

function AiModelSettingsBody({ access, model }: { access: AccessResult; model: ModelResult }) {
  // Loading — access OR model settings. An enabled control must never flash
  // before entitlement is known, so this branch comes before every other one.
  if (access.isLoading || model.isLoading) {
    return (
      <Skeleton className="h-10 w-full" aria-busy="true" aria-label="Loading AI model settings" />
    );
  }

  // Access lookup failed: entitlement is unknown, so it is treated as absent.
  // Nothing is inferred from the plan, from a cached choice, or from the mere
  // existence of a preference row.
  if (access.isError) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Unable to verify model-selection access right now.
        </p>
        <Button variant="outline" size="sm" onClick={() => access.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  // Catalog or preference read failed. A failed read is never "no preference"
  // and never a reason to render a list this component invented, so no control
  // is offered at all. Raw Supabase/Postgres text is not surfaced.
  if (model.isError || !model.saved) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          AI model settings are unavailable right now.
        </p>
        <Button variant="outline" size="sm" onClick={() => model.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!access.access.canSelectAiModel) {
    return <NonEntitledBody model={model} saved={model.saved} />;
  }

  return (
    <div className="space-y-4">
      <EntitledBody model={model} saved={model.saved} />
      <ReasoningControl
        model={model}
        saved={model.saved}
        savedReasoning={model.savedReasoning ?? { status: "automatic" }}
      />
    </div>
  );
}

/**
 * No model-selection entitlement.
 *
 * No selector is rendered — not a disabled one, none at all — so there is
 * nothing to enable by tampering with the DOM. A dormant saved preference is
 * still shown and still clearable: `clear_current_user_ai_model()` requires no
 * entitlement precisely so a downgraded account is never trapped holding a
 * choice it cannot remove.
 */
function NonEntitledBody({ model, saved }: { model: ModelResult; saved: SavedModelState }) {
  const dormantName =
    saved.status === "active"
      ? saved.displayName
      : saved.status === "unavailable"
        ? (saved.displayName ?? null)
        : null;

  return (
    <div className="space-y-2" aria-busy={model.isMutating || undefined}>
      <p className="text-sm">Paperlume is using its default model.</p>
      {/*
        Reasoning is stated even here, as visible text rather than a control.
        An account on Paperlume's default model is on automatic reasoning by
        construction, and leaving that unsaid would make the setting invisible
        to exactly the users who cannot change it.
      */}
      <p className="text-xs text-muted-foreground">
        Reasoning level: {AUTOMATIC_REASONING_LABEL}. Paperlume chooses the model and adjusts
        reasoning for each task.
      </p>
      {saved.status === "none" ? (
        <p className="text-xs text-muted-foreground">
          Model selection is available on eligible plans.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {dormantName
              ? `Your saved model (${dormantName}) is inactive because model selection is not available for this account.`
              : "Your saved model is inactive because model selection is not available for this account."}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => model.clearModel()}
            disabled={model.isMutating}
          >
            {model.isMutating && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />}
            Reset to Paperlume default
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * Entitled: the real selector.
 *
 * The Select's value is the saved model id, or the sentinel when no row exists.
 * A saved model that is not among the choosable options — `selectable = false`,
 * disabled, retired, or from a provider this build cannot route to — is still
 * rendered, as a **disabled** item, for two reasons: the trigger needs an item
 * to draw its label from, and hiding it would misreport the account's actual
 * saved state.
 */
function EntitledBody({ model, saved }: { model: ModelResult; saved: SavedModelState }) {
  const value = saved.status === "none" ? PAPERLUME_DEFAULT_VALUE : saved.modelId;
  const isChoosable =
    saved.status === "active" && model.options.some((option) => option.id === saved.modelId);

  const handleChange = (next: string) => {
    if (next === value) return;
    if (next === PAPERLUME_DEFAULT_VALUE) {
      // The sentinel is a UI value, never a model id — clearing is its only
      // meaning, and it is never handed to the setter RPC.
      model.clearModel();
      return;
    }
    model.saveModel(next);
  };

  return (
    <div className="space-y-2" aria-busy={model.isMutating || undefined}>
      <Select value={value} onValueChange={handleChange} disabled={model.isMutating}>
        <SelectTrigger
          id={SELECT_ID}
          aria-label="AI model"
          aria-describedby={STATUS_ID}
          disabled={model.isMutating}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PAPERLUME_DEFAULT_VALUE}>Paperlume default</SelectItem>
          {model.options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.displayName}
            </SelectItem>
          ))}
          {/*
            The saved model when it is no longer a valid new choice. Disabled,
            so leaving it is a one-way move — which is exactly what
            `selectable = false` means on the server.
          */}
          {!isChoosable && saved.status !== "none" && (
            <SelectItem value={saved.modelId} disabled>
              {savedItemLabel(saved)}
            </SelectItem>
          )}
        </SelectContent>
      </Select>

      <p id={STATUS_ID} className="text-xs text-muted-foreground">
        <SavedStatusText saved={saved} isChoosable={isChoosable} />
      </p>

      {model.isMutating && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Saving your model preference…
        </p>
      )}
    </div>
  );
}

function savedItemLabel(saved: SavedModelState): string {
  if (saved.status === "unavailable") {
    return saved.displayName ? `${saved.displayName} (unavailable)` : "Saved model (unavailable)";
  }
  if (saved.status === "active") return saved.displayName;
  return "Paperlume default";
}

/**
 * The one line of text that explains what the current value means. It is what
 * `aria-describedby` points at, so every state below is reachable by a screen
 * reader without inspecting the control itself.
 */
function SavedStatusText({
  saved,
  isChoosable,
}: {
  saved: SavedModelState;
  isChoosable: boolean;
}) {
  if (saved.status === "none") {
    return (
      <>
        Paperlume default follows Paperlume&apos;s currently recommended model. Choosing a named
        model saves it for this account.
      </>
    );
  }

  if (saved.status === "unavailable") {
    return (
      <>Your saved model is no longer available. Paperlume is using the default model.</>
    );
  }

  if (!isChoosable) {
    return (
      <>
        {saved.displayName} is your saved model and is still in use. It is no longer offered for
        new selections, so switching away is permanent.
      </>
    );
  }

  return (
    <>
      {saved.displayName} is saved for this account. Switch to Paperlume default to follow
      Paperlume&apos;s recommended model instead.
    </>
  );
}

/**
 * Settings → AI Model → Reasoning level (AI-MULTI-PROVIDER-001C, C41).
 *
 * How hard the model should think. One control, applying to BOTH Analyze and
 * organization suggestions — deliberately not two — and three things it is
 * carefully not:
 *
 *   • It is not a source of truth for what any model supports. The options come
 *     from that model's own `reasoning_levels` catalog column, and this file
 *     contains no model id: a component that branched on
 *     `google/gemini-3.5-flash` to decide what Automatic means would be a
 *     second copy of PaperLume's policy, in the browser, able to disagree with
 *     the server that actually sends it.
 *   • It is not an authorization boundary. `reasoning_selectable` decides
 *     whether a manual choice is offered, and `set_current_user_ai_reasoning`
 *     re-checks it — along with entitlement, the saved model and the level —
 *     server-side. Today that RPC is granted to no role at all, and every
 *     catalog row has `reasoning_selectable = false`, so the manual path is
 *     implemented and not activated.
 *   • It is not provider terminology. Nothing here says `thinkingLevel`,
 *     `output_config.effort` or `reasoning.effort`; those are three providers'
 *     spellings of one product idea and stay in the Edge adapters.
 *
 * ## Accessibility
 *
 * Every piece of load-bearing information is visible text with a programmatic
 * relationship to the control: the label is real text referenced by
 * `aria-labelledby`, and the status line — which carries the effective policy,
 * including the exact Automatic levels — is referenced by `aria-describedby`.
 * Nothing essential lives in a tooltip, a colour, an icon or a disabled
 * outline, so the whole state is reachable by a screen reader without
 * inspecting the control.
 */
function ReasoningControl({
  model,
  saved,
  savedReasoning,
}: {
  model: ModelResult;
  saved: SavedModelState;
  savedReasoning: SavedReasoningState;
}) {
  const option = saved.status === "active" ? saved.option : null;

  // A manual level is offerable only for a named, active model whose reasoning
  // control the server has opened. `reasoning_selectable = false` — the state
  // of every catalog row today — leaves the choice unoffered rather than
  // offered-and-refused, so the UI never implies a save that cannot happen.
  const canChooseManual = option !== null && option.reasoningSelectable;

  // A manual level that is already saved. It must stay visible and must stay
  // leavable even when new selection is closed, mirroring how an
  // `enabled, not selectable` MODEL behaves: switching away is permitted,
  // switching sideways is not.
  const savedLevel =
    savedReasoning.status === "automatic" ? null : savedReasoning.level;

  const value = savedLevel ?? AUTOMATIC_REASONING_VALUE;
  // Enabled when there is either a choice to make or a choice to leave.
  const controlEnabled = canChooseManual || savedLevel !== null;

  const handleChange = (next: string) => {
    if (next === value) return;
    if (next === AUTOMATIC_REASONING_VALUE) {
      // The sentinel is a UI value, never a reasoning level — clearing is its
      // only meaning, and it is never handed to the setter RPC.
      model.clearReasoning();
      return;
    }
    // Fail closed on anything this build cannot name. The hook refuses it too,
    // and so does the database; this is the first of the three.
    if (!isAiReasoningLevel(next)) return;
    model.saveReasoning(next);
  };

  return (
    <div className="space-y-2">
      <p id={REASONING_LABEL_ID} className="text-sm font-medium">
        Reasoning level
      </p>
      <Select
        value={value}
        onValueChange={handleChange}
        disabled={model.isMutating || !controlEnabled}
      >
        <SelectTrigger
          id={REASONING_SELECT_ID}
          aria-labelledby={REASONING_LABEL_ID}
          aria-describedby={REASONING_STATUS_ID}
          disabled={model.isMutating || !controlEnabled}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTOMATIC_REASONING_VALUE}>{AUTOMATIC_REASONING_LABEL}</SelectItem>
          {/*
            Exactly this model's own levels, in the catalog's order, and only
            when new selection is open. Levels a model does not support are
            simply absent — never rendered disabled, which would advertise a
            capability that does not exist.
          */}
          {canChooseManual &&
            option.reasoningLevels.map((level) => (
              <SelectItem key={level} value={level}>
                {reasoningLevelLabel(level)}
              </SelectItem>
            ))}
          {/*
            A saved level while new selection is closed. Disabled, so leaving it
            is a one-way move — which is exactly what `reasoning_selectable =
            false` means on the server — and present at all because the trigger
            needs an item to draw its label from.
          */}
          {!canChooseManual && savedLevel !== null && (
            <SelectItem value={savedLevel} disabled>
              {reasoningLevelLabel(savedLevel)}
            </SelectItem>
          )}
        </SelectContent>
      </Select>

      <div id={REASONING_STATUS_ID} className="space-y-1 text-xs text-muted-foreground">
        <ReasoningStatusText
          saved={saved}
          savedReasoning={savedReasoning}
          canChooseManual={canChooseManual}
        />
      </div>
    </div>
  );
}

/**
 * The text that explains what the current reasoning value actually means.
 *
 * This is what `aria-describedby` points at, so every state below is reachable
 * by a screen reader without inspecting the control — and it is where the
 * question "what does Automatic do?" is answered concretely rather than by
 * adjective. For a named model the exact effective policy is printed
 * ("Analyze: Minimal · Organization suggestions: Medium"), built from that
 * model's catalog metadata.
 */
function ReasoningStatusText({
  saved,
  savedReasoning,
  canChooseManual,
}: {
  saved: SavedModelState;
  savedReasoning: SavedReasoningState;
  canChooseManual: boolean;
}) {
  // Paperlume's default model. Manual reasoning is deliberately unavailable
  // here: Paperlume may change its default model server-side at any time, and a
  // level saved against "whatever the default happens to be" could silently
  // become invalid. The explanation says so rather than leaving a disabled
  // control unexplained.
  if (saved.status === "none") {
    return (
      <p>
        {AUTOMATIC_REASONING_LABEL} is used with Paperlume default. Paperlume chooses the model and
        adjusts reasoning for each task: Analyze uses a lighter reasoning setting, and organization
        suggestions use Medium. Choose a specific model to customize reasoning.
      </p>
    );
  }

  if (saved.status === "unavailable") {
    return (
      <p>
        Your saved model is no longer available, so Paperlume is using its default model and
        choosing a reasoning level for each task.
      </p>
    );
  }

  const { option } = saved;
  const automaticSummary = formatAutomaticReasoningSummary(
    option.automaticAnalyzeReasoningLevel,
    option.automaticSuggestReasoningLevel,
  );

  // A saved level this model no longer lists. The runtime already falls back to
  // this model's automatic policy and never sends the stale value; the honest
  // thing is to say that and offer the way back, not to quietly rewrite what
  // the user chose.
  if (savedReasoning.status === "unsupported") {
    return (
      <>
        <p>
          {reasoningLevelLabel(savedReasoning.level)} is saved but {option.displayName} no longer
          supports it. Paperlume is choosing a reasoning level for each task instead. Switch to{" "}
          {AUTOMATIC_REASONING_LABEL} to clear it.
        </p>
        {automaticSummary && <p>{automaticSummary}</p>}
      </>
    );
  }

  if (savedReasoning.status === "manual") {
    return (
      <>
        <p>{reasoningLevelDescription(savedReasoning.level)}</p>
        {!canChooseManual && (
          <p>
            {option.displayName} is no longer accepting new reasoning choices, so switching away
            from {reasoningLevelLabel(savedReasoning.level)} is permanent.
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <p>Recommended. Paperlume adjusts reasoning to the task.</p>
      {automaticSummary ? (
        <p>{automaticSummary}</p>
      ) : (
        <p>Paperlume chooses a reasoning level for each task.</p>
      )}
      <p>This balances quality, speed, and cost.</p>
      {!canChooseManual && (
        <p>Choosing a reasoning level is not available for {option.displayName}.</p>
      )}
    </>
  );
}
