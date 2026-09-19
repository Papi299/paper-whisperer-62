// Shared Gemini provider transport — AI-PROVIDER-RESILIENCE-001A.
//
// ## Gemini transport policy: 90 s per attempt, ZERO automatic retries (C46)
//
// This is PaperLume's permanent, owner-adopted policy for Gemini, not an
// experiment and not a value awaiting restoration. One user action makes at
// most ONE Gemini generation request:
//
//   * The per-attempt ceiling is 90 seconds. A request that has not answered by
//     then is abandoned, and the sequence ends.
//
//   * The retry budget is zero. Timeout, ordinary network failure, HTTP 429 and
//     HTTP 5xx all return after that single provider attempt. No backoff is
//     ever slept, because there is never a second attempt to sleep before.
//
//   * The caller keeps its existing quota/refund semantics unchanged. Handling
//     a provider failure is the caller's job; retrying is deliberately not part
//     of this transport's policy.
//
//   * This policy is Gemini-specific. `anthropicAiProvider.ts` and
//     `openAiProvider.ts` own their own independent timeout constants and do
//     not inherit these. A shared ADAPTER contract is asserted across providers
//     (C39); a shared TRANSPORT policy deliberately is not.
//
// Changing either constant is a new reviewed policy decision, not a tuning
// exercise — see "Why zero retries" below for what a non-zero budget would
// reintroduce.
//
// Pure module (no Deno APIs, no remote imports): the analyze-paper and
// suggest-paper-organization Edge Functions (Deno) call it with the real
// `fetch`, and Vitest (Node) exercises the exact same code with an injected
// one. Every transport decision the two functions make now lives here, so they
// cannot drift apart in how long they wait for Google or how often they ask.
//
// ## Why a timeout is terminal
//
// This module previously existed as two copies with a 15 s per-attempt timeout
// that retried on abort. Production established both halves of that policy to
// be wrong:
//
//   * A controlled probe of the shipped model/configuration returned a valid
//     HTTP 200 after 18,056 ms — comfortably past the old 15 s ceiling. The
//     timeout was killing responses Google was about to deliver.
//
//   * On 2026-08-31T03:25:38Z a single `suggest-paper-organization` invocation
//     logged `provider_timeout attempt=1 retry_in_ms=2000`, retried, and
//     succeeded ~10 s later. Google's request counter moved by TWO for that one
//     user action.
//
// A client-side timeout says only that *we* stopped waiting. It is not evidence
// that Google stopped generating, so automatically re-sending is how one user
// action becomes two provider requests — and, on a busy provider, how a
// rate-limited project rate-limits itself further. A timeout therefore ends the
// provider-call sequence here; the caller then invokes its existing
// best-effort refund path and returns its existing neutral
// provider-unavailable failure. This module performs no quota mutation of its
// own, and a refund-side failure never replaces the provider failure.
//
// ## Why zero retries, including for 429 and 5xx
//
// An explicit 429 or 5xx is not the timeout case: the provider answered, and its
// answer was "not now". Under the policy this module used to run, those kept a
// bounded retry budget. They no longer do, for two reasons:
//
//   * Duration. At a 90 s per-attempt ceiling, two retries would permit
//     90 + 2 + 90 + 4 + 90 = 276 s, well past the documented 150-second request
//     envelope. Ninety seconds and two retries cannot both be had.
//
//   * Duplicate generation work. PaperLume's caller-side quota/refund
//     semantics already handle a provider failure separately: the caller
//     invokes its existing best-effort refund path and returns a neutral
//     provider-unavailable failure. Surfacing that failure after one attempt is
//     preferred to automatically creating a second generation request on the
//     user's behalf — re-generating is not the mechanism used to repair quota
//     accounting.
//
// ## How this policy was reached (history)
//
//   * The policy before this one was a 30 s per-attempt timeout with two bounded
//     retries (backoff 2 s then 4 s), itself a correction of the original 15 s.
//
//   * Production then showed 30 s cancelling requests that had not failed: an
//     Analyze and a Suggest request each hit our own client-side ceiling
//     (`provider_timeout attempt=1 elapsed_ms=30004 retry=0`) while controlled
//     direct probes of the same model completed the same PaperLume-shaped
//     contracts in ~5-13 s.
//
//   * That evidence motivated AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A, a bounded
//     Production experiment that raised the ceiling to 90 s and dropped the
//     retry budget to 0.
//
//   * On 2026-09-19 the owner adopted the experiment's behaviour as the durable
//     policy (C46). The 90 s / zero-retry values below are therefore current
//     policy, and the 30 s / two-retry values are history.
//
// ## Duration budget
//
// Supabase currently documents a 150 s Free-plan wall-clock limit and a 150 s
// request idle timeout for hosted Edge Functions. Under this policy the worst
// case is ONE 90 s attempt with no backoff, so the transport cannot spend more
// than 90 s inside that 150 s envelope.

