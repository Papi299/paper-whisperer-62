// @vitest-environment node
import { describe, expect, it } from "vitest";
import { crossrefAbstract, pubmedAbstract, pubmedArticleTitle } from "../metadataText";
import { extractPubMedAuthors } from "../../_shared/pubmedAuthors";
import { extractPubMedArticleDoi } from "../../_shared/pubmedArticleIdentifiers";
import { decodeHTMLEntities as edgeDecode } from "../../_shared/htmlEntities";
import { articleId, efetchDocument, pubmedArticle } from "../../_shared/__tests__/fixtures/pubmedEfetchXml";
import { normalizePaperData, type RawPaperData } from "../../../../src/lib/normalizePaperData";
import { normalizeAuthorProvenanceForStorage } from "../../../../src/lib/authorProvenance";

/**
 * The Edge-to-client boundary for metadata text
 * (PAPERLUME-CODEQL-EDGE-TEXT-EXTRACTION-001A).
 *
 * The Edge Function returns the PubMed title and abstract and the Crossref
 * abstract as escaped character data: a stray `&` or `<` and CDATA text come
 * back escaped, references come back as written. The client decodes them once.
 * Independent review found that the client's previous decoder broke that
 * contract twice: it decoded `Literal &amp;lt;` (CDATA `Literal &lt;`) to
 * `Literal <`, and on one reference above U+10FFFF it left the whole field
 * escaped, so `AT&T and p < 0.05` was stored as `AT&amp;T and p &lt; 0.05`.
 *
 * Every case runs the real Edge adapter and the real client normalization.
 * Expected text is written by hand.
 */

const C = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const CONFIG = { synonymLookup: {}, poolStudyTypes: [], poolKeywords: [], synonymGroups: [] };

function normalize(fields: Partial<RawPaperData>) {
  return normalizePaperData(
    {
      title: "T",
      authors: [],
      year: null,
      journal: null,
      pmid: null,
      doi: null,
      abstract: null,
      keywords: [],
      study_type: null,
      pubmed_url: null,
      journal_url: null,
      drive_url: null,
      ...fields,
    },
    CONFIG,
  );
}

const titleOf = (source: string) => pubmedArticleTitle(efetchDocument(pubmedArticle({ title: source })))!;
const abstractOf = (source: string) => pubmedAbstract(efetchDocument(pubmedArticle({ abstract: source })));

type Field = "PubMed title" | "PubMed abstract" | "Crossref abstract";

/** The Edge reading of one provider field, and what the client stores from it. */
function throughBoundary(field: Field, source: string): { edge: string | null; stored: string | null } {
  if (field === "PubMed title") {
    const edge = titleOf(source);
    return { edge, stored: normalize({ title: edge }).title };
  }
  const edge = field === "PubMed abstract" ? abstractOf(source) : crossrefAbstract(source);
  return { edge, stored: normalize({ abstract: edge }).abstract };
}

