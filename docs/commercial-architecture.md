# Commercial Architecture (Planning Only)

> **Status: planning only. Nothing in this document is implemented.** No billing, no entitlements, no quotas, no paywall, no mobile packaging exist in the current codebase. This file captures the *intended* commercial architecture so subsequent PRs can implement against an agreed model. **Do not cite this document as evidence that any commercial functionality ships today.**
>
> **Strategy pivot (2026-05-21).** The earlier "Core + AI plan + 7-day trial + provider-neutral / single-user only" framing has been superseded by a web-first **Product-Led Growth (PLG) freemium** model with **Stripe-first** web billing, a **Free forever** tier with an AI teaser, a **Pro / Researcher** paid tier as the primary self-serve SKU, and a **Labs / Teams** future B2B tier shown only as "Coming Soon / Contact Sales". See the [Commercial strategy pivot (2026-05-21)](decisions-and-triggers.md) entries in `decisions-and-triggers.md` and §1 / §3 / §7 below.

---

## 1. MVP product model

The first commercial release of Paper Whisperer is a **web-first PLG** product.

- **Launch channel.** Web only. Mobile / native packaging is deferred to a later roadmap phase. Mobile work must not block web commercial beta. The Vercel-hosted React SPA is the only deliverable for the paid launch.
- **Acquisition mechanism.** A **Free forever** tier replaces the previously-planned 7-day time-based trial. Researchers often need weeks to reach the "aha" moment (build a library, run a real systematic review, hit AI in earnest); a fixed 7-day window converts poorly for that workflow. Free forever supports habit formation; the AI teaser (a small lifetime allowance) is the upgrade lever.
- **Paid monetization.** A single self-serve paid tier — **Pro / Researcher** — at an MVP baseline of **$15/month**. No paid AI-free "Core" tier in MVP; the previously-planned Core / AI split has been collapsed into Free / Pro.
- **B2B future path.** A **Labs / Teams** tier is included in marketing and pricing copy as **"Coming Soon" / "Contact Sales"** only. It is **not self-serve in MVP** and **must not be sold** until shared libraries, seat management, team-owner / admin roles, invitations, and team-level entitlements exist. Its role today is price anchoring and B2B lead capture for academic labs, clinical research groups, and dietitian / clinician teams.
- **Billing provider.** **Stripe-first** for the web MVP. Stripe supports the subscription model, future usage / add-on credit packs, B2B invoicing, and metered billing without locking us out of an App Store / Play Store path later. Stripe integration is **blocked** until the internal entitlement + quota schema and server-side enforcement exist.
- **Storage.** Attachments / PDF storage are **in launch scope**. Attachment privacy hardening (close the public-bucket gap) and storage-quota enforcement are **launch blockers** before paid beta. See §7.
- **Locale.** English-only LTR for MVP. Hebrew / RTL is out of scope.

Numeric quotas, prices, and the exact Free / Pro feature split are tracked in [quotas-and-pricing.md](quotas-and-pricing.md). Every number is an **MVP baseline with instrumentation** — high-confidence starting values that must be validated against real beta usage, AI cost, and conversion data before being treated as permanent.

---

## 2. Architecture principles

The commercial layer is designed around four hard separations. These principles survived the strategy pivot intact — they apply equally to a PLG-with-Stripe model and to a future multi-provider mobile model.

### 2.1 Separate billing-provider state from app entitlements

The application code must never branch on which billing provider produced a subscription. Stripe (web, MVP), a future Apple IAP, a future Google Play Billing, RevenueCat, and any future provider feed the **same internal entitlement model**. Provider details live in their own ingestion path and are flattened into a provider-agnostic read model the app consumes.

**Why this still matters even with Stripe-first.** It would be tempting to short-circuit and check Stripe live on every gated action ("is this user's Stripe subscription active?"). Don't. Two reasons:

1. **Latency.** Every render that asks "should I disable the Analyze button?" cannot block on a Stripe API call.
2. **Future-proofing.** When iOS / Android packaging arrives, Apple IAP and Google Play Billing become additional ingestion paths that produce the same `user_entitlements` rows. The application doesn't need to learn a second SDK.

The app's enforcement boundary is **`user_entitlements` + `usage_counters` in our own Postgres**, populated by Stripe webhooks, and later by Apple S2S notifications and Google RTDN.

### 2.2 Separate profile/settings from commercial state

`public.profiles` already exists and currently holds **profile and settings** data: `email`, `display_name`, `pubmed_api_key`, `created_at`, `updated_at`, plus the `user_id` link to `auth.users`. **`profiles` should remain focused on profile/settings concerns.**

Commercial state (current plan, current subscription status, current billing period, AI quota, storage quota, AI used this period, storage used this period) is a different concern with a different lifecycle:

- It is **written by the server only** in response to provider webhooks or quota-consuming actions, never by the client.
- It changes on different cadences (period rollovers, webhook-driven status flips) than profile data.
- It needs stricter RLS (read-only to the client; writes only via SECURITY DEFINER RPCs or service-role Edge Functions).
- It is an **append-and-snapshot** shape (history of subscriptions + current entitlement snapshot), not a single-row profile.

For these reasons commercial state lives in **dedicated tables** described below, not as new columns on `profiles`. Profile data and commercial data may be joined in queries, but the source-of-truth tables are separate.

### 2.3 Server-side enforcement, client-side checks for UX only

Every quota and entitlement gate is enforced **inside Postgres or inside an Edge Function**, never solely in the React client.

- Client-side checks exist to give immediate UX feedback ("you've used 13/15 lifetime AI calls — upgrade to keep analyzing"). They are not a security boundary.
- Server-side checks are the truth: AI quota is decremented and verified inside the `analyze-paper` Edge Function before Gemini is called; the storage cap is enforced by a `BEFORE INSERT` trigger on `paper_attachments`; the paper cap is enforced by the `safe_bulk_insert_papers` RPC.
- A user with a debugger and a valid JWT cannot bypass server-side checks. They can bypass client-side ones trivially.
- **The current `analyze-paper` Edge Function has no server-side quota check.** That is the primary blocker for paid beta and is the next implementation phase after the schema lands.

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
- **Annual cadence:** an annual SKU at a discount (broadly comparable to other productivity SaaS, exact percentage owner-decided) is in scope for MVP if Stripe configuration allows it cheaply; otherwise it ships in a fast-follow.
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

## 4. Proposed tables (conceptual only — none exist yet)

These tables **do not exist in the schema today.** They are the agreed conceptual shape for the next schema PR. The names and field lists below are guidance; the actual migration may diverge.

### 4.1 `user_entitlements` (one row per user)

The flattened, hot-path read model. Holds **what the user is allowed to do right now**.

Conceptual fields:

- `user_id` (PK, references `auth.users`)
- `plan` (e.g. `free` / `pro` — Labs values added when that tier becomes real)
- `subscription_status` (e.g. `none` / `active` / `past_due` / `canceled` / `expired`; **no `trialing`** in MVP because there is no time-bounded trial)
- `current_period_start`, `current_period_end` (nullable on Free)
- `ai_monthly_quota` (e.g. 0 on Free; per-period quota on Pro)
- `ai_lifetime_quota` (e.g. 15 on Free; null / unused on Pro)
- `storage_quota_bytes`
- `paper_limit`
- `features` (small JSONB flag bag for per-account overrides — e.g. comp accounts, beta access)

This row is **maintained by server-side webhook ingestion and by period-rollover jobs**. The client has SELECT-only access to its own row.

### 4.2 `subscriptions` (history, one or more rows per user)

Each row corresponds to a billing-provider subscription instance.

Conceptual fields:

