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
 * ## Advanced filters (CONSENSUS-ADVANCED-FILTERS-001A)
 *
 * A search may also carry four optional, server-validated restrictions —
 * publication years, study designs, human studies only and no preprints —
 * which become Consensus's documented `year_min`, `year_max`, `study_types`,
 * `human` and `exclude_preprints` parameters. The browser names none of them
 * directly: it sends PaperLume's own field names, every value is checked here
 * against PaperLume's bounds and a frozen study-design allowlist, and only a
 * restriction that is actually set reaches the upstream URL. Consensus applies
 * the filters; nothing in this module removes, hides or re-orders a result.
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

// ── Advanced-filter vocabulary and bounds ─────────────────────────────────

/**
 * The study designs a search may be restricted to: a frozen allowlist of
 * Consensus `study_types` values, each spelled exactly as Consensus documents
 * it for `GET /v1/search`, in the order they are sent upstream.
 *
 * A value is listed only when its exact REST spelling appears in at least two
 * official Consensus sources, at least one of them a REST source, and no
 * official source spells that design differently:
 *
 * - `rct` and `meta-analysis` — the `Consensus-NLP/consensus-api` README's
 *   request examples (`study_types=rct,meta-analysis`) and filter table, the
 *   docs' search quick start, REST examples in the docs' use cases, and the
 *   values the official MCP search tool documents;
 * - `systematic review` — the README filter table, REST examples in the docs'
 *   use cases, and the MCP values;
 * - `cohort study` — the README filter table and REST examples in the docs'
 *   use cases.
 *
 * Every other design stays out until its REST value is established:
 * `literature review` and `case report` appear only in the MCP list; the
 * non-randomized experimental design is spelled `non-rct experimental` there
 * but `non-randomized experimental study` in a REST example; `animal` and
 * `non-rct in vitro` are preclinical designs outside this filter's purpose; and
 * the web app's 19 display labels are not API values ("Longitudinal / panel
 * study" is `longitudinal / panel data study` in a REST example). Values are
 * matched exactly: no trimming, case-folding or alias is ever applied.
 */
export const CONSENSUS_STUDY_TYPES = Object.freeze(["rct", "meta-analysis", "systematic review", "cohort study"] as const);

export type ConsensusStudyType = (typeof CONSENSUS_STUDY_TYPES)[number];

/**
 * The earliest publication year a filter may name. PaperLume's own sanity
 * floor, not a Consensus limit — Consensus documents none. It refuses an
 * obviously mistyped year before it can spend a call.
 */
export const CONSENSUS_FILTER_MIN_YEAR = 1900;

/**
 * The latest publication year a filter may name: the current UTC year plus one,
 * because journals routinely date an issue ahead of the calendar. Also
 * PaperLume's own bound; a later year could only ever match nothing.
 */
export function consensusFilterMaxYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

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

/**
 * The restrictions a validated search applies. Only a restriction that is set
 * is present: an unset or `false` boolean and an empty study-design list are
 * all "no restriction", so they never appear here — and never reach the URL.
 */
export interface ConsensusSearchFilters {
  yearMin?: number;
  yearMax?: number;
  /** Allowlisted, unique, in {@link CONSENSUS_STUDY_TYPES} order. Never empty. */
  studyTypes?: readonly ConsensusStudyType[];
  human?: true;
  excludePreprints?: true;
}

/**
 * A validated search request. Carries no caller identity — by construction. An
 * unfiltered request is exactly `{ query }`, the V1 shape.
 */
export interface ValidatedConsensusSearchRequest extends ConsensusSearchFilters {
  query: string;
}

export type ConsensusSearchRequestValidation =
  | { ok: true; request: ValidatedConsensusSearchRequest }
  | { ok: false; message: string };

