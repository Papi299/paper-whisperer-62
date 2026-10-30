// @vitest-environment node
import { describe, expect, it } from "vitest";
import { toPaperId } from "@/lib/evidence/ids";
import { StudyRecordReadError } from "@/lib/studyRecord/read";
import { PAPER_ID } from "@/lib/studyRecord/__tests__/fixtures";
import { libraryStatus, looksAlike, markHiddenCharacters } from "../sourceCompareModel";

/** What the Source pane may say about the library abstract, and how a change shows what can't be seen (C2C-A). */

const cp = (...points: number[]) => String.fromCodePoint(...points);
const PAPER = toPaperId(PAPER_ID)!;
const COPY = "Adults were randomized (n = 120).";
const answer = (abstract: string | null) => ({ paperId: PAPER, abstract });
const read = (overrides: Partial<Parameters<typeof libraryStatus>[0]> = {}) => ({ isFetching: false, isError: false, error: null, data: undefined, ...overrides });

describe("libraryStatus", () => {
  it("is checking while any read is on its way — an earlier answer never stands in for it", () => {
    expect(libraryStatus(read({ isFetching: true }), COPY)).toEqual({ kind: "checking" });
    expect(libraryStatus(read({ isFetching: true, data: answer(COPY) }), COPY)).toEqual({ kind: "checking" });
    expect(libraryStatus(read({ data: undefined }), COPY)).toEqual({ kind: "checking" });
  });

  it("is failed after a failed read, even when an earlier one succeeded: never 'current', never the saved copy", () => {
    expect(libraryStatus(read({ isError: true, error: new StudyRecordReadError("transport", true), data: answer(COPY) }), COPY)).toEqual({ kind: "failed", reason: "transient" });
    expect(libraryStatus(read({ isError: true, error: new StudyRecordReadError("transport", false) }), COPY)).toEqual({ kind: "failed", reason: "refused" });
    expect(libraryStatus(read({ isError: true, error: new StudyRecordReadError("integrity", false) }), COPY)).toEqual({ kind: "failed", reason: "integrity" });
    // Anything else that isn't a read error is treated as worth trying again.
    expect(libraryStatus(read({ isError: true, error: new Error("unexpected") }), COPY)).toEqual({ kind: "failed", reason: "transient" });
  });

  it("is unavailable when the paper can't be read — not 'removed'", () => {
    expect(libraryStatus(read({ data: null }), COPY)).toEqual({ kind: "unavailable" });
  });

  it("classifies a finished read with the domain's source states", () => {
    expect(libraryStatus(read({ data: answer(COPY) }), COPY)).toMatchObject({ kind: "ready", state: { kind: "current" } });
    expect(libraryStatus(read({ data: answer(COPY.replace(" were ", `${cp(0x00a0)}were `)) }), COPY)).toMatchObject({ kind: "ready", state: { kind: "typography_only_change", capture: "allowed" } });
    expect(libraryStatus(read({ data: answer(COPY.replace("120", "118")) }), COPY)).toMatchObject({ kind: "ready", state: { kind: "content_change", capture: "allowed" } });
    expect(libraryStatus(read({ data: answer(null) }), COPY)).toMatchObject({ kind: "ready", abstract: null, state: { kind: "abstract_removed" } });
    expect(libraryStatus(read({ data: answer(COPY) }), null)).toMatchObject({ kind: "ready", state: { kind: "abstract_now_available", capture: "allowed" } });
    expect(libraryStatus(read({ data: answer("x".repeat(50_001)) }), COPY)).toMatchObject({ kind: "ready", state: { kind: "content_change", capture: "refused_too_long" } });
  });
});

describe("markHiddenCharacters", () => {
  const joined = (text: string) => markHiddenCharacters(text).map((piece) => (piece.kind === "text" ? piece.text : `[${piece.label}]`)).join("");

  it("names every character of a side made only of white space and invisible characters", () => {
    expect(joined(" ")).toBe("[space]");
    expect(joined("\n")).toBe("[line break]");
    expect(joined("  ")).toBe("[space][space]");
    expect(joined(cp(0x00a0))).toBe("[no-break space]");
    expect(joined(`${cp(0x00ad)}${cp(0x200b)}`)).toBe("[soft hyphen][zero-width space]");
    expect(joined(cp(0x2005))).toBe("[space U+2005]");
    expect(joined(cp(0x200d))).toBe("[invisible character U+200D]");
  });

  it("in a side with text, shows ordinary spaces and line breaks as themselves and names the rest", () => {
    expect(joined("the cat")).toBe("the cat");
    expect(joined("end.\nNext")).toBe("end.\nNext");
    expect(joined(`10${cp(0x2009)}mg`)).toBe("10[thin space]mg");
    expect(joined(`in${cp(0x00ad)}formation`)).toBe("in[soft hyphen]formation");
    expect(joined("a\tb")).toBe("a[tab]b");
  });

  it("keeps every visible character, in order", () => {
    const text = `p${cp(0x2009)}<${cp(0x2009)}0.05 ${cp(0x1f600)} cafe${cp(0x0301)}`;
    const visible = markHiddenCharacters(text)
      .filter((piece) => piece.kind === "text")
      .map((piece) => (piece.kind === "text" ? piece.text : ""))
      .join("");
    expect(visible).toBe(text.split(cp(0x2009)).join(""));
  });
});

describe("looksAlike", () => {
  it("is true for the same letters stored differently, and for the micro sign and mu", () => {
    expect(looksAlike(`caf${cp(0x00e9)}`, `cafe${cp(0x0301)}`)).toBe(true);
    expect(looksAlike(`5 ${cp(0x00b5)}g`, `5 ${cp(0x03bc)}g`)).toBe(true);
  });

  it("is false for anything else: equal, empty, or a superscript against a digit", () => {
    expect(looksAlike("a", "a")).toBe(false);
    expect(looksAlike("", "a")).toBe(false);
    expect(looksAlike(`m${cp(0x00b2)}`, "m2")).toBe(false);
    expect(looksAlike("-", cp(0x2013))).toBe(false);
  });
});
