# Read-Path Architecture

## Overview

The dashboard loads a paginated, server-filtered, server-sorted list of papers. Heavy columns (`abstract`, `search_vector`) are excluded from the list query and loaded on demand. Keyword filtering, keyword options, and full-text search are handled by Postgres RPCs.

## Papers list query

**Hook:** `usePapers()` → `useInfiniteQuery` with PAGE_SIZE=100.

**SELECT columns:** `id, user_id, title, authors, year, journal, pmid, doi, has_abstract, study_type, raw_study_type, statistical_methods, keywords, raw_keywords, mesh_terms, substances, pubmed_url, journal_url, drive_url, tldr, insert_order, created_at, updated_at, urls, paper_attachments(...)`.

**Excluded:** `abstract` (loaded on demand), `search_vector` (never sent to client).

**`has_abstract`** is a `GENERATED ALWAYS AS (abstract IS NOT NULL) STORED` boolean column. It lets the UI show an "abstract available" indicator without fetching the text.

### Pagination

- `useInfiniteQuery` with `getNextPageParam` based on page length.
- `IntersectionObserver` sentinel at the bottom of the table triggers `fetchNextPage()` with 200px margin.
- Virtualizer manages row heights (52px base, 220px expanded).

### Server-side sorting

Sort column and direction are query params. Changing sort only invalidates the papers list + junction queries (tags, projects). It does **not** re-fetch keyword options, filtered count, or filtered IDs — these are keyed separately.

**Query key structure:**
```
["papers", "list",    { ...filterParams, ...sortParams }]  // papers list
["papers", "count",   { ...filterParams }]                  // filtered count
["papers", "allIds",  { ...filterParams }]                  // select-all IDs
["papers", "keywordOptions", { ...filterParams }]           // keyword dropdown
```

## Server-side filtering

### Filter model

`ServerFilterParams` contains:
- `filterPaperIds` — pre-resolved IDs from keyword filter / tag filter / project filter / search
- `yearFrom`, `yearTo` — year range
- `studyTypes` — study type array

`filterPaperIds` semantics:
- `undefined` = filter still loading (show placeholder)
- `null` = no active ID filter
- `[]` = filter active but no matches
- `[...ids]` = filter active, these IDs match

### Keyword filter

**RPC:** `filter_papers_by_keywords(p_user_id, p_keywords)`

**Algorithm:** CTE builds a `synonym_map` by expanding `keywords`, `mesh_terms`, and `substances` jsonb arrays via `jsonb_array_elements_text` for all user papers. Then uses `NOT EXISTS` double-negation for AND semantics: a paper matches only if it contains ALL requested keywords across any of the three columns.

**Query plan:** Index scan on `idx_papers_user_created` → LATERAL jsonb expansion → Nested Loop Anti Join. Cost is O(n × k) where n = papers and k = avg keywords per paper.

### Keyword options

**RPC:** `get_keyword_options(p_user_id, p_paper_ids, p_year_from, p_year_to, p_study_types)`

**Algorithm:** CROSS JOIN LATERAL on `keywords || mesh_terms || substances` jsonb arrays → `DISTINCT lower()` → sorted. Optional filters narrow the paper set first. Same O(n × k) cost as keyword filter.

**Caching:** `staleTime: 30_000` (30 seconds). Keyed by filter params only (not sort).

### Full-text search

**RPC:** `search_papers_short(p_user_id, p_search_term)` for < 3 chars (ILIKE).

**Direct query:** For 3+ chars, uses `search_vector @@ websearch_to_tsquery('english', term)` with `ts_rank` ordering. GIN index `idx_papers_search_vector` provides efficient lookup.

## Abstract on-demand loading

**Hook:** `useAbstract(paperId | null)` — enabled only when paperId is truthy.

**Behavior:**
- `staleTime: Infinity` — abstract text never goes stale during a session
- `gcTime: 30 * 60 * 1000` — cached for 30 minutes after last use
- First expand of a paper row → 1 fetch. Second expand → 0 fetches (cache hit).

**Batch fetch:** `fetchAbstractsBatch(paperIds, queryClient)` checks individual cache entries, fetches only uncached IDs in one `.in("id", uncached)` query, then warms individual cache entries.

**Usage contexts:**
- `PaperList` row expand → `useAbstract(isExpanded ? paper.id : null)`
- `EditPaperDialog` → `useAbstract(open && paper ? paper.id : null)`
- `handleAnalyzePaper` → `fetchAbstract()` imperative
- `handleBulkAnalyze` → `fetchAbstractsBatch()` for selected papers

## Select-all semantics

**Mechanism:** A separate `allFilteredIds` query fetches ALL matching paper IDs (no pagination limit). This runs alongside the paginated display query but with its own cache key (filter-only, no sort).

- Checkbox is disabled until `allFilteredIds` resolves (`isSelectAllReady`).
- Toggle applies to the full filtered set, not just the visible page.
- Bulk operations (delete, tag, project-assign) use the selected ID set.

## Export and analytics

**Export:** `useExportPapers()` bypasses the paginated query entirely. Fetches ALL matching papers in one request (including `abstract`), generates CSV/RIS/BibTeX. `staleTime: 0` — always fresh.

**Analytics:** `useAnalyticsData()` similarly fetches the full filtered set, but only when the analytics panel is open (conditional query).

Both are independent of the paginated list cache and do not affect list performance.
