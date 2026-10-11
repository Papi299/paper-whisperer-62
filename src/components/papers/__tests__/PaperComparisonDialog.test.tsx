import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

// Every non-read surface of the client throws, so any RPC, Edge Function (and
// so any AI provider), Storage or auth use by the comparison fails the test
// that triggers it.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mockFrom,
    rpc: () => {
      throw new Error("forbidden: rpc");
    },
    get functions() {
      throw new Error("forbidden: functions");
    },
    get storage() {
      throw new Error("forbidden: storage");
    },
    get auth() {
      throw new Error("forbidden: auth");
    },
  },
}));

import { PaperComparisonDialog } from "../PaperComparisonDialog";
import { usePaperComparisonSession } from "@/hooks/usePaperComparisonSession";
import { COMPARISON_PAPER_SELECT } from "@/lib/paperComparison/query";
import { OTHER_USER_ID, OWNER_ID, makePaperRow, makeSparsePaperRow, paperId, type RawRow } from "@/lib/paperComparison/__tests__/fixtures";
import { COMPARISON_GROUPS, PROVENANCE_CAVEATS, fieldCaveat } from "../comparison/comparisonFields";

/**
 * EVIDENCE-MATRIX-001B — the comparison dialog, driven through the real
 * session hook and the real read hook against a stubbed PostgREST builder.
 * Fixtures are the synthetic ones from 001A; nothing here is a real paper.
 */

interface Response {
  data: unknown;
  error: unknown;
  status: number;
}

interface Read {
  table: string;
  ops: string[];
  select?: unknown;
  inArgs?: unknown[];
  eqArgs?: unknown[];
  respond: (response: Response) => void;
}

let reads: Read[] = [];

function installClient() {
  reads = [];
  mockFrom.mockImplementation((table: string) => {
    let respond!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const read: Read = { table, ops: [], respond };
    reads.push(read);
    const builder: Record<string, unknown> = {
      select: (columns: unknown) => {
        read.ops.push("select");
        read.select = columns;
        return builder;
      },
      in: (...args: unknown[]) => {
        read.ops.push("in");
        read.inArgs = args;
        return builder;
      },
      eq: (...args: unknown[]) => {
        read.ops.push("eq");
        read.eqArgs = args;
        return builder;
      },
      abortSignal: () => {
        read.ops.push("abortSignal");
        return response;
      },
    };
    for (const write of ["insert", "update", "upsert", "delete"]) {
      builder[write] = () => {
        throw new Error(`forbidden write: ${write}`);
      };
    }
    return builder;
  });
}

const ok = (data: unknown): Response => ({ data, error: null, status: 200 });
const failure = (status: number): Response => ({ data: null, error: { message: "synthetic failure" }, status });

/** Text queries that skip the screen-reader-only status region. */
const VISIBLE_ONLY = 'script, style, [role="status"]';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 5 * 60 * 1000, gcTime: 30 * 60 * 1000, retry: 1, refetchOnWindowFocus: true } },
  });
}

interface HarnessProps {
  /** The live library selection. */
  selection: string[];
  userId: string | null;
  /** Whether the toolbar's Compare action is still on the page. */
  showTrigger?: boolean;
}

/** What the page showed at each commit, with the user it was rendered for. */
let commits: { userId: string | null; text: string; status: string }[] = [];

/**
 * Records the whole document after every commit. Layout effects run after the
 * commit's DOM mutations and before the browser can paint, so this sees every
 * frame a user could have seen — including one that a later effect corrects.
 */
function CommitProbe({ userId }: { userId: string | null }) {
  useLayoutEffect(() => {
    commits.push({
      userId,
      text: document.body.textContent ?? "",
      status: document.querySelector('[role="dialog"] [role="status"]')?.textContent ?? "",
    });
  });
  return null;
}

/** A stand-in for the Dashboard: a selection, the toolbar's Compare action, Select all, and the dialog. */
function Harness({ selection, userId, showTrigger = true }: HarnessProps) {
  const session = usePaperComparisonSession(userId);
  return (
    <>
      <CommitProbe userId={userId} />
      {showTrigger && (
        <button type="button" data-comparison-trigger="" onClick={() => session.open(selection)}>
          Compare
        </button>
      )}
      <button type="button" role="checkbox" aria-checked="false" aria-label="Select all" />
      <PaperComparisonDialog request={session.request} currentUserId={userId} onClose={session.close} />
    </>
  );
}

