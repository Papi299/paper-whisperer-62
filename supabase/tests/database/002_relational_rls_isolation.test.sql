-- PFA-C03B1 comprehensive database-security suite 002: relational RLS isolation.
--
-- Proves both-owner integrity and per-user isolation on the relationship tables:
--   paper_projects · paper_tags · paper_attachments
--
-- ## The junctions are proved in two layers (DB-JUNCTION-DML-GRANT-HARDENING-001)
--
-- Since migration 20260925134526 (decision C48) `authenticated` holds SELECT
-- and nothing else on `paper_projects` / `paper_tags`: every assignment write
-- goes through the SECURITY DEFINER assignment RPCs. A browser INSERT/DELETE is
-- therefore refused at the OBJECT PRIVILEGE (42501 "permission denied") before
-- any RLS policy is consulted. That changes what this suite has to say:
--
--   * LAYER A — the real browser boundary. As `authenticated`, exactly as the
--     Data API would run it: own rows are readable, foreign rows are invisible,
--     and every direct INSERT / DELETE / UPDATE — own or cross-owner — is refused
--     by the ACL, writing nothing. Alongside it, the ENTITY tables are proved to
--     stay user-writable: a Project and a Tag are created by direct INSERT (the
--     path Edit Paper's AI "Create & select" uses), assigned through
--     `set_paper_projects` / `set_paper_tags`, and deleted again with their
--     junction rows removed by FK cascade, which needs no junction grant.
--
--   * LAYER B — the dormant policies. The junctions keep their both-owner
--     INSERT/DELETE policies on purpose, as defense-in-depth against a future
--     re-grant. Under Layer A alone those policies would be untestable: the ACL
--     answers first, so an "own paper + foreign Project → 42501" case would pass
--     whether or not the policy still existed. So this suite GRANTs INSERT and
--     DELETE back to `authenticated` inside its own transaction, runs the full
--     ownership matrix against the policies, requires every refusal to be an RLS
--     refusal rather than the ACL's, and REVOKEs again. The grant is test-only:
--     it is rolled back with everything else, and it must never appear in a
--     migration.
--
-- paper_attachments rejects a mismatched owner or foreign referenced paper at
-- the BEFORE-INSERT ownership trigger (P0001), before any storage quota is
-- consumed; its client write surface was already closed by 20260904120000.
--
-- This overlaps the accepted focused suite 000 only where needed to keep suite
-- 002 independently understandable; it does not copy the full 000 file.
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

-- Like errcode_as, but returns '<SQLSTATE> <message>'. Both an ACL refusal and
-- an RLS refusal are 42501, so the MESSAGE is what tells the two layers apart:
-- "permission denied for table …" vs "new row violates row-level security …".
CREATE FUNCTION pg_temp.err_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text; v_msg text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := '00000';
    v_msg := '';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state || ' ' || v_msg;
END;
$hlp$;

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

-- ── Fixtures (as superuser) ──────────────────────────────────────────────────
-- A owns paper a1, Projects a2 / a6 and Tags a3 / a7; B owns paper b1, Project
-- b2 and Tag b3. A's paper starts assigned to Project a2 and Tag a3, written here
-- by the owner exactly as an assignment RPC would write them.
INSERT INTO auth.users (id, email) VALUES
  ('aa000000-0000-0000-0000-000000000001','rel-A@paperlume.test'),
  ('bb000000-0000-0000-0000-000000000002','rel-B@paperlume.test');
INSERT INTO public.papers (id, user_id, title, insert_order) VALUES
  ('a0000000-0000-0000-0000-0000000000a1','aa000000-0000-0000-0000-000000000001','Paper A',1),
  ('b0000000-0000-0000-0000-0000000000b1','bb000000-0000-0000-0000-000000000002','Paper B',2);
INSERT INTO public.projects (id, user_id, name) VALUES
  ('a0000000-0000-0000-0000-0000000000a2','aa000000-0000-0000-0000-000000000001','Project A'),
  ('a0000000-0000-0000-0000-0000000000a6','aa000000-0000-0000-0000-000000000001','Project A2'),
  ('b0000000-0000-0000-0000-0000000000b2','bb000000-0000-0000-0000-000000000002','Project B');
INSERT INTO public.tags (id, user_id, name) VALUES
  ('a0000000-0000-0000-0000-0000000000a3','aa000000-0000-0000-0000-000000000001','Tag A'),
  ('a0000000-0000-0000-0000-0000000000a7','aa000000-0000-0000-0000-000000000001','Tag A2'),
  ('b0000000-0000-0000-0000-0000000000b3','bb000000-0000-0000-0000-000000000002','Tag B');
INSERT INTO public.paper_projects (paper_id, project_id) VALUES
  ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2');
INSERT INTO public.paper_tags (paper_id, tag_id) VALUES
  ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a3');

SELECT plan(57);

-- ══ LAYER A · paper_projects — the real browser boundary ════════════════════
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '1', 'paper_projects [A]: A reads their own assignment (SELECT is kept)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '0', 'paper_projects [A]: B cannot see A''s assignment');
SELECT is(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_projects(paper_id,project_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a6')$q$),
  '42501 permission denied for table paper_projects', 'paper_projects [A]: own paper + own Project direct INSERT refused at the ACL');
SELECT is(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_projects(paper_id,project_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','b0000000-0000-0000-0000-0000000000b2')$q$),
  '42501 permission denied for table paper_projects', 'paper_projects [A]: cross-owner direct INSERT refused at the ACL');
SELECT is(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501 permission denied for table paper_projects', 'paper_projects [A]: A''s direct DELETE of their own assignment refused at the ACL');
SELECT is(pg_temp.err_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501 permission denied for table paper_projects', 'paper_projects [A]: B''s direct DELETE of A''s assignment refused at the ACL');
SELECT is(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$UPDATE public.paper_projects SET project_id='a0000000-0000-0000-0000-0000000000a6' WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501 permission denied for table paper_projects', 'paper_projects [A]: direct UPDATE refused at the ACL');
SELECT is(
  (SELECT string_agg(project_id::text, ',' ORDER BY project_id) FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'),
  'a0000000-0000-0000-0000-0000000000a2', 'paper_projects [A]: the refused statements wrote and removed nothing');

-- ══ LAYER A · paper_tags — the real browser boundary (symmetric) ════════════
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '1', 'paper_tags [A]: A reads their own assignment (SELECT is kept)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '0', 'paper_tags [A]: B cannot see A''s assignment');
SELECT is(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_tags(paper_id,tag_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a7')$q$),
  '42501 permission denied for table paper_tags', 'paper_tags [A]: own paper + own Tag direct INSERT refused at the ACL');
SELECT is(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_tags(paper_id,tag_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','b0000000-0000-0000-0000-0000000000b3')$q$),
  '42501 permission denied for table paper_tags', 'paper_tags [A]: cross-owner direct INSERT refused at the ACL');
SELECT is(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501 permission denied for table paper_tags', 'paper_tags [A]: A''s direct DELETE of their own assignment refused at the ACL');
SELECT is(pg_temp.err_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501 permission denied for table paper_tags', 'paper_tags [A]: B''s direct DELETE of A''s assignment refused at the ACL');
SELECT is(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$UPDATE public.paper_tags SET tag_id='a0000000-0000-0000-0000-0000000000a7' WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501 permission denied for table paper_tags', 'paper_tags [A]: direct UPDATE refused at the ACL');
SELECT is(
  (SELECT string_agg(tag_id::text, ',' ORDER BY tag_id) FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'),
  'a0000000-0000-0000-0000-0000000000a3', 'paper_tags [A]: the refused statements wrote and removed nothing');

-- ══ LAYER A · Projects/Tags stay user-writable; assignment is RPC-mediated ══
-- The database half of Edit Paper's AI "Create & select": the ENTITY is created
-- by a direct browser INSERT, and only the paper ASSIGNMENT goes through the
-- setter RPC. Then the entity is deleted and its junction row goes with it — a
-- referential action runs as the junction's owner, so it needs no junction
-- DELETE grant either.
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.projects(id,user_id,name) VALUES ('a0000000-0000-0000-0000-0000000000a4','aa000000-0000-0000-0000-000000000001','AI-proposed Project')$q$),
  '00000', 'entities [A]: A creates a Project by direct INSERT (projects keeps INSERT)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.tags(id,user_id,name) VALUES ('a0000000-0000-0000-0000-0000000000a5','aa000000-0000-0000-0000-000000000001','ai-proposed-tag')$q$),
  '00000', 'entities [A]: A creates a Tag by direct INSERT (tags keeps INSERT)');
SELECT matches(pg_temp.err_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$INSERT INTO public.projects(user_id,name) VALUES ('aa000000-0000-0000-0000-000000000001','Planted in A''s library')$q$),
  '^42501 new row violates row-level security policy', 'entities [A]: B cannot create a Project in A''s library (entity RLS unchanged)');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.set_paper_projects('a0000000-0000-0000-0000-0000000000a1'::uuid,
       ARRAY['a0000000-0000-0000-0000-0000000000a2','a0000000-0000-0000-0000-0000000000a4']::uuid[])$q$),
  '00000', 'entities [A]: set_paper_projects assigns the just-created Project');
SELECT is(
  (SELECT string_agg(project_id::text, ',' ORDER BY project_id) FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'),
  'a0000000-0000-0000-0000-0000000000a2,a0000000-0000-0000-0000-0000000000a4',
  'entities [A]: the RPC wrote the assignment the browser itself may not write');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT public.set_paper_tags('a0000000-0000-0000-0000-0000000000a1'::uuid,
       ARRAY['a0000000-0000-0000-0000-0000000000a3','a0000000-0000-0000-0000-0000000000a5']::uuid[])$q$),
  '00000', 'entities [A]: set_paper_tags assigns the just-created Tag');
SELECT is(
  (SELECT string_agg(tag_id::text, ',' ORDER BY tag_id) FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'),
  'a0000000-0000-0000-0000-0000000000a3,a0000000-0000-0000-0000-0000000000a5',
  'entities [A]: the RPC wrote the Tag assignment the browser itself may not write');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.projects WHERE id='a0000000-0000-0000-0000-0000000000a4'$q$),
  1, 'entities [A]: A deletes their Project directly (projects keeps DELETE)');
SELECT is(
  (SELECT count(*)::int FROM public.paper_projects WHERE project_id='a0000000-0000-0000-0000-0000000000a4'),
  0, 'entities [A]: the Project''s junction row went with it (FK cascade needs no junction grant)');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.tags WHERE id='a0000000-0000-0000-0000-0000000000a5'$q$),
  1, 'entities [A]: A deletes their Tag directly (tags keeps DELETE)');
SELECT is(
  (SELECT count(*)::int FROM public.paper_tags WHERE tag_id='a0000000-0000-0000-0000-0000000000a5'),
  0, 'entities [A]: the Tag''s junction row went with it (FK cascade needs no junction grant)');

-- ══ LAYER B · the dormant both-owner policies ═══════════════════════════════
-- TEST-ONLY. Restores the pre-C48 grant inside this rolled-back transaction so
-- the policies are reachable again; see the header for why the suite needs it.
-- Every refusal below must be an RLS refusal, never the ACL's — otherwise the
-- case would be proving Layer A a second time.
GRANT INSERT, DELETE ON TABLE public.paper_projects, public.paper_tags TO authenticated;

SELECT ok(
  has_table_privilege('authenticated', 'public.paper_projects', 'INSERT')
  AND has_table_privilege('authenticated', 'public.paper_projects', 'DELETE')
  AND has_table_privilege('authenticated', 'public.paper_tags', 'INSERT')
  AND has_table_privilege('authenticated', 'public.paper_tags', 'DELETE'),
  'dormant [B]: the test-only grant is in effect, so the cases below reach the policies');

SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_projects(paper_id,project_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a6')$q$),
  '00000', 'paper_projects [B]: own paper + own Project allowed by the policy (positive control)');
SELECT matches(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_projects(paper_id,project_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','b0000000-0000-0000-0000-0000000000b2')$q$),
  '^42501 new row violates row-level security policy', 'paper_projects [B]: own paper + foreign Project rejected by the policy');
SELECT matches(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_projects(paper_id,project_id) VALUES ('b0000000-0000-0000-0000-0000000000b1','a0000000-0000-0000-0000-0000000000a2')$q$),
  '^42501 new row violates row-level security policy', 'paper_projects [B]: foreign paper + own Project rejected by the policy');
SELECT matches(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_projects(paper_id,project_id) VALUES ('b0000000-0000-0000-0000-0000000000b1','b0000000-0000-0000-0000-0000000000b2')$q$),
  '^42501 new row violates row-level security policy', 'paper_projects [B]: foreign paper + foreign Project rejected by the policy');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  0, 'paper_projects [B]: B''s DELETE of A''s assignments matches no row under the policy');
-- Unqualified on purpose. A DELETE with a WHERE clause also needs read access,
-- so the SELECT policy filters A's rows out before the DELETE policy is even
-- consulted; only a DELETE that references no column is judged by the DELETE
-- policy alone, which makes this the case that notices a weakened DELETE policy.
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.paper_projects$q$),
  0, 'paper_projects [B]: B''s unqualified DELETE reaches none of A''s rows (the DELETE policy alone decides)');
