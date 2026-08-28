/**
 * The extension's one external origin, and what an identifier can do to a URL.
 *
 * Two properties, and the second is the reason this file exists.
 *
 * 1. A supported detection produces the canonical PaperLume handoff URL, and an
 *    unsupported or restricted one produces nothing at all.
 * 2. No identifier — however hostile its punctuation — can change the origin,
 *    the path, the number of query parameters, or the value that comes back out
 *    the other side.
 *
 * The second is asserted by *reparsing* the finished URL and running it through
 * `parseExtensionImportIntent`, the same parser the live route uses. "Looks
 * percent-encoded" is not the property under test: a DOI suffix may legitimately
 * contain `&`, `?`, `#`, `=`, `/` and a literal `%`, and what matters is that
 * none of them survives into the URL's *structure*. A DOI that could append
 * `&kind=pmid` would be handing PaperLume a different paper than the one the
 * user is reading, and `pmid`/`doi` are per-user deduplication keys, so that is
 * a data-integrity bug rather than a display bug.
 *
 * Corpora are the shared ones, not new DOI semantics invented here:
 *
 *   • `DOI_RESOLVER_URLS` — resolver URLs and the DOI each names. These are the
 *     values a *detection* can actually carry, so they are driven end to end
 *     through `detectPaperFromUrl`.
 *   • `DOI_CANONICAL_URL_VECTORS` — DOI names including reserved characters,
 *     Unicode and a literal `%`. Fed to the builder directly, for the structural
 *     invariants. Two of them (a name with no `10.` indicator, and one padded
 *     with spaces either side) are legitimate DOI *names* that the handoff
 *     contract deliberately refuses, so the parse round trip is asserted over
 *     the detector-reachable corpus rather than this one.
 *
 * No network, no `chrome` runtime, no DOM: `buildPaperLumeHandoffUrl` is a
 * string function, which is the whole reason it was kept out of the popup.
 */

import { describe, it, expect } from "vitest";

import { DOI_CANONICAL_URL_VECTORS } from "@/lib/__tests__/fixtures/doiEncodingVectors";
import {
  DOI_RESOLVER_URLS,
  NON_PAPER_PAGE_URLS,
  BROWSER_RESTRICTED_URLS,
  PUBMED_RECORD_URLS,
} from "@/lib/__tests__/fixtures/recordUrlVectors";
import { parseExtensionImportIntent } from "@/lib/extensionImportHandoff";

import { detectPaperFromUrl } from "../detectPaperFromUrl";
import { buildPaperLumeHandoffUrl, PAPERLUME_WEB_ORIGIN } from "../paperLumeHandoff";

/** The exact destination, restated literally so a change to the constant fails here. */
const EXPECTED_ORIGIN = "https://app.paperlume.app";
const EXPECTED_PATHNAME = "/extension-import";

/** Build for a detection that must produce a URL, and fail loudly if it does not. */
function buildOrThrow(url: string): URL {
  const built = buildPaperLumeHandoffUrl(detectPaperFromUrl(url));
  expect(built, `no handoff URL was built for ${url}`).not.toBeNull();
  return new URL(built as string);
}

/**
 * Every structural invariant a finished handoff URL must satisfy, whatever the
 * identifier was.
 */
function expectCanonicalShape(url: URL): void {
  expect(url.protocol).toBe("https:");
  expect(url.origin).toBe(EXPECTED_ORIGIN);
  expect(url.pathname).toBe(EXPECTED_PATHNAME);
  expect(url.port).toBe("");
  expect(url.username).toBe("");
  expect(url.password).toBe("");
  // A fragment would be a value that escaped the query string.
  expect(url.hash).toBe("");
  // Exactly two parameters, in the canonical order, and nothing else: no title,
  // no source page, no referrer, no ids, no timestamp, no analytics.
  expect([...url.searchParams.keys()]).toEqual(["kind", "value"]);
}

describe("PAPERLUME_WEB_ORIGIN — the extension's only web destination", () => {
  it("is the exact PaperLume Production origin over HTTPS", () => {
    expect(PAPERLUME_WEB_ORIGIN).toBe(EXPECTED_ORIGIN);
  });

  it("is an origin, with no path, query or fragment baked into it", () => {
    // A constant carrying a path is how a "fixed origin" quietly becomes a
    // fixed *URL* that a later edit can extend. `URL.origin` round-tripping to
    // the constant itself proves there is nothing after the host.
    const parsed = new URL(PAPERLUME_WEB_ORIGIN);
    expect(parsed.origin).toBe(PAPERLUME_WEB_ORIGIN);
    expect(parsed.pathname).toBe("/");
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("");
    expect(parsed.protocol).toBe("https:");
  });
});

describe("buildPaperLumeHandoffUrl — PubMed", () => {
  it.each(PUBMED_RECORD_URLS)("hands %s over as its PMID", (_label, value, pmid) => {
    const url = buildOrThrow(value);

    expectCanonicalShape(url);
    expect(url.searchParams.get("kind")).toBe("pmid");
    expect(url.searchParams.get("value")).toBe(pmid);
    expect(parseExtensionImportIntent(url.search)).toEqual({ kind: "pmid", identifier: pmid });
  });

  it("produces the exact canonical URL for a known record", () => {
    // One literal expectation, so the assembled string is stated somewhere and
    // not only described by properties.
    expect(buildPaperLumeHandoffUrl({ state: "pubmed", pmid: "12345678" })).toBe(
      "https://app.paperlume.app/extension-import?kind=pmid&value=12345678",
    );
  });
});

