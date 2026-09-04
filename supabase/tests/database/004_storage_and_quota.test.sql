-- PFA-C03B1 comprehensive database-security suite 004: storage + AI quota.
--
-- Proves the storage-accounting and AI-quota invariants exactly:
--   * storage: exact increment on insert, exact increment on a second insert,
--     exact decrement on delete, refund floored at zero, over-cap rejection that
--     creates no row and does not move usage, negative-size rejection, missing-
--     entitlement rejection, inactive-entitlement contract, cross-owner rejection
--     before any accounting mutation, no direct client rewrite, no anon access;
--   * AI quota (sequential): below-cap consume increments once, at-cap consume is
--     rejected, usage never exceeds the cap, refund decrements the right bucket,
--     refund at zero stays zero, missing/inactive entitlements fail safe, and the
--     exempt-owner path stays allowed and increments (consistent with the
--     preserved 18-case legacy verification, which remains authoritative for the
--     full owner/manager matrix — not duplicated here).
--
-- True concurrent consumption near the cap is proven separately by the runner's
-- external barrier probe (pgTAP transactions cannot express real concurrency).
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the transaction
-- and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.errcode_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := '00000';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state;
END;
$hlp$;

-- Consume AI quota as the given authenticated user; return 'allowed|reason|used'.
CREATE FUNCTION pg_temp.consume_as(p_claims text, p_user uuid)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', p_claims, true);
  SET LOCAL ROLE authenticated;
  SELECT allowed::text || '|' || reason || '|' || used::text INTO v
  FROM public.consume_ai_quota(p_user);
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END;
$hlp$;

-- Refund AI quota as the given authenticated user; return the resulting used.
CREATE FUNCTION pg_temp.refund_used_as(p_claims text, p_user uuid)
RETURNS integer LANGUAGE plpgsql AS $hlp$
DECLARE v integer;
BEGIN
  PERFORM set_config('request.jwt.claims', p_claims, true);
  SET LOCAL ROLE authenticated;
  SELECT used INTO v FROM public.refund_ai_quota(p_user);
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END;
$hlp$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('c5000000-0000-0000-0000-000000000001','store@paperlume.test'),  -- S: small storage quota
  ('c5000000-0000-0000-0000-000000000002','missing@paperlume.test'),-- M: entitlement deleted
  ('c5000000-0000-0000-0000-000000000003','inactive@paperlume.test'),-- I: canceled entitlement
  ('c5000000-0000-0000-0000-00000000000f','free@paperlume.test'),   -- F: Free lifetime 15
  ('c5000000-0000-0000-0000-0000000000e0','owner@paperlume.test');  -- O: exempt owner (Pro)

UPDATE public.user_entitlements SET storage_quota_bytes = 1000
 WHERE user_id = 'c5000000-0000-0000-0000-000000000001';
DELETE FROM public.user_entitlements
 WHERE user_id = 'c5000000-0000-0000-0000-000000000002';
UPDATE public.user_entitlements SET plan_status = 'canceled'
 WHERE user_id = 'c5000000-0000-0000-0000-000000000003';
INSERT INTO public.internal_user_access (user_id, role, ai_quota_exempt) VALUES
  ('c5000000-0000-0000-0000-0000000000e0','owner',true);
UPDATE public.user_entitlements
   SET plan='pro', ai_monthly_quota=350, ai_lifetime_quota=0
 WHERE user_id = 'c5000000-0000-0000-0000-0000000000e0';

INSERT INTO public.papers (id, user_id, title, insert_order) VALUES
  ('d0000000-0000-0000-0000-0000000000c1','c5000000-0000-0000-0000-000000000001','Paper S',1),
  ('d0000000-0000-0000-0000-0000000000c3','c5000000-0000-0000-0000-000000000003','Paper I',2),
  ('d0000000-0000-0000-0000-0000000000c2','c5000000-0000-0000-0000-000000000002','Paper M',3);

SELECT plan(28);

