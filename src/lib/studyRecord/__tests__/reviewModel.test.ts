// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { toValueId } from "@/lib/evidence/ids";
import { locateQuote } from "@/lib/evidence/matcher";
import { VALUE_STATES, type ReviewStatus, type ValueState } from "@/lib/evidence/types";
import {
  createDraft,
  editFromRecorded,
  NOT_RECORDED_EDIT,
  removeArm,
  removeOutcome,
  revertValue,
  setValueEdit,
  STUDY_TARGET,
  valueKey,
  type StudyRecordDraft,
} from "../draft";
import { assembleStudyRecord, StudyRecordReadError, type StudyRecordData } from "../read";
import {
  buildReviewItems,
  describeRecordSources,
  filterReviewItems,
  nextNeedingReview,
  REVIEW_HOLDS,
  reviewSummary,
  reviewTargetState,
  type ReviewActivity,
  type ReviewContext,
  type ReviewItem,
} from "../reviewModel";
import {
  ABSTRACT,
  ARM_COMPARATOR,
  ARM_INTERVENTION,
  armRow,
  OUTCOME_WEIGHT,
  outcomeRow,
  PAPER_ID,
  PAPER_TITLE,
  quoteAnchorRow,
  reportRow,
  SECOND_PAPER_ID,
  snapshotRow,
  SNAPSHOT_ID,
  studyRow,
  USER,
  STUDY_ID,
  uuid,
  valueRow,
  type FixtureRows,
} from "./fixtures";

/**
 * Review mode's model (EVIDENCE-RECORDS-001C2A): items come from the SAVED
 * record only; the draft decides only whether a value's actions wait.
 * Expectations are written from the C2 audit's §E5 table and FK-PROOF-001 §J,
 * not read back from the model.
 */

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

const OLD_COPY = uuid("c", 9);
const SECOND_COPY = uuid("c", 2);
const T_REVIEW = "2026-10-21T12:00:00.000Z";
const IDLE: ReviewContext = { canWrite: true, activity: "idle" };

/** Assemble rows as `fetchStudyRecord` does: every copy as metadata, only each link's newest with text. */
function record(rows: FixtureRows, titles: Record<string, string> = { [PAPER_ID]: PAPER_TITLE, [SECOND_PAPER_ID]: "Second report" }): StudyRecordData {
  const newest = new Map<string, Row<"evidence_source_snapshots">>();
  for (const row of rows.snapshots) if (!newest.has(row.paper_id) || newest.get(row.paper_id)!.seq < row.seq) newest.set(row.paper_id, row);
  const info = rows.snapshots.map(({ exact_text: _t, exact_sha256: _e, normalized_sha256: _n, ...rest }) => rest);
  const papers = [...new Set(rows.reports.map((r) => r.paper_id))].map((id) => ({ id, user_id: USER, title: titles[id] ?? "Untitled" }));
  return assembleStudyRecord(USER, STUDY_ID, { ...rows, snapshots: info }, [...newest.values()], papers);
}

/** A quote anchor whose offsets are where the quote really is in `text` (as the server would store them). */
function quote(n: number, valueId: string, quoteText: string, overrides: Partial<Row<"evidence_field_anchors">> = {}, text = ABSTRACT): Row<"evidence_field_anchors"> {
  const match = locateQuote(quoteText, text);
  if (match.kind !== "unique" && match.kind !== "multiple") throw new Error(`fixture quote not in the copy: ${quoteText}`);
  const occurrence = match.occurrences[(overrides.match_occurrence ?? 1) - 1];
  return quoteAnchorRow({
    id: uuid("9", n),
    value_id: valueId,
    quote_text: quoteText,
    match_start: occurrence.normalized.start,
    match_end: occurrence.normalized.end,
    match_occurrence: occurrence.occurrence,
    match_count: match.count,
    ...overrides,
  });
}

function anchor(n: number, valueId: string, purpose: "supports" | "examined" | "unavailable", sourceKind: "abstract" | "full_text", extra: Partial<Row<"evidence_field_anchors">> = {}): Row<"evidence_field_anchors"> {
  return quoteAnchorRow({
    id: uuid("9", n),
    value_id: valueId,
    purpose,
    source_kind: sourceKind,
    snapshot_id: sourceKind === "abstract" && purpose !== "unavailable" ? SNAPSHOT_ID : null,
    position: purpose === "supports" ? 0 : null,
    quote_text: null,
    match_start: null,
    match_end: null,
    match_occurrence: null,
    match_count: null,
    normalization_version: null,
    matched_at: null,
    locator_kind: purpose === "supports" && sourceKind === "full_text" ? "page" : null,
    locator_text: purpose === "supports" && sourceKind === "full_text" ? "4" : null,
    ...extra,
  });
}

