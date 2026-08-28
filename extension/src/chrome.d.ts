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
 * Two members are declared — `chrome.tabs.query` and `chrome.tabs.create` — and
 * only the properties of each that this extension actually uses. Neither needs
 * the `tabs` permission:
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
 * The returned `Tab` is deliberately not read anywhere: the extension opens the
 * PaperLume handoff and its responsibility ends, so it learns nothing about the
 * tab it created.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs
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
}
