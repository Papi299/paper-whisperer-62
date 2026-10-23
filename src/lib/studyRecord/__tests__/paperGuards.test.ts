import { describe, expect, it } from "vitest";
import type { DuplicateGroup, DuplicatePaperInfo } from "@/types/database";
import { heldPapers, isPaperHeldByStudyError, mergeBlock, STUDY_RECORD_DELETE_COPY, suggestKeeper } from "../paperGuards";

/**
 * Paper deletion and duplicate merge when a study record holds a paper
 * (EVIDENCE-RECORDS-001C1; FK-PROOF-001 §F). Only `23503` on
 * `evidence_study_reports_paper_fkey` is a study-record refusal.
 */

const message = (constraint: string) =>
  `update or delete on table "papers" violates foreign key constraint "${constraint}" on table "evidence_study_reports"`;

describe("isPaperHeldByStudyError", () => {
  it("recognizes the study-report key's 23503", () => {
    expect(isPaperHeldByStudyError({ code: "23503", message: message("evidence_study_reports_paper_fkey") })).toBe(true);
    expect(isPaperHeldByStudyError({ code: "23503", message: message("evidence_study_reports_paper_fkey") }, 409)).toBe(true);
  });

  it.each([
    ["another table's key", { code: "23503", message: message("paper_tags_paper_id_fkey") }],
    ["the anchor-link key (an unlink, not a paper delete)", { code: "23503", message: message("evidence_field_anchors_link_fkey") }],
    ["the anchor-snapshot key", { code: "23503", message: message("evidence_field_anchors_snapshot_fkey") }],
    ["another SQLSTATE naming the key", { code: "P0001", message: message("evidence_study_reports_paper_fkey") }],
    ["a 23503 without a constraint name", { code: "23503", message: "foreign key violation" }],
    ["a constraint name only in details", { code: "23503", message: "x", details: 'constraint "evidence_study_reports_paper_fkey"' }],
    ["a name that merely contains the key", { code: "23503", message: message("evidence_study_reports_paper_fkey_old") }],
    ["no error", null],
    ["a string", "evidence_study_reports_paper_fkey"],
  ])("does not take %s for a study record", (_label, error) => {
    expect(isPaperHeldByStudyError(error)).toBe(false);
  });

  it("explains a refusal without ids, SQL or table names", () => {
    for (const text of [STUDY_RECORD_DELETE_COPY.refusedSingle, STUDY_RECORD_DELETE_COPY.refusedBulk]) {
      expect(text).toMatch(/study record/i);
      expect(text).not.toMatch(/evidence_|fkey|23503|[0-9a-f]{8}-/);
    }
  });
});

const info = (id: string): DuplicatePaperInfo => ({
  id,
  title: id,
  authors: [],
  year: null,
  journal: null,
  pmid: null,
  doi: "10.1/x",
  abstract: null,
  study_type: null,
  keywords: [],
  created_at: "2026-01-01T00:00:00Z",
});
const group = (...ids: [string, string, ...string[]]): Pick<DuplicateGroup, "papers"> => ({
  papers: ids.map(info) as DuplicateGroup["papers"],
});

describe("mergeBlock", () => {
  it("allows a group nobody holds, with any keeper", () => {
    expect(mergeBlock(group("A", "B"), "A", new Set())).toBeNull();
    expect(mergeBlock(group("A", "B"), "B", new Set())).toBeNull();
  });

  it("allows a held paper only as the keeper", () => {
    const linked = new Set(["b"]);
    expect(mergeBlock(group("A", "B"), "B", linked)).toBeNull();
    expect(mergeBlock(group("A", "B"), "A", linked)).toEqual({ kind: "discard_held", paperIds: ["B"] });
  });

  it("never merges a group in which several papers are held, whoever is kept", () => {
    const linked = new Set(["a", "c"]);
    for (const keep of ["A", "B", "C"]) {
      expect(mergeBlock(group("A", "B", "C"), keep, linked)).toEqual({ kind: "several_held", paperIds: ["A", "C"] });
    }
  });

  it("matches held ids case-insensitively and reports them in the group's order", () => {
    expect(heldPapers(group("C", "B", "A"), new Set(["a", "c"]))).toEqual(["C", "A"]);
  });
});

describe("suggestKeeper", () => {
  it("suggests the one held paper, else the fallback", () => {
    expect(suggestKeeper(group("A", "B"), new Set(["b"]), "A")).toBe("B");
    expect(suggestKeeper(group("A", "B"), new Set(), "A")).toBe("A");
    expect(suggestKeeper(group("A", "B"), new Set(["a", "b"]), "B")).toBe("B");
  });
});
