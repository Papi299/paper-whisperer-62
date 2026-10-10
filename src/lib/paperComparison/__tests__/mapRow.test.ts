import { describe, expect, it } from "vitest";
import { ComparisonIntegrityError } from "../errors";
import { mapComparisonRow } from "../mapRow";
import type { ComparisonRow } from "../types";
import { OTHER_USER_ID, OWNER_ID, makePaperRow, makeSparsePaperRow, paperId } from "./fixtures";

const ID = paperId(1);

function expectIntegrity(run: () => unknown, reason: string) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComparisonIntegrityError);
    expect((error as ComparisonIntegrityError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected ComparisonIntegrityError(${reason})`);
}

describe("mapComparisonRow — full contract", () => {
  it("maps a fully populated row to the exact DTO", () => {
    expect(mapComparisonRow(makePaperRow(ID), OWNER_ID)).toEqual({
      paperId: ID,
      title: { provenance: "library_metadata", value: { kind: "present", value: "Synthetic randomized trial of compound A" } },
      authors: { provenance: "library_metadata", value: { kind: "present", value: ["Doe J", "Roe R", "Poe P", "Moe M"] } },
      year: { provenance: "library_metadata", value: { kind: "present", value: 2021 } },
      journal: { provenance: "library_metadata", value: { kind: "present", value: "Journal of Synthetic Fixtures" } },
      pmid: { provenance: "library_metadata", value: { kind: "present", value: "12345678" } },
      doi: { provenance: "library_metadata", value: { kind: "present", value: "10.5555/synthetic.0001" } },
      links: {
        provenance: "display_derivation",
        value: { pubmed: "https://pubmed.ncbi.nlm.nih.gov/12345678/", doi: "https://doi.org/10.5555/synthetic.0001" },
      },
      publicationTypes: {
        provenance: "import_recorded_publication_types",
        value: { kind: "present", value: ["Randomized Controlled Trial", "Clinical Trial, Phase II", "Journal Article"] },
      },
      importedTypeText: {
        provenance: "imported_source_unrecorded",
        value: { kind: "present", value: "Randomized Controlled Trial, Clinical Trial, Phase II" },
      },
      studyTypeClassification: {
        provenance: "classification_lineage_unrecorded",
        value: { kind: "present", value: "Randomized Controlled Trial" },
      },
      abstract: {
        provenance: "stored_abstract",
        value: { kind: "present", value: "Background: synthetic. Results: 10<sup>-4</sup> &#xd7; 2.5 ± 0.3." },
      },
      tldr: { provenance: "ai_or_user_annotation", value: { kind: "present", value: "Synthetic summary for compound A." } },
      statisticalMethods: { provenance: "ai_or_user_annotation", value: { kind: "present", value: "Mixed-effects model" } },
      notes: { provenance: "user_entered", value: { kind: "present", value: "Synthetic note." } },
      projects: {
        provenance: "user_entered",
        items: [{ id: `${ID}-proj-1`, name: "Synthetic project", color: "#336699" }],
        unavailableCount: 0,
      },
      tags: {
        provenance: "user_entered",
        items: [{ id: `${ID}-tag-1`, name: "synthetic-tag", color: null }],
        unavailableCount: 0,
      },
      keywords: { provenance: "derived_keywords", value: { kind: "present", value: ["compound A", "adults"] } },
      importedKeywords: { provenance: "imported_source_unrecorded", value: { kind: "present", value: ["Compound A"] } },
      meshTerms: { provenance: "imported_source_unrecorded", value: { kind: "present", value: ["Humans", "Adult"] } },
      substances: { provenance: "imported_source_unrecorded", value: { kind: "present", value: ["Compound A"] } },
      attachments: { provenance: "display_derivation", value: { total: 2, pdf: 1, image: 1, other: 0 } },
    });
  });

  it("maps a sparse row to not-recorded values and empty relationships — never borrowed defaults", () => {
    const row = mapComparisonRow(makeSparsePaperRow(ID), OWNER_ID);
    for (const field of [
      "authors", "year", "journal", "pmid", "doi", "publicationTypes", "importedTypeText",
      "studyTypeClassification", "abstract", "tldr", "statisticalMethods", "notes",
      "keywords", "importedKeywords", "meshTerms", "substances",
    ] as const) {
      expect(row[field].value).toEqual({ kind: "not_recorded" });
    }
    expect(row.links.value).toEqual({ pubmed: null, doi: null });
    expect(row.projects).toEqual({ provenance: "user_entered", items: [], unavailableCount: 0 });
    expect(row.tags).toEqual({ provenance: "user_entered", items: [], unavailableCount: 0 });
    expect(row.attachments.value).toEqual({ total: 0, pdf: 0, image: 0, other: 0 });
  });

  it("returns a deeply frozen row", () => {
    const row = mapComparisonRow(makePaperRow(ID), OWNER_ID);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.title)).toBe(true);
    expect(Object.isFrozen(row.projects.items)).toBe(true);
  });
});

describe("mapComparisonRow — every field reads only its designated column", () => {
  // Changing one stored column must change exactly the field(s) listed for it.
  const SOURCES: ReadonlyArray<[column: string, fields: ReadonlyArray<keyof ComparisonRow>, replacement: unknown]> = [
    ["title", ["title"], "Synthetic changed title"],
    ["authors", ["authors"], ["Changed A"]],
    ["year", ["year"], 1999],
    ["journal", ["journal"], "Changed journal"],
    ["pmid", ["pmid", "links"], "87654321"],
    ["doi", ["doi", "links"], "10.5555/changed"],
    ["raw_publication_types", ["publicationTypes"], ["Review"]],
    ["raw_study_type", ["importedTypeText"], "Review"],
    ["study_type", ["studyTypeClassification"], "Cohort Study"],
    ["abstract", ["abstract"], "Changed synthetic abstract."],
    ["tldr", ["tldr"], "Changed summary."],
    ["statistical_methods", ["statisticalMethods"], "Changed methods"],
    ["notes", ["notes"], "Changed note."],
    ["keywords", ["keywords"], ["changed"]],
    ["raw_keywords", ["importedKeywords"], ["Changed"]],
    ["mesh_terms", ["meshTerms"], ["Changed"]],
    ["substances", ["substances"], ["Changed"]],
    ["paper_attachments", ["attachments"], []],
    ["paper_projects", ["projects"], []],
    ["paper_tags", ["tags"], []],
  ];

  const baseline = mapComparisonRow(makePaperRow(ID), OWNER_ID);
  const fieldKeys = (Object.keys(baseline) as Array<keyof ComparisonRow>).filter((key) => key !== "paperId");

  it.each(SOURCES)("%s → %j", (column, fields, replacement) => {
    const changed = mapComparisonRow(makePaperRow(ID, { [column]: replacement }), OWNER_ID);
    for (const key of fieldKeys) {
      if (fields.includes(key)) expect(changed[key], `${key} should follow ${column}`).not.toEqual(baseline[key]);
      else expect(changed[key], `${key} must not follow ${column}`).toEqual(baseline[key]);
    }
  });

  it("covers every field of the DTO", () => {
    const covered = new Set(SOURCES.flatMap(([, fields]) => fields));
    expect([...covered].sort()).toEqual([...fieldKeys].sort());
  });

  it("never reads the free-text URL columns, even when they are present on the row", () => {
    const row = mapComparisonRow(
      makePaperRow(ID, {
        pmid: null,
        doi: null,
        pubmed_url: "javascript:alert(1)",
        journal_url: "https://journal.invalid/synthetic",
        drive_url: "https://drive.invalid/synthetic",
      }),
      OWNER_ID,
    );
    expect(row.links.value).toEqual({ pubmed: null, doi: null });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("javascript:");
    expect(serialized).not.toContain("journal.invalid");
    expect(serialized).not.toContain("drive.invalid");
  });
});

describe("mapComparisonRow — provenance and scope", () => {
  const EXPECTED_PROVENANCE: Record<Exclude<keyof ComparisonRow, "paperId">, string> = {
    title: "library_metadata",
    authors: "library_metadata",
    year: "library_metadata",
    journal: "library_metadata",
    pmid: "library_metadata",
    doi: "library_metadata",
    links: "display_derivation",
    publicationTypes: "import_recorded_publication_types",
    importedTypeText: "imported_source_unrecorded",
    studyTypeClassification: "classification_lineage_unrecorded",
    abstract: "stored_abstract",
    tldr: "ai_or_user_annotation",
    statisticalMethods: "ai_or_user_annotation",
    notes: "user_entered",
    projects: "user_entered",
    tags: "user_entered",
    keywords: "derived_keywords",
    importedKeywords: "imported_source_unrecorded",
    meshTerms: "imported_source_unrecorded",
    substances: "imported_source_unrecorded",
    attachments: "display_derivation",
  };

  it("labels every field with its provenance category", () => {
    const row = mapComparisonRow(makePaperRow(ID), OWNER_ID);
    const actual = Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => key !== "paperId")
        .map(([key, field]) => [key, (field as { provenance: string }).provenance]),
    );
    expect(actual).toEqual(EXPECTED_PROVENANCE);
  });

  it("has no evidence-extraction, agreement or correctness keys anywhere in the DTO", () => {
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) {
          keys.add(key);
          walk(nested);
        }
      }
    };
    walk(mapComparisonRow(makePaperRow(ID), OWNER_ID));
    const forbidden =
      /pico|population|intervention|comparator|outcome|effect|risk|bias|quality|grade|agree|match|differ|verif|confirm|correct|finding|evidence|score/i;
    expect([...keys].filter((key) => forbidden.test(key))).toEqual([]);
  });

  it("never derives publication types from the imported type text", () => {
    // The legacy joined string is all a non-PubMed import (or an older row) has.
    const joined = "Randomized Controlled Trial, Clinical Trial, Phase II, Journal Article";
    const row = mapComparisonRow(makePaperRow(ID, { raw_publication_types: null, raw_study_type: joined }), OWNER_ID);
    expect(row.publicationTypes.value).toEqual({ kind: "not_recorded" });
    expect(row.importedTypeText.value).toEqual({ kind: "present", value: joined });
  });

  it("shows the classification and the publication types side by side without relating them", () => {
    const row = mapComparisonRow(
      makePaperRow(ID, { study_type: "Meta-Analysis", raw_publication_types: ["Randomized Controlled Trial"] }),
      OWNER_ID,
    );
    expect(row.studyTypeClassification.value).toEqual({ kind: "present", value: "Meta-Analysis" });
    expect(row.publicationTypes.value).toEqual({ kind: "present", value: ["Randomized Controlled Trial"] });
  });

  it("keeps a stored 'Not specified' classification as a placeholder", () => {
    const row = mapComparisonRow(makePaperRow(ID, { study_type: "Not specified", tldr: "Not specified" }), OWNER_ID);
    expect(row.studyTypeClassification.value).toEqual({ kind: "stored_placeholder", value: "Not specified" });
    expect(row.tldr.value).toEqual({ kind: "stored_placeholder", value: "Not specified" });
  });
});

describe("mapComparisonRow — Projects and Tags", () => {
  it("counts an assignment whose Project is not readable instead of dropping or guessing it", () => {
    const row = mapComparisonRow(makePaperRow(ID, { paper_projects: [{ paper_id: ID, project: null }] }), OWNER_ID);
    expect(row.projects).toEqual({ provenance: "user_entered", items: [], unavailableCount: 1 });
  });

  it("counts a Tag without a usable id or name as unavailable", () => {
    const row = mapComparisonRow(
      makePaperRow(ID, {
        paper_tags: [
          { paper_id: ID, tag: { id: "t-1", user_id: OWNER_ID, name: "  ", color: null } },
          { paper_id: ID, tag: { id: 7, user_id: OWNER_ID, name: "numeric id", color: null } },
          { paper_id: ID, tag: { id: "t-3", user_id: OWNER_ID, name: "kept", color: 12 } },
        ],
      }),
      OWNER_ID,
    );
    expect(row.tags.items).toEqual([{ id: "t-3", name: "kept", color: null }]);
    expect(row.tags.unavailableCount).toBe(2);
  });

  it("orders items by name, then id, regardless of response order", () => {
    const project = (id: string, name: string) => ({ paper_id: ID, project: { id, user_id: OWNER_ID, name, color: null } });
    const row = mapComparisonRow(
      makePaperRow(ID, { paper_projects: [project("p-3", "beta"), project("p-2", "alpha"), project("p-1", "Alpha")] }),
      OWNER_ID,
    );
    expect(row.projects.items.map((item) => item.id)).toEqual(["p-1", "p-2", "p-3"]);
  });

  it("rejects a Project owned by another user", () => {
    expectIntegrity(
      () =>
        mapComparisonRow(
          makePaperRow(ID, {
            paper_projects: [{ paper_id: ID, project: { id: "p-x", user_id: OTHER_USER_ID, name: "foreign", color: null } }],
          }),
          OWNER_ID,
        ),
      "owner_mismatch",
    );
  });

  it("rejects an assignment that names another paper", () => {
    expectIntegrity(
      () =>
        mapComparisonRow(
          makePaperRow(ID, {
            paper_tags: [{ paper_id: paperId(2), tag: { id: "t-x", user_id: OWNER_ID, name: "elsewhere", color: null } }],
          }),
          OWNER_ID,
        ),
      "relationship_mismatch",
    );
  });

  it.each([
    ["a missing relationship list", { paper_projects: undefined }],
    ["a non-array relationship list", { paper_tags: { paper_id: ID } }],
    ["a non-object assignment", { paper_tags: ["t-1"] }],
    ["a non-object Project", { paper_projects: [{ paper_id: ID, project: "p-1" }] }],
  ])("rejects %s as malformed", (_label, overrides) => {
    expectIntegrity(() => mapComparisonRow(makePaperRow(ID, overrides), OWNER_ID), "malformed_response");
  });
});

describe("mapComparisonRow — row and attachment integrity", () => {
  it("rejects a row owned by another user", () => {
    expectIntegrity(() => mapComparisonRow(makePaperRow(ID, { user_id: OTHER_USER_ID }), OWNER_ID), "owner_mismatch");
  });

  it("rejects an attachment recorded under another paper", () => {
    expectIntegrity(
      () =>
        mapComparisonRow(
          makePaperRow(ID, {
            paper_attachments: [{ id: "a-1", paper_id: paperId(2), user_id: OWNER_ID, file_type: "application/pdf" }],
          }),
          OWNER_ID,
        ),
      "relationship_mismatch",
    );
  });

  it("rejects an attachment owned by another user", () => {
    expectIntegrity(
      () =>
        mapComparisonRow(
          makePaperRow(ID, {
            paper_attachments: [{ id: "a-1", paper_id: ID, user_id: OTHER_USER_ID, file_type: "application/pdf" }],
          }),
          OWNER_ID,
        ),
      "owner_mismatch",
    );
  });

  it.each([[null], [[]], ["row"], [{ user_id: OWNER_ID }]])("rejects %j as malformed", (raw) => {
    expectIntegrity(() => mapComparisonRow(raw, OWNER_ID), "malformed_response");
  });
});
