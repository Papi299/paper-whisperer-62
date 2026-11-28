// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeHTMLEntities } from "../htmlEntities";
import { xmlCharacterData, xmlElementContents } from "../xmlText";
import { CHARACTER_DATA_VECTORS, DECODER_NEUTRAL_VECTORS, ELEMENT_VECTORS } from "./fixtures/xmlTextVectors";
import { decodeHTMLEntities as clientDecode } from "../../../../src/lib/decodeHTMLEntities";

/**
 * The mixed-content lexer behind the Edge metadata text
 * (CODEQL-EDGE-TEXT-EXTRACTION-001). It replaces single-pass `<[^>]+>`
 * removals (CodeQL `js/incomplete-multi-character-sanitization`, alerts 2–5),
 * which lost text: a quoted `>` ended a tag early, CDATA was deleted, and a
 * stray `<` deleted everything up to the next `>`. Expected values are written
 * by hand from XML 1.0's grammar.
 */

describe("xmlCharacterData — the vector table", () => {
  it.each(CHARACTER_DATA_VECTORS)("$name", ({ input, expected, boundaries }) => {
    const options = boundaries ? { wordBoundaries: new Set(boundaries) } : {};
    expect(xmlCharacterData(input, options)).toBe(expected);
  });
});

describe("xmlCharacterData — references every decoder must read alike (001B)", () => {
  it.each(DECODER_NEUTRAL_VECTORS)("$name", ({ input, expected, boundaries }) => {
    const options = boundaries ? { wordBoundaries: new Set(boundaries) } : {};
    expect(xmlCharacterData(input, options)).toBe(expected);
  });

  // A reference on its own, so no pair can form. Each is rewritten, and both
  // decoders that read this output give for the rewritten spelling exactly
  // what they gave for the reference as written.
  const rewritten = [
    "&#0;", "&#00;", "&#x0;", "&#x0000;",
    "&#x110000;", "&#1114112;", "&#x0000110000;", "&#99999999999999999999;", `&#x${"F".repeat(64)};`, `&#${"9".repeat(64)};`,
    "&#xD800;", "&#xDBFF;", "&#xDC00;", "&#xDFFF;", "&#55296;", "&#57343;", "&#x0D835;",
    "&#38;", "&#038;", "&#x26;", "&#x0026;",
  ];
  it.each(rewritten)("%s is rewritten and decodes as before", (reference) => {
    const written = xmlCharacterData(reference);
    expect(written).not.toBe(reference);
    expect(decodeHTMLEntities(written)).toBe(decodeHTMLEntities(reference));
    expect(clientDecode(written)).toBe(clientDecode(reference));
  });

  // Not blind: every other reference is still copied exactly as written.
  const copied = [
    "&#x3B1;", "&#945;", "&#x0000041;", "&#00065;", "&#x1D400;", "&#128512;", "&#x10FFFF;", "&#1114111;",
    "&#1;", "&#x7F;", "&#x85;", "&#9;", "&#xFFFE;", "&#xFFFF;", "&#xD7FF;", "&#xE000;", "&#x25;", "&#x27;", "&#59;",
    "&amp;", "&lt;", "&gt;", "&quot;", "&apos;", "&nbsp;", "&alpha;", "&AMP;",
  ];
  it.each(copied)("%s is copied as written", (reference) => {
    expect(xmlCharacterData(`a${reference}b`)).toBe(`a${reference}b`);
  });
});

describe("xmlElementContents — the vector table", () => {
  it.each(ELEMENT_VECTORS)("$name", ({ xml, element, limit, expected }) => {
    expect(xmlElementContents(xml, element, limit)).toEqual(expected);
  });
});

describe("one decoding pass over the output gives the text", () => {
  // The text on the right is what each input means, stated independently.
  it.each([
    ["<i>p</i> &lt; 0.05", "p < 0.05"],
    ["<![CDATA[A &amp; B]]>", "A &amp; B"],
    ["<![CDATA[p < 0.05 & q > 0.1]]>", "p < 0.05 & q > 0.1"],
    ["AT&T <b>R&amp;D</b>", "AT&T R&D"],
    ["5 < x < 10", "5 < x < 10"],
    ["&amp;lt;b&amp;gt;", "&lt;b&gt;"],
    ["A &am<i>p; B</i>", "A &amp; B"],
    ["Use &lt;b&gt;bold&lt;/b&gt;", "Use <b>bold</b>"],
    ["invalid &#x110000;, &#0; and &#xD800; stay", "invalid &#x110000;, &#0; and &#xD800; stay"],
    ["AT&#x26;T &#x26;#60; &#38;amp;", "AT&T &#60; &amp;"],
    ["<![CDATA[&#x110000;]]> &amp;#x110000;", "&#x110000; &#x110000;"],
  ])("%s", (input, text) => {
    expect(decodeHTMLEntities(xmlCharacterData(input))).toBe(text);
  });
});

