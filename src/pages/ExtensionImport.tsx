/**
 * `/extension-import` — the authenticated PaperLume import handoff.
 *
 * Receives one already-detected PMID or DOI, shows the user what it is, lets
 * them optionally pick existing Projects and Tags, and — only after an explicit
 * click — sends that single identifier through the application's canonical
 * importer.
 *
 * ## Opening this page never writes anything
 *
 * Navigation is intent, not instruction. A GET can arrive from a link, a
 * bookmark, browser history, a prefetch or someone else's email, so an import
 * that ran on mount would be a mutation any web page could trigger on a
 * signed-in user. The importer is reachable only from the confirm button, and a
 * reload returns to the ready state rather than replaying anything — no
 * mutation state is kept in the URL.
 *
 * ## There is no second importer here
 *
 * This page calls `bulkImportPapers` with exactly one identifier and reads the
 * result it returns. It never touches `fetch-paper-metadata`,
 * `safe_bulk_insert_papers`, `bulk_set_paper_projects`, `bulk_set_paper_tags`,
 * `bulk_add_paper_projects` or `bulk_add_paper_tags` — those are the importer's
 * implementation details, and duplicating any of them would fork metadata
 * precedence, normalization, provenance, deduplication and assignment away from
 * the Dashboard. Duplicate resolution is part of that rule, not an exception to
 * it: the page never looks a colliding paper up for itself.
 *
 * The importer must therefore receive this user's real `NormalizationConfig`.
 * It treats a missing one as "skip normalization" rather than as an error, so an
 * import that ran without the pools would quietly store an unnormalized row:
 * entities undecoded, keywords un-enriched, no Winner-Takes-All study type.
 *
 * ## Import context fails closed, and `!loading` is not readiness
 *
 * Every pool and taxonomy query defaults its data to `[]`, so a read that has
 * exhausted React Query's retries settles at exactly the shape of a successful
 * read of an empty pool. Treating "not loading" as "ready" therefore turns a
 * failed read into an apparently valid configuration and lets the import run
 * against it. `PoolsContext` reports `normalizationPoolsStatus` — `loading`,
 * `ready` or `error` — and only `ready` permits an import here; `error` renders
 * a recoverable failure with no usable confirm control at all. The same applies
 * to Projects and Tags, which this route offers as import context.
 *
 * ## What this page can and cannot claim about assignment
 *
 * The importer assigns Projects and Tags in its Phase 5, *after* the Phase 4
 * progress callback, and a Phase 5 RPC failure is deliberately non-fatal: it
 * becomes a warning toast and leaves the identifier in `addedIds`. So a
 * progress snapshot proves the paper was inserted and proves nothing whatsoever
 * about assignment.
 *
 * This page therefore reads `bulkImportPapers`' **terminal result**, which the
 * importer returns after Phase 5 has finished and which reports, per category,
 * whether assignment was applied, failed, or was never requested. That is the
 * only evidence this page is allowed to speak from — it must never re-resolve
 * the paper or query the junction tables itself, because that would fork the
 * importer's ownership of the decision it just made.
 *
 * The new-paper copy still states only the insertion. Its Phase 5 uses the
 * replace-all setters, its failure is already surfaced by the importer's own
 * warning toast, and the previously reviewed wording is deliberately left
 * alone.
 *
 * ## Duplicates are resolved only when identity is provable
 *
 * `safe_bulk_insert_papers` answers a unique-index collision with
 * `status: "duplicate"`, and — since CHROME-EXTENSION-IMPORT-001D — with the
 * existing paper's `id` when, and only when, exactly ONE row owned by this user
 * matches the attempted PMID or DOI under the same semantics the per-user
 * unique indexes enforce. Two identifiers naming two different rows, or no
 * provable row at all, return no id.
 *
 * This page opts into acting on that id (`applyAssignmentsToResolvedDuplicates`)
 * because its user just chose taxonomy for this specific paper. When the id is
 * present the selection is **added** to the existing paper through the additive
 * RPCs, so everything it was already filed under is kept; when it is absent —
 * including against a database that predates that migration — nothing is
 * written and the page says the selection was not applied. It never guesses
 * which row collided, never asks the user to choose between candidates, and
 * nothing here matches on title.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Info,
  Loader2,
  XCircle,
} from "lucide-react";

import { AssignOnImportSection } from "@/components/papers/AssignOnImportSection";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PoolsProvider, usePools } from "@/contexts/PoolsContext";
import { useAuth } from "@/hooks/useAuth";
import { useNormalizationConfig } from "@/hooks/useNormalizationConfig";
import { usePapers } from "@/hooks/usePapers";
import type {
  BulkImportAssignmentReport,
  BulkImportOutcome,
  ServerFilterParams,
  ServerSortParams,
} from "@/hooks/papers/types";
import {
  buildExtensionImportPath,
  parseExtensionImportIntent,
  type ExtensionImportIntent,
} from "@/lib/extensionImportHandoff";
import { queryKeys } from "@/lib/queryKeys";
import { buildAuthPathWithReturnTo } from "@/lib/safeReturnTo";

/**
 * Unfiltered, unsorted parameters for the `usePapers` instance this page mounts.
 *
 * Module constants so their identity is stable across renders — these feed
 * React Query keys, and a fresh object every render would rebuild them.
 *
 * The page reuses `usePapers` because that is where `bulkImportPapers` is
 * composed with the user's Projects, Tags and cache behaviour. Reaching it costs
 * one unfiltered list read this page does not display; extracting the importer
 * to avoid that read would mean maintaining a second assembly of the canonical
 * path, which is a far worse trade than a query.
 */
