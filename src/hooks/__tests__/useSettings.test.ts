import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// ── Supabase mock ──────────────────────────────────────────────────────
// Follows the same vi.hoisted pattern used in fetchInChunks.test.ts
const { mockSingle, mockEq, mockSelect, mockUpdate, mockUpsert, mockFrom } =
  vi.hoisted(() => {
    const mockSingle = vi.fn();
    const mockEq = vi.fn(() => ({ single: mockSingle }));
    const mockSelect = vi.fn(() => ({ eq: mockEq }));
    // update() returns a chainable object with .eq()
    const mockUpdateEq = vi.fn();
    const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq }));
    const mockUpsert = vi.fn();
    const mockFrom = vi.fn((table: string) => ({
      select: mockSelect,
      update: mockUpdate,
      upsert: mockUpsert,
    }));
    return { mockSingle, mockEq, mockSelect, mockUpdate, mockUpdateEq, mockUpsert, mockFrom };
  });

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom },
}));

// ── useAuth mock ───────────────────────────────────────────────────────
const mockUser = { id: "user-123", email: "test@example.com" };
let currentUser: typeof mockUser | null = mockUser;

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: currentUser }),
}));

// ── Import under test (after mocks) ───────────────────────────────────
import { useSettings } from "../useSettings";

describe("useSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = mockUser;

    // Default: profile exists with no API key
    mockSingle.mockResolvedValue({
      data: { pubmed_api_key: null },
      error: null,
    });
    mockEq.mockReturnValue({ single: mockSingle });
    mockSelect.mockReturnValue({ eq: mockEq });

    // update chain: .update({...}).eq("user_id", id) → resolved
    const updateEqFn = vi.fn().mockResolvedValue({ error: null });
    mockUpdate.mockReturnValue({ eq: updateEqFn });

    // upsert: resolved with no error
    mockUpsert.mockResolvedValue({ error: null });

    mockFrom.mockReturnValue({
      select: mockSelect,
      update: mockUpdate,
      upsert: mockUpsert,
    });
  });

  // ── Loading / initial fetch ────────────────────────────────────────

  it("fetches the API key from profiles on mount when user is present", async () => {
    mockSingle.mockResolvedValue({
      data: { pubmed_api_key: "my-secret-key" },
      error: null,
    });

    const { result } = renderHook(() => useSettings());

    // Initially loading
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.settings.pubmedApiKey).toBe("my-secret-key");
    expect(mockFrom).toHaveBeenCalledWith("profiles");
    expect(mockSelect).toHaveBeenCalledWith("pubmed_api_key");
    expect(mockEq).toHaveBeenCalledWith("user_id", "user-123");
  });

  it("returns null key and stops loading when user is not authenticated", async () => {
    currentUser = null;

    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.settings.pubmedApiKey).toBeNull();
    // Should NOT query the database at all
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("handles missing profile row gracefully (no error thrown)", async () => {
    // .single() returns error when 0 rows
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: "PGRST116", message: "no rows" },
    });

    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Key stays null — no crash
    expect(result.current.settings.pubmedApiKey).toBeNull();
  });

  // ── setPubmedApiKey ────────────────────────────────────────────────

  it("uses upsert (not update) when saving a key", async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setPubmedApiKey("new-key");
    });

    // Must call upsert, not update
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith(
      {
        user_id: "user-123",
        email: "test@example.com",
        pubmed_api_key: "new-key",
      },
      { onConflict: "user_id" }
    );

    // Local state updated
    expect(result.current.settings.pubmedApiKey).toBe("new-key");
  });

  it("trims whitespace from the key before saving", async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setPubmedApiKey("  padded-key  ");
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ pubmed_api_key: "padded-key" }),
      expect.anything()
    );
  });

  it("does not call upsert for empty/whitespace-only key", async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setPubmedApiKey("   ");
    });

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(result.current.settings.pubmedApiKey).toBeNull();
  });

  it("does not update local state when upsert fails", async () => {
    mockUpsert.mockResolvedValue({ error: { message: "DB error" } });

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const returnedError = await act(async () => {
      return result.current.setPubmedApiKey("new-key");
    });

    expect(returnedError).toEqual({ message: "DB error" });
    expect(result.current.settings.pubmedApiKey).toBeNull();
  });

  it("does nothing when user is null", async () => {
    currentUser = null;

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setPubmedApiKey("key");
    });

    expect(mockFrom).not.toHaveBeenCalled();
  });

  // ── clearPubmedApiKey ──────────────────────────────────────────────

  it("sets pubmed_api_key to null via update when clearing", async () => {
    mockSingle.mockResolvedValue({
      data: { pubmed_api_key: "existing-key" },
      error: null,
    });

    const updateEqFn = vi.fn().mockResolvedValue({ error: null });
    mockUpdate.mockReturnValue({ eq: updateEqFn });

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.settings.pubmedApiKey).toBe("existing-key");

    await act(async () => {
      await result.current.clearPubmedApiKey();
    });

    expect(mockUpdate).toHaveBeenCalledWith({ pubmed_api_key: null });
    expect(updateEqFn).toHaveBeenCalledWith("user_id", "user-123");
    expect(result.current.settings.pubmedApiKey).toBeNull();
  });

  // ── No localStorage usage ──────────────────────────────────────────

  it("never touches localStorage", async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem");
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setPubmedApiKey("a-key");
    });

    await act(async () => {
      await result.current.clearPubmedApiKey();
    });

    // None of the localStorage methods should have been called by useSettings.
    // (Other parts of the app like Supabase auth may use localStorage, so we
    // check that no call was made with our old settings key.)
    const allGetCalls = getItemSpy.mock.calls.map((c) => c[0]);
    const allSetCalls = setItemSpy.mock.calls.map((c) => c[0]);
    const allRemoveCalls = removeItemSpy.mock.calls.map((c) => c[0]);
    const allKeys = [...allGetCalls, ...allSetCalls, ...allRemoveCalls];

    expect(allKeys).not.toContain("paper-index-settings");

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
    removeItemSpy.mockRestore();
  });
});
