-- Partial unique indexes to prevent duplicate papers per user at the DB level.
-- Only enforced when the column is non-null so papers without PMID/DOI are unaffected.

CREATE UNIQUE INDEX idx_papers_user_pmid_unique
  ON public.papers (user_id, pmid)
  WHERE pmid IS NOT NULL;

CREATE UNIQUE INDEX idx_papers_user_doi_unique
  ON public.papers (user_id, lower(doi))
  WHERE doi IS NOT NULL;
