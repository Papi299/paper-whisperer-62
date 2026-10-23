import { describe, expect, it } from "vitest";
import { toArmId, toOutcomeId, type ArmId, type OutcomeId } from "@/lib/evidence/ids";
import {
  addArm,
  addOutcome,
  armTarget,
  buildChanges,
  changeArmRole,
  changeFamily,
  createDraft,
  familyChangeImpact,
  indexBaseValues,
  isDraftDirty,
  moveArm,
  NOT_RECORDED_EDIT,
  outcomeTarget,
  parseConfirmedInteger,
  rebaseAfterSave,
  removeArm,
  removeOutcome,
  restoreArm,
  setValueEdit,
  STUDY_TARGET,
  updateHeader,
  valueKey,
  viewValue,
} from "../draft";
import { ARM_COMPARATOR, ARM_INTERVENTION, assemble, newRecord, OUTCOME_WEIGHT, uuid } from "./fixtures";

/**
 * The editor's in-memory draft (EVIDENCE-RECORDS-001C1): the intended final
 * state of what the user touched, with the value version each edit started
 * from — and nothing else.
 */

const base = assemble();
const baseValues = indexBaseValues(base);
const conditionKey = valueKey(STUDY_TARGET, "condition");
const settingKey = valueKey(STUDY_TARGET, "setting");
const nRandomizedKey = valueKey(STUDY_TARGET, "n_randomized");
const comparatorTypeKey = valueKey(armTarget(ARM_COMPARATOR), "comparator_type");

const reportedText = (text: string) => ({ ...NOT_RECORDED_EDIT, state: "reported" as const, content: { shape: "text" as const, text } });
const ops = (draft = createDraft(base)) => buildChanges(base, draft).map((entry) => entry.change.op);

describe("value edits", () => {
  it("shows the stored value until the user touches it", () => {
    const draft = createDraft(base);
    const view = viewValue(baseValues, draft, conditionKey);
    expect(view.touched).toBe(false);
    expect(view.edit.state).toBe("reported");
    expect(view.edit.content).toEqual({ shape: "text", text: "Type 2 diabetes and obesity" });
    expect(viewValue(baseValues, draft, settingKey).edit).toBe(NOT_RECORDED_EDIT);
  });

  it("captures the value version at the first edit and keeps it for later edits", () => {
    let draft = setValueEdit(baseValues, createDraft(base), conditionKey, reportedText("T2D"));
    expect(draft.values.get(conditionKey)?.expectedValueVersion).toBe(2);
    draft = setValueEdit(baseValues, draft, conditionKey, reportedText("T2D and obesity"));
    expect(draft.values.get(conditionKey)?.expectedValueVersion).toBe(2);
    // A field not recorded yet is created: no expected version.
    draft = setValueEdit(baseValues, draft, settingKey, reportedText("Outpatient clinics"));
    expect(draft.values.get(settingKey)?.expectedValueVersion).toBeNull();
  });

  it("drops an edit that comes back to the stored value, so dirty means Save would change something", () => {
    const stored = viewValue(baseValues, createDraft(base), conditionKey).edit;
    let draft = setValueEdit(baseValues, createDraft(base), conditionKey, reportedText("Changed"));
    expect(isDraftDirty(base, draft)).toBe(true);
    const { expectedValueVersion: _v, ...unchanged } = stored;
    draft = setValueEdit(baseValues, draft, conditionKey, unchanged);
    expect(draft.values.has(conditionKey)).toBe(false);
    expect(isDraftDirty(base, draft)).toBe(false);
  });

  it("keeps the content while another state is tried, but sends it only for Reported", () => {
    const draft = setValueEdit(baseValues, createDraft(base), conditionKey, {
      ...viewValue(baseValues, createDraft(base), conditionKey).edit,
      state: "not_reported",
      references: [],
    });
    expect(draft.values.get(conditionKey)?.content).toEqual({ shape: "text", text: "Type 2 diabetes and obesity" });
    const [change] = buildChanges(base, draft).map((entry) => entry.change);
    expect(change).toMatchObject({ op: "set_value", fieldKey: "condition", state: "not_reported", content: null, expectedValueVersion: 2 });
  });

  it("clears a stored value back to Not yet recorded with clear_value", () => {
    const draft = setValueEdit(baseValues, createDraft(base), nRandomizedKey, { ...NOT_RECORDED_EDIT, cleared: true });
    expect(buildChanges(base, draft).map((entry) => entry.change)).toEqual([
      { op: "clear_value", target: { scope: "study" }, fieldKey: "n_randomized", expectedValueVersion: 1 },
    ]);
  });

  it("parses a confirmed number strictly, never guessing", () => {
    expect(parseConfirmedInteger(" 120 ")).toBe(120);
    expect(parseConfirmedInteger("")).toBeUndefined();
    for (const text of ["12.5", "1,200", "−3", "120 participants", "1e3", "0x10"]) expect(parseConfirmedInteger(text)).toBeNaN();
  });
});

