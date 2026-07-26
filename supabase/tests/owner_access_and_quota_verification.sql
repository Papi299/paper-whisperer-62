-- Local isolated database verification for OWNER-MANAGER-ACCESS-AND-GEMINI-QUOTA-001.
--
-- Bounded, single-file, framework-free verification in the style used by prior
-- PFA work (no pgTAP). Runs entirely inside ONE transaction that ROLLBACKs at
-- the end, so it is isolated and repeatable (no residual rows). Any failed
-- ASSERT aborts the transaction; run with ON_ERROR_STOP=1 to surface it.
--
-- Run (local stack):
--   docker exec -i supabase_db_<ref> psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f supabase/tests/owner_access_and_quota_verification.sql
--   (or pipe the file on stdin)
--
-- Caller simulation: `SET LOCAL ROLE authenticated` + a request.jwt.claims GUC
-- whose "sub" is the user's UUID makes auth.uid() resolve to that user, exactly
-- as PostgREST does at runtime. SECURITY DEFINER RPCs still execute as their
-- owner internally; the S1 guard compares p_user_id against auth.uid().
--
-- Covers the 17 original cases + case 18 (grant hardening, added 001L):
--   1 user role · 2 owner role · 3 manager role · 4 no direct table read ·
--   5 no client insert/update · 6 anon cannot execute RPC · 7 null-auth reject ·
--   8 no arbitrary-user inspection · 9 Free 15 lifetime · 10 Pro monthly cap ·
--   11 exempt allowed beyond cap · 12 exempt usage increments ·
--   13 exempt refund decrements same bucket · 14 missing/inactive safe ·
--   15 is_exempt reported · 16 usage never negative · 17 no email-based role check ·
--   18 internal_user_access direct client table/column privileges revoked
--     (PUBLIC/anon/authenticated), service_role CRUD retained, RPC EXECUTE
--     boundary intact — verifies migration 20260726120000.

BEGIN;

-- ── Setup (as postgres) ────────────────────────────────────────────────
-- handle_new_user seeds a Free entitlement (lifetime 15 / monthly 0) + a
-- lifetime ai_analysis counter (used 0) for each inserted auth.users row.
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'owner@verify.local'),   -- owner, exempt, Pro
  ('a0000000-0000-0000-0000-000000000002', 'manager@verify.local'), -- manager, NOT exempt
  ('a0000000-0000-0000-0000-000000000003', 'free@verify.local'),    -- ordinary Free
  ('a0000000-0000-0000-0000-000000000004', 'pro@verify.local'),     -- ordinary Pro
  ('a0000000-0000-0000-0000-000000000005', 'inactive@verify.local'),-- canceled entitlement
  ('a0000000-0000-0000-0000-000000000006', 'missing@verify.local'); -- entitlement deleted

-- Internal roles. Owner is exempt; manager is explicitly NOT exempt.
INSERT INTO public.internal_user_access (user_id, role, ai_quota_exempt) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'owner', true),
  ('a0000000-0000-0000-0000-000000000002', 'manager', false);

-- Make the owner a Pro-baseline account (monthly bucket) so "beyond nominal
-- quota" is meaningful, and make user 4 an ordinary Pro.
UPDATE public.user_entitlements
   SET plan = 'pro', ai_monthly_quota = 350, ai_lifetime_quota = 0,
       premium_taxonomy_enabled = true
 WHERE user_id IN ('a0000000-0000-0000-0000-000000000001',
                   'a0000000-0000-0000-0000-000000000004');

-- Inactive + missing entitlement fixtures.
UPDATE public.user_entitlements SET plan_status = 'canceled'
 WHERE user_id = 'a0000000-0000-0000-0000-000000000005';
DELETE FROM public.user_entitlements
 WHERE user_id = 'a0000000-0000-0000-0000-000000000006';


-- ── Cases 1-3, 15: role resolution + is_exempt via get_current_user_access ──
SET LOCAL ROLE authenticated;

SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.get_current_user_access();
  ASSERT r.role = 'user', 'case1: ordinary user role should be user';
  ASSERT r.is_internal = false AND r.can_view_provider_quota = false, 'case1: user not internal';
  ASSERT r.ai_quota_exempt = false, 'case1: user not exempt';
END $$;

SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.get_current_user_access();
  ASSERT r.role = 'owner', 'case2: owner role';
  ASSERT r.is_internal AND r.can_view_provider_quota, 'case2: owner internal + can view provider quota';
  ASSERT r.ai_quota_exempt = true, 'case2: owner exempt';
  ASSERT r.plan = 'pro', 'case2: owner plan reflected';
END $$;

SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.get_current_user_access();
  ASSERT r.role = 'manager', 'case3: manager role';
  ASSERT r.is_internal AND r.can_view_provider_quota, 'case3: manager internal + can view provider quota';
  ASSERT r.ai_quota_exempt = false, 'case3: manager NOT auto-exempt';
END $$;


-- ── Case 4: ordinary user cannot read internal_user_access directly ──────
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
DO $$
DECLARE v_cnt INTEGER;
BEGIN
  BEGIN
    EXECUTE 'SELECT count(*) FROM public.internal_user_access' INTO v_cnt;
    -- If the read is permitted at all, FORCE RLS + no policy must yield 0 rows.
    ASSERT v_cnt = 0, 'case4: ordinary user must not see internal rows';
  EXCEPTION WHEN insufficient_privilege THEN
    -- Even stronger: no table privilege at all. Acceptable.
    NULL;
  END;
END $$;


-- ── Case 5: ordinary user cannot insert or update internal roles ────────
DO $$
DECLARE v_blocked BOOLEAN := false; v_role_after TEXT;
BEGIN
  -- INSERT attempt as authenticated must be blocked (privilege or RLS).
  BEGIN
    EXECUTE $q$INSERT INTO public.internal_user_access(user_id, role)
              VALUES ('a0000000-0000-0000-0000-000000000003','owner')$q$;
  EXCEPTION WHEN insufficient_privilege OR sqlstate '42501' THEN v_blocked := true;
            WHEN others THEN v_blocked := true; -- RLS row violation etc.
  END;
  ASSERT v_blocked, 'case5: ordinary user INSERT into internal_user_access must be blocked';

  -- UPDATE attempt must not change the owner row (privilege error OR 0 rows).
  BEGIN
    EXECUTE $q$UPDATE public.internal_user_access SET role='owner'
              WHERE user_id='a0000000-0000-0000-0000-000000000002'$q$;
  EXCEPTION WHEN insufficient_privilege OR sqlstate '42501' THEN NULL;
            WHEN others THEN NULL;
  END;
END $$;
-- Confirm (as postgres) the manager row was NOT escalated.
RESET ROLE;
DO $$
DECLARE v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM public.internal_user_access
   WHERE user_id='a0000000-0000-0000-0000-000000000002';
  ASSERT v_role = 'manager', 'case5: manager role must remain unchanged after client UPDATE attempt';
END $$;


-- ── Case 6: anon cannot execute the access RPC ──────────────────────────
SET LOCAL ROLE anon;
DO $$
DECLARE v_blocked BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM * FROM public.get_current_user_access();
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
            WHEN others THEN v_blocked := true;
  END;
  ASSERT v_blocked, 'case6: anon must not execute get_current_user_access';
END $$;
RESET ROLE;


-- ── Case 7: null-auth caller is rejected ────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE v_rejected BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM * FROM public.get_current_user_access();
  EXCEPTION WHEN sqlstate 'P0001' THEN
    v_rejected := (SQLERRM LIKE '%no authenticated user%');
  END;
  ASSERT v_rejected, 'case7: null-auth caller must be rejected';
END $$;


-- ── Case 8: current-access RPC cannot inspect another user ──────────────
-- Structural: get_current_user_access() takes NO argument and derives identity
-- from auth.uid() only, so there is no way to point it at another user. Cases
-- 1-3 already prove it returns exactly the CALLER's row. Assert the argument
-- surface is empty (0 parameters) as a durable guard against a future param.
RESET ROLE;
DO $$
DECLARE v_nargs INTEGER;
BEGIN
  SELECT pronargs INTO v_nargs FROM pg_proc
   WHERE proname = 'get_current_user_access' AND pronamespace = 'public'::regnamespace;
  ASSERT v_nargs = 0, 'case8: get_current_user_access must take no user-id argument';
END $$;


