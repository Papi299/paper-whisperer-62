import { describe, it, expect } from "vitest";
import {
  extractPublicationTypes,
  joinPublicationTypes,
  pubmedStudyTypeOverride,
} from "../publicationTypes";

/**
 * The Edge function's publication-type provenance. These are pure helpers with
 * no Deno APIs and no remote imports, so the Edge response contract is provable
 * here without adding a Deno runtime to CI — the same arrangement
 * `identifierDetection.ts` uses.
 */

/** A PubMed EFetch fragment carrying the given publication types. */
function pubmedXml(types: string[]): string {
  return (
    "<PubmedArticle><MedlineCitation><Article>" +
    "<ArticleTitle>Fixture</ArticleTitle>" +
    "<PublicationTypeList>" +
    types
      .map((t) => `<PublicationType UI="D000000">${t}</PublicationType>`)
      .join("") +
    "</PublicationTypeList>" +
    "</Article></MedlineCitation></PubmedArticle>"
  );
}

describe("extractPublicationTypes", () => {
  it("keeps a comma-bearing official type as one value", () => {
    // The defect this whole field exists for: joined and re-split, this becomes
    // the two false values "Clinical Trial" and "Phase II".
    expect(extractPublicationTypes(pubmedXml(["Clinical Trial, Phase II"]))).toEqual([
      "Clinical Trial, Phase II",
    ]);
  });

  it("keeps a multi-comma official type whole", () => {
    expect(
      extractPublicationTypes(pubmedXml(["Research Support, N.I.H., Extramural"])),
    ).toEqual(["Research Support, N.I.H., Extramural"]);
  });

  it("preserves every value and its document order", () => {
    const types = ["Randomized Controlled Trial", "Multicenter Study", "Journal Article"];
    expect(extractPublicationTypes(pubmedXml(types))).toEqual(types);
  });

  it("separates adjacent types even when both contain commas", () => {
    const types = ["Clinical Trial, Phase II", "Research Support, N.I.H., Extramural"];
    expect(extractPublicationTypes(pubmedXml(types))).toEqual(types);
    // Two source values, not the five a comma split would produce.
    expect(extractPublicationTypes(pubmedXml(types))).toHaveLength(2);
  });

  it("returns an empty list for a record with no publication types", () => {
    expect(extractPublicationTypes("<Article><ArticleTitle>X</ArticleTitle></Article>")).toEqual(
      [],
    );
  });
});

describe("joinPublicationTypes", () => {
  it("reproduces the legacy joined representation", () => {
    expect(joinPublicationTypes(["Clinical Trial, Phase II", "Multicenter Study"])).toBe(
      "Clinical Trial, Phase II, Multicenter Study",
    );
  });

  it("maps no publication types to null, as the response contract already did", () => {
    expect(joinPublicationTypes([])).toBeNull();
  });
});

describe("pubmedStudyTypeOverride", () => {
  it("carries the boundaries along with an adopted PubMed study type", () => {
    const override = pubmedStudyTypeOverride({
      study_type: "Clinical Trial, Phase II, Multicenter Study",
      publication_types: ["Clinical Trial, Phase II", "Multicenter Study"],
    });

    expect(override).toEqual({
      study_type: "Clinical Trial, Phase II, Multicenter Study",
      publication_types: ["Clinical Trial, Phase II", "Multicenter Study"],
    });
  });

  it("declines when PubMed supplied no study type, so the record keeps its own", () => {
    // Reproduces the existing `pubmedData.study_type || crossrefResult.study_type`
    // precedence: no adoption, and therefore no PubMed structure either.
    expect(pubmedStudyTypeOverride({ study_type: null, publication_types: [] })).toBeNull();
    expect(pubmedStudyTypeOverride({})).toBeNull();
    expect(pubmedStudyTypeOverride({ study_type: "" })).toBeNull();
  });

  it("never leaves an adopted study type without its structured half", () => {
    // A PubMed record always reports both; this pins the invariant even if a
    // caller passed a record that somehow omitted the array.
    const override = pubmedStudyTypeOverride({ study_type: "Journal Article" });
    expect(override).not.toBeNull();
    expect(Array.isArray(override!.publication_types)).toBe(true);
  });
});
