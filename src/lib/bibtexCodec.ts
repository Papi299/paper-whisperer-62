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
 * So there are two encodings.
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
 * Verbatim fields (doi, url) are written exactly as stored. That is the
 * established contract: the DOI field carries the DOI name and the URL field
 * carries the URL. The exception is a value that cannot be written raw without
 * breaking the file or changing what this app reads back. That covers braces
 * that do not balance, a value wrapped in one brace pair (which the importer
 * strips), and text that would read back as one of this codec's own tokens.
 * Only such a value has its `\`, `{` and `}` written as tokens. Every other DOI
 * and URL is written byte for byte as before.
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
  const trimmed = text.trim();
  const partner = braceMatches(trimmed, true);

  let start = 0;
  let end = trimmed.length - 1;
  while (start < end && trimmed.charCodeAt(start) === LEFT_BRACE && partner[start] === end) {
    start++;
    end--;
  }

  return trimmed.slice(start, end + 1);
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

/** The tokens of the verbatim encoding, and the characters they stand for. */
const VERBATIM_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ["\\textbackslash{}", "\\"],
  ["\\textbraceleft{}", "{"],
  ["\\textbraceright{}", "}"],
];

const VERBATIM_TOKEN_START = /\\/g;

function readVerbatimToken(text: string, at: number): Token | null {
  for (const [token, value] of VERBATIM_SYMBOLS) {
    if (text.startsWith(token, at)) return { value, length: token.length };
  }
  return null;
}

/**
 * Decode a verbatim field (doi, url). Only this codec's three verbatim tokens
 * are read. Everything else is the value itself, so a DOI or URL that was
 * written raw comes back unchanged.
 */
export function decodeBibTeXVerbatim(text: string): string {
  return decodeTokens(text, VERBATIM_TOKEN_START, readVerbatimToken);
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

const VERBATIM_SPECIAL = /[\\{}]/g;

const VERBATIM_TOKEN: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "{": "\\textbraceleft{}",
  "}": "\\textbraceright{}",
};

/**
 * Whether a verbatim value can be written raw, that is, whether the importer
 * reads exactly the trimmed value back from the raw text: its braces balance,
 * no brace pair encloses all of it, and it contains nothing that would decode
 * as a verbatim token.
 */
function writesVerbatimRaw(value: string): boolean {
  return (
    bracesBalance(value) &&
    stripOuterBraces(value) === value.trim() &&
    decodeBibTeXVerbatim(value) === value
  );
}

/**
 * Encode a stored value for a verbatim field (doi, url).
 *
 * The value is written raw whenever that is safe, which is every DOI and URL
 * whose braces balance and that contains no verbatim token. Otherwise `\`, `{`
 * and `}` are written as tokens and nothing else changes. That form is
 * structurally valid, and this app reads the stored value back from it. A tool
 * that reads the field verbatim sees the tokens, but no raw form of such a
 * value could be valid BibTeX at all.
 */
export function encodeBibTeXVerbatim(value: string): string {
  if (writesVerbatimRaw(value)) return value;
  return value.replace(VERBATIM_SPECIAL, (character: string) => VERBATIM_TOKEN[character]);
}
