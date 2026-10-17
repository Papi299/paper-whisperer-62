// @vitest-environment node
import { describe, expect, it } from "vitest";

import * as review from "../review";
import {
  checkConfirm,
  checkFlag,
  CONFIRM_BLOCK_MESSAGES,
  deriveSourceChangeTransitions,
  draftChangesValue,
  draftFromRecordedValue,
  isAbstractDependent,
  predictReviewAfterSave,
  REVIEW_STATUS_LABELS,
  saveClearsReview,
} from "../review";
import { validateValueDraft } from "../validation";
import {
  abstractQuote,
  COPY_A,
  COPY_A_OLD,
  COPY_B,
  examinedAbstract,
  examinedFullText,
  FLAGGED,
  fullTextLocator,
  LINKS,
  NEEDS_REREVIEW,
  PAPER_A,
  PAPER_B,
  recordedValue,
  reviewed,
  unavailable,
} from "./fixtures/records";
import { cp } from "./fixtures/vectors";

/**
 * Human review (Requirements-001 §J2 as amended by 001A §E5-E6, §I and
 * FK-PROOF-001 §J). Only an explicit Confirm of one value at one exact version
 * creates "Reviewed by you".
 */

describe("labels", () => {
  it("uses the honest single-reviewer vocabulary", () => {
    expect(REVIEW_STATUS_LABELS).toEqual({
      unreviewed: "Not reviewed",
      user_reviewed: "Reviewed by you",
      disputed: "Flagged",
      needs_rereview: "Needs re-review",
    });
    expect(JSON.stringify(review)).not.toMatch(/verified/i);
    expect(review.REVIEWED_BY_YOU_MEANING).toContain("PaperLume hasn't checked your interpretation");
  });
});

describe("Confirm: one value, one exact version", () => {
  it("confirms a Reported value with a quote on its link's current copy, binding the version", () => {
    const value = recordedValue({ valueVersion: 4 });
    expect(checkConfirm(value, 4, LINKS)).toEqual({ kind: "allowed", item: { valueId: value.id, valueVersion: 4 } });
  });

  it("refuses a stale version: the field changed since it was opened", () => {
    expect(checkConfirm(recordedValue({ valueVersion: 5 }), 4, LINKS)).toEqual({ kind: "blocked", reasons: ["stale_version"] });
    expect(CONFIRM_BLOCK_MESSAGES.stale_version).toBe("This field changed since you opened it.");
  });

  it("does nothing for a version already reviewed (idempotent)", () => {
    expect(checkConfirm(recordedValue({ valueVersion: 3, review: reviewed(3) }), 3, LINKS)).toEqual({ kind: "already_reviewed" });
  });

  it("cannot confirm what is not recorded", () => {
    expect(checkConfirm(null, 1, LINKS)).toEqual({ kind: "blocked", reasons: ["not_recorded"] });
  });

  it("refuses a Reported value with no source, though its type and bounds are valid", () => {
    const value = recordedValue({ references: [] });
    const draft = draftFromRecordedValue(value);
    expect(validateValueDraft(draft, { designProfile: "rct_parallel", target: { scope: "study" }, links: LINKS }).ok).toBe(true);
    expect(checkConfirm(value, 1, LINKS)).toEqual({ kind: "blocked", reasons: ["no_current_support"] });
  });

  it("does not count a quote on a superseded copy; a full-text locator counts", () => {
    expect(checkConfirm(recordedValue({ references: [abstractQuote(COPY_A_OLD)] }), 1, LINKS)).toEqual({ kind: "blocked", reasons: ["no_current_support"] });
    expect(checkConfirm(recordedValue({ references: [abstractQuote(COPY_A_OLD), fullTextLocator()] }), 1, LINKS).kind).toBe("allowed");
  });

  it("needs the confirmed integer of a number", () => {
    const n = (content: unknown) => recordedValue({ fieldKey: "n_randomized", content: content as never });
    expect(checkConfirm(n({ shape: "integer_with_reported_text", reportedText: "n = 120", value: 120 }), 1, LINKS).kind).toBe("allowed");
    expect(checkConfirm(n({ shape: "integer_with_reported_text", reportedText: "n = 120", value: null }), 1, LINKS)).toEqual({ kind: "blocked", reasons: ["count_not_confirmed"] });
  });

  it("confirms an absence only against the current copy it names", () => {
    const notReported = (reference: ReturnType<typeof examinedAbstract>) => recordedValue({ state: "not_reported", content: null, references: [reference] });
    expect(checkConfirm(notReported(examinedAbstract(COPY_A)), 1, LINKS).kind).toBe("allowed");
    expect(checkConfirm(notReported(examinedAbstract(COPY_A_OLD)), 1, LINKS)).toEqual({ kind: "blocked", reasons: ["examined_abstract_not_current"] });
    expect(checkConfirm(notReported(examinedFullText()), 1, LINKS).kind).toBe("allowed");
  });

  it("confirms an unavailable abstract only while that link still has no copy", () => {
    const value = recordedValue({ state: "source_unavailable", content: null, references: [unavailable("abstract", PAPER_B)] });
    expect(checkConfirm(value, 1, LINKS).kind).toBe("allowed");
    const nowCaptured = LINKS.map((l) => (l.paperId === PAPER_B ? { ...l, currentSnapshotId: COPY_B, snapshotIds: [COPY_B] } : l));
    expect(checkConfirm(value, 1, nowCaptured)).toEqual({ kind: "blocked", reasons: ["unavailable_abstract_has_copy"] });
  });

  it("needs the notes Unclear and Not applicable require", () => {
    const unclear = (note: string, stateReason: "ambiguous" | null = "ambiguous") =>
      recordedValue({ state: "unclear", content: null, stateReason, note, references: [examinedAbstract()] });
    expect(checkConfirm(unclear("abstract gives 120 and 118"), 1, LINKS).kind).toBe("allowed");
    expect(checkConfirm(unclear("vague"), 1, LINKS)).toEqual({ kind: "blocked", reasons: ["note_missing"] });
    expect(checkConfirm(unclear("abstract gives 120 and 118", null), 1, LINKS)).toEqual({ kind: "blocked", reasons: ["state_reason_missing"] });
    const na = (note: string) => recordedValue({ state: "not_applicable", content: null, note, references: [] });
    expect(checkConfirm(na("n/a"), 1, LINKS).kind).toBe("allowed");
    expect(checkConfirm(na("no"), 1, LINKS)).toEqual({ kind: "blocked", reasons: ["note_missing"] });
  });

  it("lets a flagged or needs-re-review value be confirmed when its preconditions hold", () => {
    expect(checkConfirm(recordedValue({ review: FLAGGED }), 1, LINKS).kind).toBe("allowed");
    expect(checkConfirm(recordedValue({ review: NEEDS_REREVIEW }), 1, LINKS).kind).toBe("allowed");
  });
});

