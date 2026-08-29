/**
 * The DOI metadata fallback, exercised in a real browser against real pages.
 *
 * This is the lane for the failure that produced
 * CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01: a user navigates to
 * `https://doi.org/10.1038/s41586-020-2649-2`, the resolver redirects to Nature
 * before they can reach the toolbar, and the extension used to answer
 * *unsupported* for the most ordinary way anyone arrives at a paper by DOI.
 *
 * ## What is real here, and what is not
 *
 * The pages are real: a real tab really navigates to a publisher-like address
 * and a real Chromium really parses the markup below into a real DOM. The
 * function that reads them is the **built** one, taken out of `popup.js` by the
 * popup itself and serialized exactly the way Chrome serializes an injected
 * function. What it returns is fed straight back into the real built normalizer,
 * and everything after that — the state the popup shows, the handoff URL,
 * `chrome.tabs.create` — is real code in a real browser.
 *
 * The one thing supplied is the **grant**. Chrome refuses
 * `chrome.scripting.executeScript` outright without a toolbar click, which
 * `load.spec.ts` proves rather than assumes, and Playwright cannot click browser
 * chrome. So `openPopup({ pageHtml })` replaces `executeScript` with a harness
 * function that runs the same serialized source in the target page's realm. The
 * grant is faked; the read is not. `docs/chrome-web-store-readiness.md` §8
 * carries the manual gate for the one step that stays unautomatable.
 *
 * Because the source really is serialized and really is evaluated somewhere the
 * bundle's module scope does not exist, this lane also catches the mistake most
 * likely to survive every other test: an injected function that reads a
 * module-level constant. That works in jsdom, survives bundling, and throws
 * `ReferenceError` on a publisher's page.
 */

import { test, expect, PAPERLUME_ORIGIN } from "./support/extensionHarness";

/** Where a doi.org link for this DOI actually lands. */
const PUBLISHER_URL = "https://www.nature.com/articles/s41586-020-2649-2";
const DOI = "10.1038/s41586-020-2649-2";

/** A real DOI with capitals in its suffix, for the ASCII-case equivalence case. */
const MIXED_CASE_DOI = "10.1056/NEJMoa2107934";
const NEJM_URL = "https://www.nejm.org/doi/full/10.1056/NEJMoa2107934";

/**
 * A publisher-like article page.
 *
 * Deliberately loaded with material the extension must ignore: a title
 * containing a DOI, body text containing a different DOI, a link to a third,
 * a `citation_title`, and an author. Only `citation_doi` may be read, and only
 * from the head.
 */
const ARTICLE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>Array programming with NumPy (10.9999/title-doi) | Nature</title>
    <meta charset="utf-8">
    <meta name="citation_title" content="Array programming with NumPy">
    <meta name="citation_journal_title" content="Nature">
    <meta name="citation_author" content="Harris, Charles R.">
    <meta name="citation_doi" content="${DOI}">
    <meta name="description" content="An article. See 10.9999/description-doi.">
  </head>
  <body>
    <h1>Array programming with NumPy</h1>
    <p>Cite this article as 10.9999/body-doi.</p>
    <a href="https://doi.org/10.9999/link-doi">A cited work</a>
  </body>
</html>`;

/** The same paper, described twice, in two accepted presentation forms. */
const DUPLICATE_METADATA_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta name="citation_doi" content="  ${DOI}  ">
    <meta name="DC.Identifier" content="doi:${DOI}">
    <meta property="prism.doi" content="https://doi.org/${DOI}">
  </head>
  <body><h1>One paper</h1></body>
</html>`;

/**
 * A page whose only approved keys are on `property`, each behind a `name` that is
 * present but not approved.
 *
 * Written so that the two failure modes cannot mask each other. There is exactly
 * one DOI here, in one spelling, so the *ambiguity* rule has nothing to decide —
 * the only question is whether `property` is consulted at all. Under a
 * `name ?? property` read, `getAttribute("name")` returns `"og:type"` on the
 * first element and `""` on the second; neither is `null`, so the `??` never
 * falls through and both approved `property` values are invisible. The page then
 * publishes nothing and the popup says so.
 *
 * Both shapes are ordinary in RDFa-flavoured publisher markup.
 */
const PROPERTY_ONLY_METADATA_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta name="og:type" property="citation_doi" content="${MIXED_CASE_DOI}">
    <meta name="" property="prism.doi" content="${MIXED_CASE_DOI}">
  </head>
  <body><h1>Approved key on property only</h1></body>
</html>`;

/**
 * One paper whose DOI is published in three ASCII-case variants.
 *
 * Every approved key here is on `name`, so the `name`/`property` rule has
 * nothing to decide and this page tests the *equivalence* rule alone. Under an
 * exact-string ambiguity check these are three different DOI names and the page
 * is refused; under DOI Handbook §4.3.4 they are one DOI.
 *
 * The mixture is what real markup looks like: the registered DOI keeps its
 * capitals in `citation_doi`, while display guidance encourages the lower-cased
 * resolver URL that appears in `dc.identifier`.
 */
const CASE_VARIANT_METADATA_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta name="citation_doi" content="${MIXED_CASE_DOI}">
    <meta name="dc.identifier" content="https://doi.org/${MIXED_CASE_DOI.toLowerCase()}">
    <meta name="prism.doi" content="doi:${MIXED_CASE_DOI.toUpperCase()}">
  </head>
  <body><h1>One paper, three spellings</h1></body>
</html>`;

