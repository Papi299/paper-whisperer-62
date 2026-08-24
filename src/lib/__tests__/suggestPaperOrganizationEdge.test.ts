/**
 * `suggestPaperOrganization` — the typed client wrapper for the already-live
 * `suggest-paper-organization` Edge Function (AI-PROJECT-TAG-SUGGESTIONS-001B).
 *
 * The three properties these tests exist to hold:
 *
 *   1. **Privacy.** The request carries the seven allow-listed values and
 *      nothing else — no authors, notes, DOI, user id or quota state.
 *   2. **Identity.** No string the model authored can become a selectable
 *      database id. An `existingProjects` entry without a server-resolved `id`
 *      is dropped, and a `ref` is never read as one.
 *   3. **Honest failure.** A Google 429/503 stays a provider failure and never
 *      becomes the user's plan wall, and no upstream body reaches the message.
 *
 * No real network: `supabase.functions.invoke` and the auth surface are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Supabase mock (hoisted) ────────────────────────────────────────────
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

import {
  suggestPaperOrganization,
  parseSuggestions,
  isEmptySuggestions,
  buildSuggestOrganizationBody,
  SuggestOrganizationError,
  SUGGEST_ORGANIZATION_FUNCTION,
} from "@/lib/suggestPaperOrganizationEdge";

// ── Helpers ────────────────────────────────────────────────────────────

const PAPER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TAG_ID = "33333333-3333-4333-8333-333333333333";

function validSession(token = "valid-token") {
  return {
    data: {
      session: { access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600 },
    },
  };
}

/** A session that expires inside the two-minute freshness window. */
function staleSession(token = "nearly-expired") {
  return {
    data: {
      session: { access_token: token, expires_at: Math.floor(Date.now() / 1000) + 30 },
    },
  };
}

/** Build a `FunctionsHttpError`-like rejection with a real `Response` context. */
function httpError(status: number, body: unknown) {
  return {
    message: "Edge Function returned a non-2xx status code",
    context: new Response(JSON.stringify(body), { status }),
  };
}

const FULL_RESPONSE = {
  existingProjects: [{ id: PROJECT_ID, name: "Sarcopenia", reason: "Matches the trial cohort." }],
  existingTags: [{ id: TAG_ID, name: "RCT", reason: "The abstract describes randomisation." }],
  newProjects: [
    { name: "Resistance Training", description: "Strength interventions.", reason: "Recurring theme." },
  ],
  newTags: [{ name: "older-adults", reason: "The cohort is 65+." }],
};

/** The canonical input used across the request-shape tests. */
const INPUT = {
  paperId: PAPER_ID,
  draft: {
    title: "Unsaved title",
    abstract: "Unsaved abstract",
    keywords: ["unsaved-keyword"],
    studyType: "RCT",
  },
  currentProjectIds: [PROJECT_ID],
  currentTagIds: [TAG_ID],
};

