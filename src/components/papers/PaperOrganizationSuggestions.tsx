/**
 * The AI organization-suggestion surface inside Edit Paper —
 * AI-PROJECT-TAG-SUGGESTIONS-001B.
 *
 * One explicit button asks `suggest-paper-organization` which of the user's
 * Projects and Tags fit the paper they are editing, and what — if anything —
 * is worth creating. Everything it returns is a *recommendation*. This
 * component never assigns a paper, never saves, and never creates anything
 * without a second, separate click.
 *
 * ## The two acceptance semantics, which differ on purpose
 *
 * **An existing Project/Tag** becomes a LOCAL selection in Edit Paper and
 * nothing more: `onSelectProject` / `onSelectTag` add an id to the dialog's
 * state, and `set_paper_projects` / `set_paper_tags` run only when the user
 * presses Save Changes. Close the dialog without saving and the acceptance is
 * gone, exactly as if the user had picked the same entry from the Projects
 * selector by hand.
 *
 * **A proposed new Project/Tag** is different, and the UI says so out loud:
 * "Create & select" creates the entity immediately through the existing
 * mutation path, because a Project that does not exist cannot be selected. The
 * *paper assignment* is still staged until Save. So closing without saving
 * leaves the new Project in the library and the paper unassigned — which is
 * why the helper line under those items states it in one sentence rather than
 * hiding it behind a confirmation dialog.
 *
 * ## Identity safety
 *
 * Two rules keep a model-authored string from ever resolving to the wrong row:
 *
 *   - An **existing** suggestion carries a server-resolved id, and its action
 *     is derived against the CURRENT `projects`/`tags` props. If the row is
 *     gone by the time the user looks, the item renders as unavailable instead
 *     of selecting a stale id.
 *   - A **new** proposal is reconciled against the CURRENT taxonomy at click
 *     time via `matchTaxonomyName` — not against the snapshot the server saw.
 *     Exactly one match selects that row instead of creating a duplicate;
 *     several matches create nothing, select nothing, and say so. There is no
 *     tie-break, deliberately: see `src/lib/taxonomyNameMatch.ts`.
 *
 * ## Staleness
 *
 * Gemini takes seconds, and a draft can change inside that window. Each
 * generation captures a sequence number, the paper id and a semantic
 * fingerprint of the draft; a response commits only if all three still match.
 * Once results are on screen, a later edit to title/abstract/keywords/study
 * type marks them stale — accepted selections stay, but nothing further can be
 * accepted until the user generates again, because the reasons on screen no
 * longer describe what they are editing.
 */

import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Check,
  FolderOpen,
  Loader2,
  Plus,
  Sparkles,
  Tags,
  X,
} from "lucide-react";
import type { Project, Tag } from "@/types/database";
import type { AiQuotaStatus } from "@/hooks/useAiQuota";
import { formatQuotaExceededMessage } from "@/lib/analyzeError";
import { matchTaxonomyName, normalizeTaxonomyName } from "@/lib/taxonomyNameMatch";
import {
  isDraftEligibleForSuggestions,
  organizationDraftFingerprint,
  type OrganizationDraftState,
} from "@/lib/paperOrganizationDraft";
import {
  isEmptySuggestions,
  suggestPaperOrganization,
  SuggestOrganizationError,
  type ExistingProjectSuggestion,
  type ExistingTagSuggestion,
  type NewProjectSuggestion,
  type NewTagSuggestion,
  type OrganizationSuggestions,
} from "@/lib/suggestPaperOrganizationEdge";

export interface PaperOrganizationSuggestionsProps {
  paperId: string;
  draft: OrganizationDraftState;
  /** The user's current taxonomy. Action availability is derived from these. */
  projects: Project[];
  tags: Tag[];
  /** Edit Paper's current LOCAL selection — unsaved. */
  selectedProjectIds: string[];
  selectedTagIds: string[];
  /** Add-only: accepting a suggestion must never deselect anything. */
  onSelectProject: (projectId: string) => void;
  onSelectTag: (tagId: string) => void;
  /** The existing domain mutations. Absent → the create actions are not offered. */
  onCreateProject?: (name: string, description?: string | null) => Promise<Project | null>;
  onCreateTag?: (name: string) => Promise<Tag | null>;
  /** Advisory, read-only. Never the enforcement boundary — the server's 402 is. */
  quotaStatus?: AiQuotaStatus | null;
  /** Called after any actual invocation (success, provider failure, or 402). */
  onQuotaRefresh?: () => void;
  /** True while the dialog is saving; the whole surface goes inert. */
  disabled?: boolean;
}

