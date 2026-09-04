-- ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 — durable, recoverable attachment cleanup.
--
-- The problem this migration exists to solve
-- ──────────────────────────────────────────
-- An attachment lives in two systems that cannot share a transaction: its
-- metadata row in Postgres, and its binary in the private `attachments` Storage
-- bucket. Every deletion path therefore has a window, and until now the window
-- lost information:
--
--   1. the client read `paper_attachments.file_path`,
--   2. Postgres deleted the paper (metadata cascading away with it),
--   3. the client asked Storage to remove the object,
--   4. if step 3 failed, the failure was logged and swallowed.
--
-- After step 2 the ONLY remaining knowledge of that Storage path was a local
-- variable in a browser tab. A refresh, a crash or a closed laptop destroyed it,
-- and the binary survived — unreachable to everyone but its owner, but present —
-- until the user eventually deleted their whole account, at which point the
-- delete-account Edge Function's independent Storage sweep found it.
--
-- The fix is not to make the two systems transactional; they cannot be. It is to
-- make sure Postgres never forgets a path in the same statement that makes the
-- path unreachable. So: **cleanup intent is written, in the same transaction, as
-- the metadata that named the object is removed.** After that commit the intent
-- is durable, retryable and owner-scoped, and physical removal becomes a
-- best-effort operation over recoverable state instead of over a lost variable.
--
-- Upload has the mirror window — the binary lands in Storage before any row
-- describes it — and it needs more than durability, because there the client can
-- be WRONG about what happened. A metadata write whose HTTP response is lost may
-- still commit, and deleting the object on that belief destroys a valid
-- attachment. Section 5 therefore makes the whole upload finalization one
-- server-side, idempotent, serialized decision, so exactly one of "metadata
-- exists" and "cleanup is authorized" can ever be true for a path, and neither
-- the browser nor a concurrent retry ever has to guess which.
--
--
-- What this migration deliberately does NOT do
-- ────────────────────────────────────────────
--   * It does not touch Storage. No function here reads, writes, lists or
--     deletes a `storage.objects` row, and none can: physical removal stays with
--     the authenticated browser session that already holds Storage DELETE on its
--     own prefix. No service-role credential and no elevated endpoint is
--     introduced.
--   * It does not create a scheduler. There is no cron, no pg_cron job, no
--     scheduled Edge Function and no autonomous worker. Retry happens twice:
--     immediately after the user's action, and once when an authenticated
--     application session starts. If the user never returns, the queue row
--     simply waits, and the account-deletion Storage sweep remains the final
--     safety net — which it must, because it enumerates Storage itself and
--     therefore also catches orphans that predate this feature and orphans no
--     queue row ever described.
--   * It does not change quota accounting. `user_storage_usage` stays tied to
--     metadata: the AFTER DELETE refund on `paper_attachments` fires exactly as
--     before, so a queued-but-not-yet-removed object is already refunded while
--     still physically present. Making quota include pending bytes is a separate
--     Product/accounting decision and is not taken here.
--   * It does not weaken Storage RLS. `attachments_owner_read/insert/update/
--     delete` and the private bucket are untouched.
--
--
-- Why the browser may not INSERT into the queue directly
-- ─────────────────────────────────────────────────────
-- A queue row is an instruction to delete a Storage object. If a client could
-- write one, it could write any path it liked and let the next drain execute it.
-- The path prefix would still stop a cross-user deletion, but a user could
-- schedule the destruction of their own live attachments by inserting the paths
-- of files that are perfectly valid. So the table has SELECT-own and DELETE-own
-- policies and no INSERT policy at all: rows appear only through the three
-- SECURITY DEFINER RPCs below, each of which derives the caller from auth.uid(),
-- proves ownership, validates the path, and knows the condition — a logical
-- deletion, or a metadata insert the database itself refused — that makes the
-- object garbage in the first place.
--
-- DELETE-own is the acknowledgement path and is safe to expose: deleting your
-- own queue row only ever means "stop trying to remove this object", which at
-- worst leaves a binary in place — the failure mode this migration already
-- treats as recoverable, and the one account deletion sweeps regardless.


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. attachment_cleanup_queue
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.attachment_cleanup_queue (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    file_path  TEXT NOT NULL,
    reason     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Repeated intent for the same object is the SAME job, not a second one.
    -- Two tabs deleting the same paper, a retried RPC, or a paper delete that
    -- follows a failed upload compensation must all converge on one row.
    CONSTRAINT attachment_cleanup_queue_user_path_unique UNIQUE (user_id, file_path),

    -- A narrow, closed domain. Enumerated as a CHECK rather than an enum type so
    -- adding a case is an ordinary migration rather than a type mutation, and so
    -- an unexpected value fails at write time instead of being interpreted later.
    CONSTRAINT attachment_cleanup_queue_reason_known
        CHECK (reason IN ('attachment_delete', 'paper_delete', 'upload_compensation')),

    -- The path grammar is enforced by the RPCs against auth.uid(); this is the
    -- cheap structural half that holds regardless of which code path wrote it.
    CONSTRAINT attachment_cleanup_queue_file_path_bounded
        CHECK (length(file_path) BETWEEN 1 AND 1024)
);

