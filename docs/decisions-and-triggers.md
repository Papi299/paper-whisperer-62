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

---

## Commercialization decisions (planning)

The decisions below are commercial / product decisions, not performance / architecture decisions. They were recorded as part of the commercialization planning PR. **None of them is implemented in the current codebase** — see [commercial-architecture.md](commercial-architecture.md) for the full architecture and [quotas-and-pricing.md](quotas-and-pricing.md) for the provisional plan structure.

### C1. Single-user MVP — no teams, no shared libraries

**Decision:** The first commercial release is single-user only. One subscription = one individual user. No team accounts, no shared libraries, no collaboration features.

**Rationale:** The current data model partitions every user-scoped table on `user_id` and the RLS scheme is built around that assumption. Multi-user sharing is a non-trivial refactor (new ownership model, share permissions, invite flow, RLS rewrite) and is not required by the target audience for v1 (researchers, students, clinicians, dietitians, evidence-based knowledge workers managing their *own* libraries).

**Re-evaluation trigger:** explicit owner approval after launch, supported by user demand signal.

### C2. Plan direction — Core + AI

**Decision:** Two plans for v1: a **Core** plan (organize / import / search / filter / tags / projects / notes / saved searches / attachments / export) and an **AI** plan (everything in Core plus a defined monthly AI-analysis quota). Monthly + annual cadence per plan, with a 7-day free trial on first subscribe.

**Rationale:** AI is the only meaningfully variable cost (Gemini per-call). Tiering on AI access maps directly to the cost model and minimizes the SKU count for App Store / Play Store review.

**Out of scope for MVP:** credit packs / one-time AI top-ups, permanent free tier, family / household plans, education pricing. May be revisited post-launch.

### C3. AI is premium and bounded

**Decision:** AI usage is **never unlimited**. The AI plan ships with an explicit monthly quota; the Core plan ships with no AI or, at most, a very small monthly "taste" (TBD per [quotas-and-pricing.md](quotas-and-pricing.md)). Trial AI usage is itself capped at a small total so a 7-day trial cannot burn an AI-plan-month's worth of Gemini calls.

**Rationale:** Gemini is metered upstream cost; every AI call has marginal cost. Offering "unlimited AI" as a base feature is open-ended risk on margin and opens an abuse surface.

**Enforcement:** quota is decremented and verified inside the `analyze-paper` Edge Function before the Gemini call. Client-side checks are UX only and not a security boundary.

### C4. Internal entitlements decoupled from billing providers

**Decision:** The application's feature-gating logic reads from a provider-agnostic internal entitlement model. **No application code branches on Stripe vs. Apple IAP vs. Google Play vs. RevenueCat.** Each provider has its own thin Edge Function that ingests provider events into the same internal model.

**Rationale:** Provider rules, fee structures, webhook shapes, and refund mechanics differ. Branching the app on these differences produces N copies of every gate. A single internal model — populated by N thin ingestion functions — keeps application code stable across provider changes and makes adding or swapping a provider purely additive.

**Implication:** the chosen billing provider is **not yet decided**. Whichever provider is later selected lands as a separate dated decision and a new ingestion Edge Function. The application code does not change as a result.

### C5. Commercial state separated from `profiles`

**Decision:** Commercial state (current plan, subscription status, trial expiry, current period bounds, AI quota, storage quota, AI used this period, storage used this period) is **not** added as columns on `public.profiles`. It lives in dedicated tables: `user_entitlements` (one-row-per-user read model), `subscriptions` (history of provider state), `usage_counters` (per-period counters), and optionally `subscription_events` (audit log).

**Rationale:**

- `profiles` is client-writable for the owning user (display name, PubMed API key); commercial state must be **server-write-only**. Splitting tables avoids fine-grained per-column GRANTs and the bug class of the wrong column slipping into a client update.
- Commercial state has different lifecycle (webhook-driven), different write authority (service-role only), and a multi-row history per user, none of which fit a single profile row.
- Cleaner RLS surface: a single-purpose `user_entitlements` table is easier to lock down than a multi-purpose `profiles` table.
- Provider-specific fields (`billing_customer_id`, `billing_subscription_id`, `raw_payload`) belong with the subscription record, not with profile/settings data.

**Implication:** `profiles` continues to hold profile/settings only. A future schema PR introduces the new commercial tables. The full table shapes and rationale are in [commercial-architecture.md](commercial-architecture.md).

### C6. Documentation policy is now active

**Decision:** Every meaningful change must update documentation in the same PR, and every Claude Code task report must end with a "Documentation updates" section. See [documentation-policy.md](documentation-policy.md) for the full rule and PR checklist.

**Rationale:** As commercialization, billing, mobile packaging, store submission, and AI quota work all begin in parallel, the rate of decisions outpaces what a single developer can hold in memory. Docs are the only durable record across Claude Code sessions and contributors. Stale or missing docs become a real failure mode for the owner and for future assistants.

**Re-evaluation trigger:** explicit owner override only.
