import { describe, expect, it } from "vitest";
import { buildComparisonRequest, normalizeComparisonUuid } from "../request";
import { OWNER_ID, paperId } from "./fixtures";

const ids = (count: number) => Array.from({ length: count }, (_, i) => paperId(i + 1));

function expectRequest(outcome: ReturnType<typeof buildComparisonRequest>) {
  if (!outcome.ok) throw new Error(`expected a request, got refusal ${outcome.reason}`);
  return outcome.request;
}

describe("buildComparisonRequest — size bounds", () => {
  it("refuses 0 and 1 selected papers as too_few", () => {
    expect(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: [] })).toEqual({
      ok: false,
      reason: "too_few",
      selectedCount: 0,
    });
    expect(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: ids(1) })).toEqual({
      ok: false,
      reason: "too_few",
      selectedCount: 1,
    });
  });

  it("accepts 2 and 10 selected papers", () => {
    expect(expectRequest(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: ids(2) })).queryIds).toEqual(ids(2));
    expect(expectRequest(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: ids(10) })).queryIds).toEqual(ids(10));
  });

  it("refuses 11 selected papers as too_many and never truncates to 10", () => {
    const outcome = buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: ids(11) });
    expect(outcome).toEqual({ ok: false, reason: "too_many", selectedCount: 11 });
    expect(outcome).not.toHaveProperty("request");
  });

  it("refuses an oversized selection however large", () => {
    expect(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: ids(120) })).toEqual({
      ok: false,
      reason: "too_many",
      selectedCount: 120,
    });
  });
});

describe("buildComparisonRequest — normalization", () => {
  it("deduplicates ids across case and whitespace before judging the size", () => {
    const lettered = "abcdef00-0000-4000-8000-0000000000ab";
    const outcome = buildComparisonRequest({
      ownerUserId: OWNER_ID,
      selectedIds: [lettered, lettered.toUpperCase(), `  ${lettered}  `, "ABCDEF00-0000-4000-8000-0000000000aB"],
    });
    expect(outcome).toEqual({ ok: false, reason: "too_few", selectedCount: 1 });
  });

  it("normalizes a mixed-case id to lowercase in the query", () => {
    const lettered = "abcdef00-0000-4000-8000-0000000000ab";
    const request = expectRequest(
      buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: [lettered.toUpperCase(), paperId(1)] }),
    );
    expect(request.queryIds).toEqual([paperId(1), lettered]);
  });

  it("counts 12 entries that collapse to 10 distinct ids as 10 (accepted)", () => {
    const lettered = "abcdef00-0000-4000-8000-0000000000ab";
    const selection = [...ids(9), lettered, lettered.toUpperCase(), ` ${paperId(7)}`];
    const request = expectRequest(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: selection }));
    expect(request.selectedIds).toHaveLength(10);
    expect(request.queryIds).toEqual([...ids(9), lettered]);
  });

  it("sorts ids so the same selection always yields the same query", () => {
    const a = expectRequest(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: [paperId(3), paperId(1), paperId(2)] }));
    const b = expectRequest(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: [paperId(2), paperId(3), paperId(1)] }));
    expect(a.queryIds).toEqual([paperId(1), paperId(2), paperId(3)]);
    expect(b.queryIds).toEqual(a.queryIds);
  });

  it("keeps malformed ids as selected but never puts them in the query", () => {
    const malformed = [
      "not-a-uuid",
      `{${paperId(9)}}`, // brace form: Postgres would accept it, the request does not
      `urn:uuid:${paperId(8)}`,
      "",
      `${paperId(7)}x`,
    ];
    const request = expectRequest(
      buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: [paperId(1), paperId(2), ...malformed] }),
    );
    expect(request.selectedIds).toHaveLength(7);
    expect(request.queryIds).toEqual([paperId(1), paperId(2)]);
    for (const bad of malformed) expect(request.queryIds).not.toContain(bad.trim().toLowerCase());
  });

  it("accepts a selection whose ids are all malformed with an empty query (no read will be issued)", () => {
    const request = expectRequest(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: ["bad-1", "bad-2"] }));
    expect(request.selectedIds).toEqual(["bad-1", "bad-2"]);
    expect(request.queryIds).toEqual([]);
  });
});

describe("buildComparisonRequest — owner", () => {
  it.each([null, undefined, "", "   ", "user-1", `{${OWNER_ID}}`])("refuses owner %j as no_user", (owner) => {
    expect(buildComparisonRequest({ ownerUserId: owner, selectedIds: ids(3) })).toEqual({
      ok: false,
      reason: "no_user",
      selectedCount: 0,
    });
  });

  it("canonicalizes the owner id to lowercase", () => {
    const request = expectRequest(buildComparisonRequest({ ownerUserId: OWNER_ID.toUpperCase(), selectedIds: ids(2) }));
    expect(request.ownerUserId).toBe(OWNER_ID);
  });

  it("normalizeComparisonUuid accepts only the canonical 8-4-4-4-12 form", () => {
    expect(normalizeComparisonUuid(` ${OWNER_ID.toUpperCase()} `)).toBe(OWNER_ID);
    expect(normalizeComparisonUuid(OWNER_ID.replace(/-/g, ""))).toBeNull();
    expect(normalizeComparisonUuid(null)).toBeNull();
    expect(normalizeComparisonUuid(undefined)).toBeNull();
  });
});

describe("buildComparisonRequest — frozen snapshot", () => {
  it("is deeply frozen", () => {
    const request = expectRequest(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: ids(3) }));
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.selectedIds)).toBe(true);
    expect(Object.isFrozen(request.queryIds)).toBe(true);
    expect(() => (request.queryIds as string[]).push(paperId(99))).toThrow(TypeError);
  });

  it("is unaffected by later changes to the live selection", () => {
    const selection = new Set(ids(3));
    const request = expectRequest(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: selection }));
    selection.add(paperId(4));
    selection.delete(paperId(1));
    expect(request.queryIds).toEqual(ids(3));
  });

  it("gives every built request a new session id", () => {
    const first = expectRequest(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: ids(2) }));
    const second = expectRequest(buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: ids(2) }));
    expect(second.queryIds).toEqual(first.queryIds);
    expect(second.sessionId).toBeGreaterThan(first.sessionId);
  });
});
