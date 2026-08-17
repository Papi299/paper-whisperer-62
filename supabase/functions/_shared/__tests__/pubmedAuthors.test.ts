import { describe, it, expect } from "vitest";
import { extractPubMedAuthors } from "../pubmedAuthors";
import {
  INVALID_CHECKSUM_ORCID,
  OTHER_VALID_ORCID,
  VALID_ORCID,
} from "../../../../src/lib/__tests__/fixtures/orcidVectors";

/**
 * PubMed authorship extraction, against deterministic fixtures.
 *
 * The fixtures reproduce the element shapes NCBI's EFetch actually emits and
 * that the NLM PubMed DTD sanctions:
 *
 *   Author (((LastName, ForeName?, Initials?, Suffix?) | CollectiveName),
 *           Identifier*, AffiliationInfo*)
 *   AffiliationInfo (Affiliation, Identifier*)
 *   Identifier (#PCDATA)  with Source CDATA #REQUIRED
 *
 * No test here touches the network: PubMed is a fixture, never a CI dependency.
 */

/** Wrap author XML in the surrounding record shape EFetch returns. */
function record(authorsXml: string): string {
  return (
    "<PubmedArticle><MedlineCitation><Article>" +
    "<ArticleTitle>Fixture</ArticleTitle>" +
    `<AuthorList CompleteYN="Y">${authorsXml}</AuthorList>` +
    "</Article></MedlineCitation></PubmedArticle>"
  );
}

const PERSONAL = `<Author ValidYN="Y"><LastName>Soto-Rifo</LastName><ForeName>Ricardo</ForeName><Initials>R</Initials></Author>`;

