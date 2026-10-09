/**
 * Client-side wrapper that delegates Consensus discovery search to the
 * owner-only `search-consensus` Supabase Edge Function.
 *
 * The Edge Function authenticates the caller, re-checks server-side that they
 * are the owner, reads `CONSENSUS_API_KEY` server-side, makes ONE request to
 * Consensus and answers with an application-owned result shape. No API key, no
 * raw Consensus JSON and no upstream error text ever reaches the browser.
 *
 * ## Discovery only — the DOI is the only thing that crosses
 *
 * What comes back is display metadata for choosing papers. The only value the
 * Add Papers dialog may hand on is a result's `importDoi`, re-validated here by
 * {@link toImportableDoi}, and it goes into the existing canonical importer
 * (`bulkImportPapers` → `fetchPaperMetadata` → `fetch-paper-metadata` →
 * PubMed/Crossref provenance checks → normalization → duplicate handling →
 * `safe_bulk_insert_papers`). Consensus's title, authors, abstract, journal,
 * study type, citation count and takeaway are never written anywhere.
 *
 * ## Quota-conscious by construction
 *
 * Every Consensus request may count against the owner's monthly allowance, so
 * this wrapper sends a request only when it is called — the panel calls it only
 * from an explicit Search press — and it never retries a Consensus outcome.
 * The single refresh-and-retry below is reserved for a **PaperLume** Edge 401,
 * which the function only ever produces before it reads the key or calls
 * Consensus, so that retry cannot repeat a Consensus call.
 *
 * ## Why this duplicates the token dance in `searchPubMedEdge.ts`
 *
 * Same reason that file gives for duplicating `fetchPaperMetadataEdge.ts`: the
 * canonical importer's client and the PubMed client stay byte-identical, and
 * this wrapper's retry rule is deliberately narrower than theirs (a real Edge
 * `Response` with status 401 only — never a message that merely mentions one).
 */

import { supabase } from "@/integrations/supabase/client";
import { doiEquivalenceKey, extractDoiFromMetadataValue } from "@/lib/doiIdentifiers";
import type { ConsensusStudyType } from "@/lib/consensusSearchFilters";

/** PaperLume's own query bound. Mirrors the Edge Function, which enforces it. */
export const CONSENSUS_SEARCH_MAX_QUERY_LENGTH = 500;

/**
 * Longest DOI the dialog will hand to the importer — the importer's own
 * per-identifier bound, mirrored from the Edge boundary.
 */
export const CONSENSUS_IMPORT_DOI_MAX_LENGTH = 500;

const CONSENSUS_URL_MAX_LENGTH = 2048;
const CONSENSUS_URL_HOSTS: ReadonlySet<string> = new Set(["consensus.app"]);
const CONSENSUS_PAPER_PATH_PREFIX = "/papers/";

/** Whitespace, control, format and lone-surrogate code points — never in an importable DOI. */
const DISALLOWED_DOI_CODE_POINTS = /[\s\p{Cc}\p{Cf}\p{Cs}]/u;

/** One Consensus result as the discovery UI shows it. Mirrors the Edge contract. */
export interface ConsensusSearchResult {
  /** 1-based position in Consensus's relevance order. A render key only. */
  rank: number;
  title: string | null;
  /** Display-only. The canonical import retrieves the real authors. */
  authors: string[];
  journal: string | null;
  year: number | null;
  abstract: string | null;
  citationCount: number | null;
  studyType: string | null;
  /** Consensus-generated summary. Display-only and labelled as such. */
  takeaway: string | null;
  /** A validated consensus.app paper link, or `null`. */
  consensusUrl: string | null;
  /** THE ONLY IMPORT AUTHORITY: a validated DOI name in its original spelling. */
  importDoi: string | null;
}

/** One search's answer. One page, by design: there is no pagination in V1. */
export interface ConsensusSearchResponse {
  results: ConsensusSearchResult[];
}

/**
 * The complete request contract: the question and PaperLume's four optional
 * filter categories (CONSENSUS-ADVANCED-FILTERS-001A). The server validates
 * every field again and refuses any other. Leaving a filter out, `false` and
 * an empty `studyTypes` all mean "no restriction".
 */
