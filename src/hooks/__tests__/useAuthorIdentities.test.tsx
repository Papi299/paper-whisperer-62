import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * What the identity read KNOWS, and the one confusion that must never happen.
 *
 * Two situations leave a consumer with no identity data, and they mean opposite
 * things:
 *
 *   `unavailable`  this environment predates the 001C migration. Expected,
 *                  benign, and 001A grouping is the correct answer.
 *   `failed`       we could not read this user's identity decisions.
 *
 * Collapsing the second into the first is the quiet failure this file exists to
 * prevent. A user who has resolved two spellings into one person would watch
 * them silently split back apart, be told nothing, and have no reason to suspect
 * anything went wrong — a screen that looks correct and is not.
 *
 * The rest follows from that: a caller who could not read the graph must not be
 * allowed to write to it, and known-good data is worth keeping on screen only if
 * it is labelled as last-known.
 */

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { useAuthorIdentities } from "../useAuthorIdentities";

const USER = "user-a";

const IDENTITY_TABLES = [
  "author_identities",
  "author_identity_aliases",
  "author_identity_links",
  "author_identity_merges",
] as const;

interface TableResult {
  data: unknown[] | null;
  error: unknown;
}

/** Per-table responses for the next render. Mutated between assertions. */
let responses: Record<string, TableResult> = {};

function resultFor(table: string): TableResult {
  return responses[table] ?? { data: [], error: null };
}

/**
 * A minimal PostgREST double.
 *
 * The four identity reads are awaited directly, so the builder is thenable; the
 * linked-paper read goes through `fetchAllPages`, so it also answers `.range()`.
 */
function buildQuery(table: string) {
  const settle = () => Promise.resolve(resultFor(table));
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    range: () => settle(),
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      settle().then(onFulfilled, onRejected),
  };
  return chain;
}

/** A PostgREST "no such table" error — the one tolerated condition. */
function missingTable(table: string) {
  return {
    code: "PGRST205",
    message: `Could not find the table 'public.${table}' in the schema cache`,
    details: null,
    hint: null,
  };
}

function wrapper() {
  // No retries: a failing read must surface on the first attempt so the test is
  // about classification rather than about backoff timing.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

async function renderIdentities() {
  const view = renderHook(() => useAuthorIdentities(USER), { wrapper: wrapper() });
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  responses = {};
  mockFrom.mockImplementation((table: string) => buildQuery(table));
  mockRpc.mockResolvedValue({ data: null, error: null });
});

describe("useAuthorIdentities — read states", () => {
  it("reports a healthy read as ready and allows decisions", async () => {
    responses = {
      author_identities: {
        data: [{ id: "id-1", preferred_name: "Stuart M Phillips" }],
        error: null,
      },
    };

    const { result } = await renderIdentities();

    expect(result.current.readState).toBe("ready");
    expect(result.current.canMutate).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.isUnavailable).toBe(false);
    expect(result.current.dataset?.identities).toHaveLength(1);
  });

  it("reports the missing 001C schema as unavailable, not as an error", async () => {
    for (const table of IDENTITY_TABLES) responses[table] = { data: null, error: missingTable(table) };

    const { result } = await renderIdentities();

    expect(result.current.readState).toBe("unavailable");
    expect(result.current.isUnavailable).toBe(true);
    // Not an error: consumers fall back to 001A and say nothing alarming.
    expect(result.current.error).toBeNull();
    expect(result.current.dataset).toBeNull();
    // But still not a state anything may be written from.
    expect(result.current.canMutate).toBe(false);
  });

  it("reports a permission failure as failed — never as unavailable", async () => {
    responses.author_identities = {
      data: null,
      error: { code: "42501", message: "permission denied for table author_identities" },
    };

    const { result } = await renderIdentities();

    expect(result.current.readState).toBe("failed");
    expect(result.current.isUnavailable).toBe(false);
    expect(result.current.error).not.toBeNull();
    expect(result.current.dataset).toBeNull();
    expect(result.current.canMutate).toBe(false);
  });

  it("reports a network failure as failed", async () => {
    responses.author_identities = { data: null, error: new TypeError("Failed to fetch") };

    const { result } = await renderIdentities();

    expect(result.current.readState).toBe("failed");
    expect(result.current.isUnavailable).toBe(false);
    expect(result.current.canMutate).toBe(false);
  });

  it("reports a linked-paper evidence failure as failed, though the identity reads succeeded", async () => {
    // The evidence read is the second half of one atomic unit. Decisions without
    // the papers that explain them would render people as empty and offer a
    // Delete the database refuses — so a half-read is a failed read.
    responses = {
      author_identities: { data: [{ id: "id-1", preferred_name: "Stuart M Phillips" }], error: null },
      author_identity_links: {
        data: [
          {
            id: "ln-1",
            identity_id: "id-1",
            paper_id: "p1",
            author_index: 0,
            author_name_snapshot: "Stuart M Phillips",
            resolution_basis: "manual",
          },
        ],
        error: null,
      },
      papers: { data: null, error: { code: "42501", message: "permission denied for table papers" } },
    };

    const { result } = await renderIdentities();

    expect(result.current.readState).toBe("failed");
    expect(result.current.isUnavailable).toBe(false);
    expect(result.current.dataset).toBeNull();
    expect(result.current.linkedPapers).toEqual([]);
    expect(result.current.canMutate).toBe(false);
  });

  it("keeps the last known-good graph on a failed REFETCH, and calls it stale", async () => {
    responses.author_identities = {
      data: [{ id: "id-1", preferred_name: "Stuart M Phillips" }],
      error: null,
    };
    const { result } = await renderIdentities();
    expect(result.current.readState).toBe("ready");

    responses.author_identities = {
      data: null,
      error: { code: "42501", message: "permission denied for table author_identities" },
    };
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.readState).toBe("stale"));

    // Known-good data is worth keeping — discarding it would cost the user
    // everything they came to see. It is simply no longer authoritative.
    expect(result.current.dataset?.identities).toHaveLength(1);
    expect(result.current.error).not.toBeNull();
    expect(result.current.isUnavailable).toBe(false);
    expect(result.current.canMutate).toBe(false);
  });

  it("returns to ready when a retry succeeds", async () => {
    responses.author_identities = {
      data: null,
      error: { code: "42501", message: "permission denied for table author_identities" },
    };
    const { result } = await renderIdentities();
    expect(result.current.readState).toBe("failed");

    responses.author_identities = {
      data: [{ id: "id-1", preferred_name: "Stuart M Phillips" }],
      error: null,
    };
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.readState).toBe("ready"));
    expect(result.current.canMutate).toBe(true);
    expect(result.current.error).toBeNull();
  });
});

