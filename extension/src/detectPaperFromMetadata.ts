/**
 * The DOI metadata fallback: the one thing the extension reads from a page.
 *
 * `detectPaperFromUrl` is still tried first and still decides most cases. This
 * module runs only for the case it cannot decide — an ordinary http(s) page
 * whose *address* names no paper — and only because the user has already
 * clicked the toolbar action on that tab.
 *
 * ## Why this exists
 *
 * The URL-only classifier was correct and impractical. A DOI resolver redirects
 * almost immediately: by the time a user has read the page and reached for the
 * toolbar, `doi.org/10.1038/s41586-020-2649-2` has become
 * `www.nature.com/articles/s41586-020-2649-2`, and the extension answered
 * *unsupported* for the single most ordinary way anyone arrives at a paper by
 * DOI. Owner manual acceptance of CHROME-EXTENSION-IMPORT-001E2 failed on
 * exactly that, and CORRECTION-01 is the accepted answer to it.
 *
 * ## Why it is a metadata read and not a publisher rule
 *
 * The tempting fix is a rule for Nature, then one for Elsevier, then one for
 * Springer — a catalogue of URL patterns that is wrong the day a publisher
 * changes a path, and that never covers the next journal. The DOI is already
 * *published in the page* by the same publishers, in metadata conventions that
 * exist precisely so that indexers can read it: Google Scholar's `citation_doi`,
 * Dublin Core's `dc.identifier`, PRISM's `prism.doi`. Reading those is a
 * standards-based fallback with no per-site knowledge in it at all.
 *
 * ## What is read, and what is deliberately not
 *
 * Four metadata keys, matched case-insensitively on `name` or `property`, from
 * `document.head` only. Their `content` strings are the *entire* output.
 *
 * Not read, and each absence is a decision rather than an omission: the document
 * title, the article title, the abstract, headings, body text, anchor `href`s
 * that happen to contain `10.`, arbitrary `data-` attributes, inline scripts,
 * JSON-LD, JavaScript variables, iframes, PDFs, forms, cookies, storage, or the
 * selection. There is **no title fallback** here for the same reason
 * `detectPaperFromUrl` has none — `pmid` and `doi` are per-user deduplication
 * keys, so resolving the wrong paper is a data-integrity bug, not a display bug.
 *
 * ## Fail closed, including on ambiguity
 *
 * A page that publishes two *different* valid DOIs is refused outright rather
 * than resolved by picking one. There is no defensible way to choose — a
 * `citation_doi` and a `dc.identifier` that disagree mean the page is describing
 * more than one work, or is describing one work wrongly — and picking either
 * would offer the user the wrong paper to import under a confident-looking
 * "Paper detected".
 *
 * "Different" means *not equivalent under DOI Handbook §4.3.4*, which is a
 * weaker test than "not identical": ASCII case is insensitive when DOI names are
 * compared, so `10.1000/AB` and `10.1000/ab` are one DOI and one detection.
 * Duplicates of the same DOI, in any mixture of accepted presentation forms and
 * any mixture of ASCII case, are accepted. `doiEquivalenceKey` implements the
 * rule and explains why it is not `toLowerCase()`.
 *
 * @see https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
 *   — *"Call `scripting.insertCSS()` or `scripting.executeScript()` on that tab
 *   if the `"scripting"` permission is also declared"*, and the four gestures
 *   that grant it, of which executing the action is the one this extension uses.
 * @see https://developer.chrome.com/docs/extensions/reference/api/scripting
 *   — *"Use the `host_permissions` key or the `activeTab` permission, which
 *   grants temporary host permissions"*, and *"By default, an injection will
 *   inject into the main frame of the specified tab"*.
 */

import { doiEquivalenceKey, extractDoiFromMetadataValue } from "@/lib/doiIdentifiers";

import type { PaperDetection } from "./detectPaperFromUrl";

/**
 * Collect the `content` of every approved DOI metadata element in the page.
 *
 * **This function is injected into the page and must stay self-contained.**
 * Chrome serializes it and deserializes it inside the target document, so
 * *"any bound parameters and execution context will be lost"* — a reference to
 * anything outside this body, including a module-level constant that looks
 * harmless in the source, becomes a `ReferenceError` in the page. Everything it
 * needs is therefore declared inside it, and it calls no helper.
 *
 * It is written to be as small and as dull as a function that runs inside
 * someone else's page can be. It reads; it does not navigate, request, store,
 * observe, or write. It returns strings and nothing else: no element, no node,
 * no `document`, nothing that would drag more of the page across the boundary
 * than the values themselves — and Chrome would refuse to serialize those
 * anyway. Normalization, validation and the ambiguity decision all happen back
 * in the extension, in `resolveDoiFromMetadata`, where they are ordinary
 * testable code rather than a second identifier parser embedded in a page.
 *
 * `document.head` rather than `document`: bibliographic metadata belongs in the
 * head, and scoping there means no `<meta>` a page happens to place in its body
 * — inside user-generated content, say — is inspected at all.
 *
 * `name` and `property` are both consulted because both are used in practice
 * for these keys: Google Scholar's tags and Dublin Core are conventionally
 * `name`, while PRISM and Dublin Core in RDFa-flavoured markup appear as
 * `property`. Nothing else is consulted — not `http-equiv`, not `itemprop`.
 *
 * They are tested **independently**, and an element qualifies if *either* one
 * matches. An earlier draft read `name ?? property`, which is a different rule
 * with a real failure mode: a `<meta name="" property="prism.doi" …>` — or one
 * whose `name` carries some unrelated vendor key — has a present-but-unhelpful
 * `name`, so the `??` never falls through and the approved `property` beside it
 * is never looked at. Both attributes appearing on one element is ordinary in
 * RDFa-flavoured markup, so this was not a hypothetical.
 *
 * An element still contributes its `content` **once**, even when both attributes
 * are approved: what is being collected is one page's claim about its DOI, and
 * counting one element twice would turn a single tag into a duplicate.
 */
