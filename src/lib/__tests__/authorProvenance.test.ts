import { describe, it, expect } from "vitest";
import {
  AUTHOR_PROVENANCE_SOURCES,
  authorsArraysEqual,
  buildUnstructuredAuthorProvenance,
  cleanAffiliations,
  cleanIdentifiers,
  makeAuthorProvenance,
  normalizeAuthorProvenanceForStorage,
} from "../authorProvenance";
import { normalizePaperData, type RawPaperData } from "../normalizePaperData";
import { INVALID_CHECKSUM_ORCID, VALID_ORCID } from "./fixtures/orcidVectors";

/**
 * The authorship-provenance contract itself: the builders every parser goes
 * through, and the storage boundary that decides what may be persisted.
 */

describe("cleanAffiliations", () => {
  it("trims, drops blanks, preserves order and collapses exact duplicates", () => {
    expect(cleanAffiliations(["  B  ", "", "A", "B", "   ", "A "])).toEqual(["B", "A"]);
  });

  it("does not parse an institution or strip an embedded email", () => {
    // PubMed routinely appends a corresponding author's address to the
    // affiliation. It is preserved as written: it is affiliation text, and
    // mining it for identity is exactly what this column must not do.
    const raw = "Universidad de Chile, Santiago, Chile. rsotorifo@uchile.cl.";
    expect(cleanAffiliations([raw])).toEqual([raw]);
  });
});

describe("cleanIdentifiers", () => {
  it("trims both halves and keeps the source value otherwise", () => {
    expect(cleanIdentifiers([{ scheme: " ORCID ", value: `  ${VALID_ORCID} ` }])).toEqual([
      { scheme: "ORCID", value: VALID_ORCID },
    ]);
  });

  it("drops an identifier missing either half", () => {
    // Half an identifier cannot be represented honestly, and inventing the
    // missing half is the fabrication this column exists to avoid.
    expect(
      cleanIdentifiers([
        { scheme: "", value: VALID_ORCID },
        { scheme: "ORCID", value: "   " },
        { scheme: "ISNI", value: "123" },
      ]),
    ).toEqual([{ scheme: "ISNI", value: "123" }]);
  });
});

describe("makeAuthorProvenance", () => {
  it("fills every unstated field with its 'source said nothing' value", () => {
    const entry = makeAuthorProvenance({
      source: AUTHOR_PROVENANCE_SOURCES.csv,
      kind: "unknown",
      source_name: "A Name",
    });

    expect(entry).toEqual({
      source: "csv",
      source_field: null,
      kind: "unknown",
      source_name: "A Name",
      given_name: null,
      family_name: null,
      initials: null,
      suffix: null,
      collective_name: null,
      affiliations: [],
      identifiers: [],
      orcid: null,
      orcid_authenticated: null,
    });
  });

  it("derives the ORCID from identifiers rather than accepting one", () => {
    // No call site can hand-place an ORCID its own identifier provenance does
    // not support.
    const entry = makeAuthorProvenance({
      source: "pubmed_api",
      kind: "personal",
      source_name: "A Name",
      identifiers: [{ scheme: "ORCID", value: `https://orcid.org/${VALID_ORCID}` }],
    });

    expect(entry.orcid).toBe(VALID_ORCID);
    expect(entry.identifiers[0].value).toBe(`https://orcid.org/${VALID_ORCID}`);
  });

  it("drops an assertion flag when no ORCID survives validation", () => {
    const entry = makeAuthorProvenance({
      source: "crossref_api",
      kind: "personal",
      source_name: "A Name",
      identifiers: [{ scheme: "ORCID", value: INVALID_CHECKSUM_ORCID }],
      orcid_authenticated: true,
    });

    expect(entry.orcid).toBeNull();
    expect(entry.orcid_authenticated).toBeNull();
    expect(entry.identifiers[0].value).toBe(INVALID_CHECKSUM_ORCID);
  });
});

describe("buildUnstructuredAuthorProvenance", () => {
  it("produces one aligned unknown entry per author", () => {
    const authors = ["Smith, John", "Jane Doe"];
    const provenance = buildUnstructuredAuthorProvenance(authors, "manual", "authors")!;

    expect(provenance).toHaveLength(2);
    expect(provenance.map((entry) => entry.source_name)).toEqual(authors);
    expect(provenance.every((entry) => entry.kind === "unknown")).toBe(true);
  });

  it("returns null for an empty author list, never an empty array", () => {
    expect(buildUnstructuredAuthorProvenance([], "manual", "authors")).toBeNull();
  });
});

