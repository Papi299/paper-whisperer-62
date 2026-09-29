-- SERVICE-ROLE-LEAST-PRIVILEGE-HARDENING-001 — hosted-Production seed for the
-- service_role starting-shape lane.
--
-- WHAT THIS IS. At migration baseline 20260928133918 (C56) a clean
-- `supabase db reset` and hosted Production hold the same object privileges
-- everywhere except in two places, both belonging to service_role: its grant
-- on `papers_insert_order_seq` (`wU` on a replay, `rwU` hosted) and
-- `postgres`'s `public` default entries (TABLES `Dxtm` / SEQUENCES `w` /
-- FUNCTIONS absent on a replay; `arwdDxtm` / `rwU` / `X` hosted).
--
-- These statements turn a clean replay AT MIGRATION BASELINE 20260928133918
-- into hosted Production, so
-- `20260929084252_harden_service_role_least_privilege.sql` can be proven to
-- converge the history it will actually meet. `scripts/e2e-local.mjs` applies
-- this and then compares every public relation ACL, routine ACL and default
-- entry against `hosted-service-role-20260928133918.reference.json` before it
-- trusts the lane — a seed that silently failed would make the lane prove
-- nothing.
--
-- WHERE IT CAME FROM. Read-only observation of project lioxtgiputfniqbktcsz
-- on 2026-09-29 (ledger 96, latest 20260928133918; 29 tables, one sequence,
-- 43 routines). It is a frozen historical record: applying the migration to
-- Production does not change what Production looked like at this baseline, so
-- this file is not updated then.
--
-- It must be applied ONLY to a disposable local database. It grants
-- service_role the default privileges the hardening exists to remove.

BEGIN;

GRANT SELECT ON SEQUENCE public.papers_insert_order_seq TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;

COMMIT;
