/**
 * Lightweight query timing wrapper for performance observability.
 *
 * Wraps any async queryFn to measure wall-clock duration and log it.
 * - Dev mode: logs all queries at debug level
 * - Any mode: warns at >1s, errors on failure
 */
export function timedQueryFn<T>(
  label: string,
  fn: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    const start = performance.now();
    try {
      const result = await fn();
      const ms = performance.now() - start;
      if (ms > 1000) {
        console.warn(`[SLOW QUERY] ${label}: ${ms.toFixed(0)}ms`);
      } else if (import.meta.env.DEV) {
        console.debug(`[query] ${label}: ${ms.toFixed(0)}ms`);
      }
      return result;
    } catch (err) {
      const ms = performance.now() - start;
      console.error(`[FAILED QUERY] ${label}: ${ms.toFixed(0)}ms`, err);
      throw err;
    }
  };
}
