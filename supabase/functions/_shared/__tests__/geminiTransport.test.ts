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
 *   1. the per-attempt ceiling is not 15 s;
 *   2. reaching that ceiling ends the sequence — one provider request, no sleep.
 *
 * ## TEMPORARY — AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A
 *
 * The transport is running a temporary Production diagnostic policy: a
 * 90-second per-attempt ceiling with ZERO retries. This suite is therefore
 * pinned to the DIAGNOSTIC policy, not to the established one.
 *
 * The established policy — 30 s with two bounded retries, backoff 2 s then
 * 4 s — is to be restored when the experiment ends, at which point the
 * assertions marked TEMPORARY below revert with it. Where a diagnostic
 * assertion replaces a production semantic (a 429 or a 5xx used to buy a
 * retry), the production semantic is named in the comment rather than deleted,
 * so what is temporarily disabled stays legible.
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
  it("TEMPORARY: uses the 90-second diagnostic per-attempt timeout", async () => {
    // Established policy: 30_000. Raised for AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A
    // because Production reached our own 30 s ceiling (elapsed_ms=30004) on a
    // path that completes in ~5-13 s under a controlled direct probe. Still far
    // above the 18,056 ms success that ruled out the original 15 s ceiling.
    expect(GEMINI_PROVIDER_TIMEOUT_MS).toBe(90_000);
    expect(GEMINI_PROVIDER_TIMEOUT_MS).toBeGreaterThan(18_056);
  });

  it("TEMPORARY: allows no retry at all during the diagnostic", () => {
    // Established policy: 2. Zero is what keeps a 90 s attempt inside the
    // request envelope, and what holds one user action to at most one Gemini
    // generation request for the duration of the experiment.
    expect(GEMINI_PROVIDER_MAX_RETRIES).toBe(0);
  });

  it("leaves the backoff base and Retry-After ceiling untouched", () => {
    // Not part of the diagnostic. They are unreachable while retries are 0, and
    // must still be the established values when the retry budget is restored.
    expect(GEMINI_PROVIDER_BASE_DELAY_MS).toBe(2_000);
    expect(GEMINI_PROVIDER_MAX_RETRY_AFTER_MS).toBe(10_000);
  });

  it("TEMPORARY: bounds the worst-case provider wait to a single 90-second attempt", () => {
    // With no retry permitted there is exactly one attempt and no backoff, so
    // the worst case IS the per-attempt ceiling. (The established policy's worst
    // case was three attempts plus two backoffs: 30 + 2 + 30 + 4 + 30 = 96 s.)
    const attempts = GEMINI_PROVIDER_MAX_RETRIES + 1;
    const backoffMs = Array.from(
      { length: GEMINI_PROVIDER_MAX_RETRIES },
      (_unused, i) => GEMINI_PROVIDER_BASE_DELAY_MS * Math.pow(2, i),
    ).reduce((a, b) => a + b, 0);

    expect(attempts).toBe(1);
    expect(backoffMs).toBe(0);

    const worstCaseMs = attempts * GEMINI_PROVIDER_TIMEOUT_MS + backoffMs;
    expect(worstCaseMs).toBe(90_000);
  });

  it("keeps the diagnostic policy below the documented 150 s Edge request idle ceiling", () => {
    // Supabase documents a 150 s request idle timeout for hosted Edge Functions.
    // Asserted against the Free-plan figure only — no paid-plan headroom is
    // assumed anywhere in this suite.
    const DOCUMENTED_REQUEST_IDLE_CEILING_MS = 150_000;
    const worstCaseMs =
      (GEMINI_PROVIDER_MAX_RETRIES + 1) * GEMINI_PROVIDER_TIMEOUT_MS +
      Array.from(
        { length: GEMINI_PROVIDER_MAX_RETRIES },
        (_unused, i) => GEMINI_PROVIDER_BASE_DELAY_MS * Math.pow(2, i),
      ).reduce((a, b) => a + b, 0);

    expect(worstCaseMs).toBeLessThan(DOCUMENTED_REQUEST_IDLE_CEILING_MS);
    // The naive change — 90 s while keeping two retries — would have been
    // 90 + 2 + 90 + 4 + 90 = 276 s, and is what zero retries exists to prevent.
    expect(3 * GEMINI_PROVIDER_TIMEOUT_MS + 6_000).toBeGreaterThan(
      DOCUMENTED_REQUEST_IDLE_CEILING_MS,
    );
  });
});

// ── 2. The timeout is terminal ────────────────────────────────────────────

