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
-- All of which is reasoning about a browser that writes attachment metadata
-- directly. Section 6c stops it doing that at all: after this migration the API
-- roles keep SELECT and lose INSERT/UPDATE/DELETE/TRUNCATE, and metadata is
-- created and destroyed only by the three SECURITY DEFINER RPCs here. Section 0
-- is what makes that safe to switch on while a browser is mid-request — a
-- catalog change waits for nobody, so the migration opens with an explicit
-- three-table barrier, `auth.users` then `papers` then `paper_attachments`,
-- held to commit. There is therefore no such thing as a write that was
-- authorized before the cutover and commits after it. Section 0 derives every
-- mode and the order itself; none of the three is a preference.
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
--   * It does not weaken Storage RLS — but it does not leave it byte-identical
--     either, and the difference matters. The `attachments` bucket stays
--     private, and the owner-prefix boundary that scopes every policy to
--     `<uid>/...` is retained exactly as it was.
--     `attachments_owner_read/insert/update` are untouched. The owner DELETE
--     policy is deliberately REPLACED: section 6b re-creates
--     `attachments_owner_delete` with the same owner-prefix boundary PLUS a
--     live-metadata fence, so an owner may still delete their own objects but
--     may no longer delete one that a committed `paper_attachments` row still
--     names. That is a strengthening, and it is the only Storage change here.
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
-- 0. The cutover barrier
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Section 6c below takes attachment metadata DML away from browser clients, and
-- section 6b refuses the deletion of a binary that live metadata names. Both are
-- catalog changes, and a catalog change on its own does NOT wait for anybody:
-- `REVOKE` locks catalog rows, not `paper_attachments`, so it can commit while a
-- pre-migration browser's `INSERT INTO paper_attachments` is still open. That
-- transaction was permission-checked before the revoke and commits happily after
-- it, which reopens the exact ordering this feature exists to close:
--
--   1. an old tab uploads its object and issues a direct metadata INSERT;
--   2. the INSERT reaches Postgres and is still uncommitted;
--   3. this migration commits — grants revoked, Storage fence live;
--   4. the tab loses its HTTP response and runs its old compensation,
--      `storage.remove(file_path)`;
--   5. the fence asks whether live metadata names that object. The INSERT has
--      not committed, so the answer is no, and the delete is permitted;
--   6. the INSERT commits.
--
-- Final state: a committed metadata row, quota charged, binary gone. Every guard
-- was in place and none of them saw anything, because the whole race happens in
-- the gap between "authorized" and "committed".
--
-- The fix is to make that gap empty. An explicit ACCESS EXCLUSIVE lock, taken as
-- the migration's first act and held to commit, gives three properties, and the
-- correction needs all three:
--
--   * it conflicts with ROW EXCLUSIVE, so acquiring it WAITS for every open
--     transaction that has written to this table. Step 2 above cannot still be
--     in flight once this statement returns;
--   * it conflicts with every lock mode, so between acquisition and commit no
--     other session can begin a read or a write here. Nothing can slip in
--     between the barrier and the revoke;
--   * a table lock is always held until the transaction ends, so it is released
--     at exactly the instant the new posture becomes visible. A statement that
--     queued behind it processes the invalidation for this relation as it takes
--     its own lock, so it is planned against the NEW privileges — 42501, not a
--     successful write under the old ones.
--
-- Which is the whole claim: after this migration commits there is no such thing
-- as a pre-cutover direct metadata write that has not already finished.
--
-- ACCESS EXCLUSIVE rather than something narrower. SHARE would be enough to wait
-- out writers, but this migration also runs DDL on the table (an index, a
-- trigger) that needs more, and a lock upgrade mid-transaction is a deadlock
-- shape rather than a simplification. The strongest mode, taken once, up front,
-- is the version whose proof fits in a paragraph — and the probe in
-- scripts/e2e-local.mjs (Case CUT-1) asserts the waiting behaviour on real
-- concurrent sessions rather than assuming it.
--
-- ── The parent table needs the same treatment, for the same reason ────────
-- Section 6d revokes DELETE (and TRUNCATE) on `public.papers`, because a paper
-- deletion cascades its `paper_attachments` rows away and would otherwise remove
-- attachment metadata without ever recording the Storage cleanup intent. That
-- revoke has exactly the problem the one above has: a `DELETE FROM papers` that
-- was permission-checked before the cutover commits happily after it, and the
-- new Storage fence then makes its failure mode WORSE than the old one —
--
--   1. an old tab issues `DELETE FROM papers`; it is still uncommitted;
--   2. this migration commits — the fence is live;
--   3. the tab asks Storage to remove the binaries it read beforehand;
--   4. the fence asks whether live metadata names them. The cascade has not
--      committed, so the rows are still there, and the delete is REFUSED;
--   5. the paper deletion commits, taking the metadata with it.
--
-- The binary is now an orphan that no queue row describes — and without this
-- migration step 4 would have succeeded and left nothing behind. So the parent
-- writers have to be drained too.
--
-- ── Why SHARE on `papers`, and why it is taken FIRST ──────────────────────
-- Two strong locks on two tables is where migrations deadlock, so the mode and
-- the order are both derived rather than chosen.
--
-- The mode has to satisfy two constraints at once:
--
--   * it must conflict with ROW EXCLUSIVE, or it does not drain or block the
--     paper writers this exists for. That leaves SHARE, SHARE ROW EXCLUSIVE,
--     EXCLUSIVE and ACCESS EXCLUSIVE;
--   * it must NOT conflict with ROW SHARE or ACCESS SHARE. Every INSERT into
--     `paper_attachments` takes ROW SHARE on `papers` for its foreign-key check
--     — including the ones a pre-migration tab is still issuing during the
--     cutover — and finalization reads `papers` under ACCESS SHARE. Those
--     sessions hold `paper_attachments` while they do it. If the lock below
--     blocked them, they would be waiting for us on `papers` while we waited for
--     them on `paper_attachments`, which is a deadlock. That rules out EXCLUSIVE
--     and ACCESS EXCLUSIVE.
--
-- SHARE is what is left, and SHARE ROW EXCLUSIVE is the same thing plus a
-- self-conflict that buys nothing here.
--
-- The ORDER is forced by the same reasoning read the other way. If
-- `paper_attachments` were locked first, then while waiting for `papers` we
-- would be holding a lock that blocks the cascade of an in-flight
-- `DELETE FROM papers` — which holds `papers` and needs `paper_attachments` —
-- and that is a cycle we cannot fix, because the transaction on the other side
-- of it is a browser's raw statement. Taking `papers` first inverts it into a
-- cycle whose other side is always OUR code, which can be made to conform.
--
-- ── And the Auth table is upstream of both, so it is locked FIRST ─────────
-- The two tables created below carry `user_id UUID NOT NULL REFERENCES
-- auth.users(id) ON DELETE CASCADE`, and in PostgreSQL **adding a foreign key
-- takes SHARE ROW EXCLUSIVE on the REFERENCED table** — for the inline form in
-- `CREATE TABLE` exactly as for `ALTER TABLE ... ADD CONSTRAINT`, because both
-- go through the same constraint-addition path and both install referential
-- triggers on the parent. Verified directly on the PostgreSQL 17.6 this project
-- runs (local and Production alike): a bare `CREATE TABLE` takes no lock on
-- `auth.users` at all, and the same statement with the FK takes
-- `ShareRowExclusiveLock`.
--
-- So this migration ALWAYS needed a lock on `auth.users`. Before this
-- correction it simply took it late and implicitly, at section 1 — several
-- hundred lines after it had already taken the two barriers below. That is a
-- lock-order inversion, and it deadlocks against an ordinary account deletion:
--
--   * session A (account deletion) issues `DELETE FROM auth.users`. It holds
--     ROW EXCLUSIVE on `auth.users` and its cascade now needs ROW EXCLUSIVE on
--     `papers` and on `paper_attachments` — both of which are direct
--     `ON DELETE CASCADE` children of `auth.users`;
--   * session B (this migration) already holds the two barriers below, reaches
--     section 1, and requests SHARE ROW EXCLUSIVE on `auth.users`.
--
-- B waits for A upstream while A waits for B downstream. Postgres detects it and
-- aborts one of them — observed, not theorised:
--
--     ERROR:  deadlock detected
--     DETAIL:  Process 411 waits for ShareRowExclusiveLock on auth.users;
--              blocked by process 409.
--              Process 409 waits for RowExclusiveLock on paper_attachments;
--              blocked by process 411.
--
-- Fail-safe, but not an acceptable rollout property: a user closing their
-- account should not be able to abort a migration, or be aborted by one. The fix
-- is to take the lock the migration is already going to need BEFORE the locks
-- that stand between an Auth writer and its cascades — so the migration waits
-- upstream, holding nothing, instead of waiting upstream while holding
-- downstream.
--
-- SHARE ROW EXCLUSIVE is the mode, and it is derived the same way as the others:
--
--   * it is exactly what the foreign keys below will require, so acquiring it
--     here is not an extra cost and — crucially — leaves NO later upgrade. A
--     lock upgrade mid-transaction is its own deadlock shape; verified that
--     after this lock is held, creating both FK-bearing tables adds only
--     `AccessShareLock`, nothing stronger;
--   * it conflicts with ROW EXCLUSIVE, so it drains and then excludes Auth row
--     writers — which is what makes the barrier mean anything: once it is
--     granted, no account deletion can be in flight downstream;
--   * it does NOT conflict with ROW SHARE or ACCESS SHARE, so the foreign-key
--     reference checks that ordinary `papers` and `paper_attachments` INSERTs
--     perform against `auth.users` continue throughout. If it blocked those, the
--     barrier would recreate downstream the very cycle it exists to remove.
--
-- ── The global lock order this establishes ────────────────────────────────
--   **`auth.users` before `papers` before `paper_attachments`, for anything
--     that takes a lock on more than one of them that conflicts with ROW
--     EXCLUSIVE.**
--
-- Everything already conforms, or is provably harmless:
--
--   * account deletion (`DELETE FROM auth.users`): `auth.users` ROW EXCLUSIVE,
--     then the cascade's ROW EXCLUSIVE on `papers` and `paper_attachments`.
--     Conforms — and can no longer be caught mid-cascade by this migration,
--     because the migration cannot pass its first lock while such a transaction
--     is open.
--   * signup / Auth user mutation: ROW EXCLUSIVE on `auth.users` and nothing
--     else here. It can be delayed by the first barrier, but it holds nothing
--     downstream, so it can never close a cycle.
--   * `DELETE FROM papers` (any caller): `papers` ROW EXCLUSIVE, then the
--     cascade's ROW EXCLUSIVE on `paper_attachments`. Conforms.
--   * `INSERT INTO papers` / `INSERT INTO paper_attachments`: take their own
--     table first and then need only ROW SHARE on `auth.users` and ROW SHARE /
--     ACCESS SHARE on `papers` for the foreign-key checks — all of which SHARE
--     ROW EXCLUSIVE and SHARE permit. They reach the parents in the opposite
--     order, which is harmless precisely because they can never be BLOCKED
--     there, and a lock that is always granted immediately cannot be an edge in
--     a wait-for cycle.
--   * `finalize_attachment_upload`: same shape as the INSERT above.
--   * `delete_papers_with_attachment_cleanup` and `merge_exact_duplicates` both
--     write `paper_attachments` and then `papers`, which does NOT conform — so
--     each now takes `LOCK TABLE public.papers IN ROW EXCLUSIVE MODE` before it
--     touches `paper_attachments` at all (sections 4 and 4b). ROW EXCLUSIVE is
--     self-compatible and is the lock their own DELETE/UPDATE takes moments
--     later, so ordinary concurrency is unchanged; all it does is fix WHEN they
--     join the order. Neither needs a lock on `auth.users`.
--
-- With that, the proof is two sentences. Once the first barrier is granted, no
-- session is holding a conflicting `auth.users` lock, so no Auth cascade can be
-- in flight downstream of us at all. And while this migration holds SHARE ROW
-- EXCLUSIVE on `auth.users` and SHARE on `papers` and waits for
-- `paper_attachments`, every session that can be holding a `paper_attachments`
-- lock needs at most ROW SHARE on `auth.users` and ROW SHARE or ACCESS SHARE on
-- `papers` — which SHARE ROW EXCLUSIVE and SHARE respectively grant. No cycle
-- can form.
--
-- ── Operational implication, stated because it is real ─────────────────────
-- For the duration of this transaction the migration BLOCKS:
--
--   * all WRITES to `auth.users` — signup and user creation, account deletion,
--     and Auth user mutation including the sign-in timestamp update. Reads of
--     `auth.users`, and the foreign-key reference checks that ordinary
--     application inserts make against it, continue;
--   * all WRITES to `papers` (reads continue);
--   * all ACCESS to `paper_attachments`, reads included.
--
-- And before any of that it WAITS for any in-flight Auth, paper or attachment
-- transaction to finish. Everything it does is catalog-only (no table rewrite,
-- no backfill), so the held window is milliseconds; the wait beforehand is
-- however long the longest such open transaction takes. Deliberately there is no
-- `lock_timeout`: a timeout would turn a correctness barrier into a race the
-- migration sometimes loses, and it is not there to make rollout faster. Apply
-- it the way any DDL is applied — not during a known bulk operation, and
-- accepting that a signup or sign-in arriving in the window waits rather than
-- fails. See docs/deployment.md §6.4.

