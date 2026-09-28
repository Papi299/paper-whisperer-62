import { Toaster as Sonner } from "sonner";

import { TOAST_DURATION_MS } from "@/lib/toastPolicy";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * The app's single notification toaster, mounted once in `App.tsx`. Show
 * notifications through `useToast()` rather than importing `sonner` directly,
 * so every one follows `TOAST_DURATION_MS`.
 *
 * - `theme="light"`: the app never applies its `.dark` palette, so following
 *   the OS theme would give dark close buttons on light notifications.
 * - `closeButton`: a labelled ("Close toast") manual dismiss on every
 *   notification. Closing one resets nothing that a later one depends on.
 * - `pauseWhenPageIsHidden`: a notification that arrives while the tab is in
 *   the background waits to be seen. Hovering pauses too; both resume.
 * - `pointer-events-auto`: a modal dialog sets `pointer-events: none` on
 *   <body>, which notifications would otherwise inherit and become
 *   unreachable. Pressing one must not dismiss the dialog underneath — see
 *   `isNotificationEventTarget` below.
 * - `select-none`: a press on a notification can never turn into a text drag,
 *   whose `pointercancel` would skip the `pointerup` that ends Sonner's pause.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      closeButton
      duration={TOAST_DURATION_MS.default}
      pauseWhenPageIsHidden
      toastOptions={{
        classNames: {
          toast:
            "group toast pointer-events-auto select-none group-[.toaster]:border-border group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:shadow-lg group-[.toaster]:data-[type=error]:border-destructive group-[.toaster]:data-[type=error]:bg-destructive group-[.toaster]:data-[type=error]:text-destructive-foreground",
          title: "group-[.toast]:text-sm group-[.toast]:font-semibold",
          description: "group-[.toast]:text-sm group-[.toast]:opacity-90",
          closeButton: "group-[.toast]:border-border group-[.toast]:bg-background group-[.toast]:text-foreground",
        },
      }}
      {...props}
    />
  );
};

/**
 * Whether an event started inside the notification toaster. Radix dialogs treat
 * any press outside their content as a request to close (radix-ui/primitives
 * #2690), and notifications render outside every dialog; the dialog and sheet
 * contents use this to ignore presses on a notification or its close button.
 */
function isNotificationEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-sonner-toaster]") !== null;
}

export { Toaster, isNotificationEventTarget };
