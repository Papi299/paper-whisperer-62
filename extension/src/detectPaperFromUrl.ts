/**
 * The extension's URL-only paper classifier.
 *
 * It reads one string — the active tab's URL, obtained only after the user
 * explicitly opened the popup — and decides whether that URL *structurally*
 * names a PubMed record or a DOI. It never touches the page: no DOM, no
 * `<meta>` tag, no document title, no page text.
 *
 * This module is still tried first, always, and three of its four answers are
 * final. Since CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01 the fourth is not:
 * `unsupported` on an ordinary http(s) page is what `popup.ts` follows with the
 * narrow DOI metadata read in `detectPaperFromMetadata.ts`. `pubmed`, `doi` and
 * `restricted` end here, so a recognised address — and a browser page that is
 * no web page at all — is still answered without the page being touched.
 *
 * ## Why this does not call `detectIdentifier()`
 *
 * The importer's classifier (`supabase/functions/_shared/identifierDetection.ts`)
 * ends with a `title` classification: anything it cannot authenticate as a PMID
 * or a DOI is handed to a title search. That is correct for its input, which is
 * text a person *pasted into an import box* — where "Effects of vitamin D on
 * bone density" is a perfectly reasonable thing to have pasted.
 *
 * A browser address bar never holds a paper title. `https://publisher.example/
 * article/foo` is a URL that failed to identify a paper, not a search term, and
 * feeding it to a title search would resolve some *other* paper — the first
 * PubMed or Crossref hit for a string of URL punctuation — and offer to import
 * it. `pmid` and `doi` are per-user deduplication keys, so a wrong resolution is
 * a data-integrity bug rather than a display bug.
 *
 * So this module composes the two narrow structural extractors directly and has
 * no fallback at all. `PaperDetection` has no `title` variant, which makes the
 * absence a type-level property rather than a convention someone has to
 * remember. `__tests__/detectPaperFromUrl.test.ts` pins the difference against
 * the importer's classifier on the same input.
 *
 * ## Reuse boundary
 *
 * Both extractors are imported from the application's own pure identifier
 * modules — `@/lib/pubmedIdentifiers` and `@/lib/doiIdentifiers`. The extension
 * is built by Vite from this same repository, so it shares the application's
 * bundling domain and can use them directly: no third grammar is introduced
 * here, and there is nothing for a copy to drift from. Those two modules are in
 * turn pinned to the Edge Function's equivalent classifier by parity tests.
 */

import { extractDoiFromDoiUrl } from "@/lib/doiIdentifiers";
import { extractPmidFromPubMedUrl } from "@/lib/pubmedIdentifiers";

/**
 * What the extension concluded about the active tab.
 *
 * Deliberately four cases, and deliberately no fifth:
 *
 *   • `pubmed` / `doi` — a structurally authenticated record, with its value.
 *   • `unsupported` — an ordinary web page whose *address* names no paper. Not
 *     an error, and — since CORRECTION-01 — not always the last word: `popup.ts`
 *     follows this one state, and only this one, with the DOI metadata read.
 *     It is the final answer when that read finds nothing either.
 *   • `restricted` — there is no inspectable web page at all: a `chrome://`
 *     page, a local file, a `view-source:` view, or a tab whose URL Chrome did
 *     not expose. Kept separate from `unsupported` so the popup can say
 *     something true instead of implying detection was attempted and failed.
 */
export type PaperDetection =
  | { readonly state: "pubmed"; readonly pmid: string }
  | { readonly state: "doi"; readonly doi: string }
  | { readonly state: "unsupported" }
  | { readonly state: "restricted" };

/** The only schemes a page the extension can reason about may use. */
const INSPECTABLE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Whether a reported tab URL is an ordinary web page.
 *
 * Fails closed on every uncertainty — a non-string, a blank string, a value the
 * WHATWG parser rejects, or any scheme outside http(s). Nothing is repaired: no
 * scheme is prepended and no base URL is supplied, so a scheme-less
 * `pubmed.ncbi.nlm.nih.gov/123` never acquires the authority the prefix would
 * have given it.
 */
function isInspectableWebUrl(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;

  const trimmed = value.trim();
  if (!trimmed) return false;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  // `protocol` is lowercased by the parser, so this exact-match check also
  // covers `HTTPS:`, `CHROME:` and `JaVaScRiPt:`.
  return INSPECTABLE_PROTOCOLS.has(parsed.protocol);
}

/**
 * Classify the active tab's URL.
 *
 * PubMed is tried before DOI because the two grammars cannot both match the
 * same URL — the host sets are disjoint — so the order is documentation, not a
 * precedence rule that could hide an ambiguity.
 *
 * @param tabUrl The URL Chrome reported for the active tab, or `undefined` when
 *   it reported none.
 */
export function detectPaperFromUrl(tabUrl: string | null | undefined): PaperDetection {
  if (!isInspectableWebUrl(tabUrl)) return { state: "restricted" };

  const pmid = extractPmidFromPubMedUrl(tabUrl);
  if (pmid !== null) return { state: "pubmed", pmid };

  const doi = extractDoiFromDoiUrl(tabUrl);
  if (doi !== null) return { state: "doi", doi };

  // No title fallback, here or in the metadata read that may follow. See the
  // module comment: a URL that identifies no paper is unsupported, never a
  // search term.
  return { state: "unsupported" };
}
