import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Paper } from "@/types/database";

/**
 * The notice an export shows. The papers come from mocked queries, but the
 * file is written by the real `exportUtils`, so whether a BibTeX export gets
 * its compatibility notice is decided by the same serializer as in the app,
 * never by a summary made up for the test.
 */

const { mockToast, mockFetchAllPages, mockFetchInChunks } = vi.hoisted(() => ({
  mockToast: vi.fn(),
  mockFetchAllPages: vi.fn(),
  mockFetchInChunks: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock("@/lib/fetchAllPages", () => ({ fetchAllPages: mockFetchAllPages }));
vi.mock("@/lib/fetchInChunks", () => ({ fetchInChunks: mockFetchInChunks }));
vi.mock("@/lib/buildPapersQuery", () => ({ buildPapersQuery: vi.fn() }));

import { useExportPapers, type ExportFormat } from "../useExportPapers";

// ── Capture the download instead of starting one ──

interface Download {
  name: string;
  blob: Blob;
}

let downloads: Download[] = [];
let lastBlob: Blob | null = null;

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  vi.clearAllMocks();
  downloads = [];
  lastBlob = null;
  // jsdom has no object URLs: capture the Blob, and record a download when
  // the link is clicked, under the name the link gives the file.
  URL.createObjectURL = ((blob: Blob) => {
    lastBlob = blob;
    return "blob:captured";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: lastBlob as Blob });
  });
  mockFetchInChunks.mockResolvedValue([]);
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

// ── Fixtures ──

let nextId = 0;

function makePaper(overrides: Partial<Paper> = {}): Paper {
  nextId++;
  return {
    id: `paper-${nextId}`,
    user_id: "user-1",
    title: `Synthetic Paper ${nextId}`,
    authors: ["Consortium"],
    year: 2024,
    journal: "Journal of Testing",
    pmid: null,
    doi: `10.1000/ordinary-${nextId}`,
    abstract: "Abstract.",
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
    insert_order: nextId,
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    ...overrides,
  };
}

/** Each kind of paper, by what its BibTeX entry needs. */
const ordinary = () => makePaper();
/** An unbalanced brace: the DOI goes to `paperlume-doi-v1`. */
const doiMoved = () => makePaper({ doi: "10.1000/x}" });
/** No DOI and an unbalanced brace in the stored link: the URL goes to `paperlume-url-v1`. */
const urlMoved = () => makePaper({ doi: null, journal_url: "https://example.com/search?q={" });
/** A DOI with no resolver URL, so the stored link is written too: both move. */
const bothMoved = () => makePaper({ doi: "10.1000{x", journal_url: "https://example.com/?q=}" });

const ARGS = {
  userId: "user-1",
  serverFilterParams: { filterPaperIds: null, yearFrom: null, yearTo: null, studyTypes: null, notesPresence: "all" as const },
  serverSortParams: { sortColumn: null, sortAscending: null },
  tags: [],
  projects: [],
  tagsLoading: false,
  projectsLoading: false,
};

async function exportPapers(format: ExportFormat, papers: Paper[]) {
  mockFetchAllPages.mockResolvedValue(papers);
  const { result } = renderHook(() => useExportPapers(ARGS));
  await act(async () => {
    await result.current.exportPapers(format);
  });
  return result;
}

/** A download's text, read as the import dropzone reads a file (jsdom's Blob has no `text()`). */
const text = (download: Download): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(download.blob);
  });

const NOTICE_TITLE = "BibTeX exported with compatibility notice";
const ONE_PAPER =
  "1 paper has a DOI or URL preserved in a PaperLume-specific field. Other reference managers may not recognize it. PaperLume can recover it when the file is reimported.";
const papersNotice = (count: number) =>
  `${count} papers have DOI or URL values preserved in PaperLume-specific fields. Other reference managers may not recognize them. PaperLume can recover them when the file is reimported.`;

// ── BibTeX ──

