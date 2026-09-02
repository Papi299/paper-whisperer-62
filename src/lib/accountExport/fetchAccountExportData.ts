import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { fetchAllPages, type RangeableQuery } from "@/lib/fetchAllPages";
import { fetchAllPagesInChunks } from "@/lib/fetchAllPagesInChunks";
import { isAuthorIdentitySchemaMissing } from "@/lib/authorIdentityAvailability";
import { isAiModelPreferenceSchemaMissing } from "@/lib/aiModelPreferenceAvailability";
import { attachmentArchivePath, isSafeArchivePath } from "./sanitizeArchiveFilename";
import {
  AccountExportError,
  AUTHOR_IDENTITY_ALIAS_EXPORT_COLUMNS,
  AUTHOR_IDENTITY_EXPORT_COLUMNS,
  AUTHOR_IDENTITY_LINK_EXPORT_COLUMNS,
  AUTHOR_IDENTITY_MERGE_EXPORT_COLUMNS,
  PAPER_EXPORT_COLUMNS,
  SAFE_PROFILE_COLUMNS,
  USER_AI_PREFERENCE_EXPORT_COLUMNS,
  type AccountExportData,
  type ExportedAuthorIdentity,
  type ExportedAuthorIdentityAlias,
  type ExportedAuthorIdentityLink,
  type ExportedAuthorIdentityMerge,
  type ExportedAttachment,
  type ExportedFilterPreset,
  type ExportedKeywordExclusion,
  type ExportedKeywordPool,
  type ExportedPaper,
  type ExportedPaperProject,
  type ExportedPaperTag,
  type ExportedProject,
  type ExportedStudyTypeExclusion,
  type ExportedStudyTypePool,
  type ExportedSynonymPool,
  type ExportedTag,
  type ExportedUserAiPreference,
  type SafeExportProfile,
} from "./types";

/**
 * The read layer for PFA-C02 full account export.
 *
 * Two rules govern every query here.
 *
 * **S2 client scoping.** Every directly user-owned table carries an explicit
 * `.eq("user_id", userId)` predicate. RLS already isolates these tables, but a
 * whole-account read is the widest read surface in the product and must not
 * depend on a single control. The junction tables have no `user_id` column, so
 * they are reached only *through* the signed-in user's own paper IDs and then
 * re-validated against the owned object sets — an unrestricted whole-table
 * read is never issued.
 *
 * **Completeness.** Nothing here issues a single unpaginated `select()` and
 * assumes the response is whole: PostgREST caps a response at 1000 rows by
 * default, and an account may hold far more. Every collection is read through
 * `fetchAllPages` (or `fetchAllPagesInChunks` for the junctions, where the ID
 * list is batched *and* each batch paginated).
 */

/** Any public table read through the S2-scoped owned-table path. */
type OwnedTable = keyof Database["public"]["Tables"];

const PROFILE_SELECT = SAFE_PROFILE_COLUMNS.join(", ");
const PAPERS_SELECT = PAPER_EXPORT_COLUMNS.join(", ");
const AUTHOR_IDENTITIES_SELECT = AUTHOR_IDENTITY_EXPORT_COLUMNS.join(", ");
const AUTHOR_IDENTITY_ALIASES_SELECT = AUTHOR_IDENTITY_ALIAS_EXPORT_COLUMNS.join(", ");
const AUTHOR_IDENTITY_LINKS_SELECT = AUTHOR_IDENTITY_LINK_EXPORT_COLUMNS.join(", ");
const AUTHOR_IDENTITY_MERGES_SELECT = AUTHOR_IDENTITY_MERGE_EXPORT_COLUMNS.join(", ");
const USER_AI_PREFERENCE_SELECT = USER_AI_PREFERENCE_EXPORT_COLUMNS.join(", ");

/**
 * `select("*")` is used only for tables with no secret column and no derived
 * artifact — every column is user data that must round-trip. `profiles`
 * (holds `pubmed_api_key`) and `papers` (holds the generated `search_vector`)
 * use explicit column lists instead; see `types.ts`.
 */
