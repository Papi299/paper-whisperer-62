import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAnalyticsTargets } from "../useAnalyticsTargets";

/**
 * The hook exists so Analytics target selections outlive the responsive shell
 * swap. These tests pin the semantics it must carry over from the state it
 * replaced; the browser-level proof that the state actually survives crossing
 * 768px lives in `e2e/mobile-dashboard-density.spec.ts`.
 */
describe("useAnalyticsTargets", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useAnalyticsTargets());
    expect(result.current.selectedKeywords).toEqual([]);
    expect(result.current.selectedAuthors).toEqual([]);
  });

  it("toggles a keyword on and back off, preserving selection order", () => {
    const { result } = renderHook(() => useAnalyticsTargets());

    act(() => result.current.onToggleKeyword("neoplasms"));
    act(() => result.current.onToggleKeyword("aspirin"));
    expect(result.current.selectedKeywords).toEqual(["neoplasms", "aspirin"]);

    act(() => result.current.onToggleKeyword("neoplasms"));
    expect(result.current.selectedKeywords).toEqual(["aspirin"]);
  });

  it("holds authors independently of keywords", () => {
    // Authors carry a label alongside their key. A keyword is its own label, so
    // it stays a bare string; an author's key is an internal entity key that
    // cannot be shown, and the label is what survives the entity leaving view.
    const curie = { key: "mention:curie m", label: "Curie M" };
    const { result } = renderHook(() => useAnalyticsTargets());

    act(() => result.current.onToggleKeyword("neoplasms"));
    act(() => result.current.onSetAuthors([curie]));
    expect(result.current.selectedKeywords).toEqual(["neoplasms"]);
    expect(result.current.selectedAuthors).toEqual([curie]);

    act(() => result.current.onClearKeywords());
    expect(result.current.selectedKeywords).toEqual([]);
    expect(result.current.selectedAuthors).toEqual([curie]);

    act(() => result.current.onClearAuthors());
    expect(result.current.selectedAuthors).toEqual([]);
  });

  it("keeps stable handler identities across selection changes", () => {
    // The handlers are passed through two shells into a memo-heavy chart body;
    // re-creating them on every keystroke would churn it for nothing.
    const { result } = renderHook(() => useAnalyticsTargets());
    const first = result.current.onToggleKeyword;

    act(() => result.current.onToggleKeyword("neoplasms"));
    expect(result.current.onToggleKeyword).toBe(first);
    expect(result.current.selectedKeywords).toEqual(["neoplasms"]);
  });

  it("persists nothing — the selections are session-scoped only", () => {
    // Exploratory selections about the current view are not a saved preference,
    // so nothing may reach storage or the URL.
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");

    const { result, unmount } = renderHook(() => useAnalyticsTargets());
    act(() => result.current.onToggleKeyword("neoplasms"));
    act(() =>
      result.current.onSetAuthors([{ key: "mention:curie m", label: "Curie M" }]),
    );

    expect(setItem).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();

    // A genuinely new session (page reload) therefore starts clean, by design.
    unmount();
    const { result: reloaded } = renderHook(() => useAnalyticsTargets());
    expect(reloaded.current.selectedKeywords).toEqual([]);
    expect(reloaded.current.selectedAuthors).toEqual([]);

    setItem.mockRestore();
    pushState.mockRestore();
    replaceState.mockRestore();
  });
});
