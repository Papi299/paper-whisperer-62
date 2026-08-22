/**
 * PubMed discovery search — request validation, NCBI URL construction, and
 * upstream response parsing.
 *
 * Pure module (no Deno APIs, no remote imports, no network, no Supabase
 * client): Vitest (Node) tests it directly, exactly like the other `_shared`
 * helpers. `search-pubmed/handler.ts` owns the request path and injects the
 * network; everything that decides *what a PubMed answer means* lives here.
 *
 * ## What this module is NOT
 *
 * A PubMed search result is a **discovery** representation and nothing more.
 * It exists so a researcher can decide which records to import. It never
 * becomes persisted paper metadata: the selected PMIDs are handed to the
 * existing canonical identifier importer, which fetches the authoritative
 * record through `fetch-paper-metadata` (EFetch) and owns normalization,
 * authorship provenance, publication types, keywords and deduplication. Nothing
 * produced here may be written to `papers` or to any pool.
 *
 * ## Values are already decoded — do not decode them again
 *
 * `_shared/htmlEntities.ts` exists because PubMed's **EFetch XML** carries HTML
 * entities. The **ESummary JSON** used here does not: measured on 2026-08-22
 * across 128 live records (five queries, including entity-prone journal titles
 * and Greek letters), zero titles contained `&` or `<`, `TNF-α` arrived as the
 * real code point, and `Alzheimer's & dementia …` arrived with a literal `&`
 * and `'` rather than `&amp;` / `&apos;`. Running the decoder over this payload
 * would be a second decode pass over already-decoded text — exactly the
 * double-decode that turns a legitimate literal into markup — so summary values
 * are carried through verbatim and `pubmedSearch.test.ts` pins that.
 *
 * Titles are rendered as plain React text by the panel. No upstream string is
 * ever placed in `dangerouslySetInnerHTML`.
 */

// ── Bounds ────────────────────────────────────────────────────────────────

/**
 * Maximum accepted trimmed query length. Matches the per-identifier bound the
 * metadata function already enforces (500 characters), so the two external-input
 * surfaces are hardened to the same size.
 */
export const PUBMED_SEARCH_MAX_QUERY_LENGTH = 500;

/** Page size the client always requests. Kept conservative on purpose. */
export const PUBMED_SEARCH_DEFAULT_LIMIT = 20;

/**
 * Server-side maximum page size. Validated independently of the client, which
 * always sends {@link PUBMED_SEARCH_DEFAULT_LIMIT}. Well under NCBI's own
 * `retmax` ceiling (10,000 for PubMed) — this bound is about how much upstream
 * work one request may cause, not about what NCBI would tolerate.
 */
export const PUBMED_SEARCH_MAX_LIMIT = 50;

/**
 * Highest `retstart` NCBI accepts for `db=pubmed`. Verified against the live
 * service on 2026-08-22: `retstart=10000` returns HTTP 200 carrying
 * `esearchresult.ERROR` — *"'retstart' cannot be larger than 9998. For PubMed,
 * ESearch can only retrieve the first 9,999 records matching the query."* —
 * while `retstart=9998` returns the single last retrievable record. This is
 * PubMed's constraint, not an invented one.
 */
export const PUBMED_SEARCH_MAX_OFFSET = 9998;

/**
 * How many records of any result set PubMed will paginate through
 * (`PUBMED_SEARCH_MAX_OFFSET + 1`). A query matching more than this still
 * reports its true `total`; the extra matches are simply not reachable by
 * paging, and the UI says so rather than offering a Next button that cannot
 * work.
 */
export const PUBMED_SEARCH_MAX_REACHABLE = PUBMED_SEARCH_MAX_OFFSET + 1;

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";

/** A PMID is a bare decimal identifier — same rule as `pubmedIdentifiers.ts`. */
const PMID_PATTERN = /^\d+$/;

// ── Public types ──────────────────────────────────────────────────────────

/**
 * One PubMed record as the discovery UI shows it. Application-owned: raw NCBI
 * JSON is never forwarded to the browser, so an upstream shape change cannot
 * reach the client, and this is deliberately NOT a generated database type —
 * no row anywhere has this shape.
 */
