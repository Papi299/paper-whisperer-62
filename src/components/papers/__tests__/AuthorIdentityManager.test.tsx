import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { AuthorIdentityManager } from "../AuthorIdentityManager";
import type { useAuthorIdentities } from "@/hooks/useAuthorIdentities";
import { makeAuthorProvenance, type AuthorProvenance } from "@/lib/authorProvenance";
import type { AuthorIdentityDataset, AuthorIdentityPaper } from "@/lib/authorIdentity";

/**
 * The author identity management surface.
 *
 * The tests are organized around what the surface is allowed to CLAIM, because
 * that is what the feature can most easily get wrong. A suggestion must read as
 * a suggestion, an ORCID must be described as evidence rather than verification,
 * and no rendering path may resolve an author on the user's behalf. The
 * behavioural tests (create, link, unlink, rename, alias, merge, undo) then check
 * that pressing a button asks the server for exactly that one thing.
 *
 * Nothing here touches the network: the identity API is a plain stub, which is
 * also how the "not installed in this environment" state is exercised.
 */

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const ORCID_X = "0000-0002-1825-0097";
const ORCID_Y = "0000-0003-0945-2970";

type IdentitiesApi = ReturnType<typeof useAuthorIdentities>;

function personal(name: string, orcid: string | null): AuthorProvenance {
  return makeAuthorProvenance({
    source: "pubmed_api",
    source_field: "Author",
    kind: "personal",
    source_name: name,
    identifiers: orcid ? [{ scheme: "ORCID", value: orcid }] : [],
  });
}

function collective(name: string): AuthorProvenance {
  return makeAuthorProvenance({
    source: "pubmed_api",
    source_field: "CollectiveName",
    kind: "collective",
    source_name: name,
    collective_name: name,
  });
}

function paper(
  id: string,
  title: string,
  authors: string[],
  provenance?: AuthorProvenance[] | null,
): AuthorIdentityPaper {
  return { id, title, authors, author_provenance: provenance ?? null, year: 2024, journal: "J Test" };
}

function link(identityId: string, paperId: string, authorIndex: number, snapshot: string) {
  return {
    id: `${paperId}:${authorIndex}`,
    identity_id: identityId,
    paper_id: paperId,
    author_index: authorIndex,
    author_name_snapshot: snapshot,
    resolution_basis: "manual" as const,
  };
}

function makeDataset(parts: Partial<AuthorIdentityDataset>): AuthorIdentityDataset {
  return {
    identities: parts.identities ?? [],
    aliases: parts.aliases ?? [],
    links: parts.links ?? [],
    merges: parts.merges ?? [],
  };
}

/** A stub identity API that records what the surface asked the server to do. */
function stubIdentities(overrides: Partial<IdentitiesApi> = {}): IdentitiesApi {
  return {
    dataset: makeDataset({}),
    // Evidence defaults to empty; a test that needs user-wide evidence beyond
    // the papers it renders supplies it explicitly.
    linkedPapers: [],
    isLoading: false,
    isUnavailable: false,
    error: null,
    refresh: vi.fn(),
    createIdentityFromMention: vi.fn().mockResolvedValue("new-identity"),
    linkMention: vi.fn().mockResolvedValue(undefined),
    unlinkMention: vi.fn().mockResolvedValue(undefined),
    renameIdentity: vi.fn().mockResolvedValue(undefined),
    addAlias: vi.fn().mockResolvedValue(undefined),
    removeAlias: vi.fn().mockResolvedValue(undefined),
    mergeIdentities: vi.fn().mockResolvedValue(undefined),
    unmergeIdentity: vi.fn().mockResolvedValue(undefined),
    deleteIdentity: vi.fn().mockResolvedValue(undefined),
    isMutating: false,
    ...overrides,
  };
}

function open(
  papers: AuthorIdentityPaper[],
  identities: IdentitiesApi,
) {
  return render(
    <AuthorIdentityManager
      papers={papers}
      identities={identities}
      open
      onOpenChange={vi.fn()}
    />,
  );
}

/**
 * Switch tabs.
 *
 * Radix's `TabsTrigger` activates on `mousedown`, not on a synthesized `click`,
 * so a plain click leaves the first panel mounted and every assertion below it
 * looks for content that was never rendered.
 */
const tab = (name: RegExp) => {
  const trigger = screen.getByRole("tab", { name });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
};

