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
    expect(identities.removeAlias).toHaveBeenCalledWith("Phillips SM");
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
    fireEvent.click(screen.getByRole("button", { name: /Undo one merge/ }));
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
