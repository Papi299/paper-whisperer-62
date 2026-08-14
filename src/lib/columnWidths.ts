/**
 * Single source of truth for paper-table column width policy.
 *
 * Defaults, clamp bounds, and the keyboard resize model all live here so the
 * pointer path (`useColumnWidths.setColumnWidth`), the keyboard path, and the
 * `aria-valuemin` / `aria-valuenow` / `aria-valuemax` a resize separator
 * advertises can never disagree. They previously did: the selection column
 * defaults to 40 px while every separator advertised a global 60 px minimum,
 * so that column's own default sat below its stated floor.
 */

export interface ColumnBounds {
  min: number;
  max: number;
}

/** Default width per column, in px. Columns absent here fall back to `FALLBACK_WIDTH`. */
export const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  checkbox: 40,
  title: 300,
  authors: 150,
  year: 80,
  journal: 120,
  studyType: 120,
  tags: 150,
  keywords: 200,
  links: 120,
};

/** Width used for a column with no entry in `DEFAULT_COLUMN_WIDTHS`. */
export const FALLBACK_WIDTH = 150;

/** Bounds for ordinary data columns. */
export const DEFAULT_COLUMN_BOUNDS: ColumnBounds = { min: 60, max: 600 };

/**
 * Columns whose real constraints differ from the data-column default.
 *
 * The selection column holds nothing but a checkbox, so the 60 px floor that
 * keeps a text column readable does not apply to it — and applying it would
 * put its own 40 px default out of range.
 */
const COLUMN_BOUNDS_OVERRIDES: Record<string, ColumnBounds> = {
  checkbox: { min: 40, max: 600 },
};

/** The clamp bounds actually enforced for a column. */
export function getColumnBounds(columnId: string): ColumnBounds {
  return COLUMN_BOUNDS_OVERRIDES[columnId] ?? DEFAULT_COLUMN_BOUNDS;
}

/** The width a column starts at before the user resizes it. */
export function getDefaultColumnWidth(columnId: string): number {
  return DEFAULT_COLUMN_WIDTHS[columnId] ?? FALLBACK_WIDTH;
}

/** Clamp a requested width to the bounds for that specific column. */
export function clampColumnWidth(columnId: string, width: number): number {
  const { min, max } = getColumnBounds(columnId);
  return Math.max(min, Math.min(max, width));
}

/** Width delta applied per arrow-key press on a column resize separator. */
export const RESIZE_STEP = 16;
/** Width delta applied per Shift+arrow-key press on a column resize separator. */
export const RESIZE_STEP_LARGE = 64;

/**
 * Keyboard model for the table's column-resize separators.
 *
 * Column resizing used to be pointer-only — a bare `onMouseDown` on a `<div>` —
 * which left a real, user-facing capability unreachable without a mouse.
 *
 * Returns the requested next width, already clamped to that column's bounds, or
 * `null` when the key is not one this control claims — the caller must then
 * leave the event untouched so it keeps its default behaviour (Tab still moves
 * focus, so there is no trap).
 */
export function nextWidthForResizeKey(
  key: string,
  shiftKey: boolean,
  currentWidth: number,
  columnId: string,
): number | null {
  const { min, max } = getColumnBounds(columnId);
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
      target = min;
      break;
    case "End":
      target = max;
      break;
    default:
      return null;
  }
  return Math.max(min, Math.min(max, target));
}
