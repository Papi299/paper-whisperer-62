import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Papa from "papaparse";
import { exportToCSV } from "../exportUtils";
import { parseCSV } from "../importParsers";
import {
  normalizePaperData,
  type NormalizationConfig,
  type NormalizedPaperData,
} from "../normalizePaperData";
import type { PaperWithTags, Project, Tag } from "@/types/database";

/**
 * CSV formula injection (CWE-1236) and record integrity in the CSV export.
 *
 * The rule under test:
 *  - a cell whose first character, after any leading whitespace or control
 *    characters, is `=`, `+`, `-` or `@` (or the full-width form of one) is
 *    written as a quoted field with one added leading TAB;
 *  - a field containing a comma, a quote, `;`, CR or LF is quoted;
 *  - Year is written as its digits when it is a safe integer, and as text
 *    otherwise.
 *
 * Expected cells are written out in full rather than computed, so these tests
 * check the rule instead of restating it. Every value is harmless and
 * synthetic: arithmetic such as `=1+1`, never a function that reaches outside
 * the sheet. Code points that cannot be seen, or are easily confused with
 * ASCII, are spelled out with `cp()` so no editor or tool can change them.
 */

// ── Capture the exported file instead of downloading it ──

let downloads: Blob[] = [];

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  downloads = [];
  // jsdom has no object URLs, so the download step is stubbed and the Blob
  // captured on its way past, as in exportRoundTrip.test.ts.
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

/** The downloaded file's text, decoded as UTF-8. (jsdom's `Blob` has no `text()`.) */
const readText = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

/** The downloaded file's raw bytes. */
const readBytes = (blob: Blob): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

/** Runs the real CSV export and returns the text of the one file it downloads. */
async function exportCsv(papers: PaperWithTags[]): Promise<string> {
  downloads = [];
  exportToCSV(papers);
  expect(downloads).toHaveLength(1);
  return readText(downloads[0]);
}

// ── Code points ──

const cp = (...points: number[]): string => String.fromCodePoint(...points);

const NUL = cp(0x00);
const TAB = cp(0x09);
const LF = cp(0x0a);
const VT = cp(0x0b);
const FF = cp(0x0c);
const CR = cp(0x0d);
const UNIT_SEPARATOR = cp(0x1f);
const DEL = cp(0x7f);
const NBSP = cp(0xa0);
const EM_SPACE = cp(0x2003);
const LINE_SEPARATOR = cp(0x2028);
const MINUS_SIGN = cp(0x2212);
const IDEOGRAPHIC_SPACE = cp(0x3000);
const BOM = cp(0xfeff);
const FW_EQUALS = cp(0xff1d);
const FW_PLUS = cp(0xff0b);
const FW_MINUS = cp(0xff0d);
const FW_AT = cp(0xff20);

// ── Fixtures ──

const HEADER =
  "Title,Authors,Year,Journal,PMID,DOI,Study Types,Keywords,MeSH Terms,Substances,Tags,Projects,URL,Abstract";

/** Column positions in `HEADER`. */
const COL = {
  title: 0,
  authors: 1,
  year: 2,
  journal: 3,
  pmid: 4,
  doi: 5,
  studyTypes: 6,
  keywords: 7,
  meshTerms: 8,
  substances: 9,
  tags: 10,
  projects: 11,
  url: 12,
  abstract: 13,
} as const;

