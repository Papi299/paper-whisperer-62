import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { AnalyticsContent } from "../AnalyticsContent";
import { useAnalyticsTargets } from "@/hooks/useAnalyticsTargets";
import { makeAuthorProvenance, type AuthorProvenance } from "@/lib/authorProvenance";
import type { AuthorIdentityDataset } from "@/lib/authorIdentity";
import type { Paper } from "@/types/database";

/**
 * A selected author has to keep meaning the same thing while the identity graph
 * moves underneath it.
 *
 * This is the failure mode the pure tests in `lib/__tests__/authorSelection` pin
 * from below and this file pins where a user would actually meet it: on the
 * Analytics screen, through the real selector, with the real hook holding the
 * selection. Every transition below is one the user performs from that very
 * screen — link a mention, merge two people, undo either — so a selection
 * quietly losing its referent looks exactly like a chart going to zero for no
 * reason.
 *
 * The negative half matters as much as the positive half. `identity:<uuid>` and
 * `mention:<001A key>` are how a selection is ADDRESSED, never how it is
 * described, and the last test here holds that line across every rendered string
 * and every accessible name.
 */

const isMobileRef = { current: false };
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => isMobileRef.current,
}));

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

beforeEach(() => {
  isMobileRef.current = false;
});

const ORCID_X = "0000-0002-1825-0097";
const IDENTITY_A = "9a1f0c22-0000-4000-8000-00000000000a";
const IDENTITY_B = "9a1f0c22-0000-4000-8000-00000000000b";

function provenance(names: string[], orcid: string | null): AuthorProvenance[] {
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

function makePaper(
  id: string,
  authors: string[],
  prov?: AuthorProvenance[] | null,
): Paper {
  return {
    id,
    user_id: "user-1",
    title: `Paper ${id}`,
    authors,
    author_provenance: prov ?? null,
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
    insert_order: 1,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
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

function makeDataset(parts: Partial<AuthorIdentityDataset>): AuthorIdentityDataset {
  return {
    identities: parts.identities ?? [],
    aliases: parts.aliases ?? [],
    links: parts.links ?? [],
    merges: parts.merges ?? [],
  };
}

/**
 * The selection lives in `useAnalyticsTargets`, above the component, exactly as
 * the Dashboard arranges it — so a rerender with a new dataset is precisely what
 * happens when the user makes a decision and the identity query refetches.
 */
function Harness({
  papers,
  identityDataset,
}: {
  papers: Paper[];
  identityDataset: AuthorIdentityDataset | null;
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

/**
 * Tick the option whose label reads exactly `label`.
 *
 * The trigger toggles, so re-pressing it on an already-open popover would close
 * the list rather than reveal it — the guard keeps consecutive selections
 * working the way they do for a user clicking down a list.
 */
function selectAuthor(label: string) {
  if (screen.queryAllByRole("checkbox").length === 0) openAuthors();
  const box = screen
    .getAllByRole("checkbox")
    .find((candidate) => (candidate.closest("label")?.textContent ?? "") === label);
  if (!box) throw new Error(`no author option labelled ${label}`);
  fireEvent.click(box);
}

/**
 * Author names currently plotted, with their paper counts.
 *
 * Scoped to the Author Distribution chart: the year and study-type charts use
 * the same stubbed renderer, and an unscoped read would silently mix them in.
 */
const plotted = () => {
  const heading = screen.queryByText("Author Distribution");
  if (!heading?.parentElement) return [];
  return Array.from(heading.parentElement.querySelectorAll("li")).map(
    (item) => item.textContent ?? "",
  );
};

/** The text of every selection badge's remove control. */
const badgeLabels = () =>
  screen
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? "")
    .filter((label) => label.startsWith("Remove "))
    .map((label) => label.slice("Remove ".length));

const PAPERS_ONE_SPELLING = [
  makePaper("p1", ["Stuart M Phillips"], provenance(["Stuart M Phillips"], ORCID_X)),
];

describe("Analytics selection survives a link", () => {
  it("follows an unresolved author to the person it is linked to", () => {
    const papers = PAPERS_ONE_SPELLING;
    const { rerender } = render(<Harness papers={papers} identityDataset={makeDataset({})} />);

    selectAuthor("Stuart M Phillips");
    expect(plotted()).toEqual(["Stuart M Phillips = 1"]);

    // The user links that mention to a person they name differently.
    rerender(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities: [{ id: IDENTITY_A, preferred_name: "Prof. Stuart Phillips" }],
          links: [link(IDENTITY_A, "p1", 0, "Stuart M Phillips")],
        })}
      />,
    );

    // Still one selection, still one paper — under the person's name now.
    expect(plotted()).toEqual(["Prof. Stuart Phillips = 1"]);
    expect(badgeLabels()).toEqual(["Prof. Stuart Phillips"]);
  });

  it("keeps the user's whole paper set when one spelling resolved two ways", () => {
    // The ambiguous transition. Choosing one descendant would be the component
    // deciding which person the user meant; keeping both preserves the papers
    // they had selected, which is what the selection actually meant.
    const papers = [
      makePaper("p1", ["J Smith"]),
      makePaper("p2", ["J Smith"]),
      makePaper("p3", ["J Smith"]),
    ];
    const { rerender } = render(<Harness papers={papers} identityDataset={makeDataset({})} />);

    selectAuthor("J Smith");
    expect(plotted()).toEqual(["J Smith = 3"]);

    rerender(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities: [
            { id: IDENTITY_A, preferred_name: "Jane Smith" },
            { id: IDENTITY_B, preferred_name: "John Smith" },
          ],
          links: [
            link(IDENTITY_A, "p1", 0, "J Smith"),
            link(IDENTITY_B, "p2", 0, "J Smith"),
          ],
        })}
      />,
    );

    expect(plotted().sort()).toEqual(["J Smith = 1", "Jane Smith = 1", "John Smith = 1"]);
    expect(badgeLabels().sort()).toEqual(["J Smith", "Jane Smith", "John Smith"]);
  });
});

