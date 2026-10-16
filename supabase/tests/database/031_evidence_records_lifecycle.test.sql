-- EVIDENCE-RECORDS-001A2 suite 031: the study-record lifecycle RPCs.
--
-- Owns `20261016104232_add_evidence_records_lifecycle_rpcs.sql`: the four
-- client RPCs (create, update, set_link, delete), the owner-only pilot gate and
-- match normalization v1. Every call below runs as `authenticated` (or anon, or
-- service_role) with JWT claims, exactly as PostgREST would make it. Proves:
--   A. the function contract — exactly six functions, with their signatures,
--      results, security modes, volatility, owner and search_path; stored and
--      effective EXECUTE; no overloads; the gate and lock order in each body;
--      the evidence tables still SELECT-only;
--   B. the pilot gate (001A G6, P1-P14) — the owner allowed; a manager, an
--      ordinary user, forged JWT metadata, a demoted owner and a claim-less
--      caller refused; anon and service_role without EXECUTE; the helper and
--      the normalizer internal-only; delete ungated, also for a former owner;
--      foreign and unknown ids answered identically;
--   C. the lifecycle — creation with and without a copy, the copy's exact text
--      and fingerprints, the explicit link, several studies of one paper,
--      updates, no-ops, version conflicts, the design-family rule, link status,
--      safe unlinking, input validation, and the ordered deletion of a fully
--      populated study;
--   D. request idempotency (FK-PROOF-001 I-1), in sequence — replays, refused
--      reuse, stale versions, an aborted attempt retried, cross-user request
--      ids, and the bounded create-after-delete residual. The CONCURRENT cases
--      (identical creates and updates, conflicting updates, delete against
--      update, create against paper deletion, the isolation guard) need real
--      sessions: they are the db-tests lifecycle's evidence lifecycle race probe
--      in scripts/e2e-local.mjs;
--   E. history integrity — one header per request, gap-free versions and
--      ordinals, nothing appended by replays, no-ops or failures, earlier
--      events byte-identical after later writes, no abstract or notes text in
--      history, and a source scan of every public function;
--   F. existing behaviour — paper deletion and merge refused atomically while
--      an RPC-created study links the paper and allowed once it is deleted or
--      unlinked; deleting an account that holds RPC-created records; RLS read
--      isolation; no direct table write for the browser;
--   L. the limits — 2,000 studies per user, 5,000 events per study;
--   N. golden vectors for match normalization v1. Each expected output and
--      its SHA-256 was computed OUTSIDE PostgreSQL, by an independent reference
--      (Python's unicodedata NFC plus the REQUIREMENTS-001 section I3 mappings),
--      so the vectors test the SQL function rather than restate it.
--
-- Every non-ASCII character in this file is written as chr(<code point>).
-- Groups, outcomes, values and references have no write RPC yet (001A3), so
-- the fully populated study, the second report and the other users' studies are
-- planted by the database owner (FK-PROOF-001 K, layer 1). Everything runs in
-- one transaction and rolls back. Deterministic ids; synthetic data only; no
-- remote calls; no Production data; no real credentials.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- Fixture users: O owner, M manager, U ordinary user, F owner (demoted below),
-- X owner (account deleted below), B ordinary neighbour, L owner (limits).
CREATE FUNCTION pg_temp.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT ('03100000-0000-0000-0000-0000000000' || CASE p_name
            WHEN 'O' THEN 'a0' WHEN 'M' THEN 'b0' WHEN 'U' THEN 'c0' WHEN 'F' THEN 'd0'
            WHEN 'X' THEN 'e0' WHEN 'B' THEN 'f0' WHEN 'L' THEN 'a1' END)::uuid
$hlp$;

CREATE FUNCTION pg_temp.p(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT (CASE p_name
            WHEN 'PO1' THEN '031000a1' WHEN 'PO2' THEN '031000a2' WHEN 'PO3' THEN '031000a3'
            WHEN 'PO4' THEN '031000a4' WHEN 'PO5' THEN '031000a5' WHEN 'PO6' THEN '031000a6'
            WHEN 'PO7' THEN '031000a7' WHEN 'PO8' THEN '031000a8' WHEN 'PO9' THEN '031000a9'
            WHEN 'POA' THEN '031000aa' WHEN 'POB' THEN '031000ab' WHEN 'POC' THEN '031000ac'
            WHEN 'PM1' THEN '031000b1' WHEN 'PU1' THEN '031000c1' WHEN 'PF1' THEN '031000d1'
            WHEN 'PX1' THEN '031000e1' WHEN 'PB1' THEN '031000f1' WHEN 'PL1' THEN '031000a0'
            WHEN 'unknown' THEN '0310dead' END || '-0000-0000-0000-000000000000')::uuid
$hlp$;

-- Planted studies of other users, and an id nobody owns.
CREATE FUNCTION pg_temp.s(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT (CASE p_name WHEN 'SU1' THEN '0315c001' WHEN 'SM1' THEN '0315b001' WHEN 'SB1' THEN '0315f001'
                      WHEN 'unknown' THEN '0315dead' END || '-0000-0000-0000-000000000000')::uuid
$hlp$;

-- Request ids, one per numbered request.
CREATE FUNCTION pg_temp.rq(p_n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT ('031f' || lpad(to_hex(p_n), 4, '0') || '-0000-0000-0000-000000000000')::uuid
$hlp$;

CREATE FUNCTION pg_temp.claims(p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT '{"sub":"' || pg_temp.u(p_name)::text || '","role":"authenticated"}'
$hlp$;

-- The four RPC calls as SQL text (NULL arguments stay NULL).
CREATE FUNCTION pg_temp.q_create(p_paper uuid, p_label text, p_profile text, p_status text, p_req uuid)
RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('SELECT public.evidence_create_study_from_paper(%L::uuid, %L::text, %L::text, %L::text, %L::uuid)::text',
                p_paper, p_label, p_profile, p_status, p_req)
$hlp$;
CREATE FUNCTION pg_temp.q_update(p_study uuid, p_version integer, p_label text, p_profile text, p_notes text, p_req uuid)
RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('SELECT public.evidence_update_study(%L::uuid, %L::integer, %L::text, %L::text, %L::text, %L::uuid)::text',
                p_study, p_version, p_label, p_profile, p_notes, p_req)
$hlp$;
CREATE FUNCTION pg_temp.q_link(p_study uuid, p_paper uuid, p_action text, p_version integer, p_req uuid)
RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('SELECT public.evidence_set_link(%L::uuid, %L::uuid, %L::text, %L::integer, %L::uuid)::text',
                p_study, p_paper, p_action, p_version, p_req)
$hlp$;
CREATE FUNCTION pg_temp.q_delete(p_study uuid, p_version integer, p_req uuid)
RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('SELECT public.evidence_delete_study(%L::uuid, %L::integer, %L::uuid)::text',
                p_study, p_version, p_req)
$hlp$;

-- Run p_sql as p_role with p_claims and KEEP its effects. Returns its single
-- value, or 'ERR <SQLSTATE> <message>[ [<detail>]]'. A failed call leaves
-- nothing behind: its subtransaction rolls back.
CREATE FUNCTION pg_temp.call(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE
  v_out    text;
  v_state  text;
  v_msg    text;
  v_detail text;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  BEGIN
    EXECUTE p_sql INTO v_out;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    v_out := 'ERR ' || v_state || ' ' || v_msg
             || CASE WHEN coalesce(v_detail, '') <> '' THEN ' [' || v_detail || ']' ELSE '' END;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_out;
END;
$hlp$;

-- Answers kept for later assertions (always read in a later statement).
CREATE TEMP TABLE res (k text PRIMARY KEY, v text);

CREATE FUNCTION pg_temp.run(p_key text, p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_out text;
BEGIN
  v_out := pg_temp.call(p_role, p_claims, p_sql);
  INSERT INTO res (k, v) VALUES (p_key, v_out);
  RETURN v_out;
END;
$hlp$;

-- The status of an RPC answer, or the whole error line when there is none.
CREATE FUNCTION pg_temp.status(p_out text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT CASE WHEN p_out LIKE '{%' THEN p_out::jsonb ->> 'status' ELSE coalesce(p_out, '<null>') END
$hlp$;

-- One field of an RPC answer, or the whole error line when there is none.
CREATE FUNCTION pg_temp.field(p_out text, p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT CASE WHEN p_out LIKE '{%' THEN p_out::jsonb ->> p_name ELSE coalesce(p_out, '<null>') END
$hlp$;

CREATE FUNCTION pg_temp.kept(p_key text) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT r.v FROM res r WHERE r.k = p_key
$hlp$;

CREATE FUNCTION pg_temp.j(p_key text) RETURNS jsonb LANGUAGE sql STABLE AS $hlp$
  SELECT CASE WHEN r.v LIKE '{%' THEN r.v::jsonb END FROM res r WHERE r.k = p_key
$hlp$;

CREATE FUNCTION pg_temp.sid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $hlp$
  SELECT (pg_temp.j(p_key) ->> 'study_id')::uuid
$hlp$;

CREATE FUNCTION pg_temp.ver(p_study uuid) RETURNS integer LANGUAGE sql STABLE AS $hlp$
  SELECT s.row_version FROM public.evidence_studies s WHERE s.id = p_study
$hlp$;

-- Run p_sql as p_role, then (as postgres) p_check, then undo EVERYTHING with a
-- sentinel raised in the same subtransaction. '00000' (plus ' ' || check) on
-- success, otherwise '<SQLSTATE>' or '<SQLSTATE>:<constraint>'.
CREATE FUNCTION pg_temp.probe(p_role text, p_claims text, p_sql text, p_check text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE
  v_state text;
  v_con   text;
  v_check text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
    EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
    EXECUTE p_sql;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    IF p_check IS NOT NULL THEN
      EXECUTE p_check INTO v_check;
    END IF;
    RAISE EXCEPTION 'evidence-031 probe undo' USING ERRCODE = 'P0E31';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_con = CONSTRAINT_NAME;
  END;
  IF v_state = 'P0E31' THEN
    RETURN '00000' || CASE WHEN p_check IS NOT NULL THEN ' ' || coalesce(v_check, '<null>') ELSE '' END;
  END IF;
  RETURN v_state || CASE WHEN coalesce(v_con, '') <> '' THEN ':' || v_con ELSE '' END;
END;
$hlp$;

-- Every evidence row of one user, and their papers, as one digest.
CREATE FUNCTION pg_temp.digest(p_user uuid) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT md5(
       coalesce((SELECT string_agg(t::text, ';' ORDER BY t.id) FROM public.evidence_studies t          WHERE t.user_id = p_user), '') || '#'
    || coalesce((SELECT string_agg(t::text, ';' ORDER BY t.id) FROM public.evidence_study_reports t    WHERE t.user_id = p_user), '') || '#'
    || coalesce((SELECT string_agg(t::text, ';' ORDER BY t.id) FROM public.evidence_source_snapshots t WHERE t.user_id = p_user), '') || '#'
    || coalesce((SELECT string_agg(t::text, ';' ORDER BY t.id) FROM public.evidence_arms t             WHERE t.user_id = p_user), '') || '#'
    || coalesce((SELECT string_agg(t::text, ';' ORDER BY t.id) FROM public.evidence_outcomes t         WHERE t.user_id = p_user), '') || '#'
    || coalesce((SELECT string_agg(t::text, ';' ORDER BY t.id) FROM public.evidence_field_values t     WHERE t.user_id = p_user), '') || '#'
    || coalesce((SELECT string_agg(t::text, ';' ORDER BY t.id) FROM public.evidence_field_anchors t    WHERE t.user_id = p_user), '') || '#'
    || coalesce((SELECT string_agg(t::text, ';' ORDER BY t.id) FROM public.evidence_events t           WHERE t.user_id = p_user), '') || '#'
    || coalesce((SELECT string_agg(t::text, ';' ORDER BY t.id) FROM public.papers t                    WHERE t.user_id = p_user), ''))
$hlp$;

-- Row counts per evidence table for one study.
CREATE FUNCTION pg_temp.study_rows(p_study uuid) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('studies=%s links=%s copies=%s arms=%s outcomes=%s values=%s refs=%s events=%s',
    (SELECT count(*) FROM public.evidence_studies          WHERE id = p_study),
    (SELECT count(*) FROM public.evidence_study_reports    WHERE study_id = p_study),
    (SELECT count(*) FROM public.evidence_source_snapshots WHERE study_id = p_study),
    (SELECT count(*) FROM public.evidence_arms             WHERE study_id = p_study),
    (SELECT count(*) FROM public.evidence_outcomes         WHERE study_id = p_study),
    (SELECT count(*) FROM public.evidence_field_values     WHERE study_id = p_study),
    (SELECT count(*) FROM public.evidence_field_anchors    WHERE study_id = p_study),
    (SELECT count(*) FROM public.evidence_events           WHERE study_id = p_study))
$hlp$;

-- Row counts per evidence table for one user.
CREATE FUNCTION pg_temp.user_rows(p_user uuid) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('studies=%s links=%s copies=%s arms=%s outcomes=%s values=%s refs=%s events=%s',
    (SELECT count(*) FROM public.evidence_studies          WHERE user_id = p_user),
    (SELECT count(*) FROM public.evidence_study_reports    WHERE user_id = p_user),
    (SELECT count(*) FROM public.evidence_source_snapshots WHERE user_id = p_user),
    (SELECT count(*) FROM public.evidence_arms             WHERE user_id = p_user),
    (SELECT count(*) FROM public.evidence_outcomes         WHERE user_id = p_user),
    (SELECT count(*) FROM public.evidence_field_values     WHERE user_id = p_user),
    (SELECT count(*) FROM public.evidence_field_anchors    WHERE user_id = p_user),
    (SELECT count(*) FROM public.evidence_events           WHERE user_id = p_user))
$hlp$;

-- A study of another user, planted by the database owner (layer 1).
CREATE FUNCTION pg_temp.plant_study(p_id uuid, p_user uuid, p_paper uuid) RETURNS void LANGUAGE sql AS $hlp$
  INSERT INTO public.evidence_studies (id, user_id, label, design_profile)
  VALUES (p_id, p_user, 'Planted study', 'rct_parallel');
  INSERT INTO public.evidence_study_reports (user_id, study_id, paper_id, link_status, link_basis)
  VALUES (p_user, p_id, p_paper, 'user_confirmed', 'created_from_paper');
$hlp$;

-- A copy, with both fingerprints computed exactly as create computes them.
CREATE FUNCTION pg_temp.plant_copy(p_id uuid, p_user uuid, p_study uuid, p_paper uuid, p_seq integer, p_text text)
RETURNS void LANGUAGE sql AS $hlp$
  INSERT INTO public.evidence_source_snapshots
    (id, user_id, study_id, paper_id, seq, source_kind, exact_text, exact_sha256,
     normalized_sha256, normalization_version, char_count)
  VALUES (p_id, p_user, p_study, p_paper, p_seq, 'library_abstract', p_text, sha256(convert_to(p_text, 'UTF8')),
          sha256(convert_to(public.evidence_normalize_v1(p_text), 'UTF8')), 'v1', char_length(p_text));
$hlp$;

-- A function body without its line comments, for source scans.
CREATE FUNCTION pg_temp.code(p_fn regprocedure) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') FROM pg_proc p WHERE p.oid = p_fn
$hlp$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────

INSERT INTO auth.users (id, email) VALUES
  (pg_temp.u('O'), 'evidence-031-owner@paperlume.test'),
  (pg_temp.u('M'), 'evidence-031-manager@paperlume.test'),
  (pg_temp.u('U'), 'evidence-031-user@paperlume.test'),
  (pg_temp.u('F'), 'evidence-031-former-owner@paperlume.test'),
  (pg_temp.u('X'), 'evidence-031-deleted-owner@paperlume.test'),
  (pg_temp.u('B'), 'evidence-031-neighbour@paperlume.test'),
  (pg_temp.u('L'), 'evidence-031-limit-owner@paperlume.test');

-- The server-side role table is the gate's only authority.
INSERT INTO public.internal_user_access (user_id, role) VALUES
  (pg_temp.u('O'), 'owner'),
  (pg_temp.u('M'), 'manager'),
  (pg_temp.u('F'), 'owner'),
  (pg_temp.u('X'), 'owner'),
  (pg_temp.u('L'), 'owner');

-- PO1's abstract exercises v1: a no-break space, thin spaces, an en dash, a
-- superscript, a micro sign, curly quotes, a Unicode hyphen, an ellipsis, a
-- line break and a decomposed e-acute. MARKER031 lets section E prove the text
-- never reaches history.
INSERT INTO public.papers (id, user_id, title, abstract, insert_order) VALUES
  (pg_temp.p('PO1'), pg_temp.u('O'), 'PO1 Unicode abstract',
   'MARKER031 Adults' || chr(0x00A0) || '(n' || chr(0x2009) || '=' || chr(0x2009) || '120) were randomized '
   || chr(0x2013) || ' 10' || chr(0x2075) || ' cells per ' || chr(0x00B5) || 'L; ' || chr(0x201C) || 'double'
   || chr(0x2010) || 'blind' || chr(0x201D) || chr(0x2026) || chr(0x000A) || 'cafe' || chr(0x0301) || '.', 1),
  (pg_temp.p('PO2'), pg_temp.u('O'), 'PO2 no abstract',         NULL, 2),
  (pg_temp.p('PO3'), pg_temp.u('O'), 'PO3 empty abstract',      '', 3),
  (pg_temp.p('PO4'), pg_temp.u('O'), 'PO4 blank abstract',
   ' ' || chr(0x00A0) || chr(0x0009) || chr(0x200B) || chr(0x000A) || chr(0x3000), 4),
  (pg_temp.p('PO5'), pg_temp.u('O'), 'PO5 over-long abstract',  repeat('ab ', 16667), 5),
  (pg_temp.p('PO6'), pg_temp.u('O'), 'PO6 longest abstract',    repeat('ab ', 16666) || 'ab', 6),
  (pg_temp.p('PO7'), pg_temp.u('O'), 'PO7 second report',       'Second report abstract.', 7),
  (pg_temp.p('PO8'), pg_temp.u('O'), 'PO8 delete protection',   'Delete protection abstract.', 8),
  (pg_temp.p('PO9'), pg_temp.u('O'), 'PO9 merge keeper',        'Keeper abstract.', 9),
  (pg_temp.p('POA'), pg_temp.u('O'), 'POA merge discard',       'Discard abstract.', 10),
  (pg_temp.p('POB'), pg_temp.u('O'), 'POB design family',       'Design family abstract.', 11),
  (pg_temp.p('POC'), pg_temp.u('O'), 'POC idempotency',         'Idempotency abstract.', 12),
  (pg_temp.p('PM1'), pg_temp.u('M'), 'PM1 manager paper',       'Manager abstract.', 13),
  (pg_temp.p('PU1'), pg_temp.u('U'), 'PU1 user paper',          'User abstract.', 14),
  (pg_temp.p('PF1'), pg_temp.u('F'), 'PF1 former owner paper',  'Former owner abstract.', 15),
  (pg_temp.p('PX1'), pg_temp.u('X'), 'PX1 deleted account',     'Deleted account abstract.', 16),
  (pg_temp.p('PB1'), pg_temp.u('B'), 'PB1 neighbour paper',     'Neighbour abstract.', 17),
  (pg_temp.p('PL1'), pg_temp.u('L'), 'PL1 limits paper',        'Limits abstract.', 18);

-- A tag and a project on the merge discard, so a refused merge can be shown not
-- to have unioned either onto the keeper.
INSERT INTO public.tags (id, user_id, name) VALUES
  ('03180000-0000-0000-0000-0000000000aa', pg_temp.u('O'), 'evidence-031 tag on POA');
INSERT INTO public.paper_tags (paper_id, tag_id) VALUES
  (pg_temp.p('POA'), '03180000-0000-0000-0000-0000000000aa');
INSERT INTO public.projects (id, user_id, name) VALUES
  ('03190000-0000-0000-0000-0000000000aa', pg_temp.u('O'), 'evidence-031 project on POA');
INSERT INTO public.paper_projects (paper_id, project_id) VALUES
  (pg_temp.p('POA'), '03190000-0000-0000-0000-0000000000aa');

-- Attachment metadata, so a refused delete would have queued cleanup intent and
-- a refused merge would have re-parented a row. The BEFORE INSERT quota trigger
-- requires auth.uid() = NEW.user_id (see suite 008).
SELECT set_config('request.jwt.claims', pg_temp.claims('O'), true);
INSERT INTO public.paper_attachments (id, paper_id, user_id, file_path, file_name, file_type, size_bytes) VALUES
  ('03170000-0000-0000-0000-0000000000a8', pg_temp.p('PO8'), pg_temp.u('O'),
   pg_temp.u('O') || '/' || pg_temp.p('PO8') || '/po8.pdf', 'po8.pdf', 'application/pdf', 1000),
  ('03170000-0000-0000-0000-0000000000aa', pg_temp.p('POA'), pg_temp.u('O'),
   pg_temp.u('O') || '/' || pg_temp.p('POA') || '/poa.pdf', 'poa.pdf', 'application/pdf', 1000);
SELECT set_config('request.jwt.claims', pg_temp.claims('X'), true);
INSERT INTO public.paper_attachments (id, paper_id, user_id, file_path, file_name, file_type, size_bytes) VALUES
  ('03170000-0000-0000-0000-0000000000e1', pg_temp.p('PX1'), pg_temp.u('X'),
   pg_temp.u('X') || '/' || pg_temp.p('PX1') || '/px1.pdf', 'px1.pdf', 'application/pdf', 1000);
SELECT set_config('request.jwt.claims', '', true);

-- Studies the RPCs cannot create for these users, planted by the owner: one for
-- the ordinary user (P4), one for the manager (P2) and one for the neighbour,
-- whose copy and request header make "someone else's" ids and request ids real.
SELECT pg_temp.plant_study(pg_temp.s('SU1'), pg_temp.u('U'), pg_temp.p('PU1'));
SELECT pg_temp.plant_study(pg_temp.s('SM1'), pg_temp.u('M'), pg_temp.p('PM1'));
SELECT pg_temp.plant_study(pg_temp.s('SB1'), pg_temp.u('B'), pg_temp.p('PB1'));
SELECT pg_temp.plant_copy('0316f001-0000-0000-0000-000000000000', pg_temp.u('B'), pg_temp.s('SB1'),
                          pg_temp.p('PB1'), 1, 'Neighbour abstract.');
INSERT INTO public.evidence_events (user_id, study_id, study_version, ordinal, event_type, request_id,
                                    op, payload_sha256, result)
VALUES (pg_temp.u('B'), pg_temp.s('SB1'), 1, 0, 'request', '031fbbbb-0000-0000-0000-000000000000',
        'create_study', sha256('planted'::bytea), '{"status": "applied"}');

SELECT plan(303);

-- ═════════════════════════════════════════════════════════════════════════════
-- A. The function contract
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT string_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ') -> ' || pg_get_function_result(p.oid)
                     || ' | ' || l.lanname || ' | ' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
                     || ' | vol=' || p.provolatile::text || ' strict=' || CASE WHEN p.proisstrict THEN 't' ELSE 'f' END
                     || ' parallel=' || p.proparallel::text || ' | owner=' || pg_get_userbyid(p.proowner)
                     || ' | ' || coalesce(array_to_string(p.proconfig, ';'), '<no config>'),
                     E'\n' ORDER BY p.proname)
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'),
  'evidence_create_study_from_paper(p_paper_id uuid, p_label text, p_design_profile text, p_link_status text, p_request_id uuid) -> jsonb'
  || ' | plpgsql | definer | vol=v strict=f parallel=u | owner=postgres | search_path=public, pg_temp' || E'\n'
  || 'evidence_delete_study(p_study_id uuid, p_expected_version integer, p_request_id uuid) -> jsonb'
  || ' | plpgsql | definer | vol=v strict=f parallel=u | owner=postgres | search_path=public, pg_temp' || E'\n'
  || 'evidence_normalize_v1(p_text text) -> text'
  || ' | plpgsql | invoker | vol=i strict=t parallel=s | owner=postgres | search_path=pg_catalog, pg_temp' || E'\n'
  || 'evidence_records_assert_writable() -> void'
  || ' | plpgsql | invoker | vol=v strict=f parallel=u | owner=postgres | search_path=public, pg_temp' || E'\n'
  || 'evidence_set_link(p_study_id uuid, p_paper_id uuid, p_action text, p_expected_version integer, p_request_id uuid) -> jsonb'
  || ' | plpgsql | definer | vol=v strict=f parallel=u | owner=postgres | search_path=public, pg_temp' || E'\n'
  || 'evidence_update_study(p_study_id uuid, p_expected_version integer, p_label text, p_design_profile text, p_notes text, p_request_id uuid) -> jsonb'
  || ' | plpgsql | definer | vol=v strict=f parallel=u | owner=postgres | search_path=public, pg_temp',
  'A1 exactly six evidence functions, each with its reviewed signature, result, language, security mode, volatility, owner and search_path');

SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = nm),
  1, 'A2 exactly one overload of ' || nm)
FROM unnest(ARRAY['evidence_create_study_from_paper', 'evidence_delete_study', 'evidence_normalize_v1',
                  'evidence_records_assert_writable', 'evidence_set_link', 'evidence_update_study']) nm;

SELECT is((SELECT count(*)::int FROM pg_proc p
            WHERE p.proname LIKE 'evidence\_%' AND p.pronamespace <> 'public'::regnamespace),
  0, 'A2 no evidence function exists outside public');

-- The stored ACL, and who can execute it among the four grantees that matter
-- (PUBLIC is grantee 0; has_function_privilege also sees PUBLIC inheritance).
SELECT is((SELECT coalesce(p.proacl::text, '<default>') FROM pg_proc p WHERE p.oid = to_regprocedure(f.sig)),
  f.acl, 'A3 stored EXECUTE ACL of ' || f.sig)
FROM (VALUES
  ('public.evidence_create_study_from_paper(uuid,text,text,text,uuid)', '{postgres=X/postgres,authenticated=X/postgres}'),
  ('public.evidence_update_study(uuid,integer,text,text,text,uuid)',    '{postgres=X/postgres,authenticated=X/postgres}'),
  ('public.evidence_set_link(uuid,uuid,text,integer,uuid)',            '{postgres=X/postgres,authenticated=X/postgres}'),
  ('public.evidence_delete_study(uuid,integer,uuid)',                  '{postgres=X/postgres,authenticated=X/postgres}'),
  ('public.evidence_records_assert_writable()',                         '{postgres=X/postgres}'),
  ('public.evidence_normalize_v1(text)',                                '{postgres=X/postgres}')
) AS f(sig, acl);

SELECT is(
  (SELECT coalesce(string_agg(r, ',' ORDER BY r COLLATE "C"), '<nobody>')
     FROM unnest(ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']) r
    WHERE CASE WHEN r = 'PUBLIC'
               THEN EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                             WHERE p.oid = to_regprocedure(f.sig) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
               ELSE has_function_privilege(r, to_regprocedure(f.sig), 'EXECUTE') END),
  f.who, 'A4 effective EXECUTE on ' || f.sig || ': ' || f.who)
FROM (VALUES
  ('public.evidence_create_study_from_paper(uuid,text,text,text,uuid)', 'authenticated'),
  ('public.evidence_update_study(uuid,integer,text,text,text,uuid)',    'authenticated'),
  ('public.evidence_set_link(uuid,uuid,text,integer,uuid)',            'authenticated'),
  ('public.evidence_delete_study(uuid,integer,uuid)',                  'authenticated'),
  ('public.evidence_records_assert_writable()',                         '<nobody>'),
  ('public.evidence_normalize_v1(text)',                                '<nobody>')
) AS f(sig, who);

-- The I-1 order, read from each body: the gate before any table is read, then
-- the request lock, then the header lookup, then the study row (or, for
-- create, the per-user lock and the paper). Delete never consults the gate.
SELECT ok(
  (WITH c AS (SELECT pg_temp.code('public.evidence_create_study_from_paper(uuid,text,text,text,uuid)') AS t)
   SELECT position('PERFORM public.evidence_records_assert_writable()' IN t) > 0
      AND position('PERFORM public.evidence_records_assert_writable()' IN t) < position('FROM public.' IN t)
      AND position('pg_advisory_xact_lock(20261016' IN t) < position('FROM public.evidence_events' IN t)
      AND position('FROM public.evidence_events' IN t) < position('pg_advisory_xact_lock(20261017' IN t)
      AND position('pg_advisory_xact_lock(20261017' IN t) < position('FROM public.papers' IN t)
     FROM c),
  'A5 create: gate, request lock, header lookup, per-user lock, then the paper');
SELECT ok(
  (WITH c AS (SELECT pg_temp.code(to_regprocedure(sig)) AS t)
   SELECT position('PERFORM public.evidence_records_assert_writable()' IN t) > 0
      AND position('PERFORM public.evidence_records_assert_writable()' IN t) < position('FROM public.' IN t)
      AND position('pg_advisory_xact_lock(20261016' IN t) < position('FROM public.evidence_events' IN t)
      AND position('FROM public.evidence_events' IN t) < position('FROM public.evidence_studies' IN t)
     FROM c),
  'A5 ' || sig || ': gate, request lock, header lookup, then the study row')
FROM unnest(ARRAY['public.evidence_update_study(uuid,integer,text,text,text,uuid)',
                  'public.evidence_set_link(uuid,uuid,text,integer,uuid)']) sig;
SELECT is(position('evidence_records_assert_writable' IN pg_temp.code('public.evidence_delete_study(uuid,integer,uuid)')),
  0, 'A5 delete does not consult the pilot gate');

SELECT is(
  (SELECT string_agg(c.relname || '=' || (SELECT coalesce(string_agg(pr, ',' ORDER BY pr), '')
                                            FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) pr
                                           WHERE has_table_privilege('authenticated', c.oid, pr)),
                     ' ' ORDER BY c.relname COLLATE "C")
     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'evidence\_%'),
  'evidence_arms=SELECT evidence_events=SELECT evidence_field_anchors=SELECT evidence_field_values=SELECT '
  || 'evidence_outcomes=SELECT evidence_source_snapshots=SELECT evidence_studies=SELECT evidence_study_reports=SELECT',
  'A6 authenticated still holds exactly SELECT on each evidence table: the RPCs are the only write path');
SELECT is(
  (SELECT count(*)::int
     FROM pg_class c, unnest(ARRAY['anon', 'service_role']) r,
          unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) pr
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'evidence\_%'
      AND has_table_privilege(r, c.oid, pr)),
  0, 'A6 anon and service_role still hold nothing on any evidence table');

-- ═════════════════════════════════════════════════════════════════════════════
-- B. The pilot gate (001A G6)
-- ═════════════════════════════════════════════════════════════════════════════

-- P1 — the owner. This study (s1) is reused throughout section C.
SELECT is(pg_temp.status(pg_temp.run('s1', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('PO1'), 'Smith 2024', 'rct_parallel', 'provisional', pg_temp.rq(1)))),
  'applied', 'P1 the owner creates a study from their own paper');
SELECT is((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(pg_temp.j('s1')) k),
  'link_id,snapshot_id,status,study_id,study_version',
  'P1 the answer names the new study, its version, its link and its copy');

-- P2 — a manager is not an owner, even for a study it holds.
INSERT INTO res VALUES ('dig_m', pg_temp.digest(pg_temp.u('M')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('M'),
    pg_temp.q_create(pg_temp.p('PM1'), 'Manager study', 'rct_parallel', 'user_confirmed', pg_temp.rq(2))),
  'ERR 42501 evidence_records_not_enabled', 'P2 a manager cannot create');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('M'),
    pg_temp.q_update(pg_temp.s('SM1'), 1, 'Renamed', 'rct_parallel', NULL, pg_temp.rq(3))),
  'ERR 42501 evidence_records_not_enabled', 'P2 a manager cannot update a study it holds');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('M'),
    pg_temp.q_link(pg_temp.s('SM1'), pg_temp.p('PM1'), 'mark_provisional', 1, pg_temp.rq(4))),
  'ERR 42501 evidence_records_not_enabled', 'P2 a manager cannot change a link of a study it holds');