describe("buildPaperLumeHandoffUrl — DOI", () => {
  it.each(DOI_RESOLVER_URLS)("hands %s over as its DOI", (_label, value, doi) => {
    const url = buildOrThrow(value);

    expectCanonicalShape(url);
    expect(url.searchParams.get("kind")).toBe("doi");
    expect(url.searchParams.get("value")).toBe(doi);
    expect(parseExtensionImportIntent(url.search)).toEqual({ kind: "doi", identifier: doi });
  });

  it("produces the exact canonical URL for a known DOI", () => {
    expect(
      buildPaperLumeHandoffUrl({ state: "doi", doi: "10.1056/NEJMoa2107934" }),
    ).toBe("https://app.paperlume.app/extension-import?kind=doi&value=10.1056%2FNEJMoa2107934");
  });
});

describe("buildPaperLumeHandoffUrl — a DOI cannot escape the value parameter", () => {
  /**
   * DOI names shaped like an attempt on the query string.
   *
   * Every one is a *valid* DOI name under the existing grammar — each is
   * reachable from a real `doi.org` URL, which the assertions below prove by
   * going through the detector rather than constructing the detection by hand —
   * and every one contains the punctuation that would split a parameter,
   * overwrite a parameter, or start a fragment if the value were interpolated
   * rather than encoded.
   */
  const INJECTION_SHAPED_DOIS = [
    ["appends a second kind", "10.1000/x&kind=pmid", "https://doi.org/10.1000/x&kind=pmid"],
    ["appends a second value", "10.1000/x&value=999", "https://doi.org/10.1000/x&value=999"],
    ["opens a fragment", "10.1000/x#frag", "https://doi.org/10.1000/x%23frag"],
    ["opens a query", "10.1000/x?a=b", "https://doi.org/10.1000/x%3Fa%3Db"],
    ["looks like an authority", "10.1000/x//evil.example", "https://doi.org/10.1000/x%2F%2Fevil.example"],
    ["looks pre-encoded", "10.1000/foo%23bar", "https://doi.org/10.1000/foo%2523bar"],
  ] as const;

  it.each(INJECTION_SHAPED_DOIS)(
    "a DOI that %s stays inside value",
    (_label, doi, resolverUrl) => {
      // Proves the vector is reachable: a real resolver URL yields this DOI.
      expect(detectPaperFromUrl(resolverUrl)).toEqual({ state: "doi", doi });

      const url = buildOrThrow(resolverUrl);

      expectCanonicalShape(url);
      expect(url.searchParams.get("kind")).toBe("doi");
      expect(url.searchParams.get("value")).toBe(doi);
      // The parser the live route uses gets back exactly the DOI that went in.
      expect(parseExtensionImportIntent(url.search)).toEqual({ kind: "doi", identifier: doi });
      // The whole DOI is inside one parameter, so the URL text can hold no
      // unencoded separator after the two the builder wrote.
      expect(url.toString().split("&")).toHaveLength(2);
      expect(url.toString().split("#")).toHaveLength(1);
    },
  );

  it.each(DOI_CANONICAL_URL_VECTORS)(
    "keeps the canonical shape for %s",
    (_label, doiName) => {
      const built = buildPaperLumeHandoffUrl({ state: "doi", doi: doiName });
      expect(built).not.toBeNull();

      const url = new URL(built as string);
      expectCanonicalShape(url);
      // Whatever the punctuation, the value survives byte for byte.
      expect(url.searchParams.get("value")).toBe(doiName);
    },
  );

  it("cannot vary the origin no matter what the identifier is", () => {
    // The single property §19 asks for, stated once over every DOI the shared
    // corpora contain plus the injection-shaped ones above.
    const everyDoi = [
      ...DOI_CANONICAL_URL_VECTORS.map(([, name]) => name),
      ...DOI_RESOLVER_URLS.map(([, , doi]) => doi),
      ...INJECTION_SHAPED_DOIS.map(([, doi]) => doi),
    ];
    expect(everyDoi.length).toBeGreaterThan(20);

    for (const doi of everyDoi) {
      const built = buildPaperLumeHandoffUrl({ state: "doi", doi });
      expect(new URL(built as string).origin, `origin changed for ${doi}`).toBe(EXPECTED_ORIGIN);
      expect(new URL(built as string).pathname, `pathname changed for ${doi}`).toBe(
        EXPECTED_PATHNAME,
      );
    }
  });
});

describe("buildPaperLumeHandoffUrl — nothing to hand over", () => {
  it("builds no URL for an unsupported page", () => {
    expect(buildPaperLumeHandoffUrl({ state: "unsupported" })).toBeNull();
  });

  it("builds no URL for a restricted tab", () => {
    expect(buildPaperLumeHandoffUrl({ state: "restricted" })).toBeNull();
  });

  it.each(NON_PAPER_PAGE_URLS)("builds no URL from %s", (_label, value) => {
    expect(buildPaperLumeHandoffUrl(detectPaperFromUrl(value))).toBeNull();
  });

  it.each(BROWSER_RESTRICTED_URLS)("builds no URL from %s", (_label, value) => {
    expect(buildPaperLumeHandoffUrl(detectPaperFromUrl(value))).toBeNull();
  });
});
