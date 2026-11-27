import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { exportToBibTeX, exportToCSV, exportToRIS } from "../exportUtils";
import { toSafeExternalHref } from "../externalUrl";
import { parseRIS } from "../importParsers";
import { normalizePaperData } from "../normalizePaperData";
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
 *    continuation line, six spaces and then the text;
 *  - `parseRIS` reads a text field (title, journal, abstract, note) back whole,
 *    with LF where it had CR LF or CR. It reads a link or a year (`UR`, `L2`,
 *    `L1`, `PY`, `Y1`, `DA`) from its tag line alone, as before continuation
 *    lines were read, because the URL parser would join a link's lines into a
 *    different link. A `DO` continues only after a tag line that holds a DOI
 *    name, so a continuation can keep a line break in a DOI but never supply
 *    one;
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

/**
 * Fields that hold one value: their lines go on continuation lines. A text
 * field reads back whole. The DOI and the attachment link read back as their
 * tag line alone here: the link always does, and `HOSTILE`'s first line holds
 * no DOI name, so the DOI does too (see K2 for a DOI that continues).
 */
const SINGLE_VALUE_FIELDS: {
  name: string;
  tag: string;
  set: (value: string) => Partial<PaperWithTags>;
  read: (p: ReturnType<typeof parseRIS>["papers"][number]) => unknown;
  readsBack: string;
  expected: string;
}[] = [
  { name: "C. title", tag: "T1", set: (v) => ({ title: v }), read: (p) => p.title, readsBack: "as the same value", expected: HOSTILE },
  { name: "E. journal", tag: "JO", set: (v) => ({ journal: v }), read: (p) => p.journal, readsBack: "as the same value", expected: HOSTILE },
  { name: "F. abstract", tag: "AB", set: (v) => ({ abstract: v }), read: (p) => p.abstract, readsBack: "as the same value", expected: HOSTILE },
  { name: "H. study-type note", tag: "N1", set: (v) => ({ study_type: v }), read: (p) => p.study_type, readsBack: "as the same value", expected: HOSTILE },
  { name: "K. DOI", tag: "DO", set: (v) => ({ doi: v }), read: (p) => p.doi, readsBack: "as its tag line alone", expected: HOSTILE_LINES[0] },
  { name: "L. attachment link", tag: "L1", set: (v) => ({ drive_url: v }), read: (p) => p.drive_url, readsBack: "as its tag line alone", expected: HOSTILE_LINES[0] },
];

