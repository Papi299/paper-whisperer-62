import { describe, expect, it } from "vitest";
import { mapComparisonRow } from "@/lib/paperComparison/mapRow";
import type { ComparisonRow, ProvenanceCategory } from "@/lib/paperComparison/types";
import { OWNER_ID, makePaperRow, paperId } from "@/lib/paperComparison/__tests__/fixtures";
import { COMPARISON_GROUPS, MISSING_VALUE_TEXT, PROVENANCE_CAVEATS, fieldCaveat, identityLine } from "../comparisonFields";

/**
 * EVIDENCE-MATRIX-001B — what the comparison may show, and how it labels it.
 * These pin the owner-approved copy and the field set; a new field, a renamed
 * label or a lost caveat fails here before it reaches a reviewer.
 */

const ALL_FIELDS = COMPARISON_GROUPS.flatMap((group) => group.fields);

const ALL_CATEGORIES: readonly ProvenanceCategory[] = [
  "library_metadata",
  "import_recorded_publication_types",
  "imported_source_unrecorded",
  "classification_lineage_unrecorded",
  "stored_abstract",
  "ai_or_user_annotation",
  "user_entered",
  "derived_keywords",
  "display_derivation",
];

describe("comparison field definitions", () => {
  it("shows exactly the approved stored fields, in four groups", () => {
    expect(COMPARISON_GROUPS.map((group) => [group.label, group.fields.map((field) => field.label)])).toEqual([
      ["Bibliographic", ["Authors", "Year", "Journal", "PMID", "DOI"]],
      [
        "Study metadata",
        [
          "PaperLume study-type classification",
          "Import-recorded publication types (PubMed/NBIB)",
          "Imported study-type text",
          "Stored statistical methods / AI or user annotation",
        ],
      ],
      [
        "Stored research content",
        ["Abstract as stored in your library", "Stored TL;DR / AI or user annotation", "Your notes"],
      ],
      [
        "Library organization",
        ["Projects", "Tags", "Keywords", "Imported keywords", "MeSH terms", "Substances", "Attachments"],
      ],
    ]);
  });

  it("offers no extracted, inferred or verified finding", () => {
    const forbidden =
      /pico|population|intervention|outcome|sample size|effect|significan|finding|evidence|quality|bias|grade|certainty|synthesis|recommend|conclusion|verified|validated|confirmed|agree/i;
    for (const group of COMPARISON_GROUPS) {
      expect(group.label).not.toMatch(forbidden);
      for (const field of group.fields) expect(field.label, field.id).not.toMatch(forbidden);
    }
  });

  it("gives every field the provenance the read model gives the same value", () => {
    const row = mapComparisonRow(makePaperRow(paperId(1)), OWNER_ID);
    for (const field of ALL_FIELDS) {
      const value = row[field.id as keyof ComparisonRow] as { provenance: ProvenanceCategory };
      expect(value.provenance, field.id).toBe(field.provenance);
    }
  });

  it("represents all nine provenance categories, each with its own caveat", () => {
    expect(Object.keys(PROVENANCE_CAVEATS).sort()).toEqual([...ALL_CATEGORIES].sort());
    expect(new Set(ALL_FIELDS.map((field) => field.provenance))).toEqual(new Set(ALL_CATEGORIES));
    expect(new Set(Object.values(PROVENANCE_CAVEATS)).size).toBe(ALL_CATEGORIES.length);
    for (const field of ALL_FIELDS) {
      expect(fieldCaveat(field).startsWith(PROVENANCE_CAVEATS[field.provenance]), field.id).toBe(true);
    }
  });

  it("uses the owner-approved caveats where they are prescribed", () => {
    expect(PROVENANCE_CAVEATS.classification_lineage_unrecorded).toBe(
      "Source and scientific accuracy not independently verified.",
    );
    // The classification may be AI-written, and says so, after the prescribed caveat.
    const classification = ALL_FIELDS.find((field) => field.id === "studyTypeClassification")!;
    expect(fieldCaveat(classification)).toMatch(/^Source and scientific accuracy not independently verified\. .*AI analysis.*not recorded\.$/);
    expect(PROVENANCE_CAVEATS.import_recorded_publication_types).toMatch(
      /recorded during import .*not freshly checked against PubMed/i,
    );
    expect(PROVENANCE_CAVEATS.stored_abstract).toMatch(/not verbatim publisher text and not the full paper/i);
    expect(PROVENANCE_CAVEATS.ai_or_user_annotation).toMatch(/AI analysis or by you.*does not record which/i);
  });

  it("names the three missing states exactly", () => {
    expect(MISSING_VALUE_TEXT).toEqual({
      not_recorded: "Not recorded in library",
      unreadable: "Stored value cannot be displayed",
      stored_placeholder: "Stored placeholder: Not specified",
    });
  });

  it("never claims more than it stores in a paper's identity line", () => {
    const single = mapComparisonRow(makePaperRow(paperId(1), { authors: ["Solo A"], year: 2020, journal: null }), OWNER_ID);
    expect(identityLine(single)).toBe("Solo A · 2020");
    const many = mapComparisonRow(makePaperRow(paperId(2), { authors: ["Doe J", "Roe R"], year: null }), OWNER_ID);
    expect(identityLine(many)).toBe("Doe J et al. · Journal of Synthetic Fixtures");
    const none = mapComparisonRow(makePaperRow(paperId(3), { authors: [], year: null, journal: null }), OWNER_ID);
    expect(identityLine(none)).toBe("");
  });
});
