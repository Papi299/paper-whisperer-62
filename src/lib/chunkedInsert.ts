/**
 * Chunked RPC insert with retry and continue-on-failure.
 *
 * Processes `payload` in chunks of `chunkSize`, calling `rpcFn` for each chunk.
 * On transient failures: retries once with 1s backoff.
 * On exhausted retries: marks all papers in the failed chunk as errors, continues to next chunk.
 *
 * Returns one BulkInsertResult per input item — no silent drops.
 */

import type { BulkInsertResult } from "@/types/database";
import { withRetry, isTransientRpcError } from "@/lib/retry";

export interface ChunkedInsertOptions {
  chunkSize: number;
  interChunkDelayMs?: number;
}

export type RpcFn = (chunk: unknown[]) => Promise<{
  data: unknown;
  error: { message: string } | null;
}>;

export async function processChunkedInsert(
  payload: unknown[],
  rpcFn: RpcFn,
  options: ChunkedInsertOptions,
): Promise<{ results: BulkInsertResult[]; lastError: string | null }> {
  const { chunkSize, interChunkDelayMs = 200 } = options;
  let allResults: BulkInsertResult[] = [];
  let lastError: string | null = null;

  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    try {
      const { data: chunkResult, error: rpcError } = await withRetry(
        () => rpcFn(chunk),
        { maxRetries: 1, baseDelayMs: 1000, shouldRetry: isTransientRpcError },
      );

      if (rpcError) {
        console.error("Chunked insert error at offset", i, rpcError.message);
        lastError = rpcError.message;
        for (let j = 0; j < chunk.length; j++) {
          allResults.push({ index: i + j, status: "error", error_message: rpcError.message });
        }
        continue;
      }

      const parsed = (typeof chunkResult === "string" ? JSON.parse(chunkResult) : chunkResult) as BulkInsertResult[];
      const adjusted = parsed.map(r => ({ ...r, index: r.index + i }));
      allResults = [...allResults, ...adjusted];

      if (i + chunkSize < payload.length) {
        await new Promise(resolve => setTimeout(resolve, interChunkDelayMs));
      }
    } catch (err) {
      console.error("Chunked insert exception at offset", i, err);
      lastError = err instanceof Error ? err.message : "Network error";
      for (let j = 0; j < chunk.length; j++) {
        allResults.push({ index: i + j, status: "error", error_message: lastError ?? "Unknown error" });
      }
      continue;
    }
  }

  return { results: allResults, lastError };
}
