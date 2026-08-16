# Start Here — Current-State Handoff

> **Purpose.** The bounded current-state handoff for a fresh engineering, product, or AI-assistant session. It describes what is true **now**. It is not a project journal: chronology lives in Git, merged PRs, `supabase/migrations/`, and [migration-history.md](migration-history.md).
>
> **Maintenance rule.** Target 150–250 lines; hard maximum 300. Update **in place**: replace or delete statements that stop being true. Never append PR-by-PR narrative. Prefer a link to the authoritative document over copied detail. Prefer a verification command over a volatile snapshot (version numbers, counts). See [documentation-policy.md](documentation-policy.md).

## 1. Product and repository identity

- **Repository:** `Papi299/paper-whisperer-62`. The repository and package name remain **Paper Whisperer** (`paper-whisperer`); Supabase/Vercel/GitHub resource names are unchanged. **Repository visibility is owner-controlled and may alternate between public and private** — check GitHub for the setting in force today, and never treat either state as a fixed architectural or security assumption.
- **Working commercial brand:** **Paperlume** (working brand only — **not** a registered trademark; see C19 in [decisions-and-triggers.md](decisions-and-triggers.md)). Every reachable user-facing surface presents exactly one visible name, **`PaperLume`** (sidebar, Auth card, `<title>`/`og:title`). Internal identifiers were deliberately not renamed.
- **Domains:** `paperlume.app` secured via Cloudflare Registrar; the app is live at **`app.paperlume.app`** (Vercel). The marketing site at the root domain is not built.
- **What it is:** an academic paper library manager — import, organize, search, analyze, and export research papers — using a **single-user workspace model with per-user multi-tenant isolation** (every row is owned by one user; Postgres RLS is the isolation boundary).

## 2. Current architecture

- **Frontend:** React 18 + TypeScript + Vite SPA; shadcn/ui (Radix + Tailwind); TanStack Query for server state; React Router with four routes (`/`, `/auth`, `/dashboard`, `/reset-password`). Route guarding is a client-side redirect for UX only — **RLS is the real security boundary**.
- **Backend:** Supabase — Postgres 17, Auth (JWT, localStorage-persisted sessions), Storage, PostgREST, and four Edge Functions (see §5).
- **Read path:** all filtering, sorting, pagination, keyword matching, and full-text search happen in Postgres; the client holds one page at a time. Detail: [architecture-read-path.md](architecture-read-path.md).
- **Search:** four mutually exclusive modes (empty / short ILIKE for 1–2 chars / prefix-aware FTS for 3+ chars / quoted literal phrase), across six fields (title, abstract, authors, journal, notes, keywords) with a server-driven "Matched in:" attribution line.
- **Attachments:** private Storage bucket, owner-scoped path policies, size/MIME limits, server-side storage-quota triggers.

### Security invariants — mandatory for new code

- **S1:** every `SECURITY DEFINER` RPC verifies caller identity against `auth.uid()` (explicit guard or internally derived ownership), including an explicit `auth.uid() IS NULL` rejection. Full inventory and rule: [decisions-and-triggers.md](decisions-and-triggers.md) §Security decisions.
- **S2:** client-side mutations/reads on `user_id`-bearing tables carry an explicit `.eq("user_id", userId)` predicate as defense-in-depth, with nullable-safe `userId` threading.
- **No secret key ever reaches the client.** No `VITE_*` variable carries an elevated key. The one Edge Function that needs elevated privileges (`delete-account`) builds a server-only client and never returns or logs that key.
- Least-privilege `EXECUTE` across the SECURITY DEFINER surface (no `PUBLIC`/`anon`/`service_role`), both-owner relational RLS, and bounded `search_path` on all functions are live in Production and pinned by the database suites (§7).

## 3. Implemented capabilities

