-- AI-MODEL-CATALOG-REFRESH-001 suite 028: the three replacement models.
--
-- Owns the database half of Phase A (20260930203613), which staged Claude
-- Sonnet 5.5, Claude Opus 5.5 and GPT-6.1 Sol in `public.ai_model_catalog` as
-- ENABLED but NOT SELECTABLE and NOT open to manual reasoning — and, since
-- Phase D (20261001092335) opened all three, what those rows durably ARE.
--
-- ## Where the boundary with the older suites is
--
-- Every database suite runs against the FINAL migration state, so the catalog
-- suites were rescoped rather than softened each time the list moved:
--
--   * 012 still owns the catalog as a LIST — now seven rows, in final order;
--   * 016 still owns the reasoning VOCABULARY constraints and the setters;
--   * 018 owns what Claude Sonnet 5 and GPT-5.6 Terra WERE, and their
--     retirement;
--   * 019 still owns manual-reasoning activation — now on all seven rows;
--   * 029 owns the Phase-D cutover: the final list, the two retirements, the
--     preference mapping, and the setters' and resolver's final behaviour;
--   * 028 — this suite — owns what the three replacement rows ARE: their
--     identity, their reasoning vocabulary and Automatic policy, the
--     constraints that keep that vocabulary honest, and the fact that staging
--     them wrote nobody's preference and no telemetry.
--
-- ## The property this suite exists to defend
--
-- Phase A had to change NOTHING a user could see or do while making a Phase-C
-- canary really reach each staged model. Phase C then passed on all three, and
-- Phase D opened them — so the two STAGING gates below are now historical, and
-- this suite asserts their inverted form while 029 owns the activated
-- behaviour end to end:
--
--   * `enabled = true` — a saved preference naming the model resolves to it, so
--     a canary was not silently served by the system default. UNCHANGED;
--   * `selectable = false` → now TRUE: Phase D opened the model to users;
--   * `reasoning_selectable = false` → now TRUE: Phase D opened manual
--     reasoning on it.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials; no provider request of any kind. pgTAP
-- is created inside the transaction and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Same shape as 011/012/016/018: run a statement as a given role with a given
-- JWT claim set, and report only the SQLSTATE or a single scalar.
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

CREATE FUNCTION pg_temp.claims(p_uid text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT '{"sub":"' || p_uid || '","role":"authenticated"}';
$hlp$;

SELECT plan(27);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The three replacement rows, exactly
-- ════════════════════════════════════════════════════════════════════════════
--
-- Asserted BEFORE any fixture row is inserted, so these describe the migrated
-- catalog and nothing this suite manufactured.

SELECT is((SELECT count(*)::int FROM public.ai_model_catalog), 7,
  'the catalog holds exactly the seven final rows');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog WHERE enabled AND selectable), 7,
  'all seven rows are offered to users — the staged set is empty');
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog WHERE NOT selectable),
  0, 'no row is non-selectable any more: Phase D opened all three replacements');

-- ── Each replacement row as a whole row ───────────────────────────────────
-- One assertion per model, so a failure names the model that drifted.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable)
        = ('anthropic/claude-sonnet-5-5','anthropic','claude-sonnet-5-5','Claude Sonnet 5.5',
           true,true,50,ARRAY['low','medium','high','xhigh','max'],'low','medium',true)),
  1, 'Claude Sonnet 5.5 carries exactly its approved identity and metadata');
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable)
        = ('anthropic/claude-opus-5-5','anthropic','claude-opus-5-5','Claude Opus 5.5',
           true,true,60,ARRAY['low','medium','high','xhigh','max'],'low','medium',true)),
  1, 'Claude Opus 5.5 carries exactly its approved identity and metadata');
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable)
        = ('openai/gpt-6.1-sol','openai','gpt-6.1-sol','GPT-6.1 Sol',
           true,true,70,ARRAY['low','medium','high','xhigh','max'],'low','medium',true)),
  1, 'GPT-6.1 Sol carries exactly its approved identity and metadata');

