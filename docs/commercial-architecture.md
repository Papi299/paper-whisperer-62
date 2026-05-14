# Commercial Architecture (Planning Only)

> **Status: planning only. Nothing in this document is implemented.** No billing, no entitlements, no quotas, no paywall, no mobile packaging exist in the current codebase. This file captures the *intended* commercial architecture so subsequent PRs can implement against an agreed model. **Do not cite this document as evidence that any commercial functionality ships today.**

---

## 1. MVP product model

The first commercial release of Paper Whisperer is intentionally narrow.

- **Single-user only.** One subscription = one individual user. No teams, no shared libraries, no role-based access, no organization concept.
- **Plan direction:** **Core** plan and **AI** plan.
  - **Core**: paper organization — import, search, filters, tags, projects, notes, saved searches, attachments (within a storage cap), exports. Either no AI or a very small "taste" of AI (TBD).
  - **AI**: everything in Core, plus a defined **monthly quota of AI paper analyses**.
- **Billing cadences:** monthly subscription primary, annual subscription secondary at a discount.
- **7-day free trial** on first subscribe to a paid plan.
- **AI is premium** by default. AI usage is **never unlimited** in the base plan; in the AI plan it is **bounded by an explicit monthly quota**.
- **Storage is bounded.** Each plan carries a per-user storage cap so growth in attachment storage stays predictable as Supabase storage cost becomes relevant.

Numeric quotas, prices, and the exact Core-AI-teaser policy are tracked separately in [quotas-and-pricing.md](quotas-and-pricing.md) and remain provisional pending owner approval and cost modeling.

---

## 2. Architecture principles

The commercial layer is designed around four hard separations.

### 2.1 Separate billing-provider state from app entitlements

The application code must never branch on which billing provider produced a subscription. Stripe, Apple IAP, Google Play Billing, RevenueCat, and any future provider feed the **same internal entitlement model**. Provider details live in their own ingestion path and are flattened into a provider-agnostic read model the app consumes.

**Rationale.** Provider rules differ (Apple's webhook shape vs. Stripe's vs. Google RTDN), pricing tiers differ, refund flows differ, restore-purchase semantics differ. Branching the application on these differences produces N copies of every feature gate. A single internal model — populated by N thin ingestion functions — keeps the application stable across provider changes and lets us add or swap a provider without rewriting feature code.

### 2.2 Separate profile/settings from commercial state

`public.profiles` already exists and currently holds **profile and settings** data: `email`, `display_name`, `pubmed_api_key`, `created_at`, `updated_at`, plus the `user_id` link to `auth.users`. **`profiles` should remain focused on profile/settings concerns.**

Commercial state (current plan, current subscription status, trial expiry, current billing period, AI quota, storage quota, AI used this period, storage used this period) is a different concern with a different lifecycle:

- It is **written by the server only** in response to provider webhooks or quota-consuming actions, never by the client.
- It changes on different cadences (period rollovers, webhook-driven status flips) than profile data.
- It needs stricter RLS (read-only to the client; writes only via SECURITY DEFINER RPCs or service-role Edge Functions).
- It is an **append-and-snapshot** shape (history of subscriptions + current entitlement snapshot), not a single-row profile.

For these reasons commercial state lives in **dedicated tables** described below, not as new columns on `profiles`. Profile data and commercial data may be joined in queries, but the source-of-truth tables are separate.

### 2.3 Server-side enforcement, client-side checks for UX only

Every quota and entitlement gate is enforced **inside Postgres or inside an Edge Function**, never solely in the React client.

- Client-side checks exist to give immediate UX feedback ("you've used 200/200 AI analyses this month — upgrade to continue"). They are not a security boundary.
- Server-side checks are the truth: an AI quota is decremented and verified inside the `analyze-paper` Edge Function before Gemini is called; a storage cap is enforced by a `BEFORE INSERT` trigger on `paper_attachments`; an import cap is enforced by the `safe_bulk_insert_papers` RPC.
- A user with a debugger and a valid JWT cannot bypass server-side checks. They can bypass client-side ones trivially.

### 2.4 Read model on the hot path, history off the hot path

The application's hot path — every dashboard render, every "should this button be disabled?" check — must read a **flattened, denormalized snapshot** of the user's current entitlement. The full subscription history and event log live in their own tables and are read only by support tooling, the billing webhook handlers themselves, and admin queries.

