-- AI-MULTI-PROVIDER-001E — stage the two paid-provider models in the
-- server-controlled catalog, enabled but NOT user-selectable.
--
-- This migration does ONE thing: it inserts two reviewed rows into
-- public.ai_model_catalog. That is the entire change, for the same reason
-- 20260903120000 gave — the catalog IS the allowlist:
--
--   * the generation runtime (supabase/functions/_shared/aiModelSelection.ts)
--     holds no TypeScript list of model strings. It reads the caller's saved
--     preference, resolves it through this table, requires `enabled` and a
--     REGISTERED provider, and hands the row's trimmed `provider_model` to that
--     provider's adapter.
--   * the Settings control holds no model list either. It renders whatever rows
--     are `enabled AND selectable` and come from a provider the shipped UI can
--     route to.
--
-- So a reviewed row here — and nothing else — is what makes another model
-- routable. No file under supabase/functions/, src/components/settings/ or
-- src/hooks/ changes for this, and none may: a second allowlist in TypeScript
-- could disagree with this one.
--
-- ## Why `selectable = false`
--
-- The deliberate difference from every Google row. `enabled = true` means the
-- resolver will route a saved preference for this model; `selectable = false`
-- means the Settings control does not offer it, so no ordinary user can save
-- that preference in the first place. The two flags together stage a model that
-- is reachable ONLY by an operator who sets a preference row directly — which
-- is exactly the bounded surface the Phase-7 paid-provider canaries need, and
-- exactly the surface an un-canaried paid provider must not have any wider.
--
-- Flipping `selectable = true` is the separate, post-canary Phase-8 activation
-- described in docs/decisions-and-triggers.md. It is NOT in this file, on
-- purpose: a migration that could be applied before the canaries ran is a
-- migration that could activate a paid provider before anyone has proven it
-- works, and `supabase db push` applies whatever is on disk.
--
-- ## Reachability after this migration
--
-- Still none, in Production. A catalog row is one of three independent things a
-- request needs, and the other two remain absent:
--
--   * the adapters are registered AND deployed — Phase 6 (2026-09-17) shipped
--     analyze-paper v27 and suggest-paper-organization v11, both of which
--     contain the Anthropic and OpenAI adapters;
--   * no ANTHROPIC_API_KEY and no OPENAI_API_KEY exist on any server, so
--     `_shared/aiProviderCredentials.ts` fails closed for both providers;
--   * this migration is NOT auto-applied to Production. Applying it is a
--     separate, separately authorized rollout step.
--
-- ## Provider acceptance (first-party documentation, re-read 2026-09-17)
--
--   * claude-sonnet-5 — current, listed on Anthropic's models overview with a
--     retirement commitment no sooner than June 30, 2027;
--     adaptive thinking; effort vocabulary low|medium|high|xhigh|max with
--     `thinking: {type:"disabled"}` accepted, which is how PaperLume spells
--     `off`. 1M context, 128K max output.
--     https://platform.claude.com/docs/en/about-claude/models/overview
--   * gpt-5.6-terra — current, available on the Responses API; reasoning.effort
--     is none|low|medium|high|xhigh|max, default medium.
--     https://developers.openai.com/api/docs/models/gpt-5.6-terra
--
-- Both speak contracts the deployed adapters already implement, so no
-- request-body, prompt, parsing, timeout or retry change accompanies this.
--
-- ## What this migration explicitly does NOT do
--
--   * It does NOT set `selectable = true` on either row. See above.
--   * It does NOT set `reasoning_selectable = true` on any row, grant
--     `set_current_user_ai_reasoning` to `authenticated`, or create a manual
--     reasoning preference. Manual reasoning stays off; this owner decision
--     activates paid providers, not manual reasoning.
--   * It does NOT change the system default. That remains the Google model
--     resolved server-side from GEMINI_MODEL (decision C34).
--   * It does NOT touch any of the four Google rows — not their ids, provider
--     models, display names, flags, reasoning metadata or sort order. The
--     verify block proves that positively rather than by omission.
--   * It does NOT touch any user's saved preference. Adding a model to the
--     catalog is additive product metadata; nobody's choice moves.
--   * It adds NO credential and no column. Credentials live only in the Edge
--     environment and are installed by a separate rollout step.
--   * It changes no grant, policy, RLS setting, function, trigger, index,
--     entitlement, quota or billing value.
--
-- Durable decisions: C33 (the capability and the catalog), C34 (the system
-- default), C39 (a provider needs a reviewed adapter AND its own credential),
-- C41 (PaperLume's own reasoning policy, stated per model).


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The two newly approved rows
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A plain INSERT, with NO `ON CONFLICT` clause of any kind — the same drift
-- detector 20260903120000 used. The primary key and the
-- (provider, provider_model) UNIQUE constraint are what make a pre-existing row
-- in some state nobody reviewed fail this migration visibly at replay, rather
-- than let it be quietly reconciled into the shape this file expects.
-- `ON CONFLICT DO UPDATE` would overwrite exactly the evidence worth seeing,
-- and `ON CONFLICT DO NOTHING` would accept conflicting metadata in silence.
--
-- sort_order continues the sparse 10/20/30/40 spacing of the Google rows, so
-- the paid models append after Gemini 3.8 without renumbering a row anyone may
-- already have saved.
--
-- The reasoning metadata is each provider's OWN published vocabulary, not a
-- shared one, and is exactly what 20260912120000 §3 reviewed and recorded as
-- the staging values for these two models:
--
--   * Anthropic spells "do not think" `off` (thinking disabled) and has no
--     `none`; its five effort values follow.
--   * OpenAI spells the same idea `none` and has no `off`.
--   * Neither provider offers Google's `minimal`.
--
-- Analyze takes the cheapest level each provider has (`off` / `none`) because
-- extracting a TLDR and a study type from a title and abstract is not a
-- reasoning task; Suggest takes `medium` because matching a paper against a
-- user's Projects and Tags is.
INSERT INTO public.ai_model_catalog
    (id, provider, provider_model, display_name, enabled, selectable, sort_order,
     reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
     reasoning_selectable)
VALUES
    ('anthropic/claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5',
     true, false, 50,
     ARRAY['off','low','medium','high','xhigh','max'], 'off', 'medium', false),
    ('openai/gpt-5.6-terra', 'openai', 'gpt-5.6-terra', 'GPT-5.6 Terra',
     true, false, 60,
     ARRAY['none','low','medium','high','xhigh','max'], 'none', 'medium', false);


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Asserts what this migration claims, in the same transaction that claims it,
-- in the style of 20260902120000 §7 and 20260903120000 §2.
--
-- Every row this transaction wrote carries updated_at = now() (the INSERT
-- default, or the BEFORE UPDATE trigger) and every row it did not is strictly
-- older, so "nothing else was written" is proven by timestamp rather than by
-- trust.
DO $verify$
DECLARE
  v_count INTEGER;
BEGIN
  -- ── Exactly six rows, and exactly the six approved ones ──────────────────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_catalog_001e: catalog holds % row(s); expected exactly 6', v_count;
  END IF;

  -- ── The two new rows are EXACTLY as specified, flags included ────────────
  -- selectable = false and reasoning_selectable = false are asserted as values,
  -- not assumed from a default, because they are the whole safety property of
  -- this migration.
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
    RAISE EXCEPTION 'ai_catalog_001e: the two paid-provider rows are not exactly as specified';
  END IF;

  -- ── NEITHER paid row is selectable, stated on its own ────────────────────
  -- Restated separately from the tuple match above so the failure message names
  -- the specific harm: a paid provider offered to users before it was canaried.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE provider IN ('anthropic', 'openai')
    AND selectable;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_001e: % paid-provider row(s) are user-selectable', v_count;
  END IF;

  -- ── Manual reasoning is off EVERYWHERE, not merely on the new rows ───────
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE reasoning_selectable;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_001e: % catalog row(s) offer manual reasoning', v_count;
  END IF;

  -- ── The four Google rows are untouched, field by field ───────────────────
  -- Positively, rather than by counting what changed: this is the invariant a
  -- careless UPDATE in a future edit of this file would break.
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
    RAISE EXCEPTION 'ai_catalog_001e: the four Google catalog rows are not exactly as they were';
  END IF;

  -- ── Nothing in the catalog was written except the two new rows ───────────
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE updated_at >= now()
    AND id NOT IN ('anthropic/claude-sonnet-5', 'openai/gpt-5.6-terra');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_001e: % pre-existing catalog row(s) were modified', v_count;
  END IF;

  -- ── Order is 3.5, 3.6, 3.7, 3.8, Sonnet, Terra ───────────────────────────
  IF (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog)
     IS DISTINCT FROM ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
                            'google/gemini-3.7-flash','google/gemini-3.8-flash',
                            'anthropic/claude-sonnet-5','openai/gpt-5.6-terra'] THEN
    RAISE EXCEPTION 'ai_catalog_001e: catalog order is not the six approved models in order';
  END IF;

  -- ── No user preference was rewritten, cleared or created ─────────────────
  SELECT count(*) INTO v_count
  FROM public.user_ai_preferences
  WHERE updated_at >= now();
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_001e: % user preference row(s) were written', v_count;
  END IF;

  -- Corollary, stated separately because it is the mistake worth naming: nobody
  -- was migrated ONTO a paid model. Such a preference cannot exist yet — the
  -- rows did not exist before this transaction, and they are not selectable.
  SELECT count(*) INTO v_count
  FROM public.user_ai_preferences
  WHERE preferred_model_id IN ('anthropic/claude-sonnet-5', 'openai/gpt-5.6-terra');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_001e: % preference row(s) point at a model added by this migration', v_count;
  END IF;

  -- ── No manual reasoning preference was created ───────────────────────────
  SELECT count(*) INTO v_count
  FROM public.user_ai_preferences
  WHERE preferred_reasoning_level IS NOT NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_001e: % manual reasoning preference(s) exist', v_count;
  END IF;

  -- ── No entitlement was granted or revoked ────────────────────────────────
  -- Adding a model changes WHAT an entitled user may pick, never WHO is
  -- entitled. C33's gate is untouched.
  SELECT count(*) INTO v_count
  FROM public.user_entitlements
  WHERE updated_at >= now();
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_001e: % entitlement row(s) were written', v_count;
  END IF;

  -- ── The manual-reasoning setter is still ungranted to authenticated ──────
  -- The grant is the other half of manual reasoning, and this migration is not
  -- where it happens. Asserted here so a grant made anywhere else fails at
  -- replay rather than at runtime.
  IF has_function_privilege('authenticated',
                            'public.set_current_user_ai_reasoning(text)'::regprocedure,
                            'EXECUTE') THEN
    RAISE EXCEPTION 'ai_catalog_001e: authenticated can execute set_current_user_ai_reasoning';
  END IF;

  -- ── The catalog is still credential-free product metadata ────────────────
  -- Two paid providers now have rows, so the column set mattering is no longer
  -- hypothetical: there must remain nowhere here to put an API key.
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'ai_model_catalog'
    AND column_name ~* '(key|secret|token|credential|password)';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_001e: the catalog gained a column that could hold credential material';
  END IF;

  -- ── The read-only-to-clients posture is exactly as 001A left it ──────────
  IF has_table_privilege('anon', 'public.ai_model_catalog',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'ai_catalog_001e: anon holds a privilege on the catalog';
  END IF;
  IF has_table_privilege('service_role', 'public.ai_model_catalog', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ai_catalog_001e: service_role holds a privilege on the catalog';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.ai_model_catalog', 'SELECT') THEN
    RAISE EXCEPTION 'ai_catalog_001e: authenticated cannot read the catalog';
  END IF;
  IF has_table_privilege('authenticated', 'public.ai_model_catalog', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ai_catalog_001e: authenticated can write the catalog directly';
  END IF;
END
$verify$;
