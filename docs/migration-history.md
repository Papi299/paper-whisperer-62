# Migration History

Chronological record of the read-path performance track (March–April 2026).

## PR #56 — Server-side short search

**Commit:** `38ed394`, `cf5c941`
**What:** Created `search_papers_short` RPC using ILIKE for queries under 3 characters. Previously these were client-side filtered after fetching all papers.
**Why:** Short queries couldn't use the `search_vector` GIN index (tsquery needs meaningful tokens). ILIKE on the server avoids sending the full dataset to the client.
**Migration:** `20260401010000_add_search_papers_short.sql`

## PR #57 — Full-screen spinner fix

**Commit:** `896398c`
**What:** Prevented full-screen loading spinner flash during search/filter transitions.
**Why:** When switching filters, React Query's loading state briefly flashed a full-screen spinner before showing cached data. Fixed with `placeholderData: (prev) => prev`.

## PR #58 — Keyword enrichment and reevaluation

**Commit:** `38ff6b8`
**What:** Added `raw_keywords` column as source-of-truth for original PubMed keywords. Added bulk reevaluation mechanism for study types.
**Why:** The AI analysis was overwriting PubMed-sourced keywords. `raw_keywords` preserves the original data while allowing enrichment.
**Migration:** `20260401020000_add_raw_keywords_column.sql`

## PR #59 — Server-side keyword filter

**Commit:** `1d9d75a`
**What:** Created `filter_papers_by_keywords` RPC. Searches across `keywords`, `mesh_terms`, and `substances` jsonb columns with case-insensitive matching and AND semantics.
**Why:** Client-side keyword filtering required all papers loaded in memory. Server-side filtering returns only matching IDs.
**Migration:** `20260403010000_add_filter_keywords_rpc.sql`

## PR #60 — Lazy loading / infinite scroll

**Commit:** `9d5c1ad`
**What:** Replaced eager-load-all with `useInfiniteQuery` (PAGE_SIZE=100) and `IntersectionObserver` sentinel. Added `get_keyword_options` RPC.
**Why:** The app was fetching ALL papers into memory on dashboard load. At 400 papers with abstracts, this was ~1.2MB per load. Pagination reduced initial payload to ~100 papers.
**Migrations:** `20260405010000_add_keyword_options_rpc.sql`

## PR #61 — Lazy loading fixes

**Commit:** `4400779`
**What:** Fixed sidebar counts (tags, projects) to use server data instead of client-side counting. Stabilized select-all to use `allFilteredIds` query. Added E2E tests for the new architecture.
**Why:** After removing eager-load-all, sidebar counts and select-all broke because they depended on having all papers in memory.

## PR #62 — Query timing + sort/filter split

**Commit:** `9d63165`
**What:** Split React Query cache keys so sort changes only invalidate the papers list (not keyword options, count, or IDs). Added timing instrumentation.
**Why:** Changing sort column was triggering 7 queries (including keyword options and count). After the split, sort changes trigger only 3 queries (list + paper_tags + paper_projects).

## PR #63 — search_vector removal from list

**Commit:** `0edd21e`
**What:** Excluded `search_vector` tsvector column from the papers list SELECT.
**Why:** `search_vector` is ~1–3KB per row and never used client-side. Removing it cut list payload by ~44% and reduced median load time from ~350ms to ~270ms (DB execution).

## PR #64 — Short search bug fix

**Commit:** `5ae2236`
**What:** Recreated `search_papers_short` RPC with correct jsonb handling.
**Why:** The original RPC had a type mismatch when comparing jsonb array elements.
**Migration:** `20260405020000_recreate_search_papers_short.sql`

## PR #65 — Abstract on-demand loading

**Commit:** `8d08513`
**What:** Added `has_abstract` generated column. Removed `abstract` from list SELECT. Created `useAbstract` hook with `staleTime: Infinity` and batch fetching. Updated all abstract consumers (PaperList expand, EditPaperDialog, analyze, bulk analyze).
**Why:** Abstracts are ~500 bytes each. At 400 papers, they add ~200KB to the list payload but are only needed when a user expands a row or runs analysis. On-demand loading eliminated this from the initial load.
**Migration:** `20260406020000_add_has_abstract_column.sql`

## Edge function logging hardening (no PR — security hardening only)

**Date:** April 2026
**What:** Redacted or removed all sensitive data from `console.log`/`console.warn`/`console.error` statements in both Supabase edge functions (`analyze-paper/index.ts` and `fetch-paper-metadata/index.ts`).
**Why:** Audit found that logs were leaking auth token fragments, user IDs, paper titles/identifiers, raw Gemini API responses containing paper analysis content, and full error objects with stack traces. All of this was visible in Supabase dashboard logs.
**Files changed:**
- `supabase/functions/analyze-paper/index.ts` — 14 log statements redacted/cleaned
- `supabase/functions/fetch-paper-metadata/index.ts` — 8 log statements redacted/cleaned
**What was removed/redacted:**
- Auth header substring (was logging first 20 chars of JWT)
- User IDs (was logging `user.id`)
- Paper titles, identifiers, and abstract content
- Gemini API key length
- Raw Gemini response text (on success and error paths)
- Full Gemini error response bodies
- Full error objects (replaced with `err.message` extraction)
- DOI values in fallback log messages
**What was preserved:**
- All flow step markers (numbered 1–7 in analyze-paper)
- Retry attempt counts and HTTP status codes
- Generic auth success/failure indicators
- Abstract length (non-identifying metadata)
- Gemini response text length (non-identifying)
- Identifier type and progress counter (e.g., "3/10 (type: doi)")
**Behavior change:** None. Auth flow, retry logic, request/response payloads, error responses to clients, and all business logic are unchanged. Only log verbosity was reduced. One minor detail: in `analyze-paper`, the Gemini error-path previously consumed the response body via `await geminiRes.text()` and appended it to the thrown Error message; now neither happens. The client-facing response is unchanged (hardcoded `"Analysis failed. Please try again later."`).
**Verification:** Build passes, all 147 unit tests pass. No existing Playwright tests exercise the edge functions directly (existing E2E tests cover only dialog UI mechanics). Verification that sensitive data no longer appears in logs was done by code inspection only — runtime log output was not directly inspected (would require deploying functions or running `supabase functions serve`).
**No migration file:** This change does not affect the database.

