/**
 * Studies, the papers that report them, and the links between them
 * (EVIDENCE-RECORDS-001B; Requirements-001 §G; PR-A2 `evidence_set_link`).
 *
 * A study is the user's understanding of one study; a paper is one report. A
 * link is the user's assertion that this paper reports this study — never
 * inferred from titles, authors, PMIDs or DOIs, and never merged
 * automatically. One paper can report several studies; one study can be
 * reported in several papers, and the schema can hold that, but PR-A2 offers
 * no way to ADD a link: `evidence_set_link` only confirms, marks provisional
 * or removes an EXISTING one. A study keeps at least one link — removing its
 * last is refused, and deleting the study is the way to free its only paper
 * (Product Owner decision, PR-A2 merge).
 */

import type { PaperId, StudyId } from "./ids";
import type { LinkAction, LinkBasis, LinkStatus, StudyReportLink } from "./types";

export const LINK_STATUS_LABELS: Readonly<Record<LinkStatus, string>> = Object.freeze({
  provisional: "Provisional — you weren't sure this paper reports an original study",
  user_confirmed: "Confirmed by you",
});

export const LINK_BASIS_LABELS: Readonly<Record<LinkBasis, string>> = Object.freeze({
  created_from_paper: "Created from this paper",
  user_linked: "Linked by you",
});

export const LINK_ACTION_LABELS: Readonly<Record<LinkAction, string>> = Object.freeze({
  confirm: "Mark as confirmed",
  mark_provisional: "Mark as provisional",
  remove: "Remove this paper from the study record",
});

/** Carried by every record until linking ships (Requirements-001 §G3). */
export const IDENTITY_CAVEAT =
  "Study identity is based on this paper only. Other papers in your library may report the same study.";

export const LAST_LINK_EXPLANATION =
  "A study must remain linked to at least one paper. To free its final linked paper, delete the study record.";

export const LINK_IN_USE_EXPLANATION =
  "Sources in this study record still refer to this paper. Remove them first, or delete the study record.";

export const LINK_NOT_FOUND_EXPLANATION = "This paper is no longer linked to this study record.";

export const ADD_LINK_UNAVAILABLE_EXPLANATION = "Linking another paper to an existing study record isn't available yet.";

export const PAPER_HELD_BY_STUDY_EXPLANATION =
  "This paper has a study record. Delete the study record first, then delete or merge the paper.";

/** Where each action leads from each status: a status, "unchanged", or "removed". */
export const LINK_TRANSITIONS: Readonly<Record<LinkStatus, Readonly<Record<LinkAction, LinkStatus | "unchanged" | "removed">>>> =
  Object.freeze({
    provisional: Object.freeze({ confirm: "user_confirmed", mark_provisional: "unchanged", remove: "removed" }),
    user_confirmed: Object.freeze({ confirm: "unchanged", mark_provisional: "provisional", remove: "removed" }),
  });

export type LinkActionCheck =
  | {
      readonly kind: "allowed";
      /** What the server is expected to answer: `applied`, or `unchanged` for a no-op. */
      readonly expected: "applied" | "unchanged";
      /** The link's status afterwards; null once removed. */
      readonly resultingStatus: LinkStatus | null;
    }
  | { readonly kind: "blocked"; readonly reason: "link_not_found" | "last_link" | "link_in_use"; readonly message: string };

/**
 * Whether `action` on the study's link to `paperId` can succeed, checked in
 * the RPC's own order: the link must exist; a remove is refused for the last
 * link first, then while any source reference uses it. `links` are the study's
 * links; `referencedPaperIds` the papers its references name.
 */
export function checkLinkAction(
  links: readonly StudyReportLink[],
  paperId: PaperId,
  action: LinkAction,
  referencedPaperIds: ReadonlySet<string>,
): LinkActionCheck {
  const link = links.find((candidate) => candidate.paperId === paperId);
  if (!link) return { kind: "blocked", reason: "link_not_found", message: LINK_NOT_FOUND_EXPLANATION };
  const next = LINK_TRANSITIONS[link.status][action];
  if (next === "removed") {
    if (!links.some((candidate) => candidate.paperId !== paperId)) {
      return { kind: "blocked", reason: "last_link", message: LAST_LINK_EXPLANATION };
    }
    if (referencedPaperIds.has(paperId)) return { kind: "blocked", reason: "link_in_use", message: LINK_IN_USE_EXPLANATION };
    return { kind: "allowed", expected: "applied", resultingStatus: null };
  }
  if (next === "unchanged") return { kind: "allowed", expected: "unchanged", resultingStatus: link.status };
  return { kind: "allowed", expected: "applied", resultingStatus: next };
}

/** The reports (links) of one study. */
export function reportsOfStudy(links: readonly StudyReportLink[], studyId: StudyId): readonly StudyReportLink[] {
  return Object.freeze(links.filter((link) => link.studyId === studyId));
}

/** The studies one paper reports — possibly several, never "the" study of a paper. */
export function studiesOfPaper(links: readonly StudyReportLink[], paperId: PaperId): readonly StudyId[] {
  const studies = links.filter((link) => link.paperId === paperId).map((link) => link.studyId);
  return Object.freeze([...new Set(studies)].sort());
}

/**
 * Which of `paperIds` a study links to — the papers a delete or a duplicate
 * merge would be refused for (PR-A1 NO ACTION key; Requirements-001 §E10).
 * In the order given; papers no study links to are absent.
 */
export function papersHeldByStudies(
  paperIds: readonly PaperId[],
  links: readonly StudyReportLink[],
): ReadonlyMap<PaperId, readonly StudyId[]> {
  const held = new Map<PaperId, readonly StudyId[]>();
  for (const paperId of paperIds) {
    const studies = studiesOfPaper(links, paperId);
    if (studies.length > 0 && !held.has(paperId)) held.set(paperId, studies);
  }
  return held;
}
