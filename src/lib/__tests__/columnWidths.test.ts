import { describe, expect, it } from "vitest";
import { AVAILABLE_COLUMNS } from "@/hooks/useColumnVisibility";
import {
  DEFAULT_COLUMN_BOUNDS,
  DEFAULT_COLUMN_WIDTHS,
  FALLBACK_WIDTH,
  RESIZE_STEP,
  RESIZE_STEP_LARGE,
  clampColumnWidth,
  getColumnBounds,
  getDefaultColumnWidth,
  nextWidthForResizeKey,
} from "@/lib/columnWidths";

/**
 * Column width policy (PFA-C09).
 *
 * The bug these pin: the selection column defaults to 40 px while every resize
 * separator advertised a single global 60 px minimum, so that column exposed
 * `aria-valuenow` *below* its own `aria-valuemin`. Bounds are now per column
 * and shared by the pointer setter, the keyboard model, and the ARIA values.
 */

/** Every column the table can render, including the non-toggleable ones. */
const ALL_COLUMN_IDS = ["checkbox", ...AVAILABLE_COLUMNS.map((c) => c.id)];

describe("column width policy", () => {
  it("keeps every column's default width inside that column's own bounds", () => {
    for (const columnId of ALL_COLUMN_IDS) {
      const { min, max } = getColumnBounds(columnId);
      const width = getDefaultColumnWidth(columnId);
      expect(width, `${columnId} default >= min`).toBeGreaterThanOrEqual(min);
      expect(width, `${columnId} default <= max`).toBeLessThanOrEqual(max);
    }
  });

  it("keeps the selection column's default at its own floor, not the data-column floor", () => {
    // The specific regression: 40 < 60.
    expect(DEFAULT_COLUMN_WIDTHS.checkbox).toBe(40);
    expect(getColumnBounds("checkbox").min).toBeLessThanOrEqual(40);
    expect(DEFAULT_COLUMN_BOUNDS.min).toBe(60);
    expect(getColumnBounds("checkbox").min).toBeLessThan(DEFAULT_COLUMN_BOUNDS.min);
  });

  it("gives unknown columns the fallback width, which is also in bounds", () => {
    // `statisticalMethods` has no entry in DEFAULT_COLUMN_WIDTHS.
    expect(getDefaultColumnWidth("statisticalMethods")).toBe(FALLBACK_WIDTH);
    const { min, max } = getColumnBounds("statisticalMethods");
    expect(FALLBACK_WIDTH).toBeGreaterThanOrEqual(min);
    expect(FALLBACK_WIDTH).toBeLessThanOrEqual(max);
  });

  it("clamps the pointer setter to per-column bounds", () => {
    expect(clampColumnWidth("checkbox", 0)).toBe(getColumnBounds("checkbox").min);
    expect(clampColumnWidth("title", 0)).toBe(DEFAULT_COLUMN_BOUNDS.min);
    expect(clampColumnWidth("title", 99_999)).toBe(DEFAULT_COLUMN_BOUNDS.max);
    // A width legal for the selection column would be illegal for a text column.
    expect(clampColumnWidth("checkbox", 40)).toBe(40);
    expect(clampColumnWidth("title", 40)).toBe(DEFAULT_COLUMN_BOUNDS.min);
  });

  it("never lets the keyboard path and the pointer path disagree", () => {
    for (const columnId of ALL_COLUMN_IDS) {
      for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
        for (const shift of [false, true]) {
          for (const start of [0, 40, 60, 150, 300, 600, 5_000]) {
            const viaKeyboard = nextWidthForResizeKey(key, shift, start, columnId);
            expect(viaKeyboard).not.toBeNull();
            // Whatever the keyboard produces, the setter must accept unchanged.
            expect(clampColumnWidth(columnId, viaKeyboard as number)).toBe(viaKeyboard);
          }
        }
      }
    }
  });

  it("steps by the documented increments and honours Shift", () => {
    expect(nextWidthForResizeKey("ArrowRight", false, 200, "title")).toBe(200 + RESIZE_STEP);
    expect(nextWidthForResizeKey("ArrowLeft", false, 200, "title")).toBe(200 - RESIZE_STEP);
    expect(nextWidthForResizeKey("ArrowRight", true, 200, "title")).toBe(200 + RESIZE_STEP_LARGE);
    expect(nextWidthForResizeKey("ArrowLeft", true, 200, "title")).toBe(200 - RESIZE_STEP_LARGE);
    expect(RESIZE_STEP_LARGE).toBeGreaterThan(RESIZE_STEP);
  });

  it("sends Home/End to that column's own bounds", () => {
    expect(nextWidthForResizeKey("Home", false, 300, "title")).toBe(DEFAULT_COLUMN_BOUNDS.min);
    expect(nextWidthForResizeKey("End", false, 300, "title")).toBe(DEFAULT_COLUMN_BOUNDS.max);
    // Not the global data-column floor — the selection column's own.
    expect(nextWidthForResizeKey("Home", false, 300, "checkbox")).toBe(
      getColumnBounds("checkbox").min,
    );
    expect(nextWidthForResizeKey("Home", false, 300, "checkbox")).not.toBe(
      DEFAULT_COLUMN_BOUNDS.min,
    );
  });

  it("returns null for keys it does not claim, so Tab is never trapped", () => {
    for (const key of ["Tab", "Enter", " ", "Escape", "ArrowUp", "ArrowDown", "a"]) {
      expect(nextWidthForResizeKey(key, false, 200, "title")).toBeNull();
      expect(nextWidthForResizeKey(key, true, 200, "title")).toBeNull();
    }
  });
});
