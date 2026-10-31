import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { toPaperId, toSnapshotId, type PaperId } from "@/lib/evidence/ids";
import { assembleStudyRecord, type StudyRecordData } from "../read";
import { buildReviewItems } from "../reviewModel";
import { createDraft } from "../draft";
import {
  abstractSha256,
  canDigestAbstract,
  checkSourceUpdateCandidate,
  describeSourceUpdate,
  sourceUpdateEligibility,
  type SourceUpdateCandidate,
} from "../sourceUpdate";
import {
  ABSTRACT,
  fullRows,
  PAPER_ID,
  PAPER_TITLE,
  quoteAnchorRow,
  reportRow,
  SECOND_PAPER_ID,
  snapshotRow,
  SNAPSHOT_ID,
  STUDY_ID,
  studyRow,
  THIN_SPACE,
  USER,
  uuid,
  valueRow,
  type FixtureRows,
} from "./fixtures";

/**
 * "Use current abstract" before anything is sent (EVIDENCE-RECORDS-001C2C-B):
 * which library abstracts may become a copy, whether a frozen candidate still
 * describes the record, what the change does to reviews — the server's rule,
 * from the record, never a quote-match forecast — and the exact SHA-256 the
 * server compares.
 */

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

const OLD_COPY = uuid("c", 7);
const OLD_ABSTRACT = "Background: An earlier version of this abstract. Adults with type 2 diabetes were randomized to metformin.";
const REVISED = ABSTRACT.replace("120 participants", "118 participants");
const NBSP = String.fromCodePoint(0x00a0);
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
const ASTRAL = String.fromCodePoint(0x1d6fc); // one code point, two UTF-16 units
// Every other non-ASCII character of a vector is built from its code point, so the file shows what it holds.
const cp = (code: number) => String.fromCodePoint(code);

/** Assemble rows as the read does: every copy's metadata, and the text of each link's newest copy only. */
function record(rows: FixtureRows): StudyRecordData {
  const info = rows.snapshots.map(({ exact_text: _t, exact_sha256: _e, normalized_sha256: _n, ...rest }) => rest);
  const newest = new Map<string, Row<"evidence_source_snapshots">>();
  for (const snapshot of rows.snapshots) {
    const current = newest.get(snapshot.paper_id);
    if (!current || snapshot.seq > current.seq) newest.set(snapshot.paper_id, snapshot);
  }
  const papers = [...new Set(rows.reports.map((report) => report.paper_id))].map((id) => ({ id, user_id: USER, title: id === PAPER_ID ? PAPER_TITLE : "Second report" }));
  return assembleStudyRecord(USER, STUDY_ID, { ...rows, snapshots: info }, [...newest.values()], papers);
}

const linkOf = (data: StudyRecordData, paperId: string = PAPER_ID) => data.links.find((link) => link.link.paperId === paperId)!;
const paper = toPaperId(PAPER_ID) as PaperId;

/** The C1 record with no copy at all: its paper had no abstract when the record was created. */
function noCopyRows(): FixtureRows {
  const rows = fullRows();
  rows.snapshots = [];
  rows.anchors = [];
  return rows;
}

