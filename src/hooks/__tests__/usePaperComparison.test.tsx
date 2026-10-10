import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

// Every non-read surface of the client throws, so any RPC, Edge Function,
// Storage or auth use by the comparison path fails the test that triggers it.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mockFrom,
    rpc: () => {
      throw new Error("forbidden: rpc");
    },
    get functions() {
      throw new Error("forbidden: functions");
    },
    get storage() {
      throw new Error("forbidden: storage");
    },
    get auth() {
      throw new Error("forbidden: auth");
    },
  },
}));

import { usePaperComparison } from "../usePaperComparison";
import { queryKeys } from "@/lib/queryKeys";
import { COMPARISON_PAPER_SELECT } from "@/lib/paperComparison/query";
import { buildComparisonRequest } from "@/lib/paperComparison/request";
import type { ComparisonRequest, ComparisonResult } from "@/lib/paperComparison/types";
import {
  OTHER_USER_ID,
  OWNER_ID,
  makePaperRow,
  makeSparsePaperRow,
  paperId,
} from "@/lib/paperComparison/__tests__/fixtures";

interface Response {
  data: unknown;
  error: unknown;
  status: number;
}

interface Read {
  table: string;
  ops: string[];
  select?: unknown;
  inArgs?: unknown[];
  eqArgs?: unknown[];
  signal?: AbortSignal;
  respond: (response: Response) => void;
}

let reads: Read[] = [];

/** A PostgREST builder stub whose response each test controls. Writes throw. */
function installClient() {
  reads = [];
  mockFrom.mockImplementation((table: string) => {
    let respond!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const read: Read = { table, ops: [], respond };
    reads.push(read);
    const builder: Record<string, unknown> = {
      select: (columns: unknown) => {
        read.ops.push("select");
        read.select = columns;
        return builder;
      },
      in: (...args: unknown[]) => {
        read.ops.push("in");
        read.inArgs = args;
        return builder;
      },
      eq: (...args: unknown[]) => {
        read.ops.push("eq");
        read.eqArgs = args;
        return builder;
      },
      abortSignal: (signal: AbortSignal) => {
        read.ops.push("abortSignal");
        read.signal = signal;
        return response;
      },
    };
    for (const write of ["insert", "update", "upsert", "delete"]) {
      builder[write] = () => {
        throw new Error(`forbidden write: ${write}`);
      };
    }
    return builder;
  });
}

const ok = (data: unknown): Response => ({ data, error: null, status: 200 });
const failure = (status: number): Response => ({ data: null, error: { message: "synthetic failure" }, status });

function makeRequest(ownerUserId: string, ids: string[]): ComparisonRequest {
  const outcome = buildComparisonRequest({ ownerUserId, selectedIds: ids });
  if (!outcome.ok) throw new Error(`fixture request refused: ${outcome.reason}`);
  return outcome.request;
}

function makeQueryClient() {
  // The app's own defaults (App.tsx), so the hook's explicit options are what is tested.
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 5 * 60 * 1000, gcTime: 30 * 60 * 1000, retry: 1, refetchOnWindowFocus: true } },
  });
}

function render(queryClient: QueryClient, request: ComparisonRequest | null, currentUserId: string | null) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(
    (props: { request: ComparisonRequest | null; currentUserId: string | null }) =>
      usePaperComparison(props.request, props.currentUserId),
    { wrapper, initialProps: { request, currentUserId } },
  );
}

