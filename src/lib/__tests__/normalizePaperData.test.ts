import { describe, it, expect } from "vitest";
import { normalizePaperData, NormalizationConfig, RawPaperData, computeEnrichedKeywords } from "../normalizePaperData";

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

  it("decodes HTML entities in abstract (reported bug)", () => {
    const result = normalizePaperData(
      makeRaw({ abstract: "BMI 32.3&#x2009;&#xb1;&#x2009;5.4 kg/m2" }),
      makeConfig()
    );
    expect(result.abstract).toBe("BMI 32.3\u2009±\u20095.4 kg/m2");
  });

  it("decodes HTML entities in authors", () => {
    const result = normalizePaperData(
      makeRaw({ authors: ["Smith&#x2009;J", "Doe &amp; Partners"] }),
      makeConfig()
    );
    expect(result.authors).toEqual(["Smith\u2009J", "Doe & Partners"]);
  });

  it("decodes HTML entities in journal", () => {
    const result = normalizePaperData(
      makeRaw({ journal: "Journal&#x2013;Name" }),
      makeConfig()
    );
    expect(result.journal).toBe("Journal–Name");
  });

  it("decodes HTML entities in mesh_terms", () => {
    const result = normalizePaperData(
      makeRaw({ mesh_terms: ["term&#xb1;value"] }),
      makeConfig()
    );
    expect(result.mesh_terms).toEqual(["term±value"]);
  });

  it("decodes HTML entities in substances", () => {
    const result = normalizePaperData(
      makeRaw({ substances: ["compound&#x2009;A"] }),
      makeConfig()
    );
    expect(result.substances).toEqual(["compound\u2009A"]);
  });

  it("leaves already-decoded Unicode unchanged", () => {
    const result = normalizePaperData(
      makeRaw({ abstract: "Value ± 5.4 kg/m2", authors: ["José García"] }),
      makeConfig()
    );
    expect(result.abstract).toBe("Value ± 5.4 kg/m2");
    expect(result.authors).toEqual(["José García"]);
  });

  // ── DOI normalization ──────────────────────────────────────────────────────

  it("lowercases DOI", () => {
    const result = normalizePaperData(makeRaw({ doi: "10.1234/ABC.Def" }), makeConfig());
    expect(result.doi).toBe("10.1234/abc.def");
  });

  it("strips doi: prefix and lowercases", () => {
    const result = normalizePaperData(makeRaw({ doi: "doi:10.1234/FOO" }), makeConfig());
    expect(result.doi).toBe("10.1234/foo");
  });

  it("strips DOI: prefix (case-insensitive)", () => {
    const result = normalizePaperData(makeRaw({ doi: "DOI:10.5678/Bar" }), makeConfig());
    expect(result.doi).toBe("10.5678/bar");
  });

  it("strips https://doi.org/ prefix and lowercases", () => {
    const result = normalizePaperData(makeRaw({ doi: "https://doi.org/10.1234/TEST" }), makeConfig());
    expect(result.doi).toBe("10.1234/test");
  });

  it("strips https://dx.doi.org/ prefix and lowercases", () => {
    const result = normalizePaperData(makeRaw({ doi: "https://dx.doi.org/10.9999/XYZ" }), makeConfig());
    expect(result.doi).toBe("10.9999/xyz");
  });

  it("strips http://doi.org/ prefix", () => {
    const result = normalizePaperData(makeRaw({ doi: "http://doi.org/10.1234/http-test" }), makeConfig());
    expect(result.doi).toBe("10.1234/http-test");
  });

  it("trims whitespace from DOI", () => {
    const result = normalizePaperData(makeRaw({ doi: "  10.1234/SPACED  " }), makeConfig());
    expect(result.doi).toBe("10.1234/spaced");
  });

  it("returns null for null DOI", () => {
    const result = normalizePaperData(makeRaw({ doi: null }), makeConfig());
    expect(result.doi).toBeNull();
  });

  it("preserves already-clean lowercase DOI", () => {
    const result = normalizePaperData(makeRaw({ doi: "10.1234/already-clean" }), makeConfig());
    expect(result.doi).toBe("10.1234/already-clean");
  });
});

