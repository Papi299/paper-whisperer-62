import { useCallback, useMemo, useRef, useState } from "react";
import { Users } from "lucide-react";
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
 * WHY TWO STEPS. Choosing surfaces the contradiction; confirming acts on it. A
 * single click that both selected and committed would make an override
 * indistinguishable from a misclick, and the whole point is that this one is
 * deliberate. Cancelling writes nothing.
 *
 * Rendered inline rather than in a nested dialog so the mention's own evidence —
 * its ORCID, its paper, its source — stays on screen while the user decides. The
 * contradiction is only meaningful next to both halves of it.
 */
function IdentityPicker({
  resolution,
  excludeRootIds,
  searchLabel,
  confirmVerb,
  describeChoice,
  conflictFor,
  conflictNote,
  busy,
  onCancel,
  onConfirm,
}: {
  resolution: AuthorIdentityResolution;
  excludeRootIds?: readonly string[];
  /** Accessible name for the search field. Distinct per row, so it stays unique. */
  searchLabel: string;
  /** The button that commits, e.g. "Link" or "Merge". */
  confirmVerb: string;
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
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<AuthorIdentityCluster | null>(null);

  const matches = useMemo(
    () => searchAuthorIdentityClusters(resolution, search, { excludeRootIds }),
    [resolution, search, excludeRootIds],
  );

  if (chosen) {
    const conflicting = conflictFor(chosen);
    return (
      <div className="rounded-md border border-dashed p-2.5 space-y-2">
        <p className="text-xs">{describeChoice(chosen)}</p>
        <p className="text-[11px] text-muted-foreground">{identityContextText(chosen)}</p>
        {conflicting.length > 0 && (
          // Stated, not judged. Neither iD is called wrong, because this
          // application has no way to know which one is — only that they
          // disagree, and that the user is choosing to proceed anyway.
          <p className="text-[11px] text-destructive">
            {conflictNote(chosen, conflicting)} Paperlume did not suggest this
            match, and is not changing either record. Continuing is your decision.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={busy}
            onClick={() => onConfirm(chosen)}
          >
            {confirmVerb}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => setChosen(null)}
          >
            Back
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const visible = matches.slice(0, PICKER_RENDER_LIMIT);
  const hidden = matches.length - visible.length;

  return (
    <div className="rounded-md border border-dashed p-2.5 space-y-2">
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
        <ul className="space-y-1">
          {visible.map((cluster) => {
            const context = identityContextText(cluster);
            return (
              <li key={cluster.rootId} className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {cluster.preferredName}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {context}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 text-xs"
                  disabled={busy}
                  // Two people may share a preferred name, so the accessible
                  // name carries the same distinguishing evidence the sighted
                  // user reads underneath it.
                  aria-label={`Choose ${cluster.preferredName} — ${context}`}
                  onClick={() => setChosen(cluster)}
                >
                  Choose
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {hidden} more not shown. Search to narrow the list.
        </p>
      )}
      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>
        Cancel
      </Button>
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

  const { dataset, linkedPapers, isLoading, isUnavailable, isMutating } = identities;

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

        {resolution.staleLinks.length > 0 && (
          // Reachable only if the database's own guarantee failed — a trigger
          // clears every link on a paper the moment its authors change. Reported
          // rather than repaired: the rows are not obeyed anywhere, and the
          // mentions behind them are offered again as unresolved.
          <p className="text-xs text-destructive">
            {resolution.staleLinks.length === 1
              ? "1 saved link no longer matches the author text it was made for and is being ignored."
              : `${resolution.staleLinks.length} saved links no longer match the author text they were made for and are being ignored.`}{" "}
            Those mentions are listed as unresolved so you can decide again.
          </p>
        )}

        {isUnavailable ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Author identities are not available in this environment yet. Everything
            else on this page works normally, and authors are grouped by their name
            spelling as before.
          </p>
        ) : isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Loading author identities…
          </p>
        ) : (
          <Tabs defaultValue="unresolved" className="flex min-h-0 flex-1 flex-col">
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
                identities={identities}
                busy={isMutating}
              />
            </TabsContent>

            <TabsContent value="people" className="min-h-0 flex-1">
              <PeopleList
                clusters={clusters}
                resolution={resolution}
                identities={identities}
                busy={isMutating}
              />
            </TabsContent>

            <TabsContent value="duplicates" className="min-h-0 flex-1">
              <DuplicateList
                duplicates={duplicates}
                identities={identities}
                busy={isMutating}
              />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

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
  identities,
  busy,
}: {
  mention: AuthorMentionRef;
  candidates: ReturnType<typeof generateAuthorIdentityCandidates>[number]["candidates"];
  resolution: AuthorIdentityResolution;
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
      })
      .then(() => setCreating(false))
      .catch(() => {
        /* reported by the hook; the form stays open so nothing is lost */
      });
  }, [identities, mention, draftName]);

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
          searchLabel={`Search people to link ${mention.displayName} to`}
          confirmVerb="Link to this person"
          describeChoice={(cluster) =>
            `Link ${mention.displayName} to ${cluster.preferredName}.`
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
  identities,
  busy,
}: {
  entries: ReturnType<typeof generateAuthorIdentityCandidates>;
  resolution: AuthorIdentityResolution;
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
        <ScrollArea className="h-[46vh] pr-3">
          <ul className="space-y-2 py-1">
            {visible.map((entry) => (
              <UnresolvedRow
                key={`${entry.mention.paperId}:${entry.mention.authorIndex}`}
                mention={entry.mention}
                candidates={entry.candidates}
                resolution={resolution}
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
 * One effective person: their name, what they are also known as, what is linked
 * to them, and what identifier evidence those links currently carry.
 *
 * Note what is NOT here. There is no verified badge, because Paperlume verified
 * nothing — the user decided. ORCID evidence is described as coming from the
 * linked mentions, because that is where it comes from and it disappears if
 * those links do. Conflicting identifiers are reported and left alone: two valid
 * iDs under one person means either a source is wrong or the user merged two
 * people, and this application cannot know which.
 */
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
  return `${base} — ${parts.join(" · ")}`;
}

function PersonCard({
  cluster,
  resolution,
  identities,
  busy,
}: {
  cluster: AuthorIdentityCluster;
  resolution: AuthorIdentityResolution;
  identities: IdentitiesApi;
  busy: boolean;
}) {
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

  return (
    <li className="rounded-md border p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={rename}
          aria-label={`Name for ${cluster.preferredName}`}
          className="h-8 flex-1 min-w-[180px] text-sm font-medium"
        />
        {cluster.mergedMemberIds.length > 0 && (
          <Badge variant="secondary" className="text-[11px] font-normal">
            {cluster.mergedMemberIds.length} merged
          </Badge>
        )}
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
          Linked mentions ({cluster.linkedMentions.length})
        </p>
        {cluster.linkedMentions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing is linked to this person in the current papers.
          </p>
        ) : (
          <ul className="space-y-1">
            {cluster.linkedMentions.map((mention) => (
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
            aria-label={`Add another name for ${cluster.preferredName}`}
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
          // Only this cluster is excluded. Every other cluster is a different
          // effective person by construction, so no choice here can close a
          // cycle — and the RPC re-checks anyway.
          excludeRootIds={[cluster.rootId]}
          searchLabel={`Search people to merge ${cluster.preferredName} into`}
          confirmVerb="Merge into this person"
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
            aria-label={`Merge ${cluster.preferredName} into another person`}
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
              onClick={() =>
                void identities.deleteIdentity(cluster.rootId).catch(() => {
                  /* reported by the hook */
                })
              }
            >
              Delete person
            </Button>
          )}
      </div>
    </li>
  );
}

function PeopleList({
  clusters,
  resolution,
  identities,
  busy,
}: {
  clusters: AuthorIdentityCluster[];
  resolution: AuthorIdentityResolution;
  identities: IdentitiesApi;
  busy: boolean;
}) {
  if (clusters.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No people yet. Create one from an unresolved author mention.
      </p>
    );
  }

  return (
    <ScrollArea className="h-[52vh] pr-3">
      <ul className="space-y-2 py-2">
        {clusters.map((cluster) => (
          <PersonCard
            key={cluster.rootId}
            cluster={cluster}
            resolution={resolution}
            identities={identities}
            busy={busy}
          />
        ))}
      </ul>
    </ScrollArea>
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
  identities,
  busy,
}: {
  duplicates: ReturnType<typeof findAuthorIdentityDuplicates>;
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
    <ScrollArea className="h-[52vh] pr-3">
      <ul className="space-y-2 py-2">
        {duplicates.map((pair) => (
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
                onClick={() =>
                  void identities
                    .mergeIdentities(pair.firstRootId, pair.secondRootId)
                    .catch(() => {
                      /* reported by the hook */
                    })
                }
              >
                Merge into {pair.secondPreferredName}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={busy}
                onClick={() =>
                  void identities
                    .mergeIdentities(pair.secondRootId, pair.firstRootId)
                    .catch(() => {
                      /* reported by the hook */
                    })
                }
              >
                Merge into {pair.firstPreferredName}
              </Button>
            </div>
          </li>
        ))}
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