/**
 * Per-attempt provider timeout — PaperLume's permanent Gemini policy (C46).
 *
 * Ninety seconds is the owner-adopted ceiling, not a temporary value. It
 * replaced 30 s (itself a correction of the original 15 s) after Production
 * showed the shorter ceiling cancelling Gemini requests that had not failed;
 * see the header for that evidence. Raising or lowering it is a new reviewed
 * policy decision.
 */
export const GEMINI_PROVIDER_TIMEOUT_MS = 90_000;
/**
 * Retries *after* the first attempt — permanently ZERO for Gemini (C46).
 *
 * Zero is the product contract, not a disabled setting: one user action makes
 * at most one Gemini generation request. At a 90 s per-attempt ceiling, two
 * retries would allow 90 + 2 + 90 + 4 + 90 = 276 s, far past the documented
 * 150 s request envelope, and would automatically create duplicate generation
 * work that PaperLume's caller-side quota/refund semantics already handle
 * separately, without a second provider request.
 *
 * Consequently the 429/5xx and ordinary-network retry branches implemented
 * below are DORMANT: they are intact, reachable-by-construction code that this
 * configured budget never enters, so every outcome resolves on attempt 1 and no
 * backoff is ever slept. They are kept rather than deleted so that the policy
 * lives in one constant. Giving Gemini a non-zero retry budget would require a
 * new reviewed policy decision — including a fresh duration-budget review,
 * since 90 s and two retries cannot both be had.
 */
export const GEMINI_PROVIDER_MAX_RETRIES = 0;
/**
 * Backoff base: first retry 2 s, second 4 s. Dormant — `GEMINI_PROVIDER_MAX_RETRIES`
 * is 0, so no backoff is ever slept under the current policy.
 */
export const GEMINI_PROVIDER_BASE_DELAY_MS = 2_000;
/**
 * Ceiling applied to a `Retry-After` the provider asks for. Dormant — parsing a
 * `Retry-After` only matters to a retry, and `GEMINI_PROVIDER_MAX_RETRIES` is 0.
 */
export const GEMINI_PROVIDER_MAX_RETRY_AFTER_MS = 10_000;

export type GeminiTransportFailureKind = "http" | "network" | "timeout";

/**
 * The outcome of one provider-call sequence.
 *
 * On success the raw `Response` is handed back unread: each caller keeps its own
 * body-handling and its own classification of a 2xx whose body is unusable, so
 * nothing about malformed-success behaviour changes here. On failure only a
 * coarse kind and a status code cross this boundary — never a body, never a
 * header, never a URL — because a Google error envelope can echo request content
 * and name the Google project.
 */
export type GeminiTransportResult =
  | { ok: true; response: Response; attempts: number }
  | { ok: false; kind: GeminiTransportFailureKind; status?: number; attempts: number };

export interface GeminiTransportLogger {
  warn(message: string): void;
}

export interface GeminiTransportDeps {
  /** Log prefix, e.g. `"suggest-organization"` or `"analyze-paper"`. */
  label: string;
  /** Injected so the retry/backoff policy is exercised by tests, not mocked around. */
  fetchImpl(url: string, init: RequestInit): Promise<Response>;
  /** Injected so tests never spend real wall-clock time on backoff. */
  sleep(ms: number): Promise<void>;
  /**
   * Injected so a test can assert the configured timeout without waiting 30 s
   * for it. Defaults to the platform `AbortSignal.timeout`, which is what both
   * Deno and Node 22 provide.
   */
  createTimeoutSignal?(ms: number): AbortSignal;
  /** Injected only so elapsed-time logging is deterministic under test. */
  now?(): number;
  logger?: GeminiTransportLogger;
}

/**
 * Read a throwable's `name` without assuming it is an `Error`.
 *
 * `AbortSignal.timeout` rejects with a `DOMException`, whose relationship to
 * `Error` has varied across runtimes and spec revisions. Getting this wrong in
 * the false direction would silently restore the duplicate-request behaviour
 * this module exists to remove, so the check is structural.
 */
