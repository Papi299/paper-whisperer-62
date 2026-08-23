/**
 * suggest-paper-organization — the shared contract: every bound, every type,
 * and the two user-facing constants the handler is allowed to say out loud.
 *
 * AI-PROJECT-TAG-SUGGESTIONS-001A.
 *
 * Everything here is a plain value or a type. No Deno API, no remote import, no
 * I/O — so Vitest imports this module directly and the numbers the shipped code
 * enforces are the numbers the tests assert.
 *
 * ## Why the bounds are explicit constants
 *
 * The provider is not the validator. Gemini's own token ceiling is a property of
 * the model of the day, not a contract this endpoint can rely on: a model swap
 * would silently move it. Each limit below is therefore a decision this function
 * owns, is enforced *before* a quota unit is spent, and is covered by a test.
 *
 * ## Input bounds, and why these numbers
 *
 * The realistic worst case is a heavy user: ~100 Projects with short
 * descriptions and a few hundred Tags, plus one full abstract. That serializes
 * to roughly 15–20k characters, comfortably inside
 * `MAX_PROVIDER_INPUT_CHARS`. The per-entity limits exist so a single
 * pathological row (a 40 KB "description" pasted into a Project) cannot
 * dominate the request; the total limit exists so a merely-large-everything
 * account still cannot.
 *
 * Neither `projects.name` nor `tags.name` has a length constraint in the
 * database, so a name *can* exceed `MAX_PROJECT_NAME_LENGTH`. That case fails
 * honestly (§10 of the task: never silently truncate) rather than being trimmed,
 * because a truncated name is a name the model may fail to match and then
 * propose again as "new".
 */

// ── Input bounds: the paper draft ─────────────────────────────────────────

export const MAX_TITLE_LENGTH = 1_000;
export const MAX_ABSTRACT_LENGTH = 20_000;
export const MAX_KEYWORDS = 60;
export const MAX_KEYWORD_LENGTH = 200;
export const MAX_STUDY_TYPE_LENGTH = 200;

// ── Input bounds: the caller's taxonomy ───────────────────────────────────

export const MAX_PROJECTS = 100;
export const MAX_PROJECT_NAME_LENGTH = 200;
export const MAX_PROJECT_DESCRIPTION_LENGTH = 500;
export const MAX_TAGS = 200;
export const MAX_TAG_NAME_LENGTH = 200;

/**
 * Advisory "already selected" references from the request. Bounded by the same
 * numbers as the taxonomy itself — a caller cannot claim more current
 * assignments than they could possibly own.
 */
export const MAX_CURRENT_PROJECT_IDS = MAX_PROJECTS;
export const MAX_CURRENT_TAG_IDS = MAX_TAGS;

/**
 * Hard ceiling on the serialized provider payload. Checked on the exact string
 * that would be sent, after every per-field bound has already passed, so no
 * combination of individually-legal fields can exceed it.
 */
export const MAX_PROVIDER_INPUT_CHARS = 60_000;

// ── Output bounds: what may come back ─────────────────────────────────────

export const MAX_EXISTING_PROJECT_SUGGESTIONS = 3;
export const MAX_EXISTING_TAG_SUGGESTIONS = 5;
export const MAX_NEW_PROJECT_SUGGESTIONS = 2;
export const MAX_NEW_TAG_SUGGESTIONS = 3;

export const MAX_REASON_LENGTH = 400;
export const MAX_NEW_PROJECT_NAME_LENGTH = 100;
export const MAX_NEW_PROJECT_DESCRIPTION_LENGTH = 300;
export const MAX_NEW_TAG_NAME_LENGTH = 60;

/**
 * Absurd-length ceiling applied to each provider array *before* any per-item
 * work. Above this the response is not "slightly over the cap", it is evidence
 * the model ignored the contract, and the whole response is rejected rather
 * than trimmed. Between the category cap and this ceiling, the array is capped
 * deterministically (see `parse.ts`).
 */
export const MAX_PROVIDER_ARRAY_ITEMS = 25;

// ── Request shape ─────────────────────────────────────────────────────────

