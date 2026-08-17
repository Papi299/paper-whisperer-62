import { describe, it, expect } from "vitest";
import {
  authorMentionKey,
  authorSearchMatches,
  indexAuthorMentions,
  normalizeAuthorDisplay,
} from "../authorNames";

/**
 * AUTHOR-NAME-CANONICALIZATION-001A — the author-mention comparison contract.
 *
 * The load-bearing distinction under test: a canonical key may decide that two
 * textual mentions are *formatting*-equivalent, and must never decide that two
 * ambiguous mentions are the same human. Everything in the "must not collapse"
 * block below is a pair that a person-identity system might one day resolve and
 * that this module deliberately does not.
 *
 * Unicode variants are written as `\u` escapes on purpose: a precomposed and a
 * decomposed `José` are indistinguishable in an editor, and a test whose
 * inputs cannot be read is not a test.
 */

const E_ACUTE = "é"; // precomposed e-acute
const I_ACUTE = "í"; // precomposed i-acute
const COMBINING_ACUTE = "́";
const A_RING = "Å"; // LATIN CAPITAL LETTER A WITH RING ABOVE
const ANGSTROM = "Å"; // ANGSTROM SIGN — NFC-folds to A_RING
const RIGHT_QUOTE = "’";
const LEFT_QUOTE = "‘";
const EN_DASH = "–";
const EM_DASH = "—";
const UNICODE_HYPHEN = "‐"; // HYPHEN, not ASCII hyphen-minus
const DOTLESS_I = "ı"; // Turkish dotless i
const THIN_SPACE = " ";

/**
 * LATIN CAPITAL LETTER I WITH DOT ABOVE: one code point that lowercases to
 * TWO (`i` + COMBINING DOT ABOVE). This is the letter that makes classifying a
 * standalone initial *after* case folding wrong.
 */
const DOTTED_I = "İ";

/** `Jos<e-acute> Garc<i-acute>a` precomposed, and its decomposed twin. */
const JOSE_COMPOSED = `Jos${E_ACUTE} Garc${I_ACUTE}a`;
const JOSE_DECOMPOSED = `Jose${COMBINING_ACUTE} Garci${COMBINING_ACUTE}a`;

/** `<dotted-I> Y<dotless-i>lmaz`, without and with the initial's period. */
const YILMAZ = `${DOTTED_I} Y${DOTLESS_I}lmaz`;
const YILMAZ_PERIOD = `${DOTTED_I}. Y${DOTLESS_I}lmaz`;

/** Both directions of "these are one mention", stated once. */
function expectSameKey(a: string, b: string) {
  expect(authorMentionKey(a)).toBe(authorMentionKey(b));
  expect(authorMentionKey(a)).not.toBe("");
}

function expectDifferentKey(a: string, b: string) {
  expect(authorMentionKey(a)).not.toBe(authorMentionKey(b));
}

