import { describe, it, expect, beforeAll, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { AnalyticsContent } from "../AnalyticsContent";
import { useAnalyticsTargets } from "@/hooks/useAnalyticsTargets";
import { makeAuthorProvenance, type AuthorProvenance } from "@/lib/authorProvenance";
import type { AuthorIdentityDataset } from "@/lib/authorIdentity";
import type { Paper } from "@/types/database";

/**
 * AUTHOR-IDENTITY-RESOLUTION-001C — identity-aware Analytics, asserted where a
 * user would see it.
 *
 * The companion file `AnalyticsContent.provenanceDoesNotResolveIdentity.test.tsx`
 * proves the 001B half of the contract: a shared ORCID does NOT group two
 * mentions. This file proves the 001C half — that an explicit user decision
 * DOES, and that undoing it puts things back.
 *
 * Together they pin the boundary the whole feature turns on:
 *
 *     before an explicit action, same ORCID can still be two authors;
 *     after one, they can be one person;
 *     the user's action is the boundary, and nothing else moves it.
 *
 * Everything here goes through the real component and the real selector, not
 * through the pure utility, because the failure this guards against is the
 * grouping being right in `lib/` and wrong on screen.
 */

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <>{children}</>,
    BarChart: ({ data }: { data: Array<{ name: string; count: number }> }) => (
      <ul>
        {data.map((datum) => (
          <li key={datum.name}>{`${datum.name} = ${datum.count}`}</li>
        ))}
      </ul>
    ),
  };
});

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

const SHARED_ORCID = "0000-0002-1825-0097";

function provenanceFor(names: string[], orcid: string | null): AuthorProvenance[] {
  return names.map((name) =>
    makeAuthorProvenance({
      source: "pubmed_api",
      source_field: "Author",
      kind: "personal",
      source_name: name,
      identifiers: orcid ? [{ scheme: "ORCID", value: orcid }] : [],
    }),
  );
}

let paperSeq = 0;
function makePaper(authors: string[], provenance?: AuthorProvenance[] | null): Paper {
  paperSeq += 1;
  return {
    id: `paper-${paperSeq}`,
    user_id: "user-1",
    title: `Paper ${paperSeq}`,
    authors,
    author_provenance: provenance ?? null,
    year: 2020,
    journal: null,
    pmid: null,
    doi: null,
    study_type: null,
    raw_study_type: null,
    statistical_methods: null,
    keywords: [],
    raw_keywords: null,
    mesh_terms: [],
    substances: [],
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
    tldr: null,
    notes: null,
    insert_order: paperSeq,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };
}

function Harness({
  papers,
  identityDataset,
}: {
  papers: Paper[];
  identityDataset?: AuthorIdentityDataset | null;
}) {
  const targets = useAnalyticsTargets();
  return (
    <AnalyticsContent
      papers={papers}
      isLoading={false}
      targets={targets}
      identityDataset={identityDataset}
    />
  );
}

const openAuthors = () =>
  fireEvent.click(screen.getByRole("button", { name: /^Target Authors/ }));

const optionLabels = () =>
  screen
    .getAllByRole("checkbox")
    .map((box) => (box.closest("label") ?? box).textContent ?? "");

/** The "Authors" summary tile value. */
const authorTileCount = () =>
  screen.getByText("Authors").parentElement?.querySelector("p")?.textContent;

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

