// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { crossrefAbstract, JATS_BLOCK_ELEMENTS, pubmedAbstract, pubmedArticleTitle } from "../metadataText";
import { extractPubMedAuthors } from "../../_shared/pubmedAuthors";
import { decodeHTMLEntities } from "../../_shared/htmlEntities";
import { normalizePaperData } from "../../../../src/lib/normalizePaperData";

/**
 * The title and abstract readings `fetch-paper-metadata` returns
 * (CODEQL-EDGE-TEXT-EXTRACTION-001), on whole provider documents, and what the
 * client makes of them.
 *
 * These functions return escaped character data — markup removed, references
 * as written — because the client's `normalizePaperData` decodes the title and
 * abstract once. The last part of this file runs that client normalization on
 * their output, so a change on either side of the boundary that decodes twice,
 * or not at all, fails here. Expected text is written by hand.
 */

const C = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

/** A PubMed EFetch document in the DTD's element order. */
function efetch(title: string, abstractXml?: string): string {
  return [
    '<?xml version="1.0" ?>',
    '<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">',
    "<PubmedArticleSet>",
    "<PubmedArticle>",
    '  <MedlineCitation Status="MEDLINE" Owner="NLM">',
    '    <PMID Version="1">11111111</PMID>',
    '    <Article PubModel="Print">',
    "      <Journal><Title>Journal of Fixtures</Title></Journal>",
    `      <ArticleTitle>${title}</ArticleTitle>`,
    "      <Pagination><MedlinePgn>1-10</MedlinePgn></Pagination>",
    ...(abstractXml === undefined ? [] : [`      <Abstract>${abstractXml}</Abstract>`]),
    "      <Language>eng</Language>",
    "    </Article>",
    "  </MedlineCitation>",
    "</PubmedArticle>",
    "</PubmedArticleSet>",
  ].join("\n");
}

const section = (label: string, text: string) =>
  `<AbstractText Label="${label}" NlmCategory="${label}">${text}</AbstractText>`;

describe("PubMed ArticleTitle", () => {
  it.each([
    ["an ordinary title", "A synthetic article on dose response.", "A synthetic article on dose response."],
    ["references stay as written", "Risk &amp; benefit &#x2265; 65 years &lt;2024&gt;", "Risk &amp; benefit &#x2265; 65 years &lt;2024&gt;"],
    ["inline markup", "Growth of <i>E. coli</i> in CO<sub>2</sub>-rich <b><i>media</i></b>", "Growth of E. coli in CO2-rich media"],
    [
      "MathML with a quoted > in an attribute",
      'Values of <mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML" alttext="x > 1"><mml:mi>x</mml:mi><mml:mo>&gt;</mml:mo><mml:mn>1</mml:mn></mml:math> only',
      "Values of x&gt;1 only",
    ],
    ["CDATA", "<![CDATA[p < 0.05 & q > 0.1]]> in trials", "p &lt; 0.05 &amp; q &gt; 0.1 in trials"],
    ["a comment and a processing instruction", "Before<!-- a > b --> after<?pi x > y?> end", "Before after end"],
    ["stray angle brackets", "Dose <5 mg vs >10 mg and a <b and c> d", "Dose &lt;5 mg vs >10 mg and a &lt;b and c> d"],
    ["escaped markup", "Use &lt;b&gt;bold&lt;/b&gt;", "Use &lt;b&gt;bold&lt;/b&gt;"],
    ["a translated title, untrimmed", " [Titre traduit]. ", " [Titre traduit]. "],
  ])("%s", (_name, source, expected) => {
    expect(pubmedArticleTitle(efetch(source))).toBe(expected);
  });

  it("reads only the first ArticleTitle", () => {
    const xml = efetch("First") + "<ArticleTitle>Second</ArticleTitle>";
    expect(pubmedArticleTitle(xml)).toBe("First");
  });

  it("is undefined without an ArticleTitle, and empty when it holds only markup", () => {
    expect(pubmedArticleTitle("<PubmedArticleSet></PubmedArticleSet>")).toBeUndefined();
    expect(pubmedArticleTitle(efetch("<i></i>"))).toBe("");
  });

  it("does not see an ArticleTitle inside a comment", () => {
    const xml = efetch("Real").replace("<PubmedArticleSet>", "<PubmedArticleSet><!-- <ArticleTitle>Fake</ArticleTitle> -->");
    expect(pubmedArticleTitle(xml)).toBe("Real");
  });
});

