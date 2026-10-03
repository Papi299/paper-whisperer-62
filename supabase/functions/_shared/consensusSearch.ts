/**
 * Consensus discovery search — request validation, Consensus URL construction,
 * upstream failure classification and defensive response parsing.
 *
 * Pure module (no Deno APIs, no remote imports, no network, no Supabase
 * client): Vitest (Node) tests it directly, exactly like `pubmedSearch.ts`.
 * `search-consensus/handler.ts` owns the request path and injects the network;
 * everything that decides *what a Consensus answer means* lives here.
 *
 * ## The upstream contract this module targets
 *
 * `GET https://api.consensus.app/v1/search`, authenticated with an
 * `x-api-key` header. Consensus's documentation names this "the supported
 * endpoint for searching academic papers"; `/v1/quick_search` is the legacy
 * path, "deprecated and will be removed on 2027-02-07", and the official
 * `Consensus-NLP/consensus-api` README states that `/v1/search` "is the same
 * contract: update the path and you are done". `query` is the only required
 * parameter, and `page_size` defaults to 20, the Free plan's maximum. Sources
 * and the evidence recorded for this choice are in the PR that introduced this
 * file and in `docs/deployment.md`.
 *
 * ## What this module is NOT
 *
 * A Consensus search result is a **discovery** representation and nothing more.
 * It exists so the owner can decide which papers to import. None of its display
 * fields — title, authors, journal, year, abstract, citation count, study type,
 * takeaway — ever becomes persisted paper metadata. The only value that may
 * cross into the library is `importDoi`, a DOI name this module has validated,
 * and it crosses through the existing canonical importer
 * (`fetch-paper-metadata` → PubMed/Crossref provenance checks → normalization →
 * duplicate handling → `safe_bulk_insert_papers`), which fetches the
 * authoritative record itself. Consensus is a discovery source, not a metadata
 * authority.
 *
 * Values are rendered as plain React text by the panel. No upstream string is
 * ever placed in `dangerouslySetInnerHTML`, and no upstream URL is rendered
 * unless {@link toSafeConsensusUrl} accepted it.
 */

import { detectIdentifier } from "./identifierDetection.ts";

// ── Bounds and constants ──────────────────────────────────────────────────

/** The one upstream endpoint this function may call. Never caller-supplied. */
export const CONSENSUS_SEARCH_ENDPOINT = "https://api.consensus.app/v1/search";

/**
 * Results requested per search, and the most this function will ever forward.
 *
 * Consensus documents 20 as both the `page_size` default and the Free plan's
 * maximum ("Max papers per request (`page_size`) | 20"). The server owns this
 * value: the browser contract has no page-size field at all, so a client cannot
 * ask for 100 or 200 and silently spend a larger plan's allowance.
 */
export const CONSENSUS_SEARCH_PAGE_SIZE = 20;

/**
 * Maximum accepted trimmed query length — PaperLume's own bound.
 *
 * Consensus documents no query-length limit. 500 characters matches the bound
 * `search-pubmed` and the canonical importer already enforce on external input,
 * which leaves generous room for a natural-language research question while
 * keeping one search a predictable, bounded request.
 */
export const CONSENSUS_SEARCH_MAX_QUERY_LENGTH = 500;

/**
 * Longest DOI this module will hand to the importer: the importer's own
 * per-identifier bound (`fetch-paper-metadata` refuses anything longer than 500
 * characters), so nothing accepted here can be refused there for its length.
 */
export const CONSENSUS_IMPORT_DOI_MAX_LENGTH = 500;

/** Longest Consensus paper URL this module will consider at all. */
export const CONSENSUS_URL_MAX_LENGTH = 2048;

/**
 * Hosts a rendered "Open in Consensus" link may point at. Exactly the host
 * every audited result used (`https://consensus.app/papers/<slug>/<id>/`) and
 * the host Consensus's own documentation shows.
 */
const CONSENSUS_URL_HOSTS: ReadonlySet<string> = new Set(["consensus.app"]);

/** The path every audited and documented paper URL lives under. */
const CONSENSUS_PAPER_PATH_PREFIX = "/papers/";

/**
 * The structural shape of a DOI *name*: the `10.` directory indicator, a
 * registrant code, the `/` separator and a non-empty suffix. The same pattern
 * `identifierDetection.ts` and `src/lib/doiIdentifiers.ts` use to tell a DOI
 * name from a merely `10.`-prefixed string.
 */
const DOI_NAME_PATTERN = /^10\.[^/]+\/.+$/s;

