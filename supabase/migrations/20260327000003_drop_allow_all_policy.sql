-- Drop the rogue "Allow all access" policy on papers table.
-- This policy was created via the Supabase Dashboard and permits ALL
-- operations with qual = "true" (no user filtering), completely
-- bypassing row-level security.

DROP POLICY IF EXISTS "Allow all access" ON public.papers;

-- Also drop the diagnostic function — no longer needed.
DROP FUNCTION IF EXISTS public.diagnose_rls();
