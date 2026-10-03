// @vitest-environment node
//
// Runs the real Edge handler (Deno-free by construction) behind the mocked
// `supabase.functions.invoke`, so Node's `Request`/`Response`/`AbortSignal`
// are what the handler sees — the same web APIs the Edge runtime provides.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke, mockGetSession, mockRefreshSession } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockGetSession: vi.fn(),
  mockRefreshSession: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: mockInvoke },
    auth: { getSession: mockGetSession, refreshSession: mockRefreshSession },
  },
}));

import { searchConsensus } from "../searchConsensusEdge";
import { handleSearchConsensusRequest } from "../../../supabase/functions/search-consensus/handler.ts";
import { consensusEnvelope, consensusResult } from "../../../supabase/functions/_shared/__tests__/fixtures/consensusSearchResponse.ts";

/**
 * CONSENSUS-SEARCH-MVP-001A — one Search press costs at most ONE Consensus call.
 *
 * The browser wrapper may retry once after a PaperLume 401. That retry is only
 * free because the Edge Function answers 401 before it reads its key or calls
 * Consensus. Each half is unit-tested on its own; this suite wires the real
 * wrapper to the real handler and counts the upstream requests the handler
 * actually makes, so the property is proven end to end rather than inferred.
 */

const QUERY = "Does creatine improve cognition in healthy adults?";

function session(token: string) {
  return { data: { session: { access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null };
}

/**
 * Route `supabase.functions.invoke("search-consensus", …)` into the real
 * handler, emulating supabase-js: a 2xx resolves `{ data }`, anything else
 * resolves `{ error }` whose `context` is the function's `Response`.
 */
function wireRealHandler(options: {
  validTokens: ReadonlySet<string>;
  role: string;
  upstream: () => Response | Error;
}): { upstreamCalls: string[] } {
  const upstreamCalls: string[] = [];
  mockInvoke.mockImplementation(async (name: string, init: { body: unknown; headers: Record<string, string> }) => {
    const request = new Request(`https://edge.test/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...init.headers },
      body: JSON.stringify(init.body),
    });
    const response = await handleSearchConsensusRequest(request, {
      createCallerClient: (authHeader) => ({
        auth: {
          getUser: async () =>
            options.validTokens.has(authHeader.replace(/^Bearer /, ""))
              ? { data: { user: { id: "11111111-2222-3333-4444-555555555555" } }, error: null }
              : { data: { user: null }, error: { message: "invalid JWT" } },
        },
        rpc: async () => ({ data: [{ role: options.role }], error: null }),
      }),
      readApiKey: () => "fake-consensus-key-for-tests-0000",
      fetchImpl: async (url) => {
        upstreamCalls.push(url);
        const next = options.upstream();
        if (next instanceof Error) throw next;
        return next;
      },
      timeoutSignal: () => new AbortController().signal,
      logger: { log() {}, warn() {}, error() {} },
    });
    if (response.ok) return { data: await response.json(), error: null };
    return {
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { context: response }),
    };
  });
  return { upstreamCalls };
}

const ok = () =>
  new Response(JSON.stringify(consensusEnvelope([consensusResult()])), {
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("one Search press, at most one Consensus call", () => {
  it("a stale token is refreshed and retried once — and Consensus is called exactly once", async () => {
    mockGetSession.mockResolvedValue(session("stale-token"));
    mockRefreshSession.mockResolvedValue(session("fresh-token"));
    const { upstreamCalls } = wireRealHandler({ validTokens: new Set(["fresh-token"]), role: "owner", upstream: ok });

    const response = await searchConsensus({ query: QUERY });

    expect(response.results).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(upstreamCalls).toHaveLength(1);
  });

  it.each([
    ["a Consensus 401 (rejected key)", () => new Response("{}", { status: 401 }), "upstream"],
    ["a Consensus 429", () => new Response('{"detail":"Too many requests"}', { status: 429 }), "rate_limited"],
    ["a Consensus 500", () => new Response("{}", { status: 500 }), "upstream"],
    ["a network failure", () => new TypeError("fetch failed"), "upstream"],
  ])("%s is reported once and never retried — by the client or the server", async (_label, upstream, kind) => {
    mockGetSession.mockResolvedValue(session("fresh-token"));
    const { upstreamCalls } = wireRealHandler({ validTokens: new Set(["fresh-token"]), role: "owner", upstream });

    await expect(searchConsensus({ query: QUERY })).rejects.toMatchObject({ kind });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockRefreshSession).not.toHaveBeenCalled();
    expect(upstreamCalls).toHaveLength(1);
  });

  it("a non-owner never reaches Consensus, even across the auth retry", async () => {
    mockGetSession.mockResolvedValue(session("stale-token"));
    mockRefreshSession.mockResolvedValue(session("fresh-token"));
    const { upstreamCalls } = wireRealHandler({ validTokens: new Set(["fresh-token"]), role: "manager", upstream: ok });

    await expect(searchConsensus({ query: QUERY })).rejects.toMatchObject({ kind: "forbidden" });

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("an unrecoverable session costs two Edge requests and zero Consensus calls", async () => {
    mockGetSession.mockResolvedValue(session("stale-token"));
    mockRefreshSession.mockResolvedValue(session("also-invalid"));
    const { upstreamCalls } = wireRealHandler({ validTokens: new Set(), role: "owner", upstream: ok });

    await expect(searchConsensus({ query: QUERY })).rejects.toMatchObject({ kind: "auth" });

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(upstreamCalls).toHaveLength(0);
  });
});
