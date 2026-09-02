import { describe, it, expect } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import {
  ACCOUNT_EXPORT_CATEGORIES,
  ACCOUNT_EXPORT_COLLECTIONS,
  ACCOUNT_EXPORT_EXCLUDED_TABLES,
  ACCOUNT_EXPORT_SINGLETONS,
  EXPECTED_ARCHIVE_JSON_PATHS,
  MANIFEST_PATH,
  categoryArchivePath,
  type AccountExportDataMatchesRegistry,
  type AuthorIdentityAliasColumnsAreExported,
  type AuthorIdentityColumnsAreExported,
  type AuthorIdentityLinkColumnsAreExported,
  type AuthorIdentityMergeColumnsAreExported,
  type PaperColumnsAreClassified,
  type ProfileColumnsAreClassified,
} from "../types";

/**
 * The completeness guard for PFA-C02.
 *
 * The single biggest functional risk in a "full account export" is quietly
 * dropping one category in a later refactor. These assertions pin the registry
 * to the audit's Option A contract, and the type-level guards below make an
 * unclassified table or column a `npm run typecheck` failure rather than a
 * silent omission at runtime.
 */

type PublicTable = keyof Database["public"]["Tables"];

/** Junction tables are exported, but under their own relationship categories. */
type JunctionTable = "paper_projects" | "paper_tags";

/** Compile-time: every public table is exported, excluded, or a junction. */
export type EveryTableIsClassified = Exclude<
  PublicTable,
  | (typeof ACCOUNT_EXPORT_COLLECTIONS)[number]
  | "profiles"
  | (typeof ACCOUNT_EXPORT_EXCLUDED_TABLES)[number]
  | JunctionTable
> extends never
  ? true
  : never;

describe("account export compile-time guards", () => {
  /*
   * Each guard type resolves to `true` only while its invariant holds and to
   * `never` otherwise, so the annotated assignment below fails `npm run
   * typecheck` the moment a table or column stops being classified. The
   * runtime `expect` is what keeps the binding in a value position — without
   * it the alias would compile away and guard nothing.
   */

  it("classifies every profiles column as safe or excluded", () => {
    const guard: ProfileColumnsAreClassified = true;
    expect(guard).toBe(true);
  });

  it("classifies every papers column as exported or excluded", () => {
    const guard: PaperColumnsAreClassified = true;
    expect(guard).toBe(true);
  });

  it("keeps the export dataset shape identical to the category registry", () => {
    const guard: AccountExportDataMatchesRegistry = true;
    expect(guard).toBe(true);
  });

  it("classifies every public table as exported, junction, or out of scope", () => {
    const guard: EveryTableIsClassified = true;
    expect(guard).toBe(true);
  });

  /*
   * 001C identity decisions are not reconstructible from anything else in the
   * archive, so every column of all four tables must travel. There is no
   * "excluded" counterpart to balance against: none of these tables holds a
   * secret or a generated artifact, so a column missing from its export list is
   * always a loss, never a decision.
   */
  it("exports every author_identities column", () => {
    const guard: AuthorIdentityColumnsAreExported = true;
    expect(guard).toBe(true);
  });

  it("exports every author_identity_aliases column", () => {
    const guard: AuthorIdentityAliasColumnsAreExported = true;
    expect(guard).toBe(true);
  });

  it("exports every author_identity_links column", () => {
    const guard: AuthorIdentityLinkColumnsAreExported = true;
    expect(guard).toBe(true);
  });

  it("exports every author_identity_merges column", () => {
    const guard: AuthorIdentityMergeColumnsAreExported = true;
    expect(guard).toBe(true);
  });
});

describe("account export category registry", () => {
  it("covers exactly the PFA-C02 Option A category set", () => {
    // The audit's required minimum set, expressed as the archive files that
    // must exist. `notes` is a column on `papers` in the current schema and
    // therefore has no separate file; attachment binaries live under
    // `attachments/` rather than in a JSON category.
    expect([...ACCOUNT_EXPORT_CATEGORIES].sort()).toEqual(
      [
        "profile",
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
        // AUTHOR-IDENTITY-RESOLUTION-001C. Four additive files; no existing file
        // changed shape, which is why ACCOUNT_EXPORT_VERSION stays 2.
        "author_identities",
        "author_identity_aliases",
        "author_identity_links",
        "author_identity_merges",
      ].sort(),
    );
  });

  it("maps every category to a deterministic, safe archive path", () => {
    for (const key of ACCOUNT_EXPORT_CATEGORIES) {
      expect(categoryArchivePath(key)).toBe(`data/${key}.json`);
    }
    expect(EXPECTED_ARCHIVE_JSON_PATHS[0]).toBe(MANIFEST_PATH);
    expect(EXPECTED_ARCHIVE_JSON_PATHS).toHaveLength(
      ACCOUNT_EXPORT_CATEGORIES.length + 1,
    );
    expect(new Set(EXPECTED_ARCHIVE_JSON_PATHS).size).toBe(
      EXPECTED_ARCHIVE_JSON_PATHS.length,
    );
  });

  it("splits categories into collections and singletons with no overlap", () => {
    const collections = new Set<string>(ACCOUNT_EXPORT_COLLECTIONS);
    const singletons = new Set<string>(ACCOUNT_EXPORT_SINGLETONS);

    expect(singletons).toEqual(new Set(["profile"]));
    for (const key of collections) expect(singletons.has(key)).toBe(false);
    expect(collections.size + singletons.size).toBe(ACCOUNT_EXPORT_CATEGORIES.length);
  });

  it("keeps every relationship category in the export", () => {
    // These are the ones a refactor is most likely to lose, because they carry
    // no `user_id` of their own.
    for (const key of ["paper_projects", "paper_tags"]) {
      expect(ACCOUNT_EXPORT_CATEGORIES).toContain(key);
    }
  });

  it("keeps every pool and exclusion category in the export", () => {
    for (const key of [
      "keyword_pool",
      "synonym_pool",
      "study_type_pool",
      "keyword_exclusion_pool",
      "study_type_exclusion_pool",
      "filter_presets",
      "paper_attachments",
    ]) {
      expect(ACCOUNT_EXPORT_CATEGORIES).toContain(key);
    }
  });

  it("declares the commercial, internal and model-selection tables as out of scope", () => {
    expect([...ACCOUNT_EXPORT_EXCLUDED_TABLES].sort()).toEqual(
      [
        "internal_user_access",
        "subscriptions",
        "subscription_events",
        "usage_counters",
        "usage_credits",
        "user_entitlements",
        "user_storage_usage",
        // AI-MODEL-SELECTION-001A. `ai_model_catalog` is global product metadata
        // and is permanently out of scope; `user_ai_preferences` is genuine user
        // content whose export is DEFERRED only while the preference is
        // unreachable — 001C must promote it to a singleton category. Pinned
        // here so that promotion is a deliberate edit rather than a silent one.
        "ai_model_catalog",
        "user_ai_preferences",
      ].sort(),
    );

    // An excluded table must never also be an exported category.
    for (const table of ACCOUNT_EXPORT_EXCLUDED_TABLES) {
      expect(ACCOUNT_EXPORT_CATEGORIES).not.toContain(table);
    }
  });
});
