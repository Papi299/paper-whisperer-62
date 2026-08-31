// Shared Gemini provider transport — AI-PROVIDER-RESILIENCE-001A.
//
// ## TEMPORARY DIAGNOSTIC POLICY — AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A
//
// This module is currently running a temporary Production diagnostic policy of
// a 90-second per-attempt timeout with ZERO retries. That is NOT the
// established policy and is NOT intended to ship permanently.
//
//   * The established policy, in force before this experiment and to be
//     restored after it, is a 30-second per-attempt timeout with two bounded
//     retries (backoff 2 s then 4 s).
//
//   * The question the experiment answers: on the real authenticated
//     Production path, an Analyze and a Suggest request each reached our own
//     30 s client-side ceiling (`provider_timeout attempt=1 elapsed_ms=30004
//     retry=0`) while controlled direct probes of the same model completed the
//     same PaperLume-shaped contracts in ~5-13 s. Does such a request
//     eventually return a valid response, a provider HTTP failure, or still
//     nothing at all, when allowed to run for up to 90 s?
//
//   * Zero retries is not incidental to the diagnostic, it is required by it.
//     At a 90 s ceiling, retaining two retries would permit
//     90 + 2 + 90 + 4 + 90 = 276 s, well past the documented 150-second
//     request envelope. At zero retries the worst case is a single 90 s wait,
//     and one user action can make at most one Gemini generation request — so
//     the experiment also cannot distort the provider's request counter.
//     Removing retries does not hide the failure being investigated: both
//     Production failures already consisted of exactly one provider attempt.
//
//   * This is deliberately two constants and nothing else — no env-var
//     timeout, no model-specific branch, no total-budget redesign. REVERT both
//     constants to 30_000 / 2 once the bounded Production experiment has run,
//     whatever its result.
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
// provider-call sequence here; the caller refunds the Paperlume unit and
// returns its existing neutral provider-unavailable failure.
//
// An explicit 429 or 5xx is the opposite case: the provider answered, and its
// answer was "not now". Those normally keep the bounded retry budget — but that
// budget is temporarily 0 for the diagnostic above, so during the experiment a
// 429 or 5xx is also returned after a single attempt.
//
// ## Duration budget
//
// Supabase currently documents a 150 s Free-plan wall-clock limit and a 150 s
// request idle timeout for hosted Edge Functions. Under this temporary policy
// the worst case is ONE 90 s attempt with no backoff, so the transport cannot
// spend more than 90 s inside that 150 s envelope.
//
// Under the established policy the worst case was three full attempts separated
// by the two backoffs — 30 + 2 + 30 + 4 + 30 = 96 s.

/**
 * Per-attempt provider timeout.
 *
 * TEMPORARY — AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A. The established policy is
 * 30 s (raised from 15 s: see the header); this is raised to 90 s only for the
 * bounded Production diagnostic described above, and must be restored to
 * 30_000 when that experiment ends.
 */
export const GEMINI_PROVIDER_TIMEOUT_MS = 90_000;
/**
 * Retries *after* the first attempt, for explicitly retriable outcomes only.
 *
 * TEMPORARY — AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A. The established policy is
 * 2. Zero is required for the diagnostic window: at a 90 s per-attempt ceiling,
 * keeping two retries would allow 90 + 2 + 90 + 4 + 90 = 276 s, far past the
 * documented 150 s request envelope. At 0 the worst case is a single 90 s wait,
 * and one user action can make at most one Gemini generation request — which is
 * also the cleaner experiment. Restore to 2 when the experiment ends.
 *
 * While this is 0, the 429/5xx and ordinary-network retry semantics described
 * in the header and implemented below are reachable code but temporarily
 * inert: every outcome resolves on attempt 1 and no backoff is ever slept.
 */
export const GEMINI_PROVIDER_MAX_RETRIES = 0;
/**
 * Backoff base: first retry 2 s, second 4 s. Unchanged by the diagnostic, but
 * unreachable while `GEMINI_PROVIDER_MAX_RETRIES` is 0.
 */
export const GEMINI_PROVIDER_BASE_DELAY_MS = 2_000;
/**
 * Ceiling applied to a `Retry-After` the provider asks for. Unchanged by the
 * diagnostic, but unreachable while `GEMINI_PROVIDER_MAX_RETRIES` is 0.
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
 * Retries 429 and 5xx (honouring a bounded `Retry-After` on 429) and ordinary
 * network failures, up to `GEMINI_PROVIDER_MAX_RETRIES`. Does NOT retry a
 * timeout — see the header — and does not retry any other 4xx, which is a
 * statement about the request rather than about the provider's availability.
 *
 * TEMPORARY: `GEMINI_PROVIDER_MAX_RETRIES` is 0 for the diagnostic in the
 * header, so every outcome — retriable or not — currently resolves on attempt 1
 * and no backoff is slept. The retry branches below are retained unchanged so
 * restoring the constant restores the established policy exactly.
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
