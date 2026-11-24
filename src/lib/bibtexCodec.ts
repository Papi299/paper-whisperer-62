/**
 * The BibTeX field codec: how a stored value is written into a `.bib` field by
 * the exporter (`exportUtils.ts`) and read back by the importer
 * (`importParsers.ts`). Both directions live here so that the tokens one side
 * writes are exactly the tokens the other side reads.
 *
 * Two facts about the format decide the design.
 *
 * 1. BibTeX finds the end of a field by counting braces, and it counts every
 *    brace. A backslash does not exempt one: the field scanner in `bibtex.web`
 *    has no backslash case, so `\}` closes a group exactly as `}` does. A field
 *    whose braces do not balance therefore ends early, or runs on into the next
 *    field or the next entry. TeX's `\{` is a literal brace only once LaTeX
 *    typesets the text. To BibTeX, biber and this app's own tokenizer it is
 *    still a structural brace.
 *
 * 2. Not every field is LaTeX. biblatex reads `doi` as a verbatim field and
 *    `url` as a URI field (biblatex manual 3.22a, §2.2.1 and §2.2.2): the raw
 *    characters are the value, and a LaTeX escape written there is read as the
 *    escape, not as the character it stands for.
 *
 * So the two kinds of field are handled differently.
 *
 * Text fields (title, author, journal, abstract, keywords, note) are LaTeX.
 * Each special character in the stored value is written as one fixed token, in
 * a single pass over the stored value, so a token is never read again as input.
 * A literal brace whose partner is in the same value is written `\{` or `\}`.
 * The pair keeps the field balanced, and it is the form every reader knows. A
 * brace with no partner is written `\textbraceleft{}` or `\textbraceright{}`.
 * These are standard LaTeX text symbols, and their own braces balance. No
 * backslash form of a lone brace could keep BibTeX's count.
 *
 * The DOI and URL are written to the standard `doi` and `url` fields exactly as
 * stored, and read from them exactly as written. Nothing in those fields is
 * ever decoded, whoever wrote the file. That is the established contract, and
 * it is what every reader of those fields expects: `doi` holds the DOI name and
 * `url` holds the URL. A DOI that happens to contain `\textbraceleft{}` is that
 * text, not a brace.
 *
 * A few values cannot be written there raw. Braces that do not balance would
 * end the field early or run on past it, and a value wrapped in one brace pair
 * would lose the pair when it is read back. Any transformed form of such a
 * value in the standard field would be a different DOI or URL to every other
 * reader, so the standard field is left out. The value is written to a
 * PaperLume field instead, `paperlume-doi-v1` or `paperlume-url-v1`, in which
 * `\`, `{` and `}` are written `\textbackslash{}`, `\textbraceleft{}` and
 * `\textbraceright{}`. The field's name says how its value is encoded, so the
 * importer never has to guess from what a value looks like.
 *
 * Decoding consumes the tokens it recognizes from the original input, left to
 * right, and never reads its own output again. Each character of the input is
 * either part of exactly one token or copied once. That is what keeps a
 * decoded `\` from combining with the text after it into a second token.
 */

// ── Brace structure ──

const BACKSLASH = 0x5c;
const LEFT_BRACE = 0x7b;
const RIGHT_BRACE = 0x7d;

/**
 * The index of each brace's partner, or -1 for a brace with none, found with
 * a stack so that pairs nest.
 *
 * With `texEscapes`, a backslash makes the character after it inert. That is
 * how TeX reads `\{`, `\}` and `\\`, and it decides what a brace *group* is.
 * Without it, every brace counts. That is how BibTeX finds where a field ends,
 * and it is also the right reading of stored text, in which a backslash is
 * just a character.
 */
function braceMatches(text: string, texEscapes: boolean): Int32Array {
  const partner = new Int32Array(text.length).fill(-1);
  const open: number[] = [];

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === BACKSLASH && texEscapes) {
      index++;
    } else if (code === LEFT_BRACE) {
      open.push(index);
    } else if (code === RIGHT_BRACE && open.length > 0) {
      const opening = open.pop() as number;
      partner[opening] = index;
      partner[index] = opening;
    }
  }

  return partner;
}

/** Whether every brace in `text` has a partner, counting every brace. */
function bracesBalance(text: string): boolean {
  const partner = braceMatches(text, false);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if ((code === LEFT_BRACE || code === RIGHT_BRACE) && partner[index] < 0) return false;
  }
  return true;
}

/**
 * Trim `text` and remove the brace pairs that enclose all of it, pairing
 * braces as `braceMatches` does with the same `texEscapes`.
 */
