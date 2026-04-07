-- Add a lightweight boolean column so the list query can check abstract presence
-- without transferring the full text (~3KB/row).
-- GENERATED ALWAYS AS ... STORED auto-updates on every INSERT/UPDATE to abstract.
ALTER TABLE papers
  ADD COLUMN has_abstract boolean GENERATED ALWAYS AS (abstract IS NOT NULL) STORED;
