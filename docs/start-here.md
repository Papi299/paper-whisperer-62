# Start Here — Current-State Handoff

> **Purpose.** This is the bounded current-state handoff for a fresh engineering, product, or AI-assistant session. It describes what is true **now**. It is not a project journal: chronological history lives in Git, merged PRs, `supabase/migrations/`, and [migration-history.md](migration-history.md).
>
> **Maintenance rule.** Target 150–250 lines; hard maximum 300. Update **in place**: replace or delete statements that stop being true. Never append PR-by-PR narrative. Prefer a link to the authoritative document over copied detail. See [documentation-policy.md](documentation-policy.md).

## Product and repository identity

- **Repository:** `Papi299/paper-whisperer-62` (product name in-repo: **Paper Whisperer**). The repository is currently **public**.
- **Working commercial brand:** **Paperlume** (working brand only — **not** a registered trademark; see C19 in [decisions-and-triggers.md](decisions-and-triggers.md)).
- **Domains:** `paperlume.app` secured via Cloudflare Registrar; the app is live at **`app.paperlume.app`** (Vercel). Marketing site at root `paperlume.app` is not yet built.
- **What it is:** an academic paper library manager — import, organize, search, analyze, and export research papers — using a **single-user workspace model with per-user multi-tenant isolation** (every row is owned by one user; Postgres RLS is the isolation boundary).

## Current architecture

- **Frontend:** React 18 + TypeScript + Vite SPA; shadcn/ui (Radix + Tailwind); TanStack Query for server state; React Router with four routes (`/`, `/auth`, `/dashboard`, `/reset-password`). Route guarding is a client-side redirect for UX only — **RLS is the real security boundary**.
- **Backend:** Supabase — Postgres 17, Auth (JWT, localStorage-persisted sessions), Storage, PostgREST, and two Edge Functions: `fetch-paper-metadata` (PubMed/Crossref metadata) and `analyze-paper` (Google Gemini analysis). No service-role key is used anywhere; Edge Functions authenticate with the caller's JWT via in-body `auth.getUser()` (`verify_jwt = false` at the gateway is intentional; CORS `*` is an accepted decision under bearer-token auth).
- **Read path:** all filtering, sorting, pagination, keyword matching, and full-text search happen in Postgres; the client holds one page at a time. Detail: [architecture-read-path.md](architecture-read-path.md).
- **Search:** four mutually exclusive modes (empty / short ILIKE for 1–2 chars / prefix-aware FTS for 3+ chars / quoted literal phrase), across six fields (title, abstract, authors, journal, notes, keywords) with a server-driven "Matched in:" attribution line.
- **Security patterns (mandatory for new code):**
  - **S1:** every `SECURITY DEFINER` RPC verifies caller identity against `auth.uid()` (explicit guard or internally derived ownership). Full inventory and rule: [decisions-and-triggers.md](decisions-and-triggers.md) §Security decisions.
  - **S2:** client-side mutations/reads on `user_id`-bearing tables carry an explicit `.eq("user_id", userId)` predicate as defense-in-depth, with nullable-safe `userId` threading.
- **Attachments:** private Storage bucket, owner-scoped path policies, size/MIME limits, server-side storage-quota triggers.

## Implemented capabilities

- Papers CRUD, bulk actions (select-all across the full filtered set), and column/layout customization.
- Import by PMID/DOI identifiers and from BibTeX / RIS / CSV files, with atomic server-side bulk insert.
- Duplicate detection and merge — **PMID/DOI-only by decision**.
- Projects, tags, and four curation pools: keywords, synonyms, study types, exclusions.
- Per-paper notes (indexed into search) and saved searches / filter presets (server-side per user, RLS-isolated).
- Exports to CSV / RIS / BibTeX (chunked pipeline for large libraries).
- Per-paper file attachments in the private Storage bucket, within the server-enforced storage quota.
- AI analysis (TL;DR, study type, statistical methods) via Gemini, behind the server-enforced AI quota.
- Per-user optional PubMed API key (stored in `profiles`, used server-side by `fetch-paper-metadata`).

## Key files (orientation map)

