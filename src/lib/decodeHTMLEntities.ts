/**
 * Decodes the character and entity references in metadata text, once.
 *
 * Shared by every client caller that turns provider or user text into stored
 * and displayed text: `normalizePaperData` (title, abstract, keywords, authors,
 * journal, MeSH terms, substances, study and publication types), on the
 * browser main thread and in the normalization Web Worker, and
 * `normalizeAuthorDisplay` (author display, search and grouping keys). One
 * `replace` pass over the input, with no DOM, so it behaves the same in the
 * browser, the Worker, Node and the test runners.
 *
 * ## What is decoded
 *
 * The same set as before this change, with the same spelling rules:
 *  - the named references `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` and `&nbsp;`,
 *    in lowercase only (`&AMP;` is not decoded);
 *  - decimal references (`&#177;`) and hexadecimal references with a
 *    lowercase `x` and digits in either case (`&#xb1;`, `&#xB1;`); `&#XB1;` is
 *    not decoded.
 *
 * Everything else stays exactly as written: other names (`&alpha;`,
 * `&copy;`), incomplete syntax (`&amp`, `&#65`, `&#;`, `&#x;`) and the numeric
 * references described below. Nothing is deleted, and nothing is replaced by
 * U+FFFD or by any other character.
 *
 * ## Each reference once
 *
 * One left-to-right pass: each reference in the input is read once, and the
 * text a reference produces is never read again as part of another one. So
 * `&amp;lt;` decodes to the text `&lt;`, one level, and not to `<`; `&#38;lt;`,
 * `&#x26;#60;` and `&amp;#x3C;` likewise lose exactly one level. The previous
 * implementation ran eight replacements in sequence, each re-reading what the
 * ones before it produced (CodeQL `js/double-escaping`, alert 6).
 *
 * This matters because the Edge Function now returns the PubMed title and
 * abstract, and the Crossref abstract, as XML-escaped character data that the
 * client decodes once: CDATA text such as `Literal &lt;` reaches the client as
 * `Literal &amp;lt;` and must come back as `Literal &lt;`.
 *
 * ## Numeric references
 *
 * A numeric reference is decoded when its value is a Unicode scalar value
 * other than U+0000: U+0001 to U+D7FF, or U+E000 to U+10FFFF. Any other value
 * is left as the reference text, on its own, and the rest of the field is still
 * decoded:
 *  - above U+10FFFF there is no character, and `String.fromCodePoint` throws a
 *    `RangeError`; the previous implementation caught it and returned the whole
 *    field undecoded, so one such reference stopped every other reference in
 *    the field from being decoded;
 *  - U+D800 to U+DFFF are surrogate code points, not characters: decoded alone
 *    they leave a lone surrogate, which is not well-formed text and cannot be
 *    stored;
 *  - U+0000 cannot be stored either: PostgreSQL text holds no NUL character,
 *    and `jsonb`, which carries the import payload, rejects `\u0000`.
 *
 * One surrogate case is kept: a reference to a high surrogate (U+D800 to
 * U+DBFF) immediately followed by a reference to a low surrogate (U+DC00 to
 * U+DFFF) is the UTF-16 spelling of one supplementary character, as software
 * that counts UTF-16 code units writes it (`&#55349;&#56320;` for U+1D400).
 * The pair decodes to that character, which is what the previous
 * implementation produced for it; only a surrogate reference that is not part
 * of such a pair stays as written.
 *
 * Every other value decodes as it always has, including C0 and C1 control
 * characters, noncharacters such as U+FFFE, and astral characters. This client
 * rule is intentionally wider than the Edge decoder's
 * (`supabase/functions/_shared/htmlEntities.ts`), which accepts only XML 1.0
 * `Char` values because it reads XML: client input also comes from RIS,
 * BibTeX, NBIB, CSV and EndNote files and from manual entry, where XML's
 * restrictions do not apply.
 *
 * Digits are read one at a time, and reading stops as soon as the value passes
 * U+10FFFF, so no intermediate value grows with the length of a reference.
 *
 * This decodes references in text. It is not an HTML parser and not a
 * sanitizer: its output is text, which may legitimately contain `<` or `&`.
 *
 * `null`, `undefined` and `""` are returned as given.
 */

/** The named references this decoder has always supported, and only these. */
const NAMED_REFERENCES = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", String.fromCharCode(0xa0)],
]);

/**
 * One reference: hexadecimal, decimal, or one of the named references above.
 * A single global pattern applied by one `replace` is what makes the decoding
 * non-cascading, because `replace` never rescans its own replacement text. The
 * alternatives cannot overlap, so a match never backtracks past the digits or
 * name that follow its `&`.
 */
const REFERENCE = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos|nbsp));/g;

/**
 * A numeric reference starting exactly at `lastIndex`, used only to read the
 * reference that follows a high surrogate. Sticky, so it never scans ahead.
 */
const NUMERIC_REFERENCE_AT = /&#(?:x([0-9a-fA-F]+)|([0-9]+));/y;

const MAX_CODE_POINT = 0x10ffff;

/** A Unicode scalar value other than U+0000. */
function isDecodable(codePoint: number): boolean {
  return (codePoint >= 0x1 && codePoint <= 0xd7ff) || (codePoint >= 0xe000 && codePoint <= MAX_CODE_POINT);
}

function isHighSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdbff;
}

function isLowSurrogate(codePoint: number): boolean {
  return codePoint >= 0xdc00 && codePoint <= 0xdfff;
}

/** The value of one decimal or hexadecimal digit that the pattern admitted. */
function digitValue(code: number): number {
  if (code <= 0x39) return code - 0x30; // 0-9
  if (code >= 0x61) return code - 0x57; // a-f
  return code - 0x37; // A-F
}

/**
 * The code point a reference's digits name, or `null` once the value passes
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

function numericValue(hex: string | undefined, decimal: string | undefined): number | null {
  return hex !== undefined ? codePointOf(hex, 16) : codePointOf(decimal ?? "", 10);
}

export function decodeHTMLEntities(text: string | null | undefined): string | null {
  if (!text) return text as null;
  // End of a low-surrogate reference already emitted as the second half of a
  // pair. `replace` still reaches that reference as its own match, and it must
  // then produce nothing.
  let pairedThrough = -1;
  return text.replace(
    REFERENCE,
    (reference: string, hex: string | undefined, decimal: string | undefined, name: string | undefined, offset: number): string => {
      if (offset < pairedThrough) return "";
      if (name !== undefined) return NAMED_REFERENCES.get(name) ?? reference;
      const codePoint = numericValue(hex, decimal);
      if (codePoint === null) return reference;
      if (isHighSurrogate(codePoint)) {
        const next = offset + reference.length;
        NUMERIC_REFERENCE_AT.lastIndex = next;
        const following = NUMERIC_REFERENCE_AT.exec(text);
        const low = following ? numericValue(following[1], following[2]) : null;
        if (following && low !== null && isLowSurrogate(low)) {
          pairedThrough = next + following[0].length;
          return String.fromCharCode(codePoint, low);
        }
        return reference;
      }
      return isDecodable(codePoint) ? String.fromCodePoint(codePoint) : reference;
    },
  );
}
