/**
 * Number suggestions for the two numeric fields, `n_randomized` and
 * `n_enrolled` (EVIDENCE-RECORDS-001B; Requirements-001 §H3, §E4, §E12).
 *
 * A numeric value is stored as the reported text, verbatim, AND an integer the
 * user confirmed — always together. This module only SUGGESTS the integer, and
 * only when the text holds exactly one plain, unambiguous count. It never
 * guesses: "one hundred twenty", "100-120", "12.5", "-5", "45%", "120 mg",
 * "> 120", "10⁵", "COVID-19" and every text with two or more numbers get no
 * suggestion, with the reason. The user always confirms the number.
 *
 * `checkCountInQuote` is the digit-not-in-quote warning: it fires only when
 * the confirmed number appears in the quote under no plausible reading. It is
 * a warning, never a block, and it is not a scientific-correctness check — a
 * number whose digits do appear still needs a human to judge that the quote
 * supports it.
 */

import { COUNT_MAX, COUNT_MIN } from "./fieldDictionary";

export type CountRefusal =
  | "empty"
  | "no_digits"
  | "non_ascii_digits"
  | "multiple_numbers"
  | "range"
  | "decimal"
  | "negative"
  | "percentage"
  | "unit"
  | "qualified"
  | "exponent"
  | "attached_to_word"
  | "malformed_grouping"
  | "leading_zero"
  | "out_of_range";

export type CountSuggestion =
  | {
      readonly kind: "suggestion";
      readonly value: number;
      /** The digits as written, for example "1,204". */
      readonly matchedText: string;
      /** UTF-16 indices of `matchedText` in the reported text. */
      readonly utf16Start: number;
      readonly utf16End: number;
    }
  | { readonly kind: "no_suggestion"; readonly reason: CountRefusal };

const LETTER = /\p{L}/u;
const DECIMAL_DIGIT = /\p{Nd}/u;
const NUMBER_RUN = /[0-9]+(?:[.,][0-9]+)*/g;
const VALID_GROUPING = /^[1-9][0-9]{0,2}(?:,[0-9]{3})+$/;

/** Hyphen-minus, the Unicode hyphens and dashes, and the minus sign. */
const DASHES = new Set([0x2d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212]);
/** Comparison and approximation signs that make a number inexact: < > ≤ ≥ ~ ∼ ≈ ±. */
const QUALIFIERS = new Set([0x3c, 0x3e, 0x2264, 0x2265, 0x7e, 0x223c, 0x2248, 0xb1]);
/** The spaces allowed between a number and its unit or percent sign. */
const GAPS = new Set([0x20, 0xa0, 0x2009, 0x202f]);
const PERCENT_SIGNS = new Set([0x25, 0x2030]);
const DEGREE_SIGN = 0xb0;
const CARET = 0x5e;

function isSuperOrSubscript(cp: number): boolean {
  return cp === 0xb2 || cp === 0xb3 || cp === 0xb9 || (cp >= 0x2070 && cp <= 0x209f);
}

const MICRO = String.fromCodePoint(0x00b5);
const MU = String.fromCodePoint(0x03bc);
const DEGREE = String.fromCodePoint(DEGREE_SIGN);

/** Measurement units: a number carrying one is not a count of participants. Lowercase. */
const UNITS: ReadonlySet<string> = new Set([
  "mg", "g", "kg", "mcg", `${MICRO}g`, `${MU}g`, "ng",
  "ml", "l", "dl",
  "mmol", `${MICRO}mol`, `${MU}mol`, "mol", "mmhg",
  "cm", "mm", "m", "km",
  "h", "hr", "hrs", "hour", "hours", "min", "mins", "minute", "minutes",
  "s", "sec", "secs", "second", "seconds",
  "d", "day", "days", "wk", "wks", "week", "weeks",
  "mo", "month", "months", "y", "yr", "yrs", "year", "years",
  "iu", "u", "bpm", "kcal", "kj", "hz",
  DEGREE, `${DEGREE}c`, `${DEGREE}f`,
]);

const codePointAt = (text: string, index: number) => (index >= 0 && index < text.length ? (text.codePointAt(index) as number) : -1);

/** The code point that ends just before UTF-16 index `index`, and where it starts. */
function previous(text: string, index: number): { cp: number; at: number } {
  if (index <= 0) return { cp: -1, at: -1 };
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return { cp: text.codePointAt(index - 2) as number, at: index - 2 };
  }
  return { cp: low, at: index - 1 };
}

const isLetter = (cp: number) => cp >= 0 && LETTER.test(String.fromCodePoint(cp));

/** The word (letters, plus a leading degree or micro sign) starting at `index`, lowercased. */
function wordAt(text: string, index: number): string {
  let end = index;
  for (;;) {
    const cp = codePointAt(text, end);
    if (cp < 0) break;
    const leading = end === index && (cp === DEGREE_SIGN || cp === 0x00b5 || cp === 0x03bc);
    if (!leading && !isLetter(cp)) break;
    end += cp > 0xffff ? 2 : 1;
  }
  return text.slice(index, end).toLowerCase();
}

function skipGapsForward(text: string, index: number): number {
  let i = index;
  while (GAPS.has(codePointAt(text, i))) i += 1;
  return i;
}

function skipGapsBackward(text: string, index: number): number {
  let i = index;
  while (i > 0 && GAPS.has(text.charCodeAt(i - 1))) i -= 1;
  return i;
}