function stripEnclosingPairs(text: string, texEscapes: boolean): string {
  const trimmed = text.trim();
  const partner = braceMatches(trimmed, texEscapes);

  let start = 0;
  let end = trimmed.length - 1;
  while (start < end && trimmed.charCodeAt(start) === LEFT_BRACE && partner[start] === end) {
    start++;
    end--;
  }

  return trimmed.slice(start, end + 1);
}

/**
 * Remove brace pairs that enclose a whole value, after trimming it:
 * `{{Preserving Capitalisation}}` becomes `Preserving Capitalisation`.
 *
 * A pair is removed only when the opening brace's partner is the final
 * character, so the pair really encloses everything between. `{HIV} and {AIDS}`
 * starts and ends with a brace, but those are two separate groups, and the
 * value is left as it is. Braces are paired the way TeX reads them, so an
 * escaped `\{` or `\}` is a literal character and never closes the group.
 * Braces inside the value are kept: they are part of the imported text.
 */
export function stripOuterBraces(text: string): string {
  return stripEnclosingPairs(text, true);
}

/**
 * `stripOuterBraces` for a DOI or URL field. A backslash is an ordinary
 * character in a verbatim value, not a TeX escape, so braces are paired the
 * way BibTeX pairs them, every brace counting. `{{10.1000/x\}}` is the value
 * `10.1000/x\`, as the importer has always read it. The only difference from
 * the importer before this codec is that two separate groups, as in
 * `{a}{b}`, are no longer taken for one enclosing pair.
 */
function stripVerbatimOuterBraces(text: string): string {
  return stripEnclosingPairs(text, false);
}

// ── Decoding ──

interface Token {
  value: string;
  length: number;
}

/**
 * Decode `text` by scanning for positions where a token may start, reading at
 * most one token at each, and copying everything else once.
 */
function decodeTokens(
  text: string,
  tokenStart: RegExp,
  readToken: (text: string, at: number) => Token | null,
): string {
  let decoded = "";
  let index = 0;

  while (index < text.length) {
    tokenStart.lastIndex = index;
    const candidate = tokenStart.exec(text);
    const at = candidate ? candidate.index : text.length;

    decoded += text.slice(index, at);
    if (at === text.length) break;

    const token = readToken(text, at);
    if (token) {
      decoded += token.value;
      index = at + token.length;
    } else {
      decoded += text[at];
      index = at + 1;
    }
  }

  return decoded;
}

/** Match `pattern`, a sticky regex, at exactly `at`. */
function readPattern(
  pattern: RegExp,
  text: string,
  at: number,
  valueOf: (match: RegExpExecArray) => string,
): Token | null {
  pattern.lastIndex = at;
  const match = pattern.exec(text);
  return match ? { value: valueOf(match), length: match[0].length } : null;
}

/** LaTeX accent → Unicode lookup. */
const LATEX_ACCENTS: Record<string, string> = {
  "\\`a": "à", "\\'a": "á", "\\^a": "â", "\\~a": "ã", '\\"a': "ä", "\\aa": "å",
  "\\`e": "è", "\\'e": "é", "\\^e": "ê", '\\"e': "ë",
  "\\`i": "ì", "\\'i": "í", "\\^i": "î", '\\"i': "ï",
  "\\`o": "ò", "\\'o": "ó", "\\^o": "ô", "\\~o": "õ", '\\"o': "ö",
  "\\`u": "ù", "\\'u": "ú", "\\^u": "û", '\\"u': "ü",
  "\\'c": "ć", "\\cc": "ç", "\\~n": "ñ", "\\vs": "š", "\\vz": "ž", "\\vr": "ř",
  "\\`A": "À", "\\'A": "Á", "\\^A": "Â", "\\~A": "Ã", '\\"A': "Ä",
  "\\`E": "È", "\\'E": "É", "\\^E": "Ê", '\\"E': "Ë",
  "\\`I": "Ì", "\\'I": "Í", "\\^I": "Î", '\\"I': "Ï",
  "\\`O": "Ò", "\\'O": "Ó", "\\^O": "Ô", "\\~O": "Õ", '\\"O': "Ö",
  "\\`U": "Ù", "\\'U": "Ú", "\\^U": "Û", '\\"U': "Ü",
  "\\'C": "Ć", "\\cC": "Ç", "\\~N": "Ñ", "\\vS": "Š", "\\vZ": "Ž",
  "\\ss": "ß", "\\o": "ø", "\\O": "Ø", "\\ae": "æ", "\\AE": "Æ",
};

