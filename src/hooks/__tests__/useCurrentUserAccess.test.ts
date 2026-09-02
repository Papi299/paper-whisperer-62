import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mockRpc } }));

import { useCurrentUserAccess, DEFAULT_USER_ACCESS } from "../useCurrentUserAccess";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    role: "user",
    is_internal: false,
    can_view_provider_quota: false,
    ai_quota_exempt: false,
    plan: "free",
    plan_status: "active",
    premium_taxonomy_enabled: false,
    labs_team_enabled: false,
    can_select_ai_model: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useCurrentUserAccess", () => {
  it("is disabled and does not call the RPC when userId is absent (safe default)", () => {
    const { result } = renderHook(() => useCurrentUserAccess(undefined), { wrapper: wrapper() });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(result.current.access).toEqual(DEFAULT_USER_ACCESS);
    expect(result.current.isLoading).toBe(false);
  });

  it("resolves an ordinary user to role 'user' with no internal capability", async () => {
    mockRpc.mockResolvedValue({ data: [row()], error: null });
    const { result } = renderHook(() => useCurrentUserAccess("u-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockRpc).toHaveBeenCalledWith("get_current_user_access");
    expect(result.current.access.role).toBe("user");
    expect(result.current.access.isInternal).toBe(false);
    expect(result.current.access.canViewProviderQuota).toBe(false);
    expect(result.current.access.aiQuotaExempt).toBe(false);
  });

  it("resolves an owner (internal, can view provider quota, exempt)", async () => {
    mockRpc.mockResolvedValue({
      data: [row({ role: "owner", is_internal: true, can_view_provider_quota: true, ai_quota_exempt: true, plan: "pro" })],
      error: null,
    });
    const { result } = renderHook(() => useCurrentUserAccess("owner-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.access.role).toBe("owner"));
    expect(result.current.access.isInternal).toBe(true);
    expect(result.current.access.canViewProviderQuota).toBe(true);
    expect(result.current.access.aiQuotaExempt).toBe(true);
    expect(result.current.access.plan).toBe("pro");
  });

  it("resolves a manager (internal, can view provider quota) who is NOT auto-exempt", async () => {
    mockRpc.mockResolvedValue({
      data: [row({ role: "manager", is_internal: true, can_view_provider_quota: true, ai_quota_exempt: false })],
      error: null,
    });
    const { result } = renderHook(() => useCurrentUserAccess("mgr-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.access.role).toBe("manager"));
    expect(result.current.access.canViewProviderQuota).toBe(true);
    expect(result.current.access.aiQuotaExempt).toBe(false);
  });

  it("fails closed: an RPC error yields the ordinary-user default (never grants privileges)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { result } = renderHook(() => useCurrentUserAccess("u-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.access).toEqual(DEFAULT_USER_ACCESS);
    expect(result.current.access.canViewProviderQuota).toBe(false);
  });

  it("never over-grants: an unknown role with stray internal flags is clamped to 'user'", async () => {
    // Defense-in-depth: even if the server returned a nonsense role with the
    // internal flags set, the client must not treat it as internal.
    mockRpc.mockResolvedValue({
      data: [row({ role: "superadmin", is_internal: true, can_view_provider_quota: true })],
      error: null,
    });
    const { result } = renderHook(() => useCurrentUserAccess("weird-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.access.role).toBe("user");
    expect(result.current.access.isInternal).toBe(false);
    expect(result.current.access.canViewProviderQuota).toBe(false);
  });

  it("never over-grants exemption: role 'user' with ai_quota_exempt true is clamped to false", async () => {
    // A malformed row that pairs the ordinary-user role with an exemption flag
    // must not surface a client-side exemption (the server stays authoritative).
    mockRpc.mockResolvedValue({ data: [row({ role: "user", ai_quota_exempt: true })], error: null });
    const { result } = renderHook(() => useCurrentUserAccess("u-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.access.role).toBe("user");
    expect(result.current.access.aiQuotaExempt).toBe(false);
  });

  // ── AI-MODEL-SELECTION-001A: canSelectAiModel ─────────────────────────────
  // The server computes this as `ai_model_selection_enabled AND plan_status IN
  // ('active','trialing')`; the hook mirrors it and must never widen it.

  it("maps a server-true can_select_ai_model to canSelectAiModel true", async () => {
    mockRpc.mockResolvedValue({
      data: [row({ plan: "pro", plan_status: "active", can_select_ai_model: true })],
      error: null,
    });
    const { result } = renderHook(() => useCurrentUserAccess("pro-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.access.canSelectAiModel).toBe(true);
    // The capability is independent of the internal role model.
    expect(result.current.access.role).toBe("user");
    expect(result.current.access.isInternal).toBe(false);
  });

  it("maps a server-false can_select_ai_model to false even when the plan reads 'pro'", async () => {
    // The gate is the server's explicit entitlement flag, never the plan name:
    // a client that inferred capability from `plan === 'pro'` would show the
    // control to a user the server will refuse.
    mockRpc.mockResolvedValue({
      data: [row({ plan: "pro", plan_status: "active", can_select_ai_model: false })],
      error: null,
    });
    const { result } = renderHook(() => useCurrentUserAccess("pro-2"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.access.plan).toBe("pro");
    expect(result.current.access.canSelectAiModel).toBe(false);
  });

  it.each([
    ["null", null],
    ["absent", undefined],
    ['the string "false"', "false"],
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["an object", {}],
  ])("fails closed on canSelectAiModel when the server sends %s", async (_label, value) => {
    // Only a literal `true` grants. `!!"false"` is `true`, so truthiness
    // coercion here would hand a paid capability to a malformed row.
    mockRpc.mockResolvedValue({ data: [row({ can_select_ai_model: value })], error: null });
    const { result } = renderHook(() => useCurrentUserAccess("edge-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.access.canSelectAiModel).toBe(false);
  });

  it("fails closed on canSelectAiModel when the RPC errors", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { result } = renderHook(() => useCurrentUserAccess("pro-3"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.access.canSelectAiModel).toBe(false);
    expect(DEFAULT_USER_ACCESS.canSelectAiModel).toBe(false);
  });

  it("adding canSelectAiModel leaves every pre-existing access property unchanged", async () => {
    // An entitled owner: the new commercial capability must not disturb the
    // internal-role projection, and vice versa.
    mockRpc.mockResolvedValue({
      data: [row({
        role: "owner",
        is_internal: true,
        can_view_provider_quota: true,
        ai_quota_exempt: true,
        plan: "pro",
        plan_status: "trialing",
        premium_taxonomy_enabled: true,
        labs_team_enabled: true,
        can_select_ai_model: true,
      })],
      error: null,
    });
    const { result } = renderHook(() => useCurrentUserAccess("owner-2"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.access.role).toBe("owner"));
    expect(result.current.access).toEqual({
      role: "owner",
      isInternal: true,
      canViewProviderQuota: true,
      aiQuotaExempt: true,
      plan: "pro",
      planStatus: "trialing",
      premiumTaxonomyEnabled: true,
      labsTeamEnabled: true,
      canSelectAiModel: true,
    });
  });

  it("returns the safe default when the RPC yields an empty result set", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useCurrentUserAccess("u-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.access).toEqual(DEFAULT_USER_ACCESS);
  });
});
