-- Include `keywords` in the main search and have both search RPCs return
-- per-field match attribution flags so the UI can render an authoritative
-- "Matched in: …" sub-line per row without re-implementing server semantics
-- on the client.
--
-- Why:
--   1. Product decision: the main search bar should also search a paper's
--      curated `keywords` array, alongside title/abstract/authors/journal/
--      notes. Today only those five are searched.
--   2. Client-side derivation of "which fields matched" is unreliable for
--      `abstract` (lazy-loaded — not always in the cache) and would have to
--      re-implement the FTS prefix-tokenization rule perfectly to agree with
--      the server. Returning the flags from the RPC removes both problems.
--
-- What changes:
--   • `papers.search_vector` is rebuilt to include `keywords` at weight C.
--   • `search_papers(...)` and `search_papers_short(...)` are dropped and
--     recreated with new return columns:
--         paper_id, [rank,] matched_title, matched_abstract,
--         matched_authors, matched_journal, matched_notes, matched_keywords
--     For the FTS path, per-field flags are computed by testing each field's
--     `to_tsvector('english', coalesce(field, ''))` against the same
--     prefix-aware tsquery used in the WHERE clause. For the short (ILIKE)
--     path, flags are direct ILIKE / EXISTS-over-jsonb expressions.
--
-- What stays the same:
--   • Sanitization rule and prefix-aware FTS semantics from
--     20260417030000_prefix_search.sql (whitespace split + tsquery-operator
--     blacklist + `:*` per token + `&`-join). Unicode is preserved.
--   • Notes weight D from 20260417020000_add_notes_to_search.sql.
--   • idx_papers_search_vector GIN index — re-created on the rebuilt column.
--   • SECURITY DEFINER and EXECUTE grants to `authenticated`.
--   • The signature change is breaking on return shape only; both RPCs are
--     called from a single hook (`useFilterState`), updated in the same PR.
--
-- Why weight C for keywords:
--   The existing weight ladder is A=primary identifier (title), B=long-form
--   content (abstract), C=structured factual metadata (journal, authors),
--   D=free-form user content (notes). Keywords are short, curated tags —
--   the same character as authors/journal — so C is the natural slot. This
--   keeps title as the dominant rank signal and avoids systematically
--   over-ranking tag-heavy papers. Promoting to B is a reversible follow-up
--   if usage demands it.
--
-- Rollback:
--   Re-run 20260417020000_add_notes_to_search.sql (rebuilds search_vector
--   without keywords, restores the prior search_papers_short return shape)
--   then 20260417030000_prefix_search.sql (restores the prior search_papers
--   body). Note that callers depending on the new flag columns must also
--   be reverted in the same change.

-- ── 1. Rebuild papers.search_vector to include keywords at weight C ──
-- Dropping the generated column auto-drops idx_papers_search_vector; both
-- are re-created below. Postgres regenerates the column for every row when
-- it is re-added (sub-second at current scale, ~400 rows).
ALTER TABLE papers DROP COLUMN IF EXISTS search_vector;

ALTER TABLE papers ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(abstract, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(journal, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(authors::text, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(keywords::text, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(notes, '')), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_papers_search_vector
  ON papers USING GIN(search_vector);

-- ── 2. search_papers (FTS, ≥3 chars) — recreate with attribution flags ──
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

-- ── 3. search_papers_short (ILIKE, 1-2 chars) — recreate with flags ──
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
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION search_papers_short(UUID, TEXT) TO authenticated;
