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

- **GitHub Actions CI is the required merge gate.** The **`Validate`** workflow (`.github/workflows/validate.yml`) runs `npm ci`, lint, `npm run typecheck`, Vitest and the production build on Node 22 for every pull request to `main` (and every push to `main`); `main` is protected to require the `validate` check — strict/up-to-date, administrators included, zero required human approvals, force-push and branch deletion disabled, regular merge commits allowed, Vercel **not** a required check. Because merges to `main` auto-deploy the frontend, the local commands below remain useful pre-push evidence but are no longer the sole gate.
- Local pre-push baseline (lint / typecheck / Vitest / build are also the required CI gate; Playwright is local-only):
  - `npm run lint` — passes (0 errors).
  - `npm run typecheck` — passes (0 diagnostics, both projects).
  - `npm test` (Vitest) — passes.
  - `npm run build` — passes.
  - Targeted or full Playwright (`npm run test:e2e`) when UI behavior changes.
- **TypeScript status:** the root solution-style `tsconfig.json` has an empty file set, so plain `npx tsc --noEmit` checks **no application files** and is **not valid validation evidence**. Use `npm run typecheck`, which runs both real projects — `typecheck:app` (`tsc --noEmit -p tsconfig.app.json`) and `typecheck:node` (`tsc --noEmit -p tsconfig.node.json`). Both currently pass with **0 diagnostics** (TYPESCRIPT-BASELINE-001 regenerated the authoritative Supabase types and eliminated the former ~48-diagnostic application baseline without weakening type safety).
- **Test layers that exist:**
  - Vitest unit/integration tests — pure lib logic, import parsers, export pipeline, hooks with a mocked Supabase client.
  - Playwright E2E — Chromium-only, single-worker serial, authenticated once via a dedicated test account (`.env.test`); it runs the local dev server **against the production Supabase project** (no isolated test environment exists).
- **Test layers that do not exist:**
  - Database tests (no pgTAP) — RLS isolation, S1 guards, and quota consume/refund atomicity have **no automated verification**.
  - Edge Function (Deno) tests — validation is manual post-deploy smoke (established metadata smoke case: PMID `41912805`).
  - CI execution of the **database** (pgTAP) or **Edge Function** (Deno) layers, or of the **Playwright** E2E suite. (Required CI *does* run lint, `npm run typecheck`, Vitest and the production build — see the merge-safety baseline above; the production-backed Playwright suite is excluded until an isolated staging project exists.)
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

