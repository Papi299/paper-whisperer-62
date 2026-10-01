-- AI-MULTI-PROVIDER-001E suite 018: the two paid-provider catalog rows —
-- staged, activated, and now RETIRED.
--
-- Owns the database half of BOTH 001E migrations, and now of their end:
--
--   * 20260917201856 staged `anthropic/claude-sonnet-5` and
--     `openai/gpt-5.6-terra` in `public.ai_model_catalog` as ENABLED but NOT
--     SELECTABLE, so Phase 7 could canary them without exposing them;
--   * 20260918210017 (Phase 8) then set `selectable = true` on exactly those
--     two rows, once the Production canaries had passed;
--   * 20261001092335 (AI-MODEL-CATALOG-REFRESH-001D, Phase D) DELETED both
--     rows, after migrating every saved preference onto their successors.
--
-- The filename still says "staging" because that is where these rows came from
-- and renaming a suite loses its history; what it asserts is the CURRENT state.
-- Every database suite runs against the FINAL migration state, so the
-- staging-era claims here were inverted rather than deleted when Phase 8
-- landed, and the activation-era claims were inverted the same way when Phase D
-- retired both subjects. That is not lost coverage: 20260917201856 and
-- 20260918210017 each carry their own fail-closed verify block proving what
-- they inserted and activated, and both are replayed on every reset.
--
-- So what this suite now owns is the RETIREMENT: that neither row exists under
-- any spelling, that each provider's row set is exactly the successors, that
-- `off` and `none` left the catalog with the rows that carried them, and that
-- the setter treats both retired ids as models that never existed — while the
-- Google rows, the entitlement gate and the client grant posture are untouched.
-- The seven-row final list is owned by 012; the cutover's own mechanics,
-- including the preference mapping, are owned by 029 and by
-- `runCatalogCutoverLane` in `scripts/e2e-local.mjs`.
--
-- ## Why a separate suite, and where the boundary is
--
-- Every database suite runs against the FINAL migration state, so the existing
-- catalog suites could not keep claiming "the catalog is exhausted by the four
-- Google models". They were updated rather than softened — 012 still asserts
-- the whole list and now asserts six rows, and 016 still asserts that no row
-- offers manual reasoning. What moved here is everything specific to the two
-- paid rows:
--
--   * 012 owns the catalog as a LIST and the client-facing grant posture;
--   * 016 owns the reasoning VOCABULARY constraints and the setter's rules;
--   * 018 owns what the two paid rows ARE, what they are now allowed to do,
--     and what activation still does not grant.
--
-- ## The property this suite exists to defend
--
-- The two flags are independent, and after Phase 8 both are true for these
-- rows:
--
--   * `enabled` means the resolver WILL route a saved preference naming one of
--     these models — the property that let Phase 7 canary them, and the same
--     property that now serves a user's own choice;
--   * `selectable` means `set_current_user_ai_model` will accept it and the
--     Settings control will offer it.
--
-- A regression in either direction is still a real incident: losing `enabled`
-- would strand saved preferences on the system default while appearing to work,
-- and losing `selectable` would silently remove two models users can now
-- choose. Both directions are asserted here.
--
-- What activation deliberately did NOT change is who may choose at all. That
-- gate is `can_select_ai_model`, and section 5 proves an unentitled caller is
-- still refused a paid model at the first gate.
--
-- Neither 001E migration activated manual reasoning; each one's own verify block
-- proves that at replay. AI-MANUAL-REASONING-001 (20260919075655) later set
-- `reasoning_selectable = true` on these two rows and the four Google rows and
-- granted `set_current_user_ai_reasoning`. The whole-row assertions below
-- therefore carry `true` for that flag, and everything else about manual
-- reasoning — which rows are open, who may call the setter, and every level of
-- both paid models through the real client path — is owned by suite 019.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials; no provider request of any kind. pgTAP
-- is created inside the transaction and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Same shape as 011/012/016: run a statement as a given role with a given JWT
-- claim set, and report only the SQLSTATE or a single scalar.
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

