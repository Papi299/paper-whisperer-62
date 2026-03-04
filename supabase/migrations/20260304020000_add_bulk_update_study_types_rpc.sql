-- RPC function to bulk-update study_type on papers in a single round-trip.
-- Accepts a JSON array of {id, study_type} objects.
CREATE OR REPLACE FUNCTION public.bulk_update_study_types(
  updates jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE papers
  SET study_type = u.study_type,
      updated_at = now()
  FROM jsonb_to_recordset(updates) AS u(id uuid, study_type text)
  WHERE papers.id = u.id
    AND papers.user_id = auth.uid();
END;
$$;
