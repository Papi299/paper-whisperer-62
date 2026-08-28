/**
 * What the popup does when the user presses the continuation control.
 *
 * The markup under test is the *committed* `extension/popup.html`, read from
 * disk and parsed, not a fixture written here. A hand-written fixture would let
 * this suite stay green while the shipped popup lost the button, renamed a hook
 * or dropped a state section — the failure mode these assertions exist to catch.
 *
 * The only thing stubbed is `chrome`, and only the two members the extension is
 * allowed to call. Nothing else is faked: no authentication, no importer, no
 * Supabase, no PaperLume page. This phase's responsibility ends at constructing
 * the right URL and asking Chrome to open it, and the route on the other end has
 * its own unit and E2E coverage from CHROME-EXTENSION-IMPORT-001C1 — duplicating
 * it here would be testing a mock.
 *
 * ## Two things worth knowing about the DOM used here
 *
 * `import.meta.url` is a `file://` URL under Vitest, but jsdom replaces the
 * global `URL`, and jsdom resolves a relative reference against the *document's*
 * base — so the `new URL("…", import.meta.url)` form the sibling node-environment
 * suites use resolves to `http://localhost:3000/…` here and `fileURLToPath`
 * rejects it. Resolving from the path string instead avoids the global entirely.
 *
 * And `HTMLElement.click()` on a disabled button is a no-op in jsdom, exactly as
 * in a browser. That makes it the wrong tool for testing the in-flight latch:
 * a latch test written with it would pass against code that had no latch at all,
 * because `disabled` alone would have swallowed the second press. The
 * double-activation test therefore dispatches the event directly, which reaches
 * the listener regardless — see that test for the full reasoning.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaperDetection } from "../detectPaperFromUrl";
import { createPopup } from "../popupView";

const POPUP_HTML = readFileSync(
  path.resolve(fileURLToPath(import.meta.url), "../../../popup.html"),
  "utf-8",
);

const HANDOFF_ORIGIN = "https://app.paperlume.app";

/** A deferred promise, so a test can hold `chrome.tabs.create` unresolved. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The narrow Chrome stub: the two members the extension may call, and nothing else. */
function stubChrome(create: (properties: { url?: string }) => Promise<unknown>) {
  const createSpy = vi.fn(create);
  const querySpy = vi.fn(async () => []);
  vi.stubGlobal("chrome", { tabs: { create: createSpy, query: querySpy } });
  return { createSpy, querySpy };
}

/** Mount the committed popup markup and wire it. */
function mountPopup() {
  document.body.innerHTML = "";
  const parsed = new DOMParser().parseFromString(POPUP_HTML, "text/html");
  const markup = parsed.querySelector(".popup");
  // Without this, a renamed root would silently give every query below `null`
  // and every "is not present" assertion would pass by inspecting nothing.
  expect(markup, "extension/popup.html has no .popup root").not.toBeNull();
  document.body.append(document.importNode(markup as Element, true));

  return { root: document.body, popup: createPopup(document.body) };
}

const action = () => document.body.querySelector<HTMLButtonElement>("[data-handoff-action]");
const handoff = () => document.body.querySelector<HTMLElement>("[data-handoff]");
const status = () => document.body.querySelector<HTMLElement>("[data-handoff-status]");
const errorLine = () => document.body.querySelector<HTMLElement>("[data-handoff-error]");
const section = (state: string) =>
  document.body.querySelector<HTMLElement>(`[data-state="${state}"]`);