SELECT is(pg_temp.digest(pg_temp.u('M')), pg_temp.kept('dig_m'), 'P2 nothing of the manager''s changed');

-- P3 — an ordinary user.
INSERT INTO res VALUES ('dig_u', pg_temp.digest(pg_temp.u('U')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('U'),
    pg_temp.q_create(pg_temp.p('PU1'), 'User study', 'rct_parallel', 'user_confirmed', pg_temp.rq(5))),
  'ERR 42501 evidence_records_not_enabled', 'P3 an ordinary user cannot create');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('U'),
    pg_temp.q_update(pg_temp.s('SU1'), 1, 'Renamed', 'rct_parallel', NULL, pg_temp.rq(6))),
  'ERR 42501 evidence_records_not_enabled', 'P3 an ordinary user cannot update a study it holds');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('U'),
    pg_temp.q_link(pg_temp.s('SU1'), pg_temp.p('PU1'), 'mark_provisional', 1, pg_temp.rq(7))),
  'ERR 42501 evidence_records_not_enabled', 'P3 an ordinary user cannot change a link');

-- P5 — owner claims in JWT metadata are not the role table.
SELECT is(pg_temp.call('authenticated',
    '{"sub":"' || pg_temp.u('U')::text || '","role":"authenticated","app_metadata":{"role":"owner"},"user_metadata":{"role":"owner","is_owner":true}}',
    pg_temp.q_create(pg_temp.p('PU1'), 'Forged study', 'rct_parallel', 'user_confirmed', pg_temp.rq(9))),
  'ERR 42501 evidence_records_not_enabled', 'P5 forged app_metadata and user_metadata roles are ignored: refused');