- **Schema drift — reconciliation complete:** production predated the first tracked migration, so a clean replay of the tracked migrations produced a schema that materially differed from production even though the migration ledger matched. **All reconciliation tasks are now complete** — RECON-JUNCTIONS-001, RECON-STATISTICAL-METHODS-001, RECON-INTEGRITY-001, RECON-LEGACY-COLUMNS-001, and the final **RECON-METADATA-PARITY-001** (PR #156) — merged, applied remotely, and verified; the aligned ledger holds **65** migrations (last `20260719162013`). Freshly generated **local and linked** `public`-schema Supabase types are **semantically identical**, and the committed generated types now match the linked output (TYPESCRIPT-BASELINE-001). `papers.search_vector` (proven semantically equivalent) and the SEC-4 default-grant diff remain approved benign/artifact exclusions. Full inventory, owner decisions (C20–C26), and roadmap: [schema-reconciliation.md](schema-reconciliation.md). The audit confirmed RLS policies, security RPCs, and all commercial tables are **in parity** — enforcement is not broken.
- **CI and branch protection are now in place (CI-BASELINE-001):** the required `Validate` workflow gates pull requests to `main`, and `main` protection requires the `validate` check — closing the former top structural gap where `main` auto-deployed with no merge gate.
- E2E runs against the production Supabase project; a staging environment is a pending owner decision.
- Supabase security advisors (2026-07-17): mutable `search_path` on five functions (incl. `search_papers`); SECURITY DEFINER RPCs executable by `anon` (all are `auth.uid()`-guarded, so unexploited, but the surface is wider than needed); Auth leaked-password protection disabled.
- Repository visibility is **public** — confirm this is intentional for a commercial codebase (no secrets are committed).

**Owner-action blockers (paused — detail and ordering in [owner-decisions.md](owner-decisions.md)):** these gate the paused commercial-launch work (C27). They are future-facing and are **not** the active next task.

- Paddle Sandbox setup: account, KYB, domain verification, Product + Price, API key, webhook secret, portal config, `APP_URL` (gates the Paddle integration PR — paused per C27).
- Marketing site provider + root-domain hosting; privacy/terms/AI-disclosure/support URLs (C16).
- Google Workspace business email; monitoring/error-tracking provider; staging-environment timing.

## Current recommended next action

**Public-launch and commercial-launch implementation are paused by owner decision (C27, 2026-07-21).** Paddle integration, checkout, webhooks, paywalls, billing and public-launch work are **not on the active critical path** and must not be started as the next engineering task without a new explicit owner decision. Owner-side Paddle Sandbox setup is **no longer the next gate**.

The active priority is **product feature and workflow development** — new features, completion of incomplete user workflows, and improvements to existing functionality and usability. The infrastructure baseline is ready for that work: schema reconciliation is complete (all five RECON tasks merged and verified; **65** aligned ledger rows, last `20260719162013`), `npm run typecheck` is at **0 diagnostics** (TYPESCRIPT-BASELINE-001), and the required GitHub Actions `Validate` workflow with `main` branch protection is live (CI-BASELINE-001) — **this CI and branch-protection baseline remains active and must be used for every future feature PR**.

The next planning task is a **focused product-feature and incomplete-workflow audit and prioritization exercise** (do not select or implement a feature before that audit). The paused commercial direction remains valid future-facing work: C17/C18 (Paddle as the future MoR provider) and the built entitlement/quota/subscription/storage infrastructure are preserved, not cancelled — see C27 in [decisions-and-triggers.md](decisions-and-triggers.md) and [owner-decisions.md](owner-decisions.md).

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
| [schema-reconciliation.md](schema-reconciliation.md) | Schema drift inventory, canonical decisions C20–C26, reconciliation roadmap |
| [migration-history.md](migration-history.md) | Historical chronology (not current state) |
| [documentation-policy.md](documentation-policy.md) | Documentation rules, incl. this file's line budget |

## Recent material changes

Keep at most 5 items; remove the oldest when adding.

1. PRODUCT-DIRECTION-RESET-001 (2026-07-21, docs only): by owner decision (C27), public-launch and commercial-launch **implementation** are **paused** and off the active critical path — Paddle integration, checkout, webhooks, paywalls, billing and public-launch work must not start as the next engineering task without a new explicit owner decision. The active priority returns to **feature and workflow development**; the next planning task is a focused product-feature/incomplete-workflow audit. Commercialization is paused, **not cancelled**: C17/C18 and the built entitlement/quota/subscription/storage infrastructure are preserved as future-facing. The required CI + branch-protection baseline stays active for all feature PRs. No code, database, CI, deployment or production change.
2. CI-BASELINE-001 established the required GitHub Actions CI baseline: the **`Validate`** workflow (`.github/workflows/validate.yml`) runs `npm ci`, lint, `npm run typecheck`, Vitest and the production build on Node 22 for pull requests to `main`, pushes to `main`, and manual dispatch — official actions pinned to full commit SHAs, read-only token, inert placeholder build env (no secrets). `main` protection now requires the `validate` check (strict/up-to-date, administrators included, zero human approvals, force-push and deletion disabled, regular merge commits allowed, Vercel not required). Playwright is intentionally excluded from required CI (production-backed E2E, no isolated staging). No migration or database mutation occurred.
3. TYPESCRIPT-BASELINE-001 completed end-to-end (2026-07-21, PR #157, merge `2161ba6e`): committed the authoritative linked `src/integrations/supabase/types.ts` (local and linked `public`-schema types semantically identical), reduced the former ~48-diagnostic application TypeScript baseline to **0** (Node remains **0**) without weakening type safety, and added the truthful `typecheck` / `typecheck:app` / `typecheck:node` npm scripts. Two reviewed remediation commits within the same PR hardened runtime type boundaries: the duplicate-scan RPC JSON is now runtime-validated, duplicate groups enforce an at-least-two invariant, duplicate consolidation is transitively connected-component-safe, and project/tag mutation cache targeting was corrected. Full lint, typecheck, Vitest, build and targeted Playwright validation passed; no migration or database mutation occurred.
4. RECON-METADATA-PARITY-001 completed end-to-end (2026-07-20, PR #156, merge `4f26c85d`): the final metadata/index parity migration (`20260719162013_reconcile_metadata_parity.sql`) merged and applied remotely as an S2 convergence (eight `created_at` defaults → `now()`); aligned ledger now **65** migrations, schema and generated-type parity verified; `search_vector`/SEC-4 grants retained as approved benign/artifact exclusions.
5. RECON-LEGACY-COLUMNS-001 completed end-to-end (2026-07-19): the three empty production-only legacy columns (`papers.urls`, `synonym_pool.primary_term`, `synonym_pool.variants`) dropped per C21 (PR #155), applied remotely and verified.
