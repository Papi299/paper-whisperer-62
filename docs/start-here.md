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

**Remaining follow-up work:**
- Missing UPDATE RLS policy on `paper_attachments`
- Title-based import auto-selects first PubMed/Crossref match without user confirmation — needs a preview/review step
- Title-only duplicate detection is not covered by the dedup scan RPC (`get_duplicate_papers` only groups by PMID/DOI)

**Audited and confirmed correct (no action needed):**
- `user_id` nullability — all user-scoped tables already have `user_id NOT NULL` at the DB level
- FK `ON DELETE CASCADE` — all user-scoped tables now have correct CASCADE behavior

## What is stable — do not reopen casually

- The read-path architecture (server-side filter/sort/paginate/lazy-load)
- The keyword filter RPC and keyword options RPC
- The abstract on-demand loading pattern
- The sort/filter cache key split
- The select-all-filtered-IDs mechanism

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

The app is performant at current scale. Network RTT to Supabase Mumbai (~200ms from Israel) dominates wall time, not DB execution. Focus new work on **features**, not performance, unless the paper count grows past ~2,000 or users report slowness.

## Key files

| File | Role |
|---|---|
| `src/hooks/usePapers.ts` | Core papers infinite query + server filter/sort |
| `src/hooks/useAbstract.ts` | On-demand abstract fetch + batch fetch |
| `src/hooks/papers/useBulkSelection.ts` | Select-all via `allFilteredIds` |
| `src/lib/buildPapersQuery.ts` | PostgREST query builder with filter predicates |
| `src/lib/queryKeys.ts` | React Query key structure |
| `src/pages/Dashboard.tsx` | Main page — orchestrates all hooks |
| `src/components/papers/PaperList.tsx` | Virtualized table with lazy abstract expand |
| `supabase/migrations/` | All DB schema + RPC definitions |
