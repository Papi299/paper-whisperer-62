-- Clean up leftover temporary inspection function from FK cascade audit.
-- This function was used to verify FK delete rules via information_schema
-- and is not part of the application.

DROP FUNCTION IF EXISTS public.tmp_verify_fk2();