## PubMed API key migration to server-side storage

**Date:** April 2026
**What:** Moved PubMed API key storage from browser `localStorage` to the `profiles` table in Supabase. The edge function now reads the key server-side after authenticating the request, eliminating client-side key handling entirely.
**Why:** Storing API keys in `localStorage` is a security concern — the key was visible in browser dev tools, persisted across sessions without auth, and was sent in the request body to the edge function. Server-side storage keeps the key within the authenticated backend.
**Migration:** `20260411010000_add_pubmed_api_key_to_profiles.sql`
- Adds `pubmed_api_key TEXT DEFAULT NULL` column to `profiles`
- Also recreates the `profiles` table idempotently (it was missing from the remote DB despite its creation migration being marked as applied)
- Recreates RLS policies, triggers, and the `handle_new_user` function
**Files changed:**
- `supabase/migrations/20260411010000_add_pubmed_api_key_to_profiles.sql` — new migration
- `supabase/functions/fetch-paper-metadata/index.ts` — reads API key from `profiles` table after auth instead of from request body
- `src/integrations/supabase/types.ts` — added `pubmed_api_key` to profiles type
- `src/hooks/useSettings.ts` — complete rewrite: localStorage → Supabase `profiles` table via PostgREST
- `src/components/settings/SettingsDialog.tsx` — updated for async save/remove with loading states
- `src/lib/fetchPaperMetadataEdge.ts` — removed API key from request body; edge function reads it server-side
**Behavior change:** The API key is no longer stored in or read from `localStorage`. Existing keys in `localStorage` are orphaned (harmless). Users must re-enter their API key in the Settings dialog after this migration. The Settings dialog now shows a loading spinner while fetching the key from the server.
**Verification:** Build passes, all 147 unit tests pass. Edge function deployed. Migration applied to remote DB.

## Manual-add dialog UX fix

**Date:** April 2026
**What:** Fixed bug where Add Paper dialog closed on manual-add failure, losing user input.
**Root cause:** `addPaperManually` returned `void` (never threw); `handleManualSubmit` unconditionally called `resetAndClose()`.
**Fix:** `addPaperManually` now returns `Promise<boolean>` — `false` on all failure paths (no userId, invalid year, invalid PMID, duplicate, DB error), `true` on success. Dialog's `handleManualSubmit` only calls `resetAndClose()` when result is `true`.
**Files changed:**
- `src/hooks/papers/usePaperMutations.ts` — `addPaperManually` returns `boolean`
- `src/components/papers/AddPaperDialog.tsx` — `onSubmitManual` prop type updated, conditional close
- `src/hooks/papers/__tests__/usePaperMutations.test.ts` — 7 tests covering all return-value paths
**No migration needed.** No DB changes.

## Bulk import assignment-failure visibility

**Date:** April 2026
**What:** Made project/tag assignment failures after bulk import visible to the user.
**Root cause:** Both `bulkImportPapers` and `bulkImportFromParsedData` called `bulk_set_paper_projects` and `bulk_set_paper_tags` RPCs without checking the error return. If assignment failed, papers were imported successfully but ended up without the requested project/tag assignments — with no user-visible feedback.
**Fix:** Both functions now capture the `error` return from assignment RPCs. On failure, a warning toast is shown with `variant: "destructive"` that says which assignment(s) failed, while preserving the accurate paper import counts. Successfully inserted papers are never rolled back.
**Files changed:**
- `src/hooks/papers/useBulkMutations.ts` — error handling for `bulk_set_paper_projects` / `bulk_set_paper_tags` in both `bulkImportPapers` and `bulkImportFromParsedData`
- `src/hooks/papers/__tests__/useBulkMutations-assignment.test.ts` — 8 tests covering assignment success, project-only failure, tag-only failure, both-failure, and cache invalidation behavior
**No migration needed.** No DB changes. No rollback of inserted papers.

## Fix cross-user uniqueness bug in pool/exclusion tables

**Date:** April 2026
**What:** Fixed a bug where two different users could not add the same keyword or study type to their own independent pools.
**Root cause:** All four pool tables had global `UNIQUE` constraints (`*_term_key`) that enforced uniqueness on `keyword` or `study_type` across ALL users, not per-user. These constraints were likely created by the Supabase dashboard and overrode the per-user `UNIQUE(user_id, keyword)` constraints defined in the original migrations.
**Affected tables:**
- `keyword_pool` — had `UNIQUE(keyword)` via `keyword_pool_term_key`
- `keyword_exclusion_pool` — had `UNIQUE(keyword)` via `keyword_exclusion_pool_term_key`
- `study_type_pool` — had `UNIQUE(study_type)` via `study_type_pool_term_key`
- `study_type_exclusion_pool` — had `UNIQUE(study_type)` via `study_type_exclusion_pool_term_key`
**Fix:** Dropped all four global `*_term_key` constraints and created per-user unique indexes using `lower()` for case-insensitive dedup:
- `idx_keyword_pool_user_keyword` on `(user_id, lower(keyword))`
- `idx_keyword_exclusion_pool_user_keyword` on `(user_id, lower(keyword))`
- `idx_study_type_pool_user_study_type` on `(user_id, lower(study_type))`
- `idx_study_type_exclusion_pool_user_study_type` on `(user_id, lower(study_type))`
**Migration:** `20260412010000_fix_pool_global_unique_constraints.sql`
**Files changed:** Migration only. No frontend code changes needed — hooks already query per-user and handle `23505` errors correctly.
**Verification:** Migration applied to remote DB. Constraints verified via direct SQL query — all global `*_term_key` constraints removed, all per-user indexes created.
**Precedent:** Same bug class as the earlier `papers_pmid_key` / `papers_doi_key` fix (migration `20260327000000`).