describe("AuthorIdentityManager — availability", () => {
  it("reports the subsystem as unavailable without offering any action", () => {
    open([paper("p1", "P1", ["Stuart M Phillips"])], stubIdentities({ dataset: null, isUnavailable: true }));

    expect(screen.getByText(/not available in this environment yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Unresolved/ })).not.toBeInTheDocument();
    // The message must reassure rather than alarm: nothing else is broken.
    expect(screen.getByText(/Everything\s+else on this page works normally/i)).toBeInTheDocument();
  });

  it("shows a loading state without claiming there is nothing to resolve", () => {
    open([paper("p1", "P1", ["Stuart M Phillips"])], stubIdentities({ isLoading: true }));
    expect(screen.getByText(/Loading author identities/i)).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("describes itself as suggesting rather than deciding", () => {
    open([paper("p1", "P1", ["Stuart M Phillips"])], stubIdentities());
    expect(screen.getByText(/never links anyone for you/i)).toBeInTheDocument();
  });
});

describe("AuthorIdentityManager — unresolved mentions", () => {
  it("lists an unresolved mention with the context needed to decide", () => {
    open(
      [paper("p1", "Muscle protein synthesis", ["Stuart M Phillips"], [personal("Stuart M Phillips", ORCID_X)])],
      stubIdentities(),
    );

    expect(screen.getByText("Stuart M Phillips")).toBeInTheDocument();
    expect(screen.getByText(/Muscle protein synthesis/)).toBeInTheDocument();
    expect(screen.getByText(`ORCID ${ORCID_X}`)).toBeInTheDocument();
  });

  it("omits an explicitly collective author, which cannot become a person", () => {
    open(
      [
        paper(
          "p1",
          "P1",
          ["Stuart M Phillips", "The GRADE Working Group"],
          [personal("Stuart M Phillips", null), collective("The GRADE Working Group")],
        ),
      ],
      stubIdentities(),
    );

    expect(screen.getByText("Stuart M Phillips")).toBeInTheDocument();
    expect(screen.queryByText("The GRADE Working Group")).not.toBeInTheDocument();
  });

  it("offers a Same ORCID suggestion without applying it", () => {
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
    });

    open(
      [
        paper("p1", "P1", ["Stuart M Phillips"], [personal("Stuart M Phillips", ORCID_X)]),
        paper("p2", "P2", ["S M Phillips"], [personal("S M Phillips", ORCID_X)]),
      ],
      identities,
    );

    const button = screen.getByRole("button", { name: /Link to Stuart M Phillips/ });
    expect(within(button).getByText("Same ORCID")).toBeInTheDocument();
    // Rendering a suggestion must never be a mutation.
    expect(identities.linkMention).not.toHaveBeenCalled();
  });

  it("labels a weaker match as a name match, not a verified one", () => {
    open(
      [
        paper("p1", "P1", ["Stuart M Phillips"]),
        paper("p2", "P2", ["Stuart M. Phillips"]),
      ],
      stubIdentities({
        dataset: makeDataset({
          identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
          links: [link("phillips", "p1", 0, "Stuart M Phillips")],
        }),
      }),
    );

    expect(screen.getByText("Same normalized name")).toBeInTheDocument();
    expect(screen.queryByText(/verified/i)).not.toBeInTheDocument();
  });

  it("offers no suggestion when the ORCIDs contradict the matching name", () => {
    open(
      [
        paper("p1", "P1", ["Stuart M Phillips"], [personal("Stuart M Phillips", ORCID_X)]),
        paper("p2", "P2", ["Stuart M Phillips"], [personal("Stuart M Phillips", ORCID_Y)]),
      ],
      stubIdentities({
        dataset: makeDataset({
          identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
          links: [link("phillips", "p1", 0, "Stuart M Phillips")],
        }),
      }),
    );

    expect(screen.queryByRole("button", { name: /Link to/ })).not.toBeInTheDocument();
  });

  it("warns when several people match the same evidence", () => {
    open(
      [
        paper("p1", "P1", ["Stuart M Phillips"], [personal("Stuart M Phillips", ORCID_X)]),
        paper("p2", "P2", ["Stu Phillips"], [personal("Stu Phillips", ORCID_X)]),
        paper("p3", "P3", ["S M Phillips"], [personal("S M Phillips", ORCID_X)]),
      ],
      stubIdentities({
        dataset: makeDataset({
          identities: [
            { id: "one", preferred_name: "Stuart M Phillips" },
            { id: "two", preferred_name: "Stu Phillips" },
          ],
          links: [link("one", "p1", 0, "Stuart M Phillips"), link("two", "p2", 0, "Stu Phillips")],
        }),
      }),
    );

    expect(screen.getByText(/More than one person matches this evidence/i)).toBeInTheDocument();
  });

  it("links a mention with the basis that matches the evidence shown", () => {
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
    });

    open(
      [
        paper("p1", "P1", ["Stuart M Phillips"], [personal("Stuart M Phillips", ORCID_X)]),
        paper("p2", "P2", ["S M Phillips"], [personal("S M Phillips", ORCID_X)]),
      ],
      identities,
    );

    fireEvent.click(screen.getByRole("button", { name: /Link to Stuart M Phillips/ }));

    expect(identities.linkMention).toHaveBeenCalledWith({
      paperId: "p2",
      authorIndex: 0,
      expectedAuthor: "S M Phillips",
      identityId: "phillips",
      resolutionBasis: "orcid_candidate",
      // No surviving row for this position, so nothing is being displaced.
      replaceExisting: false,
    });
  });

  it("creates a person from a mention with an editable default name", () => {
    const identities = stubIdentities();
    open([paper("p1", "P1", ["Stuart M Phillips"])], identities);

    fireEvent.click(screen.getByRole("button", { name: /Create a new person/ }));
    const field = screen.getByLabelText("Name for this person");
    expect(field).toHaveValue("Stuart M Phillips");

    fireEvent.change(field, { target: { value: "Stuart Phillips (McMaster)" } });
    fireEvent.click(screen.getByRole("button", { name: /^Create person$/ }));

    expect(identities.createIdentityFromMention).toHaveBeenCalledWith({
      paperId: "p1",
      authorIndex: 0,
      // The exact stored string, so the server's stale-mention guard can compare it.
      expectedAuthor: "Stuart M Phillips",
      preferredName: "Stuart Phillips (McMaster)",
    });
  });

  it("sends the raw stored spelling, not the display-normalized one", () => {
    const identities = stubIdentities();
    open([paper("p1", "P1", ["  Stuart   M Phillips "])], identities);

    fireEvent.click(screen.getByRole("button", { name: /Create a new person/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Create person$/ }));

    expect(identities.createIdentityFromMention).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAuthor: "  Stuart   M Phillips " }),
    );
  });
});

