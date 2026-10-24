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
import { VALUE_STATES, type RecordedValue, type StoredReference, type ValueState } from "../types";
import { validateValueDraft, type LinkSources, type ValueContext } from "../validation";
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
import { SECTION_J_ALLOWS, SECTION_J_FORBIDDEN, sectionJConfirmable, type PurposeCounts } from "./fixtures/sectionJ";
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
    // Requirements-001A §I7, dated (EVIDENCE-RECORDS-001C2A).
    expect(review.reviewedByYouMeaning("Oct 24, 2026")).toBe(
      "Reviewed by you — you confirmed this value against the source shown, on Oct 24, 2026. PaperLume hasn't checked your interpretation.",
    );
  });
});

describe("Confirm-block messages (EVIDENCE-RECORDS-001C2A)", () => {
  // Transcribed from the C2A brief §13 and the C2 audit §E12, not from the table under test.
  const EXPECTED: Readonly<Record<keyof typeof CONFIRM_BLOCK_MESSAGES, string>> = {
    not_recorded: "Record this field, then save.",
    stale_version: "This field changed after this record was loaded. Reload to review the latest version.",
    sources_not_allowed: "This field's sources don't fit its state. Edit them, then save.",
    examined_source_missing: "Say which source you examined, then save.",
    unclear_source_missing: "Quote the unclear text, or say which source you examined, then save.",
    unavailable_source_missing: "Say which source you couldn't check, then save.",
    no_current_support: "Add a quote from the saved abstract or a full-text reference, then save.",
    unclear_source_not_current:
      "Its only quotes are in an earlier copy of the abstract. Quote the unclear passage in the current saved copy, or mark a source you examined, then save.",
    count_not_confirmed: "Enter the whole number this text reports, then save.",
    examined_abstract_not_current: "You examined an earlier copy of the abstract. Read the current saved copy, mark it as examined, then save.",
    unavailable_abstract_has_copy:
      "A copy of this paper's abstract was saved after you said it couldn't be checked. Read it, record what it says, then save.",
    note_missing: "Add the required note, then save.",
    state_reason_missing: "Say why this is unclear, then save.",
  };

  it("says what to fix and that the fix must be saved — or, for a stale version, to reload", () => {
    expect(CONFIRM_BLOCK_MESSAGES).toEqual(EXPECTED);
    for (const [block, message] of Object.entries(CONFIRM_BLOCK_MESSAGES)) {
      expect(message, block).toMatch(block === "stale_version" ? /Reload to review the latest version\.$/ : /then save\.$/);
      expect(message, block).not.toMatch(/verif|accurate|correct|confirm/i);
    }
  });

  it("tells a value whose only quotes are on earlier copies that, instead of asking for a quote", () => {
    const earlierOnly = recordedValue({ references: [abstractQuote(COPY_A_OLD)] });
    expect(checkConfirm(earlierOnly, 1, LINKS)).toEqual({ kind: "blocked", reasons: ["no_current_support"] });
    expect(review.confirmBlockMessage("no_current_support", earlierOnly, LINKS)).toBe(review.NO_CURRENT_SUPPORT_EARLIER_COPY_MESSAGE);
    expect(review.NO_CURRENT_SUPPORT_EARLIER_COPY_MESSAGE).toBe(
      "Its quotes are in an earlier copy of the abstract. Quote the passage in the current saved copy, or add a full-text reference, then save.",
    );
    // No quote at all, or only an examined copy: the plain message.
    expect(review.confirmBlockMessage("no_current_support", recordedValue({ references: [] }), LINKS)).toBe(EXPECTED.no_current_support);
    expect(review.confirmBlockMessage("no_current_support", recordedValue({ references: [examinedAbstract(COPY_A_OLD)] }), LINKS)).toBe(EXPECTED.no_current_support);
    expect(review.confirmBlockMessage("no_current_support", null, LINKS)).toBe(EXPECTED.no_current_support);
    // A block the shown references don't explain (the server saw something else): never "earlier copy".
    expect(review.confirmBlockMessage("no_current_support", recordedValue({ references: [abstractQuote(COPY_A)] }), LINKS)).toBe(EXPECTED.no_current_support);
    // Every other block reads from the table, whatever the references.
    for (const block of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
      if (block !== "no_current_support") expect(review.confirmBlockMessage(block, earlierOnly, LINKS)).toBe(EXPECTED[block]);
    }
  });
});