- Papers CRUD, bulk actions (select-all across the full filtered set), and column/layout customization.
- Import by PMID/DOI identifiers — including structurally authenticated PubMed record URLs and DOI resolver URLs — and from BibTeX / RIS / PubMed NBIB / EndNote tagged / CSV files, with atomic server-side bulk insert. Structured sources state publication types as discrete values, persisted in the nullable `papers.raw_publication_types`; the application never reconstructs them by splitting the legacy joined `raw_study_type`, which stays as the human-readable/fallback representation.
- Duplicate detection — **PMID/DOI-only by decision**. The duplicate-merge RPC's successful merge path is live in Production and covered by a dedicated database regression suite.
- Projects, tags, and four curation pools: keywords, synonyms, study types, exclusions.
- Per-paper notes (indexed into search) and saved searches / filter presets (server-side per user, RLS-isolated).
- Exports to CSV / RIS / BibTeX of the current selection/filter (chunked pipeline for large libraries), plus a separate **full account export** — **Settings → Account data** downloads one versioned ZIP (`paperlume-account-export`, format version 1) covering the signed-in user's whole dataset regardless of filters, including attachment binaries and a whitelisted non-secret profile projection. Client composition over existing SELECT-own reads and private Storage reads only. Secrets are excluded by construction (`profiles.pubmed_api_key` is never selected; no Session/User object is serialized), and the export is complete-or-fail.
- Per-paper file attachments in the private Storage bucket, within the server-enforced storage quota. **Settings → Storage** renders a read-only used/quota/remaining gauge (transparency only — no upgrade or checkout path; the database trigger stays the enforcement boundary).
- AI analysis (TL;DR, study type, statistical methods) via Gemini, behind the server-enforced AI quota, with a header usage indicator and an actionable message when the server returns the AI `402`.
- Per-user optional PubMed API key (stored in `profiles`, used server-side by `fetch-paper-metadata`).
- Actionable first-run onboarding for an empty library, keyed off the **unfiltered** count so a filtered zero-result view is a distinct state. No persistent onboarding flag.
- Internal `owner`/`manager` roles decoupled from the commercial plan (`internal_user_access` + read-only `get_current_user_access`), with an owner AI-quota exemption. Runtime authorization is **UUID/role-based, never email-based**.
- **Self-service account deletion** — **Settings → Danger zone** permanently deletes the signed-in account after the user types `DELETE MY ACCOUNT` exactly, re-validated server-side. It is a **hard** deletion: the privileged `delete-account` Edge Function derives the target **solely from the authenticated bearer token** (the client sends no user id), removes every Storage object under the account's `{userId}/` prefix **before** touching Auth, then calls `auth.admin.deleteUser(userId, false)`; database rows go with it through pre-existing `ON DELETE CASCADE` foreign keys. Storage-before-Auth is required and the operation is safe to retry. The full account export is the offered export-before-delete path.

### Responsive, mobile, and touch state

