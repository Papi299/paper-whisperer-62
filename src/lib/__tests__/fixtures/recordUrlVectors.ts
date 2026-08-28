/**
 * Shared adversarial corpora for structural record-URL recognition.
 *
 * Every implementation that decides whether a URL is a PubMed record or a DOI
 * reference reads from these arrays, so a vector added for one is automatically
 * asserted against the others:
 *
 *   • `src/lib/pubmedIdentifiers.ts`   — the application's PubMed recogniser
 *   • `src/lib/doiIdentifiers.ts`      — the application's DOI recogniser
 *   • `supabase/functions/_shared/identifierDetection.ts` — the Edge Function's
 *     equivalent, in its own bundling domain, pinned by the parity test
 *   • `extension/src/detectPaperFromUrl.ts` — the Chrome extension's
 *     URL-only classifier, which composes the two application recognisers
 *
 * The negative corpora are the point. Each entry contains PubMed- or DOI-looking
 * characters *somewhere* but is not a PubMed record and not a DOI reference, so
 * an implementation that recognises by substring rather than by parsing fails
 * loudly. The values these functions return are persisted — `pmid` and `doi` are
 * both per-user deduplication keys — so a URL that acquires authority it has not
 * earned is a data-integrity bug, not a display bug.
 *
 * Nothing here performs or requires network access: the property under test is
 * what each function *decides about untrusted text*, never what a provider
 * answers.
 */

/** A labelled URL that must never establish PubMed or DOI authority. */
export type RejectedUrlVector = readonly [label: string, value: string];

/** A labelled URL and the identifier it legitimately names. */
export type AcceptedUrlVector = readonly [label: string, value: string, identifier: string];

/**
 * Legitimate PubMed record URLs and the record each one names.
 *
 * Sub-resources beneath a record (`/citedby/`) still name that record
 * unambiguously, so they are accepted; a query string or fragment never
 * contributes the PMID and is therefore harmless.
 */
export const PUBMED_RECORD_URLS: readonly AcceptedUrlVector[] = [
  ["modern", "https://pubmed.ncbi.nlm.nih.gov/12345678", "12345678"],
  ["modern, trailing slash", "https://pubmed.ncbi.nlm.nih.gov/12345678/", "12345678"],
  ["modern, uppercase host", "https://PUBMED.NCBI.NLM.NIH.GOV/12345678/", "12345678"],
  ["modern, mixed-case host", "https://PubMed.Ncbi.Nlm.Nih.Gov/12345678", "12345678"],
  ["modern, http", "http://pubmed.ncbi.nlm.nih.gov/12345678/", "12345678"],
  ["modern, query", "https://pubmed.ncbi.nlm.nih.gov/12345678/?foo=bar", "12345678"],
  ["modern, fragment", "https://pubmed.ncbi.nlm.nih.gov/12345678/#details", "12345678"],
  ["modern, sub-resource", "https://pubmed.ncbi.nlm.nih.gov/12345678/citedby/", "12345678"],
  ["legacy", "https://www.ncbi.nlm.nih.gov/pubmed/12345678", "12345678"],
  ["legacy, trailing slash", "https://www.ncbi.nlm.nih.gov/pubmed/12345678/", "12345678"],
  ["legacy, http", "http://www.ncbi.nlm.nih.gov/pubmed/12345678", "12345678"],
  ["legacy, query", "https://www.ncbi.nlm.nih.gov/pubmed/12345678/?report=abstract", "12345678"],
  ["legacy, fragment", "https://www.ncbi.nlm.nih.gov/pubmed/12345678#abstract", "12345678"],
];

