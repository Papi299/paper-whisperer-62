import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { exportToBibTeX } from "../exportUtils";
import { parseBibTeX } from "../importParsers";
import type { PaperWithTags } from "@/types/database";

/**
 * Record integrity of the BibTeX export, end to end: what `exportToBibTeX`
 * writes and what `parseBibTeX` reads back.
 *
 * A stored value must not change the structure of the file. Whatever a title,
 * an abstract, a DOI or a URL contains, the file has one entry per paper, each
 * entry has exactly the fields the exporter wrote, and every value comes back
 * as it was stored. Structure is checked with `bibtexEntries` below, a
 * separate reading of BibTeX's own rule (every brace counts, and a backslash
 * before one changes nothing), not with the importer under test.
 *
 * Fixtures use `String.raw`, so a backslash in them is one backslash.
 */

// ── Capture the exported file instead of downloading it ──

let downloads: Blob[] = [];

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  downloads = [];
  // As in exportRoundTrip.test.ts: jsdom has no object URLs, so the download
  // step is stubbed and the Blob captured. The `URL` constructor itself keeps
  // working, because the parsers need it.
  URL.createObjectURL = ((blob: Blob) => {
    downloads.push(blob);
    return "blob:captured";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

/** The text of the most recent export, read the way the import dropzone reads a file. */
const exported = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(downloads[downloads.length - 1]);
  });

async function exportBib(papers: PaperWithTags[]): Promise<string> {
  exportToBibTeX(papers);
  return exported();
}

const BS = "\\";

// ── Fixtures ──

function makePaper(overrides: Partial<PaperWithTags> = {}): PaperWithTags {
  return {
    id: "paper-1",
    user_id: "user-1",
    title: "Effect of Treatment on Outcomes",
    authors: ["Consortium"],
    year: 2024,
    journal: "Journal of Testing",
    pmid: null,
    doi: "10.1000/first",
    abstract: "This is the abstract.",
    study_type: "Cohort",
    raw_study_type: null,
    statistical_methods: null,
    keywords: ["treatment"],
    raw_keywords: null,
    mesh_terms: [],
    substances: [],
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
    tldr: null,
    notes: null,
    insert_order: 1,
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    tags: [],
    projects: [],
    ...overrides,
  };
}

/** A second paper after the one under test, whose survival proves the boundary held. */
const sentinel = () =>
  makePaper({
    id: "paper-2",
    title: "Sentinel Paper",
    authors: ["Sentinel"],
    year: 2023,
    journal: "Sentinel Journal",
    pmid: "87654321",
    doi: "10.1000/sentinel",
    abstract: "Sentinel abstract.",
    study_type: "Case Report",
    keywords: ["sentinel"],
  });

// ── An independent reading of BibTeX structure ──

interface OracleEntry {
  type: string;
  key: string;
  fields: Array<[name: string, value: string]>;
}

/** The index of the brace that closes the group opening at `open`, counting every brace. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Read a file of brace-delimited entries by BibTeX's rules (bibtex.web): find
 * the next `@`, read the type, the key up to the first comma, then
 * `name = {value}` fields separated by commas, each value ending where the
 * brace count returns to zero. Anything else is an error, so a malformed
 * export fails loudly rather than parsing as something else.
 */
function bibtexEntries(file: string): OracleEntry[] {
  const entries: OracleEntry[] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < file.length && /\s/.test(file[i])) i++;
  };

  for (;;) {
    const at = file.indexOf("@", i);
    if (at < 0) return entries;
    i = at + 1;

    const typeStart = i;
    while (i < file.length && /[A-Za-z]/.test(file[i])) i++;
    const type = file.slice(typeStart, i);
    skipSpace();
    if (file[i] !== "{") throw new Error(`entry at ${at}: expected "{"`);
    i++;

    const keyStart = i;
    while (i < file.length && !/[\s,{}]/.test(file[i])) i++;
    const key = file.slice(keyStart, i);
    const fields: OracleEntry["fields"] = [];
    skipSpace();

    while (file[i] === ",") {
      i++;
      skipSpace();
      if (file[i] === "}") break;
      // A field name is a BibTeX identifier. bibtex.web allows any character
      // in one except white space and " # % ' ( ) , = { }.
      const nameStart = i;
      while (i < file.length && !/[\s"#%'(),={}]/.test(file[i])) i++;
      const name = file.slice(nameStart, i);
      if (!name) throw new Error(`${key}: expected a field name`);
      skipSpace();
      if (file[i] !== "=") throw new Error(`${key}.${name}: expected "="`);
      i++;
      skipSpace();
      if (file[i] !== "{") throw new Error(`${key}.${name}: expected "{"`);
      const end = closingBrace(file, i);
      if (end < 0) throw new Error(`${key}.${name}: the field never closes`);
      fields.push([name, file.slice(i + 1, end)]);
      i = end + 1;
      skipSpace();
    }

    if (file[i] !== "}") throw new Error(`${key}: expected "}" after the fields, found ${JSON.stringify(file[i])}`);
    i++;
    entries.push({ type, key, fields });
  }
}

const fieldNames = (entry: OracleEntry) => entry.fields.map(([name]) => name);

/** BibTeX's split of a name list: " and " counts only outside braces. */
function bibtexNameCount(value: string): number {
  let depth = 0;
  let count = 1;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "{") depth++;
    else if (value[i] === "}") depth--;
    else if (depth === 0 && /^\sand\s/i.test(value.slice(i, i + 5))) count++;
  }
  return count;
}

const ALL_FIELDS = ["title", "author", "year", "journal", "doi", "url", "abstract", "keywords", "note"];
const SENTINEL_FIELDS = ["title", "author", "year", "journal", "doi", "pmid", "url", "abstract", "keywords", "note"];

/**
 * The field names of an entry whose DOI or URL went to its PaperLume field:
 * the standard field is replaced, in the same place, and not written at all.
 */
const withPaperLumeField = (names: readonly string[], field: "doi" | "url"): string[] =>
  names.map((name) => (name === field ? `paperlume-${field}-v1` : name));

const LB = String.raw`\textbraceleft{}`;
const RB = String.raw`\textbraceright{}`;
const BK = String.raw`\textbackslash{}`;

function expectSentinel(file: string, paper: ReturnType<typeof parseBibTeX>["papers"][number] | undefined) {
  const entries = bibtexEntries(file);
  expect(fieldNames(entries[entries.length - 1])).toEqual(SENTINEL_FIELDS);
  expect(paper).toMatchObject({
    title: "Sentinel Paper",
    authors: ["Sentinel"],
    year: 2023,
    journal: "Sentinel Journal",
    pmid: "87654321",
    doi: "10.1000/sentinel",
    abstract: "Sentinel abstract.",
    keywords: ["sentinel"],
    study_type: "Case Report",
    pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/87654321/",
    journal_url: null,
  });
}

