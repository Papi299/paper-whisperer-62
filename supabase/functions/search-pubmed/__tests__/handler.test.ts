// @vitest-environment node
//
// The handler runs in Deno and uses the platform web APIs Deno provides. jsdom
// does not implement `AbortSignal.timeout`, so under the project's default
// environment the very first upstream attempt would throw before `fetch` was
// reached — every assertion about retries, pacing and results would then be
// measuring jsdom rather than this function. Node 22 provides the same
// `AbortSignal.timeout`, `Request` and `Response` the Edge runtime does.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  corsHeaders,
  handleSearchPubMedRequest,
  UPSTREAM_FAILURE,
  type CallerClient,
  type SearchPubMedDeps,
} from "../handler.ts";

/**
 * PUBMED-IN-APP-SEARCH-001 — the search Edge Function's real request path.
 *
 * The handler is runtime-agnostic by construction, so these exercise the actual
 * shipped code with fake clients and a fake `fetch` — nothing security-relevant
 * is re-implemented for testability. The point of most of them is what the
 * function *refuses* to do: accept an identity from the body, return the user's
 * API key, log a research query, retry a 4xx forever, or turn an upstream
 * failure into a plausible-looking empty result page.
 */

const AUTH_HEADER = "Bearer test-access-token";
const USER_ID = "11111111-2222-3333-4444-555555555555";
const API_KEY = "ncbi-secret-key-value";

/** Live-shaped ESearch page. `count` is a string, exactly as NCBI sends it. */
function esearchPayload(total: string, ids: string[]) {
  return { header: { type: "esearch" }, esearchresult: { count: total, retmax: String(ids.length), retstart: "0", idlist: ids } };
}

function esummaryPayload(records: Record<string, unknown>[]) {
  const result: Record<string, unknown> = { uids: records.map((r) => r.uid) };
  for (const record of records) result[String(record.uid)] = record;
  return { header: { type: "esummary" }, result };
}

const RECORD_A = {
  uid: "41843416",
  title: "Resistance training and hypertrophy",
  authors: [{ name: "Currier BS", authtype: "Author" }],
  fulljournalname: "Medicine and science in sports and exercise",
  pubdate: "2026 Apr 1",
  pubtype: ["Journal Article"],
  articleids: [{ idtype: "doi", value: "10.1249/MSS.0000000000003897" }],
};
const RECORD_B = { uid: "27102172", title: "A second paper", pubdate: "2016" };

// ── Fakes ─────────────────────────────────────────────────────────────────

interface Harness {
  deps: SearchPubMedDeps;
  fetchImpl: ReturnType<typeof vi.fn>;
  sleeps: number[];
  logs: string[];
  warns: string[];
  errors: string[];
  profileFilters: Array<{ table: string; columns: string; column: string; value: string }>;
}

