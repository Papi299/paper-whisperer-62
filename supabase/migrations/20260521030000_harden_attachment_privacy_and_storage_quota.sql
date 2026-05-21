-- Commercial foundation — storage quota enforcement for attachments.
--
-- Closes the storage-quota half of the C14 launch blocker from PR #141.
--
-- ─── Scope correction discovered during implementation ─────────────
--
-- The C14 launch blocker as stated in PR #141 / owner-decisions.md
-- §3 had TWO concerns:
--
--   (a) Tighten the `attachments` Storage bucket SELECT policy from
--       public-read to owner-only path-prefix RLS.
--   (b) Add a BEFORE INSERT trigger on paper_attachments enforcing
--       user_entitlements.storage_quota_bytes.
--
-- Concern (a) was ALREADY CLOSED by migration
-- `20260327100000_private_attachments_bucket.sql` (already on remote,
-- repo-tracked under supabase/migrations/, applied to production).
-- That earlier migration:
--   - Set the bucket's `public = false`.
--   - DROPped the `attachments_public_read` policy.
--   - Created `attachments_owner_read` as the owner-scoped SELECT
--     policy with path-prefix logic identical to the
--     attachments_owner_insert / _update / _delete policies from
--     20260318020000.
--
-- That earlier migration did not surface in `docs/migration-history.md`
-- — likely because it was authored through the Supabase / Lovable
-- dashboard workflow before the active documentation policy from
-- PR #C6. The post-PR-#140 production-readiness audit and the C14
-- decision text in PR #141 both believed concern (a) was outstanding;
-- it was not. The schema state, both locally and on remote, was
-- already private-bucket + owner-scoped-SELECT.
--
-- This migration therefore:
--   1. Does NOT modify any storage.objects policies. The existing
--      `attachments_owner_read` policy from 20260327100000 is the
--      authoritative owner-scoped SELECT policy. Creating a
--      redundant `attachments_owner_select` policy would be noise.
--   2. Implements only the storage-quota half (b).
--
-- The accompanying docs PR retroactively documents the
-- 20260327100000 migration in migration-history.md so future
-- contributors don't repeat the same audit miss.
--
-- ─── Storage quota enforcement design ──────────────────────────────
--
-- PR #142 added `user_entitlements.storage_quota_bytes` (Free 500
-- MB, Pro 2 GB, Labs/Teams future 10 GB). This migration adds:
--
--   - A new `user_storage_usage` table (one row per user, `bigint
--     used_bytes`). Dedicated table rather than reusing
--     `usage_counters.used` (which is `integer`, capped at ~2.1 GB
--     — Labs/Teams 10 GB would overflow silently). The two tables
--     also have semantically different shapes (AI is per-period
--     with period_start; storage is a single per-user running total).
--   - A BEFORE INSERT trigger on `paper_attachments` that does an
--     atomic check-and-increment against the entitlement quota.
--   - An AFTER DELETE trigger that decrements (floored at zero).
--   - Backfill that computes real `used_bytes` per user from
--     existing paper_attachments rows.
--
-- Trigger atomicity (race-safe):
--   The BEFORE INSERT trigger performs the check AND the increment
--   in a single atomic UPDATE gated on the quota predicate:
--     UPDATE user_storage_usage
--     SET used_bytes = used_bytes + NEW.size_bytes
--     WHERE user_id = NEW.user_id
--       AND used_bytes + NEW.size_bytes <= quota
--     RETURNING used_bytes
--   If the UPDATE matches a row, the BEFORE trigger returns NEW and
--   the paper_attachments INSERT proceeds. If it matches zero rows
--   (over-quota OR missing entitlement), the trigger RAISEs and the
--   metadata insert fails. Two concurrent INSERTs serialize on the
--   user_storage_usage row lock; the second one sees the updated
--   value and may correctly fail.
--
--   Because the BEFORE trigger has ALREADY incremented (the check
--   and the increment are the same UPDATE), there is NO AFTER
--   INSERT trigger. If the surrounding transaction rolls back, the
--   increment rolls back too — same transaction.
--
-- Existing client orphan-cleanup contract:
--   `useAttachments.uploadAttachments` (src/hooks/useAttachments.ts)
--   uploads to Storage FIRST, then inserts metadata. On metadata
--   insert failure it already calls `storage.from(BUCKET).remove(
--   [filePath])` to clean up the orphan storage object. The
--   over-quota error path goes through the same client code; no
--   client-side change required.
--
-- Existing-overage handling:
--   If any existing user is already over their Free 500 MB cap when
--   this migration deploys (e.g., the owner with a populated
--   library), the backfill records the real `used_bytes`. New
--   uploads will be blocked until the user deletes attachments to
--   drop below quota OR until their entitlement is upgraded to Pro.
--   No data is destroyed; existing files remain readable.
--
-- Security:
--   The trigger functions are SECURITY DEFINER + SET search_path =
--   public because they READ from user_entitlements and WRITE to
--   user_storage_usage, both of which have FORCE ROW LEVEL SECURITY
--   and no client write policies. The trigger uses NEW.user_id
--   which is already RLS-checked (paper_attachments INSERT policy
--   requires auth.uid() = user_id), so NEW.user_id is provably the
--   caller's own id — no separate auth.uid() guard needed.


