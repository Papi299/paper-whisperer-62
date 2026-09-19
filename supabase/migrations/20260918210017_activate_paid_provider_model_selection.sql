-- AI-MULTI-PROVIDER-001E Phase 8 — open the two canaried paid-provider models
-- to user selection.
--
-- This migration does ONE thing: it sets `selectable = true` on exactly two
-- existing rows of public.ai_model_catalog. It inserts nothing, deletes
-- nothing, and changes no other column of those rows or any other row.
--
-- ## Why this is the whole change
--
-- The catalog IS the allowlist (C33/C35/C39), and the two flags are
-- deliberately independent (C43):
--
--   * `enabled = true` — the RESOLVER honours a saved preference naming the
--     model. Both paid rows have been `enabled` since 20260917201856, which is
--     what let Phase 7 canary them through an operator-written preference.
--   * `selectable = false` — the SETTER (`set_current_user_ai_model`) refuses
--     the model with `model_not_selectable`, and the Settings control never
--     lists it. That is the flag this migration flips.
--
-- So no file under supabase/functions/, src/components/settings/ or src/hooks/
-- changes for this, and none may: the runtime holds no TypeScript list of model
-- strings and the Settings control renders whatever rows are
-- `enabled AND selectable` from a provider the shipped UI can route to. A
-- second allowlist in code could disagree with this one.
--
-- ## What earned it
--
-- Phase 7 completed on 2026-09-18 (docs/deployment.md §14.1a): both credentials
-- installed, both generation functions redeployed from the reviewed merge, and
-- four live Production canaries — Claude Analyze/Suggest and Terra
-- Analyze/Suggest — each at `provider_attempts = 1`, each recording one
-- content-free telemetry event with `cost_status = estimated` against the
-- reviewed price records, one quota unit per success, and no library mutation.
-- The Edge-log privacy hardening that gated broad activation was merged and
-- deployed the same day (EDGE-LOG-PRIVACY-HARDENING-001).
--
-- ## What this migration explicitly does NOT do
--
--   * It does NOT change `enabled`, `provider`, `provider_model`,
--     `display_name`, `sort_order`, `reasoning_levels`,
--     `auto_analyze_reasoning_level`, `auto_suggest_reasoning_level` or
--     `reasoning_selectable` on any row.
--   * It does NOT touch the four Google rows. The verify block proves that
--     positively rather than by omission.
--   * It does NOT enable manual reasoning. `reasoning_selectable` stays false
--     on every row and `set_current_user_ai_reasoning` stays ungranted — C41's
--     staging lock is untouched, and this activation is model selection only.
--   * It does NOT change entitlement. `can_select_ai_model` still decides WHO
--     may choose; this decides only WHAT is choosable. A user who is not
--     entitled still resolves to the system default and gains nothing here.
--   * It does NOT write, backfill or migrate any saved preference. Nobody is
--     moved onto a paid model; users who want one must choose it themselves
--     through the ordinary setter.
--   * It does NOT change the system default (C34), any grant, policy, RLS
--     setting, function, trigger, index, quota or billing value, and it adds no
--     credential.
--
-- Durable decisions: C33 (the capability and the catalog), C34 (the system
-- default), C39 (a provider needs a reviewed adapter AND its own credential),
-- C41 (PaperLume's own reasoning policy), C43 (stage → canary → activate).


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Preconditions, the mutation, and the affected-row count — one atomic block
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The UPDATE is deliberately NOT written as a bare statement. An unguarded
-- `UPDATE … SET selectable = true WHERE id IN (…)` would silently succeed
-- against a catalog in some state nobody reviewed — a row with different
-- reasoning metadata, a row somebody had already flipped, or a database where
-- the staging migration never ran. Each precondition below is a state this
-- activation assumes; if one is false the migration aborts and the transaction
-- rolls back, rather than normalizing the surprise away.
DO $activate$
DECLARE
  v_count   INTEGER;
  v_updated INTEGER;
BEGIN
  -- ── The catalog is the six approved rows ─────────────────────────────────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: catalog holds % row(s); expected exactly 6', v_count;
  END IF;

  -- ── Exactly two rows are targeted, and they are the two intended ids ──────
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE id IN ('anthropic/claude-sonnet-5', 'openai/gpt-5.6-terra');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: % target row(s) present; expected exactly 2', v_count;
  END IF;

  -- ── Both are in EXACTLY the state 20260917201856 staged ──────────────────
  -- Field by field, including the flags and the reasoning metadata: this
  -- migration is only authorized to move `selectable`, so everything else must
  -- already be what Phase 7 canaried. A drifted row fails here rather than
  -- being activated on trust.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
         reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
         reasoning_selectable) IN (
    ('anthropic/claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5',
     true, false, 50,
     ARRAY['off','low','medium','high','xhigh','max'], 'off', 'medium', false),
    ('openai/gpt-5.6-terra', 'openai', 'gpt-5.6-terra', 'GPT-5.6 Terra',
     true, false, 60,
     ARRAY['none','low','medium','high','xhigh','max'], 'none', 'medium', false)
  );
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: the two paid rows are not in the exact staged pre-activation state';
  END IF;

  -- ── Manual reasoning is off everywhere, before and therefore after ────────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog WHERE reasoning_selectable;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: % catalog row(s) already offer manual reasoning', v_count;
  END IF;

  -- ── The four Google rows are exactly as they were ─────────────────────────
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
         reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
         reasoning_selectable) IN (
    ('google/gemini-3.5-flash', 'google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', true, true, 10,
     ARRAY['minimal','low','medium','high'], 'minimal', 'medium', false),
    ('google/gemini-3.6-flash', 'google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', true, true, 20,
     ARRAY['minimal','low','medium','high'], 'minimal', 'medium', false),
    ('google/gemini-3.7-flash', 'google', 'gemini-3.7-flash', 'Gemini 3.7 Flash', true, true, 30,
     ARRAY['low','medium','high'], 'low', 'medium', false),
    ('google/gemini-3.8-flash', 'google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', true, true, 40,
     ARRAY['low','medium','high'], 'low', 'medium', false)
  );
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: the four Google catalog rows are not exactly as they were';
  END IF;

  -- ── The mutation ─────────────────────────────────────────────────────────
  -- Scoped by id AND by the flag being false, so a re-run cannot quietly
  -- report success over rows it did not actually change; the count below is
  -- therefore an exact statement about what this transaction did.
  UPDATE public.ai_model_catalog
     SET selectable = true
   WHERE id IN ('anthropic/claude-sonnet-5', 'openai/gpt-5.6-terra')
     AND NOT selectable;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 2 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: activation updated % row(s); expected exactly 2', v_updated;
  END IF;
