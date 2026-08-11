import { buildAccountExportManifest } from "./buildAccountExportManifest";
import {
  ATTACHMENT_DOWNLOAD_CONCURRENCY,
  downloadAttachmentsBounded,
  type AttachmentDownloader,
} from "./fetchAttachmentBinaries";
import { isSafeArchivePath } from "./sanitizeArchiveFilename";
import {
  ACCOUNT_EXPORT_CATEGORIES,
  ACCOUNT_EXPORT_COLLECTIONS,
  AccountExportError,
  MANIFEST_PATH,
  categoryArchivePath,
  type AccountExportData,
  type AccountExportManifest,
  type AccountExportProgressHandler,
} from "./types";

/**
 * ZIP construction for the account export.
 *
 * **Library.** `fflate` — MIT, no transitive dependencies, and the only small
 * browser ZIP library offering a genuinely *incremental* archive API. It is
 * imported dynamically (see `loadZipModule`) so it lands in its own lazy chunk
 * rather than the initial bundle: account export is a rare Settings action and
 * must not cost every page load.
 *
 * **Memory.** Source binaries are never all resident. Attachments are fetched
 * through a fixed concurrency window, and each one is pushed into the ZIP
 * stream and released before the window advances, so peak source-side residency
 * is the concurrency bound rather than the account's total attachment size.
 * The compressed *output* does accumulate — a browser download ultimately needs
 * a single Blob — but the archive holds one framed copy of each file, not a
 * second full-size copy of every source.
 *
 * **Ordering.** Category JSON is written first (it is small and lets a reader
 * make sense of a truncated archive), attachments next, and `manifest.json`
 * last, so the manifest can report the counts and byte totals that were
 * actually archived rather than the ones that were predicted.
 */

/** Uncompressed JSON is deflated; binaries are stored (already compressed). */
const JSON_DEFLATE_LEVEL = 6;

type ZipModule = typeof import("fflate");

/**
 * Dynamic import kept behind a function so tests can assert it is not part of
 * the module's static import graph, and so bundlers emit a separate chunk.
 */
async function loadZipModule(): Promise<ZipModule> {
  return import("fflate");
}

export interface BuildAccountExportArchiveOptions {
  data: AccountExportData;
  userId: string;
  generatedAt: Date;
  /** Injected so the archive builder never touches Supabase directly. */
  downloadAttachment: AttachmentDownloader;
  onProgress?: AccountExportProgressHandler;
  concurrency?: number;
}

export interface AccountExportArchive {
  blob: Blob;
  manifest: AccountExportManifest;
}

const encoder = new TextEncoder();

/** UTF-8 JSON, pretty-printed so the archive is human-inspectable. */
function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Build the complete account-export ZIP.
 *
 * Complete-or-fail: any failure — a category that cannot be written, an
 * attachment binary that cannot be downloaded, a count that does not reconcile
 * — rejects. The caller therefore never receives a partial archive to hand to
 * the user.
 */
