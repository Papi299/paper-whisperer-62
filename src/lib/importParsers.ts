/**
 * File Import Parsers for BibTeX (.bib), RIS (.ris), PubMed/NLM NBIB (.nbib),
 * EndNote tagged (.enw), and CSV (.csv)
 *
 * All parsers output RawPaperData[] compatible with the normalization pipeline
 * and safe_bulk_insert_papers RPC.
 *
 * Each extension has its own grammar and its own parser. `.nbib` and `.enw` are
 * *not* RIS: PubMed's Citation Manager export is the MEDLINE tagged format and
 * EndNote's tagged import format is `%`-prefixed, so neither can be read by
 * `parseRIS`. The file extension is the routing authority — content is never
 * sniffed to guess a format, and a file whose contents do not match its
 * extension fails visibly with that format's warnings rather than being
 * reinterpreted as another format.
 */

import Papa from "papaparse";
import type { RawPaperData } from "./normalizePaperData";
import {
  canonicalPubMedUrl,
  extractPmidFromPubMedUrl,
  extractPmidFromText,
  isPubMedRecordUrl,
  normalizePmid,
  toImportableExternalUrl,
} from "./pubmedIdentifiers";

export interface FileParseResult {
  papers: RawPaperData[];
  warnings: string[];
}

// ── LaTeX accent → Unicode lookup ──

const LATEX_ACCENTS: Record<string, string> = {
  "\\`a": "à", "\\'a": "á", "\\^a": "â", "\\~a": "ã", '\\"a': "ä", "\\aa": "å",
  "\\`e": "è", "\\'e": "é", "\\^e": "ê", '\\"e': "ë",
  "\\`i": "ì", "\\'i": "í", "\\^i": "î", '\\"i': "ï",
  "\\`o": "ò", "\\'o": "ó", "\\^o": "ô", "\\~o": "õ", '\\"o': "ö",
  "\\`u": "ù", "\\'u": "ú", "\\^u": "û", '\\"u': "ü",
  "\\'c": "ć", "\\cc": "ç", "\\~n": "ñ", "\\vs": "š", "\\vz": "ž", "\\vr": "ř",
  "\\`A": "À", "\\'A": "Á", "\\^A": "Â", "\\~A": "Ã", '\\"A': "Ä",
  "\\`E": "È", "\\'E": "É", "\\^E": "Ê", '\\"E': "Ë",
  "\\`I": "Ì", "\\'I": "Í", "\\^I": "Î", '\\"I': "Ï",
  "\\`O": "Ò", "\\'O": "Ó", "\\^O": "Ô", "\\~O": "Õ", '\\"O': "Ö",
  "\\`U": "Ù", "\\'U": "Ú", "\\^U": "Û", '\\"U': "Ü",
  "\\'C": "Ć", "\\cC": "Ç", "\\~N": "Ñ", "\\vS": "Š", "\\vZ": "Ž",
  "\\ss": "ß", "\\o": "ø", "\\O": "Ø", "\\ae": "æ", "\\AE": "Æ",
};

