# Architectural Decisions and Re-evaluation Triggers

## Decisions made

### 1. Server-side everything for the read path

**Decision:** All filtering, sorting, pagination, keyword matching, and full-text search happen in Postgres. The client never holds more than one page (100 papers) in the display cache.

**Rationale:** The app started by fetching all papers into memory. At ~400 papers with abstracts, this was ~1.2MB per load and growing linearly. Server-side processing keeps the client payload constant regardless of library size.

### 2. Abstract excluded from list, loaded on demand

**Decision:** The papers list fetches `has_abstract` (a stored generated boolean) instead of the full `abstract` text. Abstracts are fetched individually when a row is expanded, or in batch for bulk analysis.

**Rationale:** Abstracts are ~500 bytes each and only needed for expand/edit/analyze. Excluding them saves ~200KB on the initial 400-paper load. `staleTime: Infinity` means each abstract is fetched at most once per session.

### 3. Sort/filter cache key split

**Decision:** React Query keys for count, allFilteredIds, and keywordOptions include filter params but NOT sort params. Only the papers list key includes sort.

**Rationale:** Changing sort column was re-fetching 7 queries including keyword options and count. After the split, sort changes trigger only 3 queries (list + tags + projects). Filters still correctly invalidate everything.

### 4. Keyword filter uses NOT EXISTS double-negation for AND semantics

**Decision:** The `filter_papers_by_keywords` RPC uses `NOT EXISTS(SELECT ... WHERE NOT EXISTS(...))` rather than array containment or JOIN/GROUP HAVING.

**Rationale:** This pattern correctly handles AND semantics across three separate jsonb columns (keywords, mesh_terms, substances) with case-insensitive matching. A paper matches if ALL requested keywords appear in ANY of the three columns.

### 5. Select-all uses a separate allFilteredIds query

**Decision:** Select-all fetches ALL matching IDs in a separate unbounded query, independent of the paginated display query.

**Rationale:** With infinite scroll, the user may have only loaded 1–2 pages but wants to select all 400 matching papers. A separate query ensures select-all always covers the full filtered set.

---

## What was explicitly NOT optimized (Phase C)

### GIN indexes on jsonb keyword columns

**Status:** Not created. Not justified at current scale.

**What it would do:** A GIN index on `keywords`, `mesh_terms`, and/or `substances` would allow Postgres to look up keyword containment via index scan instead of expanding every jsonb array for every paper.

**Why deferred:** At 389 papers, keyword RPCs execute in ~15ms. The GIN index would improve this to perhaps ~2ms, but network RTT (~200ms) makes this invisible to the user. The index adds write overhead and storage.

### RPC rewrite for keyword filter/options

**Status:** Not rewritten. Current O(n×k) CTE/LATERAL pattern is adequate.

**What it would do:** Rewriting the RPCs to use a denormalized `paper_keywords` junction table or GIN-indexed containment checks would reduce keyword query cost from O(n×k) to O(log n).

**Why deferred:** Same as above. DB execution time is <5% of wall time at current scale.

### Unused index cleanup

**Status:** `idx_papers_user_doi_unique` has 0 index scans. Not dropped.

**Why deferred:** The index is small (~56KB) and may be useful for future deduplication logic. Dropping it saves negligible space.

---

## Performance re-evaluation triggers

> **Re-open Phase C performance optimization if ANY of these conditions are met:**

### Trigger 1: Library size approaches 2,000–5,000 papers

At 2,000 papers, keyword queries reach ~45–50ms DB execution time. At 5,000, they reach ~110–130ms. At 10,000, they reach ~225–275ms. The crossover point where DB time exceeds network RTT is around 5,000 papers.

**Measured data (EXPLAIN ANALYZE, April 2026):**

| Query | 389 papers | 2,000 | 5,000 | 10,000 |
|---|---|---|---|---|
| papers_list (p0) | 1.6 ms | 4.1 ms | 8.4 ms | 36.8 ms |
| count | 0.4 ms | 1.6 ms | 4.2 ms | 8.9 ms |
| all_ids | 0.5 ms | 2.2 ms | 5.7 ms | 18.6 ms |
| kw_filter (1 kw) | 15.2 ms | 44.9 ms | 111.7 ms | 224.5 ms |
| kw_options | 16.0 ms | 50.6 ms | 127.6 ms | 275.4 ms |
| fts_search | 0.7 ms | 2.9 ms | 9.0 ms | 29.1 ms |

### Trigger 2: User-reported slowness on keyword filter or keyword dropdown

If users report that selecting a keyword filter or opening the keyword dropdown feels slow (>500ms perceived), re-measure and consider Phase C.

### Trigger 3: Multi-user or shared libraries

If the app becomes multi-user with shared paper libraries, the per-user index filtering assumption may break. The current `idx_papers_user_created` index partitions by user; shared libraries would need a different indexing strategy.

### Trigger 4: Network latency changes

The current Supabase instance is in Mumbai. If the user moves or the app gains users in different regions, or if Supabase is migrated to a closer region, network RTT may drop and DB execution time may become the dominant cost sooner.

---

## What to do when triggered

1. Re-run EXPLAIN ANALYZE on `filter_papers_by_keywords` and `get_keyword_options` at the new paper count.
2. Compare DB execution time vs network RTT. If DB time > 100ms, proceed.
3. **Recommended Phase C optimization:** Create a GIN index on a combined keyword expression, or create a materialized `paper_keywords` junction table. Rewrite the two keyword RPCs to use index scans. Estimated: 1 PR, 1 migration, 2 RPC rewrites.
4. Re-measure after optimization. Target: keyword queries under 20ms at the new scale.