-- ─────────────────────────────────────────────────────────────────────
-- 1. user_storage_usage — running per-user byte total
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.user_storage_usage (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    used_bytes BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT user_storage_usage_used_bytes_nonneg
        CHECK (used_bytes >= 0)
);

COMMENT ON TABLE public.user_storage_usage IS
    'Per-user running total of bytes used by paper_attachments. One '
    'row per user. Maintained by the check_and_consume_storage_quota '
    '(BEFORE INSERT) and refund_storage_quota (AFTER DELETE) triggers '
    'on paper_attachments. Bigint is intentional — 32-bit integer '
    'would overflow at the future Labs/Teams 10 GB cap. Server-only '
    'writes. Client SELECT-own allowed so a future Settings → Storage '
    'view can render the used/quota gauge without a new policy.';

COMMENT ON COLUMN public.user_storage_usage.used_bytes IS
    'Running sum of paper_attachments.size_bytes for the user. '
    'Maintained by triggers; floored at zero on decrement.';

ALTER TABLE public.user_storage_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_storage_usage FORCE ROW LEVEL SECURITY;

-- Client SELECT-own (anticipating future Settings → Storage UI). No
-- client INSERT/UPDATE/DELETE policy — writes are server-only via the
-- SECURITY DEFINER triggers below.
CREATE POLICY "Users can view their own storage usage"
    ON public.user_storage_usage FOR SELECT
    USING (auth.uid() = user_id);

CREATE TRIGGER update_user_storage_usage_updated_at
    BEFORE UPDATE ON public.user_storage_usage
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────
-- 2. Backfill: compute real usage from existing paper_attachments
-- ─────────────────────────────────────────────────────────────────────

-- One row per existing auth.users user, used_bytes = SUM(size_bytes)
-- across their existing paper_attachments. Users with zero
-- attachments get a zero row so the trigger's UPSERT below sees an
-- existing row on the first upload.
INSERT INTO public.user_storage_usage (user_id, used_bytes)
SELECT
    u.id AS user_id,
    COALESCE(SUM(pa.size_bytes)::BIGINT, 0) AS used_bytes
FROM auth.users u
LEFT JOIN public.paper_attachments pa ON pa.user_id = u.id
GROUP BY u.id
ON CONFLICT (user_id) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────
-- 3. check_and_consume_storage_quota — BEFORE INSERT on paper_attachments
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_and_consume_storage_quota()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quota BIGINT;
  v_new_used BIGINT;
