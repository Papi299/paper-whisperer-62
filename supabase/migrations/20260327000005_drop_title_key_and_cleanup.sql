-- Drop the global UNIQUE(title) constraint that blocks cross-user imports
-- when two users import papers with the same title.
ALTER TABLE public.papers DROP CONSTRAINT IF EXISTS papers_title_key;

-- Clean up diagnostic functions
DROP FUNCTION IF EXISTS public.list_papers_constraints();
DROP FUNCTION IF EXISTS public.diagnose_rls();