- `id` (PK)
- `user_id`
- `billing_provider` (`stripe` today; `apple` / `google` / `revenuecat` / `manual` reserved for later)
- `billing_customer_id` (Stripe customer ID for now)
- `billing_subscription_id` (Stripe subscription ID for now)
- `plan` (e.g. `pro`)
- `billing_period` (`monthly` / `annual`)
- `status`
- `current_period_start`, `current_period_end`
- `raw_payload` (JSONB — last verified provider event, for forensics)
- `created_at`, `updated_at`

Uniqueness: `(billing_provider, billing_subscription_id)`. Writes only by the Stripe webhook ingestion Edge Function.

### 4.3 `usage_counters` (one row per user per billing period)

Per-period usage counters. A new row is created at each period rollover so history is preserved. On Free, the row tracks **lifetime** AI usage instead (period boundaries are `period_start = sign-up, period_end = null`).

Conceptual fields:

- `id` (PK)
- `user_id`
- `period_start`, `period_end` (nullable end for the lifetime row on Free)
- `ai_used`
- `storage_used_bytes` (maintained by triggers on `paper_attachments`)
- `imports_used` (optional)
- `updated_at`

Uniqueness: `(user_id, period_start)`. Writes only via SECURITY DEFINER RPCs.

### 4.4 `subscription_events` (append-only audit log)

Every Stripe webhook event we processed: provider, event type, raw payload, signature verification result, resulting entitlement change, timestamp. Service-role-only writes; admin-only reads. Useful for support, dispute resolution, billing reconciliation.

### 4.5 `usage_credits` (future — not MVP)

Add-on credit packs. Conceptual fields: `user_id`, `kind` (`ai`), `amount_remaining`, `purchased_at`, `expires_at`, `source` (Stripe one-time charge ID). Consumed by `analyze-paper` **after** the monthly quota is exhausted. Not built in MVP.

---

## 5. Enforcement points

Every action in the table below is enforced **server-side**. Client-side checks (where listed) exist purely to give the user fast feedback before the server roundtrip.

### 5.1 Enforcement matrix

| Action | Client-side check (UX) | Server-side enforcement (truth) | Status |
|---|---|---|---|
| **Single AI analysis** | If quota exhausted or plan does not include AI, disable Analyze and show upgrade nudge. | Inside `analyze-paper`: read `user_entitlements` + `usage_counters`, atomically increment + verify `ai_used < ai_monthly_quota` (or `ai_lifetime_quota` on Free), only then call Gemini. Refund on Gemini hard failure. | **Not implemented.** Blocker for paid beta. |
| **Bulk AI analysis** | Show "you can analyze N of M selected" and confirm before starting. | Same per-call enforcement inside `analyze-paper`. Returns structured `{ error: "quota_exceeded", reset_at }` so the bulk loop stops cleanly. | **Not implemented.** Blocker for paid beta. |
| **Attachment upload** | Read storage used / quota; refuse oversize uploads with a clear toast. | `BEFORE INSERT` trigger on `paper_attachments` sums `size_bytes` for the user and rejects if it would exceed `storage_quota_bytes`. `AFTER INSERT/DELETE` triggers maintain `usage_counters.storage_used_bytes`. | **Not implemented.** Blocker for paid beta. |
| **Attachment privacy** | n/a | Tighten the `attachments` storage bucket from public SELECT to owner-only RLS. Signed URLs continue as the read path. | **Not implemented.** Blocker for paid beta. |
| **Single paper add (manual / identifier)** | If `paper_limit` would be exceeded, refuse with a clear toast. | `safe_bulk_insert_papers` RPC counts existing papers and rejects when over `paper_limit`. | **Partial** (RPC exists; per-plan limit check not wired). |
| **Bulk import** | Refuse to start a batch larger than `import_batch_limit`; refuse if final count would exceed `paper_limit`. | Same RPC enforces atomically. | **Partial.** |
| **Identifier metadata fetch (PubMed / Crossref)** | None for MVP. | Function already caps each request at 50 identifiers. No per-month metering for MVP. | Sufficient. |
| **Synonyms / Exclusions feature access (Pro-only)** | Hide / disable feature surface for Free. | Server-side check at the relevant RPC / hook; Free users get a clear "upgrade to Pro" error. | **Not implemented.** Required at paid beta if the feature stays user-visible. |
| **Export (CSV / RIS / BibTeX)** | None. | None for MVP — exporting one's own data is a baseline expectation. | Sufficient. |

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