describe("AuthorIdentityManager — people", () => {
  const papers = [paper("p1", "P1", ["Stuart M Phillips"], [personal("Stuart M Phillips", ORCID_X)])];
  const dataset = makeDataset({
    identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
    aliases: [{ id: "a1", identity_id: "phillips", alias: "Phillips SM" }],
    links: [link("phillips", "p1", 0, "Stuart M Phillips")],
  });

  it("shows the person's names, links and identifier evidence", () => {
    open(papers, stubIdentities({ dataset }));
    tab(/People/);

    expect(screen.getByLabelText("Name for Stuart M Phillips")).toHaveValue("Stuart M Phillips");
    expect(screen.getByText("Phillips SM")).toBeInTheDocument();
    expect(screen.getByText(`ORCID ${ORCID_X}`)).toBeInTheDocument();
    expect(screen.getByText(/Linked mentions \(1\)/)).toBeInTheDocument();
  });

  it("never calls a person verified", () => {
    open(papers, stubIdentities({ dataset }));
    tab(/People/);
    expect(screen.queryByText(/verified/i)).not.toBeInTheDocument();
  });

  it("renames on blur without touching anything else", () => {
    const identities = stubIdentities({ dataset });
    open(papers, identities);
    tab(/People/);

    const field = screen.getByLabelText("Name for Stuart M Phillips");
    fireEvent.change(field, { target: { value: "S. M. Phillips" } });
    fireEvent.blur(field);

    expect(identities.renameIdentity).toHaveBeenCalledWith("phillips", "S. M. Phillips");
    expect(identities.linkMention).not.toHaveBeenCalled();
    expect(identities.unlinkMention).not.toHaveBeenCalled();
  });

  it("adds and removes an alias", () => {
    const identities = stubIdentities({ dataset });
    open(papers, identities);
    tab(/People/);

    fireEvent.change(screen.getByLabelText("Add another name for Stuart M Phillips"), {
      target: { value: "Phillips, S M" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(identities.addAlias).toHaveBeenCalledWith("phillips", "Phillips, S M");

    fireEvent.click(screen.getByRole("button", { name: "Remove alias Phillips SM" }));
    // The alias ROW id, not the text: removing an alias deletes a row, and the
    // words are not a key — two rows may carry the same name.
    expect(identities.removeAlias).toHaveBeenCalledWith("a1");
  });

  it("unlinks a mention", () => {
    const identities = stubIdentities({ dataset });
    open(papers, identities);
    tab(/People/);

    fireEvent.click(screen.getByRole("button", { name: /^Unlink$/ }));
    expect(identities.unlinkMention).toHaveBeenCalledWith("p1", 0);
  });

  it("offers delete only for a person carrying nothing", () => {
    open(papers, stubIdentities({ dataset }));
    tab(/People/);
    expect(screen.queryByRole("button", { name: /Delete person/ })).not.toBeInTheDocument();
  });

  it("offers delete once the person is empty", () => {
    const identities = stubIdentities({
      dataset: makeDataset({ identities: [{ id: "empty", preferred_name: "Nobody" }] }),
    });
    open(papers, identities);
    tab(/People/);

    fireEvent.click(screen.getByRole("button", { name: /Delete person/ }));
    expect(identities.deleteIdentity).toHaveBeenCalledWith("empty");
  });

  it("reports conflicting identifier evidence without resolving it", () => {
    open(
      [
        paper("p1", "P1", ["Stuart M Phillips"], [personal("Stuart M Phillips", ORCID_X)]),
        paper("p2", "P2", ["Stuart M Phillips"], [personal("Stuart M Phillips", ORCID_Y)]),
      ],
      stubIdentities({
        dataset: makeDataset({
          identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
          links: [link("phillips", "p1", 0, "Stuart M Phillips"), link("phillips", "p2", 0, "Stuart M Phillips")],
        }),
      }),
    );
    tab(/People/);

    expect(screen.getByText(/Linked papers state different ORCIDs/i)).toBeInTheDocument();
  });

  it("undoes a merge from the merged person's card", () => {
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [
          { id: "a", preferred_name: "A One" },
          { id: "b", preferred_name: "B Two" },
        ],
        links: [link("a", "p1", 0, "Stuart M Phillips")],
        merges: [{ source_identity_id: "a", target_identity_id: "b" }],
      }),
    });
    open(papers, identities);
    tab(/People/);

    expect(screen.getByText("1 merged")).toBeInTheDocument();
    // The control names the member and the target, not "one merge": a cluster
    // can hold several merged members and the user is choosing between edges.
    fireEvent.click(
      screen.getByRole("button", { name: "Undo merge of A One into B Two" }),
    );
    expect(identities.unmergeIdentity).toHaveBeenCalledWith("a");
  });
});

