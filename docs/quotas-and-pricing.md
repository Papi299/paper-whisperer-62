# Quotas and Pricing (Provisional)

> **Status: provisional. Every number in this document is a starting range, not a commitment.** Final pricing and final quotas require cost modeling and owner approval. Do not surface these numbers in the UI, marketing, or any external communication until they are explicitly ratified. **No commercial functionality is implemented today.**

---

## 1. Recommended plan structure

Five SKUs total: one free trial plus monthly and annual variants of two plans.

| Plan | Cadence | Includes AI? | Storage | Notes |
|---|---|---|---|---|
| **Trial** | 7 days, on first subscribe to any paid plan | Yes, capped (small total) | Same as the chosen plan | Auto-converts to the chosen paid plan unless cancelled |
| **Core Monthly** | Monthly | No, or very small "taste" (TBD) | Smaller cap | Library + import + search + filters + presets + notes + attachments + export |
| **Core Annual** | Annual, discount vs. 12× monthly | Same as Core Monthly | Same | Same feature set |
| **AI Monthly** | Monthly | Yes, with monthly analysis quota | Larger cap | Everything in Core + single + bulk AI analysis |
| **AI Annual** | Annual, discount vs. 12× monthly | Same as AI Monthly | Same | Same feature set |

Annual discount target is broadly comparable to other productivity SaaS (~16–20% off the monthly rate). The exact percentage is owner-decided.

---

## 2. Wording note: avoid "unlimited"

Use **explicit, generous limits** rather than the word **"unlimited"**.

- "Unlimited" invites abuse and complicates support ("but I had **unlimited** storage and now you say I'm capped?").
- It is harder to reason about platform / Supabase / Gemini cost when one tier promises an unbounded resource.
- A cap of, e.g., 5,000 papers reads as effectively unlimited to >99% of individual users while keeping cost modelling tractable.

If a user ever bumps a cap, the support / sales conversation that follows is itself useful product signal.

---

## 3. Provisional quota ranges

These ranges are starting points only. Treat them as **inputs to cost modelling**, not as price-list copy.

### 3.1 Papers

| Plan | Provisional paper cap |
|---|---|
| Core | 2,000 – 5,000 |
| AI | 5,000 – 10,000 |

A "soft warning at 80%, hard limit at 100%" pattern is recommended. The library currently performs comfortably to a few thousand rows on the documented architecture (see [decisions-and-triggers.md](decisions-and-triggers.md)).

### 3.2 AI analyses

| Bucket | Provisional cap |
|---|---|
| Trial | **10 – 25 total** during the 7-day trial window |
| AI plan | **100 – 300 per month** |
| Core plan AI teaser (if offered) | **0 or 5 – 10 per month**, TBD |

The trial cap exists so a 7-day trial does not let a user burn an entire AI-plan month's worth of Gemini calls before deciding.

### 3.3 Storage

| Plan | Provisional cap |
|---|---|
| Core | **500 MB – 2 GB** |
| AI | **2 GB – 5 GB** |

Per-file size is already capped at 20 MB by the bucket configuration; that limit can stay or be raised per plan.

### 3.4 Bulk import batch size

| Plan | Provisional batch cap |
|---|---|
| Core | **100 identifiers per batch** |
| AI | **500 identifiers per batch** |

This limits a single bulk-import session, not the total library size.

---

## 4. Inputs that must drive the final numbers

Quotas and prices cannot be picked from intuition. They need to be back-solved from:

- **Gemini API cost** at typical abstract length (input + output tokens), times the AI quota, times expected adoption rate, with margin.
- **Supabase costs** for the chosen plan tier — database compute, storage, egress bandwidth, Edge Function invocations, Auth, log retention.
- **Apple App Store and Google Play platform fees** on subscription revenue (verify current commission structure at submission time — see [store-launch-checklist.md](store-launch-checklist.md)).
- **Stripe fees** if web subscriptions are sold directly.
- **Chargeback rate / refund rate / trial-to-paid conversion rate** (estimated; refined post-launch with real data).
- **Competitor positioning.** Reference points include Paperpile, Mendeley Premium, Zotero subscription, Readwise Reader, Elicit, SciSpace, Scite, Connected Papers Premium, ResearchRabbit, ChatGPT Plus / Claude Pro for users substituting general LLM tools for paper-specific AI.
- **Target gross margin** the owner is willing to operate at while keeping prices accessible to students / individual researchers.

This document does not assert numbers from the above sources because they shift faster than docs do. The cost-model spreadsheet itself is the source of truth.

---

## 5. Open questions (owner approval required before any UI commits to a number)

1. **Final monthly and annual price** for Core and AI plans.
2. **Annual discount percentage** (or fixed dollar amount).
3. **Whether Core includes any AI teaser at all** — `0` AI calls, or a small monthly allowance like `5–10`?
4. **Trial AI cap** — exact number in the 10–25 range above.
5. **AI monthly quota** — exact number in the 100–300 range above.
6. **Final storage caps** for Core and AI.
7. **Final paper caps** for Core and AI (or a single shared cap with no plan differentiation).
8. **Whether the trial requires a payment method up front** (higher conversion, lower trial signups) **or not** (lower conversion, higher trial signups). Different per-platform realities (Apple often requires a payment method for trials in the auto-renewable subscription flow; verify policy at submission time — see [store-launch-checklist.md](store-launch-checklist.md)).
9. **Whether to support credit packs / one-time AI top-ups later.** Out of scope for MVP per [commercial-architecture.md](commercial-architecture.md), but a re-evaluation point post-launch.
10. **Whether there will be a permanent free tier** alongside Core, or whether only a 7-day trial is offered. Default assumption: no permanent free tier.
11. **Education / student / non-profit pricing.** Out of scope for MVP unless owner adds.
12. **Per-region pricing.** Apple/Google handle currency and regional tiering; Stripe is freeform. Default: use the platform tiers and accept their conversions.
13. **What happens when a user downgrades AI → Core mid-period.** Immediate? End of period? AI quota frozen?
14. **What happens when an AI quota is exhausted.** Hard stop only? Or offer one-time top-up purchases? Decision affects whether credit packs are MVP or post-MVP.
15. **Grandfathering rules** when prices or quotas change post-launch.

---

## 6. Implementation note

None of the numbers in this document are wired into code. There is no `entitlements` row, no `usage_counters` row, no quota check inside `analyze-paper`. When implementation begins, the agreed final numbers should land as **defaults seeded by a migration** (or as configuration in a small `plans` reference table) — not hardcoded into application logic — so a single owner-approved change can adjust them without a code release.

---

## 7. Cross-references

- [commercial-architecture.md](commercial-architecture.md) — the entitlement model these numbers will populate.
- [store-launch-checklist.md](store-launch-checklist.md) — store-side pricing setup, currency tiers, and trial configuration tasks.
- [documentation-policy.md](documentation-policy.md) — every change to these numbers must be reflected here in the same PR.