const ALL_COLUMNS = "*";

/** A user-safe wrapper. The raw cause is preserved for logs, never for the UI. */
function readFailure(cause: unknown): AccountExportError {
  return new AccountExportError("collecting", "Could not read your account data.", { cause });
}

/**
 * An ownership/consistency violation in data the server returned. This is a
 * security signal, not a normal error: it means a row outside the signed-in
 * user's own object graph reached the client. The export fails closed rather
 * than archiving it.
 */
function integrityFailure(detail: string): AccountExportError {
  return new AccountExportError("collecting", "Could not read your account data.", {
    cause: new Error(`Account export integrity check failed: ${detail}`),
  });
}

/**
 * Read every row of a directly user-owned table, paginated, S2-scoped, and in
 * a deterministic order.
 */
async function fetchOwnedTable<T>(
  table: OwnedTable,
  select: string,
  userId: string,
  orderBy: readonly string[],
): Promise<T[]> {
  return fetchAllPages<T>(() => {
    let query = supabase.from(table).select(select).eq("user_id", userId);
    for (const column of orderBy) {
      query = query.order(column, { ascending: true });
    }
    // The dynamic select string erases PostgREST's row inference; the concrete
    // row shape is supplied by the caller's `T` at this typed query boundary.
    return query as unknown as RangeableQuery;
  });
}

/** The four 001C collections, read or stood in for as one unit. */
interface AuthorIdentityExportTables {
  identities: ExportedAuthorIdentity[];
  aliases: ExportedAuthorIdentityAlias[];
  links: ExportedAuthorIdentityLink[];
  merges: ExportedAuthorIdentityMerge[];
}

/** The pre-migration stand-in. Four present-but-empty categories, never absent ones. */
const EMPTY_AUTHOR_IDENTITY_EXPORT: AuthorIdentityExportTables = {
  identities: [],
  aliases: [],
  links: [],
  merges: [],
};

/** Unwrap a settled read, re-throwing the original failure unchanged. */
function requireFulfilled<T>(settled: PromiseSettledResult<T>): T {
  if (settled.status === "rejected") throw settled.reason;
  return settled.value;
}

/**
 * Read the 001C identity collections, tolerating exactly one thing: this
 * environment predating the migration that creates them.
 *
 * WHY THIS EXISTS. The 001C schema is applied to Production separately from —
 * and before — the code that uses it. In the window between, and on every Vercel
 * Preview built from this branch while Production is still behind, an
 * unconditional read of `author_identities` fails. Full account export must not
 * be one of the things that breaks: a user asking for all of their data during a
 * rollout should get all of their data, not an error about a feature they have
 * never used.
 *
 * WHY IT IS ALL-OR-NONE. The migration creates the four tables in one
 * transaction, so a real environment has all four or none. `author_identities`
 * is therefore treated as the probe: if IT reports "no such table", the
 * subsystem is absent and all four categories are exported empty. If it answers
 * normally, the subsystem exists and the other three reads must succeed on their
 * own terms — a schema where one identity table is missing and another is
 * present is a broken installation, and quietly exporting it as empty would hand
 * the user an archive that silently omits decisions they made.
 *
 * WHAT IS NOT TOLERATED. Permission denied, an RLS refusal, a network failure, a
 * malformed query, a missing UNRELATED table: every one of those still fails the
 * export. The classifier is the same narrow one the identity UI uses — it
 * demands both a missing-object code and a 001C object name — precisely so this
 * cannot widen into "if anything goes wrong, pretend the user has no identities".
 */
