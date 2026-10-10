import { describe, expect, it } from "vitest";
import {
  doiUrlFor,
  pubmedUrlFor,
  readPlaceholderText,
  readPublicationTypes,
  readStatisticalMethods,
  readStoredText,
  readStringList,
  readYear,
  summarizeAttachmentTypes,
} from "../fields";

const NOT_RECORDED = { kind: "not_recorded" };
const UNREADABLE = { kind: "unreadable" };
const present = (value: unknown) => ({ kind: "present", value });
const placeholder = (value: string) => ({ kind: "stored_placeholder", value });

describe("readStoredText", () => {
  it.each([null, undefined, "", "   ", "\n\t "])("treats %j as not recorded", (value) => {
    expect(readStoredText(value)).toEqual(NOT_RECORDED);
  });

  it("returns text exactly as stored — no trimming, decoding or reformatting", () => {
    const abstract = "  Results: 10<sup>-4</sup> &#xd7; 2.5 ± 0.3.\n\nConclusion: synthetic.  ";
    expect(readStoredText(abstract)).toEqual(present(abstract));
    expect(readStoredText("10-4")).toEqual(present("10-4"));
  });

  it.each([[42], [true], [{}], [["text"]]])("treats non-text %j as unreadable", (value) => {
    expect(readStoredText(value)).toEqual(UNREADABLE);
  });

  it("keeps imported type text whole: raw_study_type is never split at commas", () => {
    const joined = "Randomized Controlled Trial, Clinical Trial, Phase II, Journal Article";
    expect(readStoredText(joined)).toEqual(present(joined));
  });
});

describe("readPlaceholderText", () => {
  it("marks the exact 'Not specified' literal as a stored placeholder, verbatim", () => {
    expect(readPlaceholderText("Not specified")).toEqual(placeholder("Not specified"));
    expect(readPlaceholderText(" Not specified ")).toEqual(placeholder(" Not specified "));
  });

  it("leaves other spellings and longer text as present values", () => {
    expect(readPlaceholderText("not specified")).toEqual(present("not specified"));
    expect(readPlaceholderText("Not specified in the abstract")).toEqual(present("Not specified in the abstract"));
  });

  it("still reports absence and bad shapes", () => {
    expect(readPlaceholderText(null)).toEqual(NOT_RECORDED);
    expect(readPlaceholderText("  ")).toEqual(NOT_RECORDED);
    expect(readPlaceholderText(7)).toEqual(UNREADABLE);
  });
});

describe("readStatisticalMethods", () => {
  it("reads the canonical JSON string", () => {
    expect(readStatisticalMethods("t-test, ANOVA")).toEqual(present("t-test, ANOVA"));
  });

  it("keeps 'Not specified' as a placeholder, never as 'no methods reported'", () => {
    expect(readStatisticalMethods("Not specified")).toEqual(placeholder("Not specified"));
    expect(readStatisticalMethods(["Not specified"])).toEqual(placeholder("Not specified"));
  });

  it("joins a legacy array of strings with the domain mapper's semantics", () => {
    expect(readStatisticalMethods(["t-test", "ANOVA"])).toEqual(present("t-test, ANOVA"));
    expect(readStatisticalMethods([null, "Cox regression"])).toEqual(present("Cox regression"));
    expect(readStatisticalMethods([])).toEqual(NOT_RECORDED);
  });

  it("treats NULL as not recorded", () => {
    expect(readStatisticalMethods(null)).toEqual(NOT_RECORDED);
  });

  it.each([[{ test: "t" }], [5], [true], [[{ test: "t" }]], [["t-test", 3]]])(
    "treats %j as unreadable without throwing",
    (value) => {
      expect(() => readStatisticalMethods(value)).not.toThrow();
      expect(readStatisticalMethods(value)).toEqual(UNREADABLE);
    },
  );
});

