-- AI-MODEL-SELECTION-001A — entitlement, model catalog, and per-user preference
-- foundation.
--
-- One additive migration that builds the *data and authorization* foundation for
-- a future user-selectable AI model, and deliberately stops there.
--
-- What it adds:
--   1. public.user_entitlements.ai_model_selection_enabled — a server-controlled
--      commercial/internal capability flag (default false), backfilled true for
--      existing active/trialing 'pro' / 'labs_team' rows.
--   2. public.ai_model_catalog — the authoritative, server-controlled list of AI
--      models Paperlume has explicitly approved for selection. Seeded with
--      exactly two rows: google/gemini-3.5-flash and google/gemini-3.6-flash.
--   3. public.user_ai_preferences — at most one saved model preference per user.
--      NOT backfilled: absence of a row means "use Paperlume's system default".
--   4. public.get_current_user_access() gains an additive, fail-closed
--      can_select_ai_model column.
--   5. public.set_current_user_ai_model(text) — the ONLY write path to a
--      preference, and public.clear_current_user_ai_model() — reset to default.
--
-- What it explicitly does NOT do, and must not be read as doing:
--   * It does NOT change which model any AI operation actually invokes.
--     analyze-paper and suggest-paper-organization keep resolving the model
--     through the global GEMINI_MODEL environment configuration and
--     supabase/functions/_shared/geminiModel.ts, untouched. Runtime routing is
--     AI-MODEL-SELECTION-001B.
--   * It adds NO provider credential and NO per-model API key. Gemini 3.5 Flash
--     and Gemini 3.6 Flash are served by the SAME existing server-side
--     GEMINI_API_KEY. No secret material exists anywhere in this migration, and
--     none may ever be stored in ai_model_catalog.
--   * It adds NO Anthropic / OpenAI / Gemini 3.7 support. `provider` is
--     deliberately unconstrained precisely so those become a seed row plus a
--     runtime adapter later, not a schema change — but nothing here implements
--     them.
--   * It changes no plan name, quota, paper limit, storage limit, premium
--     taxonomy flag, Labs/Teams flag, billing identifier or usage counter.
--
-- Durable decision: the enforcement contract is the explicit server-controlled
-- ai_model_selection_enabled flag combined with an active entitlement status —
-- NOT a client-side `plan === 'pro'` comparison, and never an email. An
-- owner/internal/test account is enabled by a server-side grant that sets the
-- flag, with no client change. See docs/decisions-and-triggers.md C33.
--
-- Conventions reused from prior migrations:
--   * public.update_updated_at_column() (20260203072053 / 20260411010000) is the
--     canonical updated_at trigger function for the commercial tables.
--   * ENABLE + FORCE ROW LEVEL SECURITY is the canonical posture
--     (20260412030000_fix_rls_all_tables.sql).
--   * Data API grants are stated explicitly, REVOKE-first
--     (20260731162729 / 20260818120000 §7): the Supabase database template
--     grants ALL on a new table to anon/authenticated/service_role by default,
--     so additive GRANTs alone would describe a surface the database does not
--     have.
--   * SECURITY DEFINER RPCs derive identity from auth.uid(), pin search_path,
--     and hold EXECUTE for {authenticated} only (20260726120000 / 20260731162729).


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. user_entitlements.ai_model_selection_enabled — the capability flag
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Server-controlled, like every other column on this table: user_entitlements
-- has a SELECT-own policy and NO client INSERT/UPDATE/DELETE policy, and
-- `authenticated` holds SELECT only (20260731162729). Adding a column therefore
-- cannot make it client-writable, and no new policy or grant is issued here.

ALTER TABLE public.user_entitlements
    ADD COLUMN ai_model_selection_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_entitlements.ai_model_selection_enabled IS
    'Server-controlled capability: this user''s currently effective entitlement '
    'permits choosing a non-default Paperlume AI model, subject to active '
    'entitlement state (plan_status active|trialing) and server-side model '
    'availability (ai_model_catalog.enabled AND .selectable). false on Free. '
    'This explicit flag — NOT a client-side plan-name comparison — is the '
    'durable enforcement contract, so an internal/test account can be granted '
    'model selection by a server-side entitlement write alone. Future billing '
    'ingestion must maintain it as part of the internal entitlement projection. '
    'See decisions C33.';

