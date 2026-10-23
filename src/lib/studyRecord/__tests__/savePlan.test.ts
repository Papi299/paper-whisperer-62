import { describe, expect, it } from "vitest";
import { EVIDENCE_FIELD_LIMITS, prepareSaveChanges, type SaveChange } from "@/lib/evidence/fieldRequests";
import type { DraftChange } from "../draft";
import { jsonbTextByteLength } from "../jsonbSize";
import { changeBytes, planSave, resolveBatchRefs, type BatchStep, type SavePlan } from "../savePlan";
import { STUDY_ID, uuid } from "./fixtures";

/**
 * How one press of Save is sent (EVIDENCE-RECORDS-001C1): one or more steps,
 * each atomic on the server and within the accepted per-call limits (200
 * changes, 65,536 bytes of `p_changes::text`), with one request id per step
 * generated once — never a dropped change, never a fresh id for a retry.
 */

let idCounter = 0;
const newRequestId = () => uuid("7", ++idCounter);

const setText = (n: number, text = `Definition ${n}`): DraftChange => ({
  change: {
    op: "set_value",
    target: { scope: "outcome", outcomeId: uuid("e", n) },
    fieldKey: "outcome_definition",
    expectedValueVersion: null,
    state: "reported",
    stateReason: null,
    content: { shape: "text", text },
    note: null,
    references: [],
  },
  origin: { kind: "value", key: `outcome:${uuid("e", n)}|outcome_definition` },
  withStructure: false,
});

const structure = (change: SaveChange, key: string): DraftChange => ({ change, origin: { kind: "arm", key }, withStructure: true });

const steps = (plan: SavePlan) => {
  expect(plan.ok).toBe(true);
  return plan.ok ? plan.steps : [];
};
const batches = (plan: SavePlan) => steps(plan).filter((step): step is BatchStep => step.kind === "save_changes");

/** The bytes the server would measure for a batch, with refs left as refs. */
function serverBytes(batch: BatchStep): number {
  const prepared = prepareSaveChanges({ studyId: STUDY_ID, expectedVersion: 1, changes: batch.changes.map((c) => c.change), requestId: uuid("7", 999) });
  expect(prepared.ok).toBe(true);
  return prepared.ok ? jsonbTextByteLength(prepared.request.args.p_changes) : Infinity;
}

const header = (designProfile: "rct_parallel" | "non_intervention") => ({ label: "Doe 2024", designProfile, notes: null });

