import { BookOpen, FileSpreadsheet, FileText, type LucideIcon } from "lucide-react";
import type { ExportFormat } from "@/hooks/useExportPapers";

/**
 * The export choices offered to the user, in display order.
 *
 * Desktop renders them as dropdown items and mobile renders them as direct
 * buttons inside the Library actions sheet; both read this one list so a format
 * can never appear in one presentation and not the other. Only the labels and
 * icons live here — the dataset and the format generation belong to
 * `useExportPapers` and are untouched by presentation.
 */
export interface ExportFormatOption {
  format: ExportFormat;
  label: string;
  Icon: LucideIcon;
}

export const EXPORT_FORMAT_OPTIONS: ExportFormatOption[] = [
  { format: "csv", label: "Export as CSV", Icon: FileSpreadsheet },
  { format: "ris", label: "Export as RIS", Icon: FileText },
  { format: "bibtex", label: "Export as BibTeX", Icon: BookOpen },
];
