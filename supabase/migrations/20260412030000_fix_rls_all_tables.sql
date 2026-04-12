-- Fix overly permissive RLS on 9 tables.
--
-- Bug: These tables have "Allow all access" policies (qual=true, with_check=true)
-- that let any authenticated user read/write any other user's data:
--   projects, tags, keyword_pool, keyword_exclusion_pool, study_type_pool,
--   study_type_exclusion_pool, synonym_pool, paper_projects, paper_tags
--
-- The intended per-user policies were defined in the original migrations but
-- the remote DB has dashboard-created "Allow all access" policies instead.
--
-- Fix: Drop all known policies (both migration-defined and dashboard-created),
-- then recreate the correct per-user policies from canonical definitions.
-- Enable + Force RLS on all affected tables.
--
-- Note: SECURITY DEFINER RPCs (set_paper_tags, set_paper_projects,
-- bulk_set_paper_tags, bulk_set_paper_projects, safe_bulk_insert_papers, etc.)
-- bypass RLS and are not affected by this change.

-- ════════════════════════════════════════════════════════════════════════
-- 1. projects
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow all access" ON public.projects;
DROP POLICY IF EXISTS "Users can view their own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can create their own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can update their own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can delete their own projects" ON public.projects;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.projects;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.projects;
DROP POLICY IF EXISTS "Enable update for users based on user_id" ON public.projects;
DROP POLICY IF EXISTS "Enable delete for users based on user_id" ON public.projects;

CREATE POLICY "Users can view their own projects"
  ON public.projects FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own projects"
  ON public.projects FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own projects"
  ON public.projects FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own projects"
  ON public.projects FOR DELETE
  USING (auth.uid() = user_id);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════════
-- 2. tags
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow all access" ON public.tags;
DROP POLICY IF EXISTS "Users can view their own tags" ON public.tags;
DROP POLICY IF EXISTS "Users can create their own tags" ON public.tags;
DROP POLICY IF EXISTS "Users can update their own tags" ON public.tags;
DROP POLICY IF EXISTS "Users can delete their own tags" ON public.tags;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.tags;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.tags;
DROP POLICY IF EXISTS "Enable update for users based on user_id" ON public.tags;
DROP POLICY IF EXISTS "Enable delete for users based on user_id" ON public.tags;

CREATE POLICY "Users can view their own tags"
  ON public.tags FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own tags"
  ON public.tags FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own tags"
  ON public.tags FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own tags"
  ON public.tags FOR DELETE
  USING (auth.uid() = user_id);

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags FORCE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════════
-- 3. keyword_pool
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow all access" ON public.keyword_pool;
DROP POLICY IF EXISTS "Users can view their own keywords" ON public.keyword_pool;
DROP POLICY IF EXISTS "Users can create their own keywords" ON public.keyword_pool;
DROP POLICY IF EXISTS "Users can delete their own keywords" ON public.keyword_pool;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.keyword_pool;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.keyword_pool;
DROP POLICY IF EXISTS "Enable delete for users based on user_id" ON public.keyword_pool;

CREATE POLICY "Users can view their own keywords"
  ON public.keyword_pool FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own keywords"
  ON public.keyword_pool FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own keywords"
  ON public.keyword_pool FOR DELETE
  USING (auth.uid() = user_id);

ALTER TABLE public.keyword_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_pool FORCE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════════
-- 4. keyword_exclusion_pool
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow all access" ON public.keyword_exclusion_pool;
DROP POLICY IF EXISTS "Users can view their own excluded keywords" ON public.keyword_exclusion_pool;
DROP POLICY IF EXISTS "Users can create their own excluded keywords" ON public.keyword_exclusion_pool;
DROP POLICY IF EXISTS "Users can delete their own excluded keywords" ON public.keyword_exclusion_pool;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.keyword_exclusion_pool;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.keyword_exclusion_pool;
DROP POLICY IF EXISTS "Enable delete for users based on user_id" ON public.keyword_exclusion_pool;

CREATE POLICY "Users can view their own excluded keywords"
  ON public.keyword_exclusion_pool FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own excluded keywords"
  ON public.keyword_exclusion_pool FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own excluded keywords"
  ON public.keyword_exclusion_pool FOR DELETE
  USING (auth.uid() = user_id);

ALTER TABLE public.keyword_exclusion_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_exclusion_pool FORCE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════════
-- 5. study_type_pool
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow all access" ON public.study_type_pool;
DROP POLICY IF EXISTS "Users can view own study type pool" ON public.study_type_pool;
DROP POLICY IF EXISTS "Users can insert own study type pool" ON public.study_type_pool;
DROP POLICY IF EXISTS "Users can update own study type pool" ON public.study_type_pool;
DROP POLICY IF EXISTS "Users can delete own study type pool" ON public.study_type_pool;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.study_type_pool;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.study_type_pool;
DROP POLICY IF EXISTS "Enable update for users based on user_id" ON public.study_type_pool;
DROP POLICY IF EXISTS "Enable delete for users based on user_id" ON public.study_type_pool;