const reviewedRow = (version: number) => ({ review_status: "user_reviewed", reviewed_at: T_REVIEW, reviewed_version: version });

const V = {
  condition: uuid("f", 1),
  comparatorType: uuid("f", 2),
  nRandomized: uuid("f", 3),
  setting: uuid("f", 4),
  designClassification: uuid("f", 5),
  armName: uuid("f", 6),
  outcomeName: uuid("f", 7),
  registration: uuid("f", 8),
};

/** An RCT with values in every review status and on every target. */
function rows(): FixtureRows {
  return {
    study: studyRow(),
    reports: [reportRow()],
    snapshots: [snapshotRow()],
    arms: [
      armRow({ id: ARM_COMPARATOR, arm_role: "comparator", display_label: "Placebo", position: 1 }),
      armRow({ id: ARM_INTERVENTION, display_label: "Metformin", position: 0 }),
    ],
    outcomes: [outcomeRow()],
    values: [
      valueRow({ id: V.condition, field_key: "condition", value_text: "Type 2 diabetes and obesity" }),
      valueRow({ id: V.comparatorType, arm_id: ARM_COMPARATOR, field_key: "comparator_type", value_text: null, value_code: "placebo", value_version: 1, review_status: "disputed", review_note: "Check the methods" }),
      valueRow({ id: V.nRandomized, field_key: "n_randomized", value_text: "120 participants", value_int: 120, value_version: 1, ...reviewedRow(1) }),
      valueRow({ id: V.setting, field_key: "setting", value_text: "Outpatient clinics", value_version: 1 }),
      valueRow({ id: V.designClassification, field_key: "design_classification", value_text: null, value_code: "rct_parallel", value_version: 1 }),
      valueRow({ id: V.armName, arm_id: ARM_INTERVENTION, field_key: "arm_name_as_reported", value_text: "metformin", value_version: 3, review_status: "needs_rereview", review_reason: "source_changed", review_note: "Earlier note" }),
      valueRow({ id: V.outcomeName, outcome_id: OUTCOME_WEIGHT, field_key: "outcome_name_as_reported", value_text: "body weight", value_version: 1 }),
      valueRow({ id: V.registration, field_key: "registration_ids", value_state: "not_reported", value_text: null, value_version: 1 }),
    ],
    anchors: [
      quote(1, V.condition, "type 2 diabetes"),
      quote(2, V.comparatorType, "metformin or placebo"),
      quote(3, V.nRandomized, "120 participants"),
      quote(4, V.armName, "metformin"),
      quote(5, V.outcomeName, "body weight was measured", { match_occurrence: 2 }),
      anchor(6, V.registration, "examined", "abstract"),
    ],
  };
}

const items = (base: StudyRecordData, draft: StudyRecordDraft = createDraft(base), context: ReviewContext = IDLE) => buildReviewItems(base, draft, context);
const byField = (list: readonly ReviewItem[], fieldKey: string) => {
  const found = list.find((item) => item.fieldKey === fieldKey);
  if (!found) throw new Error(`no item for ${fieldKey}`);
  return found;
};