/**
 * Code points an importable DOI may not contain: any whitespace, C0/C1 control
 * characters, format characters (zero-width joiners, BOM, bidirectional
 * overrides that could make a displayed DOI read differently from the one that
 * is imported) and lone surrogates. The DOI Handbook permits a wide repertoire
 * in a suffix, but this value is untrusted upstream data on its way into the
 * library, so the boundary only ever narrows.
 */
const DISALLOWED_DOI_CODE_POINTS = /[\s\p{Cc}\p{Cf}\p{Cs}]/u;

/**
 * The documented text of Consensus's monthly-allowance 429 ("`429` 'used all
 * included searches' | Monthly calls used up"). Any other 429 — including the
 * documented "Too many requests" per-second limit — is treated as rate
 * limiting, which tells the owner to wait rather than that the month is spent.
 */
const MONTHLY_ALLOWANCE_429_TEXT = "used all included searches";

// ── Public types ──────────────────────────────────────────────────────────

/**
 * One Consensus result as the discovery UI shows it. Application-owned: raw
 * Consensus JSON is never forwarded to the browser, so an upstream shape change
 * — or an upstream field PaperLume never asked for — cannot reach the client.
 *
 * Every display field is optional and becomes `null`/empty when the upstream
 * value is absent or malformed. The audited live response omits optional
 * fields entirely rather than sending `null`, so absence is the normal case.
 */
export interface ConsensusSearchResult {
  /**
   * 1-based position in Consensus's relevance order. A per-response identity
   * for rendering only: it is not a Consensus identifier, is never imported and
   * never leaves the dialog.
   */
  rank: number;
  title: string | null;
  /** Display-only. The canonical import retrieves the real authors. */
  authors: string[];
  journal: string | null;
  year: number | null;
  abstract: string | null;
  citationCount: number | null;
  /** Consensus's own study-design label, e.g. `"rct"`. Display-only. */
  studyType: string | null;
  /** Consensus-generated one-line summary. Display-only, labelled as such. */
  takeaway: string | null;
  /** A link to the paper on consensus.app, present only when it validated. */
  consensusUrl: string | null;
  /**
   * THE ONLY IMPORT AUTHORITY. A DOI name in Consensus's original spelling,
   * present only when {@link toImportDoi} accepted it. `null` means the result
   * is discovery-only and cannot be selected for import.
   */
  importDoi: string | null;
}

/** One search's answer. There is deliberately no page, total or cursor. */
export interface ConsensusSearchPage {
  results: ConsensusSearchResult[];
}

/** A validated search request. Carries no caller identity — by construction. */
export interface ValidatedConsensusSearchRequest {
  query: string;
}

export type ConsensusSearchRequestValidation =
  | { ok: true; request: ValidatedConsensusSearchRequest }
  | { ok: false; message: string };

export type ConsensusSearchParse =
  /** `dropped` counts entries that were not usable records. Logged as a count only. */
  | { ok: true; results: ConsensusSearchResult[]; dropped: number }
  | { ok: false; reason: "malformed" };

/**
 * How a non-2xx Consensus answer is classified. A bounded label set: the
 * upstream body itself is never carried past {@link classifyConsensusFailure}.
 */
export type ConsensusUpstreamFailure =
  /** 401 — missing, invalid or revoked key. A server configuration problem. */
  | "upstream_auth"
  /** 402 — the Consensus account's billing is past due. */
  | "upstream_billing"
  /** 403 — e.g. `feature_not_allowed`; this function never requests a paid feature. */
  | "upstream_forbidden"
  /** 429 "used all included searches" — the monthly allowance is spent. */
  | "quota_exhausted"
  /** Any other 429, including the documented one-request-per-second limit. */
  | "rate_limited"
  /** 5xx. */
  | "upstream_error"
  /** Any other non-2xx, e.g. a 400/404/422 this request should never earn. */
  | "upstream_rejected";

// ── Request validation ────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The complete browser contract. Anything else in a request body is refused. */
const REQUEST_FIELDS: ReadonlySet<string> = new Set(["query"]);

/**
 * Validate an untrusted request body into exactly one value: the query.
 *
 * The contract is **closed**. A body carrying any field other than `query` is
 * refused outright rather than having the extra field ignored, so `page`,
 * `page_size`, `include_full_text_chunks`, an endpoint, a URL, a user id or a
 * role can never ride along — not even inertly — and a client that drifts out
 * of step with this contract fails loudly instead of believing a filter was
 * applied. The handler derives the caller from the bearer token alone, and the
 * upstream URL is built from constants plus this one validated string.
 *
 * The natural-language query is not rewritten: only leading/trailing
 * whitespace is removed, and {@link buildConsensusSearchUrl} percent-encodes it
 * exactly once.
 */
