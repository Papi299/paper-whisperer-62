/**
 * HTML entity decoding for provider payloads inside the Edge Function.
 *
 * Moved verbatim out of `fetch-paper-metadata/index.ts` when a second module
 * (`pubmedAuthors.ts`) needed the same decoding: two copies of a decoder is how
 * two subtly different decoders start. The body is unchanged, so every existing
 * caller decodes exactly what it decoded before.
 *
 * Regex-based because the Deno edge runtime provides no DOMParser.
 */
export function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10))
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
