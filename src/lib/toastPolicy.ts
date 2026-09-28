/**
 * PaperLume's notification timing policy — the single place a toast's lifetime
 * is decided. Nothing else in the app passes a duration: `useToast()` picks one
 * of these by variant and the Toaster falls back to the default, so no
 * notification's lifetime is left to a third-party library default.
 *
 * Every notification closes on its own. There is deliberately no "persistent"
 * tier: no current message needs the user to act on it, and a notification
 * that waits for a click is exactly the defect this policy replaces
 * (UI-TOAST-LIFECYCLE-CONSISTENCY-001).
 *
 * - `default` (success and information): long enough to read a title plus a
 *   one-sentence description.
 * - `destructive` (errors and warnings): longer, because these are the
 *   messages a user most needs to read in full, and several carry a summary
 *   plus a note.
 *
 * Hovering a notification pauses its timer so a longer message can be
 * finished; moving away resumes it, and a hidden browser tab pauses it too.
 */
export const TOAST_DURATION_MS = {
  default: 5_000,
  destructive: 8_000,
} as const;

export type ToastVariant = keyof typeof TOAST_DURATION_MS;
