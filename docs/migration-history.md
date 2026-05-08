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

## Saved Searches / Filter Presets — E2E coverage (PR #104)

**Date:** April 2026
**What:** Added the first focused Playwright spec for the Saved Searches / Filter Presets workflow at `e2e/filter-presets.spec.ts`. The spec exercises the entire user flow through the real UI: save preset, reload page, load preset back, quoted phrase query (`"…"`) round-trip via `searchQuery`, dirty-state dot + `Update "<name>"` enabled-when-dirty / disabled-when-clean semantics, update-overwrites-payload, rename via the per-row pencil (no-op guard verified, case-only rename verified, dirty state unaffected), delete via the trash + `AlertDialog` confirmation, count label `Saved searches · N`, and the empty-state `No saved searches yet` reading. Test isolation uses an `E2E-` name prefix so a `beforeEach` cleanup hook reliably removes leftovers from prior failed runs without touching the user's real presets.

**Cross-user RLS isolation deliberately not covered.** The existing E2E auth harness (`e2e/global-setup.ts`) signs in a single `storageState` account; adding a second account would require multi-user auth plumbing that exceeded the scope of a testing-only PR. The empirical two-account RLS verification documented for PR #96 (Saved Searches MVP) already covers cross-user isolation for `filter_presets`.

**Files changed:**
- `e2e/filter-presets.spec.ts` (new)

**Verification:**
- `npx playwright test e2e/filter-presets.spec.ts` and full `npx playwright test` both passed locally on the PR branch.
- No application code, schema, RPC, RLS, or UI behavior changed.

## Playwright flake stabilization (PR #105)

**Date:** April 2026
**What:** Stabilized the two Playwright flakes observed after PR #104. Testing-side hardening plus one narrow accessibility-only product change.

**Flake 1 — `e2e/mutations.spec.ts:215` (cleanup step).** The cleanup-side selector `dialog.locator("span, div").filter({ hasText: TEST_TAG })` matched every ancestor that contained the tag-name text and could resolve to a disabled shadcn `Button` (the Popover trigger) instead of the actual icon-only X/remove button. The icon-only `<button>` had no accessible name, so a role-based selector was not yet usable.
- **Fix (product, a11y-only):** added `aria-label="Remove project \"<name>\""` and `aria-label="Remove tag \"<name>\""` plus explicit `type="button"` to both icon-only remove buttons in `src/components/papers/EditPaperDialog.tsx`. This is a genuine WCAG improvement for icon-only buttons.
- **Fix (test):** rewrote the cleanup selectors in `e2e/mutations.spec.ts` to use `dialog.getByRole("button", { name: 'Remove project "<name>"' })` (and the tag equivalent), which resolves unambiguously to the X button.

**Flake 2 — `e2e/filter-presets.spec.ts` count-label test (full-suite race).** Under full-suite load, a `Preset saved` / `Preset deleted` / `Preset updated` / `Preset renamed` shadcn toast from the previous mutation could still be animating out (~5s auto-dismiss) when the next click on the Presets trigger fired, intercepting the click and producing inconsistent menu state.
- **Fix (test only):** added `waitForToastDetached(page, title)` (waits for `getByText(title, { exact: true })` to reach `state: "detached"` with a 15s tolerance) and called it at every mutation boundary in the spec's helpers (save, delete, update, rename). Also added `dismissStaleOverlays(page)` called in `beforeEach` — hammers Escape twice and asserts no `dialog` / `alertdialog` / `menu` remains.

**Files changed:**
- `src/components/papers/EditPaperDialog.tsx` — `aria-label` + `type="button"` on the two icon-only remove buttons (a11y-only, no behavior change).
- `e2e/mutations.spec.ts` — role/name selectors for the project/tag X buttons.
- `e2e/filter-presets.spec.ts` — `waitForToastDetached` at mutation boundaries; `dismissStaleOverlays` in `beforeEach`.

**Verification:**
- Focused specs passed.
- Two consecutive full Playwright suite runs at **60/60** each.
- No schema/migration changed; no docs changed in this PR.

## Notes — E2E coverage (PR #106)

**Date:** April 2026
**What:** Added focused Playwright coverage for the Paper Notes workflow at `e2e/notes.spec.ts`, locking in the user-visible behavior shipped in PRs #84–#87 and the search-attribution work from PRs #91–#93. The spec covers five cases:

1. **Add note** via the Edit dialog → row `StickyNote` indicator appears → popover preview shows the note text verbatim (newline + Unicode round-tripped).
2. **Edit existing note** — the Edit dialog's `<Textarea>` round-trips the saved value, and a replacement persists across reopen.
3. **Clear note** — emptying the textarea and saving removes the row indicator (matches the `paper.notes?.trim()` product predicate).
4. **`Has notes` / `No notes` filter** correctly partitions a paper with a note; reset to `All Papers` restores the full list.
5. **Search + `Matched in: Notes` attribution** — typing a unique alphanumeric marker that was planted in `notes` returns the paper, and the row's attribution sub-line shows a `Notes` badge.

