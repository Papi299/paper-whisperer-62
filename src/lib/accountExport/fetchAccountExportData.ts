import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { fetchAllPages, type RangeableQuery } from "@/lib/fetchAllPages";
import { fetchAllPagesInChunks } from "@/lib/fetchAllPagesInChunks";
import { attachmentArchivePath, isSafeArchivePath } from "./sanitizeArchiveFilename";
import {
  AccountExportError,
  PAPER_EXPORT_COLUMNS,
  SAFE_PROFILE_COLUMNS,
  type AccountExportData,
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
    ] = await Promise.all([
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
    ]);
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

  if (profile && profile.user_id !== userId) {
    throw integrityFailure("profiles returned a row belonging to another user");
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
