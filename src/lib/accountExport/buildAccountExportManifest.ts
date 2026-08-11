import {
  ACCOUNT_EXPORT_CATEGORIES,
  ACCOUNT_EXPORT_COLLECTIONS,
  ACCOUNT_EXPORT_FORMAT,
  ACCOUNT_EXPORT_VERSION,
  categoryArchivePath,
  type AccountExportCategoryKey,
  type AccountExportData,
  type AccountExportManifest,
} from "./types";

/**
 * Build `manifest.json`.
 *
 * The manifest is what makes the archive verifiable rather than merely
 * plausible: a reader can determine the format and version, when it was
 * produced, which account it belongs to, which categories are present, how
 * many rows each should hold, and how many attachment binaries totalling how
 * many bytes should be present. Anything missing from the archive is therefore
 * detectable by the recipient, not only by us.
 *
 * It carries **no credential of any kind** — no token, no key, no session, no
 * email. `user_id` is an opaque account identifier and is the only identity
 * field.
 *
 * Attachment figures are the **actually archived** ones, passed in by the
 * archive builder after the binaries are written, so the manifest can never
 * describe an archive that was not produced.
 */
export function buildAccountExportManifest(
  data: AccountExportData,
  options: {
    userId: string;
    generatedAt: Date;
    archivedAttachments: { count: number; totalBytes: number };
  },
): AccountExportManifest {
  const categories = {} as AccountExportManifest["categories"];

  for (const key of ACCOUNT_EXPORT_CATEGORIES) {
    categories[key] = {
      count: categoryCount(data, key),
      path: categoryArchivePath(key),
    };
  }

  return {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    generated_at: options.generatedAt.toISOString(),
    user_id: options.userId,
    categories,
    attachments: {
      count: options.archivedAttachments.count,
      total_bytes: options.archivedAttachments.totalBytes,
    },
  };
}

/**
 * Row count for a category. Collections count their rows; the `profile`
 * singleton counts 1 when present and 0 when the account has no profile row.
 */
function categoryCount(data: AccountExportData, key: AccountExportCategoryKey): number {
  if (isCollectionKey(key)) return data[key].length;
  return data[key] === null ? 0 : 1;
}

function isCollectionKey(
  key: AccountExportCategoryKey,
): key is (typeof ACCOUNT_EXPORT_COLLECTIONS)[number] {
  return (ACCOUNT_EXPORT_COLLECTIONS as readonly string[]).includes(key);
}
