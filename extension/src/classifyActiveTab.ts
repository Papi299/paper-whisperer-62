/**
 * The order the two classifiers run in: URL first, page metadata only after.
 *
 * Separate from `popup.ts` for the reason every other behaviour in this
 * extension is separate from it — that file runs on import, so anything it held
 * would be unreachable to a test that has not already started the extension.
 * The order below is the security-relevant part of
 * CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01, so it is a function that can be
 * asserted rather than a sequence inside a bootstrap.
 *
 * ```text
 *   chrome.tabs.query  (the tab the user invoked PaperLume on)
 *        ↓
 *   detectPaperFromUrl
 *        ├── pubmed      → done. The page is never touched.
 *        ├── doi         → done. The page is never touched.
 *        ├── restricted  → done. There is no web page to touch.
 *        └── unsupported → and only here:
 *                            chrome.scripting.executeScript
 *                              → standard DOI metadata, or unsupported
 * ```
 *
 * Three of the four URL answers are final, and that is the whole privacy
 * argument: a PubMed record and a `doi.org` link are answered from the address
 * alone, so the ordinary supported cases involve no page access at all, and a
 * `chrome://` page or a `file://` URL is never made the subject of an injection
 * attempt. The page is inspected in exactly one situation — the user explicitly
 * opened PaperLume on an ordinary http(s) page whose address named no paper —
 * which is precisely the situation a DOI resolver redirect leaves them in.
 */

import { detectPaperFromPageMetadata } from "./detectPaperFromMetadata";
import { detectPaperFromUrl, type PaperDetection } from "./detectPaperFromUrl";

/**
 * The tab the user is looking at, or nothing.
 *
 * `activeTab` grants temporary host permission for exactly this tab in response
 * to the toolbar click, which is what makes `Tab.url` readable without the
 * `tabs` permission or any host permission. `url` stays optional: Chrome omits
 * it for a tab the extension holds no permission for, and for a tab that has not
 * committed a navigation. `id` stays optional for the same reason of honesty —
 * it is absent for a tab that lives in no tab strip.
 *
 * A rejection becomes "no tab" rather than an error of its own. Chrome refuses
 * the query for a tab the extension has no access to, which is the same
 * situation as a tab with no readable address and produces the same `restricted`
 * answer below — so there is one path, not two that must be kept in agreement.
 * The rejection reason is deliberately not read: it is Chrome's text about a
 * page the user is on, and this extension writes nothing about browsing
 * anywhere.
 */
async function readActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  } catch {
    return undefined;
  }
}

/** Classify the active tab. See the module comment for the order and why. */
export async function classifyActiveTab(): Promise<PaperDetection> {
  const tab = await readActiveTab();

  // No tab, or no URL, means `restricted` — there is no web page to reason
  // about, so nothing below it runs.
  const fromUrl = detectPaperFromUrl(tab?.url);
  if (fromUrl.state !== "unsupported") return fromUrl;

  // An ordinary web page whose address named no paper — the one case the
  // fallback exists for. Without a tab id there is nothing to target, and a
  // missing id is not an error worth reporting: the answer is the same
  // `unsupported` the URL already produced.
  const tabId = tab?.id;
  if (typeof tabId !== "number") return fromUrl;

  return await detectPaperFromPageMetadata(tabId);
}
