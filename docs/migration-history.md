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

## Evidence gathering (no PR — investigation only)

**Date:** April 2026
**What:** Ran EXPLAIN ANALYZE on all key queries via temporary PL/pgSQL wrapper. Generated synthetic data at 500/2K/5K/10K paper tiers. Measured DB execution times at each scale.
**Finding:** At current scale (389 papers), all queries execute in <40ms. Network RTT (~200ms) dominates. Keyword RPCs scale O(n×k) and reach ~225–275ms at 10K papers. Phase C optimization deferred — see [decisions-and-triggers.md](decisions-and-triggers.md).
