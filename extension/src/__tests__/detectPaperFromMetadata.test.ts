/**
 * The DOI metadata fallback: what it reads, what it refuses to read, and what it
 * does when a page contradicts itself.
 *
 * Three layers, tested at the level each one actually has a failure mode:
 *
 *   • `readDoiMetadataFromPage` against a real (jsdom) document, because "does
 *     it read the title?" is a question about DOM traversal and cannot be
 *     answered by inspecting a string;
 *   • `resolveDoiFromMetadata` as a pure function, because duplicate collapsing
 *     and the ambiguity refusal are decisions about a list of strings and
 *     deserve to be asserted without a document at all;
 *   • `detectPaperFromPageMetadata` against a stubbed `chrome`, because the only
 *     thing left is the Chrome call and its fail-closed error handling.
 *
 * The negative cases are the point of this file. A DOI in the document title, in
 * body text, or in a link is a DOI that must **not** be detected: the fallback
 * exists to read *published bibliographic metadata*, and the moment it starts
 * finding identifiers anywhere else it becomes the page-scraper this extension
 * has always refused to be. `pmid` and `doi` are per-user deduplication keys, so
 * a DOI scraped out of a "cited by" list would offer the wrong paper for import.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectPaperFromPageMetadata,
  readDoiMetadataFromPage,
  resolveDoiFromMetadata,
} from "../detectPaperFromMetadata";

/** The DOI the failed manual acceptance case turns on. */
const DOI = "10.1038/s41586-020-2649-2";
const OTHER_DOI = "10.1000/some-other-work";

/**
 * Put markup in the document head and read it back through the real function.
 *
 * `innerHTML` is used deliberately and only here: this is a test file, which
 * `sourceBoundary.test.ts` excludes from the no-markup-sinks rule, and building
 * `<meta>` elements one property at a time would test a DOM the parser never
 * produced. What the function must cope with is markup a browser parsed.
 */
function headMetadata(markup: string): string[] {
  document.head.innerHTML = markup;
  return readDoiMetadataFromPage();
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
  vi.unstubAllGlobals();
});

describe("readDoiMetadataFromPage — the approved keys", () => {
  it.each([
    ["citation_doi", `<meta name="citation_doi" content="${DOI}">`],
    ["dc.identifier", `<meta name="dc.identifier" content="${DOI}">`],
    ["dc.identifier.doi", `<meta name="dc.identifier.doi" content="${DOI}">`],
    ["prism.doi", `<meta name="prism.doi" content="${DOI}">`],
  ])("reads %s", (_key, markup) => {
    expect(headMetadata(markup)).toEqual([DOI]);
  });

  it("matches the key case-insensitively, however the publisher capitalised it", () => {
    // Real pages carry `DC.identifier`, `citation_DOI` and `PRISM.doi`; the
    // conventions are inconsistent and the HTML attribute is not case-sensitive
    // in practice.
    expect(
      headMetadata(`
        <meta name="Citation_DOI" content="${DOI}">
        <meta name="DC.Identifier" content="${DOI}">
        <meta name="PRISM.DOI" content="${DOI}">
      `),
    ).toEqual([DOI, DOI, DOI]);
  });

  it("reads the key from property as well as name", () => {
    // Dublin Core and PRISM both appear as `property` in RDFa-flavoured markup.
    expect(headMetadata(`<meta property="prism.doi" content="${DOI}">`)).toEqual([DOI]);
    expect(headMetadata(`<meta property="dc.identifier" content="${DOI}">`)).toEqual([DOI]);
  });

  it("tolerates whitespace around the key itself", () => {
    expect(headMetadata(`<meta name="  citation_doi " content="${DOI}">`)).toEqual([DOI]);
  });

  it("returns content verbatim, leaving normalization to the extension", () => {
    // The injected function's only job is collection. Trimming, prefix handling
    // and validation happen back in the extension where they are testable as
    // ordinary code rather than as a second parser embedded in someone's page.
    expect(headMetadata(`<meta name="citation_doi" content="  doi: ${DOI}  ">`)).toEqual([
      `  doi: ${DOI}  `,
    ]);
  });
});