This avoids forcing every render to scan a multi-row history of subscription events to decide whether the user can run AI right now.

---

## 3. Proposed future tables (conceptual only)

These tables **do not exist yet**. They are the agreed conceptual shape for a later schema PR, not migration-ready DDL.

### 3.1 `user_entitlements` (one row per user)

The flattened, hot-path read model. Holds **what the user is allowed to do right now**.

Conceptual fields:

- `user_id` (PK, references `auth.users`)
- `plan` (e.g. `free` / `core` / `ai`)
- `subscription_status` (e.g. `none` / `trialing` / `active` / `past_due` / `canceled` / `expired`)
- `trial_ends_at`
- `current_period_start`, `current_period_end`
- `ai_monthly_quota`
- `storage_quota_bytes`
- `paper_limit` (optional)
- `import_batch_limit` (optional)
- `features` (a small JSONB flag bag for future per-account overrides)

This row is **maintained by server-side webhook ingestion and by period-rollover jobs**. The client has SELECT-only access to its own row.

### 3.2 `subscriptions` (history, one or more rows per user)

Each row corresponds to a billing-provider subscription instance. Multiple rows allowed: lapsed → re-subscribed → upgraded paths produce a history.

Conceptual fields:

- `id` (PK)
- `user_id`
- `billing_provider` (e.g. `stripe` / `apple` / `google` / `revenuecat` / `manual`)
- `billing_customer_id`
- `billing_subscription_id`
- `plan` (e.g. `core` / `ai`)
- `billing_period` (`monthly` / `annual`)
- `status`
- `trial_ends_at`
- `current_period_start`, `current_period_end`
- `raw_payload` (JSONB — last verified provider event, for forensics)
- `created_at`, `updated_at`

Uniqueness: `(billing_provider, billing_subscription_id)`. Writes only by service-role Edge Functions.

### 3.3 `usage_counters` (one row per user per billing period)

Per-period usage counters. A new row is created at each period rollover so history is preserved.

Conceptual fields:

- `id` (PK)
- `user_id`
- `period_start`, `period_end`
- `ai_used`
- `storage_used_bytes` (maintained by triggers on `paper_attachments`)
- `imports_used` (optional)
- `updated_at`

Uniqueness: `(user_id, period_start)`. Writes only via SECURITY DEFINER RPCs.

### 3.4 `subscription_events` (optional, append-only audit log)

Every webhook / RTDN event we processed: provider, raw payload, signature verification result, resulting entitlement change, timestamp. Service-role-only writes; admin-only reads. Useful for support, dispute resolution, and billing reconciliation.

---

## 4. Why commercial state is not added to `profiles`

It would be technically possible to add `plan`, `subscription_status`, `trial_ends_at`, `ai_monthly_quota`, `ai_used_this_period`, `storage_used_bytes` etc. as new columns on `profiles`. We chose not to:

1. **Mixed write authority.** `profiles` today is client-writable for the user's own row (display name, PubMed API key). Commercial state must be **server-write-only**. Splitting tables avoids fine-grained per-column GRANTs and the bug class of "the wrong column slipped into a client-side update payload."
2. **Different lifecycle.** Profile data is set by the user at any time. Commercial state is set by webhooks and period jobs on cadences the user does not control.
3. **History.** A user can have multiple historical subscriptions; squashing them into a single profile row loses information needed for support and reconciliation.
4. **RLS surface.** Tightening RLS on a multi-purpose `profiles` table is harder than tightening RLS on a single-purpose `user_entitlements` table.
5. **Provider neutrality.** Provider-specific fields (`billing_customer_id`, `billing_subscription_id`, `raw_payload`) belong with the subscription record, not in `profiles`.

`profiles` may later carry a *cached* `plan` value for query convenience, but the source of truth is `user_entitlements` / `subscriptions`.

---

## 5. Enforcement points

Every action in the table below is enforced **server-side**. Client-side checks (where listed) exist purely to give the user fast feedback before the server roundtrip.