SELECT is(pg_temp.digest(pg_temp.u('U')), pg_temp.kept('dig_u'), 'P3/P5 nothing of the ordinary user''s changed');

-- P4 — delete is ungated: an ordinary user removes a study they hold.
SELECT is(pg_temp.call('authenticated', pg_temp.claims('U'), pg_temp.q_delete(pg_temp.s('SU1'), 1, pg_temp.rq(8))),
  '{"status": "deleted"}', 'P4 an ordinary user who holds a study can delete it');
SELECT is(pg_temp.user_rows(pg_temp.u('U')),
  'studies=0 links=0 copies=0 arms=0 outcomes=0 values=0 refs=0 events=0', 'P4 nothing of that study remains');

-- P6 — no caching: the owner role is read on every call.
SELECT is(pg_temp.status(pg_temp.run('sf', 'authenticated', pg_temp.claims('F'),
    pg_temp.q_create(pg_temp.p('PF1'), 'Former owner study', 'rct_parallel', 'user_confirmed', pg_temp.rq(10)))),
  'applied', 'P6 an owner creates a study');
DELETE FROM public.internal_user_access WHERE user_id = pg_temp.u('F');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('F'),
    pg_temp.q_update(pg_temp.sid('sf'), 1, 'After demotion', 'rct_parallel', NULL, pg_temp.rq(11))),
  'ERR 42501 evidence_records_not_enabled', 'P6 once its role row is removed, the next update is refused');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('F'),
    pg_temp.q_create(pg_temp.p('PF1'), 'After demotion', 'rct_parallel', 'user_confirmed', pg_temp.rq(12))),
  'ERR 42501 evidence_records_not_enabled', 'P6 and so is the next create');
SELECT is(pg_temp.ver(pg_temp.sid('sf')), 1, 'P6 the refused update changed nothing');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('F'), pg_temp.q_delete(pg_temp.sid('sf'), 1, pg_temp.rq(13))),
  '{"status": "deleted"}', 'P6 a former owner can still delete their study (delete is ungated)');
SELECT is(pg_temp.user_rows(pg_temp.u('F')),
  'studies=0 links=0 copies=0 arms=0 outcomes=0 values=0 refs=0 events=0',
  'P6 nothing of the former owner''s study remains, and its paper is free again');

-- P7 — anon reaches none of the six functions.
SELECT ok(pg_temp.call('anon', '', f.q) LIKE 'ERR 42501 permission denied for function %',
  'P7 anon is refused EXECUTE: ' || f.nm)
FROM (VALUES
  ('create',   pg_temp.q_create(pg_temp.p('PO2'), 'Anon', 'rct_parallel', 'user_confirmed', pg_temp.rq(14))),
  ('update',   pg_temp.q_update(pg_temp.s('SB1'), 1, 'Anon', 'rct_parallel', NULL, pg_temp.rq(14))),
  ('set_link', pg_temp.q_link(pg_temp.s('SB1'), pg_temp.p('PB1'), 'confirm', 1, pg_temp.rq(14))),
  ('delete',   pg_temp.q_delete(pg_temp.s('SB1'), 1, pg_temp.rq(14))),
  ('gate',     'SELECT public.evidence_records_assert_writable()::text'),
  ('normalize', 'SELECT public.evidence_normalize_v1(''x'')')
) AS f(nm, q);

-- P8 — an authenticated role without a subject.
SELECT is(pg_temp.call('authenticated', '{"role":"authenticated"}', f.q), 'ERR 42501 evidence_auth_required',
  'P8 no sub claim: ' || f.nm || ' is refused')
FROM (VALUES
  ('create',   pg_temp.q_create(pg_temp.p('PO2'), 'No sub', 'rct_parallel', 'user_confirmed', pg_temp.rq(15))),
  ('update',   pg_temp.q_update(pg_temp.s('SB1'), 1, 'No sub', 'rct_parallel', NULL, pg_temp.rq(15))),
  ('set_link', pg_temp.q_link(pg_temp.s('SB1'), pg_temp.p('PB1'), 'confirm', 1, pg_temp.rq(15))),
  ('delete',   pg_temp.q_delete(pg_temp.s('SB1'), 1, pg_temp.rq(15)))
) AS f(nm, q);

-- P9 — service_role reaches none of the six functions (C57).
SELECT ok(pg_temp.call('service_role', '', f.q) LIKE 'ERR 42501 permission denied for function %',
  'P9 service_role is refused EXECUTE: ' || f.nm)
FROM (VALUES
  ('create',   pg_temp.q_create(pg_temp.p('PO2'), 'Service', 'rct_parallel', 'user_confirmed', pg_temp.rq(16))),
  ('update',   pg_temp.q_update(pg_temp.s('SB1'), 1, 'Service', 'rct_parallel', NULL, pg_temp.rq(16))),
  ('set_link', pg_temp.q_link(pg_temp.s('SB1'), pg_temp.p('PB1'), 'confirm', 1, pg_temp.rq(16))),
  ('delete',   pg_temp.q_delete(pg_temp.s('SB1'), 1, pg_temp.rq(16))),
  ('gate',     'SELECT public.evidence_records_assert_writable()::text'),
  ('normalize', 'SELECT public.evidence_normalize_v1(''x'')')
) AS f(nm, q);

-- P13 — the two helpers are internal: not even the owner's browser session
-- can call them.
SELECT ok(pg_temp.call('authenticated', pg_temp.claims('O'), f.q) LIKE 'ERR 42501 permission denied for function %',
  'P13 authenticated cannot execute ' || f.nm)
FROM (VALUES
  ('evidence_records_assert_writable', 'SELECT public.evidence_records_assert_writable()::text'),
  ('evidence_normalize_v1',            'SELECT public.evidence_normalize_v1(''x'')')
) AS f(nm, q);

-- The helper's own decision, called by its owner as a DEFINER RPC would.
SELECT is(pg_temp.call('postgres', f.claims, 'SELECT ''passed'' FROM public.evidence_records_assert_writable()'),
  f.expected, 'P1-P8 the gate itself answers ' || f.expected || ' for ' || f.nm)
FROM (VALUES
  ('the owner',          pg_temp.claims('O'),          'passed'),
  ('a manager',          pg_temp.claims('M'),          'ERR 42501 evidence_records_not_enabled'),
  ('an ordinary user',   pg_temp.claims('U'),          'ERR 42501 evidence_records_not_enabled'),
  ('no subject',         '{"role":"authenticated"}',   'ERR 42501 evidence_auth_required')
) AS f(nm, claims, expected);

