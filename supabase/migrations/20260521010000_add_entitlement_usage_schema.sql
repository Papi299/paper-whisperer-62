-- Commercial foundation — entitlement and usage schema.
--
-- Adds the internal commercial read model the application will read at
-- render time, plus the provider-normalized billing tables, append-only
-- event audit log, per-user usage counters, and a placeholder credits
-- table for future add-on AI credit packs.
--
-- This migration ONLY creates tables, indexes, RLS, seed, and the
-- extension of the existing public.handle_new_user() trigger. It does
-- NOT:
--   - integrate Stripe (no webhook function, no SDK)
--   - enforce AI quotas (no consume_ai_quota / refund_ai_quota RPC)
--   - enforce storage quotas (no BEFORE INSERT trigger on paper_attachments)
--   - change attachments bucket SELECT policy
--   - change UI or Edge Function behavior
--
-- The shapes below match docs/commercial-architecture.md §4 and the
-- 2026-05-21 commercial pivot decisions C7–C16 in
-- docs/decisions-and-triggers.md. Numeric defaults match the Free-tier
-- MVP baselines from docs/quotas-and-pricing.md §2.
--
-- Conventions reused from prior migrations:
--   - public.update_updated_at_column() (from 20260203072053 / 20260411010000)
--     is the canonical updated_at trigger function and is reused here.
--   - public.handle_new_user() (from 20260411010000) is the canonical
--     auth.users → public.* signup trigger; this migration extends it
--     in-place to also create the default Free entitlement and the
--     lifetime AI counter row. A second AFTER INSERT trigger on
--     auth.users is intentionally NOT added — one trigger that does
--     three idempotent INSERTs is simpler and atomic per signup.
--   - ENABLE ROW LEVEL SECURITY + FORCE ROW LEVEL SECURITY is the
--     canonical RLS posture (from 20260412030000_fix_rls_all_tables.sql).
--   - All four new commercial tables use FORCE because they are
--     server-write-only and a misconfigured table owner must not be
--     able to bypass policies.

-- ─────────────────────────────────────────────────────────────────────
-- 1. user_entitlements — the hot-path read model
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.user_entitlements (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'free',
    plan_status TEXT NOT NULL DEFAULT 'active',
    billing_provider TEXT,
    billing_customer_id TEXT,
    billing_subscription_id TEXT,
    paper_limit INTEGER NOT NULL DEFAULT 1500,
    storage_quota_bytes BIGINT NOT NULL DEFAULT 524288000,
    ai_lifetime_quota INTEGER NOT NULL DEFAULT 15,
    ai_monthly_quota INTEGER NOT NULL DEFAULT 0,
    premium_taxonomy_enabled BOOLEAN NOT NULL DEFAULT false,
    labs_team_enabled BOOLEAN NOT NULL DEFAULT false,
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT user_entitlements_plan_check
        CHECK (plan IN ('free', 'pro', 'labs_team')),

    -- The status set is a superset of what Stripe emits via the webhook
    -- ingestion path landed in a later PR. 'trialing' is intentionally
    -- INCLUDED for provider-state compatibility — Stripe will emit it
    -- if any introductory offer is ever attached at the SKU level, and
    -- it is cheaper to accept the value than to NULL/strip it on
    -- ingestion. The MVP product model itself (per C9, 2026-05-21) does
    -- NOT use a time-based trial, so this status is unused on the
    -- application-write path; it exists only so a provider-driven row
    -- can be stored faithfully.
    CONSTRAINT user_entitlements_plan_status_check
        CHECK (plan_status IN ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'paused')),

    CONSTRAINT user_entitlements_paper_limit_nonneg
        CHECK (paper_limit >= 0),
    CONSTRAINT user_entitlements_storage_quota_nonneg
        CHECK (storage_quota_bytes >= 0),
    CONSTRAINT user_entitlements_ai_lifetime_nonneg
        CHECK (ai_lifetime_quota >= 0),
    CONSTRAINT user_entitlements_ai_monthly_nonneg
        CHECK (ai_monthly_quota >= 0)
);

COMMENT ON TABLE public.user_entitlements IS
    'Hot-path read model of a user''s current commercial entitlement. '
    'One row per user. Client may SELECT its own row. Writes are '
    'server-only (future Stripe webhook / admin RPC). Provider-agnostic '
    'by design — populated from `subscriptions` via the ingestion path. '
    'See docs/commercial-architecture.md §4.1.';

