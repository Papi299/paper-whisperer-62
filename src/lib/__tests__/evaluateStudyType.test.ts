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

describe("evaluateStudyType — structured publication types", () => {
  // Official PubMed publication types. "Clinical Trial" is present so that a
  // value split on its own comma visibly wins the wrong, less specific entry.
  const commaPool: StudyTypePoolEntry[] = [
    { study_type: "Clinical Trial, Phase II", specificity_weight: 1, hierarchy_rank: 1 },
    { study_type: "Multicenter Study", specificity_weight: 1, hierarchy_rank: 2 },
    { study_type: "Clinical Trial", specificity_weight: 1, hierarchy_rank: 3 },
  ];

  it("matches a comma-bearing publication type as a single value", () => {
    const result = evaluateStudyType(
      "Fixture",
      null,
      "Clinical Trial, Phase II",
      commaPool,
      ["Clinical Trial, Phase II"]
    );
    expect(result).toBe("Clinical Trial, Phase II");
  });

  it("uses the supplied values in preference to the joined string", () => {
    const joined = "Journal Article, Clinical Trial, Phase II, Multicenter Study";
    // Legacy callers can only split, which loses the Phase II value entirely.
    expect(evaluateStudyType("Fixture", null, joined, commaPool)).toBe("Multicenter Study");
    // The same citation, with the boundaries its source actually stated.
    expect(
      evaluateStudyType("Fixture", null, joined, commaPool, [
        "Journal Article",
        "Clinical Trial, Phase II",
        "Multicenter Study",
      ])
    ).toBe("Clinical Trial, Phase II");
  });

  it("strips generic types from the supplied values without splitting them", () => {
    const result = evaluateStudyType(
      "Fixture",
      null,
      "Journal Article, Clinical Trial, Phase II",
      [],
      ["Journal Article", "Clinical Trial, Phase II"]
    );
    expect(result).toBe("Clinical Trial, Phase II");
  });

  it("joins several surviving types in the existing display convention", () => {
    const result = evaluateStudyType(
      "Fixture",
      null,
      null,
      [],
      ["Research Support, N.I.H., Extramural", "Multicenter Study"]
    );
    expect(result).toBe("Research Support, N.I.H., Extramural, Multicenter Study");
  });

  it("keeps legacy raw-string callers behaving exactly as before", () => {
    const raw = "Randomized Controlled Trial, Multicenter Study";
    expect(evaluateStudyType("Some paper", null, raw, pool)).toBe("Randomized Controlled Trial");
    expect(evaluateStudyType("Some paper", null, raw, pool, undefined)).toBe(
      "Randomized Controlled Trial"
    );
  });

  it("falls back to the raw string when the supplied list is empty", () => {
    expect(
      evaluateStudyType("Some paper", null, "Journal Article, Case Report", pool, [])
    ).toBe("Case Report");
  });

  it("ignores blank entries in the supplied list", () => {
    expect(
      evaluateStudyType("Fixture", null, null, commaPool, ["  ", "Clinical Trial, Phase II"])
    ).toBe("Clinical Trial, Phase II");
  });

  it("wins a multi-comma official type whole against a shorter pool prefix", () => {
    // "Research Support, N.I.H., Extramural" holds two internal commas. Split,
    // it would offer the pool "Research Support", "N.I.H." and "Extramural" —
    // and the first of those is a real pool entry, so the wrong value would win
    // silently rather than fail visibly.
    const supportPool: StudyTypePoolEntry[] = [
      { study_type: "Research Support, N.I.H., Extramural", specificity_weight: 1, hierarchy_rank: 1 },
      { study_type: "Research Support", specificity_weight: 1, hierarchy_rank: 2 },
    ];
    const joined = "Research Support, N.I.H., Extramural, Journal Article";

    expect(
      evaluateStudyType("Fixture", null, joined, supportPool, [
        "Research Support, N.I.H., Extramural",
        "Journal Article",
      ])
    ).toBe("Research Support, N.I.H., Extramural");

    // The legacy string-only caller demonstrably lands on the shorter entry.
    expect(evaluateStudyType("Fixture", null, joined, supportPool)).toBe("Research Support");
  });
});
