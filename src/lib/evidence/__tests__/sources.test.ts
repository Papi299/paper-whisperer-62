// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ABSTRACT_MAX_LENGTH, deriveSourceState, expectSourceCapture, SOURCE_STATE_MESSAGES } from "../sources";
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
    expect(deriveSourceState(ABSTRACT, retyped)).toEqual({ kind: "typography_only_change", defaultAction: "keep_saved_copy" });
    expect(deriveSourceState("12-14 weeks", `12${cp(0x2013)}14 weeks`).kind).toBe("typography_only_change");
  });

  it("reports a change of content", () => {
    expect(deriveSourceState(ABSTRACT, ABSTRACT.replace("120", "118")).kind).toBe("content_change");
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
    expect(SOURCE_STATE_MESSAGES.typography_only_change).toContain("Your quotes still match the saved copy.");
    expect(SOURCE_STATE_MESSAGES.abstract_now_available).toBe("This paper now has an abstract. Save a copy to quote from it.");
  });
});
