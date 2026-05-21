# Quotas and Pricing (MVP Baselines)

> **Status: MVP baselines with instrumentation requirement, not final commitments.** Every numeric value below is an **approved starting point** for implementation. Each value must be wired with telemetry from day one of the closed beta so it can be validated against real usage, AI cost, conversion, and abuse signals before it is treated as permanent. Do not surface specific numbers in marketing copy outside the planned MVP pricing page until they are explicitly ratified post-beta. **No commercial functionality is implemented today.**
>
> **Strategy pivot (2026-05-21).** The prior framing (Core / AI tiers, 7-day time-based trial, single-user-only) has been superseded by a **web-first Product-Led Growth (PLG)** model with **Stripe-first** billing, a **Free forever** tier with an AI teaser, **Pro / Researcher** as the primary paid SKU, and **Labs / Teams** as a future B2B "Coming Soon / Contact Sales" tier. See the [Commercial strategy pivot (2026-05-21)](decisions-and-triggers.md) entries (C7–C15) and the rewritten [commercial-architecture.md](commercial-architecture.md).

---

## 1. The pivot in one paragraph

There is **no 7-day time-based trial** in MVP. There is **no paid AI-free Core tier** in MVP. The freemium model **is** the trial: Free forever creates habit formation, the AI teaser (15 lifetime calls) is the upgrade lever, and Pro / Researcher is the primary self-serve paid tier at an MVP baseline of $15 / month. A Labs / Teams tier is shown on the marketing site as **Coming Soon / Contact Sales** for lead capture and price anchoring; it is **not self-serve in MVP** and **must not be sold** until the underlying multi-user / shared-libraries architecture exists.

---

## 2. Plan structure

Three tiers. One is the entry funnel, one is the primary paid SKU, one is a roadmap signal.

| Tier | Status | Price (MVP baseline) | Paper limit | Storage | AI quota | Key features | Notes |
|---|---|---|---|---|---|---|---|
| **Free** | MVP, self-serve | $0 forever | 1,500 | 500 MB | **15 lifetime** AI calls | Core library, identifier + file imports, search, filters, projects, tags, notes, saved searches / filter presets, exports, attachments (within cap), **Keyword Pool** | PLG entry point + AI teaser. Excludes Synonyms / Exclusions (Pro-only). |
| **Pro / Researcher** | MVP, self-serve | **$15 / month** | 10,000 | 2 GB | **350 / month** | Everything in Free, plus **Synonyms pool** + **Exclusions pool**, full monthly AI quota | Primary monetization tier. Annual cadence at a discount in scope if cheap with Stripe; otherwise fast-follow. |
| **Labs / Teams** | **Roadmap — "Coming Soon" / "Contact Sales" only. NOT self-serve.** | $99–$149 / month baseline range, **up to 5 seats** | unlimited | 10 GB | TBD (likely team-level pool) | Future: shared libraries, seats, owner / admin roles, invitations, team-level entitlements, possible SSO | Not sellable until shared-libraries + seat-management architecture exists. Lead capture + price anchoring only. |

### Free tier — feature inclusions and exclusions

The Free tier exists to let a serious user **build a working library** and form the habit of using Paper Whisperer for their research. It is not a gimmick or a marketing decoration.

**Free includes:**
- All core organization features: papers, projects, tags, notes, exports, filter presets.
- All search modes (short, FTS, quoted-phrase, `Matched in:` attribution).
- Identifier import (PMID + DOI) and file import (CSV / RIS / BibTeX).
- Attachments / PDF storage (within the 500 MB cap).
- **Keyword Pool** (manual term curation).
- A small lifetime AI taste (15 calls total, from sign-up until upgrade) so the user can try the analyze flow on a few of their own papers without committing.

**Free excludes (intended as Pro-only premium taxonomy):**
- **Synonyms pool.**
- **Exclusions pool.**

Both Synonyms and Exclusions are currently user-accessible features in the codebase. **Gating them by entitlement is a launch blocker** before paid beta; until the gate is wired, a Free user can use the full taxonomy and there is no reason to upgrade. The gate lives server-side at the relevant RPC and is mirrored client-side as feature visibility, per [commercial-architecture.md §2.3](commercial-architecture.md).

### Pro tier — what it adds

- The remaining premium taxonomy features (Synonyms + Exclusions).
- A real monthly AI quota (350 / month at MVP baseline) instead of the 15-lifetime taste.
- Larger storage and paper caps that reflect the working volume of an active researcher rather than the demo volume of someone evaluating.
- Eligibility for **future** add-on AI credit packs (see §6) so a researcher doesn't get hard-blocked mid-project.

### Labs / Teams tier — what it is and is not

**What it is, today:** A row on the marketing pricing page that reads "Labs / Teams — Coming Soon — Contact Sales". A lead-capture form that emails the owner. A signal to academic labs, clinical research groups, and dietitian / clinician teams that the product has an institutional path.