export function readDoiMetadataFromPage(): string[] {
  // Declared here, not at module scope: see the self-containment note above.
  const keys = ["citation_doi", "dc.identifier", "dc.identifier.doi", "prism.doi"];
  const values: string[] = [];

  for (const element of document.head.querySelectorAll("meta")) {
    // `name` OR `property`, tested independently — not `name ?? property`,
    // which lets a present-but-unrelated `name` hide an approved `property`
    // on the same element. `some` also stops at the first match, so an
    // element with both approved contributes its content once.
    const approved = ["name", "property"].some((attribute) => {
      const key = (element.getAttribute(attribute) ?? "").trim().toLowerCase();
      return keys.indexOf(key) !== -1;
    });
    if (!approved) continue;

    const content = element.getAttribute("content");
    if (typeof content === "string" && content.length > 0) values.push(content);
  }

  return values;
}

/**
 * Turn the collected metadata values into a detection.
 *
 * Pure, and separated from the Chrome call above it so that every rule below is
 * assertable without a browser:
 *
 *   • each value is normalized by the application's own DOI boundary,
 *     `extractDoiFromMetadataValue`, so a presentation form (`doi:…`, `DOI: …`,
 *     `https://doi.org/…`, `http://dx.doi.org/…`, a bare name, any of them
 *     surrounded by markup whitespace) resolves to the DOI *name* the handoff
 *     contract carries;
 *   • anything that does not normalize is dropped, not guessed at;
 *   • duplicates collapse — two elements carrying the same DOI, however written,
 *     are one DOI;
 *   • two or more *different* DOIs are `unsupported`, never a choice between
 *     them.
 *
 * ## What "different" means
 *
 * Not "not identical" — *not equivalent*, per DOI Handbook §4.3.4, which the
 * application's `doiEquivalenceKey` implements. ASCII `A`–`Z` compares equal to
 * `a`–`z` when DOI names are compared, so a page whose `citation_doi` reads
 * `10.1000/AB` and whose `dc.identifier` reads `10.1000/ab` is describing **one**
 * paper and gets one detection. Treating those as an ambiguity would refuse a
 * perfectly unambiguous page, which is the defect this replaced.
 *
 * The fold is ASCII-only and is not `toLowerCase()`. Non-ASCII case is *not*
 * folded, because the Handbook says those code points are not equivalent — its
 * own example is `10.26321/Á.GUTIÉRREZ…` versus `10.26321/á.gutiérrez…`, which
 * are two different DOIs. A page carrying both of those is still an ambiguity
 * and is still refused.
 *
 * ## The DOI that comes out is a name, not a key
 *
 * Grouping is by equivalence key; what is *returned* is one of the original DOI
 * names — the first spelling the page offered, in document order. The key is a
 * comparison artefact and never leaves this function: it is not displayed, not
 * handed to `/extension-import`, and not stored. So a publisher writing
 * `10.1056/NEJMoa2107934` gets that back, with its capitals, rather than a
 * lower-cased rewrite of the DOI they registered.
 */
export function resolveDoiFromMetadata(values: readonly string[]): PaperDetection {
  // Key → the first DOI name seen for it. A `Map` rather than a `Set` because
  // both halves are needed: the key decides how many distinct DOIs the page
  // published, and the value preserves a real spelling to hand on.
  const byEquivalence = new Map<string, string>();

  for (const value of values) {
    const doi = extractDoiFromMetadataValue(value);
    if (doi === null) continue;

    const key = doiEquivalenceKey(doi);
    // `doi` is a non-empty string here, so the key is never null; the guard is
    // for the type rather than for a case that can occur.
    if (key !== null && !byEquivalence.has(key)) byEquivalence.set(key, doi);
  }

  if (byEquivalence.size !== 1) return { state: "unsupported" };

  const [doi] = byEquivalence.values();
  return { state: "doi", doi };
}

/**
 * Read the active tab's DOI metadata, if the page has any.
 *
 * The one privileged call this module makes, and the only page access the
 * extension has. It reaches the page through the temporary host permission the
 * user's toolbar click already granted — `activeTab` — rather than through a
 * declared host permission, so the access exists for one tab, because of one
 * gesture, and ends when the user navigates away. No `host_permissions`, no
 * content script, no service worker: nothing here can run when the user has not
 * asked for it.
 *
 * The main frame only. `allFrames` is deliberately not passed, so Chrome's
 * documented default applies and an advertisement or an embedded widget on the
 * page is never inspected.
 *
 * **Every failure is `unsupported`.** Chrome rejects the call for a page the
 * extension may not touch — a `chrome://` page reached mid-navigation, the Web
 * Store, a PDF viewer, a tab that closed — and the rejection reason is Chrome's
 * text about a page the user is on, so it is not read, not shown, not logged and
 * not retried. A user who cannot be offered a paper sees the ordinary "no paper
 * identified" state, which is true, rather than a browser error they cannot act
 * on.
 */
export async function detectPaperFromPageMetadata(tabId: number): Promise<PaperDetection> {
  let injected: { readonly result?: string[] }[];
  try {
    injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: readDoiMetadataFromPage,
    });
  } catch {
    return { state: "unsupported" };
  }

  // One target frame means at most one result, but the platform types this as
  // an array and a frame whose script threw carries no `result` at all.
  const values = injected.flatMap((frame) => frame.result ?? []);

  return resolveDoiFromMetadata(values);
}
