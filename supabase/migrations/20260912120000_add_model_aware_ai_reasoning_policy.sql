-- AI-MULTI-PROVIDER-001C — model-aware reasoning policy and the user's saved
-- reasoning preference (decision C41).
--
-- One additive migration that gives the database everything PaperLume's
-- reasoning control needs, and deliberately activates none of it.
--
-- What it adds:
--   1. public.ai_model_catalog gains four server-controlled capability columns:
--      reasoning_levels, auto_analyze_reasoning_level,
--      auto_suggest_reasoning_level, reasoning_selectable.
--   2. The four existing Gemini rows are given their approved reasoning
--      metadata — and reasoning_selectable = false on every one of them.
--   3. public.user_ai_preferences gains preferred_reasoning_level TEXT NULL,
--      where NULL means "Automatic" and the literal 'automatic' is not a
--      storable value.
--   4. public.set_current_user_ai_model(text) gains an additive reasoning_reset
--      result column and, while holding a row lock on the caller's preference
--      row, keeps a still-supported manual reasoning level or resets it to
--      Automatic as part of the model change.
--   5. public.set_current_user_ai_reasoning(text) — the write path for a manual
--      reasoning level. Created WITHOUT an EXECUTE grant to authenticated.
--   6. public.clear_current_user_ai_reasoning() — return to Automatic without
--      losing the saved model. Granted to authenticated immediately.
--
-- ## Automatic is a PaperLume policy, not a provider default
--
-- The load-bearing idea behind every column below. "Automatic" does NOT mean
-- "omit the provider's reasoning parameter and inherit whatever that provider
-- currently defaults to". It means PaperLume explicitly chooses a level, per
-- MODEL and per OPERATION, and sends it. Provider defaults move independently
-- of this product and are never PaperLume's policy by omission — which is why
-- the Automatic choice is stored here, in reviewed server-controlled data,
-- rather than left implicit in an adapter that sends nothing.
--
-- The approved Automatic matrix for the models that exist today:
--
--     model              analyze    organization suggestions
--     ---------------    -------    ------------------------
--     gemini-3.5-flash   minimal    medium
--     gemini-3.6-flash   minimal    medium
--     gemini-3.7-flash   low        medium
--     gemini-3.8-flash   low        medium
--
-- ## THIS MIGRATION ACTIVATES NOTHING FOR USERS
--
-- Three separate staging locks, each of which alone is sufficient:
--
--   * reasoning_selectable = false on every catalog row, so no model offers a
--     manual reasoning choice;
--   * set_current_user_ai_reasoning holds NO EXECUTE grant for `authenticated`,
--     so the write path is unreachable from any client even if a UI shipped;
--   * no Anthropic or OpenAI catalog row exists, so no non-Google model is
--     routable regardless of what the application code can now speak.
--
-- The missing grant in particular is DELIBERATE and must not be read as an
-- oversight. A later, explicitly authorized user-enablement migration flips
-- reasoning_selectable and grants EXECUTE, after the Edge runtime has been
-- deployed and a canary reviewed. Creating user-owned reasoning data before the
-- merged application contains the matching export, UI and runtime support is
-- exactly the ordering error this staging prevents.
--
-- ## Pre-applying this migration is SAFE for the currently deployed application
--
-- Every change is additive and backward compatible:
--   * the four catalog columns are new and nothing deployed reads them;
--   * preferred_reasoning_level is nullable with no backfill, so every existing
--     row keeps its exact current meaning;
--   * set_current_user_ai_model's result GAINS a column and renames, reorders
--     and redefines none — supabase-js hands the caller an object, and the
--     deployed Settings hook reads `saved`, `reason` and `display_name` by
--     name, so an extra field is invisible to it;
--   * clear_current_user_ai_model is untouched;
--   * the two new functions are new objects nothing calls.
-- This is what lets the schema be applied to Production while the OLD frontend
-- and the OLD (pre-001A) Edge runtime are still live — the required rollout
-- order, stated in docs/deployment.md and in the 001C pull request.
--
-- What this migration explicitly does NOT do:
--   * It adds NO anthropic/claude-sonnet-5 row and NO openai/gpt-5.6-terra row.
--     Their FUTURE staging values are recorded in section 3's comment as
--     documentation only, and the verify block proves neither was seeded.
--   * It stores NO credential, secret name or provider API key, and adds no
--     column that could hold one.
--   * It changes no grant, policy or RLS setting on either table, no
--     entitlement, no quota, no plan and no pricing value.
--   * It does NOT constrain ai_model_catalog.provider to a closed list and adds
--     no model-string allowlist. The provider column stays open on purpose
--     (C33/C39) and the catalog stays the model allowlist.
--   * It does NOT change which model any AI operation invokes.
--
-- Durable decisions: C33 (capability + catalog), C34 (system default),
-- C39 (adapter/registry boundary), C41 (this reasoning policy).


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. ai_model_catalog — server-controlled reasoning capability metadata
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The canonical reasoning vocabulary is exactly eight literals:
--
--     minimal  off  none  low  medium  high  xhigh  max
--
-- It is the UNION of what PaperLume's reviewed provider adapters can express,
-- not any single provider's list: `minimal` is Google's, `off` is Anthropic's
-- disabled thinking, `none` is OpenAI's zero-reasoning effort, and
-- `xhigh`/`max` exist on the two paid providers only. Which subset a given
-- model actually supports is that ROW's business, which is the entire point of
-- reasoning_levels being per-row data rather than a global enum.
--
-- 'automatic' is deliberately NOT a member. Automatic is PaperLume policy — the
-- pair of auto_* columns below — and storing it as if it were a provider
-- reasoning value would make "PaperLume chooses" and "the user chose" the same
-- state, which is the confusion this whole design exists to avoid.
--
-- TEXT[] rather than an ENUM type: an enum would have to be ALTERed to add a
-- value a future provider introduces, and ALTER TYPE ... ADD VALUE cannot run
-- in the same transaction as a use of the new value. The CHECK constraints
-- below give the same closed vocabulary with none of that.

ALTER TABLE public.ai_model_catalog
    ADD COLUMN reasoning_levels              TEXT[]  NOT NULL DEFAULT '{}',
    ADD COLUMN auto_analyze_reasoning_level  TEXT,
    ADD COLUMN auto_suggest_reasoning_level  TEXT,
    ADD COLUMN reasoning_selectable          BOOLEAN NOT NULL DEFAULT false;