describe("Analytics selection survives a merge and its undo", () => {
  const papers = [
    makePaper("p1", ["A One"]),
    makePaper("p2", ["B Two"]),
  ];
  const identities = [
    { id: IDENTITY_A, preferred_name: "A One" },
    { id: IDENTITY_B, preferred_name: "B Two" },
  ];
  const links = [link(IDENTITY_A, "p1", 0, "A One"), link(IDENTITY_B, "p2", 0, "B Two")];

  it("follows the merged source to the person it was merged into", () => {
    const { rerender } = render(
      <Harness papers={papers} identityDataset={makeDataset({ identities, links })} />,
    );

    selectAuthor("A One");
    expect(plotted()).toEqual(["A One = 1"]);

    rerender(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities,
          links,
          merges: [{ source_identity_id: IDENTITY_A, target_identity_id: IDENTITY_B }],
        })}
      />,
    );

    // Not an orphan counting zero: the selection is now the person A became.
    expect(plotted()).toEqual(["B Two = 2"]);
    expect(badgeLabels()).toEqual(["B Two"]);
  });

  it("restores the original selection when the merge is undone", () => {
    const merged = makeDataset({
      identities,
      links,
      merges: [{ source_identity_id: IDENTITY_A, target_identity_id: IDENTITY_B }],
    });
    const { rerender } = render(<Harness papers={papers} identityDataset={merged} />);

    selectAuthor("B Two");
    expect(plotted()).toEqual(["B Two = 2"]);

    rerender(
      <Harness papers={papers} identityDataset={makeDataset({ identities, links })} />,
    );

    // B was selected as B, so B is what comes back — A is independent again and
    // was never selected in its own right.
    expect(plotted()).toEqual(["B Two = 1"]);
    expect(badgeLabels()).toEqual(["B Two"]);
  });

  it("removes both halves of a converged selection in one click", () => {
    const { rerender } = render(
      <Harness papers={papers} identityDataset={makeDataset({ identities, links })} />,
    );

    selectAuthor("A One");
    selectAuthor("B Two");
    expect(plotted().sort()).toEqual(["A One = 1", "B Two = 1"]);

    rerender(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities,
          links,
          merges: [{ source_identity_id: IDENTITY_A, target_identity_id: IDENTITY_B }],
        })}
      />,
    );
    expect(badgeLabels()).toEqual(["B Two"]);

    // One badge stands for two stored selections; removing it must remove both,
    // or the badge would reappear on the next render.
    fireEvent.click(screen.getByRole("button", { name: "Remove B Two" }));
    expect(badgeLabels()).toEqual([]);
    expect(plotted()).toEqual([]);
  });
});

describe("Analytics selection survives the identity dataset arriving late", () => {
  it("reconciles a selection made against the 001A fallback", () => {
    // `null` is the Preview state: the identity subsystem is not installed, or
    // its first read has not landed. A user can select an author in that window.
    const papers = PAPERS_ONE_SPELLING;
    const { rerender } = render(<Harness papers={papers} identityDataset={null} />);

    selectAuthor("Stuart M Phillips");
    expect(plotted()).toEqual(["Stuart M Phillips = 1"]);

    rerender(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities: [{ id: IDENTITY_A, preferred_name: "Prof. Stuart Phillips" }],
          links: [link(IDENTITY_A, "p1", 0, "Stuart M Phillips")],
        })}
      />,
    );

    expect(plotted()).toEqual(["Prof. Stuart Phillips = 1"]);
  });
});

describe("Analytics selection survives a rename", () => {
  it("shows the new name without losing the selection", () => {
    const papers = PAPERS_ONE_SPELLING;
    const withName = (name: string) =>
      makeDataset({
        identities: [{ id: IDENTITY_A, preferred_name: name }],
        links: [link(IDENTITY_A, "p1", 0, "Stuart M Phillips")],
      });

    const { rerender } = render(
      <Harness papers={papers} identityDataset={withName("Stuart M Phillips")} />,
    );
    selectAuthor("Stuart M Phillips");
    expect(plotted()).toEqual(["Stuart M Phillips = 1"]);

    rerender(<Harness papers={papers} identityDataset={withName("S. M. Phillips")} />);

    expect(plotted()).toEqual(["S. M. Phillips = 1"]);
    expect(badgeLabels()).toEqual(["S. M. Phillips"]);
  });
});