-- ══ Storage accounting (user S, quota 1000, paper S) ═════════════════════════
--
-- The insert cases below run as `postgres`, not as `authenticated`. Migration
-- 20260904120000 revoked INSERT/UPDATE/DELETE on paper_attachments from every
-- browser role, so a direct client insert is now refused at the ACL before the
-- quota trigger is ever reached — every case here would report 42501 and stop
-- measuring accounting at all. The writer that remains is the table owner, which
-- is the role the SECURITY DEFINER lifecycle RPCs execute as, so it is exactly
-- who the quota and ownership triggers now guard. Claims unchanged; writer only.
-- The ACL boundary itself is asserted at the end of this section, beside the
-- equivalent assertions for user_storage_usage.
-- 1. valid insert increments usage by exactly file_size.
SELECT is(pg_temp.errcode_as('postgres','{"sub":"c5000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(id,paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('e0000000-0000-0000-0000-000000000a01','d0000000-0000-0000-0000-0000000000c1','c5000000-0000-0000-0000-000000000001','s/a1.pdf','a1.pdf','application/pdf',400)$q$),
  '00000', 'storage: first valid attachment insert succeeds');
SELECT is((SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='c5000000-0000-0000-0000-000000000001'),
  '400', 'storage: usage incremented by exactly the first file size (400)');
-- 2. second valid insert increments by the additional exact size.
SELECT is(pg_temp.errcode_as('postgres','{"sub":"c5000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(id,paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('e0000000-0000-0000-0000-000000000a02','d0000000-0000-0000-0000-0000000000c1','c5000000-0000-0000-0000-000000000001','s/a2.pdf','a2.pdf','application/pdf',300)$q$),
  '00000', 'storage: second valid attachment insert succeeds');
SELECT is((SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='c5000000-0000-0000-0000-000000000001'),
  '700', 'storage: usage incremented by exactly the second file size (700 total)');
-- 3. deletion decrements by the exact file size.
DELETE FROM public.paper_attachments WHERE id='e0000000-0000-0000-0000-000000000a01';
SELECT is((SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='c5000000-0000-0000-0000-000000000001'),
  '300', 'storage: deletion decrements usage by exactly the file size (300)');
-- 5-7. over-cap insertion rejected, creates no row, leaves usage unchanged.
SELECT is(pg_temp.errcode_as('postgres','{"sub":"c5000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(id,paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('e0000000-0000-0000-0000-000000000a03','d0000000-0000-0000-0000-0000000000c1','c5000000-0000-0000-0000-000000000001','s/big.pdf','big.pdf','application/pdf',800)$q$),
  'P0001', 'storage: over-cap insertion rejected (300+800 > 1000)');
SELECT is((SELECT count(*)::int FROM public.paper_attachments WHERE user_id='c5000000-0000-0000-0000-000000000001'),
  1, 'storage: over-cap rejection created no attachment row');
SELECT is((SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='c5000000-0000-0000-0000-000000000001'),
  '300', 'storage: over-cap rejection left usage unchanged');
-- 8. negative file size rejected.
SELECT is(pg_temp.errcode_as('postgres','{"sub":"c5000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(id,paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('e0000000-0000-0000-0000-000000000a04','d0000000-0000-0000-0000-0000000000c1','c5000000-0000-0000-0000-000000000001','s/neg.pdf','neg.pdf','application/pdf',-5)$q$),
  'P0001', 'storage: negative file size rejected');
-- 4. defensive refund never yields a negative total (floor at 0).
UPDATE public.user_storage_usage SET used_bytes = 100 WHERE user_id='c5000000-0000-0000-0000-000000000001';
DELETE FROM public.paper_attachments WHERE id='e0000000-0000-0000-0000-000000000a02'; -- size 300 > 100
SELECT is((SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='c5000000-0000-0000-0000-000000000001'),
  '0', 'storage: refund is floored at 0, never negative');
-- 9. missing entitlement rejected safely (user M, paper M).
SELECT is(pg_temp.errcode_as('postgres','{"sub":"c5000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('d0000000-0000-0000-0000-0000000000c2','c5000000-0000-0000-0000-000000000002','m/a.pdf','a.pdf','application/pdf',100)$q$),
  'P0001', 'storage: missing entitlement rejected safely');
-- 10. inactive entitlement: storage is gated on storage_quota_bytes, not plan_status
--     (the current contract), so an active quota row still permits the upload.
SELECT is(pg_temp.errcode_as('postgres','{"sub":"c5000000-0000-0000-0000-000000000003","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('d0000000-0000-0000-0000-0000000000c3','c5000000-0000-0000-0000-000000000003','i/a.pdf','a.pdf','application/pdf',100)$q$),
  '00000', 'storage: inactive entitlement still permits upload (quota is not plan_status-gated)');
SELECT is((SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='c5000000-0000-0000-0000-000000000003'),
  '100', 'storage: inactive-user upload incremented its own usage by exactly the file size');
-- 11. cross-owner attachment rejected BEFORE any accounting mutation.
SELECT is(pg_temp.errcode_as('postgres','{"sub":"c5000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('d0000000-0000-0000-0000-0000000000c3','c5000000-0000-0000-0000-000000000001','s/x.pdf','x.pdf','application/pdf',50)$q$),
  'P0001', 'storage: cross-owner attachment (foreign paper) rejected');
SELECT is((SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='c5000000-0000-0000-0000-000000000001'),
  '0', 'storage: cross-owner rejection did not mutate accounting (still 0)');
-- 12-13. ordinary users cannot rewrite accounting; anon has no access.
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"c5000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$UPDATE public.user_storage_usage SET used_bytes = 0 WHERE user_id='c5000000-0000-0000-0000-000000000001'$q$),
  '42501', 'storage: ordinary user cannot directly rewrite user_storage_usage (ACL)');
SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT count(*) FROM public.user_storage_usage$q$),
  '42501', 'storage: anon has no direct access to storage accounting (ACL)');
-- 14-16. …and since 20260904120000, ordinary users cannot write the attachment
-- metadata that DRIVES that accounting either. Every write privilege on
-- paper_attachments is gone from the browser roles, so quota can only move
-- through the lifecycle RPCs and the triggers above. SELECT is untouched — the
-- UI still lists its own attachments.
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"c5000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('d0000000-0000-0000-0000-0000000000c1','c5000000-0000-0000-0000-000000000001','s/direct.pdf','direct.pdf','application/pdf',1)$q$),
  '42501', 'storage: ordinary user cannot directly INSERT attachment metadata (ACL)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"c5000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.paper_attachments WHERE user_id='c5000000-0000-0000-0000-000000000001'$q$),
  '42501', 'storage: ordinary user cannot directly DELETE attachment metadata (ACL)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"c5000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*) FROM public.paper_attachments$q$),
  '00000', 'storage: …but SELECT is preserved — the attachment list still reads');

-- ══ AI quota sequential semantics ════════════════════════════════════════════
-- Free user F: lifetime cap 15, preloaded to 14.
UPDATE public.usage_counters SET used = 14
 WHERE user_id='c5000000-0000-0000-0000-00000000000f'
   AND feature='ai_analysis' AND period_type='lifetime';
SELECT is(pg_temp.consume_as('{"sub":"c5000000-0000-0000-0000-00000000000f","role":"authenticated"}','c5000000-0000-0000-0000-00000000000f'),
  'true|ok|15', 'ai quota: below-cap consume allowed and increments once (14 -> 15)');
SELECT is(pg_temp.consume_as('{"sub":"c5000000-0000-0000-0000-00000000000f","role":"authenticated"}','c5000000-0000-0000-0000-00000000000f'),
  'false|quota_exceeded|15', 'ai quota: at-cap consume rejected');
SELECT is((SELECT used::text FROM public.usage_counters
   WHERE user_id='c5000000-0000-0000-0000-00000000000f' AND feature='ai_analysis' AND period_type='lifetime'),
  '15', 'ai quota: usage never exceeds the cap');
SELECT is(pg_temp.refund_used_as('{"sub":"c5000000-0000-0000-0000-00000000000f","role":"authenticated"}','c5000000-0000-0000-0000-00000000000f'),
  14, 'ai quota: refund decrements the correct bucket (15 -> 14)');
-- refund at zero remains zero.
UPDATE public.usage_counters SET used = 0
 WHERE user_id='c5000000-0000-0000-0000-00000000000f'
   AND feature='ai_analysis' AND period_type='lifetime';
SELECT is(pg_temp.refund_used_as('{"sub":"c5000000-0000-0000-0000-00000000000f","role":"authenticated"}','c5000000-0000-0000-0000-00000000000f'),
  0, 'ai quota: refund at zero remains zero (floor)');
-- missing / inactive entitlements fail safe.
SELECT is(pg_temp.consume_as('{"sub":"c5000000-0000-0000-0000-000000000002","role":"authenticated"}','c5000000-0000-0000-0000-000000000002'),
  'false|missing_entitlement|0', 'ai quota: missing entitlement fails safe');
SELECT is(pg_temp.consume_as('{"sub":"c5000000-0000-0000-0000-000000000003","role":"authenticated"}','c5000000-0000-0000-0000-000000000003'),
  'false|inactive_entitlement|0', 'ai quota: inactive entitlement fails safe');
-- exempt owner: allowed beyond the nominal cap and usage still increments.
INSERT INTO public.usage_counters (user_id, feature, period_type, period_start, period_end, used)
VALUES ('c5000000-0000-0000-0000-0000000000e0','ai_analysis','monthly',
        date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC',
        (date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC') + INTERVAL '1 month', 350)
ON CONFLICT (user_id, feature, period_type, period_start) DO UPDATE SET used = 350;
SELECT is(pg_temp.consume_as('{"sub":"c5000000-0000-0000-0000-0000000000e0","role":"authenticated"}','c5000000-0000-0000-0000-0000000000e0'),
  'true|quota_exempt|351', 'ai quota: exempt owner allowed beyond cap and usage increments (350 -> 351)');

SELECT * FROM finish();
ROLLBACK;
