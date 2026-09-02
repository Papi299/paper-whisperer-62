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
} from "@/hooks/useAiModelSettings";

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

  return <EntitledBody model={model} saved={model.saved} />;
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
