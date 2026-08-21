import { describe, it, expect } from "vitest";
import {
  EMPTY_AUTHOR_IDENTITY_DATASET,
  authorEntitySearchMatches,
  buildAuthorIdentityResolution,
  collectAuthorMentions,
  findAuthorIdentityDuplicates,
  generateAuthorIdentityCandidates,
  identityEntityKey,
  indexAuthorEntities,
  isResolvableMention,
  mentionEntityKey,
  mentionSlotKey,
  resolveAuthorIdentityRoots,
  toAuthorEntityKey,
  type AuthorIdentityDataset,
  type AuthorIdentityPaper,
} from "../authorIdentity";
import { authorMentionKey } from "../authorNames";
import { makeAuthorProvenance } from "../authorProvenance";

/**
 * AUTHOR-IDENTITY-RESOLUTION-001C — the deterministic resolution core.
 *
 * The suite is organized around the one product rule the module exists to hold:
 * Paperlume may suggest an identity relationship, and must never assert one. So
 * the tests come in pairs. For every piece of evidence strong enough to produce a
 * suggestion, there is a test that the suggestion alone changes no grouping; and
 * for every kind of inference the task prohibits, there is a test that it does not
 * happen at all.
 *
 * `Stuart M Phillips` / `S M Phillips` is used throughout because it is the case
 * where the three layers visibly disagree, which is the point: 001A keeps them
 * apart, 001B may hand both the same ORCID and STILL keeps them apart, and only an
 * explicit 001C decision brings them together.
 */

const ORCID_X = "0000-0002-1825-0097";
const ORCID_Y = "0000-0003-0945-2970";

/** A checksum-valid iD that is neither X nor Y. */
const ORCID_Z = "0000-0001-5109-3700";

/**
 * Identity ids are opaque strings to this module — it never parses one — so the
 * tests use readable labels. That keeps an assertion about a merge root legible
 * as `expect(root).toBe("phillips")` instead of a UUID comparison.
 */
let sequence = 0;
function linkId(): string {
  sequence += 1;
  return `link-${sequence}`;
}

function personalProvenance(name: string, orcid: string | null) {
  return makeAuthorProvenance({
    source: "pubmed_api",
    source_field: "Author",
    kind: "personal",
    source_name: name,
    identifiers: orcid ? [{ scheme: "ORCID", value: orcid }] : [],
  });
}

function collectiveProvenance(name: string) {
  return makeAuthorProvenance({
    source: "pubmed_api",
    source_field: "CollectiveName",
    kind: "collective",
    source_name: name,
    collective_name: name,
  });
}

function unknownProvenance(name: string) {
  return makeAuthorProvenance({
    source: "bibtex",
    source_field: "author",
    kind: "unknown",
    source_name: name,
  });
}

function paper(
  id: string,
  title: string,
  authors: string[],
  provenance?: AuthorIdentityPaper["author_provenance"],
): AuthorIdentityPaper {
  return { id, title, authors, author_provenance: provenance ?? null, year: 2024, journal: "J" };
}

/** A dataset builder that keeps the tests about semantics, not plumbing. */
function dataset(parts: Partial<AuthorIdentityDataset>): AuthorIdentityDataset {
  return {
    identities: parts.identities ?? [],
    aliases: parts.aliases ?? [],
    links: parts.links ?? [],
    merges: parts.merges ?? [],
  };
}

