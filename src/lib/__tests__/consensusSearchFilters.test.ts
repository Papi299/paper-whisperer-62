import { describe, it, expect } from "vitest";
import {
  CONSENSUS_FILTER_RANGE_MESSAGE,
  CONSENSUS_STUDY_TYPE_OPTIONS,
  CONSENSUS_STUDY_TYPES,
  EMPTY_CONSENSUS_FILTER_DRAFT,
  canonicalStudyTypes,
  consensusFilterMaxYear,
  consensusFilterYearMessage,
  countDraftFilters,
  describeAppliedFilters,
  isConsensusStudyType,
  sameAppliedFilters,
  validateConsensusFilterDraft,
  type ConsensusFilterDraft,
} from "../consensusSearchFilters";

/**
 * CONSENSUS-ADVANCED-FILTERS-001A — the browser side of the owner's Consensus
 * filters: the vocabulary, the draft validation the panel and hook rely on,
 * search identity, and the summary that labels a search's results.
 */

/** The year ceiling in 2026 — passed explicitly so nothing here reads the clock. */
const MAX_YEAR = 2027;

const draft = (overrides: Partial<ConsensusFilterDraft> = {}): ConsensusFilterDraft => ({
  ...EMPTY_CONSENSUS_FILTER_DRAFT,
  ...overrides,
});

describe("the study-design vocabulary", () => {
  it("offers exactly the allowlist, in order, each readable label mapped to its exact provider value", () => {
    expect(CONSENSUS_STUDY_TYPES).toEqual(["rct", "meta-analysis", "systematic review", "cohort study"]);
    expect(CONSENSUS_STUDY_TYPE_OPTIONS.map((option) => [option.value, option.label, option.shortLabel])).toEqual([
      ["rct", "Randomized controlled trial (RCT)", "RCT"],
      ["meta-analysis", "Meta-analysis", "Meta-analysis"],
      ["systematic review", "Systematic review", "Systematic review"],
      ["cohort study", "Cohort study", "Cohort study"],
    ]);
  });

  it("is frozen, options included", () => {
    expect(Object.isFrozen(CONSENSUS_STUDY_TYPES)).toBe(true);
    expect(Object.isFrozen(CONSENSUS_STUDY_TYPE_OPTIONS)).toBe(true);
    for (const option of CONSENSUS_STUDY_TYPE_OPTIONS) expect(Object.isFrozen(option)).toBe(true);
  });

  it("recognizes only exact provider values", () => {
    expect(isConsensusStudyType("rct")).toBe(true);
    for (const value of ["RCT", " rct", "Randomized controlled trial (RCT)", "case report", "", null, 1]) {
      expect(isConsensusStudyType(value)).toBe(false);
    }
  });

  it("canonicalStudyTypes keeps allowlisted values once each, in allowlist order, and drops the rest", () => {
    expect(canonicalStudyTypes(["cohort study", "RCT", "rct", "rct", "case report", 7, null])).toEqual(["rct", "cohort study"]);
    expect(canonicalStudyTypes([])).toEqual([]);
  });
});

describe("EMPTY_CONSENSUS_FILTER_DRAFT — the default for every session", () => {
  it("sets nothing: no year, no design, and neither human-only nor no-preprints", () => {
    expect(EMPTY_CONSENSUS_FILTER_DRAFT).toEqual({
      yearMin: "",
      yearMax: "",
      studyTypes: [],
      human: false,
      excludePreprints: false,
    });
    expect(Object.isFrozen(EMPTY_CONSENSUS_FILTER_DRAFT)).toBe(true);
    expect(countDraftFilters(EMPTY_CONSENSUS_FILTER_DRAFT)).toBe(0);
  });

  it("applies no restriction at all", () => {
    expect(validateConsensusFilterDraft(EMPTY_CONSENSUS_FILTER_DRAFT, MAX_YEAR)).toEqual({ ok: true, filters: {} });
  });
});

