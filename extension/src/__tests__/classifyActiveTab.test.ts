/**
 * The order: URL first, and the page read only where it is allowed to happen.
 *
 * `detectPaperFromMetadata.test.ts` proves what the fallback reads.
 * This suite proves *when* it runs — which is the privacy-relevant half, and the
 * half a reader of the code has to take on trust unless it is asserted.
 *
 * Every test below stubs `chrome.scripting.executeScript` with a spy that
 * records whether it was called at all. Four of them assert it was **not**:
 * a PubMed URL, a doi.org URL, and any non-http(s) tab must be answered without
 * the extension ever asking Chrome for access to the page. That is not an
 * optimisation — it is the reason the extension can still say that reading a
 * recognised address involves no page access, and it is the reason a
 * `chrome://` page is never the subject of an injection attempt.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyActiveTab } from "../classifyActiveTab";
import { readDoiMetadataFromPage } from "../detectPaperFromMetadata";

const DOI = "10.1038/s41586-020-2649-2";
const PUBLISHER_URL = "https://www.nature.com/articles/s41586-020-2649-2";

/**
 * Stub the two Chrome members the classifier may use.
 *
 * `tab` is what `chrome.tabs.query` reports. `metadata` is what the injected
 * function is pretended to have returned; passing `undefined` makes the
 * injection reject, the way Chrome rejects it without a host grant.
 */
function stubChrome(
  tab: { url?: string; id?: number } | undefined,
  metadata?: string[] | Error,
) {
  const query = vi.fn(async () => (tab === undefined ? [] : [tab]));
  const executeScript = vi.fn(async (_injection: unknown) => {
    if (metadata instanceof Error) throw metadata;
    if (metadata === undefined) throw new Error("Cannot access contents of the page.");
    return [{ result: metadata }];
  });
  vi.stubGlobal("chrome", { tabs: { query }, scripting: { executeScript } });
  return { query, executeScript };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyActiveTab — an address that already names a paper", () => {
  it("answers a PubMed record from the URL and never touches the page", async () => {
    const { executeScript } = stubChrome({
      url: "https://pubmed.ncbi.nlm.nih.gov/33301246/",
      id: 7,
    });

    expect(await classifyActiveTab()).toEqual({ state: "pubmed", pmid: "33301246" });
    expect(executeScript, "a PubMed URL must need no page access").not.toHaveBeenCalled();
  });

  it("answers a doi.org URL from the URL and never touches the page", async () => {
    const { executeScript } = stubChrome({ url: `https://doi.org/${DOI}`, id: 7 });

    expect(await classifyActiveTab()).toEqual({ state: "doi", doi: DOI });
    expect(executeScript, "a doi.org URL must need no page access").not.toHaveBeenCalled();
  });

  it("answers the legacy PubMed and dx.doi.org forms the same way", async () => {
    for (const [url, expected] of [
      ["https://www.ncbi.nlm.nih.gov/pubmed/33301246", { state: "pubmed", pmid: "33301246" }],
      [`http://dx.doi.org/${DOI}`, { state: "doi", doi: DOI }],
    ] as const) {
      const { executeScript } = stubChrome({ url, id: 7 });
      expect(await classifyActiveTab()).toEqual(expected);
      expect(executeScript).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });
});

describe("classifyActiveTab — a page the browser will not let anyone read", () => {
  it.each([
    ["a chrome:// page", "chrome://settings/"],
    ["a local file", "file:///Users/someone/paper.pdf"],
    ["a view-source: view", "view-source:https://www.nature.com/"],
    ["a devtools page", "devtools://devtools/bundled/inspector.html"],
    ["an extension page", "chrome-extension://abcdefghijklmnop/popup.html"],
    ["an about: page", "about:blank"],
  ])("stays restricted for %s and attempts no injection", async (_label, url) => {
    const { executeScript } = stubChrome({ url, id: 7 });

    expect(await classifyActiveTab()).toEqual({ state: "restricted" });
    expect(executeScript, `an injection was attempted on ${url}`).not.toHaveBeenCalled();
  });

  it("stays restricted when Chrome reported no URL at all", async () => {
    // What Chrome genuinely returns for an extension holding no grant.
    const { executeScript } = stubChrome({ id: 7 });

    expect(await classifyActiveTab()).toEqual({ state: "restricted" });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("stays restricted when there is no active tab", async () => {
    const { executeScript } = stubChrome(undefined);

    expect(await classifyActiveTab()).toEqual({ state: "restricted" });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("stays restricted when chrome.tabs.query itself rejects", async () => {
    const executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn(() => Promise.reject(new Error("No tab with id: 7."))) },
      scripting: { executeScript },
    });

    expect(await classifyActiveTab()).toEqual({ state: "restricted" });
    expect(executeScript).not.toHaveBeenCalled();
  });
});

describe("classifyActiveTab — an ordinary page whose address named nothing", () => {
  it("reads the page's DOI metadata, and only then", async () => {
    const { executeScript } = stubChrome({ url: PUBLISHER_URL, id: 7 }, [DOI]);

    expect(await classifyActiveTab()).toEqual({ state: "doi", doi: DOI });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript.mock.calls[0][0]).toEqual({
      target: { tabId: 7 },
      func: readDoiMetadataFromPage,
    });
  });

  it("stays unsupported when the page publishes no DOI metadata", async () => {
    const { executeScript } = stubChrome({ url: PUBLISHER_URL, id: 7 }, []);

    expect(await classifyActiveTab()).toEqual({ state: "unsupported" });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("stays unsupported when the page's DOI metadata conflicts", async () => {
    const { executeScript } = stubChrome({ url: PUBLISHER_URL, id: 7 }, [DOI, "10.1000/other"]);

    expect(await classifyActiveTab()).toEqual({ state: "unsupported" });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("stays unsupported when Chrome refuses the injection", async () => {
    const { executeScript } = stubChrome({ url: PUBLISHER_URL, id: 7 });

    expect(await classifyActiveTab()).toEqual({ state: "unsupported" });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("stays unsupported, without attempting an injection, when the tab has no id", async () => {
    const { executeScript } = stubChrome({ url: PUBLISHER_URL });

    expect(await classifyActiveTab()).toEqual({ state: "unsupported" });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("never turns an unidentifiable page into a title search", async () => {
    // The rule `detectPaperFromUrl` was built around, restated at the level
    // where the page is now readable: a page the extension cannot identify is a
    // page nothing is sent about. There is no fifth state to leak into.
    const { executeScript } = stubChrome(
      { url: PUBLISHER_URL, id: 7 },
      ["Array programming with NumPy", "Nature", "2020"],
    );

    expect(await classifyActiveTab()).toEqual({ state: "unsupported" });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });
});
