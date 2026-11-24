import { describe, it, expect } from "vitest";
import {
  decodeBibTeXText,
  decodeBibTeXVerbatim,
  encodeBibTeXText,
  encodeBibTeXVerbatim,
  stripOuterBraces,
} from "../bibtexCodec";

/**
 * The BibTeX field codec, tested against expectations written down here from
 * the format's own rules rather than taken from the code under test:
 *
 * - LaTeX's text symbols (`\textbackslash`, `\textbraceleft`, `\textbraceright`,
 *   `\textasciitilde`, `\textasciicircum`) and escapes (`\&` `\%` `\$` `\#`
 *   `\_` `\{` `\}`) for text fields;
 * - BibTeX's brace rule from `bibtex.web`: every brace counts, a backslash
 *   before it changes nothing, and a field ends where the count returns to
 *   zero (`bibtexFieldEnd` below is an independent transcription of it);
 * - biblatex's verbatim fields, which are read raw, for `doi` and `url`.
 *
 * Round trips are checked as well. They are never the only check, because an
 * encoder and a decoder can share a wrong assumption and still agree.
 *
 * Fixtures use `String.raw`, so a backslash in them is one backslash.
 */

const BS = "\\";

/**
 * Where a brace-delimited field that opens at `open` ends, by BibTeX's rule:
 * count every brace and stop at the one that returns the count to zero.
 * Returns -1 if the field never closes.
 */
function bibtexFieldEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Whether `{value}` is exactly one complete BibTeX field. */
function isOneField(value: string): boolean {
  const field = `{${value}}`;
  return bibtexFieldEnd(field, 0) === field.length - 1;
}

// A small deterministic generator, so the property checks are reproducible.
function generator(seed: number) {
  let state = seed | 0;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (alphabet: readonly string[], maxLength: number): string => {
    const length = 1 + Math.floor(next() * maxLength);
    let s = "";
    for (let i = 0; i < length; i++) s += alphabet[Math.floor(next() * alphabet.length)];
    return s;
  };
}

/** Every character BibTeX or LaTeX treats specially, plus letters, accents and separators. */
const ALPHABET: readonly string[] = [
  BS, "{", "}", "&", "%", "$", "#", "_", "~", "^", "'", "`", '"', "c", "v", "o", "s", "e",
  "t", "x", "@", "=", ",", " ", "\n", "\r", String.fromCodePoint(0x3b1),
  String.fromCodePoint(0x2264), String.fromCodePoint(0xe9), String.fromCodePoint(0x1f9ea),
];

const randomValues = (seed: number, count: number, maxLength: number): string[] => {
  const draw = generator(seed);
  return Array.from({ length: count }, () => draw(ALPHABET, maxLength));
};

// ── Text encoding ──

