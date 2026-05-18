-- Server-side ownership enforcement for the four SECURITY DEFINER RPCs
-- that previously trusted a client-supplied `p_user_id` without verifying
-- it against `auth.uid()`. Production-hardening / defense-in-depth fix.
--
-- Why:
--   Each of these RPCs is SECURITY DEFINER, which bypasses RLS on the
--   tables they read (`papers`, `synonym_pool`). They use `p_user_id` to
--   scope their queries (`WHERE p.user_id = p_user_id`), but did not
--   verify that the caller actually owns that UUID. An authenticated user
--   who knew another user's UUID could call these RPCs and receive paper
--   IDs / match flags / rank / keyword options from another user's
--   library. (The papers' content stays protected by RLS on the table
--   itself, so this was an IDs / existence / metadata leak rather than a
--   content leak, but defense-in-depth requires fixing it.)
--
-- What changes:
--   • `search_papers`              — adds explicit `auth.uid()` guard.
--   • `search_papers_short`        — adds explicit `auth.uid()` guard.
--   • `filter_papers_by_keywords`  — adds explicit `auth.uid()` guard.
--   • `get_keyword_options`        — adds explicit `auth.uid()` guard.
--
-- All four signatures, return shapes, and bodies are otherwise byte-
-- identical to their pre-fix definitions:
--   • search_papers / search_papers_short: prefix-aware FTS tokenization,
--     ILIKE per-field tests, jsonb EXISTS over authors / keywords, and
--     the six `matched_*` attribution columns are unchanged.
--   • filter_papers_by_keywords: synonym map + NOT EXISTS double-negation
--     AND-semantics across keywords / mesh_terms / substances unchanged.
--   • get_keyword_options: CROSS JOIN LATERAL across the three jsonb
--     arrays, DISTINCT, ORDER BY unchanged. Optional filter predicates
--     (`p_paper_ids` / `p_year_from` / `p_year_to` / `p_study_types`)
--     unchanged.
--
-- Guard pattern: mirrors `safe_bulk_insert_papers`'s existing
-- `IF p_user_id <> auth.uid() THEN RAISE EXCEPTION ... END IF;` pattern.
-- A NULL `p_user_id` also raises, so the function never returns rows
-- when the caller's identity cannot be verified.
--
-- Language change: `search_papers_short` and `get_keyword_options` were
-- previously `LANGUAGE sql` (which does not support IF / RAISE). They
-- are recreated as `LANGUAGE plpgsql` with `RETURN QUERY ...` wrapping
-- the original `SELECT` body. Stability declaration (`STABLE`) and
-- `SET search_path = public` are preserved. Return shape and ordering
-- semantics are preserved byte-identically. SECURITY DEFINER is
-- preserved.
--
-- Signatures preserved bit-for-bit, so no client code change is needed
-- and no generated Supabase types need regeneration.
--
-- Rollback: re-run the prior controlling migrations
--   • 20260420010000_keywords_in_search_with_attribution.sql
--     (for search_papers + search_papers_short)
--   • 20260403010000_add_filter_keywords_rpc.sql
--     (for filter_papers_by_keywords)
--   • 20260405010000_add_keyword_options_rpc.sql
--     (for get_keyword_options)

-- ── 1. search_papers (FTS, ≥3 chars) ─────────────────────────────────
DROP FUNCTION IF EXISTS search_papers(UUID, TEXT, INTEGER, INTEGER);