describe("groups and outcomes", () => {
  it("adds a group with a local ref and saves it at its on-screen position", () => {
    const { key, draft } = addArm(createDraft(base), "intervention", "Higher dose");
    expect(key).toBe("arm_1");
    expect(buildChanges(base, draft).map((entry) => entry.change)).toEqual([
      { op: "add_arm", ref: "arm_1", armRole: "intervention", displayLabel: "Higher dose", position: 2 },
    ]);
  });

  it("reorders with dense, distinct positions", () => {
    const draft = moveArm(createDraft(base), ARM_COMPARATOR, -1);
    expect(buildChanges(base, draft).map((entry) => entry.change)).toEqual([
      { op: "update_arm", armId: ARM_COMPARATOR, armRole: "comparator", displayLabel: "Placebo", position: 0 },
      { op: "update_arm", armId: ARM_INTERVENTION, armRole: "intervention", displayLabel: "Metformin", position: 1 },
    ]);
    expect(moveArm(createDraft(base), ARM_INTERVENTION, -1)).toEqual(createDraft(base));
  });

  it("marks a saved group for removal, with its values, and Undo restores it in place", () => {
    let draft = setValueEdit(baseValues, createDraft(base), comparatorTypeKey, { ...NOT_RECORDED_EDIT, cleared: true });
    draft = removeArm(draft, ARM_COMPARATOR);
    expect(draft.arms.map((arm) => arm.key)).toEqual([ARM_INTERVENTION]);
    expect(draft.values.has(comparatorTypeKey)).toBe(false);
    expect(buildChanges(base, draft).map((entry) => entry.change)).toEqual([{ op: "remove_arm", armId: ARM_COMPARATOR }]);
    draft = restoreArm(base, draft, ARM_COMPARATOR as ArmId);
    expect(draft.arms.map((arm) => arm.key)).toEqual([ARM_INTERVENTION, ARM_COMPARATOR]);
    expect(buildChanges(base, draft)).toEqual([]);
  });

  it("drops a group added in this draft, with its draft values, without a removal", () => {
    const added = addArm(createDraft(base), "intervention", "New");
    let draft = setValueEdit(baseValues, added.draft, valueKey(armTarget(added.key), "description"), reportedText("Twice daily"));
    draft = removeArm(draft, added.key);
    expect(buildChanges(base, draft)).toEqual([]);
    expect(draft.removedArms).toEqual([]);
  });

  it("removes outcomes the same way", () => {
    const draft = removeOutcome(createDraft(base), OUTCOME_WEIGHT);
    expect(buildChanges(base, draft).map((entry) => entry.change)).toEqual([{ op: "remove_outcome", outcomeId: OUTCOME_WEIGHT }]);
  });

  it("orders changes: removals, groups, outcomes, then values (study, groups, outcomes; dictionary order)", () => {
    let draft = createDraft(base);
    draft = setValueEdit(baseValues, draft, valueKey(outcomeTarget(OUTCOME_WEIGHT), "time_points"), {
      ...NOT_RECORDED_EDIT,
      state: "reported",
      content: { shape: "text_list", entries: ["12 weeks"] },
    });
    draft = setValueEdit(baseValues, draft, settingKey, reportedText("Clinics"));
    draft = setValueEdit(baseValues, draft, conditionKey, reportedText("T2D"));
    draft = addOutcome(draft, "HbA1c").draft;
    draft = removeArm(draft, ARM_COMPARATOR);
    expect(ops(draft)).toEqual(["remove_arm", "add_outcome", "set_value", "set_value", "set_value"]);
    const fields = buildChanges(base, draft).flatMap((entry) => (entry.change.op === "set_value" ? [entry.change.fieldKey] : []));
    expect(fields).toEqual(["setting", "condition", "time_points"]);
  });
});