describe("extractPubMedAuthors — personal authors", () => {
  it("keeps the compatibility projection and reports personal provenance", () => {
    const { authors, author_provenance } = extractPubMedAuthors(record(PERSONAL));

    expect(authors).toEqual(["Ricardo Soto-Rifo"]);
    expect(author_provenance).toHaveLength(1);

    const entry = author_provenance![0];
    expect(entry.source).toBe("pubmed_api");
    expect(entry.source_field).toBe("Author");
    expect(entry.kind).toBe("personal");
    expect(entry.source_name).toBe("Ricardo Soto-Rifo");
    expect(entry.given_name).toBe("Ricardo");
    expect(entry.family_name).toBe("Soto-Rifo");
    expect(entry.initials).toBe("R");
    expect(entry.suffix).toBeNull();
    expect(entry.collective_name).toBeNull();
    expect(entry.orcid).toBeNull();
    expect(entry.orcid_authenticated).toBeNull();
  });

  it("preserves a suffix separately without changing the authors projection", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>Doe</LastName><ForeName>John</ForeName><Initials>J</Initials><Suffix>Jr</Suffix></Author>`,
    );
    const { authors, author_provenance } = extractPubMedAuthors(xml);

    // Unchanged behaviour: the suffix is NOT appended to the display string.
    expect(authors).toEqual(["John Doe"]);
    expect(author_provenance![0].suffix).toBe("Jr");
    expect(author_provenance![0].family_name).toBe("Doe");
  });

  it("skips an author with no ForeName, in BOTH arrays", () => {
    // Pre-existing behaviour: `ForeName` is optional in the DTD and the
    // compatibility projection emits nothing without it. Provenance must skip
    // the same author, or every later entry would describe the wrong name.
    const xml = record(
      `<Author ValidYN="Y"><LastName>Onlylast</LastName><Initials>O</Initials></Author>` + PERSONAL,
    );
    const { authors, author_provenance } = extractPubMedAuthors(xml);

    expect(authors).toEqual(["Ricardo Soto-Rifo"]);
    expect(author_provenance).toHaveLength(1);
    expect(author_provenance![0].source_name).toBe("Ricardo Soto-Rifo");
  });

  it("returns null provenance when a record yields no authors at all", () => {
    const { authors, author_provenance } = extractPubMedAuthors(record(""));
    expect(authors).toEqual([]);
    expect(author_provenance).toBeNull();
  });
});

describe("extractPubMedAuthors — identifiers and ORCID", () => {
  it("keeps an ORCID-labelled identifier and derives the canonical value", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>Doe</LastName><ForeName>Jane</ForeName>` +
        `<Identifier Source="ORCID">${VALID_ORCID}</Identifier></Author>`,
    );
    const entry = extractPubMedAuthors(xml).author_provenance![0];

    expect(entry.identifiers).toEqual([{ scheme: "ORCID", value: VALID_ORCID }]);
    expect(entry.orcid).toBe(VALID_ORCID);
  });

  it("normalizes a provider URI form while keeping the raw value", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>Doe</LastName><ForeName>Jane</ForeName>` +
        `<Identifier Source="ORCID">https://orcid.org/${VALID_ORCID}</Identifier></Author>`,
    );
    const entry = extractPubMedAuthors(xml).author_provenance![0];

    expect(entry.identifiers[0].value).toBe(`https://orcid.org/${VALID_ORCID}`);
    expect(entry.orcid).toBe(VALID_ORCID);
  });

  it("keeps a non-ORCID identifier but never copies it into orcid", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>Doe</LastName><ForeName>Jane</ForeName>` +
        `<Identifier Source="ISNI">0000000121032683</Identifier></Author>`,
    );
    const entry = extractPubMedAuthors(xml).author_provenance![0];

    expect(entry.identifiers).toEqual([{ scheme: "ISNI", value: "0000000121032683" }]);
    expect(entry.orcid).toBeNull();
  });

  it("preserves a checksum-invalid ORCID as raw provenance but derives null", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>Doe</LastName><ForeName>Jane</ForeName>` +
        `<Identifier Source="ORCID">${INVALID_CHECKSUM_ORCID}</Identifier></Author>`,
    );
    const entry = extractPubMedAuthors(xml).author_provenance![0];

    // The raw value stays useful for diagnosis; the derived field fails closed.
    expect(entry.identifiers[0].value).toBe(INVALID_CHECKSUM_ORCID);
    expect(entry.orcid).toBeNull();
  });

  it("fails closed when one mention carries two distinct valid ORCIDs", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>Doe</LastName><ForeName>Jane</ForeName>` +
        `<Identifier Source="ORCID">${VALID_ORCID}</Identifier>` +
        `<Identifier Source="ORCID">${OTHER_VALID_ORCID}</Identifier></Author>`,
    );
    const entry = extractPubMedAuthors(xml).author_provenance![0];

    expect(entry.identifiers).toHaveLength(2);
    expect(entry.orcid).toBeNull();
  });

  it("never promotes an AffiliationInfo identifier into author identity", () => {
    // The DTD allows Identifier in TWO places: under Author (the author's own)
    // and inside AffiliationInfo (the *institution's*, e.g. GRID/ISNI). Reading
    // the whole block would turn an organisation's id into author identity
    // evidence the source never asserted.
    const xml = record(
      `<Author ValidYN="Y"><LastName>Doe</LastName><ForeName>Jane</ForeName>` +
        `<AffiliationInfo><Affiliation>Some University</Affiliation>` +
        `<Identifier Source="GRID">grid.5335.0</Identifier>` +
        `<Identifier Source="ORCID">${OTHER_VALID_ORCID}</Identifier>` +
        `</AffiliationInfo></Author>`,
    );
    const entry = extractPubMedAuthors(xml).author_provenance![0];

    expect(entry.identifiers).toEqual([]);
    expect(entry.orcid).toBeNull();
    expect(entry.affiliations).toEqual(["Some University"]);
  });

  it("keeps the author's own identifier while ignoring the affiliation's", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>Doe</LastName><ForeName>Jane</ForeName>` +
        `<Identifier Source="ORCID">${VALID_ORCID}</Identifier>` +
        `<AffiliationInfo><Affiliation>Some University</Affiliation>` +
        `<Identifier Source="GRID">grid.5335.0</Identifier></AffiliationInfo></Author>`,
    );
    const entry = extractPubMedAuthors(xml).author_provenance![0];

    expect(entry.identifiers).toEqual([{ scheme: "ORCID", value: VALID_ORCID }]);
    expect(entry.orcid).toBe(VALID_ORCID);
  });
});

