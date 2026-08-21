/**
 * User-scoped author identity resolution — the third and last layer of the
 * author objective, and the only one permitted to say that two authorship
 * mentions are the same person.
 *
 * The three layers, and why they are separate:
 *
 *   001A `authorNames.ts`      Are two author *strings* the same mention written
 *                              differently? A conservative typographic fold.
 *                              `Stuart M. Phillips` = `Stuart M Phillips`;
 *                              `S M Phillips` ≠ `Stuart M Phillips`.
 *   001B `authorProvenance.ts` What did the *source* state about this mention?
 *                              Given/family components, affiliations, a
 *                              checksum-valid ORCID. A matching ORCID is a value
 *                              two sources supplied, never a resolved person.
 *   001C this module           Has *this user* explicitly decided that one or
 *                              more mentions are the same person?
 *
 * THE RULE EVERYTHING HERE OBEYS
 * ─────────────────────────────────────────────────────────────────────────────
 * Paperlume may SUGGEST an identity relationship from deterministic evidence. It
 * must never silently ASSERT one.
 *
 * So this module computes two kinds of thing and keeps them rigorously apart:
 *
 *   * **Resolution** — what the user has already decided. Links and merge edges,
 *     read back and aggregated. This is fact, and Analytics groups by it.
 *   * **Candidates** — what the user *might* decide, and why. Suggestions with a
 *     stated reason, which change nothing until a Link or Merge button is
 *     pressed. Analytics never reads them.
 *
 * A candidate is not a weak resolution; it is a question. Two mentions carrying
 * the same ORCID stay two separate authors in every count and every chart until
 * a human says otherwise — that boundary is the feature.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ─────────────────────────────────────────────────────────────────────────────
 * No initials expansion, no first-name or middle-name inference, no surname
 * inversion, no Levenshtein/Jaro-Winkler/phonetic/transliteration/accent
 * folding, no affiliation, institution, coauthor-network or topic matching, no
 * email inference, no ORCID/Crossref/PubMed registry lookup, and no AI. Two
 * exact comparisons carry the whole feature: an exact valid ORCID, and an exact
 * 001A mention key. Anything looser would produce suggestions a user cannot
 * check, which is worse than producing none.
 *
 * There is no network call in this file and no I/O of any kind. Everything is a
 * pure function of rows the caller already read, so all of it is directly
 * testable and none of it can surprise a user at import time.
 *
 * COMPLEXITY
 * ─────────────────────────────────────────────────────────────────────────────
 * Near-linear throughout, via `Map`/`Set` inverted indexes keyed on the exact
 * comparison values. No pairwise scan over authors or identities exists here:
 * candidate pairs are emitted from the buckets that actually collide, so the
 * work is proportional to the answer rather than to the square of the input.
 */

import {
  authorMentionKey,
  authorSearchMatches,
  normalizeAuthorDisplay,
} from "./authorNames";
import type { AuthorProvenance } from "./authorProvenance";
import { normalizeOrcid } from "./orcid";

/* -------------------------------------------------------------------------
 * Stored shapes
 * ---------------------------------------------------------------------- */

/**
 * How the USER arrived at a link. Provenance for the decision, and deliberately
 * not a score: a person made this call, so it is right or wrong, not 0.87. The
 * set mirrors the database CHECK constraint exactly.
 */
export type AuthorResolutionBasis =
  | "created_from_mention"
  | "manual"
  | "orcid_candidate"
  | "name_candidate";

export interface AuthorIdentityRecord {
  id: string;
  preferred_name: string;
}

export interface AuthorIdentityAliasRecord {
  id: string;
  identity_id: string;
  alias: string;
}

export interface AuthorIdentityLinkRecord {
  id: string;
  identity_id: string;
  paper_id: string;
  author_index: number;
  author_name_snapshot: string;
  resolution_basis: AuthorResolutionBasis;
}

export interface AuthorIdentityMergeRecord {
  source_identity_id: string;
  target_identity_id: string;
}

/** Everything the identity subsystem stores for one user, as read back. */
export interface AuthorIdentityDataset {
  identities: readonly AuthorIdentityRecord[];
  aliases: readonly AuthorIdentityAliasRecord[];
  links: readonly AuthorIdentityLinkRecord[];
  merges: readonly AuthorIdentityMergeRecord[];
}

/** The subset of a paper this module needs. Nothing is mutated. */
export interface AuthorIdentityPaper {
  id: string;
  title: string;
  authors: readonly string[];
  author_provenance?: AuthorProvenance[] | null;
  year?: number | null;
  journal?: string | null;
}

/** An empty dataset — the state before any decision, and the fallback when the
 *  identity subsystem is not installed in this environment. */
export const EMPTY_AUTHOR_IDENTITY_DATASET: AuthorIdentityDataset = {
  identities: [],
  aliases: [],
  links: [],
  merges: [],
};

/* -------------------------------------------------------------------------
 * Merge-root resolution
 * ---------------------------------------------------------------------- */

/**
 * Maps every identity to its effective root by following outgoing merge edges.
 *
 * `A → B` and `B → C` puts A, B and C all under C. An identity with no outgoing
 * edge is its own root, which is the common case.
 *
 * Cycles cannot be stored — the database rejects them at write time, and
 * `source_identity_id` is a primary key so no identity has two outgoing edges —
 * but this is the one place where a corrupt graph would hang the UI rather than
 * report a problem. So the walk is bounded and a suspected cycle degrades to
 * "every identity in the loop is its own root": conservative, non-destructive,
 * and it keeps the rest of the screen working. Silently returning a wrong root
 * would instead merge people who were never merged.
 *
 * Linear in the number of edges: each walk memoizes every node it passes, so no
 * chain is ever traversed twice however the input is ordered.
 */