function throwableName(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

/**
 * Did this attempt end at the per-attempt timeout?
 *
 * The signal passed to `fetchImpl` is the only abort source in this module, so
 * an `AbortError` raised while that signal is aborted is our timeout wearing a
 * different runtime's name. Both spellings are treated as a timeout: the cost of
 * a false positive is one non-retried network blip, the cost of a false negative
 * is the duplicate provider request that caused this task.
 */
function isTimeout(error: unknown, signal: AbortSignal): boolean {
  const name = throwableName(error);
  if (name === "TimeoutError") return true;
  return name === "AbortError" && signal.aborted;
}

/**
 * POST to Gemini with a finite per-attempt timeout and a bounded retry budget.
 *
 * The retry budget is `GEMINI_PROVIDER_MAX_RETRIES`, which is permanently 0 for
 * Gemini (C46). Under that policy EVERY outcome — timeout, ordinary network
 * failure, 429, 5xx and any other 4xx alike — resolves on attempt 1, and no
 * backoff is slept.
 *
 * The generic branches below still express what a non-zero budget would mean:
 * retry 429 and 5xx (honouring a bounded `Retry-After` on 429) and ordinary
 * network failures, never a timeout (see the header) and never any other 4xx,
 * which is a statement about the request rather than about the provider's
 * availability. They are dormant, and are kept intact rather than deleted so
 * that the policy lives in one constant; a non-zero budget is a new reviewed
 * policy decision.
 */
export async function callGeminiWithRetry(
  url: string,
  init: RequestInit,
  deps: GeminiTransportDeps,
): Promise<GeminiTransportResult> {
  const createTimeoutSignal = deps.createTimeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const now = deps.now ?? (() => Date.now());
  const warn = (message: string) => deps.logger?.warn(message);

  let attempts = 0;

  for (let attempt = 0; attempt <= GEMINI_PROVIDER_MAX_RETRIES; attempt++) {
    const attemptNumber = attempt + 1;
    const signal = createTimeoutSignal(GEMINI_PROVIDER_TIMEOUT_MS);
    const startedAt = now();
    attempts = attemptNumber;

    try {
      const response = await deps.fetchImpl(url, { ...init, signal });
      const elapsedMs = Math.max(0, now() - startedAt);

      if (response.ok) return { ok: true, response, attempts };

      const retriable = response.status === 429 || response.status >= 500;
      if (retriable && attempt < GEMINI_PROVIDER_MAX_RETRIES) {
        let delay = GEMINI_PROVIDER_BASE_DELAY_MS * Math.pow(2, attempt);
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("Retry-After"));
          if (Number.isFinite(retryAfter) && retryAfter > 0) {
            delay = Math.min(Math.max(retryAfter * 1000, delay), GEMINI_PROVIDER_MAX_RETRY_AFTER_MS);
          }
        }
        // Status, attempt and timing only. The provider's body is never read
        // here and never logged.
        warn(
          `${deps.label} provider_status=${response.status} attempt=${attemptNumber} ` +
            `elapsed_ms=${elapsedMs} retry=1 retry_in_ms=${delay}`,
        );
        await deps.sleep(delay);
        continue;
      }

      warn(
        `${deps.label} provider_status=${response.status} attempt=${attemptNumber} ` +
          `elapsed_ms=${elapsedMs} retry=0`,
      );
      return { ok: false, kind: "http", status: response.status, attempts };
    } catch (error) {
      const elapsedMs = Math.max(0, now() - startedAt);

      // A timeout ends the sequence. No sleep, no second generation request.
      if (isTimeout(error, signal)) {
        warn(
          `${deps.label} provider_timeout attempt=${attemptNumber} ` +
            `elapsed_ms=${elapsedMs} retry=0`,
        );
        return { ok: false, kind: "timeout", attempts };
      }

      if (attempt < GEMINI_PROVIDER_MAX_RETRIES) {
        const delay = GEMINI_PROVIDER_BASE_DELAY_MS * Math.pow(2, attempt);
        warn(
          `${deps.label} provider_network_error attempt=${attemptNumber} ` +
            `elapsed_ms=${elapsedMs} retry=1 retry_in_ms=${delay}`,
        );
        await deps.sleep(delay);
        continue;
      }

      warn(
        `${deps.label} provider_network_error attempt=${attemptNumber} ` +
          `elapsed_ms=${elapsedMs} retry=0`,
      );
      return { ok: false, kind: "network", attempts };
    }
  }

  // Unreachable: every path above either returns or is followed by another
  // iteration, and the last iteration cannot `continue`.
  return { ok: false, kind: "network", attempts };
}
