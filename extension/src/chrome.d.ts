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
 * `chrome.tabs.query` is the only member declared, and only the members of
 * `Tab` this phase reads. Reading `Tab.url` requires either the `tabs`
 * permission or a host permission for that tab; the extension declares neither
 * and instead relies on `activeTab`, which grants temporary host permission for
 * the current tab in response to the user's click on the toolbar action. The
 * grant is revoked when the user navigates away or closes the tab.
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
  }
}
