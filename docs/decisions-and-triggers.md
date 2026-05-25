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
- Commercial state has different lifecycle (webhook-driven), different write authority (service-role only), and a multi-row history per user, none of which fit a single profile row.
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
- `safe_bulk_insert_papers` — guard already present (original precedent).
- `set_paper_tags`, `set_paper_projects`, `bulk_set_paper_tags`, `bulk_set_paper_projects` — derive ownership from `auth.uid()` internally; no `p_user_id` parameter.
- `bulk_update_study_types`, `bulk_update_keywords` — derive ownership from `auth.uid()` internally.
- `get_duplicate_papers`, `merge_exact_duplicates` — `auth.uid()` only; no `p_user_id` parameter.
- `search_papers`, `search_papers_short`, `filter_papers_by_keywords`, `get_keyword_options` — hardened by `20260518010000_rpc_auth_uid_ownership_check.sql`.

**Required for any new `SECURITY DEFINER` RPC:** the migration creating it must include either the explicit guard or an `auth.uid()`-derived ownership pattern; review will reject SECURITY DEFINER RPCs that lack one of these.

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

**Decision:** Public-facing legal pages — **Privacy Policy**, **Terms of Service**, **AI disclosure**, **Support / contact** — live on an **external marketing site** (Webflow, Framer, or another dedicated marketing-site platform; owner choice). The app links to HTTPS URLs hosted on that site; it does not serve legal text from the repo.

**Rationale:** Legal pages are owned by the marketing surface, not the application repo. They are subject to copy / SEO / design iteration on the marketing team's cadence and benefit from a CMS workflow. The app's responsibility is to link out to authoritative URLs and to surface the AI-disclosure line at the relevant in-app action.

**Implication:** repo-tracked drafts of legal text may be created later for versioning convenience, but the **authoritative published copies are on the external site**, and the in-app links resolve to that site. No legal text in this repo should be treated as final or legally reviewed.

**Hard constraint:** the in-app surface (Settings → Privacy / Terms / Support / AI disclosure links + the at-Analyze AI disclosure) is a **launch blocker** for the web paid beta. The external URLs must exist and be linked before charging users.

**Re-evaluation trigger:** owner decision to host legal pages in-repo as Markdown (would require routing + privacy-page React component); not currently planned.

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