describe("Analytics selection when the entity leaves the view", () => {
  it("keeps a filtered-away person named and removable", () => {
    const papers = PAPERS_ONE_SPELLING;
    const data = makeDataset({
      identities: [{ id: IDENTITY_A, preferred_name: "Stuart M Phillips" }],
      links: [link(IDENTITY_A, "p1", 0, "Stuart M Phillips")],
    });

    const { rerender } = render(<Harness papers={papers} identityDataset={data} />);
    selectAuthor("Stuart M Phillips");

    // The Analytics filter now excludes that paper entirely.
    rerender(<Harness papers={[makePaper("p9", ["Someone Else"])]} identityDataset={data} />);

    expect(plotted()).toEqual(["Stuart M Phillips = 0"]);
    expect(badgeLabels()).toEqual(["Stuart M Phillips"]);
  });

  it("keeps a filtered-away unresolved mention named and removable", () => {
    // A mention has no durable record to read a name from, so the label the user
    // saw when they picked it is what keeps the badge describable.
    const { rerender } = render(
      <Harness papers={PAPERS_ONE_SPELLING} identityDataset={makeDataset({})} />,
    );
    selectAuthor("Stuart M Phillips");

    rerender(
      <Harness papers={[makePaper("p9", ["Someone Else"])]} identityDataset={makeDataset({})} />,
    );

    expect(plotted()).toEqual(["Stuart M Phillips = 0"]);
    expect(badgeLabels()).toEqual(["Stuart M Phillips"]);
  });

  it("keeps a person named after their last visible mention is unlinked", () => {
    const papers = PAPERS_ONE_SPELLING;
    const identities = [{ id: IDENTITY_A, preferred_name: "Stuart M Phillips" }];

    const { rerender } = render(
      <Harness
        papers={papers}
        identityDataset={makeDataset({
          identities,
          links: [link(IDENTITY_A, "p1", 0, "Stuart M Phillips")],
        })}
      />,
    );
    selectAuthor("Stuart M Phillips");
    expect(plotted()).toEqual(["Stuart M Phillips = 1"]);

    // Unlinked: the person still exists and is still selected, but nothing in
    // view resolves to them any more.
    rerender(<Harness papers={papers} identityDataset={makeDataset({ identities })} />);

    expect(plotted()).toEqual(["Stuart M Phillips = 0"]);
    expect(badgeLabels()).toEqual(["Stuart M Phillips"]);
  });
});

describe("Analytics selection never leaks an internal key", () => {
  it("shows no entity key or identity id in any text or accessible name", () => {
    const papers = [
      makePaper("p1", ["Stuart M Phillips"]),
      makePaper("p2", ["Someone Unrelated"]),
    ];
    const data = makeDataset({
      identities: [{ id: IDENTITY_A, preferred_name: "Stuart M Phillips" }],
      links: [link(IDENTITY_A, "p1", 0, "Stuart M Phillips")],
    });

    const { rerender } = render(<Harness papers={papers} identityDataset={data} />);
    selectAuthor("Stuart M Phillips");
    selectAuthor("Someone Unrelated");

    // Push both selections out of view — the exact state the old fallback
    // rendered the raw key in.
    rerender(<Harness papers={[makePaper("p9", ["Nobody"])]} identityDataset={data} />);

    expect(badgeLabels().sort()).toEqual(["Someone Unrelated", "Stuart M Phillips"]);

    const rendered = document.body.textContent ?? "";
    const accessibleNames = Array.from(document.querySelectorAll("[aria-label]"))
      .map((node) => node.getAttribute("aria-label") ?? "")
      .join(" ");

    for (const haystack of [rendered, accessibleNames]) {
      expect(haystack).not.toContain("identity:");
      expect(haystack).not.toContain("mention:");
      expect(haystack).not.toContain(IDENTITY_A);
    }
  });
});

describe("Analytics selection survives the responsive shell swap", () => {
  it("keeps the selection when the viewport crosses 768px", () => {
    // Below 768px the selector becomes a bottom sheet, which is a different
    // component. The selection lives above both, so it must not notice.
    const papers = PAPERS_ONE_SPELLING;
    const data = makeDataset({
      identities: [{ id: IDENTITY_A, preferred_name: "Stuart M Phillips" }],
      links: [link(IDENTITY_A, "p1", 0, "Stuart M Phillips")],
    });

    const { rerender } = render(<Harness papers={papers} identityDataset={data} />);
    selectAuthor("Stuart M Phillips");
    expect(plotted()).toEqual(["Stuart M Phillips = 1"]);

    isMobileRef.current = true;
    rerender(<Harness papers={papers} identityDataset={data} />);

    expect(plotted()).toEqual(["Stuart M Phillips = 1"]);
    expect(badgeLabels()).toEqual(["Stuart M Phillips"]);

    isMobileRef.current = false;
    rerender(<Harness papers={papers} identityDataset={data} />);

    expect(plotted()).toEqual(["Stuart M Phillips = 1"]);
    expect(badgeLabels()).toEqual(["Stuart M Phillips"]);
  });
});