describe("normalizeAuthorProvenanceForStorage", () => {
  const authors = ["A", "B"];
  const aligned = buildUnstructuredAuthorProvenance(authors, "csv", "authors")!;

  it("passes an aligned array through", () => {
    expect(normalizeAuthorProvenanceForStorage(aligned, authors)).toBe(aligned);
  });

  it("degrades a misaligned array to null rather than storing it", () => {
    // A partial array is worse than none: once the indexes stop lining up,
    // every entry describes the wrong mention.
    expect(normalizeAuthorProvenanceForStorage(aligned, ["A"])).toBeNull();
    expect(normalizeAuthorProvenanceForStorage(aligned, ["A", "B", "C"])).toBeNull();
  });

  it("treats absence, non-arrays and empty arrays as no provenance", () => {
    expect(normalizeAuthorProvenanceForStorage(undefined, authors)).toBeNull();
    expect(normalizeAuthorProvenanceForStorage(null, authors)).toBeNull();
    expect(normalizeAuthorProvenanceForStorage({}, authors)).toBeNull();
    expect(normalizeAuthorProvenanceForStorage([], [])).toBeNull();
  });
});

describe("authorsArraysEqual", () => {
  it("is exact and order-sensitive", () => {
    expect(authorsArraysEqual(["A", "B"], ["A", "B"])).toBe(true);
    expect(authorsArraysEqual(["A", "B"], ["B", "A"])).toBe(false);
    expect(authorsArraysEqual(["A"], ["A", "B"])).toBe(false);
    // Deliberately NOT the 001A mention key: provenance is bound to the literal
    // string a source supplied, so a punctuation edit is a real change.
    expect(authorsArraysEqual(["Stuart M Phillips"], ["Stuart M. Phillips"])).toBe(false);
  });
});

describe("normalizePaperData — provenance pass-through", () => {
  const config = {
    synonymLookup: {},
    poolStudyTypes: [],
    poolKeywords: [],
    synonymGroups: [],
  };

  function rawPaper(overrides: Partial<RawPaperData> = {}): RawPaperData {
    return {
      title: "A Paper",
      authors: ["Ricardo Soto-Rifo"],
      year: 2024,
      journal: null,
      pmid: null,
      doi: null,
      abstract: null,
      keywords: [],
      mesh_terms: [],
      substances: [],
      study_type: null,
      pubmed_url: null,
      journal_url: null,
      drive_url: null,
      ...overrides,
    };
  }

  it("carries structured provenance through untouched", () => {
    const provenance = [
      makeAuthorProvenance({
        source: "pubmed_api",
        source_field: "Author",
        kind: "personal",
        source_name: "Ricardo Soto-Rifo",
        given_name: "Ricardo",
        family_name: "Soto-Rifo",
        affiliations: ["Universidad de Chile"],
        identifiers: [{ scheme: "ORCID", value: VALID_ORCID }],
      }),
    ];

    const normalized = normalizePaperData(
      rawPaper({ author_provenance: provenance }),
      config,
    );

    // Byte-for-byte: no canonicalization, no initial expansion, no accent
    // stripping, no reordering, no ORCID rewriting.
    expect(normalized.author_provenance).toEqual(provenance);
    expect(normalized.author_provenance![0].orcid).toBe(VALID_ORCID);
  });

  it("keeps provenance aligned when author strings are HTML-decoded", () => {
    // Normalization decodes entities in `authors`, which changes the strings
    // but never their count or order — so the parser's alignment survives, and
    // source_name deliberately keeps the pre-normalization spelling.
    const normalized = normalizePaperData(
      rawPaper({
        authors: ["Jane &amp; Co", "Bob"],
        author_provenance: buildUnstructuredAuthorProvenance(
          ["Jane &amp; Co", "Bob"],
          "csv",
          "authors",
        ),
      }),
      config,
    );

    expect(normalized.authors).toEqual(["Jane & Co", "Bob"]);
    expect(normalized.author_provenance).toHaveLength(2);
    expect(normalized.author_provenance![0].source_name).toBe("Jane &amp; Co");
  });

  it("leaves provenance undefined when the source stated none", () => {
    expect(normalizePaperData(rawPaper(), config).author_provenance).toBeUndefined();
  });

  it("survives structured cloning, so the worker path cannot diverge", () => {
    // The normalization worker moves results across a postMessage boundary.
    // Provenance is plain JSON data, so it clones intact — pinned here because
    // a future non-cloneable field would silently break the worker path only.
    const provenance = buildUnstructuredAuthorProvenance(["A"], "manual", "authors");
    const normalized = normalizePaperData(
      rawPaper({ authors: ["A"], author_provenance: provenance }),
      config,
    );

    expect(structuredClone(normalized)).toEqual(normalized);
    expect(structuredClone(normalized).author_provenance).toEqual(provenance);
  });
});