function makeHarness(options: {
  user?: { id?: unknown } | null;
  authError?: unknown;
  profile?: Record<string, unknown> | null;
  responses?: Array<Response | Error>;
} = {}): Harness {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const profileFilters: Harness["profileFilters"] = [];

  const queue = [...(options.responses ?? [])];
  const fetchImpl = vi.fn(async (_url: string) => {
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
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string) => ({
          single: async () => {
            profileFilters.push({ table, columns, column, value });
            return { data: options.profile ?? { pubmed_api_key: null }, error: null };
          },
        }),
      }),
    }),
  };

  return {
    fetchImpl,
    sleeps,
    logs,
    warns,
    errors,
    profileFilters,
    deps: {
      createCallerClient: () => caller,
      fetchImpl: fetchImpl as unknown as SearchPubMedDeps["fetchImpl"],
      sleep: async (ms: number) => {
        sleeps.push(ms);
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function post(body: unknown, headers: Record<string, string> = { Authorization: AUTH_HEADER }) {
  return new Request("https://edge.test/search-pubmed", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** A full, healthy two-call upstream exchange. */
function happyResponses() {
  return [
    jsonResponse(esearchPayload("2509", ["41843416", "27102172"])),
    jsonResponse(esummaryPayload([RECORD_A, RECORD_B])),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
// CORS and method gating
// ══════════════════════════════════════════════════════════════════════════

describe("search-pubmed — CORS and method gating", () => {
  it("answers the preflight BEFORE any auth logic and without credentials", async () => {
    const harness = makeHarness();
    const createCallerClient = vi.fn();

    const response = await handleSearchPubMedRequest(
      // No Authorization header at all — a browser preflight never carries one.
      new Request("https://edge.test/search-pubmed", { method: "OPTIONS" }),
      { ...harness.deps, createCallerClient },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(corsHeaders["Access-Control-Allow-Origin"]);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("authorization");
    // Auth was never even constructed, so the preflight cannot 401.
    expect(createCallerClient).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["GET", "PUT", "DELETE", "PATCH"])("refuses %s before reading the token", async (method) => {
    const harness = makeHarness();
    const createCallerClient = vi.fn();
    const response = await handleSearchPubMedRequest(
      new Request("https://edge.test/search-pubmed", { method, headers: { Authorization: AUTH_HEADER } }),
      { ...harness.deps, createCallerClient },
    );
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: "method_not_allowed",
      message: "This endpoint accepts POST only.",
    });
    expect(createCallerClient).not.toHaveBeenCalled();
  });

  it("carries the CORS headers on every response, including failures", async () => {
    const harness = makeHarness({ user: null });
    const response = await handleSearchPubMedRequest(post({ query: "x" }), harness.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Authentication
// ══════════════════════════════════════════════════════════════════════════

describe("search-pubmed — authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const harness = makeHarness();
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }, {}), harness.deps);
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("unauthenticated");
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the authoritative getUser() check, not a local token decode", async () => {
    const getUser = vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null }));
    const harness = makeHarness({ responses: happyResponses() });
    const deps: SearchPubMedDeps = {
      ...harness.deps,
      createCallerClient: (header: string) => {
        expect(header).toBe(AUTH_HEADER);
        return { ...(harness.deps.createCallerClient(header) as CallerClient), auth: { getUser } };
      },
    };
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), deps);
    expect(response.status).toBe(200);
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no user", { user: null }],
    ["an auth error", { authError: { message: "bad jwt" } }],
    ["a non-string id", { user: { id: 42 } }],
    ["an empty id", { user: { id: "" } }],
  ])("fails closed on %s and reaches no upstream", async (_label, options) => {
    const harness = makeHarness({ ...options, responses: happyResponses() });
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    expect(response.status).toBe(401);
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("derives the profile lookup from the AUTHENTICATED id, never from the body", async () => {
    const harness = makeHarness({ responses: happyResponses() });
    await handleSearchPubMedRequest(
      post({
        query: "cancer",
        userId: "attacker-supplied",
        user_id: "attacker-supplied",
        id: "attacker-supplied",
      }),
      harness.deps,
    );
    expect(harness.profileFilters).toEqual([
      { table: "profiles", columns: "pubmed_api_key", column: "user_id", value: USER_ID },
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Request validation
// ══════════════════════════════════════════════════════════════════════════

describe("search-pubmed — request validation", () => {
  it("rejects a body that is not JSON", async () => {
    const harness = makeHarness();
    const response = await handleSearchPubMedRequest(
      new Request("https://edge.test/search-pubmed", {
        method: "POST",
        headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
        body: "not json at all",
      }),
      harness.deps,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_request");
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "query is required."],
    [{ query: "   " }, "query is required."],
    [{ query: "a".repeat(501) }, "query is too long (max 500 characters)."],
    [{ query: "x", offset: 9999 }, "offset must be between 0 and 9998."],
    [{ query: "x", offset: -1 }, "offset must be between 0 and 9998."],
    [{ query: "x", offset: 1.5 }, "offset must be an integer."],
    [{ query: "x", limit: 51 }, "limit must be between 1 and 50."],
    [{ query: "x", limit: 0 }, "limit must be between 1 and 50."],
  ])("rejects %o with 400 and contacts no upstream", async (body, message) => {
    const harness = makeHarness();
    const response = await handleSearchPubMedRequest(post(body), harness.deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", message });
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("validates independently of the client, which always sends 20", async () => {
    const harness = makeHarness({ responses: happyResponses() });
    await handleSearchPubMedRequest(post({ query: "cancer", limit: 50, offset: 9998 }), harness.deps);
    const url = new URL(harness.fetchImpl.mock.calls[0][0] as string);
    expect(url.searchParams.get("retmax")).toBe("50");
    expect(url.searchParams.get("retstart")).toBe("9998");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The happy path
// ══════════════════════════════════════════════════════════════════════════

describe("search-pubmed — successful search", () => {
  it("returns an application-owned page, not raw NCBI JSON", async () => {
    const harness = makeHarness({ responses: happyResponses() });
    const response = await handleSearchPubMedRequest(
      post({ query: "  resistance training hypertrophy  " }),
      harness.deps,
    );

    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page).toEqual({
      // The trimmed query the server actually executed.
      query: "resistance training hypertrophy",
      total: 2509,
      offset: 0,
      limit: 20,
      results: [
        {
          pmid: "41843416",
          title: "Resistance training and hypertrophy",
          authors: ["Currier BS"],
          journal: "Medicine and science in sports and exercise",
          publicationDate: "2026 Apr 1",
          year: 2026,
          publicationTypes: ["Journal Article"],
          doi: "10.1249/MSS.0000000000003897",
        },
        {
          pmid: "27102172",
          title: "A second paper",
          authors: [],
          journal: null,
          publicationDate: "2016",
          year: 2016,
          publicationTypes: [],
          doi: null,
        },
      ],
    });
    // No NCBI envelope leaked through.
    expect(page).not.toHaveProperty("esearchresult");
    expect(page).not.toHaveProperty("header");
  });

  it("spends exactly two upstream requests per page — ESearch then ESummary", async () => {
    const harness = makeHarness({ responses: happyResponses() });
    await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);

    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
    expect(harness.fetchImpl.mock.calls[0][0]).toContain("esearch.fcgi");
    expect(harness.fetchImpl.mock.calls[1][0]).toContain("esummary.fcgi");
    // EFetch is the canonical importer's job, for the few PMIDs the user picks —
    // never one full record fetch per discovery card.
    expect(harness.fetchImpl.mock.calls.some(([url]) => String(url).includes("efetch"))).toBe(false);
  });

  it("asks ESummary only for the PMIDs ESearch returned, in that order", async () => {
    const harness = makeHarness({ responses: happyResponses() });
    await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    const url = new URL(harness.fetchImpl.mock.calls[1][0] as string);
    expect(url.searchParams.get("id")).toBe("41843416,27102172");
  });

  it("paces the two calls at PubMed's keyless rate", async () => {
    const harness = makeHarness({ responses: happyResponses() });
    await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    expect(harness.sleeps).toEqual([350]);
  });

  it("paces faster when the user configured an API key", async () => {
    const harness = makeHarness({ profile: { pubmed_api_key: API_KEY }, responses: happyResponses() });
    await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    expect(harness.sleeps).toEqual([100]);
  });

  it("answers a zero-result query with 200 and an empty page — never a 404", async () => {
    const harness = makeHarness({
      responses: [jsonResponse({ esearchresult: { count: "0", idlist: [] } })],
    });
    const response = await handleSearchPubMedRequest(post({ query: "zzzznotaterm" }), harness.deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      query: "zzzznotaterm",
      total: 0,
      offset: 0,
      limit: 20,
      results: [],
    });
    // No PMIDs means no second call — a zero-result search costs one request.
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The user's API key
// ══════════════════════════════════════════════════════════════════════════

describe("search-pubmed — the user's PubMed API key", () => {
  it("is read server-side and never appears in the response", async () => {
    const harness = makeHarness({ profile: { pubmed_api_key: API_KEY }, responses: happyResponses() });
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);

    const body = await response.text();
    expect(body).not.toContain(API_KEY);
    expect(body).not.toContain("pubmed_api_key");
    expect(body).not.toContain("api_key");
    // It IS used — on the upstream URL, server-side only.
    expect(harness.fetchImpl.mock.calls[0][0]).toContain(`api_key=${API_KEY}`);
  });

  it("is never written to any log line", async () => {
    const harness = makeHarness({
      profile: { pubmed_api_key: API_KEY },
      // Force the noisiest path: a retry, then an exhausted upstream failure.
      responses: [jsonResponse({}, 503), jsonResponse({}, 503)],
    });
    await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);

    const everything = [...harness.logs, ...harness.warns, ...harness.errors].join("\n");
    expect(everything).not.toContain(API_KEY);
    // The upstream URL is never logged either — it carries both the key and the
    // query.
    expect(everything).not.toContain("eutils.ncbi.nlm.nih.gov");
  });

  it("treats a blank stored key as no key at all", async () => {
    const harness = makeHarness({ profile: { pubmed_api_key: "   " }, responses: happyResponses() });
    await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    expect(harness.fetchImpl.mock.calls[0][0]).not.toContain("api_key");
    expect(harness.sleeps).toEqual([350]);
  });

  it("works for a user with no profile row at all", async () => {
    const harness = makeHarness({ profile: null, responses: happyResponses() });
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    expect(response.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Privacy of the query itself
// ══════════════════════════════════════════════════════════════════════════

describe("search-pubmed — query privacy in logs", () => {
  const SENSITIVE = "BRCA1 mutation prognosis in 34-year-old female patient";

  it("logs the query's LENGTH, never its text", async () => {
    const harness = makeHarness({ responses: happyResponses() });
    await handleSearchPubMedRequest(post({ query: SENSITIVE }), harness.deps);

    const everything = [...harness.logs, ...harness.warns, ...harness.errors].join("\n");
    expect(everything).not.toContain("BRCA1");
    expect(everything).not.toContain(SENSITIVE);
    expect(harness.logs.join("\n")).toContain(`q_len=${SENSITIVE.length}`);
  });

  it("logs no title, author name or JWT", async () => {
    const harness = makeHarness({ responses: happyResponses() });
    await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);

    const everything = [...harness.logs, ...harness.warns, ...harness.errors].join("\n");
    expect(everything).not.toContain("Resistance training and hypertrophy");
    expect(everything).not.toContain("Currier BS");
    expect(everything).not.toContain("test-access-token");
  });

  it("logs the safe structured fields", async () => {
    const harness = makeHarness({ responses: happyResponses() });
    await handleSearchPubMedRequest(post({ query: "cancer", offset: 40 }), harness.deps);
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0]).toBe(
      "pubmed-search q_len=6 offset=40 limit=20 total=2509 returned=2 esearch_ms=0 esummary_ms=0 outcome=ok",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Upstream failure, retry and timeout
// ══════════════════════════════════════════════════════════════════════════

describe("search-pubmed — upstream resilience", () => {
  it("applies a finite timeout to every upstream request", async () => {
    const harness = makeHarness({ responses: happyResponses() });
    await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    // Asserted first: a loop over zero calls would pass while proving nothing.
    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of harness.fetchImpl.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
      expect((init as RequestInit).signal?.aborted).toBe(false);
    }
  });

  it("retries a 429 once with backoff, then succeeds", async () => {
    const harness = makeHarness({
      responses: [jsonResponse({}, 429), ...happyResponses()],
    });
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    expect(response.status).toBe(200);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(3);
    // 1000ms backoff, then the 350ms inter-call pacing.
    expect(harness.sleeps).toEqual([1000, 350]);
  });

  it("retries a 5xx once and then gives up with a 502", async () => {
    const harness = makeHarness({ responses: [jsonResponse({}, 502), jsonResponse({}, 502)] });
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_unavailable", message: UPSTREAM_FAILURE });
    // Bounded: two attempts, never an unbounded loop against a broken upstream.
    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry an ordinary 4xx", async () => {
    const harness = makeHarness({ responses: [jsonResponse({}, 400)] });
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    expect(response.status).toBe(502);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
  });

  it("retries a network error once and then fails cleanly", async () => {
    const harness = makeHarness({
      responses: [new Error("ECONNRESET"), new Error("ECONNRESET")],
    });
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    expect(response.status).toBe(502);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("turns NCBI's in-band ERROR into a 502 rather than an empty result page", async () => {
    const harness = makeHarness({
      responses: [
        jsonResponse({
          esearchresult: { ERROR: "Search Backend failed: 'retstart' cannot be larger than 9998." },
        }),
      ],
    });
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);

    expect(response.status).toBe(502);
    const body = await response.text();
    // A user must never be told "no results" when PubMed actually failed…
    expect(body).not.toContain('"results"');
    // …and must never be shown NCBI's internal text.
    expect(body).not.toContain("Search Backend failed");
    expect(body).not.toContain("retstart");
  });

  it("fails with 502 when the ESummary payload is unusable", async () => {
    const harness = makeHarness({
      responses: [
        jsonResponse(esearchPayload("2", ["41843416"])),
        jsonResponse({ result: "gateway timeout" }),
      ],
    });
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("upstream_unavailable");
  });

  it("fails with 502 when the upstream body is not JSON at all", async () => {
    const harness = makeHarness({
      responses: [
        new Response("<html>bad gateway</html>", { status: 200 }),
        new Response("<html>bad gateway</html>", { status: 200 }),
      ],
    });
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    expect(response.status).toBe(502);
  });

  it("does not leak an internal failure's detail to the caller", async () => {
    const harness = makeHarness();
    const deps: SearchPubMedDeps = {
      ...harness.deps,
      createCallerClient: () => {
        throw new Error("Missing required Edge Function environment variable: SUPABASE_ANON_KEY");
      },
    };
    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), deps);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "internal_error",
      message: "Something went wrong. Please try again.",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Read-only guarantee
// ══════════════════════════════════════════════════════════════════════════

describe("search-pubmed — read-only", () => {
  it("performs exactly one database read and no write of any kind", async () => {
    const writes: string[] = [];
    const harness = makeHarness({ responses: happyResponses() });
    const base = harness.deps.createCallerClient(AUTH_HEADER);
    const deps: SearchPubMedDeps = {
      ...harness.deps,
      createCallerClient: () =>
        new Proxy(base, {
          get(target, prop, receiver) {
            // Any mutating client surface would have to be reached through one
            // of these names; none of them exists on the handler's path.
            if (["insert", "update", "upsert", "delete", "rpc", "storage"].includes(String(prop))) {
              writes.push(String(prop));
            }
            return Reflect.get(target, prop, receiver);
          },
        }),
    };

    const response = await handleSearchPubMedRequest(post({ query: "cancer" }), deps);
    expect(response.status).toBe(200);
    expect(writes).toEqual([]);
    // The single read is the API-key lookup, and it selects that column alone.
    expect(harness.profileFilters).toEqual([
      { table: "profiles", columns: "pubmed_api_key", column: "user_id", value: USER_ID },
    ]);
  });

  it("only ever contacts NCBI E-utilities", async () => {
    const harness = makeHarness({ responses: happyResponses() });
    await handleSearchPubMedRequest(post({ query: "cancer" }), harness.deps);
    for (const [url] of harness.fetchImpl.mock.calls) {
      expect(new URL(String(url)).hostname).toBe("eutils.ncbi.nlm.nih.gov");
    }
  });
});
