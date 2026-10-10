import { ComparisonIntegrityError } from "./errors";
import {
  doiUrlFor,
  pubmedUrlFor,
  readPlaceholderText,
  readPublicationTypes,
  readStatisticalMethods,
  readStoredText,
  readStringList,
  readYear,
  summarizeAttachmentTypes,
} from "./fields";
import type { ComparisonRow, ComparisonTaxonomy, TaxonomyItem } from "./types";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A nested list the projection always returns: an array of objects, or the response is not trusted. */
function nestedRecords(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new ComparisonIntegrityError("malformed_response");
  }
  return value;
}

/** A nested record must name the paper it is shown under. */
function assertBelongsToPaper(record: UnknownRecord, paperId: string): void {
  if (record.paper_id !== paperId) throw new ComparisonIntegrityError("relationship_mismatch");
}

/** A record that names an owner must name the request's owner. */
function assertOwnedBy(record: UnknownRecord, ownerUserId: string): void {
  if (record.user_id !== ownerUserId) throw new ComparisonIntegrityError("owner_mismatch");
}

const nameCollator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/**
 * The Projects or Tags assigned to one paper, from `paper_projects` /
 * `paper_tags` rows with the Project/Tag embedded under `key`.
 *
 * An assignment whose Project/Tag is null (not readable under RLS) or has no
 * usable id/name is counted in `unavailableCount` rather than dropped or
 * guessed. One owned by another user, or an assignment naming another paper,
 * fails the whole response.
 */
function mapTaxonomy(
  links: unknown,
  key: "project" | "tag",
  paperId: string,
  ownerUserId: string,
): ComparisonTaxonomy {
  const items: TaxonomyItem[] = [];
  let unavailableCount = 0;
  for (const link of nestedRecords(links)) {
    assertBelongsToPaper(link, paperId);
    const entity = link[key];
    if (entity === null || entity === undefined) {
      unavailableCount += 1;
      continue;
    }
    if (!isRecord(entity)) throw new ComparisonIntegrityError("malformed_response");
    assertOwnedBy(entity, ownerUserId);
    const { id, name, color } = entity;
    if (typeof id !== "string" || typeof name !== "string" || name.trim() === "") {
      unavailableCount += 1;
      continue;
    }
    items.push(Object.freeze({ id, name, color: typeof color === "string" ? color : null }));
  }
  items.sort((a, b) => nameCollator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze({ provenance: "user_entered", items: Object.freeze(items), unavailableCount });
}

/**
 * Map one response row to a `ComparisonRow` for `ownerUserId`.
 *
 * Each field reads exactly one stored column, except `links`, whose PubMed and
 * DOI URLs derive from `pmid` and `doi` respectively; attachment counts derive
 * from the nested attachment records. The row's id is taken as given here —
 * `buildComparisonResult` has already checked it against the request — but
 * its owner and every nested record's paper and owner are checked, and any
 * mismatch throws `ComparisonIntegrityError` so the row can never be shown.
 */
export function mapComparisonRow(row: unknown, ownerUserId: string): ComparisonRow {
  if (!isRecord(row) || typeof row.id !== "string") throw new ComparisonIntegrityError("malformed_response");
  assertOwnedBy(row, ownerUserId);
  const paperId = row.id;

  const attachments = nestedRecords(row.paper_attachments);
  for (const attachment of attachments) {
    assertBelongsToPaper(attachment, paperId);
    assertOwnedBy(attachment, ownerUserId);
  }

  return Object.freeze({
    paperId,
    title: Object.freeze({ provenance: "library_metadata", value: readStoredText(row.title) }),
    authors: Object.freeze({ provenance: "library_metadata", value: readStringList(row.authors) }),
    year: Object.freeze({ provenance: "library_metadata", value: readYear(row.year) }),
    journal: Object.freeze({ provenance: "library_metadata", value: readStoredText(row.journal) }),
    pmid: Object.freeze({ provenance: "library_metadata", value: readStoredText(row.pmid) }),
    doi: Object.freeze({ provenance: "library_metadata", value: readStoredText(row.doi) }),
    links: Object.freeze({
      provenance: "display_derivation",
      value: Object.freeze({ pubmed: pubmedUrlFor(row.pmid), doi: doiUrlFor(row.doi) }),
    }),
    publicationTypes: Object.freeze({
      provenance: "import_recorded_publication_types",
      value: readPublicationTypes(row.raw_publication_types),
    }),
    importedTypeText: Object.freeze({
      provenance: "imported_source_unrecorded",
      value: readStoredText(row.raw_study_type),
    }),
    studyTypeClassification: Object.freeze({
      provenance: "classification_lineage_unrecorded",
      value: readPlaceholderText(row.study_type),
    }),
    abstract: Object.freeze({ provenance: "stored_abstract", value: readStoredText(row.abstract) }),
    tldr: Object.freeze({ provenance: "ai_or_user_annotation", value: readPlaceholderText(row.tldr) }),
    statisticalMethods: Object.freeze({
      provenance: "ai_or_user_annotation",
      value: readStatisticalMethods(row.statistical_methods),
    }),
    notes: Object.freeze({ provenance: "user_entered", value: readStoredText(row.notes) }),
    projects: mapTaxonomy(row.paper_projects, "project", paperId, ownerUserId),
    tags: mapTaxonomy(row.paper_tags, "tag", paperId, ownerUserId),
    keywords: Object.freeze({ provenance: "derived_keywords", value: readStringList(row.keywords) }),
    importedKeywords: Object.freeze({
      provenance: "imported_source_unrecorded",
      value: readStringList(row.raw_keywords),
    }),
    meshTerms: Object.freeze({ provenance: "imported_source_unrecorded", value: readStringList(row.mesh_terms) }),
    substances: Object.freeze({ provenance: "imported_source_unrecorded", value: readStringList(row.substances) }),
    attachments: Object.freeze({
      provenance: "display_derivation",
      value: summarizeAttachmentTypes(attachments.map((attachment) => attachment.file_type)),
    }),
  });
}
