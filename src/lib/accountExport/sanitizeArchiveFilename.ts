import { ATTACHMENTS_DIR } from "./types";

/**
 * Filename / archive-path safety for the account export.
 *
 * An attachment's `file_name` is arbitrary user-supplied text that was never
 * constrained to be a safe path component. It may contain `/`, `\`, `..`,
 * control characters, leading dots, Windows-reserved device names, or simply
 * be identical to another attachment's name. A ZIP entry path is interpreted
 * by whatever extracts it, and a naive path is the classic "zip slip"
 * traversal: an entry named `../../secret.txt` can be written outside the
 * extraction directory.
 *
 * So the original `file_name` is **never** used as an archive path. It stays
 * intact in `data/paper_attachments.json` as the user's real filename; the
 * archive path is derived here, and is a single sanitized segment prefixed by
 * immutable database IDs.
 */

/** Maximum length of the sanitized name segment (before the ID prefix). */
const MAX_NAME_LENGTH = 100;

/** Used when sanitization leaves nothing usable. */
const FALLBACK_NAME = "attachment";

/**
 * Characters that are illegal or path-significant on common filesystems.
 * `/` and `\` are handled earlier by segment splitting, so they are not here.
 */
const ILLEGAL_CHARACTERS = new Set(["<", ">", ":", '"', "|", "?", "*"]);

/**
 * Windows reserved device names. A file called `CON.pdf` is unwritable on
 * Windows, so the whole extraction fails rather than just that one entry.
 */
const RESERVED_BASENAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** C0 controls, DEL, and C1 controls — never meaningful in a filename. */
function isControlCodePoint(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** True when any code point in `value` is a control character. */
export function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isControlCodePoint(code)) return true;
  }
  return false;
}

/** Drop control characters; replace filesystem-illegal characters with `_`. */
function stripUnsafeCharacters(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isControlCodePoint(code)) continue;
    out += ILLEGAL_CHARACTERS.has(ch) ? "_" : ch;
  }
  return out;
}

/**
 * Reduce an arbitrary original filename to one safe archive path **segment**.
 *
 * Guarantees about the returned value: it is non-empty; contains no `/`, `\`,
 * control character, or `:`; it is not `.` or `..`; it does not start with a
 * dot; it does not end with a dot or space; its base name is not a Windows
 * reserved device name; and it is at most `MAX_NAME_LENGTH` characters.
 *
 * It is deliberately **not** collision-free — two different originals can
 * sanitize to the same text. Uniqueness comes from the attachment ID prefix
 * applied by `attachmentArchivePath`.
 */
export function sanitizeArchiveFilename(originalName: string | null | undefined): string {
  let name = typeof originalName === "string" ? originalName : "";

  // Strip any directory structure the name pretends to carry — both POSIX and
  // Windows separators — by keeping only the last component. Doing this before
  // character replacement means `foo/bar.pdf` becomes `bar.pdf` rather than
  // `foo_bar.pdf`, which is the name the user actually sees.
  const segments = name.split(/[/\\]/);
  name = segments[segments.length - 1] ?? "";

  name = stripUnsafeCharacters(name);

  // A name that is only dots (".", "..", "...") carries no information and is
  // exactly the traversal token we must never emit.
  if (/^\.+$/.test(name)) name = "";

  // Leading dots would produce a hidden file; trailing dots/spaces are dropped
  // silently by Windows, which would desynchronize the path recorded in the
  // manifest from the one actually extracted.
  name = name.replace(/^\.+/, "");
  name = name.replace(/[. ]+$/, "");

  name = name.trim();

  if (name === "") return FALLBACK_NAME;

  // The reserved-device-name check applies to the base name, extension aside.
  const dotIndex = name.lastIndexOf(".");
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  if (RESERVED_BASENAMES.has(base.toLowerCase())) {
    name = `_${name}`;
  }

  if (name.length > MAX_NAME_LENGTH) {
    // Truncate the stem but keep the extension, so the extracted file still
    // opens with the right application.
    const extIndex = name.lastIndexOf(".");
    const ext = extIndex > 0 ? name.slice(extIndex) : "";
    const stemBudget = Math.max(1, MAX_NAME_LENGTH - ext.length);
    name = (name.slice(0, stemBudget) + ext).slice(0, MAX_NAME_LENGTH);
    // Truncation can expose a new trailing dot or space.
    name = name.replace(/[. ]+$/, "");
    if (name === "") return FALLBACK_NAME;
  }

  return name;
}

/**
 * The archive path for one attachment binary:
 *
 *   `attachments/<paper-id>/<attachment-id>-<sanitized-original-name>`
 *
 * Both IDs are immutable database UUIDs, so the path is unique per attachment
 * even when two attachments on the same paper share an original filename. The
 * IDs are sanitized too — they are trusted values today, but this builder does
 * not depend on that staying true.
 */
export function attachmentArchivePath(attachment: {
  id: string;
  paper_id: string;
  file_name: string | null;
}): string {
  const paperSegment = sanitizeArchiveFilename(attachment.paper_id);
  const idSegment = sanitizeArchiveFilename(attachment.id);
  const nameSegment = sanitizeArchiveFilename(attachment.file_name);
  return `${ATTACHMENTS_DIR}/${paperSegment}/${idSegment}-${nameSegment}`;
}

/**
 * Final structural check on any path written into the archive.
 *
 * Belt-and-braces: nothing should be able to produce an unsafe path after the
 * sanitizer, so a failure here means a bug upstream and must abort the export
 * rather than emit a traversal-capable entry.
 */
export function isSafeArchivePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("\\")) return false;
  // Windows drive-letter and alternate-data-stream forms.
  if (path.includes(":")) return false;
  if (hasControlCharacter(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