/** A paper with every exported field empty, so each test controls every cell. */
function blankPaper(overrides: Partial<PaperWithTags> = {}): PaperWithTags {
  return {
    id: "paper-1",
    user_id: "user-1",
    title: "",
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

const tag = (name: string): Tag => ({
  id: `tag-${name}`,
  user_id: "user-1",
  name,
  color: "#000000",
  created_at: "2024-01-01",
});

const project = (name: string): Project => ({
  id: `project-${name}`,
  user_id: "user-1",
  name,
  description: null,
  color: "#000000",
  created_at: "2024-01-01",
});

/** A data line from already serialized cells, keyed by column; the rest are empty. */
const line = (cells: Partial<Record<number, string>>): string =>
  Array.from({ length: 14 }, (_, i) => cells[i] ?? "").join(",");

/** A whole file: the header, then the given data lines. */
const file = (...lines: string[]): string => [HEADER, ...lines].join(LF);

// ── The file format ──

describe("the file format is unchanged", () => {
  it("keeps the header, the comma delimiter and LF line breaks, with no byte order mark", async () => {
    const text = await exportCsv([
      blankPaper({ title: "First plain title", year: 2020 }),
      blankPaper({ title: "Second plain title" }),
    ]);

    expect(text).toBe(
      file(
        line({ [COL.title]: "First plain title", [COL.year]: "2020" }),
        line({ [COL.title]: "Second plain title" }),
      ),
    );
    expect(text).not.toContain(CR);

    // The first bytes are "Title" itself.
    const bytes = await readBytes(downloads[0]);
    expect(Array.from(bytes.subarray(0, 5))).toEqual([0x54, 0x69, 0x74, 0x6c, 0x65]);
  });
});

// ── Formula-leading values ──

/** [case, stored value, serialized cell], each value the Title of an otherwise empty paper. */
const NEUTRALIZED: ReadonlyArray<readonly [string, string, string]> = [
  ["=", "=1+1", `"${TAB}=1+1"`],
  ["+", "+1+1", `"${TAB}+1+1"`],
  ["-", "-1+1", `"${TAB}-1+1"`],
  ["@", "@SUM(1,1)", `"${TAB}@SUM(1,1)"`],
  ["full-width =", `${FW_EQUALS}1+1`, `"${TAB}${FW_EQUALS}1+1"`],
  ["full-width +", `${FW_PLUS}1+1`, `"${TAB}${FW_PLUS}1+1"`],
  ["full-width -", `${FW_MINUS}1+1`, `"${TAB}${FW_MINUS}1+1"`],
  ["full-width @", `${FW_AT}SUM(1,1)`, `"${TAB}${FW_AT}SUM(1,1)"`],
  ["one leading space", " =1+1", `"${TAB} =1+1"`],
  ["several leading spaces", "   +1+1", `"${TAB}   +1+1"`],
  ["leading no-break space", `${NBSP}=1+1`, `"${TAB}${NBSP}=1+1"`],
  ["leading em space", `${EM_SPACE}-1+1`, `"${TAB}${EM_SPACE}-1+1"`],
  ["leading ideographic space", `${IDEOGRAPHIC_SPACE}=1+1`, `"${TAB}${IDEOGRAPHIC_SPACE}=1+1"`],
  ["leading line separator", `${LINE_SEPARATOR}=1+1`, `"${TAB}${LINE_SEPARATOR}=1+1"`],
  ["leading byte order mark", `${BOM}=1+1`, `"${TAB}${BOM}=1+1"`],
  ["leading TAB", `${TAB}=1+1`, `"${TAB}${TAB}=1+1"`],
  ["leading CR", `${CR}=1+1`, `"${TAB}${CR}=1+1"`],
  ["leading LF", `${LF}=1+1`, `"${TAB}${LF}=1+1"`],
  ["leading CRLF", `${CR}${LF}@SUM(1,1)`, `"${TAB}${CR}${LF}@SUM(1,1)"`],
  ["leading NUL", `${NUL}=1+1`, `"${TAB}${NUL}=1+1"`],
  ["leading vertical tab", `${VT}=1+1`, `"${TAB}${VT}=1+1"`],
  ["leading form feed", `${FF}+1+1`, `"${TAB}${FF}+1+1"`],
  ["leading unit separator", `${UNIT_SEPARATOR}=1+1`, `"${TAB}${UNIT_SEPARATOR}=1+1"`],
  ["leading DEL", `${DEL}=1+1`, `"${TAB}${DEL}=1+1"`],
  ["mixed leading run", ` ${TAB}${NBSP}${CR}${LF}-1+1`, `"${TAB} ${TAB}${NBSP}${CR}${LF}-1+1"`],
  ["quotes inside", '=1+1&"x"', `"${TAB}=1+1&""x"""`],
  ["comma inside", "=SUM(1,1)", `"${TAB}=SUM(1,1)"`],
  ["semicolon inside", "=1+1;2", `"${TAB}=1+1;2"`],
  ["LF inside", `=1+1${LF}second line`, `"${TAB}=1+1${LF}second line"`],
  ["CR inside", `=1+1${CR}second line`, `"${TAB}=1+1${CR}second line"`],
  ["a lone =", "=", `"${TAB}="`],
  ["negative number as text", "-0.42", `"${TAB}-0.42"`],
  ["positive number as text", "+0.42", `"${TAB}+0.42"`],
  ["signed confidence interval", "-0.42 (95% CI -0.61 to -0.23)", `"${TAB}-0.42 (95% CI -0.61 to -0.23)"`],
  ["temperature", "-80 °C storage of serum samples", `"${TAB}-80 °C storage of serum samples"`],
  ["plus or minus", "+/- 2 SD", `"${TAB}+/- 2 SD"`],
  ["@ in a word", "@Risk analysis of trial data", `"${TAB}@Risk analysis of trial data"`],
];

/** Values written exactly as stored: no trigger, and nothing that needs quoting. */
const UNCHANGED: ReadonlyArray<readonly [string, string]> = [
  ["empty", ""],
  ["plain title", "Effect of exercise on blood pressure"],
  ["trigger after the first character", "x=1+1"],
  ["arithmetic with no prefix", "1+1"],
  ["digits", "2020"],
  ["leading apostrophe", "'Omics' approaches in cardiology"],
  ["apostrophe then =", "'=1+1"],
  ["U+2212 minus sign", `${MINUS_SIGN}1+1`],
  ["chemical name", "(+)-Catechin and cardiovascular risk"],
  ["mathematical notation", "Δ9-THC ≥ 5 ng/mL"],
  ["plus-minus sign", "±2 SD"],
  ["Greek letters", "β-blockers and α2-agonists"],
  ["accented name", "Zoë Müller-Lüdenscheidt"],
  ["Chinese", "高血压患者的随机对照试验"],
  ["only spaces", "   "],
  ["leading TAB with no trigger", `${TAB}Tabbed title`],
  ["TAB inside", `Column A${TAB}Column B`],
  ["trailing =", "Pressure ="],
];

/** [case, stored value, serialized cell]: quoted because of its content, not neutralized. */
const QUOTED: ReadonlyArray<readonly [string, string, string]> = [
  ["comma", "Smith, John", `"Smith, John"`],
  ["quotes", 'He said "hi" twice', `"He said ""hi"" twice"`],
  ["semicolon", "Hypertension; diabetes", `"Hypertension; diabetes"`],
  ["semicolon before =", "x;=1+1", `"x;=1+1"`],
  ["quote and semicolon before =", 'x";=1+1', `"x"";=1+1"`],
  ["comma before =", "x,=1+1", `"x,=1+1"`],
  ["LF", `line1${LF}=1+1`, `"line1${LF}=1+1"`],
  ["bare CR", `line1${CR}=1+1`, `"line1${CR}=1+1"`],
  ["CRLF", `line1${CR}${LF}line2`, `"line1${CR}${LF}line2"`],
];

describe("a formula-leading value is written as a quoted field with one added TAB", () => {
  it.each(NEUTRALIZED)("%s", async (_case, value, cell) => {
    expect(await exportCsv([blankPaper({ title: value })])).toBe(file(line({ [COL.title]: cell })));
  });
});

describe("any other value keeps its characters", () => {
  it.each(UNCHANGED)("%s: written as stored", async (_case, value) => {
    expect(await exportCsv([blankPaper({ title: value })])).toBe(file(line({ [COL.title]: value })));
  });

  it.each(QUOTED)("%s: quoted, with no TAB", async (_case, value, cell) => {
    expect(await exportCsv([blankPaper({ title: value })])).toBe(file(line({ [COL.title]: cell })));
  });
});

// ── Every column ──

/** [column, paper fields, that column's serialized cell]. */
const COLUMN_SWEEP: ReadonlyArray<readonly [string, number, Partial<PaperWithTags>, string]> = [
  ["Title", COL.title, { title: "=1+1" }, `"${TAB}=1+1"`],
  ["Authors, a single name", COL.authors, { authors: ["=1+1"] }, `"${TAB}=1+1"`],
  ["Authors, the first of two", COL.authors, { authors: ["=1+1", "Doe, Jane"] }, `"${TAB}=1+1; Doe, Jane"`],
  // Two names that join into one formula: `=1+1&"; "`.
  ["Authors, names built to join into a formula", COL.authors, { authors: ['=1+1&"', '"'] }, `"${TAB}=1+1&""; """`],
  // The joined cell starts with "S", so it is text; it is quoted for its `;`.
  ["Authors, the second of two", COL.authors, { authors: ["Smith J", "=1+1"] }, `"Smith J; =1+1"`],
  ["Journal", COL.journal, { journal: "=1+1" }, `"${TAB}=1+1"`],
  ["DOI", COL.doi, { doi: "=1+1" }, `"${TAB}=1+1"`],
  ["Study Types", COL.studyTypes, { study_type: "+1+1" }, `"${TAB}+1+1"`],
  ["Keywords, the first of two", COL.keywords, { keywords: ["-1+1", "outcomes"] }, `"${TAB}-1+1; outcomes"`],
  ["MeSH Terms", COL.meshTerms, { mesh_terms: ["@SUM(1,1)"] }, `"${TAB}@SUM(1,1)"`],
  ["Substances", COL.substances, { substances: [`${FW_EQUALS}1+1`] }, `"${TAB}${FW_EQUALS}1+1"`],
  ["Tags", COL.tags, { tags: [tag("=1+1")] }, `"${TAB}=1+1"`],
  ["Projects, the first of two", COL.projects, { projects: [project(" =1+1"), project("Second")] }, `"${TAB} =1+1; Second"`],
  ["Abstract", COL.abstract, { abstract: `=1+1${LF}Second paragraph.` }, `"${TAB}=1+1${LF}Second paragraph."`],
];

describe("every free-text column is neutralized after its value is joined", () => {
  it.each(COLUMN_SWEEP)("%s", async (_column, col, fields, cell) => {
    expect(await exportCsv([blankPaper(fields)])).toBe(file(line({ [col]: cell })));
  });

  it("covers all eleven free-text columns", () => {
    const covered = [...new Set(COLUMN_SWEEP.map(([, col]) => col))].sort((a, b) => a - b);
    expect(covered).toEqual([
      COL.title, COL.authors, COL.journal, COL.doi, COL.studyTypes, COL.keywords,
      COL.meshTerms, COL.substances, COL.tags, COL.projects, COL.abstract,
    ]);
  });
});

describe("PMID and URL keep their existing validation", () => {
  it("drops a stored PMID and stored links that are not valid", async () => {
    const paper = blankPaper({ pmid: "=1+1", pubmed_url: "=1+1", journal_url: "=1+1" });
    expect(await exportCsv([paper])).toBe(file(line({})));
  });

  it("writes a valid PMID and its PubMed URL as before", async () => {
    expect(await exportCsv([blankPaper({ pmid: "12345678" })])).toBe(
      file(line({ [COL.pmid]: "12345678", [COL.url]: "https://pubmed.ncbi.nlm.nih.gov/12345678/" })),
    );
  });

  it("writes a DOI and its resolver URL as before", async () => {
    expect(await exportCsv([blankPaper({ doi: "10.1000/xyz123" })])).toBe(
      file(line({ [COL.doi]: "10.1000/xyz123", [COL.url]: "https://doi.org/10.1000/xyz123" })),
    );
  });
});

// ── Year ──

describe("Year", () => {
  it.each([
    [2020, "2020"],
    [1887, "1887"],
    [0, "0"],
    [-1, "-1"],
    [-500, "-500"],
  ])("a numeric Year %s is written as the number", async (year, cell) => {
    expect(await exportCsv([blankPaper({ year })])).toBe(file(line({ [COL.year]: cell })));
  });

  it("an empty Year stays empty", async () => {
    expect(await exportCsv([blankPaper({ year: null })])).toBe(file(line({})));
  });

  it("the same characters in a text column are text, so they are neutralized", async () => {
    expect(await exportCsv([blankPaper({ title: "-500", journal: "2020", year: -500 })])).toBe(
      file(line({ [COL.title]: `"${TAB}-500"`, [COL.journal]: "2020", [COL.year]: "-500" })),
    );
  });

  // Year is typed as a number, but nothing at runtime enforces that. A value
  // of any other type is serialized as text, by the same rule as every other
  // text field, so it cannot reach the file as a formula.
  it.each([
    ["=1+1", `"${TAB}=1+1"`],
    ["-1+1", `"${TAB}-1+1"`],
    ["@SUM(1,1)", `"${TAB}@SUM(1,1)"`],
    ["-500", `"${TAB}-500"`],
    ["2020", "2020"],
  ])("a string Year %j is serialized as text", async (year, cell) => {
    const paper = blankPaper({ year: year as unknown as number });
    expect(await exportCsv([paper])).toBe(file(line({ [COL.year]: cell })));
  });

  it.each([
    [Number.NEGATIVE_INFINITY, `"${TAB}-Infinity"`],
    [-2020.5, `"${TAB}-2020.5"`],
    [-(2 ** 53), `"${TAB}-9007199254740992"`],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [2020.5, "2020.5"],
  ])("a number that is not a safe integer (%s) is serialized as text", async (year, cell) => {
    expect(await exportCsv([blankPaper({ year })])).toBe(file(line({ [COL.year]: cell })));
  });
});

// ── Records ──

/**
 * A minimal RFC 4180 reader, independent of PapaParse. Outside quotes it ends
 * a record at CRLF, LF or a bare CR, as Excel and Python's `csv` module do.
 * PapaParse picks one line ending per file (LF here) and so does not split at
 * a bare CR: it cannot see the defect this reader can.
 */
function readRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === CR || ch === LF) {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      if (ch === CR && text[i + 1] === LF) i++;
    } else {
      field += ch;
    }
  }
  record.push(field);
  records.push(record);
  return records;
}