## Fix global uniqueness on projects/tags + restore RLS on 9 tables

**Date:** April 2026
**What:** Two critical schema-drift fixes found during a comprehensive remote-DB audit.

**Fix A — Global uniqueness on `projects.name` and `tags.name`:**
Same bug class as the pool/exclusion and papers fixes. Global `UNIQUE(name)` constraints (`projects_name_key`, `tags_name_key`) prevented different users from creating projects or tags with the same name.
- Dropped `projects_name_key` and `tags_name_key`
- Created `idx_projects_user_name` on `(user_id, lower(name))` and `idx_tags_user_name` on `(user_id, lower(name))`
**Migration:** `20260412020000_fix_projects_tags_global_unique.sql`

**Fix B — Overly permissive RLS ("Allow all access") on 9 tables:**
These tables had dashboard-created "Allow all access" policies (qual=true, with_check=true) that let any authenticated user read/write any other user's data: `projects`, `tags`, `keyword_pool`, `keyword_exclusion_pool`, `study_type_pool`, `study_type_exclusion_pool`, `synonym_pool`, `paper_projects`, `paper_tags`.
- Dropped "Allow all access" policy on each table
- Recreated correct per-user policies from canonical migration definitions
- Enabled + forced RLS on all 9 tables
- `SECURITY DEFINER` RPCs (set_paper_tags, bulk_set_paper_projects, safe_bulk_insert_papers, etc.) are unaffected — they bypass RLS by design
**Migration:** `20260412030000_fix_rls_all_tables.sql`

**Files changed:** Two migration files only. No frontend code changes.
**Verification:** Both migrations applied to remote DB. Post-migration SQL queries confirmed:
- No global unique constraints on projects/tags
- Per-user unique indexes exist
- No "Allow all access" policies remain on any table
- All 9 tables have correct named per-user policies (31 total)
- All 9 tables have `relrowsecurity=true` and `relforcerowsecurity=true`

**Audited and confirmed correct:**
- `user_id` nullability — all tables already have `NOT NULL` at the DB level
- `paper_attachments` UPDATE RLS policy — no UPDATE code path exists in the app; non-issue

## Fix pool tables FK — add ON DELETE CASCADE

**Date:** April 2026
**What:** The 5 pool tables (`keyword_pool`, `keyword_exclusion_pool`, `study_type_pool`, `study_type_exclusion_pool`, `synonym_pool`) had FK constraints to `auth.users(id)` with `NO ACTION` delete rule. Replaced with `ON DELETE CASCADE` so that deleting a user automatically cleans up their pool entries.

**Root cause:** Original migrations created these tables without any FK on `user_id`. The Supabase dashboard later auto-created FK constraints, but with `NO ACTION` instead of the intended `CASCADE`.

**Pre-migration audit:**
- All user_ids in pool tables map to existing auth.users (0 orphan rows)
- 3 auth.users exist; 2 distinct user_ids appear across pool tables
- Existing FKs confirmed via `information_schema` query — all 5 had `NO ACTION`

**Migration:** `20260412040000_add_pool_tables_fk_cascade.sql`
- Drops existing `*_user_id_fkey` constraints on all 5 pool tables
- Recreates with `REFERENCES auth.users(id) ON DELETE CASCADE`

**Post-migration verification:**
- All 5 pool tables now show `CASCADE` delete rule
- `paper_attachments` was already correct (`CASCADE`)
- All data intact (row counts unchanged)
- TypeScript check passes, all 180 tests pass

**Files changed:** One migration file only. No frontend code changes.

## Fix papers/projects/tags FK — add ON DELETE CASCADE

**Date:** April 2026
**What:** `papers`, `projects`, `tags` had FK constraints to `auth.users(id)` with `NO ACTION` despite original migrations defining `ON DELETE CASCADE`. Same dashboard-drift root cause as the pool tables.

**Pre-migration audit:**
- 0 orphan rows across all 3 tables (689 papers, 34 projects, 82 tags)
- 2 distinct user_ids, all mapping to existing auth.users

**Migration:** `20260412060000_fix_papers_projects_tags_fk_cascade.sql`
- Drops existing NO ACTION constraints, recreates with ON DELETE CASCADE
- Also cleans up leftover `tmp_verify_fk()` audit function

**Post-migration verification:**
- All 10 user_id FK constraints across the entire schema now show CASCADE
- paper_attachments and profiles were already correct — not touched
- All data intact, TypeScript passes, 180 tests pass
- App-level: dashboard loads, projects/tags management works

**Files changed:** One migration file only. No frontend code changes.

**FK cascade status — complete:**
All user-scoped tables now have correct `ON DELETE CASCADE` to `auth.users(id)`. No further FK work needed.

## Evidence gathering (no PR — investigation only)

**Date:** April 2026
**What:** Ran EXPLAIN ANALYZE on all key queries via temporary PL/pgSQL wrapper. Generated synthetic data at 500/2K/5K/10K paper tiers. Measured DB execution times at each scale.
**Finding:** At current scale (389 papers), all queries execute in <40ms. Network RTT (~200ms) dominates. Keyword RPCs scale O(n×k) and reach ~225–275ms at 10K papers. Phase C optimization deferred — see [decisions-and-triggers.md](decisions-and-triggers.md).

## Notes + search wave (PRs #84–#88)

**Date:** April 2026
**What:** Two related capability waves shipped back-to-back.

