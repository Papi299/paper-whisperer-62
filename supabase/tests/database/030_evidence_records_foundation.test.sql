-- EVIDENCE-RECORDS-001A1 suite 030: the evidence-records database foundation.
--
-- Owns `20261012031537_add_evidence_records_foundation.sql`: eight tables with
-- composite owner keys, three ON DELETE NO ACTION edges, single-row CHECKs,
-- forced owner-only RLS and a SELECT-only Data API surface. That migration added
-- no function, so every fixture here is planted by the database owner, exactly
-- as a reviewed SECURITY DEFINER RPC would plant it. The lifecycle RPCs
-- EVIDENCE-RECORDS-001A2 added later are owned by suite 031.
--
-- Proves, against the live local schema:
--   A. the catalog contract — tables, columns, RLS, policies, the complete
--      foreign-key inventory with every ON DELETE action, the D7 rules (every
--      key carries user_id; every table cascades from auth.users; every child
--      of a study cascades from it directly), the supporting indexes, the
--      durable request-header key, that no trigger was added, and that the
--      only evidence functions are the twelve EVIDENCE-RECORDS-001A2 and
--      001A3 reviewed;
--   B. the privilege surface — anon and service_role reach nothing, and a
--      signed-in user can read only their own rows and write none (catalog AND
--      real attempts);
--   C. integrity — every invalid cross-study and cross-user relationship is
--      refused by the keys alone, attempted as `postgres`, which holds
--      BYPASSRLS, so no policy or RPC code can be what refuses it;
--   D. the single-row CHECK contract — values, missing-value states, review
--      columns, the source-reference matrix, copies and history headers. Each
--      negative row breaks exactly ONE rule: PostgreSQL reports the first
--      failing CHECK in constraint-NAME order, so a row that broke two would be
--      refused by whichever name sorts first and the assertion would name the
--      wrong rule. Every family starts from a positive control (the unmodified
--      base row is accepted) so a refusal is attributable to its one override;
--   E. request-idempotency keys — at most one committed header per user and
--      request, other events free to share the request id, ordering unique;
--   F. paper deletion and duplicate merge through the EXISTING client RPCs —
--      refused atomically while a study links the paper (no cleanup intent, no
--      attachment re-parenting, no tag or project union), allowed otherwise,
--      and the keeper's evidence preserved;
--   G. unlinking and single-statement study deletion.
--
-- Account deletion with every NO ACTION edge populated, in both RI trigger
-- orders, with the negative control, is suite 008's (it owns account deletion).
-- The two-session races are the db-tests lifecycle's evidence-FK race probe.
--
-- What this suite does NOT claim: no cross-row rule (a value's state against
-- its references, the current-copy rule, family-specific fields, limits) is
-- enforced by the schema — those belong to the RPCs of 001A2/001A3 and to their
-- suites.
--
-- Isolation: every probe runs in its own subtransaction and is undone by
-- pg_temp.probe(), so later assertions always see the planted fixture. The
-- whole suite rolls back. Deterministic UUIDs; synthetic data only; no remote
-- calls; no Production data; no real credentials.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────

