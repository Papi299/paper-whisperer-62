/**
 * The text of XML mixed content in provider metadata: PubMed EFetch titles,
 * abstracts and author fields, and the JATS fragments Crossref returns as
 * abstracts.
 *
 * ## What this is, and what it is not
 *
 * A small lexer for the markup XML 1.0 allows inside element content — tags,
 * comments, CDATA sections, processing instructions and references — with
 * explicitly bounded handling of everything else. It is not an XML parser: it
 * does not check that tags nest or balance, read a DTD, expand entities,
 * normalize line endings or resolve namespaces. It is not an HTML parser or an
 * HTML sanitizer either. It returns text for a JSON response, never HTML, and
 * that text may contain `<`, `>` or `&`, because scientific text does
 * (`p &lt; 0.05`).
 *
 * It replaces the single-pass `/<[^>]+>/g` removals CodeQL reported
 * (`js/incomplete-multi-character-sanitization`, alerts 2–5). Those removals were
 * not sanitizers and are not replaced by one: they were text extraction, and
 * they lost text — a `>` inside a quoted attribute ended the "tag" early, a
 * CDATA section was deleted, and an unescaped `<` in a provider's text deleted
 * everything up to the next `>`.
 *
 * ## What counts as markup
 *
 * A `<` begins markup only where XML's grammar says a complete construct begins:
 *
 *  - a start or empty-element tag: `<` Name, then attributes, each preceded by
 *    white space and written `Name = "value"` or `Name = 'value'`, then an
 *    optional `/` and `>`. A value may contain `>`; it may not contain `<`
 *    (XML 1.0 [10] `AttValue`);
 *  - an end tag: `</` Name, optional white space, `>`;
 *  - a comment `<!--` … `-->`, a CDATA section `<![CDATA[` … `]]>`, and a
 *    processing instruction `<?` Name … `?>`.
 *
 * Names follow XML 1.0 [4]/[4a]/[5]. Any other `<` — `p < 0.05`, `<5 mg`,
 * `a <b and c> d`, an unterminated comment or quote — is text.
 *
 * ## The output: character data, still escaped
 *
 * `xmlCharacterData` returns the content's character data with the markup
 * removed, in XML's escaped form:
 *
 *  - a reference that is complete (`&amp;`, `&#x3B1;`, `&nbsp;`) is copied as
 *    written; deciding what it means belongs to the decoding stage. The
 *    exception is the few character references described below, which no
 *    decoder is left to interpret;
 *  - a CDATA section's text is escaped — `&`, `<` and `>` become `&amp;`,
 *    `&lt;` and `&gt;`, which is how Canonical XML writes a CDATA section's
 *    character content — so decoding yields its literal text and nothing inside
 *    it is read as a reference or as markup;
 *  - a `&` that does not begin a complete reference, and a `<` that does not
 *    begin markup, are escaped the same way. Well-formed XML has neither; a
 *    provider that sends one is sending text.
 *
 * Decoding the result once therefore yields the text, and removing markup can
 * never join two runs of text into a reference that the source did not contain.
 * The markup is recognized on the provider's source before anything is decoded,
 * so an escaped `&lt;b&gt;` is text and stays text.
 *
 * Who decodes, and when, is the caller's decision — see `fetch-paper-metadata`
 * and `pubmedAuthors.ts`. This module never decodes.
 *
 * ## Character references every decoder must read alike
 *
 * The title and abstract are decoded in the browser, and a tab opened before a
 * release keeps the decoder it loaded. The one served before PR #377 ran eight
 * replacements in sequence — hexadecimal references first, then decimal ones,
 * each pass reading the previous pass's output — and when `String.fromCodePoint`
 * threw it gave up on the whole field and stored it still escaped
 * (CODEQL-EDGE-TEXT-EXTRACTION-001B). So the output never depends on how a
 * decoder treats a character reference that names no character it can return:
 *
 *  - a reference to U+0000 or to a value above U+10FFFF (`&#x110000;`, a
 *    twenty-digit reference) is written as the text it is: its `&` is escaped,
 *    as for an incomplete reference, so it decodes to itself;
 *  - so is a reference to a surrogate code point, unless it is one half of a
 *    pair: a high surrogate's reference followed directly, in the output, by a
 *    low surrogate's, which a decoder combines into one character. A tag the
 *    output does not show (`<i>`, a comment) does not separate the two halves;
 *    a word boundary does;
 *  - a reference to `&` itself (`&#38;`, `&#x26;`) is written `&amp;`, so that
 *    a decoder that reads hexadecimal references before decimal ones cannot
 *    turn it into the start of another reference.
 *
 * Both decoders that read this output — the client's and this function's own
 * (`htmlEntities.ts`, for author fields) — keep those references as text and
 * read `&#x26;` and `&amp;` alike, so decoding the output once yields exactly
 * the text it yielded before; only a decoder that would have thrown or cascaded
 * on them reads something different, and that is now plain text. Every other
 * character reference is copied as written.
 *
 * ## Words across tags
 *
 * Removing a tag inserts nothing, so `CO<sub>2</sub>` stays `CO2`. A caller may
 * name elements whose tags separate words (`wordBoundaries`, by local name):
 * where such a tag would otherwise make two words touch, one space is written,
 * and only then. Existing white space is kept as it is; nothing is normalized.
 *
 * ## Bounds
 *
 * One left-to-right pass. A construct that is not complete is abandoned at the
 * first character that cannot continue it — at the latest at the next `<`, since
 * no name, white space or attribute value may contain one — and searches for
 * `-->`, `]]>` and `?>` are remembered, so no part of the input is scanned more
 * than a constant number of times. A character reference's value is read once
 * more, digit by digit, and reading stops as soon as it passes U+10FFFF. No
 * recursion and no backtracking pattern; output is collected in an array and
 * joined once, and the only part ever rewritten is a high surrogate's reference
 * whose low half did not follow. The work is linear in the input.
 */