export interface ConsensusSearchRequest {
  query: string;
  yearMin?: number;
  yearMax?: number;
  studyTypes?: readonly ConsensusStudyType[];
  human?: boolean;
  excludePreprints?: boolean;
}

export type ConsensusSearchErrorKind =
  | "auth"
  | "forbidden"
  | "validation"
  | "not_configured"
  | "quota_exhausted"
  | "rate_limited"
  /** Consensus refused a filtered search — possibly a plan restriction on the filters. */
  | "filters_not_allowed"
  /** Consensus did not accept the filters it was sent. */
  | "filters_rejected"
  | "upstream"
  | "unexpected";

/**
 * A failure the Consensus panel can describe to the owner. `message` is always
 * already safe to show: it is either written here or is the Edge Function's
 * own deliberate copy for one of its known error codes.
 */
export class ConsensusSearchError extends Error {
  readonly kind: ConsensusSearchErrorKind;

  constructor(kind: ConsensusSearchErrorKind, message: string) {
    super(message);
    this.name = "ConsensusSearchError";
    this.kind = kind;
  }
}

const DEFAULT_MESSAGES: Record<ConsensusSearchErrorKind, string> = {
  auth: "Your session has expired. Please sign in again.",
  forbidden: "Consensus search is not available for this account.",
  validation: "That search could not be run.",
  not_configured: "Consensus search is not configured on the server yet.",
  quota_exhausted:
    "The connected Consensus API allowance has been used up. It resets or can be raised from the Consensus account.",
  rate_limited: "Consensus is receiving requests too quickly. Please wait a moment and try again.",
  filters_not_allowed:
    "Consensus did not allow this filtered search, possibly because of the connected Consensus plan. Clear the advanced filters to search without them, or check the plan.",
  filters_rejected: "Consensus did not accept these filters. Change or clear the advanced filters, then search again.",
  upstream: "Consensus could not be reached right now. Please try again in a moment.",
  unexpected: "Consensus search failed. Please try again.",
};

/**
 * The Edge Function's own error codes and the kind each one is. Only these
 * codes may contribute their server-written `message`; anything else — a
 * gateway answer, a stale deployment, a proxy page — gets this file's copy.
 */
const EDGE_ERROR_KINDS: Record<string, ConsensusSearchErrorKind> = {
  unauthenticated: "auth",
  forbidden: "forbidden",
  invalid_request: "validation",
  not_configured: "not_configured",
  quota_exhausted: "quota_exhausted",
  rate_limited: "rate_limited",
  filters_not_allowed: "filters_not_allowed",
  filters_rejected: "filters_rejected",
  consensus_unavailable: "upstream",
  upstream_unavailable: "upstream",
  upstream_timeout: "upstream",
  access_check_failed: "unexpected",
  internal_error: "unexpected",
  method_not_allowed: "unexpected",
};

// ── The DOI and link boundaries (re-validated on this side) ───────────────

/**
 * Accept a value as an importable DOI, or return `null`.
 *
 * The browser-side twin of the Edge `toImportDoi`, built from this
 * application's own DOI helper: the value must be a bare DOI *name* that
 * `extractDoiFromMetadataValue` returns unchanged — so `"10.1000"`,
 * `doi:10.1000/x` and `https://doi.org/10.1000/x` are all refused rather than
 * rewritten — with no whitespace, control, format or lone-surrogate code point,
 * and no longer than the importer accepts. Nothing is repaired; the original
 * spelling is returned untouched. Parity with the Edge gate is pinned by
 * `consensusSearchBoundaries.parity.test.ts`.
 */
export function toImportableDoi(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > CONSENSUS_IMPORT_DOI_MAX_LENGTH) return null;
  if (DISALLOWED_DOI_CODE_POINTS.test(value)) return null;
  return extractDoiFromMetadataValue(value) === value ? value : null;
}

