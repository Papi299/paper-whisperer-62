# Read-Path Architecture

## Overview

The dashboard loads a paginated, server-filtered, server-sorted list of papers. Heavy columns (`abstract`, `search_vector`) are excluded from the list query and loaded on demand. Keyword filtering, keyword options, and full-text search are handled by Postgres RPCs.

## Papers list query

**Hook:** `usePapers()` → `useInfiniteQuery` with PAGE_SIZE=100.

**SELECT columns:** `id, user_id, title, authors, year, journal, pmid, doi, has_abstract, study_type, raw_study_type, statistical_methods, keywords, raw_keywords, mesh_terms, substances, pubmed_url, journal_url, drive_url, tldr, notes, insert_order, created_at, updated_at, paper_attachments(...)`.

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
- `notesPresence` — tri-state notes filter (`"all"` / `"has"` / `"none"`)

`filterPaperIds` semantics:
- `undefined` = filter still loading (show placeholder)
- `null` = no active ID filter
- `[]` = filter active but no matches
- `[...ids]` = filter active, these IDs match

`notesPresence` semantics (mirrors the list row sticky-note indicator's `paper.notes?.trim()` rule — NULL and whitespace-only both count as "no notes"):
- `"all"` = no notes predicate applied (default)
- `"has"` = only papers where `notes IS NOT NULL` AND contains at least one non-whitespace character
- `"none"` = only papers where `notes IS NULL` OR contains only whitespace

Predicate implementation lives in `applyFilterPredicates` in `src/lib/buildPapersQuery.ts` via PostgREST `match` against POSIX regex `[^[:space:]]` / `^[[:space:]]*$`.

### Keyword filter

**RPC:** `filter_papers_by_keywords(p_user_id, p_keywords)`

**Algorithm:** CTE builds a `synonym_map` by expanding `keywords`, `mesh_terms`, and `substances` jsonb arrays via `jsonb_array_elements_text` for all user papers. Then uses `NOT EXISTS` double-negation for AND semantics: a paper matches only if it contains ALL requested keywords across any of the three columns.

**Query plan:** Index scan on `idx_papers_user_created` → LATERAL jsonb expansion → Nested Loop Anti Join. Cost is O(n × k) where n = papers and k = avg keywords per paper.

### Keyword options

**RPC:** `get_keyword_options(p_user_id, p_paper_ids, p_year_from, p_year_to, p_study_types)`

**Algorithm:** CROSS JOIN LATERAL on `keywords || mesh_terms || substances` jsonb arrays → `DISTINCT lower()` → sorted. Optional filters narrow the paper set first. Same O(n × k) cost as keyword filter.

**Caching:** `staleTime: 30_000` (30 seconds). Keyed by filter params only (not sort).

### Search (four mutually-exclusive modes)

The main search box routes to one of four mutually-exclusive paths based on the shape of the debounced (300 ms) query. Mode classification happens in `src/hooks/useFilterState.ts`; each mode fires at most one server-side query via `useQuery`.

| User input | Mode | RPC | Server semantics |
|---|---|---|---|
| Empty / whitespace | None | (no query fires) | Read path runs without a search ID filter |
| Unquoted, 1–2 chars | **Short ILIKE** | `search_papers_short(p_user_id, p_query)` | Per-field `ILIKE '%query%'` on title / abstract / journal / notes + `EXISTS` over `authors::jsonb` and `keywords::jsonb` arrays |
| Unquoted, ≥3 chars | **Prefix-aware FTS** | `search_papers(p_user_id, p_query, p_limit, p_offset)` | `search_vector @@ to_tsquery('english', …)` — see prefix-tokenization rule below |
| Quoted `"…"` non-empty | **Literal phrase** | `search_papers_short(p_user_id, <inner phrase>)` | Reuses the short-search RPC with the inner phrase. No stemming, no tokenizer, Unicode-safe, punctuation-preserving (e.g. `"COX-2"` works). |

Phrase mode takes priority over FTS and short modes. Unterminated quotes, a single `"`, or `""` all fall back to unquoted routing. Mode classification is bit-identical to the README "Current search behavior" section.

**Prefix-aware FTS tokenization** (`search_papers`, ≥3 chars). The RPC does **not** call `websearch_to_tsquery`. It strips the ten tsquery operator / control characters `& | ! ( ) : * < > ' " \` from the input, whitespace-splits, appends `:*` to each non-empty token, `&`-joins the tokens, and feeds the result to `to_tsquery('english', …)`. So `guideli` matches `guideline` and result counts narrow monotonically as the user types. Unicode codepoints (Latin diacritics, Cyrillic, Hebrew, Arabic, CJK, etc.) are preserved — the operator blacklist is byte-safe by codepoint. Ranking is `ts_rank(search_vector, tsquery)` desc. Explicit `OR` and `-` exclusion are intentionally unsupported. (Migration: `20260417030000_prefix_search.sql`.)

**Fields searched.** All three non-empty modes search the same **six** fields:

- **title**
- **abstract**
- **authors**
- **journal**
- **notes**
- **keywords**

The FTS path consults the generated `papers.search_vector` tsvector; the short / phrase paths run per-field ILIKE / `EXISTS` over `jsonb_array_elements_text`. (Migrations: `20260417020000_add_notes_to_search.sql` added `notes`; `20260420010000_keywords_in_search_with_attribution.sql` added `keywords`.)

**`search_vector` weight ladder.** The generated column concatenates per-field weighted tsvectors:

- **A** = `title`
- **B** = `abstract`
- **C** = `journal`, `authors::text`, `keywords::text`
- **D** = `notes`

Title remains the dominant rank signal. GIN index `idx_papers_search_vector` is recreated on the rebuilt column.

### Matched-field attribution

Both `search_papers` and `search_papers_short` return six per-field booleans alongside the matching row:

```
matched_title, matched_abstract, matched_authors,
matched_journal, matched_notes, matched_keywords
```

For the FTS path each flag is computed server-side by testing the field's own `to_tsvector('english', coalesce(field, ''))` against the same prefix-aware tsquery used in the `WHERE` clause; for the short / phrase paths each flag is the corresponding `ILIKE` / `EXISTS … ILIKE`. `useFilterState.ts` assembles a `Map<paper_id, MatchFlags>` (type defined in `src/hooks/papers/types.ts`) and threads it to `PaperList`, which renders an authoritative "Matched in: …" sub-line on each matching row in fixed UI order — **Title → Abstract → Authors → Journal → Notes → Keywords**. Attribution is **server-driven**; the client must not re-tokenize the query or re-derive the flags. (Migration: `20260420010000_keywords_in_search_with_attribution.sql`.)

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