| Path | Role |
|---|---|
| `src/pages/Dashboard.tsx` | Main page; orchestrates hooks and list UI |
| `src/hooks/usePapers.ts` | Papers infinite query + server filter/sort |
| `src/hooks/useFilterState.ts` | Filter/search state + three-mode search routing |
| `src/lib/buildPapersQuery.ts` | PostgREST query builder for the read path |
| `src/hooks/useFilterPresets.ts` | Saved searches: schema, queries, mutations |
| `src/hooks/usePaperAnalysisActions.ts` | AI-analysis orchestration (single + bulk) |
| `src/hooks/useAbstract.ts` | On-demand abstract fetch (single + batch) |
| `src/hooks/useAttachments.ts` | Attachment upload/download/delete |
| `src/lib/importParsers.ts` | BibTeX / RIS / CSV parsing |
| `src/integrations/supabase/client.ts` | Supabase client (env fail-fast via `src/lib/clientEnv.ts`) |
| `supabase/functions/analyze-paper/index.ts` | Gemini analysis + quota consume/refund |
| `supabase/functions/fetch-paper-metadata/index.ts` | PubMed/Crossref metadata fetch |
| `supabase/migrations/` | Full schema, RLS, and RPC definitions (chronological) |

## Commercial and entitlement state

**Implemented and applied to the linked Supabase project** (verified by read-only remote inspection during the 2026-07-17 Phase 0 audit — the migration ledger matches the repo and both Edge Functions are deployed and current; note that ledger parity does **not** imply full structural schema parity — see the drift risk below; the commercial/RLS enforcement objects themselves were verified in parity):

- **Entitlement/usage schema** (`20260521010000_add_entitlement_usage_schema.sql`): `user_entitlements`, `subscriptions`, `subscription_events`, `usage_counters`, `usage_credits`; `handle_new_user()` seeds a Free entitlement on signup. `subscriptions`/`subscription_events`/`usage_counters` are intentionally deny-all under RLS (server-only).
- **AI quota enforcement** (`20260521020000_add_ai_quota_rpcs.sql`): `consume_ai_quota` / `refund_ai_quota` SECURITY DEFINER RPCs with S1 guards; `analyze-paper` consumes a unit **before** calling Gemini, refunds best-effort on provider failure, and returns a structured **HTTP 402** when quota is unavailable.
- **Storage quota enforcement** (`20260521030000_harden_attachment_privacy_and_storage_quota.sql`): `user_storage_usage` plus atomic check-and-consume / refund triggers on `paper_attachments`.
- The schema is **provider-neutral**; no billing provider is wired into it yet.

**Not implemented** (do not describe these as existing):

- Paddle integration: checkout, webhook ingestion, subscription synchronization, customer portal.
- Billing / paywall / upgrade UI (nothing surfaces the 402 or storage-quota errors as an upgrade path yet).
- Free-tier feature gating of the Synonyms and Exclusions pools (launch blocker per [quotas-and-pricing.md](quotas-and-pricing.md)).
- Legal pages (privacy / terms / AI disclosure / support), account deletion, account-level data export.
- Marketing site, paid launch. **The product is not commercially launched.**

**Direction (decided, see [owner-decisions.md](owner-decisions.md) and C-numbered entries in [decisions-and-triggers.md](decisions-and-triggers.md)):** Merchant-of-Record-first billing (C17); **Paddle** selected for the web MVP (C18), gated on owner-side Paddle setup; Free → Pro two-tier MVP with baselines in [quotas-and-pricing.md](quotas-and-pricing.md) (C9–C11); web-first, mobile deferred (C7); Paperlume brand + domain (C19).

## Deployment and operations model

- **Frontend:** Vercel Git integration. Every PR gets a Preview deployment; every merge to `main` **auto-deploys to production** (`app.paperlume.app`). There is no manual promote step.
- **Database:** Supabase migrations are **not** auto-deployed. They are pushed manually (`supabase db push`) per the runbook in [deployment.md](deployment.md) §6.
- **Edge Functions:** deployed manually and separately per function (`supabase functions deploy <name> --project-ref lioxtgiputfniqbktcsz`); a GitHub merge alone does not update them. `GEMINI_API_KEY` is a manually set Supabase secret.
- **Auth email:** Supabase Auth Custom SMTP routes through Resend on `auth.paperlume.app` (owner-completed 2026-05-22; operational verification is owner-attested, see [deployment.md](deployment.md) §8a).
- Post-deploy smoke checklist and troubleshooting: [deployment.md](deployment.md) §9–§10.

