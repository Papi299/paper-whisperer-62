import { describe, expect, it } from "vitest";
import { mapEventRow } from "@/lib/evidence/records";
import { EVENT_TYPES, type HistoryEvent } from "@/lib/evidence/types";
import { describeHistoryChange, historyContextOf, type HistoryChange, type HistoryContext } from "../historyModel";
import { ARM_COMPARATOR, ARM_INTERVENTION, assemble, fullRows, LINK_ID, OUTCOME_WEIGHT, PAPER_ID, PAPER_TITLE, SNAPSHOT_ID, STUDY_ID, uuid, VALUE_COMPARATOR_TYPE, VALUE_CONDITION, VALUE_N_RANDOMIZED } from "./fixtures";
import {
  ANCHOR_N_QUOTE,
  changeRow,
  examinedAbstract,
  fullTextReference,
  historyRows,
  quoteReference,
  sha,
  textDigest,
  valueDigest,
  type EventRow,
} from "./historyFixtures";

/**
 * What History says about each change event (EVIDENCE-RECORDS-001C2B): what
 * the event recorded, named honestly, and nothing it didn't. Every event type
 * an installed RPC writes is described; a digest that fails any check is
 * `unreadable`, never guessed at.
 */

const CONTEXT: HistoryContext = historyContextOf(assemble(fullRows()));
const EMPTY: HistoryContext = { arms: new Map(), outcomes: new Map(), papers: new Map(), values: new Map() };

function eventOf(row: EventRow): HistoryEvent {
  const mapped = mapEventRow(row);
  if (!mapped.ok) throw new Error(`fixture row does not map: ${mapped.problems.join(", ")}`);
  return mapped.value;
}
const describeRow = (row: EventRow, context = CONTEXT) => describeHistoryChange(eventOf(row), context);
const fixture = (version: number, ordinal: number) => historyRows().find((row) => row.study_version === version && row.ordinal === ordinal)!;
const unreadable = (type: string, field: unknown = null) => ({ kind: "unreadable", type, field });