-- ── The three flags, each stated on its own ────────────────────────────────
SELECT ok((SELECT bool_and(enabled) FROM public.ai_model_catalog
            WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')),
  'all three replacements are enabled, which is what made the Phase-C canaries reach them');
-- Both flags INVERTED at Phase D: the staging gates are what the cutover
-- removed, and 029 owns the activated form end to end.
SELECT ok((SELECT bool_and(selectable) FROM public.ai_model_catalog
            WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')),
  'every replacement is selectable now that Phase D has opened it');
SELECT ok((SELECT bool_and(reasoning_selectable) FROM public.ai_model_catalog
            WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')),
  'every replacement is open to manual reasoning now that Phase D has opened it');

-- ── The reasoning vocabulary, exactly and in order ─────────────────────────
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')
      AND reasoning_levels = ARRAY['low','medium','high','xhigh','max']),
  3, 'each staged model exposes exactly low, medium, high, xhigh, max — in that order');
-- Each is a provider 400 the moment it is sent: `off` is thinking-disabled,
-- which both Claude 5.5 models reject; Sol rejects `none` and `minimal`.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')
      AND reasoning_levels && ARRAY['off','none','minimal']),
  0, 'no staged model exposes off, none or minimal');
-- `between_tools` and `adaptive` are Anthropic THINKING MODES, not effort
-- levels. The canonical-vocabulary CHECK is what keeps either from ever
-- becoming a catalog level — proved by trying.
SELECT throws_ok(
  $q$UPDATE public.ai_model_catalog
        SET reasoning_levels = ARRAY['between_tools','low','medium','high','xhigh','max']
      WHERE id = 'anthropic/claude-sonnet-5-5'$q$,
  '23514', NULL,
  '`between_tools` cannot become a catalog reasoning level');
SELECT throws_ok(
  $q$UPDATE public.ai_model_catalog
        SET reasoning_levels = ARRAY['adaptive','low','medium','high','xhigh','max']
      WHERE id = 'anthropic/claude-opus-5-5'$q$,
  '23514', NULL,
  '`adaptive` cannot become a catalog reasoning level');

-- ── PaperLume's own Automatic policy ───────────────────────────────────────
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')
      AND auto_analyze_reasoning_level = 'low'),
  3, 'Automatic Analyze is low on every staged model');
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')
      AND auto_suggest_reasoning_level = 'medium'),
  3, 'Automatic Suggest is medium on every staged model');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The six current rows are exactly as they were
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable) IN (
      ('google/gemini-3.5-flash','google','gemini-3.5-flash','Gemini 3.5 Flash',true,true,10,
       ARRAY['minimal','low','medium','high'],'minimal','medium',true),
      ('google/gemini-3.6-flash','google','gemini-3.6-flash','Gemini 3.6 Flash',true,true,20,
       ARRAY['minimal','low','medium','high'],'minimal','medium',true),
      ('google/gemini-3.7-flash','google','gemini-3.7-flash','Gemini 3.7 Flash',true,true,30,
       ARRAY['low','medium','high'],'low','medium',true),
      ('google/gemini-3.8-flash','google','gemini-3.8-flash','Gemini 3.8 Flash',true,true,40,
       ARRAY['low','medium','high'],'low','medium',true))),
  4, 'the four Gemini rows are unchanged, as whole rows');
-- Phase A left both 001E rows fully live; Phase D retired them by deletion
-- after migrating their preferences. Suite 018 owns that retirement.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE id IN ('anthropic/claude-sonnet-5','openai/gpt-5.6-terra')),
  0, 'Claude Sonnet 5 and GPT-5.6 Terra are gone — Phase D retired them');
SELECT is(
  (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog WHERE enabled AND selectable),
  ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash','google/gemini-3.7-flash',
        'google/gemini-3.8-flash','anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5',
        'openai/gpt-6.1-sol'],
  'the offered list is the seven final models, in final order');
-- Phase A appended at 70 / 80 / 90 so nobody was renumbered while a row was
-- merely staged. Phase D then normalized the three to 50 / 60 / 70, closing the
-- gap the two deletions left — and still did not move a Google row.
SELECT ok((SELECT min(sort_order) FROM public.ai_model_catalog WHERE provider <> 'google')
          > (SELECT max(sort_order) FROM public.ai_model_catalog WHERE provider = 'google'),
  'every replacement still sorts after every Google row');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The migration wrote no preference, entitlement, counter or telemetry row