const LT = 0x3c;
const GT = 0x3e;
const AMP = 0x26;
const SLASH = 0x2f;
const EQUALS = 0x3d;
const QUOTE = 0x22;
const APOSTROPHE = 0x27;
const QUESTION = 0x3f;
const BANG = 0x21;
const SEMICOLON = 0x3b;
const HASH = 0x23;
const LOWER_X = 0x78;
const MAX_CODE_POINT = 0x10ffff;

/** XML 1.0 [3] `S`. */
function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x9 || code === 0xa || code === 0xd;
}

/** XML 1.0 [4] `NameStartChar`, by code point. */
function isNameStartChar(cp: number): boolean {
  return (
    (cp >= 0x61 && cp <= 0x7a) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    cp === 0x5f ||
    cp === 0x3a ||
    (cp >= 0xc0 && cp <= 0xd6) ||
    (cp >= 0xd8 && cp <= 0xf6) ||
    (cp >= 0xf8 && cp <= 0x2ff) ||
    (cp >= 0x370 && cp <= 0x37d) ||
    (cp >= 0x37f && cp <= 0x1fff) ||
    (cp >= 0x200c && cp <= 0x200d) ||
    (cp >= 0x2070 && cp <= 0x218f) ||
    (cp >= 0x2c00 && cp <= 0x2fef) ||
    (cp >= 0x3001 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfdcf) ||
    (cp >= 0xfdf0 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0xeffff)
  );
}

/** XML 1.0 [4a] `NameChar`, by code point. */
function isNameChar(cp: number): boolean {
  return (
    isNameStartChar(cp) ||
    cp === 0x2d ||
    cp === 0x2e ||
    (cp >= 0x30 && cp <= 0x39) ||
    cp === 0xb7 ||
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x203f && cp <= 0x2040)
  );
}