COMMENT ON COLUMN public.user_entitlements.plan IS
    'Active plan: free | pro | labs_team. labs_team is reserved for the '
    'roadmap B2B tier (C12, 2026-05-21) and is NOT self-serve in MVP.';

COMMENT ON COLUMN public.user_entitlements.ai_lifetime_quota IS
    'Lifetime AI calls cap. Used by Free (15 calls from sign-up until '
    'upgrade). Pro stores 0 here and uses ai_monthly_quota.';

COMMENT ON COLUMN public.user_entitlements.ai_monthly_quota IS
    'Per-period AI calls cap. 0 on Free; 350 on Pro per the C11 MVP '
    'baseline (2026-05-21).';

COMMENT ON COLUMN public.user_entitlements.premium_taxonomy_enabled IS
    'Gates Synonyms + Exclusions pools. false on Free; true on Pro.';

-- Indexes
CREATE INDEX idx_user_entitlements_plan
    ON public.user_entitlements (plan);

CREATE INDEX idx_user_entitlements_billing_customer
    ON public.user_entitlements (billing_provider, billing_customer_id)
    WHERE billing_customer_id IS NOT NULL;

CREATE INDEX idx_user_entitlements_billing_subscription
    ON public.user_entitlements (billing_provider, billing_subscription_id)
    WHERE billing_subscription_id IS NOT NULL;

-- RLS
ALTER TABLE public.user_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_entitlements FORCE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own entitlement"
    ON public.user_entitlements FOR SELECT
    USING (auth.uid() = user_id);

-- No INSERT / UPDATE / DELETE policies. The client cannot mutate
-- commercial state under any circumstance. Future Stripe webhook
-- ingestion runs as service-role inside an Edge Function, bypassing RLS
-- by design.

CREATE TRIGGER update_user_entitlements_updated_at
    BEFORE UPDATE ON public.user_entitlements
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────
-- 2. subscriptions — provider-normalized billing state
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.subscriptions (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    -- Nullable: provider events may arrive before mapping to a user is
    -- resolved (e.g. a Stripe webhook for a customer whose linking is
    -- still pending). ON DELETE SET NULL preserves history when a user
    -- is deleted via the cascade.
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    provider_customer_id TEXT,
    provider_subscription_id TEXT,
    provider_price_id TEXT,
    provider_product_id TEXT,
    status TEXT NOT NULL,
    plan TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
    canceled_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT subscriptions_provider_check
        CHECK (provider IN ('stripe', 'apple', 'google', 'revenuecat', 'manual')),

    -- Full Stripe-compatible status surface. trialing is kept for
    -- provider-state compatibility; the MVP product model itself does
    -- not generate trialing rows (C9, 2026-05-21).
    CONSTRAINT subscriptions_status_check
        CHECK (status IN (
            'active', 'trialing', 'past_due', 'canceled',
            'incomplete', 'incomplete_expired', 'paused', 'unpaid'
        )),

    CONSTRAINT subscriptions_quantity_positive
        CHECK (quantity > 0)
);

COMMENT ON TABLE public.subscriptions IS
    'Provider-normalized billing/subscription state. NOT the enforcement '
    'boundary — the application reads user_entitlements, not this table. '
    'Server-only writes (Stripe webhook ingestion runs as service-role). '
    'Provider-neutral schema: same shape supports Stripe (MVP), and a '
    'future Apple IAP / Google Play / RevenueCat ingestion. '
    'See docs/commercial-architecture.md §4.2.';

-- Per-provider subscription uniqueness when the provider supplies a
-- subscription id. Stripe-driven inserts are idempotent via this index.
CREATE UNIQUE INDEX idx_subscriptions_provider_subscription_unique
    ON public.subscriptions (provider, provider_subscription_id)
    WHERE provider_subscription_id IS NOT NULL;

CREATE INDEX idx_subscriptions_user_id
    ON public.subscriptions (user_id);

CREATE INDEX idx_subscriptions_provider_customer
    ON public.subscriptions (provider, provider_customer_id)
    WHERE provider_customer_id IS NOT NULL;

CREATE INDEX idx_subscriptions_status
    ON public.subscriptions (status);

-- RLS — no client policies. The client reads user_entitlements; raw
-- subscription rows are not surfaced to the UI in MVP.
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions FORCE ROW LEVEL SECURITY;

CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON public.subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────
-- 3. usage_counters — per-user metered usage
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.usage_counters (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    feature TEXT NOT NULL,
    period_type TEXT NOT NULL,
    -- For lifetime rows we use 'epoch'::timestamptz as a sentinel so
    -- the (user_id, feature, period_type, period_start) uniqueness
    -- below works without a NULLS NOT DISTINCT clause and without
    -- per-Postgres-version surprises. period_end stays NULL for
    -- lifetime rows.
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ,
    used INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT usage_counters_feature_check
        CHECK (feature IN ('ai_analysis')),
    CONSTRAINT usage_counters_period_type_check
        CHECK (period_type IN ('lifetime', 'monthly')),
    CONSTRAINT usage_counters_used_nonneg
        CHECK (used >= 0),
    CONSTRAINT usage_counters_reserved_nonneg
        CHECK (reserved >= 0)
);

COMMENT ON TABLE public.usage_counters IS
    'Per-user, per-feature, per-period usage counters. Future '
    'consume_ai_quota / refund_ai_quota SECURITY DEFINER RPCs will '
    'atomically increment "used" against the corresponding row in '
    'user_entitlements. No client write policy. Server-only. '
    'See docs/commercial-architecture.md §4.3.';

COMMENT ON COLUMN public.usage_counters.period_start IS
    'Period start. For period_type = ''lifetime'' use the sentinel '
    'value ''epoch''::timestamptz (1970-01-01 UTC) so the uniqueness '
    'index works without NULL handling.';

CREATE UNIQUE INDEX idx_usage_counters_user_feature_period_unique
    ON public.usage_counters (user_id, feature, period_type, period_start);

CREATE INDEX idx_usage_counters_user_feature_period
    ON public.usage_counters (user_id, feature, period_type);

-- RLS — server-only. The UI surface for quota usage (planned in a later
-- PR) will be served by a SECURITY DEFINER RPC that reads on the
-- user's behalf, not by a direct client SELECT. This keeps the read
-- path uniform with the planned quota-consumption RPC and avoids
-- having to revisit the policy when the RPC lands.
ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_counters FORCE ROW LEVEL SECURITY;

CREATE TRIGGER update_usage_counters_updated_at
    BEFORE UPDATE ON public.usage_counters
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────
-- 4. subscription_events — append-only audit log
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.subscription_events (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
    processed_at TIMESTAMPTZ,
    payload JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT subscription_events_provider_check
        CHECK (provider IN ('stripe', 'apple', 'google', 'revenuecat', 'manual'))
);

COMMENT ON TABLE public.subscription_events IS
    'Append-only audit log of provider webhook / S2S notification events '
    'processed by the ingestion path. Holds the verified raw payload, '
    'event type, resolved user/subscription, and processed timestamp. '
    'Provides idempotency (unique provider + provider_event_id) and '
    'forensic trail for support, dispute resolution, and reconciliation. '
    'Server-only writes. No client policy. '
    'See docs/commercial-architecture.md §4.4.';

CREATE UNIQUE INDEX idx_subscription_events_provider_event_unique
    ON public.subscription_events (provider, provider_event_id);

CREATE INDEX idx_subscription_events_user_id
    ON public.subscription_events (user_id);

CREATE INDEX idx_subscription_events_subscription_id
    ON public.subscription_events (subscription_id);

CREATE INDEX idx_subscription_events_event_type
    ON public.subscription_events (event_type);

CREATE INDEX idx_subscription_events_created_at
    ON public.subscription_events (created_at DESC);

ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_events FORCE ROW LEVEL SECURITY;

-- No client policies. Operator / support reads happen via service-role
-- access in Supabase Studio.


-- ─────────────────────────────────────────────────────────────────────
-- 5. usage_credits — placeholder for future add-on AI credit packs
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.usage_credits (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    feature TEXT NOT NULL DEFAULT 'ai_analysis',
    source TEXT NOT NULL,
    provider TEXT,
    provider_reference_id TEXT,
    quantity_granted INTEGER NOT NULL,
    quantity_remaining INTEGER NOT NULL,
    expires_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT usage_credits_feature_check
        CHECK (feature IN ('ai_analysis')),
    CONSTRAINT usage_credits_source_check
        CHECK (source IN ('purchase', 'manual_grant', 'promo', 'refund')),
    CONSTRAINT usage_credits_quantity_granted_positive
        CHECK (quantity_granted > 0),
    CONSTRAINT usage_credits_quantity_remaining_nonneg
        CHECK (quantity_remaining >= 0),
    CONSTRAINT usage_credits_quantity_remaining_bounded
        CHECK (quantity_remaining <= quantity_granted)
);