export type ConsensusSearchParse =
  /**
   * `dropped` counts entries that were not usable records. `preprints` counts
   * forwarded records Consensus flagged `is_preprint: true`. Both are logged as
   * counts only; neither changes what is forwarded.
   */
  | { ok: true; results: ConsensusSearchResult[]; dropped: number; preprints: number }
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
  /** 403 on an unfiltered search — e.g. `feature_not_allowed`; this function never requests a paid feature. */
  | "upstream_forbidden"
  /**
   * 403 on a filtered search: Consensus refused a request whose only additions
   * are the owner's filters — most plausibly a plan restriction on them.
   */
  | "filters_not_allowed"
  /** 400 or 422 on a filtered search: Consensus did not accept the filters it was sent. */
  | "filters_rejected"
  /** 429 "used all included searches" — the monthly allowance is spent. */
  | "quota_exhausted"
  /** Any other 429, including the documented one-request-per-second limit. */
  | "rate_limited"
  /** 5xx. */
  | "upstream_error"
  /** Any other non-2xx, e.g. a 400/404/422 an unfiltered request should never earn. */
  | "upstream_rejected";

// ── Request validation ────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The complete browser contract: the query and PaperLume's four filter
 * categories, under PaperLume's own names. Anything else is refused.
 */
const REQUEST_FIELDS: ReadonlySet<string> = new Set([
  "query",
  "yearMin",
  "yearMax",
  "studyTypes",
  "human",
  "excludePreprints",
]);

/**
 * Read a field only if the body itself carries it. A parsed JSON object owns
 * every field it sent; a value inherited from a (polluted) prototype is never a
 * caller's filter.
 */
function ownField(body: Record<string, unknown>, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(body, field) ? body[field] : undefined;
}

function isConsensusStudyType(value: unknown): value is ConsensusStudyType {
  return typeof value === "string" && (CONSENSUS_STUDY_TYPES as readonly string[]).includes(value);
}

const STUDY_TYPES_MESSAGE = "studyTypes must be a list of supported study designs.";

/**
 * Validate an untrusted request body into the query and the filters it sets.
 *
 * The contract is **closed**. A body carrying any field other than `query`,
 * `yearMin`, `yearMax`, `studyTypes`, `human` and `excludePreprints` is refused
 * outright rather than having the extra field ignored, so `page`, `page_size`,
 * `include_full_text_chunks`, a Consensus parameter name such as `year_min`,
 * an endpoint, a URL, a user id or a role can never ride along — not even
 * inertly — and a client that drifts out of step with this contract fails
 * loudly instead of believing a filter was applied. The handler derives the
 * caller from the bearer token alone, and the upstream URL is built from
 * constants plus these validated values.
 *
 * The natural-language query is not rewritten: only leading/trailing
 * whitespace is removed, and {@link buildConsensusSearchUrl} percent-encodes it
 * exactly once. Each filter, when present, must be exactly right — nothing is
 * coerced, trimmed, rounded, case-folded or de-duplicated on the caller's
 * behalf:
 *
 * - `yearMin` / `yearMax` — integers from {@link CONSENSUS_FILTER_MIN_YEAR} to
 *   {@link consensusFilterMaxYear}, either one alone, and `yearMin <= yearMax`
 *   when both are set;
 * - `studyTypes` — an array of distinct {@link CONSENSUS_STUDY_TYPES} values;
 *   empty means no restriction, and the accepted set is put in allowlist order;
 * - `human` / `excludePreprints` — real booleans; `false` means no restriction.
 *
 * No message echoes a submitted value: each is a fixed sentence naming the
 * field, so caller-controlled text never reaches a response.
 *
 * @param options.now The clock the year ceiling is read from. Tests pin it.
 */
