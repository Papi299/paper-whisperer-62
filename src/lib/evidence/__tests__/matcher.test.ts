// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  findAllOccurrences,
  locateQuote,
  QUOTE_OCCURRENCE_LIMIT,
  quoteFromSelection,
  resolveSelectedOccurrence,
  selectOccurrence,
  type AdvisoryQuoteMatch,
} from "../matcher";
import { cp, FIXTURE } from "./fixtures/vectors";

/**
 * The advisory quote matcher. The matching vectors of the shared fixture fix
 * every offset; suite 032 checks the same normalized offsets against
 * PostgreSQL's own character positions on the installed normalizer, and runs
 * every vector through the server's evidence_locate_quote (EVIDENCE-RECORDS-001A3).
 */

const occurrencesOf = (match: AdvisoryQuoteMatch) => (match.kind === "unique" || match.kind === "multiple" ? match.occurrences : []);

describe("locateQuote — the shared fixture's matching vectors", () => {
  it.each(FIXTURE.matching.map((v) => [v.id, v.title, v] as const))("%s %s", (_id, _title, vector) => {
    const match = locateQuote(vector.quote, vector.snapshot);
    expect(match.kind).toBe(vector.expected_kind);
    expect(match.attestation).toBe("browser_advisory");
    if (match.kind === "invalid") {
      expect([...match.problems]).toEqual(vector.invalid_problems);
      return;
    }
    expect(vector.invalid_problems).toEqual([]);
    if (match.kind === "too_many") {
      // The oracle still lists every occurrence; no matcher claims one.
      expect([...match.normalizedQuote]).toHaveLength(vector.normalized_quote_length);
      expect(vector.expected_normalized.length).toBeGreaterThan(QUOTE_OCCURRENCE_LIMIT);
      expect(vector.expected_exact).toEqual([]);
      expect(JSON.stringify(match)).not.toContain("occurrences");
      return;
    }
    expect([...match.normalizedQuote]).toHaveLength(vector.normalized_quote_length);
    const found = occurrencesOf(match);
    expect(found.map((o) => [o.normalized.start, o.normalized.end])).toEqual(vector.expected_normalized);
    expect(found.map((o) => [o.exact.start, o.exact.end])).toEqual(vector.expected_exact);
    expect(found.map((o) => o.exact.snapped)).toEqual(vector.expected_exact_snapped);
    expect(found.map((o) => [o.exactUtf16.start, o.exactUtf16.end])).toEqual(vector.expected_exact_utf16);
    expect(found.map((o) => o.occurrence)).toEqual(found.map((_, i) => i + 1));
    if (match.kind !== "not_found") expect(match.count).toBe(found.length);
  });

  it("covers every outcome and the edges the brief names", () => {
    const kinds = new Set(FIXTURE.matching.map((v) => v.expected_kind));
    expect([...kinds].sort()).toEqual(["invalid", "multiple", "not_found", "too_many", "unique"]);
    const titles = FIXTURE.matching.map((v) => v.title).join("\n");
    for (const edge of ["overlapping", "case", "decomposed", "soft hyphen", "ellipsis", "punctuation", "code points", "emoji", "normalized exactly once"]) {
      expect(titles).toContain(edge);
    }
  });
});