describe("suggestPaperOrganization — request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(validSession());
    mockRefreshSession.mockResolvedValue(validSession("refreshed-token"));
    mockInvoke.mockResolvedValue({ data: FULL_RESPONSE, error: null });
  });

  it("invokes the deployed function slug exactly once", async () => {
    await suggestPaperOrganization(INPUT);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][0]).toBe("suggest-paper-organization");
    expect(SUGGEST_ORGANIZATION_FUNCTION).toBe("suggest-paper-organization");
  });

  it("sends the CURRENT UNSAVED draft values, not a stored row", async () => {
    await suggestPaperOrganization(INPUT);
    const body = mockInvoke.mock.calls[0][1].body;
    expect(body.draft).toEqual({
      title: "Unsaved title",
      abstract: "Unsaved abstract",
      keywords: ["unsaved-keyword"],
      studyType: "RCT",
    });
  });

  it("sends the current local Project/Tag selection ids", async () => {
    await suggestPaperOrganization(INPUT);
    const body = mockInvoke.mock.calls[0][1].body;
    expect(body.currentProjectIds).toEqual([PROJECT_ID]);
    expect(body.currentTagIds).toEqual([TAG_ID]);
  });

  it("carries ONLY the allow-listed fields — no unrelated paper or user data", async () => {
    await suggestPaperOrganization(INPUT);
    const body = mockInvoke.mock.calls[0][1].body;

    expect(Object.keys(body).sort()).toEqual(
      ["currentProjectIds", "currentTagIds", "draft", "paperId"].sort(),
    );
    expect(Object.keys(body.draft).sort()).toEqual(
      ["abstract", "keywords", "studyType", "title"].sort(),
    );

    // The fields that must never leave the browser for this feature.
    const forbidden = [
      "authors", "journal", "notes", "tldr", "statisticalMethods", "statistical_methods",
      "pmid", "doi", "pubmedUrl", "pubmed_url", "driveUrl", "drive_url", "attachments",
      "userId", "user_id", "email", "quota", "quotaStatus", "year",
    ];
    const serialized = JSON.stringify(body);
    for (const field of forbidden) {
      expect(body).not.toHaveProperty(field);
      expect(body.draft).not.toHaveProperty(field);
      expect(serialized).not.toContain(`"${field}"`);
    }
  });

  it("sends an explicit Authorization bearer header", async () => {
    await suggestPaperOrganization(INPUT);
    expect(mockInvoke.mock.calls[0][1].headers).toEqual({
      Authorization: "Bearer valid-token",
    });
  });

  it("uses a still-valid session token without spending a refresh", async () => {
    await suggestPaperOrganization(INPUT);
    expect(mockRefreshSession).not.toHaveBeenCalled();
    expect(mockInvoke.mock.calls[0][1].headers.Authorization).toBe("Bearer valid-token");
  });

  it("refreshes up front when the session is about to expire", async () => {
    mockGetSession.mockResolvedValue(staleSession());
    await suggestPaperOrganization(INPUT);
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][1].headers.Authorization).toBe("Bearer refreshed-token");
  });

  it("throws an auth error without invoking when there is no usable session", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    mockRefreshSession.mockResolvedValue({ data: { session: null }, error: { message: "no session" } });

    await expect(suggestPaperOrganization(INPUT)).rejects.toMatchObject({ kind: "auth" });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("normalizes a blank abstract/studyType to null rather than sending whitespace", async () => {
    await suggestPaperOrganization({
      paperId: PAPER_ID,
      draft: { title: "T", abstract: "   ", keywords: [], studyType: "  " },
    });
    const body = mockInvoke.mock.calls[0][1].body;
    expect(body.draft.abstract).toBeNull();
    expect(body.draft.studyType).toBeNull();
    expect(body.currentProjectIds).toEqual([]);
    expect(body.currentTagIds).toEqual([]);
  });
});

describe("suggestPaperOrganization — 401 refresh and retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(validSession());
    mockRefreshSession.mockResolvedValue(validSession("refreshed-token"));
  });

  it("refreshes once and retries once on a genuine HTTP 401", async () => {
    mockInvoke
      .mockResolvedValueOnce({ data: null, error: httpError(401, { error: "unauthenticated" }) })
      .mockResolvedValueOnce({ data: FULL_RESPONSE, error: null });

    const result = await suggestPaperOrganization(INPUT);

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[1][1].headers.Authorization).toBe("Bearer refreshed-token");
    expect(result.existingProjects).toHaveLength(1);
  });

  it("stops after a SECOND 401 — never an authentication loop", async () => {
    mockInvoke.mockResolvedValue({ data: null, error: httpError(401, { error: "unauthenticated" }) });

    await expect(suggestPaperOrganization(INPUT)).rejects.toMatchObject({ kind: "auth" });

    // Exactly two attempts: the original and the single retry.
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
  });

  it("does NOT spend a refresh on a 500 whose body merely contains '401'", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(500, {
        error: "suggestions_unavailable",
        code: "provider_unavailable",
        message: "Suggestions are temporarily unavailable. Please try again later.",
        detail: "upstream said 401 somewhere",
      }),
    });

    await expect(suggestPaperOrganization(INPUT)).rejects.toMatchObject({
      kind: "provider_failure",
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });
});

describe("suggestPaperOrganization — success parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(validSession());
    mockRefreshSession.mockResolvedValue(validSession("refreshed-token"));
  });

  it("parses a valid four-array response", async () => {
    mockInvoke.mockResolvedValue({ data: FULL_RESPONSE, error: null });
    const result = await suggestPaperOrganization(INPUT);

    expect(result.existingProjects).toEqual([
      { id: PROJECT_ID, name: "Sarcopenia", reason: "Matches the trial cohort." },
    ]);
    expect(result.existingTags[0].id).toBe(TAG_ID);
    expect(result.newProjects[0]).toEqual({
      name: "Resistance Training",
      description: "Strength interventions.",
      reason: "Recurring theme.",
    });
    expect(result.newTags[0]).toEqual({ name: "older-adults", reason: "The cohort is 65+." });
  });

  it("treats an all-empty response as a SUCCESS, not an error", async () => {
    mockInvoke.mockResolvedValue({
      data: { existingProjects: [], existingTags: [], newProjects: [], newTags: [] },
      error: null,
    });

    const result = await suggestPaperOrganization(INPUT);
    expect(isEmptySuggestions(result)).toBe(true);
  });

  it("keeps a null new-Project description as null", async () => {
    mockInvoke.mockResolvedValue({
      data: {
        ...FULL_RESPONSE,
        newProjects: [{ name: "P", description: null, reason: "r" }],
      },
      error: null,
    });
    const result = await suggestPaperOrganization(INPUT);
    expect(result.newProjects[0].description).toBeNull();
  });

  it("rejects a response missing a whole category rather than guessing", async () => {
    mockInvoke.mockResolvedValue({
      data: { existingProjects: [], existingTags: [], newProjects: [] },
      error: null,
    });
    await expect(suggestPaperOrganization(INPUT)).rejects.toMatchObject({ kind: "unexpected" });
  });

  it("rejects a non-object response body", async () => {
    mockInvoke.mockResolvedValue({ data: "nope", error: null });
    await expect(suggestPaperOrganization(INPUT)).rejects.toMatchObject({ kind: "unexpected" });
  });
});

