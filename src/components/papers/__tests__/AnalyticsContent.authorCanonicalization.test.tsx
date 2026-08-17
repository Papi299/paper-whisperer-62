import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AnalyticsContent } from "../AnalyticsContent";
import { useAnalyticsTargets } from "@/hooks/useAnalyticsTargets";
import type { Paper } from "@/types/database";

/**
 * AUTHOR-NAME-CANONICALIZATION-001A — the user-visible half of the contract.
 *
 * `authorNames.test.ts` pins the comparison key itself. What is proved here is
 * that Analytics actually *uses* it: one option per canonical mention key, a
 * summary tile counting the same keys, selected-author counts that follow
 * formatting variants, and a search box that still finds a grouped author when
 * the user types the other spelling.
 *
 * These assertions run against the real `AnalyticsContent` and the real
 * `useAnalyticsTargets`, not a re-implementation of their arithmetic.
 */

/**
 * Recharts is stubbed down to the series it is handed.
 *
 * `ResponsiveContainer` measures its parent, which is 0×0 under jsdom, so the
 * real chart renders nothing; and a bar's count only ever reaches the DOM as an
 * animated SVG path width. Rendering the series as text keeps the assertions
 * about *the numbers Analytics computed* rather than about recharts' geometry.
 * Everything above the chart boundary — options, tiles, selection — is the real
 * component.
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

const DESKTOP_WIDTH = 1024;
const MOBILE_WIDTH = 390;

afterEach(() => {
  window.innerWidth = DESKTOP_WIDTH;
});

function setViewportWidth(width: number) {
  window.innerWidth = width;
}

let paperSeq = 0;
function makePaper(authors: string[]): Paper {
  paperSeq += 1;
  return {
    id: `paper-${paperSeq}`,
    user_id: "user-1",
    title: `Paper ${paperSeq}`,
    authors,
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

function Harness({ papers }: { papers: Paper[] }) {
  const targets = useAnalyticsTargets();
  return <AnalyticsContent papers={papers} isLoading={false} targets={targets} />;
}

/**
 * The reported duplicate: the same person written with and without the period
 * on the middle initial, alongside two genuinely ambiguous shortenings that a
 * mention-level contract must leave alone.
 */
const STUART_PAPERS = () => [
  makePaper(["Stuart M. Phillips"]),
  makePaper(["Stuart M Phillips", "S M Phillips"]),
  makePaper(["stuart  m  phillips"]),
  makePaper(["Stuart Phillips"]),
];

const openAuthors = () => {
  fireEvent.click(screen.getByRole("button", { name: /^Target Authors/ }));
};

/** Option rows, desktop `<label>` or mobile row button alike. */
const optionLabels = () =>
  screen
    .getAllByRole("checkbox")
    .map((box) => (box.closest("label") ?? box).textContent ?? "");

const authorsTileCount = () =>
  screen.getByText("Authors", { selector: "p" }).previousElementSibling?.textContent;

const authorSeries = () => {
  const heading = screen.getByRole("heading", { name: "Author Distribution" });
  return within(heading.parentElement as HTMLElement)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
};

describe("AnalyticsContent — Target Authors option list", () => {
  it("shows one option per canonical mention key, not one per spelling", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(<Harness papers={STUART_PAPERS()} />);
    openAuthors();

    // Three: the grouped Stuart-M variant, plus two names that this phase
    // deliberately refuses to resolve into it.
    expect(optionLabels()).toEqual([
      "S M Phillips",
      "Stuart M. Phillips",
      "Stuart Phillips",
    ]);
  });

  it("keeps the first source spelling encountered as the representative", () => {
    setViewportWidth(DESKTOP_WIDTH);
    const { unmount } = render(
      <Harness
        papers={[makePaper(["Stuart M. Phillips"]), makePaper(["Stuart M Phillips"])]}
      />,
    );
    openAuthors();
    expect(optionLabels()).toEqual(["Stuart M. Phillips"]);
    unmount();

    render(
      <Harness
        papers={[makePaper(["Stuart M Phillips"]), makePaper(["Stuart M. Phillips"])]}
      />,
    );
    openAuthors();
    expect(optionLabels()).toEqual(["Stuart M Phillips"]);
  });

  it("does not merge reordered names", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(
      <Harness
        papers={[makePaper(["Stuart M Phillips"]), makePaper(["Phillips, Stuart M"])]}
      />,
    );
    openAuthors();
    expect(optionLabels()).toEqual(["Phillips, Stuart M", "Stuart M Phillips"]);
  });

  it("excludes empty and whitespace-only author values", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(
      <Harness papers={[makePaper(["", "   ", "\t\n", "Ann Lee"]), makePaper([])]} />,
    );
    openAuthors();
    expect(optionLabels()).toEqual(["Ann Lee"]);
  });

  it("keeps a collective author as a single unparsed option", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(
      <Harness
        papers={[
          makePaper(["GBD 2023 IHD &amp; Dietary Risk Factors Collaborators"]),
          makePaper(["GBD 2023 IHD & Dietary Risk Factors Collaborators"]),
        ]}
      />,
    );
    openAuthors();
    expect(optionLabels()).toEqual([
      "GBD 2023 IHD & Dietary Risk Factors Collaborators",
    ]);
  });
});

