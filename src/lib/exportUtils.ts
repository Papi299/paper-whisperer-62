import { PaperWithTags } from "@/types/database";
import { encodeBibTeXText, writeIdentifierField, type IdentifierField } from "./bibtexCodec";
import { canonicalDoiUrl } from "./doiIdentifiers";
import {
  canonicalPubMedUrl,
  extractPmidFromPubMedUrl,
  normalizePmid,
  toImportableExternalUrl,
} from "./pubmedIdentifiers";

/**
 * The external URL to publish for a paper, in descending order of authority.
 *
 * Nothing here trusts a stored value because of the column it sits in. Rows
 * written before import provenance was hardened may hold anything at all in
 * `pubmed_url` — a lookalike host, a non-PubMed link, a `javascript:` string —
 * so `pubmed_url` is re-checked with the same structural recognition the
 * importers use rather than being echoed back out as a PubMed link.
 *
 * The order is:
 *
 *   1. a stored `pmid` that is syntactically a PMID → canonical record URL;
 *   2. a stored `pubmed_url` that structurally *is* a PubMed record URL → the
 *      canonical form of the record it names, not the stored representation;
 *   3. the DOI resolver, as the canonical percent-encoded resolver URL — the
 *      stored DOI is a DOI *name*, and interpolating one into a URL path
 *      truncates any suffix containing `#` or `?`. A stored value that cannot
 *      form a resolver URL at all (no prefix/suffix separator) falls through to
 *      step 4 rather than exporting a link the proxy cannot answer;
 *   4. a stored `journal_url` that is a usable http(s) link — the corrected
 *      importers deliberately route generic source links here, so dropping it
 *      would lose the only link some records have;
 *   5. no URL.
 *
 * A PMID at step 1 or 2 is what makes an exported record round-trip with its
 * identifier intact, since the importers recover a PMID only from an
 * authenticated PubMed record URL and never from a generic accession field.
 * Nothing is fabricated when no step applies.
 *
 * This is not historical-data repair. A stored `pmid` that is syntactically
 * valid stays authoritative, and a row whose numeric `pmid` was fabricated by
 * the old RIS `AN` rule carries no evidence that would let the exporter tell.
 */
function exportUrlFor(paper: PaperWithTags): string {
  const pmid = normalizePmid(paper.pmid) ?? extractPmidFromPubMedUrl(paper.pubmed_url);
  if (pmid) return canonicalPubMedUrl(pmid);

  const doiUrl = canonicalDoiUrl(paper.doi);
  if (doiUrl) return doiUrl;

  return toImportableExternalUrl(paper.journal_url) ?? "";
}

/**
 * The value to write into a field whose *semantics assert* that it is a PMID —
 * the CSV `PMID` column, the BibTeX `pmid` field, the RIS compatibility `AN`.
 *
 * The same syntax rule that decides whether a stored `pmid` may generate a
 * PubMed URL decides whether it may be published as a PMID at all. Emitting a
 * value that failed that check would tell an external tool — one with no reason
 * to re-validate — that an Embase or Web of Science accession is a PMID.
 *
 * Only provably invalid values are dropped. A digit-only historical value stays
 * authoritative: if the old RIS `AN` rule fabricated it from a numeric
 * accession, nothing in the row distinguishes it from a genuine PMID, and
 * export is not the place to guess.
 */
function exportPmidFor(paper: PaperWithTags): string | null {
  return normalizePmid(paper.pmid);
}

// ── CSV ──

/**
 * A value a spreadsheet may read as a formula (CWE-1236): its first character,
 * after any leading whitespace or control characters, is `=`, `+`, `-` or `@`,
 * or the full-width form of one (U+FF1D, U+FF0B, U+FF0D, U+FF20).
 *
 * The leading run is skipped rather than only the first character tested,
 * because a consumer that trims the cell would turn " =1+1" into "=1+1". This
 * app's own CSV importer trims every value.
 */
// eslint-disable-next-line no-control-regex -- C0 controls and DEL belong to the leading run by design
const FORMULA_LEAD = /^[\s\u0000-\u001F\u007F]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/;

/**
 * A field containing any of these is quoted. Besides RFC 4180's comma, quote
 * and line break, that includes a bare CR, at which a spreadsheet ends the
 * row, and `;`, which is the list separator in some spreadsheet locales.
 */
