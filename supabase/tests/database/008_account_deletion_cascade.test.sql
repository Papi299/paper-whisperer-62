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
--     through the papers they belong to, and the saved AI-model preference
--     (AI-MODEL-SELECTION-001A) whose catalog row must nonetheless survive;
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

SELECT plan(84);

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
SELECT is(
  (SELECT count(*)::int FROM public.paper_tags
    WHERE paper_id = 'c4000000-0000-0000-0000-0000000000a1'),
  1, 'pre-delete: doomed paper_tags link exists');
SELECT is(
  (SELECT count(*)::int FROM public.paper_projects
    WHERE paper_id = 'c4000000-0000-0000-0000-0000000000a1'),
  1, 'pre-delete: doomed paper_projects link exists');

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

SELECT * FROM finish();
ROLLBACK;
