/**
 * search-pubmed — the complete request path, expressed without any runtime
 * binding.
 *
 * `index.ts` supplies the real Supabase client and `fetch`, and calls
 * `Deno.serve`; every decision that matters lives here: CORS-before-auth,
 * method gating, the authoritative `auth.getUser()` check, server-side reading
 * of the user's PubMed API key, independent validation of every request field,
 * the bounded upstream retry budget, and the rule that the caller's identity
 * comes from the bearer token and from nowhere else.
 *
 * The module uses **no** Deno API and **no** remote import, so the actual
 * handler — not a re-implementation of it — is exercised by Vitest with fake
 * clients and a fake `fetch`. Security-sensitive logic is therefore never
 * duplicated for testability. Same split as `delete-account/handler.ts`.
 *
 * ## This function is read-only
 *
 * It performs no insert, update, Project/Tag mutation, AI call or quota
 * consumption. It reads the caller's identity and their optional PubMed API
 * key, and it asks NCBI two questions. The library is only ever mutated later,
 * by the existing canonical importer, when the user explicitly imports the
 * PMIDs they selected.
 *
 * ## Why the retry helper is local
 *
 * `fetch-paper-metadata` has its own `fetchWithRetry`. Sharing one would put a
 * new module into that function's deploy artifact and force it to be
 * redeployed for a feature that does not change it, widening the rollout blast
 * radius. This copy is deliberate, is injected with `fetchImpl`/`sleep` so it is
 * genuinely unit-tested (the metadata copy is not), and leaves the canonical
 * importer's deployed bytes untouched.
 */

import {
  buildESearchUrl,
  buildESummaryUrl,
  mapESummaryResponse,
  parseESearchResponse,
  validateSearchRequest,
  type PubMedSearchPage,
} from "../_shared/pubmedSearch.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

/**
 * Single user-facing message for every upstream failure. PubMed's own error
 * text, response bodies and HTTP details are never forwarded — the user is told
 * the search could not be completed and can retry.
 */
export const UPSTREAM_FAILURE =
  "PubMed could not be reached right now. Please try again in a moment.";

/** Per-request upstream timeout. Matches the metadata function's 15s budget. */
const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * Retries *after* the first attempt. One, matching the reduced PubMed budget
 * `fetch-paper-metadata` uses: a page search must stay a bounded, predictable
 * amount of upstream work inside the Edge CPU budget.
 */
const UPSTREAM_MAX_RETRIES = 1;

const UPSTREAM_BASE_DELAY_MS = 1_000;

/**
 * Delay between the ESearch and the ESummary call, honouring NCBI's documented
 * request-rate allowance: 3 requests/second without an API key, 10/second with
 * one. Identical values to `fetch-paper-metadata`, so both functions pace the
 * same shared per-user allowance the same way. A page is exactly two upstream
 * requests — never an unbounded parallel fan-out.
 */
const RATE_LIMIT_DELAY_MS = 350;
const RATE_LIMIT_DELAY_WITH_KEY_MS = 100;

// ── Injected dependencies ─────────────────────────────────────────────────

/** Minimal shape of the caller-scoped (anon key + caller bearer token) client. */
export interface CallerClient {
  auth: {
    getUser(): Promise<{
      data: { user: { id?: unknown } | null };
      error: unknown;
    }>;
  };
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        single(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
      };
    };
  };
}

export interface SearchPubMedDeps {
  /** Build a client bound to the caller's `Authorization` header. */
  createCallerClient(authHeader: string): CallerClient;
  /** Injected so the retry/backoff policy is exercised by tests, not mocked around. */
  fetchImpl(url: string, init: RequestInit): Promise<Response>;
  /** Injected so tests never spend real wall-clock time on backoff. */
  sleep(ms: number): Promise<void>;
  /** Injected so tests can assert exactly what is (and is not) logged. */
  logger?: { log(message: string): void; warn(message: string): void; error(message: string): void };
  /** Injected so timing fields in the structured log are deterministic in tests. */
  now?(): number;
}

function fail(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), { status, headers: jsonHeaders });
}

