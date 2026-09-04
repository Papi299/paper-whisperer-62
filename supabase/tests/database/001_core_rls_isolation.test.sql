-- PFA-C03B1 comprehensive database-security suite 001: core RLS isolation.
--
-- Proves per-user row isolation on the directly user-owned tables:
--   papers · projects · tags · filter_presets · user_entitlements · usage_counters
--
-- Principals: authenticated user A, authenticated user B, anon, and an
-- authenticated caller with missing JWT claims (auth.uid() IS NULL). For every
-- table a positive control (the intended own-row behavior) precedes the
-- isolation assertions. All RLS policies here are `auth.uid() = user_id`, so the
-- exact observable semantics are asserted precisely:
--   * cross-user SELECT / UPDATE / DELETE are *ineffective* (0 rows, SQLSTATE
--     00000) because the USING clause filters the row out — never an error;
--   * a forged-owner INSERT violates WITH CHECK → 42501;
--   * anon (no table privilege) is denied at the ACL → 42501.
--
-- internal_user_access non-escalation is proven authoritatively by the preserved
-- framework-free supabase/tests/owner_access_and_quota_verification.sql (cases
-- 4/5/17/18) and is referenced here rather than re-implemented or weakened.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the transaction
-- and rolled back with it, leaving the database's extension state unchanged.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Run p_sql as p_role with the given JWT claims; return the resulting SQLSTATE
-- ('00000' on success). Role/claims are restored before returning.
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

-- Run a single-scalar-returning p_sql as p_role; return the scalar as text.
CREATE FUNCTION pg_temp.scalar_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_result text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  EXECUTE p_sql INTO v_result;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_result;
END;
$hlp$;

-- Run a mutating p_sql as p_role and return the affected row count. Used only
-- for the ineffective (0-row) cross-user UPDATE/DELETE proofs and positive
-- own-row controls, where no exception is expected.
CREATE FUNCTION pg_temp.rowcount_as(p_role text, p_claims text, p_sql text)
RETURNS integer LANGUAGE plpgsql AS $hlp$
DECLARE v_rows integer;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  EXECUTE p_sql;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_rows;
END;
$hlp$;

-- ── Fixtures (as superuser; RLS bypassed) ────────────────────────────────────
-- Inserting auth.users fires handle_new_user → seeds user_entitlements (Free,
-- 500MB, lifetime 15) + a lifetime ai_analysis usage_counters row per user.
INSERT INTO auth.users (id, email) VALUES
  ('aa000000-0000-0000-0000-000000000001','core-A@paperlume.test'),
  ('bb000000-0000-0000-0000-000000000002','core-B@paperlume.test');

INSERT INTO public.papers (id, user_id, title, notes, insert_order) VALUES
  ('a0000000-0000-0000-0000-0000000000a1','aa000000-0000-0000-0000-000000000001','Paper A','A private note',1),
  ('b0000000-0000-0000-0000-0000000000b1','bb000000-0000-0000-0000-000000000002','Paper B','B private note',2);
INSERT INTO public.projects (id, user_id, name) VALUES
  ('a0000000-0000-0000-0000-0000000000a2','aa000000-0000-0000-0000-000000000001','Project A'),
  ('b0000000-0000-0000-0000-0000000000b2','bb000000-0000-0000-0000-000000000002','Project B');
INSERT INTO public.tags (id, user_id, name) VALUES
  ('a0000000-0000-0000-0000-0000000000a3','aa000000-0000-0000-0000-000000000001','Tag A'),
  ('b0000000-0000-0000-0000-0000000000b3','bb000000-0000-0000-0000-000000000002','Tag B');
INSERT INTO public.filter_presets (id, user_id, name, payload) VALUES
  ('a0000000-0000-0000-0000-0000000000a4','aa000000-0000-0000-0000-000000000001','Preset A','{"q":"a"}'::jsonb),
  ('b0000000-0000-0000-0000-0000000000b4','bb000000-0000-0000-0000-000000000002','Preset B','{"q":"b"}'::jsonb);

SELECT plan(43);

-- Claim strings.
--   A  = {"sub":"aa…01","role":"authenticated"}
--   B  = {"sub":"bb…02","role":"authenticated"}

