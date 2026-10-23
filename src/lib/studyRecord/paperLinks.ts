/**
 * Which studies the user's papers report (EVIDENCE-RECORDS-001C1).
 *
 * Two reads over `evidence_study_reports` — the user's own "this paper reports
 * this study" links — under the owner-only RLS policy plus an explicit
 * `.eq("user_id", …)`:
 *
 *   * `fetchPaperStudies` — the studies of ONE paper, with their labels, for
 *     the Study Record entry points and the study picker. Run on demand, when a
 *     row's details are expanded or Edit Paper is open, never for a whole page.
 *   * `fetchPaperStudyLinks` — which of MANY papers have a study, batched in
 *     chunks, for the checks that run before a paper is deleted or a duplicate
 *     group is merged (Requirements-001 §E10).
 *
 * A study is never inferred from the paper: these are only the links the user
 * created. One paper can report several studies, so a paper's answer is a
 * list, never "the" study of the paper.
 *
 * The one thing tolerated is the evidence schema not existing in this
 * environment: then no paper can have a study, which is the truthful answer.
 * Any other failure — a permission or RLS refusal, a network failure, a
 * malformed answer — is thrown, never read as "no study records".
 *
 * The checks before a delete or a merge are advisory. A link created in
 * another tab after the check is still refused by the database (the NO ACTION
 * key `evidence_study_reports_paper_fkey`), and that refusal is explained by
 * `classifyEvidenceForeignKeyError`.
 */

import { isDesignProfile, type DesignProfile } from "@/lib/evidence/fieldDictionary";
import { isCanonicalUuid, toPaperId, toStudyId, type PaperId, type StudyId } from "@/lib/evidence/ids";
import { isLinkStatus, type LinkStatus } from "@/lib/evidence/types";
import { chunk, readAllPages, StudyRecordReadError, type StudyRecordClient } from "./read";

export interface PaperStudySummary {
  readonly studyId: StudyId;
  readonly label: string;
  readonly designProfile: DesignProfile;
  readonly linkStatus: LinkStatus;
  readonly createdAt: string;
}

interface LinkRow {
  readonly user_id: string;
  readonly paper_id: string;
  readonly study_id: string;
  readonly link_status: string;
}

interface StudySummaryRow {
  readonly id: string;
  readonly user_id: string;
  readonly label: string;
  readonly design_profile: string;
  readonly created_at: string;
}

const integrity = () => new StudyRecordReadError("integrity", false);

function isMissingSchema(error: unknown): boolean {
  return error instanceof StudyRecordReadError && error.kind === "missing_schema";
}

/**
 * The studies `paperId` reports, oldest first. An empty list means none — the
 * answer the database gave, never a failure in disguise.
 */
export async function fetchPaperStudies(
  client: StudyRecordClient,
  userId: string,
  paperId: string,
  signal?: AbortSignal,
): Promise<readonly PaperStudySummary[]> {
  let links: LinkRow[];
  try {
    links = await readAllPages<LinkRow>((from, to) => {
      const query = client
        .from("evidence_study_reports")
        .select("user_id, paper_id, study_id, link_status")
        .eq("user_id", userId)
        .eq("paper_id", paperId)
        .order("study_id", { ascending: true })
        .range(from, to);
      return signal ? query.abortSignal(signal) : query;
    }, "evidence_study_reports");
  } catch (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  const statusByStudy = new Map<string, LinkStatus>();
  for (const row of links) {
    if (row.user_id !== userId || row.paper_id !== paperId || !toStudyId(row.study_id) || !isLinkStatus(row.link_status)) throw integrity();
    if (statusByStudy.has(row.study_id)) throw integrity();
    statusByStudy.set(row.study_id, row.link_status);
  }
  if (statusByStudy.size === 0) return [];

  const studies = (
    await Promise.all(
      chunk([...statusByStudy.keys()]).map((ids) =>
        readAllPages<StudySummaryRow>((from, to) => {
          const query = client
            .from("evidence_studies")
            .select("id, user_id, label, design_profile, created_at")
            .eq("user_id", userId)
            .in("id", ids)
            .order("id", { ascending: true })
            .range(from, to);
          return signal ? query.abortSignal(signal) : query;
        }, "evidence_studies"),
      ),
    )
  ).flat();

  const summaries: PaperStudySummary[] = [];
  for (const row of studies) {
    const studyId = toStudyId(row.id);
    const linkStatus = statusByStudy.get(row.id);
    if (!studyId || row.user_id !== userId || !linkStatus || typeof row.label !== "string" || !isDesignProfile(row.design_profile)) {
      throw integrity();
    }
    summaries.push(Object.freeze({ studyId, label: row.label, designProfile: row.design_profile, linkStatus, createdAt: row.created_at }));
  }
  // A study deleted between the two reads simply drops out: its links went with it.
  summaries.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.studyId < b.studyId ? -1 : 1));
  return Object.freeze(summaries);
}

