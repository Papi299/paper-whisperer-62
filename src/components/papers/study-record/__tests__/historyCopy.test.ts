import { describe, expect, it } from "vitest";
import { mapEventRow } from "@/lib/evidence/records";
import { EVENT_TYPES, REQUEST_OPS } from "@/lib/evidence/types";
import { describeHistoryChange, historyContextOf, type HistoryChange, type HistoryContext } from "@/lib/studyRecord/historyModel";
import { assemble, fullRows, PAPER_TITLE } from "@/lib/studyRecord/__tests__/fixtures";
import { historyRows, type EventRow } from "@/lib/studyRecord/__tests__/historyFixtures";
import { describeChangeText, formatHistoryTime, HISTORY_COPY, HISTORY_OPERATION_TITLES, HISTORY_UNREADABLE_TITLES, historyFieldName, sourcesSummary } from "../historyCopy";

/**
 * History's wording (EVIDENCE-RECORDS-001C2B): what each recorded change says,
 * and the lines it may never cross — no fingerprint, id or request internals
 * on screen, no claim of verification, and today's names always called today's.
 */

const CONTEXT: HistoryContext = historyContextOf(assemble(fullRows()));

function textOf(row: EventRow, context = CONTEXT) {
  const mapped = mapEventRow(row);
  if (!mapped.ok) throw new Error("fixture row does not map");
  return describeChangeText(describeHistoryChange(mapped.value, context));
}
const fixture = (version: number, ordinal: number) => historyRows().find((row) => row.study_version === version && row.ordinal === ordinal)!;
const allText = () =>
  historyRows()
    .filter((row) => row.ordinal > 0)
    .map((row) => textOf(row))
    .flatMap((text) => [text.text, ...text.details]);

describe("titles", () => {
  it("names every committed operation, and only those", () => {
    expect(Object.keys(HISTORY_OPERATION_TITLES).sort()).toEqual([...REQUEST_OPS].sort());
    expect(HISTORY_OPERATION_TITLES).toEqual({
      create_study: "Study record created",
      update_study: "Study details updated",
      save_changes: "Changes saved",
      review_fields: "Review recorded",
      set_link: "Linked paper changed",
      rebase_source: "Copy of the library abstract saved",
    });
  });

  it("has a plain line for every change type — the fallback says what the type says and nothing more", () => {
    expect(Object.keys(HISTORY_UNREADABLE_TITLES).sort()).toEqual(EVENT_TYPES.filter((type) => type !== "request").sort());
  });
});

