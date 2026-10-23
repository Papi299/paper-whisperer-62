import { describe, expect, it } from "vitest";
import { toPaperId, toSnapshotId } from "@/lib/evidence/ids";
import {
  addArm,
  addOutcome,
  armTarget,
  createDraft,
  indexBaseValues,
  NOT_RECORDED_EDIT,
  setValueEdit,
  STUDY_TARGET,
  updateArm,
  updateHeader,
  valueKey,
  type DraftValueEdit,
} from "../draft";
import { hasErrors, validateDraft } from "../validateDraft";
import { ABSTRACT, ARM_COMPARATOR, assemble, fullRows, newRecord, PAPER_ID, REPEATED_PHRASE, SNAPSHOT_ID, valueRow } from "./fixtures";

/**
 * The browser's checks before anything is sent (EVIDENCE-RECORDS-001C1). The
 * server decides; these point at the input so the user can fix it first.
 */

const fresh = newRecord();
const freshValues = indexBaseValues(fresh);
const codes = (base = fresh, draft = createDraft(fresh)) => validateDraft(base, indexBaseValues(base), draft).map((issue) => `${issue.severity}:${issue.code}`);

const conditionKey = valueKey(STUDY_TARGET, "condition");
const quote = (quoteText: string, occurrence: number | null = null, expectedMatchCount: number | null = null): DraftValueEdit["references"][number] => ({
  kind: "new",
  localId: "ref_1",
  reference: {
    purpose: "supports",
    sourceKind: "abstract",
    paperId: toPaperId(PAPER_ID)!,
    snapshotId: toSnapshotId(SNAPSHOT_ID)!,
    quoteText,
    occurrence,
    expectedMatchCount,
  },
});
const withValue = (key: string, edit: Omit<DraftValueEdit, "expectedValueVersion">) => setValueEdit(freshValues, createDraft(fresh), key, edit);

