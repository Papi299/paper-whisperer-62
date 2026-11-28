// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractPubMedAuthors } from "../pubmedAuthors";
import { VALID_ORCID } from "../../../../src/lib/__tests__/fixtures/orcidVectors";

/**
 * The text of PubMed author fields after CODEQL-EDGE-TEXT-EXTRACTION-001.
 *
 * `plainText` used to remove `<[^>]+>` and then run the sequential decoder.
 * It now removes markup with the shared lexer and decodes each reference once.
 * Everything else in the extractor — which elements are read, the personal vs
 * collective choice, the compatibility projection, alignment, and the
 * author-level vs affiliation-level identifier split — is unchanged, and the
 * existing `pubmedAuthors.test.ts` still pins it. Expected text is written by
 * hand.
 */

function record(authorsXml: string): string {
  return (
    "<PubmedArticle><MedlineCitation><Article>" +
    "<ArticleTitle>Fixture</ArticleTitle>" +
    `<AuthorList CompleteYN="Y">${authorsXml}</AuthorList>` +
    "</Article></MedlineCitation></PubmedArticle>"
  );
}

const collective = (name: string, extra = "") =>
  `<Author ValidYN="Y"><CollectiveName>${name}</CollectiveName>${extra}</Author>`;
const personal = (extra = "") =>
  `<Author ValidYN="Y"><LastName>Doe</LastName><ForeName>Jane</ForeName><Initials>J</Initials>${extra}</Author>`;
const affiliation = (text: string, ids = "") =>
  `<AffiliationInfo><Affiliation>${text}</Affiliation>${ids}</AffiliationInfo>`;

describe("collective author names", () => {
  it.each([
    ["entities", "Smith &amp; Jones Study Group", "Smith & Jones Study Group"],
    ["nested markup", "<b>ABC</b> <i>Trial</i> Group", "ABC Trial Group"],
    ["numeric references", "&#913;&#x392;&#915; Investigators", String.fromCodePoint(0x391, 0x392, 0x393) + " Investigators"],
    ["an escaped reference stays one level encoded", "The &amp;lt;Alpha&amp;gt; Consortium", "The &lt;Alpha&gt; Consortium"],
    ["escaped markup is text", "The &lt;b&gt;Bold&lt;/b&gt; Group", "The <b>Bold</b> Group"],
    ["CDATA", "<![CDATA[R&D <Alpha> Group]]>", "R&D <Alpha> Group"],
    ["a quoted > in an attribute", '<b class="x>y">ABC</b> Group', "ABC Group"],
    ["a stray <", "Group <1 study", "Group <1 study"],
    ["a reference to a non-character", "Group &#x110000; West", "Group &#x110000; West"],
    ["unknown references", "AT&amp;T &copy; Group", "AT&T &copy; Group"],
  ])("%s", (_name, source, text) => {
    const { authors, author_provenance } = extractPubMedAuthors(record(collective(source)));
    expect(authors).toEqual([text]);
    expect(author_provenance).toHaveLength(1);
    expect(author_provenance![0].kind).toBe("collective");
    expect(author_provenance![0].collective_name).toBe(text);
    expect(author_provenance![0].source_name).toBe(text);
  });

  // CODEQL-EDGE-TEXT-EXTRACTION-001B: the lexer now writes these references as
  // text or as `&amp;`. Decoded here, at the Edge, they read exactly as before.
  it.each([
    ["a hexadecimal & before a decimal reference", "Unit &#x26;#60;5 Group", "Unit &#60;5 Group"],
    ["a decimal & before amp", "R&#38;amp;D Group", "R&amp;D Group"],
    ["U+0000 and a lone surrogate", "Group &#0; and &#xD800;", "Group &#0; and &#xD800;"],
    ["surrogate pair references", "Group &#xD835;&#xDC00; West", "Group &#xD835;&#xDC00; West"],
    ["a pair across removed markup", "Group &#xD835;<i></i>&#xDC00; East", "Group &#xD835;&#xDC00; East"],
  ])("%s (decoded as before)", (_name, source, text) => {
    const { authors, author_provenance } = extractPubMedAuthors(record(collective(source)));
    expect(authors).toEqual([text]);
    expect(author_provenance![0].collective_name).toBe(text);
  });

  it("a collective name that is only markup still yields no author", () => {
    const { authors, author_provenance } = extractPubMedAuthors(record(collective("<i></i>") + personal()));
    expect(authors).toEqual(["Jane Doe"]);
    expect(author_provenance).toHaveLength(1);
  });
});