describe("markup is read on the source, before anything is decoded", () => {
  it("never removes markup that was written escaped", () => {
    const escaped = "&lt;i&gt;E. coli&lt;/i&gt; and &lt;script&gt;";
    expect(xmlCharacterData(escaped)).toBe(escaped);
    expect(decodeHTMLEntities(xmlCharacterData(escaped))).toBe("<i>E. coli</i> and <script>");
  });

  it("keeps a CDATA section's text when it looks like markup", () => {
    expect(decodeHTMLEntities(xmlCharacterData("<![CDATA[<i>x</i>]]>"))).toBe("<i>x</i>");
  });
});

describe("long, valid scientific text", () => {
  it("reads a 200,000-character structured passage exactly", () => {
    const sentence = "In <i>E. coli</i>, CO<sub>2</sub> fell (p &lt; 0.05; 95% CI 0.2 to 0.6) &amp; rose. ";
    const text = "In E. coli, CO2 fell (p &lt; 0.05; 95% CI 0.2 to 0.6) &amp; rose. ";
    const repeats = Math.ceil(200_000 / sentence.length);
    expect(xmlCharacterData(sentence.repeat(repeats))).toBe(text.repeat(repeats));
  });

  it("reads many nested inline elements", () => {
    const depth = 5_000;
    const nested = "<b>".repeat(depth) + "core" + "</b>".repeat(depth);
    expect(xmlCharacterData(nested)).toBe("core");
  });
});

/**
 * A string stand-in that counts the characters the lexer examines. Every
 * string operation the lexer uses is counted, including the characters an
 * `indexOf` scans, so the bound below is about work, not wall-clock time.
 */
function counting(text: string): { source: string; examined: () => number } {
  let examined = 0;
  const counted = {
    get length() {
      return text.length;
    },
    charCodeAt(index: number) {
      examined += 1;
      return text.charCodeAt(index);
    },
    codePointAt(index: number) {
      examined += 1;
      return text.codePointAt(index);
    },
    startsWith(search: string, position?: number) {
      examined += search.length;
      return text.startsWith(search, position);
    },
    indexOf(search: string, position = 0) {
      const at = text.indexOf(search, position);
      examined += Math.max(0, (at === -1 ? text.length : at + search.length) - position);
      return at;
    },
    slice(start?: number, end?: number) {
      const part = text.slice(start, end);
      examined += part.length;
      return part;
    },
  };
  return { source: counted as unknown as string, examined: () => examined };
}

