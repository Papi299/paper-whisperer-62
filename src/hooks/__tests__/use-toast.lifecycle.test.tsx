import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Toaster } from "@/components/ui/sonner";
import { toast, useToast } from "@/hooks/use-toast";
import { TOAST_DURATION_MS } from "@/lib/toastPolicy";

/**
 * UI-TOAST-LIFECYCLE-CONSISTENCY-001 — the notification lifecycle, end to end
 * through the app's own `toast()` and the one mounted `<Toaster />`, on fake
 * timers so every interval is exact.
 *
 * The previous Radix toaster kept a provider-wide "paused" flag. Closing a
 * notification by hand with the pointer over it left that flag set once the
 * last toast unmounted, and every later notification then skipped its timer
 * and stayed until clicked. The cases below pin the properties that defect
 * broke, not the library that replaced it.
 */

/** Sonner keeps a closed toast mounted this long for its exit transition (sonner 1.7.4). */
const EXIT_MS = 200;

beforeAll(() => {
  // Sonner captures the pointer on press; jsdom does not implement capture.
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Advance fake time inside `act`, so Sonner's state updates and effects commit. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Show a notification. Sonner hands it to React on a zero-delay timer. */
function show(options: Parameters<typeof toast>[0]) {
  act(() => {
    toast(options);
  });
  advance(0);
}

/** The rendered notification with this exact title, or null once it has gone. */
function notification(title: string): HTMLElement | null {
  return screen.queryByText(title, { exact: true })?.closest<HTMLElement>("[data-sonner-toast]") ?? null;
}

function toasterList(): HTMLElement {
  const list = document.querySelector<HTMLElement>("[data-sonner-toaster]");
  if (!list) throw new Error("no notification is showing");
  return list;
}

/** Press the notification's own close button the way a mouse does. */
function closeByHand(title: string) {
  const item = notification(title);
  if (!item) throw new Error(`"${title}" is not showing`);
  const close = item.querySelector<HTMLElement>('button[aria-label="Close toast"]');
  if (!close) throw new Error(`"${title}" has no close button`);
  fireEvent.pointerDown(close);
  fireEvent.pointerUp(close);
  fireEvent.click(close);
}

describe("notification lifecycle", () => {
  it("shows an ordinary notification for the full default interval, then closes it by itself", () => {
    render(<Toaster />);
    show({ title: "Paper deleted", description: "Attachment file cleanup is pending." });

    expect(notification("Paper deleted")).not.toBeNull();
    expect(screen.getByText("Attachment file cleanup is pending.")).toBeInTheDocument();

    advance(TOAST_DURATION_MS.default - 1);
    expect(notification("Paper deleted")).toHaveAttribute("data-removed", "false");

    advance(1 + EXIT_MS);
    expect(notification("Paper deleted")).toBeNull();
  });

  it("gives errors and warnings the longer destructive interval, then closes them by itself", () => {
    render(<Toaster />);
    show({ title: "Bulk import complete with warnings", variant: "destructive" });

    const item = notification("Bulk import complete with warnings");
    expect(item).toHaveAttribute("data-type", "error");

    advance(TOAST_DURATION_MS.destructive - 1);
    expect(notification("Bulk import complete with warnings")).toHaveAttribute("data-removed", "false");

    advance(1 + EXIT_MS);
    expect(notification("Bulk import complete with warnings")).toBeNull();
  });

  it("closes at once from its labelled close button", () => {
    render(<Toaster />);
    show({ title: "Keywords updated" });

    const close = screen.getByRole("button", { name: "Close toast" });
    expect(close.tagName).toBe("BUTTON");
    closeByHand("Keywords updated");
    advance(EXIT_MS);

    expect(notification("Keywords updated")).toBeNull();
  });

  it("does not strand the next notification after one is closed by hand under the pointer", () => {
    render(<Toaster />);
    show({ title: "Paper deleted" });

    // The owner's sequence: move onto the notification, press its close button,
    // and leave the pointer where it was — no mouseleave ever arrives.
    fireEvent.mouseEnter(toasterList());
    fireEvent.mouseMove(toasterList());
    closeByHand("Paper deleted");
    advance(EXIT_MS);
    expect(notification("Paper deleted")).toBeNull();

    show({ title: "Keywords updated" });
    advance(TOAST_DURATION_MS.default + EXIT_MS);

    expect(notification("Keywords updated")).toBeNull();
  });

  it("does not strand a notification that arrives while the hand-closed one is still leaving", () => {
    render(<Toaster />);
    show({ title: "Paper deleted" });

    fireEvent.mouseEnter(toasterList());
    fireEvent.mouseMove(toasterList());
    closeByHand("Paper deleted");
    show({ title: "Bulk import complete" });

    // Held while the pointer is over the toaster; released when the closed one
    // unmounts (a separate step, so React commits that removal before time runs on).
    advance(EXIT_MS);
    expect(notification("Paper deleted")).toBeNull();
    expect(notification("Bulk import complete")).toHaveAttribute("data-removed", "false");

    // …then it runs its own full interval and closes.
    advance(TOAST_DURATION_MS.default - 1);
    expect(notification("Bulk import complete")).toHaveAttribute("data-removed", "false");
    advance(1 + EXIT_MS);
    expect(notification("Bulk import complete")).toBeNull();
  });

  it("closes every one of a run of notifications by itself", () => {
    render(<Toaster />);

    for (let i = 1; i <= 5; i++) {
      show({ title: `Saved ${i}` });
      expect(notification(`Saved ${i}`)).not.toBeNull();
      advance(TOAST_DURATION_MS.default + EXIT_MS);
      expect(notification(`Saved ${i}`)).toBeNull();
    }
  });

  it("closes a burst of stacked notifications by itself, including the ones stacked out of sight", () => {
    render(<Toaster />);
    for (let i = 1; i <= 5; i++) show({ title: `Burst ${i}` });

    advance(TOAST_DURATION_MS.default + EXIT_MS);

    for (let i = 1; i <= 5; i++) expect(notification(`Burst ${i}`)).toBeNull();
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });

  it("pauses while hovered and resumes the remaining time when the pointer leaves", () => {
    render(<Toaster />);
    show({ title: "Preset saved" });

    advance(2_000);
    fireEvent.mouseEnter(toasterList());
    advance(60_000);
    expect(notification("Preset saved")).toHaveAttribute("data-removed", "false");

    fireEvent.mouseLeave(toasterList());
    advance(TOAST_DURATION_MS.default - 2_000 - 1);
    expect(notification("Preset saved")).toHaveAttribute("data-removed", "false");

    advance(1 + EXIT_MS);
    expect(notification("Preset saved")).toBeNull();
  });

  it("pauses while the tab is hidden and resumes when it is shown again", () => {
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    try {
      render(<Toaster />);
      show({ title: "Export started" });

      advance(1_000);
      hidden = true;
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      advance(60_000);
      expect(notification("Export started")).toHaveAttribute("data-removed", "false");

      hidden = false;
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      advance(TOAST_DURATION_MS.default - 1_000 + EXIT_MS);
      expect(notification("Export started")).toBeNull();
    } finally {
      // Drop the own-property override so jsdom's own getter applies again.
      delete (document as { hidden?: boolean }).hidden;
    }
  });
});

describe("notification region", () => {
  it("is one labelled, polite live region", () => {
    render(<Toaster />);

    const regions = screen.getAllByRole("region", { name: /^Notifications\b/ });
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveAttribute("aria-live", "polite");
  });

  it("takes no pointer events once the last notification has gone", () => {
    render(<Toaster />);
    show({ title: "Tag exists" });
    advance(TOAST_DURATION_MS.default + EXIT_MS);

    // The list that could sit over page controls is unmounted, not just faded.
    expect(document.querySelector("[data-sonner-toaster]")).toBeNull();
  });
});

describe("useToast()", () => {
  it("returns the same toast function on every render, so hook dependencies stay stable", () => {
    let first: ReturnType<typeof useToast> | undefined;
    let second: ReturnType<typeof useToast> | undefined;
    function Probe({ pass }: { pass: 1 | 2 }) {
      const api = useToast();
      if (pass === 1) first = api;
      else second = api;
      return null;
    }
    const { rerender } = render(<Probe pass={1} />);
    rerender(<Probe pass={2} />);

    expect(first?.toast).toBe(toast);
    expect(second?.toast).toBe(first?.toast);
  });

  it("leaves lifetimes to the policy: a call site cannot pass its own duration", () => {
    const callSiteWithDuration = () =>
      toast({
        title: "Saved",
        // @ts-expect-error — durations come from TOAST_DURATION_MS, never a call site.
        duration: 60_000,
      });
    expect(typeof callSiteWithDuration).toBe("function");
  });
});
