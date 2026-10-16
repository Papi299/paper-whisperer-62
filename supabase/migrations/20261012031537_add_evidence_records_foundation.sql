-- EVIDENCE-RECORDS-001A1 — the database foundation for manual, source-grounded
-- study records ("Study PICO").
--
-- WHAT THIS MIGRATION IS
-- ─────────────────────────────────────────────────────────────────────────────
-- The first of three schema steps for the Manual PICO MVP specified in
-- EVIDENCE-INTELLIGENCE-REQUIREMENTS-001, as amended by 001A and corrected by
-- EVIDENCE-INTELLIGENCE-FK-PROOF-001. It creates eight empty tables, their keys,
-- their CHECK constraints, forced row level security with one owner-only SELECT
-- policy each, and revoke-first grants. Nothing else.
--
--   evidence_studies           one study, as the user understands it
--   evidence_study_reports     "this paper reports this study" (the link)
--   evidence_source_snapshots  an immutable saved copy of a paper's abstract,
--                              per study-report link
--   evidence_arms              intervention and comparator groups
--   evidence_outcomes          outcomes, as named by the authors
--   evidence_field_values      one typed value (or an explicit missing-value
--                              state) per study, group or outcome field
--   evidence_field_anchors     source references: what supports a value, which
--                              source was examined, or which was unavailable
--   evidence_events            append-only history, including request headers
--
-- WHAT IT DELIBERATELY IS NOT
-- ─────────────────────────────────────────────────────────────────────────────
-- No function, no trigger, no view, no RPC, no pilot gate and no client write
-- path of any kind. `authenticated` may SELECT its own rows and nothing more;
-- `anon` and `service_role` hold nothing. A row can therefore exist only if the
-- database owner wrote it, which in practice means: never, until the reviewed
-- SECURITY DEFINER RPCs of EVIDENCE-RECORDS-001A2/001A3 exist. No backfill, no
-- inference and no AI field: every table starts empty and stays empty here.
--
-- RELATIONSHIPS — enforced by keys, independently of RLS and of any RPC
-- ─────────────────────────────────────────────────────────────────────────────
-- Every edge is a COMPOSITE foreign key that carries `user_id`, so a cross-user
-- edge cannot be stored by anyone, however privileged. Edges between evidence
-- rows also carry `study_id`, so a cross-study edge cannot be stored either:
--
--   link      (user_id, study_id)                      -> studies       CASCADE
--   link      (user_id, paper_id)                      -> papers        NO ACTION (1)
--   copy      (user_id, study_id, paper_id)            -> link          CASCADE
--   value     (user_id, study_id, arm_id|outcome_id)   -> arm|outcome   CASCADE
--   reference (user_id, study_id, value_id)            -> value         CASCADE
--   reference (user_id, study_id, paper_id)            -> link          NO ACTION (2)
--   reference (user_id, study_id, paper_id, snapshot_id) -> copy        NO ACTION (3)
--
-- So a reference can only point at a value of its own study (R1), at a report
-- linked to that study (R2), and — for an abstract — at a copy captured for that
-- exact study-report link (R3). MATCH SIMPLE skips edge (3) when `snapshot_id`
-- is NULL, which is how a full-text reference names a report without a copy.
--
-- THE THREE NO ACTION EDGES, AND WHY ACCOUNT DELETION STILL WORKS
-- ─────────────────────────────────────────────────────────────────────────────
-- (1) refuses to delete or merge away a paper a study links to; (2) refuses to
-- unlink a report while a reference depends on it; (3) refuses to delete a copy
-- a reference points at. All three are IMMEDIATE — design F-A, the candidate
-- mechanism for PD-2 — so the refusing statement fails with 23503 and its whole
-- transaction rolls back, and
-- `delete_papers_with_attachment_cleanup` and `merge_exact_duplicates` need no
-- change to leave nothing partial behind.
--
-- Account deletion still succeeds because of two structural rules, each pinned
-- by suites 008 and 030:
--   * every evidence table has its own `user_id -> auth.users ON DELETE CASCADE`;
--   * every child of a study has its own `(user_id, study_id) -> studies CASCADE`.
-- PostgreSQL fires the NO ACTION checks raised by cascaded deletes only after
-- every first-generation cascade has run, so by then every evidence row of the
-- account is already gone. A table cleared only one generation later would pass
-- or fail depending on RI trigger-name order — which is why no evidence table is
-- left to a second-generation cascade. Observed locally on PostgreSQL 17.6 in
-- FK-PROOF-001, in both trigger orders and through the real Auth Admin API;
-- suite 008 repeats both orders, and the account-deletion E2E repeats the real
-- Auth path, against this schema.
--
-- SINGLE-ROW RULES ARE CHECK CONSTRAINTS; CROSS-ROW RULES ARE NOT ENFORCED YET
-- ─────────────────────────────────────────────────────────────────────────────
-- Declared here, because a single row can express them: the closed field-key
-- lists per scope (study, group, outcome), each key's value shape and bounds,
-- "reported if and only if a value is present", the Unclear and Not applicable
-- note rules, the review-state columns, the source-reference matrix
-- (purpose x source kind), the snapshot hash binding, and the request-header
-- shape. Each negative case in suite 030 breaks exactly one of them.
--
-- NOT enforced by this migration, and not claimed to be. Each is a cross-row or
-- authorization rule for the RPCs of 001A2/001A3, to be pinned by their suites:
--   * a new or re-pointed abstract quote targets the link's CURRENT copy;
--   * a field is allowed for the study's design family; `comparator_type`
--     appears only on comparator groups;
--   * list entries are trimmed and de-duplicated; counts (studies per user,
--     groups, outcomes, values, references, copies) stay within their limits;
--   * a value's state agrees with its references (Not reported needs at least
--     one `examined` reference, Couldn't check at least one `unavailable`, and
--     so on), and Confirm's preconditions hold;
--   * an `unavailable` abstract reference names a link that has no copy;
--   * copies are never updated, and history is never updated or deleted except
--     with its study (no client privilege exists now; the RPC suites add the
--     function-source scan);
--   * the pilot gate, ownership predicates and version checks.
--
-- REQUEST IDEMPOTENCY — the schema half only
-- ─────────────────────────────────────────────────────────────────────────────
-- A committed write request will record one header row in `evidence_events`
-- (`ordinal = 0`, `event_type = 'request'`) carrying the operation, a SHA-256 of
-- its payload and a bounded, content-free result. The partial unique index
-- `evidence_events_request_header_key (user_id, request_id) WHERE ordinal = 0`
-- makes a second committed header for one request impossible. That guarantee is
-- BOUNDED BY THE LIFETIME OF THE STUDY: deleting a study deletes its history,
-- headers included, so a request id is remembered only while its study exists.
-- A request that changes nothing need not, and will not, leave a replay
-- receipt. This is not a promise of indefinite exactly-once execution. The
-- algorithm that uses the index (advisory lock, header lookup, version check)
-- belongs to 001A2 and is not part of this migration.
--
-- EXPAND-ONLY, AND HOW IT LOCKS
-- ─────────────────────────────────────────────────────────────────────────────
-- Additive: eight new tables. No existing table, column, constraint, policy,
-- grant, function or row is altered. The frontend's account export reads the
-- new tables but tolerates their absence, so code and schema may reach
-- Production in either order.
--
-- Creating the foreign keys takes SHARE ROW EXCLUSIVE on `auth.users` and on
-- `public.papers`. The repository's global lock order puts `auth.users` before
-- `papers` (20260904120000, section 0); taking both explicitly, in that order
-- and in the exact mode the foreign keys need, means no lock is ever upgraded
-- and an account deletion running concurrently cannot deadlock with this file.
-- SHARE ROW EXCLUSIVE does not conflict with ROW SHARE, so the foreign-key
-- checks of concurrent inserts keep working; writes to `papers` and Auth wait
-- for the few milliseconds the DDL takes. Each wait is bounded by
-- `lock_timeout = 5s`, after which the whole file rolls back and can be retried.
--
-- The file is one explicit transaction. `supabase db reset` runs a file
-- statement by statement in autocommit, which would reject the LOCK statements;
-- `BEGIN`/`COMMIT` make it atomic under every runner. (`db push` opens its own
-- transaction first; the file's BEGIN then only warns, exactly as it did for
-- 20260904120000.)
--
-- ROLLBACK — forward only
-- ─────────────────────────────────────────────────────────────────────────────
-- Do not edit this file after it has been applied. While the tables are empty,
-- a reversal is a new forward migration that drops the eight tables (children
-- first: anchors, events, values, copies, arms, outcomes, links, studies). Once
-- any row exists, dropping them destroys user data and needs an export and an
-- explicit Product Owner decision.

