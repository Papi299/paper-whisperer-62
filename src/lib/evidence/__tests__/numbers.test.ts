// @vitest-environment node
import { describe, expect, it } from "vitest";

import { checkCountInQuote, suggestCount, type CountRefusal } from "../numbers";
import { cp } from "./fixtures/vectors";

/**
 * Number suggestions (Requirements-001 §H3, §E4, §E12): conservative — one
 * plain count or nothing — and the non-blocking digit-not-in-quote warning.
 */

describe("suggestCount — clear counts", () => {
  it.each([
    ["1,204", 1204, "1,204"],
    ["n = 120", 120, "120"],
    ["N=120", 120, "120"],
    ["(n = 1,204)", 1204, "1,204"],
    ["120 participants", 120, "120"],
    ["120.", 120, "120"],
    ["0", 0, "0"],
    ["10,000,000", 10_000_000, "10,000,000"],
    ["randomized: 87", 87, "87"],
  ])("suggests %j -> %i", (text, value, matched) => {
    expect(suggestCount(text)).toEqual({ kind: "suggestion", value, matchedText: matched, utf16Start: text.indexOf(matched), utf16End: text.indexOf(matched) + matched.length });
  });
});

describe("suggestCount — never a guess", () => {
  it.each<[string, CountRefusal]>([
    ["", "empty"],
    ["   ", "empty"],
    ["one hundred twenty", "no_digits"],
    [`${cp(0x0661)}${cp(0x0662)}${cp(0x0660)}`, "non_ascii_digits"],
    [`${cp(0xff11)}${cp(0xff12)}${cp(0xff10)}`, "non_ascii_digits"],
    ["120 (60 per group)", "multiple_numbers"],
    ["118 or 120", "multiple_numbers"],
    ["COVID-19 patients (n = 120)", "multiple_numbers"],
    ["100-120", "range"],
    [`100${cp(0x2013)}120`, "range"],
    ["100 to 120", "range"],
    ["12.5", "decimal"],
    ["1,204.5", "decimal"],
    ["1.204", "decimal"],
    ["-5", "negative"],
    [`${cp(0x2212)}5`, "negative"],
    ["45%", "percentage"],
    ["45 %", "percentage"],
    ["45 percent", "percentage"],
    ["45 per cent", "percentage"],
    ["120 mg", "unit"],
    ["120mg", "unit"],
    ["12 weeks", "unit"],
    [`37 ${cp(0x00b0)}C`, "unit"],
    [`5 ${cp(0x00b5)}g`, "unit"],
    ["> 120", "qualified"],
    ["~120", "qualified"],
    [`${cp(0x2248)}120`, "qualified"],
    [`${cp(0x2265)} 120`, "qualified"],
    [`10${cp(0x2075)}`, "exponent"],
    ["10^5", "multiple_numbers"],
    ["5th", "attached_to_word"],
    ["COVID-19", "attached_to_word"],
    ["H1N1", "multiple_numbers"],
    ["NCT0123", "attached_to_word"],
    ["120-day", "attached_to_word"],
    ["12,34", "malformed_grouping"],
    ["1,2345", "malformed_grouping"],
    ["0,120", "malformed_grouping"],
    ["007", "leading_zero"],
    ["10,000,001", "out_of_range"],
    ["99999999999", "out_of_range"],
  ])("gives no suggestion for %j (%s)", (text, reason) => {
    expect(suggestCount(text)).toEqual({ kind: "no_suggestion", reason });
  });

  it("never coerces a non-string", () => {
    expect(suggestCount(120 as unknown as string)).toEqual({ kind: "no_suggestion", reason: "empty" });
  });
});

describe("checkCountInQuote — a warning, never a block", () => {
  it("finds the number under every plausible reading of the quote", () => {
    expect(checkCountInQuote(1204, "(n = 1,204)")).toEqual({ kind: "appears" });
    expect(checkCountInQuote(1204, `n = 1${cp(0x2009)}204`)).toEqual({ kind: "appears" });
    expect(checkCountInQuote(10_000_000, "10,000,000 people")).toEqual({ kind: "appears" });
    expect(checkCountInQuote(120, "120 of 240 were randomized")).toEqual({ kind: "appears" });
    expect(checkCountInQuote(0, "0 adverse events")).toEqual({ kind: "appears" });
    expect(checkCountInQuote(120, ["no number here", "n = 120"])).toEqual({ kind: "appears" });
  });

  it("warns when the digits are absent, without matching a longer number", () => {
    expect(checkCountInQuote(120, "1204 participants")).toEqual({
      kind: "warning",
      code: "count.digits_absent_from_quote",
      blocking: false,
      message: "The number 120 doesn't appear in your quote. Check the value or the quote.",
    });
    expect(checkCountInQuote(120, "one hundred twenty").kind).toBe("warning");
    expect(checkCountInQuote(120, `${cp(0xff11)}${cp(0xff12)}${cp(0xff10)}`).kind).toBe("warning");
    expect(checkCountInQuote(118, ["n = 120", "120 analysed"])).toMatchObject({ kind: "warning", message: "The number 118 doesn't appear in your quotes. Check the value or the quote." });
  });
});