describe("no bulk, automatic or record-level confirmation", () => {
  it("exports nothing that confirms several values, all values, or a record", () => {
    const names = Object.keys(review);
    expect(names.filter((n) => /all|bulk|batch|many|record|section|auto/i.test(n) && /confirm|review/i.test(n))).toEqual([]);
    expect(checkConfirm.length).toBe(3);
  });

  it("refuses a list of values passed as one", () => {
    const list = [recordedValue(), recordedValue()];
    expect(checkConfirm(list as never, 1, LINKS).kind).toBe("blocked");
  });
});

describe("Flag", () => {
  it("needs a note of at least 3 characters, in any state", () => {
    const value = recordedValue({ state: "not_reported", content: null, references: [examinedAbstract()] });
    expect(checkFlag(value, 1, "Check the table")).toEqual({ kind: "allowed" });
    expect(checkFlag(value, 1, "no")).toEqual({ kind: "blocked", reasons: ["note_too_short"] });
    expect(checkFlag(value, 1, "  ab  ")).toEqual({ kind: "blocked", reasons: ["note_too_short"] });
    expect(checkFlag(value, 1, `${cp(0x200b)}${cp(0x00a0)}${cp(0x200b)}${cp(0x00a0)}`)).toEqual({ kind: "blocked", reasons: ["note_too_short"] });
    expect(checkFlag(value, 1, "x".repeat(2001))).toEqual({ kind: "blocked", reasons: ["note_too_long"] });
    expect(checkFlag(value, 1, `ab${String.fromCharCode(0xdc00)}`)).toEqual({ kind: "blocked", reasons: ["note_malformed"] });
    expect(checkFlag(value, 2, "Check the table")).toEqual({ kind: "blocked", reasons: ["stale_version"] });
    expect(checkFlag(null, 1, "Check the table")).toEqual({ kind: "blocked", reasons: ["not_recorded"] });
  });
});