async function fetchAuthorIdentityExportTables(
  userId: string,
): Promise<AuthorIdentityExportTables> {
  const [identities, aliases, links, merges] = await Promise.allSettled([
    // 001C identity decisions. Directly user-owned, so they take the same
    // S2-scoped, paginated, deterministically ordered path as every other owned
    // table. Merge edges order by their primary key (`source_identity_id`)
    // because that is the only column guaranteed distinct per row.
    fetchOwnedTable<ExportedAuthorIdentity>(
      "author_identities",
      AUTHOR_IDENTITIES_SELECT,
      userId,
      ["created_at", "id"],
    ),
    fetchOwnedTable<ExportedAuthorIdentityAlias>(
      "author_identity_aliases",
      AUTHOR_IDENTITY_ALIASES_SELECT,
      userId,
      ["created_at", "id"],
    ),
    fetchOwnedTable<ExportedAuthorIdentityLink>(
      "author_identity_links",
      AUTHOR_IDENTITY_LINKS_SELECT,
      userId,
      ["created_at", "id"],
    ),
    fetchOwnedTable<ExportedAuthorIdentityMerge>(
      "author_identity_merges",
      AUTHOR_IDENTITY_MERGES_SELECT,
      userId,
      ["created_at", "source_identity_id"],
    ),
  ]);

  if (identities.status === "rejected") {
    if (isAuthorIdentitySchemaMissing(identities.reason)) {
      return EMPTY_AUTHOR_IDENTITY_EXPORT;
    }
    throw identities.reason;
  }

  return {
    identities: identities.value,
    aliases: requireFulfilled(aliases),
    links: requireFulfilled(links),
    merges: requireFulfilled(merges),
  };
}

/**
 * Read the caller's saved AI-model preference, tolerating exactly one thing:
 * this environment predating the migration that creates the table.
 *
 * WHY IT IS READ AT ALL. `set_current_user_ai_model` is granted to
 * `authenticated`, so a real preference row can exist from the moment migration
 * `20260902120000` is applied — a UI is not a precondition for user data. A
 * full account export that omitted it would silently drop a choice the user
 * made, which is the one failure mode this export exists to prevent.
 *
 * WHY A SINGLETON. `user_id` is the table's PRIMARY KEY, so "at most one row"
 * is a schema guarantee. `maybeSingle()` reads that directly and yields `null`
 * when the user has expressed no preference — which is itself the meaningful
 * state, not an empty one.
 *
 * WHAT IS TOLERATED, AND ONLY THIS. A missing-object error naming
 * `user_ai_preferences` returns `null`, so the export keeps working during the
 * schema-before-code rollout window. Nothing else is: permission denied, an RLS
 * refusal, an auth failure, a network error, a timeout, a malformed query or
 * response, a missing UNRELATED table, a generic 4xx/5xx and any unknown error
 * all propagate and fail the whole export. Once the table exists, a genuine read
 * failure is never converted into "no preference" — the two look identical in
 * the archive, and only one of them is true.
 */
async function fetchUserAiPreference(
  userId: string,
): Promise<ExportedUserAiPreference | null> {
  const result = await supabase
    .from("user_ai_preferences")
    .select(USER_AI_PREFERENCE_SELECT)
    // S2 scoping, exactly as every other owned read: RLS already restricts this
    // to the caller's own row, and the predicate means the export never depends
    // on that single control.
    .eq("user_id", userId)
    .maybeSingle();

  if (result.error) {
    if (isAiModelPreferenceSchemaMissing(result.error)) return null;
    throw result.error;
  }

  return (result.data as ExportedUserAiPreference | null) ?? null;
}

/** Read junction rows reachable from the user's own paper IDs. */
async function fetchJunction<T>(
  table: "paper_projects" | "paper_tags",
  select: string,
  paperIds: string[],
): Promise<T[]> {
  return fetchAllPagesInChunks<T>(paperIds, (chunk) => {
    return supabase
      .from(table)
      .select(select)
      .in("paper_id", chunk)
      .order("paper_id", { ascending: true }) as unknown as RangeableQuery;
  });
}

