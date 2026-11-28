// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyPubMedDoiMatch, createFetchByDoi, type DoiLookupRecord } from "../doiLookup";
import { pubmedAbstract, pubmedArticleTitle } from "../metadataText";
import { canonicalDoiUrl } from "../../_shared/identifierDetection";
import { extractPubMedArticleDoi } from "../../_shared/pubmedArticleIdentifiers";
import { extractPubMedAuthors } from "../../_shared/pubmedAuthors";
import { articleId, efetchDocument, pubmedArticle, reference, referenceList } from "../../_shared/__tests__/fixtures/pubmedEfetchXml";
import { normalizePaperData } from "../../../../src/lib/normalizePaperData";
import { attributeToRequestedIdentifiers } from "../../../../src/lib/metadataAttribution";

/**
 * Publication identifiers after the Edge decoder change of
 * CODEQL-EDGE-TEXT-EXTRACTION-001, qualified in revision 001B.
 *
 * The article DOI is read by `pubmedArticleIdentifiers.ts` and decoded once at
 * the Edge (`htmlEntities.ts`): never by `xmlText.ts`, and never by the client,
 * which stores it lower-cased without decoding. The decoder used to run its
 * replacements in sequence and throw above U+10FFFF, so an ordinary DOI is
 * read as before, but a nested reference now gives the DOI name the XML states.
 * These tests pin what that means for the stored DOI, the resolver URL,
 * matching a requested DOI, provider attribution and the client's labels.
 *
 * Revision 001C: a DOI whose XML holds a reference that names no character is
 * malformed and is not the article's DOI. Kept as written, as 001B left it, it
 * read exactly like the well-formed `&amp;` spelling of a different DOI name,
 * so a PubMed record could answer a request for a DOI it does not state. The
 * record keeps its PMID and every other field.
 *
 * Every DOI is under the 10.5555 test prefix and unregistered; expected values
 * are written by hand.
 */

const C = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const CONFIG = { synonymLookup: {}, poolStudyTypes: [], poolKeywords: [], synonymGroups: [] };

const ownDoi = (...values: string[]) =>
  extractPubMedArticleDoi(efetchDocument(pubmedArticle({ ownIds: values.map((value) => articleId("doi", value)) })));

const storedDoi = (doi: string | null) =>
  normalizePaperData(
    {
      title: "T",
      authors: [],
      year: null,
      journal: null,
      pmid: null,
      doi,
      abstract: null,
      keywords: [],
      study_type: null,
      pubmed_url: null,
      journal_url: null,
      drive_url: null,
    },
    CONFIG,
  ).doi;

