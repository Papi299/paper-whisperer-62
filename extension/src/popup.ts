/**
 * The popup entry point.
 *
 * The complete behaviour of CHROME-EXTENSION-IMPORT-001B: read the active tab's
 * URL, classify it, show the result. It runs only because the user clicked the
 * toolbar action — which is also what grants `activeTab` — so there is no
 * background page and no service worker. Nothing observes browsing, nothing runs
 * on navigation, and nothing persists between openings.
 *
 * There is deliberately no import control. The PaperLume web handoff route does
 * not exist yet, so a button here could only lie about what it would do.
 */

import "./popup.css";

import { detectPaperFromUrl, type PaperDetection } from "./detectPaperFromUrl";

/** Every section the popup can show, including the initial one. */
type PopupState = PaperDetection["state"] | "checking";

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

/** Reveal exactly one state section and hide the rest. */
function showState(root: ParentNode, state: PopupState): void {
  for (const section of root.querySelectorAll<HTMLElement>("[data-state]")) {
    section.hidden = section.dataset.state !== state;
  }
}

/**
 * Write an identifier into its field.
 *
 * `textContent` rather than `innerHTML`, always. The value is structurally
 * authenticated — a PMID is bare digits, a DOI came from a proven resolver path
 * — but it still originated in a URL the user navigated to, and a rule that
 * holds only while the value happens to be safe is not a rule.
 */
function setField(root: ParentNode, field: string, value: string): void {
  const target = root.querySelector<HTMLElement>(`[data-field="${field}"]`);
  if (target) target.textContent = value;
}

/** Apply a classification to the document. Pure DOM work; no I/O. */
export function render(root: ParentNode, detection: PaperDetection): void {
  if (detection.state === "pubmed") setField(root, "pmid", detection.pmid);
  if (detection.state === "doi") setField(root, "doi", detection.doi);
  showState(root, detection.state);
}

async function main(): Promise<void> {
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

  render(document, detection);
}

void main();
