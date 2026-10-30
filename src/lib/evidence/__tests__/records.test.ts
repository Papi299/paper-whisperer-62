// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Database } from "@/integrations/supabase/types";
import {
  mapArmRow,
  mapEventRow,
  mapFieldAnchorRow,
  mapFieldValueRow,
  mapOutcomeRow,
  mapSourceSnapshotRow,
  mapStudyReportRow,
  mapStudyRow,
} from "../records";
import { cp } from "./fixtures/vectors";

/**
 * Generated rows mapped onto the domain models, failing closed on anything the
 * schema could not have written.
 */

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T = "2026-10-17T00:00:00+00:00";

const study: Row<"evidence_studies"> = { id: U(1), user_id: U(99), label: "Smith 2021", design_profile: "rct_parallel", notes: null, row_version: 2, created_at: T, updated_at: T };
const report: Row<"evidence_study_reports"> = { id: U(2), user_id: U(99), study_id: U(1), paper_id: U(3), link_status: "provisional", link_basis: "created_from_paper", created_at: T, updated_at: T };
const snapshot: Row<"evidence_source_snapshots"> = {
  id: U(4), user_id: U(99), study_id: U(1), paper_id: U(3), seq: 1, source_kind: "library_abstract",
  exact_text: `Caf${cp(0x00e9)} ${cp(0x1f600)}`, exact_sha256: "\\x00", normalized_sha256: "\\x00", normalization_version: "v1", char_count: 6, captured_at: T,
};
const anchorBase: Row<"evidence_field_anchors"> = {
  id: U(5), user_id: U(99), study_id: U(1), value_id: U(6), paper_id: U(3), snapshot_id: null, purpose: "unavailable", source_kind: "full_text",
  position: null, quote_text: null, match_start: null, match_end: null, match_occurrence: null, match_count: null, normalization_version: null,
  matched_at: null, locator_kind: null, locator_text: null, created_at: T,
};
const quoteAnchor: Row<"evidence_field_anchors"> = {
  ...anchorBase, purpose: "supports", source_kind: "abstract", snapshot_id: U(4), position: 0, quote_text: "type 2 diabetes",
  match_start: 12, match_end: 27, match_occurrence: 1, match_count: 1, normalization_version: "v1", matched_at: T,
};
const valueBase: Row<"evidence_field_values"> = {
  id: U(6), user_id: U(99), study_id: U(1), arm_id: null, outcome_id: null, field_key: "condition", value_state: "reported", state_reason: null,
  value_text: "Type 2 diabetes", value_code: null, value_int: null, value_list: null, note: null, extraction_method: "manual",
  review_status: "unreviewed", review_reason: null, review_note: null, reviewed_at: null, reviewed_version: null, value_version: 1, created_at: T, updated_at: T,
};
const event: Row<"evidence_events"> = {
  id: U(7), user_id: U(99), study_id: U(1), study_version: 1, ordinal: 0, event_type: "request", request_id: U(8), op: "create_study",
  payload_sha256: "\\x00", result: { status: "applied" }, target_id: null, field_key: null, before: null, after: null, note: null, occurred_at: T,
};

const problems = (result: { ok: boolean; problems?: readonly string[] }) => (result.ok ? [] : [...(result.problems ?? [])]);