describe("PubMed AbstractText", () => {
  it("joins a structured abstract's sections with one space, without labels", () => {
    const xml = efetch(
      "T",
      [
        section("BACKGROUND", "Drug X &amp; placebo were compared."),
        section("METHODS", "Adults (n = 120) received 5&#x2009;mg."),
        section("RESULTS", "HbA<sub>1c</sub> fell (p &lt; 0.01; 95% CI 0.2 to 0.6)."),
        section("CONCLUSIONS", "Drug X is <b>effective</b>."),
      ].join("\n        "),
    );
    expect(pubmedAbstract(xml)).toBe(
      "Drug X &amp; placebo were compared. Adults (n = 120) received 5&#x2009;mg. " +
        "HbA1c fell (p &lt; 0.01; 95% CI 0.2 to 0.6). Drug X is effective.",
    );
  });

  it("reads a section whose label holds a quoted >", () => {
    const xml = efetch(
      "T",
      '<AbstractText Label="P > 0.05" NlmCategory="RESULTS">Significant.</AbstractText>' + section("CONCLUSIONS", "Done."),
    );
    expect(pubmedAbstract(xml)).toBe("Significant. Done.");
  });

  it("keeps each section's white space as written", () => {
    const xml = efetch("T", "<AbstractText> leading and trailing </AbstractText><AbstractText>\nnext</AbstractText>");
    expect(pubmedAbstract(xml)).toBe(" leading and trailing  \nnext");
  });

  it("an empty-element section contributes nothing; an explicit empty one its separator", () => {
    expect(pubmedAbstract(efetch("T", '<AbstractText Label="A"/>' + section("RESULTS", "Only results.")))).toBe("Only results.");
    expect(pubmedAbstract(efetch("T", "<AbstractText></AbstractText>" + section("RESULTS", "R.")))).toBe(" R.");
  });

  it("reads DispFormula and MathML inline", () => {
    const xml = efetch(
      "T",
      '<AbstractText>where <DispFormula><mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML"><mml:mi>y</mml:mi><mml:mo>=</mml:mo><mml:mn>2</mml:mn></mml:math></DispFormula> holds</AbstractText>',
    );
    expect(pubmedAbstract(xml)).toBe("where y=2 holds");
  });

  it("keeps CDATA, stray angle brackets and escaped markup", () => {
    expect(pubmedAbstract(efetch("T", '<AbstractText><![CDATA[Dose <5 mg & "x > y"]]></AbstractText>'))).toBe(
      'Dose &lt;5 mg &amp; "x &gt; y"',
    );
    expect(pubmedAbstract(efetch("T", "<AbstractText>5 < x < 10 and p<0.05 <- arrow</AbstractText>"))).toBe(
      "5 &lt; x &lt; 10 and p&lt;0.05 &lt;- arrow",
    );
    expect(pubmedAbstract(efetch("T", "<AbstractText>The tag &lt;AbstractText&gt; is text.</AbstractText>"))).toBe(
      "The tag &lt;AbstractText&gt; is text.",
    );
  });

  it("is null when the record has no abstract", () => {
    expect(pubmedAbstract(efetch("T"))).toBeNull();
    expect(pubmedAbstract(efetch("T", '<AbstractText Label="X"/>'))).toBeNull();
  });

  it("reads a long abstract exactly", () => {
    const sentence = "Effect of <sup>13</sup>C at p &lt; 0.05 and 5 &lt; x. ";
    const repeats = 4_000;
    expect(pubmedAbstract(efetch("T", `<AbstractText>${sentence.repeat(repeats)}</AbstractText>`))).toBe(
      "Effect of 13C at p &lt; 0.05 and 5 &lt; x. ".repeat(repeats),
    );
  });
});