describe("a provider timeout is terminal", () => {
  it("TEMPORARY: arms the attempt with the 90-second diagnostic timeout", async () => {
    const harness = makeHarness([ok()]);
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.signalTimeouts).toEqual([90_000]);
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
    // Exactly one signal, armed for the diagnostic ceiling.
    expect(harness.signalTimeouts).toEqual([90_000]);
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

  it("TEMPORARY: cannot reach a later attempt at all, so a 503 never buys one", async () => {
    // Established policy: a 503 bought attempt 2, and a timeout THERE still
    // ended the sequence rather than spending the third. With the diagnostic
    // retry budget of 0 the 503 itself is terminal, so the queued timeout is
    // never consumed and there is no second attempt to time out.
    const harness = makeHarness([new Response("", { status: 503 }), timeoutError()]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
    expect(result).toEqual({ ok: false, kind: "http", status: 503, attempts: 1 });
  });

  it("logs a terminal timeout as retry=0 and never claims a retry is scheduled", async () => {
    const harness = makeHarness([timeoutError()], { elapsedPerAttempt: 90_000 });
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.warns).toEqual([
      "test-fn provider_timeout attempt=1 elapsed_ms=90000 retry=0",
    ]);
    expect(harness.warns.join("\n")).not.toContain("retry_in_ms");
    expect(harness.warns.join("\n")).not.toContain("retry=1");
  });
});

// ── 3. Retriable HTTP statuses get no retry during the diagnostic ─────────

/**
 * TEMPORARY — AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A.
 *
 * PRODUCTION SEMANTICS, TEMPORARILY DISABLED BY `GEMINI_PROVIDER_MAX_RETRIES = 0`:
 * a 429 or a 5xx means the provider answered "not now", so under the
 * established policy each bought up to two further attempts, separated by a
 * 2 s then 4 s backoff, with a bounded `Retry-After` honoured on a 429. None of
 * that code is removed — it is simply unreachable at a retry budget of 0, and
 * comes back when the constant is restored to 2.
 *
 * What must hold *during* the diagnostic is that a retriable status costs
 * exactly one provider request and no sleep, so a single user action can never
 * make more than one Gemini generation request while the ceiling is 90 s.
 */
describe("retriable HTTP statuses during the diagnostic", () => {
  it("TEMPORARY: returns a 429 after exactly one provider attempt, with no backoff", async () => {
    // A second queued 429 proves the count is enforced rather than starved: it
    // is never consumed.
    const harness = makeHarness([
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
    ]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
    expect(harness.signalTimeouts).toEqual([90_000]);
    expect(result).toEqual({ ok: false, kind: "http", status: 429, attempts: 1 });
  });

  it("TEMPORARY: returns a 5xx after exactly one provider attempt, with no backoff", async () => {
    const harness = makeHarness([
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    ]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
    expect(harness.signalTimeouts).toEqual([90_000]);
    expect(result).toEqual({ ok: false, kind: "http", status: 503, attempts: 1 });
  });

  it("TEMPORARY: a queued success after a 5xx is never reached, because there is no retry", async () => {
    // Established policy returned ok on attempt 2 here. The diagnostic gives up
    // on the 500 instead — an accepted cost of the bounded experiment.
    const harness = makeHarness([new Response("", { status: 500 }), ok({ candidates: [1] })]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(result).toEqual({ ok: false, kind: "http", status: 500, attempts: 1 });
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
  });

  it("TEMPORARY: does not sleep on a Retry-After it can no longer act on", async () => {
    // The Retry-After parsing and its 10 s cap are untouched by this task; they
    // are simply never consulted, because no second attempt exists to schedule.
    const harness = makeHarness([
      new Response("", { status: 429, headers: { "Retry-After": "7" } }),
      ok(),
    ]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.sleeps).toEqual([]);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, kind: "http", status: 429 });
  });

  it("TEMPORARY: logs a retriable status as retry=0 and never promises a retry", async () => {
    const harness = makeHarness([new Response("", { status: 503 }), ok()], {
      elapsedPerAttempt: 1_200,
    });
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.warns).toEqual([
      "test-fn provider_status=503 attempt=1 elapsed_ms=1200 retry=0",
    ]);
    expect(harness.warns.join("\n")).not.toContain("retry_in_ms");
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

/**
 * TEMPORARY — AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A.
 *
 * PRODUCTION SEMANTICS, TEMPORARILY DISABLED: an ordinary (non-timeout) network
 * failure kept the same bounded retry budget as a 5xx — up to three attempts
 * separated by a 2 s then 4 s backoff. At a retry budget of 0 it ends on the
 * first attempt like everything else. The distinct `network` kind and its
 * separate log line are unaffected.
 */
describe("non-timeout network failures during the diagnostic", () => {
  it("TEMPORARY: makes exactly one provider attempt and never sleeps", async () => {
    const harness = makeHarness([
      new Error("connection reset"),
      new Error("connection reset"),
    ]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
    expect(harness.signalTimeouts).toEqual([90_000]);
    expect(result).toEqual({ ok: false, kind: "network", attempts: 1 });
  });

  it("TEMPORARY: a queued success after a network blip is never reached", async () => {
    const harness = makeHarness([new Error("connection reset"), ok()]);
    const result = await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(result).toEqual({ ok: false, kind: "network", attempts: 1 });
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is still reported separately from a timeout in the logs", async () => {
    const harness = makeHarness([new Error("connection reset"), ok()], { elapsedPerAttempt: 50 });
    await callGeminiWithRetry(URL, INIT, harness.deps);
    expect(harness.warns).toEqual([
      "test-fn provider_network_error attempt=1 elapsed_ms=50 retry=0",
    ]);
    expect(harness.warns.join("\n")).not.toContain("retry_in_ms");
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
