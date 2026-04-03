-- Bulk update keywords for reevaluation.
-- Accepts a JSONB array of {id, keywords} objects.
-- Only updates papers belonging to the calling user.
-- The keywords column is jsonb in the live database, so we assign jsonb directly.
CREATE OR REPLACE FUNCTION public.bulk_update_keywords(
  updates jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE papers
  SET keywords = u.keywords,
      updated_at = now()
  FROM jsonb_to_recordset(updates) AS u(id uuid, keywords jsonb)
  WHERE papers.id = u.id
    AND papers.user_id = auth.uid();
END;
$$;