/** Why the one number in the text is not a plain count — its surroundings first, then its own form. */
function classifyRun(text: string, run: string, start: number, end: number): CountRefusal | null {
  const context = classifyContext(text, start, end);
  if (context) return context;
  if (run.includes(".")) return "decimal";
  if (run.includes(",") && !VALID_GROUPING.test(run)) return "malformed_grouping";
  if (!run.includes(",") && run.length > 1 && run.startsWith("0")) return "leading_zero";
  return null;
}

function classifyContext(text: string, start: number, end: number): CountRefusal | null {
  const before = previous(text, start);
  if (isLetter(before.cp)) return "attached_to_word";
  if (DASHES.has(before.cp)) {
    const beforeDash = previous(text, before.at);
    return isLetter(beforeDash.cp) || (beforeDash.cp >= 0x30 && beforeDash.cp <= 0x39) ? "attached_to_word" : "negative";
  }
  if (QUALIFIERS.has(previous(text, skipGapsBackward(text, start)).cp)) return "qualified";

  const next = codePointAt(text, end);
  if (isSuperOrSubscript(next) || next === CARET) return "exponent";
  if (PERCENT_SIGNS.has(next)) return "percentage";
  if (DASHES.has(next) && isLetter(codePointAt(text, end + 1))) return "attached_to_word";
  if (isLetter(next)) return UNITS.has(wordAt(text, end)) ? "unit" : "attached_to_word";

  const after = skipGapsForward(text, end);
  const nextAfterGap = codePointAt(text, after);
  if (PERCENT_SIGNS.has(nextAfterGap)) return "percentage";
  if (after > end) {
    const word = wordAt(text, after);
    if (word === "percent") return "percentage";
    if (word === "per" && wordAt(text, skipGapsForward(text, after + 3)) === "cent") return "percentage";
    if (UNITS.has(word)) return "unit";
  }
  return null;
}

/** A suggested integer for a numeric field's reported text, or why there is none. */
export function suggestCount(reportedText: string): CountSuggestion {
  const refuse = (reason: CountRefusal): CountSuggestion => ({ kind: "no_suggestion", reason });
  if (typeof reportedText !== "string" || reportedText.trim() === "") return refuse("empty");
  for (const ch of reportedText) {
    if (DECIMAL_DIGIT.test(ch) && !(ch >= "0" && ch <= "9")) return refuse("non_ascii_digits");
  }

  const runs = Array.from(reportedText.matchAll(NUMBER_RUN), (m) => ({
    text: m[0],
    start: m.index as number,
    end: (m.index as number) + m[0].length,
  }));
  if (runs.length === 0) return refuse("no_digits");
  if (runs.length > 1) {
    if (runs.length === 2) {
      const between = reportedText.slice(runs[0].end, runs[1].start).trim().toLowerCase();
      if (between === "to" || (between.length === 1 && DASHES.has(between.codePointAt(0) as number))) return refuse("range");
    }
    return refuse("multiple_numbers");
  }

  const [run] = runs;
  const refusal = classifyRun(reportedText, run.text, run.start, run.end);
  if (refusal) return refuse(refusal);
  const value = Number(run.text.replace(/,/g, ""));
  if (!Number.isSafeInteger(value) || value < COUNT_MIN || value > COUNT_MAX) return refuse("out_of_range");
  return { kind: "suggestion", value, matchedText: run.text, utf16Start: run.start, utf16End: run.end };
}

/** Group separators a quote may use between thousands: comma, full stop, space, no-break and thin spaces. */
const GROUP_SEPARATORS = new Set([0x2c, 0x2e, 0x20, 0xa0, 0x2009, 0x202f]);

/** Every integer reading of the digits in `quote`: each digit run alone, and each run of thousands groups joined. */
function integerReadings(quote: string): Set<string> {
  const runs = Array.from(quote.matchAll(/[0-9]+/g), (m) => ({ digits: m[0], start: m.index as number }));
  const readings = new Set<string>();
  const canonical = (digits: string) => digits.replace(/^0+(?=[0-9])/, "");
  for (const run of runs) readings.add(canonical(run.digits));
  for (let i = 0; i < runs.length; i++) {
    let joined = runs[i].digits;
    let j = i;
    while (j + 1 < runs.length) {
      const next = runs[j + 1];
      const gapStart = runs[j].start + runs[j].digits.length;
      const separatorOnly = next.start - gapStart === 1 && GROUP_SEPARATORS.has(quote.charCodeAt(gapStart));
      if (!separatorOnly || next.digits.length !== 3) break;
      joined += next.digits;
      readings.add(canonical(joined));
      j += 1;
    }
  }
  return readings;
}

export type CountQuoteCheck =
  | { readonly kind: "appears" }
  | {
      readonly kind: "warning";
      readonly code: "count.digits_absent_from_quote";
      readonly blocking: false;
      readonly message: string;
    };

/**
 * Whether the confirmed number appears in at least one of the quotes. A
 * non-blocking warning otherwise (Requirements-001 §E12: "The number 120
 * doesn't appear in your quote. Check the value or the quote.").
 */
export function checkCountInQuote(value: number, quotes: string | readonly string[]): CountQuoteCheck {
  const list = typeof quotes === "string" ? [quotes] : quotes;
  const wanted = String(value);
  if (list.some((quote) => integerReadings(quote).has(wanted))) return { kind: "appears" };
  return {
    kind: "warning",
    code: "count.digits_absent_from_quote",
    blocking: false,
    message: `The number ${wanted} doesn't appear in your ${list.length > 1 ? "quotes" : "quote"}. Check the value or the quote.`,
  };
}