/** Copy shown when the draft cannot support a useful suggestion. */
const INELIGIBLE_HINT =
  "Add an abstract, keywords, or a study type to get useful suggestions.";

/** One dismissible item's stable key. Names are normalized so case cannot resurrect a dismissal. */
function existingProjectKey(id: string): string {
  return `ep:${id}`;
}
function existingTagKey(id: string): string {
  return `et:${id}`;
}
function newProjectKey(name: string): string {
  return `np:${normalizeTaxonomyName(name)}`;
}
function newTagKey(name: string): string {
  return `nt:${normalizeTaxonomyName(name)}`;
}

/** Shared shell for one suggestion row. */
function SuggestionRow({
  icon,
  name,
  reason,
  detail,
  hint,
  actions,
}: {
  icon: React.ReactNode;
  name: string;
  reason: string;
  detail?: string | null;
  hint?: string | null;
  actions: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 rounded-md border bg-background/60 p-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <span className="shrink-0 text-muted-foreground" aria-hidden="true">
            {icon}
          </span>
          <span className="break-words">{name}</span>
        </div>
        {detail ? <p className="text-xs text-muted-foreground break-words">{detail}</p> : null}
        <p className="text-xs text-muted-foreground break-words">{reason}</p>
        {hint ? <p className="text-xs text-muted-foreground break-words">{hint}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </li>
  );
}

export function PaperOrganizationSuggestions({
  paperId,
  draft,
  projects,
  tags,
  selectedProjectIds,
  selectedTagIds,
  onSelectProject,
  onSelectTag,
  onCreateProject,
  onCreateTag,
  quotaStatus,
  onQuotaRefresh,
  disabled = false,
}: PaperOrganizationSuggestionsProps) {
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<OrganizationSuggestions | null>(null);
  /** The fingerprint the on-screen results were generated for. */
  const [resultFingerprint, setResultFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [creatingKey, setCreatingKey] = useState<string | null>(null);
  /** Short outcome sentence for the live region (generation, creation, collisions). */
  const [notice, setNotice] = useState<string | null>(null);

  const fingerprint = useMemo(() => organizationDraftFingerprint(draft), [draft]);
  const eligible = isDraftEligibleForSuggestions(draft);

  // Latest-value refs, assigned during render so a response resolving in a
  // microtask can never read a value older than the props that are on screen.
  // An effect would run too late to be trusted for that comparison.
  const paperIdRef = useRef(paperId);
  paperIdRef.current = paperId;
  const fingerprintRef = useRef(fingerprint);
  fingerprintRef.current = fingerprint;
  /** Monotonic generation counter — only the newest request may commit. */
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset every transient suggestion value when the dialog switches papers, so
  // one paper's recommendations can never be read — or accepted — against
  // another's. The form's own state is the dialog's business, not this
  // component's; nothing here touches it.
  useEffect(() => {
    requestSeqRef.current += 1;
    setLoading(false);
    setSuggestions(null);
    setResultFingerprint(null);
    setError(null);
    setDismissed(new Set());
    setCreatingKey(null);
    setNotice(null);
  }, [paperId]);

  /**
   * Results are stale once the draft they describe has been edited. Derived
   * rather than stored, so it cannot disagree with what is on screen.
   */
  const stale = suggestions !== null && resultFingerprint !== null && resultFingerprint !== fingerprint;

  /**
   * Positively known to have nothing left. An AI-quota-exempt internal user is
   * NEVER known-zero: their commercial `remaining` can read 0 while the server
   * still allows the request. Unknown status (loading / failed) is not
   * known-zero either — the server's 402 stays authoritative.
   */
  const knownZeroQuota = !!quotaStatus && !quotaStatus.isExempt && quotaStatus.remaining <= 0;

  const toastQuotaExhausted = useCallback(
    (info: { periodType: string | null; used: number; quota: number; resetAt: string | null }) => {
      toast({
        title: "AI requests used up",
        description: formatQuotaExceededMessage(info),
        variant: "destructive",
      });
    },
    [toast],
  );

  const handleGenerate = useCallback(async () => {
    if (loading || disabled || !eligible) return;

    // Known-zero convenience intercept: no request, and therefore no quota
    // refresh either — nothing was spent.
    if (knownZeroQuota && quotaStatus) {
      toastQuotaExhausted(quotaStatus);
      return;
    }

    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const paperIdAtRequest = paperId;
    const fingerprintAtRequest = fingerprint;

    setLoading(true);
    setError(null);
    setNotice(null);

    /** Only a real invocation may trigger a quota refresh. */
    let attempted = false;
    /** True while this call is still the one the UI is waiting for. */
    const isCurrent = () =>
      mountedRef.current &&
      seq === requestSeqRef.current &&
      paperIdAtRequest === paperIdRef.current &&
      fingerprintAtRequest === fingerprintRef.current;

    try {
      attempted = true;
      const result = await suggestPaperOrganization({
        paperId: paperIdAtRequest,
        draft: {
          title: draft.title,
          abstract: draft.abstract,
          keywords: draft.keywords,
          studyType: draft.studyType,
        },
        currentProjectIds: selectedProjectIds,
        currentTagIds: selectedTagIds,
      });

      // A result generated for a closed dialog, a different paper or an older
      // draft is discarded, not rendered. The unit it spent server-side is
      // real and is NOT refunded here — fabricating a refund would be a lie
      // about server state.
      if (!isCurrent()) return;

      setSuggestions(result);
      setResultFingerprint(fingerprintAtRequest);
      setDismissed(new Set());
      setNotice(
        isEmptySuggestions(result)
          ? "No strong Project or Tag suggestions for this paper."
          : "Suggestions ready. Nothing is assigned until you save.",
      );
    } catch (err: unknown) {
      if (!isCurrent()) return;

      if (err instanceof SuggestOrganizationError) {
        if (err.kind === "quota_exceeded" && err.quota) {
          // The authoritative Paperlume allowance wall.
          toastQuotaExhausted(err.quota);
          setError(formatQuotaExceededMessage(err.quota));
        } else {
          // Everything else — including a provider failure — is shown as
          // itself. A provider 429/503 arrives here as `provider_failure` with
          // the server's neutral sentence, and is never dressed up as the user
          // exhausting their plan.
          setError(err.message);
        }
      } else {
        setError("AI suggestions could not be generated. Please try again.");
      }
    } finally {
      // The unit may have been consumed (success) or consumed-then-refunded
      // (provider failure), and a 402 is itself news about the counter. Refresh
      // whenever the server was actually called — even for a response this
      // component discarded as stale.
      if (attempted) onQuotaRefresh?.();
      // Only the newest request owns the loading flag; an older one must not
      // clear the spinner a newer one is showing.
      if (mountedRef.current && seq === requestSeqRef.current) setLoading(false);
    }
  }, [
    loading,
    disabled,
    eligible,
    knownZeroQuota,
    quotaStatus,
    toastQuotaExhausted,
    paperId,
    fingerprint,
    draft,
    selectedProjectIds,
    selectedTagIds,
    onQuotaRefresh,
  ]);

  const dismiss = useCallback((key: string) => {
    // Local only. A rejected suggestion is never persisted, and no signal about
    // it is sent anywhere.
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const acceptExistingProject = useCallback(
    (suggestion: ExistingProjectSuggestion) => {
      // Local selection only. No `set_paper_projects`, no paper row update.
      onSelectProject(suggestion.id);
      setNotice(`Selected project "${suggestion.name}" for this paper. Save to apply.`);
    },
    [onSelectProject],
  );

  const acceptExistingTag = useCallback(
    (suggestion: ExistingTagSuggestion) => {
      onSelectTag(suggestion.id);
      setNotice(`Selected tag "${suggestion.name}" for this paper. Save to apply.`);
    },
    [onSelectTag],
  );

  const handleCreateProject = useCallback(
    async (suggestion: NewProjectSuggestion) => {
      if (!onCreateProject || disabled || stale || creatingKey) return;
      const key = newProjectKey(suggestion.name);
      setCreatingKey(key);
      try {
        // Reconcile against the taxonomy as it is NOW, not as the server saw it.
        const match = matchTaxonomyName(suggestion.name, projects);
        if (match.kind === "ambiguous") {
          setNotice(
            `Several projects are already named "${suggestion.name}". Nothing was created — pick the one you meant in the Projects selector below.`,
          );
          return;
        }
        if (match.kind === "unique") {
          onSelectProject(match.entity.id);
          setNotice(
            `"${match.entity.name}" already exists, so it was selected instead of creating a duplicate. Save to apply.`,
          );
          return;
        }
        const created = await onCreateProject(suggestion.name, suggestion.description);
        // A failed creation selects nothing: an id that was never proven to
        // exist must not enter the dialog's selection. The mutation has already
        // shown its own destructive toast.
        if (!created) return;
        onSelectProject(created.id);
        setNotice(
          `Created project "${created.name}" and selected it for this paper. Save to assign it.`,
        );
      } finally {
        setCreatingKey(null);
      }
    },
    [onCreateProject, disabled, stale, creatingKey, projects, onSelectProject],
  );

  const handleCreateTag = useCallback(
    async (suggestion: NewTagSuggestion) => {
      if (!onCreateTag || disabled || stale || creatingKey) return;
      const key = newTagKey(suggestion.name);
      setCreatingKey(key);
      try {
        const match = matchTaxonomyName(suggestion.name, tags);
        if (match.kind === "ambiguous") {
          setNotice(
            `Several tags are already named "${suggestion.name}". Nothing was created — pick the one you meant in the Tags selector below.`,
          );
          return;
        }
        if (match.kind === "unique") {
          onSelectTag(match.entity.id);
          setNotice(
            `"${match.entity.name}" already exists, so it was selected instead of creating a duplicate. Save to apply.`,
          );
          return;
        }
        const created = await onCreateTag(suggestion.name);
        if (!created) return;
        onSelectTag(created.id);
        setNotice(`Created tag "${created.name}" and selected it for this paper. Save to assign it.`);
      } finally {
        setCreatingKey(null);
      }
    },
    [onCreateTag, disabled, stale, creatingKey, tags, onSelectTag],
  );

  // ── Visible (non-dismissed) result slices ────────────────────────────────
  const visible = useMemo(() => {
    if (!suggestions) {
      return { existingProjects: [], existingTags: [], newProjects: [], newTags: [] };
    }
    return {
      existingProjects: suggestions.existingProjects.filter(
        (s) => !dismissed.has(existingProjectKey(s.id)),
      ),
      existingTags: suggestions.existingTags.filter((s) => !dismissed.has(existingTagKey(s.id))),
      // A proposed-new item is only *shown* when the creation path it needs is
      // wired, so the surface never offers an action it cannot perform.
      newProjects: onCreateProject
        ? suggestions.newProjects.filter((s) => !dismissed.has(newProjectKey(s.name)))
        : [],
      newTags: onCreateTag
        ? suggestions.newTags.filter((s) => !dismissed.has(newTagKey(s.name)))
        : [],
    };
  }, [suggestions, dismissed, onCreateProject, onCreateTag]);

  const hasVisibleResults =
    visible.existingProjects.length > 0 ||
    visible.existingTags.length > 0 ||
    visible.newProjects.length > 0 ||
    visible.newTags.length > 0;

  const generatedEmpty = suggestions !== null && isEmptySuggestions(suggestions);

  /** Actions are inert while saving, while a generation is running, or once stale. */
  const actionsDisabled = disabled || loading || stale;
  const generateDisabled = disabled || loading || !eligible;

  return (
    <section
      data-testid="ai-organization-suggestions"
      aria-labelledby="ai-organization-heading"
      className="space-y-2 rounded-md border border-dashed p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label id="ai-organization-heading" className="flex items-center gap-1.5">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          AI organization
        </Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 coarse:min-h-10"
          disabled={generateDisabled}
          onClick={handleGenerate}
        >
          {loading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Suggesting…
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {suggestions ? "Suggest again" : "Suggest Projects & Tags"}
            </>
          )}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Uses 1 AI request. Suggestions are optional and nothing is assigned until you save.
      </p>

      {!eligible && <p className="text-xs text-muted-foreground">{INELIGIBLE_HINT}</p>}

      {/*
        One polite live region for every outcome — generation, acceptance,
        collision, creation. Text-only and replaced rather than appended, so a
        screen reader hears the newest outcome once instead of a running log.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {notice ?? ""}
      </p>

      {error && (
        <p
          className="flex items-start gap-1.5 text-xs text-destructive"
          data-testid="ai-organization-error"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      {stale && (
        <p className="text-xs text-muted-foreground" data-testid="ai-organization-stale">
          You edited the paper after these suggestions were generated, so they no longer describe
          this draft. Anything you already selected is kept — generate again to accept more.
        </p>
      )}

      {notice && !error && (
        <p className="text-xs text-muted-foreground" aria-hidden="true">
          {notice}
        </p>
      )}

      {generatedEmpty && !stale && (
        <p className="text-xs text-muted-foreground" data-testid="ai-organization-empty">
          No strong Project or Tag suggestions for this paper.
        </p>
      )}

      {suggestions && !generatedEmpty && !hasVisibleResults && (
        <p className="text-xs text-muted-foreground">No suggestions left to review.</p>
      )}

      {visible.existingProjects.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Your Projects</p>
          <ul className="space-y-1.5">
            {visible.existingProjects.map((s) => {
              // Derived against the CURRENT taxonomy, never the generation-time
              // snapshot: a Project deleted since then is not selectable.
              const stillExists = projects.some((p) => p.id === s.id);
              const isSelected = selectedProjectIds.includes(s.id);
              return (
                <SuggestionRow
                  key={s.id}
                  icon={<FolderOpen className="h-3.5 w-3.5" />}
                  name={s.name}
                  reason={s.reason}
                  hint={stillExists ? null : "No longer in your library."}
                  actions={
                    <>
                      {isSelected ? (
                        <Badge variant="secondary" className="gap-1 text-xs">
                          <Check className="h-3 w-3" aria-hidden="true" />
                          Selected
                        </Badge>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 px-2 text-xs coarse:min-h-10"
                          disabled={actionsDisabled || !stillExists}
                          aria-label={`Select project "${s.name}" for this paper`}
                          onClick={() => acceptExistingProject(s)}
                        >
                          Select
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 coarse:min-h-10 coarse:min-w-10"
                        disabled={actionsDisabled}
                        aria-label={`Dismiss project suggestion "${s.name}"`}
                        onClick={() => dismiss(existingProjectKey(s.id))}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </>
                  }
                />
              );
            })}
          </ul>
        </div>
      )}

      {visible.existingTags.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Your Tags</p>
          <ul className="space-y-1.5">
            {visible.existingTags.map((s) => {
              const stillExists = tags.some((t) => t.id === s.id);
              const isSelected = selectedTagIds.includes(s.id);
              return (
                <SuggestionRow
                  key={s.id}
                  icon={<Tags className="h-3.5 w-3.5" />}
                  name={s.name}
                  reason={s.reason}
                  hint={stillExists ? null : "No longer in your library."}
                  actions={
                    <>
                      {isSelected ? (
                        <Badge variant="secondary" className="gap-1 text-xs">
                          <Check className="h-3 w-3" aria-hidden="true" />
                          Selected
                        </Badge>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 px-2 text-xs coarse:min-h-10"
                          disabled={actionsDisabled || !stillExists}
                          aria-label={`Select tag "${s.name}" for this paper`}
                          onClick={() => acceptExistingTag(s)}
                        >
                          Select
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 coarse:min-h-10 coarse:min-w-10"
                        disabled={actionsDisabled}
                        aria-label={`Dismiss tag suggestion "${s.name}"`}
                        onClick={() => dismiss(existingTagKey(s.id))}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </>
                  }
                />
              );
            })}
          </ul>
        </div>
      )}

      {(visible.newProjects.length > 0 || visible.newTags.length > 0) && (
        <p className="text-xs text-muted-foreground">
          Creating adds it to your library now; this paper is assigned only when you save.
        </p>
      )}

      {visible.newProjects.length > 0 && onCreateProject && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">New Projects</p>
          <ul className="space-y-1.5">
            {visible.newProjects.map((s) => {
              const key = newProjectKey(s.name);
              const match = matchTaxonomyName(s.name, projects);
              const alreadySelected =
                match.kind === "unique" && selectedProjectIds.includes(match.entity.id);
              const busy = creatingKey === key;
              return (
                <SuggestionRow
                  key={key}
                  icon={<Plus className="h-3.5 w-3.5" />}
                  name={s.name}
                  detail={s.description}
                  reason={s.reason}
                  hint={
                    match.kind === "unique" && !alreadySelected
                      ? "Already in your library — it will be selected, not duplicated."
                      : match.kind === "ambiguous"
                        ? "Several projects already share this name."
                        : null
                  }
                  actions={
                    <>
                      {alreadySelected ? (
                        <Badge variant="secondary" className="gap-1 text-xs">
                          <Check className="h-3 w-3" aria-hidden="true" />
                          Selected
                        </Badge>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 px-2 text-xs coarse:min-h-10"
                          disabled={actionsDisabled || !!creatingKey}
                          aria-label={
                            match.kind === "unique"
                              ? `Select existing project "${match.entity.name}" for this paper`
                              : `Create project "${s.name}" and select it for this paper`
                          }
                          onClick={() => handleCreateProject(s)}
                        >
                          {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                          {match.kind === "unique" ? "Select existing" : "Create & select"}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 coarse:min-h-10 coarse:min-w-10"
                        disabled={actionsDisabled || busy}
                        aria-label={`Dismiss new project suggestion "${s.name}"`}
                        onClick={() => dismiss(key)}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </>
                  }
                />
              );
            })}
          </ul>
        </div>
      )}

      {visible.newTags.length > 0 && onCreateTag && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">New Tags</p>
          <ul className="space-y-1.5">
            {visible.newTags.map((s) => {
              const key = newTagKey(s.name);
              const match = matchTaxonomyName(s.name, tags);
              const alreadySelected =
                match.kind === "unique" && selectedTagIds.includes(match.entity.id);
              const busy = creatingKey === key;
              return (
                <SuggestionRow
                  key={key}
                  icon={<Plus className="h-3.5 w-3.5" />}
                  name={s.name}
                  reason={s.reason}
                  hint={
                    match.kind === "unique" && !alreadySelected
                      ? "Already in your library — it will be selected, not duplicated."
                      : match.kind === "ambiguous"
                        ? "Several tags already share this name."
                        : null
                  }
                  actions={
                    <>
                      {alreadySelected ? (
                        <Badge variant="secondary" className="gap-1 text-xs">
                          <Check className="h-3 w-3" aria-hidden="true" />
                          Selected
                        </Badge>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className={cn("h-8 gap-1 px-2 text-xs coarse:min-h-10")}
                          disabled={actionsDisabled || !!creatingKey}
                          aria-label={
                            match.kind === "unique"
                              ? `Select existing tag "${match.entity.name}" for this paper`
                              : `Create tag "${s.name}" and select it for this paper`
                          }
                          onClick={() => handleCreateTag(s)}
                        >
                          {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                          {match.kind === "unique" ? "Select existing" : "Create & select"}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 coarse:min-h-10 coarse:min-w-10"
                        disabled={actionsDisabled || busy}
                        aria-label={`Dismiss new tag suggestion "${s.name}"`}
                        onClick={() => dismiss(key)}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </>
                  }
                />
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