describe("any change returns a value to Not reviewed", () => {
  const value = recordedValue({ valueVersion: 2, review: reviewed(2), references: [abstractQuote(), fullTextLocator(), examinedFullText(PAPER_B)] });

  it("reproduces the stored value exactly as a draft", () => {
    expect(draftChangesValue(value, draftFromRecordedValue(value))).toBe(false);
    expect(predictReviewAfterSave(value, draftFromRecordedValue(value))).toEqual({
      status: "user_reviewed",
      reason: null,
      reviewedAt: "2026-10-17T01:00:00Z",
      reviewedVersion: 2,
    });
  });

  it.each([
    ["the value", { content: { shape: "text", text: "Type 1 diabetes" } }],
    ["the state", { state: "unclear", content: null, stateReason: "ambiguous", note: "abstract gives two conditions" }],
    ["the note", { note: "Adults only" }],
    ["a removed source", { references: [] }],
  ] as const)("changing %s clears the review", (_label, change) => {
    const draft = { ...draftFromRecordedValue(value), ...change };
    expect(draftChangesValue(value, draft as never)).toBe(true);
    expect(saveClearsReview(value, draft as never)).toBe(true);
    expect(predictReviewAfterSave(value, draft as never)).toEqual({ status: "unreviewed", reason: null, reviewedAt: null, reviewedVersion: null });
  });

  it("counts reordering supporting sources as a change (their position changes), but not reordering assessments", () => {
    const base = draftFromRecordedValue(value);
    const [quote, loc, assessment] = base.references ?? [];
    expect(draftChangesValue(value, { ...base, references: [loc, quote, assessment] })).toBe(true);
    const twoAssessments = recordedValue({ state: "not_reported", content: null, references: [examinedAbstract(), unavailable("full_text", PAPER_A)] });
    const drafted = draftFromRecordedValue(twoAssessments);
    expect(draftChangesValue(twoAssessments, { ...drafted, references: [...(drafted.references ?? [])].reverse() })).toBe(false);
  });

  it("does not report a cleared review for a value nobody reviewed", () => {
    const unreviewed = recordedValue();
    expect(saveClearsReview(unreviewed, { ...draftFromRecordedValue(unreviewed), note: "changed" })).toBe(false);
  });
});

describe("a replaced or first saved abstract needs re-review (001A §E5, PD-6)", () => {
  it("moves reviewed and flagged values that depend on the abstract to Needs re-review, even if every quote is found again", () => {
    // The transition takes no match result at all: a quote found again in the
    // new copy cannot keep a review.
    const values = [reviewed(1), FLAGGED, NEEDS_REREVIEW, undefined].map((state) =>
      recordedValue({ references: [abstractQuote(COPY_A, PAPER_A)], ...(state ? { review: state } : {}) }),
    );
    const transitions = deriveSourceChangeTransitions(values, { paperId: PAPER_A, kind: "rebase" });
    expect(transitions.map((t) => [t.from, t.to, t.reason, t.changed])).toEqual([
      ["user_reviewed", "needs_rereview", "source_changed", true],
      ["disputed", "needs_rereview", "source_changed", true],
      ["needs_rereview", "needs_rereview", "source_changed", false],
      ["unreviewed", "unreviewed", null, false],
    ]);
  });

  it("depends on any abstract reference of that link — quote, examined copy or unavailable abstract — and nothing else", () => {
    expect(isAbstractDependent(recordedValue({ references: [abstractQuote()] }), PAPER_A)).toBe(true);
    expect(isAbstractDependent(recordedValue({ state: "not_reported", content: null, references: [examinedAbstract()] }), PAPER_A)).toBe(true);
    expect(isAbstractDependent(recordedValue({ references: [fullTextLocator()] }), PAPER_A)).toBe(false);
    expect(isAbstractDependent(recordedValue({ references: [abstractQuote()] }), PAPER_B)).toBe(false);
    const fullTextOnly = recordedValue({ review: reviewed(1), references: [fullTextLocator()] });
    expect(deriveSourceChangeTransitions([fullTextOnly], { paperId: PAPER_A, kind: "rebase" })).toEqual([]);
  });

  it("sends a reviewed 'abstract unavailable' claim to re-review when a first copy is saved", () => {
    const value = recordedValue({ state: "source_unavailable", content: null, review: reviewed(1), references: [unavailable("abstract", PAPER_B)] });
    expect(deriveSourceChangeTransitions([value], { paperId: PAPER_B, kind: "first_capture" })).toEqual([
      { valueId: value.id, from: "user_reviewed", to: "needs_rereview", reason: "source_changed", changed: true },
    ]);
  });
});
