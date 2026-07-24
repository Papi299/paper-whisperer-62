# Product Feature Audit

**Task:** PRODUCT-FEATURE-AUDIT-001 \
**Baseline commit:** `5a92229f28e2e7fc33d24394fb3ca25802e86dd4` \
**Audit date:** `2026-07-24` \
**Status:** Point-in-time repository audit and owner decision packet

> This document is a **point-in-time, evidence-based capability audit** and an owner decision packet. It is **not** an evergreen implementation authority and does not select or implement any feature. Current-state truth continues to live in [start-here.md](start-here.md); durable decisions in [decisions-and-triggers.md](decisions-and-triggers.md); owner gates in [owner-decisions.md](owner-decisions.md).

---

## 1. Executive summary

Paper Whisperer is a **mature, single-user academic paper library manager** with a deep, coherent core workflow. The strongest areas — import, the server-side read path, search, projects/tags, curation pools, notes, deduplication, bulk actions, and export — are **shipped and reachable end to end**, with substantial Vitest and Playwright coverage. The engineering baseline is strong: no `TODO`/`FIXME`/`HACK` markers, no skipped or `.only` tests, RLS + S1 (RPC ownership) + S2 (client scoping) applied consistently, and a required `Validate` CI gate on `main`.

The README describes the app as "feature-complete at current scale." Assessed independently, that is defensible **for the core library-management loop** but should be read alongside the app's own "Not implemented" list: **account lifecycle** (self-serve deletion, account-level data export) is absent, and the **AI-analysis quota UX** is incomplete. AI and storage quota enforcement are **live server-side** (a Free user has a real 15-call lifetime AI cap), yet **no client surface reads any entitlement/usage table**, and the client shows a **generic error** instead of the structured `402` quota message — the most user-visible partial workflow found.

- **Blocking remediation:** **None.** No Critical or High finding blocks feature selection (see §9, Outcome A).
- **Capabilities audited:** **31** — Shipped-complete 22, Shipped-partial 3, Infrastructure-only 4, Planning-only 1, Dormant-orphaned 0, Unknown-manual 1 (see §4).
- **Active feature candidates:** **9** (all non-commercial; commercial/launch work excluded under C27 — see §14).
- **Owner shortlist (three distinct directions, owner-gated):** **PFA-C01** AI-quota UX completion (recommended), **PFA-C02** full-account data export (alternative), **PFA-C03** isolated staging + phased CI E2E/DB tests (strategic alternative). The shortlist is a curated set of distinct strategic directions, not strictly the numeric top three — see §13.
- **No feature was implemented.** This PR is documentation-only.

## 2. Audit scope and method

- **Baseline SHA:** `5a92229f28e2e7fc33d24394fb3ca25802e86dd4` — the merge commit of PR #164, verified as the current `origin/main` HEAD with a clean working tree. No commits reached `main` after the expected SHA. Generated-types blob `src/integrations/supabase/types.ts` verified at `97534296d6f32bc6df45abdeba76bd76afd97b5b`. Branch protection requires `validate` (strict) and conversation resolution.
- **Areas inspected:** entire tracked tree (298 files) — `src/pages`, `src/components`, `src/hooks`, `src/lib`, `src/contexts`, `src/integrations`, `src/workers`; all 65 `supabase/migrations/`, `supabase/functions/` and `supabase/config.toml`; `src/**/__tests__` + `e2e/`; `.github/workflows/validate.yml`; and the documentation set under `docs/` plus `README.md`.
- **Method:** `git ls-files`, `git grep`/`rg` gap searches (`TODO|FIXME|HACK|XXX`, `skip|only`, `stub`, `not implemented`, `console.error/warn`, `throw new Error`), route/mount tracing from `src/App.tsx`, and UI→hook→PostgREST/RPC→Edge Function flow tracing per journey.
- **Evidence hierarchy:** strong user-facing (reachable route/mount + wired state/mutation + backend + tests) > infrastructure-only (schema/RPC/function/type with no reachable consumer) > planning-only (docs/comments/decisions). Tests corroborate reachability but do not alone prove a shipped product feature.
- **Status taxonomy (closed set — exactly one primary status per capability/journey):** `Shipped — complete at current scope`, `Shipped — partial or fragile`, `Infrastructure only`, `Planning only`, `Dormant or orphaned`, `Unknown — manual verification required`. Backend-only / no-UX / runtime-only qualifiers live in the evidence, scope, confidence, or material-gap columns — never inside the primary status. Findings that are risks rather than capabilities carry a separate `Finding type:` label instead of a capability status. **Confidence:** `High` / `Medium` / `Low`.
- **Limitations:** static repository evidence only. **No** Production authentication, **no** remote Supabase read/mutation, **no** Edge Function invocation, **no** Gemini call, **no** Playwright run, **no** external/competitor research. Runtime-only claims (accessibility, live quota behavior) are labelled and deferred to §15.

## 3. Reachable product surface

React Router defines four real routes plus a catch-all. Route guarding is a client redirect for UX only; **RLS is the real boundary**. The entire authenticated product lives on `/dashboard`; most capabilities are dialogs/modals launched from the sidebar and header.

| Entry point | Auth | Primary user action | Active implementation evidence | Status | Confidence |
|---|---|---|---|---|---|
| `/` (`Index`) | Public | Redirect to `/dashboard` or `/auth` | `src/pages/Index.tsx` uses `useAuth` | Shipped — complete at current scope | High |
| `/auth` (`Auth`) | Public | Sign in / sign up / forgot-password | `src/pages/Auth.tsx`, `supabase.auth.*`, zod validation | Shipped — complete at current scope | High |
| `/reset-password` | Public (recovery link) | Set new password | `src/pages/ResetPassword.tsx`, `updateUser` | Shipped — complete at current scope | Medium |
| `/dashboard` (`Dashboard`) | Guarded redirect | Full app: list, filter, import, edit, bulk, dedup, AI | `src/pages/Dashboard.tsx` + ~15 hooks | Shipped — complete at current scope | High |
| `*` (`NotFound`) | Public | 404 fallback (logs to `console.error`) | `src/pages/NotFound.tsx` | Shipped — complete at current scope | High |
| Add Papers dialog | Guarded | Identifier / file / manual ingestion + assignment | `AddPaperDialog.tsx` → `useBulkMutations` | Shipped — complete at current scope | High |
| Edit Paper dialog | Guarded | Edit metadata, notes, attachments, abstract | `EditPaperDialog.tsx` → `usePaperMutations`, `useAttachments` | Shipped — complete at current scope | High |
| Find Duplicates dialog | Guarded | Scan + merge PMID/DOI duplicates | `DeduplicationDialog.tsx` → `useDeduplication` | Shipped — complete at current scope | High |
| Sidebar manage modals (Projects, Tags, Keywords, Study Types, Synonyms, Exclusions) | Guarded | Taxonomy + pool CRUD | `Sidebar.tsx` + `PoolsContext` + per-pool hooks | Shipped — complete at current scope | High |
| Settings dialog | Guarded | Set/clear PubMed API key | `SettingsDialog.tsx` → `useSettings` | Shipped — complete at current scope | High |
| Analytics panel | Guarded | Aggregate stats over filtered set | `AnalyticsPanel.tsx` → `useAnalyticsData` | Shipped — complete at current scope | Medium |
| Sign-out | Guarded | End session | Sidebar dropdown → `useAuth().signOut` | Shipped — complete at current scope | High |

