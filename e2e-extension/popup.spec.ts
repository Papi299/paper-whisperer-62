/**
 * The built popup, rendered and classified by a real browser.
 *
 * The jsdom suite (`extension/src/__tests__/popup.test.ts`) drives the same
 * markup against the TypeScript source. This one drives the *built* bundle
 * inside Chrome, which is what a user gets — so a build that mangled the
 * classifier, dropped the stylesheet, or emitted syntax Chrome refuses would
 * fail here and nowhere else.
 */

import { test, expect } from "./support/extensionHarness";

/** Which state section the popup is currently showing. */
async function visibleStates(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-state]")]
      .filter((section) => !section.hidden)
      .map((section) => section.dataset.state ?? ""),
  );
}

test("holds no grant, so Chrome reports no tab URL at all and the popup says so", async ({ extension }) => {
  // Nothing is stubbed here. This is Chrome's genuine answer for an extension
  // that has not been invoked from the toolbar: `activeTab` was never granted,
  // so `Tab.url` is absent — not empty, absent. It is the strongest privacy
  // assertion in this lane, and it is real rather than simulated.
  const page = await extension.openPopup();

  const tabs = await page.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }));
  expect(tabs.every((tab) => tab.url === undefined)).toBe(true);

  await expect.poll(() => visibleStates(page)).toEqual(["restricted"]);
  await expect(page.locator("[data-handoff]")).toBeHidden();
});

test("classifies a PubMed record URL and shows its PMID", async ({ extension }) => {
  const page = await extension.openPopup({ activeTabUrl: "https://pubmed.ncbi.nlm.nih.gov/33301246/" });

  await expect.poll(() => visibleStates(page)).toEqual(["pubmed"]);
  await expect(page.locator('[data-field="pmid"]')).toHaveText("33301246");
  await expect(page.locator("[data-handoff]")).toBeVisible();
});

test("classifies a doi.org URL and shows its DOI", async ({ extension }) => {
  const page = await extension.openPopup({ activeTabUrl: "https://doi.org/10.1038/s41586-020-2649-2" });

  await expect.poll(() => visibleStates(page)).toEqual(["doi"]);
  await expect(page.locator('[data-field="doi"]')).toHaveText("10.1038/s41586-020-2649-2");
  await expect(page.locator("[data-handoff]")).toBeVisible();
});

test("offers nothing when the address names no paper and the injection is refused", async ({
  extension,
}) => {
  // A real publisher article URL, and — because `pageHtml` is not passed — the
  // **real** `chrome.scripting.executeScript`, which Chrome refuses for want of
  // a toolbar grant (`load.spec.ts` measures that refusal directly). So this is
  // the genuine fail-closed path: the address identified nothing, the page read
  // was refused, and the user is told plainly that nothing was found.
  const page = await extension.openPopup({ activeTabUrl: "https://www.nature.com/articles/s41586-020-2649-2" });

  await expect.poll(() => visibleStates(page)).toEqual(["unsupported"]);
  await expect(page.locator("[data-handoff]")).toBeHidden();

  // Chrome's refusal is about a page the user is on. It is never read, so it can
  // never be shown — the popup must not turn a permission failure into a browser
  // error the user cannot act on.
  const shown = (await page.evaluate(() => document.body.textContent)) ?? "";
  expect(shown).not.toContain("Cannot access contents");
  expect(shown).not.toContain("manifest must request permission");
  expect(shown).not.toContain("nature.com");

  // And no title fallback, no scraping, no "let PaperLume have a look".
  expect(await extension.createdTabUrls(page)).toEqual([]);
});

test("offers nothing on a restricted browser page", async ({ extension }) => {
  const page = await extension.openPopup({ activeTabUrl: "chrome://settings/" });

  await expect.poll(() => visibleStates(page)).toEqual(["restricted"]);
  await expect(page.locator("[data-handoff]")).toBeHidden();
});

test("applies its packaged stylesheet", async ({ extension }) => {
  // `toBeVisible()` would pass for an unstyled document too. The built CSS is a
  // separate packaged file, and a manifest or build change that stopped it
  // loading would leave a readable but unstyled popup — so assert a property
  // only the stylesheet sets.
  const page = await extension.openPopup({ activeTabUrl: "https://pubmed.ncbi.nlm.nih.gov/33301246/" });

  const identifier = page.locator('[data-field="pmid"]');
  await expect(identifier).toHaveText("33301246");

  const fontFamily = await identifier.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(fontFamily.toLowerCase()).toContain("mono");
});

test("makes no network request of its own", async ({ extension }) => {
  const page = await extension.openPopup({ activeTabUrl: "https://pubmed.ncbi.nlm.nih.gov/33301246/" });

  const offOrigin: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("chrome-extension://")) offOrigin.push(request.url());
  });

  await expect.poll(() => visibleStates(page)).toEqual(["pubmed"]);
  await page.waitForTimeout(500);

  // Detection is a string function. It contacts PubMed, Crossref, PaperLume and
  // everything else exactly never.
  expect(offOrigin).toEqual([]);
});