describe("Analytics collapses authors only after an explicit decision", () => {
  it("keeps two spellings apart while they are unresolved, ORCID or not", () => {
    const papers = [
      makePaper(["Stuart M Phillips"], provenanceFor(["Stuart M Phillips"], SHARED_ORCID)),
      makePaper(["S M Phillips"], provenanceFor(["S M Phillips"], SHARED_ORCID)),
    ];

    render(<Harness papers={papers} identityDataset={makeDataset({})} />);
    expect(authorTileCount()).toBe("2");

    openAuthors();
    expect(optionLabels().sort()).toEqual(["S M Phillips", "Stuart M Phillips"]);
  });

  it("collapses them into one person once both mentions are linked", () => {
    const papers = [
      makePaper(["Stuart M Phillips"], provenanceFor(["Stuart M Phillips"], SHARED_ORCID)),
      makePaper(["S M Phillips"], provenanceFor(["S M Phillips"], SHARED_ORCID)),
    ];
    const [first, second] = papers;

    render(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
          links: [
            link("phillips", first.id, 0, "Stuart M Phillips"),
            link("phillips", second.id, 0, "S M Phillips"),
          ],
        })}
      />,
    );

    expect(authorTileCount()).toBe("1");
    openAuthors();
    expect(optionLabels()).toEqual(["Stuart M Phillips"]);
  });

  it("counts both papers when the resolved identity is selected", () => {
    const papers = [
      makePaper(["Stuart M Phillips"], provenanceFor(["Stuart M Phillips"], SHARED_ORCID)),
      makePaper(["S M Phillips"], provenanceFor(["S M Phillips"], SHARED_ORCID)),
    ];
    const [first, second] = papers;

    render(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
          links: [
            link("phillips", first.id, 0, "Stuart M Phillips"),
            link("phillips", second.id, 0, "S M Phillips"),
          ],
        })}
      />,
    );

    openAuthors();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByText("Stuart M Phillips = 2")).toBeInTheDocument();
  });

  it("splits them again when one mention is unlinked", () => {
    const papers = [
      makePaper(["Stuart M Phillips"], provenanceFor(["Stuart M Phillips"], SHARED_ORCID)),
      makePaper(["S M Phillips"], provenanceFor(["S M Phillips"], SHARED_ORCID)),
    ];
    const [first] = papers;

    render(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
          links: [link("phillips", first.id, 0, "Stuart M Phillips")],
        })}
      />,
    );

    expect(authorTileCount()).toBe("2");
    openAuthors();
    expect(optionLabels().sort()).toEqual(["S M Phillips", "Stuart M Phillips"]);
  });

  it("counts a paper once when two of its mentions resolve to one person", () => {
    const paper = makePaper(["Stuart M Phillips", "S M Phillips"]);

    render(
      <Harness
        papers={[paper]}
        identityDataset={makeDataset({
          identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
          links: [
            link("phillips", paper.id, 0, "Stuart M Phillips"),
            link("phillips", paper.id, 1, "S M Phillips"),
          ],
        })}
      />,
    );

    openAuthors();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByText("Stuart M Phillips = 1")).toBeInTheDocument();
  });
});

describe("Analytics follows the merge graph", () => {
  const papers = [makePaper(["A One"]), makePaper(["B Two"])];
  const identities = [
    { id: "a", preferred_name: "A One" },
    { id: "b", preferred_name: "B Two" },
  ];
  const links = [
    link("a", papers[0].id, 0, "A One"),
    link("b", papers[1].id, 0, "B Two"),
  ];

  it("collapses a merged pair onto the target root", () => {
    render(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities,
          links,
          merges: [{ source_identity_id: "a", target_identity_id: "b" }],
        })}
      />,
    );

    expect(authorTileCount()).toBe("1");
    openAuthors();
    expect(optionLabels()).toEqual(["B Two"]);
  });

  it("separates them again once the merge is undone", () => {
    render(<Harness papers={papers} identityDataset={makeDataset({ identities, links })} />);

    expect(authorTileCount()).toBe("2");
    openAuthors();
    expect(optionLabels().sort()).toEqual(["A One", "B Two"]);
  });
});

describe("Target Authors selection survives an identity rename", () => {
  it("keeps the selection and shows the new label", () => {
    const papers = [makePaper(["Stuart M Phillips"])];
    const links = [link("phillips", papers[0].id, 0, "Stuart M Phillips")];

    const { rerender } = render(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
          links,
        })}
      />,
    );

    openAuthors();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByText("Stuart M Phillips = 1")).toBeInTheDocument();

    // Renaming changes only the display name. The selection is held by identity
    // key, so it must survive — losing it would silently drop the person out of
    // the comparison the user was building.
    rerender(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities: [{ id: "phillips", preferred_name: "S. M. Phillips (lab)" }],
          links,
        })}
      />,
    );

    expect(screen.getByText("S. M. Phillips (lab) = 1")).toBeInTheDocument();
  });
});