const NEUTRAL_FILTER_PARAMS: ServerFilterParams = {
  filterPaperIds: null,
  yearFrom: null,
  yearTo: null,
  studyTypes: null,
  notesPresence: "all",
};

const NEUTRAL_SORT_PARAMS: ServerSortParams = {
  sortColumn: null,
  sortAscending: null,
};

/** What the confirm button has produced so far. */
type ImportPhase = "ready" | "importing" | "imported" | "duplicate" | "failed";

/** Nothing requested and nothing claimed — the state before any import has run. */
const NO_ASSIGNMENT: BulkImportAssignmentReport = {
  projects: "not-requested",
  tags: "not-requested",
};

/**
 * How many of each the user had selected when they pressed Import.
 *
 * Selections describe the import that has not happened yet, so a completed run
 * leaves the live selection alone and reads these instead.
 */
interface AssignmentCounts {
  projects: number;
  tags: number;
}

/** A centred single-purpose frame, shared by every state this route renders. */
function HandoffFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  );
}

/** The full-page spinner used while auth resolves. */
function HandoffSpinner({ label }: { label: string }) {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * Route shell: validate the link, then require a session.
 *
 * Validation runs first deliberately. A broken link is broken whether or not
 * anyone is signed in, and making someone authenticate only to be told the link
 * was invalid is a pointless round trip. This state renders no user data.
 */
export default function ExtensionImport() {
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const intent = useMemo(
    () => parseExtensionImportIntent(location.search),
    [location.search],
  );

  // Preserve the import intent across sign-in. The return target is rebuilt from
  // the validated intent, never echoed from the URL — see `safeReturnTo.ts`.
  useEffect(() => {
    if (authLoading || user || !intent) return;
    navigate(buildAuthPathWithReturnTo(buildExtensionImportPath(intent)), {
      replace: true,
    });
  }, [authLoading, user, intent, navigate]);

  if (!intent) return <InvalidHandoff />;
  if (authLoading) return <HandoffSpinner label="Checking your session" />;
  if (!user) return <HandoffSpinner label="Redirecting to sign in" />;

  return (
    <PoolsProvider userId={user.id}>
      <ExtensionImportContent intent={intent} userId={user.id} />
    </PoolsProvider>
  );
}

/** The link did not carry a handoff this application recognises. */
function InvalidHandoff() {
  return (
    <HandoffFrame>
      <CardHeader>
        <div className="flex items-center gap-2 text-destructive">
          <XCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
          <CardTitle className="text-lg">Import link not recognised</CardTitle>
        </div>
        <CardDescription>
          This PaperLume import link is invalid or unsupported. Nothing has been
          imported.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild className="w-full">
          <Link to="/dashboard">Go to my library</Link>
        </Button>
      </CardContent>
    </HandoffFrame>
  );
}

/** The identifier, presented as the record it names. */
function IntentSummary({ intent }: { intent: ExtensionImportIntent }) {
  const isPmid = intent.kind === "pmid";
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 rounded-md border bg-muted/40 p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Source
      </dt>
      <dd className="text-sm">{isPmid ? "PubMed" : "DOI"}</dd>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {isPmid ? "PMID" : "DOI"}
      </dt>
      <dd
        className="break-words font-mono text-sm"
        data-testid="handoff-identifier"
      >
        {intent.identifier}
      </dd>
    </dl>
  );
}