describe("every event an installed RPC writes", () => {
  it.each<[string, number, number, HistoryChange]>([
    ["study_created", 1, 1, { kind: "study_created", label: "Doe 2024", designProfile: "rct_parallel" }],
    ["link_created", 1, 2, { kind: "link_created", paper: { current: { title: PAPER_TITLE } }, status: "user_confirmed" }],
    ["source_captured (at creation)", 1, 3, { kind: "source_captured", paper: { current: { title: PAPER_TITLE } }, seq: 1, chars: 412, first: true }],
    ["arm_added", 2, 1, { kind: "group_added", name: "Metformin", role: "intervention" }],
    ["outcome_added", 2, 3, { kind: "outcome_added", name: "Body weight" }],
    [
      "study_updated (name, kind of study and notes)",
      6,
      1,
      {
        kind: "study_updated",
        label: { from: "Doe 2024", to: "Doe 2024 trial" },
        designProfile: { from: "rct_parallel", to: "intervention_other" },
        notes: "added",
      },
    ],
    [
      "link_status_changed",
      7,
      1,
      { kind: "link_status_changed", paper: { current: { title: PAPER_TITLE } }, status: { from: "user_confirmed", to: "provisional" } },
    ],
    [
      "arm_updated (renamed and moved: the event holds both names)",
      9,
      1,
      { kind: "group_updated", name: { source: "event", name: "Placebo tablets" }, renamed: { from: "Placebo", to: "Placebo tablets" }, role: null, moved: true },
    ],
    [
      "arm_updated (moved only: the name is today's, said so)",
      9,
      2,
      { kind: "group_updated", name: { source: "current", name: "Metformin" }, renamed: null, role: null, moved: true },
    ],
    ["source_captured (a rebase's new copy)", 11, 1, { kind: "source_captured", paper: { current: { title: PAPER_TITLE } }, seq: 2, chars: 430, first: false }],
    [
      "anchor_not_rematched",
      11,
      2,
      { kind: "anchor_not_rematched", field: { fieldKey: "condition", target: { scope: "study" } }, keptSeq: 1, outcome: "not_found" },
    ],
    ["anchor_rematched", 11, 3, { kind: "anchor_rematched", field: { fieldKey: "n_randomized", target: { scope: "study" } }, seq: { from: 1, to: 2 } }],
    [
      "review_needs_rereview",
      11,
      4,
      { kind: "review", change: "needs_rereview", field: { fieldKey: "n_randomized", target: { scope: "study" } }, from: "user_reviewed", note: "none" },
    ],
    [
      "source_rebased",
      11,
      5,
      { kind: "source_rebased", paper: { current: { title: PAPER_TITLE } }, first: false, rechecked: 2, rematched: 1, notFound: 1, ambiguous: 0, needRereview: 1 },
    ],
    [
      "outcome_updated (renamed: the event holds both names)",
      9,
      3,
      { kind: "outcome_updated", name: { source: "event", name: "Body weight (kg)" }, renamed: { from: "Body weight", to: "Body weight (kg)" }, moved: false },
    ],
    ["outcome_removed", 12, 1, { kind: "outcome_removed", name: "Body weight (kg)", values: 0 }],
    ["arm_removed (with its values)", 12, 2, { kind: "group_removed", name: "Metformin", role: "intervention", values: 1 }],
    [
      "value_cleared (it was flagged)",
      12,
      3,
      {
        kind: "value_cleared",
        field: { fieldKey: "comparator_type", target: { scope: "arm", current: { name: "Placebo", role: "comparator" } } },
        state: "reported",
        stateReason: null,
        reviewCleared: "disputed",
      },
    ],
  ])("%s", (_label, version, ordinal, expected) => {
    expect(describeRow(fixture(version, ordinal))).toEqual(expected);
  });

  it("describes every event of the fixture history, and none of them as unreadable", () => {
    const types = new Set<string>();
    for (const row of historyRows().filter((candidate) => candidate.ordinal > 0)) {
      const change = describeRow(row);
      expect(change.kind, `${row.study_version}.${row.ordinal} ${row.event_type}`).not.toBe("unreadable");
      types.add(row.event_type);
    }
    // Every type an installed RPC can write today appears: all of the vocabulary but the header, review_reset
    // (written by none) and link_removed (unreachable: a last link can't be removed, no link can be added).
    expect([...types].sort()).toEqual(EVENT_TYPES.filter((type) => !["request", "review_reset", "link_removed"].includes(type)).sort());
  });

  it("never lets a fingerprint, an id or a request's internals leave the model", () => {
    for (const row of historyRows().filter((candidate) => candidate.ordinal > 0)) {
      const text = JSON.stringify(describeRow(row));
      expect(text, row.event_type).not.toMatch(/[0-9a-f]{64}/);
      expect(text, row.event_type).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    }
  });
});

