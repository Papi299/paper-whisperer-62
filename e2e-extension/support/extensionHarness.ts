/**
 * A real Chromium running the real built extension.
 *
 * Everything this lane asserts happens inside a browser that loaded
 * `dist-extension/` the way `chrome://extensions` → *Load unpacked* would. No
 * spec imports extension source; the popup under test is the built
 * `popup.js`, parsed and executed by Chrome from a `chrome-extension://`
 * origin, with the real `chrome.tabs` API behind it.
 *
 * ## Playwright's documented extension-ID trick does not apply here
 *
 * Playwright's Chrome-extensions guide obtains the extension ID from the
 * service worker's URL. This extension has no service worker, deliberately —
 * the popup performs the entire behaviour and only when the user opens it, so
 * there is no background code at all — and CHROME-EXTENSION-IMPORT-001E1
 * forbids adding one to make testing convenient. Testing adapts to the
 * product, not the other way round.
 *
 * So the ID is *derived* instead of discovered. Chrome computes an unpacked
 * extension's ID from its `key` manifest field when one is present: it is the
 * first 16 bytes of `SHA-256(DER public key)`, with each hex nibble mapped from
 * `0-f` onto `a-p`. The harness generates a throwaway RSA key per launch,
 * writes it into a *staged copy* of the build, and computes the ID it will get.
 * `assertDerivedIdMatchesBrowser` then compares the derivation against
 * `chrome.runtime.id` from inside the extension, so a wrong derivation fails
 * loudly instead of producing a URL that quietly 404s.
 *
 * ### What the staged copy may and may not differ in
 *
 * The staged copy differs from the shipped package by exactly one manifest key,
 * `key`, and nothing else. In particular the harness adds no permission, no
 * host access, no service worker, no content script and no web-accessible
 * resource — the things that would make the browser under test unrepresentative
 * of the browser a user runs.
 *
 * The staged copy also cannot be mistaken for the release package: it is
 * written to a `mkdtemp` directory outside the repository, deleted when the
 * test ends, and `key` is on the packaging script's forbidden-key list
 * (`scripts/lib/extension-package.mjs`), so a build that somehow acquired one
 * fails to package.
 *
 * ## What is real here, and what is a test double
 *
 * Stated plainly, because a harness that blurs this is worse than no harness:
 *
 *   REAL — the browser, the extension load, the manifest as Chrome parsed and
 *   granted it, the popup document and its script, the classifier, the URL
 *   builder, `chrome.tabs.create`, and the tab it opens.
 *
 *   REAL — `chrome.tabs.query` itself, in `openPopup()` with no options. What
 *   it returns there is Chrome's genuine answer for an extension holding no
 *   grant, which is a `Tab` with no `url` at all.
 *
 *   TEST DOUBLE — the *return value* of `chrome.tabs.query` in
 *   `openPopup({ activeTabUrl })`. Chrome only populates `Tab.url` after the
 *   user clicks the toolbar action, which grants `activeTab`; Playwright drives
 *   page content and cannot click browser chrome, and there is no supported API
 *   to simulate that grant. So the URL is injected, and the toolbar click that
 *   produces it in production is covered by the manual gate in
 *   `docs/chrome-web-store-readiness.md`. Nothing else about the popup is
 *   replaced: the injected string is fed to the real built classifier.
 *
 *   PASS-THROUGH SPY — `chrome.tabs.create` records the URL it was called with
 *   and then calls the real API. It is not replaced, so the assertions still
 *   observe a real tab being created; the recording only makes the exact URL
 *   readable, which the failed navigation would otherwise destroy.
 *
 * ## Isolation
 *
 * Each test gets a fresh `mkdtemp` profile directory and a fresh `mkdtemp`
 * staging directory, both removed afterwards. The developer's own Chrome
 * profile, cookies, history and installed extensions are never involved, and
 * `--disable-extensions-except` means the staged copy is the only extension
 * loaded.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test as base, chromium, expect, type BrowserContext, type Page } from "@playwright/test";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The built, unstaged artefact — what `npm run package:extension` archives. */
export const BUILD_DIR = path.join(REPO_ROOT, "dist-extension");

/** The origin the extension is allowed to hand off to. Pinned, not derived. */
export const PAPERLUME_ORIGIN = "https://app.paperlume.app";

/**
 * Chrome's unpacked-extension ID derivation.
 *
 * `a-p` rather than hex because an extension ID is a valid DNS label and must
 * not start with a digit.
 */
