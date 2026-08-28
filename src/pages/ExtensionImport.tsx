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
 * This page calls `bulkImportPapers` with exactly one identifier and reads its
 * existing progress result. It never touches `fetch-paper-metadata`,
 * `safe_bulk_insert_papers`, `bulk_set_paper_projects` or
 * `bulk_set_paper_tags` — those are the importer's implementation details, and
 * duplicating any of them would fork metadata precedence, normalization,
 * provenance, deduplication and assignment away from the Dashboard.
 *
 * The importer must therefore receive this user's real `NormalizationConfig`.
 * It treats a missing one as "skip normalization" rather than as an error, so an
 * import that ran before the pools loaded would quietly store an unnormalized
 * row: entities undecoded, keywords un-enriched, no Winner-Takes-All study type.
 * The confirm button stays disabled until the pools and taxonomy have loaded —
 * `normalizationPoolsLoading` exists so this page can tell "empty" from "not
 * loaded yet", which the arrays themselves cannot express.
 *
 * ## Duplicates are reported, not resolved
 *
 * `safe_bulk_insert_papers` answers a unique-index collision with
 * `{ status: "duplicate" }` and **no paper id**, so the importer records it as
 * skipped and its Phase 5 assignment runs only over newly inserted ids. This
 * page says exactly that: already in your library, and — when the user had
 * selected any — that those selections were not applied to the existing paper.
 * It does not guess which row collided, and nothing here matches on title.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
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
import type { ServerFilterParams, ServerSortParams } from "@/hooks/papers/types";
import {
  buildExtensionImportPath,
  parseExtensionImportIntent,
  type ExtensionImportIntent,
} from "@/lib/extensionImportHandoff";
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

/** The final `onProgress` snapshot, copied out of the importer's live arrays. */
interface ImportOutcome {
  added: string[];
  skipped: string[];
  failed: string[];
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
  const { normalizationPoolsLoading } = usePools();
  const normalizationConfig = useNormalizationConfig();

  const { projects, tags, projectsLoading, tagsLoading, bulkImportPapers } =
    usePapers(
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
  const [assignmentAtImport, setAssignmentAtImport] = useState({
    projects: 0,
    tags: 0,
  });

  const contextLoading =
    normalizationPoolsLoading || projectsLoading || tagsLoading;

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
    // Never import against a configuration that has not arrived: the importer
    // would silently skip normalization rather than refuse.
    if (importInFlight.current || contextLoading) return;

    importInFlight.current = true;
    setPhase("importing");
    setAssignmentAtImport({
      projects: selectedProjectIds.length,
      tags: selectedTagIds.length,
    });

    // The importer reports through `onProgress` and returns void. Its arrays are
    // live and keep being mutated, so each snapshot is copied; the last one to
    // arrive before it resolves is the terminal result. One identifier means the
    // three buckets are mutually exclusive and need no second lookup.
    let outcome: ImportOutcome | null = null;

    try {
      await bulkImportPapers(
        [intent.identifier],
        (_current, _total, addedIds, skippedIds, failedIds) => {
          outcome = {
            added: [...addedIds],
            skipped: [...skippedIds],
            failed: [...failedIds],
          };
        },
        {
          targetProjectIds: selectedProjectIds,
          targetTagIds: selectedTagIds,
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

    const result = outcome as ImportOutcome | null;
    if (result === null) {
      // The importer returned without reporting — it short-circuits before its
      // first callback only when it has no user or no identifiers, neither of
      // which should be reachable here. Treated as a failure rather than
      // assumed successful.
      setPhase("failed");
    } else if (result.added.length > 0) {
      setPhase("imported");
    } else if (result.skipped.length > 0) {
      setPhase("duplicate");
    } else {
      setPhase("failed");
    }

    importInFlight.current = false;
  }, [
    bulkImportPapers,
    contextLoading,
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
            {contextLoading ? (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Loading your projects, tags and keyword settings…
              </p>
            ) : (
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
            {(assignmentAtImport.projects > 0 || assignmentAtImport.tags > 0) && (
              <p className="text-muted-foreground">
                Assigned to {describeAssignment(assignmentAtImport)}.
              </p>
            )}
          </div>
        )}

        {phase === "duplicate" && (
          <div
            role="status"
            aria-live="polite"
            className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm"
          >
            <p className="flex items-center gap-2 font-medium">
              <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
              This paper is already in your library
            </p>
            <p className="text-muted-foreground">Nothing was imported.</p>
            {(assignmentAtImport.projects > 0 || assignmentAtImport.tags > 0) && (
              <p className="text-muted-foreground">
                Your {describeAssignment(assignmentAtImport)} selection was{" "}
                <strong className="font-medium text-foreground">not applied</strong>{" "}
                to the paper already in your library. Open it in your library to
                change its projects or tags.
              </p>
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
          {!isTerminal && (
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

          {phase === "failed" && (
            <Button
              onClick={runImport}
              disabled={contextLoading}
              className="flex-1"
              data-testid="handoff-retry"
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

        {!isTerminal && !contextLoading && (
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
function describeAssignment({
  projects,
  tags,
}: {
  projects: number;
  tags: number;
}): string {
  const parts: string[] = [];
  if (projects > 0) parts.push(`${projects} project${projects === 1 ? "" : "s"}`);
  if (tags > 0) parts.push(`${tags} tag${tags === 1 ? "" : "s"}`);
  return parts.join(" and ");
}
