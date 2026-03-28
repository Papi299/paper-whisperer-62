-- Performance indexing cleanup:
-- 1. Composite index for the hot pagination query:
--    SELECT ... FROM papers WHERE user_id = $1 ORDER BY insert_order DESC
--    Replaces separate lookups on idx_papers_user_id + idx_papers_insert_order
--    with a single index range scan.
-- 2. Reverse index on paper_projects(project_id) to match paper_tags symmetry
--    and support ON DELETE CASCADE from the projects table.

-- 1. Composite pagination index (supersedes standalone idx_papers_insert_order)
CREATE INDEX IF NOT EXISTS idx_papers_user_insert_order
  ON public.papers (user_id, insert_order DESC);

-- 2. Drop the now-redundant standalone insert_order index.
--    Every query using insert_order also filters by user_id;
--    the composite index above covers all such queries.
DROP INDEX IF EXISTS public.idx_papers_insert_order;

-- 3. Reverse index on paper_projects(project_id).
--    paper_tags already has idx_paper_tags_tag_id; this closes the gap
--    for paper_projects, supporting CASCADE deletes and project-based lookups.
CREATE INDEX IF NOT EXISTS idx_paper_projects_project_id
  ON public.paper_projects (project_id);
