/**
 * The client entity decoder's contract, transcribed for its tests
 * (PAPERLUME-CODEQL-EDGE-TEXT-EXTRACTION-001A).
 *
 * Imports nothing from `src/lib/decodeHTMLEntities.ts`. The vector tables hold
 * hand-written expected text, and `specDecode` is an independent reading of the
 * contract: a character-by-character scanner, written without regular
 * expressions and without the decoder's digit arithmetic, so the two share no
 * code and no technique. Non-ASCII text is built with `String.fromCodePoint`,
 * so no raw invisible character is stored in this file.
 *
 * The contract:
 *  - named references `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&nbsp;`, lowercase
 *    only;
 *  - decimal references `&#` digits `;` and hexadecimal references `&#x` hex
 *    digits `;` (lowercase `x`, digits in either case);
 *  - a numeric reference decodes when its value is a Unicode scalar value other
 *    than U+0000; a high-surrogate reference immediately followed by a
 *    low-surrogate reference decodes as the pair; anything else stays as
 *    written;
 *  - one pass: text a reference produced is never read again.
 */

export const C = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);
export const NBSP = C(0xa0);

/** The named references the client decodes, transcribed from the contract. */
export const CLIENT_NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: NBSP,
};

/** A Unicode scalar value other than U+0000. */
export const isClientDecodable = (codePoint: number): boolean =>
  (codePoint >= 0x1 && codePoint <= 0xd7ff) || (codePoint >= 0xe000 && codePoint <= 0x10ffff);

const isHighSurrogate = (codePoint: number) => codePoint >= 0xd800 && codePoint <= 0xdbff;
const isLowSurrogate = (codePoint: number) => codePoint >= 0xdc00 && codePoint <= 0xdfff;

const isDigit = (c: string) => c >= "0" && c <= "9";
const isHexDigit = (c: string) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");

type Reference =
  | { kind: "named"; end: number; name: string }
  // `value` is null when the number is larger than any code point.
  | { kind: "numeric"; end: number; value: number | null };

/**
 * The value of a digit run, or null when it is above U+10FFFF. Decided from
 * the count of significant digits: U+10FFFF has 7 decimal and 6 hexadecimal
 * digits, so any longer run is larger than every code point.
 */
function valueOf(digits: string, hex: boolean): number | null {
  let first = 0;
  while (first < digits.length - 1 && digits[first] === "0") first++;
  const significant = digits.slice(first);
  if (significant.length > (hex ? 6 : 7)) return null;
  const value = Number.parseInt(significant, hex ? 16 : 10);
  return value > 0x10ffff ? null : value;
}

/** The reference that starts at `i` (where `text[i]` is `&`), if one does. */
function readReference(text: string, i: number): Reference | null {
  if (text[i] !== "&") return null;
  if (text[i + 1] === "#") {
    const hex = text[i + 2] === "x";
    const start = hex ? i + 3 : i + 2;
    let j = start;
    while (j < text.length && (hex ? isHexDigit(text[j]) : isDigit(text[j]))) j++;
    if (j === start || text[j] !== ";") return null;
    return { kind: "numeric", end: j + 1, value: valueOf(text.slice(start, j), hex) };
  }
  for (const name of Object.keys(CLIENT_NAMED_REFERENCES)) {
    if (text.startsWith(`${name};`, i + 1)) return { kind: "named", end: i + 2 + name.length, name };
  }
  return null;
}

/** The contract, read one character at a time. */
export function specDecode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const reference = readReference(text, i);
    if (reference === null) {
      out += text[i];
      i += 1;
      continue;
    }
    if (reference.kind === "named") {
      out += CLIENT_NAMED_REFERENCES[reference.name];
      i = reference.end;
      continue;
    }
    const value = reference.value;
    if (value !== null && isHighSurrogate(value)) {
      const next = readReference(text, reference.end);
      if (next?.kind === "numeric" && next.value !== null && isLowSurrogate(next.value)) {
        out += String.fromCharCode(value, next.value);
        i = next.end;
        continue;
      }
    }
    out += value !== null && isClientDecodable(value) ? String.fromCodePoint(value) : text.slice(i, reference.end);
    i = reference.end;
  }
  return out;
}