## 4. Capability matrix

| ID | Domain | Capability | Status | Conf. | User-facing evidence | Data/backend evidence | Test evidence | Material gap |
|---|---|---|---|---|---|---|---|---|
| CAP-AUTH-01 | Auth | Email/password sign-in/up, session restore, sign-out | Shipped — complete at current scope | High | `Auth.tsx`, `useAuth.ts`, `Sidebar.tsx` | Supabase Auth, `handle_new_user` trigger | `e2e/auth.spec.ts` | Leaked-password protection disabled (advisor) |
| CAP-AUTH-02 | Auth | Password reset (email → set new) | Shipped — complete at current scope | Medium | `Auth.tsx` forgot flow, `ResetPassword.tsx` | `resetPasswordForEmail`, `updateUser` | none direct | Email delivery is runtime-only |
| CAP-ONBOARD-01 | Onboarding | Empty-library first action | Shipped — partial or fragile | Medium | `PaperList.tsx:361` "No papers yet…" | n/a | none | Doesn't mention file import / taxonomy (PFA-F005) |
| CAP-IMPORT-01 | Ingestion | PMID/DOI identifier batch import | Shipped — complete at current scope | High | `AddPaperDialog.tsx` | `fetch-paper-metadata`, `bulk_insert` RPC | `e2e/paper-import.spec.ts` | — |
| CAP-IMPORT-02 | Ingestion | Title-based import (auto first match) | Shipped — complete at current scope | High | `AddPaperDialog.tsx:568` static warning | `fetch-paper-metadata` | `importParsers.test.ts` | No per-paper confirm — accepted by decision |
| CAP-IMPORT-03 | Ingestion | File import BibTeX/RIS/NBIB/ENW/CSV/TSV | Shipped — complete at current scope | High | `AddPaperDialog.tsx` dropzone | `importParsers.ts`, `bulk_insert` | `importParsers.test.ts`, `e2e/file-import-order.spec.ts` | — |
| CAP-IMPORT-04 | Ingestion | Manual paper creation | Shipped — complete at current scope | High | `AddPaperDialog.tsx` manual tab | `usePaperMutations.addPaperManually` | `AddPaperDialog.test.tsx` | — |
| CAP-IMPORT-05 | Ingestion | Import continuation + assignment loop | Shipped — complete at current scope | High | `AddPaperDialog.tsx` (PR #164) | junction RPCs | `useBulkMutations-assignment.test.ts` | — |
| CAP-LIB-01 | Library | Server-side list, pagination, lazy load, sort | Shipped — complete at current scope | High | `PaperList.tsx`, `Dashboard.tsx` | `buildPapersQuery.ts`, pagination indexes | `e2e/eager-load.spec.ts`, `filters.spec.ts` | Large-library thresholds unverified at scale |
| CAP-LIB-02 | Library | Filters (year, study type, notes, keyword, project, tag) | Shipped — complete at current scope | High | `SearchFilters.tsx`, `useFilterState.ts` | filter RPCs, junction pagination | `e2e/filters.spec.ts` | — |
| CAP-LIB-03 | Library | Project/Tag Any/All match modes | Shipped — complete at current scope | High | `useFilterState.ts` | `resolveJunctionPaperIds` | `useFilterState.test.tsx` | — |
| CAP-SEARCH-01 | Search | Phrase / FTS / short search + "Matched in:" attribution | Shipped — complete at current scope | High | `useFilterState.ts`, `PaperList.tsx` | `search_papers`, `search_papers_short` RPCs | `e2e/search-attribution.spec.ts` | Function `search_path` mutable (advisor) |
| CAP-PROJ-01 | Projects | Create/edit/delete + assignment + filtering | Shipped — complete at current scope | High | `ManageProjectsModal.tsx`, `EditProjectDialog.tsx` | `useProjectMutations`, FK cascade | `projectTagMutations-cache.test.ts` | — |
| CAP-TAG-01 | Tags | Full tag lifecycle (mirror of projects) | Shipped — complete at current scope | High | `ManageTagsModal.tsx`, `EditTagDialog.tsx` | `useTagMutations`, FK cascade | `projectTagMutations-cache.test.ts` | — |
| CAP-PRESET-01 | Presets | Saved searches (create/load/update/rename/delete, dirty state) | Shipped — complete at current scope | High | `FilterPresetsMenu.tsx`, `Dashboard.tsx` | `filter_presets` table, payload v3 + v1/v2 reads | `useFilterPresets.test.ts`, `e2e/filter-presets.spec.ts` | — |
| CAP-DETAIL-01 | Detail | View/edit metadata, on-demand abstract, keywords, study type | Shipped — complete at current scope | High | `EditPaperDialog.tsx`, `useAbstract.ts` | `papers` table, RLS | `e2e/mutations.spec.ts` | — |
| CAP-POOLS-01 | Curation | Keyword / synonym / study-type / exclusion pools | Shipped — complete at current scope | High | Sidebar modals, `PoolsContext.tsx` | pool tables, FK cascade, re-eval hooks | `e2e/pools.spec.ts` | Gating flag `premium_taxonomy_enabled` unenforced (infra-only) |
| CAP-NOTES-01 | Notes | Per-paper notes, indexed into search | Shipped — complete at current scope | High | `EditPaperDialog.tsx` | `notes` column + search RPC | `e2e/notes.spec.ts` | — |
| CAP-ATTACH-01 | Attachments | Upload/list/signed-URL view/delete, size+MIME limits | Shipped — partial or fragile | High | `EditPaperDialog.tsx`, `useAttachments.ts` | private bucket, owner policies, storage-quota triggers | `e2e/attachments.spec.ts` | Quota workflow incomplete: usage invisible; over-quota surfaces raw DB error (PFA-F004) |
| CAP-AI-01 | AI | Single + bulk AI analysis (TL;DR, study type, stats) | Shipped — partial or fragile | High | `usePaperAnalysisActions.ts`, `PaperList.tsx` | `analyze-paper`, `consume/refund_ai_quota` | `usePaperAnalysisActions.test.ts` | 402 not surfaced; no usage/plan display (PFA-F001) |
| CAP-DEDUP-01 | Dedup | PMID/DOI detection, transitive merge, keep-suggestion | Shipped — complete at current scope | High | `DeduplicationDialog.tsx`, `useDeduplication.ts` | `get_duplicate_papers`, `merge_exact_duplicates` | `mergeOverlappingGroups.test.ts`, `parseDuplicateGroups.test.ts` | PMID/DOI-only by decision |
| CAP-BULK-01 | Bulk | Select-all across filtered set, bulk project/tag/delete/analyze | Shipped — complete at current scope | High | `BulkActionsToolbar.tsx`, `useBulkSelection.ts` | `allFilteredIds`, atomic junction RPCs | `e2e/bulk-actions.spec.ts` | — |
| CAP-EXPORT-01 | Export | CSV / RIS / BibTeX, chunked large-library pipeline | Shipped — complete at current scope | High | `SearchFilters.tsx`, `useExportPapers.ts` | `exportUtils.ts`, `fetchAllPages` | `largeExportPipeline.test.ts` | — |
| CAP-ANALYTICS-01 | Analytics | Aggregate stats over filtered set | Shipped — complete at current scope | Medium | `AnalyticsPanel.tsx` | `useAnalyticsData.ts` | none direct | Weak automated coverage |
| CAP-SETTINGS-01 | Settings | Per-user PubMed API key | Shipped — complete at current scope | High | `SettingsDialog.tsx`, `useSettings.ts` | `profiles.pubmed_api_key`, used by metadata fn | `useSettings.test.ts` | — |
| CAP-ACCOUNT-01 | Account | Self-serve deletion / account-level data export / profile mgmt | Planning only | High | none (Settings = API key only) | none | none | Entire journey absent (PFA-F003) |
| CAP-COMM-01 | Commercial | Entitlement/usage/subscription read model | Infrastructure only | High | none (client reads no entitlement table) | 6 tables + RLS in `2026052101/03` migrations | — | No UI consumer; C27 paused |
| CAP-COMM-02 | Commercial | AI quota enforcement (server) | Infrastructure only | High | none (no user-facing surface) | `consume/refund_ai_quota` live — enforcement active, backend-only | `usePaperAnalysisActions.test.ts` (client path) | No client UX (see CAP-AI-01) |
| CAP-COMM-03 | Commercial | Storage quota enforcement (server) | Infrastructure only | High | none (no user-facing surface) | `check_and_consume_storage_quota` trigger live — enforcement active, backend-only | none (no DB tests) | No usage UX (PFA-F004) |
| CAP-COMM-04 | Commercial | Paper-limit & premium-taxonomy gating | Infrastructure only | High | none | fields defined, never enforced | none | Unenforced entitlement fields (PFA-F007) |
| CAP-A11Y-01 | A11y/Responsive | Keyboard/focus/labels; narrow-screen layout | Unknown — manual verification required | Low | Radix primitives, form labels present | n/a | none | Desktop-first shell; runtime-only (PFA-F008, §15) |

**Status distribution (31 capabilities — every `CAP-*` row counted; totals sum to 31):**

| Status | Count |
|---|---|
| Shipped — complete at current scope | 22 |
| Shipped — partial or fragile | 3 |
| Infrastructure only | 4 |
| Planning only | 1 |
| Dormant or orphaned | 0 |
| Unknown — manual verification required | 1 |
| **Total** | **31** |

The three `Shipped — partial or fragile` capabilities are `CAP-ONBOARD-01`, `CAP-ATTACH-01`, `CAP-AI-01`. The four `Infrastructure only` are `CAP-COMM-01`–`CAP-COMM-04`. (The orphaned `Header.tsx`/`NavLink.tsx` are not product capabilities and appear only in §5/§6, so the capability matrix has zero `Dormant or orphaned` rows.)

### 4.1 Journey coverage summary

Every required product journey (task §7.1–§7.20) was inspected. Status is the dominant verdict for that journey; linked findings capture the gaps.

| Journey | Verdict | Note / linked finding |
|---|---|---|
| 7.1 Authentication & account entry | Shipped — complete at current scope | sign-in/up/reset/sign-out all wired; no profile page beyond API key |
| 7.2 Initial library onboarding | Shipped — partial or fragile | valid first action; thin zero-state (PFA-F005) |
| 7.3 Paper ingestion | Shipped — complete at current scope | identifier + title + BibTeX/RIS/NBIB/CSV + manual + continuation |
| 7.4 Library & read path | Shipped — complete at current scope | server filter/sort/paginate/lazy-load; scale unproven |
| 7.5 Search | Shipped — complete at current scope | phrase/FTS/short + "Matched in:" attribution |
| 7.6 Projects | Shipped — complete at current scope | full CRUD + assignment + Any/All |
| 7.7 Tags | Shipped — complete at current scope | mirror of projects |
| 7.8 Saved filters / presets | Shipped — complete at current scope | v3 payload, v1/v2 back-compat, dirty state, stale-ref guard |
| 7.9 Paper detail & editing | Shipped — complete at current scope | metadata/notes/abstract/attachments |
| 7.10 Curation pools | Shipped — complete at current scope | keywords/synonyms/study-types/exclusions; gating flag unenforced (PFA-F007) |
| 7.11 Notes | Shipped — complete at current scope | CRUD + search-indexed |
| 7.12 Attachments | Shipped — partial or fragile | upload/view/delete work; quota workflow incomplete — usage invisible, raw over-quota error (PFA-F004) |
| 7.13 AI analysis & classification | Shipped — partial or fragile | live path; 402 UX gap (PFA-F001) |
| 7.14 Duplicate handling | Shipped — complete at current scope | PMID/DOI-only by decision; transitive merge |
| 7.15 Bulk operations | Shipped — complete at current scope | select-all across filtered set |
| 7.16 Export | Shipped — complete at current scope | CSV/RIS/BibTeX, chunked |
| 7.17 Responsive & accessibility | Unknown — manual verification required | desktop-first; runtime-only (PFA-F008, §15) |
| 7.18 Error/loading/empty states | Shipped — partial or fragile | generic AI-quota errors (PFA-F001) and raw storage-quota errors (PFA-F004); thin first-run empty-state (PFA-F005); no isolated-env verification (PFA-F006, test risk) |
| 7.19 Account lifecycle & portability | Planning only | no deletion/export (PFA-F003) |
| 7.20 Commercial foundations | Infrastructure only | enforcement live but backend-only, no UX; C27 paused (§14) |

## 5. End-to-end workflow findings

Findings are ordered by the journeys in the task's §7. Severity per the task's definitions. No finding is fixed in this PR.

### PFA-F001 — AI quota `402` is not surfaced; no usage/plan display (journey 7.13, 7.20)
- **Severity:** Medium · **Classification:** Shipped — partial or fragile · **Confidence:** High · **Affected user:** every user, especially Free (15-call lifetime cap).
- **Current behavior:** `analyze-paper` consumes a quota unit and returns a structured **HTTP 402** (`{error:"quota_exceeded", message:"AI analysis quota exceeded.", details:{used,quota,remaining,…}}`) when the cap is reached. The client (`usePaperAnalysisActions.ts`) calls `supabase.functions.invoke(...)`, does `if (error) throw error`, and toasts `err.message` — which for a non-2xx is the generic *"Edge Function returned a non-2xx status code."* The structured body lives in `error.context` and is never read. No screen anywhere shows plan, quota, remaining, or reset date.
- **Expected complete behavior:** the 402 body is parsed and shown as an actionable message ("You've used all N AI analyses"), and remaining quota is visible near the analyze controls.
- **Evidence:** `usePaperAnalysisActions.ts:116-140,185-201`; `supabase/functions/analyze-paper/index.ts:196-220`; `consume_ai_quota` returns `used/quota/remaining/reset_at`; no `src/**` file reads `usage_counters`/`user_entitlements` (only `types.ts`). `user_storage_usage`/`usage_credits`/`user_entitlements` already allow **client SELECT-own**, so the read path needs no new policy.
- **User impact:** a real user hits a hard wall with a cryptic error and no way to understand it. **Technical implication:** client-only change (plus optional SELECT-own reads). **Recommended next action:** PFA-C01. **Task type:** Workflow completion / Remediation.

### PFA-F002 — Orphaned components `Header.tsx` and `NavLink.tsx` (journey 6.1)
- **Severity:** Low · **Classification:** Dormant or orphaned · **Confidence:** High.
- **Current behavior:** `src/components/layout/Header.tsx` (a top-bar with sign-out) and `src/components/NavLink.tsx` have **no import sites** — the Dashboard uses `Sidebar` for sign-out instead. Dead but compiled/typechecked.
- **Evidence:** `git grep` finds no importer for either. **User impact:** none (not shipped). **Technical implication:** minor maintenance noise. **Recommended next action:** PFA-C07. **Task type:** Remediation.

### PFA-F003 — No account deletion or account-level data export (journey 7.19)
- **Severity:** Medium · **Classification:** Planning only · **Confidence:** High · **Affected user:** all.
- **Current behavior:** the only account surface is the PubMed key in Settings. There is no self-serve account/data deletion and no user-level "export all my data." (Per-selection CSV/RIS/BibTeX export exists but is a citation export, not a portability/backup of the full account.)
- **Expected complete behavior:** a Settings surface to export **all** account-owned data (papers, notes, projects/tags and their relationships, presets, pools, synonyms, exclusions, attachment metadata + binaries, non-secret profile — see PFA-C02 Option A) and to delete the account with its data.
- **Evidence:** `SettingsDialog.tsx` (key only); README "Not implemented" list. **User impact:** data-ownership/portability and privacy expectations unmet. **Technical implication:** export is client-composable from existing reads; deletion needs a privileged cascade path (the app uses **no** service-role key today — architectural friction). **Recommended next action:** PFA-C02 (export) and/or PFA-C04 (deletion). **Task type:** Product feature.

### PFA-F004 — No storage-usage indicator; over-quota shows raw DB error (journey 7.12, 7.20)
- **Severity:** Low · **Classification:** Shipped — partial or fragile · **Confidence:** High.
- **Current behavior:** uploads over the entitlement `storage_quota_bytes` fail via the BEFORE INSERT trigger; the client cleans up the orphan storage object and toasts the raw Postgres string *"Storage quota exceeded (quota …, attempted +… bytes)"*. No proactive usage gauge exists, though `user_storage_usage` already allows client SELECT-own.
- **Evidence:** `useAttachments.ts:126-143`; `20260521030000_*` trigger. **Recommended next action:** PFA-C05. **Task type:** Product enablement.

### PFA-F005 — Thin first-run/empty-state onboarding (journey 7.2)
- **Severity:** Low · **Classification:** Shipped — partial or fragile · **Confidence:** Medium.
- **Current behavior:** the empty library shows "No papers yet / Add papers using PMIDs, DOIs, or titles" — a valid first action, but it omits file import and gives no guidance for taxonomy/pools. No zero-state coaching elsewhere.
- **Evidence:** `PaperList.tsx:358-366`. **Recommended next action:** PFA-C06. **Task type:** UX/accessibility improvement.

### PFA-F006 — No isolated staging; RLS/S1/quota atomicity unverified in CI (journey 7.18, §8)
- **Severity:** Medium · **Finding type:** Test risk · **Confidence:** High.
- **Current behavior:** Playwright runs the local dev server against the **production** Supabase project and is excluded from required CI; there are no pgTAP database tests, so RLS isolation, S1 guards, and quota consume/refund atomicity have **no automated verification**. Required CI is lint + typecheck + Vitest + build only.
- **Evidence:** `start-here.md` testing baseline; `.github/workflows/validate.yml`; no `supabase/tests`. **Recommended next action:** PFA-C03. **Task type:** Test-environment enablement. (Owner-dependent: needs a staging Supabase project decision. Do **not** add mutating Production-backed tests to required CI.)

### PFA-F007 — Unenforced entitlement fields `paper_limit` / `premium_taxonomy_enabled` (journey 7.10, 7.20)
- **Severity:** Low · **Classification:** Infrastructure only · **Confidence:** High.
- **Current behavior:** both fields are defined with Free/Pro defaults and documented intent (gate Synonyms + Exclusions; cap papers) but are **read/enforced nowhere** in code or migrations. Not a defect under C27 (commercial gating is paused), but a latent inconsistency to resolve before any gating ships.
- **Evidence:** `git grep` shows both only in the entitlement schema + `types.ts`. **Recommended next action:** track under deferred commercial work (§14). **Task type:** (deferred) Product enablement.

### PFA-F008 — Desktop-first layout; narrow-screen behavior unverified (journey 7.17)
- **Severity:** Low · **Classification:** Unknown — manual verification required · **Confidence:** Low.
- **Current behavior:** the shell is a fixed `w-64` sidebar + `h-screen` flex; there is no mobile navigation collapse. Accessibility relies on Radix primitives and present form labels, but keyboard/focus/announcement behavior cannot be proven statically. Mobile packaging is deferred (C7).
- **Evidence:** `Dashboard.tsx:556-575`, `Sidebar.tsx`. **Recommended next action:** PFA-C09 (low priority) + §15 manual checks. **Task type:** UX/accessibility improvement.

### PFA-F009 — Known Supabase security-hardening advisories (journey 7.1, §12)
- **Severity:** Low · **Finding type:** Security hardening · **Confidence:** Low (advisors recorded 2026-07-17; not re-verified here — no Production access).
- **Current behavior:** recorded advisors — mutable `search_path` on five functions (incl. `search_papers`); SECURITY DEFINER RPCs executable by `anon` (all `auth.uid()`-guarded, so unexploited); Auth leaked-password protection disabled. No secret is committed; no exploit path is implied here.
- **Evidence:** `start-here.md` "Current risks". **Recommended next action:** PFA-C08 as a separate bounded security remediation. **Task type:** Remediation.

## 6. Disconnected and infrastructure-only inventory

Presence here is **not** a defect assertion — much of it is intentional forward-provisioning under C27.

- **Commercial read model (infrastructure only):** `user_entitlements`, `subscriptions`, `subscription_events`, `usage_counters`, `usage_credits`, `user_storage_usage` — full schema + RLS, but **no client screen reads any of them**. `usage_credits`/`user_entitlements`/`user_storage_usage` even pre-authorize client SELECT-own for future UI.
- **Live enforcement without UX:** `consume_ai_quota`/`refund_ai_quota` (called by `analyze-paper`) and the storage-quota triggers are **active**, but the only user-visible outputs are a generic AI error and a raw storage error string.
- **Unused/unreachable UI:** `src/components/layout/Header.tsx`, `src/components/NavLink.tsx` (no importers).
- **Unenforced entitlement fields:** `paper_limit`, `premium_taxonomy_enabled` (defined, never read).
- **Test-covered helper, no production caller check:** none material — audited helpers (`mergeOverlappingGroups`, `evaluateStudyType`, export/import parsers) all have active callers.
- **Planned-only:** account deletion/export, paywall/checkout/portal, marketing/legal pages, mobile packaging (all documented as future).

## 7. Documentation and implementation mismatches

Only material items. Current executable code/schema is treated as the primary implementation evidence.

| ID | Documentation claim | Implementation evidence | Assessment | Recommended documentation action |
|---|---|---|---|---|
| DM-01 | `README.md`: "core application is **stable, hardened, and feature-complete at current scale**" | Core library loop is complete, but account deletion/export absent and AI-quota UX incomplete (PFA-F001/F003) | Defensible **with** the qualifier + the adjacent "Not implemented" list; not an objective factual error | None required now; revisit if account-lifecycle ships. Documented here per policy. |
| DM-02 | `start-here.md`: "nothing surfaces the 402 or storage-quota errors as an upgrade path yet" | Confirmed accurate — client shows generic/raw errors | **Accurate** (docs already honest about the gap) | None. |
| DM-03 | `start-here.md` (line 16) / `README`: "four routes" | Four named routes **plus** a `*` catch-all (`NotFound`) | Accurate for named routes; catch-all is a fallback, not a mismatch | None. |
| DM-04 | `start-here.md` handoff still frames IMPORT-CONTINUATION-WORKFLOW-001 as the active in-flight PR | PR #164 merged into `main` at the baseline SHA | **Stale after merge** | Corrected in this PR (see §13 handoff update). |

## 8. Test and verification risk map

Required CI runs **lint + typecheck + Vitest + production build** only. Playwright is **production-backed and excluded from required CI**; there are **no** pgTAP/Deno tests. Do **not** add mutating Production-backed tests to required CI.

| Workflow | Unit/component (Vitest) | E2E (Playwright, non-CI) | In required CI | Material gap | Risk |
|---|---|---|---|---|---|
| Auth / session | partial | `auth.spec.ts` | Vitest+build | Email delivery runtime-only | Medium |
| Import (identifier/file/manual/continuation) | strong (`importParsers`, `AddPaperDialog`, `useBulkMutations-assignment`) | `paper-import`, `file-import-order`, `import-order` | yes (Vitest) | metadata fetch is runtime | Low |
| Read path / filters / sort / pagination | strong (`useFilterState`, `filterSets`, `buildPapersQuery` indirectly) | `filters`, `eager-load` | yes | large-scale unproven | Low |
| Search (phrase/FTS/short + attribution) | partial | `search-attribution` | yes | RPC behavior needs DB | Medium |
| Projects / Tags / Presets | strong (`projectTagMutations-cache`, `useFilterPresets`) | `filter-presets` | yes | — | Low |
| Notes | partial | `notes` | yes | — | Low |
| Attachments / storage quota | none for quota trigger | `attachments` | E2E only for upload | **quota atomicity untested** | Medium |
| AI analysis + quota consume/refund | client path (`usePaperAnalysisActions`) mocked | none (real-Gemini E2E rejected by decision) | Vitest (client) | **server quota atomicity untested**; 402 UX untested | Medium |
| Dedup detect/merge | strong (`mergeOverlappingGroups`, `parseDuplicateGroups`) | none direct | yes | merge RPC needs DB | Medium |
| Bulk actions / export | strong (`largeExportPipeline`) | `bulk-actions` | yes | — | Low |
| RLS isolation / S1 guards | **none** | **none** | no | **no automated verification** | Medium |

## 9. Blocking-remediation gate

### Outcome A

`No Critical or High blocking remediation was identified. The owner may proceed to select the next feature from the ranked candidates after this audit is approved and merged.`

No evidence of cross-user data exposure, destructive data loss, auth bypass, secret exposure, or irreversible corruption was found: RLS + S1 + S2 are applied consistently, attachments are private/owner-scoped, commercial tables are deny-all, dedup merge is fail-closed, and env validation fails fast. The highest-severity findings are **Medium** (PFA-F001, F003, F006) with reasonable interim workarounds, so none blocks feature selection.

## 10. Candidate backlog

Discrete, non-combined candidates. Sizes are ordinal (no time estimates).

| Candidate | Type | User problem | Evidence | Proposed bounded scope | Dependencies | Size | Risk |
|---|---|---|---|---|---|---|---|
| PFA-C01 | Workflow completion / Remediation | AI analysis dead-ends with a cryptic error at the quota wall; usage is invisible | PFA-F001; `usePaperAnalysisActions.ts`, `analyze-paper` 402, `consume_ai_quota` fields | Parse 402 body → actionable toast/banner; read `usage_counters`/`user_entitlements` (SELECT-own) to show used/remaining near analyze controls | none (policies already allow SELECT-own) | Small–Medium | Low |
| PFA-C02 | Product feature | No way to export/back up the full account (data ownership/portability) | PFA-F003; `SettingsDialog.tsx` | **Full account data export (Option A).** Settings action producing one ZIP covering **all** user-owned data: papers + metadata, notes, projects + project↔paper links, tags + tag↔paper links, filter presets, keyword pools, study-type pools, synonyms, exclusions, attachment metadata, **attachment binary files**, and non-secret profile/settings. Explicitly excludes credentials, tokens, and secrets | reuses existing read hooks + signed-URL attachment fetch | Medium | Medium |
| PFA-C03 | Test-environment enablement | Playwright hits Production; RLS/S1/quota atomicity have no automated verification | PFA-F006; `validate.yml` | **Two-phase (Model A). Phase A:** isolated staging Supabase project + non-required Playwright CI. **Phase B:** representative automated DB-security/integrity tests (cross-user RLS isolation, SECURITY DEFINER caller/ownership validation, AI quota consume/refund atomicity, storage-quota enforcement). **Not complete until both phases ship**, even across separate PRs | owner decision on staging project | Epic — must be phased | Medium |
| PFA-C04 | Product feature | No self-serve account/data deletion | PFA-F003 | Settings "delete my account + data" via a privileged Edge Function (cascades) with explicit confirmation | new privileged deletion path (no service-role key today) | Medium–Large | Medium–High |
| PFA-C05 | Product enablement | Storage usage is invisible until an upload is rejected | PFA-F004; `user_storage_usage` SELECT-own | Settings → Storage gauge (used/quota) reading `user_storage_usage` + entitlement | none (policy exists) | Small | Low |
| PFA-C06 | UX/accessibility improvement | Thin first-run guidance | PFA-F005; `PaperList.tsx` | Enrich empty states (mention file import; taxonomy hint); optional first-run tips | none | Small | Low |
| PFA-C07 | Remediation | Dead components add noise | PFA-F002 | Delete `Header.tsx` + `NavLink.tsx` (confirm no import) | none | Small | Low |
| PFA-C08 | Remediation | Recorded Supabase security advisories | PFA-F009; `start-here.md` risks | Pin function `search_path`; restrict RPC EXECUTE to `authenticated`; enable leaked-password protection (owner Auth setting) | owner Auth-setting action | Small–Medium | Low |
| PFA-C09 | UX/accessibility improvement | Desktop-only shell; narrow-screen unverified | PFA-F008 | Responsive pass: collapsible sidebar, table overflow, focus/labels audit | overlaps deferred mobile (C7) | Medium | Low |

## 11. Prioritization method

Ordinal scoring (comparative only — **not** time estimates, and not a substitute for owner judgment). Weak-evidence candidates must not outrank strong-evidence ones on speculative impact; where frequency is unknown it is scored conservatively.

Dimensions: User impact (0–5), Workflow frequency (0–5), Gap severity (0–5), Strategic leverage (0–5), Evidence confidence (0–3), Implementation effort (1–5), Dependency/risk penalty (0–3).

**Evidence-confidence mapping (0–3):** `High = 3`, `Medium = 2`, `Low = 1`, `Insufficient evidence = 0`. Each candidate's confidence score equals its supporting finding's confidence unless a candidate-specific reason is stated. Every candidate here inherits its finding's confidence directly — `PFA-C08` (Low, from `PFA-F009`) and `PFA-C09` (Low, from `PFA-F008`) both score `1`; the remaining candidates trace to High findings (`3`) except `PFA-C06` (Medium, from `PFA-F005` → `2`).

```text
Priority score =
(User impact × 3)
+ (Workflow frequency × 2)
+ (Gap severity × 3)
+ (Strategic leverage × 2)
+ Evidence confidence
− (Implementation effort × 2)
− Dependency/risk penalty
```

## 12. Ranked active candidates

Commercial/launch work (C27) is excluded. After the confidence-mapping and scope corrections, all nine scores are distinct (no ties).

| Rank | Candidate | Type | Impact | Freq | Sev | Leverage | Conf | Effort | Penalty | Score | Rationale |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | PFA-C01 | Workflow completion | 4 | 3 | 3 | 3 | 3 | 2 | 0 | **32** | Fixes a live, confusing, high-visibility gap for the primary user; concrete evidence; client-only; reuses existing policies |
| 2 | PFA-C03 | Test-env enablement | 3 | 2 | 3 | 5 | 3 | 5 | 2 | **23** | Highest strategic leverage (phased staging + DB-security tests) but owner-gated + Epic |
| 3 | PFA-C05 | Product enablement | 2 | 2 | 2 | 2 | 3 | 1 | 0 | **21** | Cheap, self-contained; complements PFA-C01 |
| 4 | PFA-C02 | Product feature | 4 | 1 | 3 | 2 | 3 | 4 | 2 | **20** | Strong data-ownership value; Option A (full export incl. attachment binaries) raises effort + completeness risk |
| 5 | PFA-C06 | UX/accessibility | 2 | 2 | 2 | 1 | 2 | 1 | 0 | **18** | Low-cost onboarding polish for every new user |
| 6 | PFA-C04 | Product feature | 3 | 1 | 3 | 2 | 3 | 4 | 2 | **17** | Valuable but destructive + needs a new privileged path |
| 7 | PFA-C08 | Remediation | 2 | 0 | 2 | 2 | 1 | 2 | 1 | **12** | Defense-in-depth; not currently exploitable; Low confidence (advisors not re-verified) |
| 8 | PFA-C09 | UX/accessibility | 2 | 1 | 2 | 1 | 1 | 3 | 1 | **10** | Overlaps deferred mobile (C7); desktop-first tool; Low confidence (runtime-only) |
| 9 | PFA-C07 | Remediation | 1 | 0 | 1 | 1 | 3 | 1 | 0 | **9** | Pure hygiene; trivial |

## 13. Recommended owner shortlist

Exactly three options. Option 1 is the audit recommendation; **the final choice is owner-gated** and no option was selected or implemented. The three options are a curated set of **distinct strategic directions** — a UX remediation (C01), a strategic test-infrastructure investment (C03), and a new user-facing product feature (C02) — deliberately chosen alongside, not strictly equal to, the numeric ranking in §12. Scores inform but do not replace owner judgment; `PFA-C05` (rank 3, a small storage-usage gauge) is a strong low-cost adjacent option the owner may prefer to bundle with C01.

### Option 1 — Recommended

- **Candidate:** PFA-C01 — Complete the AI-analysis quota UX.
- **Target user:** every user; acutely the primary/owner account (Free = 15 lifetime AI calls).
- **Exact problem:** at the quota wall, AI analysis fails with *"Edge Function returned a non-2xx status code"* and remaining quota is invisible everywhere.
- **Current repository evidence:** `usePaperAnalysisActions.ts` throws on `error` and toasts the generic message; `analyze-paper/index.ts:196-220` already returns a structured 402; `consume_ai_quota` returns `used/quota/remaining/reset_at`; no `src/**` reads `usage_counters`/`user_entitlements` (SELECT-own already permitted).
- **Bounded MVP scope:** (1) read `error.context` on 402 and show an actionable message with `used/quota`; (2) show a small "AI: N left" indicator near the analyze/bulk-analyze controls by reading the lifetime/monthly counter + entitlement.
- **Non-goals:** any checkout/upgrade/paywall UX; changing quota numbers; changing the Edge Function/RPCs.
- **Acceptance criteria:** a quota-exhausted analysis shows a clear, specific message (not the generic string); the analyze controls display remaining count; no regression to the success path or bulk cooldown; Vitest covers the 402-parse branch.
- **Likely files/subsystems:** `usePaperAnalysisActions.ts`, a new small `useAiQuota` read hook, `BulkActionsToolbar.tsx`/`PaperList.tsx` indicator.
- **Schema/RPC/Edge expectation:** **none** (read-only client use of existing tables/policies).
- **Testing strategy:** Vitest for the 402-parse + indicator logic (mock `invoke`); manual smoke for the live wall.
- **Key risks:** low — client-only; must not read another user's row (S2 scoping).
- **Dependencies:** none.
- **Why in the shortlist:** highest score (rank #1, 32); fixes a live, user-facing, high-confidence gap at minimal cost and risk.

### Option 2 — Alternative

- **Candidate:** PFA-C02 — Full account data export (**Option A** — complete data portability).
- **Target user:** any user wanting a backup/portability of their whole account.
- **Exact problem:** the only export is per-selection citation formats; there is no export of all account-owned data.
- **Current repository evidence:** `SettingsDialog.tsx` exposes only the PubMed key; README lists account-level export as not implemented; full-library reads already exist (`useExportPapers`, `usePapers`, presets/pools hooks); attachment binaries are reachable via `useAttachments` signed URLs.
- **Bounded MVP scope (Option A — full account):** a Settings action producing **one downloadable ZIP** covering **all** user-owned data: papers + metadata; notes; projects + project↔paper relationships; tags + tag↔paper relationships; filter presets; keyword pools; study-type pools; synonyms; exclusions; attachment metadata; **attachment binary files**; non-secret profile/settings. **Explicitly excludes** credentials, tokens, and any secret.
- **Non-goals:** account deletion (separate, PFA-C04); scheduled/automated backups; re-import; exporting other users' data; any credential/secret.
- **Acceptance criteria:** the archive contains every category above for the signed-in user only; empty account yields a valid empty archive; large libraries + attachments stream via the existing chunked/paged pattern without exhausting memory; no secret/token is ever included.
- **Likely files/subsystems:** `SettingsDialog.tsx`, a new `useAccountExport` hook reusing existing read paths, `useAttachments` (binary fetch), `exportUtils.ts`, a client ZIP assembler.
- **Schema/RPC/Edge expectation:** none required (client composition of existing SELECT-own reads + signed-URL downloads).
- **Testing strategy:** Vitest for the manifest assembler/serializer and the category-completeness check over fixtures.
- **Key risks:** medium — completeness across ~12 data categories; attachment-binary bundling and memory on very large libraries (mitigated by streaming/paging); must never include secrets.
- **Dependencies:** none.
- **Why in the shortlist:** it is the strongest standalone **new user-facing product feature** and the coherent way to close the data-ownership/portability gap (PFA-F003). It ranks #4 by score (20) — below C03 (23) and C05 (21) — because Option A's full-coverage scope raises effort and completeness risk; it is offered as the distinct "ship a user-facing feature" direction, not as the highest number.

### Option 3 — Strategic alternative

- **Candidate:** PFA-C03 — Isolated staging + phased CI E2E and DB-security tests (**Model A** — two phases).
- **Target user:** indirectly all users (quality/safety); directly the maintainer.
- **Exact problem:** Playwright runs against **production** and is excluded from required CI; cross-user RLS isolation, SECURITY DEFINER (S1) ownership validation, and AI/storage quota atomicity have **no automated verification**.
- **Current repository evidence:** `start-here.md` testing baseline; `validate.yml` (no Playwright/DB); no `supabase/tests`.
- **Bounded scope (Model A — phased):**
  - **Phase A:** provision an isolated staging Supabase project mirroring migrations; point Playwright at it via `.env`; add a **non-required** CI job. Required `validate` stays unchanged (no mutating Production tests).
  - **Phase B:** representative automated **database-security/integrity tests** (e.g. pgTAP) covering cross-user RLS isolation, SECURITY DEFINER caller/ownership validation, AI quota consume/refund behavior and atomicity, and storage-quota enforcement (or an explicitly justified bounded subset).
  - **PFA-C03 is not complete until both phases ship** — the two phases may land as separate implementation PRs.
- **Non-goals:** making E2E a required merge gate on day one; touching production data; adding mutating Production-backed tests to required CI.
- **Acceptance criteria:** Phase A — Playwright runs green against staging in a non-required job with documented setup; Phase B — the DB-security suite runs against staging/pgTAP and fails on a deliberately introduced RLS/quota regression. Required `validate` unchanged throughout.
- **Likely files/subsystems:** `playwright.config.ts`, `e2e/global-setup.ts`, `.github/workflows/*`, `supabase/tests/` (pgTAP), `deployment.md`.
- **Schema/RPC/Edge expectation:** no product schema change; staging provisioning + pgTAP test objects.
- **Testing strategy:** the deliverable **is** test enablement (Phase A E2E, Phase B DB-security).
- **Key risks:** medium — owner must approve/provision staging; cost/secrets management; Phase B authoring effort.
- **Dependencies:** owner decision on a staging project (Phase B depends on Phase A).
- **Why in the shortlist:** highest strategic leverage (rank #2, score 23) — de-risks every subsequent feature by actually closing the RLS/S1/quota verification gap, not just the E2E-against-Production one.

## 14. Deferred commercial and launch work (C27 — excluded from active ranking)

C27 pauses (not cancels) commercial/launch implementation. The items below are inventoried but **must not** compete in §12.

- **Already-implemented infrastructure (live):** provider-neutral entitlement/usage/subscription schema (`user_entitlements`, `subscriptions`, `subscription_events`, `usage_counters`, `usage_credits`, `user_storage_usage`); **AI quota enforcement** (`consume/refund_ai_quota` + `analyze-paper` 402); **storage quota enforcement** (triggers). Free entitlement seeded on signup.
- **Missing user-facing commercial capabilities:** paywall/upgrade UX, checkout, customer portal, billing sync, plan/usage display, Free-tier gating of Synonyms/Exclusions (`premium_taxonomy_enabled`), `paper_limit` enforcement, subscription-status surfacing.
- **Owner prerequisites:** Paddle Sandbox setup (C18), marketing-site + legal/support URLs (C16), Google Workspace email, monitoring/error-tracking, staging timing — all **paused** per C27.
- **Re-evaluation trigger:** resume only when the owner explicitly decides to return to commercialization/public-release (C27). Do **not** change C27; do **not** create a new C-number.

> Note: PFA-F001/C01 (surfacing the 402 message + usage) is scoped as **product UX for an already-live enforcement path**, not commercialization — it adds **no** checkout/paywall/upgrade flow — so it is intentionally an active candidate, distinct from the paused billing work above.

## 15. Manual verification checklist

Low-confidence / runtime-dependent items not resolved statically (no Production auth or mutation was performed).

| Workflow | Fixture/account | Read-only or mutating | Safe verification method | Why not done here |
|---|---|---|---|---|
| AI quota wall UX | Free test account with quota exhausted | Mutating (consumes quota) | On staging: exhaust quota, confirm client message | No Production auth; would consume a real quota unit |
| Storage over-quota upload | Test account near cap | Mutating | On staging: upload past cap, confirm error path + orphan cleanup | Mutates storage/DB on Production |
| Password-reset email delivery | Test mailbox | Mutating (sends email) | Trigger reset on staging, confirm receipt via Resend | Depends on live SMTP/Resend |
| RLS isolation between users | Two staging accounts | Read (cross-account probe) | pgTAP or scripted cross-user SELECT on staging | No Production access; needs isolated project |
| Keyboard/focus/screen-reader (A11y) | any account | Read | Manual AT pass + axe on a running build | Runtime-only; static evidence insufficient |
| Narrow-screen/mobile layout | any account | Read | Responsive manual pass on a running build | Runtime-only; mobile deferred (C7) |
| Large-library read-path scaling | Seeded library (5k+ papers) | Read | Seed staging, measure paged queries | Needs isolated seeded environment |

## 16. Evidence appendix

Compact path-and-symbol index (no large excerpts).

```text
src/App.tsx — router: /, /auth, /dashboard, /reset-password, * (NotFound)
src/pages/Dashboard.tsx — main shell; orchestrates ~15 hooks + all dialogs
src/pages/Auth.tsx — sign in/up + forgot-password; ResetPassword.tsx — set new password
src/hooks/useAuth.ts — session state + signOut
src/hooks/usePapers.ts — infinite query, projects/tags, counts, filtered IDs, keyword options RPC
src/hooks/useFilterState.ts — phrase/FTS/short search + junction Any/All + keyword filter
src/lib/buildPapersQuery.ts — shared PostgREST predicate/sort builder
src/components/papers/AddPaperDialog.tsx — identifier/file/manual ingestion + continuation (title warning :568)
src/lib/importParsers.ts — parseBibTeX/parseRIS/parseCSV/parseFile (.bib/.ris/.nbib/.enw/.csv/.tsv)
src/hooks/papers/useBulkMutations.ts — bulk import/assignment/delete orchestration
src/hooks/useDeduplication.ts — get_duplicate_papers + merge_exact_duplicates + union-find
src/hooks/useExportPapers.ts + src/lib/exportUtils.ts — CSV/RIS/BibTeX export
src/hooks/useFilterPresets.ts — saved searches; PRESET_PAYLOAD_VERSION=3 (v1/v2 back-compat)
src/hooks/useAttachments.ts — upload/list(signed URL)/delete; 20MB + MIME limits
src/hooks/usePaperAnalysisActions.ts — single/bulk AI analysis (does NOT parse 402 body)
supabase/functions/analyze-paper/index.ts — auth → consume_ai_quota → Gemini → refund; 402 on quota
supabase/functions/fetch-paper-metadata/index.ts — PubMed/Crossref metadata (unmetered)
supabase/migrations/20260521010000_add_entitlement_usage_schema.sql — commercial read model (infra-only)
supabase/migrations/20260521020000_add_ai_quota_rpcs.sql — consume_ai_quota / refund_ai_quota
supabase/migrations/20260521030000_harden_attachment_privacy_and_storage_quota.sql — storage-quota triggers
src/components/layout/Header.tsx, src/components/NavLink.tsx — orphaned (no importers)
src/components/settings/SettingsDialog.tsx — PubMed key only (no account deletion/export)
.github/workflows/validate.yml — required CI: checkout, node, install, versions, lint, typecheck, vitest, build
```
