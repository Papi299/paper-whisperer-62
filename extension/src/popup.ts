/**
 * The popup entry point.
 *
 * Classify the tab the user invoked PaperLume on, and hand the result to the
 * popup. It runs only because the user clicked the toolbar action — which is
 * also what grants `activeTab` — so there is no background page and no service
 * worker. Nothing observes browsing, nothing runs on navigation, and nothing
 * persists between openings.
 *
 * This file is the bootstrap and nothing else: the behaviour it starts lives in
 * `popupView.ts`, and the classification in `classifyActiveTab.ts` — which owns
 * the URL-first, metadata-second order that
 * CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01 introduced, and explains it. All
 * of them are importable without starting the extension, which is what lets them
 * be tested as functions rather than as a browser.
 *
 * The popup can offer a continuation into PaperLume, which
 * CHROME-EXTENSION-IMPORT-001C1 gave a real route to open. It is still not an
 * import: the extension opens a tab and its responsibility ends there. See the
 * `popupView.ts` module comment for what one press can and cannot do.
 */

import "./popup.css";

import { classifyActiveTab } from "./classifyActiveTab";
import { createPopup } from "./popupView";

async function main(): Promise<void> {
  const popup = createPopup(document);
  popup.show(await classifyActiveTab());
}

void main();