CREATE FUNCTION search_papers(
  p_user_id UUID,
  p_query TEXT,
  p_limit INTEGER DEFAULT 1000,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE(
  paper_id UUID,
  rank REAL,
  matched_title BOOLEAN,
  matched_abstract BOOLEAN,
  matched_authors BOOLEAN,
  matched_journal BOOLEAN,
  matched_notes BOOLEAN,
  matched_keywords BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ts_query_text TEXT;
  v_ts_query      tsquery;
BEGIN
  -- Ownership guard: defense-in-depth on top of RLS. SECURITY DEFINER
  -- bypasses table-level RLS, so we must verify the caller owns the
  -- requested user_id ourselves.
  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  -- Sanitize + tokenize identically to migration 20260417030000:
  -- strip the ten tsquery operator/control characters, whitespace-split,
  -- append :* to each non-empty token, &-join. Unicode passes through.
  SELECT string_agg(tok || ':*', ' & ')
    INTO v_ts_query_text
    FROM (
      SELECT token AS tok
      FROM regexp_split_to_table(
        regexp_replace(
          COALESCE(p_query, ''),
          '[&|!():*<>''"\\]',
          ' ',
          'g'
        ),
        '\s+'
      ) AS t(token)
      WHERE length(token) > 0
    ) s;

  -- Guard: empty / whitespace-only / all-blacklisted input → zero rows.
  IF v_ts_query_text IS NULL OR v_ts_query_text = '' THEN
    RETURN;
  END IF;

  v_ts_query := to_tsquery('english', v_ts_query_text);

  RETURN QUERY
  SELECT
    p.id AS paper_id,
    ts_rank(p.search_vector, v_ts_query) AS rank,
    -- Per-field attribution: each field's own tsvector tested against the
    -- same prefix-aware tsquery. If `search_vector @@ tsq` is true (WHERE
    -- clause), at least one of these will also be true (search_vector is
    -- the union of these per-field weighted tsvectors).
    to_tsvector('english', coalesce(p.title, ''))            @@ v_ts_query AS matched_title,
    to_tsvector('english', coalesce(p.abstract, ''))         @@ v_ts_query AS matched_abstract,
    to_tsvector('english', coalesce(p.authors::text, ''))    @@ v_ts_query AS matched_authors,
    to_tsvector('english', coalesce(p.journal, ''))          @@ v_ts_query AS matched_journal,
    to_tsvector('english', coalesce(p.notes, ''))            @@ v_ts_query AS matched_notes,
    to_tsvector('english', coalesce(p.keywords::text, ''))   @@ v_ts_query AS matched_keywords
  FROM papers p
  WHERE p.user_id = p_user_id
    AND p.search_vector @@ v_ts_query
  ORDER BY rank DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION search_papers(UUID, TEXT, INTEGER, INTEGER) TO authenticated;

-- ── 2. search_papers_short (ILIKE, 1-2 chars; also phrase mode) ──────
-- Converted from LANGUAGE sql to LANGUAGE plpgsql to support the IF /
-- RAISE guard. Return shape, predicates, and per-field flag expressions
-- are byte-identical to the prior definition.
DROP FUNCTION IF EXISTS search_papers_short(UUID, TEXT);

CREATE FUNCTION search_papers_short(
  p_user_id UUID,
  p_query TEXT
)
RETURNS TABLE(
  paper_id UUID,
  matched_title BOOLEAN,
  matched_abstract BOOLEAN,
  matched_authors BOOLEAN,
  matched_journal BOOLEAN,
  matched_notes BOOLEAN,
  matched_keywords BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Ownership guard: defense-in-depth on top of RLS.
  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  RETURN QUERY
  SELECT
    p.id AS paper_id,
    p.title    ILIKE '%' || p_query || '%' AS matched_title,
    p.abstract ILIKE '%' || p_query || '%' AS matched_abstract,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.authors, '[]'::jsonb)) AS a
      WHERE a ILIKE '%' || p_query || '%'
    ) AS matched_authors,
    p.journal  ILIKE '%' || p_query || '%' AS matched_journal,
    p.notes    ILIKE '%' || p_query || '%' AS matched_notes,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb)) AS k
      WHERE k ILIKE '%' || p_query || '%'
    ) AS matched_keywords
  FROM papers p
  WHERE p.user_id = p_user_id
    AND (
      p.title    ILIKE '%' || p_query || '%'
      OR p.journal  ILIKE '%' || p_query || '%'
      OR p.abstract ILIKE '%' || p_query || '%'
      OR p.notes    ILIKE '%' || p_query || '%'
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.authors, '[]'::jsonb)) AS a
        WHERE a ILIKE '%' || p_query || '%'
      )
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb)) AS k
        WHERE k ILIKE '%' || p_query || '%'
      )
    );
END;
$$;

GRANT EXECUTE ON FUNCTION search_papers_short(UUID, TEXT) TO authenticated;

