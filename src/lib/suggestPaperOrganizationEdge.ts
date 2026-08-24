/**
 * Client-side wrapper that asks the `suggest-paper-organization` Supabase Edge
 * Function which of the user's Projects and Tags fit the paper they are
 * currently editing — AI-PROJECT-TAG-SUGGESTIONS-001B.
 *
 * The endpoint is **advisory**, and this wrapper preserves that: it returns
 * four lists of recommendations and nothing else. It creates no Project, no
 * Tag and no assignment, and it writes nothing. Every durable action stays
 * behind an explicit user gesture in `PaperOrganizationSuggestions`, and the
 * existing `useProjectMutations` / `useTagMutations` remain the sole authority
 * for changes to the library.
 *
 * ## What is sent, and what is deliberately not
 *
 * The request body carries exactly seven fields: `paperId`, and a `draft` of
 * `title` / `abstract` / `keywords` / `studyType`, plus `currentProjectIds` and
 * `currentTagIds`. `paperId` establishes *ownership* — the server re-reads the
 * row under the caller's RLS — while the draft supplies *content*, taken from
 * Edit Paper's unsaved form state rather than the stored row, because the user
 * is asking about what they are typing right now.
 *
 * Nothing else about the paper or the user goes out: no authors, journal,
 * notes, TLDR, statistical methods, PMID, DOI, URLs, attachments, user id,
 * email or quota state. {@link buildSuggestOrganizationBody} is the single
 * place that constructs the body, so that boundary is one testable function
 * rather than a property of a call site.
 *
 * ## Why this duplicates the token dance in `searchPubMedEdge.ts`
 *
 * Same reason that wrapper duplicates the importer's: `supabase.functions
 * .invoke()` reads its internal token asynchronously via `onAuthStateChange`
 * and can send a stale one, so each caller obtains a fresh token, passes
 * `Authorization` explicitly, and refreshes-and-retries exactly once on a
 * genuine HTTP 401. Extracting it now would mean editing two proven clients
 * during an unrelated feature. The duplication is deliberate and bounded.
 *
 * ## Refs never cross this boundary
 *
 * The server replaces database ids with request-local `P1`/`T1` refs before
 * anything reaches the model, and maps them back itself. The browser therefore
 * never sees a ref, and {@link parseSuggestions} never invents an id: an
 * `existingProjects` entry without a plain string `id` from the server is
 * dropped, so no model-generated string can become a selectable UUID.
 */

import { supabase } from "@/integrations/supabase/client";
import { parseAiEdgeError, type QuotaExceededInfo } from "@/lib/analyzeError";

/** The Edge Function slug. Exported so tests and route mocks agree on it. */
export const SUGGEST_ORGANIZATION_FUNCTION = "suggest-paper-organization";

/**
 * The bounded slice of Edit Paper's *current, unsaved* draft the endpoint
 * accepts. Mirrors `PaperDraft` in the Edge contract.
 */
export interface PaperOrganizationDraft {
  title: string;
  abstract?: string | null;
  keywords?: string[];
  studyType?: string | null;
}

/** Everything the wrapper needs to build one request. */
export interface SuggestOrganizationInput {
  paperId: string;
  draft: PaperOrganizationDraft;
  currentProjectIds?: string[];
  currentTagIds?: string[];
}

/** A Project the user already owns, recommended for this paper. */
export interface ExistingProjectSuggestion {
  /** A real `projects.id`, resolved server-side. Never model-generated. */
  id: string;
  name: string;
  reason: string;
}

/** A Tag the user already owns, recommended for this paper. */
export interface ExistingTagSuggestion {
  /** A real `tags.id`, resolved server-side. Never model-generated. */
  id: string;
  name: string;
  reason: string;
}

/** A Project the model proposes creating. It does not exist yet. */
export interface NewProjectSuggestion {
  name: string;
  description: string | null;
  reason: string;
}

/** A Tag the model proposes creating. It does not exist yet. */
export interface NewTagSuggestion {
  name: string;
  reason: string;
}

/** The success payload. All four arrays are always present; any may be empty. */
export interface OrganizationSuggestions {
  existingProjects: ExistingProjectSuggestion[];
  existingTags: ExistingTagSuggestion[];
  newProjects: NewProjectSuggestion[];
  newTags: NewTagSuggestion[];
}