/** A page that publishes two genuinely different DOIs. */
const CONFLICTING_METADATA_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta name="citation_doi" content="${DOI}">
    <meta name="dc.identifier" content="10.1000/a-completely-different-work">
  </head>
  <body><h1>Which paper is this?</h1></body>
</html>`;

/** A publisher page that publishes no DOI at all. */
const NO_METADATA_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>10.9999/only-in-the-title</title>
    <meta name="citation_title" content="Array programming with NumPy">
  </head>
  <body><p>The DOI is 10.9999/only-in-the-body.</p></body>
</html>`;

/** Which state section the popup is currently showing. */
async function visibleStates(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-state]")]
      .filter((section) => !section.hidden)
      .map((section) => section.dataset.state ?? ""),
  );
}

test("identifies the DOI a publisher page publishes, where the URL identifies nothing", async ({
  extension,
}) => {
  const page = await extension.openPopup({
    activeTabUrl: PUBLISHER_URL,
    pageHtml: ARTICLE_PAGE,
  });

  // The address itself names no paper — `popup.spec.ts` shows this same URL
  // reaching `unsupported` when the page behind it publishes nothing, and the
  // control immediately below repeats it here. The DOI comes from the page.
  await expect.poll(() => visibleStates(page)).toEqual(["doi"]);
  await expect(page.locator('[data-field="doi"]')).toHaveText(DOI);
  await expect(page.locator("[data-handoff]")).toBeVisible();
});

test("the same publisher URL is unsupported when the page publishes no DOI", async ({ extension }) => {
  // The control for the test above: same address, same everything, no
  // `citation_doi`. If this showed a DOI, the one above would be proving that
  // the harness detects DOIs rather than that the extension does.
  const page = await extension.openPopup({
    activeTabUrl: PUBLISHER_URL,
    pageHtml: NO_METADATA_PAGE,
  });

  await expect.poll(() => visibleStates(page)).toEqual(["unsupported"]);
  await expect(page.locator("[data-handoff]")).toBeHidden();
});

test("reads only the approved metadata, never the title, body or links", async ({ extension }) => {
  // `ARTICLE_PAGE` carries four other DOIs — in the document title, in a
  // `description` meta, in body text, and in an anchor href. The one that must
  // win is the one in `citation_doi`, and the others must not appear anywhere.
  const page = await extension.openPopup({
    activeTabUrl: PUBLISHER_URL,
    pageHtml: ARTICLE_PAGE,
  });

  await expect(page.locator('[data-field="doi"]')).toHaveText(DOI);

  const shown = (await page.evaluate(() => document.body.textContent)) ?? "";
  for (const decoy of ["10.9999", "title-doi", "body-doi", "link-doi", "description-doi"]) {
    expect(shown, `the popup showed ${decoy}`).not.toContain(decoy);
  }
  // Nor the article title, the journal, or the author.
  expect(shown).not.toContain("Array programming");
  expect(shown).not.toContain("Harris");
});

test("collapses one DOI written three ways into a single detection", async ({ extension }) => {
  const page = await extension.openPopup({
    activeTabUrl: PUBLISHER_URL,
    pageHtml: DUPLICATE_METADATA_PAGE,
  });

  await expect.poll(() => visibleStates(page)).toEqual(["doi"]);
  // Trimmed, un-prefixed, and reduced from a resolver URL to the DOI name.
  await expect(page.locator('[data-field="doi"]')).toHaveText(DOI);
});

test("reads an approved property even when an unhelpful name sits beside it", async ({
  extension,
}) => {
  // The `name ?? property` defect, in a real browser against a real DOM. Every
  // approved key on this page is on `property`, behind a `name` that is present
  // but not approved — `"og:type"` on one element, `""` on the other. Under `??`
  // neither `property` is ever consulted and this page identifies nothing.
  const page = await extension.openPopup({
    activeTabUrl: NEJM_URL,
    pageHtml: PROPERTY_ONLY_METADATA_PAGE,
  });

  await expect.poll(() => visibleStates(page)).toEqual(["doi"]);
  await expect(page.locator('[data-field="doi"]')).toHaveText(MIXED_CASE_DOI);
  await expect(page.locator("[data-handoff]")).toBeVisible();
});