COMMENT ON TABLE public.attachment_cleanup_queue IS
    'Durable, owner-scoped record of Storage objects whose attachment metadata '
    'has already been deleted and whose binaries therefore should not exist. '
    'Written ONLY by delete_attachment_with_cleanup, '
    'delete_papers_with_attachment_cleanup and finalize_attachment_upload, in '
    'the same transaction as the logical deletion — or the rejected metadata '
    'insert — that made the object unreachable. Drained by the authenticated '
    'browser session, which removes the object through the existing Storage '
    'owner-DELETE policy and then deletes its own row. A row is an intent, not a '
    'guarantee: nothing on the server executes it, and account deletion still '
    'enumerates Storage independently as the final sweep.';

COMMENT ON COLUMN public.attachment_cleanup_queue.file_path IS
    'Full Storage object key in the private attachments bucket, always '
    '<user_id>/<paper_id>/<unique_name>. The first segment is the security '
    'boundary and is re-validated against auth.uid() on write and against the '
    'signed-in user again in the browser before any remove() call.';

COMMENT ON COLUMN public.attachment_cleanup_queue.reason IS
    'Which lifecycle event created the intent: attachment_delete (one attachment '
    'deleted), paper_delete (its paper deleted), upload_compensation (binary '
    'uploaded but metadata was rejected). Operational only — nothing branches '
    'on it at drain time.';

-- The one index the drain actually uses: caller, oldest first, id as the
-- tie-break that makes paging deterministic. The unique constraint above already
-- provides a (user_id, file_path) btree, so no separate user_id index is added.
CREATE INDEX idx_attachment_cleanup_queue_user_created
    ON public.attachment_cleanup_queue (user_id, created_at, id);

ALTER TABLE public.attachment_cleanup_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_cleanup_queue FORCE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own attachment cleanup queue"
    ON public.attachment_cleanup_queue FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Acknowledgement. The drain deletes exactly the rows whose objects Storage has
-- confirmed removed. Scoped to the caller by the policy, and additionally by an
-- explicit user_id predicate on the client side.
CREATE POLICY "Users can acknowledge their own attachment cleanup queue"
    ON public.attachment_cleanup_queue FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- No INSERT policy and no UPDATE policy, deliberately — see the header. A queue
-- row is a deletion instruction; manufacturing or editing one must not be a
-- client capability.

-- Data API grants — explicit and REVOKE-first. The Supabase database template
-- ships `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon, authenticated,
-- service_role` for the migration owner, so without the revoke this table would
-- arrive with INSERT and UPDATE already granted to `authenticated` and with
-- `anon` holding everything — which would defeat the policy design above,
-- because a grant plus a missing policy is a closed door but a grant plus a
-- future policy is not. service_role gets nothing: no Edge Function reads or
-- writes this table, and account deletion's cascade is enforced internally
-- without consulting the deleting role's privileges.
REVOKE ALL ON TABLE public.attachment_cleanup_queue
    FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, DELETE ON TABLE public.attachment_cleanup_queue TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. attachment_cleanup_path_is_safe — one definition of "inside your namespace"
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Three RPCs need the same judgement, and three copies of a security predicate
-- is three chances to fix one and forget the others. SECURITY INVOKER because it
-- reads nothing: it is pure string and uuid logic over its arguments. Not
-- granted to any client role — it is an implementation detail of the RPCs, which
-- run as the owner and therefore reach it without a grant.
--
-- The grammar is the product's real path contract, `<user>/<paper>/<name>`, and
-- the checks below are ordered from cheapest to most specific:
--
--   * bounded length, so a pathological value cannot be persisted;
--   * no backslash — Storage keys use '/' only, and a backslash is the classic
--     way to smuggle a separator past a naive '/'-based check;
--   * no control character, which also excludes NUL and newline;
--   * exactly three segments, none empty (this alone rejects an absolute path,
--     a trailing slash and a '//' collapse, since each produces an empty
--     segment), and none '.' or '..' (traversal);
--   * first segment EXACTLY the caller's own id — the security boundary, and
--     the same rule the Storage RLS policies apply via storage.foldername();
--   * second segment equal to a given paper id when the caller's contract names
--     one (upload compensation), and unconstrained otherwise.
--
-- The second segment is deliberately NOT compared to `paper_attachments.paper_id`
-- on the deletion paths. merge_exact_duplicates re-parents attachment rows onto
-- the kept paper and leaves file_path untouched by design, so a perfectly valid
-- merged attachment legitimately carries a different paper id in its path than
-- in its row. Requiring them to match would make merged attachments undeletable.

