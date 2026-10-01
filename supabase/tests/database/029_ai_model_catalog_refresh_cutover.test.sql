-- AI-MODEL-CATALOG-REFRESH-001D suite 029: the final seven-model catalog.
--
-- Owns the database half of Phase D (20261001092335), the cutover that:
--
--   * migrated every saved preference off `anthropic/claude-sonnet-5` and
--     `openai/gpt-5.6-terra` onto their successors;
--   * DELETED those two rows;
--   * opened `anthropic/claude-sonnet-5-5`, `anthropic/claude-opus-5-5` and
--     `openai/gpt-6.1-sol` — selectable AND open to manual reasoning — at
--     final sort positions 50 / 60 / 70.
--
-- ## Where the boundary with the older suites is
--
-- Every database suite runs against the FINAL migration state, so the catalog
-- suites were rescoped rather than softened when the ninth row became the
-- seventh:
--
--   * 012 still owns the catalog as a LIST — now seven rows, in final order;
--   * 016 still owns the reasoning VOCABULARY constraints and the Automatic
--     matrix;
--   * 018's two subjects were RETIRED by this cutover, so it now owns their
--     ABSENCE and the paid-provider family structure that replaced them;
--   * 019 still owns manual-reasoning activation — now on all seven rows;
--   * 028 still owns what the three replacement rows ARE, and what the Phase-A
--     staging of them proved; their FLAGS moved here, because opening them is
--     this migration's act;
--   * 029 owns the cutover itself: the exact final list, the two retirements,
--     and what the setters and the resolver do once only the final seven exist.
--
-- ## The property this suite exists to defend
--
-- After Phase D a user's reachable set is exactly seven models, the two retired
-- ids behave as models that never existed, and nothing about the Gemini rows,
-- the entitlement gate or the client grant posture moved on the way. The
-- PREFERENCE MIGRATION itself cannot be asserted here — by the time any suite
-- runs, the cutover has already replayed against an empty database — so it is
-- proved separately by the populated migration-replay lane in
-- `scripts/e2e-local.mjs` (`runCatalogCutoverLane`), which seeds a preference at
-- every old level, applies this exact migration file through the real CLI, and
-- checks each mapping. The refusal controls live there too, for the same reason.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials; no provider request of any kind. pgTAP
-- is created inside the transaction and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Same shape as 011/012/016/018/019/028.
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

CREATE FUNCTION pg_temp.pair(p_uid uuid) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT COALESCE(
    (SELECT preferred_model_id || ':' || COALESCE(preferred_reasoning_level, 'AUTOMATIC')
       FROM public.user_ai_preferences WHERE user_id = p_uid),
    'NO_ROW');
$hlp$;

CREATE FUNCTION pg_temp.set_level(p_uid text, p_level text) RETURNS text
LANGUAGE sql AS $hlp$
  SELECT pg_temp.scalar_as('authenticated', pg_temp.claims(p_uid),
    format('SELECT reason FROM public.set_current_user_ai_reasoning(%L)', p_level));
$hlp$;

CREATE FUNCTION pg_temp.set_model(p_uid text, p_model text) RETURNS text
LANGUAGE sql AS $hlp$
  SELECT pg_temp.scalar_as('authenticated', pg_temp.claims(p_uid),
    format('SELECT reason FROM public.set_current_user_ai_model(%L)', p_model));
$hlp$;

-- A write and then the pair it left behind. Two STATEMENTS, because `pair` is
-- STABLE and inside the same query would report the pre-write snapshot.
CREATE FUNCTION pg_temp.step_level(p_uid text, p_level text) RETURNS text
LANGUAGE plpgsql AS $hlp$
DECLARE v_result text;
BEGIN
  v_result := pg_temp.set_level(p_uid, p_level);
  RETURN v_result || '>' || pg_temp.pair(p_uid::uuid);
END;
$hlp$;

-- Call the reasoning setter once per level, in order: `level=reason>pair`.
CREATE FUNCTION pg_temp.sweep(p_uid text, p_levels text[]) RETURNS text
LANGUAGE plpgsql AS $hlp$
DECLARE
  v_level text;
  v_out   text[] := ARRAY[]::text[];
