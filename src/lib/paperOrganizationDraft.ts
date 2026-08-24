/**
 * Pure draft logic for the Edit Paper organization-suggestion surface —
 * AI-PROJECT-TAG-SUGGESTIONS-001B.
 *
 * Two questions, both answerable without React: *may this draft be sent?* and
 * *is it still the same draft?* They live here rather than inside
 * `PaperOrganizationSuggestions` so each can be tested against its rule
 * directly, and so the component file exports a component and nothing else.
 */

/** The live Edit Paper draft this feature reasons about — four fields, no more. */
export interface OrganizationDraftState {
  title: string;
  abstract: string;
  /** Already parsed from the comma-separated field, exactly as Save parses it. */
  keywords: string[];
  studyType: string;
}

/**
 * A semantic fingerprint of the draft: the four fields the request actually
 * carries, and nothing else.
 *
 * Retitling counts as a change; editing Notes, the DOI or an attachment does
 * not, because none of them reaches the model and none can make a suggestion's
 * stated reason wrong. Trimming matches what {@link isDraftEligibleForSuggestions}
 * and the request builder do, so adding a trailing space is not a new draft.
 */
export function organizationDraftFingerprint(draft: OrganizationDraftState): string {
  return JSON.stringify([
    draft.title.trim(),
    draft.abstract.trim(),
    draft.keywords,
    draft.studyType.trim(),
  ]);
}

/**
 * The client-side mirror of the server's eligibility rule: a title, plus at
 * least one other semantic signal (abstract, keywords, or study type).
 *
 * Convenience only — `validation.ts` in the Edge Function re-checks it and
 * stays authoritative — but it stops the user spending an AI request to be
 * told something the browser already knew. A title alone is not enough
 * evidence to organize a paper against a personal taxonomy.
 */
export function isDraftEligibleForSuggestions(draft: OrganizationDraftState): boolean {
  if (draft.title.trim() === "") return false;
  return (
    draft.abstract.trim() !== "" || draft.keywords.length > 0 || draft.studyType.trim() !== ""
  );
}