describe("which library abstracts may become a saved copy", () => {
  const link = linkOf(record(fullRows()));
  const empty = linkOf(record(noCopyRows()));

  it.each([
    ["a change of content", REVISED, "content_change"],
    ["a typography-only difference — offered, though keeping the copy is the default", ABSTRACT.split(THIN_SPACE).join(" "), "typography_only_change"],
  ])("offers %s", (_label, library, state) => {
    expect(sourceUpdateEligibility(link, library)).toEqual({ kind: "eligible", state });
  });

  it("offers a first copy when the record has none and the library has an abstract", () => {
    expect(sourceUpdateEligibility(empty, "A newly added abstract of a synthetic trial.")).toEqual({ kind: "eligible", state: "abstract_now_available" });
  });

  it.each([
    ["the saved copy itself, character for character", ABSTRACT, "current"],
    ["a removed abstract", null, "abstract_removed"],
    ["an empty abstract", "", "abstract_removed"],
    ["an abstract empty after normalization v1", `  ${SOFT_HYPHEN}\n${NBSP}`, "abstract_removed"],
    ["text no database value can hold", `Lone ${String.fromCharCode(0xd800)} surrogate`, "malformed"],
  ])("never offers %s", (_label, library, reason) => {
    expect(sourceUpdateEligibility(link, library)).toEqual({ kind: "ineligible", reason });
  });

  it.each([
    ["no abstract", null],
    ["an empty abstract", ""],
    ["one empty after normalization", `${SOFT_HYPHEN}  `],
  ])("never offers a first copy of %s", (_label, library) => {
    expect(sourceUpdateEligibility(empty, library)).toEqual({ kind: "ineligible", reason: "no_copy_no_abstract" });
  });

  it("measures 50,000 in code points, as the server's char_length does: 50,000 astral characters fit, one more doesn't", () => {
    const fits = ASTRAL.repeat(50_000);
    expect(fits.length).toBe(100_000);
    expect(sourceUpdateEligibility(link, fits)).toEqual({ kind: "eligible", state: "content_change" });
    expect(sourceUpdateEligibility(link, `${fits}x`)).toEqual({ kind: "ineligible", reason: "too_long" });
    expect(sourceUpdateEligibility(empty, `${"a".repeat(49_999)}${ASTRAL}`)).toEqual({ kind: "eligible", state: "abstract_now_available" });
    expect(sourceUpdateEligibility(empty, `${"a".repeat(50_000)}${ASTRAL}`)).toEqual({ kind: "ineligible", reason: "too_long" });
    // Too long whichever way it differs — typography only included (G1).
    expect(sourceUpdateEligibility(link, ABSTRACT.replace(THIN_SPACE, " ".repeat(50_001)))).toEqual({ kind: "ineligible", reason: "too_long" });
  });

  it("refuses a 21st copy: a link holds at most 20", () => {
    const rows = fullRows();
    rows.anchors = [];
    rows.snapshots = Array.from({ length: 20 }, (_, index) =>
      snapshotRow({ id: uuid("c", 100 + index), seq: index + 1, exact_text: index === 19 ? ABSTRACT : `${OLD_ABSTRACT} (${index + 1})`, captured_at: `2026-10-${String(index + 1).padStart(2, "0")}T10:00:00.000Z` }),
    );
    const full = linkOf(record(rows));
    expect(full.snapshots).toHaveLength(20);
    expect(sourceUpdateEligibility(full, REVISED)).toEqual({ kind: "ineligible", reason: "copy_limit" });
    rows.snapshots = rows.snapshots.slice(1).map((snapshot, index) => ({ ...snapshot, seq: index + 1 }));
    expect(sourceUpdateEligibility(linkOf(record(rows)), REVISED)).toEqual({ kind: "eligible", state: "content_change" });
  });
});

describe("a frozen candidate, checked against the record as loaded", () => {
  const data = record(fullRows());
  const candidate = (overrides: Partial<SourceUpdateCandidate> = {}): SourceUpdateCandidate => ({
    paperId: paper,
    text: REVISED,
    studyVersion: 4,
    currentCopyId: toSnapshotId(SNAPSHOT_ID),
    readAt: 1,
    ...overrides,
  });

  it("is ready when it was taken from this record, at the version the editor writes against, on this link's current copy", () => {
    const check = checkSourceUpdateCandidate(data, 4, candidate());
    expect(check.kind).toBe("ready");
    expect(check.kind === "ready" && check.state).toBe("content_change");
  });

  it.each([
    ["another study version", { studyVersion: 3 }, 4],
    ["an editor writing against another version", {}, 5],
    ["a paper the record doesn't link", { paperId: toPaperId(SECOND_PAPER_ID) as PaperId }, 4],
    ["another current copy", { currentCopyId: toSnapshotId(OLD_COPY) }, 4],
    ["a first capture when the link now has a copy", { currentCopyId: null }, 4],
  ])("is stale when taken against %s", (_label, overrides, knownVersion) => {
    expect(checkSourceUpdateCandidate(data, knownVersion, candidate(overrides))).toEqual({ kind: "stale" });
  });

  it("is stale when the record read is at another version than the editor's", () => {
    const moved = record({ ...fullRows(), study: studyRow({ row_version: 5 }) });
    expect(checkSourceUpdateCandidate(moved, 4, candidate())).toEqual({ kind: "stale" });
  });

  it("is ineligible when its own text can't be a copy, whatever was shown", () => {
    expect(checkSourceUpdateCandidate(data, 4, candidate({ text: ABSTRACT }))).toEqual({ kind: "ineligible", reason: "current" });
    expect(checkSourceUpdateCandidate(data, 4, candidate({ text: "x".repeat(50_001) }))).toEqual({ kind: "ineligible", reason: "too_long" });
  });
});

