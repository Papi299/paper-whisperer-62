// @vitest-environment node
//
// The handler runs in Deno and uses the platform web APIs Deno provides. jsdom
// does not implement `AbortSignal.timeout`; Node provides the same
// `AbortSignal`, `DOMException`, `Request` and `Response` the Edge runtime does.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  corsHeaders,
  handleSearchConsensusRequest,
  CONSENSUS_UPSTREAM_TIMEOUT_MS,
  SEARCH_CONSENSUS_ERRORS,
  type CallerClient,
  type SearchConsensusDeps,
} from "../handler.ts";
import {
  consensusEnvelope,
  consensusResult,
  minimalConsensusResult,
} from "../../_shared/__tests__/fixtures/consensusSearchResponse.ts";
import { consensusFilterMaxYear } from "../../_shared/consensusSearch.ts";

/**
 * CONSENSUS-SEARCH-MVP-001A — the search-consensus Edge Function's real request
 * path, exercised with fake clients and a fake `fetch`. Nothing security
 * relevant is re-implemented for testability.
 *
 * Most of these pin what the function refuses to do: run for anyone but the
 * owner, read the Consensus key before authorization, spend a Consensus call
 * on a refused or invalid request, retry an upstream call, forward an upstream
 * body, answer a provider failure with a 401 the client would retry, or log a
 * research query, a key, a DOI or a title.
 */

const AUTH_HEADER = "Bearer test-access-token";
const USER_ID = "11111111-2222-3333-4444-555555555555";
/** A fake key. Never a real credential; pinned below to never be logged or returned. */
const FAKE_KEY = "fake-consensus-key-for-tests-0000";
const QUERY = "Does creatine improve cognition in healthy adults?";

const OWNER_ROW = { role: "owner", is_internal: true, can_view_provider_quota: true, ai_quota_exempt: true };
const MANAGER_ROW = { role: "manager", is_internal: true, can_view_provider_quota: true, ai_quota_exempt: false };
const USER_ROW = { role: "user", is_internal: false, can_view_provider_quota: false, ai_quota_exempt: false };

// ── Fakes ─────────────────────────────────────────────────────────────────

interface Harness {
  deps: SearchConsensusDeps;
  fetchImpl: ReturnType<typeof vi.fn>;
  readApiKey: ReturnType<typeof vi.fn>;
  createCallerClient: ReturnType<typeof vi.fn>;
  rpcCalls: string[];
  timeouts: number[];
  logs: string[];
  warns: string[];
  errors: string[];
  /** Every logged line, in order, whatever its level. */
  allLogLines(): string[];
}