SELECT plan(48);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Both subjects are RETIRED — no row, under any spelling
-- ════════════════════════════════════════════════════════════════════════════
--
-- Asserted BEFORE any fixture row is inserted, so these describe the migrated
-- catalog and nothing this suite manufactured.
--
-- This section previously asserted "exactly one row exists" for each model,
-- with its provider, wire model, label and both flags. Phase D deleted both
-- rows, so each of those claims is inverted to its retirement form rather than
-- deleted — and the deleted half is not lost coverage, because 20260917201856
-- and 20260918210017 both carry their own fail-closed verify blocks proving
-- what they inserted and activated, and those are replayed on every reset.

SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id = 'anthropic/claude-sonnet-5'), 0,
  'no Claude Sonnet 5 row exists — Phase D deleted it');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id = 'openai/gpt-5.6-terra'), 0,
  'no GPT-5.6 Terra row exists — Phase D deleted it');
-- By the wire model too: a row carrying `claude-sonnet-5` or `gpt-5.6-terra`
-- under some other id would still send a retired model to a provider.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE (provider, provider_model) IN (('anthropic','claude-sonnet-5'),
                                                 ('openai','gpt-5.6-terra'))),
  0, 'no row sends either retired wire model under any id');
-- Retired by DELETION, not by hiding: a disabled or closed survivor would still
-- be a row, and this suite's subject is that there is none.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE display_name IN ('Claude Sonnet 5','GPT-5.6 Terra')),
  0, 'neither retired label survives on any row');

-- Nothing ELSE arrived under either provider: the catalog is the allowlist, so
-- a stray sibling model would be a route nobody approved. Each provider's rows
-- are asserted as an exact set rather than as a count, and after Phase D those
-- sets are exactly the three replacements (suites 028 and 029).
SELECT set_eq(
  $$SELECT id FROM public.ai_model_catalog WHERE provider = 'anthropic'$$,
  ARRAY['anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5'],
  'the anthropic rows are exactly the two Claude 5.5 models');
SELECT set_eq(
  $$SELECT id FROM public.ai_model_catalog WHERE provider = 'openai'$$,
  ARRAY['openai/gpt-6.1-sol'],
  'the openai rows are exactly GPT-6.1 Sol');

-- The provider/provider_model pair is what the adapter actually sends, so it is
-- asserted exactly rather than by pattern — now for the successors.
SELECT is((SELECT provider_model FROM public.ai_model_catalog WHERE id = 'anthropic/claude-sonnet-5-5'),
  'claude-sonnet-5-5', 'the Sonnet successor sends provider model claude-sonnet-5-5');
SELECT is((SELECT provider_model FROM public.ai_model_catalog WHERE id = 'anthropic/claude-opus-5-5'),
  'claude-opus-5-5', 'the Opus row sends provider model claude-opus-5-5');
SELECT is((SELECT provider_model FROM public.ai_model_catalog WHERE id = 'openai/gpt-6.1-sol'),
  'gpt-6.1-sol', 'the Terra successor sends provider model gpt-6.1-sol');
SELECT is((SELECT display_name FROM public.ai_model_catalog WHERE id = 'anthropic/claude-sonnet-5-5'),
  'Claude Sonnet 5.5', 'the Sonnet successor carries its approved label');
SELECT is((SELECT display_name FROM public.ai_model_catalog WHERE id = 'openai/gpt-6.1-sol'),
  'GPT-6.1 Sol', 'the Terra successor carries its approved label');

-- ── enabled AND selectable, on every paid row that remains ─────────────────
-- `enabled` is still asserted separately from `selectable` because they still
-- mean different things: `enabled` is what makes a saved preference ROUTABLE,
-- `selectable` is what lets a user acquire that preference in the first place.
-- Phase D is the first point at which both are true for every paid row at once.
SELECT ok((SELECT bool_and(enabled) FROM public.ai_model_catalog
            WHERE provider <> 'google'),
  'every remaining paid model is enabled, so a saved preference for one is routable');
SELECT ok((SELECT bool_and(selectable) FROM public.ai_model_catalog
            WHERE provider <> 'google'),
  'every remaining paid model is selectable, so an entitled user can choose one');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The C41 reasoning metadata, exactly and in order
-- ════════════════════════════════════════════════════════════════════════════
--
-- `reasoning_levels` is an ARRAY, and the comparison is array equality rather
-- than set containment, so the ORDER is pinned too: it is the order a future
-- manual-reasoning control would render, and the two providers' vocabularies
-- differ at exactly the first element (`off` vs `none`).