describe("encodeBibTeXText writes one fixed LaTeX token per special character", () => {
  const TOKENS: ReadonlyArray<readonly [string, string]> = [
    [BS, String.raw`\textbackslash{}`],
    ["&", String.raw`\&`],
    ["%", String.raw`\%`],
    ["$", String.raw`\$`],
    ["#", String.raw`\#`],
    ["_", String.raw`\_`],
    ["~", String.raw`\textasciitilde{}`],
    ["^", String.raw`\textasciicircum{}`],
    ["{", String.raw`\textbraceleft{}`],
    ["}", String.raw`\textbraceright{}`],
  ];

  for (const [character, token] of TOKENS) {
    it(`${JSON.stringify(character)} → ${token}`, () => {
      expect(encodeBibTeXText(`a${character}b`)).toBe(`a${token}b`);
    });
  }

  it("writes a backslash as \\textbackslash{} and leaves the token's braces alone", () => {
    // The old chain escaped its own token, writing `\textbackslash\{\}`, which
    // LaTeX prints as a backslash followed by two braces.
    expect(encodeBibTeXText(String.raw`C:\data`)).toBe(String.raw`C:\textbackslash{}data`);
    expect(encodeBibTeXText(String.raw`C:\data`)).not.toContain(String.raw`\{\}`);
  });

  it("encodes consecutive backslashes one by one", () => {
    expect(encodeBibTeXText(String.raw`\\server\share`)).toBe(
      String.raw`\textbackslash{}\textbackslash{}server\textbackslash{}share`,
    );
  });

  it("encodes a backslash before a brace as two separate characters", () => {
    expect(encodeBibTeXText(String.raw`\{`)).toBe(String.raw`\textbackslash{}\textbraceleft{}`);
    expect(encodeBibTeXText(String.raw`\}`)).toBe(String.raw`\textbackslash{}\textbraceright{}`);
    expect(encodeBibTeXText(String.raw`\{x\}`)).toBe(String.raw`\textbackslash{}\{x\textbackslash{}\}`);
  });

  it("writes a brace with a partner in the value as \\{ or \\}, as before", () => {
    expect(encodeBibTeXText("The {HIV} Epidemic")).toBe(String.raw`The \{HIV\} Epidemic`);
    expect(encodeBibTeXText("{a {b} c}")).toBe(String.raw`\{a \{b\} c\}`);
  });

  it("pairs braces by position, not by count", () => {
    // A closing brace before its opening brace has no partner.
    expect(encodeBibTeXText("a } b { c")).toBe(String.raw`a \textbraceright{} b \textbraceleft{} c`);
    expect(encodeBibTeXText("{ { }")).toBe(String.raw`\textbraceleft{} \{ \}`);
    expect(encodeBibTeXText("{ } }")).toBe(String.raw`\{ \} \textbraceright{}`);
  });

  it("encodes LaTeX-looking text as literal text", () => {
    expect(encodeBibTeXText(String.raw`\textasciitilde{}`)).toBe(String.raw`\textbackslash{}textasciitilde\{\}`);
    expect(encodeBibTeXText(String.raw`\'e`)).toBe(String.raw`\textbackslash{}'e`);
    expect(encodeBibTeXText(String.raw`\alpha + \beta`)).toBe(String.raw`\textbackslash{}alpha + \textbackslash{}beta`);
  });

  it("copies every other character unchanged, including Unicode and comparison operators", () => {
    const plain = [
      "Effect of treatment",
      String.fromCodePoint(0x3b1, 0x3b2, 0x3b3, 0x394, 0x3bc), // Greek letters
      String.fromCodePoint(0x2264, 0x2265, 0xb1, 0xd7, 0x221a, 0x2211, 0x221e, 0x2248, 0x2260), // math symbols
      `CO${String.fromCodePoint(0x2082)} and Ca${String.fromCodePoint(0xb2, 0x207a)}`,
      "p < 0.05; OR = 2.1, 95 CI [1.3, 3.4] | x > y",
      `Jos${String.fromCodePoint(0xe9)} Garc${String.fromCodePoint(0xed)}a, Zo${String.fromCodePoint(0xeb)}`,
      `"quoted" 'single' @home = value, more`,
      "line one\nline two\r\nline three",
      String.fromCodePoint(0x1f9ea, 0x1f52c),
    ];
    for (const value of plain) expect(encodeBibTeXText(value)).toBe(value);
  });

  it("produces exactly one complete BibTeX field for any value", () => {
    for (const value of randomValues(0x5eed, 3000, 14)) {
      expect(isOneField(encodeBibTeXText(value)), JSON.stringify(value)).toBe(true);
    }
  });
});

// ── Text decoding ──

describe("decodeBibTeXText reads each token once, from the original input", () => {
  it("decodes every token the encoder writes", () => {
    expect(decodeBibTeXText(String.raw`a\textbackslash{}b`)).toBe(String.raw`a\b`);
    expect(decodeBibTeXText(String.raw`\&\%\$\#\_`)).toBe("&%$#_");
    expect(decodeBibTeXText(String.raw`\textasciitilde{} \textasciicircum{}`)).toBe("~ ^");
    expect(decodeBibTeXText(String.raw`\{x\} \textbraceleft{} \textbraceright{}`)).toBe("{x} { }");
  });

  it("does not decode a token a second time (CodeQL alert 7)", () => {
    // The old sequence first turned `\textbackslash{}` into `\`, then read that
    // `\` as the start of `\textasciitilde{}`.
    expect(decodeBibTeXText(String.raw`\textbackslash{}textasciitilde{}`)).toBe(String.raw`\textasciitilde{}`);
    expect(decodeBibTeXText(String.raw`\textbackslash{}textasciicircum{}`)).toBe(String.raw`\textasciicircum{}`);
    // Nor does an escape complete a token that was not there.
    expect(decodeBibTeXText(String.raw`\textbackslash{\}`)).toBe(String.raw`\textbackslash{}`);
  });

  it("reads the legacy \\textbackslash\\{\\} as one backslash", () => {
    // What every older Paperlume export contains for a backslash.
    expect(decodeBibTeXText(String.raw`C:\textbackslash\{\}data`)).toBe(String.raw`C:\data`);
    expect(decodeBibTeXText(String.raw`\textbackslash\{\}\{x\}`)).toBe(String.raw`\{x}`);
  });

  it("keeps a backslash that starts no token, and braces, as they are", () => {
    expect(decodeBibTeXText(String.raw`\alpha`)).toBe(String.raw`\alpha`);
    expect(decodeBibTeXText(String.raw`\textbackslash`)).toBe(String.raw`\textbackslash`);
    expect(decodeBibTeXText(String.raw`a\\b`)).toBe(String.raw`a\\b`);
    expect(decodeBibTeXText("The {HIV} Epidemic")).toBe("The {HIV} Epidemic");
  });

  it("decodes left to right, so decoded text never forms a new token", () => {
    // `\\vo`: the second backslash starts `\vo`, which decodes to `o`; the
    // first backslash and that `o` are not read again as `\o`.
    expect(decodeBibTeXText(String.raw`\\vo`)).toBe(String.raw`\o`);
    // `\o` ends where TeX ends it, before the brace.
    expect(decodeBibTeXText(String.raw`\o{\'x}`)).toBe(`${String.fromCodePoint(0xf8)}x`);
  });
});