CREATE FUNCTION pg_temp.claims(p_uid text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT '{"sub":"' || p_uid || '","role":"authenticated"}'
$hlp$;

-- Run p_sql as p_role with p_claims, then (as postgres) evaluate p_check, then
-- undo EVERYTHING by raising a sentinel inside the same subtransaction.
-- Returns '00000' (plus ' ' || the check result) when p_sql succeeded,
-- otherwise '<SQLSTATE>' or '<SQLSTATE>:<constraint>'. Nothing a probe does is
-- ever visible afterwards, whether it succeeded or failed.
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
    RAISE EXCEPTION 'evidence-030 probe undo' USING ERRCODE = 'P0E30';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_con = CONSTRAINT_NAME;
  END;
  -- The subtransaction's rollback already restored the role and the claims.
  IF v_state = 'P0E30' THEN
    RETURN '00000' || CASE WHEN p_check IS NOT NULL THEN ' ' || coalesce(v_check, '<null>') ELSE '' END;
  END IF;
  RETURN v_state || CASE WHEN coalesce(v_con, '') <> '' THEN ':' || v_con ELSE '' END;
END;
$hlp$;

-- One scalar from a read run as p_role, or 'ERROR <SQLSTATE>'. Undone like a probe.
CREATE FUNCTION pg_temp.read_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE
  v_out   text;
  v_state text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
    EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
    EXECUTE p_sql INTO v_out;
    RAISE EXCEPTION 'evidence-030 read undo' USING ERRCODE = 'P0E30';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  IF v_state = 'P0E30' THEN RETURN coalesce(v_out, '<null>'); END IF;
  RETURN 'ERROR ' || v_state;
END;
$hlp$;

-- An INSERT of one complete row given as JSON. Missing keys are NULL (column
-- defaults do not apply), so every base row below spells out every column.
CREATE FUNCTION pg_temp.ins(p_table text, p_row jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT format('INSERT INTO public.%I SELECT * FROM jsonb_populate_record(NULL::public.%I, %L::jsonb)',
                p_table, p_table, p_row::text)
$hlp$;

-- The rows each evidence table holds for one user, as one comparable string.
CREATE FUNCTION pg_temp.evidence_rows(p_uid uuid) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('studies=%s links=%s copies=%s arms=%s outcomes=%s values=%s refs=%s events=%s',
    (SELECT count(*) FROM public.evidence_studies          WHERE user_id = p_uid),
    (SELECT count(*) FROM public.evidence_study_reports    WHERE user_id = p_uid),
    (SELECT count(*) FROM public.evidence_source_snapshots WHERE user_id = p_uid),
    (SELECT count(*) FROM public.evidence_arms             WHERE user_id = p_uid),
    (SELECT count(*) FROM public.evidence_outcomes         WHERE user_id = p_uid),
    (SELECT count(*) FROM public.evidence_field_values     WHERE user_id = p_uid),
    (SELECT count(*) FROM public.evidence_field_anchors    WHERE user_id = p_uid),
    (SELECT count(*) FROM public.evidence_events           WHERE user_id = p_uid))
$hlp$;

-- The same counts as a role sees them through RLS.
CREATE FUNCTION pg_temp.visible_rows_sql() RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT $q$SELECT format('studies=%s links=%s copies=%s arms=%s outcomes=%s values=%s refs=%s events=%s',
    (SELECT count(*) FROM public.evidence_studies), (SELECT count(*) FROM public.evidence_study_reports),
    (SELECT count(*) FROM public.evidence_source_snapshots), (SELECT count(*) FROM public.evidence_arms),
    (SELECT count(*) FROM public.evidence_outcomes), (SELECT count(*) FROM public.evidence_field_values),
    (SELECT count(*) FROM public.evidence_field_anchors), (SELECT count(*) FROM public.evidence_events))$q$
$hlp$;

-- Plant one copy, with both fingerprints computed exactly as the RPC will.
-- (For plain ASCII text, match normalization v1 is the identity.)
CREATE FUNCTION pg_temp.plant_copy(p_id uuid, p_user uuid, p_study uuid, p_paper uuid, p_seq int, p_text text)
RETURNS void LANGUAGE sql AS $hlp$
  INSERT INTO public.evidence_source_snapshots
    (id, user_id, study_id, paper_id, seq, source_kind, exact_text, exact_sha256,
     normalized_sha256, normalization_version, char_count)
  VALUES (p_id, p_user, p_study, p_paper, p_seq, 'library_abstract', p_text,
          sha256(convert_to(p_text, 'UTF8')), sha256(convert_to(p_text, 'UTF8')), 'v1',
          char_length(p_text));
$hlp$;

-- Plant one supporting abstract quote, matched at offset 0 as the only occurrence.
CREATE FUNCTION pg_temp.plant_quote(p_id uuid, p_user uuid, p_study uuid, p_value uuid, p_paper uuid,
                                    p_copy uuid, p_position int, p_quote text)
RETURNS void LANGUAGE sql AS $hlp$
  INSERT INTO public.evidence_field_anchors
    (id, user_id, study_id, value_id, paper_id, snapshot_id, purpose, source_kind, position,
     quote_text, match_start, match_end, match_occurrence, match_count, normalization_version, matched_at)
  VALUES (p_id, p_user, p_study, p_value, p_paper, p_copy, 'supports', 'abstract', p_position,
          p_quote, 0, char_length(p_quote), 1, 1, 'v1', '2026-10-12T00:00:00Z');
$hlp$;

-- Plant one request header and its first change event at study_version 1.
CREATE FUNCTION pg_temp.plant_history(p_user uuid, p_study uuid, p_request uuid)
RETURNS void LANGUAGE sql AS $hlp$
  INSERT INTO public.evidence_events
    (user_id, study_id, study_version, ordinal, event_type, request_id, op, payload_sha256, result,
     target_id, after)
  VALUES
    (p_user, p_study, 1, 0, 'request', p_request, 'create_study', sha256('030 create'::bytea),
     jsonb_build_object('status', 'applied', 'study_version', 1, 'study_id', p_study), NULL, NULL),
    (p_user, p_study, 1, 1, 'study_created', p_request, NULL, NULL, NULL,
     p_study, jsonb_build_object('label', 'planted'));
$hlp$;

-- ── Base rows: each is VALID, and each negative test overrides one column ──

CREATE FUNCTION pg_temp.base_study() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object(
    'id', '03000599-0000-0000-0000-000000000000', 'user_id', '03000000-0000-0000-0000-0000000000a0',
    'label', 'Probe study', 'design_profile', 'rct_parallel', 'notes', NULL, 'row_version', 1,
    'created_at', '2026-10-12T00:00:00Z', 'updated_at', '2026-10-12T00:00:00Z')
$hlp$;

CREATE FUNCTION pg_temp.base_link() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object(
    'id', '03000699-0000-0000-0000-000000000000', 'user_id', '03000000-0000-0000-0000-0000000000a0',
    'study_id', '030005a1-0000-0000-0000-000000000000', 'paper_id', '030000a4-0000-0000-0000-000000000000',
    'link_status', 'provisional', 'link_basis', 'user_linked',
    'created_at', '2026-10-12T00:00:00Z', 'updated_at', '2026-10-12T00:00:00Z')
$hlp$;

-- A second copy (seq 2) of S1's link to PA1.
CREATE FUNCTION pg_temp.base_copy() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object(
    'id', '03000c99-0000-0000-0000-000000000000', 'user_id', '03000000-0000-0000-0000-0000000000a0',
    'study_id', '030005a1-0000-0000-0000-000000000000', 'paper_id', '030000a1-0000-0000-0000-000000000000',
    'seq', 2, 'source_kind', 'library_abstract', 'exact_text', 'Updated abstract.',
    'exact_sha256', sha256(convert_to('Updated abstract.', 'UTF8')),
    'normalized_sha256', sha256(convert_to('Updated abstract.', 'UTF8')),
    'normalization_version', 'v1', 'char_count', 17, 'captured_at', '2026-10-12T00:00:00Z')
$hlp$;

CREATE FUNCTION pg_temp.base_arm() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object(
    'id', '03000a99-0000-0000-0000-000000000000', 'user_id', '03000000-0000-0000-0000-0000000000a0',
    'study_id', '030005a1-0000-0000-0000-000000000000', 'arm_role', 'comparator',
    'display_label', 'Usual care', 'position', 5,
    'created_at', '2026-10-12T00:00:00Z', 'updated_at', '2026-10-12T00:00:00Z')
$hlp$;

CREATE FUNCTION pg_temp.base_outcome() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object(
    'id', '03000b99-0000-0000-0000-000000000000', 'user_id', '03000000-0000-0000-0000-0000000000a0',
    'study_id', '030005a1-0000-0000-0000-000000000000', 'display_label', 'Body weight', 'position', 5,
    'created_at', '2026-10-12T00:00:00Z', 'updated_at', '2026-10-12T00:00:00Z')
$hlp$;

-- A reported study-level value for a field S1 does not hold yet.
CREATE FUNCTION pg_temp.base_value() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object(
    'id', '03000d99-0000-0000-0000-000000000000', 'user_id', '03000000-0000-0000-0000-0000000000a0',
    'study_id', '030005a1-0000-0000-0000-000000000000', 'arm_id', NULL, 'outcome_id', NULL,
    'field_key', 'condition', 'value_state', 'reported', 'state_reason', NULL,
    'value_text', 'Type 2 diabetes', 'value_code', NULL, 'value_int', NULL, 'value_list', NULL,
    'note', NULL, 'extraction_method', 'manual', 'review_status', 'unreviewed',
    'review_reason', NULL, 'review_note', NULL, 'reviewed_at', NULL, 'reviewed_version', NULL,
    'value_version', 1, 'created_at', '2026-10-12T00:00:00Z', 'updated_at', '2026-10-12T00:00:00Z')
$hlp$;

-- A supporting abstract quote on V1 / PA1 / X1, at the free position 2.
CREATE FUNCTION pg_temp.base_quote() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object(
    'id', '03000e99-0000-0000-0000-000000000000', 'user_id', '03000000-0000-0000-0000-0000000000a0',
    'study_id', '030005a1-0000-0000-0000-000000000000', 'value_id', '03000d01-0000-0000-0000-000000000000',
    'paper_id', '030000a1-0000-0000-0000-000000000000', 'snapshot_id', '03000c01-0000-0000-0000-000000000000',
    'purpose', 'supports', 'source_kind', 'abstract', 'position', 2,
    'quote_text', 'randomized 120', 'match_start', 8, 'match_end', 22,
    'match_occurrence', 1, 'match_count', 1, 'normalization_version', 'v1',
    'matched_at', '2026-10-12T00:00:00Z', 'locator_kind', NULL, 'locator_text', NULL,
    'created_at', '2026-10-12T00:00:00Z')
$hlp$;

-- The same value, now a supporting full-text locator (no copy, no quote).
CREATE FUNCTION pg_temp.base_locator() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT pg_temp.base_quote() || jsonb_build_object(
    'snapshot_id', NULL, 'source_kind', 'full_text', 'quote_text', NULL, 'match_start', NULL,
    'match_end', NULL, 'match_occurrence', NULL, 'match_count', NULL, 'normalization_version', NULL,
    'matched_at', NULL, 'locator_kind', 'page', 'locator_text', '4')
$hlp$;

-- An `examined` assessment of PA1's abstract copy X1 (no position, no quote).
CREATE FUNCTION pg_temp.base_examined() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT pg_temp.base_quote() || jsonb_build_object(
    'purpose', 'examined', 'position', NULL, 'quote_text', NULL, 'match_start', NULL,
    'match_end', NULL, 'match_occurrence', NULL, 'match_count', NULL, 'normalization_version', NULL,
    'matched_at', NULL)
$hlp$;

-- An `unavailable` assessment of PA1's full text.
CREATE FUNCTION pg_temp.base_unavailable() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT pg_temp.base_examined() || jsonb_build_object(
    'purpose', 'unavailable', 'source_kind', 'full_text', 'snapshot_id', NULL)
$hlp$;

-- A request header for S1's second version.
CREATE FUNCTION pg_temp.base_header() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT jsonb_build_object(
    'id', '03000f99-0000-0000-0000-000000000000', 'user_id', '03000000-0000-0000-0000-0000000000a0',
    'study_id', '030005a1-0000-0000-0000-000000000000', 'study_version', 2, 'ordinal', 0,
    'event_type', 'request', 'request_id', '03000199-0000-0000-0000-000000000000',
    'op', 'save_changes', 'payload_sha256', sha256('030 payload'::bytea),
    'result', jsonb_build_object('status', 'applied', 'study_version', 2),
    'target_id', NULL, 'field_key', NULL, 'before', NULL, 'after', NULL, 'note', NULL,
    'occurred_at', '2026-10-12T00:00:00Z')
$hlp$;

-- A change event (ordinal 1) of that request.
CREATE FUNCTION pg_temp.base_change() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT pg_temp.base_header() || jsonb_build_object(
    'id', '03000f98-0000-0000-0000-000000000000', 'ordinal', 1, 'event_type', 'value_saved',
    'op', NULL, 'payload_sha256', NULL, 'result', NULL,
    'target_id', '03000d01-0000-0000-0000-000000000000', 'field_key', 'population_description',
    'before', NULL, 'after', jsonb_build_object('value_state', 'reported'))
$hlp$;

-- ── Fixtures — also the VALID relationship examples (001A D4) ───────────────
-- Account A is under test; account B is an untouched neighbour. Inserting into
-- auth.users fires handle_new_user, as in suites 008 and 014.
--   S1, S2 — two studies reported in ONE paper (PA1), each with its own copy.
--   S3     — one study reported in TWO papers (PA2 main, PA3 follow-up): a
--            quote from the follow-up's copy, a full-text locator on the main
--            report, and missing-value states scoped to named sources.
--   S4     — linked to the merge keeper PA5.  S5 — linked to the merge discard PA7.
--   PA4    — unlinked.  PA6 — an unlinked merge discard.

INSERT INTO auth.users (id, email) VALUES
  ('03000000-0000-0000-0000-0000000000a0', 'evidence-030-a@paperlume.test'),
  ('03000000-0000-0000-0000-0000000000b0', 'evidence-030-b@paperlume.test');

INSERT INTO public.papers (id, user_id, title, abstract, insert_order) VALUES
  ('030000a1-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'PA1 reports two studies',     'Study 1 randomized 120. Study 2 randomized 80.', 1),
  ('030000a2-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'PA2 main report of S3',       'Main report abstract.',                          2),
  ('030000a3-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'PA3 follow-up report of S3',  'Follow-up abstract.',                            3),
  ('030000a4-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'PA4 unlinked',                NULL,                                             4),
  ('030000a5-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'PA5 merge keeper, linked',    'Keeper abstract.',                               5),
  ('030000a6-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'PA6 merge discard, unlinked', 'Discard abstract.',                              6),
  ('030000a7-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'PA7 merge discard, linked',   'Linked discard abstract.',                       7),
  ('030000b1-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000b0', 'PB1 neighbour',               'Neighbour abstract.',                            8);

-- A tag and a project on the linked discard, so a refused merge can be shown
-- not to have unioned either onto the keeper.
INSERT INTO public.tags (id, user_id, name) VALUES
  ('03000aa7-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'evidence-030 tag on PA7');
INSERT INTO public.paper_tags (paper_id, tag_id) VALUES
  ('030000a7-0000-0000-0000-000000000000', '03000aa7-0000-0000-0000-000000000000');
INSERT INTO public.projects (id, user_id, name) VALUES
  ('03000ab7-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'evidence-030 project on PA7');
INSERT INTO public.paper_projects (paper_id, project_id) VALUES
  ('030000a7-0000-0000-0000-000000000000', '03000ab7-0000-0000-0000-000000000000');

-- Attachment metadata on PA1 (so a refused delete would have queued a cleanup
-- intent) and on PA7 (so a refused merge would have re-parented it). The BEFORE
-- INSERT quota trigger requires auth.uid() = NEW.user_id (see suite 008).
SELECT set_config('request.jwt.claims', pg_temp.claims('03000000-0000-0000-0000-0000000000a0'), true);
INSERT INTO public.paper_attachments (id, paper_id, user_id, file_path, file_name, file_type, size_bytes) VALUES
  ('03000f01-0000-0000-0000-000000000000', '030000a1-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0',
   '03000000-0000-0000-0000-0000000000a0/030000a1-0000-0000-0000-000000000000/pa1.pdf', 'pa1.pdf', 'application/pdf', 1000),
  ('03000f07-0000-0000-0000-000000000000', '030000a7-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0',
   '03000000-0000-0000-0000-0000000000a0/030000a7-0000-0000-0000-000000000000/pa7.pdf', 'pa7.pdf', 'application/pdf', 1000);
SELECT set_config('request.jwt.claims', '', true);

INSERT INTO public.evidence_studies (id, user_id, label, design_profile) VALUES
  ('030005a1-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'Study 1 of PA1',        'rct_parallel'),
  ('030005a2-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'Study 2 of PA1',        'rct_parallel'),
  ('030005a3-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'Study in PA2 and PA3',  'intervention_other'),
  ('030005a4-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'Study of the keeper',   'non_intervention'),
  ('030005a5-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', 'Study of the discard',  'rct_parallel'),
  ('030005b1-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000b0', 'Neighbour study',       'rct_parallel');

INSERT INTO public.evidence_study_reports (user_id, study_id, paper_id, link_status, link_basis) VALUES
  ('03000000-0000-0000-0000-0000000000a0', '030005a1-0000-0000-0000-000000000000', '030000a1-0000-0000-0000-000000000000', 'user_confirmed', 'created_from_paper'),
  ('03000000-0000-0000-0000-0000000000a0', '030005a2-0000-0000-0000-000000000000', '030000a1-0000-0000-0000-000000000000', 'user_confirmed', 'created_from_paper'),
  ('03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', '030000a2-0000-0000-0000-000000000000', 'user_confirmed', 'created_from_paper'),
  ('03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', '030000a3-0000-0000-0000-000000000000', 'provisional',    'user_linked'),
  ('03000000-0000-0000-0000-0000000000a0', '030005a4-0000-0000-0000-000000000000', '030000a5-0000-0000-0000-000000000000', 'user_confirmed', 'created_from_paper'),
  ('03000000-0000-0000-0000-0000000000a0', '030005a5-0000-0000-0000-000000000000', '030000a7-0000-0000-0000-000000000000', 'user_confirmed', 'created_from_paper'),
  ('03000000-0000-0000-0000-0000000000b0', '030005b1-0000-0000-0000-000000000000', '030000b1-0000-0000-0000-000000000000', 'user_confirmed', 'created_from_paper');

SELECT pg_temp.plant_copy('03000c01-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a1-0000-0000-0000-000000000000', '030000a1-0000-0000-0000-000000000000', 1, 'Study 1 randomized 120. Study 2 randomized 80.');
SELECT pg_temp.plant_copy('03000c02-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a2-0000-0000-0000-000000000000', '030000a1-0000-0000-0000-000000000000', 1, 'Study 1 randomized 120. Study 2 randomized 80.');
SELECT pg_temp.plant_copy('03000c03-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', '030000a2-0000-0000-0000-000000000000', 1, 'Main report abstract.');
SELECT pg_temp.plant_copy('03000c04-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', '030000a3-0000-0000-0000-000000000000', 1, 'Follow-up abstract.');
SELECT pg_temp.plant_copy('03000c05-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a4-0000-0000-0000-000000000000', '030000a5-0000-0000-0000-000000000000', 1, 'Keeper abstract.');
SELECT pg_temp.plant_copy('03000c06-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a5-0000-0000-0000-000000000000', '030000a7-0000-0000-0000-000000000000', 1, 'Linked discard abstract.');
SELECT pg_temp.plant_copy('03000c0b-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000b0', '030005b1-0000-0000-0000-000000000000', '030000b1-0000-0000-0000-000000000000', 1, 'Neighbour abstract.');

INSERT INTO public.evidence_arms (id, user_id, study_id, arm_role, display_label, position) VALUES
  ('03000a01-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a1-0000-0000-0000-000000000000', 'intervention', 'Metformin', 0),
  ('03000a02-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a1-0000-0000-0000-000000000000', 'comparator',   'Placebo',   1);
-- O2 holds no value yet, so a probe can record its time points without also
-- colliding with an existing row.
INSERT INTO public.evidence_outcomes (id, user_id, study_id, display_label, position) VALUES
  ('03000b01-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a1-0000-0000-0000-000000000000', 'HbA1c', 0),
  ('03000b02-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a1-0000-0000-0000-000000000000', 'Body weight', 1);

INSERT INTO public.evidence_field_values
  (id, user_id, study_id, arm_id, outcome_id, field_key, value_state, state_reason, value_text, value_code, value_int, value_list, note) VALUES
  ('03000d01-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a1-0000-0000-0000-000000000000', NULL, NULL, 'population_description', 'reported', NULL, 'Adults with type 2 diabetes', NULL, NULL, NULL, NULL),
  ('03000d02-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a2-0000-0000-0000-000000000000', NULL, NULL, 'n_randomized', 'reported', NULL, 'randomized 80', NULL, 80, NULL, NULL),
  ('03000d03-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', NULL, NULL, 'condition', 'reported', NULL, 'Hypertension', NULL, NULL, NULL, NULL),
  ('03000d04-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a4-0000-0000-0000-000000000000', NULL, NULL, 'design_classification', 'reported', NULL, NULL, 'cohort', NULL, NULL, NULL),
  ('03000d05-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a5-0000-0000-0000-000000000000', NULL, NULL, 'registration_ids', 'reported', NULL, NULL, NULL, NULL, ARRAY['NCT01234567'], NULL),
  ('03000d06-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', NULL, NULL, 'demographics', 'not_reported', NULL, NULL, NULL, NULL, NULL, NULL),
  ('03000d07-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', NULL, NULL, 'eligibility_criteria', 'source_unavailable', NULL, NULL, NULL, NULL, NULL, 'No full text in the library.'),
  ('03000d11-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a1-0000-0000-0000-000000000000', '03000a01-0000-0000-0000-000000000000', NULL, 'description', 'reported', NULL, 'Metformin 1 g twice daily', NULL, NULL, NULL, NULL),
  ('03000d12-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a1-0000-0000-0000-000000000000', NULL, '03000b01-0000-0000-0000-000000000000', 'time_points', 'reported', NULL, NULL, NULL, NULL, ARRAY['12 weeks', '6 months after randomization'], NULL),
  ('03000d0b-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000b0', '030005b1-0000-0000-0000-000000000000', NULL, NULL, 'condition', 'reported', NULL, 'Asthma', NULL, NULL, NULL, NULL);

-- Supporting quotes: one per study's own copy, and on S3 from the SECOND report.
SELECT pg_temp.plant_quote('03000e01-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a1-0000-0000-0000-000000000000', '03000d01-0000-0000-0000-000000000000', '030000a1-0000-0000-0000-000000000000', '03000c01-0000-0000-0000-000000000000', 0, 'Study 1 randomized 120');
SELECT pg_temp.plant_quote('03000e02-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a2-0000-0000-0000-000000000000', '03000d02-0000-0000-0000-000000000000', '030000a1-0000-0000-0000-000000000000', '03000c02-0000-0000-0000-000000000000', 0, 'Study 2 randomized 80');
SELECT pg_temp.plant_quote('03000e03-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', '03000d03-0000-0000-0000-000000000000', '030000a3-0000-0000-0000-000000000000', '03000c04-0000-0000-0000-000000000000', 0, 'Follow-up abstract');
SELECT pg_temp.plant_quote('03000e05-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a4-0000-0000-0000-000000000000', '03000d04-0000-0000-0000-000000000000', '030000a5-0000-0000-0000-000000000000', '03000c05-0000-0000-0000-000000000000', 0, 'Keeper abstract');
SELECT pg_temp.plant_quote('03000e06-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a5-0000-0000-0000-000000000000', '03000d05-0000-0000-0000-000000000000', '030000a7-0000-0000-0000-000000000000', '03000c06-0000-0000-0000-000000000000', 0, 'Linked discard abstract');
SELECT pg_temp.plant_quote('03000e0b-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000b0', '030005b1-0000-0000-0000-000000000000', '03000d0b-0000-0000-0000-000000000000', '030000b1-0000-0000-0000-000000000000', '03000c0b-0000-0000-0000-000000000000', 0, 'Neighbour abstract');

-- S3's other references: a full-text locator on the MAIN report (no copy), an
-- `examined` assessment of the main report's abstract copy and one of the
-- follow-up's full text (the "Not reported" value V6 is scoped to exactly those
-- two sources), and an `unavailable` full text for V7 ("Couldn't check").
INSERT INTO public.evidence_field_anchors
  (id, user_id, study_id, value_id, paper_id, snapshot_id, purpose, source_kind, position, locator_kind, locator_text) VALUES
  ('03000e04-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', '03000d03-0000-0000-0000-000000000000', '030000a2-0000-0000-0000-000000000000', NULL, 'supports', 'full_text', 1, 'table', 'Table 2'),
  ('03000e07-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', '03000d06-0000-0000-0000-000000000000', '030000a2-0000-0000-0000-000000000000', '03000c03-0000-0000-0000-000000000000', 'examined', 'abstract', NULL, NULL, NULL),
  ('03000e08-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', '03000d06-0000-0000-0000-000000000000', '030000a3-0000-0000-0000-000000000000', NULL, 'examined', 'full_text', NULL, 'section', 'Methods'),
  ('03000e09-0000-0000-0000-000000000000', '03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', '03000d07-0000-0000-0000-000000000000', '030000a2-0000-0000-0000-000000000000', NULL, 'unavailable', 'full_text', NULL, NULL, NULL);

SELECT pg_temp.plant_history('03000000-0000-0000-0000-0000000000a0', '030005a1-0000-0000-0000-000000000000', '03000101-0000-0000-0000-000000000000');
SELECT pg_temp.plant_history('03000000-0000-0000-0000-0000000000a0', '030005a2-0000-0000-0000-000000000000', '03000102-0000-0000-0000-000000000000');
SELECT pg_temp.plant_history('03000000-0000-0000-0000-0000000000a0', '030005a3-0000-0000-0000-000000000000', '03000103-0000-0000-0000-000000000000');
SELECT pg_temp.plant_history('03000000-0000-0000-0000-0000000000a0', '030005a4-0000-0000-0000-000000000000', '03000104-0000-0000-0000-000000000000');
SELECT pg_temp.plant_history('03000000-0000-0000-0000-0000000000a0', '030005a5-0000-0000-0000-000000000000', '03000105-0000-0000-0000-000000000000');
SELECT pg_temp.plant_history('03000000-0000-0000-0000-0000000000b0', '030005b1-0000-0000-0000-000000000000', '030001b1-0000-0000-0000-000000000000');

SELECT plan(178);

-- ═════════════════════════════════════════════════════════════════════════════
-- A. Catalog contract
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT string_agg(c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text
                     || ':' || pg_get_userbyid(c.relowner), ',' ORDER BY c.relname)
     FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'evidence\_%'),
  'evidence_arms:true:true:postgres,evidence_events:true:true:postgres,'
  || 'evidence_field_anchors:true:true:postgres,evidence_field_values:true:true:postgres,'
  || 'evidence_outcomes:true:true:postgres,evidence_source_snapshots:true:true:postgres,'
  || 'evidence_studies:true:true:postgres,evidence_study_reports:true:true:postgres',
  'A1 exactly the eight evidence tables exist, owned by postgres, with RLS enabled and forced');

-- A2: the column contract of each table, in order, with types and NOT NULL.
CREATE TEMP TABLE e030_columns (relname text PRIMARY KEY, cols text NOT NULL);
INSERT INTO e030_columns VALUES
  ('evidence_studies', 'id uuid!, user_id uuid!, label text!, design_profile text!, notes text, row_version integer!, created_at timestamp with time zone!, updated_at timestamp with time zone!'),
  ('evidence_study_reports', 'id uuid!, user_id uuid!, study_id uuid!, paper_id uuid!, link_status text!, link_basis text!, created_at timestamp with time zone!, updated_at timestamp with time zone!'),
  ('evidence_source_snapshots', 'id uuid!, user_id uuid!, study_id uuid!, paper_id uuid!, seq integer!, source_kind text!, exact_text text!, exact_sha256 bytea!, normalized_sha256 bytea!, normalization_version text!, char_count integer!, captured_at timestamp with time zone!'),
  ('evidence_arms', 'id uuid!, user_id uuid!, study_id uuid!, arm_role text!, display_label text!, position integer!, created_at timestamp with time zone!, updated_at timestamp with time zone!'),
  ('evidence_outcomes', 'id uuid!, user_id uuid!, study_id uuid!, display_label text!, position integer!, created_at timestamp with time zone!, updated_at timestamp with time zone!'),
  ('evidence_field_values', 'id uuid!, user_id uuid!, study_id uuid!, arm_id uuid, outcome_id uuid, field_key text!, value_state text!, state_reason text, value_text text, value_code text, value_int integer, value_list text[], note text, extraction_method text!, review_status text!, review_reason text, review_note text, reviewed_at timestamp with time zone, reviewed_version integer, value_version integer!, created_at timestamp with time zone!, updated_at timestamp with time zone!'),
  ('evidence_field_anchors', 'id uuid!, user_id uuid!, study_id uuid!, value_id uuid!, paper_id uuid!, snapshot_id uuid, purpose text!, source_kind text!, position integer, quote_text text, match_start integer, match_end integer, match_occurrence integer, match_count integer, normalization_version text, matched_at timestamp with time zone, locator_kind text, locator_text text, created_at timestamp with time zone!'),
  ('evidence_events', 'id uuid!, user_id uuid!, study_id uuid!, study_version integer!, ordinal integer!, event_type text!, request_id uuid!, op text, payload_sha256 bytea, result jsonb, target_id uuid, field_key text, before jsonb, after jsonb, note text, occurred_at timestamp with time zone!');

SELECT is(
  (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN '!' ELSE '' END,
                     ', ' ORDER BY a.attnum)
     FROM pg_attribute a
    WHERE a.attrelid = to_regclass('public.' || e.relname) AND a.attnum > 0 AND NOT a.attisdropped),
  e.cols,
  'A2 column contract of ' || e.relname)
FROM e030_columns e ORDER BY e.relname;

SELECT is(
  (SELECT string_agg(c.relname || '|' || p.polname || '|' || p.polcmd::text || '|' || p.polpermissive::text || '|'
                     || array_to_string(p.polroles::regrole[]::text[], ',') || '|' || pg_get_expr(p.polqual, p.polrelid)
                     || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-'), E'\n' ORDER BY c.relname)
     FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'evidence\_%'),
  'evidence_arms|Users can view their own evidence arms|r|true|authenticated|(auth.uid() = user_id)|-' || E'\n'
  || 'evidence_events|Users can view their own evidence events|r|true|authenticated|(auth.uid() = user_id)|-' || E'\n'
  || 'evidence_field_anchors|Users can view their own evidence field anchors|r|true|authenticated|(auth.uid() = user_id)|-' || E'\n'
  || 'evidence_field_values|Users can view their own evidence field values|r|true|authenticated|(auth.uid() = user_id)|-' || E'\n'
  || 'evidence_outcomes|Users can view their own evidence outcomes|r|true|authenticated|(auth.uid() = user_id)|-' || E'\n'
  || 'evidence_source_snapshots|Users can view their own evidence source snapshots|r|true|authenticated|(auth.uid() = user_id)|-' || E'\n'
  || 'evidence_studies|Users can view their own evidence studies|r|true|authenticated|(auth.uid() = user_id)|-' || E'\n'
  || 'evidence_study_reports|Users can view their own evidence study reports|r|true|authenticated|(auth.uid() = user_id)|-',
  'A3 each table has exactly one policy: a permissive owner-only SELECT for authenticated, no write policy');

-- The whole foreign-key inventory: columns, target, ON DELETE action, and
-- whether it is deferrable. Exactly three NO ACTION ("a") edges, none deferrable.
SELECT is(
  (SELECT string_agg(k.conname || '(' ||
            (SELECT string_agg(a.attname, ',' ORDER BY o.ord)
               FROM unnest(k.conkey) WITH ORDINALITY AS o(n, ord)
               JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = o.n)
            || ')>' || tn.nspname || '.' || tc.relname || '(' ||
            (SELECT string_agg(a.attname, ',' ORDER BY o.ord)
               FROM unnest(k.confkey) WITH ORDINALITY AS o(n, ord)
               JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = o.n)
            || '):' || k.confdeltype::text || CASE WHEN k.condeferrable THEN ':deferrable' ELSE '' END,
            E'\n' ORDER BY k.conname)
     FROM pg_constraint k
     JOIN pg_class c ON c.oid = k.conrelid
     JOIN pg_class tc ON tc.oid = k.confrelid
     JOIN pg_namespace tn ON tn.oid = tc.relnamespace
    WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'evidence\_%'),
  'evidence_arms_study_fkey(user_id,study_id)>public.evidence_studies(user_id,id):c' || E'\n'
  || 'evidence_arms_user_id_fkey(user_id)>auth.users(id):c' || E'\n'
  || 'evidence_events_study_fkey(user_id,study_id)>public.evidence_studies(user_id,id):c' || E'\n'
  || 'evidence_events_user_id_fkey(user_id)>auth.users(id):c' || E'\n'
  || 'evidence_field_anchors_link_fkey(user_id,study_id,paper_id)>public.evidence_study_reports(user_id,study_id,paper_id):a' || E'\n'
  || 'evidence_field_anchors_snapshot_fkey(user_id,study_id,paper_id,snapshot_id)>public.evidence_source_snapshots(user_id,study_id,paper_id,id):a' || E'\n'
  || 'evidence_field_anchors_study_fkey(user_id,study_id)>public.evidence_studies(user_id,id):c' || E'\n'
  || 'evidence_field_anchors_user_id_fkey(user_id)>auth.users(id):c' || E'\n'
  || 'evidence_field_anchors_value_fkey(user_id,study_id,value_id)>public.evidence_field_values(user_id,study_id,id):c' || E'\n'
  || 'evidence_field_values_arm_fkey(user_id,study_id,arm_id)>public.evidence_arms(user_id,study_id,id):c' || E'\n'
  || 'evidence_field_values_outcome_fkey(user_id,study_id,outcome_id)>public.evidence_outcomes(user_id,study_id,id):c' || E'\n'
  || 'evidence_field_values_study_fkey(user_id,study_id)>public.evidence_studies(user_id,id):c' || E'\n'
  || 'evidence_field_values_user_id_fkey(user_id)>auth.users(id):c' || E'\n'
  || 'evidence_outcomes_study_fkey(user_id,study_id)>public.evidence_studies(user_id,id):c' || E'\n'
  || 'evidence_outcomes_user_id_fkey(user_id)>auth.users(id):c' || E'\n'
  || 'evidence_source_snapshots_link_fkey(user_id,study_id,paper_id)>public.evidence_study_reports(user_id,study_id,paper_id):c' || E'\n'
  || 'evidence_source_snapshots_study_fkey(user_id,study_id)>public.evidence_studies(user_id,id):c' || E'\n'
  || 'evidence_source_snapshots_user_id_fkey(user_id)>auth.users(id):c' || E'\n'
  || 'evidence_studies_user_id_fkey(user_id)>auth.users(id):c' || E'\n'
  || 'evidence_study_reports_paper_fkey(user_id,paper_id)>public.papers(user_id,id):a' || E'\n'
  || 'evidence_study_reports_study_fkey(user_id,study_id)>public.evidence_studies(user_id,id):c' || E'\n'
  || 'evidence_study_reports_user_id_fkey(user_id)>auth.users(id):c',
  'A4 the foreign-key inventory is exactly the reviewed one: 22 keys, three immediate NO ACTION edges');

-- D7 rule 1, catalog-driven so a future key is held to it too.
SELECT is(
  (SELECT coalesce(string_agg(k.conname, ', ' ORDER BY k.conname), '')
     FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'evidence\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey) AND a.attname = 'user_id')),
  '',
  'A5 every foreign key out of an evidence table carries user_id (no cross-user edge is storable)');

-- Every evidence table clears in the FIRST generation of the account cascade.
SELECT is(
  (SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '')
     FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'evidence\_%'
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
         WHERE k.conrelid = c.oid AND k.contype = 'f' AND k.confrelid = 'auth.users'::regclass
           AND cardinality(k.conkey) = 1 AND a.attname = 'user_id' AND k.confdeltype = 'c')),
  '',
  'A6 every evidence table has its own user_id -> auth.users ON DELETE CASCADE');

-- D7 rule 2: every child of a study cascades from it directly, so a single
-- DELETE of a study, or of an account, never depends on a second generation.
SELECT is(
  (SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '')
     FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'evidence\_%'
      AND c.relname <> 'evidence_studies'
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint k
         WHERE k.conrelid = c.oid AND k.contype = 'f' AND k.confrelid = 'public.evidence_studies'::regclass
           AND k.confdeltype = 'c'
           AND (SELECT array_agg(a.attname::text ORDER BY o.ord)
                  FROM unnest(k.conkey) WITH ORDINALITY AS o(n, ord)
                  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = o.n) = ARRAY['user_id', 'study_id'])),
  '',
  'A7 every child of a study has a direct (user_id, study_id) -> evidence_studies ON DELETE CASCADE');

-- Each NO ACTION check, each cascade and the request lookup are served by an index.
SELECT is(
  (SELECT string_agg(pg_get_indexdef(i.indexrelid), E'\n' ORDER BY i.indexrelid::regclass::text)
     FROM pg_index i
    WHERE i.indexrelid IN (to_regclass('public.evidence_study_reports_paper_idx'),
                           to_regclass('public.evidence_field_anchors_source_idx'),
                           to_regclass('public.evidence_events_request_header_key'),
                           to_regclass('public.evidence_events_order_key'),
                           to_regclass('public.evidence_field_anchors_assessment_key'),
                           to_regclass('public.evidence_field_anchors_value_position_key'),
                           to_regclass('public.evidence_field_values_entity_field_key'))),
  'CREATE UNIQUE INDEX evidence_events_order_key ON public.evidence_events USING btree (user_id, study_id, study_version, ordinal)' || E'\n'
  || 'CREATE UNIQUE INDEX evidence_events_request_header_key ON public.evidence_events USING btree (user_id, request_id) WHERE (ordinal = 0)' || E'\n'
  || 'CREATE UNIQUE INDEX evidence_field_anchors_assessment_key ON public.evidence_field_anchors USING btree (value_id, paper_id, source_kind) WHERE (purpose <> ''supports''::text)' || E'\n'
  || 'CREATE INDEX evidence_field_anchors_source_idx ON public.evidence_field_anchors USING btree (user_id, study_id, paper_id, snapshot_id)' || E'\n'
  || 'CREATE UNIQUE INDEX evidence_field_anchors_value_position_key ON public.evidence_field_anchors USING btree (value_id, "position")' || E'\n'
  || 'CREATE UNIQUE INDEX evidence_field_values_entity_field_key ON public.evidence_field_values USING btree (study_id, arm_id, outcome_id, field_key) NULLS NOT DISTINCT' || E'\n'
  || 'CREATE INDEX evidence_study_reports_paper_idx ON public.evidence_study_reports USING btree (user_id, paper_id)',
  'A8 the NO ACTION, request-header, ordering and uniqueness indexes are exactly as reviewed');

SELECT is(
  (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'evidence\_%' AND NOT t.tgisinternal),
  0,
  'A9 no trigger of any kind sits on an evidence table (nothing runs on the account-deletion cascade path)');

-- EVIDENCE-RECORDS-001A1 added no function. EVIDENCE-RECORDS-001A2 later added
-- six — four RPCs and two internal helpers, owned by suite 031 — and
-- EVIDENCE-RECORDS-001A3 six more — three RPCs and three internal helpers,
-- owned by suite 033 — so any other evidence function, or an overload of one of
-- these, fails here.
SELECT is(
  (SELECT coalesce(string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C"), '')
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'),
  'evidence_create_study_from_paper(uuid,text,text,text,uuid), evidence_delete_study(uuid,integer,uuid), '
  || 'evidence_locate_quote(text[],text), evidence_normalize_v1(text), '
  || 'evidence_rebase_source(uuid,uuid,integer,text,uuid), evidence_records_assert_writable(), '
  || 'evidence_review_fields(uuid,integer,uuid,integer,text,text,uuid), evidence_save_changes(uuid,integer,jsonb,uuid), '
  || 'evidence_set_link(uuid,uuid,text,integer,uuid), evidence_state_reference_problems(text,integer,integer,integer), '
  || 'evidence_update_study(uuid,integer,text,text,text,uuid), evidence_value_digest(uuid,uuid)',
  'A10 the evidence functions are exactly the twelve EVIDENCE-RECORDS-001A2 and 001A3 reviewed; nothing else writes evidence');

-- ═════════════════════════════════════════════════════════════════════════════
-- B. Privilege surface (suite 015 owns the whole-schema matrix; these are the
--    evidence-specific real attempts)
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT string_agg(c.relname || '=' ||
            (SELECT coalesce(string_agg(p, ',' ORDER BY p), '')
               FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
              WHERE has_table_privilege('authenticated', c.oid, p)), ' ' ORDER BY c.relname)
     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'evidence\_%'),
  'evidence_arms=SELECT evidence_events=SELECT evidence_field_anchors=SELECT evidence_field_values=SELECT '
  || 'evidence_outcomes=SELECT evidence_source_snapshots=SELECT evidence_studies=SELECT evidence_study_reports=SELECT',
  'B1 authenticated holds exactly SELECT on every evidence table (effective, PUBLIC included)');

SELECT is(
  (SELECT coalesce(string_agg(c.relname || ':' || r.rolname, ' ' ORDER BY c.relname, r.rolname), '')
     FROM pg_class c CROSS JOIN pg_roles r
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'evidence\_%'
      AND r.rolname IN ('anon', 'service_role')
      AND has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')),
  '',
  'B2 anon and service_role hold no privilege of any kind on any evidence table');

SELECT is(
  (SELECT string_agg(c.relname || '=' || coalesce(c.relacl::text, '<default>'), ' ' ORDER BY c.relname)
     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'evidence\_%'),
  'evidence_arms={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  || 'evidence_events={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  || 'evidence_field_anchors={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  || 'evidence_field_values={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  || 'evidence_outcomes={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  || 'evidence_source_snapshots={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  || 'evidence_studies={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  || 'evidence_study_reports={postgres=arwdDxtm/postgres,authenticated=r/postgres}',
  'B3 the stored ACL of every evidence table is exactly the owner plus authenticated=r');

-- Real write attempts by a signed-in owner of the rows: every one refused at
-- the privilege check (42501) before any policy or key is consulted.
CREATE TEMP TABLE e030_writes (relname text PRIMARY KEY, base jsonb NOT NULL, upd text NOT NULL);
INSERT INTO e030_writes VALUES
  ('evidence_studies',          pg_temp.base_study(),   'label = ''x'''),
  ('evidence_study_reports',    pg_temp.base_link(),    'link_status = ''provisional'''),
  ('evidence_source_snapshots', pg_temp.base_copy(),    'seq = seq'),
  ('evidence_arms',             pg_temp.base_arm(),     'position = position'),
  ('evidence_outcomes',         pg_temp.base_outcome(), 'position = position'),
  ('evidence_field_values',     pg_temp.base_value(),   'review_status = ''unreviewed'''),
  ('evidence_field_anchors',    pg_temp.base_quote(),   'position = position'),
  ('evidence_events',           pg_temp.base_header(),  'note = NULL');

SELECT is(
  'INSERT=' || pg_temp.probe('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000a0'), pg_temp.ins(w.relname, w.base))
  || ' UPDATE=' || pg_temp.probe('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000a0'),
                                 format('UPDATE public.%I SET %s', w.relname, w.upd))
  || ' DELETE=' || pg_temp.probe('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000a0'),
                                 format('DELETE FROM public.%I', w.relname))
  || ' TRUNCATE=' || pg_temp.probe('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000a0'),
                                   format('TRUNCATE public.%I CASCADE', w.relname)),
  'INSERT=42501 UPDATE=42501 DELETE=42501 TRUNCATE=42501',
  'B4 a signed-in user cannot write ' || w.relname || ' directly (no browser write path)')
FROM e030_writes w ORDER BY w.relname;

-- Each base row is itself valid, so the 42501s above are privilege refusals
-- and not a malformed row.
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins(w.relname, w.base)), '00000',
  'B5 positive control: the base row for ' || w.relname || ' is accepted from the owner')
FROM e030_writes w ORDER BY w.relname;

SELECT is(
  pg_temp.probe('anon', NULL, 'SELECT count(*) FROM public.evidence_studies') || ' '
  || pg_temp.probe('anon', NULL, 'SELECT count(*) FROM public.evidence_field_anchors') || ' '
  || pg_temp.probe('service_role', NULL, 'SELECT count(*) FROM public.evidence_studies') || ' '
  || pg_temp.probe('service_role', NULL, 'SELECT count(*) FROM public.evidence_events'),
  '42501 42501 42501 42501',
  'B6 anon and service_role cannot read evidence rows (real attempts)');

-- RLS: each signed-in user sees exactly their own rows; a token without a
-- subject sees nothing.
SELECT is(
  pg_temp.read_as('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000a0'), pg_temp.visible_rows_sql()),
  'studies=5 links=6 copies=6 arms=2 outcomes=2 values=9 refs=9 events=10',
  'B7 RLS: user A sees all and only its own evidence rows');
SELECT is(
  pg_temp.read_as('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000b0'), pg_temp.visible_rows_sql()),
  'studies=1 links=1 copies=1 arms=0 outcomes=0 values=1 refs=1 events=2',
  'B8 RLS: user B sees all and only its own evidence rows');
SELECT is(
  pg_temp.read_as('authenticated', '{"role":"authenticated"}', pg_temp.visible_rows_sql()),
  'studies=0 links=0 copies=0 arms=0 outcomes=0 values=0 refs=0 events=0',
  'B9 RLS: an authenticated token with no subject sees no evidence row');
SELECT is(
  pg_temp.read_as('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000b0'),
    $q$SELECT count(*)::text FROM public.evidence_source_snapshots WHERE id = '03000c01-0000-0000-0000-000000000000'$q$),
  '0',
  'B10 RLS: B cannot read A''s saved abstract copy even by its id');

-- ═════════════════════════════════════════════════════════════════════════════
-- C. Integrity — every row below is attempted as postgres (BYPASSRLS), so only
--    the keys can refuse it. Each breaks exactly one key unless it says so.
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.evidence_rows('03000000-0000-0000-0000-0000000000a0'),
  'studies=5 links=6 copies=6 arms=2 outcomes=2 values=9 refs=9 events=10',
  'C0 every valid fixture row was accepted (A): two studies in one paper, one study across two reports');
SELECT is(pg_temp.evidence_rows('03000000-0000-0000-0000-0000000000b0'),
  'studies=1 links=1 copies=1 arms=0 outcomes=0 values=1 refs=1 events=2',
  'C0 every valid fixture row was accepted (B, the neighbour)');

SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors',
    pg_temp.base_quote() || '{"value_id": "03000d02-0000-0000-0000-000000000000"}')),
  '23503:evidence_field_anchors_value_fkey',
  'C1 a reference to a value of ANOTHER study is refused (R1)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors',
    pg_temp.base_quote() || '{"snapshot_id": "03000c02-0000-0000-0000-000000000000"}')),
  '23503:evidence_field_anchors_snapshot_fkey',
  'C2 a quote from the OTHER study''s copy of the same paper is refused (R3)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors',
    pg_temp.base_locator() || '{"paper_id": "030000a2-0000-0000-0000-000000000000"}')),
  '23503:evidence_field_anchors_link_fkey',
  'C3 a full-text reference to a report the study is not linked to is refused (R2)');
