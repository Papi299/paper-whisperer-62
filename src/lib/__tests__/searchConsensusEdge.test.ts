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
  searchConsensus,
  consensusSelectionKey,
  toImportableDoi,
  ConsensusSearchError,
} from "../searchConsensusEdge";

/**
 * CONSENSUS-SEARCH-MVP-001A — the browser wrapper around `search-consensus`.
 *
 * The Supabase client is mocked at the module boundary, so the token dance, the
 * request body, the single PaperLume-401 retry, the refusal to retry anything
 * else, the error-kind mapping and the defensive response parse all run for
 * real. No network, no Consensus.
 */

const QUERY = "Does creatine improve cognition in healthy adults?";

/** A session whose token is comfortably far from expiry. */
function validSession(token = "valid-token") {
  return {
    data: { session: { access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600 } },
    error: null,
  };
}

function edgeResult(overrides: Record<string, unknown> = {}) {
  return {
    rank: 1,
    title: "Synthetic fixture: creatine and working memory",
    authors: ["Ada Fixture", "Ben Placeholder"],
    journal: "Journal of Synthetic Fixtures",
    year: 2024,
    abstract: "An invented abstract.",
    citationCount: 47,
    studyType: "rct",
    takeaway: "Synthetic takeaway.",
    consensusUrl: "https://consensus.app/papers/synthetic-slug/0123456789abcdef0123456789abcdef/?utm_source=publicapi",
    importDoi: "10.5555/consensus-mvp.0001",
    ...overrides,
  };
}

/** A `supabase.functions.invoke` failure carrying the function's own Response. */
function functionError(status: number, body: unknown) {
  return {
    data: null,
    error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
      context: new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(validSession());
  mockRefreshSession.mockResolvedValue(validSession("refreshed-token"));
});

// ══════════════════════════════════════════════════════════════════════════
// Request
// ══════════════════════════════════════════════════════════════════════════