describe("parseSuggestions — identity safety", () => {
  const EMPTY = { existingProjects: [], existingTags: [], newProjects: [], newTags: [] };

  it("drops an existing suggestion carrying a model ref instead of a real id", () => {
    // `P1` is the request-local ref the server uses with the model. It must
    // never be interpreted as a database id — but equally, a ref that leaked
    // through cannot be repaired into one, so the entry is discarded.
    const parsed = parseSuggestions({
      ...EMPTY,
      existingProjects: [{ ref: "P1", name: "Sarcopenia", reason: "because" }],
    });
    expect(parsed?.existingProjects).toEqual([]);
  });

  it("drops an existing suggestion with a non-string id", () => {
    const parsed = parseSuggestions({
      ...EMPTY,
      existingTags: [{ id: 7, name: "RCT", reason: "because" }],
    });
    expect(parsed?.existingTags).toEqual([]);
  });

  it("drops an existing suggestion with a blank id", () => {
    const parsed = parseSuggestions({
      ...EMPTY,
      existingProjects: [{ id: "   ", name: "X", reason: "because" }],
    });
    expect(parsed?.existingProjects).toEqual([]);
  });

  it("drops entries without a usable reason but keeps their well-formed neighbours", () => {
    const parsed = parseSuggestions({
      ...EMPTY,
      existingProjects: [
        { id: PROJECT_ID, name: "Kept", reason: "a real reason" },
        { id: "44444444-4444-4444-8444-444444444444", name: "Dropped", reason: "" },
      ],
    });
    expect(parsed?.existingProjects.map((p) => p.name)).toEqual(["Kept"]);
  });

  it("drops a reason longer than the rendered bound", () => {
    const parsed = parseSuggestions({
      ...EMPTY,
      existingProjects: [{ id: PROJECT_ID, name: "X", reason: "x".repeat(401) }],
    });
    expect(parsed?.existingProjects).toEqual([]);
  });

  it("drops a new-Project proposal whose description is neither string nor null", () => {
    const parsed = parseSuggestions({
      ...EMPTY,
      newProjects: [{ name: "X", description: 5, reason: "because" }],
    });
    expect(parsed?.newProjects).toEqual([]);
  });

  it("drops a nameless new-Tag proposal", () => {
    const parsed = parseSuggestions({ ...EMPTY, newTags: [{ name: "  ", reason: "because" }] });
    expect(parsed?.newTags).toEqual([]);
  });

  it("returns null when a category is not an array", () => {
    expect(parseSuggestions({ ...EMPTY, newTags: "nope" })).toBeNull();
    expect(parseSuggestions(null)).toBeNull();
    expect(parseSuggestions([])).toBeNull();
  });
});

