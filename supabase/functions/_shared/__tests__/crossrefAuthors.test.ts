import { describe, it, expect } from "vitest";
import { extractCrossrefAuthors } from "../crossrefAuthors";
import {
  INVALID_CHECKSUM_ORCID,
  VALID_ORCID,
} from "../../../../src/lib/__tests__/fixtures/orcidVectors";

/**
 * Crossref contributor extraction, against deterministic fixtures shaped like
 * the REST API's documented contributor object (given, family, suffix, ORCID,
 * authenticated-orcid, affiliation[]). Crossref is never called from CI.
 */

/** Crossref states its ORCIDs as URIs, historically over plain http. */
const ORCID_URI = `http://orcid.org/${VALID_ORCID}`;

describe("extractCrossrefAuthors — the compatibility projection", () => {
  it("joins given and family exactly as before, in order", () => {
    const { authors } = extractCrossrefAuthors({
      author: [
        { given: "Ada", family: "Lovelace" },
        { given: "Charles", family: "Babbage" },
      ],
    });
    expect(authors).toEqual(["Ada Lovelace", "Charles Babbage"]);
  });

  it("handles a contributor with only a family name", () => {
    const { authors, author_provenance } = extractCrossrefAuthors({
      author: [{ family: "Lovelace" }],
    });
    expect(authors).toEqual(["Lovelace"]);
    expect(author_provenance![0].given_name).toBeNull();
    expect(author_provenance![0].family_name).toBe("Lovelace");
  });

  it("returns null provenance when there is no author array at all", () => {
    const { authors, author_provenance } = extractCrossrefAuthors({});
    expect(authors).toEqual([]);
    expect(author_provenance).toBeNull();
  });
});

describe("extractCrossrefAuthors — partial contributors cannot shift alignment", () => {
  it("drops a nameless contributor from BOTH arrays", () => {
    // The pre-existing projection already filtered the empty string this
    // produces. Provenance must drop the same entry, or every later ORCID
    // would land on the wrong person.
    const { authors, author_provenance } = extractCrossrefAuthors({
      author: [
        { given: "Ada", family: "Lovelace" },
        { ORCID: ORCID_URI }, // no usable name — an organisational `name` entry
        { given: "Charles", family: "Babbage" },
      ],
    });

    expect(authors).toEqual(["Ada Lovelace", "Charles Babbage"]);
    expect(author_provenance).toHaveLength(2);
    expect(author_provenance![0].source_name).toBe("Ada Lovelace");
    expect(author_provenance![1].source_name).toBe("Charles Babbage");
    // Critically, the skipped contributor's ORCID went nowhere.
    expect(author_provenance!.every((entry) => entry.orcid === null)).toBe(true);
  });

  it("stays aligned when only some contributors have ORCIDs or affiliations", () => {
    const { authors, author_provenance } = extractCrossrefAuthors({
      author: [
        { given: "Ada", family: "Lovelace" },
        { given: "Charles", family: "Babbage", ORCID: ORCID_URI },
        { given: "Grace", family: "Hopper", affiliation: [{ name: "US Navy" }] },
      ],
    });

    expect(authors).toHaveLength(3);
    expect(author_provenance).toHaveLength(3);
    author_provenance!.forEach((entry, index) => {
      expect(entry.source_name).toBe(authors[index]);
    });
    expect(author_provenance![0].orcid).toBeNull();
    expect(author_provenance![1].orcid).toBe(VALID_ORCID);
    expect(author_provenance![2].orcid).toBeNull();
    expect(author_provenance![2].affiliations).toEqual(["US Navy"]);
  });

  it("ignores a null or non-object entry without shifting the rest", () => {
    const { authors, author_provenance } = extractCrossrefAuthors({
      author: [null, { given: "Ada", family: "Lovelace" }, "nonsense"],
    });
    expect(authors).toEqual(["Ada Lovelace"]);
    expect(author_provenance).toHaveLength(1);
  });
});

