// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeHTMLEntities } from "../decodeHTMLEntities";
import {
  C,
  DECODED_EDGE_VALUE_VECTORS,
  FRAGMENTS,
  INVALID_REFERENCES,
  isClientDecodable,
  NBSP,
  ONE_PASS_VECTORS,
  ORDINARY_VECTORS,
  PRESERVED_VECTORS,
  SCIENTIFIC_VECTORS,
  specDecode,
  UNDECODED_NUMERIC_VECTORS,
  VALID_REFERENCES,
} from "./fixtures/clientEntitySpec";

/**
 * The client entity decoder (PAPERLUME-CODEQL-EDGE-TEXT-EXTRACTION-001A).
 *
 * The previous implementation ran eight replacements in sequence, so text one
 * of them produced was decoded again by the next (`&amp;lt;` became `<`, CodeQL
 * `js/double-escaping`, alert 6), and it returned the whole field undecoded
 * when one reference was above U+10FFFF. Since the Edge Function now returns
 * the PubMed title and abstract and the Crossref abstract as escaped character
 * data, both defects reach stored text. Expected values come from
 * `fixtures/clientEntitySpec.ts`, which imports nothing from the decoder.
 */

const decode = (text: string): string => decodeHTMLEntities(text) as string;

describe("decodeHTMLEntities — null, undefined and empty input", () => {
  it("returns each as given, as it always has", () => {
    expect(decodeHTMLEntities(null)).toBeNull();
    expect(decodeHTMLEntities(undefined)).toBeUndefined();
    expect(decodeHTMLEntities("")).toBe("");
  });
});

describe("decodeHTMLEntities — the references it has always decoded", () => {
  it.each(ORDINARY_VECTORS)("$name", ({ input, expected }) => {
    expect(decode(input)).toBe(expected);
  });

  it("decodes &nbsp; to U+00A0 and leaves an already-decoded U+00A0 alone", () => {
    expect(decode("a&nbsp;b")).toBe(`a${NBSP}b`);
    expect(decode(`a${NBSP}b`)).toBe(`a${NBSP}b`);
  });
});

describe("decodeHTMLEntities — each reference is read once", () => {
  it.each(ONE_PASS_VECTORS)("$name", ({ input, expected }) => {
    expect(decode(input)).toBe(expected);
  });

  it("never reads what an ampersand reference produced as part of the next reference", () => {
    const references = ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;", "&nbsp;", "&#60;", "&#x3C;", "&#38;", "&#x26;", "&#xD835;&#xDC00;"];
    for (const ampersand of ["&amp;", "&#38;", "&#x26;", "&#0038;", "&#x0026;"]) {
      for (const reference of references) {
        // An ampersand written as a reference, followed by the rest of another reference.
        expect(decode(ampersand + reference.slice(1))).toBe(reference);
      }
    }
  });

  it("decodes one level per call, whatever the order of named and numeric references", () => {
    const once = decode("&amp;#38;amp;lt;");
    expect(once).toBe("&#38;amp;lt;");
    expect(decode(once)).toBe("&amp;lt;");
    expect(decode(decode(once))).toBe("&lt;");
    expect(decode(decode(decode(once)))).toBe("<");
  });

  it("decodes each reference in a field independently of the others", () => {
    const parts = ["&amp;lt;", "&#38;gt;", "&lt;", "&#x3B1;", "&nbsp;", "&#x110000;"];
    const expected = ["&lt;", "&gt;", "<", C(0x3b1), NBSP, "&#x110000;"];
    expect(decode(parts.join(" "))).toBe(expected.join(" "));
    expect(decode([...parts].reverse().join(" "))).toBe([...expected].reverse().join(" "));
  });

  it("keeps CDATA-derived text literal: the Edge escapes it once, the client decodes it once", () => {
    // `<![CDATA[Literal &lt; &quot;q&quot; & <b>]]>` reaches the client escaped, as below.
    expect(decode("Literal &amp;lt; &amp;quot;q&amp;quot; &amp; &lt;b&gt;")).toBe('Literal &lt; &quot;q&quot; & <b>');
  });
});

describe("decodeHTMLEntities — references it does not decode stay as written", () => {
  it.each(PRESERVED_VECTORS)("$name", ({ input, expected }) => {
    expect(decode(input)).toBe(expected);
  });
});

