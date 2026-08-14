import * as React from "react";

/**
 * Restores focus to whatever opened a Radix dialog when that dialog closes.
 *
 * Radix's modal `Dialog.Content` (and `Sheet`, which is the same primitive)
 * handles `onCloseAutoFocus` by calling `event.preventDefault()` and then
 * focusing `context.triggerRef.current`. That is correct only when the dialog
 * was opened through a `<DialogTrigger>`. Every dialog in this app is instead
 * *controlled* — opened by a parent setting `open`, with no `DialogTrigger`
 * anywhere — so `triggerRef.current` is `null`, the `?.focus()` is a no-op, and
 * Radix's own preventDefault has already suppressed the FocusScope's natural
 * restore. Focus therefore lands on `<body>`: a keyboard user who closes a
 * dialog is dropped back at the top of the document, losing their place.
 *
 * This re-establishes the expected behaviour using only public Radix events:
 *
 * - `onOpenAutoFocus` fires while `document.activeElement` is still the opener
 *   (Radix's FocusScope reads that element and dispatches this event *before*
 *   moving focus), so it is the right moment to record it.
 * - `onCloseAutoFocus` then calls `preventDefault()` itself, which — because
 *   Radix composes the consumer handler first and skips its own once the
 *   default is prevented — replaces the broken `triggerRef` restore.
 *
 * The opener is skipped when it has since left the DOM (for example a control
 * inside a drawer that closed to make way for this dialog). In that case the
 * event is left alone and Radix's own fallback applies.
 */
export function useDialogFocusRestore() {
  const openerRef = React.useRef<HTMLElement | null>(null);

  const captureOpener = React.useCallback(() => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
  }, []);

  const restoreOpener = React.useCallback((event: Event) => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (!opener || !opener.isConnected) return;
    event.preventDefault();
    opener.focus();
  }, []);

  return { captureOpener, restoreOpener };
}