-- ── Why this file opens a transaction explicitly ──────────────────────────
-- Migration runners do not agree about this. `supabase start` sends a migration
-- file to Postgres as one batch, which Postgres executes as an implicit
-- transaction; `supabase db reset` splits the file and runs each statement in
-- autocommit, where `LOCK TABLE` is not merely useless but an error (25P01,
-- "LOCK TABLE can only be used in transaction blocks"). A barrier that is
-- released at the end of its own statement is not a barrier at all, so the
-- transaction is opened here rather than assumed.
--
-- It also makes an older claim in this file true. The fail-closed verification
-- in section 7 says replay must "produce the reviewed posture or refuse to
-- commit"; under a statement-at-a-time runner its RAISE would abort the run with
-- most of the migration already committed. Inside BEGIN/COMMIT it does what it
-- says: nothing lands unless everything verifies.
--
-- And it is what keeps the two halves of the cutover inseparable. The Storage
-- fence in section 6b and the revoke in section 6c must become visible in the
-- same instant: a fence that is live while clients can still write metadata can
-- be walked past by an uncommitted INSERT, and a revoke that lands before the
-- fence leaves a window where a stale tab's compensation can still delete the
-- binary of a row that committed just before the cutover. Both windows are
-- "milliseconds", and milliseconds is the kind of argument this correction
-- exists to stop making.
BEGIN;

LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.papers IN SHARE MODE;
LOCK TABLE public.paper_attachments IN ACCESS EXCLUSIVE MODE;


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
-- 1b. attachment_cleanup_tombstone — the outcome that outlives the work
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A queue row is WORK: it exists until the object is physically gone, and the
-- drain deletes it the moment Storage confirms. That lifecycle is right for
-- work and wrong for a DECISION.
--
-- Consider an upload whose metadata was rejected:
--
--   1. finalization commits the cleanup intent;
--   2. the drain removes the Storage object;
--   3. the drain acknowledges — the queue row is gone;
--   4. a delayed, duplicated or retried finalization arrives for the same path;
--   5. it finds no metadata and no queue row, so it inserts metadata;
--   6. the account now holds a valid attachment whose binary was deleted in (2).
--
-- Step 4 is not hypothetical: idempotent retry is exactly what the ambiguous-
-- response contract asks the client to do, and nothing bounds how late a
-- duplicated request can arrive. So the fact that a path was finalized AS
-- GARBAGE has to survive the completion of the work it authorised.
--
-- This table is that record, and nothing else. One row per path that
-- finalization refused, written only by `finalize_attachment_upload`, read only
-- by that function and by the BEFORE INSERT trigger in section 6.
--
-- ── Why not just keep the queue row ────────────────────────────────────────
-- Because then "pending physical work" and "completed decision" would be the
-- same row, and the drain would either re-remove already-absent objects forever
-- or need an UPDATE surface the clients must not have. Splitting them keeps the
-- queue exactly what it was — a work list clients may acknowledge — and puts the
-- permanent part somewhere clients cannot touch at all.
--
-- ── Why deletion paths are not tombstoned ──────────────────────────────────
-- The resurrection above needs something to CREATE metadata for the path, and
-- on this schema only finalization can. A path queued by attachment or paper
-- deletion has no upload to replay: its object was already described by metadata
-- that is now gone, and the unique per-upload name is never generated twice. So
-- tombstoning those rows would grow a permanent record of every attachment ever
-- deleted for no invariant at all — a worse privacy posture, bought with nothing.

CREATE TABLE public.attachment_cleanup_tombstone (
    user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    file_path  TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The identity of the decision. Repeated finalization of the same path
    -- converges on one row rather than accumulating.
    PRIMARY KEY (user_id, file_path),

    CONSTRAINT attachment_cleanup_tombstone_file_path_bounded
        CHECK (length(file_path) BETWEEN 1 AND 1024)
);

COMMENT ON TABLE public.attachment_cleanup_tombstone IS
    'Durable record that an uploaded Storage object was finalized as garbage, '
    'kept after the cleanup queue row for it has been acknowledged and deleted. '
    'Written only by finalize_attachment_upload; read by it and by the '
    'paper_attachments BEFORE INSERT guard. It is what stops a delayed or '
    'duplicated finalization from creating attachment metadata for a binary the '
    'drain has already removed. Not a work list: nothing acts on a row here. '
    'Holds a Storage object key and nothing else, and cascades with the account.';

COMMENT ON COLUMN public.attachment_cleanup_tombstone.file_path IS
    'Full Storage object key in the private attachments bucket, always '
    '<user_id>/<paper_id>/<unique_name>, validated against auth.uid() before it '
    'is written. Carries no bibliographic content and no file name beyond what '
    'is already inside the object key.';

ALTER TABLE public.attachment_cleanup_tombstone ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_cleanup_tombstone FORCE ROW LEVEL SECURITY;

-- No policies at all, deliberately: not SELECT, not INSERT, not UPDATE, not
-- DELETE. No client reads this table and no client may write it — it exists to
-- constrain what the server will do, and a row a user could delete would be a
-- row a user could delete in order to resurrect a removed object. The SECURITY
-- DEFINER functions reach it as the owner, which FORCE row security would
-- otherwise stop, so they are the only path in.

