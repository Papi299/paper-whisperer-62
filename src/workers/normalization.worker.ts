/**
 * Web Worker for off-main-thread paper normalization.
 *
 * Receives batches of raw papers + normalization config,
 * runs the full normalization pipeline, and posts back results.
 * This keeps the main thread responsive during large bulk imports.
 */

import {
  normalizePaperData,
  type RawPaperData,
  type NormalizedPaperData,
  type NormalizationConfig,
} from "@/lib/normalizePaperData";

export interface NormalizationRequest {
  id: number;
  papers: RawPaperData[];
  config: NormalizationConfig;
}

export interface NormalizationResponse {
  id: number;
  results: NormalizedPaperData[];
}

self.onmessage = (event: MessageEvent<NormalizationRequest>) => {
  const { id, papers, config } = event.data;

  const results: NormalizedPaperData[] = papers.map((raw) =>
    normalizePaperData(raw, config),
  );

  const response: NormalizationResponse = { id, results };
  self.postMessage(response);
};