describe("normalizeAuthorDisplay", () => {
  it("decodes HTML entities", () => {
    expect(normalizeAuthorDisplay("Smith &amp; Jones")).toBe("Smith & Jones");
    expect(normalizeAuthorDisplay("Smith&#x2009;J")).toBe("Smith J");
  });

  it("collapses whitespace runs and trims", () => {
    expect(normalizeAuthorDisplay("  Stuart   M \t Phillips \n ")).toBe(
      "Stuart M Phillips",
    );
    expect(normalizeAuthorDisplay(`Smith${THIN_SPACE}J`)).toBe("Smith J");
  });

  it("treats a decoded non-breaking space as whitespace", () => {
    expect(normalizeAuthorDisplay("Stuart&nbsp;M&nbsp;Phillips")).toBe(
      "Stuart M Phillips",
    );
  });

  it("applies canonical (NFC) composition without stripping accents", () => {
    expect(normalizeAuthorDisplay(JOSE_DECOMPOSED)).toBe(JOSE_COMPOSED);
    expect(normalizeAuthorDisplay(`${ANGSTROM}kesson`)).toBe(`${A_RING}kesson`);
  });

  it("preserves casing, initials, periods, punctuation and script", () => {
    expect(normalizeAuthorDisplay("Stuart M. Phillips")).toBe("Stuart M. Phillips");
    expect(normalizeAuthorDisplay(`O${RIGHT_QUOTE}Connor`)).toBe(
      `O${RIGHT_QUOTE}Connor`,
    );
    expect(normalizeAuthorDisplay(`Jean${EN_DASH}Pierre Martin`)).toBe(
      `Jean${EN_DASH}Pierre Martin`,
    );
    expect(normalizeAuthorDisplay("STUART M PHILLIPS")).toBe("STUART M PHILLIPS");
    expect(normalizeAuthorDisplay("Иван")).toBe(
      "Иван",
    );
    expect(normalizeAuthorDisplay("山田 太郎")).toBe(
      "山田 太郎",
    );
  });

  it("returns an empty string for absent or blank input", () => {
    expect(normalizeAuthorDisplay(null)).toBe("");
    expect(normalizeAuthorDisplay(undefined)).toBe("");
    expect(normalizeAuthorDisplay("")).toBe("");
    expect(normalizeAuthorDisplay("   ")).toBe("");
    expect(normalizeAuthorDisplay("\t\n ")).toBe("");
    expect(normalizeAuthorDisplay("&nbsp;")).toBe("");
  });
});