BEGIN;

-- Transaction-local, so COMMIT restores the runner's own settings: a fixed name
-- resolution path for everything this file creates and checks, and a bounded
-- wait for every lock. Section 0 proves both took effect, which also proves the
-- file is running as one transaction.
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context
-- ═════════════════════════════════════════════════════════════════════════════

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'evidence_records: must run as postgres (current_user is %)', current_user;
  END IF;

  IF current_setting('search_path') IS DISTINCT FROM 'pg_catalog, pg_temp'
     OR current_setting('lock_timeout') IS DISTINCT FROM '5s' THEN
    RAISE EXCEPTION 'evidence_records: the transaction-local settings are not in effect (search_path %, lock_timeout %) — this file must run as one transaction',
      current_setting('search_path'), current_setting('lock_timeout');
  END IF;
END
$ctx$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The global lock order: auth.users first, then papers
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Exactly the mode each foreign key below needs on its referenced table, taken
-- before the first one is created. See the header.

LOCK TABLE auth.users    IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.papers IN SHARE ROW EXCLUSIVE MODE;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Preconditions — refuse anything but the reviewed starting state
-- ═════════════════════════════════════════════════════════════════════════════

DO $pre$
DECLARE
  v_text text;
BEGIN
  -- Two CHECK constraints below call functions pg_proc marks STABLE rather
  -- than IMMUTABLE: convert_to(text, 'UTF8') for the snapshot hash binding and
  -- array_to_string(text[], chr(31)) for the list-element bounds. Both are
  -- deterministic for these arguments only while the server encoding is UTF8 —
  -- UTF8 to UTF8 is the identity, and text has no setting-dependent output — so
  -- refuse any other encoding rather than install a CHECK that could disagree
  -- with itself.
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'evidence_records: server_encoding is %, UTF8 is required', current_setting('server_encoding');
  END IF;

  -- Nothing of this migration exists yet, not even partially.
  SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '') INTO v_text
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'evidence\_%';
  IF v_text <> '' THEN
    RAISE EXCEPTION 'evidence_records: public already holds evidence relations: %', v_text;
  END IF;

  SELECT coalesce(string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text), '') INTO v_text
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%';
  IF v_text <> '' THEN
    RAISE EXCEPTION 'evidence_records: public already holds evidence functions: %', v_text;
  END IF;

  -- The paper-side target of edge (1): a unique key on papers (user_id, id),
  -- added by 20260818120000 for the same reason.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint k
     WHERE k.conrelid = 'public.papers'::regclass
       AND k.contype IN ('u', 'p')
       AND (SELECT array_agg(a.attname::text ORDER BY o.ord)
              FROM unnest(k.conkey) WITH ORDINALITY AS o(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = o.attnum)
           = ARRAY['user_id', 'id']
  ) THEN
    RAISE EXCEPTION 'evidence_records: public.papers has no unique key on (user_id, id)';
  END IF;

  -- Account deletion depends on papers leaving in the first generation of
  -- cascades from auth.users, exactly like every evidence table below.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint k
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
     WHERE k.conrelid = 'public.papers'::regclass
       AND k.contype = 'f'
       AND k.confrelid = 'auth.users'::regclass
       AND cardinality(k.conkey) = 1
       AND a.attname = 'user_id'
       AND k.confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'evidence_records: public.papers.user_id does not cascade from auth.users';
  END IF;
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. evidence_studies — one study, as the user understands it
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A study is not a paper. A paper is one report; a study may be reported in
-- several papers, and one paper may report several studies. Identity between
-- them is only ever what the user asserted through a link (section 4): nothing
-- here infers it, and nothing here claims a study is unique or independent.
--
-- `row_version` counts committed write requests on the study (001A H; FK-PROOF
-- I). It is the version the RPCs compare and the version every history row is
-- numbered by. The 001A request-tracking columns on this table are NOT here:
-- FK-PROOF-001 moved request idempotency into header rows of evidence_events.

CREATE TABLE public.evidence_studies (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id        uuid        NOT NULL,
    label          text        NOT NULL,
    design_profile text        NOT NULL,
    notes          text,
    row_version    integer     NOT NULL DEFAULT 1,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT evidence_studies_pkey PRIMARY KEY (id),
    CONSTRAINT evidence_studies_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
    -- The target every composite (user_id, study_id) key below points at. It
    -- also leads with user_id, so the account cascade needs no other index.
    CONSTRAINT evidence_studies_user_id_id_key UNIQUE (user_id, id),

    CONSTRAINT evidence_studies_label_check
        CHECK (char_length(label) <= 120 AND btrim(label) <> ''),
    -- The family only chooses the form (001 F2). The design itself is recorded
    -- as two fields, never derived from papers.study_type.
    CONSTRAINT evidence_studies_design_profile_check
        CHECK (design_profile IN ('rct_parallel', 'intervention_other', 'non_intervention')),
    -- Free text, never shown or treated as evidence. Absent is NULL, never ''.
    CONSTRAINT evidence_studies_notes_check
        CHECK (notes IS NULL OR (char_length(notes) <= 10000 AND btrim(notes) <> '')),
    CONSTRAINT evidence_studies_row_version_check CHECK (row_version >= 1)
);


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. evidence_study_reports — "this paper reports this study"
-- ═════════════════════════════════════════════════════════════════════════════
--
-- (user_id, study_id, paper_id) is unique. Because the study key below makes
-- user_id a function of study_id, that is the same rule as 001's
-- UNIQUE (study_id, paper_id), and this one constraint is also the target that
-- copies and references point at — so the narrower duplicate is not declared.
--
-- Edge (1) is NO ACTION: a paper a study links to cannot be deleted or merged
-- away. The index on (user_id, paper_id) serves that check.