/**
 * Read the signed-in user's complete exportable account dataset.
 *
 * Throws `AccountExportError` on any failed read or any ownership violation —
 * there is no partial result. A "full account export" that silently omits a
 * category would be worse than no export at all, so every failure path here
 * aborts the whole operation.
 */
export async function fetchAccountExportData(userId: string): Promise<AccountExportData> {
  if (!userId) {
    throw new AccountExportError("collecting", "Could not read your account data.", {
      cause: new Error("Account export requires a signed-in user id."),
    });
  }

  let profile: SafeExportProfile | null;
  let papers: ExportedPaper[];
  let projects: ExportedProject[];
  let tags: ExportedTag[];
  let filterPresets: ExportedFilterPreset[];
  let keywordPool: ExportedKeywordPool[];
  let synonymPool: ExportedSynonymPool[];
  let studyTypePool: ExportedStudyTypePool[];
  let keywordExclusionPool: ExportedKeywordExclusion[];
  let studyTypeExclusionPool: ExportedStudyTypeExclusion[];
  let attachmentRows: Omit<ExportedAttachment, "archive_path">[];
  let authorIdentities: ExportedAuthorIdentity[];
  let authorIdentityAliases: ExportedAuthorIdentityAlias[];
  let authorIdentityLinks: ExportedAuthorIdentityLink[];
  let authorIdentityMerges: ExportedAuthorIdentityMerge[];
  let userAiPreference: ExportedUserAiPreference | null;

  try {
    // The profile projection lists its columns explicitly so `pubmed_api_key`
    // is never part of the request. The key is not filtered out downstream —
    // it is never selected, so it never reaches application memory here.
    const profileResult = await supabase
      .from("profiles")
      .select(PROFILE_SELECT)
      .eq("user_id", userId)
      .maybeSingle();
    if (profileResult.error) throw profileResult.error;
    profile = (profileResult.data as SafeExportProfile | null) ?? null;

    const [coreTables, identityTables, aiPreference] = await Promise.all([
      Promise.all([
        fetchOwnedTable<ExportedPaper>("papers", PAPERS_SELECT, userId, ["insert_order", "id"]),
        fetchOwnedTable<ExportedProject>("projects", ALL_COLUMNS, userId, ["created_at", "id"]),
        fetchOwnedTable<ExportedTag>("tags", ALL_COLUMNS, userId, ["created_at", "id"]),
        fetchOwnedTable<ExportedFilterPreset>("filter_presets", ALL_COLUMNS, userId, ["created_at", "id"]),
        fetchOwnedTable<ExportedKeywordPool>("keyword_pool", ALL_COLUMNS, userId, ["created_at", "id"]),
        fetchOwnedTable<ExportedSynonymPool>("synonym_pool", ALL_COLUMNS, userId, ["created_at", "id"]),
        fetchOwnedTable<ExportedStudyTypePool>("study_type_pool", ALL_COLUMNS, userId, ["created_at", "id"]),
        fetchOwnedTable<ExportedKeywordExclusion>("keyword_exclusion_pool", ALL_COLUMNS, userId, ["created_at", "id"]),
        fetchOwnedTable<ExportedStudyTypeExclusion>("study_type_exclusion_pool", ALL_COLUMNS, userId, ["created_at", "id"]),
        fetchOwnedTable<Omit<ExportedAttachment, "archive_path">>(
          "paper_attachments",
          ALL_COLUMNS,
          userId,
          ["created_at", "id"],
        ),
      ]),
      // Read in parallel with everything else, but through its own all-or-none
      // gate: the 001C tables are the only ones whose absence is an expected
      // state of a correctly deployed environment. See
      // `fetchAuthorIdentityExportTables`.
      fetchAuthorIdentityExportTables(userId),
      // Same shape of gate, its own narrow classifier: the preference table is
      // the other object whose absence is an expected state of a correctly
      // deployed environment during rollout. See `fetchUserAiPreference`.
      fetchUserAiPreference(userId),
    ]);

    [
      papers,
      projects,
      tags,
      filterPresets,
      keywordPool,
      synonymPool,
      studyTypePool,
      keywordExclusionPool,
      studyTypeExclusionPool,
      attachmentRows,
    ] = coreTables;

    authorIdentities = identityTables.identities;
    authorIdentityAliases = identityTables.aliases;
    authorIdentityLinks = identityTables.links;
    authorIdentityMerges = identityTables.merges;
    userAiPreference = aiPreference;
  } catch (error) {
    if (error instanceof AccountExportError) throw error;
    throw readFailure(error);
  }

  const ownedPaperIds = new Set(papers.map((paper) => paper.id));
  const ownedProjectIds = new Set(projects.map((project) => project.id));
  const ownedTagIds = new Set(tags.map((tag) => tag.id));

  // Defense-in-depth on the S2-scoped reads themselves: a row whose `user_id`
  // is not the signed-in user must never be archived, whatever produced it.
  assertOwnedRows(papers, userId, "papers");
  assertOwnedRows(projects, userId, "projects");
  assertOwnedRows(tags, userId, "tags");
  assertOwnedRows(filterPresets, userId, "filter_presets");
  assertOwnedRows(keywordPool, userId, "keyword_pool");
  assertOwnedRows(synonymPool, userId, "synonym_pool");
  assertOwnedRows(studyTypePool, userId, "study_type_pool");
  assertOwnedRows(keywordExclusionPool, userId, "keyword_exclusion_pool");
  assertOwnedRows(studyTypeExclusionPool, userId, "study_type_exclusion_pool");
  assertOwnedRows(attachmentRows, userId, "paper_attachments");
  assertOwnedRows(authorIdentities, userId, "author_identities");
  assertOwnedRows(authorIdentityAliases, userId, "author_identity_aliases");
  assertOwnedRows(authorIdentityLinks, userId, "author_identity_links");
  assertOwnedRows(authorIdentityMerges, userId, "author_identity_merges");

  if (profile && profile.user_id !== userId) {
    throw integrityFailure("profiles returned a row belonging to another user");
  }

  // The preference is a singleton, so `assertOwnedRows` does not cover it — but
  // it carries a `user_id` and therefore gets the same treatment: a row for
  // anyone else must never be archived, whatever produced it.
  if (userAiPreference && userAiPreference.user_id !== userId) {
    throw integrityFailure("user_ai_preferences returned a row belonging to another user");
  }

  let paperProjects: ExportedPaperProject[];
  let paperTags: ExportedPaperTag[];
  try {
    const paperIds = [...ownedPaperIds];
    [paperProjects, paperTags] = await Promise.all([
      fetchJunction<ExportedPaperProject>("paper_projects", "paper_id, project_id", paperIds),
      fetchJunction<ExportedPaperTag>("paper_tags", "paper_id, tag_id", paperIds),
    ]);
  } catch (error) {
    throw readFailure(error);
  }

  // Both endpoints of every relationship must be inside the owned object sets.
  // A relationship pointing outside them means RLS returned something it
  // should not have; it is dropped from neither the export nor the error path
  // — the whole export fails.
  for (const row of paperProjects) {
    if (!ownedPaperIds.has(row.paper_id)) {
      throw integrityFailure("paper_projects referenced a paper outside the account");
    }
    if (!ownedProjectIds.has(row.project_id)) {
      throw integrityFailure("paper_projects referenced a project outside the account");
    }
  }
  for (const row of paperTags) {
    if (!ownedPaperIds.has(row.paper_id)) {
      throw integrityFailure("paper_tags referenced a paper outside the account");
    }
    if (!ownedTagIds.has(row.tag_id)) {
      throw integrityFailure("paper_tags referenced a tag outside the account");
    }
  }

  // Junction order is not guaranteed across ID batches; sort so the same
  // account produces the same archive bytes on every run.
  paperProjects.sort(
    (a, b) => a.paper_id.localeCompare(b.paper_id) || a.project_id.localeCompare(b.project_id),
  );
  paperTags.sort(
    (a, b) => a.paper_id.localeCompare(b.paper_id) || a.tag_id.localeCompare(b.tag_id),
  );

  // Identity decisions are a small graph, and every edge of it must land inside
  // this account's own objects. The database already guarantees this with
  // composite `(user_id, identity_id)` foreign keys, so a violation here would
  // mean a row reached the client that the schema says cannot exist — the same
  // fail-closed treatment the junction tables get, for the same reason.
  const ownedIdentityIds = new Set(authorIdentities.map((identity) => identity.id));

  for (const row of authorIdentityAliases) {
    if (!ownedIdentityIds.has(row.identity_id)) {
      throw integrityFailure("author_identity_aliases referenced an identity outside the account");
    }
  }
  for (const row of authorIdentityLinks) {
    if (!ownedIdentityIds.has(row.identity_id)) {
      throw integrityFailure("author_identity_links referenced an identity outside the account");
    }
    // A link's paper must be one of the papers being archived, or the exported
    // link would point at nothing a reader of this archive can resolve.
    if (!ownedPaperIds.has(row.paper_id)) {
      throw integrityFailure("author_identity_links referenced a paper outside the account");
    }
  }
  for (const row of authorIdentityMerges) {
    if (!ownedIdentityIds.has(row.source_identity_id)) {
      throw integrityFailure("author_identity_merges referenced a source identity outside the account");
    }
    if (!ownedIdentityIds.has(row.target_identity_id)) {
      throw integrityFailure("author_identity_merges referenced a target identity outside the account");
    }
  }

  const attachments: ExportedAttachment[] = attachmentRows.map((row) => {
    if (!ownedPaperIds.has(row.paper_id)) {
      throw integrityFailure("paper_attachments referenced a paper outside the account");
    }
    // Storage namespace check. Every attachment this application writes lives
    // under `<userId>/…`; anything else is unexpected and must not be fetched.
    if (!isOwnedStoragePath(row.file_path, userId)) {
      throw integrityFailure("paper_attachments referenced a storage path outside the account");
    }
    const archive_path = attachmentArchivePath(row);
    if (!isSafeArchivePath(archive_path)) {
      throw integrityFailure("attachment archive path failed the safety check");
    }
    return { ...row, archive_path };
  });

  return {
    profile,
    papers,
    projects,
    paper_projects: paperProjects,
    tags,
    paper_tags: paperTags,
    filter_presets: filterPresets,
    keyword_pool: keywordPool,
    synonym_pool: synonymPool,
    study_type_pool: studyTypePool,
    keyword_exclusion_pool: keywordExclusionPool,
    study_type_exclusion_pool: studyTypeExclusionPool,
    paper_attachments: attachments,
    author_identities: authorIdentities,
    author_identity_aliases: authorIdentityAliases,
    author_identity_links: authorIdentityLinks,
    author_identity_merges: authorIdentityMerges,
    user_ai_preferences: userAiPreference,
  };
}

/** Every row of a `user_id`-bearing table must belong to the signed-in user. */
function assertOwnedRows(
  rows: readonly { user_id: string }[],
  userId: string,
  table: string,
): void {
  for (const row of rows) {
    if (row.user_id !== userId) {
      throw integrityFailure(`${table} returned a row belonging to another user`);
    }
  }
}

/**
 * True when `filePath` is structurally inside the signed-in user's Storage
 * namespace: it must start with `<userId>/`, name something after that prefix,
 * and contain no traversal segment that could climb back out.
 */
export function isOwnedStoragePath(filePath: string, userId: string): boolean {
  if (typeof filePath !== "string" || filePath === "" || userId === "") return false;
  const prefix = `${userId}/`;
  if (!filePath.startsWith(prefix)) return false;
  const rest = filePath.slice(prefix.length);
  if (rest === "") return false;
  const segments = filePath.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
