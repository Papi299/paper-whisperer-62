import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mockRpc } }));

import { useAiQuota } from "../useAiQuota";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useAiQuota", () => {
  it("is disabled and does not call the RPC when userId is absent", async () => {
    const { result } = renderHook(() => useAiQuota(undefined), { wrapper: wrapper() });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("calls get_ai_quota_status with the current user and normalizes the row", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          allowed: true,
          reason: "ok",
          plan: "free",
          plan_status: "active",
          period_type: "lifetime",
          used: 3,
          quota: 15,
          remaining: 12,
          reset_at: null,
        },
      ],
      error: null,
    });

    const { result } = renderHook(() => useAiQuota("user-1"), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(mockRpc).toHaveBeenCalledWith("get_ai_quota_status", { p_user_id: "user-1" });
    expect(result.current.status).toEqual({
      allowed: true,
      reason: "ok",
      plan: "free",
      planStatus: "active",
      periodType: "lifetime",
      used: 3,
      quota: 15,
      remaining: 12,
      resetAt: null,
      isExempt: false,
    });
    expect(result.current.isError).toBe(false);
  });

  it("normalizes the additive is_exempt field for an exempt internal user", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          allowed: true,
          reason: "quota_exempt",
          plan: "pro",
          plan_status: "active",
          period_type: "monthly",
          used: 412,
          quota: 350,
          remaining: 0,
          reset_at: "2026-08-01T00:00:00Z",
          is_exempt: true,
        },
      ],
      error: null,
    });
    const { result } = renderHook(() => useAiQuota("owner-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.status?.isExempt).toBe(true);
    expect(result.current.status?.reason).toBe("quota_exempt");
    // Usage stays visible even though remaining reads 0 past the nominal cap.
    expect(result.current.status?.used).toBe(412);
  });

  it("defaults isExempt to false when the RPC omits the field (older shape)", async () => {
    mockRpc.mockResolvedValue({
      data: [{ allowed: true, reason: "ok", plan: "free", plan_status: "active", period_type: "lifetime", used: 1, quota: 15, remaining: 14, reset_at: null }],
      error: null,
    });
    const { result } = renderHook(() => useAiQuota("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.status?.isExempt).toBe(false);
  });

  it("returns null status when the RPC yields an empty result set", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useAiQuota("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.status).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("fails soft on RPC error — status null, isError true", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { result } = renderHook(() => useAiQuota("user-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.status).toBeNull();
  });
});
