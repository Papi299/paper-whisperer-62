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

function stripGenericTypes(raw: string): string {
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(s => s && !IGNORED_PUBLICATION_TYPES.has(s.toLowerCase()))
    .join(", ");
}

export interface StudyTypePoolEntry {
  study_type: string;
  specificity_weight: number;
  hierarchy_rank: number;
}

/**
 * Evaluate the winning study type for a paper given its title, abstract,
 * raw API study type string, and the user's study type pool.
 */
export function evaluateStudyType(
  title: string,
  abstract: string | null,
  rawStudyType: string | null,
  pool: StudyTypePoolEntry[]
): string {
  const textToSearch = [title, abstract || ""].join(" ");
  const matches: StudyTypePoolEntry[] = [];

  // Split raw publication types (e.g. "Randomized Controlled Trial, Multicenter Study")
  // into individual strings and check each against the pool
  const rawTypes = (rawStudyType || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  for (const st of pool) {
    try {
      // Check title + abstract
      const regex = new RegExp('\\b' + escapeRegExp(st.study_type) + '\\b', 'i');
      if (regex.test(textToSearch)) {
        matches.push(st);
        continue;
      }
      // Check each individual publication type from the API
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

  if (matches.length === 0) {
    return stripGenericTypes(rawStudyType || "");
  }

  // Sort by hierarchy_rank ASC (lower = better), then by string length DESC (longer = more specific)
  matches.sort((a, b) => {
    const rankDiff = (a.hierarchy_rank || 99) - (b.hierarchy_rank || 99);
    if (rankDiff !== 0) return rankDiff;
    return b.study_type.length - a.study_type.length;
  });

  return matches[0].study_type;
}
