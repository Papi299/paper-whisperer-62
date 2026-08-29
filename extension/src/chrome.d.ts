/**
 * The extension's complete Chrome API surface.
 *
 * Hand-written rather than pulled from `@types/chrome`, for two reasons. It adds
 * no dependency to the repository's single root dependency graph — which
 * `docs/dependency-security.md` keeps deliberately small — and, more usefully,
 * it makes the extension's *entire* privileged surface reviewable in one short
 * file. If a later phase needs another Chrome API, the declaration has to be
 * added here first, which turns "what can this extension actually do?" into a
 * question the diff answers.
 *
 * Three members are declared — `chrome.tabs.query`, `chrome.tabs.create` and
 * `chrome.scripting.executeScript` — and only the properties of each that this
 * extension actually uses. Neither `tabs` member needs the `tabs` permission:
 *
 *   • `query` is used to name the tab the user is looking at. Reading `Tab.url`
 *     from the result requires either the `tabs` permission or a host
 *     permission for that tab; the extension declares neither and instead
 *     relies on `activeTab`, which grants temporary host permission for the
 *     current tab in response to the user's click on the toolbar action. The
 *     grant is revoked when the user navigates away or closes the tab.
 *
 *   • `create` opens a new tab, which the Chrome documentation lists among the
 *     features that "don't require any permissions to use". The `tabs`
 *     permission is not a gate on the namespace at all — it grants reading the
 *     four sensitive `Tab` properties (`url`, `pendingUrl`, `title`,
 *     `favIconUrl`) — so adding it merely to open a tab would widen what the
 *     extension may *read* in exchange for nothing.
 *
 * The `Tab` returned by `create` is deliberately not read anywhere: the
 * extension opens the PaperLume handoff and its responsibility ends, so it
 * learns nothing about the tab it created.
 *
 * `chrome.scripting.executeScript` joined this file in
 * CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01, together with the `scripting`
 * permission it requires. It is what lets the extension read a publisher page's
 * DOI metadata after a DOI resolver has redirected — see
 * `detectPaperFromMetadata.ts` for why that read exists and how narrow it is.
 * It is the one member here that needs a permission of its own, and it still
 * needs *host* access on top of that: the extension declares no host permission
 * and relies entirely on the temporary grant the user's toolbar click produces,
 * so the call succeeds for exactly the tab they invoked it on and fails
 * everywhere else. That is a deliberately smaller surface than a
 * `host_permissions` entry, which would grant standing access to every matching
 * page whether the user asked for anything or not.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs
 * @see https://developer.chrome.com/docs/extensions/reference/api/scripting
 * @see https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
 */

declare namespace chrome {
  namespace tabs {
    /**
     * The subset of `tabs.Tab` this extension reads.
     *
     * `url` is optional in the platform type and must stay optional here: it is
     * absent unless the extension holds permission for that tab, and it is also
     * absent for a tab that has not committed a navigation. Both cases are real
     * inputs, and both must be handled rather than assumed away.
     */
    interface Tab {
      readonly url?: string;
      /**
       * The tab's own identifier, named as the injection target.
       *
       * Optional in the platform type and optional here: Chrome omits it for a
       * tab that does not exist in a tab strip (a devtools window, a prerender).
       * Unlike `url` it is not a sensitive property and needs no permission to
       * read — it identifies a tab without describing what is in it.
       */
      readonly id?: number;
    }

    /**
     * Query open tabs. Returns a promise in Manifest V3 (Chrome 88+).
     *
     * Only the two properties used to name "the tab the user is looking at" are
     * declared; widening this signature widens what the extension can ask for.
     */
    function query(queryInfo: {
      readonly active?: boolean;
      readonly currentWindow?: boolean;
    }): Promise<Tab[]>;

    /**
     * Open a new tab. Returns a promise in Manifest V3 (Chrome 88+).
     *
     * `url` only. The platform accepts `active`, `index`, `windowId`,
     * `openerTabId` and `pinned` too, and none is declared: the extension has no
     * business placing a tab in the user's window, and a property that cannot be
     * named cannot be passed by mistake. Chrome's own defaults — a new
     * foreground tab in the current window — are what the accepted product
     * decision asked for.
     */
    function create(createProperties: { readonly url?: string }): Promise<Tab>;
  }

  /**
   * Programmatic injection, reached only through the `activeTab` grant.
   *
   * @see https://developer.chrome.com/docs/extensions/reference/api/scripting
   */
  namespace scripting {
    /**
     * One frame's outcome.
     *
     * `result` is optional in the platform type and must stay optional: a frame
     * whose injected function threw produces an entry with no result, and the
     * value is `undefined` for a function that returned nothing. The extension's
     * injected function returns `string[]`, so that is the only shape declared —
     * narrowing this is what stops a future injection from quietly returning
     * something richer out of a page.
     */
    interface InjectionResult {
      readonly result?: string[];
    }

    /**
     * Inject a function into a tab and return what it evaluated to.
     *
     * Only the three properties this extension passes are declared. In
     * particular there is no `allFrames`, no `files`, no `args`, no `world` and
     * no `injectImmediately`: the default is the main frame, which is what the
     * DOI metadata read wants, and a property that cannot be named cannot be
     * passed by mistake. `func` is serialized by Chrome and loses its execution
     * context, so the function it names must be self-contained.
     */
    function executeScript(injection: {
      readonly target: { readonly tabId: number };
      readonly func: () => string[];
    }): Promise<InjectionResult[]>;
  }
}
