/**
 * The one PNG header reader in this repository.
 *
 * Two separate contracts need to know how big a PNG really is: the brand pack
 * (`brand-assets.mjs`, "is `paperlume-48.png` actually 48 square with an alpha
 * channel?") and the Chrome Web Store package (`extension-package.mjs`, "does
 * the file the manifest calls `icons/icon-48.png` actually contain a 48×48
 * image?"). Those are different questions about different artefacts, but they
 * are answered by reading the same 26 bytes, and two copies of a byte-offset
 * parser is exactly the kind of duplication that develops a discrepancy nobody
 * notices — because both copies keep returning *a* number.
 *
 * Header-only on purpose: the pixel data is filtered and would need inflating
 * and un-filtering to read, which is a decoder, not an assertion. What the
 * pixels look like is verified by decoding the image in a real browser — see
 * `scripts/export-store-assets.mjs`, which does exactly that and refuses to
 * write an asset whose alpha or bounding box is wrong.
 */

/** The eight bytes every PNG begins with. */
const PNG_SIGNATURE = "89504e470d0a1a0a";

/**
 * PNG colour types that carry per-pixel alpha.
 *
 * 4 is greyscale + alpha, 6 is RGBA. Anything else has no alpha channel, which
 * means a transparent background was flattened onto something at export time —
 * invisible in a diff, and visible on every surface that does not happen to be
 * that colour.
 */
export const ALPHA_COLOR_TYPES = [4, 6];

/**
 * Read a PNG's dimensions and colour type from its IHDR chunk.
 *
 * @param {Uint8Array} bytes The file's contents.
 * @returns {{width: number, height: number, bitDepth: number, colorType: number} | null}
 *   `null` when the bytes are not a PNG at all.
 */
export function readPngHeader(bytes) {
  if (bytes.byteLength < 26) return null;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}