function ExtensionImportContent({
  intent,
  userId,
}: {
  intent: ExtensionImportIntent;
  userId: string;
}) {
  const queryClient = useQueryClient();
  const { normalizationPoolsStatus, retryNormalizationPools } = usePools();
  const normalizationConfig = useNormalizationConfig();

  const {
    projects,
    tags,
    projectsLoading,
    tagsLoading,
    projectsError,
    tagsError,
    bulkImportPapers,
  } = usePapers(
    userId,
    NEUTRAL_FILTER_PARAMS,
    NEUTRAL_SORT_PARAMS,
    normalizationConfig,
  );

  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [phase, setPhase] = useState<ImportPhase>("ready");

  /**
   * The in-flight latch.
   *
   * A ref rather than the `phase` state because a second click can land in the
   * same tick as the first, before React has re-rendered with the disabled
   * button. The disabled attribute is the visible half of this; the ref is the
   * half that is actually load-bearing.
   */
  const importInFlight = useRef(false);

  // Selections describe the import that has not happened yet, so a completed
  // run leaves them behind rather than letting them imply something about it.
  const assignmentRequested =
    selectedProjectIds.length > 0 || selectedTagIds.length > 0;
  const [assignmentAtImport, setAssignmentAtImport] = useState<AssignmentCounts>({
    projects: 0,
    tags: 0,
  });

  /**
   * Whether the duplicate this run hit could be resolved to exactly one owned
   * paper. False covers both "no provable row" and "two identifiers, two rows",
   * which the user experiences identically: the selection was not applied.
   * Also false against any database that predates the resolving RPC, which is
   * what makes this page safe to deploy before that migration runs.
   */
  const [duplicateResolved, setDuplicateResolved] = useState(false);

  /**
   * The importer's post-assignment evidence for whichever group this paper
   * ended up in. The ONLY thing the terminal copy may speak from — never the
   * selection, which says what was asked for, not what happened.
   */
  const [assignmentResult, setAssignmentResult] =
    useState<BulkImportAssignmentReport>(NO_ASSIGNMENT);

  /**
   * The import context: this user's normalization pools and their taxonomy.
   *
   * Three states, not two. `contextReady` is a positive fact about every one of
   * those reads, never `!contextLoading` — each query defaults to `[]`, so a
   * failed read is byte-identical to a successful read of nothing, and only
   * `contextFailed` separates them. An import is permitted on `contextReady`
   * alone.
   */
  const contextLoading =
    normalizationPoolsStatus === "loading" || projectsLoading || tagsLoading;
  const contextFailed =
    !contextLoading &&
    (normalizationPoolsStatus === "error" || projectsError || tagsError);
  const contextReady = !contextLoading && !contextFailed;

  /**
   * Retry the context reads that failed.
   *
   * Bounded to exactly the queries this page depends on, and it mutates
   * nothing — a failed read is recovered by reading again, not by importing
   * anyway.
   */
  const retryContext = useCallback(() => {
    retryNormalizationPools();
    void queryClient.refetchQueries({ queryKey: queryKeys.projects.all(userId) });
    void queryClient.refetchQueries({ queryKey: queryKeys.tags.all(userId) });
  }, [queryClient, retryNormalizationPools, userId]);

  const toggleProject = useCallback((id: string) => {
    setSelectedProjectIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }, []);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  }, []);

  const runImport = useCallback(async () => {
    // Never import against a configuration that has not arrived — or that
    // failed to arrive and left an empty array behind: the importer would
    // silently skip normalization rather than refuse.
    if (importInFlight.current || !contextReady) return;

    importInFlight.current = true;
    setPhase("importing");
    setAssignmentAtImport({
      projects: selectedProjectIds.length,
      tags: selectedTagIds.length,
    });
    setDuplicateResolved(false);
    setAssignmentResult(NO_ASSIGNMENT);

    // The importer's TERMINAL result, returned after its assignment phase has
    // finished. The progress callback is deliberately not used here: it is
    // emitted before any assignment RPC runs, so it could only ever prove the
    // insertion. One identifier in means exactly one item out.
    let outcome: BulkImportOutcome | undefined;

    try {
      outcome = await bulkImportPapers(
        [intent.identifier],
        undefined,
        {
          targetProjectIds: selectedProjectIds,
          targetTagIds: selectedTagIds,
          // The one caller that opts in. This user picked taxonomy for this
          // exact paper moments ago, which is the whole justification — and it
          // is still only acted on when the database proved which row it is.
          applyAssignmentsToResolvedDuplicates: true,
        },
      );
    } catch {
      // The importer surfaces its own message; this page only needs the state.
      // The thrown value is deliberately not rendered — it can carry provider
      // or database text that means nothing to the person reading it.
      setPhase("failed");
      importInFlight.current = false;
      return;
    }

    const item = outcome?.items[0];
    if (!item) {
      // The importer returned nothing — it short-circuits before doing any work
      // only when it has no user or no identifiers, neither of which should be
      // reachable here. Treated as a failure rather than assumed successful.
      setPhase("failed");
    } else if (item.status === "inserted") {
      // `outcome.inserted` carries this run's assignment evidence, and the
      // new-paper copy below deliberately does not speak from it: that wording
      // was reviewed to state only the insertion, the importer already surfaces
      // an assignment failure in its own warning toast, and widening the claim
      // is not what this task changes. The evidence is still asserted on in the
      // importer's unit coverage.
      setPhase("imported");
    } else if (item.status === "duplicate-resolved") {
      setDuplicateResolved(true);
      setAssignmentResult(outcome!.resolvedDuplicates);
      setPhase("duplicate");
    } else if (item.status === "duplicate-unresolved") {
      // Already in the library, but not identifiable as one exact row — so
      // nothing was written, and the copy below says so rather than implying
      // the selection landed somewhere.
      setDuplicateResolved(false);
      setAssignmentResult(NO_ASSIGNMENT);
      setPhase("duplicate");
    } else {
      setPhase("failed");
    }

    importInFlight.current = false;
  }, [
    bulkImportPapers,
    contextReady,
    intent.identifier,
    selectedProjectIds,
    selectedTagIds,
  ]);

  const isTerminal =
    phase === "imported" || phase === "duplicate" || phase === "failed";

  return (
    <HandoffFrame>
      <CardHeader className="space-y-1">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <CardTitle className="text-lg">Paper detected</CardTitle>
        </div>
        <CardDescription>
          Review this paper before adding it to your PaperLume library.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <IntentSummary intent={intent} />

        {/* ── Pre-import: taxonomy selection ─────────────────────────────── */}
        {phase !== "imported" && phase !== "duplicate" && (
          <>
            {contextLoading && (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Loading your projects, tags and keyword settings…
              </p>
            )}

            {contextFailed && (
              <div
                role="alert"
                className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
                data-testid="handoff-context-error"
              >
                <p className="flex items-center gap-2 font-medium text-destructive">
                  <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  We couldn&apos;t load your import settings
                </p>
                <p className="text-muted-foreground">
                  Nothing has been imported. PaperLume needs your projects, tags
                  and keyword settings to file this paper correctly, so importing
                  stays unavailable until they load.
                </p>
              </div>
            )}

            {contextReady && (
              <AssignOnImportSection
                projects={projects}
                tags={tags}
                selectedProjectIds={selectedProjectIds}
                selectedTagIds={selectedTagIds}
                onToggleProject={toggleProject}
                onToggleTag={toggleTag}
                context="current-import"
              />
            )}
          </>
        )}

        {/* ── Terminal states ────────────────────────────────────────────── */}
        {phase === "imported" && (
          <div
            role="status"
            aria-live="polite"
            className="space-y-1 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm"
          >
            <p className="flex items-center gap-2 font-medium text-primary">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              Added to your library
            </p>
            {/* Deliberately NOT "Assigned to …", and deliberately unchanged by
                CHROME-EXTENSION-IMPORT-001D. The terminal result does now carry
                this run's inserted-group assignment evidence, but the reviewed
                wording here states only the insertion — which is authoritative —
                and the importer already reports an assignment failure in its own
                warning toast. Widening the claim on the new-paper path is not
                what that task changed. */}
            {(assignmentAtImport.projects > 0 || assignmentAtImport.tags > 0) && (
              <p className="text-muted-foreground">
                Your {describeAssignment(assignmentAtImport)} selection was sent
                with the import. Open the paper in your library to confirm it.
              </p>
            )}
          </div>
        )}

        {phase === "duplicate" && (
          <div
            role="status"
            aria-live="polite"
            className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm"
            data-testid="handoff-duplicate"
          >
            <p className="flex items-center gap-2 font-medium">
              <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
              This paper is already in your library
            </p>
            <p className="text-muted-foreground">No new paper was added.</p>
            {(assignmentAtImport.projects > 0 || assignmentAtImport.tags > 0) && (
              <DuplicateAssignmentSummary
                counts={assignmentAtImport}
                resolved={duplicateResolved}
                result={assignmentResult}
              />
            )}
          </div>
        )}

        {phase === "failed" && (
          <div
            role="alert"
            className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <p className="flex items-center gap-2 font-medium text-destructive">
              <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              This paper could not be imported
            </p>
            <p className="text-muted-foreground">
              Nothing was added to your library. You can try again, or add the
              paper from your library instead.
            </p>
          </div>
        )}

        {/* ── Actions ────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-2">
          {/* No confirm control exists at all while the context is unusable —
              there is nothing to press, rather than something pressed that
              quietly does nothing. */}
          {!isTerminal && !contextFailed && (
            <Button
              onClick={runImport}
              disabled={phase === "importing" || contextLoading}
              className="flex-1"
              data-testid="handoff-import"
            >
              {phase === "importing" && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {phase === "importing" ? "Importing…" : "Import to PaperLume"}
            </Button>
          )}

          {phase === "failed" && !contextFailed && (
            <Button
              onClick={runImport}
              disabled={!contextReady}
              className="flex-1"
              data-testid="handoff-retry"
            >
              Try again
            </Button>
          )}

          {contextFailed && !isTerminal && (
            <Button
              onClick={retryContext}
              className="flex-1"
              data-testid="handoff-context-retry"
            >
              Try again
            </Button>
          )}

          <Button
            asChild
            variant={isTerminal ? "default" : "outline"}
            className={isTerminal ? "flex-1" : undefined}
          >
            <Link to="/dashboard">
              Go to my library
              {isTerminal && (
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              )}
            </Link>
          </Button>
        </div>

        {!isTerminal && contextReady && (
          <p className="text-xs text-muted-foreground">
            {assignmentRequested
              ? "Nothing is added until you choose Import."
              : "Nothing is added until you choose Import. You can also add it without any project or tag."}
          </p>
        )}
      </CardContent>
    </HandoffFrame>
  );
}