-- Deterministic backfill of the CURRENTLY paid, currently-valid population.
-- Free rows keep the false default. Nothing else on the row is touched: no plan,
-- quota, limit, billing identifier or counter changes.
UPDATE public.user_entitlements
   SET ai_model_selection_enabled = true
 WHERE plan IN ('pro', 'labs_team')
   AND plan_status IN ('active', 'trialing');


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. ai_model_catalog — the server-controlled allowlist of approved models
-- ═════════════════════════════════════════════════════════════════════════════
--
-- One authoritative row per AI model Paperlume has explicitly approved. This is
-- an allowlist, not a mirror of what a provider happens to offer: a model exists
-- here only after product, privacy, cost and runtime-adapter acceptance.
--
-- `id` is a stable, provider-qualified internal identifier ('google/gemini-3.5-
-- flash'). It is deliberately NOT the bare provider model string: two providers
-- may ship colliding model names, and the saved preference must keep meaning the
-- same model forever. `provider_model` is the string a future runtime adapter
-- would hand to the provider; it is stored here ONCE so the preference table
-- never duplicates it and cannot drift.
--
-- `provider` is intentionally NOT constrained to a closed list. Anthropic and
-- OpenAI are intended future additions, and a CHECK enumerating today's single
-- provider would turn "seed a row" into "alter a constraint". Nothing here
-- implements a second provider.
--
-- The table holds NO credential and NO secret name. It is product metadata:
-- which model, from which provider, under which display label, in which order.

CREATE TABLE public.ai_model_catalog (
    id             TEXT NOT NULL PRIMARY KEY,
    provider       TEXT NOT NULL,
    provider_model TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    enabled        BOOLEAN NOT NULL DEFAULT true,
    selectable     BOOLEAN NOT NULL DEFAULT true,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Non-empty AND already trimmed. Trimmed matters as much as non-empty: a
    -- trailing space in a provider_model reaches the provider verbatim, and a
    -- trailing space in an id would silently create a second, unreachable model.
    CONSTRAINT ai_model_catalog_id_trimmed_nonempty
        CHECK (id = btrim(id) AND id <> ''),
    CONSTRAINT ai_model_catalog_provider_trimmed_nonempty
        CHECK (provider = btrim(provider) AND provider <> ''),
    CONSTRAINT ai_model_catalog_provider_model_trimmed_nonempty
        CHECK (provider_model = btrim(provider_model) AND provider_model <> ''),
    CONSTRAINT ai_model_catalog_display_name_trimmed_nonempty
        CHECK (display_name = btrim(display_name) AND display_name <> ''),
    CONSTRAINT ai_model_catalog_sort_order_nonneg
        CHECK (sort_order >= 0),

    -- One catalog row per real provider model. Two internal ids pointing at the
    -- same provider model would make the user's choice ambiguous and the future
    -- runtime adapter's behaviour undefined.
    CONSTRAINT ai_model_catalog_provider_model_unique
        UNIQUE (provider, provider_model)
);

COMMENT ON TABLE public.ai_model_catalog IS
    'Server-controlled allowlist of the AI models Paperlume has explicitly '
    'approved for user selection. Read-only to authenticated clients (SELECT '
    'grant + SELECT policy, no INSERT/UPDATE/DELETE policy and no write grant); '
    'rows are added or retired by a reviewed migration, never at runtime. '
    'Contains NO API key, secret name or credential — it is product metadata '
    'only. `provider` is deliberately unconstrained so a future Anthropic / '
    'OpenAI model is a seed row plus a runtime adapter rather than a schema '
    'change. Prefer setting enabled = false over DELETE so saved preferences and '
    'model history survive. See decisions C33.';

COMMENT ON COLUMN public.ai_model_catalog.id IS
    'Stable provider-qualified internal identifier, e.g. google/gemini-3.5-flash. '
    'This is what user_ai_preferences stores; it must never be reused for a '
    'different model.';
COMMENT ON COLUMN public.ai_model_catalog.provider_model IS
    'The provider-side model string a future runtime adapter would send. Stored '
    'here once; never duplicated into user_ai_preferences.';
COMMENT ON COLUMN public.ai_model_catalog.enabled IS
    'Master switch. false retires the model everywhere without deleting history.';
COMMENT ON COLUMN public.ai_model_catalog.selectable IS
    'Whether users may CHOOSE this model. A model can be enabled (usable if '
    'already selected, or as a system default) yet not selectable.';

CREATE INDEX idx_ai_model_catalog_selectable_order
    ON public.ai_model_catalog (sort_order, id)
    WHERE enabled AND selectable;

ALTER TABLE public.ai_model_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model_catalog FORCE ROW LEVEL SECURITY;

-- Read-only to signed-in users. Every row is readable — including a disabled or
-- unselectable one — because a client rendering a previously-saved preference
-- still needs its display name, and the contents are non-sensitive product
-- metadata. There is deliberately no INSERT/UPDATE/DELETE policy: combined with
-- the grants in section 4, direct client mutation is denied twice over.
CREATE POLICY "Authenticated users can read the AI model catalog"
    ON public.ai_model_catalog FOR SELECT
    TO authenticated
    USING (true);

CREATE TRIGGER update_ai_model_catalog_updated_at
    BEFORE UPDATE ON public.ai_model_catalog
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Seed — exactly the two initially approved models
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Both are served by the SAME existing server-side GEMINI_API_KEY; there is no
-- per-model credential and none is created here.
--
-- Nothing else is seeded. Gemini 3.7, any Claude model, any OpenAI/GPT model,
-- any preview model and the floating 'gemini-flash-latest' alias are all
-- deliberately absent: each needs explicit product/provider acceptance first,
-- and a floating alias is not a stable thing for a user to have chosen.
--
-- sort_order is sparse (10, 20) so a future model can be placed between two
-- existing ones without renumbering rows a user has already selected.
INSERT INTO public.ai_model_catalog
    (id, provider, provider_model, display_name, enabled, selectable, sort_order)
VALUES
    ('google/gemini-3.5-flash', 'google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', true, true, 10),
    ('google/gemini-3.6-flash', 'google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', true, true, 20);


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. user_ai_preferences — at most one saved preference per user
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ABSENCE OF A ROW IS MEANINGFUL: it means the user has expressed no preference
-- and Paperlume must use its system default. This migration therefore inserts
-- NOTHING here and adds nothing to handle_new_user() — manufacturing a row for
-- every existing user would silently convert "no opinion" into "chose Gemini
-- 3.5", a choice they never made.
--
-- user_id is the primary key, so one-row-per-user is a schema property rather
-- than something the setter has to be careful about.
--
-- preferred_model_id references the catalog with the default NO ACTION: a model
-- row a user has selected cannot be deleted out from under them. Retire a model
-- by setting enabled = false, which the setter and the future runtime both
-- honour, instead of destroying the history.

CREATE TABLE public.user_ai_preferences (
    user_id            UUID NOT NULL PRIMARY KEY
                       REFERENCES auth.users(id) ON DELETE CASCADE,
    preferred_model_id TEXT NOT NULL
                       REFERENCES public.ai_model_catalog(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_ai_preferences IS
    'A user''s explicitly saved AI model preference. At most one row per user '
    '(user_id is the primary key); NO row means "no explicit preference — use '
    'Paperlume''s system default", which is why this table is never backfilled. '
    'A user may read only their own row (SELECT-own policy + SELECT grant); all '
    'writes go through set_current_user_ai_model / clear_current_user_ai_model, '
    'which derive the caller from auth.uid(). Stores no provider credential and '
    'no provider_model string — the catalog owns that. A saved row may remain '
    'DORMANT after a downgrade: it is deliberately not deleted when entitlement '
    'lapses, and runtime authorization must be re-checked on every AI operation '
    'rather than inferred from the row''s existence. See decisions C33.';

COMMENT ON COLUMN public.user_ai_preferences.preferred_model_id IS
    'FK to ai_model_catalog.id. NO ACTION on delete by design — retire a model '
    'with enabled = false rather than deleting a row users have chosen.';

CREATE INDEX idx_user_ai_preferences_model
    ON public.user_ai_preferences (preferred_model_id);

ALTER TABLE public.user_ai_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_ai_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own AI model preference"
    ON public.user_ai_preferences FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- No INSERT / UPDATE / DELETE policy. Direct client mutation is not the
-- authorization path: a client that could INSERT its own row would have granted
-- itself model selection without ever passing an entitlement check.

CREATE TRIGGER update_user_ai_preferences_updated_at
    BEFORE UPDATE ON public.user_ai_preferences
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────────────
-- 4b. Data API grants — explicit, least-privilege, REVOKE-first
-- ─────────────────────────────────────────────────────────────────────────────
--
-- REVOKE FIRST is load-bearing, not boilerplate. The Supabase database template
-- ships `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon, authenticated,
-- service_role` for the role that owns these migrations, so both tables above
-- arrive with ALL privileges already granted to all three API roles. Without the
-- revoke, `authenticated` could UPDATE the catalog (pointing a "Gemini" row at
-- any provider model it liked) and INSERT its own preference row, and `anon`
-- could read both. The section 7 verify block asserts the revocation actually
-- took, so a platform default change in either direction fails at replay.
--
--   * anon and PUBLIC get nothing. There is no unauthenticated path to either
--     table.
--   * authenticated gets SELECT and only SELECT on both. Reads feed a future
--     dropdown; every write goes through the RPCs in sections 6a/6b.
--   * service_role gets nothing, deliberately rather than by omission. No Edge
--     Function in this repository reads or writes either table — the AI
--     functions call their RPCs with the caller's own JWT — and catalog
--     administration is a reviewed migration, not a runtime write. Granting a
--     server role access it has no caller for would only widen the blast radius
--     of a leaked secret key. Account deletion is unaffected: the FK cascade
--     above is enforced internally and does not consult the deleting role's
--     privileges.
REVOKE ALL ON TABLE public.ai_model_catalog
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.user_ai_preferences
    FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.ai_model_catalog    TO authenticated;
GRANT SELECT ON TABLE public.user_ai_preferences TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. get_current_user_access() — additive, fail-closed can_select_ai_model
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The RETURNS TABLE gains one column, so this must DROP + CREATE (a return-type
-- change cannot use CREATE OR REPLACE). Every pre-existing column keeps its
-- name, type, position and derivation; only the additive column is new.
--
-- can_select_ai_model is true ONLY when the entitlement row exists, carries
-- ai_model_selection_enabled = true, AND has plan_status in ('active',
-- 'trialing'). A missing entitlement yields false because both COALESCEs fall
-- back to a denying value — not because of an implicit NULL comparison, which
-- would have produced NULL rather than false.
--
-- Note what this deliberately does NOT consult: the catalog, the user's saved
-- preference, and the plan NAME. This column answers "may this user choose a
-- model at all", and answers it from the explicit capability flag alone.

DROP FUNCTION IF EXISTS public.get_current_user_access();

CREATE FUNCTION public.get_current_user_access()
RETURNS TABLE(
  role TEXT,
  is_internal BOOLEAN,
  can_view_provider_quota BOOLEAN,
  ai_quota_exempt BOOLEAN,
  plan TEXT,
  plan_status TEXT,
  premium_taxonomy_enabled BOOLEAN,
  labs_team_enabled BOOLEAN,
  can_select_ai_model BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_exempt BOOLEAN;
  v_entitlement public.user_entitlements%ROWTYPE;
BEGIN
  -- Null-auth rejection: no anonymous access. EXECUTE is also revoked from anon
  -- below; this guard additionally covers a null uid on a tokenless call.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no authenticated user';
  END IF;

  -- Effective internal role. No arbitrary-user lookup — keyed on auth.uid().
  -- SECURITY DEFINER lets this read the server-only internal_user_access table.
  SELECT ia.role, ia.ai_quota_exempt
    INTO v_role, v_exempt
  FROM public.internal_user_access ia
  WHERE ia.user_id = v_uid;

  IF v_role IS NULL THEN
    -- Ordinary user: safe default. No internal row → role 'user', not internal,
    -- cannot view provider quota, not exempt.
    v_role := 'user';
    v_exempt := false;
  END IF;

  -- Commercial context (plan/plan_status/flags). Absent entitlement → NULL plan
  -- and false flags via COALESCE.
  SELECT * INTO v_entitlement
  FROM public.user_entitlements
  WHERE user_id = v_uid;

  RETURN QUERY SELECT
    v_role,
    (v_role IN ('owner', 'manager')),
    (v_role IN ('owner', 'manager')),
    COALESCE(v_exempt, false),
    v_entitlement.plan,
    v_entitlement.plan_status,
    COALESCE(v_entitlement.premium_taxonomy_enabled, false),
    COALESCE(v_entitlement.labs_team_enabled, false),
    (COALESCE(v_entitlement.ai_model_selection_enabled, false)
     AND COALESCE(v_entitlement.plan_status, '') IN ('active', 'trialing'));
END;
$$;

COMMENT ON FUNCTION public.get_current_user_access() IS
  'Read-only projection of the CALLER''s effective internal role (owner | '
  'manager | user) and capability flags (is_internal, can_view_provider_quota, '
  'ai_quota_exempt) plus commercial plan / plan_status and implemented feature '
  'flags, including the additive fail-closed can_select_ai_model (true only when '
  'the entitlement exists with ai_model_selection_enabled = true AND plan_status '
  'in active|trialing). Derives identity from auth.uid() only (no p_user_id, no '
  'arbitrary lookup); rejects null auth. SECURITY DEFINER + STABLE + fixed '
  'search_path. Ordinary users with no internal row default to role ''user''. '
  'Never exposes the owner/manager roster. Advisory for UX only — the server '
  'boundary re-checks every capability. See decisions C28 and C33.';

REVOKE ALL ON FUNCTION public.get_current_user_access() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_current_user_access() TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 6a. set_current_user_ai_model — the only write path to a preference
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Takes NO user id. The caller is auth.uid(), full stop: there is no parameter
-- through which one user could name another, so cross-user mutation is not
-- guarded against — it is unexpressible.
--
-- Checks, in this order:
--   1. authenticated caller (null auth raises, matching the S1 RPC family);
--   2. a usable model id was supplied;
--   3. the caller's entitlement permits model selection AT ALL — checked BEFORE
--      the model is looked up, so a non-entitled caller learns nothing from the
--      shape of the failure;
--   4. the requested model exists in the catalog, is enabled, and is selectable.
-- Only then is the caller's own row upserted.
--
-- Returns a structured non-sensitive confirmation rather than raising on a
-- business rejection, mirroring the consume_ai_quota / get_ai_quota_status
-- family: a later client needs to distinguish "not entitled" from "that model is
-- retired" to say something useful, and neither reason discloses anything the
-- caller could not already read.
--
-- It calls no AI provider, reads no credential, and returns no secret.

CREATE FUNCTION public.set_current_user_ai_model(p_model_id TEXT)
RETURNS TABLE(
  saved BOOLEAN,
  reason TEXT,
  preferred_model_id TEXT,
  provider TEXT,
  display_name TEXT,
  updated_at TIMESTAMPTZ
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
BEGIN
  -- S1: identity comes from the session, never from an argument.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no authenticated user';
  END IF;

  v_model_id := btrim(COALESCE(p_model_id, ''));
  IF v_model_id = '' THEN
    RETURN QUERY SELECT
      FALSE, 'invalid_model_id'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Entitlement first. Fail closed on a missing row: no entitlement is not
  -- "unknown, allow" — it is "not entitled".
  SELECT * INTO v_entitlement
  FROM public.user_entitlements
  WHERE user_id = v_uid;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      FALSE, 'missing_entitlement'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT COALESCE(v_entitlement.ai_model_selection_enabled, false) THEN
    -- The explicit capability flag is the gate. A plan column reading 'pro'
    -- with the flag false denies here, on purpose: the flag is the contract.
    RETURN QUERY SELECT
      FALSE, 'not_entitled'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF COALESCE(v_entitlement.plan_status, '') NOT IN ('active', 'trialing') THEN
    RETURN QUERY SELECT
      FALSE, 'inactive_entitlement'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Catalog allowlist. An id absent from the catalog is refused; there is no
  -- pass-through of an arbitrary string to a provider model.
  SELECT * INTO v_model
  FROM public.ai_model_catalog
  WHERE id = v_model_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      FALSE, 'unknown_model'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT v_model.enabled THEN
    RETURN QUERY SELECT
      FALSE, 'model_disabled'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT v_model.selectable THEN
    RETURN QUERY SELECT
      FALSE, 'model_not_selectable'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Upsert the CALLER's row and no other. user_id is the primary key, so the
  -- conflict target is the whole identity of the row: this can create or replace
  -- exactly one row, belonging to exactly this caller.
  INSERT INTO public.user_ai_preferences AS p (user_id, preferred_model_id)
  VALUES (v_uid, v_model.id)
  ON CONFLICT (user_id) DO UPDATE
    SET preferred_model_id = EXCLUDED.preferred_model_id,
        updated_at = now()
  RETURNING p.updated_at INTO v_updated_at;

  RETURN QUERY SELECT
    TRUE,
    'ok'::TEXT,
    v_model.id,
    v_model.provider,
    v_model.display_name,
    v_updated_at;
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
  'model_not_selectable) and writes nothing. Upserts at most one row. Calls no '
  'AI provider and returns no secret. Saving a preference does NOT change which '
  'model any AI operation invokes — runtime routing is AI-MODEL-SELECTION-001B '
  'and must re-check authorization itself. SECURITY DEFINER + fixed search_path; '
  'EXECUTE granted to authenticated only. See decisions C33.';

REVOKE ALL ON FUNCTION public.set_current_user_ai_model(TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_current_user_ai_model(TEXT) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 6b. clear_current_user_ai_model — reset to Paperlume's system default
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Deliberately does NOT require model-selection entitlement. Clearing is the
-- safe direction: it removes a preference and returns the account to the system
-- default. Requiring the capability to clear would trap a downgraded user with a
-- dormant preference they could no longer remove — an entitlement check that
-- protects nothing and only takes control away.
--
-- Affects exactly one row, keyed on auth.uid(). Nothing else on the account is
-- touched: no entitlement, plan, quota, counter or setting.
--
-- This does not change what the system default IS.

CREATE FUNCTION public.clear_current_user_ai_model()
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
  v_deleted INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no authenticated user';
  END IF;

  DELETE FROM public.user_ai_preferences
  WHERE user_id = v_uid;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted = 0 THEN
    -- Idempotent: already on the system default.
    RETURN QUERY SELECT FALSE, 'no_preference'::TEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'ok'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.clear_current_user_ai_model() IS
  'Remove the CALLER''s saved AI model preference, returning the account to '
  'Paperlume''s system default. Derives the user from auth.uid() and accepts no '
  'parameter, so it can never clear another user''s row. Requires '
  'authentication but deliberately NOT model-selection entitlement — a '
  'downgraded user must still be able to drop a dormant preference. Idempotent: '
  'clearing when nothing is saved returns cleared = false, reason no_preference. '
  'Touches no other setting and does not change what the system default is. '
  'SECURITY DEFINER + fixed search_path; EXECUTE granted to authenticated only. '
  'See decisions C33.';

REVOKE ALL ON FUNCTION public.clear_current_user_ai_model() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.clear_current_user_ai_model() TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 7. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Asserts what this migration claims, in the same transaction that claims it, so
-- a replay that silently produced a weaker schema fails here instead of shipping.
-- Modelled on 20260818120000 §18.
DO $verify$
DECLARE
  v_table   TEXT;
  v_row     RECORD;
  v_count   INTEGER;
  v_tables  TEXT[] := ARRAY['ai_model_catalog', 'user_ai_preferences'];
  v_fns     TEXT[] := ARRAY[
    'public.get_current_user_access()',
    'public.set_current_user_ai_model(text)',
    'public.clear_current_user_ai_model()'];
  v_fn      TEXT;
BEGIN
  -- ── The entitlement flag exists, is NOT NULL, and defaults false ──
  SELECT a.attnotnull AS is_notnull,
         pg_get_expr(d.adbin, d.adrelid) AS defexpr,
         format_type(a.atttypid, a.atttypmod) AS typ
    INTO v_row
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.user_entitlements'::regclass
    AND a.attname = 'ai_model_selection_enabled'
    AND NOT a.attisdropped;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_model_selection: user_entitlements.ai_model_selection_enabled was not created';
  END IF;
  IF NOT v_row.is_notnull OR v_row.typ <> 'boolean' OR v_row.defexpr IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'ai_model_selection: ai_model_selection_enabled must be NOT NULL boolean DEFAULT false (got % / % / %)',
      v_row.typ, v_row.is_notnull, v_row.defexpr;
  END IF;

  -- ── The backfill was exactly the active/trialing paid population ──
  SELECT count(*) INTO v_count
  FROM public.user_entitlements
  WHERE ai_model_selection_enabled
    AND NOT (plan IN ('pro', 'labs_team') AND plan_status IN ('active', 'trialing'));
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_model_selection: % entitlement row(s) enabled outside the active/trialing paid population', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.user_entitlements
  WHERE plan IN ('pro', 'labs_team')
    AND plan_status IN ('active', 'trialing')
    AND NOT ai_model_selection_enabled;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_model_selection: % active/trialing paid entitlement row(s) were not backfilled', v_count;
  END IF;

  -- ── Both tables exist with RLS enabled AND forced, unreachable by anon ──
  FOREACH v_table IN ARRAY v_tables LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity
      INTO v_row
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_table AND c.relkind = 'r';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ai_model_selection: table public.% was not created', v_table;
    END IF;
    IF NOT v_row.relrowsecurity THEN
      RAISE EXCEPTION 'ai_model_selection: RLS is not enabled on public.%', v_table;
    END IF;
    IF NOT v_row.relforcerowsecurity THEN
      RAISE EXCEPTION 'ai_model_selection: RLS is not FORCED on public.%', v_table;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_table,
                           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION 'ai_model_selection: anon holds a privilege on public.%', v_table;
    END IF;
    IF has_table_privilege('service_role', 'public.' || v_table,
                           'SELECT, INSERT, UPDATE, DELETE') THEN
      RAISE EXCEPTION 'ai_model_selection: service_role holds a privilege on public.%', v_table;
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'ai_model_selection: authenticated cannot read public.%', v_table;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || v_table, 'INSERT, UPDATE, DELETE') THEN
      RAISE EXCEPTION 'ai_model_selection: authenticated can write public.% directly', v_table;
    END IF;
  END LOOP;

  -- ── The catalog holds exactly the two approved models, and no credential ──
  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'ai_model_selection: catalog seeded % row(s); expected exactly 2', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, provider, provider_model, display_name, enabled, selectable) IN (
    ('google/gemini-3.5-flash', 'google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', true, true),
    ('google/gemini-3.6-flash', 'google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', true, true)
  );
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'ai_model_selection: the two approved catalog rows are not exactly as specified';
  END IF;

  -- 3.5 must sort before 3.6.
  IF (SELECT sort_order FROM public.ai_model_catalog WHERE id = 'google/gemini-3.5-flash')
     >= (SELECT sort_order FROM public.ai_model_catalog WHERE id = 'google/gemini-3.6-flash') THEN
    RAISE EXCEPTION 'ai_model_selection: catalog sort order does not place 3.5 before 3.6';
  END IF;

  -- ── No preference row was manufactured for anyone ──
  SELECT count(*) INTO v_count FROM public.user_ai_preferences;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_model_selection: migration created % preference row(s); no backfill is permitted', v_count;
  END IF;

  -- ── The three RPCs are SECURITY DEFINER, search_path-pinned, and reachable
  --    by authenticated alone ──
  FOREACH v_fn IN ARRAY v_fns LOOP
    SELECT p.prosecdef AS secdef, p.proconfig AS cfg
      INTO v_row
    FROM pg_proc p
    WHERE p.oid = v_fn::regprocedure;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ai_model_selection: function % was not created', v_fn;
    END IF;
    IF NOT v_row.secdef THEN
      RAISE EXCEPTION 'ai_model_selection: % is not SECURITY DEFINER', v_fn;
    END IF;
    IF v_row.cfg IS NULL OR NOT (v_row.cfg @> ARRAY['search_path=public']) THEN
      RAISE EXCEPTION 'ai_model_selection: % does not pin search_path=public', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'ai_model_selection: authenticated cannot execute %', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'ai_model_selection: anon can execute %', v_fn;
    END IF;
    IF has_function_privilege('service_role', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'ai_model_selection: service_role can execute %', v_fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = v_fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'ai_model_selection: PUBLIC can execute %', v_fn;
    END IF;
  END LOOP;

  -- ── Neither setter takes a user-id parameter (S1 by construction) ──
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid IN ('public.set_current_user_ai_model(text)'::regprocedure,
                    'public.clear_current_user_ai_model()'::regprocedure)
      AND pg_get_function_identity_arguments(p.oid) ILIKE '%uuid%'
  ) THEN
    RAISE EXCEPTION 'ai_model_selection: a preference RPC accepts a caller-supplied uuid';
  END IF;
END
$verify$;
