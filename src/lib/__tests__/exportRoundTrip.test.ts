import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { exportToCSV, exportToRIS, exportToBibTeX } from "../exportUtils";
import { parseCSV, parseRIS, parseBibTeX } from "../importParsers";
import type { PaperWithTags } from "@/types/database";

/**
 * Round-trip evidence: a Paperlume export, re-imported by Paperlume, must come
 * back with the same identifiers and without inventing provenance.
 *
 * These two halves are now coupled. `AN` is no longer trusted as a PMID, so a
 * RIS export has to carry its PMID as an authenticated PubMed record URL for
 * the importer to recover it. And because a generic URL no longer falls through
 * into `pubmed_url`, a DOI-only paper must come back as a DOI-only paper rather
 * than as a PubMed one.
 */

// ── Capture the exported file instead of downloading it ──

let downloads: Blob[] = [];

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  downloads = [];
  // jsdom implements Blob and anchor clicks but not object URLs, so the
  // download step is stubbed and the Blob captured on its way past. Only these
  // two statics are replaced — the `URL` constructor itself must keep working,
  // since the parsers depend on it to authenticate hostnames.
  URL.createObjectURL = ((blob: Blob) => {
    downloads.push(blob);
    return "blob:captured";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

/**
 * The text of the file the most recent export produced, read back through the
 * same `FileReader.readAsText` the import dropzone uses. (jsdom's `Blob` has no
 * `text()`.)
 */
const exported = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(downloads[downloads.length - 1]);
  });

// ── Fixtures ──

function makePaper(overrides: Partial<PaperWithTags> = {}): PaperWithTags {
  return {
    id: "paper-1",
    user_id: "user-1",
    title: "Effect of Treatment on Outcomes",
    authors: ["Smith, John"],
    year: 2024,
    journal: "Journal of Testing",
    pmid: null,
    doi: null,
    abstract: "This is the abstract.",
    study_type: "Randomized Controlled Trial",
    raw_study_type: null,
    statistical_methods: null,
    keywords: ["treatment"],
    raw_keywords: null,
    mesh_terms: [],
    substances: [],
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
    tldr: null,
    notes: null,
    insert_order: 1,
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    tags: [],
    projects: [],
    ...overrides,
  };
}

// ── PMID round trips ──

describe("a paper with a PMID survives its own export", () => {
  const withPmid = () => makePaper({ pmid: "12345678", doi: "10.1000/test123" });

  it("RIS carries the PMID as an authenticated PubMed record URL", async () => {
    exportToRIS([withPmid()]);
    const ris = await exported();

    // The evidence the importer actually trusts.
    expect(ris).toContain("UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/");
    // `AN` is still emitted for other reference managers, but is no longer load-bearing.
    expect(ris).toContain("AN  - 12345678");

    const reimported = parseRIS(ris).papers[0];
    expect(reimported.pmid).toBe("12345678");
    expect(reimported.pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
    expect(reimported.doi).toBe("10.1000/test123");
  });

  it("RIS still recovers the PMID with AN stripped, proving UR is the source", async () => {
    exportToRIS([withPmid()]);
    const withoutAn = (await exported())
      .split("\n")
      .filter((line) => !line.startsWith("AN  - "))
      .join("\n");

    expect(parseRIS(withoutAn).papers[0].pmid).toBe("12345678");
  });

  it("CSV round-trips the PMID through the explicit column", async () => {
    exportToCSV([withPmid()]);
    const reimported = parseCSV(await exported()).papers[0];

    expect(reimported.pmid).toBe("12345678");
    expect(reimported.pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
  });

  it("BibTeX round-trips the PMID through the explicit field", async () => {
    exportToBibTeX([withPmid()]);
    const bib = await exported();

    expect(bib).toContain("url       = {https://pubmed.ncbi.nlm.nih.gov/12345678/}");

    const reimported = parseBibTeX(bib).papers[0];
    expect(reimported.pmid).toBe("12345678");
    expect(reimported.pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
  });
});

describe("a stale stored pubmed_url does not leave the application", () => {
  it("regenerates the canonical link from the PMID", async () => {
    // A row imported before this rule could be holding a non-PubMed link here.
    exportToRIS([makePaper({ pmid: "12345678", pubmed_url: "https://example.com/pubmed/999" })]);
    const ris = await exported();

    expect(ris).toContain("UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/");
    expect(ris).not.toContain("example.com");
  });

  it("does not fabricate a PubMed link when the stored PMID is not a PMID", async () => {
    exportToRIS([makePaper({ pmid: "L629384756", doi: "10.1000/test123" })]);
    const ris = await exported();

    expect(ris).not.toContain("pubmed.ncbi.nlm.nih.gov");
    expect(ris).toContain("UR  - https://doi.org/10.1000/test123");

    const reimported = parseRIS(ris).papers[0];
    expect(reimported.pmid).toBeNull();
    expect(reimported.pubmed_url).toBeNull();
    expect(reimported.journal_url).toBe("https://doi.org/10.1000/test123");
  });
});

// ── DOI-only round trips ──

describe("a DOI-only paper does not come back as PubMed", () => {
  const doiOnly = () => makePaper({ doi: "10.1056/NEJMoa2107934" });
  const resolver = "https://doi.org/10.1056/NEJMoa2107934";

  it("CSV", async () => {
    exportToCSV([doiOnly()]);
    const reimported = parseCSV(await exported()).papers[0];

    expect(reimported.doi).toBe("10.1056/NEJMoa2107934");
    expect(reimported.pmid).toBeNull();
    expect(reimported.pubmed_url).toBeNull();
    expect(reimported.journal_url).toBe(resolver);
  });

  it("RIS", async () => {
    exportToRIS([doiOnly()]);
    const reimported = parseRIS(await exported()).papers[0];

    expect(reimported.doi).toBe("10.1056/NEJMoa2107934");
    expect(reimported.pmid).toBeNull();
    expect(reimported.pubmed_url).toBeNull();
    expect(reimported.journal_url).toBe(resolver);
  });

  it("BibTeX", async () => {
    exportToBibTeX([doiOnly()]);
    const reimported = parseBibTeX(await exported()).papers[0];

    expect(reimported.doi).toBe("10.1056/NEJMoa2107934");
    expect(reimported.pmid).toBeNull();
    expect(reimported.pubmed_url).toBeNull();
    expect(reimported.journal_url).toBe(resolver);
  });
});

describe("a journal-link-only paper keeps its journal link", () => {
  it("RIS preserves L2 across the round trip", async () => {
    exportToRIS([makePaper({ journal_url: "https://journal.example.com/article" })]);
    const reimported = parseRIS(await exported()).papers[0];

    expect(reimported.pubmed_url).toBeNull();
    expect(reimported.journal_url).toBe("https://journal.example.com/article");
  });
});
