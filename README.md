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
- **In-app PubMed discovery** (Add Papers → PubMed Search): search PubMed with full PubMed syntax, browse paged results, multi-select records and import the selected PMIDs through the existing canonical identifier importer. Discovery never becomes a second import path — see below. Publication-type badges on a result honour the current user's Study Type Exclusion Pool; that is display-only and does not affect the study type recorded at import. Backed by the deployed `search-pubmed` Edge Function — [docs/deployment.md](docs/deployment.md) §7b covers its deployment rules.
- Projects, tags, curation pools (keywords / synonyms / study types / exclusions), notes, saved searches / filter presets.
- Private per-user attachments, with a **recoverable cleanup lifecycle**: Postgres and Storage cannot share a transaction, so deleting an attachment or a paper records the Storage key in `attachment_cleanup_queue` in the *same* transaction that removes the metadata naming it, and uploading finalizes through a single serialized, idempotent RPC so a lost response can never turn a saved attachment into a deleted file (`20260904120000`). Browser roles hold `SELECT` only on `paper_attachments`, and cannot `DELETE` a `papers` row either — metadata is created and destroyed exclusively by those RPCs, through the parent as well as directly — and Storage refuses to delete a binary a live attachment row still names, which together keep an already-loaded pre-migration browser tab from recreating the old destructive orderings. Physical removal is done by the authenticated browser — immediately, and once more at the next sign-in if that failed. There is no scheduled worker, so cleanup is recoverable rather than immediate or guaranteed; account deletion still enumerates Storage itself as the final sweep. **The two migrations are not yet applied to Production** (they roll out in two phases with a verified drain between them) — see [docs/deployment.md](docs/deployment.md) §6.4.
- AI analysis via Gemini (`analyze-paper` Edge Function).
- **Full account export** (Account menu → Account → Account data): one ZIP holding every category of the signed-in user's own data — papers and notes, projects, tags and their relationships, saved searches, all four pools, attachment metadata **and** attachment binaries, plus a non-secret profile projection. API keys, tokens, and session material are excluded by construction.
- Security layer: RLS on all user tables, `auth.uid()`-guarded SECURITY DEFINER RPCs, explicit client-side `user_id` scoping, fail-fast env validation.

**Implemented commercial enforcement foundations** (schema and enforcement are live; billing is not):

- Entitlement and usage schema — `user_entitlements`, `subscriptions`, `subscription_events`, `usage_counters`, `usage_credits` (`20260521010000`), provider-neutral.
- Server-side **AI quota** enforcement — `consume_ai_quota` / `refund_ai_quota` RPCs; `analyze-paper` consumes quota before calling Gemini and returns HTTP 402 when exhausted (`20260521020000`).
- Server-side **storage quota** enforcement for attachments — `user_storage_usage` + triggers (`20260521030000`).

**Not implemented** (planned; see the commercial docs below):

- Paddle billing integration (checkout, webhook ingestion, customer portal, subscription sync) — Paddle is the selected Merchant-of-Record provider, gated on owner-side setup.
- Paywall / upgrade UX, Free-tier feature gating, Terms of Service / AI-disclosure / support pages, marketing site. (The **Privacy Policy** is live in-app at the public `/privacy` route, linked from the sign-in page and from the authenticated Account menu.)
- The product is **not commercially launched**.

Self-serve **account deletion** is live: **Account menu → Account → Danger zone** permanently deletes the signed-in account after the user types `DELETE MY ACCOUNT`. It runs through the privileged `delete-account` Edge Function — deployed to the linked project — which derives the target user from the authenticated bearer token, deletes the account's private attachment binaries through the Storage API, and then hard-deletes the Auth user; the user's database rows are removed by the existing `ON DELETE CASCADE` foreign keys. Account *export* is the separate export-before-delete path.

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

**Commercial-launch implementation is currently paused** (owner decision C27, 2026-07-24): the active priority is product feature and workflow development, and Paddle/billing/launch work is off the active critical path until a new explicit owner decision. Commercialization is **paused, not cancelled**. The provider-neutral entitlement schema and server-side AI + storage quota enforcement listed under Current status are already implemented and live and remain part of the architecture. Billing itself is not implemented: **Paddle** remains the selected future Merchant-of-Record provider (decision C18), gated on owner-side Paddle setup whenever launch work resumes. There is no checkout, webhook ingestion, customer portal, paywall UX, or store listing today, and no mobile packaging. Of the legal page set only the **Privacy Policy** exists, at the public `/privacy` route.

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