/** The end of the XML Name that starts at `start`, or `start` when none does. */
function nameEnd(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    const cp = s.codePointAt(i) as number;
    if (!(i === start ? isNameStartChar(cp) : isNameChar(cp))) break;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

/** Unicode White_Space (PropList.txt), for the word-boundary decision only. */
function isWhiteSpace(code: number): boolean {
  return (
    (code >= 0x9 && code <= 0xd) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/**
 * Where the first occurrence of a terminator at or after `from` is, remembered
 * across calls. Lookups only move forward, so a terminator that is missing once
 * is missing for every later lookup, and one found ahead of the next lookup is
 * still the first one after it.
 */
interface TerminatorMemo {
  from: number;
  at: number;
}

interface Memos {
  comment: TerminatorMemo;
  cdata: TerminatorMemo;
  pi: TerminatorMemo;
}

function newMemos(): Memos {
  const fresh = (): TerminatorMemo => ({ from: Number.POSITIVE_INFINITY, at: -1 });
  return { comment: fresh(), cdata: fresh(), pi: fresh() };
}

function findTerminator(s: string, needle: string, from: number, memo: TerminatorMemo): number {
  if (from >= memo.from && (memo.at === -1 || memo.at >= from)) return memo.at;
  const at = s.indexOf(needle, from);
  memo.from = from;
  memo.at = at;
  return at;
}

type Markup =
  | { kind: "tag"; end: number; name: string; closing: boolean; empty: boolean }
  | { kind: "comment" | "pi"; end: number }
  | { kind: "cdata"; end: number; text: string };

/**
 * The markup construct that begins with the `<` at `start`, or `null` when that
 * `<` begins none and is therefore text.
 */
function scanMarkup(s: string, start: number, memos: Memos): Markup | null {
  const next = s.charCodeAt(start + 1);

  if (next === BANG) {
    if (s.startsWith("!--", start + 1)) {
      const close = findTerminator(s, "-->", start + 4, memos.comment);
      return close === -1 ? null : { kind: "comment", end: close + 3 };
    }
    if (s.startsWith("![CDATA[", start + 1)) {
      const close = findTerminator(s, "]]>", start + 9, memos.cdata);
      return close === -1 ? null : { kind: "cdata", end: close + 3, text: s.slice(start + 9, close) };
    }
    return null;
  }

  if (next === QUESTION) {
    const targetEnd = nameEnd(s, start + 2);
    if (targetEnd === start + 2) return null;
    const close = findTerminator(s, "?>", targetEnd, memos.pi);
    return close === -1 ? null : { kind: "pi", end: close + 2 };
  }

  if (next === SLASH) {
    const nameStop = nameEnd(s, start + 2);
    if (nameStop === start + 2) return null;
    let i = nameStop;
    while (i < s.length && isXmlSpace(s.charCodeAt(i))) i++;
    if (s.charCodeAt(i) !== GT) return null;
    return { kind: "tag", end: i + 1, name: s.slice(start + 2, nameStop), closing: true, empty: false };
  }

  const nameStop = nameEnd(s, start + 1);
  if (nameStop === start + 1) return null;
  const name = s.slice(start + 1, nameStop);
  let i = nameStop;
  for (;;) {
    const spaceStart = i;
    while (i < s.length && isXmlSpace(s.charCodeAt(i))) i++;
    const code = s.charCodeAt(i);
    if (code === GT) return { kind: "tag", end: i + 1, name, closing: false, empty: false };
    if (code === SLASH) {
      return s.charCodeAt(i + 1) === GT
        ? { kind: "tag", end: i + 2, name, closing: false, empty: true }
        : null;
    }
    // XML 1.0 [40]: each attribute is preceded by white space.
    if (i === spaceStart) return null;
    const attributeNameStop = nameEnd(s, i);
    if (attributeNameStop === i) return null;
    i = attributeNameStop;
    while (i < s.length && isXmlSpace(s.charCodeAt(i))) i++;
    if (s.charCodeAt(i) !== EQUALS) return null;
    i++;
    while (i < s.length && isXmlSpace(s.charCodeAt(i))) i++;
    const quote = s.charCodeAt(i);
    if (quote !== QUOTE && quote !== APOSTROPHE) return null;
    i++;
    while (i < s.length) {
      const valueCode = s.charCodeAt(i);
      if (valueCode === quote) break;
      if (valueCode === LT) return null;
      i++;
    }
    if (i >= s.length) return null;
    i++;
  }
}

function isDecimalDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isHexDigit(code: number): boolean {
  return isDecimalDigit(code) || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46);
}

/**
 * The end of the complete reference that begins with the `&` at `start`, or
 * `-1`. Complete means XML's syntax (`&#` digits `;`, `&#x` hex digits `;`,
 * `&` Name `;`) — whatever the value or name; decoding decides what it means.
 */
function referenceEnd(s: string, start: number): number {
  let i = start + 1;
  if (s.charCodeAt(i) === HASH) {
    i++;
    const hex = s.charCodeAt(i) === LOWER_X;
    if (hex) i++;
    const digitsStart = i;
    while (i < s.length && (hex ? isHexDigit(s.charCodeAt(i)) : isDecimalDigit(s.charCodeAt(i)))) i++;
    return i > digitsStart && s.charCodeAt(i) === SEMICOLON ? i + 1 : -1;
  }
  const stop = nameEnd(s, i);
  return stop > i && s.charCodeAt(stop) === SEMICOLON ? stop + 1 : -1;
}

/** The value of one digit that `referenceEnd` admitted. */
function digitValue(code: number): number {
  if (code <= 0x39) return code - 0x30; // 0-9
  if (code >= 0x61) return code - 0x57; // a-f
  return code - 0x37; // A-F
}

/**
 * The value of the complete character reference spanning `[start, end)`,
 * `Infinity` once it passes U+10FFFF, or `-1` for an entity reference. Digits
 * are read one at a time and reading stops above U+10FFFF, so the value never
 * grows with the length of the reference; leading zeros keep it small.
 */
function characterReferenceValue(s: string, start: number, end: number): number {
  if (s.charCodeAt(start + 1) !== HASH) return -1;
  const hex = s.charCodeAt(start + 2) === LOWER_X;
  const radix = hex ? 16 : 10;
  let value = 0;
  for (let i = start + (hex ? 3 : 2); i < end - 1; i++) {
    value = value * radix + digitValue(s.charCodeAt(i));
    if (value > MAX_CODE_POINT) return Number.POSITIVE_INFINITY;
  }
  return value;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

/**
 * Whether a character reference with this value is copied as written. The
 * others are written by `xmlCharacterData` itself; see "Character references
 * every decoder must read alike" above.
 */
function isCopiedAsWritten(value: number): boolean {
  return value > 0 && value <= MAX_CODE_POINT && value !== AMP && !isHighSurrogate(value) && !isLowSurrogate(value);
}

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Literal text in escaped form, as Canonical XML writes a CDATA section's content. */
function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (character) => ESCAPES[character]);
}

function localName(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf(":") + 1);
}

