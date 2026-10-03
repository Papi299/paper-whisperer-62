/**
 * search-consensus — the complete request path, expressed without any runtime
 * binding.
 *
 * `index.ts` supplies the real Supabase client, the `CONSENSUS_API_KEY` reader
 * and `fetch`, and calls `Deno.serve`; every decision that matters lives here:
 * CORS-before-auth, method gating, the authoritative `auth.getUser()` check, the
 * server-side owner check, independent validation of the request, the
 * server-side key read, the single upstream call, safe error mapping and the
 * one bounded log line.
 *
 * The module uses **no** Deno API and **no** remote import, so the actual
 * handler — not a re-implementation of it — is exercised by Vitest with fake
 * clients and a fake `fetch`. Same split as `search-pubmed/handler.ts`.
 *
 * ## Owner-only, and authorized before anything can cost a Consensus call
 *
 * The connected Consensus key belongs to the owner's own Consensus account and
 * its monthly allowance is small and shared with the owner's MCP usage. So the
 * order below is load-bearing: the caller is authenticated, then their role is
 * read **as the caller** through `get_current_user_access()` and must be
 * exactly `"owner"` (a manager is refused), and only then is the key read and
 * the one upstream request made. A refused caller costs zero Consensus calls.
 * The role is never taken from the request: the body contract is the query and
 * nothing else.
 *
 * ## Exactly one upstream attempt
 *
 * Unlike `search-pubmed`, nothing here retries. Every Consensus request may
 * count against the owner's allowance, so a 429, a 5xx, a timeout or a network
 * failure is reported to the owner, who decides whether to press Search again.
 * Every 401 this function returns is produced **before** the key is read and
 * before the upstream call, which is what makes the client's one
 * refresh-and-retry on a PaperLume 401 free of Consensus cost. A 401 *from
 * Consensus* is a server configuration problem and is answered as a 502.
 *
 * ## Read-only
 *
 * It performs no insert, update, Project/Tag mutation or AI call. The owner's
 * selected DOIs are imported afterwards by the existing canonical importer.
 */

import {
  buildConsensusSearchUrl,
  classifyConsensusFailure,
  parseConsensusSearchResponse,
  validateConsensusSearchRequest,
  type ConsensusSearchPage,
} from "../_shared/consensusSearch.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

/** Per-request upstream timeout. Same 15s budget as the other provider calls. */
export const CONSENSUS_UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * The application-owned error codes this function answers with, their HTTP
 * status, and the only copy the browser ever receives for them. Consensus's
 * own error text, response bodies and headers are never forwarded.
 */
export const SEARCH_CONSENSUS_ERRORS = {
  method_not_allowed: { status: 405, message: "This endpoint accepts POST only." },
  unauthenticated: { status: 401, message: "You must be signed in to search Consensus." },
  forbidden: { status: 403, message: "Consensus search is not available for this account." },
  access_check_failed: {
    status: 500,
    message: "Your access could not be verified right now. Please try again.",
  },
  invalid_request: { status: 400, message: "That search could not be run." },
  not_configured: { status: 503, message: "Consensus search is not configured on the server yet." },
  quota_exhausted: {
    status: 429,
    message:
      "The connected Consensus API allowance has been used up. It resets or can be raised from the Consensus account.",
  },
  rate_limited: {
    status: 429,
    message: "Consensus is receiving requests too quickly. Please wait a moment and try again.",
  },
  consensus_unavailable: { status: 502, message: "Consensus search is unavailable right now. Please try again later." },
  upstream_unavailable: {
    status: 502,
    message: "Consensus could not be reached right now. Please try again in a moment.",
  },
  upstream_timeout: { status: 504, message: "Consensus took too long to respond. Please try again in a moment." },
  internal_error: { status: 500, message: "Something went wrong. Please try again." },
} as const;

export type SearchConsensusErrorCode = keyof typeof SEARCH_CONSENSUS_ERRORS;

// ── Injected dependencies ─────────────────────────────────────────────────

