/**
 * FK-PROOF-001 §J, "Cross-row rules", transcribed from the specification for
 * tests. Deliberately NOT read from `VALUE_STATE_RULES`, `checkStateReferences`
 * or any other module under test: these predicates are the contract, so a test
 * that compares the implementation with them cannot pass by agreeing with
 * itself.
 *
 *   State               supports   examined                     unavailable
 *   reported            0-3 (1)    0                            0
 *   not_reported        0          at least 1                   any
 *   unclear             any        any, with at least one       any
 *                                  supports or examined
 *   source_unavailable  0          0                            at least 1
 *   not_applicable      0          0                            0
 *
 *   (1) "Confirm needs at least 1 on the current copy or a full-text locator."
 *
 * In every state a value holds at most three supporting references: PR-A1's
 * `evidence_field_anchors_position_check` (positions 0-2) and
 * `evidence_field_anchors_value_position_key` (one per position and value).
 */

import type { ValueState } from "../../types";

export interface PurposeCounts {
  readonly supports: number;
  readonly examined: number;
  readonly unavailable: number;
}

const SUPPORTS_CAP = 3;

/** Whether §J lets a value in `state` hold references in these numbers. */
export const SECTION_J_ALLOWS: Readonly<Record<ValueState, (counts: PurposeCounts) => boolean>> = {
  reported: ({ supports, examined, unavailable }) => supports <= SUPPORTS_CAP && examined === 0 && unavailable === 0,
  not_reported: ({ supports, examined }) => supports === 0 && examined >= 1,
  unclear: ({ supports, examined }) => supports <= SUPPORTS_CAP && supports + examined >= 1,
  source_unavailable: ({ supports, examined, unavailable }) => supports === 0 && examined === 0 && unavailable >= 1,
  not_applicable: ({ supports, examined, unavailable }) => supports === 0 && examined === 0 && unavailable === 0,
};

/**
 * Whether §J lets such a value be confirmed when every reference is on the
 * current copy: what the state allows, and for Reported at least one
 * supporting source.
 */
export function sectionJConfirmable(state: ValueState, counts: PurposeCounts): boolean {
  return SECTION_J_ALLOWS[state](counts) && (state !== "reported" || counts.supports >= 1);
}

/** Every state and purpose pair §J's table forbids outright (a 0 in its row). */
export const SECTION_J_FORBIDDEN: readonly (readonly [ValueState, keyof PurposeCounts])[] = [
  ["reported", "examined"],
  ["reported", "unavailable"],
  ["not_reported", "supports"],
  ["source_unavailable", "supports"],
  ["source_unavailable", "examined"],
  ["not_applicable", "supports"],
  ["not_applicable", "examined"],
  ["not_applicable", "unavailable"],
];
