/**
 * File Import Parsers for BibTeX (.bib), RIS (.ris), and CSV (.csv)
 *
 * All parsers output RawPaperData[] compatible with the normalization pipeline
 * and safe_bulk_insert_papers RPC.
 */

import Papa from "papaparse";
import type { RawPaperData } from "./normalizePaperData";

export interface FileParseResult {
  papers: RawPaperData[];
  warnings: string[];
}

// ── LaTeX accent → Unicode lookup ──

const LATEX_ACCENTS: Record<string, string> = {
  "\\`a": "à", "\\'a": "á", "\\^a": "â", "\\~a": "ã", '\\\"a': "ä", "\\aa": "å",
  "\\`e": "è", "\\'e": "é", "\\^e": "ê", '\\\"e': "ë",
  "\\`i": "ì", "\\'i": "í", "\\^i": "î", '\\\"i': "ï",
  "\\`o": "ò", "\\'o": "ó", "\\^o": "ô", "\\~o": "õ", '\\\"o': "ö",
  "\\`u": "ù", "\\'u": "ú", "\\^u": "û", '\\\"u': "ü",
  "\\'c": "ć", "\\cc": "ç", "\\~n": "ñ", "\\vs": "š", "\\vz": "ž", "\\vr": "ř",
  "\\`A": "À", "\\'A": "Á", "\\^A": "Â", "\\~A": "Ã", '\\\"A': "Ä",
  "\\`E": "È", "\\'E": "É", "\\^E": "Ê", '\\\"E': "Ë",
  "\\`I": "Ì", "\\'I": "Í", "\\^I": "Î", '\\\"I': "Ï",
  "\\`O": "Ò", "\\'O": "Ó", "\\^O": "Ô", "\\~O": "Õ", '\\\"O': "Ö",
  "\\`U": "Ù", "\\'U": "Ú", "\\^U": "Û", '\\\"U': "Ü",
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
    let nameStart = i;
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

  // PMID (custom field)
  const pmid = f.pmid ? stripOuterBraces(f.pmid).trim() : null;

  // URL
  const url = f.url ? stripOuterBraces(f.url).trim() : null;
  const pubmed_url = url && url.includes("pubmed") ? url : (pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null);
  const journal_url = url && !url.includes("pubmed") && !url.includes("doi.org") ? url : null;

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

  // Identifiers
  const pmid = getFirst("AN");
  const doi = getFirst("DO");

  // Abstract
  const abstract = getFirst("AB") || getFirst("N2");

  // Keywords
  const keywords = getAll("KW");

  // URLs
  const urls = getAll("UR");
  const pubmed_url = urls.find((u) => u.includes("pubmed")) || (pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null);
  const journal_url = getFirst("L2");
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
    pmid: pmid?.trim() || null,
    doi: doi?.trim() || null,
    abstract: abstract?.trim() || null,
    keywords,
    mesh_terms: [],
    substances: [],
    study_type,
    pubmed_url: typeof pubmed_url === "string" ? pubmed_url : null,
    journal_url: journal_url?.trim() || null,
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
// CSV Parser — Using PapaParse for robust field handling
// ══════════════════════════════════════════════════════════════

/** Case-insensitive header mapping with common aliases */
const CSV_HEADER_ALIASES: Record<string, string[]> = {
  title: ["title", "article_title", "paper_title", "document_title"],
  authors: ["authors", "author", "author(s)", "creator"],
  year: ["year", "publication_year", "pub_year", "date", "publication_date"],
  journal: ["journal", "journal_title", "source", "publication", "journal/book"],
  pmid: ["pmid", "pubmed_id", "pubmed id", "an"],
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

    const pmid = getVal(row, "pmid") || null;
    const doi = getVal(row, "doi") || null;
    const urlVal = getVal(row, "url");
    const pubmed_url = urlVal && urlVal.includes("pubmed")
      ? urlVal
      : (pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : (urlVal || null));

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
      pubmed_url: pubmed_url || null,
      journal_url: null,
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
    case "enw":
    case "nbib":
      return parseRIS(content);
    case "csv":
    case "tsv":
      return parseCSV(content);
    default:
      return { papers: [], warnings: [`Unsupported file format: .${ext}. Supported: .bib, .ris, .csv`] };
  }
}