-- `off` and `none` were the FIRST element of each retired row's list, and they
-- left the product with those rows. Both are still canonical vocabulary (016
-- owns that), but no row may offer either any more: every surviving model
-- rejects them at the provider, so a row listing one would let Automatic or a
-- user send a request the provider refuses, at the cost of a quota unit.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE 'off' = ANY (reasoning_levels)),
  0, 'no row offers Anthropic''s `off` any more — it retired with Claude Sonnet 5');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE 'none' = ANY (reasoning_levels)),
  0, 'no row offers OpenAI''s `none` any more — it retired with GPT-5.6 Terra');

-- The successors' lists, in order. Both providers converged on the same five
-- effort levels, which is why the first-element divergence above is gone.
SELECT is((SELECT reasoning_levels FROM public.ai_model_catalog
            WHERE id = 'anthropic/claude-sonnet-5-5'),
  ARRAY['low','medium','high','xhigh','max'],
  'Claude Sonnet 5.5 reasoning levels are low/medium/high/xhigh/max, in order');
SELECT is((SELECT reasoning_levels FROM public.ai_model_catalog
            WHERE id = 'openai/gpt-6.1-sol'),
  ARRAY['low','medium','high','xhigh','max'],
  'GPT-6.1 Sol reasoning levels are low/medium/high/xhigh/max, in order');

-- The spellings are still NOT interchangeable, and the guard is still worth
-- stating: collapsing the vocabularies would let an adapter be handed the
-- other's word. No paid row may carry any of the three foreign spellings.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE provider IN ('anthropic','openai')
              AND reasoning_levels && ARRAY['off','none','minimal']),
  0, 'no paid row offers off, none or Google''s minimal');

-- ── Automatic: the per-operation levels PaperLume chose ────────────────────
-- The retired rows' Automatic Analyze levels were the two provider-rejected
-- values; every successor uses the lowest tier it really offers.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE provider <> 'google' AND auto_analyze_reasoning_level = 'low'),
  3, 'Automatic Analyze is low on every remaining paid model');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE provider <> 'google' AND auto_suggest_reasoning_level = 'medium'),
  3, 'Automatic Suggest is medium on every remaining paid model');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE auto_analyze_reasoning_level IN ('off','none')
               OR auto_suggest_reasoning_level IN ('off','none')),
  0, 'no row''s Automatic policy still names a provider-rejected level');

-- Whole-row identity, so a column cannot drift onto the wrong model while every
-- individual assertion above still lines up. Suite 029 owns the full seven-row
-- form; here it is scoped to the paid rows that replaced this suite's subjects.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable) IN (
      ('anthropic/claude-sonnet-5-5','anthropic','claude-sonnet-5-5','Claude Sonnet 5.5',
       true,true,50,ARRAY['low','medium','high','xhigh','max'],'low','medium',true),
      ('anthropic/claude-opus-5-5','anthropic','claude-opus-5-5','Claude Opus 5.5',
       true,true,60,ARRAY['low','medium','high','xhigh','max'],'low','medium',true),
      ('openai/gpt-6.1-sol','openai','gpt-6.1-sol','GPT-6.1 Sol',
       true,true,70,ARRAY['low','medium','high','xhigh','max'],'low','medium',true))),
  3, 'each remaining paid row matches its approved metadata as a whole row');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The four Google rows are exactly as they were
-- ════════════════════════════════════════════════════════════════════════════
--
-- The invariant a careless edit of the 001E migration would break. Asserted
-- positively, as whole rows, rather than by counting what changed. The one
-- field that differs from 001E's own snapshot is `reasoning_selectable`, which
-- AI-MANUAL-REASONING-001 later set to true on every row.

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
  4, 'all four Google rows are unchanged by 001E and by the Phase-D cutover, as whole rows');

-- Phase D renumbered the paid rows to 50 / 60 / 70, closing the gap the two
-- deletions left — and it still did not renumber a Google row.
SELECT is((SELECT array_agg(sort_order ORDER BY sort_order)
             FROM public.ai_model_catalog WHERE provider = 'google'),
  ARRAY[10,20,30,40], 'the Google rows kept their original sort positions');
