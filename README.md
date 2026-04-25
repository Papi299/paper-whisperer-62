# Paper Whisperer

Academic paper library manager with server-side filtering, sorting, pagination, keyword analysis, and AI-powered study classification.

## Tech stack

- **Frontend:** React + TypeScript + Vite + shadcn-ui + Tailwind CSS
- **Backend:** Supabase (Postgres, Auth, Edge Functions, PostgREST)
- **Region:** Supabase free tier, South Asia (Mumbai)

## Current status (April 2026)

The app is **stable, hardened, and feature-complete at current scale**. Eight major work phases are complete:

1. **Read-path performance track** (PRs #56–#65) — server-side filtering, sorting, pagination, lazy loading, abstract on-demand fetch. Handles ~400+ papers with sub-second dashboard loads.
2. **Security & schema integrity hardening** (PRs #67–#76) — edge function logging redaction, PubMed API key server-side migration, RLS restoration on all user-scoped tables, per-user uniqueness constraints, FK cascade fixes, and import UX improvements.
3. **Correctness & hygiene fixes** (PRs #78–#82) — normalization worker error-handling fix, ghost query field removal, client-side code deduplication, Gemini API key transport hardening, and further log sanitization.
4. **Paper notes feature wave** (PRs #84–#87) — `notes` column on `papers` with an Edit-dialog textarea, a list-cell sticky-note indicator with popover preview, a tri-state "Has Notes" filter, and inclusion of notes in full-text search (weight D) and the short-query ILIKE path.
5. **Prefix-aware FTS** (PR #88) — `search_papers` rewritten as prefix-aware FTS so partial inputs match while typing (`guideli` finds "guideline"). Uses a Unicode-preserving blacklist of tsquery operator characters; the existing `search_vector`, GIN index, and short-search RPC are unchanged. Migration applied on Supabase and manually verified.
6. **Search wave — keywords + attribution + phrase search** (PRs #91–#93, docs normalized in PR #94) — `keywords` added to `search_vector` at weight C; both search RPCs return six per-field `matched_*` booleans that drive a read-only "Matched in: …" sub-line on each matching row in fixed field order (PR #91). Double-quoted queries (`"muscle protein synthesis"`) route to a literal phrase-match ILIKE path with no stemming, Unicode-safe, punctuation-preserving; unquoted behavior is bit-identical (PR #92). Search input placeholder reads `Search titles, authors, notes, keywords... Use "..." for exact phrase` for discoverability (PR #93). Migration `20260420010000_keywords_in_search_with_attribution.sql` applied on Supabase and verified end-to-end.
7. **Saved Searches / Filter Presets — full capability** (PRs #96, #98, #99, #101, #102) — Users can save the current filter/search configuration under a name, list saved presets alphabetically, load one (full replacement of all 8 saved fields, with stale project/tag IDs nulled and a toast), update the currently-loaded preset in place, see at a glance when the loaded preset has unsaved changes, rename any preset, and delete with a confirmation. Persistence is **server-side per user** in a new `filter_presets` table with full RLS, `FORCE ROW LEVEL SECURITY`, a case-insensitive unique name per user, an `updated_at` trigger, and a Zod-validated JSONB `payload` with a `version: 1` sentinel. Raw search query strings are saved verbatim, so quoted phrase searches round-trip exactly. Sort state is intentionally **not** in the payload (view concern). The `Update "<name>"` action (PR #98) is id-targeted (never by name lookup), preserves the preset name, and overwrites only the payload. The dropdown label shows the total preset count (`Saved searches · N`) so users notice when more rows exist below the visible area (PR #99). When a preset is loaded, a small accent **dot on the Presets trigger** signals unsaved changes; the dirty signal is derived (no schema change) by comparing the current dashboard state against the loaded preset's stored payload (order-insensitive on `selectedKeywords`), and the `Update "<name>"` menu item is disabled when clean, enabled when dirty (PR #101). Presets can be renamed via a per-row pencil icon → small Rename dialog; rename is id-targeted, metadata-only (`payload`/`created_at`/`id` untouched), reuses the same name validation and the existing `23505` → "Name already taken" pattern, has a no-op short-circuit (unchanged trimmed name → no Supabase write, no `updated_at` bump, no toast), and supports intentional case-only rename. Rename does not affect the dirty-state dot. (PR #102.) Migration `20260421010000_add_filter_presets.sql` is applied to live Supabase and verified both structurally (post-deploy SQL spot-checks) **and empirically** (two separate accounts confirmed cross-user RLS isolation — each user sees only their own rows). The capability deliberately excludes overwrite-on-duplicate, sharing, import/export, a dedicated management page, version history, sort persistence, bulk rename, and inline / click-on-name rename.
8. **E2E coverage + flake stabilization + type alignment** (PRs #104–#107) — Focused Playwright E2E coverage was added for both the **Saved Searches / Filter Presets** workflow (`e2e/filter-presets.spec.ts`, PR #104 — save / reload / load, dirty-state dot, `Update "<name>"` clean-vs-dirty enable, rename, delete, `Saved searches · N` count label, empty state) and the **Notes** workflow (`e2e/notes.spec.ts`, PR #106 — add → indicator → popover preview, edit, clear-removes-indicator, Has notes / No notes filter, search + `Matched in: Notes` attribution). Cross-user RLS isolation for presets is intentionally not in E2E (single-account auth harness; empirical two-account verification is documented for PR #96). Two Playwright flakes observed after PR #104 — a brittle ancestor-selector in `mutations.spec.ts:215` and a toast-overlay race in the presets count-label test — were stabilized in PR #105 (one narrow accessibility-only product change adding `aria-label` + `type="button"` to the icon-only project/tag remove buttons in `EditPaperDialog.tsx`, plus role/name selectors and toast-detach waits in the specs); two consecutive full-suite runs of 60/60 confirmed the stabilization, and the post-#106 suite stands at 65/65. PR #107 closed a small type drift: hand-written `Paper.raw_keywords` is now `string[] | null` in `src/types/database.ts` (matching the generated Supabase types), and call sites were audited — all writes already produced non-null arrays via `|| []`, the single property-access read site already used the same fallback, no new null guards were needed, and no behavior changed.

### Current search behavior

The main search box operates in one of four mutually-exclusive modes, selected by the shape of the query:

- **Empty** → no search filtering.
- **Unquoted, 1–2 characters** → short ILIKE search (`search_papers_short` RPC).
- **Unquoted, 3+ characters** → prefix-aware FTS (`search_papers` RPC).
- **Quoted** (`"..."` with non-empty inner string) → literal phrase match (no stemming, Unicode-safe, punctuation-preserving).

Every non-empty mode searches six fields: **title, abstract, authors, journal, notes, keywords**. Each matching row renders a **server-driven** "Matched in: …" sub-line showing which of those six fields matched (fixed order, no client-side re-tokenization). The `"..."` phrase syntax is taught via the search-input placeholder.

Deeper DB optimization is evidence-deferred until the library grows past ~2,000–5,000 papers. See [docs/decisions-and-triggers.md](docs/decisions-and-triggers.md) for the exact re-evaluation criteria.

## Documentation

| Doc | Purpose |
|---|---|
| [docs/start-here.md](docs/start-here.md) | Fresh-chat handoff for new assistants |
| [docs/architecture-read-path.md](docs/architecture-read-path.md) | Current read-path architecture |
| [docs/migration-history.md](docs/migration-history.md) | What changed, when, and why |
| [docs/decisions-and-triggers.md](docs/decisions-and-triggers.md) | Architectural decisions and re-evaluation triggers |

## Local development

```sh
git clone <repo-url>
cd paper-whisperer-62
npm install
npm run dev
```

Requires Node.js 18+. Supabase project config is in `supabase/config.toml`.

## Testing

```sh
npx vitest run               # Unit tests (228 tests)
npx playwright test          # E2E tests (currently 65, single-worker)
npx playwright test --ui     # Interactive test runner
```

E2E auth credentials are in `.env.test`. The Playwright suite is single-worker and serial; it covers the read path, filters, paper import/order, bulk actions, attachments, mutations, **Saved Searches / Filter Presets** (`e2e/filter-presets.spec.ts`, PR #104), and **Notes** (`e2e/notes.spec.ts`, PR #106). Flakes observed after the presets E2E PR were stabilized in PR #105.
