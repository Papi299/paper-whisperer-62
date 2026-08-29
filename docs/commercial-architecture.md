# Commercial Architecture (Planning Only)

> **Launch implementation paused (C27, 2026-07-24).** This document remains valid **future-facing** commercial architecture, but public-launch and commercial-launch **implementation** are paused by owner decision and are **not** the active next engineering plan. The active priority is product feature and workflow development. Do not interpret this document (including the §7 sequence) as authorizing Paddle, checkout, webhook, paywall or billing work; reactivation requires a new explicit owner decision. See [decisions-and-triggers.md](decisions-and-triggers.md) C27 and [owner-decisions.md](owner-decisions.md).
>
> **Status: planning only.** Schema (PR #142), AI quota enforcement (PR #143), and storage privacy + quota (PR #144) **have shipped**. Billing-provider integration has **not** shipped. **Paddle has been selected under C18 as the future Merchant-of-Record provider** (Lemon Squeezy retained as fallback only), but no Paddle checkout, webhook, customer portal, billing, subscription-activation, pricing-enforcement, or paywall functionality ships today, and integration is paused under C27. **Do not cite this document as evidence that any billing / checkout / paywall functionality ships today.**
>
> **Strategy pivot (2026-05-21).** The earlier "Core + AI plan + 7-day trial + provider-neutral / single-user only" framing has been superseded by a web-first **Product-Led Growth (PLG) freemium** model with a **Free forever** tier (AI teaser), **Pro / Researcher** as the primary paid self-serve SKU, and **Labs / Teams** as a future B2B "Coming Soon / Contact Sales" tier. See the C7–C16 entries in [`decisions-and-triggers.md`](decisions-and-triggers.md).
>
> **Billing-provider pivot (2026-05-21).** The earlier **Stripe-first** direction (C8) was **superseded by C17 — Merchant of Record (MoR)-first**. Stripe direct registration is not officially available for Israel-based businesses, and forming a US LLC via Stripe Atlas is excessive overhead for an independent operator validating MVP. Web billing will be implemented via a Merchant of Record provider. The internal entitlement / `subscriptions` / `subscription_events` model is **unchanged** — it was designed provider-neutral from day one.
>
> **Provider selection (2026-05-21, C18).** **Paddle** is the selected MoR provider for the web MVP under C17. Lemon Squeezy is retained as a fallback only — to be reconsidered if Paddle onboarding fails, Paddle materially changes pricing/policy, or Paddle proves insufficient during the implementation spike. **Implementation of Paddle integration is blocked** until owner-side Paddle setup (Sandbox account, KYB, domain verification, Product + $15/mo Price, customer-portal config, API key, webhook secret) is complete. **The internal architecture stays provider-neutral**: `subscriptions.provider` records `'paddle'` rows in MVP, with `apple` / `google` / `revenuecat` / `manual` reserved; future providers add as additive ingestion paths without schema rework. References to `MOR_*` and `mor-webhook` in older planning text are now read as **Paddle-specific** (`PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRO_MONTHLY_PRICE_ID`, `paddle-webhook`).
>
> **Brand + domain (C19, 2026-05-21; current state as noted).** Working commercial brand: **Paperlume**. Primary working domain: **`paperlume.app`**, secured via **Cloudflare Registrar** (Cloudflare = registrar + DNS). **Paperlume is not a registered trademark**; trademark registration was explored and deferred (Israeli filing ~1,900 ILS for Class 42 alone) until closer to paid public launch / B2B outreach.
>
> **What is live now:** the app runs on **`app.paperlume.app`** (Vercel), and Supabase Auth Custom SMTP routes through Resend on **`auth.paperlume.app`** with SPF/DKIM/DMARC verified — so DNS records and provider connections **are** configured for the app and auth-email halves. Visible **UI labels now read `PaperLume`** on every reachable surface (sidebar, Auth card, `<title>`/`og:title`). **Still unchanged and deliberately so:** the repository/package name (`paper-whisperer-62` / `paper-whisperer`), app routes, Supabase project ref, Edge Function names, database tables, and environment variables. **Still not built:** the marketing site on the root domain, its legal URLs, and Google Workspace business email.
>
> The domain also supports future Paddle KYB / domain verification (C18) and the marketing-site landing pages that C14 / C16 require. **See [`deployment.md §8a`](deployment.md) for the target URL layout, the pre-paid-beta checklist, and the wording constraints around brand / trademark language.** See [C19](decisions-and-triggers.md) for the durable decision, constraints, and re-evaluation triggers.

---

## 1. MVP product model

The first commercial release of Paper Whisperer is a **web-first PLG** product.

- **Launch channel.** Web only. Mobile / native packaging is deferred to a later roadmap phase. Mobile work must not block web commercial beta. The Vercel-hosted React SPA is the only deliverable for the paid launch.
- **Acquisition mechanism.** A **Free forever** tier replaces the previously-planned 7-day time-based trial. Researchers often need weeks to reach the "aha" moment (build a library, run a real systematic review, hit AI in earnest); a fixed 7-day window converts poorly for that workflow. Free forever supports habit formation; the AI teaser (a small lifetime allowance) is the upgrade lever.
- **Paid monetization.** A single self-serve paid tier — **Pro / Researcher** — at an MVP baseline of **$15/month**. No paid AI-free "Core" tier in MVP; the previously-planned Core / AI split has been collapsed into Free / Pro.
- **B2B future path.** A **Labs / Teams** tier is included in marketing and pricing copy as **"Coming Soon" / "Contact Sales"** only. It is **not self-serve in MVP** and **must not be sold** until shared libraries, seat management, team-owner / admin roles, invitations, and team-level entitlements exist. Its role today is price anchoring and B2B lead capture for academic labs, clinical research groups, and dietitian / clinician teams.
- **Billing provider.** **Merchant of Record (MoR)-first** for the web MVP (C17, 2026-05-21 — supersedes the earlier C8 Stripe-first direction). **Provider selected: Paddle** (C18, 2026-05-21). **Lemon Squeezy** remains a fallback only and would be reconsidered if Paddle onboarding fails. Paddle acts as the seller of record for payment collection, invoicing, and international tax / VAT / sales-tax operations **subject to Paddle's terms**, which reduces operational and accounting overhead for an Israel-based independent operator (it does **not** remove all tax / legal obligations). **Paddle integration is blocked** until (a) owner-side Paddle setup (Sandbox / KYB / domain / Product + $15/mo Price / customer-portal config / secrets) is complete, and (b) the launch-blocker items in §6 below are complete. (b)(1) AI quota enforcement and (b)(2) storage privacy + quota are **already complete** — see PRs #143 / #144.
- **Storage.** Attachments / PDF storage are **in launch scope**. Attachment privacy hardening and storage-quota enforcement were launch blockers and are now **complete and live** — see §6 items 3–4.
- **Locale.** English-only LTR for MVP. Hebrew / RTL is out of scope.

Numeric quotas, prices, and the exact Free / Pro feature split are tracked in [quotas-and-pricing.md](quotas-and-pricing.md). Every number is an **MVP baseline with instrumentation** — high-confidence starting values that must be validated against real beta usage, AI cost, and conversion data before being treated as permanent.

---

## 2. Architecture principles

The commercial layer is designed around four hard separations. These principles survived the C7–C16 strategy pivot **and** the C17 billing-provider pivot intact — they apply equally to a PLG-with-MoR model (current direction), a hypothetical future Stripe direct model (if owner constraints change), and a future multi-provider mobile model.

### 2.1 Separate billing-provider state from app entitlements

The application code must never branch on which billing provider produced a subscription. A Merchant of Record (web, MVP per C17), a future Apple IAP, a future Google Play Billing, RevenueCat, and any future provider feed the **same internal entitlement model**. Provider details live in their own ingestion path and are flattened into a provider-agnostic read model the app consumes.

**Why this still matters even with a single-provider MVP.** It would be tempting to short-circuit and check the billing provider live on every gated action ("is this user's subscription active right now?"). Don't. Two reasons:

1. **Latency.** Every render that asks "should I disable the Analyze button?" cannot block on a billing-provider API call.
2. **Future-proofing.** When iOS / Android packaging arrives, Apple IAP and Google Play Billing become additional ingestion paths that produce the same `user_entitlements` rows. The application doesn't need to learn a second SDK.

The app's enforcement boundary is **`user_entitlements` + `usage_counters` + `user_storage_usage` in our own Postgres**, populated by the MoR provider's webhooks, and later by Apple S2S notifications and Google RTDN.

### 2.2 Separate profile/settings from commercial state

`public.profiles` already exists and currently holds **profile and settings** data: `email`, `display_name`, `pubmed_api_key`, `created_at`, `updated_at`, plus the `user_id` link to `auth.users`. **`profiles` should remain focused on profile/settings concerns.**

Commercial state (current plan, current subscription status, current billing period, AI quota, storage quota, AI used this period, storage used this period) is a different concern with a different lifecycle:

- It is **written by the server only** in response to provider webhooks or quota-consuming actions, never by the client.
- It changes on different cadences (period rollovers, webhook-driven status flips) than profile data.
- It needs stricter RLS (read-only to the client; writes only via SECURITY DEFINER RPCs or service-role Edge Functions).
- It is an **append-and-snapshot** shape (history of subscriptions + current entitlement snapshot), not a single-row profile.

For these reasons commercial state lives in **dedicated tables** described below, not as new columns on `profiles`. Profile data and commercial data may be joined in queries, but the source-of-truth tables are separate.

### 2.3 Server-side enforcement, client-side checks for UX only

Two separate things are stated here, and they must not be collapsed into one another: **the architectural rule** (which is absolute) and **how much of the planned commercial surface currently satisfies it** (which is partial).

#### The rule

**Any entitlement or quota gate the product actually relies upon must have an authoritative server-side enforcement boundary — inside Postgres or inside an Edge Function.** Client-side checks exist only to give immediate UX feedback ("you've used 13/15 lifetime AI calls"); they are **never** a security boundary. A user with a debugger and a valid JWT cannot bypass a server-side check, and can bypass a client-side one trivially.

The corollary matters just as much: **a gate that has no server-side boundary is not a gate.** It must not be described, relied on, or marketed as one, and storing an entitlement value is not the same as enforcing it.

#### What is enforced today

| Gate | Server-side boundary | State |
|---|---|---|
| **AI quota** | `analyze-paper` calls the `consume_ai_quota` SECURITY DEFINER RPC **before** invoking Gemini; returns the structured **HTTP 402** without calling the provider when quota is unavailable; calls `refund_ai_quota` best-effort if the Gemini call or parsing fails after a successful consume. | ✅ **Live in Production.** |
| **Storage quota** | `BEFORE INSERT` trigger on `paper_attachments` performs an atomic quota-gated check-and-consume; `AFTER DELETE` refunds, floored at zero. | ✅ **Live in Production.** |
| **Attachment privacy** | Private bucket (`public = false`) with an owner-scoped path-prefix SELECT policy; signed URLs are the client read path. | ✅ **Live in Production.** |
| **Paper limit** | **None.** `user_entitlements.paper_limit` is stored, but `safe_bulk_insert_papers` **does not read it** — the RPC performs the atomic ownership-scoped insert and applies no per-plan cap. | ❌ **Not enforced.** |
| **Premium taxonomy (Synonyms / Exclusions)** | **None.** `user_entitlements.premium_taxonomy_enabled` is stored but **read by nothing**; both pools are fully usable by every account. | ❌ **Not enforced.** |

The two unenforced rows are **gaps in implementation completeness, not exceptions to the rule** — they are exactly why the paper cap and premium-taxonomy gating appear as launch blockers in §6, and why §5.1 records them as unwired. Neither is authorized work today; C27 is unchanged and this section selects nothing.

### 2.4 Read model on the hot path, history off the hot path

The application's hot path — every dashboard render, every "should this button be disabled?" check — must read a **flattened, denormalized snapshot** of the user's current entitlement. The full subscription history and event log live in their own tables and are read only by support tooling, the billing webhook handlers themselves, and admin queries.

This avoids forcing every render to scan a multi-row history of subscription events to decide whether the user can run AI right now.

---

## 3. Commercial tiers (MVP baselines)

> **All numeric values below are MVP baselines, not immutable final pricing.** They must be instrumented (see [quotas-and-pricing.md](quotas-and-pricing.md)) and may move with beta data, Gemini cost reality, and conversion observations. The relative shape — Free PLG entry with AI teaser → Pro with monthly AI quota → Labs/Teams as future B2B — is the durable decision.

### 3.1 Free (MVP)

- **Status:** MVP, self-serve, sign-up-required.
- **Price:** $0 / free forever (no time-bounded expiry).
- **Paper limit:** 1,500.
- **PDF storage:** 500 MB.
- **AI quota:** **15 lifetime calls** (not per-month; lifetime cap from sign-up until upgrade).
- **Includes:** core library, identifier + file imports, search, filters, projects, tags, notes, saved searches / filter presets, exports, attachments (within the storage cap), **Keyword Pool**.
- **Excludes (Pro-only premium taxonomy):** Synonyms pool and Exclusions pool. These are user-accessible features in the current codebase; gating them by entitlement is therefore a **launch blocker** before paid beta — see §6.
- **Role in funnel:** acquisition + habit formation + AI taste. The 15 lifetime calls are deliberately small enough that a serious user hits the wall quickly; large enough that someone can demo the AI feature to themselves and a colleague before being asked to pay.

### 3.2 Pro / Researcher (MVP)

- **Status:** MVP, self-serve, single-user.
- **Price:** **$15 / month** (MVP baseline).
- **Paper limit:** 10,000.
- **PDF storage:** 2 GB.
- **AI quota:** **350 calls / month** (resets on billing-period rollover).
- **Includes everything in Free, plus:** Synonyms pool, Exclusions pool, the full monthly AI quota.
- **Annual cadence:** an annual SKU at a discount (broadly comparable to other productivity SaaS, exact percentage owner-decided) is in scope for MVP if Paddle's configuration allows it cheaply; otherwise it ships in a fast-follow.
- **Add-on AI credit packs:** **future, not MVP.** Researchers should not be hard-blocked mid-project at the quota wall, so the architecture must support add-on credits later (see §5.3); we do not build them in the first paid release.

### 3.3 Labs / Teams (roadmap — "Coming Soon" / "Contact Sales" only)

- **Status:** **NOT self-serve in MVP. Not currently sellable.** Documented for marketing copy and lead capture; must not be sold until the underlying multi-user architecture exists.
- **Price baseline:** $99 – $149 / month for **up to 5 seats** (range, not commitment).
- **Paper limit:** unlimited.
- **PDF storage:** 10 GB.
- **AI quota:** TBD — likely team-level (a pool of analyses shared across seats) rather than per-seat.
- **Includes (future):** Pro features for every seat, **shared libraries** (the team can see and edit the same paper library), **seat management** (owner + member roles), invitations, team-level entitlements, audit log of team actions, optional SSO for institutional buyers.
- **Architectural prerequisites (none implemented):** the data model today partitions every user-scoped table on `user_id`. Shared libraries require either a new ownership column (`team_id`) on every relevant table or a parallel sharing/ACL layer; either is a multi-PR rewrite of RLS, ownership-scoping helpers, and most mutation hooks. This is the largest single piece of post-MVP work.
- **Role today:** price anchoring on the marketing site ("Pro is the affordable individual tier; Labs is the enterprise option"), B2B lead capture form ("Contact Sales" → email-to-owner), and roadmap signal for academic / clinical research labs evaluating long-term tooling.
- **What this PR does NOT authorize:** selling Labs / Teams to anyone. Treating Labs / Teams as buildable before shared libraries exist. Quoting prices outside the documented range without instrumentation.

### 3.4 Tier summary

| Tier | Status | Price | Paper limit | Storage | AI quota | Notes |
|---|---|---|---|---|---|---|
| **Free** | MVP self-serve | $0 forever | 1,500 | 500 MB | 15 lifetime | PLG entry; Keyword Pool included; Synonyms / Exclusions excluded |
| **Pro / Researcher** | MVP self-serve | $15 / month baseline | 10,000 | 2 GB | 350 / month | Primary paid tier; includes Synonyms + Exclusions |
| **Labs / Teams** | Roadmap — Contact Sales | $99–$149 / month baseline range | unlimited | 10 GB | TBD (team-level) | NOT self-serve; requires shared-libraries + seat-mgmt architecture |

---

## 4. Commercial tables — schema is LIVE; some behavior is still future

**These tables exist and are applied in Production.** They shipped in `20260521010000_add_entitlement_usage_schema.sql` (plus `user_storage_usage` in `20260521030000`). The paragraphs below describe the **as-built** schema, and flag separately where a *behavior* that writes or consumes a column is still future work.

Two distinctions matter throughout, and must not be collapsed:

- **The table/column exists** (live, verified against the linked project) — versus —
- **Something populates or consumes it** (in several cases still future, because billing ingestion does not exist).

The authority for column-level truth is `supabase/migrations/` and the linked schema, not this document.

### 4.1 `user_entitlements` (one row per user) — LIVE

The flattened, hot-path read model: **what the user is allowed to do right now**. `handle_new_user()` seeds a Free row at signup. The client has **SELECT-own** access; all writes are server-side.

As-built columns include `id` (PK) and a **unique** `user_id` (the doc previously described `user_id` itself as the PK), `plan` (`free` / `pro` / `labs_team`, CHECK-constrained), `plan_status` (**not** `subscription_status`), `paper_limit`, `storage_quota_bytes`, `ai_lifetime_quota`, `ai_monthly_quota`, `premium_taxonomy_enabled`, `labs_team_enabled`, `current_period_start` / `current_period_end`, the three nullable `billing_provider` / `billing_customer_id` / `billing_subscription_id` columns, `metadata` (JSONB — the flag bag previously sketched as `features`), and timestamps.

**Live behavior:** the quota columns are read and enforced by the AI-quota RPCs and the storage triggers. **Future behavior:** the `billing_*` columns and period boundaries are **never written today** — nothing populates them until billing ingestion exists, and there is no period-rollover job.

### 4.2 `subscriptions` (history, one or more rows per user) — LIVE, and empty by design

Provider-normalized subscription state. It is **not** the enforcement boundary — the application reads `user_entitlements`. RLS is deny-all to the client (server-only).

As-built columns include `id`, nullable `user_id` (`ON DELETE SET NULL`, deliberate — see §6 item 7), `provider` (**not** `billing_provider`), `provider_customer_id` / `provider_subscription_id` / `provider_price_id` / `provider_product_id`, `status`, `plan`, `quantity`, period boundaries, `cancel_at_period_end`, `canceled_at`, `metadata`, and timestamps. There is no `raw_payload` column here — the verified payload lives on `subscription_events` (§4.4).

**The `provider` CHECK constraint currently allows `stripe` / `apple` / `google` / `revenuecat` / `manual` — it does not yet include `'paddle'`.** Adding that value is part of the future Paddle integration migration (§6 item 5, §7 item 7), not something already done. **The table holds no rows and nothing writes to it**, because no ingestion path is implemented.

### 4.3 `usage_counters` (per user, per feature, per period) — LIVE

Per-period usage counters, written only by the SECURITY DEFINER AI-quota RPCs. RLS is deny-all to the client — **there is no client SELECT policy**, which is why quota state reaches the UI through the read-only `get_ai_quota_status` RPC rather than a direct table read.

As-built columns include `id`, `user_id`, `feature` (CHECK-constrained to `ai_analysis`), `period_type` (`lifetime` / `monthly`), `period_start` (the **`epoch` sentinel** for lifetime rows, so uniqueness works without NULL handling — not the sign-up timestamp originally sketched), `period_end`, `used` (**not** `ai_used`), `reserved`, `metadata`, and timestamps.

Note the shape correction: storage usage is **not** a column here. It lives in the separate **`user_storage_usage`** table (§4.6). The optional `imports_used` counter was never built.

### 4.4 `subscription_events` (append-only audit log) — LIVE, and empty by design

Append-only record of processed provider events: `provider` (same CHECK set as §4.2, likewise **without** `'paddle'` today), `provider_event_id`, `event_type`, nullable `user_id` and `subscription_id`, `processed_at`, the verified `payload` JSONB, `metadata`, `created_at`. Idempotency comes from unique `(provider, provider_event_id)`. Server-only writes, no client read policy.

**Nothing writes to it today** — it becomes active only when webhook ingestion ships. Paddle's stable globally-unique `event.id` is what would land in `provider_event_id`.

### 4.5 `usage_credits` — table LIVE, behavior FUTURE

The add-on credit-pack table exists so the shape is settled from day one (C13), with `feature`, `source` (`purchase` / `manual_grant` / `promo` / `refund`), `provider` / `provider_reference_id`, `quantity_granted`, `quantity_remaining`, `expires_at`, `metadata`, and timestamps. The client has SELECT-own access so a future Settings → Credits view needs no new policy.

**The behavior is not built:** `consume_ai_quota` does **not** fall through to credits when the monthly or lifetime quota is exhausted, nothing grants credits, and the table is empty. Credit packs remain future work per C13.

### 4.6 `user_storage_usage` — LIVE

Per-user running total of attachment bytes, one row per user, `used_bytes` as `BIGINT` (32-bit would overflow at the future Labs/Teams 10 GB cap). Maintained by the `BEFORE INSERT` check-and-consume and `AFTER DELETE` refund triggers on `paper_attachments`. Client SELECT-own is allowed, which is what the read-only Settings → Storage gauge reads.

---

## 5. Enforcement points

The table below is the per-action record of **where enforcement lives and whether it exists yet**. Read the Status column as authoritative: rows marked ✅ are enforced server-side and live; rows marked **Partial** or **Not implemented** describe the *intended* boundary that has not been built. Per §2.3, an unbuilt gate is not a gate. Client-side checks (where listed) exist purely to give the user fast feedback before the server roundtrip and are never the boundary.

### 5.1 Enforcement matrix

| Action | Client-side check (UX) | Server-side enforcement (truth) | Status |
|---|---|---|---|
| **Single AI analysis** | Header indicator shows used/remaining and an actionable message when the server returns 402. **No upgrade nudge exists** (C27). | Inside `analyze-paper`: the `consume_ai_quota` SECURITY DEFINER RPC atomically consumes a unit against `usage_counters` + `user_entitlements` (monthly on Pro, lifetime on Free) **before** Gemini is called; `refund_ai_quota` refunds best-effort on provider failure. | ✅ **Implemented and live.** |
| **Bulk AI analysis** | Bulk run stops after the first authoritative quota response, with complete `analyzed + failed + not attempted = total` accounting. | Same per-call enforcement inside `analyze-paper`; the structured **HTTP 402** body lets the bulk loop stop cleanly. | ✅ **Implemented and live.** |
| **Attachment upload** | Read-only Settings → Storage gauge shows used / quota / remaining. The raw Postgres over-quota message on rejected uploads is **not** yet a friendly toast. | `BEFORE INSERT` trigger on `paper_attachments` does an atomic quota-gated check-and-consume against `user_storage_usage.used_bytes` vs `user_entitlements.storage_quota_bytes`; `AFTER DELETE` refunds, floored at zero. | ✅ **Implemented and live.** Error-message polish outstanding. |
| **Attachment privacy** | n/a | Bucket is `public = false`; the owner-scoped SELECT policy keys on the `{userId}/{paperId}/…` path prefix. Signed URLs are the client read path. | ✅ **Implemented and live.** |
| **Single paper add (manual / identifier)** | None today. *Intended:* refuse with a clear toast if `paper_limit` would be exceeded. | `safe_bulk_insert_papers` performs the atomic ownership-scoped insert, but **does not read `paper_limit` at all**. *Intended:* count existing papers and reject over the cap. | **Partial.** The RPC exists and is the right enforcement point; the per-plan cap is **not wired**. `user_entitlements.paper_limit` is stored but never enforced. |
| **Bulk import** | None today. *Intended:* refuse a batch larger than `import_batch_limit`, or one whose final count would exceed `paper_limit`. | Same RPC, same gap — no cap check. | **Partial**, for the same reason. Not a C27-blocked item: it is unbuilt enforcement, not billing. |
| **Identifier metadata fetch (PubMed / Crossref)** | None for MVP. | Function already caps each request at 50 identifiers. No per-month metering for MVP. | Sufficient. |
| **Synonyms / Exclusions feature access (Pro-only)** | *Intended:* hide / disable the feature surface for Free. | *Intended:* server-side check at the relevant RPC. `user_entitlements.premium_taxonomy_enabled` exists to carry this but is **read by nothing**. | **Not implemented.** Both pools are fully usable by every account today. Remains a launch blocker if they stay user-visible. |
| **Export (CSV / RIS / BibTeX, and the PFA-C02 full account ZIP export)** | None. | None for MVP — exporting one's own data is a baseline expectation, and data portability must not sit behind a plan. | Sufficient. Both export paths are implemented and deliberately ungated. |

### 5.2 The AI quota RPC pattern

The recommended shape (matches PR #130's SECURITY DEFINER + `auth.uid()` pattern):

```sql
-- Pseudocode; actual migration ships in the next phase.
CREATE FUNCTION consume_ai_quota(p_user_id uuid, p_n integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;
  -- Resolve plan + active period from user_entitlements / usage_counters.
  -- Atomic UPDATE … WHERE ai_used + p_n <= effective_quota RETURNING new ai_used.
  -- Return { ok: true, ai_used, ai_remaining } or { ok: false, error: 'quota_exceeded', reset_at }.
END;
$$;
```

`analyze-paper` calls `consume_ai_quota` first; only on `ok: true` does it call Gemini. On Gemini hard failure, `refund_ai_quota` is called to undo the increment.

### 5.3 Add-on credit packs (future)

When `consume_ai_quota` would return `quota_exceeded`, a future variant checks `usage_credits` and consumes from there if a remaining balance exists. The application code does not change; the consume RPC absorbs the credit-pack logic. This is **not built in MVP** but the schema and RPC contract should be shaped so the credit-pack feature is a strictly additive PR later.

---

## 6. Launch blockers (must ship before paid beta)

The following items **must** be complete before opening the closed paid pilot (Paddle Live mode under C18). They are the minimum bar at which charging users is defensible.

1. **Entitlement + quota schema.** ✅ **Implemented and applied to Production.** Migration `20260521010000_add_entitlement_usage_schema.sql` is in the aligned ledger. Five tables: `user_entitlements`, `subscriptions`, `usage_counters`, `subscription_events`, `usage_credits`. RLS posture: client SELECT-own only on `user_entitlements` and `usage_credits`; everything else server-only. Signup trigger extended to seed Free defaults. See [migration-history.md](migration-history.md) under "Commercial foundation — entitlement and usage schema".
2. **Server-side AI quota enforcement inside `analyze-paper`.** ✅ **Implemented, applied, and deployed.** Migration `20260521020000_add_ai_quota_rpcs.sql` is applied to Production and the `analyze-paper` Edge Function is deployed. `consume_ai_quota` is called before Gemini; on `allowed=false` the function returns HTTP 402 `Payment Required` with a structured body and does not invoke Gemini. `refund_ai_quota` is called best-effort if the Gemini call or response parsing fails after a successful consume. See [migration-history.md](migration-history.md) under "Commercial foundation — AI quota enforcement".
3. **Attachment bucket privacy hardening.** ✅ **Already implemented** in `20260327100000_private_attachments_bucket.sql` (repo-tracked, applied to remote since March 2026; retro-documented in `migration-history.md` during PR #144). Bucket is `public = false`; `attachments_owner_read` SELECT policy keys on the `{userId}/{paperId}/…` path prefix. Signed URLs are the client read path.
4. **Storage quota enforcement.** ✅ **Implemented and applied to Production** via `20260521030000_harden_attachment_privacy_and_storage_quota.sql`. Dedicated `user_storage_usage` table (BIGINT-typed `used_bytes`); `BEFORE INSERT` trigger does atomic check-and-increment via a single quota-gated UPDATE; `AFTER DELETE` trigger decrements floored at zero. Backfill computes real usage per existing user.
5. **Paddle integration** (C18, 2026-05-21; selected via the MoR provider-selection audit recorded in `migration-history.md` and PR #145's follow-up). Three Edge Functions: `paddle-webhook` (idempotent ingestion into `subscriptions` + recompute of `user_entitlements` via `recompute_entitlement_from_subscription`); `create-payment-session` (authenticated; creates a Paddle checkout/transaction with `custom_data: { supabase_user_id }`); `create-customer-portal-session` (authenticated; returns the Paddle customer portal URL). Signature verification on `paddle-webhook` is **mandatory** (`Paddle-Signature` header → `HMAC-SHA256(secret, ts + ":" + rawBody)` against `h1`; 5-second timestamp tolerance — public `atomica-software/deno_paddle_verify` library is the recommended helper). All provider-specific configuration lives in Supabase secrets (`PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRO_MONTHLY_PRICE_ID`, `APP_URL`); no client-side Paddle SDK; no `VITE_PADDLE_*` secret of any kind. A small migration extends the `provider` CHECK constraint on `subscriptions` and `subscription_events` to include `'paddle'` (and adds the value to `user_entitlements.billing_provider`, which has no CHECK today). **Implementation of this PR is blocked until owner-side Paddle setup is complete** — see `owner-decisions.md §2.1`.
6. **Privacy policy + terms + support URL + AI disclosure** linked from inside the app. The **Privacy Policy is done**: the app serves it at `https://app.paperlume.app/privacy` and links to it from the sign-in surface (2026-08-29). Terms, support URL and AI disclosure remain outstanding and are still expected on the external marketing site — see §11.
7. **In-app account deletion.** ✅ **Implemented** (PFA-C04): the `delete-account` Edge Function authenticates the caller, requires the exact typed confirmation phrase server-side, deletes every Storage object under the account's `{userId}/` bucket prefix through the Storage API, and then calls `auth.admin.deleteUser(userId, false)` — a hard delete. Owned database rows are removed by the existing `ON DELETE CASCADE` foreign keys, so **no deletion RPC and no migration were required**; the cascade is pinned by `supabase/tests/database/008_account_deletion_cascade.test.sql`. The confirmation UI is Settings → Danger zone. **Retention exception:** `subscriptions.user_id` and `subscription_events.user_id` are `ON DELETE SET NULL` by design (§4.2 / §4.4), so those rows survive with a NULL `user_id` rather than being deleted. That is harmless today — C27 pauses billing, so no provider data reaches them — but **before commercial or public launch, provider/billing audit-history retention must be re-evaluated against the applicable legal and privacy requirements** (what may be retained, for how long, and in what form) once those tables actually hold real provider data. No retention policy is asserted here.
8. **Minimal monitoring / error tracking.** Sentry-equivalent on the client with PII redaction; Edge Function log inspection cadence documented.
9. **Per-user app-level rate limit on `analyze-paper`** (separate from the quota; defense in depth against credential abuse).
10. **Premium-feature gating for Synonyms / Exclusions** if those remain user-accessible — see §3.1.
11. **Production domain, hosting, and email architecture** on `paperlume.app` (C19). **Partially completed (2026-05-22):** ✅ Vercel custom domain `app.paperlume.app` connected; ✅ Resend transactional auth-email subdomain `auth.paperlume.app` wired into Supabase Auth Custom SMTP with SPF / DKIM / DMARC verified; ✅ Supabase Auth `Site URL` + `Redirect URLs` updated to `app.paperlume.app`; ✅ Paperlume-branded Auth email templates configured; ✅ multi-mailbox smoke test passed (inbox, not spam); ✅ app import smoke test passed on the new domain. **Still pending:** marketing site live on root `paperlume.app` with legal URLs (C14 / C16); Google Workspace business email on `paperlume.app` (required before broader beta if `support@paperlume.app` is referenced in user-facing templates — it is, in the customized Auth templates). See [`deployment.md §8a`](deployment.md) for the full pre-paid-beta checklist with completion status per item.

Items not on this list (mobile packaging, app-store assets, Labs/Teams shared libraries, add-on credit packs, annual SKU if Paddle makes it expensive, RTL/Hebrew) are explicitly **not** beta blockers.

---

## 7. Recommended future implementation order

**Items 1–5 are complete and live** — the commercial *foundations* (entitlement/usage schema, server-side AI quota, attachment privacy, storage quota, provider selection) are built, applied to Production, and no longer pending anything. They are retained below as the record of what the later steps build on, not as outstanding work.

**The resume point is item 6**, and it is **paused under C27**. Nothing from item 6 onward may be started without a new explicit owner decision — this section is a reactivation sequence, not a work queue.

1. **Commercial strategy docs pivot** *(PR #141, merged 2026-05-21).* ✅ Done.
2. **Entitlement + usage schema** — migration + RLS + Free-tier seeding. ✅ **Done — applied to Production.**
3. **AI quota enforcement in `analyze-paper`** — `consume_ai_quota` / `refund_ai_quota` RPCs + Edge Function wiring. ✅ **Done — applied and deployed.** The client quota surface also shipped: a header usage indicator plus an actionable message on the 402. It is **transparency only** — no upgrade, checkout, or paywall path was added (C27).
4. **Attachments privacy hardening + storage-quota enforcement** — ✅ **Done — applied to Production** (`20260327100000` privacy; `20260521030000` quota). The read-only Settings → Storage gauge also shipped, again transparency-only.
5. **MoR provider-selection audit** — short audit between Paddle and Lemon Squeezy producing a dated C18 owner decision recording the choice. ✅ **Completed (C18, 2026-05-21) — Paddle selected.** Lemon Squeezy retained as fallback only. See `decisions-and-triggers.md` C18.
6. **Owner-side Paddle setup gate** (no code; owner action). Paddle Sandbox account; KYB / business verification; domain verification; Product creation; $15 / month recurring Price; capture Price ID; Paddle API key; webhook signing secret once endpoint is registered; customer portal config; `APP_URL` decided. **Paused (C27) — off the active critical path; not the recommended next task.** This sequence resumes only after a new explicit owner decision to return to launch work.
7. **Paddle integration** — three Edge Functions (`paddle-webhook`, `create-payment-session`, `create-customer-portal-session`) + `_shared/paddle.ts` initializer + two SECURITY DEFINER RPCs (`set_billing_customer`, `recompute_entitlement_from_subscription`) + a small migration extending the `provider` CHECK constraints to include `'paddle'`. Blocked on #6 (owner setup gate).
8. **UI: paywall / upgrade** — `<UpgradeNudge>` component, Settings → subscription / Paddle customer portal / cancel. **Not** quota *display*: the AI header indicator, the 402 message, and the Settings → Storage gauge already shipped as transparency-only surfaces. What remains here is strictly the upgrade/checkout path, plus friendlier surfacing of the raw `Storage quota exceeded` Postgres error.
9. **Privacy + AI disclosure + support links** — external URLs wired into the app. The **account-deletion** half of this item is already done (PFA-C04: the `delete-account` Edge Function plus the Settings → Danger zone surface); what remains here is the legal/marketing URL wiring, which still depends on the marketing site (§11).
10. **Closed technical beta on Paddle Sandbox.** Internal testing only; not "paid beta" because Paddle is in Sandbox mode.
11. **Closed paid pilot on Paddle Live** — small invited cohort with real charges.
12. **Open beta** — public sign-up; marketing site live; Labs / Teams "Contact Sales" lead capture form live.

Each item produces its own PR and `migration-history.md` entry per `docs/documentation-policy.md`.

---

## 8. Billing-provider neutrality (Paddle MVP under MoR-first, multi-provider-ready)

The same `user_entitlements` and `subscriptions` rows can be produced by:

- **Paddle** (web, MVP per C18 — selected provider under the C17 MoR-first architecture), via a `paddle-webhook` Edge Function that verifies `Paddle-Signature` via HMAC-SHA256 over `ts:rawBody`. **This is the only provider we ship in MVP.**
- **Lemon Squeezy** (fallback only per C18; not implemented in MVP). Would be revisited if Paddle onboarding fails or Paddle materially changes policy.
- **Apple IAP** (future iOS app), via an `apple-notification` Edge Function that verifies Apple Server-to-Server Notifications V2 JWS.
- **Google Play Billing** (future Android app), via a `google-rtdn` Edge Function subscribed to Real-Time Developer Notifications.
- **RevenueCat** (optional cross-platform unification later), via a `revenuecat-webhook` Edge Function.
- **Stripe** (retained as a future option only if owner constraints change — e.g., the operator later forms a US / UK / EU entity that opens direct Stripe support without the LLC overhead). Not the MVP path per C17.
- **Manual** (admin-issued comp / press / refund-and-extend), via a small admin RPC.

Each ingestion path is responsible for:

1. Verifying the upstream signature.
2. Idempotently UPSERTing into `subscriptions`.
3. Recomputing the user's current entitlement (latest active row wins) and writing the snapshot to `user_entitlements`.
4. Appending an audit row to `subscription_events`.

Because every ingestion path lands data in the same internal model, **the application code never imports a billing SDK**. Adding a new provider later is a purely additive change — no application refactor.

---

## 9. Why commercial state is not added to `profiles`

(Unchanged from the pre-pivot architecture; same five reasons apply equally to the PLG / MoR-first model from C17 and to the Paddle-as-MVP-provider selection from C18.)

It would be technically possible to add `plan`, `subscription_status`, `ai_monthly_quota`, `ai_used_this_period`, `storage_used_bytes` etc. as new columns on `profiles`. We chose not to:

1. **Mixed write authority.** `profiles` today is client-writable for the user's own row (display name, PubMed API key). Commercial state must be **server-write-only**. Splitting tables avoids fine-grained per-column GRANTs and the bug class of "the wrong column slipped into a client-side update payload."
2. **Different lifecycle.** Profile data is set by the user at any time. Commercial state is set by webhooks and period jobs on cadences the user does not control.
3. **History.** A user can have multiple historical subscriptions; squashing them into a single profile row loses information needed for support and reconciliation.
4. **RLS surface.** Tightening RLS on a multi-purpose `profiles` table is harder than tightening RLS on a single-purpose `user_entitlements` table.
5. **Provider neutrality.** Provider-specific fields (`billing_customer_id`, `billing_subscription_id`, `raw_payload`) belong with the subscription record, not in `profiles`.

`profiles` may later carry a *cached* `plan` value for query convenience, but the source of truth is `user_entitlements` / `subscriptions`.

---

## 10. Explicit non-goals for MVP

These are intentionally **out of scope** for the first commercial release:

- **7-day time-based trial.** Replaced by Free forever + AI teaser per §1.
- **Paid AI-free Core tier.** Replaced by Free / Pro per §3.
- **Teams / multi-user libraries / shared libraries.** Labs / Teams is roadmap / Coming Soon / Contact Sales only; not self-serve. See §3.3.
- **Collaboration features** of any kind (comments, shares, real-time co-edit).
- **Credit packs / one-time AI top-ups.** Future architecture-supported but not built in MVP. See §5.3.
- **Family sharing / household plans.**
- **Coupon and promo-code logic** beyond what Paddle supplies for free.
- **Apple IAP / Google Play Billing / RevenueCat.** All deferred to the post-web-launch mobile packaging phase.
- **Mobile-native packaging.** Capacitor / React Native / true native shells are not built. Web-first; mobile is later.
- **Hebrew / RTL.** English-only LTR.
- **Education / student / non-profit pricing.** Out of scope unless owner adds.
- **Per-region pricing differentiation** beyond Paddle's defaults.

When any of the above is later approved as in-scope, it must be added as a separate, dated decision in [decisions-and-triggers.md](decisions-and-triggers.md) and accompanied by its own architecture section here.

---

## 11. Legal pages location

Public-facing legal pages (Terms of Service, AI disclosure, Support / contact) **live on an external marketing site** (Webflow, Framer, or another dedicated marketing-site platform; owner choice). The app links to HTTPS URLs hosted on that site, not to repo-served Markdown.

**Exception — the Privacy Policy (2026-08-29).** The owner superseded this for the Privacy Policy alone: it is served by the application at `https://app.paperlume.app/privacy` as a public, unauthenticated route, with the owner-approved copy in [`src/pages/Privacy.tsx`](../src/pages/Privacy.tsx). See C16 in [`decisions-and-triggers.md`](decisions-and-triggers.md).

- **In-app surface:** Settings → "Privacy", "Terms", "Support" each link out to the external URL. The "AI disclosure" line at the Analyze action also links there.
- **Repo-tracked drafts.** May be created later for versioning convenience, but the **authoritative published copies are on the external site**. The repo does not serve legal text directly today and will not as part of MVP.
- **Legal review.** Text on the external site must be reviewed by an appropriate professional before public launch. This document does not attempt to draft legal copy; doing so without review would be irresponsible.

---

## 12. Cross-references

- [quotas-and-pricing.md](quotas-and-pricing.md) — provisional plan structure, MVP baseline values, instrumentation requirements, open pricing questions.
- [store-launch-checklist.md](store-launch-checklist.md) — App Store / Play Store readiness items (deferred to post-web-launch; retained for the future mobile phase).
- [deployment.md](deployment.md) — current deployment runbook.
- [documentation-policy.md](documentation-policy.md) — the documentation update rule for all subsequent PRs.
- [decisions-and-triggers.md](decisions-and-triggers.md) — captures the 2026-05-21 commercial strategy pivot (C7–C15) and the prior C1–C6 entries it supersedes / refines.
- [owner-decisions.md](owner-decisions.md) — compact ledger of resolved and still-pending commercial decisions.