describe("what saving a new copy does to reviews — the server's rule, from the record", () => {
  /**
   * Copy 1 (earlier) and copy 2 (current, ABSTRACT) of the paper, and a second
   * linked paper with its own copy. Each value cites the abstract a different
   * way, at a different review status.
   */
  function impactRows(): FixtureRows {
    const rows = fullRows();
    rows.reports = [reportRow(), reportRow({ id: uuid("b", 2), paper_id: SECOND_PAPER_ID, link_basis: "user_linked", created_at: "2026-10-20T11:00:00.000Z" })];
    rows.snapshots = [
      snapshotRow({ id: OLD_COPY, seq: 1, exact_text: OLD_ABSTRACT, captured_at: "2026-10-01T12:00:00.000Z" }),
      snapshotRow({ seq: 2 }),
      snapshotRow({ id: uuid("c", 9), paper_id: SECOND_PAPER_ID, exact_text: "A second report of the same trial." }),
    ];
    const reviewed = { review_status: "user_reviewed", reviewed_at: "2026-10-21T10:00:00.000Z", reviewed_version: 2 } as const;
    rows.values = [
      // Reviewed, quoted on the current copy.
      valueRow({ id: uuid("f", 1), field_key: "condition", value_version: 2, ...reviewed }),
      // Flagged, quoted on the earlier copy only: still dependent on the link's abstract.
      valueRow({ id: uuid("f", 2), field_key: "setting", value_text: "Three hospitals", review_status: "disputed", review_note: "Check the setting" }),
      // Already needs re-review, with an examined current copy and a note kept from its flag.
      valueRow({ id: uuid("f", 3), field_key: "population_description", value_text: "Adults", review_status: "needs_rereview", review_reason: "source_changed", review_note: "Earlier note" }),
      // Not reviewed, quoted on the current copy.
      valueRow({ id: uuid("f", 4), field_key: "demographics", value_text: "Mixed", value_version: 1 }),
      // Reviewed, but from the full text only: not dependent.
      valueRow({ id: uuid("f", 5), field_key: "eligibility_criteria", value_text: "Adults with T2D", value_version: 3, ...reviewed, reviewed_version: 3 }),
      // Reviewed, quoted on the OTHER paper's copy: not dependent on this one.
      valueRow({ id: uuid("f", 6), field_key: "design_as_reported", value_text: "RCT", value_version: 1, ...reviewed, reviewed_version: 1 }),
    ];
    const quote = (n: number, valueId: string, snapshotId: string, paperId: string = PAPER_ID) =>
      quoteAnchorRow({ id: uuid("9", n), value_id: valueId, paper_id: paperId, snapshot_id: snapshotId });
    const assessment = (n: number, valueId: string, purpose: "examined" | "unavailable", sourceKind: "abstract" | "full_text", snapshotId: string | null) => ({
      ...quoteAnchorRow({ id: uuid("9", n), value_id: valueId }),
      purpose,
      source_kind: sourceKind,
      snapshot_id: snapshotId,
      position: null,
      quote_text: null,
      match_start: null,
      match_end: null,
      match_occurrence: null,
      match_count: null,
      normalization_version: null,
      matched_at: null,
    });
    rows.anchors = [
      quote(1, uuid("f", 1), SNAPSHOT_ID),
      quote(2, uuid("f", 1), SNAPSHOT_ID),
      quote(3, uuid("f", 2), OLD_COPY),
      assessment(4, uuid("f", 3), "examined", "abstract", SNAPSHOT_ID),
      quote(5, uuid("f", 4), SNAPSHOT_ID),
      { ...quoteAnchorRow({ id: uuid("9", 6), value_id: uuid("f", 5) }), source_kind: "full_text", snapshot_id: null, quote_text: null, match_start: null, match_end: null, match_occurrence: null, match_count: null, normalization_version: null, matched_at: null, locator_kind: "page", locator_text: "4" },
      quote(7, uuid("f", 6), uuid("c", 9), SECOND_PAPER_ID),
    ];
    return rows;
  }

  const impactOf = (rows: FixtureRows, paperId: string = PAPER_ID) => {
    const data = record(rows);
    const items = buildReviewItems(data, createDraft(data), { canWrite: true, activity: "idle" });
    return describeSourceUpdate(data, items, toPaperId(paperId) as PaperId)!;
  };
  const fields = (items: readonly { readonly fieldKey: string }[]) => items.map((item) => item.fieldKey);

  it("sorts every value citing the link's abstract by what happens to its review — and leaves the rest out", () => {
    const impact = impactOf(impactRows());
    // Reviewed and flagged: need re-review, even if every quote is found again.
    // In the record's order (the field dictionary's), as Review lists them.
    expect(fields(impact.needsRereview)).toEqual(["setting", "condition"]);
    expect(impact.needsRereview.map((item) => item.value.review.status).sort()).toEqual(["disputed", "user_reviewed"]);
    // Already needs re-review: stays so, and is not counted as a change.
    expect(fields(impact.staysNeedsRereview)).toEqual(["population_description"]);
    // Not reviewed: stays not reviewed.
    expect(fields(impact.staysUnreviewed)).toEqual(["demographics"]);
    // A full-text-only value and a value citing another paper are untouched.
    const all = [...impact.needsRereview, ...impact.staysNeedsRereview, ...impact.staysUnreviewed].map((item) => item.fieldKey);
    expect(all).not.toContain("eligibility_criteria");
    expect(all).not.toContain("design_as_reported");
    // Notes are kept: two of the affected values have one.
    expect(impact.withReviewNote).toBe(2);
  });

  it("counts the quotes the server will look for — the current copy's — apart from those on earlier copies, without forecasting a match", () => {
    const impact = impactOf(impactRows());
    expect(impact.currentCopy).toEqual({ id: SNAPSHOT_ID, seq: 2, capturedAt: "2026-10-20T10:00:00.000Z" });
    expect(impact.copies).toBe(2);
    expect(impact.quotesToRecheck).toBe(3);
    expect(impact.quotesOnEarlierCopies).toBe(1);
    expect(impact.paperTitle).toBe(PAPER_TITLE);
    expect(Object.keys(impact).sort()).toEqual(
      ["copies", "currentCopy", "needsRereview", "paperId", "paperTitle", "quotesOnEarlierCopies", "quotesToRecheck", "staysNeedsRereview", "staysUnreviewed", "unavailableAbstract", "withReviewNote"].sort(),
    );
  });

  it("describes the other link on its own: only its own dependents", () => {
    const impact = impactOf(impactRows(), SECOND_PAPER_ID);
    expect(fields(impact.needsRereview)).toEqual(["design_as_reported"]);
    expect(impact.staysNeedsRereview).toEqual([]);
    expect(impact.staysUnreviewed).toEqual([]);
    expect(impact.quotesToRecheck).toBe(1);
  });

  it("a first capture: no current copy, no quote to recheck — and a value that said the paper had no abstract to check is affected and named", () => {
    const rows = noCopyRows();
    rows.values = [
      valueRow({ id: uuid("f", 1), field_key: "condition", value_state: "not_reported", value_text: null, value_version: 2, review_status: "user_reviewed", reviewed_at: "2026-10-21T10:00:00.000Z", reviewed_version: 2 }),
      valueRow({ id: uuid("f", 2), field_key: "setting", value_state: "not_reported", value_text: null, value_version: 1 }),
    ];
    rows.anchors = [
      { ...quoteAnchorRow({ id: uuid("9", 1), value_id: uuid("f", 1) }), purpose: "unavailable", source_kind: "abstract", snapshot_id: null, position: null, quote_text: null, match_start: null, match_end: null, match_occurrence: null, match_count: null, normalization_version: null, matched_at: null },
      { ...quoteAnchorRow({ id: uuid("9", 2), value_id: uuid("f", 2) }), purpose: "unavailable", source_kind: "abstract", snapshot_id: null, position: null, quote_text: null, match_start: null, match_end: null, match_occurrence: null, match_count: null, normalization_version: null, matched_at: null },
    ];
    const impact = impactOf(rows);
    expect(impact.currentCopy).toBeNull();
    expect(impact.copies).toBe(0);
    expect(impact.quotesToRecheck).toBe(0);
    expect(fields(impact.needsRereview)).toEqual(["condition"]);
    expect(fields(impact.staysUnreviewed)).toEqual(["setting"]);
    expect(fields(impact.unavailableAbstract).sort()).toEqual(["condition", "setting"]);
  });

  it("no value citing the abstract: nothing to say about reviews", () => {
    const rows = fullRows();
    rows.anchors = [];
    const impact = impactOf(rows);
    expect([impact.needsRereview, impact.staysNeedsRereview, impact.staysUnreviewed, impact.unavailableAbstract]).toEqual([[], [], [], []]);
    expect(impact.quotesToRecheck).toBe(0);
  });
});

