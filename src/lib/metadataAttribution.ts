/**
 * Attribute each `fetch-paper-metadata` result to the identifier that was
 * requested.
 *
 * ## Why this exists
 *
 * `fetch-paper-metadata` labels a record it fetched from PubMed with that
 * record's PMID (`identifier: pmid`), whatever was asked for. A DOI the
 * importer resolved on PubMed's path therefore comes back labelled with a PMID,
 * and so does a PubMed record URL. The importer reports Added / Skipped —
 * Duplicates / Failed by that label, while it keys its terminal per-identifier
 * outcome by the strings it was given. Before this, a PubMed-resolved DOI was:
 *
 * - listed in the Add Papers summary under a PMID nobody entered;
 * - never released from a Consensus selection after a successful import,
 *   because its DOI was never reported back;
 * - reported `failed` in `BulkImportOutcome.items` although it was inserted —
 *   the status `/extension-import` acts on.
 *
 * ## How a result is matched
 *
 * Only from what each result states about itself, never from its position: the
 * function answers `[...rejected, ...fetched]` per request, and the client
 * batches requests. Each requested identifier is claimed at most once.
 *
 * 1. **Its own label**, exactly (the server trims what it was sent, so a
 *    trimmed match also counts). Applied to every result first, so a genuine
 *    label always wins over an inference.
 * 2. **Its DOI**, by DOI equivalence against a requested DOI in any form the
 *    application recognises (bare, `doi:`, resolver URL). This is sound because
 *    `fetchByDoi` accepts a PubMed record only when the record's own DOI is
 *    equivalent to the requested one (DOI-PUBMED-MATCH-HARDENING-001).
 * 3. **Its PMID**, against a requested PMID or PubMed record URL.
 *
 * A result nothing matches keeps its own label, exactly as before — a title
 * search resolved on PubMed still reports its PMID.
 *
 * Nothing about WHAT is imported changes. This decides only which requested
 * string a result is reported under.
 */

import { doiEquivalenceKey, extractDoiFromMetadataValue } from "@/lib/doiIdentifiers";
import { extractPmidFromPubMedUrl, normalizePmid } from "@/lib/pubmedIdentifiers";

/** The fields of a `PaperMetadata` result attribution reads. */
export interface AttributableResult {
  identifier: string;
  doi?: string | null;
  pmid?: string | null;
}

/**
 * Pair every result with the requested identifier it answers.
 *
 * @param requested The identifiers handed to the importer, in order.
 * @param results   The metadata results, in any order.
 * @returns One entry per result, in result order.
 */
export function attributeToRequestedIdentifiers<T extends AttributableResult>(
  requested: readonly string[],
  results: readonly T[],
): Array<{ identifier: string; meta: T }> {
  const claimed = new Set<number>();
  const claim = (matches: (candidate: string) => boolean): string | null => {
    for (let i = 0; i < requested.length; i++) {
      if (!claimed.has(i) && matches(requested[i])) {
        claimed.add(i);
        return requested[i];
      }
    }
    return null;
  };

  const attributed: Array<string | null> = results.map(() => null);

  // Pass 1 — a result's own label, for every result, before any inference.
  results.forEach((meta, index) => {
    const label = meta.identifier;
    attributed[index] = claim((candidate) => candidate === label || candidate.trim() === label);
  });

  // Pass 2 — the record's DOI, then its PMID, for results still unmatched.
  results.forEach((meta, index) => {
    if (attributed[index] !== null) return;

    const doiKey = typeof meta.doi === "string" && meta.doi !== "" ? doiEquivalenceKey(meta.doi) : null;
    if (doiKey !== null) {
      const byDoi = claim((candidate) => doiEquivalenceKey(extractDoiFromMetadataValue(candidate)) === doiKey);
      if (byDoi !== null) {
        attributed[index] = byDoi;
        return;
      }
    }

    const pmid = normalizePmid(meta.pmid ?? null);
    if (pmid !== null) {
      attributed[index] = claim(
        (candidate) => normalizePmid(candidate) === pmid || extractPmidFromPubMedUrl(candidate.trim()) === pmid,
      );
    }
  });

  return results.map((meta, index) => ({ identifier: attributed[index] ?? meta.identifier, meta }));
}
