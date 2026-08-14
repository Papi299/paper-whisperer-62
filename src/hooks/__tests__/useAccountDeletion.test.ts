import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { mockInvoke, mockSignOut, mockToast, mockRedirect } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockSignOut: vi.fn(),
  mockToast: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: mockInvoke },
    auth: { signOut: mockSignOut },
  },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock("@/lib/accountDeletion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountDeletion")>();
  return { ...actual, redirectToAuthPage: mockRedirect };
});

import { useAccountDeletion } from "../useAccountDeletion";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  GENERIC_DELETION_FAILURE,
} from "@/lib/accountDeletion";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

/**
 * Renders with the signed-in fixture user by default. An explicit argument is
 * honoured even when it is `undefined`, which is exactly the auth-transition
 * case under test — a default parameter would silently substitute `USER`.
 */
function renderDeletion(...args: [] | [string | null | undefined]) {
  const userId = args.length > 0 ? args[0] : USER;
  return renderHook(() => useAccountDeletion(userId), { wrapper });
}

/** A `FunctionsHttpError`-shaped failure carrying the function's error code. */
function httpError(code: string, status = 500) {
  return {
    context: new Response(JSON.stringify({ error: code, message: "safe copy" }), { status }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockInvoke.mockResolvedValue({ data: { status: "deleted" }, error: null });
  mockSignOut.mockResolvedValue({ error: null });
});

describe("useAccountDeletion — invocation contract", () => {
  it("invokes exactly the delete-account function", async () => {
    const { result } = renderDeletion();

    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][0]).toBe("delete-account");
  });

  it("sends the confirmation phrase and nothing else", async () => {
    const { result } = renderDeletion();

    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });

    const [, options] = mockInvoke.mock.calls[0];
    expect(options.body).toEqual({ confirmation: ACCOUNT_DELETION_CONFIRMATION });
    expect(Object.keys(options.body)).toEqual(["confirmation"]);
  });

  it("never sends a target user id, not even the signed-in one", async () => {
    const { result } = renderDeletion();

    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });

    const serialized = JSON.stringify(mockInvoke.mock.calls[0]);
    expect(serialized).not.toContain(USER);
    expect(serialized).not.toContain(OTHER);
    expect(serialized).not.toMatch(/user_?id/i);
  });

  it("forwards whatever phrase was typed and lets the server judge it", async () => {
    // The client gate is UX; the server is the authority. A wrong phrase still
    // reaches the server rather than being silently rewritten.
    mockInvoke.mockResolvedValue({ data: null, error: httpError("invalid_confirmation", 400) });
    const { result } = renderDeletion();

    await act(async () => {
      await result.current.deleteAccount("delete my account");
    });

    expect(mockInvoke.mock.calls[0][1].body).toEqual({ confirmation: "delete my account" });
  });

  it("does not invoke anything without an authenticated user context", async () => {
    const { result } = renderDeletion(undefined);

    expect(result.current.canDelete).toBe(false);

    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("prevents a duplicate invocation while one is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    mockInvoke.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const { result } = renderDeletion();

    let firstRun: Promise<void> | undefined;
    act(() => {
      firstRun = result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });
    await waitFor(() => expect(result.current.isDeleting).toBe(true));

    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ data: { status: "deleted" }, error: null });
      await firstRun;
    });

    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });
});

describe("useAccountDeletion — success cleanup", () => {
  it("clears the local session, drops cached data, and leaves the app", async () => {
    queryClient.setQueryData(["papers", USER], [{ id: "p1", title: "secret" }]);

    const { result } = renderDeletion();
    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });

    expect(mockSignOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(queryClient.getQueryData(["papers", USER])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });

  it("shows no error toast on the success path", async () => {
    const { result } = renderDeletion();
    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });

    expect(mockToast).not.toHaveBeenCalled();
    expect(result.current.isDeleting).toBe(false);
  });
});

describe("useAccountDeletion — failure handling", () => {
  it("keeps the local session when the function reports a failure", async () => {
    mockInvoke.mockResolvedValue({ data: null, error: httpError("storage_cleanup_failed") });

    const { result } = renderDeletion();
    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result.current.isDeleting).toBe(false);
  });

  it("normalizes a known code into user-safe copy", async () => {
    mockInvoke.mockResolvedValue({ data: null, error: httpError("unauthenticated", 401) });

    const { result } = renderDeletion();
    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });

    expect(mockToast).toHaveBeenCalledExactlyOnceWith({
      title: "Account not deleted",
      description: expect.stringMatching(/sign in again/i),
      variant: "destructive",
    });
  });

  it("collapses an unknown backend failure to the generic message", async () => {
    mockInvoke.mockResolvedValue({ data: null, error: httpError("storage_cleanup_failed") });

    const { result } = renderDeletion();
    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });

    expect(mockToast.mock.calls[0][0].description).toBe(GENERIC_DELETION_FAILURE);
  });

  it("never surfaces raw transport detail", async () => {
    mockInvoke.mockRejectedValue(
      new Error("FetchError: https://xyz.supabase.co/functions/v1/delete-account?apikey=SECRET"),
    );

    const { result } = renderDeletion();
    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });

    const description = mockToast.mock.calls[0][0].description as string;
    expect(description).toBe(GENERIC_DELETION_FAILURE);
    expect(description).not.toContain("apikey");
    expect(description).not.toContain("supabase.co");
    // A transport failure may mean the account still exists — never sign out.
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("stays usable after a failure so the user can retry", async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: httpError("account_deletion_failed") });

    const { result } = renderDeletion();
    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });
    expect(result.current.isDeleting).toBe(false);

    await act(async () => {
      await result.current.deleteAccount(ACCOUNT_DELETION_CONFIRMATION);
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });
});
