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

    expect(bib).toContain("pmid      = {12345678}");
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

// ── Invalid stored PMIDs ──

/**
 * A field whose semantics assert "this is a PMID" must not carry a value that
 * fails the PMID syntax rule. Paperlume's own importer would reject it, but an
 * exported file is read by tools that have no reason to re-validate.
 *
 * Only provably invalid values are dropped — see the digit-only case at the end.
 */
describe("a syntactically invalid stored PMID is not exported as a PMID", () => {
  const invalidPmids = ["L629384756", "WOS:000123456700001", "123abc"];

  for (const invalid of invalidPmids) {
    describe(`stored pmid = ${invalid}`, () => {
      const paper = () => makePaper({ pmid: invalid, doi: "10.1000/example" });

      for (const { name, run, reimport } of EXPORTERS) {
        it(name, async () => {
          run([paper()]);
          const text = await exported();

          // Absent from the file entirely, so no PMID-bearing field carries it.
          expect(text).not.toContain(invalid);
          expect(text).not.toContain("pubmed.ncbi.nlm.nih.gov");
          expect(text).toContain("https://doi.org/10.1000/example");

          const reimported = reimport(text).papers[0];
          expect(reimported.pmid).toBeNull();
          expect(reimported.doi).toBe("10.1000/example");
          expect(reimported.pubmed_url).toBeNull();
          expect(reimported.journal_url).toBe("https://doi.org/10.1000/example");
        });
      }
    });
  }

  it("RIS omits the compatibility AN line entirely", async () => {
    exportToRIS([makePaper({ pmid: "L629384756", doi: "10.1000/example" })]);
    const ris = await exported();

    expect(ris).not.toContain("AN  - ");
    expect(ris).toContain("UR  - https://doi.org/10.1000/example");
  });

  it("BibTeX omits the pmid field entirely", async () => {
    exportToBibTeX([makePaper({ pmid: "L629384756", doi: "10.1000/example" })]);
    const bib = await exported();

    expect(bib).not.toContain("pmid      = ");
    expect(bib).toContain("url       = {https://doi.org/10.1000/example}");
  });

  it("CSV leaves the PMID column empty and keeps the rest of the row intact", async () => {
    exportToCSV([makePaper({ pmid: "L629384756", doi: "10.1000/example" })]);
    const csv = await exported();
    const [header, row] = csv.split("\n");

    expect(header.split(",")[4]).toBe("PMID");
    expect(row).not.toContain("L629384756");

    // Dropping the value must not shift the columns.
    const reimported = parseCSV(csv).papers[0];
    expect(reimported.pmid).toBeNull();
    expect(reimported.doi).toBe("10.1000/example");
    expect(reimported.title).toBe("Effect of Treatment on Outcomes");
    expect(reimported.journal).toBe("Journal of Testing");
  });

  // The limit of what export can know. This value may have been fabricated by
  // the old RIS `AN` rule from a numeric accession, but the row holds no
  // evidence either way, so it stays authoritative. Repairing it would need a
  // separate evidence-backed cleanup objective, not a guess at export time.
  it("keeps a digit-only historical PMID, which the row cannot disprove", async () => {
    exportToRIS([makePaper({ pmid: "2019345678", doi: "10.1000/example" })]);
    const ris = await exported();

    expect(ris).toContain("AN  - 2019345678");
    expect(ris).toContain("UR  - https://pubmed.ncbi.nlm.nih.gov/2019345678/");
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

// ── DOI resolver link encoding ──

/**
 * A DOI suffix is opaque, so it may contain characters that mean something else
 * inside a URL. The URL fields therefore carry the *canonical percent-encoded
 * resolver URL*, while the DOI fields carry the DOI *name* — two different
 * things that used to be the same string.
 *
 * `10.1000/456#789` is the DOI Handbook's own example of why: interpolated into
 * a path, a browser reads `#789` as a fragment and asks the proxy to resolve
 * `10.1000/456`, a different DOI.
 */
describe("a DOI with URL-significant characters exports a usable link", () => {
  const DOI_NAME = "10.1000/456#789";
  const CANONICAL_URL = "https://doi.org/10.1000/456%23789";
  const specialDoi = () => makePaper({ doi: DOI_NAME });

  it("CSV URL column carries the canonical resolver URL", async () => {
    exportToCSV([specialDoi()]);
    const reimported = parseCSV(await exported()).papers[0];

    expect(reimported.journal_url).toBe(CANONICAL_URL);
  });

  it("RIS UR carries the canonical resolver URL", async () => {
    exportToRIS([specialDoi()]);
    expect(await exported()).toContain(`UR  - ${CANONICAL_URL}`);
  });

  it("BibTeX url carries the canonical resolver URL", async () => {
    exportToBibTeX([specialDoi()]);
    expect(await exported()).toContain(`url       = {${CANONICAL_URL}}`);
  });

  it("no format emits the truncating raw interpolation", async () => {
    for (const { run } of EXPORTERS) {
      run([specialDoi()]);
      expect(await exported()).not.toContain("https://doi.org/10.1000/456#789");
    }
  });

  describe("identifier fields keep the DOI name, not the URL representation", () => {
    // A DOI field asserts "this is a DOI". Percent-encoding it because the
    // neighbouring URL field is encoded would publish a DOI that is not the
    // paper's DOI, and a reference manager reading it would not re-decode.
    it("CSV DOI column", async () => {
      exportToCSV([specialDoi()]);
      const reimported = parseCSV(await exported()).papers[0];

      expect(reimported.doi).toBe(DOI_NAME);
    });

    it("RIS DO", async () => {
      exportToRIS([specialDoi()]);
      expect(await exported()).toContain(`DO  - ${DOI_NAME}`);
    });

    it("BibTeX doi", async () => {
      exportToBibTeX([specialDoi()]);
      expect(await exported()).toContain(`doi       = {${DOI_NAME}}`);
    });

    it("never percent-encodes the identifier field", async () => {
      for (const { run } of EXPORTERS) {
        run([specialDoi()]);
        const output = await exported();
        expect(output).not.toContain("10.1000%2F456");
        expect(output).toContain(DOI_NAME);
      }
    });
  });

  it("a suffix slash stays inside the DOI rather than becoming a path segment", async () => {
    // Only the first `/` separates prefix from suffix; the rest is DOI data.
    exportToRIS([makePaper({ doi: "10.1000/foo/bar" })]);
    const ris = await exported();

    expect(ris).toContain("UR  - https://doi.org/10.1000/foo%2Fbar");
    expect(ris).toContain("DO  - 10.1000/foo/bar");
  });

  it("an ordinary DOI is byte-for-byte unchanged by the encoder", async () => {
    // The regression risk of introducing an encoder at all: the common case
    // must look exactly as it did before.
    exportToRIS([makePaper({ doi: "10.1056/NEJMoa2107934" })]);
    const ris = await exported();

    expect(ris).toContain("UR  - https://doi.org/10.1056/NEJMoa2107934");
    expect(ris).toContain("DO  - 10.1056/NEJMoa2107934");
  });
});

describe("PMID precedence over the DOI resolver is unchanged", () => {
  it("exports the PubMed record URL even when a special-character DOI exists", async () => {
    exportToRIS([makePaper({ pmid: "12345678", doi: "10.1000/456#789" })]);
    const ris = await exported();

    expect(ris).toContain("UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/");
    expect(ris).not.toContain("UR  - https://doi.org/");
    // The DOI is still published as an identifier, just not as the URL.
    expect(ris).toContain("DO  - 10.1000/456#789");
  });
});

describe("a stored DOI that cannot form a resolver URL falls through", () => {
  it("uses the journal link rather than exporting an unusable DOI link", async () => {
    // No prefix/suffix separator, so no resolver URL exists for it. Previously
    // this exported `https://doi.org/10.1000`, which the proxy cannot answer.
    exportToRIS([
      makePaper({ doi: "10.1000", journal_url: "https://example.com/article" }),
    ]);
    const ris = await exported();

    expect(ris).toContain("UR  - https://example.com/article");
    expect(ris).not.toContain("https://doi.org/");
    // The stored value is still published as the DOI it claims to be; export is
    // not the place to repair it.
    expect(ris).toContain("DO  - 10.1000");
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