/** Advance fake time and settle promises, inside act. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function comparisonQueries(queryClient: QueryClient) {
  return queryClient.getQueryCache().findAll({ queryKey: ["paperComparison"] });
}

function titles(result: ComparisonResult | null): string[] {
  if (result?.kind !== "comparable") return [];
  return result.rows.map((row) => (row.title.value.kind === "present" ? row.title.value.value : "?"));
}

const IDS = [paperId(1), paperId(2), paperId(3)];

function ownerRows(prefix = "Synthetic") {
  return IDS.map((id, index) => makePaperRow(id, { title: `${prefix} paper ${index + 1}`, year: 2020 - index }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  installClient();
});

afterEach(() => {
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe("usePaperComparison — the read", () => {
  it("issues exactly one owner-scoped, id-bounded, cancellable read and returns a comparable result", async () => {
    const queryClient = makeQueryClient();
    const request = makeRequest(OWNER_ID, IDS);
    const { result } = render(queryClient, request, OWNER_ID);

    expect(result.current.status).toBe("loading");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      table: "papers",
      ops: ["select", "in", "eq", "abortSignal"],
      select: COMPARISON_PAPER_SELECT,
      inArgs: ["id", IDS],
      eqArgs: ["user_id", OWNER_ID],
    });
    expect(reads[0].signal).toBeInstanceOf(AbortSignal);

    reads[0].respond(ok(ownerRows()));
    await flush();

    expect(result.current.status).toBe("ready");
    expect(result.current.errorKind).toBeNull();
    expect(result.current.result?.kind).toBe("comparable");
    expect(titles(result.current.result)).toEqual(["Synthetic paper 1", "Synthetic paper 2", "Synthetic paper 3"]);
    expect(reads).toHaveLength(1);
  });

  it.each([
    ["there is no request", null, OWNER_ID],
    ["no user is signed in", "request", null],
    ["another user is signed in", "request", OTHER_USER_ID],
  ] as const)("is idle and issues no read when %s", async (_label, requestKind, currentUserId) => {
    const queryClient = makeQueryClient();
    const request = requestKind === "request" ? makeRequest(OWNER_ID, IDS) : null;
    const { result } = render(queryClient, request, currentUserId);
    await flush(5000);
    expect(result.current).toMatchObject({ status: "idle", result: null, errorKind: null });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("answers a request with no well-formed ids as insufficient without a read", async () => {
    const queryClient = makeQueryClient();
    const { result } = render(queryClient, makeRequest(OWNER_ID, ["bad-1", "bad-2"]), OWNER_ID);
    await flush();
    expect(result.current.status).toBe("ready");
    expect(result.current.result).toMatchObject({ kind: "insufficient", availableCount: 0, unavailableCount: 2 });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("does not depend on the library list cache", async () => {
    const queryClient = makeQueryClient();
    // A loaded library page that disagrees with the database: it must be neither read nor trusted.
    queryClient.setQueryData(queryKeys.papers.all(OWNER_ID).concat("list"), {
      pages: [[{ id: paperId(1), title: "Synthetic list-cache title" }]],
    });
    const { result } = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    expect(reads).toHaveLength(1);
    reads[0].respond(ok(ownerRows()));
    await flush();
    expect(titles(result.current.result)).not.toContain("Synthetic list-cache title");
    expect(titles(result.current.result)[0]).toBe("Synthetic paper 1");
  });
});

describe("usePaperComparison — owner isolation", () => {
  it("never shows a cached comparison to a different signed-in user", async () => {
    const queryClient = makeQueryClient();
    const request = makeRequest(OWNER_ID, IDS);
    const { result, rerender } = render(queryClient, request, OWNER_ID);
    reads[0].respond(ok(ownerRows()));
    await flush();
    expect(result.current.status).toBe("ready");

    rerender({ request, currentUserId: OTHER_USER_ID });
    expect(queryClient.getQueryData(queryKeys.paperComparison.session(OWNER_ID, request.sessionId, request.queryIds))).toBeDefined();
    expect(result.current).toMatchObject({ status: "idle", result: null });
    await flush(5000);
    expect(reads).toHaveLength(1);
  });

  it("reads separately for another owner and keys the cache by owner", async () => {
    const queryClient = makeQueryClient();
    const first = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    reads[0].respond(ok(ownerRows("Owner")));
    await flush();
    first.unmount();

    const second = render(queryClient, makeRequest(OTHER_USER_ID, IDS), OTHER_USER_ID);
    expect(reads).toHaveLength(2);
    expect(reads[1].eqArgs).toEqual(["user_id", OTHER_USER_ID]);
    reads[1].respond(
      ok(IDS.map((id, index) => makeSparsePaperRow(id, { user_id: OTHER_USER_ID, title: `Other paper ${index + 1}` }))),
    );
    await flush();
    expect(titles(second.result.current.result)).toEqual(["Other paper 1", "Other paper 2", "Other paper 3"]);
    for (const query of comparisonQueries(queryClient)) expect(query.queryKey[1]).toBe(OTHER_USER_ID);
  });
});

describe("usePaperComparison — lifecycle", () => {
  it("aborts the in-flight read on unmount and drops the session's data", async () => {
    const queryClient = makeQueryClient();
    const { unmount } = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    const signal = reads[0].signal!;
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);
    await flush();
    expect(comparisonQueries(queryClient)).toHaveLength(0);

    // A response arriving after cancellation changes nothing and throws nothing.
    reads[0].respond(ok(ownerRows()));
    await flush();
    expect(comparisonQueries(queryClient)).toHaveLength(0);
  });

  it("drops a loaded session's data on close and reads fresh data on reopen", async () => {
    const queryClient = makeQueryClient();
    const firstOpen = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    reads[0].respond(ok(ownerRows("First")));
    await flush();
    expect(titles(firstOpen.result.current.result)[0]).toBe("First paper 1");

    firstOpen.unmount();
    await flush();
    expect(comparisonQueries(queryClient)).toHaveLength(0);

    const reopen = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    expect(reopen.result.current.status).toBe("loading");
    expect(reads).toHaveLength(2);
    reads[1].respond(ok(ownerRows("Fresh")));
    await flush();
    expect(titles(reopen.result.current.result)[0]).toBe("Fresh paper 1");
  });

  it("starts a new session even when reopened before the old one is collected", async () => {
    const queryClient = makeQueryClient();
    const first = makeRequest(OWNER_ID, IDS);
    const { result, rerender } = render(queryClient, first, OWNER_ID);
    reads[0].respond(ok(ownerRows("First")));
    await flush();

    rerender({ request: makeRequest(OWNER_ID, IDS), currentUserId: OWNER_ID });
    expect(result.current.status).toBe("loading");
    expect(result.current.result).toBeNull();
    expect(reads).toHaveLength(2);
  });

  it("ignores a late response from a replaced session", async () => {
    const queryClient = makeQueryClient();
    const { result, rerender } = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    rerender({ request: makeRequest(OWNER_ID, IDS), currentUserId: OWNER_ID });
    expect(reads).toHaveLength(2);
    expect(reads[0].signal!.aborted).toBe(true);

    reads[1].respond(ok(ownerRows("Newer")));
    await flush();
    reads[0].respond(ok(ownerRows("Older")));
    await flush();

    expect(titles(result.current.result)[0]).toBe("Newer paper 1");
    const cachedTitles = comparisonQueries(queryClient).flatMap((query) =>
      titles((query.state.data as ComparisonResult | undefined) ?? null),
    );
    expect(cachedTitles).not.toContain("Older paper 1");
  });

  it("lives outside the library's cache namespace, so prefix-wide library cache operations never touch it", async () => {
    const queryClient = makeQueryClient();
    const libraryPrefix = queryKeys.papers.all(OWNER_ID);
    const { result } = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);

    // A library mutation cancelling the papers queries must not abort the comparison read.
    await act(async () => {
      await queryClient.cancelQueries({ queryKey: libraryPrefix });
    });
    expect(reads[0].signal!.aborted).toBe(false);
    reads[0].respond(ok(ownerRows()));
    await flush();
    const snapshot = result.current.result;

    act(() => {
      queryClient.setQueriesData({ queryKey: libraryPrefix }, () => "synthetic overwrite");
      queryClient.removeQueries({ queryKey: libraryPrefix });
    });
    await flush();

    expect(result.current.result).toBe(snapshot);
    expect(comparisonQueries(queryClient)).toHaveLength(1);
    expect(reads).toHaveLength(1);
  });

  it("is not refetched by library invalidations, global invalidation, focus or reconnect", async () => {
    const queryClient = makeQueryClient();
    const { result } = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    reads[0].respond(ok(ownerRows()));
    await flush();
    const snapshot = result.current.result;

    // Not awaited: a refetch, if one were (wrongly) started, would wait on a
    // response this stub never sends — the read count below is the assertion.
    act(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(OWNER_ID) });
      void queryClient.invalidateQueries();
      void queryClient.refetchQueries();
    });
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await flush(60_000);

    expect(reads).toHaveLength(1);
    expect(result.current.status).toBe("ready");
    expect(result.current.result).toBe(snapshot);
  });
});

describe("usePaperComparison — failures and retry", () => {
  it("retries a transient failure exactly once, after the retry delay", async () => {
    const queryClient = makeQueryClient();
    const { result } = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    reads[0].respond(failure(503));
    await flush();
    expect(reads).toHaveLength(1);
    expect(result.current.status).toBe("loading");

    await flush(1000);
    expect(reads).toHaveLength(2);
    reads[1].respond(ok(ownerRows()));
    await flush();
    expect(result.current.status).toBe("ready");
  });

  it("gives up after the single retry", async () => {
    const queryClient = makeQueryClient();
    const { result } = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    reads[0].respond(failure(0)); // network error / no response
    await flush(1000);
    reads[1].respond(failure(502));
    await flush(60_000);
    expect(reads).toHaveLength(2);
    expect(result.current).toMatchObject({ status: "error", errorKind: "transport", result: null });
  });

  it.each([400, 401, 403, 404])("does not retry a non-transient HTTP %i", async (status) => {
    const queryClient = makeQueryClient();
    const { result } = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    reads[0].respond(failure(status));
    await flush(60_000);
    expect(reads).toHaveLength(1);
    expect(result.current).toMatchObject({ status: "error", errorKind: "transport" });
  });

  it("does not retry an integrity failure, and shows nothing from that response", async () => {
    const queryClient = makeQueryClient();
    const { result } = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    const rows = ownerRows();
    rows[2] = makeSparsePaperRow(IDS[2], { user_id: OTHER_USER_ID });
    reads[0].respond(ok(rows));
    await flush(60_000);
    expect(reads).toHaveLength(1);
    expect(result.current).toMatchObject({ status: "error", errorKind: "integrity", result: null });
  });

  it("retry() re-reads the same frozen request after an error", async () => {
    const queryClient = makeQueryClient();
    const request = makeRequest(OWNER_ID, IDS);
    const { result } = render(queryClient, request, OWNER_ID);
    reads[0].respond(failure(400));
    await flush();
    expect(result.current.status).toBe("error");

    act(() => result.current.retry());
    await flush();
    expect(result.current.status).toBe("loading");
    expect(reads).toHaveLength(2);
    expect(reads[1]).toMatchObject({ inArgs: ["id", request.queryIds], eqArgs: ["user_id", OWNER_ID] });
    reads[1].respond(ok(ownerRows()));
    await flush();
    expect(result.current.status).toBe("ready");
  });

  it("retry() does nothing once the comparison has loaded, or while a read is in flight", async () => {
    const queryClient = makeQueryClient();
    const { result } = render(queryClient, makeRequest(OWNER_ID, IDS), OWNER_ID);
    act(() => result.current.retry());
    await flush();
    expect(reads).toHaveLength(1);

    reads[0].respond(ok(ownerRows()));
    await flush();
    const snapshot = result.current.result;
    act(() => result.current.retry());
    await flush(5000);
    expect(reads).toHaveLength(1);
    expect(result.current.result).toBe(snapshot);
  });

  it("retry() does nothing for a request that is not the signed-in user's", async () => {
    const queryClient = makeQueryClient();
    const { result } = render(queryClient, makeRequest(OWNER_ID, IDS), OTHER_USER_ID);
    act(() => result.current.retry());
    await flush(5000);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
