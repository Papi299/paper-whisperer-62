import type { QueryData } from "@supabase/supabase-js";
import type { supabase } from "@/integrations/supabase/client";
import type { ComparisonRequest } from "./types";

/**
 * The comparison's one projection: the stored values the read model maps, the
 * attachment *metadata* needed to count files, and each Project/Tag assignment
 * with the Project/Tag it points to — in a single statement, so every value
 * comes from the same database snapshot.
 *
 * Every nested record carries its foreign key (`paper_id`) and owner
 * (`user_id`), so `mapComparisonRow` can prove it belongs to the paper and the
 * user it is shown under rather than trusting the embedding.
 *
 * Deliberately NOT selected:
 * - `search_vector`, `has_abstract` (presence is judged from the text itself);
 * - `author_provenance`, `insert_order`, `created_at`, `updated_at`;
 * - `pubmed_url`, `journal_url`, `drive_url` — free-text links (imported or
 *   typed), so links are built only from a validated PMID/DOI instead;
 * - every attachment column but `id`, `paper_id`, `user_id` and `file_type`:
 *   no `file_path`, `file_name` or size, and nothing that could become a
 *   Storage path or signed URL. Attachment contents are never read.
 */
export const COMPARISON_PAPER_SELECT = `
  id, user_id, title, authors, year, journal, pmid, doi,
  abstract, study_type, raw_study_type, raw_publication_types,
  statistical_methods, tldr, notes,
  keywords, raw_keywords, mesh_terms, substances,
  paper_attachments ( id, paper_id, user_id, file_type ),
  paper_projects ( paper_id, project:projects ( id, user_id, name, color ) ),
  paper_tags ( paper_id, tag:tags ( id, user_id, name, color ) )
`;

/**
 * The single read behind a comparison: the requested ids, from the caller's
 * own papers, cancellable.
 *
 * Ownership is enforced twice, independently. RLS on `papers` returns only
 * `auth.uid() = user_id` rows, and the junction and attachment SELECT policies
 * return only records whose paper (and Project/Tag) the caller owns; the
 * explicit `.eq("user_id", …)` predicate is the S2 defense-in-depth on top, so
 * a loosened policy could still not widen this read.
 *
 * `queryIds` holds at most `MAX_COMPARISON_PAPERS` primary keys, so the read
 * is bounded by construction. A missing id simply produces no row; the
 * response never says why.
 */
export function buildComparisonQuery(
  client: typeof supabase,
  request: Pick<ComparisonRequest, "ownerUserId" | "queryIds">,
  signal: AbortSignal,
) {
  return client
    .from("papers")
    .select(COMPARISON_PAPER_SELECT)
    .in("id", request.queryIds)
    .eq("user_id", request.ownerUserId)
    .abortSignal(signal);
}

/**
 * The row type the generated `Database` schema infers for the projection. Its
 * job is to make `npm run typecheck` resolve every selected column and
 * relationship (see the type-level assertions in `query.test.ts`). At runtime
 * rows are still validated field by field: RLS can null an embedded record
 * the schema types as present.
 */
export type ComparisonPaperRow = QueryData<ReturnType<typeof buildComparisonQuery>>[number];
