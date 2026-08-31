// @vitest-environment node
//
// The transport uses the platform web APIs Deno provides. jsdom does not
// implement `AbortSignal.timeout`, so under the project's default environment
// the default signal factory would throw before `fetch` was reached and every
// assertion below would be measuring jsdom rather than this module. Node 22
// provides the same `AbortSignal.timeout`, `Request` and `Response` the Edge
// runtime does. (Same reason as suggest-paper-organization/__tests__.)
import { describe, it, expect, vi } from "vitest";
import {
  callGeminiWithRetry,
  GEMINI_PROVIDER_BASE_DELAY_MS,
  GEMINI_PROVIDER_MAX_RETRIES,
  GEMINI_PROVIDER_MAX_RETRY_AFTER_MS,
  GEMINI_PROVIDER_TIMEOUT_MS,
  type GeminiTransportDeps,
} from "../geminiTransport.ts";

/**
 * AI-PROVIDER-RESILIENCE-001A — the shared Gemini transport.
 *
 * The incident this suite pins down: on 2026-08-31 a single
 * `suggest-paper-organization` invocation timed out at 15 s, automatically
 * re-sent the generation 2 s later, succeeded — and cost the Google project TWO
 * requests for ONE user action. A separate controlled probe of the shipped
 * model returned a valid HTTP 200 after 18,056 ms, so the 15 s ceiling was also
 * killing responses that were on their way.
 *
 * Two properties therefore have to hold, and both are asserted by *counting the
 * fetches*, not by reading the code:
 *
 *   1. the per-attempt ceiling is 30 s, not 15 s;
 *   2. reaching that ceiling ends the sequence — one provider request, no sleep.
 *
 * Nothing here waits on real time: the timeout duration is asserted through an
 * injected signal factory, and backoff through an injected `sleep`.
 */

const URL = "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent";
const INIT: RequestInit = {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-goog-api-key": "SENTINEL-GEMINI-API-KEY" },
  body: JSON.stringify({ contents: [] }),
};

interface Harness {
  deps: GeminiTransportDeps;
  fetchImpl: ReturnType<typeof vi.fn>;
  sleeps: number[];
  warns: string[];
  signalTimeouts: number[];
  /** Abort controllers handed to `fetchImpl`, newest last. */
  controllers: AbortController[];
}

/** The `DOMException` shape `AbortSignal.timeout` actually rejects with. */
function timeoutError(): unknown {
  return Object.assign(new Error("Signal timed out."), { name: "TimeoutError" });
}