export function resolveAuthorIdentityRoots(
  merges: readonly AuthorIdentityMergeRecord[],
): Map<string, string> {
  const outgoing = new Map<string, string>();
  for (const edge of merges) {
    // First edge wins if the input somehow carries two for one source; the
    // database's primary key means it cannot, and picking deterministically is
    // better than picking last.
    if (!outgoing.has(edge.source_identity_id)) {
      outgoing.set(edge.source_identity_id, edge.target_identity_id);
    }
  }

  const roots = new Map<string, string>();

  for (const start of outgoing.keys()) {
    if (roots.has(start)) continue;

    // The nodes visited on this walk, in order, so the memo can be filled in
    // one pass once the root is known.
    const path: string[] = [];
    const onPath = new Set<string>();
    let current = start;
    let root: string | null = null;

    for (;;) {
      if (roots.has(current)) {
        root = roots.get(current)!;
        break;
      }
      if (onPath.has(current)) {
        // A cycle. Nothing may be grouped on the strength of it.
        root = null;
        break;
      }
      path.push(current);
      onPath.add(current);

      const next = outgoing.get(current);
      if (next === undefined) {
        root = current;
        break;
      }
      current = next;
    }

    if (root === null) {
      for (const node of path) roots.set(node, node);
    } else {
      for (const node of path) roots.set(node, root);
    }
  }

  return roots;
}

/* -------------------------------------------------------------------------
 * Mentions
 * ---------------------------------------------------------------------- */

/** One authorship position on one paper, with the evidence around it. */
export interface AuthorMentionRef {
  paperId: string;
  paperTitle: string;
  year: number | null;
  journal: string | null;
  /** 0-based, matching `papers.authors` and `author_identity_links.author_index`. */
  authorIndex: number;
  /** The stored source spelling, display-normalized. Never a canonical person name. */
  displayName: string;
  /** Exact source spelling, as stored. What a link's expected-author guard compares. */
  rawName: string;
  /** 001A comparison key for this mention. Internal; never shown to the user. */
  mentionKey: string;
  /** What the source stated this author *is*, when it stated anything. */
  provenanceKind: "personal" | "collective" | "unknown" | null;
  /** Stable source/format identifier, when provenance exists. */
  provenanceSource: string | null;
  /** Checksum-valid ORCID from the CURRENT provenance for this position, else null. */
  orcid: string | null;
  /** The provider's own assertion flag. Source metadata, never our verification. */
  orcidAuthenticated: boolean | null;
  /** Read-only context. Deliberately never used for matching. */
  affiliations: readonly string[];
}

/** Composite key for one authorship position. */
export function mentionSlotKey(paperId: string, authorIndex: number): string {
  return `${paperId}:${authorIndex}`;
}

/**
 * Every authorship position across the given papers, in paper then index order.
 *
 * Blank slots are dropped: an empty author string is not a mention and cannot be
 * resolved, counted or suggested.
 *
 * Provenance is read only where 001B guarantees it describes this position — a
 * non-null array whose length equals `authors`. A misaligned array would make
 * entry *i* describe a different human, so it is ignored wholesale rather than
 * indexed into, which is the same rule the storage layer applies.
 */
export function collectAuthorMentions(
  papers: readonly AuthorIdentityPaper[],
): AuthorMentionRef[] {
  const mentions: AuthorMentionRef[] = [];

  for (const paper of papers) {
    const authors = paper.authors ?? [];
    const provenance =
      Array.isArray(paper.author_provenance) &&
      paper.author_provenance.length === authors.length
        ? paper.author_provenance
        : null;

    for (let index = 0; index < authors.length; index += 1) {
      const rawName = authors[index];
      const displayName = normalizeAuthorDisplay(rawName);
      if (!displayName) continue;

      const entry = provenance ? provenance[index] : null;

      mentions.push({
        paperId: paper.id,
        paperTitle: paper.title,
        year: paper.year ?? null,
        journal: paper.journal ?? null,
        authorIndex: index,
        displayName,
        rawName,
        mentionKey: authorMentionKey(displayName),
        provenanceKind: entry ? entry.kind : null,
        provenanceSource: entry ? entry.source : null,
        // Re-derived rather than trusted: the column CHECK already requires a
        // canonical value, and re-validating here means a hand-written row or a
        // future relaxation cannot introduce a malformed iD into matching.
        orcid: entry ? normalizeOrcid(entry.orcid) : null,
        orcidAuthenticated: entry ? entry.orcid_authenticated : null,
        affiliations: entry ? entry.affiliations : [],
      });
    }
  }

  return mentions;
}

/**
 * Whether a mention may become a personal identity link at all.
 *
 * Only an explicitly `collective` provenance entry is refused — a consortium,
 * study group, committee or named collaboration that the PROVIDER marked as
 * such. It is not a person, and no user intent makes it one.
 *
 * `unknown` and absent provenance are permitted. The source never established
 * what those authors are, which describes most of a historical library; refusing
 * them would make the feature useless on real data. They are simply never
 * resolved automatically.
 *
 * Collective status is never inferred from the text. A free-form string
 * containing "Consortium" is `unknown` and stays resolvable, because guessing
 * from wording is exactly the inference 001B declined to make.
 */
export function isResolvableMention(mention: AuthorMentionRef): boolean {
  return mention.provenanceKind !== "collective";
}

/* -------------------------------------------------------------------------
 * Clusters
 * ---------------------------------------------------------------------- */

/** One manual alias, as displayed, with the row it came from. */
export interface AuthorIdentityClusterAlias {
  id: string;
  alias: string;
}

/**
 * One identity that has been merged into this cluster, with enough context to
 * tell it apart from the others.
 *
 * A cluster can absorb several identities, and undoing a merge reverses ONE
 * outgoing edge — so a UI offering "Undo one merge" three times over is asking
 * the user to pick blind. What distinguishes the choices has to be real
 * evidence, never a UUID: the member's own name, the identity it merges
 * directly into, and — when two merged members happen to share a preferred
 * name, which nothing prevents — the aliases, linked spellings, ORCIDs and
 * linked-mention count that belong to that member alone.
 *
 * All of it is the user's own recorded data. Nothing here is inferred.
 */
export interface AuthorIdentityMergedMember {
  id: string;
  preferredName: string;
  /** The identity this member's own outgoing edge points at. */
  targetId: string;
  /** That target's `preferred_name`. `A → B → C` reads as A into B, not A into C. */
  targetPreferredName: string;
  /** This member's own manual aliases, display-normalized. */
  aliases: readonly string[];
  /** Distinct spellings of the mentions linked to THIS member. */
  linkedSpellings: readonly string[];
  /** Distinct valid ORCIDs on the mentions linked to THIS member. */
  orcids: readonly string[];
  /** How many mentions are linked to this member across the evidence papers. */
  linkedMentionCount: number;
}