export interface Vector {
  readonly name: string;
  readonly input: string;
  readonly expected: string;
}

/** Supported references, as the client has always decoded them. */
export const ORDINARY_VECTORS: readonly Vector[] = [
  { name: "amp", input: "&amp;", expected: "&" },
  { name: "lt", input: "&lt;", expected: "<" },
  { name: "gt", input: "&gt;", expected: ">" },
  { name: "quot", input: "&quot;", expected: '"' },
  { name: "apos", input: "&apos;", expected: "'" },
  { name: "nbsp", input: "&nbsp;", expected: NBSP },
  { name: "decimal", input: "&#177;", expected: C(0xb1) },
  { name: "decimal thin space", input: "&#8201;", expected: C(0x2009) },
  { name: "hex lowercase digits", input: "&#xb1;", expected: C(0xb1) },
  { name: "hex uppercase digits", input: "&#xB1;", expected: C(0xb1) },
  { name: "hex mixed-case digits", input: "&#x3b2;&#x3B2;", expected: C(0x3b2, 0x3b2) },
  { name: "leading zeros, decimal", input: "&#0000065;", expected: "A" },
  { name: "leading zeros, hex", input: "&#x0000041;", expected: "A" },
  { name: "astral, hex", input: "&#x1D6FC;", expected: C(0x1d6fc) },
  { name: "astral, decimal", input: "&#120572;", expected: C(0x1d6fc) },
  { name: "maximum scalar value", input: "&#x10FFFF;", expected: C(0x10ffff) },
  { name: "tab, line feed, carriage return", input: "a&#9;b&#10;c&#13;d", expected: "a\tb\nc\rd" },
  {
    name: "the reported PubMed abstract",
    input: "46.4&#x2009;&#xb1;&#x2009;1.4 yr, BMI 32.3&#x2009;&#xb1;&#x2009;5.4 kg/m2",
    expected: `46.4${C(0x2009, 0xb1, 0x2009)}1.4 yr, BMI 32.3${C(0x2009, 0xb1, 0x2009)}5.4 kg/m2`,
  },
  { name: "text without references", input: "Normal text without entities", expected: "Normal text without entities" },
  { name: "already-decoded Unicode", input: `${C(0xb1)} ${C(0x2265)} ${C(0x3b1)}`, expected: `${C(0xb1)} ${C(0x2265)} ${C(0x3b1)}` },
];

/** One level per call: the required list, each with its one-pass result written by hand. */
export const ONE_PASS_VECTORS: readonly Vector[] = [
  { name: "&amp;lt;", input: "&amp;lt;", expected: "&lt;" },
  { name: "&amp;gt;", input: "&amp;gt;", expected: "&gt;" },
  { name: "&amp;quot;", input: "&amp;quot;", expected: "&quot;" },
  { name: "&amp;apos;", input: "&amp;apos;", expected: "&apos;" },
  { name: "&amp;nbsp;", input: "&amp;nbsp;", expected: "&nbsp;" },
  { name: "&amp;amp;", input: "&amp;amp;", expected: "&amp;" },
  { name: "&#38;lt;", input: "&#38;lt;", expected: "&lt;" },
  { name: "&#x26;lt;", input: "&#x26;lt;", expected: "&lt;" },
  { name: "&#x26;#60;", input: "&#x26;#60;", expected: "&#60;" },
  { name: "&amp;#60;", input: "&amp;#60;", expected: "&#60;" },
  { name: "&amp;#x3C;", input: "&amp;#x3C;", expected: "&#x3C;" },
  { name: "decimal ampersand before nbsp", input: "&#38;nbsp;", expected: "&nbsp;" },
  { name: "three levels lose one", input: "&amp;amp;lt;", expected: "&amp;lt;" },
  { name: "numeric before named", input: "&#38;amp;", expected: "&amp;" },
  { name: "named before numeric", input: "&amp;#38;", expected: "&#38;" },
  { name: "an ampersand reference then a surrogate pair", input: "&amp;#xD835;&#xDC00;", expected: "&#xD835;&#xDC00;" },
  { name: "a decoded < starts nothing", input: "&#60;&#33;--x--&#62;", expected: "<!--x-->" },
  { name: "decoded CDATA syntax stays text", input: "&lt;![CDATA[&amp;]]&gt;", expected: "<![CDATA[&]]>" },
];

