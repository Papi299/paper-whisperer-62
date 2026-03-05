-- Index for efficient paginated queries ordered by created_at
CREATE INDEX IF NOT EXISTS idx_papers_user_created
  ON papers (user_id, created_at DESC);