SELECT is(split_part(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors',
    pg_temp.base_quote() || '{"paper_id": "030000a2-0000-0000-0000-000000000000", "snapshot_id": "03000c03-0000-0000-0000-000000000000"}')), ':', 1),
  '23503',
  'C4 a quote from an unlinked report''s copy is refused (it breaks two keys)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors',
    pg_temp.base_locator() || '{"paper_id": "030000b1-0000-0000-0000-000000000000"}')),
  '23503:evidence_field_anchors_link_fkey',
  'C5 a reference to ANOTHER ACCOUNT''s paper is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_source_snapshots',
    pg_temp.base_copy() || '{"paper_id": "030000a2-0000-0000-0000-000000000000", "seq": 1}')),
  '23503:evidence_source_snapshots_link_fkey',
  'C6 a copy of a report that is not linked to the study is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_study_reports',
    pg_temp.base_link() || '{"paper_id": "030000b1-0000-0000-0000-000000000000"}')),
  '23503:evidence_study_reports_paper_fkey',
  'C7 a link to ANOTHER ACCOUNT''s paper is refused');
SELECT is(split_part(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors',
    pg_temp.base_quote() || '{"user_id": "03000000-0000-0000-0000-0000000000b0"}')), ':', 1),
  '23503',
  'C8 a row owned by B that points into A''s study is refused (it breaks several keys)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values',
    pg_temp.base_value() || '{"study_id": "030005a2-0000-0000-0000-000000000000", "arm_id": "03000a01-0000-0000-0000-000000000000", "field_key": "description"}')),
  '23503:evidence_field_values_arm_fkey',
  'C9 a value on ANOTHER study''s group is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values',
    pg_temp.base_value() || '{"study_id": "030005a2-0000-0000-0000-000000000000", "outcome_id": "03000b01-0000-0000-0000-000000000000", "field_key": "outcome_definition"}')),
  '23503:evidence_field_values_outcome_fkey',
  'C10 a value on ANOTHER study''s outcome is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_study_reports',
    pg_temp.base_link() || '{"study_id": "030005b1-0000-0000-0000-000000000000"}')),
  '23503:evidence_study_reports_study_fkey',
  'C11 a link from A into B''s study is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events',
    pg_temp.base_header() || '{"study_id": "030005b1-0000-0000-0000-000000000000"}')),
  '23503:evidence_events_study_fkey',
  'C12 a history row from A on B''s study is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_arms',
    pg_temp.base_arm() || '{"study_id": "030005b1-0000-0000-0000-000000000000"}')),
  '23503:evidence_arms_study_fkey',
  'C13 a group from A on B''s study is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_study_reports', pg_temp.base_link()
    || '{"paper_id": "030000a1-0000-0000-0000-000000000000"}')),
  '23505:evidence_study_reports_link_key',
  'C14 linking the same report to the same study twice is refused');

