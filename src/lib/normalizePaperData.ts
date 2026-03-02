/**
 * Centralized Paper Data Normalization Pipeline
 * 
 * Single source of truth for processing paper data before DB writes.
 * Both API fetches and manual entries MUST pass through this pipeline.
 */

import { decodeHTMLEntities } from "./decodeHTMLEntities";

// ── Helpers ──

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NEGATION_TRIGGERS = [
  "no", "not", "without", "excluding", "excluded",
  "lack of", "ruled out", "absence of", "neither",
  "nor", "unable to", "failed to", "non"
];

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[-–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Context-aware keyword extraction (negation handling) ──

function extractContextualKeywords(
  abstract: string,
  poolKeywords: string[]
): string[] {
  const normalized = normalizeText(abstract);
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

// ── Generic publication types to ignore ──

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

// ── Evidence Pyramid: Winner Takes All study type detection ──

interface PoolStudyTypeEntry {
  study_type: string;
  specificity_weight: number;
  hierarchy_rank: number;
}

function findWinnerStudyType(
  rawStudyTypeString: string | null,
  title: string,
  abstract: string | null,
  poolStudyTypes: PoolStudyTypeEntry[]
): string {
  // Find all matching subtypes from pool in title + abstract
  const textToSearch = [title, abstract || ""].join(" ");
  const matches: PoolStudyTypeEntry[] = [];

  for (const st of poolStudyTypes) {
    try {
      const regex = new RegExp('\\b' + escapeRegExp(st.study_type) + '\\b', 'i');
      if (regex.test(textToSearch)) {
        matches.push(st);
      }
    } catch {
      // skip invalid regex
    }
  }

  if (matches.length === 0) {
    // Fallback: return raw API study type with generic types stripped
    return stripGenericTypes(rawStudyTypeString || "");
  }

  // Sort by hierarchy_rank ASC (lower = better), then by string length DESC (longer = more specific)
  matches.sort((a, b) => {
    const rankDiff = (a.hierarchy_rank || 99) - (b.hierarchy_rank || 99);
    if (rankDiff !== 0) return rankDiff;
    return b.study_type.length - a.study_type.length;
  });

  console.log('Study Type Matches:', matches.map(m => `${m.study_type} (rank:${m.hierarchy_rank})`), 'Winner:', matches[0].study_type);

  return matches[0].study_type;
}

// ── Keyword normalization via synonym lookup ──

function normalizeKeywords(
  keywords: string[],
  synonymLookup: Record<string, string>
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const kw of keywords) {
    const canonical = synonymLookup[kw.toLowerCase()] || kw;
    const key = canonical.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(canonical);
    }
  }

  return result;
}

// ── Filter manually entered keywords against abstract negation rules ──

function filterKeywordsByAbstractContext(
  keywords: string[],
  abstract: string | null,
  poolKeywords: string[]
): string[] {
  if (!abstract || poolKeywords.length === 0) return keywords;

  const allPoolMatches = new Set(
    extractContextualKeywords(abstract, poolKeywords).map(k => k.toLowerCase())
  );

  return keywords.filter(kw => {
    const isInPool = poolKeywords.some(pk => pk.toLowerCase() === kw.toLowerCase());
    if (!isInPool) return true;
    return allPoolMatches.has(kw.toLowerCase());
  });
}

// ── Synonym-based keyword extraction with negation awareness ──

function extractSynonymKeywords(
  title: string,
  abstract: string | null,
  synonymGroups: SynonymGroupEntry[]
): string[] {
  const textToSearch = normalizeText([title, abstract || ""].join(" "));
  const matched = new Set<string>();

  for (const group of synonymGroups) {
    for (const syn of group.synonyms) {
      const pattern = new RegExp(`\\b${escapeRegExp(syn.toLowerCase())}\\b`, "gi");
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(textToSearch)) !== null) {
        const precedingText = textToSearch.slice(0, match.index).trimEnd();
        const precedingWords = precedingText.split(/\s+/).slice(-4).join(" ");

        const isNegated = NEGATION_TRIGGERS.some(trigger => {
          const triggerPattern = new RegExp(`\\b${escapeRegExp(trigger)}\\b`, "i");
          return triggerPattern.test(precedingWords);
        });

        if (!isNegated) {
          matched.add(group.canonical_term);
          break;
        }
      }

      if (matched.has(group.canonical_term)) break; // already matched this group
    }
  }

  return Array.from(matched);
}

