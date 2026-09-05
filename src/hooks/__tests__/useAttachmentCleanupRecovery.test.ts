import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * The session-start retry.
 *
 * It is the only automatic retry in the product, and the constraint that makes
 * it acceptable is that it is *bounded*: one pass per signed-in user, no timer,
 * no polling, and no toast. A hook that retried on every render — or on an
 * interval — would turn an unreachable Storage into a request loop that runs for
 * as long as the tab is open.
 */

import type { AttachmentCleanupResult } from "@/lib/attachmentCleanup";

const mockDrain = vi.fn<(userId: string | null | undefined) => Promise<AttachmentCleanupResult>>(
  async () => ({ status: "completed", removed: 0, pending: 0 }),
);
vi.mock("@/lib/attachmentCleanup", () => ({
  drainAttachmentCleanupQueue: (userId: string | null | undefined) => mockDrain(userId),
}));

import { useAttachmentCleanupRecovery } from "../useAttachmentCleanupRecovery";

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockDrain.mockResolvedValue({ status: "completed", removed: 0, pending: 0 });
});

describe("useAttachmentCleanupRecovery", () => {
  it("drains once for the signed-in user", async () => {
    renderHook(({ userId }) => useAttachmentCleanupRecovery(userId), {
      initialProps: { userId: USER as string | undefined },
    });

    await waitFor(() => expect(mockDrain).toHaveBeenCalledTimes(1));
    expect(mockDrain).toHaveBeenCalledWith(USER);
  });

  it("does not drain again on re-render", async () => {
    const { rerender } = renderHook(({ userId }) => useAttachmentCleanupRecovery(userId), {
      initialProps: { userId: USER as string | undefined },
    });

    await waitFor(() => expect(mockDrain).toHaveBeenCalledTimes(1));
    rerender({ userId: USER });
    rerender({ userId: USER });

    expect(mockDrain).toHaveBeenCalledTimes(1);
  });

  it("does nothing while there is no session", async () => {
    const { rerender } = renderHook(({ userId }) => useAttachmentCleanupRecovery(userId), {
      initialProps: { userId: undefined as string | undefined },
    });

    rerender({ userId: undefined });
    expect(mockDrain).not.toHaveBeenCalled();

    // …and starts its single pass the moment a session appears.
    rerender({ userId: USER });
    await waitFor(() => expect(mockDrain).toHaveBeenCalledTimes(1));
  });

  it("gives a different account its own single pass", async () => {
    const { rerender } = renderHook(({ userId }) => useAttachmentCleanupRecovery(userId), {
      initialProps: { userId: USER as string | undefined },
    });
    await waitFor(() => expect(mockDrain).toHaveBeenCalledTimes(1));

    rerender({ userId: OTHER });
    await waitFor(() => expect(mockDrain).toHaveBeenCalledTimes(2));
    expect(mockDrain).toHaveBeenLastCalledWith(OTHER);
  });

  it("installs no timer or interval", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const setTimeout = vi.spyOn(globalThis, "setTimeout");

    renderHook(() => useAttachmentCleanupRecovery(USER));

    expect(setInterval).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();

    setInterval.mockRestore();
    setTimeout.mockRestore();
  });

  it("does not retry, and does not throw, when the pass reports pending work", async () => {
    mockDrain.mockResolvedValue({ status: "pending", removed: 0, pending: 3 });

    const { rerender } = renderHook(({ userId }) => useAttachmentCleanupRecovery(userId), {
      initialProps: { userId: USER as string | undefined },
    });
    await waitFor(() => expect(mockDrain).toHaveBeenCalledTimes(1));

    rerender({ userId: USER });
    // Storage being down costs exactly one refused request per session, not a
    // request per render.
    expect(mockDrain).toHaveBeenCalledTimes(1);
  });
});
