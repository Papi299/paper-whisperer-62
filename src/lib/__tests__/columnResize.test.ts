import { describe, expect, it } from "vitest";
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "@/hooks/useColumnWidths";
import { RESIZE_STEP, RESIZE_STEP_LARGE, nextWidthForResizeKey } from "@/lib/columnResize";

/**
 * Keyboard column resizing (PFA-C09). Before this pass the resize handle was a
 * bare `<div onMouseDown>` with no keyboard path at all, so a real capability
 * was pointer-only. These cases pin the model that replaces it.
 */
describe("nextWidthForResizeKey", () => {
  it("grows by one step on ArrowRight and shrinks by one step on ArrowLeft", () => {
    expect(nextWidthForResizeKey("ArrowRight", false, 200)).toBe(200 + RESIZE_STEP);
    expect(nextWidthForResizeKey("ArrowLeft", false, 200)).toBe(200 - RESIZE_STEP);
  });

  it("uses the larger step when Shift is held", () => {
    expect(nextWidthForResizeKey("ArrowRight", true, 200)).toBe(200 + RESIZE_STEP_LARGE);
    expect(nextWidthForResizeKey("ArrowLeft", true, 200)).toBe(200 - RESIZE_STEP_LARGE);
    expect(RESIZE_STEP_LARGE).toBeGreaterThan(RESIZE_STEP);
  });

  it("clamps to the same bounds setColumnWidth enforces", () => {
    // Shrinking past the floor pins at the floor rather than going negative.
    expect(nextWidthForResizeKey("ArrowLeft", true, MIN_COLUMN_WIDTH + 1)).toBe(MIN_COLUMN_WIDTH);
    expect(nextWidthForResizeKey("ArrowLeft", false, MIN_COLUMN_WIDTH)).toBe(MIN_COLUMN_WIDTH);
    // Growing past the ceiling pins at the ceiling.
    expect(nextWidthForResizeKey("ArrowRight", true, MAX_COLUMN_WIDTH - 1)).toBe(MAX_COLUMN_WIDTH);
    expect(nextWidthForResizeKey("ArrowRight", false, MAX_COLUMN_WIDTH)).toBe(MAX_COLUMN_WIDTH);
  });

  it("jumps to the bounds with Home and End", () => {
    expect(nextWidthForResizeKey("Home", false, 300)).toBe(MIN_COLUMN_WIDTH);
    expect(nextWidthForResizeKey("End", false, 300)).toBe(MAX_COLUMN_WIDTH);
  });

  it("returns null for keys it does not claim, so Tab is never trapped", () => {
    // The component only calls preventDefault when this returns a number, so
    // every one of these keeps its default browser behaviour.
    for (const key of ["Tab", "Enter", " ", "Escape", "ArrowUp", "ArrowDown", "a"]) {
      expect(nextWidthForResizeKey(key, false, 200)).toBeNull();
      expect(nextWidthForResizeKey(key, true, 200)).toBeNull();
    }
  });
});
