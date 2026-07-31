# PFA-C03 — Staging Environment and Automated Security-Test Contract

> **Status: planning only.** This document is the implementation and decision contract for **PFA-C03 — Safe staging environment and automated security tests**. It plans work; it ships **none** of it. No staging Supabase project, GitHub secret, CI workflow, database-test framework, or fixture exists as a result of this document. Every "staging", "workflow", "secret", and "fixture" named below is a **recommendation or future artifact**, not a deployed one.
>
> **Owner selection.** The owner selected **PFA-C03** on 2026-07-31. This is the first bounded subtask, **PFA-C03A0** (contract + readiness audit). **PFA-C03 is not complete after this PR** — see §14.
>
> **Labels used throughout:** `[FACT]` current repository truth · `[REC]` recommendation · `[FUTURE]` future implementation · `[OWNER]` owner action · `[DECISION]` unresolved owner decision.

---

## 1. Status and scope

- **Initiative:** PFA-C03 (product-feature-audit candidate; §12/§14 of [product-feature-audit.md](product-feature-audit.md)). Two-phase "Model A": **Phase A** = isolated staging + non-required Playwright CI; **Phase B** = representative automated database-security/integrity tests. `[FACT]`
- **This task:** PFA-C03A0 — produce the contract and readiness audit only. Two documentation files change: this new file and [start-here.md](start-here.md). No code, tests, workflows, packages, configuration, migrations, or generated types change. `[FACT]`
- **In scope of the contract (planning):** staging isolation model; deterministic fixtures/reset/cleanup; a non-required Playwright CI job; a Phase B database-security suite that reuses/evolves the existing SQL verification; a phased PR roadmap; owner actions and secret **names**; an owner decision packet; a risk register; a definition of done. `[REC]`
- **Explicitly out of scope of this task:** provisioning anything, running Playwright, running Supabase CLI mutations, changing `.github/workflows/validate.yml`, adding a workflow, adding secrets, or merging. See the parent task's non-goals. `[FACT]`
- **Guardrails that constrain the whole plan:** C27 (commercialization paused), C28 (owner/manager roles + owner AI exemption), C29 (Gemini Free Tier; Google Cloud billing disabled; provider-quota dashboard deferred) all remain **unchanged**. The required `Validate / validate` gate remains **unchanged and required**. Playwright-against-Production and real-Gemini Playwright remain **prohibited**. `[FACT]`

---

## 2. Verified current baseline

All items independently reconfirmed on this branch (`docs/pfa-c03-staging-contract`, cut from `origin/main` `5b78b08d`).

### 2.1 Repository and CI

- **Required CI:** `.github/workflows/validate.yml`, workflow name `Validate`, job `validate`, on `pull_request → main`, `push → main`, and `workflow_dispatch`. Runs `npm ci` → tool-version report → `npm run lint` → `npm run typecheck` → `npm test` (Vitest) → `npm run build`. Node `22.x`, `ubuntu-24.04`, `timeout-minutes: 20`, `permissions: contents: read`, concurrency-cancel. Build env supplies **inert public placeholders** `VITE_SUPABASE_URL=https://example.supabase.co` and `VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-publishable-key`. **No** Playwright, browser install, Supabase command, migration replay, database test, or deployment. `[FACT]`
- This workflow is the sole required merge gate for `main` and must not be weakened, renamed, reordered, or made to depend on staging. `[FACT]`

### 2.2 Playwright model

- `playwright.config.ts`: `testDir ./e2e`, `fullyParallel: false`, `workers: 1`, `retries: CI ? 2 : 0`, `timeout: 30_000`, `reporter: CI ? "github" : "list"`. Two projects: `setup` (matches `global-setup.ts`) and `chromium` (depends on `setup`, `storageState: e2e/.auth/user.json`). `webServer.command: "npm run dev"`, `port: 8080`, `reuseExistingServer: !CI`. `use.baseURL = process.env.BASE_URL || "http://localhost:8080"`. `[FACT]`
- `playwright.config.ts` manually parses `.env.test` (if present) and injects **only** the keys it finds there into `process.env`, without overwriting values already set (`if (!process.env[key])`). `[FACT]`
- `e2e/global-setup.ts`: reads `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` (throws if missing), signs in through the real `/auth` UI, and asserts the dashboard renders a paper count (`/\d+\s+paper/i`) before saving `storageState` to `e2e/.auth/user.json`. **This hard-requires the test account to have ≥ 1 paper.** `[FACT]`

### 2.3 Frontend env contract

- `src/lib/clientEnv.ts`: `requireClientEnv(name)` reads `import.meta.env[name]` and throws an actionable error if empty/blank. `src/integrations/supabase/client.ts` calls it for `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` at module load and constructs the Supabase client. `[FACT]`
- `vite.config.ts` is minimal (React SWC, `@` alias, dev server on port 8080); it does **not** customize env-file loading, so Vite's default dotenv resolution applies. `[FACT]`
- Tracked env examples: `.env.example` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) and `.env.test.example` (`TEST_USER_EMAIL`, `TEST_USER_PASSWORD`, optional `BASE_URL`). `.gitignore` ignores `.env` and `.env.*` except those two examples, and ignores `e2e/.auth/user.json`. `[FACT]`

### 2.4 Supabase backend

