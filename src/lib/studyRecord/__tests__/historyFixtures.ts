/**
 * Synthetic history for the EVIDENCE-RECORDS-001C2B tests: `evidence_events`
 * rows exactly as the installed RPCs write them — a header at ordinal 0 with
 * its op, payload fingerprint and result, then change events at ordinals 1..n
 * with the digests of `evidence_value_digest` and the before/after objects of
 * each RPC (20261016104232, 20261017155445). `historyModel.parity.test.ts`
 * checks the key sets used here against the migration SQL.
 *
 * Every header also carries what History must never select or show: its
 * `payload_sha256`, its `result` (with the request's own ids) and — on one
 * planted change row — a `note`.
 */

import type { Database } from "@/integrations/supabase/types";
import { ARM_COMPARATOR, ARM_INTERVENTION, LINK_ID, OUTCOME_WEIGHT, PAPER_ID, SNAPSHOT_ID, STUDY_ID, USER, uuid, VALUE_COMPARATOR_TYPE, VALUE_CONDITION, VALUE_N_RANDOMIZED } from "./fixtures";

export type EventRow = Database["public"]["Tables"]["evidence_events"]["Row"];
type Json = Record<string, unknown>;

/** A distinct, well-formed fingerprint per number: never a real one, never text. */
export const sha = (n: number) => n.toString(16).padStart(64, "0");
export const textDigest = (n: number, chars: number) => ({ sha256: sha(n), chars });

export const SECOND_SNAPSHOT_ID = uuid("c", 2);
export const ANCHOR_CONDITION_QUOTE = uuid("9", 1);
export const ANCHOR_N_QUOTE = uuid("9", 3);
const T0 = Date.parse("2026-10-20T10:00:00.000Z");

export const requestIdOf = (version: number) => uuid("7", version);
export const occurredAtOf = (version: number) => new Date(T0 + version * 3_600_000).toISOString();

/** The digest of one value, as `evidence_value_digest` builds it. */
export function valueDigest(options: {
  valueId: string;
  fieldKey: string;
  armId?: string | null;
  outcomeId?: string | null;
  state?: string;
  stateReason?: string | null;
  content?: Json | null;
  note?: Json | null;
  valueVersion?: number;
  review?: { status?: string; reason?: string | null; reviewedAt?: string | null; reviewedVersion?: number | null; note?: Json | null };
  references?: Json[];
}): Json {
  const state = options.state ?? "reported";
  return {
    value_id: options.valueId,
    field_key: options.fieldKey,
    arm_id: options.armId ?? null,
    outcome_id: options.outcomeId ?? null,
    value_state: state,
    state_reason: options.stateReason ?? null,
    content: options.content === undefined ? (state === "reported" ? { text: textDigest(1, 27) } : null) : options.content,
    note: options.note ?? null,
    value_version: options.valueVersion ?? 1,
    review: {
      status: options.review?.status ?? "unreviewed",
      reason: options.review?.reason ?? null,
      reviewed_at: options.review?.reviewedAt ?? null,
      reviewed_version: options.review?.reviewedVersion ?? null,
      note: options.review?.note ?? null,
    },
    references: options.references ?? [],
  };
}

/** A supporting abstract quote, as the digest names it. */
export function quoteReference(anchorId: string, options: { snapshotId?: string; seq?: number; position?: number; quote?: number } = {}): Json {
  return {
    anchor_id: anchorId,
    purpose: "supports",
    source_kind: "abstract",
    paper_id: PAPER_ID,
    snapshot_id: options.snapshotId ?? SNAPSHOT_ID,
    snapshot_seq: options.seq ?? 1,
    position: options.position ?? 0,
    quote: textDigest(options.quote ?? 50, 16),
    match: { start: 25, end: 41, occurrence: 1, count: 1 },
    locator: null,
  };
}

export function examinedAbstract(anchorId: string): Json {
  return { anchor_id: anchorId, purpose: "examined", source_kind: "abstract", paper_id: PAPER_ID, snapshot_id: SNAPSHOT_ID, snapshot_seq: 1, position: null, quote: null, match: null, locator: null };
}

