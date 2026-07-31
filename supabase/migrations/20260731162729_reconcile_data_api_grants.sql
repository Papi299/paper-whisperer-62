-- PFA-C03A1-L-GRANT-PARITY-001 — reconcile Data API object grants.
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────────────────────────────────────────────────
-- Supabase's Data API (PostgREST) enforces access with TWO independent
-- layers that must BOTH be satisfied:
--   1. Postgres object GRANTs decide whether a role may reach a table at
--      all (a missing grant yields error 42501 "permission denied").
--   2. Row Level Security decides WHICH rows that role may see/change.
-- This repository's tables enable/force RLS and define per-user policies,
-- but the tracked migration chain never granted the underlying table
-- privileges to the API roles. Production still works because it was
-- provisioned under Supabase's OLD platform default, which auto-granted
-- ALL privileges on every new public table to anon/authenticated/
-- service_role. That auto-grant is being removed platform-wide (Data API
-- exposure is becoming opt-in), and a fresh local `supabase db reset`
-- already reflects the new default: the API roles receive NO table DML,
-- so `authenticated` cannot read papers/profiles/etc. (42501) and the app
-- cannot function on a clean replay.
--
-- This migration makes the intended Data API surface REPRODUCIBLE by
-- encoding it explicitly, so a from-scratch replay (fresh local, staging,
-- or disaster recovery) matches Production's effective behavior.
--
-- SCOPE / SAFETY
-- ─────────────────────────────────────────────────────────────────────
--   * Additive, idempotent object GRANTs only. No REVOKE.
--   * No table/column/type/policy/trigger/function/owner/data change.
--   * RLS remains the authoritative row-level boundary — unchanged.
--   * Least privilege, and STRICTLY NARROWER than Production: Production
--     grants the API roles ALL (arwdDxtm) on every table; this grants
--     each client role only the operations its RLS policy already exposes,
--     omits TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, and grants client roles
--     NOTHING on server-only tables.
--   * No grant to PUBLIC. No blanket `GRANT ALL ON ALL TABLES` to a client
--     role. No ALTER DEFAULT PRIVILEGES — future tables must grant their
--     own intended Data API surface explicitly (opt-in exposure).
--
-- GRANT vs RLS
-- ─────────────────────────────────────────────────────────────────────
-- The grants below only make a table REACHABLE by a role. Ownership of a
-- given ROW is still enforced by the existing `auth.uid() = user_id`
-- policies (and their EXISTS-based equivalents on junction/child tables).
-- A grant here never lets one user read or modify another user's rows.

-- ─────────────────────────────────────────────────────────────────────
-- 1. authenticated — the signed-in client role.
--    Each grant mirrors the operations the table's RLS policies already
--    expose to the owning user. anon is intentionally excluded: every
--    policy predicate is `auth.uid() = user_id`, which no anonymous
--    session can satisfy, and the product has no unauthenticated data path.
-- ─────────────────────────────────────────────────────────────────────

-- Fully user-mutable core entities (SELECT/INSERT/UPDATE/DELETE policies).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.papers                     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.projects                   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tags                       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.filter_presets             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.study_type_pool            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.synonym_pool               TO authenticated;

-- profiles is user-owned but never client-deleted (row lifecycle follows
-- auth.users via ON DELETE CASCADE); it has SELECT/INSERT/UPDATE policies only.
GRANT SELECT, INSERT, UPDATE         ON TABLE public.profiles                   TO authenticated;

-- Append/remove-only relations and pools (SELECT/INSERT/DELETE policies; no
-- UPDATE policy — rows are added and removed, not edited in place).
GRANT SELECT, INSERT, DELETE         ON TABLE public.paper_tags                 TO authenticated;
GRANT SELECT, INSERT, DELETE         ON TABLE public.paper_projects             TO authenticated;
GRANT SELECT, INSERT, DELETE         ON TABLE public.paper_attachments          TO authenticated;
GRANT SELECT, INSERT, DELETE         ON TABLE public.keyword_pool               TO authenticated;
GRANT SELECT, INSERT, DELETE         ON TABLE public.keyword_exclusion_pool     TO authenticated;
GRANT SELECT, INSERT, DELETE         ON TABLE public.study_type_exclusion_pool  TO authenticated;

-- Read-only client projections (SELECT policy only). The client reads its
-- own row; all writes are server-side (SECURITY DEFINER RPCs / service role).
GRANT SELECT                         ON TABLE public.user_entitlements          TO authenticated;
GRANT SELECT                         ON TABLE public.usage_credits              TO authenticated;
GRANT SELECT                         ON TABLE public.user_storage_usage         TO authenticated;

-- Sequence backing papers.insert_order (BIGSERIAL default). The client
-- performs a direct `papers` INSERT (manual add), so it must evaluate the
-- nextval() default; USAGE is the minimum privilege for that.
GRANT USAGE                          ON SEQUENCE public.papers_insert_order_seq TO authenticated;

-- NOTE — SERVER-ONLY TABLES ARE INTENTIONALLY OMITTED for client roles:
--   public.usage_counters, public.subscriptions, public.subscription_events,
--   public.internal_user_access
-- These have NO client RLS policy (server-only by design). They receive no
-- anon/authenticated grant, so they stay unreachable over the Data API for
-- client roles — object permissions deny before RLS is even consulted.
-- (internal_user_access already has its explicit service_role grant from
-- 20260726120000_harden_internal_user_access_grants.sql and is not retouched.)

-- ─────────────────────────────────────────────────────────────────────
-- 2. service_role — the server-only role used by Edge Functions with the
--    service key. It bypasses RLS and is NEVER exposed to a browser client.
--    Rationale for a broad, explicit object grant (permitted for the server
--    boundary): Production's established service-role ACL is arwdDxtm on
--    every public table; current server paths already use it (e.g.
--    fetch-paper-metadata reads public.profiles), and the server-only
--    commercial tables exist specifically for service-role ingestion. This
--    enumerates CURRENT objects only (no ALL-TABLES blanket, no default
--    privileges) and grants no client role anything. internal_user_access
--    is excluded — its service_role grant is already established.
-- ─────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.papers                     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.projects                   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tags                       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.paper_tags                 TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.paper_projects             TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.paper_attachments          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.filter_presets             TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles                   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.keyword_pool               TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.keyword_exclusion_pool     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.study_type_pool            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.study_type_exclusion_pool  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.synonym_pool               TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_entitlements          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.usage_credits              TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.usage_counters             TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscriptions              TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_events        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_storage_usage         TO service_role;

GRANT USAGE ON SEQUENCE public.papers_insert_order_seq TO service_role;