BEGIN
  FOREACH v_level IN ARRAY p_levels LOOP
    v_out := v_out || (v_level || '=' || pg_temp.step_level(p_uid, v_level));
  END LOOP;
  RETURN array_to_string(v_out, ',');
END;
$hlp$;

CREATE FUNCTION pg_temp.all_ok(p_model text, p_levels text[]) RETURNS text
LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT string_agg(l || '=ok>' || p_model || ':' || l, ',' ORDER BY o)
  FROM unnest(p_levels) WITH ORDINALITY AS t(l, o);
$hlp$;

CREATE FUNCTION pg_temp.all_refused(p_model text, p_kept text, p_levels text[]) RETURNS text
LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT string_agg(l || '=reasoning_level_not_supported>' || p_model || ':' || p_kept, ',' ORDER BY o)
  FROM unnest(p_levels) WITH ORDINALITY AS t(l, o);
$hlp$;

-- The five levels every replacement row offers, and the three it must not.
CREATE FUNCTION pg_temp.paid_levels() RETURNS text[] LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT ARRAY['low','medium','high','xhigh','max'];
$hlp$;
CREATE FUNCTION pg_temp.forbidden_levels() RETURNS text[] LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT ARRAY['off','none','minimal'];
$hlp$;

SELECT plan(69);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The final catalog, exactly — asserted before any fixture exists
-- ════════════════════════════════════════════════════════════════════════════

SELECT is((SELECT count(*)::int FROM public.ai_model_catalog), 7,
  'the catalog holds exactly seven rows after the cutover');

-- Ordered by the two keys the Settings control itself orders by, so this is the
-- order a user actually sees.
SELECT is(
  (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog),
  ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
        'google/gemini-3.7-flash','google/gemini-3.8-flash',
        'anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol'],
  'catalog ids are exactly the approved seven, ordered 3.5, 3.6, 3.7, 3.8, Sonnet 5.5, Opus 5.5, Sol');
SELECT is(
  (SELECT array_agg(provider_model ORDER BY sort_order, id) FROM public.ai_model_catalog),
  ARRAY['gemini-3.5-flash','gemini-3.6-flash','gemini-3.7-flash','gemini-3.8-flash',
        'claude-sonnet-5-5','claude-opus-5-5','gpt-6.1-sol'],
  'provider model strings are exactly the seven approved wire models');
SELECT is(
  (SELECT array_agg(display_name ORDER BY sort_order, id) FROM public.ai_model_catalog),
  ARRAY['Gemini 3.5 Flash','Gemini 3.6 Flash','Gemini 3.7 Flash','Gemini 3.8 Flash',
        'Claude Sonnet 5.5','Claude Opus 5.5','GPT-6.1 Sol'],
  'display names are exactly the seven approved labels');
SELECT is(
  (SELECT array_agg(provider ORDER BY sort_order, id) FROM public.ai_model_catalog),
  ARRAY['google','google','google','google','anthropic','anthropic','openai'],
  'each final model names one of the three registered provider adapters');
-- Renumbered, deliberately: Phase D normalizes the paid rows to 50/60/70 now
-- that the two rows that held 50 and 60 are gone.
SELECT is(
  (SELECT array_agg(sort_order ORDER BY sort_order, id) FROM public.ai_model_catalog),
  ARRAY[10,20,30,40,50,60,70],
  'final sort positions are exactly 10 / 20 / 30 / 40 / 50 / 60 / 70');

-- The three flags, each stated on its own so a failure names the property.
SELECT ok((SELECT bool_and(enabled) FROM public.ai_model_catalog),
  'all seven final models are enabled');
SELECT ok((SELECT bool_and(selectable) FROM public.ai_model_catalog),
  'all seven final models are selectable — the staged/current split is closed');
SELECT ok((SELECT bool_and(reasoning_selectable) FROM public.ai_model_catalog),
  'all seven final models are open to manual reasoning');
SELECT is(
  (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog
    WHERE enabled AND selectable),
  ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
        'google/gemini-3.7-flash','google/gemini-3.8-flash',
        'anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol'],
  'the offered list is exactly the seven final models, in final order');
