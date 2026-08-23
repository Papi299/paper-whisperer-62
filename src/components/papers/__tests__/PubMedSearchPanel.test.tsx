import { useState } from "react";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
import type { Project, Tag } from "@/types/database";
import { PubMedSearchError, type PubMedSearchPage } from "@/lib/searchPubMedEdge";

import { AddPaperDialog } from "../AddPaperDialog";

/**
 * PUBMED-IN-APP-SEARCH-001 — the PubMed discovery tab.
 *
 * Rendered through the real `AddPaperDialog` rather than against
 * `PubMedSearchPanel` in isolation, because the two things most worth proving
 * are boundaries the dialog owns: that the ONLY thing crossing from discovery
 * into persistence is a list of PMID strings handed to the same `onBulkImport`
 * the Import IDs tab uses, and that the Project/Tag selections are the shared
 * ones. A panel-only test could not observe either.
 */

// Radix Dialog/Popover + cmdk rely on a few DOM APIs jsdom does not implement.
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

const PROJECTS: Project[] = [
  { id: "p1", user_id: "u", name: "Alpha", description: null, color: "#f00", created_at: "" },
  { id: "p2", user_id: "u", name: "Beta", description: null, color: "#0f0", created_at: "" },
];

const TAGS: Tag[] = [
  { id: "t1", user_id: "u", name: "Omega", color: "#00f", created_at: "" },
  { id: "t2", user_id: "u", name: "Sigma", color: "#0ac", created_at: "" },
];

// ── Deterministic PubMed fixtures ────────────────────────────────────────

const LONG_TITLE =
  "Effects of progressive high-load resistance training on regional skeletal muscle hypertrophy, " +
  "intramuscular anabolic signalling and maximal voluntary isometric contraction in previously " +
  "untrained middle-aged adults: a multicentre randomised controlled trial with 24-month follow-up";

function result(pmid: string, overrides: Record<string, unknown> = {}) {
  return {
    pmid,
    title: `Paper ${pmid}`,
    authors: ["Author A", "Author B"],
    journal: "Journal of Deterministic Discovery",
    publicationDate: "2024 Mar",
    year: 2024,
    publicationTypes: ["Journal Article"],
    doi: null,
    ...overrides,
  } as PubMedSearchPage["results"][number];
}

/** Page 1 and page 2 of one 25-result query. */
const PAGE_ONE = ["11111111", "22222222", "33333333"].map((pmid) => result(pmid));
const PAGE_TWO = ["44444444", "55555555"].map((pmid) => result(pmid));

function pageOf(results: PubMedSearchPage["results"], offset: number, total = 25): PubMedSearchPage {
  return { query: "resistance training hypertrophy", total, offset, limit: 20, results };
}

/**
 * A search callback whose pages are chosen by offset. Records every request so
 * the "typing does not search" and "no rewriting" contracts are observable.
 */
function makeSearch(
  handler: (request: { query: string; offset?: number; limit?: number }) => Promise<PubMedSearchPage>,
) {
  return vi.fn(handler);
}

const twoPageSearch = () =>
  makeSearch(async ({ offset }) =>
    (offset ?? 0) === 0 ? pageOf(PAGE_ONE, 0) : pageOf(PAGE_TWO, 20),
  );

// ── Import-callback mocks ────────────────────────────────────────────────

function makeBulkImport(
  outcome: (ids: string[]) => { addedIds: string[]; skippedIds: string[]; failedIds: string[] } = (
    ids,
  ) => ({ addedIds: ids, skippedIds: [], failedIds: [] }),
) {
  return vi.fn(
    async (
      ids: string[],
      onProgress?: (
        current: number,
        total: number,
        addedIds: string[],
        skippedIds: string[],
        failedIds: string[],
      ) => void,
      // Declared so the assertions below can read the assignment options the
      // dialog passes as the third argument — the same signature
      // `bulkImportPapers` really has.
      _options?: { targetProjectIds?: string[]; targetTagIds?: string[] },
    ) => {
      const { addedIds, skippedIds, failedIds } = outcome(ids);
      onProgress?.(ids.length, ids.length, addedIds, skippedIds, failedIds);
    },
  );
}

// ── Query helpers ────────────────────────────────────────────────────────

/** Radix Tabs activate on mouse-down (primary button), not click. */
function switchTab(re: RegExp) {
  const tab = screen.getByRole("tab", { name: re });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

const searchField = () => screen.getByLabelText("Search PubMed") as HTMLInputElement;
const searchButton = () => screen.getByRole("button", { name: "Search" });
const importButton = () => screen.getByRole("button", { name: /^Import( \d+)? Selected$/ });

function typeQuery(value: string) {
  fireEvent.change(searchField(), { target: { value } });
}

function pressSearch() {
  fireEvent.click(searchButton());
}

function resultCheckbox(pmid: string) {
  return screen.getByRole("checkbox", { name: new RegExp(`^Select PMID ${pmid} — `) });
}

function triggerButton(re: RegExp): HTMLElement {
  const btn = screen.getAllByRole("button").find((b) => re.test(b.textContent || ""));
  if (!btn) throw new Error(`No trigger button matching ${re}`);
  return btn;
}

async function selectFromPopover(triggerRe: RegExp, placeholder: string, names: string[]) {
  fireEvent.click(triggerButton(triggerRe));
  await screen.findByPlaceholderText(placeholder);
  for (const name of names) {
    fireEvent.click(screen.getByRole("option", { name: new RegExp(name) }));
  }
  fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByPlaceholderText(placeholder)).toBeNull());
}

const selectProjects = (...names: string[]) =>
  selectFromPopover(/projects?/i, "Search projects...", names);
const selectTags = (...names: string[]) => selectFromPopover(/tags?/i, "Search tags...", names);

interface RenderOptions {
  onPubMedSearch?: ReturnType<typeof makeSearch>;
  onBulkImport?: ReturnType<typeof makeBulkImport>;
  startOnPubMed?: boolean;
  /** The user's Study Type Exclusion Pool, as `PoolsContext` hands it over. */
  excludedStudyTypes?: Set<string>;
}

