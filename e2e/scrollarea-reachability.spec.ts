import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * SCROLLAREA-HORIZONTAL-REACHABILITY-AUDIT-001
 *
 * Radix wraps a `ScrollArea`'s children in an element styled
 * `display: table; min-width: 100%`. A table box is never laid out narrower
 * than its own min-content width, and `truncate` sets `white-space: nowrap`,
 * which makes a line's min-content width its FULL length. So a long label does
 * not get clipped by the viewport — it widens the wrapper past it.
 *
 * The viewport is `overflow-x: hidden` and `ui/scroll-area` mounts only a
 * VERTICAL scrollbar, so whatever ends up out there is reachable by script and
 * by nobody else: no scrollbar, no wheel, no drag. Playwright's own `.click()`
 * calls `scrollIntoViewIfNeeded`, which sets `scrollLeft` even here — which is
 * exactly how this class of defect passed a green suite in
 * AUTHOR-IDENTITY-PICKER-USABILITY-001.
 *
 * Nothing below uses `.click()` or `toBeVisible()` as evidence of reachability.
 * Horizontal containment is measured with NO scrolling of any kind, because
 * horizontal is the axis the user cannot scroll; vertical reachability is
 * measured after scrolling vertically, because that axis they can.
 */

/**
 * A keyword long enough to exceed the 288px filter popover, but still a
 * plausible MeSH-style phrase rather than a robustness stunt.
 */
const LONG_KEYWORD =
  "postoperative cognitive dysfunction following cardiopulmonary bypass";

async function openKeywordPool(page: Page) {
  // A filter popover left open would swallow the first click as an
  // outside-dismiss, so close whatever is open before reaching for the rail.
  await page.keyboard.press("Escape");
  const gear = page
    .getByText("Keyword Pool")
    .locator("xpath=ancestor::div[contains(@class, 'justify-between')][1]")
    .locator("button");
  await gear.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

/** Adds the fixture keyword to the pool through the real modal. */
async function addPoolKeyword(page: Page, keyword: string) {
  const dialog = await openKeywordPool(page);
  await dialog.getByPlaceholder(/Add a keyword/).fill(keyword);
  await dialog.getByRole("button", { name: "Add keyword to pool" }).click();
  await expect(
    dialog.getByRole("button", { name: `Remove keyword ${keyword} from pool` }),
  ).toBeAttached({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });
}

/** Removes it again, so the spec is order-independent (see DEFAULT_SPECS). */
async function removePoolKeyword(page: Page, keyword: string) {
  const dialog = await openKeywordPool(page);
  const remove = dialog.getByRole("button", {
    name: `Remove keyword ${keyword} from pool`,
  });
  // `count()` does not auto-wait, so give the list a chance to render before
  // concluding there is nothing to clean up.
  await remove
    .first()
    .waitFor({ state: "attached", timeout: 5_000 })
    .catch(() => undefined);
  if (await remove.count()) {
    await remove.first().click();
    await expect(remove).toHaveCount(0, { timeout: 10_000 });
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });
}

/**
 * The measurement contract.
 *
 * Returns geometry for the scroll viewport containing `rows`, plus, per row,
 * horizontal containment taken without scrolling and a centre-point hit test
 * taken after vertical scrolling only.
 */
async function measure(scope: Locator) {
  return scope.evaluate((node: HTMLElement) => {
    const viewport = node.closest(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement;
    const wrapper = viewport.firstElementChild as HTMLElement;
    const rows = [...viewport.querySelectorAll("label")] as HTMLElement[];
    const vb = viewport.getBoundingClientRect();

    const measured = rows.map((row) => {
      const r = row.getBoundingClientRect();
      // Horizontal: as it stands, no scrolling. This is the axis with no
      // scrollbar, so anything outside is outside for good.
      const insideHorizontally = r.left >= vb.left - 1 && r.right <= vb.right + 1;

      /*
       * Vertical: reached the way a user reaches it, then hit-tested.
       *
       * Deliberately NOT `scrollIntoView({ block: "nearest" })`. `inline`
       * defaults to `"nearest"`, so on a row that IS horizontally out of view
       * it quietly scrolls sideways too — the exact programmatic rescue this
       * spec exists to forbid, performed by the measurement itself. Measured:
       * it moved `scrollLeft` 0 → 8 in the negative control. Driving
       * `scrollTop` alone cannot touch the other axis.
       */
      const vb0 = viewport.getBoundingClientRect();
      viewport.scrollTop += r.top + r.height / 2 - (vb0.top + vb0.height / 2);
      const r2 = row.getBoundingClientRect();
      const vb2 = viewport.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(r2.x + r2.width / 2),
        Math.round(r2.y + r2.height / 2),
      );
      return {
        text: (row.textContent ?? "").trim().slice(0, 40),
        insideHorizontally,
        rightOverhangPx: Math.round(Math.max(0, r.right - vb.right)),
        pressAtItsCentreLandsOnIt: hit !== null && row.contains(hit),
      };
    });

    // A `truncate` line that is doing its job clips its own box. One that has
    // widened the wrapper instead does not, and shows no ellipsis at all.
    const labels = [...viewport.querySelectorAll("span.truncate")] as HTMLElement[];

    return {
      viewport: {
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
        scrollLeft: viewport.scrollLeft,
        overflowX: getComputedStyle(viewport).overflowX,
      },
      wrapper: {
        display: getComputedStyle(wrapper).display,
        width: Math.round(wrapper.getBoundingClientRect().width),
      },
      rows: measured,
      longLabelsClipTheirOwnBox: labels
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => ({
          text: (el.textContent ?? "").slice(0, 30),
          clipsItself: el.scrollWidth > el.clientWidth,
        })),
    };
  });
}