export function deriveExtensionId(publicKeyDer: Buffer): string {
  return [...createHash("sha256").update(publicKeyDer).digest().subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .split("")
    .map((nibble) => String.fromCharCode(parseInt(nibble, 16) + 0x61))
    .join("");
}

/** How a popup page should be opened. */
export interface PopupOptions {
  /**
   * A URL to make `chrome.tabs.query` report as the active tab's.
   *
   * Omit it to leave `chrome.tabs.query` completely alone — which is the only
   * way to observe Chrome's real answer for an extension holding no `activeTab`
   * grant. See the module comment.
   */
  readonly activeTabUrl?: string;
  /** Make `chrome.tabs.create` reject, to exercise the popup's failure path. */
  readonly failTabCreate?: boolean;
}

export interface ExtensionHarness {
  readonly context: BrowserContext;
  readonly extensionId: string;
  /** Open `popup.html` as a page in the extension's own origin. */
  openPopup(options?: PopupOptions): Promise<Page>;
  /** Every URL `chrome.tabs.create` was called with on `page`, in order. */
  createdTabUrls(page: Page): Promise<string[]>;
  /** Fail unless the derived ID is the one Chrome actually assigned. */
  assertDerivedIdMatchesBrowser(page: Page): Promise<void>;
}

/**
 * The page-side instrumentation, injected before any extension script runs.
 *
 * Written as one function so Playwright can serialise it; it receives only
 * plain data. Note that it *wraps* `chrome.tabs.create` rather than replacing
 * it, unless `failTabCreate` asks for the rejection path.
 */
function instrumentation(options: PopupOptions): void {
  const created: string[] = [];
  (window as unknown as { __createdTabUrls: string[] }).__createdTabUrls = created;

  const realCreate = chrome.tabs.create.bind(chrome.tabs);
  chrome.tabs.create = async (createProperties: { readonly url?: string }) => {
    created.push(createProperties.url ?? "");
    if (options.failTabCreate) throw new Error("tabs.create refused (test double)");
    return realCreate(createProperties);
  };

  if (typeof options.activeTabUrl === "string") {
    const url = options.activeTabUrl;
    chrome.tabs.query = async () => [{ url }];
  }
}

export const test = base.extend<{ extension: ExtensionHarness }>({
  // eslint-disable-next-line no-empty-pattern
  extension: async ({}, use, testInfo) => {
    if (!existsSync(path.join(BUILD_DIR, "manifest.json"))) {
      throw new Error(
        "dist-extension/manifest.json is missing. This lane tests the BUILT extension, " +
          "never the TypeScript source. Run `npm run build:extension` (or " +
          "`npm run package:extension`) first.",
      );
    }

    // One throwaway key per launch: the ID is deterministic within a test and
    // never shared between tests.
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const extensionId = deriveExtensionId(publicKeyDer);

    const stagingDir = mkdtempSync(path.join(tmpdir(), "paperlume-ext-"));
    const profileDir = mkdtempSync(path.join(tmpdir(), "paperlume-profile-"));

    cpSync(BUILD_DIR, stagingDir, { recursive: true });
    const stagedManifestPath = path.join(stagingDir, "manifest.json");
    const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, "utf-8")) as Record<string, unknown>;
    // The one and only difference from the shipped package.
    stagedManifest.key = publicKeyDer.toString("base64");
    writeFileSync(stagedManifestPath, JSON.stringify(stagedManifest, null, 2));

    const context = await chromium.launchPersistentContext(profileDir, {
      // Playwright's bundled Chromium: Google Chrome and Microsoft Edge no
      // longer honour the extension side-loading flags, and this channel is the
      // one Playwright documents for extensions — it also runs them headless.
      channel: "chromium",
      args: [
        `--disable-extensions-except=${stagingDir}`,
        `--load-extension=${stagingDir}`,
        // Black-hole every non-loopback name. The handoff button really runs
        // `chrome.tabs.create` and a real tab really opens, but the navigation
        // cannot leave this machine — so no spec here can reach PaperLume
        // Production, sign anyone in, or create a paper. Nothing about the
        // extension's own behaviour depends on the navigation succeeding: it
        // opens a tab and its responsibility ends.
        "--host-resolver-rules=MAP * 127.0.0.1:1, EXCLUDE localhost",
      ],
    });

    const harness: ExtensionHarness = {
      context,
      extensionId,

      async openPopup(options: PopupOptions = {}) {
        const page = await context.newPage();
        await page.addInitScript(instrumentation, options);
        await page.goto(`chrome-extension://${extensionId}/popup.html`);
        return page;
      },

      async createdTabUrls(page: Page) {
        return page.evaluate(() => (window as unknown as { __createdTabUrls: string[] }).__createdTabUrls);
      },

      async assertDerivedIdMatchesBrowser(page: Page) {
        expect(
          await page.evaluate(() => chrome.runtime.id),
          "the harness derived an extension ID Chrome did not assign — every " +
            "chrome-extension:// URL in this lane would be addressing nothing",
        ).toBe(extensionId);
      },
    };

    await use(harness);

    await context.close();
    for (const dir of [stagingDir, profileDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        // Cleanup failure must not mask a test result; surface it as an
        // attachment instead of throwing over the top of the real outcome.
        await testInfo.attach("harness-cleanup-warning", {
          body: `failed to remove ${dir}: ${String(error)}`,
        });
      }
    }
  },
});

export { expect };
