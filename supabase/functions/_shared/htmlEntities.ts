/**
 * Character and entity references in provider metadata text, decoded once.
 *
 * Shared by every Edge caller that decodes PubMed EFetch text — keywords
 * (`fetch-paper-metadata/index.ts`), author fields (`pubmedAuthors.ts`) and the
 * article DOI (`pubmedArticleIdentifiers.ts`) — so that all of them decode the
 * same way. Regex-based because the Deno edge runtime provides no DOMParser.
 *
 * ## The grammar
 *
 * XML 1.0 (Fifth Edition), §4.1:
 *
 *   CharRef   ::= '&#' [0-9]+ ';' | '&#x' [0-9a-fA-F]+ ';'
 *   EntityRef ::= '&' Name ';'
 *
 * Decoded, the same set as before this change:
 *  - the five predefined entities `&amp;` `&lt;` `&gt;` `&quot;` `&apos;`
 *    (§4.6);
 *  - decimal and hexadecimal character references. The hexadecimal form takes a
 *    lowercase `x`, as XML defines it, so `&#X41;` is not decoded.
 *
 * Everything else stays exactly as written: other entity names (`&nbsp;`,
 * `&alpha;`), incomplete syntax (`&amp`, `&#65`, `&#;`), and character
 * references whose value is not a character (below).
 *
 * ## Each reference once
 *
 * One left-to-right pass over the input: every reference in the input is read
 * once, and what a reference produces is never read again as part of another.
 * So `&amp;lt;` decodes to the text `&lt;`, not to `<`, and `&#38;lt;` and
 * `&#x26;#60;` likewise stay one level encoded. The previous implementation ran
 * seven replacements in sequence, and each re-read the output of the ones
 * before it (CodeQL `js/double-escaping`, alert 8).
 *
 * ## Character references that are not characters
 *
 * A character reference is decoded only when its value is an XML 1.0 `Char`
 * (§2.2, and the "Legal Character" well-formedness constraint of §4.1):
 *
 *   Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 *
 * `String.fromCodePoint` alone does not establish that: it returns NUL, other C0
 * controls, lone surrogates and the noncharacters U+FFFE and U+FFFF, and it
 * throws `RangeError` above U+10FFFF — which, for a reference such as
 * `&#x110000;` or a twenty-digit one, failed the whole PubMed record. A
 * reference to any value outside `Char` is now left as the reference text: it
 * is not decoded, not replaced by U+FFFD or another character, and it never
 * throws. Digits are read one at a time, and reading stops accumulating as soon
 * as the value passes U+10FFFF, so no intermediate value grows with the length
 * of the reference.
 *
 * This decodes references in text. It is not an XML or HTML parser and not a
 * sanitizer: its output is text, which may legitimately hold `<` or `&`.
 */

/** The five entities XML predefines (XML 1.0 §4.6). */
const PREDEFINED_ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/**
 * One reference: a decimal character reference, a hexadecimal one, or one of the
 * predefined entities. A single global pattern, applied by one `replace`, is
 * what makes the decoding non-cascading: `replace` never rescans its own
 * replacements.
 */
const REFERENCE = /&(?:#([0-9]+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;

const MAX_CODE_POINT = 0x10ffff;

/** XML 1.0 [2] `Char`. */
function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= MAX_CODE_POINT)
  );
}

/** The value of one decimal or hexadecimal digit the pattern above admitted. */
function digitValue(code: number): number {
  if (code <= 0x39) return code - 0x30; // 0-9
  if (code >= 0x61) return code - 0x57; // a-f
  return code - 0x37; // A-F
}

/**
 * The code point a reference's digits name, or `null` once it exceeds
 * U+10FFFF. Leading zeros keep the value small, so `&#0000065;` is still `A`.
 */
function codePointOf(digits: string, radix: 10 | 16): number | null {
  let value = 0;
  for (let i = 0; i < digits.length; i++) {
    value = value * radix + digitValue(digits.charCodeAt(i));
    if (value > MAX_CODE_POINT) return null;
  }
  return value;
}

export function decodeHTMLEntities(text: string): string {
  return text.replace(
    REFERENCE,
    (reference: string, decimal?: string, hex?: string, entity?: string): string => {
      if (entity !== undefined) return PREDEFINED_ENTITIES.get(entity) ?? reference;
      const codePoint =
        decimal !== undefined ? codePointOf(decimal, 10) : codePointOf(hex ?? "", 16);
      return codePoint !== null && isXmlChar(codePoint)
        ? String.fromCodePoint(codePoint)
        : reference;
    },
  );
}