- The Dashboard has responsive smartphone controls: below `md` the navigation rail becomes a `Sheet` drawer, and the permanent mobile toolbar is compacted (Header + Search + Filters/More) so the paper table holds the majority of the viewport; secondary controls live in mobile overlays. Desktop composition is unchanged.
- Mobile searchable multi-selects render a shared touch-safe sheet: the heading is focused on open, the search field is **never** autofocused, and the option list is a plain scroll container sized from `window.visualViewport` so a software keyboard cannot bury it.
- **Coarse-pointer behavior is decoupled from the `<768px` layout breakpoint.** `(pointer: coarse)` describes how the user touches the screen; `useIsMobile()` (768px) describes how wide the screen is. A tablet legitimately gets the desktop composition *and* touch-safe focus. The 768px contract is unchanged and `useIsMobile()` remains its only JS reader.
- Reported tablet issues are addressed in the accepted implementation: Analytics is reachable at coarse-pointer tablet sizes (the controls region is an explicit bounded scroll owner) and touch hit targets meet size minimums.
- **Touch-safe initial focus is verified per surface, not claimed product-wide.** The surfaces owner testing has covered now decline Radix's text-field autofocus on a coarse pointer and focus their heading (or their popover panel) instead: the sidebar management dialogs, Save/Rename saved search, the Filters and Add Papers selectors, Analytics' Target Keywords/Authors selectors, Settings, Edit Project, Edit Tag, Add/Edit Synonym Group, Edit Paper, and Edit Paper's Projects/Tags selectors. Tapping a field still focuses it, and a fine pointer keeps its existing autofocus everywhere. Surfaces outside that list have not been audited.
- Edit Paper bounds its shell to the **dynamic** viewport and gives its long form one deliberate scroll region (`overflow-y-auto` with `overscroll-contain` and `touch-pan-y`), so every section from Title to Save Changes is reachable by panning inside the dialog rather than by scrolling the page behind it. A `vh`-bounded shell is not reliable here, because `vh` resolves against the large viewport while browser chrome is on screen.
- Close-focus restoration is handled centrally in all three modal primitives — `DialogContent`, `SheetContent`, and `AlertDialogContent` — by capturing the opener on `onOpenAutoFocus` and restoring it on `onCloseAutoFocus`, because Radix otherwise restores through a trigger ref that is `null` for a controlled surface and drops focus on `<body>`. A consumer's own handlers still compose, and a consumer that calls `preventDefault()` wins. Confirmations that *do* have an `AlertDialogTrigger` (the exclusion-pool Clear controls) still restore their trigger correctly: the shared layer captures that trigger as the opener, and Radix's own trigger restore remains the fallback when no connected opener was captured. Where the opener is unmounted by the act of opening — the saved-search Delete/Update confirmations, launched from a dropdown item that closes with the menu — the call site names the persistent Presets trigger as its deliberate fallback; there is no global focus manager and no heuristic "nearest focusable" search.
- **Confirming a paper deletion is a handoff, not a restoration**, because the optimistic cache update unmounts the row and the Delete button that opened the confirmation. `PaperList` captures the deleted paper's neighbours by id *before* dispatching the delete, then moves focus to the **next** row's Delete button, falling back to the **previous** row when the last visible row was deleted, to whatever now occupies the same slot if both neighbours also vanished, and to the empty-state heading (`tabIndex={-1}`, never a Tab stop) when no row survives. Targets come from the `papers` array and refs registered per paper id — never a DOM search — and the handoff only claims focus that has nowhere to be, so a user who moved on during the asynchronous delete keeps their place. Dismissal is unchanged: Cancel and Escape never arm it.
- **Real-device iPhone/iPad verification remains a valuable validation source.** Chromium matching `(pointer: coarse)` proves which element receives focus and the geometry of hit targets; it cannot prove physical iOS software-keyboard or touch-pan behavior.
- This is responsive **web** usability only. **C7 still defers native/mobile packaging**, and none of it is a formal whole-product WCAG conformance audit.

## 4. Key files (orientation map)

| Path | Role |
|---|---|
| `src/pages/Dashboard.tsx` | Main page; orchestrates hooks and list UI |
| `src/hooks/usePapers.ts` | Papers infinite query + server filter/sort |
| `src/hooks/useFilterState.ts` | Filter/search state + search-mode routing |
| `src/lib/buildPapersQuery.ts` | PostgREST query builder for the read path |
| `src/hooks/useFilterPresets.ts` | Saved searches: schema, queries, mutations |
| `src/hooks/usePaperAnalysisActions.ts` | AI-analysis orchestration (single + bulk) |
| `src/hooks/useAttachments.ts` | Attachment upload/download/delete |
| `src/hooks/useCoarsePointer.ts` + `src/lib/columnWidths.ts` | Input-modality detection; single source of column width/clamp policy |
| `src/lib/accountExport/` + `src/hooks/useAccountExport.ts` | Full account export: category registry, S2-scoped reads, manifest, streaming ZIP |
| `src/hooks/useAccountDeletion.ts` + `src/components/settings/DeleteAccount*.tsx` | Account-deletion client: invocation, typed-phrase gate, session/cache cleanup |
| `supabase/functions/delete-account/` + `_shared/accountDeletion.ts` | Privileged boundary: auth, confirmation, Storage cleanup, hard Auth delete |
| `src/lib/importParsers.ts` | BibTeX / RIS / PubMed NBIB / EndNote tagged / CSV parsing |
| `src/integrations/supabase/client.ts` | Supabase client (env fail-fast via `src/lib/clientEnv.ts`) |
| `supabase/migrations/` | Full schema, RLS, and RPC definitions (chronological) |
| `scripts/e2e-local.mjs` | The whole local E2E / DB-test lifecycle: stack, seed, guards, teardown |

