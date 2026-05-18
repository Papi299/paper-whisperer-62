-- Capture the schema drift on `papers.authors`, `papers.keywords`,
-- `papers.mesh_terms`, and `papers.substances`.
--
-- Production altered these four columns from `text[]` to `jsonb` via the
-- Supabase/Lovable dashboard between the March 2026 RPC wave (which uses
-- `unnest(text[])` semantics) and the April 2026 RPC wave (which uses
-- `jsonb_array_elements_text(jsonb)` / `COALESCE(col, '[]'::jsonb)`
-- semantics). The alter was never committed to the repo, so fresh local
-- replays diverged from production and failed during the April migrations:
--
--   • 20260330010000_add_raw_keywords_column.sql — `UPDATE papers SET
--     raw_keywords = keywords` fails because `keywords` is `text[]` and
--     `raw_keywords` is `jsonb`.
--   • 20260405010000_add_keyword_options_rpc.sql — `LANGUAGE sql`
--     function body fails create-time type-check on
--     `jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb))`.
--   • Other April migrations relying on the same jsonb shape.
--
-- This migration captures that conversion in repo-tracked form. It has
-- two distinct execution paths, gated by an `information_schema.columns`
-- probe on `papers.authors`:
--
--   • FRESH LOCAL REPLAY path (data_type = 'ARRAY'):
--     `papers.authors`/`keywords`/`mesh_terms`/`substances` are still
--     `text[]`. The migration drops the four-field `search_vector` that
--     `20260305020000_add_full_text_search.sql` created (it references
--     `authors`, so the column type cannot be altered while the
--     generated column depends on it), converts the four columns to
--     `jsonb`, then re-adds a four-field `search_vector` that uses the
--     `_jsonb` wrapper for `authors`. The four-field shape is
--     intentionally minimal — later migrations
--     `20260417020000_add_notes_to_search.sql` and
--     `20260420010000_keywords_in_search_with_attribution.sql` rebuild
--     `search_vector` to its final six-field shape later in the chain.
--
--   • PRODUCTION path (data_type = 'jsonb'):
--     The four columns are already `jsonb` (per the Supabase/Lovable
--     dashboard alter). The conversion block is skipped entirely.
--     **The existing six-field `search_vector` is NOT dropped, the
--     generated expression is NOT rewritten, and the GIN index is NOT
--     recreated.** Production's `search_vector` — which references
--     title (A) + abstract (B) + journal (C) + authors (C) + keywords (C)
--     + notes (D) per the post-`20260420010000` shape — stays exactly
--     where it is. The only schema change this migration makes on
--     production is creating the three IMMUTABLE wrapper functions
--     (which production didn't have because `20260305020000` was
--     applied with its pre-wrapper content).
--
-- This split is critical for safety. An earlier draft of this migration
-- (the version originally merged in PR #131) dropped and re-added
-- `search_vector` unconditionally, which would have replaced
-- production's six-field search_vector with a four-field one — silently
-- regressing FTS by losing `keywords` and `notes`. The
-- post-reconciliation deploy plan uses `supabase migration repair
-- --status applied` for the five April ledger-drift versions
-- (`20260417010000`, `20260417020000`, `20260417030000`,
-- `20260420010000`, `20260421010000`) BEFORE pushing this migration, so
-- those migrations' SQL never re-runs on production — meaning the
-- six-field `search_vector` they collectively built has no other
-- migration to rebuild it. The conditional below is what protects it.

-- ── 1. Ensure the IMMUTABLE wrappers exist (idempotent) ──
--
-- These wrappers were introduced in `20260305020000_add_full_text_search.sql`
-- via `CREATE OR REPLACE FUNCTION`. On a fresh LOCAL replay the wrappers
-- already exist by the time this migration runs (CREATE OR REPLACE is a
-- no-op in that case). On PRODUCTION, `20260305020000` was applied with
-- its original content (no wrappers) and Supabase's migration ledger tracks
-- it as applied — so it will NOT be re-run, and the wrappers do NOT exist
-- there. Re-declaring them here makes this migration safe to apply on
-- production: production gets the wrappers at this point in the timeline,
-- local sees the no-op. All three wrappers are present so this migration
-- can stand alone if anyone ever runs it in isolation against a database
-- that doesn't already have them.

CREATE OR REPLACE FUNCTION public.immutable_english_tsvector_text(t text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT to_tsvector('english'::regconfig, COALESCE(t, '')) $$;

CREATE OR REPLACE FUNCTION public.immutable_english_tsvector_textarr(arr text[])
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT to_tsvector('english'::regconfig, COALESCE(arr::text, '')) $$;

CREATE OR REPLACE FUNCTION public.immutable_english_tsvector_jsonb(j jsonb)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT to_tsvector('english'::regconfig, COALESCE(j::text, '')) $$;

-- ── 2. Conditional schema migration ──
--
-- Everything below is inside `DO $$` so that on production (where
-- columns are already `jsonb`) the entire block becomes a no-op — the
-- existing six-field `search_vector` and its GIN index are left
-- untouched. The wrappers above are the only schema change production
-- sees.
--
-- On fresh local replay (where columns are still `text[]` at this point
-- in the chain), the DROP / ALTER TYPE / ADD / CREATE INDEX all run.
-- Subsequent migrations later in the chain rebuild `search_vector` to
-- its final six-field shape.

DO $$
DECLARE
  v_data_type text;
BEGIN
  SELECT data_type INTO v_data_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'papers'
    AND column_name = 'authors';

  IF v_data_type = 'ARRAY' THEN
    -- ── FRESH LOCAL REPLAY PATH ──
    -- columns are still text[]; convert + rebuild search_vector + index.

    -- Drop search_vector (depends on authors via generated expression).
    -- Postgres rejects `ALTER COLUMN ... TYPE jsonb` while a generated
    -- column references that column.
    ALTER TABLE public.papers DROP COLUMN IF EXISTS search_vector;

    -- Convert the four columns to jsonb.
    ALTER TABLE public.papers
      ALTER COLUMN authors    DROP DEFAULT,
      ALTER COLUMN keywords   DROP DEFAULT,
      ALTER COLUMN mesh_terms DROP DEFAULT,
      ALTER COLUMN substances DROP DEFAULT;

    ALTER TABLE public.papers
      ALTER COLUMN authors    TYPE jsonb USING to_jsonb(authors),
      ALTER COLUMN keywords   TYPE jsonb USING to_jsonb(keywords),
      ALTER COLUMN mesh_terms TYPE jsonb USING to_jsonb(mesh_terms),
      ALTER COLUMN substances TYPE jsonb USING to_jsonb(substances);

    ALTER TABLE public.papers
      ALTER COLUMN authors    SET DEFAULT '[]'::jsonb,
      ALTER COLUMN keywords   SET DEFAULT '[]'::jsonb,
      ALTER COLUMN mesh_terms SET DEFAULT '[]'::jsonb,
      ALTER COLUMN substances SET DEFAULT '[]'::jsonb;

    -- Re-add search_vector using the jsonb wrapper for authors. The
    -- four-field shape here is intentional: later migrations
    -- (`20260417020000` adds notes at weight D; `20260420010000` adds
    -- keywords at weight C) rebuild `search_vector` to its final
    -- six-field shape.
    ALTER TABLE public.papers ADD COLUMN search_vector tsvector
      GENERATED ALWAYS AS (
        setweight(immutable_english_tsvector_text(title), 'A') ||
        setweight(immutable_english_tsvector_text(abstract), 'B') ||
        setweight(immutable_english_tsvector_text(journal), 'C') ||
        setweight(immutable_english_tsvector_jsonb(authors), 'C')
      ) STORED;

    -- Recreate the GIN index.
    CREATE INDEX IF NOT EXISTS idx_papers_search_vector
      ON public.papers USING GIN(search_vector);
  END IF;

  -- ── PRODUCTION PATH ──
  -- v_data_type is 'jsonb'; the entire block above is skipped.
  -- search_vector + its GIN index stay exactly as the post-
  -- 20260420010000 six-field form. Only the wrappers above were
  -- created. Net schema delta on production: three new helper
  -- functions in public schema.
END $$;
