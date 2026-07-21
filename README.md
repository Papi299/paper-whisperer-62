# Paper Whisperer

Academic paper library manager with server-side filtering, sorting, pagination, keyword analysis, and AI-powered study classification.

## Tech stack

- **Frontend:** React + TypeScript + Vite + shadcn-ui + Tailwind CSS
- **Backend:** Supabase (Postgres, Auth, Edge Functions, PostgREST)
- **Region:** Supabase free tier, South Asia (Mumbai)

## Current status

The core application is **stable, hardened, and feature-complete at current scale**, and is deployed at `app.paperlume.app` (working commercial brand: **Paperlume** — a working brand only, not a registered trademark).

**Implemented application foundations:**

- Server-side read path: filtering, sorting, pagination, lazy loading, on-demand abstract fetch.
- Full-text search with server-driven "Matched in:" attribution (see below).
- Imports (PMID / DOI / BibTeX / RIS / CSV), duplicate detection and merge (PMID/DOI-only), exports (CSV / RIS / BibTeX).
- Projects, tags, curation pools (keywords / synonyms / study types / exclusions), notes, saved searches / filter presets.
- Private per-user attachments; AI analysis via Gemini (`analyze-paper` Edge Function).
- Security layer: RLS on all user tables, `auth.uid()`-guarded SECURITY DEFINER RPCs, explicit client-side `user_id` scoping, fail-fast env validation.

**Implemented commercial enforcement foundations** (schema and enforcement are live; billing is not):

- Entitlement and usage schema — `user_entitlements`, `subscriptions`, `subscription_events`, `usage_counters`, `usage_credits` (`20260521010000`), provider-neutral.
- Server-side **AI quota** enforcement — `consume_ai_quota` / `refund_ai_quota` RPCs; `analyze-paper` consumes quota before calling Gemini and returns HTTP 402 when exhausted (`20260521020000`).
- Server-side **storage quota** enforcement for attachments — `user_storage_usage` + triggers (`20260521030000`).

**Not implemented** (planned; see the commercial docs below):

- Paddle billing integration (checkout, webhook ingestion, customer portal, subscription sync) — Paddle is the selected Merchant-of-Record provider, gated on owner-side setup.
- Paywall / upgrade UX, Free-tier feature gating, legal pages, account deletion, account-level data export, marketing site.
- The product is **not commercially launched**.

For the full current-state handoff, see [docs/start-here.md](docs/start-here.md).

### Current search behavior

The main search box operates in one of four mutually-exclusive modes, selected by the shape of the query:

- **Empty** → no search filtering.
- **Unquoted, 1–2 characters** → short ILIKE search (`search_papers_short` RPC).
- **Unquoted, 3+ characters** → prefix-aware FTS (`search_papers` RPC).
- **Quoted** (`"..."` with non-empty inner string) → literal phrase match (no stemming, Unicode-safe, punctuation-preserving).

Every non-empty mode searches six fields: **title, abstract, authors, journal, notes, keywords**. Each matching row renders a **server-driven** "Matched in: …" sub-line showing which of those six fields matched (fixed order, no client-side re-tokenization). The `"..."` phrase syntax is taught via the search-input placeholder.

Deeper DB optimization is evidence-deferred until the library grows past ~2,000–5,000 papers. See [docs/decisions-and-triggers.md](docs/decisions-and-triggers.md) for the exact re-evaluation criteria.

## Commercialization

Commercialization is **in progress**, not planning-only. The provider-neutral entitlement schema and server-side AI + storage quota enforcement listed under Current status are implemented and live. Billing itself is not: **Paddle** is the selected Merchant-of-Record provider (decision C18), and integration is gated on owner-side Paddle setup. There is no checkout, webhook ingestion, customer portal, paywall UX, legal page set, or store listing today, and no mobile packaging.

| Doc | Purpose |
|---|---|
| [docs/commercial-architecture.md](docs/commercial-architecture.md) | Entitlement / billing-neutral architecture |
| [docs/quotas-and-pricing.md](docs/quotas-and-pricing.md) | Plan structure, MVP baseline quotas, open pricing questions |
| [docs/owner-decisions.md](docs/owner-decisions.md) | Owner decision ledger: resolved decisions, blockers, unlock order |
| [docs/store-launch-checklist.md](docs/store-launch-checklist.md) | Launch readiness checklist (mobile deferred; policies must be re-verified before launch) |

Final prices and quotas are MVP baselines subject to instrumentation, and remaining launch capabilities are owner-gated — see [docs/owner-decisions.md](docs/owner-decisions.md).

## Documentation

| Doc | Purpose |
|---|---|
| [docs/start-here.md](docs/start-here.md) | Bounded current-state handoff for fresh sessions (150–250 lines, updated in place) |
| [docs/owner-decisions.md](docs/owner-decisions.md) | Owner decisions, blockers, and implementation unlock order |
| [docs/architecture-read-path.md](docs/architecture-read-path.md) | Current read-path architecture |
| [docs/migration-history.md](docs/migration-history.md) | What changed, when, and why |
| [docs/decisions-and-triggers.md](docs/decisions-and-triggers.md) | Architectural decisions and re-evaluation triggers |
| [docs/commercial-architecture.md](docs/commercial-architecture.md) | Commercial / entitlement architecture and implementation status |
| [docs/quotas-and-pricing.md](docs/quotas-and-pricing.md) | Provisional plans, quotas, open pricing questions (planning) |
| [docs/store-launch-checklist.md](docs/store-launch-checklist.md) | App Store / Play Store launch checklist (planning) |
| [docs/documentation-policy.md](docs/documentation-policy.md) | Documentation update rule for all changes |
| [docs/deployment.md](docs/deployment.md) | Deployment checklist / release runbook (operator-facing) |