describe("readDoiMetadataFromPage — what it will not look at", () => {
  it("ignores meta tags that are not on the approved list", () => {
    expect(
      headMetadata(`
        <meta name="citation_title" content="Array programming with NumPy">
        <meta name="citation_journal_title" content="Nature">
        <meta name="citation_author" content="Harris, Charles R.">
        <meta name="description" content="An article about ${DOI}">
        <meta name="og:url" content="https://doi.org/${DOI}">
        <meta name="twitter:card" content="summary">
        <meta charset="utf-8">
      `),
    ).toEqual([]);
  });

  it("ignores a key that merely contains an approved one", () => {
    expect(
      headMetadata(`
        <meta name="x-citation_doi" content="${DOI}">
        <meta name="citation_doi_url" content="${DOI}">
        <meta name="prism.doi.alternate" content="${DOI}">
      `),
    ).toEqual([]);
  });

  it("does not read the document title", () => {
    document.title = `Array programming, ${DOI}`;
    expect(headMetadata(`<title>${DOI}</title>`)).toEqual([]);
  });

  it("does not read body text", () => {
    document.body.innerHTML = `<p>Cite as ${DOI}</p><h1>${DOI}</h1>`;
    expect(headMetadata("")).toEqual([]);
  });

  it("does not read link hrefs, however DOI-shaped", () => {
    document.body.innerHTML = `<a href="https://doi.org/${DOI}">${DOI}</a>`;
    expect(
      headMetadata(`<link rel="canonical" href="https://doi.org/${DOI}">`),
    ).toEqual([]);
  });

  it("does not read arbitrary attributes on approved elements", () => {
    // The `content` attribute, and nothing else on the same element.
    expect(
      headMetadata(`<meta name="citation_doi" data-doi="${DOI}" value="${DOI}" content="">`),
    ).toEqual([]);
  });

  it("does not read JSON-LD, inline scripts or data attributes", () => {
    document.body.innerHTML = `<div data-doi="${DOI}"></div>`;
    expect(
      headMetadata(`
        <script type="application/ld+json">{"@type":"ScholarlyArticle","doi":"${DOI}"}</script>
        <script>window.articleDoi = "${DOI}";</script>
      `),
    ).toEqual([]);
  });

  it("does not read an approved meta tag placed in the body", () => {
    // Bibliographic metadata belongs in the head. Scoping there means a `<meta>`
    // inside user-generated content is never inspected.
    document.body.innerHTML = `<meta name="citation_doi" content="${DOI}">`;
    expect(headMetadata("")).toEqual([]);
  });

  it("skips an approved key with empty content", () => {
    expect(
      headMetadata(`
        <meta name="citation_doi" content="">
        <meta name="prism.doi">
      `),
    ).toEqual([]);
  });

  it("returns nothing for a page with no head content at all", () => {
    expect(headMetadata("")).toEqual([]);
  });
});

describe("readDoiMetadataFromPage — it must survive being serialized into a page", () => {
  it("references nothing outside its own body", () => {
    // The production failure this guards against is invisible in every other
    // test here. Chrome serializes `func` and deserializes it inside the target
    // document — "any bound parameters and execution context will be lost" — so
    // a reference to a module-level constant works perfectly in this suite and
    // throws `ReferenceError` on a real publisher page.
    //
    // Rebuilding the function from its own source, in a scope where the module's
    // bindings do not exist, is the only way to make that failure visible here.
    // `new Function` in a test file is exactly what the extension itself is
    // forbidden to contain; `sourceBoundary.test.ts` scans the source, and this
    // directory is not part of it.
    document.head.innerHTML = `<meta name="citation_doi" content="${DOI}">`;

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const rebuilt = new Function(`return (${String(readDoiMetadataFromPage)})();`) as () => string[];

    expect(rebuilt()).toEqual([DOI]);
  });
});

describe("resolveDoiFromMetadata — normalization and duplicates", () => {
  it("detects one valid DOI", () => {
    expect(resolveDoiFromMetadata([DOI])).toEqual({ state: "doi", doi: DOI });
  });

  it("accepts the presentation forms a publisher may have written", () => {
    for (const value of [
      `  ${DOI}  `,
      `doi:${DOI}`,
      `DOI: ${DOI}`,
      `https://doi.org/${DOI}`,
      `http://dx.doi.org/${DOI}`,
    ]) {
      expect(resolveDoiFromMetadata([value]), value).toEqual({ state: "doi", doi: DOI });
    }
  });

  it("collapses duplicate fields carrying the same DOI", () => {
    expect(resolveDoiFromMetadata([DOI, DOI, DOI])).toEqual({ state: "doi", doi: DOI });
  });

  it("collapses one DOI written in different accepted forms", () => {
    // The common real case: `citation_doi` as a bare name and `dc.identifier`
    // as a resolver URL. One paper, described twice.
    expect(
      resolveDoiFromMetadata([DOI, `https://doi.org/${DOI}`, `doi:${DOI}`, `  ${DOI}`]),
    ).toEqual({ state: "doi", doi: DOI });
  });

  it("ignores unusable values alongside one good one", () => {
    expect(
      resolveDoiFromMetadata(["", "   ", "not-a-doi", "10.1038", DOI]),
    ).toEqual({ state: "doi", doi: DOI });
  });
});

