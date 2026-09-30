-- AI-MODEL-CATALOG-REFRESH-001 suite 028: the three staged replacement models.
--
-- Owns the database half of Phase A (20260930203613): Claude Sonnet 5.5, Claude
-- Opus 5.5 and GPT-6.1 Sol staged in `public.ai_model_catalog` as ENABLED but
-- NOT SELECTABLE and NOT open to manual reasoning, beside the six current rows,
-- which are untouched.
--
-- ## Where the boundary with the older suites is
--
-- Every database suite runs against the FINAL migration state, so the older
-- catalog suites were scoped rather than softened when three more rows arrived:
--
--   * 012 still owns the catalog as a LIST — nine rows, in order;
--   * 016 still owns the reasoning VOCABULARY constraints and the setters;
--   * 018 still owns what Claude Sonnet 5 and GPT-5.6 Terra ARE;
--   * 019 still owns manual-reasoning activation on the six current rows;
--   * 028 owns what the three staged rows ARE, what staging lets them do (be
--     routed to through an operator-written preference) and what it does not
--     (be chosen by a user, or have a manual level chosen for them).
--
-- ## The property this suite exists to defend
--
-- Phase A must change NOTHING a user can see or do, while making a Phase-C
-- canary really reach each staged model:
--
--   * `enabled = true` — a saved preference naming a staged model resolves to
--     it, so a canary is not silently served by the system default;
--   * `selectable = false` — `set_current_user_ai_model` refuses it and the
--     Settings offer query does not return it;
--   * `reasoning_selectable = false` — `set_current_user_ai_reasoning` refuses a
--     new manual level on it.
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

SELECT plan(55);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The staged catalog, exactly
-- ════════════════════════════════════════════════════════════════════════════
--
-- Asserted BEFORE any fixture row is inserted, so these describe the migrated
-- catalog and nothing this suite manufactured.

SELECT is((SELECT count(*)::int FROM public.ai_model_catalog), 9,
  'the catalog holds exactly nine rows: six current plus three staged');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog WHERE enabled AND selectable), 6,
  'exactly six rows are offered to users');
SELECT is(
  (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog WHERE NOT selectable),
  ARRAY['anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol'],
  'the three non-selectable rows are exactly the staged replacements, in staging order');

-- ── Each staged row as a whole row ─────────────────────────────────────────
-- One assertion per model, so a failure names the model that drifted.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable)
        = ('anthropic/claude-sonnet-5-5','anthropic','claude-sonnet-5-5','Claude Sonnet 5.5',
           true,false,70,ARRAY['low','medium','high','xhigh','max'],'low','medium',false)),
  1, 'Claude Sonnet 5.5 is staged exactly as approved');
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable)
        = ('anthropic/claude-opus-5-5','anthropic','claude-opus-5-5','Claude Opus 5.5',
           true,false,80,ARRAY['low','medium','high','xhigh','max'],'low','medium',false)),
  1, 'Claude Opus 5.5 is staged exactly as approved');
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable)
        = ('openai/gpt-6.1-sol','openai','gpt-6.1-sol','GPT-6.1 Sol',
           true,false,90,ARRAY['low','medium','high','xhigh','max'],'low','medium',false)),
  1, 'GPT-6.1 Sol is staged exactly as approved');

-- ── The three flags, each stated on its own ────────────────────────────────
SELECT ok((SELECT bool_and(enabled) FROM public.ai_model_catalog
            WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')),
  'all three staged models are enabled, so an operator-written preference routes to them');
SELECT ok((SELECT NOT bool_or(selectable) FROM public.ai_model_catalog
            WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')),
  'no staged model is selectable');
SELECT ok((SELECT NOT bool_or(reasoning_selectable) FROM public.ai_model_catalog
            WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')),
  'no staged model is open to manual reasoning');

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
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable) IN (
      ('anthropic/claude-sonnet-5','anthropic','claude-sonnet-5','Claude Sonnet 5',true,true,50,
       ARRAY['off','low','medium','high','xhigh','max'],'off','medium',true),
      ('openai/gpt-5.6-terra','openai','gpt-5.6-terra','GPT-5.6 Terra',true,true,60,
       ARRAY['none','low','medium','high','xhigh','max'],'none','medium',true))),
  2, 'Claude Sonnet 5 and GPT-5.6 Terra are unchanged, as whole rows — not retired, not closed');
SELECT is(
  (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog WHERE enabled AND selectable),
  ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash','google/gemini-3.7-flash',
        'google/gemini-3.8-flash','anthropic/claude-sonnet-5','openai/gpt-5.6-terra'],
  'the offered list is the six current models, in their unchanged order');
