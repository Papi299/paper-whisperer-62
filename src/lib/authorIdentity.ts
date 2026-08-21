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
}

/** Root id for an identity, falling back to the identity itself. */
function rootFor(rootOf: ReadonlyMap<string, string>, identityId: string): string {
  return rootOf.get(identityId) ?? identityId;
}

/**
 * Aggregate one user's identity decisions over their current papers.
 *
 * `dataset` is `null` when the identity subsystem is not installed in this
 * environment — a Preview running against a database that predates the 001C
 * migration. That produces an `available: false` resolution in which every
 * mention is unresolved, which is precisely 001A behaviour, so every caller
 * degrades to the previous product rather than to an error state.
 *
 * Links are validated against CURRENT paper state before being trusted. A link
 * whose paper is not in `papers` (filtered out of the current view, or deleted)
 * contributes nothing, and neither does one whose author position no longer
 * exists. The database clears links whenever `papers.authors` changes, so a
 * surviving link's snapshot still matches its mention; this is the read-side
 * equivalent of that guarantee, and it means a stale row can never make two
 * unrelated authors look like one person.
 */
export function buildAuthorIdentityResolution(
  papers: readonly AuthorIdentityPaper[],
  dataset: AuthorIdentityDataset | null,
): AuthorIdentityResolution {
  const mentions = collectAuthorMentions(papers);
  const mentionBySlot = new Map<string, AuthorMentionRef>();
  for (const mention of mentions) {
    mentionBySlot.set(mentionSlotKey(mention.paperId, mention.authorIndex), mention);
  }

  if (!dataset) {
    return {
      available: false,
      clusters: new Map(),
      rootOf: new Map(),
      linkBySlot: new Map(),
      mentions,
      unresolvedMentions: mentions.filter(isResolvableMention),
    };
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

  const aliasesByRoot = new Map<string, AuthorIdentityClusterAlias[]>();
  for (const alias of dataset.aliases) {
    // An alias on an identity the dataset does not contain cannot be attributed
    // to a cluster. The composite foreign key makes that unreachable; ignoring
    // it is the conservative response if it ever happens anyway.
    if (!identityById.has(alias.identity_id)) continue;
    const root = rootFor(rootOf, alias.identity_id);
    const display = normalizeAuthorDisplay(alias.alias);
    if (!display) continue;
    const entry: AuthorIdentityClusterAlias = { id: alias.id, alias: display };
    const list = aliasesByRoot.get(root);
    if (list) list.push(entry);
    else aliasesByRoot.set(root, [entry]);
  }

  const linkBySlot = new Map<string, AuthorIdentityLinkRecord>();
  const linkedMentionsByRoot = new Map<string, AuthorMentionRef[]>();

  for (const link of dataset.links) {
    if (!identityById.has(link.identity_id)) continue;
    const slot = mentionSlotKey(link.paper_id, link.author_index);
    const mention = mentionBySlot.get(slot);
    // Not in the current paper set, or the position no longer exists.
    if (!mention) continue;

    linkBySlot.set(slot, link);

    const root = rootFor(rootOf, link.identity_id);
    const list = linkedMentionsByRoot.get(root);
    if (list) list.push(mention);
    else linkedMentionsByRoot.set(root, [mention]);
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

    clusters.set(root, {
      rootId: root,
      preferredName: rootRecord.preferred_name,
      memberIds: ordered,
      mergedMemberIds: ordered.slice(1),
      aliases,
      linkedSpellings: [...spellings],
      orcids: [...orcids],
      hasOrcidConflict: orcids.size > 1,
      linkedMentions,
      paperIds,
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

    add(rootsByNameKey, authorMentionKey(cluster.preferredName), cluster.rootId);
    for (const entry of cluster.aliases) {
      add(rootsByNameKey, authorMentionKey(entry.alias), cluster.rootId);
    }
    for (const spelling of cluster.linkedSpellings) {
      add(rootsByNameKey, authorMentionKey(spelling), cluster.rootId);
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
            searchTerms: [
              ...new Set([
                cluster.preferredName,
                ...cluster.aliases.map((entry) => entry.alias),
                ...cluster.linkedSpellings,
              ]),
            ],
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
