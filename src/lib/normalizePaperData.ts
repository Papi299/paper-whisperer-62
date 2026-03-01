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

// ── Study type deduplication with specificity weights ──

interface PoolStudyTypeEntry {
  study_type: string;
  specificity_weight: number;
}

function deduplicateStudyTypes(
  rawStudyTypeString: string | null,
  title: string,
  poolStudyTypes: PoolStudyTypeEntry[]
): string {
  if (!rawStudyTypeString && poolStudyTypes.length === 0) return "";

  const poolMap = new Map(
    poolStudyTypes.map(p => [p.study_type.toLowerCase(), p.specificity_weight])
  );

  // Parse API publication types
  const apiTypes = (rawStudyTypeString || "")
    .split(/[,;]+/)
    .map(t => t.trim())
    .filter(Boolean);

  const apiEntries = apiTypes.map(t => ({
    type: t,
    weight: poolMap.get(t.toLowerCase()) ?? 1,
  }));

  // Find title matches using word boundary regex
  const titleEntries: { type: string; weight: number }[] = [];
  for (const st of poolStudyTypes) {
    try {
      const regex = new RegExp('\\b' + escapeRegExp(st.study_type) + '\\b', 'i');
      if (regex.test(title)) {
        titleEntries.push({ type: st.study_type, weight: st.specificity_weight });
      }
    } catch {
      // skip invalid regex
    }
  }

  // Merge: group by normalized name, keep highest weight
  const merged = new Map<string, { type: string; weight: number }>();
  for (const entry of [...apiEntries, ...titleEntries]) {
    const key = entry.type.toLowerCase();
    const existing = merged.get(key);
    if (!existing || entry.weight > existing.weight) {
      merged.set(key, entry);
    }
  }

  let entries = Array.from(merged.values());

  // Substring deduplication: remove shorter strings contained in longer ones
  entries = entries.filter((entry, _i, arr) => {
    const lower = entry.type.toLowerCase();
    for (const other of arr) {
      if (other === entry) continue;
      const otherLower = other.type.toLowerCase();
      if (otherLower.includes(lower) && otherLower !== lower) {
        return false;
      }
    }
    return true;
  });

  // Sort by weight desc, then alphabetical
  entries.sort((a, b) => b.weight - a.weight || a.type.localeCompare(b.type));

  return entries.map(e => e.type).join("; ");
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
  const decodedTitle = decodeHTMLEntities(raw.title) || raw.title;
  const decodedAbstract = decodeHTMLEntities(raw.abstract) || null;

  // Step 1: Normalize keywords through synonym lookup
  let normalizedKeywords = normalizeKeywords(raw.keywords, config.synonymLookup);

  // Step 2: Filter out keywords that are negated in the abstract
  normalizedKeywords = filterKeywordsByAbstractContext(
    normalizedKeywords,
    decodedAbstract,
    config.poolKeywords
  );

  // Step 3: Deduplicate study types using specificity weights
  const deduplicatedStudyType = deduplicateStudyTypes(
    raw.study_type,
    decodedTitle,
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
    study_type: deduplicatedStudyType || null,
    pubmed_url: raw.pubmed_url,
    journal_url: raw.journal_url,
    drive_url: raw.drive_url,
  };
}
