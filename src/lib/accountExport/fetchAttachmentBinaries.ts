import { supabase } from "@/integrations/supabase/client";
import { isOwnedStoragePath } from "./fetchAccountExportData";
import {
  ACCOUNT_EXPORT_FORMAT,
  ATTACHMENTS_BUCKET,
  AccountExportError,
  type ExportedAttachment,
} from "./types";

/**
 * Attachment binary retrieval for the account export.
 *
 * The `attachments` bucket is **private**. Its `attachments_owner_read` policy
 * grants SELECT only when `auth.uid()` matches the first path segment, so an
 * ordinary authenticated `download()` already returns nothing but the caller's
 * own objects. Nothing here weakens that: no public URL is invented, the
 * bucket stays private, and no Storage policy is touched.
 *
 * Client-side validation runs anyway, because the export decides *which* paths
 * to request. Every path is re-checked against the signed-in user's namespace
 * before the request is made, so a metadata row that somehow named another
 * user's object fails closed instead of producing a request at all.
 */

/** Downloads one attachment's bytes. Injected so the archive builder stays pure. */
export type AttachmentDownloader = (attachment: ExportedAttachment) => Promise<Uint8Array>;

/**
 * Maximum attachment downloads in flight at once.
 *
 * Deliberately small and fixed. An account may hold hundreds of attachments at
 * up to 20 MB each, so an unbounded `Promise.all` over all of them would try to
 * hold the entire account's binary data in memory simultaneously. Three keeps
 * the network busy while capping resident source data at roughly three files.
 */
export const ATTACHMENT_DOWNLOAD_CONCURRENCY = 3;

function downloadFailure(cause: unknown): AccountExportError {
  return new AccountExportError(
    "attachments",
    "Could not download one of your attachments.",
    { cause },
  );
}

/** Build a downloader bound to the signed-in user. */
export function createAttachmentDownloader(userId: string): AttachmentDownloader {
  return async (attachment: ExportedAttachment): Promise<Uint8Array> => {
    if (attachment.user_id !== userId || !isOwnedStoragePath(attachment.file_path, userId)) {
      // Fail closed: never issue a Storage request for a path that is not
      // structurally inside this user's namespace.
      throw downloadFailure(
        new Error(`${ACCOUNT_EXPORT_FORMAT}: refused an attachment outside the account namespace`),
      );
    }

    const { data, error } = await supabase.storage
      .from(ATTACHMENTS_BUCKET)
      .download(attachment.file_path);

    if (error) throw downloadFailure(error);
    if (!data) throw downloadFailure(new Error("Storage returned no data for an attachment"));

    const buffer = await data.arrayBuffer();
    return new Uint8Array(buffer);
  };
}

/**
 * Download attachments with a fixed concurrency bound, yielding results **in
 * input order**.
 *
 * The window only advances when a result is consumed, so at most `concurrency`
 * downloads are ever in flight and at most `concurrency` binaries are ever
 * resident. Because the consumer writes each result into the archive and drops
 * its reference before the next slot starts, the source-side memory ceiling is
 * the concurrency bound, not the account size.
 *
 * Every started download is settled into a result object, so a failure at
 * position *n* never leaves an unhandled rejection behind for the downloads
 * already in flight behind it.
 */
export async function* downloadAttachmentsBounded(
  attachments: readonly ExportedAttachment[],
  download: AttachmentDownloader,
  concurrency: number = ATTACHMENT_DOWNLOAD_CONCURRENCY,
): AsyncGenerator<{ attachment: ExportedAttachment; bytes: Uint8Array }> {
  const limit = Math.max(1, Math.floor(concurrency));

  type Settled = { ok: true; bytes: Uint8Array } | { ok: false; error: unknown };
  const start = (attachment: ExportedAttachment): Promise<Settled> =>
    download(attachment).then(
      (bytes) => ({ ok: true, bytes }) as Settled,
      (error: unknown) => ({ ok: false, error }) as Settled,
    );

  const inFlight: Promise<Settled>[] = [];
  let nextIndex = 0;
  let yieldedIndex = 0;

  while (nextIndex < attachments.length && inFlight.length < limit) {
    inFlight.push(start(attachments[nextIndex++]));
  }

  while (inFlight.length > 0) {
    const settled = await inFlight.shift()!;
    const attachment = attachments[yieldedIndex++];

    if (!settled.ok) {
      // Drain the remaining in-flight promises so nothing rejects unobserved,
      // then abort the whole export.
      await Promise.allSettled(inFlight);
      throw settled.error instanceof AccountExportError
        ? settled.error
        : downloadFailure(settled.error);
    }

    if (nextIndex < attachments.length) {
      inFlight.push(start(attachments[nextIndex++]));
    }

    yield { attachment, bytes: settled.bytes };
  }
}