describe("authorMentionKey — formatting equivalences that MUST collapse", () => {
  it("collapses whitespace differences", () => {
    expectSameKey("Stuart M Phillips", " Stuart M Phillips ");
    expectSameKey("Stuart M Phillips", "Stuart  M   Phillips");
    expectSameKey("Stuart M Phillips", "Stuart\tM\tPhillips");
    expectSameKey("Stuart M Phillips", "Stuart\nM Phillips");
  });

  it("collapses case differences", () => {
    expectSameKey("Stuart M Phillips", "STUART M PHILLIPS");
    expectSameKey("Stuart M Phillips", "stuart m phillips");
  });

  it("collapses a period on a standalone one-letter initial", () => {
    expectSameKey("Stuart M. Phillips", "Stuart M Phillips");
    expectSameKey("John A. Smith", "John A Smith");
    expectSameKey("J. Smith", "J Smith");
  });

  it("combines case and standalone-initial folding", () => {
    const keys = [
      "Stuart M Phillips",
      " Stuart  M   Phillips ",
      "STUART M PHILLIPS",
      "Stuart M. Phillips",
      "stuart m. phillips",
    ].map(authorMentionKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("uses Unicode letters, not ASCII, for the standalone-initial test", () => {
    // Cyrillic Yu, then Greek Theta.
    expectSameKey("Ю. Петров", "Ю Петров");
    expectSameKey("Θ. Παπας", "Θ Παπας");
  });

  /**
   * The one-letter test has to be made on the display form, before comparison
   * folding, because lowercasing can expand a single letter into several code
   * points: `İ` becomes `i` + COMBINING DOT ABOVE. An implementation that folds
   * first stops seeing one letter and leaves the period attached, so the two
   * spellings of the same initial split into two author mentions.
   */
  it("collapses the initial period for a letter whose case folding expands", () => {
    expect([...DOTTED_I]).toHaveLength(1);
    expect([...DOTTED_I.toLowerCase()]).toHaveLength(2);

    expectSameKey(YILMAZ_PERIOD, YILMAZ);
    expectSameKey(`${DOTTED_I}.`, DOTTED_I);
  });

  /**
   * The same ordering argument for the other direction: a decomposed accented
   * initial is two code points until NFC composes it, so canonical
   * normalization must also precede the one-letter test.
   */
  it("collapses the initial period for a decomposed accented initial", () => {
    expectSameKey(`E${COMBINING_ACUTE}. Dupont`, `E${COMBINING_ACUTE} Dupont`);
  });

  it("collapses canonically equivalent Unicode forms", () => {
    expectSameKey(JOSE_COMPOSED, JOSE_DECOMPOSED);
    expectSameKey(`${ANGSTROM}kesson`, `${A_RING}kesson`);
  });

  it("collapses the Greek sigma family regardless of word position", () => {
    // Omicron + sigma: uppercase, medial-lowercase, final-lowercase.
    const keys = ["ΟΣ", "οσ", "ος"].map(authorMentionKey);
    expect(new Set(keys).size).toBe(1);
    expectSameKey("ΟΣΑ", "οσα");
  });

  it("collapses typographic apostrophe glyphs", () => {
    expectSameKey("O'Connor", `O${RIGHT_QUOTE}Connor`);
    expectSameKey("O'Connor", `O${LEFT_QUOTE}Connor`);
  });

  it("collapses typographic dash glyphs between the same components", () => {
    expectSameKey("Jean-Pierre Martin", `Jean${EN_DASH}Pierre Martin`);
    expectSameKey("Jean-Pierre Martin", `Jean${EM_DASH}Pierre Martin`);
    expectSameKey("Ann-Marie Lee", `Ann${UNICODE_HYPHEN}Marie Lee`);
  });

  it("compares HTML-encoded and decoded forms consistently", () => {
    expectSameKey("Smith &amp; Jones", "Smith & Jones");
    expectSameKey("Smith&#x2009;J", "Smith J");
  });
});

describe("authorMentionKey — ambiguities that MUST NOT collapse", () => {
  it("does not expand initials into full given names", () => {
    expectDifferentKey("S M Phillips", "Stuart M Phillips");
    expectDifferentKey("S. M. Phillips", "Stuart M Phillips");
  });

  it("does not infer omitted middle components", () => {
    expectDifferentKey("Stuart Phillips", "Stuart M Phillips");
  });

  it("does not invert comma name order", () => {
    expectDifferentKey("Phillips, Stuart M", "Stuart M Phillips");
    expectDifferentKey("Phillips, S M", "S M Phillips");
  });

  it("does not treat multi-character abbreviations as initials", () => {
    expectDifferentKey("St. John", "St John");
    expectDifferentKey("Jr. Smith", "Jr Smith");
  });

  it("keeps attached initial clusters distinct from spaced initials", () => {
    expectDifferentKey("J.R.R. Tolkien", "J R R Tolkien");
  });

  it("does not strip diacritics", () => {
    expectDifferentKey(`Jos${E_ACUTE} Garcia`, "Jose Garcia");
    expectDifferentKey(JOSE_COMPOSED, "Jose Garcia");
    expectDifferentKey("Müller", "Muller");
  });

  it("does not delete apostrophes", () => {
    expectDifferentKey("O'Connor", "OConnor");
    expectDifferentKey(`O${RIGHT_QUOTE}Connor`, "OConnor");
  });

  it("does not treat a hyphen as a space", () => {
    expectDifferentKey("Jean-Pierre Martin", "Jean Pierre Martin");
    expectDifferentKey("Ann-Marie Lee", "Ann Marie Lee");
    expectDifferentKey(`Jean${EN_DASH}Pierre Martin`, "Jean Pierre Martin");
  });

  it("preserves generational suffixes", () => {
    const keys = ["John Smith", "John Smith Jr.", "John Smith III"].map(
      authorMentionKey,
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("preserves particles and multi-token surnames", () => {
    expectDifferentKey("Ludwig van Beethoven", "Ludwig Beethoven");
    expectDifferentKey("Juan de la Cruz", "Juan Cruz");
    expectDifferentKey(
      `Mar${I_ACUTE}a del Carmen Garc${I_ACUTE}a`,
      `Mar${I_ACUTE}a Garc${I_ACUTE}a`,
    );
  });

  it("does not transliterate non-Latin scripts", () => {
    // Cyrillic, Greek, Japanese, Arabic, Hebrew.
    expectDifferentKey("Иван Петров", "Ivan Petrov");
    expectDifferentKey("Γεώργιος", "Georgios");
    expectDifferentKey("山田 太郎", "Taro Yamada");
    expectDifferentKey("محمد", "Muhammad");
    expectDifferentKey("דוד לוי", "David Levi");
  });

  it("does not apply locale-specific identity transformations", () => {
    // Turkish dotless i is a different letter, not a case variant of `i`.
    expect(authorMentionKey(DOTLESS_I)).not.toBe(authorMentionKey("i"));
    expectDifferentKey(`Ayd${DOTLESS_I}n`, "Aydin");
  });

  /**
   * Removing the period from `İ.` is a formatting fold and nothing more. The
   * dotted capital, the ordinary `I`/`i` and the dotless `ı` remain three
   * different letters, so only the period distinguishes the pair above.
   */
  it("does not equate a dotted capital I with ordinary or dotless i", () => {
    expectDifferentKey(YILMAZ, `I Y${DOTLESS_I}lmaz`);
    expectDifferentKey(YILMAZ_PERIOD, `I. Y${DOTLESS_I}lmaz`);
    expectDifferentKey(YILMAZ, `${DOTLESS_I} Y${DOTLESS_I}lmaz`);
  });

  it("does not equate unrelated Greek spellings", () => {
    expectDifferentKey("ΟΣ", "ΟΖ");
    expectDifferentKey("ΟΣ", "ΟΣΑ");
  });
});

describe("authorMentionKey — collective authors", () => {
  const collective = "GBD 2023 IHD & Dietary Risk Factors Collaborators";

  it("keeps a collective author as one unparsed mention", () => {
    expect(authorMentionKey(collective)).toBe(
      "gbd 2023 ihd & dietary risk factors collaborators",
    );
  });

  it("applies the same harmless formatting folds to collective authors", () => {
    expectSameKey(
      collective,
      "GBD 2023 IHD &amp;  Dietary Risk Factors  Collaborators",
    );
    expectSameKey(collective, collective.toUpperCase());
  });

  it("does not merge different collaborator groups", () => {
    expectDifferentKey(
      collective,
      "GBD 2021 IHD & Dietary Risk Factors Collaborators",
    );
  });
});

describe("authorMentionKey — empty and pathological input", () => {
  it("produces no usable key for absent or blank mentions", () => {
    for (const value of [null, undefined, "", "   ", "\t\n", " ", "&nbsp;"]) {
      expect(authorMentionKey(value)).toBe("");
    }
  });

  it("handles punctuation-only strings without throwing", () => {
    expect(() => authorMentionKey("...")).not.toThrow();
    expect(authorMentionKey("...")).toBe("...");
    expectDifferentKey("...", "-");
  });

  it("handles astral-plane characters without splitting surrogate pairs", () => {
    // MATHEMATICAL BOLD CAPITAL J.
    const astral = "\u{1D409}ohn Smith";
    expect(authorMentionKey(astral)).toBe(authorMentionKey(`  \u{1D409}ohn   Smith  `));
    expect(authorMentionKey(astral)).not.toBe(authorMentionKey("John Smith"));
  });

  it("handles a long collective author string in linear time", () => {
    const long = `${"Collaborative Research Consortium ".repeat(200)}Group`;
    const start = Date.now();
    expect(authorMentionKey(long)).toBe(authorMentionKey(long.toUpperCase()));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("indexAuthorMentions", () => {
  it("returns one entry per canonical key with a source-derived label", () => {
    const entries = indexAuthorMentions([
      ["Stuart M. Phillips", "S M Phillips"],
      ["Stuart M Phillips", "Stuart Phillips"],
      ["STUART M PHILLIPS"],
    ]);

    expect(entries.map((e) => e.label)).toEqual([
      "Stuart M. Phillips",
      "S M Phillips",
      "Stuart Phillips",
    ]);
  });

  it("uses the first non-empty mention encountered as the representative", () => {
    const periodFirst = indexAuthorMentions([
      ["Stuart M. Phillips"],
      ["Stuart M Phillips"],
    ]);
    expect(periodFirst[0].label).toBe("Stuart M. Phillips");

    const plainFirst = indexAuthorMentions([
      ["Stuart M Phillips"],
      ["Stuart M. Phillips"],
    ]);
    expect(plainFirst[0].label).toBe("Stuart M Phillips");
  });

  it("normalizes whitespace in the representative label", () => {
    const [entry] = indexAuthorMentions([["  Stuart   M.  Phillips "]]);
    expect(entry.label).toBe("Stuart M. Phillips");
  });

  it("counts each document at most once per canonical key", () => {
    const entries = indexAuthorMentions([
      ["Stuart M Phillips", "Stuart M. Phillips"],
      ["stuart m phillips"],
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].documentCount).toBe(2);
  });

  it("counts documents per key independently", () => {
    const entries = indexAuthorMentions([
      ["Stuart M. Phillips", "S M Phillips"],
      ["Stuart M Phillips"],
      ["Stuart Phillips"],
    ]);
    const byLabel = Object.fromEntries(
      entries.map((e) => [e.label, e.documentCount]),
    );
    expect(byLabel).toEqual({
      "Stuart M. Phillips": 2,
      "S M Phillips": 1,
      "Stuart Phillips": 1,
    });
  });

  it("skips empty, blank and absent mention lists", () => {
    const entries = indexAuthorMentions([
      ["", "   ", "Stuart M Phillips"],
      null,
      undefined,
      [],
      ["\t\n"],
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("Stuart M Phillips");
    expect(entries[0].documentCount).toBe(1);
  });

  it("groups canonically equivalent Unicode forms under one source spelling", () => {
    const entries = indexAuthorMentions([
      [JOSE_COMPOSED],
      [JOSE_DECOMPOSED],
      ["Jose Garcia"],
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0].label).toBe(JOSE_COMPOSED);
    expect(entries[0].documentCount).toBe(2);
    expect(entries[1].label).toBe("Jose Garcia");
  });
});

describe("authorSearchMatches", () => {
  it("finds a grouped author by a formatting-equivalent spelling", () => {
    expect(authorSearchMatches("Stuart M Phillips", "Stuart M. Phillips")).toBe(true);
    expect(authorSearchMatches("Stuart M. Phillips", "stuart m phillips")).toBe(true);
    expect(authorSearchMatches("Stuart M. Phillips", "  STUART   M PHILLIPS ")).toBe(
      true,
    );
  });

  it("finds an expanding-case initial typed with either spelling", () => {
    expect(authorSearchMatches(YILMAZ, YILMAZ_PERIOD)).toBe(true);
    expect(authorSearchMatches(YILMAZ_PERIOD, YILMAZ)).toBe(true);
  });

  it("still matches on a prefix or fragment", () => {
    expect(authorSearchMatches("Stuart M. Phillips", "stu")).toBe(true);
    expect(authorSearchMatches("Stuart M. Phillips", "phillips")).toBe(true);
    expect(authorSearchMatches("Stuart M. Phillips", "Stuart M")).toBe(true);
  });

  it("matches everything for a blank query", () => {
    expect(authorSearchMatches("Stuart M. Phillips", "")).toBe(true);
    expect(authorSearchMatches("Stuart M. Phillips", "   ")).toBe(true);
  });

  it("does not match an unrelated or accent-stripped query", () => {
    expect(authorSearchMatches("Stuart M. Phillips", "Nolan")).toBe(false);
    expect(authorSearchMatches(JOSE_COMPOSED, "Jose Garcia")).toBe(false);
  });
});
