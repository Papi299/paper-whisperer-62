import { describe, it, expect } from "vitest";
import { isEvidenceRecordsSchemaMissing } from "../evidenceRecordsAvailability";

/**
 * The compatibility detector for EVIDENCE-RECORDS-001A1.
 *
 * Too narrow, and a full account export made while Production predates the
 * migration fails with an error the user can do nothing about. Too broad, and a
 * genuine permission failure or a missing UNRELATED table is silently turned
 * into "you have no study records" — an archive that omits data the user has.
 * The second is the worse failure, so most of these tests are about what must
 * NOT be swallowed.
 */

function pgError(code: string, message: string, extra: Record<string, string> = {}) {
  return { code, message, details: null, hint: null, ...extra };
}

describe("isEvidenceRecordsSchemaMissing — the expected condition", () => {
  it.each([
    ["PGRST205", "Could not find the table 'public.evidence_studies' in the schema cache"],
    ["PGRST205", "Could not find the table 'public.evidence_field_anchors' in the schema cache"],
    ["42P01", 'relation "public.evidence_events" does not exist'],
    ["42P01", 'relation "public.evidence_source_snapshots" does not exist'],
  ])("recognises %s naming a study-records table", (code, message) => {
    expect(isEvidenceRecordsSchemaMissing(pgError(code, message))).toBe(true);
  });

  it("finds the table name in details, not only in message", () => {
    expect(
      isEvidenceRecordsSchemaMissing(
        pgError("PGRST205", "Could not find the table in the schema cache", {
          details: "Perhaps you meant public.evidence_study_reports",
        }),
      ),
    ).toBe(true);
  });
});

describe("isEvidenceRecordsSchemaMissing — what must never be swallowed", () => {
  it("rejects a permission error on a study-records table", () => {
    expect(
      isEvidenceRecordsSchemaMissing(pgError("42501", "permission denied for table evidence_studies")),
    ).toBe(false);
  });

  it("rejects a foreign-key refusal naming a study-records constraint", () => {
    // A refused paper deletion is a real, user-visible condition, not a
    // missing schema.
    expect(
      isEvidenceRecordsSchemaMissing(
        pgError(
          "23503",
          'update or delete on table "papers" violates foreign key constraint "evidence_study_reports_paper_fkey" on table "evidence_study_reports"',
        ),
      ),
    ).toBe(false);
  });

  it("rejects a missing-table error naming an unrelated relation", () => {
    expect(isEvidenceRecordsSchemaMissing(pgError("42P01", 'relation "public.papers" does not exist'))).toBe(false);
  });

  it("rejects a missing-object code carrying no object name", () => {
    expect(isEvidenceRecordsSchemaMissing(pgError("PGRST205", "Could not find the table in the schema cache"))).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "evidence_studies does not exist"],
    ["a plain Error", new Error('relation "public.evidence_studies" does not exist')],
    ["a network-shaped failure", { message: "Failed to fetch" }],
  ])("rejects %s, which carries no usable code", (_label, value) => {
    expect(isEvidenceRecordsSchemaMissing(value)).toBe(false);
  });
});
