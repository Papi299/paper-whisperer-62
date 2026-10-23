import { describe, expect, it } from "vitest";
import { locateQuote } from "@/lib/evidence/matcher";
import { toPaperId, toSnapshotId } from "@/lib/evidence/ids";
import { NOT_RECORDED_EDIT, type DraftValueEdit, type NewReference } from "../draft";
import { addQuoteToEdit, matchProblem, QUOTE_MESSAGES, quoteChoiceFromSelection } from "../quotes";
import { ABSTRACT, PAPER_ID, REPEATED_PHRASE, SNAPSHOT_ID, THIN_SPACE } from "./fixtures";

/**
 * Turning saved-abstract text into a quote (EVIDENCE-RECORDS-001C1). The
 * browser only advises: what a choice carries is the text exactly as selected
 * or typed, plus — for a repeated passage — the occurrence the user chose and
 * the count they saw. Never an offset.
 */

const select = (text: string, from = 0) => {
  const start = ABSTRACT.indexOf(text, from);
  expect(start, `fixture contains ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
  return { start, end: start + text.length };
};

describe("quoteChoiceFromSelection", () => {
  it("keeps the exact selected text, thin spaces and superscripts included", () => {
    const passage = `0.8${THIN_SPACE}% (p${THIN_SPACE}<${THIN_SPACE}0.001)`;
    const choice = quoteChoiceFromSelection(ABSTRACT, select(passage));
    expect(choice).toEqual({ kind: "ready", quoteText: passage, occurrence: null, count: null });
  });

  it("takes the occurrence from the selection itself when the passage repeats", () => {
    const first = quoteChoiceFromSelection(ABSTRACT, select(REPEATED_PHRASE));
    const second = quoteChoiceFromSelection(ABSTRACT, select(REPEATED_PHRASE, ABSTRACT.indexOf(REPEATED_PHRASE) + 1));
    expect(first).toEqual({ kind: "ready", quoteText: REPEATED_PHRASE, occurrence: 1, count: 2 });
    expect(second).toEqual({ kind: "ready", quoteText: REPEATED_PHRASE, occurrence: 2, count: 2 });
  });

  it("refuses a selection that is too short or has no letter or number", () => {
    expect(quoteChoiceFromSelection(ABSTRACT, select("% ("))).toEqual({ kind: "invalid", message: QUOTE_MESSAGES.invalid });
    expect(quoteChoiceFromSelection(ABSTRACT, select("Re"))).toEqual({ kind: "invalid", message: QUOTE_MESSAGES.invalid });
    expect(quoteChoiceFromSelection(ABSTRACT, select("1:1"))).toEqual({ kind: "ready", quoteText: "1:1", occurrence: null, count: null });
  });

  it("refuses a selection outside the copy or splitting a character", () => {
    expect(quoteChoiceFromSelection(ABSTRACT, { start: 5, end: 5 })).toEqual({ kind: "invalid", message: QUOTE_MESSAGES.selection });
    expect(quoteChoiceFromSelection(ABSTRACT, { start: 0, end: ABSTRACT.length + 1 })).toEqual({ kind: "invalid", message: QUOTE_MESSAGES.selection });
    const astral = `ab${String.fromCodePoint(0x1d4b3)}cd`;
    expect(quoteChoiceFromSelection(astral, { start: 0, end: 3 })).toEqual({ kind: "invalid", message: QUOTE_MESSAGES.selection });
  });

  it("never carries an offset of any kind", () => {
    const choice = quoteChoiceFromSelection(ABSTRACT, select(REPEATED_PHRASE));
    expect(Object.keys(choice).sort()).toEqual(["count", "kind", "occurrence", "quoteText"]);
  });
});

describe("matchProblem (typed quotes)", () => {
  it("names each refusal specifically", () => {
    expect(matchProblem(locateQuote("ab", ABSTRACT))).toBe(QUOTE_MESSAGES.invalid);
    expect(matchProblem(locateQuote("x".repeat(1001), ABSTRACT))).toBe(QUOTE_MESSAGES.tooLong);
    expect(matchProblem(locateQuote("insulin glargine", ABSTRACT))).toBe(QUOTE_MESSAGES.notFound);
    expect(matchProblem(locateQuote("a", "a".repeat(10)))).toBe(QUOTE_MESSAGES.invalid);
    expect(matchProblem(locateQuote("aaa", "aaa ".repeat(101)))).toBe(QUOTE_MESSAGES.tooMany);
  });

  it("accepts a unique or a repeated quote", () => {
    expect(matchProblem(locateQuote("metformin or placebo", ABSTRACT))).toBeNull();
    expect(matchProblem(locateQuote(REPEATED_PHRASE, ABSTRACT))).toBeNull();
  });

  it("matches typed text the way the server does: spacing variants of the saved copy", () => {
    // The copy has thin spaces; the user types ordinary ones.
    const match = locateQuote("0.8 % (p < 0.001)", ABSTRACT);
    expect(match.kind).toBe("unique");
  });
});

const reference = (quoteText: string): Extract<NewReference, { purpose: "supports"; sourceKind: "abstract" }> => ({
  purpose: "supports",
  sourceKind: "abstract",
  paperId: toPaperId(PAPER_ID)!,
  snapshotId: toSnapshotId(SNAPSHOT_ID)!,
  quoteText,
  occurrence: null,
  expectedMatchCount: null,
});

describe("addQuoteToEdit", () => {
  it("makes a field not yet recorded Reported, prefilled from the quote (still editable)", () => {
    const applied = addQuoteToEdit(NOT_RECORDED_EDIT, "condition", reference("type 2 diabetes"), "ref_1", "type 2 diabetes");
    expect(applied).toEqual({
      ok: true,
      edit: {
        cleared: false,
        state: "reported",
        stateReason: null,
        content: { shape: "text", text: "type 2 diabetes" },
        note: "",
        references: [{ kind: "new", localId: "ref_1", reference: reference("type 2 diabetes") }],
      },
    });
  });

  it("never fills in a confirmed number: only the reported text is prefilled", () => {
    const applied = addQuoteToEdit(NOT_RECORDED_EDIT, "n_randomized", reference("120 participants"), "ref_1", "120 participants");
    expect(applied.ok && applied.edit.content).toEqual({ shape: "integer_with_reported_text", reportedText: "120 participants", valueText: "" });
  });

  it("keeps what the user already wrote", () => {
    const edit: DraftValueEdit = { ...NOT_RECORDED_EDIT, state: "reported", content: { shape: "text", text: "Mine" } };
    const applied = addQuoteToEdit(edit, "condition", reference("type 2 diabetes"), "ref_2", "type 2 diabetes");
    expect(applied.ok && applied.edit.content).toEqual({ shape: "text", text: "Mine" });
  });

  it("adds a quote to Unclear without changing the state or inventing content", () => {
    const edit: DraftValueEdit = { ...NOT_RECORDED_EDIT, state: "unclear", stateReason: "ambiguous" };
    const applied = addQuoteToEdit(edit, "condition", reference("type 2 diabetes"), "ref_1", "type 2 diabetes");
    expect(applied.ok && applied.edit.state).toBe("unclear");
    expect(applied.ok && applied.edit.content).toBeNull();
  });

  it.each(["not_reported", "not_applicable", "source_unavailable"] as const)("refuses to put a quote on %s (the user changes the state first)", (state) => {
    expect(addQuoteToEdit({ ...NOT_RECORDED_EDIT, state }, "condition", reference("type 2 diabetes"), "ref_1", null)).toEqual({ ok: false, reason: "state" });
  });

  it("refuses a fourth supporting reference", () => {
    let edit: DraftValueEdit = NOT_RECORDED_EDIT;
    for (let i = 1; i <= 3; i += 1) {
      const applied = addQuoteToEdit(edit, "condition", reference(`quote ${i}`), `ref_${i}`, null);
      expect(applied.ok).toBe(true);
      if (applied.ok) edit = { ...applied.edit, expectedValueVersion: null };
    }
    expect(addQuoteToEdit(edit, "condition", reference("quote 4"), "ref_4", null)).toEqual({ ok: false, reason: "limit" });
  });
});