**Notes feature (PRs #84–#87):**
- PR #84 — Added `notes text` column on `papers` (nullable, no default) and a Notes `<Textarea>` in the Edit Paper dialog. Loaded with the existing list query, persisted via the existing `updatePaper` mutation. No new RPCs, indexes, or RLS.
- PR #85 — Sticky-note icon in the list action cell opens a popover preview of the notes text. Shown only for papers with non-whitespace notes. No extra fetch.
- PR #86 — Tri-state "Has Notes" filter (`all | has | none`) in the filter bar. Implemented as a PostgREST predicate in `buildPapersQuery.ts` using POSIX regex (`[^[:space:]]` / `^[[:space:]]*$`) so NULL and whitespace-only notes both count as "no notes" — matches the list-indicator semantics.
- PR #87 — Migration `20260417020000_add_notes_to_search.sql` regenerates `papers.search_vector` to include `notes` at weight D, and adds `OR p.notes ILIKE …` to `search_papers_short`. Ranking hierarchy: A = title, B = abstract, C = journal + authors, D = notes. Migration applied to live Supabase.

**Search behavior (PR #88):**
- Migration `20260417030000_prefix_search.sql` replaces the body of the `search_papers` RPC. Old behavior used `websearch_to_tsquery`, which tokenizes and stems user input into complete lexemes — so `guideli` (lexeme `guideli`) did not match the stored lexeme `guidelin` from "guideline" until the full word was typed. New behavior splits the input on whitespace, strips only the ten tsquery operator/control characters (`& | ! ( ) : * < > ' " \`), appends `:*` to each non-empty token, `&`-joins them, and feeds the result to `to_tsquery('english', …)`. Unicode letters are preserved (Postgres regex character classes match per codepoint), so non-English content (Latin diacritics, Cyrillic, Hebrew, Arabic, CJK) continues to be searchable. Empty / all-blacklisted / whitespace-only input is guarded — `to_tsquery('')` is never called.
- Unchanged: `search_vector` column, `idx_papers_search_vector` GIN index, `search_papers_short` ILIKE path, length-1-2 routing, frontend code, query keys, types, debounce.
- Deliberately removed: `websearch_to_tsquery` sugar (quoted phrase, explicit `OR`, `-` exclusion). None were surfaced in the UI.
- Migration applied to live Supabase. Manual verification confirmed partial-input matching (e.g., `Ast` → `Asth` → `Asthma` all return the "Asthma" paper) and monotonic narrowing across multi-syllable terms.

**Files changed (cumulative):** `papers.notes` column add; `papers.search_vector` regenerated twice (notes inclusion, then unchanged across PR #88 since only the RPC body changed); two new RPC bodies (`search_papers`, `search_papers_short`); one new column-presence predicate in `buildPapersQuery.ts`; new UI surfaces for editing/viewing/filtering notes. No existing migration was modified — all changes are additive.

## Search wave — keywords in search + server-side attribution + quoted phrases (PRs #91–#93)

**Date:** April 2026
**What:** Three back-to-back PRs extending search end-to-end. All merged and live.

**Keywords in search_vector + per-field attribution (PR #91):**
- Migration `20260420010000_keywords_in_search_with_attribution.sql` drops + rebuilds `papers.search_vector` so `keywords::text` is included at weight C, alongside `authors::text` and `journal`. Title stays A, abstract B, notes D.
- Recreates `idx_papers_search_vector` GIN index on the rebuilt column.
- `DROP FUNCTION IF EXISTS search_papers(...)` then recreates it with return columns `(paper_id UUID, rank REAL, matched_title BOOLEAN, matched_abstract BOOLEAN, matched_authors BOOLEAN, matched_journal BOOLEAN, matched_notes BOOLEAN, matched_keywords BOOLEAN)`. Per-field flags computed by testing each field's own `to_tsvector('english', coalesce(field, ''))` against the same prefix-aware tsquery used in the WHERE clause. Sanitization rule unchanged from `20260417030000_prefix_search.sql` (whitespace split + tsquery-operator blacklist + `:*` per token + `&`-join, Unicode preserved).
- `DROP FUNCTION IF EXISTS search_papers_short(...)` then recreates it with the same eight-column return shape. Flags computed via direct ILIKE for scalar fields and `EXISTS (SELECT 1 FROM jsonb_array_elements_text(...) WHERE elem ILIKE …)` for `authors` and `keywords`.
- `GRANT EXECUTE ... TO authenticated` on both.
- Client: `src/hooks/papers/types.ts` gains a `MatchFlags` interface mirroring the SQL return columns 1:1 (snake_case). `src/hooks/useFilterState.ts` replaces `serverSearchIds: Set<string>` and `shortSearchIds: Set<string>` with `Map<string, MatchFlags>` and exports a memoized `searchMatchFlags`. `src/components/papers/PaperList.tsx` adds a `MATCH_FIELD_ORDER` constant (Title, Abstract, Authors, Journal, Notes, Keywords) and renders a read-only "Matched in: …" sub-line of outline `<Badge>`s on each matching row after the project-chips line. The sub-line is hidden when search is empty or only non-search filters are active. `src/pages/Dashboard.tsx` threads `searchMatchFlags` from the hook into `<PaperList />`.

**Quoted phrase search (PR #92):**
- No migration. `src/hooks/useFilterState.ts` detects a `"…"` wrapper on the debounced query and, when present with a non-empty inner string of ≥1 character, routes to a new phrase-search mode that reuses the existing `search_papers_short` RPC with the inner string wrapped in `%…%` for per-field ILIKE + `EXISTS` over jsonb arrays. Phrase mode takes priority over FTS (≥3 chars) and short-query (1–2 chars) modes via mutually-exclusive `!usePhraseSearch` guards; unquoted behavior is bit-identical to PR #91.
- Literal match — no stemming, no tokenization, Unicode-safe, punctuation-preserving (e.g. `"COX-2"`, `"研究"`).
- A single quote character, an unterminated quote, or `""` all fall back to the regular FTS/short path.
- The same six `matched_*` columns flow through, so the "Matched in: …" sub-line works identically for phrase queries.

**Placeholder-based discoverability hint (PR #93):**
- No migration. Single-line change in `src/components/papers/SearchFilters.tsx`: placeholder updated to `Search titles, authors, notes, keywords... Use "..." for exact phrase` (JSX expression form because the literal contains double quotes).
- An initial helper-line prototype was implemented in a first commit and then reverted in a follow-up commit on the same branch per user direction — the final net diff vs main is the one-line placeholder change only.

**Files changed (cumulative across PRs #91–#93):**
- New migration: `supabase/migrations/20260420010000_keywords_in_search_with_attribution.sql`
- `src/hooks/papers/types.ts` (new `MatchFlags` interface)
- `src/hooks/useFilterState.ts` (three-mode routing, `searchMatchFlags` map export)
- `src/components/papers/PaperList.tsx` (`MATCH_FIELD_ORDER`, "Matched in: …" sub-line)
- `src/pages/Dashboard.tsx` (thread `searchMatchFlags` prop)
- `src/components/papers/SearchFilters.tsx` (placeholder text)

**Verification:**
- Migration `20260420010000_keywords_in_search_with_attribution.sql` applied to live Supabase via SQL Editor. Post-deploy SQL confirmed both RPCs return the six `matched_*` boolean columns in correct order.
- Manual end-to-end check: keyword-only matches surface `Matched in: Keywords`; multi-field matches render chips in fixed order; phrase queries on multi-word substrings (`"muscle protein synthesis"`) return literal matches with no stemmer surprise; clearing the search box removes all sub-lines; non-search filters alone render no sub-line.
- `npx tsc --noEmit`, `npx vitest run`, `npm run build` all clean after each PR.

## Docs normalization for the search wave (PR #94)

**Date:** April 2026
**What:** Docs-only normalization so future planning sessions accurately reflect the completed search wave (PRs #91–#93). No code, schema, or behavior change.
**Files changed:**
- `docs/start-here.md` — corrected the stale "quoted phrases deliberately removed" claim (true for PR #88, superseded by PR #92), added a section covering PRs #91–#93, extended the "Key files" table with `useFilterState.ts`, `papers/types.ts`, `SearchFilters.tsx`, and the two search-related migrations, updated "Current recommendation" through PR #93.
- `README.md` — added phase 6 to "Current status (April 2026)".
- `docs/migration-history.md` — appended the "Search wave — keywords in search + server-side attribution + quoted phrases (PRs #91–#93)" section above.
**No migration.** No DB change.

## Saved Searches / Filter Presets — MVP (PR #96)

**Date:** April 2026
**What:** First user-facing capability beyond the search wave. Users can snapshot the current filter/search configuration under a name, list saved presets alphabetically, load one (full replacement of saved state), and delete with a confirmation.

**Migration (applied to live Supabase):** `supabase/migrations/20260421010000_add_filter_presets.sql`
- New table `public.filter_presets` (`id uuid pk`, `user_id uuid → auth.users(id) on delete cascade`, `name text`, `payload jsonb`, `created_at timestamptz`, `updated_at timestamptz`, all `NOT NULL`).
- Case-insensitive unique index `idx_filter_presets_user_name` on `(user_id, lower(name))` enforces per-user name uniqueness; duplicate INSERTs surface Postgres error `23505`, which the client renders as a "Name already taken" toast.
- Lookup index `idx_filter_presets_user_id` on `(user_id)`.
- `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on the table.
- Four RLS policies, one per CRUD verb, all `USING (auth.uid() = user_id)` / `WITH CHECK (auth.uid() = user_id)`.
- `update_updated_at_column()` trigger reused for `BEFORE UPDATE`.

**Why JSONB instead of individual columns:** the payload is round-tripped as a whole; nothing queries its internal keys. JSONB means adding/removing a filter field later is a zero-schema-change operation. Type safety is recovered client-side via a Zod `safeParse` at the read boundary; rows that fail validation are dropped from the menu with a `console.warn` so one corrupt row never breaks the dropdown.

**Saved payload (Zod schema in `useFilterPresets.ts`):** `version: 1` sentinel + 8 user-state fields — `searchQuery: string` (saved **raw, verbatim** including surrounding quotes so phrase searches like `"muscle protein synthesis"` round-trip exactly), `yearFrom: string`, `yearTo: string`, `studyType: string`, `notesPresence: "all" | "has" | "none"`, `selectedKeywords: string[]`, `selectedProjectId: string | null`, `selectedTagId: string | null`. Sort state is intentionally **not** in the payload — it is a view concern. No other field is in the schema.

**Load semantics — full replacement.** `applyPreset` invokes each of the 8 setters exactly once with the saved value. There is no merge, no diff, no partial overlay. The preset name uniquely determines the resulting filter state. Stale-ID guard: if the saved `selectedProjectId` or `selectedTagId` no longer exists in the user's current `projects`/`tags` lists, the field is set to `null` and a gentle toast surfaces ("The project/tag saved in this preset no longer exists — skipped"). The preset still loads.

**Files changed (new + modified):**
- `supabase/migrations/20260421010000_add_filter_presets.sql` — new table + RLS + indexes + trigger.
- `src/integrations/supabase/types.ts` — `Row`/`Insert`/`Update` rows for `filter_presets`.
- `src/lib/queryKeys.ts` — `filterPresets.all(userId)` key.
- `src/hooks/useFilterPresets.ts` — new hook: `useQuery` list (alphabetical, case-insensitive, `staleTime: 60_000`), create + delete `useMutation`s with 23505-aware error toast, pure `applyPreset` and `parsePresetPayload`/`validatePresetName`/`buildPresetPayload` helpers.
- `src/hooks/useFilterState.ts` — exposed `setSelectedKeywords` (the existing return surface only had `handleKeywordToggle`; preset restore needs the direct array setter).
- `src/components/papers/FilterPresetsMenu.tsx` — new component: shadcn `DropdownMenu` (Save row + Saved-searches list with delete trash), Save `Dialog` (autofocused `Input`, `maxLength=80`, Enter submits), Delete `AlertDialog` confirmation. Empty state reads "No saved searches yet".
- `src/components/papers/SearchFilters.tsx` — mounts `<FilterPresetsMenu />` in the actions row before the Clear button; threads 7 new props.
- `src/pages/Dashboard.tsx` — wires `useFilterPresets({ userId })`, `getCurrentPresetPayload` (calls `buildPresetPayload`), and `handleLoadPreset` (calls `applyPreset` and toasts on `droppedProjectId`/`droppedTagId`).
- `src/hooks/__tests__/useFilterPresets.test.ts` — 18 unit tests covering `applyPreset` (default / fully-populated / stale-project / stale-tag / both-stale), `parsePresetPayload` (valid + multiple invalid shapes including future-version and bad enum), `validatePresetName` (empty / whitespace / overlength / at-limit), `buildPresetPayload` (version sentinel attach).

**Verification:**
- `npx tsc --noEmit`, `npx vitest run` (203/203 pass), `npm run build`, `npm run lint` — all clean (no new lint issues vs main).
- Migration applied to live Supabase via SQL Editor.
- Post-deploy SQL spot-checks confirmed: 6 columns all `NOT NULL` with correct types; both `relrowsecurity` and `relforcerowsecurity` are `true`; four RLS policies (one each for SELECT/INSERT/UPDATE/DELETE); the case-insensitive unique index on `(user_id, lower(name))` is present alongside the user-id lookup index.
- **Cross-user RLS isolation — empirically verified (post-merge).** The earlier handoff noted this check as owed. It has since been performed: the user signed in as two separate accounts (one real, one test) and confirmed each account cannot see the other's rows in `filter_presets`. Treat the empirical end-to-end check as **done**; do not re-flag it as open.

**Explicit MVP exclusions (do not re-propose as if they exist):** rename a preset, overwrite-on-duplicate-name, sharing / public presets / collaboration, import/export of presets, dedicated preset management page or sidebar surface, sort-state persistence in the payload, version history / audit trail for preset edits, auto-run / scheduled presets / saved-search alerts / smart folders / search-within-the-preset-list / drag-reorder / preset folders or tags, any change to existing search routing, `Matched in:` attribution, or `onClearFilters` behavior.

## Saved Searches / Filter Presets — update-existing-loaded-preset (PR #98)

**Date:** April 2026
**What:** First follow-up on the presets MVP. Adds a fifth user-visible action to the Presets dropdown — *Update "<name>"* — so a user can load a preset, tweak the current filters/search, and overwrite that same preset's stored payload **without** deleting and re-saving. No schema change, no search-behavior change, no payload-shape change.

**UX.** After a successful Load — or after a successful Save — the target preset becomes the **currently loaded preset**. When a preset is loaded, the Presets dropdown shows an extra item directly under *Save current search…*: `Update "<loaded preset name>"`. Clicking it opens an AlertDialog with the copy *"<name> will be overwritten with the current filters and search. The preset name stays the same. This cannot be undone."* On confirm, the preset's `payload` is overwritten with the current dashboard state. The preset name is preserved. The item is hidden when no preset is loaded. The loaded-preset pointer is cleared on Clear Filters and on Deleting the loaded preset — so the *Update* action cannot target a stale row.

**Targeting rule — id, not name.** The UPDATE mutation targets the preset by `id`, never by name lookup. This means a rename or duplicate-name scenario (neither exists in the MVP, but reserved for future) cannot silently overwrite the wrong row. The existing case-insensitive unique index on `(user_id, lower(name))` is unaffected because the mutation deliberately does not touch the `name` column. The existing `update_updated_at_column()` trigger refreshes `updated_at` as normal.

**No schema / migration change.** The `filter_presets` table, RLS policies, unique index, `updated_at` trigger, and the Zod payload schema (`version: 1` + 8 fields) are all unchanged. Nothing in this PR required SQL work.

**Files changed:**
- `src/hooks/useFilterPresets.ts` — added `updatePresetMutation` (id-targeted `UPDATE { payload }`), added `updatePreset` callback, extended the hook's return with `isUpdating` and `updatePreset`. Changed `savePreset` to resolve to the created `FilterPreset | null` (was `boolean`) so the caller can set the just-created row as "currently loaded" without a re-fetch round-trip.
- `src/pages/Dashboard.tsx` — added `loadedPresetId: string | null` state + `loadedPreset` memo. Wired `handleSavePreset`, `handleLoadPreset`, `handleDeletePreset`, `handleClearFilters`, and new `handleUpdateLoadedPreset` — set / clear the loaded-preset pointer at the correct points so *Update* can never target a stale or already-deleted row.
- `src/components/papers/FilterPresetsMenu.tsx` — new `loadedPreset` / `isUpdating` / `onUpdateLoaded` props; conditional `Update "<name>"` DropdownMenuItem; AlertDialog confirmation that keeps itself open on mutation failure so the user can retry.
- `src/components/papers/SearchFilters.tsx` — threaded the three new props through.

**Verification:**
- `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `npm run lint` — all clean.
- Manual flow confirmed live: load a preset → tweak filters → reopen dropdown → *Update "<name>"* appears as the second item → confirm → preset row reflects the new payload; label of the action correctly updates when a different preset is loaded; Clear Filters and deleting the loaded preset both hide the *Update* item.

**Explicit non-goals (do not re-propose as if they exist):** rename a preset, rename via the update flow, a per-row edit pencil icon, any form-based payload editor, version history of past payloads, bulk-update across presets. The MVP-exclusions list from PR #96 remains in force — PR #98 adds exactly one new action and does not reopen any earlier exclusion.

## Saved Searches / Filter Presets — dropdown count label (PR #99)

**Date:** April 2026
**What:** One-line UI polish on top of the presets capability. The *Saved searches* label inside the Presets dropdown now appends the total preset count, rendered as `Saved searches · N`. Users see the total at a glance and know to scroll when the visible rows are fewer than the total (the list is clipped at `max-h-[320px]`).

**Why a count label and not a visible scrollbar.** A first attempt added an always-visible thin scrollbar via `::-webkit-scrollbar` + `scrollbar-width: thin`. On macOS Chromium (Chrome, Safari, and Electron builds) the OS-level overlay-scrollbar mode overrode those styles even with `-webkit-appearance: none` — `offsetWidth − clientWidth` stayed at `0` in live verification. The count label is OS-agnostic, adds zero visual chrome, and is strictly more informative than a scrollbar (it communicates the total as well as "there is more").

**No schema / behavior change.** Single literal edit in the JSX template of `FilterPresetsMenu.tsx`. No new state, no new props, no changes to hooks, payload schema, RPCs, or search behavior.

**Files changed:**
- `src/components/papers/FilterPresetsMenu.tsx` — the `DropdownMenuLabel` text now reads `` `Saved searches${presets.length > 0 ? ` · ${presets.length}` : ""}` `` so the count is omitted when there are zero presets (empty-state copy still renders below).

**Verification:** `npx tsc --noEmit` clean; verified live in the preview — label rendered `Saved searches · 11` for an account with 11 saved presets.

## Saved Searches / Filter Presets — loaded-preset dirty-state indicator (PR #101)

**Date:** April 2026
**What:** Adds a visual unsaved-changes signal for the currently loaded preset. When a preset is loaded and the current dashboard filter/search state diverges from its stored `payload`, the Presets trigger button shows a small accent dot (top-right, `bg-primary` with a `ring-2 ring-background`) and the trigger's `aria-label` flips from `Presets` to `Presets — unsaved changes`. Inside the dropdown, the existing `Update "<name>"` item is **enabled when dirty** and **disabled when clean** (shadcn's standard muted + `cursor-not-allowed` styling). When no preset is loaded, neither the dot nor the Update item is shown — unchanged from prior behavior.

**Derivation — pure, no schema, no migration.** A new exported helper `arePresetPayloadsEqual(a, b)` in `src/hooks/useFilterPresets.ts` compares the 8 payload fields. Scalars (`version`, `searchQuery`, `yearFrom`, `yearTo`, `studyType`, `notesPresence`, `selectedProjectId`, `selectedTagId`) compare with strict `===`; `selectedKeywords` is compared **order-insensitively** as a set (same length + same members) so toggling a keyword off and back on does not register as dirty. `applyPreset` still restores keyword order on load — only the dirty comparator is order-insensitive. A `version` mismatch reads as dirty (defensive / future-proof). In `Dashboard.tsx`, `isLoadedPresetDirty` is a `useMemo` over `loadedPreset` and the existing `getCurrentPresetPayload` callback. No new state, no effects, no DB column, no mutation changes.

**No tooltip / `title` on the disabled Update item.** Disabled Radix `DropdownMenuItem`s are not a reliable hover/focus target across browsers — the `title` attribute may not appear consistently. The signal is the **trigger dot's presence/absence** before the menu opens, reinforced by the muted/disabled item once the menu is open. This decision is final; do not re-propose adding a tooltip.

**Rename interaction (forward reference).** Rename (added in PR #102, below) only touches `name`, never `payload`. Because the dirty comparator looks at payload fields only, **rename is never affected by — and never affects — the dirty-state signal**.

**Files changed:**
- `src/hooks/useFilterPresets.ts` — added exported pure helper `arePresetPayloadsEqual`. No change to hook return surface, no new mutations, no schema or Zod changes.
- `src/pages/Dashboard.tsx` — imported `arePresetPayloadsEqual`, added `isLoadedPresetDirty` `useMemo` colocated with the existing `loadedPreset` memo, threaded `isLoadedPresetDirty` into `<SearchFilters />`.
- `src/components/papers/SearchFilters.tsx` — one new prop `isLoadedPresetDirty: boolean`, passed straight through to `<FilterPresetsMenu />`.
- `src/components/papers/FilterPresetsMenu.tsx` — accepts `isLoadedPresetDirty`. Adds the trigger-button dot conditionally on `loadedPreset && isLoadedPresetDirty`. Trigger gains `relative` class + state-aware `aria-label`. Update item's `disabled` becomes `!isLoadedPresetDirty || isUpdating`; no `title` is set.
- `src/hooks/__tests__/useFilterPresets.test.ts` — 12 unit tests for `arePresetPayloadsEqual` covering identical payloads, each of the 8 fields differing in isolation (`it.each`), order-insensitive keyword equality, length-mismatch keywords, `null` vs `""` distinction on `selectedProjectId`, version mismatch, and whitespace/case differences in `searchQuery`.

**No schema, RLS, payload, or migration change.** Purely derived UI state.

**Verification:**
- `npx tsc --noEmit`, `npx vitest run` (220/220 pass — 208 prior + 12 new), `npm run build`, `npm run lint` — all clean (no new lint issues vs main).
- Manual flow confirmed live: load a preset → no dot, Update disabled → tweak any tracked field → dot appears, Update enables → revert the tweak → dot clears, Update disables → toggle a keyword off and back on → state stays clean → click Update → dot clears after the mutation resolves.

**Explicit non-goals (do not re-propose):** an explanatory tooltip on the disabled Update item, a per-row `• modified` suffix, a persistent banner / toast about unsaved changes, state-aware copy on the Update item (`Save changes` / `No changes`), a full diff view of current vs saved payload, autosave, "Revert to saved" action, navigate-away confirm dialog.

## Saved Searches / Filter Presets — rename action (PR #102)

**Date:** April 2026
**What:** Users can now rename an existing preset without deleting and re-saving. Each preset row in the Presets dropdown gains a per-row pencil icon between the name button and the existing trash button. Clicking the pencil closes the menu and opens a small dedicated Rename dialog with the current name prefilled and selected. Submitting writes the new name to the targeted row by `id`; payload, `created_at`, and `id` are untouched.

**Targeting rule — id, not name.** The UPDATE mutation does `update({ name }).eq("id", id)` — it can never accidentally rename a different row by name lookup. The existing case-insensitive unique index `idx_filter_presets_user_name` on `(user_id, lower(name))` enforces uniqueness; conflicts surface as Postgres `23505` and the client renders the existing `Name already taken` toast (same idiom as the create flow). The existing `update_filter_presets_updated_at` trigger refreshes `updated_at` as normal.

**Validation — reused verbatim.** `validatePresetName` is the source of truth: trim → reject if empty → reject if > `PRESET_NAME_MAX_LENGTH` (80). The Rename dialog's `<Input>` carries `maxLength={PRESET_NAME_MAX_LENGTH}` to mirror the Save dialog.

**No-op rename — guarded.** A new pure helper `prepareRename(preset, newName)` in `useFilterPresets.ts` returns one of three outcomes: `invalid` (validation failed), `noop` (trimmed new name byte-identical to current name), or `ok` (real rename). The hook's `renamePreset` callback maps these to side effects — for `noop`, **no Supabase call, no list query invalidation, no `updated_at` bump, no success toast** — the dialog just closes. The Save button in the Rename dialog is disabled when (a) validation would fail, (b) the trimmed draft equals the current name, or (c) a rename mutation is in flight; the form's `onSubmit` is gated on the same memoized condition so Enter doesn't bypass it. Both the dialog's submit handler and the hook's `renamePreset` re-check defensively in case the disable is bypassed (e.g. by a browser extension).

**Case-only rename is allowed.** `"My Preset"` → `"my preset"` (or `"My preset"`) is treated as a real rename — the strings differ after trim, so the mutation runs. Postgres permits the UPDATE because a row never conflicts with itself even when the unique-index expression `lower(name)` collapses to the same key. This preserves the user's ability to fix capitalization.

**Loaded-preset interaction.** If the renamed preset is currently loaded, `loadedPresetId` is unchanged. After the list refetch, the derived `loadedPreset` memo re-resolves the same id to the updated row; `loadedPreset.name` becomes the new name; the `Update "<name>"` label updates automatically. Because rename only touches `name` (never `payload`), the **dirty-state dot from PR #101 is unaffected** — `arePresetPayloadsEqual` compares payload fields only.

**No schema / migration / RLS change.** `filter_presets.name` is already plain `TEXT NOT NULL` with the per-user case-insensitive unique index; the existing UPDATE RLS policy already covers writes. Nothing in this PR required SQL work.

**Files changed:**
- `src/hooks/useFilterPresets.ts` — added pure helper `prepareRename`, added `renamePresetMutation` (id-targeted `UPDATE { name }` with the canonical 23505 → "Name already taken" branch), added `renamePreset` callback that handles validation toast / no-op short-circuit / mutation invocation. Hook return surface gains `renamePreset` and `isRenaming`.
- `src/pages/Dashboard.tsx` — destructured `renamePreset` and `isRenaming` from `useFilterPresets({...})`; threaded them into `<SearchFilters />` as `onRenamePreset` and `presetsRenaming`. No changes to `loadedPresetId` or any preset handler.
- `src/components/papers/SearchFilters.tsx` — added two passthrough props (`onRenamePreset`, `presetsRenaming`) and threaded them into `<FilterPresetsMenu />`.
- `src/components/papers/FilterPresetsMenu.tsx` — per-row Pencil button between the name and trash buttons; new `Rename saved search` Dialog mirroring the Save dialog's structure with autofocus + select-all on the prefilled input; `presetToRename` / `renameDraft` state; memoized `renameSubmitEnabled` (validation + no-op guard + `!isRenaming`); defensive submit handler that re-checks both conditions before delegating to `onRename`.
- `src/hooks/__tests__/useFilterPresets.test.ts` — 8 new unit tests for `prepareRename` covering: real rename with trimming, no-op (exact-equal and trim-equal), case-only difference (real rename, both `"my preset"` and `"My preset"` cases), invalid (empty, whitespace, over-length), and exact-max-length pass-through.

**Verification:**
- `npx tsc --noEmit`, `npx vitest run` (228/228 pass — 220 prior + 8 new), `npm run build`, `npm run lint` — all clean (no new lint issues vs main).
- Manual flow confirmed live: per-row pencil renames a non-loaded preset (toast + new name in list); per-row pencil renames the loaded preset (label of `Update "<name>"` updates automatically, dirty state unaffected); duplicate name surfaces "Name already taken"; whitespace-only name is locally rejected; no-op rename (unchanged trimmed name) closes the dialog with **no network request and no toast** (verified via DevTools Network tab); case-only rename runs as a real rename.

**Explicit non-goals (do not re-propose as if they exist):** autosave or inline / click-on-name rename, bulk rename or rename-via-search-and-replace, version history of past names, "recently renamed" indicator, rename-only docs in this same PR (docs follow-up is its own normalization PR), any change to `payload` / `arePresetPayloadsEqual` / the dirty-dot logic from PR #101, any change to the Save / Update / Delete flows or copy.

**Explicit non-goals (do not re-propose):** a distinct "N of total" indicator when the list is partially scrolled, a custom-styled scrollbar (see "Why a count label" above), a chevron / fade / scroll-hint element, or any other overflow affordance. The count label is the chosen indicator for the current scale.
