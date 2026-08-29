// The DOI metadata boundary: what a publisher's `<meta>` content is allowed to
// mean.
//
// `extractDoiFromMetadataValue` is the only place in the repository that takes a
// DOI out of *page markup*, so its input is untrusted in a way a pasted string
// is not: the user asserted nothing about it, and may not even know it is there.
// The tests below are therefore written in two halves of equal weight — the
// presentation forms that must be accepted, because refusing them would make the
// Chrome extension's fallback useless, and the values that must be refused,
// because accepting one would offer the user the wrong paper to import under a
// confident "Paper detected".
//
// Nothing here contacts a resolver. Whether a DOI is registered is doi.org's
// answer to give; the property under test is only what the string *is*.
//
// @see DOI Handbook (2025) §3.3 "Syntax of the DOI Name", §3.4.4 "HTTP Proxy
//   Form"; Crossref DOI display guidelines (display without a `doi:` prefix and
//   without `dx`, which is a display rule and not an input rule — both forms
//   exist in published metadata and both are read here).

import { describe, it, expect } from "vitest";

import { extractDoiFromMetadataValue } from "@/lib/doiIdentifiers";

/** The DOI used throughout, and the one the manual acceptance case turns on. */
const DOI = "10.1038/s41586-020-2649-2";

describe("extractDoiFromMetadataValue — accepted presentation forms", () => {
  it.each([
    ["a bare DOI name", DOI],
    ["the doi: prefix", `doi:${DOI}`],
    ["the prefix in capitals with a space", `DOI: ${DOI}`],
    ["mixed prefix case", `Doi:${DOI}`],
    ["the prefix followed by a newline", `doi:\n${DOI}`],
    ["the canonical resolver URL", `https://doi.org/${DOI}`],
    ["the resolver URL over http", `http://doi.org/${DOI}`],
    ["the deprecated dx resolver", `https://dx.doi.org/${DOI}`],
    ["the deprecated dx resolver over http", `http://dx.doi.org/${DOI}`],
    ["an upper-case resolver host", `https://DOI.ORG/${DOI}`],
  ])("reads %s", (_label, value) => {
    expect(extractDoiFromMetadataValue(value)).toBe(DOI);
  });

  it("ignores the whitespace markup puts around a content value", () => {
    // Publishers wrap long `content` attributes across lines and indent them.
    // That whitespace is markup, not DOI data — this function is the input
    // boundary, which is the one place this module's rules allow trimming.
    expect(extractDoiFromMetadataValue(`  ${DOI}  `)).toBe(DOI);
    expect(extractDoiFromMetadataValue(`\n\t${DOI}\n`)).toBe(DOI);
    expect(extractDoiFromMetadataValue(`  doi: ${DOI} `)).toBe(DOI);
    expect(extractDoiFromMetadataValue(`\n https://doi.org/${DOI} \n`)).toBe(DOI);
  });

  it("returns the DOI name, never the resolver URL it was written as", () => {
    // The handoff contract carries a DOI *name*; `/extension-import` refuses a
    // resolver URL. Returning one here would strand the Continue button.
    const read = extractDoiFromMetadataValue(`https://doi.org/${DOI}`);
    expect(read).not.toMatch(/^https?:/);
    expect(read).toBe(DOI);
  });

  it("percent-decodes a resolver path exactly once, as the URL rule already does", () => {
    // Consistency with `extractDoiFromDoiUrl` rather than a second rule: a
    // suffix's reserved characters are encoded in the URL and are data in the
    // name.
    expect(extractDoiFromMetadataValue("https://doi.org/10.1000/a%23b")).toBe("10.1000/a#b");
  });

  it("leaves the opaque suffix exactly as written", () => {
    // DOI names are equivalent only when their code points are identical, so
    // nothing may case-fold, collapse or repair the suffix.
    expect(extractDoiFromMetadataValue("10.1000/AbC-XyZ_1")).toBe("10.1000/AbC-XyZ_1");
    expect(extractDoiFromMetadataValue("10.1000/a/b/c")).toBe("10.1000/a/b/c");
    expect(extractDoiFromMetadataValue("10.1000/a b")).toBe("10.1000/a b");
  });
});