/**
 * The bounded slice of Edit Paper's *current draft* the endpoint accepts. These
 * are the only paper fields the feature needs; nothing else is read from the
 * body, and the persisted paper is never used as a source of provider input.
 *
 * The draft is deliberately not compared against the stored row: the future UX
 * asks for suggestions about what the user is typing right now, which may not
 * be saved yet. `paperId` establishes *ownership*; `draft` supplies *content*.
 */
export interface PaperDraft {
  title: string;
  abstract?: string | null;
  keywords?: string[];
  studyType?: string | null;
}

export interface SuggestOrganizationRequest {
  paperId: string;
  draft: PaperDraft;
  currentProjectIds?: string[];
  currentTagIds?: string[];
}

// ── Taxonomy ──────────────────────────────────────────────────────────────

/** A caller-owned Project, as read from the database. `id` never leaves the server. */
export interface OwnedProject {
  id: string;
  name: string;
  description: string | null;
}

/** A caller-owned Tag, as read from the database. `id` never leaves the server. */
export interface OwnedTag {
  id: string;
  name: string;
}

// ── Provider-visible data ─────────────────────────────────────────────────

/**
 * A Project as the model sees it: a request-local ref, the semantic fields, and
 * whether it is already on the paper. No `id` field exists on this type at all,
 * which is why a UUID cannot reach the prompt by accident.
 */
export interface ProviderProject {
  ref: string;
  name: string;
  description?: string;
  alreadySelected: boolean;
}

export interface ProviderTag {
  ref: string;
  name: string;
  alreadySelected: boolean;
}

export interface ProviderPaper {
  title: string;
  abstract?: string;
  keywords?: string[];
  studyType?: string;
}

export interface ProviderInput {
  paper: ProviderPaper;
  existingProjects: ProviderProject[];
  existingTags: ProviderTag[];
}

/**
 * Server-side map from a request-local ref back to the real row. Built in the
 * same pass that builds `ProviderInput`, and the *only* way a ref becomes an
 * id — there is no name-based or fuzzy fallback anywhere in this function.
 */
export interface TaxonomyRefMap {
  projects: Map<string, OwnedProject>;
  tags: Map<string, OwnedTag>;
}

// ── Response shape ────────────────────────────────────────────────────────

export interface ExistingProjectSuggestion {
  id: string;
  name: string;
  reason: string;
}

export interface ExistingTagSuggestion {
  id: string;
  name: string;
  reason: string;
}

export interface NewProjectSuggestion {
  name: string;
  description: string | null;
  reason: string;
}

export interface NewTagSuggestion {
  name: string;
  reason: string;
}

export interface OrganizationSuggestions {
  existingProjects: ExistingProjectSuggestion[];
  existingTags: ExistingTagSuggestion[];
  newProjects: NewProjectSuggestion[];
  newTags: NewTagSuggestion[];
}

// ── User-facing strings ───────────────────────────────────────────────────

/**
 * The single message shown for every provider-side failure class, mirroring
 * `_shared/providerError.ts`'s reason for having one: the machine-readable
 * class is for logs and the manager panel, and the user never sees Google
 * operational detail. Worded for this feature rather than for analysis.
 */
export const NEUTRAL_SUGGESTIONS_UNAVAILABLE_MESSAGE =
  "Suggestions are temporarily unavailable. Please try again later.";

/** Non-disclosing message for a paper that is missing *or* owned by someone else. */
export const PAPER_NOT_FOUND_MESSAGE = "That paper could not be found.";

// ── Helpers shared by validation and prompt construction ──────────────────

/** RFC 4122 shape check. Cheap, and it keeps a non-UUID out of a database filter. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Normalize a name for identity comparison — the same normalization the
 * database's per-user unique indexes use (`(user_id, lower(name))`), plus a
 * trim, so "  Diabetes " and "diabetes" are one entity here exactly as they
 * would be one row there.
 */
export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Strip C0/C1 control characters (except the tab/newline a legitimate abstract
 * may contain) and collapse runs of whitespace. Applied to every untrusted
 * string on its way into the provider payload: it removes the invisible
 * characters that make prompt text read differently than it looks, without
 * altering any word the model needs for classification.
 */
export function sanitizeForProvider(value: string): string {
  return value
    // The rule exists to catch control characters typed by accident; here they
    // are exactly what must be removed, and they are written as escapes.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/[^\S\n]*\n[^\S\n]*/g, "\n")
    .trim();
}
