import type { Database } from "@/integrations/supabase/types";

/**
 * PFA-C02 — full account data export (audit Option A, complete data portability).
 *
 * This module is the **single central definition** of the export contract:
 * which categories exist, where each one lands inside the archive, which
 * columns are read, and which columns are deliberately never read. Everything
 * else (the fetch layer, the manifest builder, the archive builder, the tests)
 * derives from the constants here, so a future refactor cannot silently drop a
 * category — the completeness test compares the produced archive against
 * `ACCOUNT_EXPORT_CATEGORIES`.
 *
 * Scope boundary: this is the signed-in user's own **content, organization,
 * attachments, and non-secret profile data**. Commercial/infrastructure tables
 * are intentionally out of scope — see `ACCOUNT_EXPORT_EXCLUDED_TABLES`.
 */

type Tables = Database["public"]["Tables"];

/** Archive format identifier written into `manifest.json`. */
export const ACCOUNT_EXPORT_FORMAT = "paperlume-account-export" as const;

/**
 * Archive format version. Bump when the archive layout or the meaning of an
 * existing file changes in a way a reader must notice. Adding a new category
 * file is additive; removing or reshaping one is not.
 */
export const ACCOUNT_EXPORT_VERSION = 1 as const;

/** Root-relative path of the manifest inside the archive. */
export const MANIFEST_PATH = "manifest.json";

/** Directory holding every JSON category file. */
export const DATA_DIR = "data";

/** Directory holding attachment binaries. */
export const ATTACHMENTS_DIR = "attachments";

/** Private Storage bucket holding attachment binaries. */
export const ATTACHMENTS_BUCKET = "attachments";

/**
 * Collection categories — each is a JSON array at `data/<key>.json`, present
 * even when the collection is empty (`[]`).
 *
 * `papers` carries per-paper **notes** in its `notes` column; notes are not a
 * separate table in the current schema and therefore not a separate file.
 */
export const ACCOUNT_EXPORT_COLLECTIONS = [
  "papers",
  "projects",
  "paper_projects",
  "tags",
  "paper_tags",
  "filter_presets",
  "keyword_pool",
  "synonym_pool",
  "study_type_pool",
  "keyword_exclusion_pool",
  "study_type_exclusion_pool",
  "paper_attachments",
] as const;

/**
 * Singleton categories — each is a single JSON value at `data/<key>.json`.
 * `profile` is an object when the row exists and `null` when it does not; the
 * file is always present.
 */
export const ACCOUNT_EXPORT_SINGLETONS = ["profile"] as const;

export type AccountExportCollectionKey = (typeof ACCOUNT_EXPORT_COLLECTIONS)[number];
export type AccountExportSingletonKey = (typeof ACCOUNT_EXPORT_SINGLETONS)[number];
export type AccountExportCategoryKey =
  | AccountExportCollectionKey
  | AccountExportSingletonKey;

/** Every category key, in a stable documented order. */
export const ACCOUNT_EXPORT_CATEGORIES: readonly AccountExportCategoryKey[] = [
  ...ACCOUNT_EXPORT_SINGLETONS,
  ...ACCOUNT_EXPORT_COLLECTIONS,
];

/** Archive path of a category's JSON file. Deterministic, one rule for all. */
export function categoryArchivePath(key: AccountExportCategoryKey): string {
  return `${DATA_DIR}/${key}.json`;
}

/** Every JSON path the archive must contain, manifest included. */
export const EXPECTED_ARCHIVE_JSON_PATHS: readonly string[] = [
  MANIFEST_PATH,
  ...ACCOUNT_EXPORT_CATEGORIES.map(categoryArchivePath),
];

/**
 * Tables that carry a `user_id` but are **out of PFA-C02 scope**: commercial
 * entitlement internals, server-only accounting, and authorization metadata.
 * None of them is user-authored account content, so exporting them would leak
 * implementation and security internals rather than improve portability.
 *
 * Listed explicitly (not merely omitted) so the boundary is reviewable, and
 * asserted by test so a future "export everything with a user_id" refactor
 * fails loudly.
 */