describe("readPublicationTypes", () => {
  it("keeps every structured element whole, including types that contain commas", () => {
    const stored = ["Randomized Controlled Trial", "Clinical Trial, Phase II", "Journal Article"];
    const result = readPublicationTypes(stored);
    expect(result).toEqual(present(stored));
    if (result.kind !== "present") throw new Error("expected present");
    expect(result.value).toHaveLength(3);
    expect(result.value[1]).toBe("Clinical Trial, Phase II");
  });

  it("treats NULL as nothing recorded at import", () => {
    expect(readPublicationTypes(null)).toEqual(NOT_RECORDED);
    expect(readPublicationTypes(undefined)).toEqual(NOT_RECORDED);
  });

  it.each([
    ["an empty array (forbidden by the column CHECK)", []],
    ["a blank element", ["Journal Article", " "]],
    ["a non-string element", ["Journal Article", 1]],
    ["a nested array", [["Journal Article"]]],
    ["an object", { type: "Journal Article" }],
    ["a joined string — never split", "Randomized Controlled Trial, Journal Article"],
  ])("treats %s as unreadable", (_label, value) => {
    expect(readPublicationTypes(value)).toEqual(UNREADABLE);
  });

  it("returns a frozen copy", () => {
    const stored = ["Review"];
    const result = readPublicationTypes(stored);
    if (result.kind !== "present") throw new Error("expected present");
    expect(result.value).not.toBe(stored);
    expect(Object.isFrozen(result.value)).toBe(true);
  });
});

describe("readStringList (authors, keywords, MeSH, substances)", () => {
  it("returns well-formed lists exactly as stored, without entity decoding", () => {
    expect(readStringList(["Ünal A", "O'Brien &amp; Co"])).toEqual(present(["Ünal A", "O'Brien &amp; Co"]));
  });

  it.each([[null], [undefined], [[]]])("treats %j as not recorded", (value) => {
    expect(readStringList(value)).toEqual(NOT_RECORDED);
  });

  it.each([
    ["mixed element types", ["Doe J", 7]],
    ["an object element", [{ name: "Doe J" }]],
    ["a blank element", ["Doe J", ""]],
    ["a null element", ["Doe J", null]],
    ["a joined string", "Doe J, Roe R"],
    ["an object", { 0: "Doe J" }],
  ])("treats %s as unreadable rather than a shortened list", (_label, value) => {
    expect(readStringList(value)).toEqual(UNREADABLE);
  });
});

describe("readYear", () => {
  it("reads an integer year", () => {
    expect(readYear(2021)).toEqual(present(2021));
  });

  it("treats NULL as not recorded", () => {
    expect(readYear(null)).toEqual(NOT_RECORDED);
  });

  it.each(["2021", 2021.5, Number.NaN, Number.POSITIVE_INFINITY, {}])("treats %j as unreadable", (value) => {
    expect(readYear(value)).toEqual(UNREADABLE);
  });
});

describe("links from identifiers", () => {
  it("builds the canonical PubMed URL only from a valid PMID", () => {
    expect(pubmedUrlFor("12345678")).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
    expect(pubmedUrlFor(" 12345678 ")).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
  });

  it.each(["PMC1234567", "L629384756", "WOS:000123456700001", "javascript:alert(1)", "", null, 12345678])(
    "builds no PubMed link from %j",
    (pmid) => {
      expect(pubmedUrlFor(pmid)).toBeNull();
    },
  );

  it("builds the canonical doi.org URL only from a usable DOI name", () => {
    expect(doiUrlFor("10.5555/synthetic.0001")).toBe("https://doi.org/10.5555/synthetic.0001");
  });

  it.each(["https://doi.org/10.5555/x", "javascript:alert(1)//10.1/x", "not a doi", "", null, 10.5555])(
    "builds no DOI link from %j",
    (doi) => {
      expect(doiUrlFor(doi)).toBeNull();
    },
  );
});

describe("summarizeAttachmentTypes", () => {
  it("counts PDFs and images by recorded MIME type and everything else as other", () => {
    expect(
      summarizeAttachmentTypes(["application/pdf", "APPLICATION/PDF", "image/png", "image/jpeg", "text/plain", null, 3]),
    ).toEqual({ total: 7, pdf: 2, image: 2, other: 3 });
  });

  it("reports zero attachments", () => {
    expect(summarizeAttachmentTypes([])).toEqual({ total: 0, pdf: 0, image: 0, other: 0 });
  });
});
