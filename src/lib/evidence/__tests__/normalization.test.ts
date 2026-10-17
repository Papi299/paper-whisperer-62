// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  codePointLength,
  EvidenceTextError,
  findPostgresTextProblem,
  isNormalizationEmpty,
  mapNormalizedRange,
  nfcUnits,
  normalizeEvidenceV1,
  normalizeEvidenceV1WithMap,
  REMOVED_CODE_POINTS,
  toCodePointOffset,
  toUtf16Offset,
  utf16BoundaryOffsets,
  WHITE_SPACE_CODE_POINTS,
} from "../normalization";
import { codePointsOf, cp, FIXTURE } from "./fixtures/vectors";

/**
 * Match normalization v1 in TypeScript, against the shared golden fixture
 * (whose expected values were computed outside both implementations) and
 * against the properties the deployed SQL function has. The SQL side of the
 * same fixture is suite 032.
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** A deterministic PRNG (mulberry32), so the property checks are reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Characters chosen to exercise every step: marks, jamo, exclusions, removals, white space, mappings, astral. */
const ALPHABET = [
  "a", "e", "A", "n", "q", "1", ".", "-", " ",
  cp(0x09), cp(0x0a), cp(0x0301), cp(0x0323), cp(0x0308), cp(0x0304), cp(0x030a), cp(0x0303), cp(0x0344),
  cp(0x00ad), cp(0x200b), cp(0x2060), cp(0xfeff), cp(0x00a0), cp(0x2009), cp(0x3000), cp(0x2028),
  cp(0x2026), cp(0x00b5), cp(0x2013), cp(0x2212), cp(0x201c), cp(0x2019),
  cp(0x1100), cp(0x1161), cp(0x11a8), cp(0xac00), cp(0x212b), cp(0x0958), cp(0x093c), cp(0x0f73),
  cp(0x1f71), cp(0x03b1), cp(0xfb1d), cp(0x1d15e), cp(0x1f600), cp(0x200d),
];

