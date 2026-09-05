-- ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 — PHASE 1 of 2.
--
-- ⚠ THIS MIGRATION MUST COMMIT, AND THEN A DRAIN MUST BE OBSERVED, BEFORE
--   `20260904120000_add_recoverable_attachment_cleanup_queue.sql` IS APPLIED.
--   The two are NOT safe to run as one uninterrupted operation while merge
--   traffic is possible. `20260904120000` enforces that itself and refuses to
--   run otherwise — see the gate at the top of its section 0. The operational
--   procedure is docs/deployment.md §6.4.
--
--
-- Why a separate phase exists at all
-- ──────────────────────────────────
-- `20260904120000` takes a three-table barrier — `auth.users`, then
-- `public.papers`, then `public.paper_attachments` — and holds it to commit.
-- That order is derived (see that file's section 0) and is provably safe
-- against every writer this schema *will* have. It is NOT safe against a writer
-- this schema currently HAS.
--
-- `merge_exact_duplicates` as deployed today — verified against the live
-- Production catalog, which contains no `LOCK TABLE` statement of any kind —
-- reaches `public.papers` only through `SELECT` (ACCESS SHARE) and foreign-key
-- checks (ROW SHARE), then writes `paper_attachments` (ROW EXCLUSIVE), and only
-- AFTER that issues `DELETE FROM papers` (ROW EXCLUSIVE). Child before parent.
-- Both of the weak parent locks it takes first are compatible with the
-- migration's `SHARE`, so nothing stops the two transactions interleaving into
-- a cycle. Reproduced on PostgreSQL 17.6 against the real tables:
--
--     ERROR:  deadlock detected
--     DETAIL:  Process 325 waits for AccessExclusiveLock on paper_attachments;
--              blocked by process 322.
--              Process 322 waits for RowExclusiveLock on papers;
--              blocked by process 325.
--
-- Process 325 is the migration; 322 is the legacy merge. Postgres chose the
-- MIGRATION as the victim.
--
-- This is not fixable by reordering the barrier. There are now two historical
-- writers with OPPOSITE orders on the same two tables:
--
--   * a stale bundle's direct `DELETE FROM papers` — parent, then child (via
--     its cascade);
--   * this legacy merge — child, then parent.
--
-- A barrier that takes the parent first cycles with the second; one that takes
-- the child first cycles with the first (that is the deadlock CORRECTION-04
-- already proved). Both locks are required — the child lock so no pre-cutover
-- metadata write commits after the revoke, the parent lock so no pre-cutover
-- paper delete does — so there is no one-transaction cutover that is safe
-- against both. Intermediate tables do not rescue it either: `paper_tags` and
-- `paper_projects` are cascade children of `papers` AND are written by the
-- legacy merge before it touches `paper_attachments`, so the two writers
-- disagree about their order too.
--
-- The remaining move is to stop one of the two writers from existing before the
-- cutover runs. That is what this file does, and it is why it must be a
-- SEPARATELY COMMITTED migration: the corrected body below only takes effect
-- for calls that BEGIN after this transaction commits.
--
--
-- Why replacing the function is not, by itself, the drain
-- ──────────────────────────────────────────────────────
-- `CREATE OR REPLACE FUNCTION` does NOT wait for executions already in flight,
-- and an invocation that began under the previous definition runs the previous
-- body to completion. Measured on this PostgreSQL 17.6, with the old call
-- parked mid-body on an advisory lock the test controlled:
--
--   * the replacement returned in 32 ms — it did not block;
--   * the in-flight call then completed with the OLD body;
--   * only a call made afterwards got the new body.
--
-- So this migration creates the boundary; it does not itself prove the boundary
-- has been crossed. `20260904120000` proves that, fail-closed, before it takes
-- a single lock: it refuses to run while ANY client transaction older than its
-- own is open. Every transaction that could still be executing the pre-phase-1
-- body necessarily began before this file committed, and therefore before that
-- one started — so if no such transaction exists, none can be inside the old
-- body. That is the whole drain argument, and it is checked rather than waited
-- out.
--
--
-- What this migration does and does not change
-- ────────────────────────────────────────────
-- It replaces exactly one function, adding exactly one executable statement:
-- `LOCK TABLE public.papers IN ROW EXCLUSIVE MODE`, before the function touches
-- `paper_attachments`. `ROW EXCLUSIVE` is self-compatible and is the lock the
-- function's own `DELETE FROM papers` takes a few statements later anyway, so
-- no ordinary caller is serialized against anything it was not already; all
-- that changes is WHEN the function joins the global order. Merge semantics,
-- signature, `SECURITY DEFINER`, pinned `search_path` and result are identical
-- to `20260817120000_add_structured_author_provenance.sql`, and suites `005`,
-- `009` and `010` are what hold that claim honest rather than review.
--
-- It creates no table, no policy, no grant, no trigger and no index. It does
-- not touch Storage. It does not reference `attachment_cleanup_queue`,
-- `attachment_cleanup_tombstone`, any lifecycle RPC, the cleanup drain or the
-- Storage live-metadata fence — none of which exist yet at this point in the
-- ledger, and none of which this phase introduces.
--
-- Consequently this phase is safe to leave in place indefinitely if
-- `20260904120000` is delayed: the application behaves exactly as before, and
-- the schema is strictly better off, because parent-first also removes a
-- pre-existing hazard between the legacy merge and an ordinary paper deletion,
-- which are opposite-ordered against each other today.
--
-- No barrier is taken here. This transaction acquires exactly the locks its own
-- single `CREATE OR REPLACE` needs, so it cannot deadlock against anything.