/** Papers carrying every structural hazard, with the fields a reader must recover. */
const HAZARDS: ReadonlyArray<{ paper: PaperWithTags; fields: string[] }> = [
  {
    paper: blankPaper({
      title: `Two lines${LF}in one title`,
      authors: ["Smith, John", "Zoë Müller"],
      year: 2021,
      journal: 'The "Quoted" Journal',
      study_type: "Randomized Controlled Trial",
      keywords: ["hypertension", "salt; sodium"],
      tags: [tag("to read")],
      abstract: `Background.${CR}${LF}${CR}${LF}Methods; results, and "quotes".${CR}A bare CR above.`,
    }),
    fields: [
      `Two lines${LF}in one title`,
      "Smith, John; Zoë Müller",
      "2021",
      'The "Quoted" Journal',
      "",
      "",
      "Randomized Controlled Trial",
      "hypertension; salt; sodium",
      "",
      "",
      "to read",
      "",
      "",
      `Background.${CR}${LF}${CR}${LF}Methods; results, and "quotes".${CR}A bare CR above.`,
    ],
  },
  {
    paper: blankPaper({
      title: `line1${CR}=1+1`,
      journal: `${CR}${LF}-1+1`,
      mesh_terms: ["Hypertension", "=1+1"],
      substances: [`${TAB}+1+1`],
      projects: [project("Thesis; chapter 2")],
      abstract: "=1+1",
    }),
    fields: [
      `line1${CR}=1+1`,
      "",
      "",
      `${TAB}${CR}${LF}-1+1`,
      "",
      "",
      "",
      "",
      "Hypertension; =1+1",
      `${TAB}${TAB}+1+1`,
      "",
      "Thesis; chapter 2",
      "",
      `${TAB}=1+1`,
    ],
  },
  { paper: blankPaper(), fields: Array<string>(14).fill("") },
  {
    paper: blankPaper({
      title: "Δ9-THC ≥ 5 ng/mL in 高血压 patients",
      authors: ["Αλέξανδρος Παπαδόπουλος"],
      year: 2019,
      journal: "Revue médicale suisse",
      keywords: ["β-blockers"],
    }),
    fields: [
      "Δ9-THC ≥ 5 ng/mL in 高血压 patients",
      "Αλέξανδρος Παπαδόπουλος",
      "2019",
      "Revue médicale suisse",
      "",
      "",
      "",
      "β-blockers",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
  },
];

const READERS: ReadonlyArray<readonly [string, (text: string) => string[][]]> = [
  ["PapaParse", (text) => Papa.parse<string[]>(text, { header: false }).data],
  ["the independent reader", readRecords],
];

describe("each paper is one logical record of 14 fields", () => {
  it("the independent reader does split at a bare CR outside quotes, as the old export wrote it", () => {
    expect(readRecords(`a${CR}=1+1,b`)).toEqual([["a"], ["=1+1", "b"]]);
    expect(readRecords(`"a${CR}=1+1",b`)).toEqual([[`a${CR}=1+1`, "b"]]);
    expect(readRecords(`x${CR}${LF}y`)).toEqual([["x"], ["y"]]);
  });

  it.each(READERS)("%s reads the header and then one record per paper", async (_reader, read) => {
    const text = await exportCsv(HAZARDS.map((h) => h.paper));
    expect(read(text)).toEqual([HEADER.split(","), ...HAZARDS.map((h) => h.fields)]);
    // A record may span several physical lines; a record is not a line.
    expect(text.split(LF).length).toBeGreaterThan(HAZARDS.length + 1);
  });

  it.each(READERS)("%s recovers each neutralized value with exactly one added TAB", async (_reader, read) => {
    const values = NEUTRALIZED.map(([, value]) => value);
    const records = read(await exportCsv(values.map((title) => blankPaper({ title }))));
    expect(records).toHaveLength(values.length + 1);
    expect(records.slice(1).map((r) => r[COL.title])).toEqual(values.map((v) => TAB + v));
    expect(records.every((r) => r.length === 14)).toBe(true);
  });

  it("writes the text as UTF-8, byte for byte", async () => {
    const unicode = HAZARDS[3];
    const text = await exportCsv([unicode.paper]);
    const expected = file(unicode.fields.join(","));
    expect(text).toBe(expected);
    expect(Array.from(await readBytes(downloads[0]))).toEqual(Array.from(new TextEncoder().encode(expected)));
  });

  it("serializes a long abstract as one field, unchanged", async () => {
    const sentence = 'Blood pressure; outcomes, "quoted" terms and Δ ≥ 5.';
    const abstract = Array.from({ length: 3000 }, (_, i) => `${i + 1}. ${sentence}`).join(`${CR}${LF}`);
    const longRun = " ".repeat(100_000);
    const records = readRecords(
      await exportCsv([
        blankPaper({ title: "Long abstract", abstract }),
        blankPaper({ title: `${longRun}=1+1` }),
        blankPaper({ title: `${longRun}x` }),
      ]),
    );
    expect(records).toHaveLength(4);
    expect(records[1][COL.abstract]).toBe(abstract);
    expect(records[2][COL.title]).toBe(`${TAB}${longRun}=1+1`);
    expect(records[3][COL.title]).toBe(`${longRun}x`);
  });
});

// ── Re-import ──

/** `escapeCSV` before this change, verbatim: the reference for re-import compatibility. */
function legacyEscapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** A data line as the old export wrote it, from the unserialized cell values. */
const legacyLine = (cells: Partial<Record<number, string>>): string =>
  Array.from({ length: 14 }, (_, i) => legacyEscapeCSV(cells[i] ?? "")).join(",");

const EMPTY_CONFIG: NormalizationConfig = {
  synonymLookup: {},
  poolStudyTypes: [],
  poolKeywords: [],
  synonymGroups: [],
};

/** What the app makes of a CSV file: the real `parseCSV`, then normalization. */
function reimport(text: string) {
  const { papers, warnings } = parseCSV(text);
  return { parsed: papers, normalized: papers.map((p) => normalizePaperData(p, EMPTY_CONFIG)), warnings };
}

/** A re-imported paper as it would be stored and exported again. Tags and projects are not imported. */
const asStored = (paper: NormalizedPaperData, i: number): PaperWithTags =>
  blankPaper({ ...paper, id: `paper-${i + 1}` });

/** The 36 Titles of the audit's matrix, PAPERLUME-SECURITY-CSV-FORMULA-INJECTION-AUDIT-001. */
const AUDIT_TITLES: readonly string[] = [
  "=1+1",
  "+1+1",
  "-1+1",
  "@SUM(1,1)",
  `${TAB}=1+1`,
  `${CR}=1+1`,
  `${LF}=1+1`,
  `${FW_EQUALS}1+1`,
  `${FW_PLUS}1+1`,
  `${FW_MINUS}1+1`,
  `${FW_AT}SUM(1,1)`,
  " =1+1",
  "x,=1+1",
  'x";=1+1',
  "x;=1+1",
  'He said "hi" twice',
  `line1${LF}=1+1`,
  `line1${CR}${LF}line2`,
  `line1${CR}=1+1`,
  "",
  "'Omics' approaches in cardiology",
  `${TAB}Tabbed legit title`,
  `${MINUS_SIGN}1+1`,
  "-0.42",
  "+0.42",
  "-0.42 (95% CI -0.61 to -0.23)",
  "=",
  "@Risk analysis of trial data",
  "-80 °C storage of serum samples",
  "+/- 2 SD",
  "(+)-Catechin and cardiovascular risk",
  "Δ9-THC ≥ 5 ng/mL",
  "1+1",
  "'=1+1",
  `${NBSP}=1+1`,
  `${BOM}=1+1`,
];

/**
 * One varied field per paper, after the audit's column sweep, plus identifiers
 * and lists: [title, paper fields, the unserialized cells the export builds].
 */
const FIELD_CASES: ReadonlyArray<readonly [string, Partial<PaperWithTags>, Partial<Record<number, string>>]> = [
  ["Authors, first", { authors: ["=1+1", "Doe, Jane"] }, { [COL.authors]: "=1+1; Doe, Jane" }],
  ["Authors, second", { authors: ["Smith J", "=1+1"] }, { [COL.authors]: "Smith J; =1+1" }],
  ["Authors, joined", { authors: ['=1+1&"', '"'] }, { [COL.authors]: '=1+1&"; "' }],
  ["Authors, accented", { authors: ["Zoë Müller", "Smith, John"] }, { [COL.authors]: "Zoë Müller; Smith, John" }],
  ["Year", { year: 2020 }, { [COL.year]: "2020" }],
  ["Year, negative", { year: -1 }, { [COL.year]: "-1" }],
  ["Journal", { journal: "=1+1" }, { [COL.journal]: "=1+1" }],
  ["Journal, leading space", { journal: " +1+1" }, { [COL.journal]: " +1+1" }],
  ["DOI", { doi: "=1+1" }, { [COL.doi]: "=1+1" }],
  ["Study Types", { study_type: "-1+1" }, { [COL.studyTypes]: "-1+1" }],
  ["Keywords", { keywords: ["=1+1", "outcomes"] }, { [COL.keywords]: "=1+1; outcomes" }],
  ["MeSH Terms", { mesh_terms: ["@SUM(1,1)", "Hypertension"] }, { [COL.meshTerms]: "@SUM(1,1); Hypertension" }],
  ["Substances", { substances: [`${FW_EQUALS}1+1`] }, { [COL.substances]: `${FW_EQUALS}1+1` }],
  ["Tags", { tags: [tag("=1+1")] }, { [COL.tags]: "=1+1" }],
  ["Projects", { projects: [project("=1+1"), project("Thesis")] }, { [COL.projects]: "=1+1; Thesis" }],
  ["Abstract", { abstract: `=1+1${LF}Second paragraph.` }, { [COL.abstract]: `=1+1${LF}Second paragraph.` }],
  ["Abstract, bare CR", { abstract: `First${CR}=1+1` }, { [COL.abstract]: `First${CR}=1+1` }],
  [
    "PMID",
    { pmid: "12345678" },
    { [COL.pmid]: "12345678", [COL.url]: "https://pubmed.ncbi.nlm.nih.gov/12345678/" },
  ],
  [
    "PubMed link only",
    { pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/7654321/" },
    { [COL.url]: "https://pubmed.ncbi.nlm.nih.gov/7654321/" },
  ],
  [
    "DOI with resolver",
    { doi: "10.1000/xyz123" },
    { [COL.doi]: "10.1000/xyz123", [COL.url]: "https://doi.org/10.1000/xyz123" },
  ],
  [
    "Journal link",
    { journal_url: "https://journal.example.com/article/1" },
    { [COL.url]: "https://journal.example.com/article/1" },
  ],
  ["Invalid identifiers", { pmid: "=1+1", pubmed_url: "=1+1", journal_url: "=1+1" }, {}],
];

const ROUND_TRIP_CASES = [
  ...AUDIT_TITLES.map((title) => ({ paper: blankPaper({ title }), cells: { [COL.title]: title } })),
  ...FIELD_CASES.map(([title, fields, cells]) => ({
    paper: blankPaper({ title, ...fields }),
    cells: { [COL.title]: title, ...cells } as Partial<Record<number, string>>,
  })),
];

describe("re-importing an export gives the same papers as before", () => {
  it("matches the old export after one export and import", async () => {
    const text = await exportCsv(ROUND_TRIP_CASES.map((c) => c.paper));
    const current = reimport(text);
    const legacy = reimport(file(...ROUND_TRIP_CASES.map((c) => legacyLine(c.cells))));

    expect(current).toEqual(legacy);
    // Not vacuous: every case but the empty Title comes back.
    expect(current.parsed).toHaveLength(ROUND_TRIP_CASES.length - 1);
    expect(current.warnings).toEqual(["CSV row 21: missing title, skipped"]);
  });

  it("keeps leading apostrophes and identifiers", async () => {
    const { normalized } = reimport(await exportCsv(ROUND_TRIP_CASES.map((c) => c.paper)));
    const byTitle = new Map(normalized.map((p) => [p.title, p]));

    expect(byTitle.has("'Omics' approaches in cardiology")).toBe(true);
    expect(byTitle.has("'=1+1")).toBe(true);
    expect(byTitle.get("PMID")).toMatchObject({
      pmid: "12345678",
      pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
    });
    expect(byTitle.get("PubMed link only")).toMatchObject({ pmid: "7654321" });
    expect(byTitle.get("DOI with resolver")).toMatchObject({ doi: "10.1000/xyz123", pmid: null });
    expect(byTitle.get("Journal link")).toMatchObject({
      pmid: null,
      journal_url: "https://journal.example.com/article/1",
    });
    expect(byTitle.get("Invalid identifiers")).toMatchObject({ pmid: null, pubmed_url: null, journal_url: null });
  });

  it("is stable over further cycles, with no TAB building up", async () => {
    const first = reimport(await exportCsv(ROUND_TRIP_CASES.map((c) => c.paper)));
    const secondText = await exportCsv(first.normalized.map(asStored));
    const second = reimport(secondText);
    expect(second.normalized).toEqual(first.normalized);

    const thirdText = await exportCsv(second.normalized.map(asStored));
    expect(thirdText).toBe(secondText);
    expect(thirdText).not.toContain(`"${TAB}${TAB}`);
  });
});
