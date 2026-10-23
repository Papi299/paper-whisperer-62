/**
 * Paper deletion and duplicate merge, when a study record holds the paper
 * (EVIDENCE-RECORDS-001C1; Requirements-001 §E10, §G5; FK-PROOF-001 §F).
 *
 * The database is the protection: `evidence_study_reports_paper_fkey` is ON
 * DELETE NO ACTION, so `delete_papers_with_attachment_cleanup` and
 * `merge_exact_duplicates` fail with `23503` — in one transaction, leaving
 * every attachment, Project/Tag assignment and cleanup-queue row as it was —
 * whenever they would remove a paper a study links to. These helpers decide
 * what the UI says and offers BEFORE that: a check that is advisory (a link
 * made in another tab after it is still refused by the key), and the
 * explanation of the key's refusal when it happens anyway.
 *
 * Nothing here deletes or changes a study record to make a paper deletable,
 * and nothing merges studies: a study is never moved to another paper
 * automatically.
 */

import { classifyEvidenceForeignKeyError } from "@/lib/evidence/errors";
import { PAPER_HELD_BY_STUDY_EXPLANATION } from "@/lib/evidence/identity";
import type { DuplicateGroup } from "@/types/database";

/**
 * Whether `error` is the database refusing to remove a paper a study links
 * to. Only `23503` on `evidence_study_reports_paper_fkey` qualifies; every
 * other error — including every other foreign-key violation — is left to the
 * caller's existing handling.
 */
export function isPaperHeldByStudyError(error: unknown, status: number | null = null): boolean {
  return classifyEvidenceForeignKeyError(error, status)?.kind === "paper_has_study_record";
}

export const STUDY_RECORD_DELETE_COPY = {
  singleTitle: "This paper has a study record",
  single: (title: string) =>
    `‘${title}’ has a study record. Delete the study record first (open it, then choose Delete study record), then delete the paper.`,
  bulkTitle: "Some selected papers have study records",
  bulk: (blocked: number, selected: number) =>
    `${blocked} of the ${selected} selected ${selected === 1 ? "paper has a study record" : "papers have study records"}. Deselect ${blocked === 1 ? "it" : "them"} or delete ${blocked === 1 ? "its study record" : "their study records"} first.`,
  checking: "Checking for study records…",
  checkFailed: "Couldn't check whether these papers have study records, so nothing can be deleted yet. Try again.",
  checkFailedSingle: "Couldn't check whether this paper has a study record, so it can't be deleted yet. Try again.",
  /** The database refused (a link made after the check). */
  refusedSingle: PAPER_HELD_BY_STUDY_EXPLANATION,
  refusedBulk: "A selected paper has a study record, so nothing was deleted. Delete its study record first, or deselect it.",
} as const;

export const STUDY_RECORD_MERGE_COPY = {
  notice: "Merging never moves or combines study records. A paper with a study record has to be the one you keep.",
  discardHeld: (title: string) => `‘${title}’ has a study record. Keep that paper in this group, or delete its study record first.`,
  severalHeld: (count: number) =>
    `${count} papers in this group have study records, so this group can't be merged. Study records are never merged automatically.`,
  checking: "Checking for study records…",
  checkFailed: "Couldn't check these papers for study records, so nothing can be merged yet. Try again.",
  refused: "A paper in this group has a study record, so the group wasn't merged.",
} as const;

/** Why a duplicate group cannot be merged as chosen, or null when it can. */
export type MergeBlock =
  | { readonly kind: "discard_held"; readonly paperIds: readonly string[] }
  | { readonly kind: "several_held"; readonly paperIds: readonly string[] };

/** The papers of `group` a study links to, in the group's order. */
export function heldPapers(group: Pick<DuplicateGroup, "papers">, linked: ReadonlySet<string>): string[] {
  return group.papers.map((paper) => paper.id).filter((id) => linked.has(id.toLowerCase()));
}

/**
 * Whether merging `group` into `keepId` would remove a paper a study links
 * to. Two or more linked papers can never be merged in this version — one of
 * them would have to go — and one linked paper can only be the keeper.
 */
export function mergeBlock(group: Pick<DuplicateGroup, "papers">, keepId: string, linked: ReadonlySet<string>): MergeBlock | null {
  const held = heldPapers(group, linked);
  if (held.length >= 2) return { kind: "several_held", paperIds: held };
  if (held.length === 1 && held[0] !== keepId) return { kind: "discard_held", paperIds: held };
  return null;
}

/**
 * The keeper to suggest: the one paper a study links to, when there is
 * exactly one — so the suggested merge never removes it — and otherwise the
 * existing completeness-based suggestion.
 */
export function suggestKeeper(group: Pick<DuplicateGroup, "papers">, linked: ReadonlySet<string>, fallback: string): string {
  const held = heldPapers(group, linked);
  return held.length === 1 ? held[0] : fallback;
}