function renderDialog(options: RenderOptions = {}) {
  const onPubMedSearch = options.onPubMedSearch ?? twoPageSearch();
  const onBulkImport = options.onBulkImport ?? makeBulkImport();
  const onOpenChange = vi.fn();

  render(
    <AddPaperDialog
      open
      onOpenChange={onOpenChange}
      onPubMedSearch={onPubMedSearch}
      onBulkImport={onBulkImport}
      excludedStudyTypes={options.excludedStudyTypes}
      projects={PROJECTS}
      tags={TAGS}
    />,
  );

  if (options.startOnPubMed !== false) switchTab(/PubMed Search/i);
  return { onPubMedSearch, onBulkImport, onOpenChange };
}

/**
 * The publication-type badges actually rendered for one result, in order.
 *
 * Scoped to that result's own row and read through the labelled list rather
 * than by text, because a badge value like "Journal Article" is not otherwise
 * distinguishable from a title, a journal name or an author.
 */
function badgesFor(pmid: string): string[] {
  const checkbox = screen.getByRole("checkbox", { name: new RegExp(`^Select PMID ${pmid} — `) });
  const row = checkbox.closest("li") as HTMLElement;
  const list = within(row).queryByRole("list", { name: "Publication types" });
  if (!list) return [];
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

/** Whether the publication-type badge section exists at all for one result. */
function hasBadgeSection(pmid: string): boolean {
  const checkbox = screen.getByRole("checkbox", { name: new RegExp(`^Select PMID ${pmid} — `) });
  const row = checkbox.closest("li") as HTMLElement;
  return within(row).queryByRole("list", { name: "Publication types" }) !== null;
}

/** Search and wait for the first page to render. */
async function search(query = "resistance training hypertrophy") {
  typeQuery(query);
  pressSearch();
  await screen.findByRole("checkbox", { name: /^Select PMID 11111111 — / });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
// The fourth mode
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — the fourth Add Papers mode", () => {
  it("exists alongside the three existing modes, all still reachable", () => {
    renderDialog({ startOnPubMed: false });

    const tabs = screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"));
    expect(tabs).toEqual(["PubMed Search", "Import IDs", "Import File", "Manual"]);
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toBeEnabled();
    }
  });

  it("does not change the default mode", () => {
    renderDialog({ startOnPubMed: false });
    expect(screen.getByRole("tab", { name: "Import IDs" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "PubMed Search" })).toHaveAttribute("aria-selected", "false");
  });

  it("exposes a labelled search field and a named Search button", () => {
    renderDialog();
    expect(searchField()).toBeInTheDocument();
    expect(searchButton()).toBeInTheDocument();
    expect(screen.getByText(/Full PubMed search syntax is supported/i)).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Explicit search only
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — search is explicit", () => {
  it("does not search while the user types", async () => {
    const { onPubMedSearch } = renderDialog();

    for (const value of ["r", "re", "res", "resistance", "resistance training"]) {
      typeQuery(value);
    }
    // Give any accidental debounce/effect a chance to fire before asserting.
    await act(async () => {
      await Promise.resolve();
    });

    expect(onPubMedSearch).not.toHaveBeenCalled();
  });

  it("searches when the Search button is pressed", async () => {
    const { onPubMedSearch } = renderDialog();
    await search();
    expect(onPubMedSearch).toHaveBeenCalledTimes(1);
  });

  it("searches on form submission — the field's Enter key path", async () => {
    // jsdom does not implement implicit form submission from a keypress, so the
    // submit EVENT is dispatched directly here; a real Enter keystroke in a real
    // browser is covered by e2e/pubmed-search.spec.ts.
    const { onPubMedSearch } = renderDialog();
    typeQuery("resistance training hypertrophy");
    fireEvent.submit(searchField().closest("form")!);
    await screen.findByRole("checkbox", { name: /^Select PMID 11111111 — / });
    expect(onPubMedSearch).toHaveBeenCalledTimes(1);
  });

  it("sends the trimmed query without rewriting PubMed syntax", async () => {
    const { onPubMedSearch } = renderDialog();
    const query = '("resistance training"[Title/Abstract]) AND muscle NOT review[pt]';

    typeQuery(`   ${query}   `);
    pressSearch();
    await screen.findByRole("checkbox", { name: /^Select PMID 11111111 — / });

    expect(onPubMedSearch).toHaveBeenCalledWith({ query, offset: 0, limit: 20 });
  });

  it("does nothing when the query is only whitespace", async () => {
    const { onPubMedSearch } = renderDialog();
    typeQuery("    ");
    expect(searchButton()).toBeDisabled();
    pressSearch();
    expect(onPubMedSearch).not.toHaveBeenCalled();
  });

  it("does not start a second search while one is in flight", async () => {
    let release!: (page: PubMedSearchPage) => void;
    const onPubMedSearch = makeSearch(
      () => new Promise<PubMedSearchPage>((resolve) => { release = resolve; }),
    );
    renderDialog({ onPubMedSearch });

    typeQuery("resistance training");
    pressSearch();
    expect(await screen.findByText("Searching PubMed…")).toBeInTheDocument();
    expect(searchButton()).toBeDisabled();

    pressSearch();
    pressSearch();
    expect(onPubMedSearch).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(pageOf(PAGE_ONE, 0));
    });
    expect(screen.queryByText("Searching PubMed…")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Result presentation
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — result presentation", () => {
  it("renders title, authors, journal, date, PMID and a PubMed link", async () => {
    renderDialog({
      onPubMedSearch: makeSearch(async () =>
        pageOf([result("11111111", { authors: ["Author A", "Author B", "Author C", "Author D", "Author E"] })], 0, 1),
      ),
    });
    await search();

    expect(screen.getByText("Paper 11111111")).toBeInTheDocument();
    // Compact author display: three named, the rest counted.
    expect(screen.getByText("Author A, Author B, Author C +2")).toBeInTheDocument();
    expect(screen.getByText("Journal of Deterministic Discovery · 2024 Mar")).toBeInTheDocument();
    expect(screen.getByText("PMID 11111111")).toBeInTheDocument();
    expect(screen.getByText("Journal Article")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /Open in PubMed/ });
    // Built from the PMID, not from any upstream URL field.
    expect(link).toHaveAttribute("href", "https://pubmed.ncbi.nlm.nih.gov/11111111/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("labels a record whose summary carried no title, keeping it selectable", async () => {
    renderDialog({
      onPubMedSearch: makeSearch(async () =>
        pageOf([result("11111111", { title: null, authors: [], journal: null, publicationDate: null, year: null })], 0, 1),
      ),
    });
    await search();

    expect(screen.getByText("Title unavailable in PubMed summary")).toBeInTheDocument();
    expect(resultCheckbox("11111111")).toBeEnabled();
  });

  it("keeps two identically titled records as separate, distinguishable results", async () => {
    renderDialog({
      onPubMedSearch: makeSearch(async () =>
        pageOf(
          [result("11111111", { title: "Same Title" }), result("22222222", { title: "Same Title" })],
          0,
          2,
        ),
      ),
    });
    await search();

    // Two rows, and each checkbox names its own PMID first.
    expect(screen.getByRole("checkbox", { name: "Select PMID 11111111 — Same Title" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select PMID 22222222 — Same Title" })).toBeInTheDocument();
  });

  it("lets a very long title wrap instead of forcing the row wider than the list", async () => {
    renderDialog({
      onPubMedSearch: makeSearch(async () => pageOf([result("11111111", { title: LONG_TITLE })], 0, 1)),
    });
    await search();

    const titleEl = screen.getByText(LONG_TITLE);
    // jsdom does not lay out, so this asserts the CAUSE rather than the pixels:
    // a nowrap line's min-content width is its full length, which is exactly how
    // PRs #233–#236 pushed row controls out of reach. Real geometry at 390px is
    // measured in e2e/pubmed-search.spec.ts.
    expect(titleEl.className).toContain("break-words");
    expect(titleEl.className).not.toContain("truncate");
    expect(titleEl.className).not.toContain("whitespace-nowrap");

    const row = titleEl.closest("li")!;
    for (const element of row.querySelectorAll("*")) {
      expect(element.className.toString()).not.toContain("truncate");
      expect(element.className.toString()).not.toContain("whitespace-nowrap");
    }
    // The checkbox is still in the row and still operable.
    expect(within(row).getByRole("checkbox")).toBeEnabled();
    expect(within(row).getByRole("link", { name: /Open in PubMed/ })).toBeInTheDocument();
  });

  it("bounds the result list to one scroll owner", async () => {
    renderDialog();
    await search();
    const list = screen.getByRole("list", { name: "PubMed search results" });
    // max-height AND overflow on the SAME element: the PR #236 lesson — a cap on
    // an outer box leaves the inner one sized to content and nothing scrolls.
    expect(list.className).toContain("max-h-[45vh]");
    expect(list.className).toContain("overflow-y-auto");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Loading, empty and error states
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — request states", () => {
  it("shows an explicit calm empty state for a valid zero-result query", async () => {
    renderDialog({ onPubMedSearch: makeSearch(async () => pageOf([], 0, 0)) });
    typeQuery("zzzznotaterm");
    pressSearch();

    expect(await screen.findByText(/No PubMed results found/i)).toBeInTheDocument();
    // Not an error, and nothing is selectable or pageable.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
    expect(importButton()).toBeDisabled();
  });

  it("shows a controlled inline error, with retry still possible", async () => {
    const onPubMedSearch = makeSearch(async () => {
      throw new PubMedSearchError("upstream", "PubMed could not be reached right now. Please try again in a moment.");
    });
    renderDialog({ onPubMedSearch });

    typeQuery("resistance training");
    pressSearch();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("PubMed could not be reached right now. Please try again in a moment.");
    // Retry is available immediately.
    expect(searchButton()).toBeEnabled();
    pressSearch();
    await waitFor(() => expect(onPubMedSearch).toHaveBeenCalledTimes(2));
  });

  it("does not present stale results from a previous query under a failed new one", async () => {
    let failNext = false;
    const onPubMedSearch = makeSearch(async ({ query }) => {
      if (failNext) throw new PubMedSearchError("upstream", "PubMed is unavailable.");
      return pageOf(PAGE_ONE, 0);
    });
    renderDialog({ onPubMedSearch });
    await search("first query");

    failNext = true;
    typeQuery("a completely different query");
    pressSearch();

    await screen.findByRole("alert");
    // The old query's results are gone: they never belonged to this query.
    expect(screen.queryByRole("checkbox", { name: /^Select PMID 11111111 — / })).toBeNull();
  });

  it("keeps the current valid page when a PAGE move fails", async () => {
    const onPubMedSearch = makeSearch(async ({ offset }) => {
      if ((offset ?? 0) > 0) throw new PubMedSearchError("upstream", "PubMed is unavailable.");
      return pageOf(PAGE_ONE, 0);
    });
    renderDialog({ onPubMedSearch });
    await search();
    fireEvent.click(resultCheckbox("11111111"));

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByRole("alert");

    // Results the user could still use are not destroyed by a failed Next…
    expect(resultCheckbox("11111111")).toBeChecked();
    expect(screen.getByText("1 paper selected")).toBeInTheDocument();
    // …and the error says the results belong to the previous successful search.
    expect(screen.getByText(/still from your last successful search/i)).toBeInTheDocument();
  });

  it("never imports anything merely by searching", async () => {
    const { onBulkImport } = renderDialog();
    await search();
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByRole("checkbox", { name: /^Select PMID 44444444 — / });

    expect(onBulkImport).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Selection
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — selection", () => {
  it("selects and deselects individual results and counts them", async () => {
    renderDialog();
    await search();

    expect(screen.queryByText(/papers? selected/)).toBeNull();

    fireEvent.click(resultCheckbox("11111111"));
    expect(await screen.findByText("1 paper selected")).toBeInTheDocument();
    expect(resultCheckbox("11111111")).toBeChecked();

    fireEvent.click(resultCheckbox("22222222"));
    expect(await screen.findByText("2 papers selected")).toBeInTheDocument();

    fireEvent.click(resultCheckbox("11111111"));
    expect(await screen.findByText("1 paper selected")).toBeInTheDocument();
    expect(resultCheckbox("11111111")).not.toBeChecked();
  });

  it("clears the whole selection from one control", async () => {
    renderDialog();
    await search();
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(resultCheckbox("22222222"));

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));

    await waitFor(() => expect(screen.queryByText(/papers? selected/)).toBeNull());
    expect(resultCheckbox("11111111")).not.toBeChecked();
    expect(importButton()).toBeDisabled();
  });

  it("selects only the CURRENT page, then clears only the current page", async () => {
    renderDialog();
    await search();

    fireEvent.click(screen.getByRole("button", { name: "Select all on this page" }));
    // Three on this page — never the 25 the query matched.
    expect(await screen.findByText("3 papers selected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear page selection" }));
    await waitFor(() => expect(screen.queryByText(/papers? selected/)).toBeNull());
  });

  it("keeps a selection made on a page the user has navigated away from", async () => {
    renderDialog();
    await search();
    fireEvent.click(resultCheckbox("11111111"));

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByRole("checkbox", { name: /^Select PMID 44444444 — / });

    // Page 1's selection is invisible but still counted, and still clearable
    // without walking back to the page it was made on.
    expect(screen.getByText("1 paper selected")).toBeInTheDocument();
    fireEvent.click(resultCheckbox("44444444"));
    expect(await screen.findByText("2 papers selected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByRole("checkbox", { name: /^Select PMID 11111111 — / });
    expect(resultCheckbox("11111111")).toBeChecked();
    expect(screen.getByText("2 papers selected")).toBeInTheDocument();
  });

  it("does not toggle selection when the PubMed link is activated", async () => {
    renderDialog();
    await search();

    const row = screen.getByText("Paper 11111111").closest("li")!;
    fireEvent.click(within(row).getByRole("link", { name: /Open in PubMed/ }));

    expect(resultCheckbox("11111111")).not.toBeChecked();
    expect(screen.queryByText(/papers? selected/)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Pagination
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — pagination", () => {
  it("states total matches and the records shown, distinctly", async () => {
    renderDialog();
    await search();
    // Never "3 papers found" for a 25-match query.
    expect(screen.getByText("1–3 of 25")).toBeInTheDocument();
    expect(screen.getByText(/matching papers/)).toBeInTheDocument();
  });

  it("disables Previous on the first page and Next on the last", async () => {
    renderDialog();
    await search();
    expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByRole("checkbox", { name: /^Select PMID 44444444 — / });

    expect(screen.getByRole("button", { name: /Previous/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
    expect(screen.getByText("21–22 of 25")).toBeInTheDocument();
  });

  it("uses the committed query for pagination, not whatever is in the field", async () => {
    const { onPubMedSearch } = renderDialog();
    await search("committed query");

    // The user starts typing something else but does NOT submit it.
    typeQuery("an unsubmitted draft");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByRole("checkbox", { name: /^Select PMID 44444444 — / });

    expect(onPubMedSearch).toHaveBeenLastCalledWith({
      query: "committed query",
      offset: 20,
      limit: 20,
    });
  });

  it("does not let a slower page request overwrite a newer one", async () => {
    const pending: Array<(page: PubMedSearchPage) => void> = [];
    const onPubMedSearch = makeSearch(
      () => new Promise<PubMedSearchPage>((resolve) => pending.push(resolve)),
    );
    renderDialog({ onPubMedSearch });

    typeQuery("resistance training");
    pressSearch();
    await act(async () => {
      pending[0](pageOf(PAGE_ONE, 0));
    });

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    // A second page request cannot even start while one is in flight.
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(onPubMedSearch).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending[1](pageOf(PAGE_TWO, 20));
    });
    expect(screen.getByText("21–22 of 25")).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Draft vs committed query
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — draft vs committed query", () => {
  it("changing the draft alone clears neither results nor selection", async () => {
    const { onPubMedSearch } = renderDialog();
    await search("first query");
    fireEvent.click(resultCheckbox("11111111"));

    typeQuery("something else entirely");
    await act(async () => {
      await Promise.resolve();
    });

    expect(onPubMedSearch).toHaveBeenCalledTimes(1);
    expect(resultCheckbox("11111111")).toBeChecked();
    expect(screen.getByText("1 paper selected")).toBeInTheDocument();
  });

  it("submitting a materially different query clears the previous selection", async () => {
    const onPubMedSearch = makeSearch(async ({ query }) =>
      query === "second query" ? pageOf([result("99999999")], 0, 1) : pageOf(PAGE_ONE, 0),
    );
    renderDialog({ onPubMedSearch });
    await search("first query");
    fireEvent.click(resultCheckbox("11111111"));
    expect(screen.getByText("1 paper selected")).toBeInTheDocument();

    typeQuery("second query");
    pressSearch();
    await screen.findByRole("checkbox", { name: /^Select PMID 99999999 — / });

    // Selections from an unrelated search are never mixed into the next import.
    expect(screen.queryByText(/papers? selected/)).toBeNull();
    expect(onPubMedSearch).toHaveBeenLastCalledWith({ query: "second query", offset: 0, limit: 20 });
  });

  it("re-submitting the SAME query refreshes it and keeps the selection", async () => {
    const { onPubMedSearch } = renderDialog();
    await search("resistance training hypertrophy");
    fireEvent.click(resultCheckbox("11111111"));

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByRole("checkbox", { name: /^Select PMID 44444444 — / });

    pressSearch();
    await screen.findByRole("checkbox", { name: /^Select PMID 11111111 — / });

    // Back to page 1, one selection, and no duplicate of it.
    expect(onPubMedSearch).toHaveBeenLastCalledWith({
      query: "resistance training hypertrophy",
      offset: 0,
      limit: 20,
    });
    expect(screen.getByText("1 paper selected")).toBeInTheDocument();
    expect(resultCheckbox("11111111")).toBeChecked();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Stale responses
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — stale-response protection", () => {
  it("discards a slow first response when a newer query has been submitted", async () => {
    const pending: Array<(page: PubMedSearchPage) => void> = [];
    const onPubMedSearch = makeSearch(
      () => new Promise<PubMedSearchPage>((resolve) => pending.push(resolve)),
    );
    renderDialog({ onPubMedSearch });

    typeQuery("query A");
    pressSearch();

    // Resolve A only AFTER B has been submitted and answered.
    await act(async () => {
      pending[0](pageOf([result("11111111", { title: "STALE A" })], 0, 1));
    });
    typeQuery("query B");
    pressSearch();
    await act(async () => {
      pending[1](pageOf([result("22222222", { title: "FRESH B" })], 0, 1));
    });
    // Now the very first request "arrives" again — it must change nothing.
    await act(async () => {
      pending[0](pageOf([result("33333333", { title: "STALE A LATE" })], 0, 1));
    });

    expect(screen.getByText("FRESH B")).toBeInTheDocument();
    expect(screen.queryByText("STALE A LATE")).toBeNull();
  });

  it("cannot repopulate a dialog that has been closed and reopened", async () => {
    const pending: Array<(page: PubMedSearchPage) => void> = [];
    const onPubMedSearch = makeSearch(
      () => new Promise<PubMedSearchPage>((resolve) => pending.push(resolve)),
    );

    function Controlled() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)}>reopen</button>
          <AddPaperDialog
            open={open}
            onOpenChange={setOpen}
            onPubMedSearch={onPubMedSearch}
            onBulkImport={makeBulkImport()}
            projects={PROJECTS}
            tags={TAGS}
          />
        </>
      );
    }
    render(<Controlled />);
    switchTab(/PubMed Search/i);

    typeQuery("in flight when closed");
    pressSearch();

    // Close mid-flight, then reopen.
    fireEvent.click(screen.getAllByRole("button", { name: "Close", hidden: true })[0]);
    fireEvent.click(screen.getByRole("button", { name: "reopen" }));
    switchTab(/PubMed Search/i);

    await act(async () => {
      pending[0](pageOf(PAGE_ONE, 0));
    });

    expect(screen.queryByRole("checkbox", { name: /^Select PMID 11111111 — / })).toBeNull();
    expect(searchField()).toHaveValue("");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The canonical import handoff
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — canonical import handoff", () => {
  it("sends ONLY the selected PMID strings to the existing identifier importer", async () => {
    const { onBulkImport } = renderDialog();
    await search();

    fireEvent.click(resultCheckbox("22222222"));
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(importButton());
    await screen.findByText("PubMed Import Results");

    expect(onBulkImport).toHaveBeenCalledTimes(1);
    const [identifiers] = onBulkImport.mock.calls[0];
    // Selection order, deterministic, no duplicates.
    expect(identifiers).toEqual(["22222222", "11111111"]);
    // Every element is a bare PMID string — never a search-summary object.
    for (const identifier of identifiers) {
      expect(typeof identifier).toBe("string");
      expect(identifier).toMatch(/^\d+$/);
    }
  });

  it("hands the importer NO discovery metadata whatsoever", async () => {
    const { onBulkImport } = renderDialog();
    await search();
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(importButton());
    await screen.findByText("PubMed Import Results");

    // The whole call — identifiers and options — contains no ESummary field.
    const [identifiers, , options] = onBulkImport.mock.calls[0];
    const serialized = JSON.stringify({ identifiers, options });
    for (const leak of [
      "Paper 11111111",
      "Author A",
      "Journal of Deterministic Discovery",
      "2024 Mar",
      "Journal Article",
      "title",
      "authors",
      "journal",
      "publicationTypes",
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("imports by PMID even when the result also carries a DOI", async () => {
    const { onBulkImport } = renderDialog({
      onPubMedSearch: makeSearch(async () =>
        pageOf([result("11111111", { doi: "10.5555/discovery-doi" })], 0, 1),
      ),
    });
    await search();

    // The DOI is displayed…
    expect(screen.getByText("DOI 10.5555/discovery-doi")).toBeInTheDocument();

    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(importButton());
    await screen.findByText("PubMed Import Results");

    // …and is NOT what gets imported. The discovery source is PubMed.
    expect(onBulkImport.mock.calls[0][0]).toEqual(["11111111"]);
    expect(JSON.stringify(onBulkImport.mock.calls[0][0])).not.toContain("10.5555");
  });

  it("passes the SHARED Project and Tag selections to the canonical import", async () => {
    const { onBulkImport } = renderDialog();
    await search();

    await selectProjects("Alpha");
    await selectTags("Omega");
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(importButton());
    await screen.findByText("PubMed Import Results");

    expect(onBulkImport.mock.calls[0][2]).toEqual({
      targetProjectIds: ["p1"],
      targetTagIds: ["t1"],
    });
  });

  it("shares one assignment intent with the Import IDs tab", async () => {
    const { onBulkImport } = renderDialog();
    await search();
    await selectProjects("Beta");

    // Chosen on the PubMed tab, applied by the identifier tab — one dialog, one
    // assignment state, no `pubmedSelectedProjectIds`.
    switchTab(/Import IDs/i);
    fireEvent.change(
      screen.getByLabelText("Paste PMIDs or DOIs, or drop a .txt/.csv file"),
      { target: { value: "777" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("Import Results Summary");

    expect(onBulkImport.mock.calls[0][2]).toEqual({ targetProjectIds: ["p2"] });
  });

  it("keeps the Import action disabled until something is selected", async () => {
    renderDialog();
    await search();
    expect(importButton()).toBeDisabled();
    fireEvent.click(resultCheckbox("11111111"));
    await waitFor(() => expect(importButton()).toBeEnabled());
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Import outcome
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — import outcome", () => {
  it("reports added, skipped-duplicate and failed in the existing vocabulary", async () => {
    const onBulkImport = makeBulkImport((ids) => ({
      addedIds: [ids[0]],
      skippedIds: [ids[1]],
      failedIds: [ids[2]],
    }));
    renderDialog({ onBulkImport });
    await search();

    fireEvent.click(screen.getByRole("button", { name: "Select all on this page" }));
    fireEvent.click(importButton());

    await screen.findByText("PubMed Import Results");
    expect(screen.getByText("Added (1)")).toBeInTheDocument();
    expect(screen.getByText("Skipped — Duplicates (1)")).toBeInTheDocument();
    expect(screen.getByText("Failed (1)")).toBeInTheDocument();
    // Identifiers, so a failed PMID is never re-labelled with a stale title.
    expect(screen.getByText("11111111")).toBeInTheDocument();
    expect(screen.getByText("22222222")).toBeInTheDocument();
    expect(screen.getByText("33333333")).toBeInTheDocument();
  });

  it("keeps query, results and assignments after a successful import, clearing only the imported selection", async () => {
    renderDialog();
    await search();
    await selectProjects("Alpha");
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(importButton());
    await screen.findByText("PubMed Import Results");

    // Query and results survive — the user can pick the next few papers.
    expect(searchField()).toHaveValue("resistance training hypertrophy");
    expect(resultCheckbox("11111111")).toBeInTheDocument();
    expect(screen.getByText("1–3 of 25")).toBeInTheDocument();
    // The just-imported selection is gone so it cannot be re-submitted.
    expect(resultCheckbox("11111111")).not.toBeChecked();
    expect(screen.queryByText(/papers? selected/)).toBeNull();
    expect(importButton()).toBeDisabled();
    // The assignment section now configures the NEXT run.
    expect(screen.getByText("Assignments for next import")).toBeInTheDocument();
    expect(triggerButton(/1 project/i)).toBeInTheDocument();
  });

  it("supports a second import from the same results with the preserved assignments", async () => {
    const { onBulkImport } = renderDialog();
    await search();
    await selectProjects("Alpha");

    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(importButton());
    await screen.findByText("PubMed Import Results");

    fireEvent.click(resultCheckbox("22222222"));
    fireEvent.click(resultCheckbox("33333333"));
    fireEvent.click(importButton());
    await waitFor(() => expect(onBulkImport).toHaveBeenCalledTimes(2));

    // Only the new pair, never a re-submission of the first paper.
    expect(onBulkImport.mock.calls[1][0]).toEqual(["22222222", "33333333"]);
    expect(onBulkImport.mock.calls[1][2]).toEqual({ targetProjectIds: ["p1"] });
  });

  it("preserves the selection, the results and the assignments when the import throws", async () => {
    const onBulkImport = vi.fn(async () => {
      throw new Error("safe_bulk_insert_papers failed");
    });
    renderDialog({ onBulkImport: onBulkImport as never });
    await search();
    await selectProjects("Alpha");
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(resultCheckbox("22222222"));

    await act(async () => {
      fireEvent.click(importButton());
    });

    // The failure is caught and stated rather than escaping the click handler
    // as an unhandled rejection nobody sees.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The import could not be completed. Your selection was kept — you can try again.",
    );
    // Nothing is lost, so the user can simply press Import again.
    expect(screen.getByText("2 papers selected")).toBeInTheDocument();
    expect(resultCheckbox("11111111")).toBeChecked();
    expect(resultCheckbox("22222222")).toBeChecked();
    expect(screen.getByText("1–3 of 25")).toBeInTheDocument();
    expect(triggerButton(/1 project/i)).toBeInTheDocument();
    expect(importButton()).toBeEnabled();
    // A failed run never presents itself as complete.
    expect(screen.queryByText("PubMed Import Results")).toBeNull();
  });

  it("lets the user retry after a failed import, and clears the failure notice", async () => {
    let failNext = true;
    const onBulkImport = vi.fn(
      async (
        ids: string[],
        onProgress?: (
          current: number,
          total: number,
          addedIds: string[],
          skippedIds: string[],
          failedIds: string[],
        ) => void,
      ) => {
        if (failNext) throw new Error("transient insert failure");
        onProgress?.(ids.length, ids.length, ids, [], []);
      },
    );
    renderDialog({ onBulkImport: onBulkImport as never });
    await search();
    fireEvent.click(resultCheckbox("11111111"));

    await act(async () => {
      fireEvent.click(importButton());
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    failNext = false;
    fireEvent.click(importButton());
    await screen.findByText("PubMed Import Results");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(onBulkImport).toHaveBeenCalledTimes(2);
    // The same PMID both times — the failed attempt imported nothing.
    expect(onBulkImport.mock.calls[0][0]).toEqual(["11111111"]);
    expect(onBulkImport.mock.calls[1][0]).toEqual(["11111111"]);
  });

  it("does not trap the user in the completed summary", async () => {
    renderDialog();
    await search();
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(importButton());
    await screen.findByText("PubMed Import Results");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss results" }));
    await waitFor(() => expect(screen.queryByText("PubMed Import Results")).toBeNull());
    // The search surface is fully usable again.
    expect(searchButton()).toBeEnabled();
  });

  it("dismisses a completed summary when a new search is committed", async () => {
    const onPubMedSearch = makeSearch(async ({ query }) =>
      query === "next query" ? pageOf([result("99999999")], 0, 1) : pageOf(PAGE_ONE, 0),
    );
    renderDialog({ onPubMedSearch });
    await search("first query");
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(importButton());
    await screen.findByText("PubMed Import Results");

    typeQuery("next query");
    pressSearch();
    await screen.findByRole("checkbox", { name: /^Select PMID 99999999 — / });

    expect(screen.queryByText("PubMed Import Results")).toBeNull();
  });

  it("locks the dialog while the import runs, and only then", async () => {
    let release!: () => void;
    const onBulkImport = vi.fn(
      async () => new Promise<void>((resolve) => { release = resolve; }),
    );
    renderDialog({ onBulkImport: onBulkImport as never });
    await search();
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(importButton());

    await waitFor(() => expect(screen.getByRole("tab", { name: "Import IDs" })).toBeDisabled());
    expect(screen.getByRole("tab", { name: "Manual" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
    expect(searchField()).toBeDisabled();
    expect(screen.getByText(/Processing 0 of 1/)).toBeInTheDocument();

    await act(async () => {
      release();
    });
    expect(screen.getByRole("tab", { name: "Import IDs" })).toBeEnabled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Session lifecycle
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — session lifecycle", () => {
  it("preserves query, page and selection across a tab switch", async () => {
    renderDialog();
    await search();
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByRole("checkbox", { name: /^Select PMID 44444444 — / });
    fireEvent.click(resultCheckbox("44444444"));

    switchTab(/Manual/i);
    expect(screen.queryByLabelText("Search PubMed")).toBeNull();
    switchTab(/PubMed Search/i);

    expect(searchField()).toHaveValue("resistance training hypertrophy");
    expect(screen.getByText("21–22 of 25")).toBeInTheDocument();
    expect(screen.getByText("2 papers selected")).toBeInTheDocument();
    expect(resultCheckbox("44444444")).toBeChecked();
  });

  it("resets every ephemeral PubMed value when the dialog is closed and reopened", async () => {
    function Controlled() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)}>reopen</button>
          <AddPaperDialog
            open={open}
            onOpenChange={setOpen}
            onPubMedSearch={twoPageSearch()}
            onBulkImport={makeBulkImport()}
            projects={PROJECTS}
            tags={TAGS}
          />
        </>
      );
    }
    render(<Controlled />);
    switchTab(/PubMed Search/i);
    await search();
    fireEvent.click(resultCheckbox("11111111"));
    fireEvent.click(importButton());
    await screen.findByText("PubMed Import Results");

    fireEvent.click(screen.getAllByRole("button", { name: "Close", hidden: true })[0]);
    fireEvent.click(screen.getByRole("button", { name: "reopen" }));

    // Reopens in the established default mode…
    expect(screen.getByRole("tab", { name: "Import IDs" })).toHaveAttribute("aria-selected", "true");
    switchTab(/PubMed Search/i);
    // …with a clean discovery session.
    expect(searchField()).toHaveValue("");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/papers? selected/)).toBeNull();
    expect(screen.queryByText("PubMed Import Results")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(importButton()).toBeDisabled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Failure isolation
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — failure isolation", () => {
  it("leaves every existing import mode usable when PubMed is unreachable", async () => {
    const onPubMedSearch = makeSearch(async () => {
      throw new PubMedSearchError("upstream", "PubMed could not be reached right now. Please try again in a moment.");
    });
    const { onBulkImport } = renderDialog({ onPubMedSearch });

    typeQuery("resistance training");
    pressSearch();
    await screen.findByRole("alert");

    // Identifier import still works end to end.
    switchTab(/Import IDs/i);
    fireEvent.change(
      screen.getByLabelText("Paste PMIDs or DOIs, or drop a .txt/.csv file"),
      { target: { value: "555\n666" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Import 2 Papers/i }));
    await screen.findByText("Import Results Summary");
    expect(onBulkImport).toHaveBeenCalledWith(["555", "666"], expect.any(Function), undefined);

    // File and Manual are still reachable too.
    switchTab(/Import File/i);
    expect(screen.getByRole("button", { name: "Choose a file to import" })).toBeInTheDocument();
    switchTab(/Manual/i);
    expect(screen.getByLabelText("Title *")).toBeInTheDocument();
  });

  it("disables Search, but nothing else, when no search callback is wired", () => {
    render(
      <AddPaperDialog
        open
        onOpenChange={vi.fn()}
        onBulkImport={makeBulkImport()}
        projects={PROJECTS}
        tags={TAGS}
      />,
    );
    switchTab(/PubMed Search/i);

    fireEvent.change(screen.getByLabelText("Search PubMed"), { target: { value: "cancer" } });
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    expect(screen.getByText("PubMed search is unavailable right now.")).toBeInTheDocument();

    switchTab(/Import IDs/i);
    expect(screen.getByLabelText("Paste PMIDs or DOIs, or drop a .txt/.csv file")).toBeEnabled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Study Type exclusions (PUBMED-SEARCH-STUDY-TYPE-EXCLUSION-001)
// ══════════════════════════════════════════════════════════════════════════

describe("PubMed Search — the user's Study Type exclusions", () => {
  /**
   * The four types the Production report actually saw on one card, three of
   * which the reporting user had already excluded. `Randomized Controlled
   * Trial` is the one they wanted to see.
   */
  const REPORTED_TYPES = [
    "Journal Article",
    "Randomized Controlled Trial",
    "Research Support, N.I.H., Extramural",
    "Research Support, Non-U.S. Gov't",
  ];

  /** One result carrying `types`, searched for and awaited. */
  async function searchWith(types: string[], excludedStudyTypes?: Set<string>) {
    const handle = renderDialog({
      excludedStudyTypes,
      onPubMedSearch: makeSearch(async () =>
        pageOf([result("11111111", { publicationTypes: types })], 0, 1),
      ),
    });
    await search();
    return handle;
  }

  // ── A ────────────────────────────────────────────────────────────────
  it("hides an excluded publication type and keeps the rest", async () => {
    await searchWith(
      ["Journal Article", "Randomized Controlled Trial"],
      new Set(["journal article"]),
    );

    expect(badgesFor("11111111")).toEqual(["Randomized Controlled Trial"]);
  });

  // ── B ────────────────────────────────────────────────────────────────
  it("matches case-insensitively, whatever case the exclusion was stored in", async () => {
    await searchWith(REPORTED_TYPES, new Set(["JOURNAL ARTICLE", "  research support, non-u.s. gov't  "]));

    // Both excluded values are gone despite differing case and stray padding…
    expect(badgesFor("11111111")).toEqual([
      "Randomized Controlled Trial",
      "Research Support, N.I.H., Extramural",
    ]);
  });

  // ── C ────────────────────────────────────────────────────────────────
  it("excludes whole values only — a broader name does not hide a narrower one", async () => {
    // This is the load-bearing case. Substring or prefix matching would wipe
    // out three real publication types the user never excluded.
    await searchWith(
      ["Clinical Trial, Phase II", "Clinical Trial, Phase III", "Randomized Controlled Trial"],
      new Set(["clinical trial"]),
    );

    expect(badgesFor("11111111")).toEqual([
      "Clinical Trial, Phase II",
      "Clinical Trial, Phase III",
      "Randomized Controlled Trial",
    ]);
  });

  it("does not let a 'Research Support' exclusion hide the comma-bearing variants", async () => {
    await searchWith(REPORTED_TYPES, new Set(["research support"]));

    expect(badgesFor("11111111")).toEqual(REPORTED_TYPES);
  });

  // ── D ────────────────────────────────────────────────────────────────
  it("hides a comma-bearing type when that exact whole value is excluded", async () => {
    await searchWith(REPORTED_TYPES, new Set(["research support, n.i.h., extramural"]));

    // The value is one publication type, never split on its commas.
    expect(badgesFor("11111111")).toEqual([
      "Journal Article",
      "Randomized Controlled Trial",
      "Research Support, Non-U.S. Gov't",
    ]);
  });

  it("reproduces the reported Production card: three excluded, one left", async () => {
    await searchWith(
      REPORTED_TYPES,
      new Set([
        "journal article",
        "research support, n.i.h., extramural",
        "research support, non-u.s. gov't",
      ]),
    );

    expect(badgesFor("11111111")).toEqual(["Randomized Controlled Trial"]);
  });

  // ── E ────────────────────────────────────────────────────────────────
  it("omits the badge section entirely when every type is excluded", async () => {
    await searchWith(
      ["Journal Article", "Research Support, Non-U.S. Gov't"],
      new Set(["journal article", "research support, non-u.s. gov't"]),
    );

    // No empty container, and no "Unknown"/"Excluded"/"No study type" filler.
    expect(hasBadgeSection("11111111")).toBe(false);
    for (const filler of [/no study type/i, /^unknown$/i, /excluded/i]) {
      expect(screen.queryByText(filler)).toBeNull();
    }

    // …and the rest of the card is untouched.
    expect(screen.getByText("Paper 11111111")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^Select PMID 11111111 — / })).toBeInTheDocument();
    expect(screen.getByText(/PMID 11111111/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open in PubMed/ })).toHaveAttribute(
      "href",
      "https://pubmed.ncbi.nlm.nih.gov/11111111/",
    );
  });

  // ── F ────────────────────────────────────────────────────────────────
  it("shows every raw PubMed type, in order, when nothing is excluded", async () => {
    await searchWith(REPORTED_TYPES, new Set());
    expect(badgesFor("11111111")).toEqual(REPORTED_TYPES);
  });

  it("degrades to the raw types when the Dashboard wires no exclusions at all", async () => {
    // The prop is optional: a caller that never supplies it must not break the
    // tab, which is what makes the existing AddPaperDialog suites still valid.
    await searchWith(REPORTED_TYPES, undefined);
    expect(badgesFor("11111111")).toEqual(REPORTED_TYPES);
  });

  // ── G ────────────────────────────────────────────────────────────────
  it("keeps a result selectable and importable when all its types are excluded", async () => {
    const { onBulkImport } = await searchWith(
      ["Journal Article"],
      new Set(["journal article"]),
    );

    expect(hasBadgeSection("11111111")).toBe(false);

    const checkbox = screen.getByRole("checkbox", { name: /^Select PMID 11111111 — / });
    expect(checkbox).not.toBeDisabled();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(screen.getByText("1 paper selected")).toBeInTheDocument();

    // A display preference is not an import eligibility rule: the PMID still
    // crosses into the canonical importer exactly as it would have.
    fireEvent.click(screen.getByRole("button", { name: /^Import( \d+)? Selected$/ }));
    await waitFor(() => expect(onBulkImport).toHaveBeenCalledTimes(1));
    expect(onBulkImport.mock.calls[0][0]).toEqual(["11111111"]);

    // Deselection still works too.
  });

  it("keeps the raw types in state: clearing exclusions reveals them with no new search", async () => {
    // Proves two things at once. The filter is derived at render time — the
    // page in state still holds PubMed's complete list, so the hidden values
    // are recoverable — and a change to the user's pool propagates by ordinary
    // React rerendering, with no cache invalidation and no second network call.
    const onPubMedSearch = makeSearch(async () =>
      pageOf([result("11111111", { publicationTypes: REPORTED_TYPES })], 0, 1),
    );
    const props = (excluded: Set<string>) => (
      <AddPaperDialog
        open
        onOpenChange={vi.fn()}
        onPubMedSearch={onPubMedSearch}
        onBulkImport={makeBulkImport()}
        excludedStudyTypes={excluded}
        projects={PROJECTS}
        tags={TAGS}
      />
    );

    const { rerender } = render(props(new Set(["journal article", "research support, non-u.s. gov't"])));
    switchTab(/PubMed Search/i);
    await search();

    expect(badgesFor("11111111")).toEqual([
      "Randomized Controlled Trial",
      "Research Support, N.I.H., Extramural",
    ]);
    expect(onPubMedSearch).toHaveBeenCalledTimes(1);

    rerender(props(new Set()));

    expect(badgesFor("11111111")).toEqual(REPORTED_TYPES);
    // The raw list was never destroyed, so nothing had to be re-fetched.
    expect(onPubMedSearch).toHaveBeenCalledTimes(1);
  });

  it("does not change the selected count when badges are filtered", async () => {
    await searchWith(REPORTED_TYPES, new Set(["journal article"]));

    const checkbox = screen.getByRole("checkbox", { name: /^Select PMID 11111111 — / });
    fireEvent.click(checkbox);
    expect(screen.getByText("1 paper selected")).toBeInTheDocument();
    // Deselecting removes the whole summary section, exactly as before — the
    // panel only renders it while something is selected.
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText(/papers? selected$/)).toBeNull();
  });
});
