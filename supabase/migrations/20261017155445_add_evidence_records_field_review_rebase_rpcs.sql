-- EVIDENCE-RECORDS-001A3 — authoritative field operations, server-side quote
-- matching, human review and source rebase for study records.
--
-- WHAT THIS MIGRATION IS
-- ─────────────────────────────────────────────────────────────────────────────
-- The third of three schema steps for the Manual PICO MVP specified in
-- EVIDENCE-INTELLIGENCE-REQUIREMENTS-001, as amended by 001A and corrected by
-- EVIDENCE-INTELLIGENCE-FK-PROOF-001. 20261012031537 (PR-A1) created the eight
-- tables; 20261016104232 (PR-A2) added the study lifecycle. This file adds the
-- write path for everything inside a study. It creates six functions, their
-- grants and their comments. No table, column, constraint, index, policy,
-- trigger, view or row is created or altered, and no PR-A1 or PR-A2 object is
-- replaced: evidence_normalize_v1 and the pilot gate are reused as installed.
--
--   Client RPCs — SECURITY DEFINER, EXECUTE for `authenticated` only:
--     evidence_save_changes             one atomic batch of group, outcome and
--                                       value changes, with source references
--     evidence_review_fields            Confirm or Flag ONE value at ONE version
--     evidence_rebase_source            save a new copy of a paper's abstract
--                                       for one study-report link, re-match
--   Internal helpers — SECURITY INVOKER, EXECUTE for their owner only:
--     evidence_locate_quote             deterministic quote location (v1)
--     evidence_state_reference_problems FK-PROOF-001 §J, stated once for both
--                                       save and review
--     evidence_value_digest             the bounded, text-free history record
--                                       of one value
--
-- Why three helpers rather than the one the brief names: §J must be ONE rule
-- for save and for Confirm (PR #345 was sent back because a validator and a
-- Confirm check held two copies of it and diverged), and every RPC that
-- records a value in history must record it identically.
--
-- Not here, by design: any UI, linking further reports to a study, AI
-- extraction, non-library sources, full-text quotes and any Evidence Matrix
-- change. They belong to PR-C1/C2 and later phases.
--
-- THE PILOT GATE, OWNERSHIP, ISOLATION — as PR-A2
-- ─────────────────────────────────────────────────────────────────────────────
-- Each RPC calls evidence_records_assert_writable() first: 42501
-- evidence_auth_required without a subject, 42501 evidence_records_not_enabled
-- unless internal_user_access says `owner`. Each takes the caller from
-- auth.uid(), accepts no user id, and names that caller's user_id in every read
-- and write. Someone else's id and an unknown id get the same answer. Each
-- refuses any isolation level but READ COMMITTED (the one PostgREST uses).
-- Delete stays ungated (PR-A2) and is not touched.
--
-- REQUEST IDEMPOTENCY — FK-PROOF-001 I-1, exactly as PR-A2
-- ─────────────────────────────────────────────────────────────────────────────
-- Gate, isolation guard and pure input validation; the advisory lock on
-- (caller, request id) in namespace 20261016, shared with PR-A2's RPCs; the
-- committed request header: same operation and payload fingerprint → its
-- stored result with status `replayed`, anything else → evidence_request_id_
-- reused; the study row FOR UPDATE and the version check; a request that
-- changes nothing answers `unchanged` and writes nothing (its request id is not
-- consumed); otherwise the changes, one header (ordinal 0), the change events
-- (1..n) at the new study version, and row_version + 1. The payload
-- fingerprint is SHA-256 over the UTF-8 text of a jsonb object holding the
-- operation and every argument except the request id.
--
-- evidence_save_changes — p_changes, a JSON array of at most 200 changes and at
-- most 65,536 bytes of jsonb text (draft PR-A3 limits). Every key listed for an
-- operation is required (JSON null where the operation allows it); any other
-- key is refused, and a key the server computes is refused as forged:
--   {op:"add_arm",    ref, arm_role, display_label, position}
--   {op:"update_arm", arm_id, arm_role, display_label, position}
--   {op:"remove_arm", arm_id}
--   {op:"add_outcome",    ref, display_label, position}
--   {op:"update_outcome", outcome_id, display_label, position}
--   {op:"remove_outcome", outcome_id}
--   {op:"set_value",  target, field_key, expected_value_version, value_state,
--                     state_reason, content, note, references}
--   {op:"clear_value", target, field_key, expected_value_version}
-- target is {scope:"study"}, {scope:"arm", arm_id | arm_ref} or
-- {scope:"outcome", outcome_id | outcome_ref}; a *_ref names a group or outcome
-- added in the same batch by its `ref` (1-64 of [A-Za-z0-9_-]).
-- expected_value_version is the value_version on screen, or null for a field
-- not yet recorded; a mismatch is evidence_version_conflict.
-- content follows the field's shape: {shape:"text", text},
-- {shape:"code", code}, {shape:"integer_with_reported_text", reported_text,
-- value}, {shape:"text_list", entries}. references is the value's COMPLETE
-- set: {anchor_id} keeps an existing reference unchanged; anything else is a
-- new one:
--   {purpose:"supports", source_kind:"abstract", paper_id, snapshot_id,
--    quote_text, occurrence, expected_match_count}
--   {purpose:"supports", source_kind:"full_text", paper_id, locator_kind,
--    locator_text}
--   {purpose:"examined", source_kind:"abstract", paper_id, snapshot_id}
--   {purpose:"examined", source_kind:"full_text", paper_id, locator_kind,
--    locator_text}                        (both null, or both given)
--   {purpose:"unavailable", source_kind, paper_id}
-- Supporting references take positions 0-2 in their order in the list.
-- A change names each entity at most once; a batch is a set of changes, not a
-- script. They are applied in a fixed phase order — groups and outcomes in
-- array order, then values in array order — and every rule that spans the
-- batch is checked on the final state, so the order of the array never
-- changes the outcome.
--
-- SOURCE-ATTRIBUTION RULES (FK-PROOF-001 §J; the PR-A1 single-row matrix)
-- ─────────────────────────────────────────────────────────────────────────────
--   state                supports   examined                 unavailable
--   reported             0-3        0                        0
--   not_reported         0          >= 1                     any
--   unclear              0-3        any; supports + examined >= 1    any
--   not_applicable       0          0                        0
--   source_unavailable   0          0                        >= 1
-- plus, per reference: the paper is linked to this study; an abstract quote or
-- examined abstract names a copy of THAT link, and a NEW one names the link's
-- current copy; an unavailable abstract names a link with no copy; one
-- examined-or-unavailable assessment per paper and source kind; at most 10
-- assessments per value (draft limit, bounding history). Full-text references
-- are locator-only. A Reported value with no supporting reference may be saved
-- (derived "No source given") and cannot be confirmed.
--
-- BLANK TEXT (Product Owner decision 4). A value text, list entry, note,
-- locator, group or outcome label is "blank" when it is empty after
-- normalization v1, and is refused; the text itself is stored exactly as sent.
-- The PR-A1 CHECKs measure btrim of U+0020 only, so this is stricter. The
-- minimum lengths of an Unclear note (10) and a Not applicable or flag note (3)
-- are measured as the CHECKs measure them, after trimming U+0020.
--
-- LISTS. Entries are never trimmed or rewritten. An entry with a leading or
-- trailing White_Space character (the 25 code points of v1) is refused, as is
-- a registration number containing one, U+001F anywhere, a blank entry and an
-- exact duplicate. The PR-A1 CHECK pattern itself is evaluated last, so an
-- entry its collation-dependent `\s` refuses is refused here first.
--
-- QUOTE MATCHING (REQUIREMENTS-001 §I4, 001A §D1 R5)
-- ─────────────────────────────────────────────────────────────────────────────
-- evidence_locate_quote normalizes the copy once and each quote once, with the
-- installed evidence_normalize_v1, then finds every contiguous occurrence of
-- the normalized quote in the normalized copy, overlapping ones included, in
-- position order. It compares UTF-8 bytes: UTF-8 is prefix-free and a
-- continuation byte never starts a character, so a byte match is exactly a
-- code point match. Offsets are 0-based, half-open code point offsets of the
-- v1-normalized copy (PO decision; suite 032). Case, punctuation and every
-- character count; an ellipsis is three full stops; nothing approximate
-- matches. A quote is refused when it has fewer than 3 or more than 1,000
-- characters as stored or once normalized, or contains no letter or digit:
-- `[[:alnum:]]` under the builtin pg_c_utf8 collation — Unicode Alphabetic, or
-- an ASCII digit — whatever the database's own collation provider is. More
-- than 100 occurrences (draft limit, bounding the work per quote) are not
-- enumerated: such a quote is ambiguous.
-- A new quote must name the link's current copy. With one occurrence it may
-- omit occurrence; with several it must name occurrence k AND the count it saw,
-- which must equal the server's (evidence_quote_ambiguous otherwise); with
-- none it is evidence_quote_not_found. The server alone writes match_start,
-- match_end, match_occurrence, match_count, normalization_version and
-- matched_at. A match proves only that the passage occurs in the saved copy.
--
-- REVIEW (001 §J2; 001A §E6, §I; PO decisions 1-3)
-- ─────────────────────────────────────────────────────────────────────────────
-- One value, one value_version, per call: there is no array parameter, so no
-- request can confirm two values. Confirm on a version already confirmed with
-- the same note is `unchanged`; it is checked after the version check and
-- before the preconditions, as the browser does (001A §I5) — safe because every
-- path that could invalidate a precondition (any edit, a rebase, a first
-- capture) moves the value out of user_reviewed and increments value_version.
-- Otherwise Confirm is refused, with evidence_confirm_blocked and the reasons
-- in DETAIL (PR-B's ConfirmBlock codes, in its order), when: the references
-- break §J; a Reported value has no current support (a quote on the link's
-- current copy, or a full-text locator); an Unclear value's only basis is
-- quotes on superseded copies; an examined abstract is not the current copy;
-- an unavailable abstract's link now has a copy; a number has no integer; an
-- Unclear value has no reason; or a required note is blank or short.
-- design_classification has no exception (PO decision 2). Confirm stores
-- reviewed_at and reviewed_version = value_version and takes an optional note;
-- Flag needs a note of at least 3 characters, in any state. Neither changes
-- value_version. Any saved change to a value returns it to unreviewed.
--
-- REBASE (001A §E2-§E8; FK-PROOF-001 §J)
-- ─────────────────────────────────────────────────────────────────────────────
-- "Use current abstract", and the first capture of a link without a copy. The
-- caller sends the SHA-256 of the abstract it displayed; the paper is read with
-- the owner predicate FOR SHARE, so an edit or merge in flight either finishes
-- first (and the hash then differs: evidence_source_changed_again) or waits
-- until the rebase commits. The same text as the current copy is `unchanged`.
-- At most 20 copies per link (evidence_snapshot_limit). A new copy (seq n+1)
-- is inserted; no copy is ever updated or removed. Each abstract quote on the
-- previous current copy is located in the new one: exactly one occurrence →
-- re-pointed (anchor_rematched); none or several → it stays on its earlier copy
-- (anchor_not_rematched). Examined abstracts are never re-pointed. Every value
-- with ANY abstract reference on that link that was reviewed, flagged or
-- needing re-review is Needs re-review (source_changed) afterwards — EVEN IF
-- EVERY QUOTE WAS FOUND AGAIN; unreviewed values stay unreviewed. A first
-- capture moves values holding an "abstract unavailable" reference the same
-- way. value_version + 1 wherever an anchor moved or the status changed.
--
-- HISTORY
-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only: no function here updates or deletes an event. Groups and
-- outcomes are recorded with their labels (as PR-A2 records the study label);
-- every other user text — values, list entries, notes, review notes,
-- locators — and every quote are recorded as {sha256, chars}, never as text,
-- so no event holds source text and every payload stays inside PR-A1's 32 KB.
--   save    arm_added/updated/removed, outcome_added/updated/removed,
--           value_saved (before/after digests), value_cleared (before)
--   review  review_confirmed, review_flagged (before/after digests; the after
--           digest names each reference and the seq of its copy, 001A §I4)
--   rebase  source_captured, anchor_rematched/anchor_not_rematched,
--           review_needs_rereview (before/after digests), source_rebased
-- review_reset is not emitted: value_saved records the review it cleared.
--
-- LIMITS — existing limits are kept; new ones are draft PR-A3 policy (Q11)
-- ─────────────────────────────────────────────────────────────────────────────
--   kept     5,000 events per study (evidence_history_limit); 3 supporting
--            references per value (CHECK); 50,000-character abstracts
--   draft    20 groups, 50 outcomes, 400 values per study (evidence_arm_limit,
--            evidence_outcome_limit, evidence_value_limit); 20 copies per link
--            (evidence_snapshot_limit); 200 changes and 65,536 bytes per save;
--            10 assessments per value; 100 occurrences per quote
-- Every count is checked on the final state of the batch, under the study row
-- lock, so neither a large batch nor concurrent requests can pass a limit.
--
-- ERRORS. Fixed messages, which never echo input, ids, text or SQL:
--   42501  evidence_auth_required, evidence_records_not_enabled
--   22023  evidence_invalid_input — DETAIL is the parameter, or a payload path
--          and rule, e.g. "p_changes[3].references[1].snapshot_id: not_current"
--   P0002  evidence_not_found, evidence_link_not_found,
--          evidence_target_not_found (DETAIL: the path of the id)
--   P0001  evidence_request_id_reused, evidence_version_conflict (DETAIL names
--          a value's version when it is the value that moved),
--          evidence_quote_not_found, evidence_quote_ambiguous,
--          evidence_confirm_blocked (DETAIL: the reasons),
--          evidence_source_changed_again, evidence_abstract_too_long,
--          evidence_snapshot_limit, evidence_arm_limit, evidence_outcome_limit,
--          evidence_value_limit, evidence_history_limit,
--          evidence_requires_read_committed
--   XX000  evidence_internal_invariant (unreachable by design)
--
-- LOCKS. Applying this file takes no lock on any user table. The RPCs take the
-- request advisory lock, then the study row FOR UPDATE, then (rebase only) the
-- paper row FOR SHARE; the inserts take KEY SHARE through their keys. They
-- never LOCK TABLE. The db-tests field/review/rebase race probe runs them
-- against each other, against link changes and against abstract edits.
--
-- The file is one explicit transaction, so its verification refuses a weaker
-- result under every runner.
--
-- ROLLBACK — forward only. A reversal is a new migration that drops the six
-- functions. Rows they wrote stay; removing them is a separate decision.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context
-- ═════════════════════════════════════════════════════════════════════════════

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'evidence_field_ops: must run as postgres (current_user is %)', current_user;
  END IF;

  IF current_setting('search_path') IS DISTINCT FROM 'pg_catalog, pg_temp'
     OR current_setting('lock_timeout') IS DISTINCT FROM '5s' THEN
    RAISE EXCEPTION 'evidence_field_ops: the transaction-local settings are not in effect (search_path %, lock_timeout %); this file must run as one transaction',
      current_setting('search_path'), current_setting('lock_timeout');
  END IF;
END
$ctx$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Preconditions — refuse anything but the reviewed PR-A1 + PR-A2 state
-- ═════════════════════════════════════════════════════════════════════════════

DO $pre$
DECLARE
  v_text  text;
  v_table text;
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'evidence_field_ops: server_encoding is %, UTF8 is required', current_setting('server_encoding');
  END IF;

  -- The RPCs write through FORCE ROW LEVEL SECURITY with no write policy.
  IF NOT (SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'evidence_field_ops: % does not hold BYPASSRLS', current_user;
  END IF;

  -- Exactly PR-A2's six functions, with their reviewed bodies, and nothing of
  -- this migration yet. md5(prosrc) is what the PR-A2 apply verified.
  SELECT coalesce(string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname COLLATE "C"), '') INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%';
  IF v_text IS DISTINCT FROM
       'evidence_create_study_from_paper=dd6949ee0e7125bbe0f83e7e49631983,'
    || 'evidence_delete_study=afc71c3ee3be2154b2c580dfb999b4aa,'
    || 'evidence_normalize_v1=0e7c43b310ad58ab43e7d4d6f1ca411e,'
    || 'evidence_records_assert_writable=53badd75082a39ee814de096653e4f5f,'
    || 'evidence_set_link=fcfd9b3546d772b5a00938426a46e90a,'
    || 'evidence_update_study=47cb76dee1273698b070638f36aa341d' THEN
    RAISE EXCEPTION 'evidence_field_ops: the evidence functions are not exactly the reviewed PR-A2 six: %', v_text;
  END IF;

  -- The two helpers this file calls, with the attributes PR-A2 gave them.
  IF (SELECT format('%s|%s|%s|%s|%s|%s', p.prosecdef, p.provolatile, p.proisstrict, pg_get_userbyid(p.proowner),
                    p.proconfig::text, coalesce(p.proacl::text, '<default>'))
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.evidence_normalize_v1(text)'))
     IS DISTINCT FROM 'f|i|t|postgres|{"search_path=pg_catalog, pg_temp"}|{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'evidence_field_ops: public.evidence_normalize_v1(text) is not the reviewed owner-only IMMUTABLE STRICT INVOKER helper';
  END IF;
  IF (SELECT format('%s|%s|%s|%s|%s', p.prosecdef, p.provolatile, pg_get_userbyid(p.proowner),
                    p.proconfig::text, coalesce(p.proacl::text, '<default>'))
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.evidence_records_assert_writable()'))
     IS DISTINCT FROM 'f|v|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'evidence_field_ops: public.evidence_records_assert_writable() is not the reviewed owner-only gate';
  END IF;
  IF to_regprocedure('public.get_current_user_access()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public.get_current_user_access()')
                       AND p.prosecdef AND p.proowner = 'postgres'::regrole
                       AND 'role' = ANY (p.proargnames)) THEN
    RAISE EXCEPTION 'evidence_field_ops: public.get_current_user_access() is not the reviewed SECURITY DEFINER role projection';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'evidence_field_ops: auth.uid() does not exist';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['evidence_studies', 'evidence_study_reports', 'evidence_source_snapshots',
                                 'evidence_arms', 'evidence_outcomes', 'evidence_field_values',
                                 'evidence_field_anchors', 'evidence_events'] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'evidence_field_ops: public.% does not exist; 20261012031537 must be applied first', v_table;
    END IF;
  END LOOP;

  -- The single-row rules the RPCs mirror — every CHECK and UNIQUE constraint of
  -- the six tables they write, and the assessment index — are exactly the
  -- reviewed PR-A1 definitions. Deparsed under this file's search_path.
  SELECT md5(
    (SELECT string_agg(c.conrelid::regclass::text || '.' || c.conname || '=' || pg_get_constraintdef(c.oid), E'\n'
                       ORDER BY c.conrelid::regclass::text COLLATE "C", c.conname COLLATE "C")
       FROM pg_constraint c
      WHERE c.contype IN ('c', 'u')
        AND c.conrelid IN ('public.evidence_arms'::regclass, 'public.evidence_outcomes'::regclass,
                           'public.evidence_field_values'::regclass, 'public.evidence_field_anchors'::regclass,
                           'public.evidence_events'::regclass, 'public.evidence_source_snapshots'::regclass))
    || E'\n' || pg_get_indexdef('public.evidence_field_anchors_assessment_key'::regclass))
    INTO v_text;
  IF v_text IS DISTINCT FROM '7727f9a9049b285b27a401e5b2894ade' THEN
    RAISE EXCEPTION 'evidence_field_ops: the evidence CHECK and UNIQUE rules are not the reviewed PR-A1 definitions (digest %)', v_text;
  END IF;

  -- The durable request key the algorithm relies on.
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indexrelid = to_regclass('public.evidence_events_request_header_key')
                    AND i.indisunique
                    AND pg_get_expr(i.indpred, i.indrelid) = '(ordinal = 0)') THEN
    RAISE EXCEPTION 'evidence_field_ops: evidence_events_request_header_key is not the reviewed partial unique index';
  END IF;

  -- The letter-or-digit rule needs the builtin, platform-independent collation.
  IF NOT EXISTS (SELECT 1 FROM pg_collation c
                  WHERE c.collname = 'pg_c_utf8' AND c.collnamespace = 'pg_catalog'::regnamespace
                    AND c.collprovider = 'b') THEN
    RAISE EXCEPTION 'evidence_field_ops: the builtin collation pg_catalog.pg_c_utf8 does not exist';
  END IF;
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. evidence_locate_quote — deterministic quote location (REQUIREMENTS-001 §I4)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every quote of p_quotes is located in p_snapshot. The copy is normalized once
-- for all of them, and each quote once: an input is never normalized twice
-- (v1 is not idempotent). One row per element, in order:
--   ord                1-based position in p_quotes
--   status             invalid | not_found | unique | multiple | too_many
--   problems           why an invalid quote is invalid (PR-B's QuoteProblem
--                      codes, in its order); empty otherwise
--   normalized_length  characters of the normalized quote
--   match_count        occurrences (null when invalid or too_many)
--   starts             0-based code point offset of each occurrence in the
--                      normalized copy; each ends at start + normalized_length
-- It decides only whether the passage occurs. It is not a review, and it says
-- nothing about whether the passage supports a value.

CREATE FUNCTION public.evidence_locate_quote(p_quotes text[], p_snapshot text)
RETURNS TABLE (ord integer, status text, problems text[], normalized_length integer,
               match_count integer, starts integer[])
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- More occurrences than this are not enumerated: the quote is too_many.
  c_cap   CONSTANT integer := 100;
  v_sb    bytea;
  v_quote text;
  v_nq    text;
  v_nb    bytea;
  v_ord   integer := 0;
  v_from  integer;
  v_hit   integer;
  v_at    integer;
  v_prev  integer;
  v_char  integer;
  v_found integer;
  v_list  integer[];
BEGIN
  v_sb := convert_to(public.evidence_normalize_v1(p_snapshot), 'UTF8');

  FOREACH v_quote IN ARRAY p_quotes LOOP
    v_ord := v_ord + 1;
    ord := v_ord;
    problems := '{}';
    normalized_length := NULL;
    match_count := NULL;
    starts := '{}';

    IF v_quote IS NULL THEN
      status := 'invalid';
      problems := ARRAY['quote_missing'];
      RETURN NEXT;
      CONTINUE;
    END IF;

    v_nq := public.evidence_normalize_v1(v_quote);
    normalized_length := char_length(v_nq);
    IF char_length(v_quote) < 3 THEN problems := array_append(problems, 'quote_too_short'); END IF;
    IF char_length(v_quote) > 1000 THEN problems := array_append(problems, 'quote_too_long'); END IF;
    IF normalized_length < 3 THEN problems := array_append(problems, 'normalized_too_short'); END IF;
    IF normalized_length > 1000 THEN problems := array_append(problems, 'normalized_too_long'); END IF;
    -- Unicode Alphabetic or an ASCII digit, by the builtin provider's own
    -- Unicode tables: the same answer under any database collation.
    IF NOT (v_nq COLLATE pg_catalog.pg_c_utf8 ~ '[[:alnum:]]') THEN
      problems := array_append(problems, 'no_letter_or_digit');
    END IF;
    IF cardinality(problems) > 0 THEN
      status := 'invalid';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Every occurrence, overlapping ones included: each search starts one byte
    -- after the previous match's first byte. Character offsets are counted
    -- incrementally over the bytes between matches, so the copy is decoded
    -- once in total, not once per occurrence.
    v_nb := convert_to(v_nq, 'UTF8');
    v_list := '{}';
    v_found := 0;
    v_from := 1;
    v_prev := 1;
    v_char := 0;
    LOOP
      v_hit := position(v_nb IN substring(v_sb FROM v_from));
      EXIT WHEN v_hit = 0;
      v_found := v_found + 1;
      EXIT WHEN v_found > c_cap;
      v_at := v_from + v_hit - 1;
      v_char := v_char + char_length(convert_from(substring(v_sb FROM v_prev FOR v_at - v_prev), 'UTF8'));
      v_list := array_append(v_list, v_char);
      v_prev := v_at;
      v_from := v_at + 1;
    END LOOP;

    IF v_found > c_cap THEN
      status := 'too_many';
    ELSIF v_found = 0 THEN
      status := 'not_found';
      match_count := 0;
    ELSE
      status := CASE WHEN v_found = 1 THEN 'unique' ELSE 'multiple' END;
      match_count := v_found;
      starts := v_list;
    END IF;
    RETURN NEXT;
  END LOOP;
  RETURN;
END
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. evidence_state_reference_problems — FK-PROOF-001 §J, stated once
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The reference-count rules a value in p_state breaks, given how many
-- references it holds per purpose: PR-A1's cap of three supporting references,
-- then §J. Empty when the counts are allowed. The codes and their order are
-- PR-B's checkStateReferences (src/lib/evidence/validation.ts), without the
-- "references." prefix. Save refuses any of them; Confirm maps them to its
-- block reasons.

CREATE FUNCTION public.evidence_state_reference_problems(
    p_state       text,
    p_supports    integer,
    p_examined    integer,
    p_unavailable integer)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE
    WHEN p_state NOT IN ('reported', 'not_reported', 'unclear', 'not_applicable', 'source_unavailable')
         OR p_supports < 0 OR p_examined < 0 OR p_unavailable < 0
      THEN ARRAY['state_unknown']::text[]
    ELSE array_remove(ARRAY[
      CASE WHEN p_supports > 3 THEN 'too_many_supporting' END,
      CASE WHEN p_state = 'not_applicable' AND p_supports + p_examined + p_unavailable > 0 THEN 'not_allowed' END,
      CASE WHEN p_state IN ('not_reported', 'source_unavailable') AND p_supports > 0 THEN 'supporting_not_allowed' END,
      CASE WHEN p_state IN ('reported', 'source_unavailable') AND p_examined > 0 THEN 'examined_not_allowed'
           WHEN p_state = 'not_reported' AND p_examined = 0 THEN 'examined_required' END,
      CASE WHEN p_state = 'reported' AND p_unavailable > 0 THEN 'unavailable_not_allowed'
           WHEN p_state = 'source_unavailable' AND p_unavailable = 0 THEN 'unavailable_required' END,
      CASE WHEN p_state = 'unclear' AND p_supports + p_examined = 0 THEN 'basis_required' END
    ]::text[], NULL)
  END
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. evidence_value_digest — one value, as history records it
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Codes, integers, states, ids, versions and match offsets in clear; every user
-- text and every quote as {sha256, chars} (a list as {sha256, count}), so the
-- digest holds no source text and stays a few kilobytes. Null when the value
-- does not exist. INVOKER: inside a DEFINER RPC it reads as that RPC's owner;
-- it has no EXECUTE grant of its own.

CREATE FUNCTION public.evidence_value_digest(p_user_id uuid, p_value_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
STRICT
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  SELECT jsonb_build_object(
    'value_id', v.id,
    'field_key', v.field_key,
    'arm_id', v.arm_id,
    'outcome_id', v.outcome_id,
    'value_state', v.value_state,
    'state_reason', v.state_reason,
    'content', CASE
      WHEN v.value_state <> 'reported' THEN NULL
      WHEN v.value_code IS NOT NULL THEN jsonb_build_object('code', v.value_code)
      WHEN v.value_list IS NOT NULL THEN jsonb_build_object('entries', jsonb_build_object(
        'sha256', encode(sha256(convert_to(to_jsonb(v.value_list)::text, 'UTF8')), 'hex'),
        'count', cardinality(v.value_list)))
      WHEN v.value_int IS NOT NULL THEN jsonb_build_object(
        'reported_text', jsonb_build_object('sha256', encode(sha256(convert_to(v.value_text, 'UTF8')), 'hex'),
                                            'chars', char_length(v.value_text)),
        'value', v.value_int)
      ELSE jsonb_build_object('text', jsonb_build_object(
        'sha256', encode(sha256(convert_to(v.value_text, 'UTF8')), 'hex'), 'chars', char_length(v.value_text)))
    END,
    'note', CASE WHEN v.note IS NULL THEN NULL
                 ELSE jsonb_build_object('sha256', encode(sha256(convert_to(v.note, 'UTF8')), 'hex'),
                                         'chars', char_length(v.note)) END,
    'value_version', v.value_version,
    'review', jsonb_build_object(
      'status', v.review_status,
      'reason', v.review_reason,
      'reviewed_at', v.reviewed_at,
      'reviewed_version', v.reviewed_version,
      'note', CASE WHEN v.review_note IS NULL THEN NULL
                   ELSE jsonb_build_object('sha256', encode(sha256(convert_to(v.review_note, 'UTF8')), 'hex'),
                                           'chars', char_length(v.review_note)) END),
    'references', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'anchor_id', a.id,
               'purpose', a.purpose,
               'source_kind', a.source_kind,
               'paper_id', a.paper_id,
               'snapshot_id', a.snapshot_id,
               'snapshot_seq', c.seq,
               'position', a.position,
               'quote', CASE WHEN a.quote_text IS NULL THEN NULL
                             ELSE jsonb_build_object('sha256', encode(sha256(convert_to(a.quote_text, 'UTF8')), 'hex'),
                                                     'chars', char_length(a.quote_text)) END,
               'match', CASE WHEN a.match_start IS NULL THEN NULL
                             ELSE jsonb_build_object('start', a.match_start, 'end', a.match_end,
                                                     'occurrence', a.match_occurrence, 'count', a.match_count) END,
               'locator', CASE WHEN a.locator_kind IS NULL THEN NULL
                               ELSE jsonb_build_object('kind', a.locator_kind, 'text', jsonb_build_object(
                                      'sha256', encode(sha256(convert_to(a.locator_text, 'UTF8')), 'hex'),
                                      'chars', char_length(a.locator_text))) END)
             ORDER BY (a.purpose <> 'supports'), a.position, a.purpose COLLATE "C", a.source_kind COLLATE "C",
                      a.paper_id, a.id)
        FROM public.evidence_field_anchors a
        LEFT JOIN public.evidence_source_snapshots c
          ON c.user_id = a.user_id AND c.study_id = a.study_id AND c.paper_id = a.paper_id AND c.id = a.snapshot_id
       WHERE a.user_id = v.user_id AND a.study_id = v.study_id AND a.value_id = v.id), '[]'::jsonb))
    FROM public.evidence_field_values v
   WHERE v.user_id = p_user_id AND v.id = p_value_id
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. evidence_save_changes — one atomic batch inside one study
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Phases, each in a fixed order, all inside the caller's transaction: any
-- refusal rolls back every write of the call.
--   0  pure: arguments, size, every change's shape, duplicates, batch refs
--   1  request lock, header (replay / reused), study FOR UPDATE, version
--   2  groups and outcomes, in array order
--   3  values, in array order: targets, versions, field rules, references
--   4  quote matching, one locate call per copy; refusals in array order
--   5  values written; unchanged values write nothing
--   6  the final state: positions, comparator-only, limits
--   7  `unchanged` if nothing changed; else history limit, events, header,
--      row_version + 1