/** "2 projects and 1 tag", for the assignment sentence in both terminal states. */
function describeAssignment({ projects, tags }: AssignmentCounts): string {
  const parts: string[] = [];
  if (projects > 0) parts.push(`${projects} project${projects === 1 ? "" : "s"}`);
  if (tags > 0) parts.push(`${tags} tag${tags === 1 ? "" : "s"}`);
  return parts.join(" and ");
}

/**
 * Narrow `counts` to the categories whose assignment reached `outcome`.
 *
 * The two categories are separate RPCs that succeed and fail independently, so
 * "your 1 project and 1 tag" is only ever true of a group that shared the same
 * fate. Everything the copy below says is assembled from these two subsets,
 * which is what keeps a half-failed run from being described as a whole one.
 */
function categoriesWith(
  counts: AssignmentCounts,
  result: BulkImportAssignmentReport,
  outcome: BulkImportAssignmentReport["projects"],
): AssignmentCounts {
  return {
    projects: result.projects === outcome ? counts.projects : 0,
    tags: result.tags === outcome ? counts.tags : 0,
  };
}

/** True when the subset holds exactly one selected thing, for "it" vs "them". */
function isSingular({ projects, tags }: AssignmentCounts): boolean {
  return projects + tags === 1;
}

/**
 * What actually happened to the selection on a paper that already existed.
 *
 * Rendered only when the user selected something. Every branch is driven by the
 * importer's terminal evidence, never by the selection alone — the selection
 * says what was asked for, and this sentence may only say what was done.
 */
