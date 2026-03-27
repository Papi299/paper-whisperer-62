import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processChunkedInsert, type RpcFn } from "../chunkedInsert";

// Suppress console.error from the retry/chunk error paths
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** Helper: build a successful RPC response for a chunk starting at global offset */
function makeSuccess(chunkSize: number, startIndex = 0) {
  return {
    data: Array.from({ length: chunkSize }, (_, j) => ({
      index: j, // local index within chunk; processChunkedInsert adjusts to global
      status: "inserted" as const,
      id: `id-${startIndex + j}`,
    })),
    error: null,
  };
}

/** Helper: build a duplicate RPC response for one item in a chunk */
function makeMixed(specs: Array<{ status: "inserted" | "duplicate" | "error"; id?: string }>) {
  return {
    data: specs.map((s, j) => ({ index: j, status: s.status, id: s.id })),
    error: null,
  };
}

describe("processChunkedInsert — chunk failure accounting", () => {
  it("all chunks succeed: every item has a result", async () => {
    // 5 items, chunkSize=2 → 3 chunks (2, 2, 1)
    const payload = Array.from({ length: 5 }, (_, i) => ({ title: `paper-${i}` }));
    const rpcFn: RpcFn = vi.fn()
      .mockResolvedValueOnce(makeSuccess(2, 0))
      .mockResolvedValueOnce(makeSuccess(2, 2))
      .mockResolvedValueOnce(makeSuccess(1, 4));

    const { results, lastError } = await processChunkedInsert(payload, rpcFn, {
      chunkSize: 2,
      interChunkDelayMs: 0,
    });

    expect(lastError).toBeNull();
    expect(results).toHaveLength(5);
    // Every index 0–4 is present exactly once
    const indices = results.map(r => r.index).sort();
    expect(indices).toEqual([0, 1, 2, 3, 4]);
    // All inserted
    expect(results.every(r => r.status === "inserted")).toBe(true);
  });

  it("middle chunk fails with rpcError: failed chunk counted, later chunks still run", async () => {
    // 6 items, chunkSize=2 → 3 chunks
    const payload = Array.from({ length: 6 }, (_, i) => ({ title: `paper-${i}` }));

    // Chunk 0 (items 0-1): success
    // Chunk 1 (items 2-3): returns rpcError (non-transient, so no retry)
    // Chunk 2 (items 4-5): success
    const rpcFn: RpcFn = vi.fn()
      .mockResolvedValueOnce(makeSuccess(2, 0))   // chunk 0
      .mockResolvedValueOnce({ data: null, error: { message: "constraint error" } }) // chunk 1
      .mockResolvedValueOnce(makeSuccess(2, 4));   // chunk 2

    const { results, lastError } = await processChunkedInsert(payload, rpcFn, {
      chunkSize: 2,
      interChunkDelayMs: 0,
    });

    // All 6 items accounted for
    expect(results).toHaveLength(6);
    const indices = results.map(r => r.index).sort();
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);

    // Chunk 0 items: inserted
    expect(results.filter(r => r.index < 2).every(r => r.status === "inserted")).toBe(true);
    // Chunk 1 items: error
    const failedItems = results.filter(r => r.index >= 2 && r.index < 4);
    expect(failedItems.every(r => r.status === "error")).toBe(true);
    expect(failedItems.every(r => r.error_message === "constraint error")).toBe(true);
    // Chunk 2 items: inserted (proves later chunks still ran)
    expect(results.filter(r => r.index >= 4).every(r => r.status === "inserted")).toBe(true);

    expect(lastError).toBe("constraint error");
    // rpcFn was called 3 times (all 3 chunks attempted)
    expect(rpcFn).toHaveBeenCalledTimes(3);
  });

  it("middle chunk throws exception: failed chunk counted, later chunks still run", async () => {
    // 6 items, chunkSize=2 → 3 chunks
    const payload = Array.from({ length: 6 }, (_, i) => ({ title: `paper-${i}` }));

    // Chunk 0: success
    // Chunk 1: throws non-transient error (shouldRetry returns false → no retry)
    // Chunk 2: success
    const rpcFn: RpcFn = vi.fn()
      .mockResolvedValueOnce(makeSuccess(2, 0))
      .mockRejectedValueOnce(new Error("Non-transient exception"))
      .mockResolvedValueOnce(makeSuccess(2, 4));

    const { results, lastError } = await processChunkedInsert(payload, rpcFn, {
      chunkSize: 2,
      interChunkDelayMs: 0,
    });

    expect(results).toHaveLength(6);
    const indices = results.map(r => r.index).sort();
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);

    // Chunk 1 items: error
    const chunk1 = results.filter(r => r.index >= 2 && r.index < 4);
    expect(chunk1.every(r => r.status === "error")).toBe(true);
    // Chunk 2 still ran
    expect(results.filter(r => r.index >= 4).every(r => r.status === "inserted")).toBe(true);

    expect(lastError).toBe("Non-transient exception");
    expect(rpcFn).toHaveBeenCalledTimes(3);
  });

  it("transient failure retries then succeeds: no items lost", async () => {
    vi.useFakeTimers();

    // 2 items, chunkSize=2 → 1 chunk
    const payload = [{ title: "a" }, { title: "b" }];
    const rpcFn: RpcFn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("503 Service Unavailable"), {}))
      .mockResolvedValueOnce(makeSuccess(2, 0));

    const promise = processChunkedInsert(payload, rpcFn, {
      chunkSize: 2,
      interChunkDelayMs: 0,
    });

    // Advance past retry backoff (1000ms)
    await vi.advanceTimersByTimeAsync(1000);

    const { results, lastError } = await promise;

    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === "inserted")).toBe(true);
    expect(lastError).toBeNull();
    expect(rpcFn).toHaveBeenCalledTimes(2); // 1 fail + 1 retry success
  });

  it("transient failure exhausts retries: chunk marked failed, later chunks proceed", async () => {
    vi.useFakeTimers();

    // 4 items, chunkSize=2 → 2 chunks
    const payload = Array.from({ length: 4 }, (_, i) => ({ title: `p-${i}` }));
    const transientError = Object.assign(new Error("502 Bad Gateway"), {});

    const rpcFn: RpcFn = vi.fn()
      // Chunk 0: fails twice (initial + 1 retry = exhausted)
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      // Chunk 1: succeeds
      .mockResolvedValueOnce(makeSuccess(2, 2));

    const promise = processChunkedInsert(payload, rpcFn, {
      chunkSize: 2,
      interChunkDelayMs: 0,
    }).catch(e => e);

    // Advance past retry backoff for chunk 0 (1000ms)
    await vi.advanceTimersByTimeAsync(1000);

    const { results, lastError } = await promise;

    expect(results).toHaveLength(4);
    const indices = results.map(r => r.index).sort();
    expect(indices).toEqual([0, 1, 2, 3]);

    // Chunk 0: failed after retry exhaustion
    expect(results.filter(r => r.index < 2).every(r => r.status === "error")).toBe(true);
    // Chunk 1: succeeded
    expect(results.filter(r => r.index >= 2).every(r => r.status === "inserted")).toBe(true);

    expect(lastError).toBe("502 Bad Gateway");
    // 2 calls for chunk 0 (initial + retry) + 1 for chunk 1 = 3
    expect(rpcFn).toHaveBeenCalledTimes(3);
  });

  it("mixed results (inserted + duplicate) are preserved correctly", async () => {
    const payload = [{ title: "a" }, { title: "b" }, { title: "c" }];
    const rpcFn: RpcFn = vi.fn().mockResolvedValueOnce(
      makeMixed([
        { status: "inserted", id: "id-0" },
        { status: "duplicate" },
        { status: "inserted", id: "id-2" },
      ]),
    );

    const { results } = await processChunkedInsert(payload, rpcFn, {
      chunkSize: 10,
      interChunkDelayMs: 0,
    });

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ index: 0, status: "inserted", id: "id-0" });
    expect(results[1]).toMatchObject({ index: 1, status: "duplicate" });
    expect(results[2]).toMatchObject({ index: 2, status: "inserted", id: "id-2" });
  });

  it("empty payload returns empty results", async () => {
    const rpcFn: RpcFn = vi.fn();
    const { results, lastError } = await processChunkedInsert([], rpcFn, {
      chunkSize: 50,
    });
    expect(results).toHaveLength(0);
    expect(lastError).toBeNull();
    expect(rpcFn).not.toHaveBeenCalled();
  });
});
