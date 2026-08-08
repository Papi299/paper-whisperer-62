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
 *
 * The export side applies the same scepticism to what is already stored: a row
 * written before the importer was hardened may hold anything in `pubmed_url`,
 * so these tests pin what the exporter does with values that column cannot
 * vouch for. What they do *not* claim is historical repair — a syntactically
 * valid stored `pmid` stays authoritative, because nothing in the row proves
 * whether it was genuine or fabricated by the old `AN` rule.
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

/** The three export formats, for assertions that must hold in all of them. */
const EXPORTERS = [
  { name: "CSV", run: exportToCSV, reimport: parseCSV },
  { name: "RIS", run: exportToRIS, reimport: parseRIS },
  { name: "BibTeX", run: exportToBibTeX, reimport: parseBibTeX },
] as const;

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

/**
 * A stored value is not authentic because of the column it sits in.
 *
 * Rows written before import provenance was hardened can hold anything in
 * `pubmed_url`, so the exporter re-checks it structurally instead of echoing it
 * back out as a PubMed link.
 */
describe("a stored pubmed_url is re-checked before it is exported", () => {
  it("valid PMID overrides a stale stored pubmed_url", async () => {
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

  // Case 1 — no PMID at all to override the stale link, so the recognition
  // check is the only thing standing between it and the exported file.
  describe("untrusted stored pubmed_url is not exported without structural validation", () => {
    const stale = () =>
      makePaper({
        pmid: null,
        pubmed_url: "https://evil-pubmed.example/123",
        doi: "10.1000/example",
      });

    for (const { name, run } of EXPORTERS) {
      it(name, async () => {
        run([stale()]);
        const text = await exported();

        expect(text).not.toContain("evil-pubmed.example");
        expect(text).not.toContain("pubmed.ncbi.nlm.nih.gov");
        expect(text).toContain("https://doi.org/10.1000/example");
      });
    }
  });

  // Case 2 — an invalid stored PMID must not rescue the stale link either.
  describe("an invalid stored PMID does not rescue an untrusted stored pubmed_url", () => {
    const stale = () =>
      makePaper({
        pmid: "L629384756",
        pubmed_url: "https://evil-pubmed.example/123",
        doi: "10.1000/example",
      });

    for (const { name, run } of EXPORTERS) {
      it(name, async () => {
        run([stale()]);
        const text = await exported();

        expect(text).not.toContain("evil-pubmed.example");
        expect(text).not.toContain("pubmed.ncbi.nlm.nih.gov");
        expect(text).toContain("https://doi.org/10.1000/example");
      });
    }
  });

  // Case 3 — the stored link genuinely names a PubMed record, so the record it
  // names is exported in canonical form rather than as stored.
  it("canonicalizes a legitimate stored PubMed record URL when no PMID is stored", async () => {
    exportToRIS([
      makePaper({
        pmid: null,
        pubmed_url: "https://www.ncbi.nlm.nih.gov/pubmed/12345678?foo=bar",
      }),
    ]);
    const ris = await exported();

    expect(ris).toContain("UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/");
    expect(ris).not.toContain("foo=bar");

    // The identifier the old stored link only implied is now recoverable.
    const reimported = parseRIS(ris).papers[0];
    expect(reimported.pmid).toBe("12345678");
    expect(reimported.pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
  });

  // Case 4 — unusable as a link at all, and there is no fallback to reach.
  describe("a non-http(s) stored pubmed_url is not exported as a URL", () => {
    const unsafe = () =>
      makePaper({ pmid: null, pubmed_url: "javascript:alert('pubmed')", doi: null });

    for (const { name, run } of EXPORTERS) {
      it(name, async () => {
        run([unsafe()]);
        const text = await exported();

        expect(text).not.toContain("javascript:");
        expect(text).not.toContain("pubmed.ncbi.nlm.nih.gov");
      });
    }
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

// ── Journal-link-only round trips ──

/**
 * With no PMID and no DOI, a generic source link is the only link the record
 * has. The corrected importers deliberately route such links to `journal_url`,
 * so the exporter has to carry them or the round trip loses them entirely.
 */
describe("a journal-link-only paper keeps its journal link", () => {
  const journalOnly = () =>
    makePaper({
      pmid: null,
      pubmed_url: null,
      doi: null,
      journal_url: "https://journal.example.com/article",
    });

  for (const { name, run, reimport } of EXPORTERS) {
    it(name, async () => {
      run([journalOnly()]);
      const text = await exported();

      expect(text).toContain("https://journal.example.com/article");

      const reimported = reimport(text).papers[0];
      expect(reimported.pmid).toBeNull();
      expect(reimported.pubmed_url).toBeNull();
      expect(reimported.journal_url).toBe("https://journal.example.com/article");
    });
  }

  it("RIS keeps L2 alongside a higher-authority UR", async () => {
    exportToRIS([
      makePaper({ pmid: "12345678", journal_url: "https://journal.example.com/article" }),
    ]);
    const ris = await exported();

    expect(ris).toContain("UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/");
    expect(ris).toContain("L2  - https://journal.example.com/article");

    const reimported = parseRIS(ris).papers[0];
    expect(reimported.pmid).toBe("12345678");
    expect(reimported.journal_url).toBe("https://journal.example.com/article");
  });

  // Case 6 — a stored journal link is validated for the same reason a stored
  // PubMed link is, in both the generic URL slot and the RIS `L2` slot.
  describe("a non-http(s) stored journal_url is not exported as a URL", () => {
    const unsafe = () =>
      makePaper({
        pmid: null,
        pubmed_url: null,
        doi: null,
        journal_url: "javascript:alert('journal')",
      });

    for (const { name, run } of EXPORTERS) {
      it(name, async () => {
        run([unsafe()]);
        expect(await exported()).not.toContain("javascript:");
      });
    }
  });
});