/**
 * How a failure should be presented. The classes are the ones Edit Paper
 * genuinely renders differently — an expired session, a draft the server
 * refused, a paper that is gone, the Paperlume allowance wall, and an upstream
 * provider problem that is *not* a wall.
 */
export type SuggestOrganizationErrorKind =
  | "auth"
  | "validation"
  | "paper_not_found"
  | "quota_exceeded"
  | "provider_failure"
  | "unexpected";

/**
 * A failure Edit Paper can describe to the user.
 *
 * `message` is always already user-safe: it is either written here or is the
 * Edge Function's own deliberate user-facing copy. Raw provider bodies, Google
 * operational detail, API keys, tokens and internal envelopes are never
 * carried — the neutral 500 message the server sends for every provider class
 * is the whole of what a provider failure says.
 *
 * `quota` is populated **only** for `kind: "quota_exceeded"`, from the
 * structured 402 body, so the caller can render the same allowance copy the
 * analysis paths use.
 */
export class SuggestOrganizationError extends Error {
  readonly kind: SuggestOrganizationErrorKind;
  readonly quota: QuotaExceededInfo | null;

  constructor(
    kind: SuggestOrganizationErrorKind,
    message: string,
    quota: QuotaExceededInfo | null = null,
  ) {
    super(message);
    this.name = "SuggestOrganizationError";
    this.kind = kind;
    this.quota = quota;
  }
}

const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please sign in again.";
const GENERIC_FAILURE_MESSAGE = "AI suggestions could not be generated. Please try again.";

/**
 * The neutral copy for a provider-side failure. The server sends its own
 * wording, which is preferred when present; this is the fallback for a 500
 * whose body could not be read. Deliberately says nothing about a plan: a
 * Google 429/503 is not the user running out of AI requests.
 */
export const SUGGESTIONS_UNAVAILABLE_MESSAGE =
  "AI suggestions are temporarily unavailable. Please try again later.";

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
 * Whether an invocation error *message* indicates an authentication failure.
 * Fallback path only — see {@link isAuthFailure}.
 */
function isAuthErrorMessage(message: string): boolean {
  return (
    message.includes("401") ||
    message.includes("Unauthorized") ||
    message.includes("Invalid JWT") ||
    message.toLowerCase().includes("jwt")
  );
}

/**
 * Whether a failed `supabase.functions.invoke` is an authentication failure.
 *
 * The status is the authority when there is one. A real non-2xx does NOT
 * describe itself: `supabase-js` raises the same generic *"Edge Function
 * returned a non-2xx status code"* for a 401, a 402 and a 500 alike and puts
 * the `Response` on `error.context`. Deciding from the message alone would
 * mean the refresh-and-retry branch never runs for a genuine 401 — and would
 * also spend a refresh on a 500 whose body merely contains the digits `401`.
 */
function isAuthFailure(error: { message?: string; context?: unknown }): boolean {
  if (error.context instanceof Response) {
    return error.context.status === 401;
  }
  return isAuthErrorMessage(error.message ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string after trimming, or null. */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Longest `reason` this client will render. The server already bounds it at
 * 400 characters; this is the browser refusing to paint an unbounded string if
 * a future deployment ever stopped doing so.
 */
const MAX_RENDERED_REASON_LENGTH = 400;

/** A usable reason: present, non-empty and bounded. */
function toReason(value: unknown): string | null {
  const reason = nonEmptyString(value);
  if (!reason) return null;
  return reason.length > MAX_RENDERED_REASON_LENGTH ? null : reason;
}

/**
 * Validate one existing-entity suggestion.
 *
 * The `id` must be a plain non-empty string that the *server* produced by
 * resolving its own ref map. There is no fallback that derives an id from a
 * name, a ref or an index — an entry missing a usable id is dropped, because
 * an id is the thing that would later be written to `paper_projects` /
 * `paper_tags`, and guessing it is how a model string becomes a real row.
 */
function toExistingSuggestion(
  value: unknown,
): { id: string; name: string; reason: string } | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.trim() === "") return null;
  const name = nonEmptyString(value.name);
  if (!name) return null;
  const reason = toReason(value.reason);
  if (!reason) return null;
  return { id: value.id, name, reason };
}