function randomTexts(count: number, seed: number): string[] {
  const random = prng(seed);
  return Array.from({ length: count }, () => {
    const length = Math.floor(random() * 24);
    return Array.from({ length }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join("");
  });
}

describe("the shared golden fixture", () => {
  it("is the v1 fixture, with unique ids and the vectors every brief requires", () => {
    expect(FIXTURE.fixture).toBe("evidence-normalization-v1");
    expect(FIXTURE.normalization_version).toBe("v1");
    const ids = [...FIXTURE.normalization.map((v) => v.id), ...FIXTURE.matching.map((v) => v.id)];
    expect(new Set(ids).size).toBe(ids.length);
    // 30 from suite 031, 6 from the migration's own check, and the 001B additions.
    expect(FIXTURE.normalization.filter((v) => v.origin === "suite-031")).toHaveLength(30);
    expect(FIXTURE.normalization.filter((v) => v.origin === "migration-verify")).toHaveLength(6);
    expect(FIXTURE.normalization.filter((v) => v.origin === "001b").length).toBeGreaterThanOrEqual(40);
    expect(FIXTURE.normalization.filter((v) => v.second_pass !== undefined).length).toBeGreaterThanOrEqual(5);
  });

  it.each(FIXTURE.normalization.map((v) => [v.id, v.title, v] as const))("%s %s", (_id, _title, vector) => {
    expect(codePointsOf(vector.input)).toBe(vector.input_code_points);
    const once = normalizeEvidenceV1(vector.input);
    expect(once).toBe(vector.expected);
    expect(sha256(once)).toBe(vector.expected_sha256);
    expect(normalizeEvidenceV1WithMap(vector.input).normalized).toBe(vector.expected);
    if (vector.second_pass !== undefined) {
      // v1 is not idempotent: a second pass composes what the first left apart.
      expect(normalizeEvidenceV1(once)).toBe(vector.second_pass);
      expect(vector.second_pass).not.toBe(once);
    }
  });
});

describe("exactly the specified steps, in order, and nothing else", () => {
  it("removes exactly U+00AD, U+200B, U+2060 and U+FEFF", () => {
    expect([...REMOVED_CODE_POINTS]).toEqual([0x00ad, 0x200b, 0x2060, 0xfeff]);
    for (const removed of REMOVED_CODE_POINTS) expect(normalizeEvidenceV1(`x${cp(removed)}y`)).toBe("xy");
  });

  it("maps exactly the 25 Unicode White_Space code points to a space", () => {
    // Derived independently from the engine: ECMAScript's \s is White_Space
    // except U+0085, plus U+FEFF (its WhiteSpace and LineTerminator sets).
    const fromJavaScript: number[] = [];
    for (let code = 1; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      if (/\s/u.test(cp(code))) fromJavaScript.push(code);
    }
    const unicodeWhiteSpace = [...fromJavaScript.filter((code) => code !== 0xfeff), 0x0085].sort((a, b) => a - b);
    expect([...WHITE_SPACE_CODE_POINTS].sort((a, b) => a - b)).toEqual(unicodeWhiteSpace);
    expect(unicodeWhiteSpace).toHaveLength(25);
    for (const code of WHITE_SPACE_CODE_POINTS) expect(normalizeEvidenceV1(`x${cp(code)}y`)).toBe("x y");
  });

  it("applies NFC, never NFKC: compatibility characters survive", () => {
    const hazards = `10${cp(0x2075)} cells; 5 m${cp(0x00b2)}; ${cp(0xfb01)}ber; H${cp(0x2082)}O`;
    expect(normalizeEvidenceV1(hazards)).toBe(hazards);
    expect(normalizeEvidenceV1(hazards)).not.toBe(hazards.normalize("NFKC"));
  });

  it("never folds case and never strips accents", () => {
    expect(normalizeEvidenceV1("Placebo PLACEBO placebo")).toBe("Placebo PLACEBO placebo");
    expect(normalizeEvidenceV1(`caf${cp(0x00e9)}`)).not.toBe("cafe");
  });

  it("removes before it collapses, and composes before it removes", () => {
    expect(normalizeEvidenceV1(`a ${cp(0x200b)} b`)).toBe("a b");
    expect(normalizeEvidenceV1(`e${cp(0x00ad)}${cp(0x0301)}`)).toBe(`e${cp(0x0301)}`);
  });

  it("leaves printable ASCII without white-space runs unchanged", () => {
    const random = prng(7);
    for (let n = 0; n < 500; n++) {
      const text = Array.from({ length: 1 + Math.floor(random() * 40) }, () =>
        String.fromCharCode(0x21 + Math.floor(random() * 94)),
      ).join("");
      expect(normalizeEvidenceV1(text)).toBe(text);
    }
  });

  it("produces output with single inner spaces, no edge spaces, and none of the mapped or removed characters", () => {
    const forbidden = new Set([...REMOVED_CODE_POINTS, ...WHITE_SPACE_CODE_POINTS.filter((c) => c !== 0x20), 0x2026, 0x00b5,
      0x2018, 0x2019, 0x201a, 0x201b, 0x201c, 0x201d, 0x201e, 0x201f, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212]);
    for (const text of randomTexts(2000, 11)) {
      const out = normalizeEvidenceV1(text);
      expect(out.startsWith(" ") || out.endsWith(" ") || out.includes("  ")).toBe(false);
      for (const ch of out) expect(forbidden.has(ch.codePointAt(0) as number)).toBe(false);
    }
  });

  it("says when text is empty after v1, as PR-A2 judges labels, notes and abstracts", () => {
    expect(isNormalizationEmpty("")).toBe(true);
    expect(isNormalizationEmpty(` ${cp(0x00a0)}${cp(0x200b)}${cp(0x3000)}\n`)).toBe(true);
    expect(isNormalizationEmpty(cp(0x0301))).toBe(false);
    expect(isNormalizationEmpty(" a ")).toBe(false);
  });
});

describe("the index map", () => {
  const check = (text: string) => {
    const map = normalizeEvidenceV1WithMap(text);
    expect(map.normalized).toBe(normalizeEvidenceV1(text));
    expect(map.normalizedLength).toBe(codePointLength(map.normalized));
    expect(map.originalLength).toBe(codePointLength(text));
    expect(map.originalUtf16Offsets).toHaveLength(map.originalLength + 1);
    for (let i = 0; i < map.normalizedLength; i++) {
      expect(map.sourceStart[i]).toBeGreaterThanOrEqual(0);
      expect(map.sourceEnd[i]).toBeGreaterThan(map.sourceStart[i]);
      expect(map.sourceEnd[i]).toBeLessThanOrEqual(map.originalLength);
      if (i > 0) {
        expect(map.sourceStart[i]).toBeGreaterThanOrEqual(map.sourceStart[i - 1]);
        expect(map.sourceEnd[i]).toBeGreaterThanOrEqual(map.sourceEnd[i - 1]);
      }
    }
  };

  it("matches the plain normalizer and is monotonic on every fixture input", () => {
    for (const vector of FIXTURE.normalization) check(vector.input);
  });

  it("matches the plain normalizer and is monotonic on 3,000 random texts", () => {
    for (const text of randomTexts(3000, 42)) check(text);
  });

  it("repairs wrong chunk boundaries: whole-string NFC always wins", () => {
    for (const text of [...randomTexts(500, 5), `${cp(0x1100)}${cp(0x1161)}${cp(0x11a8)}`, `a${cp(0x0301)}${cp(0x0323)}`]) {
      const everywhere = nfcUnits(Array.from(text), () => true);
      expect(everywhere.map((u) => cp(u.cp)).join("")).toBe(text.normalize("NFC"));
    }
  });

  it("maps a composed character back to all of its source characters", () => {
    const map = normalizeEvidenceV1WithMap(`cafe${cp(0x0301)}!`);
    expect(map.normalized).toBe(`caf${cp(0x00e9)}!`);
    expect(mapNormalizedRange(map, 3, 4)).toEqual({ start: 3, end: 5, snapped: false });
    expect(mapNormalizedRange(map, 4, 5)).toEqual({ start: 5, end: 6, snapped: false });
  });

  it("maps a collapsed white-space run, removed characters included, to the whole run", () => {
    // "a", space, space, U+200B, space, "b": one output space for original characters 1-4.
    const map = normalizeEvidenceV1WithMap(`a  ${cp(0x200b)} b`);
    expect(map.normalized).toBe("a b");
    expect(mapNormalizedRange(map, 1, 2)).toEqual({ start: 1, end: 5, snapped: false });
  });

  it("snaps a range that ends inside an expanded ellipsis to the whole character", () => {
    const map = normalizeEvidenceV1WithMap(`x${cp(0x2026)}y`);
    expect(map.normalized).toBe("x...y");
    expect(mapNormalizedRange(map, 0, 2)).toEqual({ start: 0, end: 2, snapped: true });
    expect(mapNormalizedRange(map, 0, 4)).toEqual({ start: 0, end: 2, snapped: false });
    expect(mapNormalizedRange(map, 2, 3)).toEqual({ start: 1, end: 2, snapped: true });
  });

  it("refuses an empty or out-of-range normalized range", () => {
    const map = normalizeEvidenceV1WithMap("abc");
    expect(mapNormalizedRange(map, 1, 1)).toBeNull();
    expect(mapNormalizedRange(map, -1, 2)).toBeNull();
    expect(mapNormalizedRange(map, 0, 4)).toBeNull();
    expect(mapNormalizedRange(map, 0.5, 2)).toBeNull();
  });

  it("is frozen", () => {
    const map = normalizeEvidenceV1WithMap("a b");
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(map.sourceStart)).toBe(true);
    expect(Object.isFrozen(map.normalizedCodePoints)).toBe(true);
  });
});