describe("a field that holds one value keeps every line of it inside its field", () => {
  describe.each(SINGLE_VALUE_FIELDS)("$name ($tag)", ({ tag, set, read, readsBack, expected }) => {
    it("is one record, the value's lines on continuation lines, and the next record intact", async () => {
      const file = await exportRIS([paper(set(HOSTILE)), SENTINEL]);
      const records = readRecords(file);
      expect(records).toHaveLength(2);
      expect(records[0].filter((f) => f.tag === tag)).toEqual([field(tag, ...HOSTILE_LINES)]);
      expect(records[0].map((f) => f.tag)).not.toContain("AU");
      expect(records[1]).toEqual(SENTINEL_FIELDS);
    });

    it(`reads back ${readsBack}, with nothing injected`, async () => {
      const { papers, warnings } = parseRIS(await exportRIS([paper(set(HOSTILE)), SENTINEL]));
      expect(warnings).toEqual([]);
      expect(papers).toHaveLength(2);
      expect(read(papers[0])).toBe(expected);
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
    // The DOI, the attachment link and the year read their tag lines alone
    // ("Opening line.", which holds no DOI name and no year), so the "9999" of
    // the injected DOI on a continuation line does not become the year.
    expect(papers[1]).toMatchObject({
      title: HOSTILE,
      authors: [HOSTILE_FLAT],
      journal: HOSTILE,
      doi: HOSTILE_LINES[0],
      drive_url: HOSTILE_LINES[0],
      year: null,
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

// ── K2. A continuation line adds nothing to a link, an identifier or a year ──

const PUBMED = "https://pubmed.ncbi.nlm.nih.gov";

/**
 * Reads `lines` as the fields of one third-party record placed between two
 * sentinel records, checks that both sentinels come through whole, and returns
 * the middle paper. The record gets a title unless `lines` gives one.
 */
function readBetween(lines: string[], eol: string = LF): ReturnType<typeof parseRIS>["papers"][number] {
  const file = [
    ["TY  - JOUR", "T1  - Sentinel before", `UR  - ${PUBMED}/1/`, "ER  - "],
    ["TY  - JOUR", ...(lines.some((l) => l.startsWith("T1  -")) ? [] : ["T1  - Third-party record"]), ...lines, "ER  - "],
    ["TY  - JOUR", "T1  - Sentinel after", `UR  - ${PUBMED}/2/`, "ER  - "],
  ]
    .map((record) => record.join(eol))
    .join(eol + eol);
  const { papers, warnings } = parseRIS(file + eol);
  expect(warnings).toEqual([]);
  expect(papers).toHaveLength(3);
  expect([papers[0].title, papers[0].pmid, papers[0].pubmed_url]).toEqual(["Sentinel before", "1", `${PUBMED}/1/`]);
  expect([papers[2].title, papers[2].pmid, papers[2].pubmed_url]).toEqual(["Sentinel after", "2", `${PUBMED}/2/`]);
  return papers[1];
}

const links = (p: ReturnType<typeof parseRIS>["papers"][number]) => ({ pmid: p.pmid, pubmed_url: p.pubmed_url, journal_url: p.journal_url });
const RECORD_123 = { pmid: "123", pubmed_url: `${PUBMED}/123/`, journal_url: null };
const NO_LINKS = { pmid: null, pubmed_url: null, journal_url: null };

describe("K2. a continuation line adds nothing to a link, an identifier or a year", () => {
  it("the reviewed case: PubMed record 123 continued by 456/ is still record 123", () => {
    // The URL parser itself joins the two lines, which is why a link is never
    // read across them.
    expect(new URL(`${PUBMED}/123${LF}456/`).href).toBe(`${PUBMED}/123456/`);
    const { papers, warnings } = parseRIS(["TY  - JOUR", "T1  - Example study", `UR  - ${PUBMED}/123`, "      456/", "ER  -"].join(LF));
    expect(warnings).toEqual([]);
    expect(papers.map(links)).toEqual([RECORD_123]);
  });

  it.each([
    ["six spaces", [`UR  - ${PUBMED}/123`, `${INDENT}456/`]],
    ["no indentation", [`UR  - ${PUBMED}/123`, "456/"]],
    ["four spaces", [`UR  - ${PUBMED}/123`, "    456/"]],
    ["eight spaces", [`UR  - ${PUBMED}/123`, `${INDENT}  456/`]],
    ["a tab", [`UR  - ${PUBMED}/123`, "\t456/"]],
    ["six spaces and a tab", [`UR  - ${PUBMED}/123`, `${INDENT}\t456/`]],
    ["tag-like text", [`UR  - ${PUBMED}/123`, `${INDENT}ZZ  - 456/`]],
    ["the legacy PubMed path", ["UR  - https://www.ncbi.nlm.nih.gov/pubmed/123", `${INDENT}4`]],
  ])("A, J. a PubMed record continued after %s keeps its own PMID", (_name, lines) => {
    expect(links(readBetween(lines))).toEqual(RECORD_123);
  });

  it.each([
    ["the PubMed host with no record", [`UR  - ${PUBMED}/`, `${INDENT}999/`], `${PUBMED}/`],
    ["a scheme alone", ["UR  - https:", `${INDENT}//pubmed.ncbi.nlm.nih.gov/999/`], null],
    ["a cut-off host", ["UR  - https://pubmed.ncbi.nlm.nih", `${INDENT}.gov/999/`], "https://pubmed.ncbi.nlm.nih/"],
    ["the legacy host with no path", ["UR  - https://www.ncbi.nlm.nih.gov/", `${INDENT}pubmed/999`], "https://www.ncbi.nlm.nih.gov/"],
  ])("B. %s gains no PMID from its continuation, and stays the link it was", (_name, lines, journal_url) => {
    expect(links(readBetween(lines))).toEqual({ pmid: null, pubmed_url: null, journal_url });
  });

  it.each([
    ["an indented", ["UR  - ", `${INDENT}${PUBMED}/999/`]],
    ["an unindented", ["UR  -", `${PUBMED}/999/`]],
  ])("C. an empty UR tag line gains nothing from %s continuation", (_name, lines) => {
    expect(links(readBetween(lines))).toEqual(NO_LINKS);
  });

  it("D. an empty L2 tag line gains nothing from its continuation, and a generic UR still fills in", () => {
    expect(links(readBetween(["L2  - ", `${INDENT}https://journal.example/x`]))).toEqual(NO_LINKS);
    expect(links(readBetween(["L2  - ", `${INDENT}https://journal.example/x`, "UR  - https://other.example/y"]))).toEqual({
      ...NO_LINKS,
      journal_url: "https://other.example/y",
    });
  });

  it.each([
    ["path", ["UR  - https://journal.example/articles/1", `${INDENT}2345`], "https://journal.example/articles/1"],
    ["host", ["UR  - https://journal.example", `${INDENT}.elsewhere.example/x`], "https://journal.example/"],
    ["query", ["UR  - https://journal.example/a", `${INDENT}?b=1`], "https://journal.example/a"],
  ])("E. a generic UR keeps its %s", (_name, lines, journal_url) => {
    expect(links(readBetween(lines))).toEqual({ ...NO_LINKS, journal_url });
  });

  it.each([
    ["path", ["L2  - https://journal.example/a", `${INDENT}b`], "https://journal.example/a"],
    ["host", ["L2  - https://journal.example", `${INDENT}.elsewhere.example/`], "https://journal.example/"],
  ])("F. an explicit L2 keeps its %s", (_name, lines, journal_url) => {
    expect(links(readBetween(lines))).toEqual({ ...NO_LINKS, journal_url });
  });

  it("F. a continued L2 still wins over a generic UR, and the first L2 over a second", () => {
    expect(readBetween(["UR  - https://other.example/x", "L2  - https://journal.example/a", `${INDENT}b`]).journal_url).toBe("https://journal.example/a");
    expect(readBetween(["L2  - https://journal.example/a", "L2  - https://journal.example/second"]).journal_url).toBe("https://journal.example/a");
  });

  it("G. among several UR lines, the first PubMed record on a tag line still supplies the PMID", () => {
    expect(links(readBetween([`UR  - ${PUBMED}/111`, `${INDENT}222/`, `UR  - ${PUBMED}/333/`]))).toEqual({ ...NO_LINKS, pmid: "111", pubmed_url: `${PUBMED}/111/` });
    expect(links(readBetween(["UR  - ", `${INDENT}${PUBMED}/999/`, `UR  - ${PUBMED}/123/`]))).toEqual(RECORD_123);
    expect(links(readBetween(["UR  - https://journal.example/x", "UR  - https://journal.example/y"]))).toEqual({ ...NO_LINKS, journal_url: "https://journal.example/x" });
  });

  it.each([
    ["text that is no URL", ["UR  - not-a-url", `UR  - ${PUBMED}/123/`]],
    ["a continued scheme alone", ["UR  - https:", `${INDENT}//pubmed.ncbi.nlm.nih.gov/999/`, `UR  - ${PUBMED}/123/`]],
    ["a scheme that is not http(s)", ["UR  - ftp://files.example/x", `UR  - ${PUBMED}/123/`]],
  ])("H. %s does not hide a later PubMed UR", (_name, lines) => {
    expect(links(readBetween(lines))).toEqual(RECORD_123);
  });

  it("I. a PubMed UR and a generic UR keep their roles, continued or not", () => {
    expect(links(readBetween(["UR  - https://journal.example/x", `UR  - ${PUBMED}/123/`]))).toEqual({ ...RECORD_123, journal_url: "https://journal.example/x" });
    expect(links(readBetween(["UR  - https://journal.example/x", `${INDENT}y`, `UR  - ${PUBMED}/123/`]))).toEqual({ ...RECORD_123, journal_url: "https://journal.example/x" });
    expect(links(readBetween([`UR  - ${PUBMED}/`, `${INDENT}999/`, "UR  - https://journal.example/x"]))).toEqual({ ...NO_LINKS, journal_url: `${PUBMED}/` });
  });

  it.each([
    ["LF", LF],
    ["CR LF", CR + LF],
  ])("K. with %s line endings, continued UR, L2 and L1 lines add nothing", (_name, eol) => {
    const p = readBetween([`UR  - ${PUBMED}/123`, `${INDENT}456/`, "L2  - https://journal.example/a", `${INDENT}b`, "L1  - https://drive.example/file/a", `${INDENT}b`], eol);
    expect(p).toMatchObject({ ...RECORD_123, journal_url: "https://journal.example/a", drive_url: "https://drive.example/file/a" });
  });

  it("L. the tag line's URL is read and normalized as before", () => {
    expect(links(readBetween([`UR  -    ${PUBMED}/123/   `]))).toEqual(RECORD_123);
    expect(links(readBetween([`UR  - ${PUBMED}/123/`, `${INDENT}   `]))).toEqual(RECORD_123);
    expect(links(readBetween(["UR  - HTTPS://PUBMED.NCBI.NLM.NIH.GOV/123"]))).toEqual(RECORD_123);
    // A tab inside the tag line itself is removed by the URL parser, as it was
    // before this change; only continuation lines are kept out of a link.
    expect(links(readBetween([`UR  - ${PUBMED}/12\t3/`]))).toEqual(RECORD_123);
    expect(readBetween(["UR  - https://Journal.Example/a b"]).journal_url).toBe("https://journal.example/a%20b");
  });

  it("M, N. beside a continued UR, an abstract still reads whole and its tag-like lines stay text", () => {
    const p = readBetween(["AB  - Results.", `${INDENT}UR  - ${PUBMED}/999/`, INDENT, `${INDENT}L2  - https://elsewhere.example/`, `UR  - ${PUBMED}/123`, `${INDENT}456/`]);
    expect(p).toMatchObject({ ...RECORD_123, abstract: ["Results.", `UR  - ${PUBMED}/999/`, "", "L2  - https://elsewhere.example/"].join(LF) });
  });

  it("O. an ordinary DOI and PubMed record read as before", () => {
    const p = readBetween(["DO  - 10.1000/456#789", `UR  - ${PUBMED}/12345678/`, "UR  - https://doi.org/10.1000/456%23789"]);
    expect(p).toMatchObject({ doi: "10.1000/456#789", pmid: "12345678", pubmed_url: `${PUBMED}/12345678/`, journal_url: "https://doi.org/10.1000/456%23789" });
  });

  it("P. an AN is still no PMID, whatever its continuation lines hold", () => {
    expect(links(readBetween(["AN  - 12345678", `${INDENT}${PUBMED}/87654321/`]))).toEqual(NO_LINKS);
    expect(links(readBetween(["AN  - ", `${INDENT}UR  - ${PUBMED}/999/`]))).toEqual(NO_LINKS);
  });

  describe("Q. a DOI continues only after a tag line that holds a DOI name", () => {
    it.each([
      ["a DOI name", ["DO  - 10.1000/abc", `${INDENT}def`], `10.1000/abc${LF}def`],
      ["a DOI name, unindented", ["DO  - 10.1000/abc", "def"], `10.1000/abc${LF}def`],
      ["a DOI name, over three lines", ["DO  - 10.1000/abc", `${INDENT}def`, `${INDENT}ghi`], `10.1000/abc${LF}def${LF}ghi`],
      ["a resolver URL", ["DO  - https://doi.org/10.1000/abc", `${INDENT}def`], `https://doi.org/10.1000/abc${LF}def`],
      ["the doi: form", ["DO  - DOI: 10.1000/abc", `${INDENT}def`], `DOI: 10.1000/abc${LF}def`],
    ])("after %s, the line break is kept", (_name, lines, doi) => {
      expect(readBetween(lines).doi).toBe(doi);
    });

    it.each([
      ["an empty tag line", ["DO  - ", `${INDENT}10.1000/xyz`], null],
      ["doi: alone", ["DO  - doi:", `${INDENT}10.1000/xyz`], "doi:"],
      ["the resolver alone", ["DO  - https://doi.org/", `${INDENT}10.1000/xyz`], "https://doi.org/"],
      ["a prefix and a slash", ["DO  - 10.1000/", `${INDENT}abc`], "10.1000/"],
    ])("after %s, the continuation is not read, as before", (_name, lines, doi) => {
      expect(readBetween(lines).doi).toBe(doi);
    });

    it("once normalized for saving, a continuation adds nothing to the DOI or leaves a line break in it", () => {
      const config = { synonymLookup: {}, poolStudyTypes: [], poolKeywords: [], synonymGroups: [] };
      const savedDoi = (lines: string[]) => normalizePaperData(readBetween(lines), config).doi;
      // Adds nothing: the DOI saved is the one the tag line alone gives.
      for (const tagLine of ["DO  - ", "DO  - doi:", "DO  - https://doi.org/", "DO  - 10.1000/"]) {
        expect(savedDoi([tagLine, `${INDENT}10.1000/xyz`])).toBe(savedDoi([tagLine]));
      }
      // Or keeps a line break, so it can be equal to no DOI name.
      expect(savedDoi(["DO  - https://doi.org/10.1000/ABC", `${INDENT}def`])).toBe(`10.1000/abc${LF}def`);
      expect(savedDoi(["DO  - doi:10.1000/abc", `${INDENT}def`])).toBe(`10.1000/abc${LF}def`);
    });

    it("a stored DOI keeps its line break, as LF; one whose first line is no DOI name comes back as that line", async () => {
      const { papers } = parseRIS(await exportRIS([paper({ doi: `10.1000/line${CR}${LF}break` }), paper({ doi: `10.1000/${LF}tail` }), SENTINEL]));
      expect(papers.map((p) => p.doi)).toEqual([`10.1000/line${LF}break`, "10.1000/", "10.5555/sentinel.2001"]);
      expectSentinel(papers[2]);
    });
  });

  describe("R. the attachment link and the year come from their tag lines", () => {
    it.each([
      ["a continued path", ["L1  - https://drive.example/file/a", `${INDENT}b`], "https://drive.example/file/a", "https://drive.example/file/a"],
      ["a continued host", ["L1  - https://drive.example", `${INDENT}.elsewhere.example/x`], "https://drive.example", "https://drive.example/"],
      ["an empty tag line", ["L1  - ", `${INDENT}https://drive.example/file/x`], null, null],
      ["a value that is no URL", ["L1  - local-file-name.pdf", `${INDENT}second line`], "local-file-name.pdf", null],
    ])("L1: %s", (_name, lines, drive_url, href) => {
      const p = readBetween(lines);
      expect(p.drive_url).toBe(drive_url);
      expect(toSafeExternalHref(p.drive_url)).toBe(href);
    });

    it("a stored attachment link with a line break comes back as its first line, as before", async () => {
      const { papers } = parseRIS(await exportRIS([paper({ drive_url: `https://drive.example/a${LF}b` }), SENTINEL]));
      expect(papers[0].drive_url).toBe("https://drive.example/a");
      expectSentinel(papers[1]);
    });

    it.each([
      ["an empty PY, continued, then Y1", ["PY  - ", `${INDENT}2020`, "Y1  - 1999"], 1999],
      ["a PY with no year, continued", ["PY  - n.d.", `${INDENT}2020`], null],
      ["a PY, continued", ["PY  - 2020", `${INDENT}1999`], 2020],
      ["an empty DA, continued", ["DA  - ", `${INDENT}2018/01/01`], null],
      ["an empty Y1, continued, then DA", ["Y1  - ", `${INDENT}2001`, "DA  - 2002"], 2002],
      ["digits split over two lines", ["PY  - 20", `${INDENT}21`], null],
    ])("year: %s", (_name, lines, year) => {
      expect(readBetween(lines).year).toBe(year);
    });

    it("a stored year that is not a number takes no year from its continuation lines", async () => {
      const year = ["n.d.", "DO  - 10.9999/injected"].join(LF);
      const { papers } = parseRIS(await exportRIS([paper({ year: year as unknown as number }), SENTINEL]));
      expect(papers[0].year).toBeNull();
      expectSentinel(papers[1]);
    });
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

  it("T. links, a multi-line DOI, an attachment link and a year beside multi-line text reach a fixed point", async () => {
    const corpus = [
      paper({
        title: "Identifiers beside multi-line text",
        abstract: HOSTILE,
        pmid: "12345678",
        doi: `10.1000/line${CR}${LF}break`,
        journal_url: "https://journal.example/a",
        drive_url: `https://drive.example/a${LF}b`,
        year: ["n.d.", "DO  - 10.9999/injected"].join(LF) as unknown as number,
      }),
      paper({ title: "DOI whose first line is no DOI name", doi: `10.1000/${LF}tail`, year: 2020 }),
      SENTINEL,
    ];
    const first = await exportRIS(corpus);
    const second = await exportRIS(parseRIS(first).papers.map(rebuild));
    const third = await exportRIS(parseRIS(second).papers.map(rebuild));
    expect(readRecords(second)).toHaveLength(3);
    expect(third).toBe(second);
    expect(parseRIS(second).papers.map((p) => [p.pmid, p.doi, p.journal_url, p.drive_url, p.year])).toEqual([
      ["12345678", `10.1000/line${LF}break`, "https://journal.example/a", "https://drive.example/a", null],
      [null, "10.1000/", "https://doi.org/10.1000/%0Atail", null, 2020],
      [null, "10.5555/sentinel.2001", "https://doi.org/10.5555/sentinel.2001", null, 2001],
    ]);
    expect(parseRIS(second).papers[0].abstract).toBe(HOSTILE);
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