SELECT ok((SELECT min(sort_order) FROM public.ai_model_catalog
            WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol'))
          > (SELECT max(sort_order) FROM public.ai_model_catalog WHERE selectable),
  'every staged row sorts after every current row — nobody was renumbered');

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
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE preferred_model_id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')),
  0, 'nobody was migrated onto a staged model');
SELECT is((SELECT count(*)::int FROM public.ai_provider_usage_events), 0,
  'the migration wrote no telemetry row');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. The setter REFUSES every staged model — even for an entitled caller
-- ════════════════════════════════════════════════════════════════════════════
--
-- Must run as a caller who is entitled, or it proves nothing about
-- `selectable`: `set_current_user_ai_model` checks entitlement, plan status,
-- existence and `enabled` before `selectable`, so `model_not_selectable` from
-- an entitled caller positively proves the row passed every earlier gate and
-- was refused by the flag this staging set.

INSERT INTO auth.users (id, email) VALUES
  ('e2800000-0000-0000-0000-000000000001','suite028-entitled@paperlume.test'),
  ('e2800000-0000-0000-0000-000000000002','suite028-unentitled@paperlume.test');

UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'active', ai_model_selection_enabled = true
 WHERE user_id = 'e2800000-0000-0000-0000-000000000001';

-- Positive control FIRST: this caller really can save a model.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('google/gemini-3.8-flash')$q$),
  'ok', 'control: the entitled caller can save a selectable Gemini model');

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('anthropic/claude-sonnet-5-5')$q$),
  'model_not_selectable', 'the setter refuses Claude Sonnet 5.5 as not selectable');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT saved::text FROM public.set_current_user_ai_model('anthropic/claude-sonnet-5-5')$q$),
  'false', 'and that Sonnet 5.5 selection is not saved');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('anthropic/claude-opus-5-5')$q$),
  'model_not_selectable', 'the setter refuses Claude Opus 5.5 as not selectable');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT saved::text FROM public.set_current_user_ai_model('anthropic/claude-opus-5-5')$q$),
  'false', 'and that Opus 5.5 selection is not saved');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('openai/gpt-6.1-sol')$q$),
  'model_not_selectable', 'the setter refuses GPT-6.1 Sol as not selectable');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT saved::text FROM public.set_current_user_ai_model('openai/gpt-6.1-sol')$q$),
  'false', 'and that Sol selection is not saved');
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'e2800000-0000-0000-0000-000000000001'),
  'google/gemini-3.8-flash', 'six refusals left the caller''s saved model exactly where it was');

-- ── The two current paid models are still choosable ───────────────────────
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('anthropic/claude-sonnet-5')$q$),
  'ok', 'Claude Sonnet 5 is still accepted by the setter');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('xhigh')$q$),
  'ok', 'and a manual xhigh on Claude Sonnet 5 is still accepted — the Production preference shape');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('openai/gpt-5.6-terra')$q$),
  'ok', 'GPT-5.6 Terra is still accepted by the setter');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('none')$q$),
  'ok', 'and Terra''s `none` is still accepted as a manual level');

-- ── Staging grants nobody the capability ───────────────────────────────────
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000002'),
  $q$SELECT reason FROM public.set_current_user_ai_model('openai/gpt-6.1-sol')$q$),
  'not_entitled', 'an unentitled caller is refused a staged model at the first gate');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE user_id = 'e2800000-0000-0000-0000-000000000002'),
  0, 'the refused unentitled caller has no saved preference');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. An operator-written preference ROUTES to each staged model
-- ════════════════════════════════════════════════════════════════════════════
--
-- The Phase-C canary mechanism. The setter will not create such a row, so an
-- operator writes it directly for the acceptance account. It must resolve to
-- the staged provider model — the join the runtime resolver performs, with its
-- `enabled` requirement — or a canary would silently run on the system default
-- while appearing to test a new model. The runtime's own handling of the row
-- is pinned by `aiModelCatalogRefreshStaging.test.ts`.

UPDATE public.user_ai_preferences
   SET preferred_model_id = 'anthropic/claude-sonnet-5-5', preferred_reasoning_level = NULL
 WHERE user_id = 'e2800000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT c.provider || '/' || c.provider_model
     FROM public.user_ai_preferences p
     JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id
    WHERE p.user_id = 'e2800000-0000-0000-0000-000000000001' AND c.enabled),
  'anthropic/claude-sonnet-5-5', 'an operator-written Sonnet 5.5 preference resolves to claude-sonnet-5-5');