describe("validateConsensusFilterDraft", () => {
  it("turns a full draft into the frozen filters a Search applies", () => {
    const checked = validateConsensusFilterDraft(
      draft({
        yearMin: "2020",
        yearMax: "2026",
        studyTypes: ["meta-analysis", "rct"],
        human: true,
        excludePreprints: true,
      }),
      MAX_YEAR,
    );
    expect(checked).toEqual({
      ok: true,
      filters: {
        yearMin: 2020,
        yearMax: 2026,
        studyTypes: ["rct", "meta-analysis"],
        human: true,
        excludePreprints: true,
      },
    });
    if (!checked.ok) return;
    expect(Object.isFrozen(checked.filters)).toBe(true);
    expect(Object.isFrozen(checked.filters.studyTypes)).toBe(true);
  });

  it.each([
    ["a start year alone", { yearMin: "2015" }, { yearMin: 2015 }],
    ["an end year alone", { yearMax: "2010" }, { yearMax: 2010 }],
    ["a single-year range", { yearMin: "2020", yearMax: "2020" }, { yearMin: 2020, yearMax: 2020 }],
    ["the floor", { yearMin: "1900" }, { yearMin: 1900 }],
    ["the ceiling", { yearMax: "2027" }, { yearMax: 2027 }],
    ["a typed year with surrounding spaces", { yearMin: " 2020 " }, { yearMin: 2020 }],
    ["whitespace alone, which is unset", { yearMin: "   " }, {}],
  ])("accepts %s", (_label, years, expected) => {
    expect(validateConsensusFilterDraft(draft(years), MAX_YEAR)).toEqual({ ok: true, filters: expected });
  });

  it.each([
    ["too few digits", "202"],
    ["too many digits", "20201"],
    ["a fraction", "2020.5"],
    ["exponent notation", "2e3"],
    ["a sign", "-2020"],
    ["letters", "abcd"],
    ["below the floor", "1899"],
    ["past the ceiling", "2028"],
    ["full-width digits", "２０２０"],
    ["Arabic-Indic digits", "٢٠٢٠"],
    ["digits around a space", "20 20"],
  ])("refuses %s, with the field's own message", (_label, year) => {
    expect(validateConsensusFilterDraft(draft({ yearMin: year }), MAX_YEAR)).toEqual({
      ok: false,
      errors: { yearMin: "Enter a four-digit year from 1900 to 2027." },
    });
    expect(validateConsensusFilterDraft(draft({ yearMax: year }), MAX_YEAR)).toEqual({
      ok: false,
      errors: { yearMax: "Enter a four-digit year from 1900 to 2027." },
    });
  });

  it("reports a reversed range as a range problem", () => {
    expect(validateConsensusFilterDraft(draft({ yearMin: "2024", yearMax: "2020" }), MAX_YEAR)).toEqual({
      ok: false,
      errors: { range: CONSENSUS_FILTER_RANGE_MESSAGE },
    });
  });

  it("reports each invalid year, and no range problem until both are valid", () => {
    expect(validateConsensusFilterDraft(draft({ yearMin: "abcd", yearMax: "1" }), MAX_YEAR)).toEqual({
      ok: false,
      errors: { yearMin: consensusFilterYearMessage(MAX_YEAR), yearMax: consensusFilterYearMessage(MAX_YEAR) },
    });
  });

  it("leaves out every restriction that is not set", () => {
    expect(validateConsensusFilterDraft(draft({ human: true }), MAX_YEAR)).toEqual({ ok: true, filters: { human: true } });
    expect(validateConsensusFilterDraft(draft({ studyTypes: [] }), MAX_YEAR)).toEqual({ ok: true, filters: {} });
  });

  it("reads the ceiling from the UTC calendar when none is passed", () => {
    expect(consensusFilterMaxYear(new Date("2026-12-31T23:59:59Z"))).toBe(2027);
    expect(consensusFilterMaxYear(new Date("2027-01-01T00:00:00Z"))).toBe(2028);
    const ceiling = consensusFilterMaxYear();
    expect(validateConsensusFilterDraft(draft({ yearMax: String(ceiling) })).ok).toBe(true);
    expect(validateConsensusFilterDraft(draft({ yearMax: String(ceiling + 1) })).ok).toBe(false);
  });
});

describe("sameAppliedFilters — part of a search's identity", () => {
  it("treats identical restrictions as the same search", () => {
    expect(sameAppliedFilters({}, {})).toBe(true);
    expect(
      sameAppliedFilters(
        { yearMin: 2020, studyTypes: ["rct", "meta-analysis"], human: true },
        { yearMin: 2020, studyTypes: ["rct", "meta-analysis"], human: true },
      ),
    ).toBe(true);
  });

  it.each([
    ["a changed year", { yearMin: 2020 }, { yearMin: 2021 }],
    ["an added year", {}, { yearMax: 2020 }],
    ["an added design", { studyTypes: ["rct"] as const }, { studyTypes: ["rct", "meta-analysis"] as const }],
    ["a removed design", { studyTypes: ["rct"] as const }, {}],
    ["human-only toggled", {}, { human: true as const }],
    ["preprint exclusion toggled", { excludePreprints: true as const }, {}],
  ])("treats %s as a different search", (_label, a, b) => {
    expect(sameAppliedFilters(a, b)).toBe(false);
    expect(sameAppliedFilters(b, a)).toBe(false);
  });

  it("never treats a first search as a re-run", () => {
    expect(sameAppliedFilters({}, null)).toBe(false);
    expect(sameAppliedFilters(null, null)).toBe(true);
  });
});

describe("describeAppliedFilters — what the results were searched with", () => {
  it("summarizes the full set compactly, in text", () => {
    expect(
      describeAppliedFilters({
        yearMin: 2020,
        yearMax: 2026,
        studyTypes: ["rct", "meta-analysis"],
        human: true,
        excludePreprints: true,
      }),
    ).toBe("2020–2026 · RCT + Meta-analysis · Human only · No preprints");
  });

  it.each([
    [{ yearMin: 2015 }, "From 2015"],
    [{ yearMax: 2010 }, "Up to 2010"],
    [{ yearMin: 2020, yearMax: 2020 }, "2020 only"],
    [{ studyTypes: ["systematic review", "cohort study"] as const }, "Systematic review + Cohort study"],
    [{ excludePreprints: true as const }, "No preprints"],
  ])("describes %j as %j", (filters, expected) => {
    expect(describeAppliedFilters(filters)).toBe(expected);
  });

  it("says nothing for an unfiltered search, so it is never labelled as filtered", () => {
    expect(describeAppliedFilters({})).toBeNull();
    expect(describeAppliedFilters(null)).toBeNull();
  });
});

describe("countDraftFilters — what a collapsed section reports", () => {
  it("counts filter categories, not values", () => {
    expect(countDraftFilters(draft({ yearMin: "2020", yearMax: "2026" }))).toBe(1);
    expect(countDraftFilters(draft({ studyTypes: ["rct", "meta-analysis"] }))).toBe(1);
    expect(
      countDraftFilters(draft({ yearMax: "2026", studyTypes: ["rct"], human: true, excludePreprints: true })),
    ).toBe(4);
  });

  it("counts a half-typed year: it is not unset", () => {
    expect(countDraftFilters(draft({ yearMin: "20" }))).toBe(1);
  });
});