SELECT is(
  (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog
    WHERE reasoning_selectable),
  ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
        'google/gemini-3.7-flash','google/gemini-3.8-flash',
        'anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol'],
  'manual reasoning is open on exactly the seven final models');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The two retired rows are GONE — by id and by wire model
-- ════════════════════════════════════════════════════════════════════════════
--
-- Both spellings, because a row carrying the retired wire model under a new id
-- would still route a retired model.

SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id IN ('anthropic/claude-sonnet-5','openai/gpt-5.6-terra')),
  0, 'neither retired catalog id exists any more');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE (provider, provider_model) IN (('anthropic','claude-sonnet-5'),
                                                 ('openai','gpt-5.6-terra'))),
  0, 'no row carries a retired provider model under any id');
-- They were deleted, not hidden: a disabled or non-selectable survivor would
-- leave the catalog at nine rows, which §1 already forbids — stated separately
-- because "hidden" is the specific outcome this cutover rejected.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE NOT enabled OR NOT selectable OR NOT reasoning_selectable),
  0, 'no row survives in a hidden, disabled or closed state');

-- `off` and `none` left the product with the rows that offered them. Both are
-- still canonical VOCABULARY — 016 owns that — but no row may offer either,
-- because every remaining model rejects them at the provider.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE reasoning_levels && ARRAY['off','none']),
  0, 'no final row offers off or none');
-- `minimal` is a Google word and survives on exactly the two rows that have it.
SELECT is(
  (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog
    WHERE 'minimal' = ANY (reasoning_levels)),
  ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash'],
  'minimal survives on exactly Gemini 3.5 and 3.6');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The three activated rows, as whole rows
-- ════════════════════════════════════════════════════════════════════════════
--
-- One assertion per model so a failure names the model that drifted. Identity
-- and reasoning metadata are asserted together with the new flags and sort
-- order: the cutover was allowed to change the latter two and nothing else.

SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable)
        = ('anthropic/claude-sonnet-5-5','anthropic','claude-sonnet-5-5','Claude Sonnet 5.5',
           true,true,50,ARRAY['low','medium','high','xhigh','max'],'low','medium',true)),
  1, 'Claude Sonnet 5.5 is activated exactly as approved, at 50');
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable)
        = ('anthropic/claude-opus-5-5','anthropic','claude-opus-5-5','Claude Opus 5.5',
           true,true,60,ARRAY['low','medium','high','xhigh','max'],'low','medium',true)),
  1, 'Claude Opus 5.5 is activated exactly as approved, at 60');
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable)
        = ('openai/gpt-6.1-sol','openai','gpt-6.1-sol','GPT-6.1 Sol',
           true,true,70,ARRAY['low','medium','high','xhigh','max'],'low','medium',true)),
  1, 'GPT-6.1 Sol is activated exactly as approved, at 70');

-- Their reasoning metadata is the Phase-A metadata, untouched by activation —
-- which is what makes the Phase-C evidence still describe these rows.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')
              AND reasoning_levels = ARRAY['low','medium','high','xhigh','max']),
  3, 'each replacement still exposes exactly low, medium, high, xhigh, max — in that order');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')
              AND auto_analyze_reasoning_level = 'low'),
  3, 'Automatic Analyze is still low on every replacement');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')
              AND auto_suggest_reasoning_level = 'medium'),
  3, 'Automatic Suggest is still medium on every replacement');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. The four Gemini rows are untouched
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
  4, 'the four Gemini rows are unchanged by the cutover, as whole rows');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. The catalog's integrity constraints still bite
-- ════════════════════════════════════════════════════════════════════════════
--
-- Activation did not relax the vocabulary. Proved by trying, on an activated
-- row, inside this rolled-back transaction.

SELECT throws_ok(
  $q$UPDATE public.ai_model_catalog
        SET reasoning_levels = ARRAY['between_tools','low','medium','high','xhigh','max']
      WHERE id = 'anthropic/claude-sonnet-5-5'$q$,
  '23514', NULL,
  '`between_tools` still cannot become a catalog reasoning level');
