import { describe, it, expect } from "vitest";
import {
  parseBibTeX,
  parseCSV,
  parseEndNoteTagged,
  parseNBIB,
  parseRIS,
} from "../importParsers";
import type { AuthorProvenance } from "../authorProvenance";
import { INVALID_CHECKSUM_ORCID, VALID_ORCID } from "./fixtures/orcidVectors";

/**
 * Structured authorship provenance from the file-import parsers.
 *
 * Two properties are asserted everywhere, because everything else depends on
 * them: the existing `authors` output does not change, and provenance is the
 * same length and order as it. Beyond that the formats split in two:
 *
 *  • NBIB states real structure — which field named the author (personal
 *    FAU/AU vs corporate CN), their identifiers, their affiliations — so it
 *    gets structured provenance.
 *  • BibTeX, RIS, EndNote and CSV state an author as an opaque string. They get
 *    honest `unknown` entries with nothing guessed. A comma in a name is a
 *    comma, not a family/given separator.
 */

/** Every entry lines up with its author and states its source honestly. */
function expectAligned(
  authors: string[],
  provenance: AuthorProvenance[] | null | undefined,
  source: string,
) {
  expect(provenance).not.toBeNull();
  expect(provenance).toHaveLength(authors.length);
  provenance!.forEach((entry, index) => {
    expect(entry.source).toBe(source);
    expect(entry.source_name).toBe(authors[index]);
  });
}

/** No structure was invented for an opaque source string. */
function expectNothingGuessed(entry: AuthorProvenance) {
  expect(entry.kind).toBe("unknown");
  expect(entry.given_name).toBeNull();
  expect(entry.family_name).toBeNull();
  expect(entry.initials).toBeNull();
  expect(entry.suffix).toBeNull();
  expect(entry.collective_name).toBeNull();
  expect(entry.affiliations).toEqual([]);
  expect(entry.identifiers).toEqual([]);
  expect(entry.orcid).toBeNull();
  expect(entry.orcid_authenticated).toBeNull();
}

// ══════════════════════════════════════════════════════════════
// NBIB — the one file format with real authorship structure
// ══════════════════════════════════════════════════════════════

/**
 * A MEDLINE tagged record. Tags are left-justified in a four-character column
 * with the `-` immediately after, exactly as PubMed's Citation Manager export
 * writes them.
 */
