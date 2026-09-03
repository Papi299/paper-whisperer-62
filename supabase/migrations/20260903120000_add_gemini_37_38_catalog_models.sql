-- AI-MODEL-SELECTION-001D — add Gemini 3.7 Flash and Gemini 3.8 Flash to the
-- server-controlled selectable model catalog.
--
-- This migration does ONE thing: it inserts two reviewed rows into
-- public.ai_model_catalog. That is the entire change, and it is deliberately
-- the entire change, because the catalog IS the allowlist:
--
--   * the 001B runtime (supabase/functions/_shared/aiModelSelection.ts) holds no
--     TypeScript list of model strings. It reads the caller's saved preference,
--     resolves it through this table, requires `enabled` and provider `google`,
--     and puts the row's trimmed `provider_model` verbatim into
--     https://generativelanguage.googleapis.com/v1beta/models/<m>:generateContent.
--   * the 001C Settings control holds no model list either. It renders whatever
--     rows are `enabled AND selectable` and come from a provider the shipped UI
--     can route to (`google`).
--
-- So a reviewed row here — and nothing else — is what makes another supported
-- Google Gemini model selectable and routable. No file under
-- supabase/functions/, src/components/settings/ or src/hooks/ changes for this,
-- and none may: a second allowlist in TypeScript could disagree with this one.
--
-- Provider acceptance (Google first-party documentation, re-read 2026-09-03):
--   * gemini-3.7-flash — stable, released 2026-08-13, structured outputs
--     supported, 1,048,576 in / 65,536 out, no announced shutdown date.
--   * gemini-3.8-flash — stable and Google's newest Flash model, released
--     2026-09-02, structured outputs supported, 1,048,576 in / 65,536 out,
--     thinking levels low/medium/high, no announced shutdown date.
-- Both speak the same `generateContent` contract Paperlume already sends, so no
-- request-body, prompt, parsing, timeout or retry change accompanies this.
--
-- What this migration explicitly does NOT do:
--   * It does NOT change the system default. That remains gemini-3.5-flash,
--     resolved server-side from the GEMINI_MODEL environment configuration
--     (decision C34). The catalog and the default are separate concepts, and a
--     migration is not where the default lives.
--   * It does NOT touch the Gemini 3.5 or Gemini 3.6 rows — not their ids,
--     provider models, display names, flags or sort order. The verify block
--     below proves that positively rather than by omission.
--   * It does NOT touch any user's saved preference. Adding a model to the
--     catalog is additive product metadata; nobody's choice moves because the
--     list got longer. The verify block proves no preference row was written.
--   * It adds NO credential, no secret name and no column. All four models are
--     served by the SAME existing server-side GEMINI_API_KEY.
--   * It changes no grant, policy, RLS setting, function, trigger, index,
--     entitlement, quota or billing value.
--
-- Durable decisions: C33 (the capability and the catalog), C34 (the system
-- default), C35 (these two models).


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The two newly approved rows
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A plain INSERT, with NO `ON CONFLICT` clause of any kind. That is the point:
-- the primary key and the (provider, provider_model) UNIQUE constraint are the
-- drift detector. If either id or either provider model already exists here in
-- some state nobody reviewed, this migration must fail visibly at replay rather
-- than quietly reconcile a row into the shape this file happens to expect —
-- `ON CONFLICT DO UPDATE` would overwrite exactly the evidence worth seeing,
-- and `ON CONFLICT DO NOTHING` would accept conflicting metadata in silence.
--
-- sort_order continues the sparse 10/20 spacing of the 001A seed, so 3.7 and
-- 3.8 append after 3.6 without renumbering a row anyone may already have saved.
INSERT INTO public.ai_model_catalog
    (id, provider, provider_model, display_name, enabled, selectable, sort_order)
VALUES
    ('google/gemini-3.7-flash', 'google', 'gemini-3.7-flash', 'Gemini 3.7 Flash', true, true, 30),
    ('google/gemini-3.8-flash', 'google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', true, true, 40);


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Asserts what this migration claims, in the same transaction that claims it,
-- in the same style as 20260902120000 §7. Two halves: the catalog now holds
-- exactly the four approved models in the approved order, and NOTHING ELSE was
-- written — proven by timestamp rather than by trust, since every row this
-- transaction wrote carries updated_at = now() and every row it did not
-- predates that.
DO $verify$
DECLARE
  v_count INTEGER;
