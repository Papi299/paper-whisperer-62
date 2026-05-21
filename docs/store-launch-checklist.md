# App Store / Play Store Launch Checklist (Planning — Mobile Phase, Post-Web)

> **Status: planning checklist only, and the mobile launch is now deferred behind the web launch.** No item below is "done" unless explicitly tracked elsewhere as shipped. Apple App Store and Google Play policies, fees, and required questionnaires change frequently. **Every policy item in this document must be re-verified against primary sources within 30 days of submission.** Do not treat any policy claim here as authoritative.
>
> **Strategy pivot (2026-05-21).** The MVP is now **web-first** with **Stripe-first** billing — see [commercial-architecture.md §1](commercial-architecture.md) and the C7–C15 entries in [decisions-and-triggers.md](decisions-and-triggers.md). Mobile / App Store / Play Store launch is **deferred to a later roadmap phase**. The full content of this document remains relevant for that later phase but is not on the critical path for the web MVP. Items that are *also* required before the **web** paid beta (privacy policy, terms, support URL, account deletion, AI disclosure) are still required and are tracked in [commercial-architecture.md §6](commercial-architecture.md). The web launch will land them first; the mobile checklist reuses them when the time comes.

---

## How to use this document

Each section below is a category of readiness. Items use plain Markdown checkboxes for tracking. A few items are gated on policy verification — those are flagged and must be re-checked at submission time.

**Web launch first.** Treat this checklist as the **mobile-phase** checklist. Items relevant to the web launch (privacy / terms / support URL / account deletion / AI disclosure / monitoring) have moved to the web blocker list in [commercial-architecture.md §6](commercial-architecture.md); they will be completed during the web launch and reused here when mobile work begins.

**Billing-provider direction.** Stripe is the web MVP provider per the 2026-05-21 pivot. Apple IAP and Google Play Billing remain the planned ingestion paths when mobile work begins; the [commercial-architecture.md §8](commercial-architecture.md) provider-neutral ingestion model is intact and supports adding them as purely additive Edge Functions.

**Labs / Teams.** This tier is **"Coming Soon" / "Contact Sales" only** in MVP and is a **web-first marketing concern** before it is a native app-store concern. Do not configure Labs / Teams SKUs in App Store Connect or Play Console until the underlying shared-libraries architecture exists — see [commercial-architecture.md §3.3](commercial-architecture.md).

---

## 1. Product readiness

> **Updated for the 2026-05-21 pivot.** Core / AI tiers replaced with Free / Pro / Labs-Teams; the bullets below now describe the **Pro** feature surface that the mobile build will ship with at parity with the web launch.

- [ ] **Free** tier feature surface frozen for v1 (library, identifier + file imports, search, filters, projects, tags, notes, saved searches, exports, attachments within 500 MB, Keyword Pool, 15 lifetime AI calls).
- [ ] **Pro / Researcher** tier feature surface frozen for v1 (everything in Free, plus Synonyms pool, Exclusions pool, full 350 / month AI quota, 2 GB storage, 10,000 paper cap).
- [ ] **Labs / Teams** tier surfaced only as "Coming Soon / Contact Sales" — no IAP SKUs configured.
- [ ] Mobile responsive review for the dashboard, add/edit dialogs, and settings.
- [ ] Paywall / upgrade nudge flow designed and wired (placeholder until billing provider chosen).
- [ ] Subscription manage / cancel / restore links visible from inside the app.
- [ ] Empty-state copy for users at quota / over storage cap / on Core trying AI.
- [ ] Onboarding for first-run signup (what does a brand-new user see right after sign-up?).
- [ ] All "coming soon" or planned-but-not-implemented features clearly labeled in the UI.

## 2. Legal / privacy readiness

- [ ] **Privacy policy URL** published and reachable from the app and from the store listing.
- [ ] **Terms of service URL** published and reachable from the app and from the store listing.
- [ ] Privacy policy lists every third-party data processor: Supabase, Google Gemini, NCBI / PubMed, Crossref, the chosen billing provider.
- [ ] Privacy policy describes: data collected, retention, deletion process, regional rights (GDPR, CCPA), how to contact for data subject requests.
- [ ] Terms of service covers: subscription terms, cancellation, refunds, acceptable use, AI output disclaimer (Paper Whisperer is not a medical device; AI summaries are not medical advice).
- [ ] EULA acceptance / record-keeping mechanism in place.
- [ ] Data Processing Agreement (DPA) with Supabase reviewed.
- [ ] Cookie / local-storage notice if/when a marketing site is added.
- [ ] AI disclaimer surfaced inside the app where AI output is shown ("AI-generated; verify before clinical use").

