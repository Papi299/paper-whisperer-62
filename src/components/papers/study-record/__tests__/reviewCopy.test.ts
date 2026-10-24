// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EVIDENCE_ERROR_SPECS, type EvidenceError, type EvidenceErrorKind } from "@/lib/evidence/errors";
import { CONFIRM_BLOCK_MESSAGES, FLAG_BLOCK_MESSAGES, NO_CURRENT_SUPPORT_EARLIER_COPY_MESSAGE, REVIEW_STATUS_LABELS } from "@/lib/evidence/review";
import { REVIEW_HOLDS } from "@/lib/studyRecord/reviewModel";
import { REVIEW_COPY, REVIEW_HOLD_MESSAGES, reviewErrorText, reviewItemLabel } from "../reviewCopy";
import { STUDY_RECORD_COPY } from "../studyRecordCopy";

/**
 * Review mode's wording (EVIDENCE-RECORDS-001C2A). The sentences the brief
 * gives (§13) are checked word for word; everything else is checked for what
 * it must never say: no verification, accuracy or record-level verdict.
 */

const error = (kind: EvidenceErrorKind, extra: Partial<EvidenceError> = {}): EvidenceError => ({
  kind,
  category: EVIDENCE_ERROR_SPECS[kind].category,
  applied: kind === "transport_uncertain" || kind === "malformed_response" ? "unknown" : "no",
  retry: EVIDENCE_ERROR_SPECS[kind].retry,
  userMessage: EVIDENCE_ERROR_SPECS[kind].userMessage,
  field: null,
  detail: null,
  blocks: null,
  code: null,
  status: null,
  ...extra,
});

/** Every string the review screens show, functions called with sample arguments. */
function allText(): string[] {
  const out: string[] = [];
  for (const value of Object.values(REVIEW_COPY)) {
    if (typeof value === "string") out.push(value);
    else out.push((value as (...args: unknown[]) => string)("‹a›", "‹b›", "‹c›"), (value as (...args: unknown[]) => string)(1, 2, "‹c›"));
  }
  return [...out, ...Object.values(REVIEW_HOLD_MESSAGES), ...Object.values(CONFIRM_BLOCK_MESSAGES), NO_CURRENT_SUPPORT_EARLIER_COPY_MESSAGE];
}

describe("Review wording", () => {
  it("uses the accepted names for the action and the status", () => {
    expect(REVIEW_COPY.confirm).toBe("Confirm against this source");
    expect(REVIEW_STATUS_LABELS.user_reviewed).toBe("Reviewed by you");
    expect(REVIEW_COPY.reviewedOn("Oct 24, 2026")).toBe("Reviewed by you on Oct 24, 2026");
  });

  it("says the brief's sentences word for word", () => {
    expect(CONFIRM_BLOCK_MESSAGES.no_current_support).toBe("Add a quote from the saved abstract or a full-text reference, then save.");
    expect(NO_CURRENT_SUPPORT_EARLIER_COPY_MESSAGE).toBe(
      "Its quotes are in an earlier copy of the abstract. Quote the passage in the current saved copy, or add a full-text reference, then save.",
    );
    expect(CONFIRM_BLOCK_MESSAGES.examined_abstract_not_current).toBe("You examined an earlier copy of the abstract. Read the current saved copy, mark it as examined, then save.");
    expect(CONFIRM_BLOCK_MESSAGES.count_not_confirmed).toBe("Enter the whole number this text reports, then save.");
    expect(CONFIRM_BLOCK_MESSAGES.stale_version).toBe("This field changed after this record was loaded. Reload to review the latest version.");
    expect(STUDY_RECORD_COPY.noSourceGivenHelp).toBe("You can save this, but you can't confirm it until you add a source.");
    expect(REVIEW_COPY.uncertain).toBe("We couldn't tell whether your review was recorded. Try again — it won't be recorded twice.");
    expect(REVIEW_COPY.confirmFlagged).toBe("Confirming replaces your flag and its note.");
  });

  it("says what holds every kind of hold, and what to do about it", () => {
    expect(Object.keys(REVIEW_HOLD_MESSAGES).sort()).toEqual([...REVIEW_HOLDS].sort());
    expect(REVIEW_HOLD_MESSAGES.unsaved_edit).toBe("This field has unsaved changes. Save or undo them to review it.");
    expect(REVIEW_HOLD_MESSAGES.group_removal_pending).toBe("This group will be removed when you save. Undo the removal to review its values.");
    for (const message of Object.values(REVIEW_HOLD_MESSAGES)) expect(message).toMatch(/\.$/);
  });

  it("words every refusal a review can get, never from the server's text", () => {
    const kinds = Object.keys(EVIDENCE_ERROR_SPECS) as EvidenceErrorKind[];
    for (const kind of kinds) {
      const text = reviewErrorText(error(kind));
      expect(text.length, kind).toBeGreaterThan(10);
      expect(text, kind).not.toMatch(/evidence_|P0001|SQL|null/);
    }
    // An unknown outcome, and a refusal worth resending as is: Try again, and it won't be recorded twice.
    expect(reviewErrorText(error("transport_uncertain"))).toBe(REVIEW_COPY.uncertain);
    expect(reviewErrorText(error("malformed_response"))).toBe(REVIEW_COPY.uncertain);
    expect(reviewErrorText(error("database_busy"))).toBe("The database was busy, so your review wasn't recorded. Try again — it won't be recorded twice.");
    expect(reviewErrorText(error("auth_required"))).toBe(EVIDENCE_ERROR_SPECS.auth_required.userMessage);
    // A value changed since loading, or the record: reload to review the latest version.
    expect(reviewErrorText(error("version_conflict", { detail: { parameter: "expectedValueVersion", path: [], rules: [] } }))).toBe(CONFIRM_BLOCK_MESSAGES.stale_version);
    expect(reviewErrorText(error("version_conflict"))).toBe("This study record was changed in another tab or window. Reload to review the latest version.");
    expect(reviewErrorText(error("confirm_blocked"))).toBe("This value can't be confirmed yet. Reload to see what it still needs.");
    expect(reviewErrorText(error("target_not_found"))).toBe(REVIEW_COPY.targetMissing);
    expect(reviewErrorText(error("request_id_reused"))).toBe(REVIEW_COPY.targetMissing);
    expect(reviewErrorText(error("invalid_input", { detail: { parameter: "note", path: [], rules: [] } }))).toBe(REVIEW_COPY.noteRefused);
  });

  it("never claims verification, accuracy, completeness or a record-level result", () => {
    for (const text of allText()) expect(text).not.toMatch(/verif|accura|\bcorrect\b|complete|percent|%/i);
    for (const text of Object.values(FLAG_BLOCK_MESSAGES)) expect(text).not.toMatch(/verif|accura/i);
  });

  it("names a card by its field, with the saved name of its group or outcome", () => {
    expect(reviewItemLabel({ fieldKey: "condition", target: { scope: "study" } })).toBe("Condition or health status");
    expect(reviewItemLabel({ fieldKey: "comparator_type", target: { scope: "arm", armId: "x" as never, role: "comparator", name: "Placebo" } })).toBe("Placebo: Comparator type");
    expect(reviewItemLabel({ fieldKey: "comparator_type", target: { scope: "arm", armId: "x" as never, role: "comparator", name: "" } })).toBe("Comparator group: Comparator type");
    expect(reviewItemLabel({ fieldKey: "time_points", target: { scope: "outcome", outcomeId: "y" as never, name: "Body weight" } })).toBe("Body weight: Time points as reported");
  });
});
