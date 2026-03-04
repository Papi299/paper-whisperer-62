/**
 * Client-side wrapper that delegates paper metadata fetching to the
 * `fetch-paper-metadata` Supabase edge function.
 *
 * The edge function handles rate limiting, retries with exponential backoff,
 * and PubMed/Crossref API calls server-side.
 */

import { supabase } from "@/integrations/supabase/client";
import type { PaperMetadata } from "@/types/database";

/** Maximum identifiers per single edge function invocation. */
const EDGE_BATCH_SIZE = 10;

/**
 * Fetch paper metadata via the Supabase edge function.
 *
 * Batches large identifier lists into groups of EDGE_BATCH_SIZE to avoid
 * edge function timeouts (each batch is rate-limited server-side).
 *
 * Drop-in replacement for the old client-side `fetchPaperMetadata`.
 */
export async function fetchPaperMetadata(
  identifiers: string[]
): Promise<PaperMetadata[]> {
  if (identifiers.length === 0) return [];

  const allResults: PaperMetadata[] = [];

  for (let i = 0; i < identifiers.length; i += EDGE_BATCH_SIZE) {
    const batch = identifiers.slice(i, i + EDGE_BATCH_SIZE);

    const { data, error } = await supabase.functions.invoke(
      "fetch-paper-metadata",
      { body: { identifiers: batch } }
    );

    if (error) {
      // On edge function failure, mark all identifiers in this batch as failed
      for (const id of batch) {
        allResults.push({
          identifier: id,
          error: `Edge function error: ${error.message}`,
        });
      }
      continue;
    }

    const results = data?.results;
    if (Array.isArray(results)) {
      allResults.push(...results);
    } else {
      // Unexpected response shape — mark batch as failed
      for (const id of batch) {
        allResults.push({
          identifier: id,
          error: "Unexpected edge function response",
        });
      }
    }
  }

  return allResults;
}