function link(
  identityId: string,
  paperId: string,
  authorIndex: number,
  snapshot: string,
) {
  return {
    id: linkId(),
    identity_id: identityId,
    paper_id: paperId,
    author_index: authorIndex,
    author_name_snapshot: snapshot,
    resolution_basis: "manual" as const,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. Merge-root resolution
 * ═════════════════════════════════════════════════════════════════════════ */

describe("resolveAuthorIdentityRoots", () => {
  it("leaves an unmerged identity absent, so it resolves to itself", () => {
    const roots = resolveAuthorIdentityRoots([]);
    expect(roots.size).toBe(0);
  });

  it("resolves a single edge A → B to B", () => {
    const roots = resolveAuthorIdentityRoots([
      { source_identity_id: "A", target_identity_id: "B" },
    ]);
    expect(roots.get("A")).toBe("B");
  });

  it("follows a chain A → B → C so every member resolves to C", () => {
    const roots = resolveAuthorIdentityRoots([
      { source_identity_id: "A", target_identity_id: "B" },
      { source_identity_id: "B", target_identity_id: "C" },
    ]);
    expect(roots.get("A")).toBe("C");
    expect(roots.get("B")).toBe("C");
  });

  it("resolves a chain given in reverse input order", () => {
    // Memoization must not depend on the order rows arrive from PostgREST.
    const roots = resolveAuthorIdentityRoots([
      { source_identity_id: "B", target_identity_id: "C" },
      { source_identity_id: "A", target_identity_id: "B" },
    ]);
    expect(roots.get("A")).toBe("C");
    expect(roots.get("B")).toBe("C");
  });

  it("collapses several sources into one shared root", () => {
    const roots = resolveAuthorIdentityRoots([
      { source_identity_id: "A", target_identity_id: "D" },
      { source_identity_id: "B", target_identity_id: "D" },
      { source_identity_id: "C", target_identity_id: "D" },
    ]);
    expect([roots.get("A"), roots.get("B"), roots.get("C")]).toEqual(["D", "D", "D"]);
  });

  it("defends against a cycle by making every member its own root", () => {
    // The database cannot store this. If it ever appeared, grouping people on the
    // strength of a corrupt graph is worse than not grouping them, and hanging is
    // worse than either.
    const roots = resolveAuthorIdentityRoots([
      { source_identity_id: "A", target_identity_id: "B" },
      { source_identity_id: "B", target_identity_id: "A" },
    ]);
    expect(roots.get("A")).toBe("A");
    expect(roots.get("B")).toBe("B");
  });

  it("defends against a cycle reached through a tail", () => {
    const roots = resolveAuthorIdentityRoots([
      { source_identity_id: "T", target_identity_id: "A" },
      { source_identity_id: "A", target_identity_id: "B" },
      { source_identity_id: "B", target_identity_id: "A" },
    ]);
    expect(roots.get("T")).toBe("T");
    expect(roots.get("A")).toBe("A");
    expect(roots.get("B")).toBe("B");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. Mention collection
 * ═════════════════════════════════════════════════════════════════════════ */

describe("collectAuthorMentions", () => {
  it("emits one mention per non-blank author position, 0-based", () => {
    const mentions = collectAuthorMentions([
      paper("p1", "P1", ["Stuart M Phillips", "  ", "Jane Roe"]),
    ]);
    expect(mentions.map((m) => [m.authorIndex, m.displayName])).toEqual([
      [0, "Stuart M Phillips"],
      [2, "Jane Roe"],
    ]);
  });

  it("reads provenance only when it is aligned with authors", () => {
    // A misaligned array would make entry i describe a different human, so it is
    // ignored wholesale rather than indexed into — the storage layer's own rule.
    const misaligned = [personalProvenance("Stuart M Phillips", ORCID_X)];
    const mentions = collectAuthorMentions([
      paper("p1", "P1", ["Stuart M Phillips", "Jane Roe"], misaligned),
    ]);
    expect(mentions.every((m) => m.orcid === null)).toBe(true);
    expect(mentions.every((m) => m.provenanceKind === null)).toBe(true);
  });

  it("carries the ORCID, kind and source of aligned provenance", () => {
    const mentions = collectAuthorMentions([
      paper(
        "p1",
        "P1",
        ["Stuart M Phillips", "The GRADE Working Group"],
        [
          personalProvenance("Stuart M Phillips", ORCID_X),
          collectiveProvenance("The GRADE Working Group"),
        ],
      ),
    ]);
    expect(mentions[0].orcid).toBe(ORCID_X);
    expect(mentions[0].provenanceKind).toBe("personal");
    expect(mentions[0].provenanceSource).toBe("pubmed_api");
    expect(mentions[1].orcid).toBeNull();
    expect(mentions[1].provenanceKind).toBe("collective");
  });

  it("keeps the raw source spelling alongside the display form", () => {
    // The raw value is what the link RPC's expected-author guard compares, so it
    // must survive display normalization untouched.
    const mentions = collectAuthorMentions([paper("p1", "P1", ["  Stuart   M Phillips "])]);
    expect(mentions[0].rawName).toBe("  Stuart   M Phillips ");
    expect(mentions[0].displayName).toBe("Stuart M Phillips");
  });
});

describe("isResolvableMention", () => {
  it("refuses an explicitly collective mention", () => {
    const [mention] = collectAuthorMentions([
      paper("p1", "P1", ["The GRADE Working Group"], [collectiveProvenance("The GRADE Working Group")]),
    ]);
    expect(isResolvableMention(mention)).toBe(false);
  });

  it("permits unknown provenance", () => {
    const [mention] = collectAuthorMentions([
      paper("p1", "P1", ["Stuart M Phillips"], [unknownProvenance("Stuart M Phillips")]),
    ]);
    expect(isResolvableMention(mention)).toBe(true);
  });

  it("permits a historical mention with no provenance at all", () => {
    const [mention] = collectAuthorMentions([paper("p1", "P1", ["Stuart M Phillips"])]);
    expect(mention.provenanceKind).toBeNull();
    expect(isResolvableMention(mention)).toBe(true);
  });

  it("never infers collective status from the wording of a name", () => {
    // 001B refuses to guess this from text, and 001C must not reintroduce it.
    const [mention] = collectAuthorMentions([
      paper("p1", "P1", ["The Cardiology Consortium Study Group"]),
    ]);
    expect(isResolvableMention(mention)).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. Cluster aggregation
 * ═════════════════════════════════════════════════════════════════════════ */

describe("buildAuthorIdentityResolution — clusters", () => {
  it("treats a null dataset as 'subsystem unavailable' and leaves everything unresolved", () => {
    // A Preview running against a database that predates the 001C migration must
    // behave exactly like 001A, not like an error.
    const papers = [paper("p1", "P1", ["Stuart M Phillips"])];
    const resolution = buildAuthorIdentityResolution(papers, null);

    expect(resolution.available).toBe(false);
    expect(resolution.clusters.size).toBe(0);
    expect(resolution.linkBySlot.size).toBe(0);
    expect(resolution.unresolvedMentions).toHaveLength(1);
  });

  it("treats an installed-but-empty dataset as available with nothing resolved", () => {
    const resolution = buildAuthorIdentityResolution(
      [paper("p1", "P1", ["Stuart M Phillips"])],
      EMPTY_AUTHOR_IDENTITY_DATASET,
    );
    expect(resolution.available).toBe(true);
    expect(resolution.unresolvedMentions).toHaveLength(1);
  });

  it("aggregates preferred name, aliases, linked spellings and ORCID evidence", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["S M Phillips"], [personalProvenance("S M Phillips", ORCID_X)]),
    ];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        aliases: [{ id: "a1", identity_id: "phillips", alias: "Phillips SM" }],
        links: [
          link("phillips", "p1", 0, "Stuart M Phillips"),
          link("phillips", "p2", 0, "S M Phillips"),
        ],
      }),
    );

    const cluster = resolution.clusters.get("phillips")!;
    expect(cluster.preferredName).toBe("Stuart M Phillips");
    expect(cluster.aliases).toEqual(["Phillips SM"]);
    expect([...cluster.linkedSpellings].sort()).toEqual(["S M Phillips", "Stuart M Phillips"]);
    expect(cluster.orcids).toEqual([ORCID_X]);
    expect(cluster.hasOrcidConflict).toBe(false);
    expect([...cluster.paperIds].sort()).toEqual(["p1", "p2"]);
    expect(resolution.unresolvedMentions).toHaveLength(0);
  });

  it("aggregates a merged chain under the root's name and keeps members listed", () => {
    const papers = [paper("p1", "P1", ["A One", "B Two", "C Three"])];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [
          { id: "a", preferred_name: "A One" },
          { id: "b", preferred_name: "B Two" },
          { id: "c", preferred_name: "C Three" },
        ],
        aliases: [{ id: "al", identity_id: "a", alias: "A. One" }],
        links: [link("a", "p1", 0, "A One"), link("b", "p1", 1, "B Two"), link("c", "p1", 2, "C Three")],
        merges: [
          { source_identity_id: "a", target_identity_id: "b" },
          { source_identity_id: "b", target_identity_id: "c" },
        ],
      }),
    );

    expect(resolution.clusters.size).toBe(1);
    const cluster = resolution.clusters.get("c")!;
    expect(cluster.preferredName).toBe("C Three");
    expect(cluster.memberIds[0]).toBe("c");
    expect([...cluster.mergedMemberIds].sort()).toEqual(["a", "b"]);
    // The merged member's alias belongs to the cluster — nothing was moved, it is
    // simply reachable through the root now.
    expect(cluster.aliases).toEqual(["A. One"]);
    expect([...cluster.linkedSpellings].sort()).toEqual(["A One", "B Two", "C Three"]);
  });

  it("reports conflicting ORCID evidence without resolving it", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_Y)]),
    ];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips"), link("phillips", "p2", 0, "Stuart M Phillips")],
      }),
    );

    const cluster = resolution.clusters.get("phillips")!;
    expect([...cluster.orcids].sort()).toEqual([ORCID_X, ORCID_Y].sort());
    expect(cluster.hasOrcidConflict).toBe(true);
  });

  it("ignores a link whose paper is not in the current set", () => {
    // Filtered out of the view, or deleted. It must contribute no evidence and no
    // count rather than resurrecting a paper that is not there.
    const resolution = buildAuthorIdentityResolution(
      [paper("p1", "P1", ["Stuart M Phillips"])],
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p-gone", 0, "Stuart M Phillips")],
      }),
    );
    expect(resolution.linkBySlot.size).toBe(0);
    expect(resolution.clusters.get("phillips")!.linkedMentions).toHaveLength(0);
    expect(resolution.unresolvedMentions).toHaveLength(1);
  });

  it("ignores a link whose author position no longer exists", () => {
    const resolution = buildAuthorIdentityResolution(
      [paper("p1", "P1", ["Stuart M Phillips"])],
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 7, "Someone Else")],
      }),
    );
    expect(resolution.linkBySlot.size).toBe(0);
    expect(resolution.unresolvedMentions).toHaveLength(1);
  });

  it("excludes collective mentions from the unresolved work list", () => {
    const resolution = buildAuthorIdentityResolution(
      [
        paper(
          "p1",
          "P1",
          ["Stuart M Phillips", "The GRADE Working Group"],
          [personalProvenance("Stuart M Phillips", null), collectiveProvenance("The GRADE Working Group")],
        ),
      ],
      EMPTY_AUTHOR_IDENTITY_DATASET,
    );
    expect(resolution.mentions).toHaveLength(2);
    expect(resolution.unresolvedMentions.map((m) => m.displayName)).toEqual(["Stuart M Phillips"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. Candidate generation
 * ═════════════════════════════════════════════════════════════════════════ */

/** Candidates for the single unresolved mention in a one-mention scenario. */
function candidatesFor(
  papers: AuthorIdentityPaper[],
  data: AuthorIdentityDataset,
  displayName: string,
) {
  const resolution = buildAuthorIdentityResolution(papers, data);
  const entry = generateAuthorIdentityCandidates(resolution).find(
    (c) => c.mention.displayName === displayName,
  );
  if (!entry) throw new Error(`no unresolved mention named ${displayName}`);
  return entry.candidates;
}

describe("generateAuthorIdentityCandidates — exact ORCID", () => {
  it("suggests the identity whose linked mentions carry the same valid ORCID", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["S M Phillips"], [personalProvenance("S M Phillips", ORCID_X)]),
    ];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      "S M Phillips",
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      rootId: "phillips",
      reason: "same_orcid",
      orcid: ORCID_X,
      ambiguous: false,
    });
  });

  it("is a suggestion only — the mention stays unresolved until the user links it", () => {
    // The load-bearing boundary of the whole feature.
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["S M Phillips"], [personalProvenance("S M Phillips", ORCID_X)]),
    ];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
    );

    expect(resolution.unresolvedMentions.map((m) => m.displayName)).toEqual(["S M Phillips"]);
    const entities = indexAuthorEntities(papers, resolution);
    expect(entities).toHaveLength(2);
  });

  it("returns every matching identity and flags ambiguity rather than choosing", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["Stu Phillips"], [personalProvenance("Stu Phillips", ORCID_X)]),
      paper("p3", "P3", ["S M Phillips"], [personalProvenance("S M Phillips", ORCID_X)]),
    ];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [
          { id: "one", preferred_name: "Stuart M Phillips" },
          { id: "two", preferred_name: "Stu Phillips" },
        ],
        links: [link("one", "p1", 0, "Stuart M Phillips"), link("two", "p2", 0, "Stu Phillips")],
      }),
      "S M Phillips",
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.reason === "same_orcid")).toBe(true);
    expect(candidates.every((c) => c.ambiguous)).toBe(true);
    expect(candidates.map((c) => c.rootId).sort()).toEqual(["one", "two"]);
  });

  it("offers no ORCID candidate when the identity's own ORCID evidence is gone", () => {
    // Evidence is derived from CURRENTLY linked mentions, never stored on the
    // identity, so it disappears with the link rather than outliving it.
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["S M Phillips"], [personalProvenance("S M Phillips", ORCID_X)]),
    ];
    const candidates = candidatesFor(
      papers,
      dataset({ identities: [{ id: "phillips", preferred_name: "Someone Unrelated" }], links: [] }),
      "S M Phillips",
    );
    expect(candidates).toHaveLength(0);
  });
});