-- P10-P12 — someone else's ids answer exactly like ids that do not exist.
INSERT INTO res VALUES ('dig_b', pg_temp.digest(pg_temp.u('B')));
INSERT INTO res VALUES ('o_studies', (SELECT count(*)::text FROM public.evidence_studies WHERE user_id = pg_temp.u('O')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), f.q), f.expected, 'P10-P12 ' || f.nm)
FROM (VALUES
  ('update of a foreign study',      pg_temp.q_update(pg_temp.s('SB1'), 1, 'Hijack', 'rct_parallel', NULL, pg_temp.rq(17)),       'ERR P0002 evidence_not_found'),
  ('update of an unknown study',     pg_temp.q_update(pg_temp.s('unknown'), 1, 'Hijack', 'rct_parallel', NULL, pg_temp.rq(18)),   'ERR P0002 evidence_not_found'),
  ('set_link on a foreign study',    pg_temp.q_link(pg_temp.s('SB1'), pg_temp.p('PB1'), 'mark_provisional', 1, pg_temp.rq(19)),   'ERR P0002 evidence_not_found'),
  ('set_link on an unknown study',   pg_temp.q_link(pg_temp.s('unknown'), pg_temp.p('PB1'), 'mark_provisional', 1, pg_temp.rq(20)), 'ERR P0002 evidence_not_found'),
  ('delete of a foreign study',      pg_temp.q_delete(pg_temp.s('SB1'), 1, pg_temp.rq(21)),                                          '{"status": "already_absent"}'),
  ('delete of an unknown study',     pg_temp.q_delete(pg_temp.s('unknown'), 1, pg_temp.rq(22)),                                      '{"status": "already_absent"}'),
  ('create from a foreign paper',    pg_temp.q_create(pg_temp.p('PB1'), 'Hijack', 'rct_parallel', 'user_confirmed', pg_temp.rq(23)),  'ERR P0002 evidence_paper_not_found'),
  ('create from an unknown paper',   pg_temp.q_create(pg_temp.p('unknown'), 'Hijack', 'rct_parallel', 'user_confirmed', pg_temp.rq(24)), 'ERR P0002 evidence_paper_not_found')
) AS f(nm, q, expected);
SELECT is(pg_temp.digest(pg_temp.u('B')), pg_temp.kept('dig_b'), 'P10-P12 nothing of the neighbour''s changed');
SELECT is((SELECT count(*)::text FROM public.evidence_studies WHERE user_id = pg_temp.u('O')), pg_temp.kept('o_studies'),
  'P10-P12 the refused calls wrote nothing for the caller either');

-- ═════════════════════════════════════════════════════════════════════════════
-- C. The lifecycle
-- ═════════════════════════════════════════════════════════════════════════════

-- C1-C8 — the study s1 that P1 created from PO1.
SELECT is(
  (SELECT format('%s|%s|%s|%s|%s', s.user_id, s.label, s.design_profile, coalesce(s.notes, '<null>'), s.row_version)
     FROM public.evidence_studies s WHERE s.id = pg_temp.sid('s1')),
  pg_temp.u('O')::text || '|Smith 2024|rct_parallel|<null>|1',
  'C1 the study: the caller''s, with its label and family, no notes, at version 1');
SELECT is(
  (SELECT string_agg(format('%s|%s|%s|%s', r.id = (pg_temp.j('s1') ->> 'link_id')::uuid, r.paper_id, r.link_status, r.link_basis), ';')
     FROM public.evidence_study_reports r WHERE r.study_id = pg_temp.sid('s1')),
  't|' || pg_temp.p('PO1')::text || '|provisional|created_from_paper',
  'C2 exactly one explicit link, to the source paper, with the requested status and basis created_from_paper');
SELECT is(
  (SELECT string_agg(format('%s|%s|%s|%s|%s|%s', c.id = (pg_temp.j('s1') ->> 'snapshot_id')::uuid, c.seq, c.source_kind,
                            convert_to(c.exact_text, 'UTF8') = convert_to(p.abstract, 'UTF8'), c.char_count, c.normalization_version), ';')
     FROM public.evidence_source_snapshots c JOIN public.papers p ON p.id = c.paper_id
    WHERE c.study_id = pg_temp.sid('s1')),
  't|1|library_abstract|t|85|v1',
  'C3 exactly one copy: seq 1, the library abstract byte for byte, 85 characters, normalization v1');
SELECT is(
  (SELECT encode(c.exact_sha256, 'hex') || ' ' || encode(c.normalized_sha256, 'hex')
     FROM public.evidence_source_snapshots c WHERE c.study_id = pg_temp.sid('s1')),
  '568365d7c1bf19abd18d5d580cdf64ffee9300940c943d9ebb3cfdef209fd5b5 1c4959c3b205699d92e1d0a9fa4f4f3c8ffbc4525163aa186bc80ce7eeb635ad',
  'C4 the exact and v1 fingerprints equal values computed outside PostgreSQL');
SELECT is(
  (SELECT public.evidence_normalize_v1(c.exact_text) FROM public.evidence_source_snapshots c WHERE c.study_id = pg_temp.sid('s1')),
  'MARKER031 Adults (n = 120) were randomized - 10' || chr(0x2075) || ' cells per ' || chr(0x03BC)
  || 'L; "double-blind"... caf' || chr(0x00E9) || '.',
  'C5 v1 of the copy is the hand-derived normal form (NFC, spaces, quotes, dashes, ellipsis, micro sign; the superscript kept)');
SELECT is(
  (SELECT string_agg(format('%s.%s %s %s %s', e.study_version, e.ordinal, e.event_type, coalesce(e.op, '-'),
                            e.request_id = pg_temp.rq(1)), ', ' ORDER BY e.study_version, e.ordinal)
     FROM public.evidence_events e WHERE e.study_id = pg_temp.sid('s1')),
  '1.0 request create_study t, 1.1 study_created - t, 1.2 link_created - t, 1.3 source_captured - t',
  'C6 creation wrote one header and three change events, all at version 1 and under the request id');
SELECT is(
  (SELECT encode(e.payload_sha256, 'hex') FROM public.evidence_events e WHERE e.study_id = pg_temp.sid('s1') AND e.ordinal = 0),
  '02713c0aef37c0876ec042fc5d7c7c89a8b71e5efb81be97df16fae3ddbd0b37',
  'C7 the payload fingerprint is SHA-256 of the documented canonical text, computed outside PostgreSQL');
SELECT is(
  jsonb_build_object('link_status', 'provisional', 'design_profile', 'rct_parallel', 'label', 'Smith 2024',
                     'paper_id', pg_temp.p('PO1'), 'op', 'create_study')::text,
  '{"op": "create_study", "label": "Smith 2024", "paper_id": "031000a1-0000-0000-0000-000000000000", "link_status": "provisional", "design_profile": "rct_parallel"}',
  'C7 that canonical text orders its own keys, whatever order they are given in');
SELECT is(
  (SELECT e.result FROM public.evidence_events e WHERE e.study_id = pg_temp.sid('s1') AND e.ordinal = 0),
  pg_temp.j('s1'),
  'C7 the header stores exactly the answer the caller received');
SELECT is(
  (SELECT e.target_id::text || ' ' || e.after::text FROM public.evidence_events e
    WHERE e.study_id = pg_temp.sid('s1') AND e.ordinal = 1),
  pg_temp.sid('s1')::text || ' ' || jsonb_build_object('label', 'Smith 2024', 'design_profile', 'rct_parallel', 'notes', NULL::jsonb)::text,
  'C8 study_created names the study and records its label, family and (absent) notes');
SELECT is(
  (SELECT e.target_id::text || ' ' || e.after::text FROM public.evidence_events e
    WHERE e.study_id = pg_temp.sid('s1') AND e.ordinal = 2),
  (pg_temp.j('s1') ->> 'link_id') || ' '
  || jsonb_build_object('paper_id', pg_temp.p('PO1'), 'link_status', 'provisional', 'link_basis', 'created_from_paper')::text,
  'C8 link_created names the link and records its paper, status and basis');
SELECT is(
  (SELECT e.after FROM public.evidence_events e WHERE e.study_id = pg_temp.sid('s1') AND e.ordinal = 3),
  (SELECT jsonb_build_object('paper_id', c.paper_id, 'seq', 1, 'source_kind', 'library_abstract',
                             'exact_sha256', encode(c.exact_sha256, 'hex'), 'normalized_sha256', encode(c.normalized_sha256, 'hex'),
                             'normalization_version', 'v1', 'char_count', 85, 'previous_snapshot_id', NULL::uuid)
     FROM public.evidence_source_snapshots c WHERE c.study_id = pg_temp.sid('s1')),
  'C8 source_captured records the copy''s fingerprints and length, never its text');

-- C9 — no copy when the paper has no abstract, an empty one, or a blank one.
SELECT is(pg_temp.status(pg_temp.run(f.k, 'authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p(f.paper), f.label, 'non_intervention', 'user_confirmed', pg_temp.rq(f.n)))),
  'applied', 'C9 a study is created from ' || f.nm)
FROM (VALUES ('s_po2', 'PO2', 'No abstract', 32, 'a paper with no abstract'),
             ('s_po3', 'PO3', 'Empty abstract', 33, 'a paper whose abstract is empty'),
             ('s_po4', 'PO4', 'Blank abstract', 34, 'a paper whose abstract holds only white space and invisible format characters')
     ) AS f(k, paper, label, n, nm);
SELECT is(
  (SELECT format('%s|%s|%s', coalesce(pg_temp.j(f.k) ->> 'snapshot_id', '<null>'),
                 (SELECT count(*) FROM public.evidence_source_snapshots c WHERE c.study_id = pg_temp.sid(f.k)),
                 (SELECT string_agg(e.event_type, ',' ORDER BY e.ordinal) FROM public.evidence_events e WHERE e.study_id = pg_temp.sid(f.k)))),
  '<null>|0|request,study_created,link_created',
  'C9 ' || f.nm || ': no copy, and no source_captured event')
FROM (VALUES ('s_po2', 'no abstract'), ('s_po3', 'empty abstract'), ('s_po4', 'blank abstract')) AS f(k, nm);

-- C10 — an abstract over 50,000 characters refuses the whole create.
INSERT INTO res VALUES ('o_rows_c10', pg_temp.user_rows(pg_temp.u('O')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('PO5'), 'Too long', 'rct_parallel', 'user_confirmed', pg_temp.rq(35))),
  'ERR P0001 evidence_abstract_too_long', 'C10 an abstract of 50,001 characters refuses the create');
SELECT is(pg_temp.user_rows(pg_temp.u('O')), pg_temp.kept('o_rows_c10'), 'C10 and nothing was written');

-- C11 — exactly 50,000 characters is captured.
SELECT is(pg_temp.status(pg_temp.run('s_po6', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('PO6'), 'Longest', 'rct_parallel', 'user_confirmed', pg_temp.rq(36)))),
  'applied', 'C11 an abstract of exactly 50,000 characters is accepted');
SELECT is(
  (SELECT format('%s|%s', c.char_count, c.exact_sha256 = c.normalized_sha256)
     FROM public.evidence_source_snapshots c WHERE c.study_id = pg_temp.sid('s_po6')),
  '50000|t', 'C11 its copy holds all 50,000 characters (ASCII without spacing changes: both fingerprints equal)');

-- C12 — one paper, several studies; each link keeps its own copy.
SELECT is(pg_temp.status(pg_temp.run('s2', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('PO1'), 'Smith 2024, study 2', 'intervention_other', 'user_confirmed', pg_temp.rq(37)))),
  'applied', 'C12 a second study from the same paper is created');
SELECT is(
  (SELECT format('%s|%s|%s|%s', count(DISTINCT r.study_id), count(DISTINCT c.id),
                 count(DISTINCT c.exact_sha256), bool_and(r.study_id IN (pg_temp.sid('s1'), pg_temp.sid('s2'))))
     FROM public.evidence_study_reports r
     JOIN public.evidence_source_snapshots c ON c.study_id = r.study_id AND c.paper_id = r.paper_id
    WHERE r.paper_id = pg_temp.p('PO1')),
  '2|2|1|t', 'C12 the paper now reports two separate studies, each with its own copy of the same text');

-- C13 — strict input validation; nothing is written for a refused call.
INSERT INTO res VALUES ('o_rows_c13', pg_temp.user_rows(pg_temp.u('O')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), f.q), f.expected, 'C13 create refuses ' || f.nm)
FROM (VALUES
  ('a NULL paper',              pg_temp.q_create(NULL, 'Label', 'rct_parallel', 'user_confirmed', pg_temp.rq(38)),                      'ERR 22023 evidence_invalid_input [p_paper_id]'),
  ('a NULL label',              pg_temp.q_create(pg_temp.p('PO2'), NULL, 'rct_parallel', 'user_confirmed', pg_temp.rq(38)),           'ERR 22023 evidence_invalid_input [p_label]'),
  ('an empty label',            pg_temp.q_create(pg_temp.p('PO2'), '', 'rct_parallel', 'user_confirmed', pg_temp.rq(38)),             'ERR 22023 evidence_invalid_input [p_label]'),
  ('a label of spaces',         pg_temp.q_create(pg_temp.p('PO2'), '   ', 'rct_parallel', 'user_confirmed', pg_temp.rq(38)),          'ERR 22023 evidence_invalid_input [p_label]'),
  ('a label of invisible characters',
                                pg_temp.q_create(pg_temp.p('PO2'), chr(0x00A0) || chr(0x200B) || chr(0x3000) || chr(0x0009), 'rct_parallel', 'user_confirmed', pg_temp.rq(38)),
                                                                                                                                      'ERR 22023 evidence_invalid_input [p_label]'),
  ('a 121-character label',     pg_temp.q_create(pg_temp.p('PO2'), repeat('L', 121), 'rct_parallel', 'user_confirmed', pg_temp.rq(38)), 'ERR 22023 evidence_invalid_input [p_label]'),
  ('an unknown design family',  pg_temp.q_create(pg_temp.p('PO2'), 'Label', 'rct', 'user_confirmed', pg_temp.rq(38)),                 'ERR 22023 evidence_invalid_input [p_design_profile]'),
  ('a NULL design family',      pg_temp.q_create(pg_temp.p('PO2'), 'Label', NULL, 'user_confirmed', pg_temp.rq(38)),                  'ERR 22023 evidence_invalid_input [p_design_profile]'),
  ('an unknown link status',    pg_temp.q_create(pg_temp.p('PO2'), 'Label', 'rct_parallel', 'confirmed', pg_temp.rq(38)),             'ERR 22023 evidence_invalid_input [p_link_status]'),
  ('a NULL link status',        pg_temp.q_create(pg_temp.p('PO2'), 'Label', 'rct_parallel', NULL, pg_temp.rq(38)),                    'ERR 22023 evidence_invalid_input [p_link_status]'),
  ('a NULL request id',         pg_temp.q_create(pg_temp.p('PO2'), 'Label', 'rct_parallel', 'user_confirmed', NULL),                  'ERR 22023 evidence_invalid_input [p_request_id]')
) AS f(nm, q, expected);
SELECT is(pg_temp.user_rows(pg_temp.u('O')), pg_temp.kept('o_rows_c13'), 'C13 none of the refused creates wrote anything');
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('PO2'), repeat('L', 120), 'rct_parallel', 'user_confirmed', pg_temp.rq(39)))),
  'applied', 'C13 a 120-character label is accepted');