describe("Confirm: one value, one exact version", () => {
  it("confirms a Reported value with a quote on its link's current copy, binding the version", () => {
    const value = recordedValue({ valueVersion: 4 });
    expect(checkConfirm(value, 4, LINKS)).toEqual({ kind: "allowed", item: { valueId: value.id, valueVersion: 4 } });
  });

  it("refuses a stale version: the field changed since it was opened", () => {
    expect(checkConfirm(recordedValue({ valueVersion: 5 }), 4, LINKS)).toEqual({ kind: "blocked", reasons: ["stale_version"] });
    expect(CONFIRM_BLOCK_MESSAGES.stale_version).toBe("This field changed after this record was loaded. Reload to review the latest version.");
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

/**
 * The sources each state must and must not have. Expectations come from
 * FK-PROOF-001 §J as transcribed in `fixtures/sectionJ.ts`, never from the
 * rule table under test. Every reference here is on its link's current copy
 * unless a test says otherwise, so §J alone decides.
 */
describe("Confirm needs the sources its state requires (FK-PROOF-001 §J)", () => {
  const CONTEXT: ValueContext = { designProfile: "rct_parallel", target: { scope: "study" }, links: LINKS };
  /** Paper B's first copy has been saved since the value was recorded. */
  const B_CAPTURED: readonly LinkSources[] = LINKS.map((l) => (l.paperId === PAPER_B ? { ...l, currentSnapshotId: COPY_B, snapshotIds: [COPY_B] } : l));

  /** A value in `state` whose value, reason and note are all in order, so only its sources can block it. */
  const valueIn = (state: ValueState, references: StoredReference[], extra: Parameters<typeof recordedValue>[0] = {}) =>
    recordedValue({
      state,
      content: state === "reported" ? { shape: "text", text: "Type 2 diabetes" } : null,
      stateReason: state === "unclear" ? "ambiguous" : null,
      note: state === "unclear" ? "abstract gives 120 and 118" : state === "not_applicable" ? "Not a trial" : null,
      references,
      ...extra,
    });
  const confirm = (value: RecordedValue, links: readonly LinkSources[] = LINKS) => checkConfirm(value, value.valueVersion, links);
  const validatorErrors = (value: RecordedValue) =>
    validateValueDraft(draftFromRecordedValue(value), CONTEXT).issues.filter((i) => i.severity === "error").map((i) => i.code);

  /** A minimal valid set of sources per state, from §J's table. */
  const VALID: Record<ValueState, () => StoredReference[]> = {
    reported: () => [abstractQuote()],
    not_reported: () => [examinedAbstract()],
    unclear: () => [examinedAbstract()],
    source_unavailable: () => [unavailable("abstract", PAPER_B)],
    not_applicable: () => [],
  };
  /** One more source of each purpose, on a report and source kind none of the VALID sets uses. */
  const ONE_MORE: Record<keyof PurposeCounts, () => StoredReference> = {
    supports: () => fullTextLocator(PAPER_A),
    examined: () => examinedFullText(PAPER_A),
    unavailable: () => unavailable("full_text", PAPER_B),
  };

  it.each(VALUE_STATES)("confirms a %s value that has the sources §J requires", (state) => {
    const value = valueIn(state, VALID[state]());
    expect(validatorErrors(value)).toEqual([]);
    expect(confirm(value)).toEqual({ kind: "allowed", item: { valueId: value.id, valueVersion: 1 } });
  });

  it("refuses Not reported without an examined source: an unavailable source is not an examination", () => {
    for (const references of [[], [unavailable("full_text", PAPER_B)], [unavailable("abstract", PAPER_B)]]) {
      const value = valueIn("not_reported", references);
      expect(confirm(value)).toEqual({ kind: "blocked", reasons: ["examined_source_missing"] });
      expect(validatorErrors(value)).toContain("references.examined_required");
    }
    expect(CONFIRM_BLOCK_MESSAGES.examined_source_missing).toBe("Say which source you examined, then save.");
  });

  it("refuses Unclear with neither a supporting nor an examined source", () => {
    for (const references of [[], [unavailable("full_text", PAPER_B)], [unavailable("abstract", PAPER_B)]]) {
      const value = valueIn("unclear", references);
      expect(confirm(value)).toEqual({ kind: "blocked", reasons: ["unclear_source_missing"] });
      expect(validatorErrors(value)).toContain("references.basis_required");
    }
    expect(CONFIRM_BLOCK_MESSAGES.unclear_source_missing).toBe("Quote the unclear text, or say which source you examined, then save.");
  });

  it("refuses Couldn't check without an unavailable source", () => {
    const value = valueIn("source_unavailable", []);
    expect(confirm(value)).toEqual({ kind: "blocked", reasons: ["unavailable_source_missing"] });
    expect(validatorErrors(value)).toContain("references.unavailable_required");
    expect(CONFIRM_BLOCK_MESSAGES.unavailable_source_missing).toBe("Say which source you couldn't check, then save.");
  });

  it.each(SECTION_J_FORBIDDEN)("refuses %s with a %s source, though everything else is in order", (state, purpose) => {
    expect(confirm(valueIn(state, VALID[state]())).kind).toBe("allowed");
    const value = valueIn(state, [...VALID[state](), ONE_MORE[purpose]()]);
    expect(confirm(value)).toEqual({ kind: "blocked", reasons: ["sources_not_allowed"] });
    expect(validateValueDraft(draftFromRecordedValue(value), CONTEXT).ok).toBe(false);
  });

  it("refuses more than three supporting sources", () => {
    const four = [abstractQuote(), fullTextLocator(PAPER_A), abstractQuote(COPY_A, PAPER_A, "randomized"), fullTextLocator(PAPER_B)];
    expect(confirm(valueIn("reported", four.slice(0, 3))).kind).toBe("allowed");
    expect(confirm(valueIn("reported", four))).toEqual({ kind: "blocked", reasons: ["sources_not_allowed"] });
    expect(CONFIRM_BLOCK_MESSAGES.sources_not_allowed).toBe("This field's sources don't fit its state. Edit them, then save.");
  });

  it("gives every reason at once, in a fixed order", () => {
    const value = valueIn("not_reported", [abstractQuote(), unavailable("abstract", PAPER_B)], { note: null });
    expect(confirm(value, B_CAPTURED)).toEqual({
      kind: "blocked",
      reasons: ["sources_not_allowed", "examined_source_missing", "unavailable_abstract_has_copy"],
    });
  });

  describe("current versus superseded copies", () => {
    it("Reported: only a quote on the current copy, or a full-text locator, counts", () => {
      expect(confirm(valueIn("reported", [abstractQuote(COPY_A)])).kind).toBe("allowed");
      expect(confirm(valueIn("reported", [abstractQuote(COPY_A_OLD)]))).toEqual({ kind: "blocked", reasons: ["no_current_support"] });
      expect(confirm(valueIn("reported", [abstractQuote(COPY_A_OLD), abstractQuote(COPY_A)])).kind).toBe("allowed");
      expect(confirm(valueIn("reported", [abstractQuote(COPY_A_OLD), fullTextLocator()])).kind).toBe("allowed");
    });

    it("Not reported: an examined abstract must be the current copy; an examined full text always is", () => {
      expect(confirm(valueIn("not_reported", [examinedAbstract(COPY_A)])).kind).toBe("allowed");
      expect(confirm(valueIn("not_reported", [examinedAbstract(COPY_A_OLD)]))).toEqual({ kind: "blocked", reasons: ["examined_abstract_not_current"] });
      expect(confirm(valueIn("not_reported", [examinedAbstract(COPY_A_OLD), examinedFullText(PAPER_B)]))).toEqual({
        kind: "blocked",
        reasons: ["examined_abstract_not_current"],
      });
      expect(confirm(valueIn("not_reported", [examinedFullText()])).kind).toBe("allowed");
    });

    it("Unclear: a quote on a superseded copy does not count toward Confirm; an examined source does", () => {
      // Requirements-001A's J1 amendment: only current-copy quotes count toward Confirm.
      const stale = valueIn("unclear", [abstractQuote(COPY_A_OLD)]);
      expect(validatorErrors(stale)).toEqual([]); // a carried-over quote may stay on its copy...
      expect(confirm(stale)).toEqual({ kind: "blocked", reasons: ["unclear_source_not_current"] }); // ...but is not current support
      expect(CONFIRM_BLOCK_MESSAGES.unclear_source_not_current).toBe(
        "Its only quotes are in an earlier copy of the abstract. Quote the unclear passage in the current saved copy, or mark a source you examined, then save.",
      );
      expect(confirm(valueIn("unclear", [abstractQuote(COPY_A)])).kind).toBe("allowed");
      expect(confirm(valueIn("unclear", [abstractQuote(COPY_A_OLD), fullTextLocator()])).kind).toBe("allowed");
      expect(confirm(valueIn("unclear", [abstractQuote(COPY_A_OLD), examinedFullText()])).kind).toBe("allowed");
      expect(confirm(valueIn("unclear", [examinedAbstract(COPY_A_OLD)]))).toEqual({ kind: "blocked", reasons: ["examined_abstract_not_current"] });
    });

    it("Couldn't check: an unavailable abstract holds only while its link has no copy; an unavailable full text does not depend on it", () => {
      const value = valueIn("source_unavailable", [unavailable("abstract", PAPER_B)]);
      expect(confirm(value).kind).toBe("allowed");
      expect(confirm(value, B_CAPTURED)).toEqual({ kind: "blocked", reasons: ["unavailable_abstract_has_copy"] });
      expect(confirm(valueIn("source_unavailable", [unavailable("full_text", PAPER_A)])).kind).toBe("allowed");
    });

    it("applies the copy rules in every state that has such a source, not only in Couldn't check", () => {
      for (const state of ["not_reported", "unclear"] as const) {
        const value = valueIn(state, [examinedFullText(), unavailable("abstract", PAPER_B)]);
        expect(confirm(value).kind, state).toBe("allowed");
        expect(confirm(value, B_CAPTURED), state).toEqual({ kind: "blocked", reasons: ["unavailable_abstract_has_copy"] });
      }
    });
  });

  describe("version and earlier reviews", () => {
    it("refuses a stale version before judging sources: the user must reload first", () => {
      const lacking = valueIn("not_reported", [], { valueVersion: 3 });
      expect(checkConfirm(lacking, 2, LINKS)).toEqual({ kind: "blocked", reasons: ["stale_version"] });
      expect(checkConfirm(lacking, 3, LINKS)).toEqual({ kind: "blocked", reasons: ["examined_source_missing"] });
    });

    it("treats a version already reviewed as a no-op that binds nothing", () => {
      const value = valueIn("not_reported", [examinedAbstract()], { valueVersion: 3, review: reviewed(3) });
      expect(checkConfirm(value, 3, LINKS)).toEqual({ kind: "already_reviewed" });
    });

    it("does not carry a review of an earlier version over: the current version is judged afresh", () => {
      const lacking = valueIn("not_reported", [], { valueVersion: 3, review: reviewed(2) });
      expect(checkConfirm(lacking, 3, LINKS)).toEqual({ kind: "blocked", reasons: ["examined_source_missing"] });
      const complete = valueIn("not_reported", [examinedAbstract()], { valueVersion: 3, review: reviewed(2) });
      expect(checkConfirm(complete, 3, LINKS)).toEqual({ kind: "allowed", item: { valueId: complete.id, valueVersion: 3 } });
    });

    it("blocks a flagged or needs-re-review value that lacks the sources its state requires", () => {
      for (const review of [FLAGGED, NEEDS_REREVIEW]) {
        expect(confirm(valueIn("not_reported", [], { review }))).toEqual({ kind: "blocked", reasons: ["examined_source_missing"] });
        expect(confirm(valueIn("unclear", [], { review }))).toEqual({ kind: "blocked", reasons: ["unclear_source_missing"] });
        expect(confirm(valueIn("source_unavailable", [], { review }))).toEqual({ kind: "blocked", reasons: ["unavailable_source_missing"] });
      }
    });
  });

  it("counts a required note only when it is well formed and not blank after v1, as the validator requires", () => {
    const blankNa = valueIn("not_applicable", [], { note: cp(0x00a0).repeat(3) });
    expect(validatorErrors(blankNa)).toContain("note.blank");
    expect(confirm(blankNa)).toEqual({ kind: "blocked", reasons: ["note_missing"] });
    expect(confirm(valueIn("unclear", [examinedAbstract()], { note: cp(0x00a0).repeat(10) }))).toEqual({ kind: "blocked", reasons: ["note_missing"] });
    // Malformed text is refused, not thrown on.
    expect(confirm(valueIn("not_applicable", [], { note: `n/a${String.fromCharCode(0xd800)}` }))).toEqual({ kind: "blocked", reasons: ["note_missing"] });
  });

  it("agrees with §J, and with validateValueDraft, for every count of every purpose", () => {
    // Current sources of each purpose, each on its own report and source kind, as stored values are.
    const SUPPORTS = [() => abstractQuote(), () => fullTextLocator(PAPER_A), () => abstractQuote(COPY_A, PAPER_A, "randomized"), () => fullTextLocator(PAPER_B)];
    const EXAMINED = [() => examinedAbstract(), () => examinedFullText(PAPER_A)];
    const UNAVAILABLE = [() => unavailable("full_text", PAPER_B), () => unavailable("abstract", PAPER_B)];
    let cells = 0;
    for (const state of VALUE_STATES) {
      for (let supports = 0; supports <= SUPPORTS.length; supports++) {
        for (let examined = 0; examined <= EXAMINED.length; examined++) {
          for (let unavailableCount = 0; unavailableCount <= UNAVAILABLE.length; unavailableCount++) {
            const counts: PurposeCounts = { supports, examined, unavailable: unavailableCount };
            const make = [...SUPPORTS.slice(0, supports), ...EXAMINED.slice(0, examined), ...UNAVAILABLE.slice(0, unavailableCount)];
            const value = valueIn(state, make.map((build) => build()));
            const at = `${state} with ${supports}/${examined}/${unavailableCount}`;
            const validation = validateValueDraft(draftFromRecordedValue(value), CONTEXT);
            const result = confirm(value);
            expect(validation.ok, at).toBe(SECTION_J_ALLOWS[state](counts));
            expect(result.kind, at).toBe(sectionJConfirmable(state, counts) ? "allowed" : "blocked");
            if (!validation.ok) expect(result.kind, at).toBe("blocked");
            cells += 1;
          }
        }
      }
    }
    expect(cells).toBe(VALUE_STATES.length * 5 * 3 * 3);
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