function abortError(): unknown {
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

/**
 * Build a harness whose queued outcomes are consumed one per attempt.
 *
 * A queued `Error` is thrown by `fetchImpl` (network/timeout); a queued
 * `Response` is returned. `elapsedPerAttempt` advances the injected clock inside
 * each attempt so `elapsed_ms=` is deterministic.
 */
function makeHarness(
  outcomes: Array<Response | Error | unknown>,
  options: { elapsedPerAttempt?: number; abortSignalOnTimeout?: boolean } = {},
): Harness {
  const sleeps: number[] = [];
  const warns: string[] = [];
  const signalTimeouts: number[] = [];
  const controllers: AbortController[] = [];
  const queue = [...outcomes];

  let clock = 0;
  const elapsed = options.elapsedPerAttempt ?? 0;

  const fetchImpl = vi.fn(async () => {
    const next = queue.shift();
    clock += elapsed;
    if (next === undefined) throw new Error("no provider outcome configured");
    if (next instanceof Response) return next.clone();
    // A queued throwable that is an abort is delivered with the signal already
    // aborted, exactly as a real runtime would.
    if (options.abortSignalOnTimeout) controllers[controllers.length - 1]?.abort();
    throw next;
  });

  return {
    deps: {
      label: "test-fn",
      fetchImpl: fetchImpl as unknown as GeminiTransportDeps["fetchImpl"],
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      createTimeoutSignal: (ms: number) => {
        signalTimeouts.push(ms);
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      },
      now: () => clock,
      logger: { warn: (m: string) => warns.push(m) },
    },
    fetchImpl,
    sleeps,
    warns,
    signalTimeouts,
    controllers,
  };
}

function ok(body: unknown = { candidates: [] }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── 1. The policy constants ───────────────────────────────────────────────

describe("provider policy constants", () => {
  it("uses a 30-second per-attempt timeout, not the 15 seconds that cut Production responses short", () => {
    // A controlled probe of the shipped model returned a valid 200 at 18,056 ms.
    expect(GEMINI_PROVIDER_TIMEOUT_MS).toBe(30_000);
    expect(GEMINI_PROVIDER_TIMEOUT_MS).toBeGreaterThan(18_056);
  });

  it("keeps the existing bounded retry budget and backoff base", () => {
    expect(GEMINI_PROVIDER_MAX_RETRIES).toBe(2);
    expect(GEMINI_PROVIDER_BASE_DELAY_MS).toBe(2_000);
    expect(GEMINI_PROVIDER_MAX_RETRY_AFTER_MS).toBe(10_000);
  });

  it("stays inside the documented 150 s Supabase Edge wall-clock/idle limit at its worst case", () => {
    // Three full attempts plus the two backoffs — the ceiling reachable only if
    // the provider answers 5xx just shy of the timeout twice running. A timeout
    // cannot contribute to this, because a timeout ends the sequence.
    const worstCaseMs =
      (GEMINI_PROVIDER_MAX_RETRIES + 1) * GEMINI_PROVIDER_TIMEOUT_MS +
      GEMINI_PROVIDER_BASE_DELAY_MS +
      GEMINI_PROVIDER_BASE_DELAY_MS * 2;
    expect(worstCaseMs).toBe(96_000);
    expect(worstCaseMs).toBeLessThan(150_000);
  });
});

// ── 2. The timeout is terminal ────────────────────────────────────────────

describe("a provider timeout is terminal", () => {
  it("arms every attempt with the 30-second timeout", async () => {
    const harness = makeHarness([ok()]);
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.signalTimeouts).toEqual([30_000]);
  });

  it("passes the timeout signal to fetch", async () => {
    const harness = makeHarness([ok()]);
    await callGeminiWithRetry(URL, INIT, harness.deps);
    const init = harness.fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(harness.controllers[0].signal);
    // The caller's own init survives.
    expect(init.method).toBe("POST");
    expect(init.body).toBe(INIT.body);
  });

  it("issues exactly ONE provider request when the attempt times out", async () => {
    // The whole point of 001A: Production counted two Gemini requests for one
    // user action because this path used to retry.
    const harness = makeHarness([timeoutError()]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, kind: "timeout", attempts: 1 });
  });

  it("does not sleep after a timeout", async () => {
    const harness = makeHarness([timeoutError()]);
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.sleeps).toEqual([]);
  });

  it("does not arm a second timeout signal after a timeout", async () => {
    const harness = makeHarness([timeoutError()]);
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.signalTimeouts).toEqual([30_000]);
  });

  it("treats an AbortError raised while our own signal is aborted as the timeout", async () => {
    // Runtimes differ on whether an aborted fetch surfaces TimeoutError or
    // AbortError. Misreading the second spelling would silently restore the
    // duplicate-request behaviour, so it must not retry either.
    const harness = makeHarness([abortError()], { abortSignalOnTimeout: true });
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(result).toEqual({ ok: false, kind: "timeout", attempts: 1 });
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
  });

  it("still recognises a timeout thrown as a bare object with no Error prototype", async () => {
    const harness = makeHarness([{ name: "TimeoutError", message: "timed out" }]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ kind: "timeout" });
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("times out terminally on a later attempt too, without a further retry", async () => {
    // A 503 legitimately buys a second attempt; if THAT one times out, the
    // sequence still ends there rather than spending the third.
    const harness = makeHarness([new Response("", { status: 503 }), timeoutError()]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
    expect(harness.sleeps).toEqual([2_000]);
    expect(result).toEqual({ ok: false, kind: "timeout", attempts: 2 });
  });

  it("logs a terminal timeout as retry=0 and never claims a retry is scheduled", async () => {
    const harness = makeHarness([timeoutError()], { elapsedPerAttempt: 30_000 });
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.warns).toEqual([
      "test-fn provider_timeout attempt=1 elapsed_ms=30000 retry=0",
    ]);
    expect(harness.warns.join("\n")).not.toContain("retry_in_ms");
    expect(harness.warns.join("\n")).not.toContain("retry=1");
  });
});

// ── 3. Explicit retriable HTTP statuses keep their budget ─────────────────