describe("Target Authors search reaches a resolved identity by any of its names", () => {
  const papers = [makePaper(["Stuart M Phillips"]), makePaper(["S M Phillips"])];
  const dataset = makeDataset({
    identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
    aliases: [{ id: "a1", identity_id: "phillips", alias: "Phillips SM" }],
    links: [
      link("phillips", papers[0].id, 0, "Stuart M Phillips"),
      link("phillips", papers[1].id, 0, "S M Phillips"),
    ],
  });

  it.each([
    ["its preferred name", "Stuart M. Phillips"],
    ["a manual alias", "Phillips SM"],
    ["a linked source spelling", "S M Phillips"],
  ])("finds it by %s", (_label, query) => {
    render(<Harness papers={papers} identityDataset={dataset} />);
    openAuthors();

    fireEvent.change(screen.getByLabelText("Search target authors"), {
      target: { value: query },
    });
    expect(optionLabels()).toEqual(["Stuart M Phillips"]);
  });

  it("shows no match for an unrelated name", () => {
    render(<Harness papers={papers} identityDataset={dataset} />);
    openAuthors();

    fireEvent.change(screen.getByLabelText("Search target authors"), {
      target: { value: "Jane Roe" },
    });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

describe("Analytics degrades safely when the identity subsystem is unavailable", () => {
  it("groups authors exactly as 001A does when the dataset is null", () => {
    // The Vercel Preview case: a database that predates the 001C migration.
    const papers = [
      makePaper(["Stuart M Phillips"], provenanceFor(["Stuart M Phillips"], SHARED_ORCID)),
      makePaper(["Stuart M. Phillips"], provenanceFor(["Stuart M. Phillips"], SHARED_ORCID)),
      makePaper(["S M Phillips"], provenanceFor(["S M Phillips"], SHARED_ORCID)),
    ];

    render(<Harness papers={papers} identityDataset={null} />);

    // Two entities: the formatting-equivalent pair groups, the initialled
    // spelling stays separate, and the shared ORCID changes neither.
    expect(authorTileCount()).toBe("2");
    openAuthors();
    expect(optionLabels().sort()).toEqual(["S M Phillips", "Stuart M Phillips"]);
  });

  it("offers no identity manager when no identity API is supplied", () => {
    render(<Harness papers={[makePaper(["Stuart M Phillips"])]} identityDataset={null} />);
    expect(
      screen.queryByRole("button", { name: /Manage author identities/ }),
    ).not.toBeInTheDocument();
  });
});

describe("Mixed resolved and unresolved authors", () => {
  it("reports stable counts and options for both kinds at once", () => {
    const papers = [
      makePaper(["Stuart M Phillips", "Jane Roe"]),
      makePaper(["S M Phillips", "Jane Roe"]),
    ];

    render(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities: [{ id: "phillips", preferred_name: "Stuart M Phillips" }],
          links: [
            link("phillips", papers[0].id, 0, "Stuart M Phillips"),
            link("phillips", papers[1].id, 0, "S M Phillips"),
          ],
        })}
      />,
    );

    expect(authorTileCount()).toBe("2");
    openAuthors();
    expect(optionLabels().sort()).toEqual(["Jane Roe", "Stuart M Phillips"]);

    const boxes = screen.getAllByRole("checkbox");
    boxes.forEach((box) => fireEvent.click(box));

    const chart = screen.getByText(/Jane Roe = /).closest("ul")!;
    expect(within(chart).getByText("Jane Roe = 2")).toBeInTheDocument();
    expect(within(chart).getByText("Stuart M Phillips = 2")).toBeInTheDocument();
  });
});