## 5. What is deployed now (Production)

Linked Supabase project ref: **`lioxtgiputfniqbktcsz`**. Verify before trusting any claim below.

- **Database:** every tracked migration in `supabase/migrations/` is applied to the linked project — the ledger is aligned (Local = Remote). **The live ledger is authoritative**; read it back with `supabase migration list --linked` rather than trusting a number written here.
- **Edge Functions — all four in `supabase/functions/` are deployed and ACTIVE:** `fetch-paper-metadata`, `analyze-paper`, `get-gemini-provider-quota`, and `delete-account`. Deployed versions are volatile; read them back (`supabase functions list --project-ref <project-ref>`) instead of quoting a snapshot.
  - `get-gemini-provider-quota` is **deployed but intentionally unused**: its manager-facing dashboard is **deferred under C29**, no frontend calls or renders it, and it remains as deferred infrastructure.
  - `delete-account` is **deployed and live**, and the Settings → Danger zone flow calls it in Production.
- All four authenticate the caller with the caller's JWT via in-function `auth.getUser()`; `verify_jwt = false` at the gateway is intentional, and CORS `*` is an accepted decision under bearer-token auth. Only `delete-account` uses an elevated key, and only after the caller is authenticated.
- **Edge Function deploys are separate from frontend deploys.** A GitHub merge alone never updates a function.
- **Frontend:** Vercel Git integration. Every PR head gets a Preview deployment; every merge to `main` produces a **Production** deployment on `app.paperlume.app`. There is no manual promote step.
- **Auth email:** Supabase Auth Custom SMTP routes through Resend on `auth.paperlume.app`.
- Schema reconciliation is complete: local and linked `public`-schema generated types are semantically identical, and the committed types match the linked output. Inventory and canonical decisions C20–C26: [schema-reconciliation.md](schema-reconciliation.md).

Operational procedures, secrets, migration sequence, smoke checklists: [deployment.md](deployment.md).

## 6. Commercial and entitlement state

**Implemented and live:**

- **Entitlement/usage schema** (`20260521010000`): `user_entitlements`, `subscriptions`, `subscription_events`, `usage_counters`, `usage_credits`; `handle_new_user()` seeds a Free entitlement on signup. `subscriptions` / `subscription_events` / `usage_counters` are intentionally deny-all under RLS (server-only).
- **AI quota enforcement** (`20260521020000`): `consume_ai_quota` / `refund_ai_quota` SECURITY DEFINER RPCs with S1 guards; `analyze-paper` consumes a unit **before** calling Gemini, refunds best-effort on provider failure, and returns a structured **HTTP 402** when quota is unavailable.
- **Storage quota enforcement** (`20260521030000`): `user_storage_usage` plus atomic check-and-consume / refund triggers on `paper_attachments`.
- The schema is **provider-neutral**; no billing provider is wired into it.

**Not implemented — do not describe these as existing:**

- Paddle integration: checkout, webhook ingestion, subscription synchronization, customer portal.
- Billing / paywall / upgrade UI of any kind. The AI-quota and storage indicators are **transparency only** and expose no upgrade, checkout, or purchase path.
- Free-tier feature gating of the Synonyms and Exclusions pools (launch blocker per [quotas-and-pricing.md](quotas-and-pricing.md)).
- Legal pages (privacy / terms / AI disclosure / support), marketing site, paid launch. **The product is not commercially launched.**

**Direction (decided, not started):** Merchant-of-Record-first billing (C17); **Paddle** selected for the web MVP (C18), gated on owner-side Paddle setup; Free → Pro two-tier MVP with baselines in [quotas-and-pricing.md](quotas-and-pricing.md) (C9–C11); web-first, mobile deferred (C7); Paperlume brand + domain (C19).

## 7. Testing and CI model