describe("design family and group roles", () => {
  it("says what moving to a study without an assigned intervention would take away", () => {
    expect(familyChangeImpact(baseValues, createDraft(base), "non_intervention")).toEqual({ groups: 2, groupValues: 1, numberRandomized: true });
    expect(familyChangeImpact(baseValues, createDraft(base), "intervention_other")).toEqual({ groups: 0, groupValues: 0, numberRandomized: false });
  });

  it("removes the groups and clears the number randomized only when asked to move", () => {
    const draft = changeFamily(baseValues, createDraft(base), "non_intervention");
    expect(draft.header.designProfile).toBe("non_intervention");
    expect(draft.arms).toEqual([]);
    expect(ops(draft)).toEqual(["remove_arm", "remove_arm", "clear_value"]);
  });

  it("clears the comparator type when a comparator becomes an intervention group, and sends both together", () => {
    const draft = changeArmRole(baseValues, createDraft(base), ARM_COMPARATOR, "intervention");
    const changes = buildChanges(base, draft);
    expect(changes.map((entry) => [entry.change.op, entry.withStructure])).toEqual([
      ["update_arm", true],
      ["clear_value", true],
    ]);
  });
});

describe("rebaseAfterSave", () => {
  it("drops saved edits, gives new groups their ids, and moves their unsaved edits along", () => {
    const added = addArm(createDraft(base), "intervention", "Higher dose");
    const descriptionKey = valueKey(armTarget(added.key), "description");
    let draft = setValueEdit(baseValues, added.draft, descriptionKey, reportedText("1,000 mg"));
    draft = setValueEdit(baseValues, draft, conditionKey, reportedText("T2D"));
    const newId = toArmId(uuid("d", 9))!;

    const after = rebaseAfterSave(draft, [{ kind: "arm", key: added.key }, { kind: "value", key: conditionKey }], new Map([[added.key, newId]]), new Map<string, OutcomeId>());
    expect(after.arms.at(-1)).toEqual({ key: newId, id: newId, role: "intervention", displayLabel: "Higher dose" });
    expect(after.values.has(conditionKey)).toBe(false);
    expect(after.values.get(valueKey(armTarget(newId), "description"))).toEqual(draft.values.get(descriptionKey));
  });

  it("leaves everything unsaved exactly as it was", () => {
    const draft = setValueEdit(baseValues, removeOutcome(createDraft(base), OUTCOME_WEIGHT), conditionKey, reportedText("T2D"));
    const after = rebaseAfterSave(draft, [], new Map(), new Map());
    expect(after.values).toEqual(draft.values);
    expect(after.removedOutcomes).toEqual(draft.removedOutcomes);
  });

  it("forgets only the removals that were saved", () => {
    const draft = removeOutcome(removeArm(createDraft(base), ARM_COMPARATOR), OUTCOME_WEIGHT);
    const after = rebaseAfterSave(draft, [{ kind: "arm", key: ARM_COMPARATOR }], new Map(), new Map());
    expect(after.removedArms).toEqual([]);
    expect(after.removedOutcomes.map((entry) => entry.id)).toEqual([toOutcomeId(OUTCOME_WEIGHT)]);
  });
});

describe("header", () => {
  it("is dirty for a label, family or notes change, and treats empty notes as none", () => {
    const fresh = newRecord();
    expect(isDraftDirty(fresh, createDraft(fresh))).toBe(false);
    expect(isDraftDirty(fresh, updateHeader(createDraft(fresh), { label: "Another" }))).toBe(true);
    expect(isDraftDirty(fresh, updateHeader(createDraft(fresh), { notes: "" }))).toBe(false);
    expect(isDraftDirty(fresh, updateHeader(createDraft(fresh), { notes: "Pilot" }))).toBe(true);
    // The header is saved by its own RPC, never as a field change.
    expect(buildChanges(fresh, updateHeader(createDraft(fresh), { label: "Another" }))).toEqual([]);
  });
});