describe("Crossref abstract", () => {
  it.each([
    ["a title and a paragraph that touch", "<jats:title>Abstract</jats:title><jats:p>Background text.</jats:p>", "Abstract Background text."],
    ["blocks already separated by white space", "<jats:title>Abstract</jats:title>\n<jats:p>Background text.</jats:p>", "Abstract\nBackground text."],
    [
      "sections with inline markup",
      "<jats:sec><jats:title>Background</jats:title><jats:p>A &amp; B with <jats:italic>E. coli</jats:italic> and CO<jats:sub>2</jats:sub>.</jats:p></jats:sec>" +
        "<jats:sec><jats:title>Results</jats:title><jats:p>p &lt; 0.05</jats:p></jats:sec>",
      "Background A &amp; B with E. coli and CO2. Results p &lt; 0.05",
    ],
    ["plain text", "Plain abstract with p < 0.05 and q > 0.1 for AT&T.", "Plain abstract with p &lt; 0.05 and q > 0.1 for AT&amp;T."],
    [
      "attributes, including a quoted >",
      '<jats:p xml:lang="en">Text <jats:xref ref-type="bibr" rid="b1">1</jats:xref> and <jats:ext-link xlink:href="https://example.org/?a=1&amp;b=2" ext-link-type="uri">link</jats:ext-link>; <jats:named-content content-type="x>y">named</jats:named-content>.</jats:p>',
      "Text 1 and link; named.",
    ],
    ["CDATA", "<jats:p><![CDATA[p < 0.05 & q]]></jats:p>", "p &lt; 0.05 &amp; q"],
    ["escaped markup", "<jats:p>Use &lt;jats:p&gt; literally and &lt;script&gt;</jats:p>", "Use &lt;jats:p&gt; literally and &lt;script&gt;"],
    [
      "inline MathML",
      "<jats:p>Value <jats:inline-formula><mml:math><mml:mi>x</mml:mi><mml:mo>&gt;</mml:mo><mml:mn>2</mml:mn></mml:math></jats:inline-formula> holds</jats:p>",
      "Value x&gt;2 holds",
    ],
    [
      "a line break and a list",
      "<jats:p>Line one<jats:break/>line two</jats:p><jats:list><jats:list-item><jats:p>First</jats:p></jats:list-item><jats:list-item><jats:p>Second</jats:p></jats:list-item></jats:list>",
      "Line one line two First Second",
    ],
    ["references stay as written, including invalid ones", "<jats:p>bad &#x110000; ref and A &amp; B</jats:p>", "bad &#x110000; ref and A &amp; B"],
    ["surrounding white space is trimmed", "\n  <jats:p> Text </jats:p>\n", "Text"],
  ])("%s", (_name, source, expected) => {
    expect(crossrefAbstract(source)).toBe(expected);
  });

  it("is null when nothing remains", () => {
    expect(crossrefAbstract("")).toBeNull();
    expect(crossrefAbstract("<jats:p></jats:p>")).toBeNull();
    expect(crossrefAbstract("<jats:p> \n </jats:p>")).toBeNull();
  });

  it("treats only block elements as word boundaries", () => {
    for (const block of ["p", "title", "sec", "list-item", "break"]) expect(JATS_BLOCK_ELEMENTS.has(block)).toBe(true);
    for (const inline of ["italic", "bold", "sub", "sup", "sc", "xref", "inline-formula", "math", "ext-link"]) {
      expect(JATS_BLOCK_ELEMENTS.has(inline)).toBe(false);
    }
  });
});

