import type { Paper } from "@/types/database";

/**
 * Pure helpers around `study_type` and the AI-analysis update payload.
 *
 * Lifted verbatim from inline definitions in `src/pages/Dashboard.tsx`
 * (which previously held the canonical implementations of the smart-merge
 * ternary and the analysis-result payload builder) and from the duplicate
 * `isGenericStudyType` predicate in `src/components/papers/EditPaperDialog.tsx`.
 *
 * **No behavior change** vs. the inline code that lived in those two files
 * before this module existed. In particular, this module deliberately does
 * NOT replicate `EditPaperDialog`'s extra `"Not specified"` filter on
 * `aiData.studyType` / `aiData.statisticalMethods` — `Dashboard.tsx` has
 * always passed those values through verbatim, and that asymmetry between
 * the two surfaces is intentional. If we ever decide Dashboard should also
 * filter the `"Not specified"` Gemini sentinel, that is a separate
 * behavior-change PR with its own tests.
 */

/**
 * Whether a paper's `study_type` should be treated as "generic" — i.e.
 * uninformative enough that an AI-suggested study type may safely overwrite
 * it. Returns `true` for null / undefined / empty / whitespace-only inputs
 * and for the case-insensitive PubMed catch-all `"journal article"` (with
 * surrounding whitespace tolerated).
 *
 * Used at the top of the smart merge in
 * {@link resolveStudyTypeAfterAnalysis} and
 * {@link buildAnalysisUpdates}, and as the `keptExisting` predicate in
 * `EditPaperDialog`'s AI-analyze flow.
 */
export function isGenericStudyType(type: string | null | undefined): boolean {
  return !type || type.trim() === "" || type.trim().toLowerCase() === "journal article";
}

/**
 * Smart-merge for `study_type` after AI analysis: if the existing
 * `study_type` is generic (per {@link isGenericStudyType}), accept the
 * AI-suggested value; otherwise keep the existing value verbatim.
 *
 * Preserves the exact `??` (nullish-coalescing) operator from the
 * original `Dashboard.tsx` ternary — when the existing type is generic
 * and the AI omits a `studyType`, we fall back to the existing value
 * rather than nulling it out.
 */
export function resolveStudyTypeAfterAnalysis(
  existing: string | null | undefined,
  aiSuggested: string | undefined,
): string | null | undefined {
  return isGenericStudyType(existing) ? (aiSuggested ?? existing) : existing;
}

/** The narrow shape of the update payload `Dashboard.tsx` sends to
 *  `updatePaper` after AI analysis. */
export type AnalysisUpdates = Pick<
  Paper,
  "tldr" | "study_type" | "statistical_methods"
>;

/** The shape of the `analyze-paper` Edge Function's success response (as
 *  consumed by Dashboard). All three fields are optional because the cast
 *  in `Dashboard.tsx` is `as { tldr?: string; studyType?: string; statisticalMethods?: string }`. */
export interface AnalysisAiData {
  tldr?: string;
  studyType?: string;
  statisticalMethods?: string;
}

/**
 * Build the update payload that `Dashboard.tsx`'s AI-analysis flows send
 * to `updatePaper`, plus the boolean that drives the success-toast
 * description ("Kept existing study type from PubMed" vs the standard
 * line).
 *
 * Operator semantics — preserved verbatim from the original
 * `Dashboard.tsx` inline code:
 *
 *   - `study_type`: `??` (nullish-coalescing) via {@link resolveStudyTypeAfterAnalysis}
 *     — only fall back to the existing value if the AI omitted `studyType`.
 *   - `tldr`, `statistical_methods`: `||` (truthy fallback) — fall back to
 *     the existing value when the AI returns `""` or any other falsy value.
 *
 * `keptStudyType` is a strict `boolean` derived from the exact predicate
 * at `Dashboard.tsx:491`:
 *
 *   `Boolean(!isGenericStudyType(existing) && aiData.studyType && aiData.studyType !== existing)`
 *
 * **`"Not specified"` is NOT filtered here.** The original `Dashboard.tsx`
 * code does not filter the Gemini sentinel; this helper documents that
 * current behavior. (`EditPaperDialog.tsx` does filter it, and the two
 * surfaces are intentionally asymmetric.)
 */
export function buildAnalysisUpdates(
  paper: Pick<Paper, "tldr" | "study_type" | "statistical_methods">,
  aiData: AnalysisAiData,
): { updates: AnalysisUpdates; keptStudyType: boolean } {
  const updates: AnalysisUpdates = {
    tldr: aiData.tldr || paper.tldr,
    // `paper.study_type` is `string | null` here, so the resolver never returns
    // `undefined`; `?? null` collapses the resolver's wider `| undefined` return
    // to the field's `string | null` without altering runtime behavior.
    study_type: resolveStudyTypeAfterAnalysis(paper.study_type, aiData.studyType) ?? null,
    statistical_methods: aiData.statisticalMethods || paper.statistical_methods,
  };
  const keptStudyType = Boolean(
    !isGenericStudyType(paper.study_type) &&
      aiData.studyType &&
      aiData.studyType !== paper.study_type,
  );
  return { updates, keptStudyType };
}
