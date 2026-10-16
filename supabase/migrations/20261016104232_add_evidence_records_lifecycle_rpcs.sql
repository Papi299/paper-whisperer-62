-- EVIDENCE-RECORDS-001A2 — study-record lifecycle RPCs, the server-side owner
-- gate, request idempotency, optimistic concurrency and append-only history.
--
-- WHAT THIS MIGRATION IS
-- ─────────────────────────────────────────────────────────────────────────────
-- The second of three schema steps for the Manual PICO MVP specified in
-- EVIDENCE-INTELLIGENCE-REQUIREMENTS-001, as amended by 001A and corrected by
-- EVIDENCE-INTELLIGENCE-FK-PROOF-001. 20261012031537 (PR-A1) created eight empty
-- tables with no write path; this file adds the first one. It creates six
-- functions, their grants and their comments. No table, column, constraint,
-- index, policy, trigger, view or row is created or altered.
--
--   Client RPCs — SECURITY DEFINER, EXECUTE for `authenticated` only:
--     evidence_create_study_from_paper  a new study from one of the caller's papers
--     evidence_update_study             label, design family and notes
--     evidence_set_link                 confirm, mark provisional or remove a link
--     evidence_delete_study             the study and everything it holds
--   Internal helpers — SECURITY INVOKER, EXECUTE for their owner only:
--     evidence_records_assert_writable  the owner-only pilot gate
--     evidence_normalize_v1             match normalization v1, for source capture
--
-- Not here, by design: save_changes, review_fields, rebase_source, quote
-- location and matching, values, references, groups, outcomes, review states,
-- any UI, and any AI or provider path. They belong to 001A3, 001B and 001C.
--
-- THE PILOT GATE (001A G)
-- ─────────────────────────────────────────────────────────────────────────────
-- Create, update and set_link call evidence_records_assert_writable() as their
-- first statement. It refuses a call with no authenticated subject
-- (42501 evidence_auth_required), and any caller whose server-side role is not
-- exactly `owner` (42501 evidence_records_not_enabled). The role is read on
-- every call from internal_user_access, through get_current_user_access() —
-- the authority the Consensus gate uses — and never from the JWT, an e-mail
-- address, a request parameter or the commercial plan. Nothing caches it:
-- deleting a user's row refuses that user's next call. A manager is not an
-- owner.
--
-- Delete is NOT gated. Any authenticated user may delete a study they own, so a
-- user who holds records can always remove them — and free the papers their
-- links protect from deletion and merge — even after the gate narrows.
--
-- OWNERSHIP
-- ─────────────────────────────────────────────────────────────────────────────
-- Each function takes the caller from auth.uid() and accepts no user id. Every
-- read and write of a study, link, copy or paper names that caller's user_id
-- explicitly: the functions run as their owner, which bypasses RLS, so RLS is
-- not their boundary. The composite foreign keys of PR-A1 remain an
-- independent backstop. Someone else's id and an id that does not exist get
-- the same answer: evidence_not_found, evidence_paper_not_found or
-- evidence_link_not_found from the gated RPCs, {status: already_absent} from
-- delete.
--
-- REQUEST IDEMPOTENCY — FK-PROOF-001 I-1
-- ─────────────────────────────────────────────────────────────────────────────
-- Every call carries a client-generated request id. A gated call runs, in order:
--   1. the gate, the isolation guard (below) and input validation;
--   2. a transaction-scoped advisory lock on (caller, request id);
--   3. the committed request header for (caller, request id), if any: the same
--      operation and payload fingerprint returns its stored result with status
--      `replayed`; anything else raises evidence_request_id_reused;
--   4. update and set_link only: the caller's study row FOR UPDATE
--      (evidence_not_found if there is none), then the version check
--      (evidence_version_conflict);
--   5. a request that changes nothing returns {status: unchanged} and writes
--      nothing — no header, no event, no new version — so its request id is
--      not consumed;
--   6. otherwise the change, one header (ordinal 0) and its change events
--      (ordinals 1..n), all at the new study version, and row_version + 1.
-- Identical concurrent requests serialize on the advisory lock, and the second
-- replays the first. The partial unique index evidence_events_request_header_key
-- is the backstop: a second committed header for one request cannot exist.
--
-- The payload fingerprint is SHA-256 over the UTF-8 text of a jsonb object
-- holding the operation name and every argument except the request id. jsonb
-- sorts and de-duplicates keys itself, so the text never depends on the order
-- in which arguments are listed. No argument of any RPC here is abstract text.
--
-- The guarantee is bounded, and stated plainly: a request id is remembered only
-- while its study exists. Deleting a study deletes its history, headers
-- included, so a create retried after its study was deleted creates a new
-- study. A request that changed nothing leaves no receipt, so a retry of it is
-- evaluated afresh: `unchanged` again, or evidence_version_conflict once
-- another write has moved the study — never a change of its own. This is not
-- exactly-once execution forever.
--
-- Step 3 depends on each statement seeing what committed while it waited for
-- the lock, which is READ COMMITTED — the level PostgREST uses. All four
-- functions refuse any other isolation level (evidence_requires_read_committed)
-- rather than run the race under one that does not provide it, as
-- finalize_attachment_upload does.
--
-- HISTORY
-- ─────────────────────────────────────────────────────────────────────────────
-- Creation writes study version 1, and every later change exactly one new
-- version. No function here updates an event; only evidence_delete_study
-- deletes events, and only together with their study. No event holds abstract
-- text. Study notes (up to 10,000 characters) are recorded in history as
-- {sha256, chars}, never as text: a notes change could otherwise exceed the
-- 32 KB bound PR-A1 places on an event's before + after.
--
-- SOURCE CAPTURE AT CREATION — AND THE ONE PHASE-ORDER CHANGE
-- ─────────────────────────────────────────────────────────────────────────────
-- Create reads the paper's stored abstract server-side, under the owner
-- predicate, and saves a byte-exact copy for the new link: exact_sha256 over
-- its UTF-8 bytes, normalized_sha256 after match normalization v1,
-- normalization_version 'v1' and char_count. The browser never supplies the
-- text, and no fingerprint is ever a placeholder. A NULL abstract, or one that
-- is empty after v1 (only white space or invisible format characters), gets
-- no copy; one longer than 50,000 characters refuses the create
-- (evidence_abstract_too_long). A copy is the abstract as stored in the user's
-- PaperLume library; nothing here checks it against a publisher or PubMed.
--
-- PR-A1's schema requires the v1 fingerprint, but the staged plan put
-- evidence_normalize_v1 in 001A3. So that a copy can be captured faithfully
-- now, ONLY that function moves into this phase. It is REQUIREMENTS-001 §I3,
-- exactly, applied in its stated order:
--   1. Unicode NFC — never NFKC or NFKD, which turn 10^5 (superscript) into 105;
--   2. remove U+00AD, U+200B, U+2060 and U+FEFF;
--   3. map every Unicode White_Space character to U+0020, collapse runs, trim;
--   4. map U+2018 U+2019 U+201A U+201B to ' and U+201C U+201D U+201E U+201F to ";
--   5. map U+2010-U+2015 and U+2212 to -;
--   6. map U+2026 to "..." and U+00B5 to U+03BC;
--   nothing else: no case folding, stemming, punctuation removal or fuzziness.
-- It is pure, owner-only, and called only by create (and by the validation of
-- labels and notes, where "blank" means empty after v1). Quote location and
-- matching, and every reference write, stay in 001A3; the shared TypeScript
-- fixture and its parity check stay in 001B. Suite 031 pins golden vectors
-- whose expected output and SHA-256 were computed outside PostgreSQL.
--
-- LINKS
-- ─────────────────────────────────────────────────────────────────────────────
-- set_link changes one existing link of the caller's study: `confirm`
-- (user_confirmed), `mark_provisional` (provisional) or `remove`. It never
-- creates a link, never re-parents one, and never infers that two papers report
-- one study; linking further reports is the deferred linking phase. A remove is
-- refused while any source reference uses the link (evidence_link_in_use; the
-- NO ACTION key is the backstop), and when it is the study's last link
-- (evidence_last_link): a study with no report is reachable through no paper —
-- the orphan state 001A rejected detach-on-delete (F-E) for. Deleting the study
-- is the way to free its only paper. A removed link's copies go with it,
-- explicitly, and the link_removed event lists them.
--
-- DELETION (001A H2)
-- ─────────────────────────────────────────────────────────────────────────────
-- Delete locks the caller's study, checks the expected version, then deletes in
-- one explicit order — references, values, groups, outcomes, copies, links,
-- history, the study — so no NO ACTION edge depends on the order cascades
-- fire in. Nothing of the study remains, and the papers it linked can be
-- deleted or merged again.
--
-- DESIGN FAMILY (001 F2, H3, H4)
-- ─────────────────────────────────────────────────────────────────────────────
-- Groups and the number randomized exist only in the intervention families, so
-- moving a study to non_intervention is refused while it holds any group or any
-- n_randomized value (evidence_profile_change_blocked): no data is ever hidden
-- by a family change. Every other move is allowed.
--
-- LIMITS (001 L10)
-- ─────────────────────────────────────────────────────────────────────────────
-- 2,000 studies per user (evidence_study_limit) — one user's creates serialize
-- on a second advisory lock, so the bound is exact — and 5,000 history events
-- per study (evidence_history_limit), exact under the study row lock.
--
-- ERRORS (001 L9). Fixed messages, which never echo input, ids or SQL:
--   42501  evidence_auth_required, evidence_records_not_enabled
--   22023  evidence_invalid_input (DETAIL names the parameter)
--   P0002  evidence_not_found, evidence_paper_not_found, evidence_link_not_found
--   P0001  evidence_request_id_reused, evidence_version_conflict,
--          evidence_profile_change_blocked, evidence_last_link,
--          evidence_link_in_use, evidence_abstract_too_long,
--          evidence_study_limit, evidence_history_limit,
--          evidence_requires_read_committed
--   XX000  evidence_internal_invariant (unreachable by design)
--
-- LOCKS
-- ─────────────────────────────────────────────────────────────────────────────
-- Applying this file takes no lock on any user table: it only creates
-- functions. The RPCs take the request advisory lock first, then (create only)
-- the per-user create lock, then row locks — the caller's study FOR UPDATE and
-- its link, or the paper FOR KEY SHARE. They never LOCK TABLE. The db-tests
-- lifecycle races them against each other and against paper deletion.
--
-- The file is one explicit transaction, so its verification refuses a weaker
-- result under every runner (`supabase db reset` would otherwise run it
-- statement by statement).
--
-- ROLLBACK — forward only. A reversal is a new migration that drops the six
-- functions. Rows the RPCs wrote stay; removing them is a separate decision.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context
-- ═════════════════════════════════════════════════════════════════════════════

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'evidence_lifecycle: must run as postgres (current_user is %)', current_user;
  END IF;

  IF current_setting('search_path') IS DISTINCT FROM 'pg_catalog, pg_temp'
     OR current_setting('lock_timeout') IS DISTINCT FROM '5s' THEN
    RAISE EXCEPTION 'evidence_lifecycle: the transaction-local settings are not in effect (search_path %, lock_timeout %) — this file must run as one transaction',
      current_setting('search_path'), current_setting('lock_timeout');
  END IF;
