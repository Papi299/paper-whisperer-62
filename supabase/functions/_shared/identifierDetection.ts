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
 * The same rules authenticate a DOI resolver URL, whose path *is* the DOI name
 * the proxy is being asked to resolve. `https://doi.org/10.1000/example` is a
 * DOI reference; `https://doi.org.evil.example/10.1000/example` and
 * `https://evil.example/?url=https://doi.org/10.1000/example` are not, and the
 * difference is only visible to a parser.
 *
 * The classifier returns the authenticated PMID or DOI with the classification,
 * so a caller never has to re-derive it by running a second, independent
 * pattern over the same untrusted text. That matters as much for the DOI as for
 * the PMID: the provider layer asks Crossref for `works/<encodeURIComponent
 * (DOI)>` and PubMed for `<DOI>[doi]`, so relabelling a resolver URL as a DOI
 * without extracting the DOI from it would merely send the whole URL to a
 * provider that expects a DOI name.
 *
 * Everything fails closed: unparseable text, a non-http(s) scheme, and a
 * scheme-less string such as `pubmed.ncbi.nlm.nih.gov/123` all fall through to
 * the title-search path rather than acquiring PubMed or DOI authority. Input is
 * never repaired — no scheme is prepended or guessed, because doing so would
 * invent the very authority this module exists to verify.
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

/**
 * The DOI proxy hosts, compared exactly against the parsed hostname.
 *
 * `doi.org` is the form the DOI Foundation and Crossref both document as
 * canonical (`https://doi.org/10.xxxx/xxxxx`). `dx.doi.org` is the earlier,
 * no-longer-preferred proxy hostname; both organisations state it keeps
 * resolving, and it still appears in older published references, so a paste of
 * one is a DOI reference exactly as much as a paste of the other. `http:` is
 * accepted for the same reason and by the same rule as PubMed above — the proxy
 * answers it — while the preferred scheme stays `https:`.
 */
const DOI_RESOLVER_HOSTS = new Set(["doi.org", "dx.doi.org"]);

/** The only schemes an absolute record URL may use. Compared exactly. */
const RECORD_URL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * A PMID is a bare decimal identifier. No sign, no separator, no prefix or
 * suffix, and no upper bound — NLM assigns them sequentially and a hard length
 * cap would eventually reject valid records.
 */
const PMID_PATTERN = /^\d+$/;

/**
 * The shape a resolver path must have to be a DOI *name* rather than some other
 * page on the proxy host: the `10.` directory indicator, a registrant code, the
 * `/` that separates prefix from suffix, and a non-empty suffix.
 *
 * This is deliberately the weakest check that distinguishes a DOI from
 * `https://doi.org/`, `https://doi.org/about`, and `https://doi.org/10.1000`
 * — not a DOI grammar validator. The suffix is `.+` because a DOI suffix is
 * opaque and may itself contain `/`; `[^/]+` for the registrant code stops the
 * prefix from swallowing the separator. Nothing here narrows the *direct* DOI
 * forms below, which keep their own long-standing, looser rule.
 */
const DOI_NAME_PATTERN = /^10\.[^/]+\/.+$/s;

/** The classification of a pasted identifier, with the PMID or DOI proven. */
export type DetectedIdentifier =
  | { type: "pmid"; pmid: string }
  | { type: "pubmed_url"; pmid: string }
  | { type: "doi"; doi: string }
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
 * Extract the DOI name from a value written in one of the two *direct* forms:
 * the DOI itself (`10.1000/example`) or a `doi:`-prefixed DOI in any case.
 *
 * The accepted grammar is the long-standing one and is deliberately unchanged
 * — a value beginning `10.` is taken at its word, because the person pasting it
 * is asserting it is a DOI and no URL this module recognizes can also look like
 * that. The only added rule is that `doi:` with nothing after it yields no DOI:
 * the `doi` classification now carries a value, and an empty one is not a DOI
 * the provider layer could do anything with.
 *
 * @returns The DOI name, or `null` when the value is not a direct DOI.
 */
function extractDirectDoi(trimmed: string): string | null {
  if (trimmed.startsWith("10.")) return trimmed;

  if (trimmed.toLowerCase().startsWith("doi:")) {
    const doi = trimmed.slice("doi:".length).trim();
    return doi.length > 0 ? doi : null;
  }

  return null;
}

/**
 * Extract the DOI a resolver URL refers to.
 *
 * Accepts `https://doi.org/<DOI>` and the legacy `dx.doi.org` proxy hostname,
 * over either http(s) scheme, with any query string or fragment.
 *
 * The DOI is read from `pathname` only, so neither a query nor a fragment can
 * supply or replace it, and it is taken as the *whole* path rather than its
 * first segment: a DOI suffix is opaque and may contain further `/` characters,
 * which `https://doi.org/10.1000/a/b` genuinely names. Nothing else is trimmed
 * off either — the proxy treats the path verbatim as the DOI name (a trailing
 * slash makes `10.1000/182/`, a different name, which is why the resolver
 * answers 404 for it), so silently repairing one here would resolve a DOI the
 * user did not paste.
 *
 * The path is percent-decoded exactly once. `pathname` is still URL-encoded,
 * while the DOI name is not, and the provider layer encodes it again on the way
 * out (`encodeURIComponent` for Crossref, the PubMed `[doi]` term for
 * E-utilities). Returning the encoded path would therefore double-escape every
 * reserved character a suffix contains. A malformed escape is not a DOI and
 * fails closed rather than being passed on half-decoded.
 *
 * @returns The DOI name, or `null` when the value is not a DOI resolver URL.
 */
export function extractDoiFromDoiUrl(value: string): string | null {
  const url = parseRecordUrl(value);
  if (!url) return null;

  if (!DOI_RESOLVER_HOSTS.has(url.hostname)) return null;

  // `pathname` always begins with `/` on a hierarchical URL; everything after
  // that first separator is the DOI name the proxy was asked to resolve.
  const encodedDoi = url.pathname.slice(1);
  if (!encodedDoi) return null;

  let doi: string;
  try {
    doi = decodeURIComponent(encodedDoi);
  } catch {
    return null;
  }

  return DOI_NAME_PATTERN.test(doi) ? doi : null;
}

/**
 * Classify one pasted identifier and return the PMID or DOI the classification
 * is based on.
 *
 * Order of decision:
 *   1. bare decimal digits → a PMID, as before;
 *   2. the existing direct-DOI rule (`10.` prefix, or a `doi:` prefix in any
 *      case) — neither form can also be a URL this function would otherwise
 *      recognize, so it stays first among the DOI rules;
 *   3. a structurally authenticated PubMed record URL → its PMID;
 *   4. a structurally authenticated DOI resolver URL → its DOI;
 *   5. everything else → the title-search path, which is where a value that
 *      merely *looks* like a PubMed or DOI URL belongs.
 */
export function detectIdentifier(identifier: string): DetectedIdentifier {
  const trimmed = identifier.trim();

  const pmid = normalizePmid(trimmed);
  if (pmid) return { type: "pmid", pmid };

  const directDoi = extractDirectDoi(trimmed);
  if (directDoi) return { type: "doi", doi: directDoi };

  const urlPmid = extractPmidFromPubMedUrl(trimmed);
  if (urlPmid) return { type: "pubmed_url", pmid: urlPmid };

  const urlDoi = extractDoiFromDoiUrl(trimmed);
  if (urlDoi) return { type: "doi", doi: urlDoi };

  return { type: "title" };
}