describe("items come from the saved record only", () => {
  it("builds one item per persisted value, in section, target and field order, with saved group names", () => {
    const list = items(record(rows()));
    expect(list.map((item) => [item.section, item.groupId, item.fieldKey])).toEqual([
      ["study_design", "section:study_design", "design_classification"],
      ["study_design", "section:study_design", "setting"],
      ["study_design", "section:study_design", "registration_ids"],
      ["participants", "section:participants", "condition"],
      ["participants", "section:participants", "n_randomized"],
      // Groups by saved position: Metformin (0) before Placebo (1), whatever the row order.
      ["interventions", `arm:${ARM_INTERVENTION}`, "arm_name_as_reported"],
      ["interventions", `arm:${ARM_COMPARATOR}`, "comparator_type"],
      ["outcomes", `outcome:${OUTCOME_WEIGHT}`, "outcome_name_as_reported"],
    ]);
    expect(byField(list, "comparator_type").target).toEqual({ scope: "arm", armId: ARM_COMPARATOR, role: "comparator", name: "Placebo" });
    expect(byField(list, "outcome_name_as_reported").target).toEqual({ scope: "outcome", outcomeId: OUTCOME_WEIGHT, name: "Body weight" });
    expect(byField(list, "condition").key).toBe(valueKey(STUDY_TARGET, "condition"));
  });

  it("makes no item for an empty optional field, a field recorded only in the draft, or a group added in the draft", () => {
    const base = record(rows());
    let draft = setValueEdit(new Map(), createDraft(base), valueKey(STUDY_TARGET, "demographics"), { ...NOT_RECORDED_EDIT, state: "reported", content: { shape: "text", text: "Adults" } });
    draft = { ...draft, arms: [...draft.arms, { key: "arm_1", id: null, role: "intervention", displayLabel: "New group" }] };
    const list = items(base, draft);
    expect(list).toHaveLength(base.values.length);
    expect(list.some((item) => item.fieldKey === "demographics")).toBe(false);
  });

  it("shows the SAVED value and its SAVED references even when the draft changes both", () => {
    const base = record(rows());
    const key = valueKey(STUDY_TARGET, "condition");
    const saved = byField(items(base), "condition");
    // The draft replaces the value and its quote with a different one.
    const draft = setValueEdit(new Map(base.values.map((v) => [valueKey(STUDY_TARGET, v.fieldKey), v])), createDraft(base), key, {
      ...NOT_RECORDED_EDIT,
      state: "reported",
      content: { shape: "text", text: "Obesity only" },
      references: [
        {
          kind: "new",
          localId: "ref_1",
          reference: { purpose: "supports", sourceKind: "abstract", paperId: PAPER_ID as never, snapshotId: SNAPSHOT_ID as never, quoteText: "HbA1c fell", occurrence: null, expectedMatchCount: null },
        },
      ],
    });
    const drafted = byField(items(base, draft), "condition");
    expect(drafted.value).toBe(saved.value);
    expect(drafted.value.content).toEqual({ shape: "text", text: "Type 2 diabetes and obesity" });
    expect(drafted.sources).toEqual(saved.sources);
    expect(drafted.sources.map((source) => source.kind === "quote" && source.quoteText)).toEqual(["type 2 diabetes"]);
    expect(drafted.confirm).toEqual({ kind: "held", hold: "unsaved_edit" });
  });
});

