# Start Here — Fresh Chat Handoff

## What this app is

Paper Whisperer is a single-user academic paper library manager. Users import papers (via PubMed/DOI/manual entry), organize them with tags/projects, filter by keywords/year/study-type, search full-text, and run AI-powered study-type classification. Backend is Supabase (Postgres + Edge Functions). Frontend is React + TypeScript.

## What was completed (PRs #56–#65)

The entire **read-path performance track** is done:

1. **Server-side short search** (#56) — ILIKE RPC for queries < 3 chars
2. **Full-screen spinner fix** (#57) — no flash during filter transitions
3. **Keyword enrichment** (#58) — `raw_keywords` source-of-truth + reevaluation
4. **Server-side keyword filter** (#59) — RPC with cross-column synonym normalization
5. **Lazy loading / infinite scroll** (#60) — replaced eager-load-all with PAGE_SIZE=100
6. **Lazy loading fixes** (#61) — server-side sidebar data, stable select-all, E2E tests
7. **Query timing + sort/filter split** (#62) — sort changes don't refetch keyword/count queries
8. **search_vector removal from list** (#63) — dropped ~44% payload size
9. **Short search bug fix** (#64) — correct jsonb handling in RPC
10. **Abstract on-demand loading** (#65) — `has_abstract` boolean column, lazy abstract fetch

## Edge function logging hardening (post-PR #65)

Both edge functions (`analyze-paper` and `fetch-paper-metadata`) had a logging hardening pass. All sensitive data (auth tokens, user IDs, paper titles/content, raw API responses, full error objects) was removed from logs. Only operational markers (flow steps, retry counts, HTTP status codes, generic success/failure) remain. No behavior changes. See [migration-history.md](migration-history.md) for details.

## PubMed API key migration (post-logging hardening)

PubMed API key storage moved from browser `localStorage` to the server-side `profiles` table. The edge function (`fetch-paper-metadata`) now reads the key directly from the DB after authenticating, so the client never sends the key in request bodies. Settings dialog updated for async operations with loading states. See [migration-history.md](migration-history.md) for details.

## Manual-add dialog UX fix (post-API key migration)

Fixed a bug where the Add Paper dialog would close even when manual paper creation failed (validation errors, duplicate detection, DB errors). The dialog now stays open with the user's data preserved on failure, so they can correct issues and retry. `addPaperManually` returns `boolean` (true = success, false = failure); the dialog only calls `resetAndClose()` on success.

## Bulk import assignment-failure visibility (post-dialog fix)

Project/tag assignment RPCs after bulk import (identifier-based and file-based) previously failed silently. Now, if `bulk_set_paper_projects` or `bulk_set_paper_tags` returns an error, the user sees a warning toast explaining which assignment(s) failed. Papers are never rolled back — the user knows papers were imported but may need manual project/tag assignment. See [migration-history.md](migration-history.md) for details.

## Cross-user uniqueness fix for pool/exclusion tables (post-assignment fix)

Fixed a database-layer bug where global `UNIQUE` constraints on `keyword_pool`, `study_type_pool`, `keyword_exclusion_pool`, and `study_type_exclusion_pool` prevented different users from adding the same keyword or study type to their own independent pools. Replaced with per-user unique indexes on `(user_id, lower(column))`. No frontend changes needed. See [migration-history.md](migration-history.md) for details.

## Schema drift audit fix — projects/tags uniqueness + RLS tightening (post-pool fix)

Comprehensive remote-DB audit found two more critical drift issues:
1. **Global UNIQUE on `projects.name` and `tags.name`** — same bug class as pools. Different users couldn't create projects/tags with the same name. Fixed with per-user indexes.
2. **"Allow all access" RLS policies on 9 tables** — projects, tags, keyword_pool, keyword_exclusion_pool, study_type_pool, study_type_exclusion_pool, synonym_pool, paper_projects, paper_tags all had wide-open RLS. Any authenticated user could read/write any other user's data. Fixed by dropping permissive policies and recreating correct per-user policies. SECURITY DEFINER RPCs are unaffected.

See [migration-history.md](migration-history.md) for details.

## FK cascade fixes (post-schema-drift fix)

Restored `ON DELETE CASCADE` on all user-scoped table FK constraints to `auth.users(id)`. The Supabase dashboard had overwritten these with `NO ACTION`.

- **Pool tables** (keyword_pool, keyword_exclusion_pool, study_type_pool, study_type_exclusion_pool, synonym_pool): Fixed in migration `20260412040000`.
- **papers, projects, tags**: Fixed in migration `20260412060000`.
- **paper_attachments, profiles**: Already had correct CASCADE — not touched.

See [migration-history.md](migration-history.md) for details.

## Title-import warning (post-FK fix)

Added a static warning to the Import IDs tab in the Add Papers dialog: "Title-based import may match the wrong paper. PMID/DOI import is more reliable." This is the chosen handling for the title-import reliability concern — no mandatory preview/confirmation flow. See "Standing product decisions" below.

## Post-hardening correctness and hygiene fixes (PRs #78–#82)

After the security/integrity hardening wave, a focused round of correctness and code-hygiene fixes was completed:

1. **Worker error-handling fix** (#78) — Fixed a bug in `useNormalizationWorker.ts` where the Web Worker `onerror` handler resolved pending promises with `[]` instead of rejecting. A worker crash during batch normalization (>10 papers) would silently produce papers with missing normalized fields. Now the worker rejects on error, and both bulk import flows (`bulkImportPapers`, `bulkImportFromParsedData`) catch the rejection and surface a clear error toast. 5 unit tests added.

2. **Ghost `urls` field removal** (#79) — Removed `urls` from the papers list SELECT string in `usePapers.ts` and matching docs. The field was not in any type definition, not in any migration, and not read or written by any code. Dead query baggage.

3. **Client-side `decodeHtml` deduplication** (#80) — Replaced the local browser-only `decodeHtml` helper in `AnalyticsPanel.tsx` (using `document.createElement("textarea")`) with the shared `decodeHTMLEntities` utility from `src/lib/decodeHTMLEntities.ts`.

4. **Gemini API key transport hardening** (#81) — Moved the Gemini API key in `analyze-paper` edge function from URL query parameter (`?key=`) to HTTP header (`x-goog-api-key`). The key no longer appears in URL strings, reducing exposure in server logs. Same endpoint, same request shape, same response handling.

5. **analyze-paper log sanitization** (#82) — Removed `abstract.length` and `rawText.length` from `analyze-paper` log output. These were the last two content-adjacent metadata values appearing in logs.

**Post-deploy verification (analyze-paper):**
PRs #81 and #82 were deployed to Supabase and verified:
- Gemini analysis still succeeds (status 200, valid JSON response)
- Deployed source confirmed via `supabase functions download` — both fixes present
- Logs now contain only safe high-level stage markers and HTTP status codes
- No bearer tokens, user IDs, paper titles, abstract content, raw Gemini text, or content-length metadata appears in logs

**Audited and confirmed correct (no action needed):**
- `user_id` nullability — all user-scoped tables already have `user_id NOT NULL` at the DB level
- FK `ON DELETE CASCADE` — all user-scoped tables now have correct CASCADE behavior
- `paper_attachments` UPDATE RLS policy — no UPDATE code path exists in the app; the missing policy has zero real-world impact

## Paper notes — full feature wave (PRs #84–#87)

The notes feature was built and shipped as a four-step capability. All four steps are merged and live in production:

1. **Notes column + edit surface (PR #84).** A `notes text` column on `papers` (nullable, no default) and a free-text "Notes" `<Textarea>` in the Edit Paper dialog, placed between TL;DR and Study Type. Notes load with the existing list query and persist via the existing `updatePaper` mutation — no new RPCs, indexes, or RLS changes.
2. **List indicator + popover preview (PR #85).** A sticky-note icon appears in the action cell only for papers with non-whitespace notes. Clicking it opens a popover with the notes text. No extra fetch — uses the notes already loaded with the list.
3. **"Has Notes" filter (PR #86).** Tri-state `all | has | none` dropdown in the filter bar, implemented as a PostgREST predicate in `buildPapersQuery.ts` using POSIX regex (`[^[:space:]]` / `^[[:space:]]*$`) so NULL and whitespace-only notes both count as "no notes" — matches the list-indicator semantics exactly.
4. **Notes included in text search (PR #87).** Migration `20260417020000_add_notes_to_search.sql` regenerates `papers.search_vector` with `notes` at weight D and adds `OR p.notes ILIKE …` to `search_papers_short`. Zero frontend code changes; the existing search bar covers notes automatically. Ranking hierarchy: A = title, B = abstract, C = journal + authors, D = notes.

The migrations for both PR #86 (the regex predicate is client-side) and PR #87 (the `search_vector` rebuild + short-search RPC) have been applied to live Supabase and behavior verified end-to-end (edit → save → indicator → popover → filter → search-by-notes).

Out of scope for the notes feature and not planned: markdown rendering, export inclusion, AI processing of notes, version history, sharing, bulk edit, and any non-dialog editing surface.

## Search behavior — prefix-aware FTS (PR #88, applied + verified)

Migration `20260417030000_prefix_search.sql` replaces the body of the `search_papers` RPC so partial inputs match while typing. The RPC no longer calls `websearch_to_tsquery` — instead it splits the user's input on whitespace, strips only the ten tsquery operator/control characters (`& | ! ( ) : * < > ' " \`), appends `:*` to each non-empty token, `&`-joins, and feeds the result to `to_tsquery('english', …)`. `guideli` now matches `guideline` (lexeme `guidelin` starts with `guideli`), and result counts narrow monotonically as the user types. Unicode letters (Latin diacritics, Cyrillic, Hebrew, Arabic, CJK, etc.) are preserved — Postgres regex character classes match per codepoint, so the blacklist never accidentally strips multibyte characters. The existing `search_vector` column, `idx_papers_search_vector` GIN index, `search_papers_short` ILIKE path, and length-1-2 routing are all unchanged.

**Status:** The migration has been applied to live Supabase, and manual verification has been completed. Partial inputs ("Ast" → "Asth" → "Asthma") now match the corresponding paper at every step, monotonic narrowing is observed across multi-syllable terms, and the short-query (1–2 char) ILIKE path is unaffected.

**Dropped from the FTS path (PR #88):** `websearch_to_tsquery` sugar — explicit `OR`, and `-` exclusion. Quoted phrases were also dropped from this path, but were subsequently re-introduced via a separate ILIKE-based implementation in PR #92 (see next section). Explicit `OR` and `-` exclusion remain unsupported and are not planned.

## Search wave — keywords, server-side attribution, quoted phrases (PRs #91–#93, applied + verified)

Three back-to-back PRs extended search end-to-end. All are merged and live.

1. **Keywords in search + server-side match attribution (PR #91).** Migration `20260420010000_keywords_in_search_with_attribution.sql` rebuilds `papers.search_vector` to include `keywords::text` at weight C (alongside `authors::text` and `journal`; title stays A, abstract B, notes D) and recreates `idx_papers_search_vector` on the rebuilt column. Both search RPCs (`search_papers` FTS, `search_papers_short` ILIKE) were recreated to return six per-field attribution booleans — `matched_title`, `matched_abstract`, `matched_authors`, `matched_journal`, `matched_notes`, `matched_keywords` — computed server-side against each field's own `to_tsvector`/ILIKE test. Client side, `useFilterState.ts` now threads a `Map<paper_id, MatchFlags>` through to `PaperList`, which renders a read-only "Matched in: …" sub-line of outline `<Badge>`s on each matching row in fixed field order (Title → Abstract → Authors → Journal → Notes → Keywords). Attribution is authoritative — the client does not re-tokenize the query. The sub-line hides entirely when search is empty or only non-search filters are active.

2. **Quoted phrase search (PR #92).** Wrapping a query in double quotes (`"muscle protein synthesis"`) now performs a literal phrase match against title, abstract, authors (jsonb), journal, notes, and keywords (jsonb) — no stemming, no tokenization, Unicode-safe, punctuation-preserving (`"COX-2"` works). Implementation reuses `search_papers_short`'s per-field ILIKE + `EXISTS (SELECT 1 FROM jsonb_array_elements_text(...) WHERE elem ILIKE …)` structure with the phrase wrapped in `%…%`, so zero new SQL was needed and the same six `matched_*` columns flow through. `useFilterState.ts` detects the `"…"` wrapper and routes to a third mode (phrase) that takes priority over the FTS (≥3 chars) and short-query (1–2 chars) modes via mutually-exclusive `!usePhraseSearch` guards — unquoted behavior is bit-identical to PR #88/#91. A single quote character, an unterminated quote, or `""` all fall back to the regular FTS/short path.

3. **Placeholder-based discoverability (PR #93).** The search input placeholder reads `Search titles, authors, notes, keywords... Use "..." for exact phrase`. Net diff vs main is a single-line placeholder change in `SearchFilters.tsx`; no helper line, tooltip, popover, or docs link surface was added. This was the user's chosen direction after an initial helper-line prototype was rejected as scope creep.

**Status:** Migration `20260420010000_keywords_in_search_with_attribution.sql` has been applied to live Supabase and verified end-to-end. Manual verification covered keyword-only matches, phrase-only matches on multi-word phrases present as contiguous substrings, attribution chips rendering in fixed order on the row, and clean behavior when search is cleared.

## Current search behavior — at a glance

This is the authoritative summary of how the main search box behaves today. Treat it as the source of truth — do not re-derive it from the prose above.

**Search modes (mutually exclusive, selected by query shape):**

| Query shape | Mode | Backend |
|---|---|---|
| Empty | No search filtering | — |
| Unquoted, 1–2 characters | Short ILIKE search | `search_papers_short` RPC |
| Unquoted, 3+ characters | Prefix-aware FTS | `search_papers` RPC |
| Quoted (`"..."`) with non-empty inner string | Exact phrase (literal ILIKE, no stemming) | `search_papers_short` RPC with wrapped `%phrase%` |

An unterminated quote, a lone `"`, or `""` all fall back to the regular unquoted path for the inner length.

**Searchable fields (all six are covered by every non-empty mode):**

- title
- abstract
- authors
- journal
- notes
- keywords

**"Matched in:" sub-line:**

- **Server-driven**, not client-inferred. The per-row chips come from six boolean columns (`matched_title`, `matched_abstract`, `matched_authors`, `matched_journal`, `matched_notes`, `matched_keywords`) returned by the search RPCs. The client does not re-tokenize the query.
- Chip order is fixed: **Title → Abstract → Authors → Journal → Notes → Keywords**.
- Hidden when search is empty or only non-search filters are active.

**Discoverability:**

- The `"..."` phrase syntax is taught via the search input **placeholder**, not a helper line, tooltip, or docs link. The placeholder reads `Search titles, authors, notes, keywords... Use "..." for exact phrase`. Do not re-propose a separate helper line.

**Unsupported (not planned):** explicit `OR`, `-` exclusion, and any other `websearch_to_tsquery` sugar beyond quoted phrases.

## Docs normalization for the search wave (PR #94)

The handoff documentation was normalized to reflect PRs #91–#93 in PR #94 (merged). That work updated `docs/start-here.md`, `README.md`, and `docs/migration-history.md` — no code, schema, or behavior change. Future docs passes should only correct anything that remains stale; do not re-audit the same ground.

## Saved Searches / Filter Presets — MVP (PRs #96, #98, #99 — applied + verified)

Users can snapshot the current filter/search configuration under a name, list saved presets, load one with a click, update the currently-loaded one in place, and delete. **Treat this section as the authoritative description of the presets capability — do not re-derive scope from the prose around it.** Initial MVP shipped as PR #96; PR #98 added update-existing-loaded-preset; PR #99 added a count indicator in the dropdown label.

**Persistence model.** Presets are **server-side, per user**. They are NOT in `localStorage`. The backing table is `public.filter_presets` (one JSONB `payload` column plus `id`/`user_id`/`name`/timestamps), with full RLS (`auth.uid() = user_id` for SELECT/INSERT/UPDATE/DELETE), `FORCE ROW LEVEL SECURITY`, a case-insensitive unique index `idx_filter_presets_user_name` on `(user_id, lower(name))`, and the standard `update_updated_at_column()` trigger. Migration: `supabase/migrations/20260421010000_add_filter_presets.sql`.

**Migration deployment status.** The migration has been applied to live Supabase. Post-deploy SQL spot-checks confirmed: 6 columns all `NOT NULL` with correct types (`uuid`, `text`, `jsonb`, `timestamptz`); both `relrowsecurity` and `relforcerowsecurity` are `true`; four policies exist (one each for SELECT/INSERT/UPDATE/DELETE); the case-insensitive unique index on `(user_id, lower(name))` is present alongside the user-id lookup index. **Cross-user RLS isolation has been empirically verified**: the user signed in as two separate accounts (one real, one test) and confirmed each account cannot see the other's rows in `filter_presets`. The earlier "not-yet-empirically-verified" caveat is no longer applicable.

**MVP actions.** The Presets dropdown in the filters row supports exactly five user-visible actions:

- **Save** the current filter state under a user-supplied name (Dialog with a single Input; trim non-empty; ≤ 80 chars; duplicate name surfaces a toast and does NOT overwrite).
- **List** saved presets alphabetically (case-insensitive) inside the dropdown; empty state reads "No saved searches yet". The dropdown label reads `Saved searches · N` where N is the total preset count, so users see at a glance when more rows exist below the visible area (PR #99).
- **Load** a preset by clicking its row. After a successful load (and after a successful Save), that preset becomes the **currently loaded preset**.
- **Update the currently loaded preset** (PR #98) — when a preset is loaded, the dropdown shows an extra `Update "<name>"` item directly under *Save current search…*. It opens an AlertDialog ("<name> will be overwritten with the current filters and search. The preset name stays the same. This cannot be undone.") and on confirm overwrites the preset's stored `payload` with the current dashboard state. The update is targeted by `id`, not by name lookup — rename or duplicate-name scenarios cannot silently overwrite the wrong row. The preset name is preserved; the row's `updated_at` is refreshed by the existing trigger; the JSONB schema is unchanged (still `version: 1`, same 8 fields). The `Update` item is hidden when no preset is loaded. The loaded-preset pointer is cleared on Clear Filters and on deleting the loaded preset.
- **Delete** a preset via a trailing trash icon → AlertDialog confirmation.

**Saved payload — exactly these 8 fields plus a `version: 1` sentinel.** The Zod schema in `src/hooks/useFilterPresets.ts` is the source of truth. Do not assume any other field is in the payload.

| Field | Type | Notes |
|---|---|---|
| `searchQuery` | `string` | Saved **raw, verbatim** — surrounding double-quotes are preserved so quoted phrase searches like `"muscle protein synthesis"` round-trip exactly and re-trigger the phrase-search route on load |
| `yearFrom` | `string` | Raw text-input value; may be `""` |
| `yearTo` | `string` | Raw text-input value; may be `""` |
| `studyType` | `string` | `"all"` for the no-filter case |
| `notesPresence` | `"all" \| "has" \| "none"` | |
| `selectedKeywords` | `string[]` | Order preserved |
| `selectedProjectId` | `string \| null` | UUID or null |
| `selectedTagId` | `string \| null` | UUID or null |

**Load semantics — full replacement, not merge.** Loading a preset deterministically overwrites all 8 fields via direct setter calls. There is no partial merge, no "keep current keywords and add saved ones", and no diff. The preset name uniquely determines the resulting filter state.

**Sort state is NOT saved.** Sort order is a view concern, not filter intent. Loading a preset leaves the active sort key/direction untouched. Do not propose adding sort to the payload.

**Stale-ID guard.** If a saved `selectedProjectId` or `selectedTagId` no longer exists in the user's current `projects`/`tags` lists (e.g. they deleted the project after saving the preset), the field is silently set to `null` on load and a gentle toast surfaces ("The project/tag saved in this preset no longer exists — skipped"). The preset still loads — the missing reference is dropped, not an error.

**Invalid-payload guard.** `parsePresetPayload` runs `safeParse` on every row read from the DB. Rows that fail validation (future schema version, missing fields, corrupted write) are dropped from the menu with a `console.warn` so the rest of the menu keeps rendering.

**Explicit MVP exclusions — do not re-propose as if they exist.** The MVP deliberately omits all of the following. Each was discussed and excluded for scope reasons; do not assume any of them are present.

- Rename a preset (delete + re-save is the equivalent path). The PR #98 update-loaded action is **not** a rename — it preserves the name and only overwrites the payload.
- Overwrite-on-duplicate-name (duplicate save shows a toast and is rejected). The PR #98 update-loaded action is **not** an overwrite-by-name — it targets the currently loaded preset by `id`, never by name lookup.
- Sharing / public presets / collaboration.
- Import / export of presets.
- Version history / audit trail for preset edits.
- A dedicated preset management page or sidebar surface.
- Sort-state persistence in the payload.
- Auto-run / scheduled presets / saved-search alerts / smart folders / search-within-the-preset-list / drag-reorder / preset folders or tags.
- Any change to the existing search routing, `Matched in:` attribution, or `onClearFilters` behavior (beyond the fact that Clear Filters now also clears the "currently loaded preset" pointer so the `Update "<name>"` action disappears).

## Standing product decisions — do not re-propose

These decisions have been explicitly made by the user. Do not suggest revisiting them unless the user explicitly asks.

### Duplicate detection policy
- Duplicate detection is **PMID/DOI only**. This is intentional.
- Do NOT propose fuzzy or title-based duplicate detection.
- Do NOT propose extending `get_duplicate_papers` to match by title.
- The user has explicitly rejected this direction.

### Title-based import handling
- Title-based import auto-selects the first PubMed/Crossref match. This is known and accepted.
- The chosen mitigation is a **static warning in the Add Papers dialog**: "Title-based import may match the wrong paper. PMID/DOI import is more reliable." (PR #76)
- Do NOT propose mandatory per-paper preview/confirmation for title-based imports.
- Do NOT propose a review/approval workflow before title-imported papers are saved.
- The user has explicitly rejected these approaches.

### CORS policy for edge functions
- Both edge functions (`analyze-paper`, `fetch-paper-metadata`) use `Access-Control-Allow-Origin: "*"`. This is **intentional and correct** for the current auth model.
- Auth is **Bearer-token/header-based** (Supabase JWT via `Authorization` header), NOT cookie-based. Browsers never auto-attach `localStorage` tokens cross-origin, so CORS provides no meaningful protection here.
- Tightening CORS would add complexity (Vercel preview URL regex, origin reflection logic) for zero practical security gain.
- Do NOT propose CORS restriction for the current auth architecture.
- Revisit only if the auth model changes to cookie-based sessions.

## What is stable — do not reopen casually

- The read-path architecture (server-side filter/sort/paginate/lazy-load)
- The keyword filter RPC and keyword options RPC
- The abstract on-demand loading pattern
- The sort/filter cache key split
- The select-all-filtered-IDs mechanism
- The security/schema integrity layer (RLS, per-user uniqueness, FK cascades)

These were thoroughly measured and verified. Changing them requires new evidence.

## What is intentionally deferred

- **Phase C DB optimization** (GIN indexes on jsonb keyword columns, RPC rewrites). Not justified at current scale (~400 papers). See [decisions-and-triggers.md](decisions-and-triggers.md).
- **Unused index cleanup** (`idx_papers_user_doi_unique` has 0 scans but is harmless).
- **Write-path optimization** (not profiled, not a user complaint).

## What to read next

1. [architecture-read-path.md](architecture-read-path.md) — how the read path works now
2. [decisions-and-triggers.md](decisions-and-triggers.md) — what was deferred and when to revisit
3. [migration-history.md](migration-history.md) — chronological change history

## Current recommendation

The app is performant, secure, and feature-complete at current scale. The security/integrity hardening wave (PRs #67–#76), the follow-up correctness/hygiene fixes (PRs #78–#82), the notes feature wave (PRs #84–#87), the prefix-aware FTS upgrade (PR #88), the search wave (keywords in search + server-side attribution + quoted phrase search + placeholder discoverability, PRs #91–#93), the docs normalization for that wave (PR #94), and the Saved Searches / Filter Presets MVP plus its follow-ups (PRs #96, #98, #99) are all complete and live. Migrations `20260417030000_prefix_search.sql`, `20260420010000_keywords_in_search_with_attribution.sql`, and `20260421010000_add_filter_presets.sql` are applied on Supabase and verified — the presets migration via post-deploy SQL spot-checks **and empirical cross-user RLS isolation** (two separate accounts, each sees only their own rows in `filter_presets`). Network RTT to Supabase Mumbai (~200ms from Israel) continues to dominate wall time, not DB execution. Focus new work on **features**, not performance, schema cleanup, or further hardening, unless the paper count grows past ~2,000 or users report slowness.

## Key files

| File | Role |
|---|---|
| `src/hooks/usePapers.ts` | Core papers infinite query + server filter/sort |
| `src/hooks/useFilterState.ts` | Filter/search state + three-mode search routing (phrase / FTS / short) + `searchMatchFlags` map |
| `src/hooks/useAbstract.ts` | On-demand abstract fetch + batch fetch |
| `src/hooks/papers/useBulkSelection.ts` | Select-all via `allFilteredIds` |
| `src/hooks/papers/types.ts` | `MatchFlags`, `NotesPresence`, server filter/sort param types |
| `src/lib/buildPapersQuery.ts` | PostgREST query builder with filter predicates |
| `src/lib/queryKeys.ts` | React Query key structure |
| `src/pages/Dashboard.tsx` | Main page — orchestrates all hooks |
| `src/components/papers/PaperList.tsx` | Virtualized table with lazy abstract expand + "Matched in: …" sub-line |
| `src/components/papers/SearchFilters.tsx` | Search input (with quoted-phrase placeholder hint), filter controls, mounts the Presets dropdown |
| `src/hooks/useFilterPresets.ts` | Saved Searches: Zod payload schema, list query + create/update/delete mutations, pure `applyPreset` with stale project/tag-ID guard (PRs #96, #98) |
| `src/components/papers/FilterPresetsMenu.tsx` | Presets DropdownMenu — Save Dialog, list with `Saved searches · N` count label, Update "<name>" AlertDialog (gated on a loaded preset), Delete AlertDialog (PRs #96, #98, #99) |
| `supabase/migrations/20260417030000_prefix_search.sql` | Prefix-aware FTS (PR #88) |
| `supabase/migrations/20260420010000_keywords_in_search_with_attribution.sql` | Keywords in search_vector + 6 `matched_*` attribution flags (PR #91) |
| `supabase/migrations/20260421010000_add_filter_presets.sql` | `filter_presets` table + RLS + per-user case-insensitive unique name + `updated_at` trigger (PR #96) |
| `supabase/migrations/` | All DB schema + RPC definitions |