/** References the client does not decode: kept exactly as written. */
export const PRESERVED_VECTORS: readonly Vector[] = [
  { name: "unknown names", input: "&alpha; &copy; &hellip; &mdash;", expected: "&alpha; &copy; &hellip; &mdash;" },
  { name: "uppercase names", input: "&AMP; &LT; &Amp; &NBSP;", expected: "&AMP; &LT; &Amp; &NBSP;" },
  { name: "uppercase X", input: "&#X41; &#XB1;", expected: "&#X41; &#XB1;" },
  { name: "no semicolon", input: "&amp &lt &#65 &#x41 &nbsp", expected: "&amp &lt &#65 &#x41 &nbsp" },
  { name: "no digits", input: "&#; &#x; &# &", expected: "&#; &#x; &# &" },
  { name: "a name followed by more letters", input: "&ampx; &ltz;", expected: "&ampx; &ltz;" },
  { name: "digits then a letter", input: "&#12a; &#x1g;", expected: "&#12a; &#x1g;" },
  { name: "a bare ampersand", input: "AT&T, R & D, a&b", expected: "AT&T, R & D, a&b" },
];

/** Numeric references the client leaves as written, and why. */
export const UNDECODED_NUMERIC_VECTORS: readonly Vector[] = [
  { name: "NUL, decimal", input: "&#0;", expected: "&#0;" },
  { name: "NUL, hex with leading zeros", input: "&#x0000;", expected: "&#x0000;" },
  { name: "lone high surrogate", input: "&#xD800;", expected: "&#xD800;" },
  { name: "lone low surrogate", input: "&#xDFFF;", expected: "&#xDFFF;" },
  { name: "lone surrogate, decimal", input: "&#55296;", expected: "&#55296;" },
  { name: "reversed pair", input: "&#xDC00;&#xD835;", expected: "&#xDC00;&#xD835;" },
  { name: "pair separated by a space", input: "&#xD835; &#xDC00;", expected: "&#xD835; &#xDC00;" },
  { name: "high surrogate before a non-surrogate", input: "&#xD835;&#x41;", expected: "&#xD835;A" },
  { name: "high surrogate before a named reference", input: "&#xD835;&amp;", expected: "&#xD835;&" },
  { name: "above the maximum", input: "&#x110000;", expected: "&#x110000;" },
  { name: "above the maximum, decimal", input: "&#1114112;", expected: "&#1114112;" },
  { name: "twenty decimal digits", input: "&#99999999999999999999;", expected: "&#99999999999999999999;" },
  { name: "a very long hex value", input: `&#x${"F".repeat(64)};`, expected: `&#x${"F".repeat(64)};` },
];

/** Surrogate pairs that decode, and the values the client still decodes as before. */
export const DECODED_EDGE_VALUE_VECTORS: readonly Vector[] = [
  { name: "pair, hex", input: "&#xD835;&#xDC00;", expected: C(0x1d400) },
  { name: "pair, decimal", input: "&#55349;&#56320;", expected: C(0x1d400) },
  { name: "pair, mixed forms", input: "&#xD835;&#56320;", expected: C(0x1d400) },
  { name: "pair, leading zeros", input: "&#x00D835;&#x0DC00;", expected: C(0x1d400) },
  { name: "two pairs", input: "&#xD835;&#xDC00;&#xD835;&#xDC01;", expected: C(0x1d400, 0x1d401) },
  { name: "high before a pair", input: "&#xD835;&#xD835;&#xDC00;", expected: `&#xD835;${C(0x1d400)}` },
  { name: "pair then a lone low", input: "&#xD835;&#xDC00;&#xDC01;", expected: `${C(0x1d400)}&#xDC01;` },
  { name: "C0 control", input: "&#x1;", expected: C(0x1) },
  { name: "unit separator", input: "&#31;", expected: C(0x1f) },
  { name: "delete", input: "&#127;", expected: C(0x7f) },
  { name: "C1 control, not remapped", input: "&#150;", expected: C(0x96) },
  { name: "noncharacter U+FFFE", input: "&#xFFFE;", expected: C(0xfffe) },
  { name: "noncharacter U+FDD0", input: "&#xFDD0;", expected: C(0xfdd0) },
  { name: "replacement character", input: "&#xFFFD;", expected: C(0xfffd) },
  { name: "first value after the surrogates", input: "&#xE000;", expected: C(0xe000) },
  { name: "last value before the surrogates", input: "&#xD7FF;", expected: C(0xd7ff) },
];

