# Owner Decisions — Compact Ledger

> **Purpose.** The compact, owner-facing ledger of durable owner-approved decisions, owner actions, blockers, approvals, and the implementation each decision **unlocks** — across product, commercial, architecture, schema, security, deployment, and operational matters as applicable. This file is the index only: detailed rationale lives in [decisions-and-triggers.md](decisions-and-triggers.md); topic-specific implementation detail lives in the relevant authoritative document — commercial detail in [commercial-architecture.md](commercial-architecture.md) and [quotas-and-pricing.md](quotas-and-pricing.md), schema-reconciliation detail in [schema-reconciliation.md](schema-reconciliation.md).
>
> **How to use this file.** When the owner answers a pending question, move the row from §2 to the appropriate §1 subsection and add a dated entry to `decisions-and-triggers.md`. When a resolved decision unlocks an implementation PR, the unlock is listed inline. Keep this file short — long-form goes in the authoritative topic documents.

---

## 1. Resolved decisions

Full text and rationale for each is in [decisions-and-triggers.md](decisions-and-triggers.md) at the referenced ID.

### 1.1 Commercial, product, and launch decisions (2026-05-21 pivot)

| ID | Decision | Resolved | Implementation unlocked |
|---|---|---|---|
| **C7** | Web-first launch; Apple App Store / Google Play deferred. | 2026-05-21 | The next implementation phase targets the web SPA only. Mobile work parked. |
| **C8** | ~~**Stripe-first** for web billing.~~ **Superseded by C17 (2026-05-21).** Retained as history. | 2026-05-21 | n/a — superseded same-day by C17. |
| **C17** | **Merchant of Record (MoR)-first** for web billing — supersedes C8. Stripe direct is no longer the MVP path due to Israel-side direct-registration constraints; US LLC / Stripe Atlas is excessive overhead for MVP. Apple IAP / Google Play / RevenueCat remain future ingestion paths under the same provider-neutral model. **Stripe is retained as a future option only if owner constraints change.** | 2026-05-21 | C17 establishes the architectural direction; C18 records the provider choice under it. |
| **C18** | **Paddle selected as the MoR provider** for the web MVP under C17. **Lemon Squeezy** is retained as a fallback only and would be reconsidered if Paddle onboarding fails or Paddle materially changes policy. Internal architecture stays provider-neutral; `subscriptions.provider` records `'paddle'` rows in MVP. Paddle reduces payment/tax operational burden **subject to Paddle's terms** — it does not remove all tax/legal obligations. | 2026-05-21 | Next step is **owner-side Paddle setup** (Sandbox account, KYB, domain verification, Product + $15/mo Price, customer portal config, API key, webhook secret, `APP_URL`). After owner setup completes, the next implementation PR is the Paddle integration (`paddle-webhook` + `create-payment-session` + `create-customer-portal-session` Edge Functions + `set_billing_customer` / `recompute_entitlement_from_subscription` RPCs + a small `provider` CHECK-constraint migration). **MVP baselines and provider-neutral internal architecture are unchanged.** |
| **C19** | **Paperlume working commercial brand and `paperlume.app` domain secured.** Working brand only — **not a registered trademark**. Domain registered via **Cloudflare Registrar** (Cloudflare = registrar + DNS). Trademark registration explored and deferred due to cost (Israeli filing ~1,900 ILS for Class 42 alone). No repository / package / app-route / UI / Supabase / env rename in this PR. No DNS records configured. Future architecture: marketing site on `paperlume.app`, Vercel app on `app.paperlume.app`, Resend transactional email on `auth.paperlume.app`, Google Workspace business email on `paperlume.app`. **C17 / C18 unchanged.** | 2026-05-21 | Next step is **owner-side domain / hosting / email setup** (Cloudflare auto-renew + transfer-lock, DNS records when ready, Vercel custom-domain connect, Google Workspace, Resend, Supabase Auth Custom SMTP, SPF / DKIM / DMARC). See [`deployment.md §8a`](deployment.md) for the full pre-paid-beta checklist. Trademark revisited closer to paid public launch / serious B2B outreach. |
| **C9** | **Freemium PLG** replaces the 7-day time-based trial. Free forever with AI teaser is the trial mechanism. | 2026-05-21 | `user_entitlements.subscription_status` does not need a `trialing` state in MVP. Simpler entitlement state machine. |
| **C10** | No paid AI-free **Core** tier in MVP. Two-tier MVP: Free → Pro. | 2026-05-21 | Single paid SKU at first paid launch. Reduces Paddle configuration scope. |
| **C11** | **Free + Pro MVP baselines** (numeric values; instrumentation mandatory): Free $0 / 1,500 papers / 500 MB / 15 lifetime AI; Pro $15/mo / 10,000 papers / 2 GB / 350 AI per month. | 2026-05-21 | Entitlement / usage schema (next PR) can seed Free with concrete defaults. Marketing pricing page can be drafted with these numbers. **Not permanent** — see C11 re-evaluation trigger. |
| **C12** | **Labs / Teams** is **"Coming Soon" / "Contact Sales"** only. Not self-serve in MVP. Not sellable until shared-libraries + seat-management exist. | 2026-05-21 | Marketing pricing page can include the Labs / Teams row as anchor. Lead-capture form can be drafted. **No Paddle / Apple / Google / Stripe SKU** for this tier. |
| **C13** | Add-on **AI credit packs** are a future feature; not MVP. Architecture must support them from day one (shape `usage_credits` + `consume_ai_quota` correctly). | 2026-05-21 | Next schema PR ships `usage_credits` placeholder and the credit-pack RPC contract. Implementation lands later as a fast-follow if churn pressure shows up. |
| **C14** | **Attachments / PDF storage** are in launch scope. **Privacy hardening** (close public-bucket gap) and **storage quota enforcement** are launch blockers. | 2026-05-21 | Migration: tighten `attachments` SELECT to owner-only; add `BEFORE INSERT` quota trigger and `AFTER INSERT/DELETE` usage trigger. Required before paid beta. |
| **C15** | **Hebrew / RTL** is out of scope for MVP. | 2026-05-21 | No i18n / RTL framework work in MVP. |
| **C16** | **Legal pages** (Privacy / Terms / AI disclosure / Support) live on an **external marketing site**. Repo links to HTTPS URLs. | 2026-05-21 | In-app links to the external URLs are a launch blocker. No legal text shipped in the repo. |