describe("generateAuthorIdentityCandidates — exact 001A name key", () => {
  it("suggests an identity whose preferred name is formatting-equivalent", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"]),
      paper("p2", "P2", ["Stuart M. Phillips"]),
    ];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      "Stuart M. Phillips",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ rootId: "phillips", reason: "same_normalized_name", orcid: null });
  });

  it("suggests through a manual alias", () => {
    const papers = [paper("p1", "P1", ["Stuart M Phillips"]), paper("p2", "P2", ["Phillips SM"])];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        aliases: [{ id: "a1", identity_id: "phillips", alias: "Phillips SM" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      "Phillips SM",
    );
    expect(candidates.map((c) => c.reason)).toEqual(["same_normalized_name"]);
  });

  it("suggests through a spelling the user already linked", () => {
    // Linking `S M Phillips` teaches the identity that spelling, so a third paper
    // spelling it the same way becomes findable. Learning from an explicit
    // decision, not inference.
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"]),
      paper("p2", "P2", ["S M Phillips"]),
      paper("p3", "P3", ["S M Phillips"]),
    ];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips"), link("phillips", "p2", 0, "S M Phillips")],
      }),
    );
    const entry = generateAuthorIdentityCandidates(resolution).find((c) => c.mention.paperId === "p3")!;
    expect(entry.candidates.map((c) => c.reason)).toEqual(["same_normalized_name"]);
  });

  it("does NOT suggest an initialled spelling for a full name", () => {
    // The 001A semantics stay authoritative: `S M Phillips` is not `Stuart M
    // Phillips` until some explicit alias or linked mention makes it so.
    const papers = [paper("p1", "P1", ["Stuart M Phillips"]), paper("p2", "P2", ["S M Phillips"])];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      "S M Phillips",
    );
    expect(candidates).toHaveLength(0);
  });

  it("does NOT fuzzy-match a near spelling", () => {
    const papers = [paper("p1", "P1", ["Stuart M Phillips"]), paper("p2", "P2", ["Stuart M Philips"])];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      "Stuart M Philips",
    );
    expect(candidates).toHaveLength(0);
  });

  it.each([
    ["surname inversion", "Phillips, Stuart M"],
    ["middle-name omission", "Stuart Phillips"],
    ["accent stripping", "Stuart M Phillíps"],
    ["first-name abbreviation", "St. M Phillips"],
  ])("does NOT infer a match by %s", (_label, spelling) => {
    const papers = [paper("p1", "P1", ["Stuart M Phillips"]), paper("p2", "P2", [spelling])];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      spelling,
    );
    expect(candidates).toHaveLength(0);
  });

  it("still suggests for an unknown-provenance mention, which the user must confirm", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [unknownProvenance("Stuart M Phillips")]),
      paper("p2", "P2", ["Stuart M. Phillips"], [unknownProvenance("Stuart M. Phillips")]),
    ];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      "Stuart M. Phillips",
    );
    expect(candidates.map((c) => c.reason)).toEqual(["same_normalized_name"]);
  });

  it("never offers a candidate for a collective mention", () => {
    const papers = [
      paper("p1", "P1", ["The GRADE Working Group"], [personalProvenance("The GRADE Working Group", null)]),
      paper("p2", "P2", ["The GRADE Working Group"], [collectiveProvenance("The GRADE Working Group")]),
    ];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [{ id: "grade", preferred_name: "The GRADE Working Group" }],
        links: [link("grade", "p1", 0, "The GRADE Working Group")],
      }),
    );
    const entries = generateAuthorIdentityCandidates(resolution);
    expect(entries.some((e) => e.mention.paperId === "p2")).toBe(false);
  });
});

