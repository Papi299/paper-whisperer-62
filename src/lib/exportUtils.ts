import { PaperWithTags } from "@/types/database";
import { canonicalPubMedUrl, normalizePmid } from "./pubmedIdentifiers";

/**
 * The external URL to publish for a paper, in descending order of authority.
 *
 * A valid PMID generates the canonical PubMed record link rather than reusing
 * whatever is stored in `pubmed_url`. The importers now recover a PMID only
 * from a structurally authenticated PubMed record URL — never from a generic
 * accession field — so this link is what makes an exported record round-trip
 * with its PMID intact. It also means a stored link that predates that rule
 * cannot carry a wrong or non-PubMed URL back out of the application.
 *
 * With no valid PMID nothing is fabricated: the stored link is used if there is
 * one, otherwise the DOI resolver, otherwise no URL at all.
 */
function exportUrlFor(paper: PaperWithTags): string {
  const pmid = normalizePmid(paper.pmid);
  if (pmid) return canonicalPubMedUrl(pmid);
  return paper.pubmed_url || (paper.doi ? `https://doi.org/${paper.doi}` : "");
}

// ── CSV ──

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
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
    p.year?.toString() || "",
    p.journal || "",
    p.pmid || "",
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
    ...rows.map((row) => row.map(escapeCSV).join(",")),
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
    // is no longer how a Paperlume RIS file conveys a PMID — `UR` below is.
    if (p.pmid) lines.push(`AN  - ${p.pmid}`);
    if (p.doi) lines.push(`DO  - ${p.doi}`);

    // URLs
    const url = exportUrlFor(p);
    if (url) lines.push(`UR  - ${url}`);
    if (p.journal_url) lines.push(`L2  - ${p.journal_url}`);
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

/** Escape BibTeX special characters. */
function escapeBibTeX(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
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
 * Appends a/b/c/... for duplicates.
 */
function generateCiteKey(
  paper: PaperWithTags,
  usedKeys: Set<string>,
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

  // Year part
  const yearPart = paper.year?.toString() || "nd";

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

  // Fallback: append random digits
  const fallback = `${baseKey}_${Date.now()}`;
  usedKeys.add(fallback);
  return fallback;
}

export function exportToBibTeX(papers: PaperWithTags[]): void {
  const usedKeys = new Set<string>();

  const entries = papers.map((p) => {
    const key = generateCiteKey(p, usedKeys);
    const fields: string[] = [];

    // Title — wrap in double braces to preserve capitalisation
    fields.push(`  title     = {{${escapeBibTeX(p.title)}}}`);

    // Authors
    if (p.authors.length > 0) {
      const bibtexAuthors = p.authors.map(toBibTeXAuthor).join(" and ");
      fields.push(`  author    = {${escapeBibTeX(bibtexAuthors)}}`);
    }

    // Year
    if (p.year) {
      fields.push(`  year      = {${p.year}}`);
    }

    // Journal
    if (p.journal) {
      fields.push(`  journal   = {${escapeBibTeX(p.journal)}}`);
    }

    // DOI
    if (p.doi) {
      fields.push(`  doi       = {${p.doi}}`);
    }

    // PMID (custom field, widely supported by BibTeX managers)
    if (p.pmid) {
      fields.push(`  pmid      = {${p.pmid}}`);
    }

    // URL
    const url = exportUrlFor(p);
    if (url) {
      fields.push(`  url       = {${url}}`);
    }

    // Abstract
    if (p.abstract) {
      fields.push(`  abstract  = {${escapeBibTeX(p.abstract)}}`);
    }

    // Keywords — merge keywords, mesh_terms, substances
    const allKeywords = [
      ...p.keywords,
      ...(p.mesh_terms || []),
      ...(p.substances || []),
    ];
    if (allKeywords.length > 0) {
      fields.push(`  keywords  = {${escapeBibTeX(allKeywords.join(", "))}}`);
    }

    // Note — study type
    if (p.study_type) {
      fields.push(`  note      = {Study type: ${escapeBibTeX(p.study_type)}}`);
    }

    return `@article{${key},\n${fields.join(",\n")}\n}`;
  });

  const bibtex = entries.join("\n\n");
  downloadFile(bibtex, "citations.bib", "application/x-bibtex;charset=utf-8;");
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