### 1.2 Schema reconciliation decisions (2026-07-18)

Canonical end state and the ordered implementation roadmap: [schema-reconciliation.md](schema-reconciliation.md).

| ID | Decision | Resolved | Implementation unlocked |
|---|---|---|---|
| **C20** | **`papers.statistical_methods` canonical type is `jsonb`** with a stored-value invariant of SQL `NULL` or a JSON string; existing JSON `null`s / arrays are transitional and get normalized, then constrained. Domain type stays `string \| null`. Details: [schema-reconciliation.md](schema-reconciliation.md). | 2026-07-18 | `RECON-STATISTICAL-METHODS-001`. |
| **C21** | **Dead legacy columns are removed**: `papers.urls`, `synonym_pool.primary_term`, `synonym_pool.variants` (all empty/unreferenced; emptiness re-verified at deploy time). | 2026-07-18 | `RECON-LEGACY-COLUMNS-001`. |
| **C22** | **Composite-PK junction model** for `paper_tags` / `paper_projects` (matches production); no surrogate IDs, no unused `created_at`; RPCs and types aligned. | 2026-07-18 | `RECON-JUNCTIONS-001` — first reconciliation PR. |
| **C23** | **Constraint hardening** *(amended 2026-07-19)*: NOT NULL on the eight drifted `user_id` columns plus `synonym_pool.canonical_term`/`synonyms` and `study_type_pool.hierarchy_rank`/`specificity_weight`, guarded by zero-null preflight; additionally restores `synonym_pool.synonyms DEFAULT '{}'::text[]` (present in clean replay since `20260203133100`, absent in production — discovered by the `RECON-INTEGRITY-001` preflight). No backfill, deletion or invented values; no other default in scope. | 2026-07-18 (amended 2026-07-19) | `RECON-INTEGRITY-001`. |
| **C24** | **Every reconciliation migration is applied remotely** through the deployment runbook even when it is a structural no-op against production — ledger parity is mandatory alongside schema parity. | 2026-07-18 | Applies to every RECON-* PR. |
| **C25** | **Ordering: schema reconciliation → parity verification → generated types → TypeScript baseline → CI → branch protection.** Generated Supabase types are not committed until every type-affecting difference is reconciled. | 2026-07-18 | Gates `TYPESCRIPT-BASELINE-001` and `CI-BASELINE-001` resumption. |
| **C26** | **Remaining metadata & index parity** (final reconciliation step): drop `projects.updated_at` (+trigger), remove the duplicate `papers` updated-at trigger, converge eight `created_at` defaults to `now()`, enforce `study_type_pool.created_at` NOT NULL, converge `tags.color` default to `'#e2e8f0'`, drop seven redundant single-column indexes; `papers.search_vector` (proven equivalent) and the SEC-4 default grants are approved benign/artifact exclusions. Details: [schema-reconciliation.md](schema-reconciliation.md). | 2026-07-19 | `RECON-METADATA-PARITY-001` (final RECON PR); unblocks `TYPESCRIPT-BASELINE-001` once deployed. |