describe("decodeHTMLEntities — the numeric rule", () => {
  it.each(UNDECODED_NUMERIC_VECTORS)("leaves $name as written", ({ input, expected }) => {
    expect(decode(input)).toBe(expected);
  });

  it.each(DECODED_EDGE_VALUE_VECTORS)("decodes $name", ({ input, expected }) => {
    expect(decode(input)).toBe(expected);
  });

  const values = [
    0, 1, 8, 9, 10, 13, 0x1f, 0x20, 0x41, 0x7f, 0x80, 0x9f, 0xa0, 0xfffd, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff,
    0xe000, 0xfdd0, 0xfdef, 0xfffe, 0xffff, 0x10000, 0x1d6fc, 0x1fffe, 0x10fffd, 0x10ffff, 0x110000, 0x7fffffff,
    2 ** 32, 2 ** 53, 1e21,
  ];

  it.each(values)("value %s decodes, alone, exactly when it is a scalar value other than U+0000", (value) => {
    const spellings = [
      `&#${BigInt(value).toString(10)};`,
      `&#x${BigInt(value).toString(16)};`,
      `&#x${BigInt(value).toString(16).toUpperCase()};`,
      `&#000${BigInt(value).toString(10)};`,
      `&#x000${BigInt(value).toString(16)};`,
    ];
    for (const reference of spellings) {
      const expected = isClientDecodable(value) ? String.fromCodePoint(value) : reference;
      expect(decode(reference)).toBe(expected);
      expect(decode(`[${reference}]`)).toBe(`[${expected}]`);
    }
  });

  it("decodes every high/low surrogate pair at the range edges, and neither half alone", () => {
    for (const high of [0xd800, 0xd835, 0xdbff]) {
      for (const low of [0xdc00, 0xdc01, 0xdfff]) {
        const pair = `&#x${high.toString(16)};&#${low};`;
        expect(decode(pair)).toBe(String.fromCharCode(high, low));
        expect(decode(`&#x${low.toString(16)};&#${high};`)).toBe(`&#x${low.toString(16)};&#${high};`);
      }
      expect(decode(`&#x${high.toString(16)};`)).toBe(`&#x${high.toString(16)};`);
    }
  });

  it("never produces a lone surrogate or NUL from a reference", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const samples = ["&#xD800;", "&#xDFFF;", "&#55296;", "&#xD835; &#xDC00;", "&#xDC00;&#xD835;", "&#0;", "&#x0;", "&#xD835;&#x41;"];
    for (const sample of samples) {
      const out = decode(sample);
      expect(lone.test(out)).toBe(false);
      expect(out.includes(String.fromCharCode(0))).toBe(false);
    }
  });
});

describe("decodeHTMLEntities — a malformed reference never stops the valid ones", () => {
  it.each(INVALID_REFERENCES)("%s, with every valid reference before and after it", (invalid) => {
    for (const [valid, text] of VALID_REFERENCES) {
      expect(decode(`${valid} ${invalid}`)).toBe(`${text} ${invalid}`);
      expect(decode(`${invalid} ${valid}`)).toBe(`${invalid} ${text}`);
      expect(decode(`${valid}${invalid}${valid}`)).toBe(`${text}${invalid}${text}`);
    }
  });

  it("isolates several valid and invalid references in one field", () => {
    const input =
      "&#945; &#xD800; &#x3B2; &#0; &amp; &#99999999999999999999; &lt; &#x0000041; &#00065; &#x10FFFF; " +
      "&#x110000; &alpha; &amp &#65 &#X41; &#xDFFF; &#55296; &gt;";
    const expected =
      `${C(0x3b1)} &#xD800; ${C(0x3b2)} &#0; & &#99999999999999999999; < A A ${C(0x10ffff)} ` +
      "&#x110000; &alpha; &amp &#65 &#X41; &#xDFFF; &#55296; >";
    expect(decode(input)).toBe(expected);
  });

  it("isolates repeated malformed references", () => {
    expect(decode("x&#x110000;y&#x110000;z &amp; &#xD800;&#xD800; w &lt;")).toBe("x&#x110000;y&#x110000;z & &#xD800;&#xD800; w <");
    const repeated = "&#x110000;&#;&amp&#".repeat(1000);
    expect(decode(`${repeated}&amp;`)).toBe(`${repeated}&`);
  });

  it("isolates malformed references in scientific text", () => {
    expect(decode("AT&amp;T and p &lt; 0.05; invalid &#x110000;")).toBe("AT&T and p < 0.05; invalid &#x110000;");
    expect(decode("A &amp; B &#x110000; C &lt; D")).toBe("A & B &#x110000; C < D");
    expect(decode("p &lt 0.05 &amp B &#65 &#x41 then &lt; ok")).toBe("p &lt 0.05 &amp B &#65 &#x41 then < ok");
  });

  it("never throws", () => {
    const inputs = [
      "&#x110000;",
      `&#${"9".repeat(400)};`,
      `&#x${"f".repeat(400)};`,
      "&#xD800;&#xD800;&#xD800;",
      "&#xDC00;",
      "&#0;&#x0;",
      "&".repeat(1000),
      "&#".repeat(1000),
      "&#x".repeat(1000),
    ];
    for (const input of inputs) expect(() => decodeHTMLEntities(input)).not.toThrow();
  });
});

describe("decodeHTMLEntities — scientific text", () => {
  it.each(SCIENTIFIC_VECTORS)("$name", ({ input, expected }) => {
    expect(decode(input)).toBe(expected);
  });
});

