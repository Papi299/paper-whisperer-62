// Structural identifier classification for the metadata-import Edge Function.
//
// These are pure classifier tests: no PubMed, Crossref, Supabase, or any other
// network request is made, because the property under test is what the function
// *decides about untrusted text*, not what a provider answers. Asking a live
// provider would prove nothing about the trust boundary and would make the
// suite depend on the network.
//
// The adversarial corpora below are the point of the module. Every entry is
// text that contains PubMed- or DOI-looking characters somewhere but is not a
// PubMed record or a DOI reference. The PubMed corpus is regression coverage:
// each entry used to be able to acquire PubMed authority, because the previous
// classifier accepted any string *containing* `pubmed.ncbi.nlm.nih.gov` and
// then recovered a PMID with an unanchored regex over the same raw text. The
// DOI corpus is the same trust boundary applied to the resolver host, so DOI
// recognition never becomes the substring test PubMed recognition used to be.
//
// The DOI assertions check the extracted DOI *value*, not just the label: a
// classifier that calls a resolver URL a DOI and then hands the whole URL to
// Crossref is still broken, so the value the provider layer will consume is
// what these tests pin.

import { describe, it, expect } from "vitest";
import {
  detectIdentifier,
  extractDoiFromDoiUrl,
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

/** Values that must never establish DOI authority, with why they are unsafe. */
const NON_DOI_URLS: ReadonlyArray<readonly [label: string, value: string]> = [
  ["near-host", "https://notdoi.org/10.1000/example"],
  ["near-host (prefixed)", "https://mydoi.org/10.1000/example"],
  ["suffix-host", "https://doi.org.evil.example/10.1000/example"],
  ["user-info authority confusion", "https://doi.org@evil.example/10.1000/example"],
  ["user-info authority confusion (dx)", "https://dx.doi.org@evil.example/10.1000/example"],
  ["query smuggling", "https://evil.example/?url=https://doi.org/10.1000/example"],
  ["fragment smuggling", "https://evil.example/#https://doi.org/10.1000/example"],
  ["foreign path text", "https://example.com/doi.org/10.1000/example"],
  ["resolver host, no path", "https://doi.org"],
  ["resolver host, root path", "https://doi.org/"],
  ["resolver host, not a DOI name", "https://doi.org/about"],
  ["directory indicator only", "https://doi.org/10."],
  ["prefix with no separator", "https://doi.org/10.1000"],
  ["prefix and separator, empty suffix", "https://doi.org/10.1000/"],
  ["DOI only in the query", "https://doi.org/?doi=10.1000/example"],
  ["DOI only in the fragment", "https://doi.org/#10.1000/example"],
  ["dot segments escaping the DOI path", "https://doi.org/10.1000/example/../../evil"],
  ["malformed percent-escape", "https://doi.org/10.1000/a%zz"],
  ["scheme-less", "doi.org/10.1000/example"],
  ["scheme-relative", "//doi.org/10.1000/example"],
  ["ftp scheme", "ftp://doi.org/10.1000/example"],
  ["javascript scheme", "javascript:https://doi.org/10.1000/example"],
  ["data scheme", "data:text/plain,https://doi.org/10.1000/example"],
  ["file scheme", "file:///doi.org/10.1000/example"],
];

/**
 * Legitimate DOI resolver URLs and the DOI name each one resolves.
 *
 * `doi.org` is the canonical proxy host documented by the DOI Foundation and
 * Crossref; `dx.doi.org` is the earlier one both state keeps resolving, and the
 * proxy answers http as well as https. The DOI is whatever the path says, taken
 * verbatim — the proxy does the same.
 */
const DOI_URLS: ReadonlyArray<readonly [label: string, value: string, doi: string]> = [
  ["canonical", "https://doi.org/10.1000/example", "10.1000/example"],
  ["uppercase host", "https://DOI.ORG/10.1000/example", "10.1000/example"],
  ["mixed-case host", "https://DoI.OrG/10.1000/example", "10.1000/example"],
  ["http", "http://doi.org/10.1000/example", "10.1000/example"],
  ["legacy dx host", "https://dx.doi.org/10.1000/example", "10.1000/example"],
  ["legacy dx host, http", "http://dx.doi.org/10.1000/example", "10.1000/example"],
  ["legacy dx host, uppercase", "https://DX.DOI.ORG/10.1000/example", "10.1000/example"],
  ["query after the DOI", "https://doi.org/10.1000/example?utm_source=x", "10.1000/example"],
  ["fragment after the DOI", "https://doi.org/10.1000/example#sec-2", "10.1000/example"],
  ["query and fragment", "https://doi.org/10.1000/example?a=b#c", "10.1000/example"],
  ["suffix containing a slash", "https://doi.org/10.1000/a/b/c", "10.1000/a/b/c"],
  ["sub-divided registrant code", "https://doi.org/10.1000.10/example", "10.1000.10/example"],
  ["real-world DOI, case preserved", "https://doi.org/10.1056/NEJMoa2107934", "10.1056/NEJMoa2107934"],
  ["percent-encoded reserved character", "https://doi.org/10.1000/a%23b", "10.1000/a#b"],
  ["percent-encoded space", "https://doi.org/10.1000/a%20b", "10.1000/a b"],
  ["percent-encoded angle brackets", "https://doi.org/10.1000/%3Cx%3E", "10.1000/<x>"],
  // The proxy treats the path verbatim, so `10.1000/182/` is a different name
  // from `10.1000/182` and genuinely 404s. Repairing it here would resolve a
  // DOI the user did not paste.
  ["trailing slash, preserved verbatim", "https://doi.org/10.1000/example/", "10.1000/example/"],
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

describe("detectIdentifier — direct DOI (existing contract, unchanged)", () => {
  it.each([
    ["bare DOI", "10.1000/example", "10.1000/example"],
    ["doi: prefix", "doi:10.1000/example", "10.1000/example"],
    ["DOI: prefix", "DOI:10.1000/example", "10.1000/example"],
    ["mixed-case prefix", "DoI:10.1000/example", "10.1000/example"],
    ["registrant with more digits", "10.1234/journal.pone.0123456", "10.1234/journal.pone.0123456"],
    ["surrounding whitespace", "  10.1000/example  ", "10.1000/example"],
    ["whitespace around a doi: prefix", "  doi: 10.1000/example ", "10.1000/example"],
  ])("classifies %s as a DOI and carries the DOI name", (_label, value, doi) => {
    expect(detectIdentifier(value)).toEqual({ type: "doi", doi });
  });

  it("takes a value beginning `10.` at its word, as it always has", () => {
    // The direct grammar is deliberately looser than the resolver-path one:
    // pasting `10.…` is an assertion that the value is a DOI, and narrowing
    // that here would reject DOIs the provider layer used to accept.
    expect(detectIdentifier("10.1000")).toEqual({ type: "doi", doi: "10.1000" });
  });

  it("does not classify a bare `doi:` with nothing after it as a DOI", () => {
    // The classification now carries a value, and an empty DOI is not one the
    // provider layer could resolve; it falls through like any other text.
    expect(detectIdentifier("doi:").type).toBe("title");
    expect(detectIdentifier("doi:   ").type).toBe("title");
  });
});

describe("detectIdentifier — DOI resolver URLs", () => {
  it.each(DOI_URLS)("accepts %s", (_label, value, doi) => {
    expect(detectIdentifier(value)).toEqual({ type: "doi", doi });
    expect(extractDoiFromDoiUrl(value)).toBe(doi);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(detectIdentifier("  https://doi.org/10.1000/example  ")).toEqual({
      type: "doi",
      doi: "10.1000/example",
    });
  });

  it("reads the DOI from the path, never from a query naming another DOI", () => {
    // Both a real DOI and an attacker-chosen one are present; the path wins.
    expect(
      detectIdentifier("https://doi.org/10.1000/real?ref=https://doi.org/10.9999/attacker"),
    ).toEqual({ type: "doi", doi: "10.1000/real" });
  });

  it("hands the provider layer a DOI it encodes exactly once", () => {
    // The point of carrying the DOI rather than relabelling the URL: this is
    // the value `fetchByDoi` receives, and these are the provider request
    // fragments built from it. Passing the resolver URL — or the still-encoded
    // path — would ask Crossref for a work that cannot exist.
    const detected = detectIdentifier("https://doi.org/10.1000/a%23b");
    expect(detected).toEqual({ type: "doi", doi: "10.1000/a#b" });

    const doi = detected.type === "doi" ? detected.doi : "";
    expect(encodeURIComponent(doi)).toBe("10.1000%2Fa%23b"); // Crossref works/<doi>
    expect(`${encodeURIComponent(doi)}[doi]`).toBe("10.1000%2Fa%23b[doi]"); // PubMed term
  });

  it("never returns a DOI classification without a usable DOI", () => {
    const corpus = [
      ...DOI_URLS.map(([, value]) => value),
      ...NON_DOI_URLS.map(([, value]) => value),
      ...PUBMED_URLS.map(([, value]) => value),
      "10.1000/example",
      "doi:10.1000/example",
      "Effects of resistance training on skeletal muscle",
      "",
    ];

    for (const value of corpus) {
      const detected = detectIdentifier(value);
      if (detected.type === "doi") {
        expect(detected.doi.trim()).toBe(detected.doi);
        expect(detected.doi.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("detectIdentifier — values that must not acquire DOI authority", () => {
  it.each(NON_DOI_URLS)("rejects %s", (_label, value) => {
    expect(extractDoiFromDoiUrl(value)).toBeNull();

    const detected = detectIdentifier(value);
    expect(detected.type).not.toBe("doi");
    expect(detected).not.toHaveProperty("doi");
  });

  it("routes a rejected DOI-looking URL to the title path, not to an error taxonomy", () => {
    // Fail-closed means "not a DOI", not "rejected": the existing fallback
    // still applies, so no new product-level failure mode is introduced.
    expect(detectIdentifier("https://notdoi.org/10.1000/example").type).toBe("title");
    expect(detectIdentifier("https://evil.example/?url=https://doi.org/10.1000/example").type).toBe(
      "title",
    );
  });

  it("never repairs a scheme-less resolver value by guessing a scheme", () => {
    expect(extractDoiFromDoiUrl("doi.org/10.1000/example")).toBeNull();
    expect(extractDoiFromDoiUrl("dx.doi.org/10.1000/example")).toBeNull();
  });

  it("does not let a DOI resolver URL acquire PubMed authority", () => {
    expect(extractPmidFromPubMedUrl("https://doi.org/10.1000/12345678")).toBeNull();
  });

  it("does not let a PubMed record URL acquire DOI authority", () => {
    for (const [, value] of PUBMED_URLS) {
      expect(extractDoiFromDoiUrl(value)).toBeNull();
    }
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