// ── Structural injection ──

/** Harmless synthetic text that would change a file's structure if written unencoded. */
const HOSTILE: ReadonlyArray<readonly [label: string, value: string]> = [
  ["an isolated closing brace", "Effect } size"],
  ["an isolated opening brace", "Effect { size"],
  ["braces that cross", "a } b { c"],
  ["nested groups", "{{a} {b {c}}} d"],
  ["field-like punctuation", "x}, author = {Injected Person}, note = {Study type: Fake"],
  ["entry-like text", "x}}\n}\n\n@article{injected,\n  title = {Injected Title}\n}\n@comment{"],
  ["newlines", "line one\n\nline three\r\nline four"],
  ["quoted strings", '"a" # "b", title = "c"'],
  ["consecutive escapes", String.raw`\\\{\}\\ and \} \{`],
  ["LaTeX-looking text", String.raw`\textbraceright{} \textbackslash{} \}`],
  ["a trailing backslash", `ends with ${BS}`],
];

describe("a stored text value cannot change the structure of the file", () => {
  for (const [label, value] of HOSTILE) {
    it(`title, journal, abstract and note containing ${label}`, async () => {
      const singleLine = !/[\r\n]/.test(value);
      const file = await exportBib([
        makePaper({
          title: value,
          journal: value,
          abstract: value,
          study_type: singleLine ? value : "Cohort",
        }),
        sentinel(),
      ]);

      // Structure, by BibTeX's rules: two entries, each with its own fields.
      const entries = bibtexEntries(file);
      expect(entries.map((entry) => entry.key)).toHaveLength(2);
      expect(fieldNames(entries[0])).toEqual(ALL_FIELDS);

      // Content, by the importer.
      const { papers, warnings } = parseBibTeX(file);
      expect(warnings).toEqual([]);
      expect(papers).toHaveLength(2);
      expect(papers[0]).toMatchObject({
        title: value.trim(),
        journal: value.trim(),
        abstract: value.trim(),
        study_type: singleLine ? value.trim() : "Cohort",
        authors: ["Consortium"],
        year: 2024,
        keywords: ["treatment"],
        doi: "10.1000/first",
        pmid: null,
        pubmed_url: null,
        journal_url: "https://doi.org/10.1000/first",
      });
      expectSentinel(file, papers[1]);
    });
  }

  it("authors and keywords made of hostile tokens", async () => {
    // Single tokens without commas, so the exporter's "Last, First" reordering
    // and the importer's list splitting leave them as they are.
    const tokens = ["}", "{", "a}b{c", BS, String.raw`\}`, "x}}", "{{", "@article{x", String.raw`\textbraceleft{}`];
    const file = await exportBib([makePaper({ authors: tokens, keywords: tokens }), sentinel()]);

    const entries = bibtexEntries(file);
    expect(entries).toHaveLength(2);
    expect(fieldNames(entries[0])).toEqual(ALL_FIELDS);

    const { papers, warnings } = parseBibTeX(file);
    expect(warnings).toEqual([]);
    expect(papers).toHaveLength(2);
    expect(papers[0].authors).toEqual(tokens);
    expect(papers[0].keywords).toEqual(tokens);
    expectSentinel(file, papers[1]);
  });

  it("keeps the author count BibTeX reads when braces pair across names", async () => {
    // Encoded as one string, `A{x` and `y}B` would pair into `A\{x and y\}B`,
    // and BibTeX, which splits only at an " and " outside braces, would read
    // one name. Each name is encoded on its own instead.
    const file = await exportBib([makePaper({ authors: ["A{x", "y}B"] })]);
    const author = bibtexEntries(file)[0].fields.find(([name]) => name === "author")![1];

    expect(bibtexNameCount(author)).toBe(2);
    expect(parseBibTeX(file).papers[0].authors).toEqual(["A{x", "y}B"]);
  });

  it("does not create, lose or merge entries across a large mixed export", async () => {
    const papers = HOSTILE.flatMap(([, value], index) => [
      makePaper({ id: `h${index}`, title: value, abstract: value, authors: ["Consortium"], doi: `10.1000/h${index}` }),
      makePaper({ id: `s${index}`, title: `Plain ${index}`, doi: `10.1000/s${index}` }),
    ]);
    const file = await exportBib(papers);

    expect(bibtexEntries(file)).toHaveLength(papers.length);
    const back = parseBibTeX(file);
    expect(back.warnings).toEqual([]);
    expect(back.papers.map((paper) => paper.doi)).toEqual(papers.map((paper) => paper.doi));
    expect(back.papers.map((paper) => paper.title)).toEqual(papers.map((paper) => paper.title.trim()));
  });
});

// ── DOI and URL ──