describe("decodeHTMLEntities — agrees with the transcribed contract", () => {
  // A seeded generator, so a failure names a reproducible input.
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("on 20,000 generated inputs built from reference fragments", () => {
    const random = mulberry32(20261127);
    for (let n = 0; n < 20_000; n++) {
      let input = "";
      const length = 1 + Math.floor(random() * 14);
      for (let k = 0; k < length; k++) input += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
      expect(decode(input), JSON.stringify(input)).toBe(specDecode(input));
    }
  });
});

/**
 * Bounded work, measured by counting operations rather than by timing:
 *  - one `replace` over the input per call, so no second pass and no
 *    decoding to a fixed point;
 *  - pattern executions in proportion to the number of `&` in the input;
 *  - at most 7 decimal or 6 hexadecimal digits read from a reference whose
 *    value is too large, however long it is.
 */
describe("decodeHTMLEntities — bounded work", () => {
  type Counts = { replace: number; exec: number; charCodeAt: number };
  type Method = (this: unknown, ...args: unknown[]) => unknown;

  /** Count calls to one built-in method until the returned function restores it. */
  function patch(target: object, key: string, onCall: () => void): () => void {
    const holder = target as Record<string, Method | undefined>;
    const original = holder[key];
    if (typeof original !== "function") return () => {};
    holder[key] = function (this: unknown, ...args: unknown[]) {
      onCall();
      return original.apply(this, args);
    };
    return () => {
      holder[key] = original;
    };
  }

  function counted(run: () => void): Counts {
    const counts: Counts = { replace: 0, exec: 0, charCodeAt: 0 };
    const restore = [
      patch(String.prototype, "replace", () => counts.replace++),
      patch(String.prototype, "replaceAll", () => counts.replace++),
      patch(RegExp.prototype, "exec", () => counts.exec++),
      patch(String.prototype, "charCodeAt", () => counts.charCodeAt++),
    ];
    try {
      run();
    } finally {
      for (const undo of restore) undo();
    }
    return counts;
  }

  const ampersands = (text: string) => text.split("&").length - 1;

  it("makes one replacement pass per call, and none for empty input", () => {
    for (const input of ["&amp;lt;", "&amp;amp;amp;amp;lt;", "no references", "&#x110000; &amp; &#xD835;&#xDC00;"]) {
      expect(counted(() => decode(input)).replace).toBe(1);
    }
    expect(counted(() => decodeHTMLEntities("")).replace).toBe(0);
    expect(counted(() => decodeHTMLEntities(null)).replace).toBe(0);
  });

  it("executes its patterns in proportion to the number of ampersands", () => {
    for (const input of [
      "&amp;".repeat(2000),
      "&#x110000;&#;&amp&#".repeat(500),
      "&#xD835;&#xDC00;".repeat(500),
      "&#xD835;".repeat(1000),
      "&".repeat(2000),
      `${"text ".repeat(1000)}&lt;`,
    ]) {
      const { exec } = counted(() => decode(input));
      expect(exec).toBeLessThanOrEqual(2 * ampersands(input) + 1);
    }
  });

  it("reads a bounded number of digits from a reference that is too large", () => {
    const decimal = `&#${"9".repeat(1_000_000)};`;
    const hex = `&#x${"F".repeat(1_000_000)};`;
    expect(counted(() => expect(decode(decimal)).toBe(decimal)).charCodeAt).toBeLessThanOrEqual(7);
    expect(counted(() => expect(decode(hex)).toBe(hex)).charCodeAt).toBeLessThanOrEqual(6);
    const many = `&#${"9".repeat(1000)};`.repeat(1000);
    expect(counted(() => decode(many)).charCodeAt).toBeLessThanOrEqual(7 * 1000);
  });

  it("reads leading zeros once each, so a long zero-padded reference still decodes", () => {
    const zeros = "0".repeat(1_000_000);
    const reads = counted(() => {
      expect(decode(`&#${zeros}65;`)).toBe("A");
      expect(decode(`&#x${zeros}41;`)).toBe("A");
    }).charCodeAt;
    expect(reads).toBeLessThanOrEqual(2 * (zeros.length + 2));
  });

  it("costs the same for every further copy of a repeated input, so work is linear", () => {
    for (const unit of ["&amp;lt;&#x3B1; p &lt; 0.05 ", "&#x110000;&#;&amp&#&#xD800;", `&#${"9".repeat(50)};&#xD835;&#xDC00;`]) {
      const work = (copies: number) => {
        const counts = counted(() => decode(unit.repeat(copies)));
        return counts.exec + counts.charCodeAt;
      };
      const [w1, w2, w3] = [work(1000), work(2000), work(3000)];
      expect(w3 - w2).toBe(w2 - w1);
      expect(w2 - w1).toBeLessThanOrEqual(1000 * unit.length);
    }
  });

  it("finishes on large malformed input without a second pass", () => {
    const unterminated = `&#${"1".repeat(200_000)} &#x${"a".repeat(200_000)} ${"&#x".repeat(50_000)} ${"&".repeat(200_000)}`;
    const counts = counted(() => expect(decode(unterminated)).toBe(unterminated));
    expect(counts.replace).toBe(1);
  });
});