/** Validate one proposed-new Project. `description` is nullable, never absent. */
function toNewProjectSuggestion(value: unknown): NewProjectSuggestion | null {
  if (!isRecord(value)) return null;
  const name = nonEmptyString(value.name);
  if (!name) return null;
  if (value.description !== null && typeof value.description !== "string") return null;
  const reason = toReason(value.reason);
  if (!reason) return null;
  return { name, description: nonEmptyString(value.description), reason };
}

/** Validate one proposed-new Tag. */
function toNewTagSuggestion(value: unknown): NewTagSuggestion | null {
  if (!isRecord(value)) return null;
  const name = nonEmptyString(value.name);
  if (!name) return null;
  const reason = toReason(value.reason);
  if (!reason) return null;
  return { name, reason };
}

/**
 * Validate the whole success payload, or return `null` to reject it.
 *
 * The function is trusted to be the right function, not the right *version* of
 * it. A response missing any of the four categories is refused outright rather
 * than treated as "that category had nothing to say" — a deployment serving a
 * different contract must fail honestly, not silently render three quarters of
 * an answer. Within a present category, an individual unusable entry is
 * dropped: one malformed row should not discard the suggestions beside it.
 *
 * Note the asymmetry is deliberate. A **missing category** is a contract
 * mismatch; a **bad item** is one bad row.
 */
export function parseSuggestions(data: unknown): OrganizationSuggestions | null {
  if (!isRecord(data)) return null;
  if (
    !Array.isArray(data.existingProjects) ||
    !Array.isArray(data.existingTags) ||
    !Array.isArray(data.newProjects) ||
    !Array.isArray(data.newTags)
  ) {
    return null;
  }

  const existingProjects: ExistingProjectSuggestion[] = [];
  for (const entry of data.existingProjects) {
    const parsed = toExistingSuggestion(entry);
    if (parsed) existingProjects.push(parsed);
  }

  const existingTags: ExistingTagSuggestion[] = [];
  for (const entry of data.existingTags) {
    const parsed = toExistingSuggestion(entry);
    if (parsed) existingTags.push(parsed);
  }

  const newProjects: NewProjectSuggestion[] = [];
  for (const entry of data.newProjects) {
    const parsed = toNewProjectSuggestion(entry);
    if (parsed) newProjects.push(parsed);
  }

  const newTags: NewTagSuggestion[] = [];
  for (const entry of data.newTags) {
    const parsed = toNewTagSuggestion(entry);
    if (parsed) newTags.push(parsed);
  }

  return { existingProjects, existingTags, newProjects, newTags };
}

/** True when every category came back empty — a valid, honest "nothing fits". */
export function isEmptySuggestions(suggestions: OrganizationSuggestions): boolean {
  return (
    suggestions.existingProjects.length === 0 &&
    suggestions.existingTags.length === 0 &&
    suggestions.newProjects.length === 0 &&
    suggestions.newTags.length === 0
  );
}

/**
 * Build the request body — the privacy boundary, in one testable place.
 *
 * Only the allow-listed fields are copied, by name. `abstract` and `studyType`
 * are normalized to `null` when blank so a whitespace-only field is not sent
 * as evidence the server would then have to reason about.
 */
export function buildSuggestOrganizationBody(input: SuggestOrganizationInput): {
  paperId: string;
  draft: { title: string; abstract: string | null; keywords: string[]; studyType: string | null };
  currentProjectIds: string[];
  currentTagIds: string[];
} {
  const { draft } = input;
  return {
    paperId: input.paperId,
    draft: {
      title: draft.title,
      abstract: nonEmptyString(draft.abstract),
      keywords: Array.isArray(draft.keywords) ? draft.keywords : [],
      studyType: nonEmptyString(draft.studyType),
    },
    currentProjectIds: input.currentProjectIds ?? [],
    currentTagIds: input.currentTagIds ?? [],
  };
}

/**
 * Turn a failed invocation into a typed, user-safe error.
 *
 * The 402 and the structured 500 are read through the shared
 * {@link parseAiEdgeError} — the same parser the analysis paths use — so the
 * Paperlume allowance wall and an upstream provider failure can never be
 * confused for one another. Every other status falls back to status-derived
 * copy, preferring the function's own `message` when the body carries one.
 */
