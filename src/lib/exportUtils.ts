import { PaperWithTags } from "@/types/database";

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function exportToCSV(papers: PaperWithTags[]): void {
  const headers = [
    "Title", "Authors", "Year", "Journal", "PMID", "DOI",
    "Study Types", "Keywords", "URL", "Abstract",
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
    p.pubmed_url || (p.doi ? `https://doi.org/${p.doi}` : ""),
    p.abstract || "",
  ]);

  const csv = [
    headers.map(escapeCSV).join(","),
    ...rows.map((row) => row.map(escapeCSV).join(",")),
  ].join("\n");

  downloadFile(csv, "papers_export.csv", "text/csv;charset=utf-8;");
}

export function exportToRIS(papers: PaperWithTags[]): void {
  const entries = papers.map((p) => {
    const lines: string[] = [];
    lines.push("TY  - JOUR");
    lines.push(`T1  - ${p.title}`);
    p.authors.forEach((a) => lines.push(`A1  - ${a}`));
    if (p.year) lines.push(`Y1  - ${p.year}`);
    if (p.journal) lines.push(`JO  - ${p.journal}`);
    const url = p.pubmed_url || (p.doi ? `https://doi.org/${p.doi}` : "");
    if (url) lines.push(`UR  - ${url}`);
    if (p.doi) lines.push(`DO  - ${p.doi}`);
    if (p.study_type) lines.push(`N1  - ${p.study_type}`);
    p.keywords.forEach((kw) => lines.push(`KW  - ${kw}`));
    if (p.abstract) lines.push(`AB  - ${p.abstract}`);
    lines.push("ER  - ");
    return lines.join("\n");
  });

  const ris = entries.join("\n\n");
  downloadFile(ris, "citations.ris", "application/x-research-info-systems;charset=utf-8;");
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