/** One effective person: a root identity plus everything merged into it. */
export interface AuthorIdentityCluster {
  /** The terminal identity of the merge chain. The stable key for this person. */
  rootId: string;
  /** The root's `preferred_name`. The only label ever shown for the cluster. */
  preferredName: string;
  /** Root first, then every identity merged into it, in dataset order. */
  memberIds: readonly string[];
  /** Identities merged into the root, i.e. `memberIds` minus the root. */
  mergedMemberIds: readonly string[];
  /**
   * The same members, each carrying the context needed to identify the exact
   * merge edge it owns. Same order as `mergedMemberIds`.
   */
  mergedMembers: readonly AuthorIdentityMergedMember[];
  /**
   * Manual aliases across the whole cluster, display-normalized and deduplicated
   * by text, each keeping the row id that identifies it.
   *
   * The id is not decoration: removing an alias deletes a row, so the UI needs
   * the identifier and not just the words. Deduplication keeps the first row for
   * a given text, so removing it removes something the user can see.
   */
  aliases: readonly AuthorIdentityClusterAlias[];
  /** Distinct display spellings of the mentions currently linked to the cluster. */
  linkedSpellings: readonly string[];
  /** Distinct checksum-valid ORCIDs on the cluster's currently linked mentions. */
  orcids: readonly string[];
  /**
   * True when the cluster's linked mentions carry more than one distinct ORCID.
   *
   * Reported, never resolved. Two valid iDs under one person means either a
   * source is wrong or the user merged two people, and this application cannot
   * know which — so it says so and changes nothing.
   */
  hasOrcidConflict: boolean;
  /** The linked mentions themselves, for the identity detail view. */
  linkedMentions: readonly AuthorMentionRef[];
  /** Distinct papers contributing at least one linked mention. */
  paperIds: ReadonlySet<string>;
  /**
   * How many link ROWS the dataset holds for this cluster, whether or not the
   * paper behind each one is present in the evidence set.
   *
   * `linkedMentions` answers "what can I show you"; this answers "is this person
   * empty". They differ whenever evidence is incomplete, and only this one may
   * gate a destructive action: `delete_empty_author_identity` counts rows, so a
   * UI that counted resolvable mentions instead would offer Delete for a person
   * the database will then refuse to delete.
   */
  linkRowCount: number;
  /** Alias rows across the cluster, before deduplication by text. */
  aliasRowCount: number;
}

/* -------------------------------------------------------------------------
 * The resolution index
 * ---------------------------------------------------------------------- */

/**
 * Everything derived from one user's identity decisions, in the form the UI and
 * Analytics read.
 *
 * Built once per (papers, dataset) pair. Every lookup on it is O(1); nothing is
 * recomputed per render and nothing here scans pairwise.
 */
export interface AuthorIdentityResolution {
  /** Whether the identity subsystem produced data at all. See `identityUnavailable`. */
  available: boolean;
  /** Effective person clusters, keyed by root identity id. */
  clusters: ReadonlyMap<string, AuthorIdentityCluster>;
  /** Identity id → effective root id, for every identity in the dataset. */
  rootOf: ReadonlyMap<string, string>;
  /** `paperId:index` → the link resolving that position, if the user made one. */
  linkBySlot: ReadonlyMap<string, AuthorIdentityLinkRecord>;
  /** Every authorship position across the papers, resolved or not. */
  mentions: readonly AuthorMentionRef[];
  /** Positions with no link the user could still resolve (collectives excluded). */
  unresolvedMentions: readonly AuthorMentionRef[];
  /**
   * Links whose `author_name_snapshot` no longer matches the author text at
   * their position, or whose position no longer exists on a paper that IS
   * present in the evidence set.
   *
   * The database makes this unreachable through the application: a trigger
   * clears every link on a paper the moment `authors` changes. These are what
   * survives that guarantee failing — a privileged write, a restored backup, a
   * future migration bug — and they are reported rather than obeyed, because a
   * link that no longer describes its mention would otherwise resolve the wrong
   * author to a person and be indistinguishable from a decision the user made.
   */
  staleLinks: readonly AuthorIdentityLinkRecord[];
  /**
   * `paperId:index` for every stale link at a position that still exists.
   *
   * The mention is offered as unresolved, so the user can put it right; acting
   * on it has to replace the surviving row rather than insert beside it, and
   * this is how the UI knows to ask for that.
   */
  staleLinkSlots: ReadonlySet<string>;
}

/** Root id for an identity, falling back to the identity itself. */
function rootFor(rootOf: ReadonlyMap<string, string>, identityId: string): string {
  return rootOf.get(identityId) ?? identityId;
}

/**
 * Aggregate one user's identity decisions.
 *
 * TWO PAPER COLLECTIONS, AND WHY THEY ARE NOT THE SAME ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * `papers` is the CURRENT VIEW — whatever the Analytics filter is showing. It
 * decides which mentions exist to be counted, charted and offered for
 * resolution. Narrowing a filter should narrow all of that, and it does.
 *
 * `evidencePapers` is USER-WIDE — every paper the identity graph actually links
 * to, fetched independently of any filter. It decides what an existing person
 * *is*: which spellings the user accepted for them, which ORCIDs their linked
 * papers carry, whether they have anything attached at all.
 *
 * Collapsing the two, as the first implementation did, makes a filter redefine
 * the identity graph. Filter to one paper and a person's ORCID evidence
 * vanishes, so the exact-ORCID candidate that person exists to produce is never
 * offered; their linked spellings vanish, so manual search cannot find them;
 * two people stop looking like duplicates because the paper that made them look
 * alike is out of view; and an identity with links elsewhere in the library
 * renders as empty, offering a Delete the database will then correctly refuse.
 * None of those are filtering — they are the user's durable decisions changing
 * shape because of a dropdown.
 *
 * `evidencePapers` defaults to `papers`, which is exactly right for a caller
 * that has only one collection (every pure test, and any surface where the view
 * IS the library).
 *
 * `dataset` is `null` when the identity subsystem is not installed in this
 * environment — a Preview running against a database that predates the 001C
 * migration. That produces an `available: false` resolution in which every
 * mention is unresolved, which is precisely 001A behaviour, so every caller
 * degrades to the previous product rather than to an error state.
 *
 * LINKS ARE VALIDATED BEFORE THEY ARE BELIEVED
 * ─────────────────────────────────────────────────────────────────────────────
 * A link is used only when all three hold: its paper is present, its author
 * index still exists, and the author text at that index is byte-for-byte the
 * `author_name_snapshot` recorded when the user decided. The database already
 * guarantees the third by clearing every link on a paper whenever `authors`
 * changes — this is the read-side twin of that trigger, and it is what makes the
 * claim "a stale row can never resolve the wrong author to a person" true of the
 * application and not only of the schema. A link that fails the check is
 * reported through `staleLinks` and obeyed nowhere.
 */
