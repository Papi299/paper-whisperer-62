// The client decoder that Production served before PR #377: `src/lib/decodeHTMLEntities.ts`
// at main 4c454769 (git blob d2d9b39e9f7b6da6baa262853931afdc344bf9db), copied
// byte for byte below this header. A browser tab opened before the Vercel
// release of PR #377 keeps running it, against whichever Edge Function is
// deployed, for as long as the tab stays open (CODEQL-EDGE-TEXT-EXTRACTION-001B).
//
// Test fixture only: nothing in the application imports it. It is kept so the
// stale-client state is tested against the decoder that actually runs there,
// not against a description of it. Do not edit the copy; if it ever has to
// change, it no longer describes that decoder.
// ---- verbatim copy follows ----
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