describe("computeEnrichedKeywords", () => {
  it("returns raw keywords unchanged when config is empty", () => {
    const result = computeEnrichedKeywords(
      ["diabetes", "hypertension"],
      "Some title",
      "Some abstract",
      makeConfig(),
    );
    expect(result).toEqual(["diabetes", "hypertension"]);
  });

  it("normalizes raw keywords through synonym lookup", () => {
    const config = makeConfig({
      synonymLookup: { "bp": "Hypertension", "blood pressure": "Hypertension" },
    });
    const result = computeEnrichedKeywords(["bp", "diabetes"], "Title", null, config);
    expect(result).toContain("Hypertension");
    expect(result).toContain("diabetes");
    expect(result).not.toContain("bp");
  });

  it("deduplicates after synonym normalization", () => {
    const config = makeConfig({
      synonymLookup: { "bp": "Hypertension", "high blood pressure": "Hypertension" },
    });
    const result = computeEnrichedKeywords(["bp", "high blood pressure"], "Title", null, config);
    const count = result.filter(k => k.toLowerCase() === "hypertension").length;
    expect(count).toBe(1);
  });

  it("extracts pool keywords from title+abstract", () => {
    const config = makeConfig({ poolKeywords: ["diabetes", "obesity"] });
    const result = computeEnrichedKeywords(
      [],
      "Study on diabetes outcomes",
      "Patients with obesity were enrolled.",
      config,
    );
    expect(result).toContain("diabetes");
    expect(result).toContain("obesity");
  });

  it("does not extract negated pool keywords", () => {
    const config = makeConfig({ poolKeywords: ["diabetes"] });
    const result = computeEnrichedKeywords(
      [],
      "Study title",
      "Patients without diabetes were excluded.",
      config,
    );
    expect(result).not.toContain("diabetes");
  });

  it("extracts synonym-group canonical terms from text", () => {
    const config = makeConfig({
      synonymGroups: [
        { canonical_term: "Type 2 Diabetes", synonyms: ["T2DM", "type 2 diabetes mellitus"] },
      ],
    });
    const result = computeEnrichedKeywords([], "T2DM outcomes", null, config);
    expect(result).toContain("Type 2 Diabetes");
  });

  it("merges raw, pool, and synonym keywords without duplicates", () => {
    const config = makeConfig({
      poolKeywords: ["obesity"],
      synonymGroups: [
        { canonical_term: "Diabetes", synonyms: ["diabetes", "DM"] },
      ],
    });
    const result = computeEnrichedKeywords(
      ["obesity"],
      "Study on diabetes",
      "Patients with obesity were enrolled.",
      config,
    );
    expect(result).toContain("obesity");
    expect(result).toContain("Diabetes");
    const obesityCount = result.filter(k => k.toLowerCase() === "obesity").length;
    expect(obesityCount).toBe(1);
  });

  it("filters raw pool keywords negated in abstract", () => {
    const config = makeConfig({ poolKeywords: ["diabetes", "hypertension"] });
    const result = computeEnrichedKeywords(
      ["diabetes", "hypertension"],
      "Study title",
      "Patients without diabetes were excluded from this trial. The study focused on managing hypertension in elderly adults.",
      config,
    );
    expect(result).not.toContain("diabetes");
    expect(result).toContain("hypertension");
  });

  it("normalizes pool-extracted keywords through synonym lookup", () => {
    const config = makeConfig({
      poolKeywords: ["bp"],
      synonymLookup: { "bp": "Hypertension" },
    });
    const result = computeEnrichedKeywords(
      [],
      "Study on bp management",
      null,
      config,
    );
    expect(result).toContain("Hypertension");
  });
});