SELECT is(
  (SELECT string_agg(project_id::text, ',' ORDER BY project_id) FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'),
  'a0000000-0000-0000-0000-0000000000a2,a0000000-0000-0000-0000-0000000000a6',
  'paper_projects [B]: A''s assignments survive B''s delete, and only the permitted row was added');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.paper_projects WHERE paper_id='a0000000-0000-0000-0000-0000000000a1' AND project_id='a0000000-0000-0000-0000-0000000000a6'$q$),
  1, 'paper_projects [B]: A''s DELETE of their own assignment is allowed by the policy (positive control)');

SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_tags(paper_id,tag_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a7')$q$),
  '00000', 'paper_tags [B]: own paper + own Tag allowed by the policy (positive control)');
SELECT matches(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_tags(paper_id,tag_id) VALUES ('a0000000-0000-0000-0000-0000000000a1','b0000000-0000-0000-0000-0000000000b3')$q$),
  '^42501 new row violates row-level security policy', 'paper_tags [B]: own paper + foreign Tag rejected by the policy');
SELECT matches(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_tags(paper_id,tag_id) VALUES ('b0000000-0000-0000-0000-0000000000b1','a0000000-0000-0000-0000-0000000000a3')$q$),
  '^42501 new row violates row-level security policy', 'paper_tags [B]: foreign paper + own Tag rejected by the policy');