describe("the DOI and URL fields keep their identifiers", () => {
  it("writes an ordinary DOI and URL byte for byte", async () => {
    const file = await exportBib([
      makePaper({ doi: "10.1002/(SICI)1097-4636(199706)35:4<487::AID-JBM9>3.0.CO;2-K" }),
      makePaper({ doi: "10.1000/a{b}c" }),
      makePaper({ doi: null, journal_url: "https://journal.example.com/article?id=7&x=%20y#s{2}" }),
    ]);

    expect(file).toContain("doi       = {10.1002/(SICI)1097-4636(199706)35:4<487::AID-JBM9>3.0.CO;2-K}");
    // The DOI Handbook's percent-encoding leaves ( ) : ; unescaped and encodes < >.
    expect(file).toContain(
      "url       = {https://doi.org/10.1002/(SICI)1097-4636(199706)35:4%3C487::AID-JBM9%3E3.0.CO;2-K}",
    );
    expect(file).toContain("doi       = {10.1000/a{b}c}");
    expect(file).toContain("url       = {https://doi.org/10.1000/a%7Bb%7Dc}");
    expect(file).toContain("url       = {https://journal.example.com/article?id=7&x=%20y#s{2}}");

    const papers = parseBibTeX(file).papers;
    expect(papers.map((paper) => paper.doi)).toEqual([
      "10.1002/(SICI)1097-4636(199706)35:4<487::AID-JBM9>3.0.CO;2-K",
      "10.1000/a{b}c",
      null,
    ]);
    expect(papers[2].journal_url).toBe("https://journal.example.com/article?id=7&x=%20y#s{2}");
  });

  it("writes token-like text in a DOI or URL raw, as every tool reads it", async () => {
    const doi = `10.1000/a${LB}b`;
    const link = `https://journal.example.com/a?q=${LB}x${RB}`;
    const file = await exportBib([makePaper({ doi }), makePaper({ doi: null, journal_url: link })]);

    expect(file).toContain(`doi       = {${doi}}`);
    expect(file).toContain("url       = {https://doi.org/10.1000/a%5Ctextbraceleft%7B%7Db}");
    expect(file).toContain(`url       = {${link}}`);
    expect(file).not.toContain("paperlume-");

    const papers = parseBibTeX(file).papers;
    expect(papers[0].doi).toBe(doi);
    expect(papers[1].journal_url).toBe(link);
  });

  const UNWRITABLE_DOIS: ReadonlyArray<readonly [doi: string, payload: string, resolver: string]> = [
    ["10.1000/x}", `10.1000/x${RB}`, "https://doi.org/10.1000/x%7D"],
    ["10.1000/x{", `10.1000/x${LB}`, "https://doi.org/10.1000/x%7B"],
    ["10.1000/}{", `10.1000/${RB}${LB}`, "https://doi.org/10.1000/%7D%7B"],
    [
      "10.1000/x}, title = {Injected",
      `10.1000/x${RB}, title = ${LB}Injected`,
      "https://doi.org/10.1000/x%7D%2C%20title%20=%20%7BInjected",
    ],
    ["{10.1000/x}", `${LB}10.1000/x${RB}`, "https://doi.org/%7B10.1000/x%7D"],
  ];

  for (const [doi, payload, resolver] of UNWRITABLE_DOIS) {
    it(`moves ${JSON.stringify(doi)} to its PaperLume field and recovers the exact DOI`, async () => {
      const file = await exportBib([makePaper({ doi }), sentinel()]);

      // Structure first: two entries, each with its own fields. There is no
      // `doi` field, because any form of this value written there would be a
      // different DOI to every other tool.
      const entries = bibtexEntries(file);
      expect(entries).toHaveLength(2);
      expect(fieldNames(entries[0])).toEqual(withPaperLumeField(ALL_FIELDS, "doi"));
      expect(file).toContain(`  paperlume-doi-v1 = {${payload}}`);
      // The resolver URL is unchanged: it was already percent-encoded.
      expect(file).toContain(`url       = {${resolver}}`);

      const { papers, warnings } = parseBibTeX(file);
      expect(warnings).toEqual([]);
      expect(papers).toHaveLength(2);
      expect(papers[0].doi).toBe(doi);
      expect(papers[0].journal_url).toBe(resolver);
      expect(papers[0].abstract).toBe("This is the abstract.");
      expectSentinel(file, papers[1]);
    });
  }

  const UNWRITABLE_URLS: ReadonlyArray<readonly [stored: string, payload: string]> = [
    ["https://example.com/search?q=}", `https://example.com/search?q=${RB}`],
    ["https://example.com/search?q={", `https://example.com/search?q=${LB}`],
    ["https://example.com/a?q=}#{", `https://example.com/a?q=${RB}#${LB}`],
    [`https://example.com/a?q=${BS}}`, `https://example.com/a?q=${BK}${RB}`],
    ["https://example.com/a?q=%7B}", `https://example.com/a?q=%7B${RB}`],
  ];

  for (const [stored, payload] of UNWRITABLE_URLS) {
    it(`moves the link ${JSON.stringify(stored)} to its PaperLume field and recovers it exactly`, async () => {
      const file = await exportBib([makePaper({ doi: null, journal_url: stored }), sentinel()]);

      const entries = bibtexEntries(file);
      expect(entries).toHaveLength(2);
      expect(fieldNames(entries[0])).toEqual(
        withPaperLumeField(ALL_FIELDS, "url").filter((name) => name !== "doi"),
      );
      expect(file).toContain(`  paperlume-url-v1 = {${payload}}`);

      const { papers, warnings } = parseBibTeX(file);
      expect(warnings).toEqual([]);
      expect(papers).toHaveLength(2);
      expect(papers[0]).toMatchObject({ journal_url: stored, pmid: null, pubmed_url: null, doi: null });
      expect(papers[0].abstract).toBe("This is the abstract.");
      expectSentinel(file, papers[1]);
    });
  }

  it("does not percent-encode a URL a second time", async () => {
    const file = await exportBib([
      makePaper({ doi: "10.1000/456#789" }),
      makePaper({ doi: null, journal_url: "https://example.com/a%20b?c=%7Bd%7D" }),
    ]);

    expect(file).toContain("url       = {https://doi.org/10.1000/456%23789}");
    expect(file).toContain("url       = {https://example.com/a%20b?c=%7Bd%7D}");
    expect(file).not.toContain("%25");
    expect(parseBibTeX(file).papers[1].journal_url).toBe("https://example.com/a%20b?c=%7Bd%7D");
  });

  it("keeps the PMID's authority: explicit field, then the PubMed record URL", async () => {
    const file = await exportBib([makePaper({ pmid: "12345678", doi: "10.1000/x}" })]);

    expect(file).toContain("pmid      = {12345678}");
    expect(file).toContain("url       = {https://pubmed.ncbi.nlm.nih.gov/12345678/}");
    expect(file).toContain(`  paperlume-doi-v1 = {10.1000/x${RB}}`);
    expect(parseBibTeX(file).papers[0]).toMatchObject({
      pmid: "12345678",
      pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
      doi: "10.1000/x}",
      journal_url: null,
    });
  });

  it("keeps every record and field around several exceptional identifiers", async () => {
    const file = await exportBib([
      makePaper({ id: "e1", title: "First", doi: "10.1000/x}" }),
      makePaper({ id: "e2", title: "Second", doi: null, journal_url: "https://example.com/?q={" }),
      makePaper({ id: "e3", title: "Third", doi: "{10.1000/y}", pmid: "12345678" }),
      makePaper({ id: "e4", title: "Fourth", doi: `10.1000/a${LB}b` }),
      sentinel(),
    ]);

    const entries = bibtexEntries(file);
    expect(entries.map(fieldNames)).toEqual([
      ["title", "author", "year", "journal", "paperlume-doi-v1", "url", "abstract", "keywords", "note"],
      ["title", "author", "year", "journal", "paperlume-url-v1", "abstract", "keywords", "note"],
      ["title", "author", "year", "journal", "paperlume-doi-v1", "pmid", "url", "abstract", "keywords", "note"],
      ["title", "author", "year", "journal", "doi", "url", "abstract", "keywords", "note"],
      SENTINEL_FIELDS,
    ]);

    const { papers, warnings } = parseBibTeX(file);
    expect(warnings).toEqual([]);
    expect(papers.map((paper) => [paper.title, paper.doi, paper.journal_url, paper.pmid])).toEqual([
      ["First", "10.1000/x}", "https://doi.org/10.1000/x%7D", null],
      ["Second", null, "https://example.com/?q={", null],
      ["Third", "{10.1000/y}", null, "12345678"],
      ["Fourth", `10.1000/a${LB}b`, "https://doi.org/10.1000/a%5Ctextbraceleft%7B%7Db", null],
      ["Sentinel Paper", "10.1000/sentinel", null, "87654321"],
    ]);
    expectSentinel(file, papers[4]);
  });
});