describe("resolveDoiFromMetadata — failing closed", () => {
  it("is unsupported when there is nothing to read", () => {
    expect(resolveDoiFromMetadata([])).toEqual({ state: "unsupported" });
  });

  it("is unsupported when nothing normalizes", () => {
    expect(
      resolveDoiFromMetadata(["", "  ", "not-a-doi", "10.1038", "https://www.nature.com/articles/x"]),
    ).toEqual({ state: "unsupported" });
  });

  it("refuses a page that publishes two different DOIs", () => {
    // Never a choice between them. A page whose `citation_doi` and
    // `dc.identifier` disagree is describing more than one work, or describing
    // one wrongly, and picking either would offer the user the wrong paper under
    // a confident "Paper detected".
    expect(resolveDoiFromMetadata([DOI, OTHER_DOI])).toEqual({ state: "unsupported" });
    expect(resolveDoiFromMetadata([OTHER_DOI, DOI])).toEqual({ state: "unsupported" });
  });

  it("refuses conflicting DOIs however they were written", () => {
    expect(
      resolveDoiFromMetadata([`https://doi.org/${DOI}`, `doi:${OTHER_DOI}`]),
    ).toEqual({ state: "unsupported" });
  });

  it("refuses three conflicting DOIs, including when one of them repeats", () => {
    expect(
      resolveDoiFromMetadata([DOI, DOI, OTHER_DOI, "10.9999/third"]),
    ).toEqual({ state: "unsupported" });
  });

  it("treats DOIs differing only in case as different, and so refuses them", () => {
    // DOI names are equivalent only when their code points are identical.
    // Folding case here would merge two names the resolver keeps apart.
    expect(resolveDoiFromMetadata(["10.1000/AB", "10.1000/ab"])).toEqual({ state: "unsupported" });
  });

  it("never produces a title, a URL or anything but a DOI", () => {
    const detection = resolveDoiFromMetadata([`https://doi.org/${DOI}`]);
    expect(detection).toEqual({ state: "doi", doi: DOI });
    expect(Object.keys(detection).sort()).toEqual(["doi", "state"]);
  });
});

describe("detectPaperFromPageMetadata — the Chrome call", () => {
  /** Stub `chrome.scripting.executeScript` and nothing else. */
  function stubExecuteScript(implementation: (injection: unknown) => Promise<unknown>) {
    const executeScript = vi.fn(implementation);
    vi.stubGlobal("chrome", { scripting: { executeScript } });
    return executeScript;
  }

  it("targets the given tab's main frame, with the real injected function", async () => {
    const executeScript = stubExecuteScript(async () => [{ result: [DOI] }]);

    expect(await detectPaperFromPageMetadata(42)).toEqual({ state: "doi", doi: DOI });

    expect(executeScript).toHaveBeenCalledTimes(1);
    const injection = executeScript.mock.calls[0][0] as Record<string, unknown>;
    expect(injection.target).toEqual({ tabId: 42 });
    expect(injection.func).toBe(readDoiMetadataFromPage);
    // No `allFrames`, so Chrome's documented default applies: the main frame
    // only, never an advertisement or an embedded widget. And no `args`, no
    // `files`, no `world` — a property that is never passed cannot widen this.
    expect(Object.keys(injection).sort()).toEqual(["func", "target"]);
  });

  it("is unsupported when Chrome refuses the injection", async () => {
    // The real refusal, verbatim, for an extension with no host grant.
    const executeScript = stubExecuteScript(() =>
      Promise.reject(
        new Error(
          "Cannot access contents of the page. Extension manifest must request " +
            "permission to access the respective host.",
        ),
      ),
    );

    expect(await detectPaperFromPageMetadata(42)).toEqual({ state: "unsupported" });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("does not retry a refused injection", async () => {
    const executeScript = stubExecuteScript(() => Promise.reject(new Error("no")));
    await detectPaperFromPageMetadata(42);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("is unsupported when the frame produced no result", async () => {
    stubExecuteScript(async () => [{}]);
    expect(await detectPaperFromPageMetadata(42)).toEqual({ state: "unsupported" });
  });

  it("is unsupported when Chrome returned no frames at all", async () => {
    stubExecuteScript(async () => []);
    expect(await detectPaperFromPageMetadata(42)).toEqual({ state: "unsupported" });
  });

  it("is unsupported when the page carries conflicting DOIs", async () => {
    stubExecuteScript(async () => [{ result: [DOI, OTHER_DOI] }]);
    expect(await detectPaperFromPageMetadata(42)).toEqual({ state: "unsupported" });
  });

  it("never surfaces Chrome's rejection text", async () => {
    // Chrome's message is about a page the user is on. It is not read, so it
    // cannot be shown, logged or handed to PaperLume.
    const secret = "Cannot access contents of https://intranet.example/patient-42";
    stubExecuteScript(() => Promise.reject(new Error(secret)));

    const detection = await detectPaperFromPageMetadata(42);

    expect(detection).toEqual({ state: "unsupported" });
    expect(JSON.stringify(detection)).not.toContain("intranet");
  });
});