describe("AuthorIdentityManager — duplicates", () => {
  it("explains what a merge does and offers both directions", () => {
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [
          { id: "aaa", preferred_name: "Stuart M Phillips" },
          { id: "bbb", preferred_name: "Stu Phillips" },
        ],
        links: [link("aaa", "p1", 0, "Stuart M Phillips"), link("bbb", "p2", 0, "Stu Phillips")],
      }),
    });

    open(
      [
        paper("p1", "P1", ["Stuart M Phillips"], [personal("Stuart M Phillips", ORCID_X)]),
        paper("p2", "P2", ["Stu Phillips"], [personal("Stu Phillips", ORCID_X)]),
      ],
      identities,
    );
    tab(/Duplicates/);

    expect(screen.getByText(/Merging keeps both records/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Merge into Stu Phillips/ }));
    expect(identities.mergeIdentities).toHaveBeenCalledWith("aaa", "bbb");
  });

  it("says so plainly when there is nothing to review", () => {
    open([paper("p1", "P1", ["Stuart M Phillips"])], stubIdentities());
    tab(/Duplicates/);
    expect(screen.getByText(/No possible duplicates found/i)).toBeInTheDocument();
  });
});

describe("AuthorIdentityManager — failures", () => {
  it("surfaces a failure without retrying and without changing anything", async () => {
    const linkMention = vi.fn().mockRejectedValue(new Error("conflict"));
    const identities = stubIdentities({
      linkMention,
      dataset: makeDataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
    });

    open(
      [
        paper("p1", "P1", ["Stuart M Phillips"], [personal("Stuart M Phillips", ORCID_X)]),
        paper("p2", "P2", ["S M Phillips"], [personal("S M Phillips", ORCID_X)]),
      ],
      identities,
    );

    fireEvent.click(screen.getByRole("button", { name: /Link to Stuart M Phillips/ }));
    await Promise.resolve();

    // Exactly one attempt: a conflict here means another tab already decided,
    // and retrying would overwrite that decision.
    expect(linkMention).toHaveBeenCalledTimes(1);
    // The mention is still listed, so nothing was optimistically resolved.
    expect(screen.getByText("S M Phillips")).toBeInTheDocument();
  });

  it("disables actions while a mutation is in flight", () => {
    open(
      [paper("p1", "P1", ["Stuart M Phillips"])],
      stubIdentities({ isMutating: true }),
    );
    expect(screen.getByRole("button", { name: /Create a new person/ })).toBeDisabled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Manual decisions — the user overriding the algorithm, deliberately
 *
 * Deterministic candidate generation is conservative on purpose: it withholds a
 * name match whenever ORCID evidence contradicts it. That conservatism is
 * ADVICE. Without a manual path it silently becomes policy — the algorithm
 * deciding which of the user's own people the user is permitted to pick — and
 * there are real cases on the other side of it: a source states the wrong iD, a
 * person changed iDs, two records for one human disagree. The user can see
 * that; the application cannot.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Open the manual person chooser on the first unresolved mention. */
function openPicker(mentionName: string) {
  fireEvent.click(
    screen.getByRole("button", { name: `Link ${mentionName} to an existing person` }),
  );
}

describe("AuthorIdentityManager — manual link to an existing person", () => {
  it("links a mention that produced no suggestion at all", () => {
    // Nothing about `Jane Roe` resembles `Stuart M Phillips`, so no candidate
    // exists — and that is exactly when a user most needs to say so themselves.
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
    });

    open(
      [paper("p1", "P1", ["Stuart M Phillips"]), paper("p2", "P2", ["Jane Roe"])],
      identities,
    );

    expect(
      screen.queryByRole("button", { name: /^Link to Stuart M Phillips/ }),
    ).not.toBeInTheDocument();

    openPicker("Jane Roe");
    fireEvent.change(screen.getByLabelText("Search people to link Jane Roe to"), {
      target: { value: "Stuart" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Choose Stuart M Phillips/ }));

    // Choosing does not commit. The decision is still one deliberate step away.
    expect(identities.linkMention).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Link to this person" }));

    expect(identities.linkMention).toHaveBeenCalledWith({
      paperId: "p2",
      authorIndex: 0,
      expectedAuthor: "Jane Roe",
      identityId: "phillips",
      // Chosen by hand, recorded as such — not dressed up as a followed suggestion.
      resolutionBasis: "manual",
      replaceExisting: false,
    });
  });

  it("offers no suggestion but still finds the person when ORCIDs contradict", () => {
    // The paired test the suppression rule needs. Same exact name, conflicting
    // iDs: the automatic candidate is withheld, and the person stays reachable.
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "mercer", preferred_name: "Alex R Mercer" }],
        links: [link("mercer", "p1", 0, "Alex R Mercer")],
      }),
    });

    open(
      [
        paper("p1", "P1", ["Alex R Mercer"], [personal("Alex R Mercer", ORCID_Y)]),
        paper("p2", "P2", ["Alex R Mercer"], [personal("Alex R Mercer", ORCID_X)]),
      ],
      identities,
    );

    expect(
      screen.queryByRole("button", { name: /^Link to Alex R Mercer/ }),
    ).not.toBeInTheDocument();

    openPicker("Alex R Mercer");
    expect(screen.getByRole("button", { name: /^Choose Alex R Mercer/ })).toBeInTheDocument();
  });

  it("shows the contradiction before confirming, and calls neither iD wrong", () => {
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "mercer", preferred_name: "Alex R Mercer" }],
        links: [link("mercer", "p1", 0, "Alex R Mercer")],
      }),
    });

    open(
      [
        paper("p1", "P1", ["Alex R Mercer"], [personal("Alex R Mercer", ORCID_Y)]),
        paper("p2", "P2", ["Alex R Mercer"], [personal("Alex R Mercer", ORCID_X)]),
      ],
      identities,
    );

    openPicker("Alex R Mercer");
    fireEvent.click(screen.getByRole("button", { name: /^Choose Alex R Mercer/ }));

    // Both values are stated so the user can check them; neither is judged.
    const warning = screen.getByText(new RegExp(`This mention states ORCID ${ORCID_X}`));
    expect(warning).toHaveTextContent(ORCID_Y);
    expect(warning).toHaveTextContent(/Paperlume did not suggest this match/i);
    expect(warning).toHaveTextContent(/Continuing is your decision/i);
    expect(document.body.textContent).not.toMatch(/incorrect|wrong ORCID|invalid ORCID/i);

    fireEvent.click(screen.getByRole("button", { name: "Link to this person" }));
    expect(identities.linkMention).toHaveBeenCalledWith(
      expect.objectContaining({ identityId: "mercer", resolutionBasis: "manual" }),
    );
  });

  it("writes nothing when the confirmation is cancelled", () => {
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
    });

    open(
      [paper("p1", "P1", ["Stuart M Phillips"]), paper("p2", "P2", ["Jane Roe"])],
      identities,
    );

    openPicker("Jane Roe");
    fireEvent.click(screen.getByRole("button", { name: /^Choose Stuart M Phillips/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(identities.linkMention).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Link to this person" })).not.toBeInTheDocument();
  });

  it("distinguishes two people who share a preferred name", () => {
    // Preferred names are deliberately not unique. The choice is annotated with
    // the user's own evidence — and never with a UUID, which nobody can read.
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [
          { id: "smith-a", preferred_name: "John Smith" },
          { id: "smith-b", preferred_name: "John Smith" },
        ],
        aliases: [{ id: "al", identity_id: "smith-a", alias: "Jack Smith" }],
        links: [
          link("smith-a", "p1", 0, "John Smith"),
          link("smith-b", "p2", 0, "J Smith"),
        ],
      }),
    });

    open(
      [
        paper("p1", "P1", ["John Smith"], [personal("John Smith", ORCID_X)]),
        paper("p2", "P2", ["J Smith"], [personal("J Smith", ORCID_Y)]),
        paper("p3", "P3", ["Jane Roe"]),
      ],
      identities,
    );

    openPicker("Jane Roe");
    const choices = screen
      .getAllByRole("button", { name: /^Choose John Smith/ })
      .map((button) => button.getAttribute("aria-label") ?? "");

    expect(choices).toHaveLength(2);
    expect(new Set(choices).size).toBe(2);
    expect(choices.some((label) => label.includes("Jack Smith"))).toBe(true);
    expect(choices.some((label) => label.includes(ORCID_X))).toBe(true);
    expect(choices.some((label) => label.includes(ORCID_Y))).toBe(true);
    for (const label of choices) {
      expect(label).not.toContain("smith-a");
      expect(label).not.toContain("smith-b");
    }
  });

  it("offers no manual link when the user has no people yet", () => {
    const identities = stubIdentities({ dataset: makeDataset({}) });
    open([paper("p1", "P1", ["Jane Roe"])], identities);

    expect(
      screen.queryByRole("button", { name: /Link Jane Roe to an existing person/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a new person" })).toBeInTheDocument();
  });
});

describe("AuthorIdentityManager — manual merge of any two people", () => {
  /** Two people with nothing in common: no shared ORCID, no shared name key. */
  function unrelatedPair() {
    return stubIdentities({
      dataset: makeDataset({
        identities: [
          { id: "a", preferred_name: "A One" },
          { id: "b", preferred_name: "B Two" },
        ],
        links: [link("a", "p1", 0, "A One"), link("b", "p2", 0, "B Two")],
      }),
    });
  }

  const unrelatedPapers = [
    paper("p1", "P1", ["A One"], [personal("A One", ORCID_X)]),
    paper("p2", "P2", ["B Two"], [personal("B Two", ORCID_Y)]),
  ];

  it("merges two people the duplicate detector never suggested", () => {
    const identities = unrelatedPair();
    open(unrelatedPapers, identities);

    tab(/Duplicates/);
    expect(screen.getByText(/No possible duplicates found/i)).toBeInTheDocument();

    tab(/People/);
    fireEvent.click(screen.getByRole("button", { name: "Merge A One into another person" }));
    fireEvent.click(screen.getByRole("button", { name: /^Choose B Two/ }));

    // Direction is spelled out, because the target's name becomes the group's.
    expect(screen.getByText(/Merge A One into B Two\./)).toBeInTheDocument();
    expect(identities.mergeIdentities).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Merge into this person" }));
    expect(identities.mergeIdentities).toHaveBeenCalledWith("a", "b");
  });

  it("warns about contradicting identifiers without refusing the merge", () => {
    const identities = unrelatedPair();
    open(unrelatedPapers, identities);

    tab(/People/);
    fireEvent.click(screen.getByRole("button", { name: "Merge A One into another person" }));
    fireEvent.click(screen.getByRole("button", { name: /^Choose B Two/ }));

    const warning = screen.getByText(new RegExp(`A One is linked to papers stating ORCID ${ORCID_X}`));
    expect(warning).toHaveTextContent(ORCID_Y);
    expect(warning).toHaveTextContent(/Continuing is your decision/i);

    fireEvent.click(screen.getByRole("button", { name: "Merge into this person" }));
    expect(identities.mergeIdentities).toHaveBeenCalledWith("a", "b");
  });

  it("writes nothing when the merge confirmation is cancelled", () => {
    const identities = unrelatedPair();
    open(unrelatedPapers, identities);

    tab(/People/);
    fireEvent.click(screen.getByRole("button", { name: "Merge A One into another person" }));
    fireEvent.click(screen.getByRole("button", { name: /^Choose B Two/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);

    expect(identities.mergeIdentities).not.toHaveBeenCalled();
  });

  it("never offers a person as a target for themselves", () => {
    const identities = unrelatedPair();
    open(unrelatedPapers, identities);

    tab(/People/);
    fireEvent.click(screen.getByRole("button", { name: "Merge A One into another person" }));

    expect(screen.queryByRole("button", { name: /^Choose A One/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Choose B Two/ })).toBeInTheDocument();
  });

  it("offers no merge action when there is only one person", () => {
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "a", preferred_name: "A One" }],
        links: [link("a", "p1", 0, "A One")],
      }),
    });
    open([paper("p1", "P1", ["A One"])], identities);

    tab(/People/);
    expect(screen.queryByRole("button", { name: /into another person/ })).not.toBeInTheDocument();
  });
});