describe("value saves", () => {
  const saved = (row: EventRow) => {
    const change = describeRow(row);
    if (change.kind !== "value_saved") throw new Error(`not a value_saved: ${change.kind}`);
    return change.saved;
  };

  it("a new value: recorded, with its content as History has it, and no review to clear", () => {
    expect(saved(fixture(2, 4))).toEqual({
      created: true,
      state: { from: null, to: "reported" },
      stateReason: { from: null, to: null },
      content: { from: null, to: { shape: "text", chars: 27 }, changed: false },
      note: "none",
      sources: { to: { quotes: 1, fullText: 0, examined: 0, unavailable: 0 }, changed: false },
      reviewCleared: null,
    });
    expect(saved(fixture(2, 5)).content.to).toEqual({ shape: "code", code: "placebo" });
    expect(saved(fixture(2, 6)).content.to).toEqual({ shape: "number", value: 120 });
  });

  it("an edit of a reviewed value: the text changed (by fingerprint), and the save reset the review", () => {
    expect(saved(fixture(5, 1))).toMatchObject({
      created: false,
      content: { from: { shape: "text", chars: 27 }, to: { shape: "text", chars: 31 }, changed: true },
      sources: { changed: false },
      reviewCleared: "user_reviewed",
    });
  });

  it.each([
    ["flagged", "disputed"],
    ["needing re-review", "needs_rereview"],
  ])("a save of a value %s clears that status", (_label, status) => {
    const before = valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition", review: { status, ...(status === "disputed" ? { note: textDigest(70, 9) } : { reason: "source_changed" }) } });
    const after = valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition", content: { text: textDigest(2, 5) }, valueVersion: 2 });
    expect(saved(changeRow(5, 1, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", before, after })).reviewCleared).toBe(status);
  });

  it("compares by fingerprint only: same text and new sources, a new note, a state change", () => {
    const base = { valueId: VALUE_CONDITION, fieldKey: "condition" };
    const row = (before: object, after: object) => changeRow(5, 1, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", before: valueDigest({ ...base, ...before }), after: valueDigest({ ...base, ...after }) });
    expect(saved(row({ references: [quoteReference(uuid("9", 1))] }, { references: [quoteReference(uuid("9", 1)), fullTextReference(uuid("9", 2), 1)] }))).toMatchObject({
      content: { changed: false },
      sources: { to: { quotes: 1, fullText: 1 }, changed: true },
    });
    expect(saved(row({}, { note: textDigest(9, 12) })).note).toBe("added");
    expect(saved(row({ note: textDigest(9, 12) }, { note: textDigest(10, 12) })).note).toBe("changed");
    expect(saved(row({ note: textDigest(9, 12) }, {})).note).toBe("removed");
    expect(saved(row({ note: textDigest(9, 12) }, { note: textDigest(9, 12), references: [quoteReference(uuid("9", 7))] })).note).toBe("unchanged");
    expect(
      saved(row({}, { state: "not_reported", content: null, references: [examinedAbstract(uuid("9", 4))] })),
    ).toMatchObject({ state: { from: "reported", to: "not_reported" }, content: { from: { shape: "text" }, to: null, changed: true }, sources: { to: { examined: 1 } } });
    expect(
      saved(row({ state: "unclear", stateReason: "ambiguous", content: null, note: textDigest(9, 12) }, { state: "unclear", stateReason: "conflicting", content: null, note: textDigest(9, 12) })),
    ).toMatchObject({ state: { from: "unclear", to: "unclear" }, stateReason: { from: "ambiguous", to: "conflicting" } });
  });

  it("a group value names its group as it is NOW — or as removed — never as it was", () => {
    const after = valueDigest({ valueId: uuid("f", 9), fieldKey: "description", armId: ARM_INTERVENTION });
    const row = changeRow(2, 7, "value_saved", { target: uuid("f", 9), fieldKey: "description", after });
    expect(describeRow(row)).toMatchObject({ field: { fieldKey: "description", target: { scope: "arm", current: { name: "Metformin", role: "intervention" } } } });
    expect(describeRow(row, EMPTY)).toMatchObject({ field: { target: { scope: "arm", current: null } } });
    const outcome = changeRow(2, 8, "value_saved", {
      target: uuid("f", 10),
      fieldKey: "outcome_definition",
      after: valueDigest({ valueId: uuid("f", 10), fieldKey: "outcome_definition", outcomeId: OUTCOME_WEIGHT }),
    });
    expect(describeRow(outcome)).toMatchObject({ field: { target: { scope: "outcome", current: { name: "Body weight" } } } });
    expect(describeRow(outcome, EMPTY)).toMatchObject({ field: { target: { scope: "outcome", current: null } } });
  });

  it("a list counts its entries, never shows them", () => {
    const after = valueDigest({ valueId: uuid("f", 11), fieldKey: "registration_ids", content: { entries: { sha256: sha(5), count: 2 } } });
    expect(saved(changeRow(2, 7, "value_saved", { target: uuid("f", 11), fieldKey: "registration_ids", after })).content.to).toEqual({ shape: "list", entries: 2 });
  });

  it("an unknown field key: the field is unnamed, its content unread", () => {
    const after = valueDigest({ valueId: uuid("f", 12), fieldKey: "n_randomized_arm", content: null, state: "not_applicable", note: textDigest(9, 5) });
    const change = describeRow(changeRow(2, 7, "value_saved", { target: uuid("f", 12), fieldKey: "n_randomized_arm", after }));
    expect(change).toMatchObject({ kind: "value_saved", field: { fieldKey: null, target: { scope: "study" } } });
    // Reported content of an unknown field can't be checked against a shape: unreadable.
    const reported = valueDigest({ valueId: uuid("f", 12), fieldKey: "n_randomized_arm" });
    expect(describeRow(changeRow(2, 7, "value_saved", { target: uuid("f", 12), fieldKey: "n_randomized_arm", after: reported }))).toEqual(
      unreadable("value_saved", { fieldKey: null, target: { scope: "unknown" } }),
    );
  });

  it("reads a target id in any case, as PostgreSQL compares uuids", () => {
    const row = { ...fixture(2, 4), target_id: VALUE_CONDITION.toUpperCase() };
    expect(describeRow(row).kind).toBe("value_saved");
  });

  it("ignores fields it doesn't know, and never surfaces them", () => {
    const after = { ...valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition" }), comment: "<b>raw</b>", extra: { text: "secret" } };
    const change = describeRow(changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after }));
    expect(change.kind).toBe("value_saved");
    expect(JSON.stringify(change)).not.toMatch(/raw|secret|comment|extra/);
  });
});

describe("reviews", () => {
  it.each<[string, string, string, object, object, object]>([
    ["Confirm", "review_confirmed", "condition", {}, { status: "user_reviewed", reviewedVersion: 1 }, { change: "confirmed", from: "unreviewed", note: "none" }],
    ["Confirm with a note", "review_confirmed", "condition", {}, { status: "user_reviewed", reviewedVersion: 1, note: textDigest(9, 4) }, { change: "confirmed", note: "added" }],
    ["Confirm replacing a flag", "review_confirmed", "condition", { status: "disputed", note: textDigest(8, 9) }, { status: "user_reviewed", reviewedVersion: 1 }, { change: "confirmed", from: "disputed", note: "removed" }],
    ["Confirm again with a new note", "review_confirmed", "condition", { status: "user_reviewed", reviewedVersion: 1, note: textDigest(8, 9) }, { status: "user_reviewed", reviewedVersion: 1, note: textDigest(9, 9) }, { change: "confirmed", from: "user_reviewed", note: "changed" }],
    ["Flag", "review_flagged", "condition", {}, { status: "disputed", note: textDigest(9, 9) }, { change: "flagged", from: "unreviewed", note: "added" }],
    ["Flag with a new note", "review_flagged", "condition", { status: "disputed", note: textDigest(8, 9) }, { status: "disputed", note: textDigest(9, 9) }, { change: "flagged", from: "disputed", note: "changed" }],
    ["Flag replacing a review", "review_flagged", "condition", { status: "user_reviewed", reviewedVersion: 1 }, { status: "disputed", note: textDigest(9, 9) }, { change: "flagged", from: "user_reviewed" }],
  ])("%s", (_label, type, fieldKey, beforeReview, afterReview, expected) => {
    const digest = (review: object) => valueDigest({ valueId: VALUE_CONDITION, fieldKey, review });
    expect(describeRow(changeRow(3, 1, type, { target: VALUE_CONDITION, fieldKey, before: digest(beforeReview), after: digest(afterReview) }))).toMatchObject({
      kind: "review",
      field: { fieldKey, target: { scope: "study" } },
      ...expected,
    });
  });

  it.each<[string, string, object, object]>([
    ["a Confirm that doesn't end Reviewed by you", "review_confirmed", {}, { status: "disputed", note: textDigest(9, 9) }],
    ["a Flag without a note", "review_flagged", {}, { status: "disputed" }],
    ["a Flag that doesn't end Flagged", "review_flagged", {}, { status: "user_reviewed", reviewedVersion: 1 }],
    ["a re-review mark that doesn't end Needs re-review", "review_needs_rereview", { status: "user_reviewed", reviewedVersion: 1 }, { status: "unreviewed" }],
  ])("refuses %s", (_label, type, beforeReview, afterReview) => {
    const digest = (review: object) => valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition", review });
    expect(describeRow(changeRow(3, 1, type, { target: VALUE_CONDITION, fieldKey: "condition", before: digest(beforeReview), after: digest(afterReview) })).kind).toBe("unreadable");
  });

  it("refuses a review that changed the value it reviewed — a review never does", () => {
    const before = valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition" });
    const after = valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition", content: { text: textDigest(2, 9) }, review: { status: "user_reviewed", reviewedVersion: 1 } });
    expect(describeRow(changeRow(3, 1, "review_confirmed", { target: VALUE_CONDITION, fieldKey: "condition", before, after })).kind).toBe("unreadable");
  });
});

describe("before-only and after-only events", () => {
  it("removals hold only a before; additions only an after — the other side present is refused", () => {
    expect(describeRow(changeRow(12, 1, "arm_removed", { target: ARM_COMPARATOR, before: { arm_role: "comparator", display_label: "Placebo", position: 1, values: [{}, {}] } }))).toEqual({
      kind: "group_removed",
      name: "Placebo",
      role: "comparator",
      values: 2,
    });
    expect(describeRow(changeRow(7, 1, "link_removed", { target: LINK_ID, before: { paper_id: PAPER_ID, link_status: "provisional", link_basis: "created_from_paper", snapshot_ids: [SNAPSHOT_ID] } }))).toEqual({
      kind: "link_removed",
      paper: { current: { title: PAPER_TITLE } },
      status: "provisional",
      copies: 1,
    });
    // An addition with a before, a removal with an after.
    expect(describeRow(changeRow(2, 1, "arm_added", { target: ARM_INTERVENTION, before: {}, after: { arm_role: "intervention", display_label: "X", position: 0 } })).kind).toBe("unreadable");
    expect(describeRow(changeRow(12, 1, "outcome_removed", { target: OUTCOME_WEIGHT, before: { display_label: "X", position: 0, values: [] }, after: {} })).kind).toBe("unreadable");
    expect(describeRow(changeRow(12, 2, "value_cleared", { target: VALUE_CONDITION, fieldKey: "condition", before: valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition" }), after: {} })).kind).toBe(
      "unreadable",
    );
  });

  it("a paper no longer linked, and a linked paper whose title couldn't be read, are said to be so", () => {
    const row = changeRow(1, 2, "link_created", { target: LINK_ID, after: { paper_id: uuid("a", 9), link_status: "provisional", link_basis: "created_from_paper" } });
    expect(describeRow(row)).toMatchObject({ paper: { current: null } });
    const untitled = historyContextOf(assemble(fullRows(), null));
    expect(describeRow(fixture(1, 2), untitled)).toMatchObject({ paper: { current: { title: null } } });
  });

  it("an anchor event of a value no longer recorded names its field, not its target", () => {
    const row = changeRow(11, 3, "anchor_rematched", {
      target: ANCHOR_N_QUOTE,
      fieldKey: "arm_name_as_reported",
      before: { value_id: uuid("f", 99), snapshot_id: SNAPSHOT_ID, seq: 1 },
      after: { value_id: uuid("f", 99), snapshot_id: uuid("c", 2), seq: 2 },
    });
    expect(describeRow(row)).toMatchObject({ field: { fieldKey: "arm_name_as_reported", target: { scope: "unknown" } } });
    const valueGone = { ...CONTEXT, values: new Map() };
    expect(describeRow(fixture(11, 3), valueGone)).toMatchObject({ field: { fieldKey: "n_randomized", target: { scope: "study" } } });
  });
});

describe("a rebase's summary (C2C-B, G4)", () => {
  const summary = (after: Record<string, unknown>) => describeRow(changeRow(11, 5, "source_rebased", { target: SNAPSHOT_ID, after }));
  const base = { paper_id: PAPER_ID, snapshot_id: SNAPSHOT_ID, quotes_rechecked: 0, rematched: 0, not_found: 0, ambiguous: 0, values_needing_rereview: 0, values_changed: 0 };

  it("a first copy: no earlier copy, so nothing was replaced and no quote rechecked — read from the event's own previous copy, null", () => {
    expect(summary({ ...base, previous_snapshot_id: null, values_needing_rereview: 2, values_changed: 2 })).toEqual({
      kind: "source_rebased",
      paper: { current: { title: PAPER_TITLE } },
      first: true,
      rechecked: 0,
      rematched: 0,
      notFound: 0,
      ambiguous: 0,
      needRereview: 2,
    });
  });

  it("a later copy keeps its counts as recorded: not found and found more than once apart, and only the reviews it moved", () => {
    expect(summary({ ...base, previous_snapshot_id: uuid("c", 2), quotes_rechecked: 3, rematched: 1, not_found: 1, ambiguous: 1, values_needing_rereview: 0, values_changed: 2 })).toMatchObject({
      first: false,
      rechecked: 3,
      rematched: 1,
      notFound: 1,
      ambiguous: 1,
      needRereview: 0,
    });
  });
});

describe("unreadable details: the type, and nothing more", () => {
  const condition = valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition" });
  const rebased = { paper_id: PAPER_ID, snapshot_id: SNAPSHOT_ID, previous_snapshot_id: uuid("c", 2), quotes_rechecked: 0, rematched: 0, not_found: 0, ambiguous: 0, values_needing_rereview: 0, values_changed: 0 };
  it.each<[string, EventRow, object | null]>([
    ["a value digest that isn't an object", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: "digest" }), { fieldKey: "condition", target: { scope: "study" } }],
    ["a value state outside the vocabulary", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, value_state: "verified" } }), {}],
    ["a fingerprint that isn't one", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, content: { text: { sha256: "abc", chars: 3 } } } }), {}],
    ["text shown as text instead of a fingerprint", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, content: { text: "Type 2 diabetes" } } }), {}],
    ["a code outside the field's list", changeRow(2, 5, "value_saved", { target: VALUE_COMPARATOR_TYPE, fieldKey: "comparator_type", after: valueDigest({ valueId: VALUE_COMPARATOR_TYPE, fieldKey: "comparator_type", armId: ARM_COMPARATOR, content: { code: "homeopathy" } }) }), {}],
    ["a number out of range", changeRow(2, 6, "value_saved", { target: VALUE_N_RANDOMIZED, fieldKey: "n_randomized", after: valueDigest({ valueId: VALUE_N_RANDOMIZED, fieldKey: "n_randomized", content: { reported_text: textDigest(1, 3), value: 10_000_001 } }) }), {}],
    ["content on a state without a value", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, value_state: "not_reported" } }), {}],
    ["Unclear without its reason", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, value_state: "unclear", content: null } }), {}],
    ["a value for two targets", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, arm_id: ARM_INTERVENTION, outcome_id: OUTCOME_WEIGHT } }), {}],
    ["a study field on a group", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, arm_id: ARM_INTERVENTION } }), {}],
    ["a row field key that isn't the digest's", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "setting", after: condition }), { fieldKey: "setting", target: { scope: "study" } }],
    ["a row target that isn't the digest's value", changeRow(2, 4, "value_saved", { target: VALUE_N_RANDOMIZED, fieldKey: "condition", after: condition }), {}],
    ["a save that leaves a review standing", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, review: { status: "user_reviewed", note: null } } }), {}],
    ["a before and after of different values", changeRow(5, 1, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", before: { ...condition, value_id: VALUE_N_RANDOMIZED }, after: condition }), {}],
    ["a reference purpose outside the vocabulary", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, references: [{ ...quoteReference(uuid("9", 1)), purpose: "proves" }] } }), {}],
    ["a quote recorded as text", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, references: [{ ...quoteReference(uuid("9", 1)), quote: "type 2 diabetes" }] } }), {}],
    ["a quote missing its key", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, references: [(({ quote: _q, ...rest }) => rest)(quoteReference(uuid("9", 1)))] } }), {}],
    ["a locator of a kind outside the vocabulary", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, references: [{ ...fullTextReference(uuid("9", 2)), locator: { kind: "chapter", text: textDigest(9, 3) } }] } }), {}],
    ["a locator recorded as text", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, references: [{ ...fullTextReference(uuid("9", 2)), locator: "Table 2" }] } }), {}],
    ["a supporting position out of range", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, references: [{ ...quoteReference(uuid("9", 1)), position: 3 }] } }), {}],
    ["a copy id that isn't one", changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", after: { ...condition, references: [{ ...quoteReference(uuid("9", 1)), snapshot_id: "copy-1" }] } }), {}],
    ["a study label beyond its limit", changeRow(1, 1, "study_created", { target: STUDY_ID, after: { label: "x".repeat(121), design_profile: "rct_parallel", notes: null } }), null],
    ["a design family outside the vocabulary", changeRow(1, 1, "study_created", { target: STUDY_ID, after: { label: "Doe", design_profile: "meta_analysis", notes: null } }), null],
    ["a study update that changed nothing", changeRow(6, 1, "study_updated", { target: STUDY_ID, before: { label: "Doe" }, after: { label: "Doe" } }), null],
    ["a study update with mismatched keys", changeRow(6, 1, "study_updated", { target: STUDY_ID, before: { label: "Doe" }, after: { design_profile: "rct_parallel" } }), null],
    ["notes recorded as text", changeRow(6, 1, "study_updated", { target: STUDY_ID, before: { notes: null }, after: { notes: "my notes" } }), null],
    ["a link status that didn't change", changeRow(7, 1, "link_status_changed", { target: LINK_ID, before: { paper_id: PAPER_ID, link_status: "provisional" }, after: { paper_id: PAPER_ID, link_status: "provisional" } }), null],
    ["a link change of two papers", changeRow(7, 1, "link_status_changed", { target: LINK_ID, before: { paper_id: PAPER_ID, link_status: "provisional" }, after: { paper_id: uuid("a", 2), link_status: "user_confirmed" } }), null],
    ["a copy of another kind of source", changeRow(1, 3, "source_captured", { target: SNAPSHOT_ID, after: { paper_id: PAPER_ID, seq: 1, source_kind: "full_text", char_count: 4, previous_snapshot_id: null } }), null],
    ["a rebase summary whose previous copy isn't an id", changeRow(11, 5, "source_rebased", { target: SNAPSHOT_ID, after: { ...rebased, previous_snapshot_id: "copy-1" } }), null],
    ["a rebase summary without its previous copy", changeRow(11, 5, "source_rebased", { target: SNAPSHOT_ID, after: (({ previous_snapshot_id: _p, ...rest }) => rest)(rebased) }), null],
    ["a rebase summary with a count that isn't one", changeRow(11, 5, "source_rebased", { target: SNAPSHOT_ID, after: { ...rebased, values_needing_rereview: -1 } }), null],
    ["a re-match that moved to an older copy", changeRow(11, 3, "anchor_rematched", { target: ANCHOR_N_QUOTE, fieldKey: "n_randomized", before: { value_id: VALUE_N_RANDOMIZED, seq: 2 }, after: { value_id: VALUE_N_RANDOMIZED, seq: 1 } }), { fieldKey: "n_randomized", target: { scope: "study" } }],
    ["a missed re-match with an unknown outcome", changeRow(11, 2, "anchor_not_rematched", { target: ANCHOR_N_QUOTE, fieldKey: "condition", after: { value_id: VALUE_CONDITION, kept_seq: 1, outcome: "lost" } }), { fieldKey: "condition", target: { scope: "study" } }],
    ["a group label of HTML beyond its limit", changeRow(2, 1, "arm_added", { target: ARM_INTERVENTION, after: { arm_role: "intervention", display_label: `<img src=x onerror=alert(1)>${"x".repeat(120)}`, position: 0 } }), null],
    ["a field key on a group event", changeRow(2, 1, "arm_added", { target: ARM_INTERVENTION, fieldKey: "condition", after: { arm_role: "intervention", display_label: "X", position: 0 } }), { fieldKey: "condition", target: { scope: "study" } }],
    ["an event without its target", changeRow(2, 3, "outcome_added", { target: null as unknown as string, after: { display_label: "X", position: 0 } }), null],
  ])("%s", (_label, row, field) => {
    const change = describeRow(row);
    expect(change.kind).toBe("unreadable");
    if (field !== null && Object.keys(field).length > 0) expect(change).toEqual(unreadable(row.event_type, field));
  });

  it("review_reset — in the vocabulary, written by no installed RPC — is never interpreted, whatever it holds", () => {
    const row = changeRow(5, 1, "review_reset", {
      target: VALUE_CONDITION,
      fieldKey: "condition",
      before: valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition", review: { status: "user_reviewed", reviewedVersion: 1 } }),
      after: valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition" }),
    });
    expect(describeRow(row)).toEqual(unreadable("review_reset", { fieldKey: "condition", target: { scope: "study" } }));
  });

  it("a label is kept exactly as recorded — markup and all — for the copy to render as text", () => {
    const label = "<img src=x onerror=alert(1)>";
    expect(describeRow(changeRow(1, 1, "study_created", { target: STUDY_ID, after: { label, design_profile: "rct_parallel", notes: null } }))).toEqual({
      kind: "study_created",
      label,
      designProfile: "rct_parallel",
    });
  });

  it("refuses to describe a request header as a change", () => {
    const header = historyRows().find((row) => row.ordinal === 0)!;
    expect(() => describeHistoryChange(eventOf(header), CONTEXT)).toThrow(TypeError);
  });
});