## Testing and merge-safety baseline

- **There is no GitHub Actions CI** and **no branch protection on `main`** (re-verified 2026-07-18). Since merges to `main` auto-deploy the frontend, **the only merge gate is the author running checks locally.**
- Manual pre-merge baseline:
  - `npm run lint` — passes (0 errors).
  - `npm test` (Vitest) — passes.
  - `npm run build` — passes.
  - Targeted or full Playwright (`npm run test:e2e`) when UI behavior changes.
- **TypeScript status (important):** the root solution-style `tsconfig.json` has an empty file set, so plain `npx tsc --noEmit` checks **no application files** and is **not valid validation evidence**. The real application command is `npx tsc --noEmit -p tsconfig.app.json`, which **currently fails** (~dozens of diagnostics) — blocked primarily by the schema drift below plus source/test typing defects. `npx tsc --noEmit -p tsconfig.node.json` passes. No truthful `typecheck` package script exists yet.
- **Test layers that exist:**
  - Vitest unit/integration tests — pure lib logic, import parsers, export pipeline, hooks with a mocked Supabase client.
  - Playwright E2E — Chromium-only, single-worker serial, authenticated once via a dedicated test account (`.env.test`); it runs the local dev server **against the production Supabase project** (no isolated test environment exists).
- **Test layers that do not exist:**
  - Database tests (no pgTAP) — RLS isolation, S1 guards, and quota consume/refund atomicity have **no automated verification**.
  - Edge Function (Deno) tests — validation is manual post-deploy smoke (established metadata smoke case: PMID `41912805`).
  - Any CI execution of any layer.
- Do not cite exact test counts here — run the suites for current numbers.

## Active decisions and constraints — do not casually reopen

Authoritative record with rationale and re-evaluation triggers: [decisions-and-triggers.md](decisions-and-triggers.md).

- **Duplicate detection is PMID/DOI only.** Do not propose fuzzy or title-based matching.
- **Title-based import** auto-selects the first PubMed/Crossref match; the accepted mitigation is the static warning in the Add Papers dialog. Do not propose per-paper preview/confirmation flows.
- **CORS `*` on both Edge Functions is intentional** under header-based bearer-token auth. Revisit only if auth becomes cookie-based.
- **No real-Gemini / AI Playwright E2E** — rejected as non-deterministic; the AI path is covered by mocked Vitest tests plus manual smoke.
- **Read-path architecture is stable** (server-side filter/sort/paginate, keyword RPCs, on-demand abstracts, cache-key split, select-all-IDs). Changing it requires new evidence.
- **Deferred with documented triggers:** Phase C DB optimization (jsonb GIN indexes, RPC rewrites), unused-index cleanup, write-path optimization, Hebrew/RTL (C15), mobile packaging (C7).

## Current risks and owner blockers

**Engineering risks:**

- **Schema drift (highest-priority blocker, reconciliation in progress):** production predates the first tracked migration, so a clean replay of the tracked migrations produces a schema that materially differs from production even though the migration ledger fully matches. **RECON-JUNCTIONS-001, RECON-STATISTICAL-METHODS-001, and RECON-INTEGRITY-001 are complete** — merged, applied remotely, and verified; the aligned ledger holds **63** migrations. The remaining drift — the three empty production-only legacy columns (being removed by `RECON-LEGACY-COLUMNS-001`, the current task, under C21) and then metadata/index parity (`RECON-METADATA-PARITY-001`) — is being worked through the ordered RECON sequence. Generated Supabase types cannot be treated as authoritative until reconciliation completes; reconciliation precedes the TypeScript baseline and CI. Full inventory, owner decisions (C20–C25), and roadmap: [schema-reconciliation.md](schema-reconciliation.md). The audit confirmed RLS policies, security RPCs, and all commercial tables are **in parity** — enforcement is not broken.
- No CI / no branch protection while `main` auto-deploys (second-highest gap; gated behind reconciliation + TypeScript per C25).
- E2E runs against the production Supabase project; a staging environment is a pending owner decision.
- Supabase security advisors (2026-07-17): mutable `search_path` on five functions (incl. `search_papers`); SECURITY DEFINER RPCs executable by `anon` (all are `auth.uid()`-guarded, so unexploited, but the surface is wider than needed); Auth leaked-password protection disabled.
- Repository visibility is **public** — confirm this is intentional for a commercial codebase (no secrets are committed).