-- C14-C17 — update s1 (version 1).
SELECT is(pg_temp.status(pg_temp.run('u1', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('s1'), 1, 'Smith 2024a', 'intervention_other', 'Notes v1.', pg_temp.rq(40)))),
  'applied', 'C14 the owner updates label, family and notes at the expected version');
SELECT is(pg_temp.j('u1'), jsonb_build_object('status', 'applied', 'study_id', pg_temp.sid('s1'), 'study_version', 2),
  'C14 the answer is the new version, 2');
SELECT is(
  (SELECT format('%s|%s|%s|%s', s.label, s.design_profile, s.notes, s.row_version) FROM public.evidence_studies s WHERE s.id = pg_temp.sid('s1')),
  'Smith 2024a|intervention_other|Notes v1.|2', 'C14 the study row holds the new values at version 2');
SELECT is(
  (SELECT e.before::text || ' -> ' || e.after::text FROM public.evidence_events e
    WHERE e.study_id = pg_temp.sid('s1') AND e.study_version = 2 AND e.ordinal = 1 AND e.event_type = 'study_updated'),
  jsonb_build_object('label', 'Smith 2024', 'design_profile', 'rct_parallel', 'notes', NULL::jsonb)::text || ' -> '
  || jsonb_build_object('label', 'Smith 2024a', 'design_profile', 'intervention_other',
                        'notes', jsonb_build_object('sha256', encode(sha256(convert_to('Notes v1.', 'UTF8')), 'hex'), 'chars', 9))::text,
  'C14 study_updated records each changed field; notes as {sha256, chars}, never as text');

SELECT is(pg_temp.status(pg_temp.run('u2', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('s1'), 2, 'Smith 2024a', 'intervention_other', 'Notes, second version.', pg_temp.rq(41)))),
  'applied', 'C15 a notes-only update is applied');
SELECT is(
  (SELECT string_agg(k, ',') FROM jsonb_object_keys((SELECT e.after FROM public.evidence_events e
     WHERE e.study_id = pg_temp.sid('s1') AND e.study_version = 3 AND e.ordinal = 1)) k),
  'notes', 'C15 its event records the notes alone');

INSERT INTO res VALUES ('s1_events_c16', (SELECT count(*)::text FROM public.evidence_events WHERE study_id = pg_temp.sid('s1')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('s1'), 3, 'Smith 2024a', 'intervention_other', 'Notes, second version.', pg_temp.rq(42))),
  jsonb_build_object('status', 'unchanged', 'study_id', pg_temp.sid('s1'), 'study_version', 3)::text,
  'C16 an update that changes nothing answers unchanged, at the current version');
SELECT is((SELECT count(*)::text FROM public.evidence_events WHERE study_id = pg_temp.sid('s1')), pg_temp.kept('s1_events_c16'),
  'C16 and writes no header or event');
SELECT is((SELECT count(*)::int FROM public.evidence_events WHERE request_id = pg_temp.rq(42)), 0,
  'C16 its request id is not consumed');

INSERT INTO res VALUES ('dig_o_c17', pg_temp.digest(pg_temp.u('O')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('s1'), 2, 'Stale', 'rct_parallel', NULL, pg_temp.rq(43))),
  'ERR P0001 evidence_version_conflict', 'C17 an update at a stale version is refused');
SELECT is(pg_temp.digest(pg_temp.u('O')), pg_temp.kept('dig_o_c17'), 'C17 and changes nothing');

-- C18 — update validation.
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), f.q), f.expected, 'C18 update refuses ' || f.nm)
FROM (VALUES
  ('a NULL study',               pg_temp.q_update(NULL, 3, 'L', 'rct_parallel', NULL, pg_temp.rq(44)),                          'ERR 22023 evidence_invalid_input [p_study_id]'),
  ('a NULL expected version',    pg_temp.q_update(pg_temp.sid('s1'), NULL, 'L', 'rct_parallel', NULL, pg_temp.rq(44)),        'ERR 22023 evidence_invalid_input [p_expected_version]'),
  ('expected version 0',         pg_temp.q_update(pg_temp.sid('s1'), 0, 'L', 'rct_parallel', NULL, pg_temp.rq(44)),           'ERR 22023 evidence_invalid_input [p_expected_version]'),
  ('a blank label',              pg_temp.q_update(pg_temp.sid('s1'), 3, ' ', 'rct_parallel', NULL, pg_temp.rq(44)),           'ERR 22023 evidence_invalid_input [p_label]'),
  ('an unknown design family',   pg_temp.q_update(pg_temp.sid('s1'), 3, 'L', 'cohort', NULL, pg_temp.rq(44)),                 'ERR 22023 evidence_invalid_input [p_design_profile]'),
  ('empty notes (absent is NULL)', pg_temp.q_update(pg_temp.sid('s1'), 3, 'L', 'rct_parallel', '', pg_temp.rq(44)),           'ERR 22023 evidence_invalid_input [p_notes]'),
  ('blank notes',                pg_temp.q_update(pg_temp.sid('s1'), 3, 'L', 'rct_parallel', chr(0x00A0) || ' ', pg_temp.rq(44)), 'ERR 22023 evidence_invalid_input [p_notes]'),
  ('10,001-character notes',     pg_temp.q_update(pg_temp.sid('s1'), 3, 'L', 'rct_parallel', repeat('n', 10001), pg_temp.rq(44)), 'ERR 22023 evidence_invalid_input [p_notes]'),
  ('a NULL request id',          pg_temp.q_update(pg_temp.sid('s1'), 3, 'L', 'rct_parallel', NULL, NULL),                     'ERR 22023 evidence_invalid_input [p_request_id]')
) AS f(nm, q, expected);

-- C19 — the design-family rule: no move to non_intervention while a group or
-- a number randomized exists, since that family shows neither.
SELECT is(pg_temp.status(pg_temp.run('sp', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('POB'), 'Family study', 'rct_parallel', 'user_confirmed', pg_temp.rq(45)))),
  'applied', 'C19 a study for the family rules is created');
INSERT INTO public.evidence_arms (id, user_id, study_id, arm_role, display_label, position)
VALUES ('031a0001-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('sp'), 'intervention', 'Exercise', 0);
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('sp'), 1, 'Family study', 'non_intervention', NULL, pg_temp.rq(46))),
  'ERR P0001 evidence_profile_change_blocked', 'C19 a study with a group cannot become non_intervention');
DELETE FROM public.evidence_arms WHERE id = '031a0001-0000-0000-0000-000000000000';
INSERT INTO public.evidence_field_values (id, user_id, study_id, field_key, value_state)
VALUES ('031b0001-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('sp'), 'n_randomized', 'not_reported');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('sp'), 1, 'Family study', 'non_intervention', NULL, pg_temp.rq(47))),
  'ERR P0001 evidence_profile_change_blocked', 'C19 nor one holding any n_randomized value (here an explicit not_reported)');
DELETE FROM public.evidence_field_values WHERE id = '031b0001-0000-0000-0000-000000000000';
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('sp'), 1, 'Family study', 'non_intervention', NULL, pg_temp.rq(48)))),
  'applied', 'C19 once neither exists, the move to non_intervention is applied');
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('sp'), 2, 'Family study', 'rct_parallel', NULL, pg_temp.rq(49)))),
  'applied', 'C19 moving back to an intervention family is always allowed');
INSERT INTO public.evidence_arms (id, user_id, study_id, arm_role, display_label, position)
VALUES ('031a0002-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('sp'), 'comparator', 'Usual care', 0);
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('sp'), 3, 'Family study', 'intervention_other', NULL, pg_temp.rq(50)))),
  'applied', 'C19 and moving between the two intervention families keeps the groups');

-- C20-C22 — link status on s1 (version 3, link to PO1 provisional).
SELECT is(pg_temp.status(pg_temp.run('l1', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p('PO1'), 'confirm', 3, pg_temp.rq(51)))),
  'applied', 'C20 confirm marks the link user_confirmed');
SELECT is(pg_temp.j('l1'),
  jsonb_build_object('status', 'applied', 'study_id', pg_temp.sid('s1'), 'study_version', 4, 'paper_id', pg_temp.p('PO1'),
                     'link_id', (pg_temp.j('s1') ->> 'link_id')::uuid, 'link_status', 'user_confirmed'),
  'C20 the answer names the link, its new status and the new study version');
SELECT is(
  (SELECT format('%s|%s', r.link_status, (SELECT e.before::text || ' -> ' || e.after::text FROM public.evidence_events e
                                             WHERE e.study_id = pg_temp.sid('s1') AND e.study_version = 4 AND e.ordinal = 1))
     FROM public.evidence_study_reports r WHERE r.study_id = pg_temp.sid('s1')),
  'user_confirmed|' || jsonb_build_object('paper_id', pg_temp.p('PO1'), 'link_status', 'provisional')::text || ' -> '
  || jsonb_build_object('paper_id', pg_temp.p('PO1'), 'link_status', 'user_confirmed')::text,
  'C20 the link changed and link_status_changed records before and after');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p('PO1'), 'confirm', 4, pg_temp.rq(52))),
  jsonb_build_object('status', 'unchanged', 'study_id', pg_temp.sid('s1'), 'study_version', 4, 'paper_id', pg_temp.p('PO1'),
                     'link_id', (pg_temp.j('s1') ->> 'link_id')::uuid, 'link_status', 'user_confirmed')::text,
  'C21 confirming a confirmed link answers unchanged and writes nothing');
SELECT is(pg_temp.ver(pg_temp.sid('s1')), 4, 'C21 the version did not move');
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p('PO1'), 'mark_provisional', 4, pg_temp.rq(53)))),
  'applied', 'C22 mark_provisional makes it provisional again (version 5)');

-- C23 — a paper that is not linked to the study: the caller's own, someone
-- else's and an unknown one all read the same.
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p(f.paper), 'confirm', 5, pg_temp.rq(54))),
  'ERR P0002 evidence_link_not_found', 'C23 set_link with ' || f.nm || ' finds no link')
FROM (VALUES ('PO7', 'the caller''s own unlinked paper'), ('PB1', 'someone else''s paper'), ('unknown', 'an unknown paper')) AS f(paper, nm);

-- C24 — the last link of a study is never removed: delete the study instead.
INSERT INTO res VALUES ('dig_o_c24', pg_temp.digest(pg_temp.u('O')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p('PO1'), 'remove', 5, pg_temp.rq(55))),
  'ERR P0001 evidence_last_link', 'C24 removing a study''s only link is refused');
SELECT is(pg_temp.digest(pg_temp.u('O')), pg_temp.kept('dig_o_c24'), 'C24 and changes nothing');

-- C25-C27 — a second report (planted: user_linked is the linking phase's), its
-- copy, and a reference that uses it.
INSERT INTO public.evidence_study_reports (id, user_id, study_id, paper_id, link_status, link_basis)
VALUES ('031c0007-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), pg_temp.p('PO7'), 'provisional', 'user_linked');
SELECT pg_temp.plant_copy('031d0007-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), pg_temp.p('PO7'), 1,
                          'Second report abstract.');
INSERT INTO public.evidence_field_values (id, user_id, study_id, field_key, value_state)
VALUES ('031b0002-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), 'demographics', 'not_reported');
INSERT INTO public.evidence_field_anchors (id, user_id, study_id, value_id, paper_id, snapshot_id, purpose, source_kind)
VALUES ('031e0001-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), '031b0002-0000-0000-0000-000000000000',
        pg_temp.p('PO7'), '031d0007-0000-0000-0000-000000000000', 'examined', 'abstract');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p('PO7'), 'remove', 5, pg_temp.rq(56))),
  'ERR P0001 evidence_link_in_use', 'C25 a link a source reference uses cannot be removed');
DELETE FROM public.evidence_field_anchors WHERE id = '031e0001-0000-0000-0000-000000000000';
SELECT is(pg_temp.status(pg_temp.run('l_rm', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p('PO7'), 'remove', 5, pg_temp.rq(57)))),
  'applied', 'C26 once no reference uses it, the second link is removed (version 6)');
SELECT is(
  (SELECT format('%s|%s|%s',
            (SELECT count(*) FROM public.evidence_study_reports WHERE study_id = pg_temp.sid('s1') AND paper_id = pg_temp.p('PO7')),
            (SELECT count(*) FROM public.evidence_source_snapshots WHERE id = '031d0007-0000-0000-0000-000000000000'),
            (SELECT string_agg(r.paper_id::text || ':' || r.link_status, ',') FROM public.evidence_study_reports r WHERE r.study_id = pg_temp.sid('s1')))),
  '0|0|' || pg_temp.p('PO1')::text || ':provisional',
  'C26 the link and its copy are gone; the study keeps its other link');