describe("bounded work on hostile input", () => {
  // Each workload is built at two sizes. The lexer must examine at most a
  // constant number of characters per input character, and doubling the input
  // may at most double the work. A rescan per construct fails both.
  const workloads: [string, (n: number) => string][] = [
    ["unterminated comments", (n) => "<!--".repeat(n)],
    ["unterminated CDATA", (n) => "<![CDATA[".repeat(n)],
    ["unterminated processing instructions", (n) => "<?pi ".repeat(n)],
    ["unterminated attribute values", (n) => '<a b="'.repeat(n)],
    ["unclosed start tags with attributes", (n) => '<a b="x" c=\'y\' '.repeat(n)],
    ["bare angle brackets", (n) => "<".repeat(n)],
    ["names that never close", (n) => "<a".repeat(n)],
    ["end tags that never close", (n) => "</a ".repeat(n)],
    ["incomplete character references", (n) => "&#".repeat(n)],
    ["long incomplete references", (n) => ("&#" + "9".repeat(40)).repeat(n)],
    ["incomplete entity references", (n) => "&amp".repeat(n)],
    ["valid markup and references", (n) => "<i>a</i>&amp;<![CDATA[<]]><!--c-->".repeat(n)],
    ["one comment terminator at the very end", (n) => "<!--".repeat(n) + "-->"],
  ];

  it.each(workloads)("%s", (_name, build) => {
    const small = build(4_000);
    const large = build(8_000);
    const runSmall = counting(small);
    const runLarge = counting(large);
    xmlCharacterData(runSmall.source, { wordBoundaries: new Set(["p"]) });
    xmlCharacterData(runLarge.source, { wordBoundaries: new Set(["p"]) });
    expect(runSmall.examined()).toBeLessThanOrEqual(12 * small.length);
    expect(runLarge.examined()).toBeLessThanOrEqual(12 * large.length);
    expect(runLarge.examined()).toBeLessThanOrEqual(2.1 * runSmall.examined());
  });

  it.each(workloads)("locating elements: %s", (_name, build) => {
    const small = build(4_000);
    const large = build(8_000);
    const runSmall = counting(small);
    const runLarge = counting(large);
    xmlElementContents(runSmall.source, "a");
    xmlElementContents(runLarge.source, "a");
    expect(runSmall.examined()).toBeLessThanOrEqual(12 * small.length);
    expect(runLarge.examined()).toBeLessThanOrEqual(12 * large.length);
    expect(runLarge.examined()).toBeLessThanOrEqual(2.1 * runSmall.examined());
  });

  // CODEQL-EDGE-TEXT-EXTRACTION-001B: complete character references whose
  // value is read again to decide how they are written, and high surrogates
  // whose spelling is settled one reference later.
  const referenceWorkloads: [string, (n: number) => string][] = [
    ["references above U+10FFFF", (n) => "&#x110000;".repeat(n)],
    ["long complete references", (n) => ("&#" + "9".repeat(40) + ";").repeat(n)],
    ["long leading zeros", (n) => ("&#x" + "0".repeat(40) + "41;").repeat(n)],
    ["references to U+0000", (n) => "&#0;".repeat(n)],
    ["references to &", (n) => "&#x26;#1114112;".repeat(n)],
    ["high surrogates only", (n) => "&#xD835;".repeat(n)],
    ["low surrogates only", (n) => "&#xDC00;".repeat(n)],
    ["surrogate pairs", (n) => "&#xD835;&#xDC00;".repeat(n)],
    ["high surrogates across removed markup", (n) => "&#xD835;<i></i>".repeat(n)],
    ["pairs across word boundaries", (n) => "<p>&#xD835;</p><p>&#xDC00;</p>".repeat(n)],
  ];

  it.each(referenceWorkloads)("references: %s", (_name, build) => {
    const small = build(4_000);
    const large = build(8_000);
    const runSmall = counting(small);
    const runLarge = counting(large);
    xmlCharacterData(runSmall.source, { wordBoundaries: new Set(["p"]) });
    xmlCharacterData(runLarge.source, { wordBoundaries: new Set(["p"]) });
    expect(runSmall.examined()).toBeLessThanOrEqual(12 * small.length);
    expect(runLarge.examined()).toBeLessThanOrEqual(12 * large.length);
    expect(runLarge.examined()).toBeLessThanOrEqual(2.1 * runSmall.examined());
  });

  it("reads a long reference's value no further than U+10FFFF", () => {
    // `referenceEnd` reads every digit once to find the `;`. Deciding how the
    // reference is written reads its value again, and stops after 7 decimal or
    // 6 hexadecimal digits, the first value above U+10FFFF; checking for the
    // `x` reads the first position twice more. Reading every digit again would
    // cost another 100,000.
    const digits = 100_000;
    for (const [reference, firstDigit] of [
      [`&#${"9".repeat(digits)};`, 2],
      [`&#x${"F".repeat(digits)};`, 3],
    ] as const) {
      const reads = new Array<number>(reference.length).fill(0);
      const source = {
        get length() {
          return reference.length;
        },
        charCodeAt(index: number) {
          reads[index] += 1;
          return reference.charCodeAt(index);
        },
        codePointAt: (index: number) => reference.codePointAt(index),
        startsWith: (search: string, position?: number) => reference.startsWith(search, position),
        indexOf: (search: string, position?: number) => reference.indexOf(search, position),
        slice: (start?: number, end?: number) => reference.slice(start, end),
      } as unknown as string;
      expect(xmlCharacterData(source)).toBe(`&amp;${reference.slice(1)}`);
      const digitReads = reads.slice(firstDigit, firstDigit + digits).reduce((sum, n) => sum + n, 0);
      expect(digitReads).toBeLessThanOrEqual(digits + 10);
    }
  });

  it("locates elements in a document full of unclosed start tags", () => {
    const hostile = "<AbstractText>".repeat(100_000);
    const run = counting(hostile);
    expect(xmlElementContents(run.source, "AbstractText")).toEqual([]);
    expect(run.examined()).toBeLessThanOrEqual(12 * hostile.length);
  });
});