describe("AuthorIdentityManager — undoing one merge out of several", () => {
  /** `A → B → C`: both A and B sit under root C. */
  function chain() {
    return stubIdentities({
      dataset: makeDataset({
        identities: [
          { id: "a", preferred_name: "A One" },
          { id: "b", preferred_name: "B Two" },
          { id: "c", preferred_name: "C Three" },
        ],
        links: [link("a", "p1", 0, "A One"), link("b", "p2", 0, "B Two")],
        merges: [
          { source_identity_id: "a", target_identity_id: "b" },
          { source_identity_id: "b", target_identity_id: "c" },
        ],
      }),
    });
  }

  const chainPapers = [paper("p1", "P1", ["A One"]), paper("p2", "P2", ["B Two"])];

  it("names each merge by its member and its direct target", () => {
    open(chainPapers, chain());
    tab(/People/);

    // Not two identical "Undo one merge" controls: A merged into B, B into C,
    // and undoing the wrong one silently regroups the library.
    expect(
      screen.getByRole("button", { name: "Undo merge of A One into B Two" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Undo merge of B Two into C Three" }),
    ).toBeInTheDocument();
  });

  it("reverses exactly the edge the user chose", () => {
    const identities = chain();
    open(chainPapers, identities);
    tab(/People/);

    fireEvent.click(screen.getByRole("button", { name: "Undo merge of A One into B Two" }));

    expect(identities.unmergeIdentity).toHaveBeenCalledTimes(1);
    expect(identities.unmergeIdentity).toHaveBeenCalledWith("a");
  });

  it("distinguishes merged members who share a name, without showing an id", () => {
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [
          { id: "one", preferred_name: "John Smith" },
          { id: "two", preferred_name: "John Smith" },
          { id: "root", preferred_name: "John Smith" },
        ],
        aliases: [{ id: "al", identity_id: "one", alias: "Jack Smith" }],
        links: [link("one", "p1", 0, "John Smith"), link("two", "p2", 0, "J Smith")],
        merges: [
          { source_identity_id: "one", target_identity_id: "root" },
          { source_identity_id: "two", target_identity_id: "root" },
        ],
      }),
    });

    open(
      [
        paper("p1", "P1", ["John Smith"], [personal("John Smith", ORCID_X)]),
        paper("p2", "P2", ["J Smith"], [personal("J Smith", ORCID_Y)]),
      ],
      identities,
    );
    tab(/People/);

    const undoLabels = screen
      .getAllByRole("button", { name: /^Undo merge of John Smith/ })
      .map((button) => button.getAttribute("aria-label") ?? "");

    expect(undoLabels).toHaveLength(2);
    expect(new Set(undoLabels).size).toBe(2);
    expect(undoLabels.some((label) => label.includes("Jack Smith"))).toBe(true);
    expect(undoLabels.some((label) => label.includes(ORCID_X))).toBe(true);
    expect(undoLabels.some((label) => label.includes(ORCID_Y))).toBe(true);
    for (const label of undoLabels) {
      expect(label).not.toMatch(/\broot\b/);
    }
  });
});

