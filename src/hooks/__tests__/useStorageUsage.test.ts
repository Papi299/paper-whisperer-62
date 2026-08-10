import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: mockFrom } }));

import { useStorageUsage } from "../useStorageUsage";
import { queryKeys } from "@/lib/queryKeys";

const MB = 1024 * 1024;

type Result = { data: unknown; error: unknown };

/** A minimal PostgREST builder stub: `.select().eq().maybeSingle()`. */
function tableStub(result: Result) {
  const stub = {
    select: vi.fn(() => stub),
    eq: vi.fn(() => stub),
    maybeSingle: vi.fn(async () => result),
  };
  return stub;
}

type Stubs = {
  usage: ReturnType<typeof tableStub>;
  entitlement: ReturnType<typeof tableStub>;
};

/** Wire `supabase.from` to per-table stubs and return them for assertions. */
function mockTables(usage: Result, entitlement: Result): Stubs {
  const stubs: Stubs = { usage: tableStub(usage), entitlement: tableStub(entitlement) };
  mockFrom.mockImplementation((table: string) => {
    if (table === "user_storage_usage") return stubs.usage;
    if (table === "user_entitlements") return stubs.entitlement;
    throw new Error(`unexpected table read: ${table}`);
  });
  return stubs;
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapper(client = makeClient()) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useStorageUsage", () => {
  it("is disabled and issues no query when userId is absent", async () => {
    const { result } = renderHook(() => useStorageUsage(undefined), { wrapper: wrapper() });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("issues no query while the consuming surface is closed (enabled: false)", async () => {
    mockTables({ data: { used_bytes: 5 * MB }, error: null }, { data: { storage_quota_bytes: 500 * MB }, error: null });
    const { result } = renderHook(() => useStorageUsage("user-1", { enabled: false }), {
      wrapper: wrapper(),
    });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("scopes BOTH table reads to the current user (S2 defense-in-depth)", async () => {
    const stubs = mockTables(
      { data: { used_bytes: 124 * MB }, error: null },
      { data: { storage_quota_bytes: 500 * MB }, error: null },
    );

    const { result } = renderHook(() => useStorageUsage("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).not.toBeNull());

    expect(mockFrom).toHaveBeenCalledWith("user_storage_usage");
    expect(mockFrom).toHaveBeenCalledWith("user_entitlements");
    expect(stubs.usage.select).toHaveBeenCalledWith("used_bytes");
    expect(stubs.entitlement.select).toHaveBeenCalledWith("storage_quota_bytes");
    // The explicit predicate is present on each read even though RLS also applies.
    expect(stubs.usage.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(stubs.entitlement.eq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("normalizes a normal used/quota pair", async () => {
    mockTables(
      { data: { used_bytes: 124 * MB }, error: null },
      { data: { storage_quota_bytes: 500 * MB }, error: null },
    );

    const { result } = renderHook(() => useStorageUsage("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).not.toBeNull());

    expect(result.current.status).toEqual({
      usedBytes: 124 * MB,
      quotaBytes: 500 * MB,
      remainingBytes: 376 * MB,
      percentUsed: 25,
      isAtOrOverQuota: false,
    });
    expect(result.current.isError).toBe(false);
  });

  it("treats a missing user_storage_usage row as 0 bytes used, not an error", async () => {
    // The signup trigger does not create a usage row; it appears lazily on the
    // first upload. Absent row + present entitlement is a valid zero state.
    mockTables({ data: null, error: null }, { data: { storage_quota_bytes: 500 * MB }, error: null });

    const { result } = renderHook(() => useStorageUsage("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).not.toBeNull());

    expect(result.current.status).toMatchObject({
      usedBytes: 0,
      quotaBytes: 500 * MB,
      remainingBytes: 500 * MB,
      percentUsed: 0,
      isAtOrOverQuota: false,
    });
    expect(result.current.isError).toBe(false);
  });

  it("reports unavailable (null, not an invented Free baseline) when the entitlement row is missing", async () => {
    mockTables({ data: { used_bytes: 10 * MB }, error: null }, { data: null, error: null });

    const { result } = renderHook(() => useStorageUsage("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.status).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("fails soft on a usage read error — status null, isError true", async () => {
    mockTables({ data: null, error: { message: "boom" } }, { data: { storage_quota_bytes: 500 * MB }, error: null });

    const { result } = renderHook(() => useStorageUsage("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.status).toBeNull();
  });

  it("fails soft on an entitlement read error — status null, isError true", async () => {
    mockTables({ data: { used_bytes: 0 }, error: null }, { data: null, error: { message: "denied" } });

    const { result } = renderHook(() => useStorageUsage("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.status).toBeNull();
  });

  it("reports exactly-at-cap as at-quota with a full but unclamped-text gauge", async () => {
    mockTables(
      { data: { used_bytes: 500 * MB }, error: null },
      { data: { storage_quota_bytes: 500 * MB }, error: null },
    );

    const { result } = renderHook(() => useStorageUsage("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).not.toBeNull());

    expect(result.current.status).toEqual({
      usedBytes: 500 * MB,
      quotaBytes: 500 * MB,
      remainingBytes: 0,
      percentUsed: 100,
      isAtOrOverQuota: true,
    });
  });

  it("keeps historical overage truthful: bar clamps to 100, used/quota do not", async () => {
    mockTables(
      { data: { used_bytes: 1200 }, error: null },
      { data: { storage_quota_bytes: 1000 }, error: null },
    );

    const { result } = renderHook(() => useStorageUsage("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).not.toBeNull());

    expect(result.current.status).toEqual({
      usedBytes: 1200,
      quotaBytes: 1000,
      // Never negative, and never rewritten to equal the quota.
      remainingBytes: 0,
      percentUsed: 100,
      isAtOrOverQuota: true,
    });
  });

  it("is division-safe for a zero quota with zero usage", async () => {
    mockTables({ data: { used_bytes: 0 }, error: null }, { data: { storage_quota_bytes: 0 }, error: null });

    const { result } = renderHook(() => useStorageUsage("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).not.toBeNull());

    const status = result.current.status!;
    expect(Number.isFinite(status.percentUsed)).toBe(true);
    expect(status.percentUsed).toBe(100);
    expect(status.remainingBytes).toBe(0);
    expect(status.isAtOrOverQuota).toBe(true);
  });

  it("is division-safe for positive usage against a zero quota", async () => {
    mockTables({ data: { used_bytes: 42 }, error: null }, { data: { storage_quota_bytes: 0 }, error: null });

    const { result } = renderHook(() => useStorageUsage("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).not.toBeNull());

    expect(result.current.status).toEqual({
      usedBytes: 42,
      quotaBytes: 0,
      remainingBytes: 0,
      percentUsed: 100,
      isAtOrOverQuota: true,
    });
  });

  it("isolates the cache per user — one user never reads another's figures", async () => {
    const client = makeClient();

    mockTables(
      { data: { used_bytes: 100 * MB }, error: null },
      { data: { storage_quota_bytes: 500 * MB }, error: null },
    );
    const first = renderHook(() => useStorageUsage("user-1"), { wrapper: wrapper(client) });
    await waitFor(() => expect(first.result.current.status).not.toBeNull());

    mockTables(
      { data: { used_bytes: 1 * MB }, error: null },
      { data: { storage_quota_bytes: 2048 * MB }, error: null },
    );
    const second = renderHook(() => useStorageUsage("user-2"), { wrapper: wrapper(client) });
    await waitFor(() => expect(second.result.current.status).not.toBeNull());

    expect(first.result.current.status?.usedBytes).toBe(100 * MB);
    expect(second.result.current.status?.usedBytes).toBe(1 * MB);
    expect(second.result.current.status?.quotaBytes).toBe(2048 * MB);

    // Two distinct per-user cache entries — no shared global storage key.
    expect(client.getQueryData(queryKeys.storageUsage.status("user-1"))).toMatchObject({
      usedBytes: 100 * MB,
    });
    expect(client.getQueryData(queryKeys.storageUsage.status("user-2"))).toMatchObject({
      usedBytes: 1 * MB,
    });
    expect(queryKeys.storageUsage.status("user-1")).not.toEqual(
      queryKeys.storageUsage.status("user-2"),
    );
  });

  it("refetches when the consuming surface reopens (enabled false → true)", async () => {
    mockTables(
      { data: { used_bytes: 1 * MB }, error: null },
      { data: { storage_quota_bytes: 500 * MB }, error: null },
    );

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useStorageUsage("user-1", { enabled: open }),
      { wrapper: wrapper(), initialProps: { open: true } },
    );
    await waitFor(() => expect(result.current.status?.usedBytes).toBe(1 * MB));

    // Close: no further reads while the surface is hidden.
    rerender({ open: false });
    const callsWhileClosed = mockFrom.mock.calls.length;

    // Reopen: the gauge picks up attachment activity from the closed period.
    mockTables(
      { data: { used_bytes: 7 * MB }, error: null },
      { data: { storage_quota_bytes: 500 * MB }, error: null },
    );
    rerender({ open: true });

    await waitFor(() => expect(result.current.status?.usedBytes).toBe(7 * MB));
    expect(mockFrom.mock.calls.length).toBeGreaterThan(callsWhileClosed);
  });
});