/**
 * `{\'e}` or `{\'{e}}`: an accent group. A letter's braces must come as a
 * pair, so the closing brace of an enclosing group (`{Caf\'e}`) is never taken
 * as part of the accent.
 */
const BRACED_ACCENT = /\{(\\[`'^"~cv])(?:\{([a-zA-Z])\}|([a-zA-Z]))\}/y;

/** `\'e` or `\'{e}`, including `\c{c}` and `\v{s}`. */
const UNBRACED_ACCENT = /(\\[`'^"~cv])(?:\{([a-zA-Z])\}|([a-zA-Z]))/y;

/** `\ss`, `\aa`, `\ae`, `\AE`, `\o`, `\O`, and the white space TeX skips after them. */
const LETTER_COMMAND = /\\(ss|aa|ae|AE|o|O)\b\s*/y;

/** `\&`, `\%`, `\$`, `\#`, `\_`, `\{`, `\}`. */
const ESCAPED_CHARACTER = /\\([&%$#_{}])/y;

/**
 * Text symbols, each written with an empty group as the exporter writes it.
 *
 * `\textbackslash\{\}` is the legacy form. Before this codec, the exporter
 * escaped the braces of its own `\textbackslash{}` token, so every backslash
 * in an older Paperlume export reads `\textbackslash\{\}`. To LaTeX that is a
 * backslash followed by two literal braces. It is read here as the backslash
 * it was meant to be, which is also what the importer did before.
 */
const TEXT_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ["\\textbackslash\\{\\}", "\\"],
  ["\\textbackslash{}", "\\"],
  ["\\textasciitilde{}", "~"],
  ["\\textasciicircum{}", "^"],
  ["\\textbraceleft{}", "{"],
  ["\\textbraceright{}", "}"],
];

const TEXT_TOKEN_START = /[\\{]/g;

function accentValue(match: RegExpExecArray): string {
  const letter = match[2] ?? match[3];
  return LATEX_ACCENTS[match[1] + letter] ?? letter;
}

function readTextToken(text: string, at: number): Token | null {
  if (text.charCodeAt(at) === LEFT_BRACE) {
    return readPattern(BRACED_ACCENT, text, at, accentValue);
  }

  for (const [token, value] of TEXT_SYMBOLS) {
    if (text.startsWith(token, at)) return { value, length: token.length };
  }

  return (
    readPattern(UNBRACED_ACCENT, text, at, accentValue) ??
    readPattern(LETTER_COMMAND, text, at, (match) => LATEX_ACCENTS[`\\${match[1]}`] ?? match[1]) ??
    readPattern(ESCAPED_CHARACTER, text, at, (match) => match[1])
  );
}

/**
 * Decode a BibTeX text field: LaTeX accents, escaped punctuation, and the text
 * symbols the exporter writes.
 *
 * Anything that is not a recognized token is kept as it is, including braces,
 * which carry case protection and stay in the imported text, and backslashes
 * that start no token. Each token is decoded once from the original input, so
 * a character that decoding produced is never read as part of another token.
 * Under the old sequence of replacements, the input
 * `\textbackslash{}textasciitilde{}` became `\textasciitilde{}`, and then `~`.
 */
export function decodeBibTeXText(text: string): string {
  return decodeTokens(text, TEXT_TOKEN_START, readTextToken);
}

// ── Encoding ──

const TEXT_SPECIAL = /[\\{}&%$#_~^]/g;

/**
 * Encode a stored value for a BibTeX text field, in one pass. Every character
 * the pattern matches is a character of the stored value. It is replaced by
 * its token, and the token is never matched again.
 */
export function encodeBibTeXText(value: string): string {
  const partner = braceMatches(value, false);

  return value.replace(TEXT_SPECIAL, (character: string, offset: number) => {
    switch (character) {
      case "\\":
        return "\\textbackslash{}";
      case "{":
        return partner[offset] >= 0 ? "\\{" : "\\textbraceleft{}";
      case "}":
        return partner[offset] >= 0 ? "\\}" : "\\textbraceright{}";
      case "~":
        return "\\textasciitilde{}";
      case "^":
        return "\\textasciicircum{}";
      default:
        // & % $ # _
        return `\\${character}`;
    }
  });
}

// ── DOI and URL ──

/**
 * The PaperLume field that carries a DOI or URL its standard field cannot
 * hold. The version is part of the name, and the importer reads only these
 * exact names, so a different encoding would need a new name rather than
 * change what this one means.
 */
const PAPERLUME_IDENTIFIER_FIELDS = {
  doi: "paperlume-doi-v1",
  url: "paperlume-url-v1",
} as const;

/** A standard identifier field. */
export type IdentifierField = keyof typeof PAPERLUME_IDENTIFIER_FIELDS;

/** A field as the exporter writes it, `name = {value}`. */
export interface BibTeXField {
  name: string;
  value: string;
}

/**
 * Whether a DOI or URL can be written raw in its standard field. Its braces
 * must balance, so that the field ends where it should, and no single pair may
 * enclose all of it, so that the importer reads back exactly the trimmed value.
 */
function writesIdentifierRaw(value: string): boolean {
  return bracesBalance(value) && stripVerbatimOuterBraces(value) === value.trim();
}

/**
 * The tokens of a PaperLume identifier field (version 1) and the characters
 * they stand for. These are three of the LaTeX text symbols that text fields
 * use. In an identifier field they are the whole grammar.
 */
const IDENTIFIER_TOKENS: ReadonlyArray<readonly [token: string, character: string]> = [
  ["\\textbackslash{}", "\\"],
  ["\\textbraceleft{}", "{"],
  ["\\textbraceright{}", "}"],
];

/** The token each of those characters is written as. */
const IDENTIFIER_TOKEN: Readonly<Record<string, string>> = Object.fromEntries(
  IDENTIFIER_TOKENS.map(([token, character]) => [character, token]),
);

/** The characters an identifier field writes as tokens. */
const IDENTIFIER_SPECIAL = /[\\{}]/g;

/** The same characters, found one at a time while a field is decoded. */
const IDENTIFIER_PAYLOAD_SPECIAL = /[\\{}]/g;

/**
 * How a DOI (`field` "doi") or a URL (`field` "url") is written.
 *
 * A value that can be written raw goes to the standard field exactly as
 * stored, as it always has. That is every DOI and URL whose braces balance and
 * that is not wrapped in one pair, whatever else it contains. Any other value
 * goes to the PaperLume field, with `\`, `{` and `}` written as tokens and
 * nothing else changed. The standard field is then left out, because no form
 * of such a value written there would read as the same DOI or URL in another
 * tool.
 */
export function writeIdentifierField(field: IdentifierField, value: string): BibTeXField {
  if (writesIdentifierRaw(value)) return { name: field, value };
  return {
    name: PAPERLUME_IDENTIFIER_FIELDS[field],
    value: value.replace(IDENTIFIER_SPECIAL, (character: string) => IDENTIFIER_TOKEN[character]),
  };
}

/**
 * Decode the value of a PaperLume identifier field, or return `null` if it is
 * not a valid one. The grammar is strict. Every `\` must begin one of the
 * three tokens, and every `{` and `}` must belong to one. Anything else,
 * including any other LaTeX, makes the value malformed, and the whole field is
 * ignored rather than read in part. Each token is read once, from the field as
 * written.
 */
function decodeIdentifierPayload(payload: string): string | null {
  let decoded = "";
  let index = 0;

  while (index < payload.length) {
    IDENTIFIER_PAYLOAD_SPECIAL.lastIndex = index;
    const special = IDENTIFIER_PAYLOAD_SPECIAL.exec(payload);
    if (!special) return decoded + payload.slice(index);

    const at = special.index;
    const token = IDENTIFIER_TOKENS.find(([text]) => payload.startsWith(text, at));
    if (!token) return null;

    decoded += payload.slice(index, at) + token[1];
    index = at + token[0].length;
  }

  return decoded;
}

/**
 * Read a DOI (`field` "doi") or a URL (`field` "url") from an entry's fields.
 *
 * The standard field is read raw, as before: brace pairs that enclose the
 * whole value are removed, the value is trimmed, and nothing is decoded. When
 * it has a value, that value is the answer. A PaperLume field in the same entry
 * is then ignored, so it can never replace the DOI or URL that every other
 * tool reads.
 *
 * Only when the standard field is missing or empty is the PaperLume field
 * read, by the strict grammar above, and a malformed value gives nothing. A
 * value is not trusted for having come from that field: the importer handles
 * it exactly as it handles the standard field's value, so a URL still has to
 * pass the same PubMed recognition and link checks.
 */
export function readIdentifierField(
  fields: Readonly<Record<string, string | undefined>>,
  field: IdentifierField,
): string | null {
  const written = fields[field];
  const standard = written ? stripVerbatimOuterBraces(written).trim() : null;
  if (standard) return standard;

  const payload = fields[PAPERLUME_IDENTIFIER_FIELDS[field]];
  const decoded = payload ? decodeIdentifierPayload(stripVerbatimOuterBraces(payload)) : null;
  return decoded?.trim() || standard;
}
