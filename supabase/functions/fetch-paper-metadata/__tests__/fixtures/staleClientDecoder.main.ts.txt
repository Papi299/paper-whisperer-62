/**
 * Decodes HTML entities (numeric and named) using regex.
 * Works in all JS runtimes: main thread, Web Workers, Deno, Node.
 *
 * Handles:
 *  - Hex numeric:   &#x2009; → thin space, &#xb1; → ±
 *  - Decimal numeric: &#177; → ±
 *  - Common named:  &amp; &lt; &gt; &quot; &apos; &nbsp;
 */
export function decodeHTMLEntities(text: string | null | undefined): string | null {
  if (!text) return text as null;
  try {
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
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, "\u00A0");
  } catch {
    return text;
  }
}