describe("searchConsensus — request", () => {
  it("invokes search-consensus with exactly { query } and a fresh bearer token", async () => {
    mockInvoke.mockResolvedValue({ data: { results: [] }, error: null });

    await searchConsensus({ query: QUERY });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [name, options] = mockInvoke.mock.calls[0];
    expect(name).toBe("search-consensus");
    expect(options.body).toEqual({ query: QUERY });
    expect(options.headers).toEqual({ Authorization: "Bearer valid-token" });
  });

  it("never sends a page, page size, Consensus parameter, endpoint, role, identity or key", async () => {
    mockInvoke.mockResolvedValue({ data: { results: [] }, error: null });
    // Even if a caller passes extra properties, only contract fields are forwarded.
    await searchConsensus({
      query: QUERY,
      page: 2,
      page_size: 200,
      year_min: 1800,
      study_types: "animal",
      include_full_text_chunks: true,
      url: "https://api.consensus.app/v1/quick_search",
      role: "owner",
      userId: "11111111-2222-3333-4444-555555555555",
      apiKey: "sk-live-123",
    } as unknown as { query: string });
    expect(Object.keys(mockInvoke.mock.calls[0][1].body)).toEqual(["query"]);
  });

  it("sends the filters under exactly the contract names, in a body built field by field", async () => {
    mockInvoke.mockResolvedValue({ data: { results: [] }, error: null });
    const studyTypes = ["rct", "meta-analysis"] as const;
    await searchConsensus({
      query: QUERY,
      yearMin: 2020,
      yearMax: 2026,
      studyTypes,
      human: true,
      excludePreprints: true,
    });
    const { body } = mockInvoke.mock.calls[0][1];
    expect(body).toEqual({
      query: QUERY,
      yearMin: 2020,
      yearMax: 2026,
      studyTypes: ["rct", "meta-analysis"],
      human: true,
      excludePreprints: true,
    });
    // A copy: the request body shares no array with the caller.
    expect(body.studyTypes).not.toBe(studyTypes);
  });

  it("leaves out every filter that restricts nothing — an unfiltered search sends exactly { query }", async () => {
    mockInvoke.mockResolvedValue({ data: { results: [] }, error: null });
    await searchConsensus({ query: QUERY, studyTypes: [], human: false, excludePreprints: false });
    expect(mockInvoke.mock.calls[0][1].body).toEqual({ query: QUERY });
  });

  it("forwards a malformed filter as given, for the server to refuse — never silently drops it", async () => {
    mockInvoke.mockResolvedValue(functionError(400, { error: "invalid_request", message: "human must be true or false." }));
    await expect(
      searchConsensus({ query: QUERY, human: "true", yearMin: "2020", studyTypes: "rct" } as unknown as { query: string }),
    ).rejects.toMatchObject({ kind: "validation", message: "human must be true or false." });
    expect(mockInvoke.mock.calls[0][1].body).toEqual({ query: QUERY, human: "true", yearMin: "2020", studyTypes: "rct" });
  });

  it("refreshes first when the stored token is about to expire", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: "stale", expires_at: Math.floor(Date.now() / 1000) + 30 } },
    });
    mockInvoke.mockResolvedValue({ data: { results: [] }, error: null });

    await searchConsensus({ query: QUERY });

    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer refreshed-token" });
  });

  it("fails as auth — without invoking anything — when no session can be obtained", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    mockRefreshSession.mockResolvedValue({ data: { session: null }, error: new Error("no session") });

    await expect(searchConsensus({ query: QUERY })).rejects.toMatchObject({ kind: "auth" });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The one retry, and everything that is NOT retried
// ══════════════════════════════════════════════════════════════════════════

describe("searchConsensus — retry policy", () => {
  it("retries a PaperLume Edge 401 exactly once, with the refreshed token", async () => {
    mockInvoke
      .mockResolvedValueOnce(functionError(401, { error: "unauthenticated", message: "You must be signed in to search Consensus." }))
      .mockResolvedValueOnce({ data: { results: [edgeResult()] }, error: null });

    const response = await searchConsensus({ query: QUERY });

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[1][1].headers).toEqual({ Authorization: "Bearer refreshed-token" });
    expect(mockInvoke.mock.calls[1][1].body).toEqual({ query: QUERY });
    expect(response.results).toHaveLength(1);
  });

  it("retries a PaperLume Edge 401 with the very same filtered body", async () => {
    mockInvoke
      .mockResolvedValueOnce(functionError(401, { error: "unauthenticated", message: "You must be signed in to search Consensus." }))
      .mockResolvedValueOnce({ data: { results: [] }, error: null });
    const request = { query: QUERY, yearMin: 2015, studyTypes: ["systematic review"] as const, excludePreprints: true };

    await searchConsensus(request);

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[1][1].body).toEqual(mockInvoke.mock.calls[0][1].body);
    expect(mockInvoke.mock.calls[1][1].body).toEqual({
      query: QUERY,
      yearMin: 2015,
      studyTypes: ["systematic review"],
      excludePreprints: true,
    });
  });

  it("does not loop: a second 401 after the refresh is reported as auth", async () => {
    mockInvoke.mockResolvedValue(functionError(401, { error: "unauthenticated", message: "You must be signed in to search Consensus." }));

    await expect(searchConsensus({ query: QUERY })).rejects.toMatchObject({ kind: "auth" });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the refresh itself fails", async () => {
    mockInvoke.mockResolvedValue(functionError(401, { error: "unauthenticated" }));
    mockRefreshSession.mockResolvedValue({ data: { session: null }, error: new Error("refresh failed") });

    await expect(searchConsensus({ query: QUERY })).rejects.toMatchObject({ kind: "auth" });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the monthly-allowance 429", () => functionError(429, { error: "quota_exhausted", message: "x" })],
    ["the per-second 429", () => functionError(429, { error: "rate_limited", message: "x" })],
    ["a 502 (Consensus 5xx, or a Consensus 401 mapped server-side)", () => functionError(502, { error: "upstream_unavailable", message: "x" })],
    ["a 502 consensus_unavailable", () => functionError(502, { error: "consensus_unavailable", message: "x" })],
    ["a 504 timeout", () => functionError(504, { error: "upstream_timeout", message: "x" })],
    ["a 503 not_configured", () => functionError(503, { error: "not_configured", message: "x" })],
    ["a 403 forbidden", () => functionError(403, { error: "forbidden", message: "x" })],
    ["a 400 validation error", () => functionError(400, { error: "invalid_request", message: "x" })],
    ["a 500 access-check failure", () => functionError(500, { error: "access_check_failed", message: "x" })],
    ["a refused filtered search (Consensus 403)", () => functionError(422, { error: "filters_not_allowed", message: "x" })],
    ["filters Consensus did not accept (Consensus 400/422)", () => functionError(422, { error: "filters_rejected", message: "x" })],
    [
      "a transport error whose message merely mentions 401/JWT",
      () => ({ data: null, error: Object.assign(new Error("FunctionsFetchError: 401 Invalid JWT"), { context: new TypeError("x") }) }),
    ],
    ["a network failure", () => ({ data: null, error: new Error("Failed to send a request to the Edge Function") })],
  ])("never retries %s", async (_label, make) => {
    mockInvoke.mockResolvedValue(make());
    await expect(searchConsensus({ query: QUERY })).rejects.toBeInstanceOf(ConsensusSearchError);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Error kinds
// ══════════════════════════════════════════════════════════════════════════

describe("searchConsensus — error kinds", () => {
  it.each([
    [403, "forbidden", "forbidden"],
    [400, "invalid_request", "validation"],
    [503, "not_configured", "not_configured"],
    [429, "quota_exhausted", "quota_exhausted"],
    [429, "rate_limited", "rate_limited"],
    [422, "filters_not_allowed", "filters_not_allowed"],
    [422, "filters_rejected", "filters_rejected"],
    [502, "consensus_unavailable", "upstream"],
    [502, "upstream_unavailable", "upstream"],
    [504, "upstream_timeout", "upstream"],
    [500, "access_check_failed", "unexpected"],
    [500, "internal_error", "unexpected"],
  ])("maps HTTP %i %s to kind %s and keeps the function's own copy", async (status, code, kind) => {
    mockInvoke.mockResolvedValue(functionError(status, { error: code, message: `Copy for ${code}.` }));
    await expect(searchConsensus({ query: QUERY })).rejects.toMatchObject({ kind, message: `Copy for ${code}.` });
  });

  it.each([
    [429, "rate_limited", "Consensus is receiving requests too quickly. Please wait a moment and try again."],
    [403, "forbidden", "Consensus search is not available for this account."],
    [400, "validation", "That search could not be run."],
    [502, "upstream", "Consensus could not be reached right now. Please try again in a moment."],
    [404, "unexpected", "Consensus search failed. Please try again."],
  ])("falls back to its own copy for HTTP %i with an unrecognized body — never showing gateway text", async (status, kind, message) => {
    mockInvoke.mockResolvedValue(functionError(status, { error: "something_else", message: "<gateway says: internal detail>" }));
    await expect(searchConsensus({ query: QUERY })).rejects.toMatchObject({ kind, message });
  });

  it("handles a non-JSON error body by status", async () => {
    mockInvoke.mockResolvedValue(functionError(503, "<html>Service Unavailable</html>"));
    await expect(searchConsensus({ query: QUERY })).rejects.toMatchObject({ kind: "upstream" });
  });

  it("reports a failure without a Response as unexpected, with safe copy", async () => {
    mockInvoke.mockResolvedValue({ data: null, error: new Error("Failed to send a request to the Edge Function") });
    await expect(searchConsensus({ query: QUERY })).rejects.toMatchObject({
      kind: "unexpected",
      message: "Consensus search failed. Please try again.",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Defensive response parsing
// ══════════════════════════════════════════════════════════════════════════

describe("searchConsensus — response parsing", () => {
  it.each([
    ["null", null],
    ["a string", "results"],
    ["an array", [edgeResult()]],
    ["an object without results", { items: [] }],
    ["results that is not an array", { results: { 0: edgeResult() } }],
  ])("fails safely on %s", async (_label, data) => {
    mockInvoke.mockResolvedValue({ data, error: null });
    await expect(searchConsensus({ query: QUERY })).rejects.toMatchObject({
      kind: "unexpected",
      message: "Consensus search returned an unexpected response. Please try again.",
    });
  });

  it("re-validates importDoi on this side: an invalid DOI from the server is never selectable", async () => {
    mockInvoke.mockResolvedValue({
      data: {
        results: [
          edgeResult({ importDoi: "10.5555/Keep.Spelling" }),
          edgeResult({ importDoi: "doi:10.5555/x" }),
          edgeResult({ importDoi: "https://doi.org/10.5555/x" }),
          edgeResult({ importDoi: "10.5555" }),
          edgeResult({ importDoi: "10.5555/a b" }),
          edgeResult({ importDoi: 42 }),
          edgeResult({ importDoi: null }),
        ],
      },
      error: null,
    });

    const { results } = await searchConsensus({ query: QUERY });
    expect(results.map((r) => r.importDoi)).toEqual(["10.5555/Keep.Spelling", null, null, null, null, null, null]);
  });

  it("re-validates the Consensus link on this side", async () => {
    mockInvoke.mockResolvedValue({
      data: {
        results: [
          edgeResult({ consensusUrl: "javascript:alert(1)" }),
          edgeResult({ consensusUrl: "https://consensus.app.evil.example/papers/x/" }),
          edgeResult(),
        ],
      },
      error: null,
    });
    const { results } = await searchConsensus({ query: QUERY });
    expect(results.map((r) => r.consensusUrl)).toEqual([
      null,
      null,
      "https://consensus.app/papers/synthetic-slug/0123456789abcdef0123456789abcdef/?utm_source=publicapi",
    ]);
  });

  it("drops non-object entries, degrades malformed fields, ignores unknown fields and numbers rows positionally", async () => {
    mockInvoke.mockResolvedValue({
      data: {
        results: [
          null,
          edgeResult({ rank: 99, title: 7, authors: ["Ada", 3, ""], year: "2024", citationCount: 1.5, raw_upstream: "leak" }),
          "x",
          edgeResult({ rank: 99, title: "Second" }),
        ],
      },
      error: null,
    });
    const { results } = await searchConsensus({ query: QUERY });
    expect(results.map((r) => r.rank)).toEqual([1, 2]);
    expect(results[0]).toMatchObject({ title: null, authors: ["Ada"], year: null, citationCount: null });
    expect(results[0]).not.toHaveProperty("raw_upstream");
    expect(results[1].title).toBe("Second");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Selection identity helpers
// ══════════════════════════════════════════════════════════════════════════

describe("selection identity", () => {
  it("keys DOI-equivalent spellings identically (ASCII case only)", () => {
    expect(consensusSelectionKey("10.5555/ABC")).toBe(consensusSelectionKey("10.5555/abc"));
    expect(consensusSelectionKey("10.5555/Á")).not.toBe(consensusSelectionKey("10.5555/á"));
  });

  it("toImportableDoi preserves the original spelling and refuses repairs", () => {
    expect(toImportableDoi("10.5555/MiXeD")).toBe("10.5555/MiXeD");
    expect(toImportableDoi(" 10.5555/x")).toBeNull();
    expect(toImportableDoi("DOI: 10.5555/x")).toBeNull();
  });
});
