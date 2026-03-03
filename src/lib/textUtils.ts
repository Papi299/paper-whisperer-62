/**
 * Shared text utilities for keyword extraction, negation detection, and regex escaping.
 * Single source of truth — used by normalizePaperData, evaluateStudyType, and useKeywordPool.
 */

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
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[-–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Context-aware keyword extraction from text.
 * Uses word-boundary regex matching and checks a 4-word preceding window
 * for negation triggers to prevent false positives.
 */
export function extractContextualKeywords(
  text: string,
  poolKeywords: string[]
): string[] {
  const normalized = normalizeText(text);
  const matched: string[] = [];

  for (const keyword of poolKeywords) {
    const pattern = new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`, "gi");
    let match: RegExpExecArray | null;
    let hasValidMatch = false;

    while ((match = pattern.exec(normalized)) !== null) {
      const precedingText = normalized.slice(0, match.index).trimEnd();
      const precedingWords = precedingText.split(/\s+/).slice(-4).join(" ");

      const isNegated = NEGATION_TRIGGERS.some(trigger => {
        const triggerPattern = new RegExp(`\\b${escapeRegExp(trigger)}\\b`, "i");
        return triggerPattern.test(precedingWords);
      });

      if (!isNegated) {
        hasValidMatch = true;
        break;
      }
    }

    if (hasValidMatch) {
      matched.push(keyword);
    }
  }

  return matched;
}