CREATE TABLE public.evidence_study_reports (
    id          uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL,
    study_id    uuid        NOT NULL,
    paper_id    uuid        NOT NULL,
    link_status text        NOT NULL,
    link_basis  text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT evidence_study_reports_pkey PRIMARY KEY (id),
    CONSTRAINT evidence_study_reports_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
    CONSTRAINT evidence_study_reports_study_fkey
        FOREIGN KEY (user_id, study_id)
        REFERENCES public.evidence_studies (user_id, id) ON DELETE CASCADE,
    CONSTRAINT evidence_study_reports_paper_fkey
        FOREIGN KEY (user_id, paper_id)
        REFERENCES public.papers (user_id, id) ON DELETE NO ACTION,
    CONSTRAINT evidence_study_reports_link_key UNIQUE (user_id, study_id, paper_id),

    CONSTRAINT evidence_study_reports_link_status_check
        CHECK (link_status IN ('provisional', 'user_confirmed')),
    CONSTRAINT evidence_study_reports_link_basis_check
        CHECK (link_basis IN ('created_from_paper', 'user_linked'))
);

CREATE INDEX evidence_study_reports_paper_idx
    ON public.evidence_study_reports (user_id, paper_id);


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. evidence_source_snapshots — immutable copies of an abstract, per link
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A copy belongs to one study-report link (001A D2, PD-5): two studies reported
-- in one paper each keep their own copy, so neither can quote the other's. The
-- link's current copy is its highest `seq`; lower ones are superseded and kept
-- while the link exists. A copy leaves only with its link, its study or the
-- account — and never while a reference points at it (edge 3).
--
-- `exact_sha256` is bound to `exact_text` by a CHECK, so the fingerprint stored
-- with a copy is always the fingerprint of that text. `normalized_sha256` is
-- the hash after match normalization v1, which arrives with 001A3; until then
-- only its length can be checked.

CREATE TABLE public.evidence_source_snapshots (
    id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id               uuid        NOT NULL,
    study_id              uuid        NOT NULL,
    paper_id              uuid        NOT NULL,
    seq                   integer     NOT NULL,
    source_kind           text        NOT NULL,
    exact_text            text        NOT NULL,
    exact_sha256          bytea       NOT NULL,
    normalized_sha256     bytea       NOT NULL,
    normalization_version text        NOT NULL,
    char_count            integer     NOT NULL,
    captured_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT evidence_source_snapshots_pkey PRIMARY KEY (id),
    CONSTRAINT evidence_source_snapshots_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
    CONSTRAINT evidence_source_snapshots_study_fkey
        FOREIGN KEY (user_id, study_id)
        REFERENCES public.evidence_studies (user_id, id) ON DELETE CASCADE,
    CONSTRAINT evidence_source_snapshots_link_fkey
        FOREIGN KEY (user_id, study_id, paper_id)
        REFERENCES public.evidence_study_reports (user_id, study_id, paper_id) ON DELETE CASCADE,
    -- The target of edge (3): a reference names its copy together with the
    -- study and paper, so a copy of another link can never be named.
    CONSTRAINT evidence_source_snapshots_target_key UNIQUE (user_id, study_id, paper_id, id),
    CONSTRAINT evidence_source_snapshots_seq_key UNIQUE (user_id, study_id, paper_id, seq),

    CONSTRAINT evidence_source_snapshots_seq_check CHECK (seq >= 1),
    CONSTRAINT evidence_source_snapshots_source_kind_check
        CHECK (source_kind = 'library_abstract'),
    CONSTRAINT evidence_source_snapshots_exact_text_check
        CHECK (char_length(exact_text) BETWEEN 1 AND 50000),
    CONSTRAINT evidence_source_snapshots_char_count_check
        CHECK (char_count = char_length(exact_text)),
    CONSTRAINT evidence_source_snapshots_exact_sha256_check
        CHECK (exact_sha256 = sha256(convert_to(exact_text, 'UTF8'))),
    CONSTRAINT evidence_source_snapshots_normalized_sha256_check
        CHECK (octet_length(normalized_sha256) = 32),
    CONSTRAINT evidence_source_snapshots_normalization_version_check
        CHECK (normalization_version = 'v1')
);


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. evidence_arms and evidence_outcomes — structure, not evidence
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A group's role, label and position, and an outcome's label and position, are
-- structural. What the authors reported about them is recorded as values
-- (section 7). (user_id, study_id, id) is the target a value points at, so a
-- value can never name another study's group or outcome.

CREATE TABLE public.evidence_arms (
    id            uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL,
    study_id      uuid        NOT NULL,
    arm_role      text        NOT NULL,
    display_label text        NOT NULL,
    position      integer     NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT evidence_arms_pkey PRIMARY KEY (id),
    CONSTRAINT evidence_arms_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
    CONSTRAINT evidence_arms_study_fkey
        FOREIGN KEY (user_id, study_id)
        REFERENCES public.evidence_studies (user_id, id) ON DELETE CASCADE,
    CONSTRAINT evidence_arms_target_key UNIQUE (user_id, study_id, id),

    CONSTRAINT evidence_arms_arm_role_check CHECK (arm_role IN ('intervention', 'comparator')),
    CONSTRAINT evidence_arms_display_label_check
        CHECK (char_length(display_label) <= 120 AND btrim(display_label) <> ''),
    CONSTRAINT evidence_arms_position_check CHECK (position BETWEEN 0 AND 99)
);

CREATE TABLE public.evidence_outcomes (
    id            uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL,
    study_id      uuid        NOT NULL,
    display_label text        NOT NULL,
    position      integer     NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT evidence_outcomes_pkey PRIMARY KEY (id),
    CONSTRAINT evidence_outcomes_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
    CONSTRAINT evidence_outcomes_study_fkey
        FOREIGN KEY (user_id, study_id)
        REFERENCES public.evidence_studies (user_id, id) ON DELETE CASCADE,
    CONSTRAINT evidence_outcomes_target_key UNIQUE (user_id, study_id, id),

    CONSTRAINT evidence_outcomes_display_label_check
        CHECK (char_length(display_label) <= 200 AND btrim(display_label) <> ''),
    CONSTRAINT evidence_outcomes_position_check CHECK (position BETWEEN 0 AND 99)
);


-- ═════════════════════════════════════════════════════════════════════════════
-- 7. evidence_field_values — one typed fact per field
-- ═════════════════════════════════════════════════════════════════════════════
--
-- No row means "not yet recorded". A row is either a reported value or an
-- explicit missing-value state: not_reported, unclear, not_applicable, or
-- source_unavailable ("Couldn't check"). WHICH source a missing-value state
-- refers to is never stored on the value: it is the set of `examined` and
-- `unavailable` references in section 8 (FK-PROOF-001 J). That replaces 001's
-- `basis` column, so an absence claim is always scoped to named sources and
-- never to "the study".
--
-- The field set is closed and each key's meaning never changes (001 H1); a new
-- meaning gets a new key in a new migration. `n_randomized_arm` is deferred
-- (Q10) and is therefore not in the list.
--
-- A review is bound to one exact version: "Reviewed by you" requires
-- reviewed_version = value_version, so any later change to the value must move
-- it out of user_reviewed in the same statement or be refused.

