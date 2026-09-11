-- DATA-API-ACL-RECONCILIATION-001 — hosted-Production ACL seed for the parity lane.
--
-- WHAT THIS IS. A clean `supabase db reset` does not reproduce hosted
-- Production's object privileges, and never has: Production still carries the
-- broad grants its platform default handed out, while a local replay under the
-- current CLI inherits only the non-DML residue. Every ACL test in this
-- repository ran against the second shape, which is exactly why the drift on the
-- first was invisible for as long as it was.
--
-- These statements turn a clean replay AT MIGRATION BASELINE 20260904120000 into
-- hosted Production, so the reconciliation migration can be proven to converge
-- the history it will actually meet. `scripts/e2e-local.mjs` applies this and
-- then compares the whole catalog against
-- `hosted-baseline-20260904120000.reference.json` before it trusts the lane —
-- a seed that silently failed would make the lane prove nothing, which is the
-- failure mode this pairing exists to prevent.
--
-- WHERE IT CAME FROM. Read-only observation of project lioxtgiputfniqbktcsz on
-- 2026-09-10 (28 ordinary tables, one sequence, 44 routines). It is a frozen
-- historical record: applying the migration to Production does not change what
-- Production looked like at this baseline, so this file is not updated then.
--
-- It must be applied ONLY to a disposable local database. It grants `anon` the
-- privileges the initiative exists to remove.

BEGIN;

-- 1. The 17 tables carrying the legacy platform ACL, and the sequence.
GRANT ALL ON TABLE
  public.filter_presets,
  public.keyword_exclusion_pool,
  public.keyword_pool,
  public.paper_projects,
  public.paper_tags,
  public.profiles,
  public.projects,
  public.study_type_exclusion_pool,
  public.study_type_pool,
  public.subscription_events,
  public.subscriptions,
  public.synonym_pool,
  public.tags,
  public.usage_counters,
  public.usage_credits,
  public.user_entitlements,
  public.user_storage_usage
  TO anon, authenticated, service_role;

GRANT ALL ON SEQUENCE public.papers_insert_order_seq TO anon, authenticated, service_role;

-- 2. The five SECURITY INVOKER helpers. On Production these carry an EXPLICIT
--    grant to PUBLIC and the three API roles; on a clean replay their `proacl`
--    is NULL, which means the same thing for PUBLIC (PostgreSQL's built-in
--    default is PUBLIC EXECUTE) but is not byte-identical. Making it explicit is
--    what lets the reference comparison be exact rather than approximate.
GRANT EXECUTE ON FUNCTION
  public.immutable_english_tsvector_jsonb(jsonb),
  public.immutable_english_tsvector_text(text),
  public.immutable_english_tsvector_textarr(text[]),
  public.set_updated_at(),
  public.update_updated_at_column()
  TO PUBLIC, anon, authenticated, service_role;

-- 3. Hosted Production's default privileges, which are what make a NEW table
--    arrive reachable. Without these the lane would test the migration's
--    existing-object convergence but not the future-object hardening it also
--    performs.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

COMMIT;