-- The staged row is visible to its holder under RLS, so Settings can show the
-- model in force even though it cannot offer it.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT c.display_name
       FROM public.user_ai_preferences p
       JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id$q$),
  'Claude Sonnet 5.5', 'its holder can read the staged model it is routed to');

-- A staged row is closed to a NEW manual level, even for the account routed to it.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('medium')$q$),
  'reasoning_not_selectable', 'a manual level cannot be chosen for a staged model');
SELECT ok((SELECT preferred_reasoning_level IS NULL FROM public.user_ai_preferences
            WHERE user_id = 'e2800000-0000-0000-0000-000000000001'),
  'the refused reasoning choice wrote nothing');
-- …and the way back to Automatic still works on it: an operator-written level
-- stays clearable by its holder, exactly as the column comment promises.
UPDATE public.user_ai_preferences
   SET preferred_reasoning_level = 'low'
 WHERE user_id = 'e2800000-0000-0000-0000-000000000001';
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$SELECT cleared::text FROM public.clear_current_user_ai_reasoning()$q$),
  'true', 'clearing reasoning still succeeds while routed to a staged model');
SELECT is((SELECT preferred_model_id || ':' || COALESCE(preferred_reasoning_level, 'automatic')
             FROM public.user_ai_preferences
            WHERE user_id = 'e2800000-0000-0000-0000-000000000001'),
  'anthropic/claude-sonnet-5-5:automatic', 'the clear kept the staged model and returned reasoning to Automatic');

UPDATE public.user_ai_preferences
   SET preferred_model_id = 'anthropic/claude-opus-5-5'
 WHERE user_id = 'e2800000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT c.provider || '/' || c.provider_model
     FROM public.user_ai_preferences p
     JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id
    WHERE p.user_id = 'e2800000-0000-0000-0000-000000000001' AND c.enabled),
  'anthropic/claude-opus-5-5', 'an operator-written Opus 5.5 preference resolves to claude-opus-5-5');

-- A bounded manual-effort canary: the operator writes the level too. The
-- runtime honours a saved level the model LISTS, whatever `reasoning_selectable`
-- says, so the level must be one the staged row lists.
UPDATE public.user_ai_preferences
   SET preferred_model_id = 'openai/gpt-6.1-sol', preferred_reasoning_level = 'xhigh'
 WHERE user_id = 'e2800000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT c.provider || '/' || c.provider_model
     FROM public.user_ai_preferences p
     JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id
    WHERE p.user_id = 'e2800000-0000-0000-0000-000000000001' AND c.enabled),
  'openai/gpt-6.1-sol', 'an operator-written Sol preference resolves to gpt-6.1-sol');
SELECT ok(
  (SELECT p.preferred_reasoning_level = ANY (c.reasoning_levels)
     FROM public.user_ai_preferences p
     JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id
    WHERE p.user_id = 'e2800000-0000-0000-0000-000000000001'),
  'the operator-written manual level is one the staged Sol row lists');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. No staged row is an ordinary user-selectable option
-- ════════════════════════════════════════════════════════════════════════════
--
-- Read as `authenticated`, through RLS, with the same predicate the Settings
-- control filters on — not merely as the table owner.

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000002'),
  $q$SELECT array_agg(id ORDER BY sort_order, id)::text
       FROM public.ai_model_catalog WHERE enabled AND selectable$q$),
  '{google/gemini-3.5-flash,google/gemini-3.6-flash,google/gemini-3.7-flash,google/gemini-3.8-flash,anthropic/claude-sonnet-5,openai/gpt-5.6-terra}',
  'a signed-in user is offered exactly the six current models');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000002'),
  $q$SELECT count(*)::text FROM public.ai_model_catalog
      WHERE enabled AND selectable
        AND id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')$q$),
  '0', 'no staged model is among a signed-in user''s options');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$UPDATE public.ai_model_catalog SET selectable = true WHERE id = 'openai/gpt-6.1-sol'$q$),
  '42501', 'an entitled user cannot make a staged model selectable by writing the catalog');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e2800000-0000-0000-0000-000000000001'),
  $q$UPDATE public.ai_model_catalog SET reasoning_selectable = true WHERE id = 'anthropic/claude-opus-5-5'$q$),
  '42501', 'nor open manual reasoning on one');
SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT count(*) FROM public.ai_model_catalog$q$),
  '42501', 'anon still cannot read the catalog');

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
