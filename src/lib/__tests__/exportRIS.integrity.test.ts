import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { exportToBibTeX, exportToCSV, exportToRIS } from "../exportUtils";
import { parseRIS } from "../importParsers";
import type { PaperWithTags, Project, Tag } from "@/types/database";

/**
 * RIS record integrity.
 *
 * A RIS file is a sequence of lines. A line that starts with a tag ("XX  - ")
 * begins a field; a `TY` line begins a record and an `ER` line ends it. The
 * exporter used to write every stored value straight after its tag, so a line
 * break in a value started a line of its own: text such as "ER  - " or
 * "AU  - Name" there ended the record or added a field, and everything after
 * the first line break was lost on import. One paper could come back as two.
 *
 * The contract pinned here:
 *
 *  - every exported paper is exactly one record: one `TY` line, one `ER` line,
 *    and its fields in their fixed order;
 *  - a field that holds one value (title, year, journal, PMID, DOI, the three
 *    links, abstract, note) writes each further line of its value on a
 *    continuation line, six spaces and then the text, and `parseRIS` reads the
 *    value back whole, with LF where it had CR LF or CR;
 *  - a list element (author, keyword, MeSH term, substance, tag, project)
 *    stays on its one tagged line, with each line break in it written as one
 *    space;
 *  - a value with no line break is written exactly as before.
 *
 * Two readers are used, so the exporter and the importer are never each
 * other's only oracle: `readRecords`, written for this suite from the grammar
 * above, which rejects any line that is neither a field nor a continuation,
 * any `TY` or `ER` inside a record and any empty line inside a record; and
 * `parseRIS`, the app's importer, for the round trip. Expected values are
 * written out by hand.
 */

const CR = "\r";
const LF = "\n";
const INDENT = "      ";
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const NEXT_LINE = String.fromCodePoint(0x85);

// ── Capture the exported file instead of downloading it ──

let downloads: Blob[] = [];
let downloadNames: string[] = [];

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  downloads = [];
  downloadNames = [];
  URL.createObjectURL = ((blob: Blob) => {
    downloads.push(blob);
    return "blob:captured";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloadNames.push(this.download);
  });
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

/** The bytes of the most recent download. (jsdom's `Blob` has no `arrayBuffer()`.) */
const lastDownloadBytes = (): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(downloads[downloads.length - 1]);
  });

/**
 * Exports `papers` as RIS and returns the file's text. Every export here is
 * also checked for what holds of any RIS file this app writes: one download,
 * valid UTF-8 with no byte order mark, and no carriage return anywhere.
 */
async function exportRIS(papers: PaperWithTags[]): Promise<string> {
  const before = downloads.length;
  exportToRIS(papers);
  expect(downloads.length).toBe(before + 1);
  const bytes = await lastDownloadBytes();
  expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  expect(text).not.toContain(CR);
  return text;
}

/** The text of the most recent download (CSV and BibTeX). */
async function lastDownloadText(): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await lastDownloadBytes());
}

// ── An independent reader for the grammar the exporter writes ──

/** One field as `readRecords` found it: its tag and the lines of its value. */
interface RisField {
  tag: string;
  lines: string[];
}

const field = (tag: string, ...lines: string[]): RisField => ({ tag, lines });

/**
 * Reads a file in the grammar the exporter writes, and nothing else: records
 * separated by one empty line, each `TY  - JOUR`, then fields, then `ER  - `.
 * A field is a tag line, `XX  - text`, followed by any continuation lines, six
 * spaces then text. Anything else throws, naming the record.
 */
function readRecords(file: string): RisField[][] {
  if (file === "") return [];
  return file.split(LF + LF).map((block, index) => {
    const where = `record ${index + 1}`;
    const lines = block.split(LF);
    if (lines[0] !== "TY  - JOUR") throw new Error(`${where} does not start with its TY line: ${JSON.stringify(lines[0])}`);
    if (lines.length < 2 || lines[lines.length - 1] !== "ER  - ") throw new Error(`${where} does not end with its ER line`);
    const fields: RisField[] = [];
    for (const line of lines.slice(1, -1)) {
      const tagged = /^([A-Z][A-Z0-9]) {2}- ([^\n]*)$/.exec(line);
      if (tagged) {
        if (tagged[1] === "TY" || tagged[1] === "ER") throw new Error(`${where} has a ${tagged[1]} line inside it`);
        fields.push(field(tagged[1], tagged[2]));
      } else if (line.startsWith(INDENT) && fields.length > 0) {
        fields[fields.length - 1].lines.push(line.slice(INDENT.length));
      } else {
        throw new Error(`${where} has a line that is neither a field nor a continuation: ${JSON.stringify(line)}`);
      }
    }
    return fields;
  });
}

// ── Fixtures ──