-- Only canonical literals, and no NULL element.
--
-- The NULL guard is not redundant: `ARRAY['low', NULL] <@ ARRAY[...]` evaluates
-- to NULL, and a CHECK passes on NULL. Without the second clause a row could
-- carry a level the runtime would read as a missing value.
ALTER TABLE public.ai_model_catalog
    ADD CONSTRAINT ai_model_catalog_reasoning_levels_canonical CHECK (
        reasoning_levels <@ ARRAY[
            'minimal','off','none','low','medium','high','xhigh','max'
        ]::TEXT[]
        AND array_position(reasoning_levels, NULL) IS NULL
    );

-- No level appears twice. Stated per literal because a CHECK constraint cannot
-- contain a subquery, which rules out the obvious DISTINCT formulation.
-- `array_positions` is IMMUTABLE and returns an empty array for an absent
-- value, so each clause reads "this level occurs at most once".
ALTER TABLE public.ai_model_catalog
    ADD CONSTRAINT ai_model_catalog_reasoning_levels_distinct CHECK (
        cardinality(array_positions(reasoning_levels, 'minimal')) <= 1
    AND cardinality(array_positions(reasoning_levels, 'off'))     <= 1
    AND cardinality(array_positions(reasoning_levels, 'none'))    <= 1
    AND cardinality(array_positions(reasoning_levels, 'low'))     <= 1
    AND cardinality(array_positions(reasoning_levels, 'medium'))  <= 1
    AND cardinality(array_positions(reasoning_levels, 'high'))    <= 1
    AND cardinality(array_positions(reasoning_levels, 'xhigh'))   <= 1
    AND cardinality(array_positions(reasoning_levels, 'max'))     <= 1
    );

-- An Automatic level is NULL (this model has no PaperLume reasoning policy) or
-- a canonical literal. Never free text.
ALTER TABLE public.ai_model_catalog
    ADD CONSTRAINT ai_model_catalog_auto_reasoning_canonical CHECK (
        (auto_analyze_reasoning_level IS NULL OR auto_analyze_reasoning_level = ANY (ARRAY[
            'minimal','off','none','low','medium','high','xhigh','max'
        ]::TEXT[]))
    AND (auto_suggest_reasoning_level IS NULL OR auto_suggest_reasoning_level = ANY (ARRAY[
            'minimal','off','none','low','medium','high','xhigh','max'
        ]::TEXT[]))
    );

-- A non-NULL Automatic level must be one THIS model supports. The constraint
-- that matters most: without it a reviewed row could promise Gemini 3.8 an
-- Automatic level of `minimal`, which Google rejects with a 400 — and the first
-- evidence would be a user's failed analysis rather than a failed migration.
ALTER TABLE public.ai_model_catalog
    ADD CONSTRAINT ai_model_catalog_auto_reasoning_supported CHECK (
        (auto_analyze_reasoning_level IS NULL
            OR auto_analyze_reasoning_level = ANY (reasoning_levels))
    AND (auto_suggest_reasoning_level IS NULL
            OR auto_suggest_reasoning_level = ANY (reasoning_levels))
    );

-- Offering a manual choice requires something to choose FROM and an Automatic
-- policy to offer alongside it. The UI's first option is always "Automatic
-- (Recommended)", so a selectable row with no Automatic level would render a
-- recommendation PaperLume has not made.
ALTER TABLE public.ai_model_catalog
    ADD CONSTRAINT ai_model_catalog_reasoning_selectable_usable CHECK (
        NOT reasoning_selectable
        OR (cardinality(reasoning_levels) > 0
            AND auto_analyze_reasoning_level IS NOT NULL
            AND auto_suggest_reasoning_level IS NOT NULL)
    );

