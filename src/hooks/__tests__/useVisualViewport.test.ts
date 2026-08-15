import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVisualViewport } from "../useVisualViewport";

/**
 * ADD-PAPERS-MOBILE-SELECTORS-001 — the keyboard-aware sizing input.
 *
 * `bottomInset` is the value a real iOS keyboard produces and a resized
 * headless viewport does not, so it cannot be covered by the Playwright proxy
 * at all: there, `innerHeight` and `visualViewport.height` move together and
 * the inset stays 0. These tests drive the API directly, which is the only
 * place that arithmetic can be pinned down.
 */

interface FakeViewport {
  height: number;
  offsetTop: number;
  listeners: Record<string, Array<() => void>>;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  emit(type: string): void;
}

function installVisualViewport(height: number, offsetTop = 0): FakeViewport {
  const vv: FakeViewport = {
    height,
    offsetTop,
    listeners: {},
    addEventListener(type, fn) {
      (vv.listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      vv.listeners[type] = (vv.listeners[type] ?? []).filter((f) => f !== fn);
    },
    emit(type) {
      (vv.listeners[type] ?? []).forEach((fn) => fn());
    },
  };
  Object.defineProperty(window, "visualViewport", {
    value: vv,
    configurable: true,
    writable: true,
  });
  return vv;
}

function setInnerHeight(height: number) {
  Object.defineProperty(window, "innerHeight", {
    value: height,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "visualViewport");
  setInnerHeight(768);
});

describe("useVisualViewport", () => {
  it("reports the visible height with no inset when nothing covers the screen", () => {
    setInnerHeight(844);
    installVisualViewport(844);

    const { result } = renderHook(() => useVisualViewport(true));
    expect(result.current).toEqual({ height: 844, bottomInset: 0 });
  });

  it("reports the space the software keyboard takes as a bottom inset", () => {
    setInnerHeight(844);
    const vv = installVisualViewport(844);
    const { result } = renderHook(() => useVisualViewport(true));

    // The keyboard shrinks the VISUAL viewport only — `innerHeight` is
    // unchanged, which is exactly why `100vh` and `bottom: 0` mislead.
    act(() => {
      vv.height = 424;
      vv.emit("resize");
    });

    expect(result.current.height).toBe(424);
    expect(result.current.bottomInset).toBe(420);
  });

  it("accounts for the visual viewport being scrolled within the layout viewport", () => {
    setInnerHeight(844);
    const vv = installVisualViewport(844);
    const { result } = renderHook(() => useVisualViewport(true));

    act(() => {
      vv.height = 424;
      vv.offsetTop = 100;
      vv.emit("scroll");
    });

    // 844 - (424 + 100) = 320 obscured below.
    expect(result.current.bottomInset).toBe(320);
  });

  it("never reports a negative inset", () => {
    setInnerHeight(800);
    const vv = installVisualViewport(800);
    const { result } = renderHook(() => useVisualViewport(true));

    act(() => {
      // Browsers report fractional values that can exceed innerHeight slightly.
      vv.height = 800.4;
      vv.emit("resize");
    });

    expect(result.current.bottomInset).toBe(0);
  });

  it("recovers the full height when the keyboard is dismissed", () => {
    setInnerHeight(844);
    const vv = installVisualViewport(844);
    const { result } = renderHook(() => useVisualViewport(true));

    act(() => {
      vv.height = 424;
      vv.emit("resize");
    });
    expect(result.current.bottomInset).toBe(420);

    act(() => {
      vv.height = 844;
      vv.emit("resize");
    });
    expect(result.current).toEqual({ height: 844, bottomInset: 0 });
  });

  it("observes nothing while disabled, and picks up the current state when enabled", () => {
    setInnerHeight(844);
    const vv = installVisualViewport(844);

    const { result, rerender } = renderHook(({ on }) => useVisualViewport(on), {
      initialProps: { on: false },
    });
    expect(vv.listeners.resize ?? []).toHaveLength(0);

    // Changed while the selector was closed…
    vv.height = 500;
    rerender({ on: true });

    // …and is read on open rather than being stale.
    expect(result.current.height).toBe(500);
    expect((vv.listeners.resize ?? []).length).toBeGreaterThan(0);
  });

  it("detaches its listeners when disabled again", () => {
    setInnerHeight(844);
    const vv = installVisualViewport(844);

    const { rerender } = renderHook(({ on }) => useVisualViewport(on), {
      initialProps: { on: true },
    });
    expect((vv.listeners.resize ?? []).length).toBeGreaterThan(0);

    rerender({ on: false });
    expect(vv.listeners.resize ?? []).toHaveLength(0);
    expect(vv.listeners.scroll ?? []).toHaveLength(0);
  });

  it("falls back to innerHeight where visualViewport is unavailable", () => {
    setInnerHeight(700);
    Reflect.deleteProperty(window, "visualViewport");

    const { result } = renderHook(() => useVisualViewport(true));
    expect(result.current).toEqual({ height: 700, bottomInset: 0 });
  });
});
