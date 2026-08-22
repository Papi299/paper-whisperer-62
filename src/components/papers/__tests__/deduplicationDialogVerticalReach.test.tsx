import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * DEDUPLICATION-DIALOG-VERTICAL-SCROLL-REACHABILITY-001 — structural contract.
 *
 * jsdom has no layout, so nothing here can show that the duplicate list
 * scrolls; `e2e/scrollarea-reachability.spec.ts` does that in real Chromium,
 * with wheel, touch and keyboard, and with a negative control that puts the old
 * cap back and proves the rows become unreachable again. Real Chromium remains
 * the authority.
 *
 * What this file pins is the one thing a reviewer would otherwise tidy away:
 * WHICH element carries the height cap. `max-h-[55vh]` on the ScrollArea root
 * reads as the obvious spelling and is the defect; the cap has to sit on the
 * Radix viewport, which is the element that actually scrolls.
 */

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../../..", rel), "utf-8");

describe("DeduplicationDialog results-region height ownership", () => {
  const src = read("components/papers/DeduplicationDialog.tsx");

  /**
   * Measured on `9d6c0c8` at 390x844 with three duplicate groups: root 464px
   * (`max-height: 464.2px`, `overflow: hidden`) around a 2602px viewport whose
   * `scrollHeight === clientHeight`. No scrollbar, no wheel response, and seven
   * of the nine paper rows clipped away below the root's bottom edge.
   */
  it("caps the Radix viewport, which is the element that scrolls", () => {
    expect(src).toContain(
      'const RESULTS_SCROLL_CAP =\n  "[&_[data-radix-scroll-area-viewport]]:max-h-[55vh]";',
    );
    expect(src).toContain(
      "<ScrollArea className={`flex-1 pr-4 ${RESULTS_SCROLL_CAP}`}>",
    );
  });

  /**
   * The root is a `flex-1` item of an auto-height column, so a cap here leaves
   * its height indefinite — the viewport's `h-full` then resolves to `auto` and
   * grows to its content while the root silently clips it.
   */
  it("keeps every height cap off the ScrollArea root", () => {
    const scrollArea = src.match(/<ScrollArea[^>]*>/g) ?? [];
    expect(scrollArea).toHaveLength(1);
    expect(scrollArea[0]).not.toMatch(/(^|[^-])max-h-\[/);
    expect(scrollArea[0]).not.toMatch(/\bh-\[/);
  });

  /**
   * The local override is only load-bearing while the shared primitive still
   * sizes its viewport with a percentage. If that ever changes, this test
   * should be revisited rather than the override deleted.
   */
  it("relies on a shared primitive it does not modify", () => {
    const primitive = read("components/ui/scroll-area.tsx");
    expect(primitive).toContain(
      '<ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">',
    );
    expect(primitive).toContain('className={cn("relative overflow-hidden", className)}');
    expect(primitive).not.toContain("max-h");
  });

  /**
   * The cap must not be paid for by the states that have nothing to scroll: the
   * scanning spinner and the "no duplicates" panel live outside the ScrollArea,
   * so neither can reserve 55vh of empty scroller.
   */
  it("renders the scrolling region only when there are duplicates to show", () => {
    const guarded = src.slice(src.indexOf("{hasDuplicates && ("));
    expect(guarded).toContain("<ScrollArea");
    expect(src.slice(0, src.indexOf("{hasDuplicates && ("))).not.toContain("<ScrollArea");
    expect(src).toContain("{scanning && (");
    expect(src).toContain("{hasScanned && !scanning && (");
  });
});
