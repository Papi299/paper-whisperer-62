import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCoarsePointer, useTouchSafeInitialFocus } from "../useCoarsePointer";

/**
 * REAL-DEVICE-TOUCH-UX-REMEDIATION-001 — the input-modality primitive.
 *
 * Playwright proves what the browser does with these values; this proves the
 * hook's own contract, which the E2E proxy cannot isolate: that it is SSR-safe,
 * that it survives an environment with no `matchMedia` at all, that it reacts
 * to the pointer type changing at runtime, and — the part that actually guards
 * the fix — that `onOpenAutoFocus` only intercepts Radix's initial focus on a
 * coarse pointer and otherwise leaves it completely alone.
 */

const originalMatchMedia = window.matchMedia;

interface FakeMql {
  matches: boolean;
  listeners: Array<() => void>;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  /** Flip the pointer type the way attaching/detaching a keyboard would. */
  set(next: boolean): void;
}

/** Installs a `matchMedia` that answers only `(pointer: coarse)`. */
function installMatchMedia(initial: boolean): FakeMql {
  const mql: FakeMql = {
    matches: initial,
    listeners: [],
    addEventListener(_type, fn) {
      mql.listeners.push(fn);
    },
    removeEventListener(_type, fn) {
      mql.listeners = mql.listeners.filter((f) => f !== fn);
    },
    set(next) {
      mql.matches = next;
      mql.listeners.forEach((fn) => fn());
    },
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      if (query !== "(pointer: coarse)") {
        throw new Error(`unexpected media query: ${query}`);
      }
      return mql;
    },
  });
  return mql;
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe("useCoarsePointer", () => {
  it("reports the pointer type synchronously on the first render", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(true);
  });

  it("reports false for a fine pointer", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(false);
  });

  it("reacts to the pointer type changing at runtime", () => {
    const mql = installMatchMedia(false);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(false);

    act(() => mql.set(true));
    expect(result.current).toBe(true);

    act(() => mql.set(false));
    expect(result.current).toBe(false);
  });

  it("unsubscribes on unmount", () => {
    const mql = installMatchMedia(true);
    const { unmount } = renderHook(() => useCoarsePointer());
    expect(mql.listeners).toHaveLength(1);
    unmount();
    expect(mql.listeners).toHaveLength(0);
  });

  it("falls back to fine when matchMedia is unavailable (SSR / bare jsdom)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const { result } = renderHook(() => useCoarsePointer());
    // Not merely "does not throw": defaulting to fine means an environment that
    // cannot answer the question keeps the pre-existing desktop behaviour.
    expect(result.current).toBe(false);
  });
});

describe("useTouchSafeInitialFocus", () => {
  /** A focusable stand-in for a `DialogTitle` / `PopoverContent`. */
  function attachTarget(result: { current: { focusRef: React.RefObject<HTMLElement> } }) {
    const el = document.createElement("h2");
    el.tabIndex = -1;
    document.body.appendChild(el);
    const focus = vi.spyOn(el, "focus");
    (result.current.focusRef as React.MutableRefObject<HTMLElement | null>).current = el;
    return { el, focus };
  }

  it("prevents Radix's initial focus and focuses the target on a coarse pointer", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useTouchSafeInitialFocus<HTMLElement>());
    const { focus } = attachTarget(result);

    const event = new Event("focus", { cancelable: true });
    act(() => result.current.onOpenAutoFocus(event));

    expect(event.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("leaves Radix's initial focus untouched on a fine pointer", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useTouchSafeInitialFocus<HTMLElement>());
    const { focus } = attachTarget(result);

    const event = new Event("focus", { cancelable: true });
    act(() => result.current.onOpenAutoFocus(event));

    // The whole desktop-preservation guarantee: not prevented, so Radix still
    // focuses the first tabbable element (the search/name field) as before.
    expect(event.defaultPrevented).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("runs the fine-pointer override instead, when one is supplied", () => {
    installMatchMedia(false);
    const onFinePointerAutoFocus = vi.fn();
    const { result } = renderHook(() =>
      useTouchSafeInitialFocus<HTMLElement>({ onFinePointerAutoFocus }),
    );
    const { focus } = attachTarget(result);

    const event = new Event("focus", { cancelable: true });
    act(() => result.current.onOpenAutoFocus(event));

    expect(event.defaultPrevented).toBe(true);
    expect(onFinePointerAutoFocus).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("ignores the fine-pointer override on a coarse pointer", () => {
    installMatchMedia(true);
    const onFinePointerAutoFocus = vi.fn();
    const { result } = renderHook(() =>
      useTouchSafeInitialFocus<HTMLElement>({ onFinePointerAutoFocus }),
    );
    const { focus } = attachTarget(result);

    const event = new Event("focus", { cancelable: true });
    act(() => result.current.onOpenAutoFocus(event));

    expect(onFinePointerAutoFocus).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("follows a runtime pointer-type change", () => {
    const mql = installMatchMedia(false);
    const { result } = renderHook(() => useTouchSafeInitialFocus<HTMLElement>());
    const { focus } = attachTarget(result);

    const beforeEvent = new Event("focus", { cancelable: true });
    act(() => result.current.onOpenAutoFocus(beforeEvent));
    expect(beforeEvent.defaultPrevented).toBe(false);

    act(() => mql.set(true));

    const afterEvent = new Event("focus", { cancelable: true });
    act(() => result.current.onOpenAutoFocus(afterEvent));
    expect(afterEvent.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
