/**
 * Client-side wrapper that delegates PubMed discovery search to the
 * `search-pubmed` Supabase Edge Function.
 *
 * The Edge Function authenticates the caller, reads their PubMed API key
 * server-side, calls NCBI E-utilities (ESearch + ESummary) with a bounded retry
 * budget, and answers with an application-owned page shape. No API key, no raw
 * NCBI JSON and no upstream error text ever reaches the browser.
 *
 * ## Discovery only
 *
 * What comes back is display metadata for choosing papers. The import path is
 * unchanged and unshared: the PMIDs the user selects go into the existing
 * identifier importer (`bulkImportPapers` → `fetchPaperMetadata` →
 * `fetch-paper-metadata` → normalization → `safe_bulk_insert_papers`), which
 * remains the sole authority for persisted paper metadata. Nothing returned
 * here is ever written to the database.
 *
 * ## Why this duplicates the token dance in `fetchPaperMetadataEdge.ts`
 *
 * Both wrappers need a fresh access token and a one-shot refresh-and-retry on a
 * 401, because `supabase.functions.invoke()` reads its internal token
 * asynchronously via `onAuthStateChange` and can send a stale one. Extracting
 * that into a shared helper would mean editing the canonical importer's client
 * during an unrelated discovery feature; the deliberate small duplication keeps
 * the import path's proven behaviour byte-identical. If a third caller ever
 * needs it, that is the moment to extract it — with regression tests on the
 * metadata wrapper.
 */

import { supabase } from "@/integrations/supabase/client";

/** Page size the UI requests. The server validates its own bound regardless. */
export const PUBMED_SEARCH_PAGE_SIZE = 20;

/**
 * How many records of any result set PubMed will paginate through. Verified
 * against the live service: ESearch refuses `retstart` above 9998 for
 * `db=pubmed`, so the reachable window is the first 9,999 matches. A query with
 * more matches still reports its true total — the surplus simply cannot be
 * paged to, and the UI says so instead of offering a Next that cannot work.
 */
export const PUBMED_SEARCH_MAX_REACHABLE = 9999;

/** One PubMed record as the discovery UI shows it. Mirrors the Edge contract. */
export interface PubMedSearchResult {
  /** Authoritative — the only value that crosses into the canonical importer. */
  pmid: string;
  title: string | null;
  /** Display-only summary; the canonical import retrieves the real authors. */
  authors: string[];
  journal: string | null;
  publicationDate: string | null;
  year: number | null;
  publicationTypes: string[];
  /** Display-only. The import identifier stays the PMID. */
  doi: string | null;
}

/** One page of discovery results. */
export interface PubMedSearchPage {
  query: string;
  total: number;
  offset: number;
  limit: number;
  results: PubMedSearchResult[];
}

/** What the panel asks for. `limit` defaults to {@link PUBMED_SEARCH_PAGE_SIZE}. */
export interface PubMedSearchRequest {
  query: string;
  offset?: number;
  limit?: number;
}

/**
 * A failure the PubMed tab can describe to the user.
 *
 * The `kind` separates causes the UI genuinely presents differently — a session
 * that needs re-authentication is not the same event as PubMed being down — and
 * `message` is always already user-safe: it is either written here or is the
 * Edge Function's own deliberate user-facing copy. Raw upstream bodies, stack
 * traces, keys and internal identifiers are never carried.
 */
export class PubMedSearchError extends Error {
  readonly kind: "auth" | "validation" | "upstream" | "unexpected";

  constructor(kind: PubMedSearchError["kind"], message: string) {
    super(message);
    this.name = "PubMedSearchError";
    this.kind = kind;
  }
}

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

