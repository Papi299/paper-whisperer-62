-- Fix FK constraints on 5 pool tables: replace NO ACTION with ON DELETE CASCADE.
--
-- Root cause: These tables were created with `user_id UUID NOT NULL` but
-- without REFERENCES auth.users(id). The Supabase dashboard later created
-- FK constraints automatically, but with NO ACTION instead of CASCADE.
--
-- Pre-migration audit confirmed:
--   - 0 orphan rows (all user_ids map to existing auth.users)
--   - 3 auth.users exist; 2 distinct user_ids appear in pool tables
--   - Existing FKs confirmed via information_schema query:
--       keyword_pool_user_id_fkey           → NO ACTION
--       keyword_exclusion_pool_user_id_fkey → NO ACTION
--       study_type_pool_user_id_fkey        → NO ACTION
--       study_type_exclusion_pool_user_id_fkey → NO ACTION
--       synonym_pool_user_id_fkey           → NO ACTION
--
-- Scope: Only the 5 pool tables. papers/projects/tags also have NO ACTION
-- but are out of scope for this task.

-- Drop temp inspection function if it exists from audit
DROP FUNCTION IF EXISTS public.tmp_check_fk_constraints();

-- keyword_pool
ALTER TABLE public.keyword_pool
  DROP CONSTRAINT IF EXISTS keyword_pool_user_id_fkey;
ALTER TABLE public.keyword_pool
  ADD CONSTRAINT keyword_pool_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- keyword_exclusion_pool
ALTER TABLE public.keyword_exclusion_pool
  DROP CONSTRAINT IF EXISTS keyword_exclusion_pool_user_id_fkey;
ALTER TABLE public.keyword_exclusion_pool
  ADD CONSTRAINT keyword_exclusion_pool_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- study_type_pool
ALTER TABLE public.study_type_pool
  DROP CONSTRAINT IF EXISTS study_type_pool_user_id_fkey;
ALTER TABLE public.study_type_pool
  ADD CONSTRAINT study_type_pool_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- study_type_exclusion_pool
ALTER TABLE public.study_type_exclusion_pool
  DROP CONSTRAINT IF EXISTS study_type_exclusion_pool_user_id_fkey;
ALTER TABLE public.study_type_exclusion_pool
  ADD CONSTRAINT study_type_exclusion_pool_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- synonym_pool
ALTER TABLE public.synonym_pool
  DROP CONSTRAINT IF EXISTS synonym_pool_user_id_fkey;
ALTER TABLE public.synonym_pool
  ADD CONSTRAINT synonym_pool_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