function paper(overrides: Partial<PaperWithTags> = {}): PaperWithTags {
  return {
    id: "paper-1",
    user_id: "user-1",
    title: "Effect of Treatment on Outcomes",
    authors: [],
    year: null,
    journal: null,
    pmid: null,
    doi: null,
    abstract: null,
    study_type: null,
    raw_study_type: null,
    statistical_methods: null,
    keywords: [],
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

const tags = (...names: string[]): Tag[] =>
  names.map((name, i) => ({ id: `tag-${i}`, user_id: "user-1", name, color: "#000000", created_at: "2024-01-01" }));

const projects = (...names: string[]): Project[] =>
  names.map((name, i) => ({ id: `project-${i}`, user_id: "user-1", name, description: null, color: "#000000", created_at: "2024-01-01" }));

/** A record exported after an affected one, which must come through untouched. */
const SENTINEL = paper({
  id: "sentinel",
  title: "Sentinel record",
  authors: ["Sentinel, Sam"],
  year: 2001,
  doi: "10.5555/sentinel.2001",
  keywords: ["sentinel keyword"],
});
const SENTINEL_FIELDS: RisField[] = [
  field("T1", "Sentinel record"),
  field("AU", "Sentinel, Sam"),
  field("PY", "2001"),
  field("DO", "10.5555/sentinel.2001"),
  field("UR", "https://doi.org/10.5555/sentinel.2001"),
  field("KW", "sentinel keyword"),
];

/** The sentinel as `parseRIS` must read it back. */
function expectSentinel(imported: ReturnType<typeof parseRIS>["papers"][number] | undefined): void {
  expect(imported).toMatchObject({
    title: "Sentinel record",
    authors: ["Sentinel, Sam"],
    year: 2001,
    doi: "10.5555/sentinel.2001",
    keywords: ["sentinel keyword"],
    pmid: null,
    pubmed_url: null,
    journal_url: "https://doi.org/10.5555/sentinel.2001",
  });
}

/**
 * A multi-line value made of RIS record syntax: an `ER` line, an empty line, a
 * whole injected record, an indented line and tag lines for an author, a
 * keyword, a DOI, a PubMed link and an accession number.
 */
const HOSTILE_LINES = [
  "Opening line.",
  "ER  - ",
  "",
  "TY  - JOUR",
  "T1  - Injected record",
  "AU  - Injected, Author",
  "KW  - injected",
  "DO  - 10.9999/injected",
  "UR  - https://pubmed.ncbi.nlm.nih.gov/99999999/",
  "AN  - 99999999",
  "  Indented line.",
  "Closing line.",
];
const HOSTILE = HOSTILE_LINES.join(LF);
/** The same value as one list element writes it: each line break a space. */
const HOSTILE_FLAT = HOSTILE_LINES.join(" ");

/** No record, field or identifier came from text inside a stored value. */
function expectNothingInjected(papers: ReturnType<typeof parseRIS>["papers"]): void {
  for (const p of papers) {
    expect(p.title).not.toBe("Injected record");
    expect(p.authors).not.toContain("Injected, Author");
    expect(p.keywords).not.toContain("injected");
    expect(p.doi).not.toBe("10.9999/injected");
    expect(p.pmid).not.toBe("99999999");
  }
}

// ── A. One ordinary record ──

describe("A. an ordinary record is written byte for byte as before", () => {
  const ordinary = paper({
    title: "Vitamin D and fracture risk: a trial",
    authors: ["Müller, Anna", "O'Brien, Seán", "Synthetic Trials Consortium"],
    year: 2024,
    journal: "Journal of Synthetic Trials",
    pmid: "12345678",
    doi: "10.1000/456#789",
    journal_url: "https://journal.example/article/1",
    drive_url: "https://drive.example/file/abc",
    abstract: "Risk fell (HR 0.82; 95% CI 0.71–0.95; p < 0.01) in ≥ 65-year-olds; α = 0.05.",
    keywords: ["vitamin D", "fracture"],
    mesh_terms: ["Fractures, Bone/prevention & control"],
    substances: ["Cholecalciferol"],
    study_type: "Randomized Controlled Trial",
    tags: tags("to read"),
    projects: projects("Bone review"),
  });

  // Written out from main a9c40ea6's output for the same paper.
  const ORDINARY_FILE = [
    "TY  - JOUR",
    "T1  - Vitamin D and fracture risk: a trial",
    "AU  - Müller, Anna",
    "AU  - O'Brien, Seán",
    "AU  - Synthetic Trials Consortium",
    "PY  - 2024",
    "JO  - Journal of Synthetic Trials",
    "AN  - 12345678",
    "DO  - 10.1000/456#789",
    "UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/",
    "L2  - https://journal.example/article/1",
    "L1  - https://drive.example/file/abc",
    "AB  - Risk fell (HR 0.82; 95% CI 0.71–0.95; p < 0.01) in ≥ 65-year-olds; α = 0.05.",
    "KW  - vitamin D",
    "KW  - fracture",
    "KW  - Fractures, Bone/prevention & control",
    "KW  - Cholecalciferol",
    "N1  - Randomized Controlled Trial",
    "C1  - to read",
    "C2  - Bone review",
    "ER  - ",
  ].join(LF);

  it("writes the same bytes", async () => {
    expect(await exportRIS([ordinary])).toBe(ORDINARY_FILE);
  });

  it("keeps the file name and media type", async () => {
    await exportRIS([ordinary]);
    expect(downloadNames).toEqual(["citations.ris"]);
    expect(downloads[0].type).toBe("application/x-research-info-systems;charset=utf-8;");
  });

  it("reads back with every field", async () => {
    const { papers, warnings } = parseRIS(await exportRIS([ordinary]));
    expect(warnings).toEqual([]);
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({
      title: "Vitamin D and fracture risk: a trial",
      authors: ["Müller, Anna", "O'Brien, Seán", "Synthetic Trials Consortium"],
      year: 2024,
      journal: "Journal of Synthetic Trials",
      pmid: "12345678",
      doi: "10.1000/456#789",
      abstract: "Risk fell (HR 0.82; 95% CI 0.71–0.95; p < 0.01) in ≥ 65-year-olds; α = 0.05.",
      keywords: ["vitamin D", "fracture", "Fractures, Bone/prevention & control", "Cholecalciferol"],
      study_type: "Randomized Controlled Trial",
      pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
      journal_url: "https://journal.example/article/1",
      drive_url: "https://drive.example/file/abc",
    });
  });
});

// ── B. Multiple ordinary records ──

describe("B. several ordinary records", () => {
  it("are written as before, one empty line between records and none after the last", async () => {
    const file = await exportRIS([
      paper({ title: "First", authors: ["One, A"], year: 2020 }),
      paper({ title: "DOI only", doi: "10.5555/abc.2024.001" }),
      paper({ title: "Title only" }),
    ]);
    expect(file).toBe(
      [
        "TY  - JOUR",
        "T1  - First",
        "AU  - One, A",
        "PY  - 2020",
        "ER  - ",
        "",
        "TY  - JOUR",
        "T1  - DOI only",
        "DO  - 10.5555/abc.2024.001",
        "UR  - https://doi.org/10.5555/abc.2024.001",
        "ER  - ",
        "",
        "TY  - JOUR",
        "T1  - Title only",
        "ER  - ",
      ].join(LF),
    );
    expect(readRecords(file)).toHaveLength(3);
    expect(parseRIS(file).papers.map((p) => p.title)).toEqual(["First", "DOI only", "Title only"]);
  });
});

// ── C–J. Every field that can hold a line break ──

/** Fields that hold one value: their lines go on continuation lines. */
const SINGLE_VALUE_FIELDS: {
  name: string;
  tag: string;
  set: (value: string) => Partial<PaperWithTags>;
  read: (p: ReturnType<typeof parseRIS>["papers"][number]) => unknown;
}[] = [
  { name: "C. title", tag: "T1", set: (v) => ({ title: v }), read: (p) => p.title },
  { name: "E. journal", tag: "JO", set: (v) => ({ journal: v }), read: (p) => p.journal },
  { name: "F. abstract", tag: "AB", set: (v) => ({ abstract: v }), read: (p) => p.abstract },
  { name: "H. study-type note", tag: "N1", set: (v) => ({ study_type: v }), read: (p) => p.study_type },
  { name: "K. DOI", tag: "DO", set: (v) => ({ doi: v }), read: (p) => p.doi },
  { name: "L. attachment link", tag: "L1", set: (v) => ({ drive_url: v }), read: (p) => p.drive_url },
];

describe("a field that holds one value keeps every line of it inside its field", () => {
  describe.each(SINGLE_VALUE_FIELDS)("$name ($tag)", ({ tag, set, read }) => {
    it("is one record, the value's lines on continuation lines, and the next record intact", async () => {
      const file = await exportRIS([paper(set(HOSTILE)), SENTINEL]);
      const records = readRecords(file);
      expect(records).toHaveLength(2);
      expect(records[0].filter((f) => f.tag === tag)).toEqual([field(tag, ...HOSTILE_LINES)]);
      expect(records[0].map((f) => f.tag)).not.toContain("AU");
      expect(records[1]).toEqual(SENTINEL_FIELDS);
    });

    it("reads back as the same value, with nothing injected", async () => {
      const { papers, warnings } = parseRIS(await exportRIS([paper(set(HOSTILE)), SENTINEL]));
      expect(warnings).toEqual([]);
      expect(papers).toHaveLength(2);
      expect(read(papers[0])).toBe(HOSTILE);
      expect(papers[0].authors).toEqual([]);
      expect(papers[0].keywords).toEqual([]);
      expectNothingInjected(papers);
      expectSentinel(papers[1]);
    });
  });

  it("J. a year that is not a number at runtime stays in its PY field", async () => {
    const year = ["2020", "ER  - ", "TY  - JOUR", "T1  - Injected via the year"].join(LF);
    const file = await exportRIS([paper({ year: year as unknown as number }), SENTINEL]);
    const records = readRecords(file);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual([
      field("T1", "Effect of Treatment on Outcomes"),
      field("PY", "2020", "ER  - ", "TY  - JOUR", "T1  - Injected via the year"),
    ]);
    const { papers } = parseRIS(file);
    expect(papers.map((p) => p.title)).toEqual(["Effect of Treatment on Outcomes", "Sentinel record"]);
    expect(papers[0].year).toBe(2020);
    expectSentinel(papers[1]);
  });

  it("J. a numeric year is written as before", async () => {
    const file = await exportRIS([paper({ year: 2020 }), paper({ year: -44 }), paper({ year: 2020.5 }), paper({ year: 0 })]);
    expect(readRecords(file).map((r) => r.filter((f) => f.tag === "PY"))).toEqual([
      [field("PY", "2020")],
      [field("PY", "-44")],
      [field("PY", "2020.5")],
      [],
    ]);
  });
});

/** Repeated list fields: each element stays on its own line. */
const LIST_FIELDS: {
  name: string;
  tag: string;
  set: (values: string[]) => Partial<PaperWithTags>;
  read: ((p: ReturnType<typeof parseRIS>["papers"][number]) => unknown) | null;
}[] = [
  { name: "D. author", tag: "AU", set: (v) => ({ authors: v }), read: (p) => p.authors },
  { name: "G. keyword", tag: "KW", set: (v) => ({ keywords: v }), read: (p) => p.keywords },
  { name: "G. MeSH term", tag: "KW", set: (v) => ({ mesh_terms: v }), read: (p) => p.keywords },
  { name: "G. substance", tag: "KW", set: (v) => ({ substances: v }), read: (p) => p.keywords },
  // Tags and projects are exported for other tools; `parseRIS` does not read them.
  { name: "I. tag", tag: "C1", set: (v) => ({ tags: tags(...v) }), read: null },
  { name: "I. project", tag: "C2", set: (v) => ({ projects: projects(...v) }), read: null },
];

describe("a list element stays one element on one line", () => {
  describe.each(LIST_FIELDS)("$name ($tag)", ({ tag, set, read }) => {
    const values = ["First element", HOSTILE, `Last${CR}${LF}element${CR}here`];
    const written = ["First element", HOSTILE_FLAT, "Last element here"];

    it("writes each element on its own line, line breaks as spaces, in order", async () => {
      const file = await exportRIS([paper(set(values)), SENTINEL]);
      const records = readRecords(file);
      expect(records).toHaveLength(2);
      expect(records[0].filter((f) => f.tag === tag)).toEqual(written.map((w) => field(tag, w)));
      expect(records[1]).toEqual(SENTINEL_FIELDS);
    });

    it("reads back as the same number of elements, nothing injected", async () => {
      const { papers, warnings } = parseRIS(await exportRIS([paper(set(values)), SENTINEL]));
      expect(warnings).toEqual([]);
      expect(papers).toHaveLength(2);
      if (read) expect(read(papers[0])).toEqual(written);
      expectNothingInjected(papers);
      expectSentinel(papers[1]);
    });
  });

  it("L. an author keeps its one mention and its provenance", async () => {
    const { papers } = parseRIS(await exportRIS([paper({ authors: ["Smith,\nJohn", "Roe, R"] })]));
    expect(papers[0].authors).toEqual(["Smith, John", "Roe, R"]);
    expect(papers[0].author_provenance!.map((a) => [a.source_field, a.kind, a.source_name])).toEqual([
      ["AU", "unknown", "Smith, John"],
      ["AU", "unknown", "Roe, R"],
    ]);
  });

  it("an empty element is written as before and skipped on import", async () => {
    const file = await exportRIS([paper({ authors: ["", "Roe, R"], keywords: [""] })]);
    expect(file).toBe(["TY  - JOUR", "T1  - Effect of Treatment on Outcomes", "AU  - ", "AU  - Roe, R", "KW  - ", "ER  - "].join(LF));
    expect(parseRIS(file).papers[0]).toMatchObject({ authors: ["Roe, R"], keywords: [] });
  });
});

describe("every field at once", () => {
  it("one record per paper, whatever every field holds", async () => {
    const everything = paper({
      title: HOSTILE,
      authors: [HOSTILE],
      year: HOSTILE as unknown as number,
      journal: HOSTILE,
      doi: HOSTILE,
      drive_url: HOSTILE,
      abstract: HOSTILE,
      keywords: [HOSTILE],
      mesh_terms: [HOSTILE],
      substances: [HOSTILE],
      study_type: HOSTILE,
      tags: tags(HOSTILE),
      projects: projects(HOSTILE),
    });
    const file = await exportRIS([SENTINEL, everything, everything, SENTINEL]);
    const records = readRecords(file);
    expect(records).toHaveLength(4);
    expect(records[0]).toEqual(SENTINEL_FIELDS);
    expect(records[3]).toEqual(SENTINEL_FIELDS);
    expect(records[1].map((f) => f.tag)).toEqual(["T1", "AU", "PY", "JO", "DO", "UR", "L1", "AB", "KW", "KW", "KW", "N1", "C1", "C2"]);
    for (const f of records[1]) {
      if (["AU", "KW", "C1", "C2"].includes(f.tag)) expect(f.lines).toEqual([HOSTILE_FLAT]);
      else if (f.tag !== "UR") expect(f.lines).toEqual(HOSTILE_LINES);
    }
    const { papers, warnings } = parseRIS(file);
    expect(warnings).toEqual([]);
    expect(papers).toHaveLength(4);
    expectNothingInjected(papers);
    expectSentinel(papers[0]);
    expectSentinel(papers[3]);
    expect(papers[1]).toMatchObject({
      title: HOSTILE,
      authors: [HOSTILE_FLAT],
      journal: HOSTILE,
      doi: HOSTILE,
      drive_url: HOSTILE,
      abstract: HOSTILE,
      keywords: [HOSTILE_FLAT, HOSTILE_FLAT, HOSTILE_FLAT],
      study_type: HOSTILE,
      pmid: null,
      pubmed_url: null,
    });
  });
});

// ── K. Identifiers and links ──

describe("K. identifiers and links keep their meaning", () => {
  it("the DOI field holds the DOI name and the resolver link its encoded form", async () => {
    const file = await exportRIS([paper({ doi: "10.1000/456#789" })]);
    expect(readRecords(file)[0]).toEqual([
      field("T1", "Effect of Treatment on Outcomes"),
      field("DO", "10.1000/456#789"),
      field("UR", "https://doi.org/10.1000/456%23789"),
    ]);
    expect(parseRIS(file).papers[0]).toMatchObject({ doi: "10.1000/456#789", journal_url: "https://doi.org/10.1000/456%23789" });
  });

  it("a DOI with a line break keeps its characters in DO, and its link is encoded once", async () => {
    const doi = `10.1000/line${LF}break`;
    const file = await exportRIS([paper({ doi })]);
    expect(readRecords(file)[0]).toEqual([
      field("T1", "Effect of Treatment on Outcomes"),
      field("DO", "10.1000/line", "break"),
      field("UR", "https://doi.org/10.1000/line%0Abreak"),
    ]);
    expect(parseRIS(file).papers[0]).toMatchObject({ doi, pmid: null, journal_url: "https://doi.org/10.1000/line%0Abreak" });
  });

  it("a stored PMID with a line break after its digits is exported as its digits", async () => {
    const file = await exportRIS([paper({ pmid: `12345678${LF}` })]);
    expect(readRecords(file)[0]).toEqual([
      field("T1", "Effect of Treatment on Outcomes"),
      field("AN", "12345678"),
      field("UR", "https://pubmed.ncbi.nlm.nih.gov/12345678/"),
    ]);
  });

  it("a stored PMID that holds record syntax is no PMID, so neither AN nor a PubMed link is written", async () => {
    const file = await exportRIS([paper({ pmid: `12345678${LF}ER  - ${LF}TY  - JOUR` }), SENTINEL]);
    const records = readRecords(file);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual([field("T1", "Effect of Treatment on Outcomes")]);
  });

  it("a stored PubMed link with a line break is re-derived from its PMID", async () => {
    const file = await exportRIS([paper({ pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/12345678/${LF}ER  - ` })]);
    expect(readRecords(file)[0]).toEqual([
      field("T1", "Effect of Treatment on Outcomes"),
      field("UR", "https://pubmed.ncbi.nlm.nih.gov/12345678/"),
    ]);
  });

  it("a stored journal link is written as the URL parser reads it, which holds no line break", async () => {
    const file = await exportRIS([paper({ journal_url: `https://journal.example/a${LF}ER  - x` }), SENTINEL]);
    const records = readRecords(file);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual([
      field("T1", "Effect of Treatment on Outcomes"),
      field("UR", "https://journal.example/aER%20%20-%20x"),
      field("L2", "https://journal.example/aER%20%20-%20x"),
    ]);
  });

  it("UR and L2 precedence is unchanged by multi-line values elsewhere", async () => {
    const file = await exportRIS([
      paper({ abstract: HOSTILE, pmid: "12345678", doi: "10.1000/x", journal_url: "https://journal.example/a" }),
      paper({ abstract: HOSTILE, doi: "10.1000/x", journal_url: "https://journal.example/a" }),
      paper({ abstract: HOSTILE, journal_url: "https://journal.example/a" }),
    ]);
    const links = readRecords(file).map((r) => r.filter((f) => ["AN", "UR", "L2"].includes(f.tag)));
    expect(links).toEqual([
      [field("AN", "12345678"), field("UR", "https://pubmed.ncbi.nlm.nih.gov/12345678/"), field("L2", "https://journal.example/a")],
      [field("UR", "https://doi.org/10.1000/x"), field("L2", "https://journal.example/a")],
      [field("UR", "https://journal.example/a"), field("L2", "https://journal.example/a")],
    ]);
  });

  it("a third-party AN is still not a PMID, beside multi-line fields or continued itself", () => {
    const { papers } = parseRIS(
      [
        "TY  - JOUR",
        "T1  - Accession only",
        "AB  - First line.",
        "      Second line.",
        "AN  - 12345678",
        "UR  - https://www.embase.example/record/12345678",
        "ER  - ",
        "",
        "TY  - JOUR",
        "T1  - Accession continued",
        "AN  - 1234",
        "      5678",
        "ER  - ",
      ].join(LF),
    );
    expect(papers.map((p) => [p.pmid, p.pubmed_url])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(papers[0].journal_url).toBe("https://www.embase.example/record/12345678");
  });

  it("text in an abstract that looks like AN or a PubMed UR does not give the paper a PMID", async () => {
    const abstract = ["Summary.", "AN  - 31415926", "UR  - https://pubmed.ncbi.nlm.nih.gov/31415926/"].join(LF);
    const { papers } = parseRIS(await exportRIS([paper({ doi: "10.5555/doionly", abstract })]));
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({ pmid: null, pubmed_url: null, doi: "10.5555/doionly", abstract, journal_url: "https://doi.org/10.5555/doionly" });
  });
});

// ── M. Line endings ──

describe("M. line endings", () => {
  it.each([
    ["LF", LF],
    ["CR LF", CR + LF],
    ["CR", CR],
  ])("a %s in a single-value field becomes a continuation line, read back as LF", async (_name, br) => {
    const file = await exportRIS([paper({ abstract: `First.${br}ER  - ${br}Second.` }), SENTINEL]);
    const records = readRecords(file);
    expect(records).toHaveLength(2);
    expect(records[0].find((f) => f.tag === "AB")).toEqual(field("AB", "First.", "ER  - ", "Second."));
    const { papers } = parseRIS(file);
    expect(papers[0].abstract).toBe(`First.${LF}ER  - ${LF}Second.`);
    expectSentinel(papers[1]);
  });

  it("mixed line endings in one value are each one line break", async () => {
    const file = await exportRIS([paper({ abstract: `a${CR}${LF}b${CR}c${LF}d${CR}${CR}e` })]);
    expect(readRecords(file)[0].find((f) => f.tag === "AB")).toEqual(field("AB", "a", "b", "c", "d", "", "e"));
    expect(parseRIS(file).papers[0].abstract).toBe(["a", "b", "c", "d", "", "e"].join(LF));
  });

  it.each([
    ["LF", LF],
    ["CR LF", CR + LF],
    ["CR", CR],
  ])("a %s in a list element is one space", async (_name, br) => {
    const file = await exportRIS([paper({ authors: [`Doe,${br}Jane`], keywords: [`heart${br}failure`] })]);
    expect(readRecords(file)[0]).toEqual([
      field("T1", "Effect of Treatment on Outcomes"),
      field("AU", "Doe, Jane"),
      field("KW", "heart failure"),
    ]);
  });

  it.each([
    ["U+2028 LINE SEPARATOR", LINE_SEPARATOR],
    ["U+2029 PARAGRAPH SEPARATOR", PARAGRAPH_SEPARATOR],
    ["U+0085 NEXT LINE", NEXT_LINE],
  ])("%s is not a RIS line ending: written unchanged, and read back", async (_name, ch) => {
    const value = `Alpha${ch}ER  - ${ch}Beta`;
    const file = await exportRIS([paper({ title: value, abstract: value, authors: [value] }), SENTINEL]);
    expect(readRecords(file)[0]).toEqual([field("T1", value), field("AU", value), field("AB", value)]);
    const { papers, warnings } = parseRIS(file);
    expect(warnings).toEqual([]);
    expect(papers).toHaveLength(2);
    expect(papers[0]).toMatchObject({ title: value, authors: [value], abstract: value });
    expectSentinel(papers[1]);
  });

  it("an ordinary file stays LF-only, with no carriage return", async () => {
    const file = await exportRIS([paper({ title: "One" }), paper({ title: "Two" })]);
    expect(file.split(LF)).toEqual(["TY  - JOUR", "T1  - One", "ER  - ", "", "TY  - JOUR", "T1  - Two", "ER  - "]);
  });
});

// ── N, O. Tag-like text and blank paragraphs ──

describe("N. text that looks like RIS syntax stays text", () => {
  it.each(["ER  - ", "TY  - JOUR", "AU  - Name, A", "KW  - word", "DO  - 10.9999/x", "PY  - 1901", "ER  -", "XX  - unknown tag"])(
    "a continuation line reading %j",
    async (line) => {
      const abstract = ["Before.", line, "After."].join(LF);
      const file = await exportRIS([paper({ abstract, year: 2020 }), SENTINEL]);
      expect(file).toContain(`${LF}${INDENT}${line}${LF}`);
      const { papers } = parseRIS(file);
      expect(papers).toHaveLength(2);
      expect(papers[0]).toMatchObject({ abstract, year: 2020, authors: [], keywords: [], doi: null });
      expectSentinel(papers[1]);
    },
  );

  it("tag-like text at the start of a value stays after its own tag", async () => {
    const file = await exportRIS([paper({ title: "ER  - ", abstract: "TY  - JOUR" }), SENTINEL]);
    expect(readRecords(file)[0]).toEqual([field("T1", "ER  - "), field("AB", "TY  - JOUR")]);
    const { papers } = parseRIS(file);
    expect(papers.map((p) => p.title)).toEqual(["ER  -", "Sentinel record"]);
    expect(papers[0].abstract).toBe("TY  - JOUR");
  });
});

describe("O. blank lines and white space inside prose", () => {
  it("an empty line of the value is a continuation line of six spaces, never an empty line", async () => {
    const abstract = ["Paragraph one.", "", "Paragraph two.", "", "", "Paragraph three."].join(LF);
    const file = await exportRIS([paper({ abstract }), SENTINEL]);
    expect(file).toContain(`AB  - Paragraph one.${LF}${INDENT}${LF}${INDENT}Paragraph two.${LF}${INDENT}${LF}${INDENT}${LF}${INDENT}Paragraph three.`);
    expect(readRecords(file)).toHaveLength(2);
    expect(parseRIS(file).papers[0].abstract).toBe(abstract);
  });

  it("white space inside a multi-line value is kept; the value is trimmed as a whole, as before", async () => {
    const abstract = `  Lead  ${LF}  indented line${LF}\ttabbed line ${LF}   ${LF}last  `;
    const { papers } = parseRIS(await exportRIS([paper({ abstract })]));
    expect(papers[0].abstract).toBe(`Lead  ${LF}  indented line${LF}\ttabbed line ${LF}   ${LF}last`);
  });

  it("line breaks before or after the text are not kept, as surrounding white space was not", async () => {
    const { papers } = parseRIS(await exportRIS([paper({ abstract: `${LF}${LF}Body.${LF}${LF}`, title: `${LF}Title` })]));
    expect(papers[0]).toMatchObject({ abstract: "Body.", title: "Title" });
  });
});

// ── Scientific text ──

describe("scientific text survives", () => {
  it("structured abstracts, statistics, Greek letters, accents and chemistry, line for line", async () => {
    const abstract = [
      "BACKGROUND: Serum 25(OH)D < 50 nmol/L was common (n = 1,204).",
      "METHODS: Cholecalciferol 2,000 IU/d vs placebo; α = 0.05, β = 0.2.",
      "",
      "RESULTS: HR 0.82 (95% CI 0.71–0.95; p < 0.01); I² = 12%; Δ = −3.4 ± 1.1 mmHg.",
      "Ca²⁺ and [Fe(CN)₆]³⁻ levels: N,N-dimethylformamide ≥ 99.8 %.",
      "CONCLUSIONS: Benefit in ≥ 65-year-olds; see Müller & Ñúñez — “a priori”.",
    ].join(LF);
    const authors = ["Ñúñez, José-María", "Øster, Åse", "Ψ Research Group"];
    const { papers } = parseRIS(await exportRIS([paper({ abstract, authors, title: "β-Blockers & Ca²⁺: a re-analysis" })]));
    expect(papers[0]).toMatchObject({ abstract, authors, title: "β-Blockers & Ca²⁺: a re-analysis" });
  });
});

// ── P–T. The importer's line grammar ──

describe("P. unknown third-party tags", () => {
  it("are still fields of their own, and their continuation lines stay with them", () => {
    const { papers } = parseRIS(
      [
        "TY  - JOUR",
        "T1  - Unknown tags",
        "Y2  - 2020/01/02",
        "SN  - 1234-5678",
        "      continued serial note",
        "AB  - Known abstract.",
        "M3  - Article",
        "      continued medium",
        "VL  - 12",
        "ER  - ",
      ].join(CR + LF),
    );
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({ title: "Unknown tags", abstract: "Known abstract.", year: null });
  });
});

describe("D. third-party files with continuation lines", () => {
  it("the historical specification's own shape: unindented continuation lines, CR LF", () => {
    const { papers, warnings } = parseRIS(
      [
        "TY  - JOUR",
        "AU  - Baldwin,S.A.",
        "TI  - Blood-brain barrier breach following cortical contusion in the rat",
        "PY  - 1996",
        "AB  - Adult Fisher 344 rats were subjected to a unilateral impact to the dorsal cortex above the hippocampus at 3.5",
        "m/sec with a 2 mm cortical depression. This caused severe cortical damage and neuronal loss in",
        "hippocampus subfields CA1, CA3 and hilus.",
        "KW  - cortical contusion",
        "ER  - ",
        "",
      ].join(CR + LF),
    );
    expect(warnings).toEqual([]);
    expect(papers[0]).toMatchObject({
      title: "Blood-brain barrier breach following cortical contusion in the rat",
      authors: ["Baldwin,S.A."],
      abstract: [
        "Adult Fisher 344 rats were subjected to a unilateral impact to the dorsal cortex above the hippocampus at 3.5",
        "m/sec with a 2 mm cortical depression. This caused severe cortical damage and neuronal loss in",
        "hippocampus subfields CA1, CA3 and hilus.",
      ].join(LF),
      keywords: ["cortical contusion"],
    });
  });

  it("a multi-line abstract written with raw CR LF line breaks, as Zotero's exporter writes one", () => {
    const { papers } = parseRIS(
      ["TY  - JOUR", "TI  - Zotero-style export", "AB  - BACKGROUND: First section.", "METHODS: Second section.", "", "RESULTS: Third section.", "KW  - alpha", "ER  - ", ""].join(CR + LF),
    );
    expect(papers[0]).toMatchObject({
      abstract: ["BACKGROUND: First section.", "METHODS: Second section.", "", "RESULTS: Third section."].join(LF),
      keywords: ["alpha"],
    });
  });

  it.each([
    ["four", "    "],
    ["six", INDENT],
    ["two", "  "],
  ])("continuation lines indented %s spaces, as EndNote documents and MEDLINE writes them", (_n, indent) => {
    const { papers } = parseRIS(
      ["TY  - JOUR", "TI  - Indented continuation", "AB  - Two experiments compared", `${indent}old dyslexics with controls on a`, `${indent}battery of tests.`, "KW  - balance", "ER  - "].join(LF),
    );
    expect(papers[0].abstract).toBe(["Two experiments compared", "old dyslexics with controls on a", "battery of tests."].join(LF));
  });

  it("indentation beyond six spaces is text; a tab is text", () => {
    const { papers } = parseRIS(["TY  - JOUR", "TI  - Deep indent", "AB  - Top", `${INDENT}   three more`, "\tafter a tab", "ER  - "].join(LF));
    expect(papers[0].abstract).toBe(["Top", "   three more", "\tafter a tab"].join(LF));
  });

  it("a continuation of an author or keyword joins that one element", () => {
    const { papers } = parseRIS(
      [
        "TY  - JOUR",
        "T1  - Wrapped list elements",
        "AU  - International Consortium for Synthetic",
        "      Research Methods",
        "AU  - Doe, Jane",
        "KW  - wrapped keyword phrase that",
        "      continues here",
        "ER  - ",
      ].join(LF),
    );
    expect(papers[0].authors).toEqual(["International Consortium for Synthetic\nResearch Methods", "Doe, Jane"]);
    expect(papers[0].author_provenance!.map((a) => a.source_field)).toEqual(["AU", "AU"]);
    expect(papers[0].keywords).toEqual(["wrapped keyword phrase that\ncontinues here"]);
  });

  it("a genuine tag line in unindented prose still begins a field: that text cannot be told apart", () => {
    const { papers } = parseRIS(
      ["TY  - JOUR", "T1  - Prose that looks like tags", "AB  - The trial ended early.", "ER  - was not reached", "AU  - never appeared.", "KW  - real", "ER  - "].join(LF),
    );
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({ abstract: "The trial ended early.", authors: [], keywords: [] });
  });
});

describe("S. a record without a final ER", () => {
  it("is still read, its last field whole", () => {
    const { papers } = parseRIS(["TY  - JOUR", "T1  - Truncated record", "AU  - Cut, Off", "AB  - The file", "      ends here"].join(LF));
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({ title: "Truncated record", authors: ["Cut, Off"], abstract: `The file${LF}ends here` });
  });
});

describe("T. malformed input is handled as before", () => {
  it("text outside any record is ignored, and never added to the record before it", () => {
    const { papers } = parseRIS(
      [
        "Provider: Synthetic Provider",
        "TY  - JOUR",
        "T1  - Inside",
        "KW  - last field",
        "ER  - ",
        "Trailing junk line",
        "      indented junk",
        "<Record 2 of 2>",
        "TY  - JOUR",
        "T1  - Inside two",
        "ER  - ",
        "after the last record",
      ].join(LF),
    );
    expect(papers.map((p) => [p.title, p.keywords])).toEqual([
      ["Inside", ["last field"]],
      ["Inside two", []],
    ]);
  });

  it("a tag line with one space before its hyphen is not a field, and is not added to the field above it", () => {
    const { papers } = parseRIS(["TY  - JOUR", "T1  - Title", "AU - Smith", "au  - lower case", "AB  - Abstract.", "ER  - "].join(LF));
    expect(papers[0]).toMatchObject({ title: "Title", authors: [], abstract: "Abstract." });
  });

  it("a line holding a lone carriage return is ignored, as before", () => {
    const { papers } = parseRIS(["TY  - JOUR", `T1  - Title${CR}ER  - `, "TI  - Fallback title", "AB  - First.", `second${CR}third`, "ER  - "].join(LF));
    expect(papers[0]).toMatchObject({ title: "Fallback title", abstract: "First." });
  });

  it("a file whose only line ending is CR is not read, as before", () => {
    expect(parseRIS(["TY  - JOUR", "T1  - Old Mac line endings", "ER  - ", ""].join(CR))).toEqual({
      papers: [],
      warnings: ["No valid RIS entries found in file."],
    });
  });

  it("a TY inside an unfinished record still starts a new record in its place", () => {
    // Unchanged on purpose: whether the unfinished record should be kept is a
    // recovery decision this change does not make. Readers differ: Zotero keeps
    // it, rispy and JabRef merge it into the next record.
    const { papers, warnings } = parseRIS(["TY  - JOUR", "T1  - First, without ER", "AU  - First, A", "TY  - JOUR", "T1  - Second", "ER  - "].join(LF));
    expect(warnings).toEqual([]);
    expect(papers.map((p) => [p.title, p.authors])).toEqual([["Second", []]]);
  });

  it("consecutive TY lines, ER lines outside records, empty records and records without a title", () => {
    expect(parseRIS(["TY  - JOUR", "TY  - BOOK", "T1  - After two TY lines", "ER  - "].join(LF)).papers.map((p) => p.title)).toEqual(["After two TY lines"]);
    expect(parseRIS(["ER  - ", "TY  - JOUR", "T1  - Record", "ER  - ", "ER  - "].join(LF)).papers.map((p) => p.title)).toEqual(["Record"]);
    expect(parseRIS(["TY  - JOUR", "ER  - "].join(LF))).toEqual({ papers: [], warnings: ["RIS entry 1: missing title, skipped"] });
    expect(parseRIS(["TY  - JOUR", "AU  - No, Title", "      continued", "ER  - "].join(LF))).toEqual({ papers: [], warnings: ["RIS entry 1: missing title, skipped"] });
  });

  it("blank lines between fields add nothing to the fields around them", () => {
    const { papers } = parseRIS(["TY  - JOUR", "", "T1  - Blank lines", "", "AU  - Doe, J", "", "AB  - Abstract.", "", "ER  - "].join(LF));
    expect(papers[0]).toMatchObject({ title: "Blank lines", authors: ["Doe, J"], abstract: "Abstract." });
  });
});

// ── E. Files exported before this change ──

describe("E. RIS files exported before this change", () => {
  it("an ordinary file reads as before", () => {
    const { papers } = parseRIS(["TY  - JOUR", "T1  - Old export", "AU  - Doe, J", "PY  - 2019", "DO  - 10.5555/old", "UR  - https://doi.org/10.5555/old", "ER  - "].join(LF));
    expect(papers[0]).toMatchObject({ title: "Old export", authors: ["Doe, J"], year: 2019, doi: "10.5555/old", journal_url: "https://doi.org/10.5555/old" });
  });

  it("a multi-line abstract written raw is now read whole", () => {
    const { papers } = parseRIS(["TY  - JOUR", "T1  - Old export", "AB  - First paragraph.", "", "Second paragraph.", "KW  - k", "ER  - "].join(LF));
    expect(papers[0]).toMatchObject({ abstract: `First paragraph.${LF}${LF}Second paragraph.`, keywords: ["k"] });
  });

  it("a file whose value already broke its record cannot be repaired: it reads as it did", () => {
    const old = ["TY  - JOUR", "T1  - Boundary paper", "AB  - Part one.", "ER  - ", "", "TY  - JOUR", "T1  - Injected record", "KW  - real keyword", "ER  - "].join(LF);
    expect(parseRIS(old).papers.map((p) => p.title)).toEqual(["Boundary paper", "Injected record"]);
  });
});

// ── U. Repeated export and import ──

describe("U. repeated export and import", () => {
  /** A paper rebuilt from what `parseRIS` read, as a fresh export would see it. */
  const rebuild = (p: ReturnType<typeof parseRIS>["papers"][number], i: number): PaperWithTags =>
    paper({
      id: `rebuilt-${i}`,
      title: p.title,
      authors: p.authors,
      year: p.year,
      journal: p.journal,
      pmid: p.pmid,
      doi: p.doi,
      abstract: p.abstract,
      keywords: p.keywords,
      study_type: p.study_type,
      pubmed_url: p.pubmed_url,
      journal_url: p.journal_url,
      drive_url: p.drive_url,
    });

  it("reach a fixed point after one cycle, with every paper kept", async () => {
    const corpus = [
      paper({ title: HOSTILE, authors: [HOSTILE, "Doe, J"], journal: HOSTILE, doi: HOSTILE, abstract: HOSTILE, keywords: [HOSTILE], study_type: HOSTILE, drive_url: HOSTILE }),
      paper({ title: `CR${CR}title`, abstract: `a${CR}${LF}b${CR}c`, pmid: "12345678", journal_url: "https://journal.example/a" }),
      SENTINEL,
    ];
    const first = await exportRIS(corpus);
    const second = await exportRIS(parseRIS(first).papers.map(rebuild));
    const third = await exportRIS(parseRIS(second).papers.map(rebuild));
    expect(readRecords(second)).toHaveLength(3);
    expect(third).toBe(second);
    expect(parseRIS(third).papers).toEqual(parseRIS(second).papers);
    expect(parseRIS(second).papers.map((p) => p.title)).toEqual([HOSTILE, `CR${LF}title`, "Sentinel record"]);
  });
});

// ── V. Empty export and empty fields ──

describe("V. empty export and empty optional fields", () => {
  it("an empty export is an empty file", async () => {
    expect(await exportRIS([])).toBe("");
    expect(parseRIS("")).toEqual({ papers: [], warnings: [] });
  });

  it("empty optional fields write no line, and an empty title its tag alone, as before", async () => {
    const file = await exportRIS([paper({ title: "", journal: "", doi: "", abstract: "", study_type: "", drive_url: "" })]);
    expect(file).toBe(["TY  - JOUR", "T1  - ", "ER  - "].join(LF));
  });
});

// ── W, X. Size ──

describe("W, X. large but bounded exports", () => {
  it("W. a long abstract with tag-like lines and blank paragraphs is one record, read back whole", async () => {
    const lines = Array.from({ length: 2000 }, (_, i) =>
      i % 25 === 0 ? "" : i % 10 === 0 ? (i % 20 === 0 ? "ER  - " : "TY  - JOUR") : `Line ${i}: effect size d = 0.${i % 10} (95% CI 0.1–0.9), p < 0.0${i % 9 + 1}.`,
    );
    const abstract = ["Start.", ...lines, "End."].join(LF);
    const file = await exportRIS([paper({ abstract }), SENTINEL]);
    const records = readRecords(file);
    expect(records).toHaveLength(2);
    expect(records[0].find((f) => f.tag === "AB")!.lines).toHaveLength(2002);
    const { papers } = parseRIS(file);
    expect(papers).toHaveLength(2);
    expect(papers[0].abstract).toBe(abstract);
    expectSentinel(papers[1]);
  });

  it("X. 3,000 papers with multi-line values in every field are 3,000 records, in order", async () => {
    const corpus = Array.from({ length: 3000 }, (_, i) =>
      paper({
        id: `p${i}`,
        title: `Paper ${i}${LF}ER  - ${LF}TY  - JOUR`,
        authors: [`Author ${i}${LF}AU  - Injected, Author`],
        abstract: `Abstract ${i}.${LF}${LF}T1  - Injected record`,
        keywords: [`kw ${i}${CR}${LF}KW  - injected`],
        doi: i % 3 === 0 ? `10.5555/${i}` : null,
        drive_url: i % 5 === 0 ? `https://drive.example/${i}${LF}ER  - ` : null,
      }),
    );
    const file = await exportRIS(corpus);
    const records = readRecords(file);
    expect(records).toHaveLength(3000);
    const { papers, warnings } = parseRIS(file);
    expect(warnings).toEqual([]);
    expect(papers).toHaveLength(3000);
    papers.forEach((p, i) => {
      expect(p.title).toBe(`Paper ${i}${LF}ER  - ${LF}TY  - JOUR`);
      expect(p.authors).toEqual([`Author ${i} AU  - Injected, Author`]);
    });
    expectNothingInjected(papers);
  });
});

// ── Other formats ──

describe("CSV and BibTeX are not changed by the RIS fix", () => {
  const hostile = paper({
    title: ["Line one", "ER  - ", "TY  - JOUR"].join(LF),
    authors: [`Doe,${LF}Jane`, "Roe, R"],
    year: 2021,
    journal: `J${LF}Synth`,
    doi: `10.1000/line${LF}break`,
    abstract: ["A", "", "KW  - x"].join(LF),
    study_type: "Cohort",
    keywords: [`k${LF}w`],
    mesh_terms: ["M; N"],
    journal_url: `https://journal.example/a${LF}b`,
    drive_url: `d${LF}u`,
    tags: tags(`t${LF}g`),
    projects: projects("p"),
  });

  it("CSV is byte for byte main's", async () => {
    exportToCSV([hostile]);
    expect(await lastDownloadText()).toBe(
      'Title,Authors,Year,Journal,PMID,DOI,Study Types,Keywords,MeSH Terms,Substances,Tags,Projects,URL,Abstract\n"Line one\nER  - \nTY  - JOUR","Doe,\nJane; Roe, R",2021,"J\nSynth",,"10.1000/line\nbreak",Cohort,"k\nw","M; N",,"t\ng",p,https://doi.org/10.1000/line%0Abreak,"A\n\nKW  - x"',
    );
  });

  it("BibTeX is byte for byte main's, with the same summary", async () => {
    const summary = exportToBibTeX([hostile]);
    expect(await lastDownloadText()).toBe(
      "@article{Jane2021_Line,\n  title     = {{Line one\nER  - \nTY  - JOUR}},\n  author    = {Jane, Doe, and R, Roe,},\n  year      = {2021},\n  journal   = {J\nSynth},\n  doi       = {10.1000/line\nbreak},\n  url       = {https://doi.org/10.1000/line%0Abreak},\n  abstract  = {A\n\nKW  - x},\n  keywords  = {k\nw, M; N},\n  note      = {Study type: Cohort}\n}",
    );
    expect(summary).toEqual({ paperCount: 1, affectedPaperCount: 0, exceptionalDoiCount: 0, exceptionalUrlCount: 0 });
  });
});
