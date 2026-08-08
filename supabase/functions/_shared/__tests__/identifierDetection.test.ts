// Structural identifier classification for the metadata-import Edge Function.
//
// These are pure classifier tests: no PubMed, Crossref, Supabase, or any other
// network request is made, because the property under test is what the function
// *decides about untrusted text*, not what a provider answers. Asking a live
// provider would prove nothing about the trust boundary and would make the
// suite depend on the network.
//
// The adversarial corpus below is the point of the module. Every entry is text
// that contains PubMed-looking characters somewhere but is not a PubMed record,
// and each one used to be able to acquire PubMed authority — the previous
// classifier accepted any string *containing* `pubmed.ncbi.nlm.nih.gov` and
// then recovered a PMID with an unanchored regex over the same raw text.

import { describe, it, expect } from "vitest";
import {
  detectIdentifier,
  extractPmidFromPubMedUrl,
} from "../identifierDetection.ts";
import { extractPmidFromPubMedUrl as frontendExtractPmid } from "@/lib/pubmedIdentifiers";

/** Values that must never establish PubMed authority, with why they are unsafe. */
const NON_PUBMED_URLS: ReadonlyArray<readonly [label: string, value: string]> = [
  ["near-host", "https://notpubmed.ncbi.nlm.nih.gov/12345678"],
  ["suffix-host", "https://pubmed.ncbi.nlm.nih.gov.evil.example/12345678"],
  ["user-info authority confusion", "https://pubmed.ncbi.nlm.nih.gov@evil.example/12345678"],
  ["query smuggling", "https://evil.example/?next=https://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["query smuggling (url=)", "https://evil.example/?url=https://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["fragment smuggling", "https://evil.example/#https://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["foreign path text", "https://example.com/pubmed.ncbi.nlm.nih.gov/12345678"],
  ["PubMed host, no record", "https://pubmed.ncbi.nlm.nih.gov/"],
  ["wrong modern path position", "https://pubmed.ncbi.nlm.nih.gov/foo/12345678"],
  ["invalid modern PMID segment", "https://pubmed.ncbi.nlm.nih.gov/123abc"],
  ["invalid modern PMID segment (trailing slash)", "https://pubmed.ncbi.nlm.nih.gov/123abc/"],
  ["wrong legacy service (pmc)", "https://www.ncbi.nlm.nih.gov/pmc/12345678"],
  ["wrong legacy service (pmc article)", "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/"],
  ["wrong legacy service (gene)", "https://www.ncbi.nlm.nih.gov/gene/123"],
  ["invalid legacy PMID", "https://www.ncbi.nlm.nih.gov/pubmed/123abc"],
  ["scheme-less", "pubmed.ncbi.nlm.nih.gov/12345678"],
  ["scheme-relative", "//pubmed.ncbi.nlm.nih.gov/12345678"],
  ["ftp scheme", "ftp://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["javascript scheme", "javascript:https://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["data scheme", "data:text/plain,https://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["file scheme", "file:///pubmed.ncbi.nlm.nih.gov/12345678"],
];

/** Legitimate PubMed record URLs and the record each one names. */
const PUBMED_URLS: ReadonlyArray<readonly [label: string, value: string, pmid: string]> = [
  ["modern", "https://pubmed.ncbi.nlm.nih.gov/12345678", "12345678"],
  ["modern, trailing slash", "https://pubmed.ncbi.nlm.nih.gov/12345678/", "12345678"],
  ["modern, uppercase host", "https://PUBMED.NCBI.NLM.NIH.GOV/12345678/", "12345678"],
  ["modern, mixed-case host", "https://PubMed.Ncbi.Nlm.Nih.Gov/12345678", "12345678"],
  ["modern, http", "http://pubmed.ncbi.nlm.nih.gov/12345678/", "12345678"],
  ["modern, query", "https://pubmed.ncbi.nlm.nih.gov/12345678/?foo=bar", "12345678"],
  ["modern, fragment", "https://pubmed.ncbi.nlm.nih.gov/12345678/#details", "12345678"],
  ["modern, sub-resource", "https://pubmed.ncbi.nlm.nih.gov/12345678/citedby/", "12345678"],
  ["legacy", "https://www.ncbi.nlm.nih.gov/pubmed/12345678", "12345678"],
  ["legacy, trailing slash", "https://www.ncbi.nlm.nih.gov/pubmed/12345678/", "12345678"],
  ["legacy, http", "http://www.ncbi.nlm.nih.gov/pubmed/12345678", "12345678"],
  ["legacy, query", "https://www.ncbi.nlm.nih.gov/pubmed/12345678/?report=abstract", "12345678"],
  ["legacy, fragment", "https://www.ncbi.nlm.nih.gov/pubmed/12345678#abstract", "12345678"],
];

describe("detectIdentifier — bare PMID", () => {
  it("classifies bare decimal digits as a PMID and carries the value", () => {
    expect(detectIdentifier("12345678")).toEqual({ type: "pmid", pmid: "12345678" });
  });

  it("trims surrounding whitespace before classifying", () => {
    // The handler already trims, but the classifier must not depend on that:
    // the PMID it hands back is what gets put into the PubMed request URL.
    expect(detectIdentifier("  12345678  ")).toEqual({ type: "pmid", pmid: "12345678" });
  });

  it("has no upper length bound — NLM assigns PMIDs sequentially", () => {
    expect(detectIdentifier("999999999999")).toEqual({ type: "pmid", pmid: "999999999999" });
  });

  it("accepts a short PMID", () => {
    expect(detectIdentifier("1")).toEqual({ type: "pmid", pmid: "1" });
  });

  it.each([
    ["signed +", "+123"],
    ["signed -", "-123"],
    ["digits with suffix", "123abc"],
    ["prefixed", "PMID:123"],
    ["Web of Science accession", "WOS:000123"],
    ["Embase accession", "L629384756"],
    ["decimal", "12.34"],
    ["thousands separator", "12,345"],
    ["internal space", "123 456"],
  ])("does not classify %s as a PMID", (_label, value) => {
    expect(detectIdentifier(value).type).not.toBe("pmid");
  });
});

describe("detectIdentifier — PubMed record URLs", () => {
  it.each(PUBMED_URLS)("accepts %s", (_label, value, pmid) => {
    expect(detectIdentifier(value)).toEqual({ type: "pubmed_url", pmid });
    expect(extractPmidFromPubMedUrl(value)).toBe(pmid);
  });

  it("reads the PMID from the path, never from a query that names another record", () => {
    // Both a real record and an attacker-chosen one are present; the path wins.
    expect(
      detectIdentifier("https://pubmed.ncbi.nlm.nih.gov/12345678/?ref=https://pubmed.ncbi.nlm.nih.gov/99999999"),
    ).toEqual({ type: "pubmed_url", pmid: "12345678" });
  });
});

describe("detectIdentifier — values that must not acquire PubMed authority", () => {
  it.each(NON_PUBMED_URLS)("rejects %s", (_label, value) => {
    expect(extractPmidFromPubMedUrl(value)).toBeNull();

    const detected = detectIdentifier(value);
    expect(detected.type).not.toBe("pubmed_url");
    expect(detected).not.toHaveProperty("pmid");
  });

  it("routes a rejected PubMed-looking URL to the title path, not to an error taxonomy", () => {
    // Fail-closed means "not PubMed", not "rejected": the existing fallback
    // still applies, so no new product-level failure mode is introduced.
    expect(detectIdentifier("https://notpubmed.ncbi.nlm.nih.gov/12345678").type).toBe("title");
    expect(detectIdentifier("pubmed.ncbi.nlm.nih.gov/12345678").type).toBe("title");
  });

  it("never repairs a scheme-less value by guessing one", () => {
    // Prepending `https://` here would manufacture the authority the module
    // exists to verify.
    expect(extractPmidFromPubMedUrl("pubmed.ncbi.nlm.nih.gov/12345678")).toBeNull();
    expect(extractPmidFromPubMedUrl("www.ncbi.nlm.nih.gov/pubmed/12345678")).toBeNull();
  });
});

describe("detectIdentifier — DOI (existing contract, unchanged)", () => {
  it.each([
    ["bare DOI", "10.1000/example"],
    ["doi: prefix", "doi:10.1000/example"],
    ["DOI: prefix", "DOI:10.1000/example"],
    ["mixed-case prefix", "DoI:10.1000/example"],
    ["registrant with more digits", "10.1234/journal.pone.0123456"],
  ])("classifies %s as a DOI", (_label, value) => {
    expect(detectIdentifier(value)).toEqual({ type: "doi" });
  });

  it("still does not recognize a doi.org URL as a direct DOI", () => {
    // Pinning the pre-existing boundary: DOI classification is out of scope
    // here, so this value keeps following the title path it followed before.
    expect(detectIdentifier("https://doi.org/10.1000/example").type).toBe("title");
  });
});

describe("detectIdentifier — title fallback", () => {
  it("classifies ordinary prose as a title", () => {
    expect(detectIdentifier("Effects of resistance training on skeletal muscle")).toEqual({
      type: "title",
    });
  });

  it("classifies a foreign URL as a title rather than a PubMed record", () => {
    expect(detectIdentifier("https://example.com/some/article").type).toBe("title");
  });

  it("classifies an empty string as a title", () => {
    // The handler rejects empty identifiers before this point; the classifier
    // must still be total.
    expect(detectIdentifier("").type).toBe("title");
  });
});

describe("parity with the frontend file-import helper", () => {
  // The Edge helper is a deliberate re-implementation: importing application
  // source into a deployed Edge Function would couple two runtime/bundling
  // domains. The two trust boundaries must nonetheless agree, so both are run
  // over the same corpus here — this test is what makes the duplication safe.
  const corpus = [
    ...PUBMED_URLS.map(([, value]) => value),
    ...NON_PUBMED_URLS.map(([, value]) => value),
  ];

  it.each(corpus)("Edge and frontend agree on %s", (value) => {
    expect(extractPmidFromPubMedUrl(value)).toBe(frontendExtractPmid(value));
  });
});