export function validateConsensusSearchRequest(body: unknown): ConsensusSearchRequestValidation {
  if (!isRecord(body)) {
    return { ok: false, message: "A JSON request body is required." };
  }

  for (const field of Object.keys(body)) {
    if (!REQUEST_FIELDS.has(field)) {
      // The field name is not echoed: it is caller-controlled text of any length.
      return { ok: false, message: "The request contains an unsupported field." };
    }
  }

  const rawQuery = body.query;
  if (typeof rawQuery !== "string") {
    return { ok: false, message: "query is required." };
  }
  const query = rawQuery.trim();
  if (query.length === 0) {
    return { ok: false, message: "query is required." };
  }
  if (query.length > CONSENSUS_SEARCH_MAX_QUERY_LENGTH) {
    return {
      ok: false,
      message: `query is too long (max ${CONSENSUS_SEARCH_MAX_QUERY_LENGTH} characters).`,
    };
  }

  return { ok: true, request: { query } };
}

// ── URL construction ──────────────────────────────────────────────────────

/**
 * Build the one upstream URL a search may use.
 *
 * Exactly two parameters: the query and `page_size=20`. No `page` (the first
 * page is Consensus's default, and any later page is a paid-plan feature and a
 * second deliberate call), no filters, no `include_full_text_chunks` (a paid
 * feature that would earn a 403 on the Free plan), no semantic score. Built
 * with `URL`/`URLSearchParams`, so the query is percent-encoded once.
 *
 * The API key is NOT part of the URL. It travels in the `x-api-key` header
 * only, which is why this URL may contain the query but never a credential.
 */
export function buildConsensusSearchUrl(query: string): string {
  const url = new URL(CONSENSUS_SEARCH_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("page_size", String(CONSENSUS_SEARCH_PAGE_SIZE));
  return url.toString();
}

// ── The DOI boundary ──────────────────────────────────────────────────────

/**
 * Accept a Consensus `doi` value as an importable DOI, or return `null`.
 *
 * This is the single gate between Consensus discovery and the library. A value
 * passes only when ALL of these hold:
 *
 * 1. it is a string of at most {@link CONSENSUS_IMPORT_DOI_MAX_LENGTH}
 *    characters;
 * 2. it contains no whitespace, control, format or lone-surrogate code point;
 * 3. it is structurally a DOI *name* (`10.<registrant>/<non-empty suffix>`) —
 *    `"10.1000"` alone is refused here, although the importer's looser direct
 *    rule would take it;
 * 4. PaperLume's own Edge identifier logic (`detectIdentifier`, the classifier
 *    the canonical importer runs) recognizes it as a DOI **and** extracts
 *    exactly the same string — so the importer is guaranteed to route it down
 *    its DOI path unchanged.
 *
 * Together, rules 3 and 4 accept only the bare form. `doi:10.1000/x` and
 * `https://doi.org/10.1000/x` already fail rule 3; rule 4 is the backstop if
 * that pattern is ever loosened, because both classify as DOIs but extract a
 * *different* string, and accepting them would mean rewriting upstream data.
 * Rule 3 is load-bearing on its own: without it, the importer's looser direct
 * rule would take a suffix-less `"10.1000"` (a mutation control pins this).
 *
 * Nothing is repaired: no trimming, no case change, no unescaping, no prefix
 * stripping, no Crossref title lookup, no inference from the title or abstract,
 * and Consensus's internal paper id is never a substitute. The original
 * spelling is returned untouched — DOI equivalence (ASCII case-folding) is a
 * comparison concern handled by `doiEquivalenceKey`, not a reason to alter the
 * value that is imported.
 */
export function toImportDoi(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > CONSENSUS_IMPORT_DOI_MAX_LENGTH) return null;
  if (DISALLOWED_DOI_CODE_POINTS.test(value)) return null;
  if (!DOI_NAME_PATTERN.test(value)) return null;

  const detected = detectIdentifier(value);
  if (detected.type !== "doi" || detected.doi !== value) return null;

  return value;
}

// ── The link boundary ─────────────────────────────────────────────────────

/**
 * Accept a Consensus `url` value as a safe "Open in Consensus" link, or
 * return `null`.
 *
 * Parsed, never pattern-matched: the value must be an absolute `https:` URL
 * whose host is exactly `consensus.app`, with no credentials, no explicit port,
 * and a path under `/papers/`. So `https://consensus.app.evil.example/…`,
 * `https://evil.example/?u=https://consensus.app/papers/x`, `javascript:` and
 * `http:` links are all refused. The returned value is the parser's normalized
 * `href`, never the raw upstream string.
 */