SELECT throws_ok(
  $q$UPDATE public.ai_model_catalog
        SET reasoning_levels = ARRAY['adaptive','low','medium','high','xhigh','max']
      WHERE id = 'anthropic/claude-opus-5-5'$q$,
  '23514', NULL,
  '`adaptive` still cannot become a catalog reasoning level');
SELECT throws_ok(
  $q$UPDATE public.ai_model_catalog
        SET reasoning_levels = ARRAY['ultra','low','medium','high','xhigh','max']
      WHERE id = 'openai/gpt-6.1-sol'$q$,
  '23514', NULL,
  'an invented level still cannot become a catalog reasoning level');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. The catalog is still credential-free, client-readable, client-unwritable
-- ════════════════════════════════════════════════════════════════════════════

SELECT is((SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'ai_model_catalog'
              AND column_name ~* '(key|secret|token|credential|password)'),
  0, 'the catalog still holds no column that could carry credential material');

-- ════════════════════════════════════════════════════════════════════════════
-- 7. The preference FK is intact, and still NO ACTION
-- ════════════════════════════════════════════════════════════════════════════
--
-- The FK is what made the ordered retirement safe: it is the reason a DELETE
-- cannot orphan a saved choice. If it ever gained ON DELETE CASCADE or SET
-- NULL, a future retirement could silently discard a user's preference.

SELECT is(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'public.user_ai_preferences'::regclass
      AND conname = 'user_ai_preferences_preferred_model_id_fkey'),
  'FOREIGN KEY (preferred_model_id) REFERENCES ai_model_catalog(id)',
  'the preference FK still references the catalog with NO ON DELETE action');

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Fixtures: one entitled caller, one unentitled, one inactive
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO auth.users (id, email) VALUES
  ('e2900000-0000-0000-0000-000000000001','suite029-entitled@paperlume.test'),
  ('e2900000-0000-0000-0000-000000000002','suite029-unentitled@paperlume.test'),
  ('e2900000-0000-0000-0000-000000000003','suite029-inactive@paperlume.test');

UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'active', ai_model_selection_enabled = true
 WHERE user_id = 'e2900000-0000-0000-0000-000000000001';
UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'past_due', ai_model_selection_enabled = true
 WHERE user_id = 'e2900000-0000-0000-0000-000000000003';

-- A preference naming a model the catalog does not hold is refused by the FK,
-- not stored and then ignored. Uses a retired id, so this is simultaneously the
-- proof that a retired model can no longer be referenced at all.
SELECT throws_ok(
  $q$INSERT INTO public.user_ai_preferences (user_id, preferred_model_id)
     VALUES ('e2900000-0000-0000-0000-000000000002','anthropic/claude-sonnet-5')$q$,
  '23503', NULL,
  'a preference naming the retired Claude Sonnet 5 is refused by the FK');

-- ════════════════════════════════════════════════════════════════════════════
-- 9. The model setter accepts exactly the final seven
-- ════════════════════════════════════════════════════════════════════════════
--
-- No setter body changed in Phase D. The setter reads the catalog, so the
-- catalog change IS the behaviour change — these assertions are what proves
-- that claim rather than asserting it.

SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','google/gemini-3.5-flash'),
  'ok', 'the setter accepts Gemini 3.5 Flash');
SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','google/gemini-3.6-flash'),
  'ok', 'the setter accepts Gemini 3.6 Flash');
SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','google/gemini-3.7-flash'),
  'ok', 'the setter accepts Gemini 3.7 Flash');
SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','google/gemini-3.8-flash'),
  'ok', 'the setter accepts Gemini 3.8 Flash');
SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','anthropic/claude-sonnet-5-5'),
  'ok', 'the setter accepts Claude Sonnet 5.5 — closed during staging, open now');
SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','anthropic/claude-opus-5-5'),
  'ok', 'the setter accepts Claude Opus 5.5');
SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','openai/gpt-6.1-sol'),
  'ok', 'the setter accepts GPT-6.1 Sol');