| Action | Client-side check (UX) | Server-side enforcement (truth) |
|---|---|---|
| **Single AI analysis** | If quota exhausted or plan does not include AI, disable the Analyze button and show an upgrade nudge. | Inside `analyze-paper` Edge Function: read `user_entitlements` + `usage_counters`, increment + verify `ai_used < ai_monthly_quota`, only then call Gemini. Refund on Gemini hard failure. |
| **Bulk AI analysis** | Show "you can analyze N of M selected" and ask the user to confirm before starting. | Same per-call enforcement inside `analyze-paper`. The function returns a structured `quota_exceeded` error so the bulk loop stops cleanly. |
| **Attachment upload** | Read storage used / quota; refuse oversize uploads with a clear toast. | `BEFORE INSERT` trigger on `paper_attachments` sums `size_bytes` for the user and rejects the insert if it would exceed `storage_quota_bytes`. `AFTER INSERT/DELETE` triggers maintain `usage_counters.storage_used_bytes`. |
| **Single paper add (manual / identifier)** | If `paper_limit` is set and would be exceeded, refuse with a clear toast. | `safe_bulk_insert_papers` RPC counts the user's existing papers and rejects when over `paper_limit`. |
| **Bulk import** | Refuse to start a batch larger than `import_batch_limit`; refuse to start if the final count would exceed `paper_limit`. | Same as above — `safe_bulk_insert_papers` enforces atomically. |
| **Identifier metadata fetch (PubMed/Crossref)** | None for MVP. | The function already caps each request at 50 identifiers. No per-month metering planned for MVP. |
| **Export (CSV/RIS/BibTeX)** | None. | None for MVP — exporting one's own data is a baseline expectation. May add IP-based rate limiting later if abuse appears. |
| **Saved searches / Filter Presets** | None for MVP. | Optional cap on row count via a `BEFORE INSERT` trigger if abuse seen. |

---

## 6. Billing-provider neutrality

The same `user_entitlements` and `subscriptions` rows can be produced by:

- **Stripe** (web subscriptions on the React app), via a `stripe-webhook` Edge Function that verifies the `Stripe-Signature` header.
- **Apple IAP** (iOS app), via an `apple-notification` Edge Function that verifies Apple Server-to-Server Notifications V2 JWS.
- **Google Play Billing** (Android app), via a `google-rtdn` Edge Function subscribed to Real-Time Developer Notifications.
- **RevenueCat** (optional unification layer fronting all three), via a `revenuecat-webhook` Edge Function.
- **Manual** (admin-issued comp / press / refund-and-extend), via a small admin RPC.

Each ingestion path is responsible for:

1. Verifying the upstream signature.
2. Idempotently UPSERTing into `subscriptions`.
3. Recomputing the user's current entitlement (latest active row wins) and writing the snapshot to `user_entitlements`.
4. Appending an audit row to `subscription_events`.

Because every ingestion path lands data in the same internal model, the application code never imports a billing SDK. **Adding a new provider later is a purely additive change.**

---

## 7. Explicit non-goals for MVP

These are intentionally **out of scope** for the first commercial release:

- **Teams / multi-user libraries / shared libraries.** Single-user only.
- **Collaboration features** of any kind (comments, shares, real-time co-edit).
- **Credit packs / one-time AI top-ups.** May be revisited after launch if data shows demand.
- **Public/free tier with permanent free AI.** AI is premium; the only free AI exposure is the 7-day trial (and possibly a tiny Core-plan "taste" if explicitly approved).
- **Multiple concurrent plans on one account.** A user holds at most one active subscription at a time.
- **Family sharing / household plans.**
- **Coupon and promo-code logic** beyond what the chosen billing provider gives for free.
- **In-app billing-provider implementation.** This document does not specify which provider is chosen; that decision is owner-pending.
- **Mobile-native packaging.** Capacitor / React Native / true native shells are not built.
- **Cross-platform purchase restoration** beyond what the chosen provider supplies.

When any of the above is later approved as in-scope, it must be added as a separate, dated decision in [decisions-and-triggers.md](decisions-and-triggers.md) and accompanied by its own architecture section here.

---

## 8. Cross-references

- [quotas-and-pricing.md](quotas-and-pricing.md) — provisional plan structure, quotas, and pricing open questions.
- [store-launch-checklist.md](store-launch-checklist.md) — App Store / Play Store readiness items.
- [documentation-policy.md](documentation-policy.md) — the documentation update rule for all subsequent PRs.
- [decisions-and-triggers.md](decisions-and-triggers.md) — captures the decision to keep commercial state out of `profiles` and to keep entitlements decoupled from billing providers.