---

## 2. Still pending / needs validation

Pending decisions and validation tasks — currently all commercial/launch items; future non-commercial owner decisions (schema, security, operational) belong here too. Each must be resolved (or scheduled) before the listed implementation phase can begin. Items are ordered by approximate gating order.

### 2.1 Required before Paddle integration begins

| Decision / task | Why blocking | Status |
|---|---|---|
| **Owner-side Paddle Sandbox setup** (C18). Includes: (1) Paddle Sandbox account; (2) KYB / business verification for the Israeli operator; (3) domain verification; (4) identity verification; (5) Pro Product created; (6) $15 / month recurring Price created → capture `price_id`; (7) Paddle API key generated → goes to `PADDLE_API_KEY` Supabase secret; (8) webhook notification destination plan (signing secret captured once the Edge Function URL is registered); (9) customer portal configured (allow: cancel subscription, update payment method, view invoices; do **not** enable plan-switching); (10) `APP_URL` decided (production Vercel URL). | C18 requires all of these to land before the Paddle integration PR can start. None of them are repo-side actions; they are owner actions in the Paddle dashboard. Paddle approval is **not** guaranteed by this decision — if KYB fails, the Lemon Squeezy fallback per C18 is re-opened. | **Pending owner setup.** **Next required task.** Recommended environment: Paddle Sandbox first; Live setup duplicated after Sandbox proves out. |
| **Marketing site provider** (Webflow / Framer / Vercel / Cloudflare Pages / other) — and host the marketing site at `paperlume.app` per C19. Legal URLs will be `paperlume.app/privacy`, `/terms`, `/ai-disclosure`, `/support`, etc. | C16 requires the external URLs to exist before the in-app links can be wired. The marketing site is the publication target for Privacy / Terms / AI disclosure / Support. | Pending owner choice. Domain (`paperlume.app`) is secured at Cloudflare Registrar; provider for the marketing-site front-end is still pending. |
| **Cloudflare domain hygiene** for `paperlume.app` (C19). Confirm auto-renew is enabled. Confirm transfer-lock / registry-lock is enabled. Save the domain receipt + RDAP info in a private password manager (not in the repo). | Auto-renew prevents accidental domain loss at expiry. Transfer-lock prevents social-engineering domain hijacks. The receipt + RDAP info are needed for future Paddle KYB and any domain-recovery scenario. | ✅ **Completed (2026-05-22).** |
| **App-domain + transactional-auth-email setup** on `paperlume.app` (C19, partial). Connect Vercel custom domain `app.paperlume.app` (DNS-only Cloudflare records on initial connection); Resend on `auth.paperlume.app` with SPF / DKIM / DMARC; Supabase Auth Custom SMTP pointed at Resend; Paperlume-branded Supabase Auth email templates; Supabase Auth `Site URL` + `Redirect URLs` updated to `https://app.paperlume.app`. | Required before paid beta — see [`deployment.md §8a`](deployment.md) for the full checklist. | ✅ **Completed (2026-05-22).** Owner smoke-tested auth emails across multiple inboxes; emails arrive in regular inbox, not spam. App import smoke test passed on the new domain. Inbox-placement rate should be monitored for the first 2–4 weeks as `auth.paperlume.app` reputation matures. |
| **Google Workspace business email** on `paperlume.app`. Set up `maor@`, `support@`, `billing@`, `legal@` as users / groups / aliases. | Required before broader beta if user-facing templates reference `support@paperlume.app` (the owner's branded Supabase Auth templates do). Adds operational credibility for Paddle KYB; does **not** guarantee Paddle approval. | **Pending owner setup.** Independent of auth-email delivery (which is handled by Resend); independent of Paddle integration. Recommended sequence: do this before broader beta so any reply to `support@paperlume.app` lands in a real inbox. |
| **Marketing site provider + root-domain hosting**. Marketing site at the root `paperlume.app` (Framer / Webflow / Vercel / Cloudflare Pages / other). Hosts privacy / terms / AI disclosure / support URLs. Decide `www.paperlume.app` routing (optional alias). | Required before paid beta — C14 / C16 require the external legal URLs to be live before the in-app links can resolve. | **Pending owner choice + setup.** |
| **Privacy policy + terms of service drafts**, then professional legal review. | Required by C16 before paid beta. Cannot ship without published URLs. **MoR / Paddle adoption does not remove this requirement.** | Pending owner / legal commissioning. |
| **AI disclosure copy** (what content goes to Google Gemini, how Google handles it per Google's policies, how users opt out). | Required at the Analyze action and in Settings → Privacy. | Pending owner authoring; references Google's published Gemini API data-handling policy. |
| **Support channel** — `support@…` email, in-app contact form, or other. | Required for the marketing site's Support URL and for the App Store / Play Store later. | Pending owner choice. |
| **Monitoring / error-tracking provider** (Sentry / Better Stack / DataDog / PostHog-with-errors). | Required by [commercial-architecture.md §6](commercial-architecture.md) before paid beta. PII redaction is non-negotiable. | Pending owner choice. |
| **Staging environment timing** — when does the second Supabase project + second Vercel project + Paddle Sandbox account come online? | Recommended before paid beta so billing isn't tested against production. | Pending owner schedule. Paddle Sandbox is part of this. |

### 2.1a Resolved (no longer pending)

| Decision | Status |
|---|---|
| **Billing-provider direction (Stripe-first vs MoR-first).** | ✅ Resolved by C17 (2026-05-21): MoR-first; Stripe direct retired as MVP path. |
| **US LLC / Stripe Atlas formation for MVP.** | ✅ Resolved by C17 (2026-05-21): rejected as overkill for an independent operator validating MVP. Re-open only if commercial scale justifies the entity overhead. |
| **MoR provider selection (Paddle vs Lemon Squeezy).** | ✅ Resolved by C18 (2026-05-21): **Paddle** selected as the MoR provider for the web MVP; Lemon Squeezy retained as fallback only. |
| **Working commercial brand and primary working domain.** | ✅ Resolved by C19 (2026-05-21): brand = **Paperlume**, primary domain = **`paperlume.app`** (Cloudflare Registrar). **Trademark registration deferred**, not abandoned — revisited closer to paid public launch / serious B2B outreach. |
| **App domain + transactional Auth email infrastructure** (C19 operational setup). | ✅ Completed by owner (2026-05-22). `app.paperlume.app` is live on Vercel; Resend configured on `auth.paperlume.app` with SPF / DKIM / DMARC verified; Supabase Auth Site URL + Redirect URLs updated; Custom SMTP routes Auth email through Resend; Paperlume-branded Auth email templates configured; multi-mailbox smoke test passed (inbox, not spam); app import smoke test passed on the new domain. Ongoing inbox-placement monitoring for 2–4 weeks as `auth.paperlume.app` sending reputation matures. Detailed status in [`deployment.md §8a`](deployment.md). |
| **Attachment bucket privacy** (the C14 "privacy" half). | ✅ Resolved by PR #144 audit: already closed by `20260327100000_private_attachments_bucket.sql` (retro-documented in `migration-history.md`). |
| **Storage quota enforcement** (the C14 "quota" half). | ✅ Resolved by PR #144: `user_storage_usage` + BEFORE INSERT trigger live in `20260521030000_…`. |
| **AI quota enforcement.** | ✅ Resolved by PR #143: `consume_ai_quota` / `refund_ai_quota` RPCs + `analyze-paper` integration. |

### 2.2 Required before closed paid pilot

| Decision / task | Why blocking | Status |
|---|---|---|
| **Closed paid pilot cohort size and terms** — invite-only N users, charge real money or comp at a discount, length of pilot before opening broader beta. | Defines the pilot launch contract. | Pending owner decision. |
| **Annual cadence at first paid launch?** — chosen MoR provider annual SKU configured at MVP, or monthly-only with annual as fast-follow. | Affects MoR provider product configuration scope. Default if undecided: monthly only at first launch. | Pending owner decision. |
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
| **Per-region pricing** beyond the chosen MoR provider's defaults. | Default: provider defaults. Revisit if pilot shows geographic concentration. |
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
| 5 | **MoR provider-selection audit** (Paddle vs Lemon Squeezy) per C17. **Docs / audit only — no code.** | #2 + #3 + #4 (all complete). | ✅ **Completed (C18, 2026-05-21) — Paddle selected.** Lemon Squeezy retained as fallback only. |
| 6 | **Owner-side Paddle setup gate** (no code; owner action). Paddle Sandbox account; KYB / business verification; domain verification; Pro Product creation; $15 / month recurring Price; capture Price ID; API key; webhook signing secret; customer portal configuration; `APP_URL` decided. | #5 (provider selected). | **Unblocked. Recommended next task — owner action, not engineering work.** |
| 7 | **Paddle integration PR** — three Edge Functions: `paddle-webhook` (idempotent ingestion + recompute of `user_entitlements`); `create-payment-session`; `create-customer-portal-session`. Plus `_shared/paddle.ts`, `set_billing_customer` / `recompute_entitlement_from_subscription` SECURITY DEFINER RPCs, and a small migration extending the `provider` CHECK constraints to include `'paddle'`. | #6 (owner setup complete). | Blocked on #6. **Do not start engineering work until #6 is complete.** |
| 8 | **UI: paywall / upgrade / quota state** — `<UpgradeNudge>`, per-action quota display, Settings → subscription / Paddle customer portal / cancel; quota-aware error toasts surfacing the existing 402 (AI) and `Storage quota exceeded` (storage). | #7. | Blocked on #7. |
| 9 | **Privacy + Account deletion + AI disclosure + Support links** — Edge Function for cascade deletion + Settings surface + external URLs wired. | External marketing site URLs from §2.1. | Blocked on §2.1 owner choices. |
| 10 | **Closed technical beta on Paddle Sandbox.** | #8, #9. | Blocked on #8, #9. |
| 11 | **Closed paid pilot on Paddle Live.** | #10 plus §2.2 owner decisions. | Blocked on #10 + §2.2. |
| 12 | **Open beta.** | #11. | Blocked on #11. |

---

## 4. Cross-references

- [commercial-architecture.md](commercial-architecture.md) — durable architecture rationale and table shapes.
- [quotas-and-pricing.md](quotas-and-pricing.md) — MVP baseline values, instrumentation requirements, pending pricing questions.
- [decisions-and-triggers.md](decisions-and-triggers.md) — durable dated decisions; full text of C1–C19 and the security S1 / S2 inventory.
- [store-launch-checklist.md](store-launch-checklist.md) — deferred mobile-phase checklist.
- [documentation-policy.md](documentation-policy.md) — every change to a row in §1 or §2 must also be reflected in `decisions-and-triggers.md` in the same PR.
