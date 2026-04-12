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

**Remaining follow-up (not in this task):**
- Nullable `user_id` columns on 8 tables (medium priority)
- Missing `ON DELETE CASCADE` on FKs to auth.users (low priority)
- Missing UPDATE RLS policy on `paper_attachments` (low priority)

## Evidence gathering (no PR — investigation only)

**Date:** April 2026
**What:** Ran EXPLAIN ANALYZE on all key queries via temporary PL/pgSQL wrapper. Generated synthetic data at 500/2K/5K/10K paper tiers. Measured DB execution times at each scale.
**Finding:** At current scale (389 papers), all queries execute in <40ms. Network RTT (~200ms) dominates. Keyword RPCs scale O(n×k) and reach ~225–275ms at 10K papers. Phase C optimization deferred — see [decisions-and-triggers.md](decisions-and-triggers.md).