describe("suggestPaperOrganization — typed failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(validSession());
    mockRefreshSession.mockResolvedValue(validSession("refreshed-token"));
  });

  it("HTTP 400 surfaces the server's own deliberate validation copy", async () => {
    const serverMessage =
      "Add an abstract, keywords, or a study type before requesting suggestions — a title alone is not enough.";
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(400, {
        error: "invalid_request",
        message: serverMessage,
        reason: "insufficient_evidence",
      }),
    });

    const err = await suggestPaperOrganization(INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(SuggestOrganizationError);
    expect(err.kind).toBe("validation");
    expect(err.message).toBe(serverMessage);
  });

  it("HTTP 404 gives a neutral paper-not-found message", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(404, {
        error: "paper_not_found",
        message: "That paper could not be found.",
      }),
    });

    const err = await suggestPaperOrganization(INPUT).catch((e) => e);
    expect(err.kind).toBe("paper_not_found");
    expect(err.message).toBe("That paper could not be found.");
  });

  it("HTTP 402 is the Paperlume allowance wall, with structured quota details", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(402, {
        error: "quota_exceeded",
        message: "AI quota exceeded.",
        details: {
          plan: "free",
          period_type: "lifetime",
          used: 15,
          quota: 15,
          remaining: 0,
          reset_at: null,
        },
      }),
    });

    const err = await suggestPaperOrganization(INPUT).catch((e) => e);
    expect(err.kind).toBe("quota_exceeded");
    expect(err.quota).toMatchObject({
      plan: "free",
      periodType: "lifetime",
      used: 15,
      quota: 15,
      remaining: 0,
    });
  });

  it("HTTP 500 suggestions_unavailable is a PROVIDER failure, never a quota wall", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(500, {
        error: "suggestions_unavailable",
        code: "provider_rate_limit",
        message: "Suggestions are temporarily unavailable. Please try again later.",
      }),
    });

    const err = await suggestPaperOrganization(INPUT).catch((e) => e);
    expect(err.kind).toBe("provider_failure");
    expect(err.kind).not.toBe("quota_exceeded");
    expect(err.quota).toBeNull();
    // Not a word about the user's plan.
    expect(err.message).not.toMatch(/quota|plan|used all|allowance|upgrade/i);
  });

  it.each(["provider_rate_limit", "provider_unavailable", "malformed_response", "unknown"])(
    "provider class '%s' stays a provider failure",
    async (code) => {
      mockInvoke.mockResolvedValue({
        data: null,
        error: httpError(500, {
          error: "suggestions_unavailable",
          code,
          message: "Suggestions are temporarily unavailable. Please try again later.",
        }),
      });
      const err = await suggestPaperOrganization(INPUT).catch((e) => e);
      expect(err.kind).toBe("provider_failure");
    },
  );

  it("never surfaces the raw provider body, machine class or upstream detail", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(500, {
        error: "suggestions_unavailable",
        code: "provider_rate_limit",
        message: "Suggestions are temporarily unavailable. Please try again later.",
        detail: "googleapis.com quota project 12345 exceeded; api_key=AIzaSyEXAMPLE",
      }),
    });

    const err = await suggestPaperOrganization(INPUT).catch((e) => e);
    expect(err.message).not.toContain("googleapis");
    expect(err.message).not.toContain("AIzaSy");
    expect(err.message).not.toContain("12345");
    expect(err.message).not.toContain("provider_rate_limit");
  });

  it("does not read an ANALYSIS provider failure as this feature's failure", async () => {
    // A body carrying `analysis_unavailable` is the other function's shape. It
    // falls through to the generic branch rather than being reported as a
    // suggestion provider failure with the analysis message.
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(500, {
        error: "analysis_unavailable",
        code: "provider_rate_limit",
        message: "AI analysis is temporarily unavailable.",
      }),
    });

    const err = await suggestPaperOrganization(INPUT).catch((e) => e);
    expect(err.kind).toBe("provider_failure");
    expect(err.message).not.toContain("analysis");
  });

  it("classifies a transport-level auth error with no Response context", async () => {
    mockInvoke.mockResolvedValue({ data: null, error: { message: "Invalid JWT" } });
    // No Response ⇒ the message fallback applies, one refresh is spent, and the
    // second identical failure ends as an auth error.
    const err = await suggestPaperOrganization(INPUT).catch((e) => e);
    expect(err.kind).toBe("auth");
  });

  it("falls back to a generic message for an unrecognised status", async () => {
    mockInvoke.mockResolvedValue({ data: null, error: httpError(418, { nope: true }) });
    const err = await suggestPaperOrganization(INPUT).catch((e) => e);
    expect(err.kind).toBe("unexpected");
    expect(err.message.length).toBeGreaterThan(0);
  });
});

describe("buildSuggestOrganizationBody", () => {
  it("is the single privacy boundary and copies nothing it was not asked for", () => {
    const body = buildSuggestOrganizationBody({
      paperId: PAPER_ID,
      // Extra fields on the draft object must not survive the copy.
      draft: {
        title: "T",
        abstract: "A",
        keywords: ["k"],
        studyType: "RCT",
        notes: "secret",
        authors: ["Someone"],
      } as never,
    });

    expect(body).toEqual({
      paperId: PAPER_ID,
      draft: { title: "T", abstract: "A", keywords: ["k"], studyType: "RCT" },
      currentProjectIds: [],
      currentTagIds: [],
    });
  });

  it("coerces a non-array keywords value to an empty list", () => {
    const body = buildSuggestOrganizationBody({
      paperId: PAPER_ID,
      draft: { title: "T", keywords: undefined },
    });
    expect(body.draft.keywords).toEqual([]);
  });
});