// ── Bounded upstream fetch ────────────────────────────────────────────────

/**
 * Fetch JSON from NCBI with a finite timeout and a bounded retry budget.
 *
 * Retries only what is worth retrying — 429 (rate limit), 5xx and network/abort
 * errors — with exponential backoff. An ordinary 4xx is a statement about the
 * request and is returned immediately rather than repeated.
 *
 * @returns The parsed JSON, or `null` for any failure. The caller turns that
 *          into one generic 502; no upstream detail escapes this function.
 */
async function fetchUpstreamJson(
  url: string,
  deps: SearchPubMedDeps,
  logger: NonNullable<SearchPubMedDeps["logger"]>,
): Promise<unknown | null> {
  for (let attempt = 0; attempt <= UPSTREAM_MAX_RETRIES; attempt++) {
    try {
      const response = await deps.fetchImpl(url, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt < UPSTREAM_MAX_RETRIES) {
          const delay = UPSTREAM_BASE_DELAY_MS * Math.pow(2, attempt);
          // Status and attempt only — the URL carries the user's query and the
          // API key, so it is never logged.
          logger.warn(`pubmed-search upstream_status=${response.status} attempt=${attempt + 1} retry_in_ms=${delay}`);
          await deps.sleep(delay);
          continue;
        }
        logger.warn(`pubmed-search upstream_status=${response.status} attempts_exhausted=1`);
        return null;
      }

      if (!response.ok) {
        // A plain 4xx is not retried: repeating it cannot change the answer.
        logger.warn(`pubmed-search upstream_status=${response.status} retried=0`);
        return null;
      }

      return await response.json();
    } catch (_error) {
      // Network failure, abort/timeout, or a body that is not JSON. The thrown
      // value is not logged: an upstream error can embed the request URL, and
      // that URL carries both the query text and the API key.
      if (attempt < UPSTREAM_MAX_RETRIES) {
        const delay = UPSTREAM_BASE_DELAY_MS * Math.pow(2, attempt);
        logger.warn(`pubmed-search upstream_network_error attempt=${attempt + 1} retry_in_ms=${delay}`);
        await deps.sleep(delay);
        continue;
      }
      logger.warn("pubmed-search upstream_network_error attempts_exhausted=1");
      return null;
    }
  }
  return null;
}

// ── Handler ───────────────────────────────────────────────────────────────

