import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePaperComparisonSession } from "../usePaperComparisonSession";
import { OTHER_USER_ID, OWNER_ID, paperId } from "@/lib/paperComparison/__tests__/fixtures";

/**
 * EVIDENCE-MATRIX-001B — which comparison is open. The request is frozen from
 * the selection at the moment Compare is pressed, every open is a new session,
 * an owner change closes it in the same render, and nothing is persisted.
 */

function render(userId: string | null) {
  return renderHook((props: { userId: string | null }) => usePaperComparisonSession(props.userId), {
    initialProps: { userId },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePaperComparisonSession", () => {
  it("is closed until asked to compare", () => {
    const { result } = render(OWNER_ID);
    expect(result.current.request).toBeNull();
  });

  it("freezes the exact selection, owner-bound, sorted and deduplicated", () => {
    const { result } = render(OWNER_ID);
    const selection = new Set([paperId(3), paperId(1), paperId(2)]);
    act(() => {
      result.current.open(selection);
    });
    const request = result.current.request!;
    expect(request.ownerUserId).toBe(OWNER_ID);
    expect(request.selectedIds).toEqual([paperId(1), paperId(2), paperId(3)]);
    expect(request.queryIds).toEqual([paperId(1), paperId(2), paperId(3)]);
    expect(Object.isFrozen(request)).toBe(true);

    // The live selection changing afterwards never reaches the open comparison.
    selection.add(paperId(4));
    selection.delete(paperId(1));
    expect(result.current.request).toBe(request);
    expect(request.selectedIds).toEqual([paperId(1), paperId(2), paperId(3)]);
  });

  it("refuses, without opening or truncating, a selection outside 2–10 or without a user", () => {
    const { result } = render(OWNER_ID);
    let outcome = result.current.open([paperId(1)]);
    expect(outcome).toEqual({ ok: false, reason: "too_few", selectedCount: 1 });

    const eleven = Array.from({ length: 11 }, (_, index) => paperId(index + 1));
    act(() => {
      outcome = result.current.open(eleven);
    });
    expect(outcome).toEqual({ ok: false, reason: "too_many", selectedCount: 11 });
    expect(result.current.request).toBeNull();

    const anonymous = render(null);
    expect(anonymous.result.current.open([paperId(1), paperId(2)])).toMatchObject({ ok: false, reason: "no_user" });
    expect(anonymous.result.current.request).toBeNull();
  });

  it("accepts exactly 10 papers", () => {
    const { result } = render(OWNER_ID);
    act(() => {
      result.current.open(Array.from({ length: 10 }, (_, index) => paperId(index + 1)));
    });
    expect(result.current.request?.selectedIds).toHaveLength(10);
  });

  it("starts a new session on every open, even for the same selection", () => {
    const { result } = render(OWNER_ID);
    act(() => {
      result.current.open([paperId(1), paperId(2)]);
    });
    const first = result.current.request!;
    act(() => result.current.close());
    expect(result.current.request).toBeNull();
    act(() => {
      result.current.open([paperId(1), paperId(2)]);
    });
    expect(result.current.request!.sessionId).not.toBe(first.sessionId);
  });

  it("closes in the same render when the signed-in user changes, and stays closed if they come back", () => {
    // Every render's output, not just the settled one: a request that an
    // effect clears afterwards would still have been returned once.
    const renders: { userId: string | null; open: boolean }[] = [];
    const { result, rerender } = renderHook(
      (props: { userId: string | null }) => {
        const session = usePaperComparisonSession(props.userId);
        renders.push({ userId: props.userId, open: session.request !== null });
        return session;
      },
      { initialProps: { userId: OWNER_ID as string | null } },
    );
    act(() => {
      result.current.open([paperId(1), paperId(2)]);
    });
    expect(result.current.request).not.toBeNull();

    rerender({ userId: OTHER_USER_ID });
    rerender({ userId: null });
    rerender({ userId: OWNER_ID });
    expect(result.current.request).toBeNull();
    expect(renders.filter((entry) => entry.userId !== OWNER_ID).length).toBeGreaterThan(0);
    for (const entry of renders.filter((candidate) => candidate.userId !== OWNER_ID)) {
      expect(entry.open, `render for ${entry.userId}`).toBe(false);
    }
  });

  it("keeps nothing in browser storage or the URL", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const url = window.location.href;
    const { result } = render(OWNER_ID);
    act(() => {
      result.current.open([paperId(1), paperId(2)]);
    });
    act(() => result.current.close());
    expect(setItem).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.location.href).toBe(url);
  });
});
