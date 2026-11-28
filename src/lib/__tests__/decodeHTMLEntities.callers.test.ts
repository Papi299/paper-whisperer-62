// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizePaperData, type NormalizationConfig, type RawPaperData } from "../normalizePaperData";
import { normalizeAuthorProvenanceForStorage, makeAuthorProvenance } from "../authorProvenance";
import { authorMentionKey, authorSearchMatches, indexAuthorMentions, normalizeAuthorDisplay } from "../authorNames";
import { parseBibTeX, parseCSV, parseEndNoteTagged, parseNBIB, parseRIS } from "../importParsers";
import { C, NBSP } from "./fixtures/clientEntitySpec";

/**
 * Every client caller of the shared entity decoder, through the real caller
 * (PAPERLUME-CODEQL-EDGE-TEXT-EXTRACTION-001A). The callers do not all receive
 * the same kind of text: `normalizePaperData` reads Edge Function output (the
 * PubMed title and abstract escaped, keywords and collective names already
 * decoded once), file imports (RIS, NBIB, EndNote, CSV and BibTeX, already
 * plain text) and manual entry; `normalizeAuthorDisplay` reads stored author
 * strings and search queries. Expected text is written by hand.
 */

const EMPTY_CONFIG: NormalizationConfig = { synonymLookup: {}, poolStudyTypes: [], poolKeywords: [], synonymGroups: [] };

