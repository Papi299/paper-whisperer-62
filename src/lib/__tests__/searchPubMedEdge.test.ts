import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Supabase mock (hoisted) ────────────────────────────────────────────
const { mockInvoke, mockGetSession, mockRefreshSession } = vi.hoisted(() => {
  const mockInvoke = vi.fn();
  const mockGetSession = vi.fn();
  const mockRefreshSession = vi.fn();
  return { mockInvoke, mockGetSession, mockRefreshSession };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: mockInvoke },
    auth: {
      getSession: mockGetSession,
      refreshSession: mockRefreshSession,
    },
  },
}));

import {
  searchPubMed,
  PubMedSearchError,
  PUBMED_SEARCH_PAGE_SIZE,
} from "../searchPubMedEdge";

/**
 * PUBMED-IN-APP-SEARCH-001 — the discovery Edge wrapper.
 *
 * Same shape as `fetchPaperMetadataEdge.test.ts`: the Supabase client is mocked
 * at the module boundary so the token dance, the request body, the one-shot
 * auth retry and the defensive response parse are all exercised for real.
 */

/** A session whose token is comfortably far from expiry. */
function validSession(token = "valid-token") {
  return {
    data: {
      session: { access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600 },
    },
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    query: "resistance training hypertrophy",
    total: 2509,
    offset: 0,
    limit: 20,
    results: [
      {
        pmid: "41843416",
        title: "Resistance training and hypertrophy",
        authors: ["Currier BS", "D'Souza AC"],
        journal: "Medicine and science in sports and exercise",
        publicationDate: "2026 Apr 1",
        year: 2026,
        publicationTypes: ["Journal Article", "Review"],
        doi: "10.1249/MSS.0000000000003897",
      },
    ],
    ...overrides,
  };
}