CREATE TABLE public.evidence_field_values (
    id                uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id           uuid        NOT NULL,
    study_id          uuid        NOT NULL,
    arm_id            uuid,
    outcome_id        uuid,
    field_key         text        NOT NULL,
    value_state       text        NOT NULL,
    state_reason      text,
    value_text        text,
    value_code        text,
    value_int         integer,
    value_list        text[],
    note              text,
    extraction_method text        NOT NULL DEFAULT 'manual',
    review_status     text        NOT NULL DEFAULT 'unreviewed',
    review_reason     text,
    review_note       text,
    reviewed_at       timestamptz,
    reviewed_version  integer,
    value_version     integer     NOT NULL DEFAULT 1,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT evidence_field_values_pkey PRIMARY KEY (id),
    CONSTRAINT evidence_field_values_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
    CONSTRAINT evidence_field_values_study_fkey
        FOREIGN KEY (user_id, study_id)
        REFERENCES public.evidence_studies (user_id, id) ON DELETE CASCADE,
    -- MATCH SIMPLE: a NULL arm_id or outcome_id skips that key.
    CONSTRAINT evidence_field_values_arm_fkey
        FOREIGN KEY (user_id, study_id, arm_id)
        REFERENCES public.evidence_arms (user_id, study_id, id) ON DELETE CASCADE,
    CONSTRAINT evidence_field_values_outcome_fkey
        FOREIGN KEY (user_id, study_id, outcome_id)
        REFERENCES public.evidence_outcomes (user_id, study_id, id) ON DELETE CASCADE,
    -- The target of a reference's value key (R1).
    CONSTRAINT evidence_field_values_target_key UNIQUE (user_id, study_id, id),
    -- At most one row per entity and field. NULLS NOT DISTINCT so two
    -- study-level rows for one key collide even though both entity ids are NULL.
    CONSTRAINT evidence_field_values_entity_field_key
        UNIQUE NULLS NOT DISTINCT (study_id, arm_id, outcome_id, field_key),

    -- A value belongs to the study, to one group or to one outcome — never two.
    CONSTRAINT evidence_field_values_scope_check
        CHECK (num_nonnulls(arm_id, outcome_id) <= 1),
    -- The closed field list for each scope (001 H2-H5).
    CONSTRAINT evidence_field_values_field_key_check CHECK (
        CASE
            WHEN arm_id IS NOT NULL THEN field_key IN (
                'arm_name_as_reported', 'description', 'comparator_type',
                'dose_or_intensity', 'frequency', 'duration', 'delivery_mode',
                'co_interventions')
            WHEN outcome_id IS NOT NULL THEN field_key IN (
                'outcome_name_as_reported', 'outcome_definition',
                'measurement_instrument', 'outcome_designation', 'time_points')
            ELSE field_key IN (
                'design_as_reported', 'design_classification', 'setting',
                'registration_ids', 'population_description', 'condition',
                'eligibility_criteria', 'demographics', 'n_randomized', 'n_enrolled')
        END),
    CONSTRAINT evidence_field_values_value_state_check CHECK (
        value_state IN ('reported', 'not_reported', 'unclear', 'not_applicable',
                        'source_unavailable')),
    -- "Reported" if and only if a value is present. Nothing ambiguous is ever
    -- stored as if it were a value: Unclear keeps its candidates in the note.
    CONSTRAINT evidence_field_values_value_presence_check CHECK (
        (value_state = 'reported')
        = (num_nonnulls(value_text, value_code, value_int, value_list) > 0)),
    -- Each key's value shape and bounds. Every branch tests its columns for NULL
    -- first, so a malformed row is FALSE (refused), never NULL (accepted).
    -- Lists are checked element by element by joining them with U+001F, which
    -- no element may contain: registration ids are 3-50 characters without
    -- whitespace; time points are 1-100 characters and start and end with a
    -- non-space character. Trimming and de-duplication are the RPC's.
    CONSTRAINT evidence_field_values_value_shape_check CHECK (
        value_state <> 'reported'
        OR CASE
            WHEN field_key IN ('design_as_reported', 'condition', 'outcome_name_as_reported',
                               'measurement_instrument', 'dose_or_intensity', 'frequency',
                               'duration', 'delivery_mode')
                THEN value_text IS NOT NULL AND num_nonnulls(value_code, value_int, value_list) = 0
                     AND char_length(value_text) <= 500 AND btrim(value_text) <> ''
            WHEN field_key = 'arm_name_as_reported'
                THEN value_text IS NOT NULL AND num_nonnulls(value_code, value_int, value_list) = 0
                     AND char_length(value_text) <= 300 AND btrim(value_text) <> ''
            WHEN field_key IN ('setting', 'co_interventions')
                THEN value_text IS NOT NULL AND num_nonnulls(value_code, value_int, value_list) = 0
                     AND char_length(value_text) <= 1000 AND btrim(value_text) <> ''
            WHEN field_key IN ('population_description', 'demographics', 'outcome_definition')
                THEN value_text IS NOT NULL AND num_nonnulls(value_code, value_int, value_list) = 0
                     AND char_length(value_text) <= 2000 AND btrim(value_text) <> ''
            WHEN field_key IN ('eligibility_criteria', 'description')
                THEN value_text IS NOT NULL AND num_nonnulls(value_code, value_int, value_list) = 0
                     AND char_length(value_text) <= 4000 AND btrim(value_text) <> ''
            -- A number is the verbatim reported text AND the parsed integer the
            -- user confirmed (001 H3).
            WHEN field_key IN ('n_randomized', 'n_enrolled')
                THEN value_text IS NOT NULL AND value_int IS NOT NULL
                     AND num_nonnulls(value_code, value_list) = 0
                     AND char_length(value_text) <= 200 AND btrim(value_text) <> ''
                     AND value_int BETWEEN 0 AND 10000000
            WHEN field_key = 'design_classification'
                THEN value_code IS NOT NULL AND num_nonnulls(value_text, value_int, value_list) = 0
                     AND value_code IN ('rct_parallel', 'rct_cluster', 'rct_crossover', 'rct_other',
                                        'non_randomized_controlled', 'single_group_intervention',
                                        'cohort', 'case_control', 'cross_sectional', 'case_series',
                                        'other')
            WHEN field_key = 'comparator_type'
                THEN value_code IS NOT NULL AND num_nonnulls(value_text, value_int, value_list) = 0
                     AND value_code IN ('placebo', 'sham', 'usual_care', 'no_intervention',
                                        'waitlist', 'active_comparator', 'other')
            WHEN field_key = 'outcome_designation'
                THEN value_code IS NOT NULL AND num_nonnulls(value_text, value_int, value_list) = 0
                     AND value_code IN ('primary', 'secondary')
            WHEN field_key = 'registration_ids'
                THEN value_list IS NOT NULL AND num_nonnulls(value_text, value_code, value_int) = 0
                     AND array_ndims(value_list) = 1
                     AND cardinality(value_list) BETWEEN 1 AND 5
                     AND array_position(value_list, NULL) IS NULL
                     AND array_to_string(value_list, chr(31))
                         ~ '^[^\s\x1f]{3,50}(\x1f[^\s\x1f]{3,50})*$'
            WHEN field_key = 'time_points'
                THEN value_list IS NOT NULL AND num_nonnulls(value_text, value_code, value_int) = 0
                     AND array_ndims(value_list) = 1
                     AND cardinality(value_list) BETWEEN 1 AND 10
                     AND array_position(value_list, NULL) IS NULL
                     AND array_to_string(value_list, chr(31))
                         ~ '^[^\s\x1f](?:[^\x1f]{0,98}[^\s\x1f])?(?:\x1f[^\s\x1f](?:[^\x1f]{0,98}[^\s\x1f])?)*$'
            ELSE false
        END),
    -- A reason exactly when the state is Unclear (001 J1).
    CONSTRAINT evidence_field_values_state_reason_check CHECK (
        (value_state = 'unclear') = (state_reason IS NOT NULL)
        AND (state_reason IS NULL
             OR state_reason IN ('ambiguous', 'conflicting', 'incomplete'))),
    CONSTRAINT evidence_field_values_note_check CHECK (
        note IS NULL OR (char_length(note) <= 2000 AND btrim(note) <> '')),
    -- Unclear needs a note of at least 10 characters; Not applicable at least 3.
    CONSTRAINT evidence_field_values_state_note_check CHECK (
        CASE value_state
            WHEN 'unclear'        THEN char_length(btrim(coalesce(note, ''))) >= 10
            WHEN 'not_applicable' THEN char_length(btrim(coalesce(note, ''))) >= 3
            ELSE true
        END),
    -- Only manual entry exists in the MVP (001 K3). An AI path would widen this
    -- in its own reviewed migration.
    CONSTRAINT evidence_field_values_extraction_method_check
        CHECK (extraction_method = 'manual'),
    CONSTRAINT evidence_field_values_review_status_check CHECK (
        review_status IN ('unreviewed', 'user_reviewed', 'disputed', 'needs_rereview')),
    -- "Reviewed by you" carries its time and the exact version reviewed; no other
    -- status carries either.
    CONSTRAINT evidence_field_values_reviewed_check CHECK (
        CASE
            WHEN review_status = 'user_reviewed'
                THEN reviewed_at IS NOT NULL AND reviewed_version IS NOT NULL
                     AND reviewed_version = value_version
            ELSE reviewed_at IS NULL AND reviewed_version IS NULL
        END),
    -- Needs re-review always says why; nothing else carries a review reason.
    CONSTRAINT evidence_field_values_review_reason_check CHECK (
        (review_status = 'needs_rereview') = (review_reason IS NOT NULL)
        AND (review_reason IS NULL OR review_reason = 'source_changed')),
    -- Flagging needs a note of at least 3 characters; any review note is bounded.
    CONSTRAINT evidence_field_values_review_note_check CHECK (
        (review_note IS NULL OR (char_length(review_note) <= 2000 AND btrim(review_note) <> ''))
        AND (review_status <> 'disputed'
             OR char_length(btrim(coalesce(review_note, ''))) >= 3)),
    CONSTRAINT evidence_field_values_value_version_check CHECK (value_version >= 1)
);


