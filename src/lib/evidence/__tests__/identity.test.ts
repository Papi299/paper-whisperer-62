// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  ADD_LINK_UNAVAILABLE_EXPLANATION,
  checkLinkAction,
  IDENTITY_CAVEAT,
  LAST_LINK_EXPLANATION,
  LINK_STATUS_LABELS,
  LINK_TRANSITIONS,
  papersHeldByStudies,
  reportsOfStudy,
  studiesOfPaper,
} from "../identity";
import { toLinkId, toPaperId, toStudyId, type PaperId, type StudyId } from "../ids";
import { LINK_ACTIONS, LINK_STATUSES, type StudyReportLink } from "../types";

/** Studies, reports and links (Requirements-001 §G; PR-A2 evidence_set_link). */

const S1 = toStudyId("51000000-0000-4000-8000-000000000001") as StudyId;
const S2 = toStudyId("52000000-0000-4000-8000-000000000002") as StudyId;
const P1 = toPaperId("a1000000-0000-4000-8000-000000000001") as PaperId;
const P2 = toPaperId("a2000000-0000-4000-8000-000000000002") as PaperId;
const P3 = toPaperId("a3000000-0000-4000-8000-000000000003") as PaperId;

const link = (studyId: StudyId, paperId: PaperId, status: StudyReportLink["status"] = "user_confirmed", n = 1): StudyReportLink => ({
  id: toLinkId(`1${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`)!,
  studyId,
  paperId,
  status,
  basis: "created_from_paper",
});

describe("link transitions — operations on an existing link only", () => {
  it("confirms, marks provisional, or removes; a repeat is unchanged", () => {
    expect(LINK_TRANSITIONS).toEqual({
      provisional: { confirm: "user_confirmed", mark_provisional: "unchanged", remove: "removed" },
      user_confirmed: { confirm: "unchanged", mark_provisional: "provisional", remove: "removed" },
    });
    expect(Object.keys(LINK_TRANSITIONS)).toEqual([...LINK_STATUSES]);
    expect(Object.keys(LINK_TRANSITIONS.provisional)).toEqual([...LINK_ACTIONS]);
    expect(LINK_ACTIONS).not.toContain("add");
    expect(ADD_LINK_UNAVAILABLE_EXPLANATION).toContain("isn't available yet");
  });

  it("predicts what the server will answer", () => {
    const links = [link(S1, P1, "provisional", 1), link(S1, P2, "user_confirmed", 2)];
    expect(checkLinkAction(links, P1, "confirm", new Set())).toEqual({ kind: "allowed", expected: "applied", resultingStatus: "user_confirmed" });
    expect(checkLinkAction(links, P1, "mark_provisional", new Set())).toEqual({ kind: "allowed", expected: "unchanged", resultingStatus: "provisional" });
    expect(checkLinkAction(links, P2, "mark_provisional", new Set())).toEqual({ kind: "allowed", expected: "applied", resultingStatus: "provisional" });
    expect(checkLinkAction(links, P2, "remove", new Set())).toEqual({ kind: "allowed", expected: "applied", resultingStatus: null });
  });

  it("refuses removing the study's last link, and says to delete the study instead", () => {
    const result = checkLinkAction([link(S1, P1)], P1, "remove", new Set());
    expect(result).toEqual({ kind: "blocked", reason: "last_link", message: LAST_LINK_EXPLANATION });
    expect(LAST_LINK_EXPLANATION).toBe("A study must remain linked to at least one paper. To free its final linked paper, delete the study record.");
  });

  it("checks the last link before the references, as the RPC does", () => {
    expect(checkLinkAction([link(S1, P1)], P1, "remove", new Set([P1]))).toMatchObject({ reason: "last_link" });
    expect(checkLinkAction([link(S1, P1), link(S1, P2, "user_confirmed", 2)], P1, "remove", new Set([P1]))).toMatchObject({ reason: "link_in_use" });
  });

  it("answers an unknown link as not found", () => {
    expect(checkLinkAction([link(S1, P1)], P3, "confirm", new Set())).toMatchObject({ kind: "blocked", reason: "link_not_found" });
  });
});

describe("a study is not a paper", () => {
  const links = [link(S1, P1, "user_confirmed", 1), link(S2, P1, "provisional", 2), link(S1, P2, "user_confirmed", 3)];

  it("lets one paper report several studies, and one study several papers", () => {
    expect(studiesOfPaper(links, P1)).toEqual([S1, S2].sort());
    expect(reportsOfStudy(links, S1).map((l) => l.paperId)).toEqual([P1, P2]);
    expect(studiesOfPaper(links, P3)).toEqual([]);
  });

  it("names the papers a delete or merge would be refused for", () => {
    const held = papersHeldByStudies([P3, P1, P2, P1], links);
    expect([...held.keys()]).toEqual([P1, P2]);
    expect(held.get(P1)).toEqual([S1, S2].sort());
  });

  it("labels provisional links honestly and carries the identity caveat", () => {
    expect(LINK_STATUS_LABELS.provisional).toContain("you weren't sure this paper reports an original study");
    expect(IDENTITY_CAVEAT).toBe("Study identity is based on this paper only. Other papers in your library may report the same study.");
  });
});
