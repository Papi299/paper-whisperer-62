# Owner Decisions — Compact Ledger

> **Purpose.** A compact, owner-facing ledger of commercial decisions: what's **resolved**, what's **still pending**, and what each resolved decision **unlocks** for implementation. Not a duplicate of the full architecture or pricing docs — those live in [commercial-architecture.md](commercial-architecture.md) and [quotas-and-pricing.md](quotas-and-pricing.md). This file is the index; the durable narrative is in [decisions-and-triggers.md](decisions-and-triggers.md).
>
> **How to use this file.** When the owner answers a pending question, move the row from §2 to §1 and add a dated entry to `decisions-and-triggers.md`. When a resolved decision unlocks an implementation PR, the unlock is listed inline. Keep this file short — long-form goes in the architecture / pricing docs.

---

## 1. Resolved decisions (2026-05-21 pivot)

Full text and rationale for each is in [decisions-and-triggers.md](decisions-and-triggers.md) at the referenced ID.

| ID | Decision | Resolved | Implementation unlocked |
|---|---|---|---|
| **C7** | Web-first launch; Apple App Store / Google Play deferred. | 2026-05-21 | The next implementation phase targets the web SPA only. Mobile work parked. |
| **C8** | **Stripe-first** for web billing. Webhook-driven ingestion into internal entitlement model. Apple IAP / Google Play / RevenueCat remain future ingestion paths under the same provider-neutral model. | 2026-05-21 | Stripe Checkout + `stripe-webhook` Edge Function — **blocked** until entitlement / quota schema (C11 unlock #1) and server-side AI quota enforcement (C11 unlock #2) exist. |
| **C9** | **Freemium PLG** replaces the 7-day time-based trial. Free forever with AI teaser is the trial mechanism. | 2026-05-21 | `user_entitlements.subscription_status` does not need a `trialing` state in MVP. Simpler entitlement state machine. |
| **C10** | No paid AI-free **Core** tier in MVP. Two-tier MVP: Free → Pro. | 2026-05-21 | Single paid SKU at first paid launch. Reduces Stripe configuration scope. |
| **C11** | **Free + Pro MVP baselines** (numeric values; instrumentation mandatory): Free $0 / 1,500 papers / 500 MB / 15 lifetime AI; Pro $15/mo / 10,000 papers / 2 GB / 350 AI per month. | 2026-05-21 | Entitlement / usage schema (next PR) can seed Free with concrete defaults. Marketing pricing page can be drafted with these numbers. **Not permanent** — see C11 re-evaluation trigger. |
| **C12** | **Labs / Teams** is **"Coming Soon" / "Contact Sales"** only. Not self-serve in MVP. Not sellable until shared-libraries + seat-management exist. | 2026-05-21 | Marketing pricing page can include the Labs / Teams row as anchor. Lead-capture form can be drafted. **No Stripe / Apple / Google SKU** for this tier. |
| **C13** | Add-on **AI credit packs** are a future feature; not MVP. Architecture must support them from day one (shape `usage_credits` + `consume_ai_quota` correctly). | 2026-05-21 | Next schema PR ships `usage_credits` placeholder and the credit-pack RPC contract. Implementation lands later as a fast-follow if churn pressure shows up. |
| **C14** | **Attachments / PDF storage** are in launch scope. **Privacy hardening** (close public-bucket gap) and **storage quota enforcement** are launch blockers. | 2026-05-21 | Migration: tighten `attachments` SELECT to owner-only; add `BEFORE INSERT` quota trigger and `AFTER INSERT/DELETE` usage trigger. Required before paid beta. |
| **C15** | **Hebrew / RTL** is out of scope for MVP. | 2026-05-21 | No i18n / RTL framework work in MVP. |
| **C16** | **Legal pages** (Privacy / Terms / AI disclosure / Support) live on an **external marketing site**. Repo links to HTTPS URLs. | 2026-05-21 | In-app links to the external URLs are a launch blocker. No legal text shipped in the repo. |

---

## 2. Still pending / needs validation

Pending decisions and validation tasks. Each must be resolved (or scheduled) before the listed implementation phase can begin. Items are ordered by approximate gating order.

### 2.1 Required before Stripe implementation begins

| Decision / task | Why blocking | Status |
|---|---|---|
| **Marketing site provider** (Webflow / Framer / other) and chosen domain for legal URLs (e.g., `paperwhisperer.com/privacy`). | C16 requires the external URLs to exist before the in-app links can be wired. The marketing site is the publication target for Privacy / Terms / AI disclosure / Support. | Pending owner choice. |
| **Privacy policy + terms of service drafts**, then professional legal review. | Required by C16 before paid beta. Cannot ship without published URLs. | Pending owner / legal commissioning. |
| **AI disclosure copy** (what content goes to Google Gemini, how Google handles it per Google's policies, how users opt out). | Required at the Analyze action and in Settings → Privacy. | Pending owner authoring; references Google's published Gemini API data-handling policy. |
| **Support channel** — `support@…` email, in-app contact form, or other. | Required for the marketing site's Support URL and for the App Store / Play Store later. | Pending owner choice. |
| **Monitoring / error-tracking provider** (Sentry / Better Stack / DataDog / PostHog-with-errors). | Required by [commercial-architecture.md §6](commercial-architecture.md) before paid beta. PII redaction is non-negotiable. | Pending owner choice. |
| **Staging environment timing** — when does the second Supabase project + second Vercel project + sandboxed Stripe come online? | Recommended before paid beta so billing isn't tested against production. | Pending owner schedule. |

### 2.2 Required before closed paid pilot

| Decision / task | Why blocking | Status |
|---|---|---|
| **Closed paid pilot cohort size and terms** — invite-only N users, charge real money or comp at a discount, length of pilot before opening broader beta. | Defines the pilot launch contract. | Pending owner decision. |
| **Annual cadence at first paid launch?** — Stripe annual SKU configured at MVP, or monthly-only with annual as fast-follow. | Affects Stripe product configuration scope. Default if undecided: monthly only at first launch. | Pending owner decision. |
| **Hard-wall behavior at Pro AI quota exhaustion** — keep the hard wall, or ship inline add-on credit prompt (requires C13 implementation ahead of paid beta). | Affects whether C13 is MVP scope or fast-follow. | Pending owner decision. |
| **Free → Pro grandfathering policy** — when MVP baselines move post-pilot, do existing Free / Pro users keep launch caps or migrate? | Affects how the schema records seeded entitlement values. | Pending owner decision. |

### 2.3 Required before Labs / Teams becomes sellable (post-MVP)

| Decision / task | Why blocking | Status |
|---|---|---|
| **Final Labs / Teams price** within or outside the $99–$149 range. | C12 captures the anchor range; final pricing back-solved from team-cost modelling + customer interviews. | Pending — will be informed by lead-capture volume and B2B customer interviews after web launch. |
| **Labs / Teams AI quota model** — team-level pool, per-seat allocation, or shared base + per-seat overage. | Affects schema for team entitlements. | Deferred until shared-libraries architecture is designed. |
| **Shared-libraries architecture design** — `team_id` column on existing tables vs. parallel ACL layer; RLS rewrite scope. | Largest single piece of post-MVP work. Multiple PRs. | Deferred. |
| **Optional SSO** for institutional buyers (SAML / OIDC / Google Workspace). | Common B2B expectation. | Deferred until Labs / Teams begins implementation. |

### 2.4 Not gating any current PR, but worth tracking

| Decision / task | Status |
|---|---|
| **Education / student / non-profit pricing.** | Out of scope unless owner adds; recommend deferring until post-launch demand signal. |
| **Per-region pricing** beyond Stripe defaults. | Default: Stripe defaults. Revisit if pilot shows geographic concentration. |
| **Add-on AI credit pack pricing** (e.g., `+100 calls for $X`). | Architecture support required from start (C13); pricing decision after pilot. |
| **Hebrew / RTL support timing.** | Out of MVP per C15; revisit on explicit owner priority change. |
| **Mobile / native packaging path** (Capacitor wrap vs. React Native rewrite). | Deferred per C7. Capacitor wrap of the existing SPA is the cheapest path when the mobile phase begins. |

---

## 3. Next implementation unlocks (in order)

Each row below is the next PR that becomes implementable when its prerequisites are satisfied. Numbering matches [commercial-architecture.md §7](commercial-architecture.md).

| # | PR | Prerequisites | Status |
|---|---|---|---|
| 1 | **Commercial strategy docs pivot** *(PR #141)* | None — docs only. | ✅ **Done** (merged 2026-05-21). |
| 2 | **Entitlement + usage schema** — migration adding `user_entitlements`, `subscriptions`, `usage_counters`, `subscription_events`, and the `usage_credits` shape. Seeds the existing user as `plan = 'free'`. | PR #141 (C7–C16 captured). | ✅ **Implemented** in `20260521010000_add_entitlement_usage_schema.sql` (in this PR; remote deploy pending). |
| 3 | **AI quota enforcement in `analyze-paper`** — `consume_ai_quota` / `refund_ai_quota` SECURITY DEFINER RPCs with `auth.uid()` guards; Edge Function consults them before calling Gemini. | #2. | ✅ **Implemented** in `20260521020000_add_ai_quota_rpcs.sql` + `analyze-paper` Edge Function (in this PR; remote `db push` + `functions deploy` pending). |
| 4 | **Attachments privacy + storage-quota enforcement** — tighten bucket SELECT policy; `BEFORE INSERT` quota trigger; `AFTER INSERT/DELETE` usage triggers. | #2 (`user_entitlements` must exist for the trigger to read the quota). | ✅ **Implemented.** Privacy hardening was already in place via `20260327100000` (retro-documented this PR). Storage-quota enforcement implemented in `20260521030000_harden_attachment_privacy_and_storage_quota.sql` + new `user_storage_usage` table + BEFORE INSERT / AFTER DELETE triggers on `paper_attachments`. Remote `db push` pending. |
| 5 | **Stripe Checkout + webhook ingestion** — `stripe-webhook` Edge Function; Settings → "Upgrade to Pro" flow; Stripe customer portal link. | #2 + #3 (server-side AI enforcement must exist before charging) + #4 (storage quota enforcement). | **Unblocked.** All server-side enforcement prerequisites are now landed. Recommended next major implementation PR. |
| 6 | **UI: paywall / upgrade / quota state** — `<UpgradeNudge>`, per-action quota display, Settings → subscription / billing-portal / cancel. | #5. | Blocked on #5. |
| 7 | **Privacy + Account deletion + AI disclosure + Support links** — Edge Function for cascade deletion + Settings surface + external URLs wired. | External marketing site URLs from §2.1. | Blocked on §2.1 owner choices. |
| 8 | **Closed technical beta on Stripe test mode.** | #6, #7. | Blocked on #6, #7. |
| 9 | **Closed paid pilot on Stripe live mode.** | #8 plus §2.2 owner decisions. | Blocked on #8 + §2.2. |
| 10 | **Open beta.** | #9. | Blocked on #9. |

---

## 4. Cross-references

- [commercial-architecture.md](commercial-architecture.md) — durable architecture rationale and table shapes.
- [quotas-and-pricing.md](quotas-and-pricing.md) — MVP baseline values, instrumentation requirements, pending pricing questions.
- [decisions-and-triggers.md](decisions-and-triggers.md) — durable dated decisions; full text of C1–C16 and the security S1 / S2 inventory.
- [store-launch-checklist.md](store-launch-checklist.md) — deferred mobile-phase checklist.
- [documentation-policy.md](documentation-policy.md) — every change to a row in §1 or §2 must also be reflected in `decisions-and-triggers.md` in the same PR.