function nbib(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

describe("parseNBIB — author provenance", () => {
  it("treats FAU and AU as one author, not two", () => {
    const { papers } = parseNBIB(
      nbib(
        "PMID- 39725180",
        "TI  - A study.",
        "FAU - Jin, Youkai",
        "AU  - Jin Y",
      ),
    );

    expect(papers[0].authors).toEqual(["Jin, Youkai"]);
    expectAligned(papers[0].authors, papers[0].author_provenance, "nbib");
    expect(papers[0].author_provenance![0].source_field).toBe("FAU");
  });

  it("classifies a personal author from the field, without splitting the name", () => {
    const { papers } = parseNBIB(
      nbib("PMID- 1", "TI  - T", "FAU - Phillips, Stuart M", "AU  - Phillips SM"),
    );
    const entry = papers[0].author_provenance![0];

    // NLM defines FAU as a *personal author* field, so personhood is stated.
    expect(entry.kind).toBe("personal");
    // The components are NOT: the format does not define that comma as a
    // family/given separator, so nothing is derived from it.
    expect(entry.given_name).toBeNull();
    expect(entry.family_name).toBeNull();
    expect(entry.source_name).toBe("Phillips, Stuart M");
  });

  it("falls back to AU when the export carries no FAU", () => {
    const { papers } = parseNBIB(nbib("PMID- 1", "TI  - T", "AU  - Jin Y", "AU  - Smith J"));

    expect(papers[0].authors).toEqual(["Jin Y", "Smith J"]);
    expectAligned(papers[0].authors, papers[0].author_provenance, "nbib");
    expect(papers[0].author_provenance!.map((e) => e.source_field)).toEqual(["AU", "AU"]);
  });

  it("attaches an ORCID-authority AUID to its own author and normalizes it", () => {
    const { papers } = parseNBIB(
      nbib(
        "PMID- 1",
        "TI  - T",
        "FAU - Soto-Rifo, Ricardo",
        "AU  - Soto-Rifo R",
        `AUID- ORCID: ${VALID_ORCID}`,
      ),
    );
    const entry = papers[0].author_provenance![0];

    expect(entry.identifiers).toEqual([{ scheme: "ORCID", value: VALID_ORCID }]);
    expect(entry.orcid).toBe(VALID_ORCID);
  });

  it("keeps a non-ORCID AUID as provenance without populating orcid", () => {
    const { papers } = parseNBIB(
      nbib("PMID- 1", "TI  - T", "FAU - Doe, Jane", "AUID- ISNI: 0000000121032683"),
    );
    const entry = papers[0].author_provenance![0];

    expect(entry.identifiers).toEqual([{ scheme: "ISNI", value: "0000000121032683" }]);
    expect(entry.orcid).toBeNull();
  });

  it("keeps a checksum-invalid ORCID as raw provenance but derives null", () => {
    const { papers } = parseNBIB(
      nbib("PMID- 1", "TI  - T", "FAU - Doe, Jane", `AUID- ORCID: ${INVALID_CHECKSUM_ORCID}`),
    );
    const entry = papers[0].author_provenance![0];

    expect(entry.identifiers[0].value).toBe(INVALID_CHECKSUM_ORCID);
    expect(entry.orcid).toBeNull();
  });

  it("drops an AUID with no stated authority rather than inventing one", () => {
    const { papers } = parseNBIB(
      nbib("PMID- 1", "TI  - T", "FAU - Doe, Jane", `AUID- ${VALID_ORCID}`),
    );
    const entry = papers[0].author_provenance![0];

    // Without an authority prefix there is no honest scheme to record it under,
    // and the value's shape is not permission to assume one.
    expect(entry.identifiers).toEqual([]);
    expect(entry.orcid).toBeNull();
  });

  it("keeps multiple AD affiliations for one author, in order", () => {
    const { papers } = parseNBIB(
      nbib(
        "PMID- 1",
        "TI  - T",
        "FAU - Soto-Rifo, Ricardo",
        "AU  - Soto-Rifo R",
        "AD  - Laboratory of Molecular Virology, Universidad de Chile.",
        "AD  - HIV/AIDS Workgroup, Universidad de Chile.",
      ),
    );

    expect(papers[0].author_provenance![0].affiliations).toEqual([
      "Laboratory of Molecular Virology, Universidad de Chile.",
      "HIV/AIDS Workgroup, Universidad de Chile.",
    ]);
  });

  it("does not bleed AUID or AD from one author into the next", () => {
    // The reason this parser walks the record in order instead of zipping
    // allFieldValues() arrays: only author 1 and author 3 have an ORCID here,
    // so index-pairing would put author 3's iD on author 2.
    const { papers } = parseNBIB(
      nbib(
        "PMID- 1",
        "TI  - T",
        "FAU - First, Ann",
        "AU  - First A",
        `AUID- ORCID: ${VALID_ORCID}`,
        "AD  - First Place",
        "FAU - Middle, Bob",
        "AU  - Middle B",
        "FAU - Last, Zed",
        "AU  - Last Z",
        "AUID- ISNI: 12345",
        "AD  - Third Place",
      ),
    );
    const provenance = papers[0].author_provenance!;

    expect(papers[0].authors).toEqual(["First, Ann", "Middle, Bob", "Last, Zed"]);
    expect(provenance[0].orcid).toBe(VALID_ORCID);
    expect(provenance[0].affiliations).toEqual(["First Place"]);

    expect(provenance[1].identifiers).toEqual([]);
    expect(provenance[1].orcid).toBeNull();
    expect(provenance[1].affiliations).toEqual([]);

    expect(provenance[2].identifiers).toEqual([{ scheme: "ISNI", value: "12345" }]);
    expect(provenance[2].orcid).toBeNull();
    expect(provenance[2].affiliations).toEqual(["Third Place"]);
  });

  it("marks a CN corporate author collective, in the existing display order", () => {
    const { papers } = parseNBIB(
      nbib(
        "PMID- 1",
        "TI  - T",
        "FAU - First, Ann",
        "AU  - First A",
        "CN  - The Study Group",
        "FAU - Last, Zed",
        "AU  - Last Z",
      ),
    );

    // Unchanged behaviour: corporate authors are appended after the personal
    // ones rather than kept at their byline position.
    expect(papers[0].authors).toEqual(["First, Ann", "Last, Zed", "The Study Group"]);
    expectAligned(papers[0].authors, papers[0].author_provenance, "nbib");

    const provenance = papers[0].author_provenance!;
    expect(provenance.map((e) => e.kind)).toEqual(["personal", "personal", "collective"]);
    expect(provenance[2].source_field).toBe("CN");
    expect(provenance[2].collective_name).toBe("The Study Group");
    expect(provenance[2].given_name).toBeNull();
    expect(provenance[2].family_name).toBeNull();
  });

  it("ignores an AD that precedes every author rather than guessing an owner", () => {
    const { papers } = parseNBIB(
      nbib("PMID- 1", "TI  - T", "AD  - Orphan affiliation", "FAU - Doe, Jane"),
    );

    expect(papers[0].author_provenance![0].affiliations).toEqual([]);
  });

  it("reports null provenance for a record with no authors", () => {
    const { papers } = parseNBIB(nbib("PMID- 1", "TI  - A title only"));

    expect(papers[0].authors).toEqual([]);
    expect(papers[0].author_provenance).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// Unstructured sources
// ══════════════════════════════════════════════════════════════

describe("parseBibTeX — author provenance", () => {
  const source = `@article{k1,
    title = {A Paper},
    author = {Phillips, Stuart M and Jane Q Doe and {The Study Group}},
  }`;

  it("preserves the existing author output", () => {
    const { papers } = parseBibTeX(source);
    expect(papers[0].authors).toEqual([
      "Phillips, Stuart M",
      "Jane Q Doe",
      "The Study Group",
    ]);
  });

  it("emits aligned unknown provenance from the author field", () => {
    const { papers } = parseBibTeX(source);
    expectAligned(papers[0].authors, papers[0].author_provenance, "bibtex");
    papers[0].author_provenance!.forEach(expectNothingGuessed);
    expect(papers[0].author_provenance![0].source_field).toBe("author");
  });

  it("does not split a comma-form name into family and given", () => {
    const { papers } = parseBibTeX(source);
    const entry = papers[0].author_provenance![0];
    expect(entry.source_name).toBe("Phillips, Stuart M");
    expect(entry.family_name).toBeNull();
    expect(entry.given_name).toBeNull();
  });

  it("does not read braces as a corporate-author signal", () => {
    const { papers } = parseBibTeX(source);
    // "{The Study Group}" looks organisational, but this parser draws no such
    // structural distinction, so claiming `collective` would be a guess.
    expect(papers[0].author_provenance![2].kind).toBe("unknown");
    expect(papers[0].author_provenance![2].collective_name).toBeNull();
  });

  it("reports null when an entry has no author field", () => {
    const { papers } = parseBibTeX(`@article{k2, title = {No authors}, }`);
    expect(papers[0].authors).toEqual([]);
    expect(papers[0].author_provenance).toBeNull();
  });
});

describe("parseRIS — author provenance", () => {
  const source = [
    "TY  - JOUR",
    "T1  - A Paper",
    "AU  - Smith, John",
    "AU  - Doe, Jane",
    "A1  - Primary, Author",
    "ER  - ",
  ].join("\n");

  it("preserves the existing author output and order", () => {
    const { papers } = parseRIS(source);
    expect(papers[0].authors).toEqual(["Smith, John", "Doe, Jane", "Primary, Author"]);
  });

  it("records which RIS tag produced each entry", () => {
    const { papers } = parseRIS(source);
    expectAligned(papers[0].authors, papers[0].author_provenance, "ris");
    expect(papers[0].author_provenance!.map((e) => e.source_field)).toEqual([
      "AU",
      "AU",
      "A1",
    ]);
  });

  it("guesses no structure from the comma in a RIS name", () => {
    const { papers } = parseRIS(source);
    papers[0].author_provenance!.forEach(expectNothingGuessed);
  });

  it("invents no ORCID from unrelated RIS fields", () => {
    const { papers } = parseRIS(
      [
        "TY  - JOUR",
        "T1  - A Paper",
        "AU  - Smith, John",
        `N1  - ORCID ${VALID_ORCID}`,
        "ER  - ",
      ].join("\n"),
    );
    expect(papers[0].author_provenance![0].orcid).toBeNull();
    expect(papers[0].author_provenance![0].identifiers).toEqual([]);
  });
});

describe("parseEndNoteTagged — author provenance", () => {
  const source = ["%0 Journal Article", "%T A Paper", "%A Smith, John", "%A Doe, Jane"].join("\n");

  it("preserves the existing author output", () => {
    const { papers } = parseEndNoteTagged(source);
    expect(papers[0].authors).toEqual(["Smith, John", "Doe, Jane"]);
  });

  it("emits aligned unknown provenance tagged %A", () => {
    const { papers } = parseEndNoteTagged(source);
    expectAligned(papers[0].authors, papers[0].author_provenance, "endnote");
    expect(papers[0].author_provenance!.every((e) => e.source_field === "%A")).toBe(true);
    papers[0].author_provenance!.forEach(expectNothingGuessed);
  });

  it("does not infer family/given from the comma alone", () => {
    const { papers } = parseEndNoteTagged(source);
    expect(papers[0].author_provenance![0].source_name).toBe("Smith, John");
    expect(papers[0].author_provenance![0].family_name).toBeNull();
  });
});

describe("parseCSV — author provenance", () => {
  const source = [
    "title,authors",
    '"A Paper","Smith, John; Doe, Jane; Global Burden Consortium"',
  ].join("\n");

  it("preserves the existing semicolon splitting exactly", () => {
    const { papers } = parseCSV(source);
    expect(papers[0].authors).toEqual([
      "Smith, John",
      "Doe, Jane",
      "Global Burden Consortium",
    ]);
  });

  it("emits aligned unknown provenance for user-controlled values", () => {
    const { papers } = parseCSV(source);
    expectAligned(papers[0].authors, papers[0].author_provenance, "csv");
    expect(papers[0].author_provenance!.every((e) => e.source_field === "authors")).toBe(true);
    papers[0].author_provenance!.forEach(expectNothingGuessed);
  });

  it("does not classify a value as collective from its wording", () => {
    const { papers } = parseCSV(source);
    // "Consortium" is a word in a spreadsheet cell, not a schema.
    expect(papers[0].author_provenance![2].kind).toBe("unknown");
    expect(papers[0].author_provenance![2].collective_name).toBeNull();
  });

  it("reports null when the authors cell is empty", () => {
    const { papers } = parseCSV(["title,authors", '"A Paper",""'].join("\n"));
    expect(papers[0].authors).toEqual([]);
    expect(papers[0].author_provenance).toBeNull();
  });
});