REVOKE ALL ON TABLE public.attachment_cleanup_tombstone
    FROM PUBLIC, anon, authenticated, service_role;


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
  v_lock_id  UUID;
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

  -- DISTINCT for correctness, ORDER BY for deadlock freedom: the lock loop below
  -- walks this array, and two concurrent bulk deletes that share papers must
  -- take those locks in the same order or they can wait on each other forever.
  SELECT COALESCE(array_agg(DISTINCT id ORDER BY id), ARRAY[]::UUID[])
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

  -- ── Serialization against upload finalization ────────────────────────────
  --
  -- The snapshot below decides which Storage paths this deletion will record.
  -- Without a lock, an upload finalizing concurrently can commit a new
  -- attachment AFTER the snapshot and BEFORE the paper DELETE, and the cascade
  -- then destroys the only record of its object — the exact orphan this whole
  -- migration exists to prevent, reintroduced through the back door.
  --
  -- The FK to papers does not help: it makes the cascade happen, it does not
  -- make the snapshot current. So both writers take the same per-paper lock, and
  -- one of two things is always true — either finalization committed before this
  -- snapshot (and the path is in it), or finalization is still waiting and
  -- cannot commit until this transaction ends.
  --
  -- Acquired AFTER ownership validation, so a caller can never make the database
  -- take a lock on a paper id it does not own, and in the sorted order
  -- established above.
  FOREACH v_lock_id IN ARRAY v_ids LOOP
    PERFORM pg_advisory_xact_lock(20260905, hashtext(v_lock_id::text));
  END LOOP;

  -- ── Joining the global lock order, before the first child access ─────────
  --
  -- This function writes `paper_attachments` (through the cascade) and `papers`,
  -- and until here it reached them in that order — child first. Section 0
  -- establishes the opposite order for anything holding conflicting locks on
  -- both, because the migration's cutover has to hold `papers` while it waits
  -- for `paper_attachments`, and a transaction going the other way closes the
  -- cycle. Taking the lock the DELETE below will need anyway, now, is what keeps
  -- this function on the right side of that order.
  --
  -- ROW EXCLUSIVE is self-compatible and is exactly what `DELETE FROM papers`
  -- acquires a few statements later, so no ordinary caller is serialized against
  -- anything it was not already serialized against. The only thing that changes
  -- is that this transaction now conflicts with the migration's SHARE from HERE
  -- rather than from the DELETE — early enough that it can never be holding
  -- `paper_attachments` while it waits.
  LOCK TABLE public.papers IN ROW EXCLUSIVE MODE;

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
-- 4b. merge_exact_duplicates — joins the same lock order, and nothing else
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Re-declared here for ONE added statement. This is the only other function in
-- the schema that writes both `paper_attachments` and `papers`, and it writes
-- them child-first, which is the direction section 0's cutover cannot tolerate.
--
-- It is otherwise byte-identical to its definition in
-- `20260817120000_add_structured_author_provenance.sql` — same signature, same
-- SECURITY DEFINER, same pinned `search_path`, same body — and the merge suites
-- (`005`, `009`, `010`) are what hold that claim honest rather than review.
--
-- It is worth being explicit that this function is NOT an attachment-cleanup
-- bypass and never was: step 4 re-parents `paper_attachments` onto the kept
-- paper BEFORE step 5 deletes the discards, so no metadata cascades away and no
-- Storage object is ever left undescribed. `file_path` is not touched, no quota
-- trigger fires, and Storage is not addressed. The change below is about lock
-- ordering at migration time and nothing else.

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
-- Before its first read — after only argument validation and the pure path
-- predicate, neither of which touches a table — this function takes two
-- transaction-scoped advisory locks:
--
--   * one keyed on (caller, path), so two finalization attempts for the same
--     object cannot overlap: one runs to commit or abort and releases the lock,
--     and only then does the other proceed;
--   * one keyed on the target paper, shared with
--     delete_papers_with_attachment_cleanup, which takes it before snapshotting
--     the attachment paths it will queue (see section 4).
--
-- Postgres releases transaction advisory locks during commit AFTER the
-- transaction's writes have been made visible to new snapshots, and under READ
-- COMMITTED each statement inside a VOLATILE function takes a fresh snapshot —
-- so the second attempt's first read already sees whatever the first committed.
--
-- That reduces every interleaving to ordered cases:
--
--   * the earlier attempt committed METADATA — the later one finds it and
--     returns `metadata_present`, queueing nothing;
--   * the earlier attempt committed CLEANUP INTENT, or the path is tombstoned —
--     the later one finds it and returns `cleanup_queued`, inserting nothing;
--   * paper deletion committed first — the paper is gone, this object has no
--     metadata and never will, so it is declared garbage rather than left as an
--     orphan nothing recorded.
--
-- Metadata and cleanup intent for one path are therefore mutually exclusive, and
-- "cleanup was authorized" can never be followed by a late metadata commit from
-- an attempt that was concurrent with it: there are no concurrent attempts. Nor
-- by one arriving long afterwards — that is what section 1b's tombstone is for.
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
--     declared garbage — and keeps refusing after the drain has removed the
--     object and deleted the queue row, because the tombstone in section 1b is
--     what the refusal actually reads;
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
  v_uid   UUID := auth.uid();
  v_row   public.paper_attachments%ROWTYPE;
  v_owner UUID;
  v_ok    BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_paper_id IS NULL THEN
    RAISE EXCEPTION 'Paper id is required';
  END IF;

  -- The serialization argument below depends on each statement taking a fresh
  -- snapshot after the locks are granted. Fail closed rather than run the race
  -- under an isolation level that does not provide it.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Attachment finalization requires READ COMMITTED isolation';
  END IF;

  -- Pure, and therefore safe to run before the locks: it reads no table, only
  -- its own arguments. It also constrains p_paper_id to the paper named INSIDE a
  -- path in the caller's own namespace, so the lock taken below can never be on
  -- a paper id the caller invented out of nothing.
  IF NOT public.attachment_cleanup_path_is_safe(v_uid, p_file_path, p_paper_id) THEN
    RAISE EXCEPTION 'File path is outside the caller namespace';
  END IF;

  -- ── Serialization, in one fixed order everywhere ─────────────────────────
  --
  -- Both locks are transaction-scoped and are taken BEFORE this function's first
  -- read, so every decision below is made on state no concurrent writer can
  -- still be about to change.
  --
  --   1. the PATH lock orders two finalizations of the same object;
  --   2. the PAPER lock orders this finalization against
  --      delete_papers_with_attachment_cleanup, which takes the same lock before
  --      it snapshots the attachment paths it will queue.
  --
  -- The order matters for deadlock freedom: path then paper, always. Paper
  -- deletion takes only paper locks, and in sorted order, so no cycle can form —
  -- deletion never waits on a path lock, and finalization never waits on a
  -- second paper lock.
  PERFORM pg_advisory_xact_lock(20260904, hashtext(v_uid::text || '/' || p_file_path));
  PERFORM pg_advisory_xact_lock(20260905, hashtext(p_paper_id::text));

  -- ── Already a valid attachment? ──────────────────────────────────────────
  -- Checked first, and deliberately so. This is the lost-response case that used
  -- to destroy files, and it is also what protects an attachment whose path
  -- names a paper that no longer exists — merge_exact_duplicates re-parents rows
  -- and leaves file_path alone, so a perfectly valid attachment can point at a
  -- deleted paper id. Reaching the paper check below with such a path would
  -- schedule a live file for deletion; reaching this check first cannot.
  SELECT * INTO v_row
    FROM public.paper_attachments
   WHERE user_id = v_uid
     AND file_path = p_file_path;

  IF FOUND THEN
    RETURN QUERY SELECT 'metadata_present'::TEXT, v_row.id, v_row.paper_id,
                        v_row.user_id, v_row.file_path, v_row.file_name,
                        v_row.file_type, v_row.size_bytes, v_row.created_at;
    RETURN;
  END IF;

  -- ── Already finalized as garbage? ────────────────────────────────────────
  -- The tombstone outlives the queue row, so this answer stays correct after the
  -- drain has removed the object and acknowledged its work. The queue is checked
  -- too: it is the same answer by a shorter route while the work is pending, and
  -- it also covers a path queued by attachment or paper deletion.
  IF EXISTS (
    SELECT 1 FROM public.attachment_cleanup_tombstone
     WHERE user_id = v_uid AND file_path = p_file_path
  ) OR EXISTS (
    SELECT 1 FROM public.attachment_cleanup_queue
     WHERE user_id = v_uid AND file_path = p_file_path
  ) THEN
    RETURN QUERY SELECT 'cleanup_queued'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID,
                        NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::INTEGER,
                        NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- ── The target paper, read under the lock ────────────────────────────────
  SELECT p.user_id INTO v_owner FROM public.papers p WHERE p.id = p_paper_id;

  IF FOUND AND v_owner <> v_uid THEN
    -- A paper can vanish concurrently; it can never change owner. So "exists and
    -- belongs to someone else" is unambiguously a bad request, not a race, and
    -- is refused rather than quietly turned into a cleanup.
    RAISE EXCEPTION 'Paper not found';
  END IF;

  IF NOT FOUND THEN
    -- The paper is gone. Either it was deleted before this call, or paper
    -- deletion won the lock and has already committed — and in that case its own
    -- snapshot could not have included this object, because this object has no
    -- metadata (checked above). Raising here would abort the transaction and
    -- leave the uploaded binary with nothing recorded anywhere: an orphan
    -- created by the very function that exists to prevent them. So the object is
    -- declared garbage, durably, and the drain removes it.
    INSERT INTO public.attachment_cleanup_queue (user_id, file_path, reason)
    VALUES (v_uid, p_file_path, 'upload_compensation')
    ON CONFLICT (user_id, file_path) DO NOTHING;
    INSERT INTO public.attachment_cleanup_tombstone (user_id, file_path)
    VALUES (v_uid, p_file_path)
    ON CONFLICT (user_id, file_path) DO NOTHING;

    RETURN QUERY SELECT 'cleanup_queued'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID,
                        NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::INTEGER,
                        NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- ── The metadata attempt, in its own subtransaction ──────────────────────
  -- Ownership and path are proven, so any failure from here is a rejection of
  -- the metadata itself: the binary is garbage and the intent to remove it must
  -- outlive the failure. The subtransaction rollback undoes the row and the
  -- quota the BEFORE INSERT trigger consumed for it; the enclosing transaction
  -- continues and commits the queue row and the tombstone.
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
  -- The decision, kept after the work it authorises has been done and
  -- acknowledged. Without this row a duplicated finalization arriving after the
  -- drain would find nothing and create metadata for a deleted binary.
  INSERT INTO public.attachment_cleanup_tombstone (user_id, file_path)
  VALUES (v_uid, p_file_path)
  ON CONFLICT (user_id, file_path) DO NOTHING;

  RETURN QUERY SELECT 'cleanup_queued'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID,
                      NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::INTEGER,
                      NULL::TIMESTAMPTZ;