describe("extractPubMedAuthors — affiliations", () => {
  it("keeps multiple affiliations for one author, in source order", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>Soto-Rifo</LastName><ForeName>Ricardo</ForeName>` +
        `<AffiliationInfo><Affiliation>Laboratory of Molecular Virology, Universidad de Chile.</Affiliation></AffiliationInfo>` +
        `<AffiliationInfo><Affiliation>HIV/AIDS Workgroup, Universidad de Chile.</Affiliation></AffiliationInfo>` +
        `<AffiliationInfo><Affiliation>Millennium Institute, Santiago, Chile.</Affiliation></AffiliationInfo></Author>`,
    );
    const entry = extractPubMedAuthors(xml).author_provenance![0];

    expect(entry.affiliations).toEqual([
      "Laboratory of Molecular Virology, Universidad de Chile.",
      "HIV/AIDS Workgroup, Universidad de Chile.",
      "Millennium Institute, Santiago, Chile.",
    ]);
  });

  it("attaches each author's affiliations to that author only", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>One</LastName><ForeName>Author</ForeName>` +
        `<AffiliationInfo><Affiliation>First Place</Affiliation></AffiliationInfo></Author>` +
        `<Author ValidYN="Y"><LastName>Two</LastName><ForeName>Author</ForeName>` +
        `<AffiliationInfo><Affiliation>Second Place</Affiliation></AffiliationInfo></Author>`,
    );
    const provenance = extractPubMedAuthors(xml).author_provenance!;

    expect(provenance[0].affiliations).toEqual(["First Place"]);
    expect(provenance[1].affiliations).toEqual(["Second Place"]);
  });

  it("decodes entities and strips markup inside affiliation text", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>Doe</LastName><ForeName>Jane</ForeName>` +
        `<AffiliationInfo><Affiliation>Dept of <i>Biology</i> &amp; Chemistry</Affiliation></AffiliationInfo></Author>`,
    );
    const entry = extractPubMedAuthors(xml).author_provenance![0];

    expect(entry.affiliations).toEqual(["Dept of Biology & Chemistry"]);
  });
});

describe("extractPubMedAuthors — collective authors", () => {
  it("marks a CollectiveName collective and never parses it as a person", () => {
    const xml = record(
      `<Author ValidYN="Y"><CollectiveName>GBD 2023 Dietary Risk Factors Collaborators</CollectiveName></Author>`,
    );
    const { authors, author_provenance } = extractPubMedAuthors(xml);

    expect(authors).toEqual(["GBD 2023 Dietary Risk Factors Collaborators"]);

    const entry = author_provenance![0];
    expect(entry.kind).toBe("collective");
    expect(entry.source_field).toBe("CollectiveName");
    expect(entry.collective_name).toBe("GBD 2023 Dietary Risk Factors Collaborators");
    expect(entry.given_name).toBeNull();
    expect(entry.family_name).toBeNull();
    expect(entry.initials).toBeNull();
    expect(entry.suffix).toBeNull();
  });

  it("decodes entities in a collective name, matching the authors projection", () => {
    const xml = record(
      `<Author ValidYN="Y"><CollectiveName>IHD &amp; Diet Collaborators</CollectiveName></Author>`,
    );
    const { authors, author_provenance } = extractPubMedAuthors(xml);

    expect(authors).toEqual(["IHD & Diet Collaborators"]);
    expect(author_provenance![0].source_name).toBe("IHD & Diet Collaborators");
    expect(author_provenance![0].collective_name).toBe("IHD & Diet Collaborators");
  });
});

describe("extractPubMedAuthors — mixed order", () => {
  it("preserves exact source order across personal and collective authors", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>First</LastName><ForeName>Ann</ForeName></Author>` +
        `<Author ValidYN="Y"><CollectiveName>The Study Group</CollectiveName></Author>` +
        `<Author ValidYN="Y"><LastName>Last</LastName><ForeName>Zed</ForeName></Author>`,
    );
    const { authors, author_provenance } = extractPubMedAuthors(xml);

    expect(authors).toEqual(["Ann First", "The Study Group", "Zed Last"]);
    expect(author_provenance!.map((entry) => entry.kind)).toEqual([
      "personal",
      "collective",
      "personal",
    ]);
    // Alignment is the whole contract.
    author_provenance!.forEach((entry, index) => {
      expect(entry.source_name).toBe(authors[index]);
    });
  });

  it("keeps ORCIDs with their own author across a mixed list", () => {
    const xml = record(
      `<Author ValidYN="Y"><LastName>First</LastName><ForeName>Ann</ForeName></Author>` +
        `<Author ValidYN="Y"><CollectiveName>The Study Group</CollectiveName></Author>` +
        `<Author ValidYN="Y"><LastName>Last</LastName><ForeName>Zed</ForeName>` +
        `<Identifier Source="ORCID">${VALID_ORCID}</Identifier></Author>`,
    );
    const provenance = extractPubMedAuthors(xml).author_provenance!;

    expect(provenance[0].orcid).toBeNull();
    expect(provenance[1].orcid).toBeNull();
    expect(provenance[2].orcid).toBe(VALID_ORCID);
  });
});