SELECT ok((SELECT min(sort_order) FROM public.ai_model_catalog WHERE provider <> 'google')
          > (SELECT max(sort_order) FROM public.ai_model_catalog WHERE provider = 'google'),
  'every paid model still sorts after every Google model');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. No user preference was created or rewritten
-- ════════════════════════════════════════════════════════════════════════════

SELECT is((SELECT count(*)::int FROM public.user_ai_preferences), 0,
  'the migrations created no user preference row');
-- On a fresh replay there is nothing to migrate, so this is the structural
-- half: no preference can reference a retired model, because the FK would have
-- refused it and Phase D proved zero references before deleting the rows. The
-- POPULATED case — a saved preference at every old level, migrated to its
-- successor — is proved by `runCatalogCutoverLane` in `scripts/e2e-local.mjs`.
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE preferred_model_id IN ('anthropic/claude-sonnet-5','openai/gpt-5.6-terra')),
  0, 'no preference references a retired paid model');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE preferred_reasoning_level IS NOT NULL),
  0, 'no manual reasoning preference exists');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. The setter now ACCEPTS both paid models — for an ENTITLED caller only
-- ════════════════════════════════════════════════════════════════════════════
--
-- The load-bearing test of the activation. Before Phase 8 this section proved
-- the mirror image: the same entitled caller was refused with
-- `model_not_selectable`. That refusal is exactly what the activation removes,
-- so the assertion is inverted rather than deleted — and the deleted half is
-- not lost coverage, because 20260917201856's own verify block still proves the
-- rows were inserted non-selectable, and it is replayed on every reset.
--
-- It must run as a caller who is entitled, or it proves nothing about
-- `selectable`: an acceptance for an unentitled user would be impossible for a
-- different reason. `set_current_user_ai_model` checks entitlement, then plan
-- status, then existence, then `enabled`, then `selectable` — so a successful
-- save positively proves the row passed every one of those gates, including the
-- flag this migration set.

INSERT INTO auth.users (id, email) VALUES
  ('e8000000-0000-0000-0000-000000000001','suite018-entitled@paperlume.test');

UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'active', ai_model_selection_enabled = true
 WHERE user_id = 'e8000000-0000-0000-0000-000000000001';

-- Positive control FIRST: this caller really can save a model. Without it, the
-- acceptances below would be consistent with a fixture that accepts anything.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('google/gemini-3.8-flash')$q$),
  'ok', 'control: the entitled caller can save a selectable Google model');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT saved::text FROM public.set_current_user_ai_model('google/gemini-3.8-flash')$q$),
  'true', 'control: that save reported success');

-- Both retired ids are now refused as `unknown_model` — not `model_disabled`
-- and not `model_not_selectable`. That distinction is the whole difference
-- between deleting a row and hiding one, and it is visible right here: the
-- catalog lookup finds nothing at all, so the setter never reaches a flag.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('anthropic/claude-sonnet-5')$q$),
  'unknown_model', 'the setter refuses the retired Claude Sonnet 5 as unknown');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT saved::text FROM public.set_current_user_ai_model('anthropic/claude-sonnet-5')$q$),
  'false', 'that refused Claude selection was not saved');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('openai/gpt-5.6-terra')$q$),
  'unknown_model', 'the setter refuses the retired GPT-5.6 Terra as unknown');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT saved::text FROM public.set_current_user_ai_model('openai/gpt-5.6-terra')$q$),
  'false', 'that refused Terra selection was not saved');
-- Four refusals, and the control's save is still exactly where it was.
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'e8000000-0000-0000-0000-000000000001'),
  'google/gemini-3.8-flash', 'the retired-model refusals left the caller''s saved model untouched');

-- And each successor IS accepted for the same entitled caller, which is what
-- makes the refusals above about the retirement rather than about the caller.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('anthropic/claude-sonnet-5-5')$q$),
  'ok', 'the setter accepts the Sonnet successor for an entitled caller');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('openai/gpt-6.1-sol')$q$),
  'ok', 'the setter accepts the Terra successor for an entitled caller');
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'e8000000-0000-0000-0000-000000000001'),
  'openai/gpt-6.1-sol', 'the caller''s saved model is now GPT-6.1 Sol');

