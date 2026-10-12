/**
 * Recognising "a study-records table is not installed here".
 *
 * EVIDENCE-RECORDS-001A1 adds eight tables in a migration that reaches
 * Production separately from the code that reads them. In between — and on any
 * Vercel Preview built from a branch whose migration Production has not yet
 * received — the full account export will ask a database that has never heard
 * of `evidence_studies` for its contents. That must not break the export: a
 * user asking for all of their data during a rollout should get all of it.
 *
 * Deliberately narrow, exactly like `authorIdentityAvailability.ts`: only the
 * "this object does not exist" family counts. Permission errors, RLS refusals,
 * network failures and malformed requests are real errors and must surface. The
 * shared matching lives in `missingDatabaseObject.ts`; what is specific to study
 * records is the table list below.
 *
 * One error is evidence about ONE table. Whether the schema as a whole is
 * absent is decided by the caller from every table's read together — see
 * `fetchEvidenceExportTables`. The RPCs of later PRs will be added here when
 * they exist.
 */

import { isMissingDatabaseObjectError } from "./missingDatabaseObject";

/** The eight EVIDENCE-RECORDS-001A1 tables. One migration creates all of them, in one transaction. */
export const EVIDENCE_RECORDS_TABLES = [
  "evidence_studies",
  "evidence_study_reports",
  "evidence_source_snapshots",
  "evidence_arms",
  "evidence_outcomes",
  "evidence_field_values",
  "evidence_field_anchors",
  "evidence_events",
] as const;

export type EvidenceRecordsTable = (typeof EVIDENCE_RECORDS_TABLES)[number];

/**
 * Whether this error, from a read of `table`, says that `table` itself is
 * absent from this environment. Requires BOTH a missing-object code AND that
 * table's own name, so neither a missing UNRELATED table nor a missing SIBLING
 * study-records table is ever read as this one being absent.
 */
export function isEvidenceRecordsTableMissing(error: unknown, table: EvidenceRecordsTable): boolean {
  return isMissingDatabaseObjectError(error, [table]);
}
