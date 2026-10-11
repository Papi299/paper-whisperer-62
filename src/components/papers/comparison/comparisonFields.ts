import type {
  AttachmentSummary,
  ComparisonLinks,
  ComparisonRow,
  ComparisonTaxonomy,
  FieldValue,
  ProvenanceCategory,
} from "@/lib/paperComparison/types";
import type { ComparisonSort } from "@/lib/paperComparison/sort";

/**
 * What the comparison shows, and how it describes where each value came from
 * (EVIDENCE-MATRIX-001B). The desktop matrix and the phone cards both render
 * from these definitions, so the two layouts can never offer different fields,
 * labels or caveats.
 *
 * Every field shows a value the library stores, or one computed from stored
 * values, under its provenance caveat. There is deliberately no field for an
 * extracted, inferred or verified finding: no PICO, sample size, effect size,
 * significance, main findings, evidence quality, risk of bias, GRADE, synthesis
 * or recommendation. Those need a provenance-validated extraction feature.
 */

/**
 * One caveat per provenance category, as `types.ts` requires: the read model's
 * distinctions reach the user intact, never folded into a generic "source"
 * string. The `Record` makes a new category a compile error here.
 */
export const PROVENANCE_CAVEATS: Readonly<Record<ProvenanceCategory, string>> = Object.freeze({
  library_metadata: "Imported or edited in your library; which one is not recorded.",
  import_recorded_publication_types:
    "Recorded during import from PubMed or an NBIB file; not freshly checked against PubMed. Other import methods and older imports record none.",
  imported_source_unrecorded: "Saved at import; its source is not recorded.",
  classification_lineage_unrecorded: "Source and scientific accuracy not independently verified.",
  stored_abstract:
    "Imported or edited text, possibly without its original formatting. Not verbatim publisher text and not the full paper.",
  ai_or_user_annotation: "Written by AI analysis or by you; PaperLume does not record which. Not checked against the paper.",
  user_entered: "Entered by you.",
  derived_keywords: "Imported terms combined with Keyword Pool matches and your edits; the mix is not recorded.",
  display_derivation: "Computed from stored values when this comparison opened.",
});

/** The text shown in place of a value the library cannot provide. */
export const MISSING_VALUE_TEXT = Object.freeze({
  not_recorded: "Not recorded in library",
  unreadable: "Stored value cannot be displayed",
  stored_placeholder: "Stored placeholder: Not specified",
} satisfies Record<Exclude<FieldValue<unknown>["kind"], "present">, string>);

/** How the missing states read, said once for the whole comparison. */
export const MISSING_VALUE_MEANING =
  "“Not recorded in library” means your library holds no value — not that the paper did not report it. “Stored placeholder: Not specified” means that text was saved in place of a value.";

export type ComparisonGroupId = "bibliographic" | "study" | "content" | "library";

/** One rendered field value. Each variant maps to exactly one presentation. */
export type FieldContent =
  | { readonly type: "text"; readonly value: FieldValue<string> }
  | { readonly type: "list"; readonly value: FieldValue<readonly string[]> }
  | { readonly type: "year"; readonly value: FieldValue<number> }
  | { readonly type: "identifier"; readonly value: FieldValue<string>; readonly href: string | null; readonly linkLabel: string }
  | { readonly type: "taxonomy"; readonly taxonomy: ComparisonTaxonomy }
  | { readonly type: "attachments"; readonly summary: AttachmentSummary };

export interface ComparisonFieldDef {
  readonly id: string;
  /** The exact field label. */
  readonly label: string;
  /** What an expand control names: "Show full abstract". */
  readonly noun: string;
  readonly provenance: ProvenanceCategory;
  /** A field-specific addition to the category caveat, when one applies. */
  readonly note?: string;
  /** Long free text: previewed, with an expand control. */
  readonly long?: boolean;
  readonly read: (row: ComparisonRow) => FieldContent;
}

export interface ComparisonGroupDef {
  readonly id: ComparisonGroupId;
  readonly label: string;
  readonly fields: readonly ComparisonFieldDef[];
}

function linkOf(links: ComparisonLinks, key: keyof ComparisonLinks): string | null {
  return links[key];
}