-- ── Entitlement is untouched by activation ────────────────────────────────
-- The corollary that matters most: making a model choosable did not make
-- anyone able to choose. An unentitled caller is refused at the FIRST gate,
-- before `selectable` is ever consulted, so a paid model is no more reachable
-- for them than a Google one ever was.
INSERT INTO auth.users (id, email) VALUES
  ('e8000000-0000-0000-0000-000000000002','suite018-unentitled@paperlume.test');

-- Asserted against a model that EXISTS, so the refusal is attributable to
-- entitlement rather than to the retirement: a retired id would be refused for
-- the wrong reason and prove nothing about the gate.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000002'),
  $q$SELECT reason FROM public.set_current_user_ai_model('anthropic/claude-sonnet-5-5')$q$),
  'not_entitled', 'an unentitled caller is refused Claude Sonnet 5.5 as not entitled');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000002'),
  $q$SELECT saved::text FROM public.set_current_user_ai_model('openai/gpt-6.1-sol')$q$),
  'false', 'an unentitled caller cannot save GPT-6.1 Sol either');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE user_id = 'e8000000-0000-0000-0000-000000000002'),
  0, 'the refused unentitled caller has no saved preference at all');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. A saved paid preference is ROUTABLE
-- ════════════════════════════════════════════════════════════════════════════
--
-- The other half of `enabled = true`. Before Phase 8 this was the mechanism the
-- canaries used: the setter would not create such a preference, but one written
-- directly by an operator had to resolve, or a canary would silently run on the
-- system default while appearing to test a paid provider. After Phase 8 an
-- entitled user's own choice lands in the same row, and it must resolve the
-- same way.
--
-- This is the DATABASE-side fact: the row is enabled, and the catalog join a
-- resolver performs still returns it. The runtime's own handling of that row is
-- pinned by the Vitest suites for `_shared/aiModelSelection.ts`.

INSERT INTO public.user_ai_preferences (user_id, preferred_model_id)
VALUES ('e8000000-0000-0000-0000-000000000001', 'anthropic/claude-sonnet-5-5')
ON CONFLICT (user_id) DO UPDATE SET preferred_model_id = 'anthropic/claude-sonnet-5-5';

SELECT is(
  (SELECT c.provider_model
     FROM public.user_ai_preferences p
     JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id
    WHERE p.user_id = 'e8000000-0000-0000-0000-000000000001'
      AND c.enabled),
  'claude-sonnet-5-5',
  'a saved Sonnet 5.5 preference resolves to a routable provider model');

-- And it is selectable as well as routable: after Phase D the two flags agree
-- for every paid row, which is what the cutover completed.
SELECT ok(
  (SELECT c.enabled AND c.selectable
     FROM public.user_ai_preferences p
     JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id
    WHERE p.user_id = 'e8000000-0000-0000-0000-000000000001'),
  'that routable preference names a model that is user-selectable too');

DELETE FROM public.user_ai_preferences WHERE user_id = 'e8000000-0000-0000-0000-000000000001';

-- ════════════════════════════════════════════════════════════════════════════
-- 7. The catalog is still credential-free and still read-only to clients
-- ════════════════════════════════════════════════════════════════════════════
--
-- Two PAID providers now have rows, so "there is nowhere here to put an API
-- key" stops being hypothetical: a credential column would be a credential in
-- a table every signed-in user can SELECT.

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

SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT count(*) FROM public.ai_model_catalog$q$),
  '42501', 'anon still cannot read the catalog');

-- Targets a row that EXISTS. A write refusal aimed at a retired id would be
-- weaker evidence: a reader could take it for "nothing matched" rather than
-- "the grant refused it". The grant check fires before any row is examined, and
-- naming a live row is what makes that unambiguous.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$UPDATE public.ai_model_catalog SET selectable = false WHERE id = 'anthropic/claude-sonnet-5-5'$q$),
  '42501',
  'an entitled user cannot close a paid model by writing the catalog');
-- And cannot bring a retired one back, which is the Phase-D-specific form.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$INSERT INTO public.ai_model_catalog (id, provider, provider_model, display_name)
     VALUES ('anthropic/claude-sonnet-5','anthropic','claude-sonnet-5','Claude Sonnet 5')$q$),
  '42501',
  'nor re-create a retired paid model');

SELECT * FROM finish();
ROLLBACK;