describe("extractDoiFromMetadataValue — values that get no DOI authority", () => {
  it.each([
    ["an empty string", ""],
    ["whitespace only", "   \n  "],
    ["a bare prefix with no suffix", "10.1038"],
    ["a prefix and separator with an empty suffix", "10.1038/"],
    ["a number that is not a DOI", "10"],
    ["a decimal that merely starts with 10.", "10.5"],
    ["a doi: prefix with nothing after it", "doi:"],
    ["a doi: prefix with only whitespace after it", "doi:   "],
    ["a doi: prefix wrapping something that is not a DOI", "doi:not-a-doi"],
    ["a doi: prefix wrapping a URL", `doi:https://doi.org/${DOI}`],
    ["a sentence that merely mentions a DOI", `See doi:${DOI} for details`],
    ["a sentence that merely contains a DOI name", `The DOI is ${DOI}.`],
    ["a publisher article URL", "https://www.nature.com/articles/s41586-020-2649-2"],
    ["a publisher URL whose path looks like a DOI", `https://www.nature.com/${DOI}`],
    ["a lookalike resolver host", `https://doi.org.evil.example/${DOI}`],
    ["a host that merely ends in doi.org", `https://notdoi.org/${DOI}`],
    ["a DOI carried in someone else's query string", `https://evil.example/?url=https://doi.org/${DOI}`],
    ["an authority-confusion resolver URL", `https://doi.org@evil.example/${DOI}`],
    ["a scheme-less resolver reference", `doi.org/${DOI}`],
    ["a scheme-relative resolver reference", `//doi.org/${DOI}`],
    ["the resolver root", "https://doi.org/"],
    ["another page on the resolver host", "https://doi.org/about"],
    ["a resolver URL with a prefix but no suffix", "https://doi.org/10.1038"],
    ["a javascript: URL", `javascript:${DOI}`],
    ["an ISBN", "978-3-16-148410-0"],
    ["a PMID", "33301246"],
    ["a paper title", "Array programming with NumPy"],
    ["a malformed percent escape on the resolver", "https://doi.org/10.1000/%zz"],
  ])("refuses %s", (_label, value) => {
    expect(extractDoiFromMetadataValue(value)).toBeNull();
  });

  it("refuses a non-string", () => {
    // `getAttribute` returns `string | null`, and a runtime value of some other
    // type must fail closed rather than reaching `new URL()` or a regex.
    expect(extractDoiFromMetadataValue(null)).toBeNull();
    expect(extractDoiFromMetadataValue(undefined)).toBeNull();
    expect(extractDoiFromMetadataValue(10.1038 as unknown as string)).toBeNull();
    expect(extractDoiFromMetadataValue([DOI] as unknown as string)).toBeNull();
  });

  it("does not accept a value merely because it contains 10.", () => {
    // The importer's classifier takes a leading `10.` at its word, because a
    // person pasted it and is asserting it is a DOI. Publisher markup asserts
    // nothing, so this boundary is deliberately narrower — and only narrower.
    expect(extractDoiFromMetadataValue("Volume 10.2, pages 3-4")).toBeNull();
    expect(extractDoiFromMetadataValue("version 10.14 (Sonoma)")).toBeNull();
  });
});

describe("extractDoiFromMetadataValue — the same DOI written differently", () => {
  it("normalizes every accepted form of one DOI onto one value", () => {
    // This is what makes the extension's duplicate collapsing work: a page
    // carrying `citation_doi` as a bare name and `dc.identifier` as a resolver
    // URL is describing one paper, not two.
    const forms = [
      DOI,
      ` ${DOI} `,
      `doi:${DOI}`,
      `DOI: ${DOI}`,
      `https://doi.org/${DOI}`,
      `http://dx.doi.org/${DOI}`,
    ];
    expect(new Set(forms.map(extractDoiFromMetadataValue))).toEqual(new Set([DOI]));
  });

  it("keeps two genuinely different DOIs different", () => {
    expect(extractDoiFromMetadataValue("10.1000/a")).not.toBe(extractDoiFromMetadataValue("10.1000/b"));
    // Case is not folded, because the resolver does not fold it either.
    expect(extractDoiFromMetadataValue("10.1000/AB")).not.toBe(extractDoiFromMetadataValue("10.1000/ab"));
  });
});

describe("extractDoiFromMetadataValue — it is never wider than the accepted grammar", () => {
  it("accepts nothing the importer's own classifier would refuse", () => {
    // The claim the extension's fallback rests on: the metadata boundary is a
    // narrowing of the existing DOI rules, never an extension of them. Anything
    // this accepts must survive the round trip the `/extension-import` route
    // performs on whatever the extension hands it.
    const accepted = [
      DOI,
      `doi:${DOI}`,
      `DOI: ${DOI}`,
      `https://doi.org/${DOI}`,
      "10.1000/a#b",
      "10.1000/a/b/c",
      "10.1000/a b",
    ];

    for (const value of accepted) {
      const doi = extractDoiFromMetadataValue(value);
      expect(doi, `${value} was refused`).not.toBeNull();
      // A DOI name, by the same shape rule the resolver-URL recogniser applies.
      expect(doi).toMatch(/^10\.[^/]+\/[\s\S]+$/);
    }
  });
});