-- ═════════════════════════════════════════════════════════════════════════════
-- 8. evidence_field_anchors — source references
-- ═════════════════════════════════════════════════════════════════════════════
--
-- One row names one source of one report for one value, with a purpose
-- (FK-PROOF-001 J):
--
--   purpose      source_kind  snapshot_id          quote + match   locator
--   supports     abstract     required (the copy)  required        none
--   supports     full_text    none                 none            required
--   examined     abstract     required (the copy)  none            none
--   examined     full_text    none                 none            optional
--   unavailable  abstract     none                 none            none
--   unavailable  full_text    none                 none            none
--
-- Full-text references are locator-only: no full-text quote is stored (PD-3).
-- Every one of them is the user's assertion, never checked by PaperLume.
-- An abstract quote's match columns are server-computed against the immutable
-- copy it names; this table cannot say whether the quote supports the value.
--
-- A value has at most three `supports` references (positions 0-2). An
-- `examined` or `unavailable` reference is an assessment of one source, so a
-- value holds at most one assessment per report and source kind — which also
-- makes "examined" and "unavailable" for the same source mutually exclusive.
--
-- Edges (2) and (3) are NO ACTION and are served by one index: its leading
-- three columns answer the link check, all four the copy check.

CREATE TABLE public.evidence_field_anchors (
    id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id               uuid        NOT NULL,
    study_id              uuid        NOT NULL,
    value_id              uuid        NOT NULL,
    paper_id              uuid        NOT NULL,
    snapshot_id           uuid,
    purpose               text        NOT NULL,
    source_kind           text        NOT NULL,
    position              integer,
    quote_text            text,
    match_start           integer,
    match_end             integer,
    match_occurrence      integer,
    match_count           integer,
    normalization_version text,
    matched_at            timestamptz,
    locator_kind          text,
    locator_text          text,
    created_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT evidence_field_anchors_pkey PRIMARY KEY (id),
    CONSTRAINT evidence_field_anchors_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
    CONSTRAINT evidence_field_anchors_study_fkey
        FOREIGN KEY (user_id, study_id)
        REFERENCES public.evidence_studies (user_id, id) ON DELETE CASCADE,
    -- R1: the value belongs to this reference's study.
    CONSTRAINT evidence_field_anchors_value_fkey
        FOREIGN KEY (user_id, study_id, value_id)
        REFERENCES public.evidence_field_values (user_id, study_id, id) ON DELETE CASCADE,
    -- R2, edge (2): the report is linked to this study.
    CONSTRAINT evidence_field_anchors_link_fkey
        FOREIGN KEY (user_id, study_id, paper_id)
        REFERENCES public.evidence_study_reports (user_id, study_id, paper_id) ON DELETE NO ACTION,
    -- R3, edge (3): the copy was captured for this exact study-report link.
    CONSTRAINT evidence_field_anchors_snapshot_fkey
        FOREIGN KEY (user_id, study_id, paper_id, snapshot_id)
        REFERENCES public.evidence_source_snapshots (user_id, study_id, paper_id, id) ON DELETE NO ACTION,
    CONSTRAINT evidence_field_anchors_value_position_key UNIQUE (value_id, position),

    CONSTRAINT evidence_field_anchors_purpose_check
        CHECK (purpose IN ('supports', 'examined', 'unavailable')),
    CONSTRAINT evidence_field_anchors_source_kind_check
        CHECK (source_kind IN ('abstract', 'full_text')),
    -- The matrix above, one column group per rule.
    CONSTRAINT evidence_field_anchors_snapshot_check CHECK (
        (snapshot_id IS NOT NULL)
        = (source_kind = 'abstract' AND purpose IN ('supports', 'examined'))),
    CONSTRAINT evidence_field_anchors_quote_check CHECK (
        CASE
            WHEN purpose = 'supports' AND source_kind = 'abstract'
                THEN num_nonnulls(quote_text, match_start, match_end, match_occurrence,
                                  match_count, normalization_version, matched_at) = 7
            ELSE num_nonnulls(quote_text, match_start, match_end, match_occurrence,
                              match_count, normalization_version, matched_at) = 0
        END),
    CONSTRAINT evidence_field_anchors_locator_check CHECK (
        CASE
            WHEN purpose = 'supports' AND source_kind = 'full_text'
                THEN num_nonnulls(locator_kind, locator_text) = 2
            WHEN purpose = 'examined' AND source_kind = 'full_text'
                THEN num_nonnulls(locator_kind, locator_text) IN (0, 2)
            ELSE num_nonnulls(locator_kind, locator_text) = 0
        END),
    CONSTRAINT evidence_field_anchors_position_check CHECK (
        (purpose = 'supports') = (position IS NOT NULL)
        AND (position IS NULL OR position BETWEEN 0 AND 2)),
    CONSTRAINT evidence_field_anchors_quote_text_check CHECK (
        quote_text IS NULL OR char_length(quote_text) BETWEEN 3 AND 1000),
    CONSTRAINT evidence_field_anchors_match_check CHECK (
        num_nonnulls(match_start, match_end, match_occurrence, match_count) = 0
        OR (num_nonnulls(match_start, match_end, match_occurrence, match_count) = 4
            AND match_start >= 0
            AND match_end > match_start
            AND match_occurrence >= 1
            AND match_count >= match_occurrence)),
    CONSTRAINT evidence_field_anchors_normalization_version_check CHECK (
        normalization_version IS NULL OR normalization_version = 'v1'),
    CONSTRAINT evidence_field_anchors_locator_kind_check CHECK (
        locator_kind IS NULL
        OR locator_kind IN ('page', 'section', 'table', 'figure', 'paragraph', 'other')),
    CONSTRAINT evidence_field_anchors_locator_text_check CHECK (
        locator_text IS NULL OR (char_length(locator_text) <= 200 AND btrim(locator_text) <> ''))
);