-- ═════════════════════════════════════════════════════════════════════════════
-- D. Single-row CHECK contract — one positive control per family, then one
--    override per refusal. Each refusal names the ONE rule it breaks.
-- ═════════════════════════════════════════════════════════════════════════════

-- D1. Studies, links, groups, outcomes.
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_studies', pg_temp.base_study() || '{"label": "   "}')),
  '23514:evidence_studies_label_check', 'D1a a blank study label is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_studies', pg_temp.base_study() || jsonb_build_object('label', repeat('x', 121)))),
  '23514:evidence_studies_label_check', 'D1b a study label over 120 characters is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_studies', pg_temp.base_study() || '{"design_profile": "rct"}')),
  '23514:evidence_studies_design_profile_check', 'D1c an unknown design family is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_studies', pg_temp.base_study() || '{"notes": ""}')),
  '23514:evidence_studies_notes_check', 'D1d empty notes are refused (absent is NULL)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_studies', pg_temp.base_study() || '{"row_version": 0}')),
  '23514:evidence_studies_row_version_check', 'D1e a study version below 1 is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_study_reports', pg_temp.base_link() || '{"link_status": "maybe"}')),
  '23514:evidence_study_reports_link_status_check', 'D1f an unknown link status is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_study_reports', pg_temp.base_link() || '{"link_basis": "title_similarity"}')),
  '23514:evidence_study_reports_link_basis_check', 'D1g an inferred link basis is refused (identity is only ever user-asserted)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_arms', pg_temp.base_arm() || '{"arm_role": "control"}')),
  '23514:evidence_arms_arm_role_check', 'D1h an unknown group role is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_arms', pg_temp.base_arm() || '{"position": 100}')),
  '23514:evidence_arms_position_check', 'D1i a group position outside 0-99 is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_arms', pg_temp.base_arm() || '{"display_label": ""}')),
  '23514:evidence_arms_display_label_check', 'D1j a blank group label is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_outcomes', pg_temp.base_outcome() || jsonb_build_object('display_label', repeat('x', 201)))),
  '23514:evidence_outcomes_display_label_check', 'D1k an outcome label over 200 characters is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_outcomes', pg_temp.base_outcome() || '{"position": -1}')),
  '23514:evidence_outcomes_position_check', 'D1l a negative outcome position is refused');