export interface XmlCharacterDataOptions {
  /**
   * Local names of the elements whose start, end and empty-element tags
   * separate words, e.g. a paragraph. Every other tag is removed without a
   * trace, as inline markup must be.
   */
  readonly wordBoundaries?: ReadonlySet<string>;
}

/**
 * The character data of one element's content (its source between the start
 * and end tags), with markup removed and in escaped form. See the module
 * comment for the exact contract.
 */
export function xmlCharacterData(source: string, options: XmlCharacterDataOptions = {}): string {
  const boundaries = options.wordBoundaries;
  const memos = newMemos();
  const parts: string[] = [];
  let lastCode = -1;
  let boundaryPending = false;
  // The index in `parts` of a high surrogate's reference that nothing has
  // followed yet, so its low half may still come; -1 when there is none.
  let pendingHigh = -1;

  /** The pending high half was not followed by its low half: it is text. */
  const settleHigh = (): void => {
    if (pendingHigh !== -1) {
      parts[pendingHigh] = `&amp;${parts[pendingHigh].slice(1)}`;
      pendingHigh = -1;
    }
  };

  const emit = (text: string): void => {
    if (text.length === 0) return;
    settleHigh();
    if (boundaryPending) {
      if (lastCode !== -1 && !isWhiteSpace(lastCode) && !isWhiteSpace(text.charCodeAt(0))) {
        parts.push(" ");
      }
      boundaryPending = false;
    }
    parts.push(text);
    lastCode = text.charCodeAt(text.length - 1);
  };

  /** A complete character reference that `isCopiedAsWritten` rejects. */
  const writeReference = (reference: string, value: number): void => {
    if (value === AMP) {
      emit("&amp;");
    } else if (isLowSurrogate(value) && pendingHigh !== -1 && !boundaryPending) {
      // Directly after its high half: the pair stays as written.
      parts.push(reference);
      lastCode = SEMICOLON;
      pendingHigh = -1;
    } else if (isHighSurrogate(value)) {
      emit(reference);
      pendingHigh = parts.length - 1;
    } else {
      emit(`&amp;${reference.slice(1)}`);
    }
  };

  let textStart = 0;
  let i = 0;
  while (i < source.length) {
    const code = source.charCodeAt(i);
    if (code === LT) {
      emit(source.slice(textStart, i));
      const markup = scanMarkup(source, i, memos);
      if (markup === null) {
        emit("&lt;");
        i++;
      } else {
        if (markup.kind === "cdata") emit(escapeText(markup.text));
        else if (markup.kind === "tag" && boundaries?.has(localName(markup.name))) boundaryPending = true;
        i = markup.end;
      }
      textStart = i;
    } else if (code === AMP) {
      const end = referenceEnd(source, i);
      if (end === -1) {
        emit(source.slice(textStart, i));
        emit("&amp;");
        i++;
        textStart = i;
      } else {
        const value = characterReferenceValue(source, i, end);
        if (value !== -1 && !isCopiedAsWritten(value)) {
          emit(source.slice(textStart, i));
          writeReference(source.slice(i, end), value);
          textStart = end;
        }
        i = end;
      }
    } else {
      i++;
    }
  }
  emit(source.slice(textStart));
  settleHigh();
  return parts.join("");
}