export const COMPARISON_GROUPS: readonly ComparisonGroupDef[] = Object.freeze([
  {
    id: "bibliographic",
    label: "Bibliographic",
    fields: [
      {
        id: "authors",
        label: "Authors",
        noun: "authors",
        provenance: "library_metadata",
        read: (row) => ({ type: "list", value: row.authors.value }),
      },
      {
        id: "year",
        label: "Year",
        noun: "year",
        provenance: "library_metadata",
        read: (row) => ({ type: "year", value: row.year.value }),
      },
      {
        id: "journal",
        label: "Journal",
        noun: "journal",
        provenance: "library_metadata",
        read: (row) => ({ type: "text", value: row.journal.value }),
      },
      {
        id: "pmid",
        label: "PMID",
        noun: "PMID",
        provenance: "library_metadata",
        note: "The PubMed link is built from the stored PMID and is not checked against this paper.",
        read: (row) => ({
          type: "identifier",
          value: row.pmid.value,
          href: linkOf(row.links.value, "pubmed"),
          linkLabel: "Open in PubMed",
        }),
      },
      {
        id: "doi",
        label: "DOI",
        noun: "DOI",
        provenance: "library_metadata",
        note: "The doi.org link is built from the stored DOI and is not checked against this paper.",
        read: (row) => ({
          type: "identifier",
          value: row.doi.value,
          href: linkOf(row.links.value, "doi"),
          linkLabel: "Open DOI link",
        }),
      },
    ],
  },
  {
    id: "study",
    label: "Study metadata",
    fields: [
      {
        id: "studyTypeClassification",
        label: "PaperLume study-type classification",
        noun: "classification",
        provenance: "classification_lineage_unrecorded",
        note: "It may have been set by a Study Types pool match, the publication-type fallback, AI analysis, a manual edit or a merge; which one is not recorded.",
        read: (row) => ({ type: "text", value: row.studyTypeClassification.value }),
      },
      {
        id: "publicationTypes",
        label: "Import-recorded publication types (PubMed/NBIB)",
        noun: "publication types",
        provenance: "import_recorded_publication_types",
        read: (row) => ({ type: "list", value: row.publicationTypes.value }),
      },
      {
        id: "importedTypeText",
        label: "Imported study-type text",
        noun: "imported study-type text",
        provenance: "imported_source_unrecorded",
        long: true,
        read: (row) => ({ type: "text", value: row.importedTypeText.value }),
      },
      {
        id: "statisticalMethods",
        label: "Stored statistical methods / AI or user annotation",
        noun: "statistical methods",
        provenance: "ai_or_user_annotation",
        long: true,
        read: (row) => ({ type: "text", value: row.statisticalMethods.value }),
      },
    ],
  },
  {
    id: "content",
    label: "Stored research content",
    fields: [
      {
        id: "abstract",
        label: "Abstract as stored in your library",
        noun: "abstract",
        provenance: "stored_abstract",
        long: true,
        read: (row) => ({ type: "text", value: row.abstract.value }),
      },
      {
        id: "tldr",
        label: "Stored TL;DR / AI or user annotation",
        noun: "TL;DR",
        provenance: "ai_or_user_annotation",
        long: true,
        read: (row) => ({ type: "text", value: row.tldr.value }),
      },
      {
        id: "notes",
        label: "Your notes",
        noun: "notes",
        provenance: "user_entered",
        long: true,
        read: (row) => ({ type: "text", value: row.notes.value }),
      },
    ],
  },
  {
    id: "library",
    label: "Library organization",
    fields: [
      {
        id: "projects",
        label: "Projects",
        noun: "projects",
        provenance: "user_entered",
        read: (row) => ({ type: "taxonomy", taxonomy: row.projects }),
      },
      {
        id: "tags",
        label: "Tags",
        noun: "tags",
        provenance: "user_entered",
        read: (row) => ({ type: "taxonomy", taxonomy: row.tags }),
      },
      {
        id: "keywords",
        label: "Keywords",
        noun: "keywords",
        provenance: "derived_keywords",
        read: (row) => ({ type: "list", value: row.keywords.value }),
      },
      {
        id: "importedKeywords",
        label: "Imported keywords",
        noun: "imported keywords",
        provenance: "imported_source_unrecorded",
        read: (row) => ({ type: "list", value: row.importedKeywords.value }),
      },
      {
        id: "meshTerms",
        label: "MeSH terms",
        noun: "MeSH terms",
        provenance: "imported_source_unrecorded",
        read: (row) => ({ type: "list", value: row.meshTerms.value }),
      },
      {
        id: "substances",
        label: "Substances",
        noun: "substances",
        provenance: "imported_source_unrecorded",
        read: (row) => ({ type: "list", value: row.substances.value }),
      },
      {
        id: "attachments",
        label: "Attachments",
        noun: "attachments",
        provenance: "display_derivation",
        note: "Counted from the file types recorded at upload; the files are not opened.",
        read: (row) => ({ type: "attachments", summary: row.attachments.value }),
      },
    ],
  },
] satisfies readonly ComparisonGroupDef[]);

export const DEFAULT_COMPARISON_GROUP: ComparisonGroupId = "bibliographic";

/** The caveat shown with a field: its category's, plus its own note. */
export function fieldCaveat(field: ComparisonFieldDef): string {
  const caveat = PROVENANCE_CAVEATS[field.provenance];
  return field.note ? `${caveat} ${field.note}` : caveat;
}

export const SORT_LABELS: Readonly<Record<ComparisonSort, string>> = Object.freeze({
  year_desc: "Year, newest first",
  year_asc: "Year, oldest first",
  title_asc: "Title, A to Z",
});

/** The row header's text for a paper whose title is missing, so no paper is ever nameless. */
export const MISSING_TITLE_TEXT = Object.freeze({
  not_recorded: "Untitled paper (title not recorded in library)",
  unreadable: "Untitled paper (stored title cannot be displayed)",
  stored_placeholder: "Untitled paper (stored placeholder: Not specified)",
} satisfies Record<Exclude<FieldValue<unknown>["kind"], "present">, string>);

/**
 * "Doe J et al. · 2021 · Journal" from the parts that are present. "et al."
 * only when more than one author is stored. Missing parts are left out rather
 * than given a placeholder; their state is shown in the Bibliographic group.
 */
export function identityLine(row: ComparisonRow): string {
  const parts: string[] = [];
  const authors = row.authors.value;
  if (authors.kind === "present") {
    parts.push(authors.value.length > 1 ? `${authors.value[0]} et al.` : authors.value[0]);
  }
  if (row.year.value.kind === "present") parts.push(String(row.year.value.value));
  if (row.journal.value.kind === "present") parts.push(row.journal.value.value);
  return parts.join(" · ");
}

/** Longer than this, or with more lines than `TEXT_PREVIEW_LINES`, free text starts clamped. */
export const TEXT_PREVIEW_CHARS = 240;
export const TEXT_PREVIEW_LINES = 4;
/** More items than this, a list starts shortened. */
export const LIST_PREVIEW_ITEMS = 6;

/** Whether `text` starts clamped behind a "Show full …" control. */
export function isLongText(text: string): boolean {
  return text.length > TEXT_PREVIEW_CHARS || text.split("\n").length > TEXT_PREVIEW_LINES;
}