describe("decodeBibTeXText keeps the supported LaTeX accents", () => {
  // [accent command character, letter, expected character]
  const ACCENTS: ReadonlyArray<readonly [string, string, string]> = [
    ["`", "a", "à"], ["'", "a", "á"], ["^", "a", "â"], ["~", "a", "ã"], ['"', "a", "ä"],
    ["`", "e", "è"], ["'", "e", "é"], ["^", "e", "ê"], ['"', "e", "ë"],
    ["`", "i", "ì"], ["'", "i", "í"], ["^", "i", "î"], ['"', "i", "ï"],
    ["`", "o", "ò"], ["'", "o", "ó"], ["^", "o", "ô"], ["~", "o", "õ"], ['"', "o", "ö"],
    ["`", "u", "ù"], ["'", "u", "ú"], ["^", "u", "û"], ['"', "u", "ü"],
    ["`", "A", "À"], ["'", "A", "Á"], ["^", "A", "Â"], ["~", "A", "Ã"], ['"', "A", "Ä"],
    ["`", "E", "È"], ["'", "E", "É"], ["^", "E", "Ê"], ['"', "E", "Ë"],
    ["`", "I", "Ì"], ["'", "I", "Í"], ["^", "I", "Î"], ['"', "I", "Ï"],
    ["`", "O", "Ò"], ["'", "O", "Ó"], ["^", "O", "Ô"], ["~", "O", "Õ"], ['"', "O", "Ö"],
    ["`", "U", "Ù"], ["'", "U", "Ú"], ["^", "U", "Û"], ['"', "U", "Ü"],
    ["'", "c", "ć"], ["'", "C", "Ć"], ["~", "n", "ñ"], ["~", "N", "Ñ"],
    ["c", "c", "ç"], ["c", "C", "Ç"],
    ["v", "s", "š"], ["v", "S", "Š"], ["v", "z", "ž"], ["v", "Z", "Ž"], ["v", "r", "ř"],
  ];

  for (const [accent, letter, expected] of ACCENTS) {
    const command = `${BS}${accent}`;
    it(`${command}${letter} → ${expected} in all four forms`, () => {
      expect(decodeBibTeXText(`x{${command}${letter}}y`)).toBe(`x${expected}y`);
      expect(decodeBibTeXText(`x{${command}{${letter}}}y`)).toBe(`x${expected}y`);
      expect(decodeBibTeXText(`x${command}{${letter}}y`)).toBe(`x${expected}y`);
      expect(decodeBibTeXText(`x ${command}${letter} y`)).toBe(`x ${expected} y`);
    });
  }

  it("decodes the letter commands, skipping the space TeX skips", () => {
    expect(decodeBibTeXText(String.raw`Stra\ss e`)).toBe("Straße");
    expect(decodeBibTeXText(String.raw`\AA{}ngstr\"om`)).toBe(String.raw`\AA{}ngström`);
    expect(decodeBibTeXText(String.raw`{\aa}`)).toBe("{å}");
    expect(decodeBibTeXText(String.raw`S\o ren \O{} \ae\ \AE`)).toBe(String.raw`Søren Ø{} æ\ Æ`);
  });

  it("keeps the letter of an accent the table does not know (unchanged behaviour)", () => {
    expect(decodeBibTeXText(String.raw`\'y`)).toBe("y");
  });

  it("decodes the authors of the established importer test", () => {
    expect(
      decodeBibTeXText(String.raw`Garc{\'i}a, Mar{\'i}a and M{\"u}ller, Hans and Gon{\c{c}}alves, Jo{\~a}o`),
    ).toBe("García, María and Müller, Hans and Gonçalves, João");
  });

  it("never takes the closing brace of an enclosing group as part of an accent", () => {
    // Before, `\'e}` and `{\"u}}` consumed one closing brace too many and left
    // the group unbalanced: `{Café Society`, `{Mü and more`.
    expect(decodeBibTeXText(String.raw`{Caf\'e} Society`)).toBe("{Café} Society");
    expect(decodeBibTeXText(String.raw`{M{\"u}} and more`)).toBe("{Mü} and more");
  });
});