describe("AnalyticsContent — Authors summary tile", () => {
  it("counts unique canonical mention keys", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(<Harness papers={STUART_PAPERS()} />);
    // Five raw strings, three canonical mentions.
    expect(authorsTileCount()).toBe("3");
  });

  it("does not count empty author values", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(
      <Harness papers={[makePaper(["", "   ", "Ann Lee"]), makePaper(["ANN LEE"])]} />,
    );
    expect(authorsTileCount()).toBe("1");
  });
});

describe("AnalyticsContent — selected-author statistics", () => {
  it("counts every formatting-equivalent variant, and nothing ambiguous", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(<Harness papers={STUART_PAPERS()} />);
    openAuthors();

    fireEvent.click(screen.getByRole("checkbox", { name: "Stuart M. Phillips" }));

    // Papers 1, 2 and 3 — the period, the plain and the case/whitespace variant.
    // Paper 4 (`Stuart Phillips`) and the `S M Phillips` mention are excluded.
    expect(authorSeries()).toEqual(["Stuart M. Phillips = 3"]);
  });

  it("keeps ambiguous variants on their own counts", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(<Harness papers={STUART_PAPERS()} />);
    openAuthors();

    fireEvent.click(screen.getByRole("checkbox", { name: "Stuart M. Phillips" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "S M Phillips" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Stuart Phillips" }));

    expect(authorSeries()).toEqual([
      "Stuart M. Phillips = 3",
      "S M Phillips = 1",
      "Stuart Phillips = 1",
    ]);
  });

  it("counts a paper once even when its author array repeats an equivalent spelling", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(
      <Harness
        papers={[
          makePaper(["Stuart M Phillips", "Stuart M. Phillips"]),
          makePaper(["STUART M PHILLIPS"]),
        ]}
      />,
    );
    openAuthors();
    fireEvent.click(screen.getByRole("checkbox", { name: "Stuart M Phillips" }));

    expect(authorSeries()).toEqual(["Stuart M Phillips = 2"]);
  });
});

