import { describe, it, expect } from "vitest";
import {
  buildAuthorIdentityResolution,
  indexAuthorEntities,
  type AuthorIdentityDataset,
  type AuthorIdentityPaper,
} from "../authorIdentity";
import {
  reconcileAuthorSelections,
  toggleAuthorSelection,
  type AuthorTargetSelection,
} from "../authorSelection";

/**
 * What a selected author still means after the identity graph moves.
 *
 * Every transition tested here is one the USER performs from the same screen the
 * selection lives on: linking a mention to a person, merging two people, undoing
 * either. The selection has to survive all of them without this layer ever
 * deciding, on its own, that two things are the same person — the one thing 001C
 * refuses to do anywhere.
 *
 * The other half of the contract is negative and equally load-bearing: no
 * internal key may ever reach a label. `identity:<uuid>` and `mention:<001A
 * key>` are how selections are addressed, not how they are described.
 */

function paper(
  id: string,
  authors: string[],
  title = `Paper ${id}`,
): AuthorIdentityPaper {
  return { id, title, authors, author_provenance: null, year: 2024, journal: "J Test" };
}

function dataset(parts: Partial<AuthorIdentityDataset>): AuthorIdentityDataset {
  return {
    identities: parts.identities ?? [],
    aliases: parts.aliases ?? [],
    links: parts.links ?? [],
    merges: parts.merges ?? [],
  };
}

function link(identityId: string, paperId: string, authorIndex: number, snapshot: string) {
  return {
    id: `${identityId}:${paperId}:${authorIndex}`,
    identity_id: identityId,
    paper_id: paperId,
    author_index: authorIndex,
    author_name_snapshot: snapshot,
    resolution_basis: "manual" as const,
  };
}

/** Reconcile against a freshly built resolution, as the component does. */
function reconcile(
  selections: AuthorTargetSelection[],
  papers: AuthorIdentityPaper[],
  data: AuthorIdentityDataset | null,
) {
  const resolution = buildAuthorIdentityResolution(papers, data);
  const entities = indexAuthorEntities(papers, resolution);
  return reconcileAuthorSelections(selections, entities, resolution);
}

const PAPERS = [
  paper("p1", ["Stuart M Phillips"]),
  paper("p2", ["S M Phillips"]),
];