## Chrome extension

Source lives in `extension/`, inside this same repository and dependency graph — there is no second `package.json` and no workspace. It builds with its own Vite config to its own output directory, so the web build and the Vercel artefact are untouched.

```sh
npm run build:extension        # production build → dist-extension/
npm run build:extension:dev    # same, development mode
npm run package:extension      # build + validate + Store-ready ZIP → release/
npm run test:extension:browser # load the built extension in a real Chromium
```

Load the unpacked build:

1. build it with the command above — `dist-extension/` is the unpacked directory;
2. open `chrome://extensions`;
3. turn on **Developer mode** (top right);
4. click **Load unpacked** and select `dist-extension/`;
5. rebuild and press **Reload** on the extension card after any source change.

To check it by hand, open a tab and click the PaperLume toolbar action:

| Open this | Expect |
|---|---|
| `https://pubmed.ncbi.nlm.nih.gov/12345678/` | Paper detected · PubMed · PMID `12345678` · **Continue in PaperLume** |
| `https://doi.org/10.1056/NEJMoa2107934` | Paper detected · DOI · `10.1056/NEJMoa2107934` · **Continue in PaperLume** |
| the same DOI link *after it redirects* to the publisher | Paper detected · DOI · `10.1056/NEJMoa2107934` — read from the page's standard DOI metadata, since the publisher URL carries no DOI |
| a publisher article page that publishes no standard DOI tag, or any ordinary non-paper page | No paper identified — and **not** a guess from the page title or body text. No continuation button |
| `chrome://extensions` | Nothing to check here. No continuation button |

Publisher support is not universal and is not meant to read as universal: it depends on the page carrying one of the four keys above, which many journals emit and some do not.

**What it does.** It reads the active tab's address after you click the toolbar action, and says whether that address structurally identifies a PubMed record or a DOI. If the address identifies neither and the tab is an ordinary web page, it then reads four standard bibliographic `<meta>` keys — `citation_doi`, `dc.identifier`, `dc.identifier.doi`, `prism.doi` — from that one page's `<head>`, because a `doi.org` link redirects to the publisher before you can reach the toolbar. For a recognised paper it offers **Continue in PaperLume**, which opens one new tab at the handoff route below. That is the whole of it: the extension makes no network or API request of its own (it never resolves the DOI), holds no PaperLume or Supabase session, stores nothing, sends no page content or source URL, and imports nothing. It reads no other part of a page — not the title, the abstract, the authors, the body text or the links — and a page publishing two genuinely different DOIs is refused rather than resolved to either. "Different" is the DOI specification's test, not string equality: ASCII case is insensitive when DOI names are compared, so a page writing the same DOI once with capitals and once without has published one DOI, not two. It requests `activeTab` and `scripting` and no host permission: `activeTab` grants temporary access to the one tab you invoked it on, which is what lets it read that tab's address *and* inject there, while `scripting` merely enables the injection API and reaches no page by itself. Opening the new tab requires neither the `tabs` permission nor a host permission.

**The extension hands over, it does not import.** One press does this and stops:

```
toolbar click → activeTab URL read → PubMed/DOI detection
              → (only if the URL identified nothing) page DOI metadata
              → Continue in PaperLume
    → new tab at https://app.paperlume.app/extension-import?kind=…&value=…
    → PaperLume signs you in if needed → you choose Projects and Tags
    → you press Import to PaperLume
```

Everything from the new tab onwards belongs to the web application: authentication, Projects and Tags, duplicate handling, and the explicit confirmation that actually writes. The identifier is the only thing that travels — no title, no page URL, no referrer, no ids, no analytics parameter — and the receiving route treats it as untrusted regardless of who sent it.

**Packaging and Store readiness.** `npm run package:extension` cleans, builds, validates `dist-extension/`, writes `release/paperlume-extension-<version>-rc.zip` with `manifest.json` at the archive root, then unzips what it wrote and validates that too. It exits non-zero on any contract violation — a widened permission, a remote origin, a source map, a stray test file — and the archive is byte-identical between runs. `release/` is gitignored; nothing is uploaded.

