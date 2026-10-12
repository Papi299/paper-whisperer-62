/**
 * Recognising "the study-records schema is not installed here".
 *
 * EVIDENCE-RECORDS-001A1 adds eight tables in a migration that reaches
 * Production separately from the code that reads them. In between — and on any
 * Vercel Preview built from a branch whose migration Production has not yet
 * received — the full account export will ask a database that has never heard
 * of `evidence_studies` for its contents. That must not break the export: a
 * user asking for all of their data during a rollout should get all of it.
 *
 * Deliberately narrow, exactly like `authorIdentityAvailability.ts`: only the
 * "this object does not exist" family, naming one of the objects below, counts.
 * Permission errors, RLS refusals, network failures and malformed requests are
 * real errors and must surface. The shared matching lives in
 * `missingDatabaseObject.ts`; what is specific to study records is this list.
 * The RPCs of later PRs will be added here when they exist.
 */

import { isMissingDatabaseObjectError } from "./missingDatabaseObject";

/** Every EVIDENCE-RECORDS-001A1 object name, so a missing-object error elsewhere is not misread. */
const EVIDENCE_RECORDS_OBJECT_NAMES = [
  "evidence_studies",
  "evidence_study_reports",
  "evidence_source_snapshots",
  "evidence_arms",
  "evidence_outcomes",
  "evidence_field_values",
  "evidence_field_anchors",
  "evidence_events",
] as const;

/**
 * Whether this error means the study-records schema is absent from this
 * environment. Requires BOTH a missing-object code AND a mention of one of the
 * objects above, so a missing UNRELATED table is never reported as "study
 * records not installed".
 */
export function isEvidenceRecordsSchemaMissing(error: unknown): boolean {
  return isMissingDatabaseObjectError(error, EVIDENCE_RECORDS_OBJECT_NAMES);
}