function decodeLatex(text: string): string {
  let result = text;
  // Handle {\'e}, {\`a}, {\"o} patterns (braced accents)
  result = result.replace(/\{(\\[`'^"~cv])\{?([a-zA-Z])\}?\}/g, (_match, accent, char) => {
    const key = accent + char;
    return LATEX_ACCENTS[key] ?? char;
  });
  // Handle \'e, \`a, \"o patterns (unbraced accents)
  result = result.replace(/(\\[`'^"~cv])\{?([a-zA-Z])\}?/g, (_match, accent, char) => {
    const key = accent + char;
    return LATEX_ACCENTS[key] ?? char;
  });
  // Handle \ss, \o, \ae etc. (command-style)
  result = result.replace(/\\(ss|aa|ae|AE|o|O)\b\s*/g, (_match, cmd) => {
    const key = "\\" + cmd;
    return LATEX_ACCENTS[key] ?? cmd;
  });
  // Handle \c{c} (cedilla)
  result = result.replace(/\\c\{([a-zA-Z])\}/g, (_match, char) => {
    const key = "\\c" + char;
    return LATEX_ACCENTS[key] ?? char;
  });
  // Handle \v{s} (caron)
  result = result.replace(/\\v\{([a-zA-Z])\}/g, (_match, char) => {
    const key = "\\v" + char;
    return LATEX_ACCENTS[key] ?? char;
  });
  // Strip remaining BibTeX escapes: \& → &, \% → %, etc.
  result = result.replace(/\\([&%$#_{}])/g, "$1");
  result = result.replace(/\\textbackslash\{\}/g, "\\");
  result = result.replace(/\\textasciitilde\{\}/g, "~");
  result = result.replace(/\\textasciicircum\{\}/g, "^");
  return result;
}

/**
 * Strip outer braces from a BibTeX value.
 * e.g., "{{Preserving Capitalisation}}" → "Preserving Capitalisation"
 */
function stripOuterBraces(text: string): string {
  let result = text.trim();
  while (result.startsWith("{") && result.endsWith("}")) {
    result = result.slice(1, -1);
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
// BibTeX Parser — State-machine tokenizer (NO regex for field extraction)
// ══════════════════════════════════════════════════════════════

interface BibTeXEntry {
  type: string;
  key: string;
  fields: Record<string, string>;
}

/**
 * Extract all BibTeX entries from content using brace-depth tracking.
 * Handles nested braces at any depth.
 */
function tokenizeBibTeX(content: string): BibTeXEntry[] {
  const entries: BibTeXEntry[] = [];
  let i = 0;

  while (i < content.length) {
    // Find the next @ that starts an entry
    const atIdx = content.indexOf("@", i);
    if (atIdx === -1) break;

    // Extract entry type (e.g., "article", "inproceedings")
    let typeEnd = atIdx + 1;
    while (typeEnd < content.length && /[a-zA-Z]/.test(content[typeEnd])) {
      typeEnd++;
    }
    const entryType = content.substring(atIdx + 1, typeEnd).toLowerCase();

    // Skip non-entry types like @comment, @preamble, @string
    if (entryType === "comment" || entryType === "preamble" || entryType === "string") {
      // Skip past the block
      const openBrace = content.indexOf("{", typeEnd);
      if (openBrace === -1) { i = typeEnd; continue; }
      let depth = 1;
      let j = openBrace + 1;
      while (j < content.length && depth > 0) {
        if (content[j] === "{") depth++;
        else if (content[j] === "}") depth--;
        j++;
      }
      i = j;
      continue;
    }

    // Find opening brace
    const openBrace = content.indexOf("{", typeEnd);
    if (openBrace === -1) { i = typeEnd; continue; }

    // Find matching closing brace using depth counter
    let depth = 1;
    let j = openBrace + 1;
    while (j < content.length && depth > 0) {
      if (content[j] === "{") depth++;
      else if (content[j] === "}") depth--;
      j++;
    }

    if (depth !== 0) {
      // Unmatched braces, skip
      i = j;
      continue;
    }

    const entryBody = content.substring(openBrace + 1, j - 1);

    // Extract citation key (everything before first comma)
    const firstComma = entryBody.indexOf(",");
    if (firstComma === -1) {
      i = j;
      continue;
    }

    const key = entryBody.substring(0, firstComma).trim();
    const fieldsStr = entryBody.substring(firstComma + 1);

    // Parse fields using state machine
    const fields = parseBibTeXFields(fieldsStr);

    entries.push({ type: entryType, key, fields });
    i = j;
  }

  return entries;
}

/**
 * State-machine field parser. Extracts key=value pairs from BibTeX entry body.
 * Handles both {braced values} and "quoted values" with nested braces.
 */
function parseBibTeXFields(fieldsStr: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;

  while (i < fieldsStr.length) {
    // Skip whitespace and commas
    while (i < fieldsStr.length && /[\s,]/.test(fieldsStr[i])) i++;
    if (i >= fieldsStr.length) break;

    // Extract field name
    const nameStart = i;
    while (i < fieldsStr.length && fieldsStr[i] !== "=" && !/[\s,{}]/.test(fieldsStr[i])) i++;
    const fieldName = fieldsStr.substring(nameStart, i).trim().toLowerCase();
    if (!fieldName) break;

    // Skip whitespace and '='
    while (i < fieldsStr.length && /\s/.test(fieldsStr[i])) i++;
    if (i >= fieldsStr.length || fieldsStr[i] !== "=") {
      // Not a valid field assignment, skip
      continue;
    }
    i++; // skip '='
    while (i < fieldsStr.length && /\s/.test(fieldsStr[i])) i++;
    if (i >= fieldsStr.length) break;

    // Extract field value
    let value = "";
    if (fieldsStr[i] === "{") {
      // Brace-delimited value — count depth
      let depth = 1;
      i++; // skip opening brace
      const valueStart = i;
      while (i < fieldsStr.length && depth > 0) {
        if (fieldsStr[i] === "{") depth++;
        else if (fieldsStr[i] === "}") depth--;
        if (depth > 0) i++;
      }
      value = fieldsStr.substring(valueStart, i);
      if (i < fieldsStr.length) i++; // skip closing brace
    } else if (fieldsStr[i] === '"') {
      // Quote-delimited value — find matching quote (respecting nested braces)
      i++; // skip opening quote
      const valueStart = i;
      let depth = 0;
      while (i < fieldsStr.length) {
        if (fieldsStr[i] === "{") depth++;
        else if (fieldsStr[i] === "}") depth--;
        else if (fieldsStr[i] === '"' && depth === 0) break;
        i++;
      }
      value = fieldsStr.substring(valueStart, i);
      if (i < fieldsStr.length) i++; // skip closing quote
    } else {
      // Bare value (number or string concatenation — just grab until comma)
      const valueStart = i;
      while (i < fieldsStr.length && fieldsStr[i] !== "," && fieldsStr[i] !== "}") i++;
      value = fieldsStr.substring(valueStart, i).trim();
    }

    fields[fieldName] = value;
  }

  return fields;
}

function bibtexEntryToRawPaper(entry: BibTeXEntry): RawPaperData | null {
  const f = entry.fields;
  const title = decodeLatex(stripOuterBraces(f.title || "")).trim();
  if (!title) return null;

  // Parse authors: split on " and ", decode LaTeX
  const authors = f.author
    ? f.author.split(/\s+and\s+/i).map((a) => decodeLatex(stripOuterBraces(a)).trim()).filter(Boolean)
    : [];

  // Parse year
  const yearStr = stripOuterBraces(f.year || "");
  const yearMatch = yearStr.match(/(\d{4})/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  // Parse keywords: comma-separated
  const keywords = f.keywords
    ? f.keywords.split(/,\s*/).map((k) => decodeLatex(stripOuterBraces(k)).trim()).filter(Boolean)
    : [];

  // Extract study type from note field
  const noteVal = f.note ? decodeLatex(stripOuterBraces(f.note)).trim() : null;
  const studyTypeMatch = noteVal?.match(/^Study type:\s*(.+)/i);
  const study_type = studyTypeMatch ? studyTypeMatch[1].trim() : null;

  // DOI
  const doi = f.doi ? stripOuterBraces(f.doi).trim() : null;

  const url = f.url ? stripOuterBraces(f.url).trim() : null;

  // PMID, in descending order of authority. Every source is checked
  // structurally, so a URL that merely mentions PubMed contributes nothing:
  //   1. the explicit `pmid` field, validated as a bare decimal PMID;
  //   2. a PubMed record URL in `url`;
  //   3. a PubMed record URL embedded in the free-text `note`.
  const pmid =
    normalizePmid(f.pmid ? stripOuterBraces(f.pmid) : null) ??
    extractPmidFromPubMedUrl(url) ??
    extractPmidFromText(noteVal);

  // A PubMed link is stored only once a PMID has been authenticated, and always
  // in canonical form — imported path syntax, query strings and fragments are
  // not provenance and are not preserved.
  const pubmed_url = pmid ? canonicalPubMedUrl(pmid) : null;

  // Any other valid http(s) `url` is a generic source link. A DOI resolver URL
  // belongs here too: it is a real link to the work, so it is kept rather than
  // discarded for containing "doi.org".
  const journal_url = isPubMedRecordUrl(url) ? null : toImportableExternalUrl(url);

  return {
    title,
    authors,
    year,
    journal: f.journal ? decodeLatex(stripOuterBraces(f.journal)).trim() : null,
    pmid,
    doi,
    abstract: f.abstract ? decodeLatex(stripOuterBraces(f.abstract)).trim() : null,
    keywords,
    mesh_terms: [],
    substances: [],
    study_type,
    pubmed_url,
    journal_url,
    drive_url: null,
  };
}

export function parseBibTeX(content: string): FileParseResult {
  const papers: RawPaperData[] = [];
  const warnings: string[] = [];

  const entries = tokenizeBibTeX(content);

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    const paper = bibtexEntryToRawPaper(entry);
    if (paper) {
      papers.push(paper);
    } else {
      warnings.push(`Entry ${idx + 1} (${entry.key || "unknown"}): missing title, skipped`);
    }
  }

  if (entries.length === 0 && content.trim().length > 0) {
    warnings.push("No valid BibTeX entries found in file.");
  }

  return { papers, warnings };
}

// ══════════════════════════════════════════════════════════════
// RIS Parser — Line-delimited block parser
// ══════════════════════════════════════════════════════════════

interface RISEntry {
  tags: Array<{ tag: string; value: string }>;
}

function parseRISEntries(content: string): RISEntry[] {
  const entries: RISEntry[] = [];
  let currentEntry: RISEntry | null = null;

  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    // Standard RIS line: "XX  - value" (value may be empty)
    const match = line.match(/^([A-Z][A-Z0-9])\s\s-\s?(.*)$/);
    if (match) {
      const [, tag, value] = match;
      if (tag === "TY") {
        currentEntry = { tags: [] };
        currentEntry.tags.push({ tag, value: value.trim() });
      } else if (tag === "ER") {
        if (currentEntry) {
          entries.push(currentEntry);
          currentEntry = null;
        }
      } else if (currentEntry) {
        currentEntry.tags.push({ tag, value: value.trim() });
      }
    }
  }

  // Handle entry without ER terminator
  if (currentEntry && currentEntry.tags.length > 0) {
    entries.push(currentEntry);
  }

  return entries;
}

function risEntryToRawPaper(entry: RISEntry): RawPaperData | null {
  const getFirst = (tag: string): string | null => {
    const found = entry.tags.find((t) => t.tag === tag);
    return found ? found.value : null;
  };

  const getAll = (tag: string): string[] =>
    entry.tags.filter((t) => t.tag === tag).map((t) => t.value).filter(Boolean);

  // Title: T1 (primary), TI (alternate), T2 (secondary/book title)
  const title = getFirst("T1") || getFirst("TI") || getFirst("T2");
  if (!title || !title.trim()) return null;

  // Authors: AU tags
  const authors = getAll("AU").concat(getAll("A1"));

  // Year: PY field, extract first 4 digits
  const pyVal = getFirst("PY") || getFirst("Y1") || getFirst("DA");
  const yearMatch = pyVal?.match(/(\d{4})/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  // Journal: JO, JF, JA, T2 (for journal articles)
  const journal = getFirst("JO") || getFirst("JF") || getFirst("JA");

  // DOI — `DO` is unambiguously the DOI tag.
  //
  // There is deliberately no PMID tag read here. `AN` is the generic RIS
  // Accession Number: it carries whatever identifier the exporting database
  // assigns, which is a PMID for Ovid MEDLINE but an Embase, Scopus or Web of
  // Science accession elsewhere. Nothing in the tag itself distinguishes those,
  // and numeric shape does not either — a numeric Embase accession looks
  // exactly like a PMID. Trusting `AN` therefore writes foreign identifiers
  // into `papers.pmid`, which is a deduplication key. The PMID is instead
  // recovered below from an authenticated PubMed record URL, which proves what
  // `AN` only asserts.
  const doi = getFirst("DO");

  // Abstract
  const abstract = getFirst("AB") || getFirst("N2");

  // Keywords
  const keywords = getAll("KW");

  // URLs. The PMID comes from the first `UR` that is structurally a PubMed
  // record URL, and the stored PubMed link is that record's canonical form.
  const urls = getAll("UR");
  const pmid = urls.reduce<string | null>(
    (found, u) => found ?? extractPmidFromPubMedUrl(u),
    null,
  );
  const pubmed_url = pmid ? canonicalPubMedUrl(pmid) : null;

  // Journal link: the explicit `L2` tag wins, and is never overwritten just
  // because a generic `UR` also exists. Otherwise the first valid non-PubMed
  // `UR` is preserved rather than dropped.
  const firstGenericUrl =
    urls
      .filter((u) => !isPubMedRecordUrl(u))
      .map((u) => toImportableExternalUrl(u))
      .find((u): u is string => u !== null) ?? null;
  const journal_url = toImportableExternalUrl(getFirst("L2")) ?? firstGenericUrl;

  const drive_url = getFirst("L1");

  // Study type from N1 (notes)
  const noteVal = getFirst("N1");
  const studyTypeMatch = noteVal?.match(/^Study type:\s*(.+)/i);
  const study_type = studyTypeMatch ? studyTypeMatch[1].trim() : (noteVal || null);

  return {
    title: title.trim(),
    authors,
    year,
    journal: journal?.trim() || null,
    pmid,
    doi: doi?.trim() || null,
    abstract: abstract?.trim() || null,
    keywords,
    mesh_terms: [],
    substances: [],
    study_type,
    pubmed_url,
    journal_url,
    drive_url: drive_url?.trim() || null,
  };
}

export function parseRIS(content: string): FileParseResult {
  const papers: RawPaperData[] = [];
  const warnings: string[] = [];

  const entries = parseRISEntries(content);

  for (let idx = 0; idx < entries.length; idx++) {
    const paper = risEntryToRawPaper(entries[idx]);
    if (paper) {
      papers.push(paper);
    } else {
      warnings.push(`RIS entry ${idx + 1}: missing title, skipped`);
    }
  }

  if (entries.length === 0 && content.trim().length > 0) {
    warnings.push("No valid RIS entries found in file.");
  }

  return { papers, warnings };
}

// ══════════════════════════════════════════════════════════════
// Tagged-record primitives — shared by the NBIB and EndNote parsers
//
// Both formats are line-oriented records of repeatable `tag → value` fields.
// Only the tag grammar and the field *semantics* differ, so the accessors are
// shared while tokenization and mapping stay per-format — a tag that means one
// thing in PubMed must never be read as its EndNote namesake.
// ══════════════════════════════════════════════════════════════

interface TaggedField {
  tag: string;
  value: string;
}

/** One record: its fields in file order, repeats preserved. */
type TaggedRecord = TaggedField[];

function firstFieldValue(record: TaggedRecord, tag: string): string | null {
  const found = record.find((field) => field.tag === tag);
  return found ? found.value : null;
}

function allFieldValues(record: TaggedRecord, tag: string): string[] {
  return record
    .filter((field) => field.tag === tag)
    .map((field) => field.value)
    .filter(Boolean);
}

/** First four-digit run in a free-form date, as the other parsers read years. */
function extractYear(value: string | null): number | null {
  const match = value?.match(/(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

/** Append a wrapped physical line to the logical value it continues. */
function appendContinuation(record: TaggedRecord, line: string): void {
  const previous = record[record.length - 1];
  const continuation = line.trim();
  previous.value = previous.value ? `${previous.value} ${continuation}` : continuation;
}

// ══════════════════════════════════════════════════════════════
// PubMed / NLM NBIB Parser — native MEDLINE tagged-record parser
//
// PubMed's "Send to → Citation manager" export (`.nbib`) is the MEDLINE tagged
// format. A field line carries its tag left-justified in a four-character
// column, then `-`, then the value from column seven; long values wrap onto
// indented physical lines, and citations are separated by one blank line:
//
//     PMID- 39725180
//     DP  - 2025 May
//     JT  - Journal of renal nutrition : the official journal of the Council on
//           Renal Nutrition of the National Kidney Foundation
//     AID - 10.1053/j.jrn.2024.12.006 [doi]
//
// A *logical* field is therefore the tag line plus every indented line that
// follows it — the shape RIS has no notion of, and the reason `parseRIS` could
// never read this format.
// ══════════════════════════════════════════════════════════════

/** Width of the left-justified tag column; the `-` separator sits just after. */
const NBIB_TAG_COLUMN_WIDTH = 4;

/** A tag is a short uppercase token — `TI`, `FAU`, `PMID`, `EDAT`. */
const NBIB_TAG_PATTERN = /^[A-Z][A-Z0-9]{0,3}$/;

/**
 * An `AID`/`LID` value whose identifier type is explicitly declared to be a
 * DOI. The qualifier is the authority: it is the only thing distinguishing
 * `10.1053/j.jrn.2024.12.006 [doi]` from the equally punctuated publisher item
 * identifier `S1051-2276(24)00291-7 [pii]`.
 */
const NBIB_DOI_QUALIFIER = /^(.+?)\s*\[doi\]$/i;

/**
 * NLM marks a MeSH major topic with an asterisk on the heading or on one of its
 * subheadings — `*Magnesium Deficiency/complications` — so the asterisk is a
 * majorness marker rather than vocabulary text. PubMed's own API never emits it
 * (`<DescriptorName>` holds the bare heading and majorness rides an attribute),
 * so it is stripped in both positions to keep one representation of a MeSH term
 * across the file-import and API paths.
 */
const MESH_MAJOR_TOPIC_MARKER = /(^|\/)\*/g;

function stripMeshMajorTopicMarkers(term: string): string {
  return term.replace(MESH_MAJOR_TOPIC_MARKER, "$1");
}

/**
 * Recognize a PubMed field line from the tag *syntax*, not from a list of the
 * tags Paperlume consumes, so an unfamiliar tag still ends the previous field
 * instead of being swallowed as part of its wrapped value.
 */
function parseNbibTagLine(line: string): TaggedField | null {
  if (line.length <= NBIB_TAG_COLUMN_WIDTH) return null;
  if (line[NBIB_TAG_COLUMN_WIDTH] !== "-") return null;

  const column = line.slice(0, NBIB_TAG_COLUMN_WIDTH);
  const tag = column.trimEnd();
  // The tag is left-justified, so padding is only ever on the right. This is
  // what separates a field line from an indented continuation.
  if (tag !== column.trim() || !NBIB_TAG_PATTERN.test(tag)) return null;

  return { tag, value: line.slice(NBIB_TAG_COLUMN_WIDTH + 1).trim() };
}

function parseNbibRecords(content: string): TaggedRecord[] {
  const records: TaggedRecord[] = [];
  let current: TaggedRecord = [];

  const flush = () => {
    if (current.length > 0) {
      records.push(current);
      current = [];
    }
  };

  for (const line of content.split(/\r?\n/)) {
    // A blank line closes the record: PubMed separates citations with exactly
    // one, and no field value contains one.
    if (!line.trim()) {
      flush();
      continue;
    }

    const field = parseNbibTagLine(line);
    if (field) {
      // `PMID` opens every citation, so treating it as a boundary keeps
      // adjacent records apart even in an export that lost its blank separator.
      if (field.tag === "PMID") flush();
      current.push(field);
      continue;
    }

    // An indented line continues the field above it. Both sides were trimmed
    // during tokenization, so re-joining with a single space restores the
    // logical value exactly — PubMed wraps at word boundaries.
    if (/^\s/.test(line) && current.length > 0) {
      appendContinuation(current, line);
    }
    // Anything else is outside the record grammar and is ignored rather than
    // guessed at.
  }

  flush();
  return records;
}

/** First value in `values` that is explicitly qualified as a DOI. */
function firstQualifiedDoi(values: string[]): string | null {
  for (const value of values) {
    const doi = value.match(NBIB_DOI_QUALIFIER)?.[1].trim();
    if (doi) return doi;
  }
  return null;
}

function nbibRecordToRawPaper(record: TaggedRecord): RawPaperData | null {
  const title = firstFieldValue(record, "TI")?.trim();
  if (!title) return null;

  // FAU and AU are two representations of the *same* personal authors, so
  // reading both would duplicate every name. FAU carries the full form
  // ("Jin, Youkai") and wins; AU ("Jin Y") is used only when FAU is absent.
  const fullAuthors = allFieldValues(record, "FAU");
  const authors = fullAuthors.length > 0 ? fullAuthors : allFieldValues(record, "AU");

  // CN is a corporate author — real authorship that neither FAU nor AU carries
  // — appended in file order, skipping a name already selected above.
  const selected = new Set(authors);
  for (const corporate of allFieldValues(record, "CN")) {
    if (!selected.has(corporate)) {
      selected.add(corporate);
      authors.push(corporate);
    }
  }

  // DP is the date of publication. EDAT / MHDA / CRDT are Entrez processing
  // dates — when NLM handled the record, not when the work was published — and
  // are deliberately never consulted for the year.
  const year = extractYear(firstFieldValue(record, "DP"));

  // JT is the full journal title; TA is its NLM abbreviation, used only when
  // the export carries no JT. `SO` is a formatted citation string, not a
  // journal field, and is not mined for one.
  const journal = firstFieldValue(record, "JT") || firstFieldValue(record, "TA");

  // `PMID` is PubMed's own identifier field, so unlike a generic accession it
  // may establish the PMID. The declared value is still validated as bare
  // decimal digits, and the stored link is always the canonical record URL
  // derived from it — no other NBIB field can rescue an invalid one.
  const pmid = normalizePmid(firstFieldValue(record, "PMID"));
  const pubmed_url = pmid ? canonicalPubMedUrl(pmid) : null;

  // AID and LID both hold identifiers of several kinds, each tagged with its
  // type, so only an explicitly `[doi]`-qualified value is a DOI.
  const doi =
    firstQualifiedDoi(allFieldValues(record, "AID")) ??
    firstQualifiedDoi(allFieldValues(record, "LID"));

  // AB is the article's abstract. OAB ("Other Abstract") is a substitute
  // supplied by another source; it stands in only when AB is absent, and the
  // two are never appended to each other.
  const abstracts = allFieldValues(record, "AB");
  const abstract = (abstracts.length > 0 ? abstracts : allFieldValues(record, "OAB")).join(" ");

  // Repeated PT values feed the existing comma-separated study-type input, so
  // `evaluateStudyType()` picks the user-pool winner exactly as it already does
  // for PubMed API results, which join `<PublicationType>` the same way.
  const publicationTypes = allFieldValues(record, "PT");

  return {
    title,
    authors,
    year,
    journal: journal?.trim() || null,
    pmid,
    doi,
    abstract: abstract || null,
    // OT carries author- and publisher-supplied keywords. MeSH headings are a
    // separate controlled vocabulary with their own destination below, so they
    // are not folded in here.
    keywords: allFieldValues(record, "OT"),
    mesh_terms: allFieldValues(record, "MH").map(stripMeshMajorTopicMarkers).filter(Boolean),
    // NM is the Substance Name — a bare name, the same shape the API path takes
    // from `<NameOfSubstance>`. RN is deliberately unread: it is a registry
    // entry, displayed as `I38ZP9992A (Magnesium)`, so storing it verbatim
    // would put a CAS/EC number into a list of substance names.
    substances: allFieldValues(record, "NM"),
    study_type: publicationTypes.length > 0 ? publicationTypes.join(", ") : null,
    pubmed_url,
    // A native NBIB record carries no article URL: the PubMed link is derived
    // from the validated PMID above, and there is no generic source link to
    // take without inventing one out of citation text.
    journal_url: null,
    drive_url: null,
  };
}

export function parseNBIB(content: string): FileParseResult {
  const papers: RawPaperData[] = [];
  const warnings: string[] = [];

  const records = parseNbibRecords(content);

  for (let idx = 0; idx < records.length; idx++) {
    const paper = nbibRecordToRawPaper(records[idx]);
    if (paper) {
      papers.push(paper);
    } else {
      warnings.push(`NBIB record ${idx + 1}: missing title, skipped`);
    }
  }

  if (records.length === 0 && content.trim().length > 0) {
    warnings.push("No valid PubMed/NBIB records found in file.");
  }

  return { papers, warnings };
}

// ══════════════════════════════════════════════════════════════
// EndNote Tagged Parser — native `%`-tag parser
//
// EndNote's tagged import format (`.enw`) is not RIS either. Each field starts
// with a percent sign and a single tag character — a capital letter, a digit or
// a special character — followed by a space and the value; whole references are
// separated by one blank line:
//
//     %0 Journal Article
//     %A Smith, John
//     %T A useful paper
//     %R 10.1000/example
//
// ══════════════════════════════════════════════════════════════

/**
 * `%` + exactly one tag character + separator. The tag is never case-folded:
 * EndNote defines capitals, so `%a` is an unknown tag and is safely ignored
 * rather than assumed to mean `%A`.
 */
const ENW_TAG_LINE = /^%(\S)(?:[ \t]+(.*))?$/;

function parseEndNoteRecords(content: string): TaggedRecord[] {
  const records: TaggedRecord[] = [];
  let current: TaggedRecord = [];

  const flush = () => {
    if (current.length > 0) {
      records.push(current);
      current = [];
    }
  };

  for (const line of content.split(/\r?\n/)) {
    // One blank line separates whole references.
    if (!line.trim()) {
      flush();
      continue;
    }

    const match = line.match(ENW_TAG_LINE);
    if (match) {
      current.push({ tag: match[1], value: (match[2] ?? "").trim() });
      continue;
    }

    // A non-tag line inside a record continues the field above it. Because a
    // blank line has already closed any previous reference, this can never
    // merge two records; untagged prose with no field above it is discarded
    // rather than invented into a reference of its own.
    if (current.length > 0) {
      appendContinuation(current, line);
    }
  }

  flush();
  return records;
}

function endNoteRecordToRawPaper(record: TaggedRecord): RawPaperData | null {
  const title = firstFieldValue(record, "T")?.trim();
  if (!title) return null;

  // Each %A is one whole author. EndNote writes names as "Smith, John", so
  // splitting the value on its comma would turn one person into two.
  const authors = allFieldValues(record, "A");

  // %D is the Year field; %8 is the Date field and supplies a year only when %D
  // does not — the same fallback shape the RIS parser uses from PY to DA.
  const year =
    extractYear(firstFieldValue(record, "D")) ?? extractYear(firstFieldValue(record, "8"));

  // %J is the journal name; %B (Secondary Title) carries the container title in
  // exports that omit %J. One or the other, never both concatenated.
  const journal = firstFieldValue(record, "J") || firstFieldValue(record, "B");

  // %U is the URL field. The first structurally authenticated PubMed record URL
  // establishes the PMID, and the first valid non-PubMed http(s) URL is kept as
  // the generic source link; the two coexist. Recognition is reused wholesale
  // from the shared PubMed identifier module — never a substring test.
  //
  // This is the *only* PMID authority for an EndNote record. %M is EndNote's
  // Accession Number: whatever identifier the exporting database assigned — an
  // Embase, Scopus or Web of Science accession as readily as a PMID — and
  // numeric shape does not distinguish them, so it is never read as a PMID,
  // exactly as RIS `AN` is not.
  const urls = allFieldValues(record, "U");
  const pmid = urls.reduce<string | null>(
    (found, url) => found ?? extractPmidFromPubMedUrl(url),
    null,
  );
  const pubmed_url = pmid ? canonicalPubMedUrl(pmid) : null;
  const journal_url =
    urls
      .filter((url) => !isPubMedRecordUrl(url))
      .map((url) => toImportableExternalUrl(url))
      .find((url): url is string => url !== null) ?? null;

  return {
    title,
    authors,
    year,
    journal: journal?.trim() || null,
    pmid,
    // %R is the DOI by EndNote's own definition and stands on its own: it needs
    // no corroborating %U, and no other identifier field may supply it.
    doi: firstFieldValue(record, "R")?.trim() || null,
    abstract: firstFieldValue(record, "X")?.trim() || null,
    keywords: allFieldValues(record, "K"),
    // EndNote tagged records carry no MeSH or substance vocabulary.
    mesh_terms: [],
    substances: [],
    // %0 is the bibliographic Reference Type ("Journal Article") and %9 the
    // Type of Work. Both describe the *container*, not the research design, so
    // neither is allowed to masquerade as a Paperlume study type.
    study_type: null,
    pubmed_url,
    journal_url,
    drive_url: null,
  };
}

export function parseEndNoteTagged(content: string): FileParseResult {
  const papers: RawPaperData[] = [];
  const warnings: string[] = [];

  const records = parseEndNoteRecords(content);

  for (let idx = 0; idx < records.length; idx++) {
    const paper = endNoteRecordToRawPaper(records[idx]);
    if (paper) {
      papers.push(paper);
    } else {
      warnings.push(`EndNote record ${idx + 1}: missing title, skipped`);
    }
  }

  if (records.length === 0 && content.trim().length > 0) {
    warnings.push("No valid EndNote tagged records found in file.");
  }

  return { papers, warnings };
}

// ══════════════════════════════════════════════════════════════
// CSV Parser — Using PapaParse for robust field handling
// ══════════════════════════════════════════════════════════════

/** Case-insensitive header mapping with common aliases */
const CSV_HEADER_ALIASES: Record<string, string[]> = {
  title: ["title", "article_title", "paper_title", "document_title"],
  authors: ["authors", "author", "author(s)", "creator"],
  year: ["year", "publication_year", "pub_year", "date", "publication_date"],
  journal: ["journal", "journal_title", "source", "publication", "journal/book"],
  // `an` is deliberately absent: a column headed "AN" is a generic accession
  // number whose meaning depends on the exporting database, not a PMID.
  pmid: ["pmid", "pubmed_id", "pubmed id"],
  doi: ["doi", "digital_object_identifier"],
  study_type: ["study types", "study_type", "study type", "type", "document_type"],
  keywords: ["keywords", "keyword", "author_keywords", "author keywords"],
  mesh_terms: ["mesh terms", "mesh_terms", "mesh", "mesh headings"],
  substances: ["substances", "chemicals", "chemical_substances"],
  url: ["url", "link", "pubmed_url"],
  abstract: ["abstract", "description", "summary"],
  tags: ["tags", "labels"],
  projects: ["projects", "collections", "folders"],
};

function findHeaderIndex(headers: string[], aliases: string[]): number {
  const normalizedHeaders = headers.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = normalizedHeaders.indexOf(alias.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function splitSemicolon(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  return value.split(/;\s*/).map((s) => s.trim()).filter(Boolean);
}

export function parseCSV(content: string): FileParseResult {
  const papers: RawPaperData[] = [];
  const warnings: string[] = [];

  const parsed = Papa.parse(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header: string) => header.trim(),
  });

  if (parsed.errors.length > 0) {
    for (const err of parsed.errors.slice(0, 5)) {
      warnings.push(`CSV row ${(err.row ?? 0) + 2}: ${err.message}`);
    }
  }

  const rows = parsed.data as Record<string, string>[];
  if (rows.length === 0) {
    warnings.push("No data rows found in CSV.");
    return { papers, warnings };
  }

  // Build header index map
  const headers = parsed.meta.fields || [];
  const colMap: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
    colMap[field] = findHeaderIndex(headers, aliases);
  }

  const getVal = (row: Record<string, string>, field: string): string => {
    const idx = colMap[field];
    if (idx === -1) return "";
    const key = headers[idx];
    return (row[key] || "").trim();
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const title = getVal(row, "title");
    if (!title) {
      warnings.push(`CSV row ${i + 2}: missing title, skipped`);
      continue;
    }

    const yearStr = getVal(row, "year");
    const yearMatch = yearStr.match(/(\d{4})/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

    const doi = getVal(row, "doi") || null;
    const urlVal = getVal(row, "url");

    // An explicit PMID column outranks the URL column, but both are validated
    // structurally before they can establish a PubMed identity.
    const pmid = normalizePmid(getVal(row, "pmid")) ?? extractPmidFromPubMedUrl(urlVal);
    const pubmed_url = pmid ? canonicalPubMedUrl(pmid) : null;

    // A generic URL column is a generic source link. It previously fell through
    // into `pubmed_url` with no test at all; it now goes to the journal slot,
    // which CSV used to leave permanently null.
    const journal_url = isPubMedRecordUrl(urlVal) ? null : toImportableExternalUrl(urlVal);

    papers.push({
      title,
      authors: splitSemicolon(getVal(row, "authors")),
      year,
      journal: getVal(row, "journal") || null,
      pmid,
      doi,
      abstract: getVal(row, "abstract") || null,
      keywords: splitSemicolon(getVal(row, "keywords")),
      mesh_terms: splitSemicolon(getVal(row, "mesh_terms")),
      substances: splitSemicolon(getVal(row, "substances")),
      study_type: getVal(row, "study_type") || null,
      pubmed_url,
      journal_url,
      drive_url: null,
    });
  }

  return { papers, warnings };
}

// ══════════════════════════════════════════════════════════════
// Auto-detect by file extension
// ══════════════════════════════════════════════════════════════

export function parseFile(content: string, filename: string): FileParseResult {
  const ext = filename.toLowerCase().split(".").pop();
  switch (ext) {
    case "bib":
      return parseBibTeX(content);
    case "ris":
      return parseRIS(content);
    // `.nbib` and `.enw` used to fall through to `parseRIS`, which claimed
    // support for two formats it cannot read. Each now routes to its own
    // grammar, and content that does not match its extension fails with that
    // format's warnings instead of being reinterpreted as RIS.
    case "nbib":
      return parseNBIB(content);
    case "enw":
      return parseEndNoteTagged(content);
    case "csv":
    case "tsv":
      return parseCSV(content);
    default:
      return {
        papers: [],
        warnings: [`Unsupported file format: .${ext}. Supported: .bib, .ris, .nbib, .enw, .csv`],
      };
  }
}