describe("affiliations", () => {
  it.each([
    ["nested markup and entities", "Dept of <i>Biology</i> &amp; <b>Chemistry</b>", "Dept of Biology & Chemistry"],
    ["a quoted > in an attribute", 'Dept <sup data-note="a>b">1</sup> of X', "Dept 1 of X"],
    ["CDATA", "<![CDATA[Lab A & B]]>", "Lab A & B"],
    ["a stray <", "Unit <3 and <tag attr=\"unterminated>rest", 'Unit <3 and <tag attr="unterminated>rest'],
    ["accented text", "Universit&#xE9; de Gen&#xE8;ve", "Universit" + String.fromCodePoint(0xe9) + " de Gen" + String.fromCodePoint(0xe8) + "ve"],
    ["an escaped reference", "Unit &#38;lt;5&#38;gt;", "Unit &lt;5&gt;"],
    ["a very long reference", `Lab &#x${"F".repeat(1000)}; West`, `Lab &#x${"F".repeat(1000)}; West`],
  ])("%s", (_name, source, text) => {
    const { author_provenance } = extractPubMedAuthors(record(personal(affiliation(source))));
    expect(author_provenance![0].affiliations).toEqual([text]);
  });

  it("an affiliation that is only markup is dropped, as an empty one always was", () => {
    const { author_provenance } = extractPubMedAuthors(record(personal(affiliation("<i> </i>"))));
    expect(author_provenance![0].affiliations).toEqual([]);
  });
});

describe("identifiers: the author's own, never the institution's", () => {
  it("reads an author-level identifier's text once", () => {
    const xml = record(personal(`<Identifier Source="Local">ID&amp;lt;7&amp;gt;</Identifier>`));
    expect(extractPubMedAuthors(xml).author_provenance![0].identifiers).toEqual([
      { scheme: "Local", value: "ID&lt;7&gt;" },
    ]);
  });

  it("keeps an identifier holding a reference to a non-character as text", () => {
    const xml = record(personal(`<Identifier Source="Local">X&#x110000;Y</Identifier>`));
    expect(extractPubMedAuthors(xml).author_provenance![0].identifiers).toEqual([
      { scheme: "Local", value: "X&#x110000;Y" },
    ]);
  });

  it("reads an ORCID written in CDATA, as XML defines it", () => {
    const xml = record(personal(`<Identifier Source="ORCID"><![CDATA[${VALID_ORCID}]]></Identifier>`));
    const entry = extractPubMedAuthors(xml).author_provenance![0];
    expect(entry.identifiers).toEqual([{ scheme: "ORCID", value: VALID_ORCID }]);
    expect(entry.orcid).toBe(VALID_ORCID);
  });

  it("still never promotes an affiliation's identifier, whatever its markup", () => {
    const xml = record(
      personal(
        affiliation(
          "Dept of <i>Biology</i> &amp; <![CDATA[Chemistry]]>",
          `<Identifier Source="ROR">https://ror.org/<i>00</i>&amp;x</Identifier>` +
            `<Identifier Source="ORCID">${VALID_ORCID}</Identifier>`,
        ),
      ),
    );
    const entry = extractPubMedAuthors(xml).author_provenance![0];
    expect(entry.affiliations).toEqual(["Dept of Biology & Chemistry"]);
    expect(entry.identifiers).toEqual([]);
    expect(entry.orcid).toBeNull();
  });
});

describe("the personal-name path is unchanged", () => {
  it("does not decode a personal name: the source representation is kept", () => {
    // Pre-existing and deliberate: given/family names are not decoded here.
    const xml = record(
      `<Author ValidYN="Y"><LastName>M&#252;ller</LastName><ForeName>Jos&amp;eacute;</ForeName></Author>`,
    );
    const { authors, author_provenance } = extractPubMedAuthors(xml);
    expect(authors).toEqual(["Jos&amp;eacute; M&#252;ller"]);
    expect(author_provenance![0].family_name).toBe("M&#252;ller");
    expect(author_provenance![0].given_name).toBe("Jos&amp;eacute;");
  });
});

describe("alignment with the authors projection", () => {
  it("keeps one provenance entry per emitted author, in source order", () => {
    const xml = record(
      collective("<![CDATA[R&D Group]]>") +
        `<Author ValidYN="Y"><LastName>Skipped</LastName></Author>` +
        personal(affiliation("Lab &#x110000;")) +
        collective("The &amp;lt;Alpha&amp;gt; Consortium") +
        collective("<i></i>") +
        `<Author ValidYN="Y"><LastName>Roe</LastName><ForeName>Alex</ForeName></Author>`,
    );
    const { authors, author_provenance } = extractPubMedAuthors(xml);
    expect(authors).toEqual(["R&D Group", "Jane Doe", "The &lt;Alpha&gt; Consortium", "Alex Roe"]);
    expect(author_provenance!.map((entry) => entry.kind)).toEqual(["collective", "personal", "collective", "personal"]);
    expect(author_provenance!.map((entry) => entry.source_name)).toEqual(authors);
    expect(author_provenance![1].affiliations).toEqual(["Lab &#x110000;"]);
  });

  it("does not throw on any reference, so a record's authors are never lost to one value", () => {
    const hostile = ["&#x110000;", "&#99999999999999999999;", `&#x${"F".repeat(1000)};`, "&#xD800;", "&#0;"];
    for (const reference of hostile) {
      const xml = record(
        collective(`G ${reference}`) + personal(affiliation(`A ${reference}`, "") + `<Identifier Source="Local">${reference}</Identifier>`),
      );
      expect(() => extractPubMedAuthors(xml)).not.toThrow();
      const { authors, author_provenance } = extractPubMedAuthors(xml);
      expect(authors).toEqual([`G ${reference}`, "Jane Doe"]);
      expect(author_provenance![1].identifiers).toEqual([{ scheme: "Local", value: reference }]);
    }
  });
});