describe("AuthorIdentityManager — identity evidence is user-wide", () => {
  /** Identity `sp` links to a paper the Analytics filter is not showing. */
  const HIDDEN_PAPER = paper("hidden", "Hidden paper", ["Stuart M Phillips"], [
    personal("Stuart M Phillips", ORCID_X),
  ]);
  const DATA = makeDataset({
    identities: [{ id: "sp", preferred_name: "Stuart M Phillips" }],
    links: [link("sp", "hidden", 0, "Stuart M Phillips")],
  });

  it("does not offer Delete for a person whose papers are outside the filter", () => {
    // The database counts rows. A UI gating on visible mentions would offer a
    // Delete the RPC then correctly refuses, which reads as a broken button.
    const identities = stubIdentities({ dataset: DATA, linkedPapers: [HIDDEN_PAPER] });
    open([paper("visible", "Visible paper", ["Someone Else"])], identities);
    tab(/People/);

    expect(screen.queryByRole("button", { name: "Delete person" })).not.toBeInTheDocument();
    expect(screen.getByText(/Linked mentions \(1\)/)).toBeInTheDocument();
  });

  it("keeps the person findable by a spelling only the hidden paper carries", () => {
    const identities = stubIdentities({ dataset: DATA, linkedPapers: [HIDDEN_PAPER] });
    open([paper("visible", "Visible paper", ["Jane Roe"])], identities);

    openPicker("Jane Roe");
    fireEvent.change(screen.getByLabelText("Search people to link Jane Roe to"), {
      target: { value: "Stuart M Phillips" },
    });

    expect(screen.getByRole("button", { name: /^Choose Stuart M Phillips/ })).toBeInTheDocument();
  });

  it("offers the ORCID candidate that the out-of-view evidence justifies", () => {
    const identities = stubIdentities({ dataset: DATA, linkedPapers: [HIDDEN_PAPER] });
    open(
      [paper("visible", "Visible paper", ["S M Phillips"], [personal("S M Phillips", ORCID_X)])],
      identities,
    );

    const suggestion = screen.getByRole("button", { name: /^Link to Stuart M Phillips/ });
    expect(suggestion).toHaveTextContent("Same ORCID");
  });
});