describe("a DOI or URL another tool wrote is read as written", () => {
  it("never decodes token-like text in a standard doi or url field", () => {
    const file = String.raw`@article{a, title = {A}, doi = {10.1000/a\textbraceleft{}b}}
@article{b, title = {B}, doi = {10.1000/a\textbraceright{}b}}
@article{c, title = {C}, doi = {10.1000/a\textbackslash{}b}}
@article{d, title = {D}, doi = {10.1000/\textbackslash{}\textbraceleft{}\textbraceright{}\textbraceleft{}}}
@article{e, title = {E}, doi = {10.1002/(SICI)1097-4636(199706)35:4<487::AID-JBM9\textbraceright{}>3.0.CO;2-K}}
@article{f, title = {F}, url = {https://doi.org/10.1000/456%23789}}
@article{g, title = {G}, url = {https://journal.example.com/article?id=7&q=\textbraceleft{}x\textbraceright{}#\textbackslash{}}}
@article{h, title = {H}, url = {https://example.com/a%20b?c=%7Bd%7D}}
@article{i, title = {I}, doi = {{10.1000/wrapped}}, url = {{https://journal.example.com/wrapped}}}
@article{sentinel, title = {Sentinel}, doi = {10.1000/sentinel}}`;
    const { papers, warnings } = parseBibTeX(file);

    expect(warnings).toEqual([]);
    expect(papers.map((paper) => [paper.title, paper.doi, paper.journal_url, paper.pmid])).toEqual([
      ["A", String.raw`10.1000/a\textbraceleft{}b`, null, null],
      ["B", String.raw`10.1000/a\textbraceright{}b`, null, null],
      ["C", String.raw`10.1000/a\textbackslash{}b`, null, null],
      ["D", String.raw`10.1000/\textbackslash{}\textbraceleft{}\textbraceright{}\textbraceleft{}`, null, null],
      ["E", String.raw`10.1002/(SICI)1097-4636(199706)35:4<487::AID-JBM9\textbraceright{}>3.0.CO;2-K`, null, null],
      ["F", null, "https://doi.org/10.1000/456%23789", null],
      // The WHATWG URL parser keeps \ { } as they are in a query and a fragment.
      ["G", null, String.raw`https://journal.example.com/article?id=7&q=\textbraceleft{}x\textbraceright{}#\textbackslash{}`, null],
      ["H", null, "https://example.com/a%20b?c=%7Bd%7D", null],
      ["I", "10.1000/wrapped", "https://journal.example.com/wrapped", null],
      ["Sentinel", "10.1000/sentinel", null, null],
    ]);
  });

  it("never lets a PaperLume field replace a standard DOI or URL", () => {
    const after = String.raw`@article{conflict,
  title = {Conflict},
  doi = {10.1000/standard},
  paperlume-doi-v1 = {10.1000/other\textbraceright{}},
  url = {https://journal.example.com/standard},
  paperlume-url-v1 = {https://other.example/\textbraceright{}}
}`;
    const before = String.raw`@article{conflict,
  title = {Conflict},
  PaperLume-DOI-v1 = {10.1000/other\textbraceright{}},
  doi = {10.1000/standard},
  paperlume-url-v1 = {https://other.example/\textbraceright{}},
  url = {https://journal.example.com/standard}
}`;
    for (const file of [after, before]) {
      expect(parseBibTeX(file).papers[0]).toMatchObject({
        doi: "10.1000/standard",
        journal_url: "https://journal.example.com/standard",
        pmid: null,
      });
    }
  });

  it("ignores a malformed PaperLume field, and nothing else", () => {
    const file = String.raw`@article{m1, title = {M1}, paperlume-doi-v1 = {10.1000/x\textbraceright}}
@article{m2, title = {M2}, paperlume-doi-v1 = {10.1000/{x}}}
@article{m3, title = {M3}, paperlume-doi-v2 = {10.1000/v2}}
@article{m4, title = {M4}, paperlume-url-v1 = {https://pubmed.ncbi.nlm.nih.gov/33333333/{x}}}
@article{m5, title = {M5}, paperlume-url-v1 = {https://journal.example.com/a\textasciitilde{}}}
@article{sentinel, title = {Sentinel}, author = {Sentinel}, doi = {10.1000/sentinel}}`;
    const { papers, warnings } = parseBibTeX(file);

    expect(warnings).toEqual([]);
    expect(papers.map((paper) => [paper.title, paper.doi, paper.journal_url, paper.pmid, paper.pubmed_url])).toEqual([
      ["M1", null, null, null, null],
      ["M2", null, null, null, null],
      ["M3", null, null, null, null],
      ["M4", null, null, null, null],
      ["M5", null, null, null, null],
      ["Sentinel", "10.1000/sentinel", null, null, null],
    ]);
    expect(papers[5].authors).toEqual(["Sentinel"]);
  });

  it("checks a URL from its PaperLume field exactly as one from the url field", () => {
    const pick = (file: string) => {
      const [paper] = parseBibTeX(file).papers;
      return { pmid: paper.pmid, pubmed_url: paper.pubmed_url, journal_url: paper.journal_url };
    };
    const CASES: ReadonlyArray<readonly [url: string, expected: ReturnType<typeof pick>]> = [
      [
        "https://pubmed.ncbi.nlm.nih.gov/12345678/?q={x}",
        { pmid: "12345678", pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/12345678/", journal_url: null },
      ],
      ["https://journal.example.com/a?q={x}", { pmid: null, pubmed_url: null, journal_url: "https://journal.example.com/a?q={x}" }],
      ["https://doi.org/10.1000/x", { pmid: null, pubmed_url: null, journal_url: "https://doi.org/10.1000/x" }],
      ["javascript:alert({x})", { pmid: null, pubmed_url: null, journal_url: null }],
      ["data:text/html,{x}", { pmid: null, pubmed_url: null, journal_url: null }],
    ];

    for (const [url, expected] of CASES) {
      const payload = url.replace(/[{}]/g, (brace) => (brace === "{" ? LB : RB));
      expect(pick(`@article{k, title = {T}, url = {${url}}}`), url).toEqual(expected);
      expect(pick(`@article{k, title = {T}, paperlume-url-v1 = {${payload}}}`), url).toEqual(expected);
    }

    // The explicit pmid field still outranks a PubMed URL, wherever the URL came from.
    expect(
      pick(String.raw`@article{k, title = {T}, pmid = {11111111},
  paperlume-url-v1 = {https://pubmed.ncbi.nlm.nih.gov/22222222/?q=\textbraceright{}}}`),
    ).toEqual({ pmid: "11111111", pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/11111111/", journal_url: null });
  });
});

// ── Year and citation key ──

// ── What the export reports ──

describe("the export summary counts what the file holds", () => {
  /** The PaperLume fields of each entry, as the structural oracle reads the file. */
  const paperLumeFields = (file: string): string[][] =>
    bibtexEntries(file).map((entry) => fieldNames(entry).filter((name) => name.startsWith("paperlume-")));

  it("counts nothing in an export whose DOIs and URLs are all written raw", async () => {
    const summary = exportToBibTeX([
      makePaper({ doi: "10.1000/456#789" }),
      makePaper({ doi: `10.1000/a${LB}b` }),
      makePaper({ doi: null, journal_url: "https://journal.example.com/article?id=7#s{2}" }),
      sentinel(),
    ]);

    expect(summary).toEqual({ paperCount: 4, affectedPaperCount: 0, exceptionalDoiCount: 0, exceptionalUrlCount: 0 });
    expect(await exported()).not.toContain("paperlume-");
  });

  it("counts one DOI written to its PaperLume field", async () => {
    const summary = exportToBibTeX([makePaper({ doi: "10.1000/x}" })]);

    expect(summary).toEqual({ paperCount: 1, affectedPaperCount: 1, exceptionalDoiCount: 1, exceptionalUrlCount: 0 });
    expect(paperLumeFields(await exported())).toEqual([["paperlume-doi-v1"]]);
  });

  it("counts one URL written to its PaperLume field", async () => {
    const summary = exportToBibTeX([makePaper({ doi: null, journal_url: "https://example.com/search?q={" })]);

    expect(summary).toEqual({ paperCount: 1, affectedPaperCount: 1, exceptionalDoiCount: 0, exceptionalUrlCount: 1 });
    expect(paperLumeFields(await exported())).toEqual([["paperlume-url-v1"]]);
  });

  it("counts a paper whose DOI and URL both moved once, and each of its fields", async () => {
    // A DOI with no prefix/suffix separator forms no resolver URL, so the
    // stored link is the URL written, and neither value can be written raw.
    const summary = exportToBibTeX([makePaper({ doi: "10.1000{x", journal_url: "https://example.com/?q=}" })]);

    expect(summary).toEqual({ paperCount: 1, affectedPaperCount: 1, exceptionalDoiCount: 1, exceptionalUrlCount: 1 });
    expect(paperLumeFields(await exported())).toEqual([["paperlume-doi-v1", "paperlume-url-v1"]]);
  });

  it("counts papers and fields across affected and unaffected papers", async () => {
    const summary = exportToBibTeX([
      makePaper({ id: "m1", title: "Ordinary" }),
      makePaper({ id: "m2", title: "Enclosed DOI", doi: "{10.1000/y}" }),
      makePaper({ id: "m3", title: "Link", doi: null, journal_url: `https://example.com/a?q=${BS}}` }),
      makePaper({ id: "m4", title: "Both", doi: "10.1000{x", journal_url: "https://example.com/?q={" }),
      makePaper({ id: "m5", title: "DOI beside a PMID", doi: "10.1000/}{", pmid: "12345678" }),
      makePaper({ id: "m6", title: "No identifiers", doi: null }),
      sentinel(),
    ]);

    expect(summary).toEqual({ paperCount: 7, affectedPaperCount: 4, exceptionalDoiCount: 3, exceptionalUrlCount: 2 });
    expect(paperLumeFields(await exported())).toEqual([
      [],
      ["paperlume-doi-v1"],
      ["paperlume-url-v1"],
      ["paperlume-doi-v1", "paperlume-url-v1"],
      ["paperlume-doi-v1"],
      [],
      [],
    ]);
  });

  it("counts only the URL the file holds, never a stored link passed over", async () => {
    const link = "https://example.com/?q={";
    const summary = exportToBibTeX([
      makePaper({ id: "u1", pmid: "12345678", doi: null, journal_url: link }),
      makePaper({ id: "u2", doi: null, pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/7654321/", journal_url: link }),
      makePaper({ id: "u3", doi: "10.1000/ok", journal_url: link }),
      makePaper({ id: "u4", pmid: "L629384756", doi: null, journal_url: link }),
    ]);
    const file = await exported();

    expect(summary).toEqual({ paperCount: 4, affectedPaperCount: 1, exceptionalDoiCount: 0, exceptionalUrlCount: 1 });
    expect(paperLumeFields(file)).toEqual([[], [], [], ["paperlume-url-v1"]]);
    expect(file).toContain("url       = {https://pubmed.ncbi.nlm.nih.gov/12345678/}");
    expect(file).toContain("url       = {https://pubmed.ncbi.nlm.nih.gov/7654321/}");
    expect(file).toContain("url       = {https://doi.org/10.1000/ok}");
    expect(file.split("  paperlume-url-v1 = ")).toHaveLength(2);
  });

  it("agrees with the file for any mix of DOIs, links and PMIDs", async () => {
    // Deterministic, so a failure reproduces.
    let seed = 0x5eed;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
    const DOIS = [null, "10.1000/ok", "10.1000/x}", "{10.1000/y}", `10.1000/a${LB}b`, "10.1000{x", `10.1000/${BS}`,
      "10.1000/a{b}c", "10.1000/}{", " 10.1000/z ", "{a}{b}", `{10.1000/${BS}}`] as const;
    const LINKS = [null, "https://journal.example.com/a?id=1", "https://example.com/?q={", "https://example.com/?q=}#{",
      `https://example.com/a?q=${BS}}`, "https://example.com/search?q={x}", "javascript:alert(1)"] as const;
    const PMIDS = [null, "12345678", "L629384756"] as const;
    const PUBMED_URLS = [null, "https://pubmed.ncbi.nlm.nih.gov/7654321/", "https://evil-pubmed.example/1"] as const;

    const seen = { affectedPaperCount: 0, exceptionalDoiCount: 0, exceptionalUrlCount: 0 };
    for (let round = 0; round < 40; round++) {
      const papers = Array.from({ length: 25 }, (_, i) =>
        makePaper({
          id: `r${round}-${i}`,
          doi: pick(DOIS),
          journal_url: pick(LINKS),
          pmid: pick(PMIDS),
          pubmed_url: pick(PUBMED_URLS),
        }),
      );
      const summary = exportToBibTeX(papers);
      const fields = paperLumeFields(await exported());
      const count = (name: string) => fields.filter((names) => names.includes(name)).length;

      expect(summary).toEqual({
        paperCount: fields.length,
        affectedPaperCount: fields.filter((names) => names.length > 0).length,
        exceptionalDoiCount: count("paperlume-doi-v1"),
        exceptionalUrlCount: count("paperlume-url-v1"),
      });
      expect(fields).toHaveLength(papers.length);
      seen.affectedPaperCount += summary.affectedPaperCount;
      seen.exceptionalDoiCount += summary.exceptionalDoiCount;
      seen.exceptionalUrlCount += summary.exceptionalUrlCount;
    }
    // The mix reached every count, so the agreement above is not vacuous.
    expect(Object.values(seen).every((total) => total > 0)).toBe(true);
  });

  it("downloads one file per export, and reports nothing when the download fails", () => {
    exportToBibTeX([makePaper({ doi: "10.1000/x}" }), sentinel()]);
    expect(downloads).toHaveLength(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);

    URL.createObjectURL = (() => {
      throw new Error("download blocked");
    }) as typeof URL.createObjectURL;
    expect(() => exportToBibTeX([makePaper({ doi: "10.1000/x}" })])).toThrow("download blocked");
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  });
});

describe("the year and the citation key stay inside their boundaries", () => {
  it("writes a numeric year and its key exactly as before", async () => {
    const file = await exportBib([
      makePaper({ title: "Alpha", authors: ["John Smith"], year: 2024 }),
      makePaper({ title: "Beta", authors: ["John Smith"], year: -44 }),
      makePaper({ title: "Gamma", authors: ["John Smith"], year: 0 }),
      makePaper({ title: "Delta", authors: ["John Smith"], year: null }),
    ]);
    const entries = bibtexEntries(file);

    expect(entries.map((entry) => entry.key)).toEqual(["Smith2024_Alpha", "Smith-44_Beta", "Smith0_Gamma", "Smithnd_Delta"]);
    expect(file).toContain("year      = {2024}");
    expect(file).toContain("year      = {-44}");
    // A year of 0 or null has never been written as a field.
    expect(entries[2].fields.some(([name]) => name === "year")).toBe(false);
    expect(entries[3].fields.some(([name]) => name === "year")).toBe(false);
  });

  it("neutralizes a year that is not a number at runtime", async () => {
    const injected = makePaper({
      title: "Real Title",
      authors: ["John Smith"],
      // Not the column's type, so not reachable through the typed API.
      year: "2020}, title = {Injected Title" as unknown as number,
    });
    const file = await exportBib([injected, sentinel()]);

    const entries = bibtexEntries(file);
    expect(entries).toHaveLength(2);
    expect(entries[0].key).toBe("Smithnd_Real");
    expect(fieldNames(entries[0])).toEqual(ALL_FIELDS);
    expect(file).toContain(String.raw`year      = {2020\textbraceright{}, title = \textbraceleft{}Injected Title}`);

    const { papers } = parseBibTeX(file);
    expect(papers).toHaveLength(2);
    expect(papers[0].title).toBe("Real Title");
    expect(papers[0].year).toBe(2020);
    expectSentinel(file, papers[1]);
  });
});

// ── Scientific text ──

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

describe("scientific text keeps its content through an export and re-import", () => {
  const SCIENTIFIC: readonly string[] = [
    `${cp(0x3b1)}-synuclein and ${cp(0x3b2)}-amyloid in ${cp(0x394)}F508 carriers (${cp(0x3bc)}g/mL)`,
    `x ${cp(0x2264)} y ${cp(0x2265)} z, a ${cp(0xb1)} b, 3 ${cp(0xd7)} 4, ${cp(0x221a)}2, ${cp(0x2211)} x${cp(0x1d62)}, n ${cp(0x2192)} ${cp(0x221e)}, ${cp(0x2248)} 0`,
    `CO${cp(0x2082)} and H${cp(0x2082)}O; Ca${cp(0xb2, 0x207a)} and [Fe(CN)${cp(0x2086)}]${cp(0xb3, 0x207b)}`,
    "1,2-dichloroethane, (R)-2-aminopropanoic acid and trans-4-hydroxy-L-proline",
    "p < 0.05; OR = 2.1 (95% CI 1.3-3.4); n = 1,024; I^2 = 45%; mean +/- SD",
    `${cp(0x3c7, 0xb2)}(2) = 7.5, R${cp(0xb2)} = 0.81, ${cp(0x3b2)} = ${cp(0x2212)}0.12, HR 0.7 [0.5, 0.9]`,
    "Costs of $12,000 (#1 ranked), x_i and e^{-x}, ~10 mg, 50% & more",
    String.raw`LaTeX in a title: \alpha, \textbackslash{}, \textasciitilde{}, \'e, \{, \\`,
    `"Quoted", 'single' and ${cp(0x201c)}curly${cp(0x201d)} quotes`,
    `Nested {capitalization {groups}} and {DNA} {mRNA}`,
  ];

  for (const text of SCIENTIFIC) {
    it(JSON.stringify(text).slice(0, 80), async () => {
      const file = await exportBib([makePaper({ title: text, journal: text, abstract: text, study_type: text })]);

      // Ordinary Unicode is written as itself, not as LaTeX.
      for (const character of text) {
        if (character.codePointAt(0)! > 0x7f) expect(file).toContain(character);
      }

      const paper = parseBibTeX(file).papers[0];
      expect(paper.title).toBe(text);
      expect(paper.journal).toBe(text);
      expect(paper.abstract).toBe(text);
      expect(paper.study_type).toBe(text);
    });
  }

  it("keeps a multiline abstract, blank lines included", async () => {
    const abstract = "Background: x.\n\nMethods: y & z.\r\nResults: 95% CI [1, 2].\n\n\nConclusion: {done}.";
    const paper = parseBibTeX(await exportBib([makePaper({ abstract })])).papers[0];
    expect(paper.abstract).toBe(abstract);
  });

  it("keeps accented author names, in the exporter's Last, First order", async () => {
    const file = await exportBib([
      makePaper({
        authors: [
          `Jos${cp(0xe9)} Garc${cp(0xed)}a`,
          `Zo${cp(0xeb)} M${cp(0xfc)}ller-L${cp(0xfc)}denscheidt`,
          `${cp(0x141)}ukasz ${cp(0x17b)}${cp(0xf3)}${cp(0x142)}${cp(0x107)}`,
          "Consortium",
        ],
      }),
    ]);

    expect(parseBibTeX(file).papers[0].authors).toEqual([
      `Garc${cp(0xed)}a, Jos${cp(0xe9)}`,
      `M${cp(0xfc)}ller-L${cp(0xfc)}denscheidt, Zo${cp(0xeb)}`,
      `${cp(0x17b)}${cp(0xf3)}${cp(0x142)}${cp(0x107)}, ${cp(0x141)}ukasz`,
      "Consortium",
    ]);
  });
});

describe("repeated export and import cycles are stable", () => {
  it("writes the same bytes on the second and third cycle", async () => {
    const original = [
      makePaper({
        title: String.raw`C:\data, {HIV} & a } b, \textasciitilde{} 50% ~ ^`,
        authors: ["Consortium", "x}y"],
        journal: "J. {Sci} & Tech_",
        abstract: "Line {one}\nLine } two",
        keywords: ["a_b", "c{d"],
        study_type: "Cohort #1",
        doi: "10.1000/x}",
        pmid: "12345678",
      }),
      makePaper({ doi: null, journal_url: "https://example.com/?q=}", title: "Second" }),
    ];

    const cycle = async (papers: PaperWithTags[]) => {
      const file = await exportBib(papers);
      const back = parseBibTeX(file).papers.map((raw, index) =>
        makePaper({
          id: `c${index}`,
          title: raw.title,
          authors: raw.authors,
          year: raw.year,
          journal: raw.journal,
          pmid: raw.pmid,
          doi: raw.doi,
          abstract: raw.abstract,
          keywords: raw.keywords,
          study_type: raw.study_type,
          pubmed_url: raw.pubmed_url,
          journal_url: raw.journal_url,
        }),
      );
      return { file, back };
    };

    const first = await cycle(original);
    const second = await cycle(first.back);
    const third = await cycle(second.back);

    expect(first.back.map((paper) => [paper.title, paper.abstract, paper.doi, paper.keywords])).toEqual(
      original.map((paper) => [paper.title, paper.abstract, paper.doi, paper.keywords]),
    );
    expect(first.back[1].journal_url).toBe("https://example.com/?q=}");
    expect(third.file).toBe(second.file);
    // The exceptional DOI and link stay in their PaperLume fields on every
    // cycle, and no escaping accumulates from one cycle to the next.
    for (const { file } of [first, second, third]) {
      expect(file).toContain(`  paperlume-doi-v1 = {10.1000/x${RB}}`);
      expect(file).toContain(`  paperlume-url-v1 = {https://example.com/?q=${RB}}`);
      expect(file).not.toMatch(/^ {2}doi\s/m);
    }
    expect(second.file).not.toContain(String.raw`\textbackslash{}textbackslash`);
  });
});

// ── Older Paperlume exports ──

/**
 * A file written by the exporter before this change (main a110b4ce), captured
 * byte for byte. Every backslash is `\textbackslash\{\}`.
 */
const LEGACY_EXPORT = String.raw`@article{Gomez2024_Paths,
  title     = {{Paths like C:\textbackslash\{\}data use \textbackslash\{\} and \{braces\}}},
  author    = {Gomez, Ana and Consortium},
  year      = {2024},
  journal   = {J. Sci. \& Tech.},
  doi       = {10.1000/456#789},
  pmid      = {12345678},
  url       = {https://pubmed.ncbi.nlm.nih.gov/12345678/},
  abstract  = {Line one: 50\% of x\_i \textasciitilde{} 2\textasciicircum{}3.
Line two: \{kept\} \$5 \#1.},
  keywords  = {p<0.05, x\_i},
  note      = {Study type: Cohort}
}

@article{Lee2024_textasciitilde,
  title     = {{On \textbackslash\{\}textasciitilde\{\} and \textbackslash\{\}textasciicircum\{\} in titles}},
  author    = {Lee},
  year      = {2024},
  doi       = {10.1056/NEJMoa2107934},
  url       = {https://doi.org/10.1056/NEJMoa2107934},
  keywords  = {\textbackslash\{\}textbackslash\{\}}
}

@article{Unknownnd_HIV,
  title     = {{The \{HIV\} Epidemic}},
  url       = {https://journal.example.com/article?id=7#s2}
}`;

describe("older Paperlume exports still import", () => {
  it("reads every value of a structurally valid older export", () => {
    const { papers, warnings } = parseBibTeX(LEGACY_EXPORT);

    expect(warnings).toEqual([]);
    expect(papers).toHaveLength(3);
    expect(papers[0]).toMatchObject({
      title: String.raw`Paths like C:\data use \ and {braces}`,
      authors: ["Gomez, Ana", "Consortium"],
      journal: "J. Sci. & Tech.",
      abstract: "Line one: 50% of x_i ~ 2^3.\nLine two: {kept} $5 #1.",
      keywords: ["p<0.05", "x_i"],
      doi: "10.1000/456#789",
      pmid: "12345678",
      study_type: "Cohort",
    });
    // The importer before this change read this title as "On ~ and ^ in titles".
    expect(papers[1].title).toBe(String.raw`On \textasciitilde{} and \textasciicircum{} in titles`);
    expect(papers[1].keywords).toEqual([String.raw`\textbackslash{}`]);
    expect(papers[2]).toMatchObject({
      title: "The {HIV} Epidemic",
      journal_url: "https://journal.example.com/article?id=7#s2",
    });
  });

  it("re-exports an older export's papers in the current form", async () => {
    const papers = parseBibTeX(LEGACY_EXPORT).papers.map((raw) =>
      makePaper({ title: raw.title, authors: raw.authors, journal: raw.journal, doi: raw.doi, abstract: raw.abstract }),
    );
    const file = await exportBib(papers);

    expect(file).toContain(String.raw`title     = {{Paths like C:\textbackslash{}data use \textbackslash{} and \{braces\}}}`);
    expect(file).not.toContain(String.raw`\textbackslash\{\}`);
  });

  it("reads an older export whose literal braces cross, as before", () => {
    // Captured from the exporter on main a110b4ce. In the double-braced title
    // the crossed `\}` and `\{` still balance, so the title is intact. The
    // enclosing pair is the exporter's own and is stripped, because an escaped
    // brace never closes a group. In the single-braced journal, BibTeX ends the
    // field at `\}`, so the old file already lost the rest of that value.
    const crossed = String.raw`@article{Kim2022_Ranges,
  title     = {{Ranges like a \} b \{ c}},
  author    = {Kim},
  year      = {2022},
  journal   = {Notes \} and \{ more}
}`;
    const [paper] = parseBibTeX(crossed).papers;

    expect(paper.title).toBe("Ranges like a } b { c");
    expect(paper.journal).toBe(`Notes ${BS}`);
    expect(paper.authors).toEqual(["Kim"]);
  });

  it("reads a structurally broken older export exactly as before, without guessing", () => {
    // The old exporter wrote a lone brace as `\}`, which BibTeX counts as a
    // closing brace. This entry therefore ends inside its title, and its other
    // fields lie outside any entry. They are not reconstructed: the importer
    // reads the file as BibTeX does, as it did before.
    const broken = String.raw`@article{Consortium2024_b,
  title     = {{a \} b}},
  author    = {Consortium},
  year      = {2024}
}

@article{Lee2023_Sentinel,
  title     = {{Sentinel}},
  author    = {Lee},
  year      = {2023}
}`;
    const { papers } = parseBibTeX(broken);

    expect(papers.map((paper) => [paper.title, paper.authors, paper.year])).toEqual([
      ["{a } b", [], null],
      ["Sentinel", ["Lee"], 2023],
    ]);
  });
});

// ── An ordinary record is unchanged ──

describe("an ordinary record is written exactly as before", () => {
  it("matches the previous exporter byte for byte", async () => {
    const file = await exportBib([
      makePaper({
        title: "Effects of {HIV} & co-infection: 50% of x_i at $5 (#1) ~ 2^3",
        authors: ["Maria Garcia", "Consortium"],
        journal: "J. Sci. & Tech.",
        pmid: "12345678",
        doi: "10.1000/456#789",
        abstract: "Line one, p < 0.05.\nLine two: {kept} 95% CI [1.2, 3.4].",
        keywords: ["x_i", "p<0.05"],
        mesh_terms: ["Neoplasms"],
        study_type: "Randomized Controlled Trial",
        journal_url: "https://journal.example.com/a?b=c#d",
      }),
    ]);

    // Captured from the exporter on main a110b4ce.
    expect(file).toBe(String.raw`@article{Garcia2024_Effects,
  title     = {{Effects of \{HIV\} \& co-infection: 50\% of x\_i at \$5 (\#1) \textasciitilde{} 2\textasciicircum{}3}},
  author    = {Garcia, Maria and Consortium},
  year      = {2024},
  journal   = {J. Sci. \& Tech.},
  doi       = {10.1000/456#789},
  pmid      = {12345678},
  url       = {https://pubmed.ncbi.nlm.nih.gov/12345678/},
  abstract  = {Line one, p < 0.05.
Line two: \{kept\} 95\% CI [1.2, 3.4].},
  keywords  = {x\_i, p<0.05, Neoplasms},
  note      = {Study type: Randomized Controlled Trial}
}`);
  });
});

// ── Independently authored files ──

describe("BibTeX written by other tools", () => {
  it("reads a hand-written file with groups, accents, quotes and macros", () => {
    const file = String.raw`@comment{ Written by hand; braces {balanced} here }
@string{jot = {Journal of Testing}}
@preamble{"\newcommand{\noopsort}[1]{}"}

@article{Garcia2020,
  title = {{\'E}tude of {HIV} and {AIDS} in {Caf\'e} Society},
  author = {Garc{\'i}a, Mar{\'i}a and {World Health Organization}},
  journal = "Journal of {T}esting \& Methods",
  year = 2020,
  doi = {10.1000/xyz123},
  url = {https://www.ncbi.nlm.nih.gov/pubmed/12345678},
  keywords = {meta-analysis, {HIV}},
  abstract = {A 95\% CI of 1.2--3.4 and \$5 cost; \textasciitilde{}10 mg.},
}

@article{zotero_2021,
	title = {${cp(0xc5)}ngstr${cp(0xf6)}m-scale {CO}$_2$ capture: a 50\% gain},
	doi = {10.1002/(SICI)1097-4636(199706)35:4<487::AID-JBM9>3.0.CO;2-K},
	journal = {Nature {Methods}},
	author = {Ng, Andrew and ${cp(0xd8)}ster, Bo},
	year = {2021},
	note = {Publisher: Example Press},
}`;
    const { papers, warnings } = parseBibTeX(file);

    expect(warnings).toEqual([]);
    expect(papers).toHaveLength(2);
    expect(papers[0]).toMatchObject({
      title: "Étude of {HIV} and {AIDS} in {Café} Society",
      authors: ["García, María", "World Health Organization"],
      journal: "Journal of {T}esting & Methods",
      year: 2020,
      doi: "10.1000/xyz123",
      pmid: "12345678",
      pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
      journal_url: null,
      keywords: ["meta-analysis", "HIV"],
      abstract: "A 95% CI of 1.2--3.4 and $5 cost; ~10 mg.",
    });
    expect(papers[1]).toMatchObject({
      title: `${cp(0xc5)}ngstr${cp(0xf6)}m-scale {CO}$_2$ capture: a 50% gain`,
      doi: "10.1002/(SICI)1097-4636(199706)35:4<487::AID-JBM9>3.0.CO;2-K",
      journal: "Nature {Methods}",
      authors: ["Ng, Andrew", `${cp(0xd8)}ster, Bo`],
      year: 2021,
      study_type: null,
      pmid: null,
    });
  });
});

// ── Malformed input ──

describe("malformed input ends with a bounded result", () => {
  const MALFORMED: ReadonlyArray<readonly [label: string, file: string, titles: string[]]> = [
    ["an unclosed entry", "@article{k, title = {Unclosed", []],
    ["an unclosed quote", '@article{k, title = "Unclosed quote}', ["Unclosed quote"]],
    ["a run of at signs", "@".repeat(200), []],
    ["deep unclosed nesting", `@article{k, title = ${"{".repeat(2000)}x${"}".repeat(1999)}`, []],
    ["a key with no comma", "@article{k title = {No comma}}", []],
    ["a field with no equals sign", "@article{k, title {No equals}, author = {A}}", []],
    ["only a line comment", "% nothing here", []],
    // As in BibTeX, an unclosed brace runs to the end of the file.
    ["an unclosed entry before a valid one", "@article{bad, title = {Unclosed\n@article{good, title = {Good}}", []],
    ["a stray closing brace between entries", "@article{a, title = {A}}\n}\n@article{b, title = {B}}", ["A", "B"]],
  ];

  for (const [label, file, titles] of MALFORMED) {
    it(label, () => {
      const result = parseBibTeX(file);
      expect(result.papers.map((paper) => paper.title)).toEqual(titles);
      if (titles.length === 0) expect(result.warnings.length).toBeGreaterThan(0);
    });
  }

  it("returns nothing and warns nothing for an empty file", () => {
    expect(parseBibTeX("")).toEqual({ papers: [], warnings: [] });
  });
});