/** Opens the keyword filter popover and returns its option list scope. */
async function openKeywordFilter(page: Page) {
  await page.getByRole("button", { name: /Filter by keyword/i }).first().click();
  const option = page
    .getByRole("dialog")
    .or(page.locator("[data-radix-popper-content-wrapper]"))
    .locator("label")
    .first();
  await expect(option).toBeAttached({ timeout: 10_000 });
  return option;
}

test.describe("ScrollArea horizontal reachability", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByText(/\d+\s+paper/i)).toBeVisible({ timeout: 15_000 });
    await addPoolKeyword(page, LONG_KEYWORD);
  });

  test.afterEach(async ({ page }) => {
    await removePoolKeyword(page, LONG_KEYWORD);
  });

  for (const size of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "narrow desktop", width: 1024, height: 800 },
  ]) {
    test(`a long keyword cannot push the filter list out of its popover (${size.name})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const scope = await openKeywordFilter(page);
      const geometry = await measure(scope);

      // The decisive measurement. Before the fix this read 511 against 286.
      expect(
        geometry.viewport.scrollWidth,
        "the option list overflows a viewport with no horizontal scrollbar",
      ).toBeLessThanOrEqual(geometry.viewport.clientWidth);

      // The mechanism itself, asserted directly so a regression names its cause.
      expect(
        geometry.wrapper.display,
        "the Radix content wrapper is sizing to its content again",
      ).toBe("block");
      expect(geometry.wrapper.width).toBeLessThanOrEqual(
        geometry.viewport.clientWidth,
      );

      expect(geometry.rows.length).toBeGreaterThan(0);
      for (const row of geometry.rows) {
        expect(
          row.insideHorizontally,
          `"${row.text}" sits ${row.rightOverhangPx}px outside the popover on the axis the user cannot scroll`,
        ).toBe(true);
        expect(
          row.pressAtItsCentreLandsOnIt,
          `"${row.text}" cannot be pressed where it is drawn`,
        ).toBe(true);
      }

      // `truncate` is only truthful when the box actually clips.
      const longLabel = geometry.longLabelsClipTheirOwnBox.find((l) =>
        LONG_KEYWORD.startsWith(l.text.trim().slice(0, 20)),
      );
      expect(longLabel?.clipsItself, "the long keyword shows no ellipsis").toBe(
        true,
      );

      // Nothing above needed a sideways scroll, because nothing is out there.
      expect(
        geometry.viewport.scrollLeft,
        "the option list scrolled sideways",
      ).toBe(0);
      expect(geometry.viewport.overflowX).toBe("hidden");
    });
  }

  test("keyboard traversal never moves the list sideways", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const scope = await openKeywordFilter(page);

    // Walk the options the way a keyboard user does, not with .focus().
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("Tab");

    const state = await scope.evaluate((node: HTMLElement) => {
      const viewport = node.closest(
        "[data-radix-scroll-area-viewport]",
      ) as HTMLElement;
      const active = document.activeElement as HTMLElement | null;
      const vb = viewport.getBoundingClientRect();
      const ab = active?.getBoundingClientRect();
      return {
        scrollLeft: viewport.scrollLeft,
        focusInsideViewport:
          !ab || !viewport.contains(active)
            ? null
            : ab.left >= vb.left - 1 && ab.right <= vb.right + 1,
      };
    });

    expect(state.scrollLeft, "focus dragged the list sideways").toBe(0);
    if (state.focusInsideViewport !== null) {
      expect(
        state.focusInsideViewport,
        "the focused option is outside the visible popover",
      ).toBe(true);
    }
  });

  test("NEGATIVE CONTROL: reintroducing the table wrapper strands the rows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const scope = await openKeywordFilter(page);

    // Put back the exact layout cause — and nothing else — so the assertions
    // above are shown to be load-bearing rather than trivially true.
    await page.addStyleTag({
      // The fix is a Tailwind arbitrary variant, so its selector already carries
      // a class plus this attribute and type — an unqualified
      // `[data-radix-scroll-area-viewport] > div` rule loses to it even with
      // `!important`, and would quietly "reproduce" nothing. `html body` and the
      // `:not(#x)` raise specificity above it.
      content:
        "html body [data-radix-scroll-area-viewport] > div:not(#x) { display: table !important; min-width: 100% !important; }",
    });
    const broken = await measure(scope);

    expect(broken.wrapper.display).toBe("table");
    expect(
      broken.viewport.scrollWidth,
      "the reintroduced cause did not reproduce the overflow",
    ).toBeGreaterThan(broken.viewport.clientWidth);
    expect(
      broken.rows.some((r) => !r.insideHorizontally),
      "the reintroduced cause did not strand any row",
    ).toBe(true);
    // And still no way for a person to reach what it pushed out.
    expect(broken.viewport.scrollLeft).toBe(0);
    expect(broken.viewport.overflowX).toBe("hidden");
  });
});