describe("generateAuthorIdentityCandidates — contradictory identifier evidence", () => {
  it("suppresses the weak name candidate when ORCIDs disagree", () => {
    // Same normalized name, different valid iDs. Name similarity must not override
    // structured evidence that these are different people.
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_Y)]),
    ];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      "Stuart M Phillips",
    );
    expect(candidates).toHaveLength(0);
  });

  it("keeps the name candidate when the identity has no ORCID evidence to contradict it", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [unknownProvenance("Stuart M Phillips")]),
      paper("p2", "P2", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_Y)]),
    ];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      "Stuart M Phillips",
    );
    expect(candidates.map((c) => c.reason)).toEqual(["same_normalized_name"]);
  });

  it("keeps the name candidate when the mention has no ORCID of its own", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["Stuart M Phillips"], [unknownProvenance("Stuart M Phillips")]),
    ];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      "Stuart M Phillips",
    );
    expect(candidates.map((c) => c.reason)).toEqual(["same_normalized_name"]);
  });

  it("offers one candidate per identity, carrying the stronger ORCID reason", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
    ];
    const candidates = candidatesFor(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      "Stuart M Phillips",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe("same_orcid");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. Possible duplicate identities
 * ═════════════════════════════════════════════════════════════════════════ */

describe("findAuthorIdentityDuplicates", () => {
  it("pairs two roots whose linked mentions share a valid ORCID", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["Stu Phillips"], [personalProvenance("Stu Phillips", ORCID_X)]),
    ];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [
          { id: "aaa", preferred_name: "Stuart M Phillips" },
          { id: "bbb", preferred_name: "Stu Phillips" },
        ],
        links: [link("aaa", "p1", 0, "Stuart M Phillips"), link("bbb", "p2", 0, "Stu Phillips")],
      }),
    );

    const duplicates = findAuthorIdentityDuplicates(resolution);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({
      firstRootId: "aaa",
      secondRootId: "bbb",
      reason: "same_orcid",
      orcid: ORCID_X,
    });
  });

  it("pairs two roots sharing an exact 001A name key", () => {
    const papers = [paper("p1", "P1", ["Stuart M Phillips"]), paper("p2", "P2", ["Stuart M. Phillips"])];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [
          { id: "aaa", preferred_name: "Stuart M Phillips" },
          { id: "bbb", preferred_name: "Stuart M. Phillips" },
        ],
        links: [link("aaa", "p1", 0, "Stuart M Phillips"), link("bbb", "p2", 0, "Stuart M. Phillips")],
      }),
    );
    expect(findAuthorIdentityDuplicates(resolution).map((d) => d.reason)).toEqual([
      "same_normalized_name",
    ]);
  });

  it("suppresses a same-name pair whose ORCID evidence is non-empty and disjoint", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_Y)]),
    ];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [
          { id: "aaa", preferred_name: "Stuart M Phillips" },
          { id: "bbb", preferred_name: "Stuart M Phillips" },
        ],
        links: [link("aaa", "p1", 0, "Stuart M Phillips"), link("bbb", "p2", 0, "Stuart M Phillips")],
      }),
    );
    expect(findAuthorIdentityDuplicates(resolution)).toHaveLength(0);
  });

  it("keeps a same-name pair when one side has no ORCID to contradict it", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["Stuart M Phillips"], [unknownProvenance("Stuart M Phillips")]),
    ];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [
          { id: "aaa", preferred_name: "Stuart M Phillips" },
          { id: "bbb", preferred_name: "Stuart M Phillips" },
        ],
        links: [link("aaa", "p1", 0, "Stuart M Phillips"), link("bbb", "p2", 0, "Stuart M Phillips")],
      }),
    );
    expect(findAuthorIdentityDuplicates(resolution)).toHaveLength(1);
  });

  it("reports a pair once, with the stronger reason, when both signals fire", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
      paper("p2", "P2", ["Stuart M. Phillips"], [personalProvenance("Stuart M. Phillips", ORCID_X)]),
    ];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [
          { id: "aaa", preferred_name: "Stuart M Phillips" },
          { id: "bbb", preferred_name: "Stuart M. Phillips" },
        ],
        links: [link("aaa", "p1", 0, "Stuart M Phillips"), link("bbb", "p2", 0, "Stuart M. Phillips")],
      }),
    );
    const duplicates = findAuthorIdentityDuplicates(resolution);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].reason).toBe("same_orcid");
  });

  it("never pairs identities that are already merged into one root", () => {
    const papers = [paper("p1", "P1", ["Stuart M Phillips", "Stuart M. Phillips"])];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [
          { id: "aaa", preferred_name: "Stuart M Phillips" },
          { id: "bbb", preferred_name: "Stuart M. Phillips" },
        ],
        links: [link("aaa", "p1", 0, "Stuart M Phillips"), link("bbb", "p1", 1, "Stuart M. Phillips")],
        merges: [{ source_identity_id: "bbb", target_identity_id: "aaa" }],
      }),
    );
    // One cluster exists, so there is no pair to review.
    expect(resolution.clusters.size).toBe(1);
    expect(findAuthorIdentityDuplicates(resolution)).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. Analytics author entities
 * ═════════════════════════════════════════════════════════════════════════ */