describe("AnalyticsContent — Target Authors search", () => {
  it("finds a grouped author typed with the other initial-period spelling", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(
      <Harness
        papers={[makePaper(["Stuart M Phillips"]), makePaper(["Stuart M. Phillips"])]}
      />,
    );
    openAuthors();

    fireEvent.change(screen.getByRole("textbox", { name: "Search target authors" }), {
      target: { value: "Stuart M. Phillips" },
    });
    expect(optionLabels()).toEqual(["Stuart M Phillips"]);
  });

  it("finds a grouped author typed in a different case and spacing", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(
      <Harness
        papers={[makePaper(["Stuart M. Phillips"]), makePaper(["Stuart M Phillips"])]}
      />,
    );
    openAuthors();

    fireEvent.change(screen.getByRole("textbox", { name: "Search target authors" }), {
      target: { value: "  stuart   m phillips " },
    });
    expect(optionLabels()).toEqual(["Stuart M. Phillips"]);
  });

  it("still narrows on a fragment and reports no matches for an unrelated query", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(<Harness papers={STUART_PAPERS()} />);
    openAuthors();
    const search = screen.getByRole("textbox", { name: "Search target authors" });

    fireEvent.change(search, { target: { value: "stuart" } });
    expect(optionLabels()).toEqual(["Stuart M. Phillips", "Stuart Phillips"]);

    fireEvent.change(search, { target: { value: "nolan" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("leaves Target Keywords search untouched", () => {
    setViewportWidth(DESKTOP_WIDTH);
    const paper = makePaper([]);
    render(
      <Harness papers={[{ ...paper, keywords: ["Vitamin D", "vitamin d.", "Iron"] }]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Target Keywords/ }));

    // Keyword matching stays byte-for-byte case-insensitive substring: the
    // trailing period is a literal, not a foldable initial.
    fireEvent.change(screen.getByRole("textbox", { name: "Search target keywords" }), {
      target: { value: "vitamin d." },
    });
    expect(optionLabels()).toEqual(["vitamin d."]);
  });
});

describe("AnalyticsContent — Unicode author mentions", () => {
  const COMBINING_ACUTE = "́";
  const composed = "José García";
  const decomposed = `Jose${COMBINING_ACUTE} Garci${COMBINING_ACUTE}a`;

  it("groups canonically equivalent forms under one accented source spelling", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(
      <Harness
        papers={[
          makePaper([decomposed]),
          makePaper([composed]),
          makePaper(["Jose Garcia"]),
        ]}
      />,
    );
    openAuthors();

    // Two options: the accented name (one option, accents intact) and the
    // unaccented spelling, which is a different name and stays separate.
    expect(optionLabels()).toEqual(["Jose Garcia", composed]);
    expect(authorsTileCount()).toBe("2");

    fireEvent.click(screen.getByRole("checkbox", { name: composed }));
    expect(authorSeries()).toEqual([`${composed} = 2`]);
  });
});

describe("AnalyticsContent — selection stability", () => {
  it("does not select a canonical author twice when the representative changes", () => {
    setViewportWidth(DESKTOP_WIDTH);
    const first = makePaper(["Stuart M. Phillips"]);
    const second = makePaper(["Stuart M Phillips"]);

    const { rerender } = render(<Harness papers={[first, second]} />);
    openAuthors();
    fireEvent.click(screen.getByRole("checkbox", { name: "Stuart M. Phillips" }));

    // The papers set narrows to the paper carrying the *other* spelling, so the
    // representative label changes underneath a live selection.
    rerender(<Harness papers={[second]} />);

    const option = screen.getByRole("checkbox", { name: "Stuart M Phillips" });
    expect(option).toHaveAttribute("data-state", "checked");

    fireEvent.click(option);
    expect(screen.queryByRole("heading", { name: "Author Distribution" })).toBeNull();
  });

  it("shows a source-derived label in the selected badge, never a comparison key", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(<Harness papers={STUART_PAPERS()} />);
    openAuthors();
    fireEvent.click(screen.getByRole("checkbox", { name: "Stuart M. Phillips" }));

    expect(
      screen.getByRole("button", { name: "Remove Stuart M. Phillips" }),
    ).toBeInTheDocument();
  });
});

describe("AnalyticsContent — mobile composition", () => {
  it("groups, searches and selects authors through the mobile sheet", async () => {
    setViewportWidth(MOBILE_WIDTH);
    render(<Harness papers={STUART_PAPERS()} />);

    openAuthors();
    await screen.findByRole("dialog");

    expect(optionLabels()).toEqual([
      "S M Phillips",
      "Stuart M. Phillips",
      "Stuart Phillips",
    ]);

    fireEvent.change(screen.getByRole("textbox", { name: "Search target authors" }), {
      target: { value: "stuart m. phillips" },
    });
    expect(optionLabels()).toEqual(["Stuart M. Phillips"]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Stuart M. Phillips" }));
    expect(
      screen.getByRole("checkbox", { name: "Stuart M. Phillips" }),
    ).toHaveAttribute("aria-checked", "true");

    // The sheet `aria-hidden`s the page behind it, so the chart is only
    // reachable once it is dismissed — which is how the user reads it too.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(authorSeries()).toEqual(["Stuart M. Phillips = 3"]);
  });
});
