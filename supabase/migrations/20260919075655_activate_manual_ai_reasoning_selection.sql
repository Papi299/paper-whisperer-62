-- AI-MANUAL-REASONING-001 — open the manual reasoning control to users, for all
-- six currently selectable models at once.
--
-- This migration makes TWO activation changes, and nothing else:
--
--   A. it sets `reasoning_selectable = true` on exactly the six existing rows of
--      public.ai_model_catalog;
--   B. it grants EXECUTE on public.set_current_user_ai_reasoning(text) to
--      `authenticated`, and to no other role.
--
-- Alongside them it rewrites two catalog COMMENTs whose text says the control is
-- staged off, because after this migration that text would be false. A comment
-- is documentation in the catalog, not behaviour: it changes no data, no
-- privilege and no function body.
--
-- ## Why this is the whole change
--
-- AI-MULTI-PROVIDER-001C (20260912120000) built the entire feature and
-- activated none of it. It shipped behind two staging locks, and said in its
-- own header that a later, separately authorized migration would open both
-- together:
--
--   * `reasoning_selectable = false` on every catalog row — the setter refuses a
--     new manual level with `reasoning_not_selectable`, and the Settings control
--     renders the reasoning dropdown disabled;
--   * no EXECUTE grant on `set_current_user_ai_reasoning` — the write path is
--     unreachable from any client even if a UI offered it.
--
-- Everything else already exists, is deployed, and has been live since
-- AI-MULTI-PROVIDER-001C's rollout:
--
--   * `user_ai_preferences.preferred_reasoning_level`, where NULL is Automatic;
--   * the setter's business rules — identity from auth.uid(), entitlement first,
--     a pinned model required, the model re-read under a row lock, the level
--     checked against that model's own `reasoning_levels`;
--   * `set_current_user_ai_model` resetting an incompatible manual level
--     atomically with a model change, and reporting it;
--   * `clear_current_user_ai_reasoning`, granted from the start;
--   * the Edge runtime reading the saved level, applying it to BOTH Analyze and
--     Suggest, falling back to Automatic when the effective model does not list
--     it, and three provider adapters that already express every level;
--   * the Settings control, which renders exactly the catalog's levels for the
--     saved model once `reasoning_selectable` is true;
--   * Account Export v3, which already carries the column.
--
-- So no file under supabase/functions/ changes for this, and no frontend logic
-- does either: the catalog flag and the grant are the two switches the shipped
-- code was built to wait for.
--
-- ## Why all six at once
--
-- Owner decision for AI-MANUAL-REASONING-001: manual reasoning is to be
-- user-selectable for ALL six currently selectable models, not for one provider
-- first. Each row's vocabulary was re-checked against the provider's current
-- first-party documentation on 2026-09-19 and matches the catalog exactly:
--
--   * Gemini 3.5 / 3.6 Flash — minimal | low | medium | high
--   * Gemini 3.7 / 3.8 Flash — low | medium | high (these REJECT `minimal`)
--       https://ai.google.dev/gemini-api/docs/thinking
--   * Claude Sonnet 5 — effort low | medium | high | xhigh | max, with
--     `thinking: {type: "disabled"}` accepted, which is how PaperLume spells
--     `off`
--       https://platform.claude.com/docs/en/build-with-claude/effort
--   * GPT-5.6 Terra — reasoning.effort none | low | medium | high | xhigh | max
--       https://developers.openai.com/api/docs/models/gpt-5.6-terra
--
-- ## What this migration explicitly does NOT do
--
--   * It does NOT change `reasoning_levels`, `auto_analyze_reasoning_level` or
--     `auto_suggest_reasoning_level` on any row. PaperLume's Automatic policy is
--     exactly what it was; this activates the MANUAL override only. Automatic
--     stays the default and the recommended choice.
--   * It does NOT change `id`, `provider`, `provider_model`, `display_name`,
--     `enabled`, `selectable` or `sort_order` on any row, and it inserts or
--     deletes no row.
--   * It does NOT change the column DEFAULT of `reasoning_selectable`, which
--     stays `false`: a future catalog row starts closed to manual reasoning
--     until a reviewed migration opens it, exactly as these six did.
--   * It does NOT write, backfill or migrate any saved preference. Every user
--     stays on Automatic until they choose a level themselves, and nobody's
--     saved model moves.
--   * It does NOT allow manual reasoning on PaperLume's default model. The
--     setter still refuses with `model_required` when no model is pinned,
--     because a level stored against "whatever the default is" could become
--     invalid when PaperLume changes its default server-side.
--   * It does NOT change entitlement. Manual reasoning uses the SAME capability
--     as model selection (`can_select_ai_model` /
--     `ai_model_selection_enabled`); no second flag, plan-name comparison,
--     allowlist or role bypass is introduced, and `get_current_user_access()` is
--     untouched.
--   * It does NOT grant `set_current_user_ai_reasoning` to PUBLIC, `anon` or
--     `service_role`, and it changes no other function's privileges.
--   * It does NOT change any function body, table, column, constraint, policy,
--     RLS setting, trigger, index, quota, plan, price, telemetry schema, system
--     default (C34 / GEMINI_MODEL) or credential.
--
-- Durable decisions: C33 (capability + catalog), C34 (system default), C41
-- (PaperLume's reasoning policy), C43 (stage → canary → activate).


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Preconditions and both activation changes — one atomic statement
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Deliberately ONE DO block, so the preconditions, the UPDATE and the GRANT are a
-- single statement. That keeps them atomic even under `supabase db reset`, which
-- runs a migration file statement-at-a-time rather than as one transaction: a
-- failed precondition can never leave the flag flipped without the grant, or the
-- grant issued without the flag.
--
-- Every precondition is a state this activation was reviewed against. If one is
-- false, the migration aborts before anything changes, rather than normalizing
-- the surprise away. Nothing here repairs unexpected state.
DO $activate$
DECLARE
  v_count   INTEGER;
  v_updated INTEGER;
  v_fn      TEXT;
BEGIN
  -- ── The catalog is exactly the six approved rows ─────────────────────────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: catalog holds % row(s); expected exactly 6', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE id IN ('google/gemini-3.5-flash', 'google/gemini-3.6-flash',
               'google/gemini-3.7-flash', 'google/gemini-3.8-flash',
               'anthropic/claude-sonnet-5', 'openai/gpt-5.6-terra');
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: % of the 6 approved model ids are present', v_count;
  END IF;

  -- ── Each row is in EXACTLY the reviewed pre-activation state ─────────────
  -- Field by field, flags and reasoning metadata included. The exact
  -- `reasoning_levels` array (order included) is what the Settings control will
  -- start offering the moment this commits, and the two `auto_*` columns are
  -- the Automatic policy that must NOT move. A drifted row fails here rather
  -- than being activated on trust.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
         reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
         reasoning_selectable) IN (
    ('google/gemini-3.5-flash', 'google', 'gemini-3.5-flash', 'Gemini 3.5 Flash',
     true, true, 10, ARRAY['minimal','low','medium','high'], 'minimal', 'medium', false),
    ('google/gemini-3.6-flash', 'google', 'gemini-3.6-flash', 'Gemini 3.6 Flash',
     true, true, 20, ARRAY['minimal','low','medium','high'], 'minimal', 'medium', false),
    ('google/gemini-3.7-flash', 'google', 'gemini-3.7-flash', 'Gemini 3.7 Flash',
     true, true, 30, ARRAY['low','medium','high'], 'low', 'medium', false),
    ('google/gemini-3.8-flash', 'google', 'gemini-3.8-flash', 'Gemini 3.8 Flash',
     true, true, 40, ARRAY['low','medium','high'], 'low', 'medium', false),
    ('anthropic/claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5',
     true, true, 50, ARRAY['off','low','medium','high','xhigh','max'], 'off', 'medium', false),
    ('openai/gpt-5.6-terra', 'openai', 'gpt-5.6-terra', 'GPT-5.6 Terra',
     true, true, 60, ARRAY['none','low','medium','high','xhigh','max'], 'none', 'medium', false)
  );
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: the six catalog rows are not in the exact reviewed pre-activation state';
  END IF;

  -- Stated on its own so the failure names it: nothing has been opened yet.
  SELECT count(*) INTO v_count FROM public.ai_model_catalog WHERE reasoning_selectable;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: % catalog row(s) already offer manual reasoning', v_count;
  END IF;

  -- ── The function being granted is exactly the reviewed 001C setter ───────
  -- A grant is a statement about a specific body. If
  -- set_current_user_ai_reasoning was replaced after 20260912120000 — by any
  -- route — this migration would be granting code nobody reviewed for user
  -- exposure, so the body is pinned by digest, alongside its security shape.
  -- The digest is md5 of pg_proc.prosrc: the text between the `$$` tags of the
  -- CREATE FUNCTION in 20260912120000, byte-identical in Production
  -- (verified read-only on 2026-09-19).
  PERFORM 1
  FROM pg_proc p
  WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
    AND p.prosecdef
    AND p.proconfig @> ARRAY['search_path=public']
    AND p.proargnames = ARRAY['p_reasoning_level','saved','reason','preferred_model_id',
                              'preferred_reasoning_level','updated_at']
    AND md5(p.prosrc) = '2f3db6644683273bb8e3bcea2b3f3811';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: set_current_user_ai_reasoning is not the reviewed 001C definition';
  END IF;

  -- ── The setter is still granted to NOBODY but its owner ──────────────────
  -- An allowlist, judging every grantee, not three negative checks: a grant
  -- through a default-privilege entry nobody expected would pass a deny-list.
  -- PUBLIC appears as grantee 0 and fails this test too.
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
      AND a.privilege_type = 'EXECUTE'
      AND a.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: set_current_user_ai_reasoning is already executable by a role other than its owner';
  END IF;
  -- And by name, so the failure is unambiguous about which role.
  IF has_function_privilege('authenticated', 'public.set_current_user_ai_reasoning(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: authenticated can already execute set_current_user_ai_reasoning';
  END IF;
  IF has_function_privilege('anon', 'public.set_current_user_ai_reasoning(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: anon can execute set_current_user_ai_reasoning';
  END IF;
  IF has_function_privilege('service_role', 'public.set_current_user_ai_reasoning(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: service_role can execute set_current_user_ai_reasoning';
  END IF;

  -- ── The rest of the preference RPC family is exactly as granted ──────────
  -- The way back to Automatic (clear_current_user_ai_reasoning) must already be
  -- reachable, and the model-selection RPCs must hold their reviewed posture:
  -- owner + authenticated, nobody else.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.set_current_user_ai_model(text)',
    'public.clear_current_user_ai_model()',
    'public.clear_current_user_ai_reasoning()'] LOOP
    IF NOT has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'ai_manual_reasoning_001: authenticated cannot execute %', v_fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = v_fn::regprocedure
        AND a.privilege_type = 'EXECUTE'
        AND a.grantee NOT IN (p.proowner, 'authenticated'::regrole::oid)
    ) THEN
      RAISE EXCEPTION 'ai_manual_reasoning_001: % is executable by a role other than its owner and authenticated', v_fn;
    END IF;
  END LOOP;

  -- ── A. The catalog flag, on exactly six rows ─────────────────────────────
  -- Scoped by id AND by the flag being false, so the count below is an exact
  -- statement about what this transaction changed, and a re-run could not
  -- quietly report success over rows it did not actually change.
  UPDATE public.ai_model_catalog
     SET reasoning_selectable = true
   WHERE id IN ('google/gemini-3.5-flash', 'google/gemini-3.6-flash',
                'google/gemini-3.7-flash', 'google/gemini-3.8-flash',
                'anthropic/claude-sonnet-5', 'openai/gpt-5.6-terra')
     AND NOT reasoning_selectable;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 6 THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: activation updated % row(s); expected exactly 6', v_updated;
  END IF;

  -- The BEFORE UPDATE trigger stamps every row it writes with now(). Checked
  -- HERE, inside the same statement as the UPDATE, because `db reset` runs a
  -- file statement-at-a-time and a later block would see a different now().
  SELECT count(*) INTO v_count FROM public.ai_model_catalog WHERE updated_at >= now();
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: % catalog row(s) carry this statement''s timestamp; expected 6', v_count;
  END IF;

  -- ── B. The grant, to exactly one role ────────────────────────────────────
  -- `authenticated` only, and WITHOUT grant option. The function already
  -- derives its caller from auth.uid(), takes no user id, re-checks
  -- entitlement, the pinned model, `reasoning_selectable` and the model's own
  -- level list — this grant only makes that reviewed path reachable.
  GRANT EXECUTE ON FUNCTION public.set_current_user_ai_reasoning(text) TO authenticated;
END
$activate$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Catalog documentation that would otherwise be false
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Both comments currently describe the staged state ("granted to NO role",
-- "false on every row"). They are rewritten, not appended to, so a reader of the
-- live catalog never meets a claim the schema contradicts. No behaviour changes.

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
  'Calls no AI provider and returns no secret. Created ungranted by '
  'AI-MULTI-PROVIDER-001C; EXECUTE granted to authenticated ONLY by '
  'AI-MANUAL-REASONING-001, together with reasoning_selectable = true on the '
  'six then-current catalog rows. SECURITY DEFINER + fixed search_path. '
  'See decision C41.';

COMMENT ON COLUMN public.ai_model_catalog.reasoning_selectable IS
  'Whether users may NEWLY choose a manual reasoning level for this model — '
  'the reasoning analogue of `selectable`, and NOT a statement about whether '
  'reasoning exists. An already-saved level on a row with false stays honoured '
  'by the runtime and stays clearable by its owner; it simply cannot be '
  'changed to a different manual level. Defaults to false, so a new model '
  'starts closed until a reviewed migration opens it. Created false on every '
  'row by AI-MULTI-PROVIDER-001C; set true on the six then-current rows by '
  'AI-MANUAL-REASONING-001. See decision C41.';


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Asserts what this migration claims, in the style of 20260912120000 §8 and
-- 20260918210017 §2. `supabase db push` wraps each file in one transaction, so
-- under it this block shares the activation's transaction and a failure here
-- rolls the whole file back.
--
-- The positive "these six rows were written now" check lives in section 1, not
-- here: `db reset` runs statements in autocommit, so this block's now() can be
-- later than the UPDATE's. The two "nothing else was written" checks below
-- compare against now() too; they are exact under `db push` and can only pass
-- more easily under a reset, never fail spuriously.
DO $verify$
DECLARE
  v_count INTEGER;
  v_fn    TEXT;
BEGIN
  -- ── Still exactly six rows: nothing inserted or deleted ──────────────────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: catalog holds % row(s) after activation; expected exactly 6', v_count;
  END IF;

  -- ── Each row is now EXACTLY as specified, reasoning_selectable included ──
  -- The full tuple again, with `reasoning_selectable` the single changed value:
  -- this is what proves every other field — including the reasoning vocabulary
  -- and the Automatic matrix — is exactly as it was.
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
    RAISE EXCEPTION 'ai_manual_reasoning_001: the six catalog rows are not exactly as specified after activation';
  END IF;

  -- ── Exactly these six, and no other row, offer manual reasoning ──────────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog WHERE reasoning_selectable;
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: % catalog row(s) offer manual reasoning; expected exactly 6', v_count;
  END IF;

  -- ── Gemini 3.7 / 3.8 still do not offer `minimal` ────────────────────────
  -- Restated on its own because it is the one per-model fact whose violation
  -- would become a user-visible provider 400 the moment a level is chosen.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE id IN ('google/gemini-3.7-flash', 'google/gemini-3.8-flash')
    AND 'minimal' = ANY (reasoning_levels);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: % row(s) offer `minimal` on a model Google rejects it for', v_count;
  END IF;

  -- ── A FUTURE row still starts closed ─────────────────────────────────────
  IF (SELECT pg_get_expr(d.adbin, d.adrelid)
        FROM pg_attribute a
        JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'public.ai_model_catalog'::regclass
         AND a.attname = 'reasoning_selectable') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: reasoning_selectable no longer defaults to false';
  END IF;

  -- ── THE GRANT: authenticated can execute the setter ──────────────────────
  IF NOT has_function_privilege('authenticated', 'public.set_current_user_ai_reasoning(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: authenticated cannot execute set_current_user_ai_reasoning';
  END IF;

  -- ── …and NOBODY else can: an exact allowlist, every grantee judged ───────
  -- The owner keeps its natural owner right; `authenticated` is the only grantee
  -- added. PUBLIC (grantee 0), anon, service_role and any unknown role all fail
  -- this single test.
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
      AND a.privilege_type = 'EXECUTE'
      AND a.grantee NOT IN (p.proowner, 'authenticated'::regrole::oid)
  ) THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: set_current_user_ai_reasoning is executable by a role other than its owner and authenticated';
  END IF;
  -- authenticated may call it but may not pass the privilege on.
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
      AND a.grantee = 'authenticated'::regrole::oid
      AND a.is_grantable
  ) THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: authenticated holds EXECUTE on set_current_user_ai_reasoning WITH GRANT OPTION';
  END IF;
  -- The same three negatives by name, so a failure names its role.
  IF has_function_privilege('anon', 'public.set_current_user_ai_reasoning(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: anon can execute set_current_user_ai_reasoning';
  END IF;
  IF has_function_privilege('service_role', 'public.set_current_user_ai_reasoning(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: service_role can execute set_current_user_ai_reasoning';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
      AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: set_current_user_ai_reasoning carries PUBLIC EXECUTE';
  END IF;

  -- ── The granted body is still the reviewed body ──────────────────────────
  IF (SELECT md5(p.prosrc) FROM pg_proc p
        WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure)
     IS DISTINCT FROM '2f3db6644683273bb8e3bcea2b3f3811' THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: set_current_user_ai_reasoning body changed during activation';
  END IF;

  -- ── No other RPC in the family changed posture ───────────────────────────
  FOREACH v_fn IN ARRAY ARRAY[
    'public.set_current_user_ai_model(text)',
    'public.clear_current_user_ai_model()',
    'public.clear_current_user_ai_reasoning()'] LOOP
    IF NOT has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'ai_manual_reasoning_001: authenticated lost EXECUTE on %', v_fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = v_fn::regprocedure
        AND a.privilege_type = 'EXECUTE'
        AND a.grantee NOT IN (p.proowner, 'authenticated'::regrole::oid)
    ) THEN
      RAISE EXCEPTION 'ai_manual_reasoning_001: % is executable by a role other than its owner and authenticated', v_fn;
    END IF;
  END LOOP;

  -- ── No user preference was written, created or backfilled ────────────────
  -- Activation makes a manual level CHOOSABLE; it never chooses one. Asserted
  -- by write timestamp rather than absolute state, so this stays true when the
  -- migration is replayed on a database where users have since chosen levels.
  SELECT count(*) INTO v_count
  FROM public.user_ai_preferences
  WHERE updated_at >= now();
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: % user preference row(s) were written', v_count;
  END IF;

  -- ── No entitlement was written ───────────────────────────────────────────
  -- Nobody gained or lost the model-selection capability, and so nobody gained
  -- manual reasoning except through the capability they already held.
  SELECT count(*) INTO v_count
  FROM public.user_entitlements
  WHERE updated_at >= now();
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: % entitlement row(s) were written', v_count;
  END IF;

  -- ── The table posture is unchanged: clients still cannot write directly ──
  IF has_table_privilege('authenticated', 'public.ai_model_catalog', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('authenticated', 'public.user_ai_preferences', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ai_manual_reasoning_001: authenticated can write an AI preference table directly';
  END IF;
END
$verify$;
