// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ABSTRACT_MAX_LENGTH, deriveSourceState, expectSourceCapture, SOURCE_STATE_MESSAGES, SOURCE_TOO_LONG_MESSAGE } from "../sources";
import { cp } from "./fixtures/vectors";

/** The saved copy versus the library abstract (001A §E2) and capture at creation (PR-A2). */

const ABSTRACT = "Adults with type 2 diabetes were randomized (n = 120).";

describe("expectSourceCapture — the create RPC's own order", () => {
  it("saves a copy of an abstract", () => {
    expect(expectSourceCapture(ABSTRACT)).toEqual({ kind: "copy" });
    expect(expectSourceCapture("x".repeat(ABSTRACT_MAX_LENGTH))).toEqual({ kind: "copy" });
  });

  it("saves no copy without an abstract, or for one empty after v1", () => {
    expect(expectSourceCapture(null)).toEqual({ kind: "no_copy", reason: "no_abstract" });
    expect(expectSourceCapture("")).toEqual({ kind: "no_copy", reason: "empty_after_normalization" });
    expect(expectSourceCapture(` ${cp(0x00ad)}${cp(0x200b)}\n`)).toEqual({ kind: "no_copy", reason: "empty_after_normalization" });
  });

  it("refuses an abstract over 50,000 characters BEFORE checking emptiness, as the RPC does", () => {
    expect(expectSourceCapture("x".repeat(ABSTRACT_MAX_LENGTH + 1))).toEqual({ kind: "refused", reason: "abstract_too_long" });
    expect(expectSourceCapture(" ".repeat(ABSTRACT_MAX_LENGTH + 1))).toEqual({ kind: "refused", reason: "abstract_too_long" });
    // Characters, not UTF-16 units.
    expect(expectSourceCapture(cp(0x1f600).repeat(ABSTRACT_MAX_LENGTH))).toEqual({ kind: "copy" });
  });
});

describe("deriveSourceState", () => {
  it("is Current when the library abstract equals the saved copy exactly", () => {
    expect(deriveSourceState(ABSTRACT, ABSTRACT)).toEqual({ kind: "current" });
  });

  it("keeps the saved copy by default for a typography-only change", () => {
    const retyped = ABSTRACT.replace(" were ", `${cp(0x00a0)}were${cp(0x2009)}`).replace("(n = 120)", "(n = 120)");
    expect(deriveSourceState(ABSTRACT, retyped)).toEqual({ kind: "typography_only_change", defaultAction: "keep_saved_copy", capture: "allowed" });
    expect(deriveSourceState("12-14 weeks", `12${cp(0x2013)}14 weeks`).kind).toBe("typography_only_change");
  });

  it("reports a change of content", () => {
    expect(deriveSourceState(ABSTRACT, ABSTRACT.replace("120", "118"))).toEqual({ kind: "content_change", capture: "allowed" });
    expect(deriveSourceState(ABSTRACT, ABSTRACT.toUpperCase()).kind).toBe("content_change");
  });

  it("normalizes each text once: a change only a second pass would hide is a content change", () => {
    expect(deriveSourceState(`e${cp(0x00ad)}${cp(0x0301)}tude`, `${cp(0x00e9)}tude`).kind).toBe("content_change");
  });

  it("covers a link without a copy and an abstract that disappeared", () => {
    expect(deriveSourceState(null, null)).toEqual({ kind: "no_copy_no_abstract" });
    expect(deriveSourceState(null, "  ")).toEqual({ kind: "no_copy_no_abstract" });
    expect(deriveSourceState(null, ABSTRACT)).toEqual({ kind: "abstract_now_available", capture: "allowed" });
    expect(deriveSourceState(null, "x".repeat(ABSTRACT_MAX_LENGTH + 1))).toEqual({ kind: "abstract_now_available", capture: "refused_too_long" });
    expect(deriveSourceState(ABSTRACT, null)).toEqual({ kind: "abstract_removed" });
    expect(deriveSourceState(ABSTRACT, cp(0xfeff))).toEqual({ kind: "abstract_removed" });
  });

  it("has banner copy for every state that shows one", () => {
    expect(SOURCE_STATE_MESSAGES.current).toBeNull();
    expect(SOURCE_STATE_MESSAGES.typography_only_change).toContain("only in characters PaperLume's quote matching treats as the same");
    expect(SOURCE_STATE_MESSAGES.typography_only_change).toContain("This is a technical comparison, not a check that the two say the same thing.");
    expect(SOURCE_STATE_MESSAGES.typography_only_change).toContain("Your record keeps its saved copy");
    expect(SOURCE_STATE_MESSAGES.abstract_now_available).toBe(
      "This paper now has an abstract in your library, but this record has no saved copy of it, so it can't be quoted.",
    );
    expect(SOURCE_TOO_LONG_MESSAGE).toContain("longer than 50,000 characters");
  });

  it("promises no action: no sentence tells the user to save, use, replace or update a copy (C2C-A has none to offer)", () => {
    for (const message of [...Object.values(SOURCE_STATE_MESSAGES), SOURCE_TOO_LONG_MESSAGE]) {
      for (const sentence of (message ?? "").split(/(?<=\.) /)) expect(sentence).not.toMatch(/^(save|use|replace|update|choose|review and save)\b/i);
    }
  });
});

