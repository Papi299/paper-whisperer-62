/**
 * The extension's URL boundary.
 *
 * Two properties are under test, and the second matters more than the first.
 *
 * 1. A structurally authenticated PubMed record or DOI resolver URL yields its
 *    identifier.
 * 2. Nothing else does. The adversarial corpora in
 *    `src/lib/__tests__/fixtures/recordUrlVectors.ts` are lookalike hosts,
 *    authority-confusion authorities, and URLs that carry a PubMed or DOI URL in
 *    a query or fragment — every one of which contains the right substrings and
 *    none of which is a record. `pmid` and `doi` are per-user deduplication
 *    keys, so a URL that acquires authority it has not earned corrupts dedup for
 *    that record rather than merely showing the wrong text.
 *
 * No network access, no `chrome` runtime, no DOM: `detectPaperFromUrl` is a
 * string function, which is the whole reason the classifier was kept separate
 * from the popup that calls it.
 */

import { describe, it, expect } from "vitest";

import { detectIdentifier } from "../../../supabase/functions/_shared/identifierDetection.ts";
import {
  BROWSER_RESTRICTED_URLS,
  DOI_RESOLVER_URLS,
  NON_DOI_URLS,
  NON_PAPER_PAGE_URLS,
  NON_PUBMED_URLS,
  PUBMED_RECORD_URLS,
} from "@/lib/__tests__/fixtures/recordUrlVectors";
import { detectPaperFromUrl } from "../detectPaperFromUrl";

describe("detectPaperFromUrl — PubMed records", () => {
  it.each(PUBMED_RECORD_URLS)("detects %s and reports its PMID", (_label, value, pmid) => {
    expect(detectPaperFromUrl(value)).toEqual({ state: "pubmed", pmid });
  });
});

describe("detectPaperFromUrl — DOI resolver URLs", () => {
  it.each(DOI_RESOLVER_URLS)("detects %s and reports its DOI", (_label, value, doi) => {
    expect(detectPaperFromUrl(value)).toEqual({ state: "doi", doi });
  });
});

describe("detectPaperFromUrl — values that must never be detected as a paper", () => {
  it.each(NON_PUBMED_URLS)("refuses PubMed authority to %s", (_label, value) => {
    expect(detectPaperFromUrl(value).state).not.toBe("pubmed");
    expect(detectPaperFromUrl(value).state).not.toBe("doi");
  });

  it.each(NON_DOI_URLS)("refuses DOI authority to %s", (_label, value) => {
    expect(detectPaperFromUrl(value).state).not.toBe("doi");
    expect(detectPaperFromUrl(value).state).not.toBe("pubmed");
  });

  it("never returns an identifier for any negative vector", () => {
    // The two assertions above check the label; this one checks that no PMID or
    // DOI value leaked into the result object under a different state.
    for (const [, value] of [...NON_PUBMED_URLS, ...NON_DOI_URLS, ...NON_PAPER_PAGE_URLS]) {
      const detection = detectPaperFromUrl(value);
      expect(detection).not.toHaveProperty("pmid");
      expect(detection).not.toHaveProperty("doi");
    }
  });
});

describe("detectPaperFromUrl — ordinary web pages", () => {
  it.each(NON_PAPER_PAGE_URLS)("reports %s as unsupported", (_label, value) => {
    expect(detectPaperFromUrl(value)).toEqual({ state: "unsupported" });
  });

  it("reports a PMC article as unsupported rather than as a PubMed record", () => {
    // PMC is a sibling NCBI service on the legacy PubMed host, and a PMCID is
    // not a PMID. Recognising it would put a PMCID into the PMID deduplication
    // domain. If PMC is ever supported it needs its own identifier contract.
    expect(
      detectPaperFromUrl("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/"),
    ).toEqual({ state: "unsupported" });
  });
});

describe("detectPaperFromUrl — pages the extension cannot inspect", () => {
  it.each(BROWSER_RESTRICTED_URLS)("reports %s as restricted", (_label, value) => {
    expect(detectPaperFromUrl(value)).toEqual({ state: "restricted" });
  });

  it("reports a missing URL as restricted", () => {
    // Chrome omits `Tab.url` for a tab the extension holds no permission for and
    // for a tab that has not committed a navigation. Both are real inputs.
    expect(detectPaperFromUrl(undefined)).toEqual({ state: "restricted" });
    expect(detectPaperFromUrl(null)).toEqual({ state: "restricted" });
    expect(detectPaperFromUrl("")).toEqual({ state: "restricted" });
    expect(detectPaperFromUrl("   ")).toEqual({ state: "restricted" });
  });

  it("reports an unparseable value as restricted rather than guessing", () => {
    expect(detectPaperFromUrl("not a url at all")).toEqual({ state: "restricted" });
    expect(detectPaperFromUrl("pubmed.ncbi.nlm.nih.gov/12345678")).toEqual({
      state: "restricted",
    });
  });
});

/**
 * The rule this whole module exists to enforce.
 *
 * The importer's classifier ends in a `title` classification, which is right for
 * pasted import text and wrong for an address bar. These assertions pin the
 * divergence in both directions: the importer really would call these URLs a
 * title, and the extension really does not.
 */
describe("no title fallback at the URL boundary", () => {
  const PUBLISHER_URL = "https://journal.example/article/123";

  it("classifies an ordinary publisher URL as unsupported", () => {
    expect(detectPaperFromUrl(PUBLISHER_URL)).toEqual({ state: "unsupported" });
  });

  it("diverges from the importer's classifier, which would call it a title", () => {
    // Not a defect in `detectIdentifier`: a person pasting into the import box
    // may legitimately be pasting a paper title, so falling back to a title
    // search is correct there. A browser address bar never holds a title, and a
    // title search over URL punctuation would resolve some *other* paper and
    // offer to import it.
    expect(detectIdentifier(PUBLISHER_URL)).toEqual({ type: "title" });
    expect(detectPaperFromUrl(PUBLISHER_URL).state).toBe("unsupported");
  });

  it("never produces a title-shaped result for any input", () => {
    const everyVector = [
      ...PUBMED_RECORD_URLS,
      ...DOI_RESOLVER_URLS,
      ...NON_PUBMED_URLS,
      ...NON_DOI_URLS,
      ...NON_PAPER_PAGE_URLS,
      ...BROWSER_RESTRICTED_URLS,
    ].map(([, value]) => value);

    expect(everyVector.length).toBeGreaterThan(0);
    for (const value of everyVector) {
      expect(["pubmed", "doi", "unsupported", "restricted"]).toContain(
        detectPaperFromUrl(value).state,
      );
    }
  });
});