export function buildAuthorIdentityResolution(
  papers: readonly AuthorIdentityPaper[],
  dataset: AuthorIdentityDataset | null,
  evidencePapers?: readonly AuthorIdentityPaper[],
): AuthorIdentityResolution {
  const mentions = collectAuthorMentions(papers);
  const viewMentionBySlot = new Map<string, AuthorMentionRef>();
  const viewPaperIds = new Set<string>();
  for (const paper of papers) viewPaperIds.add(paper.id);
  for (const mention of mentions) {
    viewMentionBySlot.set(mentionSlotKey(mention.paperId, mention.authorIndex), mention);
  }

  if (!dataset) {
    return {
      available: false,
      clusters: new Map(),
      rootOf: new Map(),
      linkBySlot: new Map(),
      mentions,
      unresolvedMentions: mentions.filter(isResolvableMention),
      staleLinks: [],
      staleLinkSlots: new Set(),
    };
  }

  /**
   * Slot lookup over the union of both collections, view first.
   *
   * A paper in both describes the same row, so the duplicate is dropped rather
   * than merged: preferring the view copy keeps every mention object identical
   * to the one the charts were built from, which matters because consumers
   * compare them by reference.
   */
  let evidenceMentionBySlot = viewMentionBySlot;
  let evidencePaperIds = viewPaperIds;
  if (evidencePapers && evidencePapers !== papers) {
    evidenceMentionBySlot = new Map(viewMentionBySlot);
    evidencePaperIds = new Set(viewPaperIds);
    const extra = evidencePapers.filter((paper) => !viewPaperIds.has(paper.id));
    for (const paper of extra) evidencePaperIds.add(paper.id);
    for (const mention of collectAuthorMentions(extra)) {
      evidenceMentionBySlot.set(mentionSlotKey(mention.paperId, mention.authorIndex), mention);
    }
  }

  const rootOf = resolveAuthorIdentityRoots(dataset.merges);
  const identityById = new Map(dataset.identities.map((i) => [i.id, i]));

  // Root → members. Built from the identity list rather than from the edges so
  // an unmerged identity is still its own single-member cluster.
  const membersByRoot = new Map<string, string[]>();
  for (const identity of dataset.identities) {
    const root = rootFor(rootOf, identity.id);
    const members = membersByRoot.get(root);
    if (members) members.push(identity.id);
    else membersByRoot.set(root, [identity.id]);
  }

  // Direct outgoing edge per identity, for naming the exact merge a member owns.
  const mergeTargetById = new Map<string, string>();
  for (const edge of dataset.merges) {
    if (!mergeTargetById.has(edge.source_identity_id)) {
      mergeTargetById.set(edge.source_identity_id, edge.target_identity_id);
    }
  }

  const aliasesByRoot = new Map<string, AuthorIdentityClusterAlias[]>();
  const aliasRowsByIdentity = new Map<string, string[]>();
  const aliasRowCountByRoot = new Map<string, number>();
  for (const alias of dataset.aliases) {
    // An alias on an identity the dataset does not contain cannot be attributed
    // to a cluster. The composite foreign key makes that unreachable; ignoring
    // it is the conservative response if it ever happens anyway.
    if (!identityById.has(alias.identity_id)) continue;
    const root = rootFor(rootOf, alias.identity_id);
    aliasRowCountByRoot.set(root, (aliasRowCountByRoot.get(root) ?? 0) + 1);
    const display = normalizeAuthorDisplay(alias.alias);
    if (!display) continue;
    const entry: AuthorIdentityClusterAlias = { id: alias.id, alias: display };
    const list = aliasesByRoot.get(root);
    if (list) list.push(entry);
    else aliasesByRoot.set(root, [entry]);

    const own = aliasRowsByIdentity.get(alias.identity_id);
    if (own) own.push(display);
    else aliasRowsByIdentity.set(alias.identity_id, [display]);
  }

  const linkBySlot = new Map<string, AuthorIdentityLinkRecord>();
  const linkedMentionsByRoot = new Map<string, AuthorMentionRef[]>();
  const linkedMentionsByIdentity = new Map<string, AuthorMentionRef[]>();
  const linkRowCountByRoot = new Map<string, number>();
  const staleLinks: AuthorIdentityLinkRecord[] = [];
  const staleLinkSlots = new Set<string>();

  for (const link of dataset.links) {
    if (!identityById.has(link.identity_id)) continue;

    const root = rootFor(rootOf, link.identity_id);
    // Counted from the row, not from the mention: this is what decides whether
    // the person is empty, and the database counts rows too.
    linkRowCountByRoot.set(root, (linkRowCountByRoot.get(root) ?? 0) + 1);

    const slot = mentionSlotKey(link.paper_id, link.author_index);
    const mention = evidenceMentionBySlot.get(slot);

    if (!mention) {
      // A paper we do not have says nothing either way — it is simply not in
      // evidence. A paper we DO have, missing the position the link names, is a
      // genuine inconsistency and is reported as one.
      if (evidencePaperIds.has(link.paper_id)) staleLinks.push(link);
      continue;
    }

    // Byte-for-byte, matching the RPC's own expected-author guard. The 001A fold
    // is deliberately not used: a punctuation-only edit still moved the text out
    // from under the decision, and re-offering it is the conservative response.
    if (mention.rawName !== link.author_name_snapshot) {
      staleLinks.push(link);
      staleLinkSlots.add(slot);
      continue;
    }

    // The view's own resolution map stays view-scoped: it is what decides which
    // mentions count as resolved on screen, and an out-of-view paper has no
    // mention on screen to resolve.
    if (viewMentionBySlot.has(slot)) linkBySlot.set(slot, link);

    const list = linkedMentionsByRoot.get(root);
    if (list) list.push(mention);
    else linkedMentionsByRoot.set(root, [mention]);

    const own = linkedMentionsByIdentity.get(link.identity_id);
    if (own) own.push(mention);
    else linkedMentionsByIdentity.set(link.identity_id, [mention]);
  }

  const clusters = new Map<string, AuthorIdentityCluster>();

  for (const [root, members] of membersByRoot) {
    const rootRecord = identityById.get(root);
    // A root that is not in the identity list means the dataset is internally
    // inconsistent; skip rather than invent a person with no name.
    if (!rootRecord) continue;

    // Root first so `memberIds[0]` is always the identity whose name is shown.
    const ordered = [root, ...members.filter((id) => id !== root)];
    const linkedMentions = linkedMentionsByRoot.get(root) ?? [];

    const spellings = new Set<string>();
    const orcids = new Set<string>();
    const paperIds = new Set<string>();
    for (const mention of linkedMentions) {
      spellings.add(mention.displayName);
      paperIds.add(mention.paperId);
      if (mention.orcid) orcids.add(mention.orcid);
    }

    // Deduplicated by TEXT, keeping the first row that produced it: two rows
    // spelling the same alias are one name to the user, and removing the one
    // they can see must remove a row that exists.
    const seenAliasText = new Set<string>();
    const aliases: AuthorIdentityClusterAlias[] = [];
    for (const entry of aliasesByRoot.get(root) ?? []) {
      if (seenAliasText.has(entry.alias)) continue;
      seenAliasText.add(entry.alias);
      aliases.push(entry);
    }

    const mergedMemberIds = ordered.slice(1);
    const mergedMembers: AuthorIdentityMergedMember[] = mergedMemberIds.map((memberId) => {
      const own = linkedMentionsByIdentity.get(memberId) ?? [];
      const targetId = mergeTargetById.get(memberId) ?? root;
      return {
        id: memberId,
        preferredName: identityById.get(memberId)?.preferred_name ?? "",
        targetId,
        targetPreferredName: identityById.get(targetId)?.preferred_name ?? "",
        aliases: [...new Set(aliasRowsByIdentity.get(memberId) ?? [])],
        linkedSpellings: [...new Set(own.map((mention) => mention.displayName))],
        orcids: [
          ...new Set(
            own
              .map((mention) => mention.orcid)
              .filter((orcid): orcid is string => orcid !== null),
          ),
        ],
        linkedMentionCount: own.length,
      };
    });

    clusters.set(root, {
      rootId: root,
      preferredName: rootRecord.preferred_name,
      memberIds: ordered,
      mergedMemberIds,
      mergedMembers,
      aliases,
      linkedSpellings: [...spellings],
      orcids: [...orcids],
      hasOrcidConflict: orcids.size > 1,
      linkedMentions,
      paperIds,
      linkRowCount: linkRowCountByRoot.get(root) ?? 0,
      aliasRowCount: aliasRowCountByRoot.get(root) ?? 0,
    });
  }

  const unresolvedMentions = mentions.filter(
    (mention) =>
      isResolvableMention(mention) &&
      !linkBySlot.has(mentionSlotKey(mention.paperId, mention.authorIndex)),
  );

  return {
    available: true,
    clusters,
    rootOf,
    linkBySlot,
    mentions,
    unresolvedMentions,
    staleLinks,
    staleLinkSlots,
  };
}