END;
$$;

COMMENT ON FUNCTION public.finalize_attachment_upload(UUID, TEXT, TEXT, TEXT, INTEGER) IS
    'The only way attachment metadata is created on this schema, and the '
    'linearization point for one uploaded Storage object. Takes two '
    'transaction-scoped advisory locks before its first read — on '
    '(auth.uid(), file_path), which orders repeated finalizations of the same '
    'object, and on the target paper id, which orders it against '
    'delete_papers_with_attachment_cleanup so a paper cascade cannot destroy an '
    'attachment whose path it never queued. Returns metadata_present with the '
    'committed row when metadata already exists, cleanup_queued when the path is '
    'already tombstoned or queued, when the target paper no longer exists, or '
    'when the metadata INSERT is rejected (the rejection and the storage quota it '
    'consumed roll back; the intent and its tombstone commit), and '
    'metadata_committed with the new row otherwise. Idempotent, and durably so: '
    'the tombstone outlives the queue row, so a repeated call after the drain has '
    'removed and acknowledged the object still reports cleanup rather than '
    'creating metadata for a deleted binary. Requires READ COMMITTED. Touches no '
    'Storage object.';

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
  IF NEW.user_id IS NOT NULL AND NEW.file_path IS NOT NULL AND (EXISTS (
    SELECT 1 FROM public.attachment_cleanup_queue
     WHERE user_id = NEW.user_id
       AND file_path = NEW.file_path
  ) OR EXISTS (
    -- The permanent half. A queue row disappears the moment the drain finishes;
    -- the tombstone does not, so a path finalized as garbage stays unusable for
    -- metadata even after its object is long gone.
    SELECT 1 FROM public.attachment_cleanup_tombstone
     WHERE user_id = NEW.user_id
       AND file_path = NEW.file_path
  )) THEN
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
    'row whose (user_id, file_path) has a pending cleanup intent OR a permanent '
    'cleanup tombstone, so a path declared garbage can never be turned back into '
    'a valid attachment — including by an INSERT that did not come through '
    'finalize_attachment_upload, and including long after the object was removed '
    'and its queue row acknowledged. SECURITY DEFINER so both tables are fully '
    'visible regardless of the inserting role; safe search_path.';

DROP TRIGGER IF EXISTS trg_paper_attachments_block_cleanup_intent ON public.paper_attachments;
CREATE TRIGGER trg_paper_attachments_block_cleanup_intent
  BEFORE INSERT ON public.paper_attachments
  FOR EACH ROW EXECUTE FUNCTION public.reject_attachment_over_cleanup_intent();

REVOKE ALL ON FUNCTION public.reject_attachment_over_cleanup_intent()
    FROM PUBLIC, anon, authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 6b. The Storage fence — a live attachment's binary cannot be deleted
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Everything above constrains what the CORRECTED client does. It does not
-- constrain a browser tab that loaded the old bundle before this migration was
-- applied and is still running, and that tab can still perform the two orderings
-- this whole feature exists to retire:
--
--   * upload → metadata INSERT → response lost → `remove()` the object, which
--     deletes the binary of a metadata row that did commit;
--   * attachment delete → `remove()` the object FIRST → metadata DELETE fails →
--     a row and its quota charge pointing at a file that is gone.
--
-- Both end the same way: a `paper_attachments` row naming an object that no
-- longer exists. Neither is reachable from the new client, and neither can be
-- fixed by shipping more client code, because the client at fault has already
-- been shipped. So the rule is enforced where the destruction actually happens.
--
-- **While a metadata row names an object, its owner may not delete that object.**
--
-- That single condition makes every legitimate path work and both stale-client
-- paths fail safely:
--
--   * durable deletion — `delete_attachment_with_cleanup` and
--     `delete_papers_with_attachment_cleanup` remove the metadata inside the
--     transaction that queues the path, so by the time the drain runs there is
--     no row to block it. Allowed.
--   * upload compensation — the metadata was rejected, so no row exists.
--     Allowed.
--   * pre-migration paper deletion — metadata cascades away with the paper
--     before the client removes the objects. Allowed.
--   * a stale tab's lost-response compensation — the row DID commit, so the
--     delete is refused and the file survives as the valid attachment it is.
--   * a stale tab's Storage-first attachment delete — the row is still there, so
--     the delete is refused before the binary is destroyed, and that client's own
--     error handling then leaves the metadata alone too. Both halves survive.
--
-- Account deletion is unaffected: it runs with the elevated service role, which
-- bypasses row-level security entirely, and it must — it enumerates Storage
-- itself precisely so it can find objects no metadata row describes.
--
-- ── Rollout consequence, stated because it is real ─────────────────────────
-- This makes web-first ordering the RIGHT order rather than merely a safe one.
-- If the migration were applied before the frontend deploy, the old bundle's
-- attachment deletion would start failing at the Storage call — safe, but
-- visibly broken until the new bundle loads. See docs/deployment.md §6.4.

-- The lookup the fence performs on every attachment-object DELETE, and the
-- lookup finalization and the tombstone trigger perform on every upload. There
-- was no index on this pair; without one the fence would turn each delete into a
-- sequential scan of the owner's attachments.
CREATE INDEX idx_paper_attachments_user_file_path
    ON public.paper_attachments (user_id, file_path);

-- SECURITY DEFINER on purpose. A policy predicate that read `paper_attachments`
-- directly would be filtered by that table's own RLS, which additionally
-- requires the attachment's PAPER to be owned by the caller — so a row that was
-- invisible for any reason would read as "no metadata" and open the fence. A
-- security fence must not depend on the reader's view.
--
-- It takes no user id and derives the caller from auth.uid(), so it can only
-- ever answer about the caller's own namespace and is safe to grant. STABLE, not
-- IMMUTABLE: it reads a table.
CREATE OR REPLACE FUNCTION public.attachment_object_has_live_metadata(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.paper_attachments a
     WHERE a.user_id = auth.uid()
       AND a.file_path = p_name
  );
$$;

COMMENT ON FUNCTION public.attachment_object_has_live_metadata(TEXT) IS
    'Whether a live paper_attachments row of the CALLER''s belongs to this exact '
    'Storage object key. Used by the attachments_owner_delete Storage policy to '
    'refuse deletion of a binary a metadata row still names, which is what makes '
    'a pre-migration browser tab unable to recreate either historical destructive '
    'ordering after this migration is applied. Derives the caller from auth.uid() '
    'and takes no user id, so it can only answer about the caller''s own '
    'namespace. SECURITY DEFINER so the fence sees all metadata rather than what '
    'the caller''s RLS exposes.';

REVOKE ALL ON FUNCTION public.attachment_object_has_live_metadata(TEXT)
    FROM PUBLIC, anon, service_role;
-- The policy below is evaluated as the requesting role, so that role must be
-- able to execute the predicate.
GRANT EXECUTE ON FUNCTION public.attachment_object_has_live_metadata(TEXT) TO authenticated;

-- Replaces the policy from 20260318020000. The owner-prefix boundary is
-- preserved EXACTLY as it was — this adds a condition, it does not relax one —
-- and the policy keeps its name so the four-owner-policy inventory is unchanged.
DROP POLICY IF EXISTS "attachments_owner_delete" ON storage.objects;
CREATE POLICY "attachments_owner_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'attachments'
    AND auth.uid()::text = (storage.foldername(name))[1]
    AND NOT public.attachment_object_has_live_metadata(name)
  );