describe("a BibTeX export", () => {
  it("is announced exactly as before when every DOI and URL is written raw", async () => {
    await exportPapers("bibtex", [ordinary(), ordinary()]);

    expect(mockToast.mock.calls).toEqual([[{ title: "Export started", description: "Downloading 2 papers as BIBTEX." }]]);
    expect(downloads.map((download) => download.name)).toEqual(["citations.bib"]);
    expect(await text(downloads[0])).not.toContain("paperlume-");
  });

  it("keeps the singular of the usual notice for one paper", async () => {
    await exportPapers("bibtex", [ordinary()]);

    expect(mockToast.mock.calls).toEqual([[{ title: "Export started", description: "Downloading 1 paper as BIBTEX." }]]);
  });

  it("notices one paper whose DOI is in a PaperLume field, in the singular", async () => {
    await exportPapers("bibtex", [doiMoved(), ordinary()]);

    expect(mockToast.mock.calls).toEqual([[{ title: NOTICE_TITLE, description: ONE_PAPER, variant: "destructive" }]]);
    const file = await text(downloads[0]);
    expect(file).toContain(String.raw`  paperlume-doi-v1 = {10.1000/x\textbraceright{}}`);
    expect(file.split("paperlume-")).toHaveLength(2);
  });

  it("notices one paper whose URL is in a PaperLume field", async () => {
    await exportPapers("bibtex", [urlMoved()]);

    expect(mockToast.mock.calls).toEqual([[{ title: NOTICE_TITLE, description: ONE_PAPER, variant: "destructive" }]]);
    expect(await text(downloads[0])).toContain(String.raw`  paperlume-url-v1 = {https://example.com/search?q=\textbraceleft{}}`);
  });

  it("counts a paper whose DOI and URL both moved as one paper", async () => {
    await exportPapers("bibtex", [bothMoved(), ordinary()]);

    expect(mockToast.mock.calls).toEqual([[{ title: NOTICE_TITLE, description: ONE_PAPER, variant: "destructive" }]]);
    const file = await text(downloads[0]);
    expect(file).toContain("  paperlume-doi-v1 = ");
    expect(file).toContain("  paperlume-url-v1 = ");
  });

  it("counts each affected paper once among unaffected ones, in the plural", async () => {
    await exportPapers("bibtex", [ordinary(), doiMoved(), urlMoved(), bothMoved(), ordinary(), doiMoved()]);

    expect(mockToast.mock.calls).toEqual([[{ title: NOTICE_TITLE, description: papersNotice(4), variant: "destructive" }]]);
  });

  it("is not noticed for a stored link the file does not hold", async () => {
    const link = "https://example.com/?q={";
    await exportPapers("bibtex", [
      makePaper({ pmid: "12345678", doi: null, journal_url: link }),
      makePaper({ doi: "10.1000/resolvable", journal_url: link }),
    ]);

    expect(mockToast.mock.calls).toEqual([[{ title: "Export started", description: "Downloading 2 papers as BIBTEX." }]]);
    expect(await text(downloads[0])).not.toContain("paperlume-");
  });

  it("downloads one file and shows one notice when identifiers moved", async () => {
    await exportPapers("bibtex", [doiMoved(), urlMoved(), ordinary()]);

    expect(downloads).toHaveLength(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith({ title: NOTICE_TITLE, description: papersNotice(2), variant: "destructive" });
  });
});

// ── CSV and RIS ──

describe.each([
  ["csv", "papers_export.csv", "CSV"],
  ["ris", "citations.ris", "RIS"],
] as const)("a %s export", (format, fileName, label) => {
  it("is announced as before, whatever its DOIs and URLs hold", async () => {
    await exportPapers(format, [ordinary(), doiMoved(), urlMoved(), bothMoved(), ordinary()]);

    expect(mockToast.mock.calls).toEqual([[{ title: "Export started", description: `Downloading 5 papers as ${label}.` }]]);
    expect(downloads.map((download) => download.name)).toEqual([fileName]);
    expect(await text(downloads[0])).not.toContain("paperlume-");
  });
});

// ── Failure ──

describe("a failed download", () => {
  it.each([
    ["an exceptional BibTeX export", "bibtex", () => [doiMoved(), urlMoved()]],
    ["an ordinary BibTeX export", "bibtex", () => [ordinary()]],
    ["a CSV export", "csv", () => [ordinary()]],
  ] as const)("reports the error and nothing else for %s", async (_label, format, papers) => {
    URL.createObjectURL = (() => {
      throw new Error("Download blocked");
    }) as typeof URL.createObjectURL;

    const result = await exportPapers(format, [...papers()]);

    expect(mockToast.mock.calls).toEqual([[{ title: "Export failed", description: "Download blocked", variant: "destructive" }]]);
    expect(downloads).toEqual([]);
    expect(result.current.isExporting).toBe(false);
  });
});
