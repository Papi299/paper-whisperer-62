/**
 * The DOI lookup inside `fetch-paper-metadata`: PubMed first, Crossref
 * fallback, then optional PubMed enrichment of the Crossref record.
 *
 * ## Why a PubMed record has to prove which DOI it is for
 *
 * PubMed is asked about a DOI with an E-utilities *search*, and a search
 * answers with candidates. `searchPubMedByDoi` returns the first PMID it was
 * given, and nothing about that PMID proves that the record behind it names
 * the DOI that was searched for. So a PubMed record counts as evidence about a
 * DOI only when the DOI it carries itself is equivalent to the requested one
 * (DOI Handbook §4.3.4 — `doiNamesAreEquivalent`, ASCII case only). A record
 * with no DOI, an empty one, or a different one says nothing about the
 * requested DOI:
 *
 *   • on the PubMed-first path it is not returned, and the lookup continues to
 *     the existing Crossref fallback — the path a PubMed miss already took;
 *   • on the enrichment path nothing from it is attached — no `pmid`, keywords,
 *     MeSH terms, substances, study type or `pubmed_url` — and the Crossref
 *     record, which Crossref resolved for this exact DOI, is returned as-is.
 *
 * The requested DOI is never written into a PubMed record. The backfill this
 * replaced (`pubmedResult.doi || doi`) could label a DOI-less record — possibly
 * a different paper — with the DOI the user asked for. An accepted record
 * carries its own equivalent DOI, in PubMed's spelling, and keeps the
 * `journal_url` that `fetchFromPubMed` derived from that DOI.
 *
 * ## Why it lives here
 *
 * `index.ts` cannot be imported by Vitest (Deno runtime, remote imports). This
 * module is pure and dependency-injected, like `./upstreamFetch.ts`: the
 * PubMed and Crossref calls stay in `index.ts` and are passed in, so the
 * decision is unit-tested with scripted fakes and no network.
 */

import { doiNamesAreEquivalent } from "../_shared/identifierDetection.ts";
import { pubmedStudyTypeOverride } from "../_shared/publicationTypes.ts";

/** The fields of a metadata record this lookup reads or writes. */
export interface DoiLookupRecord {
  pmid?: string | null;
  doi?: string | null;
  keywords?: string[];
  mesh_terms?: string[];
  substances?: string[];
  study_type?: string | null;
  publication_types?: string[];
  pubmed_url?: string | null;
}

/**
 * How a fetched PubMed record's own DOI relates to the DOI that was searched
 * for. Only `match` makes the record evidence about that DOI.
 */
export type PubMedDoiMatch = "match" | "missing" | "mismatch";

/** The lookup step a PubMed record was rejected from. */
export type PubMedDoiMatchStage = "direct" | "enrichment";

/**
 * Compare a PubMed record's own DOI with the DOI that was searched for.
 *
 * An absent or empty DOI is `missing` — checked before comparing, because `""`
 * is equivalent to `""` and an empty value is the absence of a DOI, not one.
 * Anything else is compared exactly as `doiNamesAreEquivalent` defines.
 */
export function classifyPubMedDoiMatch(
  pubmedDoi: string | null | undefined,
  requestedDoi: string,
): PubMedDoiMatch {
  if (typeof pubmedDoi !== "string" || pubmedDoi.length === 0) return "missing";
  return doiNamesAreEquivalent(pubmedDoi, requestedDoi) ? "match" : "mismatch";
}

/** The provider calls and logger the lookup is built from. */
export interface DoiLookupDeps<T extends DoiLookupRecord> {
  searchPubMedByDoi: (doi: string, apiKey?: string) => Promise<string | null>;
  fetchFromPubMed: (pmid: string, apiKey?: string) => Promise<T | null>;
  fetchFromCrossrefByDoi: (doi: string) => Promise<T | null>;
  logger: { log: (message: string) => void; warn: (message: string) => void };
}

/**
 * Build the DOI lookup from injected provider calls.
 *
 * `doi` is the DOI name `detectIdentifier` proved, used as given.
 */
export function createFetchByDoi<T extends DoiLookupRecord>(
  deps: DoiLookupDeps<T>,
): (doi: string, apiKey?: string) => Promise<T | null> {
  // A bounded outcome only: never the DOI, PMID, title or a URL. Both values
  // are literals from closed unions, so a caller cannot widen the line.
  const logRejected = (
    match: Exclude<PubMedDoiMatch, "match">,
    stage: PubMedDoiMatchStage,
  ): void => {
    deps.logger.warn(`fetch-paper-metadata doi_pubmed_match=${match} stage=${stage}`);
  };

  return async function fetchByDoi(doi, apiKey) {
    // Try PubMed first — accepted only when the record names this DOI.
    const pmid = await deps.searchPubMedByDoi(doi, apiKey);
    if (pmid) {
      const pubmedResult = await deps.fetchFromPubMed(pmid, apiKey);
      if (pubmedResult) {
        const match = classifyPubMedDoiMatch(pubmedResult.doi, doi);
        if (match === "match") return pubmedResult;
        logRejected(match, "direct");
      }
    }

    // Fallback to Crossref
    deps.logger.log("PubMed unavailable for DOI, falling back to Crossref");
    const crossrefResult = await deps.fetchFromCrossrefByDoi(doi);
    if (!crossrefResult) return null;

    // Try to cross-reference with PubMed for enrichment — only from a record
    // that names the same DOI Crossref resolved.
    if (crossrefResult.doi) {
      const enrichPmid = await deps.searchPubMedByDoi(crossrefResult.doi, apiKey);
      if (enrichPmid) {
        const pubmedData = await deps.fetchFromPubMed(enrichPmid, apiKey);
        if (pubmedData) {
          const match = classifyPubMedDoiMatch(pubmedData.doi, crossrefResult.doi);
          if (match === "match") {
            crossrefResult.pmid = enrichPmid;
            crossrefResult.keywords = pubmedData.keywords || [];
            crossrefResult.mesh_terms = pubmedData.mesh_terms || [];
            crossrefResult.substances = pubmedData.substances || [];
            // Study-type provenance transfers as a pair: when the PubMed value is
            // adopted its publication-type boundaries come with it, and when it is
            // not, the Crossref record keeps its own `study_type` and gains no
            // PubMed structure it cannot account for.
            const studyTypeOverride = pubmedStudyTypeOverride(pubmedData);
            if (studyTypeOverride) {
              crossrefResult.study_type = studyTypeOverride.study_type;
              crossrefResult.publication_types = studyTypeOverride.publication_types;
            }
            crossrefResult.pubmed_url = pubmedData.pubmed_url;
          } else {
            logRejected(match, "enrichment");
          }
        }
      }
    }

    return crossrefResult;
  };
}