CREATE INDEX evidence_field_anchors_source_idx
    ON public.evidence_field_anchors (user_id, study_id, paper_id, snapshot_id);

CREATE UNIQUE INDEX evidence_field_anchors_assessment_key
    ON public.evidence_field_anchors (value_id, paper_id, source_kind)
    WHERE purpose <> 'supports';


-- ═════════════════════════════════════════════════════════════════════════════
-- 9. evidence_events — append-only history and request headers
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every committed write request will produce rows numbered (study_version,
-- ordinal): a header at ordinal 0 and its change events at 1..n, all at the
-- study version the request produced. (user_id, study_id, study_version,
-- ordinal) is unique — the same rule as 001A's (study_id, study_version,
-- ordinal), since the study key makes user_id a function of study_id, and its
-- leading user_id also serves the account cascade.
--
-- A header (ordinal 0, event_type 'request') carries what a retry needs to be
-- answered without re-running the request: the operation, the SHA-256 of its
-- payload and the result it returned (an object of at most 16 KB that never
-- holds source text). Change events never carry those three; headers never
-- carry a change. See the header comment for the idempotency bound.
--
-- No event ever carries a copy's text, and a change event's before/after
-- payload is bounded at 32 KB. History has no client write privilege; it leaves
-- only with its study or the account.

CREATE TABLE public.evidence_events (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id        uuid        NOT NULL,
    study_id       uuid        NOT NULL,
    study_version  integer     NOT NULL,
    ordinal        integer     NOT NULL,
    event_type     text        NOT NULL,
    request_id     uuid        NOT NULL,
    op             text,
    payload_sha256 bytea,
    result         jsonb,
    target_id      uuid,
    field_key      text,
    before         jsonb,
    after          jsonb,
    note           text,
    occurred_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT evidence_events_pkey PRIMARY KEY (id),
    CONSTRAINT evidence_events_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
    CONSTRAINT evidence_events_study_fkey
        FOREIGN KEY (user_id, study_id)
        REFERENCES public.evidence_studies (user_id, id) ON DELETE CASCADE,
    CONSTRAINT evidence_events_order_key UNIQUE (user_id, study_id, study_version, ordinal),

    CONSTRAINT evidence_events_study_version_check CHECK (study_version >= 1),
    CONSTRAINT evidence_events_ordinal_check CHECK (ordinal >= 0),
    CONSTRAINT evidence_events_event_type_check CHECK (event_type IN (
        'request',
        'study_created', 'study_updated',
        'link_created', 'link_status_changed', 'link_removed',
        'source_captured', 'source_rebased', 'anchor_rematched', 'anchor_not_rematched',
        'arm_added', 'arm_updated', 'arm_removed',
        'outcome_added', 'outcome_updated', 'outcome_removed',
        'value_saved', 'value_cleared',
        'review_confirmed', 'review_flagged', 'review_reset', 'review_needs_rereview')),
    -- Ordinal 0 is the request header, and only the header.
    CONSTRAINT evidence_events_header_check
        CHECK ((ordinal = 0) = (event_type = 'request')),
    CONSTRAINT evidence_events_header_shape_check CHECK (
        CASE
            WHEN ordinal = 0
                THEN num_nonnulls(op, payload_sha256, result) = 3
                     AND num_nonnulls(target_id, field_key, before, after, note) = 0
            ELSE num_nonnulls(op, payload_sha256, result) = 0
        END),
    CONSTRAINT evidence_events_op_check CHECK (
        op IS NULL OR op IN ('create_study', 'update_study', 'save_changes',
                             'review_fields', 'set_link', 'rebase_source')),
    CONSTRAINT evidence_events_payload_sha256_check CHECK (
        payload_sha256 IS NULL OR octet_length(payload_sha256) = 32),
    CONSTRAINT evidence_events_result_check CHECK (
        result IS NULL
        OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 16384)),
    CONSTRAINT evidence_events_payload_size_check CHECK (
        octet_length(coalesce(before::text, '')) + octet_length(coalesce(after::text, '')) <= 32768),
    CONSTRAINT evidence_events_field_key_check CHECK (
        field_key IS NULL OR (char_length(field_key) <= 64 AND btrim(field_key) <> '')),
    CONSTRAINT evidence_events_note_check CHECK (
        note IS NULL OR (char_length(note) <= 2000 AND btrim(note) <> ''))
);

-- The durable request key: at most one committed header per user and request.
CREATE UNIQUE INDEX evidence_events_request_header_key
    ON public.evidence_events (user_id, request_id)
    WHERE ordinal = 0;


-- ═════════════════════════════════════════════════════════════════════════════
-- 10. Documentation readable from the database itself
-- ═════════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE public.evidence_studies IS
  'EVIDENCE-RECORDS-001A1. One study as the user understands it; never inferred from papers. Written only by reviewed RPCs (none exist yet); owner-only SELECT.';
COMMENT ON TABLE public.evidence_study_reports IS
  'EVIDENCE-RECORDS-001A1. A user-asserted link: this paper reports this study. The paper key is ON DELETE NO ACTION, so a linked paper cannot be deleted or merged away.';
COMMENT ON TABLE public.evidence_source_snapshots IS
  'EVIDENCE-RECORDS-001A1. Immutable saved copies of a paper abstract, one sequence per study-report link. exact_sha256 is CHECK-bound to exact_text.';
COMMENT ON TABLE public.evidence_arms IS
  'EVIDENCE-RECORDS-001A1. Structural intervention/comparator groups of a study. What was reported about them lives in evidence_field_values.';
COMMENT ON TABLE public.evidence_outcomes IS
  'EVIDENCE-RECORDS-001A1. Structural outcomes of a study. What was reported about them lives in evidence_field_values.';
COMMENT ON TABLE public.evidence_field_values IS
  'EVIDENCE-RECORDS-001A1. One typed value or explicit missing-value state per study/group/outcome field. Single-row rules are CHECKs; cross-row rules (state vs references, family, current copy) belong to the RPCs.';
COMMENT ON TABLE public.evidence_field_anchors IS
  'EVIDENCE-RECORDS-001A1. Source references with purpose supports/examined/unavailable. Keys force the value, report and copy to belong to the same study; full-text references are locator-only user assertions.';
