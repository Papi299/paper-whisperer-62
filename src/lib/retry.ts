/**
 * Retry utility with exponential backoff for client-side bulk operations.
 * Used by RPC chunk loops in useBulkMutations — NOT shared with edge functions.
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Execute `fn` with bounded retries and exponential backoff.
 * Throws the last error after all retries are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, shouldRetry = () => true } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !shouldRetry(err)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Unreachable, but satisfies TypeScript
  throw lastError;
}

/**
 * Returns true for errors that are likely transient RPC/network failures
 * and worth retrying. Returns false for constraint violations (duplicates)
 * and other non-transient errors.
 */
export function isTransientRpcError(error: unknown): boolean {
  if (!error) return false;

  const msg = typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

  // Do NOT retry Postgres constraint violations
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code: unknown }).code);
    // 23xxx = integrity constraint violations (23505 = unique_violation, etc.)
    if (code.startsWith("23")) return false;
    // 42xxx = syntax/access errors
    if (code.startsWith("42")) return false;
  }

  // Retry on network-level failures
  if (/failed to fetch|networkerror|econnreset|econnrefused|timeout/i.test(msg)) {
    return true;
  }

  // Retry on 5xx status codes
  if (/\b(500|502|503|504)\b/.test(msg)) {
    return true;
  }

  // Retry on 429 rate limiting
  if (/\b429\b/.test(msg)) {
    return true;
  }

  return false;
}