export function validateConsensusSearchRequest(
  body: unknown,
  options: { now?: Date } = {},
): ConsensusSearchRequestValidation {
  if (!isRecord(body)) {
    return { ok: false, message: "A JSON request body is required." };
  }

  for (const field of Object.keys(body)) {
    if (!REQUEST_FIELDS.has(field)) {
      // The field name is not echoed: it is caller-controlled text of any length.
      return { ok: false, message: "The request contains an unsupported field." };
    }
  }

  const rawQuery = ownField(body, "query");
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

  const request: ValidatedConsensusSearchRequest = { query };

  const maxYear = consensusFilterMaxYear(options.now);
  for (const field of ["yearMin", "yearMax"] as const) {
    const value = ownField(body, field);
    if (value === undefined) continue;
    // `Number.isInteger` refuses fractions, NaN and ±Infinity; a string, a
    // boolean or null is not a number at all.
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < CONSENSUS_FILTER_MIN_YEAR ||
      value > maxYear
    ) {
      return { ok: false, message: `${field} must be a whole year from ${CONSENSUS_FILTER_MIN_YEAR} to ${maxYear}.` };
    }
    request[field] = value;
  }
  if (request.yearMin !== undefined && request.yearMax !== undefined && request.yearMin > request.yearMax) {
    return { ok: false, message: "yearMin must not be later than yearMax." };
  }

  const rawStudyTypes = ownField(body, "studyTypes");
  if (rawStudyTypes !== undefined) {
    // Bounded before it is walked: a list longer than the allowlist cannot be
    // a set of distinct allowlisted values.
    if (!Array.isArray(rawStudyTypes) || rawStudyTypes.length > CONSENSUS_STUDY_TYPES.length) {
      return { ok: false, message: STUDY_TYPES_MESSAGE };
    }
    const selected = new Set<ConsensusStudyType>();
    for (const entry of rawStudyTypes) {
      if (!isConsensusStudyType(entry)) return { ok: false, message: STUDY_TYPES_MESSAGE };
      if (selected.has(entry)) return { ok: false, message: "studyTypes must not repeat a study design." };
      selected.add(entry);
    }
    if (selected.size > 0) {
      request.studyTypes = CONSENSUS_STUDY_TYPES.filter((type) => selected.has(type));
    }
  }

  for (const field of ["human", "excludePreprints"] as const) {
    const value = ownField(body, field);
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      return { ok: false, message: `${field} must be true or false.` };
    }
    if (value) request[field] = true;
  }

  return { ok: true, request };
}

// ── URL construction ──────────────────────────────────────────────────────

/**
 * The Consensus parameters a filter set sends, in URL order — the single
 * place PaperLume's filter names become Consensus's documented ones:
 *
 * | PaperLume          | Consensus           | Sent when                                |
 * |--------------------|---------------------|------------------------------------------|
 * | `yearMin`          | `year_min`          | set                                      |
 * | `yearMax`          | `year_max`          | set                                      |
 * | `studyTypes`       | `study_types`       | non-empty; one parameter per design      |
 * | `human`            | `human`             | `true` (as the string `true`)            |
 * | `excludePreprints` | `exclude_preprints` | `true` (as the string `true`)            |
 *
 * `study_types` repeats, once per design, in the order given — allowlist order
 * for a validated request: `study_types=rct&study_types=meta-analysis`.
 * Consensus's typed OpenAPI 3.1 schema declares `study_types` an array of enum
 * values and sets no `style` or `explode`, so the specification's defaults
 * apply: a query parameter is `form`, and a `form` array is exploded into one
 * parameter per item. The official README's examples instead send one
 * comma-separated value (`study_types=rct,meta-analysis`); that form drew HTTP
 * 422 twice in the 2026-10-10 pre-merge canary, while one design alone was
 * accepted. The repeated form drew HTTP 200 for `rct` + `meta-analysis` with a
 * year range in the 2026-10-10 canary of the deployed v3. That shows Consensus
 * accepted the request; whether every result is one of those designs is not
 * independently verified, and other design combinations are untested — see
 * docs/deployment.md §7f.
 */
function consensusFilterParams(filters: ConsensusSearchFilters): Array<[name: string, value: string]> {
  const params: Array<[string, string]> = [];
  if (filters.yearMin !== undefined) params.push(["year_min", String(filters.yearMin)]);
  if (filters.yearMax !== undefined) params.push(["year_max", String(filters.yearMax)]);
  for (const studyType of filters.studyTypes ?? []) params.push(["study_types", studyType]);
  if (filters.human === true) params.push(["human", "true"]);
  if (filters.excludePreprints === true) params.push(["exclude_preprints", "true"]);
  return params;
}

/**
 * The names — never the values — of the Consensus parameters a filter set
 * sends, each once, in URL order: a repeated `study_types` is named once. Empty
 * for an unfiltered search. The log line records these, and the handler uses
 * them to tell a filtered search from a plain one.
 */
