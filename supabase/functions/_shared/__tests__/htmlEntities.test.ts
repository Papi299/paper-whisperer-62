// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeHTMLEntities } from "../htmlEntities";
import { extractPubMedArticleDoi } from "../pubmedArticleIdentifiers";
import { articleId, efetchDocument, pubmedArticle } from "./fixtures/pubmedEfetchXml";
import { DECODE_VECTORS } from "./fixtures/xmlTextVectors";

/**
 * The Edge decoder for provider text (CODEQL-EDGE-TEXT-EXTRACTION-001).
 *
 * Two defects motivate this suite. The previous decoder ran seven replacements
 * in sequence, so `&amp;lt;` became `<` (CodeQL `js/double-escaping`, alert 8);
 * and it passed every numeric reference to `String.fromCodePoint`, which
 * decodes NUL and lone surrogates and throws above U+10FFFF — losing the whole
 * PubMed record. Expected values are written from XML 1.0, not computed.
 */

const isXmlChar = (cp: number): boolean =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff);

describe("decodeHTMLEntities — the vector table", () => {
  it.each(DECODE_VECTORS)("$name", ({ input, expected }) => {
    expect(decodeHTMLEntities(input)).toBe(expected);
  });
});

describe("decodeHTMLEntities — each reference is read once", () => {
  it("decodes one level per call", () => {
    const once = decodeHTMLEntities("&amp;amp;lt;");
    expect(once).toBe("&amp;lt;");
    expect(decodeHTMLEntities(once)).toBe("&lt;");
    expect(decodeHTMLEntities(decodeHTMLEntities(once))).toBe("<");
  });

  it("never reads what an ampersand reference produced as part of the next reference", () => {
    const references = ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;", "&#60;", "&#x3C;", "&#38;", "&#x26;"];
    for (const ampersand of ["&amp;", "&#38;", "&#x26;", "&#0038;", "&#x0026;"]) {
      for (const reference of references) {
        // "&" written as a reference, followed by the rest of another reference.
        expect(decodeHTMLEntities(ampersand + reference.slice(1))).toBe(reference);
      }
    }
  });

  it("never reads a decoded '<' as the start of anything", () => {
    expect(decodeHTMLEntities("&#60;&#33;--x--&#62;")).toBe("<!--x-->");
    expect(decodeHTMLEntities("&lt;![CDATA[&amp;]]&gt;")).toBe("<![CDATA[&]]>");
  });
});

describe("decodeHTMLEntities — values that are not XML characters", () => {
  const values = [
    0, 1, 8, 9, 10, 11, 12, 13, 14, 0x1f, 0x20, 0x7f, 0x85, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000,
    0xfdd0, 0xfffd, 0xfffe, 0xffff, 0x10000, 0x1fffe, 0x10fffd, 0x10ffff, 0x110000, 0x7fffffff, 2 ** 32, 2 ** 53, 1e21,
  ];

  it.each(values)("decimal and hexadecimal %s decode only when the value is a Char", (value) => {
    const decimal = `&#${BigInt(value).toString(10)};`;
    const hex = `&#x${BigInt(value).toString(16)};`;
    const expected = (reference: string) => (isXmlChar(value) ? String.fromCodePoint(value) : reference);
    expect(decodeHTMLEntities(decimal)).toBe(expected(decimal));
    expect(decodeHTMLEntities(hex)).toBe(expected(hex));
    expect(decodeHTMLEntities(`[${decimal}|${hex}]`)).toBe(`[${expected(decimal)}|${expected(hex)}]`);
  });

  it("never throws, and leaves the rest of the text decoded", () => {
    const text = "A &amp; B &#x110000; C &lt; D &#99999999999999999999999999; E &#xD800; F &#0; G &#x3B1;";
    expect(() => decodeHTMLEntities(text)).not.toThrow();
    expect(decodeHTMLEntities(text)).toBe(
      "A & B &#x110000; C < D &#99999999999999999999999999; E &#xD800; F &#0; G " + String.fromCodePoint(0x3b1),
    );
  });

  it("reads a long digit run without growing a value: leading zeros still decode", () => {
    const zeros = "0".repeat(1_000_000);
    expect(decodeHTMLEntities(`&#${zeros}65;`)).toBe("A");
    expect(decodeHTMLEntities(`&#x${zeros}41;`)).toBe("A");
  });

  it("leaves a long run of significant digits as written", () => {
    const nines = `&#${"9".repeat(1_000_000)};`;
    expect(decodeHTMLEntities(nines)).toBe(nines);
    const hex = `&#x${"F".repeat(1_000_000)};`;
    expect(decodeHTMLEntities(hex)).toBe(hex);
  });

  it("is bounded on many repeated malformed references", () => {
    const repeated = "&#x110000;&#;&amp&#".repeat(50_000);
    expect(decodeHTMLEntities(repeated)).toBe(repeated);
  });
});

describe("the article DOI, read through the shared decoder", () => {
  // `pubmedArticleIdentifiers.ts` is unchanged; it decodes each DOI value with
  // this decoder, so the decoder's contract reaches the DOI. Its own suite
  // still covers its selection rules.
  const own = (value: string) =>
    extractPubMedArticleDoi(efetchDocument(pubmedArticle({ ownIds: [articleId("doi", value)] })));

  it("keeps every existing decoding of a DOI", () => {
    expect(own("10.1000/a&amp;b")).toBe("10.1000/a&b");
    expect(own("10.1002/(SICI)1097-4636(199706)35:4&lt;425::AID-JBM4&gt;3.0.CO;2-H")).toBe(
      "10.1002/(SICI)1097-4636(199706)35:4<425::AID-JBM4>3.0.CO;2-H",
    );
    expect(own("10.1000/a&#38;b")).toBe("10.1000/a&b");
    expect(own("10.1000/a&amp;amp;b")).toBe("10.1000/a&amp;b");
  });

  it("no longer turns an escaped &lt; into a different DOI name", () => {
    // The DOI name stated is `10.1000/a&lt;b`; the old decoder made it `10.1000/a<b`.
    expect(own("10.1000/a&amp;lt;b")).toBe("10.1000/a&lt;b");
  });

  it("keeps a reference to a non-character as text instead of failing", () => {
    // The old decoder threw RangeError here, which lost the whole record.
    expect(own("10.1000/q2&#x110000;")).toBe("10.1000/q2&#x110000;");
    expect(own("10.1000/q2&#0;")).toBe("10.1000/q2&#0;");
    // The well-formed, doubly escaped spelling already produced this text.
    expect(own("10.1000/q2&amp;#x110000;")).toBe("10.1000/q2&#x110000;");
  });
});