SELECT matches(pg_temp.err_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_tags(paper_id,tag_id) VALUES ('b0000000-0000-0000-0000-0000000000b1','b0000000-0000-0000-0000-0000000000b3')$q$),
  '^42501 new row violates row-level security policy', 'paper_tags [B]: foreign paper + foreign Tag rejected by the policy');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  0, 'paper_tags [B]: B''s DELETE of A''s assignments matches no row under the policy');
-- Unqualified on purpose. A DELETE with a WHERE clause also needs read access,
-- so the SELECT policy filters A's rows out before the DELETE policy is even
-- consulted; only a DELETE that references no column is judged by the DELETE
-- policy alone, which makes this the case that notices a weakened DELETE policy.
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.paper_tags$q$),
  0, 'paper_tags [B]: B''s unqualified DELETE reaches none of A''s rows (the DELETE policy alone decides)');
SELECT is(
  (SELECT string_agg(tag_id::text, ',' ORDER BY tag_id) FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'),
  'a0000000-0000-0000-0000-0000000000a3,a0000000-0000-0000-0000-0000000000a7',
  'paper_tags [B]: A''s assignments survive B''s delete, and only the permitted row was added');
SELECT is(pg_temp.rowcount_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.paper_tags WHERE paper_id='a0000000-0000-0000-0000-0000000000a1' AND tag_id='a0000000-0000-0000-0000-0000000000a7'$q$),
  1, 'paper_tags [B]: A''s DELETE of their own assignment is allowed by the policy (positive control)');