-- ═════════════════════════════════════════════════════════════════════════════
-- 6c. The lifecycle boundary — clients stop writing attachment metadata
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Everything above is reasoning about WHICH of two systems to trust when a
-- browser and the database disagree. That reasoning only has to happen because
-- the browser is allowed to write attachment metadata directly. It isn't, after
-- this.
--
-- The post-migration client contract:
--
--   SELECT  — unchanged. The UI reads its own attachments, and the account
--             export reads them, through the same RLS that has always applied.
--   INSERT  — closed. Metadata is created by `finalize_attachment_upload` only.
--   DELETE  — closed. Metadata is removed by `delete_attachment_with_cleanup`,
--             by `delete_papers_with_attachment_cleanup`, by the cascade those
--             two initiate, or by account deletion.
--   UPDATE  — closed. It was already unreachable — this table has no UPDATE
--             policy and never has — but Production carries the old
--             platform-default ACL that granted the API roles everything, so the
--             privilege is revoked rather than left standing on a technicality.
--
-- TRUNCATE is revoked with them, and for a sharper reason than tidiness: it
-- removes every row without firing a row trigger and without consulting RLS, so
-- a role holding it could empty this table without refunding a byte of quota or
-- recording one path of cleanup intent. It is the one privilege that could make
-- the invariant below false in a single statement.
--
-- What that buys is a Product invariant enforced by the database rather than by
-- the current React bundle:
--
--   **Postgres never removes ordinary user attachment metadata without
--     recording the Storage cleanup intent in the same transaction.**
--
-- and its upload mirror: a metadata row can only come into existence through the
-- serialized, tombstone-aware, quota-rolling-back decision in section 5. A
-- hand-written Data API request from a stale bundle — or from anywhere else —
-- gets 42501 before RLS is even consulted.
--
-- ── What this does NOT change ──────────────────────────────────────────────
--   * The three RPCs are SECURITY DEFINER and execute as this migration's owner,
--     which owns the table. They do not consult the caller's table grants and
--     are unaffected. Section 7 asserts they still work.
--   * `service_role` keeps its grants. Nothing in this repository writes this
--     table with the service role today — `delete-account` enumerates Storage
--     itself and then deletes the auth user, letting the FK cascade take the
--     metadata — but that cascade and any future privileged repair are exactly
--     what a server role is for, and narrowing it proves nothing here.
--   * The `owner insert` / `owner delete` RLS policies stay. They are dead for
--     `authenticated` now that the grant is gone, and that is the point of
--     defense in depth: if a privilege is ever re-granted by accident, the
--     ownership predicate is still standing underneath it.
--   * REFERENCES, TRIGGER and MAINTAIN are untouched — the platform default
--     grants that trio on every new public table, and Production's legacy
--     blanket ACL grants them too. None of the three can create or remove a row,
--     and TRIGGER is inert here besides: neither `anon` nor `authenticated`
--     holds CREATE on schema `public`, so neither can define the function a
--     trigger would need. Normalising that trio across every table is a
--     repository-wide posture question and not this migration's to settle.
--
-- ── This is a deliberate narrowing of 20260731162729 ───────────────────────
-- `20260731162729_reconcile_data_api_grants.sql` granted `authenticated`
-- SELECT/INSERT/DELETE here, correctly, because that was the client contract at
-- the time. This migration overrides that decision for this ONE table because
-- the contract changed: the operations it granted now exist as RPCs that do
-- strictly more (serialize, validate, record intent, roll back quota). Every
-- other grant in that migration stands.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.paper_attachments
    FROM PUBLIC, anon, authenticated;

-- Restated rather than assumed. The line above must never be able to take the
-- read path with it, and a replay that somehow arrives without it fails in
-- section 7 rather than shipping an unreadable attachment list.
GRANT SELECT ON TABLE public.paper_attachments TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 6d. The parent boundary — a paper cannot be deleted around the lifecycle
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Section 6c closed direct DML on `paper_attachments`. Attachment metadata has a
-- second door, and it is the one it was born with: `paper_attachments.paper_id`
-- is `ON DELETE CASCADE` from `papers`, so deleting the parent deletes the child
-- without any statement ever naming the child. A client that still holds DELETE
-- on `papers` can therefore still do this:
--
--   1. read the attachment paths;
--   2. `DELETE FROM papers` directly;
--   3. the metadata cascades away — no queue row, no tombstone, nothing;
--   4. ask Storage to remove the binaries;
--   5. that call fails;
--   6. the binaries are orphans nothing describes, until account deletion.
--
-- Which is precisely the failure this migration exists to end, reached through
-- the parent instead of the child. Closing one door and leaving the other open
-- would make the invariant a statement about which table a caller happens to
-- name, rather than about what the database permits.
--
-- So the same treatment:
--
--   SELECT / INSERT / UPDATE — unchanged. Creating, reading and editing papers
--     are ordinary product operations with nothing to do with this feature, and
--     narrowing them is not on the table.
--   DELETE — closed. Paper deletion goes through
--     `delete_papers_with_attachment_cleanup`, which validates every id against
--     `auth.uid()`, serializes against finalization, snapshots every attachment
--     path, records the cleanup intent, and only then deletes — so the cascade
--     can never outrun the record of what it is about to strand.
--   TRUNCATE — closed, and not as tidiness. `TRUNCATE` removes every row without
--     firing row triggers and without consulting RLS: one statement that could
--     empty this table, cascade every attachment away, refund no quota and
--     record no intent. The local platform default grants it to `anon` here
--     (`anon=Dxtm` on `papers`), which is worth stating plainly rather than
--     leaving in an ACL nobody reads.
--
-- The invariant this completes:
--
--   **Postgres never removes ordinary user attachment metadata — directly or by
--     cascade — without recording the Storage cleanup intent in the same
--     transaction.**
--
-- ── What still deletes papers, and why each is safe ───────────────────────
--   * `delete_papers_with_attachment_cleanup` — the lifecycle path. SECURITY
--     DEFINER, so unaffected by this revoke.
--   * `merge_exact_duplicates` — SECURITY DEFINER. It re-parents attachment rows
--     onto the kept paper BEFORE deleting the discards, so nothing cascades and
--     no object is stranded. Not a bypass; see section 4b.
--   * account deletion — `delete-account` deletes the auth user and lets the
--     cascade run. Attachment metadata going away there is the point, and its
--     independent Storage sweep is what actually removes the binaries. It runs
--     with the elevated role and is unaffected.
--   * nothing else. Every function in this schema whose body deletes `papers` is
--     one of the two above, and section 7 does not attempt to police that —
--     `supabase/tests/database/003` holds the exhaustive inventory.
--
-- ── Rollout consequence ───────────────────────────────────────────────────
-- A browser tab still running the pre-migration bundle deletes papers with a
-- direct `DELETE`, so after this its paper deletion fails with 42501. Nothing is
-- destroyed — the paper, its metadata and its binaries all survive, and that
-- bundle's Storage cleanup never runs because it correctly returns on the
-- database error — but the feature is broken in that tab until it reloads. This
-- is the third stale-tab symptom, alongside upload and attachment delete, and it
-- is the reason web-first is a requirement. See docs/deployment.md §6.4.

REVOKE DELETE, TRUNCATE ON TABLE public.papers
    FROM PUBLIC, anon, authenticated;

