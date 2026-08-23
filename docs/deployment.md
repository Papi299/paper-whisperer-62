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
| **Frontend-only / client code** | React hooks, components, client lib, `src/lib/clientEnv.ts` (PR #138) | Merge → Vercel rebuild from `main`. No `supabase` commands. |
| **Docs-only** | README, `docs/*.md` (including this file) | Merge only. No runtime deploy. Vercel may rebuild but nothing user-visible changes unless the README is shipped as a docs site (not the case in this repo today). |
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
| `GEMINI_API_KEY` | `analyze-paper` | Required for the Gemini analysis call. Without it, `analyze-paper` fails fast with a clear in-source throw (preserved by PR #139). |
| `GEMINI_MODEL` | `analyze-paper`, `get-gemini-provider-quota` | **Optional.** Overrides the Gemini model alias. Both functions resolve it through the shared `_shared/geminiModel.ts` with the exact behavioral fallback `gemini-flash-latest`, so they can never silently disagree. Unset = fallback (current behavior). |
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
| `SUPABASE_SECRET_KEYS` | `delete-account` | Auto-injected by the runtime. **Server-only elevated key**, JSON dictionary keyed by key name; the function reads `default`. Preferred over the legacy key below. |
| `SUPABASE_SERVICE_ROLE_KEY` | `delete-account` | Auto-injected by the runtime. **Server-only elevated key**, legacy plain string; used only as a compatibility fallback when the project has not created the newer secret keys. |

Validated by PR #139 via the `requireEdgeEnv` helper in [`supabase/functions/_shared/env.ts`](../supabase/functions/_shared/env.ts). If for any reason the runtime stops injecting either of the first two, the function surfaces an actionable error instead of crashing with an empty-string client.

**About the elevated key (PFA-C04).** `delete-account` is the only function that needs one: deleting an Auth user is an administrative operation, and the account's private attachment binaries must be removed through the Storage API. `selectEdgeSecretKey()` in [`supabase/functions/_shared/accountDeletion.ts`](../supabase/functions/_shared/accountDeletion.ts) prefers `SUPABASE_SECRET_KEYS["default"]` and falls back to `SUPABASE_SERVICE_ROLE_KEY`; if neither is present the function returns a safe 500 and deletes nothing rather than continuing unprivileged. **Because both are platform-provided, no manual Production secret needs to be added for this function.** The key never leaves the function: it is not returned, not logged, not placed in any response body, and — as §3.1 requires — never carried in a `VITE_*` variable. Every other function remains caller-authenticated and uses no elevated key.

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

---

## 7. Edge Function deployment

Edge Function code does **not** ship via a GitHub merge or a Vercel build. Each affected function must be deployed explicitly:

```sh
supabase functions deploy analyze-paper --project-ref <project-ref>
supabase functions deploy fetch-paper-metadata --project-ref <project-ref>
supabase functions deploy get-gemini-provider-quota --project-ref <project-ref>
supabase functions deploy delete-account --project-ref <project-ref>
supabase functions deploy search-pubmed --project-ref <project-ref>
supabase functions deploy suggest-paper-organization --project-ref <project-ref>
```

- Run one command per changed function. If a PR touches several, run each.
- If a PR touches `supabase/functions/_shared/*` (e.g. `env.ts` from PR #139), every function that imports the shared module must be redeployed — the shared file is bundled into each function's deploy artifact.
- `supabase db push` is **not** needed for Edge-only PRs.
- After deploy, smoke each changed function — see §8.

The Supabase CLI runs Deno bundling at deploy time and surfaces compile errors before publishing. Treat a successful deploy as the formal Deno-side typecheck (the project doesn't run `deno check` locally — `deno` isn't part of the standard contributor toolchain).

**Verifying what is actually deployed.** Read-back representation is **tool-dependent**. The `supabase functions download` path used in prior rollout verification has been observed to return normalized/transpiled output (type annotations stripped, formatting normalized), so do not assume its files are byte-identical to repository TypeScript. Other inspection mechanisms may expose a different representation, including source closer to what was uploaded. Before using byte identity as evidence, establish what transformation, if any, the mechanism you chose applies.

- Prove provenance **before** deploying: confirm the deploying worktree's function closure (entrypoint plus every `_shared/*` module it imports, recursively) is byte-identical to the accepted commit, and deploy from that worktree.
- Afterwards, use the strongest comparison the chosen mechanism actually supports: **byte** comparison when it demonstrably returns the uploaded source representation; otherwise **semantic** comparison of the changed behavior, or a **differential** comparison of the old and new read-backs taken through the same mechanism (capture the previous version before deploying).
- Record the resulting version and `ezbr_sha256` in the rollout entry in [`migration-history.md`](migration-history.md); do not treat any particular version or hash as a fixed baseline here.

### 7a. `delete-account` — endpoint-before-UI ordering, and never smoke-test it destructively

**Current state: `delete-account` is deployed and live**, and the Settings → Danger zone flow calls it in Production. The two rules below are durable and apply to every future change to this function.

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

**Current state: `search-pubmed` is deployed to the linked project and live.** It is the Edge Function behind the Add Papers → **PubMed Search** tab (`PUBMED-IN-APP-SEARCH-001`). The initial rollout completed on **2026-08-23** — its evidence (deployment identifiers, verification results, merge and Vercel provenance) is recorded in [migration-history.md](migration-history.md). Read the live version back rather than trusting any number written here: `supabase functions list --project-ref <project-ref>`.

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

**The frontend now calls it.** `001B` shipped the Edit Paper surface against this exact contract. That PR was **frontend-only**: it changed no file under `supabase/functions/`, `supabase/config.toml` or `supabase/migrations/`, so it required no Edge deployment and no migration, and the deployed artifact it depends on is the one the `001A` rollout verified. The endpoint-before-UI gate was satisfied *before* `001B` was built, which is the ordering the rule exists to produce.

**What it is.** An advisory, non-mutating suggestion endpoint. It authenticates the caller in-function with `auth.getUser()`, verifies the requested paper belongs to that caller, reads that caller's own Projects and Tags, sends Gemini a bounded, allow-listed semantic payload, and returns four suggestion lists. It consumes **one unit of the existing AI quota** per successful generation through `consume_ai_quota`, and refunds through `refund_ai_quota` when the provider fails or returns an unusable result. It uses **no elevated key**.

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

**No new secret is required.** It reuses the existing `GEMINI_API_KEY`, the optional `GEMINI_MODEL` override (resolved through the same `_shared/geminiModel.ts` as `analyze-paper`, so the two cannot silently disagree on the model), and the auto-injected `SUPABASE_URL` / `SUPABASE_ANON_KEY`. **No migration is required** — the feature adds no table, column, RPC or RLS policy.

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

Run after a `search-pubmed` deployment, or after a frontend change affecting PubMed Search. The initial rollout completed on **2026-08-23**; its historical evidence is in [migration-history.md](migration-history.md). The boxes below stay unchecked because this is a reusable checklist, not a record of one run.

- [ ] Add Papers → **PubMed Search** → query `resistance training hypertrophy` → press Search → results render with titles, authors, journal, date and PMID.
- [ ] The result count distinguishes the records shown from PubMed's total (e.g. `1–20 of 2,509`).
- [ ] Next / Previous move between pages; a selection made on page 1 is still counted on page 2.
- [ ] Select two results, optionally choose a Project/Tag, press **Import 2 Selected** → the papers import through the normal identifier path and the summary shows Added / Skipped — Duplicates / Failed.
- [ ] Re-importing an already-imported PMID reports it as **Skipped — Duplicates**, and creates no second row.
- [ ] A field-tagged query such as `("resistance training"[Title/Abstract]) AND muscle` returns sensibly different results from the plain-text one — proof the syntax reached PubMed unrewritten.
- [ ] No Edge Function error toast, and the Function logs show `pubmed-search q_len=… outcome=ok` with **no query text**.

### 9.4 AI analysis (Edge Function: `analyze-paper`)

- [ ] Open a paper with an abstract → Analyze → confirm TLDR / study type / statistical methods populate.
- [ ] Bulk-select 2 papers → Bulk Analyze → confirm the 3-second cooldown between calls and final summary toast (e.g., `2 succeeded, 0 failed`).
- [ ] Confirm no `Missing required Edge Function environment variable: …` toast — that would indicate `GEMINI_API_KEY` is missing or one of the auto-injected vars isn't available (rare; would surface as a 500 from the function).

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

**A transient provider failure is not a failed check.** During the initial rollout the one real generation hit an upstream `503` on its first attempt, retried after 2 s and succeeded — the bounded retry budget absorbed it, the user-visible result was a normal 200, and no refund was issued because a result was delivered. If you see a `provider_status=` warning in the logs followed by `outcome=ok`, that is the retry policy working. A failure is a non-200 response, or a `502`/`500` with a provider class after the budget is exhausted.

**Frontend acceptance (`001B`), for a release that changes the Edit Paper suggestion surface.** These checks are about the *client*, so run them against the deployed frontend with a real account. Note that the "one real generation" above already spends a request; plan for one more here, and prefer a throwaway Project/Tag name so the cleanup is trivial.

- [ ] Open **Edit Paper**. The **AI organization** section renders above the Projects selector, states that it uses **1 AI request** and that nothing is assigned until you save, and **no request has been made** — confirm in the network panel that opening the dialog (and letting the abstract load) calls nothing.
- [ ] With a title but no abstract, keywords or study type, the action is **disabled** and explains what to add. Confirm no request is sent.
- [ ] Edit the abstract or study type **without saving**, then click Suggest. Confirm in the network panel that the request body carries the **unsaved** values, exactly the keys `paperId` / `draft` / `currentProjectIds` / `currentTagIds`, and no authors, notes, TLDR, PMID, DOI, URL, attachment, user id or quota field.
- [ ] Results render per category with a short reason each. A valid all-empty response renders the honest empty state ("No strong Project or Tag suggestions for this paper.") and **not** an error.
- [ ] Accept an existing Project and an existing Tag. Confirm the Projects/Tags selectors update, and that **no** `set_paper_projects` / `set_paper_tags` / `papers` request is made — acceptance must be local only.
- [ ] **Cancel** without saving, reopen the paper, and confirm neither the Project nor the Tag was assigned.
- [ ] Suggest again, press **Create & select** on a proposed new Project. Confirm the Project is created immediately (it appears in Manage Projects), the AI-proposed description was kept, and the paper is still **not** assigned until Save.
- [ ] Close without saving and confirm the created Project **remains in the library** while the paper stays unassigned — this is intended, and the UI says so.
- [ ] Reopen, accept suggestions, press **Save Changes**, and confirm the assignments now persist after a reload.
- [ ] Rename an existing Project to match a proposed-new name, then press Create & select: the existing row is **selected**, not duplicated. With two rows whose names differ only by surrounding whitespace, confirm nothing is created and nothing is selected, and the UI asks the user to pick.
- [ ] The **AI requests** indicator refreshes after a generation (success or provider failure). Confirm it does **not** refresh when the click was intercepted before any request — an ineligible draft, or a known-zero allowance.
- [ ] An exhausted allowance shows AI-**request** wording ("You've used all N of your … AI requests"), never "AI analyses", and carries no upgrade/checkout copy. A provider failure shows the neutral "temporarily unavailable" wording instead — a Google rate limit must never be reported as the user's plan running out.
- [ ] No **Paper List** row action, bulk suggest action, or suggestion column appeared anywhere.
- [ ] On a phone-width viewport and with a finger: the section and every result action are reachable inside the Edit Paper scroll region, the dialog still has exactly one vertical scroll owner, the page behind the modal never scrolls, and the Select / Create & select / Dismiss targets are comfortably tappable.

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

---

## 10. Troubleshooting

### 10.1 Missing client env vars

**Symptom:** Browser console shows `Missing required environment variable: VITE_SUPABASE_URL. Copy .env.example to .env.local and set VITE_SUPABASE_URL. See README.md → Local development.` (or the `PUBLISHABLE_KEY` variant).

**Cause:** Vercel project env var missing or empty; or for local dev, `.env.local` / `.env` not set up.

**Fix:** Set the missing var in Vercel Project Settings → Environment Variables → Production (and Preview / Development as needed). Redeploy. Locally: re-check `.env.local` exists and has both `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` non-empty.

### 10.2 Missing Edge env vars

**Symptom:** Edge Function 500 with error body `Missing required Edge Function environment variable: SUPABASE_URL. Set it in Supabase secrets or confirm it is auto-injected by the Supabase Edge runtime.` (or `SUPABASE_ANON_KEY`).

**Cause:** The Supabase Edge runtime stopped auto-injecting one of these (unusual). Or a future migration to a different runtime exposed a gap.

**Fix:** Confirm the function deployed cleanly (`supabase functions deploy <name> --project-ref <project-ref>` exits 0). If yes, contact Supabase support — the auto-injection is platform-managed.

### 10.3 Missing `GEMINI_API_KEY`

**Symptom:** `analyze-paper` returns 500 with error body containing `GEMINI_API_KEY not configured in Supabase secrets`.

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
- **Do not use service-role keys in client code.** The repo currently has zero service-role references in `src/` (verified). Keep it that way. RLS plus the SECURITY DEFINER `auth.uid()` guards from PR #130 are the security boundary.
- **Do not run `supabase db push`** for docs-only or client-only PRs. Even if it's a no-op, it adds noise; with stale local state it can re-trigger already-applied migrations.
- **Do not run `supabase db push --include-all`** unless you are deliberately reproducing the PR #131 / #132 reconciliation pattern with the same audit-first discipline. The `--include-all` flag bypasses ordering safety.
- **Do not run Playwright against Production or any linked/cloud Supabase project.** The supported lifecycle is `npm run test:e2e:local` on an ephemeral local stack; a bare `npm run test:e2e` fails closed by design. Do not work around the guard.
- **Do not assume Vercel deploys Edge Functions.** It doesn't. Edge Function code only updates via `supabase functions deploy <name>`.
- **Do not deploy a frontend that depends on a migration before the migration is applied.** Order: migration → Edge Function (if any) → frontend.

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