## 3. Account and data management

- [ ] **In-app account deletion path.** Triggers an Edge Function that deletes user data across all tables, removes storage objects, and finally calls the Supabase admin API to delete the auth user. Required by recent Apple and Google policy — verify exact current requirements at submission time.
- [ ] **Data export.** User can download their own data as a structured archive (CSV/RIS/BibTeX for papers, JSON for projects/tags/pools/presets/notes, plus attachments).
- [ ] Confirmation flow on account deletion (typed confirmation, optional cooldown period).
- [ ] Documented retention policy for billing receipts and audit logs after account deletion (as legally required).
- [ ] Email-change flow tested.
- [ ] Password-reset flow tested (already wired via `/reset-password`; smoke-test before launch).

## 4. Billing / subscription readiness

- [ ] Billing provider chosen (Stripe / Apple IAP / Google Play Billing / RevenueCat / multiple). Captured as a dated decision in [decisions-and-triggers.md](decisions-and-triggers.md) when made.
- [ ] Webhook / RTDN / S2S notification ingestion Edge Functions implemented and idempotent.
- [ ] Internal entitlement model (`user_entitlements`, `subscriptions`, `usage_counters`) populated correctly per [commercial-architecture.md](commercial-architecture.md).
- [ ] Free trial start / convert / cancel flows tested end-to-end on each platform.
- [ ] Subscription **restore** flow on each platform (Apple "Restore Purchases" is a guideline requirement; Google has its own conventions — verify at submission time).
- [ ] Subscription **upgrade / downgrade / change billing period** flow tested.
- [ ] Past-due / canceled / expired status correctly downgrades entitlements at the right time (immediate vs end of period rules captured per platform).
- [ ] Refund handling (provider-driven and manual) reflected in `subscriptions` and `user_entitlements`.
- [ ] Receipt / order-id surfaced for support flows.
- [ ] Currency and per-region price tiers configured in each store console.
- [ ] **Apple billing policy** for digital subscriptions — re-verify current commission structure, allowed external billing arrangements, and reader-app classifications at submission time. *Do not treat any policy claim here as fact.*
- [ ] **Google Play billing policy** — re-verify current commission structure, "user choice billing" availability for the relevant categories, and external-offer rules at submission time. *Do not treat any policy claim here as fact.*

## 5. Mobile / native packaging readiness

- [ ] Native packaging approach chosen (Capacitor wrapping the existing SPA / React Native rewrite / responsive PWA only / other). Captured as a dated decision in [decisions-and-triggers.md](decisions-and-triggers.md) when made.
- [ ] iOS bundle identifier reserved.
- [ ] Android application ID reserved.
- [ ] App icons (all required sizes) produced.
- [ ] Splash screens / launch images produced.
- [ ] Status bar, safe-area, and notch handling verified.
- [ ] Deep link / universal link configuration if used.
- [ ] Push notification entitlement / API key configuration if used.
- [ ] In-app browser handling for OAuth / external-link flows (e.g., the NCBI key generation page) consistent with platform rules.
- [ ] Permissions audit (file picker for imports, document picker for attachments, etc.).
- [ ] Offline behavior intentional (degraded read-only mode? graceful failure?).
- [ ] App size budget reviewed.

## 6. App Store Connect readiness

