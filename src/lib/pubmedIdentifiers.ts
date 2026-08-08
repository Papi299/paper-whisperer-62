/**
 * Structural recognition of PubMed identifiers and PubMed record URLs.
 *
 * Imported files are untrusted text. A BibTeX `url`, a RIS `UR`, or a CSV
 * `URL` column is whatever the exporting tool — or the person editing the file
 * — put there. Provenance therefore cannot be inferred from the *presence of a
 * substring*: `"pubmed"` occurs in `https://example.com/pubmed/123`, in
 * `https://example.com/?source=pubmed`, in `https://evil-pubmed.example/123`,
 * and in `https://pubmed.ncbi.nlm.nih.gov@evil.example/123` — none of which is
 * a PubMed record. A substring test grants that text an authority it has not
 * earned, and the resulting values persist: `pmid` participates in the
 * per-user deduplication domain, and `pubmed_url` is rendered to the user as a
 * link labelled "PubMed".
 *
 * Recognition here is structural instead. Parsing is delegated to the WHATWG
 * `URL` parser, and a decision is made only from the parsed `protocol`,
 * `hostname`, and `pathname`:
 *
 *   • `hostname` is compared for exact equality against an explicit host. The
 *     parser lowercases it, so `PUBMED.NCBI.NLM.NIH.GOV` matches without a
 *     manual case fold, while `pubmed.example.com`, `notpubmed.ncbi.nlm.nih.gov`
 *     and `pubmed.ncbi.nlm.nih.gov.example.com` do not.
 *   • `hostname` excludes user-info, so the authority-confusion form
 *     `https://pubmed.ncbi.nlm.nih.gov@evil.example/123` resolves to
 *     `evil.example` and is rejected.
 *   • The PMID is read from `pathname` only. A query string or fragment can
 *     never contribute it, so `?url=https://pubmed.ncbi.nlm.nih.gov/123` yields
 *     nothing.
 *
 * Everything fails closed: unparseable text, a non-http(s) scheme, and a
 * scheme-less string such as `pubmed.ncbi.nlm.nih.gov/123` all yield `null`.
 * Input is never repaired — no scheme is prepended or guessed, because doing so
 * would invent the very authority this module exists to verify.
 */

/** The modern PubMed record host. Compared exactly, against the parsed hostname. */
const PUBMED_RECORD_HOST = "pubmed.ncbi.nlm.nih.gov";

/**
 * The legacy NCBI host that served PubMed records under `/pubmed/<PMID>`.
 * Only that path prefix is PubMed: sibling NCBI services on the same host
 * (`/pmc/...`, `/gene/...`) are unrelated resources and must not be recognized.
 */
const LEGACY_PUBMED_HOST = "www.ncbi.nlm.nih.gov";
const LEGACY_PUBMED_PATH_PREFIX = "pubmed";

/** The only schemes an imported external link may use. Compared exactly. */
const IMPORTABLE_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * A PMID is a bare decimal identifier. No sign, no separator, no prefix or
 * suffix, and no upper bound — NLM assigns them sequentially and a hard length
 * cap would eventually reject valid records.
 */
const PMID_PATTERN = /^\d+$/;

/** Absolute http(s) URLs embedded in free text (e.g. a BibTeX `note` field). */
const EMBEDDED_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/** Sentence punctuation that trails a URL in prose rather than belonging to it. */
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]}]+$/;

/**
 * Validate a value that is *declared* to be a PMID — a BibTeX `pmid` field, a
 * CSV `PMID` column — and return it in normalized form.
 *
 * Declaring a field to be a PMID says what the value is *meant* to be, not what
 * it is, so the syntax is still checked: an Embase accession (`L629384756`), a
 * Web of Science accession (`WOS:000123456700001`), or free text must never
 * reach `papers.pmid`, where it would become a deduplication key.
 *
 * @returns The bare digits, or `null` when the value is not a valid PMID.
 */
export function normalizePmid(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return PMID_PATTERN.test(trimmed) ? trimmed : null;
}

/** The canonical record URL for a PMID. The single stored representation. */
export function canonicalPubMedUrl(pmid: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}

/**
 * Parse an imported value into an absolute http(s) `URL`, or `null`.
 *
 * No base URL is supplied, so relative and scheme-relative values fail rather
 * than resolving against the application origin.
 */
function parseImportableUrl(value: string | null | undefined): URL | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // `protocol` is lowercased by the parser, so this exact-match check also
  // covers `HTTPS:` and `JaVaScRiPt:`.
  return IMPORTABLE_PROTOCOLS.has(parsed.protocol) ? parsed : null;
}

/** Non-empty path segments, in order. Segments stay percent-encoded. */
function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter((segment) => segment.length > 0);
}

/**
 * Extract the PMID a PubMed record URL refers to.
 *
 * Accepts the modern record form `https://pubmed.ncbi.nlm.nih.gov/<PMID>` and
 * the legacy form `https://www.ncbi.nlm.nih.gov/pubmed/<PMID>`, each with or
 * without a trailing slash, with any query string or fragment, and with any
 * sub-resource beneath the record (e.g. `/12345678/citedby/`) — the record the
 * URL belongs to is unambiguous in all of those.
 *
 * The PMID is taken from the record position in the path. Because the host has
 * already been proven to be PubMed, a numeric segment there is an authentic
 * PubMed record reference; because only the path is consulted, no attacker-
 * supplied query or fragment can supply one.
 *
 * @returns The PMID, or `null` when the value is not a PubMed record URL.
 */
export function extractPmidFromPubMedUrl(value: string | null | undefined): string | null {
  const url = parseImportableUrl(value);
  if (!url) return null;

  const segments = pathSegments(url);

  if (url.hostname === PUBMED_RECORD_HOST) {
    return normalizePmid(segments[0]);
  }

  if (url.hostname === LEGACY_PUBMED_HOST && segments[0] === LEGACY_PUBMED_PATH_PREFIX) {
    return normalizePmid(segments[1]);
  }

  return null;
}

/** Whether a value is a PubMed record URL naming a specific record. */
export function isPubMedRecordUrl(value: string | null | undefined): boolean {
  return extractPmidFromPubMedUrl(value) !== null;
}

/**
 * Accept an imported value as a generic external link.
 *
 * Used for links that carry no provider claim (a publisher page, a DOI
 * resolver, a PMC article). The value must still be an absolute http(s) URL —
 * a `javascript:` or `data:` value must not be stored as a link merely because
 * it is not a PubMed link.
 *
 * @returns The parsed absolute URL, or `null` when it is not usable as a link.
 */
export function toImportableExternalUrl(value: string | null | undefined): string | null {
  return parseImportableUrl(value)?.href ?? null;
}

/**
 * Find the first PubMed record URL embedded in free text and return its PMID.
 *
 * Absolute http(s) candidates are extracted first and each is then put through
 * the same structural check as any other URL, so prose cannot smuggle in a
 * PMID: in `https://example.com/?url=https://pubmed.ncbi.nlm.nih.gov/123` the
 * whole run of non-whitespace characters is one candidate whose host is
 * `example.com`, and a scheme-less `pubmed.ncbi.nlm.nih.gov/123` is not a
 * candidate at all.
 *
 * @returns The PMID of the first embedded PubMed record URL, or `null`.
 */
export function extractPmidFromText(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;

  const candidates = text.match(EMBEDDED_URL_PATTERN);
  if (!candidates) return null;

  for (const candidate of candidates) {
    const pmid = extractPmidFromPubMedUrl(
      candidate.replace(TRAILING_PUNCTUATION_PATTERN, ""),
    );
    if (pmid) return pmid;
  }

  return null;
}