describe("text PostgreSQL cannot store", () => {
  const loneHigh = String.fromCharCode(0xd800);
  const loneLow = String.fromCharCode(0xdc00);

  it.each([
    ["a lone high surrogate", `a${loneHigh}b`, "lone_surrogate"],
    ["a lone low surrogate", `a${loneLow}b`, "lone_surrogate"],
    ["a high surrogate at the end", `ab${loneHigh}`, "lone_surrogate"],
    ["U+0000", `a${String.fromCharCode(0)}b`, "nul_character"],
  ])("refuses %s rather than normalizing it", (_label, text, reason) => {
    expect(findPostgresTextProblem(text)).toBe(reason);
    expect(() => normalizeEvidenceV1(text)).toThrow(EvidenceTextError);
    expect(() => normalizeEvidenceV1WithMap(text)).toThrow(EvidenceTextError);
    try {
      normalizeEvidenceV1(text);
    } catch (error) {
      expect((error as EvidenceTextError).reason).toBe(reason);
      expect((error as Error).message).not.toContain(text);
    }
  });

  it("accepts a well-formed surrogate pair", () => {
    expect(findPostgresTextProblem(cp(0x1f600))).toBeNull();
  });

  it("refuses a non-string with a TypeError", () => {
    expect(() => normalizeEvidenceV1(42 as unknown as string)).toThrow(TypeError);
  });
});

describe("code points, not UTF-16 units", () => {
  const emoji = cp(0x1f600);

  it("counts characters as PostgreSQL's char_length does", () => {
    expect(emoji.length).toBe(2);
    expect(codePointLength(emoji)).toBe(1);
    expect(codePointLength(`e${cp(0x0301)}`)).toBe(2);
    expect(codePointLength("")).toBe(0);
  });

  it("converts between the two offset kinds, refusing a split surrogate pair", () => {
    const text = `${emoji} 120`;
    expect([...utf16BoundaryOffsets(text)]).toEqual([0, 2, 3, 4, 5, 6]);
    expect(toCodePointOffset(text, 3)).toBe(2);
    expect(toCodePointOffset(text, 1)).toBeNull();
    expect(toCodePointOffset(text, 99)).toBeNull();
    expect(toUtf16Offset(text, 2)).toBe(3);
    expect(toUtf16Offset(text, 6)).toBeNull();
  });
});