COMMENT ON COLUMN public.ai_model_catalog.reasoning_levels IS
    'Ordered list of the manual reasoning levels this model supports, in the '
    'order the Settings control renders them. Canonical vocabulary only '
    '(minimal|off|none|low|medium|high|xhigh|max); no duplicates; never '
    '''automatic''. Empty means this model exposes no manual reasoning choice. '
    'This is the ONLY authority on which levels a model supports — the frontend '
    'maps values to labels but never decides membership. See decision C41.';
COMMENT ON COLUMN public.ai_model_catalog.auto_analyze_reasoning_level IS
    'The concrete level PaperLume sends to analyze-paper when the user''s '
    'reasoning choice is Automatic. NULL means PaperLume states no policy for '
    'this model and the runtime falls back to the provider default for that '
    'request. Must be one of reasoning_levels when non-NULL.';
COMMENT ON COLUMN public.ai_model_catalog.auto_suggest_reasoning_level IS
    'The concrete level PaperLume sends to suggest-paper-organization when the '
    'user''s reasoning choice is Automatic. Same rules as the analyze column.';
COMMENT ON COLUMN public.ai_model_catalog.reasoning_selectable IS
    'Whether users may NEWLY choose a manual reasoning level for this model — '
    'the reasoning analogue of `selectable`, and NOT a statement about whether '
    'reasoning exists. An already-saved level on a row with false stays honoured '
    'by the runtime and stays clearable by its owner; it simply cannot be '
    'changed to a different manual level. false on every row as of '
    'AI-MULTI-PROVIDER-001C: the control is implemented but not activated.';


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The approved reasoning metadata for the four existing Gemini rows
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Google's current published capability matrix (ai.google.dev, re-read
-- 2026-09-12), which the levels below mirror exactly:
--
--   * the request field is generationConfig.thinkingConfig.thinkingLevel, whose
--     values are the lowercase strings minimal | low | medium | high;
--   * gemini-3.5-flash and gemini-3.6-flash accept all four;
--   * gemini-3.7-flash and gemini-3.8-flash REJECT `minimal` — which is why
--     their rows list three levels and take `low` as their Automatic analyze
--     value rather than the `minimal` the older pair uses;
--   * every one of the four defaults to `medium` when the field is omitted.
--
-- That last fact is why this data exists at all. PaperLume currently sends no
-- thinking level, so Production is silently running Google's `medium` default
-- on both operations. Once the 001C Edge runtime is deployed, Automatic becomes
-- PaperLume's own choice and Analyze drops to `minimal` (3.5/3.6) or `low`
-- (3.7/3.8) — an approved, documented product behaviour change, not a
-- behaviour-preserving refactor.
--
-- A targeted UPDATE per level-set rather than one blanket statement, so the
-- rows a statement can touch are named in the statement. reasoning_selectable
-- stays at its `false` default on all four; see the header.
UPDATE public.ai_model_catalog
   SET reasoning_levels             = ARRAY['minimal','low','medium','high'],
       auto_analyze_reasoning_level = 'minimal',
       auto_suggest_reasoning_level = 'medium'
 WHERE id IN ('google/gemini-3.5-flash', 'google/gemini-3.6-flash');

UPDATE public.ai_model_catalog
   SET reasoning_levels             = ARRAY['low','medium','high'],
       auto_analyze_reasoning_level = 'low',
       auto_suggest_reasoning_level = 'medium'
 WHERE id IN ('google/gemini-3.7-flash', 'google/gemini-3.8-flash');


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. FUTURE staging values for the two providers that have no row yet
-- ═════════════════════════════════════════════════════════════════════════════
--
-- DOCUMENTATION ONLY. Nothing in this section executes, and the verify block
-- below proves no such row exists after this migration runs.
--
-- When a later, separately authorized catalog-staging migration adds them, the
-- reviewed metadata is:
--
--   anthropic/claude-sonnet-5
--     reasoning_levels             = {off, low, medium, high, xhigh, max}
--     auto_analyze_reasoning_level = off
--     auto_suggest_reasoning_level = medium
--     reasoning_selectable         = false   (initially)
--
--   openai/gpt-5.6-terra
--     reasoning_levels             = {none, low, medium, high, xhigh, max}
--     auto_analyze_reasoning_level = none
--     auto_suggest_reasoning_level = medium
--     reasoning_selectable         = false   (initially)
--
-- Both sets are the providers' own published vocabularies: Anthropic's
-- output_config.effort is low|medium|high|xhigh|max with thinking disabled
-- expressed separately, and OpenAI's reasoning.effort on gpt-5.6-terra is
-- none|low|medium|high|xhigh|max. Neither provider offers Google's `minimal`.


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. user_ai_preferences — the saved manual reasoning level
-- ═════════════════════════════════════════════════════════════════════════════
--
-- NULL MEANS AUTOMATIC. Not "unknown", not "unset pending a default" — the
-- user has made no manual reasoning choice and PaperLume's per-operation policy
-- applies. Existing rows are therefore backfilled by simply being nullable, and
-- no row at all keeps its full existing meaning: PaperLume's default model AND
-- Automatic reasoning.
--
-- The column lives HERE, on the row that already owns the saved model, because
-- manual reasoning is only available once a user pins a specific model. A
-- reasoning choice that outlived its model would be a choice whose validity
-- depends on a system default PaperLume may change server-side at any time —
-- so clearing the model clears the reasoning with it, by deleting one row.
--
-- The CHECK enforces the canonical vocabulary and nothing more. MODEL
-- compatibility is deliberately NOT a constraint here: expressing it would need
-- a cross-table CHECK, which Postgres does not support and which a trigger
-- would only imitate badly. It is re-checked where it can be checked honestly —
-- in the setter RPCs and again at runtime.
ALTER TABLE public.user_ai_preferences
    ADD COLUMN preferred_reasoning_level TEXT;

ALTER TABLE public.user_ai_preferences
    ADD CONSTRAINT user_ai_preferences_reasoning_level_canonical CHECK (
        preferred_reasoning_level IS NULL
        OR preferred_reasoning_level = ANY (ARRAY[
            'minimal','off','none','low','medium','high','xhigh','max'
        ]::TEXT[])
    );

COMMENT ON COLUMN public.user_ai_preferences.preferred_reasoning_level IS
    'The user''s MANUAL reasoning level, applied to BOTH analyze-paper and '
    'suggest-paper-organization. NULL means Automatic — PaperLume chooses a '
    'level per model and per operation from ai_model_catalog. The literal '
    '''automatic'' is not storable: Automatic is the absence of a manual '
    'choice, not a provider reasoning value. Canonical vocabulary only; model '
    'compatibility is re-checked by the setter RPCs and by the runtime, never '
    'by a constraint. See decision C41.';


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. set_current_user_ai_model — model and reasoning move together or not at all
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every existing behaviour is preserved exactly: identity still comes from
-- auth.uid() with no user-id parameter, entitlement is still checked BEFORE the
-- catalog so a non-entitled caller learns nothing from the shape of the
-- failure, the same six rejection reasons still return saved = false and write
-- nothing, and the row upserted is still the caller's and only the caller's.
--
-- WHAT IS NEW: when the model changes, the caller's saved manual reasoning
-- level is re-validated against the NEW model, and the outcome is written in
-- the same statement as the new model — all while the caller's preference row
-- is locked, so nothing can change the level between the check and the write.
--
--   * still supported by the new model  → preserved untouched;
--   * not supported by the new model    → reset to NULL (Automatic), and
--                                         reasoning_reset = true says so.
--
-- Leaving a knowingly invalid model/reasoning pair in the table is the failure
-- this prevents. The runtime would have to defend against it on every request,
-- the Settings UI would have to render a state the server considers impossible,
-- and the next reader of the row could not tell a stale value from a chosen one.
-- One locked row, one decision, one coherent pair.
--
-- LOCK ORDER. The caller's user_ai_preferences row is the only object that
-- couples the saved model to the saved reasoning level, so it is the only row
-- any of the four preference RPCs locks itself, and each locks it before it
-- writes: this function and set_current_user_ai_reasoning with SELECT ... FOR
-- UPDATE, clear_current_user_ai_reasoning and clear_current_user_ai_model with
-- the UPDATE or DELETE that is their whole body. Each takes that one lock and no
-- other of its own, so no two of them can wait on each other in opposite
-- orders. ai_model_catalog and user_entitlements are only read, never locked:
-- catalog rows change only by reviewed migration, and the foreign-key checks on
-- a written row take the KEY SHARE locks Postgres always takes, which conflict
-- with nothing these functions do.
--
-- Support is judged by reasoning_levels MEMBERSHIP alone, deliberately not by
-- the new model's reasoning_selectable flag — the same distinction the model
-- flags already draw. `reasoning_selectable = false` closes a model to NEW
-- manual choices; it does not retire a choice already made, and silently
-- discarding a level the target model genuinely supports would take away a
-- setting the user never withdrew.
--
-- The result GAINS one column and renames, reorders or redefines none, so a
-- deployed client reading `saved`, `reason` or `display_name` by name is
-- unaffected by this migration being applied ahead of the application.

