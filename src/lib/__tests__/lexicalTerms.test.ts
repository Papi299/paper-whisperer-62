import { describe, it, expect } from "vitest";
import {
  normalizeLexicalTerm,
  resolveOverlappingMatches,
  scanLexicalTerms,
  type LexicalTermMatch,
} from "../lexicalTerms";
import { normalizeText } from "../textUtils";

/** Convenience: the source substrings matched for a single term. */
function matchedTexts(text: string, terms: string[]): string[] {
  return scanLexicalTerms(text, terms).matches.map(m => m.matchedText);
}

/** Convenience: does `term` occur lexically in `text` at all? */
function matches(text: string, term: string): boolean {
  return scanLexicalTerms(text, [term]).matches.length > 0;
}

/** Convenience: the non-overlapping render set, as `[start, end, text]`. */
function resolved(text: string, terms: string[]): Array<[number, number, string]> {
  return resolveOverlappingMatches(scanLexicalTerms(text, terms).matches).map(
    m => [m.start, m.end, m.matchedText] as [number, number, string],
  );
}

describe("scanLexicalTerms — reported substring false positives", () => {
  it("does not match CT inside 'effects'", () => {
    expect(matches("The effects were evaluated.", "CT")).toBe(false);
  });

  it("does not match TRE inside 'strength'", () => {
    expect(matches("Grip strength was measured.", "TRE")).toBe(false);
  });

  it("does not match EPA inside 'separate'", () => {
    expect(matches("A separate cohort was used.", "EPA")).toBe(false);
  });

  it("does not match BIA inside 'bias'", () => {
    expect(matches("Risk of bias was assessed.", "BIA")).toBe(false);
  });

  it("rejects occurrences glued to surrounding token characters", () => {
    expect(matches("preCT", "CT")).toBe(false);
    expect(matches("CTscan", "CT")).toBe(false);
    expect(matches("CT2", "CT")).toBe(false);
    expect(matches("TP53", "p53")).toBe(false);
    expect(matches("CT_value", "CT")).toBe(false);
  });
});

describe("scanLexicalTerms — standalone terms", () => {
  it("matches a standalone term", () => {
    expect(matchedTexts("CT was performed.", ["CT"])).toEqual(["CT"]);
    expect(matchedTexts("TRE was measured.", ["TRE"])).toEqual(["TRE"]);
    expect(matchedTexts("EPA supplementation", ["EPA"])).toEqual(["EPA"]);
    expect(matchedTexts("BIA assessment", ["BIA"])).toEqual(["BIA"]);
  });

  it("is case-insensitive but reports the original source casing", () => {
    expect(matchedTexts("ct was performed.", ["CT"])).toEqual(["ct"]);
    expect(matchedTexts("Ct was performed.", ["cT"])).toEqual(["Ct"]);
  });

  it("reports offsets into the original text", () => {
    const [match] = scanLexicalTerms("The effects were evaluated by CT.", ["CT"]).matches;
    expect(match.start).toBe(30);
    expect(match.end).toBe(32);
    expect(match.matchedText).toBe("CT");
    expect(match.term).toBe("CT");
    expect(match.termIndex).toBe(0);
  });

  it("finds every standalone occurrence", () => {
    expect(matchedTexts("CT first, then CT again.", ["CT"])).toEqual(["CT", "CT"]);
  });
});

describe("scanLexicalTerms — adjacent punctuation", () => {
  it("matches terms wrapped in punctuation", () => {
    expect(matchedTexts("(CT)", ["CT"])).toEqual(["CT"]);
    expect(matchedTexts("CT, MRI", ["CT"])).toEqual(["CT"]);
    expect(matchedTexts("CT.", ["CT"])).toEqual(["CT"]);
    expect(matchedTexts('"CT"', ["CT"])).toEqual(["CT"]);
  });

  it("matches through folded smart quotes", () => {
    expect(matchedTexts("“CT”", ["CT"])).toEqual(["CT"]);
  });

  it("matches both sides of a slash-separated pair", () => {
    expect(matchedTexts("CT/MRI", ["CT"])).toEqual(["CT"]);
    expect(matchedTexts("CT/MRI", ["MRI"])).toEqual(["MRI"]);
  });
});

