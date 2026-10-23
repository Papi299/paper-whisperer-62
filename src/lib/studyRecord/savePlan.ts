/**
 * How one press of Save is sent (EVIDENCE-RECORDS-001C1).
 *
 * The study header and the record's contents have different RPCs:
 * `evidence_update_study` for the label, design family and notes, and
 * `evidence_save_changes` for groups, outcomes and values — whose one call is
 * atomic but holds at most 200 changes and 65,536 bytes (the limits the Product
 * Owner accepted; `EVIDENCE_FIELD_LIMITS`). So a Save is one or more STEPS,
 * sent one after another, and the UI says so whenever there is more than one:
 * each step is all-or-nothing on its own, but the steps are not one
 * transaction, and a failure leaves the earlier steps saved.
 *
 * The plan, in order:
 *   * The header step goes first — except when the design family is changing
 *     to one without groups, which the server refuses while any group or
 *     number randomized remains: then the contents go first, so their removal
 *     is saved before the family changes.
 *   * Every group and outcome change goes in the first contents batch,
 *     together with the value changes that must be checked with them (a
 *     group's role change and the clearing of its comparator type). Positions
 *     are checked on the final state of one batch, so splitting them could make
 *     a valid reorder look like a duplicate.
 *   * The remaining value changes are packed into as few batches as the two
 *     limits allow, in a fixed order. A value of a group added in an earlier
 *     batch names it by the id that batch returned.
 *
 * Sizes are exact, not estimated: each change is prepared by PR-B's
 * `prepareSaveChanges` and measured as PostgreSQL measures it
 * (`jsonbTextByteLength`); a group still to be created is counted at the
 * length of the id that will replace its ref.
 */

import type { DesignProfile } from "@/lib/evidence/fieldDictionary";
import { EVIDENCE_FIELD_LIMITS, prepareSaveChanges, type ChangeTarget, type SaveChange } from "@/lib/evidence/fieldRequests";
import { isInterventionFamily, type DraftChange } from "./draft";
import { jsonbTextByteLength } from "./jsonbSize";

/** A request id and study id of the right length, for measuring and checking a change on its own. */
const PLACEHOLDER_UUID = "00000000-0000-4000-8000-000000000000";

/** "[" and "]" around a batch, and ", " between its changes. */
const ARRAY_BYTES = 2;
const SEPARATOR_BYTES = 2;

const STRUCTURE_OPS: ReadonlySet<SaveChange["op"]> = new Set(["add_arm", "update_arm", "remove_arm", "add_outcome", "update_outcome", "remove_outcome"]);

export interface HeaderStep {
  readonly kind: "update_study";
  readonly requestId: string;
  readonly label: string;
  readonly designProfile: DesignProfile;
  readonly notes: string | null;
}

export interface BatchStep {
  readonly kind: "save_changes";
  readonly requestId: string;
  readonly changes: readonly DraftChange[];
  /** The batch's size as the server measures it, with refs counted at id length. */
  readonly bytes: number;
}

export type SaveStep = HeaderStep | BatchStep;

export type SavePlan =
  | { readonly ok: true; readonly steps: readonly SaveStep[] }
  | {
      readonly ok: false;
      /**
       * `nothing_to_save` — no change; `invalid_change` — a change PR-B's
       * builder refuses (validation should have caught it first);
       * `too_large` — the group and outcome changes alone, or one value change,
       * exceed what one call can hold.
       */
      readonly reason: "nothing_to_save" | "invalid_change" | "too_large";
    };

/** `change` with any batch ref in its target replaced by `idFor(ref)`. */
export function resolveTargetRefs(change: SaveChange, idFor: (scope: "arm" | "outcome", ref: string) => string | null): SaveChange | null {
  if (change.op !== "set_value" && change.op !== "clear_value") return change;
  const target: ChangeTarget = change.target;
  if ("armRef" in target) {
    const id = idFor("arm", target.armRef);
    return id ? { ...change, target: { scope: "arm", armId: id } } : null;
  }
  if ("outcomeRef" in target) {
    const id = idFor("outcome", target.outcomeRef);
    return id ? { ...change, target: { scope: "outcome", outcomeId: id } } : null;
  }
  return change;
}

/**
 * A batch ready to send: a value of a group or outcome added in THIS batch
 * keeps its ref; one added by an earlier batch is named by the id that batch
 * returned. Null when a ref resolves to nothing (its batch never ran).
 */
