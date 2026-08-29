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
 *   REAL — `chrome.scripting.executeScript` in every `openPopup` call that does
 *   **not** pass `pageHtml`. It is invoked, against a real tab id, and Chrome
 *   really refuses it — *"Cannot access contents of the page. Extension
 *   manifest must request permission to access the respective host."* — because
 *   no toolbar click ever granted `activeTab`. That refusal is the fail-closed
 *   path, exercised for real rather than simulated.
 *
 *   PARTIAL TEST DOUBLE — the `url` of the `Tab` `chrome.tabs.query` returns in
 *   `openPopup({ activeTabUrl })`. Chrome populates `Tab.url` only after the
 *   user clicks the toolbar action, which grants `activeTab`; Playwright drives
 *   page content and cannot click browser chrome, and there is no supported API
 *   to simulate that grant. So that one property is overwritten on the real
 *   `Tab` Chrome returned — the `id` the injection targets is Chrome's own — and
 *   the toolbar click that produces the URL in production is covered by the
 *   manual gate in `docs/chrome-web-store-readiness.md`. Nothing else about the
 *   popup is replaced: the injected string is fed to the real built classifier.
 *
 *   TEST DOUBLE — `chrome.scripting.executeScript` in `openPopup({ pageHtml })`,
 *   and it is a double of the **grant**, not of the read. See
 *   `PopupOptions.pageHtml` below: the extension's own injected function is
 *   taken as it was built, serialized exactly as Chrome serializes it, and
 *   executed in a real page's realm.
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
  /**
   * Markup to serve at `activeTabUrl`, in a real tab, as the page the DOI
   * metadata read runs against.
   *
   * Passing it turns on the one double this harness has for the `activeTab`
   * grant, and it is worth being precise about what that double replaces.
   * Chrome refuses `chrome.scripting.executeScript` outright without a grant —
   * verified, not assumed: the rejection is *"Cannot access contents of the
   * page. Extension manifest must request permission to access the respective
   * host."* — so the grant is the one thing that has to be supplied.
   *
   * What is supplied is **only** the permission to reach the page. The harness
   * takes the `func` the built extension passed, serializes it with
   * `String(func)` exactly as Chrome does before injection, and evaluates it in
   * the realm of a real tab that really navigated to `activeTabUrl` and really
   * parsed this markup. So the function under test is the built one, it runs
   * against a real `document.head` with real `<meta>` elements, and what comes
   * back is what it really returned — which is then handed to the real built
   * normalizer in the real popup.
   *
   * That also makes the harness sensitive to the mistake most worth catching
   * here: an injected function that reads anything from module scope survives
   * bundling, passes every jsdom test, and throws `ReferenceError` in the page.
   * It throws here too, for the same reason.
   *
   * The markup is served by route interception, so nothing is fetched: the
   * browser's DNS is black-holed and `activeTabUrl` never resolves.
   */
  readonly pageHtml?: string;
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
    // `chrome.tabs.query` still runs, and the `Tab` Chrome returned is still the
    // one that comes back — with `url` overwritten, because Chrome leaves it
    // absent without a toolbar grant. Everything else, `id` in particular, is
    // Chrome's own, so the injection below targets a tab that really exists.
    const realQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (queryInfo) => {
      const tabs = await realQuery(queryInfo);
      return tabs.map((tab) => ({ ...tab, url }));
    };
  }

  if (options.pageHtml !== undefined) {
    // The grant double. `executeScript` is replaced; the function it was given
    // is not — it is serialized the way Chrome serializes it and run, by
    // Playwright, in the real target page. See `PopupOptions.pageHtml`.
    chrome.scripting.executeScript = async ({ func }) => {
      const harness = window as unknown as {
        __harnessInjectIntoPage(source: string): Promise<string[]>;
      };
      return [{ result: await harness.__harnessInjectIntoPage(String(func)) }];
    };
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
        // The target page first, so the popup's injection has somewhere real to
        // land by the time the popup script runs.
        let target: Page | null = null;
        if (options.pageHtml !== undefined) {
          const targetUrl = options.activeTabUrl;
          if (targetUrl === undefined) {
            throw new Error("openPopup({ pageHtml }) needs activeTabUrl — the page has to have an address");
          }
          target = await context.newPage();
          const html = options.pageHtml;
          await target.route(targetUrl, (route) =>
            route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
          );
          await target.goto(targetUrl);
        }

        const page = await context.newPage();
        if (target !== null) {
          const targetPage = target;
          await page.exposeFunction("__harnessInjectIntoPage", (source: string) =>
            targetPage.evaluate<string[]>(`(${source})()`),
          );
        }
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