/* -------------------------------------------------------------------------
 * Candidate generation — suggestion only, never applied
 * ---------------------------------------------------------------------- */

/**
 * Why a candidate is being offered. The UI turns this into factual wording —
 * "Same ORCID", "Same normalized name" — and never into "verified",
 * "confirmed" or "guaranteed match".
 */
export type AuthorCandidateReason = "same_orcid" | "same_normalized_name";

export interface AuthorIdentityCandidate {
  /** The cluster being suggested. Its label is `preferredName`. */
  rootId: string;
  preferredName: string;
  reason: AuthorCandidateReason;
  /** The shared iD, for `same_orcid` only. Shown so the user can check it. */
  orcid: string | null;
  /**
   * True when more than one cluster matched this mention on the same evidence.
   * The UI must present the ambiguity rather than pick one, and the same
   * situation feeds the duplicate-identity review.
   */
  ambiguous: boolean;
}

/** One unresolved mention together with whatever the evidence suggests. */
export interface AuthorMentionCandidates {
  mention: AuthorMentionRef;
  /** Strongest first: ORCID matches, then name matches. Possibly empty. */
  candidates: readonly AuthorIdentityCandidate[];
}

/** Inverted indexes over the clusters, so candidate lookup is a Map hit. */
interface ClusterIndexes {
  /** Valid ORCID → roots whose linked mentions currently carry it. */
  rootsByOrcid: Map<string, Set<string>>;
  /** 001A key → roots whose name evidence contains that exact key. */
  rootsByNameKey: Map<string, Set<string>>;
}

/**
 * Build the inverted indexes.
 *
 * Name evidence for a cluster is the union of three things, all compared through
 * the unmodified 001A key so the fold stays authoritative and there is exactly
 * one definition of textual equivalence in the product:
 *
 *   * the root's `preferred_name` — what the user called this person;
 *   * every manual alias in the cluster — other names the user asserted;
 *   * every currently linked mention spelling in the cluster — names the user
 *     already accepted for this person by linking them.
 *
 * The third is what makes the feature converge: linking `S M Phillips` to an
 * identity teaches it that spelling, so a *third* paper spelling it the same way
 * gets a name candidate that it could not have got from the preferred name
 * alone. That is learning from an explicit decision, not inference.
 */
function buildClusterIndexes(
  clusters: ReadonlyMap<string, AuthorIdentityCluster>,
): ClusterIndexes {
  const rootsByOrcid = new Map<string, Set<string>>();
  const rootsByNameKey = new Map<string, Set<string>>();

  const add = (index: Map<string, Set<string>>, key: string, root: string) => {
    if (!key) return;
    const set = index.get(key);
    if (set) set.add(root);
    else index.set(key, new Set([root]));
  };

  for (const cluster of clusters.values()) {
    for (const orcid of cluster.orcids) add(rootsByOrcid, orcid, cluster.rootId);

    // The same approved-evidence terms the manual chooser searches, folded
    // through 001A. One definition, so what the algorithm suggests and what the
    // user can find can never drift apart.
    for (const term of authorIdentitySearchTerms(cluster)) {
      add(rootsByNameKey, authorMentionKey(term), cluster.rootId);
    }
  }

  return { rootsByOrcid, rootsByNameKey };
}