-- D2. Copies of an abstract.
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_source_snapshots', pg_temp.base_copy())
    , $c$SELECT encode(exact_sha256, 'hex') FROM public.evidence_source_snapshots WHERE id = '03000c99-0000-0000-0000-000000000000'$c$),
  '00000 ' || encode(sha256(convert_to('Updated abstract.', 'UTF8')), 'hex'),
  'D2a positive control: a second copy (seq 2) is accepted, and its hash is SHA-256 of the UTF-8 text');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_source_snapshots', pg_temp.base_copy()
    || jsonb_build_object('exact_sha256', sha256(convert_to('Different text.', 'UTF8'))))),
  '23514:evidence_source_snapshots_exact_sha256_check', 'D2b a fingerprint that is not the hash of the stored text is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_source_snapshots', pg_temp.base_copy() || '{"char_count": 99}')),
  '23514:evidence_source_snapshots_char_count_check', 'D2c a character count that disagrees with the text is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_source_snapshots', pg_temp.base_copy()
    || jsonb_build_object('exact_text', '', 'char_count', 0, 'exact_sha256', sha256(convert_to('', 'UTF8'))))),
  '23514:evidence_source_snapshots_exact_text_check', 'D2d an empty copy is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_source_snapshots', pg_temp.base_copy()
    || jsonb_build_object('exact_text', repeat('a', 50001), 'char_count', 50001, 'exact_sha256', sha256(convert_to(repeat('a', 50001), 'UTF8'))))),
  '23514:evidence_source_snapshots_exact_text_check', 'D2e a copy over 50,000 characters is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_source_snapshots', pg_temp.base_copy()
    || jsonb_build_object('normalized_sha256', substring(sha256('x'::bytea) FROM 1 FOR 16)))),
  '23514:evidence_source_snapshots_normalized_sha256_check', 'D2f a normalized fingerprint that is not 32 bytes is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_source_snapshots', pg_temp.base_copy() || '{"source_kind": "pdf_text"}')),
  '23514:evidence_source_snapshots_source_kind_check', 'D2g only the library abstract is a copy source in the MVP');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_source_snapshots', pg_temp.base_copy() || '{"normalization_version": "v2"}')),
  '23514:evidence_source_snapshots_normalization_version_check', 'D2h an unknown normalization version is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_source_snapshots', pg_temp.base_copy() || '{"seq": 0}')),
  '23514:evidence_source_snapshots_seq_check', 'D2i a copy sequence below 1 is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_source_snapshots', pg_temp.base_copy() || '{"seq": 1}')),
  '23505:evidence_source_snapshots_seq_key', 'D2j two copies with one sequence number on one link are refused');