-- ── 3. filter_papers_by_keywords ─────────────────────────────────────
-- Already PL/pgSQL; only the guard is inserted at the top of the body.
-- Synonym map, NOT EXISTS double-negation AND semantics, and the three-
-- column union (keywords / mesh_terms / substances) are unchanged.
DROP FUNCTION IF EXISTS filter_papers_by_keywords(UUID, TEXT[]);

CREATE FUNCTION filter_papers_by_keywords(
  p_user_id UUID,
  p_keywords TEXT[]
)
RETURNS TABLE(paper_id UUID)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Ownership guard: defense-in-depth on top of RLS.
  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  RETURN QUERY
  WITH synonym_map AS (
    -- Build synonym → canonical mapping from user's synonym pool
    SELECT lower(syn) AS synonym, lower(sp.canonical_term) AS canonical
    FROM synonym_pool sp,
    LATERAL unnest(sp.synonyms) AS syn
    WHERE sp.user_id = p_user_id
    UNION ALL
    -- Canonical terms map to themselves
    SELECT lower(sp.canonical_term), lower(sp.canonical_term)
    FROM synonym_pool sp
    WHERE sp.user_id = p_user_id
  )
  SELECT p.id AS paper_id
  FROM papers p
  WHERE p.user_id = p_user_id
  AND NOT EXISTS (
    -- Every selected keyword must be found in at least one column
    SELECT 1 FROM unnest(p_keywords) AS kw
    WHERE NOT (
      -- keywords: already enriched/synonym-normalized at import time
      EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb)) k
        WHERE lower(k) = lower(kw)
      )
      -- mesh_terms: normalize through synonym map at query time
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.mesh_terms, '[]'::jsonb)) m
        LEFT JOIN synonym_map sm ON lower(m) = sm.synonym
        WHERE COALESCE(sm.canonical, lower(m)) = lower(kw)
      )
      -- substances: normalize through synonym map at query time
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.substances, '[]'::jsonb)) s
        LEFT JOIN synonym_map sm ON lower(s) = sm.synonym
        WHERE COALESCE(sm.canonical, lower(s)) = lower(kw)
      )
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION filter_papers_by_keywords(UUID, TEXT[]) TO authenticated;

-- ── 4. get_keyword_options ───────────────────────────────────────────
-- Converted from LANGUAGE sql to LANGUAGE plpgsql to support the IF /
-- RAISE guard. SELECT body, DISTINCT, CROSS JOIN LATERAL across the
-- three jsonb arrays, optional `p_paper_ids` / year-range / study-types
-- filter predicates, and `ORDER BY keyword` are byte-identical.
DROP FUNCTION IF EXISTS get_keyword_options(UUID, UUID[], INT, INT, TEXT[]);

CREATE FUNCTION get_keyword_options(
  p_user_id UUID,
  p_paper_ids UUID[] DEFAULT NULL,
  p_year_from INT DEFAULT NULL,
  p_year_to INT DEFAULT NULL,
  p_study_types TEXT[] DEFAULT NULL
)
RETURNS TABLE(keyword TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Ownership guard: defense-in-depth on top of RLS.
  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  RETURN QUERY
  SELECT DISTINCT term AS keyword
  FROM papers p
  CROSS JOIN LATERAL (
    SELECT jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb)) AS term
    UNION ALL
    SELECT jsonb_array_elements_text(COALESCE(p.mesh_terms, '[]'::jsonb))
    UNION ALL
    SELECT jsonb_array_elements_text(COALESCE(p.substances, '[]'::jsonb))
  ) terms
  WHERE p.user_id = p_user_id
  AND (p_paper_ids IS NULL OR p.id = ANY(p_paper_ids))
  AND (p_year_from IS NULL OR p.year >= p_year_from)
  AND (p_year_to IS NULL OR p.year <= p_year_to)
  AND (p_study_types IS NULL OR p.study_type = ANY(p_study_types))
  ORDER BY keyword;
END;
$$;

GRANT EXECUTE ON FUNCTION get_keyword_options(UUID, UUID[], INT, INT, TEXT[]) TO authenticated;
