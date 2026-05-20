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
| **Edge Function secrets** | `GEMINI_API_KEY` rotation | `supabase secrets set <NAME>=<value> --project-ref <project-ref>`. No code deploy needed unless secret values are read at module top-level (none are in this repo — both functions read `Deno.env.get` inside the request handler via `requireEdgeEnv`). |
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
| `SUPABASE_URL` | both Edge Functions | Auto-injected by the runtime. No manual setup. |
| `SUPABASE_ANON_KEY` | both Edge Functions | Auto-injected by the runtime. No manual setup. |

Validated by PR #139 via the `requireEdgeEnv` helper in [`supabase/functions/_shared/env.ts`](../supabase/functions/_shared/env.ts). If for any reason the runtime stops injecting either, the function surfaces an actionable error instead of crashing with an empty-string client.

---

## 4. Pre-merge checklist

Before clicking **Merge** on the PR:

- [ ] CI / PR checks are green (or the failures are acknowledged and triaged in the PR description).
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

Run these from the project root on the merged `main` (after `git pull --ff-only origin main`):

```sh
npx tsc --noEmit
npx vitest run
npx eslint .                              # or scope to touched files for speed
supabase migration list --linked          # confirm Local = Remote on every row
```

- `npx tsc --noEmit` covers `src/` and `vite.config.ts` only. **Edge Functions are not covered by tsc** (they target Deno; not part of any `tsconfig` `include`). Edge Function code is bundled and checked by Deno during `supabase functions deploy`.
- `npx vitest run` should match the count in README's Testing section (currently **285**). A mismatch usually means tests were added/removed in the PR; verify against the PR's stated test delta.
- `npx eslint .` should be 0 errors. Pre-existing warnings (e.g. `react-hooks/exhaustive-deps` on `PaperList.tsx:302`, `useBulkMutations.ts:217/366`, `usePaperMutations.ts:235`) are tolerated; **new** warnings on touched files are not.
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
- The current ledger (post-PR #139) is aligned through `20260518010000` — no drift, no pending migrations.

---

## 7. Edge Function deployment

Edge Function code does **not** ship via a GitHub merge or a Vercel build. Each affected function must be deployed explicitly:

```sh
supabase functions deploy analyze-paper --project-ref <project-ref>
supabase functions deploy fetch-paper-metadata --project-ref <project-ref>
```

- Run one command per changed function. If a PR touches both, run both.
- If a PR touches `supabase/functions/_shared/*` (e.g. `env.ts` from PR #139), every function that imports the shared module must be redeployed — the shared file is bundled into each function's deploy artifact.
- `supabase db push` is **not** needed for Edge-only PRs.
- After deploy, smoke each changed function — see §8.

The Supabase CLI runs Deno bundling at deploy time and surfaces compile errors before publishing. Treat a successful deploy as the formal Deno-side typecheck (the project doesn't run `deno check` locally — `deno` isn't part of the standard contributor toolchain).

---

## 8. Frontend deployment / Vercel

The frontend deploys from `main` to Vercel. The repository ships [`vercel.json`](../vercel.json) with a single SPA-rewrite rule (`/((?!assets/).*) → /index.html`); env vars are configured in the Vercel project dashboard, not in `vercel.json`.

What we know:
- The frontend production target is Vercel.
- Required client env vars (§3.1) must be configured in the Vercel project before any deploy that needs them.
- A Vercel build with either `VITE_*` var missing will produce a bundle that throws the PR #138 fail-fast error at module load in the browser console.

What is **not** specified in this repo and intentionally left to the operator:
- Branch protection / auto-deploy / preview-deploy configuration (lives in the Vercel project settings, not in this repo).
- Whether Vercel deploys are gated by a status check; verify in the Vercel project before assuming.
- Rollback procedure for the frontend (use Vercel's deployment history UI; not codified here).

If Vercel automation is not yet set up for a given environment, follow the hosting provider's standard manual-deploy workflow. Do not invent automation in this doc that isn't actually configured.

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

### 9.4 AI analysis (Edge Function: `analyze-paper`)

- [ ] Open a paper with an abstract → Analyze → confirm TLDR / study type / statistical methods populate.
- [ ] Bulk-select 2 papers → Bulk Analyze → confirm the 3-second cooldown between calls and final summary toast (e.g., `2 succeeded, 0 failed`).
- [ ] Confirm no `Missing required Edge Function environment variable: …` toast — that would indicate `GEMINI_API_KEY` is missing or one of the auto-injected vars isn't available (rare; would surface as a 500 from the function).

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
