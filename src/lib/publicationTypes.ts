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

/**
 * Whether a PostgREST error is specifically "this database has no
 * `raw_publication_types` column yet".
 *
 * Merging auto-deploys the frontend, while applying the migration is a separate
 * later decision, so for that interval the new code runs against a schema that
 * predates the column. PostgREST resolves the select list before it applies
 * permissions or RLS, so the read fails outright rather than degrading — and it
 * fails with a signature narrow enough to act on. Observed locally against the
 * pre-migration schema:
 *
 *   HTTP 400
 *   {"code":"42703","details":null,"hint":null,
 *    "message":"column papers.raw_publication_types does not exist"}
 *
 * Both halves are required. `42703` (undefined_column) alone is not enough: any
 * other absent column produces the same code with a different message, and
 * retrying the legacy select would not fix that — it would only hide it. Every
 * unrelated failure (network, 401/403, RLS, timeout, server error, malformed
 * request) carries neither half and is therefore never mistaken for this.
 */
export function isMissingRawPublicationTypesColumn(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === "42703" &&
    typeof message === "string" &&
    message.includes("raw_publication_types")
  );
}