**Strategy.** UI-driven only (no direct DB writes). The spec picks two papers from the first ~30 visible rows that currently have no notes indicator and uses them for the run. Each test is self-contained: it seeds the notes state it needs, asserts, and restores the paper to "no notes" before finishing. An `afterAll` hook performs a second defensive clear if a test aborts mid-way. Unique `E2E-NOTES-<timestamp>` tokens make search assertions immune to collisions with the user's real notes content. The search-attribution test uses a deliberately FTS-friendly alphanumeric marker (e.g. `zzqnote<base36-timestamp>`) — a short pure-numeric segment was tried first and silently dropped by the FTS tokenizer, so that path is now ruled out.

**Files changed:**
- `e2e/notes.spec.ts` (new)

**Verification:**
- `npx playwright test e2e/notes.spec.ts` passed.
- Full suite: `npx playwright test` → **65/65** pass.
- `npx vitest run` → **228/228** pass.
- `npx tsc --noEmit`, `npm run build`, `npm run lint` — all clean (no new lint issues vs main).
- No application code, schema, RPC, RLS, or UI behavior changed.

## `raw_keywords` nullable type alignment (PR #107)

**Date:** April 2026
**What:** Closed a small type drift between hand-written and generated Supabase types. The generated types in `src/integrations/supabase/types.ts` declare `papers.raw_keywords` as `string[] | null`, but the hand-written `Paper` interface in `src/types/database.ts` had it as a non-nullable `string[]`. A local inline shape in `useBulkMutations.reevaluateKeywords` (the row type returned by `fetchAllPages`) had the same drift. Both were widened to `string[] | null` so TypeScript reflects what the database can actually return.

**Audit (do not re-audit).** Every `raw_keywords` usage in `src/` was reviewed:
- 4 insert payloads (`usePaperMutations.ts:89`, `useBulkMutations.ts:102`, `useBulkMutations.ts:225`, `useBulkMutations.ts:378`) — all already produce a non-null array via `|| []`. No change.
- 1 column-list reference (`usePapers.ts:72`) — string in a SELECT, no value access. No change.
- 1 property-access read (`useBulkMutations.ts:677`) — already null-safe via `paper.raw_keywords || []`. No change.

No new null guards were required. No behavior change. No new tests were added — the only code-level change is a TypeScript type widening; the single read site was already null-safe.

**Files changed:**
- `src/types/database.ts` — `raw_keywords: string[]` → `string[] | null`.
- `src/hooks/papers/useBulkMutations.ts` — local inline row type for `reevaluateKeywords` updated to match.

**Verification:**
- `npx tsc --noEmit` — clean.
- `npx vitest run` — 228/228 pass.
- `npm run build` — clean.
- `npm run lint` — no new issues vs main.

**Explicit non-goals.** No schema or migration changed. No regenerated Supabase types. No search/import/UI behavior change. No docs change in that PR (this entry is the docs follow-up).

## `Matched in:` search-attribution — E2E coverage (PR #109)

**Date:** April 2026
**What:** Added a focused Playwright spec at `e2e/search-attribution.spec.ts` that locks in the server-driven `Matched in:` UI shipped in PRs #91–#93. The spec covers all six supported attribution sources — **Title, Abstract, Authors, Journal, Notes, Keywords** — with one test per source. Each test asserts that searching a token planted in only that field surfaces the seeded paper's row with the correct `Matched in: <Field>` badge, scoped to the parent of the `Matched in:` `<span>`.

**Strategy.** UI-driven seeding through the existing Edit Paper dialog (no service-role helpers exist in this repo, and the dialog already exposes all six searchable fields). `beforeAll` opens the first paper, captures every searchable field's current value (waiting for the `useAbstract` hook to finish so the abstract read is the real DB value), and **appends** a per-field unique alphanumeric token (`e2eattr<field><base36-timestamp>`) to all six fields in a single Save. Each token appears in exactly one field, so a search for any one token exercises that field's `matched_*` flag in isolation. `afterAll` restores the captured originals through the same dialog → no persistent test pollution.

**Row scope.** Every test locates the seeded row by the **title token**, because the title cell is the only cell guaranteed to render seeded text in the collapsed virtual table — abstract is fetched on demand for expanded rows, notes live in a popover, and keywords live in a separately-toggled column. This was a real bug in the first iteration of the spec (filtering rows by the abstract token returned no rows even when the search match was correct) and is now the documented row-scope rule.

**Files changed:**
- `e2e/search-attribution.spec.ts` (new)

**Verification:**
- `npx playwright test e2e/search-attribution.spec.ts` — 7/7 pass (6 new + setup).
- Full suite: `npx playwright test` → **71/71** pass.
- `npx vitest run` → 228/228 pass.
- `npx tsc --noEmit`, `npm run build`, `npm run lint` — all clean (no new lint issues vs main).

