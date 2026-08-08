/**
 * Structured publication-type provenance at the database boundary.
 *
 * `papers.raw_publication_types` stores the publication types a structured
 * source (the PubMed API, a native NBIB file) stated as discrete values, so a
 * comma inside one official type ("Clinical Trial, Phase II") is never later
 * mistaken for a separator. SQL NULL is the single representation of "no
 * trustworthy boundaries were persisted for this row".
 *
 * Both directions of that boundary go through here: what an import payload is
 * allowed to write, and what a stored value is allowed to mean on the way back.
 */

/**
 * Canonicalize a candidate structured value for storage or evaluation.
 *
 * Returns `null` for anything that carries no usable provenance — missing, not
 * an array, or empty once blanks are dropped — and otherwise a non-empty array
 * of trimmed strings in their original order. A non-string element makes the
 * whole value untrustworthy rather than partially usable, so it yields `null`.
 *
 * The legacy joined `raw_study_type` string is deliberately not an input here:
 * splitting it is exactly the lossy step this column exists to avoid, so a
 * structured value is only ever populated by a source that stated boundaries.
 */
export function normalizePublicationTypes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== "string")) return null;

  const cleaned = (value as string[]).map((entry) => entry.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The same canonicalization, shaped for `evaluateStudyType`'s optional fifth
 * argument: `undefined` means "no structured values", which is precisely the
 * condition under which the evaluator falls back to the legacy joined string.
 */
export function toEvaluatorPublicationTypes(value: unknown): string[] | undefined {
  return normalizePublicationTypes(value) ?? undefined;
}
