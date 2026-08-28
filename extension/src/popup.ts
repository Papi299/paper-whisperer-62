/**
 * The popup entry point.
 *
 * Read the active tab's URL, classify it, hand the result to the popup. It runs
 * only because the user clicked the toolbar action — which is also what grants
 * `activeTab` — so there is no background page and no service worker. Nothing
 * observes browsing, nothing runs on navigation, and nothing persists between
 * openings.
 *
 * This file is the bootstrap and nothing else: the behaviour it starts lives in
 * `popupView.ts`, and the classification in `detectPaperFromUrl.ts`. Both are
 * importable without starting the extension, which is what lets them be tested
 * as functions rather than as a browser.
 *
 * The popup can now offer a continuation into PaperLume, which
 * CHROME-EXTENSION-IMPORT-001C1 gave a real route to open. It is still not an
 * import: the extension opens a tab and its responsibility ends there. See the
 * `popupView.ts` module comment for what one press can and cannot do.
 */

import "./popup.css";

import { detectPaperFromUrl, type PaperDetection } from "./detectPaperFromUrl";
import { createPopup } from "./popupView";

/**
 * Read the URL of the tab the user is looking at.
 *
 * `activeTab` grants temporary host permission for exactly this tab in response
 * to the toolbar click, which is what makes `Tab.url` readable without the
 * `tabs` permission or any host permission. `url` stays optional: Chrome omits
 * it for a tab the extension holds no permission for, and for a tab that has not
 * committed a navigation.
 */
async function readActiveTabUrl(): Promise<string | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url;
}

async function main(): Promise<void> {
  const popup = createPopup(document);

  let detection: PaperDetection;
  try {
    detection = detectPaperFromUrl(await readActiveTabUrl());
  } catch {
    // Chrome refuses the query for a tab the extension has no access to. That
    // is the same situation as a tab with no readable address, and it is shown
    // as such — never as a failure the user is invited to retry. The rejection
    // reason is deliberately not read: it is Chrome's text about a page the user
    // is on, and this extension writes nothing about browsing anywhere.
    detection = { state: "restricted" };
  }

  popup.show(detection);
}

void main();