/**
 * The source of the content of every element named `name`, in document order:
 * everything between its start tag and the first end tag of the same name after
 * it, so elements never overlap. `name` is compared exactly, prefix included.
 * An empty-element tag (`<AbstractText/>`) has no content and contributes
 * nothing. Tags inside comments and CDATA sections are not tags. Reading stops
 * after `limit` elements.
 *
 * This replaces the `<Name[^>]*>([\s\S]*?)</Name>` patterns for the two fields
 * it serves, keeping their selection — every complete element, in order — while
 * reading a start tag's quoted attributes whole and staying linear on input
 * full of unclosed start tags.
 */
export function xmlElementContents(
  xml: string,
  name: string,
  limit: number = Number.POSITIVE_INFINITY,
): string[] {
  const memos = newMemos();
  const contents: string[] = [];
  let contentStart = -1;
  let i = xml.indexOf("<");
  while (i !== -1 && contents.length < limit) {
    const markup = scanMarkup(xml, i, memos);
    if (markup === null) {
      i = xml.indexOf("<", i + 1);
      continue;
    }
    if (markup.kind === "tag" && markup.name === name) {
      if (contentStart === -1) {
        if (!markup.closing && !markup.empty) contentStart = markup.end;
      } else if (markup.closing) {
        contents.push(xml.slice(contentStart, i));
        contentStart = -1;
      }
    }
    i = xml.indexOf("<", markup.end);
  }
  return contents;
}
