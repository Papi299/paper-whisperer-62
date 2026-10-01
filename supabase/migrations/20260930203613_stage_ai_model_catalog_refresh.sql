-- AI-MODEL-CATALOG-REFRESH-001A — stage the three replacement paid-provider
-- models in the server-controlled catalog, enabled but NOT user-selectable and
-- NOT open to manual reasoning.
--
-- This migration does ONE thing: it inserts three reviewed rows into
-- public.ai_model_catalog. It updates nothing, deletes nothing, and writes no
-- other table. That is the entire change, for the reason 20260917201856 gave —
-- the catalog IS the allowlist:
--
--   * the generation runtime (supabase/functions/_shared/aiModelSelection.ts)
--     holds no TypeScript list of model strings. It resolves a saved preference
--     through this table, requires `enabled` and a REGISTERED provider, and hands
--     the row's trimmed `provider_model` to that provider's adapter;
--   * the Settings control holds no model list either. It renders whatever rows
--     are `enabled AND selectable` and come from a provider the shipped UI can
--     route to.
--
-- Both new providers are already registered (`anthropic`, `openai`), so no
-- adapter, registry, credential or Settings change accompanies this file.
--
-- ## The owner-approved target, and why this file is only its first step
--
-- The FINAL user-selectable list the owner approved is the four Gemini rows,
-- Claude Sonnet 5.5, Claude Opus 5.5 and GPT-6.1 Sol — replacing Claude Sonnet 5
-- and GPT-5.6 Terra. Reaching it is four separately authorized phases, and this
-- file is Phase A only:
--
--   A. (this file) insert the three replacements, staged;
--   B. apply this migration in Production and deploy the Edge Functions that
--      carry the new price records;
--   C. canary each new model, Analyze and Suggest, through an operator-written
--      preference on the acceptance account;
--   D. a SEPARATE forward migration that migrates saved preferences off the two
--      old rows, removes those rows, and opens the three new ones.
--
-- Nothing here retires, disables or reorders an existing row, and nothing here
-- moves anyone's saved preference. Both old models stay fully selectable and
-- routable throughout Phase A, which is exactly why no preference needs to move
-- yet. docs/deployment.md §16 carries the runbook for B–D.
--
-- ## Why `selectable = false` AND `reasoning_selectable = false`
--
-- The AI-MULTI-PROVIDER-001E Phase-7 staging pattern (C43), unchanged:
--
--   * `enabled = true` — the RESOLVER honours a saved preference naming the
--     model, so a deliberately provisioned operator preference routes to it.
--     That is what Phase C needs: a canary that silently fell back to Gemini
--     would look healthy while testing nothing.
--   * `selectable = false` — `set_current_user_ai_model` refuses the model with
--     `model_not_selectable`, and the Settings control never lists it, so no
--     ordinary user can acquire that preference.
--   * `reasoning_selectable = false` — `set_current_user_ai_reasoning` refuses a
--     manual level with `reasoning_not_selectable`, so manual reasoning cannot be
--     chosen for a model that has not been accepted.
--
-- Opening any of the three is Phase D, NOT this file: `supabase db push` applies
-- whatever is on disk, and a file that could open a model before its canaries ran
-- could open it before anyone proved it works.
--
-- ## Provider acceptance (first-party documentation, re-read 2026-09-30)
--
--   * claude-sonnet-5-5 — current; 1M context, 128K max output. Adaptive
--     thinking, on by default. Effort `low | medium | high | xhigh | max`,
--     default `high`. `thinking: {type: "disabled"}` is REJECTED with a 400 at
--     every effort level; its lowest setting is instead `thinking: {type:
--     "between_tools"}`, a Sonnet-5.5-only THINKING MODE that is accepted at
--     `high` or below and rejected at `xhigh`/`max`. Non-default sampling
--     parameters and assistant prefill return 400; structured outputs use
--     `output_config.format`.
--       https://platform.claude.com/docs/en/about-claude/models/overview
--       https://platform.claude.com/docs/en/build-with-claude/effort
--       https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
--       https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
--   * claude-opus-5-5 — current; 1M context, 128K max output. Adaptive thinking
--     ALWAYS ON; `{type: "disabled"}` and `{type: "enabled"}` both return 400.
--     Effort `low | medium | high | xhigh | max`, default `medium`. Same
--     sampling / prefill / `output_config.format` rules.
--       https://platform.claude.com/docs/en/models/opus-5-5/migration-guide
--   * gpt-6.1-sol — 1,050,000 context, 128K max output; Responses API and
--     Structured Outputs supported. `reasoning.effort` is `low | medium |
--     high | xhigh | max`, default `medium`; "The none and minimal reasoning
--     efforts are not supported."
--       https://developers.openai.com/api/docs/models/gpt-6.1-sol
--
-- All three speak request contracts the deployed adapters already implement for
-- the five levels below — Anthropic `thinking: {type: "adaptive"}` plus
-- `output_config.effort`, OpenAI `reasoning.effort` — so no request-body,
-- prompt, parsing, timeout or retry change accompanies this.
--
-- ## PaperLume's reasoning metadata for the three rows (C41)
--
-- The same shape for all three, owner-approved:
--
--     reasoning_levels             = low, medium, high, xhigh, max
--     auto_analyze_reasoning_level = low
--     auto_suggest_reasoning_level = medium
--
-- What is deliberately NOT a catalog level, and why:
--
--   * `off` — PaperLume's spelling of `thinking: {type: "disabled"}`, which
--     BOTH new Claude models reject with a 400. Listing it would let a user (or
--     Automatic) send a request the provider refuses, at the cost of a quota
--     unit.
--   * `none` — OpenAI's "do not reason", which Sol rejects.
--   * `minimal` — Google's vocabulary; neither new provider model accepts it.
--   * `between_tools` — an Anthropic THINKING MODE, not an effort level, and
--     Sonnet-5.5-only. PaperLume's five exposed levels all run adaptive
--     thinking, and `between_tools` is not introduced here.
--   * `adaptive` — also a thinking mode, and Anthropic says explicitly not to
--     pass it as an effort value.
--
-- Automatic is PaperLume's OWN policy, stated explicitly per model and per
-- operation rather than inherited from a provider default (Sonnet 5.5 defaults
-- to `high`, Opus 5.5 and Sol to `medium`): Analyze takes the lowest tier these
-- models offer, Suggest takes `medium`. The Automatic values of every existing
-- row are unchanged.
--
-- ## Sort order
--
-- 70 / 80 / 90 — after every current row, with no renumbering. Because all three
-- rows are `selectable = false`, their position cannot change the list any user
-- sees. Phase D may normalize final positions once the old rows are gone.
--
-- ## What this migration explicitly does NOT do
--
--   * It does NOT touch the four Google rows, Claude Sonnet 5 or GPT-5.6 Terra —
--     not their ids, provider models, display names, flags, reasoning metadata
--     or sort order. Preconditions and postconditions prove that positively.
--   * It does NOT write, migrate, clear or create any saved preference, and it
--     changes no entitlement, usage counter, usage credit or telemetry row. Each
--     is fingerprinted before and after the INSERT, inside the same statement.
--   * It does NOT change the system default (C34 / GEMINI_MODEL).
--   * It adds NO credential, column, grant, policy, function, trigger or index.
--     Both providers reuse their existing ANTHROPIC_API_KEY / OPENAI_API_KEY.
--
-- Durable decisions: C33 (the capability and the catalog), C34 (the system
-- default), C39 (a provider needs a reviewed adapter AND its own credential),
-- C41 (PaperLume's own reasoning policy, stated per model), C43 (stage → canary
-- → activate).


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Preconditions, the INSERT and its in-statement proof — one atomic statement
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Deliberately ONE DO block. `supabase db push` wraps the file in a
-- transaction, but `supabase db reset` runs it statement-at-a-time, so only a
-- single statement keeps the preconditions, the write and the "nothing else
-- moved" fingerprints atomic under both — and keeps `now()` the same instant
-- for the write and for the check that reads it back.
--
-- Every precondition is a state this staging was reviewed against. If one is
-- false the migration aborts before anything changes, rather than normalizing
-- the surprise away. In particular, a pre-existing row for any of the three
-- models is a failure, never an UPDATE: overwriting a row nobody reviewed would
-- destroy exactly the evidence worth seeing.
DO $stage$
DECLARE
  v_count        INTEGER;
  v_inserted     INTEGER;
  v_prefs_before TEXT;
  v_ents_before  TEXT;
  v_ctrs_before  TEXT;
  v_creds_before TEXT;
  v_tele_before  TEXT;
