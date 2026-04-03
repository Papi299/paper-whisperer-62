/**
 * Centralized Paper Data Normalization Pipeline
 * 
 * Single source of truth for processing paper data before DB writes.
 * Both API fetches and manual entries MUST pass through this pipeline.
 */

import { decodeHTMLEntities } from "./decodeHTMLEntities";
import { evaluateStudyType, StudyTypePoolEntry } from "./evaluateStudyType";
import { escapeRegExp, NEGATION_TRIGGERS, normalizeText, extractContextualKeywords } from "./textUtils";

// ── Evidence Pyramid: Winner Takes All study type detection ──
// Delegated to the standalone evaluateStudyType utility.

type PoolStudyTypeEntry = StudyTypePoolEntry;

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

export function deduplicateKeywords(keywords: string[]): string[] {
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
 * Compute the fully enriched keyword set from raw keywords + text + config.
 * Used by both import-time normalization and keyword reevaluation.
 *
 * Steps:
 * 1. Normalize raw keywords through synonym lookup
 * 2. Filter out pool keywords that are negated in the abstract
 * 3. Extract synonym-group canonical terms from title+abstract
 * 4. Extract pool keywords from title+abstract (negation-aware)
 * 5. Merge + deduplicate
 */
export function computeEnrichedKeywords(
  rawKeywords: string[],
  title: string,
  abstract: string | null,
  config: NormalizationConfig,
): string[] {
  // Step 1: Normalize raw keywords through synonym lookup
  const normalized = normalizeKeywords(rawKeywords, config.synonymLookup);
  // Step 2: Remove pool keywords that are negated in the abstract
  const filtered = filterKeywordsByAbstractContext(normalized, abstract, config.poolKeywords);
  // Step 3: Synonym-group extraction from title+abstract
  const synonymExtracted = extractSynonymKeywords(title, abstract, config.synonymGroups);
  // Step 4: Pool-keyword extraction from title+abstract (negation-aware)
  const text = [title, abstract || ""].join(" ");
  const poolExtracted = extractContextualKeywords(text, config.poolKeywords);
  const poolNormalized = poolExtracted.map(kw => config.synonymLookup[kw.toLowerCase()] || kw);
  // Merge + deduplicate
  return deduplicateKeywords([...filtered, ...synonymExtracted, ...poolNormalized]);
}

/**
 * Central normalization pipeline. Both API and manual entry paths
 * MUST call this before writing to the database.
 */
export function normalizePaperData(
  raw: RawPaperData,
  config: NormalizationConfig
): NormalizedPaperData {
  // Decode HTML entities in all human-readable text fields
  const decodedTitleRaw = decodeHTMLEntities(raw.title) || raw.title;
  const decodedTitle = decodedTitleRaw.replace(/\.\s*$/, '').trim();
  const decodedAbstract = decodeHTMLEntities(raw.abstract) || null;
  const decodedKeywords = raw.keywords.map(kw => decodeHTMLEntities(kw) || kw);
  const decodedAuthors = raw.authors.map(a => decodeHTMLEntities(a) || a);
  const decodedJournal = raw.journal ? (decodeHTMLEntities(raw.journal) || raw.journal) : null;
  const decodedMeshTerms = (raw.mesh_terms || []).map(m => decodeHTMLEntities(m) || m);
  const decodedSubstances = (raw.substances || []).map(s => decodeHTMLEntities(s) || s);
  const decodedStudyType = raw.study_type ? (decodeHTMLEntities(raw.study_type) || raw.study_type) : null;

  // Compute enriched keywords from raw keywords + title + abstract + config
  const enrichedKeywords = computeEnrichedKeywords(decodedKeywords, decodedTitle, decodedAbstract, config);

  // Winner Takes All study type (hierarchy_rank ASC, then length DESC)
  const winnerStudyType = evaluateStudyType(
    decodedTitle,
    decodedAbstract,
    decodedStudyType,
    config.poolStudyTypes
  );

  return {
    title: decodedTitle,
    authors: decodedAuthors,
    year: raw.year,
    journal: decodedJournal,
    pmid: raw.pmid,
    doi: raw.doi
      ? raw.doi.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, "").trim().toLowerCase()
      : null,
    abstract: decodedAbstract,
    keywords: enrichedKeywords,
    mesh_terms: decodedMeshTerms,
    substances: decodedSubstances,
    study_type: winnerStudyType || null,
    pubmed_url: raw.pubmed_url,
    journal_url: raw.journal_url,
    drive_url: raw.drive_url,
  };
}