describe("AuthorIdentityManager — stale links are reported, not obeyed", () => {
  /** A link whose snapshot no longer matches the author text at its position. */
  const STALE = makeDataset({
    identities: [{ id: "sp", preferred_name: "Stuart M Phillips" }],
    links: [link("sp", "p1", 0, "Stuart M Phillips")],
  });

  it("says so plainly and re-offers the mention as unresolved", () => {
    // Unreachable through the application — a trigger clears every link on a
    // paper the moment its authors change — so this is what surviving that
    // guarantee failing looks like.
    open([paper("p1", "P1", ["Jane Roe"])], stubIdentities({ dataset: STALE }));

    expect(screen.getByText(/1 saved link no longer matches/i)).toBeInTheDocument();
    expect(screen.getByText("Jane Roe")).toBeInTheDocument();
    // The wrong author is not resolved to the person.
    tab(/People/);
    expect(screen.getByText(/Nothing is linked to this person/i)).toBeInTheDocument();
  });

  it("replaces the surviving row rather than colliding with it", () => {
    // The unique (paper_id, author_index) constraint would otherwise reject the
    // user's decision for a reason they can neither see nor fix.
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [
          { id: "sp", preferred_name: "Stuart M Phillips" },
          { id: "roe", preferred_name: "Jane Roe" },
        ],
        links: [link("sp", "p1", 0, "Stuart M Phillips"), link("roe", "p2", 0, "Jane Roe")],
      }),
    });

    open([paper("p1", "P1", ["Jane Roe"]), paper("p2", "P2", ["Jane Roe"])], identities);

    fireEvent.click(screen.getAllByRole("button", { name: /^Link to Jane Roe/ })[0]);

    expect(identities.linkMention).toHaveBeenCalledWith(
      expect.objectContaining({ paperId: "p1", replaceExisting: true }),
    );
  });
});