- [ ] Apple Developer Program membership active.
- [ ] App Store Connect listing created.
- [ ] App name, subtitle, primary category, secondary category set.
- [ ] App description and "What's new" copy drafted.
- [ ] Keywords drafted (within Apple's character limit).
- [ ] Screenshots produced for every required device size.
- [ ] Optional preview video produced.
- [ ] Promotional text drafted.
- [ ] Support URL set.
- [ ] Marketing URL set (if any).
- [ ] Apple **App Privacy** ("Privacy Nutrition Label") questionnaire answered accurately for every data type collected.
- [ ] Apple Sign In considered (required if other third-party sign-in is offered — verify at submission time).
- [ ] Subscription products configured in App Store Connect — **Pro monthly** (and **Pro annual** if shipped). **No Trial introductory offer** (the freemium PLG model replaces the 7-day trial — see [commercial-architecture.md §1](commercial-architecture.md)). **No Labs / Teams SKU** until the shared-libraries architecture exists.
- [ ] Subscription group(s) configured so Apple's auto-renewable upgrade/downgrade UX works.
- [ ] StoreKit testing configuration in Xcode for local QA.
- [ ] Sandbox tester accounts created.
- [ ] Tax / banking / agreements signed in App Store Connect.
- [ ] Export compliance answered (uses encryption? exempt category? annual self-classification report due?).

## 7. Google Play Console readiness

- [ ] Google Play Developer account active.
- [ ] Play Console app created.
- [ ] Store listing copy drafted.
- [ ] Screenshots and feature graphic produced.
- [ ] Promo video produced (optional).
- [ ] Content rating questionnaire answered.
- [ ] **Data Safety** form answered accurately.
- [ ] Target API level meets current Play requirements at submission time.
- [ ] Subscriptions configured in Play Console — match the Pro monthly (and annual if shipped) SKUs from Apple. **No Labs / Teams SKU** until shared libraries exist.
- [ ] Real-Time Developer Notifications (RTDN) Pub/Sub topic configured if Google billing is used.
- [ ] License signing key handled correctly.
- [ ] Play App Signing enrolled.
- [ ] Tax / banking / merchant account configured.

## 8. Beta and testing readiness

- [ ] **TestFlight** internal + external groups defined; beta build uploaded.
- [ ] Google Play **internal testing** track configured; closed/open testing tracks planned if needed.
- [ ] Beta tester recruitment plan (researchers, students, clinicians from the target audience).
- [ ] Beta feedback channel (email / form / Discord / GitHub issues — whatever is consistent with the published Support URL).
- [ ] Subscription flows tested end-to-end with sandbox accounts on each platform.
- [ ] Account deletion flow tested end-to-end with a real (not seed) account.
- [ ] Quota exhaustion paths tested (AI used = quota; storage used = quota).
- [ ] Period rollover tested (artificially advance period_end and confirm counters reset).
- [ ] Crash-free session rate baseline collected before submitting for review.

## 8a. Attachments / PDF storage readiness (shared with web launch)

> The **attachments bucket privacy hardening** and **per-plan storage quota enforcement** items below are also web-launch blockers per [commercial-architecture.md §6](commercial-architecture.md). They will be completed during the web launch and inherited by the mobile build at no additional work.

- [ ] Supabase Storage `attachments` bucket SELECT policy tightened from public-read to owner-only RLS. Signed URLs continue as the read path.
- [ ] `BEFORE INSERT` trigger on `paper_attachments` enforces `storage_quota_bytes` from `user_entitlements` (500 MB Free / 2 GB Pro / 10 GB Labs-Teams future).
- [ ] `AFTER INSERT / DELETE` triggers maintain `usage_counters.storage_used_bytes`.
- [ ] Settings → Storage view shows used / quota.

## 9. Production operations readiness

- [ ] **Crash and error monitoring** in place (Sentry or equivalent), with PII redaction so abstracts/notes/identifiers are never sent.
- [ ] **Web analytics** (privacy-respecting) in place if a marketing site is added.
- [ ] Supabase project on a paid plan if storage / Edge Function quotas warrant.
- [ ] Staging environment distinct from production (separate Supabase project, separate Gemini key, separate billing-provider sandbox).
- [ ] **Edge Function deployment checklist** — every Edge Function change ships with `supabase functions deploy <name> --project-ref <ref>` documented in the PR description (this is already a repo convention; carry it forward for `analyze-paper`, `fetch-paper-metadata`, and any future `*-webhook` ingestion functions).
- [ ] Backups configured (Supabase automatic backups + a periodic logical export of business-critical tables).
- [ ] Disaster recovery runbook (what happens if the project is suspended? credentials rotated?).
- [ ] Incident response plan (Gemini outage, PubMed outage, Supabase outage).
- [ ] On-call / monitoring rotation if any (single-developer reality may simplify this to alerting only).
- [ ] Status page or in-app maintenance banner mechanism.
- [ ] Logs review cadence (Supabase log retention, Edge Function log inspection on a schedule).
- [ ] Cost-monitoring alerts on Supabase, Gemini, and chosen billing provider.

---

## Cross-references

- [commercial-architecture.md](commercial-architecture.md) — the entitlement / billing-neutral architecture this checklist depends on.
- [quotas-and-pricing.md](quotas-and-pricing.md) — provisional quotas to wire into store SKUs after owner approval.
- [documentation-policy.md](documentation-policy.md) — keep this checklist current as items are completed.
