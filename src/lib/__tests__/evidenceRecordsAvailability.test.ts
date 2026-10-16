import { describe, it, expect } from "vitest";
import { EVIDENCE_RECORDS_TABLES, isEvidenceRecordsTableMissing } from "../evidenceRecordsAvailability";

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

describe("EVIDENCE_RECORDS_TABLES", () => {
  it("lists the eight tables the migration creates, each once", () => {
    expect([...EVIDENCE_RECORDS_TABLES]).toEqual([
      "evidence_studies",
      "evidence_study_reports",
      "evidence_source_snapshots",
      "evidence_arms",
      "evidence_outcomes",
      "evidence_field_values",
      "evidence_field_anchors",
      "evidence_events",
    ]);
  });

  it("holds no name inside another, so a per-table text match cannot cross tables", () => {
    for (const name of EVIDENCE_RECORDS_TABLES) {
      for (const other of EVIDENCE_RECORDS_TABLES) {
        if (other !== name) expect(other.includes(name), `${other} contains ${name}`).toBe(false);
      }
    }
  });
});

describe("isEvidenceRecordsTableMissing — the expected condition", () => {
  it.each(EVIDENCE_RECORDS_TABLES)("recognises PostgREST's PGRST205 for %s itself", (table) => {
    const error = pgError("PGRST205", `Could not find the table 'public.${table}' in the schema cache`);
    expect(isEvidenceRecordsTableMissing(error, table)).toBe(true);
  });

  it.each(EVIDENCE_RECORDS_TABLES)("recognises Postgres's 42P01 for %s itself", (table) => {
    expect(isEvidenceRecordsTableMissing(pgError("42P01", `relation "public.${table}" does not exist`), table)).toBe(true);
  });

  it("matches the table name case-insensitively", () => {
    expect(
      isEvidenceRecordsTableMissing(pgError("42P01", 'relation "PUBLIC.EVIDENCE_STUDIES" does not exist'), "evidence_studies"),
    ).toBe(true);
  });

  it("finds the table name in details, not only in message", () => {
    expect(
      isEvidenceRecordsTableMissing(
        pgError("PGRST205", "Could not find the table in the schema cache", {
          details: "Perhaps you meant public.evidence_study_reports",
        }),
        "evidence_study_reports",
      ),
    ).toBe(true);
  });
});

describe("isEvidenceRecordsTableMissing — what must never be swallowed", () => {
  it("rejects a permission error on the table itself", () => {
    expect(
      isEvidenceRecordsTableMissing(pgError("42501", "permission denied for table evidence_studies"), "evidence_studies"),
    ).toBe(false);
  });

  it("rejects a foreign-key refusal naming the table", () => {
    // A refused paper deletion is a real, user-visible condition, not a
    // missing schema.
    expect(
      isEvidenceRecordsTableMissing(
        pgError(
          "23503",
          'update or delete on table "papers" violates foreign key constraint "evidence_study_reports_paper_fkey" on table "evidence_study_reports"',
        ),
        "evidence_study_reports",
      ),
    ).toBe(false);
  });

  it("rejects a missing-table error naming an unrelated relation", () => {
    expect(isEvidenceRecordsTableMissing(pgError("42P01", 'relation "public.papers" does not exist'), "evidence_studies")).toBe(false);
  });

  it.each(EVIDENCE_RECORDS_TABLES)("rejects a missing-table error naming a sibling of %s, never that table", (table) => {
    // One table's absence is no evidence about another's: the export judges each
    // read only by what it says about its own table.
    const sibling = EVIDENCE_RECORDS_TABLES.find((name) => name !== table)!;
    const error = pgError("PGRST205", `Could not find the table 'public.${sibling}' in the schema cache`);
    expect(isEvidenceRecordsTableMissing(error, table)).toBe(false);
    expect(isEvidenceRecordsTableMissing(error, sibling)).toBe(true);
  });

  it("rejects a missing-object code carrying no object name", () => {
    expect(isEvidenceRecordsTableMissing(pgError("PGRST205", "Could not find the table in the schema cache"), "evidence_studies")).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "evidence_studies does not exist"],
    ["a plain Error", new Error('relation "public.evidence_studies" does not exist')],
    ["a network-shaped failure", { message: "Failed to fetch" }],
  ])("rejects %s, which carries no usable code", (_label, value) => {
    expect(isEvidenceRecordsTableMissing(value, "evidence_studies")).toBe(false);
  });
});
