# Paper Whisperer

Academic paper library manager with server-side filtering, sorting, pagination, keyword analysis, and AI-powered study classification.

## Tech stack

- **Frontend:** React + TypeScript + Vite + shadcn-ui + Tailwind CSS
- **Backend:** Supabase (Postgres, Auth, Edge Functions, PostgREST)
- **Region:** Supabase free tier, South Asia (Mumbai)

## Current status (April 2026)

The app is **stable, hardened, and feature-complete at current scale**. Nine major work phases are complete:

1. **Read-path performance track** (PRs #56–#65) — server-side filtering, sorting, pagination, lazy loading, abstract on-demand fetch. Handles ~400+ papers with sub-second dashboard loads.
2. **Security & schema integrity hardening** (PRs #67–#76) — edge function logging redaction, PubMed API key server-side migration, RLS restoration on all user-scoped tables, per-user uniqueness constraints, FK cascade fixes, and import UX improvements.
3. **Correctness & hygiene fixes** (PRs #78–#82) — normalization worker error-handling fix, ghost query field removal, client-side code deduplication, Gemini API key transport hardening, and further log sanitization.
4. **Paper notes feature wave** (PRs #84–#87) — `notes` column on `papers` with an Edit-dialog textarea, a list-cell sticky-note indicator with popover preview, a tri-state "Has Notes" filter, and inclusion of notes in full-text search (weight D) and the short-query ILIKE path.
5. **Prefix-aware FTS** (PR #88) — `search_papers` rewritten as prefix-aware FTS so partial inputs match while typing (`guideli` finds "guideline"). Uses a Unicode-preserving blacklist of tsquery operator characters; the existing `search_vector`, GIN index, and short-search RPC are unchanged. Migration applied on Supabase and manually verified.
6. **Search wave — keywords + attribution + phrase search** (PRs #91–#93, docs normalized in PR #94) — `keywords` added to `search_vector` at weight C; both search RPCs return six per-field `matched_*` booleans that drive a read-only "Matched in: …" sub-line on each matching row in fixed field order (PR #91). Double-quoted queries (`"muscle protein synthesis"`) route to a literal phrase-match ILIKE path with no stemming, Unicode-safe, punctuation-preserving; unquoted behavior is bit-identical (PR #92). Search input placeholder reads `Search titles, authors, notes, keywords... Use "..." for exact phrase` for discoverability (PR #93). Migration `20260420010000_keywords_in_search_with_attribution.sql` applied on Supabase and verified end-to-end.
7. **Saved Searches / Filter Presets — full capability** (PRs #96, #98, #99, #101, #102) — Users can save the current filter/search configuration under a name, list saved presets alphabetically, load one (full replacement of all 8 saved fields, with stale project/tag IDs nulled and a toast), update the currently-loaded preset in place, see at a glance when the loaded preset has unsaved changes, rename any preset, and delete with a confirmation. Persistence is **server-side per user** in a new `filter_presets` table with full RLS, `FORCE ROW LEVEL SECURITY`, a case-insensitive unique name per user, an `updated_at` trigger, and a Zod-validated JSONB `payload` with a `version: 1` sentinel. Raw search query strings are saved verbatim, so quoted phrase searches round-trip exactly. Sort state is intentionally **not** in the payload (view concern). The `Update "<name>"` action (PR #98) is id-targeted (never by name lookup), preserves the preset name, and overwrites only the payload. The dropdown label shows the total preset count (`Saved searches · N`) so users notice when more rows exist below the visible area (PR #99). When a preset is loaded, a small accent **dot on the Presets trigger** signals unsaved changes; the dirty signal is derived (no schema change) by comparing the current dashboard state against the loaded preset's stored payload (order-insensitive on `selectedKeywords`), and the `Update "<name>"` menu item is disabled when clean, enabled when dirty (PR #101). Presets can be renamed via a per-row pencil icon → small Rename dialog; rename is id-targeted, metadata-only (`payload`/`created_at`/`id` untouched), reuses the same name validation and the existing `23505` → "Name already taken" pattern, has a no-op short-circuit (unchanged trimmed name → no Supabase write, no `updated_at` bump, no toast), and supports intentional case-only rename. Rename does not affect the dirty-state dot. (PR #102.) Migration `20260421010000_add_filter_presets.sql` is applied to live Supabase and verified both structurally (post-deploy SQL spot-checks) **and empirically** (two separate accounts confirmed cross-user RLS isolation — each user sees only their own rows). The capability deliberately excludes overwrite-on-duplicate, sharing, import/export, a dedicated management page, version history, sort persistence, bulk rename, and inline / click-on-name rename.
8. **E2E coverage + flake stabilization + type alignment + maintainability** (PRs #104–#107, extended in PR #109; maintainability follow-up in PRs #111–#113, extended in PR #115) — Focused Playwright E2E coverage was added for the **Saved Searches / Filter Presets** workflow (`e2e/filter-presets.spec.ts`, PR #104 — save / reload / load, dirty-state dot, `Update "<name>"` clean-vs-dirty enable, rename, delete, `Saved searches · N` count label, empty state), the **Notes** workflow (`e2e/notes.spec.ts`, PR #106 — add → indicator → popover preview, edit, clear-removes-indicator, Has notes / No notes filter, search + `Matched in: Notes` attribution), and the **server-driven `Matched in:` search-attribution** UI (`e2e/search-attribution.spec.ts`, PR #109 — one test each for Title, Abstract, Authors, Journal, Notes, Keywords; UI-driven seeding via the Edit Paper dialog with a per-field unique alphanumeric token, capture-and-restore cleanup so no persistent test pollution remains). Cross-user RLS isolation for presets is intentionally not in E2E (single-account auth harness; empirical two-account verification is documented for PR #96). Two Playwright flakes observed after PR #104 — a brittle ancestor-selector in `mutations.spec.ts:215` and a toast-overlay race in the presets count-label test — were stabilized in PR #105 (one narrow accessibility-only product change adding `aria-label` + `type="button"` to the icon-only project/tag remove buttons in `EditPaperDialog.tsx`, plus role/name selectors and toast-detach waits in the specs); two consecutive full-suite runs of 60/60 confirmed the stabilization, the post-#106 suite stood at 65/65, and the post-#109 suite stands at **71/71**. PR #107 closed a small type drift: hand-written `Paper.raw_keywords` is now `string[] | null` in `src/types/database.ts` (matching the generated Supabase types), and call sites were audited — all writes already produced non-null arrays via `|| []`, the single property-access read site already used the same fallback, no new null guards were needed, and no behavior changed. PR #109 was testing-only — no search behavior, RPC, SQL, schema, migration, or product UI changed; `Matched in:` remains server-driven (computed from the six `matched_*` booleans returned by `search_papers` / `search_papers_short`). The follow-up maintainability wave (PRs #111–#113, extended in PR #115) shipped four small refactor / lint-cleanup changes with no product behavior change: PR #111 extracted an internal `PresetNameForm` component inside `FilterPresetsMenu.tsx` deduplicating the Save and Rename dialog inner form bodies (parent retains all dialog wrappers, state, refs, autofocus useEffects, submit handlers, validation, no-op rename guard, case-only rename allowance, duplicate-name handling, and `renameSubmitEnabled`; existing E2E selectors on `Save current search` / `Rename saved search` / `Preset saved` / `Preset renamed` untouched). PR #112 collapsed the 13 individual preset-related props on `SearchFilters` into a single `filterPresets: FilterPresetsMenuProps` prop (with `FilterPresetsMenuProps` now `export`-ed); `Dashboard.tsx` declares a typed named const just above the `return (` JSX and `SearchFilters` spreads it into `<FilterPresetsMenu {...filterPresets} />` (no `useMemo` wrapper — values flowing through are bit-identical, all inner values already memoized or primitive). PR #113 fixed the pre-existing `react-hooks/exhaustive-deps` warning at `Dashboard.tsx:574` by adding `queryClient` to the `handleBulkAnalyze` `useCallback` dep array (one-token diff; aligns with the sibling `handleAnalyzePaper` callback; `useQueryClient()` is referentially stable so zero behavior change). PR #115 collapsed the three named export callback props on `SearchFilters` (`onExportCSV` / `onExportRIS` / `onExportBibTeX`) into one `onExport: (format: ExportFormat) => void`, dropped the three Dashboard wrapper lambdas (`handleExportCSV` / `handleExportRIS` / `handleExportBibTeX`), and promoted the inline `"csv" | "ris" | "bibtex"` union in `useExportPapers.ts` to a module-level `export type ExportFormat` (single source of truth — `SearchFilters.tsx` and `Dashboard.tsx` both import it; no duplicate union declared in either consumer). Same hook call (`exportPapers(format)`), same downstream `src/lib/exportUtils.ts`, same Export button copy / icons / dropdown order / `disabled={exportDisabled}` gating. PR #115 ran `npx playwright test e2e/filter-presets.spec.ts` (6/6) as the focused gate; full Playwright was deliberately not re-run because the change is structural and the focused presets spec is the spec that mounts the dashboard with the export button visible. Vitest unchanged at 228/228 across this entire wave.
9. **AI-analysis safety net + hook extraction + PubMed import reliability** (PRs #117, #119, #120, #121) — Phase landed in three steps. **(a) Pure-helper safety net (PR #117):** three helpers (`isGenericStudyType`, `resolveStudyTypeAfterAnalysis`, `buildAnalysisUpdates`) + narrow `AnalysisUpdates = Pick<Paper, "tldr" | "study_type" | "statistical_methods">` type in `src/lib/studyTypeUtils.ts`, with 22 Vitest unit tests. `Dashboard.tsx` and `EditPaperDialog.tsx` consumed the shared `isGenericStudyType` (EditPaperDialog change was strict import-swap only); intentional `"Not specified"` asymmetry preserved (Dashboard passes through; EditPaperDialog filters). **(b) Hook extraction (PR #119):** `src/hooks/usePaperAnalysisActions.ts` now owns `analyzingPaperId`, `bulkAnalyzing`, `bulkAnalyzeProgress`, `handleAnalyzePaper`, `handleBulkAnalyze`. `Dashboard.tsx` consumes the 5 returned values and threads them unchanged into `<PaperList>` and `<BulkActionsToolbar>` props. The hardcoded 3s cooldown is now `await sleep(3000)` (default real, injectable for tests). 7 mocked-async Vitest tests (4 single + 3 bulk) cover the orchestration; one test locks in the rule that the bulk cooldown runs after success and caught failure but **NOT** after missing-abstract `continue` skips. PR #119 introduced the first repo `vi.mock("@/integrations/supabase/client")` pattern and the injected-`sleep` test pattern (no `vi.useFakeTimers()` for the cooldown). **(c) PubMed import / Edge Function reliability (PRs #120 + #121):** importing PMID `41912805` ("GBD 2023 IHD & Dietary Risk Factors Collaborators") was killing the `fetch-paper-metadata` Edge Function with `546 WORKER_LIMIT` / `CPU Time exceeded` — failure was **inside the Edge Function** and **not related to PR #119**. PR #120 hardened the function: bounded PubMed `<Author>...</Author>` parsing (no cross-author backtracking), PubMed retry budget reduced to 1 retry (Crossref unchanged), `MAX_PUBMED_XML_BYTES = 2 * 1024 * 1024` size guard, and a concise structured `pubmed-parse pmid=… bytes=… fetch_ms=… parse_ms=… t_authors=… t_abstract=… t_mesh=… t_subs=…` log per successful PMID. PR #121 added PubMed `<CollectiveName>` author support so consortium / collaborator papers no longer produce empty `authors` arrays. **Supabase Edge Function deploys are separate from frontend/Vercel deploys:** `supabase functions deploy fetch-paper-metadata --project-ref lioxtgiputfniqbktcsz`. PMID `41912805` is the established manual smoke case for the metadata import path. Vitest count now **257/257** (250 prior + 7 new from PR #119). Playwright unchanged at **71/71**. PR #119 ran the focused `e2e/filter-presets.spec.ts` (6/6) as a dashboard-mount smoke; PRs #120–#121 verified via manual reproduction post-deploy. No real Gemini / AI Playwright E2E exists or is planned (intentionally — Gemini-dependent, non-deterministic).

### Current search behavior

The main search box operates in one of four mutually-exclusive modes, selected by the shape of the query:

- **Empty** → no search filtering.
- **Unquoted, 1–2 characters** → short ILIKE search (`search_papers_short` RPC).
- **Unquoted, 3+ characters** → prefix-aware FTS (`search_papers` RPC).
- **Quoted** (`"..."` with non-empty inner string) → literal phrase match (no stemming, Unicode-safe, punctuation-preserving).

Every non-empty mode searches six fields: **title, abstract, authors, journal, notes, keywords**. Each matching row renders a **server-driven** "Matched in: …" sub-line showing which of those six fields matched (fixed order, no client-side re-tokenization). The `"..."` phrase syntax is taught via the search-input placeholder.

Deeper DB optimization is evidence-deferred until the library grows past ~2,000–5,000 papers. See [docs/decisions-and-triggers.md](docs/decisions-and-triggers.md) for the exact re-evaluation criteria.

## Commercialization (planning only)

Planning has started for a future commercial release of Paper Whisperer (single-user, Core + AI plans, monthly + annual, 7-day trial). **Nothing in this area is implemented in the current codebase** — there is no billing, no entitlements, no quotas, no paywall, and no mobile packaging. The planning docs below capture the intended architecture and open questions so future PRs can implement against an agreed model.

| Doc | Purpose |
|---|---|
| [docs/commercial-architecture.md](docs/commercial-architecture.md) | Entitlement / billing-neutral architecture (planning) |
| [docs/quotas-and-pricing.md](docs/quotas-and-pricing.md) | Provisional plan structure, quotas, and open pricing questions (planning) |
| [docs/store-launch-checklist.md](docs/store-launch-checklist.md) | App Store / Play Store readiness checklist (planning; policies must be re-verified before launch) |
| [docs/documentation-policy.md](docs/documentation-policy.md) | Active documentation update rule for every meaningful change |

Do not interpret these planning docs as evidence that any commercial functionality, store listing, or billing integration ships today. Final prices, quotas, and the chosen billing provider are owner-pending.

## Documentation

| Doc | Purpose |
|---|---|
| [docs/start-here.md](docs/start-here.md) | Fresh-chat handoff for new assistants |
| [docs/architecture-read-path.md](docs/architecture-read-path.md) | Current read-path architecture |
| [docs/migration-history.md](docs/migration-history.md) | What changed, when, and why |
| [docs/decisions-and-triggers.md](docs/decisions-and-triggers.md) | Architectural decisions and re-evaluation triggers |
| [docs/commercial-architecture.md](docs/commercial-architecture.md) | Commercial / entitlement architecture (planning) |
| [docs/quotas-and-pricing.md](docs/quotas-and-pricing.md) | Provisional plans, quotas, open pricing questions (planning) |
| [docs/store-launch-checklist.md](docs/store-launch-checklist.md) | App Store / Play Store launch checklist (planning) |
| [docs/documentation-policy.md](docs/documentation-policy.md) | Documentation update rule for all changes |

Per [docs/documentation-policy.md](docs/documentation-policy.md), every meaningful change must update documentation in the same PR, and every Claude Code report must end with a "Documentation updates" section.

## Local development

```sh
git clone <repo-url>
cd paper-whisperer-62
npm install
npm run dev
```

Requires Node.js 18+. Supabase project config is in `supabase/config.toml`.

## Supabase Edge Functions

Edge Functions live under `supabase/functions/<name>/index.ts` (`analyze-paper`, `fetch-paper-metadata`). **Edge Function deploys are separate from frontend / Vercel deploys** — a GitHub merge alone does not update the deployed function. After any change under `supabase/functions/<name>/`, deploy explicitly:

```sh
supabase functions deploy <name> --project-ref <project-ref>
```

Notable manual smoke case: PMID `41912805` ("GBD 2023 IHD & Dietary Risk Factors Collaborators") for `fetch-paper-metadata` (covers bounded `<Author>...</Author>` parsing + `<CollectiveName>` consortium author support after PRs #120 / #121).

## Testing

```sh
npx vitest run               # Unit tests (263 tests)
npx playwright test          # E2E tests (currently 71, single-worker)
npx playwright test --ui     # Interactive test runner
```

E2E auth credentials are in `.env.test`. The Playwright suite is single-worker and serial; it covers the read path, filters, paper import/order, bulk actions, attachments, mutations, **Saved Searches / Filter Presets** (`e2e/filter-presets.spec.ts`, PR #104), **Notes** (`e2e/notes.spec.ts`, PR #106), and the server-driven **`Matched in:` search-attribution UI for all six sources** — Title, Abstract, Authors, Journal, Notes, Keywords (`e2e/search-attribution.spec.ts`, PR #109). Flakes observed after the presets E2E PR were stabilized in PR #105.
