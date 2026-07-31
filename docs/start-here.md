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
- **Backend:** Supabase — Postgres 17, Auth (JWT, localStorage-persisted sessions), Storage, PostgREST, and three **deployed** Edge Functions: `fetch-paper-metadata` (PubMed/Crossref metadata, v10), `analyze-paper` (Google Gemini analysis, v15), and `get-gemini-provider-quota` (v3). The third is **deployed but intentionally unused** — its manager-facing dashboard is **deferred under C29** (Gemini Free Tier during development; automatic provider-quota monitoring paused until commercialization), so **no frontend calls or renders it**; it remains as deferred infrastructure. No service-role key is used anywhere; Edge Functions authenticate with the caller's JWT via in-body `auth.getUser()` (`verify_jwt = false` at the gateway is intentional; CORS `*` is an accepted decision under bearer-token auth).
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

**Implemented and applied to the linked Supabase project** (the 2026-07-17 Phase 0 audit verified the commercial and RLS enforcement objects in parity by read-only remote inspection; subsequent bounded deployment work brought the linked project to the current **68-row aligned migration ledger** (last `20260726120000`, Local = Remote) and the current **three deployed Edge Functions** — `fetch-paper-metadata` v10, `analyze-paper` v15, and `get-gemini-provider-quota` v3 (the last deployed but intentionally unused under C29). Note that ledger parity does **not** imply full structural schema parity — see the drift risk below):

- **Entitlement/usage schema** (`20260521010000_add_entitlement_usage_schema.sql`): `user_entitlements`, `subscriptions`, `subscription_events`, `usage_counters`, `usage_credits`; `handle_new_user()` seeds a Free entitlement on signup. `subscriptions`/`subscription_events`/`usage_counters` are intentionally deny-all under RLS (server-only).
- **AI quota enforcement** (`20260521020000_add_ai_quota_rpcs.sql`): `consume_ai_quota` / `refund_ai_quota` SECURITY DEFINER RPCs with S1 guards; `analyze-paper` consumes a unit **before** calling Gemini, refunds best-effort on provider failure, and returns a structured **HTTP 402** when quota is unavailable.
- **Storage quota enforcement** (`20260521030000_harden_attachment_privacy_and_storage_quota.sql`): `user_storage_usage` plus atomic check-and-consume / refund triggers on `paper_attachments`.
- The schema is **provider-neutral**; no billing provider is wired into it yet.

**Not implemented** (do not describe these as existing):

