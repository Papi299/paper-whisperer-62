/**
 * The `/extension-import` handoff contract.
 *
 * The parser is the trust boundary for a URL anyone can construct, so these
 * tests are weighted towards what must be *refused*. Two properties matter most:
 *
 *   • an identifier only becomes importable if the application's existing PMID
 *     or DOI grammar proves it — this route is not a weaker third grammar;
 *   • there is no title case, so text that fails validation is invalid handoff
 *     input rather than a search term. `pmid` and `doi` are per-user
 *     deduplication keys, so importing the wrong paper corrupts dedup.
 *
 * No network, no DOM, no React: the parser is a string function.
 */

import { describe, it, expect } from "vitest";

import {
  MAX_IDENTIFIER_LENGTH,
  buildExtensionImportPath,
  parseExtensionImportIntent,
} from "@/lib/extensionImportHandoff";

/** Build a query string the way a caller legitimately would. */
function query(kind: string, value: string): string {
  return `?${new URLSearchParams({ kind, value }).toString()}`;
}

describe("parseExtensionImportIntent — valid PMIDs", () => {
  const VALID_PMIDS = [
    ["ordinary", "12345678"],
    ["short", "1"],
    ["a plausible future length", "999999999999"],
    ["leading zeros are part of the value, not a repair", "0012345678"],
  ] as const;

  it.each(VALID_PMIDS)("accepts a %s PMID", (_label, pmid) => {
    expect(parseExtensionImportIntent(query("pmid", pmid))).toEqual({
      kind: "pmid",
      identifier: pmid,
    });
  });

  it("accepts a query string without its leading question mark", () => {
    expect(parseExtensionImportIntent("kind=pmid&value=12345678")).toEqual({
      kind: "pmid",
      identifier: "12345678",
    });
  });

  it("accepts URLSearchParams directly", () => {
    const params = new URLSearchParams({ kind: "pmid", value: "12345678" });
    expect(parseExtensionImportIntent(params)).toEqual({
      kind: "pmid",
      identifier: "12345678",
    });
  });

  it("ignores unrelated parameters without letting them contribute", () => {
    const search = "?utm_source=x&kind=pmid&value=12345678&ref=y";
    expect(parseExtensionImportIntent(search)).toEqual({
      kind: "pmid",
      identifier: "12345678",
    });
  });
});

describe("parseExtensionImportIntent — rejected PMIDs", () => {
  const INVALID_PMIDS = [
    ["blank", ""],
    ["whitespace only", "   "],
    ["leading whitespace — accepting it would silently repair input", " 12345678"],
    ["trailing whitespace", "12345678 "],
    ["a positive sign", "+12345678"],
    ["a negative sign", "-12345678"],
    ["letters", "12345678a"],
    ["only letters", "abcdefgh"],
    ["a decimal point", "1234.5678"],
    ["a PubMed record URL where a PMID is expected", "https://pubmed.ncbi.nlm.nih.gov/12345678/"],
    ["a bare host and path", "pubmed.ncbi.nlm.nih.gov/12345678"],
    ["a DOI", "10.1000/example"],
    ["scientific notation", "1e8"],
  ] as const;

  it.each(INVALID_PMIDS)("refuses %s", (_label, value) => {
    expect(parseExtensionImportIntent(query("pmid", value))).toBeNull();
  });
});

describe("parseExtensionImportIntent — valid DOIs", () => {
  const VALID_DOIS = [
    ["ordinary", "10.1000/example"],
    ["real-world, case preserved", "10.1056/NEJMoa2107934"],
    ["suffix containing a slash", "10.1000/a/b/c"],
    ["sub-divided registrant code", "10.1000.10/example"],
    ["suffix containing a hash", "10.1000/a#b"],
    ["suffix containing a question mark", "10.1000/a?b"],
    ["suffix containing a space", "10.1000/a b"],
    ["suffix containing angle brackets", "10.1000/<x>"],
    ["suffix containing a literal percent sign", "10.1000/foo%23bar"],
    ["trailing slash is part of the name", "10.1000/example/"],
  ] as const;

  it.each(VALID_DOIS)("accepts a DOI with %s", (_label, doi) => {
    expect(parseExtensionImportIntent(query("doi", doi))).toEqual({
      kind: "doi",
      identifier: doi,
    });
  });

  it("survives URL encoding and decoding unchanged", () => {
    // The reserved characters above only reach the parser intact if the caller
    // encoded them; this proves the whole transport, not just the validator.
    for (const [, doi] of VALID_DOIS) {
      const search = new URL(
        buildExtensionImportPath({ kind: "doi", identifier: doi }),
        "http://local.invalid",
      ).search;
      expect(parseExtensionImportIntent(search)).toEqual({
        kind: "doi",
        identifier: doi,
      });
    }
  });
});

describe("parseExtensionImportIntent — rejected DOIs", () => {
  const INVALID_DOIS = [
    ["a resolver URL where a name is expected", "https://doi.org/10.1000/example"],
    ["a legacy resolver URL", "https://dx.doi.org/10.1000/example"],
    ["an http resolver URL", "http://doi.org/10.1000/example"],
    ["a doi: presentation form", "doi:10.1000/example"],
    ["an uppercase doi: presentation form", "DOI:10.1000/example"],
    ["a urn form", "urn:doi:10.1000/example"],
    ["arbitrary slash-separated text", "foo/bar"],
    ["no suffix", "10.1000"],
    ["an empty suffix", "10.1000/"],
    ["no registrant portion", "10./example"],
    ["the directory indicator alone", "10."],
    ["no separator at all", "101000example"],
    ["blank", ""],
    ["whitespace only", "   "],
    ["a PMID", "12345678"],
    ["a publisher article URL", "https://journal.example/article/123"],
  ] as const;

  it.each(INVALID_DOIS)("refuses %s", (_label, value) => {
    expect(parseExtensionImportIntent(query("doi", value))).toBeNull();
  });
});

