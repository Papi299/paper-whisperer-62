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

/**
 * Whether the library abstract could be saved as a copy: a copy holds at most
 * 50,000 characters, so a longer abstract is refused (`abstract_too_long`)
 * however it differs from the saved copy.
 */
export type SourceCapture = "allowed" | "refused_too_long";

export type SourceState =
  | { readonly kind: "no_copy_no_abstract" }
  | { readonly kind: "abstract_now_available"; readonly capture: SourceCapture }
  | { readonly kind: "current" }
  | { readonly kind: "typography_only_change"; readonly defaultAction: "keep_saved_copy"; readonly capture: SourceCapture }
  | { readonly kind: "content_change"; readonly capture: SourceCapture }
  | { readonly kind: "abstract_removed" };

/**
 * How a link's current copy relates to the library abstract now. A
 * typography-only difference keeps the saved copy by default: nothing is sent
 * and no review changes unless the user chooses to use the current abstract.
 * Every state that could lead to a new copy says whether the abstract fits in
 * one (`capture`); `current` never needs one, and an equal text always fits.
 */
export function deriveSourceState(currentCopyText: string | null, libraryAbstract: string | null): SourceState {
  const abstractEmpty = libraryAbstract === null || isNormalizationEmpty(libraryAbstract);
  if (currentCopyText === null) {
    if (abstractEmpty) return { kind: "no_copy_no_abstract" };
    return { kind: "abstract_now_available", capture: captureOf(libraryAbstract as string) };
  }
  if (abstractEmpty) return { kind: "abstract_removed" };
  if (currentCopyText === libraryAbstract) return { kind: "current" };
  if (normalizeEvidenceV1(currentCopyText) === normalizeEvidenceV1(libraryAbstract as string)) {
    return { kind: "typography_only_change", defaultAction: "keep_saved_copy", capture: captureOf(libraryAbstract as string) };
  }
  return { kind: "content_change", capture: captureOf(libraryAbstract as string) };
}

function captureOf(libraryAbstract: string): SourceCapture {
  return codePointLength(libraryAbstract) > ABSTRACT_MAX_LENGTH ? "refused_too_long" : "allowed";
}

/**
 * Banner copy per state (Requirements-001 §E2, §E9; 001A §E2). Null where
 * nothing is shown. Statements of fact only: what a user can do about a state
 * is the interface's to offer, so no message promises an action.
 * "Typography-only" is equality after normalization v1 — the characters quote
 * matching treats as the same — never a claim that two texts mean the same.
 */
export const SOURCE_STATE_MESSAGES: Readonly<Record<SourceState["kind"], string | null>> = Object.freeze({
  no_copy_no_abstract:
    "This paper has no abstract in your library. You can still record values with references to the full text, which PaperLume can't check.",
  abstract_now_available: "This paper now has an abstract in your library, but this record has no saved copy of it, so it can't be quoted.",
  current: null,
  typography_only_change:
    "The abstract in your library differs from the saved copy only in characters PaperLume's quote matching treats as the same: spacing and line breaks, quotation-mark, dash and ellipsis styles, invisible characters, or how accented letters and the micro sign are stored. This is a technical comparison, not a check that the two say the same thing. Your record keeps its saved copy, and your quotes stay on it.",
  content_change:
    "The abstract in your library has changed since this record's source copy was saved. Your quotes still point to the saved copy.",
  abstract_removed: "The abstract was removed from your library. Your record keeps its saved copy.",
});

/** Said with any state whose `capture` is `refused_too_long`. */
export const SOURCE_TOO_LONG_MESSAGE =
  "The abstract in your library is longer than 50,000 characters, the most a saved copy can hold, so PaperLume can't save a copy of it.";