function raw(overrides: Partial<RawPaperData> = {}): RawPaperData {
  return {
    title: "T",
    authors: [],
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

describe("normalizePaperData — each decoded field, once, with malformed references isolated", () => {
  const normalized = normalizePaperData(
    raw({
      title: "AT&amp;T and p &lt; 0.05; invalid &#x110000;.",
      abstract: "Literal &amp;lt; from CDATA; A &amp; B &#x110000; C &lt; D; NUL &#0; and &#xD800; stay",
      keywords: ["R&amp;D &#x110000;", "&amp;lt;tag&amp;gt;"],
      authors: ["J&#xF6;rg M&#252;ller &amp; Co&#x110000;", "Se&#225;n O&apos;Brien", "&#xD835;&#xDC00; Group"],
      journal: "Journal of R&amp;D &amp;lt;Reviews&amp;gt; &#x110000;",
      mesh_terms: ["Neoplasms &amp; Tumors", "Receptors &amp;lt;Alpha&amp;gt;", "Ions &#x110000; &amp; Salts"],
      substances: ["&#945;-Tocopherol", "Ca &#x110000; &amp; Mg"],
      publication_types: ["Journal Article", "Review &amp;amp; Commentary", "Comparative Study &#x110000; &amp; Survey"],
    }),
    EMPTY_CONFIG,
  );

  it("title: decoded once, then the trailing period removed", () => {
    expect(normalized.title).toBe("AT&T and p < 0.05; invalid &#x110000;");
  });

  it("abstract", () => {
    expect(normalized.abstract).toBe("Literal &lt; from CDATA; A & B &#x110000; C < D; NUL &#0; and &#xD800; stay");
  });

  it("keywords", () => {
    expect(normalized.keywords).toEqual(["R&D &#x110000;", "&lt;tag&gt;"]);
  });

  it("authors", () => {
    expect(normalized.authors).toEqual([`J${C(0xf6)}rg M${C(0xfc)}ller & Co&#x110000;`, `Se${C(0xe1)}n O'Brien`, `${C(0x1d400)} Group`]);
  });

  it("journal, MeSH terms and substances", () => {
    expect(normalized.journal).toBe("Journal of R&D &lt;Reviews&gt; &#x110000;");
    expect(normalized.mesh_terms).toEqual(["Neoplasms & Tumors", "Receptors &lt;Alpha&gt;", "Ions &#x110000; & Salts"]);
    expect(normalized.substances).toEqual([`${C(0x3b1)}-Tocopherol`, "Ca &#x110000; & Mg"]);
  });

  it("study type from the decoded publication types", () => {
    expect(normalized.study_type).toBe("Review &amp; Commentary, Comparative Study &#x110000; & Survey");
  });

  it("matches the study-type pool against the decoded publication type", () => {
    const pool = [{ study_type: "Meta-Analysis", specificity_weight: 1, hierarchy_rank: 1 }];
    const paper = normalizePaperData(raw({ publication_types: ["Meta&#x2D;Analysis", "Note &#x110000;"] }), {
      ...EMPTY_CONFIG,
      poolStudyTypes: pool,
    });
    expect(paper.study_type).toBe("Meta-Analysis");
  });

  it("a comma-joined study type is decoded the same way when no structured types are given", () => {
    const paper = normalizePaperData(raw({ study_type: "Clinical Trial &amp; Review, Note &#x110000;" }), EMPTY_CONFIG);
    expect(paper.study_type).toBe("Clinical Trial & Review, Note &#x110000;");
  });

  it("decodes &nbsp; in every field it decodes", () => {
    const paper = normalizePaperData(
      raw({ title: "a&nbsp;b", abstract: "c&nbsp;d", journal: "e&nbsp;f", authors: ["g&nbsp;h"], mesh_terms: ["i&nbsp;j"] }),
      EMPTY_CONFIG,
    );
    expect([paper.title, paper.abstract, paper.journal, paper.authors[0], paper.mesh_terms[0]]).toEqual([
      `a${NBSP}b`,
      `c${NBSP}d`,
      `e${NBSP}f`,
      `g${NBSP}h`,
      `i${NBSP}j`,
    ]);
  });
});

describe("normalizePaperData — identifier fields are never decoded", () => {
  it("keeps the PMID, the DOI name and every URL as given (the DOI only loses a resolver prefix and its case)", () => {
    const paper = normalizePaperData(
      raw({
        pmid: "12345678",
        doi: "https://doi.org/10.5555/ABC&amp;DEF#X&#x110000;",
        pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/12345678/?a=1&amp;b=2",
        journal_url: "https://doi.org/10.1000/456%23789",
        drive_url: "https://example.org/f?x=&lt;y&gt;",
      }),
      EMPTY_CONFIG,
    );
    expect(paper.pmid).toBe("12345678");
    expect(paper.doi).toBe("10.5555/abc&amp;def#x&#x110000;");
    expect(paper.pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/?a=1&amp;b=2");
    expect(paper.journal_url).toBe("https://doi.org/10.1000/456%23789");
    expect(paper.drive_url).toBe("https://example.org/f?x=&lt;y&gt;");
  });

  it("keeps a DOI name with a number sign distinct from its resolver URL", () => {
    const paper = normalizePaperData(raw({ doi: "10.1000/456#789", journal_url: "https://doi.org/10.1000/456%23789" }), EMPTY_CONFIG);
    expect(paper.doi).toBe("10.1000/456#789");
    expect(paper.journal_url).toBe("https://doi.org/10.1000/456%23789");
  });
});

describe("normalizePaperData — author provenance is passed through, and stays aligned", () => {
  const provenance = [
    makeAuthorProvenance({ source: "pubmed_api", source_field: "Author", kind: "personal", source_name: "J&#xF6;rg M&#252;ller &amp; Co&#x110000;" }),
    makeAuthorProvenance({
      source: "pubmed_api",
      source_field: "CollectiveName",
      kind: "collective",
      source_name: "The &lt;Alpha&gt; Consortium",
      collective_name: "The &lt;Alpha&gt; Consortium",
      affiliations: ["Lab &amp; Unit &#x110000;"],
      identifiers: [{ scheme: "ORCID", value: "0000-0002-1825-0097" }],
    }),
  ];
  const snapshot = JSON.stringify(provenance);
  const paper = normalizePaperData(
    raw({ authors: ["J&#xF6;rg M&#252;ller &amp; Co&#x110000;", "The &lt;Alpha&gt; Consortium"], author_provenance: provenance }),
    EMPTY_CONFIG,
  );

  it("decodes the compatibility author strings", () => {
    expect(paper.authors).toEqual([`J${C(0xf6)}rg M${C(0xfc)}ller & Co&#x110000;`, "The <Alpha> Consortium"]);
  });

  it("passes the provenance through untouched, in order", () => {
    expect(paper.author_provenance).toBe(provenance);
    expect(JSON.stringify(paper.author_provenance)).toBe(snapshot);
  });

  it("stores the provenance, because alignment is by position and the count is unchanged", () => {
    expect(normalizeAuthorProvenanceForStorage(paper.author_provenance, paper.authors)).toEqual(provenance);
  });
});

describe("author display, search and grouping keys", () => {
  it("leaves every name without an ampersand exactly as display normalization always has", () => {
    const names = ["Jane Doe", `Jos${C(0xe9)} Garc${C(0xed)}a`, `O'Brien, Se${C(0x301)}an`, "Van der Berg", "Soto-Rifo"];
    for (const name of names) expect(normalizeAuthorDisplay(name)).toBe(name.normalize("NFC"));
  });

  it("decodes ordinary references in a stored name once", () => {
    expect(normalizeAuthorDisplay("Garc&#xED;a, Jos&#xE9;")).toBe(`Garc${C(0xed)}a, Jos${C(0xe9)}`);
    expect(normalizeAuthorDisplay("O&apos;Brien &amp; Co")).toBe("O'Brien & Co");
    expect(authorMentionKey("M&#252;ller, J.")).toBe(`m${C(0xfc)}ller, j`);
  });

  it("decodes the valid references of a name that also holds an invalid one", () => {
    expect(normalizeAuthorDisplay("J&#xF6;rg M&#252;ller &#x110000;")).toBe(`J${C(0xf6)}rg M${C(0xfc)}ller &#x110000;`);
    expect(authorMentionKey("J&#xF6;rg M&#252;ller &#x110000;")).toBe(`j${C(0xf6)}rg m${C(0xfc)}ller &#x110000;`);
  });

  it("decodes one level, and never produces NUL or a lone surrogate", () => {
    expect(normalizeAuthorDisplay("A &amp;lt; B")).toBe("A &lt; B");
    expect(normalizeAuthorDisplay("NUL &#0; and &#xD800; x")).toBe("NUL &#0; and &#xD800; x");
    expect(normalizeAuthorDisplay("&#55349;&#56320; Group")).toBe(`${C(0x1d400)} Group`);
  });

  it("groups a decoded spelling with its referenced spelling, invalid reference or not", () => {
    const entries = indexAuthorMentions([
      [`J${C(0xf6)}rg M${C(0xfc)}ller &#x110000;`],
      ["J&#xF6;rg M&#252;ller &#x110000;"],
      [`Garc${C(0xed)}a, Ana`],
      ["Garc&#xED;a, Ana"],
    ]);
    expect(entries.map((entry) => [entry.label, entry.documentCount])).toEqual([
      [`J${C(0xf6)}rg M${C(0xfc)}ller &#x110000;`, 2],
      [`Garc${C(0xed)}a, Ana`, 2],
    ]);
  });

  it("matches a search typed with references against the decoded label", () => {
    expect(authorSearchMatches(`J${C(0xf6)}rg M${C(0xfc)}ller`, "j&#xf6;rg")).toBe(true);
    expect(authorSearchMatches("Ana Ruiz", "&#x110000;")).toBe(false);
  });
});

describe("file imports reach normalization as plain text and are decoded once", () => {
  const normalizeFirst = (papers: RawPaperData[]) => normalizePaperData(papers[0], EMPTY_CONFIG);

  it("RIS", () => {
    const ris = [
      "TY  - JOUR",
      "TI  - AT&amp;T &amp;lt;b&amp;gt; and p &lt; 0.05 &#x110000;",
      "AU  - M&#252;ller, J&#xF6;rg",
      "AB  - CI &#8805; 0.9 &amp; n&#8201;=&#8201;12",
      "KW  - R&amp;D",
      "ER  - ",
    ].join("\n");
    const paper = normalizeFirst(parseRIS(ris).papers);
    expect(paper.title).toBe("AT&T &lt;b&gt; and p < 0.05 &#x110000;");
    expect(paper.authors).toEqual([`M${C(0xfc)}ller, J${C(0xf6)}rg`]);
    expect(paper.abstract).toBe(`CI ${C(0x2265)} 0.9 & n${C(0x2009)}=${C(0x2009)}12`);
    expect(paper.keywords).toEqual(["R&D"]);
  });

  it("NBIB", () => {
    const nbib = "\nPMID- 11111111\nTI  - A &amp; B &#x110000; C &lt; D.\nAB  - Literal &amp;lt; text\n";
    const paper = normalizeFirst(parseNBIB(nbib).papers);
    expect(paper.title).toBe("A & B &#x110000; C < D");
    expect(paper.abstract).toBe("Literal &lt; text");
  });

  it("EndNote tagged", () => {
    const enw = "%0 Journal Article\n%T R&amp;D &amp;lt;x&amp;gt; &#xD835;&#xDC00;\n%A Ng &amp; Co\n";
    const paper = normalizeFirst(parseEndNoteTagged(enw).papers);
    expect(paper.title).toBe(`R&D &lt;x&gt; ${C(0x1d400)}`);
    expect(paper.authors).toEqual(["Ng & Co"]);
  });

  it("CSV (list columns are split at semicolons by the parser, so references are kept to the text columns)", () => {
    const csv = 'Title,Authors,Journal,Abstract\n"Lit &amp;lt; &#xD835;&#xDC00; &#0;","Ana Ruiz","J &amp; K","p &lt; 0.05 &#x110000;"';
    const paper = normalizeFirst(parseCSV(csv).papers);
    expect(paper.title).toBe(`Lit &lt; ${C(0x1d400)} &#0;`);
    expect(paper.authors).toEqual(["Ana Ruiz"]);
    expect(paper.journal).toBe("J & K");
    expect(paper.abstract).toBe("p < 0.05 &#x110000;");
  });

  it("BibTeX: LaTeX is decoded by the parser, references by normalization", () => {
    const bib = "@article{k,\n  title = {A \\& B &amp; C &amp;lt;x&amp;gt;},\n  author = {M{\\\"u}ller, J{\\\"o}rg},\n  abstract = {p &lt; 0.05}\n}";
    const paper = normalizeFirst(parseBibTeX(bib).papers);
    expect(paper.title).toBe("A & B & C &lt;x&gt;");
    expect(paper.authors).toEqual([`M${C(0xfc)}ller, J${C(0xf6)}rg`]);
    expect(paper.abstract).toBe("p < 0.05");
  });
});

describe("the normalization Web Worker decodes with the same function", () => {
  it("posts back what normalizePaperData returns on the main thread", async () => {
    const posted: unknown[] = [];
    const scope = { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: (message: unknown) => posted.push(message) };
    vi.stubGlobal("self", scope);
    try {
      vi.resetModules();
      await import("../../workers/normalization.worker");
      const papers = [raw({ title: "AT&amp;T &#x110000; &amp;lt;", abstract: "A &amp; B", authors: ["Ng &amp; Co"] })];
      scope.onmessage!({ data: { id: 7, papers, config: EMPTY_CONFIG } });
      expect(posted).toEqual([{ id: 7, results: papers.map((paper) => normalizePaperData(paper, EMPTY_CONFIG)) }]);
      expect((posted[0] as { results: { title: string }[] }).results[0].title).toBe("AT&T &#x110000; &lt;");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("which modules can reach the decoder", () => {
  const SRC = resolve(__dirname, "../..");
  const DECODER = resolve(SRC, "lib/decodeHTMLEntities.ts");

  /** Every local module a file imports, directly or transitively (static and type-free imports). */
  function closure(entry: string): Set<string> {
    const seen = new Set<string>();
    const pending = [entry];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms)) {
        const specifier = match[1];
        const base = specifier.startsWith("@/")
          ? resolve(SRC, specifier.slice(2))
          : specifier.startsWith(".")
            ? resolve(dirname(file), specifier)
            : null;
        if (base === null) continue;
        const target = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => existsSync(candidate));
        if (target) pending.push(target);
      }
    }
    return seen;
  }

  it.each(["lib/exportUtils.ts", "lib/bibtexCodec.ts", "lib/doiIdentifiers.ts", "lib/pubmedIdentifiers.ts", "lib/authorProvenance.ts"])(
    "%s does not import it, directly or through another module",
    (module) => {
      expect(closure(resolve(SRC, module)).has(DECODER)).toBe(false);
    },
  );

  it.each(["lib/normalizePaperData.ts", "lib/authorNames.ts", "lib/authorIdentity.ts", "workers/normalization.worker.ts"])(
    "%s does",
    (module) => {
      expect(closure(resolve(SRC, module)).has(DECODER)).toBe(true);
    },
  );
});
