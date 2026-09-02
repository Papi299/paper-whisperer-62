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

**Consequence:** No Supabase plan, billing, or Auth setting changes are authorized during development by this decision. PFA-C08's database hardening was a separate track and is now **complete**: migration `20260810152125_harden_remaining_function_search_paths` was merged (PR #200, merge `7c61ba39…`) and **deployed to Production on 2026-08-10 under separate authorization** (`PFA-C08-SECURITY-HARDENING-001P`), taking the ledger from 72 to **73** rows; post-deploy verification confirmed the four `function_search_path_mutable` warnings cleared, with `proconfig` the only changed catalog field and `papers.search_vector`, the `papers` indexes, and the `set_updated_at` trigger all unchanged — see [migration-history.md](migration-history.md). **PFA-C08 is therefore closed for the current development scope.** Leaked-password protection stays **disabled** and is an explicit **commercialization prerequisite**, not an unresolved development blocker.

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
- **Only the model component of the provider URL changes.** Prompts, request bodies, `responseMimeType`, parsing, extraction schemas, the suggestion contract, quota consumption, refunds, provider-error classification and the temporary 90-second / zero-retry transport are all untouched, and both models are served by the same existing `GEMINI_API_KEY`. `get-gemini-provider-quota` deliberately stays system-default observational monitoring rather than a per-user routing endpoint (C29 remains deferred), so it and the two generation functions may now legitimately name different models for the same request — that divergence is the feature, not drift.
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

**Verification status.** The owner completed a Production canary immediately after the default switch: one **Suggest Projects & Tags** and one **Analyze Paper** request, both `source=system_default provider=google model=gemini-3.5-flash`, one Gemini 3.5 request counted per operation, both returning sensible output. That verifies the **default path** end to end in Production. The **explicit 3.6 preference path** has **not** been provider-verified in Production and remains pending until the Settings UI is deployed and the owner intentionally selects 3.6; `AI-MODEL-SELECTION-001C` made no provider request of any kind.

**Rationale:** The operational evidence in the switch window showed 3.6 provider failures alongside successful 3.5 requests, which is sufficient reason to make 3.5 the default that every unconfigured account lands on. It is **not** sufficient to conclude anything official about a Google outage, and no such conclusion is recorded here. Keeping 3.6 selectable rather than disabling it preserves user choice and keeps the evidence reversible: if 3.6 proves healthy, the default can move back with an environment change alone.

**Re-evaluation trigger:** sustained provider-error evidence for either model; a Google deprecation or pricing change affecting either; the first successful owner-driven 3.6 preference-path verification (which closes the pending item above); or a decision to implement automatic failover, which would supersede the last bullet.