describe("Edge output through the client's normalization", () => {
  const config = { synonymLookup: {}, poolStudyTypes: [], poolKeywords: [], synonymGroups: [] };
  const normalize = (fields: { title: string; abstract: string | null; keywords?: string[]; authors?: string[] }) =>
    normalizePaperData(
      {
        title: fields.title,
        authors: fields.authors ?? [],
        year: null,
        journal: null,
        pmid: null,
        doi: null,
        abstract: fields.abstract,
        keywords: fields.keywords ?? [],
        study_type: null,
        pubmed_url: null,
        journal_url: null,
        drive_url: null,
      },
      config,
    );

  it.each([
    ["entity-encoded operators", "Effect at p &lt; 0.05 and 5 &lt; x &lt; 10", "Effect at p < 0.05 and 5 < x < 10"],
    ["named entities", "Risk &amp; benefit of &quot;early&quot; care", 'Risk & benefit of "early" care'],
    ["numeric references", "&#x3B2;-blockers &#x2265; 5 mg and &#945;-synuclein", `${C(0x3b2)}-blockers ${C(0x2265)} 5 mg and ${C(0x3b1)}-synuclein`],
    ["inline markup", "Growth of <i>E. coli</i> in CO<sub>2</sub>", "Growth of E. coli in CO2"],
    ["CDATA", "<![CDATA[p < 0.05 & q > 0.1]]> in trials", "p < 0.05 & q > 0.1 in trials"],
    ["escaped markup stays literal", "Use &lt;b&gt;bold&lt;/b&gt; and &lt;script&gt;", "Use <b>bold</b> and <script>"],
    ["stray angle brackets", "Dose <5 mg vs >10 mg", "Dose <5 mg vs >10 mg"],
    ["a doubly escaped ampersand decodes once", "The &amp;amp; operator", "The &amp; operator"],
  ])("a title with %s reaches the client as its text", (_name, source, text) => {
    expect(normalize({ title: pubmedArticleTitle(efetch(source))!, abstract: null }).title).toBe(text);
  });

  it("a structured abstract reaches the client as its text", () => {
    const xml = efetch(
      "T",
      [section("BACKGROUND", "A &amp; B."), section("RESULTS", "p &lt; 0.01 for CO<sub>2</sub>.")].join("\n"),
    );
    expect(normalize({ title: "T", abstract: pubmedAbstract(xml) }).abstract).toBe("A & B. p < 0.01 for CO2.");
  });

  it("a Crossref abstract reaches the client as its text", () => {
    const source = "<jats:title>Abstract</jats:title><jats:p>p &lt; 0.05 &amp; <jats:italic>q</jats:italic></jats:p>";
    expect(normalize({ title: "T", abstract: crossrefAbstract(source) }).abstract).toBe("Abstract p < 0.05 & q");
  });

  it("keywords and collective names keep their one Edge decoding, then the client's own", () => {
    // Pre-existing and unchanged: the Edge decodes these, and the client
    // decodes `keywords` and `authors` again. The Edge side decodes once, so
    // `raw_keywords` and `author_provenance` hold the text.
    const keyword = decodeHTMLEntities("R&amp;amp;D");
    expect(keyword).toBe("R&amp;D");
    const { authors, author_provenance } = extractPubMedAuthors(
      `<AuthorList><Author><CollectiveName>A &amp;amp; B Group</CollectiveName></Author></AuthorList>`,
    );
    expect(author_provenance![0].collective_name).toBe("A &amp; B Group");
    const normalized = normalize({ title: "T", abstract: null, keywords: [keyword], authors });
    expect(normalized.keywords).toEqual(["R&D"]);
    expect(normalized.authors).toEqual(["A & B Group"]);
  });
});

describe("index.ts reads these fields only through this module", () => {
  // Source-level check: the handler cannot be imported by Vitest (Deno runtime,
  // remote import). Comments are stripped first, so prose cannot satisfy it.
  const source = readFileSync(resolve(process.cwd(), "supabase/functions/fetch-paper-metadata/index.ts"), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("imports and calls each reading exactly once", () => {
    expect(code).toMatch(/import \{ crossrefAbstract, pubmedAbstract, pubmedArticleTitle \} from "\.\/metadataText\.ts";/);
    expect(code.match(/pubmedArticleTitle\(xml\)/g) ?? []).toHaveLength(1);
    expect(code.match(/pubmedAbstract\(xml\)/g) ?? []).toHaveLength(1);
    expect(code.match(/crossrefAbstract\(rawAbstract\)/g) ?? []).toHaveLength(1);
  });

  it("no longer removes markup with a regular expression", () => {
    expect(code).not.toMatch(/\.replace\(\/</);
    expect(code).not.toMatch(/ArticleTitle\[/);
    expect(code).not.toMatch(/AbstractText\[/);
  });

  it("decodes keywords, and only keywords, in the handler", () => {
    expect(code.match(/decodeHTMLEntities\(/g) ?? []).toHaveLength(1);
    expect(code).toMatch(/keywords\.push\(decodeHTMLEntities\(match\[1\]\)\)/);
  });

  it("keeps the request and response bounds", () => {
    expect(code).toMatch(/const MAX_IDENTIFIERS = 50;/);
    expect(code).toMatch(/if \(identifiers\.length > MAX_IDENTIFIERS\)/);
    expect(code).toMatch(/if \(trimmed\.length > 500\)/);
    expect(code).toMatch(/const MAX_PUBMED_XML_BYTES = 2 \* 1024 \* 1024;/);
    expect(code).toMatch(/if \(xml\.length > MAX_PUBMED_XML_BYTES\)/);
  });
});