function makeHarness(
  options: {
    user?: { id?: unknown } | null;
    authError?: unknown;
    access?: { data: unknown; error: unknown };
    apiKey?: string | undefined;
    responses?: Array<Response | Error>;
  } = {},
): Harness {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const rpcCalls: string[] = [];
  const timeouts: number[] = [];

  const queue = [...(options.responses ?? [])];
  const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("no queued upstream response");
    return next;
  });

  const caller: CallerClient = {
    auth: {
      getUser: async () => ({
        data: { user: "user" in options ? (options.user ?? null) : { id: USER_ID } },
        error: options.authError ?? null,
      }),
    },
    rpc: (fn) => {
      rpcCalls.push(fn);
      return Promise.resolve(options.access ?? { data: [OWNER_ROW], error: null });
    },
  };
  const createCallerClient = vi.fn(() => caller);
  const readApiKey = vi.fn(() => ("apiKey" in options ? options.apiKey : FAKE_KEY));

  return {
    fetchImpl,
    readApiKey,
    createCallerClient,
    rpcCalls,
    timeouts,
    logs,
    warns,
    errors,
    allLogLines: () => [...logs, ...warns, ...errors],
    deps: {
      createCallerClient,
      readApiKey,
      fetchImpl: fetchImpl as unknown as SearchConsensusDeps["fetchImpl"],
      timeoutSignal: (ms: number) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
      logger: {
        log: (m) => logs.push(m),
        warn: (m) => warns.push(m),
        error: (m) => errors.push(m),
      },
      now: () => 0,
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function post(body: unknown, headers: Record<string, string> = { Authorization: AUTH_HEADER }) {
  return new Request("https://edge.test/search-consensus", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function happyResponse() {
  return jsonResponse(
    consensusEnvelope([
      consensusResult(),
      minimalConsensusResult(),
      consensusResult({ title: "Discovery-only result", doi: "10.5555", url: "https://evil.example/x" }),
    ]),
  );
}

async function errorBody(response: Response) {
  return (await response.json()) as { error: string; message: string };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
// CORS and method gating
// ══════════════════════════════════════════════════════════════════════════

describe("search-consensus — CORS and method gating", () => {
  it("answers the preflight BEFORE any auth logic, with no upstream call", async () => {
    const harness = makeHarness();
    const response = await handleSearchConsensusRequest(
      new Request("https://edge.test/search-consensus", { method: "OPTIONS" }),
      harness.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(corsHeaders["Access-Control-Allow-Origin"]);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("authorization");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(harness.createCallerClient).not.toHaveBeenCalled();
    expect(harness.readApiKey).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["GET", "PUT", "DELETE", "PATCH"])("refuses %s with 405 before reading the token", async (method) => {
    const harness = makeHarness();
    const response = await handleSearchConsensusRequest(
      new Request("https://edge.test/search-consensus", { method, headers: { Authorization: AUTH_HEADER } }),
      harness.deps,
    );
    expect(response.status).toBe(405);
    expect(await errorBody(response)).toEqual({ error: "method_not_allowed", message: "This endpoint accepts POST only." });
    expect(harness.createCallerClient).not.toHaveBeenCalled();
    expect(harness.readApiKey).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("carries the CORS headers on failures as well", async () => {
    const harness = makeHarness({ user: null });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Authentication
// ══════════════════════════════════════════════════════════════════════════

describe("search-consensus — authentication", () => {
  it("refuses a request with no Authorization header — no client, no key, no upstream", async () => {
    const harness = makeHarness();
    const response = await handleSearchConsensusRequest(post({ query: QUERY }, {}), harness.deps);
    expect(response.status).toBe(401);
    expect(await errorBody(response)).toEqual({
      error: "unauthenticated",
      message: "You must be signed in to search Consensus.",
    });
    expect(harness.createCallerClient).not.toHaveBeenCalled();
    expect(harness.readApiKey).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["an Auth error", { authError: new Error("invalid JWT") }],
    ["no user", { user: null }],
    ["a user without an id", { user: {} }],
    ["a non-string id", { user: { id: 42 } }],
    ["an empty id", { user: { id: "" } }],
  ])("refuses %s with 401 — no role check, no key, no upstream", async (_label, options) => {
    const harness = makeHarness(options);
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(401);
    expect((await errorBody(response)).error).toBe("unauthenticated");
    expect(harness.rpcCalls).toEqual([]);
    expect(harness.readApiKey).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("builds the caller client from the caller's own Authorization header", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(harness.createCallerClient).toHaveBeenCalledWith(AUTH_HEADER);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Owner-only authorization
// ══════════════════════════════════════════════════════════════════════════

describe("search-consensus — owner-only authorization", () => {
  it("allows the owner, after exactly one get_current_user_access() call as the caller", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(200);
    expect(harness.rpcCalls).toEqual(["get_current_user_access"]);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("also accepts the RPC answering a single object rather than a one-row array", async () => {
    const harness = makeHarness({ access: { data: OWNER_ROW, error: null }, responses: [happyResponse()] });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(200);
  });

  it.each([
    ["a manager", [MANAGER_ROW]],
    ["an ordinary user", [USER_ROW]],
    ["no access row", []],
    ["a null answer", null],
    ["a row without a role", [{ is_internal: true }]],
    ["a differently-cased role", [{ role: "Owner" }]],
    ["a padded role", [{ role: "owner " }]],
    ["a role array", [{ role: ["owner"] }]],
    ["a non-object row", ["owner"]],
  ])("refuses %s with 403 — and spends zero Consensus calls", async (_label, data) => {
    const harness = makeHarness({ access: { data, error: null } });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toEqual({
      error: "forbidden",
      message: "Consensus search is not available for this account.",
    });
    expect(harness.readApiKey).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("answers an access-check failure with a bounded 500 — no key read, no upstream, no RPC text", async () => {
    const harness = makeHarness({
      access: { data: null, error: { message: "permission denied for function get_current_user_access" } },
    });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(500);
    expect(await errorBody(response)).toEqual({
      error: "access_check_failed",
      message: "Your access could not be verified right now. Please try again.",
    });
    expect(harness.readApiKey).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.allLogLines().join("\n")).not.toContain("permission denied");
  });

  it("never takes a role from the request: a non-owner claiming owner in the body is still refused", async () => {
    const harness = makeHarness({ access: { data: [USER_ROW], error: null } });
    const response = await handleSearchConsensusRequest(post({ query: QUERY, role: "owner", userId: USER_ID }), harness.deps);
    expect(response.status).toBe(403);
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("authorizes before reading the body: a non-owner's malformed body still earns 403, not 400", async () => {
    const harness = makeHarness({ access: { data: [MANAGER_ROW], error: null } });
    const response = await handleSearchConsensusRequest(post("{not json"), harness.deps);
    expect(response.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The server-side key
// ══════════════════════════════════════════════════════════════════════════

describe("search-consensus — CONSENSUS_API_KEY", () => {
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("answers a key that is %s with 503 not_configured and zero upstream calls", async (_label, apiKey) => {
    const harness = makeHarness({ apiKey });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(503);
    expect(await errorBody(response)).toEqual({
      error: "not_configured",
      message: "Consensus search is not configured on the server yet.",
    });
    expect(harness.readApiKey).toHaveBeenCalledTimes(1);
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the key only after the request has validated", async () => {
    const harness = makeHarness();
    await handleSearchConsensusRequest(post({ query: "" }), harness.deps);
    expect(harness.readApiKey).not.toHaveBeenCalled();
  });

  it("sends the key only in the x-api-key header — never in the URL, never back to the browser", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    const [url, init] = harness.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("x-api-key")).toBe(FAKE_KEY);
    expect(url).not.toContain(FAKE_KEY);
    expect(await response.text()).not.toContain(FAKE_KEY);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Request validation
// ══════════════════════════════════════════════════════════════════════════

describe("search-consensus — request validation", () => {
  it.each([
    ["a missing query", {}, "query is required."],
    ["an empty query", { query: "" }, "query is required."],
    ["a whitespace query", { query: "   " }, "query is required."],
    ["a non-string query", { query: 7 }, "query is required."],
    ["a query over the local bound", { query: "q".repeat(501) }, "query is too long (max 500 characters)."],
    ["an injected page", { query: QUERY, page: 1 }, "The request contains an unsupported field."],
    ["an injected page_size", { query: QUERY, page_size: 200 }, "The request contains an unsupported field."],
    ["injected full-text chunks", { query: QUERY, include_full_text_chunks: true }, "The request contains an unsupported field."],
    ["an injected endpoint", { query: QUERY, url: "https://api.consensus.app/v1/quick_search" }, "The request contains an unsupported field."],
    ["Consensus's own year_min name", { query: QUERY, year_min: 2020 }, "The request contains an unsupported field."],
  ])("refuses %s with 400 and zero upstream calls", async (_label, body, message) => {
    const harness = makeHarness();
    const response = await handleSearchConsensusRequest(post(body), harness.deps);
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toEqual({ error: "invalid_request", message });
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const harness = makeHarness();
    const response = await handleSearchConsensusRequest(post("{not json"), harness.deps);
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toEqual({ error: "invalid_request", message: "A JSON request body is required." });
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The upstream request
// ══════════════════════════════════════════════════════════════════════════

describe("search-consensus — the one upstream request", () => {
  it("calls exactly GET https://api.consensus.app/v1/search with the query and page_size=20", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    await handleSearchConsensusRequest(post({ query: `  ${QUERY}  ` }), harness.deps);

    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = harness.fetchImpl.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.consensus.app/v1/search");
    expect([...url.searchParams.entries()]).toEqual([
      ["query", QUERY],
      ["page_size", "20"],
    ]);
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("accept")).toBe("application/json");
  });

  it("encodes the query once, so reserved characters survive", async () => {
    const query = `creatine & "working memory" #1 + sleep?`;
    const harness = makeHarness({ responses: [happyResponse()] });
    await handleSearchConsensusRequest(post({ query }), harness.deps);
    const [rawUrl] = harness.fetchImpl.mock.calls[0] as [string];
    expect(new URL(rawUrl).searchParams.get("query")).toBe(query);
    expect([...new URL(rawUrl).searchParams.keys()]).toEqual(["query", "page_size"]);
  });

  it("uses a finite timeout and refuses to follow redirects (the key header must not travel)", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    const [, init] = harness.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(harness.timeouts).toEqual([CONSENSUS_UPSTREAM_TIMEOUT_MS]);
    expect(CONSENSUS_UPSTREAM_TIMEOUT_MS).toBe(15_000);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe("error");
  });

  it.each([
    ["a network error", () => new TypeError("fetch failed: https://api.consensus.app/v1/search?query=secret")],
    ["a timeout", () => new DOMException("The operation timed out.", "TimeoutError")],
    ["a 429", () => jsonResponse({ detail: "Too many requests" }, 429, { "retry-after": "1" })],
    ["a monthly-allowance 429", () => jsonResponse({ detail: "You have used all included searches." }, 429)],
    ["a 500", () => jsonResponse({ detail: "boom" }, 500)],
    ["a 503", () => jsonResponse({ detail: "unavailable" }, 503)],
    ["a 401", () => jsonResponse({ detail: "Invalid API key" }, 401)],
  ])("makes exactly ONE attempt on %s — never a retry", async (_label, make) => {
    const harness = makeHarness({ responses: [make(), happyResponse(), happyResponse()] });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.status).not.toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Error mapping
// ══════════════════════════════════════════════════════════════════════════

describe("search-consensus — upstream error mapping", () => {
  it.each([
    ["the documented monthly-allowance 429", 429, "quota_exhausted", () => jsonResponse({ detail: "You have used all included searches for this month." }, 429)],
    ["the documented per-second 429", 429, "rate_limited", () => jsonResponse({ detail: "Too many requests" }, 429, { "retry-after": "1" })],
    ["an unrecognized 429", 429, "rate_limited", () => new Response("", { status: 429 })],
    ["a Consensus 401 (bad or revoked key)", 502, "consensus_unavailable", () => jsonResponse({ detail: "Invalid API key sk-live-123" }, 401)],
    ["a Consensus 402 (billing past due)", 502, "consensus_unavailable", () => jsonResponse({ detail: "Billing past due" }, 402)],
    ["a Consensus 403 (feature not allowed)", 502, "consensus_unavailable", () => jsonResponse({ code: "feature_not_allowed" }, 403)],
    ["a 500", 502, "upstream_unavailable", () => jsonResponse({ detail: "Traceback: internal secret" }, 500)],
    ["a 502", 502, "upstream_unavailable", () => new Response("<html>bad gateway</html>", { status: 502 })],
    ["a 400", 502, "upstream_unavailable", () => jsonResponse({ detail: "bad request" }, 400)],
    ["a 422", 502, "upstream_unavailable", () => jsonResponse({ detail: [{ loc: ["query"] }] }, 422)],
    ["a network error", 502, "upstream_unavailable", () => new TypeError("fetch failed")],
    ["a timeout", 504, "upstream_timeout", () => new DOMException("The operation timed out.", "TimeoutError")],
    ["a body that is not JSON", 502, "upstream_unavailable", () => new Response("<html>ok?</html>", { status: 200 })],
    ["a JSON envelope without results", 502, "upstream_unavailable", () => jsonResponse({ page: 0, page_size: 20 })],
    ["a JSON array instead of an envelope", 502, "upstream_unavailable", () => jsonResponse([consensusResult()])],
] as const)("answers %s with %i %s and forwards no upstream text", async (_label, status, code, make) => {
    const harness = makeHarness({ responses: [make()] });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(status);
    const body = await errorBody(response);
    expect(body).toEqual({ error: code, message: SEARCH_CONSENSUS_ERRORS[code as keyof typeof SEARCH_CONSENSUS_ERRORS].message });
    const text = JSON.stringify(body);
    for (const upstream of ["Invalid API key", "sk-live-123", "Billing past due", "feature_not_allowed", "Traceback", "bad gateway", "detail"]) {
      expect(text).not.toContain(upstream);
    }
  });

  it("reads only a bounded prefix of a 429 body, however large, then releases the rest", async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode("x".repeat(1024));
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"detail":"You have used all included searches."}'));
      },
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk); // an endless body
      },
      cancel() {
        cancelled = true;
      },
    });
    const harness = makeHarness({ responses: [new Response(body, { status: 429 })] });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(429);
    expect((await errorBody(response)).error).toBe("quota_exhausted");
    expect(cancelled).toBe(true);
    // About 4 KiB was read from an unbounded stream — never the whole body.
    expect(pulls).toBeLessThan(16);
  });

  it("uses the safe owner-facing copy for quota and rate limiting", () => {
    expect(SEARCH_CONSENSUS_ERRORS.rate_limited.message).toBe(
      "Consensus is receiving requests too quickly. Please wait a moment and try again.",
    );
    expect(SEARCH_CONSENSUS_ERRORS.quota_exhausted.message).toMatch(/allowance has been used up/);
    // Neither claims to know how many calls remain.
    expect(SEARCH_CONSENSUS_ERRORS.quota_exhausted.message).not.toMatch(/\d/);
  });

  it("never answers with a 401 once the key has been read — so a client auth retry can never repeat a Consensus call", async () => {
    const upstreamOutcomes: Array<() => Response | Error> = [
      () => jsonResponse({}, 401),
      () => jsonResponse({}, 402),
      () => jsonResponse({}, 403),
      () => jsonResponse({}, 429),
      () => jsonResponse({}, 500),
      () => jsonResponse({}, 404),
      () => new TypeError("fetch failed"),
      () => new DOMException("timeout", "TimeoutError"),
      () => new Response("not json"),
      () => happyResponse(),
    ];
    for (const make of upstreamOutcomes) {
      const harness = makeHarness({ responses: [make()] });
      const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
      expect(harness.readApiKey).toHaveBeenCalledTimes(1);
      expect(response.status).not.toBe(401);
    }
  });

  it("answers an unexpected internal failure with a bounded 500 and no error text", async () => {
    const harness = makeHarness();
    harness.deps.createCallerClient = () => {
      throw new Error(`Missing required Edge Function environment variable: SUPABASE_URL ${QUERY}`);
    };
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(500);
    expect(await errorBody(response)).toEqual({ error: "internal_error", message: "Something went wrong. Please try again." });
    expect(harness.allLogLines().join("\n")).not.toContain(QUERY);
    expect(harness.allLogLines().join("\n")).not.toContain("SUPABASE_URL");
  });

  it.each(["SUPABASE_URL", "SUPABASE_ANON_KEY"])(
    "names a missing %s in the log — the operator's diagnosis — and nothing else from the error",
    async (name) => {
      const harness = makeHarness();
      harness.deps.createCallerClient = () => {
        // The exact message `requireEdgeEnv` throws.
        throw new Error(
          `Missing required Edge Function environment variable: ${name}. ` +
            `Set it in Supabase secrets or confirm it is auto-injected by the Supabase Edge runtime.`,
        );
      };
      const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(name);
      expect(harness.errors).toEqual([
        `consensus-search outcome=internal_error missing_env=${name} q_len=na filters=na upstream_status=na returned=0 importable=0 dropped=0 year_outside=na preprints=na retry=0 duration_ms=0`,
      ]);
    },
  );

  it("never logs a variable name it does not read, even in requireEdgeEnv's format", async () => {
    const harness = makeHarness();
    harness.deps.createCallerClient = () => {
      throw new Error("Missing required Edge Function environment variable: CONSENSUS_API_KEY. Set it.");
    };
    await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(harness.errors).toEqual([
      "consensus-search outcome=internal_error q_len=na filters=na upstream_status=na returned=0 importable=0 dropped=0 year_outside=na preprints=na retry=0 duration_ms=0",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Successful responses
// ══════════════════════════════════════════════════════════════════════════

describe("search-consensus — successful responses", () => {
  it("answers with the application-owned results only", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await response.json()) as { results: Array<Record<string, unknown>> };
    // No page, total, cursor, is_end or echo of upstream envelope fields.
    expect(Object.keys(body)).toEqual(["results"]);
    expect(body.results.map((r) => [r.rank, r.importDoi, r.consensusUrl === null])).toEqual([
      [1, "10.5555/consensus-mvp.0001", false],
      [2, "10.5555/consensus-mvp.0002", false],
      // The malformed DOI and the arbitrary URL were refused at this boundary.
      [3, null, true],
    ]);
  });

  it("does not forward raw upstream fields", async () => {
    const harness = makeHarness({
      responses: [
        jsonResponse(
          consensusEnvelope([
            consensusResult({ full_text_chunks: ["Section: Methods | invented"], institutions: ["Fixture University"] }),
          ]),
        ),
      ],
    });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    const text = await response.text();
    for (const raw of ["full_text_chunks", "Section: Methods", "Fixture University", "journal_name", "publish_year", "is_end", "page_size"]) {
      expect(text).not.toContain(raw);
    }
  });

  it("answers a zero-result search as an empty list, not an error", async () => {
    const harness = makeHarness({ responses: [jsonResponse(consensusEnvelope([]))] });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Logging and privacy
// ══════════════════════════════════════════════════════════════════════════

describe("search-consensus — logging", () => {
  it("logs one bounded line for a successful search: lengths, counts, status, outcome, retry=0", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(harness.allLogLines()).toEqual([
      `consensus-search outcome=ok q_len=${QUERY.length} filters=none upstream_status=200 returned=3 importable=2 dropped=0 year_outside=na preprints=na retry=0 duration_ms=0`,
    ]);
  });

  it("logs provider errors as HTTP status, bounded outcome, duration and retry=0 only", async () => {
    const harness = makeHarness({ responses: [jsonResponse({ detail: "Too many requests" }, 429)] });
    await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(harness.warns).toEqual([
      `consensus-search outcome=rate_limited q_len=${QUERY.length} filters=none upstream_status=429 returned=0 importable=0 dropped=0 year_outside=na preprints=na retry=0 duration_ms=0`,
    ]);
  });

  it("never logs the query, the key, the bearer token, a title, an abstract, a takeaway, a DOI or a URL", async () => {
    const secretQuery = "unpublished-direction rare-disease-cohort-XYZ";
    const scenarios: Array<Array<Response | Error>> = [
      [happyResponse()],
      [jsonResponse({ detail: "Invalid API key" }, 401)],
      [new TypeError(`fetch failed https://api.consensus.app/v1/search?query=${encodeURIComponent(secretQuery)}`)],
      [jsonResponse({ detail: "You have used all included searches" }, 429)],
    ];
    for (const responses of scenarios) {
      const harness = makeHarness({ responses });
      await handleSearchConsensusRequest(post({ query: secretQuery }), harness.deps);
      const logged = harness.allLogLines().join("\n");
      expect(logged).toMatch(/^consensus-search outcome=/);
      for (const forbidden of [
        secretQuery,
        encodeURIComponent(secretQuery),
        "rare-disease",
        FAKE_KEY,
        "test-access-token",
        "Synthetic fixture",
        "invented for a test",
        "Synthetic takeaway",
        "10.5555",
        "consensus.app/papers",
        "api.consensus.app",
        "Ada Fixture",
        "Invalid API key",
      ]) {
        expect(logged).not.toContain(forbidden);
      }
    }
  });

  it("logs refused requests with their outcome and no query", async () => {
    const forbidden = makeHarness({ access: { data: [MANAGER_ROW], error: null } });
    await handleSearchConsensusRequest(post({ query: QUERY }), forbidden.deps);
    expect(forbidden.allLogLines()).toEqual([
      "consensus-search outcome=forbidden q_len=na filters=na upstream_status=na returned=0 importable=0 dropped=0 year_outside=na preprints=na retry=0 duration_ms=0",
    ]);

    const notConfigured = makeHarness({ apiKey: undefined });
    await handleSearchConsensusRequest(post({ query: QUERY }), notConfigured.deps);
    expect(notConfigured.allLogLines()).toEqual([
      `consensus-search outcome=not_configured q_len=${QUERY.length} filters=none upstream_status=na returned=0 importable=0 dropped=0 year_outside=na preprints=na retry=0 duration_ms=0`,
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Advanced filters (CONSENSUS-ADVANCED-FILTERS-001A)
// ══════════════════════════════════════════════════════════════════════════

/** Every filter category set, in PaperLume's own contract names. */
const FILTERED_BODY = {
  query: QUERY,
  yearMin: 2020,
  yearMax: 2026,
  studyTypes: ["rct", "meta-analysis"],
  human: true,
  excludePreprints: true,
};

/** The filter names the handler logs for FILTERED_BODY. */
const FILTERED_PARAMS = "year_min,year_max,study_types,human,exclude_preprints";

describe("search-consensus — advanced filters reach Consensus exactly once", () => {
  it("sends a valid owner's filters as ONE request carrying exactly the documented parameters", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    const response = await handleSearchConsensusRequest(post(FILTERED_BODY), harness.deps);
    expect(response.status).toBe(200);

    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = harness.fetchImpl.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.consensus.app/v1/search");
    expect([...url.searchParams.entries()]).toEqual([
      ["query", QUERY],
      ["page_size", "20"],
      ["year_min", "2020"],
      ["year_max", "2026"],
      ["study_types", "rct"],
      ["study_types", "meta-analysis"],
      ["human", "true"],
      ["exclude_preprints", "true"],
    ]);
    // The V1 transport guarantees hold for a filtered search too.
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("x-api-key")).toBe(FAKE_KEY);
    expect(rawUrl).not.toContain(FAKE_KEY);
    expect(init.redirect).toBe("error");
    expect(harness.timeouts).toEqual([CONSENSUS_UPSTREAM_TIMEOUT_MS]);
  });

  it("sends only the filters that restrict something, with the designs in allowlist order", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    await handleSearchConsensusRequest(
      post({ query: QUERY, studyTypes: ["cohort study", "rct"], human: false, excludePreprints: false }),
      harness.deps,
    );
    const [rawUrl] = harness.fetchImpl.mock.calls[0] as [string];
    expect([...new URL(rawUrl).searchParams.entries()]).toEqual([
      ["query", QUERY],
      ["page_size", "20"],
      ["study_types", "rct"],
      ["study_types", "cohort study"],
    ]);
  });

  it("sends every allowlisted design as its own study_types parameter, in allowlist order, in one request", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    await handleSearchConsensusRequest(
      post({ query: QUERY, studyTypes: ["cohort study", "systematic review", "meta-analysis", "rct"] }),
      harness.deps,
    );
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    const [rawUrl] = harness.fetchImpl.mock.calls[0] as [string];
    expect(new URL(rawUrl).searchParams.getAll("study_types")).toEqual([
      "rct",
      "meta-analysis",
      "systematic review",
      "cohort study",
    ]);
    expect(rawUrl).toContain(
      "&study_types=rct&study_types=meta-analysis&study_types=systematic+review&study_types=cohort+study",
    );
    expect(rawUrl).not.toMatch(/%2C/i);
  });

  it("keeps an unfiltered request's upstream URL exactly the V1 URL", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    await handleSearchConsensusRequest(post({ query: QUERY, studyTypes: [] }), harness.deps);
    const [rawUrl] = harness.fetchImpl.mock.calls[0] as [string];
    expect([...new URL(rawUrl).searchParams.keys()]).toEqual(["query", "page_size"]);
  });

  it("forwards the results exactly as parsed — filters never remove, hide or re-order a card", async () => {
    const harness = makeHarness({
      responses: [
        jsonResponse(
          consensusEnvelope([
            consensusResult({ title: "Outside the range", doi: "10.5555/old", publish_year: 2001, is_preprint: true }),
            consensusResult({ title: "Inside the range", doi: "10.5555/new", publish_year: 2022 }),
          ]),
        ),
      ],
    });
    const response = await handleSearchConsensusRequest(
      post({ query: QUERY, yearMin: 2020, excludePreprints: true }),
      harness.deps,
    );
    const body = (await response.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results.map((r) => [r.rank, r.title, r.year])).toEqual([
      [1, "Outside the range", 2001],
      [2, "Inside the range", 2022],
    ]);
  });
});

describe("search-consensus — advanced filters never get past the boundary early", () => {
  it.each([
    ["a manager", [MANAGER_ROW]],
    ["an ordinary user", [USER_ROW]],
    ["no access row", []],
  ])("refuses %s's filtered request with 403 — no key read, zero Consensus calls", async (_label, data) => {
    const harness = makeHarness({ access: { data, error: null } });
    const response = await handleSearchConsensusRequest(post(FILTERED_BODY), harness.deps);
    expect(response.status).toBe(403);
    expect((await errorBody(response)).error).toBe("forbidden");
    expect(harness.readApiKey).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated filtered request with 401 before any role check", async () => {
    const harness = makeHarness({ user: null });
    const response = await handleSearchConsensusRequest(post(FILTERED_BODY), harness.deps);
    expect(response.status).toBe(401);
    expect(harness.rpcCalls).toEqual([]);
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("authorizes before validating: a non-owner's INVALID filters still earn 403, not 400", async () => {
    const harness = makeHarness({ access: { data: [MANAGER_ROW], error: null } });
    const response = await handleSearchConsensusRequest(post({ query: QUERY, yearMin: 1066 }), harness.deps);
    expect(response.status).toBe(403);
  });

  const ceiling = consensusFilterMaxYear();
  it.each([
    ["a year below the floor", { yearMin: 1899 }, `yearMin must be a whole year from 1900 to ${ceiling}.`],
    ["a year past the ceiling", { yearMax: ceiling + 1 }, `yearMax must be a whole year from 1900 to ${ceiling}.`],
    ["a fractional year", { yearMin: 2020.5 }, `yearMin must be a whole year from 1900 to ${ceiling}.`],
    ["a year as a string", { yearMax: "2020" }, `yearMax must be a whole year from 1900 to ${ceiling}.`],
    ["a reversed range", { yearMin: 2024, yearMax: 2020 }, "yearMin must not be later than yearMax."],
    ["an unknown design", { studyTypes: ["case report"] }, "studyTypes must be a list of supported study designs."],
    ["a repeated design", { studyTypes: ["rct", "rct"] }, "studyTypes must not repeat a study design."],
    ["a design list as a string", { studyTypes: "rct,meta-analysis" }, "studyTypes must be a list of supported study designs."],
    ['"true" for human', { human: "true" }, "human must be true or false."],
    ["1 for excludePreprints", { excludePreprints: 1 }, "excludePreprints must be true or false."],
    ["Consensus's own parameter name", { study_types: "rct" }, "The request contains an unsupported field."],
    ["a page alongside valid filters", { yearMin: 2020, page: 1 }, "The request contains an unsupported field."],
  ])("refuses %s with 400 — before the key is read, zero Consensus calls", async (_label, extra, message) => {
    const harness = makeHarness({ responses: [happyResponse()] });
    const response = await handleSearchConsensusRequest(post({ query: QUERY, ...extra }), harness.deps);
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toEqual({ error: "invalid_request", message });
    expect(harness.readApiKey).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("search-consensus — Consensus refusing a filtered search", () => {
  it.each([
    [
      "a 403 (feature_not_allowed)",
      () => jsonResponse({ code: "feature_not_allowed", detail: "Upgrade your plan to use this filter" }, 403),
      "filters_not_allowed",
    ],
    [
      "a 422 (a filter Consensus would not validate)",
      () => jsonResponse({ detail: [{ loc: ["query", "study_types"], msg: "value is not a valid enumeration member" }] }, 422),
      "filters_rejected",
    ],
    ["a 400", () => jsonResponse({ detail: "bad filter combination" }, 400), "filters_rejected"],
  ] as const)(
    "answers %s with a bounded 422 %s — one attempt, and never an unfiltered fallback",
    async (_label, make, code) => {
      const harness = makeHarness({ responses: [make(), happyResponse(), happyResponse()] });
      const response = await handleSearchConsensusRequest(post(FILTERED_BODY), harness.deps);

      expect(response.status).toBe(422);
      const body = await errorBody(response);
      expect(body).toEqual({ error: code, message: SEARCH_CONSENSUS_ERRORS[code].message });
      // Exactly one request, and it was the filtered one: nothing was retried
      // with the filters stripped.
      expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
      const [rawUrl] = harness.fetchImpl.mock.calls[0] as [string];
      expect(new URL(rawUrl).searchParams.getAll("study_types")).toEqual(["rct", "meta-analysis"]);
      const text = JSON.stringify(body);
      for (const upstream of ["feature_not_allowed", "Upgrade your plan", "enumeration", "bad filter combination", "detail"]) {
        expect(text).not.toContain(upstream);
      }
    },
  );

  it("tells the owner what to do, without claiming to know the plan", () => {
    expect(SEARCH_CONSENSUS_ERRORS.filters_not_allowed.message).toMatch(/Clear the advanced filters/);
    expect(SEARCH_CONSENSUS_ERRORS.filters_not_allowed.message).toMatch(/possibly/);
    expect(SEARCH_CONSENSUS_ERRORS.filters_rejected.message).toMatch(/Change or clear the advanced filters/);
  });

  it.each([
    ["a 403", () => jsonResponse({ code: "feature_not_allowed" }, 403), 502, "consensus_unavailable"],
    ["a 422", () => jsonResponse({ detail: [{ loc: ["query"] }] }, 422), 502, "upstream_unavailable"],
  ] as const)("keeps V1's answer for %s on an UNFILTERED search", async (_label, make, status, code) => {
    const harness = makeHarness({ responses: [make()] });
    const response = await handleSearchConsensusRequest(post({ query: QUERY }), harness.deps);
    expect(response.status).toBe(status);
    expect((await errorBody(response)).error).toBe(code);
  });

  it.each([
    ["the monthly-allowance 429", () => jsonResponse({ detail: "You have used all included searches." }, 429), 429, "quota_exhausted"],
    ["a per-second 429", () => jsonResponse({ detail: "Too many requests" }, 429, { "retry-after": "1" }), 429, "rate_limited"],
    ["a timeout", () => new DOMException("The operation timed out.", "TimeoutError"), 504, "upstream_timeout"],
    ["a network failure", () => new TypeError("fetch failed"), 502, "upstream_unavailable"],
    ["a 500", () => jsonResponse({ detail: "boom" }, 500), 502, "upstream_unavailable"],
    ["a Consensus 401", () => jsonResponse({ detail: "Invalid API key" }, 401), 502, "consensus_unavailable"],
    ["a Consensus 402", () => jsonResponse({ detail: "Billing past due" }, 402), 502, "consensus_unavailable"],
  ] as const)("answers %s on a filtered search as it would without filters — one attempt", async (_label, make, status, code) => {
    const harness = makeHarness({ responses: [make(), happyResponse(), happyResponse()] });
    const response = await handleSearchConsensusRequest(post(FILTERED_BODY), harness.deps);
    expect(response.status).toBe(status);
    expect((await errorBody(response)).error).toBe(code);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never answers 401 once the key has been read, filtered or not", async () => {
    const outcomes: Array<() => Response | Error> = [
      () => jsonResponse({}, 401),
      () => jsonResponse({}, 403),
      () => jsonResponse({}, 422),
      () => jsonResponse({}, 400),
      () => jsonResponse({}, 429),
      () => jsonResponse({}, 500),
      () => new TypeError("fetch failed"),
      () => new DOMException("timeout", "TimeoutError"),
      () => happyResponse(),
    ];
    for (const make of outcomes) {
      const harness = makeHarness({ responses: [make()] });
      const response = await handleSearchConsensusRequest(post(FILTERED_BODY), harness.deps);
      expect(harness.readApiKey).toHaveBeenCalledTimes(1);
      expect(response.status).not.toBe(401);
    }
  });
});

describe("search-consensus — logging a filtered search", () => {
  it("logs the applied filter NAMES and the filter diagnostics — never a filter value", async () => {
    const harness = makeHarness({
      responses: [
        jsonResponse(
          consensusEnvelope([
            consensusResult({ doi: "10.5555/a", publish_year: 2019, is_preprint: true }),
            consensusResult({ doi: "10.5555/b", publish_year: 2024, is_preprint: false }),
            minimalConsensusResult({ publish_year: 2021 }),
          ]),
        ),
      ],
    });
    await handleSearchConsensusRequest(post(FILTERED_BODY), harness.deps);
    expect(harness.allLogLines()).toEqual([
      `consensus-search outcome=ok q_len=${QUERY.length} filters=${FILTERED_PARAMS} upstream_status=200 returned=3 importable=3 dropped=0 year_outside=1 preprints=1 retry=0 duration_ms=0`,
    ]);
    const logged = harness.allLogLines().join("\n");
    for (const value of ["2020", "2026", "meta-analysis", "rct", "=true"]) {
      expect(logged).not.toContain(value);
    }
  });

  it("names a repeated study_types once — four designs log `filters=study_types`, never a value", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    await handleSearchConsensusRequest(
      post({ query: QUERY, studyTypes: ["rct", "meta-analysis", "systematic review", "cohort study"] }),
      harness.deps,
    );
    expect(harness.allLogLines()).toEqual([
      `consensus-search outcome=ok q_len=${QUERY.length} filters=study_types upstream_status=200 returned=3 importable=2 dropped=0 year_outside=na preprints=na retry=0 duration_ms=0`,
    ]);
  });

  it("logs a 422 on several designs once, with each parameter named once and no retry", async () => {
    const harness = makeHarness({ responses: [jsonResponse({ detail: [] }, 422), happyResponse()] });
    const response = await handleSearchConsensusRequest(post(FILTERED_BODY), harness.deps);
    expect(response.status).toBe(422);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.warns).toEqual([
      `consensus-search outcome=filters_rejected q_len=${QUERY.length} filters=${FILTERED_PARAMS} upstream_status=422 returned=0 importable=0 dropped=0 year_outside=na preprints=na retry=0 duration_ms=0`,
    ]);
  });

  it("counts a diagnostic only for a filter the search applied", async () => {
    const harness = makeHarness({ responses: [happyResponse()] });
    await handleSearchConsensusRequest(post({ query: QUERY, studyTypes: ["rct"], human: true }), harness.deps);
    expect(harness.allLogLines()).toEqual([
      `consensus-search outcome=ok q_len=${QUERY.length} filters=study_types,human upstream_status=200 returned=3 importable=2 dropped=0 year_outside=na preprints=na retry=0 duration_ms=0`,
    ]);
  });

  it("logs a refused filtered search with its filter names and the upstream status", async () => {
    const harness = makeHarness({ responses: [jsonResponse({ code: "feature_not_allowed" }, 403)] });
    await handleSearchConsensusRequest(post(FILTERED_BODY), harness.deps);
    expect(harness.warns).toEqual([
      `consensus-search outcome=filters_not_allowed q_len=${QUERY.length} filters=${FILTERED_PARAMS} upstream_status=403 returned=0 importable=0 dropped=0 year_outside=na preprints=na retry=0 duration_ms=0`,
    ]);
  });

  it("logs an invalid filter as a bounded invalid_request, with no filter and no value", async () => {
    const harness = makeHarness();
    await handleSearchConsensusRequest(post({ query: QUERY, studyTypes: ["<script>"] }), harness.deps);
    expect(harness.allLogLines()).toEqual([
      "consensus-search outcome=invalid_request q_len=na filters=na upstream_status=na returned=0 importable=0 dropped=0 year_outside=na preprints=na retry=0 duration_ms=0",
    ]);
  });

  it("never logs the query, the key, the token or any result text on a filtered search either", async () => {
    const secretQuery = "unpublished-direction rare-disease-cohort-XYZ";
    for (const responses of [
      [happyResponse()],
      [jsonResponse({ code: "feature_not_allowed" }, 403)],
      [new TypeError(`fetch failed https://api.consensus.app/v1/search?query=${encodeURIComponent(secretQuery)}&year_min=2020`)],
    ]) {
      const harness = makeHarness({ responses });
      await handleSearchConsensusRequest(post({ ...FILTERED_BODY, query: secretQuery }), harness.deps);
      const logged = harness.allLogLines().join("\n");
      expect(logged).toMatch(/^consensus-search outcome=/);
      for (const forbidden of [secretQuery, "rare-disease", FAKE_KEY, "test-access-token", "Synthetic fixture", "10.5555", "consensus.app/papers", "api.consensus.app"]) {
        expect(logged).not.toContain(forbidden);
      }
    }
  });
});
