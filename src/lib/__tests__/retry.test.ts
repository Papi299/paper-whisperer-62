import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, isTransientRpcError } from "../retry";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns result on first successful attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 1000 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient failure then succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 1000 });

    // First attempt fails, wait for backoff (1000 * 2^0 = 1000ms)
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries up to maxRetries times then throws", async () => {
    const error = new Error("persistent failure");
    const fn = vi.fn().mockRejectedValue(error);

    // Attach the rejection handler immediately to prevent unhandled rejection
    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 1000 }).catch((e) => e);

    // Advance through backoff delays: 1000ms (attempt 0→1), then 2000ms (attempt 1→2)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("persistent failure");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry when shouldRetry returns false", async () => {
    const error = new Error("non-retryable");
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 1000,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow("non-retryable");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses exponential backoff delays", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 500 });

    // First backoff: 500 * 2^0 = 500ms
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(2);

    // Second backoff: 500 * 2^1 = 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(3);

    const result = await promise;
    expect(result).toBe("ok");
  });

  it("with maxRetries=0 does not retry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(
      withRetry(fn, { maxRetries: 0, baseDelayMs: 1000 }),
    ).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientRpcError", () => {
  it("returns true for network-level errors", () => {
    expect(isTransientRpcError(new Error("Failed to fetch"))).toBe(true);
    expect(isTransientRpcError(new Error("NetworkError when attempting"))).toBe(true);
    expect(isTransientRpcError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientRpcError(new Error("timeout exceeded"))).toBe(true);
  });

  it("returns true for 5xx status errors", () => {
    expect(isTransientRpcError(new Error("Request failed with status 500"))).toBe(true);
    expect(isTransientRpcError(new Error("502 Bad Gateway"))).toBe(true);
    expect(isTransientRpcError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isTransientRpcError(new Error("504 Gateway Timeout"))).toBe(true);
  });

  it("returns true for 429 rate limiting", () => {
    expect(isTransientRpcError(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("returns false for Postgres constraint violations", () => {
    const uniqueViolation = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(isTransientRpcError(uniqueViolation)).toBe(false);

    const fkViolation = Object.assign(new Error("foreign key"), { code: "23503" });
    expect(isTransientRpcError(fkViolation)).toBe(false);
  });

  it("returns false for syntax/access errors", () => {
    const syntaxError = Object.assign(new Error("syntax error"), { code: "42601" });
    expect(isTransientRpcError(syntaxError)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isTransientRpcError(null)).toBe(false);
    expect(isTransientRpcError(undefined)).toBe(false);
  });

  it("returns false for generic non-transient errors", () => {
    expect(isTransientRpcError(new Error("Unauthorized"))).toBe(false);
    expect(isTransientRpcError(new Error("Bad Request"))).toBe(false);
  });
});