describe("the reviewed blocker, Examples A to D", () => {
  it.each<[string, Field, string, string, string]>([
    [
      "A: a stray & and < with an invalid reference",
      "PubMed title",
      "AT&T and p < 0.05; invalid &#x110000;",
      "AT&amp;T and p &lt; 0.05; invalid &#x110000;",
      "AT&T and p < 0.05; invalid &#x110000;",
    ],
    [
      "A, in an abstract",
      "PubMed abstract",
      "AT&T and p < 0.05; invalid &#x110000;",
      "AT&amp;T and p &lt; 0.05; invalid &#x110000;",
      "AT&T and p < 0.05; invalid &#x110000;",
    ],
    [
      "A, in a Crossref abstract",
      "Crossref abstract",
      "<jats:p>AT&T and p < 0.05; invalid &#x110000;</jats:p>",
      "AT&amp;T and p &lt; 0.05; invalid &#x110000;",
      "AT&T and p < 0.05; invalid &#x110000;",
    ],
    [
      "A, written as well-formed XML",
      "PubMed title",
      "AT&amp;T and p &lt; 0.05; invalid &#x110000;",
      "AT&amp;T and p &lt; 0.05; invalid &#x110000;",
      "AT&T and p < 0.05; invalid &#x110000;",
    ],
    ["B: CDATA text that looks like a reference", "PubMed title", "<![CDATA[Literal &lt;]]>", "Literal &amp;lt;", "Literal &lt;"],
    ["B, in an abstract", "PubMed abstract", "<![CDATA[Literal &lt;]]>", "Literal &amp;lt;", "Literal &lt;"],
    ["B, in a Crossref abstract", "Crossref abstract", "<jats:p><![CDATA[Literal &lt;]]></jats:p>", "Literal &amp;lt;", "Literal &lt;"],
    [
      "C: a malformed reference among valid ones",
      "PubMed title",
      "A &amp; B &#x110000; C &lt; D",
      "A &amp; B &#x110000; C &lt; D",
      "A & B &#x110000; C < D",
    ],
    [
      "C, in a Crossref abstract",
      "Crossref abstract",
      "<jats:p>A &amp; B &#x110000; C &lt; D</jats:p>",
      "A &amp; B &#x110000; C &lt; D",
      "A & B &#x110000; C < D",
    ],
    ["D: one decoding of &amp;lt;", "PubMed title", "Value &amp;lt; text", "Value &amp;lt; text", "Value &lt; text"],
  ])("%s (%s)", (_name, field, source, edge, stored) => {
    const result = throughBoundary(field, source);
    expect(result.edge).toBe(edge);
    expect(result.stored).toBe(stored);
  });
});

describe("CDATA text reaches storage exactly as the CDATA section holds it", () => {
  const contents = [
    "Literal &lt;",
    "&amp; &quot;q&quot; &apos;s &nbsp;",
    "&#60; &#x3C; &#x110000; &#0;",
    "a < b & c > d",
    "&amp;lt;",
    "&#xD835;&#xDC00;",
    "]] >",
  ];

  it.each(contents)("%s", (content) => {
    expect(throughBoundary("PubMed title", `Before <![CDATA[${content}]]> after`).stored).toBe(`Before ${content} after`);
    expect(throughBoundary("PubMed abstract", `<![CDATA[${content}]]>`).stored).toBe(content);
    expect(throughBoundary("Crossref abstract", `<jats:p><![CDATA[${content}]]></jats:p>`).stored).toBe(content);
  });
});

describe("valid and invalid references in one field", () => {
  it("decodes every valid reference and keeps every invalid one, in each adapter", () => {
    const source =
      "&#945; &#xD800; &#x3B2; &#0; &amp; &#99999999999999999999; &lt; &#x10FFFF; &#x110000; &alpha; &amp &#65 &#X41; " +
      "&#55349;&#56320; &#xDC00; &gt;";
    const stored =
      `${C(0x3b1)} &#xD800; ${C(0x3b2)} &#0; & &#99999999999999999999; < ${C(0x10ffff)} &#x110000; &alpha; &amp &#65 &#X41; ` +
      `${C(0x1d400)} &#xDC00; >`;
    expect(throughBoundary("PubMed title", source).stored).toBe(stored);
    expect(throughBoundary("PubMed abstract", source).stored).toBe(stored);
    expect(throughBoundary("Crossref abstract", `<jats:p>${source}</jats:p>`).stored).toBe(stored);
  });

  it("a structured abstract keeps each section's valid references when another section holds an invalid one", () => {
    const xml = efetchDocument(
      pubmedArticle({
        abstract: 'one &amp; &#x110000;</AbstractText><AbstractText Label="RESULTS" NlmCategory="RESULTS">p &lt; 0.05 &#xD800; &#177;',
      }),
    );
    expect(normalize({ abstract: pubmedAbstract(xml) }).abstract).toBe(`one & &#x110000; p < 0.05 &#xD800; ${C(0xb1)}`);
  });
});