-- ── And refuses both retired ids, as models that do not exist ──────────────
-- `unknown_model`, not `model_disabled` or `model_not_selectable`: the rows are
-- gone, so the catalog lookup finds nothing. That is the difference between
-- deleting a row and hiding one, visible at the setter.
SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','anthropic/claude-sonnet-5'),
  'unknown_model', 'the setter refuses the retired Claude Sonnet 5 as unknown');
SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','openai/gpt-5.6-terra'),
  'unknown_model', 'the setter refuses the retired GPT-5.6 Terra as unknown');
SELECT is(pg_temp.pair('e2900000-0000-0000-0000-000000000001'::uuid),
  'openai/gpt-6.1-sol:AUTOMATIC',
  'the two refusals left the caller''s saved pair exactly where the last accepted call put it');

-- ════════════════════════════════════════════════════════════════════════════
-- 10. The reasoning setter, on the final paid rows
-- ════════════════════════════════════════════════════════════════════════════
--
-- Every level each replacement LISTS is accepted, and the three it does not
-- list are refused as unsupported — not as invalid, which would mean the
-- canonical vocabulary rejected them rather than the catalog row.

SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','anthropic/claude-sonnet-5-5'),
  'ok', 'pinning Claude Sonnet 5.5 for the reasoning sweep');
SELECT is(pg_temp.sweep('e2900000-0000-0000-0000-000000000001', pg_temp.paid_levels()),
  pg_temp.all_ok('anthropic/claude-sonnet-5-5', pg_temp.paid_levels()),
  'Claude Sonnet 5.5 accepts low, medium, high, xhigh and max');
SELECT is(pg_temp.sweep('e2900000-0000-0000-0000-000000000001', pg_temp.forbidden_levels()),
  pg_temp.all_refused('anthropic/claude-sonnet-5-5', 'max', pg_temp.forbidden_levels()),
  'Claude Sonnet 5.5 refuses off, none and minimal as unsupported, keeping max');

SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','anthropic/claude-opus-5-5'),
  'ok', 'pinning Claude Opus 5.5 for the reasoning sweep');
SELECT is(pg_temp.sweep('e2900000-0000-0000-0000-000000000001', pg_temp.paid_levels()),
  pg_temp.all_ok('anthropic/claude-opus-5-5', pg_temp.paid_levels()),
  'Claude Opus 5.5 accepts low, medium, high, xhigh and max');
SELECT is(pg_temp.sweep('e2900000-0000-0000-0000-000000000001', pg_temp.forbidden_levels()),
  pg_temp.all_refused('anthropic/claude-opus-5-5', 'max', pg_temp.forbidden_levels()),
  'Claude Opus 5.5 refuses off, none and minimal as unsupported, keeping max');

SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000001','openai/gpt-6.1-sol'),
  'ok', 'pinning GPT-6.1 Sol for the reasoning sweep');
SELECT is(pg_temp.sweep('e2900000-0000-0000-0000-000000000001', pg_temp.paid_levels()),
  pg_temp.all_ok('openai/gpt-6.1-sol', pg_temp.paid_levels()),
  'GPT-6.1 Sol accepts low, medium, high, xhigh and max');
SELECT is(pg_temp.sweep('e2900000-0000-0000-0000-000000000001', pg_temp.forbidden_levels()),
  pg_temp.all_refused('openai/gpt-6.1-sol', 'max', pg_temp.forbidden_levels()),
  'GPT-6.1 Sol refuses off, none and minimal as unsupported, keeping max');

-- An arbitrary string, and the literal `automatic`, are refused by the
-- canonical-vocabulary gate BEFORE the catalog is consulted.
SELECT is(pg_temp.set_level('e2900000-0000-0000-0000-000000000001','ludicrous'),
  'invalid_reasoning_level', 'an arbitrary reasoning string is refused as invalid');
SELECT is(pg_temp.set_level('e2900000-0000-0000-0000-000000000001','automatic'),
  'invalid_reasoning_level', '`automatic` is still not a storable level — clearing is its own RPC');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2900000-0000-0000-0000-000000000001'),
  $q$SELECT cleared::text FROM public.clear_current_user_ai_reasoning()$q$),
  'true', 'Automatic is reached by clearing, and still works on a final paid row');