describe("the article's own DOI, its resolver URL and what the client stores", () => {
  it.each<[string, string, string | null, string | null, string | null]>([
    // Ordinary values: read exactly as before the decoder change.
    ["a plain DOI", "10.5555/q2b.ordinary", "10.5555/q2b.ordinary", "https://doi.org/10.5555/q2b.ordinary", "10.5555/q2b.ordinary"],
    ["an escaped ampersand", "10.5555/q2b.a&amp;b", "10.5555/q2b.a&b", "https://doi.org/10.5555/q2b.a&b", "10.5555/q2b.a&b"],
    ["numeric references", "10.5555/q2b.num&#35;&#x3C;5&#62;", "10.5555/q2b.num#<5>", "https://doi.org/10.5555/q2b.num%23%3C5%3E", "10.5555/q2b.num#<5>"],
    ["an astral reference", "10.5555/q2b.astral&#x1D400;", `10.5555/q2b.astral${C(0x1d400)}`, "https://doi.org/10.5555/q2b.astral%F0%9D%90%80", `10.5555/q2b.astral${C(0x1d400)}`],
    ["# and ? in the suffix", "10.5555/q2b#frag?x=1;y", "10.5555/q2b#frag?x=1;y", "https://doi.org/10.5555/q2b%23frag%3Fx=1;y", "10.5555/q2b#frag?x=1;y"],
    [
      "SICI-style < and >",
      "10.5555/(SICI)q2b:4&lt;521::AID&gt;3.0.CO;2-H",
      "10.5555/(SICI)q2b:4<521::AID>3.0.CO;2-H",
      "https://doi.org/10.5555/(SICI)q2b:4%3C521::AID%3E3.0.CO;2-H",
      "10.5555/(sici)q2b:4<521::aid>3.0.co;2-h",
    ],
    // Nested references: the DOI name the XML states, no longer cascaded to `<`.
    ["&amp;lt;", "10.5555/q2b.n&amp;lt;1", "10.5555/q2b.n&lt;1", "https://doi.org/10.5555/q2b.n&lt;1", "10.5555/q2b.n&lt;1"],
    ["&#38;lt;", "10.5555/q2b.n&#38;lt;2", "10.5555/q2b.n&lt;2", "https://doi.org/10.5555/q2b.n&lt;2", "10.5555/q2b.n&lt;2"],
    ["&#x26;#60;", "10.5555/q2b.n&#x26;#60;3", "10.5555/q2b.n&#60;3", "https://doi.org/10.5555/q2b.n&%2360;3", "10.5555/q2b.n&#60;3"],
    ["&amp;amp;", "10.5555/q2b.n&amp;amp;4", "10.5555/q2b.n&amp;4", "https://doi.org/10.5555/q2b.n&amp;4", "10.5555/q2b.n&amp;4"],
    // References that name no character: never thrown on, and since 001C the
    // DOI is malformed, so there is no DOI, no resolver URL and nothing stored.
    ["above U+10FFFF", "10.5555/q2b.oor&#x110000;", null, null, null],
    ["U+0000", "10.5555/q2b.nul&#0;", null, null, null],
    ["a lone surrogate", "10.5555/q2b.lone&#xD800;", null, null, null],
    ["surrogate pair references", "10.5555/q2b.pair&#xD835;&#xDC00;", null, null, null],
    // The same text, written well formed: a literal DOI name, kept.
    [
      "the literal text &#x110000;",
      "10.5555/q2b.lit&amp;#x110000;",
      "10.5555/q2b.lit&#x110000;",
      "https://doi.org/10.5555/q2b.lit&%23x110000;",
      "10.5555/q2b.lit&#x110000;",
    ],
    ["the literal text &#0;", "10.5555/q2b.litnul&#38;#0;", "10.5555/q2b.litnul&#0;", "https://doi.org/10.5555/q2b.litnul&%230;", "10.5555/q2b.litnul&#0;"],
  ])("%s", (_name, xmlValue, doi, url, stored) => {
    const own = ownDoi(xmlValue);
    expect(own).toBe(doi);
    expect(canonicalDoiUrl(own)).toBe(url);
    expect(storedDoi(own)).toBe(stored);
  });

  it("several own DOIs: the first of equivalent spellings, otherwise none", () => {
    expect(ownDoi("10.5555/Q2B.EQ", "10.5555/q2b.eq")).toBe("10.5555/Q2B.EQ");
    // Equivalent only through the previous decoder's cascade: now two DOI names.
    expect(ownDoi("10.5555/q2b.c&amp;lt;6", "10.5555/q2b.c&lt;6")).toBeNull();
    expect(ownDoi("10.5555/q2b.one", "10.5555/q2b.two")).toBeNull();
    // 001C: one malformed entry leaves no own DOI, rather than a choice.
    expect(ownDoi("10.5555/q2b.eq", "10.5555/q2b.eq&#x110000;")).toBeNull();
  });

  it("a cited work's DOI is never the article's", () => {
    const xml = efetchDocument(
      pubmedArticle({ referenceLists: [referenceList(reference("Cited.", [articleId("doi", "10.5555/q2b.cited")]))] }),
    );
    expect(extractPubMedArticleDoi(xml)).toBeNull();
  });
});

