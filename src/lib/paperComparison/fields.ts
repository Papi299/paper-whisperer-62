import { canonicalDoiUrl } from "@/lib/doiIdentifiers";
import { canonicalPubMedUrl, normalizePmid } from "@/lib/pubmedIdentifiers";
import { normalizeStatisticalMethodsForDomain } from "@/lib/statisticalMethods";
import { NOT_SPECIFIED_PLACEHOLDER } from "./constants";
import type { AttachmentSummary, FieldValue } from "./types";

/**
 * Readers from one stored column value to a `FieldValue`.
 *
 * They share three rules:
 * - a present value is returned exactly as stored — no trimming, entity
 *   decoding, number reformatting or splitting;
 * - NULL, blank text and an empty list are `not_recorded`, which only ever
 *   means "the library stores nothing";
 * - a value of an unexpected shape is `unreadable` as a whole. A list with one
 *   bad element is not shortened to its good ones, because a shortened list
 *   would look complete.
 */

const NOT_RECORDED: FieldValue<never> = Object.freeze({ kind: "not_recorded" });
const UNREADABLE: FieldValue<never> = Object.freeze({ kind: "unreadable" });

function present<T>(value: T): FieldValue<T> {
  return Object.freeze({ kind: "present", value });
}

function isBlank(value: string): boolean {
  return value.trim() === "";
}

/** Plain stored text: title, journal, PMID, DOI, notes, abstract, `raw_study_type`. */
export function readStoredText(value: unknown): FieldValue<string> {
  if (value === null || value === undefined) return NOT_RECORDED;
  if (typeof value !== "string") return UNREADABLE;
  return isBlank(value) ? NOT_RECORDED : present(value);
}

/**
 * Text that may hold the "Not specified" placeholder: TL;DR, statistical
 * methods, and the study-type classification (which AI analysis can set to
 * it). Matched exactly once trimmed — the same literal the app already treats
 * as the AI sentinel — and kept verbatim in `value`.
 */
export function readPlaceholderText(value: unknown): FieldValue<string> {
  const text = readStoredText(value);
  if (text.kind === "present" && text.value.trim() === NOT_SPECIFIED_PLACEHOLDER) {
    return Object.freeze({ kind: "stored_placeholder", value: text.value });
  }
  return text;
}

/**
 * `statistical_methods`: a JSON string, or (before decision C20's
 * reconciliation reached a database) a legacy JSON array.
 *
 * Arrays of strings join with ", " through `normalizeStatisticalMethodsForDomain`,
 * so the comparison shows what the rest of the app shows. Unlike that mapper,
 * an array holding any non-string value is `unreadable` rather than rendered
 * as JSON text, and the shapes it throws on (object, number, boolean) become
 * `unreadable` instead of an exception.
 */
export function readStatisticalMethods(value: unknown): FieldValue<string> {
  if (Array.isArray(value) && value.some((element) => element !== null && typeof element !== "string")) {
    return UNREADABLE;
  }
  let text: string | null;
  try {
    text = normalizeStatisticalMethodsForDomain(value);
  } catch {
    return UNREADABLE;
  }
  return readPlaceholderText(text);
}

/**
 * A stored list of terms: authors, keywords, imported keywords, MeSH terms,
 * substances. Readable only when every element is non-blank text.
 */
export function readStringList(value: unknown): FieldValue<readonly string[]> {
  if (value === null || value === undefined) return NOT_RECORDED;
  if (!Array.isArray(value)) return UNREADABLE;
  if (value.length === 0) return NOT_RECORDED;
  if (!value.every((element) => typeof element === "string" && !isBlank(element))) return UNREADABLE;
  return present(Object.freeze([...(value as string[])]));
}

/**
 * `raw_publication_types`, read under the column's own contract
 * (`papers_raw_publication_types_string_array_check`): SQL NULL is the single
 * "nothing recorded"; anything else must be a non-empty array of strings.
 *
 * Each element is one publication type, kept whole — "Clinical Trial, Phase II"
 * is one type, not two — and nothing is ever derived from `raw_study_type`. An
 * empty array, a blank element or a non-string element is `unreadable`, never
 * repaired.
 */
export function readPublicationTypes(value: unknown): FieldValue<readonly string[]> {
  if (value === null || value === undefined) return NOT_RECORDED;
  if (!Array.isArray(value) || value.length === 0) return UNREADABLE;
  if (!value.every((element) => typeof element === "string" && !isBlank(element))) return UNREADABLE;
  return present(Object.freeze([...(value as string[])]));
}

/** `year` (an integer column). */
export function readYear(value: unknown): FieldValue<number> {
  if (value === null || value === undefined) return NOT_RECORDED;
  if (typeof value !== "number" || !Number.isInteger(value)) return UNREADABLE;
  return present(value);
}

/** The PubMed record URL, only when the stored PMID passes `normalizePmid`. */
export function pubmedUrlFor(pmid: unknown): string | null {
  if (typeof pmid !== "string") return null;
  const normalized = normalizePmid(pmid);
  return normalized ? canonicalPubMedUrl(normalized) : null;
}

/** The doi.org URL, only when the stored DOI is a usable DOI name. */
export function doiUrlFor(doi: unknown): string | null {
  return typeof doi === "string" ? canonicalDoiUrl(doi) : null;
}

/**
 * Count attachments by the MIME type recorded at upload (compared
 * case-insensitively, as MIME types are). Anything that is not a PDF or an
 * image — including a missing or non-text type — counts as "other".
 */
export function summarizeAttachmentTypes(fileTypes: readonly unknown[]): AttachmentSummary {
  let pdf = 0;
  let image = 0;
  for (const fileType of fileTypes) {
    const normalized = typeof fileType === "string" ? fileType.trim().toLowerCase() : "";
    if (normalized === "application/pdf") pdf += 1;
    else if (normalized.startsWith("image/")) image += 1;
  }
  return Object.freeze({ total: fileTypes.length, pdf, image, other: fileTypes.length - pdf - image });
}