/**
 * Deterministic candidates for every unresolved mention.
 *
 * Two sources of evidence, in strength order.
 *
 * **1. Exact valid ORCID.** The mention's CURRENT provenance carries a
 * checksum-valid iD, and some cluster's currently linked mentions carry the same
 * one. This is the strongest deterministic signal available without inventing
 * anything — but it is still a suggestion: the user presses Link. If several
 * clusters carry the iD, all of them are returned and flagged `ambiguous`;
 * choosing one automatically would be exactly the silent assertion this feature
 * refuses, and the situation is also surfaced as a possible duplicate identity.
 *
 * **2. Exact 001A mention key.** The mention is formatting-equivalent to the
 * cluster's name evidence. Weaker, and honestly so: `Stuart M. Phillips` and
 * `Stuart M Phillips` are one spelling written twice, but two different people
 * genuinely share a name.
 *
 * **The suppression rule that makes (2) safe.** If the mention has a valid ORCID
 * and the cluster has ORCID evidence of its own but none of it matches, the name
 * candidate for that cluster is withheld. Structured identifier evidence
 * contradicts the name similarity, and offering a one-click Link there would
 * invite the user to merge two people who are provably distinct. It fails
 * conservatively rather than helpfully: the identity stays manually searchable,
 * so a user who deliberately wants to override their own data still can.
 *
 * A cluster already offered on ORCID evidence is never also offered on name
 * evidence — one candidate per cluster, carrying the strongest reason.
 *
 * Near-linear: one Map lookup per unresolved mention, and the work per mention is
 * proportional to the number of clusters that actually match it.
 */
export function generateAuthorIdentityCandidates(
  resolution: AuthorIdentityResolution,
): AuthorMentionCandidates[] {
  if (!resolution.available || resolution.clusters.size === 0) {
    return resolution.unresolvedMentions.map((mention) => ({ mention, candidates: [] }));
  }

  const { rootsByOrcid, rootsByNameKey } = buildClusterIndexes(resolution.clusters);
  const results: AuthorMentionCandidates[] = [];

  for (const mention of resolution.unresolvedMentions) {
    const candidates: AuthorIdentityCandidate[] = [];
    const offered = new Set<string>();

    if (mention.orcid) {
      const roots = rootsByOrcid.get(mention.orcid);
      if (roots && roots.size > 0) {
        const ambiguous = roots.size > 1;
        for (const rootId of roots) {
          const cluster = resolution.clusters.get(rootId);
          if (!cluster) continue;
          offered.add(rootId);
          candidates.push({
            rootId,
            preferredName: cluster.preferredName,
            reason: "same_orcid",
            orcid: mention.orcid,
            ambiguous,
          });
        }
      }
    }

    const nameRoots = rootsByNameKey.get(mention.mentionKey);
    if (nameRoots && nameRoots.size > 0) {
      const eligible: string[] = [];
      for (const rootId of nameRoots) {
        if (offered.has(rootId)) continue;
        const cluster = resolution.clusters.get(rootId);
        if (!cluster) continue;

        // Contradictory structured evidence suppresses the weak signal.
        if (
          mention.orcid &&
          cluster.orcids.length > 0 &&
          !cluster.orcids.includes(mention.orcid)
        ) {
          continue;
        }
        eligible.push(rootId);
      }

      const ambiguous = eligible.length > 1;
      for (const rootId of eligible) {
        const cluster = resolution.clusters.get(rootId)!;
        candidates.push({
          rootId,
          preferredName: cluster.preferredName,
          reason: "same_normalized_name",
          orcid: null,
          ambiguous,
        });
      }
    }

    results.push({ mention, candidates });
  }

  return results;
}

/* -------------------------------------------------------------------------
 * Possible duplicate identities
 * ---------------------------------------------------------------------- */

export interface AuthorIdentityDuplicatePair {
  /** The two clusters, ordered by root id so a pair has one representation. */
  firstRootId: string;
  secondRootId: string;
  firstPreferredName: string;
  secondPreferredName: string;
  reason: AuthorCandidateReason;
  /** The shared iD, for `same_orcid` only. */
  orcid: string | null;
}

/**
 * Clusters that might be the same person, for the user to review.
 *
 * Strong signal: two clusters whose linked mentions carry the same valid ORCID.
 * Weak signal: two clusters sharing an exact 001A name key.
 *
 * The weak signal is suppressed when both clusters have non-empty ORCID evidence
 * and the two sets are disjoint — identifiers the sources supplied say these are
 * different people, and a same-name suggestion would argue against the better
 * evidence. Where one cluster has no ORCID at all there is nothing to contradict,
 * so the suggestion stands.
 *
 * Pairs are deduplicated by ordered root ids and keep the strongest reason, so
 * two clusters sharing both an ORCID and a name appear once, as an ORCID match.
 *
 * Near-linear in practice: pairs are emitted only from index buckets that
 * actually collide, never from an all-pairs scan. A bucket of size k costs
 * k²/2 — but k is the number of clusters that genuinely share one exact iD or one
 * exact name key, which is the answer set itself, and is 1 for almost every
 * bucket. Nothing here is proportional to the square of the identity count.
 */
