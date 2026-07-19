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

## Edit Paper dialog stays open on save failure

**Date:** May 2026
**What:** Fixed a bug where the Edit Paper dialog closed even when the underlying update failed — losing the user's edited form values and giving the impression the save had succeeded. The dialog now stays open and preserves every edited field on any handled failure path, and closes only after the update actually succeeds. Symmetric with the prior "Manual-add dialog UX fix" pattern.
**Root cause:** `usePaperMutations.updatePaper(...)` resolved to `void`. On any handled failure (papers row UPDATE, `set_paper_tags` RPC, or `set_paper_projects` RPC) it rolled back the optimistic cache snapshot, fired a destructive toast, and returned silently. `EditPaperDialog.handleSave()` did `await onSave(...); onOpenChange(false);` with no way to distinguish success from failure, so the dialog always closed.
**Fix:**
- `usePaperMutations.updatePaper` now returns `Promise<boolean>`: `false` for missing `userId` and each handled failure path (UPDATE / tag RPC / project RPC), `true` after every requested write has succeeded. **Rollback behavior, destructive-toast behavior, optimistic-update behavior, abstract cache invalidation on `'abstract' in paperUpdates`, and junction cache invalidation on `tagIds`/`projectIds` change are all preserved verbatim.**
- `EditPaperDialogProps.onSave` is now `Promise<boolean>`. `handleSave()` reads the boolean and only calls `onOpenChange(false)` when it is `true`; on `false` the dialog stays open with every edited form field intact, and the user can correct the issue and retry.
- `Dashboard.handleSavePaper` now forwards the boolean from `updatePaper`. Returns `false` defensively when `editingPaper` is `null` (a state the menu UX should never reach).
- `usePaperAnalysisActions.UsePaperAnalysisActionsArgs.updatePaper` type widened from `Promise<void>` to `Promise<boolean>` so the real mutation drops in without a cast. The hook itself **does not** branch on the returned boolean — its error surface is unchanged (the mutation's own destructive toast still fires on failure during AI flows). This satisfies the rule that callers that do not need the boolean may ignore it.
**Files changed:**
- `src/hooks/papers/usePaperMutations.ts` — `updatePaper` returns `boolean`; new JSDoc explains the contract.
- `src/components/papers/EditPaperDialog.tsx` — `onSave` prop type widened; `handleSave` gates `onOpenChange(false)` on success.
- `src/pages/Dashboard.tsx` — `handleSavePaper` returns `Promise<boolean>` and forwards `updatePaper`'s result.
- `src/hooks/usePaperAnalysisActions.ts` — args-type alignment, no runtime / behavior change.
- `src/hooks/papers/__tests__/usePaperMutations.test.ts` — **6 new tests** covering: `userId` undefined → `false`, field-only update success → `true`, papers row UPDATE failure → `false` + rollback + destructive toast + no subsequent RPCs + no success toast, `set_paper_tags` failure → `false` + rollback + no `set_paper_projects` call + no success toast, `set_paper_projects` failure → `false` + rollback + no success toast, tag-only + project-only update with no paper-row changes → `true` + no row UPDATE call.
- `src/hooks/__tests__/usePaperAnalysisActions.test.ts` — 7 `mockResolvedValue(undefined)` lines for `updatePaper` updated to `mockResolvedValue(true)` so the runtime contract matches the widened type. Behavior unchanged (the AI hook does not consume the return).
**Test counts:** Vitest **263/263** (257 prior + 6 new). Playwright unchanged at **71/71** and intentionally not re-run for this fix — `e2e/mutations.spec.ts` already covers the happy-path "edit → save → dialog closes" mechanic; the new failure-path branch is defensively unit-tested at the hook level rather than via a synthetic Supabase failure injection at the Playwright layer. No new E2E spec was added.
**Verification:** `npx tsc --noEmit` clean, `npx vitest run` 263/263, `npx eslint` on touched files reports only the pre-existing `addPaperManually` `exhaustive-deps` warning that exists on `main` (unrelated to this fix).
**No migration needed.** No DB changes, no RPC changes, no Edge Function changes, no RLS changes.
**Explicit non-goals.** No change to `addPaperManually`, `deletePaper`, `bulkImportPapers`, `bulkImportFromParsedData`, `bulkDeletePapers`, `bulkSetProjects`, `bulkSetTags`, `reevaluateStudyTypes`, `reevaluateKeywords`, AI single / bulk analysis flow, attachments, Quick-Add Drive URL, search, filters, presets, notes UI, or any commercial / billing planning doc.

## Manual add — assignment-failure visibility

**Date:** May 2026
**What:** Closed a silent-failure risk in `usePaperMutations.addPaperManually`. When a manually added paper inserted successfully but the follow-up `set_paper_projects` or `set_paper_tags` RPC failed, the user saw a plain `"Paper added manually"` success toast even though their selected project/tag never got attached — the paper appeared in the library without chips and the user had no way to know an assignment had failed. The fix mirrors the **already-shipped bulk-import warning pattern** (see "Bulk import assignment-failure visibility" entry above).
**Root cause:** `addPaperManually` ignored the `{ error }` returns from the per-paper assignment RPCs:
```ts
if (options?.targetProjectIds && options.targetProjectIds.length > 0) {
  await supabase.rpc("set_paper_projects", { p_paper_id: paperId, p_project_ids: options.targetProjectIds });
}
if (options?.targetTagIds && options.targetTagIds.length > 0) {
  await supabase.rpc("set_paper_tags", { p_paper_id: paperId, p_tag_ids: options.targetTagIds });
}
invalidateAndRefetch();
toast({ title: "Paper added manually" });
return true;
```
The `bulkImportPapers` and `bulkImportFromParsedData` paths in `useBulkMutations.ts` had already adopted an `assignmentWarnings: string[]` accumulator + single destructive toast pattern; the single-paper manual-add path had been left behind.
**Fix:** Capture `{ error: projError }` / `{ error: tagError }` from each RPC, push a short human-readable label (`"project assignment failed"` / `"tag assignment failed"`) into a local `assignmentWarnings: string[]`, and surface **one** destructive toast at the end naming the specific failure(s):
- Full success → existing `"Paper added manually"` toast (unchanged).
- Partial success (any assignment failed) → `"Paper added with warnings"` with `variant: "destructive"` and description `"The paper was added, but <failed assignment(s)> — you may need to assign the project/tag manually."`. The static `"project/tag manually"` suffix is intentional user-guidance; the *variable* failure-label phrasing is what tells the user which specific assignment(s) failed.
- Hard insert failure (`papers` table insert error) → unchanged: destructive `"Error adding paper"` / `"Duplicate paper"` toast and `return false`.
**Return contract:** `addPaperManually` continues to return `Promise<boolean>`. On partial-success it returns `true` because the paper IS created and the dialog should close — the destructive toast plus the missing chips in the row are the user-visible signal that manual reassignment is needed. Hard insert failure still returns `false`. **The return-type contract is unchanged from PR #76; only the toast-fidelity changed.**
**Files changed:**
- `src/hooks/papers/usePaperMutations.ts` — `addPaperManually` captures both RPC errors into `assignmentWarnings`; chooses success-vs-warning toast at the end; new code comment documents the partial-success rationale and points at the bulk-import precedent.
- `src/hooks/papers/__tests__/usePaperMutations.test.ts` — **5 new tests** in a new `describe("usePaperMutations – addPaperManually assignment-failure visibility", …)` block: (1) both assignments succeed → `true` + normal `"Paper added manually"` toast + RPCs called with correct args + invalidate fired + no warning toast; (2) only project assignment fails → `true` + warning toast (variant `"destructive"`, description contains `"project assignment failed"`, **does not** contain `"tag assignment failed"` — the static suffix `"project/tag manually"` is allowed) + no normal success toast; (3) only tag assignment fails → symmetric to (2); (4) both fail → `true` + single warning toast whose description names **both** failures; (5) no assignments requested → `true` + normal success toast + RPCs **not** called.
**Test counts:** Vitest **268/268** (263 prior + 5 new). Playwright unchanged at **71/71** and not re-run for this fix — the failure paths require deterministic Supabase RPC failure injection that isn't available in the current single-real-account harness, and the assertions are stronger at the hook unit level. Same rationale and same precedent as PR #125.
**Verification:** `npx tsc --noEmit` clean, `npx vitest run` 268/268, `npx eslint` on touched files reports only the pre-existing `addPaperManually` `react-hooks/exhaustive-deps` warning that already exists on `main` (untouched by this fix; identical on `main` and on the branch).
**No migration needed.** No DB changes, no RPC changes, no RLS changes, no Edge Function changes.
**Explicit non-goals.** No change to `updatePaper`, `deletePaper`, `bulkImportPapers`, `bulkImportFromParsedData`, `bulkDeletePapers`, `bulkSetProjects`, `bulkSetTags`, `reevaluateStudyTypes`, `reevaluateKeywords`, AI single / bulk analysis flow, attachments, Quick-Add Drive URL, search, filters, presets, notes UI, `AddPaperDialog`'s close-on-true behavior (the partial-success path returns `true` and the dialog still closes by design — symmetric with bulk import), or any commercial / billing planning doc.

## Manual add — server-side duplicate preflight + title-blocking removal

**Date:** May 2026
**What:** Closed two issues in `usePaperMutations.addPaperManually` in one focused fix.
  1. **Data-integrity gap:** the previous duplicate check was a client-side `papers.some(...)` scan against the **currently loaded** (paginated / filtered) papers array. A duplicate that lived outside the current page or filter was missed at preflight; the user could submit a manual add for a paper they already owned and only discover the collision via the post-insert `23505` toast.
  2. **Standing-decision violation:** the same code path additionally did **exact-title hard-blocking** (`existing.title.toLowerCase() === manualTitle.toLowerCase()`), which directly contradicted the **PMID/DOI-only duplicate detection** product decision recorded in `docs/start-here.md` ("Standing product decisions — do not re-propose"). Title-based blocking is now removed from the manual-add path.

**Root cause:**
```ts
const isDuplicate = papers.some((existing) => {
  if (manualPmid && existing.pmid && manualPmid === existing.pmid) return true;
  if (manualDoi && existing.doi && manualDoi.toLowerCase() === existing.doi.toLowerCase()) return true;
  if (manualTitle && existing.title && manualTitle.toLowerCase() === existing.title.toLowerCase()) return true; // ← violates PMID/DOI-only policy
  return false;
});
if (isDuplicate) { toast(...); return false; }
```
`papers` is the React-Query–hydrated paginated/filtered list — never the full library. Even when correct (PMID/DOI rows), the check was scoped to the visible page, not the user's library.

**Fix:** Two sequential narrow server-side preflight queries scoped to the current user via RLS + an explicit `.eq("user_id", userId)`:
```ts
if (manualPmid) {
  const { data: pmidHit, error: pmidErr } = await supabase
    .from("papers").select("id")
    .eq("user_id", userId).eq("pmid", manualPmid)
    .limit(1).maybeSingle();
  if (pmidErr) { /* "Could not check for duplicates" + return false */ }
  if (pmidHit) { /* "Duplicate paper" + return false */ }
}
if (normalizedDoi) {
  const { data: doiHit, error: doiErr } = await supabase
    .from("papers").select("id")
    .eq("user_id", userId).eq("doi", normalizedDoi)
    .limit(1).maybeSingle();
  if (doiErr) { /* "Could not check for duplicates" + return false */ }
  if (doiHit) { /* "Duplicate paper" + return false */ }
}
```
- **Sequential PMID-then-DOI** (not parallel): bail on first hit, keeps mocks simple, avoids PostgREST `.or()` value-escaping edge cases on DOIs containing reserved chars.
- **`.maybeSingle()`**: null is non-error, deterministic given the per-user partial unique indexes (`idx_papers_user_pmid_unique`, `idx_papers_user_doi_unique` on `(user_id, lower(doi))`).
- **DOI normalization** mirrors `src/lib/normalizePaperData.ts:226-227`: strip `https://(dx.)?doi.org/` / `doi:` prefix, lowercase. Matches the form stored behind the per-user partial unique index. Kept inline (one regex line) rather than imported to keep `addPaperManually`'s scope tight; if the two ever drift, the per-user unique index on `lower(doi)` is the backstop.
- **Title-based blocking removed entirely.** A regression test (`does NOT block on title-only match — PMID/DOI-only dedup policy`) explicitly seeds an existing paper with the SAME title but different PMID + DOI and asserts the manual add proceeds. This brings the manual-add path into compliance with the standing PMID/DOI-only policy.

**Backstop unchanged.** The post-insert `23505` branch still fires, with the existing `"Duplicate paper (duplicate PMID or DOI)"` toast and `return false`, covering races between the preflight and the insert (two tabs, network re-order, etc.). The preflight is a UX improvement layered on top of the DB constraint — not a replacement for it.

**Preflight-failure handling.** If the preflight query itself returns an error (network outage, RLS misconfiguration, etc.), `addPaperManually` returns `false` and surfaces a destructive `"Could not check for duplicates"` toast. The function does NOT proceed to insert when the duplicate check could not be performed. This is symmetric with the PR #125 design principle ("server-side checks are the truth").

**`useCallback` deps cleanup.** Because the closure no longer reads the loaded `papers` array, `papers` was removed from the `addPaperManually` deps array. `projects` / `tags` / `queryClient` remain (pre-existing unused deps flagged by `react-hooks/exhaustive-deps`); they are deliberately untouched here to keep this PR strictly focused on the duplicate-detection bug. The lint warning correspondingly drops from 4 unnecessary deps to 3.

**Carried-forward audit finding (NOT fixed in this PR).** `useBulkMutations.ts:49-59` has an isomorphic title-blocking + loaded-array scan in the identifier-based bulk-import path. Same product-decision violation, same loaded-array limitation. The bulk path's per-paper insert + downstream `safe_bulk_insert_papers` RPC still catches true PMID/DOI duplicates at the DB layer, so **data integrity is intact**; only UX consistency is at stake. Not fixed here per the task's bulk-import scope guard.

**Files changed:**
- `src/hooks/papers/usePaperMutations.ts` — replaced the inline `papers.some(...)` block (lines 56–66 on `main`) with the two server-side preflight queries + DOI-normalization helper + `preflightFailureToast` / `duplicateToast` closures; removed `papers` from the `useCallback` deps array; new code comments document the change rationale and the backstop relationship.
- `src/hooks/papers/__tests__/usePaperMutations.test.ts` — **8 new tests** in a new `describe(\"usePaperMutations – addPaperManually server-side duplicate preflight\", …)` block (PMID hit even when loaded array empty; DOI hit when PMID misses; DOI normalization lowercases + strips URL prefix; no preflight when both identifiers absent; insert when preflight misses; preflight failure on PMID surfaces destructive "Could not check for duplicates"; same on DOI; **title-only match does NOT block** — PMID/DOI-only policy regression test). Plus **rewrote** the existing `returns false for duplicate paper (matching PMID)` test to use the server-side preflight mechanism instead of the removed loaded-array scan; renamed to `... — via server-side preflight`. Extended the hoisted Supabase mock with a `from("papers").select("id").eq().eq().limit(1).maybeSingle()` chain (`mockPreflightTopSelect` / `mockPreflightFirstEq` / `mockPreflightSecondEq` / `mockPreflightLimit` / `mockPreflightMaybeSingle`).
**Test counts:** Vitest **268/268 → 276/276** (+8 new; +0 net for the rewritten test). Playwright unchanged at **71/71** and not re-run for this fix — the preflight branches require deterministic Supabase RPC failure injection that isn't available in the single-real-account E2E harness, and the assertions are stronger at the hook unit level. Same rationale and same precedent as PRs #125 / #126.
**Verification:** `npx tsc --noEmit` clean. `npx vitest run` 276/276. `npx eslint` on touched files reports only the same pre-existing `addPaperManually` `react-hooks/exhaustive-deps` warning — now listing `'projects', 'queryClient', and 'tags'` instead of `'papers', 'projects', 'queryClient', and 'tags'` (partial improvement, the `papers` dep cleanup was needed for correctness).
**No migration needed.** No DB changes, no RPC changes, no RLS changes, no Edge Function changes. The existing partial unique indexes (`idx_papers_user_pmid_unique`, `idx_papers_user_doi_unique` on `(user_id, lower(doi))`) and the existing post-insert `23505` handling are both leveraged unchanged.
**Explicit non-goals.** No change to `updatePaper`, `deletePaper`, `bulkImportPapers`, `bulkImportFromParsedData`, `bulkDeletePapers`, `bulkSetProjects`, `bulkSetTags`, `reevaluateStudyTypes`, `reevaluateKeywords`, AI flows, attachments, Quick-Add Drive URL, search, filters, presets, notes UI, `AddPaperDialog`, `Dashboard`, or any commercial / billing planning doc. The `addPaperManually` return-type contract (`Promise<boolean>`) is unchanged from PR #76 / PR #126. The assignment-warning behavior from PR #126 is preserved verbatim.

## Bulk-import duplicate/title-blocking audit — dead-code removal

**Date:** May 2026
**What:** Closed out the PR #127 follow-up finding (recorded in the prior "Manual add — server-side duplicate preflight + title-blocking removal" entry above) that flagged `useBulkMutations.ts:49-59` for an isomorphic title-blocking + loaded-array dedup violation. A focused audit of the bulk-import paths found that **the live paths were already compliant** and the offending code lived inside a **dead function**. This PR removes the dead code outright; no live behavior changes.
**Root cause:** `useBulkMutations.ts` contained three bulk functions but only two were live:
- `bulkImportPapers` (lines 138–328 on `main`) — wired to `Dashboard.onBulkImport` via `AddPaperDialog`. Uses `safe_bulk_insert_papers` RPC in chunks of 50. **No client-side dedup prefilter, no title-blocking.**
- `bulkImportFromParsedData` (lines 330–476 on `main`) — wired to `Dashboard.onFileImport`. Same architecture as `bulkImportPapers`. **No client-side dedup prefilter, no title-blocking.**
- `addPapers` (lines 32–135 on `main`) — the legacy function that PR #127's follow-up note flagged. Client-side `papers.some(...)` scan against the paginated/filtered loaded array, with exact-title hard-blocking (after `.replace(/\.\s*$/, \"\").trim().toLowerCase()`), then per-paper `INSERT` via PostgREST with a `23505` catch. Returned from `useBulkMutations` and re-exported from `usePapers()`, **but never destructured by any UI component or test.** Repo-wide `grep -rn '\baddPapers\b'` showed exactly four references: the declaration, the `useBulkMutations` return-object entry, the `usePapers` destructure, and the `usePapers` return-object entry. Zero call sites.
**Fix:** Delete the dead `addPapers` function rather than refactor it. The function violated the standing PMID/DOI-only product decision (see `docs/start-here.md` "Standing product decisions"), had no consumer, had no tests, and would have required a `bulkImportPapers`-parity refactor (chunked RPC, server-side dedup, etc.) to even be safe to ship. Deletion is strictly safer than refactor for unused code.
**Files changed:**
- `src/hooks/papers/useBulkMutations.ts` — deleted the `addPapers` `useCallback` block (lines 32–136); removed `addPapers` from the returned object (line 709 on `main`). No other identifiers became unused — every import (`fetchPaperMetadata`, `getErrorMessage`, `useCallback`, `Paper`, `PaperWithTags`, etc.) is still referenced by `bulkImportPapers` / `bulkImportFromParsedData` / `bulkDeletePapers` / `reevaluateStudyTypes` / `reevaluateKeywords`. The `papers: PaperWithTags[]` constructor parameter remains — it is still used elsewhere in the file (e.g., by re-evaluation paths).
- `src/hooks/usePapers.ts` — removed `addPapers` from the `useBulkMutations(...)` destructure (line 290 on `main`) and from the object returned by `usePapers()` (line 358 on `main`). All other returned values are untouched.
**Data integrity unchanged.** `safe_bulk_insert_papers`, `idx_papers_user_pmid_unique`, and `idx_papers_user_doi_unique (user_id, lower(doi))` are all leveraged by the live paths exactly as before. No DB path was at risk of inserting a true duplicate before this PR, and none is after.
**Test counts:** Vitest **276/276 → 276/276** (unchanged — no test referenced `addPapers`). Playwright unchanged at **71/71** and not re-run for this dead-code removal — no live UI behavior changed.
**Verification:** `npx tsc --noEmit` clean. `npx vitest run` 276/276. `npx eslint` on the two touched source files: **0 errors, 2 warnings** — the 2 are the pre-existing `bulkImportPapers` / `bulkImportFromParsedData` `react-hooks/exhaustive-deps` warnings (`'projects', 'queryClient', and 'tags'` on each), untouched. **Pre-PR baseline was 3 warnings**; the `addPapers`-specific warning at the old line 135 is now gone with the function. Net **−1 lint warning, zero new warnings**.
**No migration needed.** No DB changes, no RPC changes, no RLS changes, no Edge Function changes.
**Explicit non-goals.** No change to `bulkImportPapers`, `bulkImportFromParsedData`, `safe_bulk_insert_papers`, `bulkDeletePapers`, `bulkSetProjects`, `bulkSetTags`, `reevaluateStudyTypes`, `reevaluateKeywords`, `addPaperManually`, `updatePaper`, `deletePaper`, AI flows, attachments, search, filters, presets, notes UI, `AddPaperDialog`, `Dashboard`, commercial / billing / mobile / store-readiness docs, or any architecture decision in `docs/decisions-and-triggers.md` (the existing PMID/DOI-only product decision is honored, not redefined). No fuzzy matching introduced; no title-based duplicate blocking re-introduced in any path.

## Docs realignment — `architecture-read-path.md` post-PR #87/#88/#91/#92

**Date:** May 2026
**What:** Docs-only realignment of `docs/architecture-read-path.md` with the current search / read-path implementation. Closes out the search-doc consistency audit. No code, SQL, RPC, migration, Edge Function, schema, or behavior change. Same precedent as PR #94 ("Docs normalization for the search wave").
**Why:** The "Full-text search" subsection still described an older path — `search_vector @@ websearch_to_tsquery('english', term)` as a direct query — that was superseded by:
- **PR #87** (`20260417020000_add_notes_to_search.sql`) — added `notes` to `search_vector` at weight D and to the short-search ILIKE path.
- **PR #88** (`20260417030000_prefix_search.sql`) — replaced `websearch_to_tsquery` with a prefix-aware tokenization in the `search_papers` RPC (strip 10 tsquery operators, whitespace-split, append `:*`, `&`-join, `to_tsquery('english', …)`). Unicode preserved. Explicit `OR` / `-` exclusion intentionally dropped.
- **PR #91** (`20260420010000_keywords_in_search_with_attribution.sql`) — added `keywords::text` to `search_vector` at weight C; rebuilt both `search_papers` and `search_papers_short` to return six per-field `matched_*` booleans (server-driven "Matched in: …" attribution).
- **PR #92** — added quoted phrase mode (`useFilterState.ts` routes `"…"` to `search_papers_short` with the inner phrase wrapped in `%…%`), no new SQL.

The README "Current search behavior" and `docs/start-here.md` "Current search behavior — at a glance" sections were already accurate (added in the PR #94 normalization pass); only `architecture-read-path.md` had not been refreshed since the older `websearch_to_tsquery` path. This entry closes that gap.

**Files changed:**
- `docs/architecture-read-path.md` — (a) added `notes` to the papers list `SELECT columns` line; (b) added `notesPresence` to the `ServerFilterParams` field list with its tri-state `"all"` / `"has"` / `"none"` semantics and a one-line note on `applyFilterPredicates`' POSIX-regex `match` predicates; (c) replaced the "Full-text search" subsection with a 4-mode search table (empty / short ILIKE / prefix-aware FTS / quoted phrase) plus a concise prefix-tokenization paragraph that explicitly states `websearch_to_tsquery` is NOT used; (d) documented the six searched fields and the `search_vector` weight ladder (A=title, B=abstract, C=journal+authors+keywords, D=notes); (e) added a new "Matched-field attribution" subsection covering the six `matched_*` flags, the `MatchFlags` Map, the fixed UI order (Title → Abstract → Authors → Journal → Notes → Keywords), and the server-driven rule. References migrations `20260417020000` / `20260417030000` / `20260420010000` inline where useful.

**Test counts:** Vitest unchanged at **276/276**. Playwright unchanged at **71/71**. Neither was re-run for this docs-only change.

**Verification:** `git diff --stat` shows changes only under `docs/`. No source / SQL / config / dependency files touched. No markdown lint tool exists in the repo (`package.json` declares only `"lint": "eslint ."`); skipped accordingly.

**No migration.** No DB / RPC / RLS / Edge Function changes.

**Explicit non-goals.** `README.md` was not updated — it already carried the accurate "Current search behavior" copy and Vitest count is unchanged. `docs/start-here.md` was not updated — the "Current search behavior — at a glance" section there is already aligned; no handoff note added to keep the change strictly narrow. `docs/decisions-and-triggers.md` was not updated — no new architecture decision. No commercial / billing / mobile / store-readiness doc was touched. No code, no SQL, no migration, no Edge Function, no test, no dependency change in this PR.

## Local migration replay — schema-drift + immutability fix wave

**Date:** May 2026
**What:** Made the full migration chain replayable from scratch via `supabase start` / `supabase db reset`. Five distinct issues blocked a clean replay; each is addressed here without changing production behavior. The work landed before any further DB migration (notably PR #130's `auth.uid()` RPC ownership hardening, which sits at `20260518010000`) so future migrations can be validated locally before deploy.
**Why:** Until this wave, `supabase db reset` failed three times in a row at three different migrations. Local validation of every migration since `20260305020000` had been impossible without ad-hoc patches. The root causes accumulated over time as production schema diverged from the migration files via Supabase/Lovable dashboard edits.

### Issue 1: `to_tsvector` immutability rejection on `search_vector` generated column

**Where:** the `GENERATED ALWAYS AS (...) STORED` clause in `20260305020000_add_full_text_search.sql`, plus the two later rebuilds in `20260417020000_add_notes_to_search.sql` and `20260420010000_keywords_in_search_with_attribution.sql`.
**Root cause:** PostgreSQL requires generated-column expressions to be IMMUTABLE. The two-argument `to_tsvector(text, text)` overload is STABLE (the first argument requires a `text → regconfig` resolution at call time), and `'english'::regconfig` alone was not sufficient on newer Postgres versions. Additionally, `jsonb_out` / `array_out` (used implicitly when casting jsonb or text[] to text) is STABLE, so `coalesce(authors::text, '')` is STABLE end-to-end even with the regconfig cast.
**Fix:** introduce two explicitly-IMMUTABLE wrapper functions in `20260305020000_add_full_text_search.sql`:
- `immutable_english_tsvector_text(text)` — for scalar text columns (title, abstract, journal, notes).
- `immutable_english_tsvector_jsonb(jsonb)` — for jsonb columns (authors, keywords, mesh_terms, substances).
- `immutable_english_tsvector_textarr(text[])` — companion wrapper kept for the pre-conversion path (see Issue 4 below); `20260305020000`'s generated column uses it because columns are still `text[]` at that point in history.

The wrapper bodies still call the underlying STABLE functions; the IMMUTABLE declaration is the standard documented Postgres workaround for this exact problem. Tsvector contents produced are byte-identical to the prior form — search ranking, GIN index contents, and `matched_*` attribution are unchanged.

### Issue 2: `setval(seq, 0)` rejected on empty `papers` table

**Where:** `20260326000000_add_insert_order_column.sql` line 25.
**Root cause:** The migration's final statement `SELECT setval('papers_insert_order_seq', COALESCE((SELECT MAX(insert_order) FROM papers), 0))` falls back to `0` on an empty table. PostgreSQL sequences have a minimum value of `1`, so `setval(seq, 0)` raises `value 0 is out of bounds`. Production hit `MAX(insert_order) ≥ 1` at migration time (the table had data), so the latent bug was never exercised there.
**Fix:** switch to the 3-arg form `setval(seq, COALESCE(MAX, 1), EXISTS(SELECT 1 FROM papers))`. When rows exist the behavior is bit-identical to the original (next `nextval()` returns `MAX+1`). When the table is empty, `setval(seq, 1, false)` means the next `nextval()` returns `1`.

### Issue 3: `authors`/`keywords`/`mesh_terms`/`substances` schema drift (text[] → jsonb)

**Where:** column-type mismatches across the late-March / April 2026 migrations.
**Root cause:** Production altered all four columns from `text[]` to `jsonb` via the Supabase/Lovable dashboard between the March RPC wave (which used `unnest(text[])`) and the April RPC wave (which uses `jsonb_array_elements_text(jsonb)` and `COALESCE(col, '[]'::jsonb)`). No migration captured the conversion. The drift was hinted at in code comments — `20260330010000_add_raw_keywords_column.sql` literally states "The keywords column is jsonb in the live database (altered from text[] by Supabase/Lovable)" — but never fixed in the repo. Fresh local replays diverged from production schema, breaking the April-onwards migrations.
**Fix:** new migration **`20260331010000_convert_columns_to_jsonb.sql`**, placed between the March and April waves. It:
1. Drops `search_vector` (depends on `authors`).
2. Conditionally converts the four columns from `text[]` to `jsonb` via an `information_schema.columns` probe — runs only when the column is still `text[]` (fresh local replay). On production (columns already `jsonb`) the `DO` block is a no-op.
3. Re-sets jsonb defaults (`'[]'::jsonb`).
4. Re-adds `search_vector` using the `immutable_english_tsvector_jsonb` wrapper.
5. Recreates the GIN index.

The two later search_vector rebuilds (`20260417020000_add_notes_to_search.sql` and `20260420010000_keywords_in_search_with_attribution.sql`) were updated to use the `_jsonb` wrapper for `authors` (and for `keywords` in 20260420) since the columns are jsonb from `20260331010000` forward.

### Issue 4: `raw_keywords = keywords` assignment-cast type mismatch

**Where:** `20260330010000_add_raw_keywords_column.sql` line 14.
**Root cause:** the UPDATE assigns `text[]` to a `jsonb` column on local fresh replay. PostgreSQL assignment-casts do not implicitly convert `text[]` to `jsonb`, and direct `text[]::jsonb` is rejected ("cannot cast type text[] to jsonb").
**Fix:** wrap the RHS in `to_jsonb(keywords)`. `to_jsonb` accepts any input type — for `text[]` it returns the equivalent jsonb array; for jsonb it is identity. Works under both local (pre-conversion) and production (post-conversion) shapes.

### Issue 5: leftover Supabase CLI local-state directory

**Where:** `supabase/.branches/` created by `supabase start`.
**Fix:** added to `.gitignore` alongside the existing `supabase/.temp/` entry. Local-only state; should never be committed.

### Files changed

- `supabase/migrations/20260305020000_add_full_text_search.sql` — added the three wrapper functions; generated column now uses `_textarr(authors)` (text[] at this point).
- `supabase/migrations/20260326000000_add_insert_order_column.sql` — switched `setval` to the 3-arg form; added clarifying comment.
- `supabase/migrations/20260330010000_add_raw_keywords_column.sql` — `keywords` → `to_jsonb(keywords)` in the backfill UPDATE; added clarifying comment.
- `supabase/migrations/20260331010000_convert_columns_to_jsonb.sql` — **new** migration capturing the schema drift; idempotent via `information_schema` probe.
- `supabase/migrations/20260417020000_add_notes_to_search.sql` — generated column switched to `_jsonb(authors)`.
- `supabase/migrations/20260420010000_keywords_in_search_with_attribution.sql` — generated column switched to `_jsonb(authors)` and `_jsonb(keywords)`. Additionally, the **six `matched_*` per-field attribution expressions** inside the `search_papers` RPC body (which run inside a `SELECT` and were not subject to the IMMUTABLE check) were also updated from bare `to_tsvector('english', …)` to `to_tsvector('english'::regconfig, …)`. These six lines were operationally fine before the edit (STABLE is acceptable inside `SELECT`) — the change is for consistency so every `to_tsvector(...)` call in the three migrations uses `::regconfig` (either directly in the RPC body or via the IMMUTABLE wrapper for generated columns). Tsvector outputs are byte-identical; ranking and `matched_*` attribution behavior unchanged.
- `.gitignore` — added `supabase/.branches/`.

### Production impact

**For each modified historical migration**, the edit either:
- Adds new objects via `CREATE OR REPLACE FUNCTION` (the three immutability wrappers) — production gets the wrappers when the new conversion migration runs.
- Changes only the syntactic form of an expression that is bit-equivalent at runtime (the wrapper-call rewrites of `to_tsvector('english', x)`; the `setval` 3-arg form when rows exist; the `to_jsonb(keywords)` form when `keywords` is already jsonb). Production's existing applied state is unaffected — Supabase tracks already-applied migrations by version and doesn't re-run them.

**The new conversion migration `20260331010000`** will be applied to production once via `supabase db push`. The DO-block conditional means it is a structural no-op for the four columns (they're already jsonb on production). The migration's net effect on production is: drop+recreate `search_vector` using the wrapper functions, and recreate the GIN index. Same tsvector contents, same search behavior — only the underlying parse-tree expression changes (and the wrappers are added).

**`search_vector` is briefly absent during the transaction** for both production and local replay. Supabase migrations run inside a transaction so the window is one transaction long (sub-second at current row count). For a single-user app this is effectively no downtime. Same risk profile as PR #91 (`20260420010000`) which also dropped+recreated `search_vector` with no incident.

### Verification

- **`supabase start` ran clean.** All 56 migration files applied successfully end-to-end. The migration ledger contains every version from `20260203072053` through `20260421010000`, including the new `20260331010000`.
- **Schema check (via `docker exec ... psql`):** `papers.authors / keywords / mesh_terms / substances` are all `jsonb` post-replay. `search_vector` exists as `tsvector`. `has_abstract`, `insert_order`, `notes`, `raw_keywords`, `tldr` all present.
- **Function inventory check:** 16 expected functions exist, including the three new `immutable_english_tsvector_*` wrappers and every RPC the application needs (`search_papers`, `search_papers_short`, `filter_papers_by_keywords`, `get_keyword_options`, `safe_bulk_insert_papers`, `set_paper_tags`, `set_paper_projects`, `bulk_set_paper_tags`, `bulk_set_paper_projects`, `bulk_update_keywords`, `bulk_update_study_types`, `get_duplicate_papers`, `merge_exact_duplicates`).
- **`npx tsc --noEmit`** clean (no source code changed; only migrations).
- **`npx vitest run`** 276/276 (unchanged).
- **Playwright** not re-run from this branch — no client-side behavior change. Suite stands at 71/71 on `main`.

### Deploy-safety audit (required reading before applying to production)

**Q1: Will `supabase db push` apply `20260331010000` cleanly to the linked remote even though later migrations (e.g. `20260420010000`, `20260421010000`) are already applied?**

**Yes, but only with the `--include-all` flag** (or equivalent). `supabase db push --help` documents the flag as: *"Include all migrations not found on remote history table."* The default behavior of `db push` is to apply migrations whose version is **newer than the latest version already in the remote `supabase_migrations.schema_migrations` ledger**. A new migration with a timestamp earlier than the latest applied version is treated as "out of order" and is skipped without the flag.

`20260331010000` has a timestamp earlier than `20260417010000` / `20260420010000` / `20260421010000`, which are already on production. The flag is required.

**Q2: Does Supabase CLI allow applying a newly-added migration whose timestamp is earlier than already-applied remote migrations?**

**Yes, via `--include-all`.** Supabase's migration ledger is content-addressed by `version` (the timestamp prefix), not by sequential ordering. Once `20260331010000` is applied, the ledger contains it alongside the later versions; subsequent `db push` runs see it as already applied and won't try to re-run it.

**Q3: Does this require `supabase migration repair`, additional commands, or any special sequence?**

**No `repair` is needed.** `supabase migration repair` is the tool for marking migrations as applied / reverted in the ledger **without running their SQL** — it's used when SQL was applied manually outside the migration system, or when an applied migration needs to be marked as reverted. **Neither situation applies here.** We genuinely want the SQL of `20260331010000` to be executed against production (to create the IMMUTABLE wrappers and to drop + re-add `search_vector` with the wrapper-based generated expression). The single `--include-all` flag is sufficient.

**Q4: If you cannot verify this safely without applying changes, the safest deployment sequence is:**

The CLI session that produced this audit was not linked to the remote Supabase project (no `supabase link` had been run, and the auth credentials necessary to link are not in this environment). The recommended deployment sequence — to be executed by the project owner with appropriate credentials, **in this exact order** — is:

1. **Link the project (one-time, if not already linked):**
   ```sh
   supabase link --project-ref <project-ref>
   ```

2. **Dry-run the push first — observe what would change without applying:**
   ```sh
   supabase db push --dry-run --include-all
   ```
   Expected output: the CLI lists `20260331010000_convert_columns_to_jsonb.sql` as the only pending migration. If it lists anything else (e.g. one of the patched historical migrations re-appearing as pending), **stop and investigate** — Supabase tracks already-applied migrations by version, not by content, so the historical edits should not produce pending entries.

3. **Apply for real:**
   ```sh
   supabase db push --include-all
   ```

4. **Verify post-apply:**
   ```sh
   supabase migration list --linked
   ```
   Expected: `20260331010000` is now in the remote ledger.

5. **Smoke-test:** in the dashboard or via the running app, run a normal search query. Confirm results render and `Matched in: …` chips display. The tsvector contents are byte-identical to pre-migration, so behavior should be indistinguishable.

**Rollback note.** If the migration fails partway, Supabase migrations run inside a transaction — the entire migration is rolled back atomically. The remote state would revert to "before `20260331010000`", with the original `search_vector` column still in place. No partial-state risk.

**Q5: Non-destructive command run.** `supabase migration list` was attempted in this session; it failed with `Cannot find project ref. Have you run supabase link?`, confirming the session is not linked. The flag inventory (`supabase db push --help`) was inspected and is the basis of the answers above. The user should run `supabase migration list --linked` and `supabase db push --dry-run --include-all` against their actual linked project before the real push.

### Self-contained migration: wrappers re-declared in `20260331010000`

A critical deploy-safety issue surfaced during this audit and was fixed in the migration file:

The original draft of `20260331010000` relied on the three `immutable_english_tsvector_*` wrapper functions being defined by `20260305020000_add_full_text_search.sql`. That works for fresh local replays (where `20260305020000` runs with the wrapper-augmented content). But **production already applied `20260305020000` with its original, pre-wrapper content** — and Supabase's migration ledger tracks it as applied, so the wrappers will not exist on production when `20260331010000` runs there.

**Fix:** `20260331010000` now re-declares all three wrappers at the top of its body via `CREATE OR REPLACE FUNCTION`. On a fresh local replay the re-declaration is a no-op (the functions exist with identical bodies); on production it is the first definition. The migration is fully self-contained — it can stand alone on any database that has the `papers` table.

### How to verify remote column types

Run this query in Supabase Studio's SQL editor (or via any psql client against the linked project) to confirm `papers.authors`, `papers.keywords`, `papers.mesh_terms`, and `papers.substances` are all `jsonb` (as expected per the schema-drift assumption that this migration captures):

```sql
SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'papers'
  AND column_name IN ('authors', 'keywords', 'mesh_terms', 'substances')
ORDER BY column_name;
```

**Expected on production (current):**

```
 column_name | data_type | udt_name
-------------|-----------|---------
 authors     | jsonb     | jsonb
 keywords    | jsonb     | jsonb
 mesh_terms  | jsonb     | jsonb
 substances  | jsonb     | jsonb
```

If any of the four rows shows `data_type = 'ARRAY'` instead of `jsonb`, **the schema-drift assumption is wrong for that environment** and the production state does not match what was assumed. In that case, the conditional `DO` block in `20260331010000` will detect the array type and run the conversion. Either way the migration is safe (the conditional handles both states) — but the audit assumption (production is already `jsonb`) should be re-verified before the push.

### Future-migration testing now works

After this migration applies in production, future migrations (PR #130's `20260518010000_rpc_auth_uid_ownership_check.sql` is the first beneficiary) can be validated locally via `supabase db reset` before being applied to production. This is the first time since the late-March / April 2026 schema drift that local migration replay has been viable.

### Non-goals

- **No source code changed.** Frontend, hooks, components, tests untouched.
- **No commercial / billing / mobile / store-readiness changes.** Commercial planning docs untouched.
- **No RLS policy changes.** The existing FORCE-RLS posture on `papers` and downstream tables is unchanged.
- **No Edge Function changes.** `analyze-paper` and `fetch-paper-metadata` untouched.
- **No change to PR #130's pending migration.** PR #130 sits on its own branch and is unaffected by this work; once both PRs land, PR #130 will also replay cleanly locally.
- **No fuzzy matching introduced; no title-based duplicate blocking re-introduced.**
- **No changes to `search_papers` / `search_papers_short` / `filter_papers_by_keywords` / `get_keyword_options` function bodies beyond what was strictly required for the schema drift.** Per-field `matched_*` attribution, prefix-aware tokenization, AND-semantics keyword filter, and ORDER BY behavior are all bit-identical to pre-PR.

## `20260331010000` made production-safe after remote ledger-drift reconciliation

**Date:** May 2026 (immediately follows PR #131).
**What:** Urgent follow-up correction to `supabase/migrations/20260331010000_convert_columns_to_jsonb.sql`. The version merged in PR #131 had a **latent production regression risk** that surfaced during the post-merge remote reconciliation audit. This patch makes the entire schema-mutation portion of the migration conditional on the columns still being `text[]`, so production (where columns are already `jsonb`) is left strictly alone except for the addition of three IMMUTABLE wrapper functions.

**Why:** A post-merge `supabase migration list --linked` revealed that the remote `supabase_migrations.schema_migrations` ledger is missing entries for **five April 2026 migrations** whose SQL effects are nevertheless present in the production schema:

| Version | File | Effect verified present on remote |
|---|---|---|
| `20260417010000` | `add_notes_column.sql` | `papers.notes text NULL` exists |
| `20260417020000` | `add_notes_to_search.sql` | `search_vector` references `notes` (weight D) |
| `20260417030000` | `prefix_search.sql` | `search_papers` RPC uses prefix-aware tokenization |
| `20260420010000` | `keywords_in_search_with_attribution.sql` | `search_vector` references `keywords` (weight C); `search_papers` / `search_papers_short` return six `matched_*` booleans |
| `20260421010000` | `add_filter_presets.sql` | `filter_presets` table exists with 6 columns |

This is the same Supabase/Lovable-dashboard schema-drift pattern that produced the `text[] → jsonb` divergence captured by PR #131 in the first place. The conclusion of the audit was unambiguous: **production schema is fully up-to-date with the application code; only the ledger has drifted.**

**The latent bug:** the version of `20260331010000` merged in PR #131 unconditionally dropped `search_vector` and re-added it with **only four fields** (title / abstract / journal / authors — no `notes`, no `keywords`). On local fresh replay this is fine because later migrations (`20260417020000`, `20260420010000`) rebuild `search_vector` to the final six-field shape. But the production deploy plan uses `supabase migration repair --status applied <version>` to record the five April migrations as applied **without re-running their SQL** — meaning those later migrations would NOT rebuild `search_vector` on production. The unconditional DROP/ADD would therefore have **permanently lost `notes` and `keywords` from production's FTS**.

**The fix:** wrap the `DROP COLUMN search_vector`, the `ALTER COLUMN ... TYPE jsonb USING to_jsonb(...)` block, the `ADD COLUMN search_vector ... GENERATED ALWAYS AS (...)` clause, and the `CREATE INDEX idx_papers_search_vector` inside the existing `IF v_data_type = 'ARRAY'` conditional. The wrappers stay unconditional at the top of the file (they're CREATE OR REPLACE so they're idempotent on local and additive on production).

**Net behavior after the fix:**

| Path | What runs | What changes |
|---|---|---|
| Fresh local replay (`data_type = 'ARRAY'`) | Wrappers created; DROP search_vector; convert 4 columns to jsonb; re-ADD search_vector with 4-field shape (authors via `_jsonb` wrapper); recreate GIN index | Local schema converges to jsonb. Later migrations `20260417020000` and `20260420010000` rebuild `search_vector` to its final 6-field shape. |
| Production (`data_type = 'jsonb'`) | Wrappers created. Entire conditional block skipped. | Three new helper functions in `public` schema. **`search_vector` and its GIN index are untouched** — production's existing 6-field generated column (`to_tsvector('english'::regconfig, …)` over title / abstract / journal / authors / keywords / notes) stays exactly as-is. |

**Files changed (in this follow-up):**

- `supabase/migrations/20260331010000_convert_columns_to_jsonb.sql` — restructured. The wrapper-function declarations and the `DO $$ … END $$` block are the only top-level statements. All schema mutation (DROP / ALTER TYPE / ADD / CREATE INDEX) is inside the `IF v_data_type = 'ARRAY'` branch.
- `docs/migration-history.md` — this entry.
- `docs/start-here.md` — handoff note updated so future sessions follow the corrected deployment plan instead of PR #131's original plan.

**Verification (local):**

- `supabase stop --no-backup; supabase start` — exit 0. All 56 migration files applied end-to-end.
- Migration ledger count: **56** (matches `ls supabase/migrations/*.sql | wc -l`).
- Final `papers` column types: `authors`, `keywords`, `mesh_terms`, `substances` all `jsonb`; `search_vector` is `tsvector`.
- Final `search_vector` generation expression: **all six fields present** (title / abstract / journal / authors / keywords / notes), via the wrapper functions, with weights A / B / C / C / C / D.
- All three wrapper functions present: `immutable_english_tsvector_text`, `immutable_english_tsvector_textarr`, `immutable_english_tsvector_jsonb`.
- `npx tsc --noEmit` clean.
- `npx vitest run` 276/276 unchanged.

### Corrected remote deployment plan

> ⚠️ **Replace the original PR #131 plan with this one.** The PR #131 plan said "`supabase db push --include-all`" applies only `20260331010000`. That is now incorrect on two counts: (a) the dry-run showed `db push --include-all` would also try to re-apply the five April migrations whose SQL is already applied; (b) `20260331010000`'s previous unconditional `search_vector` rebuild would have regressed production FTS.

**The safe deploy sequence, in this exact order:**

```sh
# Phase 1 — Reconcile the ledger drift.
# `supabase migration repair --status applied <version>` writes the version into
# `supabase_migrations.schema_migrations` WITHOUT running the migration's SQL.
# This is the documented Supabase mechanism for recording out-of-band schema
# changes that were applied via the dashboard.
supabase migration repair --status applied 20260417010000
supabase migration repair --status applied 20260417020000
supabase migration repair --status applied 20260417030000
supabase migration repair --status applied 20260420010000
supabase migration repair --status applied 20260421010000

# Phase 2 — Verify reconciliation.
supabase migration list --linked
#   Expected: the five April versions now have populated Remote columns.
#   Only 20260331010000 should remain in the Local-only state.

# Phase 3 — Dry-run the remaining push.
supabase db push --dry-run --include-all
#   Expected: lists exactly one pending migration:
#     supabase/migrations/20260331010000_convert_columns_to_jsonb.sql
#   If anything else is listed, STOP and investigate.

# Phase 4 — Apply 20260331010000.
supabase db push --include-all

# Phase 5 — Verify on production.
supabase migration list --linked
#   Expected: 20260331010000 now in the remote ledger; all 56 versions present.
```

**Phase 5 — schema verification queries** (run in Supabase Studio SQL editor against the linked production project):

```sql
-- (A) Confirm the three wrapper functions now exist on production.
SELECT proname
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN (
    'immutable_english_tsvector_text',
    'immutable_english_tsvector_textarr',
    'immutable_english_tsvector_jsonb'
  )
ORDER BY proname;
-- Expected: 3 rows.

-- (B) Confirm search_vector is STILL the six-field form (unchanged by 20260331010000).
SELECT pg_get_expr(adbin, adrelid) AS search_vector_expr
FROM pg_attrdef ad
JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
WHERE a.attname = 'search_vector'
  AND a.attrelid = 'public.papers'::regclass;
-- Expected: byte-identical to the pre-deploy form — contains references to
-- title, abstract, journal, (authors)::text, (keywords)::text, AND notes.
-- The expression should NOT use the wrapper functions on production (production
-- created search_vector inline before the wrappers existed; the wrappers are
-- now defined but unused on production).

-- (C) Smoke-test (in the running app):
--   • Run a normal search query — confirm results render.
--   • Confirm "Matched in: …" chips display for matching rows.
--   • Confirm filter presets save / load.
-- All should be indistinguishable from pre-deploy.
```

**If any of the Phase 5 queries returns unexpected output, STOP and report — do not attempt to fix forward without a new audit.**

**Rollback safety:** the migration runs inside a transaction; if `20260331010000` fails partway through, the whole migration is atomically rolled back and the wrappers are not added. Production state reverts to "before `20260331010000`" with the six-field `search_vector` intact. The five repair entries in the ledger remain (they were written by separate `migration repair` calls and do not roll back with the failed `db push`), so subsequent `migration list --linked` would still show the five April versions as applied. That's still the desired end-state.

**Non-goals carried over from PR #131** (all still apply): no frontend code, no Edge Functions, no RLS, no commercial / billing / mobile / store changes, no RPC return-shape changes, no PR #130 migration changes. The only delta from PR #131 is the structural fix inside `20260331010000` and the corrected deployment plan above.

## SECURITY DEFINER RPC ownership enforcement (server-side defense-in-depth)

**Date:** May 2026
**What:** Server-side hardening migration `20260518010000_rpc_auth_uid_ownership_check.sql` recreates four `SECURITY DEFINER` RPCs to enforce that the client-supplied `p_user_id` matches `auth.uid()`. Closes a confirmed defense-in-depth gap surfaced by the Production-Hardening audit.
**Functions hardened:**
- `search_papers(UUID, TEXT, INTEGER, INTEGER)`
- `search_papers_short(UUID, TEXT)`
- `filter_papers_by_keywords(UUID, TEXT[])`
- `get_keyword_options(UUID, UUID[], INT, INT, TEXT[])`
**Why:** Each function is `SECURITY DEFINER` (bypasses table-level RLS) and used `p_user_id` to scope its queries (`WHERE p.user_id = p_user_id`) **without verifying the caller owns that UUID**. An authenticated user who knew another user's UUID could call these RPCs and receive paper IDs / match flags / ranking / keyword options for that user's library. Paper *content* stayed protected by RLS on the `papers` table itself, so the leak was bounded to paper IDs, paper-existence-for-a-given-search-term, ts_rank, and `matched_*` per-field booleans — but defense-in-depth on top of RLS is required.
**Fix:** Each function body now opens with the same guard pattern used by `safe_bulk_insert_papers`:
```sql
IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
  RAISE EXCEPTION 'Unauthorized: user mismatch';
END IF;
```
A `NULL` `p_user_id` also raises, so the function never returns rows when the caller's identity cannot be verified. The error surfaces to the client via `supabase.rpc(...).error` and is caught by the existing `if (error) throw error` paths in `useFilterState.ts` and `usePapers.ts`. **For the normal-flow user (where `p_user_id === auth.uid()`), behavior is unchanged.**

**Language change for two of the four.** `search_papers_short` and `get_keyword_options` were previously `LANGUAGE sql` (no support for `IF`/`RAISE`). They are recreated as `LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public` with `RETURN QUERY <original-SELECT>` wrapping the original body. Return shape, predicates, ORDER BY, per-field flag expressions, the CROSS JOIN LATERAL over the three jsonb arrays in `get_keyword_options`, the optional `p_paper_ids` / year-range / study-types filters, the prefix-aware FTS tokenization in `search_papers`, the synonym-map + NOT EXISTS double-negation AND semantics in `filter_papers_by_keywords` are all byte-identical to the prior definitions. `STABLE`, `SECURITY DEFINER`, and `SET search_path = public` are preserved.

**Signatures preserved bit-for-bit** — no client code change required, no generated Supabase types regeneration needed. The four call sites in `useFilterState.ts` (`search_papers`, `search_papers_short` for both short-search and phrase-search paths, `filter_papers_by_keywords`) and the one in `usePapers.ts` (`get_keyword_options`) already pass `p_user_id: userId!` where `userId` comes from `useAuth().user.id`. **In all five client call sites, `p_user_id` is the authenticated user's ID** — there is no legitimate cross-user RPC scenario, so the guard is a pure security improvement with no normal-path behavior change.

**Files changed:**
- `supabase/migrations/20260518010000_rpc_auth_uid_ownership_check.sql` — new migration (4× DROP + CREATE + GRANT EXECUTE).
- `docs/start-here.md` — handoff entry.
- `docs/decisions-and-triggers.md` — new architecture decision: SECURITY DEFINER RPCs that accept user identifiers must validate `p_user_id = auth.uid()` (or derive identity from `auth.uid()` internally).
- `docs/migration-history.md` — this entry.

**Test counts:** Vitest unchanged at **276/276** (no source / test files touched). Playwright unchanged at **71/71** and not re-run from this branch — no live UI behavior changes for the normal-flow user; the new failure path is a deliberate server-side rejection that does not occur for legitimate clients. The repo's existing `e2e/search-attribution.spec.ts` and the read-path / mutation specs continue to exercise the post-migration RPCs without modification.

**Verification:**
- `npx tsc --noEmit`: clean.
- `npx vitest run`: 276/276.
- Structural sanity on the migration: 4 `DROP FUNCTION`, 4 `CREATE FUNCTION`, 4 `GRANT EXECUTE`, 4 `BEGIN` / 4 `END;` / 4 `$$;` — balanced.
- **Local Supabase migration replay validated post-rebase** against the now-replayable migration chain delivered by PR #131 + PR #132 (see the two entries above). `supabase stop --no-backup; supabase start` applied **all 57 migrations** end-to-end, including this PR's `20260518010000_rpc_auth_uid_ownership_check.sql` as the final entry. The four hardened functions were verified post-replay to (a) exist on the local database, (b) carry the `Unauthorized: user mismatch` guard in their bodies, and (c) preserve their pre-rebase signatures and return shapes. The earlier note in this section saying local validation "could not be run" reflected the pre-rebase state when the migration chain was not yet locally replayable; it no longer applies.

**Manual verification once deployed:**
1. Same-user call succeeds for each RPC: confirm normal search (1-2 chars, 3+ chars, quoted phrase), keyword filter, and keyword dropdown all continue to return results in the user's own library.
2. Cross-user attempt with another UUID fails with the `Unauthorized: user mismatch` Postgres error: e.g. from a second authenticated user, call `supabase.rpc('search_papers', { p_user_id: '<otherUUID>', p_query: 'test' })` and confirm the response carries `error.message === 'Unauthorized: user mismatch'`.
3. Search-attribution Playwright spec (`e2e/search-attribution.spec.ts`) continues to pass against the migrated database.

**Deploy:** standard Supabase migration apply (`supabase db push` against the live project). After PR #131 + PR #132 were merged and their reconciliation deploy was completed (the five April migrations were repair-marked applied; `20260331010000` was pushed via `--include-all`), the remote ledger's latest entry is `20260331010000`. This migration's `20260518010000_rpc_auth_uid_ownership_check.sql` has a strictly later timestamp, so **a plain `supabase db push` will pick it up — no `--include-all` flag is required**, and no `migration repair` step is needed for this migration. Run `supabase db push --dry-run` first to confirm `20260518010000` is the sole pending migration before applying. No Edge Function deploy required (no Edge Functions changed). **This migration is independent of the frontend / Vercel deploy.**

**No frontend, RLS, Edge Function, schema, or commercial-doc changes.** No unrelated RPCs touched. No client code changed (signatures bit-identical). No generated `src/integrations/supabase/types.ts` regeneration required.

**Rollback:** re-run the prior controlling migrations:
- `20260420010000_keywords_in_search_with_attribution.sql` (restores prior `search_papers` + `search_papers_short`).
- `20260403010000_add_filter_keywords_rpc.sql` (restores prior `filter_papers_by_keywords`).
- `20260405010000_add_keyword_options_rpc.sql` (restores prior `get_keyword_options`).
Rollback would re-open the defense-in-depth gap; only roll back if a normal-flow regression is observed (none expected — signatures and behavior for `p_user_id === auth.uid()` are unchanged).

**Explicit non-goals.** No RLS policy change. No Edge Function change. No frontend code change. No tests added (the failure path requires cross-account RPC injection which the single-account E2E harness can't deterministically perform; documented manual smoke above mirrors the precedent for cross-user verification used in PR #96). No commercial / billing / mobile / store-readiness changes. No change to other RPCs (`safe_bulk_insert_papers`, `set_paper_tags`, `set_paper_projects`, `bulk_set_paper_tags`, `bulk_set_paper_projects`, `bulk_update_study_types`, `bulk_update_keywords`, `get_duplicate_papers`, `merge_exact_duplicates`) — these already enforce `auth.uid()` ownership internally and were not part of the audit finding. **Rebase note:** PR #130 was rebased on `main` after PR #131 + PR #132 were merged. The rebase touched only conflict-region docs (this file's entries above + `docs/start-here.md`'s entries above). The migration file `20260518010000_rpc_auth_uid_ownership_check.sql` and the four hardened RPC bodies were unaffected.

## Client-side explicit `user_id` scoping — first hardening wave

**Date:** May 2026 (immediately follows PR #130's deploy).
**What:** Added explicit `.eq("user_id", userId)` predicates to six client-side mutation sites across three hooks. Defense-in-depth on top of the existing RLS policies. **No schema, no RPC, no migration, no Edge Function, no commercial-doc changes.** Purely a hardening of how the React client constructs PostgREST queries for user-owned tables.

**Why:** The Production-Hardening audit conducted before PR #130 identified ~13 client-side mutation sites that update or delete rows on user-owned tables by row ID only (`.eq("id", rowId)`), trusting RLS as the sole ownership boundary. RLS remains correct and is the primary security layer, but the audit recommended a layered defense — making ownership intent visible at every call site so an accidental RLS regression (e.g. during a future migration that temporarily disables a policy) cannot result in a cross-user write. PR #130 closed the equivalent server-side gap on SECURITY DEFINER RPCs; this PR begins the client-side version of the same hardening.

**Scope: 6 sites in 3 hooks.** Smallest coherent first wave; deliberately excludes junction-table flows (`paper_tags`, `paper_projects` — no direct `user_id`), pool/exclusion hooks (already carry the filter per pre-existing convention), and `projects` / `tags` (deferred to a follow-up small PR).

### Sites hardened

| File | Function | Change |
|---|---|---|
| `src/hooks/papers/usePaperMutations.ts` | `updatePaper` | `update(paperUpdates).eq("id", paperId)` → `update(paperUpdates).eq("id", paperId).eq("user_id", userId)`. The `!userId` guard at the top of the function (already present from PR #125) makes `userId` non-undefined at this line. |
| `src/hooks/papers/usePaperMutations.ts` | `deletePaper` | `delete().eq("id", paperId)` → `delete().eq("id", paperId).eq("user_id", userId)`. The `!userId` guard at the top of the function (line 327) makes `userId` non-undefined at this line. |
| `src/hooks/useFilterPresets.ts` | `deletePresetMutation` | `delete().eq("id", id)` → `delete().eq("id", id).eq("user_id", userId)`. New `if (!userId) throw new Error("Not signed in")` guard added before the supabase call (matching the existing `createPresetMutation` guard pattern at line 265). |
| `src/hooks/useFilterPresets.ts` | `updatePresetMutation` | `update({ payload }).eq("id", id)` → `update({ payload }).eq("id", id).eq("user_id", userId)`. Same `!userId` guard added. |
| `src/hooks/useFilterPresets.ts` | `renamePresetMutation` | `update({ name }).eq("id", id)` → `update({ name }).eq("id", id).eq("user_id", userId)`. Same `!userId` guard added. |
| `src/hooks/useAttachments.ts` | `deleteAttachment` | `delete().eq("id", attachment.id)` → `delete().eq("id", attachment.id).eq("user_id", userId)`. The `!userId` guard at the top of the function (line 165) makes `userId` non-undefined at this line. |

### What's NOT in this wave

- **Junction tables** (`paper_tags`, `paper_projects`) — no direct `user_id` column. Ownership flows through the parent row's RLS, which is correct as-is. Adding a synthetic filter would require either a join (changes query semantics) or an RPC change (out of scope).
- **`projects` / `tags` mutations** in `useProjectMutations.ts` / `useTagMutations.ts` (`update().eq("id", projectId)` / `delete().eq("id", tagId)`) — same shape as the sites hardened here. Deferred to a small follow-up PR to keep this wave focused.
- **Pool / exclusion hooks** (`useKeywordPool`, `useStudyTypePool`, `useSynonymPool`, `useExclusionPools`) — already carry `.eq("user_id", userId)` on every read/write per pre-existing convention. Audited; no change needed.
- **`profiles` / `settings`** (`useSettings.ts`) — already filter by `.eq("user_id", user.id)` everywhere. No change needed.
- **`useAbstract.ts`'s batch-fetch** — its query is `from("papers").select(...).in("id", ids)` with no `user_id` filter; adding one would require a non-trivial signature change (the function doesn't currently receive `userId`). Deferred to a separate careful-design PR per the PR scope spec.
- **Read paths on `papers`** — `buildPapersQuery` and `usePapers` list/count/all-ids/keyword-options already carry `.eq("user_id", userId)`. No change needed.
- **Insert paths** — already include `user_id: userId` in the row payload; no `.eq` filter needed.

### Files changed

- `src/hooks/papers/usePaperMutations.ts` — 2 sites hardened (`updatePaper`, `deletePaper`).
- `src/hooks/useFilterPresets.ts` — 3 sites hardened (`deletePresetMutation`, `updatePresetMutation`, `renamePresetMutation`), each with a new `!userId` guard.
- `src/hooks/useAttachments.ts` — 1 site hardened (`deleteAttachment`).
- `src/hooks/papers/__tests__/usePaperMutations.test.ts` — mock chain extended so `.update(x).eq().eq()` resolves; **1 new test** asserting `mockUpdateEq` is called with both `("id", paperId)` and `("user_id", userId)` (and that the `.eq` chain is exactly 2 calls). All existing tests still pass with no assertion changes.
- `docs/decisions-and-triggers.md` — added decision **S2. Client-side queries on user-owned tables should carry explicit `user_id` filters where safe** under the existing "Security decisions" section. Records the rule, the required predicate shape, the current inventory of compliant / hardened / deferred sites, and a re-evaluation trigger.
- `docs/migration-history.md` — this entry.
- `docs/start-here.md` — short handoff entry pointing at the new S2 decision and this migration-history entry.

### Test counts

Vitest: **276/276 → 277/277** (+1 new test). Playwright unchanged at **71/71** and not re-run from this branch — no live UI behavior change for legitimate users; the new filter is purely additive (it's redundant with RLS today). Same precedent and same scope discipline as the PR #130 client-side hardening.

### Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 277/277.
- `npx eslint` on the four touched files — 0 errors, 1 warning (the pre-existing `addPaperManually` `react-hooks/exhaustive-deps` warning at `usePaperMutations.ts:235`, unchanged from `main`).

### Behavior on legitimate users

**No change.** Every legitimate call already passes the row's `user_id` equal to the caller's `auth.uid()` (RLS enforces this server-side and the client uses `useAuth().user.id` everywhere). The new `.eq("user_id", userId)` predicate is therefore a redundant filter that always returns the same row set RLS would have returned anyway. Toast text, optimistic updates, rollback paths, return contracts, and error messages are all unchanged.

### Risk

**Very low.** The only failure mode this introduces is: if a client somehow passed a wrong `userId` (e.g. a stale closure capturing a previous session's UUID after a sign-out + sign-in race), the mutation would fail silently (zero rows affected). RLS would already have produced the same outcome. The new predicate makes the failure faster (PostgREST short-circuits before RLS evaluates) but doesn't introduce a new failure path.

### Non-goals

- No frontend behavior changes for legitimate users.
- No RLS, RPC, schema, migration, Edge Function, or generated-types changes.
- No commercial / billing / mobile / store-readiness changes.
- No README change (Vitest count delta is +1; not a high-level shipping-status change).
- No bulk refactor of the remaining ~7 client-side sites that could carry the same pattern (`useProjectMutations`, `useTagMutations`, etc.) — those are explicitly deferred to follow-up PRs to keep this wave reviewable.

## Client-side explicit `user_id` scoping — second wave (projects + tags)

**Date:** May 2026 (immediately follows the PR #133 first wave).
**What:** Added explicit `.eq("user_id", userId)` predicates to four client-side mutation sites across two hooks: `useProjectMutations` (update + delete) and `useTagMutations` (update + delete). Pure defense-in-depth on top of the existing RLS policies on `projects` and `tags`. **No schema, no RPC, no migration, no Edge Function, no commercial-doc changes.** Direct application of the S2 decision (see [decisions-and-triggers.md](decisions-and-triggers.md)) that PR #133 introduced.

**Why:** Closes out one of two follow-ups PR #133 explicitly deferred. The deferred set was `useProjectMutations` / `useTagMutations` (this PR) and `useAbstract` batch-fetch (still deferred — requires a signature change and remains a separate careful-design PR).

### Sites hardened

| File | Function | Change |
|---|---|---|
| `src/hooks/papers/useProjectMutations.ts` | `updateProject` | `update(dbUpdates).eq("id", projectId)` → `…eq("id", projectId).eq("user_id", userId)`. The `!userId` guard already at the top of the function makes `userId` non-undefined at this line. |
| `src/hooks/papers/useProjectMutations.ts` | `deleteProject` | `delete().eq("id", projectId)` → `…eq("id", projectId).eq("user_id", userId)`. Same `!userId` guard already present. |
| `src/hooks/papers/useTagMutations.ts` | `updateTag` | `update(updates).eq("id", tagId)` → `…eq("id", tagId).eq("user_id", userId)`. Same `!userId` guard already present. |
| `src/hooks/papers/useTagMutations.ts` | `deleteTag` | `delete().eq("id", tagId)` → `…eq("id", tagId).eq("user_id", userId)`. Same `!userId` guard already present. |

No new `!userId` guards were added — every site already short-circuits with `if (!userId) return;` at the top of its function body, matching the existing `useProjectMutations` / `useTagMutations` style.

### What's NOT in this wave

- **`createProject` / `createTag`** — insert paths. The `.eq` predicate doesn't apply to inserts; ownership is set in the row payload (`{ user_id: userId, name }`) which both functions already do. Audited; no change needed.
- **Junction table operations** (`paper_projects`, `paper_tags`) — handled via RPCs (`set_paper_projects`, `set_paper_tags`, `bulk_set_paper_projects`, `bulk_set_paper_tags`) which already enforce ownership server-side per the SECURITY DEFINER pattern from S1. Out of scope.
- **`useAbstract` batch fetch** — still deferred to a separate careful-design PR (it requires threading `userId` through a public function signature change). Not in this wave.

### Files changed

- `src/hooks/papers/useProjectMutations.ts` — 2 sites hardened.
- `src/hooks/papers/useTagMutations.ts` — 2 sites hardened.
- `docs/decisions-and-triggers.md` — updated the S2 inventory: `useProjectMutations` and `useTagMutations` moved from "Not yet hardened in this wave" to compliant. Inventory now reflects the full set of compliant sites across both hardening waves.
- `docs/migration-history.md` — this entry.
- `docs/start-here.md` — short handoff entry pointing at this wave and the updated S2 inventory.

### Test counts

Vitest: **277/277 → 277/277 (unchanged)**. No new tests added; rationale below.

### Why no new tests

These four mutation sites are mechanical siblings of the well-tested `usePaperMutations` patterns from PR #133 (the new test there asserts `mockUpdateEq` is called with both `("id", x)` and `("user_id", y)` exactly twice). The `useProjectMutations` / `useTagMutations` hooks have **no existing test files** in the repo; adding mutation-chain tests for them here would require building the same hoisted-mock infrastructure used in `usePaperMutations.test.ts` (mockable supabase client, hoisted `mockUpdate` / `mockUpdateEq` / `mockUpdateResolve` chain, mockable `usePaperCacheHelpers`, plus a renderHook harness). That's exactly the scope-creep PR #133 explicitly avoided for `useFilterPresets` and `useAttachments`, and the same precedent applies here.

TypeScript catches signature errors at compile time. The full Vitest suite passes (277/277). Manual smoke in the live app after merge will exercise the four sites through the Sidebar's Manage Projects / Manage Tags modals.

### Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 277/277 (unchanged from main).
- `npx eslint src/hooks/papers/useProjectMutations.ts src/hooks/papers/useTagMutations.ts` — 0 errors, 0 warnings. (Note: ESLint emitted no output on these two specific files, in contrast to the pre-existing `useCallback` deps warning on `usePaperMutations.ts:235` that has been carried since before this hardening wave; that warning is on a different file and is not touched here.)

### Behavior on legitimate users

**No change.** Every legitimate `updateProject` / `deleteProject` / `updateTag` / `deleteTag` call already passes a row whose `user_id` equals the caller's `auth.uid()` — RLS enforces this server-side; the client always sources `userId` from `useAuth().user.id`. The new `.eq("user_id", userId)` predicate is therefore redundant with RLS for normal calls and returns the same row set. Toast text, optimistic updates, cache rollback, return contracts, and error messages: all bit-identical.

### Risk

**Very low.** Same risk profile as PR #133's first wave. The only new failure mode is silent zero-rows-affected if the client somehow passes a wrong `userId` (e.g., stale closure after sign-out / sign-in race) — RLS would already produce the same outcome; the new predicate just makes the failure faster at the PostgREST layer.

### Non-goals

- No frontend behavior changes for legitimate users.
- No RLS, RPC, schema, migration, Edge Function, or generated-types changes.
- No commercial / billing / mobile / store-readiness changes.
- No README change (Vitest count unchanged at 277; not a high-level shipping-status change).
- No tests added (rationale above).
- No change to `createProject` / `createTag` (insert paths already correct).
- No change to junction-table RPC flows.
- No change to `useAbstract` batch fetch (deferred).

## Client-side explicit `user_id` scoping — third wave (abstract fetch)

**Date:** May 2026 (immediately follows the PR #134 second wave).
**What:** Added explicit `.eq("user_id", userId)` predicates to the abstract-fetch read path — three functions in `src/hooks/useAbstract.ts` (`useAbstract`, `fetchAbstract`, `fetchAbstractsBatch`) — by threading `userId: string` (or `string | null | undefined` for the hook) through their public signatures and through every call site. Pure defense-in-depth on top of the existing RLS policy on `papers`. **No schema, no RPC, no migration, no Edge Function, no commercial-doc, no generated-types changes.** Direct application of the S2 decision (see [decisions-and-triggers.md](decisions-and-triggers.md)) introduced by PR #133.

**Why:** Closes out the last remaining deferred S2 follow-up from PR #133 / #134. The deferred set was originally `useProjectMutations` + `useTagMutations` (closed by PR #134) and the `useAbstract` read path (closed by this PR). With this wave the S2 client-side inventory is fully covered for read and write paths against `user_id`-bearing tables; the only remaining S2-adjacent item — making the abstract query key user-scoped — is intentionally out of scope and tracked separately (see "What's NOT in this wave").

### Sites hardened

| File | Function | Change |
|---|---|---|
| `src/hooks/useAbstract.ts` | `useAbstract(paperId, userId)` | Hook signature gains `userId: string \| null \| undefined`. Query gains `.eq("user_id", userId!)`. `enabled` predicate gains `&& !!userId` so the query stays disabled until both ids are present (matches the existing `!!paperId` guard). |
| `src/hooks/useAbstract.ts` | `fetchAbstract(paperId, userId, queryClient)` | Imperative helper signature gains `userId: string` as the second arg (queryClient moves to third). Query gains `.eq("user_id", userId)`. |
| `src/hooks/useAbstract.ts` | `fetchAbstractsBatch(paperIds, userId, queryClient)` | Same shape: `userId` becomes the second arg, queryClient third. The batch supabase call gains `.eq("user_id", userId)` alongside `.in("id", uncached)`. Cache-warming path (`queryClient.setQueryData(queryKeys.papers.abstract(row.id), …)`) unchanged. |
| `src/hooks/usePaperAnalysisActions.ts` | `usePaperAnalysisActions(args)` | `UsePaperAnalysisActionsArgs` gains `userId: string`. Hook destructures `userId` and threads it into both `fetchAbstract(paper.id, userId, queryClient)` (single-paper) and `fetchAbstractsBatch(papersToAnalyze.map(p => p.id), userId, queryClient)` (bulk). `userId` added to both `useCallback` dep arrays. |
| `src/pages/Dashboard.tsx` | `usePaperAnalysisActions({...})` call | Adds `userId: user.id`. |
| `src/pages/Dashboard.tsx` | `<PaperList ... />` JSX | Adds `userId={user.id}` so the row-expand path can call `useAbstract` with the scoped id. |
| `src/components/papers/PaperList.tsx` | `PaperListProps` / `PaperRowProps` / function destructures | Both interfaces gain `userId: string \| null \| undefined`. The `PaperRow` instantiation threads the prop through. The `useAbstract(isExpanded ? paper.id : null, userId)` call passes it; when `isExpanded` is false the query stays disabled as before. |
| `src/components/papers/EditPaperDialog.tsx` | `useAbstract(open && paper ? paper.id : null, userId)` call | The component already had a `userId` prop from prior wiring; this PR just passes it into the `useAbstract` call. No JSX or prop changes. |

### Why threading rather than reading from a hook

The two imperative helpers (`fetchAbstract`, `fetchAbstractsBatch`) execute outside React render (called from event handlers in `usePaperAnalysisActions`), so they cannot read auth context through `useAuth()`. Threading `userId` as an argument is the natural shape: it matches the `usePaperMutations` PR #133 pattern (the mutation functions take `userId` explicitly even though `useAuth()` is available, because the helper is a pure async function), keeps the helpers side-effect-free, and makes the ownership intent visible at every call site.

For the hook variant (`useAbstract`), the signature accepts `string | null | undefined` so callers can pass `useAuth().user?.id` directly without an extra non-null check. The `enabled: !!paperId && !!userId` predicate keeps the query inert until both ids are present, mirroring the existing pre-PR pattern of `enabled: !!paperId`.

### What's NOT in this wave

- **Cache-key user-scoping.** The query key `queryKeys.papers.abstract(paperId)` is intentionally **not** changed to include `userId`. The defense-in-depth value lives in the query *predicate* (which is what RLS-loosening or migration-temporary-disable would actually bypass); cache-key correctness for a hypothetical multi-tenant future is a separate, smaller fix that's better done in isolation. In the current single-user MVP, sign-out garbage-collects the cache via TanStack Query's `gcTime`, so there is no practical leakage risk today. This is explicitly documented in the `useAbstract.ts` JSDoc and in the updated S2 inventory.
- **No new RLS / RPC / migration / Edge Function.** All ownership enforcement on `papers` already lives in RLS; this PR only adds redundant client-side filters on top.
- **No commercial / billing / mobile / store-readiness changes.**

### Files changed

- `src/hooks/useAbstract.ts` — 3 functions hardened (the entire public API of the module).
- `src/hooks/usePaperAnalysisActions.ts` — `userId` threaded into args + both `useCallback` closures.
- `src/pages/Dashboard.tsx` — 2 sites updated (hook call + `PaperList` JSX).
- `src/components/papers/PaperList.tsx` — 2 interfaces gain `userId`, both destructures updated, hook call updated, `<PaperRow>` JSX threads the prop.
- `src/components/papers/EditPaperDialog.tsx` — `useAbstract` call gains the existing `userId` prop as a second argument.
- `src/hooks/__tests__/usePaperAnalysisActions.test.ts` — all 7 `renderHook(() => usePaperAnalysisActions({...}))` invocations gain `userId: "user-1"`; the two `mockFetch*` `toHaveBeenCalledWith` assertions gain `"user-1"` as the new second argument.
- `docs/decisions-and-triggers.md` — S2 inventory extended to record the abstract-fetch read path as compliant, plus an explicit note that cache-key user-scoping is intentionally out of scope. Adds a "Status" line noting the S2 client-side hardening inventory is now closed.
- `docs/migration-history.md` — this entry.
- `docs/start-here.md` — short handoff entry pointing at this wave and noting the S2 client-side inventory is fully closed (cache-key correctness tracked separately).

### Test counts

Vitest: **277/277 → 277/277 (unchanged)**. The existing 7 tests in `usePaperAnalysisActions.test.ts` continue to pass after the prop-and-assertion updates — they were already the regression check for the bulk cooldown control flow and the missing-abstract behavior, and the userId threading is mechanical relative to that behavior. Playwright unchanged at **71/71** and not re-run from this branch — no live UI behavior change for legitimate users; the new predicate is purely additive (it's redundant with RLS today).

### Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 277/277.
- `npx vitest run src/hooks/__tests__/usePaperAnalysisActions.test.ts` — 7/7.
- `npx eslint` on the six touched source files plus the one test file — 0 errors, 1 warning. The single warning (`react-hooks/exhaustive-deps` on `PaperList.tsx:302` for `isVisible`) is pre-existing and unrelated to this PR — it's on the `useMemo` for `visiblePapers`, not on any hook touched by the userId threading.

### Behavior on legitimate users

**No change.** Every legitimate caller already had `useAuth().user.id` in scope (or passed it through props) and the row's `user_id` always equals the caller's `auth.uid()` — RLS enforces this server-side. The new `.eq("user_id", userId)` predicate is therefore redundant with RLS for normal calls and returns the same row set. The `useAbstract` hook's `enabled` flag now requires `userId` to be non-falsy in addition to `paperId`; this is a no-op for the authenticated single-user app where every render that supplies a `paperId` also has a current `userId`. The hook stays disabled (no fetch, no error) if `userId` is missing — which mirrors the existing pre-PR behavior of staying disabled if `paperId` is null.

### Risk

**Very low.** Same risk profile as the PR #133 / #134 client-side hardening waves:
1. RLS remains the primary security boundary and is unchanged.
2. The new predicate is redundant for legitimate calls (`auth.uid()` already matches the row's `user_id`).
3. The only new failure mode is silent zero-rows-returned if the client somehow passes a wrong `userId` (e.g., a stale closure after sign-out / sign-in race) — RLS would already produce the same outcome; the new predicate just makes the failure faster at the PostgREST layer.
4. No public-API removals — every function gains an *additional* required argument, which TypeScript catches at compile time at every call site. The 7 call sites in this PR are exhaustive (`grep -rn "useAbstract\|fetchAbstract\|fetchAbstractsBatch" src/` is the audit).

### Non-goals

- No frontend behavior changes for legitimate users.
- No RLS, RPC, schema, migration, Edge Function, or generated-types changes.
- No commercial / billing / mobile / store-readiness changes.
- No README change (Vitest count unchanged at 277; not a high-level shipping-status change).
- No new tests added — the 7 existing `usePaperAnalysisActions` tests are extended (assertion updates only), and no new fail modes are introduced that aren't already covered by the existing tests + `tsc`.
- **No change to the abstract query key** — `queryKeys.papers.abstract(paperId)` stays as-is. Cache-key correctness for hypothetical multi-tenant scenarios is a separate, smaller follow-up tracked outside this PR.
- No broader abstract / cache refactor.

## Hotfix — Dashboard null-user crash after abstract userId threading (PR #135 follow-up)

**Date:** May 2026 (urgent hotfix for the merged PR #135 / S2 third wave).
**What:** Repairs the `Cannot read properties of null (reading 'id')` crash on Dashboard entry introduced by PR #135's two direct `user.id` reads inside `DashboardContent`. Replaces those reads with a nullable-safe `userId = user?.id` alias, widens the `usePaperAnalysisActions` `userId` arg to `string | null | undefined`, and adds short-circuit guards to both analysis handlers so they never call `fetchAbstract`, `fetchAbstractsBatch`, or the `analyze-paper` Edge Function with a missing user id. Also tightens the deduplication-dialog mount condition.

### Root cause

`DashboardContent` calls `useAuth()` and reads `user`. `useAuth()` returns `user: User | null`. The outer `Dashboard` component already short-circuits with `if (!user) return null;` before mounting `DashboardContent`, but `useAuth()` can still yield `user === null` on an intermediate render during a sign-out / sign-in transition (the parent re-render that would unmount the child has not yet committed). Pre-PR-#135 code was robust to that case because every read inside `DashboardContent` went through `user?.id`. PR #135 added two new reads in `DashboardContent` that bypassed the `?.`:

- `src/pages/Dashboard.tsx` line 456 (pre-hotfix): `usePaperAnalysisActions({ ..., userId: user.id, ... })`
- `src/pages/Dashboard.tsx` line 607 (pre-hotfix): `<PaperList ... userId={user.id} />`

Either read throws `TypeError: Cannot read properties of null (reading 'id')` when `user` is null at hook-call / render time, taking the whole Dashboard down before any error boundary can render a recovery UI.

A third unsafe read predated PR #135 but is in the same component: `<DeduplicationDialog userId={user!.id}/>` (line 692 pre-hotfix). It was practically guarded by `{dedupOpen && (…)}`, but the non-null assertion (`user!`) was a latent bug — same auth-transition window could fire it if `dedupOpen` was true. The hotfix tightens the gate to `{dedupOpen && userId && (…)}` and uses the local `userId` alias.

The outer `Dashboard` component's `<PoolsProvider userId={user.id}>` (line 67) is left untouched — it sits below the parent's `if (!user) return null;` guard in the SAME component, so `user` is provably non-null at that line. The hotfix scope is `DashboardContent` and downstream, not the parent.

### Sites changed

| File | Change |
|---|---|
| `src/pages/Dashboard.tsx` | Inside `DashboardContent`: introduce `const userId = user?.id;` right after `const { user } = useAuth();`, with a JSDoc explaining the auth-transition window. Replace `userId: user.id` → `userId,` in the `usePaperAnalysisActions({...})` call, `userId={user.id}` → `userId={userId}` on `<PaperList>`, and the `DeduplicationDialog` mount → `{dedupOpen && userId && (<DeduplicationDialog ... userId={userId}/>)}`. The other pre-existing `user?.id` reads (line 150, 186, 190, 210, 378, 670) were already nullable-safe and are left alone to keep the hotfix diff minimal. |
| `src/hooks/usePaperAnalysisActions.ts` | `UsePaperAnalysisActionsArgs.userId` widened from `string` to `string \| null \| undefined`. JSDoc updated to record the auth-transition rationale. `handleAnalyzePaper` gains `if (!userId) return;` immediately after the `has_abstract` guard. `handleBulkAnalyze` gains an early `if (!userId) { toast({ title: "Not signed in", … variant: "destructive" }); return; }` BEFORE the abstract batch-fetch. `userId` was already in both `useCallback` dep arrays from PR #135; unchanged. |
| `src/hooks/__tests__/usePaperAnalysisActions.test.ts` | Added a new `describe("usePaperAnalysisActions — null/undefined userId (auth-transition hotfix)")` block with 3 focused regression tests: (a) `handleAnalyzePaper` with `userId: null` is a silent no-op (no `mockFetchAbstract`, no `mockInvoke`, no `updatePaper`, no `mockToast`); (b) same for `userId: undefined`; (c) `handleBulkAnalyze` with `userId: null` surfaces the "Not signed in" destructive toast and skips batch-fetch / invoke / sleep entirely. Existing 7 tests continue to pass with their existing `userId: "user-1"` from PR #135. |

### What stays from PR #135 — unchanged

- `useAbstract`, `fetchAbstract`, `fetchAbstractsBatch` signatures and `.eq("user_id", userId)` predicates: **unchanged**. The S2 third-wave hardening is fully preserved.
- `useAbstract`'s `enabled: !!paperId && !!userId` predicate: **unchanged** — it was already nullable-safe.
- `queryKeys.papers.abstract(paperId)` cache key: **unchanged** — the hotfix does not touch cache keys.
- `PaperList`'s `userId: string | null | undefined` prop type: **unchanged** (was already widened in PR #135).
- `EditPaperDialog`'s existing `userId?: string | null` prop: **unchanged**.

### What's NOT in this hotfix

- **No revert of PR #135.** The defense-in-depth `.eq("user_id", userId)` predicate on the abstract read path remains.
- No migration, no RPC, no RLS, no Edge Function, no generated Supabase types touched.
- No commercial / billing / mobile / store-readiness doc updates.
- No cache-key change (intentionally tracked separately per the S2 inventory note).
- No broad auth refactor — the hotfix is local to `DashboardContent` and the one hook PR #135 touched.
- No new dashboard render/auth test harness — the repo has none for this surface, and standing one up is well beyond an urgent hotfix's scope. Coverage is provided by the 3 new focused hook tests plus the post-merge production smoke.

### Files changed

- `src/pages/Dashboard.tsx`
- `src/hooks/usePaperAnalysisActions.ts`
- `src/hooks/__tests__/usePaperAnalysisActions.test.ts`
- `docs/migration-history.md` — this entry.
- `docs/start-here.md` — short handoff entry above PR #135's third-wave entry.
- `docs/decisions-and-triggers.md` — small note in the S2 inventory clarifying that threaded `userId` at auth-boundary call sites must remain nullable-safe.

### Test counts

Vitest: **277/277 → 280/280** (+3 new tests in the null/undefined-userId describe block). Playwright unchanged at **71/71** and not re-run from this branch — no Playwright fixture covers the sign-out / sign-in transition window, and the hotfix's behavior is fully captured by the new hook tests.

### Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run src/hooks/__tests__/usePaperAnalysisActions.test.ts` — 10/10 (was 7/7).
- `npx vitest run` — 280/280 (was 277/277).
- `npx eslint` on the three touched source / test files plus the four PR-#135-touched files for safety — 0 errors, 1 pre-existing warning (`PaperList.tsx:302` `react-hooks/exhaustive-deps` on the `visiblePapers` `useMemo`; unrelated to this hotfix, present on `main`).
- **Playwright not run.** No fixture covers the auth-transition crash window; running the existing 71-test suite would not exercise the hotfix and would burn ~3 minutes for no signal.
- **No Supabase migration validation.** This hotfix adds no migration; `supabase db push --dry-run` is unnecessary.

### Behavior on legitimate users

**Identical to PR #135** for any render where `user` is non-null (i.e. the normal authenticated case). The new guards only fire during the narrow auth-transition window where `useAuth()` momentarily yields `user === null` — and in that window the page previously crashed; now it stays mounted, the analyze button is a no-op until the next render lands `user`, and a bulk-analyze click surfaces a "Not signed in" toast that goes away on the next click. No legitimate analyze / abstract-fetch / paper-list flow is altered.

### Risk

**Very low.** The hotfix only adds early-return / falsy-guard branches; the happy path is bit-identical to PR #135. The only behavior change visible to a legitimate user is the bulk-analyze "Not signed in" toast in the auth-transition window — explicitly the right user-facing outcome for that state. TypeScript catches all call sites at compile time. The 3 new tests are exhaustive over the null/undefined branches.

## Client-side explicit `user_id` scoping — bulk paper delete

**Date:** May 2026 (small post-checkpoint S2 follow-up to PRs #133 / #134 / #135 / #136).
**What:** Adds an explicit `.eq("user_id", userId)` predicate to the single bulk-delete SQL chain in `src/hooks/papers/useBulkMutations.ts` — the only S2 client-side gap surfaced by the post-PR-#136 checkpoint audit. Pure defense-in-depth on top of the existing RLS policy on `papers`. **No schema, no RPC, no migration, no Edge Function, no commercial-doc, no generated-types changes.** Direct application of the S2 decision (see [decisions-and-triggers.md](decisions-and-triggers.md)) introduced by PR #133.

**Why:** PR #133 hardened single-row `deletePaper` in `usePaperMutations.ts` but did not touch the bulk variant in `useBulkMutations.ts`. The checkpoint audit after PR #136 (see `docs/start-here.md`) identified `useBulkMutations.bulkDeletePapers` as the last S2 client-side site without an explicit user-scoping predicate. With this change the S2 client-side hardening is fully closed for read and write paths against `user_id`-bearing tables.

### Site hardened

| File | Function | Change |
|---|---|---|
| `src/hooks/papers/useBulkMutations.ts` | `bulkDeletePapers` | `supabase.from("papers").delete().in("id", paperIds)` → `supabase.from("papers").delete().in("id", paperIds).eq("user_id", userId)`. The pre-existing `if (!userId \|\| paperIds.length === 0) return;` guard at the top of the callback (already present from prior code) makes `userId` provably non-null at the DELETE site — no new guard needed. `userId` is already in the `useCallback` deps array. |

No other sites were touched. The `useDeduplication`, junction-table RPC, settings, project / tag / filter-preset / attachment, and abstract-fetch paths are unchanged.

### What's NOT in this PR

- No change to `usePaperMutations.deletePaper` (single-row delete; already hardened by PR #133).
- No change to junction-table operations (RPC-driven, `auth.uid()`-enforced per S1).
- No change to bulk-import / file-import / RPC paths.
- No migration, no RPC, no RLS, no Edge Function, no generated Supabase types.
- No commercial / billing / mobile / store-readiness docs.
- No cache-key change (`queryKeys.papers.abstract` correctness remains intentionally deferred per the S2 inventory).

### Files changed

- `src/hooks/papers/useBulkMutations.ts` — 1 site hardened (one SQL chain extended by one `.eq` call, plus a 6-line in-source comment explaining the S2 rationale and the existing `!userId` guard).
- `src/hooks/papers/__tests__/useBulkMutations-assignment.test.ts` — hoisted mock chain extended so `from("papers").delete().in(...)` returns an inspectable `{ eq: mockDeleteInEq }`; `from("paper_attachments").select(...).in(...)` is also routed (the attachments pre-delete read returns `{ data: [], error: null }` so the storage-cleanup branch is skipped); **1 new test** in a new describe block asserts `mockDeleteIn` is called with `("id", paperIds)` exactly once and `mockDeleteInEq` is called with `("user_id", userId)` exactly once, plus a non-destructive success toast. The existing 8 tests (assignment-failure-visibility for `bulkImportPapers` and `bulkImportFromParsedData`) continue to pass with no assertion changes.
- `docs/decisions-and-triggers.md` — S2 inventory extended to add `useBulkMutations.bulkDeletePapers` to the compliant list, including a note that the existing `!userId` guard makes the new predicate safe.
- `docs/migration-history.md` — this entry.
- `docs/start-here.md` — short handoff entry above the PR #136 hotfix entry noting this closes the bulk-delete S2 parity gap.

### Test counts

Vitest: **280/280 → 281/281** (+1 new test). Playwright unchanged at **71/71** and not re-run from this branch — the bulk-delete path is exercised by the existing UI flow and the new predicate is purely additive (it's redundant with RLS today).

### Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run src/hooks/papers/__tests__/useBulkMutations-assignment.test.ts` — 9/9 (was 8/8).
- `npx vitest run` — 281/281 (was 280/280).
- `npx eslint` on the two touched files — 0 errors, 2 pre-existing warnings (`react-hooks/exhaustive-deps` on `useBulkMutations.ts:217 / 366`, both on `bulkImportPapers` / `bulkImportFromParsedData` callbacks — present on `main`, unrelated to this PR).
- **Playwright not run.** No focused bulk-delete spec exists and the new predicate is purely additive at the SQL layer.
- **No Supabase migration validation.** This PR adds no migration.

### Behavior on legitimate users

**No change.** Every legitimate `bulkDeletePapers` call already passes a row set whose `user_id` equals the caller's `auth.uid()` (RLS enforces this server-side; the client always sources `userId` from `useAuth().user.id`). The new `.eq("user_id", userId)` predicate is therefore redundant with RLS and returns the same row set DELETE would have removed anyway. Toast text, optimistic updates, cache rollback, storage cleanup, and selection clearing: all bit-identical.

### Risk

**Very low.** Same risk profile as PR #133's first wave. The only new failure mode is silent zero-rows-affected if the client somehow passes a wrong `userId` (e.g., stale closure after sign-out / sign-in race) — RLS would already produce the same outcome; the new predicate just makes the failure faster at the PostgREST layer.

### Non-goals

- No frontend behavior changes for legitimate users.
- No RLS, RPC, schema, migration, Edge Function, or generated-types changes.
- No commercial / billing / mobile / store-readiness changes.
- No README change (Vitest count +1 is not a high-level shipping-status change; matches the precedent set by PRs #133 / #134 / #135).
- No new tests added beyond the 1-test regression check (single-line chain change; the new test is the focused regression for the change being made).
- No abstract / cache-key refactor (cache-key user-scoping remains deferred per S2 inventory).

## Client env fail-fast validation + local-dev env docs

**Date:** May 2026 (post-checkpoint hardening; first PR in the production-readiness phase that follows the S1/S2 ownership-hardening sequence PRs #130–#137).
**What:** Adds a tiny client-side env validator (`src/lib/clientEnv.ts`) used by `src/integrations/supabase/client.ts` to fail fast with an actionable, project-specific error when either of the two required Vite-client env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) is missing or empty. Updates `README.md` with a new "Environment setup" subsection in Local development. Updates `.env.test.example` with an optional `BASE_URL` documentation comment. **No schema, no RPC, no migration, no Edge Function, no commercial-doc, no generated-types changes.** No new dependencies.

**Why:** The post-PR-#137 production-hardening env audit (see `docs/start-here.md`) identified the biggest deployment risk as the opaque failure mode of the Supabase client when env vars are missing. A fresh contributor running `npm run dev` after `npm install` previously got `Error: supabaseUrl is required.` from `@supabase/supabase-js` at module load — no hint about `.env.example` → `.env.local`. On Vercel, a misconfigured project env would surface the same opaque error in the deployed bundle. The new helper replaces that with `Missing required environment variable: VITE_SUPABASE_URL. Copy .env.example to .env.local and set VITE_SUPABASE_URL. See README.md → Local development.` The README addition documents the previously-undocumented `.env.local` setup step. The stale "276 tests" line in the README is normalized to the actual post-PR count.

### Sites changed

| File | Change |
|---|---|
| `src/lib/clientEnv.ts` *(new)* | Two exports. `requireClientEnvValue(name, value)` is the pure value-checker (throws actionable error on `undefined` / non-string / empty / whitespace-only); exported solely so the test file can exercise it without touching `import.meta.env`. `requireClientEnv(name)` is the production entry point — reads `import.meta.env[name]` once and routes through `requireClientEnvValue`. JSDoc explains the scope (client only; not used by Edge Functions which read `Deno.env.get` and have their own pattern). |
| `src/integrations/supabase/client.ts` | `const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;` (and `VITE_SUPABASE_PUBLISHABLE_KEY`) → `const SUPABASE_URL = requireClientEnv('VITE_SUPABASE_URL');`. New `import { requireClientEnv } from '@/lib/clientEnv';`. Auto-generated file banner preserved; `createClient` options preserved; export shape preserved. No env variable renamed; no support for `VITE_SUPABASE_ANON_KEY` / `VITE_SUPABASE_PROJECT_ID` added (those legacy vars remain unused). |
| `src/lib/__tests__/clientEnv.test.ts` *(new)* | 4 focused tests on `requireClientEnvValue`: (1) returns the value when a non-empty string is provided; (2) throws actionable error when value is `undefined`, with full message-contract assertion covering all four required pieces (variable name, `.env.example`, `.env.local`, `Local development`); (3) throws on empty string; (4) throws on whitespace-only string. |
| `README.md` | New "Environment setup" subsection inside "Local development" (placed between `npm install` and `npm run dev`): `cp .env.example .env.local` step, the two required `VITE_*` variables and how to find their values, `.env.local`-not-committed reminder, the new fail-fast behavior, and a guardrail note that `VITE_*` is for public anon-key style values only. Stale test count updated from `276` to `285`. |
| `.env.test.example` | New trailing 3-line comment documenting the optional `BASE_URL` env var that `playwright.config.ts:44` reads (defaults to `http://localhost:8080`). |

### What's NOT in this PR

- **No Edge Function env validation.** The `Deno.env.get("SUPABASE_URL") ?? ""` / `?? ""` fallback in `supabase/functions/analyze-paper/index.ts` and `supabase/functions/fetch-paper-metadata/index.ts` is left as-is. These are auto-injected by the Supabase Edge runtime, so the fallback is theoretical-only; tightening it is tracked as a separate small PR (would require a deploy ceremony, so kept out of this client-only PR per the audit's PR-phasing recommendation).
- **No `GEMINI_API_KEY` docs change.** The existing in-source throw in `analyze-paper/index.ts` is already actionable; a README/docs mention is deferred to the Edge env PR.
- **No deployment checklist doc.** The audit recommended this as a longer-term `docs/deployment.md` consolidating Vercel + Supabase secrets + Edge Function deploy + post-deploy smoke. Out of scope here.
- **No new dependencies.** No `zod`-based env schema; no `env-var`-style library. The helper is ~15 lines of pure TypeScript.
- **No `.env.local` / `.env.test` modification.** Local secrets were never read or written by this PR.
- **No `decisions-and-triggers.md` update.** No new architecture decision was introduced — this PR implements an audit recommendation that fits within existing patterns (defense-in-depth + actionable fail-fast); no durable design rule needed.
- **No Vercel project settings change.** Deployment env configuration in Vercel is out of scope for code PRs.
- **No `vite.config.ts` change** (no `envPrefix` override, no new plugin).
- **No commercial / billing / mobile / store-readiness doc changes.**

### Files changed

- `src/lib/clientEnv.ts` *(new, 42 lines incl. JSDoc)*.
- `src/lib/__tests__/clientEnv.test.ts` *(new, 50 lines)*.
- `src/integrations/supabase/client.ts` — 3-line change (import + two `requireClientEnv` substitutions) + 4-line comment.
- `README.md` — new "Environment setup" subsection; test count `276` → `285`.
- `.env.test.example` — 3-line trailing comment documenting optional `BASE_URL`.
- `docs/migration-history.md` — this entry.
- `docs/start-here.md` — short handoff entry above the PR #137 bulk-delete entry.

### Test counts

Vitest: **281/281 → 285/285** (+4 new tests in the new `clientEnv.test.ts` file). Playwright unchanged at **71/71** and not re-run from this branch — the change is build-time/module-load behavior, not runtime UI; Playwright sessions all start with valid env vars and hit the success path, which is bit-identical to pre-PR behavior.

### Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run src/lib/__tests__/clientEnv.test.ts` — 4/4.
- `npx vitest run` — 285/285 (was 281/281).
- `npx eslint` on the three touched source / test files (`clientEnv.ts`, `clientEnv.test.ts`, `client.ts`) — 0 errors, 0 warnings.
- **Playwright not run.** No fixture exercises a missing-env-var path; the change is invisible to a configured environment.
- **No Supabase migration validation.** This PR adds no migration.
- **No Edge Function deploy.** This PR does not touch `supabase/functions/`.

### Behavior on legitimate users

**Identical.** With both env vars correctly set (as is the case for every developer, CI runner, Playwright session, and production Vercel build today), `requireClientEnv` returns the value and the Supabase client is constructed exactly as before. The only observable change is the **failure-mode** error message — and only when one of the vars is missing or empty, which currently never happens in any working deploy.

### Risk

**Very low.** The helper is one if-statement and one throw. The Supabase client change is mechanical and exercised by every existing unit and E2E test (they all import the module). The README addition is documentation only. The `.env.test.example` addition is a commented-out optional override (no semantic change to required values). No new dependencies, no schema changes, no migration, no deploy ceremony.

### Non-goals

- No README change beyond Environment setup and the stale test count normalization.
- No `decisions-and-triggers.md` change.
- No commercial / billing / mobile / store-readiness changes.
- No Edge Function changes, no `Deno.env.get` changes, no Edge Function deploy.
- No real env values printed, logged, or committed.
- No dependencies added.
- No support for legacy unused vars (`VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_PROJECT_ID`).
- No URL-format validation (deliberately out of scope — would expand the helper and require a richer test surface; the audit explicitly recommended avoiding this in PR 1).

## Edge Function env fail-fast validation + Gemini secret docs

**Date:** May 2026 (second PR in the production-readiness phase that follows the S1/S2 ownership-hardening sequence PRs #130–#137; direct follow-up to PR #138).
**What:** Adds a Deno-side env validator (`supabase/functions/_shared/env.ts`) used by both Edge Functions to fail fast with an actionable, project-specific error when any required Edge env var (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) is missing or empty. Removes the `Deno.env.get(...) ?? ""` empty-string fallbacks at all four call sites (two per function). Updates README's "Supabase Edge Functions" section to document `GEMINI_API_KEY` setup via `supabase secrets set` and to list the two-function deploy commands explicitly. **No schema, no RPC, no migration, no RLS, no generated-types changes. No commercial-doc changes. No new dependencies.**

**Why:** The post-PR-#137 production-hardening env audit (see `docs/start-here.md`) identified the `Deno.env.get(...) ?? ""` pattern as a minor / theoretical fail-fast gap — the Supabase Edge runtime auto-injects both vars in production, so the fallback path is in practice unreachable, but a runtime-broken or unusually-configured environment would have produced an opaque downstream `auth.getUser()` failure instead of a clear "missing env var X" error. The audit also noted `GEMINI_API_KEY` was not documented in any repo doc: maintainers had to read the Edge Function source to know it was required. Both gaps are now closed.

### Sites changed

| File | Change |
|---|---|
| `supabase/functions/_shared/env.ts` *(new, sibling of the client-side `src/lib/clientEnv.ts` introduced in PR #138)* | `requireEdgeEnv(name): string` — reads `Deno.env.get(name)`, throws on `undefined` / non-string / empty / whitespace-only with the message `Missing required Edge Function environment variable: ${name}. Set it in Supabase secrets or confirm it is auto-injected by the Supabase Edge runtime.` JSDoc explains the inventory (which vars each function needs) and the deliberate decision to NOT route `GEMINI_API_KEY` through the helper — its existing bespoke message (`GEMINI_API_KEY not configured in Supabase secrets`) is sharper for that single-cause case than the helper's dual-cause phrasing. |
| `supabase/functions/analyze-paper/index.ts` | New `import { requireEdgeEnv } from "../_shared/env.ts";`. Two `Deno.env.get(...) ?? ""` reads (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) → `requireEdgeEnv(...)`. `GEMINI_API_KEY` validation block left untouched. Auth header handling, `createClient` options, CORS behavior, Gemini analysis behavior, error response shapes, and existing logging — all preserved. |
| `supabase/functions/fetch-paper-metadata/index.ts` | Same shape: new import + two reads converted. PubMed API key behavior (per-user, read from `profiles.pubmed_api_key`), metadata fetch behavior, CORS, error responses — all preserved. |
| `README.md` | "Supabase Edge Functions" section: deploy commands expanded from a single placeholder to two concrete `supabase functions deploy <name> --project-ref <project-ref>` lines (one per function); new "Required Edge Function secrets" table listing the three vars with their sources (auto-injected vs. manually-set); a single `supabase secrets set GEMINI_API_KEY=<your-gemini-api-key> --project-ref <project-ref>` example with placeholder only (no real key); explicit note that the functions now fail fast on missing Edge env vars; explicit note that `SUPABASE_SERVICE_ROLE_KEY` is NOT needed; preserves the existing `verify_jwt = false` explanation. |

### Deployment requirement after merge

Edge Function code changed — a merge does **not** push the new helper / validation to the live functions. After this PR lands, deploy both affected functions:

```sh
supabase functions deploy analyze-paper --project-ref <project-ref>
supabase functions deploy fetch-paper-metadata --project-ref <project-ref>
```

`supabase db push` is **not** needed — no migration was added. The `GEMINI_API_KEY` secret must already exist in Supabase project secrets for `analyze-paper` to operate (it was required before this PR too; this PR only documents it).

### What's NOT in this PR

- **No client env changes from PR #138.** `src/lib/clientEnv.ts` and `src/integrations/supabase/client.ts` are untouched.
- **No deployment checklist doc.** A consolidated `docs/deployment.md` (Vercel env + Supabase secrets + Edge Function deploy + post-deploy smoke) remains deferred per the audit's longer-term recommendation. This PR adds the minimum necessary deploy doc in README only.
- **No `GEMINI_API_KEY` helper conversion.** The existing in-source `throw new Error("GEMINI_API_KEY not configured in Supabase secrets")` is deliberately preserved — its single-cause wording is sharper than the generic helper's dual-cause phrasing.
- **No new dependencies.** Pure Deno + TS.
- **No migration / RPC / RLS / schema / generated-types changes.**
- **No service-role / admin / JWT-secret introduction.**
- **No commercial / billing / mobile / store-readiness doc changes.**
- **No deploy command run from this PR.** The deploy ceremony is the operator's responsibility post-merge.
- **No real secret values printed, logged, or committed.** README uses `<placeholder>` syntax only.

### Files changed

- `supabase/functions/_shared/env.ts` *(new)*.
- `supabase/functions/analyze-paper/index.ts` — 1 new import line + 2-line read substitution + 5-line comment.
- `supabase/functions/fetch-paper-metadata/index.ts` — 1 new import line + 2-line read substitution + 4-line comment.
- `README.md` — "Supabase Edge Functions" section expansion.
- `docs/migration-history.md` — this entry.
- `docs/start-here.md` — short handoff entry above the PR #138 entry.

### Tests / verification

- `npx tsc --noEmit` — clean. **Note:** `tsconfig.app.json` only `include`s `src`, and `tsconfig.node.json` only `include`s `vite.config.ts`. Edge Functions under `supabase/functions/` are **NOT** covered by `npx tsc --noEmit` because they target the Deno runtime with HTTPS imports (`https://esm.sh/...`) and a `Deno.env` global, neither of which the project's TS config supports. Static checking for Edge Function code is normally the Supabase CLI's Deno linter — Deno was not installed in this environment (`which deno` → not found), so the formal Deno check is **deferred to the post-merge deploy step**, where `supabase functions deploy <name>` runs the Deno bundler and surfaces any compile error before publishing. Manual review confirmed: import path (`../_shared/env.ts`) is correct relative to each Edge Function index, the `Deno.env.get` call site signature is unchanged, and the helper is invoked with string-literal args.
- `npx vitest run` — 285/285 (unchanged from PR #138; the Edge Function code is not exercised by Vitest because Vitest runs in Node/jsdom, not Deno).
- `npx eslint` on the three touched Edge Function files — exit 0, no errors. (ESLint covers `**/*.{ts,tsx}` per `eslint.config.js`; the `Deno` global is not declared as a known global so ESLint may silently treat it as undefined — same behavior as on `main` for the pre-existing `Deno.env.get` calls.)
- **No Playwright run.** Edge Function code is not exercised by the local Playwright suite — `analyze-paper` invocations require a deployed live function with `GEMINI_API_KEY` set, which the test environment doesn't currently exercise.
- **No Supabase migration validation.** This PR adds no migration.
- **No `supabase functions deploy` from this PR.** Deferred to the operator.

### Behavior on legitimate runtime

**Identical.** With both Edge env vars correctly auto-injected (as is the case for every working Supabase Edge runtime today), `requireEdgeEnv` returns the value and `createClient` is constructed exactly as before. The only observable change is the **failure-mode** error message — and only when one of the vars is missing or empty, which currently never happens in any working deploy. The runtime path inside the request handler (auth check → caller-token client → in-function `getUser()` → business logic) is bit-identical.

### Risk

**Very low.** The helper is one if-statement and one throw. The two call-site swaps are mechanical. README documentation is additive. The only new failure mode is "throw with actionable message instead of empty-string-into-broken-client downstream failure" — strictly better diagnostics, no new way for the function to fail in steady state. No new dependencies; no new deploy artifacts beyond the existing two functions.

### Non-goals

- No client env helper changes from PR #138.
- No conversion of `GEMINI_API_KEY` validation to the helper (preserves the sharper bespoke message).
- No README change beyond the "Supabase Edge Functions" section expansion.
- No `decisions-and-triggers.md` update (no new architecture decision — same defense-in-depth pattern as PR #138).
- No `architecture-read-path.md` update.
- No commercial / billing / mobile / store-readiness changes.
- No deployment checklist doc.

## Deployment checklist / release runbook (docs-only)

**Date:** May 2026 (closing entry of the production-hardening sequence PRs #130–#139; docs-only consolidation, no code).
**What:** New file [`docs/deployment.md`](deployment.md). Operator-facing checklist consolidating the deployment steps that previously lived across the README ("Local development", "Supabase Edge Functions", "Testing"), `start-here.md` (deploy callouts inline with PR entries), and individual `migration-history.md` entries (PR #131 / #132 reconciliation pattern, PRs #120 / #121 Edge Function deploy reminders, PR #138 / #139 env-validation behavior). Adds two pointer links from `README.md` (one in the docs table, one immediately after the Edge Functions deploy commands). Adds a handoff entry in `start-here.md` above the PR #139 entry.

**Why:** PR #139 closed the env-validation work; the post-merge audit recommendation was to follow up with a central deployment runbook so future contributors / operators don't have to reconstruct the deploy sequence from PR history. With ten production-hardening PRs landed in two weeks and a non-trivial mix of client / migration / Edge Function deploy ceremonies, the lack of a single source of truth was the biggest remaining operational risk.

### What's in `docs/deployment.md`

- §1 Purpose — operator-runbook scoping.
- §2 Deployment types table — PR scope → required deploy action mapping.
- §3 Required environment variables — split into client / Vercel, Edge Function secrets (manually set), and auto-injected by the Edge runtime.
- §4 Pre-merge checklist — CI green, scope match, docs updated, migration-specific and Edge-specific extras.
- §5 Pre-deploy local checks — the standard four commands (`tsc`, `vitest`, `eslint`, `supabase migration list --linked`) with notes on tsc/Edge-Function coverage.
- §6 Supabase migration deployment — standard six-step sequence plus a warnings subsection codifying the PR #131 / #132 lessons (don't blindly use `--include-all`; don't repair without audit; current ledger is aligned through `20260518010000`).
- §7 Edge Function deployment — per-function commands; rule that touching `_shared/*` requires redeploying every consumer.
- §8 Frontend deployment / Vercel — `vercel.json` is SPA-rewrite only; env vars live in Vercel project settings; explicit "operator-decides" callouts for branch protection / preview / rollback that this repo doesn't codify.
- §9 Post-deploy smoke checklist — by area: general / search / metadata import (PMID `41912805`) / AI analysis / paper ops / projects-tags / attachments.
- §10 Troubleshooting — six common failure modes with symptoms + fixes, all keyed to specific PRs (#136 null-user crash, #138 client env, #139 Edge env, `GEMINI_API_KEY` rotation, #131/#132 migration drift, blank-screen Vercel).
- §11 What not to do — guard-rails: no service-role in client; no committed secrets; no `db push` for docs-only; no `--include-all` outside reconciliation; no assumption Vercel deploys Edge Functions; correct deploy ordering (migration → Edge Function → frontend).
- §12 Quick links to the other operator-relevant docs.

### Sites changed

| File | Change |
|---|---|
| `docs/deployment.md` *(new)* | The runbook. ~360 lines. Markdown only; no code blocks executed; no real secret values; all commands use placeholder syntax (`<project-ref>`, `<your-gemini-api-key>`). |
| `README.md` | Two pointer links added: one row in the Documentation table; one sentence after the Edge Function smoke-case line. No other README change. |
| `docs/start-here.md` | One handoff entry placed above the PR #139 entry, summarizing the new doc's contents and explicitly noting "no runtime behavior changed". |
| `docs/migration-history.md` | This entry. |

### Files NOT touched

- No source code changed (zero `src/`, `supabase/functions/`, `e2e/`, or `tests/` files in the diff).
- No migration added — `ls supabase/migrations/` unchanged.
- No Edge Function changed.
- No env file changed — `.env.example` and `.env.test.example` are unchanged.
- `docs/decisions-and-triggers.md` — not updated (no new architecture decision; this is operational documentation, not a durable policy rule).
- `docs/architecture-read-path.md` — not updated (no read-path change).
- `docs/commercial-architecture.md`, `docs/quotas-and-pricing.md`, `docs/store-launch-checklist.md` — not updated. The runbook deliberately points operators at the existing commercial planning docs via the Quick Links section but does not modify them; commercial scope remains separate.
- `package.json`, `vite.config.ts`, `vercel.json`, `supabase/config.toml`, generated Supabase types — all unchanged.

### Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 285/285 (unchanged; docs-only PR cannot affect tests).
- Markdown lint — not configured in this repo (`package.json` has no `lint:md` script; no `.markdownlint*` file). Visual review of the new file performed; relative links validated by inspection (`../README.md` resolves; `start-here.md`, `migration-history.md`, `decisions-and-triggers.md`, `documentation-policy.md`, `../src/lib/clientEnv.ts`, `../supabase/functions/_shared/env.ts`, `../vercel.json` all referenced and exist in the tree).
- No Supabase migration validation needed (no migration added).
- No Edge Function deploy needed (no Edge Function code changed).
- No `supabase db push` run.

### Non-goals

- No runtime / behavior change for legitimate users.
- No new architecture decision (no `decisions-and-triggers.md` entry).
- No automation added (Vercel auto-deploy, CI status checks, etc. remain owner-configured in the hosting / CI dashboards, not in this repo).
- No commercial / billing / mobile / store-readiness scope.
- No README rewrite — only the two pointer additions described above.
- No reformatting / re-flow of existing doc content (existing entries in `start-here.md` and `migration-history.md` are left bit-identical above and below the new entries).

## Commercial strategy pivot — web-first PLG + Stripe-first (docs-only)

**Date:** 2026-05-21 (post-PR #140 Pre-Commercial Readiness Audit follow-up).
**What:** Docs-only PR that records the owner-approved commercial pivot from a B2C-only / single-user / Core+AI / 7-day-trial framing to a **web-first Product-Led Growth (PLG)** model with **Stripe-first** web billing, a **Free forever** entry tier, **Pro / Researcher** as the primary self-serve paid SKU at a $15 / month MVP baseline, and **Labs / Teams** as a future B2B "Coming Soon / Contact Sales" tier. **No application code, schema, RPC, RLS, Edge Function, migration, env file, dependency, or deploy. No legal text shipped as final.**

**Why:** The post-PR-#140 Pre-Commercial Readiness Audit established that the engineering foundation is strong but the commercial-product layer is unbuilt, and recommended a small docs-only pivot PR before any schema or billing implementation begins. The owner approved the pivot's strategic direction; this PR captures it as durable documentation so future implementation PRs use the correct commercial direction.

### Sites changed

| File | Change |
|---|---|
| `docs/commercial-architecture.md` | Substantial rewrite. New "MVP product model" (web-first / Stripe-first / Freemium PLG / Free / Pro / Labs-Teams roadmap / English-only). New "Commercial tiers (MVP baselines)" section with three-tier table. New "Launch blockers" section (10 items required before paid beta). New "Recommended future implementation order" (10-step sequence). "Architecture principles" (§2.1–§2.4), "Proposed tables" (§4 — `user_entitlements` / `subscriptions` / `usage_counters` / `subscription_events` / new `usage_credits` placeholder), and "Why commercial state is not added to profiles" (§9) preserved with light adaptations. New "Legal pages location" (§11) records the external-marketing-site decision. |
| `docs/quotas-and-pricing.md` | Replaced trial / Core / AI framing with the Free / Pro / Labs-Teams tier table and explicit "MVP baseline vs final pricing" + "Instrumentation required" sections. Added "Add-on credit packs (future, not MVP)" section. Updated "Inputs that must drive the final numbers" and "Open questions" to match the pivot. |
| `docs/store-launch-checklist.md` | Banner clarifies this is now the **mobile-phase checklist** post-web-launch. Section 1 product-readiness bullets updated to Free / Pro tier language. App Store Connect §6 SKU bullet updated to "Pro monthly / annual, no Trial, no Labs/Teams". Play Console §7 SKU bullet matched. New §8a "Attachments / PDF storage readiness (shared with web launch)" lists the bucket-tightening + quota-trigger items as shared with the web blockers. |
| `docs/decisions-and-triggers.md` | New dated section "Commercial strategy pivot (2026-05-21)" with **C7–C16**. C1 clarified inline (still accurate for shippable MVP; Labs/Teams is roadmap only). C2 marked **superseded by C8**. C3 marked **refined by C8 / C10**. C4 / C5 / C6 unchanged (still valid principles). |
| `docs/owner-decisions.md` *(new)* | Compact ledger: §1 resolved decisions C7–C16 with implementation unlocks; §2 still-pending / needs-validation items grouped by gating phase (before Stripe, before paid pilot, before Labs/Teams becomes sellable, non-gating); §3 next-implementation-PR table matching `commercial-architecture.md §7`. |
| `docs/start-here.md` | New handoff entry above the PR #140 entry summarizing the pivot. |
| `docs/migration-history.md` | This entry. |

### Decisions recorded (in `decisions-and-triggers.md`)

| ID | Decision (one-liner) |
|---|---|
| **C7** | Web-first launch; Apple App Store / Google Play deferred. |
| **C8** | Stripe-first for web billing. Stripe implementation blocked until entitlement schema + AI quota enforcement exist. |
| **C9** | Freemium PLG replaces 7-day time-based trial. No `trialing` state in MVP. |
| **C10** | No paid AI-free "Core" tier in MVP. Two-tier MVP: Free → Pro. |
| **C11** | Free + Pro MVP baselines. Numeric values are MVP baselines with mandatory instrumentation — not permanent. |
| **C12** | Labs / Teams is "Coming Soon / Contact Sales" only. Not sellable until shared-libraries + seat-management architecture exists. |
| **C13** | Add-on AI credit packs — future feature; architecture must support from day one. |
| **C14** | Attachments in launch scope; privacy hardening + storage-quota enforcement are launch blockers. |
| **C15** | Hebrew / RTL out of scope for MVP. |
| **C16** | Legal pages on external marketing site. Repo links to HTTPS URLs. |

### What's NOT in this PR

- No application code changes — no `src/`, no `e2e/`, no `package.json`.
- No migrations — no `supabase/migrations/`.
- No Edge Function changes — no `supabase/functions/`.
- No Stripe SDK / billing dependency added.
- No entitlement / quota schema (next PR).
- No quota enforcement code.
- No storage bucket policy change.
- No env file changes.
- No final legal text — drafts not yet authored; reference is to a future external marketing site.
- No deploy. No `supabase db push`. No `supabase functions deploy`.

### Test counts

Vitest **285/285** (unchanged — docs-only). Playwright unchanged at the previously documented count; not re-run (docs change cannot affect E2E behavior).

### Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 285/285.
- Markdown lint — **not run.** The repo has no markdown linter configured (`package.json` has no `lint:md` script; no `.markdownlint*` file). Visual review performed.
- No Supabase migration validation (no migration added).
- No Edge Function deploy (no Edge Function changed).
- No `supabase db push`.

### Behavior on legitimate users

**No change.** Docs-only PR. The running app's runtime behavior is bit-identical to `main` immediately before this PR.

### Risk

**Very low.** Documentation accuracy is the only failure mode (e.g., a future contributor reading a stale decision). Mitigated by the inline supersession notes on C1 / C2 / C3 and by `owner-decisions.md` §1 acting as the index of the latest position.

### Non-goals

- No implementation. The implementation phases (entitlement schema → AI quota → attachments privacy + quota → Stripe → UI paywall → privacy/account-deletion/AI disclosure → closed beta → paid pilot → open beta) are documented in `commercial-architecture.md §7` and `owner-decisions.md §3` but not executed here.
- No legal text drafted as final.
- No commitment of any specific final price beyond the documented MVP baselines.
- No commitment to a marketing site provider, monitoring provider, support channel, or staging timing — all listed as pending in `owner-decisions.md §2.1`.

## Commercial foundation — entitlement and usage schema

**Date:** 2026-05-21 (first implementation PR after the PR #141 commercial strategy pivot).
**What:** New migration `20260521010000_add_entitlement_usage_schema.sql`. Creates five tables — `user_entitlements`, `subscriptions`, `usage_counters`, `subscription_events`, `usage_credits` — that constitute the internal commercial read model and the foundation for the future AI quota enforcement RPCs and Stripe webhook ingestion. Extends the canonical `public.handle_new_user()` trigger to also seed the default Free entitlement and the lifetime AI counter on every new signup. Backfills existing `auth.users` rows. **No application code, no Edge Function, no Stripe SDK, no UI changes, no generated-types update, no env file changes.** Migration is prepared in the repo but **not deployed** — the user runs `supabase db push` after merge per the standard sequence in `docs/deployment.md`.

**Why:** PR #141 (2026-05-21) approved the web-first PLG strategy and explicitly named "entitlement + usage schema" as the next implementation PR (per [commercial-architecture.md §7](commercial-architecture.md) item 2 and [owner-decisions.md §3](owner-decisions.md) item 2). This PR is the single bottleneck unblocking three downstream phases: server-side AI quota enforcement (which reads from these tables), storage-quota enforcement (which reads `user_entitlements.storage_quota_bytes`), and Stripe webhook ingestion (which writes to `subscriptions` and recomputes `user_entitlements`). Stripe implementation is **explicitly blocked** by C8 until this schema exists; the unblock lands with this PR's merge + remote deploy.

### Tables created

| Table | Purpose | Client access | Writes |
|---|---|---|---|
| `user_entitlements` | Hot-path read model: plan, status, paper/storage/AI quotas, premium-taxonomy flag, period bounds. One row per user. | **SELECT-own only** (`auth.uid() = user_id`). | Server-only (future Stripe webhook / admin RPC). |
| `subscriptions` | Provider-normalized billing state. Provider-neutral schema supporting `stripe` (MVP), `apple` / `google` / `revenuecat` / `manual` (future). | **No client policy** — the UI reads `user_entitlements`, not raw subscription rows. | Server-only. |
| `usage_counters` | Per-user, per-feature, per-period (lifetime / monthly) usage counters. `feature='ai_analysis'` for now. Uses `'epoch'::timestamptz` sentinel for lifetime `period_start` so uniqueness works without NULL handling. | **No client policy** — future `consume_ai_quota` RPC reads on the user's behalf via SECURITY DEFINER. | Server-only. |
| `subscription_events` | Append-only audit log of provider webhook / S2S events. Provider + `provider_event_id` uniqueness gives idempotency. | **No client policy** — operator / support reads via service-role only. | Server-only. |
| `usage_credits` | Placeholder for future add-on AI credit packs (C13). Schema shape exists from day one so the future `consume_ai_quota` RPC can fall through to credits after the quota wall. NOT consumed in MVP. | **SELECT-own** (anticipating Settings → Credits view). | Server-only. |

### Important columns and constraints

- `user_entitlements.plan` ∈ `{free, pro, labs_team}` — `labs_team` reserved per C12; not sellable in MVP.
- `user_entitlements.plan_status` ∈ `{active, trialing, past_due, canceled, incomplete, paused}` — `trialing` retained for **provider-state compatibility** (Stripe may emit it if an SKU later attaches an introductory offer), with an inline comment noting MVP doesn't generate trialing rows on the application-write path (C9 — no time-based trial).
- `subscriptions.status` covers the full Stripe-compatible set: `{active, trialing, past_due, canceled, incomplete, incomplete_expired, paused, unpaid}`.
- `subscriptions.provider` and `subscription_events.provider` constrained to `{stripe, apple, google, revenuecat, manual}` (matches `commercial-architecture.md §8`).
- All quota / limit columns are non-negative (`CHECK (quota >= 0)`).
- `usage_credits.quantity_remaining <= quantity_granted` (CHECK) and `quantity_granted > 0`.
- Unique `(provider, provider_subscription_id)` on `subscriptions` and `(provider, provider_event_id)` on `subscription_events` for idempotent webhook ingestion.

### Free-tier seed defaults (column defaults on `user_entitlements`)

| Column | Value |
|---|---|
| `plan` | `free` |
| `plan_status` | `active` |
| `paper_limit` | 1500 |
| `storage_quota_bytes` | 524288000 (500 MB) |
| `ai_lifetime_quota` | 15 |
| `ai_monthly_quota` | 0 |
| `premium_taxonomy_enabled` | `false` |
| `labs_team_enabled` | `false` |

These match the C11 MVP baselines in [quotas-and-pricing.md §2](quotas-and-pricing.md). Numeric values are explicitly **MVP baselines with instrumentation** — not permanent — per C11.

### Indexes

- `user_entitlements`: unique `(user_id)`; `(plan)`; partial `(billing_provider, billing_customer_id)`; partial `(billing_provider, billing_subscription_id)`.
- `subscriptions`: unique partial `(provider, provider_subscription_id)`; `(user_id)`; partial `(provider, provider_customer_id)`; `(status)`.
- `usage_counters`: unique `(user_id, feature, period_type, period_start)`; `(user_id, feature, period_type)`.
- `subscription_events`: unique `(provider, provider_event_id)`; `(user_id)`; `(subscription_id)`; `(event_type)`; `(created_at DESC)`.
- `usage_credits`: `(user_id, feature)`; partial `(expires_at)` WHERE NOT NULL; partial unique `(provider, provider_reference_id)` WHERE both NOT NULL.

### RLS posture

`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on all five tables (canonical posture from `20260412030000_fix_rls_all_tables.sql`). Two SELECT-own policies (`user_entitlements`, `usage_credits`). **No INSERT / UPDATE / DELETE policy on any of the five tables.** All commercial state is server-write-only. Future Stripe webhook ingestion runs as service-role inside an Edge Function and bypasses RLS by design.

### Signup trigger behavior

`public.handle_new_user()` (the canonical signup trigger, last reset by `20260411010000`) is rewritten in this migration to do three idempotent INSERTs per new `auth.users` row:

1. `INSERT INTO public.profiles (user_id, email)` — unchanged from prior migration.
2. `INSERT INTO public.user_entitlements (user_id)` — column defaults supply the Free baseline.
3. `INSERT INTO public.usage_counters (user_id, feature, period_type, period_start) VALUES (NEW.id, 'ai_analysis', 'lifetime', 'epoch'::timestamptz)` — lifetime counter at zero.

Every INSERT has `ON CONFLICT … DO NOTHING` so the trigger is safe to re-run / re-apply against a partially-populated state. `SECURITY DEFINER SET search_path = public` preserved from the prior version. The trigger attachment (`on_auth_user_created`) is dropped and recreated to ensure the new function body takes effect.

### Backfill behavior

Migration end runs two idempotent backfill INSERTs:

- One `user_entitlements` row per existing `auth.users` user (`ON CONFLICT (user_id) DO NOTHING`).
- One lifetime `ai_analysis` `usage_counters` row per existing user (`ON CONFLICT (user_id, feature, period_type, period_start) DO NOTHING`).

Re-running the migration on a partially-populated remote (e.g., the trigger has already created rows for users who signed up between phases) is a safe no-op for existing rows.

### What is intentionally NOT included

- No `consume_ai_quota` / `refund_ai_quota` SECURITY DEFINER RPCs (next PR).
- No change to `analyze-paper` Edge Function. Quota is **not enforced yet** by this PR.
- No `BEFORE INSERT` trigger on `paper_attachments` for storage quota (separate PR).
- No change to the `attachments` Storage bucket SELECT policy (separate PR; C14 launch blocker).
- No Stripe Checkout, no `stripe-webhook` Edge Function, no Stripe dependency.
- No UI / Settings surface, no paywall, no upgrade nudge.
- No generated-types update in `src/integrations/supabase/types.ts` — the new tables are not yet read by any client hook, so the type drift is harmless until a future PR adds a hook against `user_entitlements`. Per the task brief: when uncertain about generated-types convention, avoid them in this PR.
- No env file changes; no `package.json` changes; no new dependency.

### Verification

- `supabase stop --no-backup` — clean.
- `supabase start` (from this worktree) — all 58 migrations replay successfully end-to-end. Container set up clean.
- Schema verification (via `docker exec supabase_db_lioxtgiputfniqbktcsz psql …`):
  - All 5 new tables present in `public`.
  - `pg_class.relrowsecurity = t` AND `relforcerowsecurity = t` on all 5.
  - `pg_policies` shows exactly two `SELECT` policies (`user_entitlements`, `usage_credits`), both `(auth.uid() = user_id)`; zero INSERT/UPDATE/DELETE policies on any of the five tables.
  - Trigger smoke: inserted one row into `auth.users`; `handle_new_user` fired and created a row in `profiles` + `user_entitlements` + `usage_counters` with exactly the documented Free defaults (`plan=free, plan_status=active, paper_limit=1500, storage_quota_bytes=524288000, ai_lifetime_quota=15, ai_monthly_quota=0, premium_taxonomy_enabled=f, labs_team_enabled=f`; counter `feature=ai_analysis, period_type=lifetime, period_start=1970-01-01 00:00:00+00, used=0, reserved=0`). Deleting the `auth.users` row cascaded out the derived rows correctly.
  - Backfill on empty `auth.users` produced zero rows in the derived tables, as expected.
- `npx tsc --noEmit` — clean (no source changes).
- `npx vitest run` — 285/285 (unchanged; no test code touched).
- `supabase migration list --linked` (run from the linked main worktree) — Local = Remote through `20260518010000`; the new `20260521010000` is **not yet on remote**, as intended.
- **`supabase db push` was NOT run.** Remote deployment is the operator's next step per the standard sequence in `docs/deployment.md`.

### Deployment note

Standard sequence per `docs/deployment.md §6.1`:

```sh
supabase migration list --linked       # confirm Local = Remote through 20260518010000
supabase db push --dry-run             # should list ONLY 20260521010000_add_entitlement_usage_schema.sql
supabase db push                       # apply
supabase migration list --linked       # confirm new row aligned
```

Post-deploy spot-check SQL (Supabase Studio):

```sql
SELECT count(*) FROM public.user_entitlements;   -- == count(*) FROM auth.users
SELECT count(*) FROM public.usage_counters
  WHERE feature='ai_analysis' AND period_type='lifetime';   -- == count(*) FROM auth.users
SELECT plan, plan_status, paper_limit, storage_quota_bytes,
       ai_lifetime_quota, ai_monthly_quota, premium_taxonomy_enabled
  FROM public.user_entitlements
  WHERE user_id = '<owner-uid>';                  -- should show the Free defaults
```

No Edge Function deploy needed (no `supabase/functions/` change).

### Risk

**Very low.** Migration adds new tables only — no schema mutation on existing tables. The single existing-object change is `CREATE OR REPLACE FUNCTION public.handle_new_user()`, which extends the prior signup behavior with two additional idempotent INSERTs and an `ON CONFLICT DO NOTHING` on the existing `profiles` INSERT (slightly more defensive than the prior version). Backfill statements are idempotent.

### Non-goals

- No AI quota enforcement.
- No Stripe integration.
- No storage-quota enforcement (separate launch-blocker PR per C14).
- No attachments bucket privacy change (separate launch-blocker PR per C14).
- No UI surface for plan / quota / billing.
- No new architecture decision in `decisions-and-triggers.md` — this PR implements C7–C16 from PR #141 without introducing a new durable rule.
- No README test-count change (Vitest stays at 285/285).

## Commercial foundation — AI quota enforcement

**Date:** 2026-05-21 (second implementation PR after the PR #141 commercial strategy pivot; direct follow-up to PR #142's schema landing).
**What:** New migration `20260521020000_add_ai_quota_rpcs.sql` adding two SECURITY DEFINER RPCs (`consume_ai_quota`, `refund_ai_quota`) plus the integration into `supabase/functions/analyze-paper/index.ts` so AI quota is now enforced server-side **before** Gemini is called. Closes the AI cost-exposure gap that PR #142 left in place. **No Stripe, no UI changes, no client hook changes, no storage-quota trigger, no attachments bucket policy change, no generated-types update, no env file change, no dependency.** Edge Function code changed; deploy required post-merge.

**Why:** PR #142 created the schema but did not enforce quotas. Any authenticated user could call `analyze-paper` repeatedly with no server-side cap on Gemini cost — the 3-second client cooldown is UX-only and trivially bypassable. C8 in `decisions-and-triggers.md` explicitly blocked Stripe integration until server-side AI quota enforcement exists, so this PR is the gating step before Stripe.

### Sites changed

| File | Change |
|---|---|
| `supabase/migrations/20260521020000_add_ai_quota_rpcs.sql` *(new)* | Creates `public.consume_ai_quota(p_user_id UUID)` and `public.refund_ai_quota(p_user_id UUID)`. Both SECURITY DEFINER + `SET search_path = public` + `#variable_conflict use_column` (resolves the OUT-parameter-vs-table-column ambiguity that breaks `ON CONFLICT (..., period_type, ...)` otherwise). Both gated by the S1 ownership pattern from PR #130 (`IF p_user_id IS NULL OR auth.uid() IS NULL OR p_user_id <> auth.uid() THEN RAISE EXCEPTION 'Unauthorized: user mismatch'`). Grant pattern matches PR #130 (`REVOKE … FROM PUBLIC; GRANT EXECUTE … TO authenticated`; the runtime `auth.uid() IS NULL` check blocks any residual anon EXECUTE grant from Supabase's default privileges). |
| `supabase/functions/analyze-paper/index.ts` | Inserts a quota consume between auth+input-parse and the Gemini call; wraps the Gemini-and-parse block in an inner try/catch that issues a best-effort refund on failure. New `safeRefundAiQuota(supabase, userId)` helper at the top of the file (structural `RpcClient` type, no `any`). Auth, CORS, request validation, Gemini prompt / body, JSON-clean / parsing, success response shape, and the outer 500 generic-error catch-all are bit-identical to the pre-quota version. |

### RPC return shapes

`consume_ai_quota` returns `TABLE (allowed boolean, reason text, plan text, period_type text, used integer, quota integer, remaining integer, reset_at timestamptz)`. Reasons used: `'ok'`, `'quota_exceeded'`, `'missing_entitlement'`, `'inactive_entitlement'`. On `allowed=false` no counter increment happens; on `allowed=true` exactly one increment happens.

`refund_ai_quota` returns `TABLE (refunded boolean, period_type text, used integer)`. Best-effort: returns `(false, NULL, 0)` when there's no entitlement or no counter, never raises. Decrement is `GREATEST(used - 1, 0)` so duplicate refunds are not destructive.

### Quota selection rule

The RPCs choose the quota bucket the same way:

- **`ai_monthly_quota > 0`** → monthly bucket. `period_start = date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC'`; `period_end = period_start + INTERVAL '1 month'`.
- **Else if `ai_lifetime_quota > 0`** → lifetime bucket. `period_start = 'epoch'::TIMESTAMPTZ`; `period_end = NULL`.
- **Else (both zero)** → `quota_exceeded`.

This matches the C11 baselines: Free has `ai_lifetime_quota=15, ai_monthly_quota=0` and hits the lifetime branch; Pro will have `ai_monthly_quota=350, ai_lifetime_quota=0` and hit the monthly branch.

### Concurrency / atomicity

The consume function takes a row-level `SELECT … FOR UPDATE` lock on `user_entitlements` to serialize per-user quota consumption against any concurrent webhook-driven entitlement mutation (a Pro recompute landing while the user is analyzing). The increment itself is `UPDATE … WHERE used < quota RETURNING used`, which is race-safe across two concurrent analyzes: even if both sessions read the same `used` value, only one passes the WHERE predicate on the actual UPDATE (Postgres row-level locking around the UPDATE serializes the matched row). Two simultaneous `consume_ai_quota` calls cannot both succeed and double-spend a quota unit.

### Edge Function flow

```
CORS preflight        → unchanged
Auth header check     → unchanged
auth.getUser()        → unchanged (401 on failure)
Parse body            → unchanged (400 on invalid abstract)
consume_ai_quota RPC  → NEW
  • RPC error         → 500 generic (no quota consumed)
  • allowed=false     → 402 with structured { error, message, details: { plan, period_type, used, quota, remaining, reset_at } }
  • allowed=true      → proceed (quota incremented by 1)
GEMINI_API_KEY check  → on missing: refund + throw (outer catch → 500)
Inner try:
  fetchWithRetry      → unchanged
  parse JSON          → unchanged
  return 200 with     → unchanged (tldr, studyType, statisticalMethods)
Inner catch:
  refund_ai_quota     → best-effort, errors swallowed
  rethrow             → outer catch returns 500 generic
```

### Behavior on quota exhaustion

When `consume_ai_quota` returns `allowed=false`, the Edge Function returns HTTP **402 Payment Required** with this body:

```json
{
  "error": "quota_exceeded",
  "message": "AI analysis quota exceeded.",
  "details": {
    "plan": "free",
    "period_type": "lifetime",
    "used": 15,
    "quota": 15,
    "remaining": 0,
    "reset_at": null
  }
}
```

Gemini is **not called**. No cost incurred. The current client treats non-2xx as generic — UI quota-state work lands in a later PR; the structured `details` block is ready for that UI without an Edge Function change.

### What is intentionally NOT included

- ❌ No Stripe Checkout / webhook ingestion (separate PR per C8).
- ❌ No client UI for quota state, paywall, upgrade nudge (separate PR).
- ❌ No `BEFORE INSERT` storage quota trigger on `paper_attachments` (separate launch-blocker PR per C14).
- ❌ No `attachments` bucket SELECT policy change (separate launch-blocker PR per C14).
- ❌ No `usage_credits` consumption (future per C13; not MVP).
- ❌ No `src/integrations/supabase/types.ts` regeneration — the new RPCs are not yet called from client code; the Edge Function uses `supabase.rpc()` which is untyped at the call site.
- ❌ No new dependency, no env file change, no `package.json` change.
- ❌ No deploy commands run from this PR.

### Verification

- **Local replay (`supabase stop --no-backup` + `supabase start`)**: clean across all 60 migrations (57 prior + PR #142 + this PR's RPCs).
- **Function definitions exist**: `pg_proc` shows both `consume_ai_quota` and `refund_ai_quota` with `prosecdef=t` (SECURITY DEFINER) and `proconfig={search_path=public}`.
- **Functional test (8 cases via copied `/tmp/quota_test.sql`)**:
  1. ✅ Trigger creates entitlement (Free defaults) + lifetime counter at `used=0` on new signup.
  2. ✅ Anon (no JWT context) → `Unauthorized: user mismatch` raised.
  3. ✅ Authenticated consume → `(allowed=t, reason=ok, plan=free, period_type=lifetime, used=1, quota=15, remaining=14, reset_at=NULL)`; refund → `used=0`; double-refund → `used=0` (floored at zero, not negative).
  4. ✅ Exhaustion (used=15) → `(allowed=f, reason=quota_exceeded, used=15, quota=15, remaining=0)`; `used` stays 15 (no over-increment).
  5. ✅ Pro monthly path (UPDATE entitlement to `ai_monthly_quota=350, ai_lifetime_quota=0`) → consume creates a new `usage_counters` row with `period_type=monthly`, `period_start = 2026-05-01 UTC`, `period_end = 2026-06-01 UTC`; returns `(allowed=t, reason=ok, plan=pro, period_type=monthly, used=1, quota=350, remaining=349, reset_at=2026-06-01 00:00:00+00)`.
  6. ✅ Auth-mismatch (caller sub ≠ p_user_id, both non-null) → `Unauthorized: user mismatch` raised.
  7. ✅ Missing entitlement (entitlement row deleted, then consume) → `(allowed=f, reason=missing_entitlement)`.
  8. ✅ Cleanup via `DELETE FROM auth.users` → cascades out entitlement + counter rows.
- **`npx tsc --noEmit`**: clean. The Edge Function file is **not** covered by `tsc` (Edge Functions target Deno; tsconfig only includes `src`). Static check for Edge Function code happens at `supabase functions deploy` time via Deno bundling.
- **`npx vitest run`**: 285/285 (unchanged; no test code touched).
- **`npx eslint supabase/functions/analyze-paper/index.ts`**: clean (0 errors, 0 warnings). Initial `// deno-lint-ignore no-explicit-any` workaround was replaced with a proper structural `RpcClient` type.
- **`deno check`**: not run; Deno is not installed in this environment. The `supabase functions deploy` step at remote-deploy time runs the canonical Deno bundler and surfaces any compile error before publishing.
- **`supabase migration list --linked`**: Local = Remote through `20260521010000` (PR #142 deployed); the new `20260521020000` is not yet on remote.
- **`supabase db push`**: not run.
- **`supabase functions deploy`**: not run.

### Deployment instructions (post-merge)

This PR is a **mixed PR** — both a migration and an Edge Function change. Per `docs/deployment.md §2` deployment-types table, the order is migration first, then Edge Function:

```sh
# 1. Migration
supabase migration list --linked       # confirm Local = Remote through 20260521010000
supabase db push --dry-run             # expected: ONLY 20260521020000_add_ai_quota_rpcs.sql
supabase db push                       # apply
supabase migration list --linked       # confirm 20260521020000 row aligned

# 2. Edge Function
supabase functions deploy analyze-paper --project-ref <project-ref>
```

Post-deploy spot-check SQL (Supabase Studio):

```sql
-- Functions exist
SELECT proname FROM pg_proc WHERE proname IN ('consume_ai_quota','refund_ai_quota');

-- Run one AI Analyze in the live app, then:
SELECT used FROM public.usage_counters
WHERE user_id = '<owner-uid>'
  AND feature = 'ai_analysis'
  AND period_type = 'lifetime';   -- should now be 1 (was 0 before the Analyze)
```

Post-deploy smoke (browser):
- Sign in → Dashboard → click Analyze on a paper with an abstract → expected: normal success, `tldr` / `studyType` / `statisticalMethods` populate; `usage_counters.used` increments by 1.
- (Optional, requires DB access) `UPDATE user_entitlements SET ai_lifetime_quota = 1 WHERE user_id = '<owner-uid>'` temporarily, run two Analyzes, expect the second to return 402 `quota_exceeded` with `Gemini NOT called` confirmed in Supabase logs. Restore the quota afterward.

### Behavior on legitimate users

Identical to the pre-quota version **as long as the user is within their quota**. The first 15 analyses on Free (or first 350/month on Pro) succeed exactly as before — same response shape, same UI flow. The behavior change is **only when the quota wall is reached**: instead of unlimited Gemini calls, the Edge Function returns 402 with a structured body and Gemini is not called. The 402 will be invisible to the current UI (which surfaces a generic "AI Analysis failed" toast for any non-2xx) until the next PR adds a quota-aware error handler — that's intentional; this PR establishes the contract, the UI consumes it.

### Risk

**Low.** RPCs use the S1 pattern from PR #130 (extensively tested via the search-RPC sequence). The increment is race-safe via `UPDATE … WHERE used < quota`. Refund is best-effort and floored at zero. The Edge Function happy path is bit-identical pre/post change. Only-new-behavior failure mode: a `consume_ai_quota` RPC outage would return 500 instead of 402, which the UI already handles. A spurious 402 cannot leak any data because the RPC's S1 guard requires `auth.uid() = p_user_id`.

### Non-goals

- No client UI changes (the structured 402 body is unused until a later PR).
- No quota numbers changed; the C11 MVP baselines from PR #141 / PR #142 are unchanged.
- No new architecture decision in `decisions-and-triggers.md` — this PR implements the existing C7–C16 (specifically C8 unblock + C11 enforcement).
- No README test-count change (Vitest stays at 285/285).

## Retro-doc — `20260327100000_private_attachments_bucket.sql` (attachments bucket privacy)

**Date discovered:** 2026-05-21 during PR #144 implementation.
**Status of the migration itself:** already in `supabase/migrations/`, already applied to remote (`supabase migration list --linked` confirms `20260327100000 | 20260327100000`).

**What this retro-doc records:** the migration `20260327100000_private_attachments_bucket.sql` made the `attachments` Supabase Storage bucket private (`public = false`) and replaced the broad `attachments_public_read` SELECT policy (introduced by `20260318020000`) with an owner-scoped `attachments_owner_read` SELECT policy keyed on the existing path prefix (`{userId}/{paperId}/{filename}`, first folder must equal `auth.uid()::text`). That migration was added to the repo and applied to production around 27 March 2026 but never surfaced in `migration-history.md` or `start-here.md` — likely because it was authored through the Supabase / Lovable dashboard workflow before the active documentation-policy from C6.

**Why it matters now:** the post-PR-#140 production-readiness audit and the resulting C14 launch-blocker entry in PR #141 / `owner-decisions.md` §3 both believed the `attachments_public_read` policy was still outstanding. It wasn't. The local schema and remote schema both already had `bucket.public = false` and the owner-scoped SELECT policy in place. The "attachments privacy hardening" half of C14 was closed by `20260327100000`; only the storage-quota-enforcement half remained, and that is what PR #144 (this entry's adjacent commit) implements.

**Retro-doc rather than new migration:** because the schema state is already correct, this is a documentation-only entry. No new migration was created to "redo" the privacy work. The C14 audit gap was a doc/awareness miss, not a code gap.


## Commercial foundation — attachments storage quota enforcement

**Date:** 2026-05-21 (fourth implementation PR after the PR #141 commercial strategy pivot; closes the storage-quota half of the C14 launch blocker. The privacy half was already closed by `20260327100000_private_attachments_bucket.sql` — see retro-doc above).
**What:** New migration `20260521030000_harden_attachment_privacy_and_storage_quota.sql`. Adds a dedicated `user_storage_usage` table (`bigint used_bytes`), BEFORE INSERT and AFTER DELETE triggers on `paper_attachments` for atomic quota enforcement, and a backfill that records existing per-user usage. **No application code, no Edge Function, no Stripe, no UI, no generated-types update, no env file change, no dependency.** Migration-only PR; remote deploy via `supabase db push` is the operator's next step.

**Why:** PR #142 added `user_entitlements.storage_quota_bytes` (Free 500 MB, Pro 2 GB, Labs/Teams future 10 GB) but enforced nothing. Any authenticated user could insert `paper_attachments` rows for arbitrary file sizes; the only cap was the 20 MB per-file limit on the bucket. Closing this is a C14 launch blocker and the last remaining server-side enforcement gap before Stripe per `commercial-architecture.md §6`.

### Scope correction during implementation

Inspection of the migration history revealed that the public-read policy on the `attachments` bucket — the half of C14 that the audit thought was outstanding — was **already** removed by `20260327100000_private_attachments_bucket.sql` (repo-tracked, already applied to remote). The bucket has been `public = false` with an owner-scoped `attachments_owner_read` SELECT policy since March 2026. That earlier migration was undocumented in `migration-history.md` (see the retro-doc entry above). This PR therefore **does NOT modify any storage.objects policies** — creating a redundant `attachments_owner_select` policy would be noise. The migration body addresses only the storage-quota half.

### Sites changed

| File | Change |
|---|---|
| `supabase/migrations/20260521030000_harden_attachment_privacy_and_storage_quota.sql` *(new)* | New `public.user_storage_usage` table (PK on `user_id`, `used_bytes BIGINT`, non-negative CHECK, FORCE RLS, SELECT-own client policy, `updated_at` trigger). Two SECURITY DEFINER trigger functions: `check_and_consume_storage_quota` (BEFORE INSERT — atomic check-and-increment) and `refund_storage_quota` (AFTER DELETE — decrement floored at zero). Two triggers attached to `public.paper_attachments`. Backfill computes real `used_bytes` per existing user from existing attachments. |

### Atomicity / race-safety

The BEFORE INSERT trigger does the check AND the increment in a single atomic UPDATE gated on the quota predicate:

```sql
UPDATE public.user_storage_usage
SET used_bytes = used_bytes + NEW.size_bytes,
    updated_at = now()
WHERE user_id = NEW.user_id
  AND used_bytes + NEW.size_bytes <= v_quota
RETURNING used_bytes INTO v_new_used;

IF v_new_used IS NULL THEN
  RAISE EXCEPTION 'Storage quota exceeded ...';
END IF;
```

If the UPDATE matches a row → trigger returns NEW → `paper_attachments` INSERT proceeds → row inserted. If it matches zero rows (over-quota OR missing entitlement) → `v_new_used` stays NULL → trigger raises → metadata insert fails. Two concurrent INSERTs serialize on the `user_storage_usage` row lock; the second one sees the incremented value and may correctly fail. Because the BEFORE trigger has already incremented, there is NO AFTER INSERT trigger — if the surrounding transaction rolls back, the increment rolls back too (same transaction).

### Backfill behavior

```sql
INSERT INTO public.user_storage_usage (user_id, used_bytes)
SELECT u.id, COALESCE(SUM(pa.size_bytes)::BIGINT, 0)
FROM auth.users u
LEFT JOIN public.paper_attachments pa ON pa.user_id = u.id
GROUP BY u.id
ON CONFLICT (user_id) DO NOTHING;
```

One row per existing `auth.users` user. Idempotent. Users with zero attachments get a zero row so the trigger UPSERT sees an existing row on first upload.

### Why a dedicated `user_storage_usage` table (not `usage_counters`)

`usage_counters.used` is `integer`, capped at ~2.1 GB. Free fits (500 MB), Pro is tight (2 GB), Labs/Teams (10 GB) would overflow silently. Migrating `usage_counters.used` to `bigint` would touch the AI quota RPCs landed in PR #143; the blast radius is larger than a dedicated `bigint`-typed table. The two tables also have semantically different shapes (AI is per-period with `period_start`; storage is a single per-user running total).

### Existing-orphan / existing-overage handling

- **Orphan on metadata reject:** `useAttachments.uploadAttachments` (in `src/hooks/useAttachments.ts`) uploads to Storage FIRST, then inserts metadata. On metadata insert failure it already calls `storage.from('attachments').remove([filePath])` to clean up the orphan. The over-quota error path goes through the same code; no client change needed.
- **Existing overage:** if any existing user is over their Free 500 MB cap when this migration deploys, the backfill records the real `used_bytes`. New uploads are blocked until the user deletes attachments to drop below quota OR until their entitlement is upgraded. No data is destroyed; existing files remain readable via signed URLs.

### Security posture

- New `user_storage_usage` table: `ENABLE ROW LEVEL SECURITY + FORCE ROW LEVEL SECURITY`. Single SELECT-own policy (anticipates future Settings → Storage UI). No INSERT / UPDATE / DELETE policy — writes are server-only via the SECURITY DEFINER triggers.
- Trigger functions: `SECURITY DEFINER SET search_path = public`. They read from `user_entitlements` and write to `user_storage_usage` (both have FORCE RLS and no client write policies). They trust `NEW.user_id` because the existing `paper_attachments` RLS INSERT policy (`auth.uid() = user_id`) already constrains it to the caller's own id — no separate `auth.uid()` guard in the trigger.
- Storage bucket privacy: already private since `20260327100000`. This migration does not modify it.

### Verification

- **Local replay (`supabase stop --no-backup` + `supabase start`)**: clean across all 61 migrations (60 prior + this PR).
- **Schema state**:
  - Storage policies: `attachments_owner_delete` / `attachments_owner_insert` / `attachments_owner_read` / `attachments_owner_update` — all owner-scoped, zero public-read policies.
  - Bucket: `public = false`.
  - New table + columns: `user_storage_usage(user_id uuid PK, used_bytes bigint, created_at timestamptz, updated_at timestamptz)`; RLS enabled + forced.
  - Triggers on `paper_attachments`: `trg_paper_attachments_check_storage_quota` (BEFORE INSERT), `trg_paper_attachments_refund_storage_quota` (AFTER DELETE).
  - Trigger functions: `check_and_consume_storage_quota` and `refund_storage_quota`, both `prosecdef=t` with `proconfig={search_path=public}`.
- **Functional test (9 cases via copied `/tmp/storage_test.sql`)**:
  1. ✅ Fresh user has Free 500 MB entitlement; no `user_storage_usage` row yet (created on first upload via trigger UPSERT).
  2. ✅ 10 MB insert succeeds; `used_bytes = 10,485,760`.
  3. ✅ 200 MB insert succeeds; `used_bytes = 220,200,960`.
  4. ✅ 350 MB insert (would total 560 MB > 500 MB cap) → **raises** `Storage quota exceeded (quota 524288000, attempted +367001600 bytes)`; `used_bytes` stays 220 MB (no partial state).
  5. ✅ Delete 200 MB attachment → `used_bytes` decrements to 10,485,760.
  6. ✅ Negative `size_bytes` → **raises** `paper_attachments.size_bytes must be non-negative (got -100)`.
  7. ✅ Missing entitlement (entitlement row deleted) → **raises** `Missing entitlement: cannot upload attachment for user ...`.
  8. ✅ Pro promotion (2 GB cap) → 200 MB insert succeeds; `used_bytes = 220 MB`.
  9. ✅ `DELETE FROM auth.users` → CASCADE removes `user_storage_usage` row; 0 rows remain.
- **`npx tsc --noEmit`**: clean (no source changes).
- **`npx vitest run`**: 285/285 (unchanged; no test code touched).
- **`npx eslint`**: not run on touched files (migration is SQL; no `.ts` / `.tsx` files changed).
- **Playwright (`e2e/attachments.spec.ts`)**: **not run.** The dev server's `.env` points at the **remote** Supabase project, which doesn't yet have this migration applied. Running Playwright now would exercise the pre-migration behavior (no trigger), which provides no signal for the new triggers. The 9-case SQL functional test exercises every trigger code path more thoroughly than Playwright could (Playwright can't easily push past 500 MB). Post-merge smoke (under the standard `e2e/attachments.spec.ts` upload cases of small PNGs) is the natural validation point.
- **`supabase migration list --linked`**: Local = Remote through `20260521020000` (PRs #142 + #143 deployed); this PR's `20260521030000` not yet on remote.
- **`supabase db push`**: not run.
- **`supabase functions deploy`**: not run (no Edge Function change).

### Deployment instructions (post-merge)

Migration-only PR. Per `docs/deployment.md §2`:

```sh
supabase migration list --linked       # confirm Local = Remote through 20260521020000
supabase db push --dry-run             # expected: ONLY 20260521030000_…
supabase db push                       # apply
supabase migration list --linked       # confirm 20260521030000 aligned
```

Post-deploy spot-check SQL (Supabase Studio):

```sql
-- Schema state
SELECT count(*) FROM public.user_storage_usage;   -- should equal count(*) FROM auth.users
SELECT used_bytes FROM public.user_storage_usage WHERE user_id = '<owner-uid>';

-- Trigger inventory
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.paper_attachments'::regclass AND NOT tgisinternal
ORDER BY tgname;
-- Expected:
--   trg_paper_attachments_check_storage_quota
--   trg_paper_attachments_refund_storage_quota

-- Storage privacy (should be unchanged from the existing 20260327100000 state)
SELECT id, public FROM storage.buckets WHERE id = 'attachments';   -- public = f
SELECT policyname FROM pg_policies
WHERE schemaname='storage' AND tablename='objects' AND policyname ILIKE '%attachments%'
ORDER BY policyname;
-- Expected (no public-read; only owner-scoped):
--   attachments_owner_delete / _insert / _read / _update
```

Post-deploy smoke (browser, optional but recommended):

- [ ] Sign in → upload a small PDF → succeeds; `user_storage_usage.used_bytes` increments by the file size.
- [ ] Delete the same attachment → succeeds; `user_storage_usage.used_bytes` decrements back.
- [ ] (Optional, requires DB access) `UPDATE user_entitlements SET storage_quota_bytes = <current_usage>` to set a very tight cap; attempt to upload a 1 KB file → expect a generic "Failed to save" toast; the `paper_attachments` metadata insert returns the `Storage quota exceeded` error from the trigger and `useAttachments` cleans up the orphan storage object. Restore the cap afterward.

### Limitations / non-goals

- **Client trusts `file.size` for the metadata insert.** A client could in theory spoof a smaller `size_bytes` than the actual uploaded file. The bucket-level `file_size_limit = 20971520` (20 MB) caps the upstream object regardless, so the worst-case spoof is N × 20 MB on a Free 500 MB cap — bounded. Future hardening: verify against `storage.objects.metadata.size` in the trigger or in a deferred reconciliation job. Not in MVP scope.
- **No client UI for storage usage / quota state.** The Edge Function returns generic Postgres errors as toasts; the client surfaces "Failed to save" today. A future client-quota-state PR will read `user_storage_usage` (the SELECT-own policy supports this) and surface a "Storage quota exceeded — upgrade to Pro" toast / Settings gauge.
- **No protection against `paper_attachments` UPDATE corrupting usage.** Today `paper_attachments` has no UPDATE RLS policy, so client UPDATE is blocked. If a future migration adds an UPDATE policy + changes `size_bytes` or `user_id` mid-life, the usage will silently drift. Comment in the migration documents this contract.
- **No new architecture decision in `decisions-and-triggers.md`** — implements existing C14 (storage half) without introducing a new durable rule.

### Risk

**Low.** The new triggers fire on every `paper_attachments` INSERT / DELETE. The happy path under quota is bit-identical to the pre-trigger version (the INSERT succeeds, the row appears in the table). The only new failure mode is "over-quota INSERT fails with Postgres exception" — which the client already handles cleanly (cleans up the orphan storage object, shows generic toast). Race-safe via the atomic check-and-increment UPDATE. Backfill is idempotent.

### Non-goals (recap)

- No Stripe integration.
- No client paywall / quota-state UI.
- No `analyze-paper` / AI quota changes.
- No bucket privacy work (already done by `20260327100000`).
- No `handle_new_user` extension (the trigger UPSERT covers on-demand row creation; extending the signup pipeline is unnecessary surface area).
- No generated-types regeneration (no client hook reads `user_storage_usage` yet).
- No new dependency, no env file, no Edge Function change, no deploy.

## Commercial architecture pivot — Stripe-first superseded by Merchant of Record (MoR)-first (docs-only)

**Date:** 2026-05-21 (same-day pivot — C17 supersedes C8 the day C8 was authored).
**What:** Docs-only PR recording the owner / CMO decision to replace the previously planned Stripe-first web billing direction with a Merchant of Record (MoR)-first direction. Current MoR candidate set: **Paddle** and **Lemon Squeezy**. Final provider selection is pending a separate short provider-selection audit. **No code, no migration, no Edge Function, no Stripe / Paddle / Lemon Squeezy SDK, no dependency, no env file change, no deploy.** Numeric MVP baselines unchanged.

**Why:**

- Stripe does not officially support direct account registration for Israel-based businesses. Creating a US LLC via Stripe Atlas (or equivalent) only to use Stripe is excessive overhead for an independent operator validating MVP — annual US-entity filings, CPA fees, tax-treaty work, and ongoing entity-maintenance cost the project does not need until product-market fit is real.
- MoR providers act as the seller of record for payment collection, invoicing, and international tax / VAT / sales-tax operations (subject to provider terms), which **reduces** operational and compliance overhead for the MVP. This is a "lower compliance overhead in exchange for a higher per-transaction fee" trade — the right one for a single operator at pre-PMF stage.
- The internal entitlement / subscriptions / event-log architecture was already provider-neutral by design (C4), so the pivot affects **only the identity of the chosen web billing provider** — no schema or enforcement code changes.

### What changed

| File | Change |
|---|---|
| `docs/decisions-and-triggers.md` | New **C17** dated 2026-05-21: "Merchant of Record (MoR)-first replaces Stripe-first for web billing". Marks C8 as "**SUPERSEDED by C17**" with a banner pointing readers at C17. C8's text retained verbatim for historical accuracy. |
| `docs/commercial-architecture.md` | New banner paragraph at the top explicitly recording the C17 pivot. §1 billing-provider bullet rewritten in MoR-neutral language. §2.1 narrative updated to "single-provider MVP" instead of "Stripe-first". §3 column descriptions for `subscriptions` updated to record `paddle` / `lemon_squeezy` as candidate values (`stripe` retained as future). §6 launch-blocker #5 rewritten as "MoR provider-selection audit + provider integration". §7 implementation sequence renumbered (5 → audit, 6 → MoR integration, 7 → UI, 8 → privacy/account/AI, 9 → technical beta, 10 → paid pilot, 11 → open beta). §8 heading updated to "MoR-first, multi-provider-ready". §10 non-goals references to Stripe defaults / Stripe annual cost made MoR-neutral. |
| `docs/quotas-and-pricing.md` | New banner paragraph below the strategy-pivot banner recording the C17 pivot. Inline references to "Stripe configuration cost" / "Stripe webhook" / "Stripe fees" / "Stripe defaults" / "Stripe annual SKU" / "Stripe one-time charge" / "Stripe in MVP" replaced with MoR-neutral language. Numeric MVP baseline values unchanged. |
| `docs/owner-decisions.md` | §1 resolved decisions: C8 row marked superseded; new C17 row added. C10 / C12 inline references to Stripe SKUs / configuration scope made MoR-neutral. §2.1 retitled "Required before MoR provider integration begins" with a new top-row recording the provider-selection audit as the next task. New §2.1a "Resolved (no longer pending)" subsection records C17, US LLC / Stripe Atlas rejection, attachment bucket privacy, storage-quota enforcement, and AI quota enforcement as all closed. §2.2 / §2.3 inline Stripe references made MoR-neutral. §3 implementation-unlocks table renumbered: row #5 changed from "Stripe Checkout + webhook" to "MoR provider-selection audit" (next task); new row #6 is "MoR integration"; rows #7–#11 shifted down. Cross-references updated to mention C1–C17. |
| `docs/store-launch-checklist.md` | Top banner updated to record the C17 pivot. "Billing-provider direction" paragraph updated. The single "billing provider chosen" checkbox in §4 reframed as the **mobile-phase** choice (Apple IAP / Google Play / RevenueCat) with a note that the **web-phase** choice is the MoR per C17. |
| `docs/start-here.md` | New handoff entry above the PR #144 entry recording the C17 pivot, what stays unchanged, what is now pending (provider-selection audit), file inventory, and the recommended next task. |
| `docs/migration-history.md` | This entry. |
| `docs/deployment.md`, `docs/architecture-read-path.md`, `docs/documentation-policy.md`, `README.md` | **Not changed.** None of these mention Stripe or the previously planned web-billing direction. Confirmed via `grep -n "Stripe\|stripe" docs/deployment.md README.md` returning zero matches. |

### What is now pending (was previously "Stripe Checkout + webhook")

- **MoR provider-selection audit: Paddle vs Lemon Squeezy.** Short docs/audit task. Output: a dated owner decision (C18 or later) recording the choice and the rationale. Scope: account approval / onboarding requirements for an Israel-based operator; product / price / variant configuration model; webhook event surface and signature verification; customer portal capabilities; sandbox / test-mode flow; payout / fee schedule against the $15 / month Pro baseline; refund / dispute handling; tax / invoicing behavior; geographic coverage for the target market.
- After the audit resolves: provider-specific MoR integration PR.

### What stays unchanged

- **All MVP baseline numbers.** Free $0 / 1,500 papers / 500 MB / 15 lifetime AI; Pro $15 / month / 10,000 papers / 2 GB / 350 AI per month; Labs / Teams future $99–$149 / month range and 10 GB cap. `quotas-and-pricing.md` explicit "MVP baselines with instrumentation" framing preserved.
- **Internal commercial schema.** `user_entitlements`, `subscriptions`, `subscription_events`, `usage_counters`, `usage_credits` (PR #142) and `user_storage_usage` (PR #144) all unchanged. Provider-neutral by design.
- **Server-side enforcement.** `consume_ai_quota` / `refund_ai_quota` (PR #143) and `check_and_consume_storage_quota` / `refund_storage_quota` (PR #144) all unchanged. The MoR pivot does not re-block enforcement work.
- **Launch blockers other than billing-provider integration.** Privacy / terms / support / account-deletion / AI disclosure / monitoring still required before paid beta. **MoR adoption does not remove these requirements.**
- **Provider-neutral architecture rule** (C4). The application code does not branch on which billing provider produced a subscription.

### Verification

- `git status --short` — only the seven docs files in the diff before commit.
- `npx tsc --noEmit` — clean. (Docs change, no source files touched.)
- `npx vitest run` — 285/285 (unchanged; docs-only PR cannot affect tests).
- `npx eslint` — not run (no `.ts` / `.tsx` files touched).
- Markdown lint — not configured in this repo (no `lint:md` script in `package.json`, no `.markdownlint*` file). Visual review performed; relative links checked by inspection.
- `supabase migration list --linked` — Local = Remote through `20260521030000` (PR #144 deployed). **No migration added in this PR.**
- `supabase db push` — **not run.**
- `supabase functions deploy` — **not run.**
- Stripe / Paddle / Lemon Squeezy API calls — **not made.**

### Wording constraints honored

- This entry does **not** assert that Paddle or Lemon Squeezy has been selected. Selection remains pending.
- This entry does **not** claim that MoR adoption removes all tax or legal obligations. It records that MoR providers act as the seller of record for payment / tax operations **subject to provider terms** and that this reduces operational burden.
- This entry does **not** offer legal or tax advice.
- This entry does **not** claim the product is ready for paid beta solely because the billing-provider direction changed. The launch blockers in `commercial-architecture.md §6` remain in force.

### Non-goals

- No application / source code changes.
- No migration.
- No Edge Function (`mor-webhook`, `create-payment-session`, `create-customer-portal-session`, etc. are not implemented — they will come in a separate PR **after** the provider-selection audit).
- No billing-provider SDK / dependency.
- No env file changes (`.env.example`, `.env.test.example` untouched).
- No `package.json` change.
- No generated Supabase types regeneration.
- No legal text drafted as final.
- No README change (zero Stripe mentions; nothing to update).
- No `docs/deployment.md` change (zero Stripe mentions; standard deploy sequence applies for the future MoR Edge Function PR).
- No `docs/architecture-read-path.md` change (no read-path impact).

## Commercial provider selection — Paddle selected as MoR provider (C18)

**Date:** 2026-05-21 (same-day follow-up to C17 / PR #145 — the MoR provider-selection audit ran immediately after the MoR pivot landed).
**What:** Docs-only PR recording the owner-approved provider-selection decision following the Paddle vs Lemon Squeezy audit. **Paddle is selected as the Merchant of Record provider for the web MVP.** Lemon Squeezy is retained as a fallback only. **No application code, no migration, no Edge Function, no Stripe / Paddle / Lemon Squeezy SDK, no dependency, no env file change, no deploy. No accounts / products / prices / variants / webhooks / customer-portal configurations were created on any provider.**

**Decision (C18, see `decisions-and-triggers.md`):**

- **Paddle is selected as the MoR provider** for the web MVP under the C17 MoR-first architecture.
- **Lemon Squeezy is retained as a fallback only** — to be reconsidered if Paddle rejects or materially delays the Israeli operator during KYB / verification, materially changes its pricing or policy posture before launch, or proves insufficient during the implementation spike.
- **C17 (MoR-first) remains the parent architectural decision.** C18 is the provider selection under it. C8 (Stripe-first) is still superseded.
- **The internal commercial architecture stays provider-neutral.** `subscriptions.provider` will record `'paddle'` rows in MVP; the column type and the existing enum-extension pattern accommodate `apple` / `google` / `revenuecat` / future MoR providers without rework.
- **MVP baselines are unchanged.** Free 1,500 papers / 500 MB / 15 lifetime AI; Pro $15 / month / 10,000 papers / 2 GB / 350 AI per month; Labs / Teams Coming Soon / Contact Sales only with $99–$149 / month future baseline range.
- **Paddle reduces payment / tax operational burden subject to Paddle's terms.** It does **not** remove all tax / legal obligations.
- **Paddle approval is not guaranteed by this decision.** If KYB fails, the Lemon Squeezy fallback is re-opened.

**Rationale (full audit attached as the prior turn's report):**

1. **C17 alignment.** Lemon Squeezy was acquired by Stripe (July 2024) and is migrating into Stripe Managed Payments (public preview Feb 2026). Choosing Lemon Squeezy today binds the project to a platform whose end-state inherits Stripe's underlying country-support model — recreating the original Israel-onboarding constraint that C17 was created to avoid. Paddle is an independent MoR with no announced platform transition.
2. **Israel onboarding fit.** Paddle's stated policy is "software businesses anywhere in the world except the unsupported countries listed below"; Israel is **not** on the unsupported list and is listed in the Asia section of `supportedcountries.com/paddle/`. Standard KYB / domain / identity verification applies.
3. **Engineering / Deno-Supabase fit.** A public Deno library (`atomica-software/deno_paddle_verify`) for `Paddle-Signature` HMAC-SHA256 verification exists, plus a public Supabase Edge Function integration tutorial. The internal `subscriptions` / `subscription_events` schema from PR #142 is provider-neutral and supports Paddle without structural changes.
4. **Pricing fit at the $15 / month baseline.** Paddle's all-in 5% + $0.50 per transaction is structurally simpler than Lemon Squeezy's base + 0.5% subscription + 1.5% international + 1.5% PayPal surcharge stack. Pro Net per $15 is approximately equal-or-better in every realistic scenario.
5. **Provider stability.** Paddle is independent with broad SaaS adoption.

### What changed

| File | Change |
|---|---|
| `docs/decisions-and-triggers.md` | New **C18** dated 2026-05-21 with full decision text, rationale, constraints, re-evaluation triggers. C17 stays in force as the parent architectural decision (unchanged). C8 stays superseded. |
| `docs/commercial-architecture.md` | New banner-section line below the existing C17 banner explicitly noting C18 / Paddle selection. §1 billing-provider bullet updated from "Final MoR provider selection ... is pending" to "Provider selected: Paddle (C18); Lemon Squeezy retained as fallback only". §3 column descriptions for `subscriptions.provider` / `billing_customer_id` / `billing_subscription_id` updated to record Paddle as MVP value (with `lemon_squeezy` added to the reserved-for-later list). §6 launch-blocker #5 rewritten as Paddle integration with the full Edge Function / RPC / migration scope. §7 implementation sequence renumbered: row #5 marked completed (C18 — Paddle selected), new row #6 records the owner-side Paddle setup gate, new row #7 records the Paddle integration PR, rows shifted to land on row #12 (Open beta). §8 provider list updated: Paddle listed as the MVP-MoR provider; Lemon Squeezy listed as fallback only. §10 non-goals references made Paddle-specific (annual SKU configuration cost, coupons beyond Paddle defaults, per-region pricing beyond Paddle defaults). |
| `docs/quotas-and-pricing.md` | Banner updated from MoR-neutral candidate language to Paddle-selected language. Inline references (Pro tier note, AI quota note, instrumentation note, annual SKU note, staging-environment note, fee-input note) made Paddle-specific. **Numeric baselines unchanged.** |
| `docs/owner-decisions.md` | C17 row simplified (now points at C18 for the provider choice). New C18 row added. §2.1 retitled "Required before Paddle integration begins"; top row replaced from "MoR provider selection" to "Owner-side Paddle Sandbox setup" with the full 10-step owner action list. §2.1a "Resolved" subsection extended with the MoR-provider-selection row. §3 implementation-unlocks table: row #5 marked done (C18 — Paddle selected); new row #6 is the owner-side Paddle setup gate (marked as the next required task, NOT engineering work); new row #7 is the Paddle integration PR (blocked on row #6); rows shifted to land on row #12 (Open beta). Cross-references updated to C1–C18. |
| `docs/store-launch-checklist.md` | Banner updated to reflect C18 / Paddle selected. Billing-direction paragraph updated. The mobile-phase items (Apple IAP / Google Play) are unchanged — those remain the mobile-phase ingestion paths under C4 provider-neutrality. |
| `docs/start-here.md` | New handoff entry above the PR #145 entry recording C18 / Paddle selected, what stays unchanged, what is now the next required owner action, what the future Paddle integration PR's scope looks like, and explicit "no Paddle code in this PR" markers. |
| `docs/migration-history.md` | This entry. |

### Files not changed

- `docs/deployment.md` — zero Stripe / Paddle / Lemon / MoR references (`grep` confirmed). Standard mixed-PR deploy sequence in §2 / §6.1 / §7 still applies for the future Paddle integration PR (one migration via `db push` + three Edge Function deploys). No update needed.
- `README.md` — zero Stripe / Paddle / Lemon / MoR / billing-provider references (`grep` confirmed). No high-level shipping-status change. No update needed.
- `docs/architecture-read-path.md` — no read-path change.
- `docs/documentation-policy.md` — no documentation-policy change.

### Wording constraints honored

- ✅ "**Paddle is selected as the MoR provider for the web MVP.**"
- ✅ "**Implementation remains blocked until owner-side Paddle onboarding and sandbox setup are complete.**"
- ✅ "**Paddle reduces payment / tax operational burden subject to Paddle's terms.**"
- ❌ Does NOT say "Paddle removes all tax / legal obligations."
- ❌ Does NOT say "Paddle approval is guaranteed."
- ❌ Does NOT say "The product is ready for paid beta."
- ❌ Does NOT say "Lemon Squeezy is bad." Says it is not recommended for this MVP because its Stripe-transition reintroduces strategic uncertainty.
- ❌ Does NOT say "The app is now Paddle-only forever." The provider-neutral internal architecture stays in force.

### Verification

- `git status --short` — only the seven docs files in the diff before commit.
- `npx tsc --noEmit` — clean. (Docs change, no source files touched.)
- `npx vitest run` — 285/285 (unchanged; docs-only PR cannot affect tests).
- `npx eslint` — not run (no `.ts` / `.tsx` files touched).
- Markdown lint — not configured in this repo (no `lint:md` script in `package.json`, no `.markdownlint*` file). Visual review of all seven files performed; relative links checked by inspection.
- `supabase migration list --linked` — Local = Remote through `20260521030000` (PR #144 deployed). **No migration added in this PR.**
- `supabase db push` — **not run.**
- `supabase functions deploy` — **not run.**
- Paddle / Lemon Squeezy / Stripe API calls — **not made.**
- No Paddle / Lemon Squeezy accounts were created. No products / prices / variants / webhooks / customer portals were configured.

### Non-goals

- No application / source code changes.
- No migration. (The future Paddle integration PR will include a small CHECK-constraint migration; not in this PR.)
- No Edge Function (`paddle-webhook`, `create-payment-session`, `create-customer-portal-session` will come in the Paddle integration PR, **after** owner-side Paddle setup completes).
- No billing-provider SDK / dependency added.
- No env file changes (`.env.example`, `.env.test.example` untouched; no `PADDLE_*` keys added).
- No `package.json` change.
- No generated Supabase types regeneration.
- No legal text drafted as final.
- No `README.md` change (no billing-provider mention to update).
- No `docs/deployment.md` change (no Stripe / MoR / Paddle-specific content present today; future Paddle integration PR will add a single line under §7).
- No `docs/architecture-read-path.md` change (no read-path impact).

## Commercial operations — Paperlume working brand and `paperlume.app` domain secured (C19)

**Date:** 2026-05-21 (same-day follow-up to C18 / PR #146 — the commercial-foundation triplet of decisions C17 / C18 / C19 all landed on the same day).
**What:** Docs-only PR recording the brand / domain decision. **`Paperlume`** is selected as the current working commercial brand; **`paperlume.app`** is the primary working domain (secured via **Cloudflare Registrar**, which is also the DNS control plane). **No application code, no migration, no Edge Function, no DNS records, no provider connections, no env file change, no dependency, no deploy. No Cloudflare / Vercel / Google Workspace / Resend / Paddle API calls. No accounts created on any provider. No WHOIS / RDAP personal data committed.**

**Decision (C19, see `decisions-and-triggers.md`):**

- Working commercial brand: **Paperlume**.
- Primary working domain: **`paperlume.app`**.
- Registrar / DNS: **Cloudflare**.
- **Not a registered trademark.** Israeli trademark filing was explored and deferred due to cost (~1,900 ILS for Class 42 alone). Revisited closer to paid public launch / serious B2B outreach.
- **No rename in this PR.** Repository name, npm package, app routes, UI labels, Supabase project, Edge Functions, database tables, environment variables — **all unchanged**.
- **No runtime behavior changes.**
- C17 (MoR-first) and C18 (Paddle as MoR) **remain in force**.

**Rationale (summary; full text in C19 of `decisions-and-triggers.md`):**

1. Knockout checks (Israeli trademark database; App Store; Google Play; basic web / social) returned no direct `Paperlume` / close-variant conflicts. **Not a substitute for legal trademark clearance** — a low-cost validation step only. A small art / drawing YouTube channel named "Paperlume" was found and assessed as unrelated to the SaaS / research category.
2. `paperlume.app` was available at low cost via Cloudflare Registrar (at-cost pricing; free WHOIS privacy).
3. Domain ownership unblocks downstream commercial setup: Paddle KYB / domain verification (C18), Google Workspace business email, Resend transactional-email sending subdomain, Supabase Auth Custom SMTP, marketing-site landing pages required by C14 / C16, B2B outreach.
4. `.app` is appropriate for a SaaS / web app (HTTPS-required).
5. Trademark registration was deferred — the appropriate timing is closer to paid public launch / B2B outreach, not pre-PMF.

### What changed

| File | Change |
|---|---|
| `docs/decisions-and-triggers.md` | New **C19** dated 2026-05-21 with full decision text, rationale, scope, constraints (no rename, not legally cleared, no DNS, no provider setup, no WHOIS in repo), and re-evaluation triggers (trademark conflict, `.com` becomes available, Paddle / KYB issue, better brand option appears, approaching paid launch, meaningful beta traction, international expansion, legal counsel advice). C17 / C18 / C8 unchanged. |
| `docs/deployment.md` | New **§8a** "Production domain, DNS, and email architecture" inserted between §8 (Vercel) and §9 (Post-deploy smoke). Covers: brand + domain identity; target URL layout table (`paperlume.app` / `www.paperlume.app` / `app.paperlume.app` / `auth.paperlume.app` / optional `notifications.paperlume.app`); Vercel hosting with DNS-only Cloudflare records initially; marketing-site requirements; Google Workspace business email plan; Resend + Supabase Auth Custom SMTP plan on `auth.paperlume.app` with SPF / DKIM / DMARC requirement; Paddle relationship with `paperlume.app` for KYB / domain verification; full pre-paid-beta checklist with ~17 items spanning domain hygiene → marketing site → Vercel custom domain → Supabase Auth URLs → business email → transactional email → Paddle setup → APP_URL Supabase secret. |
| `docs/commercial-architecture.md` | New C19 banner line below the existing C17 / C18 banners. New launch-blocker item #11 in §6 covering the production-domain / email / hosting setup with a pointer to `deployment.md §8a`. |
| `docs/owner-decisions.md` | New **C19** row in §1. Two new pending rows in §2.1: (a) Cloudflare domain hygiene (auto-renew + transfer-lock + receipt/RDAP saved privately) marked as recommended within first few days of purchase; (b) DNS / hosting / email setup on `paperlume.app` pointing at `deployment.md §8a`. New §2.1a resolved row recording brand+domain as resolved by C19. Cross-references updated to C1–C19. |
| `docs/store-launch-checklist.md` | Banner updated to record C19 — adds "Working commercial brand: Paperlume; primary working domain: `paperlume.app` (Cloudflare Registrar); not a registered trademark; trademark registration deferred" alongside the existing C17 / C18 banner text. |
| `docs/start-here.md` | New handoff entry above the PR #146 (C18) entry. |
| `docs/migration-history.md` | This entry. |

### Files not changed

- `docs/quotas-and-pricing.md` — does not reference `Paper Whisperer` brand or any domain by name. Free / Pro / Labs-Teams numeric baselines unchanged (per the PR brief: "Do not change pricing numbers"). Not updated.
- `README.md` — does not reference a billing provider, a marketing domain, a trademark, or a commercial brand by name. Repository name and npm package name unchanged per the no-rename rule. Not updated.
- `docs/architecture-read-path.md` — no read-path change.
- `docs/documentation-policy.md` — no documentation-policy change.
- `.env.example`, `.env.test.example`, `supabase/config.toml`, `package.json`, generated Supabase types, `src/integrations/supabase/client.ts`, and every other source / config file — all unchanged.

### Wording constraints honored

- ✅ "Working commercial brand" / "current working brand" — used throughout.
- ✅ "Primary working domain" / "domain secured" — used throughout.
- ✅ "Trademark registration deferred" — used; **not** "trademark unnecessary".
- ✅ "Cloudflare registrar/DNS" — used.
- ✅ "Future setup" / "no runtime change" — used throughout.
- ❌ Does NOT say "registered trademark", "legally cleared", "final legal brand", "guaranteed trademark safe", or "domain proves ownership of trademark".
- ❌ Does NOT say "Resend guarantees deliverability" — says "improves operational control and deliverability posture".
- ❌ Does NOT say "Google Workspace guarantees Paddle approval" — says "adds operational credibility for Paddle KYB; does not guarantee approval".
- ❌ Does NOT say "Cloudflare eliminates all lock-in" — says "reduces hosting lock-in but does not eliminate all operational lock-in".
- ❌ Does NOT say "DNS configured", "Vercel connected", "Paddle ready", or "paid beta ready".
- ❌ No `®` is used anywhere in this PR. `™` is reserved for future owner-approved marketing usage.

### Verification

- `git status --short` — only the seven docs files in the diff before commit.
- `npx tsc --noEmit` — clean. (Docs change, no source files touched.)
- `npx vitest run` — 285/285 (unchanged; docs-only PR cannot affect tests).
- `npx eslint` — not run (no `.ts` / `.tsx` files touched).
- Markdown lint — not configured in this repo (no `lint:md` script in `package.json`, no `.markdownlint*` file). Visual review of all seven files performed; relative links checked by inspection.
- `supabase migration list --linked` — Local = Remote through `20260521030000` (PR #144 deployed). **No migration added in this PR.**
- `supabase db push` — **not run.**
- `supabase functions deploy` — **not run.**
- Cloudflare API / CLI — **not called.**
- Vercel API / CLI — **not called.** Vercel custom domain not connected; Vercel project unchanged.
- Google Workspace setup — **not performed.**
- Resend setup — **not performed.**
- Supabase Auth Custom SMTP — **not configured.** Supabase Auth `Site URL` and `Redirect URLs` unchanged.
- Paddle setup — **not performed** (still blocked on owner-side gate per C18).
- No accounts were created on any provider.
- No WHOIS / RDAP personal data was committed or referenced.

### Non-goals

- No application / source code changes.
- No migration.
- No Edge Function changes.
- No env file changes (`.env.example`, `.env.test.example` untouched; no `PADDLE_*` / `RESEND_*` / `WORKSPACE_*` / `MOR_*` keys added).
- No `package.json` change.
- No generated Supabase types regeneration.
- No legal text drafted as final.
- No Cloudflare DNS records created or modified.
- No Vercel custom domain connection.
- No Google Workspace account creation.
- No Resend account creation.
- No Supabase Auth Custom SMTP configuration change.
- No Paddle Sandbox / Live setup (still owner action per C18).
- No `README.md` change (no billing-provider / brand / domain mention to update).
- No `docs/architecture-read-path.md` change (no read-path impact).
- No `docs/quotas-and-pricing.md` change (no brand / domain references in current text; numeric baselines unchanged).

## Operational setup — Paperlume app domain and Auth email delivery configured

**Date:** 2026-05-22 (next-day follow-up to PR #147 / C19, which had captured the brand + domain decision and the target architecture).
**What:** Docs-only PR recording that the owner completed the **app-domain + transactional-auth-email half** of the C19 pre-paid-beta checklist in `deployment.md §8a`. **No application code, no migration, no Edge Function, no DNS modifications by Claude, no env file change, no dependency, no deploy. No Cloudflare / Vercel / Resend / Supabase / Paddle API calls from Claude. No secrets, SMTP credentials, Resend API keys, DKIM private values, DNS record values, account IDs, WHOIS / RDAP details, message headers, reset-link URLs, screenshots, or other provider artifacts committed to the repo.**

This is **execution of C19, not a new decision** — no new C-numbered decision was created. Per `documentation-policy.md`'s convention, operational-completion notes go under the existing decision (a single paragraph appended to C19 in `decisions-and-triggers.md`) rather than as a separate C20.

**Completed (owner setup, smoke-tested 2026-05-22):**

| Item | Status |
|---|---|
| Cloudflare domain hygiene on `paperlume.app` (auto-renew, transfer-lock, receipt + RDAP info saved privately) | ✅ Completed |
| Vercel custom domain `app.paperlume.app` connected | ✅ Live. Initial DNS connection used DNS-only Cloudflare records per the §8.1 safety recommendation. The existing Vercel default URL also continues to serve the app during the cutover window. |
| Supabase Auth Site URL updated to `https://app.paperlume.app` | ✅ Completed |
| Supabase Auth Redirect URLs updated to cover `https://app.paperlume.app/**` | ✅ Completed. Old Vercel default URL pattern retained during the cutover window per the §1.4 safety note; will be removed after ~1–2 weeks of stability. |
| Resend account configured with `auth.paperlume.app` sending subdomain | ✅ Completed |
| SPF / DKIM / DMARC records active on `auth.paperlume.app` and verified in Resend | ✅ Completed. DMARC at `p=none` per the C19 / §8a guidance — do not escalate for at least 2–4 weeks of stable pass rates. |
| Supabase Auth Custom SMTP configured to route through Resend | ✅ Completed. The production Auth email path no longer relies on Supabase default SMTP. |
| Paperlume-branded Supabase Auth email templates configured (Reset Password, Confirm Signup, Magic Link as applicable) | ✅ Completed. Templates moved from the minimal default Supabase templates to branded templates with header, expiry note, "if this wasn't you" guidance, support contact at `support@paperlume.app`, and plain-text fallback URL — a measurable improvement over the default templates that look like phishing kits. |
| Multi-mailbox auth-email smoke test | ✅ Passed. Reset / signup emails arrive in the regular inbox (not spam) across multiple tested mailboxes. |
| App import smoke test on `app.paperlume.app` | ✅ Passed. Existing identifier and file imports continue to work; no regression from the domain change. |

**Still pending (does not block this PR; required before the closed paid pilot):**

- Google Workspace business email on `paperlume.app` — required before broader beta because the customized Auth templates reference `support@paperlume.app`; that address must resolve to a real inbox / group / alias before users start replying to support emails. Independent of Auth email delivery (Resend handles that) and independent of Paddle integration.
- Marketing site live at root `paperlume.app` with privacy / terms / AI disclosure / support URLs (C14 / C16).
- `www.paperlume.app` routing decision (optional marketing-site alias).
- Paddle Sandbox / KYB / Product / $15/mo Price / API key / webhook signing secret / customer-portal config per C18.
- `APP_URL` Supabase secret on the Edge Function project set to `https://app.paperlume.app` — set when the Paddle integration PR ships; no Edge Function reads `APP_URL` today.

**Trademark status unchanged.** Paperlume remains a working commercial brand per C19; trademark registration still deferred; not legally cleared.

**Wording constraints honored:**

- ✅ Documents that the setup was **completed and tested by the owner**.
- ✅ Says "branded templates + Resend + authenticated sending domain **improved deliverability** in owner tests".
- ✅ Says "ongoing deliverability still depends on domain reputation, low bounce rate, correct authentication, and gradual sending behavior".
- ❌ Does NOT claim deliverability is guaranteed.
- ❌ Does NOT claim Paperlume is a registered trademark.
- ❌ Does NOT include DNS record values, SMTP credentials, Resend API keys, account IDs, WHOIS / RDAP details, screenshots, reset links, message headers, or SPF / DKIM selector values.
- ❌ Does NOT include private email addresses beyond the intended public addresses (`support@paperlume.app`) referenced in user-facing copy.

### What changed

| File | Change |
|---|---|
| `docs/deployment.md` | §8a Status banner updated with the 2026-05-22 completion line. Google Workspace subsection updated (still pending; explicit note about `support@paperlume.app` needing a real inbox before broader beta). Resend / SMTP subsection updated from "planned" / "Not configured" language to "configured" / "verified" language with the owner smoke-test result and the deliverability-caveat language. Pre-paid-beta checklist updated: 13 items marked ✅ completed; 6 items marked still pending; new "Ongoing (post-completion monitoring)" subsection added. New "Operational notes (Do / Don't)" subsection added at the bottom of §8a covering: no DNS values in repo; no screenshots; deliverability-debug-via-headers-and-Resend-dashboard guidance. |
| `docs/owner-decisions.md` | §2.1 Cloudflare-hygiene row marked ✅ completed. Previous "DNS / hosting / email setup" row split into (a) ✅ completed "App-domain + transactional-auth-email setup" row and (b) two new pending rows for Google Workspace and marketing-site. §2.1a Resolved subsection extended with the operational-setup completion entry. |
| `docs/commercial-architecture.md` | §6 launch-blocker item #11 updated to reflect partial completion: app-domain + auth-email work is ✅ done; marketing site + Google Workspace + `APP_URL` Supabase secret remain pending. |
| `docs/store-launch-checklist.md` | Banner extended with the operational-setup progress line summarizing what's now live vs. still pending. |
| `docs/decisions-and-triggers.md` | Single-paragraph operational note appended at the bottom of the C19 entry — **not a new C-numbered decision.** Records the 2026-05-22 completion, explicitly notes "this is execution of C19, not a new decision", and reiterates that trademark status is unchanged. |
| `docs/start-here.md` | New handoff entry above the PR #147 / C19 entry — full summary of what's live, what's still pending, the ongoing-deliverability caveat, what's NOT in this PR, and the recommended next owner-side task. |
| `docs/migration-history.md` | This entry. |

### Files not changed

- `docs/quotas-and-pricing.md` — no brand / domain / email references that need updating. Numeric MVP baselines unchanged.
- `docs/architecture-read-path.md` — no read-path change.
- `docs/documentation-policy.md` — no documentation-policy change.
- `README.md` — no billing-provider / brand / domain mention to update. Repo / npm package name unchanged per the C19 no-rename rule.
- All source / migration / Edge Function / env / config / generated-types files — unchanged.

### Verification

- `git status --short` — only the seven docs files in the diff before commit.
- `npx tsc --noEmit` — clean. (Docs change, no source files touched.)
- `npx vitest run` — 285/285 (unchanged; docs-only PR cannot affect tests).
- `npx eslint` — not run (no `.ts` / `.tsx` files touched).
- Markdown lint — not configured in this repo (no `lint:md` script in `package.json`, no `.markdownlint*` file). Visual review of all seven files performed; relative links checked by inspection.
- `supabase migration list --linked` — Local = Remote through `20260521030000` (PR #144 deployed). **No migration added in this PR.**
- `supabase db push` — **not run.**
- `supabase functions deploy` — **not run.**
- Cloudflare / Vercel / Resend / Supabase / Paddle API calls — **not made.** No DNS records were modified by Claude; no SMTP test was performed by Claude; no provider dashboard was accessed via API.
- No accounts created. No products / prices / variants / webhooks / customer portals configured by Claude.
- No secrets, SMTP credentials, Resend API keys, DKIM private values, DNS record values, account IDs, WHOIS / RDAP details, message headers, reset-link URLs, screenshots, or other provider artifacts committed.

### Recommended next task

**Owner-side: Google Workspace business email on `paperlume.app`.** This is the smaller of the two remaining owner-action gates and is required before broader beta because the customized Auth email templates reference `support@paperlume.app` — that address must resolve to a real inbox / group / alias.

After that: the **Paddle Sandbox / KYB / Product / $15/mo Price / API key / webhook signing secret / customer-portal config** per C18 owner setup gate. That is the larger remaining owner-action gate; it unblocks the Paddle integration engineering PR.

Marketing-site provider + legal URLs (C14 / C16) can land in parallel with either of the above.

### Non-goals

- No application / source code changes.
- No migration.
- No Edge Function changes.
- No env file changes.
- No `package.json` change.
- No generated Supabase types regeneration.
- No legal text drafted as final.
- No Cloudflare DNS records created or modified by Claude.
- No Vercel custom domain manipulation by Claude.
- No Google Workspace account creation.
- No Resend account / domain / API key creation by Claude.
- No Supabase Auth Custom SMTP configuration change by Claude.
- No Paddle setup.
- No `README.md` change.
- No `docs/architecture-read-path.md` change.
- No `docs/quotas-and-pricing.md` change.
- No `docs/documentation-policy.md` change.

## 2026-07-18 — RECON-JUNCTIONS-001: junction tables reconciled to composite primary keys

**Migration:** `20260718063657_reconcile_junction_tables.sql` (decision C22; roadmap in [schema-reconciliation.md](schema-reconciliation.md)).

Converges `paper_tags` / `paper_projects` from the two known starting states to one canonical shape via a **two-phase design**: Phase A classifies and fully validates **both** tables (exact live-column sets; `uuid NOT NULL` plain-column checks on every pair column; exact PK shape *and* name; pair-`UNIQUE` inventory counts; catalog-level FK validation — single-column, target `id`, `ON DELETE CASCADE` / `ON UPDATE NO ACTION`, validated, non-deferrable, exactly two FKs total; row soundness; **exact constraint-inventory enforcement** — the identified canonical constraint OIDs (PK + 2 FKs, plus the single pair `UNIQUE` in the surrogate state) must account for every `pg_constraint` row, so CHECK/exclusion/extra constraints of any type fail; index-inventory validation that rejects conflicting same-name definitions, equivalent indexes under other names, and any unexpected index — with the pair `UNIQUE`'s backing index **bound by `conindid` OID** so a standalone pair-equivalent unique index under any other name fails; and dependency inspection over `id`/`created_at` covering external FKs, view/rule, policy, trigger, and other-column-default dependencies plus non-PK constraints) **before any DDL runs against either table**. Any unclassifiable state fails in Phase A. Phase B performs only the classified conversion — on clean local replay it drops the surrogate `id` PK, `id`, and `created_at` (restrictive, no `CASCADE`; PostgreSQL's restrictive drop remains the backstop for dependency classes outside the enumerated checks) and installs the composite PKs; against production (already composite-keyed) the conversion no-ops. Phase C then asserts the exact canonical end state (columns; PK name/order; exactly three constraints total — one PK, two FKs, zero of any other type; index inventory) and fails on any residue. Adversarially tested: six unsupported-state cases (nullable pair column, extra FK, conflicting legacy-index definition, second-table failure with the first in surrogate state, standalone pair-equivalent unique index, additional CHECK constraint) each fail in Phase A with no persistent mutation. Junction behavior, cascade FKs, RLS enablement/FORCE, and all six policies preserved (catalog-proven). The redundant pair `UNIQUE` and `idx_*_paper_id` are removed; canonical reverse indexes ensured (production gains `idx_paper_tags_tag_id` on deploy). The four assignment RPCs are re-declared in production's exact text form — semantics unchanged. Client side: `PaperTag` / `PaperProject` reduced to pair columns; `usePapers.ts` junction reads use explicit pair projections.

**Deployment:** per C24 this migration **must be applied to the linked project after merge** (`supabase db push` per [deployment.md](deployment.md) §6) even though most of it no-ops there — the remote application records the ledger row and creates `idx_paper_tags_tag_id`. Not yet applied remotely at merge time. Generated Supabase types remain deferred under C25 until all type-affecting drift is reconciled.

## 2026-07-18 — RECON-STATISTICAL-METHODS-001: statistical_methods reconciled to canonical JSON-string storage

**Migration:** `20260718114444_reconcile_statistical_methods.sql` (decision C20; roadmap in [schema-reconciliation.md](schema-reconciliation.md)).

Converges `papers.statistical_methods` from the two known starting states to the canonical C20 shape (`jsonb NULL`, values restricted to SQL `NULL` or a top-level JSON string) via the same **two-phase design** as the junction reconciliation. Phase A classifies the column as exactly the clean-replay `text` state or the production `jsonb DEFAULT '[]'::jsonb` state and fully validates it (live/nullable/non-generated/non-identity; exact default per state, with the column's **own `pg_attrdef` object captured by OID**; zero existing constraints or indexes involving the column; **exact dependency enumeration** — every `pg_depend` entry on the column fails Phase A except the column's own default object matched by that exact OID, and only in the JSONB state, so another generated column's stored expression, another default/expression object, views/rules, policies, trigger expressions, constraints, and expression indexes are all rejected, with restrictive non-`CASCADE` DDL as the terminal backstop for anything not proactively enumerated; zero rows holding unsupported top-level JSON **object/number/boolean** values — any such row aborts before mutation; aggregate category counts recorded for postcondition reconciliation; and both RPCs verified — for each of `safe_bulk_insert_papers` and `merge_exact_duplicates`: single overload, exact identity arguments/return type/`prokind`/language, `SECURITY DEFINER`, exact volatility, configuration exactly `{search_path=public}` (equality, not containment), owner and ACL captured; strictness, leakproof and parallel-safety are pinned exactly for `safe_bulk_insert_papers` **only** (in both Phase A and Phase C) — `merge_exact_duplicates` is not checked for those three properties, its invariance resting on the body fingerprint plus the checks above — and the **pre-migration body md5 fingerprint required to equal the approved body** (`safe_bulk_insert_papers` as created by `20260330010100`, verified byte-identical in production) so an unexpected production-side body or config change is never silently overwritten) **before any DDL or data mutation**. Phase B converts the text state with `to_jsonb(...)` (text is *never* parsed as JSON — `'["ANOVA"]'`, `'null'` stay literal strings), normalizes transitional categories (JSON `null` → SQL `NULL`; JSON array → one JSON string, elements joined in order with `", "` via `#>> '{}'` text extraction, JSON `null` elements omitted by `string_agg`, empty array → `""`), drops the noncanonical array default with no replacement, and adds the validated CHECK constraint `papers_statistical_methods_json_string_check` (`statistical_methods IS NULL OR jsonb_typeof(statistical_methods) = 'string'`). `safe_bulk_insert_papers` is re-declared with the identical metadata/body except one addition: per-row input normalization to the same invariant (missing key / JSON `null` → SQL `NULL`; string kept; array joined by the same rules; object/number/boolean raise inside the existing per-paper exception boundary, so that row returns `status = 'error'` while valid sibling rows still insert). Phase C asserts the exact end state (type/nullability/no default; exactly one constraint involving the column — the canonical validated CHECK with the exact deparsed definition; zero rows in any non-string JSON category; row count unchanged; category counts reconcile — post NULL = pre SQL NULL + pre JSON null, post string = pre string + pre array; `safe_bulk_insert_papers` verified by **exact md5 fingerprint of the complete canonical new body** — any inserted or removed statement fails the check — plus every metadata property, exact configuration equality, and **owner/ACL proven unchanged from Phase A** (no `GRANT`/`REVOKE`/`ALTER OWNER` is ever executed); `merge_exact_duplicates` proven completely unchanged — body md5, signature, metadata, configuration, owner, and ACL). Adversarially tested (all failing in Phase A with zero persistent mutation): a top-level object row; **a stored generated column depending on `statistical_methods`** (its `pg_attrdef` expression is rejected because it is not the column's own default OID); **an unexpected `safe_bulk_insert_papers` body** with identical signature/metadata (refused by the old-body fingerprint, and never overwritten); and **an extra function-level configuration setting** (refused by exact-configuration equality). The approved transformation is **deliberately lossy**: the JSON-`null`-versus-SQL-`NULL` distinction is dropped and array boundaries/element types are flattened into one comma-joined string and cannot be reconstructed. Client side: new pure boundary mapper `src/lib/statisticalMethods.ts` (`normalizeStatisticalMethodsForDomain`) applies the migration's normalization at the read boundary in `usePapers.ts` — so the app reads the current mixed production values safely during the merge → Vercel deploy → `db push` interval — and throws `TypeError` on unsupported top-level categories instead of rendering misleading text; its output is exactly equal to the SQL path for null, strings, empty arrays, string arrays, and tested scalar JSON elements, while nested composite array elements are serialized deterministically via `JSON.stringify` (no claim of universal byte identity with PostgreSQL's JSONB text rendering; production evidence shows all transitional arrays are empty). `PaperList.tsx` drops its transitional array fallback and consumes `string | null`. Domain type stays `string | null`.

**Deployment:** per C24 this migration **must be applied to the linked project after merge** (`supabase db push` per [deployment.md](deployment.md) §6) — remotely it normalizes the mixed categories (measured pre-merge by aggregate-only inspection: JSON `null`s and empty arrays; strings untouched), drops the array default, adds the constraint, and replaces the RPC. Not yet applied remotely at merge time. Generated Supabase types remain deferred under C25 until all type-affecting drift is reconciled.

## 2026-07-19 — RECON-INTEGRITY-001: ownership and pool integrity constraints enforced

**Migration:** `20260718205847_reconcile_integrity_not_null.sql` (decision C23 as amended 2026-07-19; roadmap in [schema-reconciliation.md](schema-reconciliation.md)).

Enforces NOT NULL on the twelve C23 targets — `user_id` on the eight owner-scoped tables (`papers`, `projects`, `tags`, `keyword_pool`, `keyword_exclusion_pool`, `study_type_pool`, `study_type_exclusion_pool`, `synonym_pool`) plus `synonym_pool.canonical_term`, `synonym_pool.synonyms`, `study_type_pool.hierarchy_rank`, `study_type_pool.specificity_weight` — and (per the 2026-07-19 C23 amendment) restores the canonical `DEFAULT '{}'::text[]` on `synonym_pool.synonyms`, which production lacks (discovered by this task's read-only preflight; the clean-replay schema has carried the default since `20260203133100`). Same three-phase reconciliation structure as the junction and statistical-methods migrations: a single twelve-target manifest (self-checked: 12 targets / 12 distinct pairs / 8 tables) records the expected type and **state-specific** expected defaults (S1 `'{}'::text[]` vs. S2 absent for `synonyms`; `99`/`1` for the study-type rank fields in both states; none elsewhere). Phase A classifies the global state as exactly S1 (clean replay: all twelve already NOT NULL, canonical defaults) or exactly S2 (audited production: all twelve nullable, zero NULL values, no `synonyms` default), validates ordinary-table/live/plain (non-generated, non-identity) columns and exact types, and runs a **zero-NULL gate on every target** — any NULL aborts before mutation; the migration contains no DML of any kind and never backfills, deletes or invents data. Mixed nullability, an unexpected default in either state (including "all NOT NULL but the `synonyms` default missing" and "all nullable but a `synonyms` default present"), a missing/wrong-type/generated/identity target — all fail in Phase A. Phase A also fingerprints, per table, the policy/constraint (incl. FK)/index/non-internal-trigger inventories, RLS + FORCE RLS, owner, ACL, and every **non-target** column's name/nullability/type/default. In S2, Phase B acquires ACCESS EXCLUSIVE locks on all eight tables in one deterministic alphabetical order (taking the mode `SET NOT NULL` requires anyway directly avoids a lock-upgrade deadlock window while write-blocking the race between preflight and DDL), **repeats all twelve NULL counts and the `synonyms`-default check under lock**, then runs only the bounded DDL: one `SET DEFAULT '{}'::text[]` plus exactly twelve schema-qualified `SET NOT NULL` operations grouped per table. In S1 no DDL runs (structural no-op after full validation). Phase C proves the exact canonical end state — 12/12 NOT NULL, unchanged types and attnums, exact final defaults, zero NULLs, unchanged row counts, and byte-identical Phase A fingerprints for RLS/policies/constraints/FKs/indexes/triggers/owner/ACL/non-target columns — and any failure aborts the whole transaction. Adversarially tested locally, every case in a rolled-back transaction with a canonical-state postcondition: production-like S2 succeeds with per-table data fingerprints byte-identical and omitted-column defaults flowing through; four mixed states rejected in Phase A (one-of-twelve NOT NULL; S2 with the canonical default present; S2 with an unexpected `ARRAY['x']` default; all-NOT-NULL with the default missing); a **twelve-case NULL matrix** (one disposable NULL per target) each rejected in Phase A naming the exact target, with zero persistent mutation; wrong-type (`bigint`) and generated-column metadata cases rejected; and final constraint behavior proven — omitted `synonyms` → `{}`, omitted ranks → `99`/`1`, `canonical_term` and every `user_id` required, 25/25 `not_null_violation`s across the INSERT/UPDATE-to-NULL matrix, valid inserts and updates unaffected. The application write-path audit confirmed every active insert path supplies a non-null `user_id` (client payloads under S2 guards, or the S1-guarded `safe_bulk_insert_papers`), synonym writes always supply `canonical_term`/`synonyms`, and study-type writes deliberately use the `99`/`1` defaults — no application-source change required.

**Deployment:** per C24 this migration **must be applied to the linked project after merge** (`supabase db push` per [deployment.md](deployment.md) §6), repeating the twelve aggregate zero-NULL checks immediately before pushing. Not yet applied remotely at merge time. Generated Supabase types remain deferred under C25; once deployed, the `synonyms` default restoration also converges the generated Insert-optionality of `synonym_pool.synonyms` between environments.

## 2026-07-19 — RECON-LEGACY-COLUMNS-001: empty production-only legacy columns removed

**Migration:** `20260719060025_reconcile_legacy_columns.sql` (decision C21; roadmap in [schema-reconciliation.md](schema-reconciliation.md)). **Local-only at the time of this entry — not yet applied remotely; C24 requires a separate post-merge `supabase db push` deployment task with the emptiness matrix repeated immediately before deployment.**

Drops exactly the three C21 legacy columns that exist only in production: `papers.urls`, `synonym_pool.primary_term`, `synonym_pool.variants`. The 2026-07-19 read-only re-audit of the linked project pinned their exact live metadata — `urls` **jsonb** `DEFAULT '[]'::jsonb`, `primary_term` **text** with no default, `variants` **jsonb** `DEFAULT '[]'::jsonb`; all three nullable, plain (non-generated, non-identity), storage `x`, no custom statistics/ACL/comment — and re-proved the approved emptiness: all 730 `papers` rows hold a top-level empty JSON array in `urls`, all 65 `synonym_pool` rows are SQL `NULL` in `primary_term` and empty JSON array in `variants` (full jsonb category matrices: zero SQL NULLs, JSON nulls, nonempty arrays, objects, scalars; zero total elements). The repository consumer audit (explicit projections, `select("*")` whole-row consumers, insert/update payloads, import/export pipelines, hand-written and committed generated types, RPCs, policies, triggers, both Edge Functions, Playwright helpers, Git history) and the catalog dependency inventory (`pg_depend`, constraints, indexes incl. expression/partial, extended statistics, views/rules, RLS policies, trigger definitions, other defaults/generation expressions, publication column lists, row-type-returning functions, plus a whole-word source scan of every non-catalog function/procedure body — which PostgreSQL does not dependency-track) both concluded zero consumers; the only catalog objects referencing the targets are their own two default objects. Same three-phase structure as the prior reconciliation migrations: a single three-target manifest (self-checked 3 targets / 3 distinct / 2 tables) hard-codes the audited S2 metadata; Phase A classifies exactly S1 (clean replay: all three live columns absent → structural no-op) or exactly S2 (all three present, exact metadata, full emptiness matrix, zero dependencies) and fails on any partial (1–2 present), metadata, content or dependency deviation before any DDL; Phase B (S2 only) takes ACCESS EXCLUSIVE locks on `papers` then `synonym_pool` (the mode `DROP COLUMN` requires anyway, taken directly to close the validation→DDL window — this does not make deadlocks with arbitrary concurrent transactions impossible), **repeats every classification, metadata, emptiness, dependency and function-source check under lock**, captures deterministic per-row aggregate fingerprints of all remaining data (papers excluding only `urls`; synonym_pool excluding only `primary_term`/`variants`; PK-ordered, hashes only), then runs exactly three schema-qualified **restrictive** drops — no `CASCADE`, no `IF EXISTS`, no DML of any kind, no production row updated or deleted. Phase C proves the canonical end state: all three targets gone as live columns, the live column set otherwise exactly unchanged (no fourth column removed), row counts and remaining-data fingerprints byte-identical, and policies/constraints/FKs/indexes/triggers/RLS+FORCE/owner/ACL/remaining-column definitions/public-function inventory unchanged (dropped-column tombstones and physical attnums are intentionally out of scope — canonical parity is live schema). **The drop is structurally irreversible: the columns can only ever be re-created as new columns; approved because the repeated aggregate checks prove no meaningful value exists.** Verified locally: clean replay applies all 64 migrations with an S1 no-op; a production-like S2 rollback-transaction test drops all three with byte-identical remaining-data fingerprints; and a 27-case adversarial matrix all failed safely in Phase A with zero persistent mutation — four mixed/partial states (each named in the error), fourteen content violations (nonempty/NULL/JSON-null/object/string/number-boolean per jsonb target; non-NULL and empty-string `primary_term`), four metadata violations (wrong type, unexpected default, NOT NULL, generated column), four dependency probes (view, CHECK constraint, generated-column expression, and the mandatory PL/pgSQL-function-body case caught only by the source scan), plus a restrictive-drop backstop proving a raw non-`CASCADE` `DROP COLUMN` aborts (`2BP01`) rather than removing a dependent object. Generated Supabase types remain deferred under C25; once deployed, the three linked-only generated-type fields (`urls`, `primary_term`, `variants`) disappear from the linked snapshot.

**Hardening (RECON-LEGACY-COLUMNS-001A, same migration file, still local-only/unapplied):** the migration was strengthened to close whole-row, publication and exact-metadata gaps. The S2 metadata manifest now pins and verifies each target's exact live **attnum** (`urls` 11, `primary_term` 2, `variants` 3), exact **type OID** (jsonb 3802 / text 25) and **typmod** (−1) alongside the rendered type, and asserts **zero security labels** (`pg_seclabel`, all providers) per target. A new **exact approved routine-inventory gate** runs in every state and pass: it pins the 23 public routines by a behavioral fingerprint (schema, name, identity args, result, kind, language, security-definer, volatility, strictness, leakproof, parallel, config, body MD5) that is byte-identical between a clean local replay and the linked project (`c0c14ef5…`), plus an owner/ACL fingerprint that must match one of the two audited baselines (clean-replay `1f658861…` or production `c0b444c8…`), so a whole-row consumer added, removed or changed without ever naming a target column aborts before any DDL. Explicit **whole-row idiom scans** reject any routine that mentions a target table and uses `%ROWTYPE`, `SELECT *`, a `to_jsonb`/`row_to_json`/`json(b)_agg` of a whole-row variable, or a row-type result; a companion scan rejects `SELECT *` views/matviews and any object depending on the tables' composite row type (`deptype='n'`). The **publication guard** now fails on any `FOR ALL TABLES` publication and on either target table being a member of any publication (with or without a column list), in addition to the column-list-pin check. The **preservation inventory** (captured pre-drop and re-proved byte-identical in Phase C) was expanded to include extended-statistics definitions, publication memberships, relation and column security labels, table and column comments, and every remaining column's full definition (type OID, typmod, nullability, default, generated/identity, collation, storage, compression, statistics target, ACL, comment and security labels). The adversarial suite was rebuilt on exact production geometry — the targets recreated at attnums 11/2/3 by renaming the migrated tables aside, because local `ALTER…ADD COLUMN` cannot reproduce those attnums — and re-run in full: clean replay applies all 64 migrations as an S1 no-op; the production-like S2 success drops all three with byte-identical remaining-data fingerprints while an unrelated extended-statistics object, a column comment and a CHECK constraint are all preserved; and a **34-case rejection matrix** all fails before Phase B with the database returning to canonical S1 (`CANONICAL-S1-RESTORED`) — four mixed states, fourteen content violations, six metadata violations (now including wrong attnum → "at attnum 4 (expected 11)", wrong type OID → "type OID 1009 (expected 3802)", and a **real pgsodium column security label** → "carries 1 security label(s)"), four dependency probes, three whole-row consumers (a PL/pgSQL `to_jsonb(p)` and an SQL `SELECT *` function caught by the routine-inventory gate; a `SELECT *` view caught by the per-column dependency scan), two publication probes (explicit membership and `FOR ALL TABLES`), and the restrictive-drop backstop (`2BP01`). Application validation was re-run in full: lint 0 errors, Vitest 300 passed, node typecheck passes, application typecheck unchanged at the pre-C25 baseline (48 diagnostics), build passes, Playwright 9/9, zero residual E2E artifacts. A read-only linked re-audit re-confirmed every pinned fact (attnums 11/2/3, type OIDs 3802/25/3802, typmod −1, defaults, zero security labels, no `FOR ALL TABLES` publication, neither table a publication member, 730/730 empty `urls`, 0/65 non-NULL `primary_term`, 65/65 empty `variants`, routine fingerprints `c0c14ef5…`/`c0b444c8…`) with the 63-migration ledger still Local = Remote and `20260719060025` still local-only.

## 2026-07-19 — RECON-METADATA-PARITY-001: remaining metadata and index parity (final reconciliation step)

**Migration:** `20260719162013_reconcile_metadata_parity.sql` (decision C26; roadmap item 5 in [schema-reconciliation.md](schema-reconciliation.md)). **Local-only at the time of this entry — not yet applied remotely; C24 requires a separate post-merge `supabase db push` deployment task.**

The fifth and final schema-reconciliation migration. An independent 2026-07-19 read-only re-audit (direct catalog queries on both a clean local replay and the linked project, plus generated-type comparison, effective-privilege comparison, and a full application/RPC/Edge-Function/test consumer audit) reduced the residual public-schema drift to a fully classified inventory and corrected two stale premises in the original audit: `tags.color` clean-replay default is `'#8b5cf6'` (not "absent"), and `createTag` inserts `{user_id, name}` only, so the DB default **is** used; and `study_type_pool.created_at` (NOT NULL in production, nullable locally) and the seven single-column indexes were not in the original inventory. The migration converges both a clean local replay (**S1**) and current production (**S2**) to one canonical end state (C26): drop `projects.updated_at` and its `update_projects_updated_at` trigger (no consumer reads/writes the column; the hand-written `Project` domain type is corrected in the same PR); drop the redundant `papers` `update_papers_updated_at` trigger while retaining `trg_papers_updated_at` (`set_updated_at()`, production's proven behavior — both functions set `NEW.updated_at = now()`); set the eight drifted `created_at` defaults (`keyword_exclusion_pool`, `keyword_pool`, `papers`, `projects`, `study_type_exclusion_pool`, `study_type_pool`, `synonym_pool`, `tags`) to `now()`; enforce `study_type_pool.created_at` NOT NULL; set `tags.color` default to `'#e2e8f0'`; and drop seven redundant single-column btree indexes (`idx_papers_doi`, `idx_papers_pmid`, `idx_papers_user_id`, `idx_papers_year`, `idx_projects_user_id`, `idx_synonym_pool_user_id`, `idx_tags_user_id`) superseded by production's covering composite/unique indexes and the app's user-scoped query patterns. Two items are **deliberately not changed**, evidence-backed: `papers.search_vector` — the local immutable-wrapper generation expression and production's inline `to_tsvector` form produce byte-identical `tsvector`s across a 10-row NULL/empty/punctuation/case/unicode/stopword/number/nested-jsonb corpus, so it is an approved benign textual difference (no table rewrite); and the SEC-4 default table grants — effective privileges were re-compared local-vs-linked and are consistent with the RLS-forced security model, so the diff-tool output is classified an artifact and no grant is added (`anon`/`authenticated` access is never widened to silence a diff).

Same rigor as the prior reconciliation migrations. A global state is classified via the `projects.updated_at` bellwether, and every other item is **cross-validated against that state** so any mixed or third state fails closed before any DDL. All of Phase A runs twice — pre-lock, then again under **ACCESS EXCLUSIVE** locks taken on all eight tables in one deterministic alphabetical order (the mode the DDL needs anyway, taken directly to close the validation→DDL race) — including the `study_type_pool.created_at` zero-NULL gate. Per-item guards pin exact column shape/type/default, exact trigger definitions **and enabled state** (`pg_get_triggerdef` does not encode ENABLE/DISABLE, so `tgenabled` is checked explicitly), and exact index definitions (rejecting a same-name/wrong-definition index and never dropping a unique/constraint-backed index). Phase A also captures, per table, a preservation image — RLS/FORCE/owner/ACL, policies, non-not-null constraints, indexes **minus** the seven intended drops, triggers **minus** the two intended drops, every column **minus** the intentionally-changed ones, plus row counts, order-independent remaining-data fingerprints (projects excluding the dropped `updated_at`), and the full public-function inventory. Phase B runs only the bounded convergence DDL (schema-qualified; no `CASCADE`, no `IF EXISTS`, no DML, no grants): on S1 it drops the trigger+column, the duplicate trigger, the seven indexes, sets `tags.color` canonical and `study_type_pool.created_at` NOT NULL; the `created_at` → `now()` step runs wherever the default is still `timezone('utc', now())` (S2's only non-canonical item — so production's C24 apply changes only the eight defaults, altering no stored row). Phase C proves the exact canonical end state and byte-identical preservation image, unchanged row counts and remaining-data fingerprints, and an unchanged function inventory; any failure rolls back the whole transaction.

Verified locally, every case in a rolled-back transaction with a canonical-state postcondition (`CANONICAL-LOCAL-STATE-RESTORED`, confirmed pristine after the run). Both success paths converge to byte-identical schema **and byte-identical generated types**: the clean-replay (S1) canonical types and a production-fixture→migration (S2) canonical types are identical, and both equal the linked (production) generated types except the linked-only `__InternalSupabase` client-version header — i.e. the two former type-affecting differences (`projects.updated_at`, `study_type_pool.created_at` nullability) are resolved. A 16-case adversarial suite passed: three success cases (S1 clean replay; S2 production fixture; a rows-present case proving existing `tags.color`/project values are byte-identical after convergence) and thirteen must-fail cases each rejected and rolled back — `projects.updated_at` without its trigger, wrong nullability, and an active dependent view; papers zero/three triggers, a wrong-body duplicate, and a disabled canonical trigger; an unexpected third `created_at` default and a `created_at` type mismatch; a `study_type_pool.created_at` NULL row; a wrong-definition and a wrong-predicate index; and a mixed S1/S2 state. Application validation: `npm run lint` 0 errors, Vitest **300 passed**, `npx tsc -p tsconfig.node.json` passes, `npx tsc -p tsconfig.app.json` unchanged at the pre-C25 baseline (48 diagnostics — a before/after diff shows **zero** new errors from the `Project` type correction), `npm run build` passes, Playwright **9/9** against production with clean cleanup and zero residual E2E artifacts. Post-migration `supabase db diff --linked` is explained entirely by the pending migration (eight `created_at` defaults, applied to production under C24), the approved `search_vector` textual equivalence, and the SEC-4 grant artifact — **zero unexplained statements, no unexplained type-affecting difference.**

**Deployment:** per C24 this migration **must be applied to the linked project after merge** (`supabase db push` per [deployment.md](deployment.md) §6). Not yet applied remotely at merge time. Generated Supabase types remain deferred under C25; once this migration is applied remotely and exact parity is verified, generated types become authoritative and the `TYPESCRIPT-BASELINE-001` / CI work resumes.

**Hardening (RECON-METADATA-PARITY-001A, same migration file, still local-only/unapplied):** the migration was strengthened after independent review to complete the exact-metadata guards, dependency safety, preservation inventory and routine gate. Every targeted column now carries a **complete state-specific metadata manifest** (10 columns) pinning exact type OID, typmod, rendered type, generated/identity state, collation, storage, compression, statistics target, column ACL, comment and security labels, with the only per-state differences being the audited attnum (production predates the migrations, so its physical column order — e.g. `papers.created_at` at attnum 14 vs. 16 locally, `tags.color` at 3 vs. 4 — differs and is pinned per state), the `created_at` default (`now()` vs. `timezone('utc'::text, now())`), the `study_type_pool.created_at` nullability, and the `tags.color` default. `projects.updated_at` now passes a **proactive Phase-A dependency inventory** before any DDL — `pg_depend` beyond its own default, non-not-null constraints, key/expression/predicate indexes, extended statistics, views/rules, RLS policies, other-column defaults/generation expressions, functions that consume `projects.updated_at` or the projects whole row (a precise scan that excludes the generic `set_updated_at`/`update_updated_at_column` trigger functions), composite-row-type consumers, publication column-lists, whole-table publication membership and `FOR ALL TABLES` — with the approved `update_projects_updated_at` trigger handled explicitly rather than counted as drift. The **routine-inventory gate** now pins the 23 public routines by a complete fingerprint (schema, name, identity args, result, kind, language, security-definer, volatility, strictness, leakproof, parallel, config, body md5) — behavioral `c0c14ef5…` (environment-independent) plus a full owner/ACL fingerprint matching one of the two audited baselines (clean-replay `1f658861…` / production `c0b444c8…`) — so a routine whose body is unchanged but whose volatility, security-definer flag, config, owner or ACL changed is rejected; it is captured under lock (as late as possible before Phase B) and re-proved in Phase C. The **preservation inventory** was expanded to table kind/owner/ACL/RLS/FORCE/replica-identity, policies (with roles and permissive/restrictive mode), non-not-null constraints, retained indexes (definition + unique/valid/ready/clustered/replident), retained triggers (definition + enabled + deferrability), extended statistics, publication memberships/column-lists, relation and column security labels, table and column comments, owned sequences, and every retained column's full definition — masking only the exact intentionally-changed attribute (a `created_at` default; `study_type_pool.created_at` NOT NULL; `tags.color` default) and excluding only the fully-removed `projects.updated_at`. Verified: clean replay applies all 65 migrations as an S1 no-op → canonical; the **S2 path was validated read-only against the live linked project** — all 17 Phase-A guard predicates (exact production attnums, types, defaults, nullability, trigger states, index absence, zero-NULL, routine count + behavioral + `full_s2` fingerprints) pass, proving the C24 deploy passes Phase A and that Phase B converts the eight `timezone('utc',now())` defaults to `now()`; and a **31-case adversarial matrix** all resolve correctly (13 exact-metadata violations incl. altered attnum/type-OID/typmod/generated/collation/storage/statistics-target/column-ACL/column-comment/nullability/default; 8 `projects.updated_at` dependency probes incl. view, routine body, routine returning `projects`, `%ROWTYPE`, generated-column expression, publication column-list, whole-table publication, extended statistics; 5 routine metadata-only drifts incl. volatility/secdef/config/owner/ACL with unchanged bodies; 4 preservation successes proving an unrelated extended-statistics object, a publication, and table/column comments all survive) with the database returning to canonical S1 (`CANONICAL-LOCAL-STATE-RESTORED`). Application validation re-run in full: lint 0 errors, Vitest 300 passed, node typecheck passes, application typecheck unchanged at the pre-C25 baseline (48 diagnostics, 0 new), build passes, Playwright 9/9, zero residual E2E artifacts. Index absence is backed by reproducible production evidence (`pg_stat_user_indexes`: `idx_papers_user_created` 1385 scans / `idx_papers_user_insert_order` 858 / `idx_synonym_pool_user_canonical` 117 vs. the seven bare indexes absent and unmissed; `EXPLAIN` on the doi/pmid/year contracts uses `idx_papers_user_insert_order` with the bare column as a Filter; the `*_user_id` indexes are covered by the user_id-leading unique composites via left-prefix). The stale hard-coded ledger snapshot in `deployment.md` was replaced with durable "always check `supabase migration list --linked`" guidance.