CREATE FUNCTION public.evidence_save_changes(
    p_study_id         uuid,
    p_expected_version integer,
    p_changes          jsonb,
    p_request_id       uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- The closed field dictionary: PR-A1's field-key and value-shape CHECKs, the
  -- design families of REQUIREMENTS-001 section H2-H5 and the comparator-only rule.
  -- fieldDictionary.parity.test.ts compares it with src/lib/evidence.
  c_fields CONSTANT jsonb := $fields${
    "design_as_reported":       {"scope": "study", "shape": "text", "max": 500},
    "design_classification":    {"scope": "study", "shape": "code", "codes": ["rct_parallel", "rct_cluster", "rct_crossover", "rct_other", "non_randomized_controlled", "single_group_intervention", "cohort", "case_control", "cross_sectional", "case_series", "other"]},
    "setting":                  {"scope": "study", "shape": "text", "max": 1000},
    "registration_ids":         {"scope": "study", "shape": "text_list", "min_entries": 1, "max_entries": 5, "entry_min": 3, "entry_max": 50, "whitespace": "none"},
    "population_description":   {"scope": "study", "shape": "text", "max": 2000},
    "condition":                {"scope": "study", "shape": "text", "max": 500},
    "eligibility_criteria":     {"scope": "study", "shape": "text", "max": 4000},
    "demographics":             {"scope": "study", "shape": "text", "max": 2000},
    "n_randomized":             {"scope": "study", "shape": "integer_with_reported_text", "max": 200, "families": ["rct_parallel", "intervention_other"]},
    "n_enrolled":               {"scope": "study", "shape": "integer_with_reported_text", "max": 200},
    "arm_name_as_reported":     {"scope": "arm", "shape": "text", "max": 300},
    "description":              {"scope": "arm", "shape": "text", "max": 4000},
    "comparator_type":          {"scope": "arm", "shape": "code", "codes": ["placebo", "sham", "usual_care", "no_intervention", "waitlist", "active_comparator", "other"], "roles": ["comparator"]},
    "dose_or_intensity":        {"scope": "arm", "shape": "text", "max": 500},
    "frequency":                {"scope": "arm", "shape": "text", "max": 500},
    "duration":                 {"scope": "arm", "shape": "text", "max": 500},
    "delivery_mode":            {"scope": "arm", "shape": "text", "max": 500},
    "co_interventions":         {"scope": "arm", "shape": "text", "max": 1000},
    "outcome_name_as_reported": {"scope": "outcome", "shape": "text", "max": 500},
    "outcome_definition":       {"scope": "outcome", "shape": "text", "max": 2000},
    "measurement_instrument":   {"scope": "outcome", "shape": "text", "max": 500},
    "outcome_designation":      {"scope": "outcome", "shape": "code", "codes": ["primary", "secondary"]},
    "time_points":              {"scope": "outcome", "shape": "text_list", "min_entries": 1, "max_entries": 10, "entry_min": 1, "entry_max": 100, "whitespace": "inner"}
  }$fields$;
  -- The 25 Unicode White_Space code points, exactly as evidence_normalize_v1
  -- maps them.
  c_ws CONSTANT text :=
       chr(0x0009) || chr(0x000A) || chr(0x000B) || chr(0x000C) || chr(0x000D)
    || chr(0x0020) || chr(0x0085) || chr(0x00A0) || chr(0x1680)
    || chr(0x2000) || chr(0x2001) || chr(0x2002) || chr(0x2003) || chr(0x2004) || chr(0x2005)
    || chr(0x2006) || chr(0x2007) || chr(0x2008) || chr(0x2009) || chr(0x200A)
    || chr(0x2028) || chr(0x2029) || chr(0x202F) || chr(0x205F) || chr(0x3000);
  -- Columns the server alone writes: naming one in a change is forgery.
  c_server_keys CONSTANT text[] := ARRAY[
    'id', 'user_id', 'study_id', 'value_id', 'position', 'created_at', 'updated_at',
    'match_start', 'match_end', 'match_occurrence', 'match_count', 'normalization_version', 'matched_at',
    'review_status', 'review_reason', 'review_note', 'reviewed_at', 'reviewed_version', 'value_version',
    'extraction_method', 'exact_text', 'exact_sha256', 'normalized_sha256', 'seq', 'captured_at', 'char_count'];
  c_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  v_uid       uuid := auth.uid();
  v_n         integer;
  v_i         integer;
  v_j         integer;
  v_c         jsonb;
  v_t         jsonb;
  v_r         jsonb;
  v_x         jsonb;
  v_def       jsonb;
  v_op        text;
  v_path      text;
  v_rpath     text;
  v_s         text;
  v_k         text;
  v_allowed   text[];
  v_scope     text;
  v_state     text;
  v_kind      text;
  v_purpose   text;
  v_e         record;
  v_list      text[];
  -- phase 0 bookkeeping
  v_arm_ids_seen     uuid[] := '{}';
  v_outcome_ids_seen uuid[] := '{}';
  v_removed_arms     uuid[] := '{}';
  v_removed_outcomes uuid[] := '{}';
  v_arm_refs         text[] := '{}';
  v_outcome_refs     text[] := '{}';
  v_targets          text[] := '{}';
  v_kept_seen        uuid[];
  -- phases 1-7
  v_payload   bytea;
  v_header    record;
  v_study     record;
  v_version   integer;
  v_id        uuid;
  v_arm       uuid;
  v_outcome   uuid;
  v_row       record;
  v_value     record;
  v_role      text;
  v_label     text;
  v_pos       integer;
  v_before    jsonb;
  v_after     jsonb;
  v_vals      jsonb;
  v_events    jsonb := '[]'::jsonb;
  v_arm_map   jsonb := '{}'::jsonb;
  v_out_map   jsonb := '{}'::jsonb;
  v_role_changed     uuid[] := '{}';
  v_role_changed_at  integer[] := '{}';
  v_arm_written      boolean := false;
  v_outcome_written  boolean := false;
  v_value_inserted   boolean := false;
  v_count     integer;
  v_supports  integer;
  v_examined  integer;
  v_unavail   integer;
  v_problems  text[];
  v_assess    text[];
  v_current   uuid;
  v_seq       integer;
  v_old       public.evidence_field_anchors[];
  v_anchor    public.evidence_field_anchors;
  -- new abstract quotes, one row per quote, in (change, reference) order
  v_q_change  integer[] := '{}';
  v_q_ref     integer[] := '{}';
  v_q_snap    uuid[] := '{}';
  v_q_text    text[] := '{}';
  v_q_occ     integer[] := '{}';
  v_q_seen    integer[] := '{}';
  v_q_status  text[];
  v_q_start   integer[];
  v_q_end     integer[];
  v_q_occn    integer[];
  v_q_count   integer[];
  v_snaps     uuid[];
  v_snap      uuid;
  v_idx       integer[];
  v_quotes    text[];
  v_m         record;
  v_q         integer;
  -- one value's new state
  v_new_text  text;
  v_new_code  text;
  v_new_int   integer;
  v_new_list  text[];
  v_new_reason text;
  v_new_note  text;
  v_refs_changed boolean;
  v_content_changed boolean;
  v_kept_ids  uuid[];
  v_kept_old  uuid[];
  v_result    jsonb;
BEGIN
  PERFORM public.evidence_records_assert_writable();

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'evidence_requires_read_committed' USING ERRCODE = 'raise_exception';
  END IF;

  -- -- Phase 0: arguments and the shape of every change (no table is read) --

  IF p_study_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_study_id';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_expected_version';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_changes';
  END IF;
  IF octet_length(p_changes::text) > 65536 THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_changes: too_large';
  END IF;
  v_n := jsonb_array_length(p_changes);
  IF v_n > 200 THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_changes: too_many_changes';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_request_id';
  END IF;

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_c := p_changes -> v_i;
    v_path := 'p_changes[' || v_i || ']';
    IF jsonb_typeof(v_c) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || ': not_object';
    END IF;
    IF jsonb_typeof(v_c -> 'op') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.op: invalid';
    END IF;
    v_op := v_c ->> 'op';
    v_allowed := CASE v_op
      WHEN 'add_arm'        THEN ARRAY['op', 'ref', 'arm_role', 'display_label', 'position']
      WHEN 'update_arm'     THEN ARRAY['op', 'arm_id', 'arm_role', 'display_label', 'position']
      WHEN 'remove_arm'     THEN ARRAY['op', 'arm_id']
      WHEN 'add_outcome'    THEN ARRAY['op', 'ref', 'display_label', 'position']
      WHEN 'update_outcome' THEN ARRAY['op', 'outcome_id', 'display_label', 'position']
      WHEN 'remove_outcome' THEN ARRAY['op', 'outcome_id']
      WHEN 'set_value'      THEN ARRAY['op', 'target', 'field_key', 'expected_value_version', 'value_state',
                                       'state_reason', 'content', 'note', 'references']
      WHEN 'clear_value'    THEN ARRAY['op', 'target', 'field_key', 'expected_value_version']
    END;
    IF v_allowed IS NULL THEN
      RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.op: invalid';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_c) AS k(key) WHERE k.key <> ALL (v_allowed) AND k.key = ANY (c_server_keys)) THEN
      RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || ': server_attested';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_c) AS k(key) WHERE k.key <> ALL (v_allowed)) THEN
      RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || ': unknown_key';
    END IF;
    IF NOT (v_c ?& v_allowed) THEN
      RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || ': missing_key';
    END IF;

    -- Groups and outcomes: structure, not evidence.
    IF v_op IN ('add_arm', 'add_outcome') THEN
      IF jsonb_typeof(v_c -> 'ref') IS DISTINCT FROM 'string' OR (v_c ->> 'ref') !~ '^[A-Za-z0-9_-]{1,64}$' THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.ref: invalid';
      END IF;
      IF (v_c ->> 'ref') = ANY (v_arm_refs || v_outcome_refs) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.ref: duplicate';
      END IF;
      IF v_op = 'add_arm' THEN
        v_arm_refs := array_append(v_arm_refs, v_c ->> 'ref');
      ELSE
        v_outcome_refs := array_append(v_outcome_refs, v_c ->> 'ref');
      END IF;
    END IF;
    IF v_op IN ('update_arm', 'remove_arm') THEN
      IF jsonb_typeof(v_c -> 'arm_id') IS DISTINCT FROM 'string' OR (v_c ->> 'arm_id') !~ c_uuid THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.arm_id: invalid';
      END IF;
      IF (v_c ->> 'arm_id')::uuid = ANY (v_arm_ids_seen) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.arm_id: duplicate';
      END IF;
      v_arm_ids_seen := array_append(v_arm_ids_seen, (v_c ->> 'arm_id')::uuid);
      IF v_op = 'remove_arm' THEN
        v_removed_arms := array_append(v_removed_arms, (v_c ->> 'arm_id')::uuid);
      END IF;
    END IF;
    IF v_op IN ('update_outcome', 'remove_outcome') THEN
      IF jsonb_typeof(v_c -> 'outcome_id') IS DISTINCT FROM 'string' OR (v_c ->> 'outcome_id') !~ c_uuid THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.outcome_id: invalid';
      END IF;
      IF (v_c ->> 'outcome_id')::uuid = ANY (v_outcome_ids_seen) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.outcome_id: duplicate';
      END IF;
      v_outcome_ids_seen := array_append(v_outcome_ids_seen, (v_c ->> 'outcome_id')::uuid);
      IF v_op = 'remove_outcome' THEN
        v_removed_outcomes := array_append(v_removed_outcomes, (v_c ->> 'outcome_id')::uuid);
      END IF;
    END IF;
    IF v_op IN ('add_arm', 'update_arm') THEN
      IF jsonb_typeof(v_c -> 'arm_role') IS DISTINCT FROM 'string'
         OR (v_c ->> 'arm_role') NOT IN ('intervention', 'comparator') THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.arm_role: invalid';
      END IF;
    END IF;
    IF v_op IN ('add_arm', 'update_arm', 'add_outcome', 'update_outcome') THEN
      IF jsonb_typeof(v_c -> 'display_label') IS DISTINCT FROM 'string'
         OR char_length(v_c ->> 'display_label') > (CASE WHEN v_op LIKE '%arm' THEN 120 ELSE 200 END)
         OR public.evidence_normalize_v1(v_c ->> 'display_label') = '' THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.display_label: invalid';
      END IF;
      IF jsonb_typeof(v_c -> 'position') IS DISTINCT FROM 'number'
         OR (v_c -> 'position')::text !~ '^(0|[1-9][0-9]?)$' THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.position: invalid';
      END IF;
    END IF;

    -- Values: the target, the field, the state and its content.
    IF v_op IN ('set_value', 'clear_value') THEN
      v_t := v_c -> 'target';
      IF jsonb_typeof(v_t) IS DISTINCT FROM 'object' OR jsonb_typeof(v_t -> 'scope') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.target: invalid';
      END IF;
      v_scope := v_t ->> 'scope';
      IF v_scope = 'study' AND (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_t) k) = ARRAY['scope'] THEN
        v_k := 'study';
      ELSIF v_scope = 'arm' AND (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_t) k) = ARRAY['arm_id', 'scope']
            AND jsonb_typeof(v_t -> 'arm_id') = 'string' AND (v_t ->> 'arm_id') ~ c_uuid THEN
        v_k := 'arm:' || lower(v_t ->> 'arm_id');
      ELSIF v_scope = 'arm' AND (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_t) k) = ARRAY['arm_ref', 'scope']
            AND jsonb_typeof(v_t -> 'arm_ref') = 'string' THEN
        v_k := 'arm_ref:' || (v_t ->> 'arm_ref');
      ELSIF v_scope = 'outcome' AND (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_t) k) = ARRAY['outcome_id', 'scope']
            AND jsonb_typeof(v_t -> 'outcome_id') = 'string' AND (v_t ->> 'outcome_id') ~ c_uuid THEN
        v_k := 'outcome:' || lower(v_t ->> 'outcome_id');
      ELSIF v_scope = 'outcome' AND (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_t) k) = ARRAY['outcome_ref', 'scope']
            AND jsonb_typeof(v_t -> 'outcome_ref') = 'string' THEN
        v_k := 'outcome_ref:' || (v_t ->> 'outcome_ref');
      ELSE
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.target: invalid';
      END IF;

      IF jsonb_typeof(v_c -> 'field_key') IS DISTINCT FROM 'string' OR NOT (c_fields ? (v_c ->> 'field_key')) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.field_key: unknown';
      END IF;
      v_def := c_fields -> (v_c ->> 'field_key');
      IF (v_def ->> 'scope') <> v_scope THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.field_key: wrong_scope';
      END IF;
      v_k := v_k || '|' || (v_c ->> 'field_key');
      IF v_k = ANY (v_targets) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || ': duplicate_target';
      END IF;
      v_targets := array_append(v_targets, v_k);

      v_x := v_c -> 'expected_value_version';
      IF NOT (jsonb_typeof(v_x) = 'null' AND v_op = 'set_value')
         AND NOT (jsonb_typeof(v_x) = 'number' AND v_x::text ~ '^[1-9][0-9]{0,9}$' AND v_x::text::bigint <= 2147483647) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.expected_value_version: invalid';
      END IF;
    END IF;

    IF v_op = 'set_value' THEN
      IF jsonb_typeof(v_c -> 'value_state') IS DISTINCT FROM 'string'
         OR (v_c ->> 'value_state') NOT IN ('reported', 'not_reported', 'unclear', 'not_applicable', 'source_unavailable') THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.value_state: invalid';
      END IF;
      v_state := v_c ->> 'value_state';

      -- A reason exactly when Unclear (PR-A1 state_reason_check).
      IF v_state = 'unclear' THEN
        IF jsonb_typeof(v_c -> 'state_reason') IS DISTINCT FROM 'string'
           OR (v_c ->> 'state_reason') NOT IN ('ambiguous', 'conflicting', 'incomplete') THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.state_reason: invalid';
        END IF;
      ELSIF jsonb_typeof(v_c -> 'state_reason') <> 'null' THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.state_reason: not_allowed';
      END IF;

      -- A note: bounded, not blank after v1; Unclear needs 10 characters and
      -- Not applicable 3, measured as the PR-A1 CHECK measures them.
      v_x := v_c -> 'note';
      IF jsonb_typeof(v_x) = 'string' THEN
        IF char_length(v_x #>> '{}') > 2000 THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.note: too_long';
        END IF;
        IF public.evidence_normalize_v1(v_x #>> '{}') = '' THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.note: blank';
        END IF;
      ELSIF jsonb_typeof(v_x) <> 'null' THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.note: invalid';
      END IF;
      IF (v_state = 'unclear' AND (jsonb_typeof(v_x) <> 'string' OR char_length(btrim(v_x #>> '{}')) < 10))
         OR (v_state = 'not_applicable' AND (jsonb_typeof(v_x) <> 'string' OR char_length(btrim(v_x #>> '{}')) < 3)) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.note: required';
      END IF;

      -- "Reported" if and only if a value is present, in the field's shape.
      v_x := v_c -> 'content';
      IF v_state <> 'reported' THEN
        IF jsonb_typeof(v_x) <> 'null' THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content: not_allowed';
        END IF;
      ELSE
        IF jsonb_typeof(v_x) IS DISTINCT FROM 'object' OR (v_x ->> 'shape') IS DISTINCT FROM (v_def ->> 'shape')
           OR jsonb_typeof(v_x -> 'shape') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content: wrong_shape';
        END IF;
        v_allowed := CASE v_def ->> 'shape'
          WHEN 'text' THEN ARRAY['shape', 'text']
          WHEN 'code' THEN ARRAY['code', 'shape']
          WHEN 'integer_with_reported_text' THEN ARRAY['reported_text', 'shape', 'value']
          WHEN 'text_list' THEN ARRAY['entries', 'shape']
        END;
        IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_x) k) IS DISTINCT FROM v_allowed THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content: wrong_shape';
        END IF;
        CASE v_def ->> 'shape'
          WHEN 'text' THEN
            IF jsonb_typeof(v_x -> 'text') <> 'string' THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.text: invalid';
            END IF;
            IF public.evidence_normalize_v1(v_x ->> 'text') = '' THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.text: blank';
            END IF;
            IF char_length(v_x ->> 'text') > (v_def ->> 'max')::integer THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.text: too_long';
            END IF;
          WHEN 'code' THEN
            IF jsonb_typeof(v_x -> 'code') <> 'string' OR NOT ((v_def -> 'codes') ? (v_x ->> 'code')) THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.code: not_in_list';
            END IF;
          WHEN 'integer_with_reported_text' THEN
            IF jsonb_typeof(v_x -> 'reported_text') <> 'string' THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.reported_text: invalid';
            END IF;
            IF public.evidence_normalize_v1(v_x ->> 'reported_text') = '' THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.reported_text: blank';
            END IF;
            IF char_length(v_x ->> 'reported_text') > (v_def ->> 'max')::integer THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.reported_text: too_long';
            END IF;
            IF jsonb_typeof(v_x -> 'value') <> 'number' OR (v_x -> 'value')::text !~ '^(0|[1-9][0-9]{0,7})$'
               OR (v_x -> 'value')::text::integer > 10000000 THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.value: invalid';
            END IF;
          WHEN 'text_list' THEN
            IF jsonb_typeof(v_x -> 'entries') <> 'array' THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.entries: invalid';
            END IF;
            IF jsonb_array_length(v_x -> 'entries') < (v_def ->> 'min_entries')::integer THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.entries: empty';
            END IF;
            IF jsonb_array_length(v_x -> 'entries') > (v_def ->> 'max_entries')::integer THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.entries: too_many';
            END IF;
            v_list := '{}';
            FOR v_e IN SELECT e.v, e.ord - 1 AS idx FROM jsonb_array_elements(v_x -> 'entries') WITH ORDINALITY AS e(v, ord) LOOP
              v_rpath := v_path || '.content.entries[' || v_e.idx || ']';
              IF jsonb_typeof(v_e.v) <> 'string' THEN
                RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': not_text';
              END IF;
              v_s := v_e.v #>> '{}';
              IF public.evidence_normalize_v1(v_s) = '' THEN
                RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': blank';
              END IF;
              IF strpos(v_s, chr(0x001F)) > 0 THEN
                RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': forbidden_character';
              END IF;
              IF (v_def ->> 'whitespace') = 'none' AND translate(v_s, c_ws, '') <> v_s THEN
                RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': contains_whitespace';
              END IF;
              IF strpos(c_ws, left(v_s, 1)) > 0 OR strpos(c_ws, right(v_s, 1)) > 0 THEN
                RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': untrimmed';
              END IF;
              IF char_length(v_s) < (v_def ->> 'entry_min')::integer THEN
                RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': too_short';
              END IF;
              IF char_length(v_s) > (v_def ->> 'entry_max')::integer THEN
                RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': too_long';
              END IF;
              IF v_s = ANY (v_list) THEN
                RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': duplicate';
              END IF;
              v_list := array_append(v_list, v_s);
            END LOOP;
            -- PR-A1's own pattern, whose \s follows the database collation: an
            -- entry it would refuse is refused here, before any write.
            IF (v_c ->> 'field_key') = 'registration_ids'
               AND array_to_string(v_list, chr(31)) !~ '^[^\s\x1f]{3,50}(\x1f[^\s\x1f]{3,50})*$' THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.entries: contains_whitespace';
            END IF;
            IF (v_c ->> 'field_key') = 'time_points'
               AND array_to_string(v_list, chr(31)) !~ '^[^\s\x1f](?:[^\x1f]{0,98}[^\s\x1f])?(?:\x1f[^\s\x1f](?:[^\x1f]{0,98}[^\s\x1f])?)*$' THEN
              RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.content.entries: untrimmed';
            END IF;
        END CASE;
      END IF;

      -- References: shape only here; what they name is checked in phase 3.
      IF jsonb_typeof(v_c -> 'references') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.references: invalid';
      END IF;
      v_kept_seen := '{}';
      FOR v_j IN 0 .. jsonb_array_length(v_c -> 'references') - 1 LOOP
        v_r := v_c -> 'references' -> v_j;
        v_rpath := v_path || '.references[' || v_j || ']';
        IF jsonb_typeof(v_r) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': not_object';
        END IF;
        IF v_r ? 'anchor_id' THEN
          -- An existing reference, kept exactly as stored: its id and nothing else.
          IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_r) AS k(key) WHERE k.key <> 'anchor_id' AND k.key = ANY (c_server_keys)) THEN
            RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': server_attested';
          END IF;
          IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_r) AS k(key) WHERE k.key <> 'anchor_id') THEN
            RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': unknown_key';
          END IF;
          IF jsonb_typeof(v_r -> 'anchor_id') <> 'string' OR (v_r ->> 'anchor_id') !~ c_uuid THEN
            RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || '.anchor_id: invalid';
          END IF;
          IF (v_r ->> 'anchor_id')::uuid = ANY (v_kept_seen) THEN
            RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || '.anchor_id: duplicate';
          END IF;
          v_kept_seen := array_append(v_kept_seen, (v_r ->> 'anchor_id')::uuid);
          CONTINUE;
        END IF;
        IF jsonb_typeof(v_r -> 'purpose') IS DISTINCT FROM 'string'
           OR (v_r ->> 'purpose') NOT IN ('supports', 'examined', 'unavailable') THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || '.purpose: invalid';
        END IF;
        IF jsonb_typeof(v_r -> 'source_kind') IS DISTINCT FROM 'string'
           OR (v_r ->> 'source_kind') NOT IN ('abstract', 'full_text') THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || '.source_kind: invalid';
        END IF;
        v_purpose := v_r ->> 'purpose';
        v_kind := v_r ->> 'source_kind';
        -- The PR-A1 matrix (FK-PROOF-001 section J): what each purpose and kind carries.
        v_allowed := CASE
          WHEN v_purpose = 'supports' AND v_kind = 'abstract'
            THEN ARRAY['expected_match_count', 'occurrence', 'paper_id', 'purpose', 'quote_text', 'snapshot_id', 'source_kind']
          WHEN v_purpose IN ('supports', 'examined') AND v_kind = 'full_text'
            THEN ARRAY['locator_kind', 'locator_text', 'paper_id', 'purpose', 'source_kind']
          WHEN v_purpose = 'examined' AND v_kind = 'abstract'
            THEN ARRAY['paper_id', 'purpose', 'snapshot_id', 'source_kind']
          ELSE ARRAY['paper_id', 'purpose', 'source_kind']
        END;
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_r) AS k(key) WHERE k.key <> ALL (v_allowed) AND k.key = ANY (c_server_keys)) THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': server_attested';
        END IF;
        IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_r) k) IS DISTINCT FROM v_allowed THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': wrong_keys';
        END IF;
        IF jsonb_typeof(v_r -> 'paper_id') <> 'string' OR (v_r ->> 'paper_id') !~ c_uuid THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || '.paper_id: invalid';
        END IF;
        IF v_r ? 'snapshot_id' AND (jsonb_typeof(v_r -> 'snapshot_id') <> 'string' OR (v_r ->> 'snapshot_id') !~ c_uuid) THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || '.snapshot_id: invalid';
        END IF;
        IF v_r ? 'quote_text' THEN
          IF jsonb_typeof(v_r -> 'quote_text') <> 'string' THEN
            RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || '.quote_text: invalid';
          END IF;
          -- occurrence and expected_match_count: both null, or 1 <= k <= n.
          IF NOT (jsonb_typeof(v_r -> 'occurrence') = 'null' AND jsonb_typeof(v_r -> 'expected_match_count') = 'null')
             AND NOT (jsonb_typeof(v_r -> 'occurrence') = 'number' AND (v_r -> 'occurrence')::text ~ '^[1-9][0-9]{0,8}$'
                      AND jsonb_typeof(v_r -> 'expected_match_count') = 'number'
                      AND (v_r -> 'expected_match_count')::text ~ '^[1-9][0-9]{0,8}$'
                      AND (v_r -> 'occurrence')::text::integer <= (v_r -> 'expected_match_count')::text::integer) THEN
            RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || '.occurrence: invalid';
          END IF;
        END IF;
        IF v_r ? 'locator_kind' THEN
          IF v_purpose = 'examined' AND jsonb_typeof(v_r -> 'locator_kind') = 'null' AND jsonb_typeof(v_r -> 'locator_text') = 'null' THEN
            NULL;  -- an examined full text may name no location
          ELSIF jsonb_typeof(v_r -> 'locator_kind') IS DISTINCT FROM 'string'
                OR (v_r ->> 'locator_kind') NOT IN ('page', 'section', 'table', 'figure', 'paragraph', 'other') THEN
            RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || '.locator_kind: invalid';
          ELSIF jsonb_typeof(v_r -> 'locator_text') IS DISTINCT FROM 'string'
                OR char_length(v_r ->> 'locator_text') > 200
                OR public.evidence_normalize_v1(v_r ->> 'locator_text') = '' THEN
            RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || '.locator_text: invalid';
          END IF;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- Across the whole batch, whatever the order of its changes: no value change
  -- targets a group or outcome the batch removes, and every *_ref names one it
  -- adds.
  FOR v_i IN 0 .. v_n - 1 LOOP
    v_c := p_changes -> v_i;
    IF (v_c ->> 'op') IN ('set_value', 'clear_value') THEN
      IF (v_c -> 'target') ? 'arm_id' AND (v_c -> 'target' ->> 'arm_id')::uuid = ANY (v_removed_arms) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value',
          DETAIL = 'p_changes[' || v_i || '].target.arm_id: removed_in_batch';
      END IF;
      IF (v_c -> 'target') ? 'outcome_id' AND (v_c -> 'target' ->> 'outcome_id')::uuid = ANY (v_removed_outcomes) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value',
          DETAIL = 'p_changes[' || v_i || '].target.outcome_id: removed_in_batch';
      END IF;
      IF (v_c -> 'target') ? 'arm_ref' AND NOT ((v_c -> 'target' ->> 'arm_ref') = ANY (v_arm_refs)) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value',
          DETAIL = 'p_changes[' || v_i || '].target.arm_ref: unknown_ref';
      END IF;
      IF (v_c -> 'target') ? 'outcome_ref' AND NOT ((v_c -> 'target' ->> 'outcome_ref') = ANY (v_outcome_refs)) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value',
          DETAIL = 'p_changes[' || v_i || '].target.outcome_ref: unknown_ref';
      END IF;
    END IF;
  END LOOP;

  -- -- Phase 1: the request and the study ------------------------------------

  v_payload := sha256(convert_to(jsonb_build_object(
                 'op', 'save_changes',
                 'study_id', p_study_id,
                 'expected_version', p_expected_version,
                 'changes', p_changes)::text, 'UTF8'));

  PERFORM pg_advisory_xact_lock(20261016, hashtext(v_uid::text || ':' || p_request_id::text));

  SELECT e.op, e.payload_sha256, e.result INTO v_header
    FROM public.evidence_events e
   WHERE e.user_id = v_uid AND e.request_id = p_request_id AND e.ordinal = 0;
  IF FOUND THEN
    IF v_header.op = 'save_changes' AND v_header.payload_sha256 = v_payload THEN
      RETURN v_header.result || jsonb_build_object('status', 'replayed');
    END IF;
    RAISE EXCEPTION 'evidence_request_id_reused' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT s.design_profile, s.row_version INTO v_study
    FROM public.evidence_studies s
   WHERE s.id = p_study_id AND s.user_id = v_uid
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_study.row_version <> p_expected_version THEN
    RAISE EXCEPTION 'evidence_version_conflict' USING ERRCODE = 'raise_exception';
  END IF;

  -- -- Phase 2: groups and outcomes, in array order --------------------------

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_c := p_changes -> v_i;
    v_op := v_c ->> 'op';
    v_path := 'p_changes[' || v_i || ']';
    CONTINUE WHEN v_op NOT IN ('add_arm', 'update_arm', 'remove_arm', 'add_outcome', 'update_outcome', 'remove_outcome');
    v_label := v_c ->> 'display_label';
    v_pos := (v_c -> 'position')::text::integer;
    v_role := v_c ->> 'arm_role';

    IF v_op = 'add_arm' THEN
      -- Groups exist only in the intervention families (REQUIREMENTS-001 section F2).
      IF v_study.design_profile NOT IN ('rct_parallel', 'intervention_other') THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || ': not_allowed_for_design';
      END IF;
      INSERT INTO public.evidence_arms (user_id, study_id, arm_role, display_label, position)
      VALUES (v_uid, p_study_id, v_role, v_label, v_pos)
      RETURNING id INTO v_id;
      v_arm_map := v_arm_map || jsonb_build_object(v_c ->> 'ref', v_id);
      v_arm_written := true;
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'event_type', 'arm_added', 'target_id', v_id, 'field_key', NULL, 'before', NULL,
        'after', jsonb_build_object('arm_role', v_role, 'display_label', v_label, 'position', v_pos)));

    ELSIF v_op = 'add_outcome' THEN
      INSERT INTO public.evidence_outcomes (user_id, study_id, display_label, position)
      VALUES (v_uid, p_study_id, v_label, v_pos)
      RETURNING id INTO v_id;
      v_out_map := v_out_map || jsonb_build_object(v_c ->> 'ref', v_id);
      v_outcome_written := true;
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'event_type', 'outcome_added', 'target_id', v_id, 'field_key', NULL, 'before', NULL,
        'after', jsonb_build_object('display_label', v_label, 'position', v_pos)));

    ELSIF v_op IN ('update_arm', 'remove_arm') THEN
      v_id := (v_c ->> 'arm_id')::uuid;
      SELECT a.arm_role, a.display_label, a.position INTO v_row
        FROM public.evidence_arms a
       WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.id = v_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'evidence_target_not_found' USING ERRCODE = 'no_data_found', DETAIL = v_path || '.arm_id';
      END IF;
      IF v_op = 'update_arm' THEN
        v_before := '{}'::jsonb;
        v_after := '{}'::jsonb;
        IF v_row.arm_role <> v_role THEN
          v_before := v_before || jsonb_build_object('arm_role', v_row.arm_role);
          v_after := v_after || jsonb_build_object('arm_role', v_role);
          v_role_changed := array_append(v_role_changed, v_id);
          v_role_changed_at := array_append(v_role_changed_at, v_i);
        END IF;
        IF v_row.display_label <> v_label THEN
          v_before := v_before || jsonb_build_object('display_label', v_row.display_label);
          v_after := v_after || jsonb_build_object('display_label', v_label);
        END IF;
        IF v_row.position <> v_pos THEN
          v_before := v_before || jsonb_build_object('position', v_row.position);
          v_after := v_after || jsonb_build_object('position', v_pos);
        END IF;
        CONTINUE WHEN v_after = '{}'::jsonb;
        UPDATE public.evidence_arms a
           SET arm_role = v_role, display_label = v_label, position = v_pos, updated_at = now()
         WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.id = v_id;
        v_arm_written := true;
        v_events := v_events || jsonb_build_array(jsonb_build_object(
          'event_type', 'arm_updated', 'target_id', v_id, 'field_key', NULL, 'before', v_before, 'after', v_after));
      ELSE
        SELECT coalesce(jsonb_agg(jsonb_build_object('value_id', v.id, 'field_key', v.field_key,
                                                     'value_state', v.value_state, 'value_version', v.value_version)
                                  ORDER BY v.field_key COLLATE "C"), '[]'::jsonb)
          INTO v_vals
          FROM public.evidence_field_values v
         WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.arm_id = v_id;
        DELETE FROM public.evidence_field_anchors a
         WHERE a.user_id = v_uid AND a.study_id = p_study_id
           AND a.value_id IN (SELECT v.id FROM public.evidence_field_values v
                               WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.arm_id = v_id);
        DELETE FROM public.evidence_field_values v
         WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.arm_id = v_id;
        DELETE FROM public.evidence_arms a
         WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.id = v_id;
        v_arm_written := true;
        v_events := v_events || jsonb_build_array(jsonb_build_object(
          'event_type', 'arm_removed', 'target_id', v_id, 'field_key', NULL,
          'before', jsonb_build_object('arm_role', v_row.arm_role, 'display_label', v_row.display_label,
                                       'position', v_row.position, 'values', v_vals),
          'after', NULL));
      END IF;

    ELSE  -- update_outcome, remove_outcome
      v_id := (v_c ->> 'outcome_id')::uuid;
      SELECT o.display_label, o.position INTO v_row
        FROM public.evidence_outcomes o
       WHERE o.user_id = v_uid AND o.study_id = p_study_id AND o.id = v_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'evidence_target_not_found' USING ERRCODE = 'no_data_found', DETAIL = v_path || '.outcome_id';
      END IF;
      IF v_op = 'update_outcome' THEN
        v_before := '{}'::jsonb;
        v_after := '{}'::jsonb;
        IF v_row.display_label <> v_label THEN
          v_before := v_before || jsonb_build_object('display_label', v_row.display_label);
          v_after := v_after || jsonb_build_object('display_label', v_label);
        END IF;
        IF v_row.position <> v_pos THEN
          v_before := v_before || jsonb_build_object('position', v_row.position);
          v_after := v_after || jsonb_build_object('position', v_pos);
        END IF;
        CONTINUE WHEN v_after = '{}'::jsonb;
        UPDATE public.evidence_outcomes o
           SET display_label = v_label, position = v_pos, updated_at = now()
         WHERE o.user_id = v_uid AND o.study_id = p_study_id AND o.id = v_id;
        v_outcome_written := true;
        v_events := v_events || jsonb_build_array(jsonb_build_object(
          'event_type', 'outcome_updated', 'target_id', v_id, 'field_key', NULL, 'before', v_before, 'after', v_after));
      ELSE
        SELECT coalesce(jsonb_agg(jsonb_build_object('value_id', v.id, 'field_key', v.field_key,
                                                     'value_state', v.value_state, 'value_version', v.value_version)
                                  ORDER BY v.field_key COLLATE "C"), '[]'::jsonb)
          INTO v_vals
          FROM public.evidence_field_values v
         WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.outcome_id = v_id;
        DELETE FROM public.evidence_field_anchors a
         WHERE a.user_id = v_uid AND a.study_id = p_study_id
           AND a.value_id IN (SELECT v.id FROM public.evidence_field_values v
                               WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.outcome_id = v_id);
        DELETE FROM public.evidence_field_values v
         WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.outcome_id = v_id;
        DELETE FROM public.evidence_outcomes o
         WHERE o.user_id = v_uid AND o.study_id = p_study_id AND o.id = v_id;
        v_outcome_written := true;
        v_events := v_events || jsonb_build_array(jsonb_build_object(
          'event_type', 'outcome_removed', 'target_id', v_id, 'field_key', NULL,
          'before', jsonb_build_object('display_label', v_row.display_label, 'position', v_row.position,
                                       'values', v_vals),
          'after', NULL));
      END IF;
    END IF;
  END LOOP;

  -- -- Phase 3: every value change against the study, in array order ---------

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_c := p_changes -> v_i;
    v_op := v_c ->> 'op';
    CONTINUE WHEN v_op NOT IN ('set_value', 'clear_value');
    v_path := 'p_changes[' || v_i || ']';
    v_t := v_c -> 'target';
    v_def := c_fields -> (v_c ->> 'field_key');

    -- The target, by id or by the ref of a group or outcome this batch added.
    v_arm := NULL;
    v_outcome := NULL;
    IF v_t ? 'arm_ref' THEN
      v_arm := (v_arm_map ->> (v_t ->> 'arm_ref'))::uuid;
    ELSIF v_t ? 'arm_id' THEN
      v_arm := (v_t ->> 'arm_id')::uuid;
    ELSIF v_t ? 'outcome_ref' THEN
      v_outcome := (v_out_map ->> (v_t ->> 'outcome_ref'))::uuid;
    ELSIF v_t ? 'outcome_id' THEN
      v_outcome := (v_t ->> 'outcome_id')::uuid;
    END IF;
    IF v_arm IS NOT NULL THEN
      SELECT a.arm_role INTO v_role FROM public.evidence_arms a
       WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.id = v_arm;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'evidence_target_not_found' USING ERRCODE = 'no_data_found', DETAIL = v_path || '.target.arm_id';
      END IF;
      -- comparator_type applies to comparator groups only (section H4, section H6).
      IF v_def ? 'roles' AND v_op = 'set_value' AND NOT ((v_def -> 'roles') ? v_role) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.field_key: not_allowed_for_arm_role';
      END IF;
    END IF;
    IF v_outcome IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.evidence_outcomes o
          WHERE o.user_id = v_uid AND o.study_id = p_study_id AND o.id = v_outcome) THEN
      RAISE EXCEPTION 'evidence_target_not_found' USING ERRCODE = 'no_data_found', DETAIL = v_path || '.target.outcome_id';
    END IF;
    -- The number randomized exists only in the intervention families.
    IF v_def ? 'families' AND v_op = 'set_value' AND NOT ((v_def -> 'families') ? v_study.design_profile) THEN
      RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.field_key: not_allowed_for_design';
    END IF;

    -- The value as stored, and the version the caller saw.
    SELECT v.id, v.value_version INTO v_value
      FROM public.evidence_field_values v
     WHERE v.user_id = v_uid AND v.study_id = p_study_id
       AND v.arm_id IS NOT DISTINCT FROM v_arm AND v.outcome_id IS NOT DISTINCT FROM v_outcome
       AND v.field_key = (v_c ->> 'field_key');
    IF (v_value.id IS NULL) <> (jsonb_typeof(v_c -> 'expected_value_version') = 'null')
       OR (v_value.id IS NOT NULL AND v_value.value_version <> (v_c -> 'expected_value_version')::text::integer) THEN
      RAISE EXCEPTION 'evidence_version_conflict' USING ERRCODE = 'raise_exception', DETAIL = v_path || '.expected_value_version';
    END IF;
    CONTINUE WHEN v_op = 'clear_value';

    -- References: what they name, their counts, the current-copy rule.
    v_old := '{}';
    IF v_value.id IS NOT NULL THEN
      SELECT coalesce(array_agg(a ORDER BY a.id), '{}') INTO v_old
        FROM public.evidence_field_anchors a
       WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.value_id = v_value.id;
    END IF;
    v_supports := 0;
    v_examined := 0;
    v_unavail := 0;
    v_assess := '{}';
    FOR v_j IN 0 .. jsonb_array_length(v_c -> 'references') - 1 LOOP
      v_r := v_c -> 'references' -> v_j;
      v_rpath := v_path || '.references[' || v_j || ']';
      IF v_r ? 'anchor_id' THEN
        SELECT * INTO v_anchor FROM unnest(v_old) AS o WHERE o.id = (v_r ->> 'anchor_id')::uuid;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'evidence_target_not_found' USING ERRCODE = 'no_data_found', DETAIL = v_rpath || '.anchor_id';
        END IF;
        v_purpose := v_anchor.purpose;
        v_kind := v_anchor.source_kind;
        v_id := v_anchor.paper_id;
      ELSE
        v_purpose := v_r ->> 'purpose';
        v_kind := v_r ->> 'source_kind';
        v_id := (v_r ->> 'paper_id')::uuid;
        IF NOT EXISTS (SELECT 1 FROM public.evidence_study_reports l
                        WHERE l.user_id = v_uid AND l.study_id = p_study_id AND l.paper_id = v_id) THEN
          RAISE EXCEPTION 'evidence_link_not_found' USING ERRCODE = 'no_data_found', DETAIL = v_rpath || '.paper_id';
        END IF;
        IF v_r ? 'snapshot_id' THEN
          SELECT c.seq INTO v_seq FROM public.evidence_source_snapshots c
           WHERE c.user_id = v_uid AND c.study_id = p_study_id AND c.paper_id = v_id
             AND c.id = (v_r ->> 'snapshot_id')::uuid;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'evidence_target_not_found' USING ERRCODE = 'no_data_found', DETAIL = v_rpath || '.snapshot_id';
          END IF;
          -- A new quote or a new examined abstract names the CURRENT copy
          -- (001A section D1 R5), under the study row lock that rebase also takes.
          IF EXISTS (SELECT 1 FROM public.evidence_source_snapshots c
                      WHERE c.user_id = v_uid AND c.study_id = p_study_id AND c.paper_id = v_id AND c.seq > v_seq) THEN
            RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || '.snapshot_id: not_current';
          END IF;
          IF v_purpose = 'supports' THEN
            v_q_change := array_append(v_q_change, v_i);
            v_q_ref := array_append(v_q_ref, v_j);
            v_q_snap := array_append(v_q_snap, (v_r ->> 'snapshot_id')::uuid);
            v_q_text := array_append(v_q_text, v_r ->> 'quote_text');
            v_q_occ := array_append(v_q_occ, CASE WHEN jsonb_typeof(v_r -> 'occurrence') = 'number'
                                                  THEN (v_r -> 'occurrence')::text::integer END);
            v_q_seen := array_append(v_q_seen, CASE WHEN jsonb_typeof(v_r -> 'expected_match_count') = 'number'
                                                    THEN (v_r -> 'expected_match_count')::text::integer END);
          END IF;
        END IF;
      END IF;
      -- An unavailable abstract names a link with no copy - kept or new.
      IF v_purpose = 'unavailable' AND v_kind = 'abstract'
         AND EXISTS (SELECT 1 FROM public.evidence_source_snapshots c
                      WHERE c.user_id = v_uid AND c.study_id = p_study_id AND c.paper_id = v_id) THEN
        RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': unavailable_abstract_has_copy';
      END IF;
      IF v_purpose = 'supports' THEN
        v_supports := v_supports + 1;
      ELSE
        IF (v_id::text || '|' || v_kind) = ANY (v_assess) THEN
          RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': duplicate_assessment';
        END IF;
        v_assess := array_append(v_assess, v_id::text || '|' || v_kind);
        IF v_purpose = 'examined' THEN v_examined := v_examined + 1; ELSE v_unavail := v_unavail + 1; END IF;
      END IF;
    END LOOP;
    v_problems := public.evidence_state_reference_problems(v_c ->> 'value_state', v_supports, v_examined, v_unavail);
    IF cardinality(v_problems) > 0 THEN
      RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value',
        DETAIL = v_path || '.references: ' || array_to_string(v_problems, ',');
    END IF;
    IF v_examined + v_unavail > 10 THEN
      RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_path || '.references: too_many_assessments';
    END IF;
  END LOOP;

  -- -- Phase 4: server-side quote matching -----------------------------------
  -- One locate call per copy: the copy is normalized once for all its quotes.
  -- Refusals are then reported in (change, reference) order.

  v_count := coalesce(cardinality(v_q_text), 0);
  v_q_status := array_fill(NULL::text, ARRAY[v_count]);
  v_q_start := array_fill(NULL::integer, ARRAY[v_count]);
  v_q_end := array_fill(NULL::integer, ARRAY[v_count]);
  v_q_occn := array_fill(NULL::integer, ARRAY[v_count]);
  v_q_count := array_fill(NULL::integer, ARRAY[v_count]);
  SELECT coalesce(array_agg(s.snap ORDER BY s.first_at), '{}') INTO v_snaps
    FROM (SELECT u.snap, min(u.at) AS first_at FROM unnest(v_q_snap) WITH ORDINALITY AS u(snap, at) GROUP BY u.snap) s;
  FOREACH v_snap IN ARRAY v_snaps LOOP
    SELECT array_agg(u.at::integer ORDER BY u.at), array_agg(v_q_text[u.at::integer] ORDER BY u.at) INTO v_idx, v_quotes
      FROM unnest(v_q_snap) WITH ORDINALITY AS u(snap, at)
     WHERE u.snap = v_snap;
    SELECT c.exact_text INTO v_s FROM public.evidence_source_snapshots c
     WHERE c.user_id = v_uid AND c.study_id = p_study_id AND c.id = v_snap;
    FOR v_m IN SELECT * FROM public.evidence_locate_quote(v_quotes, v_s) LOOP
      v_q := v_idx[v_m.ord];
      v_q_status[v_q] := v_m.status;
      v_q_count[v_q] := v_m.match_count;
      IF v_m.status IN ('unique', 'multiple') THEN
        -- One occurrence may be implied; several must be named, with the
        -- count the caller saw, which must be the server's count.
        IF v_q_occ[v_q] IS NULL AND v_m.match_count = 1 THEN
          v_q_occn[v_q] := 1;
        ELSIF v_q_occ[v_q] IS NOT NULL AND v_q_seen[v_q] = v_m.match_count AND v_q_occ[v_q] <= v_m.match_count THEN
          v_q_occn[v_q] := v_q_occ[v_q];
        ELSE
          v_q_status[v_q] := 'ambiguous';
        END IF;
        IF v_q_occn[v_q] IS NOT NULL THEN
          v_q_start[v_q] := v_m.starts[v_q_occn[v_q]];
          v_q_end[v_q] := v_m.starts[v_q_occn[v_q]] + v_m.normalized_length;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  FOR v_q IN 1 .. v_count LOOP
    v_rpath := 'p_changes[' || v_q_change[v_q] || '].references[' || v_q_ref[v_q] || '].quote_text';
    IF v_q_status[v_q] = 'invalid' THEN
      RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = v_rpath || ': invalid';
    ELSIF v_q_status[v_q] = 'not_found' THEN
      RAISE EXCEPTION 'evidence_quote_not_found' USING ERRCODE = 'raise_exception', DETAIL = v_rpath;
    ELSIF v_q_status[v_q] IN ('ambiguous', 'too_many') THEN
      RAISE EXCEPTION 'evidence_quote_ambiguous' USING ERRCODE = 'raise_exception', DETAIL = v_rpath;
    ELSIF v_q_status[v_q] IS DISTINCT FROM 'unique' AND v_q_status[v_q] IS DISTINCT FROM 'multiple' THEN
      RAISE EXCEPTION 'evidence_internal_invariant' USING ERRCODE = 'internal_error';
    END IF;
  END LOOP;

  -- -- Phase 5: write the values, in array order -----------------------------

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_c := p_changes -> v_i;
    v_op := v_c ->> 'op';
    CONTINUE WHEN v_op NOT IN ('set_value', 'clear_value');
    v_t := v_c -> 'target';
    v_def := c_fields -> (v_c ->> 'field_key');
    v_arm := CASE WHEN v_t ? 'arm_ref' THEN (v_arm_map ->> (v_t ->> 'arm_ref'))::uuid
                  WHEN v_t ? 'arm_id' THEN (v_t ->> 'arm_id')::uuid END;
    v_outcome := CASE WHEN v_t ? 'outcome_ref' THEN (v_out_map ->> (v_t ->> 'outcome_ref'))::uuid
                      WHEN v_t ? 'outcome_id' THEN (v_t ->> 'outcome_id')::uuid END;
    SELECT v.* INTO v_value
      FROM public.evidence_field_values v
     WHERE v.user_id = v_uid AND v.study_id = p_study_id
       AND v.arm_id IS NOT DISTINCT FROM v_arm AND v.outcome_id IS NOT DISTINCT FROM v_outcome
       AND v.field_key = (v_c ->> 'field_key');

    IF v_op = 'clear_value' THEN
      v_before := public.evidence_value_digest(v_uid, v_value.id);
      DELETE FROM public.evidence_field_anchors a
       WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.value_id = v_value.id;
      DELETE FROM public.evidence_field_values v
       WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.id = v_value.id;
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'event_type', 'value_cleared', 'target_id', v_value.id, 'field_key', v_c ->> 'field_key',
        'before', v_before, 'after', NULL));
      CONTINUE;
    END IF;

    -- The new content, exactly as sent: nothing is trimmed or rewritten.
    v_x := v_c -> 'content';
    v_new_text := NULL;
    v_new_code := NULL;
    v_new_int := NULL;
    v_new_list := NULL;
    IF (v_c ->> 'value_state') = 'reported' THEN
      CASE v_def ->> 'shape'
        WHEN 'text' THEN v_new_text := v_x ->> 'text';
        WHEN 'code' THEN v_new_code := v_x ->> 'code';
        WHEN 'integer_with_reported_text' THEN
          v_new_text := v_x ->> 'reported_text';
          v_new_int := (v_x -> 'value')::text::integer;
        WHEN 'text_list' THEN
          SELECT array_agg(e.v ORDER BY e.ord) INTO v_new_list
            FROM jsonb_array_elements_text(v_x -> 'entries') WITH ORDINALITY AS e(v, ord);
      END CASE;
    END IF;
    v_new_reason := v_c ->> 'state_reason';
    v_new_note := v_c ->> 'note';

    -- The reference list: kept ids in order, and whether anything differs.
    v_kept_ids := '{}';
    v_refs_changed := false;
    FOR v_j IN 0 .. jsonb_array_length(v_c -> 'references') - 1 LOOP
      v_r := v_c -> 'references' -> v_j;
      IF v_r ? 'anchor_id' THEN
        v_kept_ids := array_append(v_kept_ids, (v_r ->> 'anchor_id')::uuid);
      ELSE
        v_refs_changed := true;
      END IF;
    END LOOP;
    IF v_value.id IS NOT NULL THEN
      -- Removed references, or supporting references in a different order.
      SELECT coalesce(array_agg(a.id ORDER BY a.id), '{}') INTO v_kept_old
        FROM public.evidence_field_anchors a
       WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.value_id = v_value.id;
      IF v_kept_old IS DISTINCT FROM (SELECT coalesce(array_agg(k ORDER BY k), '{}') FROM unnest(v_kept_ids) k) THEN
        v_refs_changed := true;
      END IF;
      IF (SELECT coalesce(array_agg(a.id ORDER BY a.position), '{}') FROM public.evidence_field_anchors a
           WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.value_id = v_value.id AND a.purpose = 'supports')
         IS DISTINCT FROM
         (SELECT coalesce(array_agg(k.id ORDER BY k.ord), '{}')
            FROM unnest(v_kept_ids) WITH ORDINALITY AS k(id, ord)
            JOIN public.evidence_field_anchors a ON a.id = k.id AND a.user_id = v_uid AND a.purpose = 'supports') THEN
        v_refs_changed := true;
      END IF;
      v_content_changed := v_value.value_state IS DISTINCT FROM (v_c ->> 'value_state')
        OR v_value.state_reason IS DISTINCT FROM v_new_reason
        OR v_value.value_text IS DISTINCT FROM v_new_text
        OR v_value.value_code IS DISTINCT FROM v_new_code
        OR v_value.value_int IS DISTINCT FROM v_new_int
        OR v_value.value_list IS DISTINCT FROM v_new_list
        OR v_value.note IS DISTINCT FROM v_new_note;
      -- Nothing differs: this change writes nothing and records nothing.
      CONTINUE WHEN NOT v_content_changed AND NOT v_refs_changed;
      v_before := public.evidence_value_digest(v_uid, v_value.id);
      -- Any change returns the value to unreviewed (001 section J2, section H7).
      UPDATE public.evidence_field_values v
         SET value_state = v_c ->> 'value_state', state_reason = v_new_reason,
             value_text = v_new_text, value_code = v_new_code, value_int = v_new_int, value_list = v_new_list,
             note = v_new_note,
             review_status = 'unreviewed', review_reason = NULL, review_note = NULL,
             reviewed_at = NULL, reviewed_version = NULL,
             value_version = v.value_version + 1, updated_at = now()
       WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.id = v_value.id;
      v_id := v_value.id;
    ELSE
      v_before := NULL;
      INSERT INTO public.evidence_field_values
        (user_id, study_id, arm_id, outcome_id, field_key, value_state, state_reason,
         value_text, value_code, value_int, value_list, note)
      VALUES (v_uid, p_study_id, v_arm, v_outcome, v_c ->> 'field_key', v_c ->> 'value_state', v_new_reason,
              v_new_text, v_new_code, v_new_int, v_new_list, v_new_note)
      RETURNING id INTO v_id;
      v_value_inserted := true;
      v_refs_changed := jsonb_array_length(v_c -> 'references') > 0;
    END IF;

    -- Rewrite the references when they changed: kept rows return with their
    -- id, quote, match columns and times untouched (only a supporting
    -- reference's position follows its new order); new rows get the server's
    -- match.
    IF v_refs_changed THEN
      SELECT coalesce(array_agg(a ORDER BY a.id), '{}') INTO v_old
        FROM public.evidence_field_anchors a
       WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.value_id = v_id;
      DELETE FROM public.evidence_field_anchors a
       WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.value_id = v_id;
      v_pos := 0;
      FOR v_j IN 0 .. jsonb_array_length(v_c -> 'references') - 1 LOOP
        v_r := v_c -> 'references' -> v_j;
        IF v_r ? 'anchor_id' THEN
          SELECT * INTO v_anchor FROM unnest(v_old) AS o WHERE o.id = (v_r ->> 'anchor_id')::uuid;
          IF v_anchor.purpose = 'supports' THEN
            v_anchor.position := v_pos;
            v_pos := v_pos + 1;
          END IF;
          INSERT INTO public.evidence_field_anchors SELECT (v_anchor).*;
        ELSE
          v_purpose := v_r ->> 'purpose';
          v_kind := v_r ->> 'source_kind';
          v_q := NULL;
          IF v_purpose = 'supports' AND v_kind = 'abstract' THEN
            SELECT u.at INTO v_q
              FROM unnest(v_q_change, v_q_ref) WITH ORDINALITY AS u(ch, rf, at)
             WHERE u.ch = v_i AND u.rf = v_j;
          END IF;
          INSERT INTO public.evidence_field_anchors
            (user_id, study_id, value_id, paper_id, snapshot_id, purpose, source_kind, position,
             quote_text, match_start, match_end, match_occurrence, match_count, normalization_version, matched_at,
             locator_kind, locator_text)
          VALUES (v_uid, p_study_id, v_id, (v_r ->> 'paper_id')::uuid, (v_r ->> 'snapshot_id')::uuid,
                  v_purpose, v_kind, CASE WHEN v_purpose = 'supports' THEN v_pos END,
                  CASE WHEN v_q IS NOT NULL THEN v_r ->> 'quote_text' END,
                  v_q_start[v_q], v_q_end[v_q], v_q_occn[v_q], v_q_count[v_q],
                  CASE WHEN v_q IS NOT NULL THEN 'v1' END, CASE WHEN v_q IS NOT NULL THEN now() END,
                  v_r ->> 'locator_kind', v_r ->> 'locator_text');
          IF v_purpose = 'supports' THEN
            v_pos := v_pos + 1;
          END IF;
        END IF;
      END LOOP;
    END IF;

    v_after := public.evidence_value_digest(v_uid, v_id);
    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'event_type', 'value_saved', 'target_id', v_id, 'field_key', v_c ->> 'field_key',
      'before', v_before, 'after', v_after));
  END LOOP;

  -- -- Phase 6: the final state of the batch ---------------------------------

  -- A group whose role changed away from comparator keeps no comparator_type.
  FOR v_q IN 1 .. coalesce(cardinality(v_role_changed), 0) LOOP
    IF EXISTS (SELECT 1 FROM public.evidence_field_values v
                 JOIN public.evidence_arms a ON a.user_id = v.user_id AND a.study_id = v.study_id AND a.id = v.arm_id
                WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.arm_id = v_role_changed[v_q]
                  AND v.field_key = 'comparator_type' AND a.arm_role <> 'comparator') THEN
      RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value',
        DETAIL = 'p_changes[' || v_role_changed_at[v_q] || ']: comparator_type_present';
    END IF;
  END LOOP;
  -- Positions order the groups, and the outcomes, without ties.
  IF v_arm_written AND EXISTS (SELECT 1 FROM public.evidence_arms a WHERE a.user_id = v_uid AND a.study_id = p_study_id
                                GROUP BY a.position HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_changes: duplicate_arm_position';
  END IF;
  IF v_outcome_written AND EXISTS (SELECT 1 FROM public.evidence_outcomes o WHERE o.user_id = v_uid AND o.study_id = p_study_id
                                    GROUP BY o.position HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_changes: duplicate_outcome_position';
  END IF;
  -- Draft PR-A3 limits, exact under the study row lock.
  IF v_arm_written AND (SELECT count(*) FROM public.evidence_arms a WHERE a.user_id = v_uid AND a.study_id = p_study_id) > 20 THEN
    RAISE EXCEPTION 'evidence_arm_limit' USING ERRCODE = 'raise_exception';
  END IF;
  IF v_outcome_written AND (SELECT count(*) FROM public.evidence_outcomes o WHERE o.user_id = v_uid AND o.study_id = p_study_id) > 50 THEN
    RAISE EXCEPTION 'evidence_outcome_limit' USING ERRCODE = 'raise_exception';
  END IF;
  IF v_value_inserted AND (SELECT count(*) FROM public.evidence_field_values v WHERE v.user_id = v_uid AND v.study_id = p_study_id) > 400 THEN
    RAISE EXCEPTION 'evidence_value_limit' USING ERRCODE = 'raise_exception';
  END IF;

  -- -- Phase 7: history, the header and the new version ----------------------

  IF jsonb_array_length(v_events) = 0 THEN
    RETURN jsonb_build_object('status', 'unchanged', 'study_id', p_study_id, 'study_version', v_study.row_version,
                              'arm_ids', '{}'::jsonb, 'outcome_ids', '{}'::jsonb);
  END IF;

  IF (SELECT count(*) FROM public.evidence_events e WHERE e.user_id = v_uid AND e.study_id = p_study_id)
     + 1 + jsonb_array_length(v_events) > 5000 THEN
    RAISE EXCEPTION 'evidence_history_limit' USING ERRCODE = 'raise_exception';
  END IF;

  v_version := v_study.row_version + 1;
  UPDATE public.evidence_studies s
     SET row_version = v_version, updated_at = now()
   WHERE s.id = p_study_id AND s.user_id = v_uid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'evidence_internal_invariant' USING ERRCODE = 'internal_error';
  END IF;

  v_result := jsonb_build_object('status', 'applied', 'study_id', p_study_id, 'study_version', v_version,
                                 'arm_ids', v_arm_map, 'outcome_ids', v_out_map);

  INSERT INTO public.evidence_events
    (user_id, study_id, study_version, ordinal, event_type, request_id,
     op, payload_sha256, result, target_id, field_key, before, after)
  SELECT v_uid, p_study_id, v_version, 0, 'request', p_request_id,
         'save_changes', v_payload, v_result, NULL, NULL, NULL, NULL
  UNION ALL
  SELECT v_uid, p_study_id, v_version, e.ord::integer, e.v ->> 'event_type', p_request_id,
         NULL, NULL, NULL, (e.v ->> 'target_id')::uuid, e.v ->> 'field_key',
         NULLIF(e.v -> 'before', 'null'::jsonb), NULLIF(e.v -> 'after', 'null'::jsonb)
    FROM jsonb_array_elements(v_events) WITH ORDINALITY AS e(v, ord);

  RETURN v_result;
END
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. evidence_review_fields — Confirm or Flag one value at one version
-- ═════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION public.evidence_review_fields(
    p_study_id               uuid,
    p_expected_version       integer,
    p_value_id               uuid,
    p_expected_value_version integer,
    p_action                 text,
    p_note                   text,
    p_request_id             uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_payload  bytea;
  v_header   record;
  v_current  integer;
  v_value    record;
  v_refs     record;
  v_problems text[];
  v_blocks   text[] := '{}';
  v_block    text;
  v_min      integer;
  v_before   jsonb;
  v_after    jsonb;
  v_status   text;
  v_event    text;
  v_version  integer;
  v_count    integer;
  v_result   jsonb;
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
  IF p_value_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_value_id';
  END IF;
  IF p_expected_value_version IS NULL OR p_expected_value_version < 1 THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_expected_value_version';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('confirm', 'flag') THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_action';
  END IF;
  -- Flag needs a note of at least 3 characters (PR-A1 review_note_check);
  -- Confirm takes an optional one. Neither may be blank after v1.
  IF (p_action = 'flag' AND p_note IS NULL)
     OR (p_note IS NOT NULL AND (char_length(p_note) > 2000 OR public.evidence_normalize_v1(p_note) = ''
                                 OR char_length(btrim(p_note)) < (CASE WHEN p_action = 'flag' THEN 3 ELSE 1 END))) THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_note';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_request_id';
  END IF;

  v_payload := sha256(convert_to(jsonb_build_object(
                 'op', 'review_fields',
                 'study_id', p_study_id,
                 'expected_version', p_expected_version,
                 'value_id', p_value_id,
                 'expected_value_version', p_expected_value_version,
                 'action', p_action,
                 'note', p_note)::text, 'UTF8'));

  PERFORM pg_advisory_xact_lock(20261016, hashtext(v_uid::text || ':' || p_request_id::text));

  SELECT e.op, e.payload_sha256, e.result INTO v_header
    FROM public.evidence_events e
   WHERE e.user_id = v_uid AND e.request_id = p_request_id AND e.ordinal = 0;
  IF FOUND THEN
    IF v_header.op = 'review_fields' AND v_header.payload_sha256 = v_payload THEN
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

  SELECT v.* INTO v_value
    FROM public.evidence_field_values v
   WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.id = p_value_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence_target_not_found' USING ERRCODE = 'no_data_found', DETAIL = 'p_value_id';
  END IF;
  -- The review binds this exact version: "This field changed since you opened it."
  IF v_value.value_version <> p_expected_value_version THEN
    RAISE EXCEPTION 'evidence_version_conflict' USING ERRCODE = 'raise_exception', DETAIL = 'p_expected_value_version';
  END IF;

  IF p_action = 'confirm' THEN
    -- This version is already confirmed, with this note: nothing to do (001A section I5).
    IF v_value.review_status = 'user_reviewed' AND v_value.reviewed_version = v_value.value_version
       AND v_value.review_note IS NOT DISTINCT FROM p_note THEN
      RETURN jsonb_build_object('status', 'unchanged', 'study_id', p_study_id, 'study_version', v_current,
                                'value_id', p_value_id, 'value_version', v_value.value_version,
                                'review_status', v_value.review_status);
    END IF;

    -- The references, and whether each is current: a quote on its link's
    -- highest-seq copy, an examined abstract that IS that copy.
    SELECT count(*) FILTER (WHERE a.purpose = 'supports') AS supports,
           count(*) FILTER (WHERE a.purpose = 'examined') AS examined,
           count(*) FILTER (WHERE a.purpose = 'unavailable') AS unavailable,
           count(*) FILTER (WHERE a.purpose <> 'unavailable') AS basis,
           coalesce(bool_or(a.purpose = 'examined'), false) AS any_examined,
           coalesce(bool_or(a.purpose = 'supports'
                            AND (a.source_kind = 'full_text' OR a.snapshot_id = cur.id)), false) AS current_support,
           coalesce(bool_or(a.purpose = 'examined' AND a.source_kind = 'abstract'
                            AND a.snapshot_id IS DISTINCT FROM cur.id), false) AS examined_stale,
           coalesce(bool_or(a.purpose = 'unavailable' AND a.source_kind = 'abstract'
                            AND cur.id IS NOT NULL), false) AS unavailable_has_copy
      INTO v_refs
      FROM public.evidence_field_anchors a
      LEFT JOIN LATERAL (
        SELECT c.id FROM public.evidence_source_snapshots c
         WHERE c.user_id = a.user_id AND c.study_id = a.study_id AND c.paper_id = a.paper_id
         ORDER BY c.seq DESC LIMIT 1) cur ON true
     WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.value_id = p_value_id;

    -- Confirm's preconditions, as PR-B's checkConfirm states them and in its
    -- order (src/lib/evidence/review.ts). section J first, through the shared rule.
    v_problems := public.evidence_state_reference_problems(
                    v_value.value_state, v_refs.supports::integer, v_refs.examined::integer, v_refs.unavailable::integer);
    FOREACH v_block IN ARRAY v_problems LOOP
      v_block := CASE v_block
        WHEN 'examined_required'    THEN 'examined_source_missing'
        WHEN 'basis_required'       THEN 'unclear_source_missing'
        WHEN 'unavailable_required' THEN 'unavailable_source_missing'
        ELSE 'sources_not_allowed' END;
      IF NOT (v_block = ANY (v_blocks)) THEN
        v_blocks := array_append(v_blocks, v_block);
      END IF;
    END LOOP;
    IF v_value.value_state = 'reported' AND NOT v_refs.current_support THEN
      v_blocks := array_append(v_blocks, 'no_current_support');
    END IF;
    -- 001A's amendment to 001 section J1 (PO decision 1): only current-copy quotes
    -- count; an examined source always does.
    IF v_value.value_state = 'unclear' AND v_refs.basis > 0
       AND NOT (v_refs.any_examined OR v_refs.current_support) THEN
      v_blocks := array_append(v_blocks, 'unclear_source_not_current');
    END IF;
    IF v_refs.examined_stale THEN
      v_blocks := array_append(v_blocks, 'examined_abstract_not_current');
    END IF;
    IF v_refs.unavailable_has_copy THEN
      v_blocks := array_append(v_blocks, 'unavailable_abstract_has_copy');
    END IF;
    IF v_value.value_state = 'reported' AND v_value.field_key IN ('n_randomized', 'n_enrolled')
       AND v_value.value_int IS NULL THEN
      v_blocks := array_append(v_blocks, 'count_not_confirmed');
    END IF;
    IF v_value.value_state = 'unclear' AND v_value.state_reason IS NULL THEN
      v_blocks := array_append(v_blocks, 'state_reason_missing');
    END IF;
    v_min := CASE v_value.value_state WHEN 'unclear' THEN 10 WHEN 'not_applicable' THEN 3 ELSE 0 END;
    IF v_min > 0 AND (v_value.note IS NULL OR public.evidence_normalize_v1(v_value.note) = ''
                      OR char_length(btrim(v_value.note)) < v_min) THEN
      v_blocks := array_append(v_blocks, 'note_missing');
    END IF;
    IF cardinality(v_blocks) > 0 THEN
      RAISE EXCEPTION 'evidence_confirm_blocked' USING ERRCODE = 'raise_exception',
        DETAIL = array_to_string(v_blocks, ',');
    END IF;
    v_status := 'user_reviewed';
    v_event := 'review_confirmed';
  ELSE
    IF v_value.review_status = 'disputed' AND v_value.review_note IS NOT DISTINCT FROM p_note THEN
      RETURN jsonb_build_object('status', 'unchanged', 'study_id', p_study_id, 'study_version', v_current,
                                'value_id', p_value_id, 'value_version', v_value.value_version,
                                'review_status', v_value.review_status);
    END IF;
    v_status := 'disputed';
    v_event := 'review_flagged';
  END IF;

  IF (SELECT count(*) FROM public.evidence_events e WHERE e.user_id = v_uid AND e.study_id = p_study_id) > 5000 - 2 THEN
    RAISE EXCEPTION 'evidence_history_limit' USING ERRCODE = 'raise_exception';
  END IF;

  v_before := public.evidence_value_digest(v_uid, p_value_id);
  -- The review is the user's act; its time and version are the server's.
  UPDATE public.evidence_field_values v
     SET review_status = v_status,
         review_reason = NULL,
         review_note = p_note,
         reviewed_at = CASE WHEN v_status = 'user_reviewed' THEN now() END,
         reviewed_version = CASE WHEN v_status = 'user_reviewed' THEN v.value_version END,
         updated_at = now()
   WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.id = p_value_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'evidence_internal_invariant' USING ERRCODE = 'internal_error';
  END IF;
  v_after := public.evidence_value_digest(v_uid, p_value_id);

  v_version := v_current + 1;
  UPDATE public.evidence_studies s
     SET row_version = v_version, updated_at = now()
   WHERE s.id = p_study_id AND s.user_id = v_uid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'evidence_internal_invariant' USING ERRCODE = 'internal_error';
  END IF;

  v_result := jsonb_build_object('status', 'applied', 'study_id', p_study_id, 'study_version', v_version,
                                 'value_id', p_value_id, 'value_version', v_value.value_version,
                                 'review_status', v_status);

  INSERT INTO public.evidence_events
    (user_id, study_id, study_version, ordinal, event_type, request_id,
     op, payload_sha256, result, target_id, field_key, before, after)
  VALUES
    (v_uid, p_study_id, v_version, 0, 'request', p_request_id,
     'review_fields', v_payload, v_result, NULL, NULL, NULL, NULL),
    (v_uid, p_study_id, v_version, 1, v_event, p_request_id,
     NULL, NULL, NULL, p_value_id, v_value.field_key, v_before, v_after);

  RETURN v_result;
END
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 7. evidence_rebase_source — save a new copy of a linked paper's abstract
-- ═════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION public.evidence_rebase_source(
    p_study_id                 uuid,
    p_paper_id                 uuid,
    p_expected_version         integer,
    p_expected_abstract_sha256 text,
    p_request_id               uuid)
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
  v_current    integer;
  v_abstract   text;
  v_normalized text;
  v_prev       record;
  v_copies     integer;
  v_seq        integer;
  v_new_id     uuid;
  v_exact_sha  bytea;
  v_norm_sha   bytea;
  v_ids        uuid[];
  v_quotes     text[];
  v_m          record;
  v_anchor     record;
  v_val        record;
  v_digests    jsonb := '{}'::jsonb;
  v_moved      uuid[] := '{}';
  v_to         text;
  v_events     jsonb := '[]'::jsonb;
  v_rematched  integer := 0;
  v_not_found  integer := 0;
  v_ambiguous  integer := 0;
  v_rereview   integer := 0;
  v_changed    integer := 0;
  v_version    integer;
  v_count      integer;
  v_result     jsonb;
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
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_expected_version';
  END IF;
  -- The SHA-256 of the UTF-8 bytes of the abstract the caller displayed.
  IF p_expected_abstract_sha256 IS NULL OR p_expected_abstract_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_expected_abstract_sha256';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value', DETAIL = 'p_request_id';
  END IF;

  v_payload := sha256(convert_to(jsonb_build_object(
                 'op', 'rebase_source',
                 'study_id', p_study_id,
                 'paper_id', p_paper_id,
                 'expected_version', p_expected_version,
                 'expected_abstract_sha256', p_expected_abstract_sha256)::text, 'UTF8'));

  PERFORM pg_advisory_xact_lock(20261016, hashtext(v_uid::text || ':' || p_request_id::text));

  SELECT e.op, e.payload_sha256, e.result INTO v_header
    FROM public.evidence_events e
   WHERE e.user_id = v_uid AND e.request_id = p_request_id AND e.ordinal = 0;
  IF FOUND THEN
    IF v_header.op = 'rebase_source' AND v_header.payload_sha256 = v_payload THEN
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

  IF NOT EXISTS (SELECT 1 FROM public.evidence_study_reports r
                  WHERE r.user_id = v_uid AND r.study_id = p_study_id AND r.paper_id = p_paper_id) THEN
    RAISE EXCEPTION 'evidence_link_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  -- A fresh read of the caller's paper. FOR SHARE: an edit or merge already in
  -- flight finishes first, and one that starts now waits for this commit.
  SELECT p.abstract INTO v_abstract
    FROM public.papers p
   WHERE p.id = p_paper_id AND p.user_id = v_uid
     FOR SHARE;
  IF NOT FOUND THEN
    -- The link's NO ACTION key keeps a linked paper in place.
    RAISE EXCEPTION 'evidence_internal_invariant' USING ERRCODE = 'internal_error';
  END IF;
  -- The user must have seen exactly the text being saved (001A section E3).
  IF v_abstract IS NULL
     OR encode(sha256(convert_to(v_abstract, 'UTF8')), 'hex') <> p_expected_abstract_sha256 THEN
    RAISE EXCEPTION 'evidence_source_changed_again' USING ERRCODE = 'raise_exception';
  END IF;
  IF char_length(v_abstract) > 50000 THEN
    RAISE EXCEPTION 'evidence_abstract_too_long' USING ERRCODE = 'raise_exception';
  END IF;
  v_normalized := public.evidence_normalize_v1(v_abstract);
  IF v_normalized = '' THEN
    RAISE EXCEPTION 'evidence_invalid_input' USING ERRCODE = 'invalid_parameter_value',
      DETAIL = 'p_expected_abstract_sha256: source_empty';
  END IF;

  SELECT c.id, c.seq, c.exact_text INTO v_prev
    FROM public.evidence_source_snapshots c
   WHERE c.user_id = v_uid AND c.study_id = p_study_id AND c.paper_id = p_paper_id
   ORDER BY c.seq DESC
   LIMIT 1;
  -- The same text as the current copy, byte for byte: nothing to save.
  IF v_prev.id IS NOT NULL AND convert_to(v_prev.exact_text, 'UTF8') = convert_to(v_abstract, 'UTF8') THEN
    RETURN jsonb_build_object('status', 'unchanged', 'study_id', p_study_id, 'study_version', v_current,
                              'paper_id', p_paper_id, 'snapshot_id', v_prev.id, 'previous_snapshot_id', NULL::uuid,
                              'seq', v_prev.seq, 'rematched', 0, 'not_found', 0, 'ambiguous', 0, 'needs_rereview', 0);
  END IF;

  SELECT count(*) INTO v_copies
    FROM public.evidence_source_snapshots c
   WHERE c.user_id = v_uid AND c.study_id = p_study_id AND c.paper_id = p_paper_id;
  IF v_copies >= 20 THEN
    RAISE EXCEPTION 'evidence_snapshot_limit' USING ERRCODE = 'raise_exception';
  END IF;

  -- Every value that depends on this link's abstract, as it was (FK-PROOF-001
  -- section J: any abstract reference on the link, whatever its copy or purpose).
  FOR v_val IN
    SELECT v.id FROM public.evidence_field_values v
     WHERE v.user_id = v_uid AND v.study_id = p_study_id
       AND EXISTS (SELECT 1 FROM public.evidence_field_anchors a
                    WHERE a.user_id = v.user_id AND a.study_id = v.study_id AND a.value_id = v.id
                      AND a.paper_id = p_paper_id AND a.source_kind = 'abstract')
  LOOP
    v_digests := v_digests || jsonb_build_object(v_val.id::text, public.evidence_value_digest(v_uid, v_val.id));
  END LOOP;

  -- The new copy. Copies are never updated: the earlier ones stay, superseded.
  v_seq := coalesce(v_prev.seq, 0) + 1;
  v_exact_sha := sha256(convert_to(v_abstract, 'UTF8'));
  v_norm_sha := sha256(convert_to(v_normalized, 'UTF8'));
  INSERT INTO public.evidence_source_snapshots
    (user_id, study_id, paper_id, seq, source_kind, exact_text, exact_sha256,
     normalized_sha256, normalization_version, char_count)
  VALUES (v_uid, p_study_id, p_paper_id, v_seq, 'library_abstract', v_abstract, v_exact_sha,
          v_norm_sha, 'v1', char_length(v_abstract))
  RETURNING id INTO v_new_id;
  v_events := v_events || jsonb_build_array(jsonb_build_object(
    'event_type', 'source_captured', 'target_id', v_new_id, 'field_key', NULL, 'before', NULL,
    'after', jsonb_build_object('paper_id', p_paper_id, 'seq', v_seq, 'source_kind', 'library_abstract',
                                'exact_sha256', encode(v_exact_sha, 'hex'),
                                'normalized_sha256', encode(v_norm_sha, 'hex'),
                                'normalization_version', 'v1', 'char_count', char_length(v_abstract),
                                'previous_snapshot_id', v_prev.id)));

  -- Each abstract quote on the previous current copy, located in the new one
  -- (001A section E4). Quotes on older copies, and examined abstracts, never move.
  -- History lists them by field, then target, then position: deterministic.
  IF v_prev.id IS NOT NULL THEN
    SELECT array_agg(a.id ORDER BY v.field_key COLLATE "C", v.arm_id NULLS FIRST, v.outcome_id NULLS FIRST, a.position, a.id),
           array_agg(a.quote_text ORDER BY v.field_key COLLATE "C", v.arm_id NULLS FIRST, v.outcome_id NULLS FIRST, a.position, a.id)
      INTO v_ids, v_quotes
      FROM public.evidence_field_anchors a
      JOIN public.evidence_field_values v ON v.user_id = a.user_id AND v.study_id = a.study_id AND v.id = a.value_id
     WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.paper_id = p_paper_id
       AND a.snapshot_id = v_prev.id AND a.purpose = 'supports' AND a.source_kind = 'abstract';
    IF v_ids IS NOT NULL THEN
      FOR v_m IN SELECT * FROM public.evidence_locate_quote(v_quotes, v_abstract) LOOP
        SELECT a.id, a.value_id, a.match_start, a.match_end, a.match_occurrence, a.match_count, v.field_key
          INTO v_anchor
          FROM public.evidence_field_anchors a
          JOIN public.evidence_field_values v ON v.user_id = a.user_id AND v.study_id = a.study_id AND v.id = a.value_id
         WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.id = v_ids[v_m.ord];
        IF v_m.status = 'unique' THEN
          UPDATE public.evidence_field_anchors a
             SET snapshot_id = v_new_id, match_start = v_m.starts[1],
                 match_end = v_m.starts[1] + v_m.normalized_length,
                 match_occurrence = 1, match_count = 1, normalization_version = 'v1', matched_at = now()
           WHERE a.user_id = v_uid AND a.study_id = p_study_id AND a.id = v_anchor.id;
          v_moved := array_append(v_moved, v_anchor.value_id);
          v_rematched := v_rematched + 1;
          v_events := v_events || jsonb_build_array(jsonb_build_object(
            'event_type', 'anchor_rematched', 'target_id', v_anchor.id, 'field_key', v_anchor.field_key,
            'before', jsonb_build_object('value_id', v_anchor.value_id, 'snapshot_id', v_prev.id, 'seq', v_prev.seq,
                                         'match_start', v_anchor.match_start, 'match_end', v_anchor.match_end,
                                         'match_occurrence', v_anchor.match_occurrence,
                                         'match_count', v_anchor.match_count),
            'after', jsonb_build_object('value_id', v_anchor.value_id, 'snapshot_id', v_new_id, 'seq', v_seq,
                                        'match_start', v_m.starts[1],
                                        'match_end', v_m.starts[1] + v_m.normalized_length,
                                        'match_occurrence', 1, 'match_count', 1)));
        ELSE
          IF v_m.status IN ('multiple', 'too_many') THEN
            v_ambiguous := v_ambiguous + 1;
          ELSE
            v_not_found := v_not_found + 1;
          END IF;
          v_events := v_events || jsonb_build_array(jsonb_build_object(
            'event_type', 'anchor_not_rematched', 'target_id', v_anchor.id, 'field_key', v_anchor.field_key,
            'before', NULL,
            'after', jsonb_build_object('value_id', v_anchor.value_id, 'kept_snapshot_id', v_prev.id,
                                        'kept_seq', v_prev.seq,
                                        'outcome', CASE WHEN v_m.status IN ('multiple', 'too_many') THEN 'ambiguous'
                                                        WHEN v_m.status = 'not_found' THEN 'not_found'
                                                        ELSE 'invalid' END,
                                        'count', v_m.match_count)));
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- 001A section E5, strictly: reviewed, flagged and needs-re-review values go to
  -- Needs re-review (source_changed) even when every quote was found again;
  -- unreviewed values stay unreviewed. value_version + 1 wherever an anchor
  -- moved or the status changed.
  FOR v_val IN
    SELECT v.id, v.field_key, v.review_status
      FROM public.evidence_field_values v
     WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v_digests ? v.id::text
     ORDER BY v.field_key COLLATE "C", v.arm_id NULLS FIRST, v.outcome_id NULLS FIRST, v.id
  LOOP
    v_to := CASE WHEN v_val.review_status = 'unreviewed' THEN 'unreviewed' ELSE 'needs_rereview' END;
    CONTINUE WHEN v_to = v_val.review_status AND NOT (v_val.id = ANY (v_moved));
    UPDATE public.evidence_field_values v
       SET review_status = v_to,
           review_reason = CASE WHEN v_to = 'needs_rereview' THEN 'source_changed' END,
           reviewed_at = NULL, reviewed_version = NULL,
           value_version = v.value_version + 1, updated_at = now()
     WHERE v.user_id = v_uid AND v.study_id = p_study_id AND v.id = v_val.id;
    v_changed := v_changed + 1;
    IF v_to <> v_val.review_status THEN
      v_rereview := v_rereview + 1;
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'event_type', 'review_needs_rereview', 'target_id', v_val.id, 'field_key', v_val.field_key,
        'before', v_digests -> v_val.id::text, 'after', public.evidence_value_digest(v_uid, v_val.id)));
    END IF;
  END LOOP;

  v_events := v_events || jsonb_build_array(jsonb_build_object(
    'event_type', 'source_rebased', 'target_id', v_new_id, 'field_key', NULL, 'before', NULL,
    'after', jsonb_build_object('paper_id', p_paper_id, 'snapshot_id', v_new_id, 'previous_snapshot_id', v_prev.id,
                                'quotes_rechecked', coalesce(cardinality(v_ids), 0), 'rematched', v_rematched,
                                'not_found', v_not_found, 'ambiguous', v_ambiguous,
                                'values_needing_rereview', v_rereview, 'values_changed', v_changed)));

  IF (SELECT count(*) FROM public.evidence_events e WHERE e.user_id = v_uid AND e.study_id = p_study_id)
     + 1 + jsonb_array_length(v_events) > 5000 THEN
    RAISE EXCEPTION 'evidence_history_limit' USING ERRCODE = 'raise_exception';
  END IF;

  v_version := v_current + 1;
  UPDATE public.evidence_studies s
     SET row_version = v_version, updated_at = now()
   WHERE s.id = p_study_id AND s.user_id = v_uid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'evidence_internal_invariant' USING ERRCODE = 'internal_error';
  END IF;

  v_result := jsonb_build_object('status', 'applied', 'study_id', p_study_id, 'study_version', v_version,
                                 'paper_id', p_paper_id, 'snapshot_id', v_new_id, 'previous_snapshot_id', v_prev.id,
                                 'seq', v_seq, 'rematched', v_rematched, 'not_found', v_not_found,
                                 'ambiguous', v_ambiguous, 'needs_rereview', v_rereview);

  INSERT INTO public.evidence_events
    (user_id, study_id, study_version, ordinal, event_type, request_id,
     op, payload_sha256, result, target_id, field_key, before, after)
  SELECT v_uid, p_study_id, v_version, 0, 'request', p_request_id,
         'rebase_source', v_payload, v_result, NULL, NULL, NULL, NULL
  UNION ALL
  SELECT v_uid, p_study_id, v_version, e.ord::integer, e.v ->> 'event_type', p_request_id,
         NULL, NULL, NULL, (e.v ->> 'target_id')::uuid, e.v ->> 'field_key',
         NULLIF(e.v -> 'before', 'null'::jsonb), NULLIF(e.v -> 'after', 'null'::jsonb)
    FROM jsonb_array_elements(v_events) WITH ORDINALITY AS e(v, ord);

  RETURN v_result;