export const ACCOUNT_EXPORT_EXCLUDED_TABLES = [
  "internal_user_access",
  "subscriptions",
  "subscription_events",
  "usage_counters",
  "usage_credits",
  "user_entitlements",
  "user_storage_usage",
] as const;

/* -------------------------------------------------------------------------
 * profiles — explicit safe-field whitelist
 * ---------------------------------------------------------------------- */

/**
 * The **only** `profiles` columns the export query selects.
 *
 * `pubmed_api_key` is a user-supplied credential. It is excluded at the
 * **query** level, not at serialization time, so the secret never enters
 * application memory on the export path at all. Never replace this with
 * `select("*")`.
 */
export const SAFE_PROFILE_COLUMNS = [
  "id",
  "user_id",
  "email",
  "display_name",
  "created_at",
  "updated_at",
] as const;

/** Deliberately never selected from `profiles`. */
export const EXCLUDED_PROFILE_COLUMNS = ["pubmed_api_key"] as const;

export type SafeProfileColumn = (typeof SAFE_PROFILE_COLUMNS)[number];

/** The exported profile shape — a whitelist projection, never a Supabase `User`. */
export type SafeExportProfile = Pick<Tables["profiles"]["Row"], SafeProfileColumn>;

/**
 * Compile-time exhaustiveness guard: every `profiles` column is either
 * whitelisted or explicitly excluded. Adding a column to the table without
 * classifying it here fails `npm run typecheck`, forcing a deliberate
 * safe/secret decision instead of a silent omission or a silent leak.
 */
export type ProfileColumnsAreClassified = Exclude<
  keyof Tables["profiles"]["Row"],
  SafeProfileColumn | (typeof EXCLUDED_PROFILE_COLUMNS)[number]
> extends never
  ? true
  : never;

/* -------------------------------------------------------------------------
 * papers — explicit column list
 * ---------------------------------------------------------------------- */

/**
 * Columns selected for `papers`. Listed explicitly rather than `select("*")`
 * so the export contract is stable and reviewable, and so a future column
 * carrying a secret cannot join the export by default.
 *
 * Every stored value is exported verbatim — nulls, arrays, JSONB objects,
 * timestamps, identifiers, structured publication provenance
 * (`raw_publication_types`), AI-analysis fields (`tldr`, `study_type`,
 * `statistical_methods`), `notes`, and the `insert_order` ordering field. The
 * export does **not** apply the CSV/RIS/BibTeX serializers' lossy coercions.
 */
export const PAPER_EXPORT_COLUMNS = [
  "id",
  "user_id",
  "title",
  "authors",
  "year",
  "journal",
  "pmid",
  "doi",
  "abstract",
  "has_abstract",
  "study_type",
  "raw_study_type",
  "raw_publication_types",
  "statistical_methods",
  "keywords",
  "raw_keywords",
  "mesh_terms",
  "substances",
  "pubmed_url",
  "journal_url",
  "drive_url",
  "tldr",
  "notes",
  "insert_order",
  "created_at",
  "updated_at",
] as const;

/**
 * `papers` columns deliberately not exported.
 *
 * `search_vector` is a derived Postgres full-text index artifact maintained by
 * a trigger from the columns above — not user data, not restorable input, and
 * meaningless outside this database. Excluding it is a documented decision,
 * not an oversight.
 */
export const EXCLUDED_PAPER_COLUMNS = ["search_vector"] as const;

export type PaperExportColumn = (typeof PAPER_EXPORT_COLUMNS)[number];

export type ExportedPaper = Pick<Tables["papers"]["Row"], PaperExportColumn>;

/** Compile-time exhaustiveness guard — see `ProfileColumnsAreClassified`. */
export type PaperColumnsAreClassified = Exclude<
  keyof Tables["papers"]["Row"],
  PaperExportColumn | (typeof EXCLUDED_PAPER_COLUMNS)[number]
> extends never
  ? true
  : never;

/* -------------------------------------------------------------------------
 * Row shapes
 * ---------------------------------------------------------------------- */

