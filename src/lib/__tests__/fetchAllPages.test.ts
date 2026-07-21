import { describe, it, expect, vi } from "vitest";
import { fetchAllPages } from "../fetchAllPages";

describe("fetchAllPages", () => {
  it("returns all rows in a single page when count < pageSize", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}` }));
    const buildQuery = vi.fn(() => ({
      range: vi.fn(async () => ({ data: rows, error: null })),
    }));

    const result = await fetchAllPages(buildQuery, 100);
    expect(result).toHaveLength(50);
    expect(buildQuery).toHaveBeenCalledTimes(1);
  });

  it("paginates across multiple pages and collects all rows", async () => {
    // Simulate 2500 rows with pageSize=1000 → 3 pages (1000 + 1000 + 500)
    const allRows = Array.from({ length: 2500 }, (_, i) => ({ id: `r${i}` }));
    let callCount = 0;

    const buildQuery = () => ({
      range: async (from: number, to: number) => {
        callCount++;
        const page = allRows.slice(from, to + 1);
        return { data: page, error: null };
      },
    });

    const result = await fetchAllPages<{ id: string }>(buildQuery, 1000);
    expect(result).toHaveLength(2500);
    expect(callCount).toBe(3);
    // Verify order preserved
    expect(result[0].id).toBe("r0");
    expect(result[999].id).toBe("r999");
    expect(result[1000].id).toBe("r1000");
    expect(result[2499].id).toBe("r2499");
  });

  it("handles exactly pageSize rows (ambiguous last page) with one extra call", async () => {
    // Exactly 1000 rows → first page returns 1000 (= pageSize), so it fetches page 2 which returns 0
    const allRows = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}` }));
    let callCount = 0;

    const buildQuery = () => ({
      range: async (from: number, to: number) => {
        callCount++;
        const page = allRows.slice(from, to + 1);
        return { data: page, error: null };
      },
    });

    const result = await fetchAllPages(buildQuery, 1000);
    expect(result).toHaveLength(1000);
    expect(callCount).toBe(2); // 1000 rows + 1 empty page to confirm end
  });

  it("returns empty array when no rows match", async () => {
    const buildQuery = () => ({
      range: async () => ({ data: [], error: null }),
    });

    const result = await fetchAllPages(buildQuery, 1000);
    expect(result).toHaveLength(0);
  });

  it("throws on error from any page", async () => {
    let callCount = 0;
    const buildQuery = () => ({
      range: async () => {
        callCount++;
        if (callCount === 2) {
          return { data: null, error: new Error("DB connection lost") };
        }
        return { data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null };
      },
    });

    await expect(fetchAllPages(buildQuery, 1000)).rejects.toThrow("DB connection lost");
  });

  it("calls buildQuery fresh for each page (factory pattern)", async () => {
    const allRows = Array.from({ length: 1500 }, (_, i) => ({ id: `r${i}` }));
    const buildQuery = vi.fn(() => ({
      range: vi.fn(async (from: number, to: number) => {
        const page = allRows.slice(from, to + 1);
        return { data: page, error: null };
      }),
    }));

    await fetchAllPages(buildQuery, 1000);
    // buildQuery must be called once per page (2 pages for 1500 rows)
    expect(buildQuery).toHaveBeenCalledTimes(2);
  });

  it("correctly handles >1000 rows (the motivating use case)", async () => {
    // Simulate a library with 3456 papers, pageSize=1000
    const totalPapers = 3456;
    const allRows = Array.from({ length: totalPapers }, (_, i) => ({
      id: `paper-${i}`,
      title: `Paper ${i}`,
    }));

    const buildQuery = () => ({
      range: async (from: number, to: number) => {
        const page = allRows.slice(from, to + 1);
        return { data: page, error: null };
      },
    });

    const result = await fetchAllPages<{ id: string; title: string }>(buildQuery, 1000);
    expect(result).toHaveLength(totalPapers);
    // Verify no data loss — first, middle, and last rows present
    expect(result[0].id).toBe("paper-0");
    expect(result[1000].id).toBe("paper-1000");
    expect(result[2000].id).toBe("paper-2000");
    expect(result[3455].id).toBe("paper-3455");
  });
});