- Paddle integration: checkout, webhook ingestion, subscription synchronization, customer portal.
- Billing / paywall / upgrade UI. **PFA-C01-AI-QUOTA-UX-001** added AI-quota **transparency** — a header usage indicator plus a clear, actionable message when the AI `402` is hit — but **no** upgrade/checkout/paywall path (shipped 2026-07-25, PR #166 merge `fb876c8`; migration `20260724120000` applied in Production). Storage-quota errors are still surfaced only as a raw message; no upgrade path exists for either.
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
- **CORS `*` on all three Edge Functions is intentional** under header-based bearer-token auth. Revisit only if auth becomes cookie-based.
- **No real-Gemini / AI Playwright E2E** — rejected as non-deterministic; the AI path is covered by mocked Vitest tests plus manual smoke.
- **Read-path architecture is stable** (server-side filter/sort/paginate, keyword RPCs, on-demand abstracts, cache-key split, select-all-IDs). Changing it requires new evidence.
- **Deferred with documented triggers:** Phase C DB optimization (jsonb GIN indexes, RPC rewrites), unused-index cleanup, write-path optimization, Hebrew/RTL (C15), mobile packaging (C7).

## Current risks and owner blockers

**Engineering risks:**

- **Schema drift — reconciliation complete:** production predated the first tracked migration, so a clean replay of the tracked migrations produced a schema that materially differed from production even though the migration ledger matched. **All reconciliation tasks are now complete** — RECON-JUNCTIONS-001, RECON-STATISTICAL-METHODS-001, RECON-INTEGRITY-001, RECON-LEGACY-COLUMNS-001, and the final **RECON-METADATA-PARITY-001** (PR #156) — merged, applied remotely, and verified (the reconciliation sequence itself ended at `20260719162013`); the aligned ledger now holds **68** aligned migrations, last `20260726120000`, Local = Remote (the Owner/Manager grant-hardening migration, applied 2026-07-26). Freshly generated **local and linked** `public`-schema Supabase types are **semantically identical**, and the committed generated types now match the linked output (TYPESCRIPT-BASELINE-001). `papers.search_vector` (proven semantically equivalent) remains an approved benign/artifact exclusion. The **SEC-4 default-grant diff was reclassified** (PFA-C03A1-L-GRANT-PARITY-001, 2026-07-31): it is **not** benign for a clean replay — the tracked migrations never granted the Data API roles their table privileges, so a fresh local reset yields `42501` and a non-functional app; a tracked least-privilege grant-parity migration now encodes the intended Data API surface (see [schema-reconciliation.md](schema-reconciliation.md)). Full inventory, owner decisions (C20–C26), and roadmap: [schema-reconciliation.md](schema-reconciliation.md). The audit confirmed RLS policies, security RPCs, and all commercial tables are **in parity** — enforcement is not broken.
- **CI and branch protection are now in place (CI-BASELINE-001):** the required `Validate` workflow gates pull requests to `main`, and `main` protection requires the `validate` check — closing the former top structural gap where `main` auto-deployed with no merge gate.
- E2E still runs against the production Supabase project. A staging environment is now the **owner-selected active initiative (PFA-C03, 2026-07-31)**; its contract is defined in [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md) (planning only — nothing provisioned yet).
- Supabase security advisors (2026-07-17): mutable `search_path` on five functions (incl. `search_papers`); SECURITY DEFINER RPCs executable by `anon` (all are `auth.uid()`-guarded, so unexploited, but the surface is wider than needed); Auth leaked-password protection disabled.
- Repository visibility is **public** — confirm this is intentional for a commercial codebase (no secrets are committed).

**Owner-action blockers (paused — detail and ordering in [owner-decisions.md](owner-decisions.md)):** these gate the paused commercial-launch work (C27). They are future-facing and are **not** the active next task.

- Paddle Sandbox setup: account, KYB, domain verification, Product + Price, API key, webhook secret, portal config, `APP_URL` (gates the Paddle integration PR — paused per C27).
- Marketing site provider + root-domain hosting; privacy/terms/AI-disclosure/support URLs (C16).
- Google Workspace business email; monitoring/error-tracking provider; staging-environment timing.

## Current recommended next action

**Public-launch and commercial-launch implementation remain paused by owner decision (C27, 2026-07-24).** Paddle integration, checkout, webhooks, paywalls, billing and public-launch work are **not on the active critical path** and must not be started without a new explicit owner decision. Owner-side Paddle Sandbox setup is **not** the next gate.

The active priority is **product feature and workflow development**. The high-priority UX/workflow-remediation sequence that preceded feature work is **complete**:

- **PROJECT-TAG-SELECTOR-UX-001 — completed (PR #162, merge `dedde4d0`).** Dashboard Project/Tag filters are searchable multi-select with long-name overflow fixed; presets payload **version 2** (backward-compatible v1 reads).
- **PROJECT-TAG-MATCH-MODE-001 — completed (PR #163, merge `b406e2f2`).** Each of the Project and Tag filters has an independent **Any/All** match mode (Any = OR-union within a category, All = AND-by-membership within a category; categories stay ANDed with each other and every other filter — **no** global cross-category OR). Default **Any**; presets payload **version 3** (backward-compatible v1/v2 reads normalized to Any/Any).
- **IMPORT-CONTINUATION-WORKFLOW-001 — completed (PR #164, merge `5a92229f`).** The Add Papers flow no longer dead-ends after an import: both identifier and file imports show the result summary **plus** Project/Tag assignment controls with an **Import More / Import Another File** loop that preserves selections for the next batch (a completed run is never retroactively re-assigned). No callback-contract, RPC, or schema change.

**PRODUCT-FEATURE-AUDIT-001 is complete** — merged via PR #165 (merge `214bc329`); its deliverable [product-feature-audit.md](product-feature-audit.md) is the point-in-time capability audit and owner decision packet (blocking-remediation gate **Outcome A**: no Critical/High blocker). **Owner selection is complete:** on 2026-07-24 the owner selected **PFA-C01** (complete the AI-analysis quota experience) as the first implementation candidate. Candidates **PFA-C02 and PFA-C04–PFA-C09 remain unselected** and must not be started without a new explicit owner decision; **PFA-C03 was owner-selected on 2026-07-31** (see the active-initiative note below).

**The most recent implementation task (PR #168) is complete — merged to `main` and live in Production:**

- **OWNER-MANAGER-ACCESS-AND-GEMINI-QUOTA-001 (2026-07-25, decision C28; scope-normalized 2026-07-26, decision C29).** A new **owner-selected objective, separate from the PFA candidate list**: internal `owner`/`manager` roles decoupled from the commercial plan (`internal_user_access` + read-only `get_current_user_access` RPC), an owner Paperlume **AI-quota exemption** (owner is never blocked, usage still recorded/refundable; AI indicator shows "Unlimited"), and structured provider-error handling + centralized Gemini model in `analyze-paper` (no prompt/schema/retry/timeout change; a provider limit is never turned into a Paperlume 402). **Both additive migrations are applied in Production** — `20260725090000` and the grant-hardening `20260726120000` — and the **owner bootstrap is complete and verified**; ledger aligned through `20260726120000` (68 rows). **Deployed functions:** `fetch-paper-metadata` v10, `analyze-paper` v15, and `get-gemini-provider-quota` v3. **Under C29 the manager-facing provider-quota dashboard is deferred:** Paperlume stays on the **Gemini Free Tier** with **Google Cloud billing intentionally disabled**; the deployed v3 function is **retained but intentionally unused** (no frontend renders the card or calls it — the frontend surface was removed in the 001Y scope normalization), and Gemini usage/limits are checked **manually via Google AI Studio**. Prior read-only Google-side evidence (`…-001S…001X`): Monitoring returns HTTP 403, project **billing disabled**, **no** project-level IAM deny policy, **no** parent org/folder. **PR #168 was merged** via a regular exact-head merge commit (`a1fc2cea53e33c8b34c557c7087236a939bb783c`, 2026-07-28); the three review threads are resolved, merged-main `Validate` (run `30357049945`) succeeded, and the Vercel **Production** deployment (`dpl_Bx1GyYog6KCDUjHtcHTFVWqySwoV`, READY) is live on `app.paperlume.app` (the GitHub merge applied no migration and deployed no Edge Function — Supabase state is unchanged). Runtime authorization is **UUID/role-based, never email-based**; the server (the deferred provider-quota function re-checking `get_current_user_access`) stays authoritative. **C27 unchanged** — no billing/paywall/upgrade; `usage_counters` privacy and Free/Pro quota values are unchanged. **PFA-C02 and PFA-C04–PFA-C09 remain unselected; PFA-C03 is now owner-selected (2026-07-31).**

PFA-C01 is complete, deployed, and accepted:

1. **PFA-C01-AI-QUOTA-UX-001 — complete, deployed, and accepted (2026-07-25, PR #166, merge `fb876c8b6020de83d23ce2877effa0881ed5c4e4`).** Delivered a read-only `get_ai_quota_status` RPC (server-only `usage_counters` stays server-only — no client SELECT), a header usage indicator (used/remaining, lifetime vs monthly, UTC reset date), a specific actionable message when the server returns the AI `402`, and a bulk run that stops after the first authoritative quota response with complete `analyzed + failed + not attempted = total` accounting. The additive migration `20260724120000_add_ai_quota_status_rpc.sql` is **applied in Production** (project `lioxtgiputfniqbktcsz`), the merged-main `Validate` run succeeded, and the automatic Vercel **Production** deployment is live on `app.paperlume.app`. The initial MCP-generated migration-history label (`20260725054400`) was **repaired** to the canonical `20260724120000` (migration-history metadata only — no schema SQL re-executed). It adds **quota transparency only — no checkout, paywall, or upgrade path** (C27 unchanged).
2. **Active initiative: PFA-C03 (owner-selected 2026-07-31).** The owner selected **PFA-C03 — safe staging environment and automated security tests** (the audit's two-phase approach: Phase A isolated test backend + non-required Playwright CI; Phase B automated DB-security tests). Its first bounded subtask, **PFA-C03A0 (staging contract + readiness audit)**, is a **planning/readiness** task — **not** implementation completion: it produced [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md) and **provisions nothing** (no staging project, secret, CI workflow, or database-test framework exists yet; the required `Validate` gate is unchanged). **PFA-C03 is not complete.** Decision **D2** was **resolved local-first** by the owner (2026-07-31): the selected path is **C03A1-L → C03A2-L** (the cloud phases C03A1-C/C03A2-C are not selected; D1 does not block the local path). Implementation of **C03A1-L** (local-stack seed/reset + env/guard contract) began and uncovered a tracked **Data API grant-parity prerequisite**: a fresh local `supabase db reset` does not reproduce the table GRANTs the app's Data API needs (Supabase's move to opt-in Data API exposure; Production still carries the old broad auto-grants), so `authenticated` gets `42501` and the app cannot run on a clean replay. That prerequisite is fixed by the separate bounded migration PR **PFA-C03A1-L-GRANT-PARITY-001** (a single least-privilege grant migration, local-replay-proven, Production not modified). The **C03A1-L implementation itself remains uncommitted and preserved** in its own workspace — **not review-ready** — and resumes only after the grant-parity PR merges and is finalized; **C03A2-L has not begun** and no staging project, secret, or CI workflow is provisioned. **PFA-C02 and PFA-C04–PFA-C09 remain unselected**; **C27–C29 unchanged.** The prior **OWNER-MANAGER-ACCESS-AND-GEMINI-QUOTA-001** (a separate, non-PFA objective) remains complete and merged.

The infrastructure baseline supports this work: schema reconciliation is complete, **68** aligned ledger rows (last `20260726120000`, Local = Remote), `npm run typecheck` is at **0 diagnostics** (TYPESCRIPT-BASELINE-001), and the required GitHub Actions `Validate` workflow with `main` branch protection is live (CI-BASELINE-001) — **this CI and branch-protection baseline remains mandatory for every remediation and feature PR**. The paused commercial direction remains valid future-facing work: C17/C18 (Paddle as the future MoR provider) and the built entitlement/quota/subscription/storage infrastructure are preserved, not cancelled — see C27 in [decisions-and-triggers.md](decisions-and-triggers.md) and [owner-decisions.md](owner-decisions.md).

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
| [product-feature-audit.md](product-feature-audit.md) | Point-in-time evidence-based capability audit and owner decision packet (not an evergreen authority) |
| [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md) | PFA-C03 staging + automated-security-test contract (planning only; nothing provisioned) |
| [migration-history.md](migration-history.md) | Historical chronology (not current state) |
| [documentation-policy.md](documentation-policy.md) | Documentation rules, incl. this file's line budget |

## Recent material changes

Keep at most 5 items; remove the oldest when adding.

1. PFA-C03A1-L-GRANT-PARITY-001 — **Data API grant parity (one tracked migration); local-replay-proven; Production not modified; open for review**. Unblocks the paused C03A1-L work. A fresh local `supabase db reset` did not reproduce the table GRANTs the Data API needs — the tracked migrations relied on Supabase's old auto-grant default (being removed in favor of **opt-in Data API exposure**), while Production still carries the broad `arwdDxtm` client grants — so `authenticated` hit `42501` and the app could not run on a clean replay. One additive least-privilege migration (`20260731162729_reconcile_data_api_grants.sql`) grants each **client** role only the operations its RLS policy already exposes (no `anon` DML; **nothing** on the server-only `usage_counters`/`subscriptions`/`subscription_events`/`internal_user_access`), plus `authenticated`+`service_role` `USAGE` on `papers_insert_order_seq` and an explicit server-side `service_role` object grant. RLS, policies, functions, ownership, and generated types are **unchanged**; grants are a strict **subset** of Production's, so Production client access is not broadened. Proven on a clean reset (twice, reproducible): authenticated own-user reads/writes succeed, cross-user reads/writes stay RLS-blocked, server-only tables stay `42501` for clients, and service-role paths + the signup trigger work. Read-only Production ledger comparison shows exactly one pending migration; **no Production migration was applied**. **C03A1-L stays uncommitted/preserved and incomplete; C03A2-L not begun; PFA-C03 not complete; C27–C29 unchanged; PFA-C02 & PFA-C04–PFA-C09 unselected.**
2. PFA-C03A0-STAGING-CONTRACT-001 (+ correction 001A) — **planning only; owner selected PFA-C03 on 2026-07-31** (audit two-phase approach: isolated test backend + non-required Playwright CI, then automated DB-security tests). Delivered the implementation/decision contract [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md): a full 13-spec Playwright inventory (6 read-only / 7 mutating, incl. one Storage and one external-provider spec) with cleanup-failure analysis; the environment-resolution trace showing Playwright today drives a **Production-backed** frontend (Vite reads `VITE_SUPABASE_*` from `.env`; `.env.test` only supplies test credentials) and a required **two-layer** fail-closed Production-ref guard (Node pre-server + browser-observed runtime); a **local-first** test-backend model (ephemeral local Supabase; Model A) with an **optional** persistent cloud-staging model (Model B); a reset-to-seed fixture contract; a non-required Playwright CI design that leaves `Validate` unchanged and required; a Phase B DB-security contract that **reuses/evolves** `supabase/tests/owner_access_and_quota_verification.sql` (adds cross-user RLS, S1 caller-mismatch, storage-quota, broadened grants, an expected-failure negative-control) on a **separate** non-required `db-tests` workflow; a bounded phased roadmap; and an owner decision packet. **Provisions nothing** — no project, secret, workflow, or DB-test framework created; **PFA-C03 is not complete**; next gate is independent review then a separately authorized first implementation phase. Docs-only (this file + the plan). **PFA-C02 and PFA-C04–PFA-C09 remain unselected; C27–C29 unchanged.**
3. OWNER-MANAGER-ACCESS-AND-GEMINI-QUOTA-001 — **complete: PR #168 merged to `main` via regular merge commit `a1fc2cea53e33c8b34c557c7087236a939bb783c` (2026-07-28); backend deployed; scope normalized for the Free Tier phase under C29** (2026-07-25→28, decisions C28 + C29). A new owner-selected objective (separate from the PFA list): internal `owner`/`manager` roles decoupled from the commercial plan (`internal_user_access` + read-only `get_current_user_access` RPC; server-only, FORCE RLS, no client policy), an owner **AI-quota exemption** (owner never blocked, usage still recorded/refundable; additive `is_exempt` on `get_ai_quota_status`; AI indicator shows "Unlimited"), and structured provider-error handling + centralized Gemini model in `analyze-paper` (no prompt/schema/retry/timeout change; a provider limit is never a Paperlume 402). **Both additive migrations are applied in Production** — `20260725090000` and the grant-hardening `20260726120000` (which `REVOKE`s direct `internal_user_access` privileges from PUBLIC/anon/authenticated atop FORCE RLS + no policy) — and the **owner bootstrap is complete and verified**; ledger aligned through `20260726120000` (68 rows). **Deployed functions:** `fetch-paper-metadata` v10, `analyze-paper` v15, `get-gemini-provider-quota` v3. The correction passes **001A/001B** (same PR #168, migration unchanged) fixed the reviewed Monitoring/UX edge cases (one metric type per request, ALIGN_SUM minute math, synchronized-bucket totals, DST-safe Pacific-day boundary, structured provider-500 parsing, authoritative "Unlimited" condition, identity-keyed credential/response caches, pagination-overflow fails unavailable). **Scope normalization 001Y (decision C29, 2026-07-26):** Paperlume stays on the **Gemini Free Tier** with **Google Cloud billing intentionally disabled**; the manager-facing provider-quota **dashboard is deferred**, so the **frontend provider-quota surface (card, fetch hook, client lib, query key) was removed** and the deployed v3 `get-gemini-provider-quota` function is **retained but intentionally unused** (no frontend calls it; usage/limits checked manually via Google AI Studio). Prior read-only Google-side evidence (`…-001S…001X`): Monitoring returns HTTP 403, project **billing disabled**, **no** project-level IAM deny policy, **no** parent org/folder. Runtime authorization is UUID/role-based, never email-based. **C27 unchanged**; `usage_counters` privacy and Free/Pro quotas unchanged. Merged-main `Validate` (run `30357049945`) succeeded and the Vercel **Production** deployment (`dpl_Bx1GyYog6KCDUjHtcHTFVWqySwoV`, READY) is live on `app.paperlume.app`; the three review threads are resolved. (Current PFA-selection state is in item 1, not this historical entry.)
4. PFA-C01-AI-QUOTA-UX-001 — **complete, deployed, and accepted** (2026-07-25, PR #166, merge `fb876c8b6020de83d23ce2877effa0881ed5c4e4`): the AI-analysis quota experience — a **read-only** `get_ai_quota_status` SECURITY DEFINER RPC (additive migration `20260724120000`; S1-guarded, `authenticated`-only, no write/consume/refund, no client SELECT on the server-only `usage_counters`), a header **AI-quota indicator** (used/remaining, lifetime vs monthly, UTC reset date; fails soft), a pure structured-`402` parser so quota exhaustion shows a specific actionable message (not the generic non-2xx string), and a **bulk run that stops after the first authoritative quota `402`** with complete `analyzed + failed + not attempted = total` accounting. **Quota transparency only — no checkout/paywall/upgrade (C27 unchanged).** The server remains the enforcement boundary. Migration `20260724120000` is **applied in Production** (project `lioxtgiputfniqbktcsz`); merged-main `Validate` succeeded; the automatic Vercel **Production** deployment is live on `app.paperlume.app`. The initial MCP-generated migration-history label `20260725054400` was repaired to the canonical `20260724120000` (history metadata only; no schema SQL re-executed). (At that PR, PFA-C02–PFA-C09 were all unselected and the next gate was an explicit owner selection — since satisfied by the PFA-C03 selection on 2026-07-31; current state is in item 1.)
5. PRODUCT-FEATURE-AUDIT-001 (2026-07-24, PR #165, merge `214bc329`): a repository-wide, evidence-based product-feature and incomplete-workflow audit at baseline `main` `5a92229f`, delivered as [product-feature-audit.md](product-feature-audit.md). It classifies 31 capabilities (22 shipped-complete / 3 partial / 4 infrastructure-only / 1 planning-only / 0 dormant / 1 unknown), records 9 findings and a 9-candidate ranked backlog, and prepares exactly three owner shortlist options. Blocking-remediation gate **Outcome A** (no Critical/High blocker). Documentation-only; the owner subsequently selected **PFA-C01**.