**Explicit non-goals.** Testing-only. No application behavior, search behavior, RPC, SQL, schema, or migration changed. No docs change in that PR (this entry is the docs follow-up). `Matched in:` remains server-driven — the client still does not re-tokenize the query.

## Internal `PresetNameForm` extraction (PR #111)

**Date:** April 2026
**What:** Refactored `src/components/papers/FilterPresetsMenu.tsx` to extract a small **internal** `PresetNameForm` component (in the same file — no new file). The component renders the shared `<form>` + `<Input>` + `<DialogFooter>` with Cancel + Save buttons that the Save Preset and Rename Preset dialogs both used. The parent retains the `<Dialog>` / `<DialogContent>` / `<DialogHeader>` / `<DialogTitle>` / `<DialogDescription>` JSX verbatim, all state (`saveOpen`, `nameDraft`, `presetToRename`, `renameDraft`), both refs (`inputRef`, `renameInputRef`), the two autofocus useEffects (Save: focus only; Rename: focus + select-all), both submit handlers (`handleSaveSubmit`, `handleRenameSubmit`) including all validation, the no-op rename short-circuit, the case-only rename allowance, the `23505` → "Name already taken" handling, the `renameSubmitEnabled` memo, and the Rename `<Dialog>`'s `onOpenChange` `!isRenaming` guard.