CREATE POLICY "Users can view own study type pool"
  ON public.study_type_pool FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own study type pool"
  ON public.study_type_pool FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own study type pool"
  ON public.study_type_pool FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own study type pool"
  ON public.study_type_pool FOR DELETE
  USING (auth.uid() = user_id);

ALTER TABLE public.study_type_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_type_pool FORCE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════════
-- 6. study_type_exclusion_pool
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow all access" ON public.study_type_exclusion_pool;
DROP POLICY IF EXISTS "Users can view their own excluded study types" ON public.study_type_exclusion_pool;
DROP POLICY IF EXISTS "Users can create their own excluded study types" ON public.study_type_exclusion_pool;
DROP POLICY IF EXISTS "Users can delete their own excluded study types" ON public.study_type_exclusion_pool;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.study_type_exclusion_pool;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.study_type_exclusion_pool;
DROP POLICY IF EXISTS "Enable delete for users based on user_id" ON public.study_type_exclusion_pool;

CREATE POLICY "Users can view their own excluded study types"
  ON public.study_type_exclusion_pool FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own excluded study types"
  ON public.study_type_exclusion_pool FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own excluded study types"
  ON public.study_type_exclusion_pool FOR DELETE
  USING (auth.uid() = user_id);

ALTER TABLE public.study_type_exclusion_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_type_exclusion_pool FORCE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════════
-- 7. synonym_pool
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow all access" ON public.synonym_pool;
DROP POLICY IF EXISTS "Users can view their own synonym groups" ON public.synonym_pool;
DROP POLICY IF EXISTS "Users can create their own synonym groups" ON public.synonym_pool;
DROP POLICY IF EXISTS "Users can update their own synonym groups" ON public.synonym_pool;
DROP POLICY IF EXISTS "Users can delete their own synonym groups" ON public.synonym_pool;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.synonym_pool;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.synonym_pool;
DROP POLICY IF EXISTS "Enable update for users based on user_id" ON public.synonym_pool;
DROP POLICY IF EXISTS "Enable delete for users based on user_id" ON public.synonym_pool;

CREATE POLICY "Users can view their own synonym groups"
  ON public.synonym_pool FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own synonym groups"
  ON public.synonym_pool FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own synonym groups"
  ON public.synonym_pool FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own synonym groups"
  ON public.synonym_pool FOR DELETE
  USING (auth.uid() = user_id);

ALTER TABLE public.synonym_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.synonym_pool FORCE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════════
-- 8. paper_projects (junction — uses EXISTS on papers.user_id)
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow all access" ON public.paper_projects;
DROP POLICY IF EXISTS "Users can view their paper-project links" ON public.paper_projects;
DROP POLICY IF EXISTS "Users can add projects to their papers" ON public.paper_projects;
DROP POLICY IF EXISTS "Users can remove projects from their papers" ON public.paper_projects;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.paper_projects;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.paper_projects;
DROP POLICY IF EXISTS "Enable delete for users based on user_id" ON public.paper_projects;

CREATE POLICY "Users can view their paper-project links"
  ON public.paper_projects FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.papers
      WHERE papers.id = paper_projects.paper_id
      AND papers.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can add projects to their papers"
  ON public.paper_projects FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.papers
      WHERE papers.id = paper_projects.paper_id
      AND papers.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can remove projects from their papers"
  ON public.paper_projects FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.papers
      WHERE papers.id = paper_projects.paper_id
      AND papers.user_id = auth.uid()
    )
  );

ALTER TABLE public.paper_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_projects FORCE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════════
-- 9. paper_tags (junction — uses EXISTS on papers.user_id)
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow all access" ON public.paper_tags;
DROP POLICY IF EXISTS "Users can view tags on their papers" ON public.paper_tags;
DROP POLICY IF EXISTS "Users can add tags to their papers" ON public.paper_tags;
DROP POLICY IF EXISTS "Users can remove tags from their papers" ON public.paper_tags;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.paper_tags;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.paper_tags;
DROP POLICY IF EXISTS "Enable delete for users based on user_id" ON public.paper_tags;

CREATE POLICY "Users can view tags on their papers"
  ON public.paper_tags FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.papers
      WHERE papers.id = paper_tags.paper_id
      AND papers.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can add tags to their papers"
  ON public.paper_tags FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.papers
      WHERE papers.id = paper_tags.paper_id
      AND papers.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can remove tags from their papers"
  ON public.paper_tags FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.papers
      WHERE papers.id = paper_tags.paper_id
      AND papers.user_id = auth.uid()
    )
  );

ALTER TABLE public.paper_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_tags FORCE ROW LEVEL SECURITY;