COMMENT ON TABLE public.evidence_events IS
  'EVIDENCE-RECORDS-001A1. Append-only history numbered (study_version, ordinal); ordinal 0 is a request header. Removed only with its study or the account.';
COMMENT ON INDEX public.evidence_events_request_header_key IS
  'At most one committed request header per (user, request id). Bounded by the lifetime of the study: deleting a study deletes its headers. Requests that change nothing record no header. Not a promise of indefinite exactly-once execution.';


-- ═════════════════════════════════════════════════════════════════════════════
-- 11. Row level security — enabled, forced, owner-only SELECT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- One SELECT policy per table and no INSERT, UPDATE or DELETE policy anywhere:
-- every write will go through a reviewed SECURITY DEFINER RPC. FORCE applies
-- the policy to the table owner too; the RPCs' owner holds BYPASSRLS on the
-- platform, and RI checks and cascades bypass row security by design, so
-- neither the keys nor account deletion depend on these policies.

ALTER TABLE public.evidence_studies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_studies          FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.evidence_study_reports    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_study_reports    FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.evidence_source_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_source_snapshots FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.evidence_arms             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_arms             FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.evidence_outcomes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_outcomes         FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.evidence_field_values     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_field_values     FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.evidence_field_anchors    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_field_anchors    FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.evidence_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_events           FORCE  ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own evidence studies"
    ON public.evidence_studies FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own evidence study reports"
    ON public.evidence_study_reports FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own evidence source snapshots"
    ON public.evidence_source_snapshots FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own evidence arms"
    ON public.evidence_arms FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own evidence outcomes"
    ON public.evidence_outcomes FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own evidence field values"
    ON public.evidence_field_values FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own evidence field anchors"
    ON public.evidence_field_anchors FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own evidence events"
    ON public.evidence_events FOR SELECT TO authenticated
    USING (auth.uid() = user_id);


-- ═════════════════════════════════════════════════════════════════════════════
-- 12. Data API grants — revoke first, then SELECT for authenticated only
-- ═════════════════════════════════════════════════════════════════════════════
--
-- REVOKE FIRST is load-bearing, not boilerplate. What a new table inherits
-- depends on the environment's default privileges (a clean local replay and
-- hosted Production have differed), and TRUNCATE and TRIGGER are not governed
-- by RLS. Revoking by ROLE, not by privilege name, removes whatever any of
-- these four grantees received, whatever the starting defaults.
--
--   * anon and PUBLIC: nothing. Study records are private user data.
--   * authenticated: SELECT, filtered to the caller's rows by the policies.
--     No INSERT, UPDATE or DELETE — provenance, match results, review times and
--     history must never be browser-writable.
--   * service_role: nothing (C57). No server path reads or writes these tables;
--     account deletion runs through the foreign-key cascade, which does not
--     consult the deleting role's privileges.

REVOKE ALL ON TABLE public.evidence_studies          FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.evidence_study_reports    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.evidence_source_snapshots FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.evidence_arms             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.evidence_outcomes         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.evidence_field_values     FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.evidence_field_anchors    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.evidence_events           FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.evidence_studies          TO authenticated;
GRANT SELECT ON TABLE public.evidence_study_reports    TO authenticated;
GRANT SELECT ON TABLE public.evidence_source_snapshots TO authenticated;
GRANT SELECT ON TABLE public.evidence_arms             TO authenticated;
GRANT SELECT ON TABLE public.evidence_outcomes         TO authenticated;
GRANT SELECT ON TABLE public.evidence_field_values     TO authenticated;
GRANT SELECT ON TABLE public.evidence_field_anchors    TO authenticated;
GRANT SELECT ON TABLE public.evidence_events           TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 13. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Asserts what this file claims, in the transaction that claims it, so a replay
-- or an environment that produced a weaker schema fails here instead of
-- committing. Suites 008, 015, 026 and 030 pin the same facts in CI.

