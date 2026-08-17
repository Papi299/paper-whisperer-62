import { describe, it, expect } from "vitest";
import { escapeRegExp, normalizeText, extractContextualKeywords } from "../textUtils";

describe("escapeRegExp", () => {
  it("escapes special regex characters", () => {
    expect(escapeRegExp("hello.world")).toBe("hello\\.world");
    expect(escapeRegExp("foo (bar)")).toBe("foo \\(bar\\)");
    expect(escapeRegExp("a*b+c?")).toBe("a\\*b\\+c\\?");
    expect(escapeRegExp("[test]")).toBe("\\[test\\]");
  });

  it("leaves plain strings unchanged", () => {
    expect(escapeRegExp("diabetes")).toBe("diabetes");
    expect(escapeRegExp("heart failure")).toBe("heart failure");
  });
});

describe("normalizeText", () => {
  it("lowercases text", () => {
    expect(normalizeText("Hello WORLD")).toBe("hello world");
  });

  it("normalizes smart quotes and dashes", () => {
    expect(normalizeText("it\u2019s a \u201ctest\u201d")).toBe("it's a \"test\"");
    expect(normalizeText("long\u2014dash")).toBe("long-dash");
    expect(normalizeText("en\u2013dash")).toBe("en-dash");
  });

  it("collapses whitespace", () => {
    expect(normalizeText("  multiple   spaces  ")).toBe("multiple spaces");
    expect(normalizeText("tab\there")).toBe("tab here");
  });
});

describe("extractContextualKeywords", () => {
  it("finds keywords present in text", () => {
    const abstract = "This study examines diabetes in elderly patients with hypertension.";
    const result = extractContextualKeywords(abstract, ["diabetes", "hypertension"]);
    expect(result).toContain("diabetes");
    expect(result).toContain("hypertension");
  });

  it("does not match keywords not present in text", () => {
    const abstract = "This study examines diabetes in elderly patients.";
    const result = extractContextualKeywords(abstract, ["cancer", "asthma"]);
    expect(result).toEqual([]);
  });

  it("filters out negated keywords", () => {
    const abstract = "Patients without diabetes were enrolled in the study.";
    const result = extractContextualKeywords(abstract, ["diabetes"]);
    expect(result).toEqual([]);
  });

  it("filters 'no' negation", () => {
    const abstract = "There was no hypertension observed in the cohort.";
    const result = extractContextualKeywords(abstract, ["hypertension"]);
    expect(result).toEqual([]);
  });

  it("filters 'not' negation", () => {
    const abstract = "Patients did not have asthma at baseline.";
    const result = extractContextualKeywords(abstract, ["asthma"]);
    expect(result).toEqual([]);
  });

  it("filters 'excluded' negation", () => {
    const abstract = "Cases with excluded diabetes were removed from analysis.";
    const result = extractContextualKeywords(abstract, ["diabetes"]);
    expect(result).toEqual([]);
  });

  it("allows keyword when it appears both negated and non-negated", () => {
    const abstract = "While patients without diabetes were excluded from the analysis, a separate large cohort confirmed that diabetes was highly prevalent.";
    const result = extractContextualKeywords(abstract, ["diabetes"]);
    expect(result).toContain("diabetes");
  });

  it("respects word boundaries", () => {
    const abstract = "This study uses a hemidiabetic model.";
    const result = extractContextualKeywords(abstract, ["diabetes"]);
    expect(result).toEqual([]);
  });

  it("is case-insensitive", () => {
    const abstract = "DIABETES was the primary outcome measure.";
    const result = extractContextualKeywords(abstract, ["diabetes"]);
    expect(result).toContain("diabetes");
  });

  it("handles multi-word keywords", () => {
    const abstract = "This randomized controlled trial evaluated outcomes.";
    const result = extractContextualKeywords(abstract, ["randomized controlled trial"]);
    expect(result).toContain("randomized controlled trial");
  });

  it("returns empty array for empty text", () => {
    expect(extractContextualKeywords("", ["diabetes"])).toEqual([]);
  });

  it("returns empty array for empty keyword pool", () => {
    expect(extractContextualKeywords("Some text about diabetes.", [])).toEqual([]);
  });
});