export function fullTextReference(anchorId: string, position = 0): Json {
  return {
    anchor_id: anchorId,
    purpose: "supports",
    source_kind: "full_text",
    paper_id: PAPER_ID,
    snapshot_id: null,
    snapshot_seq: null,
    position,
    quote: null,
    match: null,
    locator: { kind: "table", text: textDigest(60, 7) },
  };
}

/** One request header, as every RPC writes it. */
export function headerRow(version: number, op: string, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: uuid("8", version * 1000),
    user_id: USER,
    study_id: STUDY_ID,
    study_version: version,
    ordinal: 0,
    event_type: "request",
    request_id: requestIdOf(version),
    op,
    payload_sha256: `\\x${"ab".repeat(32)}`,
    result: { status: "applied", study_id: STUDY_ID, study_version: version, link_id: LINK_ID, snapshot_id: SNAPSHOT_ID },
    target_id: null,
    field_key: null,
    before: null,
    after: null,
    note: null,
    occurred_at: occurredAtOf(version),
    ...overrides,
  };
}

/** One change event of the request at `version`. */
export function changeRow(
  version: number,
  ordinal: number,
  eventType: string,
  change: { target: string; fieldKey?: string | null; before?: unknown; after?: unknown },
  overrides: Partial<EventRow> = {},
): EventRow {
  return {
    id: uuid("8", version * 1000 + ordinal),
    user_id: USER,
    study_id: STUDY_ID,
    study_version: version,
    ordinal,
    event_type: eventType,
    request_id: requestIdOf(version),
    op: null,
    payload_sha256: null,
    result: null,
    target_id: change.target,
    field_key: change.fieldKey ?? null,
    before: (change.before ?? null) as EventRow["before"],
    after: (change.after ?? null) as EventRow["after"],
    note: null,
    occurred_at: occurredAtOf(version),
    ...overrides,
  };
}

const conditionDigest = (overrides: Partial<Parameters<typeof valueDigest>[0]> = {}) =>
  valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition", references: [quoteReference(ANCHOR_CONDITION_QUOTE)], ...overrides });
const comparatorDigest = (overrides: Partial<Parameters<typeof valueDigest>[0]> = {}) =>
  valueDigest({ valueId: VALUE_COMPARATOR_TYPE, fieldKey: "comparator_type", armId: ARM_COMPARATOR, content: { code: "placebo" }, ...overrides });
const nDigest = (overrides: Partial<Parameters<typeof valueDigest>[0]> = {}) =>
  valueDigest({
    valueId: VALUE_N_RANDOMIZED,
    fieldKey: "n_randomized",
    content: { reported_text: textDigest(3, 16), value: 120 },
    references: [quoteReference(ANCHOR_N_QUOTE, { quote: 51 })],
    ...overrides,
  });

/**
 * Twelve committed operations on the fixture study — every request op, and
 * every event type an installed RPC can write today (`link_removed` cannot
 * happen: a study's last link can't be removed and no link can be added; it
 * has its own tests):
 *   1 create · 2 save (two groups, an outcome, three values) · 3 Confirm ·
 *   4 Flag · 5 save that resets a review · 6 study details (name, kind, notes) ·
 *   7–8 link status, both ways · 9 a group renamed and moved, another moved,
 *   the outcome renamed · 10 Confirm · 11 a rebase (new copy, one quote found
 *   again, one not, one value to re-review) · 12 save that removes the
 *   outcome and a group, and clears a flagged value.
 */