/**
 * The selection identity of an importable DOI: its DOI-equivalence key (DOI
 * Handbook §4.3.4, ASCII case-folding only). Two results whose DOIs differ only
 * in ASCII case are the same paper and occupy one selection slot.
 */
export function consensusSelectionKey(doi: string): string {
  return doiEquivalenceKey(doi) ?? doi;
}

/**
 * Accept a value as a safe "Open in Consensus" link, or return `null`: an
 * absolute `https:` URL on exactly `consensus.app`, no credentials, no explicit
 * port, a path under `/papers/`. Returns the parser's normalized `href`. The
 * browser-side twin of the Edge `toSafeConsensusUrl`.
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

// ── Transport ─────────────────────────────────────────────────────────────

/**
 * Get a fresh access token, refreshing the session if needed.
 * Returns the access_token string or null if unauthenticated.
 */
async function getFreshAccessToken(): Promise<string | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;

  if (session) {
    const expiresAt = session.expires_at ?? 0;
    // Still valid for more than two minutes — use it as-is.
    if (expiresAt * 1000 - Date.now() > 120_000) {
      return session.access_token;
    }
  }

  const { data: refreshData, error } = await supabase.auth.refreshSession();
  if (error || !refreshData.session) {
    return null;
  }
  return refreshData.session.access_token;
}

/**
 * Whether a failed invocation is a PaperLume Edge 401 — the ONLY failure this
 * wrapper retries, once, after refreshing the session.
 *
 * Decided from the function's real `Response` status and from nothing else.
 * Unlike the PubMed wrapper there is no message-text fallback: a transport
 * error that merely mentions "401" or "JWT" carries no proof the request
 * stopped before Consensus, so it is not retried. `search-consensus` only ever
 * answers 401 before it reads its key or calls Consensus (a Consensus 401 comes
 * back as a 502), so retrying a genuine Edge 401 cannot spend a Consensus call.
 */
function isPaperLumeAuthRejection(error: { context?: unknown }): boolean {
  return error.context instanceof Response && error.context.status === 401;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** One display result, or `null` when the entry is not a usable record. */
function toResult(value: unknown, index: number): ConsensusSearchResult | null {
  if (!isRecord(value)) return null;
  const authors = Array.isArray(value.authors)
    ? value.authors.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];

  return {
    // Positional, assigned here: unique and stable for this response whatever
    // the server sent, so it can key a list row.
    rank: index + 1,
    title: nullableString(value.title),
    authors,
    journal: nullableString(value.journal),
    year: nullableInteger(value.year),
    abstract: nullableString(value.abstract),
    citationCount: nullableInteger(value.citationCount),
    studyType: nullableString(value.studyType),
    takeaway: nullableString(value.takeaway),
    // Both boundaries are re-applied here. A server that is the right function
    // but the wrong version — or simply wrong — cannot make an unsafe link
    // render or an invalid DOI selectable.
    consensusUrl: toSafeConsensusUrl(value.consensusUrl),
    importDoi: toImportableDoi(value.importDoi),
  };
}

/** Validate the broad shape of an Edge response, or return `null`. */
function toResponse(data: unknown): ConsensusSearchResponse | null {
  if (!isRecord(data) || !Array.isArray(data.results)) return null;
  const results: ConsensusSearchResult[] = [];
  for (const entry of data.results) {
    const result = toResult(entry, results.length);
    if (result) results.push(result);
  }
  return { results };
}

/**
 * Describe a failed invocation in words the owner can act on.
 *
 * The function's JSON body carries an `error` code and its deliberate copy. A
 * known code decides the kind and may contribute its message; an unknown body
 * falls back to the HTTP status and this file's own copy, so text from a
 * gateway or proxy is never shown.
 */