describe("each recorded change, in words", () => {
  it.each<[string, number, number, string, readonly string[]]>([
    ["creation", 1, 1, "Study record created as “Doe 2024”", ["Kind of study: Randomized trial, parallel groups"]],
    ["the first link", 1, 2, `Linked to the paper now titled “${PAPER_TITLE}”, as confirmed by you`, []],
    ["the first copy", 1, 3, `Saved a copy of the abstract of the paper now titled “${PAPER_TITLE}”`, ["Copy 1, 412 characters. History doesn't keep the copy's text."]],
    ["a group added", 2, 1, "Added intervention group “Metformin”", []],
    ["an outcome added", 2, 3, "Added outcome “Body weight”", []],
    [
      "a new text value",
      2,
      4,
      "Condition or health status: recorded as Reported — a text of 27 characters",
      ["Sources: 1 quote from a saved abstract.", "The text itself isn't stored in History."],
    ],
    [
      "a new code value on a group: the group named as it is now",
      2,
      5,
      "Comparator type (group now named “Placebo”): recorded as Reported — Placebo",
      ["No source given."],
    ],
    ["a new number", 2, 6, "Number randomized: recorded as Reported — 120", ["Sources: 1 quote from a saved abstract.", "The text itself isn't stored in History."]],
    ["Confirm", 3, 1, "Condition or health status: reviewed by you", []],
    ["Flag", 4, 1, "Comparator type (group now named “Placebo”): flagged", ["History doesn't keep the text of notes."]],
    [
      "an edit that reset a review",
      5,
      1,
      "Condition or health status: text changed",
      ["Previously reviewed by you — saving this change reset the review.", "Earlier text isn't stored in History."],
    ],
    [
      "study details",
      6,
      1,
      "Name changed from “Doe 2024” to “Doe 2024 trial”",
      [
        "Kind of study changed from Randomized trial, parallel groups to Another intervention study (cluster or crossover randomized, non-randomized controlled, single group)",
        "Study notes added. The text itself isn't stored in History.",
      ],
    ],
    ["a link marked provisional", 7, 1, `Link to the paper now titled “${PAPER_TITLE}” changed from confirmed by you to provisional`, []],
    ["a group renamed and moved", 9, 1, "Group “Placebo” renamed to “Placebo tablets”", ["Group “Placebo tablets” moved"]],
    ["a group moved: its name is today's", 9, 2, "The group now named “Metformin” moved", []],
    ["an outcome renamed", 9, 3, "Outcome “Body weight” renamed to “Body weight (kg)”", []],
    [
      "a rebase's new copy",
      11,
      1,
      `Saved a new copy of the abstract of the paper now titled “${PAPER_TITLE}”`,
      ["Copy 2, 430 characters. Earlier copies are kept; History doesn't show their text."],
    ],
    ["a quote not found again", 11, 2, "Condition or health status: a quote wasn't found in the new copy", ["It stays on copy 1."]],
    ["a quote found again", 11, 3, "Number randomized: a quote was found again in copy 2", ["It pointed to copy 1 before."]],
    ["a review sent back by the new copy", 11, 4, "Number randomized: needs re-review — a new copy of the abstract was saved", ["It was Reviewed by you before."]],
    [
      "the rebase's summary",
      11,
      5,
      `Quotes rechecked against the new copy of the abstract of the paper now titled “${PAPER_TITLE}”`,
      ["2 quotes rechecked: 1 found again, 1 not found, 0 found more than once.", "A quote not found exactly once stays on the copy it was on.", "1 field was marked as needing re-review."],
    ],
    ["an outcome removed", 12, 1, "Removed outcome “Body weight (kg)”", []],
    ["a group removed with its values", 12, 2, "Removed intervention group “Metformin”", ["Its 1 recorded value and their sources went with it."]],
    [
      "a flagged value cleared",
      12,
      3,
      "Comparator type (group now named “Placebo”): cleared (it was Reported)",
      ["Its review (Flagged) went with it."],
    ],
  ])("%s", (_label, version, ordinal, text, details) => {
    expect(textOf(fixture(version, ordinal))).toEqual({ text, details });
  });

  it("says a group or outcome is gone rather than naming it from memory", () => {
    const empty = { arms: new Map(), outcomes: new Map(), papers: new Map(), values: new Map() };
    expect(textOf(fixture(2, 5), empty).text).toBe("Comparator type (a group since removed): recorded as Reported — Placebo");
    expect(textOf(fixture(9, 2), empty).text).toBe("A group since removed moved");
    expect(textOf(fixture(1, 2), empty).text).toBe("Linked to a paper no longer linked to this record, as confirmed by you");
    expect(historyFieldName({ fieldKey: "outcome_definition", target: { scope: "outcome", current: null } })).toBe("Definition (an outcome since removed)");
    expect(historyFieldName({ fieldKey: "description", target: { scope: "unknown" } })).toBe("What the group received (no longer recorded)");
    expect(historyFieldName({ fieldKey: null, target: { scope: "study" } })).toBe("A field this version of PaperLume doesn't recognize");
  });

  it("an unreadable change: its type in plain words, its field when its row names one, and that details can't be shown", () => {
    const unreadable: HistoryChange = { kind: "unreadable", type: "value_saved", field: { fieldKey: "condition", target: { scope: "study" } } };
    expect(describeChangeText(unreadable)).toEqual({ text: "A field was saved: Condition or health status", details: ["The details of this change can't be shown."] });
    expect(describeChangeText({ kind: "unreadable", type: "review_reset", field: null })).toEqual({ text: "A review was reset", details: ["The details of this change can't be shown."] });
  });

  it("describes a review with its note only by whether it has one", () => {
    const field = { fieldKey: "condition" as const, target: { scope: "study" as const } };
    expect(describeChangeText({ kind: "review", change: "confirmed", field, from: "disputed", note: "removed" })).toEqual({
      text: "Condition or health status: reviewed by you",
      details: ["This replaced your flag.", "History doesn't keep the text of notes."],
    });
    expect(describeChangeText({ kind: "review", change: "confirmed", field, from: "unreviewed", note: "added" }).details).toEqual(["With a review note.", "History doesn't keep the text of notes."]);
    expect(describeChangeText({ kind: "review", change: "confirmed", field, from: "user_reviewed", note: "changed" }).details).toEqual([
      "It was already reviewed by you; the review note changed.",
      "History doesn't keep the text of notes.",
    ]);
    expect(describeChangeText({ kind: "review", change: "flagged", field, from: "disputed", note: "changed" }).details).toEqual(["The flag's note changed.", "History doesn't keep the text of notes."]);
    expect(describeChangeText({ kind: "review", change: "flagged", field, from: "user_reviewed", note: "added" }).details).toEqual(["This replaced your review.", "History doesn't keep the text of notes."]);
  });

  it("describes a rebase as what it was (C2C-B, G4): a first copy replaced nothing and rechecked nothing; a later one rechecked only what was there", () => {
    const paper = { current: { title: PAPER_TITLE } };
    const summary = (change: Partial<Extract<HistoryChange, { kind: "source_rebased" }>>) =>
      describeChangeText({ kind: "source_rebased", paper, first: false, rechecked: 0, rematched: 0, notFound: 0, ambiguous: 0, needRereview: 0, ...change });
    // A first capture: never a replacement, never a recheck.
    const first = summary({ first: true, needRereview: 2 });
    expect(first).toEqual({
      text: `No quotes to recheck: this was the first saved copy of the abstract of the paper now titled “${PAPER_TITLE}”`,
      details: ["2 fields were marked as needing re-review."],
    });
    expect([first.text, ...first.details].join(" ")).not.toMatch(/replac|updated|new copy|rechecked:|found again/i);
    expect(summary({ first: true }).details).toEqual(["No field's review status changed."]);
    // A later copy with nothing on the copy it replaced: zero rechecked is not a recheck.
    const none = summary({ needRereview: 1 });
    expect(none).toEqual({
      text: `No quotes rechecked: none was on the previous copy of the abstract of the paper now titled “${PAPER_TITLE}”`,
      details: ["1 field was marked as needing re-review."],
    });
    expect(none.details.join(" ")).not.toMatch(/found again|not found|more than once/);
    // Every quote found again, and no review moved.
    expect(summary({ rechecked: 3, rematched: 3 }).details).toEqual(["3 quotes rechecked: 3 found again, 0 not found, 0 found more than once.", "No field's review status changed."]);
    // Not found and found more than once are told apart, and both stay where they were.
    expect(summary({ rechecked: 2, notFound: 1, ambiguous: 1, needRereview: 1 }).details).toEqual([
      "2 quotes rechecked: 0 found again, 1 not found, 1 found more than once.",
      "A quote not found exactly once stays on the copy it was on.",
      "1 field was marked as needing re-review.",
    ]);
  });

  it("a review sent back by a new copy keeps its note, and says so without its text (C2C-B, G4)", () => {
    const field = { fieldKey: "condition" as const, target: { scope: "study" as const } };
    expect(describeChangeText({ kind: "review", change: "needs_rereview", field, from: "disputed", note: "unchanged" })).toEqual({
      text: "Condition or health status: needs re-review — a new copy of the abstract was saved",
      details: ["It was Flagged before.", "Its review note is kept.", "History doesn't keep the text of notes."],
    });
    expect(describeChangeText({ kind: "review", change: "needs_rereview", field, from: "user_reviewed", note: "none" }).details).toEqual(["It was Reviewed by you before."]);
  });

  it("summarizes sources by kind, and says when there were none", () => {
    expect(sourcesSummary({ quotes: 2, fullText: 1, examined: 1, unavailable: 1 })).toBe(
      "Sources: 2 quotes from a saved abstract, 1 full-text reference, 1 examined source, 1 source that couldn't be checked.",
    );
    expect(sourcesSummary({ quotes: 0, fullText: 0, examined: 0, unavailable: 0 })).toBe("No source given.");
  });
});

