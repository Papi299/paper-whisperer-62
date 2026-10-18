-- EVIDENCE-RECORDS-001A3 suite 033: field operations, server-side quote
-- matching, human review and source rebase.
--
-- Owns `20261017155445_add_evidence_records_field_review_rebase_rpcs.sql`: the
-- three client RPCs (save_changes, review_fields, rebase_source) and the three
-- internal helpers (locate_quote, state_reference_problems, value_digest).
-- Every RPC call below runs as `authenticated` (or anon, or service_role) with
-- JWT claims, exactly as PostgREST would make it. Proves:
--   A. the function contract — twelve evidence functions with their reviewed
--      attributes, stored and effective EXECUTE, the I-1 order in each body, no
--      dynamic SQL, PR-A2's bodies (the normalizer above all) untouched, the
--      evidence tables still SELECT-only;
--   B. the pilot gate and ownership — owner allowed; manager, ordinary user,
--      forged metadata and a claim-less caller refused; anon and service_role
--      without EXECUTE; the helpers internal; foreign and cross-study ids
--      answered as not found, and nothing of the neighbour's changed;
--   C. groups and outcomes — add, update, reorder, remove, positions, the
--      design family, the comparator-only rule;
--   D. values — every field key in its scope, every shape and bound, every
--      state, the PO blank rule (v1-empty), lists never rewritten, FK-PROOF-001
--      §J through the RPC, the per-row matrix, forged and unknown keys, the
--      current-copy rule, server quote matching, no-ops, the refused empty
--      batch, value versions, the review reset, kept references, clearing,
--      history digests;
--   E. review — Confirm and Flag of one value at one version, every reachable
--      block reason in PR-B's order, the already-reviewed no-op, notes, PO
--      decisions 1-3, no bulk parameter;
--   F. rebase — the displayed-hash check, unchanged, re-matching, the strict
--      re-review rule, examined abstracts never re-pointed, superseded copies
--      kept, the first capture, limits and events;
--   G. request idempotency in sequence (the concurrent cases are the db-tests
--      field/review/rebase race probe in scripts/e2e-local.mjs);
--   H. history integrity — gap-free versions, headers, no source or user text
--      in any event, earlier events byte-identical, the append-only scan;
--   I. existing behaviour — set_link, delete_study, paper deletion, account
--      deletion, RLS and no direct write, all with RPC-written records;
--   J. evidence_state_reference_problems over every count, against a
--      transcription of FK-PROOF-001 §J written here, not read from the code;
--   K. the limits — 20 groups, 50 outcomes, 400 values, 200 changes, 64 KB,
--      10 assessments, 5,000 events, 20 copies.
--
-- Every non-ASCII character in this file is written as chr(<code point>).
-- A few values are planted by the database owner (FK-PROOF-001 K, layer 1)
-- only where no RPC can create them, to reach a defensive refusal. Everything
-- runs in one transaction and rolls back. Deterministic ids; synthetic data
-- only; no remote calls; no Production data; no real credentials.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- Fixture users: O owner, M manager, U ordinary user, B neighbour (an owner),
-- X owner (account deleted below), L owner (limits).
CREATE FUNCTION pg_temp.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT ('03300000-0000-0000-0000-0000000000' || CASE p_name
            WHEN 'O' THEN 'a0' WHEN 'M' THEN 'b0' WHEN 'U' THEN 'c0' WHEN 'B' THEN 'd0'
            WHEN 'X' THEN 'e0' WHEN 'L' THEN 'f0' END)::uuid
$hlp$;