async function describeFunctionError(error: { message?: string; context?: unknown }): Promise<ConsensusSearchError> {
  const context = error.context;
  if (!(context instanceof Response)) {
    return new ConsensusSearchError("unexpected", DEFAULT_MESSAGES.unexpected);
  }

  let code: string | null = null;
  let serverMessage: string | null = null;
  try {
    const body: unknown = await context.clone().json();
    if (isRecord(body)) {
      if (typeof body.error === "string") code = body.error;
      if (typeof body.message === "string" && body.message.trim() !== "") serverMessage = body.message;
    }
  } catch {
    // Body unreadable or not JSON — fall through to the status-based copy.
  }

  const knownKind =
    code !== null && Object.prototype.hasOwnProperty.call(EDGE_ERROR_KINDS, code) ? EDGE_ERROR_KINDS[code] : null;
  if (knownKind) {
    return new ConsensusSearchError(knownKind, serverMessage ?? DEFAULT_MESSAGES[knownKind]);
  }

  const status = context.status;
  const kind: ConsensusSearchErrorKind =
    status === 401
      ? "auth"
      : status === 403
        ? "forbidden"
        : status === 400
          ? "validation"
          : status === 429
            ? "rate_limited"
            : status >= 500
              ? "upstream"
              : "unexpected";
  return new ConsensusSearchError(kind, DEFAULT_MESSAGES[kind]);
}

/**
 * The request body: the question plus each filter that restricts something,
 * under exactly the six contract names — never a spread of the caller's
 * object, so no page, page size, Consensus parameter name, endpoint, role or
 * identity can ride along.
 *
 * Unset (`undefined`), `false` and an empty design list mean "no restriction"
 * and are left out, so an unfiltered search sends exactly `{ query }`, the V1
 * body. Every other value is forwarded as given rather than dropped or
 * repaired: a malformed filter is the server's to refuse, loudly and at no
 * Consensus cost, never something to quietly search without.
 */
function requestBody(request: ConsensusSearchRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { query: request.query };
  if (request.yearMin !== undefined) body.yearMin = request.yearMin;
  if (request.yearMax !== undefined) body.yearMax = request.yearMax;
  const { studyTypes } = request;
  if (Array.isArray(studyTypes)) {
    // Copied, never aliased: the body shares no array with the caller.
    if (studyTypes.length > 0) body.studyTypes = [...studyTypes];
  } else if (studyTypes !== undefined) {
    body.studyTypes = studyTypes;
  }
  if (request.human !== undefined && request.human !== false) body.human = request.human;
  if (request.excludePreprints !== undefined && request.excludePreprints !== false) {
    body.excludePreprints = request.excludePreprints;
  }
  return body;
}

/**
 * Run one Consensus discovery search for the signed-in owner.
 *
 * Sends `{ query }` plus the filters the request sets. There is no page, page
 * size, endpoint or identity in the request — the server owns all of them and
 * refuses extras.
 *
 * @throws {ConsensusSearchError} for every failure, already described in words
 *         the panel can show.
 */
export async function searchConsensus(request: ConsensusSearchRequest): Promise<ConsensusSearchResponse> {
  const body = requestBody(request);

  // Fresh token BEFORE the call, passed explicitly, because
  // `supabase.functions.invoke()`'s internal token can be stale.
  const accessToken = await getFreshAccessToken();
  if (!accessToken) {
    throw new ConsensusSearchError("auth", DEFAULT_MESSAGES.auth);
  }

  let response = await supabase.functions.invoke("search-consensus", {
    body,
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Exactly one refresh-and-retry, and only for a PaperLume Edge 401 — which
  // the function produces before any Consensus call. The retry sends the very
  // same body. Never for a Consensus outcome: a 429, a 5xx, a timeout, a
  // network failure, a validation error, a 403 or a refused filter is
  // reported, and the owner decides whether to search again — with or without
  // the filters. Nothing here ever drops them and tries again.
  if (response.error && isPaperLumeAuthRejection(response.error)) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData.session) {
      throw new ConsensusSearchError("auth", DEFAULT_MESSAGES.auth);
    }
    response = await supabase.functions.invoke("search-consensus", {
      body,
      headers: { Authorization: `Bearer ${refreshData.session.access_token}` },
    });
  }

  if (response.error) {
    throw await describeFunctionError(response.error);
  }

  const parsed = toResponse(response.data);
  if (!parsed) {
    throw new ConsensusSearchError("unexpected", "Consensus search returned an unexpected response. Please try again.");
  }
  return parsed;
}
