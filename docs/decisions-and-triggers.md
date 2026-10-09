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

> **Clarified by C12 (2026-05-21).** C1 remains accurate **for the shippable MVP scope**. Labs / Teams is now documented as a future roadmap / "Coming Soon / Contact Sales" tier (C12) — present on the marketing surface for price anchoring and B2B lead capture, but **not sellable and not implemented** in MVP. C1's substance (single-user shippable MVP, no shared libraries, no collaboration code) is unchanged.

**Decision:** The first commercial release is single-user only. One subscription = one individual user. No team accounts, no shared libraries, no collaboration features.

**Rationale:** The current data model partitions every user-scoped table on `user_id` and the RLS scheme is built around that assumption. Multi-user sharing is a non-trivial refactor (new ownership model, share permissions, invite flow, RLS rewrite) and is not required by the target audience for v1 (researchers, students, clinicians, dietitians, evidence-based knowledge workers managing their *own* libraries).

**Re-evaluation trigger:** explicit owner approval after launch, supported by user demand signal.

### C2. Plan direction — Core + AI

> **Superseded by C8 (2026-05-21).** The Core + AI split has been collapsed into **Free + Pro + Labs/Teams** (Labs/Teams as future "Coming Soon / Contact Sales"). The 7-day free trial has been replaced by a **Free forever** tier with a small lifetime AI teaser. Retained below as historical context.

**Decision:** Two plans for v1: a **Core** plan (organize / import / search / filter / tags / projects / notes / saved searches / attachments / export) and an **AI** plan (everything in Core plus a defined monthly AI-analysis quota). Monthly + annual cadence per plan, with a 7-day free trial on first subscribe.

**Rationale:** AI is the only meaningfully variable cost (Gemini per-call). Tiering on AI access maps directly to the cost model and minimizes the SKU count for App Store / Play Store review.

**Out of scope for MVP:** credit packs / one-time AI top-ups, permanent free tier, family / household plans, education pricing. May be revisited post-launch.

### C3. AI is premium and bounded

> **Refined by C8 / C10 (2026-05-21).** The "AI is premium and bounded" principle stands. The shape now is: **Free** ships with 15 lifetime AI calls (taste, not trial); **Pro** ships with 350 / month; the 7-day-trial cap has been removed because there is no time-based trial. Server-side enforcement requirement is unchanged.

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
- Commercial state has different lifecycle (webhook-driven), different write authority (service-role only), and a multi-row history per user, none of which fit a single profile row. *(Note, 2026-09-29: "service-role only" means server-side only. It is not a standing grant. Under C57, live in Production since 2026-09-29, `service_role` holds no table privilege on the commercial tables until the billing writer's own migration grants the minimum it needs.)*
- Cleaner RLS surface: a single-purpose `user_entitlements` table is easier to lock down than a multi-purpose `profiles` table.
- Provider-specific fields (`billing_customer_id`, `billing_subscription_id`, `raw_payload`) belong with the subscription record, not with profile/settings data.

**Implication:** `profiles` continues to hold profile/settings only. A future schema PR introduces the new commercial tables. The full table shapes and rationale are in [commercial-architecture.md](commercial-architecture.md).

### C6. Documentation policy is now active

**Decision:** Every meaningful change must update documentation in the same PR, and every Claude Code task report must end with a "Documentation updates" section. See [documentation-policy.md](documentation-policy.md) for the full rule and PR checklist.

**Rationale:** As commercialization, billing, mobile packaging, store submission, and AI quota work all begin in parallel, the rate of decisions outpaces what a single developer can hold in memory. Docs are the only durable record across Claude Code sessions and contributors. Stale or missing docs become a real failure mode for the owner and for future assistants.

**Re-evaluation trigger:** explicit owner override only.

---

## Security decisions

### S1. SECURITY DEFINER RPCs must enforce `auth.uid()` ownership

**Decision:** Any `SECURITY DEFINER` Postgres function in this repo that accepts a `p_user_id` (or any other user-identifier) parameter and uses it to scope queries against user-owned data **must** verify it against `auth.uid()`. The standard guard is:

```sql
IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
  RAISE EXCEPTION 'Unauthorized: user mismatch';
END IF;
```

placed at the top of the function body. Equivalent alternative: drop the parameter and use `auth.uid()` directly in the function body. Both are acceptable; the explicit-guard form is preferred because it makes the security contract visible at the call site and matches the precedent set by `safe_bulk_insert_papers`.

**Rationale:** `SECURITY DEFINER` runs with the function owner's privileges and **bypasses table-level RLS** inside the function. RLS on the underlying table is therefore not a sufficient safeguard when the function scopes queries by a client-supplied UUID. Without an `auth.uid()` check, an authenticated user who knows another user's UUID can call the function and receive that user's row IDs / metadata / aggregates — exactly the gap closed by the May 2026 migration `20260518010000_rpc_auth_uid_ownership_check.sql` for `search_papers`, `search_papers_short`, `filter_papers_by_keywords`, and `get_keyword_options`.

**Applies to (current inventory, all hardened or compliant):**
- `set_paper_tags`, `set_paper_projects`, `bulk_set_paper_tags`, `bulk_set_paper_projects` — derive ownership from `auth.uid()` internally; no `p_user_id` parameter.
- `merge_exact_duplicates` — `auth.uid()` only; no `p_user_id` parameter.
- **Left this inventory — C49 (`20260926152414`, live in Production since 2026-09-26).** `search_papers`, `search_papers_short`, `filter_papers_by_keywords`, `get_keyword_options` (hardened by `20260518010000_rpc_auth_uid_ownership_check.sql`) and `get_duplicate_papers` (`auth.uid()` only) need no authority beyond the caller's own. From that migration on they are **SECURITY INVOKER**, in the repository schema and in Production alike — no longer SECURITY DEFINER RPCs, so this rule no longer governs them; table grants plus caller-owned RLS are their primary boundary, and their guards stay as defense-in-depth (C49). The migration-only rollout on 2026-09-26 took them out of Production's client-callable SECURITY DEFINER inventory ([deployment.md](deployment.md) §6.10). Until then Production ran all five as SECURITY DEFINER, and S1 governed them there.
- **Left this inventory — C52 (`20260927071803`, live in Production since 2026-09-27).** `bulk_update_study_types` and `bulk_update_keywords` derive ownership from `auth.uid()` internally and need no authority beyond the caller's own. From that migration on they are **SECURITY INVOKER**, in the repository schema and in Production alike — no longer SECURITY DEFINER RPCs, so this rule no longer governs them. The caller's `papers` grants plus the caller-owned RLS policies are their primary boundary, and each body's `papers.user_id = auth.uid()` predicate stays as defense-in-depth (C52). The migration-only rollout on 2026-09-27 took them out of Production's client-callable SECURITY DEFINER inventory ([deployment.md](deployment.md) §6.13). Until then Production ran both as SECURITY DEFINER, and S1 governed them there. At C52's rollout `safe_bulk_insert_papers` was still SECURITY DEFINER in Production and still governed by S1 there; C53 converted it later the same day (next item).
- **Left this inventory — C53 (`20260927123856`, live in Production since 2026-09-27).** `safe_bulk_insert_papers` keeps its explicit `p_user_id = auth.uid()` guard — S1's original precedent — byte-for-byte. From that migration on it is **SECURITY INVOKER**, in the repository schema and in Production alike — no longer a SECURITY DEFINER RPC, so this rule no longer governs it. The caller's `papers` INSERT/SELECT grants, `papers_insert_order_seq` USAGE and the caller-owned RLS policies are its primary database boundary, and the guard stays as defense-in-depth (C53). The migration-only rollout on 2026-09-27 took it out of Production's client-callable SECURITY DEFINER inventory ([deployment.md](deployment.md) §6.14). Until then Production ran it as SECURITY DEFINER, and S1 governed it there.

**Required for any new `SECURITY DEFINER` RPC:** the migration creating it must include either the explicit guard or an `auth.uid()`-derived ownership pattern; review will reject SECURITY DEFINER RPCs that lack one of these. It must also follow **C50**: if its body resolves any relation or type through `search_path`, it pins `SET search_path = public, pg_temp` (`pg_temp` last), and it is classified in suite `021` either way.

**Re-evaluation trigger:** if Supabase later supports a SECURITY DEFINER mode that re-applies RLS, this decision can be revisited; for now, RLS bypass inside SECURITY DEFINER is the documented Postgres behavior.

### S2. Client-side queries on user-owned tables should carry explicit `user_id` filters where safe

**Decision:** When a hook or query in `src/` mutates or selects rows from a table that has a direct `user_id` column **and** the caller already has `userId` (from `useAuth().user.id` or a hook arg), the query should include an explicit `.eq("user_id", userId)` predicate alongside whatever other filters it uses (typically `.eq("id", rowId)`). This applies to `papers`, `paper_attachments`, `filter_presets`, `projects`, `tags`, `profiles`, and the keyword / study-type / synonym / exclusion pool tables. It does **not** apply to junction tables that lack a direct `user_id` column (e.g. `paper_tags`, `paper_projects`) — those should continue to rely on RLS-through-parent-row ownership.

**Rationale:** RLS on these tables remains the primary security boundary and is sufficient by itself. The explicit client-side filter is defense-in-depth: it makes ownership intent visible at the call site, prevents an accidental cross-user write if RLS were ever loosened or temporarily disabled during a migration, and gives a clearer audit trail in PostgREST logs (the `user_id=eq.…` qualifier appears in the request URL).

**Required predicate shape:**

```ts
// Update by row id:
await supabase.from("papers")
  .update(updates)
  .eq("id", paperId)
  .eq("user_id", userId);

// Delete by row id:
await supabase.from("filter_presets")
  .delete()
  .eq("id", presetId)
  .eq("user_id", userId);

// Inserts are exempt — the user_id is set in the insert payload itself.
```

For mutations where `userId` is not already guaranteed at the call site, add an explicit `if (!userId) { … }` guard (throwing for `useMutation` mutationFns, returning `false` for `Promise<boolean>` flows) **before** the supabase call rather than relying on a `userId!` non-null assertion. This matches the pattern in `addPaperManually` / `updatePaper`.

**Applies to (current state after the May 2026 client-side hardening PR):**
- `papers` — `updatePaper` and `deletePaper` in `usePaperMutations.ts` carry both predicates. Insert paths set `user_id` in the payload (no `.eq` needed).
- `filter_presets` — `deletePresetMutation`, `updatePresetMutation`, `renamePresetMutation` in `useFilterPresets.ts` carry both predicates.
- `paper_attachments` — `deleteAttachment` in `useAttachments.ts` carries both predicates.
- All `*_pool` and `*_exclusion_pool` tables — their hooks already carry `.eq("user_id", userId)` on every read/write per pre-existing convention; no change needed.
- `projects`, `tags` — `updateProject` / `deleteProject` in `useProjectMutations.ts` and `updateTag` / `deleteTag` in `useTagMutations.ts` carry both predicates after the second client-side hardening wave (May 2026). Insert paths (`createProject`, `createTag`) set `user_id` in the row payload (no `.eq` needed).
- `papers` (abstract read path) — `useAbstract`, `fetchAbstract`, and `fetchAbstractsBatch` in `useAbstract.ts` carry both `.eq("id", paperId)` (or `.in("id", paperIds)`) and `.eq("user_id", userId)` after the third client-side hardening wave (May 2026). `userId` is threaded from `useAuth().user.id` through `Dashboard.tsx` → `usePaperAnalysisActions` / `PaperList` / `EditPaperDialog` to the call sites.
- `papers` (bulk delete) — `bulkDeletePapers` in `useBulkMutations.ts` carries both `.in("id", paperIds)` and `.eq("user_id", userId)` on the DELETE chain after the bulk-delete hardening (May 2026). The pre-existing `if (!userId || paperIds.length === 0) return;` guard at the top of the callback makes `userId` provably non-null at the DELETE site. Closes the only S2 bulk-vs-single parity gap surfaced by the post-PR-#136 checkpoint audit.
  - **Out of scope for this wave (tracked separately):** the abstract query key `queryKeys.papers.abstract(paperId)` is intentionally **not** user-scoped. The defense-in-depth value lives in the query predicate; cache-key correctness for a hypothetical multi-tenant future is a smaller, isolated fix. In the current single-user MVP, sign-out garbage-collects the cache via TanStack Query's `gcTime`, so there is no practical leakage risk today.

**Status:** The S2 client-side hardening inventory is now closed for read and write paths on `user_id`-bearing tables. No further sites are deferred under this decision. Cache-key correctness is a separate, smaller follow-up not covered by S2.

**Nullable-safe threading at auth-boundary call sites.** When `userId` is threaded from `useAuth()` into a hook or component below the auth boundary, the receiving prop / argument **must** accept `string | null | undefined` (not just `string`) and the consumer must short-circuit on a falsy `userId` BEFORE issuing any Supabase / Edge Function call. `useAuth()` can yield `user === null` on an intermediate render during sign-out / sign-in transitions even when the parent component already guards with `if (!user) return null;` (the parent's null-return commit has not yet replaced the child). Direct `user.id` or `user!.id` reads at these call sites crash the page — see the post-PR-#135 Dashboard hotfix entry in `migration-history.md`. The standard pattern is `const userId = user?.id;` immediately after `useAuth()`, then thread `userId` everywhere downstream. This applies to all S2 read AND write paths that consume a threaded user id; it does not relax the `.eq("user_id", userId)` predicate requirement.

**Required for any new client-side mutation on a user-owned table:** include `.eq("user_id", userId)` alongside any `.eq("id", rowId)` filter. Review should reject mutation hooks that omit it.

**Re-evaluation trigger:** if a future feature legitimately needs to operate cross-user (none planned for the single-user MVP per [commercial-architecture.md](commercial-architecture.md) C1), the affected sites can be revisited individually.

---

## Commercial strategy pivot (2026-05-21)

The decisions below capture the owner-approved commercial pivot from a B2C-only / single-user / Core+AI / 7-day-trial framing to a web-first **Product-Led Growth (PLG)** model with **Stripe-first** billing, a **Free forever** entry tier, **Pro / Researcher** as the primary self-serve SKU, and **Labs / Teams** as a future B2B "Coming Soon / Contact Sales" tier. They supersede or refine C1–C5 where indicated. **No commercial code is implemented yet** — see [commercial-architecture.md §6](commercial-architecture.md) for the launch-blocker list and [quotas-and-pricing.md](quotas-and-pricing.md) for the MVP baseline values.

### C7. Web-first launch; mobile / app-store deferred (2026-05-21)

**Decision:** The MVP commercial launch is **web only**, delivered via the existing Vercel-hosted React SPA. Apple App Store and Google Play submissions are deferred to a later roadmap phase. Mobile work must not block the web commercial beta.

**Rationale:** Serious academic research workflows — systematic reviews, large bulk imports, multi-column filtering, AI-driven study classification — happen on desktop browsers. The product's strongest UX surface is already the web. App-store distribution adds policy, billing, packaging, and review work that is not on the path to first paid users.

**Implication:** Apple IAP and Google Play Billing are not implemented in MVP. Stripe (C8) is the only billing-provider ingestion path in the first paid release. The [commercial-architecture.md §8](commercial-architecture.md) provider-neutral ingestion model is intact; adding Apple / Google later is purely additive.

**Re-evaluation trigger:** owner approval after the web paid pilot, supported by user demand signal for mobile.

### C8. Stripe-first for web billing (2026-05-21) — **SUPERSEDED by C17 (2026-05-21)**

> **Superseded.** This decision was overturned the same day by [C17 — Merchant of Record (MoR)-first replaces Stripe-first for web billing](#c17-merchant-of-record-mor-first-replaces-stripe-first-for-web-billing-2026-05-21) below. The text is retained verbatim for historical accuracy. **Do not implement against this decision; read C17 instead.**

**Decision (superseded):** **Stripe** is the chosen billing provider for the web MVP. Web subscriptions are sold via Stripe Checkout; subscription state is ingested into the internal `subscriptions` + `user_entitlements` model via a `stripe-webhook` Edge Function with signature verification.

**Rationale:** Stripe supports the subscription model, future usage / add-on credit packs, B2B invoicing, and metered billing, without locking us into a payment provider when mobile work begins. It is the fastest provider to integrate against the planned `user_entitlements` schema.

**Hard constraint (blocker):** **Stripe implementation must not begin until the internal entitlement + quota schema and server-side enforcement exist.** Charging users without server-side quota enforcement on `analyze-paper` would mean the AI cost surface is unbounded for any user with a valid JWT. The implementation order in [commercial-architecture.md §7](commercial-architecture.md) — schema → AI quota enforcement → storage privacy + quota → Stripe — is the gating sequence; Stripe is item 5, not item 1.

**Implementation note (reaffirms C4):** the application code does not branch on Stripe. The webhook ingestion writes provider-agnostic rows into `subscriptions` / `user_entitlements`; the rest of the application reads from those rows. Adding Apple IAP / Google Play / RevenueCat later is purely additive.

**Re-evaluation trigger:** explicit owner approval. Switching providers post-launch is supported by C4 but is a non-trivial migration of customer / subscription mappings.

### C9. Freemium PLG replaces the 7-day time-based trial (2026-05-21)

**Decision:** There is **no 7-day time-based trial** in MVP. The trial mechanism is **Free forever** with a small lifetime AI teaser; users upgrade to Pro when they exhaust the AI teaser or want premium taxonomy features.

**Rationale:** Research workflows often do not reach the "aha" moment within a fixed 7-day window — building a library, importing existing references, and seeing the AI analysis prove useful on a real systematic-review use case takes weeks for many users. A time-bounded trial converts poorly against that workflow. A Free forever tier supports habit formation, and the AI teaser exhaustion is a sharper, behavior-driven upgrade signal than a calendar countdown.

**Implication:** `user_entitlements.subscription_status` does **not** include a `trialing` state in MVP. Free users have `subscription_status = 'none'` and `plan = 'free'`. The state machine is simpler than the C2-era plan.

**Re-evaluation trigger:** if closed-pilot data shows Free users routinely never upgrading (very low conversion despite high engagement), revisit by introducing a time-bounded AI bonus (e.g., "first 30 days get 50 AI calls") as a layer on top of Free — without reintroducing a hard time-based trial.

### C10. No paid AI-free "Core" tier in MVP (2026-05-21)

**Decision:** The MVP monetization focuses on **Free → Pro**. There is no paid AI-free "Core" tier. The previously-planned Core (organize) and AI (organize + AI) split has been collapsed.

**Rationale:** Two paid tiers complicate the funnel without clear evidence that a meaningful segment wants paid organization-only. The single Pro tier at $15 / month baseline includes the AI quota by default. If post-launch data shows demand for a cheaper organization-only paid tier, it can be added as a strictly additive change.

**Re-evaluation trigger:** closed-pilot data showing users willing to pay but explicitly not wanting AI, OR a competitor positioning shift that makes a Core SKU strategically important.

### C11. Free + Pro MVP baselines (2026-05-21)

**Decision (MVP baseline values, with mandatory instrumentation — not permanent):**

- **Free:** $0 forever; **1,500 papers**; **500 MB** PDF storage; **15 lifetime** AI calls; Keyword Pool included; Synonyms / Exclusions excluded (Pro-only premium taxonomy).
- **Pro / Researcher:** **$15 / month** baseline; **10,000 papers**; **2 GB** PDF storage; **350 AI calls / month**; Synonyms pool + Exclusions pool included; eligible for future add-on AI credit packs (C13).

**Critical framing:** these numbers are **MVP baselines with instrumentation**, not final or permanent pricing. They are high-confidence starting values approved for closed beta and the first paid pilot. They **must** be reviewed against real Gemini-cost data, real storage / paper usage per user, and real Free → Pro conversion observed in pilot before being treated as permanent. Future PRs **must not** describe these numbers as fixed or immutable; they live in [quotas-and-pricing.md](quotas-and-pricing.md) and any change is a dated decision here.

**Instrumentation requirement (blocker for closed beta).** The schema and Edge Functions must surface the per-user usage, AI-success / AI-fail / quota-exhausted, storage, paper-count, and Free → Pro conversion metrics enumerated in [quotas-and-pricing.md §4](quotas-and-pricing.md) from day one. Without these, the post-pilot re-evaluation is impossible.

**Re-evaluation trigger:** every 60–90 days of pilot / open-beta data, OR when Gemini's per-token pricing changes materially.

### C12. Labs / Teams is "Coming Soon / Contact Sales" only — NOT self-serve in MVP (2026-05-21)

**Decision:** **Labs / Teams** appears on the marketing pricing page and inside the app as **"Coming Soon" / "Contact Sales"** only. It is **not sellable in MVP** and **must not be implemented as a self-serve SKU** until the underlying shared-libraries + seat-management architecture exists.

**Baseline range (anchor, not commitment):** $99–$149 / month for up to 5 seats; unlimited papers; 10 GB storage; AI quota TBD (likely team-level).

**Architectural prerequisites (none currently implemented; all out of MVP scope):**
- Shared libraries — multiple users on the same paper library; requires a new ownership model (`team_id` column or parallel ACL layer), an RLS rewrite, and a refactor of every mutation hook to respect team-level ownership.
- Seat management — owner + member roles, invitations, removal, owner-transfer.
- Team-level entitlements — `team_entitlements` table (or extension to `user_entitlements`) so quotas apply to the team, not per-seat.
- Audit log of team actions.
- Optional SSO for institutional buyers.

**Hard constraint:** future PRs **must not** treat Labs / Teams as a sellable SKU. Specifically, no Stripe product, no App Store SKU, no Play Console SKU is configured for Labs / Teams until the architecture above exists. The role today is strictly **price anchoring + B2B lead capture** (a "Contact Sales" form that emails the owner).

**Re-evaluation trigger:** owner-approved roadmap PR to begin shared-libraries work, supported by lead-capture volume from the marketing site.

### C13. Add-on AI credit packs — future architectural requirement, not MVP feature (2026-05-21)

**Decision:** The commercial model must support **add-on AI credit packs** (e.g., one-time purchase of `+100 AI analyses` when a Pro user exhausts their monthly quota) **at the architecture level from day one**. Add-on credits are **not built in MVP**.

**Rationale:** Hard quota walls mid-systematic-review create churn pressure and dampen trial-to-paid conversion. Researchers expect a way to keep going when they hit a wall. Shipping Pro with a hard wall is acceptable for the first paid pilot **if and only if** the architecture lets add-on credits be added in a small fast-follow PR; shipping a Pro tier that cannot accept credit packs without a schema rewrite is a long-tail risk.

**Implementation contract:** the next schema PR (entitlement + usage) must shape `usage_credits` and the `consume_ai_quota` RPC so credits can be consumed after the monthly quota is exhausted, before the user is hard-blocked. See [commercial-architecture.md §4.5 and §5.3](commercial-architecture.md). The application code (`analyze-paper`) will not change when credit packs ship — the RPC absorbs the logic.

**Re-evaluation trigger:** closed-paid-pilot data showing meaningful churn or "I'd pay more" feedback at the Pro quota wall.

### C14. Attachments / PDF storage in MVP scope; privacy + storage-quota enforcement are launch blockers (2026-05-21)

**Decision:** Attachments / PDF storage are **in the launch feature set** (Free 500 MB, Pro 2 GB, Labs/Teams future 10 GB). However:

- **Attachment privacy hardening is a launch blocker.** The Supabase Storage `attachments` bucket currently has a public-read SELECT policy (`bucket_id = 'attachments'`, no owner check). The client uses signed URLs with a 1-hour TTL as a convention only — anyone with the underlying file URL can fetch it indefinitely. Before paid beta, the SELECT policy must be tightened to owner-only path-prefix RLS, and signed URLs become the only access path.
- **Storage quota enforcement is a launch blocker.** A `BEFORE INSERT` trigger on `paper_attachments` must enforce `storage_quota_bytes` from `user_entitlements`. `AFTER INSERT / DELETE` triggers must maintain `usage_counters.storage_used_bytes`. The client should also show storage used / quota in Settings for UX.

**Implication:** these items are added to the launch-blocker list in [commercial-architecture.md §6](commercial-architecture.md). They are also documented as web-launch-shared items in [store-launch-checklist.md §8a](store-launch-checklist.md) so the mobile build inherits them.

**Re-evaluation trigger:** if owner decides to ship without attachments after all (would simplify the launch significantly but loses an obvious differentiator vs. Zotero / Mendeley), revisit by removing attachment UI surface and the relevant blocker items.

### C15. Hebrew / RTL is out of scope for MVP (2026-05-21)

**Decision:** Hebrew / Right-to-Left UI support is **out of scope** for the MVP commercial release. The app remains English-only LTR at launch.

**Rationale:** The initial academic research market — primary target users are English-speaking researchers, students, clinicians, dietitians — is English-first. i18n + RTL framework adoption is a non-trivial cross-cutting change (every component, every form, every dialog) that is not on the path to first paid users.

**Re-evaluation trigger:** explicit owner priority change supported by Hebrew-speaking user demand signal.

### C16. Legal pages on external marketing site; repo drafts may be versioned later (2026-05-21)

> **Partly superseded — read the supersession note at the end of this entry before relying on anything below it.** The text that follows records the decision **as made on 2026-05-21** and is preserved as written; for the **Privacy Policy** it no longer describes the product. Terms of Service, AI disclosure and Support are unaffected.

**Decision:** Public-facing legal pages — **Privacy Policy**, **Terms of Service**, **AI disclosure**, **Support / contact** — live on an **external marketing site** (Webflow, Framer, or another dedicated marketing-site platform; owner choice). The app links to HTTPS URLs hosted on that site; it does not serve legal text from the repo.

**Rationale:** Legal pages are owned by the marketing surface, not the application repo. They are subject to copy / SEO / design iteration on the marketing team's cadence and benefit from a CMS workflow. The app's responsibility is to link out to authoritative URLs and to surface the AI-disclosure line at the relevant in-app action.

**Implication:** repo-tracked drafts of legal text may be created later for versioning convenience, but the **authoritative published copies are on the external site**, and the in-app links resolve to that site. No legal text in this repo should be treated as final or legally reviewed.

**Hard constraint:** the in-app surface (Settings → Privacy / Terms / Support / AI disclosure links + the at-Analyze AI disclosure) is a **launch blocker** for the web paid beta. The external URLs must exist and be linked before charging users.

**Re-evaluation trigger:** owner decision to host legal pages in-repo as Markdown (would require routing + privacy-page React component); not currently planned.

**Superseded in part (2026-08-29, PAPERLUME-PRIVACY-001B).** The trigger above fired for the **Privacy Policy** only. The owner approved publication copy and decided to serve it from the application rather than the unbuilt marketing site: the public, unauthenticated route `/privacy` renders it, canonical `https://app.paperlume.app/privacy`, and that page is the authoritative published copy. **Terms of Service, AI disclosure and Support are unchanged by this** — C16 still governs them, and they remain launch blockers with no publication target.

**Where the in-app Privacy link lives (2026-08-29, PAPERLUME-PRIVACY-001C).** The hard constraint above names "Settings → Privacy" as the in-app surface. For the **Privacy Policy** that placement is superseded: the authenticated entry point is the **Account menu** (the email dropdown in the sidebar), not Settings, and the signed-out entry point on `/auth` remains. Settings was reduced to actual application configuration — PubMed API key and storage usage — with account export and account deletion moved to a dedicated Account dialog opened from the same menu. This changes only *where* the link is, not the C16 requirement itself, and **Terms, Support and the at-Analyze AI disclosure remain unimplemented launch blockers**.

### C17. Merchant of Record (MoR)-first replaces Stripe-first for web billing (2026-05-21)

**Decision:** **Supersedes C8.** The web MVP billing provider is **a Merchant of Record (MoR) service**, not Stripe directly. Final MoR provider selection (Paddle vs Lemon Squeezy is the current candidate set) is **pending a short provider-selection audit**. The internal entitlement model, the `subscriptions` / `subscription_events` ingestion shape, and the AI-quota / storage-quota server-side enforcement landed in PRs #143 / #144 are **all unchanged** — those were always designed to be provider-neutral (see C4).

**Rationale:**

1. **Stripe direct registration is not officially available for Israel-based businesses.** Forming a US LLC via Stripe Atlas (or equivalent) just to use Stripe is excessive operational overhead for an independent operator validating a paid SaaS MVP — annual filings, CPA fees, US-entity accounting, and tax-treaty work that the project does not need until product-market fit is real.
2. **MoR providers reduce MVP operational burden** by acting as the seller of record for payment collection, invoicing, and international tax / VAT / sales-tax remittance (subject to provider terms; this is not a claim that MoRs remove all tax / legal obligations from the owner). For an independent operator pre-PMF, that trade — higher per-transaction fee in exchange for lower compliance overhead — is the right one for MVP.
3. **Provider-neutral internal architecture survives the pivot.** C4 (separate billing-provider state from app entitlements), C7 (web-first), C9 (no time-based trial), C10 (no Core tier), C11 (Free / Pro baselines), C12 (Labs / Teams roadmap), C13 (add-on credits future), C14 (storage privacy + quota), C15 (no RTL), and C16 (legal on marketing site) all remain in force. Only the **identity of the web billing provider** changes.

**Candidate providers (selection pending):**

- **Paddle** — established MoR, broad geography, programmatic API, webhook ingestion model.
- **Lemon Squeezy** — newer MoR, developer-focused tooling, simpler onboarding.
- **Stripe** — retained as a future option only if owner constraints change (e.g., owner later forms a US/UK/EU entity directly). Not the MVP path.

The selection between Paddle and Lemon Squeezy is the topic of a separate small audit task that must run **before** any provider integration PR. That audit should consider: account approval / onboarding requirements for an Israel-based operator; product / price / variant configuration model; webhook event surface and signature verification; customer portal capabilities; sandbox / test-mode flow; payout / fee schedule against the $15 / month Pro baseline; refund / dispute handling; tax / invoicing behavior; geographic coverage relevant to the target market.

**What does NOT change:**

- **Free / Pro / Labs-Teams MVP baselines** in [quotas-and-pricing.md](quotas-and-pricing.md) §2 — unchanged. Pro stays at the $15 / month baseline. The final MoR provider's fee schedule may affect margin review post-pilot but does not move the MVP baseline before real beta data justifies a change.
- **Internal enforcement model** — `user_entitlements` is the application read model; `subscriptions` holds normalized provider state; `subscription_events` is the idempotent event log; `consume_ai_quota` / `refund_ai_quota` enforce AI server-side; the BEFORE INSERT trigger on `paper_attachments` enforces storage server-side. **None of this changes.**
- **No live-provider call on quota paths.** The application never calls the billing provider during a render / quota check.
- **The launch-blocker list** in [commercial-architecture.md §6](commercial-architecture.md) — minus the now-already-completed AI quota enforcement (PR #143) and storage privacy + quota (PR #144). MoR integration replaces "Stripe Checkout + webhook ingestion" as the remaining gating implementation item.
- **Privacy / Terms / Support / Account-deletion / AI-disclosure** launch requirements (C14, C16) — still required before live paid launch. MoR adoption does **not** remove these requirements.

**Implementation note (reaffirms C4):** the application code does not branch on Paddle vs Lemon Squeezy vs Stripe. Provider-specific Edge Functions (a `mor-webhook` / `paddle-webhook` / `lemon-squeezy-webhook` once selected; a `create-payment-session` / `create-checkout-session`; a `create-customer-portal-session`) ingest provider events into the same internal `subscriptions` / `user_entitlements` rows. Future Apple IAP / Google Play work for mobile remains purely additive under the same model.

**Hard constraint:** future implementation PRs **must not hard-code Paddle or Lemon Squeezy as the chosen provider** in architecture docs or in code until the provider-selection audit is complete and a dated owner decision (C18 or later) records the choice. References to the provider should remain MoR-neutral (or use the placeholder `MOR_PROVIDER`) until then.

**Re-evaluation trigger:** owner constraints change (formation of a US / UK / EU entity that opens direct Stripe support without the LLC overhead) — would re-open Stripe as a candidate. Major MoR-provider policy / fee change post-launch — would trigger a provider-switch evaluation (supported by C4's provider-neutral model with non-trivial customer / subscription remapping cost).

### C18. Paddle selected as the MoR provider for the web MVP (2026-05-21)

**Decision:** Under the parent C17 (MoR-first) decision, **Paddle** is selected as the Merchant of Record provider for the web MVP. **Lemon Squeezy** is retained as a fallback only — to be reconsidered if Paddle rejects the Israeli operator during KYB, materially changes its pricing or policy posture before launch, or proves insufficient during the implementation spike. **C18 does not change C17.** The MoR-first architecture remains the parent decision; C18 records the provider choice under it.

**Rationale (summary; full audit attached in the PR #146 migration-history entry):**

1. **C17 alignment.** C17 exists because Stripe does not officially support direct registration for Israel-based businesses. Paddle is an independent MoR with Israel on its supported seller-country list. Lemon Squeezy was acquired by Stripe in July 2024 and is migrating to "Stripe Managed Payments" (public preview Feb 2026); choosing Lemon Squeezy today would route the project's billing onto Stripe's underlying country-support model — recreating the constraint C17 was created to avoid.
2. **Israel onboarding fit.** Paddle's stated policy is "software businesses anywhere in the world except the unsupported countries listed below"; Israel is not on the unsupported list and is listed in the Asia section of the supported-countries reference. KYB / domain verification / identity verification still apply (standard for all sellers, regardless of country) — that is an owner-side action, not a code blocker. **Paddle approval for the Israeli operator is not guaranteed by this decision**; if it fails, Lemon Squeezy is the documented fallback.
3. **Provider stability.** Paddle is an independent MoR with broad SaaS adoption and no announced platform-transition. Lemon Squeezy is mid-acquisition into Stripe Managed Payments — picking it would bind the project to a transitional platform.
4. **Engineering / Deno-Supabase fit.** Paddle has a dedicated public Deno library (`atomica-software/deno_paddle_verify`) for webhook signature verification and a public Supabase-Edge-Function integration tutorial. The internal `subscriptions` / `subscription_events` schema (PR #142) is provider-neutral and supports Paddle without structural changes.
5. **Pricing fit at the $15 / month baseline.** Paddle's all-in 5% + $0.50 per transaction is structurally simpler than Lemon Squeezy's base + 0.5% subscription + 1.5% international + 1.5% PayPal surcharge stack. Pro Net per $15 is approximately equal-or-better at every realistic scenario. **Paddle reduces payment / tax operational burden subject to Paddle's terms — it does not remove all tax / legal obligations.**

**Constraints (preserved from C17; restated for clarity):**

- **Paddle implementation is blocked** until owner-side Paddle setup is complete (see "Owner action items" in the PR #146 migration-history entry and `docs/owner-decisions.md §2.1`).
- **MVP tier baselines are unchanged** by this decision. Free remains 1,500 papers / 500 MB / 15 lifetime AI calls. Pro / Researcher remains $15 / month / 10,000 papers / 2 GB / 350 AI / month. Labs / Teams remains "Coming Soon / Contact Sales" only with the $99–$149 / month future baseline range. (See `quotas-and-pricing.md §2`.)
- **Internal commercial architecture is provider-neutral** and stays provider-neutral. `subscriptions.provider` will record `'paddle'` rows in MVP; the column type and the existing enum-extension pattern accommodate `apple` / `google` / `revenuecat` / future MoR providers without rework. `user_entitlements` is the application enforcement / read model; `subscriptions` holds normalized provider state; `subscription_events` is the idempotent webhook audit log. **The application does NOT call Paddle live during normal quota checks.**
- **Server-side AI quota and storage quota enforcement (PRs #143 / #144) are unchanged.** Paddle webhooks update `subscriptions` and `subscription_events`; the recompute helper writes the snapshot to `user_entitlements`; the existing `consume_ai_quota` / `refund_ai_quota` RPCs and the `paper_attachments` BEFORE INSERT / AFTER DELETE triggers continue to read from `user_entitlements` / `user_storage_usage` exactly as today.
- **Launch blockers other than billing-provider integration remain in force.** Privacy policy, Terms of Service, support channel, account-deletion path, AI disclosure (per C14 / C16) are still required before the closed paid pilot. Paddle adoption does **not** remove these requirements.

**Re-evaluation triggers:**

- **Paddle rejects or materially delays the Israeli operator during KYB / business verification / domain review.** Triggers a re-open between Paddle alternatives and the Lemon Squeezy fallback.
- **Paddle materially changes its pricing structure or policy** in a way that moves the MVP margin model. Triggers a fee / margin re-evaluation, possibly a provider switch (which the C4 provider-neutral architecture supports as additive Edge Function work plus customer-mapping migration).
- **Paddle's checkout, customer portal, or webhook capability proves insufficient** during the implementation spike — e.g., a webhook event we depend on changes shape, or the customer portal lacks a required capability. Triggers a deeper integration spike or a provider switch.
- **A future mobile / app-store strategy requires a different or additional provider.** Treated as additive under C4 — Apple IAP / Google Play Billing / RevenueCat remain reserved provider values.

**Lemon Squeezy stays documented as a fallback only.** This decision does not deprecate Lemon Squeezy as a future possibility; it deselects it for MVP because the Stripe-Managed-Payments transition reintroduces the strategic uncertainty C17 exists to avoid. If a future business reason justifies revisiting (e.g., Stripe Managed Payments definitively opens Israel-based merchant onboarding), C18 itself can be revisited under the C4 provider-neutral architecture without a schema migration.

### C19. Paperlume working commercial brand and `paperlume.app` domain secured (2026-05-21)

**Decision:** **Paperlume** is selected as the current working commercial brand for the project, and **`paperlume.app`** is the primary working domain (secured via **Cloudflare Registrar**, which is also the DNS control plane). This decision records the brand and the domain; it does **not** rename the codebase, the running app, the Supabase project, the Edge Functions, the database tables, or any environment variable. It also does **not** confer trademark rights or constitute legal clearance.

**Rationale:**

1. **Knockout checks were clean.** The owner's initial knockout checks against the Israeli trademark database, Apple App Store, Google Play, and a basic web/social sweep found no identical or close conflicts on `Paperlume` / `Paper Lume` / `Paper-lume` / `Paperlum` / `Paperloom` / `Paperlumi`. Many marks exist on the bare word `Lume` in Class 9 / 42, but none of the close-variant searches surfaced a direct `Paperlume`-style conflict. A small art / drawing-focused YouTube channel named "Paperlume" was found and assessed as unrelated to the SaaS / research category this product targets. **This is not a substitute for legal trademark clearance** — it is a low-cost validation step.
2. **`paperlume.app` was available at low cost** via Cloudflare Registrar. `paperlume.com` is registered but appears inactive; the `.app` TLD is appropriate for a web / SaaS product. Cloudflare Registrar charges at-cost (no markup) and includes free WHOIS privacy by default.
3. **Domain ownership enables the rest of the commercial setup.** It is a prerequisite for Paddle KYB / domain verification (C18), Google Workspace business email, Resend transactional-email sending subdomain, Supabase Auth Custom SMTP, the marketing-site landing pages that C14 / C16 require, and any future B2B outreach.
4. **`.app` requires HTTPS.** This is appropriate for a SaaS / web application and aligns with the existing Vercel hosting model where HTTPS is the default.
5. **Trademark registration was explored and deferred** because the Israeli filing fee was approximately 1,900 ILS for Class 42 alone, and the appropriate timing is closer to paid launch / B2B outreach, not pre-PMF. **Paperlume is therefore a working commercial brand, not a registered trademark.**

**Scope of this decision:**

- Brand name in use: **Paperlume**.
- Primary working domain: **`paperlume.app`**.
- Registrar / DNS control plane: **Cloudflare**.
- The decision covers the brand identity, the domain, and the high-level future architecture for hosting / email / billing on that domain.

**Constraints (read carefully — these matter for downstream PRs):**

- **Not a registered trademark.** Paperlume is a working commercial brand, not a legally cleared or registered mark. Do not use `®` anywhere in the product or marketing. If `™` is used at all, only as optional future marketing usage after explicit owner approval; not in this PR.
- **No legal clearance has been performed.** The knockout checks above are not a professional trademark search. Before paid public launch, heavier marketing spend, B2B outreach, or international expansion, the owner should commission a professional trademark search via legal counsel.
- **No rename in this PR.** Repository name, npm package name, app routes, UI labels, README headings, Supabase project name, Edge Function names, database table names, environment variables, and Vercel project name **all remain unchanged**. A future rebrand PR (or a sequence of small PRs) will move user-visible surfaces to "Paperlume" once the brand is ready to commit to publicly.
- **No DNS records were created or modified in this PR.** Cloudflare DNS for `paperlume.app` remains in its post-purchase default state (Cloudflare nameservers active; no application records configured beyond what Cloudflare creates automatically).
- **No provider setup was performed in this PR.** Vercel is not connected to the domain; Google Workspace is not configured; Resend is not configured; Supabase Auth Custom SMTP is not configured; Paddle is not configured with the domain.
- **No WHOIS / RDAP personal data is committed.** WHOIS privacy is on by default at Cloudflare Registrar; never paste registrant personal data into the repo.
- **C17 (MoR-first) and C18 (Paddle as selected MoR) remain in force.** This C19 decision is brand / domain only; it does not affect the billing-provider architecture or the provider-neutral internal model.
- **No runtime behavior changes.** AI quota enforcement (PR #143), storage privacy and quota enforcement (PR #144), and the existing app at the current Vercel URL all continue to work exactly as before.

**Re-evaluation triggers:**

- **Trademark conflict surfaces.** Owner becomes aware of a competing `Paperlume` / close-variant mark in a relevant class / geography. Triggers professional legal review, possibly a rebrand.
- **`paperlume.com` becomes available** at a reasonable price. Triggers a buy-vs-stay-on-`.app` evaluation.
- **Paddle / KYB / domain-verification issue** with `paperlume.app` specifically. Unusual, but triggers a closer look at the domain choice.
- **A clearly better brand option appears** before launch (e.g., another low-cost candidate clears legal review). Triggers re-evaluation of the brand-name decision before public launch.
- **Approaching paid public launch, significant marketing spend, or serious B2B outreach.** Triggers the deferred professional trademark search and possibly a registration filing in the relevant geographies.
- **Meaningful beta traction** (e.g., a real paid pilot cohort) generates the budget and the risk profile that justify trademark registration. Triggers the deferred filing.
- **International expansion** beyond Israel / EN-speaking academic markets. Triggers per-geography trademark review.
- **Legal counsel advises otherwise** at any point. Always overrides this decision.

**Operational-setup update (2026-05-22):** owner completed the **app-domain + transactional-auth-email half** of C19's pre-paid-beta checklist. `https://app.paperlume.app` is live on Vercel; Resend is configured on `auth.paperlume.app` with SPF / DKIM / DMARC verified; Supabase Auth Custom SMTP routes through Resend; Paperlume-branded Auth email templates are configured; multi-mailbox smoke test passed (inbox, not spam); app import smoke test passed on the new domain. **This is execution of C19, not a new decision** — no new C-numbered decision was created. **Trademark status unchanged**: Paperlume remains a working commercial brand, not a registered trademark; registration still deferred. **Still pending under C19:** Google Workspace business email, marketing site at root `paperlume.app` with legal URLs, `APP_URL` Supabase secret (set when Paddle integration ships per C18). Detailed status with completion timestamps in [`deployment.md §8a`](deployment.md).

## Schema reconciliation decisions (2026-07-18)

**Context for all of C20–C25:** the 2026-07-18 read-only audit ([schema-reconciliation.md](schema-reconciliation.md)) proved that production predates the first tracked migration: the migration ledger matches 60/60, but a clean local replay produces a schema that materially differs from production (junction shapes, `statistical_methods` type, legacy columns, nullability, defaults). RLS policies, security RPCs, and all commercial tables were confirmed in parity. The decisions below fix the canonical end state; the ordered implementation plan lives in [schema-reconciliation.md](schema-reconciliation.md).

### C20. `papers.statistical_methods` is canonically `jsonb` holding a JSON string (or SQL NULL)

**Decision:** keep the production `jsonb` type; the stored-value invariant is SQL `NULL` or a JSON string of the display text. Transitional JSON `null`s → SQL `NULL`; JSON arrays → comma-joined strings; then a CHECK constraint locks the invariant. Domain type stays `string | null`.

**Alternatives rejected:** converting the column back to `text` (fights production and requires a riskier in-place type rewrite of live data); declaring arrays canonical (would require changing the analyze-flow writer and every reader for zero product benefit — the UI renders comma-joined text).

**Rationale:** production already stores `jsonb`; the UI already reads defensively; strings are what the application writes today. Normalize the minority representations rather than the majority.

**Consequence:** `RECON-STATISTICAL-METHODS-001` (type reconciliation + data normalization + constraint + boundary mapping/tests).

**Re-evaluation trigger:** the product adopts *structured* statistical-method objects (per-method metadata, filtering by method) rather than display text — that would justify an array-of-objects schema and a real migration of the display pipeline.

### C21. Dead legacy columns are dropped

**Decision:** drop `papers.urls`, `synonym_pool.primary_term`, `synonym_pool.variants` after re-verifying emptiness at deploy time.

**Alternatives rejected:** retaining them as a future contract (nothing reads or writes them; they exist only as pre-migration residue and keep every schema diff noisy).

**Rationale:** audit evidence — all values empty/NULL across all rows; zero references in application code, RPCs, policies, migrations, or Edge Functions.

**Consequence:** `RECON-LEGACY-COLUMNS-001`.

**Re-evaluation trigger:** a future feature genuinely needs a multi-URL field on papers or a synonym-variant model — re-add deliberately with real semantics rather than resurrecting the dead columns.

### C22. Junction tables use composite primary keys

**Decision:** `paper_tags (paper_id, tag_id)` and `paper_projects (paper_id, project_id)` are the primary keys; no surrogate UUID `id`, no unused `created_at`; reverse-lookup indexes retained/added where justified; the four atomic assignment RPCs and RLS-through-parent ownership preserved.

**Alternatives rejected:** migrating production to the surrogate-ID shape the migrations currently declare (rewrites hundreds of live junction rows to add columns no consumer uses).

**Rationale:** production already has composite PKs; every consumer uses only the pair columns; pairs uniquely identify rows by construction.

**Consequence:** `RECON-JUNCTIONS-001` — the first reconciliation PR (also aligns domain types that currently declare runtime-absent fields).

**Re-evaluation trigger:** a junction gains independent business metadata (e.g., per-assignment notes, ordering, timestamps with product meaning) — that is the point to introduce a richer entity, not before.

### C23. Ownership and pool integrity constraints are enforced

**Decision:** NOT NULL on `user_id` across the eight drifted owner-scoped tables, plus `synonym_pool.canonical_term`/`synonyms` and `study_type_pool.hierarchy_rank`/`specificity_weight`, guarded by migration-time zero-null preflight that fails safely.

**Alternatives rejected:** leaving columns nullable because current data happens to be clean (leaves the RLS-invisible null-owner row class open forever).

**Rationale:** every RLS policy and S1/S2 pattern assumes an owner; audit found zero NULLs, so tightening is backfill-free today and only gets harder later.

**Consequence:** `RECON-INTEGRITY-001`.

**Re-evaluation trigger:** system-owned or shared rows are introduced (e.g., global default pools, team libraries) — ownership modeling then changes deliberately, with its own RLS design.

**Addendum (2026-07-19) — `synonym_pool.synonyms` default alignment.** The `RECON-INTEGRITY-001` read-only preflight discovered that production `synonym_pool.synonyms` is `text[]` with **no default**, while the migration-defined schema has carried `DEFAULT '{}'::text[]` since `20260203133100` — a metadata difference the original audit's drift inventory did not record. The owner resolved the resulting blocker by amending C23: `RECON-INTEGRITY-001` also sets exactly this one default (a no-data metadata convergence; no stored value changes) alongside its NOT NULL enforcement. **Deferral to `RECON-METADATA-PARITY-001` was rejected** because enforcing NOT NULL without the default would make local and production behave differently for INSERTs omitting `synonyms` (local fills `{}`, production raises `not_null_violation`) and would leave a type-affecting Insert-optionality difference in place under C25 — exactly the divergence class the reconciliation exists to close. No other default enters C23 scope. Re-evaluation trigger: none — the amendment expires naturally once the migration is applied remotely and verified.

### C24. Every reconciliation migration is applied remotely

**Decision:** each new migration is applied to a clean local replay *and* to the linked project via the deployment runbook, even when it is structurally a no-op against production.

**Alternatives rejected:** treating "production already looks like this" as a reason to skip remote application (silently breaks ledger parity, the exact failure mode this effort exists to eliminate).

**Rationale:** reconciliation's definition of done is schema parity *plus* ledger parity; an unapplied merged migration destroys the latter immediately.

**Consequence:** a mandatory step in every RECON-* PR checklist.

**Re-evaluation trigger:** a staging environment or branch-database workflow changes the migration deployment model — the rule then adapts to the new pipeline, not away from parity.

### C25. Schema → types → TypeScript → CI ordering

**Decision:** generated Supabase types are regenerated and committed only after every type-affecting schema difference is reconciled and exact local-vs-linked parity is verified; then the TypeScript baseline is repaired and a truthful `npm run typecheck` added; only then the `Validate` CI workflow and branch protection.

**Alternatives rejected:** regenerating types from either side now (encodes a falsehood about one environment); building CI around the empty root `tsc --noEmit` (a gate that can never fail is worse than no gate).

**Rationale:** each later stage consumes the previous stage's guarantee; committing types early would need a second regeneration churn after every RECON PR.

**Consequence:** ~~`TYPESCRIPT-BASELINE-001` and `CI-BASELINE-001` stay paused until `RECON-METADATA-PARITY-001` verifies parity.~~ **Fulfilled (2026-07-20/21):** `RECON-METADATA-PARITY-001` is applied remotely and parity is verified; `TYPESCRIPT-BASELINE-001` regenerated the authoritative types (local/linked semantically identical) and restored `npm run typecheck` to 0 diagnostics; and `CI-BASELINE-001` added the required `Validate` GitHub Actions workflow (lint, typecheck, Vitest, production build on Node 22) with `main` branch protection requiring the `validate` check. The full schema → types → TypeScript → CI → branch-protection sequence is now fulfilled; no stage remains paused.

**Re-evaluation trigger:** none expected — this sequencing rule has expired now that reconciliation, the TypeScript baseline, and the CI / branch-protection stage are all complete.

### C26. Remaining metadata and index parity (final reconciliation step)

**Decision:** `RECON-METADATA-PARITY-001` converges both a clean local replay (S1) and current production (S2) to one canonical metadata end state: drop `projects.updated_at` (+ its `update_projects_updated_at` trigger); keep exactly one `papers` updated-at trigger (`trg_papers_updated_at` / `set_updated_at()`) and drop the duplicate `update_papers_updated_at`; set the eight drifted `created_at` defaults to `now()`; enforce `study_type_pool.created_at` NOT NULL (zero-NULL preflight, rechecked under lock, no backfill); set `tags.color` default to `'#e2e8f0'`; and drop seven redundant single-column indexes superseded by production's covering composite/unique indexes. `papers.search_vector` (semantically-equivalent generation expression, corpus-proven) and the SEC-4 default-grant diff (effective privileges consistent with the RLS-forced model) are **approved benign/artifact exclusions — deliberately not changed.**

**Alternatives rejected:** dropping/recreating the `search_vector` generated column for textual identity (needless table rewrite for a proven-equal expression); applying the shadow-database default grants (would widen `anon`/`authenticated` table access to silence a diff-tool artifact); keeping `projects.updated_at` or the duplicate trigger (perpetuates drift with no consumer); canonicalizing `created_at` to `timezone('utc', now())` (adds an unnecessary `timestamp`-without-tz round-trip vs. `now()`).

**Rationale:** these are the last differences between the migration-defined schema and production; resolving them makes generated types authoritative (unblocking C25) while production is mutated only for the `created_at` defaults — a metadata change that alters no stored row. Production is the reference for every other item.

**Consequence:** ~~the migration is local-only until applied remotely under C24; only then do the C25 type-baseline steps begin.~~ **Fulfilled (2026-07-20):** the migration (`20260719162013`) is merged (PR #156, merge `4f26c85d`) and applied remotely as an S2 convergence (the eight `created_at` defaults → `now()`); the 65-row ledger is aligned and the C25 type-baseline steps have begun and completed.

**Re-evaluation trigger:** none — a one-time convergence that has now been applied remotely and verified. An index later proven to serve a real query path is added by a separate performance migration, not by reopening C26.

> **`search_vector` — superseded prospectively by C54 (2026-09-27), not reversed.** C26's finding that the wrapper and direct expressions store identical values, and its decision not to rewrite Production, both still hold. C54 ends the retained dual representation from here on: every replay converges on the direct built-in form Production already stored (`8ddd960b…`), and Production took the migration's no-op branch when C54 was applied on 2026-09-27, so its column was not rewritten. The later explanation that Production's form had been "inlined" by PostgreSQL was wrong — different migration SQL text was executed (see C54).

## Product-direction reset (2026-07-24)

### C27. Public-launch and commercial-launch implementation are paused; feature development is the active priority (2026-07-24)

**Decision:** by owner decision, public-launch and commercial-launch **implementation** work is **paused** and is **not on the active critical path**. The active engineering priority returns to **product feature and workflow development** — building new features, completing incomplete user workflows, improving existing functionality and usability, and maintaining the existing technical quality gates (required CI + branch protection). This is a **priority reset, not a reversal** of any prior technical or commercial decision.

**What is paused** (must not be started as the immediate next engineering task without a new explicit owner decision): Paddle checkout implementation, billing integration, subscription-activation workflows, payment webhooks, production pricing enforcement, paywalls, upgrade/downgrade flows, public-signup launch work, public commercial rollout, store-launch work, launch campaigns, public marketing readiness, and legal-launch execution that exists solely to unblock public release.

**What remains valid** (unchanged, future-facing): C17 (MoR-first) and C18 (Paddle selected) remain the approved future billing direction; the Free/Pro plan concepts (C9–C11) remain valid future concepts; the already-implemented entitlement, quota, subscription, usage and storage infrastructure remains part of the architecture and **must not be deleted**; the commercial tables and their security controls remain intentionally preserved; and owner-side account/sandbox setup may still be performed later but is no longer part of the active critical path.

**Alternatives rejected:** cancelling commercialization outright (rejected — this is a re-prioritization, and the built commercial architecture stays); reopening the C17/C18 provider decisions (rejected — no contradiction requires it).

**Consequence:** the active next sequence is (1) record this reset, (2) perform a focused product-feature and incomplete-workflow audit, (3) produce a prioritized feature backlog, (4) select one bounded feature, (5) implement it through the normal PR + required CI process. Owner-side Paddle Sandbox setup is no longer described anywhere as the immediate active next task. No commercial-implementation task begins without a new explicit owner instruction.

**Re-evaluation trigger:** resume launch planning only after the owner explicitly decides the product is ready to return to commercialization or public-release work.

## Internal access and provider observability (2026-07-25)

### C28. Internal Owner/Manager roles are separate from commercial plans; owner gets Pro capability + AI exemption; managers may view shared Gemini provider quota (2026-07-25)

**Decision:** Introduce an **internal system role** concept that is **independent of the commercial plan** (`free`/`pro`/future `labs_team`):

- Internal roles are **`owner`** and **`manager`**, with an implicit ordinary **`user`** for everyone else. They live in a dedicated server-only table `public.internal_user_access` (owner-authored deployment grant), **not** in `user_entitlements` and **not** as a `labs_team` plan value. The owner is **not** modeled as a Paddle subscriber — no billing-provider row, fake subscription, or billing identifier is created for the owner.
- The **owner** account receives the effective **`pro`** commercial capability set (plan `pro`, status `active`, current Pro paper limit + storage quota, `premium_taxonomy_enabled = true`, `labs_team_enabled = false`) **plus an explicit Paperlume AI-quota exemption** (`ai_quota_exempt = true`). The owner is never blocked when ordinary Free/Pro quotas are exhausted; successful owner analyses are still counted for operational usage, and a failed provider call still refunds that recorded use.
- **Managers and owners** may view a **manager-only Google Gemini provider-quota dashboard** — the shared, Google-Cloud-project-level provider quota, presented separately from each user's per-user Paperlume allowance and never combined into one number.
- **A manager is not automatically quota-exempt.** Exemption is an explicit per-user field/grant (`ai_quota_exempt`), independent of role.
- **Runtime authorization is UUID/role-based, never email-based.** The target owner email (`maor29994ps5@gmail.com`) is used **only** by the later, separately-authorized deployment-time bootstrap to resolve the user UUID; it is **not** hard-coded in React, Edge Functions, RLS, RPC authorization, application config, role checks, or runtime tests. Access decisions depend on `auth.uid()` and the server-controlled role record. Enforcement stays server-side: the `get-gemini-provider-quota` Edge Function re-checks the role via `get_current_user_access()` and never trusts a client role claim.

**Rationale:** The product owner's own account must not behave like an ordinary Free user with 15 lifetime analyses, and internal operators need visibility into the shared Gemini project quota (a different resource from any single user's Paperlume allowance). Modeling the owner as a commercial subscriber would pollute billing/entitlement semantics and imply a Paddle relationship that does not exist; a separate internal-role concept keeps commercial state honest (C27 unchanged) while granting operational capability. Email-based checks are brittle and unsafe as a runtime authority, so role resolution is bound to the authenticated UUID.

**Alternatives rejected:** using `labs_team` (a future commercial B2B tier) as an owner/admin role (conflates commercial and operational concepts); adding an `is_admin` column to `profiles` or a fake `pro` subscription row for the owner (mixes operational state into commercial/billing tables); email-string role checks in code/policies (brittle, unsafe, environment-leaking); a single combined "remaining" number blending the per-user allowance with the shared provider quota (misleading — they are different resources).

**Consequence:** `OWNER-MANAGER-ACCESS-AND-GEMINI-QUOTA-001` — one additive migration (`20260725090000`: `internal_user_access` + `get_current_user_access` + AI-quota-exemption changes to `consume_ai_quota`/`refund_ai_quota`/`get_ai_quota_status` incl. additive `is_exempt`), a manager-only `get-gemini-provider-quota` Edge Function reading Google Cloud Monitoring, centralized Gemini model config + structured provider-error classification in `analyze-paper`, and the React access/provider-quota surfaces. The implementation PR performs **no** remote migration, owner grant, secret configuration, Edge deploy, or Google setup — those are later, separately-authorized deployment steps (see [deployment.md](deployment.md)). This is an S1-compliant, RLS-forced, server-authoritative feature; it does **not** weaken `usage_counters` privacy, add client writes to internal tables, alter Free/Pro quota values, or introduce billing/paywall/Labs work.

**Re-evaluation trigger:** the internal-access model needs to grow beyond `owner`/`manager` (e.g., scoped operator roles, an audit log of internal actions, or self-serve team roles) — extend `internal_user_access` deliberately with its own RLS/authorization design rather than overloading the commercial plan; or Google changes its Monitoring quota metric families, which would revise the provider-quota normalization.

### C29. Preserve Gemini Free Tier during development and defer automatic provider-quota monitoring until commercialization (2026-07-26)

**Decision:** During development Paperlume remains on the **Gemini Free Tier** and **Google Cloud billing stays disabled**. The **manager-facing automatic Gemini provider-quota dashboard is deferred** until commercialization resumes. This decision **supersedes only the active provider-dashboard portion of C28** (the third bullet — the manager-only provider-quota dashboard surface); every other part of C28 remains in force. C28 is **not** rewritten as though it never existed — its history stands.

- **Gemini Free Tier is the development provider tier.** Paperlume continues to use the existing `GEMINI_API_KEY` Free Tier key for paper analysis; no Google Cloud billing account may be linked to the Gemini project during development.
- **Google's external Free Tier limits are the real provider limit.** Paperlume's internal owner AI-quota exemption (C28) does **not** override Google's external Free Tier quota. When Google's Free Tier quota is exhausted, provider failures continue to fail safely through the existing provider-error classification and neutral client behavior (analysis is not silently corrupted; usage refunds still apply where applicable).
- **Automatic provider-quota monitoring is deferred, not deleted.** The deployed `get-gemini-provider-quota` Edge Function (v3) and its shared backend modules are **retained as deferred infrastructure**. No frontend surface renders a provider-quota card, invokes the function, or initiates a hidden provider-quota query. No permanently-failing / "temporarily unavailable" card, paid-tier upsell, static fake quota number, or operator-editable estimate is substituted.
- **Manual monitoring during development.** Gemini usage and current rate limits are checked **manually through Google AI Studio** during development; automatic Cloud-Monitoring-based quota is not presented as an active product capability.
- **Owner exemption and role model preserved.** The owner Paperlume AI-quota exemption (C28) remains active; the internal `owner`/`manager` role model, the server-only `internal_user_access` table, `get_current_user_access()`, RLS/grant hardening, and the completed owner bootstrap are unchanged. The `can_view_provider_quota` capability field is retained as part of the approved server role contract and the deferred backend authorization design.

**Rationale:** The read-only Google-side investigation (`OWNER-MANAGER-ACCESS-AND-GEMINI-QUOTA-001S`…`001X`) established that the deployed function's Cloud Monitoring call returns HTTP 403 and that **project billing is disabled** (no billing account linked; no project-level IAM deny policy; no parent org/folder). Under C27 the product is deliberately paused before commercialization, so the correct response is **not** to enable billing or invest further in the free-tier Monitoring path, but to keep the cheap, working Free Tier and remove the inactive dashboard surface while preserving the backend for a future, deliberately-revalidated reactivation.

**Alternatives rejected:** enabling Google Cloud billing to make the Monitoring call succeed (rejected — contradicts C27's pause and adds spend before commercialization); deleting the deployed Edge Function source from version control (rejected — would leave Production running code absent from the repo); shipping a permanently-failing or "temporarily unavailable" provider-quota card (rejected — presents a broken capability as a product surface); adding a static/manual quota number or upsell (rejected — misleading, and billing/paywall work is paused).

**Consequence:** `OWNER-MANAGER-ACCESS-AND-GEMINI-QUOTA-001Y` — a **repository-only** change: remove the frontend provider-quota card, its fetch hook, its client parsing/display library, their frontend-only tests, and the now-orphaned `geminiProviderQuota` query key; retain the Edge Function, shared backend monitoring modules, `supabase/config.toml` function config, and the `useCurrentUserAccess` role model (with a deferral guard test). **No** remote migration, secret, Edge deploy, invocation, Google/billing/IAM, Vercel, or merge mutation occurs. Documentation is normalized to describe the true current Production state and to classify the provider-quota dashboard as deferred infrastructure.

**Re-evaluation trigger:** an explicit owner decision to **resume commercialization**. Only then reconsider: linking a billing account, moving the Gemini project to a paid tier, estimating Gemini unit costs, setting spend controls, supporting paid-tier provider metrics, and reactivating the manager-facing dashboard. The existing free-tier Monitoring metric families and normalization **must be revalidated before reactivation** — do not assume they remain appropriate for a future paid-tier implementation.

## Supabase Auth security-plan decision (2026-08-10)

### C30. Stay on Supabase Free during development; defer leaked-password protection until commercialization (2026-08-10)

**Decision:** Keep the Supabase organization on the **Free** plan during development and **do not upgrade solely to enable leaked-password protection**. Supabase Auth leaked-password protection remains disabled while the project is on Free and is explicitly deferred until Paperlume is preparing to go commercial. Revisit earlier only if the organization moves to Pro for another reason or Supabase changes feature availability.

**Rationale:** Current Supabase documentation makes leaked-password protection available on the **Pro Plan and above**, and read-only inspection on 2026-08-10 confirmed the organization is on **Free**. The owner does not want to incur the plan cost during the current development phase solely for this one Auth control. Commercialization is already paused under C27, so the appropriate current posture is to accept the control as deferred rather than to introduce recurring spend before the product is ready for commercial launch.

**Consequence:** No Supabase plan, billing, or Auth setting changes are authorized during development by this decision. PFA-C08's database hardening was a separate track and is now **complete**: migration `20260810152125_harden_remaining_function_search_paths` was merged (PR #200, merge `7c61ba39…`) and **deployed to Production on 2026-08-10 under separate authorization** (`PFA-C08-SECURITY-HARDENING-001P`), taking the ledger from 72 to **73** rows; post-deploy verification confirmed the four `function_search_path_mutable` warnings cleared, with `proconfig` the only changed catalog field and `papers.search_vector`, the `papers` indexes, and the `set_updated_at` trigger all unchanged — see [migration-history.md](migration-history.md). **PFA-C08 is therefore closed for the current development scope.** (Its hardening outcome stands; its type-lookup reasoning is refined forward by **C51**.) Leaked-password protection stays **disabled** and is an explicit **commercialization prerequisite**, not an unresolved development blocker.

**Re-evaluation trigger:** before commercial/public paid launch, or earlier if the Supabase organization moves to Pro for another reason or Supabase makes leaked-password protection available on the current plan. At re-evaluation, confirm the current Supabase documentation and project configuration rather than assuming today's plan gate still applies; if supported, enable leaked-password protection and re-run the Security Advisor to verify the finding clears.

## CI merge-gate decisions (2026-08-16)

### D5 — Required DB-security merge gate (2026-08-16)

**Status: RESOLVED 2026-08-16 → `REQUIRE_DB_TESTS`.** D5 originated in the PFA-C03 contract as the open question of whether either non-required CI lane — `E2E (local) / e2e-local` or `DB Tests / db-tests` — should become a required merge gate for `main`.

**Decision (owner, 2026-08-16):**

- keep **`validate`** required;
- add **`db-tests`** as required;
- keep **`e2e-local`** non-required.

**Implemented state:** branch protection on `main` now requires exactly two contexts — **`validate`** (GitHub Actions app `15368`) and **`db-tests`** (GitHub Actions app `15368`). **Strict / require-branches-to-be-up-to-date remains enabled.** **`e2e-local` remains non-required**, as do the Vercel checks. No repository ruleset exists, and no other protection setting (review count, stale-review dismissal, code-owner review, last-push approval, conversation resolution, administrator enforcement, force pushes, deletions, linear history, signatures, branch lock) was changed. Required contexts are the **bare emitted job names**, not the `Workflow / job` labels shown in the GitHub UI.

**Rationale:**

- `DB Tests` covers database invariants that `Validate` structurally cannot reach — RLS isolation, table/RPC grants, `SECURITY DEFINER` caller scope, quota and true-concurrency behaviour, full migration replay, and account-deletion cascades. A green `Validate` says nothing about any of them.
- The read-only D5 audit (2026-08-16) found `DB Tests` **operationally eligible**: it emitted its check on every eligible pull-request head, passed on first attempt across the scored pull-request sample, ran well inside its declared timeout with a flat-to-tightening duration, and adds the smallest merge latency of the candidates. It also carries per-run self-validating controls (an expected-failure negative control and a catalog-fingerprint sensitivity probe), so a green result is meaningful rather than vacuous.
- `E2E (local)` was **not** promoted: its measured duration trend was materially higher and rising, its only red in the sampled window was a defect in its own spec rather than in the product, and it needed a same-SHA re-run to reach green once.
- Promotion adds **no** runner minutes — both lanes already run on every eligible pull request — so the only cost is merge-blocking latency.

**Consequence:** `D5-REQUIRED-DB-TESTS-PROMOTION-001` — one narrow `PATCH` to the `required_status_checks` sub-resource of `main`'s classic branch protection, plus documentation. No workflow, source, test, package, Supabase, or Vercel change. A failing `db-tests` now blocks merge; that is the intended behaviour and is **not** grounds for rolling the gate back. Point-in-time audit evidence, the eligibility rubric, and the rejected alternatives live in [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md) §16; the activation record is §17 of the same document.

**Re-evaluation triggers.**

*Reconsider promoting `e2e-local` when all of the following hold:*

- at least **40 further eligible pull-request runs** after the 2026-08-16 audit;
- **zero same-SHA re-runs** needed to reach green during that window;
- **zero ephemeral-stack bring-up transients** (`supabase/setup-cli` or `supabase start`) during that window;
- **p90 ≤ 7m00s** and **maximum ≤ 12m00s**;
- **no upward p90 trend** across two consecutive windows;
- **at least one legitimate unique catch** whose root cause is application or database code (candidate red while `Validate` is green), as opposed to a defect in its own spec.

*Revisit fork semantics when* outside/fork-origin contributions become part of the supported contribution model: both candidate workflows carry a same-repository job condition, so on a fork-origin pull request the job **skips and reports success**, producing a vacuous green. That must be resolved before any required check can be trusted on fork-origin contributions.

*Reconsider required `db-tests` if* recurring false-red or infrastructure failures materially disrupt merges; `DB Tests` becomes cloud- or secret-dependent; its check identity (`db-tests`, app `15368`) changes; its runtime materially expands; or its test architecture is replaced.

## Product feature architecture (2026-08-23)

### C31. PubMed Search discovers PMIDs; the existing identifier importer imports them (2026-08-23)

**Decision:** In-app PubMed discovery (`PUBMED-IN-APP-SEARCH-001`) is a **discovery** surface only. A PubMed search result is a transient display representation and is **never** a source of persisted paper metadata. The only value that crosses from discovery into persistence is the **PMID string**, handed to the pre-existing `onBulkImport` callback that the Import IDs tab already uses.

Specifically, and permanently:

- search results must not be fed to `bulkImportFromParsedData`;
- no second `safe_bulk_insert_papers` payload may be built from them;
- no second normalization, keyword enrichment, study-type evaluation, author-provenance derivation or duplicate algorithm may exist for them;
- ESummary fields must not be written to `papers`, to author-identity tables, or to any curation pool;
- a result carrying a DOI still imports by **PMID** — the discovery source is PubMed, and letting incidental metadata pick the provider would change which record is authenticated;
- a search result must not be disabled merely because its PMID appears on the currently paginated paper list: that is an incomplete duplicate check, and duplicate classification belongs to the canonical insert path.

**Rationale:** The canonical importer already owns complete PubMed metadata, structured publication types, author provenance, normalization, keyword enrichment, study-type evaluation, safe duplicate handling, chunked insertion, Project/Tag assignment, cache invalidation and import-summary semantics. A discovery summary is a deliberately thin projection — ESummary carries no abstract, no MeSH terms, no structured authorship and no reliable full author list — so persisting it would create a second, poorer source of truth whose rows would be silently inferior to identically-imported ones and would drift from the canonical path with every future change to either.

**Consequence:** PubMed Search adds a UI mode, a client wrapper and one read-only Edge Function. It adds **no** database object: no table, column, RPC, RLS policy or migration. The `e2e/pubmed-search.spec.ts` regression captures the `fetch-paper-metadata` request at the HTTP boundary and asserts its identifiers are exactly the selected PMIDs with no summary field present, so a future change that inserts ESummary objects directly fails that test rather than shipping.

**Re-evaluation trigger:** only if the canonical importer stops being able to fetch a record the search surface can find — for example if NCBI withdrew EFetch, or PubMed began returning search-only records with no retrievable full metadata. Wanting fewer network round-trips is **not** a trigger; the round-trip is what buys the authoritative record.

### C32. AI organization suggestions are advisory, spend the existing AI quota, and never mutate the library (2026-08-23)

**Decision:** AI-assisted Project/Tag organization (`AI-PROJECT-TAG-SUGGESTIONS-001`) is an **advisory** surface. The `suggest-paper-organization` Edge Function compares one paper against the caller's own taxonomy and returns suggestions. It creates nothing, assigns nothing and persists nothing; the user accepts or rejects each suggestion, and the pre-existing Project/Tag mutation paths remain the sole authority for any change to the library.

Specifically, and permanently:

- the endpoint performs **no** Project, Tag, `paper_projects`, `paper_tags` or `papers` write, and stores no suggestion history — its only writes are the existing `consume_ai_quota` / `refund_ai_quota` RPCs;
- there is **one** AI quota. The feature records under the existing `ai_analysis` usage counter rather than introducing a second quota system, a new column or a suggestion-specific allowance, so the owner/manager `ai_quota_exempt` grant (C28) keeps applying without the function knowing anything about internal roles;
- a Google rate limit, 403 or 5xx is a **provider** failure (HTTP 500, neutral wording, machine-readable class from `_shared/providerError.ts`) and never a Paperlume `402 quota_exceeded` — the same distinction `analyze-paper` draws;
- **no database identifier reaches Gemini.** Projects and Tags cross the boundary as request-local `P1`/`T1` refs, and the ref→id map exists only for the lifetime of one request. **Existing-entity suggestions resolve only through that ref map** — there is no name-based fallback and no fuzzy matching for resolving a `P#`/`T#`, so a ref the model invents resolves to nothing;
- **name comparison exists, but only to reclassify a "new" proposal — never to resolve a reference.** An exact application-normalized (`trim + lower`) comparison decides whether something the model labelled *new* already exists in the taxonomy. Promotion to an existing-entity suggestion happens **only when that comparison identifies exactly one** existing row. The application key is deliberately broader than the database's `(user_id, lower(name))` key, which does **not** trim — so `"Diabetes"` and `" Diabetes "` are two legal rows that collapse to one application key. When a proposal matches more than one row the server **never picks one**: the proposal is dropped, returned neither as an existing suggestion nor as new. No insertion order, id order, name length or other tie-break is permitted, because each would return one real UUID as though the match had been certain;
- the provider sees only paper title, abstract, keywords and study type, plus Project name/description and Tag name. User id, email, plan, quota counters, internal role, authors, affiliations, ORCID, notes, PMID, DOI, every URL, attachments and other papers are excluded by construction — `prompt.ts` builds the payload by naming allowed fields, so a new column cannot silently widen the disclosure;
- **the taxonomy comparison is complete or it does not happen.** A library larger than the supported bound fails honestly rather than sending an arbitrary subset, because a partial comparison produces confident "new Project" proposals for Projects the user already has — a wrong answer the user cannot detect;
- a title-only paper is refused before a quota unit is spent: organizing a paper from its title alone is a guess the user would be charged for.

**Acceptance semantics in the client (`001B`).** The advisory model does not survive on the server alone — a frontend that auto-applied a suggestion would make the endpoint's read-only guarantee meaningless. Durably, therefore:

- **generation is explicit.** The endpoint is called only from a user click on the Edit Paper suggestion action — never on open, on abstract load, on keystroke, on Save or on opening a selector — and one click is at most one request;
- **accepting an existing Project/Tag changes local dialog state only.** It adds an id to Edit Paper's unsaved selection; `set_paper_projects` / `set_paper_tags` are not called, and the paper row is not touched. **The existing Save Changes path stays the sole persistence point**, so closing or cancelling assigns nothing;
- **a proposed new Project/Tag requires its own explicit "Create & select" click**, and creation goes through the existing `createProject` / `createTag` mutations rather than a direct insert from the suggestion surface — those mutations remain the domain authority, including their duplicate and ownership behaviour;
- **entity creation is immediate; the paper assignment is not.** The entity exists in the library as soon as it is created, while the assignment remains staged until Save — so creating and then closing without saving leaves a new Project the user asked for and a paper that is unchanged. The UI states this rather than implying creation is deferred;
- **no suggestion is accepted automatically.** There is no bulk apply, no pre-accepted default state, and no initial selection derived from a response. Dismissal is local and never persisted — no rejected suggestion is stored or sent anywhere;
- **the client re-checks identity at action time.** An existing suggestion is actionable only while its id is still in the current taxonomy, and a proposed-new name is reconciled against the *current* taxonomy under the same `trim + lower` comparison: exactly one match selects that row instead of duplicating it, and more than one match creates nothing and selects nothing. The client applies the same no-tie-break rule as the server, for the same reason.

**Rationale:** The suggestion is a *recommendation about the user's own filing system*, and filing systems are personal. Auto-assignment would make an AI guess indistinguishable from a deliberate curation decision, and the library is the product's durable asset. Keeping the endpoint read-only also means prompt injection has no mutation authority to redirect: the worst a hostile abstract can achieve is a bad suggestion the user declines.

**Consequence:** The feature adds **no** database object — no table, column, RPC, RLS policy or migration. It shipped in two parts: `001A` is the backend contract (this Edge Function, its bounds and its tests), deployed and verified first with **no frontend caller**; `001B` adds the Edit Paper experience against that already-live contract, changing no Edge source and requiring no deployment of its own. Because the UI is useless without the endpoint, the `search-pubmed` endpoint-before-UI rule applies to any *future* contract change — see [deployment.md](deployment.md) §7c.

Because both spenders draw on the one `ai_analysis` counter, the **user-facing** name of the allowance is "AI requests" rather than "AI analyses" — a user who exhausts it on suggestions must not be told they are out of analyses. This is display copy only: `ai_analysis`, `consume_ai_quota`, `refund_ai_quota` and `get_ai_quota_status` are unchanged, and action-specific wording ("AI Analyze", "AI analysis complete") stays action-specific.

**Re-evaluation trigger:** for the quota model, only a product decision that organization suggestions should be priced separately from analysis. For the taxonomy bound, only a retrieval/embedding design that can compare a paper against a large library without sending all of it — at which point "fail honestly" is replaced by a *complete* comparison, never by silent truncation. Wanting the feature to work for an over-sized library is **not** a trigger to start truncating.

## AI model selection (2026-09-02)

### C33. User-selectable AI models are a paid/server-entitled capability; the entitlement flag — not the plan name — is the gate (2026-09-02)

**Decision:** Paperlume will let users choose which AI model it uses. The capability is available to **paid users** and to **explicitly granted owner/internal/test accounts**; ordinary Free users continue to use Paperlume's **system default** model and may not choose one.

Specifically, and durably:

- **The gate is an explicit server-controlled entitlement flag.** `public.user_entitlements.ai_model_selection_enabled` (BOOLEAN NOT NULL DEFAULT false) is the enforcement contract. A client-side `plan === 'pro'` comparison is **not** the gate and must never become one, and **no owner email is hard-coded** anywhere in code, RLS, RPC, config or tests. Existing `pro` / `labs_team` rows in `active` or `trialing` status were backfilled `true`; Free rows stay `false`. Future billing ingestion must maintain the flag as part of the internal entitlement projection.
- **Internal/manual grants flow through the same provider-agnostic entitlement.** An owner, internal or test account is enabled by one server-side write that sets the flag — no client change, no second authorization mechanism, and no coupling to the `owner`/`manager` internal role model (C28). Being internal does **not** by itself grant model selection.
- **Effective capability is entitlement AND status.** `get_current_user_access()` exposes a fail-closed `can_select_ai_model`, true only when `ai_model_selection_enabled` is true **and** `plan_status` is `active` or `trialing`. A missing entitlement is false, not unknown.
- **The model catalog is server-controlled.** `public.ai_model_catalog` is an **allowlist**, not a mirror of a provider's offerings. Authenticated users may read it (non-sensitive product metadata); no client role may insert, update or delete a row. Models are added or retired by a reviewed migration. Retirement is `enabled = false`, never `DELETE`, so saved preferences and model history survive.
- **The first selectable models are Gemini 3.5 Flash (`google/gemini-3.5-flash`) and Gemini 3.6 Flash (`google/gemini-3.6-flash`)**, and only those. Internal ids are provider-qualified so a saved choice keeps meaning the same model even if two providers ship colliding model names.
- **There is no per-model provider credential.** Both models are served by the **same existing server-side `GEMINI_API_KEY`** (the already-migrated, Production-verified Gemini Auth key). The catalog stores no API key, secret name or credential, and **provider credentials never reach the browser**.
- **No preference means the system default.** `public.user_ai_preferences` holds at most one row per user, and the **absence** of a row is the meaningful state. No existing user was backfilled, and signup creates no preference row — manufacturing one would convert "no opinion" into a choice the user never made.
- **Direct preference writes are not the authorization path.** Every write goes through `set_current_user_ai_model(p_model_id text)` or `clear_current_user_ai_model()`. Both derive the caller from `auth.uid()` and take **no user-id parameter at all**, so writing another user's preference is unexpressible rather than merely guarded. The setter re-checks entitlement, status and the catalog allowlist (`enabled` **and** `selectable`) before writing. Clearing deliberately does **not** require the entitlement, so a downgraded user can still drop a stale preference.
- **A saved preference survives downgrade, dormant.** Losing entitlement does **not** delete the row. The user keeps their choice if access returns, and this creates no authorization gap because **runtime authorization must be re-checked on every AI operation** — permission is never inferred from the row's existence.
- **A future client control is advisory UX only.** The database and runtime server boundary decide whether a preference may be set or used. `useCurrentUserAccess().canSelectAiModel` exists to decide whether to *show* a control, never to authorize one.
- **Future models are not implied.** Gemini 3.7, Anthropic/Claude and OpenAI/GPT are intentional future possibilities and are **not implemented**. `ai_model_catalog.provider` is deliberately left unconstrained so adding one is a seed row plus a runtime adapter rather than a constraint migration — but each still requires explicit **provider, privacy, cost and runtime-adapter** work, and none may be seeded before that acceptance. Floating aliases such as `gemini-flash-latest` are not selectable models: a user cannot meaningfully choose a label whose concrete model changes underneath them.

**Rationale:** Model choice is a differentiated capability with a real marginal cost, so it belongs to the commercial entitlement rather than to every account. Putting the gate in an explicit column rather than in a plan-name comparison is what makes an internal/test grant a one-row server write instead of a code change, and it is what keeps authorization off the client. Storing the provider-qualified id rather than the bare provider model string is what keeps a user's saved choice stable as the catalog grows.

**Account export.** `user_ai_preferences` is **user-owned portable account data and is exported from the moment the schema and the write RPC ship** — not from the moment a Settings control makes saving one convenient. `set_current_user_ai_model` is granted to `authenticated`, so an entitled caller can create a real preference row as soon as migration `20260902120000` is applied; a UI is not a precondition for user data, and an export that omitted such a row would silently drop a choice the user made. It is a **singleton** category at `data/user_ai_preferences.json` (its `user_id` is the table's primary key), carrying exactly `user_id`, `preferred_model_id`, `created_at` and `updated_at`. **Absence of a preference exports as JSON `null`**, which is meaningful rather than empty: it is what "no explicit choice — Paperlume uses its system default" looks like to a reader.

`ai_model_catalog` remains **permanently** excluded, and for a different reason: it is global product metadata, identical for every account and authored by Paperlume, so it is not this user's data at all. The exported preference deliberately does not resolve its id against the catalog — doing so would put Paperlume's metadata into a personal archive and would make the exported choice go stale whenever a display name changed. The stable provider-qualified id is the whole of the user's decision.

The reader tolerates exactly one degradation: a missing-object error naming `user_ai_preferences`, which is the rollout window in which an environment has the code but not yet the migration. In that case only, the category exports as `null`. Permission denied, an RLS refusal, an auth failure, a network error, a timeout, a malformed query or response, a missing *unrelated* object and any generic or unknown error all continue to **fail the whole export**, because once the table exists a genuine read failure and "the user has no preference" are indistinguishable in the archive and only one of them is true. **`AI-MODEL-SELECTION-001C` owns no export work** — the Settings control adds no new portability obligation.

*(Corrected 2026-09-02 by `AI-MODEL-SELECTION-001A-CORRECTION-01`. The first draft of this decision deferred the preference to 001C on the reasoning that it was "unreachable" until a UI existed. That reasoning was wrong: an authenticated write surface is reachable, and "no screen for it yet" is not a valid exclusion reason for user-authored data. The excluded-table registry now admits only two reasons — not user-authored content, or not account data at all — and "not yet" is not among them.)*

**Consequence (foundation):** `AI-MODEL-SELECTION-001A` — one additive migration (`20260902120000_add_ai_model_selection_foundation.sql`), regenerated Supabase types, the additive `canSelectAiModel` on `useCurrentUserAccess`, the account-export singleton and its narrow rollout classifier described above, database and unit tests, and documentation. No Production migration, Edge deploy, secret change or provider request was part of that work.

**Consequence (runtime routing):** `AI-MODEL-SELECTION-001B` — **implemented for Google Gemini, repository-only, no new migration.** One shared module, [`supabase/functions/_shared/aiModelSelection.ts`](../supabase/functions/_shared/aiModelSelection.ts), is the single implementation both AI operations use, so their authorization and fallback behaviour cannot drift:

- **Entitlement is re-checked on every AI operation**, not inferred from a preference row. `analyze-paper` and `suggest-paper-organization` each call `get_current_user_access()` through the caller-authenticated client and honour a saved preference only when `can_select_ai_model === true`. There is no `plan === 'pro'` comparison, no email check and no internal-role check in either Edge Function — the database access projection is the authority.
- **A valid saved preference routes the provider call.** The preference is read from `user_ai_preferences` with an explicit `.eq("user_id", <authenticated id>)` on top of the SELECT-own policy, then resolved through the server-controlled `ai_model_catalog`. Non-entitled, no-preference and inactive-entitlement callers all use the system default.
- **`enabled` and `selectable` deliberately differ at runtime.** A saved preference requires `enabled = true` only: `selectable = false` closes a model to *new* choices without revoking one a user already made, while `enabled = false` retires it and falls back. Requiring **both** remains the setter's job at save time, and `set_current_user_ai_model` is unchanged.
- **Metadata failure fails closed to the system default, never to an error.** An access RPC error, a malformed access row, a preference read failure, a malformed preference, a catalog read failure, a missing/disabled/malformed catalog row and an unsupported provider all resolve to `resolveGeminiModel(GEMINI_MODEL)`. That is fail-closed on the *paid capability* while preserving availability of the ordinary AI feature: none of them becomes a PaperLume 402, none refunds a unit, and none fails the request.
- **The provider adapter boundary is real.** `google` is the only implemented adapter. A catalog row naming any other provider is refused rather than called, and no external URL is constructed for it; the Gemini `generateContent` URL is assembled in exactly one place, from an `AiModelSelection` object that can only be produced by the resolver.
- **The database catalog is the allowlist.** No TypeScript list of model strings was created — a second allowlist could disagree with the first.
- **Only the model component of the provider URL changes.** Prompts, request bodies, `responseMimeType`, parsing, extraction schemas, the suggestion contract, quota consumption, refunds, provider-error classification and the 90-second / zero-retry Gemini transport (permanent since 2026-09-19, C46) are all untouched, and both models are served by the same existing `GEMINI_API_KEY`. `get-gemini-provider-quota` deliberately stays system-default observational monitoring rather than a per-user routing endpoint (C29 remains deferred), so it and the two generation functions may now legitimately name different models for the same request — that divergence is the feature, not drift.
- **Bounded diagnostics only.** One routing line per provider-bound request (operation, source, provider, public model name) and one bounded reason on an unexpected fallback. No user id, email, token, API key, raw database error or request content. The two ordinary states — not entitled, no preference — log no warning at all.

No Production migration, Production database write, Edge deploy, secret change, `GEMINI_MODEL` change or provider request was part of 001B.

**Consequence (Settings UI):** `AI-MODEL-SELECTION-001C` — **implemented, repository-only, no migration and no Edge Function change.** Settings gains an **AI Model** section ([`src/components/settings/AiModelSettingsSection.tsx`](../src/components/settings/AiModelSettingsSection.tsx)) over a focused data hook ([`src/hooks/useAiModelSettings.ts`](../src/hooks/useAiModelSettings.ts)), composed by `SettingsDialog`:

- **The server capability is the only gate.** The section renders an enabled control only when `useCurrentUserAccess().access.canSelectAiModel === true`. There is no plan-name comparison, no email or user-id allowlist, no role check and no browser-storage flag anywhere in the surface — and the setter re-checks the same entitlement server-side regardless, so the control stays advisory UX.
- **"Paperlume default" is the absence of a row, not a model.** The sentinel is a UI-only value (`__paperlume_default__`); choosing it calls `clear_current_user_ai_model()` and it is **never** passed to the setter. It deliberately does not embed the current provider model, so a future `GEMINI_MODEL` switch never becomes a frontend-deploy dependency. An explicit Gemini 3.5 pin and "no preference" are rendered as different states even though they currently route identically.
- **The catalog supplies the choices.** Options come from `ai_model_catalog` (`id, provider, display_name, enabled, selectable, sort_order`, ordered `sort_order` then `id`), filtered to `enabled AND selectable` and to the provider families the shipped UI can route to. That provider boundary — currently `google` — names providers, never models, so it is not a second model allowlist; adding Anthropic or OpenAI stays an explicit feature change.
- **Reads are user-scoped and writes go only through the two RPCs.** The preference read carries an explicit `.eq("user_id", <authenticated id>)` on top of the SELECT-own policy and uses singleton semantics; there is no `INSERT`, `UPDATE`, `UPSERT` or `DELETE` against `user_ai_preferences` or `ai_model_catalog` anywhere in the frontend. Opening Settings creates no preference row.
- **No optimistic update, and saving does not close the dialog.** The control is disabled while a write is in flight, duplicate submissions are refused, and the saved preference is refetched from the server rather than assumed. Only `saved === true` is treated as success; a malformed result is an error, never a silent success.
- **Bounded rejection messages, and each refreshes what it implies is stale.** `missing_entitlement` / `not_entitled` / `inactive_entitlement` produce one access-oriented message and re-read the access projection (entitlement may have lapsed since the dialog opened); `unknown_model` / `model_disabled` / `model_not_selectable` produce one catalog-staleness message and refresh catalog + preference. Raw Supabase or Postgres text is never rendered.
- **Retired and dormant states are reported truthfully.** An `enabled = true, selectable = false` saved model is shown as the current, still-honoured choice but is disabled for new selection, so switching away is visibly one-way. A disabled or missing saved model reports that Paperlume is using the default — matching what the 001B runtime actually does — and is never silently rewritten. A non-entitled user with a dormant preference is told it is inactive and can clear it, but cannot change it, which is the UI expression of the intentionally entitlement-free clear RPC.
- **Fail-closed on unknown state.** While access is loading no enabled control is rendered at all; an access-lookup error, a catalog read failure and a preference read failure each remove the control and offer a bounded retry. A failed read is never displayed as "no preference".
- **Capability-gated, not commercial.** The non-entitled state says model selection is available on eligible plans and offers **no** upgrade, checkout, pricing or purchase affordance — public/commercial launch remains separately controlled.

The existing PubMed key field, its Save/Remove behaviour and its Enter-key handling, the storage gauge, the bounded scroll container and the coarse-pointer initial-focus protection are all unchanged; changing the model cannot submit the PubMed form. No migration, no `supabase/functions/**` change, no Production mutation and no provider request is part of 001C.

**Re-evaluation trigger:** for the **capability tier**, an owner decision to offer model choice on Free (which would be a pricing decision, not an implementation one). For the **catalog**, an explicit product acceptance of a specific new model, which must clear provider terms, privacy/data-handling review, cost modelling and a runtime adapter before a seed row is written. For the **downgrade rule**, only evidence that a dormant preference is being honoured somewhere without an authorization re-check — which would be a defect in the runtime path, to be fixed there rather than by deleting users' saved choices. For the **provider adapter boundary**, the point at which a non-Google model is genuinely accepted for the catalog: that is when `unsupported_provider` stops being the correct answer and an adapter must exist before the seed row is written, not after.

### C34. Gemini 3.5 Flash is the Paperlume system default; Gemini 3.6 Flash remains an entitled explicit choice (2026-09-02)

**Decision:** Paperlume's **system default** AI model is **Gemini 3.5 Flash** (`gemini-3.5-flash`). **Gemini 3.6 Flash** stays in the catalog as an `enabled`, `selectable` model an entitled user may explicitly pin. Neither is removed, and no automatic failover between them is implemented.

Specifically, and durably:

- **The default is server-side configuration, not application code.** The running default is resolved from the `GEMINI_MODEL` environment configuration through `resolveGeminiModel`, server-side. Changing the default is an environment change; it is not a frontend deploy, not a migration, and not a catalog edit.
- **The browser is not an authority for the default.** The Settings control represents "follow the default" as a sentinel meaning *absence of a preference* (C33), and deliberately does not embed `gemini-3.5-flash` or any other provider model. A future default switch therefore cannot be broken, delayed or contradicted by a stale client bundle.
- **Both catalog rows remain `enabled = true, selectable = true`.** 3.6 is a choice a user may make, not a retired model. Retirement would be `enabled = false` (C33), and nothing here retires anything.
- **An explicit preference pins that model; it does not track the default.** A user who explicitly selects Gemini 3.5 Flash has pinned 3.5 and will keep it if the system default later moves. That is why an explicit 3.5 pin and "no preference" are represented as different states in the UI even while they route to the same provider model today.
- **No preference follows the default.** The absence of a `user_ai_preferences` row means the account uses whatever `GEMINI_MODEL` currently names.
- **There is no automatic provider failover from an explicit choice.** If a user explicitly selects Gemini 3.6 and Google returns a provider failure, the existing provider-error behaviour applies unchanged — Paperlume does not silently substitute another model behind the user's explicit decision. Adding failover would be a separate decision with its own cost, correctness and transparency review.

**Verification status — both paths are now verified in Production.**

*Default path (verified 2026-09-02).* The owner completed a Production canary immediately after the default switch: one **Suggest Projects & Tags** and one **Analyze Paper** request, both `source=system_default provider=google model=gemini-3.5-flash`, one Gemini 3.5 request counted per operation, both returning sensible output.

*Explicit 3.6 preference path (verified 2026-09-03).* `AI-MODEL-SELECTION-001C` itself made no provider request of any kind — it shipped the control and nothing more. Once PR #268 merged (commit `0ad72f6f4bb2a8cbb40ad1f7290f77b8c004de39`) and the Settings **AI Model** control went live in Production, the owner used it to save an explicit Gemini 3.6 preference and then ran both generation operations:

| Operation | Result | Latency | Quality | Gemini 3.6 counter | Routing log | Function version |
|---|---|---|---|---|---|---|
| Suggest Projects & Tags | **PASS** | ~15s | sensible | 6 → 7 | `suggest-organization model_routing source=user_preference provider=google model=gemini-3.6-flash` | `suggest-paper-organization` v10 |
| Analyze Paper | **PASS** | ~29s | sensible | 7 → 8 | `analyze-paper model_routing source=user_preference provider=google model=gemini-3.6-flash` | `analyze-paper` v26 |

Each action counted **exactly one** provider request and required **no retry**. So the whole chain is confirmed end to end in Production: Settings saved the user's explicit choice, the runtime re-proved entitlement and resolved the preference as `source=user_preference`, and both operations routed to `gemini-3.6-flash` and returned sensible output. This closes the pending item this decision previously carried.

**What these two successes do NOT establish.** They are not evidence that Gemini 3.6 has perfect or guaranteed availability. The earlier operational history stands unchanged — two Suggest 503 failures, one Analyze 90-second timeout, and later successful 3.6 calls. The supportable conclusion is that **Gemini 3.6 has demonstrated intermittent provider availability/latency, while Paperlume's integration and its explicit-preference route are confirmed functional.** No official Google outage finding is drawn, then or now, and nothing here changes the decision itself: 3.5 remains the system default, 3.6 remains an explicit entitled choice, and there is still no automatic failover.

**Rationale:** The operational evidence in the switch window showed 3.6 provider failures alongside successful 3.5 requests, which is sufficient reason to make 3.5 the default that every unconfigured account lands on. It is **not** sufficient to conclude anything official about a Google outage, and no such conclusion is recorded here. Keeping 3.6 selectable rather than disabling it preserves user choice and keeps the evidence reversible: if 3.6 proves healthy, the default can move back with an environment change alone.

**Re-evaluation trigger:** sustained provider-error evidence for either model; a Google deprecation or pricing change affecting either; or a decision to implement automatic failover, which would supersede the last bullet. *(The "first successful owner-driven 3.6 preference-path verification" trigger has fired — it occurred on 2026-09-03 and is recorded under Verification status above, so it is no longer outstanding.)*

### C35. Gemini 3.7 Flash and Gemini 3.8 Flash are approved selectable Google models; the system default does not move (2026-09-03)

**Decision:** Paperlume's user-selectable model catalog is extended from two models to four. **Gemini 3.7 Flash** (`google/gemini-3.7-flash`, provider model `gemini-3.7-flash`) and **Gemini 3.8 Flash** (`google/gemini-3.8-flash`, provider model `gemini-3.8-flash`) are added as `enabled = true, selectable = true` rows in `public.ai_model_catalog`, at `sort_order` 30 and 40. Neither becomes the system default.

Specifically, and durably:

- **The intended selectable list is now Gemini 3.5 Flash, Gemini 3.6 Flash, Gemini 3.7 Flash, Gemini 3.8 Flash**, in that catalog order (10 / 20 / 30 / 40). 3.5 and 3.6 are untouched — not their ids, provider models, display names, flags or sort positions — and nothing was renumbered, so a preference a user already saved keeps its meaning and its place in the list.
- **The system default remains Gemini 3.5 Flash under C34.** `GEMINI_MODEL` is unchanged and no migration touches it. A catalog row makes a model *selectable*, never *default*; the two are deliberately separate concepts, and moving the default stays an environment change.
- **All four are served by the existing server-side `GEMINI_API_KEY`** through the existing Google adapter. No second Gemini key, no model-specific key, no secret name and no credential column was added, and none may ever be: the catalog stores product metadata only.
- **No allowlist was added anywhere in code.** The 001B runtime holds no TypeScript list of model strings and the 001C Settings surface holds no model list either — the database catalog is the allowlist, so a reviewed row is the entire mechanism by which a supported Google model becomes routable and offerable. Expected runtime-code delta and production frontend-code delta were both **none**, and both held: no file under `supabase/functions/`, `src/components/settings/` or `src/hooks/` changed. Concrete model ids appear in tests and fixtures, which is fixture data rather than a rule.
- **The request contract is unchanged.** Same prompts, same JSON `responseMimeType` structured-output contract, no explicit sampling overrides (`temperature` / `top_p` / `top_k` remain absent per `AI-PROVIDER-REQUEST-CONTRACT-001A`), same parsing, same quota consumption and refund behaviour, same 90-second timeout, same zero provider retries. Only the model component of the Gemini URL varies, exactly as it already did for 3.5 and 3.6.
- **No existing preference was rewritten.** Adding rows is additive product metadata; nobody's saved choice moves because the list got longer. The Production preference row explicitly holding `google/gemini-3.6-flash` — the owner's selection from the C34 canary — stays exactly as it is. The migration proves this rather than asserting it: its fail-closed self-check refuses to commit if any preference or entitlement row was written, or if any pre-existing catalog row was modified.
- **No automatic model failover is introduced.** An explicitly chosen 3.7 or 3.8 that fails keeps the existing provider-error behaviour, exactly as C34 established for 3.6. Paperlume does not silently substitute another model behind a user's explicit decision.
- **Entitlement is unchanged.** C33's gate — `ai_model_selection_enabled` plus an `active` / `trialing` status — decides *who* may choose. 001D changes only *what* an already-entitled user may choose. No plan, price, AI quota, user limit or billing configuration was touched, and nothing here implies Paperlume has enabled Google's paid tier.

**Provider evidence (Google first-party documentation, re-read 2026-09-03).** Google's model documentation lists **`gemini-3.7-flash`** as a **stable** model — "our previous-generation Flash model for complex coding, agentic workflows, and reliable multi-step execution" — with structured outputs supported, a 1,048,576-token input limit and a 65,536-token output limit. Google's deprecation table records its **release date as 2026-08-13** and **no shutdown date announced**. **`gemini-3.8-flash`** is listed as **stable** and as Google's newest and most capable Flash model, with structured outputs supported, the same 1,048,576 / 65,536 token limits, thinking levels low / medium / high (`minimal` is rejected), the stable endpoint `gemini-3.8-flash`, **release date 2026-09-02** and **no shutdown date announced**. Both speak the same `generateContent` contract Paperlume already sends. Neither is preview-only, and no request-contract incompatibility with Paperlume's existing structured-output calls was found.

**Rationale:** The catalog exists precisely so that accepting another model from a provider already reviewed is a reviewed row rather than a code change. Both models are GA on the provider Paperlume already uses, through the credential it already holds, under the request contract it already sends — so the marginal risk is the risk of the list being longer, not the risk of a new integration. Appending at 30 and 40 rather than reordering keeps every already-saved preference stable. Leaving the default at 3.5 keeps C34's verified default path intact: adding choices is not the same decision as changing what every unconfigured account lands on, and conflating them would spend C34's Production evidence for nothing.

**Verification status — rollout and routing verified; provider generation not yet.** `AI-MODEL-SELECTION-001D` itself was repository-only and made no Gemini request. The rollout and its canaries happened afterwards, and the results separate cleanly into three layers.

*Layer 1 — Production catalog rollout: **COMPLETE** (2026-09-03).* Migration `20260903120000_add_gemini_37_38_catalog_models.sql` was applied to Production as a database-only change; the ledger records `20260903120000 add_gemini_37_38_catalog_models`. The catalog now holds exactly four rows — 3.5 (10), 3.6 (20), 3.7 (30), 3.8 (40), all `enabled`, `selectable`, `provider = google`. The 3.5 and 3.6 rows kept their exact values **and** timestamps, and no preference, entitlement, grant, policy, RLS setting or column changed. **No frontend or Edge deployment was required or performed**, which is the architectural claim this decision was built on.

*Layer 2 — Settings discovery and explicit routing: **VERIFIED** for both models.* The owner refreshed the live app and Settings → AI Model listed exactly `Paperlume default`, `Gemini 3.5 Flash`, `Gemini 3.6 Flash`, `Gemini 3.7 Flash`, `Gemini 3.8 Flash`, in that order, with the previously saved 3.6 preference still selected — so the catalog expansion rewrote nobody's choice. Selecting 3.7, and later 3.8, persisted. Production logs then prove the whole chain — Settings → preference → entitlement → catalog → shared resolver → provider model — reached the exact model each time. These are **manual live acceptance checks, not a browser regression suite.**

| Model | Suggest attempt | Execution id | Request id | Routing log | Outcome |
|---|---|---|---|---|---|
| 3.7 | 1 of 1 | `1c9b20eb-51de-4773-a272-477cfdb3adae` | `01a0668b-759d-72f1-936c-d4b8552ae4a8` | `source=user_preference provider=google model=gemini-3.7-flash` | `provider_failure class=provider_unavailable detail=http_503 provider_attempts=1 refund=attempted` |
| 3.8 | 1 of 2 | `28f26561-1c4b-4476-9074-5bfec19fca06` | `01a06692-85af-7c55-83d9-40187fe37ec3` | `source=user_preference provider=google model=gemini-3.8-flash` | same 503 shape |
| 3.8 | 2 of 2 | `0e0994bc-c97c-4eac-86ba-4e56c0e4e0ea` | `01a06692-ae29-750d-bd0a-5a61fcacc72b` | `source=user_preference provider=google model=gemini-3.8-flash` | same 503 shape |

All three ran on `suggest-paper-organization` **v10**. Provider counters moved 3.7 `0 → 1` and 3.8 `0 → 2`, matching one provider request per user action under the zero-retry policy.

*Layer 3 — successful provider generation: **NOT VERIFIED** for either model.* Every attempt above returned Google **HTTP 503** (`provider_unavailable`). **No Analyze Paper canary was run on 3.7 or on 3.8** — the only Analyze routing line in the window belongs to the earlier 3.6 canary.

**What the 503s do and do not mean.** The observed evidence argues **against** a Paperlume model-selection/routing defect as the cause of these requests' failures: each one resolved the saved user preference, cleared the entitlement and catalog checks, selected provider `google` and carried the exact intended provider-model string, and only then did the provider path return HTTP 503. That verifies the **exercised** preference → catalog → routing path; it does **not** prove that every behaviour in `_shared/aiModelSelection.ts` is defect-free, and a 503 is not by itself evidence about what the provider resolved internally. The 503s likewise do **not** establish an officially confirmed Google outage, a global failure of either model, or that all users are affected — only that Paperlume received `provider_unavailable` from the provider path in this window, a pattern Gemini models have shown here before. And `refund=attempted` is exactly that: the refund path ran, which is **not** proof that a refund succeeded. The accurate summary is that **Paperlume reached the intended provider model path, while successful Gemini 3.7 / 3.8 generation remains unverified.**

Nothing here changes the decision: no model is disabled or removed, no automatic failover is introduced, the transport policy stays 90-second timeout with zero retries, and the system default stays `gemini-3.5-flash` (C34) — an explicit choice that fails does not silently fall back to it. C34's explicit **3.6** path remains separately Production-verified (successful, for both Suggest and Analyze) and is unaffected by these results.

**Re-evaluation trigger:** the first **successful** owner-driven Production provider canary on 3.7, and separately on 3.8 (each closes that model's open Layer-3 item above); a **sustained** pattern of provider-unavailable results for either model, which would make `enabled = false` worth *considering* — note that no disablement decision is taken here, and the current evidence does not support one; a Google deprecation, shutdown date or pricing change affecting either model; a documented request-contract change that Paperlume's `generateContent` call would no longer satisfy; or an owner decision to change the system default or introduce automatic failover, either of which would be a C34-level decision rather than a catalog change.

---

### C36. Extension-import duplicates are resolved from canonical PMID/DOI identity only, and only when exactly one owned row is provable (2026-09-03)

**Decision:** `/extension-import` may apply the user's selected Projects and Tags to a paper that is **already in their library**, and it may do so only on identity the database can prove. `safe_bulk_insert_papers` answers a `unique_violation` with the existing paper's `id` when — and only when — exactly one row owned by the caller matches the attempted PMID or DOI. The route then **adds** the selection to that row.

Specifically, and durably:

- **Duplicate *resolution* is the same rule as duplicate *detection*, applied to the same two columns.** The per-user partial unique indexes are the whole identity contract, and the resolver mirrors them exactly: `pmid` compared as stored, `doi` compared through `lower()`, both scoped to `user_id`, both ignoring NULLs the way the partial predicates do. Naming which row collided is a *narrower* question than deciding that something collided, and it may never be answered with a wider rule than the one that raised the collision.
- **Title, fuzzy, and metadata similarity never participate.** No title comparison, trigram or edit distance, no author/year/journal/abstract heuristic, no URL matching, no Crossref or PubMed lookup. This is the standing PMID/DOI-only duplicate rule, unchanged — 001D adds no new matching concept, it exposes identity that the unique indexes already implied.
- **Exactly one distinct owned candidate is the only sufficient proof.** An incoming record carrying a PMID that belongs to paper A and a DOI that belongs to paper B violates both indexes by *different* rows, and the database holds no fact saying which one the user meant. Every available tie-break — constraint evaluation order, id order, creation order, closest title — is an accident rather than an answer, and acting on one would file someone's taxonomy against a paper they did not choose. Two-or-more candidates, and zero provable candidates, both return **no id** and perform **no assignment**. Do not propose a tie-break, and do not propose resolving it by title.
- **Assignment to an existing paper is ADDITIVE, through dedicated RPCs.** `bulk_add_paper_projects` / `bulk_add_paper_tags` insert missing memberships and contain no `DELETE` at all. The replace-all `bulk_set_*` setters are unchanged and stay correct for newly inserted rows — calling one of them on a months-old paper with only this handoff's selection would delete every other Project and Tag it was filed under, which is precisely the outcome this design exists to make unexpressible.
- **Acting on a resolved duplicate id is an explicit per-call opt-in.** `bulkImportPapers` takes `applyAssignmentsToResolvedDuplicates`, default `false`, and `/extension-import` is its only caller — justified because that user picked taxonomy for that one paper moments earlier. Add Papers, PubMed Search and parsed-file import keep skipping duplicates untouched; extending this to bulk paths, or to historical duplicate cleanup, is a **separate Product decision** and must not be introduced as an implementation detail.
- **The route reads the importer's terminal result, and never re-resolves anything itself.** Assignment happens after the progress callback, so the callback cannot prove it. `bulkImportPapers` returns per-identifier status plus per-category assignment evidence, and the page's copy is built only from that. The page issues no lookup of its own — a second resolution path would fork the decision the importer just made.
- **Ambiguity is reported as refusal, not as a choice.** The user is told the paper appears to already exist, that PaperLume could not identify exactly one existing paper, and that the selection was therefore not applied. Candidate rows are not described, not counted and not offered for disambiguation, and no internal row id is ever rendered.
- **The absent-id answer is also the pre-migration answer**, which is what makes the web half deployable before the database half. A client that treats "duplicate without id" as "do nothing" behaves correctly against both schemas and calls no function the older schema lacks.

**Verification status — live in Production and accepted at the database/RPC layer (2026-09-11).** Migration `20260903180000` is present exactly once in the Production ledger, and its three RPC bodies are byte-identical to the repository's. A bounded, authenticated acceptance on the dedicated Production acceptance account — disposable data, removed afterwards — confirmed the properties above live: an exact-PMID duplicate and a differently-cased-DOI duplicate each returned the existing owned row's id; a PMID and a DOI naming two different rows returned **no** id; and `bulk_add_paper_projects` / `bulk_add_paper_tags` added a membership while the existing one survived, idempotently on repeat. The `/extension-import`-only opt-in rests on current source and local regression coverage; no Production browser flow was run. The decision itself is unchanged. Record: [migration-history.md](migration-history.md), 2026-09-11 closure entry.

**Re-evaluation trigger:** a product decision to let bulk import paths assign to existing papers; a request to disambiguate two candidate rows interactively; any proposal to widen duplicate identity beyond PMID/DOI (which C-level duplicate policy already refuses); a change to either per-user unique index, which would silently change what a returned duplicate id means and must be accompanied by a matching change to the resolver and to suite `013`.

### C37. Attachment cleanup intent is durable in Postgres before the metadata that names it disappears; physical removal is a bounded, authenticated retry, never a scheduled worker (2026-09-04)

**Decision:** An attachment's binary and its metadata live in two systems that cannot share a transaction. PaperLume therefore stops trying to order the two operations well and instead makes the **intent** durable: `public.attachment_cleanup_queue` records the Storage key in the SAME Postgres transaction that removes the metadata making the key reachable. Physical deletion becomes a retryable operation over recoverable state rather than a one-shot over a variable in a browser tab.

On the upload side the same principle takes a second form. There the danger is not a lost intent but a *wrong* one: the browser can believe a metadata write failed when it committed, and act on that belief by deleting the file. So the decision about whether an uploaded object becomes an attachment or becomes garbage is made once, on the server, under a lock — never inferred from what a browser observed.

Specifically, and durably:

- **Cross-system deletion cannot be atomic, so the ordering question is the wrong question.** Storage-first orphans a metadata row and its quota charge when the metadata delete fails; database-first orphans a binary when the Storage delete fails. Both were reachable in the product — the first in `deleteAttachment`, the second in `deletePaper` / `bulkDeletePapers`, whose cleanup failure was logged and swallowed. The fix is not a better order but a durable record: **no statement may remove the last knowledge of a Storage path without first writing that path down.**
- **The queue is attachment-cleanup-specific operational state, not a job framework.** It holds a user id, a Storage path, a narrow reason and a timestamp. It is not a general task queue, and email, AI, import or any other retry must not be routed through it. Nothing on the server executes a row; a row is an intent, and the browser that owns the namespace is what acts on it.
- **The user prefix is the security boundary, in three places.** Storage RLS already keys owner access on `(storage.foldername(name))[1]`; the RPCs re-validate the first path segment against `auth.uid()` before writing a queue row; and the browser re-validates it again before any `remove()`. Paths are attachment-path-specific and carry no PMID, DOI or bibliographic meaning — they are `{userId}/{paperId}/{uniqueName}` and nothing else. Cross-user paths are unrepresentable, and malformed ones fail the whole operation closed rather than committing half of it.
- **Clients may never INSERT a queue row.** A queue row is an instruction to delete a Storage object, so a client that could write one could schedule the destruction of its own valid attachments. `authenticated` holds SELECT-own and DELETE-own and nothing else; every row comes from a `SECURITY DEFINER` RPC that has proved ownership and knows the logical-deletion condition. DELETE-own is safe to expose because acknowledging a row only ever means "stop trying", whose worst outcome is a binary that account deletion later sweeps.
- **Cleanup is idempotent at every layer.** `(user_id, file_path)` is unique, so repeated intent converges on one job; removing an already-absent Storage object is a Supabase no-op; acknowledgement deletes only rows whose batch Storage confirmed. Two tabs draining the same row is therefore safe, and a Storage success followed by a failed acknowledgement leaves the row for a retry that costs nothing. Because two tabs really do drain concurrently, the walk holds no offset: it repeatedly reads the HEAD of the queue and advances by deleting what it finishes, so rows another consumer acknowledges can never shift an unseen row past it.
- **Upload finalization is one serialized server decision, because "the write failed" is not something a browser can know.** A metadata write whose HTTP response is lost may still commit, so any client-side compensation that acts on the observed error can delete a valid, quota-charged attachment. The metadata INSERT therefore does not happen in the browser at all: `finalize_attachment_upload` takes a transaction-scoped advisory lock on `(auth.uid(), file_path)` before it reads anything, so two attempts at the same object are strictly ordered rather than both reading the same pre-commit state. Exactly one of "metadata exists" and "cleanup is authorized" can ever be true for a path — enforced beyond the RPC by a BEFORE INSERT tombstone trigger on `paper_attachments`, so a direct client INSERT cannot resurrect a path already declared garbage either. On an ambiguous transport failure the browser's only permitted move is to repeat the idempotent call; if the database still does not answer, the object is LEFT IN PLACE and no cleanup is claimed. Deleting on a guess is the failure mode this rules out, and it is ruled out by a state invariant, not by a delay, a grace period or a retry count.
- **The decision must outlive the work it authorises.** A queue row is work and is deleted the moment Storage confirms; "this path was finalized as garbage" is a decision and must not be. `public.attachment_cleanup_tombstone` keeps it, so a duplicated or delayed finalization arriving after the drain has removed the object and acknowledged its row still resolves to cleanup instead of creating metadata for a deleted binary. It is written only by finalization, has no policy and no grant for any client role, holds a Storage key and nothing else, and cascades with the account. Deletion-sourced cleanup is deliberately NOT tombstoned: only finalization can create metadata, so tombstoning those paths would grow a permanent record of every attachment ever deleted and buy no invariant.
- **Paper deletion and upload finalization are serialized on the paper.** Deletion snapshots the attachment paths it will queue and then deletes the papers; without a lock an upload can commit an attachment between those two steps, and the cascade then destroys the only record of its object. The foreign key does not help — it makes the cascade happen, it does not make the snapshot current. Both writers take the same per-paper advisory lock, deletion before its snapshot and finalization before its first read. Deadlock freedom is structural, not lucky: finalization takes path-then-paper and exactly one paper lock, deletion takes only paper locks and takes them in sorted order, so no cycle can form.
- **Stale clients are a server problem, because the client at fault has already shipped.** After the migration, a browser tab still running the pre-migration bundle can still attempt both historical destructive orderings. No new client code reaches it. So `attachments_owner_delete` gained one condition — the owner may not delete an object a live `paper_attachments` row still names — which makes both stale orderings fail safely while every legitimate path still works, because each of those removes or never had the metadata first. **The fence is a property of the post-migration database only, and saying otherwise would invent objects that do not exist yet.** During the web-first window the corrected frontend is talking to the *legacy* database: there is no fence, no `attachment_cleanup_queue`, no tombstone, no lifecycle RPC and no drain, because `20260904120000` is what creates all of them, together, in one transaction. In that window a stale tab's raw `DELETE FROM papers` behaves exactly as it always has — it removes the metadata first, so its Storage call succeeds — and the corrected frontend falls back to the same legacy path. *After* phase 2 commits, the fence exists and that path is neither legitimate nor permitted: `DELETE` on `papers` is revoked, so the stale tab is refused with `42501` at the `DELETE` itself, before it ever reaches Storage. So the legitimate list the fence permits — durable deletion, upload compensation, the drain — is a list that only has members once the migration that defines them has landed. That is deliberate — it fails early and destroys nothing, rather than cascading metadata away and stranding the binaries — but it must not be described as continuing to work. The owner-prefix boundary is unchanged, and account deletion is unaffected because it sweeps with the elevated role. This makes web-first deployment the RIGHT order rather than merely a safe one.
- **After the cutover, browsers do not write attachment metadata at all.** Everything above reasons about which of two systems to trust when a browser and the database disagree, and that question only arises because the browser is allowed to write the metadata directly. It is not, after `20260904120000`: `authenticated` keeps `SELECT` and loses `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on `paper_attachments`, while `anon` and `PUBLIC` are revoked **by role** and keep nothing at all — see the rollout note below for why that distinction is load-bearing rather than stylistic, so metadata is created and destroyed only by the three lifecycle RPCs, the cascade they initiate, and account deletion. `TRUNCATE` is revoked with the rest for a sharper reason than tidiness: it removes every row without firing a row trigger or consulting RLS, and is the one statement that could refund no quota and record no intent. This turns *"Postgres never removes ordinary user attachment metadata without recording the Storage cleanup intent in the same transaction"* from a convention of the current React bundle into a database-enforced invariant. This is a deliberate, feature-specific narrowing of `20260731162729_reconcile_data_api_grants`, which granted those privileges when the client contract still needed them; every other grant in that migration stands. `service_role` is untouched — nothing writes this table with it today, but the account-deletion cascade and any future privileged repair are what a server role is for. The now-dead `owner insert` / `owner delete` RLS policies are also kept, so an accidental re-grant would still meet the ownership predicate underneath.
- **Hosted Production and a clean replay do not start from the same ACL, so the revoke names the role rather than the privileges.** The first Phase-2 Production attempt was refused by the migration's own `DO $verify$` with `anon must not hold SELECT on paper_attachments`, and nothing in this repository could have predicted it. Production was provisioned under Supabase's **old** platform default, which auto-granted ALL (`arwdDxtm`) on every new public table to `anon`, `authenticated` and `service_role`; a `db reset` today gets the **new** default, which grants the API roles only `Dxtm` (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) and none of the four DML privileges, after which `20260731162729_reconcile_data_api_grants` grants back only what each table's policies expose — and it grants `anon` nothing, anywhere. The environments differ precisely in `SELECT`/`INSERT`/`UPDATE`/`DELETE` for `anon`. A migration that revokes **by privilege name** therefore converges the replay while leaving on Production whatever it failed to name. The `paper_attachments` half refused, because §7 asserted `anon` held no `SELECT`; the `papers` half would have **committed** with `anon` still holding `SELECT`, `INSERT` and `UPDATE`, because §7 only ever asserted `DELETE` and `TRUNCATE` there. Both halves now revoke `anon` and `PUBLIC` **by role** — `REVOKE ALL … FROM PUBLIC, anon` — which converges either starting ACL, while `authenticated` keeps its per-privilege treatment because there the contract genuinely is per privilege. §7 asserts all five privileges for `anon` on both tables and that `PUBLIC` holds nothing on either. **This was a reachable-surface defect, not an exposure:** every policy on both tables requires `auth.uid() = user_id`, which is NULL in an anonymous session, so `anon` could never read a row even while it held `SELECT`. The class escaped CI because every test ran only against a clean replay; `scripts/e2e-local.mjs` now seeds the legacy Production ACL explicitly and proves the cutover converges it (`ACL-1`…`ACL-3`).

- **The cascade is a door too, and it is the one the old bundle actually uses.** `paper_attachments.paper_id` is `ON DELETE CASCADE` from `papers`, so deleting the parent removes attachment metadata without any statement naming the child. Closing direct DML on `paper_attachments` while leaving `DELETE` on `papers` open would make the invariant a statement about which table a caller happens to write — and the pre-migration bundle writes the parent: it reads the paths, issues a raw `DELETE FROM papers`, and only then asks Storage to remove the binaries. So `DELETE` and `TRUNCATE` on `papers` are revoked too — and the two client roles do not end in the same place. `authenticated` loses `DELETE` and `TRUNCATE` and keeps `SELECT`, `INSERT` and `UPDATE`: creating and editing papers has nothing to do with this feature and is not narrowed. `anon` and PUBLIC lose the entire table privilege surface, `SELECT`/`INSERT`/`UPDATE` included, because the product has no unauthenticated data path and hosted Production's legacy ACL had granted `anon` all five. Paper deletion goes through `delete_papers_with_attachment_cleanup`, which validates every id, serializes against finalization, snapshots every attachment path and records the cleanup intent before the cascade can run. Two functions in the schema still delete papers and both are trusted: that RPC, and `merge_exact_duplicates`, which re-parents attachment rows onto the kept paper *before* removing the discards, so nothing cascades and no object is stranded. Account deletion is the third path and is deliberately outside this: it deletes the auth user, and its own independent Storage sweep is what actually removes the binaries.
- **The cutover lock order is derived, not picked, and it spans three tables.** Strong locks on several tables is where migrations deadlock, so every mode and the order itself follow from what else is running. The final global order is:

  ```sql
  LOCK TABLE auth.users            IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.papers         IN SHARE MODE;
  LOCK TABLE public.paper_attachments IN ACCESS EXCLUSIVE MODE;
  ```

  **`auth.users` first,** because the queue and tombstone tables carry `user_id ... REFERENCES auth.users(id) ON DELETE CASCADE` and PostgreSQL takes `SHARE ROW EXCLUSIVE` on the *referenced* table when a foreign key is added — verified directly on the PostgreSQL 17.6 this project runs, for the inline `CREATE TABLE` form as well as `ALTER TABLE ... ADD CONSTRAINT`. The migration therefore always needed this lock; it merely used to take it implicitly and *last*, hundreds of lines after the two downstream barriers. That is a lock-order inversion and a real deadlock against an ordinary account deletion, which holds `auth.users` and cascades into `papers` and `paper_attachments` — reproduced, not theorised (`ERROR: deadlock detected`, the migration waiting for `ShareRowExclusiveLock` on `auth.users` while the deletion waited for `RowExclusiveLock` on `paper_attachments`). Taken first, the migration waits **upstream holding nothing**. `SHARE ROW EXCLUSIVE` is exactly the mode the foreign keys will require, so there is no later lock upgrade — an upgrade is its own deadlock shape; it conflicts with `ROW EXCLUSIVE`, so Auth writers are drained and then excluded; and it does not conflict with `ROW SHARE`, so the reference checks ordinary inserts make against `auth.users` continue.

  **`papers` second, in `SHARE`.** It must conflict with `ROW EXCLUSIVE` (or it drains nothing) and must NOT conflict with `ROW SHARE` or `ACCESS SHARE` (or it blocks the foreign-key check of an in-flight `paper_attachments` INSERT — including the ones a stale tab is still issuing during the cutover — while that transaction holds the child the migration is waiting for). That leaves `SHARE`.

  **`paper_attachments` last.** Locking the child first would put an in-flight `DELETE FROM papers`, which holds the parent and needs the child for its cascade, on the other side of a cycle that cannot be fixed, because that transaction is a browser's raw statement. Parent-first inverts it into a cycle whose other side is always this repository's own code — so `delete_papers_with_attachment_cleanup` and `merge_exact_duplicates` each take `LOCK TABLE public.papers IN ROW EXCLUSIVE MODE` before touching `paper_attachments`, which is the lock their own DELETE/UPDATE takes moments later and therefore changes no ordinary concurrency. Neither needs a lock on `auth.users`.

  The resulting proof is two sentences. Once the first barrier is granted, no session holds a conflicting `auth.users` lock, so no Auth cascade can be in flight downstream at all. And while the migration holds `SHARE ROW EXCLUSIVE` on `auth.users` and `SHARE` on `papers` and waits for `paper_attachments`, every session that can hold a `paper_attachments` lock needs at most `ROW SHARE` on `auth.users` and `ROW SHARE` or `ACCESS SHARE` on `papers` — which those two modes respectively grant. No cycle can form.

- **That proof is about the writers the schema will have; one writer it HAS breaks it, and no lock order fixes that — hence two phases.** `merge_exact_duplicates` as deployed in Production takes no table lock at all: it reads `papers` (ACCESS SHARE), writes `paper_attachments` (ROW EXCLUSIVE), and only then issues `DELETE FROM papers` (ROW EXCLUSIVE). Child before parent — the exact opposite of a stale bundle's direct paper deletion. Both of the weak parent locks it takes first are compatible with the barrier's `SHARE`, so nothing stops the interleaving, and it deadlocks with the migration as the victim (reproduced: *"Process 325 waits for AccessExclusiveLock on paper_attachments; Process 322 waits for RowExclusiveLock on papers"*). This is **not** fixable by reordering: two historical writers with opposite orders on the same two tables means whichever order the barrier takes, one of them can cycle with it — parent-first with the merge, child-first with the paper delete (the deadlock the parent lock was added to close). Intermediate tables do not rescue it either; `paper_tags` and `paper_projects` are cascade children of `papers` *and* are written by the legacy merge before it touches `paper_attachments`. The only remaining move is to retire the child-first writer first, and that **cannot happen inside the cutover transaction**, because `CREATE OR REPLACE FUNCTION` does not drain in-flight executions — measured on PostgreSQL 17.6, the replacement returned in 32 ms while the old call was parked mid-body, and that call still completed with the **old** body. So the rollout is two separately committed migrations with a real drain between them: `20260904110000` installs the parent-first merge; the operator proves no transaction predating it is still open; only then may `20260904120000` run. Phase 2 enforces both halves itself, fail-closed, before it takes a single lock (`PHASE 1 MISSING` / `DRAIN NOT PROVEN`), because `supabase db push` will otherwise apply both files back to back with no boundary at all. Phase 1 is semantically inert and safe to leave in place indefinitely — it changes only *when* the merge takes a lock it already took — so a delayed or failed phase 2 leaves a fully functional database. Procedure and the exact verification query: [deployment.md](deployment.md) §6.4.
- **A revoke does not wait for anybody, so the migration takes an explicit barrier.** `REVOKE` locks catalog rows, not the table. Without a barrier, a direct metadata `INSERT` that was permission-checked *before* the cutover commits happily *after* it — and the Storage fence, asked whether live metadata names the object, gets "no" from a row that has not committed yet, permits the delete, and the row then commits: metadata present, quota charged, binary gone. The migration therefore opens with the three-lock barrier above and holds it to commit, which waits out every in-flight writer, admits no new one, and releases exactly when the new privileges become visible — so a statement that queued behind it is planned against them. The whole file runs in an explicit `BEGIN … COMMIT`, both because `LOCK TABLE` is an error outside a transaction under a statement-at-a-time runner and because the fence and the revoke must become visible in the same instant; either one alone leaves a window. The operational cost is stated rather than hidden: for its (catalog-only, millisecond) duration the migration blocks all writes to `auth.users` — signup, account deletion and Auth user mutation, though reads and foreign-key reference checks continue — all access to `paper_attachments`, and all writes to `papers`; and beforehand it waits for the longest open Auth, paper or attachment transaction. There is deliberately no `lock_timeout` — a timeout would turn a correctness barrier into a race the migration sometimes loses, and it is not there to make rollout faster.
- **What a stale bundle can and cannot do afterwards, stated honestly.** It can no longer create a valid metadata row, so it can no longer create the half-state that made the old orderings dangerous; its upload fails visibly instead of silently producing a damaged attachment, and its Storage-first deletion is refused by the fence. What it does NOT gain is durable cleanup: it cannot call functionality it does not know exists, so it writes no queue row and no tombstone. If its refused upload's own immediate Storage cleanup also fails, that binary remains as an untracked orphan inside the owner's private namespace until the account-deletion Storage sweep finds it. That residual is bounded by how long stale tabs live after the deploy, and it must not be described as durable retry.
- **The ordering claim is proved by a real multi-connection probe, not by a sequential test.** Every statement in a pgTAP transaction is already serialized, so a single-connection suite cannot distinguish a design that serializes from one that merely produces a tidy end state. `runAttachmentFinalizationProbe` and `runPaperDeleteFinalizationProbe` (`scripts/e2e-local.mjs`) hold one writer open, demonstrate that the superseded existence check reads the stale absence that used to destroy files, and require the corrected writers to block — observed through `pg_locks`, not inferred from a sleep — and then converge. They cover the post-acknowledgement replay and both paper-delete orderings. `runMigrationCutoverProbe` does the same for the cutover itself: it restores the pre-cutover grant, holds a real direct `INSERT` open, and requires the barrier to block on it — again read from `pg_locks` — then requires the writer queued behind the barrier to be refused with `42501` rather than committed. `runMergeCutoverCases` covers the legacy merge: `M-CUT-1` is a negative control that must genuinely reproduce the superseded deadlock — the suite fails if it cannot, so it can never pass vacuously — `M-CUT-2` proves the phase gate refuses the same interleaving *before taking a lock* and that the merge then completes with the attachment on the kept paper, no half-merge and no cleanup row invented, and `M-CUT-3` proves a merge begun after the boundary uses the parent-first body. `runParentCutoverCases` repeats the race against `papers`, and `runAuthCutoverCases` against `auth.users`: it holds a real account deletion at exactly the lock state `DELETE FROM auth.users` reaches, requires the barrier to queue **upstream** while provably holding *no* downstream lock, lets the deletion cascade through `papers` and `paper_attachments` and commit, and requires the cutover to complete with no deadlock in any session. It also pins the asymmetry that matters: an Auth writer arriving behind the barrier is **delayed and then succeeds**, because account deletion is not a privilege being revoked — unlike the stale paper delete in `P-CUT-2`, which is refused. Any future change to how finalization serializes must keep those probes honest or replace them with equivalents.
- **Retry is bounded and there is no scheduled worker.** One attempt immediately after the user's action, one on the next authenticated session start, and that is all: no `setInterval`, no polling, no service worker, no cron, no scheduled Edge Function, no autonomous server component. This is a deliberate limit, not an oversight — the authenticated Storage owner is already permitted to do the deletion, so adding privileged infrastructure would widen the blast radius of a leaked key to buy a guarantee the final sweep already provides.
- **Account deletion remains Storage-sourced and is the last resort.** `delete-account` continues to enumerate Storage itself, recursively and paginated, and must never be rewritten to trust the queue as an inventory: the queue can never be assumed complete, historical and pre-feature orphans exist, and an object with neither a metadata row nor a queue row must still be found. Documentation must not claim binaries are deleted immediately and unconditionally, nor that cleanup is guaranteed for a user who never returns.
- **Quota accounting is untouched.** `user_storage_usage` still tracks metadata through the existing BEFORE INSERT / AFTER DELETE triggers, so an object awaiting cleanup is already refunded while physically present. Making quota include pending bytes is a separate Product/accounting decision and was explicitly not taken here.
- **The client is correct against the pre-migration schema, which is what makes web-first deployment safe.** A narrow classifier recognises only the four cleanup object names, and only under a missing-object code; every other failure stays a real error. It additionally refuses the compatibility verdict once any cleanup object has answered in the session, so a partially installed schema fails visibly instead of silently downgrading every user to the older lossy path. The pre-migration path keeps the browser-side metadata INSERT and its immediate compensation — including the lost-response weakness, which cannot be fixed from a client against a schema that has no finalization RPC — and keeps the user-visible strings that shipped, so deploying this frontend does not quietly change what Production says before the migration is applied.

**Re-evaluation trigger:** introducing an autonomous server-side cleanup worker (cron, scheduled Edge Function, queue consumer) — which would change what this design may honestly claim about users who never return; moving attachment writes server-side; changing the Storage path layout away from `{userId}/{paperId}/{uniqueName}`, which is what the path validation and the Storage RLS both key on; changing Storage ownership policy; changing quota accounting to include pending-cleanup bytes; adding a second Storage bucket, which would need its own namespace rule and its own queue semantics; **relaxing the Storage delete fence**, which protects an already-loaded pre-migration tab from itself; **re-granting any write privilege on `paper_attachments` to a client role**, **re-granting `DELETE` or `TRUNCATE` on `papers`**, or weakening either half of the migration's cutover barrier — including changing the `papers` lock mode away from `SHARE`, or letting a function that writes both tables reach `paper_attachments` before it locks `papers` — each of which reopens either the pre-cutover-write race the fence alone cannot close or the cascade bypass; **any change to how upload finalization serializes** — a different lock, a different key, removing the tombstone trigger, or running finalization at an isolation level other than `READ COMMITTED` — each of which invalidates the linearization argument above and must be re-proved by the concurrency probe rather than reviewed. None of those is pre-decided here.

### C38. The Data API relation/sequence client-role privilege matrix is stated in full, and a new public relation or sequence reaches no client role until a migration says so (2026-09-10)

**Decision:** PaperLume's client-role privileges on the Data API **relation and sequence** surface are now a complete, exact statement rather than a floor. `PUBLIC` and `anon` hold **nothing** on any relation or sequence in `public`; `authenticated` holds exactly the per-table set its product paths use and nothing else; `service_role` is deliberately untouched. Function EXECUTE is a separate surface and is **not** part of this decision (see below). Migration `20260910212202_reconcile_data_api_acls.sql` implements it. **Production status: applied and verified on 2026-09-11 at migration `20260910212202`** (ledger 80 → 81; ordinary `public` tables with a direct `anon` grant 17 → 0), through the bounded owner-authorized rollout described in [deployment.md](deployment.md) §6.5.

- **Row-level security does not govern every privilege, and that is the load-bearing fact.** Policies exist for SELECT, INSERT, UPDATE and DELETE. `TRUNCATE` is gated by the object privilege alone: a role holding it can empty an RLS-enabled, RLS-**forced** table it cannot read a single row of. `TRIGGER` lets a role attach a trigger to a table it does not own — and then not remove it, because `DROP TRIGGER` requires ownership. `MAINTAIN` permits VACUUM/ANALYZE/REINDEX/CLUSTER on someone else's table. So "RLS protects those tables anyway" was true of the four DML privileges and false of the other four, which is why the non-DML half is removed rather than tolerated.
- **The severity claim is bounded, and stays bounded.** No anonymous row exposure through the Data API was demonstrated, and none is claimed: every policy requires `auth.uid() = user_id`, which is NULL for `anon`, and three of the affected tables have no policy at all. PostgREST exposes no TRUNCATE verb and no DDL, so the destructive capability above is reachable only by something that can open a SQL session as one of these roles. This is a least-privilege and defense-in-depth defect with a latent destructive capability behind it, plus a replay/regression problem — **not** a Production data-exposure incident, and it must not be described as one.
- **Two starting histories, so the revoke names the ROLE.** Hosted Production carried the platform's original grants when this was decided (`anon` holding all eight privileges on 17 tables); a clean replay inherits only the non-DML residue. They do not disagree about one privilege, they disagree about the whole ACL, so `REVOKE SELECT, INSERT, UPDATE, DELETE` would converge the replay and leave `anon` holding `TRUNCATE` on Production. `REVOKE ALL … FROM PUBLIC, anon, authenticated` followed by an explicit re-`GRANT` of the intended surface is idempotent across both. The migration accepts either history and refuses anything else — and it judges `postgres`'s default-privilege entry **whole**, every grantee included: `anon` and `authenticated` must each match the same history, `PUBLIC` may hold no direct default, `service_role` must be a recognised platform shape (which is then preserved), and any other grantee stops the migration before it changes anything. Checking `anon` alone is not enough, because D1a revokes by name: an unexplained `authenticated` default would be silently normalized, and a grantee nobody named would pass straight through.
- **Future objects are hardened at the default (D1a), because the next author will forget.** `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES/SEQUENCES FROM PUBLIC, anon, authenticated` makes a forgotten ACL fail **closed** — the new table is simply unreachable — instead of shipping a table the platform default already exposed. It is scoped to `postgres` and to `public`, and it covers tables, views, materialized views, partitioned tables and sequences.
- **D1a does not replace the per-object rule (D2).** Every migration that creates an API-reachable object still REVOKEs by role and GRANTs its exact surface explicitly. D1a cannot cover objects created by other owners, cannot touch functions, and a project-level setting could re-grant those defaults at any time; it is a second layer, not the contract.
- **Supabase's own 2026-10-30 platform change is compatible in both orders.** Supabase moves existing projects to opt-in Data API defaults on that date, keeping existing table grants. Its documented statements are `REVOKE`s and strictly narrower than D1a (they leave `TRUNCATE`/`REFERENCES`/`TRIGGER`/`MAINTAIN` on tables and `UPDATE` on sequences), so running them after this migration restores nothing, and if they land first the migration accepts that shape and removes the remainder. Suite 015 runs Supabase's exact statements against the converged state and proves it.
- **`service_role` is excluded deliberately, not by omission.** Its **table** privileges were already aligned between Production and a clean replay; its sequence and default postures are environment-dependent (hosted vs replay: `rwU` vs `wU` on the sequence, ALL vs `Dxtm` on table defaults, `rwU` vs `w` on sequence defaults). So this initiative deliberately preserves the exact pre-migration `service_role` posture rather than converging or narrowing it — narrowing it would be a new decision. It also bypasses RLS, which makes object privilege its only gate, and it is the role behind every Edge Function: a wrong revoke fails server-side in paths no browser test covers. The migration deliberately references it in its preconditions and verification, but names it in no privilege-mutating `GRANT`, `REVOKE` or `ALTER DEFAULT PRIVILEGES` statement; its exact observed posture is preserved, and the migration refuses to commit if that posture moved. *(Follow-up, 2026-09-29: narrowing it became its own decision, **C57**, applied to Production on 2026-09-29. `service_role` now holds only the telemetry `INSERT` and the refund `EXECUTE` on application-owned objects. Its sequence and default postures are no longer environment-dependent: Production and a full replay both end with no `service_role` sequence grant and owner-only `postgres`/`public` defaults. The preserved posture described here is the pre-C57 state.)*
- **Function EXECUTE privileges are excluded, and the reason is mechanical.** The five SECURITY INVOKER helpers carry PUBLIC EXECUTE, but that comes from PostgreSQL's built-in **global** default for functions, which `ALTER DEFAULT PRIVILEGES … IN SCHEMA public` cannot revoke — Supabase's own documented `revoke execute on functions from public` is per-schema and therefore ineffective against it. Removing it needs a global, cross-schema default change that would also affect functions `postgres` creates in `extensions`, where the installed extensions live. Suite 015 adds a fail-closed inventory guard so a **new** invoker routine cannot inherit it unnoticed; the revoke itself is a separate initiative. *(Correction, 2026-09-28 — `DB-DEFAULT-FUNCTION-EXECUTE-HARDENING-AUDIT-001`, C56. Three parts of this bullet, and the matching header of `20260910212202`, which stays untouched as applied history, were imprecise. **(1)** PUBLIC EXECUTE on an **existing** function is answered by a per-object `REVOKE`; only **future** inheritance needs a default-privilege change. **(2)** Default privileges never touch existing objects, so a global `postgres` default change does not change the functions already installed in `extensions`. It governs functions `postgres` creates **later**, in any schema, and extension objects `postgres` itself owns because it installed a non-superuser extension; `pgmq` is the proven example. Supautils-privileged and trusted extensions install as `supabase_admin` and are unaffected. **(3)** On hosted Production, `anon`, `authenticated` and `service_role` did not execute these functions only through PUBLIC: Supabase's `postgres`/`public` function default also gave each an explicit grant. C56 applies the per-object revoke and the global default change; see C56.)*
- **`paper_tags` / `paper_projects` keep `SELECT, INSERT, DELETE`.** Today's browser only reads them and every mutation goes through a SECURITY DEFINER RPC, so the grants are arguably surplus — but narrowing them is a change to the repository's established contract, not convergence toward it, and it is out of scope here. *(Follow-up, 2026-09-25: that narrowing is now its own decision, **C48** — the two junctions go to `SELECT` only, while `projects` / `tags` keep their full grant. That follow-up is complete: migration `20260925134526` was applied to Production on 2026-09-25, so the live junction grant is now `SELECT` only; the `SELECT, INSERT, DELETE` recorded here is the pre-C48 state.)*
- **The rollout needed no ordering, and none was used.** No web-first deploy, no Edge deploy, no operator drain and no lock barrier: every privilege removed is one RLS already denies that role every row of, or one no application path uses, and `authenticated`'s live DML surface is identical before and after. The one observable difference is that an operation which never worked now fails with `42501` instead of reporting "0 rows affected".

**Re-evaluation triggers:** an unauthenticated Data API path is ever introduced (today there is none); `service_role` least-privilege hardening is authorized *(fired 2026-09-29: C57, applied to Production 2026-09-29)*; the function-EXECUTE initiative is authorized *(fired 2026-09-28: C56, applied to Production 2026-09-28)*; a new client-reachable relation kind (view, materialized view, partitioned or foreign table) is added to `public`; or Supabase changes what its platform default grants, in which case the migration's accepted starting shapes and suite 015's default-privilege assertions are re-derived rather than relaxed.

### C39. AI provider protocol is isolated behind reviewed server-side adapters: the database catalog authorizes MODELS, the runtime registry authorizes PROTOCOLS (2026-09-12)

> **Partly superseded — read this entry as the 001A checkpoint.** C39 records the provider seam at `AI-MULTI-PROVIDER-001A` completion, when **`google` was the only registered adapter**, `GEMINI_API_KEY` the only AI provider credential and the Settings provider filter Google-only; **every provider-count, credential and UI-filter fact below is historical unless it carries its own supersession.** C41 later registered the Anthropic and OpenAI adapters and moved the Settings `SUPPORTED_PROVIDERS` list with them; the **Phase 6 deploy on 2026-09-17** put that three-provider runtime live in Production; and **C43** (`AI-MULTI-PROVIDER-001E`) staged both paid catalog rows and installed both credentials on **2026-09-18**, canaried them per provider and per operation, and made both rows user-selectable at **Phase 8 on 2026-09-19**. Production serves **Google, Anthropic and OpenAI** today — for current provider state read C41, C43 and [deployment.md](deployment.md) §3.2, §6.6a and §14. **The architectural decision itself remains in force:** the catalog authorizes models, the registry authorizes protocols, a new provider still needs a reviewed adapter and its own credential before it can be routed to, an unregistered provider still fails closed with `unsupported_provider`, and protocol stays separate from product semantics.

**Decision:** PaperLume's AI runtime has an explicit provider seam. Model selection decides *which* model a request should use; a **provider adapter** decides *how* to speak to that provider; and a **runtime adapter registry** decides which provider protocols PaperLume is able to speak at all. `AI-MULTI-PROVIDER-001A` implements that seam with **`google` as the only registered adapter** and **no change to the shipped Gemini path's user-visible, provider-request, routing, quota/refund or commercial behaviour, nor to how it parses any response Google's documented schema can produce**. Its one deliberate difference is a log-only privacy hardening, stated below together with the stricter reading of envelopes that schema cannot produce.

At 001A completion, specifically:

- **Two allowlists, two different questions, and they must not be conflated.** `public.ai_model_catalog` remains the authoritative, server-controlled allowlist of **models** (C33/C35), and adding a model **for a provider that already has a registered adapter** stays a reviewed migration with no code change; a model from a **new** provider also needs that provider's reviewed adapter, its own credential and explicit provider, privacy and cost acceptance first (see the re-evaluation trigger below). The runtime registry ([`supabase/functions/_shared/aiProviderRegistry.ts`](../supabase/functions/_shared/aiProviderRegistry.ts)) is the allowlist of **provider protocols** — the answer to "does PaperLume have a reviewed adapter for this row's provider?" It contains **no model string**, and duplicating the catalog in TypeScript remains forbidden: a second model allowlist could disagree with the first.
- **A catalog row is necessary but not sufficient.** A seed row naming `anthropic`, `openai` or anything else is still refused at runtime and still falls back to the system default with `unsupported_provider` — now because the registry has no adapter for it, rather than because a string comparison said `google`. The refusal happens in the resolver, **before** any URL, credential or request for that provider could be constructed, and it stays a model-selection fallback: never a 402, never a refund, never a failed AI request. *(Superseded for these two providers: C41 registered the Anthropic and OpenAI adapters, so a valid, enabled row for either is now honoured rather than refused. The rule itself stands unchanged for any provider that has no registered adapter.)*
- **An adapter is typed for its own provider.** `AiProviderAdapter<P>.generate` accepts only an `AiProviderModel<P>`, and it is a function-typed property rather than a method, so its parameter is checked contravariantly and a Google adapter cannot be widened into one that accepts another provider's models. The registry is typed as a map from each provider id to the adapter *for that provider*, and `getAiProviderAdapter(p)` returns an adapter typed for exactly `p`. Pairing the Google adapter with a model resolved for another provider is therefore a compile error, not a Gemini request carrying someone else's model name. CI does not type-check Edge code, so those signatures are also pinned by source in `_shared/__tests__/aiProviderTypeBoundary.test.ts`, whose compile-time assertions are enforced by a direct strict typecheck of the Edge modules.
- **Adapters own protocol; operations own product semantics.** The Google adapter ([`_shared/googleAiProvider.ts`](../supabase/functions/_shared/googleAiProvider.ts)) is now the only code that knows the Gemini `generateContent` URL, the `system_instruction` / `contents` / `generationConfig` envelope, the `x-goog-api-key` header and the `candidates[0].content.parts[0].text` response envelope. `analyze-paper` and `suggest-paper-organization` know none of those; they build a provider-neutral request (a system instruction, one user-content string, `responseFormat: "json"`), receive normalized **text**, and run their own existing strict parsers. No Project/Tag logic, no TLDR/study-type extraction and no quota decision may ever move into an adapter.
- **Nothing provider-shaped crosses the boundary outward.** A failure crosses as a bounded kind (`http`, `network`, `timeout`, `unreadable_response`, `empty`) plus, for HTTP, the status — never a `Response`, a provider header, a provider error body or a provider error message. That is what keeps a new abstraction from making raw provider errors easier to log, and it is enforced by test rather than by convention.
- **Provider-specific transports need not share a retry policy.** The Google adapter calls [`_shared/geminiTransport.ts`](../supabase/functions/_shared/geminiTransport.ts) and 001A neither changed its constants nor generalised them: the 90 s per attempt / zero retries policy — at the time of 001A still the bounded `AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A` experiment, and **since 2026-09-19 PaperLume's permanent Gemini policy under [C46](#c46-adopt-90-second-single-attempt-gemini-transport-as-the-permanent-policy-2026-09-19)** — was left untouched, and it is **not** asserted to be right for any future provider. Status semantics, `Retry-After` handling, idempotency and streaming differ between providers, so a shared *adapter contract* is claimed here and a shared *transport policy* is deliberately not.
- **The system default is provider/model metadata, not an assumption.** `resolveSystemDefaultAiModel(GEMINI_MODEL)` returns `{ provider: "google", providerModel }`, and the resolver returns whatever it was given rather than manufacturing `google` internally. The resolver's provider type is narrowed to a *registered* provider, so "the safe fallback is a provider we can actually call" is a property of the types and an adapter lookup has no failure branch a caller could mishandle after consuming a quota unit.
- **Credentials stay explicit and server-side.** `GEMINI_API_KEY` remains the **only** AI provider credential and is read exactly where it was read before. There is no generic `AI_API_KEY`, no `AI_PROVIDER` switch, and no secret name in the catalog. **A task that registers a second adapter owns binding each provider to its own credential name before it can route to one.**
- **The Settings provider filter mirrors the registry.** `src/hooks/useAiModelSettings.ts` keeps its own provider-family list (currently `google`), which names providers rather than models for the same reason. It and the registry must move together; neither is a model allowlist.
- **No client controls provider or model.** Unchanged and re-verified: neither request contract has a model or provider field, neither function reads a query parameter or a non-`Authorization` header, and the resolver reads no request input at all.

**Behavioural claim, and its one stated exception.** 001A is a refactor: for every response Google's `generateContent` API can produce, both operations' URL, method, headers, request bytes, parsing, quota consumption and refund behaviour, provider-error classification and user-visible responses are identical to the pre-refactor code, and so are their log lines apart from the one log-only change below. This was verified mechanically by running the pre- and post-refactor implementations of **both** operations side by side across 24 scenarios each — success, fenced output, unparseable output, whitespace output, empty envelope, non-JSON 2xx body, HTTP 429/503/400, network failure, timeout, an honoured Gemini preference, hypothetical Anthropic/OpenAI rows, a retired model, metadata failures, quota denial and a missing key — comparing status, response body, response headers, the exact provider URL/method/headers/request-body hash, the RPC sequence, the database reads and the emitted log lines.

The single deliberate difference is one **log line**, in `analyze-paper` only: a 2xx whose body is not JSON used to be logged with the JSON parse error's own message, which quotes a fragment of the provider's body, and is now logged as a bounded reason (spelled `gemini_unreadable_response` until EDGE-LOG-PRIVACY-HARDENING-001 renamed it `provider_unreadable_response`, since all three providers can produce it). The HTTP status, the response body, the `provider_unavailable` classification and the refund are unchanged. This is required by the adapter contract above — a provider error body may not cross the boundary — and it narrows what can be logged rather than widening it.

Two further facts are recorded rather than fixed. `analyze-paper` classifies an unreadable 2xx body as `provider_unavailable` while `suggest-paper-organization` classifies the same case as `malformed_response`; that divergence predates 001A, is preserved exactly, and aligning it would be a behaviour change needing its own decision. And the two functions' envelope readers were consolidated onto the stricter of the two, so envelopes that violate Google's documented response schema — a non-string `text`, or `candidates`/`parts` encoded as JSON objects rather than arrays — are now `empty` for `analyze-paper` where they were previously a crash-classified `provider_unavailable` or (for the object-as-array case) a success. Google's proto3 JSON serialization cannot emit either shape, so no reachable Gemini response is affected.

**Rationale:** The owner intends to offer models from other providers later. Without this seam, adding one meant threading a second provider through four places in two Edge Functions that must not drift apart, while the runtime's only notion of "provider" was a string equality check. Making the *protocol* implementation the unit of review — and keeping it separate from the *model* allowlist the database already owns — means a future provider is an adapter plus a credential plus a reviewed catalog row, and until all three exist the runtime refuses to call it. Doing that as a refactor that preserves provider requests, user-visible responses and commercial behaviour — with the golden-request and differential evidence and the one log-only exception above — keeps the risk of the foundation separate from the risk of the providers it will later carry.

**Scope, explicitly.** 001A registered no second provider, added no model, no migration, no catalog row, no credential, no reasoning/thinking controls, no token or cost telemetry and no pricing; it changed no prompt, no suggestion cap, no quota semantics, no entitlement and no Settings behaviour; and it was **not deployed** at the time — it reached Production only with the 2026-09-17 Phase 6 deploy of both generation functions (C42 staging).

**Re-evaluation trigger:** the point at which a non-Google provider is genuinely accepted (`AI-MULTI-PROVIDER-001B`), which must add an adapter, its own credential name, its own error/retry review and its privacy review **before** a catalog row is seeded — registering an adapter is precisely when `unsupported_provider` stops being the right answer for that provider; a decision to give providers a shared transport policy, which this decision declines to assume; a change to the Gemini transport policy, which is `geminiTransport.ts`'s and not the adapter's — note that the 90-second / zero-retry policy is no longer a pending diagnostic awaiting restoration but the permanent Gemini policy under [C46](#c46-adopt-90-second-single-attempt-gemini-transport-as-the-permanent-policy-2026-09-19); or evidence that an adapter has acquired product semantics (parsing, quota, user-facing wording), which would mean the seam has drifted and belongs back on the operation's side.

### C40. New external AI provider adapters are implemented and reviewed while unregistered; protocol implementation alone does not make a provider routeable (2026-09-12)

> **Partly superseded — read this before relying on anything below it.** This entry records the state at `AI-MULTI-PROVIDER-001B` completion, and **every bullet below describes that state unless it carries its own supersession.** Three separately authorized steps have changed it since: **C41** (`AI-MULTI-PROVIDER-001C`) made the per-operation reasoning, output-budget and credential-binding decision and **registered both adapters**; the **Phase 6 deploy on 2026-09-17** put that runtime live in Production; and **C43** (`AI-MULTI-PROVIDER-001E`) staged both paid catalog rows and installed both credentials on **2026-09-18**, canaried them per provider and per operation, and made both rows user-selectable at **Phase 8 on 2026-09-19**. Anthropic and OpenAI are therefore **live provider families in Production today**, reachable by any entitled user who selects Claude Sonnet 5 or GPT-5.6 Terra. For current state read C41, C43 and [deployment.md](deployment.md) §3.2, §6.6a and §14 — not the bullets below. **The decision itself is unchanged:** implementing a provider's protocol still does not, by itself, make that provider routeable.

**Decision:** New external AI provider adapters are implemented and reviewed while **unregistered**. Implementing a provider's protocol does not, by itself, make that provider routeable. Registration is withheld until PaperLume has an explicit per-operation reasoning/output policy, credential binding and rollout authorization. `AI-MULTI-PROVIDER-001B` applies this to Anthropic and OpenAI: both adapters exist in repository code, and neither is registered.

Specifically, and durably:

- **Adapters can exist without registration.** [`_shared/anthropicAiProvider.ts`](../supabase/functions/_shared/anthropicAiProvider.ts) (Claude Messages API) and [`_shared/openAiProvider.ts`](../supabase/functions/_shared/openAiProvider.ts) (OpenAI Responses API) are complete, tested protocol implementations. Tests import them directly. An adapter never needs a registry entry to be exercised; if one ever seemed necessary, the design would have drifted.
- **The registry remains the activation boundary.** [`_shared/aiProviderRegistry.ts`](../supabase/functions/_shared/aiProviderRegistry.ts) is unchanged: `registeredAiProviders()` is `["google"]`, `RegisteredAiProvider` is `"google"`, and the registry imports neither new module. A catalog row naming `anthropic` or `openai` still falls back to the system default with `unsupported_provider`, exactly as under C39.
- **The Settings provider filter mirrors REGISTERED providers, not adapter source files.** `SUPPORTED_PROVIDERS` in [`src/hooks/useAiModelSettings.ts`](../src/hooks/useAiModelSettings.ts) stays `["google"]`, so a seeded Anthropic or OpenAI row is not offered. An ordinary merge to `main` redeploys the frontend, so widening this list ahead of the registry would expose a provider the server cannot route.
- **Catalog rows remain absent.** No migration, seed or SQL adds Claude Sonnet 5 (`claude-sonnet-5`), GPT-5.6 Terra (`gpt-5.6-terra`) or any other non-Google row. Those model ids appear only as test fixtures and as named future targets in documentation.
- **No secret is installed, and no shipping code reads one.** The intended future names are `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, alongside `GEMINI_API_KEY`. Neither is set, and neither operation reads either. There is still no generic `AI_API_KEY`, and no secret name lives in the catalog. Binding each provider to its credential at the operation shell belongs to the task that registers it.
- **No Production data flow exists to either provider.** At 001B no shipping Edge Function imported either adapter module, so neither was in any deployment closure, and Production ran the pre-001A Google-only artifacts. *(Superseded since, in this order. C41 registered both adapters and the 2026-09-17 Phase 6 deploy put both modules in the live generation bundles — still unreachable at that point, with no catalog row and no credential. `AI-MULTI-PROVIDER-001E` (C43) then staged both paid rows and installed both credentials on 2026-09-18 and ran the paid-provider canaries, the first PaperLume requests ever sent to Anthropic and OpenAI, and Phase 8 made both rows user-selectable on 2026-09-19. Production data flow to both providers therefore exists today, for entitled users who select those models. **001B itself sent no provider request and created no Production data flow** — that is what this bullet records.)*
- **OpenAI calls, when eventually activated, are stateless with `store: false`.** The Responses API stores responses by default, so the adapter sends `store: false` on every request. It also sends no `metadata`, `safety_identifier`, `user`, `conversation`, `previous_response_id` or tools. Permanent tests assert every one of those. They are part of the reviewed contract, not defaults for a later task to revisit.
- **Provider-native reasoning must never be inherited accidentally as PaperLume product policy.** Claude Sonnet 5 runs adaptive thinking by default at effort `high`, and GPT-5.6 Terra reasons at effort `medium` by default. Both adapters send no reasoning or thinking configuration at all, so they express no PaperLume opinion. They stay unregistered precisely so that those provider defaults cannot become PaperLume behaviour. The per-operation policy, and a real output budget replacing each adapter's provisional 4,096-token ceiling, was deliberately deferred to `AI-MULTI-PROVIDER-001C`, whose decision had not been made at 001B. *(C41 made it, and that reasoning and output policy is live in Production.)*
- **Operations own the output schema; adapters translate it.** The provider-neutral request gained a required `jsonSchema` (`{ name, schema }`). `analyze-paper` and `suggest-paper-organization` each own a schema that mirrors their existing parser contract exactly: the three analysis string fields, and the four suggestion arrays with the current caps unchanged. Anthropic maps it to `output_config.format`; OpenAI maps it to `text.format` with `strict: true`. The Google adapter ignores it, so the Gemini request bytes are unchanged (golden body SHA-256 `3285186f…`). Neither dialect can express the suggestion caps, the length bounds or the request-local ref rule, so each operation's parser remains the final authority.
- **One bounded failure kind was added: `incomplete_response`.** Both new protocols report a terminal state inside a 200 response: Anthropic's `stop_reason` and OpenAI's `status`. A truncated, declined or abandoned generation is neither `empty` nor `unreadable_response`, so a new kind names it. Google cannot produce it. Both operations classify it explicitly as `malformed_response` with a refund, so the branch exists before any provider that needs it is routeable.
- **Transports stay provider-specific, per C39.** Each new adapter has its own single-attempt, no-retry transport with its own 60-second ceiling, inside the documented 150-second Supabase Edge envelope. Neither calls or generalises `geminiTransport.ts`.

**Relationship to C39.** C39's re-evaluation trigger anticipated that a non-Google provider would be accepted in `AI-MULTI-PROVIDER-001B`. It was not: 001B implements protocols only. C39's trigger therefore has not fired, and it now applies to 001C.

**Rationale:** Reviewing a provider's protocol and deciding PaperLume's policy for that provider are different decisions with different risks. Separating them lets the protocol be proved deterministically first (request bytes, response traversal, failure normalization, privacy terms) before any policy question has to be answered. The registry guarantees that nothing reviewed but unpoliced can be reached. Registering an adapter that still carried its provider's reasoning defaults would have made those defaults PaperLume's product behaviour by omission.

**Scope, explicitly.** 001B registered no provider and added no catalog row, migration, secret, reasoning policy, output budget, token or cost telemetry, prompt caching, pricing or Settings change. It changed no prompt, no suggestion cap, no quota semantics and no user-visible behaviour, and it was not deployed.

**Re-evaluation trigger:** `AI-MULTI-PROVIDER-001C`, which sets the per-operation reasoning/thinking and output-budget policy and binds each provider to its own credential at the operation shell. Only after that may it register Anthropic/OpenAI and widen the Settings provider filter, in step with the registry. Also: any proposal to register an adapter before such a policy exists, which this decision forbids; or evidence that a provider's documented contract (structured-output field names, the `store` default, terminal-state values) has changed, which would require re-reviewing that adapter before registration.

### C41. Reasoning is a model-aware PaperLume product policy: Automatic is operation-specific and explicit, manual reasoning is model-validated, and provider defaults are never silently inherited (2026-09-12)

**Decision:** How hard an AI model thinks is a **PaperLume product decision**, made per model and per operation, stated in server-controlled data and sent explicitly on every request. `AI-MULTI-PROVIDER-001C` implements the full repository-side policy, registers the Anthropic and OpenAI adapters that C40 held back, and binds each provider to its own credential. It also stages every user-facing part of the feature **off**.

Specifically, and durably:

- **Automatic is PaperLume's policy, never the provider's default.** "Automatic" does not mean "omit the provider's reasoning parameter and inherit whatever that provider defaults to today". It means PaperLume chooses a concrete level from the model's catalog row for this operation and sends it. Gemini's default is `medium`, Sonnet 5 runs adaptive thinking at effort `high`, and Terra's effort defaults to `medium`. Any of those can move without warning, and none was ever PaperLume's decision. Every adapter therefore states its reasoning configuration explicitly, **including where it happens to equal the provider's current default**, and a permanent test pins that for each provider.
- **The approved Automatic matrix.**

  | Model | Analyze | Organization suggestions |
  |---|---|---|
  | Gemini 3.5 Flash | minimal | medium |
  | Gemini 3.6 Flash | minimal | medium |
  | Gemini 3.7 Flash | low | medium |
  | Gemini 3.8 Flash | low | medium |
  | Claude Sonnet 5 *(future row)* | off | medium |
  | GPT-5.6 Terra *(future row)* | none | medium |

  The four Gemini rows carry this metadata from migration `20260912120000`. The Sonnet 5 and Terra rows **do not exist**, and their values are recorded as future staging values only.
- **The catalog is the capability authority.** `ai_model_catalog` gains `reasoning_levels` (the ordered manual levels this model supports, which is also the UI order), `auto_analyze_reasoning_level`, `auto_suggest_reasoning_level` and `reasoning_selectable`. That last flag controls whether users may **newly** choose a manual level; it is the reasoning analogue of `selectable` and says nothing about whether reasoning exists. CHECK constraints close the vocabulary to exactly `minimal | off | none | low | medium | high | xhigh | max`. They also forbid duplicates and NULL elements, require every non-NULL Automatic level to be one its own model supports, and require a selectable control to have levels plus both Automatic levels. `provider` stays unconstrained and no model-string allowlist exists anywhere, per C33/C39.
- **`automatic` is not a reasoning value.** `user_ai_preferences.preferred_reasoning_level` is `NULL` for Automatic, and the literal `'automatic'` is refused by the database and by the setter. No preference row still means PaperLume's default model **and** Automatic reasoning.
- **Manual applies to both operations.** One control. `Reasoning level = High` means `analyze-paper` at high **and** `suggest-paper-organization` at high. There is no per-operation manual setting.
- **PaperLume's default model implies Automatic reasoning.** Manual reasoning requires a pinned model (`model_required`), because PaperLume may change its default model server-side and a level saved against "whatever the default is" could silently become invalid. Settings renders the control disabled on PaperLume default and explains why, in visible text.
- **Model and reasoning move together.** `set_current_user_ai_model` locks the caller's preference row, then re-validates a saved manual level against the NEW model and writes the pair **under that lock** (see *Preference writes serialize on one row*, below). A level the new model lists is preserved; one it does not is reset to NULL, and the additive `reasoning_reset` result reports it so Settings can say so. The check is **membership in `reasoning_levels`**, not `reasoning_selectable`, matching how `selectable` treats a saved model. `clear_current_user_ai_model` still deletes the row, so returning to the default model also returns reasoning to Automatic.
- **Preference writes serialize on one row.** One transaction is not enough under READ COMMITTED: a plain read takes no lock, so another writer can commit between a setter's read and its write. Both setters therefore take `FOR UPDATE` on the caller's `user_ai_preferences` row before they decide anything.
  - `set_current_user_ai_reasoning` takes it before reading the model the row names and holds it through validation and the write. A level can never be validated against one model and stored against another, and `saved = true` can never describe a row that was deleted in the meantime.
  - `set_current_user_ai_model` takes it before reading the saved level, so a concurrent clear cannot be undone and a concurrent manual choice cannot be silently overwritten. With no row to lock it inserts with `ON CONFLICT DO NOTHING`. If another call created the row first, it locks that row and decides again: at most three passes, then a retryable `40001`.
  - A final write that lands on no row raises `XX000` instead of reporting success.
  - That one row is the only thing any of the four preference RPCs locks, so they cannot deadlock one another. The two-session proof is the `db-tests` preference-lock probe: both orders of each race, forced and free-running.
- **Runtime resolution fails open, with three distinct outcomes.** [`_shared/aiReasoningPolicy.ts`](../supabase/functions/_shared/aiReasoningPolicy.ts) is the single shared implementation. It reads the effective model's catalog row by the `(provider, provider_model)` UNIQUE key, which also works for the system default because it has no catalog id.
  - **Manual:** a saved level that the effective model lists, honoured **only** when model selection honoured the saved preference. Every model-selection fallback drops it.
  - **Automatic:** the model's own level for this operation. A saved level the model no longer lists falls back here with one bounded warning, is never sent, and is never rewritten from the runtime path.
  - **`provider_default_fallback`:** unusable metadata — a failed read, a missing row, a malformed list, or an Automatic level its own model does not support. The adapter omits the reasoning parameter for that request only. This is a fail-open compatibility path with its own `source` and bounded reason, and it is never reported or logged as a level PaperLume chose.
- **Provider mappings** (verified against current first-party documentation, 2026-09-12):
  - Google: `generationConfig.thinkingConfig.thinkingLevel`, with lowercase `minimal|low|medium|high`. 3.7/3.8 reject `minimal`, which is a per-model fact kept in the catalog rather than in code. The legacy numeric `thinkingBudget` is never sent.
  - Anthropic: `off` → `thinking: {type: "disabled"}` **plus** `output_config.effort: "low"`, because effort "applies to every output token … whether or not thinking is enabled". Disabling thinking alone would keep the `high` default output policy, and the lowest effort also keeps the pairing valid under Anthropic's rule that disabled thinking at `xhigh`/`max` is a 400 on Opus 5 and later. `low|medium|high|xhigh|max` → `thinking: {type: "adaptive"}` plus `output_config.effort: <level>`. `effort` is a **sibling** of `output_config.format`, so structured output is never overwritten. Manual `budget_tokens` is never sent.
  - OpenAI: `reasoning: {effort: none|low|medium|high|xhigh|max}` verbatim, alongside `store: false` on every request.
  - In every case, `provider_default` omits only the reasoning field.
- **Provider types are narrower than the canonical vocabulary.** `AiProviderAdapter<Provider, Level>` has no default for either parameter, and each adapter declares its own level union: Google `minimal|low|medium|high`, Anthropic `off|low|medium|high|xhigh|max`, OpenAI `none|low|medium|high|xhigh|max`. Handing Google `off`, Anthropic `minimal`, or OpenAI `off` is a compile error, proven by type-level negative controls. A runtime guard (`supportsReasoningLevel`) in the one shared dispatch, `generateWithRegisteredAiProvider`, narrows each request. If catalog metadata ever lists a level the protocol lacks, the request degrades to `provider_default` rather than spending a quota unit on a 400.
- **Operation-owned output ceilings.** `analyze-paper` = 4096 and `suggest-paper-organization` = 8192, as Anthropic `max_tokens` and OpenAI `max_output_tokens`. On both providers the ceiling bounds reasoning plus answer, so it is also what keeps `max` bounded. These are safety ceilings, not expected usage, and they replace 001B's provisional flat 4096. Adapters no longer name a number, so none has to infer which operation called it. **Gemini is sent no ceiling**, exactly as before: nothing in the current Gemini semantics makes one necessary, and Automatic moves Analyze's reasoning *down*.
- **Reasoning content never crosses the boundary.** Adapters return only user-facing text. Anthropic `thinking`/`redacted_thinking` blocks and OpenAI `reasoning` items are ignored, never logged, persisted or returned to the browser. "Reasoning level" controls hidden provider reasoning and authorizes no chain-of-thought display. No reasoning *preference* is sent to a provider either: it becomes a request parameter, never user metadata.
- **Registration.** `registeredAiProviders()` is `google`, `anthropic`, `openai`, and the Settings `SUPPORTED_PROVIDERS` moved with it. A valid, enabled `anthropic`/`openai` catalog row is now **honoured** rather than refused on provider family. An unregistered provider still falls back with `unsupported_provider`.
- **Credential binding.** One reviewed mapping, [`_shared/aiProviderCredentials.ts`](../supabase/functions/_shared/aiProviderCredentials.ts): `google` → `GEMINI_API_KEY`, `anthropic` → `ANTHROPIC_API_KEY`, `openai` → `OPENAI_API_KEY`. Both operations read **exactly the selected provider's** variable and no other. There is no generic `AI_API_KEY`, and no credential name lives in the catalog. The operation-specific missing-secret semantics are preserved:
  - `analyze-paper` checks the credential after the quota unit, as before, so a missing one refunds.
  - `suggest-paper-organization` still checks before the quota unit, so a missing one costs nothing. The check moved from before model selection to after it, because which credential to check now depends on the selected provider.
  - Logs name the missing variable, never a value.
- **Account export v3.** `preferred_reasoning_level` is user-owned portable data, so `data/user_ai_preferences.json` includes it, with Automatic serialized as JSON `null`. Because this reshapes an existing archive file, `ACCOUNT_EXPORT_VERSION` goes 2 → 3. The global catalog, including its reasoning metadata, stays excluded.
- **Quota is unchanged.** One successful AI invocation is one existing PaperLume quota unit at every reasoning level. There are no weighted credits, and plan quotas and pricing are untouched. Usage and cost telemetry belong to `AI-MULTI-PROVIDER-001D`.

**Staging — nothing is activated by this decision.** Five locks applied, and each alone kept manual reasoning and non-Google providers unreachable. **All five have since been released**, each by its own separately authorized step: locks 3, 4 and 5 by `AI-MULTI-PROVIDER-001E` and the Phase 6 deploy, and locks 1 and 2 — the manual-reasoning pair — together by `AI-MANUAL-REASONING-001` (C45) on 2026-09-19:

1. `reasoning_selectable = false` on every catalog row. *Released 2026-09-19: `20260919075655` set it true on all six rows.*
2. `set_current_user_ai_reasoning` holds **no EXECUTE grant for any role**, `authenticated` included, and a replay-time self-check fails if one appears. Only `clear_current_user_ai_reasoning`, which can only remove a manual choice, is granted. *Released 2026-09-19: the same migration granted EXECUTE to `authenticated` and to no other role.*
3. No `anthropic/*` or `openai/*` catalog row exists. *Released 2026-09-18: `20260917201856` staged both rows.*
4. No `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is installed. *Released 2026-09-18: both credentials were installed for the Phase 7 canaries.*
5. No generation Edge Function was deployed. *Released 2026-09-17: the Phase 6 deploy put the 001C runtime live (`analyze-paper` v27, `suggest-paper-organization` v11), so Gemini requests now carry the Automatic reasoning level.*

The missing grant was deliberate. Creating user-owned reasoning data before the merged application contained the matching export, UI and runtime would have been the ordering error. A later, separately authorized user-enablement migration flips `reasoning_selectable` and grants EXECUTE **together** — which is exactly what `AI-MANUAL-REASONING-001` (C45) did. Its migration `20260919075655` was reviewed, merged and **applied to Production on 2026-09-19**, releasing locks 1 and 2 in one transaction.

**Migration-before-merge dependency.** The merged frontend and export read the new columns, so the 001C pull request **must not be merged until migration `20260912120000` has been separately authorized, applied to Production, and verified while the old application is still live**. The migration is additive and backward compatible with the deployed app: the new columns are unread by it, the new preference column is nullable with no backfill, the model setter only gains a result column, and the two new functions are uncalled. Applying it alone activates nothing. Order: approve the exact PR head → authorize and apply the migration → verify the old app → merge. See [deployment.md](deployment.md) §6.6. **Status: satisfied, then merged.** `20260912120000` was applied to Production on 2026-09-12 and verified with the old application still live, and the pull request (#280) merged on 2026-09-13, so the 001C schema and frontend are live. The generation Edge rollout followed on 2026-09-17, and manual reasoning was activated on 2026-09-19 by `AI-MANUAL-REASONING-001` (C45).

**An approved behaviour change for Gemini, stated plainly.** Before the 001C runtime deployment, Production sent Gemini no explicit thinking level, so both operations ran at Google's `medium` default. The Phase 6 deployment on 2026-09-17 changed that as approved, and it is **live in Production today**:

- Analyze sends `minimal` (3.5/3.6) or `low` (3.7/3.8).
- Suggest sends `medium`, now stated explicitly.

That is intended product behaviour, not a regression. 001C is **not** Google behaviour-equivalent, unlike 001A. The fail-open `provider_default` path does reproduce the pre-001C request byte-for-byte (golden SHA-256 `3285186f…`).

**Relationship to C39 and C40.** C40's re-evaluation trigger fires here: 001C sets the per-operation reasoning and output policy and binds each provider to its own credential, so registration is now correct. C39's seam is unchanged in shape. Adapters still own protocol, operations still own product semantics, and the reasoning policy is a third shared module rather than a responsibility of either.

**Rationale:** A reasoning level is the largest single lever on a model's latency and cost, and on the paid providers it also decides whether a bounded answer fits its output ceiling. Leaving it to each provider's default would make PaperLume's behaviour, cost and correctness a function of three external release schedules. Putting the policy in reviewed catalog data keeps model capability where C33/C35 keep model identity: a migration changes it and a frontend deploy does not. Validating manual choices against the model, atomically on model change and again at runtime, keeps an invalid model/reasoning pair out of both the table and the wire. Staging every activation lock off lets the schema reach Production ahead of the application without creating data or behaviour nothing can yet honour.

**Scope, explicitly.** 001C added no Sonnet/Terra catalog row, no secret, no deploy and no live provider call, and its one migration reached Production only through its own separately authorized step (2026-09-12). It added no token/cost telemetry, prompt caching, pricing or quota weighting, and changed no prompt, no suggestion cap (3/5/2/3, 400-character reasons) and no transport policy: Gemini's 90 s / zero-retry policy — a bounded diagnostic when 001C was written, permanent since 2026-09-19 (C46) — and 60 s / one attempt for Anthropic and OpenAI, are all untouched. No provider SDK was added.

**Re-evaluation trigger:**
- The catalog-staging migration for Sonnet 5 / Terra, which must carry the future values above.
- The user-enablement migration that flips `reasoning_selectable` and grants the setter. *Fired and resolved: `AI-MANUAL-REASONING-001` (C45) prepared exactly that migration for all six models, and `20260919075655` was applied on 2026-09-19.*
- `AI-MULTI-PROVIDER-001D` usage telemetry showing a ceiling or an Automatic level is wrong for real traffic, or that Gemini needs an explicit output ceiling.
- A provider changing its reasoning vocabulary, default or field path, which requires re-reviewing that adapter's mapping and possibly the catalog rows.
- Any proposal to express Automatic by omitting a provider parameter, which this decision forbids.

## AI provider telemetry (2026-09-13)

### C42. AI provider usage and cost telemetry is server-written, content-free and provider-reported; its money figure is a list-price estimate, and unknown is never zero (2026-09-13)

**Decision:** Every PaperLume AI operation that reaches a provider records **one** durable event in `public.ai_provider_usage_events` (migration `20260913120000`, `AI-MULTI-PROVIDER-001D`). The event states which provider and public model served it, which operation it was, the reasoning decision behind it, how many real provider requests it made, what the provider **itself reported** about token usage, and a **list-price cost estimate** with the exact rates that produced it. It stores no content. It is written only by the server, cannot be read or written by any browser, never changes what the user receives, and is deleted with the account.

Specifically, and durably:

- **One event per provider-call sequence, not per HTTP request.** An event exists exactly when `generateWithRegisteredAiProvider` was called. `provider_attempts` (1–10) counts the real requests inside it, so the schema stays correct whether a transport retries or not; the Gemini 90 s / zero-retry policy (permanent since 2026-09-19, C46) is neither assumed nor changed. A request refused before the provider — missing auth, a malformed body, a title-only or foreign paper, a PaperLume `402`, a missing provider credential — records nothing: those are not provider usage.
- **Two outcomes, deliberately separate.** `provider_outcome` is the adapter's bounded result (`completed`, `http_error` with its status, `network_error`, `timeout`, `unreadable_response`, `empty_response`, `incomplete_response`); `operation_outcome` is whether the user got a result. A provider that completed and whose answer PaperLume could not parse is `completed` + `failed`, and **its usage is kept**: the provider did the work. The quota refund for that case is unchanged — provider cost and PaperLume quota are different ledgers.
- **Usage crosses the adapter seam as sanitized, provider-neutral facts.** `AiProviderResult` gains a required `usage` on both branches ([`_shared/aiUsage.ts`](../supabase/functions/_shared/aiUsage.ts)). No provider usage object, envelope or field name leaves an adapter, and no operation branches on usage. Each dimension is **reported**, **unreported** or **not applicable**, and a whole report is `unavailable` when the provider gave none (`not_returned`) or gave one that failed validation (`invalid`). A count must be a non-negative safe integer ≤ 100,000,000; one impossible value discards the whole report rather than a single field.
- **The canonical dimensions nest; they are never summed.** `input_tokens` includes the two **disjoint** subsets `cached_input_tokens` and `cache_write_input_tokens`; `output_tokens` includes `reasoning_output_tokens`; `provider_total_tokens` is stored exactly as reported and never used. A shared finalizer refuses any report in which a subset exceeds its parent, and the table's CHECK constraints refuse the same rows again.
- **Provider mappings** (first-party documentation, read 2026-09-13):

  | Provider | Source field | Canonical dimension | Semantics |
  |---|---|---|---|
  | Google | `usageMetadata.promptTokenCount` | input | "includes the number of tokens in the cached content" |
  | Google | `cachedContentTokenCount` | cached input | subset of the prompt |
  | Google | — | cache-write input | not applicable: no such dimension |
  | Google | `candidatesTokenCount` + `thoughtsTokenCount` | output | disjoint counts; the price row is "Output price (including thinking tokens)" |
  | Google | `thoughtsTokenCount` | reasoning output | subset of output |
  | Google | `totalTokenCount` | provider total | the REST reference says prompt + thoughts + candidates and the proto comment says prompt + candidates, so either sum is accepted and any other value rejects the report. Neither source counts tool-use prompt tokens in it, so they are added to neither sum |
  | Google | `toolUsePromptTokenCount` | none — a positive count raises the unmodeled-usage flag | "Number of tokens present in tool-use prompt(s)". Google documents no relationship to `promptTokenCount` or `totalTokenCount`, so it is added to no dimension and to no total. PaperLume sends no tools |
  | Anthropic | `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` | input | Anthropic's documented total; `input_tokens` alone is only the input after the last cache breakpoint. Unreported unless all three are reported |
  | Anthropic | `cache_read_input_tokens` | cached input | subset |
  | Anthropic | `cache_creation_input_tokens` | cache-write input | subset; a write outside the default 5-minute bucket is flagged unmodeled |
  | Anthropic | `output_tokens` | output | "the inclusive, authoritative total used for billing", thinking included |
  | Anthropic | `output_tokens_details.thinking_tokens` | reasoning output | ≤ `output_tokens` |
  | Anthropic | — | provider total | not applicable: none is reported |
  | OpenAI | `input_tokens` | input | all input |
  | OpenAI | `input_tokens_details.cached_tokens` | cached input | subset |
  | OpenAI | `input_tokens_details.cache_write_tokens` | cache-write input | subset, disjoint from cached ("input tokens use the uncached-input, cached-input, or cache-write rate") |
  | OpenAI | `output_tokens` | output | reasoning tokens "are billed as output tokens" and are counted inside it |
  | OpenAI | `output_tokens_details.reasoning_tokens` | reasoning output | subset |
  | OpenAI | `total_tokens` | provider total | as reported |

- **Absence has a protocol meaning only on Google.** Every `UsageMetadata` count is a proto3 `int32` with implicit presence, and ProtoJSON omits a default value, so inside a present `usageMetadata` a missing count is the wire spelling of 0. Two guards make that honest: the prompt and total must be positive, and the total must equal one of its two documented sums, which is what stops a renamed or missing output count from reading as a false zero. Tool-use prompt tokens are part of neither sum: a report whose total balances only once they are added is refused as `invalid`, never reconciled. A positive tool-use count only sets the unmodeled-usage flag — the reason an otherwise calculable estimate is then `estimated_lower_bound`. On Anthropic and OpenAI (JSON APIs) absence is **unreported**, never zero. A missing usage block is no report on every provider, and a network error, timeout, HTTP error or unreadable body always carries **no** usage.
- **Usage is preserved wherever the provider supplied it**: on success, on `empty` (a blocked answer still consumed its prompt) and on `incomplete_response` (a truncated or declined generation was still billed).
- **The money figure is a list-price estimate, and is named as one.** `list_price_estimate_usd` is the request's cost at the provider's published **standard paid-tier list price** for the usage the provider reported. It is **not** an invoice, a charge or actual spend: PaperLume has no billing evidence, and the Google project runs on the Gemini Free Tier (C29), where the same request may cost nothing. **Free-tier status is a fact about an account, not a price of $0**, and no record prices anything at zero because of it.
- **Cost statuses, decided before any amount exists:**
  - `usage_unavailable` — no trustworthy usage. No amount, and specifically **not zero**: a timeout means PaperLume stopped waiting, not that the provider stopped working.
  - `usage_incomplete` — a separately priced dimension (input, output, cache reads, cache writes) was not reported.
  - `unpriced` — no verified record covers this provider model at this instant, the input exceeds the record's prompt-size tier, or tokens fall in a rate class the record does not price. They are never priced at another class's rate.
  - `estimated` — exact for the reported usage, nothing known missing.
  - `estimated_lower_bound` — the same exact arithmetic, but more than one attempt happened (only the last attempt's usage is visible) or the provider reported billable work in a dimension these columns do not price.
- **The formula, exact.** `(input − cached − cache_write) × input_rate + cached × cached_rate + cache_write × cache_write_rate + output × output_rate`, per million tokens. Rates are decimal strings parsed to integer nano-dollars and multiplied as integers, so no floating point touches money; the amount is `numeric(24,15)` and the row's own CHECK re-proves it exactly from its stored tokens and rates.
- **Pricing is versioned, and history cannot drift.** List prices live in an append-only, effective-dated book, [`_shared/aiPriceBook.ts`](../supabase/functions/_shared/aiPriceBook.ts). Each record has an id (`<provider>/<model>@<date>`), an inclusive/exclusive UTC validity window, its source URL and verification date; windows for one model never overlap, and a price change is a **new record**, never an edit. Every estimated row copies the record id **and** all four rates onto itself, and a CHECK requires the record to name the row's own provider model. A later price change therefore re-prices nothing that was already recorded.
- **The seeded book is exactly what was verified.** Gemini 3.5 Flash ($1.50 in / $0.15 cached / $9.00 out) and Gemini 3.6, 3.7 and 3.8 Flash ($0.75 / $0.075 / $3.75 through 2026-12-31, then $1.50 / $0.15 / $7.50), from `https://ai.google.dev/gemini-api/docs/pricing` (page last updated 2026-09-11 UTC), valid from 2026-09-13. Google names no timezone for the 2027 change, so the 2026 record ends at the first instant it is January 1 anywhere (2026-12-31T10:00Z) and the 2027 record starts at the last instant it is still December 31 anywhere (2027-01-01T12:00Z); an event in that window is honestly `unpriced`. The floating `gemini-flash-latest` alias is unpriced because PaperLume cannot see what it resolves to. **No Anthropic or OpenAI price is recorded**: neither provider is routeable, and their records belong to the paid-provider staging phase, re-verified on that day.
- **Server-trusted persistence, as narrow as the architecture allows.** The table has RLS enabled and forced and **no policy**; `PUBLIC`, `anon` and `authenticated` hold nothing, and `service_role` holds `INSERT` alone — it cannot read events back, rewrite, delete or truncate them. A policy of `user_id = auth.uid()` would have proved ownership, not truthfulness, so no browser write path exists at all. The writer ([`_shared/aiUsageTelemetry.ts`](../supabase/functions/_shared/aiUsageTelemetry.ts)) builds a client lazily, only after a provider call, from the platform-injected secret key (the same `selectEdgeSecretKey` rule `delete-account` uses), with no caller Authorization header, no session and a 5-second write bound. Its type exposes one `insert` into this one table. Model selection, entitlement, quota and every product read stay on the caller-authenticated client, and the key never reaches a provider adapter or the browser.
- **Observational, never a success gate.** Recording happens after the operation's outcome is decided, on both the success and failure paths, and the recorder never throws. A failed or impossible write is one bounded log line (`usage_telemetry recorded=0 reason=… code=<SQLSTATE>`); the generated result, the provider failure the user sees, the status code and the quota refund are unchanged. A stricter "no record, no generation" gate would be a spending-control decision, not this foundation's.
- **Content-free by construction.** The row's only strings are the server-derived user id, bounded enums, public provider/model names (CHECK-constrained to identifier shapes that admit no spaces, `@` or quotes), a price-record id and decimal rates. No prompt, title, abstract, keyword, Project, Tag, id of either, generated text, provider body or error, email, token, key, session or URL can be stored. New log lines name the operation, provider, public model, outcome, attempts and statuses — never the user id or a database error message.
- **Deleted with the account.** `user_id` cascades from `auth.users`, so no pseudonymous usage trace survives a hard deletion. Retention beyond deletion would be an owner/privacy decision, and none has been made. The table is excluded from the account-export archive (server-written accounting, unreadable by the client, like `usage_counters`). The published Privacy Policy (effective September 17, 2026) states that exclusion, and that a user may request access to the information about them in these records, subject to applicable law ([privacy-data-flow-audit.md](privacy-data-flow-audit.md) §29).
- **Quota is unchanged.** One successful AI invocation is still one PaperLume AI quota unit regardless of provider, model, reasoning level, tokens or estimate. Nothing reads telemetry to decide anything.

**Staging.** Current state:
- The 001D repository implementation is merged.
- Migration `20260913120000` has been **live in Production since 2026-09-13**; the table stayed empty until Phase 6.
- The owner-approved **Privacy Policy disclosure is published**, effective September 17, 2026.
- **Runtime telemetry is live.** Both generation functions were deployed together on 2026-09-17 from `main` `f962b44d` (Phase 6: `analyze-paper` v27, `suggest-paper-organization` v11), and each provider call they make writes one event (a failed write is logged, never retried, and never changes the response).
- **The Phase 6 Gemini acceptance passed** with three content-free events: an Analyze success, a Suggest Google HTTP 503 recorded with unknown usage and refunded, and a Suggest success on the one permitted retry. Each was logged `recorded=1`, and both estimates recompute exactly ([deployment.md](deployment.md) §6.7).
- No telemetry UI exists, and nothing reads telemetry to decide quota, entitlement, pricing or access.
- Paid providers went live on 2026-09-19 (C43), and manual reasoning went live the same day (C45), so telemetry now records `reasoning_source = manual` alongside `automatic` — a user's own choice, not residue. Both columns existed from the start; activation changed which values appear, not the schema.

Every step in that sequence — paid-provider staging, credentials and canaries, then user enablement, and finally manual-reasoning activation — was separately authorized ([deployment.md](deployment.md) §6.6a, §14, §15).

**Rationale:** PaperLume is about to route to providers whose token accounting, caching and reasoning billing differ. Measuring that honestly has to exist before money is spent, and it has to be trustworthy: a browser-writable table would let anyone forge cost, a mutable price table would silently rewrite history, and a dashboard-shaped `0` in place of "unknown" would understate exactly the failures — timeouts, truncated generations — that cost money without producing anything. Keeping usage behind the adapters preserves C39, and keeping the estimate out of every decision keeps telemetry from becoming a second, unreviewed commercial policy.

**Scope of the 001D implementation, explicitly.** It made no Production migration (the migration was applied later, as its own authorized step), and no Edge deployment, secret, live provider call, paid-provider catalog row, reasoning activation, quota or billing change, telemetry UI or external analytics service. The Gemini transport diagnostic, prompts, parsers, suggestion caps and output ceilings are untouched; the Google request bytes are unchanged (golden SHA-256 `e26b9bca…`).

**Re-evaluation trigger:**
- A provider changes a usage field, its inclusion semantics or its price: re-verify that adapter's reader and add a new price record (never edit one).
- The paid-provider staging phase: add verified Anthropic/OpenAI records then, not before.
- Retries return to any transport: `estimated_lower_bound` for multi-attempt calls becomes common, and per-attempt usage may need its own design.
- Prompt caching or tools are introduced: the unmodeled-usage flags start firing and the cache-write classes need real rates. For Gemini, first establish from first-party evidence how `toolUsePromptTokenCount` relates to `promptTokenCount` and `totalTokenCount`: until then, a report whose total includes tool-use tokens is refused as `invalid`.
- A spending limit or cost-based control is proposed: that is a new decision about using this data as a gate.
- An owner or legal decision on retaining telemetry beyond account deletion, or on including it in the export or a subject-access response.

## Paid provider activation (2026-09-17)

### C43. A paid provider is staged `enabled` but NOT `selectable`, canaried through an operator-written preference, and made selectable only afterwards (2026-09-17)

**Decision.** Bringing a paid AI provider to users is **three** separately authorized steps, not one: stage the catalog row, canary it, then make it selectable. `AI-MULTI-PROVIDER-001E` performs only the first, in the repository.

**The mechanism.** `ai_model_catalog.enabled` and `.selectable` are independent flags and this decision uses the gap between them:

- `enabled = true` — the **resolver** honours a saved preference naming the model, so a real request can reach the real provider through the real endpoints.
- `selectable = false` — the **setter** (`set_current_user_ai_model`) refuses the model with `model_not_selectable`, and the Settings control never lists it, so no ordinary user can acquire that preference.

The only way to hold such a preference is for an operator to write the `user_ai_preferences` row directly. That is precisely the bounded canary surface Phase 7 needs, and it is unavailable to everyone else by construction rather than by policy.

> **CORRECTION — 2026-09-18, from the Phase-7 run. A written preference alone does not route, and the shortfall is silent.**
>
> `resolveEffectiveAiModel` applies **three gates in a fixed order**, and the catalog is the *last* of them:
>
> ```text
> 1. entitlement   get_current_user_access() → can_select_ai_model must be true
> 2. preference    user_ai_preferences.preferred_model_id must exist and be well-formed
> 3. catalog row   ai_model_catalog: exists, enabled, provider has a registered adapter
> ```
>
> Entitlement is read **before** the preference. `can_select_ai_model` is `ai_model_selection_enabled AND plan_status IN ('active','trialing')`, and the dedicated acceptance account is a **free** account, where that column keeps its `DEFAULT false`. A preference written for it was therefore ignored with `fallback("not_entitled")` — a member of `QUIET_REASONS`, so **nothing is logged**. The request would have run on the Google system default, spent a quota unit, and recorded telemetry reading `provider = google`, while every log line looked healthy. A canary built on the preference alone would have "passed" without ever reaching the paid provider.
>
> **The corrected mechanism** (owner-approved, and the one the 2026-09-18 canaries used) adds a temporary capability grant on the **same single acceptance account**, per provider block: capture the entitlement flag and the preference row → set `ai_model_selection_enabled = true` → write the preference → run the two operations → delete the preference → restore the flag → verify through both the operator connection and the account's own RLS session, on every exit path including failure. Full procedure in [deployment.md](deployment.md) §14.2.
>
> **This does not weaken the decision below.** `selectable` stays `false` throughout, so no other user's reachable set changes at any moment, and the capability is restored immediately after the block. What the correction shows is that "what is choosable" and "who may choose" are **both** gates on the route to a provider — the canary has to satisfy both, and it must do so without redefining either. Changing `can_select_ai_model`'s meaning, granting the capability to a real user's account, or adding an operator allowlist to the resolver all remain forbidden.
>
> One field cannot be restored: `user_entitlements` has a `BEFORE UPDATE` trigger, so that row's `updated_at` moves and stays moved. Restoration is proven on the substantive columns instead.

**Why not canary with `selectable = true` and revert.** Because the window is real. Between the flip and the revert, every entitled user can select an un-canaried paid model, and any preference saved in that window **survives the revert** — `enabled` still routes it. A "brief" exposure would therefore be permanent for whoever used it.

**Why not a code-level operator allowlist.** It would be a second authorization surface that could disagree with the catalog, which C33/C35/C39 exist to forbid. The preference row is already the authorized mechanism; it needs no new code.

**What the staged rows are** (as staged on 2026-09-18; `selectable` became `true` at Phase 8 on 2026-09-19 and nothing else about them moved). `anthropic/claude-sonnet-5` (sort 50) and `openai/gpt-5.6-terra` (sort 60), each `enabled`, then-not-`selectable`, `reasoning_selectable = false`, carrying its own provider vocabulary (C41): Anthropic `{off,low,medium,high,xhigh,max}` with Analyze `off`; OpenAI `{none,low,medium,high,xhigh,max}` with Analyze `none`; Suggest `medium` on both.

**What it explicitly is not.** Not manual reasoning (C41's staging lock holds: no row is `reasoning_selectable`, and `set_current_user_ai_reasoning` stays ungranted). Not an entitlement change — `can_select_ai_model` decides **who** may choose, and this decides **what** is choosable. Not a system-default change (C34). Not a Google change.

**Phase 8 — DONE, 2026-09-19. The decision is now fully executed.** Staging completed 2026-09-18 (`20260917201856`); the paid canaries passed the same day, one attempt per operation; the Edge-log privacy hardening that gated broad activation was merged and deployed the same day. Phase 8 then applied `20260918210017` (ledger 84 → 85), setting `selectable = true` on both rows and changing **nothing else** — not `enabled`, not the reasoning metadata, not the system default, not the manual-reasoning grant. Both paid models are now offered to entitled users; the four Google rows are byte-unchanged; and no preference or entitlement row was written, so nobody was migrated onto a paid model. **Manual reasoning was separately staged off by this phase** — when Phase 8 finished, `reasoning_selectable` was false on all six rows and `set_current_user_ai_reasoning` was granted to nobody. That remained a distinct decision, and it became C45: `AI-MANUAL-REASONING-001` applied the activation migration for all six rows later the same day, so those two clauses describe 001E's own scope, not Production today.

The three-step shape this decision established — **stage → canary → activate**, each separately authorized — held end to end and is the reusable recipe for any future paid model. So is the canary-entitlement correction above: the resolver checks entitlement before it reads a preference, and that is a property of the runtime, not of these two rows.

**Trigger to revisit.** A provider withdrawing a model or changing its reasoning vocabulary; a price change (the price book is effective-dated, so this is a new record, never an edit); or evidence that the operator-preference canary route is reachable by a non-operator.

### C44. A price dimension with two published rates and one reported number is left unpriced, never priced at the cheaper one (2026-09-17)

**Decision.** `aiPriceBook.ts` holds a single `cacheWriteInputUsdPerMTok` per record. Where a provider publishes **more than one** cache-write rate and the adapter cannot always tell which applied, the rate is `null` — making any positive cache write `unpriced` — rather than a plausible guess.

**Applied.** Anthropic publishes $2.50/MTok for a 5-minute cache write and $4.00/MTok for a 1-hour one, and `readAnthropicUsage` maps the **flat** `cache_creation_input_tokens` (documented as the sum over both buckets) into one dimension. The per-TTL `cache_creation` breakdown that would split them is only **conditionally** present in Anthropic's response. So the `unmodeledUsage` flag — which is raised *from that breakdown* — reads `false` in exactly the case where the split is unknowable, and a $2.50 rate would return a confident `estimated` for an unknown mixture. `null` fails closed instead.

**Not applied to OpenAI.** OpenAI publishes one cache-write rate (1.25x input = $2.50/MTok) and reports the dimension in its own `input_tokens_details.cache_write_tokens` field. One rate, one unambiguous count: it is priced.

**Corollary for prompt-size tiers.** `openai/gpt-5.6-terra` stops at `maxInputTokens = 272_000`, because above it OpenAI applies 2x input **and** 1.5x output to the whole request — two multipliers the four-rate record shape cannot express. A larger request is `unpriced`, never priced at the short-context rate.

**The through-line.** Both are the same rule the module was built on: unknown is never zero, and a cheaper-than-true number is worse than no number, because a number gets believed.

## Manual AI reasoning activation (2026-09-19)

### C45. Manual reasoning activates for every currently selectable model at once, through one migration that flips the catalog flag and grants the setter together (2026-09-19)

**Owner decision.** Manual reasoning is to be user-selectable for **all six** models the catalog currently offers — Gemini 3.5, 3.6, 3.7 and 3.8 Flash, Claude Sonnet 5 and GPT-5.6 Terra — not for one provider first. The final intended state is `reasoning_selectable = true` on exactly those six rows.

**One migration, two changes, nothing else.** `20260919075655_activate_manual_ai_reasoning_selection.sql` sets the flag on exactly six ids and grants `EXECUTE ON FUNCTION public.set_current_user_ai_reasoning(text)` to `authenticated` — the two locks C41 staged, released **together**, because either alone is a half-open state: the flag without the grant offers a choice the database refuses, and the grant without the flag opens a write path every row still rejects.

**What it deliberately does not do.**
- It does not change PaperLume's **Automatic** policy. The per-model, per-operation matrix is exactly what C41 approved, Automatic stays the first option and the recommended one, and Automatic remains `preferred_reasoning_level = NULL`.
- It does not backfill. No existing user receives a level; everyone stays on Automatic until they choose.
- It does not change the column DEFAULT, which stays `false`: a **future** model starts closed until its own reviewed migration opens it. Nothing is activated by simply existing.
- It does not introduce a second entitlement. Manual reasoning uses `can_select_ai_model` — the same capability as model selection — with no plan-name comparison, allowlist, role bypass or browser gate, and `get_current_user_access()` is untouched.
- It does not change the system default (C34), any function body, the Edge runtime, any provider adapter, telemetry, quota or pricing. One successful AI operation remains one quota unit at every level.

**Why no code changes with it.** C41 built the whole feature behind the two locks, and C33/C35/C39 keep capability in reviewed catalog data rather than in TypeScript: the Settings control renders whatever `reasoning_levels` a row lists, the runtime reads `preferred_reasoning_level` and applies it to **both** operations, and the three adapters already express every level. So activation is data, and the only repository changes are tests, comments and documentation.

**Provider vocabularies, re-verified 2026-09-19.** Gemini 3.5/3.6 `minimal | low | medium | high`; Gemini 3.7/3.8 `low | medium | high` (both **reject** `minimal`); Claude Sonnet 5 `off` plus effort `low | medium | high | xhigh | max`; GPT-5.6 Terra `none | low | medium | high | xhigh | max`. The catalog matches each provider's current first-party documentation exactly. A vocabulary is never widened inside an activation task: a disagreement stops the task for an owner decision instead.

**Rollout posture — EXECUTED 2026-09-19.** The decision is now fully carried out, in the same stage-then-activate shape C43 established for paid providers: PR #291 merged as `96cca6fbe46651790aeffd6a278c65b653cc510b`, and one `supabase db push --linked` applied `20260919075655` (ledger **85 → 86**). Production now has `reasoning_selectable = true` on all six rows and `set_current_user_ai_reasoning` executable by `authenticated` only — the owner keeps its own right, and `anon`, `service_role` and PUBLIC cannot execute it. Nothing else moved: no preference was backfilled, no entitlement row was written, no Edge Function was deployed, no secret changed, and the system default is still Google (C34). The **same `can_select_ai_model` entitlement** remains the only authority over who may choose a model or a level, PaperLume's default model stays Automatic-only (the setter answers `model_required` with no pinned model), and the column DEFAULT stays `false`, so a **future** catalog row still starts closed until its own reviewed migration opens it.

**Bounded Production acceptance — PASSED 2026-09-19.** Six operations on the dedicated acceptance account, one attempt each, covering all three provider families: Gemini 3.5 Flash at `minimal` (Analyze), Gemini 3.8 Flash at `high` (Analyze), Claude Sonnet 5 at `low` (Analyze + Suggest) and GPT-5.6 Terra at `low` (Analyze + Suggest). Every one resolved `reasoning_source = manual` at the exact saved level. Claude and Terra are the load-bearing cases: one saved level overrode **both** halves of each Automatic split (`off`/`medium` and `none`/`medium`). Gemini 3.8 returned HTTP 503 — a **provider-availability exception, not a manual-reasoning routing failure**: the intended model and manual level reached the provider boundary, and that operation's quota unit was consumed and then refunded. Five successes consumed one unit each, so reasoning effort introduced no weighted quota accounting. The acceptance account was restored to its exact prior logical state afterwards ([deployment.md](deployment.md) §15.2).

**Trigger to revisit.** A provider changing a reasoning vocabulary, default or field path; telemetry showing a level users choose is systematically wrong for an operation; a future model needing its own activation (which is a new migration, never an inherited default); or any proposal to attach a manual level to PaperLume's default model, which C41 forbids because the default can move server-side.

### C46. Adopt 90-second single-attempt Gemini transport as the permanent policy (2026-09-19)

**Owner decision.** PaperLume KEEPS the Gemini transport behaviour currently in Production: a **90-second per-attempt timeout** and **ZERO automatic retries**. This is no longer a temporary Production diagnostic — it is the durable PaperLume policy for Gemini unless a future separately authorized decision changes it. The 30-second timeout and the two bounded retries are **not** to be restored.

**What the policy is.**
- `GEMINI_PROVIDER_TIMEOUT_MS = 90_000` — the per-attempt ceiling.
- `GEMINI_PROVIDER_MAX_RETRIES = 0` — no automatic retry of any kind.
- It applies to **both** Analyze and organization suggestions, because both go through the one [`_shared/geminiTransport.ts`](../supabase/functions/_shared/geminiTransport.ts). Neither function pins a policy of its own, and neither does the Google adapter.
- A timeout, an ordinary network failure, an HTTP 429 and an HTTP 5xx all **terminate after the one provider attempt**. No backoff is slept, because there is never a second attempt to sleep before.
- PaperLume's existing quota/refund semantics are unchanged and remain the caller's responsibility: the unit is consumed before the provider call, and on a provider failure the caller invokes the existing **best-effort** refund path, exactly as before. C46 changes no refund behaviour. That path deliberately swallows its own errors so a refund-side problem cannot replace the provider failure surfaced to the user, which also means a refund is **attempted**, not guaranteed — the transport itself performs no quota mutation.
- The policy is **Gemini-specific**. `anthropicAiProvider.ts` and `openAiProvider.ts` keep their own independent 60-second constants and single attempt; C39's rule that a shared *adapter contract* is asserted while a shared *transport policy* is not still holds.

**History — how this value was reached.**
- The established policy before this decision was a **30 s per-attempt timeout with two bounded retries** (backoff 2 s then 4 s), itself a correction of an original 15 s ceiling that a controlled probe had shown cutting off a valid HTTP 200 at 18,056 ms.
- Production then reached that 30 s ceiling on requests that had not failed: an Analyze and a Suggest request each logged `provider_timeout attempt=1 elapsed_ms=30004 retry=0`, while controlled direct probes of the same model completed the same PaperLume-shaped contracts in ~5-13 s.
- `AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A` changed the two constants to 90 s / zero retries as a **bounded Production experiment**, explicitly marked as temporary at the time.
- The owner has now **explicitly chosen to keep that resulting behaviour permanently**. Repository comments, test names and current-state documentation are reconciled to say so; the executable constants do not move.

**Rationale.**
- **One user action, at most one Gemini generation request.** A client-side timeout proves only that *we* stopped waiting — not that Google stopped generating. Automatically re-sending is how one click became two provider requests on 2026-08-31, moving Google's daily counter by two for a single user action.
- **No premature cancellation.** Thirty seconds was demonstrated to be capable of ending a request before a valid Gemini response arrived. Ninety seconds gives a slow provider request substantially more room.
- **Bounded execution is preserved.** Supabase documents a 150 s Free-plan wall-clock limit and a 150 s request idle timeout for hosted Edge Functions. At one 90 s attempt with no backoff the transport cannot exceed 90 s inside that envelope. Ninety seconds and two retries cannot both be had: that combination would allow 90 + 2 + 90 + 4 + 90 = 276 s.
- **Explicit failure over automatic duplicate generation.** A 429 or 5xx is surfaced after the first attempt rather than silently creating another generation request. PaperLume already invokes its existing best-effort refund path on provider failure, so automatic re-generation is not the mechanism used to repair quota accounting.

Ninety seconds is **not** claimed to be universally optimal. It is the owner's selected PaperLume policy on the accumulated evidence above.

**What this decision deliberately does not do.** It changes no runtime behaviour — the two constants are identical before and after. It does not delete the transport's generic retry/backoff branches, its `Retry-After` parsing or its backoff constants: those remain implemented but **dormant** at a budget of zero, so the policy lives in one constant rather than in a refactor. It imposes nothing on Anthropic or OpenAI, changes no prompt, model routing, reasoning level, output limit, telemetry schema or catalog row, and required no migration and no provider canary.

**Re-evaluation triggers.**
- Supabase documenting a different Edge execution or request-idle limit, in either direction — the 90 s ceiling is justified partly by fitting inside 150 s.
- Strong evidence that a 90 s wait causes unacceptable UX or infrastructure failures (users abandoning the operation, function-level resource exhaustion, or invocations killed by the platform rather than by our own ceiling).
- Provider-supported idempotency — a request key that makes a re-send provably not duplicate generation work — which is the condition that would make retries safe rather than merely convenient.
- A future owner decision to introduce a non-zero Gemini retry budget, which must include its own duration-budget review because 90 s and two retries do not fit together.
- Material changes in Gemini transport or API behaviour: latency distribution, streaming, error semantics, or `Retry-After` conventions.

### C47. AI quota refund is a server-only accounting reversal; consumption stays caller-authenticated (2026-09-24)

**The defect this closes.** `refund_ai_quota(uuid)` was executable by `authenticated`, and its only check was `p_user_id = auth.uid()`; after that it decremented the caller's `usage_counters.used` by one, unconditionally. Nothing tied a refund to a consumption, a failed provider call or any other earlier event. The grant existed because both generation functions refunded through the **caller-scoped** client — which also let any signed-in browser call `POST /rest/v1/rpc/refund_ai_quota` directly with its own id: consume, refund, consume again, without limit. That broke C3's "AI usage is never unlimited", and because Analyze and organization suggestions share one `ai_analysis` counter and one provider project, one account could spend the project's shared provider quota for everyone. The prerequisite was only a signed-up account. Reproduced only on a disposable local replay whose function body was byte-identical to Production; it was not intentionally exercised against Production. Whether any account independently abused the old path is not established. `SEC-AI-QUOTA-REFUND-AUTHORITY-001`.

**Decision.**
- **Consumption is the caller's.** `consume_ai_quota` stays `authenticated`-only with its `auth.uid()` guard, on the caller's client: spending your own unit is a capability a caller may always exercise. `service_role` cannot consume.
- **The refund is the server's.** `refund_ai_quota` is executable by `service_role` **only** — never `authenticated`, `anon` or PUBLIC — and its body no longer compares against `auth.uid()` (the server caller has none). Its target is supplied by trusted server code: the generation function's own `auth.getUser()` identity, never a request field. A NULL target is refused.
- **Every accounting rule is preserved.** Same signature (generated types unchanged), the monthly bucket when `ai_monthly_quota > 0`, else the lifetime bucket when `ai_lifetime_quota > 0` or the user is `ai_quota_exempt` (C28), the current UTC month, `GREATEST(used − 1, 0)`, and the tolerant `refunded = false` answers for a missing entitlement, bucket or counter. No quota number, plan or entitlement changes.
- **One narrow server client per job.** Both generation functions refund through [`_shared/aiQuotaRefund.ts`](../supabase/functions/_shared/aiQuotaRefund.ts): a client built from the platform-injected secret key (`SUPABASE_SECRET_KEYS["default"]`, then `SUPABASE_SERVICE_ROLE_KEY`, through the shared `selectEdgeSecretKey` rule), with no caller Authorization header and no session, a 5 s bound, and a type that allows exactly `rpc("refund_ai_quota", { p_user_id })`. The C42 telemetry writer is **not** widened to do it; it stays insert-only on one table.
- **Best-effort, with no caller fallback.** A refund is attempted only after an attempt that consumed a unit fails to deliver. A missing key, an RPC error or a thrown fetch is one bounded `<label> refund_failed …=1` line; the original response is unchanged. There is deliberately no fallback to the caller's client — that fallback would be the defect.
- **The authority flips atomically.** Migration `20260924193915` revokes `authenticated` before replacing the body and grants `service_role` after it, in one explicit transaction behind fail-closed preconditions that pin the reviewed body by digest. There is no committed state in which the server-style body is browser-executable.

**What it deliberately does not do.** It does not bind a refund cryptographically to a specific consumption (a reservation token); the server is trusted to refund only a unit it consumed and did not deliver. That stronger design remains available if the trust boundary ever has to shrink further. It does not narrow any other `service_role` privilege, and it grants `service_role` no other SECURITY DEFINER function — CI pins that `service_role` executes exactly this one. This is a security-boundary correction, not commercialization work, and it reopens none of C27/C29/C30.

**Rollout.** Migration first — it closes the browser path the moment it commits — then deploy **both** `analyze-paper` and `suggest-paper-organization` from the same merge commit. In between, the previously deployed functions' caller-scoped refunds are refused and logged; the original provider errors still surface and successful operations are unaffected. Rolling back is a **security** rollback that re-opens the defect, and needs the Edge Functions rolled back with it; prefer fixing forward. Procedure and verification: [deployment.md](deployment.md) §6.8.

**Trigger to revisit.** Any proposal to grant `refund_ai_quota` to a browser role or to add a caller-scoped refund path; a new server-side caller of the refund; evidence that server-side refunds are being issued without a failed, consumed attempt behind them (which would argue for the reservation-token design); or a platform change to how the secret key maps to `service_role`.

### C48. The assignment junctions are read-only to the browser; Projects and Tags themselves stay user-writable (2026-09-25)

**Status: LIVE in Production since 2026-09-25.** Migration `20260925134526_harden_junction_dml_grants.sql` implements it; PR #301 merged as `043efee0b9477537cf125fffc32434a89d0c5bb5`, and the migration-only rollout applied it on 2026-09-25 (ledger **87 → 88**; [deployment.md](deployment.md) §6.9). Live posture: `authenticated` holds `SELECT` only on `paper_projects` / `paper_tags`, and still `SELECT, INSERT, UPDATE, DELETE` on `projects` / `tags`; the six junction policies, the seven assignment/merge RPCs and `service_role` were verified unchanged. Before the rollout Production granted `SELECT, INSERT, DELETE` on both junctions, as C38 recorded. `DB-JUNCTION-DML-GRANT-HARDENING-001`, follow-up to C38.

**Two kinds of table, deliberately treated differently.**
- **The junctions** — `paper_projects` ("paper X is in Project Y") and `paper_tags` ("paper X has Tag Y") — become **SELECT-only** for `authenticated`. Every assignment write already went through a SECURITY DEFINER RPC: `set_paper_projects` / `set_paper_tags` (Edit Paper, including AI-suggestion acceptance), `bulk_set_paper_projects` / `bulk_set_paper_tags` (bulk actions and assignment on newly imported papers), `bulk_add_paper_projects` / `bulk_add_paper_tags` (additive assignment on resolved duplicate imports, including extension import) and `merge_exact_duplicates`. The direct `INSERT` / `DELETE` grants were a second write path no product code used. Since the 2026-08-02 relational-ownership remediation (`20260802025704`) that path has been constrained by both-owner RLS, so in C48's starting state it could not link across accounts — but it could still bypass the RPCs' own contracts: all-or-nothing validation, NULL-id refusal, replace-versus-add semantics. The repository-wide audit behind this decision found **zero** live browser, extension or Edge Function paths that write either junction directly.
- **The entities** — `projects` and `tags` — keep **`SELECT, INSERT, UPDATE, DELETE`**, unchanged. Creating, renaming, recolouring and deleting a Project or Tag is a normal browser write, and it has to stay one.

**AI-created Projects and Tags keep working, and the reason is structural.** The AI organization flow (C32) never wrote a junction. "Create & select" inserts the **entity** row into `projects` / `tags` immediately, through the same `createProject` / `createTag` mutation the Projects and Tags UI uses, and only stages the new id in Edit Paper's local selection; the paper's **assignment** is written by `set_paper_projects` / `set_paper_tags` when the user saves. Accepting an existing suggestion is local until Save, too. So this decision removes nothing that flow uses.

**Why the RPCs keep working.** All seven routines are SECURITY DEFINER and owned by `postgres`, so their junction writes are checked against the owner's privileges, not the caller's. `authenticated` needs EXECUTE on them, which is unchanged. The caller still reaches each body as `auth.uid()` (a JWT claim, not a session role), so every ownership check is unchanged. Referential actions behave the same way: deleting a Project, Tag or paper cascades to the junction as the junction's owner, so it never needed the browser's DELETE grant either.

**The junction RLS policies stay, as dormant defense-in-depth.** The both-owner SELECT / INSERT / DELETE policies are not dropped, replaced, broadened, narrowed or renamed. The INSERT and DELETE policies become unreachable to every browser role, because the object privilege refuses first; they are kept so a future re-grant — accidental or deliberate — lands on a both-owner boundary instead of an open table. Suite 002 proves them by re-granting inside its own rolled-back transaction, and that test-only grant must never appear in a migration.

**How it is enforced.** The migration is explicitly transactional and fail-closed: it pins the junctions' pre-state ACL (direct and effective), the entity tables' full ACL, the six junction policies by digest, RLS/FORCE RLS, the absence of browser-role column grants (a column-level INSERT would survive a table-level REVOKE) and all seven RPCs by owner, security mode, `search_path`, body digest and EXECUTE ACL; it then runs one `REVOKE INSERT, DELETE … FROM authenticated`, and refuses to commit unless the junctions are `SELECT`-only, everything else it pinned is unchanged, and the transaction wrote no row. Suites 000, 002 and 015 pin the result. An architecture test (`src/test/junctionWriteBoundary.test.ts`) scans the web app, extension and Edge Function TypeScript sources for direct Supabase `.from()` junction mutations — on the builder's own chain or through a same-file local alias of it — and fails closed on a mutated builder whose table it cannot resolve and on a bare junction builder that leaves its local view (argument, return, export). It is a review-time tripwire, not a proof over every possible code path: it does not follow a builder across files or see a hand-built REST request, and the database ACL remains the enforcement. The runtime proof for the important workflow is the integrated Edit Paper test, which drives the real AI "Create & select → Save" path against a client that refuses junction writes the way PostgREST will, and the E2E network assertions.

**What it does not do.** It does not touch `service_role` (preserved and snapshot-compared, per C38), function EXECUTE, any other table, or any data.

**History — C48 is not the cross-owner fix.** The direct junction grants were not always protected this way. Before `20260802025704`, the junction policies checked **paper** ownership only, and cross-owner insertion into both `paper_projects` and `paper_tags` was a confirmed defect — reproduced on a replay of that schema and recorded with the other PFA-C03B1 findings ([pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md) §9.6). `20260802025704` closed it by making the SELECT / INSERT / DELETE policies both-owner and by validating both owners inside the setter RPCs; that record stands unchanged. C48 is a later least-privilege follow-up: it removes the direct write authority that remained after that remediation and that no product path uses. It is not an incident response in the sense that it answers no newly discovered live cross-account path. It makes no claim either way about whether the pre-2026-08-02 defect was ever exercised by a real account; that is not established.

**Re-evaluation triggers:** a product path that genuinely needs to write a junction row outside the reviewed RPCs (add a reviewed RPC rather than re-granting); a change to the assignment RPCs' security mode or ownership (the SELECT-only junction relies on them being SECURITY DEFINER and owner-privileged); a proposal to drop the dormant policies; or `service_role` least-privilege work, which would revisit the junctions' server-side grant separately.

## Least-privilege function authority (2026-09-26)

### C49. Caller-scoped read RPCs that need no elevated authority run as SECURITY INVOKER; ordinary table ACL + RLS is their primary boundary (2026-09-26)

**Status: LIVE in Production since 2026-09-26.** Migration `20260926152414_harden_read_rpcs_security_invoker.sql` implements it (`DB-INVOKER-EXECUTE-HARDENING-001A`, the first bounded result of the `DB-INVOKER-EXECUTE-HARDENING-001` design audit). PR #303 merged as `77b7a4ba0470eb3645d53217e6155cd17c65c15b`, and the migration-only rollout applied it on 2026-09-26 through the normal linked `supabase db push` (ledger **88 → 89**, latest `20260926152414`; [deployment.md](deployment.md) §6.10). Live posture, verified read-only: all five functions below are SECURITY INVOKER (`prosecdef = false`), with body, signature, owner `postgres`, `search_path=public` and EXECUTE ACL `{postgres=X/postgres,authenticated=X/postgres}` unchanged. `public` SECURITY DEFINER functions went **40 → 35**, the `authenticated`-callable ones **32 → 27**, and the `authenticated_security_definer_function_executable` advisor warnings **32 → 27** — exactly these five left the finding. The `papers` / `synonym_pool` grants, RLS, FORCE RLS and all eight ownership policies are unchanged. Before the rollout Production ran all five as SECURITY DEFINER (ledger 88, latest `20260925134526`, 32 advisor warnings — read-only, 2026-09-26).

**Decision.** A client-callable read RPC whose every read is already permitted to the caller — by the caller's own table grants and the caller-owned RLS policies — runs as **SECURITY INVOKER**, so ordinary table ACL + RLS is its primary database boundary. SECURITY DEFINER is reserved for functions that genuinely need authority the caller does not hold (writing a table the browser cannot write, reading one it cannot read, cross-row validation the caller cannot see, or evaluation inside a Storage policy), and each such function carries S1's guard.

**The five converted functions:**
- `search_papers(uuid,text,integer,integer)` — prefix-aware full-text search with per-field attribution;
- `search_papers_short(uuid,text)` — 1–2 character and quoted-phrase search with per-field attribution;
- `filter_papers_by_keywords(uuid,text[])` — keyword AND-filter with synonym expansion (reads `papers` and `synonym_pool`);
- `get_keyword_options(uuid,uuid[],integer,integer,text[])` — keyword dropdown options;
- `get_duplicate_papers()` — PMID/DOI duplicate groups.

Each reads only the caller's rows of `papers` (and `synonym_pool`). `authenticated` holds table-level `SELECT` on both, and the PERMISSIVE SELECT policies `Users can view their own papers` / `Users can view their own synonym groups` (`USING (auth.uid() = user_id)`) admit exactly the caller's rows. Before C49 they ran as their owner `postgres`, which has BYPASSRLS, so each body's own `auth.uid()` predicate was the **only** database boundary between accounts. After C49 the caller's RLS applies inside them. `authenticated` is neither SUPERUSER nor BYPASSRLS, which the migration pins.

**The explicit identity predicates stay, as defense-in-depth and product contract.** The four functions that take `p_user_id` still raise `Unauthorized: user mismatch` for a NULL id, a NULL `auth.uid()` or a mismatch. `get_duplicate_papers` still derives `v_user_id := auth.uid()` and scopes to it. Nothing caller-visible changes: for the caller's own id the body predicate and the RLS predicate select the same rows. Suite `020` demonstrates the layering. With the guard removed and owner authority restored, a cross-user call returns the victim's rows. With the guard removed but INVOKER kept, the same call returns **none**, because RLS stops it on its own.

**Exactly one attribute changes.** `prosecdef` goes true → false via `ALTER FUNCTION … SECURITY INVOKER`. Nothing else moves: not a body, signature, return type, argument default, volatility, parallel mode, owner, `search_path` or EXECUTE ACL (`authenticated` only, as before). The migration proves this by comparing each function's whole `pg_proc` row, minus `prosecdef`, before and after. It also pins the relations, grants and all eight `papers` / `synonym_pool` policies by value and digest (`07603cbe4e78a4d6097e7ec33bd1e6c8`), because after C49 those ARE the boundary. **`search_papers`' stored body still contains its historical comment "SECURITY DEFINER bypasses table-level RLS …"** (from `20260518010000`). It was deliberately not recreated just to edit a comment. The migration records that it supersedes the comment, the comment does not describe the current mode, and it may be removed the next time the body is legitimately recreated.

**Scope — what the audit found and what this does not do.** The audit classified the 32 authenticated-callable SECURITY DEFINER functions as **24 intentionally privileged** (kept) and **8 unnecessarily elevated**. C49 converts the 5 read-only ones. `bulk_update_keywords`, `bulk_update_study_types` and `safe_bulk_insert_papers` are the other 3 and belong to later, separately reviewed INVOKER groups. The rollout took the advisor count **32 → 27**, as predicted. Those 27 — the 24 intentionally privileged functions plus those three — are not defects merely because the advisor lists them. C49 does not touch the 24, the `pg_temp` placement in retained functions' `search_path`, `attachment_object_has_live_metadata` (which must stay SECURITY DEFINER), search-vector expression parity, or C30 (leaked-password protection). *(Follow-up, 2026-09-26: the `pg_temp` placement is now its own decision, **C50** — live in Production since 2026-09-26.)* *(Follow-up, 2026-09-27: `bulk_update_keywords` and `bulk_update_study_types` were the next, separately reviewed write group, **C52** — live in Production since 2026-09-27. They now run as SECURITY INVOKER, which took the advisor count **27 → 25**. `safe_bulk_insert_papers` was then still SECURITY DEFINER and not yet audited for SECURITY INVOKER, so one of the three candidates above stayed open.)* *(Follow-up, 2026-09-27: `safe_bulk_insert_papers`, the third candidate, was audited separately — `DB-SAFE-BULK-INSERT-INVOKER-AUDIT-001`, SAFE TO CONVERT — and converted by **C53**, live in Production since 2026-09-27, which took the advisor count **25 → 24**. With it the audit's eight unnecessarily elevated candidates are all resolved: five by C49, two by C52 and one by C53. The 24 intentionally privileged functions stay SECURITY DEFINER by design; this sequence does not imply that they should be converted.)*

**Performance note.** The caller's RLS predicate is now evaluated inside these functions too, as it already is on every direct `papers` read the dashboard makes. A local comparison on a 5,000-paper library (PostgreSQL 17.6, 10 calls each) returned identical row counts, with timings within noise in both modes. That measurement is local, not Production. If RLS cost ever shows up in a profile, the usual remedy is the `(SELECT auth.uid())` initplan form in the policies, which is a separate change under Performance Trigger 1.

**Privacy.** Authority reduction only: no data category, recipient, retention or processor changes, and no Privacy Policy amendment ([privacy-data-flow-audit.md](privacy-data-flow-audit.md)).

**Re-evaluation triggers:**
- a read operation that legitimately needs visibility beyond the caller's RLS view. Making it SECURITY DEFINER again requires a new, explicit security justification and S1's guard; it is never a silent revert;
- any change to `papers` / `synonym_pool` SELECT grants or policies, which is now a change to these five functions' boundary;
- a change that would make `authenticated` (or any client role) BYPASSRLS;
- the later INVOKER groups for the remaining three candidates *(all done: two by C52 and the third, `safe_bulk_insert_papers`, by C53, both live since 2026-09-27)*.

### C50. Retained SECURITY DEFINER functions with path-resolved objects explicitly place `pg_temp` last (2026-09-26)

**Status: LIVE in Production since 2026-09-26.** Migration `20260926202754_harden_security_definer_pg_temp_last.sql` implements it (`DB-SECURITY-DEFINER-PG-TEMP-LAST-001`, from the read-only audit `DB-SECURITY-DEFINER-SEARCH-PATH-AUDIT-001`). PR #305 merged as `b765145e1970c8378f528acac85ad3eb9782c346` (approved head `dfc9d368de544c696fc78484db8b2d74521c7ff3`), and the migration-only rollout applied it on 2026-09-26 through the normal linked `supabase db push` (ledger **89 → 90**, latest `20260926202754`; [deployment.md](deployment.md) §6.11).
- **Posture at the 2026-09-26 rollout, verified read-only:** of the **35** `public` SECURITY DEFINER functions, all owned by `postgres`, **32** are at `{"search_path=public, pg_temp"}` and the **3** audited exceptions below are still at `{search_path=public}`. The total stays 35 and the `authenticated`-callable ones stay **27**. The Security Advisor's `authenticated_security_definer_function_executable` count stays **27**, listing the same functions, because neither the security mode nor any grant changed. *(Superseded in part since 2026-09-27: **C52** converted two of the 32, `bulk_update_keywords` and `bulk_update_study_types`, to SECURITY INVOKER and kept their `public, pg_temp` path. That left **33**: **30** at `public, pg_temp` plus the same **3** exceptions at `public`, with **25** `authenticated`-callable and an advisor count of **25**.)* *(**C53**, also live in Production since 2026-09-27, then moved `safe_bulk_insert_papers` out the same way. The current SECURITY DEFINER inventory is therefore **32**: **29** at `public, pg_temp` plus the same **3** exceptions at `public`, with **24** `authenticated`-callable and an advisor count of **24**. All three converted functions still carry `public, pg_temp`, but they are no longer part of that inventory. The **32 + 3** at C50's own rollout is that rollout's record and does not change.)*
- **Nothing else moved.** No security mode, grant, owner, body, signature or OID changed. The whole-surface fingerprint `surface_with_oids` (`1e6cfb8bb03375d61583426b1f0ae4bc`, which covers OIDs, signatures, bodies, ACLs, modes and owners but not `proconfig`) is identical before and after. The three exception body digests are unchanged. The five trigger bindings and the `attachments_owner_delete` Storage-policy binding are unchanged, with the same OIDs.
- **Before the rollout** (read-only, 2026-09-26): ledger **89**, latest `20260926152414` (C49); all 35 at `{search_path=public}`, none at `public, pg_temp`.

**Decision — the project rule.** A SECURITY DEFINER function whose body resolves relations, types or other security-relevant objects through `search_path` must prevent temporary-schema precedence by listing `pg_temp` **last**, after its trusted schemas. For this codebase's `public`-schema definers that is `SET search_path = public, pg_temp`. A SECURITY DEFINER function may stay without it only when **all three** hold:
1. its current audited body contains no security-relevant name that is resolved through the path;
2. the exception is explicit — listed here and in suite `021`;
3. its current body is fingerprinted (`md5(prosrc)`), so any body change invalidates the exception and forces a security review.

This is deliberately **not** "every SECURITY DEFINER function must have the same search path". New functions are classified from their actual body and execution context, never copied mechanically into either group. Suite `021` fails when a new `public` SECURITY DEFINER function appears in neither group, so that classification cannot be skipped.

**Why — PostgreSQL 17 behaviour, re-confirmed for this change.**
- `pg_catalog` is always searched, before the listed schemas unless it is listed itself ([runtime-config-client, `search_path`](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-SEARCH-PATH)).
- The session's temporary schema is also always searched and, **when it is not listed, it is searched first** — before `pg_catalog` and `public`. That implicit lookup applies to **relation (table, view, sequence, …) and data-type names**; the temp schema is never searched for function or operator names (same page).
- "Writing SECURITY DEFINER Functions Safely" ([CREATE FUNCTION](https://www.postgresql.org/docs/17/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY)) names the temporary schema as the one to guard against — "searched first by default, and is normally writable by anyone" — and prescribes writing `pg_temp` as the last entry. Its own example is `SET search_path = admin, pg_temp`.
- So under `search_path=public`, an unqualified `papers`, `tags`, `paper_tags`, `profiles`, a `%ROWTYPE` or a type name in one of these bodies would resolve to a same-named object in the **caller's** temp schema if one existed, and the function would act on it with the owner's (`postgres`, BYPASSRLS) authority. With `public, pg_temp` every such name is found in `public` first.
- That arrangement relies on the other half: untrusted roles cannot CREATE in `public` (PostgreSQL 15+ default; [schema usage patterns](https://www.postgresql.org/docs/17/ddl-schemas.html#DDL-SCHEMAS-PATTERNS)). Production was re-verified read-only: `anon`, `authenticated` and `service_role` hold no CREATE on `public`. They do hold database `TEMP`, which is exactly why the temp schema is the relevant writable schema.
- Supabase's guidance is the same in kind: a SECURITY DEFINER function must set `search_path` ([Database Functions](https://supabase.com/docs/guides/database/functions)). Its lint `0011_function_search_path_mutable` flags only functions with no fixed path, so it is unaffected either way.

**Not an incident, not a confirmed exploit.** The audit found **no** function `CONFIRMED EXPLOITABLE`. It found no ordinary PaperLume caller with a current route to run arbitrary SQL in a session and create the shadow object first; PostgREST exposes RPC calls, not DDL. C50 closes a latent name-resolution surface as **defense in depth**. It does not change what any legitimate call returns: with no temp shadow present, `public, pg_temp` and `public` resolve every name identically. The 35 remain SECURITY DEFINER **intentionally** (C49 records the five that did not need it, and they are no longer SECURITY DEFINER). None of them is a defect for being SECURITY DEFINER. *(Since the 2026-09-27 rollouts there are 32: C52 moved two that C49 had already named as later INVOKER candidates, `bulk_update_keywords` and `bulk_update_study_types`, to SECURITY INVOKER as least-privilege hardening, and C53 moved the third, `safe_bulk_insert_papers`, the same way.)*

**The 32 hardened functions** (audit Tier 1 — unqualified relations on the write boundary; Tier 2 — types, `%ROWTYPE` and transitive path resolution):
- Tier 1: `bulk_add_paper_projects`, `bulk_add_paper_tags`, `bulk_set_paper_projects`, `bulk_set_paper_tags`, `bulk_update_keywords`, `bulk_update_study_types`, `merge_exact_duplicates`, `safe_bulk_insert_papers`, `set_paper_projects`, `set_paper_tags`.
- Tier 2: `attachment_object_has_live_metadata`, `author_identity_effective_root`, `check_and_consume_storage_quota`, `clear_current_user_ai_model`, `clear_current_user_ai_reasoning`, `consume_ai_quota`, `create_author_identity_from_mention`, `delete_attachment_with_cleanup`, `delete_empty_author_identity`, `delete_papers_with_attachment_cleanup`, `finalize_attachment_upload`, `get_ai_quota_status`, `get_current_user_access`, `handle_new_user`, `link_author_mention_to_identity`, `merge_author_identities`, `refund_ai_quota`, `set_current_user_ai_model`, `set_current_user_ai_reasoning`, `unlink_author_mention_identity`, `unmerge_author_identity`, `validate_author_mention_for_identity`.

Exact signatures are in the migration. For each of them, **only `proconfig` changes**. Body, OID, signature, argument defaults, result, language, volatility, parallel mode, strictness, leakproofness, SETOF, owner, SECURITY DEFINER, ACL and effective EXECUTE are all unchanged. The migration proves it by comparing each function's whole `pg_proc` row, minus `proconfig`, before and after.

**The 3 audited exceptions — stay at `search_path=public`, deliberately, and only for these bodies:**

| Function | Audited body `md5(prosrc)` | Why the path cannot be shadowed |
|---|---|---|
| `clear_author_identity_links_on_authors_change()` | `a14c92dbd8485afff4d1600684b37565` | Trigger function. Its only object reference is `public.author_identity_links`, schema-qualified. No path-resolved object and no path-sensitive callee. |
| `refund_storage_quota()` | `3e20f43b80a908b309cb6335d8eb9360` | Trigger function. It updates `public.user_storage_usage`. The apparent `user_storage_usage.` in its body is the range-variable qualifier of that qualified target, not a schema lookup. Otherwise it calls only built-ins (`GREATEST`, `now()`), which the temp schema is never searched for. |
| `reject_attachment_over_cleanup_intent()` | `494f7297c23991bc8d28d4f81906e059` | Trigger function. It reads `public.attachment_cleanup_queue` and `public.attachment_cleanup_tombstone`, both qualified. No path-resolved name. |

The audit classified them **SAFE UNDER CURRENT PRIVILEGES**. The exemption belongs to these exact bodies, never to the function names. The migration refuses to run if any digest differs. Suite `021` pins path **and** digest together, so **any future body change to one of them fails CI** until a reviewer re-audits it and either keeps the exception (updating the digest here and in `021`) or moves the function into the hardened group. They were **not** changed merely for catalog uniformity.

**Special contracts preserved:**
- `attachment_object_has_live_metadata(text)` stays SECURITY DEFINER, and its body is not recreated. The Storage policy `attachments_owner_delete` on `storage.objects` still evaluates it; the migration pins that dependency and proves it unchanged. Only its `search_path` changes. The separate attachment-fence regression task stays separate.
- `refund_ai_quota(uuid)` keeps C47 exactly: SECURITY DEFINER, owner `postgres`, `service_role` its only non-owner grantee, and nothing for `authenticated`, `anon` or PUBLIC.
- All five trigger bindings are unchanged, with the same trigger OIDs, relations and function OIDs. Two are on hardened functions (`handle_new_user` on `auth.users`, `check_and_consume_storage_quota` on `paper_attachments`) and three on the exceptions.
- `bulk_update_keywords`, `bulk_update_study_types` and `safe_bulk_insert_papers` are hardened because they are SECURITY DEFINER **today**. Their later SECURITY INVOKER groups stay separate. If they become INVOKER, this definer-specific defense can be reconsidered for them then. *(2026-09-27: **C52**, live in Production since 2026-09-27, converted the first two to SECURITY INVOKER and kept their `public, pg_temp` path. At C52's rollout `safe_bulk_insert_papers` was still SECURITY DEFINER in Production and hardened here. **C53**, live in Production since later the same day, converted it as well and likewise kept `public, pg_temp`. See C52 and C53.)*

**Evidence (local, rolled back — not a Production exploit).** Suite `021` uses a real Tier-1 function, `set_paper_tags(uuid,uuid[])`, whose ownership guard reads `papers` unqualified. An `authenticated` caller with its own JWT creates a temporary `papers` table holding a forged ownership row for another account's paper.
- **Hardened** (`public, pg_temp`): the function reads `public.papers`. The caller's own paper, which is absent from the shadow, updates normally. The forged foreign paper is refused with `Paper not found or access denied`, and the other account's links are untouched.
- **Negative control:** only that function, transaction-locally, is set back to `search_path=public`. The same shadow now wins. The caller's own real paper is refused, and the forged row lets the call replace the other account's tag links under the owner's authority.
- Restoring `public, pg_temp` refuses the forged call again. Run against the pre-C50 posture, the suite fails 40 of its 101 assertions, including every hardened behavioural one. So it detects the old posture; it does not merely pass on the new one.

**Out of scope, unchanged:** C49's five SECURITY INVOKER read RPCs; the `search_path=pg_catalog` helpers (`set_updated_at`, `immutable_english_tsvector_*`, `attachment_cleanup_path_is_safe`), whose review is a separate follow-up *(2026-09-27: now **C51**, live in Production since 2026-09-27)*; the database `TEMP` privilege, which is not revoked from PUBLIC (a separate, platform-sensitive question); default function EXECUTE hardening; service-role least privilege; search-vector expression parity; C30.

**Privacy.** Execution-environment hardening only: no data category, recipient, retention or processor changes, and no Privacy Policy amendment ([privacy-data-flow-audit.md](privacy-data-flow-audit.md)).

**Re-evaluation triggers:**
- **any new `public` SECURITY DEFINER function** — classify it from its body (hardened with `pg_temp` last, or an explicit, digest-pinned exception), in the migration that creates it and in suite `021`;
- **any body change to one of the three exceptions** — re-audit it; the digest pin fails CI until someone decides;
- a hardened function being converted to SECURITY INVOKER (the `bulk_update_*` and `safe_bulk_insert_papers` groups) — decide then whether it keeps `pg_temp` last *(decided for the two `bulk_update_*` functions by C52, and for `safe_bulk_insert_papers` by C53: they keep it)*;
- a change to CREATE on `public` or to database `TEMP` for client roles;
- the separate `pg_catalog`-helper path review — now **C51**.

### C51. The `search_path=pg_catalog` helpers whose bodies name built-in data types list `pg_temp` last (2026-09-27)

**Status: COMPLETE — LIVE in Production since 2026-09-27.** Migration `20260927001229_harden_pg_catalog_helper_pg_temp_last.sql` implements it (`DB-PG-CATALOG-HELPER-PG-TEMP-LAST-001`). PR #307 merged as `bc8278b38a6d82a15c82e5ccd478347eb00a7811` (approved head `2bdc6e0c92b4efe14a2a16e7b03f090b8995ce8a`), and the separately authorized migration-only rollout applied it on 2026-09-27 through the normal linked `supabase db push` (ledger **90 → 91**, latest `20260927001229`; [deployment.md](deployment.md) §6.12).
- **Live posture, verified read-only:** exactly the four targets below are at `{"search_path=pg_catalog, pg_temp"}`, and `set_updated_at()` is still at exactly `{search_path=pg_catalog}`. That is 4 + 1, and no other `public` function is pinned to `pg_catalog`. All five are still SECURITY INVOKER and owned by `postgres`.
- **Nothing else moved.** Only those four `proconfig` values changed. No body, OID, owner, security mode or ACL changed on any of the five, and no grant changed. The three attachment lifecycle callers are unchanged (still SECURITY DEFINER at `{"search_path=public, pg_temp"}`), as are `papers.search_vector` (the hosted direct built-in expression `8ddd960b4f4b11dd7afd35485d01fd25`; recorded at the time as "inlined", the wrong mechanism — see C54), `idx_papers_search_vector` and the `papers.trg_papers_updated_at` → `set_updated_at()` binding. The fingerprint `helpers_minus_config` covers the five helpers and the three callers as whole `pg_proc` rows minus `proconfig`. It read `f2c68ed1852d00f9e0a1369ea11a172e` both before and after. The Security Advisor shows no `function_search_path_mutable` finding and none naming the five helpers. `authenticated_security_definer_function_executable` is still **27**: C51 does not touch C50's SECURITY DEFINER inventory. *(27 at C51's rollout; C52 later took it to 25 and C53 to 24, both on 2026-09-27.)*
- **Before the rollout** (read-only, 2026-09-27): ledger **90**, latest `20260926202754` (C50); all five helpers at `{search_path=pg_catalog}`.

**Decision.** Exactly four SECURITY INVOKER helpers move from `{search_path=pg_catalog}` to `{"search_path=pg_catalog, pg_temp"}`:

| Function | Role | Classification |
|---|---|---|
| `attachment_cleanup_path_is_safe(uuid,text,uuid)` | The attachment-namespace predicate evaluated inside the three SECURITY DEFINER lifecycle RPCs (`delete_attachment_with_cleanup`, `delete_papers_with_attachment_cleanup`, `finalize_attachment_upload`) | **Security-boundary hardening.** Its resolution environment is part of that privileged boundary. |
| `immutable_english_tsvector_text(text)` | Search-vector wrapper | **Semantic-integrity / defense-in-depth hardening** |
| `immutable_english_tsvector_textarr(text[])` | Search-vector wrapper | **Semantic-integrity / defense-in-depth hardening** |
| `immutable_english_tsvector_jsonb(jsonb)` | Search-vector wrapper | **Semantic-integrity / defense-in-depth hardening** |

`set_updated_at()` **deliberately stays at exactly `{search_path=pg_catalog}`**. Its reviewed body (`md5(prosrc)` `301a884953d37769916294bb60562e05`) names no data type: it assigns `now()` to `NEW.updated_at` and returns `NEW`. As with C50's exceptions, the classification belongs to that exact body. Suite `007` pins path and digest together, so a body change forces a re-review.

> **The three wrappers — later history (2026-09-28).** When C51 hardened them, the text and jsonb wrappers were inside the search boundary: every clean replay's `papers.search_vector` called them, so a wrapper's name resolution decided what was stored. Hardening their path was correct then, and it stays correct history. C54 (live 2026-09-27) later removed that dependency, and **C55 (live in Production since 2026-09-28)** then retired the three wrappers as obsolete. C51's hardening of `attachment_cleanup_path_is_safe` and its classification of `set_updated_at()` are unaffected, and suite `007` keeps pinning both. The wrappers kept C51's `pg_catalog, pg_temp` in Production until C55's migration-only rollout dropped all three on 2026-09-28.

All five remain SECURITY INVOKER. For each of the four, **only `proconfig` changes**. Body, OID, owner, language, volatility, parallel mode, strictness, leakproofness, return type, arguments, SECURITY INVOKER status, EXECUTE ACL and effective callers are unchanged. So are the three attachment callers, the `papers.trg_papers_updated_at` binding, the `papers.search_vector` generated column, its stored values and `idx_papers_search_vector`. There is no grant, OID or dependency change.

**Why.** Under PostgreSQL 17 the session's temporary schema is always searched and, when it is not listed in `search_path`, it is searched **before** `pg_catalog` for relation and data-type names. It is never searched for function or operator names ([runtime-config-client, `search_path`](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-SEARCH-PATH)). All four bodies name built-in data types, so `search_path=pg_catalog` alone does not make those names resolve to `pg_catalog` in every session. Listing `pg_temp` explicitly **last** places `pg_catalog` ahead of it, and **built-in type-name resolution becomes deterministic**. This is C50's principle applied to the `pg_catalog`-pinned INVOKER helpers.

**Not an incident.** There is **no evidence of exploitation**. **No current ordinary PaperLume route** has been identified that provides the arbitrary SQL/DDL prerequisite; PostgREST exposes RPC calls, not DDL. Client roles hold database-level `TEMPORARY` through PUBLIC's database ACL entry `=Tc/postgres` (`T` = TEMPORARY, `c` = CONNECT). That is not CREATE on schema `public`, a separate privilege that `anon`, `authenticated` and `service_role` do not hold (re-verified read-only in Production on 2026-09-27). C51 does not change what any legitimate call returns: with no temporary object present, `pg_catalog, pg_temp` and `pg_catalog` resolve every name identically.

**PFA-C08 clarified, not reopened.** PFA-C08 (`20260810152125`, 2026-08-10) is not an incident and its hardening outcome remains valid: the four advisor findings were closed with a fixed, narrow path. Its reasoning was correct for functions and operators, which are never looked up in the temporary schema. Its broader statement that unqualified type lookups resolve `pg_catalog` first was **incomplete**: an implicit, unlisted temporary schema may precede `pg_catalog` for data-type lookup. C51 is the forward refinement for the four helpers whose bodies contain type-name references. The historical migration file is not edited.

**Two known environment differences — each accepted in exactly two reviewed shapes, never normalised:**
1. **EXECUTE ACL of the three wrappers (and of `set_updated_at()`).** A clean replay stores `proacl IS NULL`, PostgreSQL's default of owner plus PUBLIC EXECUTE. Hosted Production stores the same effective posture as the explicit `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`. The migration accepts either, requires all four to share one of them, refuses any third shape, and preserves the literal value it found. The attachment helper has one exact owner-only ACL, `{postgres=X/postgres}`, everywhere.
2. **The `papers.search_vector` expression** (`DB-SEARCH-VECTOR-EXPRESSION-PARITY-001`, tracked separately and not resolved here). A clean replay stores calls to the text and jsonb wrappers. Hosted Production stores the direct built-in form. Rendered under the migration's pinned path, these are `dd69f099a274a9cdc0f174ae0883ddb6` and `8ddd960b4f4b11dd7afd35485d01fd25`. Any third shape stops the migration. *(Correction, 2026-09-27: this record originally called the hosted form "inlined". Nothing was inlined; the two environments executed different migration text. The difference is resolved by C54, which converges every replay on the direct form.)*

**Out of scope, unchanged:** C50's SECURITY DEFINER inventory (the four C51 functions are SECURITY INVOKER and do not join it); `update_updated_at_column()`; default function-EXECUTE hardening, i.e. PUBLIC EXECUTE on the INVOKER helpers (a separate backlog item); database `TEMPORARY` (not revoked); `DB-SEARCH-VECTOR-EXPRESSION-PARITY-001`; C30.

**Privacy.** Execution-environment hardening only: no data category, recipient, retention or processor changes, and no Privacy Policy amendment ([privacy-data-flow-audit.md](privacy-data-flow-audit.md)).

**Re-evaluation triggers:**
- **any body change to `set_updated_at()`** — re-review whether it now names a data type; the digest pin in suite `007` fails CI until someone decides;
- **any new `public` function pinned to a `pg_catalog`-based `search_path`** — classify it from its body; suite `007` fails when one appears in neither group;
- a body change to one of the four that would need a schema other than `pg_catalog`;
- a change to database `TEMPORARY` for client roles, or to CREATE on `public`;
- resolution of `DB-SEARCH-VECTOR-EXPRESSION-PARITY-001`, which changes which search-vector shape is expected where.

### C52. Caller-owned bulk metadata write RPCs use SECURITY INVOKER; the caller's table grants + RLS are their primary boundary (2026-09-27)

**Status: COMPLETE — LIVE in Production since 2026-09-27.** Migration `20260927071803_convert_bulk_metadata_writes_security_invoker.sql` implements it (`DB-BULK-METADATA-WRITE-INVOKER-001`, from the read-only audit `DB-BULK-METADATA-WRITE-INVOKER-AUDIT-001`). PR #309 merged as `72469931591468bfebba2e8cfe9d7c7e85b7c658` (approved head `eaa3904c4c73b476e778b9ff83979abca4e4b646`). The separately authorized migration-only rollout applied it on 2026-09-27 through the normal linked `supabase db push` (ledger **91 → 92**, latest `20260927071803`; [deployment.md](deployment.md) §6.13).
- **Live posture, verified read-only:**
  - `bulk_update_keywords(jsonb)` (OID `46223`, body `c002702d…`) and `bulk_update_study_types(jsonb)` (OID `19998`, body `6086d69c…`) are SECURITY INVOKER. They are still owned by `postgres`, at `{"search_path=public, pg_temp"}`, with EXECUTE ACL `{postgres=X/postgres,authenticated=X/postgres}`.
  - `public` SECURITY DEFINER functions went **35 → 33**, and the `authenticated`-callable ones **27 → 25**. Exactly these two left and none joined. Of the 33, **30** were at `public, pg_temp` and C50's **3** exceptions at `public`. *(That is C52's rollout record. C53 later took the inventory to 32 / 24, 29 + 3, on 2026-09-27.)*
  - The Security Advisor's `authenticated_security_definer_function_executable` went **27 → 25** and lists neither function (see **Inventory** below).
- **Nothing else moved.**
  - Each function's whole `pg_proc` row minus `prosecdef` is identical before and after (`5fad9ff5…` / `2da2205f…`). No body, OID, owner, signature, language, volatility, parallel mode, path or ACL changed.
  - Every other `public` function is unchanged. `safe_bulk_insert_papers` was still SECURITY DEFINER at C52's rollout *(C53 later converted it; see C53)*.
  - `papers` is unchanged:
    - its grants: `authenticated` exactly `INSERT, SELECT, UPDATE`;
    - RLS and FORCE RLS;
    - its four policies, digest `83aefa94…`, none RESTRICTIVE;
    - all twelve triggers;
    - `search_vector` (`8ddd960b…`) and `idx_papers_search_vector`.
  - No application row was written.
- **Before the rollout** (read-only, 2026-09-27): ledger **91**, latest `20260927001229` (C51). Both functions were SECURITY DEFINER; the inventory was 35 / 27, and the advisor showed 27 with both listed.

**Decision.** C49's rule applies to writes too. A client-callable RPC that only writes rows the caller may already write — through its own table grants and the caller-owned RLS policies — runs as **SECURITY INVOKER**, so the ordinary table grants and RLS are its primary database boundary. Exactly two functions are converted:
- `bulk_update_keywords(jsonb)` — saves the keyword re-evaluation, in chunks of 500 `{id, keywords}` objects;
- `bulk_update_study_types(jsonb)` — saves the study-type re-evaluation, as `{id, study_type}` objects.

Their only application callers are in `src/hooks/papers/useBulkMutations.ts`. Both call with an authenticated session, for ids read from the caller's own library, and use only the returned error. No Edge Function calls them.

**Why they need no owner authority.** Each body is one statement: `UPDATE papers SET <column> = u.<column>, updated_at = now() FROM jsonb_to_recordset(updates) … WHERE papers.id = u.id AND papers.user_id = auth.uid()`. `authenticated` holds table-level `SELECT` and `UPDATE` on `papers`. The PERMISSIVE policies `Users can view their own papers` (SELECT) and `Users can update their own papers` (UPDATE) both use `auth.uid() = user_id`. The UPDATE policy has no `WITH CHECK`, so PostgreSQL also applies its `USING` expression to the new row. And because the `WHERE` clause reads `papers`, the SELECT policy filters the target rows too. Before C52 the functions ran as `postgres`, which has BYPASSRLS, so the body predicate was the **only** database boundary between accounts. After C52 the caller's RLS applies inside them, and the SELECT and UPDATE policies each block a foreign row on their own. `authenticated` is neither SUPERUSER nor BYPASSRLS, which the migration pins. C52 is least-privilege hardening based on that completed audit, not an incident response.

**What stays exactly as it was:**
- the body predicate `papers.user_id = auth.uid()`, now defense-in-depth;
- the EXECUTE ACL `{postgres=X/postgres,authenticated=X/postgres}`: `authenticated` only, and nothing for `anon`, `service_role` or PUBLIC;
- `search_path=public, pg_temp`, from C50. C50 hardened them correctly while they were SECURITY DEFINER, and the path still suits their bodies, which name `papers` unqualified. C52 keeps it; it does not relax it;
- `updated_at = now()` in the body, although `trg_papers_updated_at` makes it redundant. Cleanup is out of scope;
- the caller-visible contract. Both return `void`. An own id updates the row and sets `updated_at`. A foreign or unknown id, an empty array, SQL `NULL` and a call without claims are silent no-ops. Malformed input fails with the same PostgreSQL SQLSTATE as before (`22023` for a non-array or an array of non-objects, `22P02` for an invalid uuid) and applies nothing.

**Exactly one attribute changes.** `prosecdef` goes true → false via two `ALTER FUNCTION … SECURITY INVOKER` statements; there is no `CREATE OR REPLACE`. The migration proves it by comparing each function's whole `pg_proc` row, minus `prosecdef` and including its OID, before and after. It also proves that no other `public` function changed (`safe_bulk_insert_papers` included), that `papers`' owner, RLS flags, ACL, column grants, policies, triggers, `search_vector` column, default and index are unchanged, and that the transaction wrote no row.

**What the caller now carries — none of it new.** `papers` has a BEFORE UPDATE row trigger, so every UPDATE recomputes the stored `search_vector`. PostgreSQL checks EXECUTE on each function in that expression as the current user, which is now the caller. The same holds for the built-ins that `papers`' CHECK constraints and index expressions call. All of them are executable by `authenticated`: the replay's text and jsonb wrappers through PUBLIC, and the built-ins (`to_tsvector`, `setweight`, `tsvector_concat`, `lower`, `jsonb_path_exists`, …) through their default PUBLIC EXECUTE. A direct browser UPDATE of `papers` has always needed exactly this, so C52 adds no dependency. The migration requires every one of them to be executable by `authenticated`. *(Correction, 2026-09-27, found while building C53: for the `search_vector` callees that check was incomplete. Its §1g joins their full signatures with commas and splits the list with `string_to_array(v_expr_fns, ',')`. A multi-argument signature such as `setweight(tsvector,"char")` therefore breaks into fragments that do not resolve, and they are skipped rather than checked. On hosted Production all three callees take two arguments, so that one check proved nothing there. The CHECK-constraint and index-expression check works on OIDs and is unaffected, and so is §1g's exact pin of the callee list. The fact the check was meant to prove holds: Production confirms `authenticated` can EXECUTE `setweight(tsvector,"char")`, `to_tsvector(regconfig,text)` and `tsvector_concat(tsvector,tsvector)`, and suite `022` independently checks, by function OID, that `authenticated` can EXECUTE every function the `search_vector` expression calls (in CI, the clean-replay shape). C52's ALTERs were correct, the applied file is not edited, and no rollback or fix migration is implied. The separate `DB-MIGRATION-SIGNATURE-PARSING-AUDIT-001` follow-up was completed on 2026-10-02 and required no forward hardening; see [migration-history.md](migration-history.md), C52 entry.)* It accepts exactly the two reviewed `search_vector` shapes (clean replay `dd69f099…` on the wrappers, hosted `8ddd960b…` on built-ins; `DB-SEARCH-VECTOR-EXPRESSION-PARITY-001`, not resolved here) and refuses a third.

**Triggers.** `trg_papers_updated_at` now runs `set_updated_at()` as the caller. That function is SECURITY INVOKER at `search_path=pg_catalog` and only assigns `now()`. `papers_clear_author_identity_links_on_authors_change` fires only `AFTER UPDATE OF authors … WHEN (new.authors IS DISTINCT FROM old.authors)`. Neither function writes `authors`, so it cannot fire for them; it stays C50's audited SECURITY DEFINER exception. The migration pins all twelve `papers` triggers — the two named ones by definition, the ten internal foreign-key ones by kind and function — and neither trigger is modified.

**Duplicate ids.** A payload that repeats an id updates that row once. PostgreSQL does not define which of several matching source rows an `UPDATE … FROM` applies, so **no "first element wins" or "last element wins" contract exists**, and none is documented or tested. Duplicates behave the same in both modes, and they never cause a cross-user write.

**Evidence (local, rolled back — not a Production exploit).** Suite `022` (91 assertions) owns the change:
- **Posture and boundary.** It pins posture, the `papers` grants, the four policies, the two named triggers and their functions.
- **Contract.** It covers the own-row, foreign-row, mixed, no-op, malformed and duplicate cases above.
- **RLS is live.** A RESTRICTIVE deny policy turns the caller's own update into a no-op.
- **RLS is the primary boundary.** Controlled copies of both bodies, byte-for-byte except that the ownership predicate is removed, still cannot touch another account's row as SECURITY INVOKER. Opening only the UPDATE policy, or only the SELECT policy, still blocks the write. Opening **both** lets it through (the negative control). The same predicate-free body as SECURITY DEFINER writes the foreign row despite RLS, which is the posture the migration leaves behind.
- **The grants are live.** Revoking the caller's UPDATE, or its SELECT, on `papers` makes both refuse with `permission denied for table papers`. The same call as SECURITY DEFINER still succeeds.
- **The search_vector dependency.** Revoking EXECUTE on the jsonb wrapper refuses both calls, and a plain browser UPDATE, the same way. *(True of the clean-replay wrapper form C52 was tested on. Since C54 the expression calls only built-ins, so suite `022` now shows that revoking the wrappers affects neither write, and proves the generated-column dependency with a probe column instead.)*
- **The author-link trigger.** Neither write fires it; a direct `authors` edit still does.

Reverting both functions to SECURITY DEFINER fails 19 assertions across suites `003`, `015`, `021` and `022`. The migration refuses 21 kinds of precondition drift before its ALTERs and 5 kinds of postcondition drift before COMMIT. Before the rollout, Production passed the migration's own §0/§1 preconditions inside a read-only, rolled-back transaction, at preparation and again immediately before the apply.

**Inventory.** C52 took `public` SECURITY DEFINER functions **35 → 33** and the `authenticated`-callable ones **27 → 25**. That holds on a replay and, since the 2026-09-27 rollout, in Production. Exactly these two left; no function entered. For the same reason, the Security Advisor's `authenticated_security_definer_function_executable` went **27 → 25** in Production: the two are no longer `authenticated`-callable SECURITY DEFINER functions. That is not "2 of 27 vulnerabilities fixed". The remaining 25 are not 25 defects. They are the 24 functions the C49 audit found intentionally privileged, plus `safe_bulk_insert_papers`, which then still needed its own audit *(audited since and converted by C53, live since 2026-09-27, which took the advisor count 25 → 24)*. Each stays classified function by function, not by its presence in the advisor list.

**Not in scope, unchanged.** `safe_bulk_insert_papers(uuid,jsonb)` stays SECURITY DEFINER under C52, and was not yet audited for SECURITY INVOKER when C52 was decided. Its contract — the `p_user_id` identity guard, INSERT, per-row exception handling, unique-violation handling, the duplicate lookup and the JSONB result — needs its own audit. In particular, its broad exception handling could turn an RLS or permission failure into a row-level result object under INVOKER. It is the next distinct candidate. C49's five read RPCs, C50's retained definers and C51's helpers are untouched. *(Follow-up, 2026-09-27: audited separately — SAFE TO CONVERT, with the broad handler accepted as fail-closed — and converted by **C53**, live in Production since 2026-09-27.)*

**Privacy.** Authority reduction only: no data category, recipient, retention or processor changes, and no Privacy Policy amendment ([privacy-data-flow-audit.md](privacy-data-flow-audit.md)).

**Re-evaluation triggers:**
- a bulk metadata write that legitimately needs to update rows beyond the caller's RLS view. Making it SECURITY DEFINER again needs a new, explicit security justification and S1's guard; it is never a silent revert;
- any change to `papers`' SELECT or UPDATE grants, to its policies (a RESTRICTIVE one included) or to FORCE RLS, which is now a change to these two functions' boundary;
- a new or widened `papers` UPDATE trigger, which would now fire as the caller;
- a change to what `search_vector`, a CHECK constraint or an index expression on `papers` calls, or to EXECUTE on those functions — including the resolution of `DB-SEARCH-VECTOR-EXPRESSION-PARITY-001`;
- a change that would make `authenticated` (or any client role) BYPASSRLS;
- the separate `safe_bulk_insert_papers` INVOKER audit *(done; see C53)*.

### C53. `safe_bulk_insert_papers` runs as SECURITY INVOKER; the caller's table grants + RLS are its primary boundary (2026-09-27)

**Status: COMPLETE — LIVE in Production since 2026-09-27.** Migration `20260927123856_convert_safe_bulk_insert_security_invoker.sql` implements it (`DB-SAFE-BULK-INSERT-INVOKER-001`, from the read-only audit `DB-SAFE-BULK-INSERT-INVOKER-AUDIT-001`). PR #311 merged as `fa01fe1862d41f9c376eff3f53f2dd8aa0bee185` (approved head `660b2a5fa6533055044c2bf0e73592a6d2fe1ed3`). The separately authorized migration-only rollout applied it on 2026-09-27 with `supabase db push --linked --yes` (Supabase CLI 2.111.0, 14:14:00Z–14:14:10Z, exit 0, no seeds and no roles; ledger **92 → 93**, latest `20260927123856`; [deployment.md](deployment.md) §6.14).
- **Live posture, verified read-only:**
  - `safe_bulk_insert_papers(uuid,jsonb)` is SECURITY INVOKER. It keeps OID `29057`, owner `postgres`, body `119925245a5c3c8529ada3d2e10fba96` (7,628 characters), `{"search_path=public, pg_temp"}` and the EXECUTE ACL `{postgres=X/postgres,authenticated=X/postgres}`.
  - `public` SECURITY DEFINER functions went **33 → 32**, the `authenticated`-callable ones **25 → 24**, and C50's `public, pg_temp` definer group **30 → 29**; the **3** audited exceptions are unchanged. Exactly this function left and none joined.
  - The Security Advisor's `authenticated_security_definer_function_executable` went **25 → 24** and no longer lists it (see **Inventory** below).
- **Nothing else moved.**
  - The function's whole `pg_proc` row minus `prosecdef` is identical before and after (`0a0cb087…`), and so is its comment. No body, OID, owner, signature, result, language, volatility, parallel mode, strictness, path or ACL changed.
  - Every other `public` function is unchanged.
  - `papers` is unchanged: `authenticated` exactly `INSERT, SELECT, UPDATE` with no column grant; RLS and FORCE RLS; the four PERMISSIVE policies (digest `83aefa94…`), none RESTRICTIVE; the six constraints, the `auth.users` foreign key, the seven indexes, all twelve triggers, every default and generated column, `search_vector` (`8ddd960b…`) and `idx_papers_search_vector`. `authenticated` still holds exactly `USAGE` on `papers_insert_order_seq`.
  - No application row was written, the function was never called in Production, and no Edge Function, Auth, Storage, secret or Vercel change accompanied the rollout.
- **Before the rollout** (read-only, 2026-09-27): ledger **92**, latest `20260927071803` (C52). The function was SECURITY DEFINER with the same OID, body, path and ACL; the inventory was 33 / 25 (30 + 3), and the advisor showed 25 with it listed.

**Decision.** C49's and C52's rule applies to the bulk import too. `safe_bulk_insert_papers(uuid,jsonb)` inserts only rows for its guarded caller and looks up only that caller's own rows, all of which `authenticated` may already do through its own grants and the caller-owned RLS policies. So it runs as **SECURITY INVOKER**, and the ordinary table grants and RLS become its primary database boundary. It is the last of the eight unnecessary SECURITY DEFINER candidates the C49 audit identified: C49 converted the five read RPCs, C52 the two bulk metadata writes, and C53 closed the final deferred one with its 2026-09-27 rollout. That resolves the eight-candidate set. The 24 functions the audit found intentionally privileged stay SECURITY DEFINER by design.

Its only application caller is `src/hooks/papers/useBulkMutations.ts` (the identifier import and the file import). Both call it with an authenticated session and the caller's own user id, in chunks of 50, through `processChunkedInsert`. No Edge Function calls it.

**Audit classification — SAFE TO CONVERT.** `DB-SAFE-BULK-INSERT-INVOKER-AUDIT-001` (read-only) found:
- all 71 legitimate scenarios behave identically as DEFINER and as INVOKER — the same result JSON, rows and sequence use;
- owner authority is unnecessary, because `authenticated` already holds every privilege the body, its defaults, generated columns, constraints and indexes need;
- the INSERT and SELECT policies each independently reinforce the `p_user_id = auth.uid()` guard;
- duplicate resolution and row isolation are preserved;
- the broad `WHEN OTHERS` handler is not a prerequisite blocker (see below).

**Why it needs no owner authority.** The body rejects the call unless `p_user_id` is non-NULL and equals a non-NULL `auth.uid()`. It does this once, before the per-row loop and outside every per-row exception block. Then, per element, it canonicalizes three JSON fields, `INSERT`s one `papers` row with `user_id = p_user_id … RETURNING id`, and on `unique_violation` looks up the caller's own row by the PMID or case-folded DOI it collided on. `authenticated` holds table-level `INSERT` and `SELECT` on `papers` and `USAGE` on `papers_insert_order_seq`. The PERMISSIVE policies `Users can create their own papers` (INSERT, `WITH CHECK (auth.uid() = user_id)`) and `Users can view their own papers` (SELECT, `USING (auth.uid() = user_id)`) govern the caller. Because the INSERT has `RETURNING`, PostgreSQL applies the SELECT policy to the new row as well. Before C53 the function ran as `postgres`, which has BYPASSRLS, so the identity guard was the **only** database boundary between accounts. After C53 the caller's RLS applies inside it, and two things hold independently of the guard. The INSERT policy and the SELECT policy each refuse a row written for another account. The SELECT policy hides other accounts' rows from the duplicate lookup, so it cannot name their papers. `authenticated` is neither SUPERUSER nor BYPASSRLS, which the migration pins. C53 is least-privilege hardening: it restores ordinary table/RLS authorization as a primary boundary and keeps the guard as defense-in-depth. It follows a completed audit rather than an incident, and it makes no claim that the old posture was exploited.

**What stays exactly as it was:**
- the identity guard — NULL `p_user_id`, NULL `auth.uid()` and `p_user_id <> auth.uid()` all raise `P0001 Unauthorized: user mismatch` — now defense-in-depth;
- the EXECUTE ACL `{postgres=X/postgres,authenticated=X/postgres}`: `authenticated` only, and nothing for `anon`, `service_role` or PUBLIC;
- `search_path=public, pg_temp`, from C50. C50 hardened it correctly while it was SECURITY DEFINER, and the path still suits a body that names `papers` unqualified. C53 keeps it;
- the body, byte-for-byte, including the broad per-row `WHEN OTHERS` handler;
- the caller-visible contract: one `{index, status, id?, error_message?}` object per element, in payload order. `inserted` carries the new id. `duplicate` names the caller's existing row only when exactly one owned row matches the PMID or folded DOI it collided on. Zero candidates, or a PMID and a DOI naming two different rows, return no id. `error` is returned for a malformed element while the rest of the batch still inserts.

**Exactly one attribute changes.** `prosecdef` goes true → false via one `ALTER FUNCTION … SECURITY INVOKER` statement; there is no `CREATE OR REPLACE`. The migration proves it by comparing the function's whole `pg_proc` row, minus `prosecdef` and including its OID, and its comment, before and after. It also proves that no other `public` function changed, including its security mode. And it proves that `papers`' owner, RLS flags, ACL, every column, default, generated expression, constraint, index, policy and trigger, and the `papers_insert_order_seq` ACL, are unchanged, and that the transaction wrote no row.

**What the caller now carries — none of it new except the body's own built-ins.** An INSERT of `papers` evaluates, as the current user:
- the column defaults `gen_random_uuid()`, `now()` and `nextval('public.papers_insert_order_seq')`, which needs sequence `USAGE`;
- the generated `has_abstract` and `search_vector`;
- the three CHECK constraints (`jsonb_typeof`, `jsonb_array_length`, `jsonb_path_exists`, integer and text comparisons);
- the unique-index expression `lower(doi)`;
- the RLS policy expressions (`auth.uid()`, `uuid_eq`).

A direct browser INSERT of `papers` has always needed exactly these. The body adds only built-ins with default PUBLIC EXECUTE: `jsonb_array_elements`, `jsonb_build_object`, `to_jsonb`, `string_agg`, `jsonb_agg`, `array_agg`, `cardinality`, `btrim`, `lower`, and the jsonb, text, uuid and integer operators. The migration requires every one of them to be executable by `authenticated`. It reads the first group from the catalog's expression trees as function OIDs, so it covers either `search_vector` shape. The second group is a reviewed list of 24 signatures, one per row, each of which must resolve — an unresolvable entry is refused rather than silently skipped. No list of signatures is ever joined and split on commas. The migration accepts exactly the two reviewed `search_vector` shapes (clean replay `dd69f099…` on the wrappers, hosted `8ddd960b…` on built-ins; `DB-SEARCH-VECTOR-EXPRESSION-PARITY-001`, not resolved here) and refuses a third.

**Triggers and the foreign key.** Both named `papers` triggers are UPDATE-only, so an INSERT fires neither. The one INSERT-time trigger is the internal `papers_user_id_fkey` check against `auth.users(id)`. PostgreSQL runs it as the referenced table's owner, so `authenticated`, which holds no privilege on `auth.users`, needs none. The migration pins all twelve triggers, the foreign key and the fact that no user-defined trigger fires on INSERT. None is modified, and the browser is granted nothing on `auth.users`.

**The broad `WHEN OTHERS` handler — kept, by decision.** C53 is mode-only and does not change the handler. Under INVOKER, caller-specific drift that cannot occur under DEFINER — a revoked `papers` INSERT or SELECT, revoked sequence `USAGE`, revoked EXECUTE on a default, generated-column or CHECK function, or a policy that refuses the caller — surfaces as a per-row `status: "error"` object at HTTP 200 when it hits the INSERT, not as an RPC error. That is accepted, because:
- it fails closed: nothing is written and no other account's data is returned;
- legitimate behavior is unchanged;
- the importer already turns a failed RPC chunk into one failed row per paper, so the user sees the same failed items either way;
- no UI shows `error_message`.

Drift that strikes **inside** the duplicate handler — for example column `SELECT` on `pmid`/`doi` — is not caught by that same block. It escapes as an RPC-level error and rolls the whole call back. Narrowing the handler, for example with `WHEN insufficient_privilege THEN RAISE`, would be a separate body and API change with its own review. It is not part of C53.

**Evidence (local, rolled back — not a Production exploit).**
- **Suite `023`** (73 assertions) owns the change:
  - posture and boundary: `anon`, `service_role` and PUBLIC refused, and the `papers` grants, policies, sequence grant, INSERT-time trigger and identifier indexes pinned;
  - legitimate behavior: minimal, full-metadata, NULL-optional, multi-row, mixed and empty payloads, with defaults and generated columns;
  - the identity guard: foreign, NULL and missing identities fail with `P0001` before any per-row handling and write nothing;
  - duplicate resolution: owned PMID, owned DOI, case folding, one row named twice, two rows named, another account's identifiers, an intra-batch duplicate and the zero-candidate branch;
  - **RLS as the primary boundary**, on a guard-free INVOKER copy of the body:
    - it cannot write another account's row (G1) or learn its paper id (G2);
    - the INSERT and SELECT policies each block alone;
    - opening only the new-row checks still hides the other account's rows from the lookup (G5, with a control proving the checks were really open);
    - opening both policies lets the crossing through (G6, negative control), and so does the same copy as SECURITY DEFINER;
  - **caller privilege drift**: revoked INSERT, SELECT, sequence `USAGE`, generated-column EXECUTE and CHECK-function EXECUTE each give per-row `error` and write nothing, with a DEFINER contrast. Drift inside the handler gives an RPC-level `42501` that rolls the whole call back.
- **Regression inversion.** Reverting the function to SECURITY DEFINER in scratch copies of all 24 suites fails 14 assertions across `003` (4), `006` (1), `009` (1), `015` (3), `021` (3) and `023` (2, one of them behavioral: the INSERT-revoked drift call inserts again).
- **Migration controls.** The migration refuses 35 kinds of precondition drift before its ALTER and 12 kinds of postcondition drift before COMMIT, with a whole-catalog fingerprint byte-identical after each probe.
- **PostgREST (local stack).** Valid insert, own duplicate, malformed row, identity mismatch (`400 P0001`), `anon` (`401 42501`) and another account's PMID returned identical HTTP status and bodies as INVOKER and as DEFINER. Revoked INSERT returned `200` with per-row `error`s and wrote nothing. Handler drift returned `403 42501` and wrote nothing.
- **Importer outcome.** Vitest runs the real `processChunkedInsert` through both `bulkImportPapers` and `bulkImportFromParsedData`. It proves that a failed RPC chunk and a successful RPC with one `error` row per paper give the same failed items, counts and toast. In both shapes the following chunk is still imported, and nothing is counted as added or skipped that was not.
- **Production, read-only.** The migration's own §0/§1 preconditions passed inside a read-only, rolled-back transaction (`transaction_read_only = on`), at preparation and again immediately before the apply.

**Inventory.** C53 took `public` SECURITY DEFINER functions **33 → 32**, the `authenticated`-callable ones **25 → 24**, and C50's `public, pg_temp` definer group **30 → 29**; the **3** audited exceptions are unchanged. That holds on a replay and, since the 2026-09-27 rollout, in Production. On a replay the `public` SECURITY INVOKER inventory went **13 → 14**, and the `authenticated`-only INVOKER RPC class **7 → 8**. Exactly this one function moved. For the same reason, the Security Advisor's `authenticated_security_definer_function_executable` went **25 → 24** in Production: the function is no longer an `authenticated`-callable SECURITY DEFINER function. That is not "1 of 25 vulnerabilities fixed". The remaining 24 are not 24 defects. They are the functions the C49 audit found intentionally privileged, retained function by function as privileged contracts, and each stays classified that way, not by its presence in the advisor list.

**History, unchanged.** C49's inventory of eight candidates stands as recorded. At C50's rollout this function was correctly part of the `public, pg_temp` SECURITY DEFINER group, and C50's **32 + 3** is that rollout's record. C52's rollout left Production at **30 + 3** (33 / 25); since the C53 rollout Production is at **29 + 3** (32 / 24). C52 is not touched.

**Not in scope, unchanged.** Narrowing the `WHEN OTHERS` handler; `DB-SEARCH-VECTOR-EXPRESSION-PARITY-001`; C49's five read RPCs; C52's two writes; the 24 retained definers and C50's 3 exceptions; C51's helpers; C30.

**Privacy.** Authority reduction only: no data category, recipient, retention or processor changes, and no Privacy Policy amendment ([privacy-data-flow-audit.md](privacy-data-flow-audit.md)).

**Re-evaluation triggers:**
- an import that legitimately needs to write or read rows beyond the caller's RLS view. Making the function SECURITY DEFINER again needs a new, explicit security justification and S1's guard; it is never a silent revert;
- any change to `papers`' INSERT or SELECT grants, to `papers_insert_order_seq` USAGE, to its policies (a RESTRICTIVE one included) or to FORCE RLS, which is now a change to this function's boundary — and, through the kept handler, a change that would show up as per-row import failures;
- a new user-defined `papers` INSERT trigger, which would fire as the caller;
- a change to what a `papers` default, generated column, CHECK constraint or index expression calls, or to EXECUTE on those functions — including the resolution of `DB-SEARCH-VECTOR-EXPRESSION-PARITY-001`;
- a body change, including narrowing the exception handler, which needs its own review;
- a change that would make `authenticated` (or any client role) BYPASSRLS.

### C54. `papers.search_vector` has one canonical generation expression: the direct built-in representation (2026-09-27)

**Status: COMPLETE — LIVE in Production since 2026-09-27.** Migration `20260927161343_canonicalize_papers_search_vector_expression.sql` implements it (`DB-SEARCH-VECTOR-EXPRESSION-PARITY-001`, from the read-only audit `DB-SEARCH-VECTOR-EXPRESSION-PARITY-AUDIT-001`). PR #313 merged as `05ca045476f67ef9ccee5e23936b1b47acee6adb` (approved head `e10eaba6c309eaea4014e87c40a9f056a03fb80f`). The separately authorized migration-only rollout applied it on 2026-09-27 with `supabase db push --linked --yes` (Supabase CLI 2.111.0, between 19:51:53Z and 19:52:27Z, exit 0, exactly one migration, no seeds and no roles; ledger **93 → 94**, latest `20260927161343`; [deployment.md](deployment.md) §6.15).
- **What "live" means here.** Production's column was **not** rewritten. Production already stored the canonical expression, so the migration took its verified **no-op** branch there, and its ledger row is the only durable database change it made. What is live is the convergence: clean replays and Production now end on the same direct expression, and their migration histories are aligned through C54.
- **Repository and clean replay.** Every database built from this repository ends with exactly one `search_vector` representation: the direct built-in expression `8ddd960b4f4b11dd7afd35485d01fd25` (rendered under `search_path = pg_catalog, pg_temp`). Before C54, a replay ended on the wrapper representation `dd69f099a274a9cdc0f174ae0883ddb6`. Suite `024` owns this single-representation contract.
- **Production before the rollout.** It **already** stored that same direct expression, and had since April 2026. Verified read-only at preparation and again immediately before the apply: PostgreSQL 17.6; ledger **93**, latest `20260927123856` (C53); C54 absent; `search_vector` attnum 29, attrdef OID `59954`, F1 `8ddd960b…`; its normal dependencies exactly its six input columns and `pg_ts_config english`; `idx_papers_search_vector` (OID `61100`) valid and ready; the three wrappers (OIDs `66407`–`66409`) had zero dependents. Production needed no search-vector rewrite, and got none.
- **Live posture, verified read-only after the apply** (and again on 2026-09-27 for the documentation reconciliation):
  - PostgreSQL 17.6; ledger **94**, latest `20260927161343`, present exactly once.
  - `search_vector` is still F1 `8ddd960b…`, with weights A/B/C/C/C/D and no wrapper dependency. It calls exactly `setweight(tsvector,"char")`, `to_tsvector(regconfig,text)` and `tsvector_concat(tsvector,tsvector)` (OIDs 3624, 3745, 3625), all executable by `authenticated`. Attnum 29 and attrdef OID `59954` are unchanged.
  - `papers` (OID `17492`, relfilenode `59955`), its TOAST relation (`59958`) and `idx_papers_search_vector` (OID and relfilenode `61100`; valid, ready, live; GIN over `search_vector`) are physically unchanged.
  - The three wrappers are still present with unchanged bodies, `proconfig` and ACLs, and 0 / 0 / 0 dependents. C54 did not retire them.

> **Follow-up: C55 (2026-09-28) — COMPLETE, LIVE IN PRODUCTION since 2026-09-28.** Where this entry says the three `immutable_english_tsvector_*` wrappers remain present, unreferenced and pinned by suite `007`, that describes C54 at its completion, and it stayed Production's state until C55. C55's migration `20260927214838` retired them: its migration-only rollout dropped all three in Production on 2026-09-28 (ledger **94 → 95**). It does not change C54's decision, expression or rollout record. `search_vector` is still F1 `8ddd960b…` (attrdef `59954`), and `papers` (`17492` / `59955`) and `idx_papers_search_vector` (`61100` / `61100`) are physically unchanged. With C55, suites `007`, `015`, `022`, `023` and `024` were revised; suite `024` now checks the canonical expression against pinned golden values instead of the wrappers. C54 remains fully closed.

**Decision.** `papers.search_vector` has exactly one generation expression everywhere:

```sql
setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A')
|| setweight(to_tsvector('english'::regconfig, COALESCE(abstract, ''::text)), 'B')
|| setweight(to_tsvector('english'::regconfig, COALESCE(journal, ''::text)), 'C')
|| setweight(to_tsvector('english'::regconfig, COALESCE(authors::text, ''::text)), 'C')
|| setweight(to_tsvector('english'::regconfig, COALESCE(keywords::text, ''::text)), 'C')
|| setweight(to_tsvector('english'::regconfig, COALESCE(notes, ''::text)), 'D')
```

It calls three built-ins, compared by OID: `setweight(tsvector,"char")`, `to_tsvector(regconfig,text)` and `tsvector_concat(tsvector,tsvector)`. `authors::text` and `keywords::text` are output-function coercions through `jsonb_out`, which is IMMUTABLE. The column keeps its attnum, type, STORED generation, nullability and GIN index. The canonical term for this form is **direct built-in representation**. It is not "inlined" (see below).

**Why there were two representations — the corrected explanation.** Different SQL text was executed; nothing else.
- Production's column was created in April 2026 by the **original** text of `20260420010000` (commit `c6434de`), which called `to_tsvector('english', coalesce(<field>, ''))` directly (with `::text` on the two jsonb fields). Its attrdef, attnum and GIN index date from that one transaction.
- On 2026-05-18 (commit `e4c5931`), `20260305020000`, `20260417020000` and `20260420010000` were rewritten to call the `immutable_english_tsvector_*` wrappers so that a fresh replay would pass. The already-applied April versions were then recorded in Production with `supabase migration repair`, so their ledger rows store the **rewritten** statements, which never ran there. The wrappers first reached Production with `20260331010000` in that same push, after the column already existed.
- A clean replay executes the rewritten files and stores wrapper calls. Production stores what its original text said.

PostgreSQL did **not** turn wrapper calls into built-in calls while storing the expression. A generated-column expression is stored as parsed: a wrapper call stays a function-call node with a `pg_depend` edge on the wrapper, whatever the wrapper's `proconfig`. SQL-function inlining is a different mechanism, a planner step at execution time, and it never rewrites a stored expression.

**C26 stands, and is superseded only prospectively.** C26 (2026-07-19) correctly established that the two expressions store identical values, and deliberately kept both rather than rewrite Production. Both findings still hold: the corpus below re-proves the equivalence, and Production is still not rewritten. What was wrong was the later explanation of *why* the representations differed. C54 replaces the retained dual-representation posture from here on. It does not reclassify C26 as a mistake.

**Why converge, and why on the direct form.**
- Two shapes meant every later migration and suite touching `papers` had to accept both, as C51, C52 and C53 did.
- The wrapper shape carries hazards the built-ins do not:
  - `DROP FUNCTION … CASCADE` on a wrapper drops `search_vector` and its index;
  - `CREATE OR REPLACE` of a wrapper body leaves every stored vector computed by the old body, silently stale;
  - revoking wrapper EXECUTE breaks every INSERT and UPDATE of `papers`, because the expression is evaluated as the writing user.
- The built-ins are owned by the bootstrap superuser. The migration owner can neither replace, drop nor revoke them.
- Converging on Production's existing form means the one environment with real data needs no rewrite at all.

**How the migration converges — two accepted starting representations, and nothing else.**

| Starting representation | Recognised by | Branch |
|---|---|---|
| **Direct built-in** (hosted Production) | F1 `8ddd960b…`; dependencies exactly the six input columns, itself and `pg_ts_config english`; calls exactly the three built-ins | **No-op.** No ALTER TABLE, no explicit lock, no rewrite, no index rebuild, no ANALYZE, no row write. Validation reads only; the only durable effect of deploying it is its ledger row. **This is the branch Production took on 2026-09-27.** |
| **Clean-replay wrapper** | F1 `dd69f099…`; dependencies the six columns, itself and the text + jsonb wrappers; calls those two wrappers, `setweight` and `tsvector_concat`; all three wrapper bodies, paths and ACLs exactly reviewed | **Rewrite.** `lock_timeout` 5 s, ACCESS EXCLUSIVE on `papers`, every precondition re-checked under the lock, one `ALTER TABLE … ALTER COLUMN search_vector SET EXPRESSION AS (…)`, then `ANALYZE public.papers (search_vector)`. |

Any third expression, dependency set or call set is refused before any lock or change.
- **Semantic precondition (validation only).** Before either branch proceeds, every stored `search_vector` must already equal the canonical expression over its own row, as a `tsvector` and byte for byte (`tsvectorsend`). Nothing is modified to make it hold. The file runs with `row_security = off` as a role that bypasses RLS, so the check sees every row or fails loudly.
- **Pinned and preserved.** The wrappers' bodies, paths, volatility, parallel mode, owner and ACL (either reviewed form: NULL on a replay, explicit in Production); the built-ins' properties, including that no `to_tsvector(text,text)` exists; the column's dependents (exactly its default and the index); `papers`' owner, grants, RLS/FORCE RLS, columns, other defaults, six constraints, seven indexes, named triggers and policy digest. Signatures are resolved one per row or read as OIDs; no list is joined and split on commas.
- **Verified before COMMIT, both branches.** Exactly the canonical expression, dependencies and calls; `authenticated` can EXECUTE each callee; no `papers` default depends on a wrapper; same attnum, type, generation and nullability; the column's dependents unchanged; the search index present, valid, ready, live and GIN(`search_vector`); `papers`' logical state identical (table, every `pg_attribute` row, comments, other defaults, constraints on or referencing it, every index definition and `pg_index` row, policies, triggers, the sequence, every `public` function, every other `public` relation); the canonical expression reproduces every stored value; no row written.
  - **No-op branch, additionally:** the heap and TOAST files, every index OID and file, and the `search_vector` default's row and dependency rows are **physically identical**, and the transaction never held a lock stronger than ACCESS SHARE on `papers` or its indexes.
  - **Rewrite branch, additionally:** the row count, every other column row by row, and every stored vector byte for byte are identical before and after, and the column has fresh statistics. `SET EXPRESSION` legitimately moves the heap, TOAST and index files and gives `idx_papers_search_vector` a new OID; none of that is treated as a failure there.

**What does not change.** Search results, ranking and all six `matched_*` flags; field weights A (title), B (abstract), C (journal, authors, keywords), D (notes); the text-search configuration; the three wrappers themselves (no drop, ALTER or re-grant: they keep C51's `pg_catalog, pg_temp` path, and suite `007` keeps pinning them); every grant, policy and RPC. The cross-field `matched_*` attribution limitation is unchanged and out of scope. Generated types are unchanged.

**Evidence (local, PostgreSQL 17.6, rolled back or on disposable replays — plus two read-only Production runs and the rollout itself).**
- **Suite `024_search_vector_expression_parity`** (87 assertions) owns the final-state, single-representation contract:
  - shape: expression text, digest, complete dependency set, no wrapper dependency anywhere, calls by OID, callee properties and `authenticated` EXECUTE, the two jsonb coercions, the column's dependents, the index;
  - field weights, and one exact expected `tsvector`;
  - recomputation on a browser INSERT and on an UPDATE of each input;
  - a 33-case corpus: the canonical and the former wrapper expression are equal as `tsvector` and byte for byte. It covers SQL NULL, empty, whitespace, punctuation, case, prose, stopwords, numbers, Unicode scripts, composed and decomposed accents, emoji/ZWJ, empty/nested/scalar/mixed/null/escaped JSON, quotes and backslashes, SQL- and tsquery-like text, URLs, swapped JSON order, an over-long word, the 16383-position clamp and 255-positions-per-lexeme cap, about 200 KB of text, the six isolated fields and all six together. An over-limit input fails identically in both;
  - `search_papers` rows, ranks and flags identical over 32 queries before and after the column is rewritten to the wrapper form in-transaction; field-isolated ranks A > B > C = C = C > D with exactly the right flag; the GIN index serves `@@`;
  - detection: the wrapper form and a wrong-configuration built-in form are both flagged, and the canonical text restores the canonical shape.
- **Suites `022` and `023`.** Their tests that revoked wrapper EXECUTE and expected the write to fail no longer describe a real dependency and were replaced. Revoking the old wrappers now affects neither the INVOKER writes nor a direct browser write. The generated-column dependency itself is still proven, with a transaction-local probe column on a revoked probe function. The callee set is pinned by OID. `022` 91 → 95, `023` 73 → 76. Suite `015`'s allowlist labels for the wrappers were corrected.
- **Regression inversion.** With the migration absent (the old final replay), the suites fail 17 assertions: `024` 9, `022` 5, `023` 3. With the direct expression deliberately altered, they fail 18 (`'simple'` for the title) and 17 (notes weighted C), mostly in `024`.
- **Migration controls** on copies of the real file, each leaving a whole-catalog and data fingerprint byte-identical:
  - from the wrapper state: 1 positive control and 39 refusals. These are 32 before any change — third expressions, missing `COALESCE`, `'simple'`, a wrong weight, two changed JSON serialisations, wrapper body, path and ACL drift, an injected dependency, a dependent view and statistics object, a missing, invalid or redefined search index, eight structural drifts (a constraint, an index, a grant, FORCE RLS, a column, a policy, a trigger, a default), two stale-vector cases, `authenticated` BYPASSRLS, a revoked built-in, two wrong roles, a runner without BYPASSRLS, an unbounded `lock_timeout` and running outside a transaction — and 7 after the rewrite;
  - from the direct (Production-shaped) state: 1 positive control, 13 precondition refusals and 7 no-op postcondition refusals. The postcondition ones include an identical `SET EXPRESSION`, a REINDEX, an explicit ACCESS EXCLUSIVE lock, an ANALYZE and a row write slipped into the no-op branch — each refused;
  - lock contention: through the real CLI runner, a session holding ACCESS SHARE blocked the rewrite branch (`pg_blocking_pids` named it, on an ungranted AccessExclusiveLock); the migration was refused with `55P03` after `lock_timeout`, wrote no ledger row and changed nothing. The same held, through psql, for a ROW EXCLUSIVE holder. The no-op branch completed in about 0.2 s while other sessions held ACCESS SHARE or ROW EXCLUSIVE.
- **Positive runs through the real CLI (`supabase migration up --local`).**
  - Wrapper → direct in 1.4–1.6 s on 89 fixture rows: logical structure, every row's data and 40 `search_papers` queries (ranks and flags) identical; heap, TOAST and index files moved as expected.
  - On the Production-shaped direct state, 116 physical and catalog lines were compared: heap, TOAST and index OIDs and files, catalog-row xmins, attrdef OIDs, `pg_statistic` xmins, row ctids and xmins. Exactly one changed: the ledger.
- **Production, read-only, at preparation.** The **real migration file** was executed against Production inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`. It classified Production as the no-op branch and passed every precondition and postcondition, the all-rows semantic check included. It held only ACCESS SHARE, was never assigned a transaction ID, and changed nothing (the ledger was then 93).
- **Production rollout, 2026-09-27** ([deployment.md](deployment.md) §6.15).
  - Immediately before the apply, the exact merged file (identical to the approved head) was run again against Production with only its `BEGIN;` and `COMMIT;` replaced by `BEGIN TRANSACTION READ ONLY;` and `ROLLBACK;`. It chose `noop`, passed every check, held only ACCESS SHARE on `papers` and its indexes and no stronger relation lock anywhere, and was never assigned a transaction ID.
  - A 165-value catalog snapshot taken immediately before and after the apply differed in exactly six values, all of them ledger fields: the count, the latest version, and the C54 row's presence, name, statement count and statement digest. Everything else was identical:
    - F1, attnum, the attrdef row (OID, xmin, content) and its dependency rows, and the column's `pg_attribute` row;
    - the heap relfilenode and `pg_class` xmin; the TOAST relation, file and index; all seven `papers` index OIDs, relfilenodes and xmins;
    - `papers`' owner, ACL, column ACLs, RLS and FORCE RLS, policies, constraints (the foreign keys referencing it included), triggers, defaults, generated columns and sequence;
    - the wrappers' rows, and every `public` function, relation, policy, constraint, trigger and default digest.
  - **No ANALYZE ran.** `papers`' manual `analyze_count` stayed 0, the `pg_statistic` digest and the `search_vector` statistics row's xmin were unchanged, and the last autoanalyze (2026-09-24) was unchanged. `ANALYZE public.papers (search_vector)` belongs to the replay's rewrite branch, which did not run in Production.
  - The ledger row's ten recorded statements each appear verbatim in the merged file. No Edge Function was deployed; all six versions predate the rollout.

**Effect on C51, C52 and C53 (their re-evaluation triggers named this resolution).**
- **C51** ("which search-vector shape is expected where"): now one shape everywhere. The three wrappers keep C51's path and suite `007`'s pins. They are simply no longer referenced by `search_vector`.
- **C52 and C53** ("a change to what `search_vector` calls, or to EXECUTE on those functions"): the expression now calls only three built-ins, executable by `authenticated` through their default PUBLIC EXECUTE and not revocable by the migration owner. The INVOKER conclusions hold with one drift class fewer, because revoking a wrapper no longer breaks any write. Their applied files are unchanged. C52's §1g comma-split checker defect is unaffected, and `DB-MIGRATION-SIGNATURE-PARSING-AUDIT-001` stays a separate task.

**Correction of the historical record — applied files untouched.** Historical migration comments describe Production's form as "inlined", and `20260810152125` says PostgreSQL "inlines simple SQL functions when it stores a generated-column expression". The parity audit established that this was wrong: Production and a clean replay stored different expressions because different migration SQL text was executed. Related wording appears in `20260719162013` ("the production inline `to_tsvector` form") and in C51's `20260927001229` ("the inlined built-in form"); the C51–C53 rollout records in [deployment.md](deployment.md) used it too. `20260305020000`'s header is also wrong on two facts: no `to_tsvector(text,text)` overload exists, and `jsonb_out` is IMMUTABLE. Applied migration files remain untouched as immutable history. This entry, the new migration's header, suites `022`–`024`, and correction notes in C51 below, [deployment.md](deployment.md) §6.12–6.14, [migration-history.md](migration-history.md) and [schema-reconciliation.md](schema-reconciliation.md) record the correction.

**PostgreSQL and Supabase versions.** Production and the local stack are PostgreSQL 17.6, and Production stayed on 17.6 throughout the C54 rollout. Supabase announced 17.11 on 2026-09-25, with upgrades available from 2026-09-28 and started by the project owner. 17.11 hardens `tsvector`/`tsquery` length limits (CVE-2026-14662). Both representations call the same `to_tsvector(regconfig,text)`, so any change affects them identically, and the migration's semantic precondition re-validated every stored value at rollout. **Limitation:** no 17.11 image was available for an exact-version local reproduction. C54 was applied on 17.6, before the upgrade window opened, so the planned pre-rollout re-check on 17.11 was never needed.

**Not in scope, unchanged.** Retiring the three wrappers (a separate future decision — now C55, live in Production since 2026-09-28); `DB-MIGRATION-SIGNATURE-PARSING-AUDIT-001`; redesigning `matched_*` attribution; the 17.11 upgrade; C30.

**Privacy.** Schema-representation convergence only: no data category, recipient, retention or processor changes, and no Privacy Policy amendment ([privacy-data-flow-audit.md](privacy-data-flow-audit.md)).

**Re-evaluation triggers:**
- a database whose `search_vector` is neither reviewed representation (for example a new hosted environment), which the migration refuses — stop and re-review; do not edit the migration to fit (Production took the reviewed no-op branch on 2026-09-27);
- any change to `search_vector`'s inputs, weights, configuration or expression — it must stay one canonical representation, pinned deliberately in suite `024` and a new decision;
- a PostgreSQL upgrade that changes `to_tsvector('english', …)` output — stored vectors would need recomputation; suite `024` and the migration's semantic check are where it shows;
- retiring the wrappers — suites `007`, `015` and `024` reference them *(fired 2026-09-28: C55)*;
- a new reader or writer of `papers` that needs a function in the expression it cannot EXECUTE.

### C55. The three obsolete `immutable_english_tsvector_*` wrappers are retired (2026-09-28)

**Status: COMPLETE — LIVE IN PRODUCTION since 2026-09-28.** Migration `20260927214838_retire_immutable_english_tsvector_wrappers.sql` implements it (`DB-IMMUTABLE-TSVECTOR-WRAPPER-RETIREMENT-001`, from the read-only audit `DB-IMMUTABLE-TSVECTOR-WRAPPER-RETIREMENT-AUDIT-001`, which classified all three **SAFE TO RETIRE**). PR #315 merged as `6d17f68c62d8531ef10ef831453da7f09208b0c2` (approved head `12ce5fdba034c3bf1dd3714601877e6149a4a032`). The separately authorized migration-only rollout applied it on 2026-09-28 with `npx supabase db push --linked --yes` (Supabase CLI 2.111.0, between 06:22:05Z and 06:23:01Z, exit 0, exactly one migration, no seeds and no roles; ledger **94 → 95**, latest `20260927214838`; [deployment.md](deployment.md) §6.16).
- **Production at preparation** (read-only, 2026-09-28): PostgreSQL 17.6; ledger **94**, latest `20260927161343` (C54, present once); `search_vector` F1 `8ddd960b…`; `idx_papers_search_vector` valid, ready and live. The three wrappers are OIDs `66407` (`text`), `66408` (`textarr`) and `66409` (`jsonb`). Each is `postgres`-owned, `sql`, SECURITY INVOKER, IMMUTABLE, PARALLEL SAFE, not strict and not leakproof, returns `tsvector` and has `search_path=pg_catalog, pg_temp`. Bodies are `26edc211…` / `19261084…` / `30c015cd…`. All three carry the explicit ACL `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` and have zero dependents and zero routine-body references. `public` has 46 functions, five with PUBLIC EXECUTE: the three wrappers, `set_updated_at()` and `update_updated_at_column()`.
- **Production after the rollout** (read-only, immediately after the apply and again on 2026-09-28 for the documentation reconciliation):
  - PostgreSQL 17.6; ledger **95**, latest `20260927214838`, present exactly once. Each of its ten recorded statements appears verbatim in the merged file.
  - The three signatures no longer resolve, OIDs `66407`–`66409` no longer exist, and no function of those names exists in any schema.
  - `public` has **43** functions (46 before). Exactly two are PUBLIC-executable (five before): `set_updated_at()` and `update_updated_at_column()`, unchanged. C55 did not harden them.
  - **The only durable database changes were the migration-ledger entry and removal of the three target function objects.** A fingerprint taken immediately before and after the apply was otherwise identical:
    - the migration's own 16-category snapshot;
    - the xmins of every other function, database-wide, and of every `public` catalog row;
    - `search_vector`: F1 `8ddd960b…`, attrdef `59954` and its dependencies, the direct call set `setweight(tsvector,"char")`, `to_tsvector(regconfig,text)` and `tsvector_concat(tsvector,tsvector)`, and weights A/B/C/C/C/D;
    - `papers` (OID `17492`, relfilenode `59955`), its TOAST relation `59958`, and all seven `papers` index OIDs and relfilenodes, with `idx_papers_search_vector` still `61100` / `61100`, valid, ready and live;
    - `pg_statistic` for `papers`, and every `public` table's write counters.
  - Inside its own transaction the migration verified no lock of any mode on a `public` relation and no application row written. There was no table rewrite, index rebuild, data canary or application-data migration.
  - PostgREST refreshed its schema cache automatically through the drop event trigger; no manual `NOTIFY pgrst` was needed or sent. A bounded anonymous call to `rpc/immutable_english_tsvector_text` with a fixed input answered 200 before the rollout and 404 `PGRST202` after. That is the intended response for a retired RPC, not an application error.
  - Linked type generation contains no wrapper entry, so Production's function surface and the committed generated types agree again. The linked output differs from the committed file only in formatting (an `__InternalSupabase { PostgrestVersion: "14.5" }` block and optional parentheses in helper generics), not in schema.
  - The Security Advisor is unchanged: 24 × `authenticated_security_definer_function_executable`, 6 × `rls_enabled_no_policy` and 1 leaked-password warning, none naming a wrapper. C55 was not expected to move it, since the wrappers were SECURITY INVOKER.

**Decision.** Drop exactly these three functions, each by its complete signature, with `RESTRICT`:

```sql
DROP FUNCTION public.immutable_english_tsvector_text(text) RESTRICT;
DROP FUNCTION public.immutable_english_tsvector_textarr(text[]) RESTRICT;
DROP FUNCTION public.immutable_english_tsvector_jsonb(jsonb) RESTRICT;
```

Nothing else changes. No table, column, index, default, constraint, policy, trigger, grant, default privilege or other function is touched, and no `ALTER DEFAULT PRIVILEGES` is issued. `public` goes from **46 to 43** functions, and its PUBLIC-executable functions go from **five to exactly two**, the live trigger functions `set_updated_at()` and `update_updated_at_column()`. Those two are out of scope and unchanged.

**Why — an obsolete surface, not a vulnerability.** The wrappers are SECURITY INVOKER, read no table, have no side effect and cannot bypass RLS. Retiring them is **not** a privilege-escalation fix, a breach response or a critical-vulnerability repair. They go because:
- no supported runtime consumer calls them: no application, Edge Function or extension code, and they were never a documented API;
- no database object depends on them: since C54 `search_vector` calls only `setweight(tsvector,"char")`, `to_tsvector(regconfig,text)` and `tsvector_concat(tsvector,tsvector)`;
- PUBLIC EXECUTE nevertheless made all three callable by `anon` as Data API RPCs. On a clean replay they were the only RPCs in `anon`'s OpenAPI document, and they appeared in the generated client types;
- the function and ACL inventory gets simpler.

**Chronology — nothing earlier was wasted.**
- `20260305020000` / `20260331010000` created the wrappers for the stored search expression.
- From the 2026-05-18 rewrite of the search migrations until C54, every clean replay stored `search_vector` as calls to the text and jsonb wrappers (C26, C54).
- PFA-C08 (`20260810152125`) and C51 (`20260927001229`) correctly hardened their `search_path` while they were part of that boundary.
- C54 converged every environment on the direct built-in expression and deferred retirement.
- C55 retires them.
- `textarr` needs a precise statement. On a clean replay it was in the stored expression only transiently: `20260305020000`'s generated column used it while `authors` was still `text[]`, and `20260331010000` rebuilt that column. Production's current column never used it.
- The applied historical files are immutable and are **not** edited. A clean replay creates the wrappers, uses and hardens them, has C54 remove the last dependency, and has C55 drop them. That is expected, and needs no `migration repair`.

**Historical semantics, for the record.** Each wrapper was `SELECT to_tsvector('english'::regconfig, COALESCE(<arg>, ''))` over its argument: `t` (text), `arr::text` (text[]) or `j::text` (jsonb). The application needs only the canonical direct expression's semantics, which suite `024` now pins independently. No `text[]` behaviour is retained as a contract.

**How the migration is gated — two independent layers.**
- **Fail-closed preconditions**, before any change. Each target must be exactly the reviewed function:
  - signature (one complete signature per row, never a comma-joined list), owner, language, kind, security mode, volatility, parallel mode, strictness, leakproofness, result, argument names, `proconfig`, body digest, cost, rows, support function and comment;
  - no other function in any schema shares a target name;
  - the three ACLs share one of the two reviewed forms: NULL on a clean replay, or the explicit hosted form.

  Nothing may depend on or refer to a target:
  - `pg_depend`;
  - every stored expression node tree: defaults and generated columns, CHECKs, index expressions and predicates, view and rule actions, policies, trigger WHEN clauses, extended statistics, publication filters and SQL-standard bodies;
  - every function-OID catalog column: triggers, event triggers, casts, operators, aggregates, types, ranges, languages, transforms, support functions and operator-class support;
  - the text of every routine body, and of `pg_cron` jobs where that extension exists.

  The rest of the reviewed state must also hold:
  - `search_vector` is still C54's canonical F1, dependency set and call set;
  - `idx_papers_search_vector` is valid, ready and live;
  - `public` holds 46 functions with exactly the reviewed five PUBLIC-executable.
- **`RESTRICT`**: PostgreSQL itself refuses a drop that anything depends on. `CASCADE`, `IF EXISTS` and name-only or discovered drops are never used.
- **Postconditions before COMMIT:**
  - the three signatures, OIDs and names are gone;
  - every other function is unchanged: `public` rows whole, and database-wide by OID;
  - every `public` relation, column, default, constraint, index, policy, trigger, rule and type is unchanged, as are every default privilege, the `public` schema, the event triggers, the search column and the search index;
  - 43 functions, with exactly two PUBLIC-executable;
  - no lock of any mode on any `public` relation;
  - no application row written.

**Production effect — projected before the rollout, and observed** (the outcome is recorded above; the lock footprint was measured locally, and in Production the migration's own postcondition proved no `public` relation was locked):
- ledger **94 → 95**;
- exactly three function drops, taking ACCESS EXCLUSIVE on the three function objects only;
- no lock on `papers` or any other relation, no table rewrite, no index rebuild and no application-data write;
- the DROP fires the platform's `sql_drop` event trigger (`pgrst_drop_watch`), so PostgREST reloads its schema cache and the three RPC names stop resolving.

The Security Advisor's counts were not expected to change, and did not: the wrappers were INVOKER, and no Advisor lint named them.

**Implementation evidence** (gathered before the rollout: local, PostgreSQL 17.6, rolled back or on disposable replays; Production read-only only).
- **Migration controls on the real file**, each leaving a whole-catalog, dependency, ledger and `papers`-data fingerprint byte-identical:
  - **24 precondition refusals**, none reaching the first DROP:
    - a missing target;
    - drift in body, owner, security mode, volatility, `proconfig` or strictness;
    - a mixed or uniform unreviewed ACL;
    - an overload in `public`, or a same-named function in another schema;
    - a dependent view or CHECK;
    - a view whose `pg_depend` edge was deleted (caught by the node-tree scan alone, which `RESTRICT` would have missed);
    - a PL/pgSQL body and a dynamic-SQL body naming a target;
    - the old wrapper-form `search_vector`;
    - a built-in form with the wrong configuration;
    - an invalid, and a not-ready, search index;
    - a 47th `public` function;
    - an extra PUBLIC-executable function;
    - the wrong executing role;
    - running outside a transaction.
  - **9 postcondition refusals** after the drops: another `public` function changed, a function elsewhere dropped, a relation ACL, default privileges, a policy, a column ACL, a lock on `papers`, an application row, and a rewritten `search_vector`.
- **Positive runs.**
  - The clean-replay NULL ACL and the hosted explicit ACL both pass, and end in the same catalog fingerprint.
  - A committed run on 25 fixture papers changed exactly one thing, the wrapper count. Heap, TOAST and all seven index OIDs and relfilenodes are unchanged, as are the catalog-row xmins, `pg_statistic`, and every row's ctid, xmin, content and stored vector.
  - The only locks taken were ACCESS EXCLUSIVE on the three `pg_proc` objects and ACCESS SHARE on system catalogs.
  - Through the real CLI (`supabase migration up --local`), before the change `anon`'s OpenAPI listed exactly the three RPCs and each answered 200. Afterwards `anon` has none, `service_role` has only `refund_ai_quota`, and each call returns 404 `PGRST202` ("Could not find the function … in the schema cache").
- **Negative `RESTRICT` control.** Inside a rolled-back transaction, with the wrapper-form `search_vector` re-induced, the text and jsonb drops fail with `2BP01` naming `column search_vector of table public.papers`. `textarr` drops, since it was not in that expression. Nothing persisted.
- **Suites.**
  - `007`: **71 → 30**. The wrapper inventory, path, posture, ACL and 24 equivalence assertions go. `attachment_cleanup_path_is_safe` and `set_updated_at()` keep every pin. One new assertion requires that no function of the three names exists in any schema.
  - `015`: plan unchanged at **106**. The three allowlist rows go, and ACL-H1's inventory is eleven, where it was fourteen.
  - `022` / `023`: plans unchanged at **95 / 76**. The REVOKE/GRANT simulation goes, and the same assertions now show both INVOKER writes, the import and direct browser writes succeed with the wrappers gone.
  - `024`: **87 → 90**. A golden oracle replaces the wrapper comparison, which was never independent because the wrapper body was the same `to_tsvector` call. Each of the 33 corpus rows pins its lexeme count and `md5(tsvectorsend(…))`, identical on a clean replay and in Production. A coverage guard (+1) requires exactly one golden value per corpus row.

    The over-limit case now goes through a real browser INSERT through the generated column (`54000`) and proves no row remains (+1). The function-wrapped rewrite and detection use a transaction-local `public.zz_024_probe_tsvector(text)`, and a new assertion proves `DROP FUNCTION … RESTRICT` refuses a function the column depends on and names the column (+1). An explicit absence assertion replaces the old wrapper-dependency count. Two negative controls confirm the oracle is independent: an altered expression fails every row with keyword content, and one swapped golden value fails exactly that row.
  - **Regression inversion.** With the wrappers re-created after C55, `007` (the classified `pg_catalog` inventory and the absence check), `015` (ACL-H1, H2 and H3) and `024` (absence) fail.
- **Generated types**: exactly the three RPC entries removed (−6 lines, no additions), generated with `supabase gen types typescript --local --schema public`.
- **Full lifecycle**, the hosted-ACL parity lane and the application gates: see [migration-history.md](migration-history.md).

**Rollback — forward only; none has been performed.** Do not edit C55, and do not `migration repair` its legitimate application. If an unforeseen consumer appears, write a new forward migration that re-creates the exact reviewed definitions (bodies in `20260331010000`, `search_path` per C51) and restates the intended EXECUTE ACL explicitly. Plain `CREATE FUNCTION` reproduces the reviewed body digests, verified locally. The resulting ACL depends on the environment's default privileges: NULL under replay defaults, or the explicit hosted literal under Production's current defaults. So the restoring migration must state the intended ACL rather than rely on either.

**Not in scope, unchanged.** `set_updated_at()` and `update_updated_at_column()` (grants and definitions); default function-EXECUTE hardening and every `ALTER DEFAULT PRIVILEGES`; `DB-MIGRATION-SIGNATURE-PARSING-AUDIT-001`; database `TEMP`; service-role least privilege; C54's decision; historical migrations; the frozen hosted-ACL parity fixtures (`scripts/acl-parity/hosted-baseline-20260904120000.*`), which describe the 2026-09-04 baseline and still replay it exactly.

**Privacy.** Removes three unused callable functions. No data category, recipient, retention or processor changes, and no Privacy Policy amendment ([privacy-data-flow-audit.md](privacy-data-flow-audit.md)).

**Re-evaluation triggers:**
- a caller of any of the three names discovered after the rollout — stop, and restore by a new forward migration as above;
- a database whose state differs from the reviewed one (for example a new hosted environment), which the migration refuses — stop and re-review; do not edit the migration to fit (Production passed the reviewed preflight and was retired on 2026-09-28);
- a PostgreSQL or text-search change that moves a golden value in suite `024` — review each row that moved, then update the golden table deliberately;
- the separate default function-EXECUTE hardening decision, which is where the two remaining PUBLIC-executable trigger functions belong *(fired 2026-09-28: C56, applied to Production 2026-09-28)*.

### C56. The two updated_at trigger functions are owner-only, and functions `postgres` creates are default-deny for EXECUTE (2026-09-28)

**Status: COMPLETE — applied to Production 2026-09-28.** Migration `20260928133918_harden_default_function_execute.sql` implements it (`DB-DEFAULT-FUNCTION-EXECUTE-HARDENING-001A`). It follows the read-only audit `DB-DEFAULT-FUNCTION-EXECUTE-HARDENING-AUDIT-001`, which classified both functions **SAFE TO REVOKE DIRECT CLIENT/PUBLIC EXECUTE** and the future default posture **HARDEN DEFAULTS**. It merged as `f5bb0c3d` (PR #317, approved head `82620e6e`). It was applied in a migration-only rollout (`DB-DEFAULT-FUNCTION-EXECUTE-HARDENING-001B`; [deployment.md](deployment.md) §6.17).

- **Production outcome** (observed read-only immediately after the apply, 2026-09-28):
  - ledger **95 → 96**, latest `20260928133918`, present once. `npx supabase db push --linked --yes` exited 0 and applied exactly this file, with no seeds and no roles.
  - Both functions are exactly `{postgres=X/postgres}`, and no API role holds effective EXECUTE on either. Their OIDs (`33584` / `53609`), bodies, owner, SECURITY INVOKER mode, volatility and `search_path`s are unchanged.
  - `public` keeps **43** functions, and PUBLIC-executable ones went **2 → 0**.
  - `postgres`'s global function entry is `f={postgres=X/postgres}`, and its `public` function entry is `{postgres=X/postgres,service_role=X/postgres}`, with `service_role` preserved.
  - Identical before and after:
    - the twelve triggers;
    - the other 41 function ACLs (digest `54a18e87…`) and every other function ACL in the database;
    - every other default-privilege entry;
    - every schema.
  - No probe object remains.
  - Security Advisor unchanged (24 × 0029, 6 × `rls_enabled_no_policy`, 1 leaked-password).
  - No Edge Function was deployed, and all six keep their versions. No application row was modified.

- **Production at preparation** (read-only, 2026-09-28):
  - PostgreSQL 17.6; ledger **95**, latest `20260927214838`; 43 `public` functions.
  - Exactly two are PUBLIC-executable: `set_updated_at()` (OID `33584`, body `301a8849…`, `search_path=pg_catalog`) and `update_updated_at_column()` (OID `53609`, body `ef6b2d76…`, `search_path=public`). Both carry the explicit ACL `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`.
  - Exactly 12 enabled `BEFORE UPDATE … FOR EACH ROW` triggers use them, and nothing else depends on them.
  - `postgres` has **no global** default-privilege entry. Its `public` function entry is `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`. A clean replay stores `NULL` for both functions' ACLs and `{postgres=X/postgres}` for that entry.

**Decision.** Exactly four privilege statements:

```sql
REVOKE ALL ON FUNCTION public.set_updated_at()           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
```

Afterwards both functions are `{postgres=X/postgres}` in every environment, and no `public` function carries PUBLIC EXECUTE. A function `postgres` creates later reaches no client role until its migration GRANTs it. No body, owner, security mode, `search_path`, OID, trigger, table, policy or row changes.

**Why the existing grants are surplus — least privilege, not an exposure fix.**
- PostgreSQL checks EXECUTE on a trigger function when `CREATE TRIGGER` runs, and never when the trigger fires.
  - PostgreSQL 17's documentation states the creation-time requirement and is silent on firing, so this was proven on this repository's exact image (17.6.1.084): owner-only, all twelve triggers still fire and advance `updated_at` for a role with no EXECUTE, and for real `authenticated` and `service_role` writes.
  - Production already relies on it. Five other `public` trigger functions, among them `handle_new_user()` (fired by GoTrue) and `clear_author_identity_links_on_authors_change()` (fired by browser writes), are owner-only.
- The grant conferred nothing useful:
  - a direct call raises `0A000` ("trigger functions can only be called as triggers");
  - PostgREST drops trigger functions from its schema cache. `rpc/set_updated_at` answers `404 PGRST202` in Production, even though `anon` holds EXECUTE there;
  - its one real capability was letting a client attach `set_updated_at()` to a TEMP table of its own.

  **This is not a data-exposure incident** and must not be described as one.

**Where the grants came from.** No migration ever granted them. PUBLIC comes from PostgreSQL's built-in default for functions. `anon`, `authenticated` and `service_role` come — on hosted Production only — from Supabase's per-schema `postgres`/`public` function default. That is why hosted Production stores the explicit five-entry form and a clean replay stores `NULL`: the same effective posture, in two representations. The migration accepts both, and both converge. C38's rationale for leaving function EXECUTE out of scope was imprecise on exactly these points; see the dated correction there.

**Why future defaults change, and why globally.**
- Today, a function whose migration forgets its ACL is executable by `anon` and `authenticated` everywhere.
- A migration that revokes only PUBLIC and `anon` leaves `authenticated` able to execute the function in Production but **not** on a clean replay, so no clean-replay test can see it. Neither CI lane catches this today.
- Per-schema default privileges are *added to* the global default. PostgreSQL 17 documents that a per-schema `REVOKE` "is only useful to reverse the effects of a previous per-schema GRANT". So `… IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` changes nothing. That includes running it as part of Supabase's documented opt-in: verified, a new function stays executable by `anon` and `authenticated`.
- The only default-privilege mechanism that removes PUBLIC is the global form, which is PostgreSQL's own documented example. The per-schema statement then removes Supabase's `anon`/`authenticated` entry. No narrower default mechanism exists. An event trigger or a CI-only check would miss functions created outside migrations.

**Scope of the global change — and the operational caveat.** It governs **future** functions created by `postgres`, in any schema. That means migrations (all in `public`), functions created by hand as `postgres` (for example in the SQL editor), and member objects of an extension that `postgres` installs itself without superuser. **`pgmq` (Supabase Queues) is the proven example: under this default 39 of its 40 functions lose PUBLIC EXECUTE**, so enabling it — or any feature that creates functions as `postgres` and expects inherited PUBLIC EXECUTE — needs its execution surface reviewed and granted explicitly. `pg_temp` helper functions are included. The local lifecycle's merge-cycle probe needed an explicit `GRANT` on its helper for exactly this reason.

It does **not** reach:
- existing objects — default privileges never do, so the 49 `postgres`-owned functions already installed in Production's `extensions` are unchanged;
- objects owned by other roles, including Supabase's managed schemas;
- supautils-privileged and trusted extensions, whose member objects are created as `supabase_admin`. citext, pg_trgm, vector, pg_cron, moddatetime, pg_jsonschema and lo were verified unchanged.

`postgres` cannot alter `supabase_admin`'s defaults, and C56 does not try.

**`service_role`.** Removed from the two **existing** functions: no path needs it (its DML fires the triggers without it), and 40 of the other 41 `public` functions already exclude it. Its **future-function** default in `public` is platform-maintained and deliberately **preserved exactly as found**, following the C38 precedent. Narrowing it belongs to the separate service-role least-privilege review. The `postgres`/`public` function entry therefore legitimately ends as `{postgres=X/postgres,service_role=X/postgres}` on hosted Production and `{postgres=X/postgres}` on a clean replay.

**How the migration is gated.**
- **Fail-closed preconditions** before any change:
  - both functions' exact contract, body digest and `search_path`, and one of the two reviewed ACL forms, shared by both;
  - exactly the reviewed twelve triggers (definition, enabled state, internal flag), and no other dependent;
  - no overload of either name in `public`;
  - 43 `public` functions, exactly these two PUBLIC-executable;
  - no global `postgres` default entry;
  - the `postgres`/`public` function entry is one of two literal shapes, judged whole: hosted, or owner-only. The owner-only shape is the clean replay, and also what Supabase's documented opt-in leaves behind, so it composes. Anything else — `anon` without `authenticated`, an unreviewed grantee, `service_role` alone — stops the file.
- **Verification before COMMIT:**
  - both functions owner-only, directly and effectively;
  - no PUBLIC-executable `public` function;
  - exactly one global entry, `f={postgres=X/postgres}`;
  - the `public` entry moved only by losing `anon` and `authenticated`, with `service_role` unchanged;
  - real-object probes: a new `public` function reaches only its owner, plus `service_role` exactly where the preserved entry says so, and a new function in a fresh schema is owner-only;
  - **an in-transaction trigger probe**: scratch tables carrying each hardened function are updated as `authenticated`, which holds no EXECUTE, and each `updated_at` must advance while a direct call is refused with `42501`;
  - a snapshot proving nothing else moved: every other function ACL database-wide, every other `public` function row, relations, columns, policies, triggers, every other default entry, schemas, role memberships and event triggers;
  - no lock on a `public` relation, and no application row written.

  The probe returns to the role the file started under, not to the session user, so it works under the linked CLI's login-role-plus-`SET ROLE postgres` connection.

**Implementation evidence** (local, PostgreSQL 17.6, disposable databases; Production read-only only).
- **39 controls on the real file**, each leaving a byte-identical privilege/catalog fingerprint:
  - **19 precondition refusals**: the wrong role; body, `search_path` and security-mode drift; an extra target grantee; a uniform unreviewed ACL; an extra, a disabled and a `WHEN`-clause trigger; an overload; a 44th function; an extra PUBLIC-executable function; existing global table and function defaults; the four unreviewed `public` entry shapes; and a taken probe name.
  - **15 postcondition refusals**: a target re-granted; another function granted to PUBLIC; an extra global default; `authenticated` back in the `public` entry; `service_role`'s default narrowed; another function's ACL; another default entry; a disabled trigger; a relation ACL; a new function outside `public`; a lock on a `public` relation; a row written; `service_role` left on a target; the global revoke omitted; and Supabase's per-schema idiom substituted for it.
  - **5 positive runs** converging from all four ACL × default combinations, and from a login role that `SET ROLE`s to `postgres`. Every run ends at the same state: the other 41 function ACLs are byte-identical and equal Production's digest.
- **Suites:**
  - `015` **106 → 119**: section K, plus the SECURITY INVOKER PUBLIC-EXECUTE allowlist emptied;
  - `007` stays **30**, with `set_updated_at()` pinned exactly owner-only;
  - new `025` (**33**): all twelve triggers fire for a no-EXECUTE role, the real writers, the disabled-trigger sensitivity control, the RLS negative control, direct-call denial, and the DEFAULT-expression contrast;
  - **26 suites / 2,383 pgTAP assertions** in total.
- **Hosted-ACL parity lane:** it applies every migration after the frozen 2026-09-04 seed, C56 included, from Production's explicit function ACL and default shape. Suite `015` passes. NC4 proves `service_role`'s default privileges unmoved. New **NC7** proves a forgotten-ACL function reaches no client role (only `service_role`, by its preserved hosted default) and fails `015` on ACL-H1 alone.
- **Harness consequence, found and fixed.** The lifecycle's true-concurrency merge-cycle probe created `pg_temp.try_merge` as `postgres` and called it as `authenticated`, relying on inherited PUBLIC EXECUTE. Under C56 that call is refused, which is the intended behaviour, so the probe now grants EXECUTE explicitly.
- **Full local lifecycle.** `npm run test:db:local` passed: the replay of all 96 migrations, the sensitivity probe and negative control, all 26 suites, every concurrency and cutover probe, the residue check and the complete hosted-ACL parity lane (NC1, NC6a/b, seed verification, NC3, convergence, NC4, NC2, NC7, NC6c).
- **Application gates.** Lint (0 errors; the 18 pre-existing warnings, none in a touched file), `npm run typecheck` (app, node, extension), Vitest (173 files / 5,662 tests), the web and extension production builds, and the local E2E lane (257 Playwright tests) passed.
- **Production, read-only, at preparation.** The real file's §0 and §1 ran against Production in `BEGIN TRANSACTION READ ONLY … ROLLBACK`, with no DDL sent. Every precondition passed; the targets resolved to `{33584,53609}`, the hosted `public` entry was recognised, and no transaction ID was assigned.

**Rollback — forward only; none has been performed.** Do not edit C56, which is applied, and do not `migration repair` its legitimate application. A reversal is a new forward migration that:
- re-GRANTs the intended EXECUTE on the two functions explicitly;
- runs `ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC`, which deletes the global entry again (verified locally);
- runs the per-schema GRANT to `anon` and `authenticated` in `public`.

**Privacy.** Privilege posture only. No data category, recipient, retention or processor changes, and no Privacy Policy amendment ([privacy-data-flow-audit.md](privacy-data-flow-audit.md)).

**Not in scope, unchanged.**
- `service_role` least privilege, including its `public` function default *(taken up 2026-09-29 by C57, applied to Production 2026-09-29, which removed that default)*;
- database `TEMPORARY`;
- the 24 retained `authenticated` SECURITY DEFINER contracts;
- C30;
- `supabase_admin`'s and `supabase_auth_admin`'s default privileges, and `postgres`'s dormant `storage` default entry;
- the frozen hosted-ACL parity fixtures;
- historical migration files.

**Re-evaluation triggers:**
- enabling Supabase Queues (`pgmq`), Database Webhooks, or any extension or feature that `postgres` installs and that creates functions expecting inherited PUBLIC EXECUTE — review its execution surface and grant it explicitly in a migration;
- Supabase changing its platform function defaults before or after the rollout — for example its 2026-10-30 existing-project rollout, announced for tables and sequences — which the preconditions judge. The owner-only `public` entry its documented opt-in produces is accepted; any other shape stops the file, to be re-derived rather than relaxed. *(Since the 2026-09-28 rollout the preconditions no longer run against Production. Compare `postgres`'s global and `public` function entries, read-only, against the Production outcome above; a platform change that adds a grantee back needs its own review. Since C57, applied 2026-09-29, the `public` function entry is owner-only `{postgres=X/postgres}`, so compare it against C57's Production outcome instead.)*;
- the separate `service_role` least-privilege review *(fired 2026-09-29: C57, applied to Production 2026-09-29)*;
- a new function that genuinely needs PUBLIC or `anon` EXECUTE — classify it deliberately in suite `015`'s allowlist and state the grant in its migration;
- a PostgreSQL change to when trigger EXECUTE is checked — suite `025` and the migration's trigger probe are where it shows;
- a database whose state differs from the reviewed one (for example a new hosted environment), which the migration refuses — stop and re-review; do not edit the migration to fit (Production passed the reviewed preflight and was hardened on 2026-09-28).

### C57. `service_role` holds only the two grants a server path uses, and nothing by default (2026-09-29)

**Status: COMPLETE — applied to Production 2026-09-29.** Migration `20260929084252_harden_service_role_least_privilege.sql` implements it (`SERVICE-ROLE-LEAST-PRIVILEGE-HARDENING-001`). It follows the read-only audit `SERVICE-ROLE-LEAST-PRIVILEGE-AUDIT-001` (2026-09-29), whose verdict was **HARDENING_RECOMMENDED**. It merged as `3a3e0957` (PR #322, approved head `f5c81c12`). It was applied in a migration-only rollout (`SERVICE-ROLE-LEAST-PRIVILEGE-HARDENING-001B`; [deployment.md](deployment.md) §6.18).

- **Production outcome** (observed read-only immediately after the apply, 2026-09-29, and again the same day for the documentation reconciliation):
  - ledger **96 → 97**, latest `20260929084252`, present once. Production started from shape **H**. `npx supabase db push --linked --yes` exited 0 and applied exactly this file, with no seeds and no roles.
  - `service_role`'s stored and effective relation privileges in `public` are exactly `INSERT` on `ai_provider_usage_events`. It holds nothing on the 20 tables or on the other 8, and it has no column grant.
  - `papers_insert_order_seq` is `{postgres=rwU/postgres,authenticated=U/postgres}`: no `service_role` `USAGE`, `SELECT` or `UPDATE`.
  - It executes exactly `refund_ai_quota(uuid)`, whose contract is unchanged:
    - owner `postgres`, SECURITY DEFINER, `search_path=public, pg_temp`;
    - body `4224750d…`;
    - ACL `{postgres=X/postgres,service_role=X/postgres}`, and PUBLIC, anon and `authenticated` cannot execute it.

    The telemetry ACL is unchanged: `{postgres=arwdDxtm/postgres,service_role=a/postgres}`.
  - `postgres`'s `public` entries are `S={postgres=rwU/postgres} f={postgres=X/postgres} r={postgres=arwdDxtm/postgres}`. Its global entry is still C56's `f={postgres=X/postgres}`, and every other default-privilege entry is unchanged.
  - `service_role` keeps `USAGE` without `CREATE` on `public`; its attributes and memberships are unchanged.
  - The migration's own whole-state snapshot is identical before and after: the client-role matrix, platform schemas, relations, columns, constraints, indexes, policies, triggers, whole function rows, other default entries, roles, memberships and event triggers. Every row count is identical.
  - No `zz_c57_probe_*` object remains.
  - Security Advisor unchanged (24 × 0029, 6 × `rls_enabled_no_policy`, 1 leaked-password).
  - No Edge Function was deployed, and all six keep their versions and bundle hashes. No secret, Auth or Storage setting changed. No application row was modified: the migration's own §3i check proved, before COMMIT, that it wrote no row in `public`, `auth` or `storage`.
  - No Production AI or account-deletion canary was run. Runtime safety rests on four things:
    - the two grants the runtime uses were kept byte-for-byte;
    - the migration's in-transaction verification;
    - the database suites;
    - the local end-to-end run that deletes an account against the hardened schema.

**Decision.** Five privilege statements, and nothing else:

```sql
REVOKE ALL ON TABLE <the 20 reviewed tables> FROM service_role;
REVOKE ALL ON SEQUENCE public.papers_insert_order_seq FROM service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM service_role;
```

Afterwards `service_role`'s whole application-owned surface is:
- `USAGE` on schema `public`, which the platform grants and C57 does not touch;
- `INSERT` on `ai_provider_usage_events` (C42), kept exactly;
- `EXECUTE` on `refund_ai_quota(uuid)` (C47), kept exactly.

It holds no other relation, sequence, column or routine privilege, and a table, sequence or function `postgres` creates in `public` later grants it nothing until that migration says so.

**Why.** `service_role` is the role behind the secret key and has `BYPASSRLS`, so its object grants are the only database control on what the key can do. The audit read every consumer of the key, all read-only:
- the six deployed Edge Function bundles (downloaded byte-exact) and their import closures;
- the database: no cron, no `pg_net`, no webhooks and no Vault secrets;
- CI;
- the operator runbooks.

Only two server paths use a `public` grant:
- `analyze-paper` and `suggest-paper-organization` append a telemetry row (INSERT without RETURNING);
- the same two functions call the quota refund.

`delete-account` uses the key for the Storage API, which runs as `service_role` on the platform-owned `storage` schema, and for the Auth Admin API. Auth authorizes that call by the key's role claim and runs its SQL as `supabase_auth_admin`. The `ON DELETE CASCADE` / `SET NULL` actions run as each table's owner. The only AFTER triggers on that path are SECURITY DEFINER.

The other grants had no user:
- all eight privileges on 20 tables;
- the insert-order sequence;
- the platform defaults that hand `service_role` every new object.

Where those grants came from:
- `20260731162729`'s stated reason (`fetch-paper-metadata` reads `profiles`) was never true.
- `20260726120000`'s "bootstrap via service role" was superseded: the owner bootstrap runbook is SQL as `postgres` (deployment §13.3).
- C38 and C56 deliberately left `service_role` alone and named this review as their trigger.

The only real consumers were the local E2E fixtures.

**What a leaked secret key loses.** It keeps Auth administration and Storage, which is what a secret key is for. It can no longer, over the Data API:
- read every user's library, profile, email address or PubMed API key;
- rewrite entitlements, owner/manager access, usage counters or subscriptions.

With a SQL session that can become `service_role`, it can no longer truncate tables, attach triggers or take `ACCESS EXCLUSIVE` locks. Future objects also stop inheriting access.

**Starting shapes — judged by privilege state, never by date.** Every other grant is identical everywhere. Three shapes differ only in the sequence grant and `postgres`'s `public` default entries:

| Shape | Sequence (`service_role`) | TABLES default | SEQUENCES default | FUNCTIONS default |
|---|---|---|---|---|
| **H** — hosted Production (read-only, 2026-09-29) | `rwU` | `arwdDxtm` | `rwU` | `X` |
| **R** — clean replay | `wU` | `Dxtm` | `w` | none |
| **P** — hosted after Supabase's announced default revoke (discussion #45329) | `rwU` | `Dxtm` | `w` | `X` |

The migration recognises each shape as a whole and refuses any other combination. All three converge on the same state, with the `public` entries at `S={postgres=rwU/postgres} f={postgres=X/postgres} r={postgres=arwdDxtm/postgres}`.

These are pre-C57 states. Production started from H on 2026-09-29 and has been at that target since. A replay of the tracked chain passes through R and then applies C57 itself, so it ends at the same target.

**How it is gated.** Section 1 refuses before any change unless all of the following hold:
- `public` holds exactly the reviewed 29 tables and one sequence, all owned by `postgres`;
- the whole anon / authenticated / PUBLIC / `service_role` matrix is the reviewed one, with no other grantee;
- every `service_role` grant was made by `postgres` without grant option, and it holds no column grant;
- it executes exactly `refund_ai_quota(uuid)`, whose contract, body digest (`4224750d…`), `search_path` and ACL are pinned;
- no function is PUBLIC- or anon-executable;
- the shape is H, R or P, and C56's global entry is present;
- `service_role` belongs to no role and has USAGE without CREATE on `public`.

A new application object or an unexpected grant therefore stops the file; it is never silently revoked.

Section 3 then proves:
- the exact target, both stored and effective;
- real attempts on a new table, identity sequence and function, each refused as `service_role` with `42501`;
- a whole-state snapshot unchanged: every other grant; `authenticated`, anon and PUBLIC; platform schemas; relations; columns; constraints; indexes; policies; triggers; whole function rows; other default entries; roles and memberships; event triggers;
- no lock on a `public` relation and no row written.

**Evidence at preparation** (local, PostgreSQL 17.6 image, disposable databases; Production read-only only):
- **Three starting shapes, from real resets.** Each of R, H and P is proven, then converges to one canonical privilege state. H is reproduced line for line against a committed read-only Production reference (`scripts/acl-parity/hosted-service-role-20260928133918.*`). P is H plus Supabase's two statements verbatim.
- **Controls on the real file.** Each of the following is refused before any change, with no ledger row and the lane left byte-identical:
  - an extra table grant;
  - a column grant;
  - a second executable routine;
  - an unreviewed default;
  - a mixed shape;
  - client-matrix drift.

  Six more one-off local harness runs refused the same way: a grant option, a new table, a third-party grantee, telemetry `SELECT`, a browser-executable refund and a `TYPES` default.
- **Suites.**
  - New `026` (42): the whole surface, catalog-driven and effective; new-object probes; 16 real attempts refused (among them `profiles`, `papers`, the entitlement flag, `internal_user_access`, subscriptions, counters, `TRUNCATE`, `nextval`/`setval`, `LOCK`, `CREATE TRIGGER`, `CREATE TABLE` and `RETURNING`) with no row changed; the telemetry INSERT and refund still working; the refund refused for anon and `authenticated`; the account-deletion AFTER triggers pinned to SECURITY DEFINER; the platform Storage grants untouched.
  - `015` stays 119, now pinning the target instead of the preserved broad posture.
  - `025` stays 33, with `service_role`'s six UPDATEs now refused and firing no trigger.
  - The framework-free case 18 now requires that `service_role` holds nothing on `internal_user_access`.
- **Fixtures.** `scripts/e2e-local-*.mjs` write and verify fixture rows as the local database owner: `postgres` over the local container's socket, through the lifecycle's existing `docker exec … psql` path, with identity checked. They keep the local secret key only for Auth administration and Storage. No grant was restored to make tests convenient.

**No runtime change.** No Edge Function, secret, Auth or Storage setting changes. The two grants the runtime uses are kept byte-for-byte.

**Rollback — forward only; none performed.** Do not edit C57, which is applied, and do not `migration repair` its legitimate application. A reversal is a new forward migration that re-grants exactly what a named server path needs. The pre-change effective posture can be restored with `GRANT ALL` on the 20 tables, `GRANT USAGE, SELECT, UPDATE` on the sequence and the matching `ALTER DEFAULT PRIVILEGES … GRANT` statements. The ACL text may list entries in a different order, which is not a difference in privilege.

**Privacy.** Privilege posture only. No data category, recipient, retention or processor changes.

**Not in scope, unchanged:**
- `service_role`'s attributes and memberships;
- the platform schemas (`auth`, `storage`, `realtime`, `vault`, `graphql*`, `extensions`) and their grants;
- `supabase_admin`'s default privileges, which `postgres` cannot alter and which own no `public` object today;
- the `public` schema ACL;
- every client-role grant;
- the frozen 2026-09-04 parity fixtures;
- historical migration files.

**Re-evaluation triggers:**
- a new server path that needs database authority — for example the paused billing webhook (C27): its migration grants the minimum it needs, explicitly, and suites `015`/`026` are updated deliberately; broad grants are never restored;
- an operator workflow that wants the secret key instead of SQL as `postgres`;
- a new AFTER trigger on the account-deletion cascade path, which must be SECURITY DEFINER or touch no table (suite `026` E1);
- Supabase changing `service_role`'s attributes, memberships or platform defaults, or granting it `CREATE` on `public`;
- a PostgreSQL upgrade — re-check `pg_default_acl` afterwards, because the upgrade documentation is silent on default privileges;
- a database whose state differs from the reviewed one, which the migration refuses — stop and re-review; do not edit the migration to fit (Production passed the reviewed preflight as shape H and was hardened on 2026-09-29).

## Search attribution (2026-09-30)

### C58. Full-text search attribution names every field that contributed a query term (2026-09-30)

**Status: COMPLETE — LIVE in Production since 2026-09-30.** Migration `20260930161651_fix_search_match_cross_field_attribution.sql` implements it (`SEARCH-MATCH-ATTRIBUTION-CROSS-FIELD-001`). It follows the read-only audit `SEARCH-MATCH-ATTRIBUTION-CROSS-FIELD-AUDIT-001` (2026-09-30, **UX_ATTRIBUTION_DEFECT**, P2), and the owner chose its Option B, **contributing-field attribution**. It merged as the two-parent `8a2a880c68e5263c57a3e4a7c541a8d68f1c88ac` (PR #325, approved head `1b496fed`). It was applied on 2026-09-30 in a migration-only rollout (`SEARCH-MATCH-ATTRIBUTION-CROSS-FIELD-001B`; [deployment.md](deployment.md) §6.19).

- **Production outcome** (observed read-only immediately after the apply, and again the same day for the documentation reconciliation):
  - ledger **97 → 98**, latest `20260930161651`, present once;
  - `search_papers` body `d4a5f3afdc485d5dfda8e0798c61cc48` → `1a72d57a585779644c00636f0da3b253`, with every other attribute unchanged: owner, `plpgsql`, SECURITY INVOKER, VOLATILE, PARALLEL UNSAFE, `search_path=public`, and the authenticated-only ACL;
  - membership (`p.search_vector @@ v_ts_query`) and rank (`ts_rank(p.search_vector, v_ts_query)`) are unchanged, and all six flags test `v_ts_any`;
  - `search_vector`, its GIN index, `papers` RLS and policies, and every other function are unchanged.
- **The known limitation below remains**, as characterized. C58 did not change it.

**Decision — contributing-field attribution.** For the unquoted 3+ character full-text path (`search_papers`), a field's `matched_*` flag is true iff that field contains **at least one effective query term**. Row membership and rank do not change: a row must still contain every effective term somewhere in the combined six-field `search_vector`, and it is ranked by `ts_rank` against the same `&`-joined query. Precisely, with T the existing sanitizer's tokens and q(t) = `to_tsquery('english', t || ':*')`:

- membership: `search_vector @@ (q(t1) & q(t2) & …)` (unchanged);
- rank: `ts_rank(search_vector, q(t1) & q(t2) & …)` (unchanged);
- `matched_f`: `to_tsvector('english', coalesce(f, '')) @@ (q(t1) | q(t2) | …)` (new), built once per call from the same tokens.

**Why.** Under whole-query attribution, a paper whose terms were split across fields came back with all six flags false. `PaperList` then showed no "Matched in:" line, so it could not explain a correct result. The README and read-path docs promised a line on each matching row. The code comment the flags shipped with ("at least one of these will also be true") was false for multi-term queries. The closed PR #90, the first design, matched OR over tokens × words. Contributing-field attribution is that intent, computed on the server with the search's own parser.

**Consequences, all intentional:**
- a flag does not mean the field satisfies the whole query on its own;
- a field holding the whole query is flagged together with every other field holding one of its terms, and suite `027` case G pins this so whole-query-only attribution is not restored by accident;
- English stopwords drop out of both queries alike and never flag a field;
- a single-letter token is an ordinary prefix term (`smith j` also flags a journal starting with "J");
- a single-term query flags exactly what it flagged before, and every previously true flag stays true.

**Known limitation — characterized, not changed.** A punctuation-joined token (`a,b`, `a;b`, `a+b`, `covid-19`) is parsed as a phrase. `search_vector`'s concatenation makes the last word of one field adjacent to the first word of the next, so such a phrase can match across that seam. The row is returned, and when every term is such a phrase it can have no flag. Suite `027` pins one case. Fixing it would change sanitizer or membership semantics.

**How it is gated.** The migration refuses unless `search_papers` is exactly the reviewed function, including body `d4a5f3af…`, and `search_vector`, its GIN index and the `papers` RLS boundary are as reviewed. After the replacement it proves, before COMMIT:
- the same OID and every `pg_proc` attribute except the body;
- the exact new body `1a72d57a…`;
- the previous body's membership and rank text, verbatim;
- nothing else moved.

**Not in scope, unchanged:**
- `search_papers_short`, which also serves the quoted-phrase path;
- the sanitizer and tokenizer;
- the frontend runtime.

**Re-evaluation triggers:**
- a product decision to give users an explicit "matched across fields" indicator, which would need a new return column rather than a new meaning for the six booleans;
- any change to the sanitizer, tokenizer or `search_vector` composition, including one that removes the phrase-seam limitation — re-derive suite `027`'s characterization deliberately;
- single-letter or very short prefix terms producing attribution that users find misleading.

## AI model catalog refresh (2026-09-30)

### C59. Claude Sonnet 5.5, Claude Opus 5.5 and GPT-6.1 Sol replace Claude Sonnet 5 and GPT-5.6 Terra through stage → canary → cutover; all three expose `low … max` with PaperLume's own Automatic `low` / `medium` (2026-09-30)

**Status: COMPLETE / LIVE — all four phases executed, Production-verified 2026-10-01.**

- **Phase A — implemented.** The staging migration, its tests and the catalog metadata were prepared and reviewed in the repository.
- **Phase B — staged in Production.** Migration `20260930203613` was applied on 2026-10-01 (ledger **98 → 99**) and both generation functions were deployed with the new `…@2026-09-30` price records (`analyze-paper` v34, `suggest-paper-organization` v17), leaving nine catalog rows with the original six still the only selectable ones.
- **Phase C — passed 9 / 9.** Bounded Production canaries on 2026-10-01 across all three replacements — Analyze Automatic `low`, Suggest Automatic `medium`, Analyze manual `max` — every one routed to the exact model in one provider attempt, `completed` / `succeeded`, usage `reported`, `cost_status = estimated` against its exact `…@2026-09-30` price record, and no Google fallback. The acceptance account's lifetime quota was temporarily raised for the window and restored afterwards, with the genuinely consumed usage deliberately **kept** rather than reset.
- **Phase D — merged and applied.** PR #328 merged as `63a590a798326a55fa8a333599d1384ad469e415` (a normal two-parent merge of the approved head `5156ec27`); merged-`main` Validate, DB Tests and Extension all passed on attempt 1. One `supabase db push --linked --yes` applied migration `20261001092335` — **ledger 99 → 100**, one attempt, no seeds and no roles. It migrated every saved preference off Claude Sonnet 5 and GPT-5.6 Terra onto their successors, **deleted** those two catalog rows, and opened the three replacements.

**Live result.** The catalog holds exactly **seven** rows, all `enabled`, `selectable` and `reasoning_selectable`: Gemini 3.5/3.6/3.7/3.8 Flash at sort 10/20/30/40, then **Claude Sonnet 5.5 (50), Claude Opus 5.5 (60), GPT-6.1 Sol (70)**. `anthropic/claude-sonnet-5` and `openai/gpt-5.6-terra` no longer exist as catalog rows — deleted, not hidden. No Edge Function was deployed and no provider call was made for Phase D; the catalog is the allowlist, so the row change was the whole change. Entitlements, usage counters, credits and all telemetry were provably unchanged. Executed evidence is [deployment.md](deployment.md) §16; the ledger entry is [migration-history.md](migration-history.md).

**Adapter vocabulary narrowing — OPTIONAL / DEFERRED CLEANUP, outside C59's completion criteria.** The rollout plan below originally contemplated narrowing the adapters' provider-level `off` / `none` vocabularies as a fourth step after cutover; that is recorded as a historical consideration, not an unfinished phase. C59's completion criteria were the owner's: the final seven models live, the old two retired, saved preferences migrated, the reasoning policy live, and the provider canaries passed — all met. **Final disposition: deferred.** The catalog is authoritative, no live row offers either literal, so neither is reachable through catalog policy; the branches are an unreachable superset rather than a correctness or security defect, and they do not justify an Edge deployment on their own. **Revisit if** the adapter vocabulary becomes misleading or a maintenance/testing burden; a future model reuses `off` or `none` with different semantics; or an Edge deployment is already being made for related provider work.

**Decision.** The owner's target is seven selectable models: the four Gemini Flash rows, Claude Sonnet 5.5, Claude Opus 5.5 and GPT-6.1 Sol. Claude Sonnet 5 and GPT-5.6 Terra are retired. It is reached by C43's three separately authorized steps, extended by a fourth that C43 never needed:

1. **Stage** the three replacements `enabled = true`, `selectable = false`, `reasoning_selectable = false`, beside the six current rows, touching nothing else.
2. **Canary** each on Analyze and Suggest through an operator-written preference on the acceptance account.
3. **Cut over** in one forward migration that moves saved preferences, then removes the old rows, then opens the new ones.
4. Only afterwards, narrow the adapters' provider-level vocabularies.

Steps 3 and 4 are one migration and one Edge change, each separately reviewed.

**Reasoning metadata — the same for all three rows.**
- `reasoning_levels = low, medium, high, xhigh, max`.
- Automatic Analyze `low`, Automatic Suggest `medium`.

Each is PaperLume's explicit policy (C41), never a provider default: Sonnet 5.5 defaults to `high`, and Opus 5.5 and Sol to `medium`. Not catalog levels, and why:
- `off` is `thinking: {type: "disabled"}`, which both Claude 5.5 models reject at every effort level.
- `none` and `minimal` are rejected by Sol.
- `between_tools` (Sonnet 5.5 only) and `adaptive` are Anthropic **thinking modes**, not effort levels. PaperLume runs adaptive thinking at all five levels and introduces neither. The canonical-vocabulary CHECK keeps both out of the catalog; suite `028` proves it.

**Why the adapters kept `off` and `none` through the rollout, and still do.** The catalog row is the per-model capability authority. The adapter vocabulary is per-**protocol**, and Claude Sonnet 5 and Terra legitimately used those levels for as long as they remained selectable — narrowing an adapter first would have broken a live model. The staged rows never listed those levels, and a saved level a row does not list falls back to that model's Automatic level before any request is built (C41). *Now that the cutover has removed both old rows, no catalog row offers either value, so the adapter branches are unreachable through catalog policy rather than load-bearing.* They are left in place because removing them would need an Edge deployment and is deferred optional cleanup (above), not because they are still needed.

**Pricing** (C44, applied again). The records are `…@2026-09-30`.
- Both Claude 5.5 records carry cache-write `null`: two published TTL rates against one summed usage field.
- Sol is priced up to the same published 272K boundary as Terra and is `unpriced` above it.
- The old `…@2026-09-17` records stay unchanged and open-ended **for historical telemetry interpretation only**. Their catalog rows were deleted by the Phase-D cutover, so those models are neither selectable nor routable; a price record has never been an authorization surface.

**Preference migration at cutover — executed 2026-10-01.**
- Model mapping: `claude-sonnet-5 → claude-sonnet-5-5`, `gpt-5.6-terra → gpt-6.1-sol`.
- Levels `low … max` are preserved.
- `off` (Claude) and `none` (OpenAI) become `NULL`, i.e. Automatic.
- `NULL` stays `NULL`.
- **Observed at rollout:** the single saved preference then in Production, `anthropic/claude-sonnet-5` at `xhigh`, migrated to `anthropic/claude-sonnet-5-5` at `xhigh`, with the preference row count unchanged and zero preferences left on either retired id. That population was the state on the day, not a property of the migration, which is set-based and unconditional on count.

The cutover handles whatever population exists when it runs; it must not assume today's single saved preference. Order is forced by the foreign key: `user_ai_preferences.preferred_model_id` has no `ON DELETE` action, so preferences move before the old rows go.

**Trigger to revisit:**
- any Phase C call failing with a 4xx attributable to the request or reasoning shape;
- a manual level that routinely ends `incomplete_response` inside the unchanged output ceilings;
- a provider changing one of these models' effort vocabulary, default or pricing;
- a replacement becoming a Covered Model with a data-retention requirement, which re-opens the privacy review.

## Consensus discovery (2026-10-03)

### C60. Consensus discovers DOIs for the owner only; the existing importer imports them; one Search is at most one Consensus call (2026-10-03)

**Status:** implemented by `CONSENSUS-SEARCH-MVP-001A`, and for the current single-owner pilot **deployed, live in Production since 2026-10-09 and manually accepted by the owner the same day**. The rollout in [deployment.md](deployment.md) §7e ran in its required order: `CONSENSUS_API_KEY` installed and `search-consensus` deployed on 2026-10-03, then PR #336 merged as `0da8e9c7` on 2026-10-09, which made the owner UI live. The pilot assumes exactly one `owner` account; a read-only count confirmed that on 2026-10-03 and on 2026-10-09. Production acceptance completed on 2026-10-09: one explicit owner Consensus search returned 20 importable results, and one selected DOI was added through PaperLume's canonical PubMed/Crossref importer. The import required no additional Consensus search. The owner-only scope below is an explicit product decision, not a temporary technical limit.

**Decision:** Consensus search is an **owner-only discovery source** inside Add Papers → **Search** (the renamed first mode; there is no fifth mode). Specifically, and until re-decided:

- **Discovery, never a metadata authority.** A Consensus result is transient display data. Only its validated DOI crosses into persistence, through the same `onBulkImport` the Import IDs tab and the PubMed source use — C31's rule, applied to DOIs. No Consensus title, author list, abstract, journal, study type, citation count, takeaway or link is written anywhere, and no second insert, normalization or duplicate path exists for it.
- **The DOI boundary never repairs.** `importDoi` is set only for a bare DOI name that the Edge identifier logic (`detectIdentifier`) recognizes **unchanged**, and the browser re-validates it with its own helper; selection and de-duplication use DOI equivalence (`doiEquivalenceKey`) while one original spelling is imported. A missing or malformed DOI makes a result discovery-only. No Crossref title search, fuzzy match, inference from the title or abstract, or use of Consensus's internal id.
- **Owner-only, enforced twice.** The UI offers the source only when the caller's resolved access role is exactly `owner`, failing closed while that lookup loads or after it fails. The `search-consensus` Edge Function independently re-checks `get_current_user_access()` **as the caller** before it reads `CONSENSUS_API_KEY` or contacts Consensus, so a refused caller costs zero Consensus calls. A manager is not authorized, and no role or identity is accepted from the request.
- **Quota-conscious by construction.** One explicit Search is at most one Consensus request:
  - no automatic retry of any Consensus outcome — 429, 5xx, timeout or network;
  - no pagination, background search, search-as-you-type or related-paper search;
  - no request on opening the dialog, switching the source or selecting a result;
  - `page_size` is fixed at 20 by the server, and the browser contract is `{ query }` alone.

  The only client retry is one refresh-and-retry on a **PaperLume** Edge 401, which the function produces only before any Consensus call.
- **Query-only V1.** No filters and no full-text chunks.
- **The key is server-only.** `CONSENSUS_API_KEY` is an Edge secret: no BYOK, no profile column, nothing in the browser, the logs or a URL.

**Rationale:** The connected key belongs to the owner's own Consensus account. On the Free plan the owner confirmed on 2026-10-02, it carries a small monthly allowance (30 calls in the plan table read on 2026-10-03), shared with the owner's Consensus MCP use. So every request has a real cost, and a silent retry or an accidental search spends it. The canonical importer already owns DOI → PubMed/Crossref provenance, including the DOI-equivalence verification of PR #334 and the own-article DOI extraction of PR #335 (deployed as `fetch-paper-metadata` v25 on 2026-10-03). Persisting Consensus's projection would create a second, poorer source of truth beside it.

**Consequence:** one new Edge Function, a client wrapper, a hook, a panel and the Search-mode rename. No table, column, RPC, RLS policy or migration. Because the merged frontend shows the control to the owner, the secret and the endpoint had to exist **before** the merge, and they did. Any future change to the endpoint's contract is likewise deployed before the frontend that depends on it ([deployment.md](deployment.md) §7e).

**Re-evaluation trigger:**
- a paid Consensus plan, or measured use, that justifies pagination or filters;
- a decision to offer Consensus to anyone but the owner — that needs an owner-approved Privacy Policy update and a per-user quota and authorization design, not a widened role check;
- granting the `owner` role to any additional account: the schema permits several `owner` rows, so the owner-only premise is a data fact this decision depends on, not a constraint;
- Consensus changing its `/v1/search` contract.
