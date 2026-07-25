import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: mockInvoke } } }));

import { useGeminiProviderQuota } from "../useGeminiProviderQuota";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

const okData = {
  status: "ok",
  configuredModel: "gemini-flash-latest",
  observedModels: ["gemini-flash-latest"],
  providerTier: "free",
  sharedScope: true,
  collectedAt: "2026-07-25T12:00:00Z",
  metricsMayLagSeconds: 240,
  dimensions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useGeminiProviderQuota", () => {
  it("is DISABLED for ordinary users — never invokes the Edge Function", () => {
    const { result } = renderHook(() => useGeminiProviderQuota("user-1", false), { wrapper: wrapper() });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("is disabled without a userId even when canView is true", () => {
    const { result } = renderHook(() => useGeminiProviderQuota(undefined, true), { wrapper: wrapper() });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
  });

  it("invokes and normalizes for an authorized viewer", async () => {
    mockInvoke.mockResolvedValue({ data: okData, error: null });
    const { result } = renderHook(() => useGeminiProviderQuota("mgr-1", true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(mockInvoke).toHaveBeenCalledWith("get-gemini-provider-quota");
    expect(result.current.data?.status).toBe("ok");
    expect(result.current.isError).toBe(false);
  });

  it("fails soft on invoke error — data null, isError true", async () => {
    mockInvoke.mockResolvedValue({ data: null, error: new Error("forbidden") });
    const { result } = renderHook(() => useGeminiProviderQuota("mgr-1", true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("fails soft on a malformed payload", async () => {
    mockInvoke.mockResolvedValue({ data: { nonsense: true }, error: null });
    const { result } = renderHook(() => useGeminiProviderQuota("mgr-1", true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("refresh() does not fire a second request while one is pending (spam guard)", async () => {
    // A never-resolving invoke keeps the query in-flight so refresh must no-op.
    mockInvoke.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useGeminiProviderQuota("mgr-1", true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    act(() => result.current.refresh());
    act(() => result.current.refresh());
    expect(mockInvoke).toHaveBeenCalledTimes(1); // still just the initial fetch
  });
});