END
$activate$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Asserts what this migration claims, in the same transaction that claims it,
-- in the style of 20260902120000 §7, 20260903120000 §2 and 20260917201856 §2.
--
-- Every row this transaction wrote carries updated_at = now() (the BEFORE
-- UPDATE trigger) and every row it did not is strictly older, so "nothing else
-- was written" is proven by timestamp rather than by trust.
DO $verify$
DECLARE
  v_count INTEGER;
BEGIN
  -- ── Still exactly six rows: nothing was inserted or deleted ──────────────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: catalog holds % row(s) after activation; expected exactly 6', v_count;
  END IF;

  -- ── The two paid rows are now EXACTLY as specified, selectable included ───
  -- The full tuple again, with `selectable` the single changed value: this is
  -- what proves the migration moved one field and nothing else.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
         reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
         reasoning_selectable) IN (
    ('anthropic/claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5',
     true, true, 50,
     ARRAY['off','low','medium','high','xhigh','max'], 'off', 'medium', false),
    ('openai/gpt-5.6-terra', 'openai', 'gpt-5.6-terra', 'GPT-5.6 Terra',
     true, true, 60,
     ARRAY['none','low','medium','high','xhigh','max'], 'none', 'medium', false)
  );
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: the two paid rows are not exactly as specified after activation';
  END IF;

  -- ── Both paid rows are selectable, stated on its own ─────────────────────
  -- Restated separately from the tuple match so the failure message names the
  -- specific outcome this migration exists to produce.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE provider IN ('anthropic', 'openai') AND selectable;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: % paid-provider row(s) are selectable; expected exactly 2', v_count;
  END IF;

  -- ── Manual reasoning is STILL off everywhere ─────────────────────────────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog WHERE reasoning_selectable;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: % catalog row(s) offer manual reasoning', v_count;
  END IF;

  -- ── And the setter that would expose it is still granted to nobody ───────
  IF has_function_privilege('authenticated', 'public.set_current_user_ai_reasoning(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_catalog_phase8: authenticated can execute set_current_user_ai_reasoning';
  END IF;

  -- ── The four Google rows are untouched, field by field ───────────────────
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
         reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
         reasoning_selectable) IN (
    ('google/gemini-3.5-flash', 'google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', true, true, 10,
     ARRAY['minimal','low','medium','high'], 'minimal', 'medium', false),
    ('google/gemini-3.6-flash', 'google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', true, true, 20,
     ARRAY['minimal','low','medium','high'], 'minimal', 'medium', false),
    ('google/gemini-3.7-flash', 'google', 'gemini-3.7-flash', 'Gemini 3.7 Flash', true, true, 30,
     ARRAY['low','medium','high'], 'low', 'medium', false),
    ('google/gemini-3.8-flash', 'google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', true, true, 40,
     ARRAY['low','medium','high'], 'low', 'medium', false)
  );
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: the four Google catalog rows are not exactly as they were';
  END IF;

  -- ── Nothing in the catalog was written except the two paid rows ──────────
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE updated_at >= now()
    AND id NOT IN ('anthropic/claude-sonnet-5', 'openai/gpt-5.6-terra');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: % other catalog row(s) were modified', v_count;
  END IF;

  -- ── Order is unchanged: 3.5, 3.6, 3.7, 3.8, Sonnet, Terra ────────────────
  IF (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog)
     IS DISTINCT FROM ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
                            'google/gemini-3.7-flash','google/gemini-3.8-flash',
                            'anthropic/claude-sonnet-5','openai/gpt-5.6-terra'] THEN
    RAISE EXCEPTION 'ai_catalog_phase8: catalog order is not the six approved models in order';
  END IF;

  -- ── No user preference was written, created or backfilled ────────────────
  -- Activation makes a model CHOOSABLE; it never chooses for anyone. Asserted
  -- by write timestamp rather than by absolute state, so this stays true when
  -- the migration is replayed on a database where users have since chosen one.
  SELECT count(*) INTO v_count
  FROM public.user_ai_preferences
  WHERE updated_at >= now();
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: % user preference row(s) were written', v_count;
  END IF;

  -- ── No entitlement was written ───────────────────────────────────────────
  -- The corollary worth naming: nobody gained the model-selection capability
  -- because the paid rows became selectable. `can_select_ai_model` is
  -- unchanged, so an unentitled user still resolves to the system default.
  SELECT count(*) INTO v_count
  FROM public.user_entitlements
  WHERE updated_at >= now();
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_phase8: % entitlement row(s) were written', v_count;
  END IF;
END
$verify$;
