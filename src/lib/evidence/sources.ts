/**
 * The saved copy of an abstract versus the abstract in the library
 * (EVIDENCE-RECORDS-001B; Requirements-001A §E2, PR-A2 source capture).
 *
 * A study record quotes an immutable copy saved by the server. The library
 * abstract can change afterwards — an edit, a merge filling it in, a removal.
 * These helpers say how the two relate, for a banner and its actions. They are
 * informational: they compare text the browser was given, and the server
 * re-checks everything when the user acts.
 *
 * Equality is exact string equality (equivalent to equal `exact_sha256`, the
 * SHA-256 of the UTF-8 bytes) and, for the typography-only case, equality after
 * normalization v1 (equivalent to equal `normalized_sha256`). Each text is
 * normalized once, from its original. No hashing happens here, so no browser
 * crypto API is needed.
 */

import { codePointLength, isNormalizationEmpty, normalizeEvidenceV1 } from "./normalization";

/** The longest abstract a copy can hold (PR-A1 `evidence_source_snapshots_exact_text_check`; PR-A2). */
export const ABSTRACT_MAX_LENGTH = 50_000;

export type CaptureExpectation =
  | { readonly kind: "copy" }
  | { readonly kind: "no_copy"; readonly reason: "no_abstract" | "empty_after_normalization" }
  | { readonly kind: "refused"; readonly reason: "abstract_too_long" };

/**
 * What creating a study from a paper with `abstract` will do about a copy —
 * the order of `evidence_create_study_from_paper`, exactly: no abstract, no
 * copy; longer than 50,000 characters, the create is refused (checked BEFORE
 * emptiness, so a long all-white-space abstract is refused too); empty after
 * v1, no copy; otherwise a copy.
 */
export function expectSourceCapture(abstract: string | null): CaptureExpectation {
  if (abstract === null) return { kind: "no_copy", reason: "no_abstract" };
  if (codePointLength(abstract) > ABSTRACT_MAX_LENGTH) return { kind: "refused", reason: "abstract_too_long" };
  if (isNormalizationEmpty(abstract)) return { kind: "no_copy", reason: "empty_after_normalization" };
  return { kind: "copy" };
}

export type SourceState =
  | { readonly kind: "no_copy_no_abstract" }
  | { readonly kind: "abstract_now_available"; readonly capture: "allowed" | "refused_too_long" }
  | { readonly kind: "current" }
  | { readonly kind: "typography_only_change"; readonly defaultAction: "keep_saved_copy" }
  | { readonly kind: "content_change" }
  | { readonly kind: "abstract_removed" };

/**
 * How a link's current copy relates to the library abstract now. A
 * typography-only difference keeps the saved copy by default: nothing is sent
 * and no review changes unless the user chooses to use the current abstract.
 */
export function deriveSourceState(currentCopyText: string | null, libraryAbstract: string | null): SourceState {
  const abstractEmpty = libraryAbstract === null || isNormalizationEmpty(libraryAbstract);
  if (currentCopyText === null) {
    if (abstractEmpty) return { kind: "no_copy_no_abstract" };
    return {
      kind: "abstract_now_available",
      capture: codePointLength(libraryAbstract as string) > ABSTRACT_MAX_LENGTH ? "refused_too_long" : "allowed",
    };
  }
  if (abstractEmpty) return { kind: "abstract_removed" };
  if (currentCopyText === libraryAbstract) return { kind: "current" };
  if (normalizeEvidenceV1(currentCopyText) === normalizeEvidenceV1(libraryAbstract as string)) {
    return { kind: "typography_only_change", defaultAction: "keep_saved_copy" };
  }
  return { kind: "content_change" };
}

/** Banner copy per state (Requirements-001 §E2, §E9; 001A §E2). Null where nothing is shown. */
export const SOURCE_STATE_MESSAGES: Readonly<Record<SourceState["kind"], string | null>> = Object.freeze({
  no_copy_no_abstract:
    "This paper has no abstract in your library. You can still record values with references to the full text, which PaperLume can't check.",
  abstract_now_available: "This paper now has an abstract. Save a copy to quote from it.",
  current: null,
  typography_only_change:
    "The abstract in your library differs only in spacing or punctuation style. Your quotes still match the saved copy.",
  content_change:
    "The abstract in your library has changed since this record's source copy was saved. Your quotes still point to the saved copy.",
  abstract_removed: "The abstract was removed from your library. Your record keeps its saved copy.",
});
