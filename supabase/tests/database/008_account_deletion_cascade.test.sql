-- PFA-C04 suite 008: account-deletion cascade and retention contract.
--
-- This suite owns the database half of self-service account deletion. PFA-C04
-- deliberately adds NO deletion RPC and NO migration: the claim it rests on is
-- that removing a row from auth.users already removes every piece of the user's
-- Paperlume product data through the foreign keys that are already there. That
-- claim is a schema property, so it is asserted here rather than assumed.
--
-- Proves, against the live local schema:
--   * catalog contract — every user-linked public table's FK to auth.users
--     carries the ON DELETE behaviour PFA-C04 depends on, and no public FK
--     references auth.users with NO ACTION / RESTRICT (either would make the
--     Edge Function's auth.admin.deleteUser call fail outright);
--   * behavioural cascade — a synthetic Auth user with a representative row in
--     every owned table loses all of them when its auth.users row is deleted,
--     including the junction rows that own no user_id and are reached only
--     through the papers they belong to, the saved AI-model preference
--     (AI-MODEL-SELECTION-001A) whose catalog row must nonetheless survive, and
--     pending attachment-cleanup intent (ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001)
--     — which must cascade from auth.users while being reachable from no paper,
--     since an intent that died with its paper would be useless;
--   * deliberate retention — subscriptions.user_id and
--     subscription_events.user_id are ON DELETE SET NULL by design (C13
--     provider/audit history). Those rows survive with a NULL user_id and,
--     crucially, do NOT block the delete. This is an intentional current-schema
--     exception, not an oversight: no real provider data flows into these tables
--     today (C27 pauses billing), and the retention semantics must be
--     re-evaluated against legal/privacy requirements before commercial launch
--     if they ever hold real provider data. See docs/commercial-architecture.md;
--   * blast radius — a second, untouched account keeps every one of its rows, so
--     the cascade is scoped to the deleted user and to that user alone;
--   * study records (EVIDENCE-RECORDS-001A1) — the doomed account holds a study
--     record with all three ON DELETE NO ACTION edges populated (link -> paper,
--     reference -> link, reference -> copy), and the single DELETE still
--     succeeds and leaves no evidence row; it succeeds again with the RI trigger
--     order reversed; a negative control proves an uncleared NO ACTION edge
--     WOULD block the deletion; and two diagnostics pin why every evidence
--     table must cascade from auth.users directly (Part 7);
--   * Storage is NOT covered by the database — storage.objects has no cascading
--     FK to auth.users, which is exactly why the delete-account Edge Function
--     must remove attachment binaries through the Storage API *before* deleting
--     the Auth user. Asserted at the catalog level only: this suite never
--     inserts, updates or deletes a storage object.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. Every mutation happens inside this
-- transaction and rolls back with it, so the synthetic auth.users rows exist in
-- the local test database only. pgTAP is created inside the transaction and
-- rolled back with it, leaving the database's extension state unchanged.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- ON DELETE action of the single-column FK from public.<tbl>.<col> to
-- auth.users(id), decoded to a readable word. 'none' when no such FK exists.
CREATE FUNCTION pg_temp.auth_fk_action(p_table text, p_column text)
RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT COALESCE(
    (SELECT CASE c.confdeltype
              WHEN 'a' THEN 'no action'
              WHEN 'r' THEN 'restrict'
              WHEN 'c' THEN 'cascade'
              WHEN 'n' THEN 'set null'
              WHEN 'd' THEN 'set default'
            END
     FROM pg_constraint c
     JOIN pg_attribute a
       ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.conrelid = ('public.' || p_table)::regclass
       AND c.confrelid = 'auth.users'::regclass
       AND array_length(c.conkey, 1) = 1
       AND a.attname = p_column
     LIMIT 1),
    'none');
$hlp$;

-- ON DELETE action of the single-column FK from public.<tbl>.<col> to
-- public.<ref>(id). Used for the junction tables, which own no user_id and
-- inherit deletion entirely from the rows they point at.
CREATE FUNCTION pg_temp.rel_fk_action(p_table text, p_column text, p_ref text)
RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT COALESCE(
    (SELECT CASE c.confdeltype
              WHEN 'a' THEN 'no action'
              WHEN 'r' THEN 'restrict'
              WHEN 'c' THEN 'cascade'
              WHEN 'n' THEN 'set null'
              WHEN 'd' THEN 'set default'
            END
     FROM pg_constraint c
     JOIN pg_attribute a
       ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.conrelid = ('public.' || p_table)::regclass
       AND c.confrelid = ('public.' || p_ref)::regclass
       AND array_length(c.conkey, 1) = 1
       AND a.attname = p_column
     LIMIT 1),
    'none');
$hlp$;

-- Row count in a user-owned table, scoped to one user id.
CREATE FUNCTION pg_temp.rows_for(p_table text, p_user uuid)
RETURNS integer LANGUAGE plpgsql STABLE AS $hlp$
DECLARE n integer;
BEGIN
  EXECUTE format('SELECT count(*)::int FROM public.%I WHERE user_id = $1', p_table)
    INTO n USING p_user;
  RETURN n;
END;
$hlp$;

-- EVIDENCE-RECORDS-001A1 helpers ─────────────────────────────────────────────

-- Run p_sql, then evaluate p_check, then undo both by raising a sentinel in the
-- same subtransaction. '00000 <check>' on success, else '<SQLSTATE>[:<constraint>]'.
CREATE FUNCTION pg_temp.probe(p_sql text, p_check text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE
  v_state text;
  v_con   text;
  v_check text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    IF p_check IS NOT NULL THEN
      EXECUTE p_check INTO v_check;
    END IF;
    RAISE EXCEPTION 'evidence-008 probe undo' USING ERRCODE = 'P0E08';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_con = CONSTRAINT_NAME;
  END;
  IF v_state = 'P0E08' THEN
    RETURN '00000' || CASE WHEN p_check IS NOT NULL THEN ' ' || coalesce(v_check, '<null>') ELSE '' END;
  END IF;
  RETURN v_state || CASE WHEN coalesce(v_con, '') <> '' THEN ':' || v_con ELSE '' END;
END;
$hlp$;

-- Every evidence table's rows for one user, as one comparable string.
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

-- A complete study record for p_user on p_paper, written as the database owner
-- because no client write path exists (the RPCs come in 001A2/001A3). It
-- populates all three NO ACTION edges: the link -> paper, two references ->
-- link (a quote and a full-text locator), and the quote -> copy.
CREATE FUNCTION pg_temp.plant_evidence(p_user uuid, p_paper uuid) RETURNS void LANGUAGE plpgsql AS $hlp$
DECLARE
  v_study   uuid := md5(p_user::text || ':study')::uuid;
  v_copy    uuid := md5(p_user::text || ':copy')::uuid;
  v_arm     uuid := md5(p_user::text || ':arm')::uuid;
  v_outcome uuid := md5(p_user::text || ':outcome')::uuid;
  v_value   uuid := md5(p_user::text || ':value')::uuid;
  v_text    text := 'Planted abstract for the account-deletion cascade.';
BEGIN
  INSERT INTO public.evidence_studies (id, user_id, label, design_profile)
  VALUES (v_study, p_user, 'Planted study', 'rct_parallel');
  INSERT INTO public.evidence_study_reports (user_id, study_id, paper_id, link_status, link_basis)
  VALUES (p_user, v_study, p_paper, 'user_confirmed', 'created_from_paper');
  INSERT INTO public.evidence_source_snapshots
    (id, user_id, study_id, paper_id, seq, source_kind, exact_text, exact_sha256,
     normalized_sha256, normalization_version, char_count)
  VALUES (v_copy, p_user, v_study, p_paper, 1, 'library_abstract', v_text,
          sha256(convert_to(v_text, 'UTF8')), sha256(convert_to(v_text, 'UTF8')), 'v1',
          char_length(v_text));
  INSERT INTO public.evidence_arms (id, user_id, study_id, arm_role, display_label, position)
  VALUES (v_arm, p_user, v_study, 'intervention', 'Planted group', 0);
  INSERT INTO public.evidence_outcomes (id, user_id, study_id, display_label, position)
  VALUES (v_outcome, p_user, v_study, 'Planted outcome', 0);
  INSERT INTO public.evidence_field_values (id, user_id, study_id, field_key, value_state, value_text)
  VALUES (v_value, p_user, v_study, 'population_description', 'reported', 'Planted population');
  INSERT INTO public.evidence_field_values (user_id, study_id, arm_id, field_key, value_state, value_text)
  VALUES (p_user, v_study, v_arm, 'description', 'reported', 'Planted intervention');
  INSERT INTO public.evidence_field_anchors
    (user_id, study_id, value_id, paper_id, snapshot_id, purpose, source_kind, position,
     quote_text, match_start, match_end, match_occurrence, match_count, normalization_version, matched_at)
  VALUES (p_user, v_study, v_value, p_paper, v_copy, 'supports', 'abstract', 0,
          'Planted abstract', 0, 16, 1, 1, 'v1', now());
  INSERT INTO public.evidence_field_anchors
    (user_id, study_id, value_id, paper_id, purpose, source_kind, position, locator_kind, locator_text)
  VALUES (p_user, v_study, v_value, p_paper, 'supports', 'full_text', 1, 'page', '4');
  INSERT INTO public.evidence_events
    (user_id, study_id, study_version, ordinal, event_type, request_id, op, payload_sha256, result)
  VALUES (p_user, v_study, 1, 0, 'request', md5(p_user::text || ':request')::uuid, 'create_study',
          sha256('planted'::bytea), jsonb_build_object('status', 'applied', 'study_version', 1));
  INSERT INTO public.evidence_events (user_id, study_id, study_version, ordinal, event_type, request_id, target_id)
  VALUES (p_user, v_study, 1, 1, 'study_created', md5(p_user::text || ':request')::uuid, v_study);
END;
$hlp$;

-- The three NO ACTION edges a user's evidence populates: link -> paper,
-- reference -> link, reference -> copy.
CREATE FUNCTION pg_temp.evidence_edges(p_uid uuid) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT format('edges %s/%s/%s',
    (SELECT count(*) FROM public.evidence_study_reports r
       JOIN public.papers p ON p.user_id = r.user_id AND p.id = r.paper_id WHERE r.user_id = p_uid),
    (SELECT count(*) FROM public.evidence_field_anchors a
       JOIN public.evidence_study_reports r
         ON r.user_id = a.user_id AND r.study_id = a.study_id AND r.paper_id = a.paper_id WHERE a.user_id = p_uid),
    (SELECT count(*) FROM public.evidence_field_anchors a
       JOIN public.evidence_source_snapshots c
         ON c.user_id = a.user_id AND c.study_id = a.study_id AND c.paper_id = a.paper_id AND c.id = a.snapshot_id
      WHERE a.user_id = p_uid))
$hlp$;

-- The ON DELETE action trigger auth.users fires for the key from p_child.
-- Triggers on one table fire in name order, and an internal RI trigger is named
-- RI_ConstraintTrigger_a_<oid>, compared as text.
CREATE FUNCTION pg_temp.delete_trigger_of(p_child regclass) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT min(t.tgname::text COLLATE "C")
    FROM pg_trigger t JOIN pg_constraint c ON c.oid = t.tgconstraint
   WHERE t.tgrelid = 'auth.users'::regclass AND t.tgisinternal AND (t.tgtype & 8) <> 0
     AND c.conrelid = p_child
$hlp$;

-- Where the papers cascade fires relative to ALL eight evidence cascades.
CREATE FUNCTION pg_temp.papers_position() RETURNS text LANGUAGE sql STABLE AS $hlp$
  WITH e AS (
    SELECT min(pg_temp.delete_trigger_of(to_regclass('public.' || t)) COLLATE "C") AS lo,
           max(pg_temp.delete_trigger_of(to_regclass('public.' || t)) COLLATE "C") AS hi
      FROM unnest(ARRAY['evidence_studies', 'evidence_study_reports', 'evidence_source_snapshots',
                        'evidence_arms', 'evidence_outcomes', 'evidence_field_values',
                        'evidence_field_anchors', 'evidence_events']) AS t)
  SELECT CASE
           WHEN pg_temp.delete_trigger_of('public.papers') COLLATE "C" < e.lo THEN 'first'
           WHEN pg_temp.delete_trigger_of('public.papers') COLLATE "C" > e.hi THEN 'last'
           ELSE 'between'
         END
    FROM e
$hlp$;

-- Re-create papers -> auth.users with its exact definition, so its RI trigger
-- gets a newer OID and therefore a later name: the reverse firing order.
CREATE FUNCTION pg_temp.flip_papers_cascade_sql() RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT $q$
    DO $flip$
    DECLARE v_def text;
    BEGIN
      SELECT pg_get_constraintdef(k.oid) INTO STRICT v_def
        FROM pg_constraint k
       WHERE k.conrelid = 'public.papers'::regclass AND k.conname = 'papers_user_id_fkey';
      ALTER TABLE public.papers DROP CONSTRAINT papers_user_id_fkey;
      EXECUTE 'ALTER TABLE public.papers ADD CONSTRAINT papers_user_id_fkey ' || v_def;
    END
    $flip$;$q$
$hlp$;

-- A table cleared only in the SECOND generation of the account cascade: it
-- cascades from a study, not from auth.users, and holds a NO ACTION key to
-- papers. Created only inside a probe.
CREATE FUNCTION pg_temp.gen2_table_sql() RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT $q$
    CREATE SCHEMA evidence_008_diag;
    CREATE TABLE evidence_008_diag.gen2_links (
      user_id  uuid NOT NULL,
      study_id uuid NOT NULL,
      paper_id uuid NOT NULL,
      CONSTRAINT evidence_008_gen2_study_fkey FOREIGN KEY (user_id, study_id)
        REFERENCES public.evidence_studies (user_id, id) ON DELETE CASCADE,
      CONSTRAINT evidence_008_gen2_paper_fkey FOREIGN KEY (user_id, paper_id)
        REFERENCES public.papers (user_id, id) ON DELETE NO ACTION);
    INSERT INTO evidence_008_diag.gen2_links
    VALUES ('c4000000-0000-0000-0000-0000000000d3', md5('c4000000-0000-0000-0000-0000000000d3:study')::uuid,
            'c4000000-0000-0000-0000-0000000000a3');$q$
$hlp$;

SELECT plan(114);

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 1 — catalog contract
-- ─────────────────────────────────────────────────────────────────────────────

-- Directly user-owned product data: must cascade from auth.users.
SELECT is(pg_temp.auth_fk_action('profiles', 'user_id'), 'cascade',
  'profiles.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('papers', 'user_id'), 'cascade',
  'papers.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('projects', 'user_id'), 'cascade',
  'projects.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('tags', 'user_id'), 'cascade',
  'tags.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('filter_presets', 'user_id'), 'cascade',
  'filter_presets.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('keyword_pool', 'user_id'), 'cascade',
  'keyword_pool.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('synonym_pool', 'user_id'), 'cascade',
  'synonym_pool.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('study_type_pool', 'user_id'), 'cascade',
  'study_type_pool.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('keyword_exclusion_pool', 'user_id'), 'cascade',
  'keyword_exclusion_pool.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('study_type_exclusion_pool', 'user_id'), 'cascade',
  'study_type_exclusion_pool.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('paper_attachments', 'user_id'), 'cascade',
  'paper_attachments.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('user_entitlements', 'user_id'), 'cascade',
  'user_entitlements.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('usage_counters', 'user_id'), 'cascade',
  'usage_counters.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('usage_credits', 'user_id'), 'cascade',
  'usage_credits.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('user_storage_usage', 'user_id'), 'cascade',
  'user_storage_usage.user_id cascades from auth.users');
-- An internal owner/manager grant is account data like any other: PFA-C04 adds
-- no exemption for it, so it must cascade with the rest.
SELECT is(pg_temp.auth_fk_action('internal_user_access', 'user_id'), 'cascade',
  'internal_user_access.user_id cascades from auth.users');
-- AI-MODEL-SELECTION-001A. A saved AI-model preference is a user setting, so it
-- leaves with the account. Note it references ai_model_catalog on the other
-- side, and that FK is deliberately NO ACTION — but only in the catalog
-- direction, which is why deleting the USER is still unobstructed.
SELECT is(pg_temp.auth_fk_action('user_ai_preferences', 'user_id'), 'cascade',
  'user_ai_preferences.user_id cascades from auth.users');
-- ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001. Pending Storage-cleanup intent is
-- user-scoped operational state and leaves with the account like everything
-- else. It is excluded from the portability ARCHIVE (see
-- src/lib/accountExport/types.ts) — which is a different question entirely, and
-- this cascade is why exclusion there costs the user nothing.
SELECT is(pg_temp.auth_fk_action('attachment_cleanup_queue', 'user_id'), 'cascade',
  'attachment_cleanup_queue.user_id cascades from auth.users');
-- CORRECTION-02. The tombstone is the same state one step further from the user
-- — the permanent record that an uploaded object was finalized as garbage, kept
-- after the queue row for it was acknowledged. It is durable ON PURPOSE, so its
-- cascade is the only thing that bounds how long it lives.
SELECT is(pg_temp.auth_fk_action('attachment_cleanup_tombstone', 'user_id'), 'cascade',
  'attachment_cleanup_tombstone.user_id cascades from auth.users');
-- And it must NOT be reachable from papers: an intent that cascaded away with
-- the paper whose deletion created it would be destroyed by the exact statement
-- it exists to outlive.
-- AI-MULTI-PROVIDER-001D. Provider-usage telemetry names the user it served, so
-- it leaves with the account: no pseudonymous usage trace outlives a hard
-- deletion. Retaining it would be an owner/privacy decision, not a default.
SELECT is(pg_temp.auth_fk_action('ai_provider_usage_events', 'user_id'), 'cascade',
  'ai_provider_usage_events.user_id cascades from auth.users');
-- EVIDENCE-RECORDS-001A1. Study records are the user's own work, so they leave
-- with the account — and each of the eight tables cascades from auth.users
-- DIRECTLY. That is load-bearing, not tidy: three of their keys are ON DELETE
-- NO ACTION, and PostgreSQL runs a NO ACTION check raised by a cascaded delete
-- only after every first-generation cascade has finished. A table reached only
-- through a second-generation cascade would pass or fail by RI trigger-name
-- order (Part 7, G1/G2).
SELECT is(pg_temp.auth_fk_action('evidence_studies', 'user_id'), 'cascade',
  'evidence_studies.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('evidence_study_reports', 'user_id'), 'cascade',
  'evidence_study_reports.user_id cascades from auth.users (directly, not only via its study)');
SELECT is(pg_temp.auth_fk_action('evidence_source_snapshots', 'user_id'), 'cascade',
  'evidence_source_snapshots.user_id cascades from auth.users (directly, not only via its link)');
SELECT is(pg_temp.auth_fk_action('evidence_arms', 'user_id'), 'cascade',
  'evidence_arms.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('evidence_outcomes', 'user_id'), 'cascade',
  'evidence_outcomes.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('evidence_field_values', 'user_id'), 'cascade',
  'evidence_field_values.user_id cascades from auth.users');
SELECT is(pg_temp.auth_fk_action('evidence_field_anchors', 'user_id'), 'cascade',
  'evidence_field_anchors.user_id cascades from auth.users (directly, not only via its value)');
SELECT is(pg_temp.auth_fk_action('evidence_events', 'user_id'), 'cascade',
  'evidence_events.user_id cascades from auth.users (history leaves with the account)');
SELECT is(
  (SELECT count(*)::int FROM pg_constraint
    WHERE contype='f' AND conrelid='public.attachment_cleanup_queue'::regclass
      AND confrelid IN ('public.papers'::regclass,'public.paper_attachments'::regclass)),
  0, 'attachment_cleanup_queue has no FK to papers/paper_attachments (intent outlives them)');
SELECT is(
  (SELECT count(*)::int FROM pg_constraint
    WHERE contype='f' AND conrelid='public.attachment_cleanup_tombstone'::regclass
      AND confrelid IN ('public.papers'::regclass,'public.paper_attachments'::regclass)),
  0, 'attachment_cleanup_tombstone has no FK to papers/paper_attachments');

-- Junction tables carry no user_id; they are removed via their paper/tag/project.
SELECT is(pg_temp.auth_fk_action('paper_tags', 'user_id'), 'none',
  'paper_tags has no direct auth.users link (owned via papers)');
SELECT is(pg_temp.auth_fk_action('paper_projects', 'user_id'), 'none',
  'paper_projects has no direct auth.users link (owned via papers)');
SELECT is(pg_temp.rel_fk_action('paper_tags', 'paper_id', 'papers'), 'cascade',
  'paper_tags.paper_id cascades from papers');
SELECT is(pg_temp.rel_fk_action('paper_tags', 'tag_id', 'tags'), 'cascade',
  'paper_tags.tag_id cascades from tags');
SELECT is(pg_temp.rel_fk_action('paper_projects', 'paper_id', 'papers'), 'cascade',
  'paper_projects.paper_id cascades from papers');
SELECT is(pg_temp.rel_fk_action('paper_projects', 'project_id', 'projects'), 'cascade',
  'paper_projects.project_id cascades from projects');
SELECT is(pg_temp.rel_fk_action('paper_attachments', 'paper_id', 'papers'), 'cascade',
  'paper_attachments.paper_id cascades from papers');

-- Deliberate provider/audit-history retention (C13). Documented exception.
SELECT is(pg_temp.auth_fk_action('subscriptions', 'user_id'), 'set null',
  'subscriptions.user_id is intentionally ON DELETE SET NULL (retained history)');
SELECT is(pg_temp.auth_fk_action('subscription_events', 'user_id'), 'set null',
  'subscription_events.user_id is intentionally ON DELETE SET NULL (retained history)');
-- internal_user_access.created_by records who granted the role, not whose data
-- it is; unlinking rather than cascading is intentional.
SELECT is(pg_temp.auth_fk_action('internal_user_access', 'created_by'), 'set null',
  'internal_user_access.created_by is intentionally ON DELETE SET NULL');

-- The load-bearing global invariant: nothing in the public schema may block a
-- hard Auth deletion. A future table added with a default (NO ACTION) FK to
-- auth.users would break self-service deletion silently — this fails instead.
SELECT is(
  (SELECT count(*)::int
     FROM pg_constraint c
     JOIN pg_class rel ON rel.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE c.contype = 'f'
      AND c.confrelid = 'auth.users'::regclass
      AND n.nspname = 'public'
      AND c.confdeltype IN ('a', 'r')),
  0, 'no public FK to auth.users can block a hard account deletion');

-- Storage binaries are outside the database cascade. This is the schema fact
-- that makes the Edge Function's Storage-before-Auth step mandatory rather than
-- merely tidy.
SELECT is(
  (SELECT count(*)::int
     FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.conrelid = 'storage.objects'::regclass
      AND c.confrelid = 'auth.users'::regclass
      AND c.confdeltype = 'c'),
  0, 'storage.objects does not cascade from auth.users — Storage needs the API');

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 2 — fixtures
-- ─────────────────────────────────────────────────────────────────────────────
-- DOOMED is the account PFA-C04 deletes; KEEPER is an untouched neighbour that
-- must survive intact. Inserting into auth.users fires handle_new_user, which
-- seeds a profile, a Free entitlement and a lifetime usage counter for each.

INSERT INTO auth.users (id, email) VALUES
  ('c4000000-0000-0000-0000-0000000000d1', 'pfa-c04-doomed@paperlume.test'),
  ('c4000000-0000-0000-0000-0000000000d2', 'pfa-c04-keeper@paperlume.test');

INSERT INTO public.papers (id, user_id, title, insert_order) VALUES
  ('c4000000-0000-0000-0000-0000000000a1', 'c4000000-0000-0000-0000-0000000000d1', 'Doomed paper', 1),
  ('c4000000-0000-0000-0000-0000000000a2', 'c4000000-0000-0000-0000-0000000000d2', 'Keeper paper', 2);

INSERT INTO public.projects (id, user_id, name) VALUES
  ('c4000000-0000-0000-0000-0000000000b1', 'c4000000-0000-0000-0000-0000000000d1', 'Doomed project'),
  ('c4000000-0000-0000-0000-0000000000b2', 'c4000000-0000-0000-0000-0000000000d2', 'Keeper project');

INSERT INTO public.tags (id, user_id, name) VALUES
  ('c4000000-0000-0000-0000-0000000000c1', 'c4000000-0000-0000-0000-0000000000d1', 'Doomed tag'),
  ('c4000000-0000-0000-0000-0000000000c2', 'c4000000-0000-0000-0000-0000000000d2', 'Keeper tag');

INSERT INTO public.paper_tags (paper_id, tag_id) VALUES
  ('c4000000-0000-0000-0000-0000000000a1', 'c4000000-0000-0000-0000-0000000000c1'),
  ('c4000000-0000-0000-0000-0000000000a2', 'c4000000-0000-0000-0000-0000000000c2');

INSERT INTO public.paper_projects (paper_id, project_id) VALUES
  ('c4000000-0000-0000-0000-0000000000a1', 'c4000000-0000-0000-0000-0000000000b1'),
  ('c4000000-0000-0000-0000-0000000000a2', 'c4000000-0000-0000-0000-0000000000b2');

INSERT INTO public.filter_presets (user_id, name, payload) VALUES
  ('c4000000-0000-0000-0000-0000000000d1', 'Doomed preset', '{"version":3}'::jsonb),
  ('c4000000-0000-0000-0000-0000000000d2', 'Keeper preset', '{"version":3}'::jsonb);

INSERT INTO public.keyword_pool (user_id, keyword) VALUES
  ('c4000000-0000-0000-0000-0000000000d1', 'oncology'),
  ('c4000000-0000-0000-0000-0000000000d2', 'oncology');

INSERT INTO public.synonym_pool (user_id, canonical_term, synonyms) VALUES
  ('c4000000-0000-0000-0000-0000000000d1', 'cancer', ARRAY['neoplasm']),
  ('c4000000-0000-0000-0000-0000000000d2', 'cancer', ARRAY['neoplasm']);

INSERT INTO public.study_type_pool (user_id, study_type) VALUES
  ('c4000000-0000-0000-0000-0000000000d1', 'Cohort Study'),
  ('c4000000-0000-0000-0000-0000000000d2', 'Cohort Study');

INSERT INTO public.keyword_exclusion_pool (user_id, keyword) VALUES
  ('c4000000-0000-0000-0000-0000000000d1', 'editorial'),
  ('c4000000-0000-0000-0000-0000000000d2', 'editorial');

INSERT INTO public.study_type_exclusion_pool (user_id, study_type) VALUES
  ('c4000000-0000-0000-0000-0000000000d1', 'Comment'),
  ('c4000000-0000-0000-0000-0000000000d2', 'Comment');

-- Attachment metadata only — no Storage object is created here; Storage binaries
-- are the Edge Function's job and are never manipulated by SQL. The BEFORE
-- INSERT quota trigger enforces `auth.uid() = NEW.user_id` (PFA-C03B1
-- remediation), so each row is inserted under its own owner's claims, exactly as
-- the caller-authenticated client path does. That trigger also materializes the
-- user_storage_usage row, which is the state a real account is in.
SELECT set_config('request.jwt.claims',
  '{"sub":"c4000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
INSERT INTO public.paper_attachments (paper_id, user_id, file_path, file_name, file_type, size_bytes) VALUES
  ('c4000000-0000-0000-0000-0000000000a1', 'c4000000-0000-0000-0000-0000000000d1',
   'c4000000-0000-0000-0000-0000000000d1/c4000000-0000-0000-0000-0000000000a1/doomed.pdf',
   'doomed.pdf', 'application/pdf', 2048);

SELECT set_config('request.jwt.claims',
  '{"sub":"c4000000-0000-0000-0000-0000000000d2","role":"authenticated"}', true);
INSERT INTO public.paper_attachments (paper_id, user_id, file_path, file_name, file_type, size_bytes) VALUES
  ('c4000000-0000-0000-0000-0000000000a2', 'c4000000-0000-0000-0000-0000000000d2',
   'c4000000-0000-0000-0000-0000000000d2/c4000000-0000-0000-0000-0000000000a2/keeper.pdf',
   'keeper.pdf', 'application/pdf', 2048);

SELECT set_config('request.jwt.claims', '', true);

-- Pending attachment cleanup for each user (ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001).
-- Planted as the owner because the table has no client INSERT path at all: in
-- production these rows appear only from inside the cleanup RPCs. What this
-- suite is asserting is the cascade, not how the row got there.
INSERT INTO public.attachment_cleanup_queue (user_id, file_path, reason) VALUES
  ('c4000000-0000-0000-0000-0000000000d1',
   'c4000000-0000-0000-0000-0000000000d1/c4000000-0000-0000-0000-0000000000a1/pending-doomed.pdf',
   'paper_delete'),
  ('c4000000-0000-0000-0000-0000000000d2',
   'c4000000-0000-0000-0000-0000000000d2/c4000000-0000-0000-0000-0000000000a2/pending-keeper.pdf',
   'paper_delete');

-- The permanent cleanup decision for each user, same reasoning as above.
INSERT INTO public.attachment_cleanup_tombstone (user_id, file_path) VALUES
  ('c4000000-0000-0000-0000-0000000000d1',
   'c4000000-0000-0000-0000-0000000000d1/c4000000-0000-0000-0000-0000000000a1/finalized-doomed.pdf'),
  ('c4000000-0000-0000-0000-0000000000d2',
   'c4000000-0000-0000-0000-0000000000d2/c4000000-0000-0000-0000-0000000000a2/finalized-keeper.pdf');

INSERT INTO public.usage_credits (user_id, source, quantity_granted, quantity_remaining) VALUES
  ('c4000000-0000-0000-0000-0000000000d1', 'manual_grant', 10, 10),
  ('c4000000-0000-0000-0000-0000000000d2', 'manual_grant', 10, 10);

INSERT INTO public.internal_user_access (user_id, role, ai_quota_exempt, created_by) VALUES
  ('c4000000-0000-0000-0000-0000000000d1', 'manager', false,
   'c4000000-0000-0000-0000-0000000000d2');

-- A saved AI-model preference for each user. Both point at the SAME catalog row
-- on purpose: the doomed user's preference must go while the neighbour's stays,
-- and the shared catalog row must survive both.
INSERT INTO public.user_ai_preferences (user_id, preferred_model_id) VALUES
  ('c4000000-0000-0000-0000-0000000000d1', 'google/gemini-3.5-flash'),
  ('c4000000-0000-0000-0000-0000000000d2', 'google/gemini-3.5-flash');

-- One provider-usage event for each user (AI-MULTI-PROVIDER-001D). Planted as
-- the owner: in production only the generation functions' server key writes
-- these. A content-free row, exactly as the runtime builds it.
INSERT INTO public.ai_provider_usage_events
  (occurred_at, user_id, telemetry_version, operation, provider, provider_model,
   model_selection_source, reasoning_source, resolved_reasoning_level,
   provider_outcome, provider_attempts, operation_outcome, usage_status,
   input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
   provider_total_tokens, has_unmodeled_usage, cost_status)
SELECT '2026-10-01T12:00:00Z', u, 1, 'analyze', 'google', 'gemini-flash-latest',
       'system_default', 'provider_default_fallback', NULL,
       'completed', 1, 'succeeded', 'reported',
       1200, 0, 190, 40, 1390, false, 'unpriced'
  FROM unnest(ARRAY['c4000000-0000-0000-0000-0000000000d1',
                    'c4000000-0000-0000-0000-0000000000d2']::uuid[]) AS u;

-- EVIDENCE-RECORDS-001A1. A study record on each user's paper, every NO ACTION
-- edge populated. Planted as the owner: no client write path exists yet.
SELECT pg_temp.plant_evidence('c4000000-0000-0000-0000-0000000000d1', 'c4000000-0000-0000-0000-0000000000a1');
SELECT pg_temp.plant_evidence('c4000000-0000-0000-0000-0000000000d2', 'c4000000-0000-0000-0000-0000000000a2');

-- A second doomed account for Part 7, deleted only inside probes (always undone).
INSERT INTO auth.users (id, email) VALUES
  ('c4000000-0000-0000-0000-0000000000d3', 'pfa-c04-doomed-2@paperlume.test');
INSERT INTO public.papers (id, user_id, title, insert_order) VALUES
  ('c4000000-0000-0000-0000-0000000000a3', 'c4000000-0000-0000-0000-0000000000d3', 'Second doomed paper', 3);
SELECT pg_temp.plant_evidence('c4000000-0000-0000-0000-0000000000d3', 'c4000000-0000-0000-0000-0000000000a3');

-- Retained provider/audit history for the doomed user.
INSERT INTO public.subscriptions (id, user_id, provider, status) VALUES
  ('c4000000-0000-0000-0000-0000000000e1', 'c4000000-0000-0000-0000-0000000000d1',
   'manual', 'active');

INSERT INTO public.subscription_events
  (id, provider, provider_event_id, event_type, user_id, subscription_id, payload) VALUES
  ('c4000000-0000-0000-0000-0000000000e2', 'manual', 'pfa-c04-evt-1', 'subscription.created',
   'c4000000-0000-0000-0000-0000000000d1', 'c4000000-0000-0000-0000-0000000000e1', '{}'::jsonb);

-- Positive controls: every fixture really exists before the delete, so a later
-- "zero rows" assertion cannot pass merely because nothing was created.
SELECT is(pg_temp.rows_for('profiles', 'c4000000-0000-0000-0000-0000000000d1'), 1,
  'pre-delete: doomed profile exists');
SELECT is(pg_temp.rows_for('papers', 'c4000000-0000-0000-0000-0000000000d1'), 1,
  'pre-delete: doomed paper exists');
SELECT is(pg_temp.rows_for('paper_attachments', 'c4000000-0000-0000-0000-0000000000d1'), 1,
  'pre-delete: doomed attachment metadata exists');
SELECT is(pg_temp.rows_for('user_entitlements', 'c4000000-0000-0000-0000-0000000000d1'), 1,
  'pre-delete: doomed entitlement exists (signup trigger)');
SELECT cmp_ok(pg_temp.rows_for('usage_counters', 'c4000000-0000-0000-0000-0000000000d1'), '>=', 1,
  'pre-delete: doomed usage counter exists (signup trigger)');
SELECT is(pg_temp.rows_for('user_storage_usage', 'c4000000-0000-0000-0000-0000000000d1'), 1,
  'pre-delete: doomed storage-usage row exists (quota trigger)');
SELECT is(pg_temp.rows_for('internal_user_access', 'c4000000-0000-0000-0000-0000000000d1'), 1,
  'pre-delete: doomed internal access row exists');
SELECT is(pg_temp.rows_for('user_ai_preferences', 'c4000000-0000-0000-0000-0000000000d1'), 1,
  'pre-delete: doomed AI-model preference exists');
SELECT is(pg_temp.rows_for('attachment_cleanup_queue', 'c4000000-0000-0000-0000-0000000000d1'), 1,
  'pre-delete: doomed pending attachment cleanup exists');
SELECT is(pg_temp.rows_for('attachment_cleanup_tombstone', 'c4000000-0000-0000-0000-0000000000d1'), 1,
  'pre-delete: doomed cleanup tombstone exists');
SELECT is(pg_temp.rows_for('ai_provider_usage_events', 'c4000000-0000-0000-0000-0000000000d1'), 1,
  'pre-delete: doomed provider-usage event exists');
SELECT is(
  (SELECT count(*)::int FROM public.paper_tags
    WHERE paper_id = 'c4000000-0000-0000-0000-0000000000a1'),
  1, 'pre-delete: doomed paper_tags link exists');
SELECT is(
  (SELECT count(*)::int FROM public.paper_projects
    WHERE paper_id = 'c4000000-0000-0000-0000-0000000000a1'),
  1, 'pre-delete: doomed paper_projects link exists');

SELECT is(
  pg_temp.evidence_rows('c4000000-0000-0000-0000-0000000000d1') || ' '
  || pg_temp.evidence_edges('c4000000-0000-0000-0000-0000000000d1'),
  'studies=1 links=1 copies=1 arms=1 outcomes=1 values=2 refs=2 events=2 edges 1/2/1',
  'pre-delete: doomed holds a study record with all three NO ACTION edges populated (link->paper, reference->link, quote->copy)');
-- AD1 runs in the order the migrations left the triggers in: the papers
-- cascade first. Part 7 reverses it.
SELECT is(pg_temp.papers_position(), 'first',
  'AD1 order: the papers cascade fires before every evidence cascade (the order the migrations create)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 3 — the deletion, exactly as the Edge Function performs it
-- ─────────────────────────────────────────────────────────────────────────────
-- auth.admin.deleteUser(userId, false) removes this row. No RPC, no extra
-- statement, no per-table cleanup: if this single delete is not sufficient,
-- PFA-C04's no-migration premise is wrong and the assertions below fail.

SELECT lives_ok(
  $q$DELETE FROM auth.users WHERE id = 'c4000000-0000-0000-0000-0000000000d1'$q$,
  'deleting the auth.users row succeeds with owned data and Storage metadata present');

SELECT is(
  (SELECT count(*)::int FROM auth.users WHERE id = 'c4000000-0000-0000-0000-0000000000d1'),
  0, 'the Auth user is gone (hard delete, not a soft delete)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 4 — every owned row is gone
-- ─────────────────────────────────────────────────────────────────────────────

SELECT is(pg_temp.rows_for('profiles', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: profile removed');
SELECT is(pg_temp.rows_for('papers', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: papers removed');
SELECT is(pg_temp.rows_for('projects', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: projects removed');
SELECT is(pg_temp.rows_for('tags', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: tags removed');
SELECT is(pg_temp.rows_for('filter_presets', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: filter presets removed');
SELECT is(pg_temp.rows_for('keyword_pool', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: keyword pool removed');
SELECT is(pg_temp.rows_for('synonym_pool', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: synonym pool removed');
SELECT is(pg_temp.rows_for('study_type_pool', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: study-type pool removed');
SELECT is(pg_temp.rows_for('keyword_exclusion_pool', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: keyword exclusion pool removed');
SELECT is(pg_temp.rows_for('study_type_exclusion_pool', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: study-type exclusion pool removed');
SELECT is(pg_temp.rows_for('paper_attachments', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: attachment metadata removed');
SELECT is(pg_temp.rows_for('user_entitlements', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: entitlement removed');
SELECT is(pg_temp.rows_for('usage_counters', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: usage counters removed');
SELECT is(pg_temp.rows_for('usage_credits', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: usage credits removed');
SELECT is(pg_temp.rows_for('user_storage_usage', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: storage-usage accounting removed');
SELECT is(pg_temp.rows_for('internal_user_access', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: internal owner/manager access removed (no exemption)');
SELECT is(pg_temp.rows_for('user_ai_preferences', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: saved AI-model preference removed');
SELECT is(pg_temp.rows_for('attachment_cleanup_queue', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: pending attachment-cleanup intent removed');
SELECT is(pg_temp.rows_for('attachment_cleanup_tombstone', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: permanent cleanup tombstone removed');
SELECT is(pg_temp.rows_for('ai_provider_usage_events', 'c4000000-0000-0000-0000-0000000000d1'), 0,
  'cascade: provider-usage telemetry removed (no pseudonymous trace survives)');

SELECT is(pg_temp.evidence_rows('c4000000-0000-0000-0000-0000000000d1'),
  'studies=0 links=0 copies=0 arms=0 outcomes=0 values=0 refs=0 events=0',
  'AD1 cascade: every evidence row is gone, despite three populated NO ACTION edges — copies and history included');

-- Junction rows own no user_id, so they are the easiest thing to leave behind.
SELECT is(
  (SELECT count(*)::int FROM public.paper_tags
    WHERE paper_id = 'c4000000-0000-0000-0000-0000000000a1'),
  0, 'cascade: paper_tags links removed via the paper');
SELECT is(
  (SELECT count(*)::int FROM public.paper_projects
    WHERE paper_id = 'c4000000-0000-0000-0000-0000000000a1'),
  0, 'cascade: paper_projects links removed via the paper');

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 5 — deliberate provider/audit-history retention
-- ─────────────────────────────────────────────────────────────────────────────
-- These rows are NOT user-authored Paperlume content. They are unlinked, not
-- deleted, and they never obstruct the deletion.

SELECT is(
  (SELECT count(*)::int FROM public.subscriptions
    WHERE id = 'c4000000-0000-0000-0000-0000000000e1'),
  1, 'retention: the subscription row survives the account deletion');
SELECT ok(
  (SELECT user_id IS NULL FROM public.subscriptions
    WHERE id = 'c4000000-0000-0000-0000-0000000000e1'),
  'retention: the surviving subscription row is unlinked (user_id set to NULL)');
SELECT is(
  (SELECT count(*)::int FROM public.subscription_events
    WHERE id = 'c4000000-0000-0000-0000-0000000000e2'),
  1, 'retention: the subscription event survives the account deletion');
SELECT ok(
  (SELECT user_id IS NULL FROM public.subscription_events
    WHERE id = 'c4000000-0000-0000-0000-0000000000e2'),
  'retention: the surviving subscription event is unlinked (user_id set to NULL)');
SELECT is(
  (SELECT count(*)::int FROM public.subscriptions WHERE user_id IS NOT NULL),
  0, 'retention: no surviving subscription still points at a deleted user');

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 6 — blast radius
-- ─────────────────────────────────────────────────────────────────────────────
-- Deleting one account must not touch another. Every keeper fixture is still
-- there, including the junction rows and the trigger-seeded commercial rows.

SELECT is(
  (SELECT count(*)::int FROM auth.users WHERE id = 'c4000000-0000-0000-0000-0000000000d2'),
  1, 'blast radius: the neighbouring Auth user is untouched');
SELECT is(pg_temp.rows_for('profiles', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour profile intact');
SELECT is(pg_temp.rows_for('papers', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour papers intact');
SELECT is(pg_temp.rows_for('projects', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour projects intact');
SELECT is(pg_temp.rows_for('tags', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour tags intact');
SELECT is(pg_temp.rows_for('filter_presets', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour filter presets intact');
SELECT is(pg_temp.rows_for('keyword_pool', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour keyword pool intact');
SELECT is(pg_temp.rows_for('synonym_pool', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour synonym pool intact');
SELECT is(pg_temp.rows_for('study_type_pool', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour study-type pool intact');
SELECT is(pg_temp.rows_for('keyword_exclusion_pool', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour keyword exclusion pool intact');
SELECT is(pg_temp.rows_for('study_type_exclusion_pool', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour study-type exclusion pool intact');
SELECT is(pg_temp.rows_for('paper_attachments', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour attachment metadata intact');
SELECT is(pg_temp.rows_for('user_entitlements', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour entitlement intact');
SELECT is(pg_temp.rows_for('user_ai_preferences', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour AI-model preference intact');
SELECT is(pg_temp.rows_for('attachment_cleanup_queue', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour pending attachment cleanup intact');
SELECT is(pg_temp.rows_for('attachment_cleanup_tombstone', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour cleanup tombstone intact');
SELECT is(pg_temp.rows_for('ai_provider_usage_events', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour provider-usage telemetry intact');
-- The catalog is product metadata, not account data: deleting a user who had
-- chosen a model must not retire the model for everyone else.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id = 'google/gemini-3.5-flash'), 1,
  'blast radius: the shared catalog row survives the account deletion');
SELECT is(pg_temp.rows_for('usage_credits', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour usage credits intact');
SELECT is(pg_temp.rows_for('user_storage_usage', 'c4000000-0000-0000-0000-0000000000d2'), 1,
  'blast radius: neighbour storage-usage accounting intact');
SELECT is(
  (SELECT count(*)::int FROM public.paper_tags
    WHERE paper_id = 'c4000000-0000-0000-0000-0000000000a2'),
  1, 'blast radius: neighbour paper_tags link intact');
SELECT is(
  (SELECT count(*)::int FROM public.paper_projects
    WHERE paper_id = 'c4000000-0000-0000-0000-0000000000a2'),
  1, 'blast radius: neighbour paper_projects link intact');

SELECT is(pg_temp.evidence_rows('c4000000-0000-0000-0000-0000000000d2') || ' '
          || pg_temp.evidence_edges('c4000000-0000-0000-0000-0000000000d2'),
  'studies=1 links=1 copies=1 arms=1 outcomes=1 values=2 refs=2 events=2 edges 1/2/1',
  'blast radius: neighbour study record intact, every edge still in place');

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 7 — study records: the reverse trigger order, the negative control, and
-- the generation diagnostics (EVIDENCE-RECORDS-001A1)
-- ─────────────────────────────────────────────────────────────────────────────
-- Every probe below is undone, so the second doomed account starts each one
-- with its full record and its paper.

-- AD2. Reverse the order: the papers cascade now fires AFTER every evidence
-- cascade. The deletion must still succeed.
SELECT is(
  pg_temp.probe(
    pg_temp.flip_papers_cascade_sql()
      || $q$ DELETE FROM auth.users WHERE id = 'c4000000-0000-0000-0000-0000000000d3';$q$,
    $c$SELECT pg_temp.papers_position() || ' ' || pg_temp.evidence_rows('c4000000-0000-0000-0000-0000000000d3')
           || ' papers=' || (SELECT count(*) FROM public.papers WHERE user_id = 'c4000000-0000-0000-0000-0000000000d3')
           || ' | ' || pg_temp.evidence_rows('c4000000-0000-0000-0000-0000000000d2')$c$),
  '00000 last studies=0 links=0 copies=0 arms=0 outcomes=0 values=0 refs=0 events=0 papers=0 | '
  || 'studies=1 links=1 copies=1 arms=1 outcomes=1 values=2 refs=2 events=2',
  'AD2 with the papers cascade firing LAST, account deletion still succeeds and clears every evidence row; the neighbour is untouched');

-- N1. Negative control: the same deletion with one NO ACTION edge to papers that
-- nothing clears in the first generation MUST be refused. Proves this suite can
-- see a blocked deletion, so the successes above are not vacuous.
SELECT is(
  pg_temp.probe($q$
    CREATE SCHEMA evidence_008_diag;
    CREATE TABLE evidence_008_diag.uncleared_links (
      user_id  uuid NOT NULL,
      paper_id uuid NOT NULL,
      CONSTRAINT evidence_008_uncleared_paper_fkey FOREIGN KEY (user_id, paper_id)
        REFERENCES public.papers (user_id, id) ON DELETE NO ACTION);
    INSERT INTO evidence_008_diag.uncleared_links
    VALUES ('c4000000-0000-0000-0000-0000000000d3', 'c4000000-0000-0000-0000-0000000000a3');
    DELETE FROM auth.users WHERE id = 'c4000000-0000-0000-0000-0000000000d3';$q$),
  '23503:evidence_008_uncleared_paper_fkey',
  'N1 negative control: an uncleared NO ACTION edge to papers blocks account deletion');

-- G1/G2. Why every evidence table cascades from auth.users DIRECTLY. A table
-- cleared only in the second generation (it cascades from a study) carries a
-- NO ACTION key to papers. Its outcome is decided by RI trigger-name order:
-- with the papers cascade first, the papers check runs before the study
-- cascade reaches the row and the deletion fails; with it last, it succeeds.
-- If PostgreSQL ever changes when these checks fire, these fail and say so.
SELECT is(
  pg_temp.probe(pg_temp.gen2_table_sql()
    || $q$ DELETE FROM auth.users WHERE id = 'c4000000-0000-0000-0000-0000000000d3';$q$),
  CASE WHEN pg_temp.papers_position() = 'first' THEN '23503:evidence_008_gen2_paper_fkey' ELSE '00000' END,
  'G1 diagnostic: in the migration order, a second-generation-only table blocks account deletion, exactly as trigger order predicts');
SELECT is(
  pg_temp.probe(pg_temp.flip_papers_cascade_sql() || pg_temp.gen2_table_sql()
      || $q$ DELETE FROM auth.users WHERE id = 'c4000000-0000-0000-0000-0000000000d3';$q$,
    $c$SELECT pg_temp.papers_position()$c$),
  '00000 last',
  'G2 diagnostic: in the reverse order the same table no longer blocks it — the result depends on order, which is why no evidence table relies on it');

SELECT * FROM finish();
ROLLBACK;
