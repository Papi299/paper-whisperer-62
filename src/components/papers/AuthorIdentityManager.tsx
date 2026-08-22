import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRight, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTouchSafeInitialFocus } from "@/hooks/useCoarsePointer";
import { cn } from "@/lib/utils";
import type { useAuthorIdentities } from "@/hooks/useAuthorIdentities";
import {
  authorIdentityClustersConflict,
  authorIdentityOrcidConflict,
  buildAuthorIdentityResolution,
  findAuthorIdentityDuplicates,
  generateAuthorIdentityCandidates,
  mentionSlotKey,
  searchAuthorIdentityClusters,
  type AuthorIdentityCluster,
  type AuthorIdentityMergedMember,
  type AuthorIdentityPaper,
  type AuthorIdentityResolution,
  type AuthorMentionRef,
} from "@/lib/authorIdentity";

/**
 * The author identity management surface (AUTHOR-IDENTITY-RESOLUTION-001C).
 *
 * Every decision in this dialog is explicit and reversible, and the wording is
 * chosen to keep that true. Deterministic evidence produces a SUGGESTION with a
 * factual reason — "Same ORCID", "Same normalized name" — and never a claim that
 * Paperlume verified anything. There is no "verified" badge, no confidence
 * score, and no action that resolves an author without the user pressing a
 * button for that specific mention.
 *
 * Three sections, matching the three questions a user actually has:
 *
 *   Unresolved — which author mentions have I not decided about, and what does
 *                the evidence suggest?
 *   People     — who have I said exists, what are they called, and what is
 *                attached to them?
 *   Duplicates — have I accidentally created the same person twice?
 *
 * When the 001C schema is not installed in this environment the dialog reports
 * that plainly and offers nothing. It is the only part of Paperlume that stops
 * working in that case, which is the point of keeping it a separate surface.
 */

type IdentitiesApi = ReturnType<typeof useAuthorIdentities>;

interface AuthorIdentityManagerProps {
  papers: readonly AuthorIdentityPaper[];
  identities: IdentitiesApi;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Factual, non-committal phrasing for why something is being suggested. */
const REASON_TEXT = {
  same_orcid: "Same ORCID",
  same_normalized_name: "Same normalized name",
} as const;

/**
 * How many people the manual chooser renders at once.
 *
 * Same reasoning as the unresolved list: a long library produces a long list of
 * people, and every entry carries its own context line and button. The search
 * box reaches the rest, and the count of what is hidden is stated rather than
 * silently dropped.
 */
const PICKER_RENDER_LIMIT = 25;

/**
 * The evidence that tells two people apart when their names do not.
 *
 * Preferred names are deliberately not unique — two researchers really can both
 * be `John Smith`, and 001C refuses to invent a distinguishing suffix for them.
 * So anywhere the user must choose between people, the choice is annotated with
 * things that are actually theirs: the ORCIDs their linked papers state, the
 * other names the user recorded, the source spellings they linked, how much is
 * attached, and a paper they can recognise.
 *
 * Every item is the user's own data or a source's own statement. Nothing is
 * derived, and the identity's UUID is never among it — a user cannot recognise a
 * UUID, so showing one would be answering the question with a different question.
 */
function identityContextParts(cluster: AuthorIdentityCluster): string[] {
  const parts: string[] = [];
  if (cluster.orcids.length > 0) parts.push(`ORCID ${cluster.orcids.join(", ")}`);
  if (cluster.aliases.length > 0) {
    parts.push(`also known as ${cluster.aliases.map((entry) => entry.alias).join(", ")}`);
  }
  const otherSpellings = cluster.linkedSpellings.filter(
    (spelling) => spelling !== cluster.preferredName,
  );
  if (otherSpellings.length > 0) parts.push(`linked as ${otherSpellings.join(", ")}`);
  parts.push(
    cluster.linkRowCount === 1 ? "1 linked mention" : `${cluster.linkRowCount} linked mentions`,
  );
  const firstPaper = cluster.linkedMentions[0]?.paperTitle;
  if (firstPaper) parts.push(`including ${firstPaper}`);
  return parts;
}

function identityContextText(cluster: AuthorIdentityCluster): string {
  return identityContextParts(cluster).join(" · ");
}

/** 1st, 2nd, 3rd, 4th… */
function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * One human description per person, guaranteed distinct across the whole set.
 *
 * Two identities may legitimately share a preferred name, and once in a while
 * they will also share every scrap of evidence attached to them: same name, no
 * ORCIDs, no aliases, nothing linked. That is a real state — creating two people
 * and resolving neither yet produces it — and at that point there is genuinely
 * nothing about them that differs except when the user made them.
 *
 * So creation order is the last resort, and only the last resort. It is true,
 * derived from the user's own data, and something a person can actually reason
 * about ("I made that one first"). The alternative was the identity's UUID,
 * which is unique but tells a human nothing at all — answering the question with
 * a different question.
 *
 * Computed over every cluster rather than over whatever a search is currently
 * showing, so a description does not change as the user types.
 */
function describeIdentities(
  clusters: readonly AuthorIdentityCluster[],
): Map<string, string> {
  const base = new Map<string, string>();
  const groups = new Map<string, AuthorIdentityCluster[]>();

  for (const cluster of clusters) {
    const text = identityContextText(cluster);
    base.set(cluster.rootId, text);
    // Grouped on name AND evidence: only a full collision needs a tiebreak.
    const key = `${cluster.preferredName}\u0000${text}`;
    const group = groups.get(key);
    if (group) group.push(cluster);
    else groups.set(key, [cluster]);
  }

  const described = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      described.set(group[0].rootId, base.get(group[0].rootId) ?? "");
      continue;
    }
    const ordered = [...group].sort(
      (a, b) => a.creationRank - b.creationRank || a.rootId.localeCompare(b.rootId),
    );
    ordered.forEach((cluster, index) => {
      described.set(
        cluster.rootId,
        `${base.get(cluster.rootId) ?? ""} · created ${ordinal(index + 1)}`,
      );
    });
  }
  return described;
}

/** A short, unambiguous description of where a mention comes from. */
function MentionContext({ mention }: { mention: AuthorMentionRef }) {
  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{mention.paperTitle}</span>
      {mention.year ? ` · ${mention.year}` : ""}
      {mention.journal ? ` · ${mention.journal}` : ""}
    </p>
  );
}

/**
 * Read-only evidence about a mention.
 *
 * Deliberately a small subset of what 001B stores. Enough to make an informed
 * decision — where it came from, what the source said it was, and an ORCID the
 * user can check — without turning the row into a provenance dump. Affiliations
 * are shown because they are useful context, and they influence no matching
 * whatsoever.
 */