export interface PaperStudyLinks {
  /** Each requested paper that a study links to, with its studies. */
  readonly studiesByPaper: ReadonlyMap<PaperId, readonly StudyId[]>;
}

/**
 * Which of `paperIds` a study links to — the papers a delete or a duplicate
 * merge would be refused for. Every requested id is examined: the ids are read
 * in chunks, and each chunk in pages, so a large selection is never truncated.
 */
export async function fetchPaperStudyLinks(
  client: StudyRecordClient,
  userId: string,
  paperIds: readonly string[],
  signal?: AbortSignal,
): Promise<PaperStudyLinks> {
  // Only a UUID can be a paper's id, so only a UUID can be linked: anything
  // else is answered "not linked" without asking the database (which would
  // refuse the whole request for one malformed id).
  const wanted = [...new Set(paperIds.flatMap((id) => (isCanonicalUuid(id) ? [id.toLowerCase()] : [])))].sort();
  const studiesByPaper = new Map<PaperId, StudyId[]>();
  if (wanted.length === 0) return { studiesByPaper };
  let rows: LinkRow[];
  try {
    rows = (
      await Promise.all(
        chunk(wanted).map((ids) =>
          readAllPages<LinkRow>((from, to) => {
            const query = client
              .from("evidence_study_reports")
              .select("user_id, paper_id, study_id, link_status")
              .eq("user_id", userId)
              .in("paper_id", ids)
              .order("paper_id", { ascending: true })
              .order("study_id", { ascending: true })
              .range(from, to);
            return signal ? query.abortSignal(signal) : query;
          }, "evidence_study_reports"),
        ),
      )
    ).flat();
  } catch (error) {
    if (isMissingSchema(error)) return { studiesByPaper };
    throw error;
  }
  const requested = new Set(wanted);
  for (const row of rows) {
    const paperId = toPaperId(row.paper_id);
    const studyId = toStudyId(row.study_id);
    if (!paperId || !studyId || row.user_id !== userId || !requested.has(paperId)) throw integrity();
    const list = studiesByPaper.get(paperId) ?? [];
    list.push(studyId);
    studiesByPaper.set(paperId, list);
  }
  return { studiesByPaper };
}

/** Titles of the user's papers, by id, for naming the papers a check blocked. */
export async function fetchPaperTitles(
  client: StudyRecordClient,
  userId: string,
  paperIds: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const titles = new Map<string, string>();
  const ids = [...new Set(paperIds)];
  const rows = (
    await Promise.all(
      chunk(ids).map((part) =>
        readAllPages<{ id: string; user_id: string; title: string }>((from, to) => {
          const query = client
            .from("papers")
            .select("id, user_id, title")
            .eq("user_id", userId)
            .in("id", part)
            .order("id", { ascending: true })
            .range(from, to);
          return signal ? query.abortSignal(signal) : query;
        }),
      ),
    )
  ).flat();
  for (const row of rows) {
    if (row.user_id !== userId || typeof row.title !== "string") throw integrity();
    titles.set(row.id, row.title);
  }
  return titles;
}