export function historyRows(): EventRow[] {
  const reviewed = (version: number, valueVersion: number) => ({ status: "user_reviewed", reviewedAt: occurredAtOf(version), reviewedVersion: valueVersion });
  return [
    headerRow(1, "create_study"),
    changeRow(1, 1, "study_created", { target: STUDY_ID, after: { label: "Doe 2024", design_profile: "rct_parallel", notes: null } }),
    changeRow(1, 2, "link_created", { target: LINK_ID, after: { paper_id: PAPER_ID, link_status: "user_confirmed", link_basis: "created_from_paper" } }),
    changeRow(1, 3, "source_captured", {
      target: SNAPSHOT_ID,
      after: {
        paper_id: PAPER_ID,
        seq: 1,
        source_kind: "library_abstract",
        exact_sha256: sha(900),
        normalized_sha256: sha(901),
        normalization_version: "v1",
        char_count: 412,
        previous_snapshot_id: null,
      },
    }),

    headerRow(2, "save_changes"),
    changeRow(2, 1, "arm_added", { target: ARM_INTERVENTION, after: { arm_role: "intervention", display_label: "Metformin", position: 0 } }),
    changeRow(2, 2, "arm_added", { target: ARM_COMPARATOR, after: { arm_role: "comparator", display_label: "Placebo", position: 1 } }),
    changeRow(2, 3, "outcome_added", { target: OUTCOME_WEIGHT, after: { display_label: "Body weight", position: 0 } }),
    changeRow(2, 4, "value_saved", { target: VALUE_CONDITION, fieldKey: "condition", before: null, after: conditionDigest() }),
    changeRow(2, 5, "value_saved", { target: VALUE_COMPARATOR_TYPE, fieldKey: "comparator_type", before: null, after: comparatorDigest() }),
    changeRow(2, 6, "value_saved", { target: VALUE_N_RANDOMIZED, fieldKey: "n_randomized", before: null, after: nDigest() }),

    headerRow(3, "review_fields"),
    changeRow(3, 1, "review_confirmed", { target: VALUE_CONDITION, fieldKey: "condition", before: conditionDigest(), after: conditionDigest({ review: reviewed(3, 1) }) }),

    headerRow(4, "review_fields"),
    changeRow(4, 1, "review_flagged", {
      target: VALUE_COMPARATOR_TYPE,
      fieldKey: "comparator_type",
      before: comparatorDigest(),
      after: comparatorDigest({ review: { status: "disputed", note: textDigest(70, 17) } }),
    }),

    headerRow(5, "save_changes"),
    changeRow(5, 1, "value_saved", {
      target: VALUE_CONDITION,
      fieldKey: "condition",
      before: conditionDigest({ review: reviewed(3, 1) }),
      after: conditionDigest({ content: { text: textDigest(2, 31) }, valueVersion: 2 }),
    }),

    headerRow(6, "update_study"),
    changeRow(6, 1, "study_updated", {
      target: STUDY_ID,
      before: { label: "Doe 2024", design_profile: "rct_parallel", notes: null },
      after: { label: "Doe 2024 trial", design_profile: "intervention_other", notes: textDigest(80, 140) },
    }),

    headerRow(7, "set_link"),
    changeRow(7, 1, "link_status_changed", {
      target: LINK_ID,
      before: { paper_id: PAPER_ID, link_status: "user_confirmed" },
      after: { paper_id: PAPER_ID, link_status: "provisional" },
    }),

    headerRow(8, "set_link"),
    changeRow(8, 1, "link_status_changed", {
      target: LINK_ID,
      before: { paper_id: PAPER_ID, link_status: "provisional" },
      after: { paper_id: PAPER_ID, link_status: "user_confirmed" },
    }),

    headerRow(9, "save_changes"),
    changeRow(9, 1, "arm_updated", {
      target: ARM_COMPARATOR,
      before: { display_label: "Placebo", position: 1 },
      after: { display_label: "Placebo tablets", position: 0 },
    }),
    changeRow(9, 2, "arm_updated", { target: ARM_INTERVENTION, before: { position: 0 }, after: { position: 1 } }),
    changeRow(9, 3, "outcome_updated", { target: OUTCOME_WEIGHT, before: { display_label: "Body weight" }, after: { display_label: "Body weight (kg)" } }),

    headerRow(10, "review_fields"),
    changeRow(10, 1, "review_confirmed", { target: VALUE_N_RANDOMIZED, fieldKey: "n_randomized", before: nDigest(), after: nDigest({ review: reviewed(10, 1) }) }),

    headerRow(11, "rebase_source"),
    changeRow(11, 1, "source_captured", {
      target: SECOND_SNAPSHOT_ID,
      after: {
        paper_id: PAPER_ID,
        seq: 2,
        source_kind: "library_abstract",
        exact_sha256: sha(902),
        normalized_sha256: sha(903),
        normalization_version: "v1",
        char_count: 430,
        previous_snapshot_id: SNAPSHOT_ID,
      },
    }),
    changeRow(11, 2, "anchor_not_rematched", {
      target: ANCHOR_CONDITION_QUOTE,
      fieldKey: "condition",
      after: { value_id: VALUE_CONDITION, kept_snapshot_id: SNAPSHOT_ID, kept_seq: 1, outcome: "not_found", count: 0 },
    }),
    changeRow(11, 3, "anchor_rematched", {
      target: ANCHOR_N_QUOTE,
      fieldKey: "n_randomized",
      before: { value_id: VALUE_N_RANDOMIZED, snapshot_id: SNAPSHOT_ID, seq: 1, match_start: 40, match_end: 56, match_occurrence: 1, match_count: 1 },
      after: { value_id: VALUE_N_RANDOMIZED, snapshot_id: SECOND_SNAPSHOT_ID, seq: 2, match_start: 44, match_end: 60, match_occurrence: 1, match_count: 1 },
    }),
    changeRow(11, 4, "review_needs_rereview", {
      target: VALUE_N_RANDOMIZED,
      fieldKey: "n_randomized",
      before: nDigest({ review: reviewed(10, 1) }),
      after: nDigest({
        valueVersion: 2,
        review: { status: "needs_rereview", reason: "source_changed" },
        references: [quoteReference(ANCHOR_N_QUOTE, { quote: 51, snapshotId: SECOND_SNAPSHOT_ID, seq: 2 })],
      }),
    }),
    changeRow(11, 5, "source_rebased", {
      target: SECOND_SNAPSHOT_ID,
      after: {
        paper_id: PAPER_ID,
        snapshot_id: SECOND_SNAPSHOT_ID,
        previous_snapshot_id: SNAPSHOT_ID,
        quotes_rechecked: 2,
        rematched: 1,
        not_found: 1,
        ambiguous: 0,
        values_needing_rereview: 1,
        values_changed: 2,
      },
    }),

    headerRow(12, "save_changes"),
    // Groups and outcomes first, then values: the save RPC's phase order.
    changeRow(12, 1, "outcome_removed", { target: OUTCOME_WEIGHT, before: { display_label: "Body weight (kg)", position: 0, values: [] } }),
    changeRow(12, 2, "arm_removed", {
      target: ARM_INTERVENTION,
      before: { arm_role: "intervention", display_label: "Metformin", position: 1, values: [{ value_id: uuid("f", 20), field_key: "description", value_state: "reported", value_version: 1 }] },
    }),
    changeRow(
      12,
      3,
      "value_cleared",
      { target: VALUE_COMPARATOR_TYPE, fieldKey: "comparator_type", before: comparatorDigest({ review: { status: "disputed", note: textDigest(70, 17) } }) },
      // Planted: no RPC writes a change event's note. History never selects it.
      { note: "PLANTED-NOTE-NEVER-SHOWN" },
    ),
  ];
}

/** `count` operations, each a one-change save at versions 1..count (no digests needed: for paging tests). */
export function manyOperations(count: number): EventRow[] {
  const rows: EventRow[] = [];
  for (let version = 1; version <= count; version += 1) {
    rows.push(headerRow(version, version === 1 ? "create_study" : "save_changes"));
    rows.push(
      version === 1
        ? changeRow(1, 1, "study_created", { target: STUDY_ID, after: { label: "Doe 2024", design_profile: "rct_parallel", notes: null } })
        : changeRow(version, 1, "outcome_added", { target: uuid("e", version), after: { display_label: `Outcome ${version}`, position: 0 } }),
    );
  }
  return rows;
}

/** One save of `count` change events at `version` (a large request: paged details). */
export function largeSave(version: number, count: number): EventRow[] {
  const rows = [headerRow(version, "save_changes")];
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    rows.push(changeRow(version, ordinal, "outcome_added", { target: uuid("e", 100 + ordinal), after: { display_label: `Outcome ${ordinal}`, position: ordinal % 100 } }));
  }
  return rows;
}