describe("parseExtensionImportIntent — the length bound", () => {
  it("accepts a DOI exactly at the maximum", () => {
    const prefix = "10.1000/";
    const doi = prefix + "a".repeat(MAX_IDENTIFIER_LENGTH - prefix.length);
    expect(doi).toHaveLength(MAX_IDENTIFIER_LENGTH);
    expect(parseExtensionImportIntent(query("doi", doi))).toEqual({
      kind: "doi",
      identifier: doi,
    });
  });

  it("refuses a DOI one character over the maximum", () => {
    const prefix = "10.1000/";
    const doi = prefix + "a".repeat(MAX_IDENTIFIER_LENGTH - prefix.length + 1);
    expect(doi).toHaveLength(MAX_IDENTIFIER_LENGTH + 1);
    expect(parseExtensionImportIntent(query("doi", doi))).toBeNull();
  });

  it("refuses an over-long PMID", () => {
    expect(
      parseExtensionImportIntent(query("pmid", "1".repeat(MAX_IDENTIFIER_LENGTH + 1))),
    ).toBeNull();
  });

  it("matches the per-identifier bound the metadata Edge Function enforces", () => {
    expect(MAX_IDENTIFIER_LENGTH).toBe(500);
  });
});

describe("parseExtensionImportIntent — malformed handoffs", () => {
  it("refuses a missing kind", () => {
    expect(parseExtensionImportIntent("?value=12345678")).toBeNull();
  });

  it("refuses a missing value", () => {
    expect(parseExtensionImportIntent("?kind=pmid")).toBeNull();
  });

  it("refuses an empty query string", () => {
    expect(parseExtensionImportIntent("")).toBeNull();
    expect(parseExtensionImportIntent("?")).toBeNull();
  });

  it("refuses null and undefined", () => {
    expect(parseExtensionImportIntent(null)).toBeNull();
    expect(parseExtensionImportIntent(undefined)).toBeNull();
  });

  it("refuses a repeated value rather than picking a winner", () => {
    // Two senders disagreeing about the identifier is not a situation this
    // route should resolve by first-wins or last-wins.
    expect(
      parseExtensionImportIntent("?kind=pmid&value=12345678&value=87654321"),
    ).toBeNull();
  });

  it("refuses a repeated kind", () => {
    expect(
      parseExtensionImportIntent("?kind=pmid&kind=doi&value=12345678"),
    ).toBeNull();
  });

  const UNKNOWN_KINDS = [
    "title",
    "url",
    "pmcid",
    "isbn",
    "PMID",
    "Doi",
    "",
    "pmid ",
  ] as const;

  it.each(UNKNOWN_KINDS)("refuses the unknown kind %j", (kind) => {
    expect(parseExtensionImportIntent(query(kind, "12345678"))).toBeNull();
    expect(parseExtensionImportIntent(query(kind, "10.1000/example"))).toBeNull();
  });
});

/**
 * The rule this route shares with the extension's own classifier.
 *
 * The importer's `detectIdentifier()` ends in a `title` classification, which is
 * correct for text a person pasted into an import box. A handoff parameter is
 * machine-supplied, so there is nothing for a title search to be right about.
 */
describe("no title fallback", () => {
  const NEVER_IMPORTABLE = [
    "https://publisher.example/article/foo",
    "Effects of vitamin D on bone density",
    "https://scholar.google.com/scholar?q=crispr",
    "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/",
    "10.1000",
    "javascript:alert(1)",
  ] as const;

  it.each(NEVER_IMPORTABLE)("never classifies %j as importable", (value) => {
    for (const kind of ["pmid", "doi", "title", "url"]) {
      expect(parseExtensionImportIntent(query(kind, value))).toBeNull();
    }
  });

  it("has no result shape that could carry a title", () => {
    const intent = parseExtensionImportIntent(query("pmid", "12345678"));
    expect(intent).not.toBeNull();
    expect(["pmid", "doi"]).toContain(intent!.kind);
  });
});

describe("buildExtensionImportPath", () => {
  it("round-trips every valid intent through the parser", () => {
    const intents = [
      { kind: "pmid", identifier: "12345678" },
      { kind: "doi", identifier: "10.1000/a/b" },
      { kind: "doi", identifier: "10.1000/a#b" },
      { kind: "doi", identifier: "10.1000/a b" },
    ] as const;

    for (const intent of intents) {
      const path = buildExtensionImportPath(intent);
      expect(path.startsWith("/extension-import?")).toBe(true);
      const search = new URL(path, "http://local.invalid").search;
      expect(parseExtensionImportIntent(search)).toEqual(intent);
    }
  });

  it("percent-encodes a suffix that would otherwise end the query", () => {
    const path = buildExtensionImportPath({ kind: "doi", identifier: "10.1000/a#b" });
    expect(path).not.toContain("#b");
    expect(path).toContain("%23b");
  });
});