/** Whether a function-invocation error looks like an authentication failure. */
function isAuthError(message: string): boolean {
  return (
    message.includes("401") ||
    message.includes("Unauthorized") ||
    message.includes("Invalid JWT") ||
    message.toLowerCase().includes("jwt")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One display result, or `null` when the entry is not a usable record. */
function toResult(value: unknown): PubMedSearchResult | null {
  if (!isRecord(value)) return null;
  // The PMID is the identity of the row and the value that would be imported.
  // An entry without one is dropped rather than rendered as a selectable paper.
  if (typeof value.pmid !== "string" || value.pmid.trim() === "") return null;

  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
  const nullableString = (input: unknown): string | null =>
    typeof input === "string" ? input : null;

  return {
    pmid: value.pmid,
    title: nullableString(value.title),
    authors: strings(value.authors),
    journal: nullableString(value.journal),
    publicationDate: nullableString(value.publicationDate),
    year: typeof value.year === "number" && Number.isFinite(value.year) ? value.year : null,
    publicationTypes: strings(value.publicationTypes),
    doi: nullableString(value.doi),
  };
}

/**
 * Validate the broad shape of an Edge response.
 *
 * The function is trusted to be the right function, not to be the right
 * *version* of it: a deployment lagging the frontend would answer something
 * this page cannot render, and a defensive parse turns that into one honest
 * error instead of a crash inside the result list.
 */
function toPage(data: unknown): PubMedSearchPage | null {
  if (!isRecord(data)) return null;
  if (typeof data.total !== "number" || !Number.isFinite(data.total) || data.total < 0) return null;
  if (typeof data.offset !== "number" || !Number.isFinite(data.offset)) return null;
  if (typeof data.limit !== "number" || !Number.isFinite(data.limit)) return null;
  if (!Array.isArray(data.results)) return null;

  const results: PubMedSearchResult[] = [];
  for (const entry of data.results) {
    const result = toResult(entry);
    if (result) results.push(result);
  }

  return {
    query: typeof data.query === "string" ? data.query : "",
    total: data.total,
    offset: data.offset,
    limit: data.limit,
    results,
  };
}

/**
 * Read the Edge Function's own user-facing message out of a failed invocation.
 *
 * `supabase.functions.invoke` surfaces a non-2xx as an error whose `context` is
 * the raw `Response`; the JSON body carries the deliberate copy the function
 * wrote. Anything unreadable falls back to a generic message rather than
 * exposing transport detail.
 */
async function describeFunctionError(
  error: { message?: string; context?: unknown },
): Promise<PubMedSearchError> {
  const context = error.context;
  if (context instanceof Response) {
    const status = context.status;
    let message: string | null = null;
    try {
      const body: unknown = await context.clone().json();
      if (isRecord(body) && typeof body.message === "string" && body.message.trim() !== "") {
        message = body.message;
      }
    } catch {
      // Body unreadable or not JSON — fall through to the status-based copy.
    }
    if (status === 401) {
      return new PubMedSearchError(
        "auth",
        message ?? "Your session has expired. Please sign in again.",
      );
    }
    if (status === 400) {
      return new PubMedSearchError("validation", message ?? "That search could not be run.");
    }
    if (status >= 500) {
      return new PubMedSearchError(
        "upstream",
        message ?? "PubMed could not be reached right now. Please try again in a moment.",
      );
    }
    return new PubMedSearchError("unexpected", message ?? "PubMed search failed. Please try again.");
  }

  const raw = error.message ?? "";
  if (isAuthError(raw)) {
    return new PubMedSearchError("auth", "Your session has expired. Please sign in again.");
  }
  return new PubMedSearchError("unexpected", "PubMed search failed. Please try again.");
}

/**
 * Search PubMed for one page of discovery results.
 *
 * The query is sent exactly as given (the server trims it and executes it
 * verbatim) — PubMed syntax such as `("resistance training"[Title/Abstract])
 * AND muscle` must survive intact, so nothing here rewrites, splits or strips
 * it.
 *
 * @throws {PubMedSearchError} for every failure, already described in words the
 *         PubMed tab can show.
 */
export async function searchPubMed(request: PubMedSearchRequest): Promise<PubMedSearchPage> {
  const body = {
    query: request.query,
    offset: request.offset ?? 0,
    limit: request.limit ?? PUBMED_SEARCH_PAGE_SIZE,
  };

  // Fresh token BEFORE the call, passed explicitly, because
  // `supabase.functions.invoke()`'s internal token can be stale.
  const accessToken = await getFreshAccessToken();
  if (!accessToken) {
    throw new PubMedSearchError("auth", "Your session has expired. Please sign in again.");
  }

  let response = await supabase.functions.invoke("search-pubmed", {
    body,
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Exactly one refresh-and-retry on an auth failure. Never a loop: a second
  // 401 after a successful refresh is a real authentication problem, and
  // retrying it again would only delay telling the user.
  if (response.error && isAuthError(response.error.message ?? "")) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData.session) {
      throw new PubMedSearchError("auth", "Your session has expired. Please sign in again.");
    }
    response = await supabase.functions.invoke("search-pubmed", {
      body,
      headers: { Authorization: `Bearer ${refreshData.session.access_token}` },
    });
  }

  if (response.error) {
    throw await describeFunctionError(response.error);
  }

  const page = toPage(response.data);
  if (!page) {
    throw new PubMedSearchError(
      "unexpected",
      "PubMed search returned an unexpected response. Please try again.",
    );
  }

  return page;
}