SELECT is(pg_temp.pair('e2900000-0000-0000-0000-000000000001'::uuid),
  'openai/gpt-6.1-sol:AUTOMATIC',
  'the clear kept the pinned model and returned reasoning to Automatic');

-- ════════════════════════════════════════════════════════════════════════════
-- 11. The entitlement gate is unchanged by the cutover
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000002','anthropic/claude-opus-5-5'),
  'not_entitled', 'an unentitled caller is refused a newly-opened model at the first gate');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE user_id = 'e2900000-0000-0000-0000-000000000002'),
  0, 'the refused unentitled caller has no saved preference');
SELECT is(pg_temp.set_model('e2900000-0000-0000-0000-000000000003','anthropic/claude-opus-5-5'),
  'inactive_entitlement', 'an entitled caller whose plan is not active is still refused');
SELECT is(pg_temp.set_level('e2900000-0000-0000-0000-000000000002','max'),
  'not_entitled', 'the reasoning setter gates on entitlement too');

-- ════════════════════════════════════════════════════════════════════════════
-- 12. Resolution: every final model resolves to its own wire model
-- ════════════════════════════════════════════════════════════════════════════
--
-- The join the runtime resolver performs, with its `enabled` requirement. This
-- is the database half of "a migrated preference resolves to the successor";
-- the runtime half is pinned by the Vitest suites.

UPDATE public.user_ai_preferences
   SET preferred_model_id = 'anthropic/claude-sonnet-5-5', preferred_reasoning_level = 'xhigh'
 WHERE user_id = 'e2900000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT c.provider || '/' || c.provider_model || '@' || COALESCE(p.preferred_reasoning_level,'AUTOMATIC')
     FROM public.user_ai_preferences p
     JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id
    WHERE p.user_id = 'e2900000-0000-0000-0000-000000000001' AND c.enabled),
  'anthropic/claude-sonnet-5-5@xhigh',
  'the shape a migrated Sonnet preference lands in resolves to claude-sonnet-5-5 at its preserved level');

UPDATE public.user_ai_preferences
   SET preferred_model_id = 'openai/gpt-6.1-sol', preferred_reasoning_level = NULL
 WHERE user_id = 'e2900000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT c.provider || '/' || c.provider_model || '@'
            || c.auto_analyze_reasoning_level || '/' || c.auto_suggest_reasoning_level
     FROM public.user_ai_preferences p
     JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id
    WHERE p.user_id = 'e2900000-0000-0000-0000-000000000001' AND c.enabled),
  'openai/gpt-6.1-sol@low/medium',
  'the shape a migrated Terra `none` preference lands in resolves to Sol on Automatic low / medium');

UPDATE public.user_ai_preferences
   SET preferred_model_id = 'anthropic/claude-opus-5-5', preferred_reasoning_level = NULL
 WHERE user_id = 'e2900000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT c.provider || '/' || c.provider_model || '@'
            || c.auto_analyze_reasoning_level || '/' || c.auto_suggest_reasoning_level
     FROM public.user_ai_preferences p
     JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id
    WHERE p.user_id = 'e2900000-0000-0000-0000-000000000001' AND c.enabled),
  'anthropic/claude-opus-5-5@low/medium',
  'an Opus 5.5 preference on Automatic resolves to low / medium');

-- Every preference in the database names a model that exists and a level that
-- model lists. Stated over the whole table: this is the invariant the cutover's
-- own postcondition asserted, re-checked here against the replayed schema.
SELECT is(
  (SELECT count(*)::int FROM public.user_ai_preferences p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.ai_model_catalog c
       WHERE c.id = p.preferred_model_id
         AND (p.preferred_reasoning_level IS NULL
              OR p.preferred_reasoning_level = ANY (COALESCE(c.reasoning_levels, ARRAY[]::text[]))))),
  0, 'no preference names a missing model or a level that model does not list');