BEGIN
  -- ── The catalog is exactly the six reviewed rows ─────────────────────────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: catalog holds % row(s); expected exactly 6', v_count;
  END IF;

  -- Field by field, flags and reasoning metadata included — the state
  -- 20260919075655 left, verified read-only in Production on 2026-09-30.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
         reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
         reasoning_selectable) IN (
    ('google/gemini-3.5-flash', 'google', 'gemini-3.5-flash', 'Gemini 3.5 Flash',
     true, true, 10, ARRAY['minimal','low','medium','high'], 'minimal', 'medium', true),
    ('google/gemini-3.6-flash', 'google', 'gemini-3.6-flash', 'Gemini 3.6 Flash',
     true, true, 20, ARRAY['minimal','low','medium','high'], 'minimal', 'medium', true),
    ('google/gemini-3.7-flash', 'google', 'gemini-3.7-flash', 'Gemini 3.7 Flash',
     true, true, 30, ARRAY['low','medium','high'], 'low', 'medium', true),
    ('google/gemini-3.8-flash', 'google', 'gemini-3.8-flash', 'Gemini 3.8 Flash',
     true, true, 40, ARRAY['low','medium','high'], 'low', 'medium', true),
    ('anthropic/claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5',
     true, true, 50, ARRAY['off','low','medium','high','xhigh','max'], 'off', 'medium', true),
    ('openai/gpt-5.6-terra', 'openai', 'gpt-5.6-terra', 'GPT-5.6 Terra',
     true, true, 60, ARRAY['none','low','medium','high','xhigh','max'], 'none', 'medium', true)
  );
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: the six catalog rows are not in the exact reviewed pre-staging state';
  END IF;

  -- ── None of the three replacements exists in ANY form ─────────────────────
  -- By id AND by the (provider, provider_model) pair the adapter would send, so
  -- a row with the same wire model under a different id fails here with a
  -- named message rather than as a bare UNIQUE violation.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE id IN ('anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5', 'openai/gpt-6.1-sol')
     OR (provider, provider_model) IN (('anthropic', 'claude-sonnet-5-5'),
                                       ('anthropic', 'claude-opus-5-5'),
                                       ('openai', 'gpt-6.1-sol'));
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: % row(s) for a replacement model already exist; refusing to overwrite an unreviewed row', v_count;
  END IF;

  -- ── A new row still starts closed to manual reasoning by default ──────────
  -- The INSERT below states `false` explicitly anyway; this proves the column
  -- default is the one 20260919075655 left, so nothing else relies on drift.
  IF (SELECT pg_get_expr(d.adbin, d.adrelid)
        FROM pg_attribute a
        JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'public.ai_model_catalog'::regclass
         AND a.attname = 'reasoning_selectable') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: reasoning_selectable no longer defaults to false';
  END IF;

  -- ── Fingerprint every table this migration must NOT write ────────────────
  -- Whole-row digests ordered by primary key, so any insert, delete or change
  -- to any column moves them. A row count alone would miss an UPDATE.
  SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.user_id), '')) INTO v_prefs_before
    FROM public.user_ai_preferences t;
  SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) INTO v_ents_before
    FROM public.user_entitlements t;
  SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) INTO v_ctrs_before
    FROM public.usage_counters t;
  SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) INTO v_creds_before
    FROM public.usage_credits t;
  SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) INTO v_tele_before
    FROM public.ai_provider_usage_events t;

  -- ── The write ────────────────────────────────────────────────────────────
  -- A plain INSERT with NO `ON CONFLICT`, the drift detector 20260903120000 and
  -- 20260917201856 used: a pre-existing row that somehow slipped past the check
  -- above fails on the primary key or the (provider, provider_model) UNIQUE
  -- constraint instead of being reconciled in silence.
  INSERT INTO public.ai_model_catalog
      (id, provider, provider_model, display_name, enabled, selectable, sort_order,
       reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
       reasoning_selectable)
  VALUES
      ('anthropic/claude-sonnet-5-5', 'anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5',
       true, false, 70, ARRAY['low','medium','high','xhigh','max'], 'low', 'medium', false),
      ('anthropic/claude-opus-5-5', 'anthropic', 'claude-opus-5-5', 'Claude Opus 5.5',
       true, false, 80, ARRAY['low','medium','high','xhigh','max'], 'low', 'medium', false),
      ('openai/gpt-6.1-sol', 'openai', 'gpt-6.1-sol', 'GPT-6.1 Sol',
       true, false, 90, ARRAY['low','medium','high','xhigh','max'], 'low', 'medium', false);
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 3 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: staging inserted % row(s); expected exactly 3', v_inserted;
  END IF;

  -- ── Exactly the three new rows carry this statement's timestamp ──────────
  -- Checked HERE, in the same statement as the INSERT, because under `db reset`
  -- a later block would see a different now() and pass vacuously.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE updated_at >= now();
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: % catalog row(s) carry this statement''s timestamp; expected 3', v_count;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE updated_at >= now()
    AND id NOT IN ('anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5', 'openai/gpt-6.1-sol');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: % pre-existing catalog row(s) were written', v_count;
  END IF;

  -- ── Nothing outside the catalog moved ────────────────────────────────────
  IF (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.user_id), ''))
        FROM public.user_ai_preferences t) IS DISTINCT FROM v_prefs_before THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: a user_ai_preferences row was written';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), ''))
        FROM public.user_entitlements t) IS DISTINCT FROM v_ents_before THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: a user_entitlements row was written';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), ''))
        FROM public.usage_counters t) IS DISTINCT FROM v_ctrs_before THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: a usage_counters row was written';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), ''))
        FROM public.usage_credits t) IS DISTINCT FROM v_creds_before THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: a usage_credits row was written';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), ''))
        FROM public.ai_provider_usage_events t) IS DISTINCT FROM v_tele_before THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: an ai_provider_usage_events row was written';
  END IF;