describe("extractCrossrefAuthors — structured fields", () => {
  it("records the documented personal fields and nothing else", () => {
    const entry = extractCrossrefAuthors({
      author: [{ given: "Ada", family: "Lovelace", suffix: "III" }],
    }).author_provenance![0];

    expect(entry.source).toBe("crossref_api");
    expect(entry.source_field).toBe("author");
    expect(entry.kind).toBe("personal");
    expect(entry.given_name).toBe("Ada");
    expect(entry.family_name).toBe("Lovelace");
    expect(entry.suffix).toBe("III");
    // Crossref has no initials field, so none is derived from `given`.
    expect(entry.initials).toBeNull();
    expect(entry.collective_name).toBeNull();
  });

  it("keeps affiliation names in order and ignores affiliation identifiers", () => {
    // ROR/ISNI ids on an affiliation identify the *institution*, not the
    // author; promoting one would manufacture identity evidence.
    const entry = extractCrossrefAuthors({
      author: [
        {
          given: "Ada",
          family: "Lovelace",
          affiliation: [
            { name: "First Institute", id: [{ id: "https://ror.org/abc", "id-type": "ROR" }] },
            { name: "Second Institute" },
            { id: [{ id: "https://ror.org/def" }] },
          ],
        },
      ],
    }).author_provenance![0];

    expect(entry.affiliations).toEqual(["First Institute", "Second Institute"]);
    expect(entry.identifiers).toEqual([]);
  });

  it("does not invent middle names or reorder the source string", () => {
    const entry = extractCrossrefAuthors({
      author: [{ given: "A.", family: "Lovelace" }],
    }).author_provenance![0];

    expect(entry.source_name).toBe("A. Lovelace");
    expect(entry.given_name).toBe("A.");
  });
});

describe("extractCrossrefAuthors — ORCID and its assertion flag", () => {
  it("keeps the raw URI as provenance and derives the canonical iD", () => {
    const entry = extractCrossrefAuthors({
      author: [{ given: "Ada", family: "Lovelace", ORCID: ORCID_URI }],
    }).author_provenance![0];

    expect(entry.identifiers).toEqual([{ scheme: "ORCID", value: ORCID_URI }]);
    expect(entry.orcid).toBe(VALID_ORCID);
  });

  it("preserves a provider assertion boolean when it is actually supplied", () => {
    const entry = extractCrossrefAuthors({
      author: [
        { given: "Ada", family: "Lovelace", ORCID: ORCID_URI, "authenticated-orcid": true },
      ],
    }).author_provenance![0];

    expect(entry.orcid).toBe(VALID_ORCID);
    expect(entry.orcid_authenticated).toBe(true);
  });

  it("preserves an explicit false, distinguishing it from absence", () => {
    const entry = extractCrossrefAuthors({
      author: [
        { given: "Ada", family: "Lovelace", ORCID: ORCID_URI, "authenticated-orcid": false },
      ],
    }).author_provenance![0];

    expect(entry.orcid_authenticated).toBe(false);
  });

  it("reports null when the provider supplies no assertion flag", () => {
    const entry = extractCrossrefAuthors({
      author: [{ given: "Ada", family: "Lovelace", ORCID: ORCID_URI }],
    }).author_provenance![0];

    expect(entry.orcid_authenticated).toBeNull();
  });

  it("never synthesizes true from a stringy provider value", () => {
    const entry = extractCrossrefAuthors({
      author: [
        { given: "Ada", family: "Lovelace", ORCID: ORCID_URI, "authenticated-orcid": "true" },
      ],
    }).author_provenance![0];

    expect(entry.orcid_authenticated).toBeNull();
  });

  it("drops an assertion flag when no ORCID could be derived", () => {
    // An assertion qualifies an ORCID; with none derived there is nothing for
    // it to assert, and reporting it would describe an authentication of
    // nothing.
    const entry = extractCrossrefAuthors({
      author: [
        {
          given: "Ada",
          family: "Lovelace",
          ORCID: INVALID_CHECKSUM_ORCID,
          "authenticated-orcid": true,
        },
      ],
    }).author_provenance![0];

    expect(entry.orcid).toBeNull();
    expect(entry.orcid_authenticated).toBeNull();
    // ...while the raw value survives for diagnosis.
    expect(entry.identifiers).toEqual([
      { scheme: "ORCID", value: INVALID_CHECKSUM_ORCID },
    ]);
  });

  it("reports no identifiers when the contributor has no ORCID", () => {
    const entry = extractCrossrefAuthors({
      author: [{ given: "Ada", family: "Lovelace" }],
    }).author_provenance![0];

    expect(entry.identifiers).toEqual([]);
    expect(entry.orcid).toBeNull();
  });

  it("does not link two contributors that share an ORCID", () => {
    // Provenance, not identity: the same iD on two mentions stays two
    // independent statements with no relationship recorded between them.
    const provenance = extractCrossrefAuthors({
      author: [
        { given: "Ada", family: "Lovelace", ORCID: ORCID_URI },
        { given: "A.", family: "Lovelace", ORCID: ORCID_URI },
      ],
    }).author_provenance!;

    expect(provenance).toHaveLength(2);
    expect(provenance[0].orcid).toBe(VALID_ORCID);
    expect(provenance[1].orcid).toBe(VALID_ORCID);
    expect(provenance[0].source_name).not.toBe(provenance[1].source_name);
  });
});