-- ══ papers ═══════════════════════════════════════════════════════════════════
-- Positive controls.
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.papers WHERE id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '1', 'papers: A selects own paper');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$UPDATE public.papers SET title='Paper A (own edit)' WHERE id='a0000000-0000-0000-0000-0000000000a1'$q$),
  1, 'papers: A updates own paper (positive control, 1 row)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.papers WHERE id='a0000000-0000-0000-0000-0000000000a1' AND notes IS NOT NULL$q$),
  '1', 'papers: A sees own notes (positive control)');
-- Isolation.
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.papers WHERE id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '0', 'papers: B cannot select A''s paper');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.papers WHERE id='a0000000-0000-0000-0000-0000000000a1' AND notes IS NOT NULL$q$),
  '0', 'papers: A''s notes are not disclosed to B');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$UPDATE public.papers SET title='hijacked' WHERE id='a0000000-0000-0000-0000-0000000000a1'$q$),
  0, 'papers: B cannot update A''s title (0 rows)');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$UPDATE public.papers SET notes='leaked' WHERE id='a0000000-0000-0000-0000-0000000000a1'$q$),
  0, 'papers: B cannot update A''s notes (0 rows)');
SELECT is(
  (SELECT title FROM public.papers WHERE id='a0000000-0000-0000-0000-0000000000a1'),
  'Paper A (own edit)', 'papers: A''s title is unchanged by B''s attempts');
-- Since migration 20260904120000 no browser role holds DELETE on papers at all:
-- a paper deletion cascades its paper_attachments rows away, so it has to go
-- through delete_papers_with_attachment_cleanup, which records the Storage
-- cleanup intent in the same transaction. The row-level isolation this suite
-- exists to prove therefore moves to that RPC, and is asserted there rather than
-- being quietly lost to a grant that refuses everybody equally.
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.papers WHERE id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501', 'papers: B cannot delete A''s paper — no browser role holds DELETE');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.papers WHERE id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501', 'papers: nor can A on her own paper — deletion is the lifecycle RPC''s to perform');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT * FROM public.delete_papers_with_attachment_cleanup(
       ARRAY['a0000000-0000-0000-0000-0000000000a1']::uuid[])$q$),
  'P0001', 'papers: B cannot delete A''s paper through the lifecycle RPC either');
SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE id='a0000000-0000-0000-0000-0000000000a1'),
  1, 'papers: A''s paper still exists after B''s delete attempts');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$TRUNCATE public.papers$q$),
  '42501', 'papers: TRUNCATE is closed too — it would empty the table without firing a trigger or consulting RLS');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$INSERT INTO public.papers (user_id,title,insert_order) VALUES ('aa000000-0000-0000-0000-000000000001','forged',99)$q$),
  '42501', 'papers: B cannot insert a paper owned by A (WITH CHECK)');
SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT count(*) FROM public.papers$q$),
  '42501', 'papers: anon cannot access authenticated paper rows (ACL)');
SELECT is(pg_temp.scalar_as('authenticated','',
  $q$SELECT count(*)::text FROM public.papers$q$),
  '0', 'papers: authenticated caller with missing claims sees no rows');

-- ══ projects ═════════════════════════════════════════════════════════════════
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.projects WHERE id='a0000000-0000-0000-0000-0000000000a2'$q$),
  '1', 'projects: A selects own project (positive control)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.projects WHERE id='a0000000-0000-0000-0000-0000000000a2'$q$),
  '0', 'projects: B cannot select A''s project');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$UPDATE public.projects SET name='hijacked' WHERE id='a0000000-0000-0000-0000-0000000000a2'$q$),
  0, 'projects: B cannot update A''s project (0 rows)');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.projects WHERE id='a0000000-0000-0000-0000-0000000000a2'$q$),
  0, 'projects: B cannot delete A''s project (0 rows)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$INSERT INTO public.projects (user_id,name) VALUES ('aa000000-0000-0000-0000-000000000001','forged')$q$),
  '42501', 'projects: B cannot insert a project owned by A (WITH CHECK)');

