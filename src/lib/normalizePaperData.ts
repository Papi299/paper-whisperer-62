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

// ── Flat multi-match study type detection ──

interface PoolStudyTypeEntry {
  study_type: string;
  specificity_weight: number;
}

function findAllMatchingStudyTypes(
  rawStudyTypeString: string | null,
  title: string,
  abstract: string | null,
  poolStudyTypes: PoolStudyTypeEntry[]
): string {
  const matched = new Set<string>();

  // Parse API publication types
  (rawStudyTypeString || "")
    .split(/[,;]+/)
    .map(t => t.trim())
    .filter(Boolean)
    .forEach(t => matched.add(t));

  // Find matches from pool in title + abstract
  const textToSearch = [title, abstract || ""].join(" ");
  for (const st of poolStudyTypes) {
    try {
      const regex = new RegExp('\\b' + escapeRegExp(st.study_type) + '\\b', 'i');
      if (regex.test(textToSearch)) {
        matched.add(st.study_type);
      }
    } catch {
      // skip invalid regex
    }
  }

  const result = Array.from(matched).sort((a, b) => a.localeCompare(b));
  if (result.length > 0) {
    console.log('Matched Study Types:', result);
  }

  return result.join(", ");
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

  // Find which pool keywords are negated in the abstract
  const allPoolMatches = new Set(
    extractContextualKeywords(abstract, poolKeywords).map(k => k.toLowerCase())
  );

  // For manually entered keywords that also exist in the pool,
  // only keep them if they passed the negation check
  return keywords.filter(kw => {
    const isInPool = poolKeywords.some(pk => pk.toLowerCase() === kw.toLowerCase());
    if (!isInPool) return true; // not in pool, keep as-is
    return allPoolMatches.has(kw.toLowerCase()); // only keep if not negated
  });
}

// ── Main Pipeline ──

export interface NormalizationConfig {
  synonymLookup: Record<string, string>;
  poolStudyTypes: PoolStudyTypeEntry[];
  poolKeywords: string[];
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
 * 
 * 1. Normalizes keywords via synonym lookup (deduplicates canonical forms)
 * 2. Filters keywords against abstract negation context
 * 3. Deduplicates study types using specificity weights + substring rules
 */
export function normalizePaperData(
  raw: RawPaperData,
  config: NormalizationConfig
): NormalizedPaperData {
  // Step 0: Decode HTML entities in text fields (PubMed returns encoded entities)
  const decodedTitleRaw = decodeHTMLEntities(raw.title) || raw.title;
  // Step 0b: Remove trailing period (PubMed appends one to titles)
  const decodedTitle = decodedTitleRaw.replace(/\.\s*$/, '').trim();
  const decodedAbstract = decodeHTMLEntities(raw.abstract) || null;

  // Step 1: Normalize keywords through synonym lookup
  let normalizedKeywords = normalizeKeywords(raw.keywords, config.synonymLookup);

  // Step 2: Filter out keywords that are negated in the abstract
  normalizedKeywords = filterKeywordsByAbstractContext(
    normalizedKeywords,
    decodedAbstract,
    config.poolKeywords
  );

  // Step 3: Find all matching study types (flat multi-match)
  const matchedStudyTypes = findAllMatchingStudyTypes(
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
    keywords: normalizedKeywords,
    mesh_terms: raw.mesh_terms || [],
    substances: raw.substances || [],
    study_type: matchedStudyTypes || null,
    pubmed_url: raw.pubmed_url,
    journal_url: raw.journal_url,
    drive_url: raw.drive_url,
  };
}