export interface PubMedSearchResult {
  /** Authoritative. The only value that crosses into the canonical importer. */
  pmid: string;
  title: string | null;
  /** Display-only. The canonical import retrieves the real authors + provenance. */
  authors: string[];
  journal: string | null;
  /** PubMed's own `pubdate` text, e.g. `"2026 Apr 1"`. Not reformatted. */
  publicationDate: string | null;
  year: number | null;
  publicationTypes: string[];
  /** Display-only. The import identifier stays the PMID — see the panel. */
  doi: string | null;
}

/** One page of discovery results. */
export interface PubMedSearchPage {
  /** The trimmed query the server actually executed. */
  query: string;
  /** PubMed's total match count, which may exceed what paging can reach. */
  total: number;
  offset: number;
  limit: number;
  results: PubMedSearchResult[];
}

/** A validated search request. Carries no caller identity — by construction. */
export interface ValidatedSearchRequest {
  query: string;
  offset: number;
  limit: number;
}

export type SearchRequestValidation =
  | { ok: true; request: ValidatedSearchRequest }
  | { ok: false; message: string };

export type ESearchParse =
  | { ok: true; total: number; pmids: string[] }
  /**
   * `upstream_error`: NCBI answered 200 but reported a failure in-band.
   * `malformed`: the payload is not a shape this module can trust.
   * The upstream text itself is deliberately not carried — it is never shown.
   */
  | { ok: false; reason: "upstream_error" | "malformed" };

// ── Request validation ────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an integer request field.
 *
 * `Number.isSafeInteger` rejects `NaN`, `Infinity`, fractions and values past
 * 2^53 in one check, so no arithmetic downstream can silently overflow.
 */
function validateInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return { ok: false, message: `${label} must be an integer.` };
  }
  if (value < min || value > max) {
    return { ok: false, message: `${label} must be between ${min} and ${max}.` };
  }
  return { ok: true, value };
}

/**
 * Validate an untrusted request body into exactly three values.
 *
 * The body is read **field by field**, so no other key can influence the
 * request. That is the structural reason a caller-supplied user id is
 * impossible here: this function never looks for one, and the handler derives
 * the user solely from the verified bearer token.
 *
 * PubMed query *syntax* is never sanitized. Quotes, parentheses, field tags and
 * Boolean operators are what makes a PubMed query a PubMed query; stripping any
 * of them would silently execute a different search than the user wrote. Only
 * leading/trailing whitespace is removed, and the result is percent-encoded once
 * on the way into the URL by {@link buildESearchUrl}.
 */
export function validateSearchRequest(body: unknown): SearchRequestValidation {
  if (!isRecord(body)) {
    return { ok: false, message: "A JSON request body is required." };
  }

  const rawQuery = body.query;
  if (typeof rawQuery !== "string") {
    return { ok: false, message: "query is required." };
  }
  const query = rawQuery.trim();
  if (query.length === 0) {
    return { ok: false, message: "query is required." };
  }
  if (query.length > PUBMED_SEARCH_MAX_QUERY_LENGTH) {
    return {
      ok: false,
      message: `query is too long (max ${PUBMED_SEARCH_MAX_QUERY_LENGTH} characters).`,
    };
  }

  const offset = validateInteger(body.offset, 0, 0, PUBMED_SEARCH_MAX_OFFSET, "offset");
  if (!offset.ok) return { ok: false, message: offset.message };

  const limit = validateInteger(
    body.limit,
    PUBMED_SEARCH_DEFAULT_LIMIT,
    1,
    PUBMED_SEARCH_MAX_LIMIT,
    "limit",
  );
  if (!limit.ok) return { ok: false, message: limit.message };

  return { ok: true, request: { query, offset: offset.value, limit: limit.value } };
}

// ── PMID validation ───────────────────────────────────────────────────────

/**
 * Accept a value from an untrusted upstream list as a PMID.
 *
 * The ESearch `idlist` is external input and the ESummary `result` object is
 * keyed by strings NCBI chose (`"uids"` is one of them). Returning an arbitrary
 * key as a PMID would put unvalidated text into the import pipeline, so every
 * candidate is checked against the same bare-decimal rule
 * `src/lib/pubmedIdentifiers.ts` applies to imported values.
 */