describe("scanLexicalTerms — hyphens and dashes", () => {
  it("treats a boundary hyphen as a delimiter", () => {
    expect(matchedTexts("CT-based imaging", ["CT"])).toEqual(["CT"]);
    expect(matchedTexts("pre-CT assessment", ["CT"])).toEqual(["CT"]);
    expect(matchedTexts("non-CT finding", ["CT"])).toEqual(["CT"]);
  });

  it("matches a hyphenated term against itself", () => {
    expect(matchedTexts("IL-6 increased", ["IL-6"])).toEqual(["IL-6"]);
    expect(matchedTexts("(IL-6)", ["IL-6"])).toEqual(["IL-6"]);
  });

  it("folds en and em dashes to hyphens, preserving the source text", () => {
    expect(matchedTexts("IL–6 increased", ["IL-6"])).toEqual(["IL–6"]);
    expect(matchedTexts("IL—6 increased", ["IL-6"])).toEqual(["IL—6"]);
  });

  it("does not treat spaces and hyphens as synonyms", () => {
    expect(matches("T-cell response", "T cell")).toBe(false);
    expect(matches("T cell response", "T-cell")).toBe(false);
  });
});

describe("scanLexicalTerms — multi-word terms", () => {
  it("matches multi-word terms case-insensitively", () => {
    expect(matchedTexts("a randomized controlled trial of X", ["randomized controlled trial"]))
      .toEqual(["randomized controlled trial"]);
    expect(matchedTexts("A Randomized Controlled Trial", ["randomized controlled trial"]))
      .toEqual(["Randomized Controlled Trial"]);
  });

  it("matches across repeated and mixed whitespace, preserving the source span", () => {
    expect(matchedTexts("randomized    controlled trial", ["randomized controlled trial"]))
      .toEqual(["randomized    controlled trial"]);
    expect(matchedTexts("randomized\ncontrolled\ttrial", ["randomized controlled trial"]))
      .toEqual(["randomized\ncontrolled\ttrial"]);
  });

  it("normalizes whitespace inside the term as well", () => {
    expect(matchedTexts("a randomized controlled trial", ["  randomized   controlled trial "]))
      .toEqual(["randomized controlled trial"]);
  });

  it("still requires boundaries at the ends of a multi-word term", () => {
    expect(matches("xrandomized controlled trial", "randomized controlled trial")).toBe(false);
    expect(matches("randomized controlled trials", "randomized controlled trial")).toBe(false);
  });
});

describe("scanLexicalTerms — Unicode-aware boundaries", () => {
  it("treats Unicode letters as token characters", () => {
    expect(matches("αCTβ", "CT")).toBe(false);
    expect(matches("éCTé", "CT")).toBe(false);
    expect(matches("CTé", "CT")).toBe(false);
    expect(matches("éCT", "CT")).toBe(false);
  });

  it("matches a non-ASCII term surrounded by punctuation", () => {
    expect(matchedTexts("(β)", ["β"])).toEqual(["β"]);
  });

  it("does not match a non-ASCII term inside a longer word", () => {
    expect(matches("αβγ", "β")).toBe(false);
  });

  it("treats combining marks as token characters", () => {
    // Decomposed "e" + U+0301: the combining mark, not a letter, is what
    // continues the token, so plain "e" must not match part of it.
    expect(matches("e\u0301", "e")).toBe(false);
    expect(matches("caf\u00e9 e\u0301clair", "e")).toBe(false);
    // The mark must not block a genuinely standalone occurrence either.
    expect(matches("e\u0301 and e alone", "e")).toBe(true);
  });

  it("treats connector punctuation as a token character", () => {
    expect(matches("_CT", "CT")).toBe(false);
    expect(matches("CT_", "CT")).toBe(false);
  });

  it("treats digits as token characters on both sides", () => {
    expect(matches("2CT", "CT")).toBe(false);
    expect(matches("CT2", "CT")).toBe(false);
  });
});

describe("scanLexicalTerms — regex metacharacters are literal", () => {
  it("matches terms containing regex-significant characters", () => {
    expect(matchedTexts("written in C++ mostly", ["C++"])).toEqual(["C++"]);
    expect(matchedTexts("using C++.", ["C++"])).toEqual(["C++"]);
    expect(matchedTexts("the value A+B held", ["A+B"])).toEqual(["A+B"]);
    expect(matchedTexts("a (test) case", ["(test)"])).toEqual(["(test)"]);
    expect(matchedTexts("range [0,1] used", ["[0,1]"])).toEqual(["[0,1]"]);
  });

  it("does not let metacharacters act as patterns", () => {
    expect(matches("xyz", ".*")).toBe(false);
    expect(matches("Cxx code", "C++")).toBe(false);
    expect(matches("a test case", "(test)")).toBe(false);
  });
});

