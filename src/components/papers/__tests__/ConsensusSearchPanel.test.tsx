import { useState } from "react";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
import type { Project, Tag } from "@/types/database";
import type { PubMedSearchPage } from "@/lib/searchPubMedEdge";
import {
  ConsensusSearchError,
  type ConsensusSearchResponse,
  type ConsensusSearchResult,
} from "@/lib/searchConsensusEdge";
import type { ConsensusSearchFn } from "@/hooks/useConsensusSearch";

import { AddPaperDialog } from "../AddPaperDialog";
import { CONSENSUS_QUOTA_NOTE } from "../ConsensusSearchPanel";

/**
 * CONSENSUS-SEARCH-MVP-001A — the owner-only Consensus source inside Add
 * Papers → Search.
 *
 * Rendered through the real `AddPaperDialog`, like the PubMed suite, because
 * the properties worth proving are boundaries the dialog owns: that only an
 * owner-wired dialog shows Consensus at all, that choosing a source never
 * searches, that the ONLY thing crossing from Consensus into persistence is a
 * list of validated DOI strings handed to the same `onBulkImport` every other
 * mode uses — with the shared Project/Tag selections — and that closing the
 * dialog puts the source back to PubMed.
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

// ── Deterministic Consensus fixtures (application-owned shape) ───────────

const LONG_ABSTRACT =
  "Background: this invented abstract is deliberately longer than the card's excerpt so the excerpt has to stop " +
  "somewhere sensible. Methods: nothing was measured, because nothing exists. Results: the fixture remains a " +
  "fixture. Conclusions: the discovery card must show a compact excerpt rather than the whole abstract, and the " +
  "words beyond the cut — UNIQUE_TAIL_MARKER — must not be rendered.";

function consensusResult(rank: number, overrides: Partial<ConsensusSearchResult> = {}): ConsensusSearchResult {
  return {
    rank,
    title: `Consensus paper ${rank}`,
    authors: ["Ada Fixture", "Ben Placeholder", "Cara Example", "Dan Sample"],
    journal: "Journal of Synthetic Fixtures",
    year: 2024,
    abstract: LONG_ABSTRACT,
    citationCount: 47,
    studyType: "rct",
    takeaway: `Synthetic takeaway for paper ${rank}.`,
    consensusUrl: `https://consensus.app/papers/synthetic-slug-${rank}/0123456789abcdef0123456789abcdef/?utm_source=publicapi`,
    importDoi: `10.5555/consensus.${rank}`,
    ...overrides,
  };
}

const RESULTS: ConsensusSearchResult[] = [
  consensusResult(1),
  consensusResult(2, { title: "Discovery-only paper", importDoi: null }),
  consensusResult(3),
];

function makeConsensusSearch(results: ConsensusSearchResult[] = RESULTS) {
  return vi.fn<ConsensusSearchFn>(async () => ({ results }));
}

/** A Consensus search whose promises the test settles by hand. */
function deferredConsensusSearch() {
  const pending: Array<{ resolve(r: ConsensusSearchResponse): void; reject(e: unknown): void }> = [];
  const search = vi.fn<ConsensusSearchFn>(
    () =>
      new Promise<ConsensusSearchResponse>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return { search, pending };
}

function pubmedSearchFn() {
  return vi.fn(
    async (): Promise<PubMedSearchPage> => ({
      query: "resistance training",
      total: 1,
      offset: 0,
      limit: 20,
      results: [
        {
          pmid: "11111111",
          title: "PubMed paper",
          authors: ["Author A"],
          journal: "Journal of Deterministic Discovery",
          publicationDate: "2024 Mar",
          year: 2024,
          publicationTypes: ["Journal Article"],
          doi: null,
        },
      ],
    }),
  );
}

type ProgressFn = (current: number, total: number, addedIds: string[], skippedIds: string[], failedIds: string[]) => void;

function makeBulkImport(
  outcome: (ids: string[]) => { addedIds: string[]; skippedIds: string[]; failedIds: string[] } = (ids) => ({
    addedIds: ids,
    skippedIds: [],
    failedIds: [],
  }),
) {
  return vi.fn(
    async (
      ids: string[],
      onProgress?: ProgressFn,
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

const sourceGroup = () => screen.getByRole("radiogroup", { name: "Search source" });
const sourceRadio = (name: "PubMed" | "Consensus") => within(sourceGroup()).getByRole("radio", { name });
const chooseSource = (name: "PubMed" | "Consensus") => fireEvent.click(sourceRadio(name));
const consensusField = () => screen.getByLabelText("Search Consensus") as HTMLInputElement;
const searchButton = () => screen.getByRole("button", { name: "Search" });
const importButton = () => screen.getByRole("button", { name: /^Import( \d+)? Selected$/ });
const resultCheckbox = (doi: string) =>
  screen.getByRole("checkbox", { name: new RegExp(`^Select DOI ${doi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — `) });
const rowOf = (text: string) => screen.getByText(text).closest("li") as HTMLElement;

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

const selectProjects = (...names: string[]) => selectFromPopover(/projects?/i, "Search projects...", names);
const selectTags = (...names: string[]) => selectFromPopover(/tags?/i, "Search tags...", names);

interface RenderOptions {
  /** `null` renders the ordinary-user dialog: no Consensus callback at all. */
  onConsensusSearch?: ConsensusSearchFn | null;
  onPubMedSearch?: ReturnType<typeof pubmedSearchFn>;
  onBulkImport?: ReturnType<typeof makeBulkImport>;
}

function renderDialog(options: RenderOptions = {}) {
  const onConsensusSearch =
    options.onConsensusSearch === null ? undefined : (options.onConsensusSearch ?? makeConsensusSearch());
  const onPubMedSearch = options.onPubMedSearch ?? pubmedSearchFn();
  const onBulkImport = options.onBulkImport ?? makeBulkImport();
  const onOpenChange = vi.fn();
  const view = render(
    <AddPaperDialog
      open
      onOpenChange={onOpenChange}
      onPubMedSearch={onPubMedSearch}
      onConsensusSearch={onConsensusSearch}
      onBulkImport={onBulkImport}
      projects={PROJECTS}
      tags={TAGS}
    />,
  );
  switchTab(/^Search$/);
  return { onConsensusSearch, onPubMedSearch, onBulkImport, onOpenChange, view };
}

/** Owner: switch to Consensus, type, press Search and wait for the results. */
async function consensusSearch(query = "Does creatine improve cognition?") {
  chooseSource("Consensus");
  fireEvent.change(consensusField(), { target: { value: query } });
  fireEvent.click(searchButton());
  await screen.findByText("Showing 3 Consensus results");
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
// Ordinary users
// ══════════════════════════════════════════════════════════════════════════

describe("Search mode — an ordinary user", () => {
  it("names the first mode Search and keeps exactly four modes", () => {
    renderDialog({ onConsensusSearch: null });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Search", "Import IDs", "Import File", "Manual"]);
    expect(tabs[0]).toHaveTextContent(/^Search$/);
  });

  it("renders the PubMed experience directly, with no Consensus control anywhere", () => {
    renderDialog({ onConsensusSearch: null });
    expect(screen.getByLabelText("Search PubMed")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Search source" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByLabelText("Search Consensus")).toBeNull();
    expect(screen.queryByText(/Consensus/)).toBeNull();
    expect(screen.getByText("Search PubMed, import by identifier, upload a file, or add manually.")).toBeInTheDocument();
  });

  it("still searches PubMed exactly as before", async () => {
    const { onPubMedSearch } = renderDialog({ onConsensusSearch: null });
    fireEvent.change(screen.getByLabelText("Search PubMed"), { target: { value: "resistance training" } });
    fireEvent.click(searchButton());
    await screen.findByRole("checkbox", { name: /^Select PMID 11111111 — / });
    expect(onPubMedSearch).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The owner's source selector
// ══════════════════════════════════════════════════════════════════════════

describe("Search mode — the owner's source selector", () => {
  it("offers PubMed | Consensus and starts on PubMed", () => {
    renderDialog();
    expect(within(sourceGroup()).getAllByRole("radio").map((r) => r.textContent)).toEqual(["PubMed", "Consensus"]);
    expect(sourceRadio("PubMed")).toHaveAttribute("aria-checked", "true");
    expect(sourceRadio("Consensus")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByLabelText("Search PubMed")).toBeInTheDocument();
    expect(screen.queryByLabelText("Search Consensus")).toBeNull();
    expect(
      screen.getByText("Search PubMed or Consensus, import by identifier, upload a file, or add manually."),
    ).toBeInTheDocument();
  });

  it("switching sources issues no request to either provider", () => {
    const { onConsensusSearch, onPubMedSearch } = renderDialog();
    chooseSource("Consensus");
    expect(consensusField()).toBeInTheDocument();
    expect(screen.getByText(CONSENSUS_QUOTA_NOTE)).toBeInTheDocument();
    chooseSource("PubMed");
    chooseSource("Consensus");
    expect(onConsensusSearch).not.toHaveBeenCalled();
    expect(onPubMedSearch).not.toHaveBeenCalled();
  });

  it("choosing the active source again keeps it chosen", () => {
    renderDialog();
    chooseSource("Consensus");
    chooseSource("Consensus");
    expect(sourceRadio("Consensus")).toHaveAttribute("aria-checked", "true");
    expect(consensusField()).toBeInTheDocument();
  });

  it("preserves each source's own work across switches", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Search PubMed"), { target: { value: "pubmed draft" } });
    await consensusSearch("consensus question");
    fireEvent.click(resultCheckbox("10.5555/consensus.1"));

    chooseSource("PubMed");
    expect(screen.getByLabelText("Search PubMed")).toHaveValue("pubmed draft");
    chooseSource("Consensus");
    expect(consensusField()).toHaveValue("consensus question");
    expect(resultCheckbox("10.5555/consensus.1")).toBeChecked();
  });

  it("falls back to PubMed at once if Consensus is withdrawn while the dialog is open", async () => {
    const { view, onBulkImport, onPubMedSearch } = renderDialog();
    chooseSource("Consensus");
    view.rerender(
      <AddPaperDialog
        open
        onOpenChange={vi.fn()}
        onPubMedSearch={onPubMedSearch}
        onConsensusSearch={undefined}
        onBulkImport={onBulkImport}
        projects={PROJECTS}
        tags={TAGS}
      />,
    );
    expect(screen.queryByRole("radiogroup", { name: "Search source" })).toBeNull();
    expect(screen.queryByLabelText("Search Consensus")).toBeNull();
    expect(screen.getByLabelText("Search PubMed")).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Explicit, deliberate search
// ══════════════════════════════════════════════════════════════════════════

describe("Consensus — every search is explicit", () => {
  it("typing searches nothing; pressing Search searches once with the trimmed query", async () => {
    const { onConsensusSearch } = renderDialog();
    chooseSource("Consensus");
    fireEvent.change(consensusField(), { target: { value: "  creatine cognition  " } });
    expect(onConsensusSearch).not.toHaveBeenCalled();

    fireEvent.click(searchButton());
    await screen.findByText("Showing 3 Consensus results");
    expect(onConsensusSearch).toHaveBeenCalledTimes(1);
    expect(onConsensusSearch).toHaveBeenCalledWith({ query: "creatine cognition" });
  });

  it("Enter in the query field is the same single, explicit submission", async () => {
    const { onConsensusSearch } = renderDialog();
    chooseSource("Consensus");
    fireEvent.change(consensusField(), { target: { value: "creatine" } });
    fireEvent.submit(consensusField().closest("form") as HTMLFormElement);
    await screen.findByText("Showing 3 Consensus results");
    expect(onConsensusSearch).toHaveBeenCalledTimes(1);
  });

  it("disables Search for an empty or over-long question", () => {
    renderDialog();
    chooseSource("Consensus");
    expect(searchButton()).toBeDisabled();
    fireEvent.change(consensusField(), { target: { value: "q".repeat(501) } });
    expect(searchButton()).toBeDisabled();
    expect(screen.getByText("Shorten the question to 500 characters or fewer (currently 501).")).toBeInTheDocument();
    expect(consensusField()).toHaveAttribute("aria-invalid", "true");
  });

  it("disables Search while a request is in flight, announces it, and sends nothing more", async () => {
    const { search, pending } = deferredConsensusSearch();
    renderDialog({ onConsensusSearch: search });
    chooseSource("Consensus");
    fireEvent.change(consensusField(), { target: { value: "creatine" } });
    fireEvent.click(searchButton());

    expect(searchButton()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Searching Consensus…");
    fireEvent.click(searchButton());
    fireEvent.submit(consensusField().closest("form") as HTMLFormElement);
    expect(search).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending[0].resolve({ results: RESULTS });
    });
    expect(searchButton()).toBeEnabled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders no pagination of any kind", async () => {
    renderDialog();
    await consensusSearch();
    for (const name of [/Next/i, /Previous/i, /Load more/i, /Show more/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Results
// ══════════════════════════════════════════════════════════════════════════

describe("Consensus — result cards", () => {
  it("shows the discovery fields compactly", async () => {
    renderDialog();
    await consensusSearch();
    const row = rowOf("Consensus paper 1");
    expect(within(row).getByText("Ada Fixture, Ben Placeholder, Cara Example +1")).toBeInTheDocument();
    expect(within(row).getByText("Journal of Synthetic Fixtures · 2024 · 47 citations")).toBeInTheDocument();
    expect(within(row).getByText("RCT")).toBeInTheDocument();
    expect(within(row).getByText("Study type:")).toHaveClass("sr-only");
    expect(within(row).getByText("DOI 10.5555/consensus.1")).toBeInTheDocument();
    // The abstract is an excerpt, never the whole text.
    expect(row.textContent).toContain("Background: this invented abstract");
    expect(row.textContent).not.toContain("UNIQUE_TAIL_MARKER");
    expect(row.textContent).toContain("…");
  });

  it("labels the takeaway as Consensus-generated and not saved", async () => {
    renderDialog();
    await consensusSearch();
    const row = rowOf("Consensus paper 1");
    expect(row.textContent).toContain(
      "Consensus takeaway (generated by Consensus · not saved): Synthetic takeaway for paper 1.",
    );
  });

  it("renders upstream text as text — never as markup", async () => {
    renderDialog({
      onConsensusSearch: makeConsensusSearch([
        consensusResult(1, { title: '<img src=x onerror="alert(1)">Injected', takeaway: "<b>bold?</b>" }),
      ]),
    });
    chooseSource("Consensus");
    fireEvent.change(consensusField(), { target: { value: "x" } });
    fireEvent.click(searchButton());
    await screen.findByText('<img src=x onerror="alert(1)">Injected');
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });

  it("shows a result without an importable DOI as discovery-only: no checkbox, a clear note", async () => {
    renderDialog();
    await consensusSearch();
    const row = rowOf("Discovery-only paper");
    expect(within(row).queryByRole("checkbox")).toBeNull();
    expect(within(row).getByText("No importable DOI available")).toBeInTheDocument();
    // Still a real result: its link and details render.
    expect(within(row).getByRole("link", { name: /Open in Consensus/ })).toBeInTheDocument();
  });

  it("opens a validated Consensus link safely in a new tab", async () => {
    renderDialog();
    await consensusSearch();
    const link = within(rowOf("Consensus paper 1")).getByRole("link", { name: /Open in Consensus/ });
    expect(link).toHaveAttribute(
      "href",
      "https://consensus.app/papers/synthetic-slug-1/0123456789abcdef0123456789abcdef/?utm_source=publicapi",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("(opens in a new tab)");
  });

  it("never renders an unvalidated link, even if one reaches the panel", async () => {
    renderDialog({
      onConsensusSearch: makeConsensusSearch([
        consensusResult(1, { consensusUrl: "javascript:alert(1)" }),
        consensusResult(2, { consensusUrl: "https://consensus.app.evil.example/papers/x/" }),
        consensusResult(3, { consensusUrl: null }),
      ]),
    });
    await consensusSearch();
    expect(screen.queryAllByRole("link", { name: /Open in Consensus/ })).toHaveLength(0);
    for (const anchor of Array.from(document.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href") ?? "").not.toMatch(/^javascript:|evil\.example/);
    }
  });

  it("never makes a row selectable from an importDoi that does not re-validate", async () => {
    renderDialog({
      onConsensusSearch: makeConsensusSearch([
        consensusResult(1, { title: "Forged DOI", importDoi: "doi:10.5555/forged" }),
        consensusResult(2),
        consensusResult(3),
      ]),
    });
    await consensusSearch();
    expect(within(rowOf("Forged DOI")).queryByRole("checkbox")).toBeNull();
    expect(within(rowOf("Forged DOI")).getByText("No importable DOI available")).toBeInTheDocument();
  });

  it("answers an empty result list plainly", async () => {
    renderDialog({ onConsensusSearch: makeConsensusSearch([]) });
    chooseSource("Consensus");
    fireEvent.change(consensusField(), { target: { value: "nothing" } });
    fireEvent.click(searchButton());
    await screen.findByText("No Consensus results found. Try rephrasing your question.");
  });

  it.each([
    ["quota_exhausted", "The connected Consensus API allowance has been used up. It resets or can be raised from the Consensus account."],
    ["rate_limited", "Consensus is receiving requests too quickly. Please wait a moment and try again."],
    ["not_configured", "Consensus search is not configured on the server yet."],
  ] as const)("announces a %s failure as an alert with its safe copy", async (kind, message) => {
    renderDialog({
      onConsensusSearch: vi.fn<ConsensusSearchFn>(async () => {
        throw new ConsensusSearchError(kind, message);
      }),
    });
    chooseSource("Consensus");
    fireEvent.change(consensusField(), { target: { value: "creatine" } });
    fireEvent.click(searchButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("nests no interactive control inside another", async () => {
    renderDialog();
    await consensusSearch();
    const list = screen.getByRole("list", { name: "Consensus search results" });
    expect(
      list.querySelectorAll("a a, a button, button a, button button, [role=checkbox] a, a [role=checkbox]"),
    ).toHaveLength(0);
    // The row itself is not a click target.
    for (const item of within(list).getAllByRole("listitem")) {
      expect(item).not.toHaveAttribute("role", "button");
      expect(item).not.toHaveAttribute("tabindex");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Selection
// ══════════════════════════════════════════════════════════════════════════

describe("Consensus — selection", () => {
  it("selects importable rows individually and counts them", async () => {
    renderDialog();
    await consensusSearch();
    fireEvent.click(resultCheckbox("10.5555/consensus.3"));
    expect(resultCheckbox("10.5555/consensus.3")).toBeChecked();
    expect(screen.getByText("1 paper selected")).toBeInTheDocument();
    expect(importButton()).toHaveTextContent("Import 1 Selected");
  });

  it("select-all selects only the importable rows, then disables itself", async () => {
    renderDialog();
    await consensusSearch();
    fireEvent.click(screen.getByRole("button", { name: "Select all importable results" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeChecked();
    expect(screen.getByText("2 papers selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select all importable results" })).toBeDisabled();
  });

  it("clear selection empties it", async () => {
    renderDialog();
    await consensusSearch();
    fireEvent.click(screen.getByRole("button", { name: "Select all importable results" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText(/papers? selected/)).toBeNull();
    expect(importButton()).toBeDisabled();
  });

  it("treats DOI-equivalent results as one paper", async () => {
    renderDialog({
      onConsensusSearch: makeConsensusSearch([
        consensusResult(1, { title: "Upper", importDoi: "10.5555/SAME.Paper" }),
        consensusResult(2, { title: "Lower", importDoi: "10.5555/same.paper" }),
        consensusResult(3),
      ]),
    });
    await consensusSearch();
    fireEvent.click(resultCheckbox("10.5555/SAME.Paper"));
    // The other spelling shows as selected too, and only one paper is counted.
    expect(resultCheckbox("10.5555/same.paper")).toBeChecked();
    expect(screen.getByText("1 paper selected")).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The canonical import handoff
// ══════════════════════════════════════════════════════════════════════════

describe("Consensus — canonical import handoff", () => {
  it("sends ONLY the selected, validated DOI strings to the existing importer", async () => {
    const { onBulkImport } = renderDialog();
    await consensusSearch();
    fireEvent.click(resultCheckbox("10.5555/consensus.3"));
    fireEvent.click(resultCheckbox("10.5555/consensus.1"));
    fireEvent.click(importButton());
    await screen.findByText("Consensus Import Results");

    expect(onBulkImport).toHaveBeenCalledTimes(1);
    const [identifiers] = onBulkImport.mock.calls[0];
    expect(identifiers).toEqual(["10.5555/consensus.3", "10.5555/consensus.1"]);
    for (const identifier of identifiers) expect(typeof identifier).toBe("string");
  });

  it("hands the importer NO Consensus discovery metadata whatsoever", async () => {
    const { onBulkImport } = renderDialog();
    await consensusSearch();
    fireEvent.click(screen.getByRole("button", { name: "Select all importable results" }));
    fireEvent.click(importButton());
    await screen.findByText("Consensus Import Results");

    const serialized = JSON.stringify(onBulkImport.mock.calls[0].filter((arg) => typeof arg !== "function"));
    for (const leak of [
      "Consensus paper",
      "Ada Fixture",
      "Journal of Synthetic Fixtures",
      "invented abstract",
      "Synthetic takeaway",
      "rct",
      "consensus.app",
      "citationCount",
      "rank",
      "title",
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("imports one identifier for DOI-equivalent results", async () => {
    const { onBulkImport } = renderDialog({
      onConsensusSearch: makeConsensusSearch([
        consensusResult(1, { title: "Upper", importDoi: "10.5555/SAME.Paper" }),
        consensusResult(2, { title: "Lower", importDoi: "10.5555/same.paper" }),
        consensusResult(3),
      ]),
    });
    await consensusSearch();
    fireEvent.click(screen.getByRole("button", { name: "Select all importable results" }));
    fireEvent.click(importButton());
    await screen.findByText("Consensus Import Results");
    expect(onBulkImport.mock.calls[0][0]).toEqual(["10.5555/SAME.Paper", "10.5555/consensus.3"]);
  });

  it("passes the SHARED Project and Tag selections — chosen on PubMed, used by Consensus", async () => {
    const { onBulkImport } = renderDialog();
    await selectProjects("Alpha");
    await consensusSearch();
    await selectTags("Omega");
    fireEvent.click(resultCheckbox("10.5555/consensus.1"));
    fireEvent.click(importButton());
    await screen.findByText("Consensus Import Results");
    expect(onBulkImport.mock.calls[0][2]).toEqual({ targetProjectIds: ["p1"], targetTagIds: ["t1"] });
  });

  it("reports the run in the canonical Added / Skipped — Duplicates / Failed vocabulary, by DOI", async () => {
    const onBulkImport = makeBulkImport((ids) => ({ addedIds: [ids[0]], skippedIds: [ids[1]], failedIds: [] }));
    renderDialog({
      onBulkImport,
      onConsensusSearch: makeConsensusSearch([consensusResult(1), consensusResult(2), consensusResult(3)]),
    });
    await consensusSearch();
    fireEvent.click(screen.getByRole("button", { name: "Select all importable results" }));
    fireEvent.click(importButton());

    await screen.findByText("Consensus Import Results");
    expect(screen.getByText("Added (1)")).toBeInTheDocument();
    expect(screen.getByText("Skipped — Duplicates (1)")).toBeInTheDocument();
    expect(screen.getByText("10.5555/consensus.1")).toBeInTheDocument();
    expect(screen.getByText("10.5555/consensus.2")).toBeInTheDocument();
  });

  it("releases added and duplicate DOIs from the selection but keeps a failed one for a deliberate retry", async () => {
    const onBulkImport = makeBulkImport((ids) => ({ addedIds: [ids[0]], skippedIds: [ids[1]], failedIds: [ids[2]] }));
    renderDialog({
      onBulkImport,
      onConsensusSearch: makeConsensusSearch([consensusResult(1), consensusResult(2), consensusResult(3)]),
    });
    await consensusSearch();
    fireEvent.click(screen.getByRole("button", { name: "Select all importable results" }));
    fireEvent.click(importButton());
    await screen.findByText("Failed (1)");

    expect(resultCheckbox("10.5555/consensus.1")).not.toBeChecked();
    expect(resultCheckbox("10.5555/consensus.2")).not.toBeChecked();
    expect(resultCheckbox("10.5555/consensus.3")).toBeChecked();
    expect(screen.getByText("1 paper selected")).toBeInTheDocument();
    // Query, results and the next-run assignment section all stay.
    expect(consensusField()).toHaveValue("Does creatine improve cognition?");
    expect(screen.getByText("Assignments for next import")).toBeInTheDocument();
  });

  it("keeps the selection and explains when the import run throws", async () => {
    const onBulkImport = vi.fn(async () => {
      throw new Error("insert path detail");
    });
    renderDialog({ onBulkImport: onBulkImport as unknown as ReturnType<typeof makeBulkImport> });
    await consensusSearch();
    fireEvent.click(resultCheckbox("10.5555/consensus.1"));
    fireEvent.click(importButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The import could not be completed. Your selection was kept — you can try again.",
    );
    expect(screen.queryByText("insert path detail")).toBeNull();
    expect(resultCheckbox("10.5555/consensus.1")).toBeChecked();
  });

  it("locks modes, source and Close while the import runs, and cannot double-submit", async () => {
    let finish: () => void = () => {};
    const onBulkImport = vi.fn(
      (ids: string[], onProgress?: ProgressFn) =>
        new Promise<void>((resolve) => {
          finish = () => {
            onProgress?.(ids.length, ids.length, ids, [], []);
            resolve();
          };
        }),
    );
    renderDialog({ onBulkImport: onBulkImport as unknown as ReturnType<typeof makeBulkImport> });
    await consensusSearch();
    fireEvent.click(resultCheckbox("10.5555/consensus.1"));
    fireEvent.click(importButton());

    for (const tab of screen.getAllByRole("tab")) expect(tab).toBeDisabled();
    expect(sourceRadio("PubMed")).toBeDisabled();
    expect(sourceRadio("Consensus")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
    expect(importButton()).toBeDisabled();
    fireEvent.click(importButton());
    expect(onBulkImport).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
    });
    await screen.findByText("Consensus Import Results");
    expect(sourceRadio("PubMed")).toBeEnabled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Dialog lifecycle
// ══════════════════════════════════════════════════════════════════════════

describe("Consensus — dialog lifecycle", () => {
  function Controlled({ search }: { search: ConsensusSearchFn }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen(true)}>reopen</button>
        <AddPaperDialog
          open={open}
          onOpenChange={setOpen}
          onPubMedSearch={pubmedSearchFn()}
          onConsensusSearch={search}
          onBulkImport={makeBulkImport()}
          projects={PROJECTS}
          tags={TAGS}
        />
      </>
    );
  }

  const closeDialog = () => fireEvent.click(screen.getAllByRole("button", { name: "Close", hidden: true })[0]);
  const reopen = () => fireEvent.click(screen.getByRole("button", { name: "reopen" }));

  it("closing resets the source to PubMed and clears the Consensus session", async () => {
    render(<Controlled search={makeConsensusSearch()} />);
    switchTab(/^Search$/);
    await consensusSearch();
    fireEvent.click(resultCheckbox("10.5555/consensus.1"));

    closeDialog();
    reopen();
    switchTab(/^Search$/);

    expect(sourceRadio("PubMed")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Search PubMed")).toBeInTheDocument();
    chooseSource("Consensus");
    expect(consensusField()).toHaveValue("");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/papers? selected/)).toBeNull();
    expect(importButton()).toBeDisabled();
  });

  it("a response arriving after close cannot repopulate the reopened dialog", async () => {
    const { search, pending } = deferredConsensusSearch();
    render(<Controlled search={search} />);
    switchTab(/^Search$/);
    chooseSource("Consensus");
    fireEvent.change(consensusField(), { target: { value: "creatine" } });
    fireEvent.click(searchButton());

    closeDialog();
    await act(async () => {
      pending[0].resolve({ results: RESULTS });
    });
    reopen();
    switchTab(/^Search$/);
    chooseSource("Consensus");

    expect(screen.queryByText("Showing 3 Consensus results")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(consensusField()).toHaveValue("");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Focus and keyboard
// ══════════════════════════════════════════════════════════════════════════

describe("Consensus — focus and keyboard", () => {
  // A browser drops focus to <body> when the pressed Search button turns
  // disabled for the request. jsdom does not, so these tests drop it themselves.
  const loseFocus = () => (document.activeElement as HTMLElement | null)?.blur();

  it("moves focus to the results heading when a search settles with focus lost", async () => {
    renderDialog();
    chooseSource("Consensus");
    fireEvent.change(consensusField(), { target: { value: "creatine" } });
    loseFocus();
    fireEvent.click(searchButton());
    const heading = await screen.findByText("Showing 3 Consensus results");
    await waitFor(() => expect(heading).toHaveFocus());
    // A focus target, never a Tab stop.
    expect(heading).toHaveAttribute("tabindex", "-1");
  });

  it("returns focus to the question field when a search ends with no results", async () => {
    renderDialog({ onConsensusSearch: makeConsensusSearch([]) });
    chooseSource("Consensus");
    fireEvent.change(consensusField(), { target: { value: "nothing" } });
    loseFocus();
    fireEvent.click(searchButton());
    await screen.findByText("No Consensus results found. Try rephrasing your question.");
    await waitFor(() => expect(consensusField()).toHaveFocus());
  });

  it("never moves focus the owner has put somewhere", async () => {
    renderDialog();
    chooseSource("Consensus");
    fireEvent.change(consensusField(), { target: { value: "creatine" } });
    consensusField().focus();
    fireEvent.click(searchButton());
    await screen.findByText("Showing 3 Consensus results");
    expect(consensusField()).toHaveFocus();
  });

  it("moves between the two sources with the arrow keys, without searching", async () => {
    const { onConsensusSearch, onPubMedSearch } = renderDialog();
    sourceRadio("PubMed").focus();
    fireEvent.keyDown(sourceRadio("PubMed"), { key: "ArrowRight" });
    await waitFor(() => expect(sourceRadio("Consensus")).toHaveFocus());
    fireEvent.keyDown(sourceRadio("Consensus"), { key: "ArrowLeft" });
    await waitFor(() => expect(sourceRadio("PubMed")).toHaveFocus());
    expect(onConsensusSearch).not.toHaveBeenCalled();
    expect(onPubMedSearch).not.toHaveBeenCalled();
  });

  it("is a single Tab stop for the whole source group (roving focus)", () => {
    renderDialog();
    const stops = () =>
      [sourceGroup(), ...within(sourceGroup()).getAllByRole("radio")].filter(
        (element) => element.getAttribute("tabindex") === "0",
      );
    // Before focus enters the group, the group itself is the one Tab stop and
    // every option is reached with the arrow keys.
    expect(stops()).toEqual([sourceGroup()]);
  });

  it("treats focus parked on the dialog shell as lost, and moves it to the results", async () => {
    renderDialog();
    chooseSource("Consensus");
    fireEvent.change(consensusField(), { target: { value: "creatine" } });
    fireEvent.click(searchButton());
    // Where Radix's focus trap puts focus once the focused node is removed.
    (screen.getByRole("dialog") as HTMLElement).focus();
    const heading = await screen.findByText("Showing 3 Consensus results");
    await waitFor(() => expect(heading).toHaveFocus());
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Accessibility
// ══════════════════════════════════════════════════════════════════════════

describe("Consensus — accessibility", () => {
  it("labels the field, describes it with the quota note, and names every result checkbox by DOI and title", async () => {
    renderDialog();
    await consensusSearch();
    expect(consensusField()).toHaveAccessibleDescription(CONSENSUS_QUOTA_NOTE);
    expect(resultCheckbox("10.5555/consensus.1")).toHaveAccessibleName("Select DOI 10.5555/consensus.1 — Consensus paper 1");
    expect(screen.getByRole("list", { name: "Consensus search results" })).toBeInTheDocument();
  });

  it("states that no remaining-call figure is known — and shows none", async () => {
    renderDialog();
    await consensusSearch();
    expect(screen.queryByText(/remaining|calls left|searches left/i)).toBeNull();
  });

  it("exposes the source choice as a labelled radio group whose options are real buttons", () => {
    renderDialog();
    const radios = within(sourceGroup()).getAllByRole("radio");
    for (const radio of radios) expect(radio.tagName).toBe("BUTTON");
  });
});