test("collapses ASCII case variants of one DOI, keeping the registered spelling", async ({
  extension,
}) => {
  // DOI Handbook §4.3.4: ASCII `A`–`Z` compares identical to `a`–`z` when DOI
  // names are compared, so three spellings of `10.1056/NEJMoa2107934` are one
  // paper, not an ambiguity. What is shown, and what is handed off, is the
  // spelling the page published first — not a lower-cased rewrite.
  const page = await extension.openPopup({
    activeTabUrl: NEJM_URL,
    pageHtml: CASE_VARIANT_METADATA_PAGE,
  });

  await expect.poll(() => visibleStates(page)).toEqual(["doi"]);
  await expect(page.locator('[data-field="doi"]')).toHaveText(MIXED_CASE_DOI);
  await expect(page.locator("[data-handoff]")).toBeVisible();

  const opened = extension.context.waitForEvent("page");
  await page.locator("[data-handoff-action]").click();
  await opened;

  const [handoffUrl] = await extension.createdTabUrls(page);
  const handoff = new URL(handoffUrl);
  expect(handoff.searchParams.get("kind")).toBe("doi");
  // The capitals survive: one valid DOI name, not a normalization artefact.
  expect(handoff.searchParams.get("value")).toBe(MIXED_CASE_DOI);
  expect(handoff.searchParams.get("value")).not.toBe(MIXED_CASE_DOI.toLowerCase());
  expect([...handoff.searchParams.keys()].sort()).toEqual(["kind", "value"]);
});

test("fails closed on a page that publishes two different DOIs", async ({ extension }) => {
  // Never a choice between them. Offering either would put the wrong paper in
  // front of the user under a confident "Paper detected", and `doi` is a
  // per-user deduplication key — so the wrong one is a data-integrity bug.
  const page = await extension.openPopup({
    activeTabUrl: PUBLISHER_URL,
    pageHtml: CONFLICTING_METADATA_PAGE,
  });

  await expect.poll(() => visibleStates(page)).toEqual(["unsupported"]);
  await expect(page.locator("[data-handoff]")).toBeHidden();

  const shown = (await page.evaluate(() => document.body.textContent)) ?? "";
  expect(shown).not.toContain(DOI);
  expect(shown).not.toContain("10.1000/a-completely-different-work");
});

test("hands a metadata-detected DOI over as kind and value, and nothing else", async ({
  extension,
}) => {
  const page = await extension.openPopup({
    activeTabUrl: PUBLISHER_URL,
    pageHtml: ARTICLE_PAGE,
  });
  await expect(page.locator("[data-handoff]")).toBeVisible();

  const pagesBefore = extension.context.pages().length;
  const opened = extension.context.waitForEvent("page");
  await page.locator("[data-handoff-action]").click();
  await opened;

  const createdUrls = await extension.createdTabUrls(page);
  expect(createdUrls).toHaveLength(1);
  // Exactly one real tab, opened by the real `chrome.tabs.create`.
  expect(extension.context.pages().length).toBe(pagesBefore + 1);

  const handoff = new URL(createdUrls[0]);
  expect(handoff.origin).toBe(PAPERLUME_ORIGIN);
  expect(handoff.pathname).toBe("/extension-import");
  expect([...handoff.searchParams.keys()].sort()).toEqual(["kind", "value"]);
  expect(handoff.searchParams.get("kind")).toBe("doi");
  expect(handoff.searchParams.get("value")).toBe(DOI);
  expect(handoff.hash).toBe("");

  // The page it came from does not travel — not the URL, not the title, not the
  // journal, not the author, not a referrer, not the extension id.
  const raw = createdUrls[0];
  for (const leaked of ["nature.com", "Array", "Harris", "citation", "chrome-extension"]) {
    expect(raw, `the handoff carried ${leaked}`).not.toContain(leaked);
  }
});

test("makes no request of its own while reading a page's metadata", async ({ extension }) => {
  const page = await extension.openPopup({
    activeTabUrl: PUBLISHER_URL,
    pageHtml: ARTICLE_PAGE,
  });

  const offOrigin: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("chrome-extension://")) offOrigin.push(request.url());
  });

  await expect.poll(() => visibleStates(page)).toEqual(["doi"]);
  await page.waitForTimeout(500);

  // The metadata read is an injection, not a fetch. Nothing is looked up, and
  // in particular the DOI is never resolved against doi.org or Crossref to see
  // whether it exists.
  expect(offOrigin).toEqual([]);
});

test("stores nothing, having read a page", async ({ extension }) => {
  const page = await extension.openPopup({
    activeTabUrl: PUBLISHER_URL,
    pageHtml: ARTICLE_PAGE,
  });
  await expect.poll(() => visibleStates(page)).toEqual(["doi"]);

  const storage = await page.evaluate(() => ({
    // `chrome.storage` is not merely unused — the permission is not declared, so
    // Chrome does not expose the namespace at all.
    chromeStorage: typeof (chrome as unknown as { storage?: unknown }).storage,
    localStorageKeys: Object.keys(localStorage),
    sessionStorageKeys: Object.keys(sessionStorage),
    cookies: document.cookie,
  }));

  expect(storage.chromeStorage).toBe("undefined");
  expect(storage.localStorageKeys).toEqual([]);
  expect(storage.sessionStorageKeys).toEqual([]);
  expect(storage.cookies).toBe("");
});
