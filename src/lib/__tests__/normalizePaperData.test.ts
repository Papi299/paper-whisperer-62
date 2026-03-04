import { describe, it, expect } from "vitest";
import { normalizePaperData, NormalizationConfig, RawPaperData } from "../normalizePaperData";

function makeRaw(overrides: Partial<RawPaperData> = {}): RawPaperData {
  return {
    title: "Test Paper Title.",
    authors: ["John Doe"],
    year: 2024,
    journal: "Test Journal",
    pmid: "12345",
    doi: "10.1234/test",
    abstract: "This study examines diabetes in patients with hypertension.",
    keywords: ["diabetes", "blood pressure"],
    mesh_terms: [],
    substances: [],
    study_type: null,
    pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/12345/",
    journal_url: "https://doi.org/10.1234/test",
    drive_url: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<NormalizationConfig> = {}): NormalizationConfig {
  return {
    synonymLookup: {},
    poolStudyTypes: [],
    poolKeywords: [],
    synonymGroups: [],
    ...overrides,
  };
}

describe("normalizePaperData", () => {
  it("strips trailing period from title", () => {
    const result = normalizePaperData(makeRaw({ title: "My Paper Title." }), makeConfig());
    expect(result.title).toBe("My Paper Title");
  });

  it("preserves title without trailing period", () => {
    const result = normalizePaperData(makeRaw({ title: "My Paper Title" }), makeConfig());
    expect(result.title).toBe("My Paper Title");
  });

  it("normalizes keywords through synonym lookup", () => {
    const config = makeConfig({
      synonymLookup: { "blood pressure": "Hypertension", "bp": "Hypertension" },
    });
    const result = normalizePaperData(
      makeRaw({ keywords: ["blood pressure", "diabetes"] }),
      config
    );
    expect(result.keywords).toContain("Hypertension");
    expect(result.keywords).toContain("diabetes");
    expect(result.keywords).not.toContain("blood pressure");
  });

  it("deduplicates keywords after synonym normalization", () => {
    const config = makeConfig({
      synonymLookup: { "bp": "Hypertension", "high blood pressure": "Hypertension" },
    });
    const result = normalizePaperData(
      makeRaw({ keywords: ["bp", "high blood pressure"] }),
      config
    );
    const hypertensionCount = result.keywords.filter(k => k.toLowerCase() === "hypertension").length;
    expect(hypertensionCount).toBe(1);
  });

  it("filters negated keywords from abstract context", () => {
    const config = makeConfig({
      poolKeywords: ["diabetes", "hypertension"],
    });
    const result = normalizePaperData(
      makeRaw({
        abstract: "Patients without diabetes were excluded from this trial. The study focused on managing hypertension in elderly adults.",
        keywords: ["diabetes", "hypertension"],
      }),
      config
    );
    expect(result.keywords).not.toContain("diabetes");
    expect(result.keywords).toContain("hypertension");
  });

  it("extracts canonical terms from synonym groups found in text", () => {
    const config = makeConfig({
      synonymGroups: [
        { canonical_term: "Type 2 Diabetes", synonyms: ["T2DM", "type 2 diabetes mellitus"] },
      ],
    });
    const result = normalizePaperData(
      makeRaw({
        title: "T2DM treatment outcomes",
        abstract: "We studied T2DM patients.",
        keywords: [],
      }),
      config
    );
    expect(result.keywords).toContain("Type 2 Diabetes");
  });

  it("does not extract synonym group when text only contains negated mention", () => {
    const config = makeConfig({
      synonymGroups: [
        { canonical_term: "Diabetes", synonyms: ["diabetes", "DM"] },
      ],
    });
    const result = normalizePaperData(
      makeRaw({
        title: "Study of patients",
        abstract: "Patients without diabetes were enrolled.",
        keywords: [],
      }),
      config
    );
    expect(result.keywords).not.toContain("Diabetes");
  });

  it("evaluates study type using pool", () => {
    const config = makeConfig({
      poolStudyTypes: [
        { study_type: "Cohort Study", specificity_weight: 1, hierarchy_rank: 1 },
      ],
    });
    const result = normalizePaperData(
      makeRaw({
        abstract: "This prospective cohort study followed patients for 10 years.",
      }),
      config
    );
    expect(result.study_type).toBe("Cohort Study");
  });

  it("passes through fields unchanged", () => {
    const result = normalizePaperData(makeRaw(), makeConfig());
    expect(result.authors).toEqual(["John Doe"]);
    expect(result.year).toBe(2024);
    expect(result.journal).toBe("Test Journal");
    expect(result.pmid).toBe("12345");
    expect(result.doi).toBe("10.1234/test");
    expect(result.pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/12345/");
    expect(result.journal_url).toBe("https://doi.org/10.1234/test");
  });

  it("defaults mesh_terms and substances to empty arrays", () => {
    const result = normalizePaperData(
      makeRaw({ mesh_terms: undefined, substances: undefined }),
      makeConfig()
    );
    expect(result.mesh_terms).toEqual([]);
    expect(result.substances).toEqual([]);
  });

  it("decodes HTML entities in title", () => {
    const result = normalizePaperData(
      makeRaw({ title: "Effect of &amp; Treatment." }),
      makeConfig()
    );
    expect(result.title).toBe("Effect of & Treatment");
  });
});