describe("useAuthorIdentities — mutations are gated on a trustworthy graph", () => {
  it("refuses a write when the read failed, without reaching the server", async () => {
    responses.author_identities = {
      data: null,
      error: { code: "42501", message: "permission denied for table author_identities" },
    };
    const { result } = await renderIdentities();

    await expect(
      result.current.linkMention({
        paperId: "p1",
        authorIndex: 0,
        expectedAuthor: "Stuart M Phillips",
        identityId: "id-1",
        resolutionBasis: "manual",
      }),
    ).rejects.toThrow();

    // The point is that it never asked. A mutation validates against the CURRENT
    // graph, and this caller could not read it.
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("refuses a write from the stale state too", async () => {
    responses.author_identities = {
      data: [{ id: "id-1", preferred_name: "Stuart M Phillips" }],
      error: null,
    };
    const { result } = await renderIdentities();

    responses.author_identities = {
      data: null,
      error: { code: "42501", message: "permission denied" },
    };
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.readState).toBe("stale"));

    await expect(result.current.unmergeIdentity("id-1")).rejects.toThrow();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("refuses a write when the schema is absent, and says so in those terms", async () => {
    for (const table of IDENTITY_TABLES) responses[table] = { data: null, error: missingTable(table) };
    const { result } = await renderIdentities();

    await expect(result.current.deleteIdentity("id-1")).rejects.toThrow();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Author identities are not available in this environment yet.",
      }),
    );
  });

  it("lets a write through once the graph is readable", async () => {
    responses.author_identities = {
      data: [{ id: "id-1", preferred_name: "Stuart M Phillips" }],
      error: null,
    };
    const { result } = await renderIdentities();

    await result.current.unmergeIdentity("id-1");

    expect(mockRpc).toHaveBeenCalledWith("unmerge_author_identity", {
      p_source_identity_id: "id-1",
    });
  });

  it("asks the server to displace only a provably stale link", async () => {
    responses.author_identities = { data: [], error: null };
    mockRpc.mockResolvedValue({ data: { identity_id: "new-id" }, error: null });
    const { result } = await renderIdentities();

    await result.current.createIdentityFromMention({
      paperId: "p1",
      authorIndex: 0,
      expectedAuthor: "Current Author",
      preferredName: "Repaired Person",
      replaceStaleExisting: true,
    });

    expect(mockRpc).toHaveBeenCalledWith(
      "create_author_identity_from_mention",
      expect.objectContaining({ p_replace_stale_existing: true }),
    );
  });

  it("defaults the stale-replacement flag off", async () => {
    responses.author_identities = { data: [], error: null };
    mockRpc.mockResolvedValue({ data: { identity_id: "new-id" }, error: null });
    const { result } = await renderIdentities();

    await result.current.createIdentityFromMention({
      paperId: "p1",
      authorIndex: 0,
      expectedAuthor: "Current Author",
    });

    expect(mockRpc).toHaveBeenCalledWith(
      "create_author_identity_from_mention",
      expect.objectContaining({ p_replace_stale_existing: false }),
    );
  });
});