SELECT is(
  (SELECT e.event_type || ' ' || e.target_id::text || ' ' || e.before::text || ' ' || coalesce(e.after::text, '<null>')
     FROM public.evidence_events e WHERE e.study_id = pg_temp.sid('s1') AND e.study_version = 6 AND e.ordinal = 1),
  'link_removed 031c0007-0000-0000-0000-000000000000 '
  || jsonb_build_object('paper_id', pg_temp.p('PO7'), 'link_status', 'provisional', 'link_basis', 'user_linked',
                        'snapshot_ids', jsonb_build_array('031d0007-0000-0000-0000-000000000000'))::text || ' <null>',
  'C26 link_removed records the link and lists the copies removed with it');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    'SELECT deleted_count || ''/'' || queued_count FROM public.delete_papers_with_attachment_cleanup(ARRAY[''' || pg_temp.p('PO7')::text || ''']::uuid[])'),
  '1/0', 'C27 the unlinked paper can now be deleted through the existing RPC');
SELECT is((SELECT count(*)::int FROM public.papers WHERE id = pg_temp.p('PO7')), 0, 'C27 and it is gone');

-- C28 — set_link validation.
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), f.q), f.expected, 'C28 set_link refuses ' || f.nm)
FROM (VALUES
  ('an unknown action',         pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p('PO1'), 'add', 6, pg_temp.rq(58)),        'ERR 22023 evidence_invalid_input [p_action]'),
  ('a NULL action',             pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p('PO1'), NULL, 6, pg_temp.rq(58)),         'ERR 22023 evidence_invalid_input [p_action]'),
  ('a NULL paper',              pg_temp.q_link(pg_temp.sid('s1'), NULL, 'confirm', 6, pg_temp.rq(58)),                'ERR 22023 evidence_invalid_input [p_paper_id]'),
  ('a NULL study',              pg_temp.q_link(NULL, pg_temp.p('PO1'), 'confirm', 6, pg_temp.rq(58)),                 'ERR 22023 evidence_invalid_input [p_study_id]'),
  ('expected version 0',        pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p('PO1'), 'confirm', 0, pg_temp.rq(58)),   'ERR 22023 evidence_invalid_input [p_expected_version]'),
  ('a NULL request id',         pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p('PO1'), 'confirm', 6, NULL),              'ERR 22023 evidence_invalid_input [p_request_id]'),
  ('a stale version',           pg_temp.q_link(pg_temp.sid('s1'), pg_temp.p('PO1'), 'confirm', 5, pg_temp.rq(58)),   'ERR P0001 evidence_version_conflict')
) AS f(nm, q, expected);

-- C29-C32 — deletion of a fully populated study. Planted: a group, an outcome,
-- values at all three scopes, a superseded copy (seq 2) next to the current
-- one, and references of every purpose — two of them on the copies (NO ACTION
-- edges 2 and 3).
INSERT INTO public.evidence_arms (id, user_id, study_id, arm_role, display_label, position)
VALUES ('031a0003-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), 'intervention', 'Metformin', 0);
INSERT INTO public.evidence_outcomes (id, user_id, study_id, display_label, position)
VALUES ('031f0003-0000-0000-0000-0000000000aa', pg_temp.u('O'), pg_temp.sid('s1'), 'HbA1c', 0);
INSERT INTO public.evidence_field_values (id, user_id, study_id, arm_id, outcome_id, field_key, value_state, value_text, value_list) VALUES
  ('031b0003-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), NULL, NULL, 'condition', 'reported', 'Type 2 diabetes', NULL),
  ('031b0004-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), '031a0003-0000-0000-0000-000000000000', NULL, 'description', 'reported', 'Metformin 1 g', NULL),
  ('031b0005-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), NULL, '031f0003-0000-0000-0000-0000000000aa', 'time_points', 'reported', NULL, ARRAY['12 weeks']);
SELECT pg_temp.plant_copy('031d0002-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), pg_temp.p('PO1'), 2,
                          'A later edition of the abstract.');
INSERT INTO public.evidence_field_anchors
  (id, user_id, study_id, value_id, paper_id, snapshot_id, purpose, source_kind, position,
   quote_text, match_start, match_end, match_occurrence, match_count, normalization_version, matched_at, locator_kind, locator_text) VALUES
  ('031e0002-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), '031b0003-0000-0000-0000-000000000000', pg_temp.p('PO1'),
   (pg_temp.j('s1') ->> 'snapshot_id')::uuid, 'supports', 'abstract', 0, 'Adults', 10, 16, 1, 1, 'v1', now(), NULL, NULL),
  ('031e0003-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), '031b0003-0000-0000-0000-000000000000', pg_temp.p('PO1'),
   NULL, 'supports', 'full_text', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'table', 'Table 2'),
  ('031e0004-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), '031b0004-0000-0000-0000-000000000000', pg_temp.p('PO1'),
   '031d0002-0000-0000-0000-000000000000', 'examined', 'abstract', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('031e0005-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), '031b0005-0000-0000-0000-000000000000', pg_temp.p('PO1'),
   NULL, 'unavailable', 'full_text', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
SELECT is(pg_temp.study_rows(pg_temp.sid('s1')),
  'studies=1 links=1 copies=2 arms=1 outcomes=1 values=4 refs=4 events=14',
  'C29 before: the study holds a row in every evidence table');
INSERT INTO res VALUES ('dig_o_c30', pg_temp.digest(pg_temp.u('O')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), pg_temp.q_delete(pg_temp.sid('s1'), 5, pg_temp.rq(59))),
  'ERR P0001 evidence_version_conflict', 'C30 deleting at a stale version is refused');
SELECT is(pg_temp.digest(pg_temp.u('O')), pg_temp.kept('dig_o_c30'), 'C30 and removes nothing');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), pg_temp.q_delete(pg_temp.sid('s1'), 6, pg_temp.rq(60))),
  '{"status": "deleted"}', 'C31 deleting at the current version answers deleted');
SELECT is(pg_temp.study_rows(pg_temp.sid('s1')),
  'studies=0 links=0 copies=0 arms=0 outcomes=0 values=0 refs=0 events=0',
  'C31 nothing of the study remains in any table, history and request headers included');
SELECT is(
  (SELECT format('%s|%s|%s', pg_temp.study_rows(pg_temp.sid('s2')),
                 (SELECT count(*) FROM public.papers WHERE id = pg_temp.p('PO1')),
                 (SELECT count(*) FROM public.evidence_study_reports WHERE paper_id = pg_temp.p('PO1')))),
  'studies=1 links=1 copies=1 arms=0 outcomes=0 values=0 refs=0 events=4|1|1',
  'C31 the other study of the same paper, and the paper, are untouched');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), pg_temp.q_delete(pg_temp.sid('s1'), 6, pg_temp.rq(61))),
  '{"status": "already_absent"}', 'C32 deleting it again answers already_absent');

-- ═════════════════════════════════════════════════════════════════════════════
-- D. Request idempotency, in sequence (FK-PROOF-001 I-1)
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.status(pg_temp.run('d1', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('POC'), 'Idempotent', 'rct_parallel', 'provisional', pg_temp.rq(64)))),
  'applied', 'D1 a create is applied');
INSERT INTO res VALUES ('d_counts', pg_temp.user_rows(pg_temp.u('O')));
INSERT INTO res VALUES ('d_v1', (SELECT md5(string_agg(e::text, '|' ORDER BY e.ordinal)) FROM public.evidence_events e
                                  WHERE e.study_id = pg_temp.sid('d1') AND e.study_version = 1));
SELECT is(pg_temp.status(pg_temp.run('d1r', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('POC'), 'Idempotent', 'rct_parallel', 'provisional', pg_temp.rq(64)))),
  'replayed', 'D1 retrying it with the same id and body (a lost response) replays it');
SELECT is(pg_temp.j('d1r') - 'status', pg_temp.j('d1') - 'status',
  'D1 the replay returns the original study, version, link and copy');
SELECT is(pg_temp.user_rows(pg_temp.u('O')), pg_temp.kept('d_counts'), 'D1 the replay wrote no row, not even a header');

SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('d1'), 1, 'Idempotent 2', 'rct_parallel', NULL, pg_temp.rq(65)))),
  'applied', 'D2 an update moves it to version 2');
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_link(pg_temp.sid('d1'), pg_temp.p('POC'), 'confirm', 2, pg_temp.rq(66)))),
  'applied', 'D2 a link change moves it to version 3');
SELECT is(pg_temp.field(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('POC'), 'Idempotent', 'rct_parallel', 'provisional', pg_temp.rq(64))), 'study_version'),
  '1', 'D2 after later writes, the create still replays its ORIGINAL result (version 1)');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('d1'), 1, 'Idempotent 2', 'rct_parallel', NULL, pg_temp.rq(65))),
  jsonb_build_object('status', 'replayed', 'study_id', pg_temp.sid('d1'), 'study_version', 2)::text,
  'D2 and so does the update (version 2), although the study is now at version 3');
SELECT is(pg_temp.ver(pg_temp.sid('d1')), 3, 'D2 the replays changed nothing');

INSERT INTO res VALUES ('d_events_before_refusals', (SELECT count(*)::text FROM public.evidence_events WHERE user_id = pg_temp.u('O')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), f.q), 'ERR P0001 evidence_request_id_reused', 'D3 ' || f.nm)
FROM (VALUES
  ('a create id reused with another label',     pg_temp.q_create(pg_temp.p('POC'), 'Another label', 'rct_parallel', 'provisional', pg_temp.rq(64))),
  ('a create id reused for another paper',      pg_temp.q_create(pg_temp.p('PO2'), 'Idempotent', 'rct_parallel', 'provisional', pg_temp.rq(64))),
  ('an update id reused with other notes',      pg_temp.q_update(pg_temp.sid('d1'), 1, 'Idempotent 2', 'rct_parallel', 'Different', pg_temp.rq(65))),
  ('a create id reused for an update',          pg_temp.q_update(pg_temp.sid('d1'), 3, 'Idempotent 3', 'rct_parallel', NULL, pg_temp.rq(64))),
  ('an update id reused for a link change',     pg_temp.q_link(pg_temp.sid('d1'), pg_temp.p('POC'), 'mark_provisional', 3, pg_temp.rq(65))),
  ('a link id reused for a create',             pg_temp.q_create(pg_temp.p('POC'), 'Idempotent', 'rct_parallel', 'provisional', pg_temp.rq(66)))
) AS f(nm, q);

-- D4 — two requests prepared against the same version: the first wins.
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('d1'), 3, 'First writer', 'rct_parallel', NULL, pg_temp.rq(67)))),
  'applied', 'D4 the first of two requests at version 3 is applied');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('d1'), 3, 'Second writer', 'rct_parallel', NULL, pg_temp.rq(68))),
  'ERR P0001 evidence_version_conflict', 'D4 the second, with another request id, gets a version conflict');
SELECT is((SELECT count(*)::text FROM public.evidence_events WHERE user_id = pg_temp.u('O')),
  ((pg_temp.kept('d_events_before_refusals'))::int + 2)::text,
  'D3/D4 the refused requests appended nothing (only the first writer''s header and event)');
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('d1'), 4, 'Second writer', 'rct_parallel', NULL, pg_temp.rq(68)))),
  'applied', 'D4 the conflict consumed nothing: the same id, reloaded at version 4, is applied');

-- D5 — an attempt that ran but never committed, then its retry.
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('POC'), 'Rolled back', 'rct_parallel', 'provisional', pg_temp.rq(69)),
    'SELECT count(*)::text FROM public.evidence_events WHERE request_id = ''' || pg_temp.rq(69)::text || ''''),
  '00000 4', 'D5 inside its transaction the attempt wrote its header and events');
SELECT is((SELECT count(*)::int FROM public.evidence_events WHERE request_id = pg_temp.rq(69))
          + (SELECT count(*)::int FROM public.evidence_studies WHERE label = 'Rolled back'),
  0, 'D5 after the rollback nothing of it remains');
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('POC'), 'Rolled back', 'rct_parallel', 'provisional', pg_temp.rq(69)))),
  'applied', 'D5 so its retry is applied afresh, not replayed');

-- D6 — the documented residual: a request id lives only as long as its study.
SELECT is(pg_temp.status(pg_temp.run('d6', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('POC'), 'Doomed', 'rct_parallel', 'provisional', pg_temp.rq(70)))),
  'applied', 'D6 a create is applied');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), pg_temp.q_delete(pg_temp.sid('d6'), 1, pg_temp.rq(71))),
  '{"status": "deleted"}', 'D6 its study is deleted, history and header included');
SELECT is(pg_temp.status(pg_temp.run('d6r', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('POC'), 'Doomed', 'rct_parallel', 'provisional', pg_temp.rq(70)))),
  'applied', 'D6 a stale retry of that create is therefore applied again (bounded by the study''s lifetime)');
SELECT isnt(pg_temp.sid('d6r'), pg_temp.sid('d6'), 'D6 and makes a new study, not the deleted one');

-- D7 — a no-op consumes nothing.
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('d1'), 5, 'Second writer', 'rct_parallel', NULL, pg_temp.rq(72)))),
  'unchanged', 'D7 a no-op answers unchanged');
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_update(pg_temp.sid('d1'), 5, 'After the no-op', 'rct_parallel', NULL, pg_temp.rq(72)))),
  'applied', 'D7 so the same request id can still carry a real change');

-- D8 — request ids belong to their user: the neighbour's header is invisible.
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('POC'), 'Shared request id', 'rct_parallel', 'provisional', '031fbbbb-0000-0000-0000-000000000000'))),
  'applied', 'D8 a request id another user already committed neither replays nor collides');

-- ═════════════════════════════════════════════════════════════════════════════
-- E. History integrity
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT md5(string_agg(e::text, '|' ORDER BY e.ordinal)) FROM public.evidence_events e
    WHERE e.study_id = pg_temp.sid('d1') AND e.study_version = 1),
  pg_temp.kept('d_v1'),
  'E1 version 1 of the study is byte-identical after four later writes and every replay');
SELECT is(
  (SELECT count(*)::int FROM (SELECT e.user_id, e.request_id FROM public.evidence_events e WHERE e.ordinal = 0
                               GROUP BY e.user_id, e.request_id HAVING count(*) > 1) d),
  0, 'E2 no user has two headers for one request id');
SELECT is(
  (SELECT coalesce(string_agg(DISTINCT s.label, ', '), '')
     FROM public.evidence_studies s
    WHERE s.user_id = pg_temp.u('O')
      AND (   ARRAY(SELECT DISTINCT e.study_version FROM public.evidence_events e WHERE e.study_id = s.id ORDER BY 1)
                IS DISTINCT FROM ARRAY(SELECT generate_series(1, s.row_version))
           OR EXISTS (SELECT 1 FROM public.evidence_events e WHERE e.study_id = s.id
                       GROUP BY e.study_version
                      HAVING count(*) FILTER (WHERE e.ordinal = 0 AND e.event_type = 'request') <> 1
                          OR min(e.ordinal) <> 0 OR max(e.ordinal) <> count(*) - 1))),
  '', 'E3 every study of the owner has versions 1..row_version, one header per version, and gap-free ordinals');
SELECT is(
  (SELECT count(*)::int FROM public.evidence_events e
    WHERE e.ordinal > 0 AND e.user_id = pg_temp.u('O')
      AND NOT EXISTS (SELECT 1 FROM public.evidence_events h
                       WHERE h.user_id = e.user_id AND h.study_id = e.study_id AND h.study_version = e.study_version
                         AND h.ordinal = 0 AND h.request_id = e.request_id)),
  0, 'E3 every change event carries the request id of its version''s header');
SELECT is(
  (SELECT count(*)::int FROM public.evidence_events e
     JOIN public.evidence_source_snapshots c ON c.user_id = e.user_id
    WHERE position(c.exact_text IN coalesce(e.before::text, '') || coalesce(e.after::text, '')
                                    || coalesce(e.result::text, '') || coalesce(e.note, '')) > 0),
  0, 'E4 no event holds the text of any copy of its user');
SELECT is(
  (SELECT count(*)::int FROM public.evidence_events e
    WHERE (coalesce(e.before::text, '') || coalesce(e.after::text, '') || coalesce(e.result::text, '') || coalesce(e.note, ''))
          ~ '(MARKER031|Notes v1\.|Notes, second version\.)'),
  0, 'E4 neither the abstract marker nor any notes text appears in history');
SELECT is(
  (SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '') FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND pg_temp.code(p.oid::regprocedure) ~* 'update[[:space:]]+(only[[:space:]]+)?(public\.)?evidence_events'),
  '', 'E5 no public function updates evidence_events');
SELECT is(
  (SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '') FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND pg_temp.code(p.oid::regprocedure) ~* 'delete[[:space:]]+from[[:space:]]+(only[[:space:]]+)?(public\.)?evidence_events'),
  'evidence_delete_study', 'E5 only evidence_delete_study deletes from evidence_events');
SELECT is(
  (SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '') FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND pg_temp.code(p.oid::regprocedure) ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?evidence_events'),
  'evidence_create_study_from_paper,evidence_set_link,evidence_update_study',
  'E5 exactly the three gated RPCs append history');
SELECT is(
  (SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '') FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND pg_temp.code(p.oid::regprocedure) ~* '(update[[:space:]]+(only[[:space:]]+)?(public\.)?evidence_source_snapshots|truncate[^;]*evidence_)'),
  '', 'E5 no public function updates a copy or truncates an evidence table');

-- ═════════════════════════════════════════════════════════════════════════════
-- F. Existing behaviour
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.status(pg_temp.run('sf8', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('PO8'), 'Protects PO8', 'rct_parallel', 'user_confirmed', pg_temp.rq(80)))),
  'applied', 'F1 a study is created from a paper that has an attachment');
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('O'),
    'SELECT * FROM public.delete_papers_with_attachment_cleanup(ARRAY[''' || pg_temp.p('PO8')::text || ''']::uuid[])'),
  '23503:evidence_study_reports_paper_fkey', 'F1 deleting the linked paper through the existing RPC is refused');
SELECT is(
  (SELECT format('%s|%s|%s', (SELECT count(*) FROM public.papers WHERE id = pg_temp.p('PO8')),
                 (SELECT count(*) FROM public.paper_attachments WHERE paper_id = pg_temp.p('PO8')),
                 (SELECT count(*) FROM public.attachment_cleanup_queue WHERE user_id = pg_temp.u('O')))),
  '1|1|0', 'F1 the refusal left nothing partial: paper and attachment kept, no cleanup intent queued');

SELECT is(pg_temp.status(pg_temp.run('sfa', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_create(pg_temp.p('POA'), 'Protects POA', 'rct_parallel', 'user_confirmed', pg_temp.rq(81)))),
  'applied', 'F2 a study is created from the paper a merge would discard');
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('O'),
    'SELECT public.merge_exact_duplicates(''' || pg_temp.p('PO9')::text || '''::uuid, ARRAY[''' || pg_temp.p('POA')::text || ''']::uuid[])'),
  '23503:evidence_study_reports_paper_fkey', 'F2 merging the linked paper away is refused');
SELECT is(
  (SELECT format('%s|%s|%s|%s|%s', (SELECT count(*) FROM public.papers WHERE id = pg_temp.p('POA')),
                 (SELECT paper_id FROM public.paper_attachments WHERE id = '03170000-0000-0000-0000-0000000000aa'),
                 (SELECT count(*) FROM public.paper_tags WHERE paper_id = pg_temp.p('PO9')),
                 (SELECT count(*) FROM public.paper_projects WHERE paper_id = pg_temp.p('PO9')),
                 (SELECT abstract FROM public.papers WHERE id = pg_temp.p('PO9')))),
  '1|' || pg_temp.p('POA')::text || '|0|0|Keeper abstract.',
  'F2 the refusal left nothing partial: discard kept, attachment not re-parented, no tag or project union, keeper unchanged');

SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), pg_temp.q_delete(pg_temp.sid('sf8'), 1, pg_temp.rq(82))),
  '{"status": "deleted"}', 'F3 the study protecting PO8 is deleted');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    'SELECT deleted_count || ''/'' || queued_count FROM public.delete_papers_with_attachment_cleanup(ARRAY[''' || pg_temp.p('PO8')::text || ''']::uuid[])'),
  '1/1', 'F3 now the paper deletes through the existing RPC, queueing its attachment''s cleanup');
SELECT is(
  (SELECT format('%s|%s', (SELECT count(*) FROM public.papers WHERE id = pg_temp.p('PO8')),
                 (SELECT count(*) FROM public.attachment_cleanup_queue WHERE user_id = pg_temp.u('O')))),
  '0|1', 'F3 the paper is gone and its attachment''s cleanup intent is queued, as before PR-A2');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), pg_temp.q_delete(pg_temp.sid('sfa'), 1, pg_temp.rq(83))),
  '{"status": "deleted"}', 'F4 the study protecting POA is deleted');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    'SELECT ''merged'' FROM public.merge_exact_duplicates(''' || pg_temp.p('PO9')::text || '''::uuid, ARRAY[''' || pg_temp.p('POA')::text || ''']::uuid[])'),
  'merged', 'F4 now the merge proceeds');
SELECT is(
  (SELECT format('%s|%s|%s|%s', (SELECT count(*) FROM public.papers WHERE id = pg_temp.p('POA')),
                 (SELECT paper_id FROM public.paper_attachments WHERE id = '03170000-0000-0000-0000-0000000000aa'),
                 (SELECT count(*) FROM public.paper_tags WHERE paper_id = pg_temp.p('PO9')),
                 (SELECT count(*) FROM public.paper_projects WHERE paper_id = pg_temp.p('PO9')))),
  '0|' || pg_temp.p('PO9')::text || '|1|1', 'F4 the discard is gone; its attachment, tag and project moved to the keeper');

-- F5 — deleting an account that holds RPC-created records.
SELECT is(pg_temp.status(pg_temp.run('sx', 'authenticated', pg_temp.claims('X'),
    pg_temp.q_create(pg_temp.p('PX1'), 'Doomed account study', 'rct_parallel', 'provisional', pg_temp.rq(84)))),
  'applied', 'F5 the doomed account creates a study with a copy');
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('X'),
    pg_temp.q_link(pg_temp.sid('sx'), pg_temp.p('PX1'), 'confirm', 1, pg_temp.rq(85)))),
  'applied', 'F5 and changes its link, so it holds two versions of history');
INSERT INTO res VALUES ('dig_o_f5', pg_temp.digest(pg_temp.u('O')));
INSERT INTO res VALUES ('dig_b_f5', pg_temp.digest(pg_temp.u('B')));
SELECT is(pg_temp.call('postgres', NULL,
    'WITH d AS (DELETE FROM auth.users WHERE id = ''' || pg_temp.u('X')::text || ''' RETURNING 1) SELECT count(*)::text FROM d'),
  '1', 'F5 deleting the Auth user succeeds');
SELECT is(
  pg_temp.user_rows(pg_temp.u('X')) || format(' papers=%s attachments=%s access=%s',
    (SELECT count(*) FROM public.papers WHERE user_id = pg_temp.u('X')),
    (SELECT count(*) FROM public.paper_attachments WHERE user_id = pg_temp.u('X')),
    (SELECT count(*) FROM public.internal_user_access WHERE user_id = pg_temp.u('X'))),
  'studies=0 links=0 copies=0 arms=0 outcomes=0 values=0 refs=0 events=0 papers=0 attachments=0 access=0',
  'F5 and leaves no evidence, paper, attachment or role row of that account');
SELECT is(pg_temp.digest(pg_temp.u('O')) || ' ' || pg_temp.digest(pg_temp.u('B')),
  pg_temp.kept('dig_o_f5') || ' ' || pg_temp.kept('dig_b_f5'), 'F5 other accounts are untouched');

-- F6 — RLS still scopes every read to the caller.
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), 'SELECT count(*)::text FROM public.evidence_studies'),
  (SELECT count(*)::text FROM public.evidence_studies WHERE user_id = pg_temp.u('O')),
  'F6 the owner reads exactly their own studies');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('B'),
    'SELECT string_agg(id::text, '','') FROM public.evidence_studies'),
  pg_temp.s('SB1')::text, 'F6 the neighbour reads only their own study');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('B'),
    'SELECT count(*)::text FROM public.evidence_events WHERE user_id = ''' || pg_temp.u('O')::text || ''''),
  '0', 'F6 and none of the owner''s history');
SELECT ok(pg_temp.call('anon', '', 'SELECT count(*)::text FROM public.evidence_studies') LIKE 'ERR 42501 %',
  'F6 anon reads nothing');

-- F7 — the browser still cannot write a table directly.
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('O'), f.q), '42501', 'F7 authenticated cannot ' || f.nm || ' directly')
FROM (VALUES
  ('insert a study',  'INSERT INTO public.evidence_studies (user_id, label, design_profile) VALUES (''' || pg_temp.u('O')::text || ''', ''Direct'', ''rct_parallel'')'),
  ('update a study',  'UPDATE public.evidence_studies SET row_version = row_version + 1'),
  ('delete a study',  'DELETE FROM public.evidence_studies'),
  ('append history',  'INSERT INTO public.evidence_events (user_id, study_id, study_version, ordinal, event_type, request_id) SELECT user_id, id, 99, 1, ''study_updated'', gen_random_uuid() FROM public.evidence_studies LIMIT 1'),
  ('rewrite a copy',  'UPDATE public.evidence_source_snapshots SET char_count = char_count')
) AS f(nm, q);

-- ═════════════════════════════════════════════════════════════════════════════
-- L. Limits (001 L10)
-- ═════════════════════════════════════════════════════════════════════════════

INSERT INTO public.evidence_studies (user_id, label, design_profile)
SELECT pg_temp.u('L'), 'Planted ' || g, 'rct_parallel' FROM generate_series(1, 1999) AS g;
SELECT is(pg_temp.status(pg_temp.run('sl', 'authenticated', pg_temp.claims('L'),
    pg_temp.q_create(pg_temp.p('PL1'), 'Study 2000', 'rct_parallel', 'user_confirmed', pg_temp.rq(96)))),
  'applied', 'L1 the 2,000th study of one user is created');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('L'),
    pg_temp.q_create(pg_temp.p('PL1'), 'Study 2001', 'rct_parallel', 'user_confirmed', pg_temp.rq(97))),
  'ERR P0001 evidence_study_limit', 'L1 the 2,001st is refused');

-- 4 events from the create, plus 4,994 planted at version 1, make 4,998.
INSERT INTO public.evidence_events (user_id, study_id, study_version, ordinal, event_type, request_id, target_id, after)
SELECT pg_temp.u('L'), pg_temp.sid('sl'), 1, g, 'study_updated', gen_random_uuid(), pg_temp.sid('sl'), '{}'::jsonb
  FROM generate_series(4, 4997) AS g;
SELECT is(pg_temp.status(pg_temp.call('authenticated', pg_temp.claims('L'),
    pg_temp.q_update(pg_temp.sid('sl'), 1, 'Study 2000, renamed', 'rct_parallel', NULL, pg_temp.rq(98)))),
  'applied', 'L2 a write that brings the history to exactly 5,000 events is applied');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('L'),
    pg_temp.q_link(pg_temp.sid('sl'), pg_temp.p('PL1'), 'mark_provisional', 2, pg_temp.rq(99))),
  'ERR P0001 evidence_history_limit', 'L2 the next one is refused');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('L'),
    pg_temp.q_update(pg_temp.sid('sl'), 2, 'Study 2000, again', 'rct_parallel', NULL, pg_temp.rq(100))),
  'ERR P0001 evidence_history_limit', 'L2 for an update too');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('L'), pg_temp.q_delete(pg_temp.sid('sl'), 2, pg_temp.rq(101))),
  '{"status": "deleted"}', 'L2 a full study can still be deleted, all 5,000 events with it');

-- ═════════════════════════════════════════════════════════════════════════════
-- N. Match normalization v1 — golden vectors (expected values computed outside
--    PostgreSQL; see the header)
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(public.evidence_normalize_v1('p' || chr(0x2009) || '<' || chr(0x202F) || '0.001' || chr(0x00A0)),
          'p < 0.001',
  'N01 spaces around < (thin, narrow no-break, no-break): output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('p' || chr(0x2009) || '<' || chr(0x202F) || '0.001' || chr(0x00A0)), 'UTF8')), 'hex'),
  'ac4df7ee2d153f8845beaebd887b5a838a429d4e48575f9e3e41031f2a33e5c8',
  'N01 spaces around < (thin, narrow no-break, no-break): SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('ran' || chr(0x00AD) || 'domized'),
          'randomized',
  'N02 soft hyphen removed: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('ran' || chr(0x00AD) || 'domized'), 'UTF8')), 'hex'),
  'c78e2c6a7e4ba04d05abe48c0046400325d7b4d5a2281a71a0df465997bc9797',
  'N02 soft hyphen removed: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1(chr(0x201C) || 'blinded' || chr(0x201D) || ' and ' || chr(0x2018) || 'open' || chr(0x2019)),
          '"blinded" and ''open''',
  'N03 curly double and single quotes: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(chr(0x201C) || 'blinded' || chr(0x201D) || ' and ' || chr(0x2018) || 'open' || chr(0x2019)), 'UTF8')), 'hex'),
  '0cc01df13223d976021cd26367350568a7c765103258bfc55c6b05c9634c6993',
  'N03 curly double and single quotes: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1(chr(0x201E) || 'a' || chr(0x201F) || ' ' || chr(0x201A) || 'b' || chr(0x201B)),
          '"a" ''b''',
  'N04 low-9 and reversed-9 quotes: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(chr(0x201E) || 'a' || chr(0x201F) || ' ' || chr(0x201A) || 'b' || chr(0x201B)), 'UTF8')), 'hex'),
  '40e1da853aeebfa8a30f2170cc6e95a553208c4514064a65c0f8a352874d730f',
  'N04 low-9 and reversed-9 quotes: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('12' || chr(0x2013) || '14 weeks'),
          '12-14 weeks',
  'N05 en dash range: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('12' || chr(0x2013) || '14 weeks'), 'UTF8')), 'hex'),
  'a5ee9a069e0ee73a4e0d19408c47c378cc9e79160a5b89efc577b27e10e04486',
  'N05 en dash range: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1(chr(0x2212) || '2.1 kg'),
          '-2.1 kg',
  'N06 minus sign: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(chr(0x2212) || '2.1 kg'), 'UTF8')), 'hex'),
  '47b049d7076fb4d03300ef207d5a1e3b4fa044f67b3bd013293e1cab76a5b4f2',
  'N06 minus sign: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('a' || chr(0x2010) || 'b' || chr(0x2011) || 'c' || chr(0x2012) || 'd' || chr(0x2013) || 'e' || chr(0x2014) || 'f' || chr(0x2015) || 'g'),
          'a-b-c-d-e-f-g',
  'N07 all mapped dashes: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('a' || chr(0x2010) || 'b' || chr(0x2011) || 'c' || chr(0x2012) || 'd' || chr(0x2013) || 'e' || chr(0x2014) || 'f' || chr(0x2015) || 'g'), 'UTF8')), 'hex'),
  '483fefe153fe9a94667bcbfb80fa9cf74506a9a32ba0f80f1aacb311ac0688f7',
  'N07 all mapped dashes: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('cafe' || chr(0x0301)),
          'caf' || chr(0x00E9),
  'N08 e + combining acute composes (NFC): output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('cafe' || chr(0x0301)), 'UTF8')), 'hex'),
  '850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e',
  'N08 e + combining acute composes (NFC): SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('caf' || chr(0x00E9)),
          'caf' || chr(0x00E9),
  'N09 precomposed e acute unchanged: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('caf' || chr(0x00E9)), 'UTF8')), 'hex'),
  '850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e',
  'N09 precomposed e acute unchanged: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('5 ' || chr(0x00B5) || 'g'),
          '5 ' || chr(0x03BC) || 'g',
  'N10 micro sign to Greek mu: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('5 ' || chr(0x00B5) || 'g'), 'UTF8')), 'hex'),
  'f331bc43a9476fe99f623fe4e0ee5dbbb0a9661a7a062f024c90b7edbfd5de5c',
  'N10 micro sign to Greek mu: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('5 ' || chr(0x03BC) || 'g'),
          '5 ' || chr(0x03BC) || 'g',
  'N11 Greek mu unchanged: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('5 ' || chr(0x03BC) || 'g'), 'UTF8')), 'hex'),
  'f331bc43a9476fe99f623fe4e0ee5dbbb0a9661a7a062f024c90b7edbfd5de5c',
  'N11 Greek mu unchanged: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('10' || chr(0x2075) || ' cells'),
          '10' || chr(0x2075) || ' cells',
  'N12 superscript 5 stays (NFKC hazard): output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('10' || chr(0x2075) || ' cells'), 'UTF8')), 'hex'),
  '58064f92009bb8e27d8333ff733593934b5acf7518e53553aca357e1df36b64d',
  'N12 superscript 5 stays (NFKC hazard): SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('5 m' || chr(0x00B2)),
          '5 m' || chr(0x00B2),
  'N13 superscript 2 stays: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('5 m' || chr(0x00B2)), 'UTF8')), 'hex'),
  '145ead7315bc60166e65160f73ea9fc9b13bbfb0598ebc0e8108ad11d3243c66',
  'N13 superscript 2 stays: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1(chr(0xFB01) || 'ber'),
          chr(0xFB01) || 'ber',
  'N14 fi ligature stays: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(chr(0xFB01) || 'ber'), 'UTF8')), 'hex'),
  '7ec6c036b25596d5c5163c9ab7cd78a7032a5da9bd123a68f5049767fdd6db85',
  'N14 fi ligature stays: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('Placebo vs placebo'),
          'Placebo vs placebo',
  'N15 no case folding: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('Placebo vs placebo'), 'UTF8')), 'hex'),
  'b57ef4c50d212f67f2c782be996359c229dce0635ec86477b6565167e47e5af9',
  'N15 no case folding: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('a' || chr(0x000D) || chr(0x000A) || 'b' || chr(0x0009) || 'c' || chr(0x000B) || 'd' || chr(0x000C) || 'e'),
          'a b c d e',
  'N16 line breaks and tabs become one space: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('a' || chr(0x000D) || chr(0x000A) || 'b' || chr(0x0009) || 'c' || chr(0x000B) || 'd' || chr(0x000C) || 'e'), 'UTF8')), 'hex'),
  '52cf9f06f83e0a0a90dc25dcf548c18421244f9520c577672cd27b6618f12134',
  'N16 line breaks and tabs become one space: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('A ' || chr(0x2026) || ' B'),
          'A ... B',
  'N17 ellipsis is three periods, not a wildcard: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('A ' || chr(0x2026) || ' B'), 'UTF8')), 'hex'),
  '26bf87b9ed4c180cf97c8784cdc39b9c9c9a99d1dbbe3aaebe221aeda4c8a92a',
  'N17 ellipsis is three periods, not a wildcard: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1(chr(0xFEFF) || 'a' || chr(0x200B) || 'b' || chr(0x2060) || 'c'),
          'abc',
  'N18 BOM, zero-width space and word joiner removed: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(chr(0xFEFF) || 'a' || chr(0x200B) || 'b' || chr(0x2060) || 'c'), 'UTF8')), 'hex'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'N18 BOM, zero-width space and word joiner removed: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('  a   b  '),
          'a b',
  'N19 collapse runs and trim: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('  a   b  '), 'UTF8')), 'hex'),
  'c8687a08aa5d6ed2044328fa6a697ab8e96dc34291e8c2034ae8c38e6fcc6d65',
  'N19 collapse runs and trim: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('a' || chr(0x2028) || 'b' || chr(0x2029) || 'c' || chr(0x0085) || 'd' || chr(0x1680) || 'e' || chr(0x3000) || 'f' || chr(0x205F) || 'g'),
          'a b c d e f g',
  'N20 separators and wide spaces: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('a' || chr(0x2028) || 'b' || chr(0x2029) || 'c' || chr(0x0085) || 'd' || chr(0x1680) || 'e' || chr(0x3000) || 'f' || chr(0x205F) || 'g'), 'UTF8')), 'hex'),
  '54ff557e9f8f96a09c179ad2101dbca7e608ebc826b03c8833518097fa2dd32f',
  'N20 separators and wide spaces: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('x' || chr(0x0009) || chr(0x000A) || chr(0x000B) || chr(0x000C) || chr(0x000D) || ' ' || chr(0x0085) || chr(0x00A0) || chr(0x1680) || chr(0x2000) || chr(0x2001) || chr(0x2002) || chr(0x2003) || chr(0x2004) || chr(0x2005) || chr(0x2006) || chr(0x2007) || chr(0x2008) || chr(0x2009) || chr(0x200A) || chr(0x2028) || chr(0x2029) || chr(0x202F) || chr(0x205F) || chr(0x3000) || 'y'),
          'x y',
  'N21 all 25 White_Space characters: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('x' || chr(0x0009) || chr(0x000A) || chr(0x000B) || chr(0x000C) || chr(0x000D) || ' ' || chr(0x0085) || chr(0x00A0) || chr(0x1680) || chr(0x2000) || chr(0x2001) || chr(0x2002) || chr(0x2003) || chr(0x2004) || chr(0x2005) || chr(0x2006) || chr(0x2007) || chr(0x2008) || chr(0x2009) || chr(0x200A) || chr(0x2028) || chr(0x2029) || chr(0x202F) || chr(0x205F) || chr(0x3000) || 'y'), 'UTF8')), 'hex'),
  '887fcea6a80333c6c02ae7e79735f0edad8d811f0b61431495f796f4bf6a7c19',
  'N21 all 25 White_Space characters: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('a ' || chr(0x200B) || ' b'),
          'a b',
  'N22 removal happens before collapsing: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('a ' || chr(0x200B) || ' b'), 'UTF8')), 'hex'),
  'c8687a08aa5d6ed2044328fa6a697ab8e96dc34291e8c2034ae8c38e6fcc6d65',
  'N22 removal happens before collapsing: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('e' || chr(0x00AD) || chr(0x0301)),
          'e' || chr(0x0301),
  'N23 soft hyphen blocks composition (step order): output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('e' || chr(0x00AD) || chr(0x0301)), 'UTF8')), 'hex'),
  'bf12767b0f2a56b2190075bae8169f656e3ce8d6357d4aff184bc6c7ea48f9f6',
  'N23 soft hyphen blocks composition (step order): SHA-256 of the output');