export type ExportedProject = Tables["projects"]["Row"];
export type ExportedTag = Tables["tags"]["Row"];
export type ExportedFilterPreset = Tables["filter_presets"]["Row"];
export type ExportedKeywordPool = Tables["keyword_pool"]["Row"];
export type ExportedSynonymPool = Tables["synonym_pool"]["Row"];
export type ExportedStudyTypePool = Tables["study_type_pool"]["Row"];
export type ExportedKeywordExclusion = Tables["keyword_exclusion_pool"]["Row"];
export type ExportedStudyTypeExclusion = Tables["study_type_exclusion_pool"]["Row"];
export type ExportedPaperProject = Tables["paper_projects"]["Row"];
export type ExportedPaperTag = Tables["paper_tags"]["Row"];

/** Stored attachment metadata, plus the archive path its binary is written to. */
export type ExportedAttachment = Tables["paper_attachments"]["Row"] & {
  /**
   * Where this attachment's binary lives inside the archive. The original
   * `file_name` is preserved untouched above; this sanitized, ID-prefixed path
   * exists for safe transport only.
   */
  archive_path: string;
};

/** The complete in-memory dataset for one account export. */
export interface AccountExportData {
  profile: SafeExportProfile | null;
  papers: ExportedPaper[];
  projects: ExportedProject[];
  paper_projects: ExportedPaperProject[];
  tags: ExportedTag[];
  paper_tags: ExportedPaperTag[];
  filter_presets: ExportedFilterPreset[];
  keyword_pool: ExportedKeywordPool[];
  synonym_pool: ExportedSynonymPool[];
  study_type_pool: ExportedStudyTypePool[];
  keyword_exclusion_pool: ExportedKeywordExclusion[];
  study_type_exclusion_pool: ExportedStudyTypeExclusion[];
  paper_attachments: ExportedAttachment[];
}

/**
 * Compile-time guard that `AccountExportData` covers exactly the registry.
 * A new category key with no field (or a field with no key) fails typecheck.
 */
export type AccountExportDataMatchesRegistry = Exclude<
  keyof AccountExportData,
  AccountExportCategoryKey
> extends never
  ? Exclude<AccountExportCategoryKey, keyof AccountExportData> extends never
    ? true
    : never
  : never;

/* -------------------------------------------------------------------------
 * Manifest
 * ---------------------------------------------------------------------- */

export interface AccountExportManifest {
  format: typeof ACCOUNT_EXPORT_FORMAT;
  version: typeof ACCOUNT_EXPORT_VERSION;
  /** ISO-8601 UTC instant the export was generated. */
  generated_at: string;
  /** The account the archive belongs to. Never an email or a session object. */
  user_id: string;
  /** Row count and archive path per category, for every category. */
  categories: Record<
    AccountExportCategoryKey,
    { count: number; path: string }
  >;
  attachments: {
    /** Number of attachment binaries actually written into the archive. */
    count: number;
    /** Total bytes of those binaries as archived. */
    total_bytes: number;
  };
}

/* -------------------------------------------------------------------------
 * Progress + failure reporting
 * ---------------------------------------------------------------------- */

export type AccountExportStage = "collecting" | "attachments" | "archiving";

export interface AccountExportProgress {
  stage: AccountExportStage;
  /** Attachments completed so far (`attachments` stage only). */
  current?: number;
  /** Total attachments expected (`attachments` stage only). */
  total?: number;
}

export type AccountExportProgressHandler = (progress: AccountExportProgress) => void;

/**
 * A user-safe export failure.
 *
 * `message` is deliberately high-level and safe to render. The underlying
 * cause is kept on `cause` for debugging but is never surfaced to the user, so
 * raw Postgres/Storage/session details cannot leak into the UI.
 */
export class AccountExportError extends Error {
  readonly stage: AccountExportStage;
  /** The underlying failure. Never rendered — the compile target predates the
   *  standard `cause` option, so it is attached explicitly. */
  readonly cause?: unknown;

  constructor(stage: AccountExportStage, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AccountExportError";
    this.stage = stage;
    this.cause = options?.cause;
  }
}