describe("indexAuthorEntities", () => {
  const twoSpellings = [
    paper("p1", "P1", ["Stuart M Phillips"], [personalProvenance("Stuart M Phillips", ORCID_X)]),
    paper("p2", "P2", ["S M Phillips"], [personalProvenance("S M Phillips", ORCID_X)]),
  ];

  it("keeps two unresolved spellings apart even when the ORCID matches", () => {
    // The 001A/001B behaviour Analytics must preserve until the user decides.
    const resolution = buildAuthorIdentityResolution(twoSpellings, EMPTY_AUTHOR_IDENTITY_DATASET);
    const entities = indexAuthorEntities(twoSpellings, resolution);

    expect(entities).toHaveLength(2);
    expect(entities.every((e) => e.kind === "mention")).toBe(true);
    expect(entities.map((e) => e.label).sort()).toEqual(["S M Phillips", "Stuart M Phillips"]);
  });

  it("collapses them into one person once the user links both", () => {
    const resolution = buildAuthorIdentityResolution(
      twoSpellings,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips"), link("phillips", "p2", 0, "S M Phillips")],
      }),
    );
    const entities = indexAuthorEntities(twoSpellings, resolution);

    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      key: identityEntityKey("phillips"),
      kind: "identity",
      label: "Stuart M Phillips",
      documentCount: 2,
    });
  });

  it("splits them again when one is unlinked", () => {
    const resolution = buildAuthorIdentityResolution(
      twoSpellings,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
    );
    const entities = indexAuthorEntities(twoSpellings, resolution);

    expect(entities).toHaveLength(2);
    expect(entities.map((e) => e.kind).sort()).toEqual(["identity", "mention"]);
    expect(entities.find((e) => e.kind === "identity")!.documentCount).toBe(1);
  });

  it("counts a paper once when two of its mentions resolve to the same identity", () => {
    const papers = [paper("p1", "P1", ["Stuart M Phillips", "S M Phillips"])];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips"), link("phillips", "p1", 1, "S M Phillips")],
      }),
    );
    const entities = indexAuthorEntities(papers, resolution);
    expect(entities).toHaveLength(1);
    expect(entities[0].documentCount).toBe(1);
  });

  it("collapses a merged pair onto the target root and separates them again on unmerge", () => {
    const papers = [paper("p1", "P1", ["A One"]), paper("p2", "P2", ["B Two"])];
    const identities = [
      { id: "a", preferred_name: "A One" },
      { id: "b", preferred_name: "B Two" },
    ];
    const links = [link("a", "p1", 0, "A One"), link("b", "p2", 0, "B Two")];

    const merged = indexAuthorEntities(
      papers,
      buildAuthorIdentityResolution(
        papers,
        dataset({ identities, links, merges: [{ source_identity_id: "a", target_identity_id: "b" }] }),
      ),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ key: identityEntityKey("b"), label: "B Two", documentCount: 2 });

    const unmerged = indexAuthorEntities(
      papers,
      buildAuthorIdentityResolution(papers, dataset({ identities, links })),
    );
    expect(unmerged).toHaveLength(2);
    expect(unmerged.map((e) => e.label).sort()).toEqual(["A One", "B Two"]);
  });

  it("keeps the identity key stable across a rename", () => {
    // The selection key must survive the label changing, or renaming a person
    // would silently drop them out of a comparison.
    const papers = [paper("p1", "P1", ["Stuart M Phillips"])];
    const links = [link("phillips", "p1", 0, "Stuart M Phillips")];

    const before = indexAuthorEntities(
      papers,
      buildAuthorIdentityResolution(
        papers,
        dataset({ identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }], links }),
      ),
    );
    const after = indexAuthorEntities(
      papers,
      buildAuthorIdentityResolution(
        papers,
        dataset({ identities: [{ id: "phillips", preferred_name: "S. M. Phillips (lab)" }], links }),
      ),
    );

    expect(before[0].key).toBe(after[0].key);
    expect(after[0].label).toBe("S. M. Phillips (lab)");
  });

  it("mixes resolved and unresolved entities with stable counts", () => {
    const papers = [
      paper("p1", "P1", ["Stuart M Phillips", "Jane Roe"]),
      paper("p2", "P2", ["S M Phillips", "Jane Roe"]),
    ];
    const resolution = buildAuthorIdentityResolution(
      papers,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips"), link("phillips", "p2", 0, "S M Phillips")],
      }),
    );
    const entities = indexAuthorEntities(papers, resolution);

    expect(entities).toHaveLength(2);
    const byLabel = new Map(entities.map((e) => [e.label, e]));
    expect(byLabel.get("Stuart M Phillips")!.documentCount).toBe(2);
    expect(byLabel.get("Jane Roe")!.documentCount).toBe(2);
    expect(byLabel.get("Jane Roe")!.kind).toBe("mention");
  });

  it("still groups formatting-equivalent unresolved spellings, as 001A always did", () => {
    const papers = [paper("p1", "P1", ["Stuart M Phillips"]), paper("p2", "P2", ["Stuart M. Phillips"])];
    const entities = indexAuthorEntities(
      papers,
      buildAuthorIdentityResolution(papers, EMPTY_AUTHOR_IDENTITY_DATASET),
    );
    expect(entities).toHaveLength(1);
    expect(entities[0].key).toBe(mentionEntityKey(authorMentionKey("Stuart M Phillips")));
    expect(entities[0].documentCount).toBe(2);
  });

  it("counts a collective mention as an ordinary unresolved author entity", () => {
    // It may never become a person, but it is still an author string the library
    // contains, and hiding it from Analytics would under-report the data.
    const papers = [
      paper("p1", "P1", ["The GRADE Working Group"], [collectiveProvenance("The GRADE Working Group")]),
    ];
    const entities = indexAuthorEntities(
      papers,
      buildAuthorIdentityResolution(papers, EMPTY_AUTHOR_IDENTITY_DATASET),
    );
    expect(entities).toHaveLength(1);
    expect(entities[0].kind).toBe("mention");
  });
});