CREATE FUNCTION pg_temp.p(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT (CASE p_name
            WHEN 'PA' THEN '033000a1' WHEN 'PB' THEN '033000a2' WHEN 'PC' THEN '033000a3'
            WHEN 'PD' THEN '033000a4' WHEN 'PF' THEN '033000a5' WHEN 'PG' THEN '033000a6'
            WHEN 'PE1' THEN '033000e1' WHEN 'PE2' THEN '033000e2' WHEN 'PE3' THEN '033000e3'
            WHEN 'PE4' THEN '033000e4' WHEN 'PE5' THEN '033000e5'
            WHEN 'PM' THEN '033000b1' WHEN 'PU' THEN '033000c1' WHEN 'PN' THEN '033000d1'
            WHEN 'PX' THEN '033000f1' WHEN 'PL' THEN '033000f2'
            WHEN 'unknown' THEN '0330dead' END || '-0000-0000-0000-000000000000')::uuid
$hlp$;

-- Studies planted for other users, and an id nobody owns.
CREATE FUNCTION pg_temp.s(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT (CASE p_name WHEN 'SM' THEN '0335b001' WHEN 'SU' THEN '0335c001' WHEN 'SN' THEN '0335d001'
                      WHEN 'unknown' THEN '0335dead' END || '-0000-0000-0000-000000000000')::uuid
$hlp$;

-- One request id per numbered request. lpad truncates, so pad to at least 4.
CREATE FUNCTION pg_temp.rq(p_n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT ('033f' || lpad(to_hex(p_n), greatest(4, char_length(to_hex(p_n))), '0') || '-0000-0000-0000-000000000000')::uuid
$hlp$;

CREATE FUNCTION pg_temp.claims(p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT '{"sub":"' || pg_temp.u(p_name)::text || '","role":"authenticated"}'
$hlp$;

-- The three RPC calls as SQL text (NULL arguments stay NULL).
CREATE FUNCTION pg_temp.q_save(p_study uuid, p_version integer, p_changes jsonb, p_req uuid)
RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('SELECT public.evidence_save_changes(%L::uuid, %L::integer, %L::jsonb, %L::uuid)::text',
                p_study, p_version, p_changes, p_req)
$hlp$;
CREATE FUNCTION pg_temp.q_review(p_study uuid, p_version integer, p_value uuid, p_value_version integer,
                                 p_action text, p_note text, p_req uuid)
RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('SELECT public.evidence_review_fields(%L::uuid, %L::integer, %L::uuid, %L::integer, %L::text, %L::text, %L::uuid)::text',
                p_study, p_version, p_value, p_value_version, p_action, p_note, p_req)
$hlp$;
CREATE FUNCTION pg_temp.q_rebase(p_study uuid, p_paper uuid, p_version integer, p_sha text, p_req uuid)
RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('SELECT public.evidence_rebase_source(%L::uuid, %L::uuid, %L::integer, %L::text, %L::uuid)::text',
                p_study, p_paper, p_version, p_sha, p_req)
$hlp$;
CREATE FUNCTION pg_temp.q_create(p_paper uuid, p_label text, p_profile text, p_req uuid)
RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('SELECT public.evidence_create_study_from_paper(%L::uuid, %L::text, %L::text, ''user_confirmed'', %L::uuid)::text',
                p_paper, p_label, p_profile, p_req)
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

CREATE FUNCTION pg_temp.keep(p_key text, p_value text) RETURNS void LANGUAGE sql AS $hlp$
  INSERT INTO res (k, v) VALUES (p_key, p_value)
$hlp$;

CREATE FUNCTION pg_temp.status(p_out text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT CASE WHEN p_out LIKE '{%' THEN p_out::jsonb ->> 'status' ELSE coalesce(p_out, '<null>') END
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

-- The current copy of a study-report link, and a copy by its seq.
CREATE FUNCTION pg_temp.cur(p_study uuid, p_paper uuid) RETURNS uuid LANGUAGE sql STABLE AS $hlp$
  SELECT c.id FROM public.evidence_source_snapshots c
   WHERE c.study_id = p_study AND c.paper_id = p_paper ORDER BY c.seq DESC LIMIT 1
$hlp$;
CREATE FUNCTION pg_temp.copy(p_study uuid, p_paper uuid, p_seq integer) RETURNS uuid LANGUAGE sql STABLE AS $hlp$
  SELECT c.id FROM public.evidence_source_snapshots c
   WHERE c.study_id = p_study AND c.paper_id = p_paper AND c.seq = p_seq
$hlp$;

-- A value by its target and field, and its current version.
CREATE FUNCTION pg_temp.vid(p_study uuid, p_field text, p_arm uuid DEFAULT NULL, p_outcome uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql STABLE AS $hlp$
  SELECT v.id FROM public.evidence_field_values v
   WHERE v.study_id = p_study AND v.field_key = p_field
     AND v.arm_id IS NOT DISTINCT FROM p_arm AND v.outcome_id IS NOT DISTINCT FROM p_outcome
$hlp$;
CREATE FUNCTION pg_temp.vv(p_value uuid) RETURNS integer LANGUAGE sql STABLE AS $hlp$
  SELECT v.value_version FROM public.evidence_field_values v WHERE v.id = p_value
$hlp$;

-- Payload builders: targets, contents, references and changes, exactly as the
-- migration header documents them.
CREATE FUNCTION pg_temp.st() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$ SELECT '{"scope": "study"}'::jsonb $hlp$;
CREATE FUNCTION pg_temp.at(p_arm uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('scope', 'arm', 'arm_id', p_arm) $hlp$;
CREATE FUNCTION pg_temp.aref(p_ref text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('scope', 'arm', 'arm_ref', p_ref) $hlp$;
CREATE FUNCTION pg_temp.ot(p_outcome uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('scope', 'outcome', 'outcome_id', p_outcome) $hlp$;
CREATE FUNCTION pg_temp.oref(p_ref text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('scope', 'outcome', 'outcome_ref', p_ref) $hlp$;

CREATE FUNCTION pg_temp.txt(p_text text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('shape', 'text', 'text', p_text) $hlp$;
CREATE FUNCTION pg_temp.cd(p_code text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('shape', 'code', 'code', p_code) $hlp$;
CREATE FUNCTION pg_temp.cnt(p_text text, p_value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('shape', 'integer_with_reported_text', 'reported_text', p_text, 'value', p_value) $hlp$;
CREATE FUNCTION pg_temp.lst(p_entries jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('shape', 'text_list', 'entries', p_entries) $hlp$;

CREATE FUNCTION pg_temp.qt(p_paper uuid, p_snapshot uuid, p_quote text, p_occ integer DEFAULT NULL, p_count integer DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('purpose', 'supports', 'source_kind', 'abstract', 'paper_id', p_paper,
                            'snapshot_id', p_snapshot, 'quote_text', p_quote,
                            'occurrence', p_occ, 'expected_match_count', p_count)
$hlp$;
CREATE FUNCTION pg_temp.ftl(p_paper uuid, p_kind text DEFAULT 'page', p_text text DEFAULT 'p. 4')
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('purpose', 'supports', 'source_kind', 'full_text', 'paper_id', p_paper,
                            'locator_kind', p_kind, 'locator_text', p_text)
$hlp$;
CREATE FUNCTION pg_temp.exa(p_paper uuid, p_snapshot uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('purpose', 'examined', 'source_kind', 'abstract', 'paper_id', p_paper, 'snapshot_id', p_snapshot)
$hlp$;
CREATE FUNCTION pg_temp.exf(p_paper uuid, p_kind text DEFAULT NULL, p_text text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('purpose', 'examined', 'source_kind', 'full_text', 'paper_id', p_paper,
                            'locator_kind', p_kind, 'locator_text', p_text)
$hlp$;
CREATE FUNCTION pg_temp.una(p_kind text, p_paper uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('purpose', 'unavailable', 'source_kind', p_kind, 'paper_id', p_paper)
$hlp$;
CREATE FUNCTION pg_temp.kp(p_anchor uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('anchor_id', p_anchor)
$hlp$;

CREATE FUNCTION pg_temp.sv(p_target jsonb, p_field text, p_expected integer, p_state text, p_reason text,
                           p_content jsonb, p_note text, p_refs jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('op', 'set_value', 'target', p_target, 'field_key', p_field,
                            'expected_value_version', p_expected, 'value_state', p_state,
                            'state_reason', p_reason, 'content', p_content, 'note', p_note,
                            'references', p_refs)
$hlp$;
-- A Reported value with one content and references, the commonest change.
CREATE FUNCTION pg_temp.rv(p_target jsonb, p_field text, p_expected integer, p_content jsonb, p_refs jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT pg_temp.sv(p_target, p_field, p_expected, 'reported', NULL, p_content, NULL, p_refs)
$hlp$;
CREATE FUNCTION pg_temp.cv(p_target jsonb, p_field text, p_expected integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('op', 'clear_value', 'target', p_target, 'field_key', p_field, 'expected_value_version', p_expected)
$hlp$;
CREATE FUNCTION pg_temp.add_arm(p_ref text, p_role text, p_label text, p_pos integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('op', 'add_arm', 'ref', p_ref, 'arm_role', p_role, 'display_label', p_label, 'position', p_pos)
$hlp$;
CREATE FUNCTION pg_temp.upd_arm(p_arm uuid, p_role text, p_label text, p_pos integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('op', 'update_arm', 'arm_id', p_arm, 'arm_role', p_role, 'display_label', p_label, 'position', p_pos)
$hlp$;
CREATE FUNCTION pg_temp.add_out(p_ref text, p_label text, p_pos integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('op', 'add_outcome', 'ref', p_ref, 'display_label', p_label, 'position', p_pos)
$hlp$;
CREATE FUNCTION pg_temp.upd_out(p_outcome uuid, p_label text, p_pos integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object('op', 'update_outcome', 'outcome_id', p_outcome, 'display_label', p_label, 'position', p_pos)
$hlp$;

-- Save, review or rebase as a user at the study's CURRENT version.
CREATE FUNCTION pg_temp.save(p_user text, p_study uuid, p_changes jsonb, p_req integer)
RETURNS text LANGUAGE sql AS $hlp$
  SELECT pg_temp.call('authenticated', pg_temp.claims(p_user),
                      pg_temp.q_save(p_study, pg_temp.ver(p_study), p_changes, pg_temp.rq(p_req)))
$hlp$;
CREATE FUNCTION pg_temp.review(p_user text, p_study uuid, p_value uuid, p_action text, p_note text, p_req integer)
RETURNS text LANGUAGE sql AS $hlp$
  SELECT pg_temp.call('authenticated', pg_temp.claims(p_user),
                      pg_temp.q_review(p_study, pg_temp.ver(p_study), p_value, pg_temp.vv(p_value), p_action, p_note, pg_temp.rq(p_req)))
$hlp$;
CREATE FUNCTION pg_temp.sha(p_text text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex')
$hlp$;
CREATE FUNCTION pg_temp.rebase(p_user text, p_study uuid, p_paper uuid, p_req integer)
RETURNS text LANGUAGE sql AS $hlp$
  SELECT pg_temp.call('authenticated', pg_temp.claims(p_user),
                      pg_temp.q_rebase(p_study, p_paper, pg_temp.ver(p_study),
                                       pg_temp.sha((SELECT abstract FROM public.papers WHERE id = p_paper)), pg_temp.rq(p_req)))
$hlp$;

-- Run p_sql as p_role, then (as postgres) p_check, then undo EVERYTHING with a
-- sentinel raised in the same subtransaction (suite 030's pattern).
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
    RAISE EXCEPTION 'evidence-033 probe undo' USING ERRCODE = 'P0E33';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_con = CONSTRAINT_NAME;
  END;
  IF v_state = 'P0E33' THEN
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

-- Row counts per evidence table for one study, and for one user.
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

-- A study of another user, and a copy with both fingerprints, planted by the owner.
CREATE FUNCTION pg_temp.plant_study(p_id uuid, p_user uuid, p_paper uuid) RETURNS void LANGUAGE sql AS $hlp$
  INSERT INTO public.evidence_studies (id, user_id, label, design_profile)
  VALUES (p_id, p_user, 'Planted study', 'rct_parallel');
  INSERT INTO public.evidence_study_reports (user_id, study_id, paper_id, link_status, link_basis)
  VALUES (p_user, p_id, p_paper, 'user_confirmed', 'created_from_paper');
$hlp$;
CREATE FUNCTION pg_temp.plant_copy(p_id uuid, p_user uuid, p_study uuid, p_paper uuid, p_seq integer, p_text text)
RETURNS void LANGUAGE sql AS $hlp$
  INSERT INTO public.evidence_source_snapshots
    (id, user_id, study_id, paper_id, seq, source_kind, exact_text, exact_sha256,
     normalized_sha256, normalization_version, char_count)
  VALUES (p_id, p_user, p_study, p_paper, p_seq, 'library_abstract', p_text, sha256(convert_to(p_text, 'UTF8')),
          sha256(convert_to(public.evidence_normalize_v1(p_text), 'UTF8')), 'v1', char_length(p_text));
$hlp$;
CREATE FUNCTION pg_temp.plant_link(p_user uuid, p_study uuid, p_paper uuid) RETURNS void LANGUAGE sql AS $hlp$
  INSERT INTO public.evidence_study_reports (user_id, study_id, paper_id, link_status, link_basis)
  VALUES (p_user, p_study, p_paper, 'provisional', 'user_linked');
$hlp$;

-- A function body without its line comments, for source scans.
CREATE FUNCTION pg_temp.code(p_fn regprocedure) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') FROM pg_proc p WHERE p.oid = p_fn
$hlp$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────

INSERT INTO auth.users (id, email) VALUES
  (pg_temp.u('O'), 'evidence-033-owner@paperlume.test'),
  (pg_temp.u('M'), 'evidence-033-manager@paperlume.test'),
  (pg_temp.u('U'), 'evidence-033-user@paperlume.test'),
  (pg_temp.u('B'), 'evidence-033-neighbour@paperlume.test'),
  (pg_temp.u('X'), 'evidence-033-deleted-owner@paperlume.test'),
  (pg_temp.u('L'), 'evidence-033-limits-owner@paperlume.test');

INSERT INTO public.internal_user_access (user_id, role) VALUES
  (pg_temp.u('O'), 'owner'),
  (pg_temp.u('M'), 'manager'),
  (pg_temp.u('B'), 'owner'),
  (pg_temp.u('X'), 'owner'),
  (pg_temp.u('L'), 'owner');

-- PA's abstract exercises v1 and matching: thin spaces, an en dash, two
-- "placebo", an overlapping "abababa", a superscript, a micro sign, a
-- subscript, curly quotes, a Unicode hyphen, an ellipsis, a decomposed
-- e-acute, an astral letter and a soft hyphen. MARKER033 lets section H prove
-- the text never reaches history.
INSERT INTO public.papers (id, user_id, title, abstract, insert_order) VALUES
  (pg_temp.p('PA'), pg_temp.u('O'), 'PA rich abstract',
   'MARKER033 Adults with type 2 diabetes (n' || chr(0x2009) || '=' || chr(0x2009) || '120) were randomized '
   || chr(0x2013) || ' metformin vs placebo vs placebo' || chr(0x2010) || 'like care; 10' || chr(0x2075) || ' cells per '
   || chr(0x00B5) || 'L; ' || chr(0x201C) || 'double' || chr(0x2010) || 'blind' || chr(0x201D) || chr(0x2026)
   || ' cafe' || chr(0x0301) || ' H' || chr(0x2082) || 'O x' || chr(0x1D400) || 'y abababa. Follow' || chr(0x00AD)
   || 'up 12 weeks.', 1),
  (pg_temp.p('PB'), pg_temp.u('O'), 'PB no abstract', NULL, 2),
  (pg_temp.p('PC'), pg_temp.u('O'), 'PC rebase abstract',
   'Rebase study: 64 adults with asthma received inhaler A or inhaler B. Lung function improved with inhaler A.', 3),
  (pg_temp.p('PD'), pg_temp.u('O'), 'PD second report', 'Second report: participants were followed for 6 months.', 4),
  (pg_temp.p('PF'), pg_temp.u('O'), 'PF cohort abstract', 'A cohort of 2,000 nurses was followed for 10 years.', 5),
  (pg_temp.p('PG'), pg_temp.u('O'), 'PG repetitive abstract', 'Repeated: ' || repeat('a', 103) || '.', 6),
  (pg_temp.p('PE1'), pg_temp.u('O'), 'PE1 extra report', NULL, 7),
  (pg_temp.p('PE2'), pg_temp.u('O'), 'PE2 extra report', NULL, 8),
  (pg_temp.p('PE3'), pg_temp.u('O'), 'PE3 extra report', NULL, 9),
  (pg_temp.p('PE4'), pg_temp.u('O'), 'PE4 extra report', NULL, 10),
  (pg_temp.p('PE5'), pg_temp.u('O'), 'PE5 extra report', NULL, 11),
  (pg_temp.p('PM'), pg_temp.u('M'), 'PM manager paper', 'Manager abstract.', 12),
  (pg_temp.p('PU'), pg_temp.u('U'), 'PU user paper', 'User abstract.', 13),
  (pg_temp.p('PN'), pg_temp.u('B'), 'PN neighbour paper', 'Neighbour abstract with type 2 diabetes.', 14),
  (pg_temp.p('PX'), pg_temp.u('X'), 'PX deleted account', 'Deleted account abstract about asthma.', 15),
  (pg_temp.p('PL'), pg_temp.u('L'), 'PL limits paper', 'Limits abstract about obesity.', 16);

-- Studies only the owner could plant: for the manager and the ordinary user
-- (who cannot create one), and the neighbour's, with a copy, a value, a
-- reference and a request header, so "someone else's" ids are real.
SELECT pg_temp.plant_study(pg_temp.s('SM'), pg_temp.u('M'), pg_temp.p('PM'));
SELECT pg_temp.plant_study(pg_temp.s('SU'), pg_temp.u('U'), pg_temp.p('PU'));
SELECT pg_temp.plant_study(pg_temp.s('SN'), pg_temp.u('B'), pg_temp.p('PN'));
SELECT pg_temp.plant_copy('0336d001-0000-0000-0000-000000000000', pg_temp.u('B'), pg_temp.s('SN'), pg_temp.p('PN'), 1,
                          'Neighbour abstract with type 2 diabetes.');
INSERT INTO public.evidence_arms (id, user_id, study_id, arm_role, display_label, position)
VALUES ('0337d001-0000-0000-0000-000000000000', pg_temp.u('B'), pg_temp.s('SN'), 'comparator', 'Neighbour arm', 0);
INSERT INTO public.evidence_outcomes (id, user_id, study_id, display_label, position)
VALUES ('0338d001-0000-0000-0000-000000000000', pg_temp.u('B'), pg_temp.s('SN'), 'Neighbour outcome', 0);
INSERT INTO public.evidence_field_values (id, user_id, study_id, field_key, value_state, value_text)
VALUES ('0339d001-0000-0000-0000-000000000000', pg_temp.u('B'), pg_temp.s('SN'), 'condition', 'reported', 'Neighbour condition');
INSERT INTO public.evidence_field_anchors (id, user_id, study_id, value_id, paper_id, purpose, source_kind, position, locator_kind, locator_text)
VALUES ('033ad001-0000-0000-0000-000000000000', pg_temp.u('B'), pg_temp.s('SN'), '0339d001-0000-0000-0000-000000000000',
        pg_temp.p('PN'), 'supports', 'full_text', 0, 'page', 'p. 1');
INSERT INTO public.evidence_events (user_id, study_id, study_version, ordinal, event_type, request_id, op, payload_sha256, result)
VALUES (pg_temp.u('B'), pg_temp.s('SN'), 1, 0, 'request', '033fbbbb-0000-0000-0000-000000000000',
        'create_study', sha256('planted'::bytea), '{"status": "applied"}');
INSERT INTO public.evidence_field_values (id, user_id, study_id, field_key, value_state, value_text)
VALUES ('0339b001-0000-0000-0000-000000000000', pg_temp.u('M'), pg_temp.s('SM'), 'condition', 'reported', 'Manager condition');

-- The owner's studies, through the real RPC.
SELECT pg_temp.run('s1', 'authenticated', pg_temp.claims('O'), pg_temp.q_create(pg_temp.p('PA'), 'Main study', 'rct_parallel', pg_temp.rq(1)));
SELECT pg_temp.run('s2', 'authenticated', pg_temp.claims('O'), pg_temp.q_create(pg_temp.p('PB'), 'No copy study', 'rct_parallel', pg_temp.rq(2)));
SELECT pg_temp.run('s3', 'authenticated', pg_temp.claims('O'), pg_temp.q_create(pg_temp.p('PC'), 'Rebase study', 'rct_parallel', pg_temp.rq(3)));
SELECT pg_temp.run('s4', 'authenticated', pg_temp.claims('O'), pg_temp.q_create(pg_temp.p('PF'), 'Cohort study', 'non_intervention', pg_temp.rq(4)));
SELECT pg_temp.run('s5', 'authenticated', pg_temp.claims('O'), pg_temp.q_create(pg_temp.p('PG'), 'Repetitive study', 'rct_parallel', pg_temp.rq(5)));
SELECT pg_temp.run('sx', 'authenticated', pg_temp.claims('X'), pg_temp.q_create(pg_temp.p('PX'), 'Doomed account study', 'rct_parallel', pg_temp.rq(6)));

-- S1 also reports in PD (its copy superseded by a second one) and in five
-- reports without abstracts, all planted: linking is a later phase.
SELECT pg_temp.plant_link(pg_temp.u('O'), pg_temp.sid('s1'), pg_temp.p('PD'));
SELECT pg_temp.plant_copy('0336a004-0000-0000-0000-000000000001', pg_temp.u('O'), pg_temp.sid('s1'), pg_temp.p('PD'), 1,
                          'Second report: participants were followed for 6 months.');
SELECT pg_temp.plant_copy('0336a004-0000-0000-0000-000000000002', pg_temp.u('O'), pg_temp.sid('s1'), pg_temp.p('PD'), 2,
                          'Second report, revised: participants were followed for 6 months.');
SELECT pg_temp.plant_link(pg_temp.u('O'), pg_temp.sid('s1'), pg_temp.p(x)) FROM unnest(ARRAY['PE1', 'PE2', 'PE3', 'PE4', 'PE5']) x;

SELECT plan(469);

-- ═════════════════════════════════════════════════════════════════════════════
-- A. The function contract
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT string_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ') -> ' || pg_get_function_result(p.oid)
                     || ' | ' || l.lanname || ' | ' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
                     || ' | vol=' || p.provolatile::text || ' strict=' || CASE WHEN p.proisstrict THEN 't' ELSE 'f' END
                     || ' parallel=' || p.proparallel::text || ' | owner=' || pg_get_userbyid(p.proowner)
                     || ' | ' || coalesce(array_to_string(p.proconfig, ';'), '<no config>'),
                     E'\n' ORDER BY p.proname COLLATE "C")
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
      AND p.proname IN ('evidence_locate_quote', 'evidence_rebase_source', 'evidence_review_fields',
                        'evidence_save_changes', 'evidence_state_reference_problems', 'evidence_value_digest')),
  'evidence_locate_quote(p_quotes text[], p_snapshot text) -> TABLE(ord integer, status text, problems text[], normalized_length integer, match_count integer, starts integer[])'
  || ' | plpgsql | invoker | vol=i strict=t parallel=s | owner=postgres | search_path=pg_catalog, pg_temp' || E'\n'
  || 'evidence_rebase_source(p_study_id uuid, p_paper_id uuid, p_expected_version integer, p_expected_abstract_sha256 text, p_request_id uuid) -> jsonb'
  || ' | plpgsql | definer | vol=v strict=f parallel=u | owner=postgres | search_path=public, pg_temp' || E'\n'
  || 'evidence_review_fields(p_study_id uuid, p_expected_version integer, p_value_id uuid, p_expected_value_version integer, p_action text, p_note text, p_request_id uuid) -> jsonb'
  || ' | plpgsql | definer | vol=v strict=f parallel=u | owner=postgres | search_path=public, pg_temp' || E'\n'
  || 'evidence_save_changes(p_study_id uuid, p_expected_version integer, p_changes jsonb, p_request_id uuid) -> jsonb'
  || ' | plpgsql | definer | vol=v strict=f parallel=u | owner=postgres | search_path=public, pg_temp' || E'\n'
  || 'evidence_state_reference_problems(p_state text, p_supports integer, p_examined integer, p_unavailable integer) -> text[]'
  || ' | sql | invoker | vol=i strict=t parallel=s | owner=postgres | search_path=pg_catalog, pg_temp' || E'\n'
  || 'evidence_value_digest(p_user_id uuid, p_value_id uuid) -> jsonb'
  || ' | sql | invoker | vol=s strict=t parallel=u | owner=postgres | search_path=public, pg_temp',
  'A1 the six PR-A3 functions, each with its reviewed signature, result, language, security mode, volatility, owner and search_path');

SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'),
  12, 'A2 twelve evidence functions in all: PR-A2''s six and these six');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = nm),
  1, 'A2 exactly one overload of ' || nm)
FROM unnest(ARRAY['evidence_locate_quote', 'evidence_rebase_source', 'evidence_review_fields',
                  'evidence_save_changes', 'evidence_state_reference_problems', 'evidence_value_digest']) nm;

SELECT is((SELECT coalesce(p.proacl::text, '<default>') FROM pg_proc p WHERE p.oid = to_regprocedure(f.sig)),
  f.acl, 'A3 stored EXECUTE ACL of ' || f.sig)
FROM (VALUES
  ('public.evidence_save_changes(uuid,integer,jsonb,uuid)',                        '{postgres=X/postgres,authenticated=X/postgres}'),
  ('public.evidence_review_fields(uuid,integer,uuid,integer,text,text,uuid)',      '{postgres=X/postgres,authenticated=X/postgres}'),
  ('public.evidence_rebase_source(uuid,uuid,integer,text,uuid)',                   '{postgres=X/postgres,authenticated=X/postgres}'),
  ('public.evidence_locate_quote(text[],text)',                                    '{postgres=X/postgres}'),
  ('public.evidence_state_reference_problems(text,integer,integer,integer)',       '{postgres=X/postgres}'),
  ('public.evidence_value_digest(uuid,uuid)',                                      '{postgres=X/postgres}')
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
  ('public.evidence_save_changes(uuid,integer,jsonb,uuid)',                        'authenticated'),
  ('public.evidence_review_fields(uuid,integer,uuid,integer,text,text,uuid)',      'authenticated'),
  ('public.evidence_rebase_source(uuid,uuid,integer,text,uuid)',                   'authenticated'),
  ('public.evidence_locate_quote(text[],text)',                                    '<nobody>'),
  ('public.evidence_state_reference_problems(text,integer,integer,integer)',       '<nobody>'),
  ('public.evidence_value_digest(uuid,uuid)',                                      '<nobody>')
) AS f(sig, who);

-- The I-1 order, read from each body: the gate before any table is read, the
-- isolation guard, then the request lock, the header lookup, the study row.
SELECT ok(
  (WITH c AS (SELECT pg_temp.code(to_regprocedure(sig)) AS t)
   SELECT position('PERFORM public.evidence_records_assert_writable()' IN t) > 0
      AND position('PERFORM public.evidence_records_assert_writable()' IN t) < position('transaction_isolation' IN t)
      AND position('transaction_isolation' IN t) < position('FROM public.' IN t)
      AND position('pg_advisory_xact_lock(20261016' IN t) < position('FROM public.evidence_events' IN t)
      AND position('FROM public.evidence_events' IN t) < position('FROM public.evidence_studies' IN t)
      AND position('FOR UPDATE' IN t) > position('FROM public.evidence_studies' IN t)
     FROM c),
  'A5 ' || sig || ': gate, isolation guard, request lock, header lookup, then the study row FOR UPDATE')
FROM unnest(ARRAY['public.evidence_save_changes(uuid,integer,jsonb,uuid)',
                  'public.evidence_review_fields(uuid,integer,uuid,integer,text,text,uuid)',
                  'public.evidence_rebase_source(uuid,uuid,integer,text,uuid)']) sig;
SELECT is(
  (SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname COLLATE "C"), '') FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
      AND pg_temp.code(p.oid::regprocedure) ~* '(^|[^a-z_])execute[[:space:]]'),
  '', 'A6 no evidence function runs dynamic SQL');
SELECT is(
  (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.evidence_normalize_v1(text)'::regprocedure),
  '0e7c43b310ad58ab43e7d4d6f1ca411e', 'A7 evidence_normalize_v1 is PR-A2''s body, byte for byte: reused, not recreated');
SELECT is(
  (SELECT count(*)::int FROM pg_proc p
    WHERE p.oid IN ('public.evidence_save_changes(uuid,integer,jsonb,uuid)'::regprocedure,
                    'public.evidence_rebase_source(uuid,uuid,integer,text,uuid)'::regprocedure,
                    'public.evidence_locate_quote(text[],text)'::regprocedure)
      AND position('public.evidence_normalize_v1(' IN pg_temp.code(p.oid::regprocedure)) > 0),
  3, 'A7 save, rebase and locate_quote call the installed normalizer');
SELECT is(
  (SELECT string_agg(c.relname || '=' || (SELECT coalesce(string_agg(pr, ',' ORDER BY pr), '')
                                            FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) pr
                                           WHERE has_table_privilege('authenticated', c.oid, pr)),
                     ' ' ORDER BY c.relname COLLATE "C")
     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'evidence\_%'),
  'evidence_arms=SELECT evidence_events=SELECT evidence_field_anchors=SELECT evidence_field_values=SELECT '
  || 'evidence_outcomes=SELECT evidence_source_snapshots=SELECT evidence_studies=SELECT evidence_study_reports=SELECT',
  'A8 authenticated still holds exactly SELECT on each evidence table: the RPCs are the only write path');
SELECT is(
  (SELECT count(*)::int
     FROM pg_class c, unnest(ARRAY['anon', 'service_role']) r,
          unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) pr
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'evidence\_%'
      AND has_table_privilege(r, c.oid, pr)),
  0, 'A8 anon and service_role still hold nothing on any evidence table');
SELECT is(
  (SELECT string_agg(format_type(t, NULL), ',' ORDER BY ord)
     FROM pg_proc p, unnest(p.proargtypes) WITH ORDINALITY AS a(t, ord)
    WHERE p.oid = 'public.evidence_review_fields(uuid,integer,uuid,integer,text,text,uuid)'::regprocedure),
  'uuid,integer,uuid,integer,text,text,uuid',
  'A9 review_fields takes one value id and one version: no array or JSON argument, so no request can confirm two values');

-- ═════════════════════════════════════════════════════════════════════════════
-- B. The pilot gate and ownership
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'),
    jsonb_build_array(pg_temp.rv(pg_temp.st(), 'setting', NULL, pg_temp.txt('Outpatient clinics in Finland'))), 10)),
  'applied', 'B1 the owner saves a value in their own study');

SELECT pg_temp.keep('dig_m', pg_temp.digest(pg_temp.u('M')));
SELECT pg_temp.keep('dig_u', pg_temp.digest(pg_temp.u('U')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims(f.who), f.q), 'ERR 42501 evidence_records_not_enabled',
  'B2 ' || f.nm || ' is refused: not an owner')
FROM (VALUES
  ('M', 'a manager''s save',   pg_temp.q_save(pg_temp.s('SM'), 1, jsonb_build_array(pg_temp.rv(pg_temp.st(), 'setting', NULL, pg_temp.txt('x y z'))), pg_temp.rq(11))),
  ('M', 'a manager''s review', pg_temp.q_review(pg_temp.s('SM'), 1, '0339b001-0000-0000-0000-000000000000', 1, 'flag', 'Not sure', pg_temp.rq(12))),
  ('M', 'a manager''s rebase', pg_temp.q_rebase(pg_temp.s('SM'), pg_temp.p('PM'), 1, pg_temp.sha('Manager abstract.'), pg_temp.rq(13))),
  ('U', 'an ordinary user''s save',   pg_temp.q_save(pg_temp.s('SU'), 1, '[]'::jsonb, pg_temp.rq(14))),
  ('U', 'an ordinary user''s review', pg_temp.q_review(pg_temp.s('SU'), 1, pg_temp.rq(15), 1, 'confirm', NULL, pg_temp.rq(15))),
  ('U', 'an ordinary user''s rebase', pg_temp.q_rebase(pg_temp.s('SU'), pg_temp.p('PU'), 1, pg_temp.sha('User abstract.'), pg_temp.rq(16)))
) AS f(who, nm, q);
SELECT is(pg_temp.call('authenticated',
    '{"sub":"' || pg_temp.u('U')::text || '","role":"authenticated","app_metadata":{"role":"owner"},"user_metadata":{"role":"owner"}}',
    pg_temp.q_save(pg_temp.s('SU'), 1, '[]'::jsonb, pg_temp.rq(17))),
  'ERR 42501 evidence_records_not_enabled', 'B2 forged owner metadata in the JWT is ignored');
SELECT is(pg_temp.digest(pg_temp.u('M')) || ' ' || pg_temp.digest(pg_temp.u('U')),
  pg_temp.kept('dig_m') || ' ' || pg_temp.kept('dig_u'), 'B2 nothing of the manager''s or the user''s changed');

SELECT ok(pg_temp.call(f.role, '', f.q) LIKE 'ERR 42501 permission denied for function %',
  'B3 ' || f.role || ' is refused EXECUTE: ' || f.nm)
FROM (VALUES
  ('anon', 'save',   pg_temp.q_save(pg_temp.sid('s1'), 1, '[]'::jsonb, pg_temp.rq(18))),
  ('anon', 'review', pg_temp.q_review(pg_temp.sid('s1'), 1, pg_temp.rq(18), 1, 'confirm', NULL, pg_temp.rq(18))),
  ('anon', 'rebase', pg_temp.q_rebase(pg_temp.sid('s1'), pg_temp.p('PA'), 1, repeat('0', 64), pg_temp.rq(18))),
  ('anon', 'locate_quote', 'SELECT count(*)::text FROM public.evidence_locate_quote(ARRAY[''abc''], ''abc'')'),
  ('anon', 'state_reference_problems', 'SELECT public.evidence_state_reference_problems(''reported'', 0, 0, 0)::text'),
  ('anon', 'value_digest', 'SELECT public.evidence_value_digest(''' || pg_temp.u('O') || ''', ''' || pg_temp.u('O') || ''')::text'),
  ('service_role', 'save',   pg_temp.q_save(pg_temp.sid('s1'), 1, '[]'::jsonb, pg_temp.rq(19))),
  ('service_role', 'review', pg_temp.q_review(pg_temp.sid('s1'), 1, pg_temp.rq(19), 1, 'confirm', NULL, pg_temp.rq(19))),
  ('service_role', 'rebase', pg_temp.q_rebase(pg_temp.sid('s1'), pg_temp.p('PA'), 1, repeat('0', 64), pg_temp.rq(19))),
  ('service_role', 'locate_quote', 'SELECT count(*)::text FROM public.evidence_locate_quote(ARRAY[''abc''], ''abc'')'),
  ('service_role', 'state_reference_problems', 'SELECT public.evidence_state_reference_problems(''reported'', 0, 0, 0)::text'),
  ('service_role', 'value_digest', 'SELECT public.evidence_value_digest(''' || pg_temp.u('O') || ''', ''' || pg_temp.u('O') || ''')::text')
) AS f(role, nm, q);
SELECT ok(pg_temp.call('authenticated', pg_temp.claims('O'), f.q) LIKE 'ERR 42501 permission denied for function %',
  'B4 the helpers are internal: even the owner''s session cannot execute ' || f.nm)
FROM (VALUES
  ('evidence_locate_quote', 'SELECT count(*)::text FROM public.evidence_locate_quote(ARRAY[''abc''], ''abc'')'),
  ('evidence_state_reference_problems', 'SELECT public.evidence_state_reference_problems(''reported'', 0, 0, 0)::text'),
  ('evidence_value_digest', 'SELECT public.evidence_value_digest(''' || pg_temp.u('O') || ''', ''' || pg_temp.u('O') || ''')::text')
) AS f(nm, q);
SELECT is(pg_temp.call('authenticated', '{"role":"authenticated"}', f.q), 'ERR 42501 evidence_auth_required',
  'B5 no sub claim: ' || f.nm || ' is refused')
FROM (VALUES
  ('save',   pg_temp.q_save(pg_temp.sid('s1'), 1, '[]'::jsonb, pg_temp.rq(20))),
  ('review', pg_temp.q_review(pg_temp.sid('s1'), 1, pg_temp.rq(20), 1, 'confirm', NULL, pg_temp.rq(20))),
  ('rebase', pg_temp.q_rebase(pg_temp.sid('s1'), pg_temp.p('PA'), 1, repeat('0', 64), pg_temp.rq(20)))
) AS f(nm, q);

-- Someone else's study and an unknown one answer alike.
SELECT pg_temp.keep('dig_b', pg_temp.digest(pg_temp.u('B')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), f.q), 'ERR P0002 evidence_not_found', 'B6 ' || f.nm)
FROM (VALUES
  ('save into the neighbour''s study',   pg_temp.q_save(pg_temp.s('SN'), 1, jsonb_build_array(pg_temp.rv(pg_temp.st(), 'setting', NULL, pg_temp.txt('Hijack'))), pg_temp.rq(21))),
  ('save into an unknown study',         pg_temp.q_save(pg_temp.s('unknown'), 1, jsonb_build_array(pg_temp.rv(pg_temp.st(), 'setting', NULL, pg_temp.txt('Hijack'))), pg_temp.rq(22))),
  ('review in the neighbour''s study',   pg_temp.q_review(pg_temp.s('SN'), 1, '0339d001-0000-0000-0000-000000000000', 1, 'flag', 'Hijack', pg_temp.rq(23))),
  ('review in an unknown study',         pg_temp.q_review(pg_temp.s('unknown'), 1, '0339d001-0000-0000-0000-000000000000', 1, 'flag', 'Hijack', pg_temp.rq(24))),
  ('rebase of the neighbour''s study',   pg_temp.q_rebase(pg_temp.s('SN'), pg_temp.p('PN'), 1, pg_temp.sha('Neighbour abstract with type 2 diabetes.'), pg_temp.rq(25))),
  ('rebase of an unknown study',         pg_temp.q_rebase(pg_temp.s('unknown'), pg_temp.p('PN'), 1, pg_temp.sha('Neighbour abstract with type 2 diabetes.'), pg_temp.rq(26)))
) AS f(nm, q);

-- Inside the caller's own study, someone else's ids and another study's ids
-- are refused like ids that do not exist.
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), f.changes, 30 + f.n), f.expected, 'B7 ' || f.nm)
FROM (VALUES
  (1, 'a reference to the neighbour''s paper',
      jsonb_build_array(pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('Diabetes'), jsonb_build_array(pg_temp.ftl(pg_temp.p('PN'))))),
      'ERR P0002 evidence_link_not_found [p_changes[0].references[0].paper_id]'),
  (2, 'a quote on the neighbour''s copy',
      jsonb_build_array(pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('Diabetes'),
        jsonb_build_array(pg_temp.qt(pg_temp.p('PA'), '0336d001-0000-0000-0000-000000000000', 'type 2 diabetes')))),
      'ERR P0002 evidence_target_not_found [p_changes[0].references[0].snapshot_id]'),
  (3, 'keeping the neighbour''s reference',
      jsonb_build_array(pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('Diabetes'),
        jsonb_build_array(pg_temp.kp('033ad001-0000-0000-0000-000000000000')))),
      'ERR P0002 evidence_target_not_found [p_changes[0].references[0].anchor_id]'),
  (4, 'updating the neighbour''s group',
      jsonb_build_array(pg_temp.upd_arm('0337d001-0000-0000-0000-000000000000', 'comparator', 'Hijack', 0)),
      'ERR P0002 evidence_target_not_found [p_changes[0].arm_id]'),
  (5, 'a value on the neighbour''s outcome',
      jsonb_build_array(pg_temp.rv(pg_temp.ot('0338d001-0000-0000-0000-000000000000'), 'measurement_instrument', NULL, pg_temp.txt('Hijack'))),
      'ERR P0002 evidence_target_not_found [p_changes[0].target.outcome_id]'),
  (6, 'a quote on another study''s copy of another paper',
      jsonb_build_array(pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('Asthma'),
        jsonb_build_array(pg_temp.qt(pg_temp.p('PA'), (pg_temp.j('s3') ->> 'snapshot_id')::uuid, 'asthma')))),
      'ERR P0002 evidence_target_not_found [p_changes[0].references[0].snapshot_id]'),
  (7, 'a reference to a paper linked only to another study',
      jsonb_build_array(pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('Asthma'), jsonb_build_array(pg_temp.ftl(pg_temp.p('PC'))))),
      'ERR P0002 evidence_link_not_found [p_changes[0].references[0].paper_id]'),
  (8, 'a reference to an unknown paper',
      jsonb_build_array(pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('Asthma'), jsonb_build_array(pg_temp.ftl(pg_temp.p('unknown'))))),
      'ERR P0002 evidence_link_not_found [p_changes[0].references[0].paper_id]')
) AS f(n, nm, changes, expected);
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_review(pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), '0339d001-0000-0000-0000-000000000000', 1, 'flag', 'Hijack', pg_temp.rq(40))),
  'ERR P0002 evidence_target_not_found [p_value_id]', 'B7 reviewing the neighbour''s value inside one''s own study');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_rebase(pg_temp.sid('s1'), pg_temp.p('PN'), pg_temp.ver(pg_temp.sid('s1')), pg_temp.sha('Neighbour abstract with type 2 diabetes.'), pg_temp.rq(41))),
  'ERR P0002 evidence_link_not_found', 'B7 rebasing one''s own study onto the neighbour''s paper');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_rebase(pg_temp.sid('s1'), pg_temp.p('PC'), pg_temp.ver(pg_temp.sid('s1')), pg_temp.sha((SELECT abstract FROM public.papers WHERE id = pg_temp.p('PC'))), pg_temp.rq(42))),
  'ERR P0002 evidence_link_not_found', 'B7 rebasing onto one''s own paper that this study does not report');
SELECT is(pg_temp.digest(pg_temp.u('B')), pg_temp.kept('dig_b'), 'B8 nothing of the neighbour''s changed');

-- ═════════════════════════════════════════════════════════════════════════════
-- C. Groups and outcomes
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.status(pg_temp.run('c1', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_save(pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), jsonb_build_array(
      pg_temp.add_arm('met', 'intervention', 'Metformin', 0),
      pg_temp.add_arm('pla', 'comparator', 'Placebo', 1),
      pg_temp.add_out('hba1c', 'HbA1c', 0)), pg_temp.rq(50)))),
  'applied', 'C1 two groups and an outcome are added in one batch');
SELECT is((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(pg_temp.j('c1')) k),
  'arm_ids,outcome_ids,status,study_id,study_version', 'C1 the answer has exactly its documented keys');
SELECT is((SELECT string_agg(a.display_label || ':' || a.arm_role || ':' || a.position, ',' ORDER BY a.position)
             FROM public.evidence_arms a WHERE a.study_id = pg_temp.sid('s1')),
  'Metformin:intervention:0,Placebo:comparator:1', 'C1 the groups exist with their roles, labels and positions');
SELECT is((SELECT a.id FROM public.evidence_arms a WHERE a.study_id = pg_temp.sid('s1') AND a.display_label = 'Placebo'),
  (pg_temp.j('c1') -> 'arm_ids' ->> 'pla')::uuid, 'C1 arm_ids maps each ref to the id the server created');
SELECT is((SELECT o.id FROM public.evidence_outcomes o WHERE o.study_id = pg_temp.sid('s1')),
  (pg_temp.j('c1') -> 'outcome_ids' ->> 'hba1c')::uuid, 'C1 outcome_ids maps the outcome''s ref to its id');
SELECT pg_temp.keep('arm_met', pg_temp.j('c1') -> 'arm_ids' ->> 'met');
SELECT pg_temp.keep('arm_pla', pg_temp.j('c1') -> 'arm_ids' ->> 'pla');
SELECT pg_temp.keep('out_hba1c', pg_temp.j('c1') -> 'outcome_ids' ->> 'hba1c');
SELECT pg_temp.keep('h_early', (SELECT md5(string_agg(e::text, '|' ORDER BY e.study_version, e.ordinal)) FROM public.evidence_events e
                                  WHERE e.study_id = pg_temp.sid('s1') AND e.study_version <= 3));
SELECT is(
  (SELECT string_agg(e.ordinal || ' ' || e.event_type || ' ' || coalesce(e.after::text, '<null>'), ' | ' ORDER BY e.ordinal)
     FROM public.evidence_events e WHERE e.study_id = pg_temp.sid('s1') AND e.study_version = (pg_temp.j('c1') ->> 'study_version')::int),
  '0 request <null>'
  || ' | 1 arm_added {"arm_role": "intervention", "position": 0, "display_label": "Metformin"}'
  || ' | 2 arm_added {"arm_role": "comparator", "position": 1, "display_label": "Placebo"}'
  || ' | 3 outcome_added {"position": 0, "display_label": "HbA1c"}',
  'C1 one header, then one event per change in array order');

SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.upd_arm(pg_temp.kept('arm_met')::uuid, 'intervention', 'Metformin 1 g', 0)), 51)),
  'applied', 'C2 a group is renamed');
SELECT is(
  (SELECT e.before::text || ' -> ' || e.after::text FROM public.evidence_events e
    WHERE e.study_id = pg_temp.sid('s1') AND e.event_type = 'arm_updated' ORDER BY e.study_version DESC LIMIT 1),
  '{"display_label": "Metformin"} -> {"display_label": "Metformin 1 g"}', 'C2 arm_updated records the changed field only');
SELECT pg_temp.keep('v_c3', pg_temp.ver(pg_temp.sid('s1'))::text);
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.upd_arm(pg_temp.kept('arm_met')::uuid, 'intervention', 'Metformin 1 g', 0),
    pg_temp.upd_out(pg_temp.kept('out_hba1c')::uuid, 'HbA1c', 0)), 52),
  jsonb_build_object('status', 'unchanged', 'study_id', pg_temp.sid('s1'), 'study_version', pg_temp.kept('v_c3')::int,
                     'arm_ids', '{}'::jsonb, 'outcome_ids', '{}'::jsonb)::text,
  'C3 updates that change nothing answer unchanged');
SELECT is(pg_temp.ver(pg_temp.sid('s1')), pg_temp.kept('v_c3')::int, 'C3 and do not move the version');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.upd_arm(pg_temp.kept('arm_met')::uuid, 'intervention', 'Metformin 1 g', 1),
    pg_temp.upd_arm(pg_temp.kept('arm_pla')::uuid, 'comparator', 'Placebo', 0)), 53)),
  'applied', 'C4 two groups swap positions in one batch: only the final state must be free of ties');
SELECT is((SELECT string_agg(a.display_label, ',' ORDER BY a.position) FROM public.evidence_arms a WHERE a.study_id = pg_temp.sid('s1')),
  'Placebo,Metformin 1 g', 'C4 the order follows the new positions');
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), f.changes, 54), f.expected, 'C5 ' || f.nm)
FROM (VALUES
  ('a new group at a taken position', jsonb_build_array(pg_temp.add_arm('dup', 'intervention', 'Duplicate', 0)),
   'ERR 22023 evidence_invalid_input [p_changes: duplicate_arm_position]'),
  ('a new outcome at a taken position', jsonb_build_array(pg_temp.add_out('dup', 'Weight', 0)),
   'ERR 22023 evidence_invalid_input [p_changes: duplicate_outcome_position]'),
  ('half a swap', jsonb_build_array(pg_temp.upd_arm(pg_temp.kept('arm_pla')::uuid, 'comparator', 'Placebo', 1)),
   'ERR 22023 evidence_invalid_input [p_changes: duplicate_arm_position]')
) AS f(nm, changes, expected);

SELECT is(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(f.change), 55), f.expected, 'C6 ' || f.nm)
FROM (VALUES
  ('a ref with a space',           pg_temp.add_arm('bad ref', 'intervention', 'X', 5),    'ERR 22023 evidence_invalid_input [p_changes[0].ref: invalid]'),
  ('a 65-character ref',           pg_temp.add_arm(repeat('r', 65), 'intervention', 'X', 5), 'ERR 22023 evidence_invalid_input [p_changes[0].ref: invalid]'),
  ('an unknown role',              pg_temp.add_arm('r1', 'control', 'X', 5),             'ERR 22023 evidence_invalid_input [p_changes[0].arm_role: invalid]'),
  ('a blank label',                pg_temp.add_arm('r1', 'intervention', '   ', 5),      'ERR 22023 evidence_invalid_input [p_changes[0].display_label: invalid]'),
  ('a label blank after v1',       pg_temp.add_arm('r1', 'intervention', chr(0x00A0) || chr(0x200B) || chr(0x3000), 5),
                                                                                          'ERR 22023 evidence_invalid_input [p_changes[0].display_label: invalid]'),
  ('a 121-character group label',  pg_temp.add_arm('r1', 'intervention', repeat('L', 121), 5), 'ERR 22023 evidence_invalid_input [p_changes[0].display_label: invalid]'),
  ('a 201-character outcome label', pg_temp.add_out('r1', repeat('L', 201), 5),           'ERR 22023 evidence_invalid_input [p_changes[0].display_label: invalid]'),
  ('position 100',                 pg_temp.add_arm('r1', 'intervention', 'X', 100),       'ERR 22023 evidence_invalid_input [p_changes[0].position: invalid]'),
  ('position -1',                  pg_temp.add_arm('r1', 'intervention', 'X', -1),        'ERR 22023 evidence_invalid_input [p_changes[0].position: invalid]'),
  ('position 1.5',                 jsonb_set(pg_temp.add_arm('r1', 'intervention', 'X', 1), '{position}', '1.5'), 'ERR 22023 evidence_invalid_input [p_changes[0].position: invalid]'),
  ('position as a string',         jsonb_set(pg_temp.add_arm('r1', 'intervention', 'X', 1), '{position}', '"1"'), 'ERR 22023 evidence_invalid_input [p_changes[0].position: invalid]'),
  ('an invalid group id',          jsonb_build_object('op', 'remove_arm', 'arm_id', 'not-a-uuid'), 'ERR 22023 evidence_invalid_input [p_changes[0].arm_id: invalid]'),
  ('an unknown group id',          jsonb_build_object('op', 'remove_arm', 'arm_id', pg_temp.p('unknown')), 'ERR P0002 evidence_target_not_found [p_changes[0].arm_id]'),
  ('an unknown outcome id',        pg_temp.upd_out(pg_temp.p('unknown'), 'X', 9),        'ERR P0002 evidence_target_not_found [p_changes[0].outcome_id]'),
  ('a missing key',                jsonb_build_object('op', 'add_arm', 'ref', 'r1', 'arm_role', 'intervention', 'display_label', 'X'),
                                                                                          'ERR 22023 evidence_invalid_input [p_changes[0]: missing_key]'),
  ('an unknown key',               pg_temp.add_arm('r1', 'intervention', 'X', 5) || '{"colour": "red"}', 'ERR 22023 evidence_invalid_input [p_changes[0]: unknown_key]'),
  ('a server-owned key',           pg_temp.add_arm('r1', 'intervention', 'X', 5) || jsonb_build_object('id', pg_temp.p('unknown')),
                                                                                          'ERR 22023 evidence_invalid_input [p_changes[0]: server_attested]'),
  ('an unknown operation',         jsonb_build_object('op', 'merge_arms'),               'ERR 22023 evidence_invalid_input [p_changes[0].op: invalid]'),
  ('a change that is not an object', '"add_arm"'::jsonb,                                'ERR 22023 evidence_invalid_input [p_changes[0]: not_object]')
) AS f(nm, change, expected);
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), f.changes, 56), f.expected, 'C6 ' || f.nm)
FROM (VALUES
  ('a duplicate ref', jsonb_build_array(pg_temp.add_arm('same', 'intervention', 'X', 5), pg_temp.add_out('same', 'Y', 5)),
   'ERR 22023 evidence_invalid_input [p_changes[1].ref: duplicate]'),
  ('one group changed twice', jsonb_build_array(pg_temp.upd_arm(pg_temp.kept('arm_met')::uuid, 'intervention', 'A', 1),
                                                jsonb_build_object('op', 'remove_arm', 'arm_id', pg_temp.kept('arm_met'))),
   'ERR 22023 evidence_invalid_input [p_changes[1].arm_id: duplicate]'),
  ('a value on a group removed in the same batch',
   jsonb_build_array(jsonb_build_object('op', 'remove_arm', 'arm_id', pg_temp.kept('arm_met')),
                     pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'duration', NULL, pg_temp.txt('12 weeks'))),
   'ERR 22023 evidence_invalid_input [p_changes[1].target.arm_id: removed_in_batch]'),
  ('a value on a ref no change adds',
   jsonb_build_array(pg_temp.rv(pg_temp.aref('ghost'), 'duration', NULL, pg_temp.txt('12 weeks'))),
   'ERR 22023 evidence_invalid_input [p_changes[0].target.arm_ref: unknown_ref]')
) AS f(nm, changes, expected);

-- The design family: groups exist only in the intervention families.
SELECT is(pg_temp.save('O', pg_temp.sid('s4'), jsonb_build_array(pg_temp.add_arm('g', 'intervention', 'Exposed', 0)), 57),
  'ERR 22023 evidence_invalid_input [p_changes[0]: not_allowed_for_design]', 'C7 a non_intervention study takes no group');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s4'), jsonb_build_array(pg_temp.add_out('o', 'Incident cancer', 0)), 58)),
  'applied', 'C7 but takes outcomes');

-- comparator_type: comparator groups only, also after a role change.
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'comparator_type', NULL, pg_temp.cd('placebo'))), 59),
  'ERR 22023 evidence_invalid_input [p_changes[0].field_key: not_allowed_for_arm_role]', 'C8 an intervention group takes no comparator type');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.at(pg_temp.kept('arm_pla')::uuid), 'comparator_type', NULL, pg_temp.cd('placebo'),
               jsonb_build_array(pg_temp.qt(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA')), 'placebo', 1, 2)))), 60)),
  'applied', 'C8 a comparator group does');
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.upd_arm(pg_temp.kept('arm_pla')::uuid, 'intervention', 'Placebo', 0)), 61),
  'ERR 22023 evidence_invalid_input [p_changes[0]: comparator_type_present]',
  'C8 a comparator holding a comparator type cannot become an intervention group');
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('O'),
    pg_temp.q_save(pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), jsonb_build_array(
      pg_temp.upd_arm(pg_temp.kept('arm_pla')::uuid, 'intervention', 'Placebo', 0),
      pg_temp.cv(pg_temp.at(pg_temp.kept('arm_pla')::uuid), 'comparator_type', 1)), pg_temp.rq(62)),
    'SELECT arm_role FROM public.evidence_arms WHERE id = ''' || pg_temp.kept('arm_pla') || ''''),
  '00000 intervention', 'C8 unless the same batch clears it: the batch is judged by its final state');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.add_arm('usual', 'comparator', 'Usual care', 2),
    pg_temp.rv(pg_temp.aref('usual'), 'comparator_type', NULL, pg_temp.cd('usual_care'))), 63)),
  'applied', 'C9 a value can target a group added in the same batch, by its ref');
SELECT pg_temp.keep('arm_usual', (SELECT a.id::text FROM public.evidence_arms a WHERE a.study_id = pg_temp.sid('s1') AND a.display_label = 'Usual care'));

-- ═════════════════════════════════════════════════════════════════════════════
-- D. Values
-- ═════════════════════════════════════════════════════════════════════════════

-- D1 — every field key, in its scope, with its shape, stored exactly as sent.
SELECT is(pg_temp.status(pg_temp.run('d1', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_save(pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), jsonb_build_array(
      pg_temp.rv(pg_temp.st(), 'design_as_reported', NULL, pg_temp.txt('A randomized, double-blind trial')),
      pg_temp.rv(pg_temp.st(), 'design_classification', NULL, pg_temp.cd('rct_parallel')),
      pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst('["NCT01234567", "ISRCTN12345678"]')),
      pg_temp.rv(pg_temp.st(), 'population_description', NULL, pg_temp.txt('Adults with type 2 diabetes')),
      pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('Type 2 diabetes'),
                 jsonb_build_array(pg_temp.qt(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA')), 'type 2 diabetes'))),
      pg_temp.rv(pg_temp.st(), 'eligibility_criteria', NULL, pg_temp.txt('HbA1c 7-10%')),
      pg_temp.rv(pg_temp.st(), 'demographics', NULL, pg_temp.txt('Mean age 58')),
      pg_temp.rv(pg_temp.st(), 'n_randomized', NULL, pg_temp.cnt('n' || chr(0x2009) || '=' || chr(0x2009) || '120', '120'),
                 jsonb_build_array(pg_temp.qt(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA')), '(n = 120)'))),
      pg_temp.rv(pg_temp.st(), 'n_enrolled', NULL, pg_temp.cnt('120 enrolled', '120')),
      pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'arm_name_as_reported', NULL, pg_temp.txt('Metformin group')),
      pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'description', NULL, pg_temp.txt('Metformin 1 g twice daily')),
      pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'dose_or_intensity', NULL, pg_temp.txt('1 g')),
      pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'frequency', NULL, pg_temp.txt('Twice daily')),
      pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'duration', NULL, pg_temp.txt('12 weeks'),
                 jsonb_build_array(pg_temp.qt(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA')), '12 weeks'))),
      pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'delivery_mode', NULL, pg_temp.txt('Oral')),
      pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'co_interventions', NULL, pg_temp.txt('Diet advice')),
      pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'outcome_name_as_reported', NULL, pg_temp.txt('Glycated haemoglobin')),
      pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'outcome_definition', NULL, pg_temp.txt('HbA1c in %')),
      pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'measurement_instrument', NULL, pg_temp.txt('HPLC')),
      pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'outcome_designation', NULL, pg_temp.cd('primary')),
      pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'time_points', NULL, pg_temp.lst('["12 weeks", "6 months after randomization"]'))
    ), pg_temp.rq(70)))),
  'applied', 'D1 one batch records 21 of the 23 field keys (setting and comparator_type are already recorded)');
SELECT is(
  (SELECT string_agg(v.field_key || '=' || coalesce(v.value_text, '') || '/' || coalesce(v.value_code, '') || '/'
                     || coalesce(v.value_int::text, '') || '/' || coalesce(array_to_string(v.value_list, '|'), '')
                     || '@' || CASE WHEN v.arm_id IS NOT NULL THEN 'arm' WHEN v.outcome_id IS NOT NULL THEN 'outcome' ELSE 'study' END,
                     '; ' ORDER BY v.field_key COLLATE "C", v.value_code COLLATE "C")
     FROM public.evidence_field_values v WHERE v.study_id = pg_temp.sid('s1')),
  'arm_name_as_reported=Metformin group///@arm; co_interventions=Diet advice///@arm; comparator_type=/placebo//@arm; '
  || 'comparator_type=/usual_care//@arm; condition=Type 2 diabetes///@study; delivery_mode=Oral///@arm; '
  || 'demographics=Mean age 58///@study; description=Metformin 1 g twice daily///@arm; '
  || 'design_as_reported=A randomized, double-blind trial///@study; design_classification=/rct_parallel//@study; '
  || 'dose_or_intensity=1 g///@arm; duration=12 weeks///@arm; eligibility_criteria=HbA1c 7-10%///@study; '
  || 'frequency=Twice daily///@arm; measurement_instrument=HPLC///@outcome; n_enrolled=120 enrolled//120/@study; '
  || 'n_randomized=n' || chr(0x2009) || '=' || chr(0x2009) || '120//120/@study; outcome_definition=HbA1c in %///@outcome; '
  || 'outcome_designation=/primary//@outcome; outcome_name_as_reported=Glycated haemoglobin///@outcome; '
  || 'population_description=Adults with type 2 diabetes///@study; registration_ids=///NCT01234567|ISRCTN12345678@study; '
  || 'setting=Outpatient clinics in Finland///@study; time_points=///12 weeks|6 months after randomization@outcome',
  'D1 every value is stored in its columns exactly as sent, thin spaces included (nothing normalized or trimmed)');
SELECT is(
  (SELECT string_agg(DISTINCT v.review_status || ':' || v.value_version || ':' || v.extraction_method, ',')
     FROM public.evidence_field_values v WHERE v.study_id = pg_temp.sid('s1')),
  'unreviewed:1:manual', 'D1 every new value is manual, unreviewed, at value_version 1');

-- D2 — a field outside its scope, or unknown.
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(f.change), 71), f.expected, 'D2 ' || f.nm)
FROM (VALUES
  ('a group field at study level',   pg_temp.rv(pg_temp.st(), 'description', NULL, pg_temp.txt('x y z')),            'ERR 22023 evidence_invalid_input [p_changes[0].field_key: wrong_scope]'),
  ('a study field on a group',       pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'condition', NULL, pg_temp.txt('x y z')), 'ERR 22023 evidence_invalid_input [p_changes[0].field_key: wrong_scope]'),
  ('an outcome field at study level', pg_temp.rv(pg_temp.st(), 'time_points', NULL, pg_temp.lst('["1 week"]')),        'ERR 22023 evidence_invalid_input [p_changes[0].field_key: wrong_scope]'),
  ('a group field on an outcome',    pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'duration', NULL, pg_temp.txt('x y z')), 'ERR 22023 evidence_invalid_input [p_changes[0].field_key: wrong_scope]'),
  ('an unknown field key',           pg_temp.rv(pg_temp.st(), 'effect_size', NULL, pg_temp.txt('x y z')),            'ERR 22023 evidence_invalid_input [p_changes[0].field_key: unknown]'),
  ('the deferred n_randomized_arm',  pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'n_randomized_arm', NULL, pg_temp.cnt('60', '60')), 'ERR 22023 evidence_invalid_input [p_changes[0].field_key: unknown]'),
  ('a target with two scopes',       pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid) || jsonb_build_object('outcome_id', pg_temp.kept('out_hba1c')), 'duration', NULL, pg_temp.txt('x y z')),
                                                                                                                      'ERR 22023 evidence_invalid_input [p_changes[0].target: invalid]'),
  ('a target with no scope',         pg_temp.rv('{}'::jsonb, 'condition', NULL, pg_temp.txt('x y z')),               'ERR 22023 evidence_invalid_input [p_changes[0].target: invalid]')
) AS f(nm, change, expected);

-- D3 — the number randomized exists only in the intervention families.
SELECT is(pg_temp.save('O', pg_temp.sid('s4'), jsonb_build_array(pg_temp.rv(pg_temp.st(), 'n_randomized', NULL, pg_temp.cnt('2,000', '2000'))), 72),
  'ERR 22023 evidence_invalid_input [p_changes[0].field_key: not_allowed_for_design]', 'D3 a non_intervention study records no number randomized');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s4'), jsonb_build_array(pg_temp.rv(pg_temp.st(), 'n_enrolled', NULL, pg_temp.cnt('2,000 nurses', '2000'))), 73)),
  'applied', 'D3 but does record the number enrolled');

-- D4 — shapes and bounds (the PR-A1 CHECK bounds, plus the PO blank rule).
SELECT is(pg_temp.save('O', pg_temp.sid('s2'), jsonb_build_array(f.change), 74), f.expected, 'D4 ' || f.nm)
FROM (VALUES
  ('the wrong shape for the field',      pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.cd('rct_parallel')),        'ERR 22023 evidence_invalid_input [p_changes[0].content: wrong_shape]'),
  ('an extra key in the content',        pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('x y z') || '{"code": "x"}'), 'ERR 22023 evidence_invalid_input [p_changes[0].content: wrong_shape]'),
  ('no content for Reported',            pg_temp.rv(pg_temp.st(), 'condition', NULL, NULL),                              'ERR 22023 evidence_invalid_input [p_changes[0].content: wrong_shape]'),
  ('text that is not a string',          pg_temp.rv(pg_temp.st(), 'condition', NULL, jsonb_build_object('shape', 'text', 'text', 42)), 'ERR 22023 evidence_invalid_input [p_changes[0].content.text: invalid]'),
  ('text of spaces',                     pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('   ')),                 'ERR 22023 evidence_invalid_input [p_changes[0].content.text: blank]'),
  ('text blank after v1 only',           pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt(chr(0x00A0) || chr(0x200B) || chr(0x2060) || chr(0x0009))),
                                                                                                                         'ERR 22023 evidence_invalid_input [p_changes[0].content.text: blank]'),
  ('501 characters of condition',        pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt(repeat('c', 501))),         'ERR 22023 evidence_invalid_input [p_changes[0].content.text: too_long]'),
  ('1,001 characters of setting',        pg_temp.rv(pg_temp.st(), 'setting', NULL, pg_temp.txt(repeat('s', 1001))),          'ERR 22023 evidence_invalid_input [p_changes[0].content.text: too_long]'),
  ('2,001 characters of demographics',   pg_temp.rv(pg_temp.st(), 'demographics', NULL, pg_temp.txt(repeat('d', 2001))),     'ERR 22023 evidence_invalid_input [p_changes[0].content.text: too_long]'),
  ('4,001 characters of eligibility',    pg_temp.rv(pg_temp.st(), 'eligibility_criteria', NULL, pg_temp.txt(repeat('e', 4001))), 'ERR 22023 evidence_invalid_input [p_changes[0].content.text: too_long]'),
  ('a code outside its list',            pg_temp.rv(pg_temp.st(), 'design_classification', NULL, pg_temp.cd('meta_analysis')), 'ERR 22023 evidence_invalid_input [p_changes[0].content.code: not_in_list]'),
  ('a code of the wrong list',           pg_temp.rv(pg_temp.st(), 'design_classification', NULL, pg_temp.cd('placebo')),      'ERR 22023 evidence_invalid_input [p_changes[0].content.code: not_in_list]'),
  ('a number above 10,000,000',          pg_temp.rv(pg_temp.st(), 'n_randomized', NULL, pg_temp.cnt('10000001', '10000001')), 'ERR 22023 evidence_invalid_input [p_changes[0].content.value: invalid]'),
  ('a negative number',                  pg_temp.rv(pg_temp.st(), 'n_randomized', NULL, pg_temp.cnt('-1', '-1')),              'ERR 22023 evidence_invalid_input [p_changes[0].content.value: invalid]'),
  ('a fractional number',                pg_temp.rv(pg_temp.st(), 'n_randomized', NULL, pg_temp.cnt('12.5', '12.5')),          'ERR 22023 evidence_invalid_input [p_changes[0].content.value: invalid]'),
  ('a number as a string',               pg_temp.rv(pg_temp.st(), 'n_randomized', NULL, pg_temp.cnt('120', '"120"')),           'ERR 22023 evidence_invalid_input [p_changes[0].content.value: invalid]'),
  ('a number without its integer',       pg_temp.rv(pg_temp.st(), 'n_randomized', NULL, pg_temp.cnt('120', 'null')),            'ERR 22023 evidence_invalid_input [p_changes[0].content.value: invalid]'),
  ('a blank reported text',              pg_temp.rv(pg_temp.st(), 'n_randomized', NULL, pg_temp.cnt(chr(0x2009), '1')),         'ERR 22023 evidence_invalid_input [p_changes[0].content.reported_text: blank]'),
  ('201 characters of reported text',    pg_temp.rv(pg_temp.st(), 'n_randomized', NULL, pg_temp.cnt(repeat('1', 201), '1')),    'ERR 22023 evidence_invalid_input [p_changes[0].content.reported_text: too_long]'),
  ('content on a Not reported value',    pg_temp.sv(pg_temp.st(), 'condition', NULL, 'not_reported', NULL, pg_temp.txt('x y z'), NULL, jsonb_build_array(pg_temp.exf(pg_temp.p('PB')))),
                                                                                                                         'ERR 22023 evidence_invalid_input [p_changes[0].content: not_allowed]')
) AS f(nm, change, expected);
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s2'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt(repeat('c', 500))),
    pg_temp.rv(pg_temp.st(), 'eligibility_criteria', NULL, pg_temp.txt(repeat('e', 4000))),
    pg_temp.rv(pg_temp.st(), 'n_randomized', NULL, pg_temp.cnt('ten million', '10000000')),
    pg_temp.rv(pg_temp.st(), 'n_enrolled', NULL, pg_temp.cnt('none', '0'))), 75)),
  'applied', 'D4 the exact upper bounds, and zero, are accepted');

-- D5 — lists: never trimmed, never de-duplicated silently.
SELECT is(pg_temp.save('O', pg_temp.sid('s2'), jsonb_build_array(f.change), 76), f.expected, 'D5 ' || f.nm)
FROM (VALUES
  ('no registration number',           pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst('[]')),                       'ERR 22023 evidence_invalid_input [p_changes[0].content.entries: empty]'),
  ('six registration numbers',         pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst('["NCT1", "NCT2", "NCT3", "NCT4", "NCT5", "NCT6"]')), 'ERR 22023 evidence_invalid_input [p_changes[0].content.entries: too_many]'),
  ('eleven time points',               pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'time_points', NULL, pg_temp.lst('["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]')),
                                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].content.entries: too_many]'),
  ('a list that is not an array',      pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst('"NCT01234567"')),            'ERR 22023 evidence_invalid_input [p_changes[0].content.entries: invalid]'),
  ('an entry that is not text',        pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst('[12345]')),                   'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: not_text]'),
  ('a two-character number',           pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst('["NC"]')),                    'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: too_short]'),
  ('a 51-character number',            pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst(to_jsonb(ARRAY[repeat('N', 51)]))),         'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: too_long]'),
  ('a number with a space',            pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst('["NCT 01234567"]')),          'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: contains_whitespace]'),
  ('a number with a no-break space',   pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst(to_jsonb(ARRAY['NCT' || chr(0x00A0) || '01234567']))),
                                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: contains_whitespace]'),
  ('a number with NEXT LINE',          pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst(to_jsonb(ARRAY['NCT' || chr(0x0085) || '01234567']))),
                                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: contains_whitespace]'),
  ('a number with an ideographic space', pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst(to_jsonb(ARRAY['NCT' || chr(0x3000) || '01234567']))),
                                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: contains_whitespace]'),
  ('a duplicate number',               pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst('["NCT01234567", "NCT01234567"]')), 'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[1]: duplicate]'),
  ('a blank entry (zero-width only)',  pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst(to_jsonb(ARRAY[chr(0x200B) || chr(0x200B) || chr(0x200B)]))),
                                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: blank]'),
  ('U+001F in an entry',               pg_temp.rv(pg_temp.st(), 'registration_ids', NULL, pg_temp.lst(to_jsonb(ARRAY['NCT' || chr(0x001F) || '0123']))), 'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: forbidden_character]'),
  ('a time point with a leading space', pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'time_points', NULL, pg_temp.lst('[" 12 weeks"]')), 'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: untrimmed]'),
  ('a time point with a trailing tab', pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'time_points', NULL, pg_temp.lst(to_jsonb(ARRAY['12 weeks' || chr(0x0009)]))),
                                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: untrimmed]'),
  ('a time point with a trailing no-break space', pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'time_points', NULL, pg_temp.lst(to_jsonb(ARRAY['12 weeks' || chr(0x00A0)]))),
                                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: untrimmed]'),
  ('a 101-character time point',       pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'time_points', NULL, pg_temp.lst(to_jsonb(ARRAY[repeat('t', 101)]))), 'ERR 22023 evidence_invalid_input [p_changes[0].content.entries[0]: too_long]')
) AS f(nm, change, expected);
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'time_points', 1,
               to_jsonb(ARRAY['12' || chr(0x00A0) || 'weeks', 't', repeat('t', 100), '6 months', '12 weeks']))), 77)),
  'ERR 22023 evidence_invalid_input [p_changes[0].content: wrong_shape]', 'D5 a bare array is not a list content: the shape is named');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'time_points', 1,
               pg_temp.lst(to_jsonb(ARRAY['12' || chr(0x00A0) || 'weeks', 't', repeat('t', 100), '6 months', '12 weeks'])))), 78)),
  'applied', 'D5 time points may hold inner white space (a no-break space), one character, or exactly 100');
SELECT is((SELECT v.value_list FROM public.evidence_field_values v WHERE v.id = pg_temp.vid(pg_temp.sid('s1'), 'time_points', NULL, pg_temp.kept('out_hba1c')::uuid)),
  ARRAY['12' || chr(0x00A0) || 'weeks', 't', repeat('t', 100), '6 months', '12 weeks'],
  'D5 and the entries are stored as sent: the no-break space is kept, and "12 weeks" and "12<NBSP>weeks" are different entries');

-- D6 — states, reasons and notes.
SELECT is(pg_temp.save('O', pg_temp.sid('s2'), jsonb_build_array(f.change), 79), f.expected, 'D6 ' || f.nm)
FROM (VALUES
  ('an unknown state',                     pg_temp.sv(pg_temp.st(), 'condition', NULL, 'missing', NULL, NULL, NULL), 'ERR 22023 evidence_invalid_input [p_changes[0].value_state: invalid]'),
  ('Unclear without a reason',             pg_temp.sv(pg_temp.st(), 'condition', NULL, 'unclear', NULL, NULL, 'Two different conditions', jsonb_build_array(pg_temp.exf(pg_temp.p('PB')))),
                                                                                                               'ERR 22023 evidence_invalid_input [p_changes[0].state_reason: invalid]'),
  ('Unclear with an unknown reason',       pg_temp.sv(pg_temp.st(), 'condition', NULL, 'unclear', 'vague', NULL, 'Two different conditions', jsonb_build_array(pg_temp.exf(pg_temp.p('PB')))),
                                                                                                               'ERR 22023 evidence_invalid_input [p_changes[0].state_reason: invalid]'),
  ('a reason on a Reported value',         pg_temp.sv(pg_temp.st(), 'condition', NULL, 'reported', 'ambiguous', pg_temp.txt('x y z'), NULL), 'ERR 22023 evidence_invalid_input [p_changes[0].state_reason: not_allowed]'),
  ('Unclear with a 9-character note',      pg_temp.sv(pg_temp.st(), 'condition', NULL, 'unclear', 'ambiguous', NULL, '123456789', jsonb_build_array(pg_temp.exf(pg_temp.p('PB')))),
                                                                                                               'ERR 22023 evidence_invalid_input [p_changes[0].note: required]'),
  ('Unclear with no note',                 pg_temp.sv(pg_temp.st(), 'condition', NULL, 'unclear', 'ambiguous', NULL, NULL, jsonb_build_array(pg_temp.exf(pg_temp.p('PB')))),
                                                                                                               'ERR 22023 evidence_invalid_input [p_changes[0].note: required]'),
  ('a note of only v1-invisible characters', pg_temp.sv(pg_temp.st(), 'condition', NULL, 'unclear', 'ambiguous', NULL, repeat(chr(0x00A0), 12), jsonb_build_array(pg_temp.exf(pg_temp.p('PB')))),
                                                                                                               'ERR 22023 evidence_invalid_input [p_changes[0].note: blank]'),
  ('a 2,001-character note',               pg_temp.sv(pg_temp.st(), 'condition', NULL, 'reported', NULL, pg_temp.txt('x y z'), repeat('n', 2001)), 'ERR 22023 evidence_invalid_input [p_changes[0].note: too_long]'),
  ('a note that is not text',              pg_temp.sv(pg_temp.st(), 'condition', NULL, 'reported', NULL, pg_temp.txt('x y z'), NULL) || '{"note": 7}', 'ERR 22023 evidence_invalid_input [p_changes[0].note: invalid]'),
  ('Not applicable with a 2-character note', pg_temp.sv(pg_temp.st(), 'condition', NULL, 'not_applicable', NULL, NULL, 'no'), 'ERR 22023 evidence_invalid_input [p_changes[0].note: required]'),
  ('Not applicable with no note',          pg_temp.sv(pg_temp.st(), 'condition', NULL, 'not_applicable', NULL, NULL, NULL), 'ERR 22023 evidence_invalid_input [p_changes[0].note: required]')
) AS f(nm, change, expected);
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s2'), jsonb_build_array(
    pg_temp.sv(pg_temp.st(), 'setting', NULL, 'not_applicable', NULL, NULL, 'N/A'),
    pg_temp.sv(pg_temp.st(), 'demographics', NULL, 'unclear', 'incomplete', NULL, 'Only the mean age is given', jsonb_build_array(pg_temp.exf(pg_temp.p('PB')))),
    pg_temp.sv(pg_temp.st(), 'design_as_reported', NULL, 'not_reported', NULL, NULL, NULL, jsonb_build_array(pg_temp.exf(pg_temp.p('PB'), 'section', 'Methods'))),
    pg_temp.sv(pg_temp.st(), 'population_description', NULL, 'source_unavailable', NULL, NULL, NULL,
               jsonb_build_array(pg_temp.una('abstract', pg_temp.p('PB')), pg_temp.una('full_text', pg_temp.p('PB'))))), 80)),
  'applied', 'D6 each missing-value state with its required parts: Not applicable (3-character note), Unclear, Not reported, Couldn''t check');

-- D7 — FK-PROOF-001 §J through the RPC (the full count grid is section J).
SELECT is(pg_temp.save('O', pg_temp.sid('s2'), jsonb_build_array(f.change), 81), f.expected, 'D7 ' || f.nm)
FROM (VALUES
  ('Not reported with nothing examined',   pg_temp.sv(pg_temp.st(), 'condition', 1, 'not_reported', NULL, NULL, NULL),
                                                                    'ERR 22023 evidence_invalid_input [p_changes[0].references: examined_required]'),
  ('Not reported with only "unavailable"', pg_temp.sv(pg_temp.st(), 'condition', 1, 'not_reported', NULL, NULL, NULL, jsonb_build_array(pg_temp.una('full_text', pg_temp.p('PB')))),
                                                                    'ERR 22023 evidence_invalid_input [p_changes[0].references: examined_required]'),
  ('Not reported with a supporting source', pg_temp.sv(pg_temp.st(), 'condition', 1, 'not_reported', NULL, NULL, NULL, jsonb_build_array(pg_temp.exf(pg_temp.p('PB')), pg_temp.ftl(pg_temp.p('PB')))),
                                                                    'ERR 22023 evidence_invalid_input [p_changes[0].references: supporting_not_allowed]'),
  ('Reported with an examined source',     pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('x y z'), jsonb_build_array(pg_temp.exf(pg_temp.p('PB')))),
                                                                    'ERR 22023 evidence_invalid_input [p_changes[0].references: examined_not_allowed]'),
  ('Reported with an unavailable source',  pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('x y z'), jsonb_build_array(pg_temp.una('full_text', pg_temp.p('PB')))),
                                                                    'ERR 22023 evidence_invalid_input [p_changes[0].references: unavailable_not_allowed]'),
  ('Unclear with only "unavailable"',      pg_temp.sv(pg_temp.st(), 'condition', 1, 'unclear', 'ambiguous', NULL, 'Two conditions given', jsonb_build_array(pg_temp.una('full_text', pg_temp.p('PB')))),
                                                                    'ERR 22023 evidence_invalid_input [p_changes[0].references: basis_required]'),
  ('Not applicable with a source',         pg_temp.sv(pg_temp.st(), 'condition', 1, 'not_applicable', NULL, NULL, 'N/A', jsonb_build_array(pg_temp.exf(pg_temp.p('PB')))),
                                                                    'ERR 22023 evidence_invalid_input [p_changes[0].references: not_allowed]'),
  ('Couldn''t check with nothing unavailable', pg_temp.sv(pg_temp.st(), 'condition', 1, 'source_unavailable', NULL, NULL, NULL),
                                                                    'ERR 22023 evidence_invalid_input [p_changes[0].references: unavailable_required]'),
  ('Couldn''t check with an examined source', pg_temp.sv(pg_temp.st(), 'condition', 1, 'source_unavailable', NULL, NULL, NULL,
                                                         jsonb_build_array(pg_temp.una('abstract', pg_temp.p('PB')), pg_temp.exf(pg_temp.p('PB')))),
                                                                    'ERR 22023 evidence_invalid_input [p_changes[0].references: examined_not_allowed]'),
  ('four supporting sources',              pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('x y z'),
                                                      jsonb_build_array(pg_temp.ftl(pg_temp.p('PB'), 'page', '1'), pg_temp.ftl(pg_temp.p('PB'), 'page', '2'),
                                                                        pg_temp.ftl(pg_temp.p('PB'), 'page', '3'), pg_temp.ftl(pg_temp.p('PB'), 'page', '4'))),
                                                                    'ERR 22023 evidence_invalid_input [p_changes[0].references: too_many_supporting]')
) AS f(nm, change, expected);
-- PO decisions 2 and 3: a Reported value with no source, design_classification
-- included, may be SAVED (it reads "No source given" and cannot be confirmed).
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s2'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'design_classification', NULL, pg_temp.cd('rct_parallel')),
    pg_temp.sv(pg_temp.st(), 'registration_ids', NULL, 'reported', NULL, pg_temp.lst('["NCT00000001"]'), 'From the registry')), 82)),
  'applied', 'D7 a Reported value without any source is saved (PO decisions 2 and 3)');

-- D8 — the per-row matrix, forged and unknown keys.
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('Type 2 diabetes'), jsonb_build_array(f.ref))), 83), f.expected, 'D8 ' || f.nm)
FROM (VALUES
  ('a full-text reference with a quote',     pg_temp.ftl(pg_temp.p('PA')) || '{"quote_text": "type 2 diabetes"}',   'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: wrong_keys]'),
  ('a full-text reference naming a copy',    pg_temp.ftl(pg_temp.p('PA')) || jsonb_build_object('snapshot_id', pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA'))),
                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: wrong_keys]'),
  ('a supporting full text without a locator', pg_temp.ftl(pg_temp.p('PA'), NULL, NULL),                             'ERR 22023 evidence_invalid_input [p_changes[0].references[0].locator_kind: invalid]'),
  ('an unknown locator kind',                pg_temp.ftl(pg_temp.p('PA'), 'chapter', 'Two'),                         'ERR 22023 evidence_invalid_input [p_changes[0].references[0].locator_kind: invalid]'),
  ('a blank locator',                        pg_temp.ftl(pg_temp.p('PA'), 'page', chr(0x2009) || chr(0x200B)),        'ERR 22023 evidence_invalid_input [p_changes[0].references[0].locator_text: invalid]'),
  ('a 201-character locator',                pg_temp.ftl(pg_temp.p('PA'), 'page', repeat('p', 201)),                 'ERR 22023 evidence_invalid_input [p_changes[0].references[0].locator_text: invalid]'),
  ('an abstract quote without its copy',     pg_temp.qt(pg_temp.p('PA'), NULL, 'type 2 diabetes'),                   'ERR 22023 evidence_invalid_input [p_changes[0].references[0].snapshot_id: invalid]'),
  ('a client-supplied match_start',          pg_temp.qt(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA')), 'type 2 diabetes') || '{"match_start": 0}',
                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: server_attested]'),
  ('a client-supplied matched_at',           pg_temp.qt(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA')), 'type 2 diabetes') || '{"matched_at": "2026-01-01T00:00:00Z"}',
                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: server_attested]'),
  ('a client-supplied match_count',          pg_temp.qt(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA')), 'type 2 diabetes') || '{"match_count": 1}',
                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: server_attested]'),
  ('a client-supplied normalization_version', pg_temp.qt(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA')), 'type 2 diabetes') || '{"normalization_version": "v1"}',
                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: server_attested]'),
  ('a client-supplied position',             pg_temp.ftl(pg_temp.p('PA')) || '{"position": 0}',                     'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: server_attested]'),
  ('a kept reference that also edits',       pg_temp.kp(pg_temp.p('unknown')) || '{"quote_text": "edited"}',         'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: unknown_key]'),
  ('a kept reference forging its match',     pg_temp.kp(pg_temp.p('unknown')) || '{"match_end": 9}',                 'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: server_attested]'),
  ('a non-library source',                   pg_temp.ftl(pg_temp.p('PA')) || '{"source_kind": "other_source"}',      'ERR 22023 evidence_invalid_input [p_changes[0].references[0].source_kind: invalid]'),
  ('an unknown purpose',                     pg_temp.ftl(pg_temp.p('PA')) || '{"purpose": "contradicts"}',           'ERR 22023 evidence_invalid_input [p_changes[0].references[0].purpose: invalid]'),
  ('a reference that is not an object',      '"type 2 diabetes"'::jsonb,                                              'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: not_object]'),
  ('occurrence without the count seen',      pg_temp.qt(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA')), 'placebo', 2, NULL),
                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].references[0].occurrence: invalid]'),
  ('occurrence above the count seen',        pg_temp.qt(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA')), 'placebo', 3, 2),
                                                                                                                   'ERR 22023 evidence_invalid_input [p_changes[0].references[0].occurrence: invalid]')
) AS f(nm, ref, expected);
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(f.change), 84), f.expected, 'D8 ' || f.nm)
FROM (VALUES
  ('a client-supplied value_version',  pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('x y z')) || '{"value_version": 9}',   'ERR 22023 evidence_invalid_input [p_changes[0]: server_attested]'),
  ('a client-supplied review_status',  pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('x y z')) || '{"review_status": "user_reviewed"}', 'ERR 22023 evidence_invalid_input [p_changes[0]: server_attested]'),
  ('a client-supplied reviewed_at',    pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('x y z')) || '{"reviewed_at": "2026-01-01"}',     'ERR 22023 evidence_invalid_input [p_changes[0]: server_attested]'),
  ('a client-supplied extraction_method', pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('x y z')) || '{"extraction_method": "ai"}', 'ERR 22023 evidence_invalid_input [p_changes[0]: server_attested]'),
  ('a client-supplied user_id',        pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('x y z')) || jsonb_build_object('user_id', pg_temp.u('B')), 'ERR 22023 evidence_invalid_input [p_changes[0]: server_attested]'),
  ('references that are not a list',   pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('x y z')) || '{"references": {}}',         'ERR 22023 evidence_invalid_input [p_changes[0].references: invalid]')
) AS f(nm, change, expected);

-- D9 — what references name: the link, its copy, the CURRENT copy.
SELECT is(pg_temp.save('O', pg_temp.sid(f.study), jsonb_build_array(f.change), 85), f.expected, 'D9 ' || f.nm)
FROM (VALUES
  ('s1', 'a quote on another link''s copy',
   pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('Type 2 diabetes'), jsonb_build_array(pg_temp.qt(pg_temp.p('PA'), '0336a004-0000-0000-0000-000000000002', 'participants'))),
   'ERR P0002 evidence_target_not_found [p_changes[0].references[0].snapshot_id]'),
  ('s1', 'a new quote on a superseded copy',
   pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('Type 2 diabetes'), jsonb_build_array(pg_temp.qt(pg_temp.p('PD'), '0336a004-0000-0000-0000-000000000001', 'participants'))),
   'ERR 22023 evidence_invalid_input [p_changes[0].references[0].snapshot_id: not_current]'),
  ('s1', 'a new examined abstract on a superseded copy',
   pg_temp.sv(pg_temp.st(), 'demographics', 1, 'not_reported', NULL, NULL, NULL, jsonb_build_array(pg_temp.exa(pg_temp.p('PD'), '0336a004-0000-0000-0000-000000000001'))),
   'ERR 22023 evidence_invalid_input [p_changes[0].references[0].snapshot_id: not_current]'),
  ('s1', '"abstract unavailable" for a link that has a copy',
   pg_temp.sv(pg_temp.st(), 'demographics', 1, 'source_unavailable', NULL, NULL, NULL, jsonb_build_array(pg_temp.una('abstract', pg_temp.p('PA')))),
   'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: unavailable_abstract_has_copy]'),
  ('s1', 'two assessments of one source',
   pg_temp.sv(pg_temp.st(), 'demographics', 1, 'not_reported', NULL, NULL, NULL,
              jsonb_build_array(pg_temp.exf(pg_temp.p('PE1')), pg_temp.una('full_text', pg_temp.p('PE1')))),
   'ERR 22023 evidence_invalid_input [p_changes[0].references[1]: duplicate_assessment]'),
  ('s1', 'eleven assessments',
   pg_temp.sv(pg_temp.st(), 'demographics', 1, 'not_reported', NULL, NULL, NULL, jsonb_build_array(
     pg_temp.exa(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA'))), pg_temp.exf(pg_temp.p('PA')),
     pg_temp.exa(pg_temp.p('PD'), '0336a004-0000-0000-0000-000000000002'), pg_temp.exf(pg_temp.p('PD')),
     pg_temp.una('abstract', pg_temp.p('PE1')), pg_temp.una('full_text', pg_temp.p('PE1')),
     pg_temp.una('abstract', pg_temp.p('PE2')), pg_temp.una('full_text', pg_temp.p('PE2')),
     pg_temp.una('abstract', pg_temp.p('PE3')), pg_temp.una('full_text', pg_temp.p('PE3')),
     pg_temp.una('abstract', pg_temp.p('PE4')))),
   'ERR 22023 evidence_invalid_input [p_changes[0].references: too_many_assessments]')
) AS f(study, nm, change, expected);
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.sv(pg_temp.st(), 'demographics', 1, 'not_reported', NULL, NULL, NULL, jsonb_build_array(
      pg_temp.exa(pg_temp.p('PA'), pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA'))), pg_temp.exf(pg_temp.p('PA')),
      pg_temp.exa(pg_temp.p('PD'), '0336a004-0000-0000-0000-000000000002'), pg_temp.exf(pg_temp.p('PD')),
      pg_temp.una('abstract', pg_temp.p('PE1')), pg_temp.una('full_text', pg_temp.p('PE1')),
      pg_temp.una('abstract', pg_temp.p('PE2')), pg_temp.una('full_text', pg_temp.p('PE2')),
      pg_temp.una('abstract', pg_temp.p('PE3')), pg_temp.una('full_text', pg_temp.p('PE3'))))), 86)),
  'applied', 'D9 ten assessments, each of one source, scoped to the reports examined: accepted');

-- D10 — server-side quote matching against PA's current copy.
SELECT pg_temp.keep('pa_copy', pg_temp.cur(pg_temp.sid('s1'), pg_temp.p('PA'))::text);
SELECT pg_temp.keep('pa_norm', (SELECT public.evidence_normalize_v1(c.exact_text) FROM public.evidence_source_snapshots c WHERE c.id = pg_temp.kept('pa_copy')::uuid));
SELECT is(pg_temp.save('O', pg_temp.sid('s2'), jsonb_build_array(f.change), 87), f.expected, 'D10 a quote on a copy of the right link is still checked: ' || f.nm)
FROM (VALUES
  ('a link without a copy has no quotes',
   pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('x y z'), jsonb_build_array(pg_temp.qt(pg_temp.p('PB'), pg_temp.kept('pa_copy')::uuid, 'type 2 diabetes'))),
   'ERR P0002 evidence_target_not_found [p_changes[0].references[0].snapshot_id]')
) AS f(nm, change, expected);
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'population_description', 1, pg_temp.txt('Adults with type 2 diabetes'),
               jsonb_build_array(pg_temp.qt(pg_temp.p('PA'), pg_temp.kept('pa_copy')::uuid, f.quote, f.occ, f.cnt)))), 88),
  f.expected, 'D10 ' || f.nm)
FROM (VALUES
  ('a quote not in the copy',                'type 1 diabetes', NULL::int, NULL::int, 'ERR P0001 evidence_quote_not_found [p_changes[0].references[0].quote_text]'),
  ('case counts',                            'Type 2 Diabetes', NULL, NULL,           'ERR P0001 evidence_quote_not_found [p_changes[0].references[0].quote_text]'),
  ('a superscript is not a digit (no NFKC)', '105 cells', NULL, NULL,                 'ERR P0001 evidence_quote_not_found [p_changes[0].references[0].quote_text]'),
  ('a subscript is not a digit',             'H2O', NULL, NULL,                       'ERR P0001 evidence_quote_not_found [p_changes[0].references[0].quote_text]'),
  ('an ellipsis is not a wildcard',          'randomized ... metformin', NULL, NULL,  'ERR P0001 evidence_quote_not_found [p_changes[0].references[0].quote_text]'),
  ('a removed soft hyphen is not a hyphen',  'Follow-up', NULL, NULL,                 'ERR P0001 evidence_quote_not_found [p_changes[0].references[0].quote_text]'),
  ('two occurrences, none chosen',           'placebo', NULL, NULL,                   'ERR P0001 evidence_quote_ambiguous [p_changes[0].references[0].quote_text]'),
  ('an occurrence with the wrong count seen', 'placebo', 1, 3,                         'ERR P0001 evidence_quote_ambiguous [p_changes[0].references[0].quote_text]'),
  ('a unique quote with an occurrence of 2', 'type 2 diabetes', 2, 2,                  'ERR P0001 evidence_quote_ambiguous [p_changes[0].references[0].quote_text]'),
  ('three overlapping occurrences, none chosen', 'aba', NULL, NULL,                    'ERR P0001 evidence_quote_ambiguous [p_changes[0].references[0].quote_text]'),
  ('two characters',                         'ty', NULL, NULL,                        'ERR 22023 evidence_invalid_input [p_changes[0].references[0].quote_text: invalid]'),
  ('punctuation only',                       '...;', NULL, NULL,                      'ERR 22023 evidence_invalid_input [p_changes[0].references[0].quote_text: invalid]'),
  ('too short once normalized',              'a' || chr(0x200B) || chr(0x200B) || 'b', NULL, NULL, 'ERR 22023 evidence_invalid_input [p_changes[0].references[0].quote_text: invalid]'),
  ('1,001 characters',                       repeat('x', 1001), NULL, NULL,           'ERR 22023 evidence_invalid_input [p_changes[0].references[0].quote_text: invalid]'),
  ('Arabic-Indic digits only (no letter or ASCII digit)', chr(0x0661) || chr(0x0662) || chr(0x0660), NULL, NULL,
                                                                                        'ERR 22023 evidence_invalid_input [p_changes[0].references[0].quote_text: invalid]')
) AS f(nm, quote, occ, cnt, expected);
SELECT is(pg_temp.save('O', pg_temp.sid('s5'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('Repetition'),
               jsonb_build_array(pg_temp.qt(pg_temp.p('PG'), pg_temp.cur(pg_temp.sid('s5'), pg_temp.p('PG')), 'aaa', 1, 101)))), 89),
  'ERR P0001 evidence_quote_ambiguous [p_changes[0].references[0].quote_text]',
  'D10 more than 100 occurrences are never enumerated: even an occurrence with the right count is ambiguous');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s5'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('Repetition'),
               jsonb_build_array(pg_temp.qt(pg_temp.p('PG'), pg_temp.cur(pg_temp.sid('s5'), pg_temp.p('PG')), 'Repeated: aaa')))), 90)),
  'applied', 'D10 a few more words make it unique');

-- Accepted quotes: each stores the server's match, and the offsets select the
-- normalized quote out of the normalized copy (0-based, half-open, code points).
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'population_description', pg_temp.vv(pg_temp.vid(pg_temp.sid('s1'), 'population_description')),
               pg_temp.txt('Adults with type 2 diabetes'), jsonb_build_array(
      pg_temp.qt(pg_temp.p('PA'), pg_temp.kept('pa_copy')::uuid, 'placebo', 2, 2),
      pg_temp.qt(pg_temp.p('PA'), pg_temp.kept('pa_copy')::uuid, 'x' || chr(0x1D400) || 'y'),
      pg_temp.qt(pg_temp.p('PA'), pg_temp.kept('pa_copy')::uuid, chr(0x201C) || 'double-blind"' || chr(0x2026)))),
    pg_temp.rv(pg_temp.st(), 'eligibility_criteria', pg_temp.vv(pg_temp.vid(pg_temp.sid('s1'), 'eligibility_criteria')),
               pg_temp.txt('HbA1c 7-10%'), jsonb_build_array(
      pg_temp.qt(pg_temp.p('PA'), pg_temp.kept('pa_copy')::uuid, 'aba', 3, 3),
      pg_temp.qt(pg_temp.p('PA'), pg_temp.kept('pa_copy')::uuid, '10' || chr(0x2075) || ' cells per ' || chr(0x03BC) || 'L'),
      pg_temp.qt(pg_temp.p('PA'), pg_temp.kept('pa_copy')::uuid, 'H' || chr(0x2082) || 'O'))),
    pg_temp.rv(pg_temp.st(), 'demographics', pg_temp.vv(pg_temp.vid(pg_temp.sid('s1'), 'demographics')),
               pg_temp.txt('Mean age 58'), jsonb_build_array(
      pg_temp.qt(pg_temp.p('PA'), pg_temp.kept('pa_copy')::uuid, 'caf' || chr(0x00E9) || ' H'),
      pg_temp.qt(pg_temp.p('PA'), pg_temp.kept('pa_copy')::uuid, ' Followup 12' || chr(0x200B) || ' '),
      pg_temp.qt(pg_temp.p('PA'), pg_temp.kept('pa_copy')::uuid, 'per ' || chr(0x00B5) || 'L')))), 91)),
  'applied', 'D10 nine quotes, chosen occurrences, supplementary, combining, zero-width and micro-sign characters, all matched');
SELECT is(
  (SELECT string_agg(format('%s|%s/%s|%s', substr(pg_temp.kept('pa_norm'), a.match_start + 1, a.match_end - a.match_start)
                              = public.evidence_normalize_v1(a.quote_text),
                            a.match_occurrence, a.match_count, a.match_start), ' ; ' ORDER BY v.field_key, a.position)
     FROM public.evidence_field_anchors a JOIN public.evidence_field_values v ON v.id = a.value_id
    WHERE a.study_id = pg_temp.sid('s1') AND v.field_key IN ('population_description', 'eligibility_criteria', 'demographics')),
  (SELECT string_agg(format('t|%s/%s|%s', x.occ, x.cnt, x.start), ' ; ' ORDER BY x.ord)
     FROM (VALUES (1, 1, 1, strpos(pg_temp.kept('pa_norm'), 'caf' || chr(0x00E9) || ' H') - 1),
                  (2, 1, 1, strpos(pg_temp.kept('pa_norm'), 'Followup 12') - 1),
                  (3, 1, 1, strpos(pg_temp.kept('pa_norm'), 'per ' || chr(0x03BC) || 'L') - 1),
                  (4, 3, 3, strpos(pg_temp.kept('pa_norm'), 'abababa') - 1 + 4),
                  (5, 1, 1, strpos(pg_temp.kept('pa_norm'), '10' || chr(0x2075) || ' cells') - 1),
                  (6, 1, 1, strpos(pg_temp.kept('pa_norm'), 'H' || chr(0x2082) || 'O') - 1),
                  (7, 2, 2, strpos(pg_temp.kept('pa_norm'), 'placebo-like') - 1),
                  (8, 1, 1, strpos(pg_temp.kept('pa_norm'), 'x' || chr(0x1D400) || 'y') - 1),
                  (9, 1, 1, strpos(pg_temp.kept('pa_norm'), '"double-blind"...') - 1)) AS x(ord, occ, cnt, start)),
  'D10 each offset range slices the normalized quote out of the normalized copy; occurrences and counts are the server''s (computed here by strpos)');
SELECT is(
  (SELECT string_agg(a.quote_text, ' | ' ORDER BY a.match_start) FROM public.evidence_field_anchors a
    JOIN public.evidence_field_values v ON v.id = a.value_id WHERE v.id = pg_temp.vid(pg_temp.sid('s1'), 'demographics')),
  'per ' || chr(0x00B5) || 'L | caf' || chr(0x00E9) || ' H |  Followup 12' || chr(0x200B) || ' ',
  'D10 the quote is stored as the user wrote it, not normalized');
SELECT is(
  (SELECT string_agg(DISTINCT a.normalization_version || ':' || (a.matched_at = now())::text, ',')
     FROM public.evidence_field_anchors a WHERE a.study_id = pg_temp.sid('s1') AND a.quote_text IS NOT NULL),
  'v1:true', 'D10 every stored quote carries normalization v1 and the server''s match time');

-- D11 — no-ops, kept references, versions, the review reset.
SELECT pg_temp.keep('cond', pg_temp.vid(pg_temp.sid('s1'), 'condition')::text);
SELECT pg_temp.keep('cond_anchor', (SELECT a.id::text FROM public.evidence_field_anchors a WHERE a.value_id = pg_temp.kept('cond')::uuid));
SELECT pg_temp.keep('v_d11', pg_temp.ver(pg_temp.sid('s1'))::text);
SELECT pg_temp.keep('ev_d11', (SELECT count(*)::text FROM public.evidence_events WHERE study_id = pg_temp.sid('s1')));
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('Type 2 diabetes'), jsonb_build_array(pg_temp.kp(pg_temp.kept('cond_anchor')::uuid)))), 100)),
  'unchanged', 'D11 resending a value exactly as stored, its reference kept by id, answers unchanged');
SELECT is((SELECT count(*)::text FROM public.evidence_events WHERE study_id = pg_temp.sid('s1')) || ' ' || pg_temp.ver(pg_temp.sid('s1')),
  pg_temp.kept('ev_d11') || ' ' || pg_temp.kept('v_d11'), 'D11 and writes no event and no new version');
SELECT is((SELECT count(*)::int FROM public.evidence_events WHERE request_id = pg_temp.rq(100)), 0, 'D11 its request id is not consumed');
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(f.change), 101), f.expected, 'D11 ' || f.nm)
FROM (VALUES
  ('a value recorded since, sent as new',  pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('T2D')), 'ERR P0001 evidence_version_conflict [p_changes[0].expected_value_version]'),
  ('a stale value version',               pg_temp.rv(pg_temp.st(), 'condition', 2, pg_temp.txt('T2D')),    'ERR P0001 evidence_version_conflict [p_changes[0].expected_value_version]'),
  ('a version for a value not recorded',  pg_temp.rv(pg_temp.at(pg_temp.kept('arm_usual')::uuid), 'duration', 1, pg_temp.txt('x y z')),
                                                                                                            'ERR P0001 evidence_version_conflict [p_changes[0].expected_value_version]'),
  ('clearing at a stale version',          pg_temp.cv(pg_temp.ot(pg_temp.kept('out_hba1c')::uuid), 'outcome_designation', 9), 'ERR P0001 evidence_version_conflict [p_changes[0].expected_value_version]'),
  ('clearing a value not recorded',        pg_temp.cv(pg_temp.at(pg_temp.kept('arm_usual')::uuid), 'frequency', 1), 'ERR P0001 evidence_version_conflict [p_changes[0].expected_value_version]'),
  ('clearing without a version',          pg_temp.cv(pg_temp.st(), 'condition', NULL),                      'ERR 22023 evidence_invalid_input [p_changes[0].expected_value_version: invalid]'),
  ('a version of 0',                      pg_temp.rv(pg_temp.st(), 'condition', 0, pg_temp.txt('T2D')),    'ERR 22023 evidence_invalid_input [p_changes[0].expected_value_version: invalid]'),
  ('keeping another value''s reference',  pg_temp.rv(pg_temp.st(), 'demographics', pg_temp.vv(pg_temp.vid(pg_temp.sid('s1'), 'demographics')), pg_temp.txt('Mean age 58'),
                                                     jsonb_build_array(pg_temp.kp(pg_temp.kept('cond_anchor')::uuid))),
                                          'ERR P0002 evidence_target_not_found [p_changes[0].references[0].anchor_id]'),
  ('keeping one reference twice',          pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('Type 2 diabetes'),
                                                     jsonb_build_array(pg_temp.kp(pg_temp.kept('cond_anchor')::uuid), pg_temp.kp(pg_temp.kept('cond_anchor')::uuid))),
                                          'ERR 22023 evidence_invalid_input [p_changes[0].references[1].anchor_id: duplicate]')
) AS f(nm, change, expected);
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'condition', 1, pg_temp.txt('T2D')), pg_temp.cv(pg_temp.st(), 'condition', 1)), 102),
  'ERR 22023 evidence_invalid_input [p_changes[1]: duplicate_target]', 'D11 one field changed twice in a batch is refused');

-- Confirm the condition, then edit only its note: the review is cleared.
SELECT is(pg_temp.status(pg_temp.review('O', pg_temp.sid('s1'), pg_temp.kept('cond')::uuid, 'confirm', 'Checked twice', 103)), 'applied',
  'D12 the condition is confirmed');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.sv(pg_temp.st(), 'condition', 1, 'reported', NULL, pg_temp.txt('Type 2 diabetes'), 'Adults only',
               jsonb_build_array(pg_temp.kp(pg_temp.kept('cond_anchor')::uuid)))), 104)),
  'applied', 'D12 a note-only edit of a confirmed value is saved');
SELECT is(
  (SELECT format('%s|%s|%s|%s|%s|%s', v.review_status, coalesce(v.reviewed_at::text, '-'), coalesce(v.reviewed_version::text, '-'),
                 coalesce(v.review_note, '-'), v.value_version, v.note)
     FROM public.evidence_field_values v WHERE v.id = pg_temp.kept('cond')::uuid),
  'unreviewed|-|-|-|2|Adults only', 'D12 any change returns the value to unreviewed, clears the review and increments value_version');
SELECT is(
  (SELECT e.before -> 'review' ->> 'status' || ' -> ' || (e.after -> 'review' ->> 'status')
     FROM public.evidence_events e WHERE e.study_id = pg_temp.sid('s1') AND e.request_id = pg_temp.rq(104) AND e.ordinal = 1),
  'user_reviewed -> unreviewed', 'D12 value_saved records the review it cleared');
SELECT is((SELECT a.id::text FROM public.evidence_field_anchors a WHERE a.value_id = pg_temp.kept('cond')::uuid),
  pg_temp.kept('cond_anchor'), 'D12 the kept reference keeps its id');

-- Kept references: reordering moves positions only; removing compacts them.
SELECT pg_temp.keep('pop', pg_temp.vid(pg_temp.sid('s1'), 'population_description')::text);
SELECT pg_temp.keep('pop_refs', (SELECT string_agg(a.id::text || '@' || a.match_start || '/' || a.match_occurrence || '/' || a.matched_at, ',' ORDER BY a.id)
                                   FROM public.evidence_field_anchors a WHERE a.value_id = pg_temp.kept('pop')::uuid));
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'population_description', pg_temp.vv(pg_temp.kept('pop')::uuid), pg_temp.txt('Adults with type 2 diabetes'),
      (SELECT jsonb_agg(pg_temp.kp(a.id) ORDER BY a.position DESC) FROM public.evidence_field_anchors a WHERE a.value_id = pg_temp.kept('pop')::uuid))), 105)),
  'applied', 'D13 reversing the order of three kept quotes is a change');
SELECT is((SELECT string_agg(a.id::text || '@' || a.match_start || '/' || a.match_occurrence || '/' || a.matched_at, ',' ORDER BY a.id)
             FROM public.evidence_field_anchors a WHERE a.value_id = pg_temp.kept('pop')::uuid),
  pg_temp.kept('pop_refs'), 'D13 each kept quote keeps its id, its match and its match time');
-- In the copy the quotes come in the order placebo, "double-blind", the astral
-- one, and they were saved at positions 0, 2, 1; reversed, they are 2, 0, 1.
SELECT is((SELECT string_agg(a.position::text, ',' ORDER BY a.match_start) FROM public.evidence_field_anchors a WHERE a.value_id = pg_temp.kept('pop')::uuid),
  '2,0,1', 'D13 only the positions follow the new order');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'population_description', pg_temp.vv(pg_temp.kept('pop')::uuid), pg_temp.txt('Adults with type 2 diabetes'),
      (SELECT jsonb_agg(pg_temp.kp(a.id) ORDER BY a.position) FROM public.evidence_field_anchors a
        WHERE a.value_id = pg_temp.kept('pop')::uuid AND a.position <> 1))), 106)),
  'applied', 'D13 dropping the middle quote is a change');
SELECT is((SELECT string_agg(a.position::text, ',' ORDER BY a.position) FROM public.evidence_field_anchors a WHERE a.value_id = pg_temp.kept('pop')::uuid),
  '0,1', 'D13 the remaining quotes are renumbered 0 and 1');

-- Clearing a value.
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.cv(pg_temp.st(), 'population_description', pg_temp.vv(pg_temp.kept('pop')::uuid))), 107)),
  'applied', 'D14 a value is cleared');
SELECT is((SELECT count(*)::int FROM public.evidence_field_values WHERE id = pg_temp.kept('pop')::uuid)
          + (SELECT count(*)::int FROM public.evidence_field_anchors WHERE value_id = pg_temp.kept('pop')::uuid),
  0, 'D14 it and its references are gone: the field is Not yet recorded again');
SELECT is((SELECT e.event_type || ' ' || e.field_key || ' ' || (e.before ->> 'value_id') || ' ' || coalesce(e.after::text, '<null>')
             FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(107) AND e.ordinal = 1),
  'value_cleared population_description ' || pg_temp.kept('pop') || ' <null>', 'D14 value_cleared records what was cleared');

-- Partial no-op: only the real change writes.
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.sv(pg_temp.st(), 'condition', 2, 'reported', NULL, pg_temp.txt('Type 2 diabetes'), 'Adults only',
               jsonb_build_array(pg_temp.kp(pg_temp.kept('cond_anchor')::uuid))),
    pg_temp.rv(pg_temp.st(), 'demographics', pg_temp.vv(pg_temp.vid(pg_temp.sid('s1'), 'demographics')), pg_temp.txt('Mean age 58.2'),
      (SELECT jsonb_agg(pg_temp.kp(a.id) ORDER BY a.position) FROM public.evidence_field_anchors a
        WHERE a.value_id = pg_temp.vid(pg_temp.sid('s1'), 'demographics')))), 108)),
  'applied', 'D15 a batch with one unchanged and one changed value is applied');
SELECT is((SELECT string_agg(e.event_type || ':' || coalesce(e.field_key, '-'), ',' ORDER BY e.ordinal) FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(108)),
  'request:-,value_saved:demographics', 'D15 and records only the value that changed');

-- D16 — the history digest of a value holds no text, only fingerprints.
SELECT is(
  (SELECT string_agg(k, ',' ORDER BY k COLLATE "C") FROM jsonb_object_keys((SELECT e.after FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(108) AND e.ordinal = 1)) k),
  'arm_id,content,field_key,note,outcome_id,references,review,state_reason,value_id,value_state,value_version',
  'D16 a value digest has exactly its documented keys');
SELECT is(
  (SELECT e.after -> 'content' FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(108) AND e.ordinal = 1),
  jsonb_build_object('text', jsonb_build_object('sha256', pg_temp.sha('Mean age 58.2'), 'chars', 13)),
  'D16 text content is recorded as {sha256, chars}');
SELECT is(
  (SELECT string_agg(DISTINCT (r ? 'quote')::text || (r -> 'quote' ? 'sha256')::text || (r ? 'snapshot_seq')::text, ',')
     FROM public.evidence_events e, jsonb_array_elements(e.after -> 'references') r
    WHERE e.request_id = pg_temp.rq(108) AND e.ordinal = 1),
  'truetruetrue', 'D16 each quote is a fingerprint, with the seq of its copy');

-- D17 — payload-level validation.
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), f.q), f.expected, 'D17 ' || f.nm)
FROM (VALUES
  ('a NULL study',            pg_temp.q_save(NULL, 1, '[]'::jsonb, pg_temp.rq(110)),                       'ERR 22023 evidence_invalid_input [p_study_id]'),
  ('a NULL expected version', pg_temp.q_save(pg_temp.sid('s1'), NULL, '[]'::jsonb, pg_temp.rq(110)),        'ERR 22023 evidence_invalid_input [p_expected_version]'),
  ('expected version 0',      pg_temp.q_save(pg_temp.sid('s1'), 0, '[]'::jsonb, pg_temp.rq(110)),           'ERR 22023 evidence_invalid_input [p_expected_version]'),
  ('NULL changes',            pg_temp.q_save(pg_temp.sid('s1'), 1, NULL, pg_temp.rq(110)),                  'ERR 22023 evidence_invalid_input [p_changes]'),
  ('changes as an object',    pg_temp.q_save(pg_temp.sid('s1'), 1, '{"op": "add_arm"}'::jsonb, pg_temp.rq(110)), 'ERR 22023 evidence_invalid_input [p_changes]'),
  ('a NULL request id',       pg_temp.q_save(pg_temp.sid('s1'), 1, jsonb_build_array(pg_temp.add_out('late', 'Weight', 9)), NULL), 'ERR 22023 evidence_invalid_input [p_request_id]'),
  ('a stale study version',   pg_temp.q_save(pg_temp.sid('s1'), 1, jsonb_build_array(pg_temp.add_out('late', 'Weight', 9)), pg_temp.rq(110)), 'ERR P0001 evidence_version_conflict')
) AS f(nm, q, expected);

-- D17 — a batch holds 1 to 200 changes. An empty one is refused before any
-- table is read or locked, so it writes nothing, creates no request header and
-- consumes no request id. A batch of no-ops is not empty: it answers unchanged.
SELECT pg_temp.keep('v_d17', pg_temp.ver(pg_temp.sid('s1'))::text);
SELECT pg_temp.keep('dig_d17', pg_temp.digest(pg_temp.u('O')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), f.q), 'ERR 22023 evidence_invalid_input [p_changes: empty]',
  'D17 an empty batch is refused ' || f.nm)
FROM (VALUES
  ('at the current version',     pg_temp.q_save(pg_temp.sid('s1'), pg_temp.kept('v_d17')::int, '[]'::jsonb, pg_temp.rq(111))),
  ('at a stale version',         pg_temp.q_save(pg_temp.sid('s1'), 1, '[]'::jsonb, pg_temp.rq(111))),
  ('for an unknown study',       pg_temp.q_save(pg_temp.s('unknown'), 1, '[]'::jsonb, pg_temp.rq(111))),
  ('with a committed request id', pg_temp.q_save(pg_temp.sid('s1'), pg_temp.kept('v_d17')::int, '[]'::jsonb, pg_temp.rq(108)))
) AS f(nm, q);
SELECT pg_temp.keep('d17_noop', jsonb_build_array(
    (SELECT pg_temp.upd_arm(a.id, a.arm_role, a.display_label, a.position) FROM public.evidence_arms a WHERE a.id = pg_temp.kept('arm_met')::uuid),
    (SELECT pg_temp.upd_out(o.id, o.display_label, o.position) FROM public.evidence_outcomes o WHERE o.id = pg_temp.kept('out_hba1c')::uuid),
    pg_temp.rv(pg_temp.st(), 'demographics', pg_temp.vv(pg_temp.vid(pg_temp.sid('s1'), 'demographics')), pg_temp.txt('Mean age 58.2'),
      (SELECT jsonb_agg(pg_temp.kp(a.id) ORDER BY a.position) FROM public.evidence_field_anchors a
        WHERE a.value_id = pg_temp.vid(pg_temp.sid('s1'), 'demographics'))))::text);
SELECT is(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(pg_temp.kept('d17_noop')::jsonb -> 2), 112),
  jsonb_build_object('status', 'unchanged', 'study_id', pg_temp.sid('s1'), 'study_version', pg_temp.kept('v_d17')::int,
                     'arm_ids', '{}'::jsonb, 'outcome_ids', '{}'::jsonb)::text,
  'D17 a batch of one unchanged change is not empty: unchanged, at the current version');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), pg_temp.kept('d17_noop')::jsonb, 113)), 'unchanged',
  'D17 nor is a batch of unchanged changes of every kind: a group, an outcome and a value');
SELECT is(pg_temp.digest(pg_temp.u('O')) || ' ' || pg_temp.ver(pg_temp.sid('s1')),
  pg_temp.kept('dig_d17') || ' ' || pg_temp.kept('v_d17'),
  'D17 none of these calls wrote anything: the owner''s rows, history and study version are as they were');
SELECT is((SELECT count(*)::int FROM public.evidence_events WHERE request_id IN (pg_temp.rq(111), pg_temp.rq(112), pg_temp.rq(113))), 0,
  'D17 and no request header exists for any of their ids');

-- The refused id is still free: it carries a batch mixing those no-ops with
-- one real change, of which only the real change is written. Afterwards an
-- empty batch on that id is still refused, neither replayed nor reused, and
-- the batch itself replays its original answer.
SELECT pg_temp.keep('d17_rows',
  (SELECT a::text FROM public.evidence_arms a WHERE a.id = pg_temp.kept('arm_met')::uuid) || ' '
  || (SELECT o::text FROM public.evidence_outcomes o WHERE o.id = pg_temp.kept('out_hba1c')::uuid) || ' '
  || (SELECT v::text FROM public.evidence_field_values v WHERE v.id = pg_temp.vid(pg_temp.sid('s1'), 'demographics')));
SELECT pg_temp.keep('d17_mixed', (pg_temp.kept('d17_noop')::jsonb || jsonb_build_array(pg_temp.add_out('d17', 'Waist circumference', 11)))::text);
SELECT is(pg_temp.status(pg_temp.run('d17', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_save(pg_temp.sid('s1'), pg_temp.kept('v_d17')::int, pg_temp.kept('d17_mixed')::jsonb, pg_temp.rq(111)))),
  'applied', 'D17 the refused request id then carries a mixed batch: applied');
SELECT is((SELECT string_agg(e.event_type || ':' || coalesce(e.field_key, '-'), ',' ORDER BY e.ordinal) FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(111))
          || ' ' || pg_temp.ver(pg_temp.sid('s1')),
  'request:-,outcome_added:- ' || (pg_temp.kept('v_d17')::int + 1),
  'D17 one new version, one header and one event: only the real change is recorded');
SELECT is(
  (SELECT a::text FROM public.evidence_arms a WHERE a.id = pg_temp.kept('arm_met')::uuid) || ' '
  || (SELECT o::text FROM public.evidence_outcomes o WHERE o.id = pg_temp.kept('out_hba1c')::uuid) || ' '
  || (SELECT v::text FROM public.evidence_field_values v WHERE v.id = pg_temp.vid(pg_temp.sid('s1'), 'demographics')),
  pg_temp.kept('d17_rows'), 'D17 and the group, outcome and value it left unchanged are untouched');
SELECT pg_temp.keep('dig_d17b', pg_temp.digest(pg_temp.u('O')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_save(pg_temp.sid('s1'), pg_temp.kept('v_d17')::int, '[]'::jsonb, pg_temp.rq(111))),
  'ERR 22023 evidence_invalid_input [p_changes: empty]', 'D17 an empty batch on that id, now committed, is still refused');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_save(pg_temp.sid('s1'), pg_temp.kept('v_d17')::int, pg_temp.kept('d17_mixed')::jsonb, pg_temp.rq(111))),
  (pg_temp.j('d17') || '{"status": "replayed"}')::text, 'D17 and the batch itself still replays its original answer');
SELECT is(pg_temp.digest(pg_temp.u('O')), pg_temp.kept('dig_d17b'), 'D17 neither the refusal nor the replay wrote anything');

-- ═════════════════════════════════════════════════════════════════════════════
-- E. Review
-- ═════════════════════════════════════════════════════════════════════════════

-- E1 — Confirm, and its no-op.
SELECT pg_temp.keep('dur', pg_temp.vid(pg_temp.sid('s1'), 'duration', pg_temp.kept('arm_met')::uuid)::text);
SELECT is(pg_temp.status(pg_temp.run('e1', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_review(pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), pg_temp.kept('dur')::uuid, 1, 'confirm', NULL, pg_temp.rq(120)))),
  'applied', 'E1 a Reported value with a quote on the current copy is confirmed');
SELECT is((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(pg_temp.j('e1')) k),
  'review_status,status,study_id,study_version,value_id,value_version', 'E1 the answer has exactly its documented keys');
SELECT is(
  (SELECT format('%s|%s|%s|%s', v.review_status, v.reviewed_at = now(), v.reviewed_version, v.value_version)
     FROM public.evidence_field_values v WHERE v.id = pg_temp.kept('dur')::uuid),
  'user_reviewed|t|1|1', 'E1 Confirm records the server''s time and the exact version; value_version itself does not move');
SELECT is(
  (SELECT e.event_type || ' ' || (e.after -> 'review' ->> 'status') || ' ' || (e.after -> 'references' -> 0 ->> 'snapshot_seq')
          || ' ' || (e.after -> 'references' -> 0 ->> 'anchor_id' IS NOT NULL)::text
     FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(120) AND e.ordinal = 1),
  'review_confirmed user_reviewed 1 true', 'E1 review_confirmed names each reference and the seq of its copy (001A §I4)');
SELECT pg_temp.keep('v_e1', pg_temp.ver(pg_temp.sid('s1'))::text);
SELECT is(pg_temp.status(pg_temp.review('O', pg_temp.sid('s1'), pg_temp.kept('dur')::uuid, 'confirm', NULL, 121)), 'unchanged',
  'E1 confirming the confirmed version again is a no-op');
SELECT is(pg_temp.ver(pg_temp.sid('s1')), pg_temp.kept('v_e1')::int, 'E1 that writes nothing');
SELECT is(pg_temp.status(pg_temp.review('O', pg_temp.sid('s1'), pg_temp.kept('dur')::uuid, 'confirm', 'Matches Table 1', 122)), 'applied',
  'E1 confirming again with a new note is a new confirmation');
SELECT is(pg_temp.status(pg_temp.review('O', pg_temp.sid('s1'), pg_temp.kept('dur')::uuid, 'confirm', 'Matches Table 1', 123)), 'unchanged',
  'E1 and repeating it is a no-op');

-- E2 — Flag, and Confirm from Flagged.
SELECT is(pg_temp.status(pg_temp.review('O', pg_temp.sid('s1'), pg_temp.kept('dur')::uuid, 'flag', 'Check the full text', 124)), 'applied',
  'E2 a confirmed value is flagged');
SELECT is(
  (SELECT format('%s|%s|%s|%s', v.review_status, coalesce(v.reviewed_at::text, '-'), coalesce(v.reviewed_version::text, '-'), v.review_note)
     FROM public.evidence_field_values v WHERE v.id = pg_temp.kept('dur')::uuid),
  'disputed|-|-|Check the full text', 'E2 Flagged keeps its note and no review time or version');
SELECT is(pg_temp.status(pg_temp.review('O', pg_temp.sid('s1'), pg_temp.kept('dur')::uuid, 'flag', 'Check the full text', 125)), 'unchanged',
  'E2 flagging it again with the same note is a no-op');
SELECT is(
  (SELECT (e.before -> 'review' ->> 'status') || ' -> ' || (e.after -> 'review' ->> 'status') || ' ' || (e.after -> 'review' -> 'note' ->> 'sha256')
     FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(124) AND e.ordinal = 1),
  'user_reviewed -> disputed ' || pg_temp.sha('Check the full text'), 'E2 review_flagged keeps the previous state and the note''s fingerprint');
SELECT is(pg_temp.status(pg_temp.review('O', pg_temp.sid('s1'), pg_temp.kept('dur')::uuid, 'confirm', NULL, 126)), 'applied',
  'E2 a flagged value is confirmed again');
SELECT is((SELECT v.review_status || '|' || coalesce(v.review_note, '-') FROM public.evidence_field_values v WHERE v.id = pg_temp.kept('dur')::uuid),
  'user_reviewed|-', 'E2 and the flag''s note is gone from the row (history keeps it)');

-- E3 — notes and arguments.
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_review(f.study, f.version, f.value, f.vver, f.action, f.note, f.req)), f.expected, 'E3 ' || f.nm)
FROM (VALUES
  ('a flag without a note',          pg_temp.sid('s1'), 1, pg_temp.kept('dur')::uuid, 1, 'flag', NULL::text, pg_temp.rq(130),     'ERR 22023 evidence_invalid_input [p_note]'),
  ('a 2-character flag note',        pg_temp.sid('s1'), 1, pg_temp.kept('dur')::uuid, 1, 'flag', 'no', pg_temp.rq(130),           'ERR 22023 evidence_invalid_input [p_note]'),
  ('a flag note blank after v1',     pg_temp.sid('s1'), 1, pg_temp.kept('dur')::uuid, 1, 'flag', repeat(chr(0x00A0), 5), pg_temp.rq(130), 'ERR 22023 evidence_invalid_input [p_note]'),
  ('a 2,001-character note',         pg_temp.sid('s1'), 1, pg_temp.kept('dur')::uuid, 1, 'flag', repeat('n', 2001), pg_temp.rq(130), 'ERR 22023 evidence_invalid_input [p_note]'),
  ('an empty Confirm note',          pg_temp.sid('s1'), 1, pg_temp.kept('dur')::uuid, 1, 'confirm', '', pg_temp.rq(130),          'ERR 22023 evidence_invalid_input [p_note]'),
  ('an unknown action',              pg_temp.sid('s1'), 1, pg_temp.kept('dur')::uuid, 1, 'confirm_all', NULL, pg_temp.rq(130),    'ERR 22023 evidence_invalid_input [p_action]'),
  ('a NULL value',                   pg_temp.sid('s1'), 1, NULL, 1, 'confirm', NULL, pg_temp.rq(130),                             'ERR 22023 evidence_invalid_input [p_value_id]'),
  ('a NULL value version',           pg_temp.sid('s1'), 1, pg_temp.kept('dur')::uuid, NULL, 'confirm', NULL, pg_temp.rq(130),     'ERR 22023 evidence_invalid_input [p_expected_value_version]'),
  ('a NULL study',                   NULL, 1, pg_temp.kept('dur')::uuid, 1, 'confirm', NULL, pg_temp.rq(130),                     'ERR 22023 evidence_invalid_input [p_study_id]'),
  ('a NULL request id',              pg_temp.sid('s1'), 1, pg_temp.kept('dur')::uuid, 1, 'confirm', NULL, NULL,                   'ERR 22023 evidence_invalid_input [p_request_id]'),
  ('a stale study version',          pg_temp.sid('s1'), 1, pg_temp.kept('dur')::uuid, 1, 'flag', 'Stale', pg_temp.rq(130),        'ERR P0001 evidence_version_conflict'),
  ('a stale value version',          pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), pg_temp.kept('cond')::uuid, 1, 'confirm', NULL, pg_temp.rq(130),
                                                                                                                                  'ERR P0001 evidence_version_conflict [p_expected_value_version]'),
  ('an unknown value',               pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), pg_temp.p('unknown'), 1, 'confirm', NULL, pg_temp.rq(130),
                                                                                                                                  'ERR P0002 evidence_target_not_found [p_value_id]'),
  ('a value of another study of the caller''s', pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), pg_temp.vid(pg_temp.sid('s2'), 'setting'), 1, 'confirm', NULL, pg_temp.rq(130),
                                                                                                                                  'ERR P0002 evidence_target_not_found [p_value_id]')
) AS f(nm, study, version, value, vver, action, note, req, expected);

-- E4 — every reachable reason Confirm is blocked, in PR-B's order.
SELECT is(pg_temp.review('O', pg_temp.sid('s2'), pg_temp.vid(pg_temp.sid('s2'), 'design_classification'), 'confirm', NULL, 131),
  'ERR P0001 evidence_confirm_blocked [no_current_support]', 'E4 design_classification without a source cannot be confirmed (PO decision 2)');
SELECT is(pg_temp.review('O', pg_temp.sid('s2'), pg_temp.vid(pg_temp.sid('s2'), 'registration_ids'), 'confirm', NULL, 132),
  'ERR P0001 evidence_confirm_blocked [no_current_support]', 'E4 nor can a Reported value with only a note (PO decision 3: "No source given")');
SELECT is(pg_temp.status(pg_temp.review('O', pg_temp.sid('s2'), pg_temp.vid(pg_temp.sid('s2'), f.field), 'confirm', NULL, 133 + f.n)), 'applied',
  'E4 ' || f.nm || ' is confirmed')
FROM (VALUES
  (0, 'setting',                'Not applicable with its note'),
  (1, 'demographics',           'Unclear with an examined full text'),
  (2, 'design_as_reported',     'Not reported with an examined full text'),
  (3, 'population_description', 'Couldn''t check with two unavailable sources')
) AS f(n, field, nm);

-- Planted rows reach the defensive reasons no save can produce: Confirm
-- re-checks §J, the copies and the notes itself rather than trusting save. On
-- S1's saved setting (Reported, no source) the owner plants an examined,
-- superseded abstract; on S5 three values break §J or the note rule.
INSERT INTO public.evidence_field_anchors (id, user_id, study_id, value_id, paper_id, snapshot_id, purpose, source_kind) VALUES
  ('033b0001-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s1'), pg_temp.vid(pg_temp.sid('s1'), 'setting'),
   pg_temp.p('PD'), '0336a004-0000-0000-0000-000000000001', 'examined', 'abstract');
INSERT INTO public.evidence_field_values (id, user_id, study_id, field_key, value_state, state_reason, note) VALUES
  ('033b0002-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s5'), 'design_as_reported', 'not_reported', NULL, NULL),
  ('033b0003-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s5'), 'eligibility_criteria', 'unclear', 'ambiguous', repeat(chr(0x00A0), 10)),
  ('033b0004-0000-0000-0000-000000000000', pg_temp.u('O'), pg_temp.sid('s5'), 'setting', 'source_unavailable', NULL, NULL);
INSERT INTO public.evidence_field_anchors (user_id, study_id, value_id, paper_id, purpose, source_kind) VALUES
  (pg_temp.u('O'), pg_temp.sid('s5'), '033b0002-0000-0000-0000-000000000000', pg_temp.p('PG'), 'unavailable', 'full_text'),
  (pg_temp.u('O'), pg_temp.sid('s5'), '033b0003-0000-0000-0000-000000000000', pg_temp.p('PG'), 'unavailable', 'full_text');
SELECT is(pg_temp.review('O', f.study, f.value, 'confirm', NULL, 140 + f.n), f.expected, 'E4 ' || f.nm)
FROM (VALUES
  (1, pg_temp.sid('s1'), pg_temp.vid(pg_temp.sid('s1'), 'setting'),
      'a Reported value with only an examined, superseded abstract',
      'ERR P0001 evidence_confirm_blocked [sources_not_allowed,no_current_support,examined_abstract_not_current]'),
  (2, pg_temp.sid('s5'), '033b0002-0000-0000-0000-000000000000'::uuid, 'Not reported with nothing examined',
      'ERR P0001 evidence_confirm_blocked [examined_source_missing]'),
  (3, pg_temp.sid('s5'), '033b0003-0000-0000-0000-000000000000'::uuid, 'Unclear with only "unavailable" and a note blank after v1',
      'ERR P0001 evidence_confirm_blocked [unclear_source_missing,note_missing]'),
  (4, pg_temp.sid('s5'), '033b0004-0000-0000-0000-000000000000'::uuid, 'Couldn''t check with nothing unavailable',
      'ERR P0001 evidence_confirm_blocked [unavailable_source_missing]')
) AS f(n, study, value, nm, expected);
SELECT is((SELECT string_agg(DISTINCT v.review_status, ',') FROM public.evidence_field_values v
            WHERE v.id IN (pg_temp.vid(pg_temp.sid('s1'), 'setting'), '033b0002-0000-0000-0000-000000000000', '033b0003-0000-0000-0000-000000000000',
                           '033b0004-0000-0000-0000-000000000000', pg_temp.vid(pg_temp.sid('s2'), 'design_classification'))),
  'unreviewed', 'E4 a blocked Confirm changes nothing');
-- Remove the planted rows again, so later sections see only RPC-written rows.
DELETE FROM public.evidence_field_anchors WHERE id = '033b0001-0000-0000-0000-000000000000'
   OR value_id IN ('033b0002-0000-0000-0000-000000000000', '033b0003-0000-0000-0000-000000000000');
DELETE FROM public.evidence_field_values WHERE id IN ('033b0002-0000-0000-0000-000000000000', '033b0003-0000-0000-0000-000000000000',
                                                      '033b0004-0000-0000-0000-000000000000');

-- ═════════════════════════════════════════════════════════════════════════════
-- F. Rebase
-- ═════════════════════════════════════════════════════════════════════════════

-- S3 gets four values on PC's copy: a reviewed one whose quote will be found
-- again, a flagged one whose quote will not, an unreviewed one whose quote
-- will be found twice, and a reviewed Not reported with an examined abstract.
-- A fifth, reviewed, cites only the full text: not abstract-dependent.
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s3'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('Asthma'),
               jsonb_build_array(pg_temp.qt(pg_temp.p('PC'), pg_temp.cur(pg_temp.sid('s3'), pg_temp.p('PC')), 'adults with asthma'))),
    pg_temp.rv(pg_temp.st(), 'n_randomized', NULL, pg_temp.cnt('64 adults', '64'),
               jsonb_build_array(pg_temp.qt(pg_temp.p('PC'), pg_temp.cur(pg_temp.sid('s3'), pg_temp.p('PC')), '64 adults'))),
    pg_temp.rv(pg_temp.st(), 'design_as_reported', NULL, pg_temp.txt('Two inhalers compared'),
               jsonb_build_array(pg_temp.qt(pg_temp.p('PC'), pg_temp.cur(pg_temp.sid('s3'), pg_temp.p('PC')), 'inhaler A', 1, 2))),
    pg_temp.sv(pg_temp.st(), 'demographics', NULL, 'not_reported', NULL, NULL, NULL,
               jsonb_build_array(pg_temp.exa(pg_temp.p('PC'), pg_temp.cur(pg_temp.sid('s3'), pg_temp.p('PC'))))),
    pg_temp.rv(pg_temp.st(), 'setting', NULL, pg_temp.txt('Hospital'), jsonb_build_array(pg_temp.ftl(pg_temp.p('PC'), 'table', 'Table 1')))), 150)),
  'applied', 'F0 five values are recorded on the rebase study');
SELECT is(pg_temp.status(pg_temp.review('O', pg_temp.sid('s3'), pg_temp.vid(pg_temp.sid('s3'), f.field), f.action, f.note, 151 + f.n)), 'applied',
  'F0 ' || f.field || ' is ' || f.action || 'ed')
FROM (VALUES (0, 'condition', 'confirm', NULL::text), (1, 'n_randomized', 'flag', 'Check the CONSORT diagram'),
             (2, 'demographics', 'confirm', NULL), (3, 'setting', 'confirm', NULL)) AS f(n, field, action, note);

-- F1 — the displayed text must be the stored text.
SELECT pg_temp.keep('f_dig', pg_temp.digest(pg_temp.u('O')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), f.q), f.expected, 'F1 ' || f.nm)
FROM (VALUES
  ('a hash of another text',  pg_temp.q_rebase(pg_temp.sid('s3'), pg_temp.p('PC'), pg_temp.ver(pg_temp.sid('s3')), pg_temp.sha('Something else'), pg_temp.rq(160)),
                              'ERR P0001 evidence_source_changed_again'),
  ('an abstract-less paper',  pg_temp.q_rebase(pg_temp.sid('s2'), pg_temp.p('PB'), pg_temp.ver(pg_temp.sid('s2')), pg_temp.sha(''), pg_temp.rq(161)),
                              'ERR P0001 evidence_source_changed_again'),
  ('an upper-case hash',      pg_temp.q_rebase(pg_temp.sid('s3'), pg_temp.p('PC'), pg_temp.ver(pg_temp.sid('s3')), upper(pg_temp.sha('x')), pg_temp.rq(162)),
                              'ERR 22023 evidence_invalid_input [p_expected_abstract_sha256]'),
  ('a short hash',            pg_temp.q_rebase(pg_temp.sid('s3'), pg_temp.p('PC'), pg_temp.ver(pg_temp.sid('s3')), 'abc', pg_temp.rq(163)),
                              'ERR 22023 evidence_invalid_input [p_expected_abstract_sha256]'),
  ('a NULL paper',            pg_temp.q_rebase(pg_temp.sid('s3'), NULL, pg_temp.ver(pg_temp.sid('s3')), pg_temp.sha('x'), pg_temp.rq(164)),
                              'ERR 22023 evidence_invalid_input [p_paper_id]'),
  ('a NULL version',          pg_temp.q_rebase(pg_temp.sid('s3'), pg_temp.p('PC'), NULL, pg_temp.sha('x'), pg_temp.rq(165)),
                              'ERR 22023 evidence_invalid_input [p_expected_version]'),
  ('a stale version',         pg_temp.q_rebase(pg_temp.sid('s3'), pg_temp.p('PC'), 1, pg_temp.sha((SELECT abstract FROM public.papers WHERE id = pg_temp.p('PC'))), pg_temp.rq(166)),
                              'ERR P0001 evidence_version_conflict')
) AS f(nm, q, expected);
SELECT is(pg_temp.rebase('O', pg_temp.sid('s3'), pg_temp.p('PC'), 167),
  jsonb_build_object('status', 'unchanged', 'study_id', pg_temp.sid('s3'), 'study_version', pg_temp.ver(pg_temp.sid('s3')),
                     'paper_id', pg_temp.p('PC'), 'snapshot_id', pg_temp.cur(pg_temp.sid('s3'), pg_temp.p('PC')),
                     'previous_snapshot_id', NULL::uuid, 'seq', 1, 'rematched', 0, 'not_found', 0, 'ambiguous', 0, 'needs_rereview', 0)::text,
  'F1 the library abstract unchanged since the copy: unchanged, nothing written');
SELECT is(pg_temp.digest(pg_temp.u('O')), pg_temp.kept('f_dig'), 'F1 none of the refusals or the no-op changed anything');

-- F2 — the abstract is edited: "adults with asthma" stays once, "64 adults"
-- becomes "62 adults", "inhaler A" now appears three times.
UPDATE public.papers SET abstract =
  'Rebase study, revised: 62 adults with asthma received inhaler A or inhaler B; inhaler A was preferred. Lung function improved with inhaler A.'
 WHERE id = pg_temp.p('PC');
SELECT pg_temp.keep('f2_prev', pg_temp.cur(pg_temp.sid('s3'), pg_temp.p('PC'))::text);
SELECT pg_temp.keep('f2_vv', (SELECT string_agg(v.field_key || '=' || v.value_version, ',' ORDER BY v.field_key) FROM public.evidence_field_values v WHERE v.study_id = pg_temp.sid('s3')));
SELECT is(pg_temp.status(pg_temp.run('f2', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_rebase(pg_temp.sid('s3'), pg_temp.p('PC'), pg_temp.ver(pg_temp.sid('s3')),
                     pg_temp.sha((SELECT abstract FROM public.papers WHERE id = pg_temp.p('PC'))), pg_temp.rq(170)))),
  'applied', 'F2 "use current abstract" saves a new copy');
SELECT is(pg_temp.j('f2') - 'study_version' - 'snapshot_id',
  jsonb_build_object('status', 'applied', 'study_id', pg_temp.sid('s3'), 'paper_id', pg_temp.p('PC'),
                     'previous_snapshot_id', pg_temp.kept('f2_prev')::uuid, 'seq', 2,
                     'rematched', 1, 'not_found', 1, 'ambiguous', 1, 'needs_rereview', 3),
  'F2 the answer counts: one quote re-matched, one not found, one ambiguous; three values need re-review');
SELECT is(
  (SELECT string_agg(format('%s|%s|%s|%s', c.seq, c.id = pg_temp.kept('f2_prev')::uuid,
                            convert_to(c.exact_text, 'UTF8') = convert_to(p.abstract, 'UTF8'), c.exact_sha256 = sha256(convert_to(c.exact_text, 'UTF8'))), ';' ORDER BY c.seq)
     FROM public.evidence_source_snapshots c JOIN public.papers p ON p.id = c.paper_id WHERE c.study_id = pg_temp.sid('s3')),
  '1|t|f|t;2|f|t|t', 'F2 the earlier copy is kept, superseded; the new one holds the edited abstract byte for byte');
SELECT is(
  (SELECT string_agg(format('%s:%s:%s', v.field_key, c.seq,
                            CASE WHEN a.purpose = 'supports' THEN substr(public.evidence_normalize_v1(c.exact_text), a.match_start + 1, a.match_end - a.match_start) ELSE a.purpose END),
                     ' | ' ORDER BY v.field_key)
     FROM public.evidence_field_anchors a JOIN public.evidence_field_values v ON v.id = a.value_id
     LEFT JOIN public.evidence_source_snapshots c ON c.id = a.snapshot_id
    WHERE a.study_id = pg_temp.sid('s3') AND a.source_kind = 'abstract'),
  'condition:2:adults with asthma | demographics:1:examined | design_as_reported:1:inhaler A | n_randomized:1:64 adults',
  'F2 the quote found once moved to the new copy at its new offsets; the missing and the ambiguous ones, and the examined abstract, stay on the earlier copy');
SELECT is(
  (SELECT string_agg(format('%s=%s/%s/%s', v.field_key, v.review_status, coalesce(v.review_reason, '-'), coalesce(v.review_note, '-')), ', ' ORDER BY v.field_key)
     FROM public.evidence_field_values v WHERE v.study_id = pg_temp.sid('s3')),
  'condition=needs_rereview/source_changed/-, demographics=needs_rereview/source_changed/-, design_as_reported=unreviewed/-/-, '
  || 'n_randomized=needs_rereview/source_changed/Check the CONSORT diagram, setting=user_reviewed/-/-',
  'F2 the strict rule: reviewed (even re-matched) and flagged values need re-review, the flag''s note kept; unreviewed stays; the full-text-only value is untouched');
SELECT is((SELECT string_agg(v.field_key || '=' || v.value_version, ',' ORDER BY v.field_key) FROM public.evidence_field_values v WHERE v.study_id = pg_temp.sid('s3')),
  'condition=2,demographics=2,design_as_reported=1,n_randomized=2,setting=1',
  'F2 value_version moved where an anchor moved or the status changed, and nowhere else');
SELECT is(
  (SELECT string_agg(e.ordinal || ':' || e.event_type || coalesce(':' || e.field_key, '') || coalesce(':' || (e.after ->> 'outcome'), ''), ' ' ORDER BY e.ordinal)
     FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(170)),
  '0:request 1:source_captured 2:anchor_rematched:condition 3:anchor_not_rematched:design_as_reported:ambiguous '
  || '4:anchor_not_rematched:n_randomized:not_found 5:review_needs_rereview:condition 6:review_needs_rereview:demographics '
  || '7:review_needs_rereview:n_randomized 8:source_rebased',
  'F2 the events: the capture, one per quote re-checked, one per value sent to re-review, then the summary');
SELECT is(
  (SELECT (e.after ->> 'previous_snapshot_id') || ' ' || (e.after ->> 'seq') || ' ' || (e.after ->> 'exact_sha256')
     FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(170) AND e.event_type = 'source_captured'),
  pg_temp.kept('f2_prev') || ' 2 ' || pg_temp.sha((SELECT abstract FROM public.papers WHERE id = pg_temp.p('PC'))),
  'F2 source_captured names the copy it supersedes and the new copy''s fingerprint');
SELECT is(
  (SELECT (e.before -> 'review' ->> 'status') || '>' || (e.after -> 'review' ->> 'status') || ' ' || (e.before ->> 'value_version') || '>' || (e.after ->> 'value_version')
     FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(170) AND e.event_type = 'review_needs_rereview' AND e.field_key = 'condition'),
  'user_reviewed>needs_rereview 1>2', 'F2 review_needs_rereview records the review and version before and after');
SELECT is(pg_temp.review('O', pg_temp.sid('s3'), pg_temp.vid(pg_temp.sid('s3'), 'demographics'), 'confirm', NULL, 171),
  'ERR P0001 evidence_confirm_blocked [examined_abstract_not_current]', 'F2 an examined abstract must be re-examined on the current copy before Confirm');
SELECT is(pg_temp.status(pg_temp.review('O', pg_temp.sid('s3'), pg_temp.vid(pg_temp.sid('s3'), 'condition'), 'confirm', NULL, 172)), 'applied',
  'F2 the re-matched value can be confirmed again, by the user, on the new version');

-- F3 — Unclear with only a superseded quote (PO decision 1), and a second
-- rebase leaving earlier anchors alone.
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s3'), jsonb_build_array(
    pg_temp.sv(pg_temp.st(), 'eligibility_criteria', NULL, 'unclear', 'conflicting', NULL, 'Two age limits are given',
               jsonb_build_array(pg_temp.qt(pg_temp.p('PC'), pg_temp.cur(pg_temp.sid('s3'), pg_temp.p('PC')), 'Lung function improved')))), 180)),
  'applied', 'F3 an Unclear value quotes the current copy');
UPDATE public.papers SET abstract = 'Rebase study, third edition: inhalers compared in 62 adults.' WHERE id = pg_temp.p('PC');
SELECT is(pg_temp.status(pg_temp.rebase('O', pg_temp.sid('s3'), pg_temp.p('PC'), 181)), 'applied', 'F3 a second rebase');
SELECT is(pg_temp.review('O', pg_temp.sid('s3'), pg_temp.vid(pg_temp.sid('s3'), 'eligibility_criteria'), 'confirm', NULL, 182),
  'ERR P0001 evidence_confirm_blocked [unclear_source_not_current]', 'F3 an Unclear value whose only basis is a superseded quote cannot be confirmed (PO decision 1)');
SELECT is(
  (SELECT string_agg(v.field_key || ':' || c.seq, ',' ORDER BY v.field_key)
     FROM public.evidence_field_anchors a JOIN public.evidence_field_values v ON v.id = a.value_id
     JOIN public.evidence_source_snapshots c ON c.id = a.snapshot_id
    WHERE a.study_id = pg_temp.sid('s3') AND a.source_kind = 'abstract'),
  'condition:2,demographics:1,design_as_reported:1,eligibility_criteria:2,n_randomized:1',
  'F3 the second rebase re-checks only quotes on the copy it supersedes: earlier anchors stay where they were');
SELECT is((SELECT count(*)::int FROM public.evidence_source_snapshots WHERE study_id = pg_temp.sid('s3')), 3, 'F3 three copies, none overwritten');

-- F4 — the first capture of a link without a copy (FK-PROOF-001 §J).
SELECT is(pg_temp.status(pg_temp.review('O', pg_temp.sid('s2'), pg_temp.vid(pg_temp.sid('s2'), 'population_description'), 'confirm', NULL, 190)),
  'unchanged', 'F4 (the Couldn''t check value, confirmed in E4, is reviewed)');
UPDATE public.papers SET abstract = 'Now available: an abstract for PB about diabetes care.' WHERE id = pg_temp.p('PB');
SELECT is(pg_temp.status(pg_temp.run('f4', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_rebase(pg_temp.sid('s2'), pg_temp.p('PB'), pg_temp.ver(pg_temp.sid('s2')), pg_temp.sha('Now available: an abstract for PB about diabetes care.'), pg_temp.rq(191)))),
  'applied', 'F4 "save a copy" captures the first copy of a link');
SELECT is((pg_temp.j('f4') ->> 'seq') || ' ' || coalesce(pg_temp.j('f4') ->> 'previous_snapshot_id', '<null>'), '1 <null>', 'F4 at seq 1, superseding nothing');
SELECT is(
  (SELECT v.review_status || '/' || v.review_reason FROM public.evidence_field_values v WHERE v.id = pg_temp.vid(pg_temp.sid('s2'), 'population_description')),
  'needs_rereview/source_changed', 'F4 a reviewed "abstract unavailable" claim needs re-review once the abstract exists');
SELECT is(
  (SELECT string_agg(v.field_key || '=' || v.review_status, ',' ORDER BY v.field_key) FROM public.evidence_field_values v
    WHERE v.study_id = pg_temp.sid('s2') AND v.field_key IN ('demographics', 'design_as_reported', 'setting')),
  'demographics=user_reviewed,design_as_reported=user_reviewed,setting=user_reviewed',
  'F4 values with no abstract reference on that link are not touched');
SELECT is(pg_temp.review('O', pg_temp.sid('s2'), pg_temp.vid(pg_temp.sid('s2'), 'population_description'), 'confirm', NULL, 192),
  'ERR P0001 evidence_confirm_blocked [unavailable_abstract_has_copy]', 'F4 and cannot be confirmed while it says the abstract is unavailable');
SELECT is(pg_temp.save('O', pg_temp.sid('s2'), jsonb_build_array(
    pg_temp.sv(pg_temp.st(), 'population_description', pg_temp.vv(pg_temp.vid(pg_temp.sid('s2'), 'population_description')), 'source_unavailable', NULL, NULL, 'Asked the authors',
      (SELECT jsonb_agg(pg_temp.kp(a.id) ORDER BY a.source_kind COLLATE "C") FROM public.evidence_field_anchors a
        WHERE a.value_id = pg_temp.vid(pg_temp.sid('s2'), 'population_description')))), 193),
  'ERR 22023 evidence_invalid_input [p_changes[0].references[0]: unavailable_abstract_has_copy]',
  'F4 nor saved again while it keeps that reference');

-- F5 — limits and empty text.
UPDATE public.papers SET abstract = repeat('w ', 25000) || 'x' WHERE id = pg_temp.p('PB');
SELECT is(pg_temp.rebase('O', pg_temp.sid('s2'), pg_temp.p('PB'), 194), 'ERR P0001 evidence_abstract_too_long', 'F5 an abstract of 50,001 characters is refused');
UPDATE public.papers SET abstract = chr(0x00A0) || chr(0x200B) || chr(0x3000) WHERE id = pg_temp.p('PB');
SELECT is(pg_temp.rebase('O', pg_temp.sid('s2'), pg_temp.p('PB'), 195),
  'ERR 22023 evidence_invalid_input [p_expected_abstract_sha256: source_empty]', 'F5 an abstract blank after v1 is not saved as a copy');
SELECT pg_temp.plant_copy(('0336c0' || lpad(to_hex(g), 2, '0') || '-0000-0000-0000-000000000000')::uuid, pg_temp.u('O'),
                          pg_temp.sid('s2'), pg_temp.p('PB'), g, 'Planted copy ' || g)
  FROM generate_series(2, 19) g;
UPDATE public.papers SET abstract = 'The twentieth text.' WHERE id = pg_temp.p('PB');
SELECT is(pg_temp.status(pg_temp.rebase('O', pg_temp.sid('s2'), pg_temp.p('PB'), 196)), 'applied', 'F5 the twentieth copy of a link is saved');
UPDATE public.papers SET abstract = 'The twenty-first text.' WHERE id = pg_temp.p('PB');
SELECT is(pg_temp.rebase('O', pg_temp.sid('s2'), pg_temp.p('PB'), 197), 'ERR P0001 evidence_snapshot_limit', 'F5 the twenty-first is refused');

-- ═════════════════════════════════════════════════════════════════════════════
-- G. Request idempotency, in sequence (FK-PROOF-001 I-1)
-- ═════════════════════════════════════════════════════════════════════════════

SELECT pg_temp.keep('g_v', pg_temp.ver(pg_temp.sid('s1'))::text);
SELECT is(pg_temp.status(pg_temp.run('g1', 'authenticated', pg_temp.claims('O'),
    pg_temp.q_save(pg_temp.sid('s1'), pg_temp.kept('g_v')::int, jsonb_build_array(pg_temp.add_out('weight', 'Body weight', 1)), pg_temp.rq(200)))),
  'applied', 'G1 a save is applied');
SELECT pg_temp.keep('g_rows', pg_temp.user_rows(pg_temp.u('O')));
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_save(pg_temp.sid('s1'), pg_temp.kept('g_v')::int, jsonb_build_array(pg_temp.add_out('weight', 'Body weight', 1)), pg_temp.rq(200))),
  (pg_temp.j('g1') || '{"status": "replayed"}')::text, 'G1 the same request again (a lost response) replays the original answer, ids included');
SELECT is(pg_temp.user_rows(pg_temp.u('O')), pg_temp.kept('g_rows'), 'G1 and writes nothing, not even a header');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(pg_temp.add_out('bp', 'Blood pressure', 2)), 201)), 'applied',
  'G2 a later save moves the study on');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_save(pg_temp.sid('s1'), pg_temp.kept('g_v')::int, jsonb_build_array(pg_temp.add_out('weight', 'Body weight', 1)), pg_temp.rq(200))),
  (pg_temp.j('g1') || '{"status": "replayed"}')::text, 'G2 the retry still replays the ORIGINAL answer and version');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'), f.q), 'ERR P0001 evidence_request_id_reused', 'G3 ' || f.nm)
FROM (VALUES
  ('a save id with another body',   pg_temp.q_save(pg_temp.sid('s1'), pg_temp.kept('g_v')::int, jsonb_build_array(pg_temp.add_out('weight', 'Weight', 1)), pg_temp.rq(200))),
  ('a save id at another version',  pg_temp.q_save(pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), jsonb_build_array(pg_temp.add_out('weight', 'Body weight', 1)), pg_temp.rq(200))),
  ('a save id for a review',        pg_temp.q_review(pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), pg_temp.kept('dur')::uuid, 1, 'flag', 'Reused', pg_temp.rq(200))),
  ('a save id for a rebase',        pg_temp.q_rebase(pg_temp.sid('s1'), pg_temp.p('PA'), pg_temp.ver(pg_temp.sid('s1')), pg_temp.sha('x'), pg_temp.rq(200))),
  ('a create id for a save',        pg_temp.q_save(pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), jsonb_build_array(pg_temp.add_out('x', 'X', 7)), pg_temp.rq(1))),
  ('a review id for a save',        pg_temp.q_save(pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), jsonb_build_array(pg_temp.add_out('x', 'X', 7)), pg_temp.rq(120))),
  ('a rebase id for a review',      pg_temp.q_review(pg_temp.sid('s3'), pg_temp.ver(pg_temp.sid('s3')), pg_temp.vid(pg_temp.sid('s3'), 'condition'), 2, 'flag', 'Reused', pg_temp.rq(170)))
) AS f(nm, q);
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_review(pg_temp.sid('s1'), (SELECT e.study_version - 1 FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(120) AND e.ordinal = 0),
                     pg_temp.kept('dur')::uuid, 1, 'confirm', NULL, pg_temp.rq(120))),
  (SELECT (e.result || '{"status": "replayed"}')::text FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(120) AND e.ordinal = 0),
  'G4 a review retried after later writes replays its original answer');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    pg_temp.q_rebase(pg_temp.sid('s3'), pg_temp.p('PC'), (SELECT e.study_version - 1 FROM public.evidence_events e WHERE e.request_id = pg_temp.rq(170) AND e.ordinal = 0),
                     pg_temp.sha('Rebase study, revised: 62 adults with asthma received inhaler A or inhaler B; inhaler A was preferred. Lung function improved with inhaler A.'),
                     pg_temp.rq(170))),
  (pg_temp.j('f2') || '{"status": "replayed"}')::text, 'G4 so does a rebase, although the abstract has changed again since');
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('O'),
    pg_temp.q_save(pg_temp.sid('s1'), pg_temp.ver(pg_temp.sid('s1')), jsonb_build_array(pg_temp.add_out('rolled', 'Rolled back', 9)), pg_temp.rq(210)),
    'SELECT count(*)::text FROM public.evidence_events WHERE request_id = ''' || pg_temp.rq(210)::text || ''''),
  '00000 2', 'G5 inside its transaction an attempt wrote its header and event');
SELECT is((SELECT count(*)::int FROM public.evidence_events WHERE request_id = pg_temp.rq(210))
          + (SELECT count(*)::int FROM public.evidence_outcomes WHERE display_label = 'Rolled back'), 0, 'G5 after its rollback nothing of it remains');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(pg_temp.add_out('rolled', 'Rolled back', 9)), 210)), 'applied',
  'G5 so its retry is applied afresh');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(pg_temp.upd_out((SELECT id FROM public.evidence_outcomes WHERE display_label = 'Rolled back'), 'Rolled back', 9)), 211)),
  'unchanged', 'G6 a no-op');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(pg_temp.upd_out((SELECT id FROM public.evidence_outcomes WHERE display_label = 'Rolled back'), 'Rolled forward', 9)), 211)),
  'applied', 'G6 consumed nothing: the same request id can still carry a real change');
SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(pg_temp.add_out('shared', 'Shared id', 10)), x'bbbb'::int)), 'applied',
  'G7 a request id another user committed neither replays nor collides');

-- ═════════════════════════════════════════════════════════════════════════════
-- H. History integrity
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT count(*)::int FROM (SELECT e.user_id, e.request_id FROM public.evidence_events e WHERE e.ordinal = 0
                               GROUP BY e.user_id, e.request_id HAVING count(*) > 1) d),
  0, 'H1 no user has two headers for one request id');
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
  '', 'H1 every study of the owner has versions 1..row_version, one header per version, gap-free ordinals');
SELECT is(
  (SELECT count(*)::int FROM public.evidence_events e
    WHERE e.ordinal > 0 AND e.user_id = pg_temp.u('O')
      AND NOT EXISTS (SELECT 1 FROM public.evidence_events h
                       WHERE h.user_id = e.user_id AND h.study_id = e.study_id AND h.study_version = e.study_version
                         AND h.ordinal = 0 AND h.request_id = e.request_id)),
  0, 'H1 every change event carries the request id of its version''s header');
SELECT is(
  (SELECT count(*)::int FROM public.evidence_events e
     JOIN public.evidence_source_snapshots c ON c.user_id = e.user_id
    WHERE position(c.exact_text IN coalesce(e.before::text, '') || coalesce(e.after::text, '')
                                    || coalesce(e.result::text, '') || coalesce(e.note, '')) > 0),
  0, 'H2 no event holds the text of any copy');
SELECT is(
  (SELECT count(*)::int FROM public.evidence_events e
    WHERE (coalesce(e.before::text, '') || coalesce(e.after::text, '') || coalesce(e.result::text, ''))
          ~ ('(MARKER033|type 2 diabetes|Type 2 diabetes|Adults only|Check the full text|Check the CONSORT|Matches Table 1|NCT01234567|p\. 4|Mean age 58|Two age limits)')),
  0, 'H2 no quote, value text, note, review note, list entry or locator appears in any event');
SELECT is(
  (SELECT max(octet_length(coalesce(e.before::text, '')) + octet_length(coalesce(e.after::text, ''))) < 16384
          AND max(octet_length(coalesce(e.result::text, ''))) < 4096
     FROM public.evidence_events e WHERE e.user_id = pg_temp.u('O')),
  true, 'H3 every event payload is small: before + after under 16 KB, results under 4 KB');
SELECT is(
  (SELECT md5(string_agg(e::text, '|' ORDER BY e.study_version, e.ordinal)) FROM public.evidence_events e
    WHERE e.study_id = pg_temp.sid('s1') AND e.study_version <= 3),
  pg_temp.kept('h_early'), 'H4 the first three versions of a study are byte-identical after every later write')
FROM (SELECT 1) one WHERE pg_temp.kept('h_early') IS NOT NULL;
SELECT is(
  (SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname COLLATE "C"), '') FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND pg_temp.code(p.oid::regprocedure) ~* 'update[[:space:]]+(only[[:space:]]+)?(public\.)?(evidence_events|evidence_source_snapshots)'),
  '', 'H5 no public function updates history or a copy');
SELECT is(
  (SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname COLLATE "C"), '') FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND pg_temp.code(p.oid::regprocedure) ~* 'delete[[:space:]]+from[[:space:]]+(only[[:space:]]+)?(public\.)?evidence_events'),
  'evidence_delete_study', 'H5 only evidence_delete_study deletes history');
SELECT is(
  (SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname COLLATE "C"), '') FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND pg_temp.code(p.oid::regprocedure) ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?evidence_events'),
  'evidence_create_study_from_paper,evidence_rebase_source,evidence_review_fields,evidence_save_changes,evidence_set_link,evidence_update_study',
  'H5 exactly the six gated RPCs append history');

-- ═════════════════════════════════════════════════════════════════════════════
-- I. Existing behaviour, with RPC-written records
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.status(pg_temp.save('O', pg_temp.sid('s1'), jsonb_build_array(
    pg_temp.rv(pg_temp.at(pg_temp.kept('arm_met')::uuid), 'frequency', 1, pg_temp.txt('Twice daily'), jsonb_build_array(pg_temp.ftl(pg_temp.p('PD'), 'page', '3')))), 219)),
  'applied', 'I1 a value cites the second report''s full text');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    format('SELECT public.evidence_set_link(%L::uuid, %L::uuid, ''remove'', %L::integer, %L::uuid)::text',
           pg_temp.sid('s1'), pg_temp.p('PD'), pg_temp.ver(pg_temp.sid('s1')), pg_temp.rq(220))),
  'ERR P0001 evidence_link_in_use', 'I1 so that link cannot be removed');
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('O'),
    'SELECT * FROM public.delete_papers_with_attachment_cleanup(ARRAY[''' || pg_temp.p('PC')::text || ''']::uuid[])'),
  '23503:evidence_study_reports_paper_fkey', 'I2 a rebased paper still cannot be deleted while a study links it');
SELECT is(pg_temp.study_rows(pg_temp.sid('s3')) ~ '^studies=1 links=1 copies=3 arms=0 outcomes=0 values=6 refs=6 events=[0-9]+$', true,
  'I3 before: the rebase study holds three copies, values, references and history');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    format('SELECT public.evidence_delete_study(%L::uuid, %L::integer, %L::uuid)::text', pg_temp.sid('s3'), pg_temp.ver(pg_temp.sid('s3')), pg_temp.rq(221))),
  '{"status": "deleted"}', 'I3 the owner deletes it');
SELECT is(pg_temp.study_rows(pg_temp.sid('s3')), 'studies=0 links=0 copies=0 arms=0 outcomes=0 values=0 refs=0 events=0',
  'I3 nothing of it remains, superseded copies and re-matched anchors included');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('O'),
    'SELECT deleted_count || ''/'' || queued_count FROM public.delete_papers_with_attachment_cleanup(ARRAY[''' || pg_temp.p('PC')::text || ''']::uuid[])'),
  '1/0', 'I3 and its paper can be deleted again');

-- Account deletion with every kind of RPC-written record.
SELECT is(pg_temp.status(pg_temp.save('X', pg_temp.sid('sx'), jsonb_build_array(
    pg_temp.add_arm('a', 'intervention', 'Inhaler', 0), pg_temp.add_out('o', 'FEV1', 0),
    pg_temp.rv(pg_temp.st(), 'condition', NULL, pg_temp.txt('Asthma'),
               jsonb_build_array(pg_temp.qt(pg_temp.p('PX'), pg_temp.cur(pg_temp.sid('sx'), pg_temp.p('PX')), 'about asthma'))),
    pg_temp.rv(pg_temp.aref('a'), 'description', NULL, pg_temp.txt('An inhaler'), jsonb_build_array(pg_temp.ftl(pg_temp.p('PX'))))), 230)),
  'applied', 'I4 the doomed account saves groups, outcomes, values and references');
SELECT is(pg_temp.status(pg_temp.review('X', pg_temp.sid('sx'), pg_temp.vid(pg_temp.sid('sx'), 'condition'), 'confirm', NULL, 231)), 'applied', 'I4 confirms one');
UPDATE public.papers SET abstract = 'Deleted account abstract, edited, about asthma.' WHERE id = pg_temp.p('PX');
SELECT is(pg_temp.status(pg_temp.rebase('X', pg_temp.sid('sx'), pg_temp.p('PX'), 232)), 'applied', 'I4 and rebases its copy');
SELECT pg_temp.keep('i_dig', pg_temp.digest(pg_temp.u('O')) || ' ' || pg_temp.digest(pg_temp.u('B')));
SELECT is(pg_temp.call('postgres', NULL,
    'WITH d AS (DELETE FROM auth.users WHERE id = ''' || pg_temp.u('X')::text || ''' RETURNING 1) SELECT count(*)::text FROM d'),
  '1', 'I4 deleting the Auth user succeeds, with both NO ACTION reference edges populated');
SELECT is(pg_temp.user_rows(pg_temp.u('X')) || format(' papers=%s', (SELECT count(*) FROM public.papers WHERE user_id = pg_temp.u('X'))),
  'studies=0 links=0 copies=0 arms=0 outcomes=0 values=0 refs=0 events=0 papers=0', 'I4 and leaves nothing of that account');
SELECT is(pg_temp.digest(pg_temp.u('O')) || ' ' || pg_temp.digest(pg_temp.u('B')), pg_temp.kept('i_dig'), 'I4 other accounts are untouched');

-- RLS still scopes reads; the browser still cannot write a table directly.
SELECT is(pg_temp.call('authenticated', pg_temp.claims('B'),
    'SELECT count(*)::text FROM public.evidence_field_values WHERE user_id = ''' || pg_temp.u('O')::text || ''''), '0',
  'I5 the neighbour reads none of the owner''s values');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('B'),
    'SELECT count(*)::text FROM public.evidence_field_anchors WHERE user_id = ''' || pg_temp.u('O')::text || ''''), '0',
  'I5 nor their references');
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('O'), f.q), '42501', 'I6 authenticated cannot ' || f.nm || ' directly')
FROM (VALUES
  ('confirm a value',           'UPDATE public.evidence_field_values SET review_status = ''user_reviewed'', reviewed_at = now(), reviewed_version = value_version'),
  ('forge a match',             'UPDATE public.evidence_field_anchors SET match_start = 0'),
  ('insert a value',            'INSERT INTO public.evidence_field_values (user_id, study_id, field_key, value_state, value_text) VALUES (''' || pg_temp.u('O') || ''', ''' || pg_temp.sid('s1') || ''', ''frequency'', ''reported'', ''x'')'),
  ('insert a reference',        'INSERT INTO public.evidence_field_anchors (user_id, study_id, value_id, paper_id, purpose, source_kind) SELECT user_id, study_id, id, ''' || pg_temp.p('PA') || ''', ''unavailable'', ''full_text'' FROM public.evidence_field_values LIMIT 1'),
  ('add a group',               'INSERT INTO public.evidence_arms (user_id, study_id, arm_role, display_label, position) VALUES (''' || pg_temp.u('O') || ''', ''' || pg_temp.sid('s1') || ''', ''intervention'', ''x'', 50)'),
  ('rewrite a copy',            'UPDATE public.evidence_source_snapshots SET exact_text = exact_text'),
  ('delete history',            'DELETE FROM public.evidence_events')
) AS f(nm, q);

-- ═════════════════════════════════════════════════════════════════════════════
-- J. FK-PROOF-001 §J over every count (supports 0-4, examined 0-2,
--    unavailable 0-2), against a transcription written here
-- ═════════════════════════════════════════════════════════════════════════════
--
--   state               supports   examined                 unavailable
--   reported            0-3        0                        0
--   not_reported        0          >= 1                     any
--   unclear             0-3        any, supports+examined >= 1   any
--   source_unavailable  0          0                        >= 1
--   not_applicable      0          0                        0

CREATE TEMP VIEW j_grid AS
SELECT st, s, e, u,
       CASE st
         WHEN 'reported'           THEN s <= 3 AND e = 0 AND u = 0
         WHEN 'not_reported'       THEN s = 0 AND e >= 1
         WHEN 'unclear'            THEN s <= 3 AND s + e >= 1
         WHEN 'source_unavailable' THEN s = 0 AND e = 0 AND u >= 1
         WHEN 'not_applicable'     THEN s = 0 AND e = 0 AND u = 0
       END AS allowed,
       public.evidence_state_reference_problems(st, s, e, u) AS problems
  FROM unnest(ARRAY['reported', 'not_reported', 'unclear', 'not_applicable', 'source_unavailable']) st,
       generate_series(0, 4) s, generate_series(0, 2) e, generate_series(0, 2) u;

SELECT is(
  (SELECT coalesce(string_agg(format('%s/%s/%s', g.s, g.e, g.u), ' ' ORDER BY g.s, g.e, g.u), '')
     FROM j_grid g WHERE g.st = st.name AND (cardinality(g.problems) = 0) IS DISTINCT FROM g.allowed),
  '', 'J1 ' || st.name || ': the rule refuses exactly the counts §J forbids (45 cells)')
FROM unnest(ARRAY['reported', 'not_reported', 'unclear', 'not_applicable', 'source_unavailable']) AS st(name);
SELECT is((SELECT count(*)::int FROM j_grid), 225, 'J1 the grid has every cell');
SELECT is(public.evidence_state_reference_problems(f.st, f.s, f.e, f.u), f.codes, 'J2 ' || f.st || ' ' || f.s || '/' || f.e || '/' || f.u)
FROM (VALUES
  ('reported', 4, 1, 1,           ARRAY['too_many_supporting', 'examined_not_allowed', 'unavailable_not_allowed']),
  ('not_reported', 4, 0, 0,       ARRAY['too_many_supporting', 'supporting_not_allowed', 'examined_required']),
  ('unclear', 4, 0, 0,            ARRAY['too_many_supporting']),
  ('unclear', 0, 0, 2,            ARRAY['basis_required']),
  ('not_applicable', 0, 1, 1,     ARRAY['not_allowed']),
  ('not_applicable', 4, 0, 0,     ARRAY['too_many_supporting', 'not_allowed']),
  ('source_unavailable', 1, 1, 0, ARRAY['supporting_not_allowed', 'examined_not_allowed', 'unavailable_required']),
  ('reported', 0, 0, 0,           ARRAY[]::text[]),
  ('unknown_state', 0, 0, 0,      ARRAY['state_unknown'])
) AS f(st, s, e, u, codes);

-- ═════════════════════════════════════════════════════════════════════════════
-- K. Limits (draft PR-A3 policy, plus PR-A2's history limit)
-- ═════════════════════════════════════════════════════════════════════════════

SELECT pg_temp.run('sl', 'authenticated', pg_temp.claims('L'), pg_temp.q_create(pg_temp.p('PL'), 'Limits study', 'rct_parallel', pg_temp.rq(300)));
INSERT INTO public.evidence_arms (user_id, study_id, arm_role, display_label, position)
SELECT pg_temp.u('L'), pg_temp.sid('sl'), 'intervention', 'Arm ' || g, g FROM generate_series(0, 18) g;
INSERT INTO public.evidence_outcomes (user_id, study_id, display_label, position)
SELECT pg_temp.u('L'), pg_temp.sid('sl'), 'Outcome ' || g, g FROM generate_series(0, 48) g;
SELECT is(pg_temp.save('L', pg_temp.sid('sl'), jsonb_build_array(pg_temp.add_arm('a20', 'comparator', 'Arm 19', 19), pg_temp.add_arm('a21', 'comparator', 'Arm 20', 20)), 301),
  'ERR P0001 evidence_arm_limit', 'K1 a batch that would make 21 groups is refused');
SELECT is(pg_temp.status(pg_temp.save('L', pg_temp.sid('sl'), jsonb_build_array(pg_temp.add_arm('a20', 'comparator', 'Arm 19', 19)), 302)),
  'applied', 'K1 the 20th group is added');
SELECT is(pg_temp.save('L', pg_temp.sid('sl'), jsonb_build_array(pg_temp.add_arm('a21', 'comparator', 'Arm 20', 20)), 303),
  'ERR P0001 evidence_arm_limit', 'K1 the 21st is refused');
SELECT is(pg_temp.status(pg_temp.save('L', pg_temp.sid('sl'), jsonb_build_array(pg_temp.add_out('o50', 'Outcome 49', 49)), 304)),
  'applied', 'K2 the 50th outcome is added');
SELECT is(pg_temp.save('L', pg_temp.sid('sl'), jsonb_build_array(pg_temp.add_out('o51', 'Outcome 50', 50)), 305),
  'ERR P0001 evidence_outcome_limit', 'K2 the 51st is refused');

-- 400 values. Every slot of the study: 10 study fields, 8 per group (20) and
-- 5 per outcome (50) make 420. The owner plants 399 — all 250 outcome slots,
-- 7 text fields of each group, and every study field but `setting` — so the
-- RPC records the 400th, and a comparator_type would be the 401st.
INSERT INTO public.evidence_field_values (user_id, study_id, arm_id, outcome_id, field_key, value_state, value_text)
SELECT pg_temp.u('L'), pg_temp.sid('sl'), NULL, o.id, k, 'reported', 'Planted'
  FROM public.evidence_outcomes o, unnest(ARRAY['outcome_name_as_reported', 'outcome_definition', 'measurement_instrument']) k
 WHERE o.study_id = pg_temp.sid('sl');
INSERT INTO public.evidence_field_values (user_id, study_id, arm_id, outcome_id, field_key, value_state)
SELECT pg_temp.u('L'), pg_temp.sid('sl'), NULL, o.id, k, 'not_reported'
  FROM public.evidence_outcomes o, unnest(ARRAY['outcome_designation', 'time_points']) k
 WHERE o.study_id = pg_temp.sid('sl');
INSERT INTO public.evidence_field_values (user_id, study_id, arm_id, outcome_id, field_key, value_state, value_text)
SELECT pg_temp.u('L'), pg_temp.sid('sl'), a.id, NULL, k, 'reported', 'Planted'
  FROM public.evidence_arms a, unnest(ARRAY['arm_name_as_reported', 'description', 'dose_or_intensity', 'frequency', 'duration',
                                            'delivery_mode', 'co_interventions']) k
 WHERE a.study_id = pg_temp.sid('sl');
INSERT INTO public.evidence_field_values (user_id, study_id, arm_id, outcome_id, field_key, value_state)
SELECT pg_temp.u('L'), pg_temp.sid('sl'), NULL, NULL, k, 'not_reported'
  FROM unnest(ARRAY['design_as_reported', 'design_classification', 'registration_ids', 'population_description', 'condition',
                    'eligibility_criteria', 'demographics', 'n_randomized', 'n_enrolled']) k;
SELECT is((SELECT count(*)::int FROM public.evidence_field_values WHERE study_id = pg_temp.sid('sl')), 399, 'K3 399 values are planted');
SELECT is(pg_temp.status(pg_temp.save('L', pg_temp.sid('sl'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'setting', NULL, pg_temp.txt('Clinic'))), 306)), 'applied', 'K3 the 400th value is recorded');
SELECT is(pg_temp.save('L', pg_temp.sid('sl'), jsonb_build_array(
    pg_temp.rv(pg_temp.at((SELECT id FROM public.evidence_arms WHERE study_id = pg_temp.sid('sl') AND position = 19)), 'comparator_type', NULL, pg_temp.cd('placebo'))), 307),
  'ERR P0001 evidence_value_limit', 'K3 the 401st is refused');
SELECT is(pg_temp.status(pg_temp.save('L', pg_temp.sid('sl'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'setting', 1, pg_temp.txt('Clinic, revised'))), 308)), 'applied', 'K3 at the limit, a value can still change');

-- 200 changes, 64 KB.
SELECT is(pg_temp.save('L', pg_temp.sid('sl'), (SELECT jsonb_agg(pg_temp.add_out('x' || g, 'X', 0)) FROM generate_series(1, 201) g), 309),
  'ERR 22023 evidence_invalid_input [p_changes: too_many_changes]', 'K4 201 changes are refused before anything is read');
SELECT is(pg_temp.status(pg_temp.save('L', pg_temp.sid('sl'),
    (SELECT jsonb_agg(CASE WHEN u.k = 'time_points'
                           THEN pg_temp.rv(pg_temp.ot(o.id), u.k, 1, pg_temp.lst(jsonb_build_array('Week ' || o.position)))
                           ELSE pg_temp.rv(pg_temp.ot(o.id), u.k, 1, pg_temp.txt('Revised ' || o.position)) END
                      ORDER BY o.position, u.n)
       FROM public.evidence_outcomes o,
            unnest(ARRAY['outcome_name_as_reported', 'outcome_definition', 'measurement_instrument', 'time_points']) WITH ORDINALITY AS u(k, n)
      WHERE o.study_id = pg_temp.sid('sl')), 310)),
  'applied', 'K4 exactly 200 changes in one batch are applied');
SELECT is((SELECT count(*)::int FROM public.evidence_events e WHERE e.study_id = pg_temp.sid('sl') AND e.request_id = pg_temp.rq(310)), 201,
  'K4 as one request: one header and 200 change events');
SELECT is(pg_temp.save('L', pg_temp.sid('sl'), jsonb_build_array(pg_temp.add_out('big', 'Big', 98) || jsonb_build_object('padding', repeat('p', 70000))), 311),
  'ERR 22023 evidence_invalid_input [p_changes: too_large]', 'K5 a payload over 64 KB is refused before anything is read');

-- 5,000 events: exact under the study row lock, for save, review and rebase.
SELECT pg_temp.keep('k_events', (SELECT count(*)::text FROM public.evidence_events WHERE study_id = pg_temp.sid('sl')));
INSERT INTO public.evidence_events (user_id, study_id, study_version, ordinal, event_type, request_id, target_id, after)
SELECT pg_temp.u('L'), pg_temp.sid('sl'), 1, 1000 + g, 'study_updated', gen_random_uuid(), pg_temp.sid('sl'), '{}'::jsonb
  FROM generate_series(1, 5000 - 3 - pg_temp.kept('k_events')::int) g;
SELECT is(pg_temp.status(pg_temp.save('L', pg_temp.sid('sl'), jsonb_build_array(
    pg_temp.rv(pg_temp.st(), 'setting', 2, pg_temp.txt('Clinic, final')), pg_temp.upd_out((SELECT id FROM public.evidence_outcomes WHERE study_id = pg_temp.sid('sl') AND position = 0), 'Outcome zero', 0)), 312)),
  'applied', 'K6 a save that brings the history to exactly 5,000 events is applied');
SELECT is((SELECT count(*)::int FROM public.evidence_events WHERE study_id = pg_temp.sid('sl')), 5000, 'K6 (5,000 events)');
SELECT is(pg_temp.save('L', pg_temp.sid('sl'), jsonb_build_array(pg_temp.rv(pg_temp.st(), 'setting', 3, pg_temp.txt('Clinic, again'))), 313),
  'ERR P0001 evidence_history_limit', 'K6 the next save is refused');
SELECT is(pg_temp.review('L', pg_temp.sid('sl'), pg_temp.vid(pg_temp.sid('sl'), 'setting'), 'flag', 'Over the limit', 314),
  'ERR P0001 evidence_history_limit', 'K6 so is a review');
UPDATE public.papers SET abstract = 'Limits abstract, edited.' WHERE id = pg_temp.p('PL');
SELECT is(pg_temp.rebase('L', pg_temp.sid('sl'), pg_temp.p('PL'), 315), 'ERR P0001 evidence_history_limit', 'K6 and a rebase');
SELECT is(pg_temp.call('authenticated', pg_temp.claims('L'),
    format('SELECT public.evidence_delete_study(%L::uuid, %L::integer, %L::uuid)::text', pg_temp.sid('sl'), pg_temp.ver(pg_temp.sid('sl')), pg_temp.rq(316))),
  '{"status": "deleted"}', 'K6 a full study can still be deleted');

SELECT * FROM finish();
ROLLBACK;
