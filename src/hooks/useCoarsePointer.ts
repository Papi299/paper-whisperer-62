import * as React from "react";

/**
 * The primary pointing device is coarse — a finger rather than a mouse or
 * trackpad. This is an *input modality* question and is deliberately NOT the
 * app's layout breakpoint: `useIsMobile()` (768px) still decides which layout
 * composes, and a 1024px-wide iPad keeps the desktop/tablet composition while
 * matching this query.
 *
 * `(pointer: coarse)` describes the *primary* pointer, so a laptop with a
 * touchscreen and a trackpad reports `fine` and keeps its desktop behaviour;
 * an iPad — with or without a Magic Keyboard — reports `coarse`, which is the
 * right answer for it either way, because none of the behaviour keyed off this
 * hook removes a capability, it only declines to *assume* the user wants to
 * type the moment a surface opens.
 */
const COARSE_POINTER_QUERY = "(pointer: coarse)";

function readCoarsePointer() {
  // SSR / jsdom without a matchMedia polyfill: assume fine, i.e. behave exactly
  // as the app did before this hook existed.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/**
 * Whether the primary pointer is coarse (touch), resolved synchronously on the
 * first render and kept live afterwards.
 *
 * Reactive because the answer genuinely changes at runtime: detaching an iPad
 * from its keyboard, or plugging a mouse into an Android tablet, flips the
 * media query, and a surface opened after that change must behave the new way.
 */
export function useCoarsePointer() {
  const [isCoarse, setIsCoarse] = React.useState<boolean>(readCoarsePointer);

  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(COARSE_POINTER_QUERY);
    const onChange = () => setIsCoarse(mql.matches);
    mql.addEventListener("change", onChange);
    // Re-read once mounted: the first paint may have happened before the
    // browser settled on a pointer type (hybrid devices, restored sessions).
    setIsCoarse(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isCoarse;
}

interface TouchSafeInitialFocusOptions {
  /**
   * What to focus when the pointer is *fine*. Omit to let Radix place initial
   * focus exactly as it does today (first tabbable element) — which is what
   * every surface using this helper wants on a desktop.
   */
  onFinePointerAutoFocus?: () => void;
}

/**
 * Initial focus for a Radix surface (Dialog, Popover, Sheet) that must not
 * summon the software keyboard merely by opening.
 *
 * Radix places initial focus on the first tabbable descendant. On these
 * surfaces that descendant is a text field — "New project name", "Search
 * projects…", the preset name — so on a touch device *opening* the surface
 * raised the keyboard, which covered the very list the user opened it to read
 * and stole the first touch-pan. Opening a selector is not consent to type.
 *
 * On a coarse pointer this focuses a deliberate non-text target instead
 * (attach `focusRef` to the surface's heading with `tabIndex={-1}`, or to the
 * popover content itself, which Radix already renders with `tabIndex={-1}`).
 * Focus therefore still lands *inside* the open surface — the focus trap, the
 * Escape handler and PFA-C09's focus restoration are all untouched — it simply
 * lands somewhere that is not an input. Tapping the field still focuses it and
 * still raises the keyboard, because that is an explicit request to type.
 *
 * On a fine pointer nothing changes unless `onFinePointerAutoFocus` is given,
 * so desktop keyboard workflows keep their existing autofocus.
 *
 * This is the `onOpenAutoFocus` lifecycle Radix exposes for exactly this
 * purpose — not a timer, not a `blur()`, and not a disabled focus trap.
 */
export function useTouchSafeInitialFocus<T extends HTMLElement>(
  options?: TouchSafeInitialFocusOptions,
) {
  const isCoarse = useCoarsePointer();
  const focusRef = React.useRef<T>(null);
  const onFinePointerAutoFocus = options?.onFinePointerAutoFocus;

  const onOpenAutoFocus = React.useCallback(
    (event: Event) => {
      if (isCoarse) {
        event.preventDefault();
        focusRef.current?.focus();
        return;
      }
      if (onFinePointerAutoFocus) {
        event.preventDefault();
        onFinePointerAutoFocus();
      }
      // Otherwise fall through to Radix's own initial focus, unchanged.
    },
    [isCoarse, onFinePointerAutoFocus],
  );

  return { focusRef, onOpenAutoFocus, isCoarse };
}