async function describeFunctionError(
  error: { message?: string; context?: unknown },
): Promise<SuggestOrganizationError> {
  const parsed = await parseAiEdgeError(error, "suggestions_unavailable");

  if (parsed.kind === "quota_exceeded") {
    return new SuggestOrganizationError("quota_exceeded", parsed.info.message, parsed.info);
  }
  if (parsed.kind === "provider_failure") {
    // The machine class (`provider_rate_limit`, `provider_unavailable`, …) is
    // deliberately NOT surfaced: the server's neutral sentence is the whole of
    // what the user sees, and none of these classes is a plan wall.
    return new SuggestOrganizationError("provider_failure", parsed.message);
  }

  const context = error.context;
  if (context instanceof Response) {
    const status = context.status;
    let message: string | null = null;
    try {
      const body: unknown = await context.clone().json();
      if (isRecord(body)) {
        message = nonEmptyString(body.message);
      }
    } catch {
      // Body unreadable or not JSON — fall through to status-based copy.
    }

    if (status === 401) {
      return new SuggestOrganizationError("auth", SESSION_EXPIRED_MESSAGE);
    }
    if (status === 400) {
      // The server's 400 copy is deliberate, user-facing guidance (insufficient
      // evidence, a stale selection, a taxonomy too large). Prefer it verbatim.
      return new SuggestOrganizationError(
        "validation",
        message ?? "Suggestions could not be generated for this draft.",
      );
    }
    if (status === 404) {
      return new SuggestOrganizationError("paper_not_found", message ?? "That paper could not be found.");
    }
    if (status === 500) {
      // A 500 that did NOT parse as a structured provider failure (an
      // `internal_error`, or an unreadable body). Neutral wording either way.
      return new SuggestOrganizationError("provider_failure", SUGGESTIONS_UNAVAILABLE_MESSAGE);
    }
    return new SuggestOrganizationError("unexpected", message ?? GENERIC_FAILURE_MESSAGE);
  }

  const raw = error.message ?? "";
  if (isAuthErrorMessage(raw)) {
    return new SuggestOrganizationError("auth", SESSION_EXPIRED_MESSAGE);
  }
  return new SuggestOrganizationError("unexpected", GENERIC_FAILURE_MESSAGE);
}

/**
 * Ask for organization suggestions for one paper draft.
 *
 * Called only from an explicit user gesture — never on open, on typing, or on
 * save. One call spends one AI request server-side.
 *
 * @throws {SuggestOrganizationError} for every failure, already classified and
 *         already described in words Edit Paper can show.
 */
export async function suggestPaperOrganization(
  input: SuggestOrganizationInput,
): Promise<OrganizationSuggestions> {
  const body = buildSuggestOrganizationBody(input);

  // Fresh token BEFORE the call, passed explicitly, because
  // `supabase.functions.invoke()`'s internal token can be stale.
  const accessToken = await getFreshAccessToken();
  if (!accessToken) {
    throw new SuggestOrganizationError("auth", SESSION_EXPIRED_MESSAGE);
  }

  let response = await supabase.functions.invoke(SUGGEST_ORGANIZATION_FUNCTION, {
    body,
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Exactly one refresh-and-retry on an auth failure, recognised from the HTTP
  // status rather than the generic invoke message. Never a loop: a second 401
  // after a successful refresh is a real authentication problem, and retrying
  // would only delay telling the user — and each attempt is a request the
  // server may charge for.
  if (response.error && isAuthFailure(response.error)) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData.session) {
      throw new SuggestOrganizationError("auth", SESSION_EXPIRED_MESSAGE);
    }
    response = await supabase.functions.invoke(SUGGEST_ORGANIZATION_FUNCTION, {
      body,
      headers: { Authorization: `Bearer ${refreshData.session.access_token}` },
    });
  }

  if (response.error) {
    throw await describeFunctionError(response.error);
  }

  const suggestions = parseSuggestions(response.data);
  if (!suggestions) {
    // A well-formed HTTP 200 this client cannot trust. Refusing is the honest
    // outcome: the alternative is rendering a partial contract as if it were
    // the whole answer. The unit is already spent server-side and this client
    // deliberately does not fabricate a refund.
    throw new SuggestOrganizationError(
      "unexpected",
      "AI suggestions came back in an unexpected format. Please try again.",
    );
  }

  return suggestions;
}