describe("text encoding and decoding agree", () => {
  it("decodes every encoded value back to the stored value", () => {
    for (const value of randomValues(0xc0dec, 3000, 16)) {
      expect(decodeBibTeXText(encodeBibTeXText(value)), JSON.stringify(value)).toBe(value);
    }
  });

  it("is stable: re-encoding a decoded value gives the same bytes", () => {
    for (const value of randomValues(0x57ab1e, 1000, 16)) {
      const once = encodeBibTeXText(value);
      expect(encodeBibTeXText(decodeBibTeXText(once))).toBe(once);
    }
  });

  it("decodes a legacy export of any value whose braces balance", () => {
    // The old exporter's output, one character at a time. This map is the
    // old chain of replacements written out: its only cascade was escaping
    // the braces of its own `\textbackslash{}`.
    const LEGACY: Readonly<Record<string, string>> = {
      [BS]: String.raw`\textbackslash\{\}`, "&": String.raw`\&`, "%": String.raw`\%`,
      "$": String.raw`\$`, "#": String.raw`\#`, "_": String.raw`\_`, "{": String.raw`\{`,
      "}": String.raw`\}`, "~": String.raw`\textasciitilde{}`, "^": String.raw`\textasciicircum{}`,
    };
    const legacyEncode = (value: string) => {
      let out = "";
      for (const character of value) out += LEGACY[character] ?? character;
      return out;
    };
    const balanced = (value: string) => {
      let depth = 0;
      for (const character of value) {
        if (character === "{") depth++;
        else if (character === "}" && --depth < 0) return false;
      }
      return depth === 0;
    };

    let checked = 0;
    for (const value of randomValues(0x1e9ac7, 4000, 14).filter(balanced)) {
      expect(decodeBibTeXText(legacyEncode(value)), JSON.stringify(value)).toBe(value);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
    // The case the old decoder got wrong: literal LaTeX-looking text.
    expect(decodeBibTeXText(legacyEncode(String.raw`\textasciitilde{}`))).toBe(String.raw`\textasciitilde{}`);
  });
});

// ── Outer braces ──

describe("stripOuterBraces removes only a pair that encloses the whole value", () => {
  it("strips complete enclosing groups, outermost first", () => {
    expect(stripOuterBraces("{{Preserving Capitalisation}}")).toBe("Preserving Capitalisation");
    expect(stripOuterBraces("{The {HIV} Epidemic: A {Meta-Analysis}}")).toBe("The {HIV} Epidemic: A {Meta-Analysis}");
    expect(stripOuterBraces("  {a}  ")).toBe("a");
    expect(stripOuterBraces("{}")).toBe("");
    expect(stripOuterBraces("{{}}")).toBe("");
  });

  it("leaves two neighbouring groups alone", () => {
    expect(stripOuterBraces("{A} and {B}")).toBe("{A} and {B}");
    expect(stripOuterBraces("{HIV} and {AIDS} in {Africa}")).toBe("{HIV} and {AIDS} in {Africa}");
    expect(stripOuterBraces("{{a}{b}}")).toBe("{a}{b}");
    expect(stripOuterBraces(String.raw`{\'E}tude du {Caf\'e}`)).toBe(String.raw`{\'E}tude du {Caf\'e}`);
  });

  it("reads an escaped brace as a literal character, never as the group's end", () => {
    expect(stripOuterBraces(String.raw`{\}x\{}`)).toBe(String.raw`\}x\{`);
    // An older export of the title "a } b { c": its braces balance in number
    // but cross, and the enclosing pair is still the exporter's own.
    expect(stripOuterBraces(String.raw`{a \} b \{ c}`)).toBe(String.raw`a \} b \{ c`);
    expect(stripOuterBraces(String.raw`\{x\}`)).toBe(String.raw`\{x\}`);
  });

  it("leaves an unbalanced value alone", () => {
    expect(stripOuterBraces("{Smith")).toBe("{Smith");
    expect(stripOuterBraces("Jones}")).toBe("Jones}");
    expect(stripOuterBraces("{{a}")).toBe("{{a}");
    expect(stripOuterBraces("{a}}")).toBe("{a}}");
  });

  it("keeps braces inside the value", () => {
    expect(stripOuterBraces("x {a} y")).toBe("x {a} y");
  });
});

// ── Verbatim fields ──

describe("encodeBibTeXVerbatim writes DOIs and URLs as stored", () => {
  const RAW: readonly string[] = [
    "10.1056/NEJMoa2107934",
    "10.1000/456#789",
    "10.1000/foo/bar",
    "10.1002/(SICI)1097-4636(199706)35:4<487::AID-JBM9>3.0.CO;2-K",
    "10.1000/a{b}c",
    "10.1000/50%off_$x&y~z^w",
    String.raw`10.1000/a\b`,
    "https://doi.org/10.1000/456%23789",
    "https://doi.org/10.1000/foo%2Fbar",
    "https://pubmed.ncbi.nlm.nih.gov/12345678/",
    "https://journal.example.com/article?id=7&x=%20y#section-2",
    "https://example.com/search?q={x}#f{y}",
  ];

  for (const value of RAW) {
    it(`writes ${value} byte for byte`, () => {
      expect(encodeBibTeXVerbatim(value)).toBe(value);
      expect(decodeBibTeXVerbatim(stripOuterBraces(value)).trim()).toBe(value);
    });
  }

  it("does not LaTeX-escape or percent-encode anything", () => {
    const value = "https://example.com/a_b?c=50%25&d=#e";
    expect(encodeBibTeXVerbatim(value)).toBe(value);
    expect(encodeBibTeXVerbatim(value)).not.toContain(BS);
    expect(encodeBibTeXVerbatim(value)).not.toContain("%2525");
  });
});

describe("encodeBibTeXVerbatim encodes only a value that cannot be written raw", () => {
  const ENCODED: ReadonlyArray<readonly [string, string]> = [
    // Braces that do not balance would end the field early or run past it.
    ["10.1000/x}", String.raw`10.1000/x\textbraceright{}`],
    ["10.1000/x{", String.raw`10.1000/x\textbraceleft{}`],
    ["https://example.com/search?q=}", String.raw`https://example.com/search?q=\textbraceright{}`],
    ["https://example.com/search?q={", String.raw`https://example.com/search?q=\textbraceleft{}`],
    // A value wrapped in one pair would lose it to the importer's stripping.
    ["{10.1000/x}", String.raw`\textbraceleft{}10.1000/x\textbraceright{}`],
    // Text that would read back as a verbatim token. Every backslash and brace
    // is then written as a token, so the value decodes exactly.
    [
      String.raw`10.1000/a\textbraceleft{}b`,
      String.raw`10.1000/a\textbackslash{}textbraceleft\textbraceleft{}\textbraceright{}b`,
    ],
  ];

  for (const [value, expected] of ENCODED) {
    it(`encodes ${value}`, () => {
      const encoded = encodeBibTeXVerbatim(value);
      expect(encoded).toBe(expected);
      expect(isOneField(encoded)).toBe(true);
      expect(decodeBibTeXVerbatim(stripOuterBraces(encoded)).trim()).toBe(value);
    });
  }

  it("reads back any value, raw or encoded, as the trimmed stored value", () => {
    for (const value of randomValues(0xd01, 3000, 14)) {
      const encoded = encodeBibTeXVerbatim(value);
      expect(isOneField(encoded), JSON.stringify(value)).toBe(true);
      expect(decodeBibTeXVerbatim(stripOuterBraces(encoded)).trim(), JSON.stringify(value)).toBe(value.trim());
    }
  });

  it("reads only its own three tokens, so other backslash text is kept", () => {
    // A third-party file that escaped an underscore in its DOI field keeps the
    // escape, as before: verbatim fields are not LaTeX-decoded.
    expect(decodeBibTeXVerbatim(String.raw`10.1000/a\_b`)).toBe(String.raw`10.1000/a\_b`);
    expect(decodeBibTeXVerbatim(String.raw`\textasciitilde{}`)).toBe(String.raw`\textasciitilde{}`);
    expect(decodeBibTeXVerbatim(String.raw`\textbackslash\{\}`)).toBe(String.raw`\textbackslash\{\}`);
  });
});