**Defensive form-onSubmit guard for Save** — intentional. The shared form's `<form>` `onSubmit` defensively gates on `submitDisabled` before invoking the parent's handler. The Save dialog previously had **no** such guard at the form level (only the button itself was disabled); the Rename dialog already had one (introduced in PR #102). Lifting the guard into `PresetNameForm` aligns Save's Enter-key path with Rename's existing defensive idiom. Observably equivalent in normal use because the Save button is already disabled in the same condition and `handleSaveSubmit` re-validates via `validatePresetName`. Called out explicitly in the PR body so reviewers do not misread it as a new product behavior.

**Files changed:** `src/components/papers/FilterPresetsMenu.tsx` only (+93 / −59).

**Verification:** `npx tsc --noEmit`, `npx vitest run` (228/228), `npx playwright test e2e/filter-presets.spec.ts` (6/6), full `npx playwright test` (71/71), `npm run build`, `npm run lint` — all clean (no new lint issues vs main).

**Explicit non-goals.** No new file. No copy / accessibility / dialog title / button text / toast text changes. No E2E selector changes. No schema / migration / RPC / RLS / search behavior / presets behavior changes. No extraction of the Update or Delete `<AlertDialog>`s. Refactor-only.

## Group `SearchFilters` preset props into one `filterPresets` prop (PR #112)

**Date:** April 2026
**What:** `SearchFilters` previously took **13 individual preset-related props** and forwarded each one (with five rename mappings — `presetsLoading`/`isLoading`, `getCurrentPresetPayload`/`getCurrentPayload`, `onSavePreset`/`onSave`, `onLoadPreset`/`onLoad`, `onUpdateLoadedPreset`/`onUpdateLoaded`, `onRenamePreset`/`onRename`) into `<FilterPresetsMenu />` without using any of them locally. PR #112 collapses those 13 props into a single `filterPresets: FilterPresetsMenuProps` prop, typed against the menu's existing interface. Three changes:

- `src/components/papers/FilterPresetsMenu.tsx` — one word: `export` added to the existing `FilterPresetsMenuProps` interface declaration so it can be imported as a type.
- `src/components/papers/SearchFilters.tsx` — removed the 13 preset fields from `SearchFiltersProps`; added one `filterPresets: FilterPresetsMenuProps` field; replaced the 13-line `<FilterPresetsMenu ... />` JSX with `<FilterPresetsMenu {...filterPresets} />`.
- `src/pages/Dashboard.tsx` — declared `const filterPresets: FilterPresetsMenuProps = { /* 13 fields */ };` immediately above the `return (` JSX block (locked-in decision: not inline in JSX, easier to scan and to grep). Replaced the 13 preset prop lines on `<SearchFilters />` with `filterPresets={filterPresets}`. Added `import type { FilterPresetsMenuProps }`.

**Memoization:** the bundle is a plain `const`, **not** wrapped in `useMemo` (locked-in decision). React compares the spread props individually, all 13 inner values are already `useCallback` / `useMemo` / primitive, the wrapper isn't used in any dep array, so memoization would add cost without benefit. If a future change ever puts `filterPresets` into a dep array, `useMemo` should be added at that point — not pre-emptively.

**Net diff:** −32 lines across 3 files. **Zero behavior change** — values flowing through to `FilterPresetsMenu` are bit-identical to before.

**Verification:** `npx tsc --noEmit` (primary gate, since the typed object literal must satisfy `FilterPresetsMenuProps`), `npx vitest run` (228/228), `npx playwright test e2e/filter-presets.spec.ts` (6/6), full `npx playwright test` (71/71), `npm run build`, `npm run lint` — all clean (one pre-existing `Dashboard.tsx` `react-hooks/exhaustive-deps` warning was unrelated and was fixed separately in PR #113).

**Explicit non-goals.** No new file. No new hook (no `usePresetOrchestration`). No changes to `useFilterPresets.ts`. No `FilterPresetsMenu` internals change beyond the one-word `export`. No copy / accessibility / E2E selector / toast text changes. No schema / migration / RPC / RLS / search / filter / presets-behavior changes. No grouping for export or project/tag props (separate, justified PRs if/when they ever happen).

## Fix `Dashboard.tsx` `react-hooks/exhaustive-deps` warning (PR #113)

**Date:** April 2026
**What:** Resolved the pre-existing `react-hooks/exhaustive-deps` warning at `src/pages/Dashboard.tsx:574` by adding `queryClient` to the dependency array of the `handleBulkAnalyze` `useCallback`. The closure references `queryClient` inside its body (passed to `fetchAbstractsBatch` to prime / read the per-paper abstract cache, line 528) but did not declare it as a dependency. The sister callback `handleAnalyzePaper` (line 510, the single-paper version of the same flow) already included `queryClient` in its dep array — this PR aligns the two.

**One-token diff:**

```ts
// before
}, [papers, selectedPaperIds, updatePaper, toast]);
// after
}, [papers, selectedPaperIds, updatePaper, queryClient, toast]);
```

**Why safe:** `useQueryClient()` returns a referentially-stable singleton for the lifetime of the surrounding `QueryClientProvider`. Adding a stable value to a dep array does not cause additional callback recreations — `handleBulkAnalyze`'s identity cadence is unchanged. The bulk-analysis flow (Gemini per-paper call, 3-second cooldown, success/fail counters, progress reporting, toast routing) runs identically. No stale-closure risk was ever present (closure can't go stale on a stable value); the warning was a true-positive on the rule, not on a runtime hazard.

**Files changed:** `src/pages/Dashboard.tsx` only (+1 / −1).

**Verification:** `npx tsc --noEmit`, `npx vitest run` (228/228), `npm run build`, `npm run lint` — all clean (the warning at `src/pages/Dashboard.tsx:574` is gone). Playwright was deliberately not run: the bulk-analysis code path is not covered by E2E (it requires real Gemini API calls), and the change is a dep-array adjustment that does not alter runtime behavior.

**Explicit non-goals.** No reorganisation of `handleBulkAnalyze`'s body, no extracted helper, no custom hook. No `eslint-disable` comment. No changes to any other `useCallback` / `useMemo` / `useEffect`. No type / schema / migration / RPC / RLS / search / filter / presets / UI / docs / test changes.

## Collapse `SearchFilters` export callbacks into one `onExport(format)` (PR #115)

**Date:** April 2026
**What:** `SearchFilters` previously took **three named callback props** — `onExportCSV`, `onExportRIS`, `onExportBibTeX` — and `Dashboard` wrapped the `useExportPapers` hook's `exportPapers(format)` with three trivial one-line lambdas (`handleExportCSV`, `handleExportRIS`, `handleExportBibTeX`) to feed each named callback. PR #115 collapses the indirection layer so the same single hook call (`exportPapers("csv" | "ris" | "bibtex")`) is invoked directly from `SearchFilters`'s export `<DropdownMenu>` items. Three files changed:

- `src/hooks/useExportPapers.ts` — promoted the inline parameter type union to a module-level `export type ExportFormat = "csv" | "ris" | "bibtex";` (single source of truth) and updated `exportPapers`'s signature to consume it. **Type-promotion only** — hook body and download behavior untouched.
- `src/components/papers/SearchFilters.tsx` — replaced the three named callback props on `SearchFiltersProps` with one `onExport: (format: ExportFormat) => void`. Imports `ExportFormat` from `@/hooks/useExportPapers` (**no duplicate union declared in this file**). Each `<DropdownMenuItem onClick=>` now calls `onExport("csv" | "ris" | "bibtex")` directly.
- `src/pages/Dashboard.tsx` — deleted the three wrapper lambdas (`handleExportCSV` / `handleExportRIS` / `handleExportBibTeX`). Now passes `onExport={exportPapers}` directly (the hook's signature already matches the new prop's signature; no inline `(format) => exportPapers(format)` lambda needed).

**Net diff:** **+15 / −16 across 3 files**.

**Behavior preservation.** Same hook call, same arguments, same downstream behavior. The Export button still reads `Export` when ready / `Exporting…` (with spinner) while a download is in flight. The dropdown still surfaces three menu items in the same order — CSV → RIS → BibTeX — with the same `<FileSpreadsheet>` / `<FileText>` / `<BookOpen>` icons and the same labels (`Export as CSV` / `Export as RIS` / `Export as BibTeX`). The `exportDisabled = !isExportReady || isExporting` gating is unchanged. `isExporting` and `isExportReady` remain individual primitive flags on `SearchFiltersProps` (deliberately not bundled). `src/lib/exportUtils.ts` is untouched.

**Files changed:**
- `src/hooks/useExportPapers.ts` — type-promotion only.
- `src/components/papers/SearchFilters.tsx` — 3 callback props → 1; 3 `onClick` handlers updated.
- `src/pages/Dashboard.tsx` — 3 wrapper lambdas deleted; 3 prop assignments → 1.

**Verification:**
- `npx tsc --noEmit` — clean (the `ExportFormat` union is enforced across the boundary).
- `npm run lint` — no new issues vs `main`.
- `npx vitest run` — 228/228 pass.
- `npx playwright test e2e/filter-presets.spec.ts` — 6/6 pass (focused gate; mounts the dashboard with the export button visible).
- `npm run build` — clean.
- **Full Playwright suite NOT run** — justified because the change is structural (same hook call, same downstream behavior) and the focused presets spec is the spec that exercises the dashboard with the export button rendered.

**Explicit non-goals.** No new file, no new hook (no `useDashboardExportActions`). No duplicate `ExportFormat` declaration in `SearchFilters.tsx` or `Dashboard.tsx` — the union lives in exactly one place: `src/hooks/useExportPapers.ts`. No grouping of `isExporting` / `isExportReady` into a bundle (they remain individual primitive flags). No changes to `src/lib/exportUtils.ts`, `BulkActionsToolbar.tsx`, or any other file. No copy / accessibility / icon / styling / E2E selector / toast text changes. No schema / migration / RPC / RLS / search-behavior / filter-behavior / presets-behavior / export-behavior / export-format changes. No test additions, no docs change in that PR (this entry is the docs follow-up).

## AI-analysis pre-refactor safety net — pure helpers + 22 Vitest unit tests (PR #117)

**Date:** April 2026
**What:** First deterministic safety net for the AI-analysis block in `src/pages/Dashboard.tsx`. Pure-helper extraction + Vitest unit tests; **no behavior change, no UI change, no hook extraction, no new test infrastructure**. The pure-helper layer is the prerequisite for the eventual `usePaperAnalysisActions` hook extraction (which does NOT exist yet and is explicitly out of scope here).

**New file: `src/lib/studyTypeUtils.ts`** — exports three pure helpers + one type:

- `isGenericStudyType(type: string | null | undefined): boolean` — null/undefined/empty/whitespace-only and the case-insensitive PubMed catch-all `"journal article"` return `true`. Lifted **verbatim** from inline definitions previously duplicated in `Dashboard.tsx:457` AND `EditPaperDialog.tsx:150`.
- `resolveStudyTypeAfterAnalysis(existing, aiSuggested)` — the smart-merge ternary. Preserves the exact `??` (nullish-coalescing) operator from the original `Dashboard.tsx` code; only falls back to the existing value if the AI omitted `studyType`.
- `buildAnalysisUpdates(paper, aiData)` — returns `{ updates: AnalysisUpdates, keptStudyType: boolean }`. `updates` is typed narrowly as `Pick<Paper, "tldr" | "study_type" | "statistical_methods">` (NOT `Record<string, unknown>`). `keptStudyType` is a strict `boolean` derived from the exact `Dashboard.tsx:491` predicate `Boolean(!isGenericStudyType(existing) && aiData.studyType && aiData.studyType !== existing)`. Operator semantics preserved verbatim: `??` for `study_type`, `||` for `tldr` and `statistical_methods` (truthy fallback, including on empty string).
- `type AnalysisUpdates = Pick<Paper, "tldr" | "study_type" | "statistical_methods">`.

**`Dashboard.tsx` change:** deleted the inline `isGenericStudyType`, the smart-merge ternaries (in both `handleAnalyzePaper` and `handleBulkAnalyze`), the inline payload literals, and the inline `keptStudyType` derivation. Both AI flows now call `buildAnalysisUpdates(paper, aiData)` and consume `{ updates, keptStudyType }`. The async orchestration (state, toasts, `supabase.functions.invoke("analyze-paper", …)`, `fetchAbstract` / `fetchAbstractsBatch`, `updatePaper`, 3-second cooldown) is **untouched**.

**`EditPaperDialog.tsx` change — strict import-swap only.** The duplicate inline `isGenericStudyType` (was lines 150–151) was deleted and replaced with `import { isGenericStudyType } from "@/lib/studyTypeUtils";`. **No other line of `handleAnalyze` was touched.** In particular, `EditPaperDialog`'s existing `"Not specified"` filtering remains verbatim:

```ts
if (data.studyType && data.studyType !== "Not specified") {
  setStudyType(data.studyType);
}
if (data.statisticalMethods && data.statisticalMethods !== "Not specified") {
  setStatisticalMethods(data.statisticalMethods);
}
if (data.tldr) setTldr(data.tldr);
```

**Intentional asymmetry preserved (current behavior):**
- **`Dashboard.tsx` does NOT filter `"Not specified"`.** If existing `study_type` is generic / null and the AI returns `"Not specified"` as `studyType`, `updates.study_type === "Not specified"` and is persisted as such.
- **`EditPaperDialog.tsx` DOES filter `"Not specified"`.**

The unit tests document this asymmetry as **"current behavior, not a contract"** in the test header. If the team ever decides Dashboard should also filter the sentinel, that must be a separate behavior-change PR with its own tests.

**New file: `src/lib/__tests__/studyTypeUtils.test.ts`** — 22 Vitest unit tests:

- `isGenericStudyType` (4 cases): null/undefined; empty/whitespace; `"Journal Article"` case + whitespace tolerance; specific types (`"RCT"`, `"Cohort Study"`, etc.).
- `resolveStudyTypeAfterAnalysis` (5 cases): kept-when-specific; adopted-when-null; adopted-when-generic-`"journal article"` (case-insensitive); `??` fallback when AI omits; `??` does NOT fall back on empty string.
- `buildAnalysisUpdates` happy paths (2 cases): all AI fields × generic existing → all adopted; all AI fields × specific existing → AI tldr + AI methods adopted, existing `study_type` kept.
- `buildAnalysisUpdates` `||` fallback (3 cases): empty AI tldr → existing kept; empty AI methods → existing kept; AI omits tldr entirely → existing kept.
- `buildAnalysisUpdates` `"Not specified"` pass-through (2 cases): passes through to `study_type` and `statistical_methods` when truthy (current Dashboard behavior, intentionally documented).
- `buildAnalysisUpdates.keptStudyType` truth table (6 cases): true when specific × different AI; false when identical AI; false when AI omits; false when generic existing × any AI; false when generic `"journal article"` literal × any AI; false when AI returns empty string.

**Files changed:**
- `src/lib/studyTypeUtils.ts` (new)
- `src/lib/__tests__/studyTypeUtils.test.ts` (new — 22 tests)
- `src/pages/Dashboard.tsx` (delete inline `isGenericStudyType` + both smart-merge ternaries + both payload literals + inline `keptStudyType` derivation; both AI flows now call `buildAnalysisUpdates`)
- `src/components/papers/EditPaperDialog.tsx` (delete inline `isGenericStudyType`; import from `@/lib/studyTypeUtils`; no other line touched)

**Verification:**
- `npx tsc --noEmit` — clean.
- `npx vitest run` — **250/250** pass (228 prior + 22 new).
- `npm run lint` — no new issues vs main.
- `npm run build` — clean.
- `npx playwright test e2e/filter-presets.spec.ts` — **6/6** pass (focused smoke that the dashboard still mounts and the AI handlers wire through unchanged).
- **Full Playwright suite NOT run** — pure helper extraction has no plausible E2E regression surface, and AI analysis is intentionally not E2E-covered (Gemini-dependent, non-deterministic, rate-limited).

**Explicit non-goals (reflect in future planning):**
- **No `usePaperAnalysisActions` hook extraction yet** — sequenced as the next AI-analysis PR. The pure helpers are the prerequisite.
- **No tests for `handleAnalyzePaper` / `handleBulkAnalyze` themselves** (the async, toast, mutation, cooldown layers).
- **No `vi.useFakeTimers()` introduction**, **no `vi.mock("@/integrations/supabase/client")` introduction**, **no `renderHook` for any AI handler**, **no QueryClient test wrapper** — none of these test infrastructures exist in the repo today.
- **No real Gemini / Edge Function E2E**. The Sparkles AI button and bulk-analyze toolbar are intentionally not E2E-covered.
- No changes to the `analyze-paper` Edge Function, `useAbstract.ts`, `<PaperList>` / `<BulkActionsToolbar>` JSX or props, toast text, button labels, or any UI surface.
- **No filtering of `"Not specified"` in `buildAnalysisUpdates`** (would be a behavior change — out of scope here).
- **No merge of `studyTypeUtils.ts` into `evaluateStudyType.ts`** (the two files own different domains: study-type-vs-pool evaluation vs. AI-merge helpers).
- No docs change in that PR (this entry is the docs follow-up).

## AI-analysis hook extraction — `usePaperAnalysisActions` + 7 mocked-async tests (PR #119)

**Date:** April 2026
**What:** Extracted the async AI-analysis orchestration from `Dashboard.tsx` into a dedicated hook `src/hooks/usePaperAnalysisActions.ts`, paired with 7 focused mocked-async Vitest tests in `src/hooks/__tests__/usePaperAnalysisActions.test.ts`. Structural refactor only — **no behavior change, no UI change, no schema change**. PR #117's pure-helper safety net was the prerequisite (the hook imports `buildAnalysisUpdates` from `@/lib/studyTypeUtils` as-is).

**What moved out of `Dashboard.tsx`:** state (`analyzingPaperId`, `bulkAnalyzing`, `bulkAnalyzeProgress`) and callbacks (`handleAnalyzePaper`, `handleBulkAnalyze`). `Dashboard.tsx` now calls `usePaperAnalysisActions({ papers, selectedPaperIds, updatePaper })` and threads the 5 returned values unchanged into `<PaperList>` and `<BulkActionsToolbar>` props. **No JSX / UI / props changed in those components.**

**Behavior preservation — verbatim:**
- Toast titles / descriptions, `try / catch / finally` boundaries, bulk processing order, `selectedPaperIds`-derived selection, `buildAnalysisUpdates` (PR #117), `"Not specified"` Dashboard-vs-EditPaperDialog asymmetry, missing-abstract behavior, progress reset behavior — all unchanged.
- The hardcoded `await new Promise(resolve => setTimeout(resolve, 3000))` cooldown is now `await sleep(3000)`, where `sleep` defaults to a real `setTimeout`-backed wait in production. Tests inject a no-op `sleep`. Production behavior is bit-equivalent.

**Bulk cooldown truth table (intentionally preserved):** ✅ success → cooldown; ✅ caught per-paper failure → cooldown; ❌ missing abstract → NO cooldown (the `if (!abstract) { failCount++; continue; }` `continue` jumps to the next iteration before the `await sleep(3000)` line).

**New test infrastructure introduced (first time in the repo):**
- `vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: mockInvoke } } }))` — first repo-wide mock for `supabase.functions.invoke`.
- Injected `sleep` instead of `vi.useFakeTimers()` — tests pass `sleep: vi.fn().mockResolvedValue(undefined)` and assert call count + `3000` arg.
- `vi.mock("@/hooks/useAbstract")` for `fetchAbstract` / `fetchAbstractsBatch`.
- Standard `vi.mock("@/hooks/use-toast")` and `vi.mock("@tanstack/react-query")` overriding only `useQueryClient` (matches `usePaperMutations.test.ts` precedent).
- **No `renderHook` QueryClient wrapper** — bare `renderHook()` with module-level `useQueryClient` mock.

**The 7 tests.** Single-paper (4): skips papers without abstracts; analyzes one paper successfully; shows `"No abstract"` toast when fetch returns null; handles invoke error and clears `analyzingPaperId`. Bulk (3): exits early when selected papers have no abstracts; analyzes 2 papers successfully and reports `2 succeeded, 0 failed`; **mixed scenario** — paper1 success + paper2 missing abstract + paper3 caught invoke failure → `updatePaper` called once (paper1), per-paper failure toast for paper3, `sleep` called **exactly 2 times** (not 3), final toast `"1 succeeded, 2 failed out of 3 papers."`. The mixed scenario is the locked-in regression check for the missing-abstract-skip-cooldown rule.

**Files changed:**
- `src/hooks/usePaperAnalysisActions.ts` (new).
- `src/hooks/__tests__/usePaperAnalysisActions.test.ts` (new — 7 tests).
- `src/pages/Dashboard.tsx` — deleted 3 useState + both useCallback bodies + replaced with one hook call. Also dropped now-unused imports (`supabase`, `fetchAbstract`, `fetchAbstractsBatch`, `buildAnalysisUpdates`).
- `src/pages/Dashboard.tsx` follow-up commit `d368fb9` (same PR): removed unused `useQueryClient` import + `const queryClient = useQueryClient()` (the value is now owned inside the hook).

**Verification:**
- `npx tsc --noEmit` — clean.
- `npx vitest run` — **257/257** pass (250 prior + 7 new).
- `npm run lint` — no new issues vs main.
- `npm run build` — clean.
- `npx playwright test e2e/filter-presets.spec.ts` — 6/6 pass (focused dashboard-mount smoke).
- **Full Playwright suite NOT run** — same justification as PR #117 (AI flow is intentionally not E2E-covered; hook extraction has no plausible E2E regression surface).

**Explicit non-goals.** No real Gemini / Supabase Edge Function calls in tests. No real Gemini / AI Playwright E2E. No changes to `studyTypeUtils.ts`, `useAbstract.ts`, the `analyze-paper` Edge Function, the `fetch-paper-metadata` Edge Function, `<PaperList>`, `<BulkActionsToolbar>`, UI / copy / layout, schema / migration / RPC / RLS, or search / filter / presets / export behavior. No docs change in that PR (this entry is the docs follow-up).

## `fetch-paper-metadata` Edge Function — CPU hardening for large PubMed XML (PR #120)

**Date:** April 2026
**What:** Importing PMID `41912805` (a 2025+ assignment, paper authored as the consortium "GBD 2023 IHD & Dietary Risk Factors Collaborators") was killing the `fetch-paper-metadata` Edge Function with browser status `546` and Supabase logs:

```
User authenticated
Processing identifier 1/1 (type: pmid)
CPU Time exceeded
shutdown
```

The failure was **inside the Edge Function** — after auth and identifier-type detection succeeded — and was **NOT related to PR #119** (the import codepath does not pass through the AI-analysis hook). PR #120 made four small Edge-Function-only changes in `supabase/functions/fetch-paper-metadata/index.ts`:

1. **Bounded PubMed author parsing.** Replaced the previous single regex (three lazy `[\s\S]*?` quantifiers, capable of backtracking across `<Author>` boundaries when an author lacked `<ForeName>`) with a bounded two-pass extraction: first match each `<Author>...</Author>` block (FIRST `</Author>` always closes — never spans siblings), then per-block extract `<LastName>` and `<ForeName>` independently. Personal-author behavior preserved: emit only when both fields exist; format `${foreName} ${lastName}`.
2. **Reduced PubMed retry budget from 3 → 1.** PubMed call sites (`fetchFromPubMed`, `searchPubMedByDoi`, `searchPubMedByTitle`) now pass `fetchWithRetry(url, {}, 1)`. Crossref retry behavior is **unchanged** (different code path, not implicated).
3. **Added `MAX_PUBMED_XML_BYTES = 2 * 1024 * 1024`.** Hard size guard immediately after `await response.text()`. Oversized XML logs `pubmed-parse pmid=… bytes=… skipped=oversize` and returns `null`, surfacing as the existing per-identifier `"Could not find paper metadata"` error rather than killing the function.
4. **Added a concise structured log line per successful PMID:** `pubmed-parse pmid=… bytes=… fetch_ms=… parse_ms=… t_authors=… t_abstract=… t_mesh=… t_subs=…`. Sizes / timings only — no titles, abstracts, author names, API keys, or user data (per the logging-redaction policy from PRs #81 / #82).

**Files changed:** `supabase/functions/fetch-paper-metadata/index.ts` only (+67 / −8).

**Behavior preservation:** auth requirement, CORS behavior, request shape (`{ identifiers: string[] }`), response shape (`{ results: PaperMetadata[] }`), per-identifier error envelope, PubMed-first / Crossref-fallback semantics, server-side-only PubMed API key, `MAX_IDENTIFIERS` validation, per-item sanitization, and the client-side wrapper in `src/lib/fetchPaperMetadataEdge.ts` — all unchanged.

**Verification:** `npx tsc --noEmit` clean, `npx vitest run` 257/257, `npm run lint` no new issues, `npm run build` clean. **Manual post-deploy reproduction with PMID `41912805` is the gate** (the Deno Edge Function is not in the Vitest harness; same pattern as PRs #81 / #82). After Supabase Edge Function deploy, the function no longer killed CPU on `41912805`.

**Edge Function deploy is separate from frontend / Vercel deploy.** Required after merge:

```bash
supabase functions deploy fetch-paper-metadata --project-ref lioxtgiputfniqbktcsz
```

**Explicit non-goals.** No client changes (`fetchPaperMetadataEdge.ts` untouched). No PR #119 / `usePaperAnalysisActions` / Dashboard / `analyze-paper` / schema / migration / RLS / RPC / UI changes. The browser-console 406s observed in the same incident are incidental (PostgREST `.single()` returning 0 rows — likely the `profiles.pubmed_api_key` lookup) and are not part of this hotfix.

## PubMed `<CollectiveName>` author support (PR #121)

**Date:** April 2026
**What:** After PR #120 was deployed, PMID `41912805` imported successfully — but with an empty `authors` array. PubMed represents that paper's sole author as a `<CollectiveName>` element rather than a personal `<LastName>` + `<ForeName>` pair, and the bounded extractor from PR #120 only emitted personal authors. PR #121 added `<CollectiveName>` support inside the existing per-`<Author>`-block loop, before the personal-author extraction:

```ts
const collectiveName = body
  .match(/<CollectiveName[^>]*>([\s\S]*?)<\/CollectiveName>/)?.[1]
  ?.replace(/<[^>]+>/g, "")
  .trim();
if (collectiveName) {
  authors.push(decodeHTMLEntities(collectiveName));
  continue;
}
// then the existing <LastName> + <ForeName> personal-author branch runs unchanged
```

The `decodeHTMLEntities` call decodes `&amp;` → `&` so the imported author reads `"GBD 2023 IHD & Dietary Risk Factors Collaborators"`. Personal-author papers are unaffected.

**Files changed:** `supabase/functions/fetch-paper-metadata/index.ts` only (+21 / −5).

**Behavior preservation:** all PR #120 invariants intact (bounded `<Author>...</Author>` parsing, no cross-author backtracking, `MAX_PUBMED_XML_BYTES`, PubMed retry budget = 1, concise `pubmed-parse` timing log including `t_authors`). Request / response shape, auth, CORS, PubMed-first / Crossref-fallback semantics, per-identifier failure behavior, client wrapper — all unchanged.

**Verification:** `npx tsc --noEmit` clean, `npx vitest run` 257/257, `npm run lint` no new issues, `npm run build` clean. Manual post-deploy reproduction: import PMID `41912805` → expect `authors: ["GBD 2023 IHD & Dietary Risk Factors Collaborators"]`, no `546`, `pubmed-parse pmid=41912805 …` log line still appears.

**Edge Function deploy required:** `supabase functions deploy fetch-paper-metadata --project-ref lioxtgiputfniqbktcsz`.

**Explicit non-goals.** No client changes. No PR #119 / Dashboard / `analyze-paper` / schema / migration / RLS / RPC / UI changes. No tests added (Deno Edge Function is not in the Vitest harness).