export function resolveBatchRefs(
  changes: readonly SaveChange[],
  armIds: ReadonlyMap<string, string>,
  outcomeIds: ReadonlyMap<string, string>,
): SaveChange[] | null {
  const addedArms = new Set(changes.flatMap((change) => (change.op === "add_arm" ? [change.ref] : [])));
  const addedOutcomes = new Set(changes.flatMap((change) => (change.op === "add_outcome" ? [change.ref] : [])));
  const resolved: SaveChange[] = [];
  for (const change of changes) {
    const next = resolveTargetRefs(change, (scope, ref) => {
      if (scope === "arm") return addedArms.has(ref) ? null : armIds.get(ref) ?? null;
      return addedOutcomes.has(ref) ? null : outcomeIds.get(ref) ?? null;
    });
    if (next) {
      resolved.push(next);
      continue;
    }
    // Unresolved: legitimate only when the ref is added in this very batch.
    const target = (change as { target?: ChangeTarget }).target;
    const sameBatch = target && (("armRef" in target && addedArms.has(target.armRef)) || ("outcomeRef" in target && addedOutcomes.has(target.outcomeRef)));
    if (!sameBatch) return null;
    resolved.push(change);
  }
  return resolved;
}

/** One change's bytes inside a batch, as the server measures them; null when PR-B's builder refuses it. */
export function changeBytes(change: SaveChange): number | null {
  const measured = resolveTargetRefs(change, () => PLACEHOLDER_UUID);
  if (!measured) return null;
  const prepared = prepareSaveChanges({ studyId: PLACEHOLDER_UUID, expectedVersion: 1, changes: [measured], requestId: PLACEHOLDER_UUID });
  if (!prepared.ok) return null;
  return jsonbTextByteLength((prepared.request.args.p_changes as unknown[])[0]);
}

export interface PlanInput {
  /** The header as it will be saved, or null when it did not change. */
  readonly header: { readonly label: string; readonly designProfile: DesignProfile; readonly notes: string | null } | null;
  readonly changes: readonly DraftChange[];
  /** One fresh id per step, generated once: a retry of a step resends that step's id. */
  readonly newRequestId: () => string;
  readonly limits?: { readonly changes: number; readonly bytes: number };
}

export function planSave({ header, changes, newRequestId, limits }: PlanInput): SavePlan {
  const maxChanges = limits?.changes ?? EVIDENCE_FIELD_LIMITS.changesPerSave;
  const maxBytes = limits?.bytes ?? EVIDENCE_FIELD_LIMITS.saveBytes;
  if (!header && changes.length === 0) return { ok: false, reason: "nothing_to_save" };

  const sized: { change: DraftChange; bytes: number }[] = [];
  for (const change of changes) {
    const bytes = changeBytes(change.change);
    if (bytes === null) return { ok: false, reason: "invalid_change" };
    sized.push({ change, bytes });
  }
  const first = sized.filter((entry) => entry.change.withStructure || STRUCTURE_OPS.has(entry.change.change.op));
  const rest = sized.filter((entry) => !first.includes(entry));

  const batches: { changes: DraftChange[]; bytes: number }[] = [];
  let current: { changes: DraftChange[]; bytes: number } = { changes: [], bytes: ARRAY_BYTES };
  const fits = (batch: typeof current, bytes: number) =>
    batch.changes.length < maxChanges && batch.bytes + (batch.changes.length > 0 ? SEPARATOR_BYTES : 0) + bytes <= maxBytes;
  const add = (batch: typeof current, entry: { change: DraftChange; bytes: number }) => {
    batch.bytes += (batch.changes.length > 0 ? SEPARATOR_BYTES : 0) + entry.bytes;
    batch.changes.push(entry.change);
  };

  for (const entry of first) {
    if (!fits(current, entry.bytes)) return { ok: false, reason: "too_large" };
    add(current, entry);
  }
  for (const entry of rest) {
    if (!fits(current, entry.bytes)) {
      if (current.changes.length > 0) batches.push(current);
      current = { changes: [], bytes: ARRAY_BYTES };
      if (!fits(current, entry.bytes)) return { ok: false, reason: "too_large" };
    }
    add(current, entry);
  }
  if (current.changes.length > 0) batches.push(current);

  const batchSteps: BatchStep[] = batches.map((batch) => ({ kind: "save_changes", requestId: newRequestId(), changes: batch.changes, bytes: batch.bytes }));
  if (!header) return { ok: true, steps: batchSteps };
  const headerStep: HeaderStep = { kind: "update_study", requestId: newRequestId(), ...header };
  // To a family without groups: remove them first, then change the family.
  return { ok: true, steps: isInterventionFamily(header.designProfile) ? [headerStep, ...batchSteps] : [...batchSteps, headerStep] };
}