describe("study, link, copy, group and outcome rows", () => {
  it("map onto the domain models", () => {
    expect(mapStudyRow(study)).toEqual({ ok: true, value: { id: U(1), label: "Smith 2021", designProfile: "rct_parallel", notes: null, version: 2, createdAt: T, updatedAt: T } });
    expect(mapStudyReportRow(report)).toEqual({ ok: true, value: { id: U(2), studyId: U(1), paperId: U(3), status: "provisional", basis: "created_from_paper" } });
    expect(mapSourceSnapshotRow(snapshot)).toMatchObject({ ok: true, value: { seq: 1, charCount: 6, normalizationVersion: "v1" } });
    expect(mapArmRow({ id: U(9), user_id: U(99), study_id: U(1), arm_role: "comparator", display_label: "Placebo", position: 1, created_at: T, updated_at: T })).toMatchObject({ ok: true, value: { role: "comparator" } });
    expect(mapOutcomeRow({ id: U(10), user_id: U(99), study_id: U(1), display_label: "HbA1c", position: 0, created_at: T, updated_at: T })).toMatchObject({ ok: true });
  });

  it("refuse what the schema cannot hold, naming the column, not its content", () => {
    expect(problems(mapStudyRow({ ...study, design_profile: "rct", row_version: 0 }))).toEqual(["design_profile", "row_version"]);
    expect(problems(mapStudyReportRow({ ...report, link_status: "maybe", paper_id: "p" }))).toEqual(["paper_id", "link_status"]);
    // char_count counts code points: the emoji is one character.
    expect(problems(mapSourceSnapshotRow({ ...snapshot, char_count: 7 }))).toEqual(["char_count"]);
    expect(problems(mapSourceSnapshotRow({ ...snapshot, source_kind: "publisher_pdf", normalization_version: "v2" }))).toEqual(["source_kind", "normalization_version"]);
    expect(problems(mapArmRow({ id: U(9), user_id: U(99), study_id: U(1), arm_role: "placebo", display_label: "x", position: 100, created_at: T, updated_at: T }))).toEqual(["arm_role", "position"]);
    const leaked = mapStudyRow({ ...study, design_profile: "Smith 2021 secret" });
    expect(JSON.stringify(leaked)).not.toContain("secret");
  });
});

describe("source-reference rows: the PR-A1 matrix", () => {
  it("map each purpose and source kind to its own variant", () => {
    expect(mapFieldAnchorRow(quoteAnchor)).toMatchObject({
      ok: true,
      value: { valueId: U(6), reference: { purpose: "supports", sourceKind: "abstract", snapshotId: U(4), quoteText: "type 2 diabetes", match: { attestation: "server", normalizedStart: 12, normalizedEnd: 27, occurrence: 1, count: 1 } } },
    });
    expect(mapFieldAnchorRow({ ...anchorBase, purpose: "supports", position: 1, locator_kind: "table", locator_text: "Table 2" })).toMatchObject({
      ok: true,
      value: { reference: { purpose: "supports", sourceKind: "full_text", locator: { kind: "table", text: "Table 2" } } },
    });
    expect(mapFieldAnchorRow({ ...anchorBase, purpose: "examined", source_kind: "abstract", snapshot_id: U(4) })).toMatchObject({ ok: true, value: { reference: { purpose: "examined", snapshotId: U(4) } } });
    expect(mapFieldAnchorRow({ ...anchorBase, purpose: "examined" })).toMatchObject({ ok: true, value: { reference: { purpose: "examined", sourceKind: "full_text", locator: null } } });
    expect(mapFieldAnchorRow(anchorBase)).toMatchObject({ ok: true, value: { reference: { purpose: "unavailable", sourceKind: "full_text" } } });
  });

  it.each<[string, Partial<Row<"evidence_field_anchors">>, string]>([
    ["a quote without its match", { match_count: null }, "match"],
    ["a match ending before it starts", { match_end: 12 }, "match"],
    ["an occurrence beyond the count", { match_occurrence: 2 }, "match"],
    ["a quote too short", { quote_text: "ab" }, "match"],
    ["a quote with a locator", { locator_kind: "page", locator_text: "4" }, "locator"],
    ["a quote without its copy", { snapshot_id: null }, "snapshot_id"],
    ["a quote at position 3", { position: 3 }, "position"],
  ])("refuse %s", (_label, change, problem) => {
    expect(problems(mapFieldAnchorRow({ ...quoteAnchor, ...change }))).toContain(problem);
  });

  it("refuse full-text quotes, half locators, and copies or positions where none belong", () => {
    expect(problems(mapFieldAnchorRow({ ...anchorBase, purpose: "supports", position: 0, locator_kind: "page", locator_text: "4", quote_text: "A passage" }))).toContain("match");
    expect(problems(mapFieldAnchorRow({ ...anchorBase, purpose: "examined", locator_kind: "page" }))).toContain("locator");
    expect(problems(mapFieldAnchorRow({ ...anchorBase, snapshot_id: U(4) }))).toContain("snapshot_id");
    expect(problems(mapFieldAnchorRow({ ...anchorBase, position: 0 }))).toContain("position");
    expect(problems(mapFieldAnchorRow({ ...anchorBase, purpose: "cites" }))).toEqual(["purpose"]);
  });
});

