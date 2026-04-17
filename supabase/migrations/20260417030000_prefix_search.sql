-- Upgrade the papers full-text search RPC to prefix-aware FTS.
--
-- Why:
--   Under websearch_to_tsquery, partial inputs (e.g. "guideli") tokenize into
--   a different lexeme than the fully typed word ("guidelin" from "guideline"),
--   so results vanish mid-typing and reappear only when the whole word is
--   entered. This breaks the user expectation that typing more characters
--   monotonically narrows the result set.
--
-- What changes:
--   `search_papers(p_user_id, p_query, p_limit, p_offset)` now builds a prefix
--   tsquery from the user's input and feeds it to `to_tsquery('english', …)`.
--   Each whitespace-delimited token gets `:*` appended, tokens are &-joined.
--   `guideli:*` matches any lexeme starting with `guideli`, including
--   `guidelin` (from "guideline") — so partial inputs now match correctly.
--
-- What stays the same:
--   Signature, return shape, SECURITY DEFINER, papers.search_vector column,
--   idx_papers_search_vector GIN index, search_papers_short RPC, the
--   length-1-2 ILIKE path, and every frontend surface.
--
-- Deliberately lost features (from websearch_to_tsquery):
--   Quoted-phrase ("exact phrase"), explicit OR, and `-` exclusion. These are
--   not surfaced in the UI and not documented as in use.
--
-- Unicode safety:
--   The sanitizer uses a narrow blacklist of tsquery operator characters
--   (& | ! ( ) : * < > ' " \). Every other character — including all Unicode
--   letters (Latin diacritics, Cyrillic, Greek, Hebrew, Arabic, CJK, etc.),
--   hyphens, underscores, and non-operator punctuation — is preserved as part
--   of the token. Postgres regex character classes match per codepoint, so the
--   blacklist does not accidentally strip multibyte characters.
--
-- Rollback: re-run 20260325000000_raise_search_papers_limit.sql.

CREATE OR REPLACE FUNCTION search_papers(
  p_user_id UUID,
  p_query TEXT,
  p_limit INTEGER DEFAULT 1000,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE(paper_id UUID, rank REAL)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ts_query_text TEXT;
  v_ts_query      tsquery;
BEGIN
  -- 1. Strip tsquery operator / control characters from the user input,
  --    replacing them with a space. Everything else (incl. all Unicode
  --    letters) is preserved.
  -- 2. Split the sanitized string on whitespace.
  -- 3. Keep only non-empty tokens.
  -- 4. Append :* to each token (prefix-match flag).
  -- 5. Join with ' & '.
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

  -- Guard: empty / whitespace-only / all-blacklisted input returns zero rows.
  -- Critical — calling to_tsquery('') raises a syntax error.
  IF v_ts_query_text IS NULL OR v_ts_query_text = '' THEN
    RETURN;
  END IF;

  v_ts_query := to_tsquery('english', v_ts_query_text);

  RETURN QUERY
  SELECT p.id AS paper_id,
         ts_rank(p.search_vector, v_ts_query) AS rank
  FROM papers p
  WHERE p.user_id = p_user_id
    AND p.search_vector @@ v_ts_query
  ORDER BY rank DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;
