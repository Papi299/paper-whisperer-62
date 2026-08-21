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
    // The healthy state by default. The read-state tests below override it —
    // and the whole point of those is that "unavailable" and "failed" must not
    // be allowed to look alike.
    readState: "ready" as const,
    canMutate: true,
    retry: vi.fn(),
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
    open(
      [paper("p1", "P1", ["Stuart M Phillips"])],
      stubIdentities({
        dataset: null,
        readState: "unavailable",
        canMutate: false,
        isUnavailable: true,
      }),
    );

    expect(screen.getByText(/not available in this environment yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Unresolved/ })).not.toBeInTheDocument();
    // The message must reassure rather than alarm: nothing else is broken.
    expect(screen.getByText(/Everything\s+else on this page works normally/i)).toBeInTheDocument();
  });

  it("shows a loading state without claiming there is nothing to resolve", () => {
    open(
      [paper("p1", "P1", ["Stuart M Phillips"])],
      stubIdentities({ readState: "loading", canMutate: false, isLoading: true }),
    );
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
      // Nothing stale at this position, so nothing is being displaced.
      replaceStaleExisting: false,
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
    expect(screen.queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
  });

  it("offers delete once the person is empty", () => {
    const identities = stubIdentities({
      dataset: makeDataset({ identities: [{ id: "empty", preferred_name: "Nobody" }] }),
    });
    open(papers, identities);
    tab(/People/);

    fireEvent.click(screen.getByRole("button", { name: /^Delete / }));
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
    // The accessible name now states BOTH ends, because direction is the whole
    // decision and the visible "Merge into X" says only half of it.
    fireEvent.click(
      screen.getByRole("button", { name: "Merge Stuart M Phillips into Stu Phillips" }),
    );
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

/**
 * Select a person by pressing the ROW that names them, not a control inside it.
 *
 * Deliberately not `fireEvent.click(radio)`. The defect this surface was rebuilt
 * for was an affordance the DOM could reach and a person could not, so the test
 * presses what the user presses — the row body — and relies on the row being a
 * real `<label>` for a real radio to turn that into a selection.
 */
function selectPerson(name: RegExp | string): HTMLInputElement {
  const radio = screen.getByRole("radio", { name }) as HTMLInputElement;
  const row = radio.closest("label");
  expect(row).not.toBeNull();
  fireEvent.click(row!);
  return radio;
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
    selectPerson(/^Stuart M Phillips/);

    // Choosing does not commit. The decision is still one deliberate step away.
    expect(identities.linkMention).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Link Jane Roe to Stuart M Phillips" }),
    );

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
    expect(screen.getByRole("radio", { name: /^Alex R Mercer/ })).toBeInTheDocument();
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
    selectPerson(/^Alex R Mercer/);

    // Both values are stated so the user can check them; neither is judged.
    const warning = screen.getByText(new RegExp(`This mention states ORCID ${ORCID_X}`));
    expect(warning).toHaveTextContent(ORCID_Y);
    expect(warning).toHaveTextContent(/Paperlume did not suggest this match/i);
    expect(warning).toHaveTextContent(/Continuing is your decision/i);
    expect(document.body.textContent).not.toMatch(/incorrect|wrong ORCID|invalid ORCID/i);

    fireEvent.click(
      screen.getByRole("button", { name: "Link Alex R Mercer to Alex R Mercer" }),
    );
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
    selectPerson(/^Stuart M Phillips/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(identities.linkMention).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Link Jane Roe to Stuart M Phillips" }),
    ).not.toBeInTheDocument();
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
    // The accessible name of each option is the row's own text: the preferred
    // name plus the evidence that tells two people of that name apart.
    const choices = screen
      .getAllByRole("radio", { name: /^John Smith/ })
      .map((radio) => radio.closest("label")?.textContent ?? "");

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

/* ═══════════════════════════════════════════════════════════════════════════
 * Choosing an existing person is a usable interaction
 *
 * AUTHOR-IDENTITY-PICKER-USABILITY-001. The owner opened this chooser in
 * Production, saw the three people they had created, and could not select any of
 * them. Nothing was broken in the DOM: every option existed, carried an
 * accessible name, and answered a programmatic click. It was the LAYOUT that was
 * wrong — selection lived in a small button at the end of a `nowrap` row, and a
 * nowrap row inside a Radix scroll viewport is not clipped by it but widens it,
 * carrying whatever sits at the end of the row outside the visible area, on an
 * axis with no scrollbar. Automation reached it by setting `scrollLeft` itself;
 * a person had no way to.
 *
 * These tests hold the interaction contract that came out of that: the row IS
 * the affordance, selection and confirmation are separate, and nothing reaches
 * the server until the second step. The GEOMETRY half of the contract — that no
 * affordance can leave the visible picker — needs a real layout engine and lives
 * in `e2e/author-identity.spec.ts`.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("AuthorIdentityManager — the existing-person chooser is usable", () => {
  const THREE = [
    { id: "schoenfeld", preferred_name: "Brad J Schoenfeld" },
    { id: "burke", preferred_name: "Louise M Burke" },
    { id: "phillips", preferred_name: "Stuart M Phillips" },
  ];

  /** The owner's shape: three people already created, one mention undecided. */
  function threePeople() {
    return stubIdentities({
      dataset: makeDataset({
        identities: THREE,
        links: [
          link("schoenfeld", "p1", 0, "Brad J Schoenfeld"),
          link("burke", "p2", 0, "Louise M Burke"),
          link("phillips", "p3", 0, "Stuart M Phillips"),
        ],
      }),
    });
  }

  const threePapers = [
    paper("p1", "P1", ["Brad J Schoenfeld"]),
    paper("p2", "P2", ["Louise M Burke"]),
    paper("p3", "P3", ["Stuart M Phillips"]),
    paper("p4", "P4", ["Stuart Phillips"]),
  ];

  it("asks who the mention is, and says nothing will change yet", () => {
    open(threePapers, threePeople());
    openPicker("Stuart Phillips");

    // The question names the mention being resolved, not a generic prompt.
    const group = screen.getByRole("radiogroup", { name: "Who is Stuart Phillips?" });
    expect(group).toBeInTheDocument();
    expect(
      screen.getByText(/Select an existing person below\. Nothing will be changed until you confirm\./),
    ).toBeInTheDocument();
  });

  it("offers every existing person as a selectable option", () => {
    open(threePapers, threePeople());
    openPicker("Stuart Phillips");

    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(3);

    for (const name of ["Brad J Schoenfeld", "Louise M Burke", "Stuart M Phillips"]) {
      const option = screen.getByRole("radio", { name: new RegExp(`^${name}`) });
      expect(option).not.toBeDisabled();
      expect(option).not.toBeChecked();
      // The pressable region is the row that carries the name, so an affordance
      // can only become unreachable by taking the person's name with it.
      expect(option.closest("label")).toHaveTextContent(name);
    }
  });

  it("selects the person whose row was pressed, and asks the server nothing", () => {
    const identities = threePeople();
    open(threePapers, identities);
    openPicker("Stuart Phillips");

    const chosen = selectPerson(/^Stuart M Phillips/);

    expect(chosen).toBeChecked();
    expect(screen.getByRole("radio", { name: /^Brad J Schoenfeld/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /^Louise M Burke/ })).not.toBeChecked();
    // Selecting is not deciding.
    expect(identities.linkMention).not.toHaveBeenCalled();
  });

  it("names both sides of the decision on the button that commits it", () => {
    const identities = threePeople();
    open(threePapers, identities);
    openPicker("Stuart Phillips");
    selectPerson(/^Stuart M Phillips/);

    expect(
      screen.getByRole("button", { name: "Link Stuart Phillips to Stuart M Phillips" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Stuart Phillips on this paper will be recorded as Stuart M Phillips."),
    ).toBeInTheDocument();
    expect(identities.linkMention).not.toHaveBeenCalled();
  });

  it("links exactly once, and only on the confirmation", () => {
    const identities = threePeople();
    open(threePapers, identities);
    openPicker("Stuart Phillips");
    selectPerson(/^Stuart M Phillips/);

    fireEvent.click(
      screen.getByRole("button", { name: "Link Stuart Phillips to Stuart M Phillips" }),
    );

    expect(identities.linkMention).toHaveBeenCalledTimes(1);
    expect(identities.linkMention).toHaveBeenCalledWith({
      paperId: "p4",
      authorIndex: 0,
      expectedAuthor: "Stuart Phillips",
      identityId: "phillips",
      resolutionBasis: "manual",
      replaceExisting: false,
    });
  });

  it("writes nothing when a selected chooser is cancelled", () => {
    const identities = threePeople();
    open(threePapers, identities);
    openPicker("Stuart Phillips");
    selectPerson(/^Stuart M Phillips/);

    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);

    expect(identities.linkMention).not.toHaveBeenCalled();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("links the person selected last, having written nothing on the way there", () => {
    const identities = threePeople();
    open(threePapers, identities);
    openPicker("Stuart Phillips");

    selectPerson(/^Brad J Schoenfeld/);
    expect(identities.linkMention).not.toHaveBeenCalled();

    // Changing your mind is free, and does not close the chooser.
    selectPerson(/^Louise M Burke/);
    expect(identities.linkMention).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /^Brad J Schoenfeld/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /^Louise M Burke/ })).toBeChecked();

    fireEvent.click(
      screen.getByRole("button", { name: "Link Stuart Phillips to Louise M Burke" }),
    );

    expect(identities.linkMention).toHaveBeenCalledTimes(1);
    expect(identities.linkMention).toHaveBeenCalledWith(
      expect.objectContaining({ identityId: "burke" }),
    );
    // The person passed over is not linked, and never was.
    expect(identities.linkMention).not.toHaveBeenCalledWith(
      expect.objectContaining({ identityId: "schoenfeld" }),
    );
  });

  it("keeps long evidence in the row rather than on one unwrappable line", () => {
    // The exact shape of the owner's data: a short name against a long title.
    // `truncate` is what made the row nowrap, and a nowrap row is what pushed
    // the affordance out of the viewport, so the option's own text must not use
    // it. The visible consequence is asserted for real in the E2E spec.
    const longTitle =
      "Resistance training volume enhances muscle hypertrophy but not strength in trained men: a systematic review and meta-analysis of dose-response relationships";
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
    });

    open(
      [paper("p1", longTitle, ["Stuart M Phillips"]), paper("p2", "P2", ["Stuart Phillips"])],
      identities,
    );
    openPicker("Stuart Phillips");

    const row = screen.getByRole("radio", { name: /^Stuart M Phillips/ }).closest("label")!;
    expect(row).toHaveTextContent(longTitle.slice(0, 40));
    for (const node of row.querySelectorAll("*")) {
      expect(node.className.toString()).not.toMatch(/\btruncate\b|\bwhitespace-nowrap\b/);
    }

    // And the affordance is still the row, not something after the long text.
    fireEvent.click(row);
    expect(screen.getByRole("radio", { name: /^Stuart M Phillips/ })).toBeChecked();
  });

  it("keeps a selection while the search hides it, and brings it back", () => {
    // Searching changes the view, not the decision. Discarding a selection
    // because the user typed would silently throw away a choice they made.
    const identities = threePeople();
    open(threePapers, identities);
    openPicker("Stuart Phillips");
    selectPerson(/^Stuart M Phillips/);

    const search = screen.getByLabelText("Search people to link Stuart Phillips to");
    fireEvent.change(search, { target: { value: "Burke" } });

    expect(screen.queryByRole("radio", { name: /^Stuart M Phillips/ })).not.toBeInTheDocument();
    // The confirmation still names the person, so the selection is never silent.
    expect(
      screen.getByRole("button", { name: "Link Stuart Phillips to Stuart M Phillips" }),
    ).toBeInTheDocument();
    expect(identities.linkMention).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("radio", { name: /^Stuart M Phillips/ })).toBeChecked();
  });

  it("exposes no identity id as the way to tell two people apart", () => {
    open(threePapers, threePeople());
    openPicker("Stuart Phillips");

    const group = screen.getByRole("radiogroup", { name: "Who is Stuart Phillips?" });
    for (const id of THREE.map((identity) => identity.id)) {
      expect(group.textContent ?? "").not.toContain(id);
    }
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
    selectPerson(/^B Two/);

    // Direction is spelled out, because the target's name becomes the group's.
    expect(screen.getByText(/Merge A One into B Two\./)).toBeInTheDocument();
    expect(identities.mergeIdentities).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Merge A One into B Two" }));
    expect(identities.mergeIdentities).toHaveBeenCalledWith("a", "b");
  });

  it("warns about contradicting identifiers without refusing the merge", () => {
    const identities = unrelatedPair();
    open(unrelatedPapers, identities);

    tab(/People/);
    fireEvent.click(screen.getByRole("button", { name: "Merge A One into another person" }));
    selectPerson(/^B Two/);

    const warning = screen.getByText(new RegExp(`A One is linked to papers stating ORCID ${ORCID_X}`));
    expect(warning).toHaveTextContent(ORCID_Y);
    expect(warning).toHaveTextContent(/Continuing is your decision/i);

    fireEvent.click(screen.getByRole("button", { name: "Merge A One into B Two" }));
    expect(identities.mergeIdentities).toHaveBeenCalledWith("a", "b");
  });

  it("writes nothing when the merge confirmation is cancelled", () => {
    const identities = unrelatedPair();
    open(unrelatedPapers, identities);

    tab(/People/);
    fireEvent.click(screen.getByRole("button", { name: "Merge A One into another person" }));
    selectPerson(/^B Two/);
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);

    expect(identities.mergeIdentities).not.toHaveBeenCalled();
  });

  it("never offers a person as a target for themselves", () => {
    const identities = unrelatedPair();
    open(unrelatedPapers, identities);

    tab(/People/);
    fireEvent.click(screen.getByRole("button", { name: "Merge A One into another person" }));

    expect(screen.queryByRole("radio", { name: /^A One/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^B Two/ })).toBeInTheDocument();
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

    expect(screen.queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.getByText(/Linked mentions \(1\)/)).toBeInTheDocument();
  });

  it("keeps the person findable by a spelling only the hidden paper carries", () => {
    const identities = stubIdentities({ dataset: DATA, linkedPapers: [HIDDEN_PAPER] });
    open([paper("visible", "Visible paper", ["Jane Roe"])], identities);

    openPicker("Jane Roe");
    fireEvent.change(screen.getByLabelText("Search people to link Jane Roe to"), {
      target: { value: "Stuart M Phillips" },
    });

    expect(screen.getByRole("radio", { name: /^Stuart M Phillips/ })).toBeInTheDocument();
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

/* ═══════════════════════════════════════════════════════════════════════════
 * A failed read is a failed read
 *
 * `dataset === null` has two meanings that must never be rendered alike: the
 * 001C subsystem is not installed here, or the user's decisions could not be
 * read. The first is benign and warrants no error language; the second, dressed
 * up as the first, tells a user with saved people that they have none.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("AuthorIdentityManager — real read failures", () => {
  function failed(overrides: Partial<IdentitiesApi> = {}) {
    return stubIdentities({
      dataset: null,
      readState: "failed",
      canMutate: false,
      isUnavailable: false,
      error: new Error("permission denied for table author_identities"),
      ...overrides,
    });
  }

  it("says the identities could not be loaded, and offers a retry", () => {
    const identities = failed();
    open([paper("p1", "P1", ["Stuart M Phillips"])], identities);

    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(identities.retry).toHaveBeenCalledTimes(1);
  });

  it("never presents a failure as the not-installed-here case", () => {
    open([paper("p1", "P1", ["Stuart M Phillips"])], failed());

    expect(
      screen.queryByText(/not available in this environment yet/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Everything\s+else on this page works normally/i))
      .not.toBeInTheDocument();
  });

  it("offers no identity controls at all while the graph is unknown", () => {
    open([paper("p1", "P1", ["Stuart M Phillips"])], failed());

    // No tabs means no unresolved list claiming the user has decided nothing.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create a new person/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Link to/ })).not.toBeInTheDocument();
  });

  it("shows no raw database text to the user", () => {
    open([paper("p1", "P1", ["Stuart M Phillips"])], failed());

    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toMatch(/permission denied/i);
    expect(rendered).not.toMatch(/42501|PGRST|relation|pg_/);
  });
});

describe("AuthorIdentityManager — a stale graph is shown but not edited", () => {
  function stale() {
    return stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
      readState: "stale",
      canMutate: false,
      error: new Error("Failed to fetch"),
    });
  }

  it("keeps the last known-good people on screen rather than discarding them", () => {
    open([paper("p1", "P1", ["Stuart M Phillips"])], stale());
    tab(/People/);

    expect(screen.getByLabelText("Name for Stuart M Phillips")).toBeInTheDocument();
  });

  it("says plainly that it is last-known and offers a retry", () => {
    const identities = stale();
    open([paper("p1", "P1", ["Stuart M Phillips"])], identities);

    expect(screen.getByText(/last author identities that loaded successfully/i))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(identities.retry).toHaveBeenCalledTimes(1);
  });

  it("disables every decision, because editing could displace a newer one", () => {
    const identities = stale();
    open(
      [paper("p1", "P1", ["Stuart M Phillips"]), paper("p2", "P2", ["Jane Roe"])],
      identities,
    );

    expect(screen.getByRole("button", { name: /Create a new person/ })).toBeDisabled();

    tab(/People/);
    expect(screen.getByRole("button", { name: /^Unlink$/ })).toBeDisabled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Two people called John Smith
 *
 * An exact shared name is itself duplicate evidence, so the Duplicates tab is
 * precisely where two legitimately same-named people meet. "Merge into John
 * Smith" twice over asks the user to pick blind between the two records they
 * are deciding the fate of.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("AuthorIdentityManager — same-name duplicate actions", () => {
  /** Two `John Smith` identities, told apart only by their own evidence. */
  function sameNamePair() {
    return stubIdentities({
      dataset: makeDataset({
        identities: [
          { id: "smith-a", preferred_name: "John Smith" },
          { id: "smith-b", preferred_name: "John Smith" },
        ],
        aliases: [{ id: "al", identity_id: "smith-a", alias: "Jack Smith" }],
        links: [link("smith-a", "p1", 0, "John Smith"), link("smith-b", "p2", 0, "John Smith")],
      }),
    });
  }

  const sameNamePapers = [
    paper("p1", "First paper", ["John Smith"], [personal("John Smith", ORCID_X)]),
    paper("p2", "Second paper", ["John Smith"], [personal("John Smith", ORCID_X)]),
  ];

  it("gives both merge directions distinct accessible names", () => {
    open(sameNamePapers, sameNamePair());
    tab(/Duplicates/);

    const merges = screen
      .getAllByRole("button", { name: /^Merge / })
      .map((button) => button.getAttribute("aria-label") ?? "");

    expect(merges).toHaveLength(2);
    expect(new Set(merges).size).toBe(2);
    // Each names BOTH ends, so direction is never inferred from DOM order.
    for (const label of merges) {
      expect(label).toMatch(/ into /);
      expect(label).not.toMatch(/smith-a|smith-b/);
    }
  });

  it("distinguishes the two sides visually with their own evidence", () => {
    open(sameNamePapers, sameNamePair());
    tab(/Duplicates/);

    const visible = screen
      .getAllByRole("button", { name: /^Merge / })
      .map((button) => button.textContent ?? "");

    expect(new Set(visible).size).toBe(2);
    expect(visible.some((text) => text.includes("Jack Smith"))).toBe(true);
  });

  it("sends the right source and target for each direction", () => {
    const identities = sameNamePair();
    open(sameNamePapers, identities);
    tab(/Duplicates/);

    const [first, second] = screen.getAllByRole("button", { name: /^Merge / });
    const firstLabel = first.getAttribute("aria-label") ?? "";

    fireEvent.click(first);
    // The label states the direction; the call must match it. Which of the two
    // is rendered first is not something this test should depend on.
    const expected = firstLabel.includes("Jack Smith") && firstLabel.indexOf("Jack Smith") < firstLabel.indexOf(" into ")
      ? ["smith-a", "smith-b"]
      : ["smith-b", "smith-a"];
    expect(identities.mergeIdentities).toHaveBeenCalledWith(expected[0], expected[1]);

    fireEvent.click(second);
    expect(identities.mergeIdentities).toHaveBeenCalledWith(expected[1], expected[0]);
  });

  it("falls back to creation order when two people are otherwise identical", () => {
    // Same name, no ORCIDs, no aliases, nothing linked — a real state, reached
    // by creating two people and then unlinking both. Their shared name is still
    // duplicate evidence, so they are still offered as a pair; creation order is
    // the only true thing left that separates them, and it beats a UUID.
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [
          { id: "twin-a", preferred_name: "John Smith" },
          { id: "twin-b", preferred_name: "John Smith" },
        ],
      }),
    });

    open([paper("p1", "First paper", ["Someone Else"])], identities);
    tab(/Duplicates/);

    const merges = screen
      .getAllByRole("button", { name: /^Merge / })
      .map((button) => button.getAttribute("aria-label") ?? "");

    expect(new Set(merges).size).toBe(2);
    expect(merges.some((label) => label.includes("created 1st"))).toBe(true);
    expect(merges.some((label) => label.includes("created 2nd"))).toBe(true);
    for (const label of merges) expect(label).not.toMatch(/twin-a|twin-b/);
  });

  it("keeps ordinary different-name duplicates concise", () => {
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

    // The names already distinguish them, so the button text stays short.
    expect(screen.getByRole("button", { name: "Merge Stuart M Phillips into Stu Phillips" }))
      .toHaveTextContent("Merge into Stu Phillips");
  });

  it("distinguishes identical people in the manual chooser too", () => {
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [
          { id: "twin-a", preferred_name: "John Smith" },
          { id: "twin-b", preferred_name: "John Smith" },
        ],
      }),
    });

    open([paper("p3", "Third paper", ["Jane Roe"])], identities);

    openPicker("Jane Roe");
    const choices = screen
      .getAllByRole("radio", { name: /^John Smith/ })
      .map((radio) => radio.closest("label")?.textContent ?? "");

    expect(choices).toHaveLength(2);
    expect(new Set(choices).size).toBe(2);
    for (const label of choices) expect(label).not.toMatch(/twin-a|twin-b/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Repairing a stale saved link
 *
 * The database makes these unreachable — a trigger clears a paper's links the
 * moment its authors change. This is about what a user can DO if one survives
 * anyway, because the previous behaviour offered actions that could only fail.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("AuthorIdentityManager — stale saved links can be repaired", () => {
  it("lets Create a new person repair a stale row, not just Link", () => {
    // Previously this button was offered and could only ever collide with the
    // unique (paper_id, author_index) constraint: the UI said "unresolved" and
    // every action it gave the user was impossible.
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "old", preferred_name: "Old Person" }],
        links: [link("old", "p1", 0, "Author As Written Before")],
      }),
    });

    open([paper("p1", "P1", ["Current Author"])], identities);

    expect(screen.getByText(/no longer match/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Create a new person/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Create person$/ }));

    expect(identities.createIdentityFromMention).toHaveBeenCalledWith(
      expect.objectContaining({
        paperId: "p1",
        authorIndex: 0,
        expectedAuthor: "Current Author",
        replaceStaleExisting: true,
      }),
    );
  });

  it("offers an explicit removal for a row whose author position is gone", () => {
    // Nothing can render a mention for it, so no ordinary action reaches it —
    // and its surviving row keeps the person non-empty and undeletable.
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "old", preferred_name: "Old Person" }],
        links: [link("old", "p1", 7, "Author At A Gone Position")],
      }),
      linkedPapers: [paper("p1", "Owned paper", ["Only Author"])],
    });

    open([paper("p1", "Owned paper", ["Only Author"])], identities);

    const remove = screen.getByRole("button", {
      name: "Remove stale saved link for Author At A Gone Position on Owned paper",
    });
    // The row is described in terms the user can recognise before acting.
    expect(screen.getByText(/Author At A Gone Position/)).toBeInTheDocument();
    expect(screen.getByText(/that author position no longer exists/i)).toBeInTheDocument();

    fireEvent.click(remove);
    expect(identities.unlinkMention).toHaveBeenCalledWith("p1", 7);
  });

  it("removes nothing until the user asks", () => {
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "old", preferred_name: "Old Person" }],
        links: [link("old", "p1", 7, "Author At A Gone Position")],
      }),
      linkedPapers: [paper("p1", "Owned paper", ["Only Author"])],
    });

    open([paper("p1", "Owned paper", ["Only Author"])], identities);

    // Detection is read-only. A background effect that quietly deleted rows the
    // frontend disliked would be Paperlume editing identity history on a hunch.
    expect(identities.unlinkMention).not.toHaveBeenCalled();
    expect(identities.createIdentityFromMention).not.toHaveBeenCalled();
    expect(identities.linkMention).not.toHaveBeenCalled();
  });

  it("says nothing about stale links when every link is valid", () => {
    const identities = stubIdentities({
      dataset: makeDataset({
        identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
        links: [link("phillips", "p1", 0, "Stuart M Phillips")],
      }),
    });

    open([paper("p1", "P1", ["Stuart M Phillips"])], identities);

    expect(screen.queryByText(/no longer match/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Remove stale saved link/ }),
    ).not.toBeInTheDocument();
  });
});