-- ════════════════════════════════════════════════════════════════════════════
--
-- On a fresh replay these tables start empty, so an empty table is exactly
-- "nothing was written". The migration also fingerprints all five tables before
-- and after its INSERT in the same statement, which is what makes the property
-- hold against a POPULATED database.

SELECT is((SELECT count(*)::int FROM public.user_ai_preferences), 0,
  'the migration created no user preference row');
-- On a fresh replay there is nothing to migrate, so this says that neither the
-- Phase-A staging nor the Phase-D cutover INVENTS a preference. Phase D does
-- migrate real preferences onto these rows when some exist; that populated case
-- is proved by `runCatalogCutoverLane` in `scripts/e2e-local.mjs`.
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE preferred_model_id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')),
  0, 'no preference was invented for a replacement model on an empty replay');
SELECT is((SELECT count(*)::int FROM public.ai_provider_usage_events), 0,
  'the migration wrote no telemetry row');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Fixtures — and where the staging-gate assertions went
-- ════════════════════════════════════════════════════════════════════════════
--
-- Until Phase D this suite owned three blocks of staging-gate coverage: that
-- `set_current_user_ai_model` refused every staged model with
-- `model_not_selectable` for an ENTITLED caller, that an operator-written
-- preference nevertheless ROUTED to each staged row, and that no staged row
-- appeared in a signed-in user's options.
--
-- All three described gates the cutover deliberately removed, so they are not
-- inverted here — they would become a second copy of what suite 029 now
-- asserts in its activated form:
--
--   * the setter accepting all seven final models, and refusing both retired
--     ids as `unknown_model`                              → 029 §9
--   * a saved preference resolving to each model's wire model, including the
--     shapes the preference migration produces              → 029 §12
--   * the offered list read through RLS, and the catalog still unwritable by
--     any client                                           → 029 §13
--   * the entitlement gate, unchanged by activation         → 029 §11
--
-- The staged history is not lost either: 20260930203613 carries its own
-- fail-closed verify block proving it inserted all three rows NOT selectable
-- and NOT open to manual reasoning, and that block replays on every reset.
--
-- What remains here is the fixture the telemetry section below needs, and the
-- durable subject of this suite: what the three rows ARE, and the constraints
-- that keep their vocabulary honest.

INSERT INTO auth.users (id, email) VALUES
  ('e2800000-0000-0000-0000-000000000001','suite028-entitled@paperlume.test');

UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'active', ai_model_selection_enabled = true
 WHERE user_id = 'e2800000-0000-0000-0000-000000000001';

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Telemetry records a staged model exactly, priced by its own record
-- ════════════════════════════════════════════════════════════════════════════
--
-- The telemetry table holds no model allowlist, so a staged model's event
-- must fit it unchanged — and its record-matches-model CHECK must refuse to
-- attach one model's price record to another, including the model it replaces.
-- Rows mirror what `buildAiProviderUsageEvent` produces for 1,000 input and 200
-- output tokens against the shipped 2026-09-30 records.

INSERT INTO public.ai_provider_usage_events
  (occurred_at, user_id, telemetry_version, operation, provider, provider_model,
   model_selection_source, reasoning_source, resolved_reasoning_level,
   provider_outcome, provider_http_status, provider_attempts, operation_outcome,
   usage_status, input_tokens, cached_input_tokens, cache_write_input_tokens,
   output_tokens, reasoning_output_tokens, provider_total_tokens, has_unmodeled_usage,
   cost_status, list_price_estimate_usd, price_record_id, input_usd_per_mtok,
   cached_input_usd_per_mtok, cache_write_input_usd_per_mtok, output_usd_per_mtok)
