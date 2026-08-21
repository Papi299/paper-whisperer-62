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
  buildAuthorIdentityResolution,
  findAuthorIdentityDuplicates,
  generateAuthorIdentityCandidates,
  type AuthorIdentityCluster,
  type AuthorIdentityPaper,
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

  const { dataset, isLoading, isUnavailable, isMutating } = identities;

  const resolution = useMemo(
    () => buildAuthorIdentityResolution(papers, dataset),
    [papers, dataset],
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
                identities={identities}
                busy={isMutating}
              />
            </TabsContent>

            <TabsContent value="people" className="min-h-0 flex-1">
              <PeopleList clusters={clusters} identities={identities} busy={isMutating} />
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
  identities,
  busy,
}: {
  mention: AuthorMentionRef;
  candidates: ReturnType<typeof generateAuthorIdentityCandidates>[number]["candidates"];
  identities: IdentitiesApi;
  busy: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState(mention.displayName);

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
    (rootId: string, reason: "same_orcid" | "same_normalized_name") => {
      void identities
        .linkMention({
          paperId: mention.paperId,
          authorIndex: mention.authorIndex,
          expectedAuthor: mention.rawName,
          identityId: rootId,
          resolutionBasis: reason === "same_orcid" ? "orcid_candidate" : "name_candidate",
        })
        .catch(() => {
          /* reported by the hook */
        });
    },
    [identities, mention],
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
                onClick={() => link(candidate.rootId, candidate.reason)}
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
      )}
    </li>
  );
}

function UnresolvedList({
  entries,
  identities,
  busy,
}: {
  entries: ReturnType<typeof generateAuthorIdentityCandidates>;
  identities: IdentitiesApi;
  busy: boolean;
}) {
  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Every author mention in the current papers has been resolved, or is a
        collective author that cannot be a person.
      </p>
    );
  }

  return (
    <ScrollArea className="h-[52vh] pr-3">
      <ul className="space-y-2 py-2">
        {entries.map((entry) => (
          <UnresolvedRow
            key={`${entry.mention.paperId}:${entry.mention.authorIndex}`}
            mention={entry.mention}
            candidates={entry.candidates}
            identities={identities}
            busy={busy}
          />
        ))}
      </ul>
    </ScrollArea>
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
function PersonCard({
  cluster,
  identities,
  busy,
}: {
  cluster: AuthorIdentityCluster;
  identities: IdentitiesApi;
  busy: boolean;
}) {
  const [name, setName] = useState(cluster.preferredName);
  const [alias, setAlias] = useState("");
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
      const index = order.indexOf(aliasId);
      const next = index >= 0 ? order[index + 1] : undefined;
      const previous = index > 0 ? order[index - 1] : undefined;

      void identities
        .removeAlias(aliasId)
        .then(() => {
          const target =
            (next && aliasRefs.current.get(next)) ??
            (previous && aliasRefs.current.get(previous)) ??
            aliasRefs.current.get(order[index]) ??
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
            {cluster.aliases.map((value) => (
              <Badge key={value} variant="secondary" className="text-xs pr-1">
                <span className="truncate max-w-[160px]">{value}</span>
                <button
                  ref={(node) => aliasRefs.current.set(value, node)}
                  onClick={() => removeAlias(value)}
                  aria-label={`Remove alias ${value}`}
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

      <div className="flex flex-wrap gap-2">
        {cluster.mergedMemberIds.map((memberId) => (
          <Button
            key={memberId}
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() =>
              void identities.unmergeIdentity(memberId).catch(() => {
                /* reported by the hook */
              })
            }
          >
            Undo one merge
          </Button>
        ))}
        {cluster.linkedMentions.length === 0 &&
          cluster.aliases.length === 0 &&
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
  identities,
  busy,
}: {
  clusters: AuthorIdentityCluster[];
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