-- D3. Values: field keys, shapes and missing-value states.
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value())),
  '00000', 'D3a positive control: the base reported value is accepted');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"field_key": "favorite_color", "value_state": "not_reported", "value_text": null}')),
  '23514:evidence_field_values_field_key_check', 'D3b a field key outside the closed list is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"field_key": "description", "value_state": "not_reported", "value_text": null}')),
  '23514:evidence_field_values_field_key_check', 'D3c a group field recorded at study level is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"outcome_id": "03000b01-0000-0000-0000-000000000000", "field_key": "condition", "value_state": "not_reported", "value_text": null}')),
  '23514:evidence_field_values_field_key_check', 'D3d a study field recorded on an outcome is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"arm_id": "03000a02-0000-0000-0000-000000000000", "outcome_id": "03000b01-0000-0000-0000-000000000000", "field_key": "duration", "value_state": "not_reported", "value_text": null}')),
  '23514:evidence_field_values_scope_check', 'D3e a value on a group AND an outcome at once is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value() || '{"value_state": "maybe", "value_text": null}')),
  '23514:evidence_field_values_value_state_check', 'D3f an unknown value state is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value() || '{"value_state": "not_reported"}')),
  '23514:evidence_field_values_value_presence_check', 'D3g "Not reported" carrying a value is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value() || '{"value_text": null, "value_code": "hypertension"}')),
  '23514:evidence_field_values_value_shape_check', 'D3h a text field given a code instead of text is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value() || jsonb_build_object('value_text', repeat('x', 501)))),
  '23514:evidence_field_values_value_shape_check', 'D3i a 501-character condition is refused (bound 500)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value() || '{"value_text": "   "}')),
  '23514:evidence_field_values_value_shape_check', 'D3j a blank reported text is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"field_key": "n_enrolled", "value_text": "n = 1,204", "value_int": 1204}')),
  '00000', 'D3k positive control: a number with its reported text and parsed integer is accepted');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"field_key": "n_enrolled", "value_text": "n = 1,204"}')),
  '23514:evidence_field_values_value_shape_check', 'D3l a number without its parsed integer is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"field_key": "n_enrolled", "value_text": "n = 10,000,001", "value_int": 10000001}')),
  '23514:evidence_field_values_value_shape_check', 'D3m a number above 10,000,000 is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"field_key": "design_classification", "value_text": null, "value_code": "meta_analysis"}')),
  '23514:evidence_field_values_value_shape_check', 'D3n a design classification outside its closed list is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"field_key": "registration_ids", "value_text": null, "value_list": ["NCT01234567", "ISRCTN12345678"]}')),
  '00000', 'D3o positive control: a list of two registration ids is accepted');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"field_key": "registration_ids", "value_text": null, "value_list": ["NCT 01234567"]}')),
  '23514:evidence_field_values_value_shape_check', 'D3p a registration id containing whitespace is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"field_key": "registration_ids", "value_text": null, "value_list": ["NCT1", "NCT2", "NCT3", "NCT4", "NCT5", "NCT6"]}')),
  '23514:evidence_field_values_value_shape_check', 'D3q more than five registration ids are refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"field_key": "registration_ids", "value_text": null, "value_list": []}')),
  '23514:evidence_field_values_value_shape_check', 'D3r an empty list is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"field_key": "registration_ids", "value_text": null, "value_list": ["NCT01234567", null]}')),
  '23514:evidence_field_values_value_shape_check', 'D3s a list containing NULL is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"outcome_id": "03000b02-0000-0000-0000-000000000000", "field_key": "time_points", "value_text": null, "value_list": [" 12 weeks"]}')),
  '23514:evidence_field_values_value_shape_check', 'D3t a time point with leading whitespace is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"value_state": "unclear", "value_text": null, "note": "abstract gives 120 and 118"}')),
  '23514:evidence_field_values_state_reason_check', 'D3u "Unclear" without its reason is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"value_state": "not_reported", "value_text": null, "state_reason": "ambiguous"}')),
  '23514:evidence_field_values_state_reason_check', 'D3v a reason on anything but "Unclear" is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"value_state": "unclear", "value_text": null, "state_reason": "conflicting", "note": "120?"}')),
  '23514:evidence_field_values_state_note_check', 'D3w "Unclear" with a note under 10 characters is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"value_state": "unclear", "value_text": null, "state_reason": "conflicting", "note": "abstract gives 120 and 118"}')),
  '00000', 'D3x positive control: "Unclear" with a reason and a sufficient note is accepted');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"value_state": "not_applicable", "value_text": null}')),
  '23514:evidence_field_values_state_note_check', 'D3y "Not applicable" without a note is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"value_state": "not_reported", "value_text": null, "note": "   "}')),
  '23514:evidence_field_values_note_check', 'D3z a blank note is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value() || '{"extraction_method": "ai"}')),
  '23514:evidence_field_values_extraction_method_check', 'D3aa only manual extraction exists in the MVP');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"study_id": "030005a1-0000-0000-0000-000000000000", "field_key": "population_description"}')),
  '23505:evidence_field_values_entity_field_key', 'D3ab a second study-level row for one field is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"arm_id": "03000a01-0000-0000-0000-000000000000", "field_key": "description"}')),
  '23505:evidence_field_values_entity_field_key', 'D3ac a second row for one field of one group is refused');

