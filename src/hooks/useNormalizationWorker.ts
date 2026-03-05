import { useRef, useCallback, useEffect } from "react";
import type { RawPaperData, NormalizedPaperData, NormalizationConfig } from "@/lib/normalizePaperData";
import { normalizePaperData } from "@/lib/normalizePaperData";
import type { NormalizationRequest, NormalizationResponse } from "@/workers/normalization.worker";

/** Minimum batch size to justify spinning up the worker. */
const WORKER_THRESHOLD = 10;

/**
 * Hook that provides a `normalize` function which transparently
 * delegates to a Web Worker for large batches (> WORKER_THRESHOLD)
 * and falls back to the main thread for small batches.
 */
export function useNormalizationWorker() {
  const workerRef = useRef<Worker | null>(null);
  const nextIdRef = useRef(0);
  const pendingRef = useRef<Map<number, (results: NormalizedPaperData[]) => void>>(
    new Map(),
  );

  // Lazily create the worker on first large-batch call
  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL("../workers/normalization.worker.ts", import.meta.url),
        { type: "module" },
      );

      workerRef.current.onmessage = (event: MessageEvent<NormalizationResponse>) => {
        const { id, results } = event.data;
        const resolve = pendingRef.current.get(id);
        if (resolve) {
          pendingRef.current.delete(id);
          resolve(results);
        }
      };

      workerRef.current.onerror = (err) => {
        console.error("[NormalizationWorker] error:", err);
        // Reject all pending
        for (const [id, resolve] of pendingRef.current) {
          resolve([]); // resolve empty so callers can fall back
          pendingRef.current.delete(id);
        }
      };
    }
    return workerRef.current;
  }, []);

  // Clean up worker on unmount
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  /**
   * Normalize a batch of papers. For batches larger than WORKER_THRESHOLD,
   * delegates to the Web Worker. Otherwise runs synchronously on the main thread.
   */
  const normalize = useCallback(
    async (
      papers: RawPaperData[],
      config: NormalizationConfig,
    ): Promise<NormalizedPaperData[]> => {
      // Small batch: run on main thread synchronously
      if (papers.length <= WORKER_THRESHOLD) {
        return papers.map((raw) => normalizePaperData(raw, config));
      }

      // Large batch: offload to Web Worker
      const worker = getWorker();
      const id = nextIdRef.current++;

      return new Promise<NormalizedPaperData[]>((resolve) => {
        pendingRef.current.set(id, resolve);
        const message: NormalizationRequest = { id, papers, config };
        worker.postMessage(message);
      });
    },
    [getWorker],
  );

  return { normalize };
}
