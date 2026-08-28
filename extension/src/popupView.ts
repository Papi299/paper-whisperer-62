/**
 * The popup's behaviour: show one state, and run the continuation action.
 *
 * Separate from `popup.ts` for the same reason `detectPaperFromUrl` is: that
 * file is the entry point and runs on import, so everything it does would be
 * unreachable to a test that has not already started the extension. Here the
 * behaviour is a function over a DOM node, which the popup suite drives against
 * the real `extension/popup.html` markup.
 *
 * `chrome.tabs.create` is called from here rather than injected, because "which
 * Chrome API does pressing this button call?" is the security-relevant question
 * and an injected opener would answer it somewhere else. The popup suite stubs
 * `chrome` itself, so what the test observes is the real call.
 *
 * ## Why the continuation control exists now
 *
 * Until CHROME-EXTENSION-IMPORT-001C1 there was nowhere for it to lead, and a
 * button that led nowhere could only lie about what it would do. PaperLume now
 * owns `/extension-import`, so the control leads to a real route — and it still
 * does not import. It opens a page; that page authenticates the user, offers
 * their own Projects and Tags, and takes its own explicit confirmation before
 * writing anything. The label says *Continue* rather than *Import* for that
 * reason.
 *
 * ## What pressing it can and cannot do
 *
 * One press creates at most one tab. There is an in-flight latch as well as the
 * disabled attribute, because this is plain DOM code with no rerender to wait
 * for: two `click` events dispatched in the same tick both reach the listener,
 * and `disabled` alone only stops the ones the *browser* would have suppressed.
 * The latch is set before the first `await`, so the second activation returns
 * having done nothing.
 *
 * There is no other privileged call, no request, and no fallback. If Chrome
 * refuses to open the tab, the popup says so and offers a retry — it does not
 * navigate the tab the user is reading, and it does not reach the network by
 * some other route. `window.open`, `<a>` and `location` are all absent for the
 * same reason: one supported press, one `chrome.tabs.create`, or nothing.
 */

import type { PaperDetection } from "./detectPaperFromUrl";
import { buildPaperLumeHandoffUrl } from "./paperLumeHandoff";

/** Every section the popup can show, including the initial one. */
export type PopupState = PaperDetection["state"] | "checking";

/** The popup, wired to a document. `show` may be called more than once. */
export interface Popup {
  /** Apply a classification: reveal its section, and offer continuation if it has one. */
  show(detection: PaperDetection): void;
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

/**
 * Wire the popup's markup.
 *
 * The handoff URL is held in this closure rather than written into the DOM as a
 * `data-` attribute: nothing else needs to read it, and a URL that never
 * reaches the document cannot be re-read from it after the state has moved on.
 */
export function createPopup(root: ParentNode): Popup {
  const handoff = root.querySelector<HTMLElement>("[data-handoff]");
  const action = root.querySelector<HTMLButtonElement>("[data-handoff-action]");
  const status = root.querySelector<HTMLElement>("[data-handoff-status]");
  const error = root.querySelector<HTMLElement>("[data-handoff-error]");

  /** The URL for the current detection, or `null` when there is nothing to open. */
  let handoffUrl: string | null = null;
  /** Set before the first `await` of an activation; see the module comment. */
  let opening = false;

  function setOpening(inFlight: boolean): void {
    if (action) action.disabled = inFlight;
    if (status) status.hidden = !inFlight;
  }

  async function activate(): Promise<void> {
    // Synchronous, and first: everything below this line may be interleaved.
    if (opening) return;

    const url = handoffUrl;
    if (url === null) return;

    opening = true;
    if (error) error.hidden = true;
    setOpening(true);

    try {
      await chrome.tabs.create({ url });
      // Deliberately still latched. Chrome focuses the new tab, which closes
      // the popup, so there is nothing left to press — and if the popup does
      // survive, a second press would open a second tab for one user decision.
    } catch {
      // The rejection reason is Chrome's text about the user's browsing, so it
      // is not read, not shown and not logged. The fixed copy already in the
      // markup is shown instead, and the button is released so the user can
      // try again — a failed call must never look like a success.
      opening = false;
      setOpening(false);
      if (error) error.hidden = false;
    }
  }

  action?.addEventListener("click", () => {
    void activate();
  });

  return {
    show(detection: PaperDetection): void {
      if (detection.state === "pubmed") setField(root, "pmid", detection.pmid);
      if (detection.state === "doi") setField(root, "doi", detection.doi);
      showState(root, detection.state);

      handoffUrl = buildPaperLumeHandoffUrl(detection);

      // `unsupported` and `restricted` produce no URL, so the control stays
      // hidden and `activate` has nothing to open even if one is reached.
      if (handoff) handoff.hidden = handoffUrl === null;
      if (error) error.hidden = true;
      opening = false;
      setOpening(false);
    },
  };
}
