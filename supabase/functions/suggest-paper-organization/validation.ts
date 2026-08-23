/**
 * suggest-paper-organization — request validation.
 *
 * Pure. Every check here runs *before* a quota unit is consumed and before the
 * taxonomy is read, so a malformed request costs the user nothing and discloses
 * nothing about their library.
 *
 * The module answers exactly one question: "is this body a well-formed,
 * in-bounds, semantically sufficient request?" It never consults the database,
 * never trusts a field it did not explicitly read, and returns a machine
 * `reason` alongside the human message so the future UI can branch without
 * string-matching.
 *
 * ## Unknown fields are ignored, not accepted
 *
 * Only `paperId`, `draft.{title,abstract,keywords,studyType}`,
 * `currentProjectIds` and `currentTagIds` are read. Anything else in the body —
 * `user_id`, `notes`, `authors`, an entire serialized paper row — is never
 * copied into the validated request object, so it cannot reach the provider or
 * influence identity no matter what the caller sends.
 */

import {
  isUuid,
  MAX_ABSTRACT_LENGTH,
  MAX_CURRENT_PROJECT_IDS,
  MAX_CURRENT_TAG_IDS,
  MAX_KEYWORD_LENGTH,
  MAX_KEYWORDS,
  MAX_STUDY_TYPE_LENGTH,
  MAX_TITLE_LENGTH,
  type SuggestOrganizationRequest,
} from "./contract.ts";

export type ValidationResult =
  | { ok: true; request: SuggestOrganizationRequest }
  | { ok: false; reason: string; message: string };

function invalid(reason: string, message: string): ValidationResult {
  return { ok: false, reason, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an optional string field that the client may send as `null`,
 * `undefined` or a string. Anything else is a type error rather than a value to
 * coerce — a number or an object in `abstract` means the caller is confused
 * about the contract, and guessing at their intent is how bad data reaches a
 * prompt.
 */
function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false; reason: string; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, reason: "invalid_type", message: `${field} must be a string when provided.` };
  }
  if (value.length > maxLength) {
    return {
      ok: false,
      reason: "bounds_exceeded",
      message: `${field} is too long (max ${maxLength} characters).`,
    };
  }
  const trimmed = value.trim();
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

/** Validate an optional array of owned-entity UUIDs. Shape only — ownership is checked later. */
function optionalUuidArray(
  value: unknown,
  field: string,
  maxItems: number,
): { ok: true; value: string[] } | { ok: false; reason: string; message: string } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, reason: "invalid_type", message: `${field} must be an array when provided.` };
  }
  if (value.length > maxItems) {
    return {
      ok: false,
      reason: "bounds_exceeded",
      message: `${field} has too many entries (max ${maxItems}).`,
    };
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isUuid(entry)) {
      return { ok: false, reason: "invalid_id", message: `${field} must contain only valid ids.` };
    }
    // De-duplicate here so a repeated id cannot inflate the "already selected"
    // picture the model is shown.
    seen.add(entry.toLowerCase());
  }
  return { ok: true, value: [...seen] };
}

/**
 * Validate the whole request body.
 *
 * Order matters: identity (`paperId`) first, then shape, then bounds, then the
 * eligibility rule — so the cheapest and most disclosing-if-wrong checks fail
 * first.
 */
export function validateSuggestRequest(body: unknown): ValidationResult {
  if (!isPlainObject(body)) {
    return invalid("invalid_body", "A JSON object request body is required.");
  }

  if (!isUuid(body.paperId)) {
    return invalid("invalid_paper_id", "A valid paperId is required.");
  }

  if (!isPlainObject(body.draft)) {
    return invalid("invalid_draft", "A draft object is required.");
  }
  const draft = body.draft;

  // ── Title: the one unconditionally required content field ──
  if (typeof draft.title !== "string") {
    return invalid("invalid_type", "draft.title must be a string.");
  }
  if (draft.title.length > MAX_TITLE_LENGTH) {
    return invalid("bounds_exceeded", `draft.title is too long (max ${MAX_TITLE_LENGTH} characters).`);
  }
  const title = draft.title.trim();
  if (title === "") {
    return invalid("missing_title", "draft.title is required.");
  }

  const abstract = optionalString(draft.abstract, "draft.abstract", MAX_ABSTRACT_LENGTH);
  if (!abstract.ok) return invalid(abstract.reason, abstract.message);

  const studyType = optionalString(draft.studyType, "draft.studyType", MAX_STUDY_TYPE_LENGTH);
  if (!studyType.ok) return invalid(studyType.reason, studyType.message);

  // ── Keywords ──
  let keywords: string[] = [];
  if (draft.keywords !== undefined && draft.keywords !== null) {
    if (!Array.isArray(draft.keywords)) {
      return invalid("invalid_type", "draft.keywords must be an array when provided.");
    }
    if (draft.keywords.length > MAX_KEYWORDS) {
      return invalid("bounds_exceeded", `draft.keywords has too many entries (max ${MAX_KEYWORDS}).`);
    }
    for (const keyword of draft.keywords) {
      if (typeof keyword !== "string") {
        return invalid("invalid_type", "draft.keywords must contain only strings.");
      }
      if (keyword.length > MAX_KEYWORD_LENGTH) {
        return invalid(
          "bounds_exceeded",
          `A keyword is too long (max ${MAX_KEYWORD_LENGTH} characters).`,
        );
      }
      const trimmed = keyword.trim();
      // An empty or whitespace-only keyword carries no meaning; drop it rather
      // than sending the model a blank list entry to interpret.
      if (trimmed !== "") keywords.push(trimmed);
    }
    keywords = [...new Set(keywords)];
  }

  const currentProjectIds = optionalUuidArray(
    body.currentProjectIds,
    "currentProjectIds",
    MAX_CURRENT_PROJECT_IDS,
  );
  if (!currentProjectIds.ok) return invalid(currentProjectIds.reason, currentProjectIds.message);

  const currentTagIds = optionalUuidArray(body.currentTagIds, "currentTagIds", MAX_CURRENT_TAG_IDS);
  if (!currentTagIds.ok) return invalid(currentTagIds.reason, currentTagIds.message);

  // ── Eligibility ──
  //
  // A title alone is not enough evidence to organize a paper against a personal
  // taxonomy: the model would be pattern-matching a handful of words, and the
  // user would spend a quota unit on a guess. Require the title plus at least
  // one other semantic signal. This is checked last because it is the only rule
  // here that is about *meaning* rather than *shape*.
  const hasSupportingEvidence =
    abstract.value !== null || keywords.length > 0 || studyType.value !== null;
  if (!hasSupportingEvidence) {
    return invalid(
      "insufficient_evidence",
      "Add an abstract, keywords, or a study type before requesting suggestions — a title alone is not enough.",
    );
  }

  return {
    ok: true,
    request: {
      paperId: body.paperId,
      draft: {
        title,
        abstract: abstract.value,
        keywords,
        studyType: studyType.value,
      },
      currentProjectIds: currentProjectIds.value,
      currentTagIds: currentTagIds.value,
    },
  };
}