// ── Deduplicate keywords (case-insensitive) ──

function deduplicateKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const kw of keywords) {
    const key = kw.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(kw);
    }
  }
  return result;
}

// ── Main Pipeline ──

export interface SynonymGroupEntry {
  canonical_term: string;
  synonyms: string[];
}

export interface NormalizationConfig {
  synonymLookup: Record<string, string>;
  poolStudyTypes: PoolStudyTypeEntry[];
  poolKeywords: string[];
  synonymGroups: SynonymGroupEntry[];
}

export interface RawPaperData {
  title: string;
  authors: string[];
  year: number | null;
  journal: string | null;
  pmid: string | null;
  doi: string | null;
  abstract: string | null;
  keywords: string[];
  mesh_terms?: string[];
  substances?: string[];
  study_type: string | null;
  pubmed_url: string | null;
  journal_url: string | null;
  drive_url: string | null;
}

export interface NormalizedPaperData {
  title: string;
  authors: string[];
  year: number | null;
  journal: string | null;
  pmid: string | null;
  doi: string | null;
  abstract: string | null;
  keywords: string[];
  mesh_terms: string[];
  substances: string[];
  study_type: string | null;
  pubmed_url: string | null;
  journal_url: string | null;
  drive_url: string | null;
}

/**
 * Central normalization pipeline. Both API and manual entry paths
 * MUST call this before writing to the database.
 */
export function normalizePaperData(
  raw: RawPaperData,
  config: NormalizationConfig
): NormalizedPaperData {
  // Decode HTML entities
  const decodedTitleRaw = decodeHTMLEntities(raw.title) || raw.title;
  const decodedTitle = decodedTitleRaw.replace(/\.\s*$/, '').trim();
  const decodedAbstract = decodeHTMLEntities(raw.abstract) || null;

  // Decode HTML entities in keywords
  const decodedKeywords = raw.keywords.map(kw => decodeHTMLEntities(kw) || kw);

  // Step 1: Normalize keywords through synonym lookup
  let normalizedKeywords = normalizeKeywords(decodedKeywords, config.synonymLookup);

  // Step 2: Filter out keywords that are negated in the abstract
  normalizedKeywords = filterKeywordsByAbstractContext(
    normalizedKeywords,
    decodedAbstract,
    config.poolKeywords
  );

  // Step 2.5: Synonym-based keyword extraction from title + abstract
  const synonymExtracted = extractSynonymKeywords(
    decodedTitle,
    decodedAbstract,
    config.synonymGroups
  );
  // Merge synonym-extracted canonical terms, deduplicating
  const mergedKeywords = deduplicateKeywords([...normalizedKeywords, ...synonymExtracted]);

  // Step 3: Winner Takes All study type (hierarchy_rank ASC, then length DESC)
  const winnerStudyType = findWinnerStudyType(
    raw.study_type,
    decodedTitle,
    decodedAbstract,
    config.poolStudyTypes
  );

  return {
    title: decodedTitle,
    authors: raw.authors,
    year: raw.year,
    journal: raw.journal,
    pmid: raw.pmid,
    doi: raw.doi,
    abstract: decodedAbstract,
    keywords: mergedKeywords,
    mesh_terms: raw.mesh_terms || [],
    substances: raw.substances || [],
    study_type: winnerStudyType || null,
    pubmed_url: raw.pubmed_url,
    journal_url: raw.journal_url,
    drive_url: raw.drive_url,
  };
}