-- ══ tags ═════════════════════════════════════════════════════════════════════
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.tags WHERE id='a0000000-0000-0000-0000-0000000000a3'$q$),
  '1', 'tags: A selects own tag (positive control)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.tags WHERE id='a0000000-0000-0000-0000-0000000000a3'$q$),
  '0', 'tags: B cannot select A''s tag');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$UPDATE public.tags SET name='hijacked' WHERE id='a0000000-0000-0000-0000-0000000000a3'$q$),
  0, 'tags: B cannot update A''s tag (0 rows)');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.tags WHERE id='a0000000-0000-0000-0000-0000000000a3'$q$),
  0, 'tags: B cannot delete A''s tag (0 rows)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$INSERT INTO public.tags (user_id,name) VALUES ('aa000000-0000-0000-0000-000000000001','forged')$q$),
  '42501', 'tags: B cannot insert a tag owned by A (WITH CHECK)');

-- ══ filter_presets ═══════════════════════════════════════════════════════════
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.filter_presets WHERE id='a0000000-0000-0000-0000-0000000000a4'$q$),
  '1', 'filter_presets: A selects own preset (positive control)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.filter_presets (user_id,name,payload) VALUES ('aa000000-0000-0000-0000-000000000001','A new',' {"q":"n"}'::jsonb)$q$),
  '00000', 'filter_presets: A creates own preset (positive control)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.filter_presets WHERE id='a0000000-0000-0000-0000-0000000000a4'$q$),
  '0', 'filter_presets: B cannot select A''s preset');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$UPDATE public.filter_presets SET name='hijacked' WHERE id='a0000000-0000-0000-0000-0000000000a4'$q$),
  0, 'filter_presets: B cannot update A''s preset (0 rows)');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.filter_presets WHERE id='a0000000-0000-0000-0000-0000000000a4'$q$),
  0, 'filter_presets: B cannot delete A''s preset (0 rows)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$INSERT INTO public.filter_presets (user_id,name,payload) VALUES ('aa000000-0000-0000-0000-000000000001','forged','{}'::jsonb)$q$),
  '42501', 'filter_presets: B cannot insert a preset owned by A (WITH CHECK)');

-- ══ user_entitlements (SELECT-own-only; no client writes) ════════════════════
-- authenticated holds SELECT only; there is no INSERT/UPDATE/DELETE privilege,
-- so both direct mutation AND forged-owner writes are denied at the ACL (42501).
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.user_entitlements WHERE user_id='aa000000-0000-0000-0000-000000000001'$q$),
  '1', 'user_entitlements: A sees own entitlement (positive control)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.user_entitlements WHERE user_id='aa000000-0000-0000-0000-000000000001'$q$),
  '0', 'user_entitlements: B cannot see A''s entitlement');
SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT count(*) FROM public.user_entitlements$q$),
  '42501', 'user_entitlements: anon has no direct access (ACL)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.user_entitlements (user_id,plan) VALUES ('aa000000-0000-0000-0000-000000000001','pro')$q$),
  '42501', 'user_entitlements: direct client INSERT prohibited (ACL)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$UPDATE public.user_entitlements SET plan='pro' WHERE user_id='aa000000-0000-0000-0000-000000000001'$q$),
  '42501', 'user_entitlements: direct client UPDATE prohibited (ACL)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.user_entitlements WHERE user_id='aa000000-0000-0000-0000-000000000001'$q$),
  '42501', 'user_entitlements: direct client DELETE prohibited (ACL)');

-- ══ usage_counters (server-only boundary) ════════════════════════════════════
-- authenticated has no SELECT/INSERT/UPDATE/DELETE privilege; anon has none.
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*) FROM public.usage_counters$q$),
  '42501', 'usage_counters: authenticated cannot SELECT (ACL)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.usage_counters (user_id,feature,period_type,period_start,used) VALUES ('aa000000-0000-0000-0000-000000000001','ai_analysis','lifetime','epoch',0)$q$),
  '42501', 'usage_counters: authenticated cannot INSERT (ACL)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$UPDATE public.usage_counters SET used=0$q$),
  '42501', 'usage_counters: authenticated cannot UPDATE (ACL)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.usage_counters$q$),
  '42501', 'usage_counters: authenticated cannot DELETE (ACL)');
SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT count(*) FROM public.usage_counters$q$),
  '42501', 'usage_counters: anon has no direct access (ACL)');

SELECT * FROM finish();
ROLLBACK;
