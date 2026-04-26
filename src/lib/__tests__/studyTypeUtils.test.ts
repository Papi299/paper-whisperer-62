import { describe, it, expect } from "vitest";
import {
  isGenericStudyType,
  resolveStudyTypeAfterAnalysis,
  buildAnalysisUpdates,
} from "../studyTypeUtils";

/**
 * Pure-function tests for the AI-analysis study-type helpers.
 *
 * These tests document `Dashboard.tsx`'s **current** behavior verbatim —
 * they are NOT a product contract for what the merge "should" do. In
 * particular, the `"Not specified"` Gemini sentinel passes through
 * unchanged because that is what `Dashboard.tsx` does today; if we ever
 * decide Dashboard should filter the sentinel (the way `EditPaperDialog`
 * already does), that becomes a separate behavior-change PR with its
 * own tests.
 *
 * Operator semantics being locked in:
 *   - `study_type` uses `??` (only fall back when AI omitted)
 *   - `tldr` / `statistical_methods` use `||` (truthy fallback, including
 *     on empty string)
 */

describe("isGenericStudyType", () => {
  it("returns true for null and undefined", () => {
    expect(isGenericStudyType(null)).toBe(true);
    expect(isGenericStudyType(undefined)).toBe(true);
  });

  it("returns true for empty and whitespace-only strings", () => {
    expect(isGenericStudyType("")).toBe(true);
    expect(isGenericStudyType("   ")).toBe(true);
    expect(isGenericStudyType("\t\n")).toBe(true);
  });

  it("returns true for the PubMed catch-all 'journal article' (case-insensitive)", () => {
    expect(isGenericStudyType("journal article")).toBe(true);
    expect(isGenericStudyType("Journal Article")).toBe(true);
    expect(isGenericStudyType("  JOURNAL ARTICLE  ")).toBe(true);
  });

  it("returns false for specific study types", () => {
    expect(isGenericStudyType("RCT")).toBe(false);
    expect(isGenericStudyType("Meta-analysis")).toBe(false);
    expect(isGenericStudyType("Cohort Study")).toBe(false);
    expect(isGenericStudyType("Randomized Controlled Trial")).toBe(false);
  });
});

describe("resolveStudyTypeAfterAnalysis", () => {
  it("keeps the existing value when it is specific", () => {
    expect(resolveStudyTypeAfterAnalysis("RCT", "Cohort Study")).toBe("RCT");
  });

  it("adopts the AI suggestion when the existing value is null", () => {
    expect(resolveStudyTypeAfterAnalysis(null, "RCT")).toBe("RCT");
  });

  it("adopts the AI suggestion when the existing value is the generic 'journal article' (case-insensitive)", () => {
    expect(resolveStudyTypeAfterAnalysis("journal article", "RCT")).toBe("RCT");
    expect(resolveStudyTypeAfterAnalysis("Journal Article", "RCT")).toBe("RCT");
  });

  it("falls back to the existing value when the AI omits a suggestion (?? semantics)", () => {
    expect(resolveStudyTypeAfterAnalysis(null, undefined)).toBe(null);
    expect(resolveStudyTypeAfterAnalysis("RCT", undefined)).toBe("RCT");
  });

  it("does NOT fall back on an empty AI string (?? does not coalesce on '')", () => {
    // Defensive: with `??`, an explicit empty string from the AI is treated
    // as a real value and overwrites the existing generic value. This
    // documents `Dashboard.tsx`'s current behavior (which uses `??`).
    expect(resolveStudyTypeAfterAnalysis(null, "")).toBe("");
    expect(resolveStudyTypeAfterAnalysis("", "")).toBe("");
  });
});