-- ── Case 9: ordinary Free quota remains 15 lifetime ─────────────────────
-- Preload the Free user's lifetime counter to 14, then two consumes: the 15th
-- is allowed (remaining 0), the 16th is quota_exceeded. Proves the 15 cap.
UPDATE public.usage_counters SET used = 14
 WHERE user_id='a0000000-0000-0000-0000-000000000003'
   AND feature='ai_analysis' AND period_type='lifetime';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.consume_ai_quota('a0000000-0000-0000-0000-000000000003');
  ASSERT r.allowed AND r.reason='ok', 'case9: 15th Free analysis allowed';
  ASSERT r.period_type='lifetime' AND r.quota=15 AND r.used=15 AND r.remaining=0, 'case9: Free lifetime 15 accounting';
  SELECT * INTO r FROM public.consume_ai_quota('a0000000-0000-0000-0000-000000000003');
  ASSERT r.allowed=false AND r.reason='quota_exceeded', 'case9: 16th Free analysis blocked at 15';
END $$;


-- ── Case 10: ordinary Pro quota remains monthly and capped ──────────────
RESET ROLE;
INSERT INTO public.usage_counters (user_id, feature, period_type, period_start, period_end, used)
VALUES ('a0000000-0000-0000-0000-000000000004','ai_analysis','monthly',
        date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC',
        (date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC') + INTERVAL '1 month',
        349)
ON CONFLICT (user_id, feature, period_type, period_start) DO UPDATE SET used = 349;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.consume_ai_quota('a0000000-0000-0000-0000-000000000004');
  ASSERT r.allowed AND r.period_type='monthly' AND r.quota=350 AND r.used=350 AND r.remaining=0, 'case10: Pro 350th monthly allowed';
  SELECT * INTO r FROM public.consume_ai_quota('a0000000-0000-0000-0000-000000000004');
  ASSERT r.allowed=false AND r.reason='quota_exceeded', 'case10: Pro 351st monthly blocked';
END $$;


-- ── Cases 11-13, 16: exempt owner (Pro) beyond cap; increment; refund; floor ──
RESET ROLE;
-- Put the owner's monthly counter AT the nominal cap (350).
INSERT INTO public.usage_counters (user_id, feature, period_type, period_start, period_end, used)
VALUES ('a0000000-0000-0000-0000-000000000001','ai_analysis','monthly',
        date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC',
        (date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC') + INTERVAL '1 month',
        350)
ON CONFLICT (user_id, feature, period_type, period_start) DO UPDATE SET used = 350;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
DO $$
DECLARE r RECORD;
BEGIN
  -- Case 11 + 12: allowed beyond the cap AND usage still increments (350 -> 351).
  SELECT * INTO r FROM public.consume_ai_quota('a0000000-0000-0000-0000-000000000001');
  ASSERT r.allowed=true AND r.reason='quota_exempt', 'case11: exempt owner allowed beyond nominal quota';
  ASSERT r.period_type='monthly' AND r.used=351, 'case12: exempt owner usage increments past the cap';

  -- Case 13: refund decrements the SAME (monthly) bucket (351 -> 350).
  SELECT * INTO r FROM public.refund_ai_quota('a0000000-0000-0000-0000-000000000001');
  ASSERT r.refunded=true AND r.period_type='monthly' AND r.used=350, 'case13: exempt refund decrements same bucket';
END $$;

-- Case 16: refund never yields a negative counter (floor at 0).
RESET ROLE;
UPDATE public.usage_counters SET used = 0
 WHERE user_id='a0000000-0000-0000-0000-000000000001'
   AND feature='ai_analysis' AND period_type='monthly';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.refund_ai_quota('a0000000-0000-0000-0000-000000000001');
  ASSERT r.used >= 0, 'case16: refund must not produce negative usage';
END $$;
RESET ROLE;
DO $$
DECLARE v_used INTEGER;
BEGIN
  SELECT used INTO v_used FROM public.usage_counters
   WHERE user_id='a0000000-0000-0000-0000-000000000001'
     AND feature='ai_analysis' AND period_type='monthly';
  ASSERT v_used = 0, 'case16: monthly counter floored at 0, not negative';
END $$;


-- ── Case 14: missing / inactive entitlement behavior remains safe ───────
SET LOCAL ROLE authenticated;
-- inactive
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.consume_ai_quota('a0000000-0000-0000-0000-000000000005');
  ASSERT r.allowed=false AND r.reason='inactive_entitlement', 'case14: inactive entitlement blocks consume';
  SELECT * INTO r FROM public.get_ai_quota_status('a0000000-0000-0000-0000-000000000005');
  ASSERT r.allowed=false AND r.reason='inactive_entitlement' AND r.is_exempt=false, 'case14: inactive status read';
END $$;
-- missing
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.consume_ai_quota('a0000000-0000-0000-0000-000000000006');
  ASSERT r.allowed=false AND r.reason='missing_entitlement', 'case14: missing entitlement blocks consume';
  SELECT * INTO r FROM public.get_ai_quota_status('a0000000-0000-0000-0000-000000000006');
  ASSERT r.allowed=false AND r.reason='missing_entitlement', 'case14: missing entitlement status read';
END $$;


-- ── Case 15: quota-status RPC reports is_exempt (owner true, user false) ──
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.get_ai_quota_status('a0000000-0000-0000-0000-000000000001');
  ASSERT r.is_exempt = true, 'case15: exempt owner is_exempt=true';
  ASSERT r.allowed = true AND r.reason='quota_exempt', 'case15: exempt owner allowed via status';
END $$;
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.get_ai_quota_status('a0000000-0000-0000-0000-000000000003');
  ASSERT r.is_exempt = false, 'case15: ordinary user is_exempt=false';
END $$;


-- ── Case 17: no role check depends on email ─────────────────────────────
RESET ROLE;
DO $$
DECLARE v_email_cols INTEGER;
BEGIN
  SELECT count(*) INTO v_email_cols FROM information_schema.columns
   WHERE table_schema='public' AND table_name='internal_user_access' AND column_name ILIKE '%email%';
  ASSERT v_email_cols = 0, 'case17: internal_user_access must have no email column (role is UUID-based)';
END $$;


-- ── Case 18 (001L): internal_user_access direct client grants revoked ────
-- Defense in depth on top of FORCE RLS + no policy: the object-permission
-- layer must itself deny PUBLIC/anon/authenticated direct table access, while
-- service_role keeps CRUD and authenticated keeps ONLY the RPC EXECUTE path.
RESET ROLE;
DO $$
DECLARE
  v_rls BOOLEAN; v_force BOOLEAN; v_policies INTEGER;
  v_role TEXT; v_priv TEXT; v_colpriv INTEGER;
BEGIN
  -- Table posture: exists + RLS enabled + FORCE RLS + zero policies.
  SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_rls, v_force
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='internal_user_access';
  ASSERT v_rls IS TRUE, 'case18: RLS must be enabled on internal_user_access';
  ASSERT v_force IS TRUE, 'case18: FORCE RLS must be enabled on internal_user_access';
  SELECT count(*) INTO v_policies FROM pg_policies
   WHERE schemaname='public' AND tablename='internal_user_access';
  ASSERT v_policies = 0, 'case18: internal_user_access must have zero RLS policies';

  -- No direct table privileges for anon or authenticated (every privilege type).
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      ASSERT has_table_privilege(v_role, 'public.internal_user_access', v_priv) = false,
        format('case18: %s must NOT have %s on internal_user_access', v_role, v_priv);
    END LOOP;
    -- No column-level privileges either.
    SELECT count(*) INTO v_colpriv FROM information_schema.column_privileges
     WHERE table_schema='public' AND table_name='internal_user_access' AND grantee = v_role;
    ASSERT v_colpriv = 0, format('case18: %s must have no column privileges on internal_user_access', v_role);
  END LOOP;

  -- Explicit server path: service_role retains CRUD.
  FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    ASSERT has_table_privilege('service_role', 'public.internal_user_access', v_priv) = true,
      format('case18: service_role must retain %s on internal_user_access', v_priv);
  END LOOP;

  -- RPC boundary preserved: authenticated keeps EXECUTE; anon and PUBLIC do not.
  ASSERT has_function_privilege('authenticated', 'public.get_current_user_access()', 'EXECUTE') = true,
    'case18: authenticated must retain EXECUTE on get_current_user_access()';
  ASSERT has_function_privilege('anon', 'public.get_current_user_access()', 'EXECUTE') = false,
    'case18: anon must NOT execute get_current_user_access()';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.proname='get_current_user_access' AND p.pronamespace='public'::regnamespace
       AND a.grantee = 0 /* PUBLIC */ AND a.privilege_type='EXECUTE'
  ), 'case18: PUBLIC must NOT have EXECUTE on get_current_user_access()';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL 18 VERIFICATION CASES PASSED'; END $$;

ROLLBACK;