describe("sources, scoped to the paper and copy they name (FK-PROOF-001 §J)", () => {
  it("locates a quote on the current copy by the server's offsets, with context, and names its copy", () => {
    const outcome = byField(items(record(rows())), "outcome_name_as_reported");
    expect(outcome.sources).toHaveLength(1);
    const [source] = outcome.sources;
    if (source.kind !== "quote") throw new Error("expected a quote");
    expect([source.occurrence, source.count]).toEqual([2, 2]);
    expect(source.copy).toMatchObject({ total: 1, current: true, snapshot: { id: SNAPSHOT_ID, seq: 1 } });
    expect(source.paper).toEqual({ paperId: PAPER_ID, title: PAPER_TITLE });
    // Occurrence 2 — the passage at week 12, not the first one.
    expect(source.context?.match).toBe("body weight was measured");
    expect(source.context?.after).toContain(" again at week 12.");
    expect(source.context?.before).toContain("at baseline and ");
  });

  it("does not locate a quote on an earlier copy in the current one: its context is unknown", () => {
    const fixture = rows();
    fixture.snapshots = [snapshotRow({ id: OLD_COPY, seq: 1, captured_at: "2026-10-01T12:00:00.000Z" }), snapshotRow({ seq: 2 })];
    fixture.anchors = fixture.anchors.map((row) => (row.value_id === V.condition ? { ...row, snapshot_id: OLD_COPY } : row));
    const condition = byField(items(record(fixture)), "condition");
    const [source] = condition.sources;
    if (source.kind !== "quote") throw new Error("expected a quote");
    expect(source.copy).toMatchObject({ current: false, total: 2, snapshot: { id: OLD_COPY, seq: 1 } });
    expect(source.context).toBeNull();
    expect(condition.confirm).toEqual({ kind: "blocked", reasons: ["no_current_support"] });
  });

  it("describes examined, unavailable and full-text sources with their paper", () => {
    const fixture = rows();
    fixture.reports = [reportRow(), reportRow({ id: uuid("b", 2), paper_id: SECOND_PAPER_ID })];
    fixture.values.push(
      valueRow({ id: uuid("f", 20), field_key: "eligibility_criteria", value_state: "source_unavailable", value_text: null, value_version: 1 }),
      valueRow({ id: uuid("f", 21), field_key: "demographics", value_text: "Adults aged 40–70", value_version: 1 }),
    );
    fixture.anchors.push(
      anchor(20, uuid("f", 20), "unavailable", "abstract", { paper_id: SECOND_PAPER_ID }),
      anchor(21, uuid("f", 20), "unavailable", "full_text", { paper_id: PAPER_ID }),
      anchor(22, uuid("f", 21), "supports", "full_text", { paper_id: SECOND_PAPER_ID, locator_kind: "table", locator_text: "2" }),
    );
    const list = items(record(fixture));
    expect(byField(list, "eligibility_criteria").sources).toEqual([
      { kind: "unavailable", id: uuid("9", 20), paper: { paperId: SECOND_PAPER_ID, title: "Second report" }, sourceKind: "abstract", copyNow: false },
      { kind: "unavailable", id: uuid("9", 21), paper: { paperId: PAPER_ID, title: PAPER_TITLE }, sourceKind: "full_text", copyNow: false },
    ]);
    expect(byField(list, "demographics").sources).toEqual([
      { kind: "full_text", id: uuid("9", 22), paper: { paperId: SECOND_PAPER_ID, title: "Second report" }, purpose: "supports", locator: { kind: "table", text: "2" } },
    ]);
    expect(byField(list, "demographics").fromAbstractOnly).toBe(false);
    expect(byField(list, "condition").fromAbstractOnly).toBe(true);
    const registration = byField(list, "registration_ids");
    expect(registration.sources).toMatchObject([{ kind: "examined_abstract", paper: { paperId: PAPER_ID }, copy: { current: true } }]);
    expect(registration.abstractPaperIds).toEqual([PAPER_ID]);
  });

  it("scopes every source of a study with several linked reports to its own paper and copy", () => {
    const fixture = rows();
    fixture.reports = [reportRow(), reportRow({ id: uuid("b", 2), paper_id: SECOND_PAPER_ID })];
    const secondText = "A second report: 118 participants completed the trial.";
    fixture.snapshots.push(snapshotRow({ id: SECOND_COPY, paper_id: SECOND_PAPER_ID, exact_text: secondText, char_count: Array.from(secondText).length }));
    fixture.anchors.push(quote(30, V.nRandomized, "118 participants", { paper_id: SECOND_PAPER_ID, snapshot_id: SECOND_COPY, position: 1 }, secondText));
    const n = byField(items(record(fixture)), "n_randomized");
    expect(n.sources.map((source) => source.kind === "quote" && [source.paper.paperId, source.copy?.snapshot.id, source.context?.match])).toEqual([
      [PAPER_ID, SNAPSHOT_ID, "120 participants"],
      [SECOND_PAPER_ID, SECOND_COPY, "118 participants"],
    ]);
    expect(n.abstractPaperIds).toEqual([PAPER_ID, SECOND_PAPER_ID]);
  });

  it("depends only on the record: the same sources whatever the draft", () => {
    const base = record(rows());
    const sources = describeRecordSources(base);
    expect(buildReviewItems(base, createDraft(base), IDLE, sources)).toEqual(items(base));
  });
});