/** The identifier shown for a state, ignoring markup that is currently hidden. */
const shownIdentifier = (field: string) =>
  document.body.querySelector<HTMLElement>(`[data-field="${field}"]`)?.textContent;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("popup — the committed markup", () => {
  beforeEach(() => stubChrome(async () => ({})));

  it("carries every state section and the continuation control", () => {
    mountPopup();

    for (const state of ["checking", "pubmed", "doi", "unsupported", "restricted"]) {
      expect(section(state), `popup.html has no "${state}" section`).not.toBeNull();
    }
    expect(action()).not.toBeNull();
    expect(handoff()).not.toBeNull();
  });

  it("labels the control Continue in PaperLume, and never Import", () => {
    mountPopup();

    expect(action()?.textContent?.trim()).toBe("Continue in PaperLume");
    // The extension does not import; PaperLume takes its own confirmation.
    // A label claiming otherwise would be the one lie this phase must not tell.
    expect(action()?.textContent).not.toMatch(/import|add paper|save to/i);
  });

  it("hides the control until a detection reveals it", () => {
    // The popup opens in the "checking" state, before any classification.
    mountPopup();
    expect(handoff()?.hidden).toBe(true);
  });

  it("tells the truth about what leaves the extension", () => {
    mountPopup();
    // Collapsed, because the assertions below are about the sentence and the
    // markup wraps it — a line break must not be able to fail a copy check.
    const footnote = (document.body.querySelector(".popup__footnote")?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();

    // The old copy said "Nothing is sent anywhere", which stopped being true the
    // moment the user could hand an identifier over.
    expect(footnote).not.toMatch(/nothing is sent anywhere/i);
    expect(footnote).toMatch(/only when you open PaperLume/i);
    expect(footnote).toMatch(/never the page itself/i);
    expect(footnote).toMatch(/unless you choose Continue in PaperLume/i);
  });
});

describe("popup — PubMed", () => {
  const detection: PaperDetection = { state: "pubmed", pmid: "12345678" };

  it("shows the PMID and offers the continuation", () => {
    stubChrome(async () => ({}));
    const { popup } = mountPopup();

    popup.show(detection);

    expect(section("pubmed")?.hidden).toBe(false);
    expect(shownIdentifier("pmid")).toBe("12345678");
    expect(handoff()?.hidden).toBe(false);
    expect(action()?.disabled).toBe(false);
  });

  it("opens exactly one tab at the canonical handoff URL", async () => {
    const { createSpy, querySpy } = stubChrome(async () => ({}));
    const { popup } = mountPopup();
    popup.show(detection);

    action()?.click();
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    expect(createSpy).toHaveBeenCalledWith({
      url: `${HANDOFF_ORIGIN}/extension-import?kind=pmid&value=12345678`,
    });
    // `chrome.tabs.query` belongs to the entry point's tab read, which this
    // suite does not run: pressing the button must not query anything.
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("reaches the network through nothing but that tab", async () => {
    // A behavioural companion to the static source-boundary suite: even on the
    // one path that legitimately produces a URL, no request primitive is used.
    // Only globals jsdom actually provides are stubbed, so every spy here is one
    // the code could really have reached; `sendBeacon` and `importScripts` exist
    // in neither jsdom nor the extension, and stay the static suite's to prove.
    const requestPrimitives = {
      fetch: vi.fn(),
      XMLHttpRequest: vi.fn(),
      WebSocket: vi.fn(),
      EventSource: vi.fn(),
    };
    for (const [name, spy] of Object.entries(requestPrimitives)) vi.stubGlobal(name, spy);
    const { createSpy } = stubChrome(async () => ({}));

    const { popup } = mountPopup();
    popup.show(detection);
    action()?.click();
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    for (const [name, spy] of Object.entries(requestPrimitives)) {
      expect(spy, `the popup used ${name}`).not.toHaveBeenCalled();
    }
  });
});

describe("popup — DOI", () => {
  // A DOI whose suffix carries the reserved characters that would split the
  // query string if the value were interpolated rather than encoded.
  const detection: PaperDetection = { state: "doi", doi: "10.1000/a&b#c" };

  it("shows the DOI and offers the continuation", () => {
    stubChrome(async () => ({}));
    const { popup } = mountPopup();

    popup.show(detection);

    expect(section("doi")?.hidden).toBe(false);
    expect(shownIdentifier("doi")).toBe("10.1000/a&b#c");
    expect(handoff()?.hidden).toBe(false);
  });

  it("opens one tab whose query round-trips back to the same DOI", async () => {
    const { createSpy } = stubChrome(async () => ({}));
    const { popup } = mountPopup();
    popup.show(detection);

    action()?.click();
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    const opened = new URL((createSpy.mock.calls[0][0] as { url: string }).url);
    expect(opened.origin).toBe(HANDOFF_ORIGIN);
    expect(opened.pathname).toBe("/extension-import");
    expect([...opened.searchParams.keys()]).toEqual(["kind", "value"]);
    expect(opened.searchParams.get("kind")).toBe("doi");
    expect(opened.searchParams.get("value")).toBe("10.1000/a&b#c");
    expect(opened.hash).toBe("");
  });

  it("shows a plain-text DOI, never markup built from it", () => {
    stubChrome(async () => ({}));
    const { popup } = mountPopup();

    popup.show({ state: "doi", doi: "10.1000/<img src=x>" });

    const field = document.body.querySelector<HTMLElement>('[data-field="doi"]');
    expect(field?.textContent).toBe("10.1000/<img src=x>");
    expect(field?.querySelector("img")).toBeNull();
    expect(field?.children).toHaveLength(0);
  });
});

describe("popup — states that cannot hand anything over", () => {
  it.each(["unsupported", "restricted"] as const)("offers no continuation for %s", async (state) => {
    const { createSpy } = stubChrome(async () => ({}));
    const { popup } = mountPopup();

    popup.show({ state });

    expect(section(state)?.hidden).toBe(false);
    expect(handoff()?.hidden).toBe(true);

    // Belt and braces: even reaching the listener directly — which no user can
    // do through a hidden control — must open nothing, because there is no URL.
    action()?.dispatchEvent(new MouseEvent("click"));
    await Promise.resolve();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("withdraws the continuation when a supported state is replaced", () => {
    stubChrome(async () => ({}));
    const { popup } = mountPopup();

    popup.show({ state: "pubmed", pmid: "12345678" });
    expect(handoff()?.hidden).toBe(false);

    popup.show({ state: "unsupported" });
    expect(handoff()?.hidden).toBe(true);
  });
});

describe("popup — same-tick duplicate activation", () => {
  it("opens one tab while the first attempt is unresolved", async () => {
    const gate = deferred<unknown>();
    const { createSpy } = stubChrome(() => gate.promise);
    const { popup } = mountPopup();
    popup.show({ state: "pubmed", pmid: "12345678" });

    // `dispatchEvent`, not `.click()`. The first activation disables the button
    // synchronously, and jsdom — like a browser — makes `.click()` on a disabled
    // button a no-op, so a test written with it would pass even if the in-flight
    // latch did not exist. Dispatching reaches the listener either way, which is
    // what makes this assertion about the latch rather than about `disabled`.
    action()?.dispatchEvent(new MouseEvent("click"));
    action()?.dispatchEvent(new MouseEvent("click"));
    await Promise.resolve();

    expect(createSpy).toHaveBeenCalledTimes(1);

    // And the disabled state is there too, so the ordinary user path is stopped
    // before the latch is ever consulted.
    expect(action()?.disabled).toBe(true);
    expect(status()?.hidden).toBe(false);

    gate.resolve({});
    await gate.promise;
    // Still one: a resolved attempt has already opened the tab Chrome focuses,
    // and one decision must not become two tabs.
    action()?.dispatchEvent(new MouseEvent("click"));
    await Promise.resolve();
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

describe("popup — Chrome refuses to open the tab", () => {
  const REJECTION = "Tabs cannot be edited right now (user may be dragging a tab).";

  it("says so without leaking Chrome's message, and claims no success", async () => {
    const { createSpy } = stubChrome(() => Promise.reject(new Error(REJECTION)));
    const { popup } = mountPopup();
    popup.show({ state: "pubmed", pmid: "12345678" });

    action()?.click();
    await vi.waitFor(() => expect(errorLine()?.hidden).toBe(false));

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(errorLine()?.textContent?.trim()).toBe("PaperLume couldn’t be opened. Try again.");

    // Chrome's text is about the tab the user is on. It is never read, so it can
    // never be displayed — and neither can the URL or the identifier.
    expect(document.body.textContent).not.toContain(REJECTION);
    expect(document.body.textContent).not.toContain("dragging");
    expect(document.body.textContent).not.toContain(HANDOFF_ORIGIN);

    // Nothing may suggest the tab opened.
    expect(status()?.hidden).toBe(true);
    expect(document.body.textContent).not.toMatch(/opened PaperLume|opened in a new tab/i);
  });

  it("allows a retry, and that retry calls Chrome again", async () => {
    let attempts = 0;
    const { createSpy } = stubChrome(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error(REJECTION);
      return {};
    });
    const { popup } = mountPopup();
    popup.show({ state: "pubmed", pmid: "12345678" });

    action()?.click();
    await vi.waitFor(() => expect(errorLine()?.hidden).toBe(false));
    // The control has to be usable again, or "Try again" is not an instruction.
    expect(action()?.disabled).toBe(false);

    action()?.click();
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));

    // The retry opened the same canonical URL, and the failure copy is gone.
    expect(createSpy).toHaveBeenNthCalledWith(2, {
      url: `${HANDOFF_ORIGIN}/extension-import?kind=pmid&value=12345678`,
    });
    expect(errorLine()?.hidden).toBe(true);
  });

  it("holds the latch across a failure so a retry cannot double up", async () => {
    const gate = deferred<unknown>();
    const { createSpy } = stubChrome(() => gate.promise);
    const { popup } = mountPopup();
    popup.show({ state: "pubmed", pmid: "12345678" });

    action()?.dispatchEvent(new MouseEvent("click"));
    await Promise.resolve();
    expect(createSpy).toHaveBeenCalledTimes(1);

    // A press while the first attempt is still unsettled is refused, even
    // though this one is on its way to failing.
    action()?.dispatchEvent(new MouseEvent("click"));
    await Promise.resolve();
    expect(createSpy).toHaveBeenCalledTimes(1);

    gate.reject(new Error(REJECTION));
    await vi.waitFor(() => expect(errorLine()?.hidden).toBe(false));

    // Only now, with the attempt settled, does a press reach Chrome again.
    action()?.dispatchEvent(new MouseEvent("click"));
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));
  });
});
