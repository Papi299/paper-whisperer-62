/**
 * Client-side wrapper that delegates paper metadata fetching to the
 * `fetch-paper-metadata` Supabase edge function.
 *
 * The edge function handles rate limiting, retries with exponential backoff,
 * and PubMed/Crossref API calls server-side.
 */

import { supabase } from "@/integrations/supabase/client";
import type { PaperMetadata } from "@/types/database";
import { getPubmedApiKey } from "@/hooks/useSettings";

/** Maximum identifiers per single edge function invocation. */
const EDGE_BATCH_SIZE = 10;

/**
 * Get a fresh access token, refreshing the session if needed.
 * Returns the access_token string or null if unauthenticated.
 */
async function getFreshAccessToken(): Promise<string | null> {
  // First try: read the current session from memory
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;

  if (session) {
    const expiresAt = session.expires_at ?? 0;
    // If the token is still valid for > 2 minutes, use it as-is
    if (expiresAt * 1000 - Date.now() > 120_000) {
      return session.access_token;
    }
  }

  // Session is missing or about to expire — force a refresh
  const { data: refreshData, error } = await supabase.auth.refreshSession();
  if (error || !refreshData.session) {
    return null;
  }
  return refreshData.session.access_token;
}

/**
 * Invoke the edge function for a single batch of identifiers.
 * Explicitly passes the Authorization header to avoid the race condition
 * where supabase.functions.invoke() reads a stale token from its
 * internal headers (updated asynchronously via onAuthStateChange).
 *
 * On a 401, refreshes the session and retries once with the new token.
 */
async function invokeBatch(
  batch: string[],
  accessToken: string
): Promise<{ data: unknown; error: Error | null }> {
  const apiKey = getPubmedApiKey();
  const body = apiKey
    ? { identifiers: batch, api_key: apiKey }
    : { identifiers: batch };

  const first = await supabase.functions.invoke("fetch-paper-metadata", {
    body,
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // If we get an auth / gateway error, refresh the token and retry once.
  if (first.error) {
    const msg = first.error.message ?? "";
    const isAuthError =
      msg.includes("401") ||
      msg.includes("Unauthorized") ||
      msg.includes("Invalid JWT") ||
      msg.toLowerCase().includes("jwt");

    if (isAuthError) {
      // Force a real token refresh and get the new token directly
      const { data: refreshData, error: refreshError } =
        await supabase.auth.refreshSession();
      if (refreshError || !refreshData.session) {
        return {
          data: null,
          error: refreshError ?? new Error("Session refresh returned no session"),
        };
      }

      // Retry with the explicitly fresh token
      return supabase.functions.invoke("fetch-paper-metadata", {
        body,
        headers: {
          Authorization: `Bearer ${refreshData.session.access_token}`,
        },
      });
    }
  }

  return first;
}

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

  // Get a fresh access token BEFORE any edge function calls.
  // We pass it explicitly in the Authorization header instead of relying
  // on supabase.functions.invoke()'s internal token (which can be stale
  // due to async propagation from onAuthStateChange).
  const accessToken = await getFreshAccessToken();
  if (!accessToken) {
    return identifiers.map((id) => ({
      identifier: id,
      error: "Not authenticated — please sign in again.",
    }));
  }

  const allResults: PaperMetadata[] = [];

  for (let i = 0; i < identifiers.length; i += EDGE_BATCH_SIZE) {
    const batch = identifiers.slice(i, i + EDGE_BATCH_SIZE);

    const { data, error } = await invokeBatch(batch, accessToken);

    if (error) {
      for (const id of batch) {
        allResults.push({
          identifier: id,
          error: `Edge function error: ${error.message}`,
        });
      }
      continue;
    }

    const results = (data as { results?: PaperMetadata[] })?.results;
    if (Array.isArray(results)) {
      allResults.push(...results);
    } else {
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