describe("what a card offers (the C2 audit §E5)", () => {
  it("offers Confirm and Flag for a saved, supported value when nothing holds it", () => {
    const condition = byField(items(record(rows())), "condition");
    expect(condition.confirm).toEqual({ kind: "offered" });
    expect(condition.flag).toEqual({ kind: "offered" });
    expect(condition.confirmCheck).toBe("allowed");
  });

  it("offers no Confirm for a version already reviewed, but still offers Flag", () => {
    const n = byField(items(record(rows())), "n_randomized");
    expect(n.confirm).toEqual({ kind: "already_reviewed" });
    expect(n.flag).toEqual({ kind: "offered" });
    expect(n.needsReview).toBe(false);
  });

  it("lets a flagged or needs-re-review value be confirmed when its sources allow it", () => {
    const list = items(record(rows()));
    expect(byField(list, "comparator_type").confirm).toEqual({ kind: "offered" });
    expect(byField(list, "arm_name_as_reported").confirm).toEqual({ kind: "offered" });
  });

  it("blocks Confirm for a Reported value with no source, and for a design classification without support", () => {
    const list = items(record(rows()));
    expect(byField(list, "setting").confirm).toEqual({ kind: "blocked", reasons: ["no_current_support"] });
    expect(byField(list, "design_classification").confirm).toEqual({ kind: "blocked", reasons: ["no_current_support"] });
    // Flag needs no source.
    expect(byField(list, "setting").flag).toEqual({ kind: "offered" });
  });

  it.each(VALUE_STATES.filter((state) => state !== "not_applicable"))("never treats an empty list of references as the source %s needs", (state: ValueState) => {
    const fixture = rows();
    const id = uuid("f", 40);
    fixture.values.push(
      valueRow({
        id,
        field_key: "eligibility_criteria",
        value_state: state,
        value_text: state === "reported" ? "Adults" : null,
        state_reason: state === "unclear" ? "ambiguous" : null,
        note: state === "unclear" ? "The abstract gives two different criteria." : null,
        value_version: 1,
      }),
    );
    const item = byField(items(record(fixture)), "eligibility_criteria");
    expect(item.sources).toEqual([]);
    expect(item.confirm.kind).toBe("blocked");
    expect(item.confirmCheck).toBe("blocked");
  });

  it("offers Confirm for Not applicable with its note and no source — the one state that takes none", () => {
    const fixture = rows();
    fixture.values.push(valueRow({ id: uuid("f", 41), field_key: "eligibility_criteria", value_state: "not_applicable", value_text: null, note: "Single centre", value_version: 1 }));
    expect(byField(items(record(fixture)), "eligibility_criteria").confirm).toEqual({ kind: "offered" });
  });

  it("blocks Confirm on an examined copy that is no longer current", () => {
    const fixture = rows();
    fixture.snapshots = [snapshotRow({ id: OLD_COPY, seq: 1 }), snapshotRow({ seq: 2 })];
    fixture.anchors = fixture.anchors.map((row) => (row.value_id === V.registration ? { ...row, snapshot_id: OLD_COPY } : row));
    expect(byField(items(record(fixture)), "registration_ids").confirm).toEqual({ kind: "blocked", reasons: ["examined_abstract_not_current"] });
  });

  it("never sees a count without its confirmed number: the read refuses such a row before Review could", () => {
    // `count_not_confirmed` is one of checkConfirm's defensive blocks (review.test.ts covers it).
    const fixture = rows();
    fixture.values = fixture.values.map((row) => (row.id === V.nRandomized ? { ...row, value_int: null, review_status: "unreviewed", reviewed_at: null, reviewed_version: null } : row));
    expect(() => record(fixture)).toThrow(StudyRecordReadError);
  });

  it("holds a value with an unsaved edit, and only that value; undoing the edit offers it again", () => {
    const base = record(rows());
    const baseValues = new Map(base.values.map((v) => [valueKey(STUDY_TARGET, v.fieldKey), v]));
    const key = valueKey(STUDY_TARGET, "condition");
    const edited = setValueEdit(baseValues, createDraft(base), key, { ...NOT_RECORDED_EDIT, state: "reported", content: { shape: "text", text: "T2D" } });
    const list = items(base, edited);
    expect(byField(list, "condition").confirm).toEqual({ kind: "held", hold: "unsaved_edit" });
    expect(byField(list, "condition").flag).toEqual({ kind: "held", hold: "unsaved_edit" });
    expect(byField(list, "setting").confirm).toEqual({ kind: "blocked", reasons: ["no_current_support"] });
    expect(byField(list, "outcome_name_as_reported").confirm).toEqual({ kind: "offered" });
    // Undo, or an edit back to the saved value, leaves no edit: it is offered again.
    expect(byField(items(base, revertValue(edited, key)), "condition").confirm).toEqual({ kind: "offered" });
    const condition = base.values.find((v) => v.fieldKey === "condition")!;
    const backToSaved = setValueEdit(baseValues, edited, key, { ...editFromRecorded(condition) });
    expect(backToSaved.values.has(key)).toBe(false);
    expect(byField(items(base, backToSaved), "condition").confirm).toEqual({ kind: "offered" });
  });

  it("holds the saved values of a group or outcome the draft removes", () => {
    const base = record(rows());
    const list = items(base, removeOutcome(removeArm(createDraft(base), ARM_COMPARATOR), OUTCOME_WEIGHT));
    expect(byField(list, "comparator_type").confirm).toEqual({ kind: "held", hold: "group_removal_pending" });
    expect(byField(list, "outcome_name_as_reported").flag).toEqual({ kind: "held", hold: "outcome_removal_pending" });
    expect(byField(list, "arm_name_as_reported").confirm).toEqual({ kind: "offered" });
  });

  it.each<[ReviewActivity]>([["busy"], ["unresolved"], ["changed_elsewhere"]])("holds every action while the editor is %s", (activity) => {
    const list = items(record(rows()), undefined, { canWrite: true, activity });
    for (const item of list) {
      expect(item.flag).toEqual({ kind: "held", hold: activity });
      if (item.confirm.kind !== "already_reviewed") expect(item.confirm).toEqual({ kind: "held", hold: activity });
    }
  });

  it("checks the holds in a fixed order: the editor first, then a removal, then the value's own edit", () => {
    expect(REVIEW_HOLDS).toEqual(["busy", "unresolved", "changed_elsewhere", "group_removal_pending", "outcome_removal_pending", "unsaved_edit"]);
    const base = record(rows());
    const removed = removeArm(createDraft(base), ARM_COMPARATOR);
    expect(byField(items(base, removed, { canWrite: true, activity: "unresolved" }), "comparator_type").confirm).toEqual({ kind: "held", hold: "unresolved" });
  });

  it("offers no action at all to a user who may not write, but shows every status", () => {
    const list = items(record(rows()), undefined, { canWrite: false, activity: "idle" });
    for (const item of list) {
      expect(item.confirm).toEqual({ kind: "none" });
      expect(item.flag).toEqual({ kind: "none" });
    }
    expect(list.map((item) => item.value.review.status).sort()).toEqual(["disputed", "needs_rereview", "unreviewed", "unreviewed", "unreviewed", "unreviewed", "unreviewed", "user_reviewed"]);
  });
});