- `supabase/config.toml`: `project_id = "lioxtgiputfniqbktcsz"` (Production ref); `verify_jwt = false` for all three functions (in-body `auth.getUser()` is authoritative). `[FACT]`
- Migrations: **68** tracked files, chain `20260203072053_… → 20260726120000_harden_internal_user_access_grants.sql`; storage/quota-relevant migrations include `20260318010000_add_paper_attachments`, `20260318020000_add_attachments_storage_policies`, `20260327100000_private_attachments_bucket`, `20260521030000_harden_attachment_privacy_and_storage_quota`, plus the entitlement/quota schema `20260521010000` and AI-quota RPCs `20260521020000` / `20260724120000` / `20260725090000`. `[FACT]`
- Edge Functions (source in `supabase/functions/`): `fetch-paper-metadata`, `analyze-paper`, `get-gemini-provider-quota`, plus shared helpers (`env.ts`, `geminiModel.ts`, `geminiMonitoring.ts`, `pacificTime.ts`, `providerCache.ts`, `providerError.ts`). Secret names referenced: `GEMINI_API_KEY`, `GEMINI_MODEL` (optional override), `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_MONITORING_CLIENT_EMAIL`, `GOOGLE_MONITORING_PRIVATE_KEY`. External hosts referenced: PubMed (`eutils.ncbi.nlm.nih.gov`, `pubmed.ncbi.nlm.nih.gov`), Crossref (`api.crossref.org`, `doi.org`), Google (`generativelanguage.googleapis.com`, `monitoring.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com`), `esm.sh`. `[FACT]`

### 2.5 Existing database verification

- `supabase/tests/owner_access_and_quota_verification.sql` exists: local-only, framework-free, single transaction wrapped in `BEGIN … ROLLBACK`, run manually via `psql -v ON_ERROR_STOP=1` against a local stack. It simulates callers with `SET LOCAL ROLE authenticated` + a `request.jwt.claims` GUC and covers **18 cases**: role resolution (user/owner/manager) and `is_exempt` via `get_current_user_access()`; ordinary user cannot read/insert/update `internal_user_access`; anon cannot execute the access RPC; null-auth rejection; no arbitrary-user inspection (0-arg RPC); Free 15-lifetime cap; Pro 350-monthly cap; exempt owner allowed beyond cap with usage still incrementing; exempt refund decrements the same bucket; refund floor at 0; missing/inactive entitlement safety; `is_exempt` reporting; no email-based role column; and grant hardening (FORCE RLS, zero policies, revoked direct grants for anon/authenticated, retained `service_role` CRUD, RPC EXECUTE boundary). `[FACT]`
- **This is the reusable Phase B seed.** It is not absent and must not be duplicated or ignored. §9 evolves it. `[FACT]`

---

## 3. Changes since the 2026-07-24 product-feature audit

The July-24 audit ([product-feature-audit.md](product-feature-audit.md)) described PFA-C03 (PFA-F006, §14/§15) before the Owner/Manager work landed. The following are now true and supersede the corresponding audit snapshots:

