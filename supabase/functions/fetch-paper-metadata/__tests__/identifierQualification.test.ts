// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyPubMedDoiMatch, createFetchByDoi, type DoiLookupRecord } from "../doiLookup";
import { canonicalDoiUrl } from "../../_shared/identifierDetection";
import { extractPubMedArticleDoi } from "../../_shared/pubmedArticleIdentifiers";
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
 * read as before, but a nested reference now gives the DOI name the XML states,
 * and a reference that names no character is kept as written. These tests pin
 * what that means for the stored DOI, the resolver URL, matching a requested
 * DOI, provider attribution and the client's labels. Every DOI is under the
 * 10.5555 test prefix and unregistered; expected values are written by hand.
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
  it.each<[string, string, string, string, string]>([
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
    // References that name no character: kept as written, never thrown on.
    ["above U+10FFFF", "10.5555/q2b.oor&#x110000;", "10.5555/q2b.oor&#x110000;", "https://doi.org/10.5555/q2b.oor&%23x110000;", "10.5555/q2b.oor&#x110000;"],
    ["U+0000", "10.5555/q2b.nul&#0;", "10.5555/q2b.nul&#0;", "https://doi.org/10.5555/q2b.nul&%230;", "10.5555/q2b.nul&#0;"],
    ["a lone surrogate", "10.5555/q2b.lone&#xD800;", "10.5555/q2b.lone&#xD800;", "https://doi.org/10.5555/q2b.lone&%23xD800;", "10.5555/q2b.lone&#xd800;"],
    [
      "surrogate pair references",
      "10.5555/q2b.pair&#xD835;&#xDC00;",
      "10.5555/q2b.pair&#xD835;&#xDC00;",
      "https://doi.org/10.5555/q2b.pair&%23xD835;&%23xDC00;",
      "10.5555/q2b.pair&#xd835;&#xdc00;",
    ],
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
    ["surrogate pair references, an astral request", "10.5555/q2b.pair&#xD835;&#xDC00;", `10.5555/q2b.pair${C(0x1d400)}`, "mismatch"],
    ["an invalid reference in PubMed's DOI", "10.5555/q2b.oor&#x110000;", "10.5555/q2b.oor", "mismatch"],
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
function lookup(pubmed: Record<string, { pmid: string; xmlDoi: string }>, crossref: Record<string, string>) {
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
    logger: { log: () => {}, warn: () => {} },
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

  it("an escaped spelling is not decoded into a match", () => {
    const [attributed] = attributeToRequestedIdentifiers(["10.5555/q2b.n<1"], [{ identifier: "91000203", doi: "10.5555/q2b.n&lt;1", pmid: "91000203" }]);
    expect(attributed.identifier).toBe("91000203");
  });
});