export function toSafeConsensusUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > CONSENSUS_URL_MAX_LENGTH) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (!CONSENSUS_URL_HOSTS.has(url.hostname)) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  if (!url.pathname.startsWith(CONSENSUS_PAPER_PATH_PREFIX)) return null;

  return url.href;
}

// ── Response parsing ──────────────────────────────────────────────────────

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const item = nonEmptyString(entry);
    if (item) items.push(item);
  }
  return items;
}

/** A four-digit publication year, or `null`. Same plausibility bound as PubMed. */
function publicationYear(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value >= 1000 && value <= 9999 ? value : null;
}

/** A non-negative integer count, or `null`. Never a displayed `NaN`. */
function nonNegativeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value >= 0 ? value : null;
}

/**
 * Map one upstream result onto the discovery shape.
 *
 * Reads exactly the fields the live audit observed and Consensus documents —
 * `title`, `authors`, `journal_name`, `publish_year`, `abstract`,
 * `citation_count`, `study_type`, `takeaway`, `url`, `doi` — and copies
 * nothing else. Every other upstream field (institutions, countries, sample
 * size, SJR quartile, preprint flag, full-text chunks, anything added later) is
 * dropped here and never reaches the browser.
 */
function mapConsensusResult(entry: Record<string, unknown>, rank: number): ConsensusSearchResult {
  return {
    rank,
    title: nonEmptyString(entry.title),
    authors: stringList(entry.authors),
    journal: nonEmptyString(entry.journal_name),
    year: publicationYear(entry.publish_year),
    abstract: nonEmptyString(entry.abstract),
    citationCount: nonNegativeCount(entry.citation_count),
    studyType: nonEmptyString(entry.study_type),
    takeaway: nonEmptyString(entry.takeaway),
    consensusUrl: toSafeConsensusUrl(entry.url),
    importDoi: toImportDoi(entry.doi),
  };
}

/**
 * Parse a Consensus `/v1/search` payload into discovery results, in
 * Consensus's relevance order.
 *
 * The envelope must be an object with a `results` array — anything else is a
 * payload this module cannot trust, reported as `malformed` and never shown as
 * an empty result list. Inside a valid envelope, one bad entry never sinks the
 * page: a non-object entry, or a record with nothing to show or act on (no
 * title, no importable DOI and no safe link), is dropped and counted, and every
 * other entry is mapped field by field. No more than one page
 * ({@link CONSENSUS_SEARCH_PAGE_SIZE}) is ever forwarded, whatever arrives.
 *
 * A zero-result answer (`results: []`) is a valid answer, not a failure.
 */
export function parseConsensusSearchResponse(payload: unknown): ConsensusSearchParse {
  if (!isRecord(payload)) return { ok: false, reason: "malformed" };

  const rawResults = payload.results;
  if (!Array.isArray(rawResults)) return { ok: false, reason: "malformed" };

  const results: ConsensusSearchResult[] = [];
  let dropped = 0;
  for (const entry of rawResults) {
    if (results.length >= CONSENSUS_SEARCH_PAGE_SIZE || !isRecord(entry)) {
      dropped++;
      continue;
    }
    const result = mapConsensusResult(entry, results.length + 1);
    if (result.title === null && result.importDoi === null && result.consensusUrl === null) {
      dropped++;
      continue;
    }
    results.push(result);
  }

  return { ok: true, results, dropped };
}

// ── Upstream failure classification ───────────────────────────────────────

/**
 * Classify a non-2xx Consensus response into a bounded label.
 *
 * Only the documented statuses are distinguished. A 429 is the monthly
 * allowance only when its body carries Consensus's documented phrase; every
 * other 429 is per-second rate limiting. The body is consulted for that one
 * phrase and is then discarded — it is never logged, returned or stored.
 *
 * @param status   The upstream HTTP status (never 2xx here).
 * @param bodyText A bounded prefix of the response body; only read for 429s.
 */
export function classifyConsensusFailure(status: number, bodyText: string): ConsensusUpstreamFailure {
  if (status === 401) return "upstream_auth";
  if (status === 402) return "upstream_billing";
  if (status === 403) return "upstream_forbidden";
  if (status === 429) {
    return bodyText.toLowerCase().includes(MONTHLY_ALLOWANCE_429_TEXT) ? "quota_exhausted" : "rate_limited";
  }
  if (status >= 500) return "upstream_error";
  return "upstream_rejected";
}