const NEEDS_QUOTES = /[",;\r\n]/;

/**
 * Serializes one text field.
 *
 * A formula-leading value is written quoted, with one TAB added in front of
 * it: `=1+1` becomes `"<TAB>=1+1"`, which a spreadsheet such as Excel reads as
 * text. No character is removed and nothing else is added, so the stored value
 * is untouched and only this file's representation of it changes. This app's
 * CSV importer trims the TAB, so re-importing an export gives the same papers
 * as before. A program reading the file does see the TAB, and no prefix is
 * proven safe in every spreadsheet and locale.
 */
function escapeCSV(value: string): string {
  if (FORMULA_LEAD.test(value)) return `"\t${value.replace(/"/g, '""')}"`;
  if (NEEDS_QUOTES.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Serializes one cell. A safe integer, the Year column's type, is written as
 * its digits, with a minus sign when negative: a spreadsheet reads that as a
 * number, never as a formula. Every other value is serialized as text, so a
 * Year that is not a number at runtime is still neutralized.
 */
function serializeCSVCell(value: string | number | null): string {
  if (Number.isSafeInteger(value)) return String(value);
  return escapeCSV(value == null ? "" : String(value));
}

export function exportToCSV(papers: PaperWithTags[]): void {
  const headers = [
    "Title", "Authors", "Year", "Journal", "PMID", "DOI",
    "Study Types", "Keywords", "MeSH Terms", "Substances",
    "Tags", "Projects", "URL", "Abstract",
  ];

  const rows = papers.map((p) => [
    p.title,
    p.authors.join("; "),
    p.year,
    p.journal || "",
    exportPmidFor(p) ?? "",
    p.doi || "",
    p.study_type || "",
    p.keywords.join("; "),
    (p.mesh_terms || []).join("; "),
    (p.substances || []).join("; "),
    p.tags.map((t) => t.name).join("; "),
    p.projects.map((pr) => pr.name).join("; "),
    exportUrlFor(p),
    p.abstract || "",
  ]);

  const csv = [
    headers.map(escapeCSV).join(","),
    ...rows.map((row) => row.map(serializeCSVCell).join(",")),
  ].join("\n");

  downloadFile(csv, "papers_export.csv", "text/csv;charset=utf-8;");
}

// ── RIS ──

export function exportToRIS(papers: PaperWithTags[]): void {
  const entries = papers.map((p) => {
    const lines: string[] = [];

    // Type & core fields
    lines.push("TY  - JOUR");
    lines.push(`T1  - ${p.title}`);
    p.authors.forEach((a) => lines.push(`AU  - ${a}`));
    if (p.year) lines.push(`PY  - ${p.year}`);
    if (p.journal) lines.push(`JO  - ${p.journal}`);

    // Identifiers. `AN` is retained for reference managers that read it, but it
    // is no longer how a Paperlume RIS file conveys a PMID — `UR` below is —
    // and it is emitted only for a value that is syntactically a PMID. (This
    // says nothing about import: an incoming `AN` is still never trusted.)
    const pmid = exportPmidFor(p);
    if (pmid) lines.push(`AN  - ${pmid}`);
    if (p.doi) lines.push(`DO  - ${p.doi}`);

    // URLs. `L2` is validated for the same reason `UR` is: a stored link is not
    // trusted to be a usable http(s) link merely because it was stored.
    const url = exportUrlFor(p);
    if (url) lines.push(`UR  - ${url}`);
    const journalUrl = toImportableExternalUrl(p.journal_url);
    if (journalUrl) lines.push(`L2  - ${journalUrl}`);
    if (p.drive_url) lines.push(`L1  - ${p.drive_url}`);

    // Abstract
    if (p.abstract) lines.push(`AB  - ${p.abstract}`);

    // Keywords, MeSH terms, substances — all as KW
    p.keywords.forEach((kw) => lines.push(`KW  - ${kw}`));
    (p.mesh_terms || []).forEach((mt) => lines.push(`KW  - ${mt}`));
    (p.substances || []).forEach((s) => lines.push(`KW  - ${s}`));

    // Study type as note
    if (p.study_type) lines.push(`N1  - ${p.study_type}`);

    // User tags and projects in custom fields
    p.tags.forEach((t) => lines.push(`C1  - ${t.name}`));
    p.projects.forEach((pr) => lines.push(`C2  - ${pr.name}`));

    lines.push("ER  - ");
    return lines.join("\n");
  });

  const ris = entries.join("\n\n");
  downloadFile(ris, "citations.ris", "application/x-research-info-systems;charset=utf-8;");
}

// ── BibTeX ──
//
// Field values go through `bibtexCodec.ts`. Text fields (title, author,
// journal, abstract, keywords, note) are LaTeX-encoded. The DOI name and the
// URL are written raw in the standard `doi` and `url` fields, as before. A
// value that cannot be written raw goes to a PaperLume field in their place
// (see `writeIdentifierField`). Every field this exporter writes therefore has
// balanced braces, so no stored value can end its field early or run on into
// the next field or entry.

/**
 * What one `exportToBibTeX` call wrote to its file, for the notice the export
 * shows. Every count is taken from the fields that were written, as
 * `writeIdentifierField` named them, so the summary cannot disagree with the
 * download: an identifier the file does not contain, such as a stored
 * `journal_url` passed over for a PubMed or DOI link, is never counted.
 */
export interface BibTeXExportSummary {
  /** Papers in the file, one entry each. */
  paperCount: number;
  /** Papers with a DOI or URL, or both, in a PaperLume field, each counted once. */
  affectedPaperCount: number;
  /** `paperlume-doi-v1` fields in the file. */
  exceptionalDoiCount: number;
  /** `paperlume-url-v1` fields in the file. */
  exceptionalUrlCount: number;
}

/**
 * A `doi` or `url` line, or the PaperLume field that replaces it for a value
 * the standard field cannot hold, and which of the two it is. Field names are
 * padded as before, so an ordinary record is written byte for byte as it
 * always was.
 */
function bibtexIdentifierLine(
  field: IdentifierField,
  value: string,
): { line: string; inPaperLumeField: boolean } {
  const written = writeIdentifierField(field, value);
  return {
    line: `  ${written.name.padEnd(9)} = {${written.value}}`,
    inPaperLumeField: written.name !== field,
  };
}

/**
 * The text of the `year` field. A number, the column's type, is written as
 * JavaScript prints it, which never includes a BibTeX special character, so a
 * numeric year is written exactly as before. Any other value at runtime is
 * encoded as text, so it cannot leave its field.
 */
function bibtexYear(year: unknown): string {
  return typeof year === "number" ? String(year) : encodeBibTeXText(String(year));
}

/**
 * Parse "First Middle Last" into "Last, First Middle" for BibTeX.
 * Handles single-name authors and hyphenated last names.
 */
function toBibTeXAuthor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return name;
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(" ");
  return `${last}, ${first}`;
}

/**
 * Generate a unique BibTeX citation key.
 * Format: FirstAuthorLastName + Year + first significant title word.
 * Appends a/b/c/... for duplicates, then _1, _2, _3, ... once those are used.
 *
 * `usedKeys` holds every key already in the file, and it alone decides whether
 * a key is free: every candidate is checked against it, whichever paper's key
 * it would repeat. `fallbackStart` only records, per base key, where the search
 * for a numbered key resumes, so a large group does not rescan the numbers it
 * has already used.
 */
function generateCiteKey(
  paper: PaperWithTags,
  usedKeys: Set<string>,
  fallbackStart: Map<string, number>,
): string {
  // Author part
  let authorPart = "Unknown";
  if (paper.authors.length > 0) {
    const firstAuthor = paper.authors[0].trim();
    const parts = firstAuthor.split(/\s+/);
    authorPart = parts[parts.length - 1] || "Unknown";
    // Strip non-alphanumeric characters
    authorPart = authorPart.replace(/[^a-zA-Z]/g, "");
  }

  // Year part. Only a number, the column's type, contributes: the key has no
  // delimiters around it, so any other value at runtime gets the same "nd" as
  // a missing year rather than its characters.
  const yearPart = typeof paper.year === "number" ? String(paper.year) : "nd";

  // Title word
  const stopWords = new Set([
    "a", "an", "the", "of", "in", "on", "at", "to", "for", "and", "or",
    "is", "are", "was", "were", "with", "from", "by", "as", "its", "it",
  ]);
  const titleWords = (paper.title || "untitled")
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const significantWord =
    titleWords.find((w) => !stopWords.has(w.toLowerCase())) ||
    titleWords[0] ||
    "untitled";

  const baseKey = `${authorPart}${yearPart}_${significantWord}`;

  // Ensure uniqueness
  if (!usedKeys.has(baseKey)) {
    usedKeys.add(baseKey);
    return baseKey;
  }

  // Append a, b, c, ...
  const suffixes = "abcdefghijklmnopqrstuvwxyz";
  for (const s of suffixes) {
    const candidate = `${baseKey}${s}`;
    if (!usedKeys.has(candidate)) {
      usedKeys.add(candidate);
      return candidate;
    }
  }

  // Then _1, _2, _3, ...: the lowest number whose key the file does not hold
  // yet. Every number below where the search starts is already in the file.
  // Nothing here reads the clock, so the same papers in the same order get the
  // same keys in every export.
  let n = fallbackStart.get(baseKey) ?? 1;
  while (usedKeys.has(`${baseKey}_${n}`)) n++;
  fallbackStart.set(baseKey, n);
  const fallback = `${baseKey}_${n}`;
  usedKeys.add(fallback);
  return fallback;
}

/**
 * Writes `papers` as one BibTeX file, downloads it, and returns what the file
 * holds (see `BibTeXExportSummary`). The summary is returned only once the
 * download has been handed to the browser, so a caller never announces a file
 * that was not produced.
 */
export function exportToBibTeX(papers: PaperWithTags[]): BibTeXExportSummary {
  const usedKeys = new Set<string>();
  const fallbackStart = new Map<string, number>();
  let affectedPaperCount = 0;
  let exceptionalDoiCount = 0;
  let exceptionalUrlCount = 0;

  const entries = papers.map((p) => {
    const key = generateCiteKey(p, usedKeys, fallbackStart);
    const fields: string[] = [];
    let affected = false;

    // Title — wrap in double braces to preserve capitalisation
    fields.push(`  title     = {{${encodeBibTeXText(p.title)}}}`);

    // Authors. Each name is encoded on its own, so a brace pair never spans
    // two names: BibTeX splits the list only at an " and " outside braces.
    if (p.authors.length > 0) {
      const bibtexAuthors = p.authors
        .map((author) => encodeBibTeXText(toBibTeXAuthor(author)))
        .join(" and ");
      fields.push(`  author    = {${bibtexAuthors}}`);
    }

    // Year
    if (p.year) {
      fields.push(`  year      = {${bibtexYear(p.year)}}`);
    }

    // Journal
    if (p.journal) {
      fields.push(`  journal   = {${encodeBibTeXText(p.journal)}}`);
    }

    // DOI — the DOI name, raw (see `writeIdentifierField`)
    if (p.doi) {
      const doi = bibtexIdentifierLine("doi", p.doi);
      fields.push(doi.line);
      if (doi.inPaperLumeField) {
        exceptionalDoiCount++;
        affected = true;
      }
    }

    // PMID (custom field, widely supported by BibTeX managers)
    const pmid = exportPmidFor(p);
    if (pmid) {
      fields.push(`  pmid      = {${pmid}}`);
    }

    // URL — raw, as `exportUrlFor` produced it (see `writeIdentifierField`).
    // Only this URL is written, so only this URL is counted.
    const url = exportUrlFor(p);
    if (url) {
      const written = bibtexIdentifierLine("url", url);
      fields.push(written.line);
      if (written.inPaperLumeField) {
        exceptionalUrlCount++;
        affected = true;
      }
    }

    // Abstract
    if (p.abstract) {
      fields.push(`  abstract  = {${encodeBibTeXText(p.abstract)}}`);
    }

    // Keywords — merge keywords, mesh_terms, substances. Encoded one keyword at
    // a time, as authors are.
    const allKeywords = [
      ...p.keywords,
      ...(p.mesh_terms || []),
      ...(p.substances || []),
    ];
    if (allKeywords.length > 0) {
      fields.push(`  keywords  = {${allKeywords.map(encodeBibTeXText).join(", ")}}`);
    }

    // Note — study type
    if (p.study_type) {
      fields.push(`  note      = {Study type: ${encodeBibTeXText(p.study_type)}}`);
    }

    if (affected) affectedPaperCount++;
    return `@article{${key},\n${fields.join(",\n")}\n}`;
  });

  const bibtex = entries.join("\n\n");
  downloadFile(bibtex, "citations.bib", "application/x-bibtex;charset=utf-8;");
  return { paperCount: entries.length, affectedPaperCount, exceptionalDoiCount, exceptionalUrlCount };
}

// ── Shared ──

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
