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

import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect, BUILD_DIR } from "./support/extensionHarness";

/** The production icon set, as Chrome must read it back out of the manifest. */
const EXPECTED_ICONS = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
};

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
  expect(parsed.action).toEqual({
    default_title: "PaperLume",
    default_popup: "popup.html",
    default_icon: EXPECTED_ICONS,
  });
  expect(parsed.icons).toEqual(EXPECTED_ICONS);

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
  //
  // The comparison has to reach outside the browser to mean anything. Reading
  // the manifest from the extension's own origin would read the STAGED copy,
  // and comparing the staged copy against itself proves nothing about how far
  // it has drifted from the artefact that ships. So the reference side is read
  // from `dist-extension/` on disk — the directory `npm run package:extension`
  // archives.
  const shipped = JSON.parse(
    readFileSync(path.join(BUILD_DIR, "manifest.json"), "utf-8"),
  ) as Record<string, unknown>;

  const page = await extension.openPopup();
  const loaded = await page.evaluate(() => chrome.runtime.getManifest());

  expect(shipped, "the shipped manifest must never carry a key").not.toHaveProperty("key");
  expect(loaded, "the staged copy must carry the harness key").toHaveProperty("key");

  const loadedWithoutKey = { ...loaded };
  delete loadedWithoutKey.key;

  expect(loadedWithoutKey).toEqual(shipped);
});

test("runs no background context in the real browser", async ({ extension }) => {
  await extension.openPopup();

  // The popup does the whole job, only while it is open. Anything here would be
  // extension code running when the user asked for nothing.
  expect(extension.context.serviceWorkers()).toHaveLength(0);
  expect(extension.context.backgroundPages()).toHaveLength(0);
});

test("serves every declared icon from its own origin, at the declared size", async ({ extension }) => {
  // The manifest naming a file and the package containing one are both already
  // asserted elsewhere. Neither answers the question this does: does the browser
  // decode the bytes at that path into an image of the size the manifest
  // promised? A 16px file copied into the 128px slot passes every check that
  // does not decode it, and produces a blurred install dialogue.
  const page = await extension.openPopup();

  for (const [size, path] of Object.entries(EXPECTED_ICONS)) {
    const decoded = await page.evaluate(
      ([iconPath]) =>
        new Promise<{ width: number; height: number } | null>((resolve) => {
          const image = new Image();
          image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
          image.onerror = () => resolve(null);
          image.src = chrome.runtime.getURL(iconPath);
        }),
      [path],
    );

    expect(decoded, `Chrome could not decode ${path}`).not.toBeNull();
    expect(decoded).toEqual({ width: Number(size), height: Number(size) });
  }
});
