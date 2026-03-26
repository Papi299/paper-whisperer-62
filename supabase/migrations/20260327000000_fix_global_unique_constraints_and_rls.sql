-- Fix two cross-user isolation bugs:
--
-- Bug A: Global unique constraints papers_pmid_key and papers_doi_key
--   enforce uniqueness on pmid/doi across ALL users, blocking user B
--   from importing a paper that user A already has.
--   The correct per-user partial indexes (idx_papers_user_pmid_unique,
--   idx_papers_user_doi_unique) already exist — drop the global ones.
--
-- Bug B: RLS on the papers table is not being enforced.
--   Re-enable and FORCE RLS so it applies even to table-owner roles.

-- ── Bug A: Drop global unique constraints ──────────────────────────────

-- Drop only if they exist (idempotent).
ALTER TABLE public.papers DROP CONSTRAINT IF EXISTS papers_pmid_key;
ALTER TABLE public.papers DROP CONSTRAINT IF EXISTS papers_doi_key;

-- Also drop any plain unique INDEX variants (in case they were created
-- as indexes rather than table constraints).
DROP INDEX IF EXISTS papers_pmid_key;
DROP INDEX IF EXISTS papers_doi_key;

-- ── Bug B: Re-enable and force RLS ─────────────────────────────────────

ALTER TABLE public.papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.papers FORCE ROW LEVEL SECURITY;

-- ── Verify: per-user partial indexes still exist (no-op, just safety) ──

CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_user_pmid_unique
  ON public.papers (user_id, pmid)
  WHERE pmid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_user_doi_unique
  ON public.papers (user_id, lower(doi))
  WHERE doi IS NOT NULL;