describe("retriable HTTP statuses", () => {
  it("retries a persistent 503 up to the existing bound and no further", async () => {
    const harness = makeHarness([
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    ]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(3);
    expect(harness.sleeps).toEqual([2_000, 4_000]);
    expect(result).toEqual({ ok: false, kind: "http", status: 503, attempts: 3 });
  });

  it("retries a persistent 429 up to the existing bound", async () => {
    const harness = makeHarness([
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
    ]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(3);
    expect(harness.sleeps).toEqual([2_000, 4_000]);
    expect(result).toMatchObject({ ok: false, kind: "http", status: 429 });
  });

  it("recovers when a retry succeeds", async () => {
    const harness = makeHarness([new Response("", { status: 500 }), ok({ candidates: [1] })]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(result.ok).toBe(true);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(result.attempts).toBe(2);
      expect(await result.response.json()).toEqual({ candidates: [1] });
    }
  });

  it("honours a bounded Retry-After on a 429", async () => {
    const harness = makeHarness([
      new Response("", { status: 429, headers: { "Retry-After": "7" } }),
      ok(),
    ]);
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.sleeps).toEqual([7_000]);
  });

  it("caps an outsized Retry-After rather than obeying it", async () => {
    const harness = makeHarness([
      new Response("", { status: 429, headers: { "Retry-After": "600" } }),
      ok(),
    ]);
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.sleeps).toEqual([GEMINI_PROVIDER_MAX_RETRY_AFTER_MS]);
  });

  it("ignores a nonsensical Retry-After and falls back to the backoff", async () => {
    const harness = makeHarness([
      new Response("", { status: 429, headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" } }),
      ok(),
    ]);
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.sleeps).toEqual([2_000]);
  });

  it("logs a retried status with the retry it is actually about to make", async () => {
    const harness = makeHarness([new Response("", { status: 503 }), ok()], {
      elapsedPerAttempt: 1_200,
    });
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.warns).toEqual([
      "test-fn provider_status=503 attempt=1 elapsed_ms=1200 retry=1 retry_in_ms=2000",
    ]);
  });
});

// ── 4. Non-retriable HTTP ─────────────────────────────────────────────────

describe("non-retriable HTTP statuses", () => {
  it.each([400, 401, 403, 404, 422])("returns a %d immediately without a retry", async (status) => {
    const harness = makeHarness([new Response("", { status })]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
    expect(result).toEqual({ ok: false, kind: "http", status, attempts: 1 });
  });
});

// ── 5. Non-timeout network failures ───────────────────────────────────────

describe("non-timeout network failures", () => {
  it("keeps the existing bounded retry behaviour", async () => {
    const harness = makeHarness([
      new Error("connection reset"),
      new Error("connection reset"),
      new Error("connection reset"),
    ]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(3);
    expect(harness.sleeps).toEqual([2_000, 4_000]);
    expect(result).toEqual({ ok: false, kind: "network", attempts: 3 });
  });

  it("recovers when a retry succeeds", async () => {
    const harness = makeHarness([new Error("connection reset"), ok()]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(result.ok).toBe(true);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("is reported separately from a timeout in the logs", async () => {
    const harness = makeHarness([new Error("connection reset"), ok()], { elapsedPerAttempt: 50 });
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.warns).toEqual([
      "test-fn provider_network_error attempt=1 elapsed_ms=50 retry=1 retry_in_ms=2000",
    ]);
  });
});

// ── 6. Success ────────────────────────────────────────────────────────────

describe("success", () => {
  it("returns on the first attempt and never retries", async () => {
    const harness = makeHarness([ok({ candidates: [{ content: {} }] })]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
    expect(harness.warns).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(1);
  });

  it("hands the body back unread so the caller keeps its own malformed-success policy", async () => {
    // A 2xx carrying junk is NOT a transport failure and must not be retried
    // here; the caller decides what an unusable body means.
    const harness = makeHarness([new Response("not json at all", { status: 200 })]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(result.ok).toBe(true);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.response.bodyUsed).toBe(false);
      await expect(result.response.json()).rejects.toBeDefined();
    }
  });
});

// ── 7. Log hygiene ────────────────────────────────────────────────────────

describe("log hygiene", () => {
  it("never logs the key, the URL, or the provider's body", async () => {
    const harness = makeHarness([
      new Response("Google says: project 12345 quota exhausted for model X", { status: 429 }),
      new Response("Google says: project 12345 quota exhausted for model X", { status: 429 }),
      new Response("Google says: project 12345 quota exhausted for model X", { status: 429 }),
    ]);
    await callGeminiWithRetry(URL, INIT, harness.deps);
    const all = harness.warns.join("\n");
    expect(all).toContain("provider_status=429");
    for (const secret of [
      "SENTINEL-GEMINI-API-KEY",
      "project 12345",
      "Google says",
      "generativelanguage.googleapis.com",
      "x-goog-api-key",
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it("is silent when no logger is supplied", async () => {
    const harness = makeHarness([timeoutError()]);
    const result = await callGeminiWithRetry(URL, INIT, { ...harness.deps, logger: undefined });
    expect(result).toMatchObject({ kind: "timeout" });
  });
});
