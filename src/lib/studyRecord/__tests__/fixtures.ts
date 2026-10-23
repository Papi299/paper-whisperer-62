/**
 * Synthetic study records for the 001C1 tests. Built as database ROWS and
 * assembled by the real read path (`assembleStudyRecord`), so every fixture has
 * passed the same mapping and cross-checks a loaded record does.
 */

import type { Database } from "@/integrations/supabase/types";
import { assembleStudyRecord, type StudyRecordData } from "../read";

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

export const uuid = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const USER = uuid("1", 1);
export const OTHER_USER = uuid("1", 2);
export const STUDY_ID = uuid("5", 1);
export const PAPER_ID = uuid("a", 1);
export const SECOND_PAPER_ID = uuid("a", 2);
export const LINK_ID = uuid("b", 1);
export const SNAPSHOT_ID = uuid("c", 1);
export const ARM_INTERVENTION = uuid("d", 1);
export const ARM_COMPARATOR = uuid("d", 2);
export const OUTCOME_WEIGHT = uuid("e", 1);
export const VALUE_CONDITION = uuid("f", 1);
export const VALUE_COMPARATOR_TYPE = uuid("f", 2);
export const VALUE_N_RANDOMIZED = uuid("f", 3);
export const ANCHOR_CONDITION = uuid("9", 1);

const T0 = "2026-10-20T10:00:00.000Z";

// Built from code points: a thin space, superscripts and other scientific
// characters must reach the tests exactly, whatever the editor does to escapes.
export const THIN_SPACE = String.fromCodePoint(0x2009);
const SUPERSCRIPT_TWO = String.fromCodePoint(0x00b2);
const SUPERSCRIPT_NINE = String.fromCodePoint(0x2079);
const GREATER_EQUAL = String.fromCodePoint(0x2265);
const TIMES = String.fromCodePoint(0x00d7);

/** The phrase the abstract holds twice (occurrence disambiguation). */
export const REPEATED_PHRASE = "body weight was measured";

export const ABSTRACT = [
  `Background: Adults with type 2 diabetes and obesity (BMI ${GREATER_EQUAL}30${THIN_SPACE}kg/m${SUPERSCRIPT_TWO}) were randomized 1:1.`,
  `Methods: 120 participants received metformin or placebo for 12${THIN_SPACE}weeks; ${REPEATED_PHRASE} at baseline and ${REPEATED_PHRASE} again at week 12.`,
  `Results: Leukocytes stayed at 6.1${TIMES}10${SUPERSCRIPT_NINE}/L; HbA1c fell by 0.8${THIN_SPACE}% (p${THIN_SPACE}<${THIN_SPACE}0.001).`,
].join("\n");

export const PAPER_TITLE = "Metformin for weight in adults with type 2 diabetes: a randomized trial";