describe("matching the requested DOI", () => {
  it.each<[string, string, string, string]>([
    ["the same DOI", "10.5555/q2b.ordinary", "10.5555/q2b.ordinary", "match"],
    ["ASCII case only", "10.5555/q2b.ordinary", "10.5555/Q2B.ORDINARY", "match"],
    ["PubMed writes &amp;lt;, the request has <", "10.5555/q2b.n&amp;lt;1", "10.5555/q2b.n<1", "mismatch"],
    ["PubMed writes &amp;lt;, the request has &lt;", "10.5555/q2b.n&amp;lt;1", "10.5555/q2b.n&lt;1", "match"],
    ["PubMed writes &lt;, the request has <", "10.5555/q2b.n&lt;1", "10.5555/q2b.n<1", "match"],
    ["surrogate pair references, an astral request", "10.5555/q2b.pair&#xD835;&#xDC00;", `10.5555/q2b.pair${C(0x1d400)}`, "missing"],
    ["an invalid reference in PubMed's DOI", "10.5555/q2b.oor&#x110000;", "10.5555/q2b.oor", "missing"],
    // 001C, the collision: before, the malformed XML gave exactly the requested text, a match.
    ["PubMed's XML is malformed, the request is the text it decodes to", "10.5555/q2b.lit&#x110000;", "10.5555/q2b.lit&#x110000;", "missing"],
    ["PubMed's XML writes that text well formed", "10.5555/q2b.lit&amp;#x110000;", "10.5555/q2b.lit&#x110000;", "match"],
    ["the same, in another case", "10.5555/q2b.lit&amp;#x110000;", "10.5555/Q2B.LIT&#x110000;", "match"],
  ])("%s", (_name, xmlValue, requested, match) => {
    expect(classifyPubMedDoiMatch(ownDoi(xmlValue), requested)).toBe(match);
  });

  it("no own DOI is missing, whatever the references cite", () => {
    expect(classifyPubMedDoiMatch(ownDoi(), "10.5555/q2b.cited")).toBe("missing");
  });
});

interface Fetched extends DoiLookupRecord {
  identifier: string;
  source: "pubmed" | "crossref";
}

