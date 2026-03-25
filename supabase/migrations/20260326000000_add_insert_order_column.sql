-- Add a BIGSERIAL column to preserve exact insertion order across bulk imports.
-- Within a bulk RPC call, all papers share the same created_at timestamp,
-- so created_at alone cannot preserve input order. insert_order auto-increments
-- on every INSERT, capturing the true sequence.

-- 1. Create the sequence
CREATE SEQUENCE IF NOT EXISTS public.papers_insert_order_seq;

-- 2. Add the column with a default from the sequence
ALTER TABLE public.papers
  ADD COLUMN insert_order bigint NOT NULL DEFAULT nextval('public.papers_insert_order_seq');

-- 3. Backfill existing rows: assign insert_order based on (created_at, id) so
--    existing papers get a deterministic order consistent with the old sort.
WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS rn
  FROM public.papers
)
UPDATE public.papers p
SET insert_order = n.rn
FROM numbered n
WHERE p.id = n.id;

-- 4. Advance the sequence past the backfilled values
SELECT setval('public.papers_insert_order_seq',
  COALESCE((SELECT MAX(insert_order) FROM public.papers), 0));

-- 5. Create an index for efficient ORDER BY insert_order DESC queries
CREATE INDEX idx_papers_insert_order ON public.papers (insert_order DESC);