export async function buildAccountExportArchive(
  options: BuildAccountExportArchiveOptions,
): Promise<AccountExportArchive> {
  const { data, userId, generatedAt, downloadAttachment, onProgress } = options;

  let zipModule: ZipModule;
  try {
    zipModule = await loadZipModule();
  } catch (error) {
    throw new AccountExportError("archiving", "Could not create your export archive.", {
      cause: error,
    });
  }

  const { Zip, ZipDeflate, ZipPassThrough } = zipModule;

  const chunks: Uint8Array[] = [];
  let streamError: unknown = null;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const zip = new Zip((err, chunk, final) => {
    if (err) {
      // Record the first stream error; the awaiting writer surfaces it.
      streamError ??= err;
      resolveDone();
      return;
    }
    if (chunk && chunk.length > 0) {
      // Copy before retaining. fflate emits some output as a `subarray` view
      // into an internal buffer it may reuse for later chunks, so keeping the
      // view would risk the archive mutating underneath us. The copy is
      // per-chunk (kilobytes), replaces the view immediately, and never
      // doubles the archive.
      chunks.push(new Uint8Array(chunk));
    }
    if (final) resolveDone();
  });

  /** Write one complete file into the archive, then release its source bytes. */
  const writeFile = (path: string, bytes: Uint8Array, compress: boolean): void => {
    if (!isSafeArchivePath(path)) {
      throw new AccountExportError("archiving", "Could not create your export archive.", {
        cause: new Error(`Refused an unsafe archive path: ${path}`),
      });
    }
    const entry = compress
      ? new ZipDeflate(path, { level: JSON_DEFLATE_LEVEL })
      : new ZipPassThrough(path);
    zip.add(entry);
    entry.push(bytes, true);
    if (streamError) throw streamError;
  };

  const writtenPaths: string[] = [];
  let archivedCount = 0;
  let archivedBytes = 0;

  try {
    onProgress?.({ stage: "collecting" });

    // 1. Every category file, always present — an empty collection is written
    //    as `[]` and a missing profile as `null`, so a reader never has to
    //    distinguish "absent because empty" from "absent because dropped".
    for (const key of ACCOUNT_EXPORT_CATEGORIES) {
      const path = categoryArchivePath(key);
      writeFile(path, encodeJson(data[key]), true);
      writtenPaths.push(path);
    }

    // 2. Attachment binaries, bounded and streamed.
    const attachments = data.paper_attachments;
    const total = attachments.length;
    if (total > 0) {
      onProgress?.({ stage: "attachments", current: 0, total });
      for await (const { attachment, bytes } of downloadAttachmentsBounded(
        attachments,
        downloadAttachment,
        options.concurrency ?? ATTACHMENT_DOWNLOAD_CONCURRENCY,
      )) {
        writeFile(attachment.archive_path, bytes, false);
        writtenPaths.push(attachment.archive_path);
        archivedCount += 1;
        archivedBytes += bytes.length;
        onProgress?.({ stage: "attachments", current: archivedCount, total });
      }
    }

    // 3. Reconcile before claiming success. Metadata declaring N binaries and
    //    an archive holding N-1 is a failed export, not a successful one.
    if (archivedCount !== total) {
      throw new AccountExportError("attachments", "Could not download one of your attachments.", {
        cause: new Error(`Archived ${archivedCount} of ${total} attachment binaries`),
      });
    }

    onProgress?.({ stage: "archiving" });

    // 4. Manifest last, reporting what was actually archived.
    const manifest = buildAccountExportManifest(data, {
      userId,
      generatedAt,
      archivedAttachments: { count: archivedCount, totalBytes: archivedBytes },
    });
    writeFile(MANIFEST_PATH, encodeJson(manifest), true);
    writtenPaths.push(MANIFEST_PATH);

    zip.end();
    await done;
    if (streamError) throw streamError;

    assertArchiveIsComplete(writtenPaths, data);

    return { blob: new Blob(chunks as BlobPart[], { type: "application/zip" }), manifest };
  } catch (error) {
    // Terminate the stream so the encoder releases its buffers even on the
    // failure path, and never return a partial archive.
    try {
      zip.terminate();
    } catch {
      // Already ended or never started — nothing to release.
    }
    chunks.length = 0;
    if (error instanceof AccountExportError) throw error;
    throw new AccountExportError("archiving", "Could not create your export archive.", {
      cause: error,
    });
  }
}

/**
 * Last line of defence against a silently incomplete archive: every registry
 * category file and every declared attachment path must have been written.
 */
function assertArchiveIsComplete(writtenPaths: readonly string[], data: AccountExportData): void {
  const written = new Set(writtenPaths);

  const missingCategories = ACCOUNT_EXPORT_CATEGORIES.map(categoryArchivePath).filter(
    (path) => !written.has(path),
  );
  if (missingCategories.length > 0 || !written.has(MANIFEST_PATH)) {
    throw new AccountExportError("archiving", "Could not create your export archive.", {
      cause: new Error(
        `Archive is missing required files: ${[...missingCategories, written.has(MANIFEST_PATH) ? "" : MANIFEST_PATH]
          .filter(Boolean)
          .join(", ")}`,
      ),
    });
  }

  const missingAttachments = data.paper_attachments.filter(
    (attachment) => !written.has(attachment.archive_path),
  );
  if (missingAttachments.length > 0) {
    throw new AccountExportError("attachments", "Could not download one of your attachments.", {
      cause: new Error(`Archive is missing ${missingAttachments.length} attachment binaries`),
    });
  }
}

/** Exposed for tests: the collection keys the archive must always contain. */
export const ARCHIVE_COLLECTION_KEYS = ACCOUNT_EXPORT_COLLECTIONS;