function MentionEvidence({ mention }: { mention: AuthorMentionRef }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {mention.orcid && (
        <Badge variant="outline" className="text-[11px] font-normal">
          ORCID {mention.orcid}
        </Badge>
      )}
      {mention.provenanceKind && mention.provenanceKind !== "unknown" && (
        <Badge variant="outline" className="text-[11px] font-normal capitalize">
          {mention.provenanceKind}
        </Badge>
      )}
      {mention.provenanceSource && (
        <Badge variant="outline" className="text-[11px] font-normal">
          {mention.provenanceSource.replace(/_/g, " ")}
        </Badge>
      )}
      {mention.affiliations.length > 0 && (
        <span className="text-[11px] text-muted-foreground truncate max-w-[260px]">
          {mention.affiliations[0]}
        </span>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Stale saved links — reported, never repaired behind the user's back
 * ---------------------------------------------------------------------- */

/** How many stale rows are listed before the rest are summarised. */
const STALE_RENDER_LIMIT = 10;

/**
 * Saved links that no longer describe the mention they name.
 *
 * The database makes these unreachable: a trigger clears a paper's links the
 * moment its `authors` change. So this list is empty in every healthy account,
 * and exists for the case where that guarantee failed — a privileged write, a
 * restored backup.
 *
 * Two rules govern it. First, nothing is repaired automatically. A background
 * effect that quietly deleted rows the frontend disliked would be Paperlume
 * editing the user's identity history on a hunch, which is the same class of
 * silent assertion the whole feature refuses; detection is read-only and repair
 * is always an explicit click.
 *
 * Second, the row is described in terms the user can act on: the name it was
 * saved under, the paper, and the person it points at. Where the author position
 * still exists the mention is also back in Unresolved and can simply be resolved
 * again; where it does not, removing the row is the only repair, and that is
 * what this offers.
 */
function StaleLinkList({
  staleLinks,
  identities,
  busy,
}: {
  staleLinks: AuthorIdentityResolution["staleLinks"];
  identities: IdentitiesApi;
  busy: boolean;
}) {
  const visible = staleLinks.slice(0, STALE_RENDER_LIMIT);
  const hidden = staleLinks.length - visible.length;

  return (
    <div className="mb-2 space-y-2 rounded-md border border-dashed p-2.5">
      <p className="text-xs font-medium text-destructive">
        {staleLinks.length === 1
          ? "1 saved link no longer matches the author text it was made for."
          : `${staleLinks.length} saved links no longer match the author text they were made for.`}
      </p>
      <p className="text-[11px] text-muted-foreground">
        They are being ignored, so nobody is grouped by them. Nothing is removed
        until you say so.
      </p>
      <ul className="space-y-1">
        {visible.map((stale) => (
          <li
            key={stale.link.id}
            className="flex items-start justify-between gap-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs">
                Saved as <span className="font-medium">{stale.link.author_name_snapshot}</span>
                {stale.identityName ? ` for ${stale.identityName}` : ""}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {stale.paperTitle ?? "A paper that is not currently loaded"}
                {stale.hasCurrentMention
                  ? " · that author is listed under Unresolved, so you can decide again"
                  : " · that author position no longer exists"}
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 text-xs"
              disabled={busy}
              aria-label={`Remove stale saved link for ${stale.link.author_name_snapshot}${
                stale.paperTitle ? ` on ${stale.paperTitle}` : ""
              }`}
              onClick={() =>
                void identities
                  .unlinkMention(stale.link.paper_id, stale.link.author_index)
                  .catch(() => {
                    /* reported by the hook */
                  })
              }
            >
              Remove stale saved link
            </Button>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="text-[11px] text-muted-foreground">{hidden} more not shown.</p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * The manual chooser — the user overriding the algorithm, deliberately
 * ---------------------------------------------------------------------- */

/**
 * Search the user's own people and pick one, in two explicit steps.
 *
 * WHY THIS EXISTS AT ALL. Automatic candidate generation is conservative on
 * purpose: it withholds a name match whenever ORCID evidence contradicts it, so
 * a one-click Link can never propose joining two provably different people.
 * That conservatism is *advice*. Without a manual path it silently becomes
 * policy — the algorithm deciding which of the user's own people the user is
 * permitted to choose — and there are real cases on the other side of it. A
 * source states the wrong iD; a person changed iDs; two records for one human
 * disagree. The user can see that. The application cannot.
 *
 * So this refuses nobody. Every owned identity is searchable and selectable,
 * including — especially — the ones deterministic evidence declined to suggest.
 *
 * WHY TWO STEPS. Selecting surfaces the contradiction; confirming acts on it. A
 * single click that both selected and committed would make an override
 * indistinguishable from a misclick, and the whole point is that this one is
 * deliberate. Cancelling writes nothing, and so does changing the selection.
 *
 * WHY THE WHOLE ROW. Selection used to live in a `Choose` button at the far end
 * of a single nowrap line. Inside a scroll viewport that does not clip such a
 * line, it stretches the row instead — and a button pinned to the end of a row
 * wider than the viewport sits outside it, with no scrollbar on that axis and
 * nothing painted at its coordinates. It stayed clickable through the DOM, which
 * is exactly why automation never noticed, and unreachable for a person, which
 * is what the owner reported. The affordance is now the row itself: it cannot
 * leave the viewport without taking the person's name with it.
 *
 * Rendered inline rather than in a nested dialog so the mention's own evidence —
 * its ORCID, its paper, its source — stays on screen while the user decides. The
 * contradiction is only meaningful next to both halves of it.
 */
function IdentityPicker({
  resolution,
  describe,
  excludeRootIds,
  question,
  searchLabel,
  confirmLabel,
  describeChoice,
  conflictFor,
  conflictNote,
  busy,
  onCancel,
  onConfirm,
}: {
  resolution: AuthorIdentityResolution;
  /** Distinct human descriptions, shared with every other person-choice surface. */
  describe: ReadonlyMap<string, string>;
  excludeRootIds?: readonly string[];
  /** The question the list answers, e.g. "Who is Stuart Phillips?". */
  question: string;
  /** Accessible name for the search field. Distinct per row, so it stays unique. */
  searchLabel: string;
  /** The commit button's label. Names both sides of the decision. */
  confirmLabel: (cluster: AuthorIdentityCluster) => string;
  /** Full sentence describing what confirming will do. */
  describeChoice: (cluster: AuthorIdentityCluster) => string;
  /** ORCIDs on the chosen person that contradict this decision, or `[]`. */
  conflictFor: (cluster: AuthorIdentityCluster) => string[];
  /** What the conflicting evidence on the other side of the decision is. */
  conflictNote: (cluster: AuthorIdentityCluster, conflicting: string[]) => string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (cluster: AuthorIdentityCluster) => void;
}) {
  const groupId = useId();
  const questionId = `${groupId}-question`;
  const [search, setSearch] = useState("");
  const [chosenId, setChosenId] = useState<string | null>(null);

  const matches = useMemo(
    () => searchAuthorIdentityClusters(resolution, search, { excludeRootIds }),
    [resolution, search, excludeRootIds],
  );

  /**
   * The selection is held as an id and re-read from the CURRENT graph.
   *
   * Searching is a change of view, not a change of mind: typing must not discard
   * a decision the user already made, so filtering the list deliberately leaves
   * the selection — and the confirmation naming it — standing even when the row
   * itself is filtered out of sight. Clearing the search brings the row back
   * already selected.
   *
   * What DOES clear it is the person genuinely ceasing to be a choice: deleted,
   * merged into someone else, or excluded from this particular picker. Holding
   * the cluster object instead would keep a stale copy of a person who no longer
   * exists and offer to link to them, which the RPC would then refuse for a
   * reason the user could not see.
   */
  const chosen = useMemo(() => {
    if (chosenId === null) return null;
    if (excludeRootIds?.includes(chosenId)) return null;
    return resolution.clusters.get(chosenId) ?? null;
  }, [chosenId, excludeRootIds, resolution]);

  const visible = matches.slice(0, PICKER_RENDER_LIMIT);
  const hidden = matches.length - visible.length;
  const conflicting = chosen ? conflictFor(chosen) : [];

  return (
    <div className="space-y-2.5 rounded-md border border-dashed p-2.5">
      <div className="space-y-0.5">
        <p id={questionId} className="text-xs font-medium">
          {question}
        </p>
        <p className="text-[11px] text-muted-foreground">
          Select an existing person below. Nothing will be changed until you confirm.
        </p>
      </div>

      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search by name, other name, or ORCID"
        aria-label={searchLabel}
        className="h-8 text-sm"
      />

      {matches.length === 0 ? (
        <p className="text-xs text-muted-foreground">No people match that search.</p>
      ) : (
        <div role="radiogroup" aria-labelledby={questionId} className="space-y-1">
          {visible.map((cluster) => {
            const context = describe.get(cluster.rootId) ?? identityContextText(cluster);
            const selected = chosen?.rootId === cluster.rootId;
            return (
              // A real radio in a real group, visually replaced rather than
              // reimplemented. Arrow-key movement, the group's single tab stop,
              // and the checked state a screen reader reads out are all the
              // platform's, not ours. The label wraps the whole row, so the row
              // — not a control at the end of it — is what the user presses,
              // whether with a mouse, a finger, or the keyboard.
              <label
                key={cluster.rootId}
                className={cn(
                  // `relative` is load-bearing: the visually-hidden radio is
                  // absolutely positioned, so without a positioned row to belong
                  // to it is laid out against the scroll viewport instead —
                  // hundreds of pixels from its own label. Focusing it then
                  // scrolls the list somewhere unrelated, which is exactly what
                  // clicking a row does.
                  "relative block rounded-md",
                  busy ? "cursor-not-allowed" : "cursor-pointer",
                )}
              >
                <input
                  type="radio"
                  name={groupId}
                  value={cluster.rootId}
                  checked={selected}
                  disabled={busy}
                  onChange={() => setChosenId(cluster.rootId)}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    // min-h-11 keeps the row a comfortable touch target even
                    // when the person carries a single short line of evidence.
                    "flex min-h-11 w-full items-start gap-2.5 rounded-md border p-2 transition-colors",
                    "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1",
                    selected
                      ? "border-primary bg-accent"
                      : "border-transparent hover:bg-muted/60",
                    busy && "opacity-60",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                      selected ? "border-primary" : "border-muted-foreground/50",
                    )}
                  >
                    {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
                  </span>
                  {/* `min-w-0` plus wrapping, never `truncate`. A nowrap row
                      inside a scroll viewport does not get clipped by it — it
                      pushes the row wider than the viewport and takes whatever
                      sits at the end of it out of reach. */}
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block break-words text-xs font-medium">
                      {cluster.preferredName}
                    </span>
                    {/* Two people may share a preferred name, so the evidence
                        that tells them apart is part of the option itself and
                        therefore part of its accessible name. */}
                    <span className="block break-words text-[11px] text-muted-foreground">
                      {context}
                    </span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      {hidden > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {hidden} more not shown. Search to narrow the list.
        </p>
      )}

      {chosen && (
        <div className="space-y-1.5 rounded-md bg-muted/50 p-2">
          <p className="break-words text-xs">{describeChoice(chosen)}</p>
          {conflicting.length > 0 && (
            // Stated, not judged. Neither iD is called wrong, because this
            // application has no way to know which one is — only that they
            // disagree, and that the user is choosing to proceed anyway.
            <p className="break-words text-[11px] text-destructive">
              {conflictNote(chosen, conflicting)} Paperlume did not suggest this
              match, and is not changing either record. Continuing is your decision.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {chosen && (
          <Button
            size="sm"
            className="h-8 whitespace-normal text-left text-xs"
            disabled={busy}
            onClick={() => onConfirm(chosen)}
          >
            {confirmLabel(chosen)}
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function AuthorIdentityManager({
  papers,
  identities,
  open,
  onOpenChange,
}: AuthorIdentityManagerProps) {
  // Focus a heading rather than a text field when a finger opened this: the
  // repository's touch-safe contract, and the unresolved list is the first thing
  // worth reading anyway.
  const { focusRef, onOpenAutoFocus } = useTouchSafeInitialFocus<HTMLHeadingElement>();

  const { dataset, linkedPapers, readState, canMutate, retry, isMutating } = identities;

  /**
   * Nothing may be written while the authoritative graph is in doubt.
   *
   * A link, a merge and a delete are all validated against the CURRENT graph.
   * From `stale` — the last known-good dataset over a failed refresh — a control
   * would still look usable and could displace a decision made since, so every
   * one of them is disabled until a read succeeds. `isMutating` keeps its own,
   * separate job: stopping a second click while one write is in flight.
   */
  const busy = isMutating || !canMutate;

  /**
   * `papers` is what Analytics is currently showing; `linkedPapers` is every
   * paper the identity graph actually links to, account-wide.
   *
   * Both are needed and they are not interchangeable. The unresolved list is
   * about the current view — that is what the user is working through. What an
   * existing person IS must not depend on the view at all, or filtering would
   * erase a person's ORCID evidence, hide them from this dialog's own search,
   * and offer Delete for someone with links elsewhere in the library.
   */
  const resolution = useMemo(
    () => buildAuthorIdentityResolution(papers, dataset, linkedPapers),
    [papers, dataset, linkedPapers],
  );
  const candidates = useMemo(
    () => generateAuthorIdentityCandidates(resolution),
    [resolution],
  );
  const duplicates = useMemo(() => findAuthorIdentityDuplicates(resolution), [resolution]);

  const clusters = useMemo(
    () =>
      [...resolution.clusters.values()].sort((a, b) =>
        a.preferredName.localeCompare(b.preferredName),
      ),
    [resolution],
  );

  /** Mentions the user has not decided about, most informative first. */
  const unresolved = useMemo(
    () => candidates.filter((entry) => entry.candidates.length > 0)
      .concat(candidates.filter((entry) => entry.candidates.length === 0)),
    [candidates],
  );

  /** One distinct description per person, shared by every choice surface here. */
  const describe = useMemo(() => describeIdentities(clusters), [clusters]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[85vh] flex flex-col"
        onOpenAutoFocus={onOpenAutoFocus}
      >
        <DialogHeader>
          <DialogTitle ref={focusRef} tabIndex={-1} className="outline-none">
            Author identities
          </DialogTitle>
          <DialogDescription>
            Group author mentions that you know are the same person. Paperlume
            suggests matches from ORCIDs and exact name spellings, and never links
            anyone for you.
          </DialogDescription>
        </DialogHeader>

        {readState === "unavailable" ? (
          // The expected compatibility case, and deliberately not phrased as an
          // error: nothing is broken, this environment simply predates 001C.
          <p className="py-8 text-center text-sm text-muted-foreground">
            Author identities are not available in this environment yet. Everything
            else on this page works normally, and authors are grouped by their name
            spelling as before.
          </p>
        ) : readState === "failed" ? (
          // A REAL failure, and the one thing it must not do is look like the
          // case above. Saying "you have no people yet" here would be a lie the
          // user has no way to detect.
          <div className="space-y-3 py-8 text-center">
            <p className="text-sm font-medium">Author identities could not be loaded.</p>
            <p className="text-sm text-muted-foreground">
              Your saved people and links are unchanged — this page just could not
              read them. Nothing can be edited until it loads.
            </p>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : readState === "loading" ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Loading author identities…
          </p>
        ) : (
          <Tabs defaultValue="unresolved" className="flex min-h-0 flex-1 flex-col">
            {readState === "stale" && (
              // Known-good data is worth keeping on screen — throwing it away to
              // simplify the UI would cost the user everything they came here to
              // see. But it is last-known, not current, and editing on top of it
              // could displace a decision made since, so it is labelled and every
              // control below is disabled.
              <div className="mb-2 space-y-1.5 rounded-md border border-dashed p-2.5">
                <p className="text-xs font-medium">
                  Showing the last author identities that loaded successfully.
                </p>
                <p className="text-[11px] text-muted-foreground">
                  A refresh failed, so this may be out of date and cannot be edited
                  until it loads again.
                </p>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={retry}>
                  Try again
                </Button>
              </div>
            )}

            {resolution.staleLinks.length > 0 && (
              <StaleLinkList
                staleLinks={resolution.staleLinks}
                identities={identities}
                busy={busy}
              />
            )}
            <TabsList className="w-full">
              <TabsTrigger value="unresolved" className="flex-1">
                Unresolved ({unresolved.length})
              </TabsTrigger>
              <TabsTrigger value="people" className="flex-1">
                People ({clusters.length})
              </TabsTrigger>
              <TabsTrigger value="duplicates" className="flex-1">
                Duplicates ({duplicates.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="unresolved" className="min-h-0 flex-1">
              <UnresolvedList
                entries={unresolved}
                resolution={resolution}
                describe={describe}
                identities={identities}
                busy={busy}
              />
            </TabsContent>

            <TabsContent value="people" className="min-h-0 flex-1">
              <PeopleList
                clusters={clusters}
                resolution={resolution}
                describe={describe}
                identities={identities}
                busy={busy}
              />
            </TabsContent>

            <TabsContent value="duplicates" className="min-h-0 flex-1">
              <DuplicateList
                duplicates={duplicates}
                resolution={resolution}
                describe={describe}
                identities={identities}
                busy={busy}
              />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Makes a scroll viewport's content take the viewport's width.
 *
 * Radix wraps a ScrollArea's children in an element styled `display: table;
 * min-width: 100%`, which is how it measures overflow on both axes. A table box
 * is never laid out narrower than its own min-content width, so one `nowrap`
 * descendant anywhere inside makes that wrapper — and every row in it — wider
 * than the viewport rather than clipped by it. The viewport is `overflow-x:
 * hidden` and mounts no horizontal scrollbar, so anything pushed out there is
 * unreachable: not scrollable by wheel, trackpad or drag, and not painted.
 *
 * Forcing the wrapper to a block box gives it the viewport's width, which is the
 * only width this dialog ever wants. Vertical scrolling, the axis that does have
 * a scrollbar, is unaffected.
 */
const SCROLL_CONTENT_FITS_WIDTH = "[&_[data-radix-scroll-area-viewport]>div]:!block";

/* -------------------------------------------------------------------------
 * Unresolved mentions
 * ---------------------------------------------------------------------- */

/**
 * One unresolved mention, its evidence, and the actions available for it.
 *
 * A candidate is rendered as a button labelled with the person's name and the
 * factual reason. Pressing it links THAT mention to THAT identity and nothing
 * else — no other mention is affected, and no other suggestion is applied. This
 * is the point at which a suggestion becomes a decision, and it is always a
 * deliberate act.
 */
function UnresolvedRow({
  mention,
  candidates,
  resolution,
  describe,
  identities,
  busy,
}: {
  mention: AuthorMentionRef;
  candidates: ReturnType<typeof generateAuthorIdentityCandidates>[number]["candidates"];
  resolution: AuthorIdentityResolution;
  describe: ReadonlyMap<string, string>;
  identities: IdentitiesApi;
  busy: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [draftName, setDraftName] = useState(mention.displayName);

  /**
   * A surviving row for this position that no longer describes it.
   *
   * The database makes this unreachable through the application, so it is only
   * ever seen if that guarantee failed. When it has, acting on the mention must
   * REPLACE the stale row rather than insert beside it — the unique
   * `(paper_id, author_index)` constraint would otherwise reject the user's
   * decision for a reason they cannot see or fix.
   */
  const hasStaleLink = resolution.staleLinkSlots.has(
    mentionSlotKey(mention.paperId, mention.authorIndex),
  );

  const create = useCallback(async () => {
    // The preferred name defaults to the display-normalized source spelling and
    // is editable before confirming. It is never assembled from 001B's
    // given/family components: how a person is called is the user's call, not a
    // parser's.
    await identities
      .createIdentityFromMention({
        paperId: mention.paperId,
        authorIndex: mention.authorIndex,
        expectedAuthor: mention.rawName,
        preferredName: draftName,
        // The same repair the Link path already had. Without it this button was
        // offered for a stale slot and could only ever fail on the unique
        // (paper_id, author_index) constraint — the UI said "unresolved" and
        // every action it gave the user was impossible. The server re-proves
        // staleness itself; a link that still matches is refused there.
        replaceStaleExisting: hasStaleLink,
      })
      .then(() => setCreating(false))
      .catch(() => {
        /* reported by the hook; the form stays open so nothing is lost */
      });
  }, [identities, mention, draftName, hasStaleLink]);

  const link = useCallback(
    (rootId: string, basis: "orcid_candidate" | "name_candidate" | "manual") => {
      void identities
        .linkMention({
          paperId: mention.paperId,
          authorIndex: mention.authorIndex,
          expectedAuthor: mention.rawName,
          identityId: rootId,
          resolutionBasis: basis,
          replaceExisting: hasStaleLink,
        })
        .then(() => setPicking(false))
        .catch(() => {
          /* reported by the hook */
        });
    },
    [identities, mention, hasStaleLink],
  );

  return (
    <li className="rounded-md border p-3 space-y-2">
      <div className="space-y-1">
        <p className="text-sm font-medium">{mention.displayName}</p>
        <MentionContext mention={mention} />
        <MentionEvidence mention={mention} />
      </div>

      {candidates.length > 0 && (
        <div className="space-y-1.5">
          {candidates.some((candidate) => candidate.ambiguous) && (
            <p className="text-xs text-muted-foreground">
              More than one person matches this evidence. Choose the right one, or
              review them under Duplicates.
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {candidates.map((candidate) => (
              <Button
                key={`${candidate.rootId}:${candidate.reason}`}
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={busy}
                onClick={() =>
                  link(
                    candidate.rootId,
                    candidate.reason === "same_orcid" ? "orcid_candidate" : "name_candidate",
                  )
                }
              >
                Link to {candidate.preferredName}
                <Badge variant="secondary" className="ml-1.5 text-[10px] font-normal">
                  {REASON_TEXT[candidate.reason]}
                </Badge>
              </Button>
            ))}
          </div>
        </div>
      )}

      {picking && (
        <IdentityPicker
          resolution={resolution}
          describe={describe}
          question={`Who is ${mention.displayName}?`}
          searchLabel={`Search people to link ${mention.displayName} to`}
          // Both halves of the decision, so the commit reads as the sentence the
          // user is actually agreeing to rather than as a bare verb.
          confirmLabel={(cluster) =>
            `Link ${mention.displayName} to ${cluster.preferredName}`
          }
          describeChoice={(cluster) =>
            `${mention.displayName} on this paper will be recorded as ${cluster.preferredName}.`
          }
          conflictFor={(cluster) => authorIdentityOrcidConflict(mention.orcid, cluster)}
          conflictNote={(cluster, conflicting) =>
            `This mention states ORCID ${mention.orcid}; ${cluster.preferredName} is linked to papers stating ${conflicting.join(", ")}.`
          }
          busy={busy}
          onCancel={() => setPicking(false)}
          // Chosen by hand rather than followed from a suggestion, and recorded
          // as such: `manual` is how the decision was actually reached.
          onConfirm={(cluster) => link(cluster.rootId, "manual")}
        />
      )}

      {creating ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            aria-label="Name for this person"
            className="h-8 flex-1 min-w-[180px] text-sm"
          />
          <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={create}>
            Create person
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => setCreating(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {/* Always offered, whatever the evidence suggested — including when it
              deliberately suggested nothing. A user who can see that a source
              got an ORCID wrong must still be able to say so. */}
          {resolution.clusters.size > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              disabled={busy || picking}
              aria-label={`Link ${mention.displayName} to an existing person`}
              onClick={() => setPicking(true)}
            >
              Link to existing person…
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            disabled={busy}
            onClick={() => {
              setDraftName(mention.displayName);
              setCreating(true);
            }}
          >
            Create a new person
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * How many unresolved mentions are rendered at once.
 *
 * A modest library reaches several hundred author mentions — 120 papers with two
 * authors each is already 240 — and every one of them is a card carrying its own
 * buttons and an editable field. Rendering them all makes the dialog slow to open
 * and slow to update after every decision, which matters most exactly when the
 * user is working through a long list.
 *
 * Suggestions are ordered first, so the mentions worth acting on are the ones on
 * screen; the search box reaches anything else. The tab label keeps showing the
 * true total, because how much work remains is the honest number.
 */
const UNRESOLVED_RENDER_LIMIT = 50;

function UnresolvedList({
  entries,
  resolution,
  describe,
  identities,
  busy,
}: {
  entries: ReturnType<typeof generateAuthorIdentityCandidates>;
  resolution: AuthorIdentityResolution;
  describe: ReadonlyMap<string, string>;
  identities: IdentitiesApi;
  busy: boolean;
}) {
  const [search, setSearch] = useState("");

  const matching = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(
      (entry) =>
        entry.mention.displayName.toLowerCase().includes(query) ||
        entry.mention.paperTitle.toLowerCase().includes(query),
    );
  }, [entries, search]);

  const visible = matching.slice(0, UNRESOLVED_RENDER_LIMIT);
  const hidden = matching.length - visible.length;

  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Every author mention in the current papers has been resolved, or is a
        collective author that cannot be a person.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search author or paper"
        aria-label="Search unresolved author mentions"
        className="h-8 text-sm"
      />
      {matching.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No unresolved author mentions match that search.
        </p>
      ) : (
        <ScrollArea className={cn("h-[46vh] pr-3", SCROLL_CONTENT_FITS_WIDTH)}>
          <ul className="space-y-2 py-1">
            {visible.map((entry) => (
              <UnresolvedRow
                key={`${entry.mention.paperId}:${entry.mention.authorIndex}`}
                mention={entry.mention}
                candidates={entry.candidates}
                resolution={resolution}
                describe={describe}
                identities={identities}
                busy={busy}
              />
            ))}
          </ul>
          {hidden > 0 && (
            <p className="px-1 pb-2 text-xs text-muted-foreground">
              {hidden} more not shown. Search to narrow the list, or resolve these
              first — mentions with a suggestion are listed before the rest.
            </p>
          )}
        </ScrollArea>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * People
 * ---------------------------------------------------------------------- */

/**
 * The accessible name for one "undo this merge" control.
 *
 * `A → B → C` puts both A and B under root C, so the card shows two undo
 * controls and they must not read identically — the user is choosing which edge
 * to reverse, and reversing the wrong one silently regroups their library.
 *
 * The name says which member and which target. Where two merged members happen
 * to share both — nothing stops two people being called `John Smith` — their own
 * distinguishing evidence is appended, the same evidence the picker shows.
 */
function undoMergeLabel(
  member: AuthorIdentityMergedMember,
  cluster: AuthorIdentityCluster,
): string {
  const base = `Undo merge of ${member.preferredName} into ${member.targetPreferredName}`;
  const collides =
    cluster.mergedMembers.filter(
      (other) =>
        other.preferredName === member.preferredName &&
        other.targetPreferredName === member.targetPreferredName,
    ).length > 1;
  if (!collides) return base;

  const evidence = undoMergeEvidence(member);

  // Two merged members can be identical right down to their evidence — two
  // same-named people, neither carrying anything, both merged into this one.
  // Creation order is then the only true thing left that distinguishes them,
  // and it is something a person can actually reason about, unlike a UUID.
  const twins = cluster.mergedMembers.filter(
    (other) =>
      other.preferredName === member.preferredName &&
      other.targetPreferredName === member.targetPreferredName &&
      undoMergeEvidence(other) === evidence,
  );
  if (twins.length < 2) return `${base} — ${evidence}`;

  const rank =
    [...twins]
      .sort((a, b) => a.creationRank - b.creationRank || a.id.localeCompare(b.id))
      .findIndex((other) => other.id === member.id) + 1;
  return `${base} — ${evidence} · created ${ordinal(rank)}`;
}

/** The evidence half of an undo label, and the key collisions are detected on. */
function undoMergeEvidence(member: AuthorIdentityMergedMember): string {
  const parts: string[] = [];
  if (member.orcids.length > 0) parts.push(`ORCID ${member.orcids.join(", ")}`);
  if (member.aliases.length > 0) parts.push(`also known as ${member.aliases.join(", ")}`);
  if (member.linkedSpellings.length > 0) {
    parts.push(`linked as ${member.linkedSpellings.join(", ")}`);
  }
  parts.push(
    member.linkedMentionCount === 1
      ? "1 linked mention"
      : `${member.linkedMentionCount} linked mentions`,
  );
  return parts.join(" · ");
}

/**
 * How many linked mentions an expanded person shows before offering the rest.
 *
 * A prolific author accumulates dozens of linked mentions, and rendering all of
 * them turns "who is this person" into a wall of paper titles that buries the
 * name, the aliases and the merge control underneath it. Five is enough to
 * recognise a person by the work attached to them; the rest is available on
 * request and never rendered until then.
 */
const MENTION_PREVIEW_LIMIT = 5;

/**
 * The short facts a collapsed person row states about itself.
 *
 * `linkedMentions` rather than `linkRowCount`: this number is a promise about
 * what opening the row will show, so it has to be the number of mentions the
 * panel can actually list. `linkRowCount` answers a different question — "is
 * this person empty" — and only that one may gate Delete.
 */
function personSummaryParts(cluster: AuthorIdentityCluster): string[] {
  const mentions = cluster.linkedMentions.length;
  const parts = [mentions === 1 ? "1 linked mention" : `${mentions} linked mentions`];
  if (cluster.aliases.length > 0) {
    parts.push(cluster.aliases.length === 1 ? "1 alias" : `${cluster.aliases.length} aliases`);
  }
  if (cluster.mergedMemberIds.length > 0) {
    parts.push(`${cluster.mergedMemberIds.length} merged`);
  }
  return parts;
}

/**
 * The short evidence that tells two same-name people apart in the compact list.
 *
 * Preferred names are not unique, and a list of identical rows is not a list.
 * The full description every other choice surface here shows ends in an example
 * paper title, which is exactly the kind of long text a scannable row must not
 * carry — so this keeps the identifying evidence (other names, iDs) and drops
 * both the example paper and the mention count the row already states in its
 * own right.
 *
 * When even that evidence is identical, `describeIdentities` has already fallen
 * back to creation order, and that tiebreak — the last thing it appends — is
 * carried over, because at that point it is the only true distinction left.
 */
function ambiguityCue(
  cluster: AuthorIdentityCluster,
  describe: ReadonlyMap<string, string>,
): string {
  const parts = identityContextParts(cluster).filter(
    (part) => !part.startsWith("including ") && !/\d+ linked mentions?$/.test(part),
  );
  const described = describe.get(cluster.rootId) ?? "";
  const last = described.split(" · ").pop() ?? "";
  if (/^created \d+(?:st|nd|rd|th)$/.test(last)) parts.push(last);
  return parts.join(" · ");
}

/**
 * One person, collapsed to a single row until the user asks for more.
 *
 * The whole header is the disclosure control, not a chevron at the end of it:
 * a row is what a person aims at, with a mouse and much more so with a finger,
 * and a 16px target beside a name that may wrap to two lines is neither. The
 * chevron stays as the visual statement of state and is hidden from assistive
 * technology, because `aria-expanded` already says it and saying it twice makes
 * every row longer to listen to.
 *
 * The body is rendered only while open. Hiding it with CSS would leave every
 * person's mention list, alias editor and merge control in the document at all
 * times — the exact cost this compaction exists to remove.
 */
function PersonRow({
  cluster,
  resolution,
  describe,
  ambiguousName,
  identities,
  busy,
  expanded,
  onToggle,
  showAllMentions,
  onToggleShowAllMentions,
  onDelete,
  headerRef,
}: {
  cluster: AuthorIdentityCluster;
  resolution: AuthorIdentityResolution;
  describe: ReadonlyMap<string, string>;
  /**
   * Whether another person on this list is called the same thing.
   *
   * When they are, every control on this row — the header, the name field, the
   * alias field, Merge, Delete — would otherwise carry an accessible name
   * identical to its twin, and a screen-reader user would be choosing between
   * two "Merge John Smith into another person" buttons with nothing to separate
   * them. The row's own evidence is added only then, because for the
   * overwhelmingly common unique-name case the short label is clearer.
   */
  ambiguousName: boolean;
  identities: IdentitiesApi;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  showAllMentions: boolean;
  onToggleShowAllMentions: () => void;
  onDelete: () => void;
  headerRef: (node: HTMLButtonElement | null) => void;
}) {
  const rowId = useId();
  const headerId = `${rowId}-header`;
  const panelId = `${rowId}-panel`;
  const summary = personSummaryParts(cluster);
  if (ambiguousName) {
    const cue = ambiguityCue(cluster, describe);
    if (cue) summary.push(cue);
  }

  return (
    <li className="rounded-md border">
      <button
        type="button"
        id={headerId}
        ref={headerRef}
        aria-expanded={expanded}
        // Only while the panel exists: pointing at an absent id is a promise
        // assistive technology cannot follow.
        aria-controls={expanded ? panelId : undefined}
        onClick={onToggle}
        className={cn(
          // min-h-11 keeps the row a comfortable target on a touch screen even
          // for a person whose name fits on one short line.
          "flex min-h-11 w-full items-center gap-2 rounded-md p-2 text-left transition-colors",
          "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2",
          "focus-visible:ring-ring focus-visible:ring-offset-1",
          expanded && "bg-muted/40",
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        {/* `min-w-0` plus wrapping, never `nowrap`. A row that refuses to wrap
            inside a scroll viewport is not clipped by it — it pushes itself
            wider than the viewport and takes the disclosure control with it. */}
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block break-words text-sm font-medium">
            {cluster.preferredName}
          </span>
          {/* One text node, joined the way every other accessible name in this
              dialog is joined. Separate elements with an aria-hidden separator
              would read as "11 linked mentions2 aliases": the separator is
              dropped from the accessible name and nothing replaces the space,
              because inline nodes are concatenated without one. */}
          <span className="block break-words text-[11px] text-muted-foreground">
            {summary.join(" · ")}
          </span>
        </span>
        {/* Evidence, never a verdict. A person carrying two contradictory iDs
            must not wear the same quiet badge as one carrying a single agreed
            one, because that badge would be hiding the thing worth knowing. */}
        {cluster.hasOrcidConflict ? (
          <Badge
            variant="outline"
            className="shrink-0 border-destructive text-[10px] font-normal text-destructive"
          >
            ORCID conflict
          </Badge>
        ) : cluster.orcids.length > 0 ? (
          <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
            ORCID
          </Badge>
        ) : null}
      </button>

      {expanded && (
        <div id={panelId} className="space-y-3 border-t p-2.5">
          <PersonDetail
            cluster={cluster}
            resolution={resolution}
            describe={describe}
            ambiguousName={ambiguousName}
            identities={identities}
            busy={busy}
            showAllMentions={showAllMentions}
            onToggleShowAllMentions={onToggleShowAllMentions}
            onDelete={onDelete}
          />
        </div>
      )}
    </li>
  );
}

/**
 * Everything a person can be managed with, shown only for the open row.
 *
 * Note what is NOT here. There is no verified badge, because Paperlume verified
 * nothing — the user decided. ORCID evidence is described as coming from the
 * linked mentions, because that is where it comes from and it disappears if
 * those links do. Conflicting identifiers are reported and left alone: two valid
 * iDs under one person means either a source is wrong or the user merged two
 * people, and this application cannot know which.
 */
function PersonDetail({
  cluster,
  resolution,
  describe,
  ambiguousName,
  identities,
  busy,
  showAllMentions,
  onToggleShowAllMentions,
  onDelete,
}: {
  cluster: AuthorIdentityCluster;
  resolution: AuthorIdentityResolution;
  describe: ReadonlyMap<string, string>;
  ambiguousName: boolean;
  identities: IdentitiesApi;
  busy: boolean;
  showAllMentions: boolean;
  onToggleShowAllMentions: () => void;
  onDelete: () => void;
}) {
  const nameSuffix = ambiguousName ? ` — ${describe.get(cluster.rootId) ?? ""}` : "";
  const [name, setName] = useState(cluster.preferredName);
  const [alias, setAlias] = useState("");
  const [merging, setMerging] = useState(false);
  const aliasRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const emptyAliasRef = useRef<HTMLParagraphElement>(null);

  const rename = useCallback(() => {
    if (name.trim() === cluster.preferredName) return;
    void identities.renameIdentity(cluster.rootId, name).catch(() => {
      /* reported by the hook */
    });
  }, [identities, cluster, name]);

  /**
   * Removing an alias is a list deletion, so it follows the repository's
   * post-delete focus rule: the next alias's remove button, else the previous
   * one, else whatever now occupies the same slot, else the empty-state text.
   * Neighbours are captured by id BEFORE the row unmounts, never by searching
   * the DOM afterwards.
   */
  const removeAlias = useCallback(
    (aliasId: string) => {
      const order = cluster.aliases;
      const index = order.findIndex((entry) => entry.id === aliasId);
      const next = index >= 0 ? order[index + 1]?.id : undefined;
      const previous = index > 0 ? order[index - 1]?.id : undefined;

      void identities
        .removeAlias(aliasId)
        .then(() => {
          const target =
            (next && aliasRefs.current.get(next)) ??
            (previous && aliasRefs.current.get(previous)) ??
            aliasRefs.current.get(aliasId) ??
            emptyAliasRef.current;
          // Only claim focus that has nowhere to be: a user who moved on during
          // the asynchronous delete keeps their place.
          if (target && document.activeElement === document.body) target.focus();
        })
        .catch(() => {
          /* reported by the hook */
        });
    },
    [identities, cluster],
  );

  /**
   * The mentions rendered right now.
   *
   * Ordering is the data layer's, untouched: links are read `created_at, id`
   * ascending, so "the first five" means the five decisions the user made first
   * and means the same thing on every render. Nothing here ranks by relevance,
   * by identifier, or by anything else — a list that reorders itself is a list
   * a user cannot return to.
   */
  const mentions = cluster.linkedMentions;
  const visibleMentions = showAllMentions
    ? mentions
    : mentions.slice(0, MENTION_PREVIEW_LIMIT);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={rename}
          aria-label={`Name for ${cluster.preferredName}${nameSuffix}`}
          className="h-8 flex-1 min-w-[180px] text-sm font-medium"
        />
      </div>

      {cluster.orcids.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {cluster.orcids.map((orcid) => (
            <Badge key={orcid} variant="outline" className="text-[11px] font-normal">
              ORCID {orcid}
            </Badge>
          ))}
          {cluster.hasOrcidConflict && (
            <span className="text-[11px] text-destructive">
              Linked papers state different ORCIDs for this person.
            </span>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          Linked mentions ({mentions.length})
        </p>
        {mentions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing is linked to this person in the current papers.
          </p>
        ) : (
          <ul className="space-y-1">
            {visibleMentions.map((mention) => (
              <li
                key={`${mention.paperId}:${mention.authorIndex}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="min-w-0 flex-1 truncate text-xs">
                  <span className="font-medium">{mention.displayName}</span>
                  <span className="text-muted-foreground"> — {mention.paperTitle}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 text-xs"
                  disabled={busy}
                  onClick={() =>
                    void identities
                      .unlinkMention(mention.paperId, mention.authorIndex)
                      .catch(() => {
                        /* reported by the hook */
                      })
                  }
                >
                  Unlink
                </Button>
              </li>
            ))}
          </ul>
        )}
        {/* Derived from the current list, never from a remembered total: unlink
            a mention off the end of a long list and the offer to expand it
            disappears on its own, rather than promising rows that are gone. */}
        {mentions.length > MENTION_PREVIEW_LIMIT && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-1 text-xs"
            onClick={onToggleShowAllMentions}
          >
            {showAllMentions ? "Show fewer" : `Show all ${mentions.length} linked mentions`}
          </Button>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          Also known as ({cluster.aliases.length})
        </p>
        {cluster.aliases.length === 0 ? (
          <p ref={emptyAliasRef} tabIndex={-1} className="text-xs text-muted-foreground outline-none">
            No other names recorded.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {cluster.aliases.map((entry) => (
              <Badge key={entry.id} variant="secondary" className="text-xs pr-1">
                <span className="truncate max-w-[160px]">{entry.alias}</span>
                <button
                  ref={(node) => aliasRefs.current.set(entry.id, node)}
                  onClick={() => removeAlias(entry.id)}
                  aria-label={`Remove alias ${entry.alias}`}
                  className="ml-1 hover:text-destructive"
                  disabled={busy}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Input
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            placeholder="Add another name"
            aria-label={`Add another name for ${cluster.preferredName}${nameSuffix}`}
            className="h-8 flex-1 text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={busy || !alias.trim()}
            onClick={() =>
              void identities
                .addAlias(cluster.rootId, alias)
                .then(() => setAlias(""))
                .catch(() => {
                  /* reported by the hook */
                })
            }
          >
            Add
          </Button>
        </div>
      </div>

      {cluster.mergedMembers.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Merged into this person ({cluster.mergedMembers.length})
          </p>
          <ul className="space-y-1">
            {cluster.mergedMembers.map((member) => (
              <li key={member.id} className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {member.preferredName}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    merged into {member.targetPreferredName}
                    {member.orcids.length > 0 ? ` · ORCID ${member.orcids.join(", ")}` : ""}
                    {member.linkedSpellings.length > 0
                      ? ` · linked as ${member.linkedSpellings.join(", ")}`
                      : ""}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 text-xs"
                  disabled={busy}
                  // Reverses ONE outgoing edge. In `A → B → C` undoing A's edge
                  // frees A and leaves `B → C` exactly as it was, because a merge
                  // is a link and never a reassignment.
                  aria-label={undoMergeLabel(member, cluster)}
                  onClick={() =>
                    void identities.unmergeIdentity(member.id).catch(() => {
                      /* reported by the hook */
                    })
                  }
                >
                  Undo merge
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {merging && (
        <IdentityPicker
          resolution={resolution}
          describe={describe}
          // Only this cluster is excluded. Every other cluster is a different
          // effective person by construction, so no choice here can close a
          // cycle — and the RPC re-checks anyway.
          excludeRootIds={[cluster.rootId]}
          question={`Merge ${cluster.preferredName} into which person?`}
          searchLabel={`Search people to merge ${cluster.preferredName} into`}
          confirmLabel={(target) =>
            `Merge ${cluster.preferredName} into ${target.preferredName}`
          }
          describeChoice={(target) =>
            `Merge ${cluster.preferredName} into ${target.preferredName}. ${target.preferredName} becomes the name for the group, both records are kept, and you can undo this at any time.`
          }
          conflictFor={(target) =>
            authorIdentityClustersConflict(cluster, target) ? [...target.orcids] : []
          }
          conflictNote={(target, conflicting) =>
            `${cluster.preferredName} is linked to papers stating ORCID ${cluster.orcids.join(", ")}; ${target.preferredName} states ${conflicting.join(", ")}.`
          }
          busy={busy}
          onCancel={() => setMerging(false)}
          onConfirm={(target) => {
            void identities
              .mergeIdentities(cluster.rootId, target.rootId)
              .then(() => setMerging(false))
              .catch(() => {
                /* reported by the hook */
              });
          }}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {/* Merging is a decision about two people the USER identifies, so it
            cannot be gated on the duplicate detector having spotted them. That
            detector is an assistant, not the list of merges the user is allowed
            to make — and it stays deliberately silent exactly where identifier
            evidence conflicts, which is one of the cases a person most needs to
            override. */}
        {resolution.clusters.size > 1 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={busy || merging}
            aria-label={`Merge ${cluster.preferredName}${nameSuffix} into another person`}
            onClick={() => setMerging(true)}
          >
            Merge with another person…
          </Button>
        )}
        {/* Row counts, not visible mentions: `delete_empty_author_identity`
            counts rows, so gating on what happens to be on screen would offer a
            Delete the database then correctly refuses. */}
        {cluster.linkRowCount === 0 &&
          cluster.aliasRowCount === 0 &&
          cluster.mergedMemberIds.length === 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive"
              disabled={busy}
              aria-label={`Delete ${cluster.preferredName}${nameSuffix}`}
              onClick={onDelete}
            >
              Delete person
            </Button>
          )}
      </div>
    </>
  );
}

/**
 * The People tab: every person the user has said exists, one row each.
 *
 * The list is compact by default and opens one person at a time. Both halves of
 * that matter. A management surface that renders every person's mentions,
 * aliases and actions at once stops being a list at around three people — a
 * single prolific author is taller than the dialog — and letting several open at
 * once would recreate the same wall a few clicks later. So the row is the unit
 * of the list, and the detail is a place you go rather than a thing you are in.
 *
 * The disclosure state is ephemeral by design: nothing about which row happens
 * to be open belongs in the database, the URL or local storage. It is keyed by
 * root id rather than by name, so renaming a person does not close their row,
 * and it is reconciled against the CURRENT identity graph on every render, so a
 * person who has been deleted or merged away cannot leave an open panel behind.
 */
function PeopleList({
  clusters,
  resolution,
  describe,
  identities,
  busy,
}: {
  clusters: AuthorIdentityCluster[];
  resolution: AuthorIdentityResolution;
  describe: ReadonlyMap<string, string>;
  identities: IdentitiesApi;
  busy: boolean;
}) {
  const [search, setSearch] = useState("");
  const [openedRootId, setOpenedRootId] = useState<string | null>(null);
  const [showAllRootId, setShowAllRootId] = useState<string | null>(null);
  const headerRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const emptyRef = useRef<HTMLParagraphElement>(null);

  // 001C's approved matching, unchanged and unextended: preferred name, manual
  // aliases, linked spellings, and an exact ORCID. No fuzzy matching, no
  // initials expansion, no affiliation, nothing inferred.
  const matches = useMemo(
    () => searchAuthorIdentityClusters(resolution, search),
    [resolution, search],
  );

  /**
   * The person whose panel is actually open, reconciled against what is on
   * screen right now.
   *
   * Two things can take the open row away without the user closing it: the
   * search no longer matches it, or the identity itself stopped being an
   * effective root — deleted, or merged into somebody else. Deriving the open
   * row rather than trusting the stored id means neither can ever paint a panel
   * belonging to a person who is not in the list.
   */
  const expandedRootId =
    openedRootId !== null && matches.some((cluster) => cluster.rootId === openedRootId)
      ? openedRootId
      : null;

  /**
   * ...and then forget it, so clearing the search does not spring the row back
   * open. A row that reappears expanded because of something the user typed
   * several keystrokes ago is hidden state, and the cost of asking them to press
   * it again is one press.
   */
  useEffect(() => {
    if (openedRootId !== null && expandedRootId === null) {
      setOpenedRootId(null);
      setShowAllRootId(null);
    }
  }, [openedRootId, expandedRootId]);

  const toggle = useCallback((rootId: string) => {
    // Opening a second person closes the first, and reopening anyone starts
    // from the compact five mentions again.
    setShowAllRootId(null);
    setOpenedRootId((current) => (current === rootId ? null : rootId));
  }, []);

  /**
   * Deleting a person is a list deletion, so it follows the repository's
   * post-delete focus rule: the next person's header, else the previous one,
   * else the empty-state text. Neighbours are captured by id BEFORE the row
   * unmounts, never by searching the DOM afterwards.
   */
  const deletePerson = useCallback(
    (rootId: string) => {
      const index = matches.findIndex((cluster) => cluster.rootId === rootId);
      const next = index >= 0 ? matches[index + 1]?.rootId : undefined;
      const previous = index > 0 ? matches[index - 1]?.rootId : undefined;
      // Whether the focus is standing on something that is about to be deleted.
      // Captured now, because by the time the delete resolves the answer is the
      // same but the row it refers to may be halfway out of the document.
      const row = headerRefs.current.get(rootId)?.closest("li") ?? null;
      const focusIsBeingDeleted = !!row && row.contains(document.activeElement);

      void identities
        .deleteIdentity(rootId)
        .then(() => {
          const target =
            (next && headerRefs.current.get(next)) ??
            (previous && headerRefs.current.get(previous)) ??
            emptyRef.current;
          // Claim focus in exactly two cases: it is about to be destroyed with
          // the row, or it is already nowhere. A user who moved on during the
          // asynchronous delete keeps their place.
          if (!target) return;
          if (focusIsBeingDeleted || document.activeElement === document.body) {
            target.focus();
          }
        })
        .catch(() => {
          /* reported by the hook */
        });
    },
    [identities, matches],
  );

  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const cluster of clusters) {
      counts.set(cluster.preferredName, (counts.get(cluster.preferredName) ?? 0) + 1);
    }
    return counts;
  }, [clusters]);

  if (clusters.length === 0) {
    return (
      <p
        ref={emptyRef}
        tabIndex={-1}
        className="py-8 text-center text-sm text-muted-foreground outline-none"
      >
        No people yet. Create one from an unresolved author mention.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search by name, other name, or ORCID"
        aria-label="Search people"
        className="h-8 text-sm"
      />
      {matches.length === 0 ? (
        <p
          ref={emptyRef}
          tabIndex={-1}
          className="py-8 text-center text-sm text-muted-foreground outline-none"
        >
          No people match that search.
        </p>
      ) : (
        <ScrollArea className={cn("h-[52vh] pr-3", SCROLL_CONTENT_FITS_WIDTH)}>
          <ul className="space-y-1.5 py-1">
            {matches.map((cluster) => (
              <PersonRow
                key={cluster.rootId}
                cluster={cluster}
                resolution={resolution}
                describe={describe}
                ambiguousName={(nameCounts.get(cluster.preferredName) ?? 0) > 1}
                identities={identities}
                busy={busy}
                expanded={expandedRootId === cluster.rootId}
                onToggle={() => toggle(cluster.rootId)}
                showAllMentions={showAllRootId === cluster.rootId}
                onToggleShowAllMentions={() =>
                  setShowAllRootId((current) =>
                    current === cluster.rootId ? null : cluster.rootId,
                  )
                }
                onDelete={() => deletePerson(cluster.rootId)}
                headerRef={(node) => headerRefs.current.set(cluster.rootId, node)}
              />
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Possible duplicates
 * ---------------------------------------------------------------------- */

/**
 * Pairs of people who might be the same person.
 *
 * "Merge A into B" is spelled out rather than assumed, because the direction
 * matters: B's name becomes the name of the group. Nothing is copied or deleted
 * either way — A keeps its links and aliases, which is what makes the undo in
 * the People tab a genuine restoration rather than a reconstruction.
 */
function DuplicateList({
  duplicates,
  resolution,
  describe,
  identities,
  busy,
}: {
  duplicates: ReturnType<typeof findAuthorIdentityDuplicates>;
  resolution: AuthorIdentityResolution;
  describe: ReadonlyMap<string, string>;
  identities: IdentitiesApi;
  busy: boolean;
}) {
  if (duplicates.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No possible duplicates found.
      </p>
    );
  }

  return (
    <ScrollArea className={cn("h-[52vh] pr-3", SCROLL_CONTENT_FITS_WIDTH)}>
      <ul className="space-y-2 py-2">
        {duplicates.map((pair) => {
          const first = resolution.clusters.get(pair.firstRootId);
          const second = resolution.clusters.get(pair.secondRootId);
          const firstContext = describe.get(pair.firstRootId) ?? "";
          const secondContext = describe.get(pair.secondRootId) ?? "";

          /**
           * Whether the two sides need their evidence in the button text.
           *
           * An exact shared name is itself duplicate evidence, so this tab is
           * precisely where two people called `John Smith` end up side by side —
           * and "Merge into John Smith" twice over gives the user no way to tell
           * which record they are about to keep. When the names differ the short
           * wording is clearer, so the context is added only where it is doing
           * work.
           */
          const namesCollide = pair.firstPreferredName === pair.secondPreferredName;
          const label = (name: string, context: string) =>
            namesCollide && context ? `${name} (${context})` : name;

          return (
            <li
              key={`${pair.firstRootId}|${pair.secondRootId}`}
              className="rounded-md border p-3 space-y-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">{pair.firstPreferredName}</span>
                <span className="text-xs text-muted-foreground">and</span>
                <span className="text-sm font-medium">{pair.secondPreferredName}</span>
                <Badge variant="secondary" className="text-[10px] font-normal">
                  {REASON_TEXT[pair.reason]}
                  {pair.orcid ? ` ${pair.orcid}` : ""}
                </Badge>
              </div>

              {/* Both sides' own evidence, always shown, so the pair can be
                  understood before either button is considered. */}
              {(first || second) && (
                <div className="space-y-0.5 text-[11px] text-muted-foreground">
                  <p className="truncate">
                    {pair.firstPreferredName} — {firstContext}
                  </p>
                  <p className="truncate">
                    {pair.secondPreferredName} — {secondContext}
                  </p>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Merging keeps both records. The one you merge into becomes the name
                for the group, and you can undo it at any time.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={busy}
                  // Names source AND target: direction is the whole decision, and
                  // DOM order is not something a screen reader conveys.
                  aria-label={`Merge ${label(pair.firstPreferredName, firstContext)} into ${label(
                    pair.secondPreferredName,
                    secondContext,
                  )}`}
                  onClick={() =>
                    void identities
                      .mergeIdentities(pair.firstRootId, pair.secondRootId)
                      .catch(() => {
                        /* reported by the hook */
                      })
                  }
                >
                  Merge into {label(pair.secondPreferredName, secondContext)}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={busy}
                  aria-label={`Merge ${label(pair.secondPreferredName, secondContext)} into ${label(
                    pair.firstPreferredName,
                    firstContext,
                  )}`}
                  onClick={() =>
                    void identities
                      .mergeIdentities(pair.secondRootId, pair.firstRootId)
                      .catch(() => {
                        /* reported by the hook */
                      })
                  }
                >
                  Merge into {label(pair.firstPreferredName, firstContext)}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

/**
 * The button that opens the manager, sited next to the Target Authors selector.
 *
 * Analytics is where author grouping becomes visible — it is the screen where a
 * user notices that one researcher is showing up as three — so it is where the
 * fix belongs. A new global navigation section would put the tool a long way
 * from the problem it solves.
 */
export function ManageAuthorIdentitiesButton({
  papers,
  identities,
  compact,
}: {
  papers: readonly AuthorIdentityPaper[];
  identities: IdentitiesApi;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={compact ? "h-8 w-full text-xs" : "h-8 text-xs"}
        onClick={() => setOpen(true)}
      >
        <Users className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Manage author identities
      </Button>
      <AuthorIdentityManager
        papers={papers}
        identities={identities}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