describe("the SHA-256 the server compares", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const node = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

  it.each([
    ["ASCII", "Background: a synthetic trial."],
    ["Latin-1 and the micro sign", `Caf${cp(0xe9)} au lait, 5 ${cp(0xb5)}g`],
    ["a composed and a decomposed accent — never normalized into each other", `e${cp(0x301)} and ${cp(0xe9)}`],
    ["CJK", `${cp(0x7cd6)}${cp(0x5c3f)}${cp(0x75c5)}${cp(0x306e)}${cp(0x8a66)}${cp(0x9a13)}`],
    ["supplementary characters", `${ASTRAL} and ${cp(0x1f600)}`],
    ["white space kept exactly: leading, trailing, CRLF, a thin space, a no-break space", `  Lead\r\nline${THIN_SPACE}two${NBSP}three  \n`],
    ["invisible characters", `soft${SOFT_HYPHEN}hyphen${cp(0x200b)}zero-width${cp(0xfeff)}BOM`],
    ["the fixture abstract", ABSTRACT],
    ["50,000 code points", ASTRAL.repeat(50_000)],
  ])("is the lowercase hex SHA-256 of the UTF-8 bytes, as node's: %s", async (_label, text) => {
    const digest = await abstractSha256(text);
    expect(digest).toEqual({ ok: true, sha256: node(text) });
    expect(digest.ok && digest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the text as given: two texts equal after normalization have different digests", async () => {
    const a = await abstractSha256(ABSTRACT);
    const b = await abstractSha256(ABSTRACT.split(THIN_SPACE).join(" "));
    expect(a.ok && b.ok && a.sha256 !== b.sha256).toBe(true);
    const trimmed = await abstractSha256(` ${ABSTRACT} `);
    expect(trimmed.ok && a.ok && trimmed.sha256 !== a.sha256).toBe(true);
  });

  it("refuses to hash text with no faithful UTF-8 form (a lone surrogate, NUL) rather than replace it", async () => {
    expect(await abstractSha256(`a${String.fromCharCode(0xdc00)}b`)).toEqual({ ok: false, reason: "failed" });
    expect(await abstractSha256(`a\u0000b`)).toEqual({ ok: false, reason: "failed" });
  });

  it("fails closed without Web Crypto: no crypto at all, or no subtle digest", async () => {
    expect(canDigestAbstract()).toBe(true);
    vi.stubGlobal("crypto", undefined);
    expect(canDigestAbstract()).toBe(false);
    expect(await abstractSha256(ABSTRACT)).toEqual({ ok: false, reason: "unavailable" });
    vi.stubGlobal("crypto", { randomUUID: () => "x" });
    expect(canDigestAbstract()).toBe(false);
    expect(await abstractSha256(ABSTRACT)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("fails closed when the digest itself fails or answers something that isn't a SHA-256", async () => {
    vi.stubGlobal("crypto", { subtle: { digest: () => Promise.reject(new Error("OperationError")) } });
    expect(await abstractSha256(ABSTRACT)).toEqual({ ok: false, reason: "failed" });
    vi.stubGlobal("crypto", { subtle: { digest: () => Promise.resolve(new ArrayBuffer(20)) } });
    expect(await abstractSha256(ABSTRACT)).toEqual({ ok: false, reason: "failed" });
  });
});