**What it is not, today:** Sellable. A real SKU in Stripe. A live entitlement.

**What it requires before it can be sold:**
- Shared libraries (multiple users on the same paper library).
- Seat management (owner + member roles, invitations, removal).
- Team-level entitlements (`team_entitlements` table or similar; the `user_id`-keyed `user_entitlements` shape doesn't fit).
- Audit log of team actions.
- Likely SSO for institutional buyers.

Each of those is a multi-PR effort. The current single-user codebase partitions every user-scoped table on `user_id` and the RLS scheme is built around that assumption; adding shared libraries is the largest single piece of post-MVP work.

**Pricing of Labs / Teams is a baseline range, not a quote.** $99 – $149 / month for up to 5 seats is the documented anchor range; the final number will be back-solved from team-cost modelling, customer interviews, and the AI-cost data we will have by then.

---

## 3. MVP baseline vs final pricing

The numbers in §2 are **MVP baselines**. The decision to ship with these specific values is approved; the decision that these values are permanent is **not**.

What "MVP baseline" means concretely:

- The closed beta and the closed paid pilot ship at these prices and quotas.
- The marketing pricing page uses these prices and quotas at launch.
- The instrumentation requirements in §4 are mandatory from day one of the closed beta.
- After 60–90 days of pilot data, the values are re-evaluated against:
  - Real Gemini cost per call (input + output tokens at observed abstract length).
  - Real storage usage per user.
  - Real paper count per user (does the Pro 10,000 cap actually bind for anyone?).
  - Real conversion from Free to Pro at various AI-teaser exhaustion points.
  - Real abuse signals (users hammering the AI quota, multiple-account behavior).
- Any change to these numbers post-launch must be documented as a dated decision in [decisions-and-triggers.md](decisions-and-triggers.md) and must be reflected here in the same PR.

---

> **Server-side enforcement status (2026-05-21).** The AI quota values above are now backed by **server-side enforcement** inside the `analyze-paper` Edge Function via the `consume_ai_quota` / `refund_ai_quota` SECURITY DEFINER RPCs (`20260521020000_add_ai_quota_rpcs.sql`). The **storage quota** values are now backed by server-side enforcement via the BEFORE INSERT / AFTER DELETE triggers on `paper_attachments` and the new `user_storage_usage` table (`20260521030000_harden_attachment_privacy_and_storage_quota.sql`). The `attachments` Storage bucket has been **private with owner-scoped SELECT** since `20260327100000_private_attachments_bucket.sql` (retro-documented in `migration-history.md`). Paper-count limits remain client-side-only for now (low priority; the `safe_bulk_insert_papers` RPC can be extended in a small later PR if needed). Numeric values are unchanged.

## 4. Instrumentation requirements (mandatory before closed beta)

The schema, Edge Functions, and observability layer must track the following from day one. Without this telemetry, the §3 re-evaluation is impossible.

**Per-user usage metrics:**

- AI calls attempted (per call: `paper_id`, `user_id`, timestamp).
- AI calls successful (Gemini returned a parseable result).
- AI calls failed (Gemini error, parse failure, network failure — distinguish).
- AI quota-exhausted events (user hit `quota_exceeded` from `consume_ai_quota`).
- Storage used (bytes) per user, sampled from `usage_counters` on a daily cadence.
- Paper count per user, same cadence.
- Library age (days since sign-up) per user.
- Free → Pro upgrade events (Stripe webhook → `subscription_events`).
- Pro → cancel events.
- AI calls remaining at upgrade (how close to the wall does a converter typically get?).

**Per-call cost telemetry (recommended for the AI cost calibration):**

- Token count in (title + abstract length).
- Token count out (Gemini response length).
- Gemini API latency.
- Whether the response parsed cleanly.

Gemini does not currently bill per-token in a way visible at request time — the **estimated** cost per call is computed offline from observed token counts × the published rate per million tokens. Document the cost-estimation formula alongside the dashboard.

**Funnel metrics:**

- Sign-ups (Free users created).
- Time-to-first-paper (sign-up → first paper added).
- Time-to-first-AI-call.
- Time-to-AI-quota-exhausted (for users who exhaust).
- AI-exhausted → upgrade rate.
- AI-exhausted → churn rate (user never returns after the wall).
- 30-day-active rate by tier.
- Labs / Teams contact-form submissions and source (which pricing-page row was clicked).

**Privacy.** No abstract text, no notes content, no identifier values appear in telemetry payloads. Telemetry events carry IDs and counts, not user content. This is non-negotiable; mishandling it would breach the privacy policy that hasn't been written yet but absolutely will say "we don't share your research with third parties beyond the AI provider you explicitly opted into."

---

## 5. Open questions (owner approval / validation required)

These items are **not gating** for the next implementation PR (schema), but each will be needed before paid beta or before the relevant feature ships. Each lives also as a row in [owner-decisions.md](owner-decisions.md).

1. **Labs / Teams exact AI quota model** — team-level pool vs. per-seat allocation vs. shared base + per-seat overage. Decision can wait until the shared-libraries architecture is being designed.
2. **Add-on AI credit pack pricing** — e.g. `+100 AI calls for $X` one-time. Architecture support is required from the start (see §6); pricing is later.
3. **Annual discount percentage** — broadly 16–20% off the monthly rate is typical; exact number owner-decided. May or may not ship at the very first paid launch depending on Stripe-side configuration cost.
4. **Marketing site provider and legal URL structure** — Webflow / Framer / other. Decides where `privacy.paperwhisperer.com` (or equivalent) lives.
5. **Monitoring / error-tracking provider** — Sentry / Better Stack / DataDog / PostHog-with-errors. Required before paid beta per [commercial-architecture.md §6](commercial-architecture.md).
6. **Support channel** — `support@…` email, in-app contact form, Discord, or other. Required for the marketing site's Support URL.
7. **Staging environment timing** — when does the second Supabase project (and second Vercel project, separate Gemini key, sandboxed Stripe) come online? Recommended before paid beta to avoid testing billing against production.
8. **Closed paid pilot cohort size and terms** — invite-only N users, charge real money or comp at a discount, length of pilot before opening to broader paid beta.
9. **Free → Pro grandfathering** — when MVP-baseline numbers move post-pilot, do existing Free users keep the launch caps or migrate to new ones? Same question for Pro pricing.
10. **Education / student / non-profit pricing** — out of scope unless owner adds. Recommend deferring until post-launch demand signal.
11. **Whether the Pro tier ships with annual at launch** — Stripe configuration cost vs. SKU complexity. Default: monthly only at first paid launch; annual as fast-follow.
12. **What happens when an AI quota is exhausted on Pro** — hard stop only (today's plan), or offer add-on credit pack inline (requires §6 ahead of paid beta)?
13. **Per-region pricing** — Stripe's defaults vs. tier-specific currency adjustments. Default: Stripe defaults.

---

## 6. Add-on credit packs (future, not MVP)

The architecture must support add-on credit packs from day one so they can ship later **without** refactoring the quota path. Doing this is a matter of shaping `consume_ai_quota` and `usage_credits` correctly in the next schema PR — see [commercial-architecture.md §4.5 and §5.3](commercial-architecture.md).

What add-on credits will be when they ship:

- A user on Pro who exhausts their 350 / month AI quota can buy, e.g., `+100 AI analyses` as a one-time Stripe charge.
- The credit balance accrues in `usage_credits` and is consumed **after** the monthly quota is exhausted, before the user is hard-blocked.
- The credit pack may have an expiry (e.g., consumable within 90 days) or may roll forever — owner decision later.
- The application code (`analyze-paper`) does not change; the `consume_ai_quota` RPC absorbs the credit-pack logic.

**Why this matters for MVP design even though we don't ship it now.** Researchers in the middle of a systematic review do not appreciate hard quota walls. A hard wall at the monthly cap with no escape valve creates churn pressure and dampens trial-to-paid conversion. Shipping Pro with a hard wall is acceptable for the first paid pilot if the architecture lets us add credit packs in a small fast-follow PR; shipping a Pro tier that **cannot** add credit packs without a schema rewrite is a longer-tail risk.

---

## 7. Inputs that must drive the final numbers

Re-evaluation of the §2 baseline values after closed beta should be back-solved from:

- **Gemini API cost** at observed abstract token lengths × the AI quota × adoption rate × margin target.
- **Supabase costs** for the chosen plan tier — database compute, storage, egress, Edge Function invocations, Auth, log retention.
- **Stripe fees** on web subscription revenue (current published structure).
- **Chargeback / refund / Free → Pro conversion rates** observed in closed beta.
- **Competitor positioning** — Paperpile, Mendeley Premium, Zotero subscription, Readwise Reader, Elicit, SciSpace, Scite, Connected Papers Premium, ResearchRabbit, and the cost of substituting general-purpose LLM tools (ChatGPT Plus / Claude Pro) for paper-specific AI.
- **Target gross margin** the owner is willing to operate at while keeping prices accessible to students and individual researchers.

This document does not assert numbers from the above sources because they shift faster than docs do. The cost-model spreadsheet itself is the source of truth.

---

## 8. Cross-references

- [commercial-architecture.md](commercial-architecture.md) — the entitlement model these numbers populate and the launch-blocker list.
- [store-launch-checklist.md](store-launch-checklist.md) — App Store / Play Store readiness items (deferred to post-web-launch).
- [documentation-policy.md](documentation-policy.md) — every change to these numbers must be reflected here in the same PR.
- [decisions-and-triggers.md](decisions-and-triggers.md) — C7–C15 capture the 2026-05-21 pivot.
- [owner-decisions.md](owner-decisions.md) — compact ledger of resolved + still-pending commercial decisions.
