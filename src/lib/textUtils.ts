/**
 * Shared text utilities for keyword extraction, negation detection, and regex escaping.
 * Single source of truth — used by normalizePaperData, evaluateStudyType, and useKeywordPool.
 */

import { scanLexicalTerms } from "./lexicalTerms";

export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const NEGATION_TRIGGERS = [
  "no", "not", "without", "excluding", "excluded",
  "lack of", "ruled out", "absence of", "neither",
  "nor", "unable to", "failed to", "non"
];

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[-–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the 4-word window preceding `normalizedStart` contains a negation
 * trigger. Operates on the normalized comparison text, so offsets must come
 * from the same scan.
 */
function isNegatedAt(normalizedText: string, normalizedStart: number): boolean {
  const precedingText = normalizedText.slice(0, normalizedStart).trimEnd();
  const precedingWords = precedingText.split(/\s+/).slice(-4).join(" ");

  return NEGATION_TRIGGERS.some(trigger => {
    const triggerPattern = new RegExp(`\\b${escapeRegExp(trigger)}\\b`, "i");
    return triggerPattern.test(precedingWords);
  });
}

/**
 * Context-aware keyword extraction from text.
 *
 * Two distinct layers, deliberately kept apart:
 *  1. `scanLexicalTerms` decides where each pool term genuinely occurs — the
 *     same lexical contract the abstract highlighter renders, so extraction and
 *     highlighting can no longer disagree about what counts as a term;
 *  2. this function then rejects occurrences whose 4-word preceding window
 *     holds a negation trigger.
 *
 * A keyword is accepted when at least one of its lexical occurrences survives
 * the negation check.
 */
export function extractContextualKeywords(
  text: string,
  poolKeywords: string[]
): string[] {
  const { normalizedText, matches } = scanLexicalTerms(text, poolKeywords);
  const accepted = new Set<number>();

  for (const match of matches) {
    if (accepted.has(match.termIndex)) continue;
    if (!isNegatedAt(normalizedText, match.normalizedStart)) {
      accepted.add(match.termIndex);
    }
  }

  // Filtering the input preserves pool order (and any duplicate entries).
  return poolKeywords.filter((_, index) => accepted.has(index));
}
