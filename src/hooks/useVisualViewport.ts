import * as React from "react";

export interface VisualViewportMetrics {
  /** Height of the region the user can actually see right now, in CSS pixels. */
  height: number;
  /**
   * How much of the layout viewport is currently obscured at the bottom —
   * in practice, the software keyboard. `0` whenever nothing is covering it.
   */
  bottomInset: number;
}

function readMetrics(): VisualViewportMetrics {
  if (typeof window === "undefined") return { height: 0, bottomInset: 0 };
  const vv = window.visualViewport;
  if (!vv) return { height: window.innerHeight, bottomInset: 0 };
  // What the layout viewport still claims minus what is actually visible below
  // the current scroll offset. Clamped: browsers report fractional values that
  // can round to a pixel or two of negative inset.
  const bottomInset = Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
  return { height: Math.round(vv.height), bottomInset };
}

/**
 * Tracks the *visual* viewport — the part of the screen not covered by the
 * software keyboard.
 *
 * A phone keyboard does not resize the **layout** viewport, so `100vh`, `100dvh`
 * and `position: fixed; bottom: 0` all keep describing the whole screen while
 * its bottom third is covered. A bottom sheet sized and pinned that way puts its
 * footer — and the last of its options — underneath the keyboard, which is
 * exactly the owner's Production report: the list "appears near the bottom" and
 * cannot be reached. `dvh` does not fix it either; it tracks collapsing browser
 * chrome, not the keyboard. `window.visualViewport` is the only API that reports
 * what is genuinely left, so consumers cap their height by `height` and lift
 * themselves off the bottom edge by `bottomInset`.
 *
 * Listeners are attached only while `enabled`, so a closed selector observes
 * nothing.
 *
 * Note for tests: resizing a headless viewport moves `innerHeight` and
 * `visualViewport.height` together, so `bottomInset` stays 0 and only `height`
 * changes. That models a smaller screen, not a keyboard overlaying a full-size
 * one — a proxy for the constrained height, not proof of the inset behaviour.
 */
export function useVisualViewport(enabled: boolean): VisualViewportMetrics {
  const [metrics, setMetrics] = React.useState<VisualViewportMetrics>(readMetrics);

  React.useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    // Re-read on open: the viewport may have changed while this was disabled.
    setMetrics(readMetrics());

    const update = () => {
      setMetrics((prev) => {
        const next = readMetrics();
        // Keyboard animations fire a burst of events; skip no-op state updates
        // so the sheet does not re-render on every frame of one.
        return prev.height === next.height && prev.bottomInset === next.bottomInset
          ? prev
          : next;
      });
    };

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", update);
      // The visual viewport also *scrolls* within the layout viewport when the
      // keyboard opens, which changes the inset without changing the height.
      vv.addEventListener("scroll", update);
    }
    window.addEventListener("resize", update);

    return () => {
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      }
      window.removeEventListener("resize", update);
    };
  }, [enabled]);

  return metrics;
}
