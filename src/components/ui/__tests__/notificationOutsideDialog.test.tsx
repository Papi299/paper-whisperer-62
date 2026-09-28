import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "@/hooks/use-toast";

/**
 * UI-TOAST-LIFECYCLE-CONSISTENCY-001 — pressing a notification never dismisses
 * the dialog under it.
 *
 * Notifications render outside every dialog, and a Radix dialog closes on any
 * press outside its content (radix-ui/primitives #2690). The previous Radix
 * toaster registered itself as a dismissable-layer branch, so the problem never
 * showed; the Sonner toaster does not, so `DialogContent` and `SheetContent`
 * ignore presses that start inside it. A press anywhere else still closes them,
 * which the control case in each block proves.
 */

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

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function showNotification() {
  act(() => {
    toast({ title: "Attachment uploaded" });
  });
  // Sonner adds the toast, and Radix arms its outside-press listener, on
  // zero-delay timers.
  advance(0);
}

function notificationCloseButton(): HTMLElement {
  return screen.getByRole("button", { name: "Close toast" });
}

describe.each([
  [
    "Dialog",
    (onOpenChange: (open: boolean) => void) => (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Edit paper</DialogTitle>
          <DialogDescription>Unsaved edits live here.</DialogDescription>
        </DialogContent>
      </Dialog>
    ),
  ],
  [
    "Sheet",
    (onOpenChange: (open: boolean) => void) => (
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetTitle>Selection</SheetTitle>
          <SheetDescription>Bulk actions for the selected papers.</SheetDescription>
        </SheetContent>
      </Sheet>
    ),
  ],
])("%s under a notification", (_name, renderOverlay) => {
  it("stays open when the notification's close button is pressed, and the notification closes", () => {
    const onOpenChange = vi.fn();
    render(
      <>
        <Toaster />
        {renderOverlay(onOpenChange)}
      </>,
    );
    showNotification();

    const close = notificationCloseButton();
    fireEvent.pointerDown(close);
    fireEvent.pointerUp(close);
    fireEvent.click(close);
    advance(200);

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.queryByText("Attachment uploaded")).toBeNull();
  });

  it("stays open when the notification body is pressed", () => {
    const onOpenChange = vi.fn();
    render(
      <>
        <Toaster />
        {renderOverlay(onOpenChange)}
      </>,
    );
    showNotification();

    fireEvent.pointerDown(screen.getByText("Attachment uploaded"));

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("control: still closes on a press anywhere else outside it", () => {
    const onOpenChange = vi.fn();
    render(
      <>
        <Toaster />
        {renderOverlay(onOpenChange)}
      </>,
    );
    showNotification();

    fireEvent.pointerDown(document.body);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