describe("summary, filter and Confirm & next", () => {
  it("counts the saved values by their own status, and those that can't be confirmed yet — never a record-level verdict", () => {
    const summary = reviewSummary(items(record(rows())));
    expect(summary).toEqual({
      recorded: 8,
      counts: { unreviewed: 5, user_reviewed: 1, disputed: 1, needs_rereview: 1 },
      cannotConfirmYet: 2,
    });
    expect(JSON.stringify(summary)).not.toMatch(/verified|complete|accurate|correct|percent/i);
    expect(Object.values(summary.counts).reduce((a, b) => a + b, 0)).toBe(summary.recorded);
  });

  it("counts every review status", () => {
    for (const status of ["unreviewed", "user_reviewed", "disputed", "needs_rereview"] as ReviewStatus[]) {
      const fixture = rows();
      fixture.values = [valueRow({ id: V.condition, field_key: "condition", value_text: "T2D", review_status: status, ...(status === "user_reviewed" ? reviewedRow(2) : {}), review_reason: status === "needs_rereview" ? "source_changed" : null, review_note: status === "disputed" ? "Check" : null })];
      fixture.anchors = [quote(1, V.condition, "type 2 diabetes")];
      const summary = reviewSummary(items(record(fixture)));
      expect(summary.counts[status], status).toBe(1);
      expect(summary.recorded).toBe(1);
    }
  });

  it("filters to the values that need review by default, and changes nothing persisted", () => {
    const list = items(record(rows()));
    const needs = filterReviewItems(list, "needs_review");
    expect(needs.map((item) => item.fieldKey)).not.toContain("n_randomized");
    expect(needs).toHaveLength(7);
    expect(filterReviewItems(list, "all")).toEqual(list);
    expect(list.map((item) => item.value.review.status)).toEqual(items(record(rows())).map((item) => item.value.review.status));
  });

  it("moves to the next value that needs review, wrapping round, never to the one just confirmed", () => {
    const list = items(record(rows()));
    const keyOf = (field: string) => byField(list, field).key;
    expect(nextNeedingReview(list, keyOf("condition"))?.fieldKey).toBe("arm_name_as_reported"); // n_randomized is reviewed
    expect(nextNeedingReview(list, keyOf("outcome_name_as_reported"))?.fieldKey).toBe("design_classification"); // wraps
    const onlyOne = list.map((item) => (item.fieldKey === "condition" ? item : { ...item, needsReview: false }));
    expect(nextNeedingReview(onlyOne, keyOf("condition"))).toBeNull();
    expect(nextNeedingReview(list, "unknown-key")?.fieldKey).toBe("design_classification");
  });

  it("says whether a press still names the saved value, at the version it showed", () => {
    const list = items(record(rows()));
    const condition = byField(list, "condition");
    expect(reviewTargetState(list, condition.value.id, condition.value.valueVersion)).toEqual({ kind: "current", item: condition });
    expect(reviewTargetState(list, condition.value.id, condition.value.valueVersion - 1)).toEqual({ kind: "stale_version" });
    expect(reviewTargetState(list, toValueId(uuid("f", 99))!, 1)).toEqual({ kind: "not_recorded" });
  });
});
