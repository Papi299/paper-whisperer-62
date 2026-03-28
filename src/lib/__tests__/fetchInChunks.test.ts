import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — factory must not reference variables declared below.
// Use vi.hoisted to declare mocks that are available inside the factory.
const { mockFrom, mockSelect, mockIn } = vi.hoisted(() => {
  const mockIn = vi.fn();
  const mockSelect = vi.fn(() => ({ in: mockIn }));
  const mockFrom = vi.fn(() => ({ select: mockSelect }));
  return { mockFrom, mockSelect, mockIn };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom },
}));

import { fetchInChunks } from "../fetchInChunks";

describe("fetchInChunks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default implementations after clearAllMocks
    mockSelect.mockReturnValue({ in: mockIn });
    mockFrom.mockReturnValue({ select: mockSelect });
  });

  it("returns empty array for empty IDs without any network call", async () => {
    const result = await fetchInChunks("paper_tags", "paper_id, tag_id", "paper_id", []);
    expect(result).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("fetches in a single chunk when IDs fit within chunkSize", async () => {
    const ids = ["id1", "id2", "id3"];
    const mockData = [
      { paper_id: "id1", tag_id: "t1" },
      { paper_id: "id2", tag_id: "t2" },
    ];
    mockIn.mockResolvedValueOnce({ data: mockData, error: null });

    const result = await fetchInChunks<{ paper_id: string; tag_id: string }>(
      "paper_tags", "paper_id, tag_id", "paper_id", ids, 500
    );

    expect(result).toEqual(mockData);
    expect(mockFrom).toHaveBeenCalledWith("paper_tags");
    expect(mockSelect).toHaveBeenCalledWith("paper_id, tag_id");
    expect(mockIn).toHaveBeenCalledTimes(1);
    expect(mockIn).toHaveBeenCalledWith("paper_id", ids);
  });

  it("chunks large ID arrays and merges results", async () => {
    // 1200 IDs with chunkSize=500 → 3 chunks (500 + 500 + 200)
    const ids = Array.from({ length: 1200 }, (_, i) => `id-${i}`);

    const chunk1Data = [{ paper_id: "id-0", tag_id: "t1" }];
    const chunk2Data = [{ paper_id: "id-500", tag_id: "t2" }];
    const chunk3Data = [{ paper_id: "id-1000", tag_id: "t3" }];

    mockIn
      .mockResolvedValueOnce({ data: chunk1Data, error: null })
      .mockResolvedValueOnce({ data: chunk2Data, error: null })
      .mockResolvedValueOnce({ data: chunk3Data, error: null });

    const result = await fetchInChunks<{ paper_id: string; tag_id: string }>(
      "paper_tags", "paper_id, tag_id", "paper_id", ids, 500
    );

    expect(result).toHaveLength(3);
    expect(result).toEqual([...chunk1Data, ...chunk2Data, ...chunk3Data]);
    expect(mockIn).toHaveBeenCalledTimes(3);

    // Verify chunk boundaries
    const firstChunkIds = mockIn.mock.calls[0][1];
    const secondChunkIds = mockIn.mock.calls[1][1];
    const thirdChunkIds = mockIn.mock.calls[2][1];
    expect(firstChunkIds).toHaveLength(500);
    expect(secondChunkIds).toHaveLength(500);
    expect(thirdChunkIds).toHaveLength(200);
    expect(firstChunkIds[0]).toBe("id-0");
    expect(secondChunkIds[0]).toBe("id-500");
    expect(thirdChunkIds[0]).toBe("id-1000");
  });

  it("throws on error from any chunk", async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `id-${i}`);

    mockIn
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("Request too large") });

    await expect(
      fetchInChunks("paper_tags", "paper_id, tag_id", "paper_id", ids, 500)
    ).rejects.toThrow("Request too large");
  });

  it("handles null data gracefully (treats as empty)", async () => {
    mockIn.mockResolvedValueOnce({ data: null, error: null });

    const result = await fetchInChunks("paper_tags", "paper_id, tag_id", "paper_id", ["id-1"]);
    expect(result).toEqual([]);
  });

  it("correctly handles >1000 IDs for export junction hydration", async () => {
    // The motivating use case: export with 2000 papers needs junction hydration
    const ids = Array.from({ length: 2000 }, (_, i) => `paper-${i}`);

    // Each chunk returns some junction rows
    mockIn
      .mockResolvedValueOnce({
        data: Array.from({ length: 300 }, (_, i) => ({ paper_id: `paper-${i}`, tag_id: `tag-${i % 5}` })),
        error: null,
      })
      .mockResolvedValueOnce({
        data: Array.from({ length: 250 }, (_, i) => ({ paper_id: `paper-${500 + i}`, tag_id: `tag-${i % 5}` })),
        error: null,
      })
      .mockResolvedValueOnce({
        data: Array.from({ length: 200 }, (_, i) => ({ paper_id: `paper-${1000 + i}`, tag_id: `tag-${i % 5}` })),
        error: null,
      })
      .mockResolvedValueOnce({
        data: Array.from({ length: 150 }, (_, i) => ({ paper_id: `paper-${1500 + i}`, tag_id: `tag-${i % 5}` })),
        error: null,
      });

    const result = await fetchInChunks<{ paper_id: string; tag_id: string }>(
      "paper_tags", "paper_id, tag_id", "paper_id", ids, 500
    );

    // All junction rows from all chunks collected
    expect(result).toHaveLength(300 + 250 + 200 + 150);
    expect(mockIn).toHaveBeenCalledTimes(4); // 2000 / 500 = 4 chunks
  });
});