export function studyRow(overrides: Partial<Row<"evidence_studies">> = {}): Row<"evidence_studies"> {
  return {
    id: STUDY_ID,
    user_id: USER,
    label: "Doe 2024",
    design_profile: "rct_parallel",
    notes: null,
    row_version: 4,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function reportRow(overrides: Partial<Row<"evidence_study_reports">> = {}): Row<"evidence_study_reports"> {
  return {
    id: LINK_ID,
    user_id: USER,
    study_id: STUDY_ID,
    paper_id: PAPER_ID,
    link_status: "user_confirmed",
    link_basis: "created_from_paper",
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function snapshotRow(overrides: Partial<Row<"evidence_source_snapshots">> = {}): Row<"evidence_source_snapshots"> {
  const exactText = overrides.exact_text ?? ABSTRACT;
  return {
    id: SNAPSHOT_ID,
    user_id: USER,
    study_id: STUDY_ID,
    paper_id: PAPER_ID,
    seq: 1,
    source_kind: "library_abstract",
    exact_text: exactText,
    exact_sha256: "0".repeat(64),
    normalized_sha256: "0".repeat(64),
    normalization_version: "v1",
    char_count: Array.from(exactText).length,
    captured_at: T0,
    ...overrides,
  };
}

export function armRow(overrides: Partial<Row<"evidence_arms">> = {}): Row<"evidence_arms"> {
  return {
    id: ARM_INTERVENTION,
    user_id: USER,
    study_id: STUDY_ID,
    arm_role: "intervention",
    display_label: "Metformin",
    position: 0,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function outcomeRow(overrides: Partial<Row<"evidence_outcomes">> = {}): Row<"evidence_outcomes"> {
  return {
    id: OUTCOME_WEIGHT,
    user_id: USER,
    study_id: STUDY_ID,
    display_label: "Body weight",
    position: 0,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function valueRow(overrides: Partial<Row<"evidence_field_values">> = {}): Row<"evidence_field_values"> {
  return {
    id: VALUE_CONDITION,
    user_id: USER,
    study_id: STUDY_ID,
    arm_id: null,
    outcome_id: null,
    field_key: "condition",
    value_state: "reported",
    state_reason: null,
    value_text: "Type 2 diabetes and obesity",
    value_code: null,
    value_int: null,
    value_list: null,
    note: null,
    extraction_method: "manual",
    review_status: "unreviewed",
    review_reason: null,
    review_note: null,
    reviewed_at: null,
    reviewed_version: null,
    value_version: 2,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function quoteAnchorRow(overrides: Partial<Row<"evidence_field_anchors">> = {}): Row<"evidence_field_anchors"> {
  return {
    id: ANCHOR_CONDITION,
    user_id: USER,
    study_id: STUDY_ID,
    value_id: VALUE_CONDITION,
    paper_id: PAPER_ID,
    snapshot_id: SNAPSHOT_ID,
    purpose: "supports",
    source_kind: "abstract",
    position: 0,
    quote_text: "type 2 diabetes",
    match_start: 25,
    match_end: 40,
    match_occurrence: 1,
    match_count: 1,
    normalization_version: "v1",
    matched_at: T0,
    locator_kind: null,
    locator_text: null,
    created_at: T0,
    ...overrides,
  };
}

export interface FixtureRows {
  study: Row<"evidence_studies"> | null;
  reports: Row<"evidence_study_reports">[];
  snapshots: Row<"evidence_source_snapshots">[];
  arms: Row<"evidence_arms">[];
  outcomes: Row<"evidence_outcomes">[];
  values: Row<"evidence_field_values">[];
  anchors: Row<"evidence_field_anchors">[];
}

/** An RCT with two groups, one outcome, a quoted condition, a comparator type and a number randomized. */
export function fullRows(): FixtureRows {
  return {
    study: studyRow(),
    reports: [reportRow()],
    snapshots: [snapshotRow()],
    arms: [armRow(), armRow({ id: ARM_COMPARATOR, arm_role: "comparator", display_label: "Placebo", position: 1 })],
    outcomes: [outcomeRow()],
    values: [
      valueRow(),
      valueRow({
        id: VALUE_COMPARATOR_TYPE,
        arm_id: ARM_COMPARATOR,
        field_key: "comparator_type",
        value_text: null,
        value_code: "placebo",
        value_version: 1,
      }),
      valueRow({
        id: VALUE_N_RANDOMIZED,
        field_key: "n_randomized",
        value_text: "120 participants",
        value_int: 120,
        value_version: 1,
      }),
    ],
    anchors: [quoteAnchorRow()],
  };
}

/** Assemble rows the way `fetchStudyRecord` does (the current copies are the snapshots given). */
export function assemble(rows: FixtureRows = fullRows(), title: string | null = PAPER_TITLE): StudyRecordData {
  const snapshotInfo = rows.snapshots.map(({ exact_text: _t, exact_sha256: _e, normalized_sha256: _n, ...info }) => info);
  const papers = title === null ? [] : [...new Set(rows.reports.map((r) => r.paper_id))].map((id) => ({ id, user_id: USER, title }));
  return assembleStudyRecord(USER, STUDY_ID, { ...rows, snapshots: snapshotInfo }, rows.snapshots, papers);
}

/** A new record as `evidence_create_study_from_paper` leaves it: version 1, one link, one copy, nothing recorded. */
export function newRecord(designProfile = "rct_parallel", abstract: string | null = ABSTRACT): StudyRecordData {
  return assemble({
    study: studyRow({ row_version: 1, design_profile: designProfile }),
    reports: [reportRow()],
    snapshots: abstract === null ? [] : [snapshotRow({ exact_text: abstract, char_count: Array.from(abstract).length })],
    arms: [],
    outcomes: [],
    values: [],
    anchors: [],
  });
}