describe("extractContextualKeywords — lexical term boundaries", () => {
  it("rejects the reported substring false positives", () => {
    expect(extractContextualKeywords("The effects were evaluated.", ["CT"])).toEqual([]);
    expect(extractContextualKeywords("Grip strength was measured.", ["TRE"])).toEqual([]);
    expect(extractContextualKeywords("A separate cohort was used.", ["EPA"])).toEqual([]);
    expect(extractContextualKeywords("Risk of bias was assessed.", ["BIA"])).toEqual([]);
  });

  it("still accepts the same terms standing alone", () => {
    expect(extractContextualKeywords("CT was performed.", ["CT"])).toEqual(["CT"]);
    expect(extractContextualKeywords("TRE was measured.", ["TRE"])).toEqual(["TRE"]);
    expect(extractContextualKeywords("EPA supplementation helped.", ["EPA"])).toEqual(["EPA"]);
    expect(extractContextualKeywords("BIA assessment was used.", ["BIA"])).toEqual(["BIA"]);
  });

  it("does not accept a term embedded in a larger token", () => {
    expect(extractContextualKeywords("A preCT CTscan CT2 reading.", ["CT"])).toEqual([]);
    expect(extractContextualKeywords("TP53 mutation status.", ["p53"])).toEqual([]);
    expect(extractContextualKeywords("The CT_value column.", ["CT"])).toEqual([]);
  });

  it("returns the term as the pool spelled it, whatever the text casing", () => {
    expect(extractContextualKeywords("ct was performed.", ["CT"])).toEqual(["CT"]);
  });

  it("accepts terms adjacent to punctuation", () => {
    expect(extractContextualKeywords("Imaging (CT) was used.", ["CT"])).toEqual(["CT"]);
    expect(extractContextualKeywords("Both CT/MRI were used.", ["CT", "MRI"])).toEqual(["CT", "MRI"]);
    expect(extractContextualKeywords("CT-based imaging.", ["CT"])).toEqual(["CT"]);
  });

  it("accepts hyphenated terms across dash variants", () => {
    expect(extractContextualKeywords("IL-6 increased.", ["IL-6"])).toEqual(["IL-6"]);
    expect(extractContextualKeywords("IL–6 increased.", ["IL-6"])).toEqual(["IL-6"]);
    expect(extractContextualKeywords("IL—6 increased.", ["IL-6"])).toEqual(["IL-6"]);
  });

  it("does not treat spaces and hyphens as synonyms", () => {
    expect(extractContextualKeywords("T-cell response measured.", ["T cell"])).toEqual([]);
    expect(extractContextualKeywords("T cell response measured.", ["T-cell"])).toEqual([]);
  });

  it("matches multi-word terms across arbitrary whitespace", () => {
    const term = "randomized controlled trial";
    expect(extractContextualKeywords("A randomized    controlled trial ran.", [term])).toEqual([term]);
    expect(extractContextualKeywords("A randomized\ncontrolled\ttrial ran.", [term])).toEqual([term]);
    expect(extractContextualKeywords("Randomized controlled trials pooled.", [term])).toEqual([]);
  });

  it("uses Unicode-aware boundaries rather than ASCII ones", () => {
    // ASCII \b sees a boundary between a Greek letter and "C", so the previous
    // implementation matched here.
    expect(extractContextualKeywords("The αCTβ subunit.", ["CT"])).toEqual([]);
    expect(extractContextualKeywords("The éCTé marker.", ["CT"])).toEqual([]);
    // ...and it saw no boundary around a bare Greek letter, so this never matched.
    expect(extractContextualKeywords("The (β) subunit was measured.", ["β"])).toEqual(["β"]);
    expect(extractContextualKeywords("The αβγ complex.", ["β"])).toEqual([]);
  });

  it("treats regex-significant characters in a term as literal text", () => {
    expect(extractContextualKeywords("Written in C++ mostly.", ["C++"])).toEqual(["C++"]);
    expect(extractContextualKeywords("Written in Cxx mostly.", ["C++"])).toEqual([]);
    expect(extractContextualKeywords("Any text at all.", [".*"])).toEqual([]);
  });

  it("preserves pool order and duplicate entries", () => {
    expect(extractContextualKeywords("CT and MRI were used.", ["MRI", "CT", "MRI"]))
      .toEqual(["MRI", "CT", "MRI"]);
  });

  it("ignores empty and whitespace-only pool entries", () => {
    expect(extractContextualKeywords("CT was performed.", ["", "   ", "CT"])).toEqual(["CT"]);
  });

  it("keeps negation separate from lexical matching", () => {
    // "non-CT" is a real lexical occurrence of CT (the highlighter shows it),
    // but "non" is a negation trigger, so extraction still rejects it.
    expect(extractContextualKeywords("A non-CT finding was noted.", ["CT"])).toEqual([]);
    // A later non-negated occurrence rescues the term, as before.
    expect(extractContextualKeywords("A non-CT finding was noted, then CT confirmed it.", ["CT"]))
      .toEqual(["CT"]);
  });
});