export function findAuthorIdentityDuplicates(
  resolution: AuthorIdentityResolution,
): AuthorIdentityDuplicatePair[] {
  if (!resolution.available || resolution.clusters.size < 2) return [];

  const { rootsByOrcid, rootsByNameKey } = buildClusterIndexes(resolution.clusters);
  const pairs = new Map<string, AuthorIdentityDuplicatePair>();

  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const record = (a: string, b: string, reason: AuthorCandidateReason, orcid: string | null) => {
    if (a === b) return;
    const [first, second] = a < b ? [a, b] : [b, a];
    const key = pairKey(a, b);
    const existing = pairs.get(key);
    // An ORCID match always wins: it is the stronger statement about the same
    // two clusters, and reporting the weaker one instead would understate it.
    if (existing && !(reason === "same_orcid" && existing.reason !== "same_orcid")) return;

    const firstCluster = resolution.clusters.get(first);
    const secondCluster = resolution.clusters.get(second);
    if (!firstCluster || !secondCluster) return;

    pairs.set(key, {
      firstRootId: first,
      secondRootId: second,
      firstPreferredName: firstCluster.preferredName,
      secondPreferredName: secondCluster.preferredName,
      reason,
      orcid,
    });
  };

  for (const [orcid, roots] of rootsByOrcid) {
    if (roots.size < 2) continue;
    const list = [...roots];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) record(list[i], list[j], "same_orcid", orcid);
    }
  }

  for (const roots of rootsByNameKey.values()) {
    if (roots.size < 2) continue;
    const list = [...roots];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = resolution.clusters.get(list[i]);
        const b = resolution.clusters.get(list[j]);
        if (!a || !b) continue;

        // Non-empty, disjoint identifier evidence contradicts the name match.
        if (a.orcids.length > 0 && b.orcids.length > 0) {
          const shared = a.orcids.some((orcid) => b.orcids.includes(orcid));
          if (!shared) continue;
        }
        record(list[i], list[j], "same_normalized_name", null);
      }
    }
  }

  // Stable output so the review list does not reshuffle between renders.
  return [...pairs.values()].sort(
    (a, b) =>
      a.firstRootId.localeCompare(b.firstRootId) ||
      a.secondRootId.localeCompare(b.secondRootId),
  );
}

/* -------------------------------------------------------------------------
 * Manual selection — the user overriding the algorithm, on purpose
 * ---------------------------------------------------------------------- */

/**
 * Everything a cluster is findable by when the USER is doing the looking.
 *
 * Deliberately the same three sources the automatic candidate index uses — the
 * preferred name, the manual aliases, every linked source spelling — plus the
 * cluster's ORCID evidence, which a user can legitimately paste but which the
 * automatic path must never match loosely.
 *
 * Every term is something the user already approved or a source already stated.
 * Nothing is derived, expanded, transliterated or scored.
 */
export function authorIdentitySearchTerms(cluster: AuthorIdentityCluster): string[] {
  return [
    ...new Set([
      cluster.preferredName,
      ...cluster.aliases.map((entry) => entry.alias),
      ...cluster.linkedSpellings,
    ]),
  ];
}

/**
 * Clusters matching a manual search, for the user to choose from.
 *
 * THIS IS NOT CANDIDATE GENERATION, and the distinction is the point of the
 * whole surface. `generateAuthorIdentityCandidates` answers "what does the
 * evidence suggest?" and is deliberately, sometimes frustratingly, conservative
 * — it withholds a name match when ORCID evidence contradicts it, precisely so
 * a one-click Link never proposes joining two provably different people.
 *
 * That conservatism is advice. It is not permission. A user looking at their own
 * library may know that one of those ORCIDs is simply wrong, and they must be
 * able to say so. So this function applies no suppression at all: a cluster
 * whose ORCID evidence contradicts the mention still appears, because hiding it
 * would turn a suggestion engine into an authorization policy over which people
 * the user is allowed to pick. The contradiction is surfaced at confirmation
 * time instead — see `authorIdentityOrcidConflict`.
 *
 * An empty query returns everything, in preferred-name order, so the chooser
 * opens as a browsable list rather than a blank prompt. Matching itself is 001A's
 * unchanged `authorSearchMatches`, per term, so a query cannot straddle two
 * terms — and a bare ORCID is matched exactly, since that is the only way a
 * pasted iD is ever a search.
 */
export function searchAuthorIdentityClusters(
  resolution: AuthorIdentityResolution,
  search: string,
  options: { excludeRootIds?: readonly string[] } = {},
): AuthorIdentityCluster[] {
  const excluded = new Set(options.excludeRootIds ?? []);
  const query = search.trim();
  const orcidQuery = normalizeOrcid(query);

  const matches = [...resolution.clusters.values()].filter((cluster) => {
    if (excluded.has(cluster.rootId)) return false;
    if (!query) return true;
    if (orcidQuery && cluster.orcids.includes(orcidQuery)) return true;
    return authorIdentitySearchTerms(cluster).some((term) =>
      authorSearchMatches(term, query),
    );
  });

  return matches.sort(
    (a, b) => a.preferredName.localeCompare(b.preferredName) || a.rootId.localeCompare(b.rootId),
  );
}

/**
 * The ORCIDs a cluster carries that contradict a given iD, or `[]` for none.
 *
 * Non-empty means: this mention states one iD, the person's linked papers state
 * others, and no linked paper states this one. That is the exact condition that
 * suppresses an automatic name candidate — reported here so a manual override
 * can show the user what they are overriding, in their own data, before they
 * commit to it.
 *
 * Neither value is called wrong. The application does not know which it is, and
 * saying so would be an assertion it has no basis for.
 */
export function authorIdentityOrcidConflict(
  orcid: string | null,
  cluster: AuthorIdentityCluster,
): string[] {
  if (!orcid || cluster.orcids.length === 0) return [];
  if (cluster.orcids.includes(orcid)) return [];
  return [...cluster.orcids];
}

/**
 * Whether two clusters carry non-empty, entirely disjoint ORCID evidence.
 *
 * The merge-time counterpart of the rule above, and the reason the duplicate
 * detector stays quiet about such a pair. A manual merge may still proceed; the
 * user is told first.
 */
export function authorIdentityClustersConflict(
  a: AuthorIdentityCluster,
  b: AuthorIdentityCluster,
): boolean {
  if (a.orcids.length === 0 || b.orcids.length === 0) return false;
  return !a.orcids.some((orcid) => b.orcids.includes(orcid));
}

/* -------------------------------------------------------------------------
 * Analytics author entities
 * ---------------------------------------------------------------------- */

/**
 * What Analytics counts as "one author" after 001C.
 *
 * The model is deliberately mixed, and honest about being mixed:
 *
 *   * a mention the user has resolved counts as the PERSON it resolves to,
 *     collapsing every spelling they linked into one entity;
 *   * a mention they have not resolved counts as the 001A textual mention it has
 *     always counted as.
 *
 * So `Stuart M Phillips` and `S M Phillips` are two authors until the user says
 * they are one, and one author afterwards. Nothing pretends an unresolved string
 * is a person, and nothing keeps two resolved mentions apart once a person has
 * been asserted.
 */
