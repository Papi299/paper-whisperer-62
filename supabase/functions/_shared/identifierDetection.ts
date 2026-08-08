/**
 * Structural classification of a pasted metadata-import identifier.
 *
 * Pure module (no Deno APIs, no remote imports, no network, no Supabase
 * client): Vitest (Node) tests it directly, exactly like the other
 * `_shared` helpers.
 *
 * A pasted identifier is untrusted text, and the classification decides which
 * provider is asked to *authenticate* it. Deciding that a string is a PubMed
 * record because it *contains* PubMed-looking text grants that text an
 * authority it has not earned: `"pubmed.ncbi.nlm.nih.gov"` occurs in
 * `https://notpubmed.ncbi.nlm.nih.gov/123`, in
 * `https://evil.example/?url=https://pubmed.ncbi.nlm.nih.gov/123`, and in
 * `https://pubmed.ncbi.nlm.nih.gov@evil.example/123` — none of which is a
 * PubMed record — and the values that come back are persisted, `pmid` being a
 * per-user deduplication key.
 *
 * Recognition here is therefore structural, and mirrors the semantics already
 * accepted for file imports in `src/lib/pubmedIdentifiers.ts`. Parsing is
 * delegated to the WHATWG `URL` parser and a decision is made only from the
 * parsed `protocol`, `hostname`, and `pathname`:
 *
 *   • `hostname` is compared for exact equality against an explicit host. The
 *     parser lowercases it, so `PUBMED.NCBI.NLM.NIH.GOV` matches without a
 *     manual case fold, while `notpubmed.ncbi.nlm.nih.gov` and
 *     `pubmed.ncbi.nlm.nih.gov.evil.example` do not.
 *   • `hostname` excludes user-info, so the authority-confusion form
 *     `https://pubmed.ncbi.nlm.nih.gov@evil.example/123` resolves to
 *     `evil.example` and is rejected.
 *   • The PMID is read from `pathname` only, so a query string or fragment can
 *     never contribute one.
 *
 * The classifier returns the authenticated PMID with the classification, so a
 * caller never has to re-derive it by running a second, independent pattern
 * over the same untrusted text.
 *
 * Everything fails closed: unparseable text, a non-http(s) scheme, and a
 * scheme-less string such as `pubmed.ncbi.nlm.nih.gov/123` all fall through to
 * the title-search path rather than acquiring PubMed authority. Input is never
 * repaired — no scheme is prepended or guessed, because doing so would invent
 * the very authority this module exists to verify.
 *
 * This module is intentionally a small Edge-runtime-safe equivalent of the
 * frontend helper rather than an import of it: the deployed function and the
 * bundled application are separate runtime/bundling domains. A parity test
 * (`__tests__/identifierDetection.test.ts`) pins the two to the same answers
 * over a shared PubMed corpus so they cannot drift apart silently.
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

/** The only schemes an absolute record URL may use. Compared exactly. */
const RECORD_URL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * A PMID is a bare decimal identifier. No sign, no separator, no prefix or
 * suffix, and no upper bound — NLM assigns them sequentially and a hard length
 * cap would eventually reject valid records.
 */
const PMID_PATTERN = /^\d+$/;

/** The classification of a pasted identifier, with the PMID already proven. */
export type DetectedIdentifier =
  | { type: "pmid"; pmid: string }
  | { type: "pubmed_url"; pmid: string }
  | { type: "doi" }
  | { type: "title" };

/**
 * Validate a value that is *claimed* to be a PMID and return it normalized.
 *
 * @returns The bare digits, or `null` when the value is not a valid PMID.
 */
function normalizePmid(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return PMID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Parse a value into an absolute http(s) `URL`, or `null`.
 *
 * No base URL is supplied, so relative and scheme-relative values
 * (`//pubmed.ncbi.nlm.nih.gov/123`) fail rather than resolving against some
 * ambient origin.
 */
function parseRecordUrl(value: string): URL | null {
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
  return RECORD_URL_PROTOCOLS.has(parsed.protocol) ? parsed : null;
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
export function extractPmidFromPubMedUrl(value: string): string | null {
  const url = parseRecordUrl(value);
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

/**
 * Classify one pasted identifier and, for PubMed records, return the PMID the
 * classification is based on.
 *
 * Order of decision:
 *   1. bare decimal digits → a PMID, as before;
 *   2. the existing direct-DOI rule (`10.` prefix, or a `doi:` prefix in any
 *      case) — deliberately unchanged, since neither form can also be a URL
 *      this function would otherwise recognize;
 *   3. a structurally authenticated PubMed record URL → its PMID;
 *   4. everything else → the title-search path, which is where a value that
 *      merely *looks* like a PubMed URL belongs.
 */
export function detectIdentifier(identifier: string): DetectedIdentifier {
  const trimmed = identifier.trim();

  const pmid = normalizePmid(trimmed);
  if (pmid) return { type: "pmid", pmid };

  if (trimmed.startsWith("10.") || trimmed.toLowerCase().startsWith("doi:")) {
    return { type: "doi" };
  }

  const urlPmid = extractPmidFromPubMedUrl(trimmed);
  if (urlPmid) return { type: "pubmed_url", pmid: urlPmid };

  return { type: "title" };
}