BEGIN
  -- ── Exactly four rows, and exactly the four approved ones ────────────────
  SELECT count(*) INTO v_count FROM public.ai_model_catalog;
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: catalog holds % row(s); expected exactly 4', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order) IN (
    ('google/gemini-3.5-flash', 'google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', true, true, 10),
    ('google/gemini-3.6-flash', 'google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', true, true, 20),
    ('google/gemini-3.7-flash', 'google', 'gemini-3.7-flash', 'Gemini 3.7 Flash', true, true, 30),
    ('google/gemini-3.8-flash', 'google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', true, true, 40)
  );
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: the four approved catalog rows are not exactly as specified';
  END IF;

  -- ── Order is 3.5, 3.6, 3.7, 3.8 — the order the Settings control renders ──
  IF (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog)
     IS DISTINCT FROM ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
                            'google/gemini-3.7-flash','google/gemini-3.8-flash'] THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: catalog order is not 3.5, 3.6, 3.7, 3.8';
  END IF;

  -- ── Nothing in the catalog was written except the two new rows ───────────
  -- Every row this transaction touched carries updated_at = now() (the INSERT
  -- default, or the BEFORE UPDATE trigger). A pre-existing row that came out of
  -- an earlier migration is strictly older. So a non-zero count here is a row
  -- this migration modified and had no business modifying.
  SELECT count(*) INTO v_count
  FROM public.ai_model_catalog
  WHERE updated_at >= now()
    AND id NOT IN ('google/gemini-3.7-flash', 'google/gemini-3.8-flash');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: % pre-existing catalog row(s) were modified', v_count;
  END IF;

  -- ── No user preference was rewritten, cleared or created ─────────────────
  -- The invariant this migration most has to honour: a user who explicitly saved
  -- google/gemini-3.6-flash still has exactly that, and a user who saved nothing
  -- still has nothing.
  SELECT count(*) INTO v_count
  FROM public.user_ai_preferences
  WHERE updated_at >= now();
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: % user preference row(s) were written', v_count;
  END IF;

  -- Corollary, stated separately because it is the mistake worth naming: nobody
  -- was migrated ONTO a newly added model. A preference for 3.7 or 3.8 can only
  -- exist once a user chooses one, which cannot have happened before this
  -- transaction created the rows.
  SELECT count(*) INTO v_count
  FROM public.user_ai_preferences
  WHERE preferred_model_id IN ('google/gemini-3.7-flash', 'google/gemini-3.8-flash');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: % preference row(s) point at a model added by this migration', v_count;
  END IF;

  -- ── No entitlement was granted or revoked ────────────────────────────────
  -- Adding a model changes WHAT an entitled user may pick, never WHO is
  -- entitled. C33's gate is untouched.
  SELECT count(*) INTO v_count
  FROM public.user_entitlements
  WHERE updated_at >= now();
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: % entitlement row(s) were written', v_count;
  END IF;

  -- ── The catalog is still credential-free product metadata ────────────────
  -- The column set is unchanged, so no place to put an API key appeared. 001A
  -- pinned this too; re-asserting it here keeps the claim attached to the
  -- migration that last wrote to the table.
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'ai_model_catalog'
    AND column_name ~* '(key|secret|token|credential|password)';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: the catalog gained a column that could hold credential material';
  END IF;

  -- ── The read-only-to-clients posture is exactly as 001A left it ──────────
  -- Not changed here, and asserted so that a change made anywhere else fails at
  -- replay rather than at runtime.
  IF has_table_privilege('anon', 'public.ai_model_catalog',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: anon holds a privilege on the catalog';
  END IF;
  IF has_table_privilege('service_role', 'public.ai_model_catalog', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: service_role holds a privilege on the catalog';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.ai_model_catalog', 'SELECT') THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: authenticated cannot read the catalog';
  END IF;
  IF has_table_privilege('authenticated', 'public.ai_model_catalog', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ai_model_catalog_001d: authenticated can write the catalog directly';
  END IF;
END
$verify$;