export type AuthorEntityKind = "identity" | "mention";

export interface AuthorEntity {
  /**
   * Stable internal key: `identity:<root uuid>` or `mention:<001A key>`.
   *
   * Never displayed. It is the selection key precisely because it survives the
   * things a label does not — renaming an identity, or the option coming to be
   * represented by a different source spelling.
   */
  key: string;
  kind: AuthorEntityKind;
  /** What the user sees: a root `preferred_name`, or a 001A representative spelling. */
  label: string;
  /** Papers contributing at least one mention to this entity. Counted once each. */
  documentCount: number;
  /** Root identity id, for `identity` entities. */
  rootId: string | null;
  /**
   * Everything this entity is findable by: the label, plus (for an identity) the
   * cluster's aliases and linked spellings. Populated from explicit user
   * decisions only — never from inference.
   */
  searchTerms: readonly string[];
}

const IDENTITY_KEY_PREFIX = "identity:";
const MENTION_KEY_PREFIX = "mention:";

export function identityEntityKey(rootId: string): string {
  return `${IDENTITY_KEY_PREFIX}${rootId}`;
}

export function mentionEntityKey(mentionKey: string): string {
  return `${MENTION_KEY_PREFIX}${mentionKey}`;
}

/**
 * Normalize any author-target selection value into a current entity key.
 *
 * The compatibility adapter required because selection values predating 001C are
 * raw author label strings. `useAnalyticsTargets` keeps selections in session
 * state and deliberately persists nothing — no database row, no profile field, no
 * URL parameter, no localStorage — so there is no stored history to migrate. What
 * this protects is the live in-session value: a selection made before the
 * identity dataset finished loading, or held across the responsive breakpoint,
 * must keep meaning the same thing afterwards.
 *
 * A value already carrying a known prefix is returned unchanged; anything else is
 * read as a source spelling and folded to its 001A mention key, which is exactly
 * what selecting it used to mean.
 *
 * An author genuinely named `identity:…` or `mention:…` would be misread. That is
 * accepted: both prefixes are followed by a colon, which no bibliographic name
 * format produces in that position, and the alternative — a wrapper object in
 * session state — would complicate every call site to guard against a name that
 * does not occur.
 */
export function toAuthorEntityKey(value: string): string {
  if (value.startsWith(IDENTITY_KEY_PREFIX) || value.startsWith(MENTION_KEY_PREFIX)) {
    return value;
  }
  return mentionEntityKey(authorMentionKey(value));
}

/**
 * Group every mention across the papers into one entity per effective author.
 *
 * One pass over the mentions is the whole author story for Analytics: the summary
 * tile, the option list and the per-author paper counts all read from this, so
 * they cannot disagree about what counts as one author.
 *
 * A paper is credited once per entity however many of its mentions land there.
 * That covers both the old case (a paper listing two formatting-equivalent
 * spellings) and the new one (a paper listing two mentions the user resolved to
 * the same person) — required by the task, and the only defensible reading of
 * "papers by this author".
 *
 * Identity entities are emitted for every cluster with at least one linked
 * mention among these papers. A cluster whose papers are all filtered out
 * produces no option, exactly as an author with no visible papers produces none
 * today.
 *
 * Representative labels for unresolved mentions keep 001A's rule unchanged: the
 * first non-empty source spelling encountered in caller order, display-normalized.
 * Linear in the number of mentions.
 */
export function indexAuthorEntities(
  papers: readonly AuthorIdentityPaper[],
  resolution: AuthorIdentityResolution,
): AuthorEntity[] {
  const entities = new Map<string, AuthorEntity>();
  const countedPapers = new Map<string, Set<string>>();

  const credit = (entity: AuthorEntity, paperId: string) => {
    let seen = countedPapers.get(entity.key);
    if (!seen) {
      seen = new Set<string>();
      countedPapers.set(entity.key, seen);
    }
    if (seen.has(paperId)) return;
    seen.add(paperId);
    entity.documentCount += 1;
  };

  for (const mention of resolution.mentions) {
    const slot = mentionSlotKey(mention.paperId, mention.authorIndex);
    const link = resolution.linkBySlot.get(slot);

    if (link) {
      const rootId = rootFor(resolution.rootOf, link.identity_id);
      const cluster = resolution.clusters.get(rootId);
      if (cluster) {
        const key = identityEntityKey(rootId);
        let entity = entities.get(key);
        if (!entity) {
          entity = {
            key,
            kind: "identity",
            label: cluster.preferredName,
            documentCount: 0,
            rootId,
            // Deduplicated, and the preferred name leads so the most meaningful
            // term is first for any consumer that shows a subset.
            searchTerms: authorIdentitySearchTerms(cluster),
          };
          entities.set(key, entity);
        }
        credit(entity, mention.paperId);
        continue;
      }
      // A link pointing at a cluster that could not be built is not evidence of
      // a person; fall through and count the mention textually.
    }

    if (!mention.mentionKey) continue;
    const key = mentionEntityKey(mention.mentionKey);
    let entity = entities.get(key);
    if (!entity) {
      entity = {
        key,
        kind: "mention",
        label: mention.displayName,
        documentCount: 0,
        rootId: null,
        searchTerms: [mention.displayName],
      };
      entities.set(key, entity);
    }
    credit(entity, mention.paperId);
  }

  return [...entities.values()];
}

/**
 * Whether an author entity matches a search query.
 *
 * Resolved identities are findable by their preferred name, by every manual alias
 * in the cluster, and by every linked source spelling in it — so a user who
 * merged `S M Phillips` into `Stuart M Phillips` can still find the person by
 * typing either. Unresolved mentions keep 001A's substring-on-canonical-form
 * behaviour unchanged.
 *
 * Internal keys and identity UUIDs are never searched: a user cannot type one,
 * and matching them would leak them into the interface.
 */
export function authorEntitySearchMatches(entity: AuthorEntity, search: string): boolean {
  if (!authorMentionKey(search)) return true;
  return entity.searchTerms.some((term) => authorSearchMatches(term, search));
}
