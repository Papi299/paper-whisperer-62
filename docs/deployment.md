# Deployment checklist / release runbook

> **Operator runbook for deploying Paper Whisperer.** Single source of truth for what to run, in what order, for each kind of PR. Consolidates the deployment instructions that previously lived scattered across the README, `start-here.md`, and individual `migration-history.md` entries. Behavior of the running app is unchanged by this doc.

---

## 1. Purpose

This document is the **operator-facing checklist** used immediately before and after deploying any change. Use it whenever a PR has merged and you're about to push to production (Vercel, Supabase Edge runtime, Supabase database, or all three). The audience is the developer or operator doing the deploy — not a fresh contributor onboarding to the codebase (use [README.md](../README.md) for that) and not a future Claude Code session looking for context (use [start-here.md](start-here.md) and [migration-history.md](migration-history.md) for that).

Each section is action-oriented. Where prior PRs already documented a behavior or contract, this doc links rather than restates.

---

## 2. Deployment types

Different PRs require different deploy actions. The table below maps PR scope to required steps. A "Mixed PR" follows every applicable row.

| PR type | Examples | Required deploy action |
|---|---|---|
| **Frontend-only / client code** | React hooks, components, client lib, `src/lib/clientEnv.ts` (PR #138), the `/extension-import` handoff route | Merge → Vercel rebuild from `main`. No `supabase` commands. A new client route needs no server configuration: `vercel.json` already rewrites everything outside `/assets/` to `index.html`, so a deep link and a hard refresh both resolve. |
| **Docs-only** | README, `docs/*.md` (including this file) | Merge only. No runtime deploy. Vercel may rebuild but nothing user-visible changes unless the README is shipped as a docs site (not the case in this repo today). |
| **Chrome extension** | Files under `extension/`, `vite.extension.config.ts`, `tsconfig.extension.json` | **No deploy action exists today.** The extension is built by the required `Validate` check (`npm run build:extension` → `dist-extension/`) and is loaded unpacked for development; its output directory is gitignored and excluded from the Vercel artefact. A merge deploys nothing — **including to the Chrome Web Store**. **Version `0.1.0` is published to testers (`Private`) since 2026-09-30** (`cfanjbamcemoeglgkpbidnclkomaocmo`). The draft item, its population, the review submission and the publication were all manual owner actions in the Developer Dashboard, **not** a deploy or CI path, and no automation in this repository can reach the Store. So a merged extension change reaches no installed copy until a **new version** is packaged, uploaded by hand and approved in a new Google review. That is a separate lifecycle with no runbook here yet; see [chrome-web-store-readiness.md](chrome-web-store-readiness.md) for the release gate. **It does, however, have a Production dependency**: the popup's **Continue in PaperLume** button opens `https://app.paperlume.app/extension-import` in a new tab, so that route must stay live and keep its `?kind=…&value=…` contract. It is a plain navigation — the extension issues no request, holds no session, sends no API call and never sees a response — so the extension needs no host permission for `app.paperlume.app` and no deploy of its own. But a change to the route's URL contract breaks installed copies — the published `0.1.0` among them — that no deploy can reach. Change `EXTENSION_IMPORT_PATH` or the parameter names only additively. |
| **Supabase migration** | Files under `supabase/migrations/` | Merge → run the [Supabase migration deployment](#6-supabase-migration-deployment) sequence. Vercel deploy not blocked by migration but should happen after the DB is in the expected state. |
| **Edge Function code** | Files under `supabase/functions/<name>/`, including `supabase/functions/_shared/*` | Merge → `supabase functions deploy <name> --project-ref <project-ref>` for **every** changed function. **GitHub merge alone does not update Edge Functions.** No `supabase db push`. |
| **Edge Function secrets** | `GEMINI_API_KEY` rotation | `supabase secrets set <NAME>=<value> --project-ref <project-ref>`. No code deploy needed unless secret values are read at module top-level (none are in this repo — every function reads `Deno.env.get` inside the request handler via `requireEdgeEnv`). |
| **Mixed PR** | Frontend + migration; Edge Function + frontend; etc. | Follow each applicable row above, in order: **migration first → Edge Function deploy → frontend (Vercel) last**. Frontend last so the client doesn't briefly call a Function or query a schema that hasn't caught up yet. |

If a PR's report doesn't make its type obvious, look at the file paths in `git diff --stat <merge-commit>^!` against `main`.

---

## 3. Required environment variables

### 3.1 Client / Vercel (build-inlined into the bundle)

| Variable | Source | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase Studio → Project Settings → API → Project URL | Vercel Project Settings → Environment Variables (Production, Preview, Development as appropriate). |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase Studio → Project Settings → API → Project API keys → `anon public` | Public/publishable value by design — safe to inline into the client bundle. |

- Both values are intentionally **public anon-key-style** and are inlined by Vite at build time. They do not grant access beyond what RLS allows for an unauthenticated session.
- Validated client-side by PR #138 — see [`src/lib/clientEnv.ts`](../src/lib/clientEnv.ts). Missing or empty → fail-fast at module load with an actionable error pointing at the README's Local development → Environment setup section.
- **Never put a service-role key in any `VITE_`-prefixed variable.** Vite will inline it into the client bundle. The repo has no service-role usage today (verified by `grep -rn SERVICE_ROLE src/` returning zero matches) and that property must be preserved.

For local dev, the same two values go in a local `.env.local` (or the existing `.env`). See [README → Environment setup](../README.md#environment-setup).

### 3.2 Supabase Edge Function secrets (manually set)

| Variable | Used by | Notes |
|---|---|---|
| `GEMINI_API_KEY` | `analyze-paper`, `suggest-paper-organization` | Required. **One key serves both**, for their Gemini `generateContent` calls — `suggest-paper-organization` reuses the existing secret and introduced no new one, so rotating this value rotates it for both. Without it, each fails safely with a generic 500 **before** any provider call, naming the secret only in its Edge log — `analyze-paper` via its clear in-source throw (preserved by PR #139), which surfaces in the log rather than the response. `analyze-paper` refunds the unit it already consumed; `suggest-paper-organization` checks the key first and consumes nothing. **It was the only AI provider credential installed until 2026-09-18, when the two paid-provider keys were added (rows below).** Repository `main` — and, since the 2026-09-17 Phase 6 deploy, the live generation runtime — registers `google`, `anthropic` and `openai` (C41), and `AI-MULTI-PROVIDER-001C` binds each to its own credential name through the one reviewed mapping in `_shared/aiProviderCredentials.ts` — `google` → this key, `anthropic` → `ANTHROPIC_API_KEY`, `openai` → `OPENAI_API_KEY`. Both of the other two are installed since 2026-09-18 (rows below), so a request that resolves to a paid catalog row now reaches that provider with that provider's own key. Each operation reads **only the selected provider's** variable; for a request that resolves to a Google row that is this key, presented as `x-goog-api-key`. Since Phase 8 on 2026-09-19 both paid rows are `selectable = true`, so an entitled user who explicitly selects Claude Sonnet 5 or GPT-5.6 Terra is served through that provider's own credential instead (§6.6a, §14). This key serves every request that resolves to a **Google** row: no entitlement, no saved preference, a saved Google preference, or a preference that cannot be safely resolved and falls back to the system default (C34). A missing selected-provider credential never falls back to another provider's key. There is no generic `AI_API_KEY` and no `AI_PROVIDER`. Installation of the paid-provider secrets was a separately authorized Phase-5 step (§6.6a) and completed on 2026-09-18. *Historical checkpoints:* at `AI-MULTI-PROVIDER-001A` (C39) completion the seam registered only the Google adapter, and `AI-MULTI-PROVIDER-001B` (C40) added the Anthropic/OpenAI adapters unregistered and no secret. Operator detail: §10.3. |
| `ANTHROPIC_API_KEY` | `analyze-paper`, `suggest-paper-organization` — only for a request routed to an `anthropic` catalog row | **Installed in Production on 2026-09-18** (§6.6a phase 5, §14.1). Named by `AI-MULTI-PROVIDER-001C` (C41) as the credential for the registered Anthropic adapter, and read only when a request resolves to an `anthropic` catalog row; a missing value never falls back to `GEMINI_API_KEY` or `OPENAI_API_KEY`. The `anthropic/claude-sonnet-5` row is `enabled` and — since Phase 8 on 2026-09-19 — `selectable`, so any entitled user can choose Claude Sonnet 5 from Settings and reach this credential; before Phase 8 only an operator-written preference on the acceptance account did (§14.2). Never store it under a generic name. |
| `OPENAI_API_KEY` | `analyze-paper`, `suggest-paper-organization` — only for a request routed to an `openai` catalog row | **Installed in Production on 2026-09-18.** The same terms as `ANTHROPIC_API_KEY`, for the registered OpenAI adapter and the `openai/gpt-5.6-terra` row. |
| `CONSENSUS_API_KEY` | `search-consensus` only | **Installed in Production on 2026-10-03** (§7e). Rotating, replacing or removing it is a separate, explicitly owner-authorized operation, and like any secret change it advances every function's version counter by one. The owner's own Consensus API key. The owner confirmed the **Free** plan on 2026-10-02; per Consensus's own plan table read on 2026-10-03, that plan allows 30 calls a month shared with the owner's Consensus MCP usage, 20 papers per request and 1 request/second. Read server-side by `search-consensus` **only after** the caller has been authenticated and authorized as the owner, and sent to Consensus only in the `x-api-key` header — never in a URL, never logged, never returned, never a `VITE_` variable, never stored in a profile column. Absent → the function answers `503 not_configured` before any Consensus request. Verify it **by name only**: `supabase secrets list` shows an unsalted SHA-256 digest of every value, which must not be printed or recorded for this key. |
| `GEMINI_MODEL` | `analyze-paper`, `get-gemini-provider-quota`, `suggest-paper-organization` | **Optional. This is the SYSTEM DEFAULT model**, not necessarily the model every request uses. All three resolve it through the shared `_shared/geminiModel.ts` with the exact behavioral fallback `gemini-flash-latest`, so they can never disagree about the *default*. Since `AI-MODEL-SELECTION-001B` the two generation functions may route an individual request to an entitled user's saved preference instead (`_shared/aiModelSelection.ts`), while `get-gemini-provider-quota` deliberately keeps reporting this configured default — it is system-wide observational monitoring, not a per-user routing report, so the three may legitimately name different models for the same request. This value remains the fallback for every caller who is not entitled, has no preference, or whose preference cannot be safely resolved. Unset = fallback. **Production currently sets `gemini-3.5-flash`** — the system default under decision **C34**. Changing the default is an environment change here and nothing else: it is not a frontend deploy, not a migration and not a catalog edit, because the Settings control represents "follow the default" as a *sentinel meaning no saved preference* rather than embedding a model string in the browser. `gemini-3.6-flash`, `gemini-3.7-flash` and `gemini-3.8-flash` are all `enabled` and `selectable` in the catalog as explicit choices for entitled users (3.7 and 3.8 added by migration `20260903120000`, C35, **applied to Production on 2026-09-03**). Adding a catalog model never changes this value: the catalog decides what is *selectable*, this variable decides what is *default*. |
| `GOOGLE_CLOUD_PROJECT_ID` | `get-gemini-provider-quota` | **Optional / feature-gated, and currently inert.** Google Cloud project that owns the Gemini API usage. Under C29 **no frontend surface calls this function**, so these three secrets affect nothing today; absent, the function's own response is a bounded "not configured" and ordinary analysis is unaffected. |
| `GOOGLE_MONITORING_CLIENT_EMAIL` | `get-gemini-provider-quota` | Service-account email for the Monitoring reader (below). |
| `GOOGLE_MONITORING_PRIVATE_KEY` | `get-gemini-provider-quota` | Service-account private key (PEM). Escaped `\n` newlines are normalized in-code. **Never** exposed to the browser, logged, or committed. |

Set or rotate:

```sh
supabase secrets set GEMINI_API_KEY=<your-gemini-api-key> --project-ref <project-ref>
```

Check current secrets (names only — values are never displayed):

```sh
supabase secrets list --project-ref <project-ref>
```

- Substitute placeholders verbatim — never paste a real key into a chat, PR description, or commit message.
- Rotating the key takes effect on the next function invocation; no code redeploy needed.

### 3.3 Auto-injected by the Supabase Edge runtime

| Variable | Used by | Notes |
|---|---|---|
| `SUPABASE_URL` | Edge Functions | Auto-injected by the runtime. No manual setup. |
| `SUPABASE_ANON_KEY` | Edge Functions | Auto-injected by the runtime. No manual setup. |
| `SUPABASE_SECRET_KEYS` | `delete-account`; also `analyze-paper` and `suggest-paper-organization`, for the telemetry INSERT (live since 2026-09-17) and the server-only AI-quota refund (C47, live since 2026-09-25; §6.8) | Auto-injected by the runtime. **Server-only elevated key**, JSON dictionary keyed by key name; the function reads `default`. Preferred over the legacy key below. |
| `SUPABASE_SERVICE_ROLE_KEY` | as above | Auto-injected by the runtime. **Server-only elevated key**, legacy plain string; used only as a compatibility fallback when the project has not created the newer secret keys. |

Validated by PR #139 via the `requireEdgeEnv` helper in [`supabase/functions/_shared/env.ts`](../supabase/functions/_shared/env.ts). If for any reason the runtime stops injecting either of the first two, the function fails safely — a request that reaches the environment check is refused rather than served by an empty-string client — and the actionable message naming the variable goes to its **Edge log**. The caller receives a neutral generic 500 that does not name the variable; the body differs per function. Operator detail: §10.2.

**About the elevated key (PFA-C04).** `delete-account` is the only function that needs one for administration: deleting an Auth user is an administrative operation, and the account's private attachment binaries must be removed through the Storage API. `selectEdgeSecretKey()` in [`supabase/functions/_shared/accountDeletion.ts`](../supabase/functions/_shared/accountDeletion.ts) prefers `SUPABASE_SECRET_KEYS["default"]` and falls back to `SUPABASE_SERVICE_ROLE_KEY`; if neither is present the function returns a safe 500 and deletes nothing rather than continuing unprivileged. **Because both are platform-provided, no manual Production secret needs to be added for this function.** The key never leaves the function: it is not returned, not logged, not placed in any response body, and — as §3.1 requires — never carried in a `VITE_*` variable. The generation functions hold the only other elevated-key uses, each a narrow single-call client: the insert-only telemetry writer (below, live) and the server-only quota-refund client (below, live since the 2026-09-25 §6.8 rollout). Every other function remains caller-authenticated and uses no elevated key.

**The telemetry writer (AI-MULTI-PROVIDER-001D, C42 — live in Production since the 2026-09-17 Phase 6 deploy).** `analyze-paper` and `suggest-paper-organization` each build a second, server-only client from the same two platform-injected keys, through the same `selectEdgeSecretKey` rule. It is created lazily, only after a provider call has happened; carries no caller Authorization header and no session; is typed to one `insert` into `ai_provider_usage_events`; and the database grants `service_role` exactly `INSERT` on that table and nothing else on it. Authentication, model selection, entitlement, quota consumption and every product read stay on the caller-authenticated client. No manual secret is added, and a missing key only means the event is not recorded (one bounded log line) — never a failed AI request.

**The quota-refund client (SEC-AI-QUOTA-REFUND-AUTHORITY-001, C47 — live in Production since the 2026-09-25 rollout, §6.8).** `refund_ai_quota` is granted to `service_role` **only** from migration `20260924193915`, because while `authenticated` could execute it any signed-in browser could call it for its own id and reset its own AI quota. `analyze-paper` and `suggest-paper-organization` therefore refund through a **third**, separate client built by [`_shared/aiQuotaRefund.ts`](../supabase/functions/_shared/aiQuotaRefund.ts) from the same two platform-injected keys through the same `selectEdgeSecretKey` rule. It is created lazily — only on a path that already consumed a unit and is about to report a failure — carries no caller Authorization header and no session, bounds its request to 5 s, and is typed to exactly one call, `rpc("refund_ai_quota", { p_user_id })`. The user id is the function's own `auth.getUser()` result, never a request field. It is **not** the telemetry writer's client, which stays insert-only. The refund stays best-effort: a missing key, an RPC error or a thrown fetch is one bounded `<label> refund_failed …=1` line and the original response is unchanged — and there is deliberately **no** fallback to the caller's client, because that fallback is the defect C47 closed. Quota **consumption** is unchanged and stays on the caller's client.

---

## 4. Pre-merge checklist

Before clicking **Merge** on the PR:

- [ ] **The required `Validate` GitHub Actions check is green on the PR's latest head.** `main` is protected to require it: the `.github/workflows/validate.yml` workflow (`npm ci`, lint, `npm run typecheck`, Vitest, production build on Node 22) must pass before the **Merge** button is enabled — a PR cannot be merged while it is pending or failing, and pushing a new commit re-runs it against the new head under strict/up-to-date mode. This is one of the **two** authoritative hosted merge gates — `db-tests` is the other (see the next item) — and neither is satisfied by operator-attested local validation. Zero human approvals are required, but unresolved PR conversations block the merge.
- [ ] **Know which workflows are gates.** `main` protection requires the bare check names `validate` and `db-tests`; a red `db-tests` blocks the **Merge** button, which is intended. `DB Tests` became required on **2026-08-16** when the owner resolved **D5** to `REQUIRE_DB_TESTS`. `E2E (local)` (`.github/workflows/e2e-local.yml`) was deliberately **not** promoted and remains evidence rather than a gate — read it deliberately, because a red or skipped run does not block merging. Both run against an **ephemeral local Supabase stack**, never Production, and fork-origin pull requests skip both before any execution. Vercel is **not** a required check.
- [ ] PR scope matches the title and description — no surprise migration, no surprise Edge Function change, no commercial-doc edit smuggled in.
- [ ] Docs are updated alongside the change, per [`docs/documentation-policy.md`](documentation-policy.md). The PR report ends with a "Documentation updates" section.
- [ ] **If the PR adds a migration:**
  - Local replay still passes, if feasible:
    ```sh
    supabase stop --no-backup
    supabase start
    ```
  - The new migration's filename uses a timestamp **strictly later** than every committed migration. If not, you're in out-of-order territory — see [§6 warnings](#62-warnings).
  - The PR description includes the deploy plan (and any conditional behavior in the migration is documented inline + in `migration-history.md`).
- [ ] **If the PR changes Edge Function code:**
  - The PR description includes the exact `supabase functions deploy` commands.
  - Any new secret requirement is documented in the PR + this doc's §3.2.
- [ ] **If the PR changes env semantics:**
  - `.env.example` / `.env.test.example` reflect new required values (no real secrets).
  - README's "Environment setup" section is accurate.

---

## 5. Pre-deploy local checks

These are **pre-deploy** checks on the merged `main` (and, run before pushing, useful pre-push evidence). They are **not** the protected-branch merge gates — the required hosted checks `validate` and `db-tests` are (§4). Run them from the project root on the merged `main` (after `git pull --ff-only origin main`):

```sh
npm run lint                              # ESLint (0 errors)
npm run typecheck                         # tsconfig.app.json + tsconfig.node.json
npm test                                  # Vitest
npm run build                             # production build
supabase migration list --linked          # confirm Local = Remote on every row
```

When UI behavior changed, run the **safe local E2E lifecycle** — never a Production-backed Playwright run:

```sh
npm run test:e2e:local                    # ephemeral local Supabase stack, fail-closed guard
npm run test:e2e:local:stop               # only if an interrupted run left the stack up
```

When database code changed (migration, RPC, RLS, grants, triggers):

```sh
npm run test:db:local                     # pgTAP suites on an ephemeral local stack
```

A bare `npm run test:e2e` (plain `playwright test`) **deliberately fails closed** without an explicit local backend contract. Do not attempt to point Playwright at the linked/Production project — the merged two-layer guard rejects it, and doing so is not a supported operational path.

- **Do not use plain `npx tsc --noEmit` as a check** — the root solution-style `tsconfig.json` has an empty file set, so it validates nothing (2026-07-18 audit). Use `npm run typecheck`, which runs both project references: `typecheck:app` (`tsc --noEmit -p tsconfig.app.json`) and `typecheck:node` (`tsc --noEmit -p tsconfig.node.json`). Both now pass with **0 diagnostics** (TYPESCRIPT-BASELINE-001, 2026-07-20). **Edge Functions are not covered by tsc** (they target Deno; not part of any `tsconfig` `include`). Edge Function code is bundled and checked by Deno during `supabase functions deploy`.
- `npm test` should pass in full. A count change versus the previous run usually means tests were added/removed in the PR; verify against the PR's stated test delta.
- `npm run lint` should be 0 errors. Pre-existing warnings (e.g. `react-hooks/exhaustive-deps` on `PaperList.tsx:302`, `useBulkMutations.ts:217/366`, `usePaperMutations.ts:235`) are tolerated; **new** warnings on touched files are not.
- `supabase migration list --linked` (from a worktree linked to the project — `/Users/maor/Documents/GitHub/paper-whisperer-62` on the primary dev box) should show **identical values in the Local and Remote columns on every row**. Drift is the trigger for §6.2.

**Do not** run `supabase db push` unless the PR added a migration. **Do not** run `supabase functions deploy` unless the PR touched `supabase/functions/`. Running them anyway is usually a no-op but adds noise — and `db push` with stale state can re-attempt already-applied migrations.

---

## 6. Supabase migration deployment

### 6.1 Standard sequence

```sh
# 1. Verify ledger
supabase migration list --linked

# 2. Dry-run — confirms exactly what would be applied
supabase db push --dry-run

# 3. Read the dry-run output:
#    - It should list ONLY the new migration(s) added in the PR.
#    - If extra (older) migrations appear, STOP — see §6.2.

# 4. Apply
supabase db push

# 5. Re-verify ledger
supabase migration list --linked

# 6. Smoke-test the feature the migration enables.
#    Use the relevant items from §8.
```

### 6.2 Warnings

- **Do not use `--include-all`** unless you are in a documented out-of-order / historical-migration repair scenario like the PR #131 / PR #132 wave that reconciled ledger drift in May 2026. That repair used `supabase migration repair --status applied <version>` for the five April migrations that were applied via the Supabase/Lovable dashboard out-of-band, then `supabase db push --include-all` for the one genuinely new migration. The full sequence is documented in [`migration-history.md`](migration-history.md) under "`20260331010000` made production-safe after remote ledger-drift reconciliation".
- **If `supabase db push --dry-run` shows migrations you don't recognize:** stop. Run `supabase migration list --linked` and compare against `ls supabase/migrations/`. Either the local repo is behind (rare on a freshly-pulled `main`) or the remote ledger has drifted (more common; see PR #131 / #132 history).
- **If Local vs. Remote differ on any row** before you `db push`: do not blindly run `migration repair`. First audit the actual schema state on the remote (e.g., via Supabase Studio SQL editor) to confirm whether the row's effect is already applied. Repair without audit can mark something as applied that wasn't, leaving production half-migrated.
- **Do not rely on a hard-coded ledger version in this runbook.** Before every deployment, run `supabase migration list --linked` and require every previously deployed migration to show as aligned (Local = Remote), with only the migration explicitly approved for the current deployment shown as local-only. A static "current version" here becomes stale after each deploy; the live ledger is the source of truth. Recent reconciliation history is in [`migration-history.md`](migration-history.md).

### 6.3 Web-before-migration is safe for `20260903180000` (extension-import duplicate resolution)

> **Status — this window is CLOSED for the linked project. `20260903180000` is LIVE in Production, verified 2026-09-11.** The ledger holds it exactly once, and the live `safe_bulk_insert_papers`, `bulk_add_paper_projects` and `bulk_add_paper_tags` bodies are byte-identical to the migration's. A bounded, authenticated Production acceptance the same day exercised PMID resolution, `lower(doi)` resolution, the two-row ambiguity refusal and additive Project/Tag assignment on disposable data, all of it removed afterwards — see [migration-history.md](migration-history.md). **Nothing here is a pending step.** What follows is kept as the record of the deployment order, and as the reference for a replay or for any other database that predates `20260903180000`, against which the client still behaves correctly. The exact application date is not recoverable — the ledger has no applied-at column — so none is given. Verify rather than trust this note: `supabase migration list --linked` should list `20260903180000` as applied.

Merging to `main` triggers a Vercel Production deploy. **Vercel does not apply Supabase migrations** — the database half of `CHROME-EXTENSION-IMPORT-001D` is a separate, separately authorized `supabase db push --linked` step, and the web half is deliberately built to be correct in the window between the two.

- **Before the migration is applied.** The deployed `safe_bulk_insert_papers` answers every `unique_violation` with `{ status: "duplicate" }` and **no `id`**. The client treats a duplicate without an id as *unresolved*: it calls neither `bulk_add_paper_projects` nor `bulk_add_paper_tags` — which is what matters, because those functions do not exist yet — and `/extension-import` reports that the selection was not applied, exactly as it did before this change. No runtime error is possible, because no call to a missing function is made.
- **After the migration is applied.** A duplicate that resolves to exactly one owned row starts carrying its `id`, and the same already-deployed client begins adding the selection through the additive RPCs. **No second frontend deploy is required** — the feature activates from the database side.
- **Ordering rule:** web first is safe; database first is also safe (an id the old client never reads changes nothing). What is *not* safe is assuming the feature is live in Production merely because the code merged. Until the migration is applied, duplicates keep failing closed, and any claim that duplicate assignment works in Production must cite the applied migration, not the deploy.
- This is the inverse of the `search-pubmed` / `suggest-paper-organization` endpoint-before-UI rule in §7b/§7c. Those frontends are useless without their endpoint; this one is *correct* without its migration, by construction and by test — see the `calls no additive RPC when the duplicate result carries no id` case in `e2e/extension-import.spec.ts`, which reproduces the pre-migration response against the real route.

### 6.4 Web-before-migration is required for `20260904120000` (recoverable attachment cleanup)

> **Status — this rollout is COMPLETE. Both phases are applied to Production and the procedure below is retained as the record of how, and as the pattern for any future two-phase cutover.** Phase 1 (`20260904110000`) and phase 2 (`20260904120000`) were applied with the operator checkpoint between them — after PR #273 merged on 2026-09-05, and after the corrected frontend had already been deployed. The lifecycle then passed a bounded Production wet acceptance on 2026-09-10 (`ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001` is technically closed). **Do not re-run these steps** — phase 2 refuses to re-apply, and the ledger already carries both rows. Verify rather than trust this note: `supabase migration list --linked` should show 80 rows with `20260904120000` latest.

Same rule as §6.3, same reason: merging to `main` triggers a Vercel Production deploy, **Vercel does not apply Supabase migrations**, and the database half of `ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001` is a separate, separately authorized step. **There is no Edge deployment for this work at all** — `supabase/functions/**` is unchanged.

> #### ⚠ The database half is TWO migrations with a mandatory checkpoint between them
>
> **`supabase db push --linked` applied to both files in one command is NOT a valid rollout.** It is not merely discouraged — it is the specific failure this checkpoint exists to prevent, and `20260904120000` refuses to run when it detects it.
>
> | Phase | File | What it does |
> |---|---|---|
> | 1 | `20260904110000_prepare_merge_lock_order.sql` | Replaces `merge_exact_duplicates` with a body that locks `papers` **before** re-parenting `paper_attachments`. Nothing else. |
> | — | **operator checkpoint** | Verify no transaction predating phase 1 is still open (query below). |
> | 2 | `20260904120000_add_recoverable_attachment_cleanup_queue.sql` | The cutover: the two cleanup tables, the lifecycle RPCs, the Storage fence, the grant revokes, behind the three-table barrier. |
>
> **Why.** `merge_exact_duplicates` as deployed in Production today takes no table lock at all: it reads `papers`, writes `paper_attachments`, and only then issues `DELETE FROM papers` — child before parent. Phase 2's barrier goes parent before child. Those two orders form a wait-for cycle, and it is not hypothetical; reproduced on PostgreSQL 17.6 against the real tables, with **the migration as the victim**:
>
> ```
> ERROR:  deadlock detected
> DETAIL:  Process 325 waits for AccessExclusiveLock on paper_attachments; blocked by process 322.
>          Process 322 waits for RowExclusiveLock on papers; blocked by process 325.
> ```
>
> Reordering phase 2's barrier does not fix it, because the *other* historical writer — a stale bundle's raw `DELETE FROM papers` — runs parent before child, so whichever order the barrier picks, one of the two can cycle with it. `paper_tags` and `paper_projects` do not help either: they are cascade children of `papers` **and** are written by the legacy merge before it touches `paper_attachments`, so the two writers disagree about their order too. The only remaining move is to retire the child-first writer before phase 2 runs — which cannot be done inside phase 2, because **`CREATE OR REPLACE FUNCTION` does not drain in-flight executions.** Measured on this PostgreSQL 17.6, with the old call parked mid-body: the replacement returned in **32 ms**, and the in-flight call still completed with the **old body**. Only calls that *begin* after the replacement commits get the new one.
>
> **The checkpoint, and exactly how it is verified.** After phase 1 commits, run this against the linked project and require **zero rows**:
>
> ```sql
> SELECT pid, usename, application_name, state, now() - xact_start AS open_for
>   FROM pg_stat_activity
>  WHERE datname = current_database()
>    AND pid <> pg_backend_pid()
>    AND backend_type = 'client backend'
>    AND xact_start IS NOT NULL
>    AND xact_start < (SELECT max(xact_start) FROM pg_stat_activity WHERE pid = pg_backend_pid());
> ```
>
> Any transaction that could still be executing the pre-phase-1 merge body necessarily began before phase 1 committed. So once no client transaction older than the current one remains, none can be inside that body — that is the whole drain argument, and it is *checked*, not waited out. Re-run the query until it is empty; do not substitute a fixed wait for it. In practice the merge is a sub-second RPC, so this clears almost immediately, but a long-running session (an open psql, a report, an idle-in-transaction connection) will hold it — end those first.
>
> **Phase 2 enforces both halves itself, fail-closed, before it takes a single lock.** It refuses with `PHASE 1 MISSING` if the installed `merge_exact_duplicates` still re-parents attachments before locking `papers`, and with `DRAIN NOT PROVEN` — naming the offending pids — if any older client transaction is open. The drain half arms only when `auth.users` is non-empty, because the body being drained is reachable only through the merge RPC, which requires `auth.uid()` and paper ownership; a database with no users has nothing to drain, so a bootstrap or a local replay is not falsely reported as a drain failure. Production has users, so it is fully armed there. **If phase 2 refuses, do not retry it blindly** — the refusal is the gate working. Fix the named condition and re-apply.
>
> **If phase 1 succeeds and phase 2 is delayed.** Nothing breaks and nothing is half-applied. Phase 1 changes only *when* one function takes a lock it already took; merge semantics, signature and results are identical, and no table, policy, grant or trigger changes. The application behaves exactly as before, indefinitely. It is in fact strictly better off: parent-first also removes a pre-existing hazard between the legacy merge and an ordinary paper deletion, which are opposite-ordered against each other today. There is no rush and no partial state to babysit.
>
> **If phase 2 fails.** It is one transaction, so it rolls back entirely — no table, RPC, policy or grant change lands. The database stays in the phase-1 state described above, which is fully functional. Read the error, satisfy it, and re-apply. A `DRAIN NOT PROVEN` or `PHASE 1 MISSING` refusal costs nothing; a deadlock, which is what these replace, would have aborted the migration at an arbitrary point in its barrier.
>
> **Rollout record — hosted Production and a clean replay start from different ACLs.** The first Phase-2 attempt passed the phase gate and the barrier and was then refused by the migration's own `DO $verify$`: `anon must not hold SELECT on paper_attachments`. That is not drift anyone introduced. Production was provisioned under Supabase's **old** platform default, which auto-granted ALL (`arwdDxtm`) on every new `public` table to `anon`, `authenticated` and `service_role`, and **most of its ordinary `public` tables still carry that direct `anon` grant** — only the ones created after the default changed are clean. Take the live inventory rather than trusting a number that ages: `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 'anon'::regrole);` A `db reset` today gets the **new** default, which grants the API roles only `Dxtm` (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) and none of the four DML privileges; `20260731162729_reconcile_data_api_grants` then grants back only what each table's policies expose, and grants `anon` nothing on any table. The two environments therefore differ precisely in `SELECT`, `INSERT`, `UPDATE` and `DELETE` for `anon`. So a migration that revoked **by privilege name** converged the replay and left standing on Production whatever it did not name. `paper_attachments` refused as designed; `papers` would have **committed** with `anon` still holding `SELECT`, `INSERT` and `UPDATE`, because the verification there only checked `DELETE` and `TRUNCATE`. Both halves now revoke `anon` and `PUBLIC` **by role**, which converges either starting ACL, and the verification asserts all five privileges for `anon` on both tables. It was an over-broad *reachable surface*, not an exposure: every policy on both tables requires `auth.uid() = user_id`, which is NULL for an anonymous session, so no row was ever reachable. The defect class was invisible to CI because every test ran on a clean replay; `scripts/e2e-local.mjs` now seeds the legacy Production ACL and proves the cutover converges it, and reads the migration's privilege statements out of the migration file rather than restating them.

- **Before the migration is applied.** `attachment_cleanup_queue` and the three cleanup RPCs do not exist. Every call to one comes back as PostgREST `PGRST202`/`PGRST205` (or SQLSTATE `42883`/`42P01`) naming the missing object, and a narrow classifier — which recognises only those four object names, and only under a missing-object code — routes each flow to the behaviour that shipped before this change:
  - **attachment delete:** Storage object first, then the metadata row. On this path Storage-first is what *prevents* an orphan, so a Storage failure correctly leaves both halves intact and the user can retry.
  - **paper / bulk delete:** read the attachment paths, delete the papers, then remove the objects best-effort.
  - **upload:** the browser INSERTs the metadata itself and, if that INSERT fails, removes the just-written object immediately.
  One thing IS better than before even here: a `remove()` that returns `{ error }` — which is how Supabase Storage reports most failures — is now recognised as a cleanup failure instead of being invisible, so the user is told files remain rather than seeing an unqualified success. Nothing else about the pre-migration behaviour changes, deliberately, down to the user-visible strings — including the lost-response weakness on upload, which is fixed by the migration and cannot be fixed from a client against a schema that has no finalization RPC.
- **After the migration is applied.** The same already-deployed client starts taking the durable path: cleanup intent is written in the same transaction as the logical deletion, uploads finalize through one serialized server RPC instead of a browser INSERT, and physical removal is retried immediately and again at the next authenticated session start. The direct-DML privileges the legacy fallback used are gone, which is why the fallback must never be reachable on this database — and it is not, because the RPCs it probes for all exist. **No second frontend deploy is required** — the feature activates from the database side.
- **Ordering rule — web first, and this is now a requirement rather than a preference.** The migration makes two changes that an already-loaded bundle can notice:
  - it **revokes `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on `public.paper_attachments` from `authenticated`**, which keeps `SELECT` — the UI and the account export read the table. Attachment metadata is thereafter created and destroyed only by `finalize_attachment_upload`, `delete_attachment_with_cleanup`, `delete_papers_with_attachment_cleanup`, the cascade those initiate, and account deletion. **`anon` and `PUBLIC` are revoked wholesale** and keep nothing at all, including `SELECT`;
  - it **revokes `DELETE` and `TRUNCATE` on `public.papers` from `authenticated`**, which keeps `SELECT`, `INSERT` and `UPDATE`. `paper_attachments.paper_id` cascades from `papers`, so a direct paper deletion removes attachment metadata without any statement naming it — the same bypass through the parent table. Paper deletion therefore goes through `delete_papers_with_attachment_cleanup`, which records every Storage path before the cascade runs. Creating and editing papers are untouched. **`anon` and `PUBLIC` are revoked wholesale here too** — including `SELECT`, `INSERT` and `UPDATE`, which the product never exposes to an anonymous session;
  - it adds a condition to the `attachments_owner_delete` Storage policy: an object a live `paper_attachments` row still names cannot be deleted by its owner.
  All three are deliberate, and together they are what stops a browser tab still running the pre-migration bundle from producing any historical destructive ordering (see §6.4a). They also mean an old bundle's **upload** fails at its metadata INSERT, its **attachment deletion** fails at the Storage call, and its **paper deletion** fails at the `DELETE`, as soon as the migration lands.
  - **Web first:** correct, and the only order that is also feature-functional throughout. Deployed clients never write the table directly and delete metadata first, so neither the revoke nor the fence ever fires for them, and the durable path activates the moment the migration lands.
  - **Database first:** *non-destructive*, but **not feature-functional**. Until the new bundle reaches a tab, that tab cannot upload an attachment (the direct INSERT is refused with `42501`), cannot delete one (the Storage call is refused), and cannot delete a paper (the direct `DELETE` is refused with `42501`). All three fail visibly and leave every paper, every metadata row and every binary intact — nothing is destroyed and no data is lost — but a user on a stale tab is looking at a broken attachment feature *and* a broken delete button until they reload. Do not describe this order as safe-and-working; it is safe-and-degraded. Prefer web first, and if the order is ever reversed, expect those three symptoms and do not diagnose them as a broken migration.
  - What is *not* safe either way is assuming the durable path is live in Production merely because the code merged. Until the migration is applied, cleanup is still best-effort, and any claim that orphaned binaries are now recoverable in Production must cite the applied migration, not the deploy.
- **Phase 2 takes three brief locks, and may wait.** It opens with the phase gate above — which takes no lock at all, so a refusal there costs nothing — and then, as its first three locking statements, `LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE`, `LOCK TABLE public.papers IN SHARE MODE`, and `LOCK TABLE public.paper_attachments IN ACCESS EXCLUSIVE MODE`, all held until the migration commits. The order and the modes are derived, not chosen:
  - **`auth.users` first.** The two tables this migration creates carry `user_id ... REFERENCES auth.users(id) ON DELETE CASCADE`, and adding a foreign key takes `SHARE ROW EXCLUSIVE` on the *referenced* table. So the migration always needed this lock — the only question was whether it took it explicitly and first, or implicitly and last. Last is a lock-order inversion that deadlocks against an ordinary account deletion, which holds `auth.users` and then cascades into `papers` and `paper_attachments`; taking it first means the migration waits **upstream holding nothing** instead. `SHARE ROW EXCLUSIVE` is exactly what the foreign keys will require, so there is no later lock upgrade (an upgrade is its own deadlock shape); it conflicts with `ROW EXCLUSIVE`, so Auth writers are drained and then excluded; and it does *not* conflict with `ROW SHARE`, so the foreign-key reference checks ordinary inserts make against `auth.users` continue throughout.
  - **then `papers`, in `SHARE`.** A stronger lock there would block the foreign-key check of an in-flight `paper_attachments` INSERT.
  - **then `paper_attachments`.** Locking the child first would put an in-flight `DELETE FROM papers` — which holds the parent and needs the child for its cascade — on the other side of a deadlock nobody can fix, because that transaction is a browser's raw statement. Taking the parents first, each in the weakest mode that still blocks the writers it must, is the only ordering whose remaining hazards are all in code this repository controls; `delete_papers_with_attachment_cleanup` and `merge_exact_duplicates` each take their `papers` lock before touching `paper_attachments` so that they conform.

  This is not tuning — it is what makes the revoke correct. A `REVOKE` locks catalog rows and not the table, so without the barrier a metadata `INSERT` that was permission-checked *before* the cutover could still commit *after* it, and the Storage fence would then be evaluated against a row that had not committed yet. Practical consequences when applying:
  - the migration **waits** for any in-flight Auth, paper or attachment operation to finish before it proceeds, and while it runs it **blocks all writes to `auth.users`** — signup and user creation, account deletion, and Auth user mutation including the sign-in timestamp update (reads of `auth.users`, and the foreign-key reference checks ordinary application inserts make against it, continue) — plus **all access to `paper_attachments`** (reads included) and **all writes to `papers`** (reads of `papers` continue). A signup or sign-in arriving inside the window **waits** rather than failing;
  - everything it does is catalog-only (no table rewrite, no backfill), so the held window is milliseconds; the wait beforehand is however long the longest open attachment transaction takes;
  - there is deliberately **no `lock_timeout`**: a timeout would turn a correctness barrier into a race the migration sometimes loses. Apply it as you would any DDL — not during a known bulk operation.
  - the whole file runs inside an explicit `BEGIN … COMMIT`, so a failed self-verification leaves nothing behind.
- **A partially installed schema is a fault, not an old schema.** The classifier refuses the compatibility verdict once any cleanup object has answered successfully in that browser session. If the queue exists but an RPC does not — a state the transactional migration cannot produce — the error surfaces instead of silently downgrading every user to the older lossy path. If that is ever observed in Production, treat it as a broken migration, not a rollout window.

#### 6.4a Which client is running, against which database

Four combinations exist during a rollout, and only one of them is degraded. Production has since completed the rollout, so only the second row still describes it:

| Frontend | Database | Behaviour |
|---|---|---|
| corrected (this PR) | pre-migration | Works, through narrow legacy compatibility: browser-side metadata INSERT and immediate compensation, exactly what shipped, including its lost-response weakness — which is a schema-level fix and cannot be made from a client. Neither the revoke nor the Storage fence exists yet, so nothing else changes. |
| corrected | post-migration | The intended design: serialized finalization, durable tombstone, atomic enqueue-before-delete, fenced Storage deletes, and metadata writes only through the lifecycle RPCs. |
| **stale** (loaded before the deploy) | pre-migration | Unchanged. This combination no longer occurs in Production — the migration has been applied — and it is the state this feature replaced. |
| **stale** | post-migration | Safe but degraded. **Upload fails**: the direct metadata INSERT is refused with `42501`, so no attachment is created — the old bundle then runs its immediate Storage cleanup and, if that succeeds, nothing is left. **Attachment deletion fails**: the Storage call is refused by the fence, so the tab reports "Delete failed" and both halves survive. **Paper deletion fails**: the direct `DELETE FROM papers` is refused with `42501`, so the paper, its attachment metadata and its binaries all survive — and because that bundle reads the paths, deletes the papers and only then calls Storage, the refusal at step two means step three never runs, so it cannot strip files off papers it did not delete. **A lost-response compensation is refused** too, so a valid attachment's binary cannot be destroyed. Nothing is destroyed in any of these cases, and the user gets the feature back by reloading onto the new bundle. |

The last row is the point of the three changes together: the destructive orderings are not merely no longer written, they are no longer permitted — the half-state that made them dangerous (a committed metadata row whose binary the same tab deletes) can no longer be created at all, and attachment metadata can no longer be removed through the parent table either.

**The one residual, stated plainly.** A stale bundle cannot obtain durable cleanup: it cannot call functionality it does not know exists, so it writes no queue row and no tombstone. If its upload is refused **and** its own immediate Storage cleanup also fails, the uploaded binary remains as an untracked orphan. That object is inside the owner's private namespace, is unreachable to anyone else, and is removed by the account-deletion Storage sweep, which enumerates Storage itself rather than trusting any metadata or queue inventory. The window is bounded by how long stale tabs live after the deploy. This is a rollout edge, not a reason to reopen autonomous-worker scope — and it is strictly better than the pre-migration behaviour it replaces, where the same failure could leave a *committed* attachment row pointing at a file the tab had already deleted.

**Post-migration verification (structural, non-destructive).** After applying, confirm on the linked project that `public.attachment_cleanup_queue` exists with RLS enabled *and* forced, exactly two policies (SELECT, DELETE), `authenticated` holding SELECT+DELETE and **not** INSERT/UPDATE, `anon`/`service_role`/`PUBLIC` holding nothing, the `(user_id, file_path)` unique constraint present, the `auth.users` FK cascading, and no FK to `papers`/`paper_attachments`; that all three client RPCs are `SECURITY DEFINER` with `search_path=public` and executable by `authenticated` only; that `trg_paper_attachments_block_cleanup_intent` exists on `paper_attachments` alongside the two pre-existing storage-quota triggers; that `public.attachment_cleanup_tombstone` exists with RLS enabled *and* forced, **zero** policies and no privilege for any client role; that `authenticated` holds **`SELECT` only** on `public.paper_attachments` — no `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE`, with `anon` and `PUBLIC` holding nothing at all; that `authenticated` holds **`SELECT`, `INSERT` and `UPDATE` but neither `DELETE` nor `TRUNCATE`** on `public.papers`, with `anon` holding none of the five; and that `attachments_owner_delete` on `storage.objects` still carries its owner-prefix condition and now also calls `attachment_object_has_live_metadata`, with `idx_paper_attachments_user_file_path` present to serve it. The migration's own `DO $verify$` block asserts all of this inside the same transaction — plus that `finalize_attachment_upload` serializes before it reads, that no `queue_untracked_attachment_cleanup` function exists, and that all three cutover barriers — `SHARE ROW EXCLUSIVE` on `auth.users`, `SHARE` on `public.papers` and `ACCESS EXCLUSIVE` on `public.paper_attachments` — are still held, granted, by the migration's own backend at the moment the privilege posture is checked — so a successful apply already proves it; this is the read-back, not a second gate.

### 6.5 No ordering constraint for `20260910212202` (Data API ACL reconciliation) — COMPLETE

> **Status — COMPLETE. APPLIED TO PRODUCTION 2026-09-11. DO NOT RE-RUN AS A
> PENDING DEPLOY.** PR #275 merged as `9ca298ba14c32459200ea84db4fa16bd75e20057`
> and the migration was applied **exactly once**, in a single successful
> `supabase db push` that needed no retry. The ledger moved **80 → 81**, its
> latest became `20260910212202`, and ordinary `public` tables carrying a direct
> `anon` grant moved **17 → 0**. A read-only postflight confirmed the full
> contract below. **Nothing here is a pending step.** The procedure that follows
> is retained as the record of how it was done and as generic
> recovery/replay reference — not as something to execute again against this
> project. Verify rather than trust this note: `supabase migration list --linked`
> should show `20260910212202` present exactly once. (The ledger has since moved
> on: **83** rows, latest `20260913120000`, since 2026-09-13 — §6.6, §6.7.)

**What it changes.** Client-role object privileges only: `PUBLIC`, `anon` and
`authenticated` on the 28 ordinary `public` tables and the one sequence, plus the
default privileges `postgres` hands to FUTURE tables and sequences in `public`.
It changes no RLS policy, no function, no trigger, no column and no row.
`service_role` is referenced by the preconditions and the verification, but it
is named in no privilege-mutating `GRANT`, `REVOKE` or
`ALTER DEFAULT PRIVILEGES` statement; its exact observed posture is preserved,
and the migration refuses to commit if that posture moved.

**Ordering: none required, in either direction.** Unlike §6.4, this migration
needs no web-first deploy, no Edge deploy, no operator drain and no lock barrier.
The reason is not that the risk was accepted — it is that the class of race §6.4
guards against cannot arise here:

- every privilege it removes is one the shipped bundle does not use: either RLS
  already denies that role every row (no policy, or a policy `anon` can never
  satisfy), or it is a non-DML privilege (`TRUNCATE`, `REFERENCES`, `TRIGGER`,
  `MAINTAIN`) that no application path exercises;
- the DML surface `authenticated` actually uses is **identical** before and
  after — the re-`GRANT`s restate it inside the same transaction — so no
  in-flight request can lose a privilege it was planned with.

**Stale browser tabs were unaffected.** No shipped bundle issues a statement that
uses a revoked privilege. The one observable difference is in operations that
never worked: a hand-written request that previously returned "0 rows affected"
(RLS filtered it) now returns `42501` instead.

**Preflight (read-only) — the historical rollout sequence.** The migration pins
its own preconditions and refuses an unexpected schema, so the useful preflight
was confirming which state Production was in. These are the commands that were
run on 2026-09-11, kept as the record and as the pattern for a comparable
future ACL migration. **Against this project they are now satisfied** — the
migration is applied, so a dry-run here proposes nothing:

```sh
supabase migration list --linked          # then: this migration local-only. NOW: aligned (82/82 since 2026-09-12)
supabase db push --dry-run                # then: EXACTLY this one migration. NOW: nothing to push
```

```sql
-- 28 ordinary tables, 1 sequence, all owned by postgres, and no other Data API relation
select c.relkind, count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p','v','m','f','S') group by 1;
-- the starting default-privilege entries — judged WHOLE, see below
select d.defaclobjtype, d.defaclacl from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
 where n.nspname = 'public' and pg_get_userbyid(d.defaclrole) = 'postgres';
```

A table added since the audit **must** stop the rollout: its intended surface has
never been reviewed, and the migration will refuse it rather than guess.

The same holds for the default privileges. For TABLES (`r`) and SEQUENCES (`S`)
the entry must be one of the two audited histories **as a whole**: `postgres`
holds its full owner set; `anon` and `authenticated` both hold ALL / `rwU`
(hosted, as Production stood before this rollout) or both hold `Dxtm` / `w`
(after Supabase's 2026-10-30 change); `service_role` holds either shape; and nothing else appears — no direct `PUBLIC`
entry and no other role. Anything else — an `authenticated` entry that differs
from `anon`'s, an unfamiliar grantee — makes the migration refuse before it
changes anything. That is a reason to re-audit, never to relax the precondition.

**Supabase's own 2026-10-30 change is compatible in both orders.** Supabase moves
existing projects to opt-in Data API defaults on that date, keeping existing table
grants. Its statements are `REVOKE`s and narrower than this migration's, so
applying them after it restores nothing; and if they land first, the migration's
preconditions accept that shape and simply remove the remainder. Suite 015 proves
this by running Supabase's documented statements against the converged state.

**Apply — already done; do not repeat.** It was applied with the standard §6.1
sequence, as one `supabase db push`. The file is wrapped in an explicit
`BEGIN … COMMIT` and ends with a fail-closed verification block, so it either
produces the reviewed matrix or leaves the database untouched — which is also
why re-running it is unnecessary rather than merely discouraged: the ledger
already carries its row.

**Postflight (read-only) — run on 2026-09-11, and still the right re-check.**
These queries returned the required empty/converged results then, and they
remain the SELECT-only way to re-confirm the live posture at any time:

```sql
-- must return no rows: PUBLIC (grantee 0) and anon reach nothing
select c.relname, a.grantee, a.privilege_type
  from pg_class c join pg_namespace n on n.oid = c.relnamespace,
       aclexplode(coalesce(c.relacl, acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end, c.relowner))) a
 where n.nspname = 'public' and c.relkind in ('r','p','v','m','f','S')
   and a.grantee in (0, 'anon'::regrole);
-- authenticated on the sequence must be USAGE only
select relacl from pg_class where oid = 'public.papers_insert_order_seq'::regclass;
-- must return no rows: only the owner and service_role remain in the defaults
select d.defaclobjtype, a.grantee, a.privilege_type
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
 where n.nspname = 'public' and pg_get_userbyid(d.defaclrole) = 'postgres' and d.defaclobjtype in ('r','S')
   and a.grantee not in ('postgres'::regrole, 'service_role'::regrole);
```

Then a signed-in smoke pass: load the library, add/edit/delete a paper, edit tags
and projects, add and remove a keyword and a study type, save a filter preset,
open Analytics, and confirm the storage gauge and AI quota still render. **On
2026-09-11 that pass was deliberately not run**: the rollout authorization was
read-only outside the migration itself, so runtime observation was limited to
non-mutating signed-out `GET`s of `/` and `/auth` (both `200`). The pass above
stays the right check for a comparable future ACL change, and remains available
on demand here.

**Rollback (reference only — not invoked).** Re-`GRANT` the previous posture.
Nothing here touches data, so recovery is a privilege statement, not a
restore. The correct target is the intended matrix — if a real dependency surfaces, re-grant that one privilege on
that one table and amend the matrix, its test and this runbook together, rather
than restoring the legacy blanket ACL.

### 6.6 Migration-BEFORE-merge is required for `20260912120000` (model-aware reasoning policy) — PHASES 1–2 COMPLETE: applied 2026-09-12, merged 2026-09-13; Phase 3 (001D) foundation COMPLETE

> **Status — Phases 1 and 2 COMPLETE; the Phase 3 foundation is COMPLETE too (§6.7); Phase 6 is COMPLETE (§6.6a). Do not re-run the migration or the merge as a pending step.** `20260912120000` was applied to Production on 2026-09-12, exactly once, with `supabase db push --linked` from the approved PR head `8001fce8182859a7cfd1d597573112df502ef3fd`, and verified while the old frontend and the pre-001A Edge runtime stayed live. That left the ledger aligned at **82** rows, latest `20260912120000`; it went to **83** rows, latest `20260913120000` (§6.7), and stands at **86** today (§15). Manual reasoning stayed staged off at that point and no provider secret was installed; both were released later, by `AI-MULTI-PROVIDER-001E` (§14) and `AI-MANUAL-REASONING-001` (§15) respectively. `analyze-paper` v26 / `suggest-paper-organization` v10 were unchanged by this migration and advanced only at the separately authorized Phase 6 deploy on 2026-09-17 (§6.6a). The procedure below is kept as the record of that rollout and as a reusable pattern.
>
> - **Phase 1 completed (2026-09-12):** independent approval of the implementation head; explicit authorization of the Production migration; its application; old-app verification (read-only — see the note after the procedure).
> - **Phase 2 completed (2026-09-13):** PR #280 merged at its independently approved head `d62994ef67ff8f27763a442bd9f63f4d7f7b54f5` as the regular two-parent merge `1c4c9b5882628cbe6ab7bead60e7f4eac0bed0b4`, whose tree is identical to that head. Merged-main CI passed, and the automatic Vercel Production deployment of that commit reached READY, putting the 001C frontend live. **No Edge Function was deployed** by the merge: `analyze-paper` v26 and `suggest-paper-organization` v10 were unchanged, and manual reasoning remained staged off at that date.
> - **Phase 3 (001D telemetry foundation) — COMPLETE:** the repository implementation merged on 2026-09-13 (PR #282), migration `20260913120000` was applied to Production on 2026-09-13, and the Privacy Policy disclosure was published with effective date September 17, 2026 (PR #283) (§6.7). Telemetry collection started with Phase 6.
> - **Phase 6 and the Google part of Phase 7 — COMPLETE (2026-09-17):** both generation functions were deployed together from `main` `f962b44d` (`analyze-paper` v27, `suggest-paper-organization` v11), followed by a bounded Gemini telemetry canary that passed (§6.6a, §6.7).
> - **Later, each separately authorized — and all since completed:** paid-provider row staging and provider secrets (2026-09-18), the paid-provider canaries (2026-09-18), and user enablement at Phase 8 (2026-09-19), with manual reasoning following separately the same day (§6.6a, §14, §15).

**The `AI-MULTI-PROVIDER-001C` pull request must not be merged until this migration has been separately authorized, applied to Production, and verified while the old application is still live** (decision C41). The merged frontend reads `ai_model_catalog.reasoning_levels`, `auto_analyze_reasoning_level`, `auto_suggest_reasoning_level` and `reasoning_selectable`, and the merged account export reads `user_ai_preferences.preferred_reasoning_level`. An ordinary merge redeploys the frontend on Vercel, so merging first would put code that names those columns in front of a database that has none of them.

**Why pre-applying it to the OLD application is safe.** Every change is additive and backward compatible:

- the four catalog columns are new and nothing deployed reads them;
- `preferred_reasoning_level` is nullable with no backfill, so every existing preference row keeps its exact meaning;
- `set_current_user_ai_model` only **gains** a result column (`reasoning_reset`). The deployed Settings hook reads `saved`, `reason` and `display_name` by name, so the extra field is invisible to it;
- `clear_current_user_ai_model`'s body is untouched; only its comment changes;
- `set_current_user_ai_reasoning` and `clear_current_user_ai_reasoning` are new objects that nothing deployed calls.

**Applying it activates nothing** — a permanent property of `20260912120000` itself, not of Production today. Every Gemini row gets `reasoning_selectable = false`. `set_current_user_ai_reasoning` is granted to **no role**, and the migration's own self-check fails if `authenticated` can execute it. No `anthropic/*` or `openai/*` row is added. A user could neither create nor see a manual reasoning level after this migration alone; the separately authorized `AI-MANUAL-REASONING-001` opened both locks on 2026-09-19 (§15).

```text
1. independent review approves the exact 001C PR head
2. obtain explicit owner authorization for the Production migration
3. supabase migration list --linked              # then: ledger ended at 20260910212202 (pre-application checkpoint; after it 82 rows, latest 20260912120000; NOW 83 rows, latest 20260913120000)
   supabase db push --linked --dry-run           # then: listed ONLY 20260912120000 (NOW: nothing to push)
4. apply it while the OLD frontend and the OLD (pre-001A) Edge runtime are live:
   supabase db push --linked
5. verify, read-only (see the checks below)
6. confirm the old application is healthy: Settings loads and saves a model,
   Analyze succeeds, Suggest succeeds, the account export downloads
7. re-read the PR head and confirm it is STILL the exact approved SHA
8. only then merge that exact head; the automatic Vercel deploy then runs
   against the new schema
```

**How steps 1–6 actually ran (2026-09-12).** Steps 1–5 ran as written, and every step-5 check below passed. Step 6 was performed **read-only**: the old frontend bundle kept serving unchanged, and its exact catalog and saved-preference reads succeeded as `authenticated`. Saving a model, Analyze, Suggest and the account export were **not** exercised, because that authorization permitted no preference write and no AI quota use. Steps 7–8 ran on 2026-09-13 as the Phase 2 merge recorded above.

Read-only post-apply checks (step 5):

- the four Gemini rows carry exactly the C41 matrix: 3.5/3.6 `{minimal,low,medium,high}` with analyze `minimal`; 3.7/3.8 `{low,medium,high}` with analyze `low`; suggest `medium` on all four;
- `count(*) WHERE reasoning_selectable` = 0, and `count(*) WHERE provider <> 'google'` = 0;
- `count(*) FROM user_ai_preferences WHERE preferred_reasoning_level IS NOT NULL` = 0;
- `has_function_privilege('authenticated', 'public.set_current_user_ai_reasoning(text)', 'EXECUTE')` = **false**;
- `has_function_privilege('authenticated', 'public.clear_current_user_ai_reasoning()', 'EXECUTE')` = true;
- neither new function is executable by `anon` or `service_role`.

Remember the Production legacy-ACL history (§6.5): assert grants on **exact privileges**, not on privilege names that Production renders differently.

**Rollback (reference only).** The migration writes no user data, so reverting it is a schema operation: drop the two new functions, restore the 001A `set_current_user_ai_model` signature, drop the five catalog constraints and four columns, and drop the preference column and its constraint. Do that only while no merged application depends on them. **Once the 001C head is merged, revert the application first.**

#### 6.6a The full AI-MULTI-PROVIDER rollout order (reference — the 001C PR executed none of it; all eight phases COMPLETE, 2026-09-12 → 2026-09-19)

```text
Phase 1  schema expansion             apply 20260912120000 (this section)   COMPLETE 2026-09-12
Phase 2  application merge            merge the exact approved 001C head   COMPLETE 2026-09-13 (PR #280, 1c4c9b5)
Phase 3  telemetry foundation         AI-MULTI-PROVIDER-001D (usage/cost)   COMPLETE: merged 2026-09-13 (PR #282);
                                      migration 20260913120000 applied 2026-09-13;
                                      Privacy Policy disclosure published 2026-09-17
                                      (PR #283) (§6.7). Collection started at Phase 6
Phase 4  stage paid-provider rows     separate migration: anthropic/claude-sonnet-5 and   COMPLETE 2026-09-18:
                                      openai/gpt-5.6-terra with the C41 future values,    20260917201856 applied (ledger 84)
                                      selectable = false, reasoning_selectable = false
Phase 5  install provider secrets     ANTHROPIC_API_KEY, OPENAI_API_KEY (§3.2)            COMPLETE 2026-09-18
Phase 6  deploy BOTH generation       analyze-paper AND suggest-paper-organization        COMPLETE 2026-09-17: from main f962b44d;
         Edge Functions together      (§7c) — never before Phase 1                        analyze-paper v27, suggest v11 (§6.7)
Phase 7  controlled live canary       per provider, per operation                         COMPLETE: Google/Gemini 2026-09-17 (§6.7);
                                                                                          Anthropic + OpenAI 2026-09-18 (§14.1a)
Phase 8  user enablement              separate migration: open the paid models to user    COMPLETE 2026-09-19:
                                      selection (selectable = true on the two paid rows)  20260918210017 applied (ledger 85).
                                                                                          Manual reasoning + the reasoning
                                                                                          setter grant were DEFERRED out of
                                                                                          001E and completed separately the
                                                                                          same day by AI-MANUAL-REASONING-001
                                                                                          (20260919075655, ledger 86 — §15)
```

**All eight phases are complete.** The paid-provider rows were staged and both credentials installed on 2026-09-18, the generation functions were redeployed from `ef8ad768` (`analyze-paper` v29, `suggest-paper-organization` v13), and the Claude Sonnet 5 and GPT-5.6 Terra canaries passed that day (§14.1a). Phase 8 followed on 2026-09-19: `20260918210017` set `selectable = true` on exactly those two rows, so both models are now offered to entitled users. **What the original Phase-8 line also contemplated — flipping `reasoning_selectable` and granting `set_current_user_ai_reasoning` — was deliberately NOT done by 001E.** Manual reasoning was a separate initiative, not leftover 001E work. That initiative is `AI-MANUAL-REASONING-001` (C45, §15), and it completed later the same day: `20260919075655` was applied on 2026-09-19 (ledger 85 → 86), so manual reasoning is now live and Production-accepted. The paragraph below records the earlier Phase 6 milestone.

**Historical checkpoint — state on 2026-09-17, after Phase 6 and the Google canary and before the paid-provider staging, credential, canary and activation work.** Both generation functions had been deployed together from `main` `f962b44d`, and the bounded Production telemetry canary on the live Gemini models had passed (§6.7; [migration-history.md](migration-history.md)). Phases 4 and 5 were not prerequisites of Phase 6: at that checkpoint no paid-provider catalog row or credential existed, so the deployed runtime could not route a request to Anthropic or OpenAI. Phases 4 and 5, the paid-provider canaries and Phase 8 still remained, each needing its own authorization. All of them completed on 2026-09-18 and 2026-09-19, as the phase table and the paragraph above record and §14 details.

Each phase needs its own explicit authorization. **Phase 6 must never precede Phase 1.** The 001C runtime reads `preferred_reasoning_level` in its preference query, and against the old schema that read fails. Every entitled user would then fall back to the system default with `preference_lookup_failed`, and saved model choices would silently stop being honoured.

**Phase 6 changed Gemini behaviour on purpose.** Before it, Production sent no thinking level, so both operations ran at Google's implicit `medium`. With the 001C runtime, live since 2026-09-17:

- Analyze sends PaperLume's `minimal` (3.5/3.6) or `low` (3.7/3.8);
- Suggest sends `medium` explicitly.

This is approved product policy (C41), not a regression. The Phase 6 canary confirmed the levels actually sent on Gemini 3.5 Flash (Analyze `minimal`, Suggest `medium`, from telemetry and the Edge logs) and that Analyze returned its complete, non-empty contract at `minimal`. It did not assess output quality: canary output was deliberately neither retained nor reviewed.

### 6.7 `20260913120000` (provider-usage telemetry) — apply BEFORE the generation Edge deploy; COMPLETE: applied 2026-09-13, Privacy Policy published 2026-09-17, collection LIVE since the 2026-09-17 Phase 6 deploy

> **Status — migration COMPLETE, Privacy Policy prerequisite COMPLETE, and telemetry collection LIVE since the 2026-09-17 Phase 6 deploy. Do not re-run the migration as a pending step.**
>
> - **Applied 2026-09-13, exactly once.** One `supabase db push --linked` from `main` `96777816` (PR #282, merged 2026-09-13 20:33:47Z). The operator's record shows a read-only preflight at 21:23:22Z that found the ledger at 82 rows with the version absent, then one push from 21:23:22Z to 21:23:35Z that exited 0. The Production ledger stores no application time and commit timestamps are off, so that window comes from the operator record, not the database.
> - **Re-verified read-only on 2026-09-17 (03:17:59Z, inside `SET TRANSACTION READ ONLY`):**
>   - the ledger holds **83** rows, latest `20260913120000`, which is present exactly once;
>   - `public.ai_provider_usage_events` exists, owned by `postgres`, with RLS enabled and forced and zero policies;
>   - its ACL is `{postgres=arwdDxtm/postgres,service_role=a/postgres}` with no column ACL, so `anon` and `authenticated` hold no privilege and `service_role` holds `INSERT` only;
>   - `user_id` cascades from `auth.users`;
>   - it held **0 rows** (`n_tup_ins` 0) — before Phase 6;
>   - the catalog is still the four Google rows with `reasoning_selectable` false on all of them, and the reasoning setter is still ungranted — both before `AI-MULTI-PROVIDER-001E` and before `AI-MANUAL-REASONING-001` (§15);
>   - Edge was still `analyze-paper` v26 and `suggest-paper-organization` v10 — before Phase 6.
> - **Privacy Policy published, effective September 17, 2026.**
>   - What changed: the owner-approved amendment added the "AI usage records" disclosure (§2), its purpose (§5), account-lifetime retention (§13), and the export exclusion with access on request, "Subject to applicable law" (§15).
>   - How it went live: PR #283 merged as the two-parent `24591dfd` (2026-09-16 22:47:20Z UTC, 01:47 on September 17 in Israel), and its automatic Vercel Production deployment put it on `app.paperlume.app/privacy`.
>   - Verification: the live page was checked signed out right after that deployment, and again on 2026-09-17.
> - **Live: telemetry collection, since 2026-09-17.** The §6.6a Phase 6 deploy of both generation functions put the writer live, and the bounded canary that followed recorded exactly three content-free events (acceptance record below). The procedure that follows is the record of the migration step.

**What it adds.** One table, `public.ai_provider_usage_events` (C42), with RLS enabled and forced, no policy, two indexes, and a fail-closed verify block. It touches no existing table, backfills nothing, adds no function, sequence or trigger, and adds no catalog row. Creating the `user_id` foreign key takes a brief `SHARE ROW EXCLUSIVE` lock on `auth.users` for the (catalog-only) duration of the transaction, so signups and account deletions wait out that moment and it waits for any open `auth.users` write; no application table is locked.

**Ordering.**

- **Merge before migration was safe.** No frontend code reads or writes the table (the regenerated `types.ts` only describes it), and nothing deployed at the time wrote it.
- **Migration before the generation Edge deploy is required — satisfied (applied 2026-09-13).** The 001D runtime writes one event per provider call. Deployed against a database without the table, every write is refused and logged as `usage_telemetry recorded=0 reason=write_rejected` — the user response and quota are unaffected, but the telemetry record is empty from day one. That is why this migration had to precede §6.6a Phase 6.
- **The public Privacy Policy had to disclose telemetry before it went live — satisfied (published, effective September 17, 2026).** Since the 001D runtime was deployed (2026-09-17), PaperLume persists a per-user record of each AI request's provider, model and token usage. [`src/pages/Privacy.tsx`](../src/pages/Privacy.tsx) is owner-approved legal text, so the disclosure was owner-approved before publication (PR #283). The amendment is provider-neutral, and enabling a paid provider remains a new recipient that needs its own privacy review ([privacy-data-flow-audit.md](privacy-data-flow-audit.md) §8). See [privacy-data-flow-audit.md](privacy-data-flow-audit.md) §29 for the telemetry itself.

**Why the grant statements are sufficient on hosted Production.** Read-only inspection on 2026-09-13 found `postgres`'s TABLE default in `public` granting `service_role=arwdDxtm` (and nothing to `PUBLIC`, `anon` or `authenticated`, per C38). The migration revokes by **role** from `PUBLIC, anon, authenticated, service_role` and then grants `INSERT` to `service_role`, and its verify block is an allowlist over the whole ACL, so a default-privilege entry the audit did not see fails the migration rather than shipping.

```text
1. obtain explicit owner authorization
2. supabase migration list --linked         # then: 82 rows, latest 20260912120000 (NOW 83 rows, latest 20260913120000)
   supabase db push --linked --dry-run      # then: listed ONLY 20260913120000 (NOW: nothing to push)
3. supabase db push --linked
4. read-only verification (below)
```

Read-only post-apply checks (all passed again on 2026-09-17; see the status above):

- ledger 83 rows, latest `20260913120000`, present exactly once;
- `relrowsecurity` and `relforcerowsecurity` both true; zero rows in `pg_policy` for the table;
- the non-owner ACL is exactly `service_role:INSERT`;
- `has_table_privilege('anon' | 'authenticated', 'public.ai_provider_usage_events', …)` false for all eight privileges;
- `count(*) = 0` at application (the migration creates no row; events have accrued since Phase 6);
- the `user_id` FK cascades from `auth.users`.

**Canary expectations (reusable; first executed in the 2026-09-17 Phase 6 acceptance).** Re-read the row count immediately before a deploy, and attribute later events by user, operation and time window rather than by the global count, which real traffic now moves. Each canary request should produce exactly one event whose `provider`, `provider_model`, `operation` and `provider_attempts` match the request; a Gemini success should read `usage_status = reported`; and the Edge log should contain `usage_telemetry recorded=1` and no `recorded=0` line. A `recorded=0` line during a canary is a telemetry reliability failure to resolve before any paid provider is activated. A provider-side failure (HTTP 429/5xx, timeout, network) is **not** a telemetry failure: it should produce one failure event with `usage_status = absent`, NULL token fields and `cost_status = usage_unavailable`, plus a quota refund, and those should be verified before any bounded retry.

**The canary fixture.** The dedicated Production acceptance account deliberately keeps **one synthetic, non-sensitive paper** ("PaperLume Phase 6 Canary — Synthetic Sleep and Memory Study"), created on 2026-09-17 through the account's own authenticated Data API session under RLS, with no Project, Tag or assignment. It exists so a future Analyze/Suggest canary has an owned paper to name. Do not delete it, and do not add Projects or Tags to it just to make Suggest produce output — an all-new-suggestions answer is a valid result. Never put the account's credentials in the repository, and do not record the fixture paper's id.

**Phase 6 acceptance record (2026-09-17).** Full detail, with evidence classes, is in [migration-history.md](migration-history.md).

- The pre-deploy count was 0. Pre-provider smokes (`OPTIONS`, unauthenticated `POST`, invalid authenticated `POST` on both functions) returned 200/401/400, spent no quota and wrote no event.
- **Analyze:** HTTP 200, one attempt; event `google` / `gemini-3.5-flash`, `system_default`, `automatic` → `minimal`, `completed`, `succeeded`, usage `reported` (520 input / 68 output / 588 total), `estimated` at $0.001392000000000 under `google/gemini-3.5-flash@2026-09-13`.
- **Suggest:** the first request met a Google **HTTP 503** on its single attempt. The quota unit was refunded, and the failure event reads `http_error` 503, `failed`, usage `absent`, NULL tokens and `usage_unavailable`. The one permitted retry returned HTTP 200 at `automatic` → `medium`, usage `reported` (755 input / 1,102 output including 835 reasoning / 1,857 total), `estimated` at $0.011050500000000.
- **Totals:** three events, three `recorded=1` log lines and no `recorded=0`, quota 0 → 2 on the acceptance account, no paper/Project/Tag/assignment mutation, all Google. Both estimates matched an independent exact recomputation.

**Rollback (reference only).** `DROP TABLE public.ai_provider_usage_events;` — nothing depends on it. If a runtime that writes it is already deployed, dropping it degrades that runtime to logged `write_rejected` lines, with no user-visible change.

---

### 6.8 `20260924193915` (server-only AI-quota refund, C47) — migration FIRST, then deploy BOTH generation functions; COMPLETE: applied and both functions deployed 2026-09-25

> **Status — COMPLETE. The migration-first rollout finished on 2026-09-25 and the server-only refund is live in Production. Do not re-run the migration or the deploys as a pending step.**
>
> - **Merged.** PR #299 as the two-parent commit `dca8a0be3daa61f45d1f18e2aa526e8a444a320e` (parents `f06107b6` and the approved head `4e18b352`). Merged-`main` Validate, DB Tests and Extension passed on that commit, and Vercel's automatic production deployment of it is READY.
> - **Migration first.** `20260924193915_make_ai_quota_refund_server_only.sql` was applied under its own repository version; its statements are in the Production Postgres log at 04:37:16–04:37:17Z. Ledger **86 → 87**, latest `20260924193915`, the only new row.
> - **Then both generation functions,** from the merge commit:
>   - `analyze-paper` **v32 → v33** at 04:38:04Z, `ezbr_sha256` `7562f5a8bb954368e2a0cddb28a446faed879f72e7e461193048bdbfed107271`;
>   - `suggest-paper-organization` **v15 → v16** at 04:38:11Z, `ezbr_sha256` `fa7f5ebcdaa71946d6eed733d769d8bbb9913b3c51f3f53af52350e521997127`.
>
>   By these timestamps the old v32/v15 bundles ran against the new grant for under a minute. `fetch-paper-metadata` v22, `get-gemini-provider-quota` v9, `delete-account` v6 and `search-pubmed` v6 were not redeployed.
> - **Verified read-only on 2026-09-25** (inside `SET TRANSACTION READ ONLY`):
>   - `refund_ai_quota(uuid)`: one overload, owner `postgres`, SECURITY DEFINER, `search_path=public`, body digest `4224750ddbff3651e7e0aaa2576f4de4`, ACL `{postgres=X/postgres,service_role=X/postgres}`;
>   - EXECUTE: `service_role` **true**; `authenticated`, `anon` and PUBLIC **false**;
>   - the set of `public` SECURITY DEFINER functions `service_role` can execute is exactly `{refund_ai_quota(uuid)}`;
>   - `consume_ai_quota` (`8b3f8c3b380703c1ae8286db9745ad0d`) and `get_ai_quota_status` (`212b9a3ed220e347e8d8ca486b6d83a1`) are unchanged and still granted to owner + `authenticated`.
>
>   The independent Production verification read back the deployed `analyze-paper` v33 and `suggest-paper-organization` v16 bundles: both contain the reviewed server-only refund path.
> - **No canary.** No AI-provider request and no quota consume or refund was made to prove the rollout. The security closure rests on the live ACL and body plus the deployed bundles; a canary would have spent or refunded a real unit.
> - **Pre-rollout state, historical.** Read-only verification on 2026-09-24 found 86 ledger rows (latest `20260919075655`), `refund_ai_quota` executable by its owner and `authenticated` only (`{postgres=X/postgres,authenticated=X/postgres}`, body digest `36d1bdb04fc5d163a04cc32afce0ee66`), and `analyze-paper` v32 / `suggest-paper-organization` v15 byte-identical to `main` `f06107b6`, both refunding through the **caller-scoped** client. The 2026-09-25 preflight, before the migration, found the same ledger, ACL, digest and bundle hashes.

**Why it exists.** Before C47 a signed-in browser could `POST /rest/v1/rpc/refund_ai_quota` with its own id: the function checked only `p_user_id = auth.uid()` and then decremented the counter, with nothing tying a refund to a consumption. Consume, refund, consume again — without limit, on the one `ai_analysis` counter both AI operations share. See decision C47.

**What changes, together.**
- **Database:** one explicitly transactional migration replaces the body (the `auth.uid()` comparison is removed; every bucket rule is preserved; a NULL target is refused) and the ACL (`authenticated` revoked **before** the body changes, `service_role` granted **after**) in the same transaction, behind fail-closed preconditions that pin the reviewed body by digest. Final EXECUTE: owner + `service_role`; `authenticated`, `anon` and PUBLIC none. `service_role` then executes exactly this one SECURITY DEFINER function in `public`. `consume_ai_quota`, `get_ai_quota_status`, quotas, plans, entitlements and counters do not change.
- **Edge:** `analyze-paper` and `suggest-paper-organization` refund through the server-only refund client (§3.3). **Both** had to be redeployed (v33 and v16). `_shared/aiQuotaRefund.ts` joins the deployment closure of both; `_shared/edgeSecretKey.ts` was already in it.
- **Generated types:** unchanged — same signature (verified by generating types before and after on a local replay: byte-identical).

**Ordered rollout — EXECUTED 2026-09-25 (each step was separately authorized).** Kept as the reference procedure; the commands and checks below are what a re-verification uses.
1. ~~Merge the independently approved exact head with a regular two-parent merge commit; wait for merged-`main` CI.~~ **DONE** — `dca8a0be`; merged-`main` CI green.
2. ~~Read-only preflight inside `SET TRANSACTION READ ONLY`: the ledger is still 86 rows with `20260924193915` absent, and `refund_ai_quota` still has the pre-state above. If anything differs, stop — the migration would refuse it anyway, and the difference needs explaining first.~~ **DONE** — every pre-state value matched.
3. ~~`supabase db push --linked` from the merge commit — it must apply exactly `20260924193915` (87 rows).~~ **DONE** — ledger 86 → 87.
4. ~~Verify **immediately**, read-only:~~ **DONE** — every expectation below held. The query:
   ```sql
   BEGIN; SET TRANSACTION READ ONLY;
   SELECT current_setting('transaction_read_only') AS ro,
          p.proacl::text,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,   -- expect false
          has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon,            -- expect false
          EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   WHERE a.grantee = 0) AS public_exec,                                 -- expect false
          has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_role,    -- expect true
          md5(p.prosrc) AS body                                                         -- expect 4224750ddbff3651e7e0aaa2576f4de4
     FROM pg_proc p WHERE p.oid = 'public.refund_ai_quota(uuid)'::regprocedure;
   ROLLBACK;
   ```
   Expected ACL: `{postgres=X/postgres,service_role=X/postgres}`.
5. ~~Deploy **both** `analyze-paper` and `suggest-paper-organization` from a worktree whose function closure is byte-identical to the merge commit (§7).~~ **DONE** — v33 and v16 (hashes in the status above).
6. ~~Verify the deployed sources through the §7 read-back: both import `_shared/aiQuotaRefund.ts`; neither calls `refund_ai_quota` on its caller-scoped client.~~ **DONE.**
7. ~~Confirm normal CI and Vercel status. No frontend or Vercel action is part of this change.~~ **DONE** — no manual Vercel action was taken.

**Why the migration went first, and what the gap cost.** Migration-first closes the browser path the moment it commits. Until step 5 finished, the previously deployed functions (v32/v15, historical) would still try to refund through the caller's JWT and be refused (`42501`); refund is best-effort, so such an attempt logs `refund_failed rpc_error=1`, the **original** provider failure still reaches the user, and successful operations are unaffected. The only possible cost was that a unit consumed by an attempt failing inside that window would not be given back, which is why the gap had to be short; it was under a minute (status above). Deploying the Edge Functions first would not have avoided a gap (their `service_role` refund is refused until the grant exists) and would have left the exploit open for longer. **Never bridge such a gap with an authenticated fallback**: that fallback is the defect.

**After the deploy.** A refund failure is visible only in the Edge log. `refund_failed no_server_key=1` means the platform-injected key is missing (the same condition the telemetry writer reports as `reason=no_server_key`); `refund_failed rpc_error=1` from v33/v16 or later means the grant or the deployed code is not what this section expects — re-run step 4 and step 6.

**Rollback — a SECURITY rollback, reference only.** Prefer fixing forward. Restoring the previous state **deliberately re-opens the self-refund defect**, and it needs both halves or refunds stop working:
1. a new forward migration, in one explicit transaction: `REVOKE ALL ON FUNCTION public.refund_ai_quota(uuid) FROM PUBLIC, anon, authenticated, service_role;`, then the `CREATE OR REPLACE FUNCTION public.refund_ai_quota` text from `20260725090000` §4 **verbatim** (its body digest is `36d1bdb04fc5d163a04cc32afce0ee66`), then `GRANT EXECUTE ON FUNCTION public.refund_ai_quota(uuid) TO authenticated;`;
2. redeploying both generation functions from `main` `f06107b6` (or any commit whose refund path is caller-scoped), because the C47 functions refund as `service_role`, which the restored ACL refuses.

Neither step has been applied. Do not treat the rollback as a routine revert: it hands every signed-in browser back the ability to reset its own AI quota.

### 6.9 `20260925134526` (junction DML grant hardening, C48) — migration-only; COMPLETE: applied 2026-09-25

> **Status — COMPLETE. The migration-only rollout finished on 2026-09-25 and C48 is live in Production. Do not re-run the migration as a pending step.**
>
> - **Merged.** PR #301 as the two-parent commit `043efee0b9477537cf125fffc32434a89d0c5bb5` (parents `69f51a66` and the approved head `285ea61b`).
> - **Hosted CI.** Merged-`main` on `043efee`: Validate, DB Tests and Extension passed. `E2E (local)` does not run on a push to `main` (it runs on eligible pull requests, on demand and on a daily schedule — [README](../README.md#ci)); its evidence for this change is the pull-request run on the exact approved head `285ea61b0fe810c46c71d5248792b65a2b17f343`, run `36193186293`, which passed.
> - **Migration only.** `20260925134526_harden_junction_dml_grants.sql` was applied under its own repository version. Ledger **87 → 88**, latest `20260925134526`, present exactly once. It was the only intentional Production mutation of the C48 rollout: no Edge Function was deployed (versions unchanged), no secret, Auth or Storage state changed, and no AI or application-data canary was run.
> - **Automatic Vercel deployment, no manual action.** The PR #301 merge triggered the repository's normal automatic Vercel Production deployment for `043efee` (`dpl_FYqqhWU5TBJqbZHGypApzhcrMPrk`, READY). It carried no C48 application-behavior change — C48 changed database grants, tests and docs, not shipped frontend behavior — and no manual Vercel deploy, promotion, redeploy or configuration change occurred or was needed.
> - **Verified read-only after the apply:**
>   - `paper_projects` / `paper_tags`: `authenticated` holds `SELECT` **only** — `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` and `MAINTAIN` are all false. Normalized direct ACL: `postgres=arwdDxtm`, `service_role=arwdDxtm`, `authenticated=r`. RLS and FORCE RLS still on.
>   - `projects` / `tags`: **unchanged** — `authenticated` `SELECT`, `INSERT`, `UPDATE` and `DELETE` all true; ACL `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,authenticated=arwd/postgres}`. Creating a Project or Tag, by hand or through AI "Create & select", is still a direct browser INSERT.
>   - The six junction policies (SELECT / INSERT / DELETE on each junction, both-owner) are unchanged, digest `04b973b09f1aadcd8a5389b8899818b7`; they remain as dormant defense-in-depth.
>   - All seven assignment/merge RPCs are unchanged: owner `postgres`, SECURITY DEFINER, `search_path=public`, the body digests listed in step 5 below; EXECUTE true for `postgres` and `authenticated`, false for `anon`, `service_role` and PUBLIC.
>   - `service_role`'s junction privileges are unchanged.
> - **No canary.** No AI suggestion was run, no Project or Tag was created and no paper assignment was made to prove the rollout. It is established by the live ACL/catalog state and the tracked migration; the product paths under the hardened schema are proven by CI (pgTAP 000/002/015, the Vitest junction-boundary suites and the E2E lane).
> - **Pre-rollout state, historical.** Read-only verification on 2026-09-25, before the merge, found ledger **87** (latest `20260924193915`); `authenticated` holding `SELECT, INSERT, DELETE` on `paper_projects` and `paper_tags` (`authenticated=ard/postgres`) and `SELECT, INSERT, UPDATE, DELETE` on `projects` and `tags` (`authenticated=arwd/postgres`).

**What changes.** One statement inside a fail-closed transaction: `REVOKE INSERT, DELETE ON TABLE public.paper_projects, public.paper_tags FROM authenticated;`. Nothing else: not `projects` / `tags` (Projects and Tags — including AI-proposed ones — are still created by direct browser INSERT), not `service_role`, not `anon` / PUBLIC, not RLS or any policy, not any function, not any row. See decision C48.

**Why there is no ordering constraint.** No shipped client path writes either junction directly: every assignment goes through `set_paper_*`, `bulk_set_paper_*`, `bulk_add_paper_*` or `merge_exact_duplicates`, all SECURITY DEFINER and owned by `postgres`, so they write as the owner and are unaffected by the caller's grant. FK cascades (deleting a Project, Tag or paper) also run as the junction's owner. So there is no web-first or Edge-first step, no drain and no barrier, and no frontend or Edge Function deploy is part of this rollout. **Generated types do not change** (a grant is not part of the schema shape PostgREST types describe).

**Reference procedure — kept for re-verification and as the pattern for a comparable migration-only change; not a pending step.** The completed record is the status box above; these steps describe the procedure and are not themselves a record of what was run.
1. Merge the independently approved exact head with a regular two-parent merge commit; wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. `E2E (local)` is not a merged-`main` check — its evidence is the pull-request run on the exact approved head.
2. Read-only preflight inside `SET TRANSACTION READ ONLY`: the ledger is at the expected pre-state with the migration absent, and the relations are in the pre-state the migration pins. The migration refuses any other pre-state anyway (its section 1) — a difference needs explaining before anyone retries.
3. `supabase migration list --linked`, then `supabase db push --dry-run` from the merge commit. The dry run must list **exactly** the one migration being rolled out; anything else, stop (§6.2).
4. `supabase db push --linked` (for C48 this took the ledger 87 → 88).
5. Verify immediately, read-only (this query also re-verifies the current state at any time):
   ```sql
   BEGIN; SET TRANSACTION READ ONLY;
   -- Junctions: SELECT only for authenticated, direct and effective.
   SELECT c.relname, c.relacl::text,
          has_table_privilege('authenticated', c.oid, 'SELECT') AS sel,   -- expect true
          has_table_privilege('authenticated', c.oid, 'INSERT') AS ins,   -- expect false
          has_table_privilege('authenticated', c.oid, 'UPDATE') AS upd,   -- expect false
          has_table_privilege('authenticated', c.oid, 'DELETE') AS del,   -- expect false
          c.relrowsecurity, c.relforcerowsecurity                          -- expect true, true
     FROM pg_class c
    WHERE c.oid IN ('public.paper_projects'::regclass, 'public.paper_tags'::regclass,
                    'public.projects'::regclass, 'public.tags'::regclass)
    ORDER BY c.relname;
   -- Assignment RPC authority unchanged.
   SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
          p.proconfig::text, md5(p.prosrc) AS body, p.proacl::text
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('set_paper_projects','set_paper_tags','bulk_set_paper_projects','bulk_set_paper_tags',
                        'bulk_add_paper_projects','bulk_add_paper_tags','merge_exact_duplicates')
    ORDER BY 1;
   ROLLBACK;
   ```
   Expected (the live state since 2026-09-25):
   - `paper_projects` / `paper_tags`: `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,authenticated=r/postgres}`; `sel` true, `ins` / `upd` / `del` false; RLS and FORCE RLS true.
   - `projects` / `tags`: **unchanged** — `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,authenticated=arwd/postgres}`; `sel`, `ins`, `upd`, `del` all true.
   - All seven routines: owner `postgres`, SECURITY DEFINER, `{search_path=public}` *(superseded since the 2026-09-26 C50 rollout: all seven are now `{"search_path=public, pg_temp"}` — §6.11; everything else on this line is unchanged)*, ACL `{postgres=X/postgres,authenticated=X/postgres}`, and bodies `set_paper_projects` `8104be4a8a25bfbca45b0aab4393d110`, `set_paper_tags` `8b0537b3964e5a1956a8d1e99bdaed82`, `bulk_set_paper_projects` `a348cebfcf3b393af9aff1b5a77cd1a6`, `bulk_set_paper_tags` `e3b6bcfec228d4cca4f52dc126765e32`, `bulk_add_paper_projects` `1d1c91251a099af644cb9d416637e1cc`, `bulk_add_paper_tags` `01da7404df6f887252f724c649d11fba`, `merge_exact_duplicates` `b43400b3cdc51b5572efe81a80acdfab`.
6. Confirm the security advisor shows nothing new (read-only). The six assignment RPCs' "authenticated can execute a SECURITY DEFINER function" notices are expected — after this change they are the deliberate client-facing write authority.

**No canary was run, and none was required.** The migration's own verification block refuses to commit anything but the expected state, and the product paths are covered by CI against the hardened schema (pgTAP 000/002/015 and the E2E lane replay every migration). If an authenticated product smoke is ever separately authorized, the smallest one is: open Edit Paper on a disposable paper, use AI "Create & select" or the Projects selector, save, reopen — the assignment must persist.

**Rollback — reference only; none has been performed, and this section authorizes none.** Prefer fixing forward: if a real product path turns out to need a direct junction write, the fix is a reviewed RPC for that path. Restoring the pre-C48 grant (`GRANT INSERT, DELETE ON TABLE public.paper_projects, public.paper_tags TO authenticated;`, in a new forward migration) would be a **least-privilege regression**: it re-opens a direct browser write path that bypasses the RPCs' contracts. The rows would still be constrained by the dormant both-owner RLS policies that stay in place today, so it would not re-open the pre-`20260802025704` cross-owner defect — but it undoes C48 and needs its own decision.

### 6.10 `20260926152414` (read RPCs become SECURITY INVOKER, C49) — migration-only; COMPLETE: applied 2026-09-26

> **Status — COMPLETE. The migration-only rollout finished on 2026-09-26 and C49 is live in Production. Do not re-run the migration as a pending step.**
>
> - **Merged.** PR #303 as the two-parent commit `77b7a4ba0470eb3645d53217e6155cd17c65c15b` (parents `a4ca8238` and the approved head `a68fdaad`).
> - **Hosted CI.** Merged-`main` on `77b7a4b`: Validate (run `36256010365`), DB Tests (`36256010458`) and Extension (`36256010359`) passed. `E2E (local)` does not run on a push to `main` ([README](../README.md#ci)); its evidence for this change is the pull-request run on the exact approved head `a68fdaad9ba993cb01b145f9977e0fdacc98f866`, run `36254210375`, which passed.
> - **What was run — migration only, exactly as planned.** The linked migration comparison showed exactly one pending migration, `20260926152414`. `supabase db push --dry-run` listed exactly `20260926152414_harden_read_rpcs_security_invoker.sql`, and the normal linked `supabase db push` applied exactly that file under its own repository version; the five `ALTER FUNCTION … SECURITY INVOKER` statements are in the Production Postgres log at 17:21:31–17:21:32Z. Ledger **88 → 89**, latest `20260926152414`, present exactly once (name `harden_read_rpcs_security_invoker`). It was the only intentional Production mutation of the C49 rollout. No Edge Function was deployed (versions unchanged), no Auth, Storage, secret, AI/provider or quota state changed, no application row was written, and no canary was run.
> - **No manual Vercel action.** None was part of the database rollout, and none was needed: C49 changed a database security mode, tests and docs, not shipped frontend behavior. This record makes no claim about the `app.paperlume.app` alias or any Vercel deployment; they were outside the rollout's verification scope.
> - **Verified read-only after the apply** (and re-verified independently, read-only, on 2026-09-26 for the documentation reconciliation):
>   - All five: `prosecdef` **false** (SECURITY INVOKER); owner `postgres`; `{search_path=public}`; stored ACL `{postgres=X/postgres,authenticated=X/postgres}`; EXECUTE true for `authenticated`, false for `anon`, `service_role` and PUBLIC; bodies unchanged — the digests in step 5 below.
>   - `public` SECURITY DEFINER functions **40 → 35**; `authenticated`-callable SECURITY DEFINER functions **32 → 27**.
>   - Security Advisor `authenticated_security_definer_function_executable` **32 → 27**. The five are exactly the ones that left the finding, and none of them is listed.
>   - `papers` / `synonym_pool` unchanged: owner `postgres`, RLS and FORCE RLS on, `authenticated` exactly `INSERT, SELECT, UPDATE` / `DELETE, INSERT, SELECT, UPDATE`. The eight ownership policies are unchanged — all PERMISSIVE, none RESTRICTIVE, `auth.uid() = user_id` — digest `07603cbe4e78a4d6097e7ec33bd1e6c8`.
> - **Pre-rollout state, historical.** Read-only verification on 2026-09-26, before the merge, found ledger **88** (latest `20260925134526`), all five SECURITY DEFINER, 40 `public` SECURITY DEFINER functions (32 `authenticated`-callable) and **32** `authenticated_security_definer_function_executable` warnings.

**What changes.** Five statements inside a fail-closed transaction, one attribute each — `prosecdef` true → false:

```sql
ALTER FUNCTION public.search_papers(uuid,text,integer,integer)                SECURITY INVOKER;
ALTER FUNCTION public.search_papers_short(uuid,text)                          SECURITY INVOKER;
ALTER FUNCTION public.filter_papers_by_keywords(uuid,text[])                  SECURITY INVOKER;
ALTER FUNCTION public.get_keyword_options(uuid,uuid[],integer,integer,text[]) SECURITY INVOKER;
ALTER FUNCTION public.get_duplicate_papers()                                  SECURITY INVOKER;
```

Nothing else: not a body, signature, return type, argument default, volatility, parallel mode, owner, `search_path` or EXECUTE ACL; not a table grant, RLS flag or policy; not another function; not a row. `authenticated` keeps EXECUTE on all five. See decision C49.

**Why there is no ordering constraint.** The shipped web app and extension call these five with the caller's own id, and for that call both security modes return the same rows: the body's own `user_id` predicate and the caller-owned RLS SELECT policy select the same set. Every other call is still refused by the unchanged guard before the first read. No Edge Function calls them. So there was no web-first or Edge-first step, no drain and no barrier, and **no Edge Function deployment was part of this rollout. No manual frontend or Vercel deployment step was required either.** A merge to `main` is the Vercel Git integration's ordinary automatic Production trigger, as for every merge, and C49 carries no application-behavior change for it to ship. **Generated types do not change** (security mode is not part of the function signature PostgREST types describe; verified byte-identical locally).

**Reference procedure — the plan as written before the rollout, kept for re-verification and as the pattern for a comparable migration-only change; not a pending step.** The completed record is the status box above; these steps describe the procedure and are not themselves a record of what was run.
1. Merge the independently approved exact head with a regular two-parent merge commit; wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. `E2E (local)` is not a merged-`main` check — its evidence is the pull-request run on the exact approved head.
2. Read-only preflight inside `SET TRANSACTION READ ONLY`: ledger **88**, latest `20260925134526`, migration absent; the five functions still SECURITY DEFINER with the body digests below; the policy digest below. The migration refuses any other pre-state anyway (its section 1) — a difference needs explaining before anyone retries.
3. `supabase migration list --linked`, then `supabase db push --dry-run` from the merge commit. The dry run must list **exactly** `20260926152414_harden_read_rpcs_security_invoker.sql`; anything else, stop (§6.2).
4. Apply exactly that migration: `supabase db push --linked` (for C49 this took the ledger **88 → 89**).
5. Verify immediately, read-only (this query also re-verifies the state at any time):
   ```sql
   BEGIN; SET TRANSACTION READ ONLY;
   SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
          p.proconfig::text, md5(p.prosrc) AS body, p.proacl::text,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,   -- expect true
          has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_x,   -- expect false
          has_function_privilege('service_role',  p.oid, 'EXECUTE') AS svc_x     -- expect false
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('search_papers','search_papers_short','filter_papers_by_keywords',
                        'get_keyword_options','get_duplicate_papers')
    ORDER BY 1;
   SELECT count(*) FILTER (WHERE p.prosecdef) AS public_definer,                         -- expect 35
          count(*) FILTER (WHERE p.prosecdef
                             AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_definer  -- expect 27
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
   ROLLBACK;
   ```
   Expected (the live state since 2026-09-26):
   - All five: `prosecdef` **false**; owner `postgres`; `{search_path=public}`; ACL `{postgres=X/postgres,authenticated=X/postgres}`; `auth_x` true, `anon_x` and `svc_x` false; bodies **unchanged** — `search_papers` `d4a5f3afdc485d5dfda8e0798c61cc48` *(its body at the C49 rollout. Since C58 was applied on 2026-09-30 (§6.19), the live body is `1a72d57a585779644c00636f0da3b253`, and re-running this query now returns that; its other attributes above are unchanged)*, `search_papers_short` `ce353564edcb73a5466092e84d0b8d1b`, `filter_papers_by_keywords` `b2f5a8e58589a5a094a7074c5ed9bb2d`, `get_keyword_options` `531010c10d84ee94c7c1e00d65a2e7f5`, `get_duplicate_papers` `3c914811a9b8c75b9df834e1cf51e1e0`.
   - `public_definer` **40 → 35**, `auth_definer` **32 → 27**.
   - `papers` / `synonym_pool` ACLs, RLS, FORCE RLS and all eight policies unchanged (policy digest `07603cbe4e78a4d6097e7ec33bd1e6c8`, the formula in the migration's §1d).
6. Re-read the Security Advisor (read-only): `authenticated_security_definer_function_executable` **32 → 27**, with none of the five listed. The remaining 27 are expected at this phase — the 24 functions the audit found intentionally privileged, plus `bulk_update_keywords`, `bulk_update_study_types` and `safe_bulk_insert_papers`, which are later INVOKER groups. *(All three since converted on 2026-09-27: the two `bulk_update_*` functions by C52 (§6.13) and `safe_bulk_insert_papers` by C53 (§6.14), which took the count to 24.)*

**No canary was run, and none was required.** The migration's own verification block refuses to commit anything but the expected catalog state, and the behaviour under INVOKER is covered by CI against a full replay (pgTAP 000/003/015/020, the search/filter E2E specs). If an authenticated product smoke is ever separately authorized, the smallest one is: search the library (3+ characters, and 1–2 characters), apply a keyword filter, open the keyword dropdown and open Find Duplicates — results must match the pre-rollout ones.

**Rollback — reference only; none has been performed, and this section authorizes none.** Prefer fixing forward. The reviewed restoration is a new forward migration containing exactly the five `ALTER FUNCTION … SECURITY DEFINER;` statements, which returns them to the pre-change shape (bodies, ACL and configuration were never touched). It re-adds owner authority and re-makes each body's guard the only database boundary for these five; it does not remove any boundary. It needs its own decision against C49.

---

### 6.11 `20260926202754` (SECURITY DEFINER `pg_temp`-last hardening, C50) — migration-only; COMPLETE: applied 2026-09-26

> **Status — COMPLETE. The migration-only rollout finished on 2026-09-26 and C50 is live in Production. Do not re-run the migration as a pending step.**
>
> - **Merged.** PR #305 as the two-parent commit `b765145e1970c8378f528acac85ad3eb9782c346` (parents `fb6f2778` and the approved head `dfc9d368`; tree `71864d6d`, identical to the approved head's).
> - **Hosted CI.** Merged-`main` on `b765145`: Validate (run `36272601913`), DB Tests (`36272601840`) and Extension (`36272600988`) passed. `E2E (local)` does not run on a push to `main` ([README](../README.md#ci)); its evidence for this change is the pull-request run on the exact approved head `dfc9d368de544c696fc78484db8b2d74521c7ff3`, run `36271097526`, which passed.
> - **Before — fresh read-only preflight, immediately before the apply** (step 3): PostgreSQL 17.6; ledger **89**, latest `20260926152414`, C50 absent; **35** `public` SECURITY DEFINER functions, **27** of them `authenticated`-callable, all owned by `postgres`; `anon` and PUBLIC execute none of them, and `service_role` only `refund_ai_quota(uuid)`; **35** at `{search_path=public}` and **0** at `public, pg_temp`; the three exception bodies matched their audited digests; advisor `authenticated_security_definer_function_executable` **27**; `surface_with_oids` recomputed as `1e6cfb8bb03375d61583426b1f0ae4bc`. The migration's own §0/§1 precondition blocks were also run verbatim inside a read-only, rolled-back transaction, and passed.
> - **What was run — migration only, exactly as planned.** `supabase migration list --linked` showed exactly one local-only migration, `20260926202754`, and no remote-only one. `supabase db push --linked --dry-run` listed exactly `20260926202754_harden_security_definer_pg_temp_last.sql`, with no seeds and no roles. The normal linked `supabase db push --linked --yes` then applied exactly that file under its own repository version. Ledger **89 → 90**, latest `20260926202754`, present exactly once (name `harden_security_definer_pg_temp_last`). It was the only intentional Production mutation of the C50 rollout. No Edge Function was deployed (all six versions and bundle hashes were unchanged). The rollout changed no Auth, Storage, secret, AI/provider or quota state, wrote no application row and ran no canary.
> - **No manual Vercel action.** None was part of the database rollout, and none was needed: C50 changed function configuration, tests and docs, not shipped frontend behavior. This record makes no claim about any Vercel deployment; that was outside the rollout's verification scope.
> - **After — verified read-only immediately after the apply** (and re-verified independently, read-only, on 2026-09-26 for the documentation reconciliation):
>   - **35** `public` SECURITY DEFINER functions, **27** `authenticated`-callable; `anon` and PUBLIC execute none; `service_role` only `refund_ai_quota(uuid)`, whose ACL is still `{postgres=X/postgres,service_role=X/postgres}`.
>   - **32** at exactly `{"search_path=public, pg_temp"}`. They are exactly the 32 listed below, and each moved only from `{search_path=public}`.
>   - **3** at `{search_path=public}`, exactly `clear_author_identity_links_on_authors_change()`, `refund_storage_quota()` and `reject_attachment_over_cleanup_intent()`. Their whole `pg_proc` rows are byte-identical to the preflight: OIDs `108859`, `66812`, `109308`; bodies `a14c92db…`, `3e20f43b…`, `494f7297…`; owner-only ACL `{postgres=X/postgres}`.
>   - `surface_with_oids` is **`1e6cfb8bb03375d61583426b1f0ae4bc`, identical** to the preflight value, so no OID, signature, body, ACL, security mode or owner changed.
>   - The five trigger bindings and the `attachments_owner_delete` Storage-policy binding are unchanged, with the same trigger, policy and function OIDs.
>   - Security Advisor `authenticated_security_definer_function_executable` is still **27**, listing the same functions, and no new finding appeared. The C30 leaked-password warning and the six `rls_enabled_no_policy` notices predate C50 and are unrelated to it.

**What changes.** 32 exact-signature statements inside a fail-closed transaction, one attribute each — `proconfig` `{search_path=public}` → `{"search_path=public, pg_temp"}`:

```sql
-- Tier 1
ALTER FUNCTION public.bulk_add_paper_projects(uuid[],uuid[])                     SET search_path = public, pg_temp;
ALTER FUNCTION public.bulk_add_paper_tags(uuid[],uuid[])                         SET search_path = public, pg_temp;
ALTER FUNCTION public.bulk_set_paper_projects(uuid[],uuid[])                     SET search_path = public, pg_temp;
ALTER FUNCTION public.bulk_set_paper_tags(uuid[],uuid[])                         SET search_path = public, pg_temp;
ALTER FUNCTION public.bulk_update_keywords(jsonb)                                SET search_path = public, pg_temp;
ALTER FUNCTION public.bulk_update_study_types(jsonb)                             SET search_path = public, pg_temp;
ALTER FUNCTION public.merge_exact_duplicates(uuid,uuid[])                        SET search_path = public, pg_temp;
ALTER FUNCTION public.safe_bulk_insert_papers(uuid,jsonb)                        SET search_path = public, pg_temp;
ALTER FUNCTION public.set_paper_projects(uuid,uuid[])                            SET search_path = public, pg_temp;
ALTER FUNCTION public.set_paper_tags(uuid,uuid[])                                SET search_path = public, pg_temp;
-- Tier 2
ALTER FUNCTION public.attachment_object_has_live_metadata(text)                  SET search_path = public, pg_temp;
ALTER FUNCTION public.author_identity_effective_root(uuid,uuid)                  SET search_path = public, pg_temp;
ALTER FUNCTION public.check_and_consume_storage_quota()                          SET search_path = public, pg_temp;
ALTER FUNCTION public.clear_current_user_ai_model()                              SET search_path = public, pg_temp;
ALTER FUNCTION public.clear_current_user_ai_reasoning()                          SET search_path = public, pg_temp;
ALTER FUNCTION public.consume_ai_quota(uuid)                                     SET search_path = public, pg_temp;
ALTER FUNCTION public.create_author_identity_from_mention(uuid,integer,text,text,boolean) SET search_path = public, pg_temp;
ALTER FUNCTION public.delete_attachment_with_cleanup(uuid)                       SET search_path = public, pg_temp;
ALTER FUNCTION public.delete_empty_author_identity(uuid)                         SET search_path = public, pg_temp;
ALTER FUNCTION public.delete_papers_with_attachment_cleanup(uuid[])              SET search_path = public, pg_temp;
ALTER FUNCTION public.finalize_attachment_upload(uuid,text,text,text,integer)    SET search_path = public, pg_temp;
ALTER FUNCTION public.get_ai_quota_status(uuid)                                  SET search_path = public, pg_temp;
ALTER FUNCTION public.get_current_user_access()                                  SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_user()                                          SET search_path = public, pg_temp;
ALTER FUNCTION public.link_author_mention_to_identity(uuid,integer,text,uuid,text,boolean) SET search_path = public, pg_temp;
ALTER FUNCTION public.merge_author_identities(uuid,uuid)                         SET search_path = public, pg_temp;
ALTER FUNCTION public.refund_ai_quota(uuid)                                      SET search_path = public, pg_temp;
ALTER FUNCTION public.set_current_user_ai_model(text)                            SET search_path = public, pg_temp;
ALTER FUNCTION public.set_current_user_ai_reasoning(text)                        SET search_path = public, pg_temp;
ALTER FUNCTION public.unlink_author_mention_identity(uuid,integer)               SET search_path = public, pg_temp;
ALTER FUNCTION public.unmerge_author_identity(uuid)                              SET search_path = public, pg_temp;
ALTER FUNCTION public.validate_author_mention_for_identity(uuid,uuid,integer,text) SET search_path = public, pg_temp;
```

**No statement touches the three audited exceptions**, which stay at `search_path=public` for their audited bodies only: `clear_author_identity_links_on_authors_change()` (`a14c92dbd8485afff4d1600684b37565`), `refund_storage_quota()` (`3e20f43b80a908b309cb6335d8eb9360`) and `reject_attachment_over_cleanup_intent()` (`494f7297c23991bc8d28d4f81906e059`). The migration also changes no body, owner, security mode, grant, trigger, policy, relation or row, and its §3 proves each of those before COMMIT.

**Why there is no ordering constraint.** With no temporary shadow object present — the only situation a legitimate caller creates — `public, pg_temp` and `public` resolve every name identically, so no call returns anything different. A call already executing when the migration commits finishes under the configuration it started with. So there was no web-first or Edge-first step, no drain and no barrier. **No Edge Function deployment and no manual frontend or Vercel step were part of this rollout.** Generated types do not change, because `proconfig` is not part of any signature.

**Procedure — EXECUTED 2026-09-26; kept as the reference procedure and as the pattern for a comparable migration-only change; not a pending step.** These are the steps as written before the rollout. The `expect` values in step 3 are the **pre-rollout** state it was checked against. What was actually observed and run is the status box above, restated per step below.
1. Independently approve the exact PR head. Merge it with a normal two-parent merge commit.
2. Wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. `E2E (local)` is not a merged-`main` check; its evidence is the pull-request run on the exact approved head.
3. Fresh read-only preflight against Production (pre-rollout expectations; after the rollout this query returns ledger 90, latest `20260926202754`, `c50_present` 1, `at_public` 3 and `at_pg_temp_last` 32):
   ```sql
   BEGIN; SET TRANSACTION READ ONLY; SET LOCAL search_path TO public;
   SELECT count(*) AS ledger, max(version) AS latest                               -- expect 89, 20260926152414
     FROM supabase_migrations.schema_migrations;
   SELECT count(*) FILTER (WHERE version = '20260926202754') AS c50_present        -- expect 0
     FROM supabase_migrations.schema_migrations;
   SELECT count(*) FILTER (WHERE p.prosecdef) AS public_definer,                   -- expect 35
          count(*) FILTER (WHERE p.prosecdef
                             AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_definer,  -- expect 27
          count(*) FILTER (WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=public']) AS at_public,       -- expect 35
          count(*) FILTER (WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']) AS at_pg_temp_last  -- expect 0
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
   SELECT p.oid::regprocedure, md5(p.prosrc) AS body                               -- expect the three audited digests
     FROM pg_proc p
    WHERE p.oid IN ('public.clear_author_identity_links_on_authors_change()'::regprocedure,
                    'public.refund_storage_quota()'::regprocedure,
                    'public.reject_attachment_over_cleanup_intent()'::regprocedure);
   -- Record this value; step 7 must return the same one.
   SELECT md5(string_agg(p.oid::text || '|' || p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|'
                         || coalesce(p.proacl::text, '') || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner),
                         E'\n' ORDER BY p.oid)) AS surface_with_oids
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef;
   ROLLBACK;
   ```
   At the audit on 2026-09-26 `surface_with_oids` read `1e6cfb8bb03375d61583426b1f0ae4bc`. The rule was to re-read it at preflight rather than trust that value, and the fresh preflight immediately before the apply returned the same value. Every other step-3 value matched too. Any other pre-state would have been a reason to stop, and the migration refuses it anyway (its §1). In particular, **if an exception digest differs, stop and re-audit that function**; do not edit the migration to fit.
4. `supabase migration list --linked` must show exactly one local-only migration, `20260926202754`. Then run `supabase db push --dry-run` from the merge commit; it must list **exactly** `20260926202754_harden_security_definer_pg_temp_last.sql`. Anything else, stop (§6.2). *Observed:* exactly that one local-only migration, and a dry run that listed exactly that file and nothing else.
5. Obtain the separate, explicit rollout authorization. *Obtained before the apply.*
6. Apply exactly that migration through the normal linked workflow: `supabase db push --linked` (ledger **89 → 90**). *Executed as `supabase db push --linked --yes`; it applied exactly that one file, and the ledger went **89 → 90**.*
7. Verify immediately, read-only (the expected values below are the live state since 2026-09-26, and were observed exactly):
   - the ledger is **90**, latest `20260926202754`, present exactly once;
   - rerunning the step-3 counts gives `public_definer` **35**, `auth_definer` **27**, `at_public` **3**, `at_pg_temp_last` **32**, and the three rows at `at_public` are exactly the three exceptions, with their audited digests;
   - `surface_with_oids` is **identical** to the value recorded at step 3. That shows the OIDs, bodies, ACLs, security modes and owners of all 35 are unchanged.
   ```sql
   BEGIN; SET TRANSACTION READ ONLY; SET LOCAL search_path TO public;
   SELECT p.oid::regprocedure, p.proconfig::text
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
      AND p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'];      -- expect exactly the 3 exceptions, at {search_path=public}
   ROLLBACK;
   ```
8. Re-read the Security Advisor (read-only). `authenticated_security_definer_function_executable` is expected to stay at **27**, the same functions as before, because neither the security mode nor any grant changes. `function_search_path_mutable` is expected to be unchanged. *Observed:* **27**, the same functions, before and after; no `function_search_path_mutable` finding either time, and no new finding.

**No canary was run, and none was required.** No temp-shadow probe was repeated in Production, and no disposable row was written. The migration's own verification refuses to commit anything but the expected catalog state, and the behaviour is covered in CI against a full replay: suite `021` (including the temp-shadow behavioural test and its old-posture negative control), plus the existing suites that exercise these functions. If an authenticated product smoke is ever separately authorized, the smallest one is to tag a paper, add it to a project and open Settings → AI; each must behave exactly as before.

**Rollback — reference only; none has been performed, and this section authorizes none.** Prefer fixing forward. The reviewed restoration is a new forward migration with the same 32 statements set to `SET search_path = public`, which returns them to the pre-change shape (bodies, ACLs and modes were never touched). It removes a defense-in-depth layer; it opens no boundary. It needs its own decision against C50.

### 6.12 `20260927001229` (`pg_catalog`-helper `pg_temp`-last hardening, C51) — migration-only; COMPLETE: applied 2026-09-27

> **Status — COMPLETE. The migration-only rollout finished on 2026-09-27 and C51 is live in Production. Do not re-run the migration as a pending step.**
>
> - **Merged.** PR #307 as the two-parent commit `bc8278b38a6d82a15c82e5ccd478347eb00a7811` (parents `35de3020` and the approved head `2bdc6e0c`; tree `efc740f3`, identical to the approved head's).
> - **Hosted CI.** Merged-`main` on `bc8278b`: Validate (run `36296417102`), DB Tests (`36296417141`) and Extension (`36296417122`) passed. `E2E (local)` does not run on a push to `main` ([README](../README.md#ci)); its evidence for this change is the pull-request run on the exact approved head `2bdc6e0c92b4efe14a2a16e7b03f090b8995ce8a`, run `36292037273`, which passed.
> - **Before — pre-state, verified read-only at preparation on 2026-09-27 and again in the fresh preflight immediately before the apply** (step 3):
>   - PostgreSQL 17.6; ledger **90**, latest `20260926202754` (C50), C51 absent.
>   - Exactly five `public` functions at `{search_path=pg_catalog}`, all SECURITY INVOKER and owned by `postgres`: `attachment_cleanup_path_is_safe` (OID `109298`, body `2c2f2ff5…`), the text / text[] / jsonb wrappers (`66407` / `66408` / `66409`, bodies `26edc211…` / `19261084…` / `30c015cd…`) and `set_updated_at` (`33584`, body `301a8849…`).
>   - The attachment helper's ACL was `{postgres=X/postgres}`, and the other four were at the hosted explicit default form.
>   - The three attachment callers were at `{"search_path=public, pg_temp"}` with digests `23833e1f…` / `91bf1072…` / `4bdcc814…`.
>   - `papers.search_vector` was at the hosted direct built-in expression `8ddd960b4f4b11dd7afd35485d01fd25` *(recorded at the time as "inlined" — the wrong mechanism; see C54)*, and `trg_papers_updated_at` (OID `33585`) was bound to `set_updated_at()`.
>   - `helpers_minus_config` recomputed as `f2c68ed1852d00f9e0a1369ea11a172e`.
>   - The migration's own §0/§1 precondition blocks were also run verbatim inside a read-only, rolled-back transaction, and passed.
> - **What was run — migration only, exactly as planned.**
>   - `supabase migration list --linked` showed local and remote aligned through `20260926202754`, exactly one local-only migration, `20260927001229`, and no remote-only one.
>   - `supabase db push --linked --dry-run` listed exactly `20260927001229_harden_pg_catalog_helper_pg_temp_last.sql`, with no seeds and no roles.
>   - The normal linked `supabase db push --linked --yes` (Supabase CLI 2.111.0) then applied exactly that file under its own repository version, between 05:23:28Z and 05:23:59Z UTC. It exited 0 and reported no seeds and no roles.
>   - Ledger **90 → 91**, latest `20260927001229`, present exactly once (name `harden_pg_catalog_helper_pg_temp_last`).
>   - It was the only intentional Production mutation of the C51 rollout. No Edge Function was deployed: all six versions read back afterwards were last updated on or before 2026-09-25. The rollout changed no Auth, Storage, secret, AI/provider or quota state, created no temporary object, wrote no application row and ran no canary.
> - **No manual Vercel action.** None was part of the database rollout, and none was needed: C51 changed function configuration, tests and docs, not shipped frontend behavior. This record makes no claim about any Vercel deployment; that was outside the rollout's verification scope.
> - **After — verified read-only immediately after the apply** (and re-verified independently, read-only, on 2026-09-27 for the documentation reconciliation):
>   - Exactly the four targets are at `{"search_path=pg_catalog, pg_temp"}`: `attachment_cleanup_path_is_safe` and the three `immutable_english_tsvector_*` wrappers, same OIDs, each moved only from `{search_path=pg_catalog}`.
>   - `set_updated_at()` is still at exactly `{search_path=pg_catalog}`, and its whole `pg_proc` row is byte-identical to the preflight. The `pg_catalog` distribution over `public` is 4 + 1.
>   - All five are still SECURITY INVOKER, owned by `postgres`, with the same body digests, literal ACLs and effective callers. Nobody but the owner can execute the attachment helper. The wrappers and `set_updated_at()` are executable by PUBLIC (hence `anon`, `authenticated` and `service_role`), as before. *(Correction, 2026-09-28, C56: "hence" overstates it. On hosted Production those three roles also held explicit grants of their own, from Supabase's `postgres`/`public` function default. The effective callers recorded here were correct.)*
>   - The three attachment callers' whole `pg_proc` rows are byte-identical: OIDs `109299` / `109300` / `109304`, SECURITY DEFINER, owner `postgres`, `{"search_path=public, pg_temp"}`, ACL `{postgres=X/postgres,authenticated=X/postgres}`, and bodies `23833e1f…` / `91bf1072…` / `4bdcc814…`.
>   - `helpers_minus_config` is **`f2c68ed1852d00f9e0a1369ea11a172e`, identical** to the preflight value.
>   - The `papers.search_vector` attribute, default and expression (`8ddd960b…`) are unchanged. `idx_papers_search_vector` (OID `61100`) is valid and ready, with the same definition and relfilenode. `trg_papers_updated_at` (OID `33585`, `tgfoid` `33584`, BEFORE UPDATE, `EXECUTE FUNCTION public.set_updated_at()`) is unchanged. Every `pg_depend` edge into the five is unchanged, and so is every other `public` function row.
>   - The Security Advisor shows no `function_search_path_mutable` finding and no finding naming any of the five helpers. `authenticated_security_definer_function_executable` is still **27**, as recorded after C50. The C30 leaked-password warning and the six `rls_enabled_no_policy` notices predate C51 and are unrelated to it.

**What changes.** Four exact-signature statements inside a fail-closed transaction, one attribute each — `proconfig` `{search_path=pg_catalog}` → `{"search_path=pg_catalog, pg_temp"}`:

```sql
ALTER FUNCTION public.attachment_cleanup_path_is_safe(uuid,text,uuid)  SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.immutable_english_tsvector_text(text)            SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.immutable_english_tsvector_textarr(text[])       SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.immutable_english_tsvector_jsonb(jsonb)          SET search_path = pg_catalog, pg_temp;
```

**No statement touches `public.set_updated_at()`**, which stays at exactly `{search_path=pg_catalog}`. The migration also changes no body, OID, owner, security mode, grant, caller, trigger, generated column, index, policy, relation or row, and its §3 proves each of those before COMMIT. It accepts only the two reviewed representations of the wrappers' EXECUTE ACL (NULL on a clean replay, explicit on hosted) and of the `search_vector` expression (wrapper calls on a clean replay, direct built-in calls on hosted — recorded at the time as "inlined"; see C54), and preserves whichever it finds (C51).

**Why there is no ordering constraint.** With no temporary object present — the only situation a legitimate caller creates — `pg_catalog, pg_temp` and `pg_catalog` resolve every name identically, so no call returns anything different. A call already executing when the migration commits finishes under the configuration it started with. So there was no web-first or Edge-first step, no drain and no barrier. **No Edge Function deployment and no manual frontend or Vercel step were part of this rollout.** Generated types do not change, because `proconfig` is not part of any signature.

**Procedure — EXECUTED 2026-09-27; kept as the reference procedure and as the pattern for a comparable migration-only change; not a pending step.** These are the steps as written before the rollout. The `expect` values in step 3 are the **pre-rollout** state it was checked against. What was actually observed and run is the status box above, restated per step below.
1. Independently approve the exact PR head. Merge it with a normal two-parent merge commit.
2. Wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. `E2E (local)` is not a merged-`main` check; its evidence is the pull-request run on the exact approved head.
3. Fresh read-only preflight against Production (pre-rollout expectations; after the rollout this query returns ledger 91, latest `20260927001229`, `c51_present` 1, the four targets at `{"search_path=pg_catalog, pg_temp"}`, `set_updated_at()` at `{search_path=pg_catalog}`, and the same digests, ACLs, `search_vector_expr` and `helpers_minus_config`):
   ```sql
   BEGIN; SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog, pg_temp;
   SELECT count(*) AS ledger, max(version) AS latest                                -- expect 90, 20260926202754
     FROM supabase_migrations.schema_migrations;
   SELECT count(*) FILTER (WHERE version = '20260927001229') AS c51_present         -- expect 0
     FROM supabase_migrations.schema_migrations;
   SELECT p.oid::regprocedure, p.proconfig::text, p.prosecdef, md5(p.prosrc) AS body,
          coalesce(p.proacl::text, '<default>') AS acl
     FROM pg_proc p
    WHERE p.oid IN ('public.attachment_cleanup_path_is_safe(uuid,text,uuid)'::regprocedure,
                    'public.immutable_english_tsvector_text(text)'::regprocedure,
                    'public.immutable_english_tsvector_textarr(text[])'::regprocedure,
                    'public.immutable_english_tsvector_jsonb(jsonb)'::regprocedure,
                    'public.set_updated_at()'::regprocedure)
    ORDER BY 1;                                  -- expect all five {search_path=pg_catalog}, prosecdef f, the five digests above
   SELECT md5(pg_get_expr(d.adbin, d.adrelid)) AS search_vector_expr                 -- expect 8ddd960b4f4b11dd7afd35485d01fd25
     FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector';
   -- Record this value; step 7 must return the same one.
   SELECT md5(string_agg(p.oid::text || '|' || md5((to_jsonb(p.*) - 'proconfig')::text), E'\n' ORDER BY p.oid))
            AS helpers_minus_config
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('attachment_cleanup_path_is_safe', 'immutable_english_tsvector_text',
                        'immutable_english_tsvector_textarr', 'immutable_english_tsvector_jsonb', 'set_updated_at',
                        'delete_attachment_with_cleanup', 'delete_papers_with_attachment_cleanup',
                        'finalize_attachment_upload');
   ROLLBACK;
   ```
   At preparation on 2026-09-27 this preflight returned exactly the pre-state above, and `helpers_minus_config` read `f2c68ed1852d00f9e0a1369ea11a172e`. The rule was to re-read it at preflight rather than trust that value, and the fresh preflight immediately before the apply returned the same value. Every other step-3 value matched too. Any other pre-state would have been a reason to stop, and the migration refuses it anyway (its §1). In particular, **if a body digest or the `search_vector` expression differs, stop and re-review**; do not edit the migration to fit.
4. `supabase migration list --linked` must show exactly one local-only migration, `20260927001229`. Then run `supabase db push --dry-run` from the merge commit; it must list **exactly** `20260927001229_harden_pg_catalog_helper_pg_temp_last.sql`. Anything else, stop (§6.2). *Observed:* exactly that one local-only migration and no remote-only one, and a dry run that listed exactly that file, with no seeds and no roles.
5. Obtain the separate, explicit rollout authorization. *Obtained before the apply.*
6. Apply exactly that migration through the normal linked workflow: `supabase db push --linked` (ledger **90 → 91**). *Executed as `supabase db push --linked --yes` (CLI 2.111.0) between 05:23:28Z and 05:23:59Z UTC; it applied exactly that one file, and the ledger went **90 → 91**.*
7. Verify immediately, read-only (the expected values below are the live state since 2026-09-27, and were observed exactly):
   - the ledger is **91**, latest `20260927001229`, present exactly once;
   - rerunning step 3 shows the four targets at exactly `{"search_path=pg_catalog, pg_temp"}` and `set_updated_at()` still at exactly `{search_path=pg_catalog}`; all five `prosecdef = f`; the same five body digests; the same literal ACLs; the same `search_vector_expr`;
   - `helpers_minus_config` is **identical** to the step-3 value. That shows the OIDs, bodies, ACLs, modes and owners of the five helpers and the three attachment callers are unchanged; only the four targets' `proconfig` moved.
8. Re-read the Security Advisor (read-only). `function_search_path_mutable` is expected to stay clear, since all five still pin a fixed path, and no new finding is expected. *Observed:* no `function_search_path_mutable` finding, none naming the five helpers, and no new finding; `authenticated_security_definer_function_executable` still **27**.

**No canary was run, and none was required.** No temporary-object probe was run in Production, and no application row was written. The migration's own verification refuses to commit anything but the expected catalog state, and the behaviour is covered in CI against a full replay: suites `007`, `014`, `015` and `021`, and the hosted-ACL parity lane, which applies this migration from Production's explicit ACL shape.

**Rollback — reference only; none has been performed, and this section authorizes none.** Prefer fixing forward. The reviewed restoration is a new forward migration with the same four statements set to `SET search_path = pg_catalog`, which returns them to the pre-change shape (bodies, ACLs and modes were never touched). It removes a hardening layer; it opens no grant. It needs its own decision against C51.

---

### 6.13 `20260927071803` (bulk metadata writes become SECURITY INVOKER, C52) — migration-only; COMPLETE: applied 2026-09-27

> **Status — COMPLETE. The migration-only rollout finished on 2026-09-27 and C52 is live in Production. Do not re-run the migration as a pending step.**
>
> - **Merged.** PR #309 as the two-parent commit `72469931591468bfebba2e8cfe9d7c7e85b7c658` (parents `f0931090` and the approved head `eaa3904c`; tree `bacea6cb`, identical to the approved head's).
> - **Hosted CI.** Merged-`main` on `7246993`: Validate (run `36307235008`), DB Tests (`36307235030`) and Extension (`36307235024`) passed. `E2E (local)` does not run on a push to `main` ([README](../README.md#ci)); its evidence for this change is the pull-request run on the exact approved head `eaa3904c4c73b476e778b9ff83979abca4e4b646`, run `36304602176`, which passed.
> - **Before — pre-rollout state, verified read-only at preparation on 2026-09-27 and again in the fresh preflight immediately before the apply** (step 3):
>   - PostgreSQL 17.6; ledger **91**, latest `20260927001229` (C51); C52 absent.
>   - `bulk_update_keywords(jsonb)` (OID `46223`, body `c002702d05a14e7febd00feaf1e97786`) and `bulk_update_study_types(jsonb)` (OID `19998`, body `6086d69c0915c8a7c67089556b40041b`) were SECURITY DEFINER, owned by `postgres`, plpgsql, VOLATILE, PARALLEL UNSAFE, `returns void`, argument `updates jsonb`, at `{"search_path=public, pg_temp"}`, with ACL `{postgres=X/postgres,authenticated=X/postgres}`.
>   - **35** `public` SECURITY DEFINER functions, **27** of them `authenticated`-callable; Security Advisor `authenticated_security_definer_function_executable` **27**, both functions listed. `safe_bulk_insert_papers(uuid,jsonb)` (OID `29057`) was SECURITY DEFINER.
>   - `papers`: owner `postgres`, RLS and FORCE RLS on, `authenticated` exactly `INSERT, SELECT, UPDATE`, no column grant. Its four caller-owned PERMISSIVE policies matched the digest `83aefa941c0457380be04b51c131ed5d`, and there was no RESTRICTIVE policy. `trg_papers_updated_at` (BEFORE UPDATE → `set_updated_at()`, SECURITY INVOKER, `{search_path=pg_catalog}`) and `papers_clear_author_identity_links_on_authors_change` (AFTER UPDATE OF `authors`, WHEN `authors` changed) were in their reviewed shape.
>   - `papers.search_vector` was at the hosted direct built-in expression `8ddd960b4f4b11dd7afd35485d01fd25` *(recorded at the time as "inlined" — the wrong mechanism; see C54)*; every function it calls was executable by `authenticated`. `idx_papers_search_vector` (OID `61100`) was valid and ready.
>   - The migration's own §0/§1 precondition blocks were run verbatim inside a read-only, rolled-back transaction, and passed both times.
> - **What was run — migration only, exactly as planned.**
>   - `supabase migration list --linked` showed local and remote aligned through `20260927001229`, exactly one local-only migration, `20260927071803`, and no remote-only one.
>   - `supabase db push --linked --dry-run` listed exactly `20260927071803_convert_bulk_metadata_writes_security_invoker.sql`, with no seeds and no roles.
>   - The normal linked `supabase db push --linked --yes` (Supabase CLI 2.111.0) then applied exactly that file under its own repository version, between 09:07:33Z and 09:07:45Z UTC. It exited 0 and reported no seeds and no roles.
>   - Ledger **91 → 92**, latest `20260927071803`, present exactly once (name `convert_bulk_metadata_writes_security_invoker`).
>   - It was the only intentional Production mutation of the C52 rollout. No Edge Function was deployed: all six versions and bundle hashes read back afterwards were unchanged. The rollout changed no Auth, Storage, secret, AI/provider or quota state, created no temporary object, wrote no application row and ran no canary.
> - **No manual Vercel action.** None was part of the database rollout, and none was needed: C52 changed a function security mode, tests and docs, not shipped frontend behavior. This record makes no claim about any Vercel deployment; that was outside the rollout's verification scope.
> - **After — verified read-only immediately after the apply** (and re-verified independently, read-only, on 2026-09-27 for the documentation reconciliation):
>   - Both functions are SECURITY INVOKER.
>     - They keep the same OIDs (`46223`, `19998`), owner `postgres`, plpgsql, VOLATILE and PARALLEL UNSAFE.
>     - They keep `{"search_path=public, pg_temp"}`, the ACL `{postgres=X/postgres,authenticated=X/postgres}`, and bodies `c002702d…` / `6086d69c…`.
>     - Their whole `pg_proc` rows minus `prosecdef` are **identical** to the preflight (`5fad9ff5f940c37fa9dd9fce3fc925b6` / `2da2205ff43522a8b9e2c8b4f859b041`). Only the security mode moved.
>   - **33** `public` SECURITY DEFINER functions, **25** of them `authenticated`-callable. **30** are at `{"search_path=public, pg_temp"}` and C50's **3** exceptions at `{search_path=public}`.
>     - Exactly these two left, and none joined. Every other `public` function's row is unchanged.
>     - `safe_bulk_insert_papers(uuid,jsonb)` (OID `29057`) was still SECURITY DEFINER at this rollout. *(C53 converted it later the same day, which took the inventory to 32 / 24; see §6.14.)*
>   - `papers` is unchanged:
>     - `authenticated` is still exactly `INSERT, SELECT, UPDATE`, with no DELETE or TRUNCATE;
>     - RLS and FORCE RLS are on;
>     - the four policies still match `83aefa94…`, none RESTRICTIVE.
>   - All twelve `papers` triggers are unchanged, `trg_papers_updated_at` and `papers_clear_author_identity_links_on_authors_change` included. So are `set_updated_at()`, the `search_vector` expression (`8ddd960b…`) and `idx_papers_search_vector` (OID `61100`, valid and ready, same definition).
>   - Row counts of all 29 `public` tables were identical immediately before and after the apply. The migration's own §3 also proved its transaction wrote no row.
>   - Security Advisor `authenticated_security_definer_function_executable` went **27 → 25**, with neither function listed and no finding added. The C30 leaked-password warning and the six `rls_enabled_no_policy` notices predate C52 and are unrelated to it.

**What changes.** Two statements inside a fail-closed transaction, one attribute each — `prosecdef` true → false:

```sql
ALTER FUNCTION public.bulk_update_keywords(jsonb)     SECURITY INVOKER;
ALTER FUNCTION public.bulk_update_study_types(jsonb)  SECURITY INVOKER;
```

Nothing else: not a body, OID, signature, return type, owner, `search_path` (both keep C50's `public, pg_temp`), volatility, parallel mode, cost, strictness or EXECUTE ACL; not a table grant, RLS flag, policy, trigger, generated column or index; not another function (`safe_bulk_insert_papers` stays SECURITY DEFINER under C52; C53 later converted it, §6.14); not a row. `authenticated` keeps EXECUTE on both. See decision C52.

**Why there is no ordering constraint.** The shipped web app calls both functions for ids from the caller's own library. For those ids both security modes update the same rows: the body's `user_id` predicate and the caller-owned RLS SELECT and UPDATE policies admit the same set. Every other id is a silent no-op in both modes. A call already executing when the migration commits finishes under the mode it started with. No Edge Function calls them. So there was no web-first or Edge-first step, no drain and no barrier. **No Edge Function deployment and no manual frontend or Vercel step were part of this rollout.** Generated types do not change: the security mode is not part of the function signature PostgREST types describe, and the local check was byte-identical.

**Procedure — EXECUTED 2026-09-27; kept as the reference procedure and as the pattern for a comparable migration-only change; not a pending step.** These are the steps as written before the rollout. The `expect` values in step 3 are the **pre-rollout** state it was checked against. What was actually observed and run is the status box above, restated per step below.
1. Independently approve the exact PR head. Merge it with a normal two-parent merge commit.
2. Wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. `E2E (local)` is not a merged-`main` check; its evidence is the pull-request run on the exact approved head.
3. Fresh read-only preflight against Production. These are the pre-rollout expectations. After the rollout this query returned:
   - ledger 92, latest `20260927071803`, `c52_present` 1;
   - both rows with `prosecdef` false, and the same OIDs, bodies, paths, ACLs and `row_minus_secdef` values;
   - `public_definer` 33 and `auth_definer` 25;
   - the same `papers_policies` and `search_vector_expr`.

   *(That is C52's post-state. The 2026-09-27 C53 rollout took the ledger to 93, latest `20260927123856`, and the counts to `public_definer` 32 and `auth_definer` 24, with the two C52 rows unchanged (§6.14). The 2026-09-27 C54 rollout then took the ledger to 94, latest `20260927161343`, changing nothing else (§6.15). The 2026-09-28 C55 rollout then took the ledger to 95, latest `20260927214838`, removing only the three SECURITY INVOKER `immutable_english_tsvector_*` wrappers and leaving these counts unchanged (§6.16). The 2026-09-28 C56 rollout then took the ledger to 96, latest `20260928133918`, changing only the ACLs of two SECURITY INVOKER trigger functions and `postgres`'s function defaults, and leaving these counts unchanged (§6.17).)*

   ```sql
   BEGIN; SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog, pg_temp;
   SELECT count(*) AS ledger, max(version) AS latest                                -- expect 91, 20260927001229
     FROM supabase_migrations.schema_migrations;
   SELECT count(*) FILTER (WHERE version = '20260927071803') AS c52_present         -- expect 0
     FROM supabase_migrations.schema_migrations;
   SELECT p.oid, p.oid::regprocedure, p.prosecdef, p.proconfig::text, md5(p.prosrc) AS body,
          p.proacl::text, md5((to_jsonb(p.*) - 'prosecdef')::text) AS row_minus_secdef
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('bulk_update_keywords', 'bulk_update_study_types')
    ORDER BY 2;                          -- expect the two rows in the status box's "Before" list, prosecdef true
   SELECT count(*) FILTER (WHERE p.prosecdef) AS public_definer,                    -- expect 35
          count(*) FILTER (WHERE p.prosecdef
                             AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_definer  -- expect 27
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
   SELECT md5(string_agg(format('%s|%s|%s|%s|%s|%s', pol.polname, pol.polcmd, pol.polpermissive,
                                (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                                   FROM unnest(pol.polroles) r),
                                coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>'),
                                coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')),
                         E'\n' ORDER BY pol.polname)) AS papers_policies            -- expect 83aefa941c0457380be04b51c131ed5d
     FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass;
   SELECT md5(pg_get_expr(d.adbin, d.adrelid)) AS search_vector_expr                 -- expect 8ddd960b4f4b11dd7afd35485d01fd25
     FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector';
   ROLLBACK;
   ```
   Record both `row_minus_secdef` values; step 7 must return the same ones. At preparation on 2026-09-27 they read `5fad9ff5f940c37fa9dd9fce3fc925b6` (`bulk_update_keywords`) and `2da2205ff43522a8b9e2c8b4f859b041` (`bulk_update_study_types`).
   - The rule was to re-read them at preflight rather than trust those values. The fresh preflight immediately before the apply returned the same values, and every other step-3 value matched too.
   - The migration's own §0/§1 blocks also passed, run verbatim inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`.
   - Any other pre-state would have been a reason to stop, and the migration refuses it anyway (its §1). In particular, **if a body digest, the policy digest or the `search_vector` expression differs, stop and re-review**; do not edit the migration to fit.
4. `supabase migration list --linked` must show exactly one local-only migration, `20260927071803`, and no remote-only one. Then run `supabase db push --dry-run` from the merge commit; it must list **exactly** `20260927071803_convert_bulk_metadata_writes_security_invoker.sql`. Anything else, stop (§6.2). *Observed:* local and remote aligned through `20260927001229`, exactly that one local-only migration and no remote-only one, and a dry run that listed exactly that file, with no seeds and no roles.
5. Obtain the separate, explicit rollout authorization. *Obtained before the apply.*
6. Apply exactly that migration through the normal linked workflow: `supabase db push --linked` (ledger **91 → 92**). *Executed as `supabase db push --linked --yes` (CLI 2.111.0) between 09:07:33Z and 09:07:45Z UTC; it applied exactly that one file, and the ledger went **91 → 92**.*
7. Verify immediately, read-only (the expected values below are the live state since 2026-09-27, and were observed exactly):
   - the ledger is **92**, latest `20260927071803`, present exactly once;
   - rerunning step 3 shows both functions with `prosecdef` **false**, and the same OIDs (`46223`, `19998`), body digests, `{"search_path=public, pg_temp"}` and ACL `{postgres=X/postgres,authenticated=X/postgres}`; both `row_minus_secdef` values are **identical** to step 3;
   - `public_definer` **35 → 33**, `auth_definer` **27 → 25**; the two that left are exactly these two;
   - `authenticated` still has EXECUTE on both, and `anon`, `service_role` and PUBLIC still have none;
   - `papers`' grants, RLS and FORCE RLS are unchanged, `papers_policies` is unchanged, and so are both named triggers, `search_vector_expr` and `idx_papers_search_vector`;
   - Edge Function versions are unchanged.
8. Re-read the Security Advisor (read-only). `authenticated_security_definer_function_executable` is expected to go **27 → 25**, with neither function listed. The remaining 25 are the 24 functions the C49 audit found intentionally privileged, plus `safe_bulk_insert_papers`, which was then still unaudited for SECURITY INVOKER *(since audited and converted by C53, which took the count 25 → 24; §6.14)*. They are not 25 confirmed defects; each is classified function by function. *Observed:* **27 → 25**, neither function listed and no finding added. The six `rls_enabled_no_policy` notices (INFO) and the C30 leaked-password warning (WARN) were unchanged.

**No canary was run, and none was required.** No application row was written, and no disposable user or paper was created in Production. The migration's own verification refuses to commit anything but the expected catalog state. The behaviour under INVOKER is covered in CI against a full replay: suite `022`, plus `000`, `003`, `015` and `021`, and the hosted-ACL parity lane, which applies this migration from Production's legacy ACL shape. If an authenticated product smoke is ever separately authorized, the smallest one is to change a keyword-pool entry and a study-type-pool entry so the library re-evaluates keywords and study types. Both must save without an error toast, exactly as before.

**Rollback — reference only; none has been performed, and this section authorizes none.** Prefer fixing forward. The reviewed restoration is a new forward migration containing exactly the two `ALTER FUNCTION … SECURITY DEFINER;` statements, which returns them to the pre-change shape (bodies, ACL and configuration were never touched). It re-adds owner authority and re-makes the body predicate the only database boundary for these two; it does not remove any boundary. It needs its own decision against C52.

---

### 6.14 `20260927123856` (`safe_bulk_insert_papers` becomes SECURITY INVOKER, C53) — migration-only; COMPLETE: applied 2026-09-27

> **Status — COMPLETE. The migration-only rollout finished on 2026-09-27 and C53 is live in Production. Do not re-run the migration as a pending step. No rollback has been performed.**
>
> - **Merged.** PR #311 as the two-parent commit `fa01fe1862d41f9c376eff3f53f2dd8aa0bee185` (parents `1de56587` and the approved head `660b2a5f`; tree `a6edbe71`, identical to the approved head's).
> - **Hosted CI.** Merged-`main` on `fa01fe1`: Validate (run `36324018877`), DB Tests (`36324018874`) and Extension (`36324018829`) passed. `E2E (local)` does not run on a push to `main` ([README](../README.md#ci)); its evidence for this change is the pull-request run on the exact approved head `660b2a5fa6533055044c2bf0e73592a6d2fe1ed3`, run `36322283497`, which passed.
> - **Before — pre-rollout state, verified read-only at preparation on 2026-09-27 and again in the fresh preflight immediately before the apply** (step 3):
>   - PostgreSQL 17.6; ledger **92**, latest `20260927071803` (C52); C53 absent.
>   - `safe_bulk_insert_papers(uuid,jsonb)` (OID `29057`, body `119925245a5c3c8529ada3d2e10fba96`, 7,628 characters) was SECURITY DEFINER, owned by `postgres`, plpgsql, VOLATILE, PARALLEL UNSAFE, not STRICT, `returns jsonb`, arguments `p_user_id uuid, p_papers jsonb`, at `{"search_path=public, pg_temp"}`, with ACL `{postgres=X/postgres,authenticated=X/postgres}`. Its whole `pg_proc` row minus `prosecdef` hashed to `0a0cb0878fbafd75b4f5d8f366904d81`, by the formula in step 3.
>   - **33** `public` SECURITY DEFINER functions, **25** of them `authenticated`-callable, distributed **30** at `public, pg_temp` and **3** at `public`. The Security Advisor's `authenticated_security_definer_function_executable` was **25**, and it listed this function.
>   - `papers`: owner `postgres`, RLS and FORCE RLS on, `authenticated` exactly `INSERT, SELECT, UPDATE`, no column grant. Its four caller-owned PERMISSIVE policies matched the digest `83aefa941c0457380be04b51c131ed5d`, and there was no RESTRICTIVE policy. `authenticated` held exactly `USAGE` on `papers_insert_order_seq`. The six constraints (the `papers.user_id → auth.users` foreign key included), the seven indexes (all valid and ready, the PMID and `lower(doi)` unique indexes included) and the twelve triggers were in their reviewed shape. Both named triggers were UPDATE-only, and the only INSERT-time trigger was the internal `papers_user_id_fkey` check against `auth.users`.
>   - `papers.search_vector` was at the hosted direct built-in expression `8ddd960b4f4b11dd7afd35485d01fd25` *(recorded at the time as "inlined" — the wrong mechanism; see C54)*. Read by function OID, `authenticated` could EXECUTE all three functions it calls: `setweight(tsvector,"char")`, `to_tsvector(regconfig,text)` and `tsvector_concat(tsvector,tsvector)`. `idx_papers_search_vector` (OID `61100`) was valid and ready. Every function and operator the body calls was executable by `authenticated` too.
>   - The migration's own §0/§1 precondition blocks were run verbatim inside a read-only, rolled-back transaction, and passed both times.
> - **What was run — migration only, exactly as planned.**
>   - `supabase migration list --linked` showed local and remote aligned through `20260927071803`, exactly one local-only migration, `20260927123856`, and no remote-only one.
>   - `supabase db push --linked --dry-run` listed exactly `20260927123856_convert_safe_bulk_insert_security_invoker.sql`, with no seeds and no roles.
>   - From a clean checkout of the merge commit, the normal linked `supabase db push --linked --yes` (Supabase CLI 2.111.0) then applied exactly that file under its own repository version, between 14:14:00Z and 14:14:10Z UTC. It exited 0 and reported no seeds and no roles.
>   - Ledger **92 → 93**, latest `20260927123856`, present exactly once (name `convert_safe_bulk_insert_security_invoker`). Its seven recorded statements hold exactly one `ALTER`, the reviewed one.
>   - It was the only intentional Production mutation of the C53 rollout. No Edge Function was deployed: all six functions' versions and last-update times predate the rollout (the latest are `analyze-paper` v33 and `suggest-paper-organization` v16, both from 2026-09-25), re-read on 2026-09-27. The rollout changed no Auth, Storage, secret, AI/provider or quota state, created no temporary object, wrote no application row, never called the function and ran no canary.
> - **No manual Vercel action.** None was part of the database rollout, and none was needed: C53 changed a function security mode, tests and docs, not shipped frontend behavior. This record makes no claim about any Vercel deployment; that was outside the rollout's verification scope.
> - **After — verified read-only immediately after the apply** (and re-verified independently, read-only, on 2026-09-27 for the documentation reconciliation):
>   - `safe_bulk_insert_papers(uuid,jsonb)` is SECURITY INVOKER.
>     - It keeps the same OID (`29057`), owner `postgres`, plpgsql, VOLATILE, PARALLEL UNSAFE, not STRICT, `returns jsonb` and arguments `p_user_id uuid, p_papers jsonb`.
>     - It keeps `{"search_path=public, pg_temp"}`, the ACL `{postgres=X/postgres,authenticated=X/postgres}`, its comment and body `119925245a…` (7,628 characters).
>     - Its whole `pg_proc` row minus `prosecdef` is **identical** to the preflight (`0a0cb0878fbafd75b4f5d8f366904d81`). Only the security mode moved.
>   - **32** `public` SECURITY DEFINER functions, **24** of them `authenticated`-callable. **29** are at `{"search_path=public, pg_temp"}` and C50's **3** exceptions at `{search_path=public}`.
>     - Exactly this function left, and none joined. Every other `public` function's whole row is unchanged.
>   - `papers` is unchanged:
>     - `authenticated` is still exactly `INSERT, SELECT, UPDATE`, with no DELETE or TRUNCATE and no column grant;
>     - RLS and FORCE RLS are on;
>     - the four policies still match `83aefa94…`, none RESTRICTIVE: INSERT `WITH CHECK (auth.uid() = user_id)`, SELECT `USING (auth.uid() = user_id)`, and the UPDATE and DELETE ones.
>   - `authenticated` still holds exactly `USAGE` on `papers_insert_order_seq`.
>   - The six constraints and the `auth.users` foreign key, the seven indexes, all twelve triggers, every column default and generated expression, the `search_vector` expression (`8ddd960b…`, with EXECUTE on its three functions) and `idx_papers_search_vector` (OID `61100`, valid and ready, same definition) are unchanged. So are the `public`-wide relation ACL, column ACL, policy, trigger, constraint and index digests.
>   - `papers`' row count and latest `created_at` / `updated_at` were identical immediately before and after the apply. The migration's own verification also proved its transaction wrote no row.
>   - Security Advisor `authenticated_security_definer_function_executable` went **25 → 24**, with `safe_bulk_insert_papers` no longer listed. It was the only name removed, and none was added. The C30 leaked-password warning (WARN) and the six `rls_enabled_no_policy` notices (INFO) predate C53 and are unchanged.

**What changes.** One statement inside a fail-closed transaction, one attribute — `prosecdef` true → false:

```sql
ALTER FUNCTION public.safe_bulk_insert_papers(uuid,jsonb)  SECURITY INVOKER;
```

Nothing else changes. The body (the broad per-row `WHEN OTHERS` handler included), OID, signature, return type, owner, comment, `search_path` (C50's `public, pg_temp`), volatility, parallel mode, cost, strictness and EXECUTE ACL all stay as they are. So do every table and sequence grant, RLS flag, policy, trigger, constraint, default, generated column and index, and every other function. No row is written. `authenticated` keeps EXECUTE. See decision C53.

**Why there is no ordering constraint.** The shipped web app calls this function with its own user id, in chunks of 50. For a legitimate caller both security modes insert the same rows and return the same result. The identity guard rejects every other `p_user_id` in both modes, and the caller-owned RLS policies admit exactly the rows the guard admits. A call already executing when the migration commits finishes under the mode it started with. No Edge Function calls it. So there was no web-first or Edge-first step, no drain and no barrier. **No Edge Function deployment and no manual frontend or Vercel step were part of this rollout.** Generated types do not change: the security mode is not part of the function signature PostgREST types describe, and the local regeneration was byte-identical.

**Procedure — EXECUTED 2026-09-27; kept as the reference procedure and as the pattern for a comparable migration-only change; not a pending step.** These are the steps as written before the rollout. The `expect` values in step 3 are the **pre-rollout** state it was checked against. What was actually observed and run is the status box above, restated per step below.
1. Independently approve the exact PR head. Merge it with a normal two-parent merge commit.
2. Wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. `E2E (local)` is not a merged-`main` check; its evidence is the pull-request run on the exact approved head.
3. Fresh read-only preflight against Production. These are the pre-rollout expectations. After the rollout this query returns:
   - ledger 93, latest `20260927123856`, `c53_present` 1;
   - the row with `prosecdef` false, and the same OID, body, length, path, ACL and `row_minus_secdef`;
   - `public_definer` 32, `auth_definer` 24 and `pg_temp_definer` 29;
   - the same `papers_policies`, `seq_usage` and `search_vector_expr`.

   ```sql
   BEGIN; SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog, pg_temp;
   SELECT count(*) AS ledger, max(version) AS latest                                -- expect 92, 20260927071803
     FROM supabase_migrations.schema_migrations;
   SELECT count(*) FILTER (WHERE version = '20260927123856') AS c53_present         -- expect 0
     FROM supabase_migrations.schema_migrations;
   SELECT p.oid, p.prosecdef, p.proconfig::text, md5(p.prosrc) AS body, length(p.prosrc) AS body_len,
          p.proacl::text, md5((to_jsonb(p.*) - 'prosecdef')::text) AS row_minus_secdef
     FROM pg_proc p
    WHERE p.oid = 'public.safe_bulk_insert_papers(uuid,jsonb)'::regprocedure;  -- expect the row in the status box's "Before" list, prosecdef true
   SELECT count(*) FILTER (WHERE p.prosecdef) AS public_definer,                    -- expect 33
          count(*) FILTER (WHERE p.prosecdef
                             AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_definer,  -- expect 25
          count(*) FILTER (WHERE p.prosecdef
                             AND p.proconfig = ARRAY['search_path=public, pg_temp']) AS pg_temp_definer    -- expect 30
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
   SELECT md5(string_agg(format('%s|%s|%s|%s|%s|%s', pol.polname, pol.polcmd, pol.polpermissive,
                                (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                                   FROM unnest(pol.polroles) r),
                                coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>'),
                                coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')),
                         E'\n' ORDER BY pol.polname)) AS papers_policies            -- expect 83aefa941c0457380be04b51c131ed5d
     FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass;
   SELECT has_sequence_privilege('authenticated', 'public.papers_insert_order_seq', 'USAGE') AS seq_usage;  -- expect true
   SELECT md5(pg_get_expr(d.adbin, d.adrelid)) AS search_vector_expr                 -- expect 8ddd960b4f4b11dd7afd35485d01fd25
     FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector';
   ROLLBACK;
   ```
   Record `row_minus_secdef`; step 7 must return the same value. At preparation on 2026-09-27 it read `0a0cb0878fbafd75b4f5d8f366904d81`.
   - The rule was to re-read it at preflight rather than trust that value. The fresh preflight immediately before the apply returned the same value, and every other step-3 value matched too.
   - The migration's own §0/§1 blocks also passed, run verbatim inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`.
   - Any other pre-state would have been a reason to stop, and the migration refuses it anyway (its §1). In particular, **if the body digest, the policy digest or the `search_vector` expression differs, stop and re-review**; do not edit the migration to fit.
4. `supabase migration list --linked` must show exactly one local-only migration, `20260927123856`, and no remote-only one. Then run `supabase db push --dry-run` from the merge commit; it must list **exactly** `20260927123856_convert_safe_bulk_insert_security_invoker.sql`. Anything else, stop (§6.2). *Observed:* local and remote aligned through `20260927071803`, exactly that one local-only migration and no remote-only one, and a dry run that listed exactly that file, with no seeds and no roles.
5. Obtain the separate, explicit rollout authorization. *Obtained before the apply.*
6. Apply exactly that migration through the normal linked workflow: `supabase db push --linked` (ledger **92 → 93**). *Executed as `supabase db push --linked --yes` (CLI 2.111.0) between 14:14:00Z and 14:14:10Z UTC; it exited 0, applied exactly that one file, and the ledger went **92 → 93**.*
7. Verify immediately, read-only (the expected values below are the live state since 2026-09-27, and were observed exactly):
   - the ledger is **93**, latest `20260927123856`, present exactly once;
   - rerunning step 3 shows the function with `prosecdef` **false**, and the same OID (`29057`), body digest, `{"search_path=public, pg_temp"}` and ACL `{postgres=X/postgres,authenticated=X/postgres}`; `row_minus_secdef` is **identical** to step 3;
   - `public_definer` **33 → 32**, `auth_definer` **25 → 24**, `pg_temp_definer` **30 → 29**, and the 3 `public` exceptions unchanged; the one that left is exactly this function;
   - `authenticated` still has EXECUTE, and `anon`, `service_role` and PUBLIC still have none;
   - `papers`' grants, RLS and FORCE RLS are unchanged; `papers_policies`, `seq_usage`, both named triggers, `search_vector_expr` and `idx_papers_search_vector` are unchanged;
   - Edge Function versions are unchanged. *Observed:* no Edge Function was deployed; all six versions and last-update times predate the rollout.
8. Re-read the Security Advisor (read-only). `authenticated_security_definer_function_executable` is expected to go **25 → 24**, with `safe_bulk_insert_papers` no longer listed. The remaining 24 are the functions the C49 audit found intentionally privileged. They are not 24 confirmed defects; each is classified function by function. *Observed:* **25 → 24**, `safe_bulk_insert_papers` no longer listed and no finding added. The six `rls_enabled_no_policy` notices (INFO) and the C30 leaked-password warning (WARN) were unchanged.

**No canary was run, and none was required.** The function was never called in Production, no application row was written, and no disposable user or paper was created there. The migration's own verification refuses to commit anything but the expected catalog state. The behaviour under INVOKER is covered in CI against a full replay: suite `023`, plus `000`, `003`, `006`, `009`, `013`, `015` and `021`, and the hosted-ACL parity lane, which applies this migration from Production's legacy ACL shape. If an authenticated product smoke is ever separately authorized, the smallest one is a single-identifier PubMed import of a paper already in the account's library. It must be reported as a skipped duplicate exactly as before, and it writes no row.

**Row-level errors under caller drift — expected, and fail-closed.** C53 kept the per-row `WHEN OTHERS` handler by decision; the body did not change. If a future change ever removed a grant or policy this function relies on, the import would report each affected paper as `failed` (a per-row `error` object at HTTP 200) rather than failing the whole request. Nothing would be written, and no other account's data would be returned. The importer already treats a failed RPC chunk the same way, so the user sees the same failed items. Drift that strikes inside the duplicate handler still escapes as an RPC-level error that rolls the whole call back. Treat a sudden spike of failed imports after any `papers` grant, policy or sequence change as that drift.

**Rollback — reference only; none has been performed, and this section authorizes none.** Prefer fixing forward. The reviewed restoration is a new forward migration containing exactly `ALTER FUNCTION public.safe_bulk_insert_papers(uuid,jsonb) SECURITY DEFINER;`, which returns it to the pre-change shape (body, ACL and configuration were never touched). It re-adds owner authority and re-makes the identity guard the only database boundary for this function; it does not remove any boundary. It needs its own decision against C53.

### 6.15 `20260927161343` (one canonical `papers.search_vector` expression, C54) — migration-only; COMPLETE: applied 2026-09-27 (Production took the no-op branch)

> **Status — COMPLETE. The migration-only rollout finished on 2026-09-27 and C54 is live in Production. Production already stored the canonical direct built-in expression, so the migration took its no-op branch there. Its column was not rewritten, and the C54 ledger row is the only durable database change. Do not re-run the migration as a pending step. No rollback has been performed.**
>
> *(2026-09-28: the wrapper facts below — present, unreferenced, zero dependents — and step 7's ledger values describe C54's rollout. C55 retired the three wrappers in Production on 2026-09-28, taking the ledger to 95 (§6.16); the `search_vector`, `papers` and index facts below still hold. Step 3's wrapper-dependents query below resolves the wrappers by signature, so it now errors in Production, as on any database where C55 has run.)*
>
> - **Merged.** PR #313 as the two-parent commit `05ca045476f67ef9ccee5e23936b1b47acee6adb` (parents `9bf114bd` and the approved head `e10eaba6`; tree `5326acda`, identical to the approved head's). The source branch `db/search-vector-direct-canonicalization` is preserved, but it is no longer pending work. Since the merge, every replay ends on one `search_vector` representation (C54).
> - **Hosted CI.** Merged-`main` on `05ca045`: Validate (run `36344934817`), DB Tests (`36344934832`) and Extension (`36344934863`) passed. `E2E (local)` does not run on a push to `main` ([README](../README.md#ci)); its evidence for this change is the pull-request run on the exact approved head `e10eaba6c309eaea4014e87c40a9f056a03fb80f`, run `36342553665`, which passed.
> - **Before — pre-rollout state, verified read-only at preparation on 2026-09-27 and again in the fresh preflight immediately before the apply** (step 3):
>   - PostgreSQL 17.6; ledger **93**, latest `20260927123856` (C53); `20260927161343` absent.
>   - `papers.search_vector`: attnum 29, attrdef OID `59954` (xmin `6791`), expression `8ddd960b4f4b11dd7afd35485d01fd25`. This is the direct built-in form. It calls `setweight`, `to_tsvector(regconfig,text)` and `tsvector_concat`, all executable by `authenticated`. Its normal dependencies are exactly its six input columns and `pg_ts_config english`.
>   - `idx_papers_search_vector`: OID `61100` (relfilenode `61100`), valid, ready and live, `GIN (search_vector)`. `papers`: OID `17492`, relfilenode `59955` (`pg_class` xmin `11363`); TOAST `59958`.
>   - The three wrappers (OIDs `66407`–`66409`, bodies `26edc211…` / `19261084…` / `30c015cd…`, `{"search_path=pg_catalog, pg_temp"}`, the explicit hosted ACL) had **zero** dependents.
> - **Rehearsal — the real migration file, read-only.** The file ran end to end inside `BEGIN TRANSACTION READ ONLY … ROLLBACK` twice: at preparation, and again immediately before the apply. Only its `BEGIN;` and `COMMIT;` lines were replaced. The second run used the merged file, identical to the approved head.
>   - Both times it classified Production as the **no-op** branch and passed every precondition and postcondition, the all-rows semantic check included.
>   - It held only ACCESS SHARE on `papers` and its indexes. The second run also confirmed it held no stronger relation lock anywhere.
>   - It was never assigned a transaction ID, ran no ALTER and no ANALYZE, and rolled back.
> - **What was run — migration only, exactly as planned.**
>   - `supabase migration list --linked` showed local and remote aligned through `20260927123856`, exactly one local-only migration, `20260927161343`, and no remote-only one.
>   - `supabase db push --linked --dry-run` listed exactly `20260927161343_canonicalize_papers_search_vector_expression.sql`, with no seeds and no roles.
>   - From a clean checkout of the merge commit, the normal linked `supabase db push --linked --yes` (Supabase CLI 2.111.0) then applied exactly that file, between 19:51:53Z and 19:52:27Z UTC. It exited 0 and reported no seeds and no roles.
>   - Ledger **93 → 94**, latest `20260927161343`, present exactly once (name `canonicalize_papers_search_vector_expression`). Each of its ten recorded statements appears verbatim in the merged file. `supabase migration list --linked` now shows local and remote aligned through `20260927161343`.
>   - This was the rollout's only intentional Production mutation.
>     - No Edge Function was deployed. All six functions' versions and last-update times predate the rollout; the latest are `analyze-paper` v33 and `suggest-paper-organization` v16, both from 2026-09-25.
>     - The rollout changed no Auth, Storage, secret, AI/provider or quota state, created no temporary object, wrote no application row and ran no canary.
> - **No manual Vercel action.** None was part of the database rollout, and none was needed. This record makes no claim about any Vercel deployment.
> - **After — verified read-only immediately after the apply, again a minute later, and again on 2026-09-27 for the documentation reconciliation:**
>   - PostgreSQL 17.6; ledger **94**, latest `20260927161343`, present exactly once.
>   - A 165-value catalog snapshot, taken immediately before and after the apply, differed in exactly six values. All six are ledger fields: the count, the latest version, and the C54 row's presence, name, statement count and statement digest. **No application, schema or physical object changed; the C54 ledger row was the only durable database change.** In particular, these were identical before and after:
>     - `search_vector`: F1 `8ddd960b…`, attnum 29, the attrdef row (OID `59954`, xmin `6791`, content) and its dependency rows, the column's `pg_attribute` row, and the call set (OIDs 3624, 3745, 3625);
>     - `papers`: relfilenode `59955` and `pg_class` xmin `11363`; the TOAST relation and file `59958` and its index;
>     - all seven `papers` indexes' OIDs, relfilenodes and xmins, `idx_papers_search_vector` (`61100` / `61100`, valid, ready, live) included;
>     - the wrappers' rows (bodies, `proconfig`, ACLs) and their 0 / 0 / 0 dependents;
>     - on `papers`: owner, ACL, column ACLs, RLS and FORCE RLS, policies, constraints (the foreign keys referencing it included), triggers, defaults, generated columns and sequence;
>     - in `public`: every function, relation, policy, constraint, trigger and default digest.
>   - **No ANALYZE ran.** `papers`' manual `analyze_count` stayed 0. The `pg_statistic` digest, the `search_vector` statistics row's xmin and the last autoanalyze (2026-09-24) were all unchanged.

**What the migration does.** It accepts exactly two starting representations of `papers.search_vector` and refuses any third before taking a lock or changing anything (C54):
- **Direct built-in** (`8ddd960b…`, hosted Production) → **no-op branch.** Validation reads only: no `ALTER TABLE`, no explicit lock, no table rewrite, no index rebuild, no `ANALYZE`, no row write. Its own verification proves before COMMIT that the heap, TOAST and index files, every index OID and the column default's row are physically unchanged, and that it held nothing stronger than ACCESS SHARE on `papers`. **Production took this branch on 2026-09-27.**
- **Clean-replay wrapper** (`dd69f099…`, every `supabase db reset`) → **rewrite branch.** `lock_timeout` 5 s, ACCESS EXCLUSIVE on `papers`, every precondition re-checked under the lock, one `ALTER TABLE public.papers ALTER COLUMN search_vector SET EXPRESSION AS (…)`, then `ANALYZE public.papers (search_vector)`, with row count, data and stored vectors proven identical. This branch runs on replays only; it did not run in Production.

Both branches require every stored vector to equal the canonical expression already (validation only), and end on exactly `8ddd960b…` with no wrapper dependency.

**Production effect — projected before the rollout, and observed exactly.** Exactly one ledger row (**93 → 94**). The no-op branch. No ALTER TABLE, no rewrite, no index rebuild, no ANALYZE, no application-data write. The `search_vector` expression, attrdef OID `59954`, `idx_papers_search_vector` OID `61100` and every relfilenode unchanged. It reads every `papers` row once for the semantic check, under ACCESS SHARE only, so it neither blocks nor is blocked by ordinary application reads and writes.

**Why there was no ordering constraint.** Production's expression and stored values did not change, so no client, RPC or Edge Function could observe the rollout. No Edge Function deployment, no frontend step and no drain were involved. Generated types do not change (local regeneration byte-identical).

**Procedure — EXECUTED 2026-09-27; kept as the reference procedure; not a pending step.** These are the steps as written before the rollout. The `expect` values in step 3 are the **pre-rollout** state it was checked against. What was actually observed and run is the status box above, restated per step below.
1. Independently approve the exact PR head. Merge it with a normal two-parent merge commit.
2. Wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. `E2E (local)` is not a merged-`main` check; its evidence is the pull-request run on the exact approved head.
3. Fresh read-only preflight against Production. These are the pre-rollout expectations. After the rollout, the second query returns `94`, `20260927161343` and `1`; every other value is unchanged.

   ```sql
   BEGIN; SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog, pg_temp;
   SELECT current_setting('server_version') AS pg;                                   -- expect 17.6 (see the note below if not)
   SELECT count(*) AS ledger, max(version) AS latest,                                -- expect 93, 20260927123856
          count(*) FILTER (WHERE version = '20260927161343') AS c54_present         -- expect 0
     FROM supabase_migrations.schema_migrations;
   SELECT a.attnum, d.oid AS attrdef_oid, d.xmin::text AS attrdef_xmin,            -- expect 29, 59954; record the xmin
          md5(pg_get_expr(d.adbin, d.adrelid)) AS search_vector_expr                -- expect 8ddd960b4f4b11dd7afd35485d01fd25
     FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector';
   SELECT c.oid, c.relfilenode, c.xmin::text AS class_xmin                           -- expect idx 61100/61100 and papers 17492/59955; record the xmins
     FROM pg_class c WHERE c.oid IN ('public.papers'::regclass, 'public.idx_papers_search_vector'::regclass);
   SELECT count(*) AS wrapper_dependents                                             -- expect 0
     FROM pg_depend WHERE refclassid = 'pg_proc'::regclass AND deptype = 'n'
      AND refobjid IN ('public.immutable_english_tsvector_text(text)'::regprocedure,
                       'public.immutable_english_tsvector_jsonb(jsonb)'::regprocedure,
                       'public.immutable_english_tsvector_textarr(text[])'::regprocedure);
   ROLLBACK;
   ```
   Then run the **real migration file** read-only: replace its `BEGIN;` with `BEGIN TRANSACTION READ ONLY;` and its `COMMIT;` with `ROLLBACK;`, and run it with `supabase db query --linked -f`. It must finish, with `current_setting('paperlume.search_vector_parity.branch', true)` = `noop` just before the ROLLBACK. A read-only transaction cannot take the rewrite branch's lock, so it cannot change anything even if the classification were wrong. **If the expression is not `8ddd960b…`, the branch is not `noop`, or any check refuses, stop and re-review; do not edit the migration to fit.** *Observed:* every step-3 value matched, at preparation and immediately before the apply. It read attrdef xmin `6791`, `papers` `pg_class` xmin `11363` and index xmin `6791`. The real file, run read-only both times, finished on `noop` with only ACCESS SHARE held and no transaction ID assigned.
4. `supabase migration list --linked` must show exactly one local-only migration, `20260927161343`, and no remote-only one. Then run `supabase db push --dry-run` from the merge commit. It must list **exactly** `20260927161343_canonicalize_papers_search_vector_expression.sql`, with no seeds and no roles. Anything else, stop (§6.2). *Observed:* local and remote aligned through `20260927123856`, exactly that one local-only migration and no remote-only one, and a dry run that listed exactly that file, with no seeds and no roles.
5. Obtain the separate, explicit rollout authorization. *Obtained before the apply.*
6. Apply exactly that migration through the normal linked workflow: `supabase db push --linked` (ledger **93 → 94**). The file is explicitly transactional; a refusal rolls it back with nothing changed. *Executed as `supabase db push --linked --yes` (CLI 2.111.0) between 19:51:53Z and 19:52:27Z UTC; it exited 0, applied exactly that one file, and the ledger went **93 → 94**.*
7. Verify immediately, read-only (the expected values below are the live state since 2026-09-27, and were observed exactly). Rerun step 3's first query block:
   - the ledger is **94**, latest `20260927161343`, present exactly once;
   - `search_vector_expr` is still `8ddd960b…`, and attnum 29, attrdef OID `59954` **and its xmin** are identical to step 3 (an `ALTER TABLE` would have replaced the attrdef row);
   - `papers` and `idx_papers_search_vector` keep the same OIDs, relfilenodes **and** `pg_class` xmins (a rewrite, index rebuild or ANALYZE would move at least one);
   - wrapper dependents are still 0; Edge Function versions are unchanged. *Observed:* no Edge Function was deployed; all six versions and last-update times predate the rollout.

**No canary was run, and none was required.** Nothing observable changed in Production. The rewrite branch's behavior is covered in CI against a full replay: suite `024` (the single-representation contract, a 33-case equivalence corpus and before/after `search_papers` comparison), suites `022` and `023`, and the hosted-ACL parity lane, which applies this migration from Production's legacy ACL shape.

**PostgreSQL 17.11.** Production stayed on PostgreSQL 17.6 throughout the rollout, so the contingency below never arose. Supabase makes 17.11 available from 2026-09-28, and the project owner starts the upgrade. It hardens `tsvector` length limits, and would affect the canonical and wrapper forms identically. The plan had been that if Production was upgraded before this rollout, step 3 would be repeated, including the read-only run of the real file, because its semantic check re-validates every stored vector on the new version. No 17.11 image was available for an exact-version local reproduction when this was prepared.

**Rollback — reference only; none has been performed, and this section authorizes none.** In Production there is nothing to roll back: the no-op branch changed no schema object. The ledger row remains, recording that the canonicalization check ran. On a replayed database the former wrapper expression could be restored with another `SET EXPRESSION`, a rewrite with the same values, but that would reintroduce the dual representation C54 removes, so it needs its own decision.

### 6.16 `20260927214838` (retire the three obsolete `immutable_english_tsvector_*` wrappers, C55) — migration-only; COMPLETE: applied 2026-09-28

> **Status — COMPLETE. The migration-only rollout finished on 2026-09-28 and C55 is live in Production. It dropped exactly the three wrappers. The migration-ledger entry and the removal of those three function objects were the only durable database changes. Do not re-run the migration as a pending step. No rollback has been performed.**
>
> - **Merged.** PR #315 as the two-parent commit `6d17f68c62d8531ef10ef831453da7f09208b0c2` (parents `6355badc` and the approved head `12ce5fdb`; tree `adf18c46`, identical to the approved head's). The source branch `db/retire-immutable-tsvector-wrappers` is preserved, but it is no longer pending work.
> - **Hosted CI.** Merged-`main` on `6d17f68c`: Validate (run `36383622064`), DB Tests (`36383621892`) and Extension (`36383621874`) passed. `E2E (local)` does not run on a push to `main` ([README](../README.md#ci)); its evidence for this change is the pull-request run on the exact approved head `12ce5fdba034c3bf1dd3714601877e6149a4a032`, run `36355827464`, which passed.
> - **Before — verified read-only at preparation, again after the merge, and again immediately before the apply** (step 3):
>   - PostgreSQL 17.6; ledger **94**, latest `20260927161343` (C54); `20260927214838` absent.
>   - The three wrappers present: OIDs `66407` (`text`), `66408` (`textarr`) and `66409` (`jsonb`); bodies `26edc211…` / `19261084…` / `30c015cd…`; `{"search_path=pg_catalog, pg_temp"}`; the explicit hosted ACL; zero dependents or references on every surface (no `cron.job` table exists).
>   - `public`: 46 functions, five of them PUBLIC-executable (the three wrappers, `set_updated_at()` and `update_updated_at_column()`).
>   - `search_vector` F1 `8ddd960b…` (attrdef `59954`), calling exactly `setweight(tsvector,"char")`, `to_tsvector(regconfig,text)` and `tsvector_concat(tsvector,tsvector)`. `idx_papers_search_vector` `61100` / `61100`, valid, ready and live. `papers` `17492` / `59955`, TOAST `59958`.
>   - Security Advisor: 24 × `authenticated_security_definer_function_executable`, 6 × `rls_enabled_no_policy` and 1 leaked-password warning, none naming a wrapper.
> - **Read-only preflight — the merged file's §0–§1.** The merged file up to the section-2 banner, with only its `BEGIN;` replaced by `BEGIN TRANSACTION READ ONLY;`, ended by `ROLLBACK`. No DDL was sent. Every precondition passed:
>   - it ran as `postgres` with both transaction-local settings in effect;
>   - it resolved the targets to `{66407,66408,66409}` and built the 16-category snapshot;
>   - it held only ACCESS SHARE on catalogs and nothing on any `public` relation, and was never assigned a transaction ID.
> - **What was run — migration only, exactly as planned.**
>   - `supabase migration list --linked` showed local and remote aligned through `20260927161343`, exactly one local-only migration, `20260927214838`, and no remote-only one.
>   - `supabase db push --linked --dry-run` listed exactly `20260927214838_retire_immutable_english_tsvector_wrappers.sql`, with no seeds and no roles.
>   - From a checkout whose tree is identical to the merge commit's, `npx supabase db push --linked --yes` (Supabase CLI 2.111.0) then applied exactly that file, between the pre-apply fingerprint at 06:22:05Z and the post-apply fingerprint at 06:23:01Z UTC. It exited 0 and reported no seeds and no roles.
>   - Ledger **94 → 95**, latest `20260927214838`, present exactly once (name `retire_immutable_english_tsvector_wrappers`). Each of its ten recorded statements appears verbatim in the merged file, among them exactly the three `DROP FUNCTION … RESTRICT`. `supabase migration list --linked` now shows local and remote aligned through `20260927214838` (95 / 95).
>   - This was the rollout's only intentional Production mutation.
>     - No Edge Function was deployed. All six functions' versions and last-update times predate the rollout; the latest are `analyze-paper` v33 and `suggest-paper-organization` v16, both from 2026-09-25.
>     - The rollout created no temporary object, wrote no application row and ran no canary.
> - **No manual Vercel action.** None was part of the database rollout, and none was needed. This record makes no claim about any Vercel deployment.
> - **After — verified read-only immediately after the apply, again three minutes later, and again on 2026-09-28 for the documentation reconciliation:**
>   - PostgreSQL 17.6; ledger **95**, latest `20260927214838`, present exactly once.
>   - The three signatures no longer resolve (`to_regprocedure` returns NULL), OIDs `66407`–`66409` no longer exist, no function of those names exists in any schema, and no `pg_depend` row refers to the old OIDs.
>   - `public`: **43** functions; exactly two PUBLIC-executable, `set_updated_at()` and `update_updated_at_column()`, both unchanged.
>   - A fingerprint taken immediately before and after the apply differed only in the ledger and the three targets. Identical before and after:
>     - the migration's own 16-category snapshot: every other function, `public` relations and their ACLs, columns and their ACLs, defaults, constraints, indexes, policies, triggers, rules, types, default privileges, the `public` schema, event triggers, the search column and the search index;
>     - the xmins of every non-target function, database-wide, and of every `public` catalog row;
>     - `search_vector`: F1 `8ddd960b…`, attrdef `59954` (xmin `6791`) and its dependency rows, the direct call set, and weights A/B/C/C/C/D;
>     - `papers` `17492` / `59955` (`pg_class` xmin `11363`), TOAST `59958`, and all seven `papers` indexes' OIDs, relfilenodes and xmins, `idx_papers_search_vector` (`61100` / `61100`, valid, ready, live) included;
>     - `pg_statistic` for `papers`, and every `public` table's cumulative write counters.
>   - **No table or index rewrite and no application-data write.** The migration's own postconditions, checked inside its transaction before COMMIT, found no lock of any mode on a `public` relation and no application row written.
>   - **PostgREST.** The schema cache refreshed automatically through the drop event trigger; **no manual `NOTIFY pgrst` was needed or sent**. A bounded anonymous call to `POST /rest/v1/rpc/immutable_english_tsvector_text` with a fixed input answered **200** before the rollout and **404 `PGRST202`** ("Could not find the function … in the schema cache") after. That is the intended response for a retired RPC, not an application error. Production's OpenAPI document requires a secret API key, so the anonymous probe, not an OpenAPI listing, was the observation.
>   - **Generated types.** Linked generation (`supabase gen types typescript --linked --schema public`, written to a scratch file only) contains no wrapper entry and is semantically identical to the committed `types.ts`. It differs only in formatting: an `__InternalSupabase { PostgrestVersion: "14.5" }` block and optional parentheses in helper generics.
>   - **Security Advisor unchanged:** the same 31 findings as before (24 × lint 0029, 6 × `rls_enabled_no_policy`, 1 leaked-password), none naming a wrapper. None was expected to change, since the wrappers were SECURITY INVOKER.

**What the migration does** (C55). It drops exactly `public.immutable_english_tsvector_text(text)`, `public.immutable_english_tsvector_textarr(text[])` and `public.immutable_english_tsvector_jsonb(jsonb)`, each by complete signature with `RESTRICT`, and nothing else. Fail-closed preconditions run before the drops:
- the exact reviewed contract of each target, including its body digest and one of the two reviewed ACL forms;
- no same-named function in any schema;
- no dependency or reference of any kind: `pg_depend`, stored node trees, function-OID catalog columns and routine-body text;
- `search_vector` at C54's canonical `8ddd960b…`, with its exact dependencies and calls;
- the search index valid, ready and live;
- 46 `public` functions, exactly five of them PUBLIC-executable.

Postconditions run before COMMIT:
- the three targets are gone, and every other function is unchanged;
- every `public` relation, column, default, constraint, index, policy, trigger, rule, type, default privilege and event trigger is unchanged;
- `public` holds 43 functions, exactly two of them PUBLIC-executable;
- no lock on any `public` relation, and no application row written.

**Production effect — projected before the rollout, and observed** (see the status box; the lock footprint was measured locally, and in Production the migration's own postcondition proved no `public` relation was locked):
- ledger **94 → 95**, latest `20260927214838`;
- exactly three function drops, taking ACCESS EXCLUSIVE on the three function objects only;
- **no lock on `papers`** or any other relation;
- no table rewrite, no index rebuild, no ANALYZE and no application-data write;
- `search_vector` (`8ddd960b…`) and `idx_papers_search_vector` physically unchanged.

The DROP fires the platform's `sql_drop` event trigger (`pgrst_drop_watch`), so PostgREST reloads its schema cache; in Production it did so automatically on 2026-09-28. Afterwards `POST /rest/v1/rpc/immutable_english_tsvector_*` no longer resolves and answers 404 `PGRST202`, locally and in Production. No application, extension or Edge code calls those RPCs. Security Advisor counts were not expected to change, and did not: the wrappers were INVOKER, and no lint named them.

**Why there was no ordering constraint.** No Edge Function, frontend step or drain was involved. The committed generated types had already lost the three RPC entries (−6 lines) at the merge, and no handwritten code references them, so the frontend was correct before and after the rollout.

**Procedure — EXECUTED 2026-09-28; kept as the reference procedure; not a pending step.** These are the steps as written before the rollout. The `expect` values in step 3 are the **pre-rollout** state it was checked against. What was actually observed and run is the status box above, restated per step below.
1. Independently approve the exact PR head. Merge it with a normal two-parent merge commit.
2. Wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. `E2E (local)` is not a merged-`main` check; its evidence is the pull-request run on the exact approved head.
3. Fresh read-only preflight against Production. These are the pre-rollout expectations. After the rollout, the second query returns `95`, `20260927214838` and `1`, the wrapper query returns no rows, and `public_fns` is `43`; the other values are unchanged.

   ```sql
   BEGIN; SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog, pg_temp;
   SELECT current_setting('server_version') AS pg;                                   -- expect 17.6 unless independently upgraded
   SELECT count(*) AS ledger, max(version) AS latest,                                -- expect 94, 20260927161343
          count(*) FILTER (WHERE version = '20260927214838') AS c55_present         -- expect 0
     FROM supabase_migrations.schema_migrations;
   SELECT p.oid, p.oid::regprocedure AS sig, md5(p.prosrc) AS body, p.proconfig, p.proacl::text AS acl,
          (SELECT count(*) FROM pg_depend d WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid) AS dependents
     FROM pg_proc p WHERE p.proname LIKE 'immutable_english_tsvector%' ORDER BY 2;
     -- expect exactly three rows: 66409 jsonb 30c015cd…, 66407 text 26edc211…, 66408 textarr 19261084…;
     -- {"search_path=pg_catalog, pg_temp"}; the explicit hosted ACL; 0 dependents each
   SELECT md5(pg_get_expr(d.adbin, d.adrelid)) AS search_vector_expr                 -- expect 8ddd960b4f4b11dd7afd35485d01fd25
     FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector';
   SELECT c.oid, c.relfilenode, c.xmin::text AS class_xmin                           -- record: papers, idx_papers_search_vector
     FROM pg_class c WHERE c.oid IN ('public.papers'::regclass, 'public.idx_papers_search_vector'::regclass);
   SELECT count(*) AS public_fns FROM pg_proc WHERE pronamespace = 'public'::regnamespace;   -- expect 46
   ROLLBACK;
   ```
   Then run the **real migration file's §0 and §1** read-only, with no DDL sent. Take the file from its first line up to, but not including, the section-2 banner. Replace its `BEGIN;` with `BEGIN TRANSACTION READ ONLY;`. Append a final `SELECT current_setting('transaction_read_only'), current_setting('paperlume.retire_tsvector_wrappers.targets', true);` and `ROLLBACK;`. Run it with `supabase db query --linked -f`. It must return `on` and the three target OIDs, which means every precondition passed. **If any value differs or any check refuses, stop and re-review; do not edit the migration to fit.** *Observed:* every step-3 value matched immediately before the apply, and the §0–§1 run passed every precondition, returning `on` and `{66407,66408,66409}` with no transaction ID assigned.
4. `supabase migration list --linked` must show exactly one local-only migration, `20260927214838`, and no remote-only one. Then run `supabase db push --dry-run` from the merge commit. It must list **exactly** `20260927214838_retire_immutable_english_tsvector_wrappers.sql`, with no seeds and no roles. Anything else, stop (§6.2). *Observed:* local and remote aligned through `20260927161343`, exactly that one local-only migration and no remote-only one, and a dry run that listed exactly that file, with no seeds and no roles.
5. Obtain the separate, explicit rollout authorization. *Obtained before the apply.*
6. Apply exactly that migration through the normal linked workflow: `supabase db push --linked` (ledger **94 → 95**). The file is explicitly transactional; a refusal rolls it back with nothing changed. *Executed as `npx supabase db push --linked --yes` (CLI 2.111.0) between 06:22:05Z and 06:23:01Z UTC; it exited 0, applied exactly that one file, and the ledger went **94 → 95**.*
7. Verify immediately, read-only (the expected values below are the live state since 2026-09-28, and were observed exactly):
   - ledger **95**, latest `20260927214838`, present exactly once;
   - no function named `immutable_english_tsvector_%` in any schema;
   - `public` holds **43** functions, and its PUBLIC-executable set is exactly `set_updated_at()` and `update_updated_at_column()` *(superseded later on 2026-09-28 by C56, §6.17: both are now owner-only, and the PUBLIC-executable set is empty)*;
   - `search_vector_expr` is still `8ddd960b…`, and `papers` and `idx_papers_search_vector` keep the OIDs, relfilenodes and `pg_class` xmins recorded in step 3;
   - Edge Function versions are unchanged;
   - optionally, an anonymous `POST /rest/v1/rpc/immutable_english_tsvector_text` returns 404 `PGRST202`. *Observed:* no Edge Function was deployed, and all six versions and last-update times predate the rollout. The anonymous call answered 404 `PGRST202`; the same call had answered 200 before the rollout.

**No canary was run, and none was required.** No application behaviour depended on the wrappers. The drop is covered in CI against a full replay: suites `007`, `015`, `022`, `023` and `024`, plus the hosted-ACL parity lane, which applies this migration from Production's explicit ACL shape.

**Rollback — forward only; none has been performed, and this section authorizes none.** Do not edit the applied migration, and do not `migration repair` a legitimate application of it. If an unforeseen consumer appears after the rollout, write a **new** forward migration. It re-creates the exact reviewed definitions (bodies and attributes in `20260331010000`, `search_path = pg_catalog, pg_temp` per `20260927001229`) and restates the intended EXECUTE ACL explicitly. The ACL a plain `CREATE FUNCTION` receives depends on the environment's default privileges, so it must not be left to them. That needs its own decision against C55.

### 6.17 `20260928133918` (owner-only updated_at trigger functions and default-deny function EXECUTE, C56) — migration-only; COMPLETE: applied 2026-09-28

> **Status — COMPLETE. The migration-only rollout finished on 2026-09-28 and C56 is live in Production. The migration-ledger entry, the two functions' ACLs and `postgres`'s two function default-privilege entries were the only durable database changes. Do not re-run the migration as a pending step. No rollback has been performed.**
>
> - **Merged.** PR #317 as the two-parent commit `f5bb0c3dfeab160e958a64e8101305d938f57ddb` (parents `2659c0e9` and the approved head `82620e6e`; tree `b915322d`, identical to the approved head's). The source branch `db/default-function-execute-hardening` is preserved, but it is no longer pending work.
> - **Hosted CI.** Merged-`main` on `f5bb0c3d`:
>   - Validate (run `36448022375`) and Extension (`36448022372`) passed.
>   - DB Tests (`36448022378`) failed on attempt 1 inside `supabase start`, while bringing up the ephemeral stack and before any migration replay or test. The lifecycle suppresses that command's raw output because it can contain local credentials. This is the documented bring-up transient ([pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md) §16.4).
>   - Attempt 2 on the same SHA passed: 26 files / 2,383 pgTAP assertions, the hosted-ACL parity convergence, NC4 and NC7. The pull-request run on the identical tree had already passed `supabase start` and the full lifecycle.
>   - `E2E (local)` does not run on a push to `main` ([README](../README.md#ci)); its evidence for this change is the pull-request run on the exact approved head `82620e6e47ef00e7b2de23e3ee9160957a930147`, run `36440511161`, which passed (257 tests).
> - **Before — verified read-only at preparation, and again after the merge immediately before the apply** (step 3, 16:13Z UTC):
>   - PostgreSQL 17.6; ledger **95**, latest `20260927214838`; `20260928133918` absent.
>   - `public`: 43 functions, exactly two PUBLIC-executable: `set_updated_at()` (OID `33584`, body `301a8849…`, `{search_path=pg_catalog}`) and `update_updated_at_column()` (OID `53609`, body `ef6b2d76…`, `{search_path=public}`). Both are SECURITY INVOKER, with the explicit hosted ACL `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`.
>   - Exactly 12 enabled triggers use them, and nothing else depends on them. The only other function of either name is `storage.update_updated_at_column()`, outside `public`.
>   - `postgres` has no global default entry. Its `public` function entry is `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`.
>   - The other 41 `public` function ACLs digest to `54a18e87…`, the same value as at preparation.
>   - Security Advisor: 24 × `authenticated_security_definer_function_executable`, 6 × `rls_enabled_no_policy` and 1 leaked-password warning, none naming either function.
> - **Read-only preflight — the merged file's §0–§1.** The merged file up to the section-2 banner, with only its `BEGIN;` replaced by `BEGIN TRANSACTION READ ONLY;`, ended by `ROLLBACK`. No privilege statement was sent. Every precondition passed:
>   - it ran as `postgres` with the transaction-local settings in effect;
>   - it resolved the targets to `{33584,53609}` and recognised the hosted `public` entry;
>   - it was never assigned a transaction ID.
>
>   The temporary copy was deleted afterwards.
> - **What was run — migration only, exactly as planned.**
>   - `supabase migration list --linked` showed local and remote aligned through `20260927214838`, exactly one local-only migration, `20260928133918`, and no remote-only one.
>   - `supabase db push --linked --dry-run` listed exactly `20260928133918_harden_default_function_execute.sql`, with no seeds and no roles.
>   - From a checkout at the merge commit, `npx supabase db push --linked --yes` (Supabase CLI 2.111.0) applied exactly that file between 16:16:26Z and 16:17:01Z UTC. It exited 0 and reported no seeds and no roles.
>   - Ledger **95 → 96**, latest `20260928133918`, present exactly once (name `harden_default_function_execute`). Each of its 13 recorded statements appears verbatim in the merged file. `supabase migration list --linked` now shows local and remote aligned through `20260928133918` (96 / 96).
>   - This was the rollout's only intentional Production mutation.
>     - No Edge Function was deployed. All six functions' versions and last-update times are unchanged and predate the rollout; the latest are `analyze-paper` v33 and `suggest-paper-organization` v16, both from 2026-09-25.
>     - The migration's scratch schema `zz_c56_default_probe` and its probe objects were created and dropped inside the migration's own transaction. No application row was written and no canary was run.
> - **No manual Vercel action.** None was part of the database rollout, and none was needed. Vercel's Git integration created its usual Production deployment for the merge commit (GitHub deployment `6714545827`, success). C56 changes no frontend code, so nothing depends on that deployment's ordering.
> - **After — verified read-only immediately after the apply (16:17Z UTC onward):**
>   - PostgreSQL 17.6; ledger **96**, latest `20260928133918`, present exactly once.
>   - Both functions are exactly `{postgres=X/postgres}`. `anon`, `authenticated`, `service_role` and `authenticator` hold no effective EXECUTE on either. Their OIDs, bodies, owner, language, return type, security mode, volatility, parallel setting and `proconfig` are unchanged: each whole `pg_proc` row apart from its ACL is identical.
>   - `public`: still **43** functions, and **none** is PUBLIC-executable (2 → 0).
>   - `postgres`'s global function entry is exactly `f={postgres=X/postgres}`, and its `public` function entry is `{postgres=X/postgres,service_role=X/postgres}`. The platform's `service_role` entry was preserved. Every other default-privilege entry is identical.
>   - The twelve triggers are identical row for row, and all are enabled.
>   - The other 41 `public` function ACLs are identical one by one (digest `54a18e87…`), and so are their whole rows. Every other function ACL in the database is identical, and so is the database-wide function count.
>   - No `zz_c56_default_probe` schema remains, no `zz_` object of any kind exists, and every schema is unchanged.
>   - **Data API.** An anonymous `GET /rest/v1/rpc/set_updated_at` and `…/rpc/update_updated_at_column` answered **404 `PGRST202`**, exactly as they did before C56: PostgREST excludes trigger functions.
>   - **Generated types.** Linked generation (`supabase gen types typescript --linked --schema public`, written to a scratch file only) is semantically identical to the committed `types.ts`. It differs only in formatting: an `__InternalSupabase` PostgREST-version block and optional helper-generic parentheses.
>   - **Security Advisor unchanged:** the identical 31 findings (24 × 0029, 6 × `rls_enabled_no_policy`, 1 leaked-password), none naming either function, as expected for SECURITY INVOKER functions.

**What the migration does** (C56). Exactly four privilege statements, and nothing else:
- `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` on `public.set_updated_at()` and on `public.update_updated_at_column()`;
- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` (global);
- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated`. `service_role`'s default entry is deliberately not named.

Fail-closed preconditions run before the change:
- both functions' exact contract, body digest, `search_path`, and one reviewed ACL form: `NULL`, or the explicit hosted five-entry form;
- exactly the reviewed twelve triggers, and no other dependent;
- 43 `public` functions, exactly two PUBLIC-executable;
- no global `postgres` default entry;
- the `postgres`/`public` function entry is exactly the hosted four-role literal or the owner-only literal.

Verification runs before COMMIT:
- both functions `{postgres=X/postgres}`, directly and effectively;
- no PUBLIC-executable `public` function;
- one global entry `f={postgres=X/postgres}`;
- the `public` entry lost only `anon` and `authenticated`;
- real-object default probes in `public` and in a fresh schema;
- an in-transaction probe in which `authenticated`, holding no EXECUTE, fires both hardened functions through scratch triggers, while a direct call is refused with `42501`;
- a whole-surface snapshot showing nothing else moved;
- no lock on a `public` relation, and no application row written.

The probe objects live in one scratch schema, `zz_c56_default_probe`, created and dropped inside the transaction.

**Production effect — projected before the rollout, and observed** (see the status box; in Production the migration's own postconditions also proved, before COMMIT, that no `public` relation was locked and no application row was written):
- ledger **95 → 96**, latest `20260928133918`;
- catalog writes only:
  - the two functions' ACLs become `{postgres=X/postgres}`;
  - one global `pg_default_acl` row for `postgres`, `f={postgres=X/postgres}`, is added;
  - the `postgres`/`public` function entry becomes `{postgres=X/postgres,service_role=X/postgres}` (the platform's `service_role` entry is kept);
- `public` keeps 43 functions, now with **zero** PUBLIC-executable; the other 41 function ACLs are unchanged;
- no lock on any `public` relation, no table rewrite and no application-data write.

The Data API surface does not change: PostgREST already excludes trigger functions, so `rpc/set_updated_at` answers `404 PGRST202` before and after, and did in Production after the rollout. The privilege DDL may prompt a routine PostgREST schema-cache reload through the platform's event trigger. Security Advisor counts were not expected to change, since neither function is SECURITY DEFINER, and did not.

**Operational consequence — in force since 2026-09-28.** A function `postgres` creates — in a migration, in the SQL editor, or as a member of an extension `postgres` installs itself — is owner-only (plus `service_role` in `public`) until explicitly granted. **Enabling Supabase Queues (`pgmq`) is the proven case needing review:** under this default, 39 of its 40 functions lose PUBLIC EXECUTE. Supautils-privileged and trusted extensions install as `supabase_admin` and are unaffected. Existing functions keep their ACLs.

**Why there was no ordering constraint.** No Edge Function, frontend step or drain was involved. No application code calls either function directly, and their triggers keep firing for every writer.

**Procedure — EXECUTED 2026-09-28; kept as the reference procedure; not a pending step.** These are the steps as written before the rollout. The `expect` values in step 3 are the **pre-rollout** state it was checked against. What was actually observed and run is the status box above, restated per step below.
1. Independently approve the exact PR head. Merge it with a normal two-parent merge commit. *Observed:* merged as `f5bb0c3d`, parents `2659c0e9` and the approved head `82620e6e`.
2. Wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. `E2E (local)` is not a merged-`main` check; its evidence is the pull-request run on the exact approved head. *Observed:* Validate and Extension passed. DB Tests hit the `supabase start` bring-up transient on attempt 1 and passed on attempt 2 of the same SHA. The rollout waited for that green run.
3. Fresh read-only preflight against Production. These are the pre-rollout expectations. After the rollout, the second query returns `96`, `20260928133918` and `1`. Both ACLs read `{postgres=X/postgres}`. The default query shows a `<GLOBAL>` `f` row `{postgres=X/postgres}` and `public` `f` = `{postgres=X/postgres,service_role=X/postgres}`. The other values are unchanged:

   ```sql
   BEGIN; SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog, pg_temp;
   SELECT current_setting('server_version') AS pg;                                   -- expect 17.6 unless independently upgraded
   SELECT count(*) AS ledger, max(version) AS latest,                                -- expect 95, 20260927214838
          count(*) FILTER (WHERE version = '20260928133918') AS c56_present         -- expect 0
     FROM supabase_migrations.schema_migrations;
   SELECT p.oid, p.oid::regprocedure AS sig, md5(p.prosrc) AS body, p.proconfig, p.proacl::text AS acl
     FROM pg_proc p WHERE p.oid IN ('public.set_updated_at()'::regprocedure, 'public.update_updated_at_column()'::regprocedure);
     -- expect 33584 301a8849… {search_path=pg_catalog} and 53609 ef6b2d76… {search_path=public},
     -- both with the explicit hosted five-entry ACL
   SELECT count(*) AS triggers FROM pg_trigger t                                     -- expect 12
    WHERE t.tgfoid IN ('public.set_updated_at()'::regprocedure, 'public.update_updated_at_column()'::regprocedure)
      AND t.tgenabled = 'O';
   SELECT CASE WHEN d.defaclnamespace = 0 THEN '<GLOBAL>' ELSE d.defaclnamespace::regnamespace::text END AS nsp,
          d.defaclobjtype, d.defaclacl::text
     FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole ORDER BY 1, 2;
     -- expect no <GLOBAL> row; public f = {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
   SELECT count(*) AS public_fns FROM pg_proc WHERE pronamespace = 'public'::regnamespace;   -- expect 43
   ROLLBACK;
   ```
   Then run the **real migration file's §0 and §1** read-only, with no DDL sent. Take the file from its first line up to, but not including, the section-2 banner. Replace its `BEGIN;` with `BEGIN TRANSACTION READ ONLY;`. Append a final `SELECT current_setting('transaction_read_only'), current_setting('paperlume.default_function_execute.targets', true);` and `ROLLBACK;`. Run it with `supabase db query --linked -f`. It must return `on` and the two target OIDs, which means every precondition passed. **If any value differs or any check refuses, stop and re-review; do not edit the migration to fit.** If Supabase has changed its platform function defaults in the meantime (its 2026-10-30 existing-project rollout is announced for tables and sequences), the preconditions decide. The owner-only `public` entry that Supabase's documented opt-in produces is an accepted shape; anything else stops the file. *Observed:* every step-3 value matched immediately before the apply. The §0–§1 run passed every precondition, returning `on` and `{33584,53609}` with no transaction ID assigned.
4. `supabase migration list --linked` must show exactly one local-only migration, `20260928133918`, and no remote-only one. `supabase db push --dry-run` must list **exactly** `20260928133918_harden_default_function_execute.sql`, with no seeds and no roles. Anything else, stop (§6.2). *Observed:* local and remote aligned through `20260927214838`, exactly that one local-only migration and no remote-only one. The dry run listed exactly that file, with no seeds and no roles.
5. Obtain the separate, explicit rollout authorization. *Obtained in advance:* the owner authorized the merge and this rollout together as one sequential task (`DB-DEFAULT-FUNCTION-EXECUTE-HARDENING-001B`), conditional on every gate above passing.
6. Apply exactly that migration through the normal linked workflow: `supabase db push --linked` (ledger **95 → 96**). The file is explicitly transactional; a refusal rolls it back with nothing changed. *Executed as `npx supabase db push --linked --yes` (CLI 2.111.0) between 16:16:26Z and 16:17:01Z UTC. It exited 0, applied exactly that one file, and the ledger went **95 → 96**.*
7. Verify immediately, read-only (the expected values below are the live state since 2026-09-28, and were observed exactly):
   - ledger **96**, latest `20260928133918`, present exactly once;
   - both functions `{postgres=X/postgres}`;
   - `postgres`'s global entry exactly `f={postgres=X/postgres}`;
   - the `public` function entry `{postgres=X/postgres,service_role=X/postgres}`;
   - `public` holds 43 functions and none is PUBLIC-executable;
   - the twelve triggers are unchanged and enabled;
   - the other 41 function ACLs are unchanged (the migration's §3 snapshot proves this before COMMIT; an `md5` of their ACLs taken in step 3 and again here confirms it independently);
   - no `zz_c56_default_probe` schema exists;
   - Security Advisor counts are unchanged;
   - Edge Function versions are unchanged;
   - optionally, an anonymous `GET /rest/v1/rpc/set_updated_at` still returns 404 `PGRST202`. *Observed:* every item above held. The other 41 ACLs matched the step-3 digest `54a18e87…` one by one. The Advisor's 31 findings were identical. All six Edge Functions kept their versions and update times. Both anonymous RPC calls answered 404 `PGRST202`.

   An authenticated browser-path UPDATE on an acceptance-owned row, advancing its `updated_at`, is the natural end-to-end check. The migration's own trigger probe already proves the mechanism in Production, so this check is optional and needs its own authorization. **It was not run: no application row was modified for this rollout.** The in-transaction probe passed before COMMIT, which is what let the migration commit.

**Rollback — forward only; none has been performed, and this section authorizes none.** Do not edit the applied migration, and do not `migration repair` a legitimate application of it. A reversal is a **new** forward migration:
- re-GRANT the intended EXECUTE on the two functions explicitly;
- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC`, which deletes the global entry again (verified locally);
- the per-schema `GRANT EXECUTE ON FUNCTIONS TO anon, authenticated` in `public`.

That needs its own decision against C56.

---

---

### 6.18 `20260929084252` (`service_role` least privilege, C57) — migration-only; COMPLETE — APPLIED TO PRODUCTION 2026-09-29

> **Status — COMPLETE — APPLIED TO PRODUCTION 2026-09-29. The migration-only rollout finished on 2026-09-29 and C57 is live in Production. The migration-ledger entry, 21 relation ACLs and `postgres`'s three `public` default-privilege entries were the only durable database changes. Do not re-run the migration as a pending step. No rollback has been performed.**
>
> - **Merged.** PR #322 as the two-parent commit `3a3e095725ffdbeb6302c88c40b18019583d8b8a` (parents `4e8bc485` and the approved head `f5c81c12`; tree `0d3e5e6a`, identical to the approved head's). The source branch `db/service-role-least-privilege-hardening` is preserved, but it is no longer pending work.
> - **Hosted CI.** Merged-`main` on `3a3e0957`, all passing on attempt 1:
>   - Validate (run `36566019632`);
>   - Extension (`36566019690`);
>   - DB Tests (`36566019711`). It covered 27 files / 2,425 pgTAP assertions, the hosted-ACL parity lane with NC4 and NC7, and the starting-shape lane with SR-NC1–7 and R, H and P converging.
>
>   `E2E (local)` does not run on a push to `main` ([README](../README.md#ci)). Its evidence for this change is the pull-request run on the exact approved head `f5c81c120fc2ac9720f21d384ec359058e52fbd4`, run `36562500879`, which passed 260 tests, including an end-to-end account deletion.
> - **Before — verified read-only after the merge, immediately before the apply** (12:15–12:24Z UTC):
>   - PostgreSQL 17.6; ledger **96**, latest `20260928133918`; `20260929084252` absent.
>   - `service_role`:
>     - all eight privileges on the 20 tables;
>     - `INSERT` only on `ai_provider_usage_events`, and nothing on the other 8 tables;
>     - `USAGE`, `SELECT` and `UPDATE` on `papers_insert_order_seq`;
>     - EXECUTE on exactly `refund_ai_quota(uuid)` (body `4224750d…`, ACL `{postgres=X/postgres,service_role=X/postgres}`).
>   - `postgres`'s `public` entries were `S={postgres=rwU/postgres,service_role=rwU/postgres} f={postgres=X/postgres,service_role=X/postgres} r={postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`, which is shape **H**. A read-only catalog fingerprint was identical to the captures taken earlier that day.
>   - Edge Functions, all ACTIVE: `analyze-paper` v33, `delete-account` v6, `fetch-paper-metadata` v23, `get-gemini-provider-quota` v9, `search-pubmed` v6, `suggest-paper-organization` v16. Each `ezbr_sha256` was recorded.
>   - Security Advisor: 24 × `authenticated_security_definer_function_executable`, 6 × `rls_enabled_no_policy` and 1 leaked-password warning.
> - **Read-only preflight — the merged file's §0–§1.** The merged file's statements after its `BEGIN;`, through the end of §1, ran verbatim inside `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`, and no privilege statement was sent. It ran as `postgres` with the transaction-local settings in effect. Every precondition passed, and it classified Production as shape **H**. Its invariant snapshot hashed to md5 `620202f9…`.
> - **What was run — migration only, exactly as planned.**
>   - `supabase migration list --linked` showed local and remote aligned through `20260928133918` (96 paired), exactly one local-only migration, `20260929084252`, and no remote-only one.
>   - `supabase db push --linked --dry-run` listed exactly `20260929084252_harden_service_role_least_privilege.sql`, with no seeds and no roles.
>   - From a clean checkout of `main` at the merge commit, `npx supabase db push --linked --yes` (Supabase CLI 2.111.0) applied exactly that file between 12:25:46Z and 12:26:07Z UTC. It exited 0 and reported no seeds and no roles.
>   - Ledger **96 → 97**, latest `20260929084252`, present exactly once (name `harden_service_role_least_privilege`, 14 recorded statements).
>   - This was the rollout's only intentional Production mutation.
>     - No Edge Function was deployed, and no secret, Auth, Storage or PostgreSQL version change was made.
>     - The `zz_c57_probe_*` table, identity sequence and function were created and dropped inside the migration's own transaction.
>     - No application row was written, and no canary was run.
> - **No manual Vercel action.** None was part of the database rollout, and none was needed. Vercel's Git integration created its usual Production deployment for the merge commit: `dpl_Ggp1PTZW1vQEG4ZX5ymFByhjp8oT`, READY, target production, aliased to `app.paperlume.app`; GitHub deployment `6734275874` for `3a3e0957`, success. C57 changes no frontend code.
> - **After — verified read-only immediately after the apply (12:29Z UTC), and again the same day for the documentation reconciliation:**
>   - Ledger **97**, latest `20260929084252`, present exactly once.
>   - `service_role`'s stored relation grants in `public` are exactly `ai_provider_usage_events:INSERT` (granted by `postgres`, no grant option), and so are its effective ones.
>     - The former 20 tables and the other 8 give it nothing.
>     - It holds no column grant and reaches no column beyond that INSERT.
>   - `papers_insert_order_seq` is `{postgres=rwU/postgres,authenticated=U/postgres}`: no `service_role` `USAGE`, `SELECT` or `UPDATE`, and no `public` sequence grants it anything.
>   - `service_role` executes exactly `refund_ai_quota(uuid)`, unchanged:
>     - owner `postgres`, SECURITY DEFINER, `search_path=public, pg_temp`;
>     - body `4224750ddbff3651e7e0aaa2576f4de4`;
>     - ACL `{postgres=X/postgres,service_role=X/postgres}`, and it is not executable by PUBLIC, anon or `authenticated`.
>
>     The telemetry ACL is unchanged: `{postgres=arwdDxtm/postgres,service_role=a/postgres}`.
>   - `postgres`'s `public` default entries are owner-only: `S={postgres=rwU/postgres} f={postgres=X/postgres} r={postgres=arwdDxtm/postgres}`.
>     - Its global entry is still `f={postgres=X/postgres}` (C56).
>     - Every other default-privilege entry is identical, `supabase_admin`'s included.
>   - `service_role` has `USAGE` and no `CREATE` on `public`. Its attributes and memberships are unchanged.
>   - No `zz_c57_probe_*` object exists.
>   - The migration's own invariant snapshot, re-executed read-only, is byte-identical to the preflight's (`620202f9…`). It covers:
>     - the client-role matrix;
>     - the other schemas' relation ACLs;
>     - relations, columns, constraints, indexes, policies and triggers;
>     - whole function rows and every function ACL;
>     - types, schemas and the database ACL;
>     - roles, memberships and event triggers.
>   - The read-only catalog fingerprint changed only in the ledger, the relation ACLs (the 163 removed `service_role` entries: 20 × 8 plus 3) and the three default entries above. These are all identical:
>     - every row count;
>     - the account-deletion path: 39 foreign keys, and the only AFTER DELETE trigger, `refund_storage_quota()`, still SECURITY DEFINER;
>     - the platform `storage` grants;
>     - the `auth` ACLs.
>   - All six Edge Functions have the same versions, IDs, `ezbr_sha256` and update times.
>   - **Security Advisor unchanged:** the identical 31 findings (24 × 0029, 6 × `rls_enabled_no_policy`, 1 leaked-password).
> - **Runtime.** No Production AI canary and no Production account-deletion canary was run. Runtime safety rests on four things:
>   - the two retained grants being byte-identical;
>   - the migration's in-transaction verification;
>   - the database suites;
>   - the local end-to-end run that deletes an account against the hardened schema.
>
>   When the rollout completed, no `ai_provider_usage_events` row had yet been recorded after the apply.

**What the migration does** (C57). Exactly five privilege statements:
- `REVOKE ALL … FROM service_role` on the 20 reviewed tables and on `papers_insert_order_seq`;
- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES / SEQUENCES / FUNCTIONS FROM service_role`.

`ai_provider_usage_events` (INSERT) and `refund_ai_quota(uuid)` (EXECUTE) are not named, so the two server paths keep exactly the grants they use. No client-role grant, platform schema, role attribute or membership is touched. The fail-closed preconditions, verification and accepted starting shapes (H hosted, R clean replay, P hosted after Supabase's announced default revoke) are described in C57 and in the migration header.

**Production effect — projected before the rollout, and observed** (see the status box):
- ledger **96 → 97**, latest `20260929084252`;
- catalog writes only: 21 relation ACLs lose their `service_role` entry, and `postgres`'s three `public` default entries become owner-only: `S={postgres=rwU/postgres} f={postgres=X/postgres} r={postgres=arwdDxtm/postgres}`;
- the `ai_provider_usage_events` ACL (`{postgres=arwdDxtm/postgres,service_role=a/postgres}`) and the `refund_ai_quota` ACL (`{postgres=X/postgres,service_role=X/postgres}`) are byte-identical afterwards;
- no lock on any existing `public` relation, no table rewrite and no application-data write. The in-transaction probes create and drop one table (with its identity sequence) and one function, all named `zz_c57_probe_*`.

The privilege DDL may prompt a routine PostgREST schema-cache reload through the platform's event trigger. Security Advisor counts are not expected to change, because none of its findings names `service_role`.

**Why there is no ordering constraint.** No Edge Function, secret, frontend step or drain is involved:
- no deployed function uses a revoked grant;
- `delete-account` uses Storage and Auth Admin, not `public` grants;
- the E2E fixtures that did use the grants are local-only and already re-pointed.

**Procedure — EXECUTED 2026-09-29; kept as the reference procedure; not a pending step.** These are the steps as written before the rollout. The `expect` values in step 3 are the **pre-rollout** state it was checked against. What was actually observed and run is the status box above, restated per step below.
1. Independently approve the exact PR head. Merge it with a normal two-parent merge commit. *Observed:* merged as `3a3e0957`, parents `4e8bc485` and the approved head `f5c81c12`.
2. Wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. `E2E (local)` is not a merged-`main` check; its evidence is the pull-request run on the exact approved head. *Observed:* all three passed on attempt 1, and the pull-request E2E run `36562500879` had passed.
3. Fresh read-only preflight against Production, with these expected pre-rollout values:

   ```sql
   BEGIN TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog, pg_temp;
   SELECT current_setting('server_version') AS pg;                                    -- expect 17.6 unless independently upgraded
   SELECT count(*) AS ledger, max(version) AS latest,                                 -- expect 96, 20260928133918
          count(*) FILTER (WHERE version = '20260929084252') AS c57_present          -- expect 0
     FROM supabase_migrations.schema_migrations;
   SELECT c.relname, a.privilege_type
     FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'service_role'::regrole
    ORDER BY 1, 2;                                                                    -- expect 20 tables x 8, the sequence x 3, telemetry INSERT
   SELECT p.oid::regprocedure FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('service_role', p.oid, 'EXECUTE');
                                                                                      -- expect exactly refund_ai_quota(uuid)
   SELECT md5(prosrc), proacl::text FROM pg_proc WHERE oid = 'public.refund_ai_quota(uuid)'::regprocedure;
                                                                                      -- expect 4224750d…, {postgres=X/postgres,service_role=X/postgres}
   SELECT d.defaclobjtype, d.defaclacl::text FROM pg_default_acl d
    WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace ORDER BY 1;
                                                                                      -- expect shape H: S rwU, f X, r arwdDxtm for service_role
   SELECT current_setting('transaction_read_only') AS ro;                             -- expect on
   ROLLBACK;
   ```

   Then run the merged file's §0–§1 read-only: the file up to the section-2 banner, with its `BEGIN;` replaced by `BEGIN TRANSACTION READ ONLY;` and ended by `ROLLBACK;`. Every precondition must pass and report starting shape **H**, or **P** if Supabase's announced default revoke has landed by then. A refusal means stop and re-review; never edit the migration to fit. *Observed:* every expectation above held, and the preconditions passed with shape **H**. After the rollout:
   - the second query returns `97`, `20260929084252` and `1`;
   - the third returns only `ai_provider_usage_events | INSERT`;
   - the default query shows the three owner-only entries.
4. `supabase migration list --linked`: local and remote aligned through `20260928133918`, exactly one local-only migration (`20260929084252`), no remote-only one. `supabase db push --linked --dry-run` must list exactly that file, with no seeds and no roles. *Observed:* exactly so.
5. From a checkout at the merge commit, `npx supabase db push --linked --yes`, migration only. No Edge Function deploy, no secret change, no Auth, Storage or Vercel change. *Executed* with Supabase CLI 2.111.0, 12:25:46Z–12:26:07Z UTC, exit 0, exactly `20260929084252`. It ran under the owner's authorization for the merge and the rollout as one sequential task (`SERVICE-ROLE-LEAST-PRIVILEGE-HARDENING-001B`).
6. After, read-only:
   - ledger 97, latest `20260929084252`, present once;
   - `service_role`'s stored grants in `public` are exactly `ai_provider_usage_events:INSERT`;
   - its executable `public` routines are exactly `refund_ai_quota(uuid)` with the unchanged ACL and body;
   - the three `postgres`/`public` default entries are owner-only, and every other `pg_default_acl` row is unchanged;
   - the client-role matrix and every other ACL are unchanged — the upgrade fingerprint's `relation_acl` changes only in `service_role` entries, and its `function_acl` digest is unchanged;
   - no `zz_c57_probe_*` object exists;
   - all six Edge Function versions and `ezbr_sha256` values are unchanged;
   - the Security Advisor counts are unchanged.

   *Observed:* every item above held (see the status box).
7. Runtime acceptance — observation only, no canary required. Once organic traffic produces one, a new `ai_provider_usage_events` row recorded after the apply shows the telemetry INSERT path is intact. The refund path's grant is proven by the catalog check in step 6. Account deletion's Storage grants live in the platform `storage` schema, which the migration's snapshot proves untouched. An authenticated AI canary or an account-deletion canary needs its own authorization. *Observed:* no canary was run. When the rollout completed, no post-apply telemetry row existed yet.

**Rollback — not performed; forward-only corrective migration if ever needed.** Do not edit the applied migration, and do not `migration repair` a legitimate application of it. A new migration re-grants exactly what a named server path needs — never the old broad posture wholesale without review. The pre-change effective posture could be restored with `GRANT ALL` on the 20 tables, `GRANT USAGE, SELECT, UPDATE` on the sequence and the matching `ALTER DEFAULT PRIVILEGES … GRANT` statements. The ACL text may then list entries in a different order.

---

### 6.19 `20260930161651` (contributing-field search attribution, C58) — migration-only; APPLIED / PRODUCTION-VERIFIED — 2026-09-30

> **Status — APPLIED / PRODUCTION-VERIFIED — 2026-09-30.** The migration-only rollout (`SEARCH-MATCH-ATTRIBUTION-CROSS-FIELD-001B`) finished on 2026-09-30, and C58 is live in Production. By design, and by the checks below, the only durable database changes were the migration-ledger entry and `search_papers`' body.
>
> - **Merged.** PR #325 as the two-parent commit `8a2a880c68e5263c57a3e4a7c541a8d68f1c88ac`. Its parents are `0ae11d0e` and the approved head `1b496fed4ba99ee0b5f724e967fcfe53f62fa89d`, and its tree `3809584b` is identical to the approved head's. The source branch was deleted after the rollout.
> - **Hosted CI.** Merged-`main` on `8a2a880c`, all passing on attempt 1:
>   - Validate (run `36757016310`);
>   - DB Tests (`36757016305`): 28 files / 2,530 pgTAP assertions, including suite `027`;
>   - Extension (`36757016311`).
>
>   `E2E (local)` does not run on a push to `main` ([README](../README.md#ci)). Its pull-request run on the exact approved head, `36749595519`, passed 260 tests. That lane does not include `e2e/search-attribution.spec.ts`; its cross-field case was run locally during implementation, with a red control.
> - **Before — verified read-only after the merge and merged-`main` CI, immediately before the apply:**
>   - PostgreSQL 17.6; ledger **97**, latest `20260929084252`; `20260930161651` absent.
>   - `search_papers`:
>     - body `d4a5f3afdc485d5dfda8e0798c61cc48`;
>     - one overload, owner `postgres`, `plpgsql`, SECURITY INVOKER, VOLATILE, PARALLEL UNSAFE, `search_path=public`;
>     - ACL `{postgres=X/postgres,authenticated=X/postgres}`, so `authenticated` can execute it and PUBLIC, `anon` and `service_role` cannot;
>     - nothing depends on it.
>   - Search infrastructure and RLS:
>     - `search_vector` stored expression `8ddd960b4f4b11dd7afd35485d01fd25`;
>     - `idx_papers_search_vector` valid, ready and live;
>     - `papers` RLS and FORCE RLS on, with the `papers` / `synonym_pool` policy digest `07603cbe4e78a4d6097e7ec33bd1e6c8`;
>     - `authenticated` is neither superuser nor BYPASSRLS.
>   - This catalog fingerprint was identical to one taken before the merge.
> - **Read-only preflight — the merged file's §0–§1.** The statements after the file's `BEGIN;`, through the end of §1, ran verbatim inside `BEGIN TRANSACTION READ ONLY; … ROLLBACK;` (`transaction_read_only = on`), and no DDL was sent. They passed as `postgres` with the transaction-local settings in effect, and recorded the previous body `d4a5f3af…`.
> - **What was run — migration only, exactly as planned.**
>   - `supabase migration list --linked` showed local and remote aligned through `20260929084252` (97 paired), exactly one local-only migration, `20260930161651`, and no remote-only one.
>   - `supabase db push --linked --dry-run` listed exactly `20260930161651_fix_search_match_cross_field_attribution.sql`, with no seeds and no roles.
>   - From a clean checkout of `main` at the merge commit, one `npx supabase db push --linked --yes` (Supabase CLI 2.111.0) applied exactly that file on its first and only attempt. It exited 0 and reported no seeds and no roles.
>   - Ledger **97 → 98**.
> - **After — verified read-only immediately after the apply.** The catalog fingerprint was re-read later the same day, unchanged, for the documentation reconciliation.
>   - **Ledger:** **98**, latest `20260930161651`, present exactly once (name `fix_search_match_cross_field_attribution`, 8 recorded statements). The other 97 versions are unchanged, so no other migration was applied.
>   - **Body:** `search_papers` is `1a72d57a585779644c00636f0da3b253`. All six `matched_*` flags test `v_ts_any`. The membership predicate `p.search_vector @@ v_ts_query` and the rank `ts_rank(p.search_vector, v_ts_query)` each occur once, verbatim.
>   - **Function identity and posture:** its whole `pg_proc` row except the body is identical to the preflight snapshot — OID, signature, result, owner, language, security mode, volatility, parallel mode, cost, rows, `search_path` and ACL. Effective EXECUTE is still `authenticated` only.
>   - **Other functions:** every other `public` function's row is identical, including `search_papers_short` (`ce353564edcb73a5466092e84d0b8d1b`) and the other read RPCs.
>   - **Search infrastructure and RLS:** unchanged — `search_vector` (`8ddd960b…`), every `papers` index (with `idx_papers_search_vector` valid, ready and live), `papers`' owner, RLS, FORCE RLS, table ACL and grants, and the policy digest `07603cbe…`.
>   - **No row writes:** the migration's own §3 proved, before COMMIT, that it wrote no row in `public`, `auth` or `storage`.
> - **Runtime evidence boundary.** No Production user-content query and no Production UI search were run, no Production search fixture was created, and no real paper content was read. Acceptance rests on:
>   - the exact deployed body and posture above;
>   - merged-`main` DB Tests, including suite `027`, which compares rows, ranks and flags against the previous body;
>   - the local E2E cross-field case from the implementation phase.
>
>   This is not an end-to-end Production UI acceptance.
> - **Deployment isolation.** The migration push was the rollout's only intentional Production database mutation.
>   - No Edge Function was deployed. The six were read after the apply at their existing versions — `analyze-paper` v33, `delete-account` v6, `fetch-paper-metadata` v23, `get-gemini-provider-quota` v9, `search-pubmed` v6, `suggest-paper-organization` v16 — and none had been updated since 2026-09-28.
>   - No secret, Auth or Storage change was made.
> - **No manual Vercel action.** Vercel's Git integration created its usual Production deployment for the merge commit: `dpl_3etF1C2pEFnveK4hhPLq6931GaLj`, source `8a2a880c`, target production, READY, aliased to `app.paperlume.app`. The frontend needed no change for C58. The database migration, not that deployment, activated it.

**What the migration does** (C58). One `CREATE OR REPLACE FUNCTION public.search_papers(uuid,text,integer,integer)` inside a fail-closed transaction. The same sanitized tokens are also joined with ` | ` into `v_ts_any`, once per call, and the six `matched_*` flags test `v_ts_any` instead of the membership query. The guard, sanitizer, `&`-join, empty-input return, membership `WHERE`, `ts_rank`, `ORDER BY` and `LIMIT/OFFSET` are the previous body's text verbatim, and section 3 proves it. Signature, return columns, defaults, `LANGUAGE plpgsql`, SECURITY INVOKER, VOLATILE, PARALLEL UNSAFE, COST 100, ROWS 1000, `search_path=public`, owner and ACL are all unchanged, and every attribute is restated explicitly. No GRANT or REVOKE. `search_papers_short`, `papers`, `search_vector`, the GIN index and every policy are untouched, and no row is written. The new body is `1a72d57a585779644c00636f0da3b253`.

**No ordering constraint.** The shipped web app renders whatever flags the RPC returns, and the RPC's name, arguments and result columns do not change, so the generated types do not change either. No Edge Function calls `search_papers`, so there is no web-first or Edge-first step, and no Vercel or Edge deployment is part of this rollout.

**Reference procedure — the plan as written before the rollout, kept for re-verification and as the pattern for a comparable migration-only change; not a pending step.** The completed record is the status box above; these steps describe the procedure and are not themselves a record of what was run.
1. Merge the independently approved exact head with a regular two-parent merge commit. Wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. `E2E (local)` is not a merged-`main` check; its evidence is the pull-request run on the exact approved head.
2. Read-only preflight: send the merged file's statements after `BEGIN;`, through the end of §1, verbatim inside `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`. Send no DDL. It must pass as `postgres` with the transaction-local settings in effect. Section 1 refuses any other pre-state; a refusal must be explained before anyone retries.
3. `supabase migration list --linked`: local and remote aligned through `20260929084252`, and exactly one local-only migration, `20260930161651`. `supabase db push --linked --dry-run` must list exactly that file, with no seeds and no roles. Anything else: stop (§6.2).
4. From a checkout at the merge commit, `supabase db push --linked`, migration only. No Edge Function deploy, no secret change, and no Auth, Storage or Vercel change.
5. Verify immediately, read-only (this query also re-verifies the state at any time):
   ```sql
   BEGIN; SET TRANSACTION READ ONLY;
   SELECT md5(p.prosrc) AS body,                                    -- expect 1a72d57a585779644c00636f0da3b253
          p.prosecdef, p.provolatile, p.proconfig::text, p.proacl::text,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,   -- expect true
          has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_x,   -- expect false
          has_function_privilege('service_role',  p.oid, 'EXECUTE') AS svc_x     -- expect false
     FROM pg_proc p WHERE p.oid = 'public.search_papers(uuid,text,integer,integer)'::regprocedure;
   SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.search_papers_short(uuid,text)'::regprocedure;  -- expect ce353564edcb73a5466092e84d0b8d1b
   SELECT count(*), max(version) FROM supabase_migrations.schema_migrations;                          -- expect 98, 20260930161651
   ROLLBACK;
   ```
   Expected: `prosecdef` false, `v`, `{search_path=public}`, ACL `{postgres=X/postgres,authenticated=X/postgres}`. `search_vector` stays at `8ddd960b4f4b11dd7afd35485d01fd25`, `idx_papers_search_vector` stays valid, and the `papers` / `synonym_pool` policy digest stays `07603cbe4e78a4d6097e7ec33bd1e6c8`.
6. No canary is required. The migration's own section 3 refuses to commit anything but the reviewed body and posture. Behaviour is covered against a full replay by suite `027`, which compares rows, ranks and flags against the previous body, and by the `e2e/search-attribution.spec.ts` cross-field case. If an authenticated product smoke is separately authorized, the smallest one searches two words that sit in two different fields of one paper and expects both fields in "Matched in:".

**Rollback — reference only; none has been performed, and this section authorizes none.** Prefer fixing forward. A reversal is a new forward migration that re-creates the previous body (`d4a5f3af…`, the `search_papers` text of `20260802025704`) with every attribute stated, including SECURITY INVOKER, behind the same kind of preconditions. It restores the zero-flag rows C58 removes and changes no result set. It needs its own decision against C58.

### 6.20 `20260930203613` (stage the three replacement AI models, C59) — COMPLETE: applied to Production 2026-10-01

**Status: APPLIED.** `AI-MODEL-CATALOG-REFRESH-001A` prepared it and Phase B applied it on 2026-10-01 with one bare `supabase db push --linked --yes`; the ledger went **98 → 99**. It inserted `anthropic/claude-sonnet-5-5`, `anthropic/claude-opus-5-5` and `openai/gpt-6.1-sol` as `enabled = true`, `selectable = false`, `reasoning_selectable = false`, and wrote nothing else. The same phase redeployed both generation functions so the new price records shipped — `analyze-paper` **v34** (`23edb1e6…`) and `suggest-paper-organization` **v17** (`c1230563…`). See §16.1 for the executed record.

### 6.21 `20261001092335` (the final seven-model cutover, C59) — APPLIED 2026-10-01

**Status: APPLIED.** Prepared by `AI-MODEL-CATALOG-REFRESH-001D`, its locking rationale corrected by `-001D-R1`, and applied to Production on 2026-10-01 by `-001E` in a migration-only rollout (ledger **99 → 100**; merge `63a590a7`; executed evidence in §16.3). It is Phase D of §16 and did three things in one transaction, in an order the foreign key makes mandatory: migrated every saved preference off `anthropic/claude-sonnet-5` and `openai/gpt-5.6-terra` onto their successors, DELETED those two rows, then opened the three replacements (`selectable` and `reasoning_selectable`) at final sort positions 50 / 60 / 70. The result is exactly **seven** rows, all fully open — which is what Production holds now.

**It locks before it reads.** `public.user_ai_preferences` then `public.ai_model_catalog`, both `IN EXCLUSIVE MODE`.

Four functions write `user_ai_preferences`, and they do not all lock alike. `set_current_user_ai_model` reads the catalog with a **plain** SELECT, then takes `SELECT … FOR UPDATE` on the caller's preference row and writes it (UPDATE, or `INSERT … ON CONFLICT (user_id) DO NOTHING` when there was no row to lock). `set_current_user_ai_reasoning` takes that `FOR UPDATE` **first** and only then reads the catalog row the preference names. `clear_current_user_ai_model` (DELETE) and `clear_current_user_ai_reasoning` (UPDATE) take **no** `FOR UPDATE` at all and conflict through ROW EXCLUSIVE alone.

So the modes to block on the preference table are ROW SHARE (the two setters' `FOR UPDATE`) and ROW EXCLUSIVE (every write, both clear paths included). **EXCLUSIVE is the weakest standard mode that conflicts with both** — SHARE and SHARE ROW EXCLUSIVE block the writes but not the `FOR UPDATE`, and anything weaker blocks neither — so **no preference mutation can commit** while the cutover rewrites references and deletes the old rows. That, not the FK and not speed, is what makes the zero-reference gate ahead of the DELETE mean anything. On the catalog, EXCLUSIVE serializes conflicting catalog-level mutations while still allowing ACCESS SHARE reads; `authenticated` holds SELECT and nothing else there, so it is a migration/admin mutation boundary rather than a client-write boundary. Preferences are locked first because every conflicting lock any of the four takes is preferences-first, catalog-second (the model setter's catalog `FOR KEY SHARE` comes from its write, after the preference lock), so the two cannot deadlock. Both release at COMMIT.

**What the locks do not promise.** EXCLUSIVE not conflicting with ACCESS SHARE means in-flight readers are never *blocked* — it does **not** give them one snapshot. `resolveEffectiveAiModel` performs three separate reads (access RPC, preference row, catalog row), so under READ COMMITTED a request can straddle the COMMIT: read a preference still naming a retiring id just before, and the catalog just after, when that id is gone. The resolver already classifies that as `model_missing` and falls back to the system default on Automatic. The cost was **at most one request served by the default model instead of the pinned one**, for the width of the cutover transaction — not corruption, not reachability of a retired model, not an orphaned preference, and not a security bypass, since the saved row is rewritten in the same transaction and the next request reads the successor. That was a bounded rollout race, now closed: the cutover has committed. Giving the resolver a single snapshot across its three reads would be an architecture change to the generation path and is deliberately out of scope.

**Migration-only.** No Edge Function source changed, so **no deployment was required, and none was performed** — `analyze-paper` v34 and `suggest-paper-organization` v17 remain the deployed runtime: the resolver, the reasoning policy, both setters and the Settings control are all data-driven from this table, so the row change was the whole change. The price book keeps all five paid records, including the two retired models' — historical telemetry still names them, and telemetry has no FK to the catalog. Rollback is a forward migration; see §16.3.

## 7. Edge Function deployment

Edge Function code does **not** ship via a GitHub merge or a Vercel build. Each affected function must be deployed explicitly:

```sh
supabase functions deploy analyze-paper --project-ref <project-ref>
supabase functions deploy fetch-paper-metadata --project-ref <project-ref>
supabase functions deploy get-gemini-provider-quota --project-ref <project-ref>
supabase functions deploy delete-account --project-ref <project-ref>
supabase functions deploy search-pubmed --project-ref <project-ref>
supabase functions deploy suggest-paper-organization --project-ref <project-ref>
supabase functions deploy search-consensus --project-ref <project-ref>   # endpoint before UI — follow §7e
```

- Run one command per changed function. If a PR touches several, run each.
- If a PR touches `supabase/functions/_shared/*` (e.g. `env.ts` from PR #139), every function that imports the shared module must be redeployed — the shared file is bundled into each function's deploy artifact.
- `supabase db push` is **not** needed for Edge-only PRs.
- After deploy, smoke each changed function — see §8.

The Supabase CLI runs Deno bundling at deploy time and surfaces compile errors before publishing. Treat a successful deploy as the formal Deno-side typecheck (the project doesn't run `deno check` locally — `deno` isn't part of the standard contributor toolchain).

**Verifying what is actually deployed.** Read-back representation is **tool-dependent**. The `supabase functions download` path used in prior rollout verification has been observed to return normalized/transpiled output (type annotations stripped, formatting normalized), so do not assume its files are byte-identical to repository TypeScript. Other inspection mechanisms may expose a different representation, including source closer to what was uploaded. Before using byte identity as evidence, establish what transformation, if any, the mechanism you chose applies.

- Prove provenance **before** deploying: confirm the deploying worktree's function closure (entrypoint plus every `_shared/*` module it imports, recursively) is byte-identical to the accepted commit, and deploy from that worktree.
- Afterwards, use the strongest comparison the chosen mechanism actually supports: **byte** comparison when it demonstrably returns the uploaded source representation; otherwise **semantic** comparison of the changed behavior, or a **differential** comparison of the old and new read-backs taken through the same mechanism (capture the previous version before deploying).
- **Observed on 2026-09-17 (CLI 2.111.0, Phase 6):** `supabase functions download <name> --project-ref <project-ref> --use-api --workdir <scratch dir>` returned files byte-identical to the Git blobs of the commit each version was deployed from — before the deploy (v26/v10, commit `c106c84`) and after it (v27/v11, commit `f962b44d`) — so byte comparison was valid for that mechanism then. Re-establish it on each run rather than assuming it. Always pass a scratch `--workdir`: the command writes `supabase/functions/<name>/…` and the shared modules under it, and pointed at the repository it would overwrite source.
- **A deploy can move secret timestamps.** After the Edge deploys of 2026-08-23, 2026-09-02 and 2026-09-17, the platform-injected `SUPABASE_*` entries in `supabase secrets list` carried an `updated_at` within a millisecond of the deployed function's own `updated_at`, although no operator sets those entries. Compare manually managed secrets when proving "no secret changed", and do not read that re-stamp as a secret change.
- Record the resulting version and `ezbr_sha256` in the rollout entry in [`migration-history.md`](migration-history.md); do not treat any particular version or hash as a fixed baseline here.

### 7a. `delete-account` — endpoint-before-UI ordering, and never smoke-test it destructively

**Current state: `delete-account` is deployed and live**, and the Account → Danger zone flow calls it in Production. The two rules below are durable and apply to every future change to this function.

**Rule 1 — the endpoint must never lag the UI that calls it.** Merging to `main` auto-deploys the frontend (§8); Edge Functions do **not** ship with that merge. So for any change that makes a *new* destructive surface reachable, deploy the function first:

```text
1. independent review approves the exact PR head
2. obtain explicit owner authorization for the Production Edge deployment
3. deploy that exact reviewed function:
     supabase functions deploy delete-account --project-ref <project-ref>
4. verify it NON-DESTRUCTIVELY only (see below)
5. merge the exact reviewed PR head
6. verify merged-main CI + the automatic Vercel Production deployment
```

The same rule runs in reverse on rollback: redeploy the previous function version **before** reverting the frontend. The button must never outlive the endpoint.

**Rule 2 — non-destructive Production verification only.** Never "smoke test" this function by deleting a real account — not the owner's, and not a throwaway account created for the purpose. The safe checks are:

- `OPTIONS` returns 200 with the CORS headers (preflight, mutates nothing);
- `GET` returns `405 method_not_allowed`;
- `POST` with no Authorization header returns `401 unauthenticated`;
- `POST` with a valid token and a *wrong* confirmation phrase returns `400 invalid_confirmation`.

Each of those is refused before any privileged client is constructed, so none can delete anything. Correctness of the destructive path itself is established by the Vitest suites, the pgTAP cascade suite (`008_account_deletion_cascade`), and the destructive Playwright spec running against an ephemeral local stack — never by a Production deletion.

---

### 7b. `search-pubmed` — deployed; endpoint-before-UI ordering applies

**Current state: `search-pubmed` is deployed to the linked project and live.** It is the Edge Function behind the Add Papers → **Search** mode's PubMed source (`PUBMED-IN-APP-SEARCH-001`; the mode was named **PubMed Search** until `CONSENSUS-SEARCH-MVP-001A`). The initial rollout completed on **2026-08-23** — its evidence (deployment identifiers, verification results, merge and Vercel provenance) is recorded in [migration-history.md](migration-history.md). Read the live version back rather than trusting any number written here: `supabase functions list --project-ref <project-ref>`.

**What it is.** A read-only discovery endpoint. It authenticates the caller in-function with `auth.getUser()`, reads that user's optional `profiles.pubmed_api_key` server-side, calls NCBI E-utilities **ESearch** then **ESummary** with a finite timeout and a one-retry budget, and returns an application-owned page of PubMed summaries. It performs **no** insert, update, Project/Tag mutation, AI call or quota consumption, and it uses **no** elevated key. The user's API key is never returned, never logged, and never reaches the browser; the raw search query is never logged either — only its length.

**What it is not.** It is not an import path. The PMIDs a user selects are imported by the pre-existing canonical importer (`bulkImportPapers` → `fetchPaperMetadata` → `fetch-paper-metadata` → normalization → `safe_bulk_insert_papers`), which remains the sole authority for persisted paper metadata. Deploying `search-pubmed` therefore changes nothing about how papers are stored.

**Deployment artifact.** The function's complete closure is:

```text
supabase/functions/search-pubmed/index.ts      # Deno shell only
supabase/functions/search-pubmed/handler.ts    # the whole request path
supabase/functions/_shared/pubmedSearch.ts     # validation, URL building, parsing
supabase/functions/_shared/env.ts              # pre-existing, unchanged
```

`_shared/env.ts` is the only shared module it imports, and it was **unchanged by the initial rollout** — so no other function needed redeploying, and `fetch-paper-metadata` kept its deployed version. Re-check that closure before any future deploy: if a change reaches `_shared/env.ts`, every function bundling it must be redeployed too.

**Required ordering — the endpoint must not lag the UI that calls it.** This rule is durable, not a one-off: it governed the initial rollout and governs every future change that gives `search-pubmed` a new or altered request/response contract before frontend code can use it. Merging to `main` auto-deploys the frontend (§8); Edge Functions do **not** ship with that merge, so a frontend that expects a contract the deployed function does not serve yet would fail every search.

```text
1. independent review approves the exact PR head
2. obtain explicit owner authorization for the Production Edge deployment
3. deploy that exact reviewed function from a worktree byte-identical to it:
     supabase functions deploy search-pubmed --project-ref <project-ref>
4. verify the deployment (see below)
5. merge the exact reviewed PR head
6. verify merged-main CI + the automatic Vercel Production deployment
7. run the §9.3b post-deploy smoke checklist
```

On rollback the order reverses: revert the frontend **before** rolling the function back.

A frontend-only change that uses the **already-deployed** contract — a rendering or wiring fix, for example — needs no Edge deployment and merges normally.

**Verification, non-destructively.** Every check below is refused before any PubMed request is made, so none of them consumes upstream rate budget or touches user data:

- `OPTIONS` returns 200 with the CORS headers (preflight, before any auth);
- `GET` returns `405 method_not_allowed`;
- `POST` with no Authorization header returns `401 unauthenticated`;
- `POST` with a valid token and `{"query": ""}` returns `400 invalid_request`.

The empty-query case is the informative one: it proves the worker boots, builds the caller-scoped client and validates the JWT, then stops at request validation **before** the `profiles.pubmed_api_key` lookup and before ESearch/ESummary — so it costs no upstream rate budget. All four passed at the initial rollout on 2026-08-23 ([migration-history.md](migration-history.md)); re-run them after any future deployment.

**No new secret is required.** It uses the auto-injected `SUPABASE_URL` / `SUPABASE_ANON_KEY` and the already-existing per-user `profiles.pubmed_api_key`. **No migration is required** — the feature adds no table, column, RPC or RLS policy.

---

### 7c. `suggest-paper-organization` — deployed; endpoint-before-UI gate satisfied

**Current state: `suggest-paper-organization` is deployed to the linked project and ACTIVE.** It is the Edge Function behind the Edit Paper **Suggest Projects & Tags** experience (`AI-PROJECT-TAG-SUGGESTIONS-001`). The initial rollout completed and was verified on **2026-08-23** — its evidence (deployment identifiers, verification results, merge and Vercel provenance) is recorded in [migration-history.md](migration-history.md). Read the live version back rather than trusting any number written here: `supabase functions list --project-ref <project-ref>`.

**The frontend calls it in Production, and the feature is accepted.** `001B` shipped the Edit Paper surface against this exact contract (PR #242, merged as `8159d353f3cdb76b332d6a0266f00c4d4772c566`). That PR was **frontend-only**: it changed no file under `supabase/functions/`, `supabase/config.toml` or `supabase/migrations/`, so it required no Edge deployment and no migration, and the deployed artifact it depends on is the one the `001A` rollout verified. **`001B` Production acceptance completed on 2026-08-24** against that unchanged deployed function — a real generation returned 200, and both the existing-selection and **Create & select** paths persisted correctly through Save Changes; the chronology is in [migration-history.md](migration-history.md). The endpoint-before-UI gate was satisfied *before* `001B` was built, which is the ordering the rule exists to produce.

**What it is.** An advisory, non-mutating suggestion endpoint. It authenticates the caller in-function with `auth.getUser()`, verifies the requested paper belongs to that caller, reads that caller's own Projects and Tags, sends Gemini a bounded, allow-listed semantic payload, and returns four suggestion lists. It consumes **one unit of the existing AI quota** per successful generation through `consume_ai_quota` on the caller's client, and refunds best-effort through `refund_ai_quota` when the provider fails or returns an unusable result. Since the 2026-09-25 C47 rollout (v16, §6.8) that refund goes through the **server-only refund client** (§3.3), because the database no longer lets a caller refund; its only other elevated-key use is the insert-only telemetry writer (§3.3). Before C47, v15 and earlier refunded on the caller's client. Every read stays caller-scoped.

**What it is not.** It is not a mutation path. It performs no Project, Tag, `paper_projects`, `paper_tags` or `papers` write, and persists no suggestion — its deployment therefore changed nothing about how the library is stored, and it cannot alter existing data. Production verification confirmed that empirically: a real generation left every Project, Tag, assignment and paper row byte-identical. It is also not a second quota system: it records under the existing `ai_analysis` counter, so the owner/manager AI exemption keeps working unchanged. See [decisions-and-triggers.md](decisions-and-triggers.md) C32.

**Deployment artifact.** The function's complete closure is:

```text
supabase/functions/suggest-paper-organization/index.ts       # Deno shell only
supabase/functions/suggest-paper-organization/handler.ts     # the whole request path
supabase/functions/suggest-paper-organization/validation.ts  # request shape, bounds, eligibility
supabase/functions/suggest-paper-organization/prompt.ts      # provider payload + ephemeral refs
supabase/functions/suggest-paper-organization/parse.ts       # strict response validation
supabase/functions/suggest-paper-organization/contract.ts    # bounds and types
supabase/functions/_shared/env.ts                            # pre-existing, unchanged
supabase/functions/_shared/geminiModel.ts                    # pre-existing, unchanged
supabase/functions/_shared/providerError.ts                  # pre-existing, unchanged
```

The three `_shared` modules were **not modified** by `001A`, so no other function needed redeploying — and the rollout confirmed it: all five pre-existing functions kept their exact versions and bundle hashes. Re-check that closure before any future deploy: if a change reaches one of those shared modules, every function bundling it must be redeployed too.

**No new secret is required.** It reuses the existing `GEMINI_API_KEY`, the optional `GEMINI_MODEL` override (resolved through the same `_shared/geminiModel.ts` as `analyze-paper`, so the two cannot disagree on the system default), and the auto-injected `SUPABASE_URL` / `SUPABASE_ANON_KEY`. **No migration is required** — the feature adds no table, column, RPC or RLS policy.

> **Bundle closure changed after `AI-MODEL-SELECTION-001B`.** Both generation functions now also bundle `supabase/functions/_shared/aiModelSelection.ts`. The file list above describes the `001A` rollout as it happened and is not being rewritten; treat `_shared/aiModelSelection.ts` as a member of the deployment closure for **both** `analyze-paper` and `suggest-paper-organization` from now on. **That `001B` routing bundle has since been deployed to Production in both generation functions**, so this closure is live rather than pending: any future change to `_shared/aiModelSelection.ts` puts **both** `analyze-paper` and `suggest-paper-organization` in the deployment set, and merging to `main` ships neither of them — see the ordering rule immediately below.
>
> **Bundle closure changed again with `AI-MULTI-PROVIDER-001A` (C39); deployed 2026-09-17 (Phase 6).** The provider seam adds three shared modules to the closure of **both** generation functions — `_shared/aiProvider.ts` (the contract), `_shared/aiProviderRegistry.ts` (the adapter registry, which also resolves the system default) and `_shared/googleAiProvider.ts` (the Google adapter, which is now what calls `_shared/geminiTransport.ts`) — plus `analyze-paper/prompt.ts` for `analyze-paper` only. Until Phase 6 Production ran the pre-001A artifacts; the refactor left every provider request, user-visible response and quota/refund outcome unchanged. The deploy covered **both** `analyze-paper` and `suggest-paper-organization` in one authorized set, because they share every one of those modules, and any future change to them must do the same. **No new secret was required or permitted by it:** at 001A `GEMINI_API_KEY` was the only AI provider credential, and no Anthropic/OpenAI secret could exist or be added until an adapter for that provider was registered and reviewed. *(C41 registered both adapters, and both paid credentials were installed on 2026-09-18 — §3.2.)* There is still no `AI_API_KEY` and no `AI_PROVIDER`.
>
> **`AI-MULTI-PROVIDER-001B` (C40) edits modules inside that closure; deployed with Phase 6.** It changes `_shared/aiProvider.ts` (a required `jsonSchema` and one new failure kind, `incomplete_response`), both operations' `prompt.ts` (their output schemas), and `suggest-paper-organization/handler.ts` and `analyze-paper/index.ts` (an explicit branch for the new failure kind, which Google cannot produce), so the deploy had to cover **both** generation functions together. At 001B the two new adapter modules, `_shared/anthropicAiProvider.ts` and `_shared/openAiProvider.ts`, were **in neither closure**, because no shipping function imported them; 001C changed that (below). The Gemini request bytes are unchanged, and no new secret is required.
>
> **`AI-MULTI-PROVIDER-001C` (C41) changes the closure again; its Edge change went live with the 2026-09-17 Phase 6 deploy** (the 001C frontend had been live since the 2026-09-13 merge). Registering Anthropic and OpenAI means `_shared/aiProviderRegistry.ts` now **imports** `_shared/anthropicAiProvider.ts` and `_shared/openAiProvider.ts`, so all three adapters are in the closure of **both** generation functions — and therefore in both deployed bundles, where they stay unreachable without a catalog row and a credential. So are two new shared modules: `_shared/aiReasoningPolicy.ts`, the per-model, per-operation reasoning policy, and `_shared/aiProviderCredentials.ts`, the provider→credential-name mapping. The deploy therefore had to cover `analyze-paper` **and** `suggest-paper-organization` together, **after** migration `20260912120000` was live (§6.6a, phases 1 and 6), and it did. The Google request gains exactly one field, `generationConfig.thinkingConfig.thinkingLevel`. The fail-open `provider_default` path reproduces the pre-001C bytes exactly (golden SHA-256 `3285186f…`). With no non-Google catalog row, no new secret was required to deploy it.
>
> **`AI-MULTI-PROVIDER-001D` (C42) adds five shared modules to both closures; deployed with Phase 6.** They are `_shared/aiUsage.ts`, `_shared/aiPriceBook.ts`, `_shared/aiCostEstimate.ts`, `_shared/aiUsageTelemetry.ts` and `_shared/edgeSecretKey.ts`. At the Phase 6 deploy the complete closures, discovered recursively from each entrypoint, were **19 files** for `analyze-paper` and **23** for `suggest-paper-organization`, every one byte-identical to `main` `f962b44d`. `_shared/edgeSecretKey.ts` is also in `delete-account`'s closure in `main`, through a re-export from `_shared/accountDeletion.ts`; the deployed `delete-account` predates that behaviour-preserving extraction. A future change to `_shared/edgeSecretKey.ts` therefore puts all three functions in the deployment set.

**Required ordering for every FUTURE change — the endpoint must not lag the UI that calls it.** The initial deployment is done; this rule is durable and governs any later PR that changes this function, or any shared module inside its bundle, in a way that alters the request/response contract. Merging to `main` auto-deploys the frontend (§8); Edge Functions do **not** ship with that merge, so a frontend expecting a contract the deployed function does not serve yet would fail every request.

**Which path applies depends on one question: would merging this PR put a caller in Production that the deployed Edge artifact cannot serve?** Answer it before doing anything else — the two paths order the merge and the deployment differently, and picking the wrong one is exactly how the invariant gets broken.

**Determining the deployment set (both paths).** Before deploying anything, inspect the changed function's dependency closure (§7c "Deployment artifact" above). A changed module under `supabase/functions/_shared/` is bundled into **every** function that imports it, so all of those functions belong to the authorized deployment set — not just the one the PR is "about". Deploy the complete set, and only then verify and smoke. Discovering a second affected function *after* the smoke checks would mean the Production state you verified was never the final one.

**Path A — backend-only change.** Use this only when the PR contains no frontend that depends on the new contract, **and** the currently deployed frontend stays compatible with the currently deployed Edge artifact for the whole rollout interval.

```text
1. independent review approves the exact backend PR head
2. merge that backend-only PR through the normal GitHub process
3. obtain explicit owner authorization for the Production Edge deployment
4. determine the COMPLETE affected Edge Function set (see above)
5. deploy every required named function from the exact merged artifact:
     supabase functions deploy <name> --project-ref <project-ref>
6. verify live artifacts: supabase functions list --project-ref <project-ref>
   — every intended function advanced and is ACTIVE, and every function you did
     NOT intend to change kept its version and bundle hash
7. run the §9.3c smoke checklist
8. only after that succeeds may any dependent frontend PR merge
```

`001A` took this path, and it was safe for the specific reason stated in the Path A precondition above the sequence — not in numbered step 1, which is only the review step: the endpoint had **no frontend caller at all**, so merging before the first deployment could not expose a broken UI. That condition is what makes merge-first legitimate — it is not a general licence.

`001B` needed neither path, because it changed no Edge artifact: a frontend-only PR against an already-deployed, unchanged contract has no deployment to order. The next PR that touches this function's closure must pick a path again, using the question above.

**Path B — the frontend depends on the changed Edge contract.** Use this when the same PR carries frontend code expecting the changed contract, or when merging the frontend first would put an incompatible caller in Production. **Here the deployment happens before the merge.**

```text
1. independent review approves the exact PR head
2. obtain explicit owner authorization for the Production Edge deployment
3. determine the COMPLETE affected Edge Function set (see above)
4. deploy the exact APPROVED Edge artifact(s) BEFORE merging the frontend change
5. verify live artifacts — intended functions advanced, unaffected functions
   unchanged (same check as Path A step 6)
6. run the §9.3c smoke checklist
7. re-read the PR head and confirm it is STILL the exact approved SHA
8. only then merge that exact head through the normal GitHub process
```

**If the PR head moves at any point after approval or deployment, stop.** The earlier approval no longer describes what would merge, and the changed head needs independent review before it can be merged. Never quietly deploy an artifact that was not the reviewed one.

A frontend-only change that uses the **already-deployed** contract needs no Edge deployment and merges normally. On rollback the order reverses: revert the frontend **before** rolling the function back.

**A Vercel Preview cannot validate this function.** A Preview build exercises frontend code only; the endpoint lives in Supabase and is deployed separately. Preview state is evidence about the frontend, never about this endpoint's deployed version.

### 7d. `fetch-paper-metadata` — Crossref operational identity (`CROSSREF-OPERATIONAL-IDENTITY-001A`); COMPLETE: deployed 2026-09-28

> **Status — COMPLETE. `fetch-paper-metadata` v23 is live in Production since 2026-09-28 18:39:13Z (`CROSSREF-OPERATIONAL-IDENTITY-001B`).** Every Crossref request now identifies PaperLume. The only Production change was that one function's redeploy. No rollback has been performed.
>
> - **Merged.** PR #319 as the two-parent commit `589703838ae5cbc10e16098ddc757fe2f6750d05`: parents `3f0ccaae` and the approved head `ab3e06dc`; tree `85a56b94`, identical to the approved head's. The source branch `fix/crossref-operational-identity` is preserved.
> - **Hosted CI.** Merged-`main` on `58970383`: Validate (run `36465888100`), DB Tests (`36465888137`) and Extension (`36465888026`) all passed on the first attempt. `E2E (local)` does not run on a push to `main`; its evidence is the pull-request run on the approved head, `36461241018`, which passed.
> - **Before — read-only preflight, 18:37Z.**
>   - `fetch-paper-metadata` was **v22** (id `7e682b6d-b91b-4d36-9668-fc40a77b2f27`, updated 2026-09-18T20:19:26.016Z, `ezbr_sha256` `c334e87d80b1f9c0081c06baf1f5481326912e2f579c2764994e94b42ccc9c20`, `verify_jwt = false`).
>   - The other five were `analyze-paper` v33, `suggest-paper-organization` v16, `get-gemini-provider-quota` v9, `delete-account` v6 and `search-pubmed` v6. Their ids, update times and `ezbr_sha256` were recorded.
>   - The 14 secrets (7 manually managed, 7 platform `SUPABASE_*`) were recorded by name, digest and `updated_at`. No value was read.
> - **Rollback capture.** `supabase functions download fetch-paper-metadata --project-ref <project-ref> --use-api --workdir <scratch>` returned v22's 11-file closure. Every file was byte-identical to its blob at `a3c7d910`, so byte comparison was valid for this mechanism on this run. v22 sends `PaperIndex/1.0 (mailto:support@paperindex.app)` at both call sites.
> - **Provenance.** The deploy ran from a clean detached worktree at `58970383` (no modified, untracked or ignored files). Its recursively determined closure was 12 files: `index.ts`, `upstreamFetch.ts` and `crossrefRequest.ts`, plus nine `_shared` modules (`authorProvenance`, `boundedLogging`, `crossrefAuthors`, `env`, `htmlEntities`, `identifierDetection`, `orcid`, `publicationTypes`, `pubmedAuthors`). Each was byte-identical to its merge-commit blob.
> - **Deploy.** `supabase functions deploy fetch-paper-metadata --project-ref <project-ref>` ran with Supabase CLI 2.111.0 and Docker bundling ("script size: 102 kB") between 18:39:02Z and 18:39:26Z UTC. It exited 0 and deployed exactly that one function.
> - **After — verified read-only immediately after the deploy.**
>   - `fetch-paper-metadata` is **v23**: same id, updated 2026-09-28T18:39:13.518Z, `ezbr_sha256` `1e74d51d50b31260670d90fea7df710ec93875e42f03b1af26d6e8c9599d3296`, `verify_jwt = false`, ACTIVE.
>   - The other five functions are identical in every listed field: version, update time, `ezbr_sha256`, entrypoint and `verify_jwt`.
>   - **Deployed source.** Read back through the same `--use-api` mechanism, v23 is exactly the 12-file closure, and every file is byte-identical to `58970383`. Executing the deployed `crossrefRequest.ts` yields:
>     - `User-Agent: PaperLume/1.0 (mailto:mutrisport@gmail.com)`;
>     - `…/works/10.1000%2Fxyz123?mailto=mutrisport@gmail.com` for a DOI lookup;
>     - `…/works?query.title=…&rows=1&mailto=mutrisport@gmail.com` for a title search.
>
>     Both `index.ts` call sites use it. No deployed code contains `PaperIndex` or `support@paperindex.app`, and `fetch-paper-metadata` does not use `support@paperlume.app`.
>   - **Secrets.** All 7 manually managed secrets are unchanged in digest and `updated_at`. The 7 platform `SUPABASE_*` rows are unchanged in digest; only their `updated_at` moved, to the deploy instant (18:39:13.518Z). That is the platform's standing restamp on every deploy, not a secret change.
>   - **Database untouched.** A read-only fingerprint was identical before and after: ledger 96 (latest `20260928133918`), the `public` function-ACL digest and the relation count. No Auth, Storage or Vercel setting was changed.
> - **Boot probe.** One unauthenticated `POST` with an empty body answered the function's own `401 {"error":"Missing Authorization header"}`. That proves v23 boots and runs its handler. It carried no identifier and reached neither the database nor Crossref.
> - **Authenticated Crossref acceptance — deliberately skipped.** No safe existing acceptance credential was available: the `PAPERLUME_PROD_ACCEPT_*` variables are not inherited by this VS Code-launched session. The function authenticates every caller, so the live Crossref-fallback call was not run. No user, password or session was created and no auth state was changed to make one possible, so the Edge log inspection tied to that call was not run either. The identity is proven by the byte-identical deployed source, not by an observed outgoing request.

**What changed.** Every Crossref request `fetch-paper-metadata` makes identifies PaperLume, through the new `fetch-paper-metadata/crossrefRequest.ts`:
- `User-Agent: PaperLume/1.0 (mailto:mutrisport@gmail.com)`;
- a `mailto=mutrisport@gmail.com` query parameter, on the DOI lookup (`/works/{DOI}`) and on the title search (`/works?query.title=…&rows=1`).

Nothing else changed: the DOI and title encoding, `rows=1`, the transport, and the retry budget and logging. The contact is temporary — see [privacy-data-flow-audit.md](privacy-data-flow-audit.md) §34 — and `support@paperlume.app` is deliberately not used while it is inactive.

**Ordering.** No migration, no frontend change and no other function was involved. The change is inside `fetch-paper-metadata/`, and no `_shared/*` module changed, so this was the only function to redeploy. The frontend does not depend on it, so there was no endpoint-before-UI constraint: merge first, then deploy.

**Procedure — EXECUTED 2026-09-28; kept as the reference procedure; not a pending step.** These are the steps as written before the deploy; the status box above records what was observed.
1. Independently approve the exact PR head. Merge it with a normal two-parent merge commit. *Observed:* merged as `58970383`.
2. Wait for merged-`main` CI (Validate, DB Tests, Extension) to be green on that commit. *Observed:* all three passed on the first attempt.
3. Record the current deployed state: `supabase functions list --project-ref <project-ref>` (expect `fetch-paper-metadata` **v22**), and capture its current source with `supabase functions download fetch-paper-metadata --project-ref <project-ref> --use-api --workdir <scratch dir>` as the rollback reference (§7). *Observed:* v22, `c334e87d…`; the 11-file source is byte-identical to `a3c7d910`.
4. Prove provenance: the deploying worktree's `fetch-paper-metadata` closure is byte-identical to the merge commit. That means `index.ts`, `upstreamFetch.ts`, `crossrefRequest.ts` and every `_shared/*` module the entrypoint imports, recursively. *Observed:* 12 files, all byte-identical, in a clean worktree.
5. Deploy exactly that function: `supabase functions deploy fetch-paper-metadata --project-ref <project-ref>`. No other function, and no secret change. *Observed:* exit 0, one function.
6. Verify the result:
   - the version moved up exactly one from the step-3 value (**v22 → v23** unless something else redeployed it in between), and no other function's version moved;
   - read back through the same `--use-api` mechanism, the deployed files are byte-identical to the merge commit (re-establish byte fidelity first, §7), so the deployed `crossrefRequest.ts` carries the new identity;
   - record the version and `ezbr_sha256` in [migration-history.md](migration-history.md);
   - compare the manually managed secrets only: a deploy restamps the platform `SUPABASE_*` entries.

   *Observed:* v22 → v23, `1e74d51d…`, 12/12 files byte-identical, the other five functions and every manual secret unchanged.
7. Run one bounded functional check that carries no user content. Make one authenticated `POST` to `fetch-paper-metadata` with a single public DOI that PubMed does not index, so the lookup falls back to Crossref. Crossref's test DOI `10.5555/12345678` is a candidate; confirm it before use. The call must:
   - return one record with `source: "crossref"`, which proves Crossref accepted the new request shape;
   - write nothing, because the function returns metadata and does not insert a paper.

   The outgoing header cannot be observed from the function's response. The identity is established by the byte-identical deployed source in step 6, and polite-pool routing follows from Crossref's documented rule that an email in `mailto` or the agent header selects it. Crossref documents a pool response header (`x-api-pool`) only for Metadata Plus. Check that the Edge log lines for the call contain no DOI, title, URL or contact. *Not run:* no safe existing authenticated acceptance credential was available (see the status box). An unauthenticated boot probe answered the function's own 401 instead.
8. Reconcile the documentation from "prepared" to "live": this section, [privacy-data-flow-audit.md](privacy-data-flow-audit.md) §34 and §22.4 item 19, and the `fetch-paper-metadata` version in [start-here.md](start-here.md) §5. *Done* in `DOCS-CROSSREF-OPERATIONAL-IDENTITY-PRODUCTION-RECONCILIATION-001`.

**Rollback — none has been performed.** If a real regression appears, redeploy the captured v22 source (byte-identical to `a3c7d910`) from its download workdir, or deploy from `3f0ccaae`, the previous merge. No database state is involved.

### 7e. `search-consensus` — COMPLETE: deployed 2026-10-03, owner UI live and accepted 2026-10-09; endpoint-before-UI ordering applies

> **Status — COMPLETE. `search-consensus` is live in Production for the owner and passed the owner's Production acceptance on 2026-10-09 (`CONSENSUS-SEARCH-MVP-001A`, C60).** The initial rollout ran in the required order below: the secret and the endpoint first, the merge last. Read the live state back rather than trusting this box — `supabase functions list --project-ref <project-ref>`, and `supabase secrets list --project-ref <project-ref>` **for the name only**.
>
> - **Owner premise.** A read-only, count-only check found exactly one account holding role `owner` on 2026-10-03, and again before the merge on 2026-10-09. No id was recorded.
> - **Secret.** `CONSENSUS_API_KEY` was installed on 2026-10-03 from a private temp file (`secrets set --env-file`, file deleted afterwards) and verified by name only.
> - **Deploy.** `search-consensus` **v1** was deployed on 2026-10-03 from the exact approved head `712ed465`: ACTIVE, `verify_jwt = false`, `ezbr_sha256` `937acf15…` (full value in [migration-history.md](migration-history.md)).
> - **Read-back.** `functions download --use-api` returned exactly the five-file closure listed below, every file byte-identical to `712ed465`. It was re-verified on 2026-10-09, before and after the merge, with the same result.
> - **Zero-cost smoke.** `OPTIONS` → 200, `GET` → 405, `POST` without `Authorization` → 401; the one resulting log line was a bounded `outcome=unauthenticated` with no query text. The two token-bearing checks under *Non-consuming verification* (non-owner → 403, owner with an empty query → 400) were **not run**, because no signed-in test credential was available. The owner path has since been exercised live by the 2026-10-09 acceptance below. The non-owner refusal (403) has still not been probed live; it rests on the handler suite and the byte-identical deployed source.
> - **Merge.** PR #336 merged on 2026-10-09 at the approved head, as the two-parent commit `0da8e9c7c1b2a2c16c8cb59398b6490d6507578f` (tree identical to the head's). Merged-`main` Validate, DB Tests and Extension passed on the first attempt.
> - **Frontend.** The automatic Vercel Production deployment of `0da8e9c7`, aliased to `app.paperlume.app`, made the owner's **PubMed | Consensus** selector live. The merge deployed no Edge Function: `search-consensus` was still v1 with the same bundle afterwards, and its read-back still matched.
> - **Owner acceptance — PASSED on 2026-10-09 (search and import).** The rollout itself, from the secret installation through the merge, made **no** Consensus request, and the optional step-7 canary was not run. After the merge, the owner ran the acceptance through the Production UI.
>   - **Search.** One explicit Consensus search made one Consensus request (upstream HTTP 200, no retry) and returned 20 results, all 20 with an importable DOI. The function's log line read `outcome=ok upstream_status=200 returned=20 importable=20 dropped=0 retry=0`.
>   - **Import.** One selected DOI was added through the canonical importer, and the summary read **Consensus Import Results — Added (1)**. The outcome was reported under the requested DOI, not the resolved PMID, and that DOI left the selection.
>   - **Result.** The new library row carries PubMed-backed canonical metadata: PMID, PubMed URL, full abstract and `pubmed_api` author provenance.
>   - **No extra call.** The import made no further Consensus search.
>
>   §9.3d remains the reusable checklist for future changes.
>
> **Version counters are not source revisions.** Installing `CONSENSUS_API_KEY` advanced the version counter of every other function by one, with no redeploy: `fetch-paper-metadata` v25 → v26, `analyze-paper` v34 → v35, `get-gemini-provider-quota` v9 → v10, `delete-account` v6 → v7, `search-pubmed` v6 → v7, `suggest-paper-organization` v17 → v18. Their `ezbr_sha256` and `updated_at` did not change. In particular, `fetch-paper-metadata` v26 still runs the PR #335 source deployed as v25 (`updated_at` 2026-10-03T06:39:17Z, before the secret was set). Its read-back on 2026-10-09 was 14 of 14 files byte-identical to `main`. Do not "correct" these numbers by redeploying.

**What it is.** The owner-only endpoint behind Add Papers → **Search** → **Consensus**. For each request, in this order:

1. CORS preflight answered before any auth; `POST` only (`405` otherwise).
2. An `Authorization` header is required, and `auth.getUser()` must validate it (`401 unauthenticated` otherwise).
3. `get_current_user_access()` runs **as the caller** and its `role` must equal exactly `owner` — a manager, an ordinary user, a missing row or a malformed answer is `403 forbidden`, and an RPC error is `500 access_check_failed`. The role is never read from the request.
4. The body is validated against a **closed** contract — exactly `{ "query": string }`, trimmed, 1–500 characters (PaperLume's own bound; Consensus documents none). Any other field — `page`, `page_size`, filters, a URL, a role — is `400 invalid_request`.
5. Only now is `CONSENSUS_API_KEY` read (`503 not_configured` if absent).
6. Exactly **one** `GET https://api.consensus.app/v1/search?query=…&page_size=20`, with the key in `x-api-key`, a 15 s timeout and `redirect: "error"` so the key header can never follow a redirect. It is **never retried**, whatever the outcome.
7. The answer is parsed into an application-owned shape — `rank`, `title`, `authors`, `journal`, `year`, `abstract`, `citationCount`, `studyType`, `takeaway`, `consensusUrl`, `importDoi` — and nothing else of Consensus's payload is forwarded. `importDoi` is set only for a bare DOI name that PaperLume's Edge identifier logic (`detectIdentifier`) recognizes **unchanged**, with no whitespace/control/format characters and at most the importer's 500-character bound; nothing is repaired. `consensusUrl` is set only for an `https://consensus.app/papers/…` link.
8. One bounded log line per request — `consensus-search outcome=… q_len=… upstream_status=… returned=… importable=… dropped=… retry=0 duration_ms=…` — with no query text, title, abstract, takeaway, DOI, URL, key or token. A missing runtime variable is named as `missing_env=SUPABASE_URL|SUPABASE_ANON_KEY`, never with free error text.

| Consensus answer | Browser receives |
|---|---|
| 200 with `results` | `200 { "results": [...] }` (an empty list is a valid answer) |
| 401 (missing/invalid/revoked key), 402 (billing past due), 403 (e.g. `feature_not_allowed`) | `502 consensus_unavailable` — never which of the three |
| 429 whose body says "used all included searches" (monthly allowance) | `429 quota_exhausted` |
| any other 429 (documented "Too many requests", 1 request/second) | `429 rate_limited` |
| 5xx, any other 4xx, a network failure, non-JSON or a malformed envelope | `502 upstream_unavailable` |
| timeout | `504 upstream_timeout` |

Every `401` the function returns is produced **before** step 5. That is what makes the browser wrapper's single refresh-and-retry on a PaperLume `401` free of Consensus cost; it retries nothing else.

**Contract decision, with sources.** `GET /v1/search` is the endpoint Consensus documents as "the supported endpoint for searching academic papers"; `/v1/quick_search` is "deprecated and will be removed on 2027-02-07", and the official `Consensus-NLP/consensus-api` README states that `/v1/search` "is the same contract". Sources (retrieved 2026-10-03): `https://docs.consensus.app/llms.txt` and its companion `llms-full.txt` (the HTML reference pages and `openapi.json` sit behind a Cloudflare browser challenge), and `https://github.com/Consensus-NLP/consensus-api`. The live audit of 2026-10-02 (`CONSENSUS-API-CAPABILITY-AUDIT-001`) had already exercised `/v1/search` once with the owner's Free key. **V1 is query-only**: no filters (the typed parameter reference could not be read, so none was added on inference), no `page`, no `include_full_text_chunks`.

**What it is not.** Not an import path, not a metadata authority and not an AI provider; it persists nothing. The DOIs the owner selects are imported by the canonical importer (`bulkImportPapers` → `fetchPaperMetadata` → `fetch-paper-metadata` → PubMed/Crossref provenance checks → normalization → duplicate handling → `safe_bulk_insert_papers`), which fetches each paper's metadata itself.

**Deployment artifact.** The function's complete closure:

```text
supabase/functions/search-consensus/index.ts        # Deno shell only
supabase/functions/search-consensus/handler.ts      # the whole request path
supabase/functions/_shared/consensusSearch.ts       # contract, DOI/link boundaries, parsing
supabase/functions/_shared/identifierDetection.ts   # pre-existing, UNCHANGED (also bundled by fetch-paper-metadata)
supabase/functions/_shared/env.ts                   # pre-existing, UNCHANGED
```

Neither pre-existing shared module is changed, so no other function needed redeploying and `fetch-paper-metadata` kept its deployed source (its version counter still moved when the secret was installed — see the status box). `supabase/config.toml` declares `[functions.search-consensus] verify_jwt = false` — in-body authentication, exactly like the other functions; it does **not** make the function anonymous.

**Rollout order — EXECUTED 2026-10-03 → 2026-10-09; kept as the reference procedure; not a pending step.** Merging to `main` auto-deploys the frontend (§8), and the merged frontend shows the Consensus source to the owner, so the endpoint, and the secret it needs, had to exist first. The status box above records what was observed. **For any future change to `search-consensus`'s source or contract**, the same rule holds: deploy and verify the Edge change before the frontend that depends on it becomes live — every step below except 3–4. The key does **not** need installing again; steps 3–4 apply only to an explicitly authorized rotation or replacement.

```text
1.  independent review approves the exact PR head
2.  explicit owner authorization for the secret installation and the Production Edge deployment
3.  install the secret from a private file, so the value reaches neither shell history nor the
    process list (and is never pasted into a chat, PR, commit or log):
      umask 077 and write the single line CONSENSUS_API_KEY=<owner's key> to a new temp file
      supabase secrets set --env-file <that temp file> --project-ref <project-ref>
      delete the temp file
    Typing `supabase secrets set CONSENSUS_API_KEY=<key>` inline would store the key in history.
    `secrets set` rolls EVERY function's `version` by +1 without redeploying anything — prove
    that with each function's unchanged `ezbr_sha256`, `updated_at` and `entrypoint_path`.
4.  verify the secret BY NAME ONLY (`supabase secrets list` prints a digest — do not record it)
5.  deploy the exact approved head from a worktree byte-identical to it:
      supabase functions deploy search-consensus --project-ref <project-ref>
6.  verify the deployed source (`functions download --use-api` into a scratch workdir; byte-compare
    the closure above) and the owner-only boundary with the non-consuming checks below, and
    confirm with a read-only count — no ids recorded — that exactly one account holds role
    `owner` (the premise of privacy-data-flow-audit.md §37.2; the schema permits several)
7.  OPTIONAL, only if separately authorized: ONE controlled authenticated owner canary. It spends
    one call from the owner's monthly allowance; run it once, never in a loop
8.  re-check that the PR head is still exactly the approved one
9.  merge the exact head
10. the automatic Vercel Production deployment makes the owner UI live; run §9.3d
```

**Non-consuming verification.** None of these reaches Consensus, so none spends allowance:

- `OPTIONS` → 200 with the CORS headers;
- `GET` → `405 method_not_allowed`;
- `POST` with no `Authorization` → `401 unauthenticated`;
- `POST` with a valid **non-owner** token → `403 forbidden` (stops before the key is read);
- `POST` with the **owner's** token and `{"query": ""}` → `400 invalid_request` (proves the owner check passed, and stops before the key is read and before Consensus).

**Rollback — none has been performed.** Remove the UI first, then the endpoint — the control must never outlive its function. A frontend that stops passing `onConsensusSearch` hides the control at once. Unsetting `CONSENSUS_API_KEY` alone is also safe: the function then answers `503 not_configured` without calling Consensus. Like any secret change, unsetting it needs explicit owner authorization. No database state is involved.

**Expanding beyond the owner is a different project.** Access for managers or ordinary users, per-user keys, a commercial plan, pagination, filters, full-text chunks or Consensus-grounded synthesis would each change the quota, privacy and authorization model, and the published Privacy Policy would need an owner-approved update before any user other than the owner could send queries to Consensus ([privacy-data-flow-audit.md](privacy-data-flow-audit.md)).

---

## 8. Frontend deployment / Vercel

The frontend deploys from `main` to Vercel. The repository ships [`vercel.json`](../vercel.json) with a single SPA-rewrite rule (`/((?!assets/).*) → /index.html`); env vars are configured in the Vercel project dashboard, not in `vercel.json`.

**Vercel Git integration is the Production deployment model.** Merging to `main` creates a **Production** deployment on `app.paperlume.app` automatically; every pull-request head gets a **Preview** deployment. There is **no manual promote step**, and no `vercel deploy` is run by hand as part of the normal release path.

- Required client env vars (§3.1) must be configured in the Vercel project before any deploy that needs them.
- A Vercel build with either `VITE_*` var missing will produce a bundle that throws the client-env fail-fast error at module load in the browser console.
- Vercel is **not** a required GitHub status check — a failed or pending Vercel deployment does not block the **Merge** button. The required GitHub merge gates are `validate` and `db-tests` (§4).

What lives in the Vercel project settings rather than in this repository, and must be verified there rather than assumed:
- Deployment protection, build/environment configuration, and domain assignment.
- Rollback: use Vercel's deployment history (promote a prior READY Production deployment). Not codified here.

**Never hand-deploy the frontend to work around a failing merge.** If Production is wrong, either land a fix through the normal PR path or roll back through Vercel's deployment history.

---

## 8a. Production domain, DNS, and email architecture

> **Status.**
> - **2026-05-21 (C19):** brand / domain decision captured. No DNS records, no provider connections, no SMTP setup.
> - **2026-05-22 (operational setup PR — this section update):** owner has completed the **app-domain + transactional-auth-email half** of C19's pre-paid-beta checklist. `app.paperlume.app` is live on Vercel; Supabase Auth URL configuration is updated; Resend is configured with `auth.paperlume.app` and verified; Supabase Auth Custom SMTP routes through Resend; Auth email templates are Paperlume-branded; owner tested several auth emails — they arrive in the regular inbox (not spam) across multiple tested mailboxes; an import smoke test passed on the new domain. **Google Workspace business email, marketing-site setup, legal-page URLs, Paddle setup, and `APP_URL` Supabase secret remain pending.** Detailed status in the §8a checklist at the end of this section.

### Brand and domain

- **Working commercial brand:** **Paperlume** (working brand only — not a registered trademark; see C19 for the constraints and re-evaluation triggers).
- **Primary working domain:** **`paperlume.app`**, secured through **Cloudflare Registrar**.
- Cloudflare is both registrar and DNS control plane; Cloudflare nameservers are the source of truth for `paperlume.app`.
- `.app` is part of Google's HSTS-preload list and requires HTTPS — appropriate for a SaaS / web app; the hosting provider (Vercel) and Cloudflare both supply HTTPS automatically.

### Target URL layout (future — not configured yet)

| URL | Hosts | Notes |
|---|---|---|
| `paperlume.app` | Marketing site (landing, pricing, Contact Sales / Labs lead-capture, privacy / terms / AI disclosure / support / security pages) | Provider TBD (Framer / Webflow / Vercel / Cloudflare Pages / other). Owner picks at marketing-site setup time. |
| `www.paperlume.app` | Optional alias for the marketing site | Configured at marketing-site setup time. |
| `app.paperlume.app` | Authenticated React SPA, deployed on Vercel | This is the value of `APP_URL` in production once the Vercel custom domain is connected. |
| `auth.paperlume.app` | Transactional auth-email sending subdomain via Resend (Supabase Auth Custom SMTP target) | Used by Resend for SPF / DKIM / DMARC alignment. |
| `notifications.paperlume.app` *(optional, future)* | Broader transactional-email subdomain if auth email and product-notification email are split later | Not configured at MVP. |

The repo does not contain DNS record values; those are set in the Cloudflare dashboard when each subdomain is connected.

### Hosting (Vercel)

- Vercel remains the planned host for the authenticated React SPA per `vercel.json` and §8 above.
- Future production URL: **`app.paperlume.app`**.
- DNS remains managed in **Cloudflare**, not Vercel.
- **Initial-connection recommendation:** when first connecting `app.paperlume.app` to Vercel, use **DNS-only ("grey-cloud")** Cloudflare records — i.e., do not put Cloudflare proxy / orange-cloud in front of Vercel during initial setup. Vercel manages SSL / HTTPS certificates for `*.vercel.app` automatically; layering Cloudflare proxy on top during initial setup creates well-known SSL / caching / origin-CNAME issues that are easier to debug if you start in DNS-only mode and only later (if at all) enable proxy.
- Vercel custom-domain setup happens later, in its own PR / operator action — not in this PR.

### Marketing site

- The root `paperlume.app` will host the marketing surface.
- The marketing site must eventually serve:
  - **Landing page.**
  - **Pricing page** (Free / Pro / Labs-Teams Coming Soon — see [quotas-and-pricing.md §2](quotas-and-pricing.md)).
  - **Contact Sales / Labs lead-capture form** (per C12).
  - **Privacy Policy** (URL linked from the app per C16).
  - **Terms of Service** (per C16).
  - **AI disclosure** (what content goes to Google Gemini and how; per C14 / C16).
  - **Support / contact** (per C16).
  - **Security / data-handling page** (recommended for B2B credibility; not strictly required at MVP).
- Marketing-site provider selection is a separate owner decision in `owner-decisions.md §2.1`. **Not configured in this PR.**

### Business email (Google Workspace)

- **Future business email** is planned on **Google Workspace** on the `paperlume.app` domain.
- Likely addresses:
  - `maor@paperlume.app` (owner inbox)
  - `support@paperlume.app` (group or alias)
  - `billing@paperlume.app` (group or alias)
  - `legal@paperlume.app` (group or alias)
- Aliases / groups can route to a single inbox at MVP to minimize per-user license cost.
- Google Workspace setup adds operational credibility for Paddle KYB (per C18), vendor onboarding, B2B outreach, and support response. **It does not guarantee Paddle approval.**
- **Crossref operational contact.** `fetch-paper-metadata` identifies PaperLume to Crossref with `mutrisport@gmail.com` for now, because `support@paperlume.app` is not active yet (§7d). Once a dedicated PaperLume address resolves, moving Crossref to it means changing `CROSSREF_CONTACT_EMAIL` and redeploying `fetch-paper-metadata`, as its own small task.
- **Status: still pending owner setup.** Auth email delivery does not depend on Google Workspace — that is handled by Resend (next subsection). However: if any user-facing template (Auth email footer, marketing copy) references `support@paperlume.app` or another `@paperlume.app` address, that address **must resolve to a real inbox / group / alias before broader beta** — otherwise users replying to support get bounce-backs. Owner should ensure any address referenced in the customized Auth templates is reachable before the closed paid pilot.

### Transactional auth email (Resend → Supabase Auth Custom SMTP)

- **Resend** is the configured provider for **Supabase Auth Custom SMTP** — transactional auth email (signup confirmation, password reset, magic links / OTP if used, account-critical auth emails) routed via the **`auth.paperlume.app`** sending subdomain.
- Required DNS records on `auth.paperlume.app`: **SPF**, **DKIM**, and **DMARC** alignment per Resend's verification flow. **Configured and verified by the owner (2026-05-22).** Specific record values are not committed to the repo — they live in Cloudflare DNS for `paperlume.app` and are visible in the owner's Resend dashboard.
- **Supabase default SMTP** is fine for development and personal use; it **should not be used for production / commercial launch** — it has low daily limits, no per-domain reputation, and "from" addresses that look like Supabase rather than Paperlume. **The production Auth email path no longer relies on Supabase default SMTP** — all transactional Auth email routes through Resend on `auth.paperlume.app` since 2026-05-22.
- A custom-SMTP setup improves **operational control and deliverability posture** (per-domain reputation, on-brand "from" addresses, observable bounce / complaint rates). It does **not** guarantee perfect deliverability — Gmail / Outlook anti-spam decisions are upstream of any sender. **Ongoing deliverability still depends on**: domain reputation building over time, low bounce / complaint rate, correctly aligned SPF / DKIM / DMARC, gradual sending behavior (no sudden volume spikes), and template content quality (which the owner addressed in the customized Paperlume-branded Auth templates).
- **Owner smoke-test result (2026-05-22):** reset / signup auth emails now arrive in the regular inbox (not spam) across multiple tested mailboxes. This is consistent with branded Resend-authenticated email from a new sending subdomain after initial reputation training; **monitor over the next 2–4 weeks** for inbox stability as the `auth.paperlume.app` reputation continues to mature with Gmail / Outlook.
- The Resend API key, the Resend SMTP password, the DKIM selector private value, and any account / dashboard IDs **are not committed to the repo**. They live in the owner's password manager and in the Supabase Auth → SMTP Settings dashboard (Resend API key as the SMTP password).

### Billing provider (Paddle, per C18)

- `paperlume.app` is the domain Paddle will verify during KYB (per C18's owner-side setup gate in [owner-decisions.md §2.1](owner-decisions.md)).
- Paddle's customer-facing checkout / receipts / customer portal will render under `paperlume.app` branding (logo / colour set in the Paddle dashboard) once Sandbox setup completes.
- **C18 remains active.** Paddle integration is still blocked on owner-side setup. C19 (this section) records the domain that Paddle will use; it does not unblock the Paddle integration PR.

### Pre-paid-beta checklist (domain / email / hosting)

A separate, additive checklist that lives alongside the existing §4 / §5 pre-deploy work and the C18 owner-side Paddle setup gate. **Updated 2026-05-22** with the owner's operational-setup completion.

**Completed (owner setup, smoke-tested 2026-05-22):**

- [x] ✅ `paperlume.app` purchased via Cloudflare Registrar.
- [x] ✅ Cloudflare auto-renew confirmed on `paperlume.app`.
- [x] ✅ Cloudflare domain transfer-lock enabled.
- [x] ✅ Domain receipt / RDAP info saved privately (password manager, not the repo).
- [x] ✅ Vercel custom domain `app.paperlume.app` connected (DNS-only Cloudflare records on initial connection per the §8.1 recommendation; the authenticated app now runs on `https://app.paperlume.app`).
- [x] ✅ Supabase Auth **Site URL** updated to `https://app.paperlume.app` (Supabase dashboard → Authentication → URL Configuration).
- [x] ✅ Supabase Auth **Redirect URLs** updated to cover `https://app.paperlume.app/**`. The old Vercel default URL pattern is retained during the cutover window per the §1.4 safety note; remove after ~1–2 weeks of stability.
- [x] ✅ Resend account configured with `auth.paperlume.app` sending subdomain.
- [x] ✅ SPF / DKIM / DMARC records active on `auth.paperlume.app` and verified in Resend.
- [x] ✅ Supabase Auth Custom SMTP configured to use Resend (Supabase dashboard → Authentication → SMTP Settings).
- [x] ✅ Paperlume-branded Supabase Auth email templates configured (Reset Password, Confirm Signup, Magic Link as applicable — owner customized from the default minimal templates to include branding header, expiry note, "if this wasn't you" guidance, support contact, and plain-text fallback URL).
- [x] ✅ Signup, password-reset, and confirmation auth-email smoke tests passed end-to-end on multiple real inboxes (2026-05-22). Emails arrive in the regular inbox, not spam, in tested mailboxes.
- [x] ✅ No production auth-email path relies on Supabase default SMTP.
- [x] ✅ App import smoke test passed on `app.paperlume.app` after the URL cutover (existing identifier / file import flows continue to work; no regression from the domain change).

**Pending (still required before closed paid pilot):**

- [ ] Marketing-site provider chosen (Framer / Webflow / Vercel / Cloudflare Pages / other).
- [ ] Marketing site live at `paperlume.app` (root) with privacy / terms / AI disclosure / support URLs reachable.
- [ ] `www.paperlume.app` routing decided (optional marketing-site alias).
- [ ] Google Workspace configured on `paperlume.app` with business addresses live (`support@paperlume.app` must resolve to a real inbox / group / alias before broader beta — see the Google Workspace subsection above).
- [ ] Paddle KYB / domain verification completed using `paperlume.app` per C18.
- [ ] `APP_URL` Supabase secret on the Edge Function project set to `https://app.paperlume.app`. (No Edge Function reads `APP_URL` today; this is set when the Paddle integration PR ships.)

**Ongoing (post-completion monitoring):**

- Track auth-email inbox-placement rate as the `auth.paperlume.app` sending reputation matures with Gmail / Outlook (the first ~2–4 weeks of any new sending subdomain are the most volatile).
- Monitor Resend's deliverability dashboard for SPF / DKIM / DMARC pass rates and bounce / complaint rates.
- (Optional, recommended) Set up Gmail Postmaster Tools and Microsoft SNDS for receiver-side reputation visibility on `auth.paperlume.app`.
- Do **not** escalate DMARC from `p=none` to `p=quarantine` / `p=reject` for at least 2–4 weeks of stable pass rates.

When all the pending items above are ✅ alongside the existing C16 (legal-page URLs live), C18 (Paddle Sandbox / Live setup), and the launch-blocker items in [commercial-architecture.md §6](commercial-architecture.md), the web paid pilot is operationally ready.

### Operational notes (Do / Don't)

- **Do not** commit DNS record values, SMTP credentials, Resend API keys, DKIM private keys, account IDs, dashboard URLs, message headers, reset-link URLs, or any other provider-side artifacts to the repo. They live in Cloudflare / Resend / Supabase / Vercel dashboards and in the owner's password manager only.
- **Do not** paste screenshots of provider dashboards into PR descriptions or repo docs.
- If deliverability issues recur (e.g., emails start going to spam again), the first diagnostic step is **reading email headers** (`Authentication-Results:` line) and checking **Resend's deliverability dashboard** — not changing code. Deliverability problems are 99% configuration / reputation, not application code.
- The application code itself was **not modified** during the operational setup. The Supabase project URL didn't change, the `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` env vars in the Vercel project didn't change, no `package.json` change, no migration, no Edge Function deploy.

---

## 9. Post-deploy smoke checklist

Run from a real browser session signed into the production app. Tick each item; investigate any failure before declaring the deploy done.

### 9.1 General

- [ ] Sign in with a known account → Dashboard renders without console errors.
- [ ] Sign out → returns to `/auth` cleanly (no `Cannot read properties of null (reading 'id')` regression — PR #136 covers this; failure here is critical).
- [ ] Sign in again → Dashboard re-renders, paper list loads.

### 9.2 Search / filters

- [ ] Empty search → default list visible.
- [ ] Short search (1–2 chars) → ILIKE path; results appear.
- [ ] 3+ char search → FTS path; results appear with `Matched in: …` sub-line on matching rows.
- [ ] Quoted phrase search (e.g. `"muscle protein synthesis"`) → literal phrase match; results restricted to the phrase.
- [ ] Keyword filter (pick a keyword from the dropdown) → list filters; clear works.
- [ ] Save current filter as a preset → Saved Searches dropdown shows it; load it back → filters/search restore.
- [ ] Notes filter (`Has notes` / `No notes`) → correctly partitions.

### 9.3 Metadata import (Edge Function: `fetch-paper-metadata`)

- [ ] Add Paper → Bulk import → identifier `41912805` (the established post-deploy smoke PMID from PRs #120 / #121 — covers bounded `<Author>` parsing + `<CollectiveName>` consortium author support).
- [ ] Confirm the paper imports, metadata appears (title, authors, year), and no Edge Function error toast surfaces.
- [ ] Bonus: import a DOI to exercise the Crossref fallback path.

### 9.3b In-app PubMed search (Edge Function: `search-pubmed`)

Run after a `search-pubmed` deployment, or after a frontend change affecting the Search mode's PubMed source. The initial rollout completed on **2026-08-23**; its historical evidence is in [migration-history.md](migration-history.md). The boxes below stay unchecked because this is a reusable checklist, not a record of one run.

- [ ] Add Papers → **Search** (PubMed source) → query `resistance training hypertrophy` → press Search → results render with titles, authors, journal, date and PMID.
- [ ] The result count distinguishes the records shown from PubMed's total (e.g. `1–20 of 2,509`).
- [ ] Next / Previous move between pages; a selection made on page 1 is still counted on page 2.
- [ ] Select two results, optionally choose a Project/Tag, press **Import 2 Selected** → the papers import through the normal identifier path and the summary shows Added / Skipped — Duplicates / Failed.
- [ ] Re-importing an already-imported PMID reports it as **Skipped — Duplicates**, and creates no second row.
- [ ] A field-tagged query such as `("resistance training"[Title/Abstract]) AND muscle` returns sensibly different results from the plain-text one — proof the syntax reached PubMed unrewritten.
- [ ] No Edge Function error toast, and the Function logs show `pubmed-search q_len=… outcome=ok` with **no query text**.

### 9.4 AI analysis (Edge Function: `analyze-paper`)

- [ ] Open a paper with an abstract → Analyze → confirm TLDR / study type / statistical methods populate.
- [ ] Bulk-select 2 papers → Bulk Analyze → confirm the 3-second cooldown between calls and final summary toast (e.g., `2 succeeded, 0 failed`).
- [ ] Confirm no `AI Analysis failed` toast. A server-side configuration gap — a missing `GEMINI_API_KEY`, or an auto-injected var the runtime stopped supplying — surfaces exactly this way: a generic 500 whose toast reads *"Edge Function returned a non-2xx status code."* and **never names the variable**. Confirm which one from the Edge log: §10.3 for the key, §10.2 for the auto-injected vars.

### 9.3c AI organization suggestions (Edge Function: `suggest-paper-organization`)

Run after any deployment affecting `suggest-paper-organization` or a shared module inside its bundle. The initial rollout verification completed on **2026-08-23** and passed every check below, including one real generation; its evidence is in [migration-history.md](migration-history.md). The boxes stay unchecked because this is a reusable checklist, not a record of one run.

Non-destructive checks first — each is refused before Gemini is contacted and before a quota unit is spent, so none of them costs a request or touches user data:

- [ ] `OPTIONS` returns 200 with the CORS headers (preflight, answered before any auth).
- [ ] `GET` returns `405 method_not_allowed`.
- [ ] `POST` with no Authorization header returns `401 unauthenticated`.
- [ ] `POST` with a valid token and `{}` returns `400 invalid_request` with `reason: "invalid_paper_id"`.
- [ ] `POST` with a valid token, an owned `paperId` and a title-only draft returns `400 invalid_request` with `reason: "insufficient_evidence"`.
- [ ] `POST` with a valid token and a well-formed but **foreign** `paperId` (with an otherwise valid draft, so validation cannot short-circuit it) returns `404 paper_not_found`, and the message discloses nothing about the other account.

**These last two prove different things, and neither substitutes for the other.** The handler validates the request *before* it queries the paper:

```text
CORS → method → auth header → getUser() → request validation → paper ownership
     → taxonomy → provider-input build → consume quota → Gemini
```

- The **title-only** case proves worker boot, the Authorization path, `getUser()`, body parsing, and the eligibility rule — and that the request stops at validation, **before** `consume_ai_quota` and before Gemini, so it costs no AI request. It does **not** prove ownership was enforced: validation rejects it before the `papers` query ever runs, and it would return the same `400` even if the `paperId` were not the caller's.
- The **foreign-paper** case is the ownership proof, and only if its draft is otherwise valid. Give it a real title plus an abstract so it survives validation and actually reaches the ownership query; then the `404` shows the row was refused on ownership, and that no quota unit or provider call followed. A foreign paper sent with a title-only draft returns `400`, which tells you nothing about ownership.

Then, one real generation (this **does** spend one AI request):

- [ ] `POST` with an owned `paperId` and a draft carrying an abstract returns 200 with exactly the four keys `existingProjects`, `existingTags`, `newProjects`, `newTags`.
- [ ] Every `existingProjects[].id` / `existingTags[].id` is a Project/Tag that account actually owns, and no `P1`/`T1`-style ref appears anywhere in the response.
- [ ] Confirm in the Supabase dashboard that the account's `usage_counters` row for `ai_analysis` increased by exactly **one**, and that no `projects`, `tags`, `paper_projects`, `paper_tags` or `papers` row was created, changed or deleted by the call.
- [ ] Confirm the function logs carry counts and outcome labels only — no abstract text, no Project/Tag names, no raw Gemini body.

Finally, confirm the boundary held elsewhere:

- [ ] `analyze-paper` still returns its unchanged `tldr` / `studyType` / `statisticalMethods` contract, and its deployed version and bundle hash are unchanged.

**A transient provider failure is not a failed check — but under the current policy it is no longer absorbed.** During the initial rollout the one real generation hit an upstream `503` on its first attempt, retried after 2 s and succeeded: the bounded retry budget absorbed it, the user-visible result was a normal 200, and no refund was issued because a result was delivered. **That retry no longer happens.** PaperLume's permanent Gemini transport policy is 90 s per attempt with ZERO automatic retries (C46 in [decisions-and-triggers.md](decisions-and-triggers.md)), so a `503` now ends the sequence on attempt 1.

What to expect today: a `provider_status=` warning is **terminal** for that provider-call sequence, and is followed by a neutral provider-unavailable failure rather than by `outcome=ok`. The caller then attempts the established best-effort quota refund, which the log records as `refund=attempted` — that proves the refund path was invoked, not that the refund necessarily succeeded, and a refund-side issue never replaces the provider failure. That is the policy working as designed, not a regression. Re-run the check manually; another transient `503` on that separate operator-initiated invocation is the provider being unavailable, not this deployment failing. A real failure of *this* deployment is a non-200 whose logs show something other than a provider class — a contract, auth, quota or parsing error.

**Frontend acceptance (`001B`), for a release that changes the Edit Paper suggestion surface.** These checks are about the *client*, so run them against the deployed frontend with a real account. Note that the "one real generation" above already spends a request; plan for one more here, and prefer a throwaway Project/Tag name so the cleanup is trivial.

- [ ] Open **Edit Paper**. The **AI organization** section renders above the Projects selector, states that it uses **1 AI request** and that nothing is assigned until you save, and **no request has been made** — confirm in the network panel that opening the dialog (and letting the abstract load) calls nothing.
- [ ] With a title but no abstract, keywords or study type, the action is **disabled** and explains what to add. Confirm no request is sent.
- [ ] Open a paper whose abstract is **not yet cached** (a hard reload first, so the on-demand fetch really runs) and that also has keywords or a study type. While the abstract is loading the action is **disabled** and says the abstract is loading — *not* "add an abstract", which would be untrue. Confirm no request is sent during that window, and that the action becomes available once the abstract lands. This is the guard against paying for a generation whose answer the arriving abstract would immediately invalidate.
- [ ] Edit the abstract or study type **without saving**, then click Suggest. Confirm in the network panel that the request body carries the **unsaved** values, exactly the keys `paperId` / `draft` / `currentProjectIds` / `currentTagIds`, and no authors, notes, TLDR, PMID, DOI, URL, attachment, user id or quota field.
- [ ] Results render per category with a short reason each. A valid all-empty response renders the honest empty state ("No strong Project or Tag suggestions for this paper.") and **not** an error.
- [ ] Accept an existing Project and an existing Tag. Confirm the Projects/Tags selectors update, and that **no** `set_paper_projects` / `set_paper_tags` / `papers` request is made — acceptance must be local only.
- [ ] **Cancel** without saving, reopen the paper, and confirm neither the Project nor the Tag was assigned.
- [ ] Suggest again, press **Create & select** on a proposed new Project. Confirm the Project is created immediately (it appears in Manage Projects), the AI-proposed description was kept, and the paper is still **not** assigned until Save.
- [ ] Close without saving and confirm the created Project **remains in the library** while the paper stays unassigned — this is intended, and the UI says so.
- [ ] Throttle the network, press **Create & select**, and confirm **Save Changes is disabled** until the creation resolves — then that saving immediately afterwards assigns the new entity. Save must never be able to run ahead of a creation it would otherwise miss. **Cancel stays enabled** during that window by design; confirm that cancelling mid-creation persists no assignment even after the creation lands.
- [ ] Reopen, accept suggestions, press **Save Changes**, and confirm the assignments now persist after a reload.
- [ ] Rename an existing Project to match a proposed-new name, then press Create & select: the existing row is **selected**, not duplicated. With two rows whose names differ only by surrounding whitespace, confirm nothing is created and nothing is selected, and the UI asks the user to pick.
- [ ] The **AI requests** indicator refreshes after a generation (success or provider failure). Confirm it does **not** refresh when the click was intercepted before any request — an ineligible draft, or a known-zero allowance.
- [ ] An exhausted allowance shows AI-**request** wording ("You've used all N of your … AI requests"), never "AI analyses", and carries no upgrade/checkout copy. A provider failure shows the neutral "temporarily unavailable" wording instead — a Google rate limit must never be reported as the user's plan running out.
- [ ] No **Paper List** row action, bulk suggest action, or suggestion column appeared anywhere.
- [ ] On a phone-width viewport and with a finger: the section and every result action are reachable inside the Edit Paper scroll region, the dialog still has exactly one vertical scroll owner, the page behind the modal never scrolls, and the Select / Create & select / Dismiss targets are comfortably tappable.

### 9.3d Owner-only Consensus search (Edge Function: `search-consensus`) — deployed; owner acceptance passed 2026-10-09

Run once after the §7e rollout, and after any later change to `search-consensus` or the Consensus source. **Status (2026-10-09):** the §7e rollout is complete, and the owner's initial Production acceptance **passed** on 2026-10-09. One explicit search returned 20 importable results, and one selected DOI was added through the canonical PubMed/Crossref importer. The import required no additional Consensus search (§7e has the bounded evidence). That acceptance covered the owner search, import and log items below. The non-owner view, the reset on reopen and the no-DOI display were not part of the reported evidence. The unchecked boxes are the reusable template for future changes, not a record of the 2026-10-09 run. **Every Consensus search spends one call from the owner's monthly allowance**, so the authenticated items here run only when the owner has authorized spending one; the rest spend nothing. The boxes stay unchecked because this is a reusable checklist.

- [ ] Signed in as an ordinary (non-owner) user: Add Papers → **Search** shows the PubMed experience directly, with no source selector and no "Consensus" anywhere in the dialog.
- [ ] Signed in as the owner: Search shows the **PubMed | Consensus** selector, starting on **PubMed**. Choosing Consensus, typing and selecting make **no** request (browser network panel).
- [ ] *(Spends one call — authorize first.)* One Search with a natural-language question → one `search-consensus` request → up to 20 results; a result without a DOI shows "No importable DOI available" and has no checkbox; "Open in Consensus" opens `consensus.app` in a new tab.
- [ ] Select one result, optionally choose a Project/Tag, **Import 1 Selected** → the summary reads **Consensus Import Results** in the Added / Skipped — Duplicates / Failed vocabulary, listing the DOI. The library row carries the importer's canonical metadata, not Consensus's wording.
- [ ] Close and reopen Add Papers → Search starts on **PubMed** again.
- [ ] The Function logs show one `consensus-search outcome=ok q_len=… retry=0 …` line per search with **no query text, title, DOI or URL**.

### 9.5 Paper operations

- [ ] Add Paper manually → fills required fields → save → paper appears.
- [ ] Edit a paper → change title, notes, project, tag → save → list reflects.
- [ ] Delete a paper (single) → confirm row disappears.
- [ ] Bulk-select 2+ papers → Bulk Delete → confirm rows disappear and toast reads `Deleted N paper(s)` (PR #137 added the explicit `user_id` scoping to this path).

### 9.6 Projects / tags

- [ ] Manage Projects → rename a project → chip updates everywhere it's shown.
- [ ] Manage Projects → delete a project → confirm cascade behavior (paper.projects loses the chip; the paper itself remains).
- [ ] Manage Tags → same: rename + delete.

### 9.7 Attachments (only if part of the released change-set)

- [ ] Open a paper → upload a small PDF → confirm it appears in the attachments list.
- [ ] Delete that attachment → confirm it disappears and storage is cleaned (no orphaned file).
- [ ] **After `20260904120000` is applied:** delete an attachment, then confirm `attachment_cleanup_queue` holds **no** row for the signed-in user — the healthy path enqueues and drains within the same action, so a lingering row means physical cleanup did not complete. A row that IS present is not a failure of the delete; it is pending work that the next authenticated session retries.
- [ ] **After `20260904120000` is applied:** with a freshly loaded tab, delete an attachment and confirm it succeeds. A "Delete failed" here from a tab that has been open since before the deploy is the Storage fence doing its job, not a fault — reload and retry.
- [ ] **After `20260904120000` is applied:** with a freshly loaded tab, upload an attachment and confirm it succeeds. A failed upload from a tab open since before the deploy is the lifecycle boundary doing its job — that bundle writes metadata directly and no browser role holds `INSERT` any more — not a fault; reload and retry.
- [ ] **After `20260904120000` is applied:** with a freshly loaded tab, delete a paper (single and bulk) and confirm both succeed and that `attachment_cleanup_queue` ends empty. A "Failed to delete" from a tab open since before the deploy is the parent boundary doing its job: that bundle issues a direct `DELETE FROM papers`, and no browser role holds `DELETE` any more. All three symptoms together mean the frontend deploy has not reached that tab, never that the migration is broken.
- [ ] **After `20260904120000` is applied:** upload an attachment on a healthy connection and confirm the queue is **still** empty afterwards. A successful upload commits metadata and no cleanup intent; a queue row appearing after a *successful* upload would mean finalization and the tombstone disagree, which is a fault rather than pending work.

---

## 10. Troubleshooting

### 10.1 Missing client env vars

**Symptom:** Browser console shows `Missing required environment variable: VITE_SUPABASE_URL. Copy .env.example to .env.local and set VITE_SUPABASE_URL. See README.md → Local development.` (or the `PUBLISHABLE_KEY` variant).

**Cause:** Vercel project env var missing or empty; or for local dev, `.env.local` / `.env` not set up.

**Fix:** Set the missing var in Vercel Project Settings → Environment Variables → Production (and Preview / Development as needed). Redeploy. Locally: re-check `.env.local` exists and has both `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` non-empty.

### 10.2 Missing Edge env vars

**Symptom:** an Edge Function returns a **generic HTTP 500 that does not name the variable.** All seven deployed functions read `SUPABASE_URL` / `SUPABASE_ANON_KEY` through `requireEdgeEnv` **inside the request handler and inside that handler's outer `try`**, so the helper's actionable message is caught there, written to the Edge log — by `search-consensus` only as the bounded field `missing_env=<NAME>`, never as message text — and replaced by the function's own neutral body. **Diagnose from the Edge Function logs, not from the response.**

**For a request that reaches the environment check** (see the gates below), the neutral body differs per function; the log line is what names the variable:

| Function | Client sees (HTTP 500) | Edge log line |
|---|---|---|
| `analyze-paper` | `{"error": "Analysis failed. Please try again later."}` | `analyze-paper error: Missing required Edge Function environment variable: …` |
| `fetch-paper-metadata` | `{"error": "Internal server error"}` | `fetch-paper-metadata error: Missing required …` |
| `search-pubmed` | `{"error": "internal_error", "message": "Something went wrong. Please try again."}` | `search-pubmed error: Missing required …` |
| `suggest-paper-organization` | `{"error": "internal_error", "message": "Something went wrong. Please try again."}` | `suggest-organization error: Missing required …` |
| `delete-account` | `{"error": "account_deletion_failed", "message": "Your account could not be deleted. Please try again."}` | `delete-account: unexpected error: Missing required …` |
| `get-gemini-provider-quota` | `{"error": "Provider quota unavailable"}` | `get-gemini-provider-quota error: Missing required …` |
| `search-consensus` | `{"error": "internal_error", "message": "Something went wrong. Please try again."}` | `consensus-search outcome=internal_error missing_env=SUPABASE_URL …` — the variable is named by a bounded field, never by the error text |

`SUPABASE_URL` and `SUPABASE_ANON_KEY` behave identically in every function — only the variable name in the log differs. What the user sees in the app is generic in every case: each caller renders either the function's neutral `message` or its own fallback copy (Analyze falls back to supabase-js's *"Edge Function returned a non-2xx status code."*, since its body carries no `message` field). **No path renders the variable name.**

**Nothing is left half-done.** In all of them the check runs before any database read, quota RPC, provider call or deletion, so no quota unit is consumed and no refund, cleanup or rollback is required — `delete-account` in particular deletes nothing, and `search-consensus` reads no key and makes no Consensus request.

**Not every request reaches the check.** Every function answers `OPTIONS` first, and `search-pubmed`, `search-consensus`, `suggest-paper-organization` and `delete-account` reject a non-`POST` method next. All but `delete-account` then require an `Authorization` header to be **present** before constructing the Supabase client; `delete-account` instead requires that header to **parse** as `Bearer <token>`. A missing variable produces the 500s above only once those pre-env gates are passed. Preflight can still return 200, the method gates can still return 405, and a **missing** `Authorization` header still returns 401 — as does malformed bearer syntax, for `delete-account`. **None of those responses is evidence that the variable is present.**

**Presence is not validity.** Each pre-env gate tests only that a credential is *there*, never that it is good — `auth.getUser()` is what validates the token, and it runs *after* the client is constructed. A present-but-invalid or expired token therefore reaches the environment check and receives the generic 500, not a 401. Diagnose the missing-env condition with a genuine authenticated request; a preflight, a wrong-method probe, or a header-less `curl` cannot distinguish a missing variable from a healthy one.

**Cause:** The Supabase Edge runtime stopped auto-injecting one of these (unusual). Or a future migration to a different runtime exposed a gap.

**Fix:** Confirm the function deployed cleanly (`supabase functions deploy <name> --project-ref <project-ref>` exits 0). If yes, contact Supabase support — the auto-injection is platform-managed.

### 10.3 Missing `GEMINI_API_KEY`

**Symptom:** both Gemini consumers fail with a **generic HTTP 500**, and **neither names the secret in its response body** — that is deliberate, so the browser is never told which server-side configuration is missing. **Diagnose from the Edge Function logs, not from the response.**

| Function | Client sees | Edge log line | Quota |
|---|---|---|---|
| `analyze-paper` | 500 `{"error": "Analysis failed. Please try again later."}` | `analyze-paper error: GEMINI_API_KEY not configured in Supabase secrets` | The unit is consumed **before** this check, so the missing-key path calls `refund_ai_quota` before throwing. Since the C47 rollout (v33, 2026-09-25) that call goes through the server-only refund client (§3.3, §6.8). The refund is **best-effort**: if it fails it is logged (`analyze-paper refund_failed …=1`) and swallowed so the original error still surfaces. |
| `suggest-paper-organization` | 500 `{"error": "internal_error", "message": "Something went wrong. Please try again."}` | `suggest-organization provider_key_missing env=GEMINI_API_KEY` | The key is checked **before** `consume_ai_quota`, so **no unit is consumed and no refund is required**. |

Both fail before any Gemini provider call is made, so a missing key costs nothing upstream. The ordering difference is the useful diagnostic: if Analyze is failing you will also see a refund attempt in its log, whereas Suggest never reaches the quota RPC at all.

**Since `AI-MULTI-PROVIDER-001C` (C41) the missing variable is the SELECTED provider's.** Each operation reads exactly the credential for the provider its request resolved to, via `_shared/aiProviderCredentials.ts`. For a request routed to Google, both log lines above are unchanged apart from Suggest's added `env=` suffix. For a request routed to an Anthropic or OpenAI row, the same lines name `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` instead: `analyze-paper error: <NAME> not configured in Supabase secrets` and `suggest-organization provider_key_missing env=<NAME>`. **A missing non-Google key never falls back to `GEMINI_API_KEY`.** The quota behaviour above is preserved: Analyze refunds, and Suggest still fails before the quota unit. Suggest now calls `get_current_user_access` first, because which key to check depends on the selected provider, but that is a read and spends nothing.

**Fix:**

```sh
supabase secrets set GEMINI_API_KEY=<your-gemini-api-key> --project-ref <project-ref>
```

No code redeploy needed; the next function invocation picks up the new secret.

### 10.4 Migration dry-run shows unexpected migrations

**Symptom:** `supabase db push --dry-run` lists migrations you don't recognize, or more migrations than the PR added.

**Fix:** **Stop. Do not run `supabase db push`.** Run `supabase migration list --linked` and compare Local vs. Remote columns. If they disagree on rows you didn't expect, you're in a ledger-drift scenario — see [`migration-history.md`](migration-history.md) under the PR #131 / #132 entries for the audit-then-repair pattern, and treat the situation as its own audit task before touching production.

### 10.5 Edge Function deploy fails

**Symptom:** `supabase functions deploy <name>` exits non-zero or surfaces a Deno bundling error.

**First checks:**
- Import paths inside the function: relative imports must end in `.ts` (e.g. `import { requireEdgeEnv } from "../_shared/env.ts";` — note the explicit extension).
- HTTPS imports (`https://esm.sh/...`) must be reachable; transient `esm.sh` outages do happen.
- The function references `Deno.env` / `Deno.serve` / similar — these are Deno-only and won't typecheck in the project's `tsc` run; that's expected. The `/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />` triple-slash at the top of each function is what makes them resolve under the Supabase deploy bundler.
- If the function imports from `_shared/*`, confirm the shared file actually exists in `main` (a feature-branch-only shared file would deploy fine from your worktree but break a different operator).

### 10.6 Frontend deploys but blank screen

**Symptom:** Vercel build succeeds but the deployed page is blank with a console error.

**Fix:** Check the browser console first. The two most common causes today are §10.1 (missing client env var, throws at module load) and a transient Supabase outage (network error in `auth.getUser()` after sign-in attempt). The PR #138 fail-fast covers the first cleanly; the second isn't an app bug.

---

## 11. What not to do

- **Do not commit `.env.local`, `.env.test`, or any file containing a real secret.** Both names are gitignored already (`.gitignore` lines 2–4 cover the pattern); don't override the ignore.
- **Do not paste real secrets** (Gemini key, JWT, service-role key, OAuth secret) into a chat, PR description, commit message, or this doc.
- **Do not use service-role keys in client code.** The repo currently has zero service-role references in `src/` (verified). Keep it that way. RLS plus the SECURITY DEFINER `auth.uid()` guards from PR #130 are the security boundary. Since the C47 rollout (2026-09-25, §6.8), the one server-only RPC, `refund_ai_quota`, is granted to `service_role` alone and is called only by the two generation Edge Functions. Never grant it back to `authenticated` and never add a caller-scoped fallback for it.
- **Do not run `supabase db push`** for docs-only or client-only PRs. Even if it's a no-op, it adds noise; with stale local state it can re-trigger already-applied migrations.
- **Do not run `supabase db push --include-all`** unless you are deliberately reproducing the PR #131 / #132 reconciliation pattern with the same audit-first discipline. The `--include-all` flag bypasses ordering safety.
- **Do not run Playwright against Production or any linked/cloud Supabase project.** The supported lifecycle is `npm run test:e2e:local` on an ephemeral local stack; a bare `npm run test:e2e` fails closed by design. Do not work around the guard.
- **Do not assume Vercel deploys Edge Functions.** It doesn't. Edge Function code only updates via `supabase functions deploy <name>`.
- **Do not deploy a frontend that depends on a migration before the migration is applied.** Order: migration → Edge Function (if any) → frontend.
- **Do not spend the owner's Consensus allowance casually.** An authenticated Consensus search — a canary, a smoke check, a debugging retry — consumes a call from the owner's small monthly pool (shared with the owner's Consensus MCP usage). Run one only with explicit authorization, once, and never in a loop. Never put `CONSENSUS_API_KEY` in a `VITE_` variable, a URL, a log or a report, and never record its `secrets list` digest.

---

## 12. Quick links

- [README → Environment setup](../README.md#environment-setup) — local dev env file convention.
- [README → Supabase Edge Functions](../README.md#supabase-edge-functions) — short-form deploy commands + secrets table.
- [docs/start-here.md](start-here.md) — handoff narrative for fresh assistants; recent hardening history.
- [docs/migration-history.md](migration-history.md) — every prior deploy / migration / hotfix entry, including the PR #131 / #132 reconciliation pattern.
- [docs/decisions-and-triggers.md](decisions-and-triggers.md) — S1 / S2 ownership-scoping rules and re-evaluation triggers.
- [docs/documentation-policy.md](documentation-policy.md) — the "every meaningful change updates docs" rule that gates every PR.

---

## 13. Owner/Manager access + Gemini provider quota (OWNER-MANAGER-ACCESS-AND-GEMINI-QUOTA-001)

> **Status (updated 2026-07-28): backend deployed and verified; the provider-quota dashboard is DEFERRED under decision C29. PR #168 is MERGED** — regular exact-head merge commit `a1fc2cea53e33c8b34c557c7087236a939bb783c` (2026-07-28); merged-main `Validate` run `30357049945` succeeded and the Vercel **Production** deployment `dpl_Bx1GyYog6KCDUjHtcHTFVWqySwoV` is **READY** on `app.paperlume.app`. The GitHub merge applied **no** migration and deployed **no** Edge Function — Supabase migrations and functions were deployed separately (under the earlier staged steps) and are unchanged. No development-phase deployment action is currently required.
>
> **Current Production state (all under staged, individually-authorized steps):**
> - **Migrations applied:** `20260725090000` **and** the grant-hardening `20260726120000` (which `REVOKE`s direct `internal_user_access` privileges from `PUBLIC`/`anon`/`authenticated` as defense in depth atop FORCE RLS + no policy). Ledger aligned through `20260726120000` (68 rows).
> - **Owner bootstrap complete and verified** (owner internal role + AI-quota exemption + Pro-baseline entitlement, confirmed via the read-only RPCs; usage history preserved; no subscription/billing identity created).
> - **Google Monitoring configured:** `monitoring.googleapis.com` + `iam.googleapis.com` enabled on the Gemini project; a narrowly-privileged Monitoring service account holds **only** `roles/monitoring.viewer`; the three Google Edge secrets `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_MONITORING_CLIENT_EMAIL`, `GOOGLE_MONITORING_PRIVATE_KEY` are set (`GEMINI_MODEL` intentionally unset).
> - **Deployed functions:** all functions committed under `supabase/functions/` are deployed and ACTIVE. Deployed version numbers are volatile — read them back with `supabase functions list --project-ref <project-ref>` rather than trusting a snapshot recorded here.
> - **Billing intentionally DISABLED** on the Gemini project; **provider monitoring is unavailable** (the deployed provider-quota function's Cloud Monitoring call returns HTTP 403 — see the read-only evidence in decision **C29**). Read-only investigation confirmed: billing disabled, **no** project-level IAM deny policy, **no** parent org/folder.
> - **Frontend no longer calls or renders provider monitoring.** Under **C29** (scope normalization task 001Y) the frontend provider-quota card, fetch hook, client library, their tests, and the orphaned query key were removed. The deployed provider-quota function is **retained but intentionally unused** — deferred infrastructure, not active product functionality.
> - **No Production rollback or deletion occurred in 001Y.** No migration, secret, Edge deploy/invocation, Google/billing/IAM, Vercel, or merge mutation was performed by the scope-normalization task.
>
> **Do NOT enable Google Cloud billing during development.** Under C27 (commercialization paused) + C29 (Free Tier), the correct posture is the working Gemini Free Tier with billing off; Gemini usage/limits are checked **manually via Google AI Studio**. Reactivating the dashboard (and any billing change) requires a new explicit commercialization decision. See decisions **C28** and **C29** in [decisions-and-triggers.md](decisions-and-triggers.md).

This feature adds internal `owner`/`manager` roles (separate from the commercial plan) and an owner AI-quota exemption — **both active in Production**. It also included a manager-only view of the **shared** Google Gemini provider quota, which is **deferred under C29**; the runbook below (§13.1–§13.5) is retained as the **deferred reactivation sequence for commercialization** and is **not** a development-phase task.

### 13.1 Google Cloud prerequisites (owner-side; not repo actions) — DEFERRED (reactivation only)

> **Deferred under C29.** §13.1–§13.5 are the **reactivation runbook for when commercialization resumes** — they are **not** development-phase steps. The Google Monitoring API, service account, `roles/monitoring.viewer`, and Edge secrets already exist from the C28 staged deployment; the deployed provider-quota function is retained but unused. During development, do **not** run these steps, and do **not** enable billing.

Required before the provider-quota panel can return data. Absent, the panel fails soft ("not configured") and ordinary analysis is unaffected.

1. **Identify the Google Cloud project** that owns the Gemini (`generativelanguage.googleapis.com`) usage → its ID becomes `GOOGLE_CLOUD_PROJECT_ID`.
2. **Enable the Cloud Monitoring API** (`monitoring.googleapis.com`) on that project.
3. **Create a narrowly-privileged service account** dedicated to Monitoring reads.
4. **Grant it exactly `roles/monitoring.viewer`** — nothing broader. It needs no Gemini, billing, or write permissions.
5. **Create a JSON key** for that service account and capture `client_email` and `private_key`. Store securely (password manager); **never commit it, paste it into a PR, or expose it to the browser.**

The **implementation PR does not** create the service account, enable APIs, create a key, or alter IAM — those are owner-side actions performed at deploy time.

### 13.2 Supabase Edge secrets

Set on the linked project (names only shown by `secrets list`; values never displayed):

```sh
supabase secrets set GOOGLE_CLOUD_PROJECT_ID=<project-id> --project-ref <project-ref>
supabase secrets set GOOGLE_MONITORING_CLIENT_EMAIL=<sa-email> --project-ref <project-ref>
supabase secrets set GOOGLE_MONITORING_PRIVATE_KEY="<pem-with-\n-newlines>" --project-ref <project-ref>
# Optional, only to override the model alias (defaults to gemini-flash-latest):
# supabase secrets set GEMINI_MODEL=<model> --project-ref <project-ref>
```

These are **backend-only** Edge secrets. They are **never** `VITE_`-prefixed and **never** reach the client bundle (see §3.1's service-role warning — the same rule applies to Monitoring credentials). The private key's escaped `\n` newlines are normalized in the function; either literal or escaped newlines are accepted.

### 13.3 Owner bootstrap runbook (bounded, deployment-time; separately authorized)

The Production owner grant is **not** in the schema migration (an environment-specific email must not run in every environment). It is a bounded, one-time transaction performed **after** the migration applies, under its own explicit authorization. Target account: `maor29994ps5@gmail.com`.

The transaction must:

1. **Resolve exactly one** `auth.users.id` for `maor29994ps5@gmail.com`; **abort unless exactly one** row matches.
2. **Upsert `internal_user_access`** for that UUID: `role = 'owner'`, `ai_quota_exempt = true` (record a bounded metadata reason such as an internal-owner grant if compatible).
3. **Update the owner's `user_entitlements`** to the current Pro baseline (see [quotas-and-pricing.md](quotas-and-pricing.md) §2): `plan = 'pro'`, `plan_status = 'active'`, current Pro `paper_limit` (10,000), Pro `storage_quota_bytes` (2 GB), `ai_lifetime_quota` appropriate to Pro (0 — Pro uses the monthly bucket), current Pro `ai_monthly_quota` (350), `premium_taxonomy_enabled = true`, `labs_team_enabled = false`.
4. **Preserve prior usage history** (do not reset `usage_counters`).
5. **Create no subscription** and **set no billing-provider identifiers** — the owner is not a Paddle customer.
6. **Verify afterward via read-only RPCs** (`get_current_user_access`, `get_ai_quota_status`) that the owner resolves to role `owner`, `is_internal = true`, `can_view_provider_quota = true`, `ai_quota_exempt = true`, plan `pro`/active, and `is_exempt = true` with `reason = quota_exempt`.

A manager is granted the same way but with `role = 'manager'` and **without** `ai_quota_exempt` (managers are not auto-exempt).

### 13.4 Deployment order (each Production mutation separately authorized) — DEFERRED (reactivation only)

> **Deferred under C29.** The backend steps (migrations, owner bootstrap, secrets, function deploys for `analyze-paper` and `get-gemini-provider-quota`) are **already complete**. This ordered sequence is retained for a future commercialization reactivation of the dashboard; step 9's "frontend head" no longer includes a provider-quota surface (removed under C29). Do not enable billing as part of development.

1. Independently approve the exact PR head.
2. Owner configures/confirms the Google Cloud Monitoring project (§13.1 steps 1–2).
3. Create the narrowly-privileged service account; grant `roles/monitoring.viewer`; create + securely provide the key (§13.1 steps 3–5).
4. **Apply the approved migration:** `supabase db push` (§6 sequence) — applies `20260725090000` only.
5. **Owner bootstrap** (§13.3) — bounded UUID/role/entitlement transaction.
6. **Set the Google Edge secrets** (§13.2).
7. **Deploy the Edge Functions:** `supabase functions deploy get-gemini-provider-quota --project-ref <project-ref>` and, because it changed, `supabase functions deploy analyze-paper --project-ref <project-ref>`.
8. **Verify role security + provider data** (§13.5).
9. **Merge the exact approved frontend head**; verify merged-main CI + the automatic Vercel Production deploy.
10. Owner-account runtime smoke test (§13.5).

### 13.5 Verification checklist (post-deploy)

> **Under C29 there is no provider-quota panel in any build** (the frontend surface was removed). The panel-rendering bullets below apply **only to a future commercialization reactivation**. The owner AI-exemption and role checks (below) remain active and verifiable today.

- [ ] Ordinary user: `get_current_user_access` returns role `user`. (Deferred reactivation: the provider-quota panel would be **not rendered**, and the deployed Edge Function still returns **403** if called directly — currently it is never called from the client.)
- [ ] Owner: AI indicator shows **"Unlimited"**; an analysis succeeds even past the nominal Pro cap and is still counted. (Deferred reactivation: the panel would render.)
- [ ] Manager (if granted): a manager who is not exempt still enforces the normal quota. (Deferred reactivation: the panel would render.)
- [ ] Deferred reactivation only: the provider panel shows shared/project-level quota with the approximate/lag/Pacific-reset caveats, or a bounded "temporarily unavailable" if Monitoring is not returning data.
- [ ] No credential/token/private-key material appears in Edge logs or any response body.
- [ ] `usage_counters` is still `FORCE RLS` with no client SELECT policy; `internal_user_access` is not readable by the client.

### 13.6 Secret rotation

Rotate a Monitoring credential by creating a new service-account key in Google Cloud, then:

```sh
supabase secrets set GOOGLE_MONITORING_CLIENT_EMAIL=<sa-email> --project-ref <project-ref>
supabase secrets set GOOGLE_MONITORING_PRIVATE_KEY="<new-pem>" --project-ref <project-ref>
```

Rotation takes effect on the next function invocation **because both in-memory caches are keyed by a non-sensitive credential identity**. The OAuth token cache is keyed by the service-account email, the project id, and a SHA-256 fingerprint of the private key. The provider-response cache is keyed by that **full credential identity plus the configured model** (project, model, service-account email, private-key fingerprint) — the fingerprint is computed *before* the response-cache lookup. So when any of email, project, model, or key changes, the identity changes, neither cache is reused, and the new credential is exercised on the next call rather than returning a response produced under the previous credential. (The raw private key is never used, stored, or logged as a cache key — only its fingerprint.) No code redeploy is needed. **Delete the old key in Google Cloud** after confirming the panel still returns data. Never place Monitoring credentials in any `VITE_`-prefixed variable, the client bundle, a PR description, or a commit.

### 13.7 Monitoring query behavior (implementation notes)

- **One metric type per request.** Google Cloud Monitoring rejects a `timeSeries.list` filter that ORs several metric types, so the function issues **one request per metric type** (`filter = metric.type = "<one>"`) — the six supported types (request + input-token, each limit/usage/exceeded), across a daily and a minute window (12 requests), each following `nextPageToken` to completion. Results are combined only after all responses are parsed. `*_internal` metrics are never queried.
- **Minute DELTA aggregation uses `ALIGN_SUM`, not `ALIGN_DELTA`.** To total a count inside a 60-second quota bucket the minute-window usage/exceeded requests use `aggregation.perSeriesAligner = ALIGN_SUM` with `aggregation.alignmentPeriod = 60s`. `ALIGN_DELTA` (which computes differences between samples) is never requested for any metric. GAUGE **limit** metrics are fetched **unaligned** and their newest reported point is selected (aligning a gauge as DELTA/SUM would be invalid).
- **Daily usage** sums raw (unaligned) DELTA points from the current **Pacific-day** boundary (DST-safe; resolved via the wall-time→UTC fixpoint, not by subtracting wall-clock elapsed time).
- **Minute usage combines only synchronized buckets.** Each contributing series' newest complete 60-second bucket is grouped by its `interval.endTime`; the value shown sums **only the newest bucket-end timestamp that every contributing series shares**. Data from different minute intervals is never combined (a 12:03–12:04 value is never added to a 12:04–12:05 value), and an absent/forming series is never treated as zero. When the series share no common complete bucket, usage/exceeded is null (never fabricated), and `remaining` stays null unless both usage and limit are known for a reliable window.
- **Pagination never silently truncates.** Each metric's pages are followed to completion. If the safety page bound is reached while a `nextPageToken` still remains, the collector fails that collection rather than presenting partial data as complete — it becomes the bounded `unavailable` result below (the token and raw body are never exposed).
- **Fail-soft:** missing credentials, a disabled API, an HTTP failure, a timeout, or pagination overflow yield a bounded `status: "unavailable"` result (HTTP 200) with no raw Google body — the panel is observational only and never blocks user analysis. Values are approximate and may lag; do not present them as real-time or guaranteed.

---

## 14. Paid provider activation (AI-MULTI-PROVIDER-001E) — COMPLETE (Phase 8 applied 2026-09-19)

**Current state (2026-09-19): the rollout is COMPLETE. Claude Sonnet 5 and GPT-5.6 Terra are user-selectable for entitled accounts.** Phase 8 was owner-authorized and applied on 2026-09-19: PR #289 merged as the two-parent commit `38b22c209591a5f5ac2d80498bb55d082dde6d22`, and one `supabase db push --linked` applied `20260918210017_activate_paid_provider_model_selection.sql` (ledger **84 → 85**). It moved exactly two catalog flags — `anthropic/claude-sonnet-5` and `openai/gpt-5.6-terra`, `selectable` **false → true** — and nothing else: the four Google rows are byte-unchanged, `reasoning_selectable` was still false on all six rows and `set_current_user_ai_reasoning` still granted to nobody **when this phase finished** (both were released later the same day by `AI-MANUAL-REASONING-001`, §15), the system default is still Google, and no preference, entitlement or quota row was written. **Entitlement remains the authority for WHO may select a model**; activation only changed WHAT is choosable, and a non-entitled account still resolves to the system default. No new provider canary was required — Phase 7 had already exercised all four operations live — and no Edge deployment or secret change accompanied Phase 8. The steps below are the executed record.

**Earlier state, for the record (2026-09-18): steps 1–10 were done and Phase 8 was not.** The owner authorized the rollout; PR #287 merged as `ef8ad768`; the Privacy Policy amendment is live with effective date September 18, 2026; migration `20260917201856` is applied (ledger 84, six catalog rows); both paid-provider secrets are installed; both generation functions were redeployed from `ef8ad768`; and the Claude Sonnet 5 and GPT-5.6 Terra Phase-7 canaries passed. **Both paid models remain `selectable = false` and manual reasoning remains disabled, so no ordinary user can select or reach either provider.**

The deployed generation runtime already **contained** both adapters (Phase 6), so this was not an adapter rollout. It is a credential + catalog rollout, and each step below was separately authorized.

### 14.1 Ordered rollout

1. ~~Independent exact-head review of the Draft PR.~~ **DONE.**
2. ~~**Owner approval of the exact Privacy Policy wording**, and re-checking the effective date against the actual publication date (§14.5).~~ **DONE** — September 18, 2026.
3. ~~Merge. The Vercel deploy publishes the amended policy.~~ **DONE** — PR #287, merge `ef8ad768`.
4. ~~Apply migration `20260917201856`.~~ **DONE 2026-09-18** — ledger 83 → 84, six rows, both paid rows `selectable = false`.
5. ~~Install `ANTHROPIC_API_KEY`.~~ **DONE 2026-09-18.**
6. ~~Install `OPENAI_API_KEY`.~~ **DONE 2026-09-18** — both installed in one `secrets set --env-file`, values read from the operator environment and never echoed; 12 → 14 secrets, no other secret changed.
7. ~~**Deploy both generation functions together** from the exact accepted merge (§6.6a).~~ **DONE 2026-09-18** — from `ef8ad768`: `analyze-paper` → **v29**, `suggest-paper-organization` → **v13**, read back byte-identical to the commit. Required even though the adapters were already deployed: the new **price records** live in the bundle, and without them every paid estimate would be `unpriced` — the canaries confirm they are not.
8. ~~Phase 7 Claude canaries (§14.2).~~ **PASSED 2026-09-18** — Analyze (`automatic` → `off`) and Suggest (`automatic` → `medium`), one attempt each.
9. ~~Phase 7 OpenAI canaries.~~ **PASSED 2026-09-18** — Analyze (`automatic` → `none`) and Suggest (`automatic` → `medium`), one attempt each.
10. ~~Inspect routing, quota, telemetry, usage and cost.~~ **DONE** — see the acceptance record below.
11. ~~Phase 8: create and apply the selectable-activation migration (§14.4).~~ **DONE 2026-09-19** — `20260918210017` applied, ledger 84 → 85, exactly two rows changed.
12. **Settings discovery verified read-only 2026-09-19**; a live user-selected invocation per provider is **not done and is not required for activation** — Phase 7 already exercised Analyze and Suggest against both providers through the real Production endpoints (§14.1a). Verifying it now would mean spending a real user's quota on a paid provider, so it is left to ordinary use.

> Secrets note: one `supabase secrets set` bumps **every** Edge Function's version with no redeploy — observed again on 2026-09-18, when all six went +1 with byte-identical bundles. Record versions before and after, and gate any "did a secret change?" check on the manual subset rather than an all-rows fingerprint.

#### 14.1a Phase-7 acceptance record (2026-09-18)

Four provider calls, one attempt each, on the dedicated acceptance account's retained synthetic canary paper. Telemetry went 3 → 7 events with no event from any other account in either window; the account's lifetime AI quota went 2 → 6 (+1 per successful operation); every estimate was `estimated` (never `unpriced`), and each amount recomputed exactly from the stored rates.

| Provider / model | Operation | Reasoning | Input / output tokens | Estimated list price | Price record |
|---|---|---|---|---|---|
| `anthropic/claude-sonnet-5` | Analyze | `automatic` → `off` | 1,105 / 102 | $0.003230 | `anthropic/claude-sonnet-5@2026-09-17` |
| `anthropic/claude-sonnet-5` | Suggest | `automatic` → `medium` | 1,863 / 200 | $0.005726 | `anthropic/claude-sonnet-5@2026-09-17` |
| `openai/gpt-5.6-terra` | Analyze | `automatic` → `none` | 555 / 67 | $0.001914 | `openai/gpt-5.6-terra@2026-09-17` |
| `openai/gpt-5.6-terra` | Suggest | `automatic` → `medium` | 887 / 125 | $0.003274 | `openai/gpt-5.6-terra@2026-09-17` |

Total $0.014144. Other properties verified: `model_selection_source = user_preference` on all four; `provider_attempts = 1` on all four; `usage_status = reported` with `has_unmodeled_usage = false`; Suggest mutated no paper, Project, Tag or assignment; the canary paper was unchanged; and the bounded Edge log windows contained no key, identity, token, title/abstract fragment or provider body, with `usage_telemetry recorded=1` for each call and no `recorded=0`.

Two provider behaviours worth recording, neither a failure: **both** providers reported zero reasoning tokens even at `medium` (a requested level is not spent thinking), and Terra reported `cache_write_tokens` explicitly as 0 — had it omitted the field the estimate would have been `usage_incomplete` rather than `estimated`.

After both blocks the acceptance account was restored to its exact pre-canary state (§14.2).

### 14.2 Phase 7 canary design — routing a non-selectable model

> **Historical as of 2026-09-19, and deliberately retained.** Phase 8 made both rows `selectable = true`, so the constraint below no longer describes the live catalog. The procedure is kept because it is the reusable recipe for canarying **any** future staged model — and because the entitlement trap it documents is a live property of the resolver, not a fact about these two rows.

**The constraint (as it stood during Phase 7).** Both staged rows were `selectable = false` on purpose (C43), so `set_current_user_ai_model` refused them and Settings never listed them. A canary therefore had to route the model **without** making it selectable.

**A saved preference alone is NOT enough, and the failure is silent.** This was discovered during the 2026-09-18 run and corrected here. `resolveEffectiveAiModel` (`supabase/functions/_shared/aiModelSelection.ts`) applies three gates **in this order**:

```text
1. entitlement   rpc get_current_user_access() → can_select_ai_model must be true
2. preference    user_ai_preferences.preferred_model_id must exist and be well-formed
3. catalog row   ai_model_catalog: must exist, be enabled, and name a REGISTERED provider
```

Entitlement is checked **before** the preference is ever read, and `can_select_ai_model` is `user_entitlements.ai_model_selection_enabled AND plan_status IN ('active','trialing')` (`20260902120000`). The dedicated acceptance account is a **free** account, and free rows keep the column's `DEFAULT false`. A preference written for a non-entitled account is therefore ignored with `fallback("not_entitled")` — which is in `QUIET_REASONS`, so **nothing is logged**. The request silently runs on the Google system default instead, spends a quota unit, and writes a telemetry row that says `provider = google`. Every surface looks healthy; only the telemetry's provider column reveals that the "paid canary" never reached the paid provider.

**The approved bounded mechanism.** An operator, as the `postgres` role, temporarily grants the capability **and** writes the preference, for the **dedicated acceptance account only**, per provider block:

```sql
-- One transaction per step; ideally one DO block so preconditions, both
-- writes and the postconditions commit together or not at all.
-- The account is identified from PAPERLUME_PROD_ACCEPT_* in the operator
-- environment; its email and UUID are never printed into a report or doc.
-- Matching it by sha256(user_id) keeps the UUID out of the SQL text too.
BEGIN;
  -- 1. capture the pre-canary state: the entitlement flag AND the preference
  --    row (which may not exist at all)
  SELECT ai_model_selection_enabled FROM public.user_entitlements WHERE user_id = :acceptance_uid;
  SELECT preferred_model_id, preferred_reasoning_level
    FROM public.user_ai_preferences WHERE user_id = :acceptance_uid;
  -- 2. temporarily grant the capability — this account only
  UPDATE public.user_entitlements
     SET ai_model_selection_enabled = true
   WHERE user_id = :acceptance_uid;
  -- 3. point it at the staged model, leaving reasoning Automatic (NULL)
  INSERT INTO public.user_ai_preferences (user_id, preferred_model_id)
  VALUES (:acceptance_uid, 'anthropic/claude-sonnet-5')
  ON CONFLICT (user_id) DO UPDATE SET preferred_model_id = EXCLUDED.preferred_model_id;
COMMIT;
```

**Why this is the safest bounded mechanism, and not a shortcut.** It adds no code, no flag and no second authorization surface. It touches exactly two rows belonging to exactly one disposable acceptance account. It leaves `selectable = false` untouched, so **no other user's reachable set changes at any point** — which a temporary `selectable = true` flip would not achieve, since a preference saved during the window would survive the revert. And it does not weaken the product rule: entitlement still gates model selection for everyone, including this account, outside the window.

**What must NOT be done instead:** changing `can_select_ai_model`'s definition, granting the capability to a real user's account, adding an operator allowlist to the resolver, or flipping `selectable`. Entitlement semantics are a product rule; do not redefine them to make a canary convenient.

**Restore, on every exit path — success or failure.** Replay the captured preference value, or `DELETE` the row if there was none; then set `ai_model_selection_enabled` back to its captured value. Verify by re-reading through **both** the operator connection and the account's own RLS session (`get_current_user_access().can_select_ai_model` must be `false` again). Run the restore even if the provider call failed, and keep it idempotent so it can be retried — the one-attempt rule governs provider calls, not cleanup.

**One column cannot be restored exactly.** `user_entitlements` carries a `BEFORE UPDATE` trigger (`update_user_entitlements_updated_at`), so the row's `updated_at` moves and stays moved. Prove restoration on the substantive fields instead — e.g. `md5(to_jsonb(e) - 'updated_at' - 'ai_model_selection_enabled')` for that row, plus a whole-table md5 of `user_ai_preferences`, which does return byte-identical when the pre-canary state had no row.

**Per-provider canary checklist** (run on the acceptance account, one operation at a time):

- exactly **one** provider call per operation (`attempts = 1` in telemetry; no retry on Anthropic by design);
- telemetry row records the expected `provider` and `provider_model`;
- reasoning source and level match the catalog row (Analyze `off`/`none`, Suggest `medium`);
- usage dimensions present and internally consistent (subsets ≤ parents);
- cost estimate is `estimated` with the expected record id — **not** `unpriced`, which would mean step 7 was skipped;
- quota: one unit consumed; refunded on an induced failure;
- Suggest mutates **no** library data (it returns suggestions; the user applies them);
- **no content** appears in telemetry or logs;
- the acceptance account's canary paper is not deleted.

### 14.3 What a canary must never do

Flip `selectable`; grant `set_current_user_ai_reasoning`; touch a non-acceptance account; print a secret, the acceptance email or its UUID; delete the durable canary paper; **leave the temporary `ai_model_selection_enabled` capability in place after the block, or grant it to any account other than the dedicated acceptance one**.

### 14.4 Phase 8 — the final activation mutation

**Status: APPLIED to Production on 2026-09-19 — this section is now an executed operator record.** Both prerequisites were met first: the Phase-7 canaries passed on 2026-09-18 (§14.1a), and the Edge-log privacy hardening that gated broad activation was merged and deployed the same day (EDGE-LOG-PRIVACY-HARDENING-001, `analyze-paper` v30 / `fetch-paper-metadata` v22).

**What was done.** PR #289 was reviewed at its exact head and merged as the two-parent commit `38b22c209591a5f5ac2d80498bb55d082dde6d22`; required merged-main CI (Validate, DB Tests) passed; `supabase migration list --linked` and a dry run each showed **exactly one** pending migration; a final read-only gate re-confirmed both rows still `selectable = false`; then **one** `supabase db push --linked --yes`, one attempt, exit 0, applied `20260918210017_activate_paid_provider_model_selection.sql`. Ledger **84 → 85**. Verified afterwards, as the state stood at that point: both paid rows `selectable = true` with every other field unchanged, the four Google rows byte-identical, `reasoning_selectable` false on all six, the reasoning setter still ungranted (both released later the same day by `AI-MANUAL-REASONING-001`, §15), entitlements and preferences unwritten, and no Edge deployment or secret change.

The migration set exactly this and nothing else:

```sql
UPDATE public.ai_model_catalog
   SET selectable = true
 WHERE id IN ('anthropic/claude-sonnet-5', 'openai/gpt-5.6-terra');
```

It must **not** change `enabled`, reasoning metadata, `reasoning_selectable`, the system default, or any grant. Its verify block should assert both rows are now selectable, that `reasoning_selectable` is still false everywhere, that the four Google rows are untouched, and that no preference or entitlement row was written.

This migration is **deliberately not committed by 001E**, so it cannot be applied by a `db push` that runs before the canaries.

### 14.5 Privacy Policy effective date

The amendment now carries effective date **September 18, 2026**, advanced from the original September 17 drafting date during the 001A privacy correction. Two places hold it and must always agree:

- `src/pages/Privacy.tsx` — the rendered `Effective date:` line;
- `EFFECTIVE_DATE` in `src/pages/__tests__/Privacy.test.tsx`, which pins it and also asserts that **exactly one** effective date is rendered.

**This is a standing merge gate, not a one-off.** If the amendment is not published on September 18, 2026, the displayed date is false on publication and must be advanced again in both places before merge. Do not assume the date is still correct because it was correct when written.

The September 17, 2026 date on the **earlier** 001D telemetry amendment (PR #283) is historical and must not be rewritten.

## 15. Manual AI reasoning activation (AI-MANUAL-REASONING-001) — COMPLETE (applied and Production-accepted 2026-09-19)

**Current state: manual reasoning is LIVE.** `reasoning_selectable` is `true` on all six catalog rows and `set_current_user_ai_reasoning` is executable by `authenticated` — the two locks C41 staged, released together on 2026-09-19. An entitled user (`can_select_ai_model`) who has pinned a named model may choose any level that model's catalog row lists; **Automatic stays the default and the recommended choice**, and PaperLume's own default model remains Automatic-only by design, because the setter still refuses a level with no pinned model (`model_required`). One saved manual level applies to **both** Analyze and organization suggestions.

**What was done.** PR #291 was merged as the two-parent commit `96cca6fbe46651790aeffd6a278c65b653cc510b`, and one `supabase db push --linked` applied `20260919075655_activate_manual_ai_reasoning_selection.sql` (ledger **85 → 86**). The migration made exactly two changes:

1. `reasoning_selectable` **false → true** on exactly the six existing rows: Gemini 3.5, 3.6, 3.7 and 3.8 Flash, Claude Sonnet 5 and GPT-5.6 Terra.
2. `GRANT EXECUTE ON FUNCTION public.set_current_user_ai_reasoning(text) TO authenticated` — that role and no other.

It also rewrote two catalog COMMENTs whose text would otherwise still say the control is staged off. There was **no Edge deploy, no secret change, no function-body change, no entitlement change, no preference backfill and no system-default change**; the column DEFAULT stays `false`, so a future model still starts closed until its own reviewed migration opens it. The Automatic matrix is exactly what C41 approved and did not move: Analyze `minimal` (Gemini 3.5/3.6), `low` (3.7/3.8), `off` (Claude Sonnet 5), `none` (GPT-5.6 Terra); organization suggestions `medium` everywhere. The bounded Production acceptance then passed across all three provider families (§15.2).

### 15.1 Ordered rollout — EXECUTED (each step was separately authorized)

1. ~~Independent exact-head review of the Draft PR.~~ **DONE.**
2. ~~Merge the exact approved head as a regular two-parent GitHub merge.~~ **DONE** — PR #291, merge `96cca6fbe46651790aeffd6a278c65b653cc510b`. The Vercel deploy that followed shipped **no behaviour change**: the Settings control reads `reasoning_selectable` from Production, which was still false at that moment.
3. ~~Wait for required merged-main CI (Validate, DB Tests, E2E (local)).~~ **DONE.**
4. ~~Prove exactly **one** pending migration with a read-only preflight.~~ **DONE** — the ledger was at **85** with `20260919075655` absent.
5. ~~Dry-run `supabase db push --linked --dry-run`.~~ **DONE** — it listed that one file and nothing else.
6. ~~Apply exactly that one migration with one `supabase db push --linked`.~~ **DONE 2026-09-19** — ledger **85 → 86**, latest `20260919075655`.
7. ~~Verify, read-only.~~ **DONE** — all six rows `reasoning_selectable = true`; the setter's ACL is exactly `{postgres=X/postgres,authenticated=X/postgres}` with no grant option; `anon`, `service_role` and PUBLIC cannot execute it; every other catalog field byte-unchanged (levels, both Automatic columns, `enabled`, `selectable`, `sort_order`); the setter body still `md5(prosrc) = 2f3db664…`; no preference row written and no manual level backfilled; no entitlement row written; the system default unchanged.
8. ~~Verify that the Reasoning control enables for a pinned model and offers exactly that model's levels.~~ **DONE** — verified through the acceptance account's own RLS session, which is the read the Settings control performs: all six rows come back `reasoning_selectable = true` with their own level lists.
9. ~~Run the separately authorized bounded Production acceptance (§15.2).~~ **PASSED 2026-09-19** — six operations, one attempt each.
10. ~~Restore the acceptance account to its exact prior model and reasoning state.~~ **DONE** — see §15.2.
11. Document the live activation and close the initiative. *(This section, and the closure PR that carries it.)*

### 15.2 Bounded Production acceptance — PASSED 2026-09-19

Run on the dedicated acceptance account, never the owner's library, against its retained synthetic canary paper, with its exact prior model and reasoning state captured first so it could be restored.

**Read-only first, for all six models:** each row was confirmed `reasoning_selectable = true` through the account's own RLS session — the same read the Settings control performs — with the level list exactly that model's: `minimal` present on Gemini 3.5/3.6 and absent on 3.7/3.8, `off` on Claude Sonnet 5 and `none` on GPT-5.6 Terra.

**Then six provider operations, and no more** — enough to prove the preference path saves it, the database stores it, the resolver carries it, both operation types honour it, and all three adapters express it. **Every one of the six resolved `model_selection_source = user_preference`, `reasoning_source = manual` and the exact saved level, with `provider_attempts = 1` and no retry:**

| # | Model | Manual level | Operations | Result |
|---|-------|--------------|------------|--------|
| A | Gemini 3.5 Flash | `minimal` | Analyze | **PASS** — routed to `google/gemini-3.5-flash`, `manual`/`minimal`, provider completed |
| B | Gemini 3.8 Flash | `high` | Analyze | **reasoning path PASS; provider HTTP 503** — routed to `google/gemini-3.8-flash` at `manual`/`high`, one attempt, quota consumed then refunded. A provider-availability exception, **not** a manual-reasoning routing failure: the intended model and manual level reached the provider boundary, and Gemini 3.8 did **not** generate a response |
| C | Claude Sonnet 5 | `low` | Analyze + Suggest | **PASS both** — `manual`/`low` on each, overriding the Automatic split (Analyze `off`, Suggest `medium`) |
| D | GPT-5.6 Terra | `low` | Analyze + Suggest | **PASS both** — `manual`/`low` on each, overriding the Automatic split (Analyze `none`, Suggest `medium`) |

C and D are the load-bearing cases: one saved level overrode **both** halves of each provider's Automatic split, which is what "manual applies to both operations" means in practice.

**Quota.** Five successes consumed one PaperLume quota unit each; the 503 consumed a unit and it was refunded, so that operation's net effect was zero. Net acceptance delta **+5**. Reasoning effort introduced no weighted quota accounting — one successful AI operation is one unit at every level, exactly as before.

**Telemetry.** Each of the six operations recorded one content-free event carrying the reasoning source and the resolved level, alongside provider, model, outcome, attempts, usage dimensions and the list-price estimate. Absolute row counts are volatile and deliberately not recorded here as an architectural fact.

**Restoration, verified.** The temporary `ai_model_selection_enabled = true` was returned to its prior `false`; the account's original preference state was the **absence** of a preference row, and that absence was restored rather than merely setting reasoning to Automatic; the substantive entitlement fields matched the captured baseline afterwards (`updated_at` moved normally because of its trigger, which cannot be restored); the durable synthetic canary paper remained; and no non-acceptance account was intentionally changed.

Do **not** sweep every level against every provider: the per-level encoding is already pinned by the adapter suites and the activation chain test.

## 16. AI model catalog refresh (AI-MODEL-CATALOG-REFRESH-001) — COMPLETE: Phase B LIVE, Phase C PASSED, Phase D APPLIED / PRODUCTION-VERIFIED

**Current state in Production: SEVEN catalog rows, all fully open.** All four phases are executed. Phase A's staging migration `20260930203613` (§6.20) was applied on 2026-10-01 (ledger 98 → 99) and both generation functions carry the new price records; Phase C's canaries **passed 9 / 9** on all three replacements; and Phase D's cutover `20261001092335` (§6.21) was applied on 2026-10-01 (**ledger 99 → 100**), which is what took Production from nine rows to seven. Claude Sonnet 5 and GPT-5.6 Terra are **retired by deletion** — those rows no longer exist — and the saved preferences that named them were migrated to their successors in the same transaction. Decision **C59** holds the policy; this section is the executed rollout record and the runbook that produced it.

**The owner-approved destination, now live** — seven user-selectable models, every one `enabled`, `selectable` and `reasoning_selectable`:

| sort | `id` | `display_name` | `reasoning_levels` | Automatic Analyze / Suggest |
|---|---|---|---|---|
| 10 | `google/gemini-3.5-flash` | Gemini 3.5 Flash | `minimal, low, medium, high` | `minimal` / `medium` |
| 20 | `google/gemini-3.6-flash` | Gemini 3.6 Flash | `minimal, low, medium, high` | `minimal` / `medium` |
| 30 | `google/gemini-3.7-flash` | Gemini 3.7 Flash | `low, medium, high` | `low` / `medium` |
| 40 | `google/gemini-3.8-flash` | Gemini 3.8 Flash | `low, medium, high` | `low` / `medium` |
| 50 | `anthropic/claude-sonnet-5-5` | Claude Sonnet 5.5 | `low, medium, high, xhigh, max` | `low` / `medium` |
| 60 | `anthropic/claude-opus-5-5` | Claude Opus 5.5 | `low, medium, high, xhigh, max` | `low` / `medium` |
| 70 | `openai/gpt-6.1-sol` | GPT-6.1 Sol | `low, medium, high, xhigh, max` | `low` / `medium` |

No surviving row offers `off` or `none`. Selecting any of the seven still requires `can_select_ai_model`, unchanged by this refresh.

**What Phase A staged** — identical reasoning metadata on all three rows. The `sort_order` values below are the **staged** ones; Phase D renumbered them to 50 / 60 / 70 and flipped both flags to `true`:

| `id` | `provider_model` | `display_name` | `sort_order` | `enabled` / `selectable` / `reasoning_selectable` | `reasoning_levels` | Automatic Analyze / Suggest |
|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-5-5` | `claude-sonnet-5-5` | Claude Sonnet 5.5 | 70 | true / false / false | `low, medium, high, xhigh, max` | `low` / `medium` |
| `anthropic/claude-opus-5-5` | `claude-opus-5-5` | Claude Opus 5.5 | 80 | true / false / false | `low, medium, high, xhigh, max` | `low` / `medium` |
| `openai/gpt-6.1-sol` | `gpt-6.1-sol` | GPT-6.1 Sol | 90 | true / false / false | `low, medium, high, xhigh, max` | `low` / `medium` |

The only shipped Edge source change is `_shared/aiPriceBook.ts`: three appended records (`…@2026-09-30`), and the Terra-specific 272K constant renamed to a provider-generic one with the same value. Every request builder, adapter, prompt, parser, timeout, retry rule, output ceiling (Analyze 4,096 / Suggest 8,192) and credential name is unchanged.

### 16.1 Phase B — staging rollout — COMPLETE: executed 2026-10-01

**Status: APPLIED.** The merge was `1e281b9b`; merged-`main` Validate, DB Tests and Extension CI all passed; the read-only preflight matched; one bare `supabase db push --linked --yes` took the ledger **98 → 99**; and both generation functions were deployed from the merge commit — `analyze-paper` v33 → **v34** (`23edb1e633b7c59bdc1c930594ae099bba7ce4c0024e59a0bbbb7770b503cdc8`) and `suggest-paper-organization` v16 → **v17** (`c1230563980fb9d76553945d4a0f3bd0b0929b9e7f607d4a185d81e6ba2e7ee6`), both read back byte-identical to the commit. The catalog went to nine rows with the original six byte-unchanged, and preferences, entitlements, counters, credits and telemetry were all unwritten. The steps below are the record of what was done.

1. Independent exact-head review of the PR; merge it as a regular two-parent merge; wait for merged-`main` CI.
2. Read-only preflight: ledger **98**, latest `20260930161651`, `20260930203613` absent, and the catalog still exactly the six rows the migration's §1 asserts. Running the file's §1 inside `BEGIN TRANSACTION READ ONLY … ROLLBACK` proves its preconditions without writing — the INSERT then fails as a read-only write, after every check has passed.
3. `supabase db push --linked --dry-run` must list exactly that one file; then one `supabase db push --linked`. Ledger **98 → 99**.
4. Verify read-only: nine rows; the six current rows byte-unchanged; the three staged rows exactly as tabled above; `enabled AND selectable` still returns exactly the six current ids in order; preferences, entitlements, usage counters, usage credits and telemetry unchanged.
5. Deploy **both** generation functions — `analyze-paper` and `suggest-paper-organization` — from the exact merge commit. Required before Phase C even though no request builder changed: the price records live in the bundle, and without them every replacement canary is `unpriced`. Record versions and bundle hashes before and after, and read the deployed source back (`functions download --use-api`) to prove it matches the commit.

Order of steps 3 and 5 is not safety-critical — the migration alone creates rows no user can select and no preference names, and the bundle alone adds price records for models nothing routes to — but both must be done before Phase C. Rollback of step 5 is a redeploy of the previous closure; rollback of step 3 is a forward migration deleting the three rows (they can have no dependents until Phase C).

### 16.2 Phase C — bounded provider canaries — PASSED 2026-10-01 (9 / 9)

**Status: PASSED.** Nine provider calls on the dedicated acceptance account, one attempt each, zero retries, zero failures, zero refunds; total list-price estimate **$0.105908**. Telemetry 68 → 77. Per model — Claude Sonnet 5.5, Claude Opus 5.5, GPT-6.1 Sol — Analyze at **Automatic → `low`**, Suggest at **Automatic → `medium`**, and Analyze at **manual → `max`**. Every row recorded `model_selection_source = user_preference`, `provider_attempts = 1`, `provider_outcome = completed`, `operation_outcome = succeeded`, `usage_status = reported`, `cost_status = estimated` and the exact `…@2026-09-30` price record for its own model. **No Google fallback and nothing `unpriced`.** Suggest persisted no library data on any of the three blocks, and the bounded Edge-log scan found no email, UUID, JWT, key prefix, title or abstract in either generation function's console or invocation logs.

**`max` is not blocked.** The unchanged 4,096 Analyze output ceiling was not reached: the three manual-`max` calls returned complete results at 2,583 / 1,214 / 1,126 output tokens (2,452 / 1,083 / 1,034 of them reasoning). No `MAX_REASONING_OUTPUT_CEILING_BLOCKER`.

**Quota, and the acceptance account's end state.** The owner authorized a temporary `ai_lifetime_quota` increase **15 → 20** on that account only; the nine calls took `used` 11 → 20; the limit was then restored to **15** and the consumed usage deliberately **not** restored. The account therefore ends at **quota 15 / used 20 / remaining 0**, which is valid and expected for a disposable acceptance account. This is operational context, not a product invariant — and it means any future canary on that account needs a fresh owner quota decision *before* the first call.

The design below is the record of the mechanism that was used.

Use the §14.2 mechanism unchanged: on the dedicated acceptance account only, one provider block at a time, temporarily set `ai_model_selection_enabled = true`, write the preference row directly (the setter refuses a staged model with `model_not_selectable`, by design), run the operations, then restore both — on every exit path. **Never** flip `selectable` or `reasoning_selectable` for a canary. Suite `028` proves an operator-written preference for each staged model resolves to it, and `aiModelCatalogRefreshStaging.test.ts` proves the runtime routes it without falling back.

**Budget first — and NOT with `usage_credits`.** An earlier version of this section offered "a bounded, recorded `usage_credits` grant to that account alone" as a possible headroom mechanism. **That does not work, and the failure is silent.** `public.usage_credits` exists as the future credit-pack schema (C13; commercial-architecture.md §4.5), but the deployed `consume_ai_quota` **does not read that table** — granting rows in it creates no headroom at all, and the canary would still hit the quota wall with the grant sitting there looking applied.

The mechanism actually used on 2026-10-01, and the one to use again, is a **temporary bounded increase to `user_entitlements.ai_lifetime_quota`** for the acceptance account only, restored on every exit path. No usage history is ever reset: `used` keeps whatever the canaries spent, and only the limit moves back. Re-verify the account's quota read-only before planning, and get the owner's decision on the exact headroom number before the first call — the authorization is for specific `quota / used` numbers, so a different starting `used` is a STOP, not a cue to recompute.

**Minimum matrix — six calls:** for each of Claude Sonnet 5.5, Claude Opus 5.5 and GPT-6.1 Sol, Analyze and Suggest once each at **Automatic** (reasoning `NULL`), which exercises `low` and `medium`.

**Bounded manual coverage — recommended, owner's call:** the operator writes `preferred_reasoning_level` directly (the reasoning setter refuses a staged row with `reasoning_not_selectable`; the runtime honours a saved level the row lists). One Analyze per model at `max` — the level most likely to exhaust the unchanged 4,096 Analyze ceiling — plus `high` and `xhigh` once per provider protocol. That is at most six further calls; do not sweep every level of every model, because the per-level wire encoding is already pinned by the adapter suites.

**A call passes only if:**

- telemetry names the exact staged `provider` / `provider_model`, with `model_selection_source = user_preference` — a `google` row means the canary silently fell back and **proves nothing**;
- `reasoning_source` and `resolved_reasoning_level` are as intended (`automatic` → Analyze `low`, Suggest `medium`);
- `provider_attempts = 1`, provider outcome `completed`;
- `cost_status = estimated` against `…@2026-09-30` — `unpriced` means Phase B step 5 was skipped;
- no content in telemetry or logs, and Suggest mutates no library data.

**Stop conditions.** Any 4xx attributable to the request or reasoning shape **blocks activation** for that model. An `incomplete_response` at a manual level is recorded and reviewed before that level is opened at Phase D.

### 16.3 Phase D — cutover — APPLIED / PRODUCTION-VERIFIED — 2026-10-01

**Status: APPLIED.** Prepared, reviewed and locally validated by `AI-MODEL-CATALOG-REFRESH-001D`, its locking rationale corrected by `-001D-R1`, and rolled out by `AI-MODEL-CATALOG-REFRESH-001E` on 2026-10-01. Its prerequisite was met — every Phase-C model passed (§16.2). **No Edge deployment, no secret change and no Settings change accompanied it** — see §6.21.

**Merge.** PR #328 merged as **`63a590a798326a55fa8a333599d1384ad469e415`** — a normal two-parent merge commit (parent 1 the pre-merge `main` `1e281b9b`, parent 2 the approved head `5156ec27`), whose tree is byte-identical to the approved head's, with a zero-file diff between them. Merged with `--match-head-commit`, so GitHub itself refused any head drift.

**Merged-`main` CI — every applicable lane, attempt 1, success:**

| workflow | run id | attempt | conclusion |
|---|---|---|---|
| Validate | `36893886837` | 1 | success |
| DB Tests | `36893886822` | 1 | success |
| Extension (package + real browser) | `36893886894` | 1 | success |

`E2E (local)` has **no `push` trigger** by design (`CI-E2E-EXECUTION-POLICY-001`: pull requests, a daily schedule and manual dispatch only), so it did not run on the merge and was not expected to. It had already passed on the approved head.

**Read-only preflight, immediately before the apply:** ledger **99**, latest `20260930203613`, `20261001092335` absent; exactly **nine** catalog rows with **six** selectable and the **three** replacements `enabled` / not `selectable` / not `reasoning_selectable` at their staged metadata; the Phase-C gate intact at **9** conforming events; `analyze-paper` v34 and `suggest-paper-organization` v17 at their exact bundle hashes; and exactly **one** pending migration — proven both by `supabase migration list --linked` (100 entries, one local-only, zero remote-only orphans) and by `supabase db push --linked --dry-run`, which listed that one file with `seeds: []` and `roles: []`.

**Apply.** One `supabase db push --linked --yes`. **One attempt, success.** Exactly one migration, no seeds, no roles, nothing executed by hand — no manual `DO` block, no manual preference rewrite, no manual delete, no manual activation. **Ledger 99 → 100**, latest `20261001092335`, present exactly once, with the previous 99 versions' ordered digest unchanged.

**Post-state, verified read-only:**

- exactly **seven** catalog rows, in the §16 order at sorts 10–70, every one `enabled`, `selectable` **and** `reasoning_selectable`;
- `anthropic/claude-sonnet-5` and `openai/gpt-5.6-terra` absent **by id and by `(provider, provider_model)` wire pair** — deleted, not hidden;
- the three replacement rows matching their approved metadata field for field, and the four Google rows byte-identical to the preflight digest;
- no surviving row offering `off` or `none`;
- the saved preference migration succeeded — the one pre-cutover row, `anthropic/claude-sonnet-5` / `xhigh`, became `anthropic/claude-sonnet-5-5` / `xhigh`, with the preference row count unchanged and zero preferences left on either retired id;
- **unrelated state provably unchanged** by digest and count: `user_entitlements` (7 rows), `usage_counters` (10), `usage_credits` (0), all **77** `ai_provider_usage_events` rows, the Phase-C 9-event evidence, the retired models' historical telemetry, and the preference foreign key — the migration wrote no telemetry, no quota and no entitlement;
- **Edge unchanged** — `analyze-paper` v34 and `suggest-paper-organization` v17 at the same bundle hashes;
- **no post-cutover provider call.** Phase C had already proved all three models, so no further quota was consumed.

**Incidental Vercel deployment.** The merge triggered the normal automatic Git-integration Production deployment `dpl_2GYkNn3HyyfKHFmCgYbjcJaMqAqs` from `63a590a7`, which reached **Ready** and carries the `app.paperlume.app` and `paper-whisperer-62.vercel.app` aliases. No manual deploy, promote or redeploy occurred. **It did not perform the cutover** — no frontend runtime source changed in the PR, and the model list is database-driven.

**Rollback** is a forward migration, not a revert: the applied migration is immutable. Re-inserting the two deleted rows would restore the catalog but not un-rewrite any preference the cutover changed, and the rewritten preferences are valid for their successors. If the seven-model list had to be withdrawn, the honest move is to set `selectable = false` on whichever replacements should not be offered, leaving every migrated preference routable.

The design below is what the applied migration implements, kept as the reference record of what was executed.

One transactional migration, fail-closed at both ends in the style of `20260930203613`. Order matters: `user_ai_preferences.preferred_model_id` references `ai_model_catalog(id)` with **no** `ON DELETE` action, so an old row cannot be deleted while any preference still names it — the delete itself fails closed.

1. Assert the three replacement rows exist exactly as staged (or as Phase C left them).
2. Migrate **every** then-current saved preference, whatever the population is at that moment:

   | From `preferred_model_id` | To |
   |---|---|
   | `anthropic/claude-sonnet-5` | `anthropic/claude-sonnet-5-5` |
   | `openai/gpt-5.6-terra` | `openai/gpt-6.1-sol` |

   | Old `preferred_reasoning_level` | Claude Sonnet 5 → Sonnet 5.5 | GPT-5.6 Terra → Sol |
   |---|---|---|
   | `low` / `medium` / `high` / `xhigh` / `max` | unchanged | unchanged |
   | `off` | `NULL` (Automatic) — Sonnet 5.5 rejects disabled thinking | not applicable |
   | `none` | not applicable | `NULL` (Automatic) — Sol rejects `none` |
   | `NULL` (Automatic) | `NULL` | `NULL` |

   Assert afterwards that no preference names an old row and that every migrated level is listed by its new row.
3. Only then delete (or disable) the two old catalog rows.
4. Set `selectable = true` and `reasoning_selectable = true` on the three replacement rows; optionally normalize the final `sort_order`.
5. Postconditions: exactly seven rows, all `enabled` and `selectable`; every other table's rows unchanged except the migrated preferences; the system default untouched.

**Afterwards, and only once no row or preference can name them:** the provider-level `off` (Anthropic adapter) and `none` (OpenAI adapter) may be removed in a reviewed Edge change — until then they must stay, because the catalog is the per-model authority and Sonnet 5 / Terra legitimately use them. The two old price records stay in the book unchanged: historical telemetry carries its own record id and rates, and a record prices nothing that is no longer routed.
