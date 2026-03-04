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
