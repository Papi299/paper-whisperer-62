/**
 * The handoff, performed by the real `chrome.tabs.create` in a real browser.
 *
 * The button really runs the extension's real code path and Chrome really opens
 * a tab. What it cannot do is arrive: the harness black-holes DNS for every
 * non-loopback name, so the navigation dies at the resolver. That is deliberate
 * and is what makes this safe to run anywhere — no spec here can reach
 * PaperLume Production, authenticate anyone, or create a paper, and CI needs no
 * network egress.
 *
 * Nothing about the extension's behaviour depends on the navigation succeeding.
 * It opens a tab and its responsibility ends there; the import is a decision the
 * user makes later, inside authenticated PaperLume, and no test here presses it.
 */

import { test, expect, PAPERLUME_ORIGIN } from "./support/extensionHarness";

const PUBMED_TAB = "https://pubmed.ncbi.nlm.nih.gov/33301246/";

/** Press the control the way a user does. */
async function pressContinue(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("[data-handoff-action]").click();
}

test("hands a PMID to the exact PaperLume route, in one real new tab", async ({ extension }) => {
  const page = await extension.openPopup({ activeTabUrl: PUBMED_TAB });
  await expect(page.locator("[data-handoff]")).toBeVisible();

  const pagesBefore = extension.context.pages().length;
  const opened = extension.context.waitForEvent("page");
  await pressContinue(page);
  await opened;

  // The exact handoff shape: origin, path, and the two contract parameters.
  expect(await extension.createdTabUrls(page)).toEqual([
    `${PAPERLUME_ORIGIN}/extension-import?kind=pmid&value=33301246`,
  ]);
  // …and a real tab, opened by Chrome, not merely a recorded intention.
  expect(extension.context.pages().length).toBe(pagesBefore + 1);
});

test("hands a DOI over percent-encoded, and sends nothing else", async ({ extension }) => {
  const page = await extension.openPopup({ activeTabUrl: "https://doi.org/10.1038/s41586-020-2649-2" });
  await expect(page.locator("[data-handoff]")).toBeVisible();

  const opened = extension.context.waitForEvent("page");
  await pressContinue(page);
  await opened;

  const [handoffUrl] = await extension.createdTabUrls(page);
  expect(handoffUrl).toBe(`${PAPERLUME_ORIGIN}/extension-import?kind=doi&value=10.1038%2Fs41586-020-2649-2`);

  // The source page URL, a title, a referrer, an extension id, an analytics
  // parameter: none of them travel. Only `kind` and `value` exist.
  const parsed = new URL(handoffUrl);
  expect([...parsed.searchParams.keys()].sort()).toEqual(["kind", "value"]);
  expect(parsed.origin).toBe(PAPERLUME_ORIGIN);
  expect(parsed.pathname).toBe("/extension-import");
});

test("opens one tab for two activations in the same tick", async ({ extension }) => {
  const page = await extension.openPopup({ activeTabUrl: PUBMED_TAB });
  await expect(page.locator("[data-handoff]")).toBeVisible();

  const pagesBefore = extension.context.pages().length;

  // `dispatchEvent`, not `.click()`. Playwright's click respects the `disabled`
  // attribute, so a click-based double activation is suppressed by the browser
  // and would pass against code with no latch at all. Two synthetic events in
  // one tick both reach the listener, which is what the in-flight latch in
  // `popupView.ts` actually exists to stop.
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("[data-handoff-action]");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  await expect.poll(() => extension.createdTabUrls(page)).toHaveLength(1);
  await page.waitForTimeout(500);

  expect(await extension.createdTabUrls(page)).toHaveLength(1);
  expect(extension.context.pages().length).toBe(pagesBefore + 1);
});

test("reports a refused open without reaching the network by another route", async ({ extension }) => {
  const page = await extension.openPopup({ activeTabUrl: PUBMED_TAB, failTabCreate: true });
  await expect(page.locator("[data-handoff]")).toBeVisible();

  const offOrigin: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("chrome-extension://")) offOrigin.push(request.url());
  });

  const pagesBefore = extension.context.pages().length;
  await pressContinue(page);

  await expect(page.locator("[data-handoff-error]")).toBeVisible();
  await expect(page.locator("[data-handoff-error]")).toContainText("couldn’t be opened");

  // A failed open must look like a failure: the button is released so the user
  // can retry, and the progress line is gone.
  await expect(page.locator("[data-handoff-action]")).toBeEnabled();
  await expect(page.locator("[data-handoff-status]")).toBeHidden();

  // And there is no fallback. No tab, no `fetch`, no beacon, no navigation of
  // the page the user was reading — the extension has one way to reach
  // PaperLume and it just failed.
  await page.waitForTimeout(500);
  expect(extension.context.pages().length).toBe(pagesBefore);
  expect(offOrigin).toEqual([]);
  expect(page.url()).toBe(`chrome-extension://${extension.extensionId}/popup.html`);
});

test("has no control to press when nothing was identified", async ({ extension }) => {
  const page = await extension.openPopup({ activeTabUrl: "https://www.nature.com/articles/s41586-020-2649-2" });

  await expect(page.locator("[data-handoff]")).toBeHidden();

  // Not merely hidden — Playwright would refuse to click it, which proves
  // nothing about the code. Reaching past the UI and firing the event directly
  // shows the handler itself has nothing to open.
  const pagesBefore = extension.context.pages().length;
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("[data-handoff-action]");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(500);

  expect(await extension.createdTabUrls(page)).toEqual([]);
  expect(extension.context.pages().length).toBe(pagesBefore);
});
