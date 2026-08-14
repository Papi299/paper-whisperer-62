import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "@/hooks/useColumnWidths";

/** Width delta applied per arrow-key press on a column resize separator. */
export const RESIZE_STEP = 16;
/** Width delta applied per Shift+arrow-key press on a column resize separator. */
export const RESIZE_STEP_LARGE = 64;

/**
 * Keyboard model for the table's column-resize separators.
 *
 * Column resizing used to be pointer-only — a bare `onMouseDown` on a `<div>` —
 * which left a real, user-facing capability unreachable without a mouse. This
 * is the keyboard half of that control, kept out of the component so it can be
 * exercised directly.
 *
 * Returns the requested next width, already clamped to the same bounds
 * `useColumnWidths.setColumnWidth` enforces, or `null` when the key is not one
 * this control claims — the caller must then leave the event untouched so it
 * keeps its default behaviour (Tab still moves focus, so there is no trap).
 */
export function nextWidthForResizeKey(
  key: string,
  shiftKey: boolean,
  currentWidth: number,
): number | null {
  const step = shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
  let target: number;
  switch (key) {
    case "ArrowRight":
      target = currentWidth + step;
      break;
    case "ArrowLeft":
      target = currentWidth - step;
      break;
    case "Home":
      target = MIN_COLUMN_WIDTH;
      break;
    case "End":
      target = MAX_COLUMN_WIDTH;
      break;
    default:
      return null;
  }
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, target));
}
