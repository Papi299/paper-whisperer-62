/**
 * Standalone study type evaluation utility.
 * Extracted from normalizePaperData for reuse in dynamic re-evaluation.
 *
 * Single-winner logic: scan title+abstract for pool study types (case-insensitive),
 * sort matches by hierarchy_rank ASC, break ties by string length DESC.
 */

import { escapeRegExp } from "./textUtils";

const IGNORED_PUBLICATION_TYPES = new Set([
  "journal article",
]);

/** Drop publication types that carry no study-design meaning of their own. */
function removeGenericTypes(types: string[]): string[] {
  return types.filter(t => t && !IGNORED_PUBLICATION_TYPES.has(t.toLowerCase()));
}

/**
 * Recover individual publication types from the legacy comma-joined string.
 *
 * This is lossy: an official PubMed publication type may contain a comma of its
 * own ("Clinical Trial, Phase II", "Research Support, N.I.H., Extramural"), and
 * once joined there is no way to tell that comma from a separator. Callers that
 * still know the real boundaries pass `publicationTypes` instead.
 */
function splitRawTypes(rawStudyType: string | null): string[] {
  return (rawStudyType || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

export interface StudyTypePoolEntry {
  study_type: string;
  specificity_weight: number;
  hierarchy_rank: number;
}

/**
 * Evaluate the winning study type for a paper given its title, abstract,
 * raw API study type string, and the user's study type pool.
 *
 * `publicationTypes` is the optional structured form of the same information,
 * supplied by sources that know where one publication type ends and the next
 * begins (a native NBIB file's repeated `PT` fields). When present it is used
 * verbatim, so punctuation inside a single official type cannot split it.
 * Callers that only have the legacy joined string keep their existing behavior.
 */
export function evaluateStudyType(
  title: string,
  abstract: string | null,
  rawStudyType: string | null,
  pool: StudyTypePoolEntry[],
  publicationTypes?: string[]
): string {
  const textToSearch = [title, abstract || ""].join(" ");
  const matches: StudyTypePoolEntry[] = [];

  // Individual publication types to check against the pool: the caller's own
  // values when it supplied them, otherwise recovered from the joined string.
  const structuredTypes = (publicationTypes || []).map(t => t.trim()).filter(Boolean);
  const rawTypes = structuredTypes.length > 0 ? structuredTypes : splitRawTypes(rawStudyType);

  for (const st of pool) {
    try {
      // Check title + abstract
      const regex = new RegExp('\\b' + escapeRegExp(st.study_type) + '\\b', 'i');
      if (regex.test(textToSearch)) {
        matches.push(st);
        continue;
      }
      // Check each individual publication type
      for (const rawType of rawTypes) {
        if (rawType.toLowerCase() === st.study_type.toLowerCase()) {
          matches.push(st);
          break;
        }
      }
    } catch {
      // skip invalid regex
    }
  }

  // No pool winner: fall back to the publication types themselves, minus the
  // generic ones. Generic removal compares whole values, so a comma-bearing
  // type survives intact when the caller supplied structured types.
  if (matches.length === 0) {
    return removeGenericTypes(rawTypes).join(", ");
  }

  // Sort by hierarchy_rank ASC (lower = better), then by string length DESC (longer = more specific)
  matches.sort((a, b) => {
    const rankDiff = (a.hierarchy_rank || 99) - (b.hierarchy_rank || 99);
    if (rankDiff !== 0) return rankDiff;
    return b.study_type.length - a.study_type.length;
  });

  return matches[0].study_type;
}