/** A `supabase.functions.invoke` failure carrying the function's own Response. */
function functionError(status: number, body: unknown) {
  return {
    data: null,
    error: Object.assign(new Error(`Edge Function returned a non-2xx status code`), {
      context: new Response(JSON.stringify(body), { status }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(validSession());
  mockRefreshSession.mockResolvedValue(validSession("refreshed-token"));
});

// ══════════════════════════════════════════════════════════════════════════
// Request shape
// ══════════════════════════════════════════════════════════════════════════

describe("searchPubMedEdge — request", () => {
  it("sends exactly { query, offset, limit } to the search function", async () => {
    mockInvoke.mockResolvedValue({ data: page(), error: null });

    await searchPubMed({ query: "resistance training hypertrophy", offset: 40, limit: 20 });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [name, options] = mockInvoke.mock.calls[0];
    expect(name).toBe("search-pubmed");
    expect(options.body).toEqual({
      query: "resistance training hypertrophy",
      offset: 40,
      limit: 20,
    });
    // No identity and no credential is ever sent in the body: the function
    // derives the user from the bearer token alone.
    expect(options.body).not.toHaveProperty("userId");
    expect(options.body).not.toHaveProperty("user_id");
    expect(options.body).not.toHaveProperty("apiKey");
    expect(options.body).not.toHaveProperty("api_key");
  });

  it("defaults offset to 0 and limit to the conservative page size", async () => {
    mockInvoke.mockResolvedValue({ data: page(), error: null });
    await searchPubMed({ query: "cancer" });
    expect(mockInvoke.mock.calls[0][1].body).toEqual({
      query: "cancer",
      offset: 0,
      limit: PUBMED_SEARCH_PAGE_SIZE,
    });
    expect(PUBMED_SEARCH_PAGE_SIZE).toBe(20);
  });

  it("sends the PubMed query verbatim — no client-side rewriting", async () => {
    mockInvoke.mockResolvedValue({ data: page(), error: null });
    const query = '("resistance training"[Title/Abstract]) AND muscle NOT review[pt]';
    await searchPubMed({ query });
    expect(mockInvoke.mock.calls[0][1].body.query).toBe(query);
  });

  it("passes the access token in an explicit Authorization header", async () => {
    mockInvoke.mockResolvedValue({ data: page(), error: null });
    await searchPubMed({ query: "cancer" });
    expect(mockInvoke.mock.calls[0][1].headers).toEqual({
      Authorization: "Bearer valid-token",
    });
  });

  it("refreshes a near-expiry session before the first call", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: "stale", expires_at: Math.floor(Date.now() / 1000) + 30 } },
    });
    mockInvoke.mockResolvedValue({ data: page(), error: null });

    await searchPubMed({ query: "cancer" });

    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][1].headers.Authorization).toBe("Bearer refreshed-token");
  });

  it("fails as an auth error, without calling the function, when there is no session", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    mockRefreshSession.mockResolvedValue({ data: { session: null }, error: new Error("no session") });

    await expect(searchPubMed({ query: "cancer" })).rejects.toMatchObject({
      name: "PubMedSearchError",
      kind: "auth",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Successful mapping
// ══════════════════════════════════════════════════════════════════════════

describe("searchPubMedEdge — successful response", () => {
  it("returns the page with its results mapped", async () => {
    mockInvoke.mockResolvedValue({ data: page(), error: null });
    const result = await searchPubMed({ query: "resistance training hypertrophy" });

    expect(result.total).toBe(2509);
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(20);
    expect(result.results).toEqual([
      {
        pmid: "41843416",
        title: "Resistance training and hypertrophy",
        authors: ["Currier BS", "D'Souza AC"],
        journal: "Medicine and science in sports and exercise",
        publicationDate: "2026 Apr 1",
        year: 2026,
        publicationTypes: ["Journal Article", "Review"],
        doi: "10.1249/MSS.0000000000003897",
      },
    ]);
  });

  it("accepts a zero-result page as a normal success", async () => {
    mockInvoke.mockResolvedValue({ data: page({ total: 0, results: [] }), error: null });
    const result = await searchPubMed({ query: "zzzznotaterm" });
    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("normalises a partial result rather than propagating undefined fields", async () => {
    mockInvoke.mockResolvedValue({
      data: page({ results: [{ pmid: "1", title: null }] }),
      error: null,
    });
    const result = await searchPubMed({ query: "x" });
    expect(result.results[0]).toEqual({
      pmid: "1",
      title: null,
      authors: [],
      journal: null,
      publicationDate: null,
      year: null,
      publicationTypes: [],
      doi: null,
    });
  });

  it("drops a result entry with no usable PMID — it could not be imported", async () => {
    mockInvoke.mockResolvedValue({
      data: page({
        results: [{ title: "no pmid" }, { pmid: "", title: "blank pmid" }, { pmid: "1", title: "ok" }],
      }),
      error: null,
    });
    const result = await searchPubMed({ query: "x" });
    expect(result.results.map((r) => r.pmid)).toEqual(["1"]);
  });

  it("filters non-string entries out of the array fields", async () => {
    mockInvoke.mockResolvedValue({
      data: page({
        results: [{ pmid: "1", authors: ["A", 42, null], publicationTypes: ["Review", {}] }],
      }),
      error: null,
    });
    const result = await searchPubMed({ query: "x" });
    expect(result.results[0].authors).toEqual(["A"]);
    expect(result.results[0].publicationTypes).toEqual(["Review"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Invalid / unexpected responses
// ══════════════════════════════════════════════════════════════════════════

describe("searchPubMedEdge — unexpected responses", () => {
  it.each([
    ["null data", null],
    ["a bare string", "ok"],
    ["an array", []],
    ["a missing results array", { query: "x", total: 1, offset: 0, limit: 20 }],
    ["a non-array results", { query: "x", total: 1, offset: 0, limit: 20, results: "none" }],
    ["a missing total", { query: "x", offset: 0, limit: 20, results: [] }],
    ["a negative total", { query: "x", total: -1, offset: 0, limit: 20, results: [] }],
    ["a non-numeric total", { query: "x", total: "2509", offset: 0, limit: 20, results: [] }],
    ["a missing offset", { query: "x", total: 1, limit: 20, results: [] }],
  ])("rejects %s as an unexpected response", async (_label, data) => {
    mockInvoke.mockResolvedValue({ data, error: null });
    await expect(searchPubMed({ query: "cancer" })).rejects.toMatchObject({
      name: "PubMedSearchError",
      kind: "unexpected",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Function-level failures
// ══════════════════════════════════════════════════════════════════════════

describe("searchPubMedEdge — function errors", () => {
  it("surfaces a 400 as a validation error carrying the function's own message", async () => {
    mockInvoke.mockResolvedValue(
      functionError(400, { error: "invalid_request", message: "query is too long (max 500 characters)." }),
    );

    await expect(searchPubMed({ query: "x".repeat(600) })).rejects.toMatchObject({
      kind: "validation",
      message: "query is too long (max 500 characters).",
    });
  });

  it("surfaces a 502 as an upstream error the user can retry", async () => {
    mockInvoke.mockResolvedValue(
      functionError(502, {
        error: "upstream_unavailable",
        message: "PubMed could not be reached right now. Please try again in a moment.",
      }),
    );

    const error = await searchPubMed({ query: "cancer" }).catch((e) => e);
    expect(error).toBeInstanceOf(PubMedSearchError);
    expect(error.kind).toBe("upstream");
    expect(error.message).toBe("PubMed could not be reached right now. Please try again in a moment.");
  });

  it("surfaces a 500 as an upstream-class error with a safe fallback message", async () => {
    mockInvoke.mockResolvedValue(functionError(500, { error: "internal_error" }));
    await expect(searchPubMed({ query: "cancer" })).rejects.toMatchObject({ kind: "upstream" });
  });

  it("does not carry transport detail into the user-facing message", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: new Error("FunctionsFetchError: TypeError: fetch failed at node:internal/deps/undici"),
    });
    const error = await searchPubMed({ query: "cancer" }).catch((e) => e);
    expect(error.kind).toBe("unexpected");
    expect(error.message).toBe("PubMed search failed. Please try again.");
    expect(error.message).not.toContain("undici");
  });

  it("survives an error whose body is not readable JSON", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error("non-2xx"), {
        context: new Response("<html>bad gateway</html>", { status: 502 }),
      }),
    });
    await expect(searchPubMed({ query: "cancer" })).rejects.toMatchObject({
      kind: "upstream",
      message: "PubMed could not be reached right now. Please try again in a moment.",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Auth retry
// ══════════════════════════════════════════════════════════════════════════

describe("searchPubMedEdge — auth retry", () => {
  it("refreshes once and retries with the new token on a 401", async () => {
    mockInvoke
      .mockResolvedValueOnce({ data: null, error: new Error("401 Unauthorized") })
      .mockResolvedValueOnce({ data: page(), error: null });

    const result = await searchPubMed({ query: "cancer" });

    expect(result.total).toBe(2509);
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[1][1].headers).toEqual({ Authorization: "Bearer refreshed-token" });
    // The retry is the SAME request, not a re-derived one.
    expect(mockInvoke.mock.calls[1][1].body).toEqual(mockInvoke.mock.calls[0][1].body);
  });

  it("gives up as an auth error when the refresh itself fails", async () => {
    mockInvoke.mockResolvedValue({ data: null, error: new Error("Invalid JWT") });
    mockRefreshSession.mockResolvedValue({ data: { session: null }, error: new Error("refresh failed") });

    await expect(searchPubMed({ query: "cancer" })).rejects.toMatchObject({ kind: "auth" });
    // Refreshing failed, so there was nothing to retry with.
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("never loops: a second 401 after a successful refresh is reported, not retried again", async () => {
    mockInvoke.mockResolvedValue({ data: null, error: new Error("401 Unauthorized") });

    await expect(searchPubMed({ query: "cancer" })).rejects.toMatchObject({ kind: "auth" });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
  });

  it("does not treat a non-auth failure as a token problem", async () => {
    mockInvoke.mockResolvedValue(
      functionError(502, { error: "upstream_unavailable", message: "PubMed could not be reached right now. Please try again in a moment." }),
    );

    await expect(searchPubMed({ query: "cancer" })).rejects.toMatchObject({ kind: "upstream" });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });
});
