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

import {
  doiEquivalenceKey,
  doiNamesAreEquivalent,
  extractDoiFromMetadataValue,
} from "@/lib/doiIdentifiers";

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
    // A statement about *parsing*, not about equivalence. ASCII case is
    // insensitive when two DOI names are compared (§4.3.4, and
    // `doiEquivalenceKey` below), but the Handbook scopes that rule to
    // comparison — *"It does not restrict DOI names to containing only
    // uppercase or lowercase letters"* — so what comes back here is the
    // spelling the publisher wrote, which is what gets displayed and handed on.
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
  });

  it("does not fold ASCII case when parsing — but the two are still one DOI", () => {
    // Both halves matter, and they are not in tension. Parsing preserves the
    // spelling; equivalence testing folds ASCII case. A previous revision of
    // this suite asserted only the first half and drew the wrong conclusion
    // from it — that `10.1000/AB` and `10.1000/ab` are different DOIs. They are
    // not: Handbook §4.3.4 makes them the same DOI, and Crossref documents the
    // same rule for the suffixes it issues.
    expect(extractDoiFromMetadataValue("10.1000/AB")).toBe("10.1000/AB");
    expect(extractDoiFromMetadataValue("10.1000/ab")).toBe("10.1000/ab");
    expect(doiNamesAreEquivalent("10.1000/AB", "10.1000/ab")).toBe(true);
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

describe("doiEquivalenceKey — DOI Handbook §4.3.4", () => {
  it("makes ASCII case-variant DOI names equivalent", () => {
    // *"a code point in the range U+0041..U+005A … is considered identical to
    // the corresponding code point in the range U+0061..U+007A"*.
    expect(doiEquivalenceKey("10.1000/AB")).toBe(doiEquivalenceKey("10.1000/ab"));
    expect(doiEquivalenceKey("10.1000/AbC")).toBe(doiEquivalenceKey("10.1000/aBc"));
    // The prefix folds too — the rule is about the DOI name, not about the
    // suffix alone — though a registrant code is digits and dots in practice.
    expect(doiEquivalenceKey("10.1000A/x")).toBe(doiEquivalenceKey("10.1000a/x"));
  });

  it("reproduces the Handbook's own equivalent example", () => {
    // EXAMPLE 1: equivalent, because U+0053 and U+0073 are considered identical.
    expect(
      doiNamesAreEquivalent(
        "10.5594/SMPTE.ST2067-21.2020",
        "10.5594/sMPTE.sT2067-21.2020",
      ),
    ).toBe(true);
  });

  it("reproduces the Handbook's own NON-equivalent example", () => {
    // EXAMPLE 2: not equivalent, because U+00C1 LATIN CAPITAL LETTER A WITH
    // ACUTE and U+00E1 LATIN SMALL LETTER A WITH ACUTE are not considered
    // identical. This is the case a `toLowerCase()` implementation gets wrong,
    // and it is the reason the fold is written out by code point.
    expect(
      doiNamesAreEquivalent(
        "10.26321/\u00C1.GUTI\u00C9RREZ.ZARZA.02.2018.03",
        "10.26321/\u00E1.guti\u00E9rrez.zarza.02.2018.03",
      ),
    ).toBe(false);
  });

  it("folds no code point outside U+0041..U+005A", () => {
    // Every one of these is folded by `String.prototype.toLowerCase` and must
    // NOT be folded here. If this test ever fails, the implementation has
    // reached for a general-purpose lowercasing.
    for (const [upper, lower] of [
      ["\u00C1", "\u00E1"], // Á / á — the Handbook's own counterexample
      ["\u00D6", "\u00F6"], // Ö / ö
      ["\u0130", "i"], // İ — lowercases to "i̇" (two code points) under Unicode
      ["\u03A3", "\u03C3"], // Σ / σ — Greek
      ["\u0410", "\u0430"], // А / а — Cyrillic, and visually identical to ASCII A
      ["\u00DF", "ss"], // ß — case-folds to "ss" under full Unicode folding
    ]) {
      expect(
        doiNamesAreEquivalent(`10.1000/${upper}`, `10.1000/${lower}`),
        `10.1000/${upper} was folded onto 10.1000/${lower}`,
      ).toBe(false);
    }
  });

  it("is not String.prototype.toLowerCase", () => {
    // Stated directly, because the two agree on every ASCII input and the
    // difference only shows on the inputs above.
    const withAcute = "10.26321/\u00C1.X";
    expect(doiEquivalenceKey(withAcute)).not.toBe(withAcute.toLowerCase());
    expect(doiEquivalenceKey(withAcute)).toBe("10.26321/\u00C1.x");
  });

  it("changes nothing else about the name", () => {
    // The Handbook's rule has exactly one exception in it. No trimming, no
    // percent-decoding, no whitespace collapsing, no separator handling.
    expect(doiEquivalenceKey(" 10.1000/a b ")).toBe(" 10.1000/a b ");
    expect(doiEquivalenceKey("10.1000/a%23b")).toBe("10.1000/a%23b");
    expect(doiEquivalenceKey("10.1000/a/b/c")).toBe("10.1000/a/b/c");
  });

  it("leaves surrogate pairs intact", () => {
    // Iterating by code point rather than by UTF-16 code unit. No code point the
    // rule touches is outside the BMP, so nothing here should change at all.
    const astral = "10.1000/\u{1F4C4}-A";
    expect(doiEquivalenceKey(astral)).toBe("10.1000/\u{1F4C4}-a");
    expect([...(doiEquivalenceKey(astral) as string)]).toHaveLength([...astral].length);
  });

  it("returns null for a non-string, and calls nothing equivalent to it", () => {
    expect(doiEquivalenceKey(null)).toBeNull();
    expect(doiEquivalenceKey(undefined)).toBeNull();
    expect(doiEquivalenceKey(10.1038 as unknown as string)).toBeNull();

    // Two non-DOI-names are not "the same DOI" merely by both being unusable.
    expect(doiNamesAreEquivalent(null, null)).toBe(false);
    expect(doiNamesAreEquivalent(undefined, "10.1000/a")).toBe(false);
    expect(doiNamesAreEquivalent("10.1000/a", null)).toBe(false);
  });

  it("is reflexive, symmetric and stable", () => {
    for (const name of ["10.1000/AbC", "10.1000/x", "10.26321/\u00C1.X", "10.1000/a b"]) {
      expect(doiNamesAreEquivalent(name, name)).toBe(true);
      expect(doiEquivalenceKey(name)).toBe(doiEquivalenceKey(name));
    }
    expect(doiNamesAreEquivalent("10.1000/AB", "10.1000/ab")).toBe(
      doiNamesAreEquivalent("10.1000/ab", "10.1000/AB"),
    );
  });

  it("still separates DOIs that differ by more than case", () => {
    expect(doiNamesAreEquivalent("10.1000/a", "10.1000/b")).toBe(false);
    expect(doiNamesAreEquivalent("10.1000/a", "10.1001/a")).toBe(false);
    expect(doiNamesAreEquivalent("10.1000/a", "10.1000/a ")).toBe(false);
  });
});