- **There are two required merge gates: `validate` and `db-tests`.** `main` protection requires both — strict/up-to-date, administrators included, **zero** required human approvals, unresolved conversations block the merge, force-push and branch deletion disabled, regular merge commits allowed, Vercel **not** a required check, no repository rulesets.
  - **`Validate / validate`** — `.github/workflows/validate.yml` runs `npm ci`, lint, `npm run typecheck`, Vitest and the production build on Node 22 for every pull request to `main` and every push to `main`.
  - **`DB Tests / db-tests`** — became required on **2026-08-16** when the owner resolved decision **D5** to `REQUIRE_DB_TESTS`. A red `db-tests` blocks merge; that is intended, not a reason to roll the gate back.
- **`E2E (local) / e2e-local` runs on every eligible PR but is NOT a required check.** All three workflows run on same-repository pull requests and `main` pushes, skip fork-origin PRs before any execution, use `contents: read` only, and need **no** GitHub secret, variable, or Environment. `e2e-local` was deliberately **not** promoted under D5; reconsider it only against the recorded trigger — [decisions-and-triggers.md](decisions-and-triggers.md).
- **Required contexts are bare job names.** Branch protection matches the emitted check name — `validate` and `db-tests`, each bound to the GitHub Actions app — **not** the `Workflow / job` labels shown in the GitHub UI. Use the bare names in any protection change.
- **Fork-origin PRs would produce a vacuous green** on the required `db-tests` gate: the same-repository job condition makes it skip and report success. Harmless under today's same-repository-only model, but it must be resolved before fork contributions are accepted.
- **Local-first Playwright is the supported safe lifecycle.** `npm run test:e2e:local` starts an **ephemeral local Supabase stack**, replays every tracked migration, applies a deterministic local-only seed, and runs the suite behind a **two-layer fail-closed** Production/remote guard (Layer 2 runs in the browser before any credential read or fill). Raw key-bearing stack-startup output is suppressed.
  - A bare **`npm run test:e2e` deliberately fails closed** without an explicit local backend contract. **Production-backed Playwright is prohibited by the merged guard** and is not an available path.
  - The `E2E (local)` workflow reuses this same local-first lifecycle. It never contacts Production or any cloud project.
  - **External-metadata import order is covered deterministically.** The `import-order` spec is part of this lane: Playwright fulfils the one `fetch-paper-metadata` request so the metadata is fixed, while the real Add Papers UI, bulk-insert RPC, `insert_order`, refetch, table and refresh persistence all run for real. It needs no live PubMed/Crossref, no served Edge Function and no provider credential, and it deletes the papers it imports.
  - **There is no hosted staging environment.** The accepted path is local-first; no cloud test project, secret, or Environment is provisioned, and selecting one is optional and unselected.
- **Database-layer tests exist.** `supabase/tests/database/` holds pgTAP suites covering core and relational RLS isolation, RPC caller scope and grants, storage and quota, duplicate-merge success, publication-type provenance, function `search_path` hardening, and account-deletion cascade — plus a preserved framework-free verification file. `npm run test:db:local` runs them all on an ephemeral local stack with a catalog-fingerprint baseline, an expected-failure negative control, a true-concurrency AI-quota probe, and fail-closed residue/teardown inspection. The hosted `DB Tests` workflow is a thin wrapper around that same lifecycle.
- **Local pre-push baseline:** `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` — plus `npm run test:e2e:local` when UI behavior changes, and `npm run test:db:local` when database code changes.
- **TypeScript:** the root solution-style `tsconfig.json` has an empty file set, so a bare `npx tsc --noEmit` checks **no application files** and is **not valid evidence**. Use `npm run typecheck`, which runs `typecheck:app` and `typecheck:node`.
- **What does not exist:** a required E2E gate, and Edge Function tests executed by a **Deno** runtime. `delete-account` is the partial exception — its request path lives in a runtime-agnostic handler plus a pure shared module, so it is covered by Vitest and invoked for real as a served local Edge Function under the local lifecycle. Other Edge Function validation remains manual post-deploy smoke (established metadata case: PMID `41912805`).
- **Do not cite exact test counts here** — run the suites for current numbers.

## 8. Dependency security

