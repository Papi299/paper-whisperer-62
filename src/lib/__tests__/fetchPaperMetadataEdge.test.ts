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

import { fetchPaperMetadata } from "../fetchPaperMetadataEdge";

// ── Helpers ────────────────────────────────────────────────────────────

/** Simulate a valid session with a token that won't expire for a while. */
function validSession(token = "valid-token") {
  return {
    data: {
      session: {
        access_token: token,
        expires_at: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      },
    },
  };
}

/** Standard edge function success response. */
function successResponse(results: unknown[]) {
  return { data: { results }, error: null };
}

describe("fetchPaperMetadataEdge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(validSession());
    mockRefreshSession.mockResolvedValue(validSession("refreshed-token"));
  });

  // ── Request body shape ───────────────────────────────────────────────

  it("sends only { identifiers } in the body — no api_key field", async () => {
    mockInvoke.mockResolvedValue(
      successResponse([
        { identifier: "12345", title: "Test Paper", source: "pubmed" },
      ])
    );

    await fetchPaperMetadata(["12345"]);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const callArgs = mockInvoke.mock.calls[0];

    // First arg: function name
    expect(callArgs[0]).toBe("fetch-paper-metadata");

    // Second arg: options object
    const options = callArgs[1];
    expect(options.body).toEqual({ identifiers: ["12345"] });

    // Explicitly verify api_key is NOT in the body
    expect(options.body).not.toHaveProperty("api_key");
    expect(options.body).not.toHaveProperty("apiKey");
  });

  it("sends Authorization header with the access token", async () => {
    mockInvoke.mockResolvedValue(successResponse([]));

    await fetchPaperMetadata(["12345"]);

    const options = mockInvoke.mock.calls[0][1];
    expect(options.headers).toEqual({
      Authorization: "Bearer valid-token",
    });
  });

  // ── Empty input ──────────────────────────────────────────────────────

  it("returns empty array for empty identifiers without any calls", async () => {
    const result = await fetchPaperMetadata([]);
    expect(result).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ── Batching ─────────────────────────────────────────────────────────

  it("batches identifiers in groups of 10", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);

    mockInvoke
      .mockResolvedValueOnce(
        successResponse(ids.slice(0, 10).map((id) => ({ identifier: id })))
      )
      .mockResolvedValueOnce(
        successResponse(ids.slice(10, 20).map((id) => ({ identifier: id })))
      )
      .mockResolvedValueOnce(
        successResponse(ids.slice(20, 25).map((id) => ({ identifier: id })))
      );

    const result = await fetchPaperMetadata(ids);

    expect(mockInvoke).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(25);

    // Verify batch sizes
    expect(mockInvoke.mock.calls[0][1].body.identifiers).toHaveLength(10);
    expect(mockInvoke.mock.calls[1][1].body.identifiers).toHaveLength(10);
    expect(mockInvoke.mock.calls[2][1].body.identifiers).toHaveLength(5);

    // Verify no batch includes api_key
    for (const call of mockInvoke.mock.calls) {
      expect(call[1].body).not.toHaveProperty("api_key");
    }
  });

  // ── Auth handling ────────────────────────────────────────────────────

  it("returns auth error results when not authenticated", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    mockRefreshSession.mockResolvedValue({
      data: { session: null },
      error: { message: "No session" },
    });

    const result = await fetchPaperMetadata(["12345", "67890"]);

    expect(result).toHaveLength(2);
    expect(result[0].error).toContain("Not authenticated");
    expect(result[1].error).toContain("Not authenticated");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("retries with a refreshed token on 401", async () => {
    // First call: auth error
    mockInvoke
      .mockResolvedValueOnce({
        data: null,
        error: new Error("401 Unauthorized"),
      })
      // Retry: success
      .mockResolvedValueOnce(
        successResponse([{ identifier: "12345", title: "Paper" }])
      );

    const result = await fetchPaperMetadata(["12345"]);

    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledTimes(2);

    // Retry should use refreshed token
    const retryHeaders = mockInvoke.mock.calls[1][1].headers;
    expect(retryHeaders.Authorization).toBe("Bearer refreshed-token");

    // Retry body should still only have identifiers
    expect(mockInvoke.mock.calls[1][1].body).toEqual({
      identifiers: ["12345"],
    });
    expect(mockInvoke.mock.calls[1][1].body).not.toHaveProperty("api_key");

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Paper");
  });

  // ── Error handling ───────────────────────────────────────────────────

  it("returns error results when edge function fails (non-auth)", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: new Error("Internal server error"),
    });

    const result = await fetchPaperMetadata(["12345"]);

    expect(result).toHaveLength(1);
    expect(result[0].error).toContain("Edge function error");
    expect(result[0].error).toContain("Internal server error");
  });

  it("handles unexpected response shape gracefully", async () => {
    mockInvoke.mockResolvedValue({
      data: { something: "unexpected" },
      error: null,
    });

    const result = await fetchPaperMetadata(["12345"]);

    expect(result).toHaveLength(1);
    expect(result[0].error).toBe("Unexpected edge function response");
  });
});