describe("scientific text", () => {
  it.each<[string, Field, string, string]>([
    ["literal comparisons", "PubMed title", "Outcome at p > 0.05 and x >= 5", "Outcome at p > 0.05 and x >= 5"],
    ["stray < in comparisons", "PubMed abstract", "raw p < 0.05 and q > 0.1 with HbA<sub>1c</sub> &lt;7%", "raw p < 0.05 and q > 0.1 with HbA1c <7%"],
    [
      "numeric operators and units",
      "PubMed title",
      "CI &#8805; 0.9, n&#8201;=&#8201;12, 5&#xB1;2 &#x3BC;g",
      `CI ${C(0x2265)} 0.9, n${C(0x2009)}=${C(0x2009)}12, 5${C(0xb1)}2 ${C(0x3bc)}g`,
    ],
    [
      "a Crossref section",
      "Crossref abstract",
      "<jats:sec><jats:title>Results</jats:title><jats:p>p &lt; 0.05 and raw q < 0.1 &amp; r > 0.2</jats:p></jats:sec>",
      "Results p < 0.05 and raw q < 0.1 & r > 0.2",
    ],
    ["escaped markup stays text", "PubMed title", "Use &lt;b&gt;bold&lt;/b&gt; literally", "Use <b>bold</b> literally"],
  ])("%s", (_name, field, source, stored) => {
    expect(throughBoundary(field, source).stored).toBe(stored);
  });
});

describe("PubMed authors across the boundary", () => {
  const xml = efetchDocument(
    pubmedArticle({
      articleExtras:
        '<AuthorList CompleteYN="Y">' +
        '<Author ValidYN="Y"><LastName>M&#252;ller &amp; Co&#x110000;</LastName><ForeName>J&#xF6;rg</ForeName><Initials>J</Initials>' +
        '<Identifier Source="ORCID">0000-0002-1825-0097</Identifier>' +
        "<AffiliationInfo><Affiliation>Lab &amp; Unit</Affiliation></AffiliationInfo></Author>" +
        '<Author ValidYN="Y"><LastName>Ng &amp;lt;3&amp;gt;</LastName><ForeName>Li</ForeName><Initials>L</Initials></Author>' +
        '<Author ValidYN="Y"><CollectiveName>The &lt;Alpha&gt; Consortium</CollectiveName></Author>' +
        "</AuthorList>",
    }),
  );
  const { authors, author_provenance } = extractPubMedAuthors(xml);
  const provenanceSnapshot = JSON.stringify(author_provenance);
  const paper = normalize({ authors, author_provenance });

  it("a personal name leaves the Edge as written and the client decodes it once", () => {
    expect(authors.slice(0, 2)).toEqual(["J&#xF6;rg M&#252;ller &amp; Co&#x110000;", "Li Ng &amp;lt;3&amp;gt;"]);
    expect(paper.authors.slice(0, 2)).toEqual([`J${C(0xf6)}rg M${C(0xfc)}ller & Co&#x110000;`, "Li Ng &lt;3&gt;"]);
  });

  it("a collective name is decoded at the Edge, then again by the client (pre-existing, group Q3)", () => {
    expect(authors[2]).toBe("The <Alpha> Consortium");
    expect(paper.authors[2]).toBe("The <Alpha> Consortium");
  });

  it("keeps provenance kind, order, identifiers and affiliations exactly as the Edge stated them", () => {
    expect(author_provenance!.map((entry) => entry.kind)).toEqual(["personal", "personal", "collective"]);
    expect(author_provenance![0].identifiers).toEqual([{ scheme: "ORCID", value: "0000-0002-1825-0097" }]);
    expect(author_provenance![0].affiliations).toEqual(["Lab & Unit"]);
    expect(JSON.stringify(paper.author_provenance)).toBe(provenanceSnapshot);
    expect(normalizeAuthorProvenanceForStorage(paper.author_provenance, paper.authors)).toEqual(author_provenance);
  });
});

describe("the article DOI is decoded once, at the Edge, and never by the client", () => {
  it.each([
    ["a number sign", "10.1000/456#789", "10.1000/456#789"],
    ["an escaped ampersand", "10.5555/Q2A&amp;X", "10.5555/q2a&x"],
    ["a doubly escaped ampersand keeps one level", "10.5555/Q2A&amp;amp;X", "10.5555/q2a&amp;x"],
    ["an invalid reference", "10.5555/q2a&#x110000;", "10.5555/q2a&#x110000;"],
  ])("%s", (_name, source, stored) => {
    const doi = extractPubMedArticleDoi(efetchDocument(pubmedArticle({ ownIds: [articleId("doi", source)] })));
    expect(normalize({ doi }).doi).toBe(stored);
  });
});