Authoritative current state, remediation policy, and re-evaluation triggers: [dependency-security.md](dependency-security.md). `npm audit` (full and `--omit=dev`) on the current checkout is the live source — **do not treat a count written in any document as current**.

- **All five dependency clusters are complete, and `npm audit` is at zero in both the full and the production-only graph.** In Clusters 1–4 the implementation delta was confined to `package-lock.json`; Cluster 5 additionally changed `package.json` and six import specifiers, because clearing it required crossing a major version.
- **React Router Cluster 5 is implemented**: `react-router` **7.18.2** is now the single declared Router dependency, and `react-router-dom` and `@remix-run/router` have left the graph entirely. It was a direct-package migration of import provenance only — **React and ReactDOM stay 18.3.1**, the route tree and every navigation target are unchanged, and no future flag was enabled. React Router v8 remains **out of scope** (it requires React 19.2.7+ and Node 22.22+).
- The **`nanoid` high advisory remains remediated** by a name-scoped, lockfile-only update within its parent's existing semver range.
- **Zero is a measurement, not a guarantee.** Advisory databases move, so a new finding can appear without any repository change. Never restate a count from memory — run `npm audit` and read [dependency-security.md](dependency-security.md).

## 9. Active decisions and constraints — do not casually reopen

Authoritative record with rationale and re-evaluation triggers: [decisions-and-triggers.md](decisions-and-triggers.md). Owner gates and unlock order: [owner-decisions.md](owner-decisions.md).

- **Duplicate detection is PMID/DOI only.** Do not propose fuzzy or title-based matching.
- **Title-based import** auto-selects the first PubMed/Crossref match; the accepted mitigation is the static warning in the Add Papers dialog. Do not propose per-paper preview/confirmation flows.
- **CORS `*` on the Edge Functions is intentional** under header-based bearer-token auth. Revisit only if auth becomes cookie-based.
- **No real-Gemini / AI Playwright E2E** — rejected as non-deterministic; the AI path is covered by mocked Vitest tests plus manual smoke.
- **Read-path architecture is stable** (server-side filter/sort/paginate, keyword RPCs, on-demand abstracts, cache-key split, select-all-IDs). Changing it requires new evidence.
- **The 768px layout contract is fixed**, and `(pointer: coarse)` is a separate axis from it. Do not merge the two.
- **Deferred with documented triggers:** Phase C DB optimization (jsonb GIN indexes, RPC rewrites), unused-index cleanup, write-path optimization, Hebrew/RTL (C15).

### Owner-deferred work — NOT active engineering backlog

These are paused by owner decision. Starting any of them requires a **new explicit owner decision**, not an engineering judgement call.

| Decision | Deferred | Re-evaluation trigger |
|---|---|---|
| **C27** | Commercialization and public-launch implementation (Paddle, checkout, webhooks, paywalls, billing, launch execution) | Owner explicitly decides to return to commercialization |
| **C29** | Automatic Gemini provider-quota dashboard/monitoring; Google Cloud billing stays disabled; usage checked manually via Google AI Studio | Commercialization decision **plus** revalidation of the Monitoring metric families |
| **C30** | Supabase Auth leaked-password protection (a Pro-plan feature; the org is on Free) | Before commercialization / paid launch, or earlier if the org moves to Pro or Supabase changes the feature gate |
| **C7** | Native/mobile and app-store packaging | Post-web-launch roadmap phase |

Owner-action blockers that gate the paused C27 work — Paddle Sandbox setup, marketing-site provider and legal-page URLs (C16), business email, monitoring/error-tracking provider — are listed in [owner-decisions.md](owner-decisions.md). They are future-facing and are **not** the active next task.

## 10. Open engineering backlog

Meaningful open items. This is a pointer list, not a backlog database — none of it is auto-selected.

- **Desktop Paper Actions compression.** The Actions buttons compress to 16×32 on desktop as well; desktop density was explicitly accepted, so this stays low priority unless new evidence or an owner decision escalates it.
- **Optional hosted staging** remains unselected; local-first is the accepted path.

## 11. Before selecting the next task

