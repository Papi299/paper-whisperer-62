import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * SCROLLAREA-HORIZONTAL-REACHABILITY-AUDIT-001 — structural contracts.
 *
 * These are deliberately NOT geometry assertions. jsdom has no layout, so it
 * cannot show that a row fits inside a popover; only a real browser can, and
 * `e2e/scrollarea-reachability.spec.ts` does exactly that with hit-testing and
 * `scrollLeft`.
 *
 * What this file pins is the narrow structural cause a reviewer would otherwise
 * delete as noise: which ScrollArea carries the wrapper override, and which rows
 * are allowed to shrink. Each assertion below failed on the audited baseline
 * (`a4285f68`) and names the measurement that proved it.
 */

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../../..", rel), "utf-8");

describe("Radix ScrollArea content wrapper overrides", () => {
  /**
   * Radix styles the wrapper `display: table; min-width: 100%`, so it is never
   * narrower than its own min-content width — and `truncate` makes a line's
   * min-content its full length. Measured before the fix, at every viewport
   * from 1280 down to 390: wrapper 511px inside a 286px viewport, every option
   * row 216.5px past the right edge, `overflow-x: hidden`, no horizontal
   * scrollbar mounted, `scrollLeft` pinned at 0.
   */
  it("KeywordFilterDropdown pins its option list to the viewport width", () => {
    const src = read("components/papers/KeywordFilterDropdown.tsx");
    expect(src).toContain(
      'const SCROLL_CONTENT_FITS_WIDTH = "[&_[data-radix-scroll-area-viewport]>div]:!block"',
    );
    expect(src).toMatch(
      /<ScrollArea className=\{cn\("h-64", SCROLL_CONTENT_FITS_WIDTH\)\}>/,
    );
  });

  /** Measured before the fix: wrapper 495px inside a 270px viewport. */
  it("AnalyticsContent pins its target-selector list to the viewport width", () => {
    const src = read("components/papers/AnalyticsContent.tsx");
    expect(src).toContain(
      'const SCROLL_CONTENT_FITS_WIDTH = "[&_[data-radix-scroll-area-viewport]>div]:!block"',
    );
    expect(src).toMatch(
      /<ScrollArea className=\{cn\("max-h-\[300px\] overflow-y-auto", SCROLL_CONTENT_FITS_WIDTH\)\}>/,
    );
  });

  /**
   * The shared primitive is the one thing this audit must NOT change: ten
   * surfaces render through it and their current layout depends on the Radix
   * behaviour. Every fix above is local for that reason.
   */
  it("leaves the shared ScrollArea primitive alone", () => {
    const src = read("components/ui/scroll-area.tsx");
    expect(src).toContain(
      '<ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">',
    );
    expect(src).not.toContain("data-radix-scroll-area-viewport");
    expect(src).not.toContain("!block");
  });
});

describe("DeduplicationDialog row shrinkability", () => {
  const src = read("components/papers/DeduplicationDialog.tsx");

  /**
   * This surface has no `truncate` anywhere — the five historical matches were
   * calls to a local string helper of the same name. Its overflow came from
   * something else entirely: a DOI is one token with no break opportunity, so
   * its min-content width is its full length. Measured at 390px before the fix:
   * wrapper 515px inside a 324px viewport, every paper row 174.3px past the
   * edge, carrying the "Keep" badge and the copy count off-screen. Desktop and
   * 1024px measured clean, so this one is narrow-viewport only — and the mobile
   * More menu opens this very dialog, so it is genuinely reachable there.
   */
  it("lets the identifier badge break instead of setting the card width", () => {
    expect(src).toMatch(
      /<Badge variant="outline" className="font-mono text-xs min-w-0 break-all">/,
    );
  });

  it("keeps the copy count from being pushed off the group header", () => {
    expect(src).toContain('<div className="flex items-center justify-between gap-2">');
    expect(src).toContain('<span className="shrink-0 text-xs text-muted-foreground">');
  });

  /** The paper row is a grid item of the RadioGroup; its automatic minimum size
   *  is content-based, so without `min-w-0` it cannot take the width it is given. */
  it("lets each paper row shrink to the width it is given", () => {
    expect(src).toContain("flex min-w-0 items-start gap-3 rounded-md border p-3");
  });

  it("gives the inline identifiers break opportunities", () => {
    expect(src).toContain('<span className="font-mono break-all">PMID: {paper.pmid}</span>');
    expect(src).toContain('<span className="font-mono break-all">');
  });
});