function DuplicateAssignmentSummary({
  counts,
  resolved,
  result,
}: {
  counts: AssignmentCounts;
  resolved: boolean;
  result: BulkImportAssignmentReport;
}) {
  // Not identifiable as one exact existing paper — either nothing matched, or
  // the PMID and the DOI named two different rows. Both are the same fact to
  // the person reading this: PaperLume refused to guess, so it wrote nothing.
  // The candidate rows are deliberately not described or offered as a choice.
  if (!resolved) {
    return (
      <p className="text-muted-foreground" data-testid="handoff-duplicate-assignment">
        Your {describeAssignment(counts)} selection was{" "}
        <strong className="font-medium text-foreground">not applied</strong>:
        PaperLume could not identify exactly one existing paper for this
        identifier, and it will not guess. Open the paper in your library to
        change its projects or tags.
      </p>
    );
  }

  const applied = categoriesWith(counts, result, "applied");
  const failed = categoriesWith(counts, result, "failed");
  const anyApplied = applied.projects + applied.tags > 0;
  const anyFailed = failed.projects + failed.tags > 0;

  return (
    <p className="text-muted-foreground" data-testid="handoff-duplicate-assignment">
      {anyApplied && (
        <>
          Your {describeAssignment(applied)} selection has been{" "}
          <strong className="font-medium text-foreground">applied</strong> to the
          paper already in your library, and everything it was already filed
          under was kept.{" "}
        </>
      )}
      {anyFailed && (
        <>
          Your {describeAssignment(failed)} selection could{" "}
          <strong className="font-medium text-foreground">not be applied</strong>{" "}
          — you can add {isSingular(failed) ? "it" : "them"} from your library.
          {!anyApplied && " Nothing about that paper was changed."}
        </>
      )}
    </p>
  );
}