-- D4. Review columns.
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"review_status": "user_reviewed", "reviewed_at": "2026-10-12T00:00:00Z", "reviewed_version": 1}')),
  '00000', 'D4a positive control: "Reviewed by you" bound to the current version is accepted');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"review_status": "user_reviewed", "reviewed_version": 1}')),
  '23514:evidence_field_values_reviewed_check', 'D4b "Reviewed by you" without its time is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"review_status": "user_reviewed", "reviewed_at": "2026-10-12T00:00:00Z", "reviewed_version": 1, "value_version": 2}')),
  '23514:evidence_field_values_reviewed_check', 'D4c a review of an earlier version cannot stand as "Reviewed by you"');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"reviewed_at": "2026-10-12T00:00:00Z", "reviewed_version": 1}')),
  '23514:evidence_field_values_reviewed_check', 'D4d review stamps on an unreviewed value are refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value() || '{"review_status": "needs_rereview"}')),
  '23514:evidence_field_values_review_reason_check', 'D4e "Needs re-review" without its reason is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value()
    || '{"review_status": "needs_rereview", "review_reason": "user_changed_mind"}')),
  '23514:evidence_field_values_review_reason_check', 'D4f an unknown re-review reason is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value() || '{"review_status": "disputed"}')),
  '23514:evidence_field_values_review_note_check', 'D4g flagging without a note is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value() || '{"review_status": "verified"}')),
  '23514:evidence_field_values_review_status_check', 'D4h a "verified" review status does not exist');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_values', pg_temp.base_value() || '{"value_version": 0}')),
  '23514:evidence_field_values_value_version_check', 'D4i a value version below 1 is refused');

-- D5. The source-reference matrix (purpose x source kind).
SELECT is(
  pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_quote())) || ' '
  || pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_locator())) || ' '
  || pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_examined())) || ' '
  || pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_examined()
       || '{"source_kind": "full_text", "snapshot_id": null}')) || ' '
  || pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_examined()
       || '{"source_kind": "full_text", "snapshot_id": null, "locator_kind": "section", "locator_text": "Results"}')) || ' '
  || pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_unavailable())) || ' '
  || pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_unavailable()
       || '{"source_kind": "abstract"}')),
  '00000 00000 00000 00000 00000 00000 00000',
  'D5a positive controls: every valid cell of the matrix is accepted (supports abstract/full text; examined abstract/full text with and without a locator; unavailable full text/abstract)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_quote() || '{"snapshot_id": null}')),
  '23514:evidence_field_anchors_snapshot_check', 'D5b a supporting abstract quote without its copy is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_examined() || '{"snapshot_id": null}')),
  '23514:evidence_field_anchors_snapshot_check', 'D5c an examined abstract that names no copy is refused (an absence claim must name the exact text)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_locator()
    || '{"snapshot_id": "03000c01-0000-0000-0000-000000000000"}')),
  '23514:evidence_field_anchors_snapshot_check', 'D5d a full-text reference that names a copy is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_unavailable()
    || '{"source_kind": "abstract", "snapshot_id": "03000c01-0000-0000-0000-000000000000"}')),
  '23514:evidence_field_anchors_snapshot_check', 'D5e an "unavailable" abstract that names a copy is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_quote()
    || '{"quote_text": null, "match_start": null, "match_end": null, "match_occurrence": null, "match_count": null, "normalization_version": null, "matched_at": null}')),
  '23514:evidence_field_anchors_quote_check', 'D5f a supporting abstract reference without its quote and match is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_examined()
    || '{"quote_text": "randomized 120", "match_start": 8, "match_end": 22, "match_occurrence": 1, "match_count": 1, "normalization_version": "v1", "matched_at": "2026-10-12T00:00:00Z"}')),
  '23514:evidence_field_anchors_quote_check', 'D5g an examined reference carrying a quote is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_locator()
    || '{"quote_text": "verbatim publisher text"}')),
  '23514:evidence_field_anchors_quote_check', 'D5h a full-text reference carrying quote text is refused (locator-only, PD-3)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_locator()
    || '{"locator_kind": null, "locator_text": null}')),
  '23514:evidence_field_anchors_locator_check', 'D5i a supporting full-text reference without a locator is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_examined()
    || '{"source_kind": "full_text", "snapshot_id": null, "locator_kind": "section"}')),
  '23514:evidence_field_anchors_locator_check', 'D5j half a locator is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_unavailable()
    || '{"locator_kind": "page", "locator_text": "4"}')),
  '23514:evidence_field_anchors_locator_check', 'D5k an "unavailable" reference carrying a locator is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_quote() || '{"position": null}')),
  '23514:evidence_field_anchors_position_check', 'D5l a supporting reference without a position is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_quote() || '{"position": 3}')),
  '23514:evidence_field_anchors_position_check', 'D5m a fourth supporting reference (position 3) is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_examined() || '{"position": 1}')),
  '23514:evidence_field_anchors_position_check', 'D5n an assessment carrying a position is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_quote() || '{"position": 0}')),
  '23505:evidence_field_anchors_value_position_key', 'D5o two supporting references at one position are refused');
SELECT is(pg_temp.probe('postgres', NULL,
    pg_temp.ins('evidence_field_anchors', pg_temp.base_examined()) || '; '
    || pg_temp.ins('evidence_field_anchors', pg_temp.base_examined() || '{"id": "03000e98-0000-0000-0000-000000000000"}')),
  '23505:evidence_field_anchors_assessment_key', 'D5p two assessments of one source for one value are refused');
SELECT is(pg_temp.probe('postgres', NULL,
    pg_temp.ins('evidence_field_anchors', pg_temp.base_unavailable()) || '; '
    || pg_temp.ins('evidence_field_anchors', pg_temp.base_examined() || '{"id": "03000e98-0000-0000-0000-000000000000", "source_kind": "full_text", "snapshot_id": null}')),
  '23505:evidence_field_anchors_assessment_key', 'D5q "examined" and "unavailable" for the same source are mutually exclusive');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_unavailable() || '{"purpose": "refutes"}')),
  '23514:evidence_field_anchors_purpose_check', 'D5r an unknown reference purpose is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_unavailable() || '{"source_kind": "registry"}')),
  '23514:evidence_field_anchors_source_kind_check', 'D5s a non-library source kind is refused (deferred, PD-4)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_quote() || '{"match_end": 8}')),
  '23514:evidence_field_anchors_match_check', 'D5t a match that ends where it starts is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_quote() || '{"match_occurrence": 2}')),
  '23514:evidence_field_anchors_match_check', 'D5u an occurrence beyond the match count is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_quote() || '{"quote_text": "ab"}')),
  '23514:evidence_field_anchors_quote_text_check', 'D5v a quote under 3 characters is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_quote() || jsonb_build_object('quote_text', repeat('q', 1001)))),
  '23514:evidence_field_anchors_quote_text_check', 'D5w a quote over 1,000 characters is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_quote() || '{"normalization_version": "v2"}')),
  '23514:evidence_field_anchors_normalization_version_check', 'D5x a match under an unknown normalization version is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_locator() || '{"locator_kind": "chapter"}')),
  '23514:evidence_field_anchors_locator_kind_check', 'D5y an unknown locator kind is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_field_anchors', pg_temp.base_locator() || '{"locator_text": "  "}')),
  '23514:evidence_field_anchors_locator_text_check', 'D5z a blank locator is refused');

-- ═════════════════════════════════════════════════════════════════════════════
-- E. History and request idempotency keys
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.probe('postgres', NULL,
    pg_temp.ins('evidence_events', pg_temp.base_header()) || '; ' || pg_temp.ins('evidence_events', pg_temp.base_change())),
  '00000', 'E1 positive control: a header and its change event at the next study version are accepted');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_header()
    || '{"study_id": "030005a2-0000-0000-0000-000000000000", "request_id": "03000101-0000-0000-0000-000000000000"}')),
  '23505:evidence_events_request_header_key',
  'E2 a second committed header for the same user and request id is refused, even on another study');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_change()
    || '{"study_version": 1, "ordinal": 2, "request_id": "03000101-0000-0000-0000-000000000000"}')),
  '00000', 'E3 change events of a request share its request id freely (only headers are unique)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_header()
    || '{"user_id": "03000000-0000-0000-0000-0000000000b0", "study_id": "030005b1-0000-0000-0000-000000000000", "request_id": "03000101-0000-0000-0000-000000000000"}')),
  '00000', 'E4 request ids are scoped per user: B may use an id A already used');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_header() || '{"study_version": 1}')),
  '23505:evidence_events_order_key', 'E5 two rows at one (study, version, ordinal) are refused (gap-free, single-writer history)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_header() || '{"event_type": "value_saved"}')),
  '23514:evidence_events_header_check', 'E6 ordinal 0 is reserved for the request header');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_change() || '{"event_type": "request"}')),
  '23514:evidence_events_header_check', 'E7 a request header at a non-zero ordinal is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_header() || '{"result": null}')),
  '23514:evidence_events_header_shape_check', 'E8 a header without its stored result is refused (a retry could not be answered)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_header()
    || '{"after": {"value_text": "a change"}}')),
  '23514:evidence_events_header_shape_check', 'E9 a header carrying a change is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_change() || '{"op": "save_changes"}')),
  '23514:evidence_events_header_shape_check', 'E10 a change event carrying header fields is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_header() || '{"op": "delete_study"}')),
  '23514:evidence_events_op_check', 'E11 an unknown or unrecorded operation is refused (a delete leaves no header)');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_header()
    || jsonb_build_object('payload_sha256', substring(sha256('x'::bytea) FROM 1 FOR 16)))),
  '23514:evidence_events_payload_sha256_check', 'E12 a payload fingerprint that is not 32 bytes is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_header() || '{"result": ["applied"]}')),
  '23514:evidence_events_result_check', 'E13 a stored result that is not an object is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_header()
    || jsonb_build_object('result', jsonb_build_object('status', 'applied', 'pad', repeat('x', 16400))))),
  '23514:evidence_events_result_check', 'E14 a stored result over 16 KB is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_change()
    || jsonb_build_object('after', jsonb_build_object('pad', repeat('x', 32800))))),
  '23514:evidence_events_payload_size_check', 'E15 a change payload over 32 KB is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_change() || '{"event_type": "study_deleted"}')),
  '23514:evidence_events_event_type_check', 'E16 an event type outside the closed list is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_change() || '{"ordinal": -1}')),
  '23514:evidence_events_ordinal_check', 'E17 a negative ordinal is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_change() || '{"study_version": 0}')),
  '23514:evidence_events_study_version_check', 'E18 a study version below 1 is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_change() || '{"note": " "}')),
  '23514:evidence_events_note_check', 'E19 a blank event note is refused');
