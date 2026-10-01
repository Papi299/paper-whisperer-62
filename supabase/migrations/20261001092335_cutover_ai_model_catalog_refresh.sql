-- AI-MODEL-CATALOG-REFRESH-001D (Phase D) — the final seven-model cutover.
--
-- This is the last of the four phases decision C59 holds. It does three things,
-- in one transaction, in an order the foreign key makes mandatory:
--
--   1. migrates every saved preference off the two retiring rows and onto their
--      approved successors, mapping each reasoning level;
--   2. DELETES the two retiring catalog rows;
--   3. opens the three replacement rows — `selectable` and
--      `reasoning_selectable` — and normalizes their final sort positions.
--
-- The owner-approved destination is exactly SEVEN user-selectable rows:
--
--     10  google/gemini-3.5-flash       Gemini 3.5 Flash
--     20  google/gemini-3.6-flash       Gemini 3.6 Flash
--     30  google/gemini-3.7-flash       Gemini 3.7 Flash
--     40  google/gemini-3.8-flash       Gemini 3.8 Flash
--     50  anthropic/claude-sonnet-5-5   Claude Sonnet 5.5
--     60  anthropic/claude-opus-5-5     Claude Opus 5.5
--     70  openai/gpt-6.1-sol            GPT-6.1 Sol
--
-- ## Why deletion, when the FK comment said otherwise
--
-- `user_ai_preferences.preferred_model_id` carries this comment from
-- 20260902120000:
--
--     NO ACTION on delete by design — retire a model with enabled = false
--     rather than deleting a row users have chosen.
--
-- The owner's Phase-D decision is explicit that the final catalog holds exactly
-- seven rows, so the two retiring models go by DELETE rather than by being
-- hidden at nine rows. That does NOT discard the property the comment was
-- protecting. The property was "a user must never be left pointing at a model
-- that no longer works", and this migration honours it more strongly than
-- hiding would: every saved preference is MIGRATED to the successor model first,
-- and the deletion is gated on there being zero remaining references. The
-- `NO ACTION` FK is what makes that safe rather than optional — if the
-- migration got the order wrong, the DELETE itself would fail closed rather
-- than silently orphan or null a saved choice. The column comment is corrected
-- at the end of this file so the database stops documenting a rule the project
-- no longer follows.
--
-- ## Phase C is the gate this file stands on
--
-- Phase C (2026-10-01) ran nine Production canaries — Analyze/Automatic,
-- Suggest/Automatic and Analyze/manual-`max` against each of the three
-- replacement models — all with `model_selection_source = user_preference`,
-- `provider_attempts = 1`, `provider_outcome = completed`,
-- `operation_outcome = succeeded`, `cost_status = estimated` and the exact
-- `…@2026-09-30` price record. No Google fallback, no retry, no failure. That
-- is what makes opening these three rows a reviewed act rather than a hope.
--
-- ## What this migration deliberately does NOT do
--
--   * It changes NO generation runtime source. The resolver, the reasoning
--     policy, both setters, the Settings UI and the provider adapters are all
--     data-driven from this table; the catalog IS the allowlist, so a row change
--     is the whole change. No Edge deployment is required.
--   * It does NOT touch the four Google rows — not their ids, provider models,
--     labels, flags, reasoning metadata or sort order. A postcondition proves it.
--   * It does NOT change the system default (C34 / `GEMINI_MODEL`). A catalog
--     row makes a model selectable, never default.
--   * It does NOT delete the retiring models' PRICE records, and it does NOT
--     rewrite telemetry. Historical `ai_provider_usage_events` rows keep naming
--     the provider and model that actually served them — 42 `claude-sonnet-5`
--     and 12 `gpt-5.6-terra` rows at the time of writing. There is no FK from
--     telemetry to the catalog, which is exactly why that history survives a
--     catalog deletion; a postcondition proves the count did not move.
--   * It does NOT remove the providers' `off` / `none` compatibility paths from
--     the adapters. After this migration no catalog row offers either value, so
--     neither is reachable through catalog policy — they remain a harmless
--     unreachable superset rather than an Edge deployment.
--   * It writes no entitlement, usage counter, usage credit or telemetry row.
--
-- ## Concurrency — the race this file has to close, and the locks that close it
--
-- Three things move here that a concurrent user action also writes:
-- saved preferences, catalog reachability, and catalog rows. The dangerous
-- interleaving is specific: `set_current_user_ai_model` validates a model id
-- against the catalog and then writes a preference row. If it committed a
-- preference naming `anthropic/claude-sonnet-5` in the window between this
-- migration's "zero preferences reference the old rows" postcondition and its
-- DELETE, then either the DELETE fails (best case, transaction aborts) or a
-- saved choice is silently left behind by the mapping. "The migration is fast"
-- is not an argument — the window is small, not absent.
--
-- So the two tables are locked explicitly, in this order:
--
--     1. public.user_ai_preferences  IN EXCLUSIVE MODE
--     2. public.ai_model_catalog     IN EXCLUSIVE MODE
--
-- Why EXCLUSIVE and not something weaker or stronger:
--
--   * Both setters take `SELECT … FOR UPDATE` on the caller's preference row,
--     which is a ROW SHARE table lock, and their INSERT/UPDATE/DELETE is ROW
--     EXCLUSIVE. EXCLUSIVE is the weakest standard mode that conflicts with
--     BOTH, so it is the weakest lock that actually blocks a racing setter.
--     SHARE ROW EXCLUSIVE would block the write but not the `FOR UPDATE`.
--   * EXCLUSIVE does NOT conflict with ACCESS SHARE, so plain readers keep
--     working throughout: an in-flight Analyze or Suggest can still resolve a
--     preference and read the catalog, and Settings can still render. That is
--     the difference between a short mutual-exclusion window and a read outage,
--     which is why this is not ACCESS EXCLUSIVE.
--   * Both locks are taken by this transaction and released automatically when
--     it commits or rolls back. Nothing here holds a lock across statements that
--     wait on anything external, and the whole body is bounded work over a
--     nine-row table and a preference table with one row per user.
--
-- Why preferences FIRST, then the catalog. A writer must never be able to hold
-- one of these locks while waiting for the other in the opposite order, or the
-- two deadlock. `set_current_user_ai_model` reads the catalog with a plain
-- SELECT (ACCESS SHARE, which EXCLUSIVE does not conflict with), then locks the
-- caller's preference row, and only then does its write take the FK's
-- `FOR KEY SHARE` on the catalog row. So the only locks a setter holds in a
-- conflicting mode are taken preferences-first, catalog-second — the same order
-- as here. With preferences locked first, no setter can be sitting between the
-- two, and no new reference to a retiring row can appear after the check.
--
-- ## One statement, on purpose
--
-- Everything above is ONE `DO` block. `supabase db push` wraps a migration file
-- in a transaction, but `supabase db reset` runs it statement-at-a-time, so only
-- a single statement keeps the locks, the preconditions, all three mutations and
-- the postconditions in one transaction under BOTH. A multi-statement version
-- would take its locks and release them before the work under `db reset`.
--
-- Durable decisions: C33 (the capability and the catalog), C34 (the system
-- default), C39 (a provider needs a reviewed adapter AND its own credential),
-- C41 (PaperLume's own reasoning policy), C43 (stage → canary → activate),
-- C59 (this refresh).


-- ═════════════════════════════════════════════════════════════════════════════
-- The cutover — preconditions, three mutations and their proof, atomically
-- ═════════════════════════════════════════════════════════════════════════════
DO $cutover$
DECLARE
  v_count          INTEGER;
  v_n              INTEGER;
  v_gemini_before  TEXT;
  v_untouched_b    TEXT;
  v_migrating      UUID[];
  v_ents_before    TEXT;
  v_ctrs_before    TEXT;
  v_creds_before   TEXT;
  v_tele_before    TEXT;
  v_tele_retired_b INTEGER;
  v_prefs_total_b  INTEGER;
  v_sonnet_prefs   INTEGER;
  v_terra_prefs    INTEGER;
BEGIN
  -- ── Locks, before the first read that anything is decided on ─────────────
  -- See the header for the mode and ordering rationale. Taken first so every
  -- precondition below is read from a state no concurrent setter can change
  -- before this transaction commits.
  LOCK TABLE public.user_ai_preferences IN EXCLUSIVE MODE;
  LOCK TABLE public.ai_model_catalog    IN EXCLUSIVE MODE;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 1. Fail-closed starting state: the exact reviewed nine-row catalog
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- Every check is a state this cutover was reviewed against. Unexpected drift
  -- aborts the migration rather than being normalized away, because a row
  -- nobody reviewed must not be silently carried into the final catalog.

  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 9 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: catalog holds % row(s); expected exactly the 9 staged rows', v_count;
  END IF;

  -- The four Google rows, field by field. They must survive byte-identical.
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
     true, true, 40, ARRAY['low','medium','high'], 'low', 'medium', true)
  );
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: the four Google rows are not in their exact reviewed state (% of 4)', v_count;
  END IF;

  -- The two retiring rows, field by field, INCLUDING all three flags. They must
  -- still be fully live: retiring a row that something already closed would mean
  -- the state under review is not the state being changed.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
         reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
         reasoning_selectable) IN (
    ('anthropic/claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5',
     true, true, 50, ARRAY['off','low','medium','high','xhigh','max'], 'off', 'medium', true),
    ('openai/gpt-5.6-terra', 'openai', 'gpt-5.6-terra', 'GPT-5.6 Terra',
     true, true, 60, ARRAY['none','low','medium','high','xhigh','max'], 'none', 'medium', true)
  );
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: the two retiring rows are not in their exact reviewed live state (% of 2)', v_count;
  END IF;

  -- The three replacement rows, field by field, still STAGED. `selectable` and
  -- `reasoning_selectable` are asserted as `false` values rather than assumed:
  -- this migration is the only thing authorized to open them, and it must be
  -- opening them from closed.
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
    RAISE EXCEPTION 'ai_catalog_refresh_001d: the three replacement rows are not in their exact staged state (% of 3)', v_count;
  END IF;

  -- Stated separately, because it is the whole user-visible invariant this
  -- migration inverts: before it, exactly the six current rows are offered.
  IF (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog
       WHERE enabled AND selectable)
     IS DISTINCT FROM ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
                            'google/gemini-3.7-flash','google/gemini-3.8-flash',
                            'anthropic/claude-sonnet-5','openai/gpt-5.6-terra'] THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: the offered list is not the exact six current rows';
  END IF;

  -- ── Capture everything that must NOT move ────────────────────────────────
  SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) INTO v_gemini_before
    FROM public.ai_model_catalog t WHERE t.provider = 'google';
  -- The set this migration is allowed to rewrite, identified by USER rather than
  -- by model id. Keying the untouched-set digest on `user_id` is what makes the
  -- check correct for any population: a "rows not naming the NEW ids" predicate
  -- would wrongly exclude a preference that ALREADY named a replacement before
  -- the cutover, and report a false mutation. These are the only users whose row
  -- may differ afterwards, and every other row must be byte-identical.
  SELECT COALESCE(array_agg(p.user_id ORDER BY p.user_id), ARRAY[]::UUID[]) INTO v_migrating
    FROM public.user_ai_preferences p
   WHERE p.preferred_model_id IN ('anthropic/claude-sonnet-5', 'openai/gpt-5.6-terra');
  SELECT md5(COALESCE(string_agg(p::text, '|' ORDER BY p.user_id), '')) INTO v_untouched_b
    FROM public.user_ai_preferences p
   WHERE NOT (p.user_id = ANY (v_migrating));
  SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) INTO v_ents_before
    FROM public.user_entitlements t;
  SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) INTO v_ctrs_before
    FROM public.usage_counters t;
  SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) INTO v_creds_before
    FROM public.usage_credits t;
  SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) INTO v_tele_before
    FROM public.ai_provider_usage_events t;
  SELECT count(*) INTO v_tele_retired_b FROM public.ai_provider_usage_events
   WHERE provider_model IN ('claude-sonnet-5', 'gpt-5.6-terra');
  SELECT count(*) INTO v_prefs_total_b FROM public.user_ai_preferences;
  SELECT count(*) INTO v_sonnet_prefs FROM public.user_ai_preferences
   WHERE preferred_model_id = 'anthropic/claude-sonnet-5';
  SELECT count(*) INTO v_terra_prefs FROM public.user_ai_preferences
   WHERE preferred_model_id = 'openai/gpt-5.6-terra';

  -- ═══════════════════════════════════════════════════════════════════════
  -- 2. Refuse an unmappable reasoning level BEFORE writing anything
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- The table's own CHECK allows the whole canonical vocabulary
  -- (minimal/off/none/low/medium/high/xhigh/max), but each retiring row only
  -- ever LISTED a subset, and `set_current_user_ai_reasoning` only ever stored a
  -- listed value. A level outside that subset therefore cannot have come from
  -- the product — so it gets a named refusal instead of an invented mapping.
  --
  -- Checked before the first UPDATE so an unmappable row aborts the whole
  -- cutover rather than being discovered half way through it.
  SELECT count(*) INTO v_count FROM public.user_ai_preferences
   WHERE preferred_model_id = 'anthropic/claude-sonnet-5'
     AND preferred_reasoning_level IS NOT NULL
     AND preferred_reasoning_level NOT IN ('off','low','medium','high','xhigh','max');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: % Claude Sonnet 5 preference(s) carry a level that row never offered; refusing to invent a mapping', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.user_ai_preferences
   WHERE preferred_model_id = 'openai/gpt-5.6-terra'
     AND preferred_reasoning_level IS NOT NULL
     AND preferred_reasoning_level NOT IN ('none','low','medium','high','xhigh','max');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: % GPT-5.6 Terra preference(s) carry a level that row never offered; refusing to invent a mapping', v_count;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 3. Migrate preferences — EVERY row, whatever the population is
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- Set-based and unconditional on count: this is correct for zero, one or many
  -- rows, and no observed population is encoded anywhere in this file. At the
  -- time of review Production held exactly one such row
  -- (`anthropic/claude-sonnet-5` at `xhigh`) and zero Terra rows, but the
  -- statements below neither assert nor depend on that.
  --
  -- The level map is the owner-approved one. `off` and `none` become NULL —
  -- Automatic — because they are the two values the successor models reject
  -- outright: Claude Sonnet 5.5 returns 400 for disabled thinking, and GPT-6.1
  -- Sol does not support `none`. Carrying either across would hand the user a
  -- saved level that fails at the provider and costs a quota unit; Automatic is
  -- the honest landing place, and it resolves to the successor row's own policy
  -- (Analyze `low`, Suggest `medium`).

  UPDATE public.user_ai_preferences
     SET preferred_model_id = 'anthropic/claude-sonnet-5-5',
         preferred_reasoning_level = CASE preferred_reasoning_level
           WHEN 'off' THEN NULL
           ELSE preferred_reasoning_level   -- low/medium/high/xhigh/max, and NULL
         END
   WHERE preferred_model_id = 'anthropic/claude-sonnet-5';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_sonnet_prefs THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: migrated % Sonnet preference(s), expected the % counted before', v_n, v_sonnet_prefs;
  END IF;

  UPDATE public.user_ai_preferences
     SET preferred_model_id = 'openai/gpt-6.1-sol',
         preferred_reasoning_level = CASE preferred_reasoning_level
           WHEN 'none' THEN NULL
           ELSE preferred_reasoning_level   -- low/medium/high/xhigh/max, and NULL
         END
   WHERE preferred_model_id = 'openai/gpt-5.6-terra';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_terra_prefs THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: migrated % Terra preference(s), expected the % counted before', v_n, v_terra_prefs;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 4. Preference postconditions — the gate the DELETE stands behind
  -- ═══════════════════════════════════════════════════════════════════════

  SELECT count(*) INTO v_count FROM public.user_ai_preferences
   WHERE preferred_model_id = 'anthropic/claude-sonnet-5';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: % preference(s) still reference Claude Sonnet 5', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.user_ai_preferences
   WHERE preferred_model_id = 'openai/gpt-5.6-terra';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: % preference(s) still reference GPT-5.6 Terra', v_count;
  END IF;

  -- Nobody gained or lost a preference row: this is a rewrite, never a delete
  -- or an insert. A user who had a saved choice still has exactly one.
  SELECT count(*) INTO v_count FROM public.user_ai_preferences;
  IF v_count <> v_prefs_total_b THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: preference row count moved % -> %', v_prefs_total_b, v_count;
  END IF;

  -- Every preference now names a row that EXISTS and LISTS its level. Stated
  -- over the whole table, not just the migrated rows, so it also catches a
  -- pre-existing row this migration should have left alone but didn't.
  SELECT count(*) INTO v_count
  FROM public.user_ai_preferences p
  WHERE NOT EXISTS (
    SELECT 1 FROM public.ai_model_catalog c
     WHERE c.id = p.preferred_model_id
       AND (p.preferred_reasoning_level IS NULL
            OR p.preferred_reasoning_level
                 = ANY (COALESCE(c.reasoning_levels, ARRAY[]::TEXT[]))));
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: % preference(s) name a missing model or a level that model does not list', v_count;
  END IF;

  -- Every preference belonging to a user NOT in the migrating set is
  -- byte-identical, `updated_at` included — so no Gemini user's row was
  -- touched, no row that already named a replacement was touched, and the
  -- BEFORE UPDATE timestamp trigger fired only on the rows this migration
  -- deliberately rewrote.
  IF (SELECT md5(COALESCE(string_agg(p::text, '|' ORDER BY p.user_id), ''))
        FROM public.user_ai_preferences p
       WHERE NOT (p.user_id = ANY (v_migrating)))
     IS DISTINCT FROM v_untouched_b THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: a preference outside the migrating set was written';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 5. Delete the two retired rows
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- Exactly two, named explicitly. If a preference somehow still referenced one
  -- the FK would abort here instead — which is the fail-closed backstop behind
  -- the postconditions above, not a substitute for them.
  DELETE FROM public.ai_model_catalog
   WHERE id IN ('anthropic/claude-sonnet-5', 'openai/gpt-5.6-terra');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: deleted % catalog row(s); expected exactly 2', v_n;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 6. Open the three replacements, and normalize their final positions
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- Only the three flags and `sort_order` are in the SET list. Provider,
  -- provider_model, display_name and all three pieces of reasoning metadata are
  -- deliberately absent from it, so this statement cannot alter the identity or
  -- the policy that Phase C actually exercised.
  UPDATE public.ai_model_catalog AS c
     SET selectable = true,
         reasoning_selectable = true,
         sort_order = v.sort_order
  FROM (VALUES
          ('anthropic/claude-sonnet-5-5', 50),
          ('anthropic/claude-opus-5-5',   60),
          ('openai/gpt-6.1-sol',          70)
       ) AS v(id, sort_order)
   WHERE c.id = v.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: activated % replacement row(s); expected exactly 3', v_n;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 7. The final catalog, exactly
  -- ═══════════════════════════════════════════════════════════════════════

  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 7 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: catalog holds % row(s) after the cutover; expected exactly 7', v_count;
  END IF;

  -- Neither retired id may survive in any form.
  SELECT count(*) INTO v_count FROM public.ai_model_catalog
   WHERE id IN ('anthropic/claude-sonnet-5', 'openai/gpt-5.6-terra')
      OR (provider, provider_model) IN (('anthropic','claude-sonnet-5'), ('openai','gpt-5.6-terra'));
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: % retired row(s) survived the cutover', v_count;
  END IF;

  -- The whole list, as whole rows, in final order.
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
    ('anthropic/claude-sonnet-5-5', 'anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5',
     true, true, 50, ARRAY['low','medium','high','xhigh','max'], 'low', 'medium', true),
    ('anthropic/claude-opus-5-5', 'anthropic', 'claude-opus-5-5', 'Claude Opus 5.5',
     true, true, 60, ARRAY['low','medium','high','xhigh','max'], 'low', 'medium', true),
    ('openai/gpt-6.1-sol', 'openai', 'gpt-6.1-sol', 'GPT-6.1 Sol',
     true, true, 70, ARRAY['low','medium','high','xhigh','max'], 'low', 'medium', true)
  );
  IF v_count <> 7 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: the final seven rows are not exactly as approved (% of 7)', v_count;
  END IF;

  -- Order, and the three flags, each stated on its own so a failure is specific.
  IF (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog)
     IS DISTINCT FROM ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
                            'google/gemini-3.7-flash','google/gemini-3.8-flash',
                            'anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5',
                            'openai/gpt-6.1-sol'] THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: the final catalog order is not the approved seven';
  END IF;
  IF (SELECT array_agg(sort_order ORDER BY sort_order, id) FROM public.ai_model_catalog)
     IS DISTINCT FROM ARRAY[10,20,30,40,50,60,70] THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: the final sort positions are not 10..70';
  END IF;
  IF NOT (SELECT bool_and(enabled) FROM public.ai_model_catalog) THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: a final row is not enabled';
  END IF;
  IF NOT (SELECT bool_and(selectable) FROM public.ai_model_catalog) THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: a final row is not selectable';
  END IF;
  IF NOT (SELECT bool_and(reasoning_selectable) FROM public.ai_model_catalog) THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: a final row is not open to manual reasoning';
  END IF;
  -- No new row offers a value its provider rejects.
  SELECT count(*) INTO v_count FROM public.ai_model_catalog
   WHERE id IN ('anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','openai/gpt-6.1-sol')
     AND reasoning_levels && ARRAY['off','none','minimal'];
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: % replacement row(s) offer off, none or minimal', v_count;
  END IF;
  -- And no row anywhere still offers the two values the retired rows carried.
  SELECT count(*) INTO v_count FROM public.ai_model_catalog
   WHERE reasoning_levels && ARRAY['off','none'];
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: % final row(s) still offer off or none', v_count;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 8. Nothing outside the catalog and the two migrated preference sets moved
  -- ═══════════════════════════════════════════════════════════════════════

  IF (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), ''))
        FROM public.ai_model_catalog t WHERE t.provider = 'google')
     IS DISTINCT FROM v_gemini_before THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: a Google catalog row was written';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) FROM public.user_entitlements t)
     IS DISTINCT FROM v_ents_before THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: a user_entitlements row was written';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) FROM public.usage_counters t)
     IS DISTINCT FROM v_ctrs_before THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: a usage_counters row was written';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) FROM public.usage_credits t)
     IS DISTINCT FROM v_creds_before THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: a usage_credits row was written';
  END IF;
  -- Telemetry history is immutable here, and it keeps naming the models that
  -- actually served those requests. There is no FK from telemetry to the
  -- catalog, so deleting a catalog row leaves its history intact by design.
  IF (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), ''))
        FROM public.ai_provider_usage_events t)
     IS DISTINCT FROM v_tele_before THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: a telemetry row was written';
  END IF;
  SELECT count(*) INTO v_count FROM public.ai_provider_usage_events
   WHERE provider_model IN ('claude-sonnet-5', 'gpt-5.6-terra');
  IF v_count <> v_tele_retired_b THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: retired-model telemetry count moved % -> %', v_tele_retired_b, v_count;
  END IF;

  -- The catalog is still credential-free product metadata, and still read-only
  -- to clients. Restated here because this is the migration that changes what
  -- the table OFFERS, and the posture must not have travelled with it.
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'ai_model_catalog'
    AND column_name ~* '(key|secret|token|credential|password)';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: the catalog gained a column that could hold credential material';
  END IF;
  IF has_table_privilege('anon', 'public.ai_model_catalog',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: anon holds a privilege on the catalog';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.ai_model_catalog', 'SELECT') THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: authenticated cannot read the catalog';
  END IF;
  IF has_table_privilege('authenticated', 'public.ai_model_catalog', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ai_catalog_refresh_001d: authenticated can write the catalog directly';
  END IF;

  RAISE NOTICE 'ai_catalog_refresh_001d: cutover complete — 7 rows; migrated % Sonnet and % Terra preference(s)',
    v_sonnet_prefs, v_terra_prefs;
END
$cutover$;


-- ═════════════════════════════════════════════════════════════════════════════
-- The FK's design note, corrected
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Metadata only — no row changes here. The 20260902120000 comment said to
-- retire a model with `enabled = false` "rather than deleting a row users have
-- chosen", and Phase D deletes two such rows. The property that comment
-- protected still holds, by a stronger route: `NO ACTION` means a saved choice
-- can never be orphaned by a deletion, so a retirement MUST migrate preferences
-- first and the DELETE fails closed if it did not. That is the rule now stated.
COMMENT ON COLUMN public.user_ai_preferences.preferred_model_id IS
    'FK to ai_model_catalog.id, NO ACTION on delete by design: a saved choice '
    'can never be orphaned or nulled by a catalog deletion. Retiring a model is '
    'therefore an ORDERED migration — rewrite every preference naming it onto '
    'the approved successor, prove zero references remain, and only then delete '
    'the row (AI-MODEL-CATALOG-REFRESH-001D, decision C59). Hiding a model with '
    'enabled = false remains available when no successor exists, but it is not '
    'required: the FK is what makes deletion safe rather than forbidden. See '
    'decisions C33 and C59.';