describe("locateQuote — rules", () => {
  const copy = "Adults with type 2 diabetes were randomized (n = 120).";

  it("normalizes each input once: a quote never matches text a second pass would produce", () => {
    // The copy's soft hyphen keeps e + U+0301 apart; only a second NFC would compose it.
    expect(locateQuote(`${cp(0x00e9)}tude`, `e${cp(0x00ad)}${cp(0x0301)}tude`).kind).toBe("not_found");
  });

  it("treats an ellipsis as three full stops, never as a wildcard", () => {
    expect(locateQuote("type ... randomized", copy).kind).toBe("not_found");
    expect(locateQuote(`type 2${cp(0x2026)}`, "type 2... and more").kind).toBe("unique");
  });

  it("refuses a quote without a letter or digit, and one too short or too long", () => {
    expect(locateQuote("?!;", copy)).toMatchObject({ kind: "invalid", problems: ["no_letter_or_digit"] });
    expect(locateQuote("n=", copy)).toMatchObject({ kind: "invalid", problems: ["quote_too_short", "normalized_too_short"] });
    expect(locateQuote("x".repeat(1000), "x".repeat(1000)).kind).toBe("unique");
    expect(locateQuote("x".repeat(1001), copy).kind).toBe("invalid");
  });

  it("counts a letter of any script, or an ASCII digit, as the server does (Alphabetic or 0-9)", () => {
    expect(locateQuote(`${cp(0x03b1)}${cp(0x03b2)}${cp(0x03b3)}`, `x ${cp(0x03b1)}${cp(0x03b2)}${cp(0x03b3)} y`).kind).toBe("unique");
    expect(locateQuote(`${cp(0x216b)}${cp(0x216b)}${cp(0x216b)}`, `Phase ${cp(0x216b)}${cp(0x216b)}${cp(0x216b)}.`).kind).toBe("unique");
    // A digit of another script is not an ASCII digit and not Alphabetic.
    expect(locateQuote(`${cp(0x0661)}${cp(0x0662)}${cp(0x0663)}`, `${cp(0x0661)}${cp(0x0662)}${cp(0x0663)}`)).toMatchObject({
      kind: "invalid",
      problems: ["no_letter_or_digit"],
    });
    expect(locateQuote(`n=${cp(0x0661)}${cp(0x0662)}`, `n=${cp(0x0661)}${cp(0x0662)}`).kind).toBe("unique");
  });

  it("enumerates up to 100 occurrences; beyond that a quote is too_many, with no count or offsets", () => {
    const hundred = locateQuote("aaa", "a".repeat(102));
    expect(hundred.kind).toBe("multiple");
    if (hundred.kind !== "multiple") return;
    expect(hundred.count).toBe(QUOTE_OCCURRENCE_LIMIT);
    expect(hundred.occurrences[99].normalized).toEqual({ start: 99, end: 102 });
    expect(locateQuote("aaa", "a".repeat(103))).toEqual({
      attestation: "browser_advisory",
      normalizationVersion: "v1",
      kind: "too_many",
      normalizedQuote: "aaa",
    });
    expect(selectOccurrence(locateQuote("aaa", "a".repeat(103)), 1)).toBeNull();
  });

  it("refuses text PostgreSQL cannot store as a quote, without throwing", () => {
    expect(locateQuote(`ab${String.fromCharCode(0xd800)}c`, copy)).toMatchObject({ kind: "invalid", problems: ["malformed_text"] });
    expect(locateQuote(42 as unknown as string, copy)).toMatchObject({ kind: "invalid", problems: ["malformed_text"] });
  });

  it("gives every result the advisory attestation and no server-attested field", () => {
    const match = locateQuote("type 2 diabetes", copy);
    expect(match.attestation).toBe("browser_advisory");
    const json = JSON.stringify(match);
    for (const field of ["matched_at", "matchedAt", "match_count", "server"]) expect(json).not.toContain(field);
    expect(Object.isFrozen(match)).toBe(true);
  });

  it("is deterministic", () => {
    const a = locateQuote("received", "A received x. B received y. C received z.");
    const b = locateQuote("received", "A received x. B received y. C received z.");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("gives context from the saved copy around each occurrence, without orphaned marks", () => {
    const text = `${"a".repeat(50)} received drug X ${"b".repeat(50)}`;
    const [occurrence] = occurrencesOf(locateQuote("received drug X", text));
    expect(occurrence.context).toEqual({
      before: `${"a".repeat(39)} `,
      match: "received drug X",
      after: ` ${"b".repeat(39)}`,
      truncatedBefore: true,
      truncatedAfter: true,
    });
    const marked = `xe${cp(0x0301)}ye${cp(0x0301)}ztarget`;
    const [withMarks] = occurrencesOf(locateQuote("target", marked, { contextLength: 4 }));
    expect(withMarks.context.before.codePointAt(0)).not.toBe(0x0301);
  });
});

describe("choosing among several occurrences", () => {
  const text = "Group A received drug X. Group B received placebo. Group C received drug X.";
  const match = locateQuote("received drug X", text);

  it("lists them in position order, with context for the user to choose from", () => {
    expect(match.kind).toBe("multiple");
    // Up to 40 characters of the saved copy on each side; the second starts mid-word.
    expect(occurrencesOf(match).map((o) => o.context.before.trim())).toEqual(["Group A", "ug X. Group B received placebo. Group C"]);
    expect(occurrencesOf(match).map((o) => o.context.truncatedBefore)).toEqual([false, true]);
  });

  it("selects one explicitly, by its 1-based number", () => {
    expect(selectOccurrence(match, 2)?.normalized.start).toBe(59);
    expect(selectOccurrence(match, 0)).toBeNull();
    expect(selectOccurrence(match, 3)).toBeNull();
    expect(selectOccurrence(match, 1.5)).toBeNull();
    expect(selectOccurrence(locateQuote("absent text", text), 1)).toBeNull();
  });

  it("resolves the occurrence a selection in the copy is, and asks when it cannot tell", () => {
    const second = text.lastIndexOf("received drug X");
    expect(resolveSelectedOccurrence(match, { start: second, end: second + 15 })).toMatchObject({
      kind: "resolved",
      occurrence: { occurrence: 2 },
    });
    expect(resolveSelectedOccurrence(match, { start: 0, end: 5 })).toEqual({ kind: "unresolved", reason: "outside_occurrences" });
    expect(resolveSelectedOccurrence(locateQuote("nowhere at all", text), { start: 0, end: 5 })).toEqual({
      kind: "unresolved",
      reason: "no_occurrences",
    });
    const overlapping = locateQuote("aaa", "aaaa");
    expect(resolveSelectedOccurrence(overlapping, { start: 1, end: 3 })).toEqual({ kind: "unresolved", reason: "ambiguous" });
  });

  it("takes a quote from a selection and knows which occurrence it was", () => {
    const second = text.lastIndexOf("received drug X");
    const quote = quoteFromSelection(text, { start: second, end: second + 15 });
    expect(quote.kind).toBe("quote");
    if (quote.kind !== "quote") return;
    expect(quote.quoteText).toBe("received drug X");
    expect(quote.match.kind).toBe("multiple");
    expect(quote.selected).toMatchObject({ kind: "resolved", occurrence: { occurrence: 2 } });
  });

  it("refuses a selection that splits a character or leaves the copy", () => {
    const emoji = `${cp(0x1f600)} trial`;
    expect(quoteFromSelection(emoji, { start: 1, end: 7 })).toEqual({ kind: "invalid_selection" });
    expect(quoteFromSelection(emoji, { start: 0, end: 99 })).toEqual({ kind: "invalid_selection" });
    expect(quoteFromSelection(emoji, { start: 3, end: 3 })).toEqual({ kind: "invalid_selection" });
    expect(quoteFromSelection(emoji, { start: 3, end: 8 })).toMatchObject({ kind: "quote", quoteText: "trial" });
  });
});

describe("findAllOccurrences", () => {
  const codes = (text: string) => Array.from(text, (ch) => ch.codePointAt(0) as number);

  it("finds every occurrence, overlapping ones included, or the first `limit`", () => {
    expect(findAllOccurrences(codes("aaaaa"), codes("aa"))).toEqual([0, 1, 2, 3]);
    expect(findAllOccurrences(codes("aaaaa"), codes("aa"), 2)).toEqual([0, 1]);
    expect(findAllOccurrences(codes("aaaaa"), codes("aa"), 0)).toEqual([]);
    expect(findAllOccurrences(codes("abababa"), codes("aba"))).toEqual([0, 2, 4]);
    expect(findAllOccurrences(codes("abc"), codes("abcd"))).toEqual([]);
    expect(findAllOccurrences(codes("abc"), [])).toEqual([]);
  });

  it("agrees with a brute-force search on random inputs", () => {
    let seed = 99;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let n = 0; n < 500; n++) {
      const text = Array.from({ length: Math.floor(random() * 30) }, () => "ab"[Math.floor(random() * 2)]).join("");
      const pattern = Array.from({ length: 1 + Math.floor(random() * 4) }, () => "ab"[Math.floor(random() * 2)]).join("");
      const brute: number[] = [];
      for (let i = 0; i + pattern.length <= text.length; i++) if (text.slice(i, i + pattern.length) === pattern) brute.push(i);
      expect(findAllOccurrences(codes(text), codes(pattern))).toEqual(brute);
    }
  });
});
