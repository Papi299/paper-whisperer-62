-- Fix FK constraints on papers, projects, tags: replace NO ACTION with ON DELETE CASCADE.
--
-- Root cause: Original migrations (20260203072053) defined these tables with
-- `user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`, but the
-- remote DB has drifted to NO ACTION — likely overwritten by the Supabase
-- dashboard when managing constraints.
--
-- Pre-migration audit confirmed:
--   - 0 orphan rows across all 3 tables
--   - papers: 689 rows, 2 distinct user_ids
--   - projects: 34 rows, 2 distinct user_ids
--   - tags: 82 rows, 2 distinct user_ids
--   - All user_ids map to existing auth.users
--
-- Scope: Only papers, projects, tags. Pool tables already fixed in prior migration.

-- Clean up temp inspection function from prior audit
DROP FUNCTION IF EXISTS public.tmp_verify_fk();

-- papers
ALTER TABLE public.papers
  DROP CONSTRAINT IF EXISTS papers_user_id_fkey;
ALTER TABLE public.papers
  ADD CONSTRAINT papers_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- projects
ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_user_id_fkey;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- tags
ALTER TABLE public.tags
  DROP CONSTRAINT IF EXISTS tags_user_id_fkey;
ALTER TABLE public.tags
  ADD CONSTRAINT tags_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