SELECT is(pg_temp.probe('postgres', NULL, pg_temp.ins('evidence_events', pg_temp.base_change() || jsonb_build_object('field_key', repeat('k', 65)))),
  '23514:evidence_events_field_key_check', 'E20 an over-long event field key is refused');

-- ═════════════════════════════════════════════════════════════════════════════
-- F. Paper deletion and duplicate merge through the EXISTING client RPCs
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT count(*)::int FROM public.attachment_cleanup_queue WHERE user_id = '03000000-0000-0000-0000-0000000000a0'),
  0, 'F0 before: A has no pending cleanup intent');

SELECT is(pg_temp.probe('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000a0'),
    $q$SELECT * FROM public.delete_papers_with_attachment_cleanup(ARRAY['030000a1-0000-0000-0000-000000000000']::uuid[])$q$),
  '23503:evidence_study_reports_paper_fkey',
  'F1 deleting a paper a study links to is refused by edge (1)');
SELECT is(
  (SELECT count(*)::text FROM public.papers WHERE id = '030000a1-0000-0000-0000-000000000000') || '|'
  || (SELECT count(*)::text FROM public.paper_attachments WHERE id = '03000f01-0000-0000-0000-000000000000') || '|'
  || (SELECT count(*)::text FROM public.attachment_cleanup_queue WHERE user_id = '03000000-0000-0000-0000-0000000000a0') || '|'
  || pg_temp.evidence_rows('03000000-0000-0000-0000-0000000000a0'),
  '1|1|0|studies=5 links=6 copies=6 arms=2 outcomes=2 values=9 refs=9 events=10',
  'F2 the refused delete left nothing partial: paper, attachment row, no cleanup intent, evidence intact');
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000a0'),
    $q$SELECT * FROM public.delete_papers_with_attachment_cleanup(ARRAY['030000a4-0000-0000-0000-000000000000', '030000a1-0000-0000-0000-000000000000']::uuid[])$q$),
  '23503:evidence_study_reports_paper_fkey',
  'F3 a bulk delete containing one linked paper is refused as a whole');
SELECT is(
  (SELECT count(*)::int FROM public.papers WHERE id = '030000a4-0000-0000-0000-000000000000'),
  1, 'F4 the unlinked paper in that refused bulk call is still there');
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000a0'),
    $q$SELECT * FROM public.delete_papers_with_attachment_cleanup(ARRAY['030000a4-0000-0000-0000-000000000000']::uuid[])$q$,
    $c$SELECT count(*)::text FROM public.papers WHERE id = '030000a4-0000-0000-0000-000000000000'$c$),
  '00000 0',
  'F5 an unlinked paper deletes normally through the same RPC');
SELECT is(pg_temp.probe('postgres', NULL,
    $q$DELETE FROM public.papers WHERE id = '030000a2-0000-0000-0000-000000000000'$q$),
  '23503:evidence_study_reports_paper_fkey',
  'F6 owner SQL outside any RPC is refused too (the key, not the RPC, is the protection)');
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000a0'),
    $q$SELECT public.merge_exact_duplicates('030000a5-0000-0000-0000-000000000000'::uuid, ARRAY['030000a7-0000-0000-0000-000000000000']::uuid[])$q$),
  '23503:evidence_study_reports_paper_fkey',
  'F7 merging away a linked discard is refused by edge (1)');
SELECT is(
  (SELECT count(*)::text FROM public.papers WHERE id = '030000a7-0000-0000-0000-000000000000') || '|'
  || (SELECT paper_id::text FROM public.paper_attachments WHERE id = '03000f07-0000-0000-0000-000000000000') || '|'
  || (SELECT count(*)::text FROM public.paper_tags WHERE paper_id = '030000a5-0000-0000-0000-000000000000') || '|'
  || (SELECT count(*)::text FROM public.paper_projects WHERE paper_id = '030000a5-0000-0000-0000-000000000000') || '|'
  || (SELECT abstract FROM public.papers WHERE id = '030000a5-0000-0000-0000-000000000000'),
  '1|030000a7-0000-0000-0000-000000000000|0|0|Keeper abstract.',
  'F8 the refused merge left nothing partial: discard kept, attachment not re-parented, no tag or project union, keeper unchanged');
SELECT is(pg_temp.probe('authenticated', pg_temp.claims('03000000-0000-0000-0000-0000000000a0'),
    $q$SELECT public.merge_exact_duplicates('030000a5-0000-0000-0000-000000000000'::uuid, ARRAY['030000a6-0000-0000-0000-000000000000']::uuid[])$q$,
    $c$SELECT (SELECT count(*) FROM public.papers WHERE id = '030000a6-0000-0000-0000-000000000000') || '|'
           || (SELECT count(*) FROM public.evidence_study_reports WHERE study_id = '030005a4-0000-0000-0000-000000000000' AND paper_id = '030000a5-0000-0000-0000-000000000000') || '|'
           || (SELECT exact_text FROM public.evidence_source_snapshots WHERE id = '03000c05-0000-0000-0000-000000000000') || '|'
           || (SELECT count(*) FROM public.evidence_field_anchors WHERE id = '03000e05-0000-0000-0000-000000000000')$c$),
  '00000 0|1|Keeper abstract.|1',
  'F9 a merge whose keeper alone is linked proceeds, and the keeper''s link, copy and quote survive');

-- ═════════════════════════════════════════════════════════════════════════════
-- G. Unlinking and single-statement study deletion
-- ═════════════════════════════════════════════════════════════════════════════

SELECT is(split_part(pg_temp.probe('postgres', NULL,
    $q$DELETE FROM public.evidence_study_reports WHERE study_id = '030005a3-0000-0000-0000-000000000000' AND paper_id = '030000a3-0000-0000-0000-000000000000'$q$), ':', 1),
  '23503',
  'G1 unlinking a report that a quote depends on is refused (edges 2 and 3)');
SELECT is(pg_temp.probe('postgres', NULL,
    $q$DELETE FROM public.evidence_study_reports WHERE study_id = '030005a3-0000-0000-0000-000000000000' AND paper_id = '030000a2-0000-0000-0000-000000000000'$q$),
  '23503:evidence_field_anchors_link_fkey',
  'G2 unlinking a report that only an assessment and a locator depend on is refused too');
SELECT is(pg_temp.probe('postgres', NULL,
    $q$DELETE FROM public.evidence_field_anchors WHERE paper_id = '030000a2-0000-0000-0000-000000000000' AND study_id = '030005a3-0000-0000-0000-000000000000';
       DELETE FROM public.evidence_study_reports WHERE study_id = '030005a3-0000-0000-0000-000000000000' AND paper_id = '030000a2-0000-0000-0000-000000000000'$q$,
    $c$SELECT (SELECT count(*) FROM public.evidence_source_snapshots WHERE id = '03000c03-0000-0000-0000-000000000000') || '|'
           || (SELECT count(*) FROM public.evidence_study_reports WHERE study_id = '030005a3-0000-0000-0000-000000000000')$c$),
  '00000 0|1',
  'G3 once no reference remains, the unlink succeeds and its copy goes with it; the other report stays linked');
SELECT is(pg_temp.probe('postgres', NULL,
    $q$DELETE FROM public.evidence_studies WHERE id = '030005a1-0000-0000-0000-000000000000'$q$,
    $c$SELECT format('%s/%s/%s/%s/%s/%s/%s %s|%s',
         (SELECT count(*) FROM public.evidence_study_reports    WHERE study_id = '030005a1-0000-0000-0000-000000000000'),
         (SELECT count(*) FROM public.evidence_source_snapshots WHERE study_id = '030005a1-0000-0000-0000-000000000000'),
         (SELECT count(*) FROM public.evidence_arms             WHERE study_id = '030005a1-0000-0000-0000-000000000000'),
         (SELECT count(*) FROM public.evidence_outcomes         WHERE study_id = '030005a1-0000-0000-0000-000000000000'),
         (SELECT count(*) FROM public.evidence_field_values     WHERE study_id = '030005a1-0000-0000-0000-000000000000'),
         (SELECT count(*) FROM public.evidence_field_anchors    WHERE study_id = '030005a1-0000-0000-0000-000000000000'),
         (SELECT count(*) FROM public.evidence_events           WHERE study_id = '030005a1-0000-0000-0000-000000000000'),
         (SELECT count(*) FROM public.evidence_field_anchors    WHERE study_id = '030005a2-0000-0000-0000-000000000000'),
         (SELECT count(*) FROM public.papers                    WHERE id = '030000a1-0000-0000-0000-000000000000'))$c$),
  '00000 0/0/0/0/0/0/0 1|1',
  'G4 one DELETE of a study removes every row of it; the other study of the same paper and the paper itself are untouched');
SELECT is(pg_temp.probe('postgres', NULL,
    $q$DELETE FROM public.evidence_source_snapshots WHERE id = '03000c01-0000-0000-0000-000000000000'$q$),
  '23503:evidence_field_anchors_snapshot_fkey',
  'G5 a copy a quote points at cannot be deleted on its own (edge 3)');

SELECT * FROM finish();
ROLLBACK;