DROP FUNCTION IF EXISTS public.set_current_user_ai_model(TEXT);

CREATE FUNCTION public.set_current_user_ai_model(p_model_id TEXT)
RETURNS TABLE(
  saved BOOLEAN,
  reason TEXT,
  preferred_model_id TEXT,
  provider TEXT,
  display_name TEXT,
  updated_at TIMESTAMPTZ,
  reasoning_reset BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid UUID := auth.uid();
  v_model_id TEXT;
  v_entitlement public.user_entitlements%ROWTYPE;
  v_model public.ai_model_catalog%ROWTYPE;
  v_updated_at TIMESTAMPTZ;
  v_saved_reasoning TEXT;
  v_next_reasoning TEXT;
  v_reasoning_reset BOOLEAN := FALSE;
  v_written BOOLEAN := FALSE;
BEGIN
  -- S1: identity comes from the session, never from an argument.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no authenticated user';
  END IF;

  v_model_id := btrim(COALESCE(p_model_id, ''));
  IF v_model_id = '' THEN
    RETURN QUERY SELECT
      FALSE, 'invalid_model_id'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::TIMESTAMPTZ, FALSE;
    RETURN;
  END IF;

  -- Entitlement first. Fail closed on a missing row: no entitlement is not
  -- "unknown, allow" — it is "not entitled".
  SELECT * INTO v_entitlement
  FROM public.user_entitlements
  WHERE user_id = v_uid;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      FALSE, 'missing_entitlement'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::TIMESTAMPTZ, FALSE;
    RETURN;
  END IF;

  IF NOT COALESCE(v_entitlement.ai_model_selection_enabled, false) THEN
    -- The explicit capability flag is the gate. A plan column reading 'pro'
    -- with the flag false denies here, on purpose: the flag is the contract.
    RETURN QUERY SELECT
      FALSE, 'not_entitled'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::TIMESTAMPTZ, FALSE;
    RETURN;
  END IF;

  IF COALESCE(v_entitlement.plan_status, '') NOT IN ('active', 'trialing') THEN
    RETURN QUERY SELECT
      FALSE, 'inactive_entitlement'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::TIMESTAMPTZ, FALSE;
    RETURN;
  END IF;

  -- Catalog allowlist. An id absent from the catalog is refused; there is no
  -- pass-through of an arbitrary string to a provider model.
  SELECT * INTO v_model
  FROM public.ai_model_catalog
  WHERE id = v_model_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      FALSE, 'unknown_model'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::TIMESTAMPTZ, FALSE;
    RETURN;
  END IF;

  IF NOT v_model.enabled THEN
    RETURN QUERY SELECT
      FALSE, 'model_disabled'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::TIMESTAMPTZ, FALSE;
    RETURN;
  END IF;

  IF NOT v_model.selectable THEN
    RETURN QUERY SELECT
      FALSE, 'model_not_selectable'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::TIMESTAMPTZ, FALSE;
    RETURN;
  END IF;

  -- Decide and write under a ROW LOCK on the caller's preference row.
  --
  -- Being inside one transaction is not enough on its own. Under READ
  -- COMMITTED a plain SELECT takes no lock, so a concurrent
  -- clear_current_user_ai_reasoning or set_current_user_ai_reasoning could
  -- commit between reading the saved level and writing the new pair — and the
  -- write would then restore a level the user had just cleared, or overwrite
  -- one they had just chosen, from a stale read. FOR UPDATE makes every other
  -- writer of this row wait for this transaction to end, and makes this read
  -- wait for a writer already in flight and then return the row it committed.
  -- The level examined below is therefore the level that gets overwritten.
  --
  -- The loop exists only for the case where there is no row to lock. The row
  -- is then created on Automatic, because no manual level can exist without a
  -- row. If a concurrent call creates it first, ON CONFLICT DO NOTHING waits
  -- for that call's transaction, inserts nothing, and the next pass locks the
  -- row that call committed and decides against its real contents instead of
  -- overwriting them. Only a second create-and-delete by the same account in
  -- that window could defeat the next pass, so three passes is a bound rather
  -- than a budget; exhausting it fails closed as a retryable serialization
  -- failure.
  FOR v_attempt IN 1..3 LOOP
    SELECT p.preferred_reasoning_level INTO v_saved_reasoning
    FROM public.user_ai_preferences p
    WHERE p.user_id = v_uid
    FOR UPDATE;

    IF FOUND THEN
      IF v_saved_reasoning IS NOT NULL
         AND NOT (v_saved_reasoning = ANY (COALESCE(v_model.reasoning_levels, ARRAY[]::TEXT[]))) THEN
        v_next_reasoning := NULL;
        v_reasoning_reset := TRUE;
      ELSE
        v_next_reasoning := v_saved_reasoning;
        v_reasoning_reset := FALSE;
      END IF;

      -- The CALLER's locked row and no other, and only while it still holds
      -- the level just examined. Both columns are written together, so the
      -- model and the reasoning level can never disagree about which
      -- transaction last decided them.
      UPDATE public.user_ai_preferences AS p
         SET preferred_model_id = v_model.id,
             preferred_reasoning_level = v_next_reasoning,
             updated_at = now()
       WHERE p.user_id = v_uid
         AND p.preferred_reasoning_level IS NOT DISTINCT FROM v_saved_reasoning
      RETURNING p.updated_at INTO v_updated_at;

      IF NOT FOUND THEN
        -- Unreachable while the lock above is held. Fail closed rather than
        -- report a save that did not land.
        RAISE EXCEPTION USING
          ERRCODE = 'internal_error',
          MESSAGE = 'AI model preference was not saved: the locked preference row was not updated';
      END IF;

      v_written := TRUE;
      EXIT;
    END IF;

    -- No row: nothing to lock and no manual level to carry. user_id is the
    -- primary key, so this creates at most one row, belonging to exactly this
    -- caller.
    INSERT INTO public.user_ai_preferences AS p (user_id, preferred_model_id, preferred_reasoning_level)
    VALUES (v_uid, v_model.id, NULL)
    ON CONFLICT (user_id) DO NOTHING
    RETURNING p.updated_at INTO v_updated_at;

    IF FOUND THEN
      v_reasoning_reset := FALSE;
      v_written := TRUE;
      EXIT;
    END IF;
  END LOOP;

  IF NOT v_written THEN
    RAISE EXCEPTION USING
      ERRCODE = 'serialization_failure',
      MESSAGE = 'AI model preference was not saved because it changed concurrently; retry';
  END IF;

  RETURN QUERY SELECT
    TRUE,
    'ok'::TEXT,
    v_model.id,
    v_model.provider,
    v_model.display_name,
    v_updated_at,
    v_reasoning_reset;
END;
$$;

COMMENT ON FUNCTION public.set_current_user_ai_model(TEXT) IS
  'Save the CALLER''s preferred AI model. Derives the user from auth.uid() and '
  'accepts no user-id parameter, so it can never write another user''s row. '
  'Requires ai_model_selection_enabled = true AND plan_status in '
  'active|trialing, and requires the requested id to exist in ai_model_catalog '
  'with enabled AND selectable — every failure returns saved = false with a '
  'reason (invalid_model_id | missing_entitlement | not_entitled | '
  'inactive_entitlement | unknown_model | model_disabled | '
  'model_not_selectable) and writes nothing. Writes at most one row. Locks the '
  'caller''s preference row (FOR UPDATE) and, under that lock, re-validates any '
  'saved manual reasoning level against the new model: a level the new model '
  'supports is preserved, one it does not is reset to NULL (Automatic) and '
  'reasoning_reset = true reports that (AI-MULTI-PROVIDER-001C / C41). The '
  'check and the write therefore serialize with every other writer of that '
  'row, and a write that does not land raises instead of reporting '
  'saved = true. Calls no AI provider and returns no secret. '
  'Saving a preference does NOT change which model any AI operation invokes — '
  'runtime routing re-checks authorization itself. SECURITY DEFINER + fixed '
  'search_path; EXECUTE granted to authenticated only. See decisions C33, C41.';

REVOKE ALL ON FUNCTION public.set_current_user_ai_model(TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_current_user_ai_model(TEXT) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5b. clear_current_user_ai_model — unchanged, and now documented as clearing
--     the reasoning level with it
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The function body is deliberately NOT touched. It deletes the caller's row,
-- and the reasoning level lives on that row, so returning to PaperLume's
-- default model already returns the account to Automatic reasoning — no new
-- statement, no second code path, and nothing that could clear one without the
-- other. Only the COMMENT changes, so the documented contract states the
-- consequence the schema now has.
COMMENT ON FUNCTION public.clear_current_user_ai_model() IS
  'Remove the CALLER''s saved AI model preference, returning the account to '
  'Paperlume''s system default model AND to Automatic reasoning — both live on '
  'the single row this deletes, so they cannot come apart. Derives the user '
  'from auth.uid() and accepts no parameter, so it can never clear another '
  'user''s row. Requires authentication but deliberately NOT model-selection '
  'entitlement — a downgraded user must still be able to drop a dormant '
  'preference. Idempotent: clearing when nothing is saved returns '
  'cleared = false, reason no_preference. Touches no other setting and does not '
  'change what the system default is. SECURITY DEFINER + fixed search_path; '
  'EXECUTE granted to authenticated only. See decisions C33, C41.';


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. set_current_user_ai_reasoning — the manual reasoning write path
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Created, reviewed, and NOT GRANTED. See section 8 and the file header: this
-- function exists so that the write path is written and tested now, and is
-- reachable by nobody until a later user-enablement migration says so.
--
-- Takes NO user id. The caller is auth.uid(), full stop, exactly as in the
-- model setter — cross-user mutation is unexpressible rather than guarded.
--
-- Checks, in this order:
--   1. authenticated caller (null auth raises, matching the S1 RPC family);
--   2. the requested level is a canonical literal — a client bug, answered
--      before anything about this account is consulted, and disclosing nothing;
--   3. the caller's entitlement permits model selection AT ALL, checked BEFORE
--      any model- or catalog-specific rejection so a non-entitled caller learns
--      nothing from the shape of the failure;
--   4. a named model is actually saved — manual reasoning is a property of a
--      pinned model, and there is no such thing as a reasoning choice attached
--      to PaperLume's own default;
--   5. that model still resolves in the catalog and is still enabled;
--   6. that model's reasoning control is open to NEW selection;
--   7. the requested level is one THAT MODEL supports.
-- Only then is the caller's own row updated, and only its reasoning column.
--
-- From step 4 onward the caller's preference row is locked FOR UPDATE, so
-- steps 5–7 judge the model the row names when it is written, not a model it
-- named a moment earlier: a concurrent model switch, model clear or reasoning
-- clear either commits before step 4 reads the row, or waits for this
-- transaction to end. The final UPDATE is also conditioned on that model, and a
-- write that lands on no row raises instead of answering saved = true.
--
-- It calls no AI provider, reads no credential, knows no provider endpoint and
-- returns no secret. The reasoning level it writes is a bounded literal that
-- came out of the catalog's own capability list.

CREATE FUNCTION public.set_current_user_ai_reasoning(p_reasoning_level TEXT)
RETURNS TABLE(
  saved BOOLEAN,
  reason TEXT,
  preferred_model_id TEXT,
  preferred_reasoning_level TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid UUID := auth.uid();
  v_level TEXT;
  v_entitlement public.user_entitlements%ROWTYPE;
  v_preference public.user_ai_preferences%ROWTYPE;
  v_model public.ai_model_catalog%ROWTYPE;
  v_updated_at TIMESTAMPTZ;
  v_saved_model_id TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no authenticated user';
  END IF;

  v_level := btrim(COALESCE(p_reasoning_level, ''));
  IF v_level = '' OR NOT (v_level = ANY (ARRAY[
       'minimal','off','none','low','medium','high','xhigh','max'
     ]::TEXT[])) THEN
    -- Includes the literal 'automatic', which is deliberately not a storable
    -- reasoning value: returning to Automatic is clear_current_user_ai_reasoning.
    RETURN QUERY SELECT
      FALSE, 'invalid_reasoning_level'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO v_entitlement
  FROM public.user_entitlements
  WHERE user_id = v_uid;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      FALSE, 'missing_entitlement'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT COALESCE(v_entitlement.ai_model_selection_enabled, false) THEN
    RETURN QUERY SELECT
      FALSE, 'not_entitled'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF COALESCE(v_entitlement.plan_status, '') NOT IN ('active', 'trialing') THEN
    RETURN QUERY SELECT
      FALSE, 'inactive_entitlement'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- A manual reasoning level belongs to a model the user pinned. With no saved
  -- model there is nothing to validate the level against, and PaperLume's own
  -- default model may change server-side — so this is refused rather than
  -- stored against a moving target.
  --
  -- The row is LOCKED here, before the model it names is read, and the lock is
  -- held through every check below and the write. Under READ COMMITTED a plain
  -- SELECT takes no lock: a concurrent set_current_user_ai_model could switch
  -- the model, or clear_current_user_ai_model delete the row, after the level
  -- had been validated against the OLD model — storing a level the new model
  -- does not support, or answering saved = true for a row that no longer
  -- exists. With FOR UPDATE those writers wait for this transaction, and if one
  -- is already in flight this read waits for it and then returns the row it
  -- committed, or no row at all.
  SELECT * INTO v_preference
  FROM public.user_ai_preferences
  WHERE user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      FALSE, 'model_required'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO v_model
  FROM public.ai_model_catalog
  WHERE id = v_preference.preferred_model_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      FALSE, 'model_missing'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT v_model.enabled THEN
    -- A retired model is not routed at runtime either, so a reasoning level
    -- chosen for it would never reach a provider.
    RETURN QUERY SELECT
      FALSE, 'model_disabled'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT v_model.reasoning_selectable THEN
    -- The staging gate, and the long-term "closed to new choices" gate. Both
    -- are the same rule: this model does not accept a NEW manual level.
    RETURN QUERY SELECT
      FALSE, 'reasoning_not_selectable'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT (v_level = ANY (COALESCE(v_model.reasoning_levels, ARRAY[]::TEXT[]))) THEN
    -- The catalog is the only authority on which levels a model supports. A
    -- level this row does not list is refused even though it is canonical.
    RETURN QUERY SELECT
      FALSE, 'reasoning_level_not_supported'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Only the caller's locked row, only its reasoning column, and only while it
  -- still names the model this level was just validated against. The saved
  -- model is never rewritten here; the result reports what the write stored.
  UPDATE public.user_ai_preferences AS p
     SET preferred_reasoning_level = v_level,
         updated_at = now()
   WHERE p.user_id = v_uid
     AND p.preferred_model_id = v_model.id
  RETURNING p.preferred_model_id, p.updated_at INTO v_saved_model_id, v_updated_at;

  IF NOT FOUND THEN
    -- Unreachable while the lock above is held: the row was found, locked and
    -- validated in this transaction. If it ever happens, fail closed — a
    -- saved = true for a write that did not land is the one answer this
    -- function must never give.
    RAISE EXCEPTION USING
      ERRCODE = 'internal_error',
      MESSAGE = 'AI reasoning preference was not saved: the locked preference row was not updated';
  END IF;

  RETURN QUERY SELECT
    TRUE,
    'ok'::TEXT,
    v_saved_model_id,
    v_level,
    v_updated_at;
END;
$$;

COMMENT ON FUNCTION public.set_current_user_ai_reasoning(TEXT) IS
  'Save the CALLER''s MANUAL AI reasoning level, applied to both analyze-paper '
  'and suggest-paper-organization. Derives the user from auth.uid() and accepts '
  'no user-id parameter. Requires a canonical level, then '
  'ai_model_selection_enabled = true AND plan_status in active|trialing, then a '
  'saved named-model preference whose catalog row is enabled, has '
  'reasoning_selectable = true, and lists the requested level in '
  'reasoning_levels — every failure returns saved = false with a reason '
  '(invalid_reasoning_level | missing_entitlement | not_entitled | '
  'inactive_entitlement | model_required | model_missing | model_disabled | '
  'reasoning_not_selectable | reasoning_level_not_supported) and writes '
  'nothing. Updates only the caller''s reasoning column; never the saved model. '
  'Locks the caller''s preference row (FOR UPDATE) before reading the model it '
  'names and holds it through validation and the write, so neither can race a '
  'concurrent model switch, model clear or reasoning clear; a write that does '
  'not land raises instead of reporting saved = true. '
  'Calls no AI provider and returns no secret. STAGED: EXECUTE is granted to NO '
  'role by AI-MULTI-PROVIDER-001C — a later, separately authorized '
  'user-enablement migration grants it to authenticated alongside flipping '
  'ai_model_catalog.reasoning_selectable. SECURITY DEFINER + fixed search_path. '
  'See decision C41.';

-- ─────────────────────────────────────────────────────────────────────────────
-- STAGED PRIVILEGES — the missing GRANT is the feature
-- ─────────────────────────────────────────────────────────────────────────────
--
-- PUBLIC, anon and service_role are revoked for the same reasons the rest of
-- this RPC family revokes them. `authenticated` is revoked too, and is then NOT
-- granted: after this migration no role in the database can execute this
-- function, and the only way to run it is as the owner in a migration or a
-- database test.
--
-- That is intentional. It means this migration can be applied to Production
-- ahead of the application merge without creating a single row of user-owned
-- reasoning data — data the currently deployed frontend could not export, the
-- currently deployed Edge runtime could not honour, and no user could see.
--
-- Do not "fix" this by adding a grant. Enabling the feature is a separate,
-- separately authorized migration that flips reasoning_selectable and grants
-- EXECUTE together, after the Edge runtime rollout and canary.
REVOKE ALL ON FUNCTION public.set_current_user_ai_reasoning(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 7. clear_current_user_ai_reasoning — return to Automatic, keep the model
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Granted to authenticated IMMEDIATELY, unlike the setter above, and the
-- asymmetry is deliberate. This function cannot create user data and cannot
-- increase any capability: it can only turn a manual choice back into the
-- absence of one. Shipping the way OUT of a state before the way IN is the safe
-- ordering, and it mirrors clear_current_user_ai_model, which likewise requires
-- no entitlement so a downgraded account is never trapped holding a setting it
-- cannot remove.
--
-- An UPDATE rather than a DELETE: the saved MODEL must survive. Returning to
-- Automatic reasoning is not the same act as returning to PaperLume's default
-- model, and conflating them would silently discard a choice the user did not
-- withdraw.

CREATE FUNCTION public.clear_current_user_ai_reasoning()
RETURNS TABLE(
  cleared BOOLEAN,
  reason TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid UUID := auth.uid();
  v_updated INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no authenticated user';
  END IF;

  -- The predicate does the idempotence: a row already on Automatic matches
  -- nothing, so no write happens and updated_at does not move.
  UPDATE public.user_ai_preferences AS p
     SET preferred_reasoning_level = NULL,
         updated_at = now()
   WHERE p.user_id = v_uid
     AND p.preferred_reasoning_level IS NOT NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- Already on Automatic — either no preference row at all, or a row with no
    -- manual level. Both are the same state from the caller's point of view.
    RETURN QUERY SELECT FALSE, 'no_reasoning_preference'::TEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'ok'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.clear_current_user_ai_reasoning() IS
  'Return the CALLER''s AI reasoning choice to Automatic by setting '
  'preferred_reasoning_level = NULL, PRESERVING the saved model. Derives the '
  'user from auth.uid() and accepts no parameter, so it can never clear another '
  'user''s row. Requires authentication but deliberately NOT model-selection '
  'entitlement, and deliberately not reasoning_selectable — leaving a manual '
  'level must never be blocked by the gate that controls entering one. '
  'Idempotent: with nothing to clear it returns cleared = false, reason '
  'no_reasoning_preference, and writes nothing. Touches no other column and no '
  'other row. SECURITY DEFINER + fixed search_path; EXECUTE granted to '
  'authenticated only — safe to grant immediately because it can only remove a '
  'manual choice, never create one. See decision C41.';

REVOKE ALL ON FUNCTION public.clear_current_user_ai_reasoning() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.clear_current_user_ai_reasoning() TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 8. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Asserts what this migration claims, in the same transaction that claims it,
-- so a replay that silently produced a weaker schema, a different policy matrix
-- or — most importantly — a GRANTED reasoning setter fails here instead of
-- shipping. Modelled on 20260902120000 §7 and 20260903120000 §2.
DO $verify$
DECLARE
  v_row    RECORD;
  v_count  INTEGER;
  v_col    TEXT;
  v_cols   TEXT[] := ARRAY[
    'reasoning_levels', 'auto_analyze_reasoning_level',
    'auto_suggest_reasoning_level', 'reasoning_selectable'];
  v_cons   TEXT;
  v_cons_list TEXT[] := ARRAY[
    'ai_model_catalog_reasoning_levels_canonical',
    'ai_model_catalog_reasoning_levels_distinct',
    'ai_model_catalog_auto_reasoning_canonical',
    'ai_model_catalog_auto_reasoning_supported',
    'ai_model_catalog_reasoning_selectable_usable'];
  v_fn     TEXT;
  v_fns    TEXT[] := ARRAY[
    'public.set_current_user_ai_model(text)',
    'public.clear_current_user_ai_model()',
    'public.set_current_user_ai_reasoning(text)',
    'public.clear_current_user_ai_reasoning()'];
BEGIN
  -- ── The four catalog columns exist with the intended shape ───────────────
  FOREACH v_col IN ARRAY v_cols LOOP
    PERFORM 1
    FROM pg_attribute a
    WHERE a.attrelid = 'public.ai_model_catalog'::regclass
      AND a.attname = v_col
      AND NOT a.attisdropped;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ai_reasoning_001c: ai_model_catalog.% was not created', v_col;
    END IF;
  END LOOP;

  SELECT a.attnotnull AS is_notnull,
         format_type(a.atttypid, a.atttypmod) AS typ,
         pg_get_expr(d.adbin, d.adrelid) AS defexpr
    INTO v_row
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.ai_model_catalog'::regclass
    AND a.attname = 'reasoning_levels';
  IF NOT v_row.is_notnull OR v_row.typ <> 'text[]' THEN
    RAISE EXCEPTION 'ai_reasoning_001c: reasoning_levels must be NOT NULL text[] (got % / %)',
      v_row.typ, v_row.is_notnull;
  END IF;

  SELECT a.attnotnull AS is_notnull,
         format_type(a.atttypid, a.atttypmod) AS typ,
         pg_get_expr(d.adbin, d.adrelid) AS defexpr
    INTO v_row
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.ai_model_catalog'::regclass
    AND a.attname = 'reasoning_selectable';
  IF NOT v_row.is_notnull OR v_row.typ <> 'boolean' OR v_row.defexpr IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'ai_reasoning_001c: reasoning_selectable must be NOT NULL boolean DEFAULT false (got % / % / %)',
      v_row.typ, v_row.is_notnull, v_row.defexpr;
  END IF;

  -- Nullable is load-bearing on both Automatic columns: NULL means "PaperLume
  -- states no policy for this model", which the runtime answers with its
  -- bounded provider-default fallback.
  IF EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.ai_model_catalog'::regclass
      AND a.attname IN ('auto_analyze_reasoning_level', 'auto_suggest_reasoning_level')
      AND a.attnotnull
  ) THEN
    RAISE EXCEPTION 'ai_reasoning_001c: the Automatic level columns must stay nullable';
  END IF;

  -- ── Every integrity constraint this migration promised is present ────────
  FOREACH v_cons IN ARRAY v_cons_list LOOP
    PERFORM 1
    FROM pg_constraint
    WHERE conrelid = 'public.ai_model_catalog'::regclass
      AND conname = v_cons
      AND contype = 'c';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ai_reasoning_001c: CHECK constraint % is missing', v_cons;
    END IF;
  END LOOP;

  PERFORM 1
  FROM pg_constraint
  WHERE conrelid = 'public.user_ai_preferences'::regclass
    AND conname = 'user_ai_preferences_reasoning_level_canonical'
    AND contype = 'c';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_reasoning_001c: the preference reasoning CHECK constraint is missing';
  END IF;

  -- ── The catalog still holds exactly the four approved Google models ──────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'ai_reasoning_001c: catalog holds % row(s); expected exactly 4', v_count;
  END IF;

  -- No Sonnet, no Terra, no row from any provider without a seeded model. This
  -- migration adds reasoning METADATA, never a model.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE provider <> 'google';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_reasoning_001c: % non-Google catalog row(s) exist; 001C seeds none', v_count;
  END IF;

  -- ── The approved Automatic matrix, as whole rows ─────────────────────────
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, reasoning_levels, auto_analyze_reasoning_level,
         auto_suggest_reasoning_level, reasoning_selectable) IN (
    ('google/gemini-3.5-flash', ARRAY['minimal','low','medium','high'], 'minimal', 'medium', false),
    ('google/gemini-3.6-flash', ARRAY['minimal','low','medium','high'], 'minimal', 'medium', false),
    ('google/gemini-3.7-flash', ARRAY['low','medium','high'],           'low',     'medium', false),
    ('google/gemini-3.8-flash', ARRAY['low','medium','high'],           'low',     'medium', false)
  );
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'ai_reasoning_001c: the four Gemini rows do not carry exactly the approved reasoning metadata';
  END IF;

  -- Stated separately because it is the staging lock, not a detail of the
  -- matrix: 001C activates manual reasoning for nobody.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE reasoning_selectable;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_reasoning_001c: % catalog row(s) have reasoning_selectable = true; 001C must activate none', v_count;
  END IF;

  -- Neither 3.7 nor 3.8 may offer Google's `minimal`, which those models reject.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE id IN ('google/gemini-3.7-flash', 'google/gemini-3.8-flash')
    AND 'minimal' = ANY (reasoning_levels);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_reasoning_001c: % row(s) offer `minimal` on a model Google rejects it for', v_count;
  END IF;

  -- ── The catalog is still credential-free product metadata ────────────────
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('ai_model_catalog', 'user_ai_preferences')
    AND column_name ~* '(key|secret|token|credential|password)';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_reasoning_001c: a column that could hold credential material was introduced';
  END IF;

  -- ── No user data was manufactured, and no existing row changed meaning ───
  SELECT count(*) INTO v_count
  FROM public.user_ai_preferences
  WHERE preferred_reasoning_level IS NOT NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_reasoning_001c: % preference row(s) were given a manual reasoning level; the backfill is NULL', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.user_ai_preferences
  WHERE updated_at >= now();
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_reasoning_001c: % user preference row(s) were written', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.user_entitlements
  WHERE updated_at >= now();
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_reasoning_001c: % entitlement row(s) were written', v_count;
  END IF;

  -- ── The model setter gained its additive column and lost nothing ─────────
  IF (SELECT p.proargnames FROM pg_proc p
        WHERE p.oid = 'public.set_current_user_ai_model(text)'::regprocedure)
     IS DISTINCT FROM ARRAY['p_model_id','saved','reason','preferred_model_id',
                            'provider','display_name','updated_at','reasoning_reset'] THEN
    RAISE EXCEPTION 'ai_reasoning_001c: set_current_user_ai_model does not carry exactly its previous result plus reasoning_reset';
  END IF;

  -- ── All four RPCs are SECURITY DEFINER with a pinned search_path ─────────
  FOREACH v_fn IN ARRAY v_fns LOOP
    SELECT p.prosecdef AS secdef, p.proconfig AS cfg
      INTO v_row
    FROM pg_proc p
    WHERE p.oid = v_fn::regprocedure;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ai_reasoning_001c: function % does not exist', v_fn;
    END IF;
    IF NOT v_row.secdef THEN
      RAISE EXCEPTION 'ai_reasoning_001c: % is not SECURITY DEFINER', v_fn;
    END IF;
    IF v_row.cfg IS NULL OR NOT (v_row.cfg @> ARRAY['search_path=public']) THEN
      RAISE EXCEPTION 'ai_reasoning_001c: % does not pin search_path=public', v_fn;
    END IF;
    -- Nothing in this family is reachable by anon, by service_role, or through
    -- an invisible PUBLIC EXECUTE (which hides at grantee 0, where
    -- pg_get_userbyid returns NULL rather than a role name).
    IF has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'ai_reasoning_001c: anon can execute %', v_fn;
    END IF;
    IF has_function_privilege('service_role', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'ai_reasoning_001c: service_role can execute %', v_fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = v_fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'ai_reasoning_001c: % carries PUBLIC EXECUTE', v_fn;
    END IF;
  END LOOP;

  -- ── The three GRANTED functions are reachable by authenticated ───────────
  FOREACH v_fn IN ARRAY ARRAY[
    'public.set_current_user_ai_model(text)',
    'public.clear_current_user_ai_model()',
    'public.clear_current_user_ai_reasoning()'] LOOP
    IF NOT has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'ai_reasoning_001c: authenticated cannot execute %', v_fn;
    END IF;
  END LOOP;

  -- ── THE STAGING LOCK: the reasoning setter is reachable by no one ────────
  -- The single most important assertion in this migration. If a future edit
  -- adds the grant without also being the reviewed user-enablement migration,
  -- replay fails here rather than quietly opening a write path to user-owned
  -- reasoning data.
  IF has_function_privilege('authenticated', 'public.set_current_user_ai_reasoning(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_reasoning_001c: authenticated can execute set_current_user_ai_reasoning; 001C must leave it UNGRANTED';
  END IF;

  -- ── Exact grantee ALLOWLISTS — every grantee judged, not just the named ones ──
  -- The per-role checks above are a deny-list: they would pass a function that
  -- some OTHER role could still execute — through a default-privilege entry
  -- nobody expected, say. So the ACLs are also judged as allowlists: the staged
  -- setter may name its owner and nobody else, and the two granted RPCs their
  -- owner and `authenticated` and nobody else. PUBLIC appears as grantee 0 and
  -- fails both tests, so it needs no separate clause here.
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
      AND a.privilege_type = 'EXECUTE'
      AND a.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'ai_reasoning_001c: set_current_user_ai_reasoning is executable by a role other than its owner; 001C must leave it UNGRANTED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid IN ('public.set_current_user_ai_model(text)'::regprocedure,
                    'public.clear_current_user_ai_reasoning()'::regprocedure)
      AND a.privilege_type = 'EXECUTE'
      AND a.grantee NOT IN (p.proowner, 'authenticated'::regrole::oid)
  ) THEN
    RAISE EXCEPTION 'ai_reasoning_001c: a granted reasoning RPC is executable by a role other than its owner and authenticated';
  END IF;

  -- ── The table posture is exactly as 001A left it ─────────────────────────
  IF has_table_privilege('anon', 'public.ai_model_catalog',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_table_privilege('anon', 'public.user_ai_preferences',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'ai_reasoning_001c: anon holds a privilege on an AI preference table';
  END IF;
  IF has_table_privilege('service_role', 'public.ai_model_catalog', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('service_role', 'public.user_ai_preferences', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ai_reasoning_001c: service_role holds a privilege on an AI preference table';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.ai_model_catalog', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.user_ai_preferences', 'SELECT') THEN
    RAISE EXCEPTION 'ai_reasoning_001c: authenticated lost SELECT on an AI preference table';
  END IF;
  IF has_table_privilege('authenticated', 'public.ai_model_catalog', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('authenticated', 'public.user_ai_preferences', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ai_reasoning_001c: authenticated can write an AI preference table directly';
  END IF;
END
$verify$;