function renderHarness(props: HarnessProps, queryClient = makeQueryClient()) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
  return {
    queryClient,
    ...view,
    rerenderHarness: (next: HarnessProps) =>
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <Harness {...next} />
        </QueryClientProvider>,
      ),
  };
}

/** Press Compare the way a tap in WebKit does: no focus moves to it. */
function pressCompare() {
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
}

function dialog() {
  return screen.getByRole("dialog", { name: "Compare papers" });
}

function rowTitles() {
  return within(dialog())
    .getAllByRole("rowheader")
    .map((header) => header.querySelector("[id$='-title']")?.textContent);
}

/** Answer a read and wait until the dialog has left its loading state. */
async function settle(response: Response, index = reads.length - 1) {
  await act(async () => {
    reads[index].respond(response);
  });
  await waitFor(() => expect(within(dialog()).queryByText(/^Loading \d+ papers?…$/)).toBeNull());
}

/** Activate a field-group tab (Radix activates on mouse down). */
function openGroup(label: string) {
  fireEvent.mouseDown(within(dialog()).getByRole("tab", { name: label }), { button: 0 });
}

function expectNoUuidInDocument() {
  expect(document.body.outerHTML).not.toMatch(UUID);
}

const IDS = [paperId(1), paperId(2), paperId(3)];

function rows3(prefix = "Synthetic"): RawRow[] {
  return IDS.map((id, index) => makePaperRow(id, { title: `${prefix} paper ${index + 1}`, year: 2022 - index }));
}

const originalInnerWidth = window.innerWidth;

beforeEach(() => {
  vi.clearAllMocks();
  installClient();
  commits = [];
});

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalInnerWidth });
  vi.restoreAllMocks();
});

describe("PaperComparisonDialog — opening and reading", () => {
  it("reads nothing until Compare is pressed, then once, for the frozen selection only", async () => {
    renderHarness({ selection: [IDS[2], IDS[0], IDS[1]], userId: OWNER_ID });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    pressCompare();
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      table: "papers",
      ops: ["select", "in", "eq", "abortSignal"],
      select: COMPARISON_PAPER_SELECT,
      inArgs: ["id", IDS],
      eqArgs: ["user_id", OWNER_ID],
    });
    expect(dialog()).toHaveAccessibleDescription(/read-only view of what your library had stored/i);
    // Focus starts on the title, so nothing is pre-activated.
    expect(screen.getByRole("heading", { name: "Compare papers" })).toHaveFocus();
  });

  it("announces loading, shows nothing stale, then announces the comparison", async () => {
    renderHarness({ selection: IDS, userId: OWNER_ID });
    pressCompare();
    await waitFor(() => expect(within(dialog()).getByRole("status")).toHaveTextContent("Loading 3 papers…"));
    expect(within(dialog()).queryByRole("table")).toBeNull();
    expectNoUuidInDocument();

    await settle(ok(rows3()));
    await waitFor(() => expect(within(dialog()).getByRole("status")).toHaveTextContent("Comparing 3 papers."));
    expect(rowTitles()).toEqual(["Synthetic paper 1", "Synthetic paper 2", "Synthetic paper 3"]);
    expectNoUuidInDocument();
  });

  it("reads papers by id only — unloaded pages and filtered-out papers need no list query", async () => {
    // The ids below are on no list page in this harness at all.
    const offList = [paperId(101), paperId(250)];
    renderHarness({ selection: offList, userId: OWNER_ID });
    pressCompare();
    await settle(ok(offList.map((id, index) => makePaperRow(id, { title: `Unloaded paper ${index + 1}`, year: 2000 + index }))));
    expect(rowTitles()).toEqual(["Unloaded paper 2", "Unloaded paper 1"]);
    expect(mockFrom.mock.calls).toEqual([["papers"]]);
  });
});