END
$ctx$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Preconditions — refuse anything but the reviewed starting state
-- ═════════════════════════════════════════════════════════════════════════════

DO $pre$
DECLARE
  v_table text;
  v_text  text;
  v_row   record;
BEGIN
  -- normalize() exists only for a UTF8 server encoding, and the copy hashes
  -- PR-A1 binds by CHECK assume it.
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'evidence_lifecycle: server_encoding is %, UTF8 is required', current_setting('server_encoding');
  END IF;

  -- The RPCs write through FORCE ROW LEVEL SECURITY with no write policy, which
  -- only an owner holding BYPASSRLS can do.
  IF NOT (SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'evidence_lifecycle: % does not hold BYPASSRLS, so the RPCs it owns could not write the evidence tables', current_user;
  END IF;

  -- Nothing of this migration exists yet, not even partially.
  SELECT coalesce(string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text), '') INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%';
  IF v_text <> '' THEN
    RAISE EXCEPTION 'evidence_lifecycle: public already holds evidence functions: %', v_text;
  END IF;

  -- PR-A1's eight tables, and the durable request key the algorithm relies on.
  FOREACH v_table IN ARRAY ARRAY['evidence_studies', 'evidence_study_reports', 'evidence_source_snapshots',
                                 'evidence_arms', 'evidence_outcomes', 'evidence_field_values',
                                 'evidence_field_anchors', 'evidence_events'] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'evidence_lifecycle: public.% does not exist; 20261012031537 must be applied first', v_table;
    END IF;
  END LOOP;

  SELECT i.indisunique,
         (SELECT array_agg(a.attname::text ORDER BY o.ord)
            FROM unnest(i.indkey) WITH ORDINALITY AS o(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = o.attnum) AS cols,
         pg_get_expr(i.indpred, i.indrelid) AS pred
    INTO v_row
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('public.evidence_events_request_header_key');
  IF NOT FOUND OR NOT v_row.indisunique OR v_row.cols IS DISTINCT FROM ARRAY['user_id', 'request_id']
     OR v_row.pred IS DISTINCT FROM '(ordinal = 0)' THEN
    RAISE EXCEPTION 'evidence_lifecycle: evidence_events_request_header_key is not UNIQUE (user_id, request_id) WHERE ordinal = 0';
  END IF;

  -- Every closed-list value these functions write must be one the PR-A1 CHECKs
  -- accept. A value missing here would surface as a runtime 23514; refuse now.
  SELECT coalesce(string_agg(x.con || ' lacks ' || x.val, '; '), '') INTO v_text
    FROM (VALUES
      ('evidence_events_op_check', 'create_study'),
      ('evidence_events_op_check', 'update_study'),
      ('evidence_events_op_check', 'set_link'),
      ('evidence_events_event_type_check', 'request'),
      ('evidence_events_event_type_check', 'study_created'),
      ('evidence_events_event_type_check', 'study_updated'),
      ('evidence_events_event_type_check', 'link_created'),
      ('evidence_events_event_type_check', 'link_status_changed'),
      ('evidence_events_event_type_check', 'link_removed'),
      ('evidence_events_event_type_check', 'source_captured'),
      ('evidence_study_reports_link_status_check', 'provisional'),
      ('evidence_study_reports_link_status_check', 'user_confirmed'),
      ('evidence_study_reports_link_basis_check', 'created_from_paper'),
      ('evidence_studies_design_profile_check', 'rct_parallel'),
      ('evidence_studies_design_profile_check', 'intervention_other'),
      ('evidence_studies_design_profile_check', 'non_intervention'),
      ('evidence_source_snapshots_source_kind_check', 'library_abstract'),
      ('evidence_source_snapshots_normalization_version_check', 'v1')
    ) AS x(con, val)
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_constraint k
            WHERE k.conname = x.con AND k.contype = 'c'
              AND k.connamespace = 'public'::regnamespace
              AND position(quote_literal(x.val) IN pg_get_constraintdef(k.oid)) > 0);
  IF v_text <> '' THEN
    RAISE EXCEPTION 'evidence_lifecycle: a PR-A1 CHECK does not accept a value this migration writes: %', v_text;
  END IF;

  -- The gate's authority: the role projection of get_current_user_access().
  IF to_regprocedure('public.get_current_user_access()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public.get_current_user_access()')
                       AND p.prosecdef AND p.proowner = 'postgres'::regrole
                       AND 'role' = ANY (p.proargnames)) THEN
    RAISE EXCEPTION 'evidence_lifecycle: public.get_current_user_access() is not the reviewed SECURITY DEFINER role projection';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'evidence_lifecycle: auth.uid() does not exist';
  END IF;

  -- The abstract create copies.
  IF (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
       WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'abstract' AND NOT a.attisdropped)
     IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'evidence_lifecycle: public.papers.abstract is not a text column';
  END IF;
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. evidence_normalize_v1 — match normalization v1 (REQUIREMENTS-001 §I3)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Pure, and applied in exactly the specification's order, one step per
-- statement. The order matters: U+200B goes before runs of spaces collapse, so
-- "a", space, U+200B, space, "b" becomes "a b"; U+00AD goes after NFC, so "e",
-- U+00AD, U+0301 stays "e" + U+0301, because the soft hyphen blocked the
-- composition. Every non-ASCII character is written as chr(<code point>), so
-- the source is plain ASCII and the body depends on no session setting.
-- EXECUTE is the owner's alone: this is not a browser API.