/**
 * G1 (EVIDENCE-RECORDS-001C2C-DESIGN-AUDIT-001 §D): a copy holds at most 50,000
 * characters, so an abstract over that is never represented as one a copy could
 * be made of — whichever way it differs from the saved copy. Characters are code
 * points, PostgreSQL's char_length, not UTF-16 units.
 */
describe("deriveSourceState — an abstract too long for a copy, in every state that could lead to one", () => {
  const LONG = "x".repeat(ABSTRACT_MAX_LENGTH + 1);

  it("refuses a first copy of an abstract over the limit", () => {
    expect(deriveSourceState(null, LONG)).toEqual({ kind: "abstract_now_available", capture: "refused_too_long" });
    expect(deriveSourceState(null, "x".repeat(ABSTRACT_MAX_LENGTH))).toEqual({ kind: "abstract_now_available", capture: "allowed" });
  });

  it("refuses a changed abstract over the limit", () => {
    expect(deriveSourceState(ABSTRACT, `${ABSTRACT} ${LONG}`)).toEqual({ kind: "content_change", capture: "refused_too_long" });
    expect(deriveSourceState(ABSTRACT, `${ABSTRACT} ${"x".repeat(ABSTRACT_MAX_LENGTH - ABSTRACT.length - 1)}`)).toEqual({ kind: "content_change", capture: "allowed" });
  });

  it("refuses a typography-only change over the limit: v1 collapses white space, so a library abstract can be longer than its saved copy and still equal after v1", () => {
    const saved = "a b";
    const padded = `a${" ".repeat(ABSTRACT_MAX_LENGTH)}b`;
    expect(Array.from(padded).length).toBe(ABSTRACT_MAX_LENGTH + 2);
    expect(deriveSourceState(saved, padded)).toEqual({ kind: "typography_only_change", defaultAction: "keep_saved_copy", capture: "refused_too_long" });
    // Invisible characters count too: v1 removes them, char_length does not.
    const hidden = `a${cp(0x200b).repeat(ABSTRACT_MAX_LENGTH)} b`;
    expect(deriveSourceState(saved, hidden)).toEqual({ kind: "typography_only_change", defaultAction: "keep_saved_copy", capture: "refused_too_long" });
  });

  it("counts characters, not UTF-16 units: 50,000 astral characters fit", () => {
    const astral = cp(0x1f600).repeat(ABSTRACT_MAX_LENGTH);
    expect(astral.length).toBe(ABSTRACT_MAX_LENGTH * 2);
    expect(deriveSourceState("a", astral)).toEqual({ kind: "content_change", capture: "allowed" });
    expect(deriveSourceState("a", `${astral}${cp(0x1f600)}`)).toEqual({ kind: "content_change", capture: "refused_too_long" });
  });

  it("never needs the gate where no copy could follow", () => {
    // Equal texts: the saved copy already fits. Removed or empty: nothing to copy.
    expect(deriveSourceState(ABSTRACT, ABSTRACT)).toEqual({ kind: "current" });
    expect(deriveSourceState(ABSTRACT, " ".repeat(ABSTRACT_MAX_LENGTH + 1))).toEqual({ kind: "abstract_removed" });
    expect(deriveSourceState(null, " ".repeat(ABSTRACT_MAX_LENGTH + 1))).toEqual({ kind: "no_copy_no_abstract" });
  });
});

describe("deriveSourceState — Unicode and white-space edges", () => {
  it("tells exact equality from equality after v1", () => {
    // Composed and decomposed: equal after NFC only.
    expect(deriveSourceState(`caf${cp(0x00e9)}`, `cafe${cp(0x0301)}`).kind).toBe("typography_only_change");
    // The micro sign and the Greek mu: equal after v1 only.
    expect(deriveSourceState(`5 ${cp(0x00b5)}g`, `5 ${cp(0x03bc)}g`).kind).toBe("typography_only_change");
    // Line breaks, tabs and no-break spaces: one space after v1.
    expect(deriveSourceState("a b", `a\n\t${cp(0x00a0)}b`).kind).toBe("typography_only_change");
    // Leading and trailing white space and invisible characters: trimmed and removed by v1.
    expect(deriveSourceState("a b", ` ${cp(0xfeff)}a b${cp(0x00ad)}\n`).kind).toBe("typography_only_change");
    // An ellipsis and three full stops.
    expect(deriveSourceState("and so on...", `and so on${cp(0x2026)}`).kind).toBe("typography_only_change");
  });

  it("reports what v1 keeps as a change of content", () => {
    // A removed space between two words, a changed digit, a changed letter case, a different letter that looks alike.
    expect(deriveSourceState("a b", "ab").kind).toBe("content_change");
    expect(deriveSourceState("n = 120", "n = 121").kind).toBe("content_change");
    expect(deriveSourceState("Type 2", "type 2").kind).toBe("content_change");
    expect(deriveSourceState("Oxygen", `${cp(0x039f)}xygen`).kind).toBe("content_change");
    // A superscript two is not a two: v1 applies NFC, never NFKC.
    expect(deriveSourceState(`m${cp(0x00b2)}`, "m2").kind).toBe("content_change");
  });
});