describe("PaperComparisonDialog — sessions and the selection", () => {
  it("keeps an open comparison on its frozen ids while the selection changes", async () => {
    const view = renderHarness({ selection: [IDS[0], IDS[1]], userId: OWNER_ID });
    pressCompare();
    await settle(ok(rows3().slice(0, 2)));

    view.rerenderHarness({ selection: [IDS[2], paperId(9)], userId: OWNER_ID });
    view.rerenderHarness({ selection: [], userId: OWNER_ID, showTrigger: false });
    expect(reads).toHaveLength(1);
    expect(rowTitles()).toEqual(["Synthetic paper 1", "Synthetic paper 2"]);
  });

  it("closing drops the session's data; reopening is a new session with a fresh read", async () => {
    const view = renderHarness({ selection: [IDS[0], IDS[1]], userId: OWNER_ID });
    pressCompare();
    await settle(ok(rows3("First").slice(0, 2)));

    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(view.queryClient.getQueryCache().findAll({ queryKey: ["paperComparison"] }).filter((q) => q.state.data)).toEqual([]),
    );

    view.rerenderHarness({ selection: [IDS[1], IDS[2]], userId: OWNER_ID });
    pressCompare();
    expect(reads).toHaveLength(2);
    expect(reads[1].inArgs).toEqual(["id", [IDS[1], IDS[2]]]);
    expect(within(dialog()).queryByRole("table")).toBeNull();
    await settle(ok([makePaperRow(IDS[1], { title: "Fresh 2", year: 2020 }), makePaperRow(IDS[2], { title: "Fresh 3", year: 2019 })]));
    expect(rowTitles()).toEqual(["Fresh 2", "Fresh 3"]);
  });

  it("an owner change empties the dialog in the same render and closes it", async () => {
    const view = renderHarness({ selection: IDS, userId: OWNER_ID });
    pressCompare();
    await settle(ok(rows3()));
    expect(screen.getByText("Synthetic paper 1")).toBeInTheDocument();

    act(() => view.rerenderHarness({ selection: IDS, userId: OTHER_USER_ID }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Not in any frame rendered for the new user — not even while closing —
    // and not in what the status region could still read out.
    const otherUserFrames = commits.filter((commit) => commit.userId === OTHER_USER_ID);
    expect(otherUserFrames.length).toBeGreaterThan(0);
    for (const frame of otherUserFrames) {
      expect(frame.text).not.toContain("Synthetic paper");
      expect(frame.status).toBe("");
    }
    expect(reads).toHaveLength(1);
  });

  it("never mutates the selection it was opened from", async () => {
    const selection = [IDS[0], IDS[1]];
    const snapshot = [...selection];
    renderHarness({ selection, userId: OWNER_ID });
    pressCompare();
    await settle(ok(rows3().slice(0, 2)));
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(selection).toEqual(snapshot);
  });
});

describe("PaperComparisonDialog — result states", () => {
  it("names how many selected papers were unavailable, never which", async () => {
    renderHarness({ selection: IDS, userId: OWNER_ID });
    pressCompare();
    await settle(ok(rows3().slice(0, 2)));
    // Shown once on screen (the status region repeats it for screen readers).
    expect(within(dialog()).getByText(/1 of the 3 selected papers could not be included/, { ignore: VISIBLE_ONLY })).toBeVisible();
    await waitFor(() =>
      expect(within(dialog()).getByRole("status")).toHaveTextContent(
        "Comparing 2 papers. 1 of the 3 selected papers could not be included.",
      ),
    );
    expect(rowTitles()).toHaveLength(2);
    expectNoUuidInDocument();
  });

  it("does not present one paper as a comparison", async () => {
    renderHarness({ selection: [IDS[0], IDS[1]], userId: OWNER_ID });
    pressCompare();
    await settle(ok([makePaperRow(IDS[0], { title: "Lonely paper" })]));
    expect(within(dialog()).queryByRole("table")).toBeNull();
    expect(screen.queryByText("Lonely paper")).toBeNull();
    expect(within(dialog()).getByText("A comparison needs at least 2 available papers.")).toBeVisible();
    expect(within(dialog()).getByText(/1 of the 2 selected papers is available/, { ignore: VISIBLE_ONLY })).toBeVisible();
    expectNoUuidInDocument();

    fireEvent.click(within(dialog()).getByRole("button", { name: "Return to library" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a transport failure offers Try again through the hook's own retry, with focus kept in the dialog", async () => {
    const view = renderHarness({ selection: IDS, userId: OWNER_ID });
    pressCompare();
    const sessionQueries = () =>
      view.queryClient
        .getQueryCache()
        .findAll({ queryKey: ["paperComparison", OWNER_ID] })
        .map((query) => query.queryHash);
    const before = sessionQueries();
    expect(before).toHaveLength(1);
    await settle(failure(400));
    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent("The comparison could not be loaded. Try again, or close it and try again later.");
    expect(alert).not.toHaveTextContent(/400|synthetic failure/);
    expect(within(alert).queryByRole("button")).toBeNull();
    expectNoUuidInDocument();

    fireEvent.click(within(dialog()).getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("heading", { name: "Compare papers" })).toHaveFocus();
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1].inArgs).toEqual(["id", IDS]);
    // The same query, re-run — not a new session or key.
    expect(sessionQueries()).toEqual(before);
    await settle(ok(rows3()));
    expect(rowTitles()).toHaveLength(3);
  });

  it("an integrity failure fails closed: generic copy, nothing from the response, no retry", async () => {
    renderHarness({ selection: IDS, userId: OWNER_ID });
    pressCompare();
    const rows = rows3();
    rows[2] = makeSparsePaperRow(IDS[2], { user_id: OTHER_USER_ID, title: "Foreign paper" });
    await settle(ok(rows));
    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent(/did not pass a consistency check\. Nothing from it is displayed\./);
    expect(alert).not.toHaveTextContent(/owner|mismatch|integrity/i);
    expect(screen.queryByText("Synthetic paper 1")).toBeNull();
    expect(screen.queryByText("Foreign paper")).toBeNull();
    expect(within(dialog()).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(dialog()).getByRole("button", { name: "Return to library" })).toBeVisible();
    expectNoUuidInDocument();
  });
});

describe("PaperComparisonDialog — provenance and stored values", () => {
  async function openWith(rows: RawRow[]) {
    renderHarness({ selection: rows.map((row) => row.id as string), userId: OWNER_ID });
    pressCompare();
    await settle(ok(rows));
  }

  it("labels every column with its exact label and every value with its provenance caveat", async () => {
    await openWith(rows3());
    const seenCaveats = new Set<string>();
    for (const group of COMPARISON_GROUPS) {
      openGroup(group.label);
      const table = within(dialog()).getByRole("table");
      const headers = within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent);
      expect(headers.length).toBe(group.fields.length + 1);
      for (const field of group.fields) {
        // The header's accessible name is the label alone; the caveat is shown under it.
        const header = within(table).getByRole("columnheader", { name: field.label });
        expect(header).toHaveTextContent(PROVENANCE_CAVEATS[field.provenance]);
        seenCaveats.add(PROVENANCE_CAVEATS[field.provenance]);
      }
      // …and said once to assistive technology, before the table, with the
      // caveat the header hides from it.
      for (const field of group.fields) {
        const terms = within(dialog()).getAllByText(field.label, { selector: "dt" });
        expect(terms).toHaveLength(1);
        expect(terms[0].nextElementSibling?.tagName).toBe("DD");
        expect(terms[0].nextElementSibling).toHaveTextContent(fieldCaveat(field));
        expect(terms[0].compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    }
    expect(seenCaveats).toEqual(new Set(Object.values(PROVENANCE_CAVEATS)));
  });

  it("keeps the four FieldValue states distinct", async () => {
    await openWith([
      makeSparsePaperRow(IDS[0], { title: "Sparse paper", year: 2020 }),
      makePaperRow(IDS[1], {
        title: "Odd paper",
        year: 2019,
        tldr: "  Not specified ",
        study_type: "Not specified",
        raw_publication_types: [],
        authors: ["Doe J", 42],
      }),
    ]);
    const sparse = within(screen.getByRole("row", { name: /Sparse paper/ }));
    const odd = within(screen.getByRole("row", { name: /Odd paper/ }));
    expect(sparse.getAllByText("Not recorded in library").length).toBeGreaterThan(0);
    expect(odd.getByText("Stored value cannot be displayed")).toHaveAttribute("data-value-state", "unreadable");

    openGroup("Study metadata");
    const oddStudy = within(screen.getByRole("row", { name: /Odd paper/ }));
    expect(oddStudy.getByText("Stored placeholder: Not specified")).toHaveAttribute("data-value-state", "stored_placeholder");
    expect(oddStudy.getByText("Stored value cannot be displayed")).toHaveAttribute("data-value-state", "unreadable");
    const sparseStudy = within(screen.getByRole("row", { name: /Sparse paper/ }));
    expect(sparseStudy.getAllByText("Not recorded in library")[0]).toHaveAttribute("data-value-state", "not_recorded");

    openGroup("Stored research content");
    expect(within(screen.getByRole("row", { name: /Odd paper/ })).getByText("Stored placeholder: Not specified")).toBeVisible();
    // What the missing states mean is said once, in the comparison.
    expect(within(dialog()).getByText(/means your library holds no value — not that the paper did not report it/)).toBeVisible();
  });

  it("renders each stored list element as one item — a publication type with a comma stays one type", async () => {
    await openWith(rows3());
    openGroup("Study metadata");
    const row = within(screen.getByRole("row", { name: /Synthetic paper 1/ }));
    const items = row.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual(["Randomized Controlled Trial", "Clinical Trial, Phase II", "Journal Article"]);
  });

  it("shows stored markup as text, never as HTML", async () => {
    await openWith([
      makePaperRow(IDS[0], { title: "Markup paper", year: 2021, abstract: "Results: 10<sup>-4</sup> &#xd7; 2.5 ± 0.3." }),
      makePaperRow(IDS[1], { title: "Hostile paper", year: 2020, abstract: '<img src=x onerror="alert(1)"> risk' }),
    ]);
    openGroup("Stored research content");
    expect(within(dialog()).getByText("Results: 10<sup>-4</sup> &#xd7; 2.5 ± 0.3.")).toBeVisible();
    expect(within(dialog()).getByText('<img src=x onerror="alert(1)"> risk')).toBeVisible();
    expect(dialog().querySelector("sup")).toBeNull();
    expect(dialog().querySelector("img")).toBeNull();
  });

  it("clamps a very long abstract by CSS only, and expands it in place", async () => {
    const longAbstract = `Background: ${"synthetic sentence about compound A. ".repeat(150)}End of stored abstract.`;
    await openWith([
      makePaperRow(IDS[0], { title: "Long paper", year: 2021, abstract: longAbstract }),
      makePaperRow(IDS[1], { title: "Short paper", year: 2020, abstract: "Short." }),
    ]);
    openGroup("Stored research content");
    const row = within(screen.getByRole("row", { name: /Long paper/ }));
    const toggle = row.getByRole("button", { name: "Show full abstract" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const value = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    // The whole stored string is in the document even while clamped.
    expect(value.textContent).toBe(longAbstract);
    expect(value).toHaveClass("line-clamp-4");
    expect(toggle).toHaveAccessibleDescription(/Long paper/);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Show less");
    expect(value).not.toHaveClass("line-clamp-4");
    // A short abstract offers nothing to expand.
    expect(within(screen.getByRole("row", { name: /Short paper/ })).queryByRole("button", { name: /Show full/ })).toBeNull();
    // Expansion survives a sort and a group switch.
    fireEvent.change(within(dialog()).getByLabelText("Sort papers"), { target: { value: "title_asc" } });
    openGroup("Bibliographic");
    openGroup("Stored research content");
    expect(within(screen.getByRole("row", { name: /Long paper/ })).getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("says when a long list is shortened, and shows all of it on request", async () => {
    const mesh = Array.from({ length: 23 }, (_, index) => `Synthetic heading ${index + 1}`);
    await openWith([
      makePaperRow(IDS[0], { title: "Indexed paper", year: 2021, mesh_terms: mesh }),
      makePaperRow(IDS[1], { title: "Plain paper", year: 2020 }),
    ]);
    openGroup("Library organization");
    const row = within(screen.getByRole("row", { name: /Indexed paper/ }));
    expect(row.getByText("Showing 6 of 23")).toBeVisible();
    fireEvent.click(row.getByRole("button", { name: "Show all 23 MeSH terms" }));
    const list = document.getElementById(row.getByRole("button", { name: "Show less" }).getAttribute("aria-controls")!)!;
    expect(within(list).getAllByRole("listitem")).toHaveLength(23);
    expect(row.queryByText(/Showing 6 of 23/)).toBeNull();
  });

  it("keeps two papers with the same title apart, each with its own values", async () => {
    await openWith([
      makePaperRow(IDS[0], { title: "Same title", year: 2021, journal: "Journal A" }),
      makePaperRow(IDS[1], { title: "Same title", year: 2015, journal: "Journal B" }),
    ]);
    const rows = within(dialog()).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole("cell", { name: "Journal A" })).toBeInTheDocument();
    expect(within(rows[1]).getByRole("cell", { name: "Journal B" })).toBeInTheDocument();
    const links = within(dialog()).getAllByRole("link", { name: /Open in PubMed/ });
    expect(links[0]).toHaveAccessibleDescription(/Same title.*2021.*Journal A/);
    expect(links[1]).toHaveAccessibleDescription(/Same title.*2015.*Journal B/);
  });

  it("links a PMID or DOI only through the read model's derived link", async () => {
    await openWith([
      makePaperRow(IDS[0], { title: "Linked paper", year: 2021, pmid: "12345678", doi: "10.5555/synthetic.0001" }),
      makePaperRow(IDS[1], { title: "Unlinked paper", year: 2020, pmid: "PMID-not-a-number", doi: "not a doi" }),
    ]);
    const linked = within(screen.getByRole("row", { name: /Linked paper/ }));
    expect(linked.getByRole("link", { name: /Open in PubMed/ })).toHaveAttribute("href", "https://pubmed.ncbi.nlm.nih.gov/12345678/");
    const doi = linked.getByRole("link", { name: /Open DOI link/ });
    expect(doi).toHaveAttribute("href", "https://doi.org/10.5555/synthetic.0001");
    expect(doi).toHaveAttribute("target", "_blank");
    expect(doi).toHaveAttribute("rel", "noopener noreferrer");
    expect(doi).toHaveAccessibleName(/opens in a new tab/);

    const unlinked = within(screen.getByRole("row", { name: /Unlinked paper/ }));
    expect(unlinked.queryByRole("link")).toBeNull();
    // The stored text is still shown, as stored.
    expect(unlinked.getByText("PMID-not-a-number")).toBeVisible();
    expect(unlinked.getByText("not a doi")).toBeVisible();
  });

  it("offers no link the URL allowlist would change, such as a DOI with a dot segment", async () => {
    await openWith([
      makePaperRow(IDS[0], { title: "Dotted paper", year: 2021, pmid: null, doi: "10.1000/.." }),
      makePaperRow(IDS[1], { title: "Climbing paper", year: 2020, pmid: null, doi: "../10.1000/abc" }),
    ]);
    for (const title of ["Dotted paper", "Climbing paper"]) {
      expect(within(screen.getByRole("row", { name: new RegExp(title) })).queryByRole("link")).toBeNull();
    }
    expect(within(screen.getByRole("row", { name: /Dotted paper/ })).getByText("10.1000/..")).toBeVisible();
  });

  it("sorts locally, keeping every value with its paper, and never reads again", async () => {
    await openWith([
      makePaperRow(IDS[0], { title: "Beta trial", year: 2010, journal: "Journal B" }),
      makePaperRow(IDS[1], { title: "Alpha trial", year: 2020, journal: "Journal A" }),
      makePaperRow(IDS[2], { title: "Gamma trial", year: null, journal: "Journal G" }),
    ]);
    const sort = within(dialog()).getByLabelText("Sort papers");
    expect(sort).toHaveValue("year_desc");
    expect(rowTitles()).toEqual(["Alpha trial", "Beta trial", "Gamma trial"]);

    fireEvent.change(sort, { target: { value: "year_asc" } });
    expect(rowTitles()).toEqual(["Beta trial", "Alpha trial", "Gamma trial"]);
    fireEvent.change(sort, { target: { value: "title_asc" } });
    expect(rowTitles()).toEqual(["Alpha trial", "Beta trial", "Gamma trial"]);
    expect(within(dialog()).getByRole("table")).toHaveAccessibleName(/sorted by title, a to z/i);
    for (const [title, journal] of [
      ["Alpha trial", "Journal A"],
      ["Beta trial", "Journal B"],
      ["Gamma trial", "Journal G"],
    ]) {
      expect(within(screen.getByRole("row", { name: new RegExp(title) })).getByRole("cell", { name: journal })).toBeInTheDocument();
    }
    expect(reads).toHaveLength(1);
  });

  it("adds no inferred or verified claim of its own, whatever the stored text says", async () => {
    await openWith([
      makePaperRow(IDS[0], { title: "Claimful paper", year: 2021, abstract: "Low risk of bias; GRADE high; significant effect." }),
      makePaperRow(IDS[1], { title: "Quiet paper", year: 2020 }),
    ]);
    const forbidden =
      /\b(pico|sample size|effect size|significan\w*|main findings?|evidence quality|risk of bias|grade|certainty|synthesis|recommendations?|validated|confirmed)\b/i;
    for (const group of COMPARISON_GROUPS) {
      openGroup(group.label);
      const chrome = [
        ...within(dialog()).getAllByRole("columnheader"),
        ...within(dialog()).getAllByRole("tab"),
        ...within(dialog()).getAllByRole("button"),
        ...within(dialog()).getAllByRole("heading"),
        within(dialog()).getByRole("status"),
      ].map((element) => element.textContent ?? "");
      chrome.push(dialog().getAttribute("aria-describedby") ? (document.getElementById(dialog().getAttribute("aria-describedby")!)?.textContent ?? "") : "");
      for (const text of chrome) {
        expect(text).not.toMatch(forbidden);
        // "verified" appears only in the denial "not independently verified".
        expect(text.replace(/not independently verified/gi, "")).not.toMatch(/verified/i);
      }
    }
    // The stored abstract itself is shown verbatim, uncensored.
    openGroup("Stored research content");
    expect(within(dialog()).getByText("Low risk of bias; GRADE high; significant effect.")).toBeVisible();
  });
});

describe("PaperComparisonDialog — focus and phone layout", () => {
  it("returns focus to Compare even when pressing it did not focus it", async () => {
    renderHarness({ selection: IDS, userId: OWNER_ID });
    pressCompare();
    // The open modal hides the page from the accessibility tree, hence `hidden`.
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Compare", hidden: true }));
    await settle(ok(rows3()));
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Compare" })).toHaveFocus();
  });

  it("falls back to Select all when Compare is gone, and closes from its Close button", async () => {
    const view = renderHarness({ selection: IDS, userId: OWNER_ID });
    pressCompare();
    await settle(ok(rows3()));
    view.rerenderHarness({ selection: [], userId: OWNER_ID, showTrigger: false });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("checkbox", { name: "Select all" })).toHaveFocus();
  });

  it("crossing 768px with focus on a cell control moves focus to the active tab, not the dialog", async () => {
    const listeners: Array<() => void> = [];
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      renderHarness({ selection: IDS, userId: OWNER_ID });
      pressCompare();
      await settle(ok(rows3()));
      const link = within(dialog()).getAllByRole("link", { name: /Open in PubMed/ })[0];
      act(() => link.focus());
      expect(link).toHaveFocus();

      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
      act(() => listeners.forEach((listener) => listener()));
      expect(within(dialog()).queryByRole("table")).toBeNull();
      expect(within(dialog()).getAllByRole("article")).toHaveLength(3);
      expect(within(dialog()).getByRole("tab", { name: "Bibliographic" })).toHaveFocus();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("below 768px shows one card per paper, each with every field's label and caveat", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    renderHarness({ selection: IDS, userId: OWNER_ID });
    pressCompare();
    await settle(ok(rows3()));
    expect(within(dialog()).queryByRole("table")).toBeNull();
    openGroup("Study metadata");
    const cards = within(dialog()).getAllByRole("article");
    expect(cards.map((card) => within(card).getByRole("heading").textContent)).toEqual([
      "Synthetic paper 1",
      "Synthetic paper 2",
      "Synthetic paper 3",
    ]);
    for (const card of cards) {
      expect(card).toHaveAccessibleName(/Synthetic paper \d .*Doe J et al\./);
      const terms = within(card)
        .getAllByRole("term")
        .map((term) => term.textContent);
      // The prescribed caveat first, then how the classification may have been set (AI included).
      expect(terms[0]).toBe(
        "PaperLume study-type classificationSource and scientific accuracy not independently verified. It may have been set by a Study Types pool match, the publication-type fallback, AI analysis, a manual edit or a merge; which one is not recorded.",
      );
      expect(terms).toHaveLength(4);
    }
    expectNoUuidInDocument();
  });
});

describe("PaperComparisonDialog — read-only", () => {
  it("issues one SELECT and nothing else through a full session: no write, RPC, Edge Function, Storage or network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderHarness({ selection: IDS, userId: OWNER_ID });
    pressCompare();
    await settle(ok(rows3()));
    for (const group of COMPARISON_GROUPS) openGroup(group.label);
    fireEvent.change(within(dialog()).getByLabelText("Sort papers"), { target: { value: "year_asc" } });
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(mockFrom.mock.calls).toEqual([["papers"]]);
    expect(reads[0].ops).toEqual(["select", "in", "eq", "abortSignal"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
});