/** Minimal shape of the caller-scoped (anon key + caller bearer token) client. */
export interface CallerClient {
  auth: {
    getUser(): Promise<{
      data: { user: { id?: unknown } | null };
      error: unknown;
    }>;
  };
  rpc(fn: "get_current_user_access"): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface SearchConsensusDeps {
  /** Build a client bound to the caller's `Authorization` header. */
  createCallerClient(authHeader: string): CallerClient;
  /**
   * Read the server-side `CONSENSUS_API_KEY`. Called at most once per request,
   * and only after the caller has been authorized as the owner.
   */
  readApiKey(): string | undefined;
  /** The one upstream call. Injected so tests can count and inspect it. */
  fetchImpl(url: string, init: RequestInit): Promise<Response>;
  /** Injected so the timeout is asserted, not waited for. Defaults to `AbortSignal.timeout`. */
  timeoutSignal?(ms: number): AbortSignal;
  /** Injected so tests can assert exactly what is (and is not) logged. */
  logger?: { log(message: string): void; warn(message: string): void; error(message: string): void };
  /** Injected so the duration field in the log line is deterministic in tests. */
  now?(): number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fail(code: SearchConsensusErrorCode, message?: string): Response {
  const { status, message: defaultMessage } = SEARCH_CONSENSUS_ERRORS[code];
  return new Response(JSON.stringify({ error: code, message: message ?? defaultMessage }), {
    status,
    headers: jsonHeaders,
  });
}

function json(page: ConsensusSearchPage): Response {
  return new Response(JSON.stringify(page), { headers: jsonHeaders });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `AbortSignal.timeout` rejects with a `TimeoutError` DOMException in Deno and Node. */
function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

/** Longest 429 body prefix inspected for Consensus's documented allowance phrase. */
const RATE_LIMIT_BODY_PREFIX = 4096;

/**
 * The browser-facing code for each classified upstream failure. Credential,
 * billing and permission failures share one bounded "unavailable" answer: the
 * browser is never told whether the key was rejected, revoked or unpaid — the
 * owner reads the exact upstream status in the function log instead.
 */
const UPSTREAM_FAILURE_CODE = {
  upstream_auth: "consensus_unavailable",
  upstream_billing: "consensus_unavailable",
  upstream_forbidden: "consensus_unavailable",
  quota_exhausted: "quota_exhausted",
  rate_limited: "rate_limited",
  upstream_error: "upstream_unavailable",
  upstream_rejected: "upstream_unavailable",
} as const satisfies Record<ReturnType<typeof classifyConsensusFailure>, SearchConsensusErrorCode>;

// ── Handler ───────────────────────────────────────────────────────────────

export async function handleSearchConsensusRequest(
  req: Request,
  deps: SearchConsensusDeps,
): Promise<Response> {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  // 1. CORS preflight — answered before auth, and before anything else.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 2. POST only. Every other method is refused before the token is read.
  if (req.method !== "POST") {
    return fail("method_not_allowed");
  }

  const started = now();
  const record = (fields: Omit<SearchLogFields, "durationMs">, level: "log" | "warn" | "error" = "log") =>
    logSearch(logger, level, { ...fields, durationMs: now() - started });

  try {
    // 3. Bearer credential required.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      record({ outcome: "unauthenticated" });
      return fail("unauthenticated");
    }

    // 4. Authoritative authentication. `getUser()` is a network check against
    //    the Auth server, not a local decode.
    const caller = deps.createCallerClient(authHeader);
    const { data: userData, error: authError } = await caller.auth.getUser();
    const userId = userData?.user?.id;
    if (authError || typeof userId !== "string" || userId === "") {
      record({ outcome: "unauthenticated" });
      return fail("unauthenticated");
    }

    // 5. Authorization, server-side and as the caller. The SECURITY DEFINER RPC
    //    derives identity from auth.uid() only; its role is the sole authority.
    //    Exactly "owner" — a manager, an ordinary user, a missing row or a
    //    malformed answer are all refused. Nothing below this line runs for a
    //    refused caller: no body read, no key read, no upstream request.
    const { data: accessData, error: accessError } = await caller.rpc("get_current_user_access");
    if (accessError) {
      // The RPC's error text is not logged: only the bounded outcome.
      record({ outcome: "access_check_failed" }, "error");
      return fail("access_check_failed");
    }
    const accessRow = Array.isArray(accessData) ? accessData[0] : accessData;
    if (!isRecord(accessRow) || accessRow.role !== "owner") {
      record({ outcome: "forbidden" });
      return fail("forbidden");
    }

    // 6. Request validation, independent of whatever the client claims to send.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      record({ outcome: "invalid_request" });
      return fail("invalid_request", "A JSON request body is required.");
    }
    const validation = validateConsensusSearchRequest(body);
    if (!validation.ok) {
      record({ outcome: "invalid_request" });
      return fail("invalid_request", validation.message);
    }
    const { query } = validation.request;

    // 7. The server-side key. Read only now, after authorization. Never logged,
    //    never returned, never placed in a URL.
    const rawKey = deps.readApiKey();
    const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";
    if (apiKey === "") {
      record({ outcome: "not_configured", queryLength: query.length });
      return fail("not_configured");
    }

    // 8. The one upstream request. No retry on any outcome. `redirect: "error"`
    //    means the key header can never follow a redirect to another host.
    let response: Response;
    try {
      response = await deps.fetchImpl(buildConsensusSearchUrl(query), {
        method: "GET",
        headers: { "x-api-key": apiKey, Accept: "application/json" },
        redirect: "error",
        signal: timeoutSignal(CONSENSUS_UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      // The thrown value is not logged: a fetch error can quote the request
      // URL, and that URL carries the research query.
      const timedOut = isTimeout(error);
      record({ outcome: timedOut ? "upstream_timeout" : "upstream_network_error", queryLength: query.length }, "warn");
      return fail(timedOut ? "upstream_timeout" : "upstream_unavailable");
    }

    if (!response.ok) {
      let bodyPrefix = "";
      if (response.status === 429) {
        // Read only to tell the two documented 429s apart; then discarded.
        try {
          bodyPrefix = (await response.text()).slice(0, RATE_LIMIT_BODY_PREFIX);
        } catch {
          bodyPrefix = "";
        }
      } else {
        try {
          await response.body?.cancel();
        } catch {
          // Nothing to release.
        }
      }
      const failure = classifyConsensusFailure(response.status, bodyPrefix);
      record({ outcome: failure, queryLength: query.length, upstreamStatus: response.status }, "warn");
      return fail(UPSTREAM_FAILURE_CODE[failure]);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      const timedOut = isTimeout(error);
      record(
        {
          outcome: timedOut ? "upstream_timeout" : "malformed_response",
          queryLength: query.length,
          upstreamStatus: response.status,
        },
        "warn",
      );
      return fail(timedOut ? "upstream_timeout" : "upstream_unavailable");
    }

    const parsed = parseConsensusSearchResponse(payload);
    if (!parsed.ok) {
      record({ outcome: "malformed_response", queryLength: query.length, upstreamStatus: response.status }, "warn");
      return fail("upstream_unavailable");
    }

    record({
      outcome: "ok",
      queryLength: query.length,
      upstreamStatus: response.status,
      returned: parsed.results.length,
      importable: parsed.results.filter((result) => result.importDoi !== null).length,
      dropped: parsed.dropped,
    });
    return json({ results: parsed.results });
  } catch (error) {
    // Deliberately no free error text: an exception here may quote anything
    // the request carried. The one diagnosis that IS recorded is which
    // runtime-injected variable was missing, recognised only as the exact
    // message `requireEdgeEnv` writes for one of the two names this function
    // reads — so an operator can still tell a missing SUPABASE_URL from any
    // other failure, without the log ever carrying arbitrary text.
    record({ outcome: "internal_error", missingEnv: missingRuntimeEnv(error) }, "error");
    return fail("internal_error");
  }
}

/** The runtime-injected variables `index.ts` requires, by name. */
const RUNTIME_ENV_NAMES = ["SUPABASE_URL", "SUPABASE_ANON_KEY"] as const;

/** Which runtime variable `requireEdgeEnv` reported missing, if that is what this error is. */
function missingRuntimeEnv(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /^Missing required Edge Function environment variable: ([A-Z_]+)\./.exec(error.message);
  const name = match?.[1];
  return RUNTIME_ENV_NAMES.find((candidate) => candidate === name);
}

// ── The one log line ──────────────────────────────────────────────────────

interface SearchLogFields {
  outcome: string;
  /** Only ever one of {@link RUNTIME_ENV_NAMES}. */
  missingEnv?: string;
  queryLength?: number;
  upstreamStatus?: number;
  returned?: number;
  importable?: number;
  dropped?: number;
  durationMs: number;
}

/**
 * One structured line per request.
 *
 * A research query can reveal an unpublished research direction, a clinical
 * interest or a person's own diagnosis, so **the query text is never logged** —
 * only its length. Titles, abstracts, takeaways, authors, DOIs, Consensus URLs,
 * the request URL, the API key, the bearer token and every upstream body are
 * likewise absent: everything here is a length, a count, a status, a duration
 * or a bounded outcome label. `retry=0` is constant by design.
 */
function logSearch(
  logger: NonNullable<SearchConsensusDeps["logger"]>,
  level: "log" | "warn" | "error",
  fields: SearchLogFields,
): void {
  logger[level](
    `consensus-search outcome=${fields.outcome}${fields.missingEnv ? ` missing_env=${fields.missingEnv}` : ""} ` +
      `q_len=${fields.queryLength ?? "na"} ` +
      `upstream_status=${fields.upstreamStatus ?? "na"} returned=${fields.returned ?? 0} ` +
      `importable=${fields.importable ?? 0} dropped=${fields.dropped ?? 0} retry=0 ` +
      `duration_ms=${Math.max(0, Math.round(fields.durationMs))}`,
  );
}