CREATE FUNCTION public.evidence_normalize_v1(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  t text := p_text;
BEGIN
  -- 1. Unicode NFC. Never NFKC or NFKD, which fold U+2075 SUPERSCRIPT FIVE
  --    into "5", so that "10^5" would read as "105".
  t := normalize(t, NFC);

  -- 2. Remove SOFT HYPHEN, ZERO WIDTH SPACE, WORD JOINER and U+FEFF.
  t := translate(t, chr(0x00AD) || chr(0x200B) || chr(0x2060) || chr(0xFEFF), '');

  -- 3. Map each of the 25 Unicode White_Space code points to U+0020, collapse
  --    runs of spaces into one, and trim both ends.
  t := translate(t,
         chr(0x0009) || chr(0x000A) || chr(0x000B) || chr(0x000C) || chr(0x000D)
         || chr(0x0020) || chr(0x0085) || chr(0x00A0) || chr(0x1680)
         || chr(0x2000) || chr(0x2001) || chr(0x2002) || chr(0x2003) || chr(0x2004) || chr(0x2005)
         || chr(0x2006) || chr(0x2007) || chr(0x2008) || chr(0x2009) || chr(0x200A)
         || chr(0x2028) || chr(0x2029) || chr(0x202F) || chr(0x205F) || chr(0x3000),
         repeat(' ', 25));
  t := btrim(regexp_replace(t, ' {2,}', ' ', 'g'), ' ');

  -- 4. Map U+2018, U+2019, U+201A, U+201B to U+0027 APOSTROPHE, and U+201C,
  --    U+201D, U+201E, U+201F to U+0022 QUOTATION MARK.
  t := translate(t,
         chr(0x2018) || chr(0x2019) || chr(0x201A) || chr(0x201B)
         || chr(0x201C) || chr(0x201D) || chr(0x201E) || chr(0x201F),
         repeat(chr(0x0027), 4) || repeat(chr(0x0022), 4));

  -- 5. Map U+2010 through U+2015 and U+2212 MINUS SIGN to U+002D HYPHEN-MINUS.
  t := translate(t,
         chr(0x2010) || chr(0x2011) || chr(0x2012) || chr(0x2013) || chr(0x2014) || chr(0x2015)
         || chr(0x2212),
         repeat('-', 7));

  -- 6. Map U+2026 HORIZONTAL ELLIPSIS to three full stops, and U+00B5 MICRO
  --    SIGN to U+03BC GREEK SMALL LETTER MU.
  t := replace(t, chr(0x2026), '...');
  t := translate(t, chr(0x00B5), chr(0x03BC));

  -- Nothing else: no case folding, stemming, punctuation removal or fuzziness.
  RETURN t;
END
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. evidence_records_assert_writable — the owner-only pilot gate (001A G2)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- INVOKER is enough: it adds no authority of its own. Inside a gated RPC it runs
-- as that RPC's owner, which may execute get_current_user_access(). VOLATILE, so
-- no plan or caller can reuse an earlier answer.

CREATE FUNCTION public.evidence_records_assert_writable()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'evidence_auth_required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT a.role INTO v_role FROM public.get_current_user_access() AS a;
  IF v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'evidence_records_not_enabled' USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. evidence_create_study_from_paper
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A new study, its explicit link to the caller's paper (created_from_paper),
-- and — when the paper has an abstract — a copy of it, all at study version 1.
-- A paper may be the source of any number of studies; a study is never the paper.

CREATE FUNCTION public.evidence_create_study_from_paper(
    p_paper_id       uuid,
    p_label          text,
    p_design_profile text,
    p_link_status    text,
    p_request_id     uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid        uuid := auth.uid();
  v_payload    bytea;
  v_header     record;
  v_abstract   text;
  v_normalized text;
  v_study_id   uuid;
  v_link_id    uuid;
  v_copy_id    uuid;
  v_exact_sha  bytea;
  v_norm_sha   bytea;
  v_result     jsonb;
BEGIN
  PERFORM public.evidence_records_assert_writable();

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'evidence_requires_read_committed' USING ERRCODE = 'raise_exception';
  END IF;

  IF p_paper_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_paper_id';
  END IF;
  IF p_label IS NULL OR char_length(p_label) > 120 OR public.evidence_normalize_v1(p_label) = '' THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_label';
  END IF;
  IF p_design_profile IS NULL OR p_design_profile NOT IN ('rct_parallel', 'intervention_other', 'non_intervention') THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_design_profile';
  END IF;
  IF p_link_status IS NULL OR p_link_status NOT IN ('provisional', 'user_confirmed') THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_link_status';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_request_id';
  END IF;

  v_payload := sha256(convert_to(jsonb_build_object(
                 'op', 'create_study',
                 'paper_id', p_paper_id,
                 'label', p_label,
                 'design_profile', p_design_profile,
                 'link_status', p_link_status)::text, 'UTF8'));

  -- No study row exists yet, so this lock and the header key are what make two
  -- identical creates one study.
  PERFORM pg_advisory_xact_lock(20261016, hashtext(v_uid::text || ':' || p_request_id::text));

  SELECT e.op, e.payload_sha256, e.result INTO v_header
    FROM public.evidence_events e
   WHERE e.user_id = v_uid AND e.request_id = p_request_id AND e.ordinal = 0;
  IF FOUND THEN
    IF v_header.op = 'create_study' AND v_header.payload_sha256 = v_payload THEN
      RETURN v_header.result || jsonb_build_object('status', 'replayed');
    END IF;
    RAISE EXCEPTION 'evidence_request_id_reused' USING ERRCODE = 'raise_exception';
  END IF;

  -- One user's creates run one at a time, so the study limit below is exact.
  PERFORM pg_advisory_xact_lock(20261017, hashtext(v_uid::text));

  -- KEY SHARE holds the paper until commit: a concurrent paper deletion or
  -- merge waits, then meets the new link's NO ACTION key.
  SELECT p.abstract INTO v_abstract
    FROM public.papers p
   WHERE p.id = p_paper_id AND p.user_id = v_uid
     FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence_paper_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  IF (SELECT count(*) FROM public.evidence_studies s WHERE s.user_id = v_uid) >= 2000 THEN
    RAISE EXCEPTION 'evidence_study_limit' USING ERRCODE = 'raise_exception';
  END IF;

  IF v_abstract IS NOT NULL THEN
    IF char_length(v_abstract) > 50000 THEN
      RAISE EXCEPTION 'evidence_abstract_too_long' USING ERRCODE = 'raise_exception';
    END IF;
    v_normalized := public.evidence_normalize_v1(v_abstract);
    IF v_normalized = '' THEN
      v_abstract := NULL;
    END IF;
  END IF;

  INSERT INTO public.evidence_studies (user_id, label, design_profile, notes, row_version)
  VALUES (v_uid, p_label, p_design_profile, NULL, 1)
  RETURNING id INTO v_study_id;

  INSERT INTO public.evidence_study_reports (user_id, study_id, paper_id, link_status, link_basis)
  VALUES (v_uid, v_study_id, p_paper_id, p_link_status, 'created_from_paper')
  RETURNING id INTO v_link_id;

  IF v_abstract IS NOT NULL THEN
    v_exact_sha := sha256(convert_to(v_abstract, 'UTF8'));
    v_norm_sha  := sha256(convert_to(v_normalized, 'UTF8'));
    INSERT INTO public.evidence_source_snapshots
      (user_id, study_id, paper_id, seq, source_kind, exact_text, exact_sha256,
       normalized_sha256, normalization_version, char_count)
    VALUES (v_uid, v_study_id, p_paper_id, 1, 'library_abstract', v_abstract, v_exact_sha,
            v_norm_sha, 'v1', char_length(v_abstract))
    RETURNING id INTO v_copy_id;
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'study_id', v_study_id,
    'study_version', 1,
    'link_id', v_link_id,
    'snapshot_id', v_copy_id);

  INSERT INTO public.evidence_events
    (user_id, study_id, study_version, ordinal, event_type, request_id,
     op, payload_sha256, result, target_id, after)
  VALUES
    (v_uid, v_study_id, 1, 0, 'request', p_request_id,
     'create_study', v_payload, v_result, NULL, NULL),
    (v_uid, v_study_id, 1, 1, 'study_created', p_request_id,
     NULL, NULL, NULL, v_study_id,
     jsonb_build_object('label', p_label, 'design_profile', p_design_profile, 'notes', NULL::jsonb)),
    (v_uid, v_study_id, 1, 2, 'link_created', p_request_id,
     NULL, NULL, NULL, v_link_id,
     jsonb_build_object('paper_id', p_paper_id, 'link_status', p_link_status,
                        'link_basis', 'created_from_paper'));

  -- Fingerprints only: the copy's text never enters history.
  IF v_copy_id IS NOT NULL THEN
    INSERT INTO public.evidence_events
      (user_id, study_id, study_version, ordinal, event_type, request_id, target_id, after)
    VALUES
      (v_uid, v_study_id, 1, 3, 'source_captured', p_request_id, v_copy_id,
       jsonb_build_object('paper_id', p_paper_id, 'seq', 1, 'source_kind', 'library_abstract',
                          'exact_sha256', encode(v_exact_sha, 'hex'),
                          'normalized_sha256', encode(v_norm_sha, 'hex'),
                          'normalization_version', 'v1',
                          'char_count', char_length(v_abstract),
                          'previous_snapshot_id', NULL::uuid));
  END IF;

  RETURN v_result;
END
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. evidence_update_study
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Replaces the label, design family and notes (NULL = no notes) of one study at
-- one expected version. History records which of the three changed; notes as
-- their fingerprint, never as text.

CREATE FUNCTION public.evidence_update_study(
    p_study_id         uuid,
    p_expected_version integer,
    p_label            text,
    p_design_profile   text,
    p_notes            text,
    p_request_id       uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_payload bytea;
  v_header  record;
  v_study   record;
  v_version integer;
  v_count   integer;
  v_before  jsonb := '{}'::jsonb;
  v_after   jsonb := '{}'::jsonb;
  v_result  jsonb;
BEGIN
  PERFORM public.evidence_records_assert_writable();

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'evidence_requires_read_committed' USING ERRCODE = 'raise_exception';
  END IF;

  IF p_study_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_study_id';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_expected_version';
  END IF;
  IF p_label IS NULL OR char_length(p_label) > 120 OR public.evidence_normalize_v1(p_label) = '' THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_label';
  END IF;
  IF p_design_profile IS NULL OR p_design_profile NOT IN ('rct_parallel', 'intervention_other', 'non_intervention') THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_design_profile';
  END IF;
  IF p_notes IS NOT NULL AND (char_length(p_notes) > 10000 OR public.evidence_normalize_v1(p_notes) = '') THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_notes';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_request_id';
  END IF;

  v_payload := sha256(convert_to(jsonb_build_object(
                 'op', 'update_study',
                 'study_id', p_study_id,
                 'expected_version', p_expected_version,
                 'label', p_label,
                 'design_profile', p_design_profile,
                 'notes', p_notes)::text, 'UTF8'));

  PERFORM pg_advisory_xact_lock(20261016, hashtext(v_uid::text || ':' || p_request_id::text));

  SELECT e.op, e.payload_sha256, e.result INTO v_header
    FROM public.evidence_events e
   WHERE e.user_id = v_uid AND e.request_id = p_request_id AND e.ordinal = 0;
  IF FOUND THEN
    IF v_header.op = 'update_study' AND v_header.payload_sha256 = v_payload THEN
      RETURN v_header.result || jsonb_build_object('status', 'replayed');
    END IF;
    RAISE EXCEPTION 'evidence_request_id_reused' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT s.label, s.design_profile, s.notes, s.row_version INTO v_study
    FROM public.evidence_studies s
   WHERE s.id = p_study_id AND s.user_id = v_uid
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_study.row_version <> p_expected_version THEN
    RAISE EXCEPTION 'evidence_version_conflict' USING ERRCODE = 'raise_exception';
  END IF;

  IF v_study.label = p_label AND v_study.design_profile = p_design_profile
     AND v_study.notes IS NOT DISTINCT FROM p_notes THEN
    RETURN jsonb_build_object('status', 'unchanged', 'study_id', p_study_id,
                              'study_version', v_study.row_version);
  END IF;

  IF p_design_profile = 'non_intervention' AND v_study.design_profile <> 'non_intervention'
     AND (EXISTS (SELECT 1 FROM public.evidence_arms a
                   WHERE a.user_id = v_uid AND a.study_id = p_study_id)
          OR EXISTS (SELECT 1 FROM public.evidence_field_values fv
                      WHERE fv.user_id = v_uid AND fv.study_id = p_study_id
                        AND fv.field_key = 'n_randomized')) THEN
    RAISE EXCEPTION 'evidence_profile_change_blocked' USING ERRCODE = 'raise_exception';
  END IF;

  IF (SELECT count(*) FROM public.evidence_events e
       WHERE e.user_id = v_uid AND e.study_id = p_study_id) > 5000 - 2 THEN
    RAISE EXCEPTION 'evidence_history_limit' USING ERRCODE = 'raise_exception';
  END IF;

  IF v_study.label <> p_label THEN
    v_before := v_before || jsonb_build_object('label', v_study.label);
    v_after  := v_after  || jsonb_build_object('label', p_label);
  END IF;
  IF v_study.design_profile <> p_design_profile THEN
    v_before := v_before || jsonb_build_object('design_profile', v_study.design_profile);
    v_after  := v_after  || jsonb_build_object('design_profile', p_design_profile);
  END IF;
  IF v_study.notes IS DISTINCT FROM p_notes THEN
    v_before := v_before || jsonb_build_object('notes',
      CASE WHEN v_study.notes IS NULL THEN NULL::jsonb
           ELSE jsonb_build_object('sha256', encode(sha256(convert_to(v_study.notes, 'UTF8')), 'hex'),
                                   'chars', char_length(v_study.notes)) END);
    v_after := v_after || jsonb_build_object('notes',
      CASE WHEN p_notes IS NULL THEN NULL::jsonb
           ELSE jsonb_build_object('sha256', encode(sha256(convert_to(p_notes, 'UTF8')), 'hex'),
                                   'chars', char_length(p_notes)) END);
  END IF;

  v_version := v_study.row_version + 1;

  UPDATE public.evidence_studies s
     SET label = p_label, design_profile = p_design_profile, notes = p_notes,
         row_version = v_version, updated_at = now()
   WHERE s.id = p_study_id AND s.user_id = v_uid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'evidence_internal_invariant' USING ERRCODE = 'internal_error';
  END IF;

  v_result := jsonb_build_object('status', 'applied', 'study_id', p_study_id,
                                 'study_version', v_version);

  INSERT INTO public.evidence_events
    (user_id, study_id, study_version, ordinal, event_type, request_id,
     op, payload_sha256, result, target_id, before, after)
  VALUES
    (v_uid, p_study_id, v_version, 0, 'request', p_request_id,
     'update_study', v_payload, v_result, NULL, NULL, NULL),
    (v_uid, p_study_id, v_version, 1, 'study_updated', p_request_id,
     NULL, NULL, NULL, p_study_id, v_before, v_after);

  RETURN v_result;
END
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. evidence_set_link
-- ═════════════════════════════════════════════════════════════════════════════
--
-- One existing link of the caller's study, named by (study, paper):
--   confirm           -> link_status user_confirmed
--   mark_provisional  -> link_status provisional
--   remove            -> the link and its copies, unless a source reference
--                        uses it or it is the study's last link

CREATE FUNCTION public.evidence_set_link(
    p_study_id         uuid,
    p_paper_id         uuid,
    p_action           text,
    p_expected_version integer,
    p_request_id       uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid         uuid := auth.uid();
  v_payload     bytea;
  v_header      record;
  v_current     integer;
  v_link        record;
  v_status      text;
  v_event       text;
  v_before      jsonb;
  v_after       jsonb;
  v_copies      jsonb;
  v_version     integer;
  v_count       integer;
  v_result      jsonb;
BEGIN
  PERFORM public.evidence_records_assert_writable();

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'evidence_requires_read_committed' USING ERRCODE = 'raise_exception';
  END IF;

  IF p_study_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_study_id';
  END IF;
  IF p_paper_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_paper_id';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('confirm', 'mark_provisional', 'remove') THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_action';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_expected_version';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_request_id';
  END IF;

  v_payload := sha256(convert_to(jsonb_build_object(
                 'op', 'set_link',
                 'study_id', p_study_id,
                 'paper_id', p_paper_id,
                 'action', p_action,
                 'expected_version', p_expected_version)::text, 'UTF8'));

  PERFORM pg_advisory_xact_lock(20261016, hashtext(v_uid::text || ':' || p_request_id::text));

  SELECT e.op, e.payload_sha256, e.result INTO v_header
    FROM public.evidence_events e
   WHERE e.user_id = v_uid AND e.request_id = p_request_id AND e.ordinal = 0;
  IF FOUND THEN
    IF v_header.op = 'set_link' AND v_header.payload_sha256 = v_payload THEN
      RETURN v_header.result || jsonb_build_object('status', 'replayed');
    END IF;
    RAISE EXCEPTION 'evidence_request_id_reused' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT s.row_version INTO v_current
    FROM public.evidence_studies s
   WHERE s.id = p_study_id AND s.user_id = v_uid
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_current <> p_expected_version THEN
    RAISE EXCEPTION 'evidence_version_conflict' USING ERRCODE = 'raise_exception';
  END IF;

  -- The link is looked up only inside the caller's own study, so a paper that
  -- is someone else's, unknown, or simply not linked all read the same.
  SELECT r.id, r.link_status, r.link_basis INTO v_link
    FROM public.evidence_study_reports r
   WHERE r.user_id = v_uid AND r.study_id = p_study_id AND r.paper_id = p_paper_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence_link_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_action = 'remove' THEN
    IF NOT EXISTS (SELECT 1 FROM public.evidence_study_reports r
                    WHERE r.user_id = v_uid AND r.study_id = p_study_id AND r.paper_id <> p_paper_id) THEN
      RAISE EXCEPTION 'evidence_last_link' USING ERRCODE = 'raise_exception';
    END IF;
    IF EXISTS (SELECT 1 FROM public.evidence_field_anchors a
                WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.paper_id = p_paper_id) THEN
      RAISE EXCEPTION 'evidence_link_in_use' USING ERRCODE = 'raise_exception';
    END IF;
    IF (SELECT count(*) FROM public.evidence_events e
         WHERE e.user_id = v_uid AND e.study_id = p_study_id) > 5000 - 2 THEN
      RAISE EXCEPTION 'evidence_history_limit' USING ERRCODE = 'raise_exception';
    END IF;

    SELECT coalesce(jsonb_agg(c.id ORDER BY c.seq), '[]'::jsonb) INTO v_copies
      FROM public.evidence_source_snapshots c
     WHERE c.user_id = v_uid AND c.study_id = p_study_id AND c.paper_id = p_paper_id;

    DELETE FROM public.evidence_source_snapshots c
     WHERE c.user_id = v_uid AND c.study_id = p_study_id AND c.paper_id = p_paper_id;
    DELETE FROM public.evidence_study_reports r
     WHERE r.id = v_link.id AND r.user_id = v_uid;

    v_status := NULL;
    v_event  := 'link_removed';
    v_before := jsonb_build_object('paper_id', p_paper_id, 'link_status', v_link.link_status,
                                   'link_basis', v_link.link_basis, 'snapshot_ids', v_copies);
    v_after  := NULL;
  ELSE
    v_status := CASE p_action WHEN 'confirm' THEN 'user_confirmed' ELSE 'provisional' END;
    IF v_link.link_status = v_status THEN
      RETURN jsonb_build_object('status', 'unchanged', 'study_id', p_study_id,
                                'study_version', v_current, 'paper_id', p_paper_id,
                                'link_id', v_link.id, 'link_status', v_status);
    END IF;
    IF (SELECT count(*) FROM public.evidence_events e
         WHERE e.user_id = v_uid AND e.study_id = p_study_id) > 5000 - 2 THEN
      RAISE EXCEPTION 'evidence_history_limit' USING ERRCODE = 'raise_exception';
    END IF;

    UPDATE public.evidence_study_reports r
       SET link_status = v_status, updated_at = now()
     WHERE r.id = v_link.id AND r.user_id = v_uid;

    v_event  := 'link_status_changed';
    v_before := jsonb_build_object('paper_id', p_paper_id, 'link_status', v_link.link_status);
    v_after  := jsonb_build_object('paper_id', p_paper_id, 'link_status', v_status);
  END IF;

  v_version := v_current + 1;

  UPDATE public.evidence_studies s
     SET row_version = v_version, updated_at = now()
   WHERE s.id = p_study_id AND s.user_id = v_uid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'evidence_internal_invariant' USING ERRCODE = 'internal_error';
  END IF;

  v_result := jsonb_build_object('status', 'applied', 'study_id', p_study_id,
                                 'study_version', v_version, 'paper_id', p_paper_id,
                                 'link_id', v_link.id, 'link_status', v_status);

  INSERT INTO public.evidence_events
    (user_id, study_id, study_version, ordinal, event_type, request_id,
     op, payload_sha256, result, target_id, before, after)
  VALUES
    (v_uid, p_study_id, v_version, 0, 'request', p_request_id,
     'set_link', v_payload, v_result, NULL, NULL, NULL),
    (v_uid, p_study_id, v_version, 1, v_event, p_request_id,
     NULL, NULL, NULL, v_link.id, v_before, v_after);

  RETURN v_result;
END
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 7. evidence_delete_study
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Ungated: authentication and ownership only. p_request_id keeps one client
-- contract across the four RPCs; nothing durable records it, because the
-- study's history leaves with the study.

CREATE FUNCTION public.evidence_delete_study(
    p_study_id         uuid,
    p_expected_version integer,
    p_request_id       uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_current integer;
  v_count   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'evidence_auth_required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'evidence_requires_read_committed' USING ERRCODE = 'raise_exception';
  END IF;

  IF p_study_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_study_id';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_expected_version';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_request_id';
  END IF;

  SELECT s.row_version INTO v_current
    FROM public.evidence_studies s
   WHERE s.id = p_study_id AND s.user_id = v_uid
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'already_absent');
  END IF;
  IF v_current <> p_expected_version THEN
    RAISE EXCEPTION 'evidence_version_conflict' USING ERRCODE = 'raise_exception';
  END IF;

  -- Children before parents, so no NO ACTION edge is ever left pointing at a
  -- deleted row, whatever order the cascades would fire in.
  DELETE FROM public.evidence_field_anchors    x WHERE x.user_id = v_uid AND x.study_id = p_study_id;
  DELETE FROM public.evidence_field_values     x WHERE x.user_id = v_uid AND x.study_id = p_study_id;
  DELETE FROM public.evidence_arms             x WHERE x.user_id = v_uid AND x.study_id = p_study_id;
  DELETE FROM public.evidence_outcomes         x WHERE x.user_id = v_uid AND x.study_id = p_study_id;
  DELETE FROM public.evidence_source_snapshots x WHERE x.user_id = v_uid AND x.study_id = p_study_id;
  DELETE FROM public.evidence_study_reports    x WHERE x.user_id = v_uid AND x.study_id = p_study_id;
  DELETE FROM public.evidence_events           x WHERE x.user_id = v_uid AND x.study_id = p_study_id;
  DELETE FROM public.evidence_studies          x WHERE x.user_id = v_uid AND x.id = p_study_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'evidence_internal_invariant' USING ERRCODE = 'internal_error';
  END IF;

  RETURN jsonb_build_object('status', 'deleted');
END
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 8. EXECUTE — revoke first, then the four RPCs for authenticated only
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Revoking by ROLE removes whatever any of these grantees could have received
-- from any default. The two helpers end up owner-only; the RPCs add exactly
-- `authenticated`. anon and service_role reach none of the six.

REVOKE ALL ON FUNCTION public.evidence_normalize_v1(text)                                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evidence_records_assert_writable()                         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evidence_create_study_from_paper(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evidence_update_study(uuid, integer, text, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evidence_set_link(uuid, uuid, text, integer, uuid)         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evidence_delete_study(uuid, integer, uuid)                 FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.evidence_create_study_from_paper(uuid, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.evidence_update_study(uuid, integer, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.evidence_set_link(uuid, uuid, text, integer, uuid)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.evidence_delete_study(uuid, integer, uuid)                 TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 9. Documentation readable from the database itself
-- ═════════════════════════════════════════════════════════════════════════════

COMMENT ON FUNCTION public.evidence_normalize_v1(text) IS
  'EVIDENCE-RECORDS-001A2. Match normalization v1 (REQUIREMENTS-001 section I3): NFC, remove U+00AD/U+200B/U+2060/U+FEFF, White_Space to one space and trim, curly quotes and U+2010-U+2015/U+2212 dashes to ASCII, U+2026 to "...", U+00B5 to U+03BC; nothing else (never NFKC). Pure; owner-only; used for source-copy fingerprints.';
COMMENT ON FUNCTION public.evidence_records_assert_writable() IS
  'EVIDENCE-RECORDS-001A2. The owner-only pilot gate: 42501 evidence_auth_required without auth.uid(), 42501 evidence_records_not_enabled unless get_current_user_access() reports role owner. Read on every call; internal-only (no client EXECUTE).';
COMMENT ON FUNCTION public.evidence_create_study_from_paper(uuid, text, text, text, uuid) IS
  'EVIDENCE-RECORDS-001A2. Owner-gated. Creates a study, its created_from_paper link to the caller''s paper and, when the paper has an abstract, a byte-exact copy with SHA-256 fingerprints. Idempotent per request id while the study exists (FK-PROOF-001 I-1).';
COMMENT ON FUNCTION public.evidence_update_study(uuid, integer, text, text, text, uuid) IS
  'EVIDENCE-RECORDS-001A2. Owner-gated. Replaces label, design family and notes at an expected version; unchanged requests write nothing; moving to non_intervention is refused while groups or n_randomized exist.';
COMMENT ON FUNCTION public.evidence_set_link(uuid, uuid, text, integer, uuid) IS
  'EVIDENCE-RECORDS-001A2. Owner-gated. confirm | mark_provisional | remove one existing link of the caller''s study; never creates or re-parents a link. Remove is refused while references use the link or when it is the study''s last link.';
COMMENT ON FUNCTION public.evidence_delete_study(uuid, integer, uuid) IS
  'EVIDENCE-RECORDS-001A2. NOT gated: any authenticated owner of a study may delete it. Locks it, checks the version, deletes children in explicit order, history included. already_absent for unknown and foreign ids alike.';


-- ═════════════════════════════════════════════════════════════════════════════
-- 10. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Asserts what this file claims, in the transaction that claims it. Suites 003,
-- 007, 015, 021, 030 and 031 pin the same facts in CI.

DO $verify$
DECLARE
  -- name(args) | result | language | security | volatility | strict | parallel | owner | config | acl
  v_expected CONSTANT text :=
       'evidence_create_study_from_paper(p_paper_id uuid, p_label text, p_design_profile text, p_link_status text, p_request_id uuid)'
    || '|jsonb|plpgsql|definer|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres,authenticated=X/postgres}' || E'\n'
    || 'evidence_delete_study(p_study_id uuid, p_expected_version integer, p_request_id uuid)'
    || '|jsonb|plpgsql|definer|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres,authenticated=X/postgres}' || E'\n'
    || 'evidence_normalize_v1(p_text text)'
    || '|text|plpgsql|invoker|i|t|s|postgres|{"search_path=pg_catalog, pg_temp"}|{postgres=X/postgres}' || E'\n'
    || 'evidence_records_assert_writable()'
    || '|void|plpgsql|invoker|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres}' || E'\n'
    || 'evidence_set_link(p_study_id uuid, p_paper_id uuid, p_action text, p_expected_version integer, p_request_id uuid)'
    || '|jsonb|plpgsql|definer|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres,authenticated=X/postgres}' || E'\n'
    || 'evidence_update_study(p_study_id uuid, p_expected_version integer, p_label text, p_design_profile text, p_notes text, p_request_id uuid)'
    || '|jsonb|plpgsql|definer|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres,authenticated=X/postgres}';
  -- regprocedure text, qualified because this file's search_path omits public.
  v_rpcs CONSTANT text :=
       'public.evidence_create_study_from_paper(uuid,text,text,text,uuid),public.evidence_delete_study(uuid,integer,uuid),'
    || 'public.evidence_set_link(uuid,uuid,text,integer,uuid),public.evidence_update_study(uuid,integer,text,text,text,uuid)';
  v_text  text;
  v_table text;
BEGIN
  -- The six functions, exactly, with every attribute this file sets.
  SELECT string_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ')'
                    || '|' || pg_get_function_result(p.oid)
                    || '|' || l.lanname
                    || '|' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
                    || '|' || p.provolatile::text
                    || '|' || CASE WHEN p.proisstrict THEN 't' ELSE 'f' END
                    || '|' || p.proparallel::text
                    || '|' || pg_get_userbyid(p.proowner)
                    || '|' || coalesce(p.proconfig::text, '<none>')
                    || '|' || coalesce(p.proacl::text, '<default>'),
                    E'\n' ORDER BY p.proname)
    INTO v_text
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%';
  IF v_text IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION E'evidence_lifecycle: the evidence functions are not the reviewed six:\n%', v_text;
  END IF;

  -- Effective EXECUTE, PUBLIC inheritance included: authenticated reaches the
  -- four RPCs and nothing else here; anon, service_role and PUBLIC reach none.
  SELECT coalesce(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.proname), '')
    INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_text IS DISTINCT FROM v_rpcs THEN
    RAISE EXCEPTION 'evidence_lifecycle: authenticated executes % instead of exactly the four RPCs', v_text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
                AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                     OR has_function_privilege('service_role', p.oid, 'EXECUTE')
                     OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                                 WHERE a.grantee = 0))) THEN
    RAISE EXCEPTION 'evidence_lifecycle: anon, service_role or PUBLIC can execute an evidence function';
  END IF;

  -- The tables are untouched: still exactly authenticated SELECT, no column
  -- grant, no trigger — the RPCs are the only write path.
  FOREACH v_table IN ARRAY ARRAY['evidence_studies', 'evidence_study_reports', 'evidence_source_snapshots',
                                 'evidence_arms', 'evidence_outcomes', 'evidence_field_values',
                                 'evidence_field_anchors', 'evidence_events'] LOOP
    SELECT coalesce(string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                               || ':' || a.privilege_type, ',' ORDER BY a.grantee::text, a.privilege_type), '')
      INTO v_text
      FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r'::"char", c.relowner))) a
     WHERE c.oid = to_regclass('public.' || v_table) AND a.grantee <> c.relowner;
    IF v_text <> 'authenticated:SELECT'
       OR has_table_privilege('authenticated', to_regclass('public.' || v_table), 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
       OR has_table_privilege('anon', to_regclass('public.' || v_table), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
       OR has_table_privilege('service_role', to_regclass('public.' || v_table), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
       OR EXISTS (SELECT 1 FROM pg_attribute att WHERE att.attrelid = to_regclass('public.' || v_table) AND att.attacl IS NOT NULL)
       OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.' || v_table) AND NOT t.tgisinternal) THEN
      RAISE EXCEPTION 'evidence_lifecycle: public.% is no longer SELECT-only for authenticated and trigger-free (grants %)', v_table, v_text;
    END IF;
  END LOOP;

  -- History is append-only by construction: no new function updates an event,
  -- and only the delete deletes one. Comments are stripped before scanning.
  SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '') INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'update[[:space:]]+(only[[:space:]]+)?(public\.)?evidence_events';
  IF v_text <> '' THEN
    RAISE EXCEPTION 'evidence_lifecycle: % update evidence_events', v_text;
  END IF;
  SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '') INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'delete[[:space:]]+from[[:space:]]+(only[[:space:]]+)?(public\.)?evidence_events';
  IF v_text <> 'evidence_delete_study' THEN
    RAISE EXCEPTION 'evidence_lifecycle: the functions deleting evidence_events are "%", not exactly evidence_delete_study', v_text;
  END IF;

  -- Normalization v1 behaves as specified on this server: NFC composes, the
  -- NFKC hazards are left alone, the steps run in their order, and NULL stays
  -- NULL. Inputs are built with chr(), so this block is plain ASCII too.
  IF public.evidence_normalize_v1('10' || chr(0x2075) || ' cells; 5 m' || chr(0x00B2) || '; ' || chr(0xFB01) || 'ber')
       IS DISTINCT FROM ('10' || chr(0x2075) || ' cells; 5 m' || chr(0x00B2) || '; ' || chr(0xFB01) || 'ber')
     OR public.evidence_normalize_v1('cafe' || chr(0x0301)) IS DISTINCT FROM ('caf' || chr(0x00E9))
     OR public.evidence_normalize_v1('  p' || chr(0x2009) || '<' || chr(0x202F) || '0.001' || chr(0x00A0) || chr(0x000D) || chr(0x000A))
       IS DISTINCT FROM 'p < 0.001'
     OR public.evidence_normalize_v1('a ' || chr(0x200B) || ' b' || chr(0x00AD) || 'c') IS DISTINCT FROM 'a bc'
     OR public.evidence_normalize_v1('e' || chr(0x00AD) || chr(0x0301)) IS DISTINCT FROM ('e' || chr(0x0301))
     OR public.evidence_normalize_v1(chr(0x201C) || 'a' || chr(0x201D) || ' ' || chr(0x2018) || 'b' || chr(0x2019)
                                     || ' ' || chr(0x2013) || ' ' || chr(0x2212) || ' ' || chr(0x2026) || ' ' || chr(0x00B5))
       IS DISTINCT FROM ('"a" ''b'' - - ... ' || chr(0x03BC))
     OR public.evidence_normalize_v1(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'evidence_lifecycle: evidence_normalize_v1 does not reproduce the reviewed v1 behaviour on this server';
  END IF;
END
$verify$;

COMMIT;
