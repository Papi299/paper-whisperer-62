import { describe, expect, it } from "vitest";
import { ComparisonIntegrityError } from "../errors";
import { buildComparisonRequest } from "../request";
import { buildComparisonResult } from "../result";
import type { ComparisonRequest, ComparisonResult, ComparisonRow } from "../types";
import { OTHER_USER_ID, OWNER_ID, makePaperRow, makeSparsePaperRow, paperId, type RawRow } from "./fixtures";

function requestFor(selectedIds: string[]): ComparisonRequest {
  const outcome = buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds });
  if (!outcome.ok) throw new Error(`fixture request refused: ${outcome.reason}`);
  return outcome.request;
}

function comparable(result: ComparisonResult) {
  if (result.kind !== "comparable") throw new Error(`expected comparable, got ${result.kind}`);
  return result;
}

function expectIntegrity(run: () => unknown, reason: string) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComparisonIntegrityError);
    expect((error as ComparisonIntegrityError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected ComparisonIntegrityError(${reason})`);
}

/** Rows with distinct, ordered years so the default order is predictable. */
function rowsWithYears(ids: string[]): RawRow[] {
  return ids.map((id, index) => makePaperRow(id, { year: 2020 - index, title: `Synthetic paper ${index + 1}` }));
}

const textOf = (row: ComparisonRow, field: "abstract" | "notes" | "title") => {
  const value = row[field].value;
  return value.kind === "present" ? value.value : null;
};

describe("buildComparisonResult — availability", () => {
  it("returns every requested paper when all are returned", () => {
    const ids = [paperId(1), paperId(2), paperId(3)];
    const result = comparable(buildComparisonResult(requestFor(ids), rowsWithYears(ids)));
    expect(result.rows.map((row) => row.paperId)).toEqual(ids);
    expect(result).toMatchObject({ selectedCount: 3, unavailableCount: 0, unavailablePaperIds: [] });
  });

  it("reports a requested paper that produced no row as unavailable, without a reason", () => {
    const ids = [paperId(1), paperId(2), paperId(3)];
    const result = comparable(buildComparisonResult(requestFor(ids), rowsWithYears([paperId(1), paperId(3)])));
    expect(result.rows.map((row) => row.paperId)).toEqual([paperId(1), paperId(3)]);
    expect(result).toMatchObject({ selectedCount: 3, unavailableCount: 1, unavailablePaperIds: [paperId(2)] });
    expect(Object.keys(result).sort()).toEqual(["kind", "rows", "selectedCount", "unavailableCount", "unavailablePaperIds"]);
  });

  it("is insufficient — with no rows at all — when only one paper is available", () => {
    const ids = [paperId(1), paperId(2), paperId(3)];
    expect(buildComparisonResult(requestFor(ids), rowsWithYears([paperId(2)]))).toEqual({
      kind: "insufficient",
      selectedCount: 3,
      availableCount: 1,
      unavailableCount: 2,
      unavailablePaperIds: [paperId(1), paperId(3)],
    });
  });

  it("is insufficient when no paper is available", () => {
    expect(buildComparisonResult(requestFor([paperId(1), paperId(2)]), [])).toEqual({
      kind: "insufficient",
      selectedCount: 2,
      availableCount: 0,
      unavailableCount: 2,
      unavailablePaperIds: [paperId(1), paperId(2)],
    });
  });

  it("counts malformed selected ids as unavailable", () => {
    const request = requestFor([paperId(1), paperId(2), "not-a-uuid"]);
    const result = comparable(buildComparisonResult(request, rowsWithYears([paperId(1), paperId(2)])));
    expect(result).toMatchObject({ selectedCount: 3, unavailableCount: 1, unavailablePaperIds: ["not-a-uuid"] });
  });

  it("answers an all-malformed request as insufficient", () => {
    expect(buildComparisonResult(requestFor(["bad-1", "bad-2"]), [])).toMatchObject({
      kind: "insufficient",
      availableCount: 0,
      unavailableCount: 2,
    });
  });
});

describe("buildComparisonResult — integrity (fail closed)", () => {
  const ids = [paperId(1), paperId(2), paperId(3)];

  it("rejects a row the request did not ask for", () => {
    expectIntegrity(
      () => buildComparisonResult(requestFor(ids), [...rowsWithYears([paperId(1), paperId(2)]), makePaperRow(paperId(99))]),
      "unrequested_paper",
    );
  });

  it("rejects a requested paper owned by another user", () => {
    expectIntegrity(
      () =>
        buildComparisonResult(requestFor(ids), [
          ...rowsWithYears([paperId(1), paperId(2)]),
          makePaperRow(paperId(3), { user_id: OTHER_USER_ID }),
        ]),
      "owner_mismatch",
    );
  });

  it("rejects the same paper returned twice", () => {
    expectIntegrity(
      () => buildComparisonResult(requestFor(ids), [...rowsWithYears(ids), makePaperRow(paperId(2))]),
      "duplicate_paper",
    );
  });

  it("rejects an id returned in a different letter case than requested", () => {
    const lettered = "abcdef00-0000-4000-8000-0000000000ab";
    expectIntegrity(
      () =>
        buildComparisonResult(requestFor([paperId(1), paperId(2), lettered]), [
          ...rowsWithYears([paperId(1), paperId(2)]),
          makePaperRow(lettered.toUpperCase()),
        ]),
      "unrequested_paper",
    );
  });

  it.each([[null], [{}], ["[]"], [[null]], [[{ title: "no id" }]]])("rejects a malformed response %j", (data) => {
    expectIntegrity(() => buildComparisonResult(requestFor(ids), data), "malformed_response");
  });

  it("rejects the whole response when one nested record is foreign", () => {
    const rows = rowsWithYears(ids);
    rows[1] = makePaperRow(paperId(2), {
      paper_attachments: [{ id: "a-1", paper_id: paperId(2), user_id: OTHER_USER_ID, file_type: "application/pdf" }],
    });
    expectIntegrity(() => buildComparisonResult(requestFor(ids), rows), "owner_mismatch");
  });
});

describe("buildComparisonResult — association by id only", () => {
  it("produces the same rows in the same order however the database orders them", () => {
    const ids = Array.from({ length: 6 }, (_, i) => paperId(i + 1));
    const rows = ids.map((id, index) => makePaperRow(id, { year: [2019, 2021, null, 2021, 2018, 2020][index] }));
    const request = requestFor(ids);
    const expected = comparable(buildComparisonResult(request, rows)).rows;
    for (let seed = 1; seed <= 12; seed += 1) {
      const shuffled = [...rows].sort((a, b) => ((String(a.id).charCodeAt(35) * seed) % 7) - ((String(b.id).charCodeAt(35) * seed) % 7));
      expect(comparable(buildComparisonResult(request, shuffled)).rows).toEqual(expected);
    }
  });

  it("keeps each paper's own values when two papers share a title", () => {
    const rows = [
      makePaperRow(paperId(1), { title: "Synthetic duplicate title", abstract: "SENTINEL-ABSTRACT-1", notes: "SENTINEL-NOTE-1" }),
      makePaperRow(paperId(2), { title: "Synthetic duplicate title", abstract: "SENTINEL-ABSTRACT-2", notes: "SENTINEL-NOTE-2" }),
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const result = comparable(buildComparisonResult(requestFor([paperId(1), paperId(2)]), order));
      expect(result.rows).toHaveLength(2);
      const byId = new Map(result.rows.map((row) => [row.paperId, row]));
      expect(textOf(byId.get(paperId(1))!, "abstract")).toBe("SENTINEL-ABSTRACT-1");
      expect(textOf(byId.get(paperId(1))!, "notes")).toBe("SENTINEL-NOTE-1");
      expect(textOf(byId.get(paperId(2))!, "abstract")).toBe("SENTINEL-ABSTRACT-2");
      expect(textOf(byId.get(paperId(2))!, "notes")).toBe("SENTINEL-NOTE-2");
    }
  });

  it("keeps similar titles, and identical DOIs, as separate papers", () => {
    const rows = [
      makePaperRow(paperId(1), { title: "Synthetic Trial A", doi: "10.5555/same" }),
      makePaperRow(paperId(2), { title: "synthetic trial a.", doi: "10.5555/same" }),
      makePaperRow(paperId(3), { title: "Synthetic Trial A ", doi: "10.5555/same" }),
    ];
    const result = comparable(buildComparisonResult(requestFor([paperId(1), paperId(2), paperId(3)]), rows));
    expect(result.rows.map((row) => row.paperId).sort()).toEqual([paperId(1), paperId(2), paperId(3)]);
  });

  it("never fills a missing value from another paper", () => {
    const rows = [makePaperRow(paperId(1)), makeSparsePaperRow(paperId(2))];
    const result = comparable(buildComparisonResult(requestFor([paperId(1), paperId(2)]), rows));
    const sparse = result.rows.find((row) => row.paperId === paperId(2))!;
    expect(sparse.abstract.value).toEqual({ kind: "not_recorded" });
    expect(sparse.publicationTypes.value).toEqual({ kind: "not_recorded" });
    expect(sparse.projects.items).toEqual([]);
    expect(sparse.attachments.value.total).toBe(0);
  });

  it("returns a frozen result", () => {
    const result = comparable(buildComparisonResult(requestFor([paperId(1), paperId(2)]), rowsWithYears([paperId(1), paperId(2)])));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rows)).toBe(true);
    expect(Object.isFrozen(result.unavailablePaperIds)).toBe(true);
  });
});