**Owner-action blockers (detail and ordering in [owner-decisions.md](owner-decisions.md)):**

- Paddle Sandbox setup: account, KYB, domain verification, Product + Price, API key, webhook secret, portal config, `APP_URL` (gates the Paddle integration PR).
- Marketing site provider + root-domain hosting; privacy/terms/AI-disclosure/support URLs (C16).
- Google Workspace business email; monitoring/error-tracking provider; staging-environment timing.

## Current recommended next action

Continue the approved schema-reconciliation sequence: **RECON-JUNCTIONS-001, RECON-STATISTICAL-METHODS-001, and RECON-INTEGRITY-001 are done** (merged, applied remotely, verified; 63 aligned ledger rows); **RECON-LEGACY-COLUMNS-001** is the current task (C21: drop the three empty production-only legacy columns — `papers.urls`, `synonym_pool.primary_term`, `synonym_pool.variants` — after re-proving emptiness at deploy time). Then `RECON-METADATA-PARITY-001` closes the remaining metadata/index drift. After exact schema parity is restored, resume the TypeScript baseline and then establish CI and branch protection. The full ordered sequence and per-migration rules are in [schema-reconciliation.md](schema-reconciliation.md) (decisions C20–C25).

## Authoritative documents

| Document | Authority |
|---|---|
| [README.md](../README.md) | Concise public/developer entry point |
| [architecture-read-path.md](architecture-read-path.md) | Read-path architecture detail |
| [decisions-and-triggers.md](decisions-and-triggers.md) | Durable decisions (C-numbers, S1/S2) + re-evaluation triggers |
| [owner-decisions.md](owner-decisions.md) | Owner gates, blockers, implementation unlock order |
| [deployment.md](deployment.md) | Deployment runbook, env vars, domains, smoke checklists |
| [commercial-architecture.md](commercial-architecture.md) | Entitlement/billing architecture |
| [quotas-and-pricing.md](quotas-and-pricing.md) | Plan structure, MVP baselines, instrumentation |
| [store-launch-checklist.md](store-launch-checklist.md) | Launch/store readiness (mobile deferred) |
| [schema-reconciliation.md](schema-reconciliation.md) | Schema drift inventory, canonical decisions C20–C25, reconciliation roadmap |
| [migration-history.md](migration-history.md) | Historical chronology (not current state) |
| [documentation-policy.md](documentation-policy.md) | Documentation rules, incl. this file's line budget |

## Recent material changes

Keep at most 5 items; remove the oldest when adding.

1. RECON-INTEGRITY-001 completed end-to-end (2026-07-19): twelve NOT NULL constraints enforced and the `synonym_pool.synonyms` empty-array default restored per amended C23 (PR #154), applied remotely and verified; aligned ledger now 63 migrations.
2. RECON-STATISTICAL-METHODS-001 completed end-to-end (2026-07-18): `papers.statistical_methods` converged to canonical JSON-string storage (PR #153), applied remotely and verified.
3. RECON-JUNCTIONS-001 completed end-to-end (2026-07-18): junction tables converged to composite PKs, migration applied remotely, exact junction parity verified (PR #152).
4. Read-only schema-reconciliation audit (2026-07-18) proved material production-vs-migrations drift despite full ledger parity; canonical decisions C20–C25 and the reconciliation roadmap recorded in [schema-reconciliation.md](schema-reconciliation.md).
5. ESLint baseline restored to zero errors (PR #150); lint is now a reliable local gate.