-- Close the test-only window again and prove it closed, so nothing later in
-- this file runs against the widened grant.
REVOKE INSERT, DELETE ON TABLE public.paper_projects, public.paper_tags FROM authenticated;
SELECT is(
  (SELECT string_agg(c.relname || '=' || coalesce((SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type)
                                                   FROM aclexplode(c.relacl) a WHERE a.grantee = 'authenticated'::regrole), ''),
                     ' ' ORDER BY c.relname)
     FROM pg_class c WHERE c.oid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass)),
  'paper_projects=SELECT paper_tags=SELECT',
  'dormant [B]: the test-only grant is withdrawn again (authenticated back to SELECT only)');

-- ══ paper_attachments (ownership trigger + storage accounting) ═══════════════
--
-- The four write cases below run as `postgres`, not as `authenticated`. Since
-- migration 20260904120000 no browser role holds INSERT/UPDATE/DELETE here, so a
-- direct client write is refused at the ACL before the ownership trigger is
-- consulted — these cases would then pass while testing nothing. The writer that
-- remains is the table owner, which is who the SECURITY DEFINER lifecycle RPCs
-- execute as, so it is exactly who the trigger has to hold against now. The two
-- client-facing assertions that follow them are new: the ACL boundary itself,
-- and cross-user isolation re-proved through the RPC that replaced the direct
-- DELETE.
SELECT is(pg_temp.errcode_as('postgres','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('a0000000-0000-0000-0000-0000000000a1','aa000000-0000-0000-0000-000000000001','a/ok.pdf','ok.pdf','application/pdf',1000)$q$),
  '00000', 'paper_attachments: own attachment on own paper allowed (positive control)');
SELECT is(pg_temp.errcode_as('postgres','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('b0000000-0000-0000-0000-0000000000b1','aa000000-0000-0000-0000-000000000001','a/x.pdf','x.pdf','application/pdf',100)$q$),
  'P0001', 'paper_attachments: own user_id + foreign paper_id rejected (trigger)');
SELECT is(pg_temp.errcode_as('postgres','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('a0000000-0000-0000-0000-0000000000a1','bb000000-0000-0000-0000-000000000002','a/y.pdf','y.pdf','application/pdf',100)$q$),
  'P0001', 'paper_attachments: foreign user_id + own paper rejected (trigger)');
SELECT is(pg_temp.errcode_as('postgres','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$INSERT INTO public.paper_attachments(paper_id,user_id,file_path,file_name,file_type,size_bytes)
     VALUES ('b0000000-0000-0000-0000-0000000000b1','bb000000-0000-0000-0000-000000000002','a/z.pdf','z.pdf','application/pdf',100)$q$),
  'P0001', 'paper_attachments: foreign user_id + foreign paper rejected (trigger)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_attachments WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '1', 'paper_attachments: A views own attachment metadata (positive control)');
SELECT is(pg_temp.scalar_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT count(*)::text FROM public.paper_attachments WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '0', 'paper_attachments: B cannot view A''s attachment metadata');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$DELETE FROM public.paper_attachments WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501', 'paper_attachments: B cannot delete A''s attachment metadata — no browser role holds DELETE at all');
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  $q$DELETE FROM public.paper_attachments WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'$q$),
  '42501', 'paper_attachments: nor can A, on her own row — deletion is the lifecycle RPC''s to perform');
-- Cross-user isolation, re-proved on the path that replaced the direct DELETE.
-- The grant boundary above refuses everyone equally, which is a weaker statement
-- than the one this suite exists to make; the RPC is where owner separation now
-- lives, so that is where it is asserted.
SELECT is(pg_temp.errcode_as('authenticated','{"sub":"bb000000-0000-0000-0000-000000000002","role":"authenticated"}',
  $q$SELECT public.delete_attachment_with_cleanup(
       (SELECT id FROM public.paper_attachments WHERE paper_id='a0000000-0000-0000-0000-0000000000a1'))$q$),
  'P0001', 'paper_attachments: B cannot delete A''s attachment through the lifecycle RPC either');
SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue), 0,
  'paper_attachments: B''s refused RPC call queued no cleanup for A''s object');
SELECT is(
  (SELECT count(*)::int FROM public.paper_attachments WHERE user_id='aa000000-0000-0000-0000-000000000001'),
  1, 'paper_attachments: rejected combinations created no row (only the one valid attachment exists)');
SELECT is(
  (SELECT used_bytes::text FROM public.user_storage_usage WHERE user_id='aa000000-0000-0000-0000-000000000001'),
  '1000', 'paper_attachments: rejected combinations did not change storage accounting');

SELECT * FROM finish();
ROLLBACK;