- **`supabase/tests/` now exists.** The audit stated "no `supabase/tests`" (PFA-F006 evidence, §15). That is no longer accurate: `owner_access_and_quota_verification.sql` (18 cases) is committed. Phase B **reuses** it. `[FACT]`
- **Baseline commit advanced.** The audit baseline was `main` `5a92229f`; the current baseline is `5b78b08d` (PR #169 merged). PRs #165–#169 (audit, PFA-C01, Owner/Manager access, Gemini-quota scope normalization, documentation finalization) all merged. `[FACT]`
- **Three Edge Functions are deployed** (`fetch-paper-metadata` v10, `analyze-paper` v15, `get-gemini-provider-quota` v3), the third **deployed-but-unused** under C29. The audit predated the deployed provider-quota function. `[FACT]`
- **C29 exists** (2026-07-26): Gemini Free Tier during development; Google Cloud billing disabled; provider-quota dashboard deferred. Staging **must not** replicate Google Monitoring credentials or the provider-quota path (§4). `[FACT]`
- **Unchanged since the audit:** Playwright still runs the local dev server against the **Production** Supabase project and is excluded from required CI; there are still no pgTAP tests and no CI execution of the database or Edge-Function layers; required CI is still lint + typecheck + Vitest + build only. The audit's core PFA-C03 problem statement therefore still holds. `[FACT]`

---

## 4. Full E2E inventory

`e2e/` contains **13 spec files** plus `global-setup.ts` (auth setup) and `helpers.ts` (shared mutating helpers). All run Chromium-only, single-worker, serial, using the one authenticated `storageState`. Every spec that calls `waitForDashboard`/the `\d+ paper` assertion depends on the account having **≥ 1 paper**.

### 4.1 Classification matrix

| Spec | Primary workflow | Class | DB/Storage entities touched | Cleanup | Staging-safe unchanged? | Initial CI subset? |
|---|---|---|---|---|---|---|
| `auth.spec.ts` | Auth page + logged-in dashboard | **Read-only** | none | n/a | Yes | **Yes** |
| `bulk-actions.spec.ts` | Select-all / selection toolbar | **Read-only** | none (select/deselect only) | n/a | Yes | **Yes** |
| `eager-load.spec.ts` | Lazy-load, select-all-IDs, export menu | **Read-only** | none (opens export menu; never exports/mutates) | n/a | Yes | **Yes** |
| `filters.spec.ts` | Search box, year filters, clear, columns | **Read-only** | none | n/a | Yes | **Yes** |
| `paper-import.spec.ts` | Add-Papers dialog states | **Read-only** | none (never submits an import) | n/a | Yes | **Yes** |
| `pools.spec.ts` | Sidebar pools/projects/tags dialogs, export menu | **Read-only** | none (opens dialogs only) | n/a | Yes | **Yes** |
| `filter-presets.spec.ts` | Saved-search CRUD | **Mutating** | `filter_presets` (insert/update/rename/delete) | `beforeEach` + `afterEach` delete all `E2E-*` presets | Yes (prefix-isolated) | Wave 2 |
| `file-import-order.spec.ts` | `.bib` file import + order | **Mutating** | `papers` (+ junctions) create/delete; **no external call** | pre-clean + post-clean by `E2E-Test*` prefix | Yes | Wave 2 |
| `mutations.spec.ts` | Create project/tag, assign to first paper, statistical-methods round-trip | **Mutating** | `projects`, `tags`, junctions, one manual `papers` row | in-test removal + `finally` paper delete | Needs care | Wave 3 |
| `notes.spec.ts` | Notes add/edit/clear/filter/search | **Mutating** | `notes` field of 2 pre-existing papers | per-test restore-to-empty + `afterAll` defensive clear | Needs care | Wave 3 |
| `search-attribution.spec.ts` | 6-field `Matched in:` attribution | **Mutating** | title/authors/journal/abstract/keywords/notes of **first** paper | `afterAll` restores captured originals | Needs care | Wave 3 |
| `attachments.spec.ts` | Attachment upload/open/refresh/delete | **Mutating + Storage** | `paper_attachments` rows + private-bucket objects; signed-URL HEAD fetch | pre-clean + in-group delete | Needs bucket + fixtures | Wave 3 |
| `import-order.spec.ts` | PMID import + order | **Mutating + external** | `papers` via `fetch-paper-metadata` → PubMed/Crossref | pre-clean + post-clean | External nondeterminism | Wave 4 / gated |

### 4.2 Per-spec detail (auth, pre-existing data, external calls, order dependence, cleanup-failure consequence, remediation)

- **auth** — Auth assumptions: exercises both logged-out (fresh `storageState: undefined` contexts) and the shared logged-in state. Pre-existing data: ≥ 1 paper (dashboard count). External: none. Order: independent. Cleanup failure: n/a. Remediation: none. `[FACT]`
- **bulk-actions / eager-load / filters / paper-import / pools** — Shared logged-in state; ≥ 1 paper (eager-load has a `count > 100` branch that only *adds* assertions when the library is large, and select-all asserts the selected count equals the total). No external calls; read-only; no cleanup needed. Remediation: none for staging correctness; for eager-load to exercise the large-library branch, a seeded library > 100 papers is desirable but not required for green. `[FACT]`
- **filter-presets** — ≥ 1 paper (dashboard must load). External: none. Order: serial; robust because every created preset uses the `E2E-` prefix and `beforeEach`/`afterEach` delete all `E2E-*` presets (capped loop). Cleanup-failure consequence: orphaned `E2E-*` presets on the account, harmlessly reaped on the next run. Some empty-state assertions assume the account has **no non-`E2E-` presets** (defensively skipped otherwise) — a dedicated staging account satisfies this cleanly. Remediation: minimal; ideal on a dedicated staging account. `[REC]`
- **file-import-order** — Imports 3 papers from `e2e/fixtures/test-import-order.bib` (client-parsed, no external metadata) and asserts reverse-insert order + stability across two refreshes + a `+3` count delta. Order: strictly serial (count-delta sensitive). Cleanup-failure consequence: leftover `E2E-Test{Alpha,Bravo,Charlie}` papers; the pre-clean step reaps them next run. **Count-sensitive: no concurrent library mutation may run during it.** Remediation: run in an isolation lane with no parallel writers. `[FACT]`
- **mutations** — Creates `_e2e_proj_<ts>` / `_e2e_tag_<ts>`, assigns to the **first row** (default sort `insert_order DESC`), asserts persistence, then unassigns + deletes; second group creates a manual `_e2e_paper_<ts>`, round-trips `statistical_methods`, deletes in `finally`. Order: serial; depends on "first paper" being stable. Cleanup-failure consequence: leftover `_e2e_*` project/tag/paper artifacts. Remediation: dedicated account; deterministic first-row fixture; unique names already good. `[FACT]`
- **notes** — Dynamically picks the first two rows in the first 30 with **no** notes indicator; sets/clears notes with unique per-run tokens; restores to empty per test + `afterAll`. Pre-existing data: **≥ 2 note-less papers in the first 30 rows**. External: none. Order: serial. Cleanup-failure consequence: a real paper left carrying an `E2E-NOTES-*` note (restored to empty on success, since chosen papers began empty). Remediation: dedicated account with a known set of note-less papers. `[FACT]`
- **search-attribution** — Appends per-field tokens to **all six** searchable fields of the **first** paper, then `afterAll` writes the captured originals back. Order: serial. **Highest cleanup-failure blast radius:** if `afterAll` fails, a real paper permanently carries `e2eattr*` tokens across six fields. Remediation: run against a **disposable staging paper** (fixture created and destroyed per run), not the account's first real paper; or a per-run reset. `[REC]`
- **attachments** — Uploads `fixtures/test-attachment.png` to the private bucket for the **first** paper, opens the signed URL (in-page `HEAD` fetch to Supabase Storage → expects 200), asserts persistence after refresh, deletes; group 2 confirms the SVG fixture is rejected **client-side** (no upload). Pre-existing data: ≥ 1 paper. Backend needs: private bucket + owner-scoped policies + storage-quota triggers (no Edge Function). Cleanup-failure consequence: orphaned storage object + `paper_attachments` row (pre-clean reaps next run). Remediation: staging bucket + policies provisioned; dedicated account. `[FACT]`
- **import-order** — Imports fixed PMIDs `39140285/6/7` through `fetch-paper-metadata` → PubMed/Crossref and asserts specific title prefixes + `+3` count + order. External: **live PubMed/Crossref** (title text and availability can drift). Backend needs: deployed `fetch-paper-metadata` + network egress + (optional) per-user PubMed key. Cleanup-failure consequence: leftover imported papers. Remediation: gate behind an Edge-Function-provisioned wave; treat external metadata as variable (assert on stable identifiers/counts, not exact remote titles) or provide a deterministic metadata stand-in. `[FACT]`

### 4.3 Shared modules

- **`e2e/global-setup.ts`** — the single auth gate; requires `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` and a ≥ 1-paper account. `[FACT]`
- **`e2e/helpers.ts`** — mutating helpers (`importPapersByIds`, `deletePapersByTitleSubstrings`, `createProject`/`createTag`/`deleteProject`/`deleteTag`, `openEditPaperDialog`) plus read helpers (`waitForDashboard`, `getPaperCount`, `getVisiblePaperTitles`, `collectConsoleErrors`). Not a spec; underpins the mutating specs' cleanup. `[FACT]`
- **`e2e/fixtures/`** — `test-attachment.png`, `test-import-order.bib`, `test-invalid.svg`. `[FACT]`

**Cleanup caveat (mandated by the parent task):** several specs are "safe" only because `afterAll`/`finally` cleanup succeeds. `search-attribution` (six real fields) and `mutations`/`attachments` (first-row dependence) are **not** safe against a crash, cancelled run, or overlapping run. The reset model in §7 must not treat cleanup helpers as the isolation boundary.

---

## 5. Environment-resolution analysis (and the Production-fallback finding)

### 5.1 How values resolve today `[FACT]`

Two **independent** environment surfaces exist during a Playwright run; conflating them is the root risk:

1. **The Playwright runner process** — `playwright.config.ts` reads `.env.test` and sets `TEST_USER_EMAIL`, `TEST_USER_PASSWORD`, and (if present) `BASE_URL` into `process.env` (non-overwriting). `global-setup.ts` consumes the two credentials; `baseURL` defaults to `http://localhost:8080`.
2. **The Vite dev server** — `webServer.command: "npm run dev"` (= `vite`, development mode). The frontend's `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` resolve through **Vite's own dotenv loading**, which reads `.env` / `.env.local` — **not** `.env.test`. On this machine the untracked `.env` defines both `VITE_` variables and references the Production ref `lioxtgiputfniqbktcsz` exactly once (confirmed by name/count only; values not printed).

**Distinctions that matter:**

- *Frontend URL under test* = `baseURL` (`localhost:8080`) — the local dev server.
- *Supabase project that frontend talks to* = whatever `import.meta.env.VITE_SUPABASE_URL` resolves to = **today, Production**.
- *Authenticated test account* = `.env.test` credentials (the Production-backed `ps4` account).
- *Edge Functions reached* = those of the resolved Supabase project = **today, Production's**.

### 5.2 The finding `[FACT]`

**Playwright today drives a Production-backed frontend as a real Production account.** `.env.test` supplies only the runner's credentials and base URL; it does **not** repoint the frontend's Supabase project. There is currently **no** mechanism that redirects the tested frontend to a non-Production backend. This is exactly why the suite is excluded from required CI and why every mutating spec runs against Production data today.

### 5.3 Fallback paths that must be closed `[REC]`

- `.env.test` sets credentials but **not** `VITE_` values → the dev server silently keeps whatever `.env`/`.env.local` provides (Production).
- A CI runner with no explicit staging `VITE_` values would either fail the `clientEnv` fail-fast (if truly empty) **or**, worse, inherit a committed/placeholder/Production value → must be made impossible.
- Relying on ambiguous `process.env` → `import.meta.env` inlining is fragile; the contract must not depend on it.

### 5.4 Required fail-closed contract `[REC]` / `[FUTURE]`

The staging Playwright job **must**:

1. **Materialize staging values deterministically** into the file Vite reads (e.g. write a job-scoped `.env.local`/`.env` containing `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` from staging secrets), rather than assuming process-env inlining.
2. **Abort when any required staging variable is absent** (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `TEST_USER_EMAIL`, `TEST_USER_PASSWORD`) — fail the job, never fall through to defaults.
3. **Never fall back to `.env.local`, `.env`, or Production** — the job must not read a developer's local env; it constructs its own from staging secrets only.
4. **Hard Production-ref denial guard:** before starting the dev server, assert the resolved `VITE_SUPABASE_URL` does **not** contain `lioxtgiputfniqbktcsz` (and does contain the expected staging host); abort otherwise. Mirror the guard inside `global-setup.ts` (read `import.meta.env`/the live client URL and throw if it is the Production ref) so a misconfiguration fails at setup, before any mutation.
5. **Never print secret values** — mask in logs; assert on ref substrings, not full keys.

---

## 6. Recommended staging resource contract

`[REC]` unless marked `[OWNER]`/`[DECISION]`.

### 6.1 Supabase staging project

- A **distinct Supabase project** (separate ref, separate URL, separate keys) — never a schema/table prefix inside Production, and never re-linking the repo away from Production. `[REC]` `[OWNER]`
- **Naming convention:** `paperlume-staging` (project name) to make the console unambiguous. `[REC]`
- **Project-ref handling:** the staging ref is treated as a non-secret identifier but is **only** ever referenced through CI secrets/variables in workflows; `supabase/config.toml`'s `project_id` stays Production and is **not** edited by staging CI (staging commands pass `--project-ref` explicitly or use a separate linked context outside the repo). `[REC]`
- **Region:** choose the region closest to CI runners / owner to minimize latency; the choice is not correctness-critical. `[DECISION]` (default: same region as Production).
- **Plan/cost:** staging can start on the lowest tier that supports the required migration chain, Auth, and Storage. This document makes **no** claim about current Supabase prices or quotas (none verified here); the owner confirms the plan at provisioning time. `[OWNER]` `[DECISION]`

### 6.2 Test accounts

- **Dedicated staging accounts**, created only in the staging project — e.g. `e2e-primary@…` and (for future cross-user tests) `e2e-secondary@…`. `[REC]`
- **The Production-backed `ps4` account is never used as the staging account** and its credentials are never placed in staging CI. `[FACT]`/`[REC]`
- Staging Auth should allow these accounts to sign in without manual email confirmation friction (see §7 fixtures). `[REC]`

### 6.3 GitHub secret ownership and CI hardening

- **Least-privilege, environment-scoped secrets:** store staging secrets in a GitHub **Environment** (e.g. `staging-e2e`) rather than repository-wide secrets, so access is scoped and auditable. `[REC]` `[OWNER]`
- **Fork-PR protection:** the staging workflow must **not** expose secrets to pull requests from forks — trigger on `workflow_dispatch` and/or `push`/`pull_request` from same-repo branches only, and/or gate the secret-using job behind the protected Environment with required reviewers. `[REC]`
- **Read-only token:** `permissions: contents: read` (add only what a specific step needs). `[REC]`
- **Concurrency:** one staging run at a time (`concurrency` group with `cancel-in-progress`) so count-sensitive specs never overlap. `[REC]`
- **Cancellation/timeout:** explicit `timeout-minutes` (≤ 20, matching `Validate`'s budget) and a cancellation-safe reset (§7). `[REC]`
- **Artifacts:** upload Playwright `trace`/`screenshot` (already `on-first-retry` / `only-on-failure`) with bounded retention (e.g. 7 days); **never** upload env files or anything containing secrets. `[REC]`
- **Hard Production-ref denial guard** as in §5.4. `[REC]`

### 6.4 What staging must **not** replicate

- **No** Google Monitoring credentials (`GOOGLE_MONITORING_*`, `GOOGLE_CLOUD_PROJECT_ID`) and **no** provider-quota path — deferred by C29. `[FACT]`/`[REC]`
- **No** owner/manager Production bootstrap identity copied in; if internal-role behavior is exercised, it is seeded with **synthetic** staging UUIDs (as the SQL test already does). `[REC]`
- **No** real commercial/billing identifiers; entitlements are seeded as fixtures. `[REC]`

---

## 7. Recommended fixture, reset, and cleanup model

### 7.1 Options considered `[REC]`

| Approach | Determinism | Failure tolerance | Fit here |
|---|---|---|---|
| Unique per-run data + guaranteed cleanup | Medium | Low (cleanup can crash) | Already the status quo; insufficient alone |
| Bounded clean-before + clean-after by marker/prefix | Medium-High | Medium | Good complement (specs already do prefix cleanup) |
| **DB reset + migration replay to a known seed, per run** | **High** | **High** (state is rebuilt, not repaired) | **Recommended primary** |
| Known static seed baseline (no reset) | Medium | Low (drifts as specs mutate) | Weak alone |
| Separate account per workflow/run | High isolation | Medium | Useful for cross-user + parallelism later |
| Ephemeral Supabase branch per run | High | High | Only if branch feature/cost is owner-verified `[DECISION]` |

### 7.2 Recommended model `[REC]`

**Reset-to-seed as the isolation boundary, plus prefix cleanup as defense-in-depth.** Each staging E2E run:

1. **Reset staging to a known seed** before the suite (rebuild, don't repair): apply the full migration chain and load a deterministic seed (fixed set of papers ≥ the specs' needs, ≥ 2 note-less papers, the dedicated account(s), a disposable paper reserved for `search-attribution`, storage bucket present). This makes "first row" and count-delta assumptions deterministic and neutralizes crashed-cleanup state from prior runs.
2. **Run the suite** serially (as today).
3. **Best-effort prefix/marker cleanup** after (the specs already do this) — but correctness comes from step 1, **not** from `afterAll` succeeding.

Because correctness is reset-based, a partially-failed run, a browser crash, a cancelled workflow, a retry after partial mutation, and stale data from a previous run are all handled by the next run's reset. Parallel runs are prevented by the concurrency guard (§6.3). External-metadata variability is contained by isolating `import-order` (§4.2) and asserting on stable fields. Attachment objects, Auth users, duplicate imports, date-sensitive records, and quota counters are all restored by reseed.

### 7.3 Reset mechanism options `[DECISION]`

- **A (recommended default):** an ephemeral **local** Supabase stack (`supabase start`) in the CI job, migration-replayed + seeded, for the Playwright frontend to target. Fully deterministic, no shared-state contention, no cloud cost, no fork-secret exposure. Trade-off: CI must run the local stack and the app against it.
- **B:** a persistent **staging cloud project** reset per run (`db reset`/targeted truncate + reseed). Closest to real Supabase (Storage signed URLs, Auth email); requires careful serialization and secret handling.
- The owner chooses A vs B at PFA-C03A1 (§10, Decision D2). A can serve the **initial** Playwright subset with the least risk; B (or A+B) is warranted once Storage/Auth-dependent specs and Phase B enter.

---

## 8. Recommended initial non-required Playwright CI contract

`[FUTURE]` — specified, not implemented.

- **Workflow name:** `E2E (staging)`. **Job/check name:** `e2e-staging`. Distinct from `Validate`. `[REC]`
- **Triggers:** `workflow_dispatch` (always) + `push` to same-repo feature branches and/or `pull_request` from **same-repo** branches only; **no** fork-PR secret exposure. Optionally a nightly `schedule`. `[REC]`
- **Non-required by design:** it is **not** added to `main` branch protection's required checks initially; it informs, it does not gate. `Validate / validate` remains the **only** required merge gate and is unchanged. `[REC]`/`[FACT]`
- **Steps (shape):** checkout → setup Node 22 + npm cache → `npm ci` → `npx playwright install --with-deps chromium` → materialize staging env (fail-closed, §5.4) → provision/reset the target backend (§7.3) → run the **initial subset** → upload artifacts → teardown/reset. `[REC]`
- **Environment variable names (no values):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `TEST_USER_EMAIL`, `TEST_USER_PASSWORD`, optional `BASE_URL`; plus the guard constant referencing the Production ref to reject. Model B additionally needs a staging service/DB credential **by name only** for reset (e.g. `STAGING_SUPABASE_DB_PASSWORD` or `STAGING_SUPABASE_ACCESS_TOKEN`). `[REC]`
- **Initial subset (green first):** the 6 **read-only** specs — `auth`, `bulk-actions`, `eager-load`, `filters`, `paper-import`, `pools`. They need only a seeded ≥ 1-paper account and no cleanup. `[REC]`
- **Wave 2:** `filter-presets`, `file-import-order` (deterministic, self-cleaning, count-sensitive → isolation lane). **Wave 3:** `mutations`, `notes`, `search-attribution` (needs disposable-paper fixture), `attachments` (needs bucket + fixtures). **Wave 4 / gated:** `import-order` (external provider + Edge Function; nondeterministic). `[REC]`
- **Serial/concurrency:** keep `workers: 1`, serial; one workflow run at a time; `retries: 2` in CI as today. `[REC]`
- **Timeout/retry:** `timeout-minutes` ≤ 20; per-test `timeout: 30_000` unchanged. `[REC]`
- **Fail-closed guard + no-secret-logging** as §5.4/§6.3. `[REC]`
- **Evidence required before it is considered stable:** the initial subset passes green ≥ 3 consecutive runs against staging; the Production-ref guard is proven to abort on a deliberately-wrong URL; no secret appears in logs/artifacts; `Validate` is untouched. `[REC]`

---

## 9. Recommended Phase B database-security-test contract

`[FUTURE]` — reuses and evolves `supabase/tests/owner_access_and_quota_verification.sql`.

### 9.1 Framework choice `[DECISION]` → recommendation

| Option | Pros | Cons |
|---|---|---|
| Keep framework-free transaction/`ASSERT` scripts | Zero new deps; matches existing 18-case file; runs via `psql`; trivially CI-able | Bespoke assertion ergonomics; no standard TAP output |
| Adopt **pgTAP** | Standard TAP output, rich assertions, CI-friendly | New extension/dependency; rewrite/relearn; must be available in the target stack |
| **Hybrid (recommended)** | Keep the proven framework-free file as-is; add **new** framework-free files for the uncovered areas; adopt pgTAP later only if TAP reporting is needed | Two idioms briefly coexist | 

**Recommendation:** continue framework-free (transaction-wrapped, `ROLLBACK`, `ON_ERROR_STOP=1`) to match the existing, working file and avoid a new dependency, adding new sibling scripts per area. Revisit pgTAP only if standardized TAP reporting becomes valuable. `[REC]`

### 9.2 Execution model `[REC]`

- **Primary: local ephemeral stack** — `supabase start`, migration replay, run each `supabase/tests/*.sql` with `psql -v ON_ERROR_STOP=1`. Deterministic, no cloud secret, mirrors the existing run instructions. This is the natural CI target for a `db-tests` job.
- Optionally also runnable against staging, but local replay is the authoritative, secret-free path.
- **Migration replay requirement:** Phase B depends on a clean replay of all 68 migrations into the ephemeral stack; fixture isolation is per-transaction `ROLLBACK` (as today).

### 9.3 Required coverage (reuse + additions) `[REC]`

Existing file already covers: owner/manager/user role resolution, direct-table-access denial on `internal_user_access`, RPC EXECUTE boundary for `get_current_user_access`, AI-quota consume/refund/exemption/floor, missing/inactive safety, grant hardening (case 18). **Phase B must add:**

- **Cross-user RLS isolation** on the domain tables — `papers`, `projects`, `tags`, junctions, `notes`/notes-bearing rows, `paper_attachments`, `filter_presets`, `usage_counters`, `user_entitlements`: user A cannot SELECT/UPDATE/DELETE user B's rows. `[REC]`
- **S1 SECURITY DEFINER caller/ownership** — for each `p_user_id`-taking RPC (`consume_ai_quota`, `refund_ai_quota`, `get_ai_quota_status`, and the read-path RPCs `search_papers`, `search_papers_short`, `filter_papers_by_keywords`, `get_keyword_options`): calling with **another** user's UUID is rejected/So-scoped to `auth.uid()`. The existing file proves the 0-arg access RPC and consume/refund happy paths; the **caller-mismatch rejection** is the addition. `[REC]`
- **RPC EXECUTE grants** — broaden the case-18 style grant assertions to the other SECURITY DEFINER RPCs (authenticated has EXECUTE; anon/PUBLIC do not where intended). `[REC]`
- **AI quota consume/refund atomicity + concurrency** — concurrent consume near the cap does not exceed it; refund is idempotent-safe and floors at 0 (partially covered; add the concurrency/atomicity dimension). `[REC]`
- **Storage-quota enforcement + usage accounting** — the `user_storage_usage` + check-and-consume/refund triggers on `paper_attachments`: insert past cap is blocked; usage increments/decrements correctly; accounting never goes negative. **Not covered today.** `[REC]`
- **Internal Owner/Manager grant hardening + ordinary-user non-escalation** — already covered by cases 4/5/18; keep and reference. `[REC]`

### 9.4 Negative-control proof (definition) `[REC]`

**Negative-control proof** for this project = a bounded, isolated demonstration that the Phase B suite **fails** when a representative invariant is deliberately broken — executed **inside a rolled-back transaction** so the broken state is never committed and never leaves the test context. Concretely: within one `BEGIN … ROLLBACK`, drop or weaken a single RLS policy (or grant a forbidden privilege), assert that the corresponding isolation/grant assertion now **fails**, then `ROLLBACK`. This proves the test can actually detect a regression rather than always passing. It is committed as a guarded, self-reverting control — never as a committed weakening of a real policy. Phase B ships at least one such control (e.g. cross-user RLS on `papers`, and one quota/storage invariant). `[REC]`

---

## 10. Phased implementation roadmap

`[REC]` — bounded PRs; **not** one epic. Each phase is separately authorized; none is started by this task.

| Phase | Purpose | Repo mutations | External mutations | Owner actions | Secrets (names only) | Tests | Acceptance | Stop conditions | Migration? | Prod access? | Separate deploy auth? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **C03A0** (this) | Contract + readiness audit | 2 docs | none | none | none | none | Contract complete; §14 DoD-ready; `Validate` green | any overlap/dirty tree/secret needed | No | Prohibited | No |
| **C03A1** | Owner-side staging provisioning + read-only verification | none (or a docs note) | **owner** creates staging project + accounts + secrets | Provision staging project, dedicated accounts, GitHub Environment + secrets, confirm plan/region | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `TEST_USER_EMAIL`, `TEST_USER_PASSWORD` (+ reset creds for Model B) | read-only verification only | Staging reachable; migrations replay clean; guard rejects Prod ref | provisioning blocked/ambiguous | No (repo) | Prohibited (Production) | Yes (staging setup is owner-authorized) |
| **C03A2** | Repo staging config + non-required Playwright CI | `playwright.config.ts`/`e2e/*` env wiring, new `E2E (staging)` workflow, `.env.test.example` docs | CI runs against staging | approve secrets/Environment usage | as A1 | initial read-only subset green in CI | subset green ≥ 3 runs; `Validate` unchanged & required; no secret leakage | subset flaky/secret exposure/Prod-ref reachable | No | Prohibited (Production) | Uses A1 staging |
| **C03B1** | DB-test framework + representative local coverage | new `supabase/tests/*.sql` (RLS, S1 caller-mismatch, storage quota, broadened grants) | none | none | none | local `psql` replay | new suites pass locally on clean replay; existing 18-case file still passes | replay fails/coverage gap | No (test SQL only; no schema change) | Prohibited | No |
| **C03B2** | DB-test CI integration + negative-control | new `db-tests` job (ephemeral stack) | CI only | none | none (local stack) | negative control proves failure detection | `db-tests` runs green on `main` state; negative control demonstrably fails-then-reverts; still non-required unless owner promotes | control leaks state/job unstable | No | Prohibited | No |
| **C03 finalization** | Docs reconciliation + acceptance | docs (`start-here`, `deployment`, this file) | none | owner accepts PFA-C03 done | none | n/a | §14 DoD fully met; both phases shipped | DoD unmet | No | Prohibited | No |

Waves within C03A2 (E2E subset expansion) follow §8; `import-order` (external) is gated last.

---

## 11. Owner-action and secret-name checklist

`[OWNER]` — no values, names only.

- [ ] Create the **staging Supabase project** (`paperlume-staging`), confirm **plan** and **region** (Decisions D1/D2). `[OWNER]`
- [ ] Create **dedicated staging test accounts** (primary; secondary for cross-user tests). Never reuse `ps4`. `[OWNER]`
- [ ] Decide the **reset mechanism** — local ephemeral stack (A) vs staging cloud reset (B) (Decision D2). `[OWNER]`
- [ ] Create a GitHub **Environment** (`staging-e2e`) and add secrets: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `TEST_USER_EMAIL`, `TEST_USER_PASSWORD` (+ optional `BASE_URL`; + Model-B reset credential e.g. `STAGING_SUPABASE_DB_PASSWORD` / `STAGING_SUPABASE_ACCESS_TOKEN`). `[OWNER]`
- [ ] Confirm **fork-PR secret protection** and required-reviewer gating on the Environment. `[OWNER]`
- [ ] Confirm staging **Storage bucket + policies** are provisioned by migration replay (needed for `attachments`, Wave 3). `[OWNER]`
- [ ] For Wave 4 only: decide whether to provision a staging `fetch-paper-metadata` deployment / egress for `import-order`, or defer it (Decision D4). `[OWNER]`
- [ ] Explicitly **exclude** `GOOGLE_MONITORING_*` / provider-quota from staging (C29). `[OWNER]`

---

## 12. Owner decision packet

`[DECISION]` — only genuinely open items. (Already-decided items are **not** reopened: PFA-C03 selection, C27–C29, no Production-backed Playwright, no real-Gemini Playwright, the required `Validate` gate, and staged cloud/Production authorization.)

- **D1 — Staging plan/region.** *Why:* determines cost and latency. *Recommended default:* lowest tier that supports the full migration chain + Auth + Storage, same region as Production. *Alternatives:* higher tier; different region. *Trade-off:* cost vs realism/latency. *Blocks:* C03A1.
- **D2 — Reset mechanism (local ephemeral stack A vs staging cloud reset B, or A-then-B).** *Why:* drives determinism, cost, secret surface, and which specs can run first. *Recommended default:* **A** for the initial E2E subset and all of Phase B; introduce **B** only when Storage/Auth-email realism is required. *Alternatives:* B-only; ephemeral Supabase branches (only if the feature/cost is owner-verified). *Trade-off:* realism vs cost/complexity. *Blocks:* C03A1/C03A2/C03B2.
- **D3 — DB-test framework (framework-free hybrid vs pgTAP).** *Why:* maintenance burden and reporting. *Recommended default:* framework-free hybrid (reuse the 18-case file, add siblings). *Alternatives:* adopt pgTAP now. *Trade-off:* zero-dep simplicity vs standardized TAP output. *Blocks:* C03B1.
- **D4 — External-metadata E2E (`import-order`).** *Why:* PubMed/Crossref are nondeterministic and require Edge-Function egress. *Recommended default:* defer to Wave 4 and assert on stable identifiers/counts (not exact remote titles), or provide a deterministic stand-in. *Alternatives:* provision full staging Edge Functions + egress; drop the external assertions. *Trade-off:* coverage vs flakiness/secret/cost. *Blocks:* the final E2E wave only.
- **D5 — Whether/when to promote `e2e-staging` or `db-tests` to a required check.** *Why:* changes the merge gate. *Recommended default:* keep both **non-required** until proven stable; revisit later with evidence. *Alternatives:* promote `db-tests` (deterministic) sooner. *Trade-off:* stronger gate vs merge friction/flakiness. *Blocks:* nothing now; a future decision.

---

## 13. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Staging CI silently falls back to Production | Medium (today's default) | **High** (mutates real data) | Fail-closed env (§5.4) + hard Production-ref denial guard in CI **and** `global-setup.ts` |
| Secrets exposed to fork PRs | Medium | High | Same-repo/`workflow_dispatch` triggers + protected Environment + required reviewers |
| Cleanup-crash leaves real data mutated (esp. `search-attribution`) | Medium | Medium-High | Reset-to-seed as the isolation boundary; disposable fixture paper for six-field spec |
| Count/order-sensitive specs collide under overlap | Medium | Medium | Concurrency guard (one run) + reseed + isolation lane for import specs |
| External metadata drift (`import-order`) | Medium | Medium | Gate to last wave; assert stable fields; optional deterministic stand-in |
| Secret values leak into logs/artifacts | Low | High | Mask; assert on ref substrings; never upload env files |
| Scope creep into required `Validate` | Low | High | New jobs are separate and non-required; `Validate` untouched by contract |
| Staging drifts from Production schema | Medium | Medium | Reset via full migration replay every run |
| Unverified pricing/limit assumptions | Low | Medium | This doc makes **no** pricing/limit claims; owner confirms at provisioning |

---

## 14. Definition of done for PFA-C03

PFA-C03 is complete only when **both** phases have shipped (across separate bounded PRs):

- **Phase A done:** an isolated staging backend exists; Playwright is wired to it fail-closed (no Production fallback; Production-ref guard proven); a **non-required** `E2E (staging)` job runs the initial subset green with documented setup; `Validate / validate` remains unchanged and required. `[FUTURE]`
- **Phase B done:** a database-security suite (reusing/evolving `owner_access_and_quota_verification.sql`) covers cross-user RLS isolation, S1 caller/ownership, RPC EXECUTE grants, AI-quota consume/refund atomicity, storage-quota enforcement, and internal-access non-escalation; it runs in CI (non-required unless the owner promotes it) and includes at least one **negative-control** proof that fails-then-reverts. `[FUTURE]`
- **Finalization:** docs reconciled; owner accepts. `[FUTURE]`

**After PFA-C03A0 (this PR), PFA-C03 is NOT complete.** The next gate is independent review of this contract, then a separately authorized **PFA-C03A1** (owner-side staging provisioning). No implementation phase is authorized by this task.

---

## 15. Evidence appendix

All read-only; gathered on branch `docs/pfa-c03-staging-contract` (from `origin/main` `5b78b08d`).

- **Preflight:** `git status --short` clean; `git rev-parse origin/main` = `5b78b08d074703b6ed5cdd3a1c7a5b118f6a6a38`; no open PRs; no `staging`/`pfa-c03`/`e2e-ci` branches.
- **CI:** `.github/workflows/validate.yml` (lines 1–73).
- **Playwright:** `playwright.config.ts` (1–70); `e2e/global-setup.ts` (1–41); `e2e/helpers.ts` (1–262).
- **E2E specs (13):** `auth`, `bulk-actions`, `eager-load`, `filters`, `paper-import`, `pools`, `filter-presets`, `file-import-order`, `mutations`, `notes`, `search-attribution`, `attachments`, `import-order` (all read in full).
- **Frontend env:** `src/lib/clientEnv.ts`; `src/integrations/supabase/client.ts`; `vite.config.ts`; `package.json` (`dev = vite`); `.env.example`; `.env.test.example`; `.gitignore`.
- **Production-fallback evidence:** untracked `.env` defines `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` and references `lioxtgiputfniqbktcsz` (confirmed by name/count only; **no values printed**); `.env.test` defines only `TEST_USER_EMAIL` + `TEST_USER_PASSWORD`; no `.env.local`/`.env.development` present.
- **Supabase:** `supabase/config.toml` (ref `lioxtgiputfniqbktcsz`; three `verify_jwt=false` functions); 68 migrations (chain end `20260726120000`); storage/quota migrations enumerated in §2.4; `supabase/functions/_shared/env.ts`; secret names + external hosts grepped from `supabase/functions/`.
- **DB test:** `supabase/tests/owner_access_and_quota_verification.sql` (18 cases, `BEGIN … ROLLBACK`).
- **Decisions:** C27/C28/C29 and S1 in [decisions-and-triggers.md](decisions-and-triggers.md); unlock order in [owner-decisions.md](owner-decisions.md); PFA-C03 in [product-feature-audit.md](product-feature-audit.md) §14/§15; line budget in [documentation-policy.md](documentation-policy.md).
