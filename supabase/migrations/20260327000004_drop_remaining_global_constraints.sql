-- Enumerate and drop ALL global (non-per-user) unique constraints on papers.
--
-- Step 1: Create a temporary diagnostic function to list all constraints
-- Step 2: After inspecting, drop the known bad ones
-- Step 3: Clean up the diagnostic function

-- Temporary diagnostic function
CREATE OR REPLACE FUNCTION public.list_papers_constraints()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', c.conname,
      'type', c.contype,
      'definition', pg_get_constraintdef(c.oid)
    )), '[]'::jsonb)
    FROM pg_constraint c
    WHERE c.conrelid = 'public.papers'::regclass
  );
END;
$$;