describe("buildAnalysisUpdates", () => {
  // Minimal Paper-shaped fixture for the two fields the helper actually
  // reads, plus the third field it builds.
  const paperGeneric = {
    tldr: "old tldr",
    study_type: null,
    statistical_methods: "old methods",
  };
  const paperSpecific = {
    tldr: "old tldr",
    study_type: "RCT",
    statistical_methods: "old methods",
  };

  describe("happy paths", () => {
    it("adopts all AI fields when existing study_type is generic", () => {
      const { updates, keptStudyType } = buildAnalysisUpdates(paperGeneric, {
        tldr: "new tldr",
        studyType: "Cohort Study",
        statisticalMethods: "new methods",
      });
      expect(updates).toEqual({
        tldr: "new tldr",
        study_type: "Cohort Study",
        statistical_methods: "new methods",
      });
      expect(keptStudyType).toBe(false);
    });

    it("keeps the existing study_type when it is specific, but still adopts the new tldr / statistical_methods", () => {
      const { updates, keptStudyType } = buildAnalysisUpdates(paperSpecific, {
        tldr: "new tldr",
        studyType: "Cohort Study",
        statisticalMethods: "new methods",
      });
      expect(updates).toEqual({
        tldr: "new tldr",
        study_type: "RCT",
        statistical_methods: "new methods",
      });
      expect(keptStudyType).toBe(true);
    });
  });

  describe("|| fallback semantics for tldr and statistical_methods", () => {
    it("falls back to existing tldr when AI returns empty string", () => {
      const { updates } = buildAnalysisUpdates(paperGeneric, {
        tldr: "",
        studyType: "Cohort Study",
        statisticalMethods: "new methods",
      });
      expect(updates.tldr).toBe("old tldr");
    });

    it("falls back to existing statistical_methods when AI returns empty string", () => {
      const { updates } = buildAnalysisUpdates(paperGeneric, {
        tldr: "new tldr",
        studyType: "Cohort Study",
        statisticalMethods: "",
      });
      expect(updates.statistical_methods).toBe("old methods");
    });

    it("falls back to existing tldr when AI omits tldr entirely", () => {
      const { updates } = buildAnalysisUpdates(paperGeneric, {
        studyType: "Cohort Study",
      });
      expect(updates.tldr).toBe("old tldr");
    });
  });

  describe("'Not specified' Gemini sentinel — current Dashboard behavior", () => {
    // These tests document Dashboard's CURRENT behavior — the literal
    // string "Not specified" passes through unchanged because Dashboard
    // does not filter it. EditPaperDialog DOES filter it, and the
    // asymmetry between the two surfaces is intentional.
    //
    // If we ever decide Dashboard should also filter the sentinel,
    // this is a separate behavior-change PR with its own tests.

    it("passes 'Not specified' through to study_type when existing is generic", () => {
      const { updates } = buildAnalysisUpdates(paperGeneric, {
        tldr: "new tldr",
        studyType: "Not specified",
        statisticalMethods: "new methods",
      });
      expect(updates.study_type).toBe("Not specified");
    });

    it("passes 'Not specified' through to statistical_methods when truthy", () => {
      const { updates } = buildAnalysisUpdates(paperGeneric, {
        tldr: "new tldr",
        studyType: "Cohort Study",
        statisticalMethods: "Not specified",
      });
      expect(updates.statistical_methods).toBe("Not specified");
    });
  });

  describe("keptStudyType predicate matches Dashboard.tsx:491 verbatim", () => {
    it("true when existing is specific AND AI returned a different specific value", () => {
      const { keptStudyType } = buildAnalysisUpdates(paperSpecific, {
        studyType: "Cohort Study",
      });
      expect(keptStudyType).toBe(true);
    });

    it("false when existing is specific AND AI returned the identical value (nothing was overridden)", () => {
      const { keptStudyType } = buildAnalysisUpdates(paperSpecific, {
        studyType: "RCT",
      });
      expect(keptStudyType).toBe(false);
    });

    it("false when existing is specific AND AI omitted studyType (the && short-circuits)", () => {
      const { keptStudyType } = buildAnalysisUpdates(paperSpecific, {
        tldr: "new tldr",
      });
      expect(keptStudyType).toBe(false);
    });

    it("false when existing is generic and AI returned a value (the !isGenericStudyType short-circuits)", () => {
      const { keptStudyType } = buildAnalysisUpdates(paperGeneric, {
        studyType: "RCT",
      });
      expect(keptStudyType).toBe(false);
    });

    it("false when existing is the generic 'journal article' literal (same reason)", () => {
      const { keptStudyType } = buildAnalysisUpdates(
        { tldr: "old tldr", study_type: "journal article", statistical_methods: "old methods" },
        { studyType: "RCT" },
      );
      expect(keptStudyType).toBe(false);
    });

    it("false when AI returns an empty studyType (the && short-circuits on '')", () => {
      const { keptStudyType } = buildAnalysisUpdates(paperSpecific, {
        studyType: "",
      });
      expect(keptStudyType).toBe(false);
    });
  });
});
