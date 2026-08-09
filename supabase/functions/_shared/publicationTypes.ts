/**
 * PubMed publication-type provenance.
 *
 * PubMed states publication types as discrete `<PublicationType>` elements, and
 * an official one may contain a comma of its own ("Clinical Trial, Phase II",
 * "Research Support, N.I.H., Extramural"). Once such values are joined into one
 * string, no split can tell that comma from a separator, so the boundaries have
 * to survive as their own field rather than be recovered later.
 *
 * This module owns both representations the response carries and the rule for
 * transferring them together. It is deliberately pure — no Deno APIs, no remote
 * imports — so it is Node-importable and unit-tested by Vitest, the same shape
 * as `identifierDetection.ts`.
 */

/**
 * Read the publication types out of a PubMed EFetch XML record, one value per
 * `<PublicationType>` element, in document order. Each element's text is taken
 * whole: a comma inside one is part of that value and never a boundary.
 */
export function extractPublicationTypes(xml: string): string[] {
  const matches = xml.matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g);
  const publicationTypes: string[] = [];
  for (const match of matches) publicationTypes.push(match[1]);
  return publicationTypes;
}

/**
 * The legacy comma-joined representation of the same values, kept as
 * `study_type` for every consumer that already reads one string.
 */
export function joinPublicationTypes(publicationTypes: string[]): string | null {
  return publicationTypes.length > 0 ? publicationTypes.join(", ") : null;
}

/** The two representations of one record's study-type provenance. */
export interface StudyTypeProvenance {
  study_type?: string | null;
  publication_types?: string[];
}

/**
 * The PubMed study-type provenance a Crossref record should adopt, or `null`
 * when PubMed supplied none and the record keeps its own.
 *
 * The two representations move as a pair: a record must never end up with a
 * PubMed-derived `study_type` and no matching boundaries, nor with publication
 * types belonging to a `study_type` it did not take. This reproduces the
 * existing `pubmedData.study_type || crossrefResult.study_type` precedence
 * exactly — it only makes the structured half travel with it.
 */
export function pubmedStudyTypeOverride(
  pubmed: StudyTypeProvenance,
): { study_type: string; publication_types: string[] } | null {
  if (!pubmed.study_type) return null;
  return {
    study_type: pubmed.study_type,
    publication_types: pubmed.publication_types ?? [],
  };
}