describe("what History never says", () => {
  it("never shows a fingerprint, an id, a request's internals or a planted note", () => {
    for (const line of allText()) {
      expect(line).not.toMatch(/[0-9a-f]{64}/);
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(line).not.toMatch(/sha256|payload|request_id|PLANTED/i);
    }
  });

  it("never claims verification, approval, validation or completeness", () => {
    const sentences = [...allText(), ...Object.values(HISTORY_OPERATION_TITLES), ...Object.values(HISTORY_UNREADABLE_TITLES), ...Object.values(HISTORY_COPY as Record<string, unknown>).filter((value): value is string => typeof value === "string")];
    for (const line of sentences) expect(line).not.toMatch(/\b(verif|approv|validat|complete|accura|correct|certif)/i);
  });

  it("calls a name it didn't record today's", () => {
    // Every group, outcome or paper named from the record as loaded now is marked "now".
    for (const line of allText().filter((candidate) => /group|outcome|paper/i.test(candidate) && candidate.includes("“"))) {
      if (/^(Added|Removed|Group “|Outcome “)/.test(line)) continue; // names the event itself recorded
      expect(line, line).toMatch(/now (named|titled)|since removed|no longer/);
    }
  });
});

describe("dates", () => {
  it("shows a date, a time and its zone, so it is never ambiguous", () => {
    expect(formatHistoryTime("2026-10-25T14:03:00.000Z", "UTC")).toBe("Oct 25, 2026, 2:03 PM UTC");
    // A zone without daylight saving, so the expectation doesn't depend on the runtime's time zone rules.
    expect(formatHistoryTime("2026-10-25T14:03:00.000Z", "Asia/Tokyo")).toBe("Oct 25, 2026, 11:03 PM GMT+9");
    // Without a zone: the reader's own, still named.
    expect(formatHistoryTime("2026-10-25T14:03:00.000Z")).toMatch(/^Oct 2[456], 2026, \d{1,2}:\d{2} [AP]M \S+$/);
  });
});
