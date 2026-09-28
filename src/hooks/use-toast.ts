import type { ReactNode } from "react";
import { toast as sonnerToast } from "sonner";

import { TOAST_DURATION_MS, type ToastVariant } from "@/lib/toastPolicy";

/**
 * The app's one way to show a notification.
 *
 * PaperLume used to mount two toasters: the shadcn/Radix one behind this hook
 * and a Sonner one used directly by the synonym pool. The Radix one kept a
 * provider-wide "paused" flag that a hand-closed notification could leave set,
 * after which later notifications never started their timer and stayed until
 * clicked (UI-TOAST-LIFECYCLE-CONSISTENCY-001). Every notification now goes
 * through here to the single Sonner `<Toaster />` in `App.tsx`.
 *
 * The call-site contract is unchanged — `toast({ title, description, variant })`
 * — so no caller had to move. Lifetimes are not a caller's choice: there is no
 * `duration` option, and the variant picks one from `TOAST_DURATION_MS`.
 */
export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  /** `"destructive"` for errors and warnings; the default for everything else. */
  variant?: ToastVariant;
}

function toast({ title, description, variant = "default" }: ToastOptions): void {
  const options = { description, duration: TOAST_DURATION_MS[variant] };
  if (variant === "destructive") {
    sonnerToast.error(title, options);
  } else {
    sonnerToast(title, options);
  }
}

/** Module-level, so every render hands hooks the same `toast` for their dependency lists. */
const api = { toast } as const;

function useToast() {
  return api;
}

export { useToast, toast };