describe("resolveOverlappingMatches — deterministic overlap handling", () => {
  it("prefers the longer term at the same start and never nests", () => {
    expect(resolved("A CT scan was performed.", ["CT", "CT scan"]))
      .toEqual([[2, 9, "CT scan"]]);
  });

  it("is insensitive to pool ordering", () => {
    expect(resolved("A CT scan was performed.", ["CT scan", "CT"]))
      .toEqual([[2, 9, "CT scan"]]);
  });

  it("collapses duplicate and case-equivalent pool entries to one span", () => {
    expect(resolved("CT was performed.", ["CT", "CT", "ct"]))
      .toEqual([[0, 2, "CT"]]);
  });

  it("keeps non-overlapping matches from different terms", () => {
    expect(resolved("CT and MRI were used.", ["CT", "MRI"]))
      .toEqual([[0, 2, "CT"], [7, 10, "MRI"]]);
  });

  it("drops a later partially overlapping match", () => {
    expect(resolved("CT scan was done.", ["CT scan", "scan was"]))
      .toEqual([[0, 7, "CT scan"]]);
  });

  it("returns matches in ascending source order", () => {
    const list = resolveOverlappingMatches(
      scanLexicalTerms("MRI first, CT second, MRI third.", ["CT", "MRI"]).matches,
    );
    expect(list.map((m: LexicalTermMatch) => m.start)).toEqual([0, 11, 22]);
  });
});

describe("scanLexicalTerms — empty and pathological input", () => {
  it("returns nothing for empty text", () => {
    expect(scanLexicalTerms("", ["CT"]).matches).toEqual([]);
  });

  it("returns nothing for whitespace-only text", () => {
    expect(scanLexicalTerms("   \n\t ", ["CT"]).matches).toEqual([]);
  });

  it("returns nothing for an empty term list", () => {
    expect(scanLexicalTerms("CT was performed.", []).matches).toEqual([]);
  });

  it("skips empty and whitespace-only terms without hanging", () => {
    expect(scanLexicalTerms("CT was performed.", ["", "   ", "\n"]).matches).toEqual([]);
    expect(matchedTexts("CT was performed.", ["", "CT"])).toEqual(["CT"]);
  });

  it("tolerates nullish term values", () => {
    expect(
      scanLexicalTerms("CT was performed.", [undefined as unknown as string, "CT"]).matches,
    ).toHaveLength(1);
  });

  it("handles repeated terms without duplicating scan work incorrectly", () => {
    const { matches: found } = scanLexicalTerms("CT and CT.", ["CT", "CT"]);
    expect(found).toHaveLength(4);
    expect(found.map(m => m.start)).toEqual([0, 0, 7, 7]);
  });

  it("handles a term consisting only of punctuation", () => {
    expect(() => scanLexicalTerms("a - b", ["-"])).not.toThrow();
    expect(matchedTexts("a - b", ["-"])).toEqual(["-"]);
  });

  it("finds overlapping occurrences of a self-overlapping term", () => {
    expect(scanLexicalTerms("aaaa", ["aa"]).matches).toEqual([]);
    expect(matchedTexts("aa aa", ["aa"])).toEqual(["aa", "aa"]);
  });
});

describe("normalizeLexicalTerm", () => {
  it("applies the same folds as normalizeText", () => {
    expect(normalizeLexicalTerm("  IL–6  Levels ")).toBe("il-6 levels");
    expect(normalizeLexicalTerm("")).toBe("");
    expect(normalizeLexicalTerm("   ")).toBe("");
  });
});

describe("normalized comparison text stays aligned with normalizeText", () => {
  // The matcher folds character-by-character so it can map offsets back to the
  // source. This locks that fold against normalizeText, the fold used by the
  // synonym and study-type paths, so the two cannot drift apart.
  const samples = [
    "",
    "   ",
    "The effects were evaluated by CT.",
    "  Leading and trailing   whitespace  ",
    "IL–6 and IL—6 and IL-6",
    "it’s a “test” with ′primes′",
    "randomized\ncontrolled\ttrial",
    "αCTβ and café éclair",
    "C++ and (test) and [0,1]",
    "MIXED Case WITH  Multiple   Spaces",
  ];

  it.each(samples)("matches normalizeText for %j", sample => {
    expect(scanLexicalTerms(sample, []).normalizedText).toBe(normalizeText(sample));
  });
});