describe("value rows", () => {
  it("map each shape", () => {
    expect(mapFieldValueRow(valueBase, [])).toMatchObject({ ok: true, value: { target: { scope: "study" }, content: { shape: "text", text: "Type 2 diabetes" }, review: { status: "unreviewed" } } });
    expect(mapFieldValueRow({ ...valueBase, field_key: "n_randomized", value_text: "n = 120", value_int: 120 }, [])).toMatchObject({ ok: true, value: { content: { shape: "integer_with_reported_text", value: 120 } } });
    expect(mapFieldValueRow({ ...valueBase, outcome_id: U(10), field_key: "time_points", value_text: null, value_list: ["12 weeks"] }, [])).toMatchObject({ ok: true, value: { target: { scope: "outcome" }, content: { entries: ["12 weeks"] } } });
    expect(mapFieldValueRow({ ...valueBase, value_state: "not_reported", value_text: null }, [])).toMatchObject({ ok: true, value: { content: null } });
    expect(mapFieldValueRow({ ...valueBase, review_status: "user_reviewed", reviewed_at: T, reviewed_version: 1 }, [])).toMatchObject({ ok: true, value: { review: { status: "user_reviewed", reviewedVersion: 1 } } });
  });

  it.each<[string, Partial<Row<"evidence_field_values">>, string]>([
    ["a key outside its scope", { arm_id: U(9) }, "field_key"],
    ["a value for two entities", { arm_id: U(9), outcome_id: U(10) }, "target"],
    ["an unknown key", { field_key: "n_randomized_arm" }, "field_key"],
    ["the wrong shape", { value_code: "x" }, "value"],
    ["a code outside the list", { field_key: "design_classification", value_text: null, value_code: "meta_analysis" }, "value"],
    ["a number out of range", { field_key: "n_enrolled", value_int: 10_000_001 }, "value"],
    ["a value on a non-reported state", { value_state: "not_applicable", note: "n/a" }, "value"],
    ["Unclear without its reason", { value_state: "unclear", value_text: null, note: "abstract gives two" }, "state_reason"],
    ["a reason on another state", { state_reason: "ambiguous" }, "state_reason"],
    ["a review without its version", { review_status: "user_reviewed", reviewed_at: T }, "reviewed"],
    ["a review of another version", { review_status: "user_reviewed", reviewed_at: T, reviewed_version: 2 }, "reviewed"],
    ["needs re-review without its reason", { review_status: "needs_rereview" }, "review_reason"],
    ["an AI extraction", { extraction_method: "ai" }, "extraction_method"],
  ])("refuse %s", (_label, change, problem) => {
    expect(problems(mapFieldValueRow({ ...valueBase, ...change }, []))).toContain(problem);
  });
});

describe("history rows", () => {
  it("map a request header and a change event", () => {
    expect(mapEventRow(event)).toMatchObject({ ok: true, value: { ordinal: 0, type: "request", op: "create_study" } });
    // A whole generated row still maps: the mapper takes the columns it reads, and a row has them all.
    const change: Row<"evidence_events"> = { ...event, ordinal: 1, event_type: "study_created", op: null, payload_sha256: null, result: null };
    expect(mapEventRow(change)).toMatchObject({ ok: true, value: { op: null } });
  });

  it("read only the columns a history read selects (C2B): never user_id, payload_sha256, result or note", () => {
    const { user_id: _user, payload_sha256: _payload, result: _result, note: _note, ...projected } = event;
    expect(mapEventRow(projected)).toMatchObject({ ok: true, value: { ordinal: 0, type: "request", op: "create_study" } });
    const mapped = mapEventRow(projected);
    expect(mapped.ok && Object.keys(mapped.value).sort()).toEqual(
      ["after", "before", "fieldKey", "id", "occurredAt", "op", "ordinal", "requestId", "studyId", "studyVersion", "targetId", "type"],
    );
  });

  it("refuse a header that is not one, and an unknown event", () => {
    expect(problems(mapEventRow({ ...event, ordinal: 1 }))).toEqual(["event_type", "op"]);
    expect(problems(mapEventRow({ ...event, event_type: "value_verified" }))).toEqual(["event_type"]);
    expect(problems(mapEventRow({ ...event, op: "confirm_all" }))).toEqual(["op"]);
  });
});