`npm run test:extension:browser` loads the **built** extension into a real Chromium (Playwright's bundled channel, a throwaway profile, DNS black-holed to loopback) and asserts what the browser reports: the permissions Chrome actually granted (`["activeTab","scripting"]` with zero host origins), that a real `chrome.scripting.executeScript` is refused without a toolbar grant, that no background context exists, that the popup classifies and renders, that a real publisher page's `citation_doi` is read while its title, body and links are not, and that pressing Continue calls the real `chrome.tabs.create` exactly once at the exact handoff URL. One step it cannot automate is the toolbar click that grants `activeTab`, so that is a mandatory manual gate before submission.

The extension is still loaded unpacked for development. It is **not** published to the Chrome Web Store. As of **2026-08-30** a **draft** Store item exists (`cfanjbamcemoeglgkpbidnclkomaocmo`) with the `0.1.0` package uploaded, and the listing, privacy, test-instruction and distribution fields have been **populated and saved** (category `Workflow & Planning`, language `English (United States)`, visibility `Unlisted`, all regions). **Nothing has been submitted for review, and nothing is published** — submission is a separate explicit owner decision. Policy audit, privacy data flow, the manual release checklist and the remaining Store gates are in [docs/chrome-web-store-readiness.md](docs/chrome-web-store-readiness.md).

## Extension import handoff

`/extension-import` is the authenticated PaperLume route that accepts one already-detected identifier:

```
/extension-import?kind=pmid&value=12345678
/extension-import?kind=doi&value=10.1056%2FNEJMoa2107934
```

It carries an identifier and nothing else — no token, no session material, no user id, no Project or Tag id, no paper metadata. The Chrome extension above is one sender of these links; it is not a privileged one. The value is untrusted regardless of who sent it: a PMID must already be in normalized form and a DOI must round-trip through the application's canonical DOI handling, so anything else renders as an unrecognised link. There is no title fallback.

Opening the route imports nothing. It shows the identifier, lets you pick from your existing Projects and Tags, and runs the same importer the Add Papers dialog uses only after you choose **Import to PaperLume** — so a link, a bookmark or a refresh can never write to your library.

A paper you already have is reported as already in your library, and no second copy is created. Your selected Projects and Tags can still be **added** to that existing paper, but only when PaperLume can prove which paper it is: identity comes from your own PMID and DOI uniqueness and nothing else — never a title, never fuzzy or metadata similarity. If the identifiers point at two different papers of yours, or at none that can be proven, nothing is applied and the page says so rather than guessing. When the selection is applied it is **added**: everything that paper was already filed under is kept.

If your projects, tags or keyword settings cannot be loaded, the route says so and offers a retry instead of importing: saving a paper without those settings would file it incorrectly, so importing is unavailable until they load.

Signing in first preserves the intent: `/auth?returnTo=…` accepts only this one route with a valid identifier, and rebuilds the destination from the validated parts rather than redirecting to the supplied text.

## Supabase Edge Functions

Edge Functions live under `supabase/functions/<name>/index.ts` (`analyze-paper`, `fetch-paper-metadata`, `get-gemini-provider-quota`, `delete-account`, `search-pubmed`, `suggest-paper-organization`). All six are deployed to the linked project. `get-gemini-provider-quota` is **deployed but intentionally unused** — its manager-facing dashboard is deferred under decision C29, and no frontend code calls or renders it.

`suggest-paper-organization` is the newest. It backs the Edit Paper **Suggest Projects & Tags** experience: it compares one owned paper against the caller's own Projects and Tags and returns suggestions. It is **advisory** — it creates, assigns and persists nothing — spends one unit of the existing AI quota per successful generation, is caller-authenticated, and uses no elevated key. It needed no migration and no new secret. It is deployed, live, and now **called by the frontend**: `AI-PROJECT-TAG-SUGGESTIONS-001B` added the Edit Paper surface, and the endpoint contract was unchanged by it — see [docs/deployment.md](docs/deployment.md) §7c and decision C32.

The user experience it backs is on-demand and reversible. A compact **AI organization** section sits above the Projects selector in Edit Paper; one click spends one AI request, and there is no Paper List action and no bulk mode. Suggested **existing** Projects/Tags become local selections only and persist when the user presses Save Changes, so cancelling assigns nothing. A proposed **new** Project/Tag requires a separate **Create & select** click, which creates the entity immediately through the existing `createProject` / `createTag` mutations — the paper assignment still waits for Save — and reconciles the name against the taxonomy as it stands at that moment, selecting a single existing match rather than duplicating it and refusing to guess when several match.

`search-pubmed` backs the PubMed Search tab. It is read-only (PubMed ESearch + ESummary), caller-authenticated, uses no elevated key, and reads the caller's optional `profiles.pubmed_api_key` server-side exactly as `fetch-paper-metadata` does. Because a frontend that calls it is useless without it, any future change to its request/response contract must be deployed **before** the frontend that depends on it merges — see [docs/deployment.md](docs/deployment.md) §7b.

**Edge Function deploys are separate from frontend / Vercel deploys** — a GitHub merge alone does not update the deployed function. After any change under `supabase/functions/<name>/`, deploy each changed function explicitly:

```sh
supabase functions deploy analyze-paper --project-ref <project-ref>
supabase functions deploy fetch-paper-metadata --project-ref <project-ref>
supabase functions deploy get-gemini-provider-quota --project-ref <project-ref>
supabase functions deploy delete-account --project-ref <project-ref>
supabase functions deploy search-pubmed --project-ref <project-ref>
supabase functions deploy suggest-paper-organization --project-ref <project-ref>
```

### Required Edge Function secrets

| Variable | Used by | Source |
|---|---|---|
| `SUPABASE_URL` | all | **Auto-injected** by the Supabase Edge runtime — no manual setup. |
| `SUPABASE_ANON_KEY` | all | **Auto-injected** by the Supabase Edge runtime — no manual setup. |
| `SUPABASE_SECRET_KEYS` / `SUPABASE_SERVICE_ROLE_KEY` | `delete-account` only | **Auto-injected** by the Supabase Edge runtime — no manual setup. Server-only; see below. |
| `GEMINI_API_KEY` | `analyze-paper`, `suggest-paper-organization` | **Must be set manually** via `supabase secrets set`. One key backs both functions' Gemini `generateContent` calls — `suggest-paper-organization` **reuses** it and introduced no new secret. Without it, both fail safely with a generic 500 before any provider call and name the secret only in the Edge log, never in the response — `analyze-paper` refunds the quota unit it already consumed, and `suggest-paper-organization` checks the key before consuming one. Operator detail: [docs/deployment.md](docs/deployment.md) §10.3. |

Set the Gemini key once per project (placeholder shown — substitute your real key, never commit it):

```sh
supabase secrets set GEMINI_API_KEY=<your-gemini-api-key> --project-ref <project-ref>
```

Every function **fails fast** if a required Edge env var is missing or empty — `supabase/functions/_shared/env.ts` validates each at the call site. The actionable message naming the variable goes to the **Edge log**; a caller that reaches the check receives a neutral generic 500 that never names it. Operator detail: [docs/deployment.md](docs/deployment.md) §10.2.

**Caller-authenticated functions.** `fetch-paper-metadata`, `analyze-paper`, `get-gemini-provider-quota`, `search-pubmed` and `suggest-paper-organization` need **no** elevated key: each constructs its Supabase client with the **caller's** auth header and relies on RLS plus an in-function `auth.getUser()` check for ownership enforcement.

**`delete-account` is different.** Deleting an Auth user is an administrative operation, and the account's private attachment binaries have to be removed through the Storage API, so this function additionally builds a **server-only elevated client**. It prefers the current secret-key mechanism (`SUPABASE_SECRET_KEYS`, a JSON dictionary keyed by key name, reading `default`) and falls back to the legacy `SUPABASE_SERVICE_ROLE_KEY`. **Both are supplied automatically by the Supabase Edge runtime, so no manual secret needs to be added.** That key is used only inside the function: it is never sent to the browser, never placed in a response body, never logged, and never exposed through any `VITE_*` variable. The function still authenticates the *caller* exactly like the others — the elevated client is used only after `auth.getUser(token)` has established who is asking, and the deleted user id comes from that result and nowhere else.

`supabase/config.toml` sets `verify_jwt = false` on all six functions — intentional, so the in-function `auth.getUser()` check handles stale / refreshing tokens gracefully without a 401 at the gateway.

Notable manual smoke case: PMID `41912805` ("GBD 2023 IHD & Dietary Risk Factors Collaborators") for `fetch-paper-metadata` — it exercises bounded `<Author>...</Author>` parsing and `<CollectiveName>` consortium author support.

For the full deployment runbook — including pre-merge / pre-deploy / migration / Edge Function / post-deploy smoke checklists and troubleshooting — see [docs/deployment.md](docs/deployment.md).

## Testing

```sh
npm run lint                 # ESLint
npm run typecheck            # TypeScript (application + Node + extension projects)
npm test                     # Unit / integration tests (Vitest)
npm run build                # Production build (web app)
npm run build:extension      # Production build (Chrome extension)
npm run package:extension    # Chrome Web Store release-candidate ZIP + package validation
npm run test:extension:browser  # Real-Chromium unpacked-extension lane (no backend, no network)
npm run test:e2e:local       # Playwright E2E against an ephemeral local Supabase stack
npm run test:db:local        # pgTAP database-security suites on an ephemeral local stack
```

> Use `npm run typecheck` (not a bare `tsc --noEmit`): the root `tsconfig.json` has an empty file set, so it delegates to the `tsconfig.app.json`, `tsconfig.node.json` and `tsconfig.extension.json` project references that the script checks.

### Local-first end-to-end tests

`npm run test:e2e:local` is the **supported, safe E2E lifecycle**. It starts an ephemeral local Supabase stack (Docker required), replays every tracked migration, applies a deterministic local-only seed, and runs the Chromium single-worker suite behind a two-layer fail-closed guard that rejects any Production or remote backend before credentials are read. Use `npm run test:e2e:local:stop` if a run is interrupted and leaves the stack up.

A bare `npm run test:e2e` (plain `playwright test`) **deliberately fails closed** without an explicit local backend contract — running the suite against the Production Supabase project is not a supported path.

The suite covers the read path, filters, paper import/order, in-app PubMed discovery, bulk actions, attachments, mutations, saved searches / filter presets, notes, search attribution, account export and deletion, branding, and the responsive / mobile / touch behaviors.

### Database tests

pgTAP suites in `supabase/tests/database/` cover core and relational RLS isolation, RPC caller scope and grants, storage and quota enforcement, duplicate-merge behavior, publication-type provenance, function `search_path` hardening, and account-deletion cascade. `npm run test:db:local` runs them all on an ephemeral local stack alongside a framework-free verification file, an expected-failure negative control, a concurrency probe, and fail-closed teardown checks.

### CI

| Workflow | Runs | Required to merge? |
|---|---|---|
| **`Validate`** (`.github/workflows/validate.yml`) | `npm ci`, lint, typecheck, Vitest, web production build, Chrome extension production build on Node 22 | **Yes** — required on `main` |
| **`DB Tests`** (`.github/workflows/db-tests.yml`) | The same `test:db:local` database lifecycle | **Yes** — required on `main` |
| **`E2E (local)`** (`.github/workflows/e2e-local.yml`) | The same local-first Playwright lifecycle on an ephemeral local stack | No — evidence, not a gate |
| **`Extension`** (`.github/workflows/extension.yml`) | `npm run test:extension:browser` and `npm run package:extension` — the real-Chromium extension lane and the Store package contract | No — evidence, not a gate |

Branch protection requires the bare check names `validate` and `db-tests`; Vercel is **not** a required check. All four workflows use a read-only token and require no repository secret, variable, or Environment; `E2E (local)`, `DB Tests` and `Extension` skip fork-origin pull requests before executing anything. `Validate`, `DB Tests` and `Extension` also run on every push to `main`. **`E2E (local)` deliberately does not:** re-running the identical, already-green integration candidate the moment it lands as a content-equivalent merge commit duplicated the pre-merge run for another ~19 minutes, so that post-merge trigger was replaced with a **daily 02:17 UTC scheduled run** (`cron: '17 2 * * *'`, which GitHub runs from the latest commit on the default branch) as an independent health check for environmental drift. Its pre-merge pull-request run is unchanged, and it remains non-required. `Extension` is additionally **path-scoped on pull requests** — a PR runs it only when the extension, its build config, the shared identifier/handoff modules it bundles, its packaging or its browser lane change, so an unrelated application PR does not pay for a browser download. Its `main`-push trigger is deliberately **not** path-filtered: every push to `main` runs it, so a bad merge cannot land unverified. None of them contact Production or any cloud Supabase project — there is **no hosted staging environment**, and local-first is the accepted path.

Edge Function tests executed by a **Deno** runtime do not exist. `delete-account`, `search-pubmed` and `suggest-paper-organization` are the partial exceptions: each keeps its whole request path in a runtime-agnostic `handler.ts` plus pure sibling/`_shared` modules, so the real handler — not a re-implementation — is covered by Vitest. `delete-account` is additionally invoked for real as a served local Edge Function under the local E2E lifecycle; `search-pubmed` is not, because its E2E stubs the request at the browser boundary to keep CI off the live NCBI network.

See [docs/start-here.md](docs/start-here.md) for the full testing and merge-safety baseline.