CREATE OR REPLACE FUNCTION public.attachment_cleanup_path_is_safe(
    p_user_id   UUID,
    p_file_path TEXT,
    p_paper_id  UUID
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p_user_id IS NOT NULL
     AND p_file_path IS NOT NULL
     AND length(p_file_path) BETWEEN 1 AND 1024
     AND p_file_path !~ '\\'
     AND p_file_path !~ '[[:cntrl:]]'
     AND array_length(string_to_array(p_file_path, '/'), 1) = 3
     AND NOT ('' = ANY (string_to_array(p_file_path, '/')))
     AND NOT ('.' = ANY (string_to_array(p_file_path, '/')))
     AND NOT ('..' = ANY (string_to_array(p_file_path, '/')))
     AND split_part(p_file_path, '/', 1) = p_user_id::text
     AND (p_paper_id IS NULL OR split_part(p_file_path, '/', 2) = p_paper_id::text);
$$;

COMMENT ON FUNCTION public.attachment_cleanup_path_is_safe(UUID, TEXT, UUID) IS
    'Whether a Storage object key is safely inside p_user_id''s attachments '
    'namespace: exactly <user>/<paper>/<name>, no empty/./.. segment, no '
    'backslash, no control character, bounded length, first segment exactly '
    'p_user_id. When p_paper_id is non-null the second segment must equal it. '
    'Pure; reads no table. Internal to the attachment-cleanup RPCs — granted to '
    'no client role.';

REVOKE ALL ON FUNCTION public.attachment_cleanup_path_is_safe(UUID, TEXT, UUID)
    FROM PUBLIC, anon, authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. delete_attachment_with_cleanup(p_attachment_id uuid)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Replaces the old client sequence "remove the Storage object, then delete the
-- metadata row". That ordering never orphaned a binary, but it had the mirror
-- failure: Storage could succeed and the metadata delete fail, leaving a row and
-- its quota charge pointing at a file that no longer exists. Here the whole
-- Postgres side is one transaction and Storage is not involved at all.
--
-- Returns void. The caller does not need the path back: after this commits, the
-- caller's own SELECT-own policy on the queue shows it exactly the work to do,
-- so returning the path would widen the response for no benefit.

CREATE OR REPLACE FUNCTION public.delete_attachment_with_cleanup(
    p_attachment_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_path TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_attachment_id IS NULL THEN
    RAISE EXCEPTION 'Attachment id is required';
  END IF;

  -- Ownership is proven here rather than delegated to RLS: this function is
  -- SECURITY DEFINER, so RLS on paper_attachments does not apply to it.
  -- Requiring BOTH the attachment and its paper to belong to the caller mirrors
  -- the table's own "owner select" policy exactly.
  SELECT a.file_path
    INTO v_path
    FROM public.paper_attachments a
    JOIN public.papers p
      ON p.id = a.paper_id
   WHERE a.id = p_attachment_id
     AND a.user_id = v_uid
     AND p.user_id = v_uid;

  -- One message for "not yours" and "does not exist". Distinguishing them would
  -- turn this into an existence oracle over other accounts' attachment ids.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attachment not found';
  END IF;

  IF NOT public.attachment_cleanup_path_is_safe(v_uid, v_path, NULL) THEN
    -- Fail closed, and say nothing about the path itself. Deleting the metadata
    -- while refusing to record the intent is precisely the information loss this
    -- whole migration exists to prevent, so neither half happens.
    RAISE EXCEPTION 'Attachment path is outside the caller namespace';
  END IF;

  -- Intent first. If this INSERT fails, the DELETE below never runs and the
  -- transaction aborts, so the metadata that names the object survives.
  INSERT INTO public.attachment_cleanup_queue (user_id, file_path, reason)
  VALUES (v_uid, v_path, 'attachment_delete')
  ON CONFLICT (user_id, file_path) DO NOTHING;

  -- The AFTER DELETE refund_storage_quota trigger fires from this statement,
  -- unchanged, inside this same transaction.
  DELETE FROM public.paper_attachments
   WHERE id = p_attachment_id
     AND user_id = v_uid;
END;
$$;

COMMENT ON FUNCTION public.delete_attachment_with_cleanup(UUID) IS
    'Atomically records Storage cleanup intent for one owned attachment and '
    'deletes its metadata row, in a single transaction. Storage is not touched; '
    'physical removal is the authenticated caller''s own subsequent drain of '
    'attachment_cleanup_queue. Rejects unauthenticated callers, unknown or '
    'foreign attachment ids, and any stored path outside the caller namespace.';

REVOKE ALL ON FUNCTION public.delete_attachment_with_cleanup(UUID)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.delete_attachment_with_cleanup(UUID) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. delete_papers_with_attachment_cleanup(p_paper_ids uuid[])
-- ═════════════════════════════════════════════════════════════════════════════
--
-- One function for both the single-paper and the bulk delete; the single-paper
-- caller passes a one-element array. Two implementations of "delete papers and
-- do not lose their attachment paths" would be two places for the ordering to
-- drift.
--
-- The queue rows carry no paper_id and no FK to papers, deliberately. A cleanup
-- intent that cascaded away with the paper it came from would be deleted by the
-- very statement it exists to survive.

CREATE OR REPLACE FUNCTION public.delete_papers_with_attachment_cleanup(
    p_paper_ids UUID[]
)
RETURNS TABLE (deleted_count INTEGER, queued_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_ids      UUID[];
  v_owned    INTEGER;
  v_paths    TEXT[];
  v_path     TEXT;
  v_deleted  INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_paper_ids IS NULL THEN
    RAISE EXCEPTION 'Paper ids are required';
  END IF;
  -- A NULL element is malformed input, not "no paper": silently dropping it
  -- would delete a different set than the caller asked for.
  IF array_position(p_paper_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Paper ids must not contain NULL';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT id), ARRAY[]::UUID[])
    INTO v_ids
    FROM unnest(p_paper_ids) AS id;

  IF cardinality(v_ids) = 0 THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  -- Validate EVERY id before mutating anything. One foreign or unknown id fails
  -- the whole call, so a caller can never produce a partial deletion by mixing
  -- ids it owns with ids it does not.
  SELECT count(*)::INTEGER
    INTO v_owned
    FROM public.papers
   WHERE id = ANY (v_ids)
     AND user_id = v_uid;

  IF v_owned <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'One or more papers do not exist or do not belong to the caller';
  END IF;

  -- Every attachment path these papers would take down with them. Not filtered
  -- by paper_attachments.user_id: a row whose owner somehow differs from the
  -- paper's owner would still cascade away, so its path must still be accounted
  -- for — and the validation below is what decides whether it can be.
  SELECT COALESCE(array_agg(DISTINCT a.file_path), ARRAY[]::TEXT[])
    INTO v_paths
    FROM public.paper_attachments a
   WHERE a.paper_id = ANY (v_ids);

  FOREACH v_path IN ARRAY v_paths LOOP
    IF NOT public.attachment_cleanup_path_is_safe(v_uid, v_path, NULL) THEN
      -- Fail closed for the whole call. Deleting the papers anyway would destroy
      -- the last record of an object this function has just refused to describe.
      RAISE EXCEPTION 'An attachment path is outside the caller namespace';
    END IF;
  END LOOP;

  -- Intent before deletion, same transaction.
  IF cardinality(v_paths) > 0 THEN
    INSERT INTO public.attachment_cleanup_queue (user_id, file_path, reason)
    SELECT v_uid, path, 'paper_delete'
      FROM unnest(v_paths) AS path
    ON CONFLICT (user_id, file_path) DO NOTHING;
  END IF;

  -- paper_attachments cascades from papers; its AFTER DELETE trigger refunds
  -- storage quota exactly as it does today.
  DELETE FROM public.papers
   WHERE id = ANY (v_ids)
     AND user_id = v_uid;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- queued_count is the number of distinct paths whose intent is now durable,
  -- which is what the caller needs to know. An ON CONFLICT skip still means the
  -- intent is recorded, so it counts.
  RETURN QUERY SELECT v_deleted, cardinality(v_paths)::INTEGER;
END;
$$;

COMMENT ON FUNCTION public.delete_papers_with_attachment_cleanup(UUID[]) IS
    'Atomically records Storage cleanup intent for every attachment of the given '
    'owned papers and deletes those papers, in a single transaction. Used by both '
    'single-paper and bulk deletion. Validates all ids before mutating, so a '
    'foreign or unknown id rejects the whole call. Touches no Storage object; '
    'physical removal is the authenticated caller''s own subsequent drain.';

REVOKE ALL ON FUNCTION public.delete_papers_with_attachment_cleanup(UUID[])
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.delete_papers_with_attachment_cleanup(UUID[]) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. finalize_attachment_upload(...) — the linearization point for an upload
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The client uploads the binary to Storage first and records metadata second.
-- That order is not negotiable — Postgres must never hold the bytes — so there
-- is always an instant where an object exists that no row describes.
--
-- The first version of this migration closed that window with a separate
-- compensation RPC: the browser INSERTed metadata directly, and if it saw an
-- error it called a second function that checked whether a committed
-- paper_attachments row named the path, and queued cleanup when none did. That
-- check is correct about a row that has ALREADY committed and useless about one
-- that has not, and the difference is exactly the case it existed to handle:
--
--   T1  the INSERT reaches Postgres and begins; it has not committed.
--   ↯   the browser's HTTP response is lost (aborted request, dropped
--       connection, proxy timeout) and it observes an error.
--   T2  the compensation RPC runs, takes its own snapshot, sees no committed
--       metadata row, and commits a cleanup intent.
--   →   the browser drains the queue and deletes the Storage object.
--   T1  commits.
--
-- The account is now left with a valid, quota-charged attachment row pointing at
-- a binary that has been deleted — the mirror of the orphan this whole migration
-- exists to prevent, and strictly worse, because the user can see the attachment
-- and cannot open it. No number of repeated SELECTs fixes it: a sequential
-- existence check cannot prove that no earlier transaction will commit later.
--
-- So metadata is not written by the client at all on this schema. It is written
-- here, and this function is the only place where either outcome — a metadata
-- row or a cleanup intent for the same path — can be created.
--
--
-- Why that makes the outcome linearizable
-- ───────────────────────────────────────
-- The first thing this function does after validating the caller is take a
-- transaction-scoped advisory lock keyed on (caller, path). Two finalization
-- attempts for the same object therefore cannot overlap: one runs to commit or
-- abort and releases the lock, and only then does the other proceed. Postgres
-- releases transaction advisory locks during commit AFTER the transaction's
-- writes have been made visible to new snapshots, and under READ COMMITTED each
-- statement inside a VOLATILE function takes a fresh snapshot — so the second
-- attempt's first read already sees whatever the first attempt committed.
--
-- That reduces every interleaving to two ordered cases:
--
--   * the earlier attempt committed METADATA — the later one finds it and
--     returns `metadata_present`, queueing nothing;
--   * the earlier attempt committed CLEANUP INTENT — the later one finds it and
--     returns `cleanup_queued`, inserting nothing.
--
-- Metadata and cleanup intent for one path are therefore mutually exclusive, and
-- "cleanup was authorized" can never be followed by a late metadata commit from
-- an attempt that was concurrent with it: there are no concurrent attempts.
--
-- Because the fresh-snapshot half of that argument is an isolation-level
-- property rather than a lock property, the isolation level is asserted rather
-- than assumed. Under REPEATABLE READ or SERIALIZABLE a waiter could hold a
-- snapshot older than the commit it just waited for and reach the opposite
-- decision, so this function refuses to run there. PostgREST uses READ COMMITTED;
-- an environment that does not is a misconfiguration, and failing closed makes
-- it visible instead of silently reopening the race.
--
-- The tombstone trigger in section 6 extends the same exclusion to any INSERT
-- that does not come through here at all, so the invariant is a property of the
-- table rather than of this function's callers.
--
--
-- Idempotency, which is what makes a lost response survivable
-- ──────────────────────────────────────────────────────────
-- Paths are generated fresh per upload attempt and never reused, so "the same
-- path" always means "the same upload". Calling this function again with the
-- same arguments is therefore safe and is the documented recovery for an
-- ambiguous transport failure:
--
--   * the first call committed metadata → the retry returns `metadata_present`
--     with the committed row, and nothing is scheduled for deletion;
--   * the first call committed cleanup intent → the retry returns
--     `cleanup_queued` and refuses to write metadata over a path already
--     declared garbage;
--   * the first call's transaction rolled back entirely → nothing is committed,
--     and the retry finalizes from scratch.
--
-- The browser never has to guess which of the three happened, which is the whole
-- point: guessing is what deleted the file.
--
--
-- Quota
-- ─────
-- The INSERT below fires `trg_paper_attachments_check_storage_quota` exactly as a
-- client INSERT does, because it is an ordinary INSERT on the same table. The
-- trigger's own ownership guard still reads auth.uid(), which SECURITY DEFINER
-- does not change. The INSERT is wrapped in a PL/pgSQL block with an EXCEPTION
-- handler, so a rejection — quota exceeded, a constraint, anything — rolls back
-- the failed row AND the quota the trigger consumed for it, while the enclosing
-- transaction survives to commit the cleanup intent. Quota is consumed exactly
-- once on success and not at all on rejection.

CREATE OR REPLACE FUNCTION public.finalize_attachment_upload(
    p_paper_id   UUID,
    p_file_path  TEXT,
    p_file_name  TEXT,
    p_file_type  TEXT,
    p_size_bytes INTEGER
)
RETURNS TABLE (
    status                TEXT,
    attachment_id         UUID,
    attachment_paper_id   UUID,
    attachment_user_id    UUID,
    attachment_file_path  TEXT,
    attachment_file_name  TEXT,
    attachment_file_type  TEXT,
    attachment_size_bytes INTEGER,
    attachment_created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.paper_attachments%ROWTYPE;
  v_ok  BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_paper_id IS NULL THEN
    RAISE EXCEPTION 'Paper id is required';
  END IF;

  -- The serialization argument above depends on each statement here taking a
  -- fresh snapshot after the lock is granted. Fail closed rather than run the
  -- race under an isolation level that does not provide it.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Attachment finalization requires READ COMMITTED isolation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.papers WHERE id = p_paper_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Paper not found';
  END IF;

  -- The contract names one paper, so the path must be inside that paper's
  -- namespace and not merely inside the caller's.
  IF NOT public.attachment_cleanup_path_is_safe(v_uid, p_file_path, p_paper_id) THEN
    RAISE EXCEPTION 'File path is outside the caller namespace';
  END IF;

  -- ── Serialization point ──────────────────────────────────────────────────
  -- Held to the end of THIS transaction, whichever way it ends. Keyed on the
  -- caller and the path, so unrelated uploads never wait on each other; a hash
  -- collision would only make two unrelated finalizations take turns, which is
  -- slower and never wrong.
  PERFORM pg_advisory_xact_lock(20260904, hashtext(v_uid::text || '/' || p_file_path));

  -- Everything below reads AFTER the lock was granted, so it sees the committed
  -- result of any finalization that held this lock before us.
  SELECT * INTO v_row
    FROM public.paper_attachments
   WHERE user_id = v_uid
     AND file_path = p_file_path;

  IF FOUND THEN
    -- Already a valid attachment. This is the lost-response case that used to
    -- destroy the file: the answer is the committed row, not a cleanup.
    RETURN QUERY SELECT 'metadata_present'::TEXT, v_row.id, v_row.paper_id,
                        v_row.user_id, v_row.file_path, v_row.file_name,
                        v_row.file_type, v_row.size_bytes, v_row.created_at;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.attachment_cleanup_queue
     WHERE user_id = v_uid AND file_path = p_file_path
  ) THEN
    -- The path is already declared garbage. Writing metadata over it would
    -- resurrect an object the drain is entitled to delete at any moment.
    RETURN QUERY SELECT 'cleanup_queued'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID,
                        NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::INTEGER,
                        NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- ── The metadata attempt, in its own subtransaction ──────────────────────
  -- Ownership and path are already proven, so any failure from here is a
  -- rejection of the metadata itself: the binary is garbage and the intent to
  -- remove it must outlive the failure. The subtransaction rollback undoes the
  -- row and the quota the BEFORE INSERT trigger consumed for it; the enclosing
  -- transaction continues and commits the queue row.
  BEGIN
    INSERT INTO public.paper_attachments
      (paper_id, user_id, file_path, file_name, file_type, size_bytes)
    VALUES
      (p_paper_id, v_uid, p_file_path, p_file_name, p_file_type, p_size_bytes)
    RETURNING * INTO v_row;
    v_ok := TRUE;
  EXCEPTION WHEN OTHERS THEN
    -- Deliberately not re-raised and deliberately not reported in detail. The
    -- caller learns the outcome, never the guard text.
    v_ok := FALSE;
  END;

  IF v_ok THEN
    RETURN QUERY SELECT 'metadata_committed'::TEXT, v_row.id, v_row.paper_id,
                        v_row.user_id, v_row.file_path, v_row.file_name,
                        v_row.file_type, v_row.size_bytes, v_row.created_at;
    RETURN;
  END IF;

  INSERT INTO public.attachment_cleanup_queue (user_id, file_path, reason)
  VALUES (v_uid, p_file_path, 'upload_compensation')
  ON CONFLICT (user_id, file_path) DO NOTHING;

  RETURN QUERY SELECT 'cleanup_queued'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID,
                      NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::INTEGER,
                      NULL::TIMESTAMPTZ;
END;
$$;

COMMENT ON FUNCTION public.finalize_attachment_upload(UUID, TEXT, TEXT, TEXT, INTEGER) IS
    'The only way attachment metadata is created on this schema, and the '
    'linearization point for one uploaded Storage object. Takes a '
    'transaction-scoped advisory lock on (auth.uid(), file_path) before reading '
    'anything, so concurrent or repeated finalizations of the same object are '
    'strictly ordered instead of racing. Returns metadata_present with the '
    'committed row when metadata already exists, cleanup_queued when durable '
    'cleanup intent already exists or when the metadata INSERT is rejected (the '
    'rejection and the storage quota it consumed roll back; the intent commits), '
    'and metadata_committed with the new row otherwise. Idempotent: a repeated '
    'call after a lost response reports the durable outcome instead of letting '
    'the client guess. Requires READ COMMITTED. Touches no Storage object.';

REVOKE ALL ON FUNCTION public.finalize_attachment_upload(UUID, TEXT, TEXT, TEXT, INTEGER)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_attachment_upload(UUID, TEXT, TEXT, TEXT, INTEGER) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. The tombstone: metadata may never be written over a queued path
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Section 5 proves that two finalizations of the same object cannot interleave.
-- That is a property of the function, and `authenticated` still holds INSERT on
-- paper_attachments — the pre-migration client path needs it, and a browser tab
-- loaded before the frontend deploy still uses it. Without this trigger the
-- exclusion would hold only for writes that came through finalization.
--
-- So the rule is enforced on the table: while a cleanup intent for a path
-- exists, no metadata row may name that path. A queue row is a standing
-- instruction to delete the object, and any row created over it would describe a
-- file the next drain is entitled to remove.
--
-- Named to sort before trg_paper_attachments_check_storage_quota so a refusal
-- costs no quota accounting at all. SECURITY DEFINER because the check must see
-- the whole queue rather than whatever the inserting role's RLS policy exposes:
-- the same predicate must hold whether the INSERT arrives from finalization
-- (running as the owner) or from a client (running as authenticated).

CREATE OR REPLACE FUNCTION public.reject_attachment_over_cleanup_intent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND NEW.file_path IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.attachment_cleanup_queue
     WHERE user_id = NEW.user_id
       AND file_path = NEW.file_path
  ) THEN
    -- Says nothing about the path. The client that hits this legitimately is
    -- retrying an upload whose cleanup already committed, and the outcome it
    -- needs is "not saved", not the contents of the queue.
    RAISE EXCEPTION 'Attachment path is queued for cleanup';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.reject_attachment_over_cleanup_intent() IS
    'BEFORE INSERT trigger function for paper_attachments. Refuses any metadata '
    'row whose (user_id, file_path) already has a durable cleanup intent, so a '
    'path declared garbage can never be turned back into a valid attachment — '
    'including by an INSERT that did not come through finalize_attachment_upload. '
    'SECURITY DEFINER so the queue is fully visible regardless of the inserting '
    'role; safe search_path.';

DROP TRIGGER IF EXISTS trg_paper_attachments_block_cleanup_intent ON public.paper_attachments;
CREATE TRIGGER trg_paper_attachments_block_cleanup_intent
  BEFORE INSERT ON public.paper_attachments
  FOR EACH ROW EXECUTE FUNCTION public.reject_attachment_over_cleanup_intent();

REVOKE ALL ON FUNCTION public.reject_attachment_over_cleanup_intent()
    FROM PUBLIC, anon, authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. Fail-closed self-verification
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Replay must produce the reviewed posture or refuse to commit. Everything here
-- is a property this migration claims above; a platform default change in either
-- direction fails at replay rather than shipping.

DO $verify$
DECLARE
  v_fn    TEXT;
  v_count INTEGER;
  v_cfg   TEXT[];
BEGIN
  -- ── The table exists with the intended protection ──
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'attachment_cleanup_queue'
       AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup_queue: RLS must be enabled AND forced';
  END IF;

  -- Exactly one SELECT policy and one DELETE policy, and nothing else. An INSERT
  -- or UPDATE policy appearing here would hand clients the ability to
  -- manufacture or rewrite deletion instructions.
  SELECT count(*)::INTEGER INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'attachment_cleanup_queue';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'attachment_cleanup_queue: expected exactly 2 policies, found %', v_count;
  END IF;
  SELECT count(*)::INTEGER INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'attachment_cleanup_queue'
     AND cmd IN ('SELECT', 'DELETE');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'attachment_cleanup_queue: policies must be SELECT and DELETE only';
  END IF;

  -- ── Grants are exactly SELECT+DELETE for authenticated, nothing for anyone else ──
  IF NOT (has_table_privilege('authenticated', 'public.attachment_cleanup_queue', 'SELECT')
      AND has_table_privilege('authenticated', 'public.attachment_cleanup_queue', 'DELETE')) THEN
    RAISE EXCEPTION 'attachment_cleanup_queue: authenticated must hold SELECT and DELETE';
  END IF;
  IF has_table_privilege('authenticated', 'public.attachment_cleanup_queue', 'INSERT')
     OR has_table_privilege('authenticated', 'public.attachment_cleanup_queue', 'UPDATE') THEN
    RAISE EXCEPTION 'attachment_cleanup_queue: authenticated must NOT hold INSERT or UPDATE';
  END IF;
  IF has_table_privilege('anon', 'public.attachment_cleanup_queue', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'attachment_cleanup_queue: anon must hold nothing';
  END IF;
  IF has_table_privilege('service_role', 'public.attachment_cleanup_queue', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'attachment_cleanup_queue: service_role must hold nothing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
     WHERE c.oid = 'public.attachment_cleanup_queue'::regclass AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup_queue: PUBLIC must hold nothing';
  END IF;

  -- ── The account-deletion cascade, and the absence of a paper cascade ──
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.conrelid = 'public.attachment_cleanup_queue'::regclass
       AND c.confrelid = 'auth.users'::regclass
       AND c.confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup_queue: user_id must cascade from auth.users';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.conrelid = 'public.attachment_cleanup_queue'::regclass
       AND c.confrelid IN ('public.papers'::regclass, 'public.paper_attachments'::regclass)
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup_queue: must not reference papers/paper_attachments — the intent must outlive them';
  END IF;

  -- ── The uniqueness that makes repeated intent idempotent ──
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.attachment_cleanup_queue'::regclass
       AND contype = 'u'
       AND conname = 'attachment_cleanup_queue_user_path_unique'
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup_queue: (user_id, file_path) uniqueness is missing';
  END IF;

  -- ── The three client RPCs: definer, pinned path, authenticated-only ──
  FOREACH v_fn IN ARRAY ARRAY[
    'public.delete_attachment_with_cleanup(uuid)',
    'public.delete_papers_with_attachment_cleanup(uuid[])',
    'public.finalize_attachment_upload(uuid,text,text,text,integer)'
  ] LOOP
    SELECT p.proconfig INTO v_cfg FROM pg_proc p WHERE p.oid = v_fn::regprocedure;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'attachment_cleanup: % is not SECURITY DEFINER', v_fn;
    END IF;
    IF v_cfg IS NULL OR NOT (v_cfg @> ARRAY['search_path=public']) THEN
      RAISE EXCEPTION 'attachment_cleanup: % does not pin search_path=public', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'attachment_cleanup: authenticated cannot execute %', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'attachment_cleanup: anon/service_role can execute %', v_fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = v_fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'attachment_cleanup: PUBLIC can execute %', v_fn;
    END IF;
    -- No RPC here may reach the `storage` schema. This is the architectural
    -- claim the whole design rests on, so it is checked rather than reviewed.
    -- It matches a schema QUALIFICATION (`storage.`, bare or quoted) rather than
    -- the bare word, which appears legitimately in prose about the storage quota
    -- and inside identifiers such as `refund_storage_quota`.
    IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = v_fn::regprocedure)
         ~* '(\mstorage[[:space:]]*\.|"storage"[[:space:]]*\.)' THEN
      RAISE EXCEPTION 'attachment_cleanup: % references the storage schema; the RPCs must not touch Storage', v_fn;
    END IF;
  END LOOP;

  -- ── The superseded compensation RPC must not exist ──
  -- Its sequential existence check could not see an in-flight metadata INSERT,
  -- which is the race section 5 exists to remove. Leaving it callable would
  -- leave that race reachable from any client that still knew its name.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'queue_untracked_attachment_cleanup'
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup: queue_untracked_attachment_cleanup must not exist';
  END IF;

  -- ── The tombstone trigger and its function ──
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.paper_attachments'::regclass
       AND tgname = 'trg_paper_attachments_block_cleanup_intent'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup: the cleanup-intent tombstone trigger is missing';
  END IF;
  -- It must fire BEFORE the quota trigger, so a refusal consumes no quota. The
  -- name is what decides that, so the name ordering is asserted rather than
  -- trusted.
  IF NOT ('trg_paper_attachments_block_cleanup_intent'
            < 'trg_paper_attachments_check_storage_quota') THEN
    RAISE EXCEPTION 'attachment_cleanup: the tombstone trigger no longer sorts before the quota trigger';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p
           WHERE p.oid = 'public.reject_attachment_over_cleanup_intent()'::regprocedure) THEN
    RAISE EXCEPTION 'attachment_cleanup: reject_attachment_over_cleanup_intent must be SECURITY DEFINER';
  END IF;
  IF NOT (SELECT p.proconfig FROM pg_proc p
           WHERE p.oid = 'public.reject_attachment_over_cleanup_intent()'::regprocedure)
         @> ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'attachment_cleanup: reject_attachment_over_cleanup_intent does not pin search_path=public';
  END IF;
  IF has_function_privilege('authenticated', 'public.reject_attachment_over_cleanup_intent()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reject_attachment_over_cleanup_intent()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.reject_attachment_over_cleanup_intent()', 'EXECUTE') THEN
    RAISE EXCEPTION 'attachment_cleanup: reject_attachment_over_cleanup_intent must not be directly executable';
  END IF;
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public.reject_attachment_over_cleanup_intent()'::regprocedure)
       ~* '(\mstorage[[:space:]]*\.|"storage"[[:space:]]*\.)' THEN
    RAISE EXCEPTION 'attachment_cleanup: the tombstone trigger references the storage schema';
  END IF;

  -- ── Finalization actually serializes: the lock is taken before it reads ──
  -- Asserted on the source rather than at runtime, because the property that
  -- matters is ordering within the function body, and a reordering that put a
  -- read first would be invisible to any single-connection test.
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public.finalize_attachment_upload(uuid,text,text,text,integer)'::regprocedure)
       !~ 'pg_advisory_xact_lock' THEN
    RAISE EXCEPTION 'attachment_cleanup: finalize_attachment_upload takes no transaction advisory lock';
  END IF;
  IF (SELECT position('pg_advisory_xact_lock' IN p.prosrc)
        FROM pg_proc p
       WHERE p.oid = 'public.finalize_attachment_upload(uuid,text,text,text,integer)'::regprocedure)
     > (SELECT position('FROM public.paper_attachments' IN p.prosrc)
          FROM pg_proc p
         WHERE p.oid = 'public.finalize_attachment_upload(uuid,text,text,text,integer)'::regprocedure) THEN
    RAISE EXCEPTION 'attachment_cleanup: finalize_attachment_upload reads paper_attachments before it serializes';
  END IF;

  -- ── The path helper is internal, pure and pinned ──
  IF (SELECT p.prosecdef FROM pg_proc p
       WHERE p.oid = 'public.attachment_cleanup_path_is_safe(uuid,text,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'attachment_cleanup_path_is_safe must stay SECURITY INVOKER';
  END IF;
  IF NOT (SELECT p.proconfig FROM pg_proc p
           WHERE p.oid = 'public.attachment_cleanup_path_is_safe(uuid,text,uuid)'::regprocedure)
         @> ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION 'attachment_cleanup_path_is_safe does not pin search_path=pg_catalog';
  END IF;
  IF has_function_privilege('authenticated', 'public.attachment_cleanup_path_is_safe(uuid,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.attachment_cleanup_path_is_safe(uuid,text,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.attachment_cleanup_path_is_safe(uuid,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'attachment_cleanup_path_is_safe must not be client-executable';
  END IF;

  -- ── The helper actually refuses what it claims to refuse ──
  IF public.attachment_cleanup_path_is_safe(
       '00000000-0000-0000-0000-00000000000a'::uuid,
       '00000000-0000-0000-0000-00000000000b/p/f.png', NULL) THEN
    RAISE EXCEPTION 'attachment_cleanup_path_is_safe accepted a foreign first segment';
  END IF;
  IF public.attachment_cleanup_path_is_safe(
       '00000000-0000-0000-0000-00000000000a'::uuid,
       '00000000-0000-0000-0000-00000000000a/../f.png', NULL) THEN
    RAISE EXCEPTION 'attachment_cleanup_path_is_safe accepted a traversal segment';
  END IF;
  IF NOT public.attachment_cleanup_path_is_safe(
       '00000000-0000-0000-0000-00000000000a'::uuid,
       '00000000-0000-0000-0000-00000000000a/00000000-0000-0000-0000-00000000000c/f.png', NULL) THEN
    RAISE EXCEPTION 'attachment_cleanup_path_is_safe rejected the canonical product path';
  END IF;

  -- ── The quota subsystem this design depends on is untouched ──
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.paper_attachments'::regclass
       AND tgname = 'trg_paper_attachments_refund_storage_quota'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup: the storage-quota refund trigger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.paper_attachments'::regclass
       AND tgname = 'trg_paper_attachments_check_storage_quota'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup: the storage-quota consume trigger is missing';
  END IF;

  -- ── Storage ownership policies are exactly as they were ──
  SELECT count(*)::INTEGER INTO v_count
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname IN ('attachments_owner_read', 'attachments_owner_insert',
                        'attachments_owner_update', 'attachments_owner_delete');
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'attachment_cleanup: the four attachments Storage owner policies are not all present';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'attachments' AND public) THEN
    RAISE EXCEPTION 'attachment_cleanup: the attachments bucket must stay private';
  END IF;
END
$verify$;
