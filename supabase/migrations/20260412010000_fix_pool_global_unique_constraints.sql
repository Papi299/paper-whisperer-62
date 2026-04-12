-- Fix cross-user uniqueness bug in all four pool/exclusion tables.
--
-- Bug: Global unique constraints (*_term_key) enforce uniqueness on
-- keyword/study_type across ALL users. If User A has "randomized controlled trial"
-- in their study type pool, User B cannot add it to their own pool.
--
-- Root cause: The remote DB has UNIQUE(keyword) / UNIQUE(study_type) constraints
-- named *_term_key, which are global. The correct per-user unique constraints
-- from the migration files (UNIQUE(user_id, keyword)) were either not applied
-- or were overridden by dashboard-created global constraints.
--
-- Fix: Drop the global *_term_key constraints and create per-user unique indexes.
-- Uses lower() for case-insensitive uniqueness (consistent with client-side checks).

-- ── 1. keyword_pool ──────────────────────────────────────────────────────

ALTER TABLE public.keyword_pool
  DROP CONSTRAINT IF EXISTS keyword_pool_term_key;

DROP INDEX IF EXISTS keyword_pool_term_key;

-- Also drop the inline UNIQUE(user_id, keyword) if it exists from the original migration
ALTER TABLE public.keyword_pool
  DROP CONSTRAINT IF EXISTS keyword_pool_user_id_keyword_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_pool_user_keyword
  ON public.keyword_pool (user_id, lower(keyword));

-- ── 2. keyword_exclusion_pool ────────────────────────────────────────────

ALTER TABLE public.keyword_exclusion_pool
  DROP CONSTRAINT IF EXISTS keyword_exclusion_pool_term_key;

DROP INDEX IF EXISTS keyword_exclusion_pool_term_key;

ALTER TABLE public.keyword_exclusion_pool
  DROP CONSTRAINT IF EXISTS keyword_exclusion_pool_user_id_keyword_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_exclusion_pool_user_keyword
  ON public.keyword_exclusion_pool (user_id, lower(keyword));

-- ── 3. study_type_pool ───────────────────────────────────────────────────

ALTER TABLE public.study_type_pool
  DROP CONSTRAINT IF EXISTS study_type_pool_term_key;

DROP INDEX IF EXISTS study_type_pool_term_key;

-- The original migration created this named index — drop and recreate for consistency
DROP INDEX IF EXISTS study_type_pool_user_study_type_idx;

CREATE UNIQUE INDEX IF NOT EXISTS idx_study_type_pool_user_study_type
  ON public.study_type_pool (user_id, lower(study_type));

-- ── 4. study_type_exclusion_pool ─────────────────────────────────────────

ALTER TABLE public.study_type_exclusion_pool
  DROP CONSTRAINT IF EXISTS study_type_exclusion_pool_term_key;

DROP INDEX IF EXISTS study_type_exclusion_pool_term_key;

ALTER TABLE public.study_type_exclusion_pool
  DROP CONSTRAINT IF EXISTS study_type_exclusion_pool_user_id_study_type_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_study_type_exclusion_pool_user_study_type
  ON public.study_type_exclusion_pool (user_id, lower(study_type));