describe("authorEntitySearchMatches", () => {
  const papers = [paper("p1", "P1", ["Stuart M Phillips"]), paper("p2", "P2", ["S M Phillips"])];
  const resolution = buildAuthorIdentityResolution(
    papers,
    dataset({
      identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
      aliases: [{ id: "a1", identity_id: "phillips", alias: "Phillips SM" }],
      links: [link("phillips", "p1", 0, "Stuart M Phillips"), link("phillips", "p2", 0, "S M Phillips")],
    }),
  );
  const [identity] = indexAuthorEntities(papers, resolution);

  it.each([
    ["the preferred name", "Stuart M Phillips"],
    ["a punctuation variant of the preferred name", "Stuart M. Phillips"],
    ["a manual alias", "Phillips SM"],
    ["a linked source spelling", "S M Phillips"],
    ["a fragment", "phillips"],
  ])("finds a resolved identity by %s", (_label, query) => {
    expect(authorEntitySearchMatches(identity, query)).toBe(true);
  });

  it("matches everything for a blank query", () => {
    expect(authorEntitySearchMatches(identity, "   ")).toBe(true);
  });

  it("does not match an unrelated name", () => {
    expect(authorEntitySearchMatches(identity, "Jane Roe")).toBe(false);
  });

  it("never exposes the internal key or identity id to search", () => {
    expect(authorEntitySearchMatches(identity, "phillips-id")).toBe(false);
    expect(authorEntitySearchMatches(identity, "identity:")).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. Selection-key compatibility
 * ═════════════════════════════════════════════════════════════════════════ */

describe("toAuthorEntityKey", () => {
  it("passes an identity key through unchanged", () => {
    expect(toAuthorEntityKey(identityEntityKey("phillips"))).toBe("identity:phillips");
  });

  it("passes a mention key through unchanged", () => {
    const key = mentionEntityKey(authorMentionKey("Stuart M Phillips"));
    expect(toAuthorEntityKey(key)).toBe(key);
  });

  it("folds a legacy raw label into the mention key it used to mean", () => {
    // Selections are session state, never persisted, so this protects a live
    // value held across the responsive breakpoint or made before the identity
    // dataset finished loading.
    expect(toAuthorEntityKey("Stuart M. Phillips")).toBe(
      mentionEntityKey(authorMentionKey("Stuart M Phillips")),
    );
  });

  it("maps formatting-equivalent legacy labels onto one key", () => {
    expect(toAuthorEntityKey("Stuart M. Phillips")).toBe(toAuthorEntityKey("Stuart M Phillips"));
  });
});

describe("mentionSlotKey", () => {
  it("distinguishes positions on the same paper", () => {
    expect(mentionSlotKey("p1", 0)).not.toBe(mentionSlotKey("p1", 1));
  });
});