-- Restated so the revoke above can never take an ordinary product capability
-- with it. A replay that somehow lands without these fails in section 7 rather
-- than shipping a library nobody can add to or edit.
GRANT SELECT, INSERT, UPDATE ON TABLE public.papers TO authenticated;


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
  v_src   TEXT;
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

  -- ── Finalization actually serializes: both locks precede every read ──
  -- Asserted on the source rather than at runtime, because the property that
  -- matters is ordering within the function body, and a reordering that put a
  -- read first would be invisible to any single-connection test.
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.finalize_attachment_upload(uuid,text,text,text,integer)'::regprocedure;
  IF v_src !~ 'pg_advisory_xact_lock\(20260904' THEN
    RAISE EXCEPTION 'attachment_cleanup: finalize_attachment_upload takes no per-path advisory lock';
  END IF;
  IF v_src !~ 'pg_advisory_xact_lock\(20260905' THEN
    RAISE EXCEPTION 'attachment_cleanup: finalize_attachment_upload takes no per-paper advisory lock';
  END IF;
  -- Path lock before paper lock, the one order that cannot deadlock against
  -- delete_papers_with_attachment_cleanup.
  IF position('pg_advisory_xact_lock(20260904' IN v_src)
     > position('pg_advisory_xact_lock(20260905' IN v_src) THEN
    RAISE EXCEPTION 'attachment_cleanup: finalize_attachment_upload takes its locks in the wrong order';
  END IF;
  -- Both locks before the first table read of either table it decides on.
  IF position('pg_advisory_xact_lock(20260905' IN v_src)
     > position('FROM public.paper_attachments' IN v_src) THEN
    RAISE EXCEPTION 'attachment_cleanup: finalize_attachment_upload reads paper_attachments before it serializes';
  END IF;
  IF position('pg_advisory_xact_lock(20260905' IN v_src)
     > position('FROM public.papers' IN v_src) THEN
    RAISE EXCEPTION 'attachment_cleanup: finalize_attachment_upload reads papers before it serializes';
  END IF;
  -- The tombstone is what makes the cleanup outcome survive acknowledgement, so
  -- finalization must consult it and must write it.
  IF v_src !~ 'attachment_cleanup_tombstone' THEN
    RAISE EXCEPTION 'attachment_cleanup: finalize_attachment_upload ignores the cleanup tombstone';
  END IF;

  -- ── Paper deletion serializes before it snapshots the paths it will queue ──
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.delete_papers_with_attachment_cleanup(uuid[])'::regprocedure;
  IF v_src !~ 'pg_advisory_xact_lock\(20260905' THEN
    RAISE EXCEPTION 'attachment_cleanup: delete_papers_with_attachment_cleanup takes no per-paper advisory lock';
  END IF;
  IF position('pg_advisory_xact_lock(20260905' IN v_src)
     > position('FROM public.paper_attachments a' IN v_src) THEN
    RAISE EXCEPTION 'attachment_cleanup: delete_papers_with_attachment_cleanup snapshots attachment paths before it serializes';
  END IF;
  -- Deterministic lock order, or two concurrent bulk deletes sharing papers can
  -- wait on each other forever.
  IF v_src !~ 'array_agg\(DISTINCT id ORDER BY id\)' THEN
    RAISE EXCEPTION 'attachment_cleanup: delete_papers_with_attachment_cleanup does not take its paper locks in a deterministic order';
  END IF;

  -- ── The durable cleanup tombstone ──
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'attachment_cleanup_tombstone'
       AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup_tombstone: RLS must be enabled AND forced';
  END IF;
  -- No policy of any kind: no client reads it and no client writes it. A row a
  -- user could delete is a row a user could delete to resurrect a removed object.
  SELECT count(*)::INTEGER INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'attachment_cleanup_tombstone';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'attachment_cleanup_tombstone: expected 0 policies, found %', v_count;
  END IF;
  IF has_table_privilege('authenticated', 'public.attachment_cleanup_tombstone', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('anon', 'public.attachment_cleanup_tombstone', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('service_role', 'public.attachment_cleanup_tombstone', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'attachment_cleanup_tombstone: no client role may hold any privilege';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
     WHERE c.oid = 'public.attachment_cleanup_tombstone'::regclass AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup_tombstone: PUBLIC must hold nothing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.conrelid = 'public.attachment_cleanup_tombstone'::regclass
       AND c.confrelid = 'auth.users'::regclass
       AND c.confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup_tombstone: user_id must cascade from auth.users';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.conrelid = 'public.attachment_cleanup_tombstone'::regclass
       AND c.confrelid IN ('public.papers'::regclass, 'public.paper_attachments'::regclass)
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup_tombstone: must not reference papers/paper_attachments';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.attachment_cleanup_tombstone'::regclass
       AND contype = 'p'
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup_tombstone: (user_id, file_path) primary key is missing';
  END IF;

  -- ── The Storage fence ──
  IF NOT (SELECT p.prosecdef FROM pg_proc p
           WHERE p.oid = 'public.attachment_object_has_live_metadata(text)'::regprocedure) THEN
    RAISE EXCEPTION 'attachment_cleanup: attachment_object_has_live_metadata must be SECURITY DEFINER';
  END IF;
  IF NOT (SELECT p.proconfig FROM pg_proc p
           WHERE p.oid = 'public.attachment_object_has_live_metadata(text)'::regprocedure)
         @> ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'attachment_cleanup: attachment_object_has_live_metadata does not pin search_path=public';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.attachment_object_has_live_metadata(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'attachment_cleanup: authenticated must be able to execute the Storage fence predicate';
  END IF;
  IF has_function_privilege('anon', 'public.attachment_object_has_live_metadata(text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.attachment_object_has_live_metadata(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'attachment_cleanup: anon/service_role must not execute the Storage fence predicate';
  END IF;
  -- The predicate exists only if the policy actually uses it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname = 'attachments_owner_delete'
       AND qual LIKE '%attachment_object_has_live_metadata%'
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup: the attachments delete policy does not fence live metadata';
  END IF;
  -- The owner-prefix boundary must still be there — this migration adds a
  -- condition to that policy, it must never replace one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname = 'attachments_owner_delete'
       AND qual LIKE '%foldername%'
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup: the attachments delete policy lost its owner-prefix boundary';
  END IF;
  -- Without this index the fence turns every object delete into a sequential
  -- scan of the owner's attachments.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'paper_attachments'
       AND indexname = 'idx_paper_attachments_user_file_path'
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup: the (user_id, file_path) index the Storage fence needs is missing';
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

  -- ── The upstream half of the barrier is still held, right here ──
  -- `auth.users` is the first lock the file takes and the one that makes the
  -- other two safe: while it is held, no Auth writer — and therefore no account
  -- deletion cascading toward `papers` and `paper_attachments` — can be in
  -- flight downstream of this transaction. SHARE ROW EXCLUSIVE specifically,
  -- because it is exactly what the foreign keys in sections 1 and 1b require:
  -- assert the mode, and a later edit that weakened it into a lock UPGRADE (its
  -- own deadlock shape) fails here rather than in Production.
  IF NOT EXISTS (
    SELECT 1 FROM pg_locks
     WHERE locktype = 'relation'
       AND relation = 'auth.users'::regclass
       AND mode = 'ShareRowExclusiveLock'
       AND granted
       AND pid = pg_backend_pid()
  ) THEN
    RAISE EXCEPTION
      'attachment_cleanup: the SHARE ROW EXCLUSIVE cutover barrier on auth.users is not held';
  END IF;

  -- ── The cutover barrier is still held, right here ──
  -- Not a restatement of the LOCK at the top of the file: this asserts that the
  -- posture being verified below is being verified INSIDE the barrier, on a
  -- table no other session can be reading or writing. If the lock were ever
  -- moved, weakened, or split into its own transaction, every privilege check
  -- that follows would become a snapshot of a table other sessions can still
  -- mutate, and the whole cutover argument would quietly stop holding.
  IF NOT EXISTS (
    SELECT 1 FROM pg_locks
     WHERE locktype = 'relation'
       AND relation = 'public.paper_attachments'::regclass
       AND mode = 'AccessExclusiveLock'
       AND granted
       AND pid = pg_backend_pid()
  ) THEN
    RAISE EXCEPTION
      'attachment_cleanup: the ACCESS EXCLUSIVE cutover barrier on paper_attachments is not held';
  END IF;

  -- ── The post-migration client authority model ──
  -- SELECT survives; every write privilege is gone from every browser role.
  -- Asserted per privilege and per role rather than as one aggregate, so a
  -- failure says exactly which door was left open.
  IF NOT has_table_privilege('authenticated', 'public.paper_attachments', 'SELECT') THEN
    RAISE EXCEPTION 'attachment_cleanup: authenticated must keep SELECT on paper_attachments';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('authenticated', 'public.paper_attachments', v_fn) THEN
      RAISE EXCEPTION
        'attachment_cleanup: authenticated must not hold % on paper_attachments — metadata is written only through the lifecycle RPCs', v_fn;
    END IF;
    IF has_table_privilege('anon', 'public.paper_attachments', v_fn) THEN
      RAISE EXCEPTION 'attachment_cleanup: anon must not hold % on paper_attachments', v_fn;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.paper_attachments', 'SELECT') THEN
    RAISE EXCEPTION 'attachment_cleanup: anon must not hold SELECT on paper_attachments';
  END IF;
  -- PUBLIC is every role at once, including future ones. A grant here would
  -- reinstate the whole surface without naming anybody.
  IF EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = 'public.paper_attachments'::regclass AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup: paper_attachments must grant nothing to PUBLIC';
  END IF;

  -- ── …and the RPCs that replace those privileges still work ──
  -- SECURITY DEFINER functions execute as this migration's owner and do not
  -- consult the caller's table grants. That is the entire reason the revoke
  -- above is safe, so it is asserted rather than assumed: the owner must still
  -- be able to write the table, and the client must still be able to call the
  -- three entry points.
  IF NOT has_table_privilege(
       (SELECT relowner::regrole::text FROM pg_class WHERE oid = 'public.paper_attachments'::regclass),
       'public.paper_attachments', 'INSERT, DELETE') THEN
    RAISE EXCEPTION 'attachment_cleanup: the table owner can no longer write paper_attachments — the lifecycle RPCs would fail';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.finalize_attachment_upload(uuid,text,text,text,integer)',
    'public.delete_attachment_with_cleanup(uuid)',
    'public.delete_papers_with_attachment_cleanup(uuid[])'
  ] LOOP
    IF NOT has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'attachment_cleanup: authenticated must be able to execute %', v_fn;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'attachment_cleanup: % must be SECURITY DEFINER — it writes a table its callers cannot', v_fn;
    END IF;
  END LOOP;

  -- ── The parent barrier is held too, and in the right mode ──
  -- SHARE, not something stronger: a stronger lock on `papers` would block the
  -- foreign-key check of an in-flight `paper_attachments` INSERT, which is the
  -- deadlock section 0 derives its whole ordering from. If this ever fails
  -- because the mode was changed, the change is unsafe rather than merely
  -- different.
  IF NOT EXISTS (
    SELECT 1 FROM pg_locks
     WHERE locktype = 'relation'
       AND relation = 'public.papers'::regclass
       AND mode = 'ShareLock'
       AND granted
       AND pid = pg_backend_pid()
  ) THEN
    RAISE EXCEPTION
      'attachment_cleanup: the SHARE cutover barrier on papers is not held';
  END IF;

  -- ── The parent authority model ──
  -- Attachment metadata has two doors. Section 6c closed the direct one; this
  -- is the cascade. Asserted per privilege and per role, like the child.
  FOREACH v_fn IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
    IF NOT has_table_privilege('authenticated', 'public.papers', v_fn) THEN
      RAISE EXCEPTION
        'attachment_cleanup: authenticated must keep % on papers — ordinary paper editing is not this migration''s to remove', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('authenticated', 'public.papers', v_fn) THEN
      RAISE EXCEPTION
        'attachment_cleanup: authenticated must not hold % on papers — a paper deletion cascades attachment metadata away, so it must go through delete_papers_with_attachment_cleanup', v_fn;
    END IF;
    IF has_table_privilege('anon', 'public.papers', v_fn) THEN
      RAISE EXCEPTION 'attachment_cleanup: anon must not hold % on papers', v_fn;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = 'public.papers'::regclass AND a.grantee = 0
       AND a.privilege_type IN ('DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup: papers must grant no DELETE or TRUNCATE to PUBLIC';
  END IF;

  -- ── …and the RPC that replaces the revoked capability still works ──
  IF NOT has_table_privilege(
       (SELECT relowner::regrole::text FROM pg_class WHERE oid = 'public.papers'::regclass),
       'public.papers', 'DELETE') THEN
    RAISE EXCEPTION 'attachment_cleanup: the table owner can no longer delete papers — the lifecycle RPC would fail';
  END IF;

  -- ── Both cross-table writers conform to the global lock order ──
  -- Each must take its `papers` lock before it touches `paper_attachments`, or
  -- the cutover in section 0 can deadlock against it. Checked on the source so a
  -- later edit that moves or drops the statement fails at replay.
  -- Matched against the first STATEMENT that reaches the child table, not the
  -- first mention of its name: both functions discuss `paper_attachments` in
  -- their comments long before they touch it.
  SELECT pg_get_functiondef('public.delete_papers_with_attachment_cleanup(uuid[])'::regprocedure)
    INTO v_src;
  IF position('LOCK TABLE public.papers IN ROW EXCLUSIVE MODE' IN v_src) = 0
     OR position('LOCK TABLE public.papers IN ROW EXCLUSIVE MODE' IN v_src)
        > position('FROM public.paper_attachments' IN v_src) THEN
    RAISE EXCEPTION
      'attachment_cleanup: delete_papers_with_attachment_cleanup must lock papers before it reads paper_attachments, or the cutover barrier can deadlock against it';
  END IF;

  SELECT pg_get_functiondef('public.merge_exact_duplicates(uuid,uuid[])'::regprocedure)
    INTO v_src;
  IF position('LOCK TABLE public.papers IN ROW EXCLUSIVE MODE' IN v_src) = 0
     OR position('LOCK TABLE public.papers IN ROW EXCLUSIVE MODE' IN v_src)
        > position('UPDATE paper_attachments' IN v_src) THEN
    RAISE EXCEPTION
      'attachment_cleanup: merge_exact_duplicates must lock papers before it re-parents paper_attachments, or the cutover barrier can deadlock against it';
  END IF;

  -- ── The read path the UI depends on is intact ──
  -- Revoking write must not have taken the RLS predicate with it: an owner
  -- SELECT policy has to remain, or the attachment list silently empties.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'paper_attachments' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'attachment_cleanup: paper_attachments must keep an owner SELECT policy';
  END IF;
END
$verify$;

COMMIT;