describe("validateDraft", () => {
  it("passes an untouched record", () => {
    expect(codes()).toEqual([]);
  });

  it("refuses an empty or over-long study name", () => {
    expect(hasErrors(validateDraft(fresh, freshValues, updateHeader(createDraft(fresh), { label: "   " })))).toBe(true);
    expect(hasErrors(validateDraft(fresh, freshValues, updateHeader(createDraft(fresh), { label: "x".repeat(121) })))).toBe(true);
    expect(hasErrors(validateDraft(fresh, freshValues, updateHeader(createDraft(fresh), { label: "x".repeat(120) })))).toBe(false);
  });

  it("warns, but allows saving, a Reported value without a source: “No source given”", () => {
    const issues = validateDraft(fresh, freshValues, withValue(conditionKey, { ...NOT_RECORDED_EDIT, state: "reported", content: { shape: "text", text: "T2D" } }));
    expect(issues).toEqual([expect.objectContaining({ code: "value.no_source_given", message: "No source given", severity: "warning" })]);
    expect(hasErrors(issues)).toBe(false);
  });

  it("accepts a quote found once, and a repeated quote only with the occurrence chosen", () => {
    const reported = { ...NOT_RECORDED_EDIT, state: "reported" as const, content: { shape: "text" as const, text: "T2D" } };
    expect(codes(fresh, withValue(conditionKey, { ...reported, references: [quote("metformin or placebo")] }))).toEqual([]);
    expect(codes(fresh, withValue(conditionKey, { ...reported, references: [quote(REPEATED_PHRASE, 2, 2)] }))).toEqual([]);
    expect(hasErrors(validateDraft(fresh, freshValues, withValue(conditionKey, { ...reported, references: [quote(REPEATED_PHRASE)] })))).toBe(true);
  });

  it("refuses a quote that is not in the saved copy", () => {
    const issues = validateDraft(
      fresh,
      freshValues,
      withValue(conditionKey, { ...NOT_RECORDED_EDIT, state: "reported", content: { shape: "text", text: "T2D" }, references: [quote("insulin glargine")] }),
    );
    expect(hasErrors(issues)).toBe(true);
    expect(issues[0].path).toEqual(["references", 0, "quoteText"]);
  });

  it("requires a reason, an explanation and a basis for Unclear, and an explanation for Not applicable", () => {
    const examined: DraftValueEdit["references"][number] = {
      kind: "new",
      localId: "ref_2",
      reference: { purpose: "examined", sourceKind: "abstract", paperId: toPaperId(PAPER_ID)!, snapshotId: toSnapshotId(SNAPSHOT_ID)! },
    };
    const unclear = { ...NOT_RECORDED_EDIT, state: "unclear" as const, stateReason: "ambiguous" as const, note: "Two different definitions." };
    expect(hasErrors(validateDraft(fresh, freshValues, withValue(conditionKey, { ...NOT_RECORDED_EDIT, state: "unclear" })))).toBe(true);
    // Reason and explanation, but nothing it is unclear in: the basis is required (§J).
    expect(validateDraft(fresh, freshValues, withValue(conditionKey, unclear)).map((issue) => issue.code)).toEqual(["references.basis_required"]);
    expect(hasErrors(validateDraft(fresh, freshValues, withValue(conditionKey, { ...unclear, references: [examined] })))).toBe(false);
    expect(hasErrors(validateDraft(fresh, freshValues, withValue(conditionKey, { ...NOT_RECORDED_EDIT, state: "not_applicable" })))).toBe(true);
  });

  it("refuses a confirmed number that is not a plain whole number", () => {
    const key = valueKey(STUDY_TARGET, "n_randomized");
    const edit = (valueText: string) => ({ ...NOT_RECORDED_EDIT, state: "reported" as const, content: { shape: "integer_with_reported_text" as const, reportedText: "120 participants", valueText } });
    expect(hasErrors(validateDraft(fresh, freshValues, withValue(key, edit("120"))))).toBe(false);
    expect(hasErrors(validateDraft(fresh, freshValues, withValue(key, edit("12.5"))))).toBe(true);
    expect(hasErrors(validateDraft(fresh, freshValues, withValue(key, edit(""))))).toBe(true);
  });

  it("refuses groups in a study without an assigned intervention", () => {
    const record = newRecord("non_intervention");
    const draft = addArm(createDraft(record), "intervention", "A").draft;
    expect(codes(record, draft)).toContain("error:study.groups_not_allowed");
  });

  it("names a group or outcome without a name, at that group or outcome", () => {
    const withArm = addArm(createDraft(fresh), "intervention", "  ");
    const withOutcome = addOutcome(withArm.draft, "");
    const issues = validateDraft(fresh, freshValues, withOutcome.draft);
    expect(issues.map((issue) => issue.target)).toEqual([
      { kind: "arm", key: withArm.key },
      { kind: "outcome", key: withOutcome.key },
    ]);
  });

  it("does not hide a stored value the new role no longer allows: it must be resolved", () => {
    const base = assemble();
    const draft = updateArm(createDraft(base), ARM_COMPARATOR, { role: "intervention" });
    const issues = validateDraft(base, indexBaseValues(base), draft);
    expect(issues).toContainEqual(expect.objectContaining({ code: "field.not_allowed_for_design", target: { kind: "value", key: valueKey(armTarget(ARM_COMPARATOR), "comparator_type") } }));
  });

  it("refuses Number randomized in a study without an assigned intervention", () => {
    const base = assemble();
    const draft = updateHeader(createDraft(base), { designProfile: "non_intervention" });
    expect(codes(base, draft)).toEqual(expect.arrayContaining(["error:study.groups_not_allowed", "error:study.n_randomized_not_allowed"]));
  });

  it("counts recorded fields against the per-record limit", () => {
    const rows = fullRows();
    const base = assemble({ ...rows, values: [rows.values[0]], anchors: rows.anchors });
    expect(codes(base, createDraft(base)).filter((code) => code.includes("limit"))).toEqual([]);
    // A stored value on a field that exists is checked for nothing else while untouched.
    expect(validateDraft(assemble({ ...rows, values: [valueRow()], anchors: rows.anchors }), indexBaseValues(base), createDraft(base))).toEqual([]);
  });

  it("checks against the saved copy, never the live abstract", () => {
    const record = newRecord("rct_parallel", ABSTRACT.replace("metformin", "sitagliptin"));
    const issues = validateDraft(
      record,
      indexBaseValues(record),
      setValueEdit(indexBaseValues(record), createDraft(record), conditionKey, {
        ...NOT_RECORDED_EDIT,
        state: "reported",
        content: { shape: "text", text: "T2D" },
        references: [quote("metformin or placebo")],
      }),
    );
    expect(hasErrors(issues)).toBe(true);
  });
});