The following items **must** be complete before opening the closed paid pilot (real Stripe live-mode). They are the minimum bar at which charging users is defensible.

1. **Entitlement + quota schema.** ✅ **Implemented** in migration `20260521010000_add_entitlement_usage_schema.sql` (repo only — remote deploy pending). Five tables: `user_entitlements`, `subscriptions`, `usage_counters`, `subscription_events`, `usage_credits`. RLS posture: client SELECT-own only on `user_entitlements` and `usage_credits`; everything else server-only. Signup trigger extended to seed Free defaults. See [migration-history.md](migration-history.md) under "Commercial foundation — entitlement and usage schema".
2. **Server-side AI quota enforcement inside `analyze-paper`.** ✅ **Implemented** in migration `20260521020000_add_ai_quota_rpcs.sql` + the `analyze-paper` Edge Function (repo only — remote DB push + Edge Function deploy pending). `consume_ai_quota` is called before Gemini; on `allowed=false` the function returns HTTP 402 `Payment Required` with a structured body and does not invoke Gemini. `refund_ai_quota` is called best-effort if the Gemini call or response parsing fails after a successful consume. See [migration-history.md](migration-history.md) under "Commercial foundation — AI quota enforcement".
3. **Attachment bucket privacy hardening.** ✅ **Already implemented** in `20260327100000_private_attachments_bucket.sql` (repo-tracked, applied to remote since March 2026; retro-documented in `migration-history.md` during PR #144). Bucket is `public = false`; `attachments_owner_read` SELECT policy keys on the `{userId}/{paperId}/…` path prefix. Signed URLs are the client read path.
4. **Storage quota enforcement.** ✅ **Implemented** in `20260521030000_harden_attachment_privacy_and_storage_quota.sql` (repo only — remote `db push` pending). Dedicated `user_storage_usage` table (BIGINT-typed `used_bytes`); `BEFORE INSERT` trigger does atomic check-and-increment via a single quota-gated UPDATE; `AFTER DELETE` trigger decrements floored at zero. Backfill computes real usage per existing user.
5. **Stripe Checkout + webhook ingestion.** New `stripe-webhook` Edge Function. Idempotent UPSERT into `subscriptions`. Recompute `user_entitlements`. Append `subscription_events`. Signature verification on the webhook.
6. **Privacy policy + terms + support URL + AI disclosure** linked from inside the app (URLs hosted on the external marketing site — see §11).
7. **In-app account deletion.** Edge Function that cascades user data deletion across tables + Storage bucket prefix + finally `auth.admin.deleteUser`. Confirmation UI in Settings.
8. **Minimal monitoring / error tracking.** Sentry-equivalent on the client with PII redaction; Edge Function log inspection cadence documented.
9. **Per-user app-level rate limit on `analyze-paper`** (separate from the quota; defense in depth against credential abuse).
10. **Premium-feature gating for Synonyms / Exclusions** if those remain user-accessible — see §3.1.

Items not on this list (mobile packaging, app-store assets, Labs/Teams shared libraries, add-on credit packs, annual SKU if Stripe makes it expensive, RTL/Hebrew) are explicitly **not** beta blockers.

---

## 7. Recommended future implementation order

The next ~6 PRs are blocked by each other in a clear order. This is the recommended sequence:

1. **Commercial strategy docs pivot** *(PR #141, merged 2026-05-21).* ✅ Done.
2. **Entitlement + usage schema** — migration + RLS + Free-tier seeding for the existing user. ✅ **Implemented** in `20260521010000_add_entitlement_usage_schema.sql` (remote deploy pending).
3. **AI quota enforcement in `analyze-paper`** — `consume_ai_quota` / `refund_ai_quota` RPCs + Edge Function wiring. ✅ **Implemented** in `20260521020000_add_ai_quota_rpcs.sql` + the `analyze-paper` Edge Function (remote deploy pending). Client UI for quota state + quota-exceeded toast is **deferred** to a later PR — the Edge Function already returns a structured 402 body that the UI consumes later.
4. **Attachments privacy hardening + storage-quota enforcement** — ✅ **Completed.** Privacy hardening was previously done by `20260327100000` (retro-documented). Storage-quota enforcement implemented in `20260521030000_harden_attachment_privacy_and_storage_quota.sql` (remote deploy pending).
5. **Stripe Checkout + webhook ingestion** — `stripe-webhook` Edge Function + Settings → "Upgrade to Pro" flow + Stripe customer portal link.
6. **UI: paywall / upgrade / quota state** — `<UpgradeNudge>` component, per-action quota display, Settings → subscription / billing portal / cancel.
7. **Privacy + account deletion + AI disclosure + support links** — Edge Function for deletion + Settings surface + external URLs wired.
8. **Closed technical beta on Stripe test mode.** Internal testing only; not "paid beta" because Stripe is in test mode.
9. **Closed paid pilot on Stripe live mode** — small invited cohort with real charges.
10. **Open beta** — public sign-up; marketing site live; Labs / Teams "Contact Sales" lead capture form live.

Each item produces its own PR and `migration-history.md` entry per `docs/documentation-policy.md`.

---

## 8. Billing-provider neutrality (Stripe-first, multi-provider-ready)

The same `user_entitlements` and `subscriptions` rows can be produced by:

- **Stripe** (web, MVP), via a `stripe-webhook` Edge Function that verifies the `Stripe-Signature` header. **This is the only provider we ship in MVP.**
- **Apple IAP** (future iOS app), via an `apple-notification` Edge Function that verifies Apple Server-to-Server Notifications V2 JWS.
- **Google Play Billing** (future Android app), via a `google-rtdn` Edge Function subscribed to Real-Time Developer Notifications.
- **RevenueCat** (optional cross-platform unification later), via a `revenuecat-webhook` Edge Function.
- **Manual** (admin-issued comp / press / refund-and-extend), via a small admin RPC.

Each ingestion path is responsible for:

1. Verifying the upstream signature.
2. Idempotently UPSERTing into `subscriptions`.
3. Recomputing the user's current entitlement (latest active row wins) and writing the snapshot to `user_entitlements`.
4. Appending an audit row to `subscription_events`.

Because every ingestion path lands data in the same internal model, **the application code never imports a billing SDK**. Adding a new provider later is a purely additive change — no application refactor.

---

## 9. Why commercial state is not added to `profiles`

(Unchanged from the pre-pivot architecture; same five reasons apply equally to the PLG / Stripe-first model.)

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
- **Coupon and promo-code logic** beyond what Stripe provides for free.
- **Apple IAP / Google Play Billing / RevenueCat.** All deferred to the post-web-launch mobile packaging phase.
- **Mobile-native packaging.** Capacitor / React Native / true native shells are not built. Web-first; mobile is later.
- **Hebrew / RTL.** English-only LTR.
- **Education / student / non-profit pricing.** Out of scope unless owner adds.
- **Per-region pricing differentiation** beyond Stripe's defaults.

When any of the above is later approved as in-scope, it must be added as a separate, dated decision in [decisions-and-triggers.md](decisions-and-triggers.md) and accompanied by its own architecture section here.

---

## 11. Legal pages location

Public-facing legal pages (Privacy Policy, Terms of Service, AI disclosure, Support / contact) **live on an external marketing site** (Webflow, Framer, or another dedicated marketing-site platform; owner choice). The app links to HTTPS URLs hosted on that site, not to repo-served Markdown.

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