BEGIN
  -- Defensive: size_bytes must be non-negative. paper_attachments
  -- has no CHECK on this today; the trigger guards against a
  -- negative size that would otherwise inflate available quota for a
  -- later upload.
  IF NEW.size_bytes IS NULL OR NEW.size_bytes < 0 THEN
    RAISE EXCEPTION 'paper_attachments.size_bytes must be non-negative (got %)', NEW.size_bytes;
  END IF;

  -- Look up the storage quota. user_entitlements has FORCE ROW
  -- LEVEL SECURITY but this function is SECURITY DEFINER so it
  -- bypasses RLS. NEW.user_id is already validated by the
  -- paper_attachments RLS INSERT policy (auth.uid() = user_id) — the
  -- trigger trusts that NEW.user_id is the caller's own id.
  SELECT storage_quota_bytes INTO v_quota
  FROM public.user_entitlements
  WHERE user_id = NEW.user_id;

  IF v_quota IS NULL THEN
    RAISE EXCEPTION 'Missing entitlement: cannot upload attachment for user %', NEW.user_id;
  END IF;

  -- Ensure the usage row exists. Backfill should have created one
  -- for every existing user; this idempotent UPSERT covers any
  -- future user whose row wasn't created (defense in depth — the
  -- handle_new_user pipeline doesn't create user_storage_usage rows
  -- by default; the backfill on this migration plus this UPSERT
  -- cover both old and new users).
  INSERT INTO public.user_storage_usage (user_id, used_bytes)
  VALUES (NEW.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  -- Atomic check-and-increment. The WHERE clause is the quota
  -- gate; the UPDATE row-locks user_storage_usage for this user so
  -- two concurrent INSERTs serialize. If used_bytes +
  -- NEW.size_bytes would exceed quota, the UPDATE matches zero
  -- rows; v_new_used stays NULL; the trigger raises.
  UPDATE public.user_storage_usage
  SET used_bytes = user_storage_usage.used_bytes + NEW.size_bytes,
      updated_at = now()
  WHERE user_storage_usage.user_id = NEW.user_id
    AND user_storage_usage.used_bytes + NEW.size_bytes <= v_quota
  RETURNING user_storage_usage.used_bytes INTO v_new_used;

  IF v_new_used IS NULL THEN
    RAISE EXCEPTION 'Storage quota exceeded (quota %, attempted +% bytes)', v_quota, NEW.size_bytes;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_and_consume_storage_quota() IS
    'BEFORE INSERT trigger function for paper_attachments. Atomically '
    'checks and consumes user_storage_usage against '
    'user_entitlements.storage_quota_bytes. Raises if the quota would '
    'be exceeded. SECURITY DEFINER + safe search_path. Trusts '
    'NEW.user_id because the paper_attachments RLS INSERT policy '
    'already constrains it to auth.uid().';

DROP TRIGGER IF EXISTS trg_paper_attachments_check_storage_quota ON public.paper_attachments;
CREATE TRIGGER trg_paper_attachments_check_storage_quota
    BEFORE INSERT ON public.paper_attachments
    FOR EACH ROW
    EXECUTE FUNCTION public.check_and_consume_storage_quota();


-- ─────────────────────────────────────────────────────────────────────
-- 4. refund_storage_quota — AFTER DELETE on paper_attachments
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.refund_storage_quota()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- GREATEST guards against double-decrement / out-of-order events.
  -- A zero row (or missing row) is acceptable — the UPDATE simply
  -- matches zero rows.
  UPDATE public.user_storage_usage
  SET used_bytes = GREATEST(user_storage_usage.used_bytes - OLD.size_bytes, 0),
      updated_at = now()
  WHERE user_storage_usage.user_id = OLD.user_id;

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.refund_storage_quota() IS
    'AFTER DELETE trigger function for paper_attachments. Decrements '
    'user_storage_usage.used_bytes by OLD.size_bytes, floored at '
    'zero. SECURITY DEFINER + safe search_path.';

DROP TRIGGER IF EXISTS trg_paper_attachments_refund_storage_quota ON public.paper_attachments;
CREATE TRIGGER trg_paper_attachments_refund_storage_quota
    AFTER DELETE ON public.paper_attachments
    FOR EACH ROW
    EXECUTE FUNCTION public.refund_storage_quota();


-- ─────────────────────────────────────────────────────────────────────
-- 5. UPDATE protection (intentional absence)
-- ─────────────────────────────────────────────────────────────────────

-- paper_attachments has no UPDATE RLS policy (see
-- 20260318010000_add_paper_attachments.sql), so client UPDATE is
-- already blocked. If an UPDATE were ever introduced (e.g., a future
-- migration adding a column + UPDATE policy), changing size_bytes
-- or user_id mid-life would silently corrupt usage accounting. We do
-- NOT install a defensive UPDATE trigger here because no UPDATE path
-- exists; the next contributor adding an UPDATE policy must also
-- add a trigger to handle the delta. This comment is the documented
-- contract; the absence of a trigger is intentional.
