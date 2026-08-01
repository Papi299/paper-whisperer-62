# PFA-C03 — Staging Environment and Automated Security-Test Contract

> **Status: active contract — C03A1-L merged and accepted.** This document is the durable implementation and decision contract for **PFA-C03 — Safe staging environment and automated security tests**. **C03A0** (this contract) is complete; **C03A1-L** (local-stack seed/reset + env/guard foundation) is now **merged to `main` and independently accepted** (PR #173, merge `299b19a…` — see §7.3, §10, §14); **C03A2-L** (non-required local Playwright CI workflow) is **next but unstarted**; **Phase B** is unstarted; **PFA-C03 is incomplete.** No **cloud** Supabase project, GitHub secret, CI workflow (E2E/DB-test), database-test framework, or cloud fixture exists — every such artifact named below remains a **recommendation or future artifact**, not a deployed one; the only merged deliverable is the repo-local C03A1-L lifecycle.
>
> **Owner selection.** The owner selected **PFA-C03** on 2026-07-31. Its first bounded subtask, **PFA-C03A0** (contract + readiness audit), produced this contract; the next subtask, **PFA-C03A1-L** (local-stack seed/reset + env/guard foundation), has since been **implemented, merged, and independently accepted** (PR #173, merge commit `299b19a08da0a61984bf2333d12406cbfd62aef7`, merged-main `Validate` run `30697869074` success, Vercel Production `dpl_9zhjYVmjLKTKqrt7PW6haZej9rLf` READY on `app.paperlume.app` — see §7.3, §10, §14). This document still ships no cloud project/workflow/framework of its own. **PFA-C03 is not complete.**
>
> **Labels used throughout:** `[FACT]` current repository truth · `[REC]` recommendation · `[FUTURE]` future implementation · `[OWNER]` owner action · `[DECISION]` unresolved owner decision.
>
> **Model naming (read this first).** The 2026-07-24 audit called its *two-phase structure* "Model A" (Phase A = test backend + non-required Playwright CI; Phase B = DB-security tests). **This contract keeps that two-phase structure but reuses the names "Model A / Model B" for the *test-backend* decision**, which is the substantive architecture choice:
> - **Model A — local-first (recommended default):** an **ephemeral local Supabase stack** started inside CI; no cloud project, region, plan, cloud account, or cloud reset credential.
> - **Model B — persistent cloud staging:** a separate Supabase **cloud** project — chosen either as a deliberate **cloud-first** architecture (decision D2), or added **later for parity** when a wave demonstrates a need Model A cannot cover.
>
> Local-first is the **recommendation, not a mandate**; cloud-first is a genuine D2 option (§7.3, §12). Which Phase A phases are *required* depends on that D2 choice (§10).
>
> Where the audit's two-phase structure is meant, this document says **"Phase A / Phase B"**, never "Model A", to avoid collision.

---

## 1. Status and scope

- **Initiative:** PFA-C03 (product-feature-audit candidate; §12/§14 of [product-feature-audit.md](product-feature-audit.md)). Two phases: **Phase A** = an isolated test backend + a non-required Playwright CI job; **Phase B** = representative automated database-security/integrity tests. `[FACT]`
- **This task:** PFA-C03A0 — produce the contract and readiness audit only. Two documentation files change: this file and [start-here.md](start-here.md). No code, tests, workflows, packages, configuration, migrations, or generated types change. `[FACT]`
- **In scope of the contract (planning):** the local-first vs optional-cloud test-backend decision tree; deterministic fixtures/reset/cleanup; a two-layer fail-closed Production guard; a non-required Playwright CI job; a **separate** non-required Phase B database-security suite that reuses/evolves the existing SQL verification with an expected-failure negative-control; a phased PR roadmap; owner actions with public-config-vs-secret classification; an owner decision packet; a risk register; a definition of done. `[REC]`
- **Explicitly out of scope of this task:** provisioning anything, running Playwright, running any Supabase stack or CLI mutation, changing `.github/workflows/validate.yml`, adding a workflow, adding secrets, or merging. `[FACT]`
- **Guardrails that constrain the whole plan:** C27 (commercialization paused), C28 (owner/manager roles + owner AI exemption), C29 (Gemini Free Tier; Google Cloud billing disabled; provider-quota dashboard deferred) all remain **unchanged**. The required `Validate / validate` gate remains **unchanged and required**; any Phase A/B job is a **separate** workflow/check, never a new job silently added to `Validate`. Playwright-against-Production and real-Gemini Playwright remain **prohibited**. `[FACT]`

---

## 2. Verified current baseline

All items independently reconfirmed on this branch (`docs/pfa-c03-staging-contract`, cut from `origin/main` `5b78b08d`).

### 2.1 Required CI

- `.github/workflows/validate.yml`, workflow name `Validate`, job `validate`, on `pull_request → main`, `push → main`, and `workflow_dispatch`. Runs `npm ci` → tool-version report → `npm run lint` → `npm run typecheck` → `npm test` (Vitest) → `npm run build`. Node `22.x`, `ubuntu-24.04`, `timeout-minutes: 20`, `permissions: contents: read`, concurrency-cancel. Build env supplies **inert public placeholders** `VITE_SUPABASE_URL=https://example.supabase.co` and `VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-publishable-key`. **No** Playwright, browser install, Supabase command, migration replay, database test, or deployment. `[FACT]`
- This workflow is the sole required merge gate for `main` and must not be weakened, renamed, reordered, made to depend on staging, or extended with a Phase A/B job. `[FACT]`

### 2.2 Playwright model

- `playwright.config.ts`: `testDir ./e2e`, `fullyParallel: false`, `workers: 1`, `retries: CI ? 2 : 0`, `timeout: 30_000`, `reporter: CI ? "github" : "list"`. Two projects: `setup` (matches `global-setup.ts`) and `chromium` (depends on `setup`, `storageState: e2e/.auth/user.json`). `webServer.command: "npm run dev"`, `port: 8080`, `reuseExistingServer: !CI`. `use.baseURL = process.env.BASE_URL || "http://localhost:8080"`. `[FACT]`
- `playwright.config.ts` manually parses `.env.test` (if present) and injects **only** the keys it finds there into `process.env`, without overwriting values already set (`if (!process.env[key])`). `[FACT]`
- `e2e/global-setup.ts`: reads `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` (throws if missing), signs in through the real `/auth` UI, and asserts the dashboard renders a paper count (`/\d+\s+paper/i`) before saving `storageState` to `e2e/.auth/user.json`. **This hard-requires the test account to have ≥ 1 paper.** It runs in Node/Playwright and drives the browser; it does **not** and cannot read the browser's `import.meta.env` directly (see §5). `[FACT]`

### 2.3 Frontend env contract

- `src/lib/clientEnv.ts`: `requireClientEnv(name)` reads `import.meta.env[name]` and throws an actionable error if empty/blank. `src/integrations/supabase/client.ts` calls it for `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` at module load and constructs the Supabase client. `[FACT]`
- `vite.config.ts` is minimal (React SWC, `@` alias, dev server on port 8080); it does **not** customize env-file loading, so Vite's default dotenv resolution applies. `[FACT]`
- Tracked env examples: `.env.example` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) and `.env.test.example` (`TEST_USER_EMAIL`, `TEST_USER_PASSWORD`, optional `BASE_URL`). `.gitignore` ignores `.env` and `.env.*` except those two examples, and ignores `e2e/.auth/user.json`. `[FACT]`

### 2.4 Supabase backend

- `supabase/config.toml`: `project_id = "lioxtgiputfniqbktcsz"` (Production ref); `verify_jwt = false` for all three functions (in-body `auth.getUser()` is authoritative). `[FACT]`
- Migrations: **69** tracked files, chain `20260203072053_… → 20260731162729_reconcile_data_api_grants.sql`; storage/quota-relevant migrations include `20260318010000_add_paper_attachments`, `20260318020000_add_attachments_storage_policies`, `20260327100000_private_attachments_bucket`, `20260521030000_harden_attachment_privacy_and_storage_quota`, plus the entitlement/quota schema `20260521010000` and AI-quota RPCs `20260521020000` / `20260724120000` / `20260725090000`. `[FACT]`
- Edge Functions (source in `supabase/functions/`): `fetch-paper-metadata`, `analyze-paper`, `get-gemini-provider-quota`, plus shared helpers. Secret names referenced: `GEMINI_API_KEY`, `GEMINI_MODEL` (optional override), `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_MONITORING_CLIENT_EMAIL`, `GOOGLE_MONITORING_PRIVATE_KEY`. External hosts referenced: PubMed (`eutils.ncbi.nlm.nih.gov`, `pubmed.ncbi.nlm.nih.gov`), Crossref (`api.crossref.org`, `doi.org`), Google (`generativelanguage.googleapis.com`, `monitoring.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com`), `esm.sh`. `[FACT]`

### 2.5 Existing database verification

- `supabase/tests/owner_access_and_quota_verification.sql` exists: local-only, framework-free, single transaction wrapped in `BEGIN … ROLLBACK`, run manually via `psql -v ON_ERROR_STOP=1` against a local stack. It simulates callers with `SET LOCAL ROLE authenticated` + a `request.jwt.claims` GUC and covers **18 cases**: role resolution (user/owner/manager) and `is_exempt` via `get_current_user_access()`; ordinary user cannot read/insert/update `internal_user_access`; anon cannot execute the access RPC; null-auth rejection; no arbitrary-user inspection (0-arg RPC); Free 15-lifetime cap; Pro 350-monthly cap; exempt owner allowed beyond cap with usage still incrementing; exempt refund decrements the same bucket; refund floor at 0; missing/inactive entitlement safety; `is_exempt` reporting; no email-based role column; grant hardening (FORCE RLS, zero policies, revoked direct grants for anon/authenticated, retained `service_role` CRUD, RPC EXECUTE boundary). `[FACT]`
- **This is the reusable Phase B seed.** It is not absent and must not be duplicated or ignored. §9 evolves it. `[FACT]`

---

## 3. Changes since the 2026-07-24 product-feature audit

- **`supabase/tests/` now exists.** The audit stated "no `supabase/tests`". That is no longer accurate: `owner_access_and_quota_verification.sql` (18 cases) is committed. Phase B **reuses** it. `[FACT]`
- **Baseline commit advanced** `5a92229f` → `5b78b08d` (PRs #165–#169 merged). `[FACT]`
- **Three Edge Functions are deployed** (`fetch-paper-metadata` v10, `analyze-paper` v15, `get-gemini-provider-quota` v3), the third deployed-but-unused under C29. `[FACT]`
- **C29 exists** (2026-07-26): Gemini Free Tier; Google Cloud billing disabled; provider-quota dashboard deferred. No test backend replicates Google Monitoring or the provider-quota path (§6). `[FACT]`
- **Unchanged since the audit:** Playwright still runs the local dev server against the **Production** Supabase project and is excluded from required CI; there are still no pgTAP tests and no CI execution of the database or Edge-Function layers; required CI is still lint + typecheck + Vitest + build only. `[FACT]`

---

## 4. Full E2E inventory

`e2e/` contains **13 spec files** plus `global-setup.ts` (auth setup) and `helpers.ts` (shared mutating helpers). All run Chromium-only, single-worker, serial, using the one authenticated `storageState`. Every spec that calls `waitForDashboard`/the `\d+ paper` assertion depends on the account having **≥ 1 paper**.

### 4.1 Classification matrix

| Spec | Primary workflow | Class | DB/Storage entities touched | Cleanup | Model-A (local) safe? | Initial CI subset? |
|---|---|---|---|---|---|---|
| `auth.spec.ts` | Auth page + logged-in dashboard | **Read-only** | none | n/a | Yes | **Yes** |
| `bulk-actions.spec.ts` | Select-all / selection toolbar | **Read-only** | none (select/deselect only) | n/a | Yes | **Yes** |
| `eager-load.spec.ts` | Lazy-load, select-all-IDs, export menu | **Read-only** | none (opens export menu; never exports/mutates) | n/a | Yes | **Yes** |
| `filters.spec.ts` | Search box, year filters, clear, columns | **Read-only** | none | n/a | Yes | **Yes** |
| `paper-import.spec.ts` | Add-Papers dialog states | **Read-only** | none (never submits an import) | n/a | Yes | **Yes** |
| `pools.spec.ts` | Sidebar pools/projects/tags dialogs, export menu | **Read-only** | none (opens dialogs only) | n/a | Yes | **Yes** |
| `filter-presets.spec.ts` | Saved-search CRUD | **Mutating** | `filter_presets` (insert/update/rename/delete) | `beforeEach` + `afterEach` delete all `E2E-*` presets | Yes (prefix-isolated) | Wave 2 |
| `file-import-order.spec.ts` | `.bib` file import + order | **Mutating** | `papers` (+ junctions) create/delete; **no external call** | pre-clean + post-clean by `E2E-Test*` prefix | Yes | Wave 2 |
| `mutations.spec.ts` | Create project/tag, assign to first paper, statistical-methods round-trip | **Mutating** | `projects`, `tags`, junctions, one manual `papers` row | in-test removal + `finally` paper delete | Yes (needs seed) | Wave 3 |
| `notes.spec.ts` | Notes add/edit/clear/filter/search | **Mutating** | `notes` field of 2 pre-existing papers | per-test restore-to-empty + `afterAll` defensive clear | Yes (needs seed) | Wave 3 |
| `search-attribution.spec.ts` | 6-field `Matched in:` attribution | **Mutating** | title/authors/journal/abstract/keywords/notes of **first** paper | `afterAll` restores captured originals | Yes (needs disposable paper) | Wave 3 |
| `attachments.spec.ts` | Attachment upload/open/refresh/delete | **Mutating + Storage** | `paper_attachments` rows + private-bucket objects; signed-URL HEAD fetch | pre-clean + in-group delete | Yes — local Supabase includes Storage | Wave 3 |
| `import-order.spec.ts` | PMID import + order | **Mutating + external** | `papers` via `fetch-paper-metadata` → PubMed/Crossref | pre-clean + post-clean | Only with local Edge Functions served + network egress | Wave 4 / gated |

### 4.2 Per-spec detail (auth, pre-existing data, external calls, order dependence, cleanup-failure consequence, remediation)

- **auth** — logged-out (fresh `storageState: undefined`) + shared logged-in state; ≥ 1 paper; no external calls; independent; no cleanup. `[FACT]`
- **bulk-actions / eager-load / filters / paper-import / pools** — shared logged-in state; ≥ 1 paper (eager-load adds assertions only when the library is large, and select-all asserts selected == total); read-only; no cleanup. For eager-load to exercise the large-library branch, a seed > 100 papers is desirable but not required. `[FACT]`
- **filter-presets** — ≥ 1 paper (dashboard loads); no external; serial; robust `E2E-`-prefix cleanup (`beforeEach`/`afterEach`, capped loop). Cleanup-failure: orphaned `E2E-*` presets, reaped next run. Some empty-state assertions assume no non-`E2E-` presets (defensively skipped) — a dedicated seed satisfies this. `[REC]`
- **file-import-order** — imports 3 papers from `e2e/fixtures/test-import-order.bib` (client-parsed, no external metadata); asserts reverse-insert order + two refreshes + `+3` delta; strictly serial (count-sensitive); leftover `E2E-Test*` reaped by pre-clean. **No concurrent library writer during it.** `[FACT]`
- **mutations** — creates `_e2e_proj_<ts>`/`_e2e_tag_<ts>`, assigns to the **first row** (`insert_order DESC`), then unassigns + deletes; second group creates/deletes a manual `_e2e_paper_<ts>`. Serial; depends on a stable first paper. Leftover `_e2e_*` on crash. Remediation: deterministic seed + unique names (already good). `[FACT]`
- **notes** — picks the first two of the first-30 rows with **no** notes indicator; unique per-run tokens; restores empty per test + `afterAll`. Needs **≥ 2 note-less papers in the first 30 rows**. No external; serial. Remediation: a seed with known note-less papers. `[FACT]`
- **search-attribution** — appends per-field tokens to **all six** searchable fields of the **first** paper; `afterAll` writes captured originals back. Serial. **Highest cleanup-failure blast radius:** an `afterAll` failure leaves a paper carrying `e2eattr*` across six fields. Remediation: run against a **disposable seeded paper** created/destroyed per run, not a real first paper. `[REC]`
- **attachments** — uploads `fixtures/test-attachment.png` to the private bucket for the **first** paper, opens the signed URL (in-page `HEAD` → 200), asserts persistence, deletes; group 2 confirms the SVG is rejected **client-side**. Needs the private bucket + owner-scoped policies + storage-quota triggers (**all created by migration replay; no cloud required — local Supabase provides Storage**). Leftover object/row reaped by pre-clean. `[FACT]`
- **import-order** — imports fixed PMIDs `39140285/6/7` through `fetch-paper-metadata` → **live PubMed/Crossref** and asserts specific title prefixes + `+3` + order. Needs `fetch-paper-metadata` **served** (locally via `supabase functions serve`, or cloud) + network egress. External-metadata drift is real; gate last and assert on stable identifiers/counts, not exact remote titles, or use a deterministic stand-in. `[FACT]`

### 4.3 Shared modules

- **`e2e/global-setup.ts`** — the single auth gate; requires `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` and a ≥ 1-paper account. `[FACT]`
- **`e2e/helpers.ts`** — mutating helpers (`importPapersByIds`, `deletePapersByTitleSubstrings`, `createProject`/`createTag`/`deleteProject`/`deleteTag`, `openEditPaperDialog`) + read helpers. Underpins cleanup. `[FACT]`
- **`e2e/fixtures/`** — `test-attachment.png`, `test-import-order.bib`, `test-invalid.svg`. `[FACT]`

**Cleanup caveat (mandated):** several specs are "safe" only if `afterAll`/`finally` cleanup succeeds. `search-attribution` (six real fields) and `mutations`/`attachments` (first-row dependence) are **not** safe against a crash, cancelled run, or overlapping run. The reset model in §7 must not treat cleanup helpers as the isolation boundary.

---

## 5. Environment-resolution analysis and the executable two-layer Production guard

### 5.1 How values resolve today `[FACT]`

Two **independent** environment surfaces exist during a Playwright run; conflating them is the root risk:

1. **The Playwright runner process (Node)** — `playwright.config.ts` reads `.env.test` and sets `TEST_USER_EMAIL`, `TEST_USER_PASSWORD`, and (if present) `BASE_URL` into `process.env` (non-overwriting). `global-setup.ts` consumes the two credentials; `baseURL` defaults to `http://localhost:8080`.
2. **The Vite dev server (browser bundle)** — `webServer.command: "npm run dev"` (= `vite`, development mode). The frontend's `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` resolve through **Vite's own dotenv loading**, which reads `.env` / `.env.local` — **not** `.env.test`. On this machine the untracked `.env` defines both `VITE_` variables and references the Production ref `lioxtgiputfniqbktcsz` exactly once (confirmed by name/count only; values not printed).

**Distinctions that matter:** the *frontend URL under test* = `baseURL` (`localhost:8080`); the *Supabase project the frontend talks to* = whatever `import.meta.env.VITE_SUPABASE_URL` resolves to (**today, Production**); the *authenticated account* = `.env.test` credentials (the Production-backed `ps4` account); the *Edge Functions reached* = the resolved project's.

### 5.2 The finding `[FACT]`

**Playwright today drives a Production-backed frontend as a real Production account.** `.env.test` supplies only the runner's credentials and base URL; it does **not** repoint the frontend's Supabase project. There is currently **no** mechanism that redirects the tested frontend to a non-Production backend.

### 5.3 Why one guard is not enough `[FACT]`/`[REC]`

- Node/CI `process.env` proves the **intended** configuration, but Node **cannot read the browser's `import.meta.env`** — those values are inlined into the Vite bundle at dev-server start and live only in the browser runtime. A `process.env` check therefore cannot prove which backend the loaded frontend **actually** talks to.
- Conversely, the browser can observe the backend it actually uses, but a browser-only check runs too late to stop a misconfigured server from starting.

Both layers are required: Layer 1 prevents a wrong server from ever starting; Layer 2 proves the running frontend actually points where intended, **before** any credential is entered or any mutation occurs.

### 5.4 Layer 1 — pre-server Node/CI guard `[REC]` / `[FUTURE]`

A CI/Node preflight step, before `vite` starts, that:

1. **Requires the complete backend target configuration** (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `TEST_USER_EMAIL`, `TEST_USER_PASSWORD`) and **materializes the `VITE_` values deterministically into the file Vite reads** (job-scoped `.env.local`/`.env`) rather than assuming `process.env` inlining.
2. **Rejects blank/missing values** — fail the job; never fall through to defaults, `.env.local` on a developer machine, or Production.
3. **Parses the configured Supabase URL** and:
   - **rejects the Production ref `lioxtgiputfniqbktcsz`** outright;
   - **Model A:** requires a **local** Supabase host (e.g. `127.0.0.1`/`localhost` on the local API port) and **rejects any remote Supabase host**;
   - **Model B:** requires the **exact approved staging ref/host** and rejects anything else (including Production).
4. **Never prints key/password values** (mask; assert on host/ref substrings only).

### 5.5 Layer 2 — browser-observed runtime guard `[REC]` / `[FUTURE]`

Inside Playwright, **before** entering credentials or mutating anything (i.e. at the very start of `global-setup.ts`, after the first navigation), verify the backend the loaded frontend actually uses, via **one** implementation-ready mechanism:

- **(Recommended) Network observation:** load the app, capture the host of the frontend's **first Supabase request** (e.g. a `**/rest/v1/**` or `**/auth/v1/**` call via `page.waitForRequest`/routing), and assert that host equals the approved expected host/ref and is **not** the Production ref; or
- **Sanitized runtime indicator:** expose a **test-only**, key-free project-ref/host indicator (e.g. a `data-…` attribute or a `window.__E2E_SUPABASE_HOST__` set from `import.meta.env.VITE_SUPABASE_URL`'s host only — **never** the publishable key or any secret) and read it through the browser.

If the observed host is Production or unexpected, throw before authentication so no credential is submitted and no data is touched. This is the guard that closes the gap `process.env` cannot: it confirms the **actually-loaded** bundle's backend.

### 5.6 Guard summary

| | Layer 1 (Node/CI, pre-server) | Layer 2 (browser, pre-auth) |
|---|---|---|
| Runs | before `vite` starts | after app load, before credentials |
| Proves | intended configuration is complete + non-Production | the loaded frontend actually talks to the approved backend |
| Reads | `process.env` / materialized env file | live Supabase request host or sanitized runtime indicator |
| Cannot | see the actually-loaded bundle | prevent a wrong server from starting |

---

## 6. Recommended test-backend resource contract

`[REC]` unless marked `[OWNER]`/`[DECISION]`. **Model A is the recommended default; Model B is the backend for a cloud-first D2 selection or for later cloud parity.**

### 6.1 Model A — local-first (recommended default)

- CI starts an **ephemeral local Supabase stack** (`supabase start`) in the job; the full **69-migration chain is replayed** locally; deterministic Auth users + seed data are created locally; Vite and Playwright point **only** at the local stack; the stack is destroyed after the run. `[REC]`
- **No cloud Supabase project, region, plan, cloud account, or cloud reset credential is required. No sensitive cloud secret is needed for the local path.** `[REC]`
- Model A serves: the initial read-only Playwright subset; the deterministic mutating waves (`filter-presets`, `file-import-order`, `mutations`, `notes`, `search-attribution`); **attachments** (local Supabase includes **Storage** and **Auth**); and all of **Phase B**. `[REC]`
- **Do not claim Storage or ordinary Auth alone requires cloud** — local Supabase provides both. Concrete capabilities that genuinely need cloud (Model B) are narrow: **real outbound email delivery** (password-reset/confirmation via Resend/SMTP), **production-parity edge/CDN or signed-URL behavior** if a spec depends on it, and **cloud-only quota/limit behavior**. None of the 13 current specs require these except optionally `import-order` (external metadata egress, which local `supabase functions serve` + network can also cover). `[REC]`

### 6.2 Model B — persistent cloud staging (cloud-first, or optional parity)

Chosen either as a deliberate **cloud-first** architecture (D2 option B), or added **later for parity** when a wave has a **demonstrated** requirement Model A cannot cover:

- A **separate** Supabase **cloud** project (distinct ref/URL/keys), name `paperlume-staging`; never a prefix inside Production; never re-link the repo away from Production (`supabase/config.toml`'s `project_id` stays Production; staging commands pass `--project-ref` or use a separate context). `[REC]` `[OWNER]`
- **Dedicated cloud staging accounts** (never the Production `ps4` account). `[FACT]`/`[REC]`
- **Environment-scoped GitHub configuration and credentials** (see §6.3), serialized reset/reseed, and an explicit **plan + region** decision (D1). `[OWNER]` `[DECISION]`

### 6.3 Configuration vs secrets (applies to both models)

Distinguish **public client configuration** (safe to expose to the built client; may still be scoped in an Environment for tidiness) from **actual secrets** (must be protected and never logged):

| Public client configuration | Sensitive secrets / operational config |
|---|---|
| `VITE_SUPABASE_URL` | `TEST_USER_PASSWORD` |
| Supabase **project ref** | Cloud **reset/DB password** (Model B only) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` (anon/publishable — a public client key by design) | Supabase **access token** (Model B only) |
| | Any service-role / service credential |
| | `TEST_USER_EMAIL` — treat as **sensitive operational config** (not cryptographic, but do not broadcast) |

Do **not** describe the publishable client key as a private credential. For **Model A**, the sensitive set reduces to `TEST_USER_PASSWORD` (+ `TEST_USER_EMAIL` handled carefully); there is **no** cloud reset/DB password, access token, or service credential.

### 6.4 CI hardening (both models)

- **Least privilege:** `permissions: contents: read` plus only what a step needs. `[REC]`
- **Fork-PR protection:** any secret-using job triggers on `workflow_dispatch` and/or same-repo `push`/`pull_request` only, and/or is gated behind a protected GitHub **Environment** with required reviewers — **no** fork PR receives secrets. (Model A's local path needs no cloud secret, shrinking this surface to `TEST_USER_*`.) `[REC]`
- **Concurrency:** one run at a time (`concurrency` + `cancel-in-progress`) so count-sensitive specs never overlap. `[REC]`
- **Timeout:** explicit `timeout-minutes` ≤ 20. **Artifacts:** Playwright `trace`/`screenshot` with bounded retention (~7 days); **never** upload env files or secrets. `[REC]`
- **Two-layer Production-ref guard** (§5). `[REC]`

### 6.5 What no test backend replicates

No Google Monitoring credentials, no `GOOGLE_*`, no provider-quota path (C29); no Production owner/manager bootstrap (internal roles are seeded with synthetic UUIDs, as the SQL test already does); no real commercial/billing identifiers. `[FACT]`/`[REC]`

---

## 7. Recommended fixture, reset, and cleanup model

### 7.1 Options considered `[REC]`

| Approach | Determinism | Failure tolerance | Fit here |
|---|---|---|---|
| Unique per-run data + guaranteed cleanup | Medium | Low (cleanup can crash) | Status quo; insufficient alone |
| Bounded clean-before + clean-after by marker/prefix | Medium-High | Medium | Good complement (specs already do this) |
| **Reset-to-seed each run (rebuild, not repair)** | **High** | **High** | **Recommended primary** |
| Known static seed baseline (no reset) | Medium | Low (drifts) | Weak alone |
| Separate account per workflow/run | High isolation | Medium | Useful for cross-user + parallelism later |
| Ephemeral Supabase branch per run (cloud) | High | High | Model B only, if branch feature/cost is owner-verified `[DECISION]` |

### 7.2 Recommended model `[REC]`

**Reset-to-seed as the isolation boundary, plus prefix cleanup as defense-in-depth.** Each run: (1) reset to a known seed (migration replay + deterministic seed: fixed papers ≥ specs' needs, ≥ 2 note-less papers, dedicated account(s), a disposable paper reserved for `search-attribution`, storage bucket present); (2) run the suite serially; (3) best-effort prefix/marker cleanup — but correctness comes from step 1, **not** from `afterAll`.

Because correctness is reset-based, a partially-failed run, browser crash, cancelled workflow, retry after partial mutation, and stale prior-run data are all handled by the next reset. Parallel runs are prevented by the concurrency guard. External-metadata variability is contained by isolating `import-order`. Attachment objects, Auth users, duplicate imports, date-sensitive records, and quota counters are all restored by reseed.

- **Model A:** the reset is inherent — the ephemeral stack is created fresh (migration replay + seed) and **destroyed after the run**. No cloud reset credential. `[REC]`
- **Model B:** reset is a serialized `db reset`/targeted-truncate + reseed against the cloud project, requiring a reset credential (§6.3) and strict serialization. `[REC]`

### 7.3 D2 — the real architecture decision `[DECISION]`

Choose one: **local-first** (Model A only, recommended); **cloud-first** (Model B from the start); or **local-first with optional later cloud parity** (Model A now, add Model B only when a wave demonstrably needs it). The roadmap (§10) **must not force cloud provisioning when local-first is selected.**

**`[DECISION — RESOLVED 2026-07-31]` D2 = local-first.** The owner selected **local-first** (Model A). The required Phase A path is **`C03A1-L → C03A2-L`**; the cloud phases **`C03A1-C → C03A2-C`** are **not** selected and begin only if a later owner decision identifies a concrete cloud-parity need. **D1** (cloud plan/region) does **not** block the local path.

**Grant-parity prerequisite uncovered by C03A1-L — resolved (merged + applied 2026-07-31).** Implementing C03A1-L surfaced a tracked defect that had to land **before** the local six-spec run could pass: a fresh local `supabase db reset` does not reproduce the Data API table GRANTs the app needs (the tracked chain relied on Supabase's old auto-grant default, now moving to **opt-in Data API exposure**; Production still carries the broad legacy grants), so `authenticated` received `42501` and the app could not run on a clean replay. This was fixed by the **separate bounded migration PR `PFA-C03A1-L-GRANT-PARITY-001`** (one least-privilege `20260731162729_reconcile_data_api_grants.sql`; local-replay-proven), now **merged** to `main` (merge commit `1f00800e5c2f1e1c2d405aa0061ecc38c8738004`) and **applied to Production** via the tracked linked CLI — the ledger is aligned at **69 (Local = Remote), latest `20260731162729`**, and the Production application was an **effective no-op** (existing ACLs already broader; no privilege revoked, no `anon`/`PUBLIC` grant added). **The grant-parity prerequisite remains complete, and C03A1-L has now been implemented, merged, and independently accepted** (`PFA-C03A1-L-LOCAL-STACK-FOUNDATION-MERGE-001`). PR #173 merged to `main` via a **regular two-parent merge commit `299b19a08da0a61984bf2333d12406cbfd62aef7`** (parents: base `bf78406bba9f57c6e5dbe5b6b09a27a6778df9a5`, head `e2374b108cb56712b573dc4820a4e9a2e50c1037`; merge tree identical to the approved-head tree `c9f0993…`), with a four-commit / eleven-file scope (`test: add local Supabase E2E foundation` → `docs: record PFA-C03 local-first implementation` → `fix: harden local E2E safety lifecycle` → `fix: suppress local Supabase credential output`). Merged-main **`Validate` run `30697869074`** (event `push`, branch `main`, head `299b19a…`) succeeded, and the automatic Vercel **Production** deployment **`dpl_9zhjYVmjLKTKqrt7PW6haZej9rLf`** is **READY** on `app.paperlume.app`. Re-verified on the **accepted merge tree**: the local lifecycle (`npm run test:e2e:local`) starts an **ephemeral local Supabase stack**, **replays all 69 tracked migrations**, seeds two local-only confirmed Auth users plus a deterministic fixture (120 primary + 5 secondary papers, ≥ 2 note-less newest rows, a disposable highest-`insert_order` paper), and proves RLS cross-user isolation with authenticated (non-service-role) clients. The **two-layer fail-closed guard is merged** (Layer 1 pre-server in `playwright.config.ts` via Vite `loadEnv`; Layer 2 browser-observed in `e2e/global-setup.ts` **before any credential read or fill**), its pure logic is unit-tested (**32 guard tests**), and the **guard negative controls pass** (`npm run test:e2e:local:verify-guards`: the Layer 1 Production-target control fails closed before Vite starts with no secret leaked; the Layer 2 ordering check confirms the guard precedes both credential reads, the fill, and sign-in). The **six selected read-only specs pass on the merge tree** (`auth`, `bulk-actions`, `eager-load`, `filters`, `paper-import`, `pools` — **32 tests green**) and a **second reset/reseed cycle is deterministic** (fresh ephemeral stack, all 69 migrations replayed again, identical fixture counts and ownership-relative assertions, bounded `auth.spec` — **6 tests green**, clean teardown). **Lifecycle safety is hardened:** teardown failures are authoritative (a nonzero `supabase stop` fails the command; a lifecycle+teardown double failure surfaces both via `AggregateError`); `SIGINT`/`SIGTERM` trigger one-time cleanup and exit **130**/**143**; malformed backend values are fully redacted (never echoed); and the raw key-bearing `supabase start` banner is **captured and discarded** — never inherited, logged, written, or thrown. The **complete Vitest suite contained 694 passing tests at the merge acceptance point** (point-in-time evidence, not an evergreen invariant). Accepted credential-output scans over both lifecycle runs produced **zero credential-marker matches** across all categories (values never displayed). **No Production or cloud Supabase access occurred** (only local `supabase start` / `db reset --local` / `status` / `stop`; no `--linked` command, no remote query, no Edge Function deploy/invoke) and **no GitHub workflow was created**; Production remains at **69 migrations** (latest `20260731162729`) with Edge Functions unchanged. **C03A1-L is merged and independently accepted; C03A2-L is next but has not begun; and PFA-C03 remains incomplete.** D3–D5 remain unresolved.

---

## 8. Recommended initial non-required Playwright CI contract

`[FUTURE]` — specified, not implemented. **One coherent backend per run.** The shape below is shown for the **recommended local-first default (Model A, local ephemeral stack)**; under a **cloud-first** D2 selection the equivalent job targets cloud staging (Model B) via `E2E (staging)`. The two are never mixed in one run and neither is ever merged into `Validate`.

- **Workflow name:** `E2E (local)` (Model A) or `E2E (staging)` (Model B) — a distinct workflow per backend. Under cloud-first the job is `E2E (staging)` from the start; under local-first it is `E2E (local)` (and `E2E (staging)` is added only if cloud parity is later chosen). Neither is ever merged into `Validate`. **Job/check name:** `e2e-local` / `e2e-staging`. `[REC]`
- **Triggers:** `workflow_dispatch` (always) + same-repo `push`/`pull_request` only; **no** fork-PR secret exposure. Optional nightly `schedule`. `[REC]`
- **Non-required by design:** not added to `main` branch protection's required checks initially; `Validate / validate` remains the **only** required merge gate and is unchanged. `[REC]`/`[FACT]`
- **Steps (Model A shape):** checkout → setup Node 22 + npm cache → `npm ci` → `npx playwright install --with-deps chromium` → start local Supabase stack → replay migrations → seed → **Layer 1 guard** (materialize `VITE_` for the local host; reject blanks/Production/remote) → run the **initial subset** with **Layer 2 guard** active in `global-setup.ts` → upload artifacts → tear down the stack. `[REC]`
- **Environment/variable names (no values):** Model A needs only public client config for the local stack (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` — the local stack's URL + anon key, typically emitted by `supabase start`), plus `TEST_USER_EMAIL`, `TEST_USER_PASSWORD` (seeded locally), optional `BASE_URL`, and the guard constant naming the Production ref to reject. **No cloud reset credential, access token, or service credential is required for Model A.** Model B additionally needs a staging ref + a reset credential **by name only** (e.g. `STAGING_SUPABASE_DB_PASSWORD` or `STAGING_SUPABASE_ACCESS_TOKEN`). `[REC]`
- **Initial subset (green first):** the 6 **read-only** specs — `auth`, `bulk-actions`, `eager-load`, `filters`, `paper-import`, `pools`. **Wave 2:** `filter-presets`, `file-import-order` (count-sensitive → isolation lane). **Wave 3:** `mutations`, `notes`, `search-attribution` (disposable-paper fixture), `attachments`. **Wave 4 / gated:** `import-order` (external provider; served Edge Function + egress; nondeterministic). `[REC]`
- **Serial/concurrency/timeout:** keep `workers: 1`, serial; one run at a time; `retries: 2` in CI; `timeout-minutes` ≤ 20; per-test `timeout: 30_000`. `[REC]`
- **Evidence before "stable":** the initial subset passes green ≥ 3 consecutive runs; the Layer 1 + Layer 2 guards are proven to abort on a deliberately-wrong (Production) URL; no secret appears in logs/artifacts; `Validate` untouched. `[REC]`

---

## 9. Recommended Phase B database-security-test contract

`[FUTURE]` — reuses and evolves `supabase/tests/owner_access_and_quota_verification.sql`.

### 9.1 Framework choice `[DECISION]` → recommendation

| Option | Pros | Cons |
|---|---|---|
| Keep framework-free transaction/`ASSERT` scripts | Zero new deps; matches existing 18-case file; runs via `psql`; trivially CI-able | Bespoke assertions; no standard TAP output |
| Adopt **pgTAP** | Standard TAP output, rich assertions | New extension/dependency; rewrite/relearn |
| **Hybrid (recommended)** | Keep the proven file; add new framework-free siblings for uncovered areas; adopt pgTAP later only if TAP reporting is needed | Two idioms briefly coexist |

**Recommendation:** framework-free hybrid (transaction-wrapped, `ROLLBACK`, `ON_ERROR_STOP=1`), adding new sibling scripts per area. `[REC]`

### 9.2 Execution model `[REC]`

- **Local ephemeral stack (Model A):** `supabase start`, replay all 69 migrations, run each `supabase/tests/*.sql` with `psql -v ON_ERROR_STOP=1`. Deterministic, no cloud secret, mirrors the existing run instructions and matches the E2E Model A. Fixture isolation is per-transaction `ROLLBACK` (as today).

### 9.3 Required coverage (reuse + additions) `[REC]`

Existing file covers role resolution, direct-table denial on `internal_user_access`, the access-RPC EXECUTE boundary, AI-quota consume/refund/exemption/floor, missing/inactive safety, grant hardening (case 18). **Phase B adds:**

- **Cross-user RLS isolation** on domain tables — `papers`, `projects`, `tags`, junctions, notes-bearing rows, `paper_attachments`, `filter_presets`, `usage_counters`, `user_entitlements`: user A cannot SELECT/UPDATE/DELETE user B's rows.
- **S1 SECURITY DEFINER caller/ownership** — for each `p_user_id`-taking RPC (`consume_ai_quota`, `refund_ai_quota`, `get_ai_quota_status`, and read-path `search_papers`, `search_papers_short`, `filter_papers_by_keywords`, `get_keyword_options`): calling with **another** user's UUID is rejected/scoped to `auth.uid()`. (The existing file proves the 0-arg access RPC + happy-path consume/refund; **caller-mismatch rejection** is the addition.)
- **RPC EXECUTE grants** — broaden the case-18 style assertions to the other SECURITY DEFINER RPCs.
- **AI-quota consume/refund atomicity + concurrency** — concurrent consume near the cap does not exceed it; refund floors at 0.
- **Storage-quota enforcement + usage accounting** — `user_storage_usage` + check-and-consume/refund triggers on `paper_attachments`: insert past cap blocked; usage inc/dec correct; never negative. **Not covered today.**
- **Internal grant hardening + ordinary-user non-escalation** — already covered (cases 4/5/18); keep and reference.

### 9.4 Expected-failure negative-control harness `[REC]`

An intentionally-failing `ASSERT` under `ON_ERROR_STOP=1` **aborts the whole `psql` invocation immediately** — execution does **not** continue to a later ordinary `ROLLBACK`, and the normal green suite cannot be reused to "prove" detection because its own abort would look like a real failure. The negative control therefore uses an **outer expected-failure harness** that treats a nonzero inner exit as success:

1. A **separate** negative-control SQL script (or a generated temporary script), distinct from the normal green suite.
2. The script **starts a transaction**.
3. It **deliberately weakens exactly one bounded invariant** (e.g. drop/loosen one RLS policy, or grant a forbidden privilege) in that transaction.
4. It **invokes the normal detector/assertion** for that invariant.
5. The inner `psql -v ON_ERROR_STOP=1` process is **expected to exit nonzero** (the assertion fires; the transaction aborts).
6. An **outer shell/test harness treats nonzero as success** for this expected-failure step.
7. A **zero exit is a failure** of the negative control — the detector did not catch the regression.
8. The connection **closes / the transaction is rolled back** (the abort already discards the weakening; the harness never issues a `COMMIT`).
9. A **fresh connection** then verifies the weakened policy/grant/function state **did not persist** (baseline intact).
10. The **normal green suite** runs (or re-runs) against the restored baseline and must pass.

The negative-control artifact **never leaves a weakened committed schema or policy** and is never committed in a weakened state. Phase B ships at least one such control (e.g. cross-user RLS on `papers`, plus one quota/storage invariant).

### 9.5 Phase B CI `[REC]`/`[FACT]`

Phase B runs in a **separate, non-required** workflow/check — proposed `db-tests` (a distinct workflow, not a job appended to `Validate`). It **must not** be silently added to the required `Validate` workflow while claiming `Validate` is unchanged. Promotion to required (if ever) is a later owner decision (D5).

---

## 10. Phased implementation roadmap

`[REC]` — bounded PRs; **not** one epic. Each phase is separately authorized; none is started by this task. **The required Phase A path is chosen by D2 (§7.3); local-first is the recommended default, not a mandate:**

- **D2 = local-first (recommended):** Phase A = `C03A1-L → C03A2-L`. The cloud phases are **not** required (add them later only if separately justified and authorized).
- **D2 = cloud-first:** Phase A = `C03A1-C → C03A2-C`. The local Phase A phases (`C03A1-L` / `C03A2-L`) are **not** prerequisites and are taken only if independently chosen for extra coverage.
- **D2 = local-first + optional cloud parity:** Phase A begins `C03A1-L → C03A2-L`, then adds `C03A1-C → C03A2-C` **only after** a concrete unmet requirement is identified and separately authorized.
- **Phase B is shared under every D2 option:** `C03B1 → C03B2` (local, deterministic), regardless of the Phase A branch — unless a later owner decision changes it.

In the table below each phase is tagged **(shared)**, **(local-first)**, or **(cloud-first / optional-hybrid)** to show where it is required.

| Phase | Purpose | Repo mutations | External mutations | Owner actions | Sensitive secrets (names only) | Acceptance | Prod access | Separate deploy auth? |
|---|---|---|---|---|---|---|---|---|
| **C03A0** (this) *(shared)* | Contract + readiness audit | 2 docs | none | none | none | Contract complete; §14 DoD-ready; `Validate` green | Prohibited | No |
| **C03A1-L** *(local-first / hybrid)* — **merged and accepted** (PR #173, merge `299b19a…`) | Local-stack seed/reset + env + guard contract (repo) | `playwright.config.ts`/`e2e/*` env wiring + guards + seed/reset scripts | none (local only) | none (local path needs no cloud action) | none for the local path (`TEST_USER_*` seeded locally) | **met on the accepted merge tree:** local stack replays all 69 + seeds (120/5); both guard layers reject Production/remote (32 guard tests; Layer 2 before credential reads and fills); six read-only specs green (32); deterministic second reset/reseed (auth 6 green); teardown/signal hardening; startup credential output suppressed (zero-match scans); merged-main `Validate` `30697869074` green | Prohibited | No |
| **C03A2-L** *(local-first / hybrid)* | Non-required **local** Playwright CI (`E2E (local)`) | new `E2E (local)` workflow | CI only (ephemeral local stack) | approve running the workflow | none cloud (local anon key + seeded `TEST_USER_*`) | initial read-only subset green ≥ 3 runs; guards proven; `Validate` unchanged & required | Prohibited | No |
| **C03A1-C** *(cloud-first; optional under hybrid)* | Cloud staging provisioning + read-only verification | none (or docs note) | **owner** creates cloud project + accounts + secrets | provision cloud project, dedicated accounts, GitHub Environment + secrets, confirm **plan/region (D1)** | staging ref (public) + reset credential (`STAGING_SUPABASE_DB_PASSWORD`/`STAGING_SUPABASE_ACCESS_TOKEN`), `TEST_USER_PASSWORD` | staging reachable; migrations replay clean; guards reject Production | Prohibited (Production) | Yes (cloud setup owner-authorized) |
| **C03A2-C** *(cloud-first; optional under hybrid)* | Non-required **cloud** Playwright CI (`E2E (staging)`) | new `E2E (staging)` workflow | CI runs against cloud staging | approve secrets/Environment | as C03A1-C | subset green vs staging; secrets fork-protected; `Validate` unchanged | Prohibited (Production) | Uses C03A1-C |
| **C03B1** *(shared)* | DB-test framework + representative **local** coverage | new `supabase/tests/*.sql` (RLS, S1 caller-mismatch, storage quota, broadened grants) | none | none | none | new suites pass on clean local replay; existing 18-case file still passes | Prohibited | No |
| **C03B2** *(shared)* | **Separate** non-required `db-tests` CI + expected-failure negative-control | new `db-tests` workflow (ephemeral local stack) | CI only | none | none | `db-tests` green on `main` state; negative control **fails-then-reverts** (verified via fresh connection); separate workflow, still non-required | Prohibited | No |
| **finalization** *(shared)* | Docs reconciliation + acceptance | docs | none | owner accepts PFA-C03 done | none | §14 DoD met; both phases shipped | Prohibited | No |

**D1 (cloud plan/region) blocks only the cloud phases (`C03A1-C` / `C03A2-C`), never the local phases.** E2E subset expansion waves (§8) run within whichever Phase A branch is chosen (`C03A2-L` under local-first, `C03A2-C` under cloud-first); `import-order` (external) is gated last.

---

## 11. Owner-action and secret-name checklist

`[OWNER]` — no values, names only. **Local-first needs no cloud action.**

**Decisions (both paths):**

- [x] **D2 — test-backend architecture:** **RESOLVED 2026-07-31 → local-first** (path `C03A1-L → C03A2-L`; cloud not selected). `[OWNER]` `[DECISION — RESOLVED]`
- [ ] **D3 — DB-test framework:** framework-free hybrid (recommended) / pgTAP. `[OWNER]` `[DECISION]`

**Local-first (Model A) — no cloud provisioning required:**

- [ ] Approve running the non-required `E2E (local)` and `db-tests` workflows. `[OWNER]`
- [ ] Confirm seeded local `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` handling (sensitive operational config; the anon key + local URL are public client config). `[OWNER]`

**Cloud (Model B) — required for a cloud-first D2 selection; optional for later hybrid parity:**

- [ ] Create the **cloud** Supabase project (`paperlume-staging`); confirm **plan** and **region** (D1). `[OWNER]`
- [ ] Create **dedicated cloud staging accounts** (never `ps4`; secondary account for cross-user tests). `[OWNER]`
- [ ] Create a GitHub **Environment** (`staging-e2e`) and add: **public** — `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, staging ref; **sensitive** — `TEST_USER_PASSWORD`, a reset credential (`STAGING_SUPABASE_DB_PASSWORD` or `STAGING_SUPABASE_ACCESS_TOKEN`); handle `TEST_USER_EMAIL` as sensitive operational config. `[OWNER]`
- [ ] Confirm **fork-PR secret protection** + required-reviewer gating on the Environment. `[OWNER]`
- [ ] For Wave 4 only: decide whether to serve/provision `fetch-paper-metadata` + egress for `import-order`, or defer (D4). `[OWNER]`
- [ ] Explicitly **exclude** `GOOGLE_MONITORING_*` / provider-quota from any test backend (C29). `[OWNER]`

---

## 12. Owner decision packet

`[DECISION]` — only genuinely open items. (Not reopened: PFA-C03 selection, C27–C29, no Production-backed Playwright, no real-Gemini Playwright, the required `Validate` gate, staged cloud/Production authorization.)

- **D1 — Cloud staging plan/region.** *Why:* cost/latency of the **optional** cloud project. *Recommended default:* **not needed** under local-first; if cloud is selected, lowest tier supporting the full migration chain + Auth + Storage, same region as Production. *Trade-off:* cost/realism. *Blocks:* **only** C03A1-C/C03A2-C (never the local path).
- **D2 — Test-backend architecture (local-first / cloud-first / local-first + optional cloud). `[RESOLVED 2026-07-31 → local-first]`** *Why:* the substantive architecture choice; it selects the required Phase A branch (§10) and drives determinism, cost, secret surface, and which specs run first. *Recommended default:* **local-first**, adding cloud only when a wave demonstrably needs it. *Alternatives:* cloud-first; local-first + optional cloud. *Trade-off:* realism vs cost/complexity/secret surface. *Selects the Phase A branch:* local-first → `C03A1-L → C03A2-L`; cloud-first → `C03A1-C → C03A2-C`; hybrid → `C03A1-L → C03A2-L` first, optional `C03A1-C → C03A2-C` later. *Blocks:* the Phase A branch shape (local-first unblocks `C03A1-L` immediately without any cloud decision; cloud-first additionally needs D1). Phase B (`C03B1 → C03B2`) is shared and unaffected. **Owner outcome:** local-first selected; path `C03A1-L → C03A2-L`; cloud phases not selected; D1 still does not block the local path. The Data API grant-parity prerequisite (`PFA-C03A1-L-GRANT-PARITY-001`, §7.3) is **complete — merged and applied to Production 2026-07-31**, and **C03A1-L has now been implemented, merged, and independently accepted** (`…-MERGE-001`: PR #173, merge `299b19a…`; local stack replays all 69 migrations, deterministic 120/5 seed, two-layer fail-closed guards + negative controls, six read-only specs green (32), deterministic second reset/reseed (auth 6)). **C03A1-L is merged and accepted; C03A2-L is next but has not begun; PFA-C03 remains incomplete.**
- **D3 — DB-test framework (framework-free hybrid vs pgTAP).** *Why:* maintenance/reporting. *Recommended default:* framework-free hybrid. *Trade-off:* zero-dep vs standardized TAP. *Blocks:* C03B1.
- **D4 — External-metadata E2E (`import-order`).** *Why:* PubMed/Crossref are nondeterministic and need served Edge Functions + egress. *Recommended default:* defer to Wave 4; assert on stable identifiers/counts (not exact remote titles), or use a deterministic stand-in. *Trade-off:* coverage vs flakiness/cost. *Blocks:* the final E2E wave only.
- **D5 — Promotion of `e2e-*` or `db-tests` to a required check.** *Why:* changes the merge gate. *Recommended default:* keep **non-required** until proven stable; revisit later (deterministic `db-tests` could be promoted sooner). *Trade-off:* stronger gate vs flakiness. *Blocks:* nothing now.

---

## 13. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| CI silently falls back to Production | Medium (today's default) | **High** (mutates real data) | **Two-layer guard** (§5): Layer 1 Node/CI (reject blanks/Production/remote before server start) **and** Layer 2 browser-observed (verify actual backend before credentials) |
| Node check "proves" config but the loaded bundle differs | Medium | High | Layer 2 observes the frontend's real Supabase host at runtime, before auth |
| Secrets exposed to fork PRs | Low under local-first (no cloud secret) / Medium under cloud | High | Local-first removes cloud secrets from the initial path; cloud path uses same-repo/`workflow_dispatch` + protected Environment + required reviewers |
| Cleanup-crash leaves real data mutated (esp. `search-attribution`) | Medium | Medium-High | Reset-to-seed as the isolation boundary; disposable fixture paper for the six-field spec |
| Count/order-sensitive specs collide under overlap | Medium | Medium | Concurrency guard (one run) + reseed + isolation lane for import specs |
| External metadata drift (`import-order`) | Medium | Medium | Gate to last wave; assert stable fields; optional deterministic stand-in |
| Secret values leak into logs/artifacts | Low | High | Mask; assert on host/ref substrings; never upload env files; publishable key is public but still not broadcast |
| Negative control leaves a committed weakening | Low | High | Outer expected-failure harness; abort-driven rollback; **fresh-connection** verification of restored baseline |
| Phase A/B job creeps into required `Validate` | Low | High | New workflows are separate and non-required; `Validate` untouched |
| Test backend drifts from Production schema | Medium | Medium | Reset via full migration replay every run |
| Unverified pricing/limit assumptions | Low | Medium | This doc makes **no** pricing/limit claims; owner confirms at (optional) cloud provisioning |

---

## 14. Definition of done for PFA-C03

PFA-C03 is complete only when **both** phases have shipped (across separate bounded PRs):

- **Phase A done:** an isolated test backend exists (local-first by default; cloud only if selected); Playwright is wired to it fail-closed with the **two-layer** Production guard proven (Layer 1 rejects blanks/Production/remote before server start; Layer 2 verifies the browser-observed backend before credentials); a **non-required** `E2E (local)` (and/or `E2E (staging)`) job runs the initial subset green with documented setup; `Validate / validate` remains unchanged and required. `[FUTURE]`
- **Phase B done:** a database-security suite (reusing/evolving `owner_access_and_quota_verification.sql`) covers cross-user RLS isolation, S1 caller/ownership, RPC EXECUTE grants, AI-quota consume/refund atomicity, storage-quota enforcement, and internal-access non-escalation; it runs in a **separate** non-required `db-tests` workflow and includes at least one **expected-failure negative-control** that fails-then-reverts, with restoration verified through a fresh connection. `[FUTURE]`
- **Finalization:** docs reconciled; owner accepts. `[FUTURE]`

**PFA-C03 is NOT complete.** The C03A0 contract shipped, and **C03A1-L is now merged and independently accepted** (local-first foundation; PR #173, merge `299b19a…`). The next phase is the separately authorized **C03A2-L** (non-required `E2E (local)` CI), which must reuse the merged C03A1-L lifecycle, stay separate from the required `Validate` gate, and never access Production; **C03A2-L has not begun** and **no `E2E (local)`/`db-tests` workflow exists**. Phase B (`C03B1 → C03B2`) remains unstarted. No further implementation phase is authorized by this task.

---

## 15. Evidence appendix

All read-only; gathered on branch `docs/pfa-c03-staging-contract` (from `origin/main` `5b78b08d`).

- **Preflight:** `git status --short` clean; `git rev-parse origin/main` = `5b78b08d074703b6ed5cdd3a1c7a5b118f6a6a38`; no overlapping `staging`/`pfa-c03`/`e2e-ci` branch or open PR.
- **CI:** `.github/workflows/validate.yml` (lines 1–73).
- **Playwright:** `playwright.config.ts` (1–70); `e2e/global-setup.ts` (1–41, Node/Playwright — does not read browser `import.meta.env`); `e2e/helpers.ts` (1–262).
- **E2E specs (13):** `auth`, `bulk-actions`, `eager-load`, `filters`, `paper-import`, `pools`, `filter-presets`, `file-import-order`, `mutations`, `notes`, `search-attribution`, `attachments`, `import-order` (all read in full).
- **Frontend env:** `src/lib/clientEnv.ts`; `src/integrations/supabase/client.ts`; `vite.config.ts`; `package.json` (`dev = vite`); `.env.example`; `.env.test.example`; `.gitignore`.
- **Production-fallback evidence:** untracked `.env` defines `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` and references `lioxtgiputfniqbktcsz` (name/count only; **no values printed**); `.env.test` defines only `TEST_USER_EMAIL` + `TEST_USER_PASSWORD`; no `.env.local`/`.env.development` present.
- **Supabase:** `supabase/config.toml` (ref `lioxtgiputfniqbktcsz`; three `verify_jwt=false` functions); 69 migrations (chain end `20260731162729`); storage/quota migrations in §2.4; `supabase/functions/_shared/env.ts`; secret names + external hosts grepped from `supabase/functions/`.
- **DB test:** `supabase/tests/owner_access_and_quota_verification.sql` (18 cases, `BEGIN … ROLLBACK`).
- **Decisions:** C27/C28/C29 and S1 in [decisions-and-triggers.md](decisions-and-triggers.md); unlock order in [owner-decisions.md](owner-decisions.md); PFA-C03 in [product-feature-audit.md](product-feature-audit.md) §14/§15; line budget in [documentation-policy.md](documentation-policy.md).