describe("planSave", () => {
  it("has nothing to send for an untouched draft", () => {
    expect(planSave({ header: null, changes: [], newRequestId })).toEqual({ ok: false, reason: "nothing_to_save" });
  });

  it("sends a header-only change as one update_study step", () => {
    const plan = planSave({ header: header("rct_parallel"), changes: [], newRequestId });
    expect(steps(plan)).toEqual([{ kind: "update_study", requestId: expect.any(String), label: "Doe 2024", designProfile: "rct_parallel", notes: null }]);
  });

  it("sends the header first, except when moving to a family without groups", () => {
    const removal = structure({ op: "remove_arm", armId: uuid("d", 1) }, uuid("d", 1));
    expect(steps(planSave({ header: header("rct_parallel"), changes: [removal], newRequestId })).map((s) => s.kind)).toEqual(["update_study", "save_changes"]);
    expect(steps(planSave({ header: header("non_intervention"), changes: [removal], newRequestId })).map((s) => s.kind)).toEqual(["save_changes", "update_study"]);
  });

  it("gives each step its own request id, generated once with the plan", () => {
    let calls = 0;
    const counting = () => {
      calls += 1;
      return newRequestId();
    };
    const plan = planSave({ header: header("rct_parallel"), changes: [1, 2, 3, 4, 5].map((n) => setText(n)), newRequestId: counting, limits: { changes: 2, bytes: 65_536 } });
    const ids = steps(plan).map((step) => step.requestId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(calls).toBe(4);
  });

  it("splits by the change limit without dropping or reordering a change", () => {
    const changes = Array.from({ length: EVIDENCE_FIELD_LIMITS.changesPerSave + 1 }, (_, i) => setText(i + 1));
    const planned = batches(planSave({ header: null, changes, newRequestId }));
    expect(planned.map((batch) => batch.changes.length)).toEqual([200, 1]);
    expect(planned.flatMap((batch) => batch.changes)).toEqual(changes);
  });

  it("splits by the byte limit, measured exactly as the server measures it", () => {
    const long = (n: number) => setText(n, `${"x".repeat(3990)} ${n}`);
    const changes = Array.from({ length: 20 }, (_, i) => long(i + 1));
    const planned = batches(planSave({ header: null, changes, newRequestId }));
    expect(planned.length).toBeGreaterThan(1);
    for (const batch of planned) {
      expect(batch.bytes).toBe(serverBytes(batch));
      expect(batch.bytes).toBeLessThanOrEqual(EVIDENCE_FIELD_LIMITS.saveBytes);
    }
    expect(planned.flatMap((batch) => batch.changes)).toEqual(changes);
  });

  it("packs a batch right up to the byte limit and no further", () => {
    const one = changeBytes(setText(1).change)!;
    // Room for exactly two changes: "[" + a + ", " + b + "]".
    const limit = 2 + one + 2 + changeBytes(setText(2).change)!;
    const planned = batches(planSave({ header: null, changes: [setText(1), setText(2), setText(3)], newRequestId, limits: { changes: 200, bytes: limit } }));
    expect(planned.map((batch) => batch.changes.length)).toEqual([2, 1]);
    expect(planned[0].bytes).toBe(limit);
  });

  it("keeps every group and outcome change in the first batch", () => {
    const changes: DraftChange[] = [
      setText(1),
      structure({ op: "add_arm", ref: "arm_1", armRole: "intervention", displayLabel: "A", position: 0 }, "arm_1"),
      setText(2),
      structure({ op: "update_arm", armId: uuid("d", 1), armRole: "comparator", displayLabel: "B", position: 1 }, uuid("d", 1)),
      setText(3),
    ];
    const planned = batches(planSave({ header: null, changes, newRequestId, limits: { changes: 3, bytes: 65_536 } }));
    expect(planned[0].changes.map((c) => c.change.op)).toEqual(["add_arm", "update_arm", "set_value"]);
    expect(planned.flatMap((batch) => batch.changes)).toHaveLength(5);
  });

  it("refuses, rather than splits, structure that one call cannot hold", () => {
    const changes = [1, 2, 3].map((n) => structure({ op: "remove_arm", armId: uuid("d", n) }, uuid("d", n)));
    expect(planSave({ header: null, changes, newRequestId, limits: { changes: 2, bytes: 65_536 } })).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses a single change larger than one call", () => {
    expect(planSave({ header: null, changes: [setText(1)], newRequestId, limits: { changes: 200, bytes: 50 } })).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses a change PR-B's builder would not send", () => {
    const bad: DraftChange = {
      change: { ...(setText(1).change as Extract<SaveChange, { op: "set_value" }>), fieldKey: "comparator_type" },
      origin: { kind: "value", key: "x" },
      withStructure: false,
    };
    expect(planSave({ header: null, changes: [bad], newRequestId })).toEqual({ ok: false, reason: "invalid_change" });
  });
});

describe("resolveBatchRefs", () => {
  const addArm: SaveChange = { op: "add_arm", ref: "arm_1", armRole: "intervention", displayLabel: "A", position: 0 };
  const valueOfNewArm: SaveChange = {
    op: "set_value",
    target: { scope: "arm", armRef: "arm_1" },
    fieldKey: "description",
    expectedValueVersion: null,
    state: "reported",
    stateReason: null,
    content: { shape: "text", text: "Twice daily" },
    note: null,
    references: [],
  };

  it("keeps a ref the same batch adds", () => {
    expect(resolveBatchRefs([addArm, valueOfNewArm], new Map(), new Map())).toEqual([addArm, valueOfNewArm]);
  });

  it("names a group an earlier batch added by the id the server returned", () => {
    const id = uuid("d", 7);
    expect(resolveBatchRefs([valueOfNewArm], new Map([["arm_1", id]]), new Map())).toEqual([{ ...valueOfNewArm, target: { scope: "arm", armId: id } }]);
  });

  it("refuses a ref nothing created", () => {
    expect(resolveBatchRefs([valueOfNewArm], new Map(), new Map())).toBeNull();
  });
});