export function normalizeSearchPmid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return PMID_PATTERN.test(trimmed) ? trimmed : null;
}

// ── URL construction ──────────────────────────────────────────────────────

/**
 * Build the ESearch URL for one page.
 *
 * Constructed with `URL`/`URLSearchParams` rather than string concatenation, so
 * the query is percent-encoded exactly once and a PubMed expression containing
 * `&`, `+`, `#`, `"` or `[` survives transport with its meaning intact.
 *
 * `sort=relevance` is PubMed's documented default ordering ("Best Match" on the
 * PubMed website), stated explicitly so the ordering the user sees is a property
 * of this request rather than of whatever NCBI defaults to later.
 */
export function buildESearchUrl(params: {
  query: string;
  offset: number;
  limit: number;
  apiKey?: string;
}): string {
  const url = new URL("esearch.fcgi", EUTILS_BASE);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("term", params.query);
  url.searchParams.set("retmode", "json");
  url.searchParams.set("retstart", String(params.offset));
  url.searchParams.set("retmax", String(params.limit));
  url.searchParams.set("sort", "relevance");
  if (params.apiKey) url.searchParams.set("api_key", params.apiKey);
  return url.toString();
}

/**
 * Build the ESummary URL for the PMIDs one ESearch page returned.
 *
 * `version=2.0` is the only supported ESummary version parameter and is what
 * produces the `authors[] / articleids[] / pubtype[]` record shape parsed below.
 */
export function buildESummaryUrl(params: { pmids: string[]; apiKey?: string }): string {
  const url = new URL("esummary.fcgi", EUTILS_BASE);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("id", params.pmids.join(","));
  url.searchParams.set("retmode", "json");
  url.searchParams.set("version", "2.0");
  if (params.apiKey) url.searchParams.set("api_key", params.apiKey);
  return url.toString();
}

// ── ESearch parsing ───────────────────────────────────────────────────────

/**
 * Parse `count` defensively.
 *
 * PubMed sends the total as a **string** (`"count":"2509"`), so it is parsed
 * rather than trusted. Anything that is not a finite non-negative integer means
 * the payload is not one this module understands — never a displayed `NaN`.
 */
function parseCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Parse an ESearch JSON payload into a total and an ordered PMID list.
 *
 * NCBI reports several real failures as HTTP 200 with an `ERROR` string inside
 * `esearchresult` (an out-of-range `retstart` is one), so a 200 is not by itself
 * a success and is checked here.
 *
 * A zero-result query is a perfectly good answer — `count: "0"` with an empty
 * `idlist` — and parses as `{ ok: true, total: 0, pmids: [] }`, never as an
 * error.
 */
export function parseESearchResponse(payload: unknown): ESearchParse {
  if (!isRecord(payload)) return { ok: false, reason: "malformed" };

  const result = payload.esearchresult;
  if (!isRecord(result)) return { ok: false, reason: "malformed" };

  // In-band failure. The upstream text is intentionally not propagated.
  if (typeof result.ERROR === "string" && result.ERROR.trim() !== "") {
    return { ok: false, reason: "upstream_error" };
  }
  if (Array.isArray(result.ERROR) || isRecord(result.ERROR)) {
    return { ok: false, reason: "upstream_error" };
  }

  const total = parseCount(result.count);
  if (total === null) return { ok: false, reason: "malformed" };

  const rawIds = result.idlist;
  if (!Array.isArray(rawIds)) return { ok: false, reason: "malformed" };

  // Order is load-bearing: this list *is* the relevance ranking PubMed
  // returned, and it is the order the results are shown and imported in.
  // Anything that is not a syntactically valid PMID is dropped rather than
  // carried into the import pipeline as an identifier.
  const pmids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of rawIds) {
    const pmid = normalizeSearchPmid(candidate);
    if (pmid && !seen.has(pmid)) {
      seen.add(pmid);
      pmids.push(pmid);
    }
  }

  return { ok: true, total, pmids };
}

// ── ESummary parsing ──────────────────────────────────────────────────────

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Compact display authors.
 *
 * ESummary states each author as `{ name, authtype }`, where `authtype` is
 * `"Author"` for a person and `"CollectiveName"` for a consortium — both are
 * legitimate display authors, so neither is filtered out. This list is a
 * *summary*: the persisted authors and their provenance come from the canonical
 * EFetch import, never from here.
 */
function extractAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const authors: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = nonEmptyString(entry.name);
    if (name) authors.push(name);
  }
  return authors;
}

/** Publication types as PubMed stated them — discrete values, never a joined string. */
function extractPublicationTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const types: string[] = [];
  for (const entry of value) {
    const type = nonEmptyString(entry);
    if (type) types.push(type);
  }
  return types;
}

/**
 * The DOI from `articleids`, when PubMed states one.
 *
 * Display metadata only. The identifier this feature imports is always the
 * PMID: the discovery source is PubMed, and letting a present DOI redirect the
 * import would silently change which provider authenticates the record.
 */
function extractDoi(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (entry.idtype !== "doi") continue;
    const doi = nonEmptyString(entry.value);
    if (doi) return doi;
  }
  return null;
}

/**
 * A four-digit year from PubMed's own date fields.
 *
 * `pubdate` is free text (`"2026 Apr 1"`, `"2019 Nov-Dec"`, `"2020"`) and
 * `sortpubdate` is `"YYYY/MM/DD hh:mm"`. Only a leading four-digit year in a
 * plausible range is accepted; nothing is inferred when neither field carries
 * one.
 */
function extractYear(pubdate: string | null, sortpubdate: string | null): number | null {
  for (const source of [pubdate, sortpubdate]) {
    if (!source) continue;
    const match = /^(\d{4})/.exec(source.trim());
    if (!match) continue;
    const year = Number(match[1]);
    if (year >= 1000 && year <= 9999) return year;
  }
  return null;
}

/**
 * Map one ESummary record onto the discovery shape.
 *
 * The PMID is supplied by the caller from the ESearch order and is already
 * validated, so it is authoritative even when the record itself is unusable.
 * Every other field is optional: NCBI answers an unknown id with
 * `{ uid, error: "cannot get document summary" }` (verified live), and a
 * genuine record may omit any of `fulljournalname`, `pubdate`, `pubtype` or a
 * DOI. Such a row still lists — with a `null` title the UI labels explicitly —
 * because the PMID alone is enough to import the paper properly.
 */
function mapSummaryRecord(pmid: string, record: unknown): PubMedSearchResult {
  if (!isRecord(record)) {
    return {
      pmid,
      title: null,
      authors: [],
      journal: null,
      publicationDate: null,
      year: null,
      publicationTypes: [],
      doi: null,
    };
  }

  const pubdate = nonEmptyString(record.pubdate);
  const sortpubdate = nonEmptyString(record.sortpubdate);

  return {
    pmid,
    title: nonEmptyString(record.title),
    authors: extractAuthors(record.authors),
    // `fulljournalname` is the readable journal title; `source` is the NLM
    // abbreviation and is the fallback when the full name is absent.
    journal: nonEmptyString(record.fulljournalname) ?? nonEmptyString(record.source),
    publicationDate: pubdate,
    year: extractYear(pubdate, sortpubdate),
    publicationTypes: extractPublicationTypes(record.pubtype),
    doi: extractDoi(record.articleids),
  };
}

/**
 * Map an ESummary payload onto the ordered PMID list from ESearch.
 *
 * **The ESearch order wins.** ESummary answers with an object keyed by uid plus
 * its own `uids` array, and object key order is not a ranking — reading results
 * out of it would quietly replace PubMed's relevance ordering with whatever the
 * serializer produced. Iterating `pmids` instead makes the displayed and
 * imported order exactly the order PubMed ranked.
 *
 * @param payload The raw ESummary JSON.
 * @param pmids   Validated PMIDs in ESearch order.
 * @returns One result per requested PMID, in order, or `null` when the payload
 *          is not an ESummary response at all (a total upstream failure, as
 *          distinct from individual records being incomplete).
 */
export function mapESummaryResponse(
  payload: unknown,
  pmids: string[],
): PubMedSearchResult[] | null {
  if (pmids.length === 0) return [];
  if (!isRecord(payload)) return null;

  const result = payload.result;
  if (!isRecord(result)) return null;

  return pmids.map((pmid) => mapSummaryRecord(pmid, result[pmid]));
}
