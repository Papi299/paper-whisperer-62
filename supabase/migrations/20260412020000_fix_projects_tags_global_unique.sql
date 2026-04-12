-- Fix cross-user uniqueness bug on projects.name and tags.name.
--
-- Bug: Global unique constraints (projects_name_key, tags_name_key) enforce
-- uniqueness on name across ALL users. If User A has a project named "My Review",
-- User B cannot create a project with the same name.
--
-- Same bug class as the pool/exclusion table fix (20260412010000) and the
-- papers pmid/doi fix (20260327000000).
--
-- Fix: Drop global constraints, create per-user case-insensitive unique indexes.

-- ── 1. projects ──────────────────────────────────────────────────────────

ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_name_key;

DROP INDEX IF EXISTS projects_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_name
  ON public.projects (user_id, lower(name));

-- ── 2. tags ──────────────────────────────────────────────────────────────

ALTER TABLE public.tags
  DROP CONSTRAINT IF EXISTS tags_name_key;

DROP INDEX IF EXISTS tags_name_key;

-- Also drop the intended per-user constraint from the original migration
-- in case it exists alongside the global one
ALTER TABLE public.tags
  DROP CONSTRAINT IF EXISTS tags_user_id_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_name
  ON public.tags (user_id, lower(name));