describe("release order: a deployed Edge Function older than this change, with the corrected client", () => {
  // What `fetch-paper-metadata` at main 4c454769 returned for these provider
  // fields, recorded by running that handler on the same synthetic records.
  // Until the separately authorized Edge deployment, Production keeps
  // returning these representations to the corrected client.
  it.each<[string, string, string]>([
    [
      "named references",
      "Risk &amp; benefit of &quot;early&quot; care: the patient&apos;s view &lt;2024&gt;",
      `Risk & benefit of "early" care: the patient's view <2024>`,
    ],
    ["a stray & and < kept raw, with an invalid reference", "AT&T and p < 0.05; invalid &#x110000;", "AT&T and p < 0.05; invalid &#x110000;"],
    ["a malformed reference among valid ones", "A &amp; B &#x110000; C &lt; D", "A & B &#x110000; C < D"],
    ["one decoding of &amp;lt;", "&amp;lt;i&amp;gt; is escaped", "&lt;i&gt; is escaped"],
    [
      "surrogate pairs and lone halves",
      "Math &#55349;&#56320; and &#xD835;&#xDC01; bold, lone &#xD835; and &#xDC00; stay",
      `Math ${C(0x1d400)} and ${C(0x1d401)} bold, lone &#xD835; and &#xDC00; stay`,
    ],
    ["NUL and a lone surrogate", "NUL &#0; and surrogate &#xD800; in a title &amp; more", "NUL &#0; and surrogate &#xD800; in a title & more"],
  ])("title: %s", (_name, legacyEdge, stored) => {
    expect(normalize({ title: legacyEdge }).title).toBe(stored);
  });

  it("abstract, journal, personal author and keywords", () => {
    const paper = normalize({
      abstract: "bad &#x110000; ref and A &amp; B",
      journal: "Journal of R&amp;D &amp;lt;Reviews&amp;gt; &#x110000;",
      authors: ["J&#xF6;rg M&#252;ller &amp; Co&#x110000;", "Smith & Jones Study Group"],
      // Keywords the old Edge decoder had already decoded (and cascaded).
      keywords: ["R&D", "<tag>", `${C(0x1d400)} keyword`],
    });
    expect(paper.abstract).toBe("bad &#x110000; ref and A & B");
    expect(paper.journal).toBe("Journal of R&D &lt;Reviews&gt; &#x110000;");
    expect(paper.authors).toEqual([`J${C(0xf6)}rg M${C(0xfc)}ller & Co&#x110000;`, "Smith & Jones Study Group"]);
    expect(paper.keywords).toEqual(["R&D", "<tag>", `${C(0x1d400)} keyword`]);
  });
});

describe("the second decode of fields the Edge already decoded (pre-existing, group Q3)", () => {
  // Not removed by this revision: the Edge decodes keywords and collective
  // names once, and normalizePaperData decodes `keywords` and `authors` again.
  // `raw_keywords` and `author_provenance` keep the one Edge decoding.
  it("a keyword and a collective name holding an invalid reference", () => {
    const keyword = edgeDecode("&#x110000; &amp;lt;b&amp;gt;");
    expect(keyword).toBe("&#x110000; &lt;b&gt;");
    const { authors, author_provenance } = extractPubMedAuthors(
      "<AuthorList><Author><CollectiveName>Beta &#x110000; &amp;amp; Gamma Group</CollectiveName></Author></AuthorList>",
    );
    expect(author_provenance![0].collective_name).toBe("Beta &#x110000; &amp; Gamma Group");
    const paper = normalize({ keywords: [keyword], authors });
    expect(paper.keywords).toEqual(["&#x110000; <b>"]);
    expect(paper.authors).toEqual(["Beta &#x110000; & Gamma Group"]);
  });
});