/**
 * Malformed references must not stop the valid ones around them: each invalid
 * reference with each valid one, before and after it.
 */
export const INVALID_REFERENCES: readonly string[] = [
  "&#x110000;",
  "&#1114112;",
  "&#99999999999999999999;",
  `&#x${"F".repeat(200)};`,
  "&#0;",
  "&#xD800;",
  "&#56320;",
  "&alpha;",
  "&amp",
  "&#65",
  "&#;",
  "&#X41;",
];

export const VALID_REFERENCES: readonly (readonly [string, string])[] = [
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
  ["&nbsp;", NBSP],
  ["&#945;", C(0x3b1)],
  ["&#x3B2;", C(0x3b2)],
  ["&#x0000041;", "A"],
  ["&#x1D6FC;", C(0x1d6fc)],
  ["&#xD835;&#xDC00;", C(0x1d400)],
];

/** Scientific text: literal operators, escaped ones, and Unicode. */
export const SCIENTIFIC_VECTORS: readonly Vector[] = [
  { name: "literal comparisons", input: "p < 0.05, q > 0.1, x <= 5, y >= 2, a<b", expected: "p < 0.05, q > 0.1, x <= 5, y >= 2, a<b" },
  { name: "escaped comparisons", input: "p &lt; 0.05 and 5 &lt; x &lt; 10; q &gt; 0.2", expected: "p < 0.05 and 5 < x < 10; q > 0.2" },
  {
    name: "numeric operators",
    input: "CI &#8805; 0.9, n&#8201;=&#8201;12, 5&#xB1;2, &#x2264;3, &#8800;0",
    expected: `CI ${C(0x2265)} 0.9, n${C(0x2009)}=${C(0x2009)}12, 5${C(0xb1)}2, ${C(0x2264)}3, ${C(0x2260)}0`,
  },
  {
    name: "Greek, micro and sub/superscripts",
    input: "&#x3B1;=0.05, &#x3B2;&gt;0.8, 10&#xB5;g, CO&#x2082;, m&#xB2;",
    expected: `${C(0x3b1)}=0.05, ${C(0x3b2)}>0.8, 10${C(0xb5)}g, CO${C(0x2082)}, m${C(0xb2)}`,
  },
  {
    name: "mathematical alphanumerics",
    input: "&#x1D45D; &lt; &#x1D6FC; and &#55349;&#56320;",
    expected: `${C(0x1d45d)} < ${C(0x1d6fc)} and ${C(0x1d400)}`,
  },
  { name: "escaped markup stays text", input: "&lt;i&gt;E. coli&lt;/i&gt; &amp; &lt;script&gt;", expected: "<i>E. coli</i> & <script>" },
];

/**
 * Fragments for generated inputs: reference pieces that can join into new
 * references, malformed syntax, surrogate halves, and plain text.
 */
export const FRAGMENTS: readonly string[] = [
  "&", "&", "&", "#", "#", "x", "X", ";", ";", "amp", "lt", "gt", "quot", "apos", "nbsp", "alpha", "AMP",
  "0", "00", "1", "9", "65", "38", "26", "3C", "60", "110000", "99999999", "D835", "DC00", "55349", "56320",
  "FFFE", "10FFFF", " ", "a", "<", ">", C(0x3b1), C(0x1d400),
];
