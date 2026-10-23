import { describe, expect, it } from "vitest";
import { fetchPaperStudies, fetchPaperStudyLinks, fetchPaperTitles } from "../paperLinks";
import { IN_LIST_CHUNK } from "../read";
import { fakeSupabase, missingTableError } from "./fakeSupabase";
import { OTHER_USER, PAPER_ID, SECOND_PAPER_ID, STUDY_ID, USER, uuid } from "./fixtures";

/**
 * Which studies the user's papers report (EVIDENCE-RECORDS-001C1): the summary
 * behind "Study records — None / 1 / 2" and the checks before a paper delete or
 * a duplicate merge. Owner-scoped, chunked and paged; a refusal is an error,
 * never "no study records".
 */

const link = (paperId: string, studyId: string, extra: Record<string, unknown> = {}) => ({
  user_id: USER,
  paper_id: paperId,
  study_id: studyId,
  link_status: "user_confirmed",
  ...extra,
});
const study = (id: string, label: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  user_id: USER,
  label,
  design_profile: "rct_parallel",
  created_at: createdAt,
  ...extra,
});

describe("fetchPaperStudies", () => {
  it("lists every study the paper reports, oldest first, with its link status", async () => {
    const second = uuid("5", 2);
    const { client, requests } = fakeSupabase({
      tables: {
        evidence_study_reports: [link(PAPER_ID, STUDY_ID), link(PAPER_ID, second, { link_status: "provisional" }), link(SECOND_PAPER_ID, uuid("5", 3))],
        evidence_studies: [study(second, "Doe 2024 (extension)", "2026-10-02T00:00:00Z"), study(STUDY_ID, "Doe 2024", "2026-10-01T00:00:00Z")],
      },
    });
    const studies = await fetchPaperStudies(client, USER, PAPER_ID);
    expect(studies.map((s) => [s.label, s.linkStatus])).toEqual([
      ["Doe 2024", "user_confirmed"],
      ["Doe 2024 (extension)", "provisional"],
    ]);
    for (const request of requests) expect(request.eq).toContainEqual(["user_id", USER]);
  });

  it("answers None only when the database says so", async () => {
    const { client, requests } = fakeSupabase({ tables: { evidence_study_reports: [], evidence_studies: [] } });
    expect(await fetchPaperStudies(client, USER, PAPER_ID)).toEqual([]);
    expect(requests.map((r) => r.table)).toEqual(["evidence_study_reports"]);
  });

  it("answers None where study records are not installed", async () => {
    const { client } = fakeSupabase({
      tables: {},
      failures: { evidence_study_reports: { error: missingTableError("evidence_study_reports"), status: 404 } },
    });
    expect(await fetchPaperStudies(client, USER, PAPER_ID)).toEqual([]);
  });

  it("is an error — not None — when the read is refused or fails", async () => {
    const refused = fakeSupabase({ tables: {}, failures: { evidence_study_reports: { error: { code: "42501", message: "permission denied" }, status: 403 } } });
    await expect(fetchPaperStudies(refused.client, USER, PAPER_ID)).rejects.toMatchObject({ kind: "transport" });
    const offline = fakeSupabase({ tables: {}, failures: { evidence_study_reports: "throw" } });
    await expect(fetchPaperStudies(offline.client, USER, PAPER_ID)).rejects.toMatchObject({ kind: "transport", transient: true });
  });

  it("refuses an answer that is not the user's own", async () => {
    const { client } = fakeSupabase({
      tables: { evidence_study_reports: [link(PAPER_ID, STUDY_ID)], evidence_studies: [study(STUDY_ID, "Doe", "2026-10-01T00:00:00Z", { user_id: OTHER_USER })] },
    });
    // The fake filters by user like RLS would, so the foreign row is simply not returned…
    expect(await fetchPaperStudies(client, USER, PAPER_ID)).toEqual([]);
    // …and a row that does come back for another user is an integrity failure.
    const leaky = fakeSupabase({ tables: { evidence_study_reports: [link(PAPER_ID, STUDY_ID, { user_id: OTHER_USER })] } });
    const leakyClient = {
      from: (table: string) => {
        const chain = (leaky.client.from as unknown as (name: string) => { eq: (c: string, v: unknown) => unknown })(table);
        const original = chain.eq.bind(chain);
        chain.eq = (column: string, value: unknown) => (column === "user_id" ? chain : original(column, value));
        return chain;
      },
    } as unknown as typeof leaky.client;
    await expect(fetchPaperStudies(leakyClient, USER, PAPER_ID)).rejects.toMatchObject({ kind: "integrity" });
  });
});

describe("fetchPaperStudyLinks", () => {
  it("examines every id: chunked, deduplicated, case-insensitive", async () => {
    const ids = Array.from({ length: IN_LIST_CHUNK * 2 + 5 }, (_, i) => uuid("a", i + 1));
    const held = ids[150];
    const { client, requests } = fakeSupabase({ tables: { evidence_study_reports: [link(held, STUDY_ID), link(held, uuid("5", 2))] } });
    const { studiesByPaper } = await fetchPaperStudyLinks(client, USER, [...ids, ids[0].toUpperCase(), held]);
    expect([...studiesByPaper.keys()]).toEqual([held]);
    expect(studiesByPaper.get(held as never)).toHaveLength(2);
    const asked = requests.flatMap((r) => r.in.flatMap(([, values]) => values));
    expect(new Set(asked).size).toBe(ids.length);
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request.eq).toContainEqual(["user_id", USER]);
  });

  it("does not ask about ids that cannot be papers", async () => {
    const { client, requests } = fakeSupabase({ tables: { evidence_study_reports: [] } });
    const { studiesByPaper } = await fetchPaperStudyLinks(client, USER, ["paper-1", "", "not-a-uuid"]);
    expect(studiesByPaper.size).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("reads every page of a large answer", async () => {
    const paper = uuid("a", 1);
    const rows = Array.from({ length: 1500 }, (_, i) => link(paper, uuid("5", i + 1)));
    const { client, requests } = fakeSupabase({ tables: { evidence_study_reports: rows } });
    const { studiesByPaper } = await fetchPaperStudyLinks(client, USER, [paper]);
    expect(studiesByPaper.get(paper as never)).toHaveLength(1500);
    expect(requests.map((r) => r.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("answers 'not held' where study records are not installed, and fails on anything else", async () => {
    const missing = fakeSupabase({ tables: {}, failures: { evidence_study_reports: { error: missingTableError("evidence_study_reports"), status: 404 } } });
    expect((await fetchPaperStudyLinks(missing.client, USER, [PAPER_ID])).studiesByPaper.size).toBe(0);
    const refused = fakeSupabase({ tables: {}, failures: { evidence_study_reports: { error: { code: "42501", message: "permission denied" }, status: 403 } } });
    await expect(fetchPaperStudyLinks(refused.client, USER, [PAPER_ID])).rejects.toBeTruthy();
  });
});

describe("fetchPaperTitles", () => {
  it("names the user's papers by id", async () => {
    const { client } = fakeSupabase({ tables: { papers: [{ id: PAPER_ID, user_id: USER, title: "A paper" }] } });
    expect(await fetchPaperTitles(client, USER, [PAPER_ID, PAPER_ID])).toEqual(new Map([[PAPER_ID, "A paper"]]));
  });
});