-- ════════════════════════════════════════════════════════════════════════════
-- 13. What a signed-in user actually sees, through RLS
-- ════════════════════════════════════════════════════════════════════════════
--
-- Read as `authenticated` with the same predicate the Settings control filters
-- on, not as the table owner — so this is the Settings contract's database half.

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2900000-0000-0000-0000-000000000002'),
  $q$SELECT array_agg(id ORDER BY sort_order, id)::text
       FROM public.ai_model_catalog WHERE enabled AND selectable$q$),
  '{google/gemini-3.5-flash,google/gemini-3.6-flash,google/gemini-3.7-flash,google/gemini-3.8-flash,anthropic/claude-sonnet-5-5,anthropic/claude-opus-5-5,openai/gpt-6.1-sol}',
  'a signed-in user is offered exactly the seven final models, in final order');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2900000-0000-0000-0000-000000000002'),
  $q$SELECT count(*)::text FROM public.ai_model_catalog
      WHERE id IN ('anthropic/claude-sonnet-5','openai/gpt-5.6-terra')$q$),
  '0', 'a signed-in user cannot see a retired model at all');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e2900000-0000-0000-0000-000000000002'),
  $q$SELECT count(*)::text FROM public.ai_model_catalog$q$),
  (SELECT count(*)::text FROM public.ai_model_catalog),
  'an ordinary signed-in user can still read the whole catalog');
SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT count(*) FROM public.ai_model_catalog$q$),
  '42501', 'anon still cannot reach the catalog at all');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e2900000-0000-0000-0000-000000000001'),
  $q$UPDATE public.ai_model_catalog SET selectable = false WHERE id = 'openai/gpt-6.1-sol'$q$),
  '42501', 'an entitled user cannot close a final model by writing the catalog');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e2900000-0000-0000-0000-000000000001'),
  $q$DELETE FROM public.ai_model_catalog WHERE id = 'anthropic/claude-opus-5-5'$q$),
  '42501', 'nor delete one');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e2900000-0000-0000-0000-000000000001'),
  $q$INSERT INTO public.ai_model_catalog (id, provider, provider_model, display_name)
     VALUES ('anthropic/claude-sonnet-5','anthropic','claude-sonnet-5','Claude Sonnet 5')$q$),
  '42501', 'nor re-create a retired one');

-- ════════════════════════════════════════════════════════════════════════════
-- 14. Telemetry history survives the retirement
-- ════════════════════════════════════════════════════════════════════════════
--
-- There is no FK from telemetry to the catalog, by design: a usage event
-- records which provider and model actually served a request, and that must
-- stay true after the model is retired. On a fresh replay the table is empty,
-- so what is asserted is the STRUCTURAL property that makes the history safe —
-- that a retired model string is still storable and still readable.

SELECT is((SELECT count(*)::int FROM pg_constraint
            WHERE conrelid = 'public.ai_provider_usage_events'::regclass
              AND contype = 'f'
              AND confrelid = 'public.ai_model_catalog'::regclass),
  0, 'telemetry has no foreign key to the catalog, so retirement cannot erase history');
-- Deliberately the minimal valid shape — `usage_status = 'absent'` with no
-- token or cost columns, which the table's own `no_usage_no_tokens`,
-- `reported_has_io` and `*_iff_estimated` constraints require of each other.
-- What is under test here is the MODEL STRING, not the pricing: a priced event
-- for a live model is already pinned by suite 028 §7, and computing exact
-- price arithmetic by hand would only add a way for this assertion to fail for
-- a reason that has nothing to do with retirement.
INSERT INTO public.ai_provider_usage_events (
  occurred_at, user_id, telemetry_version, operation, provider, provider_model,
  model_selection_source, reasoning_source, resolved_reasoning_level,
  provider_outcome, provider_attempts, operation_outcome,
  usage_status, has_unmodeled_usage, cost_status)
VALUES (
  now(), 'e2900000-0000-0000-0000-000000000001', 1, 'analyze', 'anthropic', 'claude-sonnet-5',
  'user_preference', 'manual', 'xhigh', 'completed', 1, 'succeeded',
  'absent', false, 'unpriced');
SELECT is((SELECT count(*)::int FROM public.ai_provider_usage_events
            WHERE provider_model = 'claude-sonnet-5'),
  1, 'a historical event naming a retired model is still storable and readable');

SELECT * FROM finish();
ROLLBACK;