- Every PFA candidate (C01–C09) is **selected or closed for its accepted scope**. Post-PFA work has been responsive/mobile/touch remediation, which is **not** a reopening of PFA-C09.
- **No completion selects a next objective.** A new explicit owner decision is required before further feature work starts, and owner-deferred items in §9 are not eligible by default.
- The required CI and branch-protection baseline in §7 is **mandatory for every PR**, feature or remediation.
- Any change under `supabase/` needs the matching deploy step from [deployment.md](deployment.md) — a merge alone deploys neither migrations nor Edge Functions.
- Verify volatile facts (ledger, deployed function versions, `npm audit`, branch protection) against the live source before restating them.

## 12. Authoritative documents

| Document | Authority |
|---|---|
| [README.md](../README.md) | Concise public/developer entry point |
| [documentation-policy.md](documentation-policy.md) | Documentation rules, incl. this file's line budget |
| [decisions-and-triggers.md](decisions-and-triggers.md) | Durable decisions (C-numbers, S1/S2) + re-evaluation triggers |
| [owner-decisions.md](owner-decisions.md) | Owner gates, blockers, implementation unlock order |
| [deployment.md](deployment.md) | Deployment runbook, env vars, domains, smoke checklists |
| [architecture-read-path.md](architecture-read-path.md) | Read-path architecture detail |
| [dependency-security.md](dependency-security.md) | npm dependency-security posture, remediation policy and triggers |
| [schema-reconciliation.md](schema-reconciliation.md) | Schema drift inventory, canonical decisions C20–C26 |
| [commercial-architecture.md](commercial-architecture.md) | Entitlement/billing architecture (planning) |
| [quotas-and-pricing.md](quotas-and-pricing.md) | Plan structure, MVP baselines, instrumentation (planning) |
| [store-launch-checklist.md](store-launch-checklist.md) | Launch/store readiness (mobile deferred; planning) |
| [migration-history.md](migration-history.md) | Historical chronology — **history, not current state** |
| [product-feature-audit.md](product-feature-audit.md) | Point-in-time capability audit and owner decision packet — **historical, not an evergreen authority** |
| [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md) | PFA-C03 contract and evidence record (complete); D4 decision and resolution; §16 D5 audit evidence (frozen) and §17 D5 activation record |

## 13. Recent material changes

At most 5 items; remove the oldest when adding.

1. **Touch-safe focus, hit targets and tablet Analytics overflow.** Real-device iPad verification found the same defect class wherever the layout is desktop but the input is a finger. Introduced coarse-pointer detection and a `coarse:` Tailwind variant (no new dependency): Actions buttons no longer shrink below the touch minimum, surfaces opening on a coarse pointer focus a non-text target instead of an input, and the Dashboard controls region became an explicit bounded scroll owner so Analytics is reachable at 1024×768. Desktop autofocus is unchanged everywhere, proven by preservation tests that pass on both trees.
2. **Mobile searchable selectors.** Seven selectors below 768px render a shared touch-safe sheet — heading focused on open, search never autofocused, native scroll container sized from `window.visualViewport` — and the Filters sheet focuses its title rather than a number input. Desktop popovers are untouched.
3. **Mobile Dashboard density.** The permanent smartphone toolbar was compacted from roughly three quarters of the viewport to about a fifth via progressive disclosure (Filters and Library-actions sheets); nothing was removed and no touch target shrank. Desktop geometry is byte-identical to baseline.
4. **Responsive/accessibility pass (PFA-C09).** Shell responsive below `md` via a navigation drawer, contained table overflow with no document/body horizontal overflow at any checked viewport, keyboard-operable sorting and column resizing with real ARIA values, real accessible names on management and filter controls, and central dialog close-focus restoration.
5. **Management-component surface re-audited, and visible branding.** The six sidebar management families are now fully audited: the pool `*Section` components that no runtime, re-export, dynamic, config or test path reached — and which the production module graph confirmed were never bundled — were removed, and every surviving management dialog is untouched. The sidebar rows and their modals remain the only implementation of that UI. Every reachable surface presents exactly one name, `PaperLume`; internal identifiers, resource names, and historical documentation were deliberately left intact.