VALUES
  ('2026-10-01T12:00:00Z','e2800000-0000-0000-0000-000000000001',1,'analyze','anthropic','claude-sonnet-5-5',
   'user_preference','automatic','low','completed',NULL,1,'succeeded',
   'reported',1000,0,0,200,50,NULL,false,
   'estimated',0.004000000000000,'anthropic/claude-sonnet-5-5@2026-09-30',2.00,0.20,NULL,10.00),
  ('2026-10-01T12:00:00Z','e2800000-0000-0000-0000-000000000001',1,'suggest','anthropic','claude-opus-5-5',
   'user_preference','automatic','medium','completed',NULL,1,'succeeded',
   'reported',1000,0,0,200,50,NULL,false,
   'estimated',0.008000000000000,'anthropic/claude-opus-5-5@2026-09-30',4.00,0.20,NULL,20.00),
  ('2026-10-01T12:00:00Z','e2800000-0000-0000-0000-000000000001',1,'analyze','openai','gpt-6.1-sol',
   'user_preference','manual','xhigh','completed',NULL,1,'succeeded',
   'reported',1000,0,0,200,50,1200,false,
   'estimated',0.004000000000000,'openai/gpt-6.1-sol@2026-09-30',2.00,0.10,2.50,10.00);

SELECT is(
  (SELECT array_agg(provider || '/' || provider_model || '=' || price_record_id ORDER BY price_record_id)
     FROM public.ai_provider_usage_events),
  ARRAY['anthropic/claude-opus-5-5=anthropic/claude-opus-5-5@2026-09-30',
        'anthropic/claude-sonnet-5-5=anthropic/claude-sonnet-5-5@2026-09-30',
        'openai/gpt-6.1-sol=openai/gpt-6.1-sol@2026-09-30'],
  'each staged model''s event is accepted with its exact provider model and its own price record');

SELECT throws_ok(
  $q$INSERT INTO public.ai_provider_usage_events
       (occurred_at, user_id, telemetry_version, operation, provider, provider_model,
        model_selection_source, reasoning_source, resolved_reasoning_level,
        provider_outcome, provider_http_status, provider_attempts, operation_outcome,
        usage_status, input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, provider_total_tokens, has_unmodeled_usage,
        cost_status, list_price_estimate_usd, price_record_id, input_usd_per_mtok,
        cached_input_usd_per_mtok, cache_write_input_usd_per_mtok, output_usd_per_mtok)
     VALUES ('2026-10-01T12:00:00Z','e2800000-0000-0000-0000-000000000001',1,'analyze','anthropic','claude-sonnet-5',
        'user_preference','automatic','off','completed',NULL,1,'succeeded',
        'reported',1000,0,0,200,0,NULL,false,
        'estimated',0.004000000000000,'anthropic/claude-sonnet-5-5@2026-09-30',2.00,0.20,NULL,10.00)$q$,
  '23514', 'new row for relation "ai_provider_usage_events" violates check constraint "ai_provider_usage_events_record_matches_model"',
  'a Claude Sonnet 5 event cannot carry the Sonnet 5.5 price record, despite identical rates');
SELECT throws_ok(
  $q$INSERT INTO public.ai_provider_usage_events
       (occurred_at, user_id, telemetry_version, operation, provider, provider_model,
        model_selection_source, reasoning_source, resolved_reasoning_level,
        provider_outcome, provider_http_status, provider_attempts, operation_outcome,
        usage_status, input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, provider_total_tokens, has_unmodeled_usage,
        cost_status, list_price_estimate_usd, price_record_id, input_usd_per_mtok,
        cached_input_usd_per_mtok, cache_write_input_usd_per_mtok, output_usd_per_mtok)
     VALUES ('2026-10-01T12:00:00Z','e2800000-0000-0000-0000-000000000001',1,'analyze','openai','gpt-6.1-sol',
        'user_preference','automatic','low','completed',NULL,1,'succeeded',
        'reported',1000,0,0,200,0,1200,false,
        'estimated',0.004400000000000,'openai/gpt-5.6-terra@2026-09-17',2.00,0.20,2.50,12.00)$q$,
  '23514', 'new row for relation "ai_provider_usage_events" violates check constraint "ai_provider_usage_events_record_matches_model"',
  'a Sol event cannot carry GPT-5.6 Terra''s price record');

-- ════════════════════════════════════════════════════════════════════════════
-- 8. The catalog is still credential-free
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT count(*)::int FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_model_catalog'
      AND column_name ~* '(key|secret|token|credential|password)'),
  0, 'the catalog has no column that could hold credential material');
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id || provider || provider_model || display_name)
          ~* '(api[_-]?key|secret|token|credential|password|sk-|sk_)'),
  0, 'no catalog row names a secret or credential in its metadata');

SELECT * FROM finish();
ROLLBACK;
