-- Diagnose and fix RLS on papers table.
-- Despite ENABLE + FORCE ROW LEVEL SECURITY, the papers table returns
-- all rows to any authenticated user. This indicates a permissive policy
-- exists that doesn't filter by user_id.
--
-- Strategy: drop ALL existing policies on papers and recreate only the
-- correct per-user ones. This is safe because the correct policies are
-- well-known from the initial migration.

-- Drop all known policies (from migrations)
DROP POLICY IF EXISTS "Users can view their own papers" ON public.papers;
DROP POLICY IF EXISTS "Users can create their own papers" ON public.papers;
DROP POLICY IF EXISTS "Users can update their own papers" ON public.papers;
DROP POLICY IF EXISTS "Users can delete their own papers" ON public.papers;

-- Drop any dashboard-created permissive policies (common names)
DROP POLICY IF EXISTS "Enable read access for all users" ON public.papers;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.papers;
DROP POLICY IF EXISTS "Enable update for users based on user_id" ON public.papers;
DROP POLICY IF EXISTS "Enable delete for users based on user_id" ON public.papers;
DROP POLICY IF EXISTS "Enable read access for authenticated users only" ON public.papers;
DROP POLICY IF EXISTS "allow_all" ON public.papers;
DROP POLICY IF EXISTS "public_read" ON public.papers;

-- Recreate correct per-user policies
CREATE POLICY "Users can view their own papers"
  ON public.papers FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own papers"
  ON public.papers FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own papers"
  ON public.papers FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own papers"
  ON public.papers FOR DELETE
  USING (auth.uid() = user_id);

-- Ensure RLS is enabled and forced
ALTER TABLE public.papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.papers FORCE ROW LEVEL SECURITY;