SELECT is(public.evidence_normalize_v1(chr(0x212B) || ' ' || chr(0x2126)),
          chr(0x00C5) || ' ' || chr(0x03A9),
  'N24 canonical singletons (Angstrom, Ohm): output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(chr(0x212B) || ' ' || chr(0x2126)), 'UTF8')), 'hex'),
  '69dc02ebabc7bba88abeca8e014d783275c7fd651e2e8022a23125a641221dc9',
  'N24 canonical singletons (Angstrom, Ohm): SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('A' || chr(0x030A)),
          chr(0x00C5),
  'N25 A + ring composes: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('A' || chr(0x030A)), 'UTF8')), 'hex'),
  '0a94dc9d420d1142d6b71de60f9bf7e2f345a4d62c9f141b091539769ddf3075',
  'N25 A + ring composes: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1(chr(0xFF0D) || ' ' || chr(0x2032) || ' ' || chr(0x02BC) || ' ' || chr(0x2E3A)),
          chr(0xFF0D) || ' ' || chr(0x2032) || ' ' || chr(0x02BC) || ' ' || chr(0x2E3A),
  'N26 nothing else: fullwidth hyphen, prime, modifier apostrophe, two-em dash: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(chr(0xFF0D) || ' ' || chr(0x2032) || ' ' || chr(0x02BC) || ' ' || chr(0x2E3A)), 'UTF8')), 'hex'),
  '867dc66ab3599d13b059545f77090b62828d45a1b461f013bef0eab55ca914b0',
  'N26 nothing else: fullwidth hyphen, prime, modifier apostrophe, two-em dash: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1(' ' || chr(0x0009) || chr(0x00A0) || chr(0x3000) || chr(0x000A)),
          '',
  'N27 only whitespace normalizes to empty: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(' ' || chr(0x0009) || chr(0x00A0) || chr(0x3000) || chr(0x000A)), 'UTF8')), 'hex'),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'N27 only whitespace normalizes to empty: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1(''),
          '',
  'N28 empty string: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(''), 'UTF8')), 'hex'),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'N28 empty string: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1('Adults with type 2 diabetes.'),
          'Adults with type 2 diabetes.',
  'N29 plain ASCII is unchanged: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1('Adults with type 2 diabetes.'), 'UTF8')), 'hex'),
  'aac3d8cd3e5ca9a6eb7c4940648518e76d339d56aae162097cc61097aee93a7a',
  'N29 plain ASCII is unchanged: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1(chr(0x1D400) || ' x'),
          chr(0x1D400) || ' x',
  'N30 astral character unchanged: output');
SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(chr(0x1D400) || ' x'), 'UTF8')), 'hex'),
  'bbb15d65e30517e3695724d44dbabf80e636e9eb032397f3eb6845abb896b85c',
  'N30 astral character unchanged: SHA-256 of the output');
SELECT is(public.evidence_normalize_v1(NULL), NULL, 'N31 NULL stays NULL (STRICT)');

SELECT * FROM finish();
ROLLBACK;
