/**
 * The PubMed/Crossref transport: retry, backoff, timeout — and the bounded
 * failure reporting that replaced rethrowing the provider's own error.
 *
 * EDGE-LOG-PRIVACY-HARDENING-001.
 *
 * ## Why this moved out of `index.ts`
 *
 * It used to be a private function in the Deno shell, which Vitest cannot
 * import (remote `https://esm.sh/…` imports, `Deno.serve`). That made the one
 * genuinely dangerous path in this function untestable: on exhaustion it did
 *
 *     lastError = error instanceof Error ? error : new Error(String(error));
 *     …
 *     throw lastError;
 *
 * so the caller caught the runtime's own `fetch` error and logged its message.
 * A `fetch` failure message can embed the request URL, and these URLs carry
 * the PMID, the DOI or title being searched, and the user's `api_key`.
 *
 * Only the transport moved. The retry budget, the backoff schedule, the
 * per-attempt timeout and the retry conditions are byte-for-byte the previous
 * behaviour, and the defaults below are the previous default arguments.
 *
 * ## What may be logged
 *
 * Server-generated bounded facts only: which upstream, the HTTP status, the
 * attempt number, the delay, and an allow-listed error NAME. Never the URL,
 * never the API key, never the query, never a throwable's message.
 *
 * Pure except for its injected dependencies, so Vitest drives it with a fake
 * `fetch` that rejects with a hostile, URL-bearing error and asserts what the
 * logger received.
 */

import { boundedErrorName, type BoundedErrorName } from "../_shared/boundedLogging.ts";

/** The two upstreams this function talks to, as a bounded log label. */
export type UpstreamSource = "pubmed" | "crossref";

/** Per-attempt timeout. Unchanged from the previous inline `AbortSignal.timeout(15_000)`. */
export const UPSTREAM_TIMEOUT_MS = 15_000;
/** Previous default argument of `fetchWithRetry`. Crossref paths use it. */
export const UPSTREAM_DEFAULT_MAX_RETRIES = 3;
/** Previous default argument of `fetchWithRetry`. */
export const UPSTREAM_DEFAULT_BASE_DELAY_MS = 1000;

/**
 * The message of the error thrown once the retry budget is exhausted.
 *
 * A fixed literal: the caller may log it, and callers of callers may not know
 * where it came from, so it carries no upstream detail of its own. The detail
 * is in the bounded line this module logs immediately before throwing.
 */
export const UPSTREAM_FETCH_FAILED_MESSAGE = "upstream_fetch_failed";

export interface UpstreamFetchOptions {
  /** Which upstream — the only thing that distinguishes the log lines. */
  source: UpstreamSource;
  /** Request init, exactly as before (headers for Crossref; empty for PubMed). */
  init?: RequestInit;
  /** Defaults to 3, as the previous signature did. PubMed paths pass 1. */
  maxRetries?: number;
  /** Defaults to 1000 ms, as the previous signature did. */
  baseDelayMs?: number;
}

export interface UpstreamFetchDeps {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  logger: { warn(message: string): void };
  /** Injected so a test never waits 15 real seconds for the platform signal. */
  createTimeoutSignal?: (ms: number) => AbortSignal;
}

/**
 * Build the retrying fetch. One instance is created per Edge Function instance
 * in `index.ts`; the returned function is the exact code paths above.
 */
export function createFetchWithRetry(
  deps: UpstreamFetchDeps,
): (url: string, options: UpstreamFetchOptions) => Promise<Response> {
  const createSignal = deps.createTimeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  return async function fetchWithRetry(url: string, options: UpstreamFetchOptions): Promise<Response> {
    const {
      source,
      init = {},
      maxRetries = UPSTREAM_DEFAULT_MAX_RETRIES,
      baseDelayMs = UPSTREAM_DEFAULT_BASE_DELAY_MS,
    } = options;

    // Only the NAME of the last failure survives the loop. The error object
    // itself is deliberately not retained: keeping it is what made the old
    // implementation able to rethrow a URL into a caller's log line.
    let lastErrorName: BoundedErrorName | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await deps.fetchImpl(url, {
          ...init,
          signal: createSignal(UPSTREAM_TIMEOUT_MS),
        });

        // Retry on rate limit or server errors — unchanged.
        if (response.status === 429 || response.status >= 500) {
          if (attempt < maxRetries) {
            const delay = baseDelayMs * Math.pow(2, attempt);
            deps.logger.warn(
              `upstream_retry source=${source} status=${response.status} ` +
                `attempt=${attempt + 1} delay_ms=${delay} retry=1`,
            );
            await deps.sleep(delay);
            continue;
          }
        }

        return response;
      } catch (error) {
        lastErrorName = boundedErrorName(error);
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          deps.logger.warn(
            `upstream_retry source=${source} error=${lastErrorName} ` +
              `attempt=${attempt + 1} delay_ms=${delay} retry=1`,
          );
          await deps.sleep(delay);
        }
      }
    }

    // Reached only when every attempt threw: a non-retryable status returns
    // above, and the final attempt returns its response whatever the status.
    deps.logger.warn(
      `upstream_fetch_failed source=${source} attempts=${maxRetries + 1} ` +
        `error=${lastErrorName ?? "none"} retry=0`,
    );
    throw new Error(UPSTREAM_FETCH_FAILED_MESSAGE);
  };
}