END
$fn$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 8. EXECUTE — revoke first, then the three RPCs for authenticated only
-- ═════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.evidence_locate_quote(text[], text)                              FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evidence_state_reference_problems(text, integer, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evidence_value_digest(uuid, uuid)                                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evidence_save_changes(uuid, integer, jsonb, uuid)                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evidence_review_fields(uuid, integer, uuid, integer, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evidence_rebase_source(uuid, uuid, integer, text, uuid)          FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.evidence_save_changes(uuid, integer, jsonb, uuid)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.evidence_review_fields(uuid, integer, uuid, integer, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.evidence_rebase_source(uuid, uuid, integer, text, uuid)          TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 9. Documentation readable from the database itself
-- ═════════════════════════════════════════════════════════════════════════════

COMMENT ON FUNCTION public.evidence_locate_quote(text[], text) IS
  'EVIDENCE-RECORDS-001A3. Internal, owner-only. Locates each quote in a copy after normalization v1 (each input normalized once): every contiguous, case-sensitive occurrence, overlapping included, as 0-based code point offsets of the normalized copy; refuses quotes under 3 or over 1,000 characters or without a letter or digit (pg_c_utf8 [[:alnum:]]); more than 100 occurrences is too_many. Proves only that the passage occurs.';
COMMENT ON FUNCTION public.evidence_state_reference_problems(text, integer, integer, integer) IS
  'EVIDENCE-RECORDS-001A3. Internal, owner-only. FK-PROOF-001 section J as one rule: the reference-count problems of a value state (PR-B checkStateReferences codes), used by save_changes and by Confirm.';
COMMENT ON FUNCTION public.evidence_value_digest(uuid, uuid) IS
  'EVIDENCE-RECORDS-001A3. Internal, owner-only. The bounded history record of one value: codes, integers, states, ids, versions and match offsets in clear; user text and quotes as {sha256, chars}; never source text.';
COMMENT ON FUNCTION public.evidence_save_changes(uuid, integer, jsonb, uuid) IS
  'EVIDENCE-RECORDS-001A3. Owner-gated. One atomic batch of group, outcome and value changes at an expected study version, each value at its expected value version; enforces the field dictionary, design families, FK-PROOF-001 section J, the current-copy rule and server-side quote matching; any change resets review. Idempotent per request id while the study exists.';
COMMENT ON FUNCTION public.evidence_review_fields(uuid, integer, uuid, integer, text, text, uuid) IS
  'EVIDENCE-RECORDS-001A3. Owner-gated. Confirm or Flag ONE value at ONE value_version: no bulk confirmation by construction. Confirm requires the state''s sources and current support (PR-B ConfirmBlock reasons in evidence_confirm_blocked DETAIL); Flag needs a note.';
COMMENT ON FUNCTION public.evidence_rebase_source(uuid, uuid, integer, text, uuid) IS
  'EVIDENCE-RECORDS-001A3. Owner-gated. Saves a new copy of a linked paper''s abstract after checking the SHA-256 the caller displayed; re-points quotes found exactly once; every abstract-dependent reviewed, flagged or re-review value needs re-review even when every quote was found again. Copies are never updated.';


-- ═════════════════════════════════════════════════════════════════════════════
-- 10. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Asserts what this file claims, in the transaction that claims it. Suites 003,
-- 007, 015, 021, 031, 032 and 033 pin the same facts in CI.

DO $verify$
DECLARE
  -- name(args) | result | language | security | volatility | strict | parallel | owner | config | acl
  v_expected CONSTANT text :=
       'evidence_create_study_from_paper(p_paper_id uuid, p_label text, p_design_profile text, p_link_status text, p_request_id uuid)'
    || '|jsonb|plpgsql|definer|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres,authenticated=X/postgres}' || E'\n'
    || 'evidence_delete_study(p_study_id uuid, p_expected_version integer, p_request_id uuid)'
    || '|jsonb|plpgsql|definer|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres,authenticated=X/postgres}' || E'\n'
    || 'evidence_locate_quote(p_quotes text[], p_snapshot text)'
    || '|TABLE(ord integer, status text, problems text[], normalized_length integer, match_count integer, starts integer[])'
    || '|plpgsql|invoker|i|t|s|postgres|{"search_path=pg_catalog, pg_temp"}|{postgres=X/postgres}' || E'\n'
    || 'evidence_normalize_v1(p_text text)'
    || '|text|plpgsql|invoker|i|t|s|postgres|{"search_path=pg_catalog, pg_temp"}|{postgres=X/postgres}' || E'\n'
    || 'evidence_rebase_source(p_study_id uuid, p_paper_id uuid, p_expected_version integer, p_expected_abstract_sha256 text, p_request_id uuid)'
    || '|jsonb|plpgsql|definer|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres,authenticated=X/postgres}' || E'\n'
    || 'evidence_records_assert_writable()'
    || '|void|plpgsql|invoker|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres}' || E'\n'
    || 'evidence_review_fields(p_study_id uuid, p_expected_version integer, p_value_id uuid, p_expected_value_version integer, p_action text, p_note text, p_request_id uuid)'
    || '|jsonb|plpgsql|definer|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres,authenticated=X/postgres}' || E'\n'
    || 'evidence_save_changes(p_study_id uuid, p_expected_version integer, p_changes jsonb, p_request_id uuid)'
    || '|jsonb|plpgsql|definer|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres,authenticated=X/postgres}' || E'\n'
    || 'evidence_set_link(p_study_id uuid, p_paper_id uuid, p_action text, p_expected_version integer, p_request_id uuid)'
    || '|jsonb|plpgsql|definer|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres,authenticated=X/postgres}' || E'\n'
    || 'evidence_state_reference_problems(p_state text, p_supports integer, p_examined integer, p_unavailable integer)'
    || '|text[]|sql|invoker|i|t|s|postgres|{"search_path=pg_catalog, pg_temp"}|{postgres=X/postgres}' || E'\n'
    || 'evidence_update_study(p_study_id uuid, p_expected_version integer, p_label text, p_design_profile text, p_notes text, p_request_id uuid)'
    || '|jsonb|plpgsql|definer|v|f|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres,authenticated=X/postgres}' || E'\n'
    || 'evidence_value_digest(p_user_id uuid, p_value_id uuid)'
    || '|jsonb|sql|invoker|s|t|u|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres}';
  v_rpcs CONSTANT text :=
       'public.evidence_create_study_from_paper(uuid,text,text,text,uuid),public.evidence_delete_study(uuid,integer,uuid),'
    || 'public.evidence_rebase_source(uuid,uuid,integer,text,uuid),'
    || 'public.evidence_review_fields(uuid,integer,uuid,integer,text,text,uuid),'
    || 'public.evidence_save_changes(uuid,integer,jsonb,uuid),public.evidence_set_link(uuid,uuid,text,integer,uuid),'
    || 'public.evidence_update_study(uuid,integer,text,text,text,uuid)';
  v_text  text;
  v_table text;
BEGIN
  -- The twelve functions, exactly, with every attribute.
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
                    E'\n' ORDER BY p.proname COLLATE "C")
    INTO v_text
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%';
  IF v_text IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION E'evidence_field_ops: the evidence functions are not the reviewed twelve:\n%', v_text;
  END IF;

  -- Effective EXECUTE: authenticated reaches the seven RPCs and nothing else;
  -- anon, service_role and PUBLIC reach none of the twelve.
  SELECT coalesce(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.proname COLLATE "C"), '')
    INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_text IS DISTINCT FROM v_rpcs THEN
    RAISE EXCEPTION 'evidence_field_ops: authenticated executes % instead of exactly the seven RPCs', v_text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
                AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                     OR has_function_privilege('service_role', p.oid, 'EXECUTE')
                     OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                                 WHERE a.grantee = 0))) THEN
    RAISE EXCEPTION 'evidence_field_ops: anon, service_role or PUBLIC can execute an evidence function';
  END IF;

  -- The PR-A2 bodies are untouched; the normalizer this file reuses above all.
  SELECT coalesce(string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname COLLATE "C"), '') INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('evidence_create_study_from_paper', 'evidence_delete_study', 'evidence_normalize_v1',
                       'evidence_records_assert_writable', 'evidence_set_link', 'evidence_update_study');
  IF v_text IS DISTINCT FROM
       'evidence_create_study_from_paper=dd6949ee0e7125bbe0f83e7e49631983,'
    || 'evidence_delete_study=afc71c3ee3be2154b2c580dfb999b4aa,'
    || 'evidence_normalize_v1=0e7c43b310ad58ab43e7d4d6f1ca411e,'
    || 'evidence_records_assert_writable=53badd75082a39ee814de096653e4f5f,'
    || 'evidence_set_link=fcfd9b3546d772b5a00938426a46e90a,'
    || 'evidence_update_study=47cb76dee1273698b070638f36aa341d' THEN
    RAISE EXCEPTION 'evidence_field_ops: a PR-A2 function body changed: %', v_text;
  END IF;

  -- The tables are untouched: exactly authenticated SELECT, no column grant, no
  -- trigger — the RPCs remain the only write path — and no view exposes them.
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
      RAISE EXCEPTION 'evidence_field_ops: public.% is no longer SELECT-only for authenticated and trigger-free (grants %)', v_table, v_text;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_class c
              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
                AND pg_get_viewdef(c.oid) ~ 'evidence_') THEN
    RAISE EXCEPTION 'evidence_field_ops: a public view reads an evidence table';
  END IF;

  -- History stays append-only and copies immutable, by construction, across
  -- every evidence function (comments stripped): no UPDATE of events; a DELETE
  -- of events only in evidence_delete_study; no UPDATE of a copy; a DELETE of a
  -- copy only where PR-A2 put one; no TRUNCATE; and no dynamic SQL in the new
  -- functions.
  SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname COLLATE "C"), '') INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'update[[:space:]]+(only[[:space:]]+)?(public\.)?(evidence_events|evidence_source_snapshots)';
  IF v_text <> '' THEN
    RAISE EXCEPTION 'evidence_field_ops: % update history or a copy', v_text;
  END IF;
  SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname COLLATE "C"), '') INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'delete[[:space:]]+from[[:space:]]+(only[[:space:]]+)?(public\.)?evidence_events';
  IF v_text <> 'evidence_delete_study' THEN
    RAISE EXCEPTION 'evidence_field_ops: the functions deleting evidence_events are "%", not exactly evidence_delete_study', v_text;
  END IF;
  SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname COLLATE "C"), '') INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'delete[[:space:]]+from[[:space:]]+(only[[:space:]]+)?(public\.)?evidence_source_snapshots';
  IF v_text <> 'evidence_delete_study,evidence_set_link' THEN
    RAISE EXCEPTION 'evidence_field_ops: the functions deleting copies are "%", not exactly delete_study and set_link', v_text;
  END IF;
  SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname COLLATE "C"), '') INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%'
     AND (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'truncate[[:space:]]'
          OR (p.proname IN ('evidence_locate_quote', 'evidence_state_reference_problems', 'evidence_value_digest',
                            'evidence_save_changes', 'evidence_review_fields', 'evidence_rebase_source')
              AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '(^|[^a-z_])execute[[:space:]]'));
  IF v_text <> '' THEN
    RAISE EXCEPTION 'evidence_field_ops: % truncate a table or run dynamic SQL', v_text;
  END IF;
  SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname COLLATE "C"), '') INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?evidence_events';
  IF v_text <> 'evidence_create_study_from_paper,evidence_rebase_source,evidence_review_fields,evidence_save_changes,evidence_set_link,evidence_update_study' THEN
    RAISE EXCEPTION 'evidence_field_ops: the functions appending history are "%", not exactly the six gated RPCs', v_text;
  END IF;

  -- Quote location behaves as specified on this server: overlapping
  -- occurrences count, case counts, an ellipsis is three full stops, a
  -- superscript stays a superscript, offsets are code points of the normalized
  -- copy, the letter-or-digit rule and the occurrence cap hold. Inputs are
  -- built with chr(), so this block is plain ASCII.
  IF (SELECT string_agg(format('%s:%s:%s:%s', l.status, coalesce(l.match_count::text, '-'),
                               array_to_string(l.starts, '/'), array_to_string(l.problems, '/')), ' ' ORDER BY l.ord)
        FROM public.evidence_locate_quote(
               ARRAY['aba', 'Placebo', 'A...B', '105 cells', 'caf' || chr(0x00E9), 'x' || chr(0x1D400) || 'y', '..!',
                     chr(0x24D0) || chr(0x24D1) || chr(0x24D2), chr(0x0661) || chr(0x0662) || chr(0x0663), 'aaa', 'ab'],
               'abababa placebo A' || chr(0x2026) || 'B 10' || chr(0x2075) || ' cells cafe' || chr(0x0301)
               || ' x' || chr(0x1D400) || 'y ' || chr(0x24D0) || chr(0x24D1) || chr(0x24D2) || ' ' || repeat('a', 103)) AS l)
     IS DISTINCT FROM
       'multiple:3:0/2/4: not_found:0:: unique:1:16: not_found:0:: unique:1:32: unique:1:37: invalid:-::no_letter_or_digit'
    || ' unique:1:41: invalid:-::no_letter_or_digit too_many:-:: invalid:-::quote_too_short/normalized_too_short' THEN
    RAISE EXCEPTION 'evidence_field_ops: evidence_locate_quote does not reproduce the reviewed behaviour on this server';
  END IF;
  IF public.evidence_state_reference_problems('reported', 4, 1, 1) IS DISTINCT FROM
       ARRAY['too_many_supporting', 'examined_not_allowed', 'unavailable_not_allowed']
     OR public.evidence_state_reference_problems('not_reported', 1, 0, 0) IS DISTINCT FROM
       ARRAY['supporting_not_allowed', 'examined_required']
     OR public.evidence_state_reference_problems('unclear', 0, 0, 2) IS DISTINCT FROM ARRAY['basis_required']
     OR public.evidence_state_reference_problems('not_applicable', 0, 0, 1) IS DISTINCT FROM ARRAY['not_allowed']
     OR public.evidence_state_reference_problems('source_unavailable', 0, 1, 0) IS DISTINCT FROM
       ARRAY['examined_not_allowed', 'unavailable_required']
     OR cardinality(public.evidence_state_reference_problems('unclear', 3, 2, 2)) <> 0 THEN
    RAISE EXCEPTION 'evidence_field_ops: evidence_state_reference_problems does not reproduce FK-PROOF-001 section J';
  END IF;
END
$verify$;

COMMIT;