DO $verify$
DECLARE
  v_tables CONSTANT text[] := ARRAY[
    'evidence_studies', 'evidence_study_reports', 'evidence_source_snapshots',
    'evidence_arms', 'evidence_outcomes', 'evidence_field_values',
    'evidence_field_anchors', 'evidence_events'];
  -- Every foreign key out of an evidence table: name, target and ON DELETE
  -- action (c = CASCADE, a = NO ACTION). Exactly three NO ACTION edges.
  v_fk_expected CONSTANT text :=
       'evidence_arms_study_fkey>public.evidence_studies:c'
    || ',evidence_arms_user_id_fkey>auth.users:c'
    || ',evidence_events_study_fkey>public.evidence_studies:c'
    || ',evidence_events_user_id_fkey>auth.users:c'
    || ',evidence_field_anchors_link_fkey>public.evidence_study_reports:a'
    || ',evidence_field_anchors_snapshot_fkey>public.evidence_source_snapshots:a'
    || ',evidence_field_anchors_study_fkey>public.evidence_studies:c'
    || ',evidence_field_anchors_user_id_fkey>auth.users:c'
    || ',evidence_field_anchors_value_fkey>public.evidence_field_values:c'
    || ',evidence_field_values_arm_fkey>public.evidence_arms:c'
    || ',evidence_field_values_outcome_fkey>public.evidence_outcomes:c'
    || ',evidence_field_values_study_fkey>public.evidence_studies:c'
    || ',evidence_field_values_user_id_fkey>auth.users:c'
    || ',evidence_outcomes_study_fkey>public.evidence_studies:c'
    || ',evidence_outcomes_user_id_fkey>auth.users:c'
    || ',evidence_source_snapshots_link_fkey>public.evidence_study_reports:c'
    || ',evidence_source_snapshots_study_fkey>public.evidence_studies:c'
    || ',evidence_source_snapshots_user_id_fkey>auth.users:c'
    || ',evidence_studies_user_id_fkey>auth.users:c'
    || ',evidence_study_reports_paper_fkey>public.papers:a'
    || ',evidence_study_reports_study_fkey>public.evidence_studies:c'
    || ',evidence_study_reports_user_id_fkey>auth.users:c';
  v_table text;
  v_rel   regclass;
  v_text  text;
  v_count integer;
  v_row   record;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    v_rel := to_regclass('public.' || v_table);
    IF v_rel IS NULL THEN
      RAISE EXCEPTION 'evidence_records: public.% was not created', v_table;
    END IF;

    -- Owner, RLS enabled and forced.
    SELECT c.relkind, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity
      INTO v_row
      FROM pg_class c WHERE c.oid = v_rel;
    IF v_row.relkind <> 'r' OR v_row.owner <> 'postgres'
       OR NOT v_row.relrowsecurity OR NOT v_row.relforcerowsecurity THEN
      RAISE EXCEPTION 'evidence_records: public.% is not an RLS-forced table owned by postgres (kind %, owner %, rls %, force %)',
        v_table, v_row.relkind, v_row.owner, v_row.relrowsecurity, v_row.relforcerowsecurity;
    END IF;

    -- Exactly one policy: a permissive owner-only SELECT for authenticated.
    SELECT count(*)::int INTO v_count FROM pg_policy p WHERE p.polrelid = v_rel;
    SELECT string_agg(p.polcmd::text || '|' || p.polpermissive::text || '|'
                      || (SELECT string_agg(r::regrole::text, ',' ORDER BY r::regrole::text) FROM unnest(p.polroles) r)
                      || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '<none>')
                      || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '<none>'), ';')
      INTO v_text
      FROM pg_policy p WHERE p.polrelid = v_rel;
    IF v_count <> 1 OR v_text IS DISTINCT FROM 'r|true|authenticated|(auth.uid() = user_id)|<none>' THEN
      RAISE EXCEPTION 'evidence_records: public.% policies are not exactly the owner-only SELECT (%: %)',
        v_table, v_count, v_text;
    END IF;

    -- Direct grants: the owner, and authenticated SELECT. Nothing else, for any
    -- grantee — an allowlist, not a list of named roles.
    SELECT coalesce(string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                               || ':' || a.privilege_type, ','
                               ORDER BY a.grantee::text, a.privilege_type), '')
      INTO v_text
      FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r'::"char", c.relowner))) a
     WHERE c.oid = v_rel AND a.grantee <> c.relowner;
    IF v_text <> 'authenticated:SELECT' THEN
      RAISE EXCEPTION 'evidence_records: public.% grants are not exactly authenticated:SELECT (found %)', v_table, v_text;
    END IF;

    -- Effective privileges, PUBLIC inheritance included.
    IF has_table_privilege('anon', v_rel, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN') THEN
      RAISE EXCEPTION 'evidence_records: anon holds a privilege on public.%', v_table;
    END IF;
    IF has_table_privilege('service_role', v_rel, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN') THEN
      RAISE EXCEPTION 'evidence_records: service_role holds a privilege on public.%', v_table;
    END IF;
    IF NOT has_table_privilege('authenticated', v_rel, 'SELECT')
       OR has_table_privilege('authenticated', v_rel, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN') THEN
      RAISE EXCEPTION 'evidence_records: authenticated does not hold exactly SELECT on public.%', v_table;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute att WHERE att.attrelid = v_rel AND att.attacl IS NOT NULL) THEN
      RAISE EXCEPTION 'evidence_records: public.% carries a column-level grant', v_table;
    END IF;

    -- No trigger of any kind: nothing runs on the account-deletion cascade path.
    IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = v_rel AND NOT t.tgisinternal) THEN
      RAISE EXCEPTION 'evidence_records: public.% has a trigger', v_table;
    END IF;

    -- A direct user_id -> auth.users ON DELETE CASCADE, so the account cascade
    -- clears this table in the first generation.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint k
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
       WHERE k.conrelid = v_rel AND k.contype = 'f' AND k.confrelid = 'auth.users'::regclass
         AND cardinality(k.conkey) = 1 AND a.attname = 'user_id' AND k.confdeltype = 'c'
    ) THEN
      RAISE EXCEPTION 'evidence_records: public.% has no direct user_id cascade from auth.users', v_table;
    END IF;

    -- Every child of a study has its own (user_id, study_id) -> studies CASCADE.
    IF v_table <> 'evidence_studies' AND NOT EXISTS (
      SELECT 1 FROM pg_constraint k
       WHERE k.conrelid = v_rel AND k.contype = 'f'
         AND k.confrelid = 'public.evidence_studies'::regclass AND k.confdeltype = 'c'
         AND (SELECT array_agg(a.attname::text ORDER BY o.ord)
                FROM unnest(k.conkey) WITH ORDINALITY AS o(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = o.attnum)
             = ARRAY['user_id', 'study_id']
    ) THEN
      RAISE EXCEPTION 'evidence_records: public.% has no direct (user_id, study_id) cascade from evidence_studies', v_table;
    END IF;

    -- Every foreign key out of the table carries user_id.
    SELECT coalesce(string_agg(k.conname, ', ' ORDER BY k.conname), '') INTO v_text
      FROM pg_constraint k
     WHERE k.conrelid = v_rel AND k.contype = 'f'
       AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey) AND a.attname = 'user_id');
    IF v_text <> '' THEN
      RAISE EXCEPTION 'evidence_records: foreign keys of public.% without user_id: %', v_table, v_text;
    END IF;

    -- Nothing was backfilled.
    EXECUTE format('SELECT count(*)::int FROM %s', v_rel) INTO v_count;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'evidence_records: public.% holds % row(s); no backfill is permitted', v_table, v_count;
    END IF;
  END LOOP;

  -- The whole foreign-key inventory, with every ON DELETE action, and nothing
  -- deferrable: the protective edges are immediate (F-A).
  SELECT string_agg(k.conname || '>' || k.confrelid::regclass::text || ':' || k.confdeltype::text,
                    ',' ORDER BY k.conname)
    INTO v_text
    FROM pg_constraint k
   WHERE k.contype = 'f' AND k.conrelid = ANY (
           SELECT to_regclass('public.' || t) FROM unnest(v_tables) AS t);
  IF v_text IS DISTINCT FROM v_fk_expected THEN
    RAISE EXCEPTION 'evidence_records: the foreign-key inventory is not the reviewed one: %', v_text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint k
              WHERE k.contype = 'f' AND k.condeferrable
                AND k.conrelid = ANY (SELECT to_regclass('public.' || t) FROM unnest(v_tables) AS t)) THEN
    RAISE EXCEPTION 'evidence_records: an evidence foreign key is deferrable';
  END IF;

  -- Each NO ACTION check has an index on its referencing columns.
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indrelid = 'public.evidence_study_reports'::regclass
                    AND (SELECT array_agg(a.attname::text ORDER BY o.ord)
                           FROM unnest(i.indkey) WITH ORDINALITY AS o(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = o.attnum
                          WHERE o.ord <= 2) = ARRAY['user_id', 'paper_id']) THEN
    RAISE EXCEPTION 'evidence_records: no index serves edge (1) (user_id, paper_id)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indrelid = 'public.evidence_field_anchors'::regclass AND i.indpred IS NULL
                    AND (SELECT array_agg(a.attname::text ORDER BY o.ord)
                           FROM unnest(i.indkey) WITH ORDINALITY AS o(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = o.attnum
                          WHERE o.ord <= 4) = ARRAY['user_id', 'study_id', 'paper_id', 'snapshot_id']) THEN
    RAISE EXCEPTION 'evidence_records: no index serves edges (2) and (3)';
  END IF;

  -- The durable request key: unique, on (user_id, request_id), headers only.
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
    RAISE EXCEPTION 'evidence_records: evidence_events_request_header_key is not UNIQUE (user_id, request_id) WHERE ordinal = 0';
  END IF;

  -- No function was created: the write path belongs to later, reviewed PRs.
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'evidence\_%') THEN
    RAISE EXCEPTION 'evidence_records: an evidence function exists';
  END IF;

  -- The locks of section 1 are held by this transaction, in the reviewed mode.
  SELECT string_agg(l.relation::regclass::text || '=' || l.mode, ',' ORDER BY l.relation::regclass::text)
    INTO v_text
    FROM pg_locks l
   WHERE l.locktype = 'relation' AND l.pid = pg_backend_pid() AND l.granted
     AND l.relation IN ('auth.users'::regclass, 'public.papers'::regclass)
     AND l.mode = 'ShareRowExclusiveLock';
  IF v_text IS DISTINCT FROM 'auth.users=ShareRowExclusiveLock,public.papers=ShareRowExclusiveLock' THEN
    RAISE EXCEPTION 'evidence_records: the global-order locks are not held as reviewed (found %)', v_text;
  END IF;
END
$verify$;

COMMIT;