COMMENT ON TABLE public.usage_credits IS
    'Add-on AI credit packs. Future feature per C13 (2026-05-21); NOT '
    'consumed in MVP. Schema shape exists from day one so the future '
    'consume_ai_quota RPC can fall through to credits after the '
    'monthly/lifetime quota is exhausted. Client SELECT-own allowed so '
    'a future Settings → Credits view can show the balance without a '
    'new policy migration. No client write policy. '
    'See docs/commercial-architecture.md §4.5.';

CREATE INDEX idx_usage_credits_user_feature
    ON public.usage_credits (user_id, feature);

CREATE INDEX idx_usage_credits_expires_at
    ON public.usage_credits (expires_at)
    WHERE expires_at IS NOT NULL;

-- Idempotency on a (provider, provider_reference_id) Stripe charge id.
-- WHERE clause keeps the index from rejecting multiple manual_grant
-- rows that have no provider reference.
CREATE UNIQUE INDEX idx_usage_credits_provider_reference_unique
    ON public.usage_credits (provider, provider_reference_id)
    WHERE provider IS NOT NULL AND provider_reference_id IS NOT NULL;

ALTER TABLE public.usage_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_credits FORCE ROW LEVEL SECURITY;

-- Client may SELECT its own credits (anticipating the future Settings
-- → Credits surface). Writes remain server-only.
CREATE POLICY "Users can view their own credits"
    ON public.usage_credits FOR SELECT
    USING (auth.uid() = user_id);

CREATE TRIGGER update_usage_credits_updated_at
    BEFORE UPDATE ON public.usage_credits
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────
-- 6. Backfill existing users
-- ─────────────────────────────────────────────────────────────────────

-- One Free entitlement per existing auth.users user. ON CONFLICT keeps
-- the migration idempotent: re-running on a partially-applied state
-- (or on a remote where the trigger has already created some rows
-- between phases) is a no-op for existing rows.
INSERT INTO public.user_entitlements (user_id)
SELECT u.id
FROM auth.users u
ON CONFLICT (user_id) DO NOTHING;

-- One lifetime ai_analysis counter per existing user. Uses the
-- 'epoch'::timestamptz sentinel for period_start; period_end stays
-- NULL on lifetime rows. Monthly rows are NOT seeded here — they are
-- created on demand when a Pro user's first AI call lands in a new
-- billing period.
INSERT INTO public.usage_counters (user_id, feature, period_type, period_start)
SELECT u.id, 'ai_analysis', 'lifetime', 'epoch'::timestamptz
FROM auth.users u
ON CONFLICT (user_id, feature, period_type, period_start) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────
-- 7. Extend handle_new_user() to seed entitlements + counter on signup
-- ─────────────────────────────────────────────────────────────────────

-- The canonical signup trigger (last established by
-- 20260411010000_add_pubmed_api_key_to_profiles.sql) inserts a profile
-- row for every new auth.users row. This migration extends it to also
-- INSERT the default Free entitlement and the lifetime ai_analysis
-- counter, all in the same trigger pass so signup is atomic.
--
-- The body is intentionally kept linear and idempotent (ON CONFLICT
-- DO NOTHING on every INSERT) so a partial replay / a previously-run
-- migration cannot break a new signup.
--
-- SECURITY DEFINER + search_path = public is preserved from the prior
-- version of this function.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    -- 1. profiles (unchanged from prior migration)
    INSERT INTO public.profiles (user_id, email)
    VALUES (NEW.id, NEW.email)
    ON CONFLICT (user_id) DO NOTHING;

    -- 2. Default Free entitlement. All column defaults already encode
    --    the Free MVP baseline (paper_limit=1500, storage_quota_bytes
    --    =524288000, ai_lifetime_quota=15, ai_monthly_quota=0,
    --    premium_taxonomy_enabled=false, labs_team_enabled=false), so
    --    only user_id needs to be supplied.
    INSERT INTO public.user_entitlements (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;

    -- 3. Lifetime ai_analysis counter starting at 0.
    INSERT INTO public.usage_counters (user_id, feature, period_type, period_start)
    VALUES (NEW.id, 'ai_analysis', 'lifetime', 'epoch'::timestamptz)
    ON CONFLICT (user_id, feature, period_type, period_start) DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Recreate the trigger attachment so the new function body takes
-- effect immediately. Idempotent — matches the pattern from
-- 20260411010000.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();