describe("author selection reconciliation", () => {
  it("leaves an untouched mention selection exactly where it was", () => {
    const result = reconcile(
      [{ key: "mention:stuart m phillips", label: "Stuart M Phillips" }],
      PAPERS,
      dataset({}),
    );

    expect(result).toHaveLength(1);
    expect(result[0].entityKey).toBe("mention:stuart m phillips");
    expect(result[0].label).toBe("Stuart M Phillips");
    expect(result[0].documentCount).toBe(1);
    expect(result[0].present).toBe(true);
  });

  it("folds a legacy raw author label into the mention it always meant", () => {
    // Selections predating entity keys are bare display strings. Nothing
    // persists them, but one can still be in session state from a moment ago.
    const result = reconcile(
      [{ key: "Stuart M. Phillips", label: "Stuart M. Phillips" }],
      PAPERS,
      dataset({}),
    );

    expect(result).toHaveLength(1);
    expect(result[0].entityKey).toBe("mention:stuart m phillips");
    expect(result[0].present).toBe(true);
  });

  it("follows a linked mention to the person it became", () => {
    // The transition the user performs constantly: select an author, then
    // resolve that same author to a person. The selection must not be orphaned.
    const result = reconcile(
      [{ key: "mention:s m phillips", label: "S M Phillips" }],
      PAPERS,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p2", 0, "S M Phillips")],
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0].entityKey).toBe("identity:phillips");
    expect(result[0].label).toBe("Stuart M Phillips");
    expect(result[0].documentCount).toBe(1);
  });

  it("keeps EVERY descendant when one spelling was resolved two different ways", () => {
    // The ambiguous case, and the reason the policy is written down. One
    // spelling occurs on three papers; the user linked one to X, one to Y, and
    // left the third alone. Their selection meant "these three papers", so all
    // three descendants are preserved. Picking one would be this layer deciding
    // which person they meant — from evidence that says they meant more.
    const papers = [
      paper("p1", ["J Smith"]),
      paper("p2", ["J Smith"]),
      paper("p3", ["J Smith"]),
    ];
    const result = reconcile(
      [{ key: "mention:j smith", label: "J Smith" }],
      papers,
      dataset({
        identities: [
          { id: "x", preferred_name: "Jane Smith" },
          { id: "y", preferred_name: "John Smith" },
        ],
        links: [link("x", "p1", 0, "J Smith"), link("y", "p2", 0, "J Smith")],
      }),
    );

    expect(result.map((entry) => entry.entityKey).sort()).toEqual([
      "identity:x",
      "identity:y",
      "mention:j smith",
    ]);
    // The paper set the user had selected is intact: one each.
    expect(result.every((entry) => entry.documentCount === 1)).toBe(true);
    expect(result.map((entry) => entry.label).sort()).toEqual([
      "J Smith",
      "Jane Smith",
      "John Smith",
    ]);
  });

  it("follows a merged identity to its effective root", () => {
    const result = reconcile(
      [{ key: "identity:a", label: "A One" }],
      PAPERS,
      dataset({
        identities: [
          { id: "a", preferred_name: "A One" },
          { id: "b", preferred_name: "B Two" },
        ],
        links: [link("a", "p1", 0, "Stuart M Phillips")],
        merges: [{ source_identity_id: "a", target_identity_id: "b" }],
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0].entityKey).toBe("identity:b");
    expect(result[0].label).toBe("B Two");
    expect(result[0].documentCount).toBe(1);
  });

  it("follows a whole merge chain to its terminal root", () => {
    const result = reconcile(
      [{ key: "identity:a", label: "A One" }],
      PAPERS,
      dataset({
        identities: [
          { id: "a", preferred_name: "A One" },
          { id: "b", preferred_name: "B Two" },
          { id: "c", preferred_name: "C Three" },
        ],
        links: [link("a", "p1", 0, "Stuart M Phillips")],
        merges: [
          { source_identity_id: "a", target_identity_id: "b" },
          { source_identity_id: "b", target_identity_id: "c" },
        ],
      }),
    );

    expect(result[0].entityKey).toBe("identity:c");
    expect(result[0].label).toBe("C Three");
  });

  it("restores the original selection when the merge is undone", () => {
    // The reason stored keys are never rewritten. Undo needs no bookkeeping
    // because nothing was recorded to undo: the same stored key simply resolves
    // somewhere else once the edge is gone.
    const identities = [
      { id: "a", preferred_name: "A One" },
      { id: "b", preferred_name: "B Two" },
    ];
    const links = [link("a", "p1", 0, "Stuart M Phillips")];
    const selection = [{ key: "identity:a", label: "A One" }];

    const merged = reconcile(
      selection,
      PAPERS,
      dataset({ identities, links, merges: [{ source_identity_id: "a", target_identity_id: "b" }] }),
    );
    expect(merged[0].entityKey).toBe("identity:b");

    const unmerged = reconcile(selection, PAPERS, dataset({ identities, links, merges: [] }));
    expect(unmerged[0].entityKey).toBe("identity:a");
    expect(unmerged[0].label).toBe("A One");
    expect(unmerged[0].documentCount).toBe(1);
  });

  it("returns a linked selection to its mention when the link is undone", () => {
    const identities = [{ id: "phillips", preferred_name: "Stuart M Phillips" }];
    const selection = [{ key: "mention:s m phillips", label: "S M Phillips" }];

    const linked = reconcile(
      selection,
      PAPERS,
      dataset({ identities, links: [link("phillips", "p2", 0, "S M Phillips")] }),
    );
    expect(linked[0].entityKey).toBe("identity:phillips");

    const unlinked = reconcile(selection, PAPERS, dataset({ identities, links: [] }));
    expect(unlinked[0].entityKey).toBe("mention:s m phillips");
    expect(unlinked[0].label).toBe("S M Phillips");
  });

  it("reconciles a selection made before the identity dataset arrived", () => {
    // While `dataset` is null the UI is on the 001A fallback and everything is a
    // mention. Nothing special happens when real data lands — the link rule
    // above already covers it, which is why there is no load-order branch.
    const selection = [{ key: "mention:s m phillips", label: "S M Phillips" }];

    const duringFallback = reconcile(selection, PAPERS, null);
    expect(duringFallback[0].entityKey).toBe("mention:s m phillips");
    expect(duringFallback[0].present).toBe(true);

    const afterLoad = reconcile(
      selection,
      PAPERS,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p2", 0, "S M Phillips")],
      }),
    );
    expect(afterLoad[0].entityKey).toBe("identity:phillips");
    expect(afterLoad[0].label).toBe("Stuart M Phillips");
  });

  it("follows a rename, because the label is read live and never stored back", () => {
    const result = reconcile(
      [{ key: "identity:phillips", label: "Stuart M Phillips" }],
      PAPERS,
      dataset({
        identities: [{ id: "phillips", preferred_name: "Prof. Stuart Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
    );

    expect(result[0].label).toBe("Prof. Stuart Phillips");
  });

  it("keeps an identity selection describable when its papers are filtered away", () => {
    // The person still exists; only their papers left the view. The badge stays
    // removable and stays named — from the live cluster, not the internal key.
    const result = reconcile(
      [{ key: "identity:phillips", label: "Stale Label" }],
      [paper("p9", ["Someone Unrelated"])],
      dataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
    );

    expect(result[0].entityKey).toBe("identity:phillips");
    expect(result[0].label).toBe("Stuart M Phillips");
    expect(result[0].documentCount).toBe(0);
    expect(result[0].present).toBe(false);
  });

  it("falls back to the remembered label for a mention with nothing in view", () => {
    // A mention has no durable record anywhere, so when its papers are gone the
    // only human-readable thing left is what the user read when they picked it.
    const result = reconcile(
      [{ key: "mention:curie m", label: "Curie M" }],
      [paper("p9", ["Someone Unrelated"])],
      dataset({}),
    );

    expect(result[0].label).toBe("Curie M");
    expect(result[0].documentCount).toBe(0);
    expect(result[0].present).toBe(false);
  });

  it("drops a selection with no readable label rather than showing its key", () => {
    // Only reachable from state this module did not write. Rendering the raw key
    // is the single outcome that is never acceptable, so the entry is omitted.
    const result = reconcile(
      [{ key: "mention:curie m", label: "   " }],
      [paper("p9", ["Someone Unrelated"])],
      dataset({}),
    );

    expect(result).toEqual([]);
  });

  it("never produces a label containing an internal key or an identity id", () => {
    const identityId = "3f5c2a10-0000-4000-8000-000000000abc";
    const result = reconcile(
      [
        { key: `identity:${identityId}`, label: "Stuart M Phillips" },
        { key: "mention:s m phillips", label: "S M Phillips" },
        { key: "mention:gone entirely", label: "Gone Entirely" },
      ],
      PAPERS,
      dataset({
        identities: [{ id: identityId, preferred_name: "Stuart M Phillips" }],
        links: [link(identityId, "p1", 0, "Stuart M Phillips")],
      }),
    );

    for (const entry of result) {
      expect(entry.label).not.toContain("identity:");
      expect(entry.label).not.toContain("mention:");
      expect(entry.label).not.toContain(identityId);
    }
  });

  it("collapses two selections that the user later merged into one badge", () => {
    const result = reconcile(
      [
        { key: "identity:a", label: "A One" },
        { key: "identity:b", label: "B Two" },
      ],
      PAPERS,
      dataset({
        identities: [
          { id: "a", preferred_name: "A One" },
          { id: "b", preferred_name: "B Two" },
        ],
        links: [link("a", "p1", 0, "Stuart M Phillips"), link("b", "p2", 0, "S M Phillips")],
        merges: [{ source_identity_id: "a", target_identity_id: "b" }],
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0].entityKey).toBe("identity:b");
    // Both stored keys ride along, so removing the badge removes both — and
    // undoing the merge brings back two independent selections.
    expect([...result[0].storedKeys].sort()).toEqual(["identity:a", "identity:b"]);
    // Two papers, credited once each, under the one person they now are.
    expect(result[0].documentCount).toBe(2);
  });
});

describe("toggling an author target", () => {
  const papers = [paper("p1", ["A One"]), paper("p2", ["B Two"])];

  it("adds a new selection with the label the user just read", () => {
    const next = toggleAuthorSelection([], [], { key: "mention:a one", label: "A One" });
    expect(next).toEqual([{ key: "mention:a one", label: "A One" }]);
  });

  it("removes every stored key that resolves to the removed badge", () => {
    // Otherwise deselecting a merged pair would drop one key and leave the
    // other, and the badge would come straight back.
    const selections = [
      { key: "identity:a", label: "A One" },
      { key: "identity:b", label: "B Two" },
    ];
    const reconciled = reconcile(
      selections,
      papers,
      dataset({
        identities: [
          { id: "a", preferred_name: "A One" },
          { id: "b", preferred_name: "B Two" },
        ],
        links: [link("a", "p1", 0, "A One"), link("b", "p2", 0, "B Two")],
        merges: [{ source_identity_id: "a", target_identity_id: "b" }],
      }),
    );

    const next = toggleAuthorSelection(selections, reconciled, {
      key: "identity:b",
      label: "B Two",
    });
    expect(next).toEqual([]);
  });

  it("pins the siblings of an expanded selection instead of taking them with it", () => {
    // One spelling resolved two ways shares a single stored key. Removing one
    // descendant must not silently remove the other, so the survivor is first
    // given an explicit key of its own.
    const papers = [paper("p1", ["J Smith"]), paper("p2", ["J Smith"])];
    const selections = [{ key: "mention:j smith", label: "J Smith" }];
    const reconciled = reconcile(
      selections,
      papers,
      dataset({
        identities: [{ id: "x", preferred_name: "Jane Smith" }],
        links: [link("x", "p1", 0, "J Smith")],
      }),
    );
    expect(reconciled).toHaveLength(2);

    const next = toggleAuthorSelection(selections, reconciled, {
      key: "identity:x",
      label: "Jane Smith",
    });

    // Jane is gone; the still-unresolved half of the same spelling survives,
    // now addressed in its own right.
    expect(next).toEqual([{ key: "mention:j smith", label: "J Smith" }]);
  });

  it("round-trips: adding then removing returns to nothing selected", () => {
    const added = toggleAuthorSelection([], [], { key: "mention:a one", label: "A One" });
    const reconciled = reconcile(added, papers, dataset({}));
    const removed = toggleAuthorSelection(added, reconciled, {
      key: "mention:a one",
      label: "A One",
    });
    expect(removed).toEqual([]);
  });
});
