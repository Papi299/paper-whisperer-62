import type { AccountExportProgress } from "./types";

/**
 * Archive filename and the browser download trigger.
 *
 * The filename is deterministic and product-prefixed, uses a UTC timestamp
 * (so it is stable under a mocked clock in tests and unambiguous across time
 * zones), and contains only characters that are valid on Windows, macOS and
 * Linux. It carries **no** email address or other personal identifier — the
 * file often ends up in a shared Downloads folder.
 */

/** e.g. `paperlume-account-export-2026-08-10T20-30-00Z.zip` */
export function accountExportFileName(generatedAt: Date): string {
  // `toISOString()` is always UTC: 2026-08-10T20:30:00.000Z. Drop the
  // milliseconds and replace the colons, which are invalid in Windows paths.
  const stamp = generatedAt.toISOString().slice(0, 19).replace(/:/g, "-");
  return `paperlume-account-export-${stamp}Z.zip`;
}

/** Trigger a single local download of the archive. No upload, no email. */
export function triggerArchiveDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Bounded, user-facing progress text. Every stage reports concrete progress
 * rather than an indefinite spinner, and the attachment stage names both the
 * current position and the known total.
 */
export function accountExportStatusText(progress: AccountExportProgress | null): string {
  if (!progress) return "Preparing account data…";
  switch (progress.stage) {
    case "collecting":
      return "Preparing account data…";
    case "attachments": {
      const current = Math.min((progress.current ?? 0) + 1, progress.total ?? 0);
      return `Downloading attachments ${current} of ${progress.total ?? 0}…`;
    }
    case "archiving":
      return "Creating archive…";
  }
}