export async function handleSearchPubMedRequest(
  req: Request,
  deps: SearchPubMedDeps,
): Promise<Response> {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  // 1. CORS preflight — answered before auth, and before anything else. A
  //    browser preflight carries no credentials and must never be refused for
  //    lacking them.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 2. POST only. Every other method is refused before the token is read.
  if (req.method !== "POST") {
    return fail(405, "method_not_allowed", "This endpoint accepts POST only.");
  }

  try {
    // 3. Bearer credential required.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return fail(401, "unauthenticated", "You must be signed in to search PubMed.");
    }

    // 4. Authoritative validation of the caller. `getUser()` is a network check
    //    against the Auth server, not a local decode, and the resulting id is
    //    the only identity this function will use. No request field can name a
    //    user — `validateSearchRequest` reads exactly `query`, `offset` and
    //    `limit`, and nothing here consults the body for an identity.
    const caller = deps.createCallerClient(authHeader);
    const { data, error: authError } = await caller.auth.getUser();
    const userId = data?.user?.id;
    if (authError || typeof userId !== "string" || userId === "") {
      return fail(401, "unauthenticated", "You must be signed in to search PubMed.");
    }

    // 5. Request validation, independent of whatever the client claims to send.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail(400, "invalid_request", "A JSON request body is required.");
    }

    const validation = validateSearchRequest(body);
    if (!validation.ok) {
      return fail(400, "invalid_request", validation.message);
    }
    const { query, offset, limit } = validation.request;

    // 6. The user's PubMed API key, read server-side under their own identity.
    //    It is used only to build the upstream URL: it is never returned, never
    //    logged, and never reaches the browser.
    const { data: profile } = await caller
      .from("profiles")
      .select("pubmed_api_key")
      .eq("user_id", userId)
      .single();
    const rawKey = profile?.pubmed_api_key;
    const apiKey = typeof rawKey === "string" && rawKey.trim() !== "" ? rawKey.trim() : undefined;

    // 7. ESearch — the ordered PMIDs and the true total.
    const tSearchStart = now();
    const esearchPayload = await fetchUpstreamJson(
      buildESearchUrl({ query, offset, limit, apiKey }),
      deps,
      logger,
    );
    const esearchMs = now() - tSearchStart;

    if (esearchPayload === null) {
      logSearch(logger, { query, offset, limit, total: null, returned: 0, esearchMs, esummaryMs: 0, outcome: "esearch_unavailable" });
      return fail(502, "upstream_unavailable", UPSTREAM_FAILURE);
    }

    const parsed = parseESearchResponse(esearchPayload);
    if (!parsed.ok) {
      logSearch(logger, { query, offset, limit, total: null, returned: 0, esearchMs, esummaryMs: 0, outcome: `esearch_${parsed.reason}` });
      return fail(502, "upstream_unavailable", UPSTREAM_FAILURE);
    }

    // 8. A zero-result query is a normal answer, not a failure and not a 404.
    if (parsed.pmids.length === 0) {
      logSearch(logger, { query, offset, limit, total: parsed.total, returned: 0, esearchMs, esummaryMs: 0, outcome: "ok" });
      return json({ query, total: parsed.total, offset, limit, results: [] });
    }

    // 9. ESummary for exactly those PMIDs, one request, after the rate-limit
    //    pause. EFetch is deliberately NOT used here: full records are the
    //    canonical importer's job, for the handful of PMIDs the user selects.
    await deps.sleep(apiKey ? RATE_LIMIT_DELAY_WITH_KEY_MS : RATE_LIMIT_DELAY_MS);

    const tSummaryStart = now();
    const esummaryPayload = await fetchUpstreamJson(
      buildESummaryUrl({ pmids: parsed.pmids, apiKey }),
      deps,
      logger,
    );
    const esummaryMs = now() - tSummaryStart;

    const results = esummaryPayload === null ? null : mapESummaryResponse(esummaryPayload, parsed.pmids);
    if (results === null) {
      logSearch(logger, { query, offset, limit, total: parsed.total, returned: 0, esearchMs, esummaryMs, outcome: "esummary_unavailable" });
      return fail(502, "upstream_unavailable", UPSTREAM_FAILURE);
    }

    logSearch(logger, { query, offset, limit, total: parsed.total, returned: results.length, esearchMs, esummaryMs, outcome: "ok" });
    return json({ query, total: parsed.total, offset, limit, results });
  } catch (error) {
    // The message is included because it originates in this function's own
    // code paths; upstream bodies and URLs never reach here (they are handled
    // and discarded inside `fetchUpstreamJson`).
    logger.error(
      `search-pubmed error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    return fail(500, "internal_error", "Something went wrong. Please try again.");
  }
}

function json(page: PubMedSearchPage): Response {
  return new Response(JSON.stringify(page), { headers: jsonHeaders });
}

/**
 * One structured log line per search.
 *
 * A research query can reveal a clinician's patient, a researcher's unpublished
 * direction, or a person's own diagnosis, so **the query text is never logged**
 * — only its length. Titles, author names, the API key and the JWT are likewise
 * absent: everything here is a count, a bound, a duration or an outcome label.
 */
function logSearch(
  logger: NonNullable<SearchPubMedDeps["logger"]>,
  fields: {
    query: string;
    offset: number;
    limit: number;
    total: number | null;
    returned: number;
    esearchMs: number;
    esummaryMs: number;
    outcome: string;
  },
): void {
  logger.log(
    `pubmed-search q_len=${fields.query.length} offset=${fields.offset} ` +
      `limit=${fields.limit} total=${fields.total ?? "na"} returned=${fields.returned} ` +
      `esearch_ms=${Math.round(fields.esearchMs)} esummary_ms=${Math.round(fields.esummaryMs)} ` +
      `outcome=${fields.outcome}`,
  );
}