export function consensusFilterParamNames(filters: ConsensusSearchFilters): string[] {
  return [...new Set(consensusFilterParams(filters).map(([name]) => name))];
}

/**
 * Build the one upstream URL a search may use.
 *
 * The query and `page_size=20`, then only the filter parameters the validated
 * request actually sets — so an unfiltered search builds exactly the V1 URL.
 * No `page` (the first page is Consensus's default, and any later page is a
 * paid-plan feature and a second deliberate call), no
 * `include_full_text_chunks` (a paid feature that would earn a 403 on the Free
 * plan), no semantic score, and no parameter a caller could name: every name
 * here is a constant. Built with `URL`/`URLSearchParams`, so the query and
 * every filter value are percent-encoded once.
 *
 * The API key is NOT part of the URL. It travels in the `x-api-key` header
 * only, which is why this URL may contain the query but never a credential.
 */
export function buildConsensusSearchUrl(query: string, filters: ConsensusSearchFilters = {}): string {
  const url = new URL(CONSENSUS_SEARCH_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("page_size", String(CONSENSUS_SEARCH_PAGE_SIZE));
  // `append`, never `set`: `study_types` repeats, and `set` would keep only
  // the last design.
  for (const [name, value] of consensusFilterParams(filters)) {
    url.searchParams.append(name, value);
  }
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
 *
 * `preprints` counts the forwarded records whose `is_preprint` is exactly
 * `true` — a diagnostic for the log line, which lets one authorized canary show
 * whether an `exclude_preprints` search came back free of preprints. The flag
 * itself is still never forwarded.
 */
export function parseConsensusSearchResponse(payload: unknown): ConsensusSearchParse {
  if (!isRecord(payload)) return { ok: false, reason: "malformed" };

  const rawResults = payload.results;
  if (!Array.isArray(rawResults)) return { ok: false, reason: "malformed" };

  const results: ConsensusSearchResult[] = [];
  let dropped = 0;
  let preprints = 0;
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
    if (entry.is_preprint === true) preprints++;
  }

  return { ok: true, results, dropped, preprints };
}

/**
 * How many forwarded results report a publication year outside the requested
 * range, or `null` when the search set no year filter.
 *
 * A diagnostic for the log line only — it lets one authorized canary show
 * whether Consensus honoured the range. Nothing is removed, hidden or
 * re-ordered, and a result without a year is not counted.
 */
export function countResultsOutsideYearRange(
  results: readonly ConsensusSearchResult[],
  filters: ConsensusSearchFilters,
): number | null {
  const { yearMin, yearMax } = filters;
  if (yearMin === undefined && yearMax === undefined) return null;
  return results.filter(
    (result) =>
      result.year !== null &&
      ((yearMin !== undefined && result.year < yearMin) || (yearMax !== undefined && result.year > yearMax)),
  ).length;
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
 * A filtered search is told apart only where the filters are the likely cause:
 * a 403 becomes `filters_not_allowed` (Consensus documents `403
 * feature_not_allowed` as its plan-restriction answer, and the only thing such
 * a request adds to a plain search is its filters), and a 400 or 422 becomes
 * `filters_rejected`. Credentials (401), billing (402), the allowance and rate
 * limits (429) and server failures (5xx) mean the same with or without filters.
 *
 * @param status   The upstream HTTP status (never 2xx here).
 * @param bodyText A bounded prefix of the response body; only read for 429s.
 * @param filtered Whether the request carried any filter parameter.
 */
export function classifyConsensusFailure(status: number, bodyText: string, filtered = false): ConsensusUpstreamFailure {
  if (status === 401) return "upstream_auth";
  if (status === 402) return "upstream_billing";
  if (status === 403) return filtered ? "filters_not_allowed" : "upstream_forbidden";
  if (status === 429) {
    return bodyText.toLowerCase().includes(MONTHLY_ALLOWANCE_429_TEXT) ? "quota_exhausted" : "rate_limited";
  }
  if (status >= 500) return "upstream_error";
  if (filtered && (status === 400 || status === 422)) return "filters_rejected";
  return "upstream_rejected";
}
