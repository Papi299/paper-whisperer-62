/**
 * The extension as Chrome actually loads it.
 *
 * Every assertion here reads the *browser's* view rather than the manifest file.
 * `extension/src/__tests__/manifest.test.ts` already pins the committed JSON,
 * and `scripts/lib/extension-package.mjs` pins the packaged JSON; neither can
 * tell you what Chrome did with it. A key Chrome silently ignored, a permission
 * it declined to grant, or a background context it started anyway are all
 * invisible to a file read and visible here.
 */

import { test, expect } from "./support/extensionHarness";

test("loads as an unpacked MV3 extension and serves its popup document", async ({ extension }) => {
  const page = await extension.openPopup();

  expect(page.url()).toBe(`chrome-extension://${extension.extensionId}/popup.html`);
  await expect(page.locator(".popup__brand")).toHaveText("PaperLume");
});

test("is assigned the extension ID the harness derived", async ({ extension }) => {
  // If this fails, every other chrome-extension:// URL in this lane is
  // addressing an extension that does not exist, and the suite is vacuous.
  await extension.assertDerivedIdMatchesBrowser(await extension.openPopup());
});

test("is granted exactly activeTab, and no host origin", async ({ extension }) => {
  const page = await extension.openPopup();

  const granted = await page.evaluate(
    () => new Promise<chrome.permissions.Permissions>((resolve) => chrome.permissions.getAll(resolve)),
  );

  // Chrome's own answer to "what does this extension hold?" — not a re-read of
  // the file that asked for it.
  expect(granted.permissions).toEqual(["activeTab"]);
  expect(granted.origins).toEqual([]);
});

test("is parsed by Chrome with the permission contract intact", async ({ extension }) => {
  const page = await extension.openPopup();
  const parsed = await page.evaluate(() => chrome.runtime.getManifest());

  expect(parsed.manifest_version).toBe(3);
  expect(parsed.name).toBe("PaperLume");
  expect(parsed.permissions).toEqual(["activeTab"]);
  expect(parsed.action).toEqual({ default_title: "PaperLume", default_popup: "popup.html" });

  for (const forbidden of [
    "host_permissions",
    "optional_permissions",
    "optional_host_permissions",
    "background",
    "content_scripts",
    "web_accessible_resources",
    "externally_connectable",
  ]) {
    expect(parsed, `Chrome parsed a forbidden manifest key: ${forbidden}`).not.toHaveProperty(forbidden);
  }
});

test("differs from the shipped package by the harness key and nothing else", async ({ extension }) => {
  // The staged copy exists only to give the ID derivation something to work
  // from. If it ever diverged further, this lane would be testing a browser
  // nobody runs — so the divergence is asserted, not assumed.
  const page = await extension.openPopup();
  const parsed = await page.evaluate(() => chrome.runtime.getManifest());

  // Same-origin read of the package's own manifest — this is the file Chrome
  // loaded, fetched from the extension origin rather than from disk.
  const shipped = JSON.parse(
    await page.evaluate(async () => (await fetch("./manifest.json")).text()),
  ) as Record<string, unknown>;

  // `key` is the one addition. Chrome also does not echo it back in
  // getManifest() on every version, so compare the file the package contains.
  expect(shipped).toHaveProperty("key");
  delete shipped.key;
  const parsedWithoutKey = { ...parsed };
  delete parsedWithoutKey.key;

  expect(parsedWithoutKey).toEqual(shipped);
});

test("runs no background context in the real browser", async ({ extension }) => {
  await extension.openPopup();

  // The popup does the whole job, only while it is open. Anything here would be
  // extension code running when the user asked for nothing.
  expect(extension.context.serviceWorkers()).toHaveLength(0);
  expect(extension.context.backgroundPages()).toHaveLength(0);
});