Per [docs/documentation-policy.md](docs/documentation-policy.md), a meaningful change updates whichever authoritative document it makes inaccurate — in the same PR, proportionally — and every Claude Code report must end with a "Documentation updates" section.

**For production deployment steps, see [docs/deployment.md](docs/deployment.md)** — it consolidates the per-PR-type deploy actions, required env vars, migration deploy sequence, Edge Function deploy commands, post-deploy smoke checklist, and troubleshooting.

## Local development

```sh
git clone <repo-url>
cd paper-whisperer-62
npm install
```

### Environment setup

The client requires two Supabase env vars at build / dev-server time. Copy the example file and fill in the values from your Supabase project (Supabase Studio → Project Settings → API):

```sh
cp .env.example .env.local
```

Then edit `.env.local`:

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<your-anon-publishable-key>
```

- `.env.local` must **not** be committed (it's already in `.gitignore`).
- If either value is missing or empty, the app **fails fast** at module load with an actionable error pointing back to this section — the helper in `src/lib/clientEnv.ts` validates both before initializing the Supabase client.
- These are public, client-inlined values (anon / publishable key) by design; never put a service-role key in a `VITE_` variable.

### Run the dev server

```sh
npm run dev
```

Requires Node.js 20.19+ or 22.12+. Supabase project config is in `supabase/config.toml`.

## Supabase Edge Functions

Edge Functions live under `supabase/functions/<name>/index.ts` (`analyze-paper`, `fetch-paper-metadata`). **Edge Function deploys are separate from frontend / Vercel deploys** — a GitHub merge alone does not update the deployed function. After any change under `supabase/functions/<name>/`, deploy explicitly:

```sh
supabase functions deploy analyze-paper --project-ref <project-ref>
supabase functions deploy fetch-paper-metadata --project-ref <project-ref>
```

### Required Edge Function secrets

| Variable | Used by | Source |
|---|---|---|
| `SUPABASE_URL` | both | **Auto-injected** by the Supabase Edge runtime — no manual setup. |
| `SUPABASE_ANON_KEY` | both | **Auto-injected** by the Supabase Edge runtime — no manual setup. |
| `GEMINI_API_KEY` | `analyze-paper` | **Must be set manually** via `supabase secrets set`. Used for the Gemini analysis call; without it, `analyze-paper` fails fast with a clear error. |

Set the Gemini key once per project (placeholder shown — substitute your real key, never commit it):

```sh
supabase secrets set GEMINI_API_KEY=<your-gemini-api-key> --project-ref <project-ref>
```

Both functions now **fail fast with an actionable error** if any required Edge env var is missing or empty — `supabase/functions/_shared/env.ts` validates each at the call site. No `SUPABASE_SERVICE_ROLE_KEY` is needed; the functions construct their Supabase client with the **caller's** auth header and rely on RLS plus in-function `auth.getUser()` for ownership enforcement.

`supabase/config.toml` sets `verify_jwt = false` on both functions — intentional, so the in-function `auth.getUser()` check handles stale / refreshing tokens gracefully without a 401 at the gateway.

Notable manual smoke case: PMID `41912805` ("GBD 2023 IHD & Dietary Risk Factors Collaborators") for `fetch-paper-metadata` — it exercises bounded `<Author>...</Author>` parsing and `<CollectiveName>` consortium author support.

For the full deployment runbook — including pre-merge / pre-deploy / migration / Edge Function / post-deploy smoke checklists and troubleshooting — see [docs/deployment.md](docs/deployment.md).

## Testing

```sh
npm run typecheck            # TypeScript (application + Node projects; 0 diagnostics)
npx vitest run               # Unit / integration tests
npx playwright test          # E2E tests (Chromium, single-worker serial)
npx playwright test --ui     # Interactive test runner
```

> Use `npm run typecheck` (not a bare `tsc --noEmit`): the root `tsconfig.json` has an empty file set, so it delegates to the `tsconfig.app.json` and `tsconfig.node.json` project references that the script checks.

E2E auth credentials are in `.env.test` (dedicated test account). The Playwright suite covers the read path, filters, paper import/order, bulk actions, attachments, mutations, saved searches / filter presets (`e2e/filter-presets.spec.ts`), notes (`e2e/notes.spec.ts`), and the server-driven `Matched in:` search-attribution UI for all six sources (`e2e/search-attribution.spec.ts`).

There is currently **no CI** — no GitHub Actions workflow runs these suites, and `main` has no required checks — so tests must be run locally before merging. Database-layer tests (pgTAP) and Edge Function (Deno) tests do not exist yet. See [docs/start-here.md](docs/start-here.md) for the full testing and merge-safety baseline.
