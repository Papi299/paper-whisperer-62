import { describe, it, expect } from "vitest";
import { evaluateStudyType, StudyTypePoolEntry } from "../evaluateStudyType";

const pool: StudyTypePoolEntry[] = [
  { study_type: "Randomized Controlled Trial", specificity_weight: 1, hierarchy_rank: 1 },
  { study_type: "Cohort Study", specificity_weight: 1, hierarchy_rank: 2 },
  { study_type: "Case-Control Study", specificity_weight: 1, hierarchy_rank: 3 },
  { study_type: "Cross-Sectional Study", specificity_weight: 1, hierarchy_rank: 4 },
  { study_type: "Case Report", specificity_weight: 1, hierarchy_rank: 5 },
];

describe("evaluateStudyType", () => {
  it("matches study type found in title", () => {
    const result = evaluateStudyType(
      "A Randomized Controlled Trial of Drug X",
      "This trial evaluated the efficacy of Drug X.",
      null,
      pool
    );
    expect(result).toBe("Randomized Controlled Trial");
  });

  it("matches study type found in abstract", () => {
    const result = evaluateStudyType(
      "Drug X Efficacy Study",
      "This cohort study followed patients over 5 years.",
      null,
      pool
    );
    expect(result).toBe("Cohort Study");
  });

  it("matches study type from raw publication type", () => {
    const result = evaluateStudyType(
      "Drug X Efficacy",
      "Methods: We evaluated outcomes in patients.",
      "Case Report",
      pool
    );
    expect(result).toBe("Case Report");
  });

  it("picks highest-ranked match when multiple types found", () => {
    const result = evaluateStudyType(
      "A Randomized Controlled Trial",
      "This cohort study was also a randomized controlled trial.",
      null,
      pool
    );
    expect(result).toBe("Randomized Controlled Trial");
  });

  it("breaks ties by string length (longer = more specific)", () => {
    const tiedPool: StudyTypePoolEntry[] = [
      { study_type: "Trial", specificity_weight: 1, hierarchy_rank: 1 },
      { study_type: "Controlled Trial", specificity_weight: 1, hierarchy_rank: 1 },
    ];
    const result = evaluateStudyType(
      "A Controlled Trial of interventions",
      null,
      null,
      tiedPool
    );
    expect(result).toBe("Controlled Trial");
  });

  it("strips generic 'Journal Article' when no pool match", () => {
    const result = evaluateStudyType(
      "Some paper title",
      "Some abstract text.",
      "Journal Article, Review",
      pool
    );
    expect(result).toBe("Review");
  });

  it("returns empty string when no match and no raw type", () => {
    const result = evaluateStudyType(
      "Some paper title",
      "Some abstract text.",
      null,
      pool
    );
    expect(result).toBe("");
  });

  it("returns empty string for empty pool and empty raw type", () => {
    const result = evaluateStudyType("Title", "Abstract", null, []);
    expect(result).toBe("");
  });

  it("returns raw type stripped of generic when no pool match", () => {
    const result = evaluateStudyType(
      "Title",
      "Abstract",
      "Journal Article",
      pool
    );
    expect(result).toBe("");
  });

  it("handles comma-separated raw publication types", () => {
    const result = evaluateStudyType(
      "Some paper",
      null,
      "Randomized Controlled Trial, Multicenter Study",
      pool
    );
    expect(result).toBe("Randomized Controlled Trial");
  });

  it("is case-insensitive for text matching", () => {
    const result = evaluateStudyType(
      "a randomized controlled trial of treatment",
      null,
      null,
      pool
    );
    expect(result).toBe("Randomized Controlled Trial");
  });

  it("handles null abstract gracefully", () => {
    const result = evaluateStudyType(
      "A Case Report of rare disease",
      null,
      null,
      pool
    );
    expect(result).toBe("Case Report");
  });
});