BEGIN;

CREATE OR REPLACE FUNCTION public.merge_exact_duplicates(
  p_keep_id uuid,
  p_discard_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_owned   integer;
  v_merged  record;
BEGIN
  -- ══ 1. Validation ════════════════════════════════════════════════════════
  -- Every check runs before the first persistent mutation, so a rejected call
  -- is provably side-effect free. The function is SECURITY DEFINER and its owner
  -- (postgres) holds BYPASSRLS, so these explicit auth.uid() predicates — not
  -- row-level security — are the authorization boundary.

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_keep_id IS NULL THEN
    RAISE EXCEPTION 'Keep paper id is required';
  END IF;

  IF p_discard_ids IS NULL OR cardinality(p_discard_ids) = 0 THEN
    RAISE EXCEPTION 'At least one discard paper id is required';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(p_discard_ids) AS d WHERE d IS NULL) THEN
    RAISE EXCEPTION 'Discard paper ids must not contain NULL';
  END IF;

  -- The keep paper must never be reachable through its own discard list.
  IF p_keep_id = ANY(p_discard_ids) THEN
    RAISE EXCEPTION 'Keep paper cannot also be listed as a discard paper';
  END IF;

  -- Repeated discard ids are malformed input, not a merge instruction: reject
  -- rather than silently normalising, so the caller learns its request was wrong.
  IF cardinality(p_discard_ids) <>
     (SELECT count(DISTINCT d)::integer FROM unnest(p_discard_ids) AS d) THEN
    RAISE EXCEPTION 'Discard paper ids must be unique';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM papers WHERE id = p_keep_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Keep paper not found or access denied';
  END IF;

  -- All-or-nothing: every discard id must resolve to an existing caller-owned
  -- paper. Counting owned rows rejects unknown and foreign ids alike.
  SELECT count(*)::integer INTO v_owned
  FROM papers
  WHERE id = ANY(p_discard_ids) AND user_id = v_user_id;

  IF v_owned <> cardinality(p_discard_ids) THEN
    RAISE EXCEPTION 'One or more discard papers not found or access denied';
  END IF;

  -- ══ 1b. Join the global lock order (added by CORRECTION-04) ══════════════
  -- The ONLY line that differs from the definition in
  -- 20260817120000_add_structured_author_provenance.sql. Everything else below
  -- is that function byte for byte.
  --
  -- This function updates `paper_attachments` (step 4) and only then deletes and
  -- updates `papers` (steps 5-6) — the opposite of the order section 0 of this
  -- migration establishes. Its cutover holds SHARE on `papers` while waiting for
  -- ACCESS EXCLUSIVE on `paper_attachments`, so a merge sitting between steps 4
  -- and 5 would be waiting for the migration on `papers` while the migration
  -- waited for it on `paper_attachments`: a deadlock, in a window of two
  -- adjacent statements. Taking the lock step 5 needs anyway, here, removes the
  -- window rather than making it small.
  --
  -- ROW EXCLUSIVE is self-compatible and is what the DELETE below acquires in
  -- any case, so concurrency between merges, inserts, updates and deletes is
  -- exactly as it was. Only DDL-strength locks — which is to say this migration
  -- — can now see the difference.
  LOCK TABLE public.papers IN ROW EXCLUSIVE MODE;

  -- ══ 2. Capture the merged metadata before anything is deleted ════════════
  WITH keep AS (
    SELECT * FROM papers WHERE id = p_keep_id
  ),
  discard AS (
    SELECT * FROM papers WHERE id = ANY(p_discard_ids)
  ),
  -- Deterministic source order for list metadata: the keep paper first, then
  -- the discards by (created_at, id).
  ordered AS (
    SELECT s.keywords, s.raw_keywords, s.mesh_terms, s.substances,
           row_number() OVER (ORDER BY s.grp, s.created_at, s.id) AS rn
    FROM (
      SELECT 0 AS grp, k.created_at, k.id,
             k.keywords, k.raw_keywords, k.mesh_terms, k.substances
      FROM keep k
      UNION ALL
      SELECT 1, d.created_at, d.id,
             d.keywords, d.raw_keywords, d.mesh_terms, d.substances
      FROM discard d
    ) s
  ),
  -- Unpivot the four list columns, keeping each element's source row (rn) and
  -- its position inside its own JSON array (ord). Anything that is not a JSON
  -- array — including SQL NULL — contributes nothing.
  elems AS (
    SELECT f.field, e.val, o.rn, e.ord
    FROM ordered o
    CROSS JOIN LATERAL (VALUES
      ('keywords'::text,     o.keywords),
      ('raw_keywords'::text, o.raw_keywords),
      ('mesh_terms'::text,   o.mesh_terms),
      ('substances'::text,   o.substances)
    ) AS f(field, arr)
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(f.arr) = 'array' THEN f.arr ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS e(val, ord)
  ),
  -- Exact-value deduplication that retains the first occurrence only.
  firsts AS (
    SELECT DISTINCT ON (field, val) field, val, rn, ord
    FROM elems
    ORDER BY field, val, rn, ord
  ),
  lists AS (
    SELECT
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'keywords'),     '[]'::jsonb) AS keywords,
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'raw_keywords'), '[]'::jsonb) AS raw_keywords,
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'mesh_terms'),   '[]'::jsonb) AS mesh_terms,
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'substances'),   '[]'::jsonb) AS substances
  ),
  -- The single source row that supplies BOTH raw study-type representations:
  -- the keep paper first (grp 0), then the discards by (created_at, id). Rows
  -- with no raw_study_type cannot establish the pair and are not candidates.
  provenance AS (
    SELECT s.raw_study_type, s.raw_publication_types
    FROM (
      SELECT 0 AS grp, k.created_at, k.id, k.raw_study_type, k.raw_publication_types
      FROM keep k
      UNION ALL
      SELECT 1, d.created_at, d.id, d.raw_study_type, d.raw_publication_types
      FROM discard d
    ) s
    WHERE s.raw_study_type IS NOT NULL
    ORDER BY s.grp, s.created_at, s.id
    LIMIT 1
  ),
  -- The single source row that supplies BOTH the authors array and the
  -- structured provenance describing it, under the function's pre-existing
  -- authors rule: the keep paper first (grp 0), then the discards by
  -- (created_at, id), considering only rows with a non-empty authors array.
  -- Selecting the ROW rather than each column independently is what keeps the
  -- names and the structure describing them from coming out of different
  -- records.
  author_source AS (
    SELECT s.authors, s.author_provenance
    FROM (
      SELECT 0 AS grp, k.created_at, k.id, k.authors, k.author_provenance
      FROM keep k
      UNION ALL
      SELECT 1, d.created_at, d.id, d.authors, d.author_provenance
      FROM discard d
    ) s
    WHERE jsonb_typeof(s.authors) = 'array' AND jsonb_array_length(s.authors) > 0
    ORDER BY s.grp, s.created_at, s.id
    LIMIT 1
  )
  SELECT
    -- Scalar metadata: the keep value wins; a NULL keep value is filled from the
    -- earliest discard that has one, ordered by (created_at, id).
    COALESCE(k.abstract,            (SELECT d.abstract            FROM discard d WHERE d.abstract            IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS abstract,
    COALESCE(k.journal,             (SELECT d.journal             FROM discard d WHERE d.journal             IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS journal,
    COALESCE(k.year,                (SELECT d.year                FROM discard d WHERE d.year                IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS year,
    COALESCE(k.pmid,                (SELECT d.pmid                FROM discard d WHERE d.pmid                IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS pmid,
    COALESCE(k.doi,                 (SELECT d.doi                 FROM discard d WHERE d.doi                 IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS doi,
    COALESCE(k.study_type,          (SELECT d.study_type          FROM discard d WHERE d.study_type          IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS study_type,
    COALESCE(k.statistical_methods, (SELECT d.statistical_methods FROM discard d WHERE d.statistical_methods IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS statistical_methods,
    COALESCE(k.pubmed_url,          (SELECT d.pubmed_url          FROM discard d WHERE d.pubmed_url          IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS pubmed_url,
    COALESCE(k.journal_url,         (SELECT d.journal_url         FROM discard d WHERE d.journal_url         IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS journal_url,
    COALESCE(k.drive_url,           (SELECT d.drive_url           FROM discard d WHERE d.drive_url           IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS drive_url,
    COALESCE(k.tldr,                (SELECT d.tldr                FROM discard d WHERE d.tldr                IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS tldr,
    COALESCE(k.notes,               (SELECT d.notes               FROM discard d WHERE d.notes               IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS notes,
    -- Raw study-type provenance, taken whole from one source row so the joined
    -- string and its boundaries always describe the same source statement.
    -- Falling back to the keep row when no row qualifies leaves a legacy keep
    -- paper exactly as it was rather than borrowing a foreign array.
    COALESCE((SELECT p.raw_study_type FROM provenance p), k.raw_study_type) AS raw_study_type,
    CASE
      WHEN EXISTS (SELECT 1 FROM provenance)
        THEN (SELECT p.raw_publication_types FROM provenance p)
      ELSE k.raw_publication_types
    END AS raw_publication_types,
    -- Authors are a whole-value choice, never a union: a non-empty keep author
    -- list is preserved exactly, otherwise the earliest non-empty discard list
    -- is adopted. Identical selection to the previous CASE expression, now
    -- routed through author_source so its provenance travels with it.
    COALESCE((SELECT a.authors FROM author_source a), k.authors) AS authors,
    -- ...and the provenance from that SAME row. NULL there stays NULL here.
    CASE
      WHEN EXISTS (SELECT 1 FROM author_source)
        THEN (SELECT a.author_provenance FROM author_source a)
      ELSE k.author_provenance
    END AS author_provenance,
    l.keywords, l.raw_keywords, l.mesh_terms, l.substances
  INTO v_merged
  FROM keep k CROSS JOIN lists l;

  -- ══ 3. Preserve relationships before the discards disappear ══════════════
  -- Junction rows cascade on delete, so union them onto the keep paper first.
  -- DISTINCT collapses the same assignment held by several discards; ON CONFLICT
  -- collapses an assignment the keep paper already holds.
  INSERT INTO paper_tags (paper_id, tag_id)
  SELECT DISTINCT p_keep_id, pt.tag_id
  FROM paper_tags pt
  WHERE pt.paper_id = ANY(p_discard_ids)
  ON CONFLICT (paper_id, tag_id) DO NOTHING;

  INSERT INTO paper_projects (paper_id, project_id)
  SELECT DISTINCT p_keep_id, pp.project_id
  FROM paper_projects pp
  WHERE pp.paper_id = ANY(p_discard_ids)
  ON CONFLICT (paper_id, project_id) DO NOTHING;

  -- ══ 4. Re-parent attachments so the cascade cannot destroy them ══════════
  -- Only paper_id changes. id, user_id, file_path, file_name, file_type,
  -- size_bytes and created_at are all left untouched, the Storage object is not
  -- addressed at all, and no quota trigger fires.
  UPDATE paper_attachments
  SET paper_id = p_keep_id
  WHERE paper_id = ANY(p_discard_ids);

  -- ══ 5. Delete the discards, releasing their unique identifier values ═════
  DELETE FROM papers
  WHERE id = ANY(p_discard_ids)
    AND user_id = v_user_id;

  -- ══ 6. Apply the captured metadata to the keep paper ═════════════════════
  -- Runs last so an identifier transferred from a discard cannot collide with
  -- the still-live discard row. id, user_id, title, created_at and insert_order
  -- are never assigned; has_abstract and search_vector are generated columns and
  -- update themselves from their sources.
  UPDATE papers SET
    abstract              = v_merged.abstract,
    journal               = v_merged.journal,
    year                  = v_merged.year,
    pmid                  = v_merged.pmid,
    doi                   = v_merged.doi,
    study_type            = v_merged.study_type,
    statistical_methods   = v_merged.statistical_methods,
    pubmed_url            = v_merged.pubmed_url,
    journal_url           = v_merged.journal_url,
    drive_url             = v_merged.drive_url,
    raw_study_type        = v_merged.raw_study_type,
    raw_publication_types = v_merged.raw_publication_types,
    tldr                  = v_merged.tldr,
    notes                 = v_merged.notes,
    authors               = v_merged.authors,
    author_provenance     = v_merged.author_provenance,
    keywords              = v_merged.keywords,
    raw_keywords          = v_merged.raw_keywords,
    mesh_terms            = v_merged.mesh_terms,
    substances            = v_merged.substances,
    updated_at            = now()
  WHERE id = p_keep_id
    AND user_id = v_user_id;
END;
$$;


-- ── Fail-closed verification ────────────────────────────────────────────────
-- Replay must install the parent-first body or refuse to commit. This is the
-- exact property `20260904120000` checks for before it takes its barrier, so a
-- silent regression here would surface there as a refusal rather than as a
-- deadlock in Production.
DO $verify$
DECLARE
  v_src TEXT;
BEGIN
  SELECT pg_get_functiondef('public.merge_exact_duplicates(uuid,uuid[])'::regprocedure)
    INTO v_src;

  IF position('LOCK TABLE public.papers IN ROW EXCLUSIVE MODE' IN v_src) = 0 THEN
    RAISE EXCEPTION
      'merge lock order: merge_exact_duplicates must take LOCK TABLE public.papers IN ROW EXCLUSIVE MODE';
  END IF;

  -- Before the child, not merely somewhere. `UPDATE paper_attachments` is the
  -- function's first write to the child; if the lock does not precede it, the
  -- function still holds the child while asking for the parent.
  IF position('LOCK TABLE public.papers IN ROW EXCLUSIVE MODE' IN v_src)
     > position('UPDATE paper_attachments' IN v_src) THEN
    RAISE EXCEPTION
      'merge lock order: merge_exact_duplicates locks papers AFTER it re-parents paper_attachments — that is the historical order this phase exists to retire';
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_proc p
           WHERE p.oid = 'public.merge_exact_duplicates(uuid,uuid[])'::regprocedure) THEN
    RAISE EXCEPTION 'merge lock order: merge_exact_duplicates must remain SECURITY DEFINER';
  END IF;

  IF NOT (SELECT p.proconfig @> ARRAY['search_path=public'] FROM pg_proc p
           WHERE p.oid = 'public.merge_exact_duplicates(uuid,uuid[])'::regprocedure) THEN
    RAISE EXCEPTION 'merge lock order: merge_exact_duplicates must keep search_path=public pinned';
  END IF;
END
$verify$;

COMMIT;