/** The DOI lookup over scripted providers; PubMed records go through the real DOI extractor. */
function lookup(pubmed: Record<string, { pmid: string; xmlDoi: string }>, crossref: Record<string, string>, warnings: string[] = []) {
  return createFetchByDoi<Fetched>({
    searchPubMedByDoi: async (doi) => pubmed[doi]?.pmid ?? null,
    fetchFromPubMed: async (pmid) => {
      const entry = Object.values(pubmed).find((candidate) => candidate.pmid === pmid);
      if (!entry) return null;
      const doi = ownDoi(entry.xmlDoi);
      return { identifier: pmid, source: "pubmed", pmid, doi, keywords: ["PubMed keyword"], pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` };
    },
    fetchFromCrossrefByDoi: async (doi) =>
      crossref[doi] === undefined ? null : { identifier: doi, source: "crossref", doi: crossref[doi], pmid: null, keywords: [] },
    logger: { log: () => {}, warn: (message) => warnings.push(message) },
  });
}

describe("which provider answers a DOI request", () => {
  it("a PubMed record that names the requested DOI answers it", async () => {
    const result = await lookup({ "10.5555/q2b.ordinary": { pmid: "91000201", xmlDoi: "10.5555/q2b.ordinary" } }, {})("10.5555/q2b.ordinary");
    expect(result).toMatchObject({ source: "pubmed", pmid: "91000201", doi: "10.5555/q2b.ordinary" });
  });

  it("a PubMed record whose XML writes the DOI doubly escaped no longer answers for the unescaped DOI", async () => {
    const result = await lookup(
      { "10.5555/q2b.n<1": { pmid: "91000203", xmlDoi: "10.5555/q2b.n&amp;lt;1" } },
      { "10.5555/q2b.n<1": "10.5555/q2b.n<1" },
    )("10.5555/q2b.n<1");
    // Crossref's record, without the PubMed PMID or keywords: PubMed's own
    // DOI is now `10.5555/q2b.n&lt;1`, which does not name the request.
    expect(result).toMatchObject({ source: "crossref", doi: "10.5555/q2b.n<1", pmid: null, keywords: [] });
  });

  it("the same record answers a request for the spelling it states", async () => {
    const result = await lookup({ "10.5555/q2b.n&lt;1": { pmid: "91000203", xmlDoi: "10.5555/q2b.n&amp;lt;1" } }, {})("10.5555/q2b.n&lt;1");
    expect(result).toMatchObject({ source: "pubmed", pmid: "91000203", doi: "10.5555/q2b.n&lt;1" });
  });

  it("a PubMed record whose DOI holds an invalid reference never answers; Crossref does", async () => {
    const result = await lookup(
      { "10.5555/q2b.oor": { pmid: "91000208", xmlDoi: "10.5555/q2b.oor&#x110000;" } },
      { "10.5555/q2b.oor": "10.5555/q2b.oor" },
    )("10.5555/q2b.oor");
    expect(result).toMatchObject({ source: "crossref", doi: "10.5555/q2b.oor", pmid: null });
  });

  const LITERAL = "10.5555/q2c.lit&#x110000;";

  it("001C: a malformed PubMed DOI never answers for the literal DOI it decodes to", async () => {
    const warnings: string[] = [];
    const result = await lookup({ [LITERAL]: { pmid: "91000231", xmlDoi: LITERAL } }, { [LITERAL]: LITERAL }, warnings)(LITERAL);
    // Before 001C this was PubMed's record 91000231, accepted as a match.
    expect(result).toMatchObject({ source: "crossref", identifier: LITERAL, doi: LITERAL, pmid: null, keywords: [] });
    expect(warnings).toEqual([
      "fetch-paper-metadata doi_pubmed_match=missing stage=direct",
      "fetch-paper-metadata doi_pubmed_match=missing stage=enrichment",
    ]);
  });

  it("001C: without a Crossref record the request finds nothing, not the malformed record", async () => {
    expect(await lookup({ [LITERAL]: { pmid: "91000231", xmlDoi: LITERAL } }, {})(LITERAL)).toBeNull();
  });

  it("001C: a PubMed record whose well-formed XML states the literal DOI answers it", async () => {
    const result = await lookup({ [LITERAL]: { pmid: "91000232", xmlDoi: "10.5555/q2c.lit&amp;#x110000;" } }, {})(LITERAL);
    expect(result).toMatchObject({ source: "pubmed", pmid: "91000232", doi: LITERAL, keywords: ["PubMed keyword"] });
  });

  it("001C: a malformed PubMed DOI never enriches the Crossref record; a well-formed one does", async () => {
    const requested = "10.5555/Q2C.LIT&#x110000;";
    const malformed = await lookup({ [LITERAL]: { pmid: "91000233", xmlDoi: LITERAL } }, { [requested]: LITERAL })(requested);
    expect(malformed).toMatchObject({ source: "crossref", doi: LITERAL, pmid: null, keywords: [] });
    const wellFormed = await lookup(
      { [LITERAL]: { pmid: "91000234", xmlDoi: "10.5555/q2c.lit&amp;#x110000;" } },
      { [requested]: LITERAL },
    )(requested);
    expect(wellFormed).toMatchObject({ source: "crossref", doi: LITERAL, pmid: "91000234", keywords: ["PubMed keyword"] });
  });
});

describe("a malformed DOI is rejected, not the paper (001C)", () => {
  // `index.ts` cannot run under Vitest. It builds a PubMed record from these
  // readers, sets `journal_url` to `canonicalDoiUrl(doi)`, and drops the record
  // only when it has no title. The handler itself ran on records like these in
  // the 001C Node and Edge-runtime harnesses.
  const fields = (doiXml: string) => {
    const xml = efetchDocument(
      pubmedArticle({
        pmid: "91000230",
        title: "A paper whose DOI is malformed",
        abstract: "Results &amp; methods.",
        articleExtras: '<AuthorList><Author ValidYN="Y"><LastName>Lane</LastName><ForeName>Pat</ForeName></Author></AuthorList>',
        ownIds: [articleId("doi", doiXml)],
      }),
    );
    const doi = extractPubMedArticleDoi(xml);
    return { doi, journalUrl: canonicalDoiUrl(doi), title: pubmedArticleTitle(xml), abstract: pubmedAbstract(xml), authors: extractPubMedAuthors(xml) };
  };

  it("keeps every other field exactly as with a well-formed DOI", () => {
    const malformed = fields("10.5555/q2c.lit&#x110000;");
    const wellFormed = fields("10.5555/q2c.lit&amp;#x110000;");
    expect([malformed.doi, malformed.journalUrl]).toEqual([null, null]);
    expect([wellFormed.doi, wellFormed.journalUrl]).toEqual(["10.5555/q2c.lit&#x110000;", "https://doi.org/10.5555/q2c.lit&%23x110000;"]);
    expect(malformed.title).toBe("A paper whose DOI is malformed");
    expect(malformed.authors.authors).toHaveLength(1);
    expect({ title: malformed.title, abstract: malformed.abstract, authors: malformed.authors }).toEqual({
      title: wellFormed.title,
      abstract: wellFormed.abstract,
      authors: wellFormed.authors,
    });
  });

  it("the client stores the paper under its PMID and labels it by the PMID requested", () => {
    const paper = normalizePaperData(
      {
        title: "A paper whose DOI is malformed",
        authors: [],
        year: null,
        journal: null,
        pmid: "91000230",
        doi: null,
        abstract: null,
        keywords: [],
        study_type: null,
        pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/91000230/",
        journal_url: null,
        drive_url: null,
      },
      CONFIG,
    );
    expect([paper.pmid, paper.doi, paper.journal_url]).toEqual(["91000230", null, null]);
    const [attributed] = attributeToRequestedIdentifiers(["91000230"], [{ identifier: "91000230", doi: null, pmid: "91000230" }]);
    expect(attributed.identifier).toBe("91000230");
  });
});

describe("the client labels a result by what it states, never by decoding its DOI", () => {
  it("a Crossref answer keeps the requested DOI as its label", () => {
    const [attributed] = attributeToRequestedIdentifiers(["10.5555/q2b.n<1"], [{ identifier: "10.5555/q2b.n<1", doi: "10.5555/q2b.n<1", pmid: null }]);
    expect(attributed.identifier).toBe("10.5555/q2b.n<1");
  });

  it("a PubMed answer labelled by its PMID is matched to the request by DOI equivalence", () => {
    const [attributed] = attributeToRequestedIdentifiers(["10.5555/Q2B.ORDINARY"], [{ identifier: "91000201", doi: "10.5555/q2b.ordinary", pmid: "91000201" }]);
    expect(attributed.identifier).toBe("10.5555/Q2B.ORDINARY");
  });

  it("001C: a Crossref answer for the literal DOI keeps the requested DOI as its label", () => {
    const literal = "10.5555/q2c.lit&#x110000;";
    const [attributed] = attributeToRequestedIdentifiers([literal], [{ identifier: literal, doi: literal, pmid: null }]);
    expect(attributed.identifier).toBe(literal);
  });

  it("an escaped spelling is not decoded into a match", () => {
    const [attributed] = attributeToRequestedIdentifiers(["10.5555/q2b.n<1"], [{ identifier: "91000203", doi: "10.5555/q2b.n&lt;1", pmid: "91000203" }]);
    expect(attributed.identifier).toBe("91000203");
  });
});
