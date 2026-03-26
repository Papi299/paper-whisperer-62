-- Temporary diagnostic: check RLS state and policies on papers table
CREATE OR REPLACE FUNCTION public.diagnose_rls()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rls_enabled boolean;
  v_rls_forced boolean;
  v_policies jsonb;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity
  INTO v_rls_enabled, v_rls_forced
  FROM pg_class
  WHERE relname = 'papers' AND relnamespace = 'public'::regnamespace;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', polname,
    'cmd', polcmd,
    'permissive', polpermissive,
    'roles', polroles::text,
    'qual', pg_get_expr(polqual, polrelid),
    'with_check', pg_get_expr(polwithcheck, polrelid)
  )), '[]'::jsonb)
  INTO v_policies
  FROM pg_policy
  WHERE polrelid = 'public.papers'::regclass;

  RETURN jsonb_build_object(
    'rls_enabled', v_rls_enabled,
    'rls_forced', v_rls_forced,
    'policy_count', jsonb_array_length(v_policies),
    'policies', v_policies
  );
END;
$$;