/** Values that must never establish PubMed authority, with why each is unsafe. */
export const NON_PUBMED_URLS: readonly RejectedUrlVector[] = [
  ["near-host", "https://notpubmed.ncbi.nlm.nih.gov/12345678"],
  ["suffix-host", "https://pubmed.ncbi.nlm.nih.gov.evil.example/12345678"],
  ["user-info authority confusion", "https://pubmed.ncbi.nlm.nih.gov@evil.example/12345678"],
  ["query smuggling", "https://evil.example/?next=https://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["query smuggling (url=)", "https://evil.example/?url=https://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["fragment smuggling", "https://evil.example/#https://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["foreign path text", "https://example.com/pubmed.ncbi.nlm.nih.gov/12345678"],
  ["PubMed host, no record", "https://pubmed.ncbi.nlm.nih.gov/"],
  ["wrong modern path position", "https://pubmed.ncbi.nlm.nih.gov/foo/12345678"],
  ["invalid modern PMID segment", "https://pubmed.ncbi.nlm.nih.gov/123abc"],
  ["invalid modern PMID segment (trailing slash)", "https://pubmed.ncbi.nlm.nih.gov/123abc/"],
  ["wrong legacy service (pmc)", "https://www.ncbi.nlm.nih.gov/pmc/12345678"],
  ["wrong legacy service (pmc article)", "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/"],
  ["wrong legacy service (gene)", "https://www.ncbi.nlm.nih.gov/gene/123"],
  ["invalid legacy PMID", "https://www.ncbi.nlm.nih.gov/pubmed/123abc"],
  ["scheme-less", "pubmed.ncbi.nlm.nih.gov/12345678"],
  ["scheme-relative", "//pubmed.ncbi.nlm.nih.gov/12345678"],
  ["ftp scheme", "ftp://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["javascript scheme", "javascript:https://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["data scheme", "data:text/plain,https://pubmed.ncbi.nlm.nih.gov/12345678"],
  ["file scheme", "file:///pubmed.ncbi.nlm.nih.gov/12345678"],
];

/**
 * Legitimate DOI resolver URLs and the DOI name each one resolves.
 *
 * `doi.org` is the canonical proxy host documented by the DOI Foundation and
 * Crossref; `dx.doi.org` is the earlier one both state keeps resolving, and the
 * proxy answers http as well as https. The DOI is whatever the path says, taken
 * verbatim and percent-decoded exactly once — the proxy does the same.
 */
export const DOI_RESOLVER_URLS: readonly AcceptedUrlVector[] = [
  ["canonical", "https://doi.org/10.1000/example", "10.1000/example"],
  ["uppercase host", "https://DOI.ORG/10.1000/example", "10.1000/example"],
  ["mixed-case host", "https://DoI.OrG/10.1000/example", "10.1000/example"],
  ["http", "http://doi.org/10.1000/example", "10.1000/example"],
  ["legacy dx host", "https://dx.doi.org/10.1000/example", "10.1000/example"],
  ["legacy dx host, http", "http://dx.doi.org/10.1000/example", "10.1000/example"],
  ["legacy dx host, uppercase", "https://DX.DOI.ORG/10.1000/example", "10.1000/example"],
  ["query after the DOI", "https://doi.org/10.1000/example?utm_source=x", "10.1000/example"],
  ["fragment after the DOI", "https://doi.org/10.1000/example#sec-2", "10.1000/example"],
  ["query and fragment", "https://doi.org/10.1000/example?a=b#c", "10.1000/example"],
  ["suffix containing a slash", "https://doi.org/10.1000/a/b/c", "10.1000/a/b/c"],
  ["sub-divided registrant code", "https://doi.org/10.1000.10/example", "10.1000.10/example"],
  ["real-world DOI, case preserved", "https://doi.org/10.1056/NEJMoa2107934", "10.1056/NEJMoa2107934"],
  ["percent-encoded reserved character", "https://doi.org/10.1000/a%23b", "10.1000/a#b"],
  ["percent-encoded space", "https://doi.org/10.1000/a%20b", "10.1000/a b"],
  ["percent-encoded angle brackets", "https://doi.org/10.1000/%3Cx%3E", "10.1000/<x>"],
  // The proxy treats the path verbatim, so `10.1000/182/` is a different name
  // from `10.1000/182` and genuinely 404s. Repairing it here would name a DOI
  // the user was not looking at.
  ["trailing slash, preserved verbatim", "https://doi.org/10.1000/example/", "10.1000/example/"],
];

/** Values that must never establish DOI authority, with why each is unsafe. */
export const NON_DOI_URLS: readonly RejectedUrlVector[] = [
  ["near-host", "https://notdoi.org/10.1000/example"],
  ["near-host (prefixed)", "https://mydoi.org/10.1000/example"],
  ["suffix-host", "https://doi.org.evil.example/10.1000/example"],
  ["user-info authority confusion", "https://doi.org@evil.example/10.1000/example"],
  ["user-info authority confusion (dx)", "https://dx.doi.org@evil.example/10.1000/example"],
  ["query smuggling", "https://evil.example/?url=https://doi.org/10.1000/example"],
  ["fragment smuggling", "https://evil.example/#https://doi.org/10.1000/example"],
  ["foreign path text", "https://example.com/doi.org/10.1000/example"],
  ["resolver host, no path", "https://doi.org"],
  ["resolver host, root path", "https://doi.org/"],
  ["resolver host, not a DOI name", "https://doi.org/about"],
  ["directory indicator only", "https://doi.org/10."],
  ["prefix with no separator", "https://doi.org/10.1000"],
  ["prefix and separator, empty suffix", "https://doi.org/10.1000/"],
  ["DOI only in the query", "https://doi.org/?doi=10.1000/example"],
  ["DOI only in the fragment", "https://doi.org/#10.1000/example"],
  ["dot segments escaping the DOI path", "https://doi.org/10.1000/example/../../evil"],
  ["malformed percent-escape", "https://doi.org/10.1000/a%zz"],
  ["scheme-less", "doi.org/10.1000/example"],
  ["scheme-relative", "//doi.org/10.1000/example"],
  ["ftp scheme", "ftp://doi.org/10.1000/example"],
  ["javascript scheme", "javascript:https://doi.org/10.1000/example"],
  ["data scheme", "data:text/plain,https://doi.org/10.1000/example"],
  ["file scheme", "file:///doi.org/10.1000/example"],
];

/**
 * Ordinary web pages that name no paper this phase can identify.
 *
 * These are the regression corpus for the extension's URL boundary. A pasted
 * string that is neither a PMID nor a DOI may legitimately be a paper *title*,
 * which is why the importer's own classifier falls back to a title search — but
 * a browser address bar never holds a title. `https://publisher.example/article/foo`
 * is a URL that failed to identify a paper, and treating it as a search term
 * would resolve some *other* paper and offer to import it.
 */
export const NON_PAPER_PAGE_URLS: readonly RejectedUrlVector[] = [
  ["publisher article page", "https://journal.example/article/123"],
  ["publisher article page, deep path", "https://www.nature.com/articles/s41586-021-03819-2"],
  ["publisher page with a DOI-looking substring", "https://journal.example/10.1000/example"],
  ["publisher page with a DOI in the query", "https://journal.example/a?doi=10.1000/example"],
  ["publisher page with a DOI in the fragment", "https://journal.example/a#10.1000/example"],
  ["PMC article", "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/"],
  ["Google Scholar results", "https://scholar.google.com/scholar?q=crispr"],
  ["Google Scholar citation", "https://scholar.google.com/citations?user=abc123"],
  ["search engine", "https://www.google.com/search?q=10.1000%2Fexample"],
  ["a plain title-looking path", "https://example.com/Effects+of+Vitamin+D+on+Bone+Density"],
  ["site root", "https://example.com/"],
  ["preprint server", "https://arxiv.org/abs/2101.00001"],
];

/**
 * URLs the browser may report for a page the extension cannot inspect at all.
 *
 * These are not "unsupported pages" — there is no web page to identify. They
 * are reported separately so the popup can say something true rather than
 * implying the user is on an article page that failed detection.
 */
export const BROWSER_RESTRICTED_URLS: readonly RejectedUrlVector[] = [
  ["new tab page", "chrome://newtab/"],
  ["extensions page", "chrome://extensions/"],
  ["settings page", "chrome://settings/"],
  ["the extension's own pages", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html"],
  ["devtools", "devtools://devtools/bundled/inspector.html"],
  ["about:blank", "about:blank"],
  ["local file", "file:///Users/someone/paper.pdf"],
  ["view-source", "view-source:https://pubmed.ncbi.nlm.nih.gov/12345678/"],
  ["data URL", "data:text/html,<h1>hi</h1>"],
];