END
$stage$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Asserts the resulting catalog, in the style of 20260917201856 §2 and
-- 20260919075655 §3. Under `db push` this block shares the file's transaction,
-- so a failure here rolls the INSERT back too. Every check below is about
-- absolute state, not timestamps, so it is exact under `db reset` as well.
DO $verify$
DECLARE
  v_count INTEGER;
BEGIN
  -- ── Nine rows: six current plus three staged ─────────────────────────────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 9 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: catalog holds % row(s) after staging; expected exactly 9', v_count;
  END IF;

  -- ── The three staged rows are EXACTLY as specified, flags included ───────
  -- `selectable = false` and `reasoning_selectable = false` are asserted as
  -- values, not assumed from a default: they are the safety property of Phase A.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
         reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
         reasoning_selectable) IN (
    ('anthropic/claude-sonnet-5-5', 'anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5',
     true, false, 70, ARRAY['low','medium','high','xhigh','max'], 'low', 'medium', false),
    ('anthropic/claude-opus-5-5', 'anthropic', 'claude-opus-5-5', 'Claude Opus 5.5',
     true, false, 80, ARRAY['low','medium','high','xhigh','max'], 'low', 'medium', false),
    ('openai/gpt-6.1-sol', 'openai', 'gpt-6.1-sol', 'GPT-6.1 Sol',
     true, false, 90, ARRAY['low','medium','high','xhigh','max'], 'low', 'medium', false)
  );
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: the three staged rows are not exactly as specified';
  END IF;

  -- ── The six current rows are EXACTLY as they were ────────────────────────
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
         reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
         reasoning_selectable) IN (
    ('google/gemini-3.5-flash', 'google', 'gemini-3.5-flash', 'Gemini 3.5 Flash',
     true, true, 10, ARRAY['minimal','low','medium','high'], 'minimal', 'medium', true),
    ('google/gemini-3.6-flash', 'google', 'gemini-3.6-flash', 'Gemini 3.6 Flash',
     true, true, 20, ARRAY['minimal','low','medium','high'], 'minimal', 'medium', true),
    ('google/gemini-3.7-flash', 'google', 'gemini-3.7-flash', 'Gemini 3.7 Flash',
     true, true, 30, ARRAY['low','medium','high'], 'low', 'medium', true),
    ('google/gemini-3.8-flash', 'google', 'gemini-3.8-flash', 'Gemini 3.8 Flash',
     true, true, 40, ARRAY['low','medium','high'], 'low', 'medium', true),
    ('anthropic/claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5',
     true, true, 50, ARRAY['off','low','medium','high','xhigh','max'], 'off', 'medium', true),
    ('openai/gpt-5.6-terra', 'openai', 'gpt-5.6-terra', 'GPT-5.6 Terra',
     true, true, 60, ARRAY['none','low','medium','high','xhigh','max'], 'none', 'medium', true)
  );
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: the six current catalog rows are not exactly as they were';
  END IF;

  -- ── What a user can newly choose is exactly the six current models ───────
  -- Stated on its own, in render order, because it is the user-visible
  -- invariant of Phase A: the Settings control offers `enabled AND selectable`.
  IF (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog
       WHERE enabled AND selectable)
     IS DISTINCT FROM ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
                            'google/gemini-3.7-flash','google/gemini-3.8-flash',
                            'anthropic/claude-sonnet-5','openai/gpt-5.6-terra'] THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: the user-selectable models are not exactly the six current ones in order';
  END IF;

  -- ── Manual reasoning is open on exactly the six current rows ─────────────
  IF (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog
       WHERE reasoning_selectable)
     IS DISTINCT FROM ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
                            'google/gemini-3.7-flash','google/gemini-3.8-flash',
                            'anthropic/claude-sonnet-5','openai/gpt-5.6-terra'] THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: manual reasoning is open on a row other than the six current ones';
  END IF;

  -- ── No staged row offers a level its provider model rejects ──────────────
  -- Restated separately from the tuple match because each is a provider 400 the
  -- moment it is sent: `off` (thinking disabled) on either Claude 5.5 model,
  -- `none` on Sol, and `minimal` on any of them.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE id IN ('anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5', 'openai/gpt-6.1-sol')
    AND reasoning_levels && ARRAY['off','none','minimal'];
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: % staged row(s) offer off, none or minimal', v_count;
  END IF;

  -- ── Full catalog order ───────────────────────────────────────────────────
  IF (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog)
     IS DISTINCT FROM ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
                            'google/gemini-3.7-flash','google/gemini-3.8-flash',
                            'anthropic/claude-sonnet-5','openai/gpt-5.6-terra',
                            'anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5',
                            'openai/gpt-6.1-sol'] THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: catalog order is not the nine rows in their staged order';
  END IF;

  -- ── Nobody points at a staged model ──────────────────────────────────────
  -- The corollary worth naming: the rows did not exist before this file and are
  -- not selectable, so a preference naming one could only have been written by
  -- this migration — which must write none.
  SELECT count(*) INTO v_count
  FROM public.user_ai_preferences
  WHERE preferred_model_id IN ('anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5',
                               'openai/gpt-6.1-sol');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: % preference row(s) point at a staged model', v_count;
  END IF;

  -- ── The catalog is still credential-free product metadata ────────────────
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'ai_model_catalog'
    AND column_name ~* '(key|secret|token|credential|password)';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: the catalog gained a column that could hold credential material';
  END IF;

  -- ── Still read-only to clients ───────────────────────────────────────────
  IF has_table_privilege('anon', 'public.ai_model_catalog',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: anon holds a privilege on the catalog';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.ai_model_catalog', 'SELECT') THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: authenticated cannot read the catalog';
  END IF;
  IF has_table_privilege('authenticated', 'public.ai_model_catalog', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001a: authenticated can write the catalog directly';
  END IF;
END
$verify$;
