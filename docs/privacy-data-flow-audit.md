# Privacy and Data-Flow Audit — PAPERLUME-PRIVACY-001A

> **Status: evidence-backed factual inventory. Not a privacy policy, and not legal advice.**
>
> This document records what PaperLume's source, schema and configuration *actually do* with data, as of the commit named in §1. It exists so that a Privacy Policy and the Chrome Web Store privacy disclosures can be written from verified facts rather than from assumption. It deliberately contains **no final legal prose** — §17 offers a policy outline only.
>
> Every row is labelled with a confidence class (§2). Anything the source cannot establish is marked as needing owner input or first-party verification against a third party's own published terms, and is **not** guessed at.

---

## 1. Audit basis

| Item | Value |
|---|---|
| Repository | `Papi299/paper-whisperer-62` |
| Audited commit (`origin/main`) | `eaa4b9bfd475caafc032625f47b0c4e6b2b6c9fd` |
| Tree | `354b5338480d3ea60592bc1ba6bd36b1633a9c67` |
| Working tree at audit time | Clean |
| Open pull requests at audit time | None |
| Audit date | 2026-08-29 |
| Method | Read-only inspection of application source, `supabase/migrations/**`, `supabase/functions/**`, `extension/**`, configuration and documentation, plus **read-only** Production Supabase metadata queries (`pg_policies`, `storage.buckets`, table/RLS listing) and one read-only Supabase Management API project lookup. **No SQL writes, no migration, no deploy, no configuration change, no Production mutation of any kind.** |

**Scope boundary.** This audit reads. It changed no application behaviour, no `supabase/**` file, no dependency, and nothing in Production. Where the audit found a genuine gap, the gap is *described here* rather than fixed — closing any of them is separate product or security work.

---

## 2. Confidence classification

| Class | Meaning |
|---|---|
| **VERIFIED** | Established directly from repository source, migrations, configuration, or read-only Production metadata. A policy sentence can be written from it. |
| **PARTIALLY VERIFIED** | The mechanism is verified, but a material part of the fact (a live dashboard setting, an operational practice, a third party's own behaviour) is outside the repository. |
| **OWNER INPUT REQUIRED** | The source establishes nothing; only the owner can decide or supply it. Do not invent a value. |
| **EXTERNAL POLICY VERIFICATION REQUIRED** | Depends on a third party's published terms (retention, training use, sub-processors, transfer mechanism). Must be read first-party from that provider before any claim is made. |

---

## 3. Executive summary of what was found

1. **PaperLume stores one user's research library, scoped per user.** Papers (including title, abstract, authors, PMID, DOI, journal, keywords, MeSH terms, notes and AI-generated summaries), Projects, Tags, four normalization/exclusion pools, saved filter presets, user-declared author identities, and attachment binaries.
2. **Account identity is minimal.** Email and an opaque user UUID, from Supabase Auth. Optional display name. One optional user-supplied credential: an NCBI PubMed API key.
3. **Four external services receive data today**: Supabase (all storage/auth), Google Gemini (title/abstract, or title/abstract/keywords/study-type plus Project and Tag *names*), NCBI E-utilities (identifiers and search queries), Crossref (DOI or title). Two more receive no user content: Google Cloud Monitoring (aggregate provider metrics, owner/manager only) and Vercel (static hosting).
4. **A fifth processor is live but configured outside this repository**: **Resend**, as Supabase Auth's custom SMTP, which handles transactional auth email and therefore the user's email address.
5. **There is no application analytics, telemetry, error-reporting, advertising or fingerprinting of any kind.** See §10.
6. **The Chrome extension is exceptionally narrow**: `activeTab` only, no storage, no content scripts, no network capability at all. Re-verified against merged source in §11. *(Amended 2026-08-29 — the extension now also declares `scripting` and reads four bibliographic `<meta>` values from an invoked tab. It remains narrow: still no storage, still no content scripts, still no network capability, still no host permission. See §24.)*
7. **Account deletion is implemented and is a hard delete**, with two evidenced exceptions (§12.4) and one class of external record it cannot reach (§12.5).
8. **No retention period is defined anywhere in source.** Data is retained until the user deletes it or deletes their account.
9. **No privacy policy, terms, cookie policy, age gate, legal entity, or privacy contact exists in the repository or the running app.** All are owner input.

---

## 4. User and account data

Source of each category, its purpose, where it lives, whether it is required, and what happens on deletion.

| Category | Source | Purpose | Storage location | Required? | Deletion behaviour | Class |
|---|---|---|---|---|---|---|
| **User UUID** | Generated by Supabase Auth at signup | Primary identity; every row and Storage path is keyed on it | `auth.users`, and as `user_id` on every application table | Required | Hard-deleted by `auth.admin.deleteUser(userId, false)` | VERIFIED |
| **Email address** | Typed by the user at signup ([`src/pages/Auth.tsx:118`](../src/pages/Auth.tsx#L118)) | Authentication, email confirmation, password reset | `auth.users`, plus a mirrored copy in `public.profiles.email` written by the `handle_new_user()` signup trigger | Required | Both deleted — `profiles` cascades on `auth.users` | VERIFIED |
| **Password** | Typed by the user | Authentication | Supabase Auth (hashed by GoTrue; never in application tables) | Required | Deleted with the Auth user | VERIFIED |
| **Display name** | User-editable column | Display | `profiles.display_name` | Optional; nullable, and no UI writes it today | Cascade-deleted | VERIFIED |
| **NCBI PubMed API key** | Pasted by the user in Settings ([`src/hooks/useSettings.ts`](../src/hooks/useSettings.ts)) | Raises the user's own NCBI rate limit on their searches and imports | `profiles.pubmed_api_key`, **plaintext**, RLS-protected owner-only | Optional | Cascade-deleted. **Excluded by construction from the account data export** — the export uses an explicit column projection, not `select("*")` ([`fetchAccountExportData.ts`](../src/lib/accountExport/fetchAccountExportData.ts)) | VERIFIED |
| **Entitlement / plan state** | Seeded at signup with Free defaults by the signup trigger | Quota and limit enforcement | `user_entitlements` (plan, plan status, AI monthly/lifetime quota, paper limit, storage quota bytes, feature flags, billing customer/subscription id columns) | Automatic | Cascade-deleted | VERIFIED |
| **AI usage counters** | Written by the `consume_ai_quota` / `refund_ai_quota` RPCs | Quota enforcement | `usage_counters` — feature name, period, integer used/reserved counts. **No prompt, paper, or content is recorded** | Automatic | Cascade-deleted | VERIFIED |
| **Storage usage total** | Maintained by triggers on `paper_attachments` | Storage-quota enforcement | `user_storage_usage.used_bytes` | Automatic | Cascade-deleted | VERIFIED |
| **Add-on credits** | — | Future credit packs | `usage_credits` | Automatic (table empty in Production: 0 rows) | Cascade-deleted | VERIFIED |
| **Internal operational role** | Manually inserted by the operator | Grants `owner`/`manager` capabilities (provider-quota panel, AI-quota exemption) | `internal_user_access` — server-only, no client policy; readable by the caller only through the `get_current_user_access()` SECURITY DEFINER RPC | Not applicable to ordinary users (1 row in Production) | Cascade-deleted | VERIFIED |
| **Billing / subscription records** | Would be written by a provider webhook | Billing | `subscriptions`, `subscription_events` | **Not applicable today — no billing integration exists** (§8.3) | `ON DELETE SET NULL`: rows would survive account deletion with a null `user_id` (§12.4) | VERIFIED |

**Normalization pools, keywords, study types and exclusions** are user research configuration rather than account data, and are inventoried in §5.

### 4.1 Notes on account data

- **The email is stored twice.** Once in `auth.users` (Supabase Auth's own table) and once in `public.profiles.email`, copied by the `handle_new_user()` trigger. Both are removed by account deletion. A policy sentence should not claim email lives only in the auth system.
- **The PubMed API key is a user-supplied third-party credential held in plaintext** in an RLS-protected column. It is read server-side only, by `fetch-paper-metadata` and `search-pubmed`, and is used solely to build the NCBI URL — it is never returned to the browser and never logged ([`search-pubmed/handler.ts:241-245`](../supabase/functions/search-pubmed/handler.ts#L241-L245)). It is nevertheless a credential belonging to the user's NCBI account and should be named explicitly in the policy.
- **No profile photo, phone number, address, date of birth, employer, institution, or payment detail is collected anywhere.** Verified by reading the complete `Database` type ([`src/integrations/supabase/types.ts`](../src/integrations/supabase/types.ts)) and every migration.

---

## 5. Research-library data

All of the following are per-user and RLS-scoped. Production row counts are given where they help calibrate scale, and come from a read-only metadata query.

| Category | What is stored | Provenance | Storage | Class |
|---|---|---|---|---|
| **Papers** (`papers`, 673 rows) | `title`, `abstract`, `authors` (JSONB), `author_provenance`, `journal`, `year`, `pmid`, `doi`, `pubmed_url`, `journal_url`, `drive_url`, `keywords`, `raw_keywords`, `mesh_terms`, `substances`, `study_type`, `raw_study_type`, `raw_publication_types`, `statistical_methods`, `has_abstract`, `insert_order`, a generated `search_vector`, plus `notes` and `tldr` | **Mixed.** Bibliographic fields are third-party metadata retrieved from NCBI/PubMed and Crossref, or typed by the user for a manual entry. `notes` is user-authored. `tldr`, and often `study_type` / `statistical_methods`, are **AI-generated** by `analyze-paper` | Supabase Postgres | VERIFIED |
| **Notes** | Free text the user writes about a paper; stored in `papers.notes`, not a separate table | User-authored | Same row as the paper | VERIFIED |
| **AI outputs** | `papers.tldr` (narrative summary), and `study_type` / `statistical_methods` where the AI value won the merge ([`src/lib/studyTypeUtils.ts`](../src/lib/studyTypeUtils.ts)) | Generated by Google Gemini, then **persisted** by the client (`updatePaper`) | Same row as the paper | VERIFIED |
| **Projects** (`projects`, 57 rows) | `name`, optional `description`, `color` | User-authored | Supabase Postgres | VERIFIED |
| **Tags** (`tags`, 129 rows) | `name`, `color` | User-authored | Supabase Postgres | VERIFIED |
| **Paper↔Project / Paper↔Tag assignments** (`paper_projects` 494, `paper_tags` 586) | Composite-key junction rows | User-authored | Supabase Postgres | VERIFIED |
| **Keyword pool / keyword exclusions** (`keyword_pool` 5, `keyword_exclusion_pool` 7) | Keyword strings | User-authored normalization configuration | Supabase Postgres | VERIFIED |
| **Study-type pool / exclusions** (`study_type_pool` 6, `study_type_exclusion_pool` 0) | Study-type label, group name, hierarchy rank, specificity weight | User-authored | Supabase Postgres | VERIFIED |
| **Synonym pool** (`synonym_pool`, 7 rows) | Canonical term + synonym array | User-authored | Supabase Postgres | VERIFIED |
| **Saved filter presets** (`filter_presets`, 3 rows) | `name` + an opaque JSONB `payload` describing a saved search/filter state | User-authored | Supabase Postgres | VERIFIED |
| **Author identities** (`author_identities` 4, `author_identity_aliases` 6, `author_identity_links` 69, `author_identity_merges` 0) | A person the *user* asserts exists, their preferred name, alternate names, which author mention on which paper is that person, and merge edges. Includes `author_name_snapshot` — the author name text as it stood when the link was made | **User-authored assertions about third parties** (paper authors), over author names that came from PubMed/Crossref | Supabase Postgres | VERIFIED |
| **Attachments** | See §6 | User-uploaded | Supabase Storage + `paper_attachments` metadata | VERIFIED |
| **Import history** | **None.** There is no import-log or search-history table anywhere in the schema. Imported papers are the only record that an import happened; PubMed searches are not persisted | — | — | VERIFIED |

### 5.1 A privacy-relevant characteristic of the data

Author identities, `author_name_snapshot`, and `papers.authors` contain **personal data about third parties** — named researchers who are not PaperLume users. That data originates from public bibliographic records, but a policy should not describe the library as containing only the user's own personal data.

Additionally, a research library on medical or clinical topics can reveal a great deal about the *user's* interests. Nothing in the schema makes a health inference about the user, and no health data about the user is collected — but a policy should avoid the claim that the library contains "no sensitive information", because what a person chooses to read is itself revealing.

---

## 6. Attachments and Supabase Storage

| Property | Verified value | Evidence |
|---|---|---|
| Bucket name | `attachments` — the only bucket in the Production project | Read-only `storage.buckets` query; [`accountDeletion.ts:29`](../supabase/functions/_shared/accountDeletion.ts#L29) |
| Public? | **No.** `public = false` in Production | Read-only `storage.buckets` query; [`20260327100000_private_attachments_bucket.sql`](../supabase/migrations/20260327100000_private_attachments_bucket.sql) |
| Path structure | `{userId}/{paperId}/{uniqueName}` | [`useAttachments.ts`](../src/hooks/useAttachments.ts); the deletion module documents the same contract |
| Access model | Four owner-scoped RLS policies on `storage.objects` (`attachments_owner_read/insert/update/delete`), each requiring `auth.uid()::text = (storage.foldername(name))[1]` | Read-only `pg_policies` query; [`20260318020000`](../supabase/migrations/20260318020000_add_attachments_storage_policies.sql), [`20260327100000`](../supabase/migrations/20260327100000_private_attachments_bucket.sql) |
| Read URLs | **Signed URLs only**, 1-hour expiry (`SIGNED_URL_EXPIRY = 3600`). No public URL is ever generated | [`useAttachments.ts:53`](../src/hooks/useAttachments.ts#L53) |
| Allowed content types | `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `image/gif` — enforced at the bucket, and again client-side | Read-only `storage.buckets` query |
| Size limit | 20 MB per file (bucket `file_size_limit = 20971520`) | Read-only `storage.buckets` query |
| Quota | Per-user byte cap enforced by an atomic `BEFORE INSERT` trigger on `paper_attachments` against `user_entitlements.storage_quota_bytes` | [`20260521030000`](../supabase/migrations/20260521030000_harden_attachment_privacy_and_storage_quota.sql) |
| Metadata stored | `file_name`, `file_path`, `file_type`, `size_bytes`, `paper_id`, `user_id`, `created_at` | `paper_attachments` |

### 6.1 Do attachments contain PDFs and full text?

**Yes, by design.** `application/pdf` is an allowed MIME type and the feature exists to let a user keep the paper's PDF with the record. PaperLume never extracts, parses, indexes or reads the contents of an attachment — no code path opens the binary. The binaries are opaque to the application.

**PARTIALLY VERIFIED caveat for the policy:** a user may upload a PDF that is licensed, paywalled, or contains material beyond the paper. That is a terms-of-service concern, not a data-flow one, but it should be considered when drafting.

### 6.2 Do AI functions receive attachment contents?

**No — structurally, not merely by convention.**

- `analyze-paper` accepts exactly `{ title, abstract }` from the request body and sends only those two strings to Gemini ([`analyze-paper/index.ts:161`](../supabase/functions/analyze-paper/index.ts#L161)).
- `suggest-paper-organization` builds the provider payload by **allow-listing** fields — paper `title`, `abstract`, `keywords`, `studyType`, and Project/Tag *names* plus optional Project descriptions. There is no attachment parameter in any function in [`prompt.ts`](../supabase/functions/suggest-paper-organization/prompt.ts), and its `ProviderProject`/`ProviderTag` types have no `id` field at all.
- Neither function has a Storage client. Neither reads `paper_attachments`.

### 6.3 Deletion lifecycle for attachments

| Trigger | What happens | Class |
|---|---|---|
| User deletes one attachment | Storage object removed first, then the metadata row ([`useAttachments.ts:167-172`](../src/hooks/useAttachments.ts#L167-L172)) | VERIFIED |
| User deletes a paper | Attachment paths are read *before* the delete; the DB rows go by `ON DELETE CASCADE`; the Storage objects are then removed **best-effort** — a failure is logged and swallowed ([`usePaperMutations.ts:426-457`](../src/hooks/papers/usePaperMutations.ts#L426-L457), same pattern in `useBulkMutations.ts`) | VERIFIED |
| Upload fails partway | The client removes the orphaned Storage object it just wrote ([`useAttachments.ts:140`](../src/hooks/useAttachments.ts#L140)) | VERIFIED |
| Account deletion | Storage is enumerated **from Storage itself**, recursively and paginated, and every object under `{userId}/` is removed before the Auth user is deleted — so a best-effort orphan from the paper-delete path is still cleaned up (§12) | VERIFIED |

**Gap worth stating honestly:** between a paper deletion whose best-effort Storage cleanup failed and the user's eventual account deletion, an orphaned binary can persist in the bucket with no metadata row pointing at it. It remains inaccessible to anyone but the owner (the RLS path prefix still matches only them), and account deletion sweeps it. A policy should not claim attachment binaries are deleted *immediately and unconditionally* when a paper is deleted.

---

## 7. Authentication, cookies and browser storage

### 7.1 Authentication

| Property | Verified value |
|---|---|
| Provider | Supabase Auth (GoTrue) |
| Methods implemented | **Email + password only.** Sign-up with email confirmation, sign-in, password reset. No OAuth/social provider, no magic link, and no MFA appears anywhere in source |
| Signup redirect | `${window.location.origin}/` |
| Password reset redirect | `${window.location.origin}/reset-password` |
| Client key | The Supabase **publishable/anon** key, build-inlined by Vite. No service-role key exists anywhere in `src/` (verified: `grep -rn SERVICE_ROLE src/` matches only two test files' assertion strings) |
| Session handling | `persistSession: true`, `autoRefreshToken: true`, `storage: localStorage` ([`src/integrations/supabase/client.ts`](../src/integrations/supabase/client.ts)) |
| Edge Function auth | All six functions set `verify_jwt = false` at the gateway and validate the bearer token **in-body** with an authoritative `auth.getUser()` network call. No function accepts a user id from a request body | [`supabase/config.toml`](../supabase/config.toml) |

### 7.2 Browser storage inventory

Complete. Every match in non-test application source is listed.

| Mechanism | Key / name | Purpose | Lifetime | Class |
|---|---|---|---|---|
| `localStorage` | Supabase Auth session keys (named by `@supabase/supabase-js`, conventionally `sb-<project-ref>-auth-token`) | Holds the access token, refresh token and user object so a session survives a reload | Until sign-out, token expiry without refresh, or the user clears site data | VERIFIED (key naming is the library's, not this repo's) |
| `localStorage` | Column-width preferences ([`useColumnWidths.ts`](../src/hooks/useColumnWidths.ts)) | Remembers table column widths | Until cleared by the user | VERIFIED |
| `localStorage` | Column-visibility preferences ([`useColumnVisibility.ts`](../src/hooks/useColumnVisibility.ts)) | Remembers which table columns are shown | Until cleared by the user | VERIFIED |
| Cookie | `sidebar:state` ([`src/components/ui/sidebar.tsx:68`](../src/components/ui/sidebar.tsx#L68)) | Remembers whether the sidebar is expanded. First-party, non-tracking, no identifier | `max-age` set in the component (7 days) | VERIFIED |
| `sessionStorage` | **None.** No application code uses it | — | — | VERIFIED |
| `IndexedDB` | **None.** No application code uses it | — | — | VERIFIED |

**No tokens or credential values are reproduced in this document, and none should appear in the policy.**

**Cookie-banner relevance:** the only cookie is a first-party UI preference, and the only other browser storage is the auth session plus two display preferences. None is used for tracking, advertising, measurement or profiling. Whether a cookie/consent notice is nonetheless required is a legal determination — **OWNER INPUT REQUIRED**.

---

## 8. AI / Gemini data flow

Two AI features exist. Both call Google's Generative Language API at `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, server-side from a Supabase Edge Function, authenticated with a single `GEMINI_API_KEY` Edge secret. **The browser never contacts Google.**

Model: resolved from the optional `GEMINI_MODEL` secret through [`_shared/geminiModel.ts`](../supabase/functions/_shared/geminiModel.ts), with the fallback `gemini-flash-latest`. Both functions resolve it through the same module so they cannot disagree. Generation config for both: `responseMimeType: "application/json"`, `temperature: 0.1`.

### 8.1 `analyze-paper`

| Question | Answer | Class |
|---|---|---|
| Trigger | The user explicitly presses an analyse action on a paper (single or batch) — [`usePaperAnalysisActions.ts`](../src/hooks/usePaperAnalysisActions.ts), [`EditPaperDialog.tsx:338`](../src/components/papers/EditPaperDialog.tsx#L338). Never automatic, never on import | VERIFIED |
| Data sent to Google | Exactly two values, in one text part: `Title: {title}` and `Abstract: {abstract}`, plus a fixed system instruction | VERIFIED |
| Data **not** sent | User id, email, paper id, PMID, DOI, journal, authors, notes, Projects, Tags, keywords, attachments, any other paper, any token | VERIFIED |
| Response | `{ tldr, studyType, statisticalMethods }` | VERIFIED |
| Response stored? | **Yes.** The client merges and persists it into `papers.tldr`, and into `study_type` / `statistical_methods` per the merge rule | VERIFIED |
| Quota | One unit consumed via `consume_ai_quota` *before* the provider call; best-effort `refund_ai_quota` on any provider or parse failure | VERIFIED |
| Logging | Step markers, HTTP status codes, a provider-error class, and bounded error messages. **The raw Google response body is never logged**, and no title, abstract or user id is logged | VERIFIED |

### 8.2 `suggest-paper-organization`

| Question | Answer | Class |
|---|---|---|
| Trigger | The user presses the suggestion control for one paper ([`PaperOrganizationSuggestions.tsx`](../src/components/papers/PaperOrganizationSuggestions.tsx)) | VERIFIED |
| Data sent to Google | A JSON document built by **allow-list**: the paper's `title`, and `abstract`, `keywords`, `studyType` where present; **every** Project of that user as `{ref, name, description?, alreadySelected}` and **every** Tag as `{ref, name, alreadySelected}` | VERIFIED |
| Data **not** sent | Database ids (Projects/Tags are given ephemeral request-local refs `P1…Pn` / `T1…Tn` and the type has no `id` field), user id, email, plan/quota state, internal role, authors, affiliations, ORCID, notes, PMID, DOI, any URL, attachments, other papers, tokens | VERIFIED |
| Response | Suggested existing Projects/Tags by ref plus proposed new names, each with a short rationale | VERIFIED |
| Response stored? | **No.** The endpoint mutates nothing — its injected DB interface exposes only `select` and `rpc`, with no `insert`/`update`/`upsert`/`delete` to call. Suggestions are returned to the client and only applied if the user accepts them through the ordinary mutation paths | VERIFIED |
| Quota | One unit via `consume_ai_quota` after all validation; refunded best-effort on provider failure or unusable output | VERIFIED |
| Logging | Structured counts only — outcome, number of Projects/Tags in, number of suggestions out. **No name, title, abstract, ref or user id is logged** | VERIFIED |

**Privacy-material fact for the policy:** `suggest-paper-organization` sends the user's **entire Project and Tag taxonomy** — every name, and every Project description — to Google on each invocation. Those are user-authored labels that can be descriptive ("Ph.D. chapter 3 — paediatric sepsis"). This is the single widest AI disclosure in the product and must be stated plainly.

### 8.3 `get-gemini-provider-quota`

Owner/manager only, gated by `get_current_user_access()`. It queries **Google Cloud Monitoring** (`monitoring.googleapis.com`, minted via `oauth2.googleapis.com` with a service-account JWT and the `monitoring.read` scope) for aggregate Gemini usage metrics of the shared Google Cloud project. **No user data of any kind is sent, and no per-user metric is requested.** The `deployment.md` record states no frontend surface calls this function today; the audit confirms no caller exists in `src/` — the only matches are an unrelated capability flag on the access hook. Credentials are never returned or logged.

### 8.4 Provider policy questions — do not answer from code

The following **cannot** be established from this repository and must be verified first-party against Google's current published terms for the specific API and account tier in use before any statement is made in a policy:

- whether Gemini API inputs/outputs are retained by Google, and for how long;
- whether they may be used to train or improve models;
- whether human review may occur;
- which Google entity is the processor, and in which regions processing occurs;
- whether a data processing addendum applies and has been accepted.

**Class: EXTERNAL POLICY VERIFICATION REQUIRED.** The same applies to NCBI, Crossref, Supabase, Vercel and Resend.

---

## 9. External services and third parties

### 9.1 Services that currently receive or return data

| Service | Purpose | Data sent | Data received | Client or server | Evidence |
|---|---|---|---|---|---|
| **Supabase** (Postgres, Auth, Storage, Edge Functions) | The entire backend | Everything in §4–§6; auth credentials | Everything the app displays | Both — browser talks to Supabase directly with the anon key under RLS; Edge Functions run in Supabase's runtime | [`src/integrations/supabase/client.ts`](../src/integrations/supabase/client.ts), all migrations |
| **Google Gemini** (`generativelanguage.googleapis.com`) | AI analysis and organisation suggestions | §8.1 / §8.2 | Generated text | **Server (Edge Function) only** | [`analyze-paper/index.ts`](../supabase/functions/analyze-paper/index.ts), [`suggest-paper-organization/handler.ts`](../supabase/functions/suggest-paper-organization/handler.ts) |
| **NCBI E-utilities / PubMed** (`eutils.ncbi.nlm.nih.gov`) | Metadata lookup and PubMed search | A PMID, a DOI, a title string, or the user's **raw search query**; plus the user's NCBI API key when they have supplied one | Bibliographic records (ESearch/ESummary/EFetch XML/JSON) | **Server only** | [`_shared/pubmedSearch.ts`](../supabase/functions/_shared/pubmedSearch.ts), [`fetch-paper-metadata/index.ts`](../supabase/functions/fetch-paper-metadata/index.ts) |
| **Crossref** (`api.crossref.org`) | DOI and title metadata fallback | A DOI or a title string, plus a `User-Agent` header | Bibliographic records | **Server only** | [`fetch-paper-metadata/index.ts:412-434`](../supabase/functions/fetch-paper-metadata/index.ts#L412-L434) |
| **Google Cloud Monitoring** (`monitoring.googleapis.com`, `oauth2.googleapis.com`) | Owner/manager provider-quota panel | **No user data** — a service-account JWT and a metrics query for the shared project | Aggregate metric time series | **Server only**, owner/manager gated, currently unreferenced by any UI | [`get-gemini-provider-quota/index.ts`](../supabase/functions/get-gemini-provider-quota/index.ts) |
| **Vercel** | Static hosting of the SPA at `app.paperlume.app` | HTTP request metadata inherent to serving a page (IP address, user agent, requested path) — the standard consequence of hosting, not application code | The application bundle | Client ↔ hosting edge | [`vercel.json`](../vercel.json), `docs/deployment.md` §3.1 |
| **Resend** | Transactional Supabase Auth email via custom SMTP on `auth.paperlume.app` | The user's email address and the auth email content (confirmation, reset) | — | Server-side, **configured in the Supabase dashboard, not in this repository** | `docs/commercial-architecture.md` §6 item 11; `docs/deployment.md` §8a. **Class: PARTIALLY VERIFIED** — the repository records the configuration, it is not code-inspectable here |
| **Cloudflare** | Registrar and DNS for `paperlume.app` | DNS resolution only | — | Infrastructure | `docs/owner-decisions.md` C19. Class: PARTIALLY VERIFIED |

### 9.2 Services that are planned but **not** implemented

None of these processes any data today and **none may be listed as a current processor**:

| Service | Status |
|---|---|
| **Paddle** (Merchant of Record) | Selected as the future provider (decision C18) and **paused** (C27). Zero code: `grep -rniE "stripe\|paddle\|lemonsqueezy\|revenuecat"` over `src/` and `supabase/functions/` returns **no matches**. `subscriptions` and `subscription_events` hold 0 rows in Production |
| Stripe, Lemon Squeezy, Apple IAP, Google Play Billing, RevenueCat | Provider-neutral schema shapes exist; no integration |
| **Sentry** or any error-tracking service | Named as an unmet launch blocker in `commercial-architecture.md` §6 item 8. Not installed, not configured, not called |
| Google Workspace business email | Pending owner setup |
| Marketing site | Not chosen, not built |

### 9.3 A finding to raise with the owner

`fetch-paper-metadata` sends a **stale contact address** to Crossref on every request:

```
User-Agent: PaperIndex/1.0 (mailto:support@paperindex.app)
```

— [`fetch-paper-metadata/index.ts:415`](../supabase/functions/fetch-paper-metadata/index.ts#L415) and [`:434`](../supabase/functions/fetch-paper-metadata/index.ts#L434).

This is the Crossref "polite pool" convention: the address is the contact Crossref may use to reach the operator about API behaviour. It names the **former** brand (`paperindex.app`), not `paperlume.app`, and points at an address the repository gives no evidence resolves. It transmits no user data — but a privacy policy that lists Crossref as a processor should be accurate about what is sent, and the owner may want this corrected. **Correcting it is a source change and therefore out of scope for this audit** (see §16); it is recorded here as a finding only.

---

## 10. Analytics, telemetry and logs

### `NO APPLICATION ANALYTICS/TRACKING FOUND IN SOURCE`

**Search basis.** Every tracked file (excluding `package-lock.json` and `bun.lockb`) was searched, case-insensitively and with word boundaries, for: `gtag`, `googletagmanager`, `google-analytics`, `posthog`, `@sentry`, `mixpanel`, `amplitude`, `segment.com`, `logrocket`, `fullstory`, `hotjar`, `datadog`, `bugsnag`, `rollbar`, `plausible`, `fathom`, `matomo`, `clarity.ms`, `@vercel/analytics`, `@vercel/speed-insights`, `window.dataLayer`, `navigator.sendBeacon`, and fingerprinting terms.

**Result: zero genuine matches.** The only hit was the word "amplitude" inside the `analyze-paper` prompt text (a physiological term in the summarisation instruction). Earlier substring passes produced false positives only — `getTag`, `scrollBar`, `isEntry`, the English word "plausible", and an internal `organizationDraftFingerprint` which is a content hash of a draft, not a browser fingerprint.

Corroborating evidence:

- [`package.json`](../package.json) contains **no** analytics, telemetry, monitoring or error-reporting dependency.
- [`index.html`](../index.html) loads **no** third-party script, pixel, tag manager or font CDN. Its only `<script>` is the application bundle.
- There is no custom event-tracking module, no `track()` helper, no beacon, and no advertising or marketing integration.
- Supabase Realtime is not used.

### 10.1 Infrastructure logs are a separate category and do exist

These are ordinary server-side operational logs, not application analytics. A policy should describe them honestly rather than claiming "we log nothing".

| Log | What it contains | Class |
|---|---|---|
| **Supabase Edge Function logs** | Structured operational lines written by the functions. Audited line by line: `search-pubmed` logs `q_len=<length>` and **never the query text** ([`handler.ts:317-336`](../supabase/functions/search-pubmed/handler.ts#L317-L336)); `suggest-paper-organization` logs outcomes and counts only; `analyze-paper` logs step markers, HTTP statuses and a provider-error class; `delete-account` logs a removed-object **count** and a failure code. **`fetch-paper-metadata` logs the PMID being parsed** (`pubmed-parse pmid=… bytes=… fetch_ms=…`) — a public catalogue number, but one that reveals which paper a request concerned | VERIFIED |
| **Supabase platform logs** | Postgres, Auth, Storage and API-gateway logs kept by Supabase. Retention and content are Supabase's, not this repository's | EXTERNAL POLICY VERIFICATION REQUIRED |
| **Vercel access logs** | Standard hosting request logs (IP, user agent, path, timing) | EXTERNAL POLICY VERIFICATION REQUIRED |

**No user id, email, token, key, title, abstract, note, Project name or Tag name is written to any application log.** That was checked against all 50 `console.*` call sites across `supabase/functions/**` (excluding tests).

---

## 11. Chrome extension privacy flow

> **HISTORICAL SNAPSHOT — superseded in part. See [§24](#24-addendum--2026-08-29--chrome-extension-import-001e2-correction-01).**
>
> Everything in this section was true of the extension at the commit named in §1
> and is left exactly as it was audited. It is **no longer a description of
> current behaviour**: on 2026-08-29 the extension gained a narrow DOI metadata
> read and the `scripting` permission. §24 is the dated delta. Nothing here has
> been rewritten to make the old statements read as though they were never true —
> they were true, and the date they stopped being true is recorded.

Re-verified against the merged source at the audited commit, not copied from `docs/chrome-web-store-readiness.md`. The complete extension is five source files plus a manifest and a popup document.

### 11.1 Manifest

```json
{ "manifest_version": 3, "name": "PaperLume", "version": "0.1.0",
  "permissions": ["activeTab"],
  "action": { "default_title": "PaperLume", "default_popup": "popup.html" },
  "content_security_policy": { "extension_pages": "script-src 'self'; object-src 'self';" } }
```

— [`extension/manifest.json`](../extension/manifest.json). **One permission. No `host_permissions`. No `content_scripts`. No `background`/service worker. No `web_accessible_resources`.**

### 11.2 What is accessed

**The active tab's URL, and only after the user clicks the toolbar action** — the click is what grants `activeTab`. Read once, in `readActiveTabUrl()` via `chrome.tabs.query({active: true, currentWindow: true})` ([`popup.ts:36`](../extension/src/popup.ts#L36)). Nothing else: no DOM, no `<meta>`, no document title, no page text, no cookies, no history, no other tab.

The extension's **entire** Chrome API surface is two members, hand-declared in [`chrome.d.ts`](../extension/src/chrome.d.ts) and asserted as an exact set (not a deny-list) by [`sourceBoundary.test.ts`](../extension/src/__tests__/sourceBoundary.test.ts): `chrome.tabs.query` and `chrome.tabs.create`.

### 11.3 Local processing

`detectPaperFromUrl()` ([`detectPaperFromUrl.ts`](../extension/src/detectPaperFromUrl.ts)) is a pure string function. It rejects any scheme outside `http:`/`https:` as `restricted`, then tries the PubMed URL grammar and the doi.org URL grammar (both reused from the application's own `@/lib/pubmedIdentifiers` and `@/lib/doiIdentifiers`). Anything else is `unsupported`. **There is deliberately no title fallback** — the `PaperDetection` type has no title variant, so an unidentifiable URL cannot become a search term.

### 11.4 Automatic transmission

**None. The extension has no network capability at all.** [`sourceBoundary.test.ts`](../extension/src/__tests__/sourceBoundary.test.ts) asserts the absence of `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `importScripts`, `navigator.serviceWorker` and `RTCPeerConnection` from every extension source file. An independent grep across `extension/` at this commit confirms: the only occurrences of those terms are inside the test that forbids them.

### 11.5 User-confirmed navigation

Only after a second, explicit press of **Continue in PaperLume** does anything leave the extension, and it leaves as a browser navigation — `chrome.tabs.create({ url })` — not a request. The URL is built by [`paperLumeHandoff.ts`](../extension/src/paperLumeHandoff.ts):

```
https://app.paperlume.app/extension-import?kind=pmid&value=<PMID>
https://app.paperlume.app/extension-import?kind=doi&value=<URL-encoded DOI>
```

`PAPERLUME_WEB_ORIGIN` is a hard-coded constant, never derived from the tab, storage, config or a redirect. The URL is assembled by assigning `pathname` and `search` onto a `URL` built from that constant, because neither setter can change the host — `new URL(path, origin)` is deliberately *not* used, since it could. The query grammar comes from the shared [`extensionImportHandoff.ts`](../src/lib/extensionImportHandoff.ts), so the sender cannot drift from what the receiving route parses.

### 11.6 Is the full source URL ever sent?

**No.** `toIntent()` maps only the two authenticated detection states to an intent carrying `kind` and the extracted identifier. `unsupported` and `restricted` map to `null`, and a `null` handoff URL keeps the Continue control hidden entirely. The source URL, page title, referrer, extension id, user id, Project/Tag id, timestamp and any analytics parameter are **absent from the code**, not merely absent from the output.

### 11.7 Extension storage

**None.** No `storage` permission is declared, and no `chrome.storage`, `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` or Cache API reference exists in extension source. There is no background context, so nothing survives the popup closing.

### 11.8 Absence checklist

| Concern | Present? | Basis |
|---|---|---|
| Content scripts | **No** | No `content_scripts` key; asserted by [`manifest.test.ts:113`](../extension/src/__tests__/manifest.test.ts#L113) |
| DOM scraping | **No** | No scripting permission, no injection API, no DOM access to any page |
| Cookie access | **No** | No `cookies` permission; no `document.cookie` |
| Auth-token access | **No** | The extension holds no session and calls no Supabase API. PaperLume authenticates in its own tab |
| History collection | **No** | No `history` permission; nothing persists |
| Analytics | **No** | No network primitive exists to send any |
| Extension-owned API calls | **No** | See §11.4 |
| Remote code | **No** | CSP is `script-src 'self'`; the packaging script re-reads the built ZIP and fails on any remote reference |

### 11.9 Distribution status

The extension is **not published** to the Chrome Web Store and no listing exists (`docs/deployment.md`, `README.md` §167). `npm run package:extension` produces a local, gitignored release candidate ZIP and explicitly uploads, publishes and tags nothing.

---

## 12. Account deletion

### 12.1 Trigger

Settings → **Danger zone** → Delete account. A destructive dialog requires the user to type the exact phrase `DELETE MY ACCOUNT`; the final button stays disabled until it matches ([`DeleteAccountDialog.tsx`](../src/components/settings/DeleteAccountDialog.tsx)). The client then invokes the `delete-account` Edge Function ([`useAccountDeletion.ts:60`](../src/hooks/useAccountDeletion.ts#L60)) and signs out locally.

### 12.2 Server path

[`delete-account/handler.ts`](../supabase/functions/delete-account/handler.ts), in order:

1. CORS preflight answered before anything else; **POST only** — every other method is refused before the token is read.
2. Bearer token required and validated by an authoritative `getUser(token)` network call.
3. **The deletion target is the authenticated user and nothing else.** A `user_id` in the request body is structurally incapable of redirecting the deletion — the body is only ever checked for the confirmation phrase.
4. The confirmation phrase is **re-validated server-side**, byte-exact: no trimming, no case folding, no boolean flag accepted as proof ([`accountDeletion.ts:checkDeletionConfirmation`](../supabase/functions/_shared/accountDeletion.ts)).
5. The elevated server-only key is selected (`SUPABASE_SECRET_KEYS`, falling back to `SUPABASE_SERVICE_ROLE_KEY`); if neither is usable the request fails safe rather than proceeding unprivileged.
6. **Storage first.** Every object under `{userId}/` is enumerated recursively and paginated **from Storage itself** (not from `paper_attachments`, so orphans are caught), validated against the user's prefix twice — once on discovery and once immediately before `remove()` — and deleted in batches. Any failure aborts and **leaves the Auth user intact**, so the operation stays safely retryable and never reports a success it did not achieve.
7. **Then the Auth user**, hard-deleted: `auth.admin.deleteUser(userId, false)` — the explicit non-soft-delete argument.

### 12.3 What the cascade removes

Deleting the `auth.users` row removes, via `ON DELETE CASCADE` foreign keys, every row in: `profiles`, `papers` (and therefore `paper_projects`, `paper_tags`, `paper_attachments`, `author_identity_links` by their own cascades), `projects`, `tags`, `keyword_pool`, `keyword_exclusion_pool`, `study_type_pool`, `study_type_exclusion_pool`, `synonym_pool`, `filter_presets`, `author_identities`, `author_identity_aliases`, `author_identity_merges`, `user_entitlements`, `usage_counters`, `usage_credits`, `user_storage_usage`, and `internal_user_access`. The cascade is pinned by a database test, `supabase/tests/database/008_account_deletion_cascade.test.sql` (referenced by `commercial-architecture.md` §6 item 7).

### 12.4 What is intentionally retained — the two evidenced exceptions

| Table | Column | Behaviour | Consequence |
|---|---|---|---|
| `subscriptions` | `user_id` | `ON DELETE SET NULL` | The row survives with a null `user_id` |
| `subscription_events` | `user_id` | `ON DELETE SET NULL` | The row survives with a null `user_id`. It also carries a `payload JSONB NOT NULL` holding the **verified raw provider webhook body**, which for a real billing provider would typically contain the customer's email and billing details — and that payload is *not* nulled |

— [`20260521010000_add_entitlement_usage_schema.sql:149`](../supabase/migrations/20260521010000_add_entitlement_usage_schema.sql#L149) and [`:290`](../supabase/migrations/20260521010000_add_entitlement_usage_schema.sql#L290).

**Both tables hold 0 rows in Production** (verified by read-only query) because no billing integration exists. So today the exception is theoretical. It stops being theoretical the moment billing is implemented, and it is already tracked as an open item in `store-launch-checklist.md` §3 and `commercial-architecture.md` §6 item 7. **Class: VERIFIED (mechanism) / OWNER INPUT REQUIRED (whether to keep it, and what retention to state).**

### 12.5 What deletion provably cannot reach

State this in the policy; do not claim total erasure.

| Data | Why deletion cannot remove it | Class |
|---|---|---|
| Content already sent to **Google Gemini** | Once transmitted, its lifecycle is governed by Google's terms | EXTERNAL POLICY VERIFICATION REQUIRED |
| Queries and identifiers already sent to **NCBI** and **Crossref** | Same | EXTERNAL POLICY VERIFICATION REQUIRED |
| Emails already delivered via **Resend** | Same | EXTERNAL POLICY VERIFICATION REQUIRED |
| **Supabase / Vercel infrastructure logs and backups** | Retained on the providers' own schedules, outside application control | EXTERNAL POLICY VERIFICATION REQUIRED |
| Data the user **exported** before deleting | It is on the user's own device | VERIFIED |

### 12.6 Failure behaviour

Every internal failure returns the **same** generic message (`GENERIC_FAILURE`), so the response never discloses which stage failed. Storage failure aborts before the Auth user is touched; a retry re-runs an empty cleanup and proceeds. No cooldown or grace period exists — deletion is immediate and permanent by design.

### 12.7 Data export (relevant to portability rights)

Settings → Account data produces one versioned ZIP containing the whole account: `manifest.json` plus JSON for papers (notes and author provenance included), projects, tags, both junction tables, filter presets, all four pools, attachment metadata, the four author-identity datasets, a non-secret profile projection, **and the attachment binaries**. The manifest carries no credential and no email; `pubmed_api_key` is excluded by explicit column projection. — [`src/lib/accountExport/`](../src/lib/accountExport/). **Class: VERIFIED.**

---

## 13. Retention

`NO EXPLICIT RETENTION PERIOD ESTABLISHED IN SOURCE`

There is no scheduled job, no TTL, no expiry column with a purge, no cron, no archival policy and no retention constant anywhere in the repository. `usage_credits.expires_at` exists but is unused (0 rows, no consumer). What the source *does* establish:

| Category | Retention as evidenced |
|---|---|
| Papers, notes, AI outputs, Projects, Tags, assignments, pools, presets, author identities | **Retained until the user deletes the item, or deletes their account.** No automatic expiry |
| Attachment binaries | Retained until the attachment or its paper is deleted (best-effort, §6.3), or until account deletion sweeps the namespace |
| Profile, entitlements, usage counters, storage usage | Retained for the life of the account; deleted with it |
| `subscriptions` / `subscription_events` | **Would survive account deletion indefinitely, unlinked.** No period defined (§12.4) |
| Supabase Auth session in `localStorage` | Until sign-out, refresh failure, or the user clears site data |
| Column width / visibility preferences, sidebar cookie | Until the user clears them; the cookie has a 7-day `max-age` |
| AI prompt content at Google, queries at NCBI/Crossref, email at Resend | **Not determinable from this repository** — EXTERNAL POLICY VERIFICATION REQUIRED |
| Supabase and Vercel platform logs and backups | **Not determinable from this repository** — EXTERNAL POLICY VERIFICATION REQUIRED |

**Do not state a number of days for anything.** If the policy needs a defined retention period, that is a product decision plus an implementation, not a documentation exercise.

---

## 14. Security measures actually evidenced

Only claims supportable by implementation. Each is safe to state; nothing below is an absolute.

| Measure | Evidence | Class |
|---|---|---|
| Transport encryption | All endpoints are HTTPS: Supabase, Vercel (`app.paperlume.app`), Gemini, NCBI, Crossref. No `http://` endpoint is contacted in application code | VERIFIED |
| Row Level Security | **Enabled on every public application table present at audit time: 24/24 regular tables** in schema `public` (read-only `pg_class` verification; 0 with RLS disabled, 22 of the 24 additionally `FORCE`). That is the same 24-table set this audit inventories in §4 and §5. Owner-scoped policies key on `auth.uid()` | VERIFIED |
| Server-only tables | `subscriptions`, `subscription_events`, `usage_counters`, `internal_user_access` have **no client policy at all**; `internal_user_access` additionally has direct privileges revoked from `PUBLIC`, `anon` and `authenticated` | VERIFIED |
| Private Storage with owner-scoped authorization | Bucket `public = false`; four path-prefix RLS policies; reads only via 1-hour signed URLs | VERIFIED |
| Authenticated Edge Functions | All six require an `Authorization` header and validate it with an authoritative `auth.getUser()` **network** call. None accepts a user id from a request body | VERIFIED |
| Ownership re-checks in RPCs | `20260518010000_rpc_auth_uid_ownership_check.sql` and `20260802025704_harden_rpc_and_relational_ownership.sql` add `auth.uid()` ownership guards; `20260810152125` hardens function `search_path` | VERIFIED |
| No elevated key in the browser | Verified: `grep -rn SERVICE_ROLE src/` matches only test assertion strings. The only elevated key use is inside `delete-account`, from the runtime-injected secret, never returned or logged | VERIFIED |
| Non-disclosing errors | Foreign and missing papers return an identical 404; account-deletion failures return one generic message regardless of cause; provider errors are neutralised before reaching the user | VERIFIED |
| Prompt-injection containment | The Gemini payload is JSON-encoded (so user text cannot terminate its container), the system instruction states the data/instruction boundary, and the **output contract is strictly parsed** — a model-invented ref resolves to nothing, making a fabricated existing-entity suggestion unrepresentable | VERIFIED |
| Destructive-action confirmation | Exact phrase, re-validated server-side | VERIFIED |
| Minimal extension permissions | One permission (`activeTab`); the API surface is an exact allow-list asserted by test | VERIFIED |
| CI gates | Required `validate` and `db-tests` checks; workflows use a read-only token and never contact Production | VERIFIED |

### 14.1 Claims that must NOT be made

- ❌ "Completely secure", "fully secure", "unhackable", "industry-leading security", "bank-grade encryption".
- ❌ **"We cannot access your data."** This is not supportable. The operator holds Supabase project access and the service-role key, which bypasses RLS. RLS protects users *from each other*, not from the operator.
- ❌ "Your data is encrypted end-to-end." There is no client-side encryption. Encryption at rest is Supabase's platform behaviour and would need first-party verification before being described.
- ❌ "We never share your data with third parties." Four services receive data (§9.1). The accurate framing is *processors acting on the user's instruction for a stated purpose*, and even that depends on the provider-terms and DPA questions in §22.3 being answered first.
- ❌ Any claim of a certification (SOC 2, ISO 27001, HIPAA) — none is evidenced, and PaperLume's own compliance is not inherited from a vendor's.

---

## 15. Children and age

| Question | Finding |
|---|---|
| Age gate at signup? | **None.** `src/pages/Auth.tsx` collects email and password only |
| Minimum-age term anywhere? | **None.** A repository-wide search for `age gate`, `minimum age`, `13 years`, `16 years`, `18 years`, `COPPA`, `birth date`, `date of birth` returns **zero matches** |
| Child-directed features? | **None.** The product is a scientific-literature manager. No feature targets or appeals to children |
| Any date-of-birth or age field in schema? | **None** |

`OWNER/LEGAL DECISION REQUIRED` — whether to set a minimum age, what it should be, whether to add a gate, and how to handle discovery of an under-age account. **Do not invent a minimum age.** Note that Chrome Web Store, and any future app store, will each ask their own age/audience question.

---

## 16. International processing and geography

| Element | What the repository/config establishes | Class |
|---|---|---|
| **Supabase region** | **`ap-south-1`** — AWS Asia Pacific (Mumbai), India. Project `lioxtgiputfniqbktcsz` ("academic-papers-index"), created 2026-03-01, Postgres 17.6. Verified two ways: the local CLI pooler URL (`aws-1-ap-south-1.pooler.supabase.com`) and a read-only Supabase Management API project lookup | VERIFIED |
| **Where the database, Storage and Edge Functions run** | The same Supabase project — so **user research data, attachments and auth records are stored in India** | VERIFIED |
| **Vercel hosting** | `app.paperlume.app` on Vercel; the app is a static SPA served from Vercel's global edge network. No region is pinned in [`vercel.json`](../vercel.json), which contains only an SPA rewrite | PARTIALLY VERIFIED — the specific edge regions are Vercel's |
| **Google Gemini** | `generativelanguage.googleapis.com` — a global endpoint. **No region is specified in the request**, so the processing location is Google's to determine | PARTIALLY VERIFIED |
| **NCBI / PubMed** | US government service (NLM/NIH), United States | VERIFIED (from the endpoint) |
| **Crossref** | Not-for-profit; global infrastructure | PARTIALLY VERIFIED |
| **Resend** | Transactional email; region not established here | EXTERNAL POLICY VERIFICATION REQUIRED |
| **Cloudflare** | Registrar/DNS for `paperlume.app` | PARTIALLY VERIFIED |
| **Operator location** | `docs/owner-decisions.md` C17/C19 reference "Israel-side direct-registration constraints" and an Israeli trademark filing cost. **These are planning notes, not an establishment of legal identity or place of establishment** | See §17 — OWNER INPUT REQUIRED |

**Legal conclusions are explicitly out of scope.** Which regimes apply (GDPR, UK GDPR, CCPA/CPRA, Israeli Privacy Protection Law, India's DPDP Act — the last being directly relevant given the storage region), whether a transfer mechanism is required and which one, whether a representative or DPO is needed, and whether a Record of Processing Activities is required, are all **OWNER/LEGAL INPUT REQUIRED**. This audit establishes only *where the bytes are*.

---

## 17. Contact and legal entity

Nothing in the repository or the running application establishes any of these.

| Item | Status |
|---|---|
| Legal operator name | `OWNER INPUT REQUIRED` |
| Company / registered entity | `OWNER INPUT REQUIRED`. `docs/owner-decisions.md` C17 records that a US LLC was explicitly **rejected** for MVP; no entity is asserted to exist |
| Trading name | "PaperLume" / "Paperlume" is a **working commercial brand, explicitly not a registered trademark** (C19) |
| Privacy contact email | `OWNER INPUT REQUIRED`. No privacy address exists anywhere |
| Support email | `support@paperlume.app` is referenced in the Supabase Auth email templates and in three docs, but `docs/deployment.md` and `docs/owner-decisions.md` both record that it is **pending owner setup** and may not resolve to a real inbox. **Class: PARTIALLY VERIFIED — referenced, not confirmed reachable** |
| Stale operational contact | `support@paperindex.app` is still sent to Crossref (§9.3) |
| Postal address | `OWNER INPUT REQUIRED` |
| Governing law / jurisdiction | `OWNER INPUT REQUIRED` |
| Data-subject-request route | `OWNER INPUT REQUIRED` |
| DPO / EU or UK representative | `OWNER INPUT REQUIRED` |
| Software licence | No `LICENSE` file exists in the repository |

**Legal identity must not be derived from a GitHub username, a git author email, account metadata, or the country hints in the decision ledger.** Those are development artefacts.

---

## 18. Existing legal documents

Exhaustive search of the repository and the application's routes.

| Document | Exists? | Detail |
|---|---|---|
| Privacy Policy | **Absent** | No file, no route, no draft. Named as an unmet launch blocker in `commercial-architecture.md` §6 item 6, `store-launch-checklist.md` §2, and `chrome-web-store-readiness.md` §6 ("Status: OWNER INPUT REQUIRED — the URL does not exist yet") |
| Terms of Service | **Absent** | Same blockers |
| Cookie policy | **Absent** | Listed as conditional on a future marketing site |
| AI disclosure page | **Absent** | Required by C16; the only in-app AI wording is the placeholder text `"AI-generated summary..."` in [`EditPaperDialog.tsx:605`](../src/components/papers/EditPaperDialog.tsx#L605). **No AI disclaimer is surfaced where AI output is shown** |
| Data-processing disclosures | **Absent as a legal document.** The engineering facts exist in `docs/chrome-web-store-readiness.md` §6 and now in this file | |
| Deletion documentation | **Present, engineering-facing only** — `store-launch-checklist.md` §3, `commercial-architecture.md` §6 item 7. No user-facing page | |
| Support / legal page | **Absent** | Blocked on the unchosen marketing site |
| App routes | `/`, `/auth`, `/dashboard`, `/extension-import`, `/reset-password`, `*` — **no `/privacy`, `/terms`, `/support` or `/ai-disclosure`** ([`src/App.tsx:33-41`](../src/App.tsx#L33-L41)) | |

**Decision C16 (2026-05-21)** puts legal pages on an external marketing site at `paperlume.app/privacy`, `/terms`, etc., with the repository linking to HTTPS URLs. The marketing-site provider is still an unmade owner decision, so **no publication target currently exists**.

> ### Post-audit implementation note — PAPERLUME-PRIVACY-001B
>
> **This note is outside the audited snapshot above.** The table and the C16
> paragraph in this section describe the repository at the audited commit named
> in §1 (`eaa4b9bfd475caafc032625f47b0c4e6b2b6c9fd`) and are left exactly as the
> audit found them. Nothing in this note was re-audited: **no re-inspection of
> source, schema, configuration or Production was performed for it**, and no
> other statement, matrix, provider disclosure or finding in this document has
> been revisited.
>
> What changed *after* that commit: PAPERLUME-PRIVACY-001B added an
> owner-approved Privacy Policy to the application as a public, unauthenticated
> route, `/privacy` ([`src/pages/Privacy.tsx`](../src/pages/Privacy.tsx)),
> canonical `https://app.paperlume.app/privacy`. It is served by the application
> rather than by the still-unchosen marketing site, which supersedes C16 **for
> the Privacy Policy only** — Terms of Service, Support and the AI-disclosure
> page are unchanged by it and still have no publication target.
>
> **Authority boundary.** That page is the authority for the *published policy
> wording*; this document remains the authority for the *data-flow facts* behind
> it. If the two ever disagree, raise the discrepancy — do not reword the policy
> page to match an implementation, and do not edit this audit to match the
> policy.
>
> **Navigation changed again (PAPERLUME-PRIVACY-001C).** Also outside the audited
> snapshot, and likewise not re-audited. Two UI paths this document names are no
> longer where it says: **Settings → Danger zone** (§12.1) and **Settings →
> Account data** (§12.7) both moved into a dedicated **Account** dialog, opened
> from the Account menu — the authenticated email dropdown — which now also
> carries a **Privacy Policy** item pointing at `/privacy`. Settings keeps the
> PubMed API key and the storage gauge. **This is a navigation change only.** No
> data flow, no retention behaviour, no deletion or export mechanism, and no
> third-party recipient changed, so every factual row in this document stands as
> audited; only the menu path a user follows to reach two of them differs.

---

## 19. Chrome Web Store disclosure mapping

Based **only** on the extension behaviour verified in §11. This is a factual draft for a human to review against the live Developer Dashboard. **Nothing here has been or may be submitted, and selecting these answers does not guarantee policy compliance** — Google's form wording and policies change, and only the live form is authoritative.

> **SUPERSEDED IN PART on 2026-08-29.** One answer below is now wrong for the current extension: **Website content** is **Yes**, not No. Every other row still holds. The corrected mapping, and why only that one row moved, is in §24.

### 19.1 Data-type questions

| Dashboard category | Factual answer | Repository evidence | Ambiguity |
|---|---|---|---|
| Personally identifiable information | **No** | No name, address, email, phone, username or ID is read or transmitted. The extension holds no account | None |
| Health information | **No** | The transmitted value is a publication identifier, not information about a person's health | Arguable only if one reads "the user viewed a paper about X" as health information about the *user*. The extension transmits the identifier only on an explicit second gesture, never automatically |
| Financial and payment information | **No** | None accessed | None |
| Authentication information | **No** | No `cookies` permission, no storage, no session, no Supabase call | None |
| Personal communications | **No** | No page content is ever read | None |
| Location | **No** | No geolocation API, no IP handling | None |
| **Web history** | **Yes** | The active tab's URL is read on invocation. Chrome's own definition covers "the domains or URLs the browser interacts with". Answering No would be indefensible | None — this is the honest answer and should not be argued away |
| User activity | **No** | No clicks, keystrokes, mouse position or interaction telemetry | None |
| Website content | **No** | URL only. No DOM, text, image or media is read | None |

### 19.2 Certifications

| Certification | Factual position | Evidence |
|---|---|---|
| I do not sell or transfer user data to third parties, apart from the approved use cases | **Can certify** | Nothing is sold. The only transfer is a user-initiated navigation carrying one identifier to PaperLume, the extension's own first-party service |
| I do not use or transfer user data for purposes unrelated to my item's single purpose | **Can certify** | The identifier *is* the single purpose |
| I do not use or transfer user data to determine creditworthiness or for lending purposes | **Can certify** | Not applicable |

### 19.3 Permission justification (`activeTab`)

Factual basis for the justification field: the extension needs the address of the page the user is looking at in order to recognise a PubMed record or a DOI. `activeTab` grants that only in response to the user's click on the toolbar action, and only for that tab. No host permission and no `tabs` permission is requested, because `activeTab` is sufficient and narrower.

### 19.4 Remote code

**None.** CSP is `script-src 'self'; object-src 'self';`; the packaging script re-reads the built ZIP and fails on any remote reference. Opening a PaperLume tab is *navigation*, not remote code execution.

### 19.5 Items that block submission

| Blocker | Status |
|---|---|
| **A published, publicly reachable privacy policy URL** | Required by Google whenever an extension handles user data, and "Web history = Yes" makes it unambiguous. **Does not exist** (§18) |
| Single-purpose statement | Drafted in `chrome-web-store-readiness.md` §2; owner must submit |
| Store listing assets / brand icons | Recorded as outstanding in `chrome-web-store-readiness.md` |
| Manual release acceptance checklist | `chrome-web-store-readiness.md` § Manual release acceptance checklist |

### 19.6 What the privacy policy must cover for the extension

1. That it reads the active tab's URL, only when the user opens the popup.
2. That it stores nothing and transmits nothing automatically.
3. That pressing **Continue** opens PaperLume with only a PMID or DOI.
4. That the source URL, page content and page titles are never sent.
5. How PaperLume then handles that identifier (§5, §9).
6. The processor list — Supabase, NCBI/PubMed, Crossref, Google Gemini, Resend — **noting that the extension itself contacts none of them**.
7. The contact route for data-subject requests.

---

## 20. Privacy-policy fact matrix

Columns: **Collected/accessed? · Source · Purpose · Stored? · Storage/location · Shared/processor · Retention evidence · Deletion evidence · Wording confidence · Owner input needed?**

Location is `Supabase (ap-south-1, India)` unless stated. "Until account deletion" means no automatic expiry exists.

| # | Data category | Collected? | Source | Purpose | Stored? | Location | Processor | Retention | Deletion | Confidence | Owner input |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | User UUID | Yes | Generated at signup | Identity, row scoping | Yes | Supabase Auth + every table | Supabase | Until deletion | Hard-deleted | VERIFIED | No |
| 2 | Email address | Yes | User at signup | Auth, confirmation, reset | Yes | `auth.users` + `profiles.email` | Supabase; **Resend** (delivery) | Until deletion | Cascade + Auth delete | VERIFIED (storage) / PARTIALLY VERIFIED (Resend) | No |
| 3 | Password | Yes | User | Auth | Yes (hashed) | Supabase Auth | Supabase | Until deletion | Deleted with Auth user | VERIFIED | No |
| 4 | Display name | Optional | User | Display | Yes | `profiles` | Supabase | Until deletion | Cascade | VERIFIED | No |
| 5 | NCBI PubMed API key | Optional | User pastes it | Raise the user's own NCBI rate limit | Yes, **plaintext** | `profiles.pubmed_api_key` | Supabase; sent to **NCBI** in request URLs | Until removed or deletion | Cascade; excluded from export | VERIFIED | Disclose explicitly |
| 6 | Paper bibliographic metadata (title, abstract, authors, journal, year, PMID, DOI, URLs, MeSH, substances, publication types) | Yes | **NCBI/Crossref**, or user-typed | The library | Yes | `papers` | Supabase; sent to **Gemini** (title+abstract) when the user runs AI | Until deletion | Cascade | VERIFIED | No |
| 7 | Paper notes | Yes | User-authored | User's own annotations | Yes | `papers.notes` | Supabase only — **never sent to Gemini** | Until deletion | Cascade | VERIFIED | No |
| 8 | AI outputs (`tldr`, AI-derived study type / statistical methods) | Yes | **Generated by Google Gemini** | Summary and classification | Yes | `papers` | Google (generation), Supabase (storage) | Until deletion | Cascade | VERIFIED | AI disclosure wording |
| 9 | Projects (name, description, colour) | Yes | User-authored | Organisation | Yes | `projects` | Supabase; **names + descriptions sent to Gemini** by suggestions | Until deletion | Cascade | VERIFIED | Disclose explicitly |
| 10 | Tags (name, colour) | Yes | User-authored | Organisation | Yes | `tags` | Supabase; **names sent to Gemini** by suggestions | Until deletion | Cascade | VERIFIED | Disclose explicitly |
| 11 | Paper↔Project / Paper↔Tag assignments | Yes | User-authored | Organisation | Yes | junction tables | Supabase | Until deletion | Cascade | VERIFIED | No |
| 12 | Keyword pool + exclusions | Yes | User-authored | Normalization | Yes | pool tables | Supabase | Until deletion | Cascade | VERIFIED | No |
| 13 | Study-type pool + exclusions | Yes | User-authored | Normalization | Yes | pool tables | Supabase | Until deletion | Cascade | VERIFIED | No |
| 14 | Synonym pool | Yes | User-authored | Normalization | Yes | `synonym_pool` | Supabase | Until deletion | Cascade | VERIFIED | No |
| 15 | Saved filter presets | Yes | User-authored | Saved searches | Yes | `filter_presets` (opaque JSONB) | Supabase | Until deletion | Cascade | VERIFIED | No |
| 16 | Author identities, aliases, links, merges (incl. `author_name_snapshot`) | Yes | User assertions over third-party author names | Disambiguating researchers | Yes | four tables | Supabase | Until deletion | Cascade | VERIFIED | Note third-party personal data |
| 17 | Attachment binaries (PDFs, images) | Yes | User upload | Keeping the paper with the record | Yes | Storage bucket `attachments`, private, `{userId}/{paperId}/…` | Supabase | Until deleted; sweep at account deletion | Storage `remove()`; best-effort on paper delete (§6.3) | VERIFIED | No |
| 18 | Attachment metadata | Yes | Derived from upload | Listing, quota | Yes | `paper_attachments` | Supabase | Until deletion | Cascade | VERIFIED | No |
| 19 | PubMed search queries | Yes, **transiently** | User types them | Searching PubMed | **No** — not persisted anywhere | — | **NCBI** receives the query | Not retained by PaperLume; only `q_len` is logged | Nothing to delete | VERIFIED | No |
| 20 | Import identifiers (PMID/DOI/title) | Transiently | User, or the extension handoff | Metadata lookup | Only as the resulting paper row | — | **NCBI**, **Crossref** | See #6 | See #6 | VERIFIED | No |
| 21 | Entitlement / plan state | Yes | Seeded at signup | Quota enforcement | Yes | `user_entitlements` | Supabase | Until deletion | Cascade | VERIFIED | No |
| 22 | AI usage counters | Yes | RPC-written | Quota enforcement | Yes — **counts only, no content** | `usage_counters` | Supabase | Until deletion | Cascade | VERIFIED | No |
| 23 | Storage usage total | Yes | Trigger-maintained | Quota enforcement | Yes | `user_storage_usage` | Supabase | Until deletion | Cascade | VERIFIED | No |
| 24 | Internal operational role | Operator-set | Manual insert | Owner/manager capabilities | Yes | `internal_user_access` | Supabase | Until deletion | Cascade | VERIFIED | No |
| 25 | Billing / subscription records | **Not today** | Would come from a provider | Billing | Schema only; **0 rows** | `subscriptions`, `subscription_events` | None today | **Would survive deletion, unlinked** | `SET NULL`, not deleted | VERIFIED (mechanism) | **Yes — retention decision** |
| 26 | Supabase Auth session | Yes | Auth | Keeping the user signed in | Yes | **Browser `localStorage`** | — | Until sign-out / expiry / cleared | Local sign-out clears it | VERIFIED | No |
| 27 | Column width + visibility preferences | Yes | User's UI actions | Remembering table layout | Yes | **Browser `localStorage`** | — | Until cleared | Not server-side | VERIFIED | No |
| 28 | `sidebar:state` cookie | Yes | User's UI action | Remembering sidebar state | Yes | **First-party cookie**, 7-day max-age | — | 7 days | Expires | VERIFIED | Cookie-notice decision |
| 29 | Extension: active tab URL | Yes, on click | Chrome `activeTab` | Detecting a paper from the address | **No** | Read into memory only | None | Not retained | Nothing to delete | VERIFIED | No |
| 30 | Extension: handed-off identifier | Yes, on a second click | Derived from the URL | Opening the import route | Only if the user completes the import | URL query parameter | None — navigation, not a request | See #6 | See #6 | VERIFIED | No |
| 31 | Edge Function operational logs | Yes | Server-side | Debugging, operations | Yes | Supabase platform | Supabase | **Supabase's schedule** | Not user-controllable | PARTIALLY VERIFIED | **Yes — state honestly** |
| 32 | Hosting request logs (IP, user agent, path) | Yes | Inherent to serving the app | Hosting | Yes | Vercel | Vercel | **Vercel's schedule** | Not user-controllable | PARTIALLY VERIFIED | **Yes — state honestly** |
| 33 | Auth email content and address | Yes | Auth flows | Confirmation, password reset | At the provider | **Resend** | Resend | **Resend's schedule** | Not user-controllable | PARTIALLY VERIFIED | **Yes** |
| 34 | Gemini prompt/response at Google | Sent | §8 | AI features | At Google | Google | Google | **Unknown from source** | Cannot be deleted by PaperLume | EXTERNAL POLICY VERIFICATION REQUIRED | **Yes** |
| 35 | Analytics / advertising / tracking identifiers | **No — none exist** | — | — | **No** | — | — | — | — | VERIFIED | No |
| 36 | Age / date of birth | **No — not collected** | — | — | **No** | — | — | — | — | VERIFIED | **Yes — minimum-age decision** |
| 37 | Payment card / billing details | **No — not collected** | — | — | **No** | — | — | — | — | VERIFIED | Revisit at billing |
| 38 | Precise or coarse location | **No — not collected** | — | — | **No** | — | — | — | — | VERIFIED | No |

---

## 21. Policy outline proposal

**A structural outline only. Deliberately not legal copy, and not to be published as drafted.** Each section names the facts it must carry and where they are established.

1. **Who we are and how to contact us** — operator name, entity, address, privacy contact, DSR route. *All §17, all owner input.*
2. **What PaperLume is** — a personal scientific-literature manager; a plain statement that the library is private to the account.
3. **What we collect** — account data (§4), research-library data (§5), attachments (§6), browser storage (§7). Name the PubMed API key explicitly; name notes and AI outputs explicitly; note that bibliographic data includes third-party author names (§5.1).
4. **What we do not collect** — no analytics, tracking, advertising, fingerprinting, location, payment data or age (§10, §20 rows 35–38). This is a genuine strength and can be stated flatly.
5. **How we use it** — operating the library, running the two AI features on request, enforcing quotas, sending transactional auth email.
6. **AI features, in detail** — a dedicated section, because this is the widest disclosure. Cover: both features are user-initiated and never automatic; `analyze-paper` sends title and abstract; `suggest-paper-organization` sends title, abstract, keywords, study type **and every Project and Tag name plus Project descriptions**; ids, notes, authors, attachments and identity are never sent; outputs are stored (§8.1) or not (§8.2); the AI output disclaimer.
7. **Third parties and processors** — the table in §9.1, and an explicit statement that Paddle/Stripe/analytics/error-tracking are **not** used (§9.2). *Sub-processor terms and DPAs: EXTERNAL POLICY VERIFICATION REQUIRED.*
8. **Where data is stored** — Supabase in `ap-south-1` (India); Vercel edge hosting; the AI provider's own locations (§16). *Transfer mechanism: legal input.*
9. **Retention** — until the user deletes it or deletes the account; no automatic expiry; the `subscriptions` exception if billing ever launches; provider log retention outside our control (§13). **No invented periods.**
10. **Your rights and how to exercise them** — export (§12.7) and deletion (§12) are both self-service and shipped, which is worth stating concretely. Which statutory rights apply: legal input.
11. **Deletion, precisely** — what is removed, in what order, and what deletion cannot reach (§12.5). Do not claim total erasure.
12. **Security** — only §14. Never the §14.1 list.
13. **Cookies and local storage** — the one first-party cookie and the three `localStorage` items (§7.2); no tracking cookies.
14. **The Chrome extension** — the seven points in §19.6.
15. **Children** — whatever minimum age the owner sets (§15). *Owner/legal.*
16. **Changes to this policy, and effective date.**

**Also needed, and not part of the privacy policy:** Terms of Service, an AI-output disclaimer surfaced *in the app* where AI output is shown (currently absent — §18), a support page, and the in-app links to all of them (currently absent — §18).

---

## 22. Complete list of owner and legal inputs required

### 22.1 Legal identity and contact — blocking

1. Legal operator name and entity (or an explicit statement that the operator is an individual).
2. Registered/postal address.
3. Privacy contact email and the data-subject-request route.
4. Confirmation that `support@paperlume.app` resolves to a real inbox (currently recorded as pending).
5. Governing law and jurisdiction.
6. Whether a DPO or an EU/UK representative is needed.

### 22.2 Policy decisions

7. Minimum age, and whether to add a gate (§15).
8. Retention decision for `subscriptions` / `subscription_events` before billing launches (§12.4).
9. Whether a cookie/consent notice is required (§7.2).
10. Where the policy will be published — the marketing-site provider is still an unmade decision (C16/C19), so no publication target exists.
11. Which privacy regimes are being claimed as applicable (relevant given India-hosted data and an operator whose location the repository does not establish).

### 22.3 First-party verification against providers

12. **Google Gemini API** — retention, training use, human review, DPA, processing regions (§8.4).
13. **Supabase** — DPA, sub-processors, log and backup retention, encryption at rest.
14. **Vercel** — DPA, access-log retention.
15. **Resend** — DPA, email log retention.
16. **NCBI** and **Crossref** — their public terms for query data.

### 22.4 Product gaps this audit found (each is separate work, not a documentation fix)

17. **No AI disclaimer is surfaced in the app** where AI output is shown, despite being a stated launch requirement (§18).
18. **No `/privacy`, `/terms`, `/support` route or link exists** in the app (§18).
19. **The Crossref `User-Agent` names the retired `paperindex.app` brand** and an address of unknown reachability (§9.3).
20. **Orphaned attachment binaries can survive a failed best-effort cleanup** until account deletion (§6.3).
21. **No error-tracking with PII redaction exists**, which is a stated launch blocker — if one is later added, it becomes a new processor and this audit must be revised.

---

## 23. Maintenance

This document describes the commit in §1, plus the dated addenda that follow it. It stops being true when any of the following change, and must be revised in the same PR that changes them — **as an addendum, not as an edit to the snapshot**, so that the record of what was true when remains readable:

- a new Edge Function, or a change to what an existing one sends to a provider;
- a new table or column holding user data, or a change to a `ON DELETE` rule;
- a new external endpoint contacted by client or server;
- any analytics, telemetry or error-reporting dependency;
- a change to the extension's manifest, permissions or handoff contract;
- a billing integration reaching `subscriptions` / `subscription_events`;
- a change to the Supabase region or hosting arrangement.

---

## 24. Addendum — 2026-08-29 — CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01

> **This is a dated delta, not a rewrite.** §11 and §19 above record the
> extension as it was at the commit in §1, and they are left intact: those
> statements were accurate when they were made, and this section records what
> changed, when, and why — rather than editing history so that every old sentence
> reads like current state. Where the two disagree, **this section is current**.

| Item | Value |
|---|---|
| Change | `CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01` |
| Date | 2026-08-29 |
| Base commit | `89a7c247db55b3b1ee062ddb434b9501253662ac` |
| Scope | The Chrome extension only. No application, Edge Function, migration, schema, RLS, provider, or Production change of any kind |
| Method | Read of the changed source, the built `dist-extension/` bundle, and the release-candidate ZIP; plus first-party re-reading of Chrome's `activeTab` and `chrome.scripting` documentation. No Production access, no Dashboard access |

### 24.1 Why the change happened

Owner manual acceptance of the 001E2 release candidate failed on the DOI case. A
DOI resolver redirects almost immediately — `https://doi.org/10.1038/s41586-020-2649-2`
becomes `https://www.nature.com/articles/s41586-020-2649-2` — so by the time an
ordinary user clicks the toolbar action, the active tab's URL is the publisher's
and contains no DOI. The URL-only classifier answered *unsupported* for the most
ordinary way anyone navigates by DOI. The behaviour was correct by its own rules
and unusable in practice.

### 24.2 The behaviour delta, stated as before and after

| | Before (§11, at the audited commit) | After (2026-08-29) |
|---|---|---|
| Manifest permissions | `["activeTab"]` | `["activeTab", "scripting"]` |
| Host permissions | None | **None** — unchanged |
| Privileged Chrome API surface | `chrome.tabs.query`, `chrome.tabs.create` | those two plus `chrome.scripting.executeScript` |
| Page access | **None.** No DOM, no `<meta>`, no title, no text | Four `<meta>` `content` values, in `document.head`, main frame only, on an invoked tab whose URL identified no paper |
| Content scripts | None | **None** — unchanged |
| Background context | None | **None** — unchanged |
| Storage | None | **None** — unchanged |
| Network capability | None | **None** — unchanged |
| What the handoff carries | `kind` + `value` | **`kind` + `value`** — unchanged |
| Title fallback | None | **None** — unchanged |
| Source files | 5 | 7 (`detectPaperFromMetadata.ts`, `classifyActiveTab.ts` added) |
| Shipping package files | 8 | **8** — unchanged; the new code bundles into `popup.js` |

### 24.3 What is accessed now

**The active tab's URL**, as before, only after the user clicks the toolbar
action.

**And, only where that URL identified no paper**, the `content` of `<meta>`
elements in `document.head` whose `name` or `property` — case-normalized —
is one of exactly four keys:

```text
citation_doi · dc.identifier · dc.identifier.doi · prism.doi
```

The read is bounded on three independent axes:

- **When.** Only for the `unsupported` outcome of the URL classifier, which means
  only on an ordinary `http(s)` page. A PubMed record and a `doi.org` link are
  answered from the address and the page is never touched; a `chrome://` page, a
  `file://` URL or a tab with no readable address is `restricted` and no
  injection is attempted at all. Asserted in
  [`classifyActiveTab.test.ts`](../extension/src/__tests__/classifyActiveTab.test.ts),
  where those cases assert `executeScript` was **not called**.
- **What.** Four keys, from the head, main frame only (`allFrames` is not passed,
  so Chrome's documented default applies). Not read: the document title, article
  title, abstract, authors, journal, headings, body text, anchor `href`s,
  `data-` attributes, JSON-LD, inline scripts, JavaScript variables, sub-frames,
  PDFs, forms, cookies, page storage, the selection, or any other tab.
- **By whose permission.** `scripting` enables the API and grants access to no
  page; the host access comes from `activeTab`, which exists only for the tab the
  user invoked the action on and only until they navigate away. **VERIFIED**
  against the browser: `chrome.permissions.getAll()` returns
  `{ permissions: ["activeTab","scripting"], origins: [] }`, and a real
  `executeScript` call with no toolbar grant is refused by Chrome with *"Cannot
  access contents of the page. Extension manifest must request permission to
  access the respective host."* ([`load.spec.ts`](../e2e-extension/load.spec.ts)).

### 24.4 Local processing, retention and transmission

**Local and transient.** The collected strings are normalized by the
application's own DOI boundary (`extractDoiFromMetadataValue` in
[`src/lib/doiIdentifiers.ts`](../src/lib/doiIdentifiers.ts)), reduced to a set of
distinct DOI names, and used to produce at most one DOI. They live in the popup's
page for as long as the popup is open and are gone when it closes.

**Retention: none.** Unchanged from §11.7. No `storage` permission, no
`chrome.storage`, `localStorage`, `sessionStorage`, `indexedDB`,
`document.cookie` or Cache API reference exists in the source or the built
bundle, and there is no background context. Asserted in a real browser *after* a
metadata read has occurred ([`metadata.spec.ts`](../e2e-extension/metadata.spec.ts),
*"stores nothing, having read a page"*).

**Automatic transmission: none.** Unchanged from §11.4. No network primitive
exists in the bundle. In particular the DOI read from a page is **not resolved** —
doi.org, Crossref and PubMed are not contacted to check that it exists.

**After the user presses Continue:** `kind` and `value`, exactly as before. The
page URL, page content, title, authors and journal do not travel, and the handoff
grammar has no third parameter to carry them in. Asserted on a metadata-detected
DOI in a real browser, including that the publisher host, article title and
author name appear nowhere in the URL.

**Fail-closed on ambiguity.** A page publishing two *different* valid DOIs
produces `unsupported` — never a choice between them. `doi` is a per-user
deduplication key, so offering the wrong paper is a data-integrity problem rather
than a display one.

### 24.5 Corrected Chrome Web Store disclosure mapping

Only one row of §19.1 changes:

| Dashboard category | §19.1 answer | Current answer | Basis |
|---|---|---|---|
| **Website content** | No | **Yes** | The extension reads `<meta>` element content from the page. Four bibliographic keys, processed locally and transiently, with neither the content nor the page URL transmitted — but content **is** accessed, and the category asks what is accessed |
| Web history | Yes | **Yes** — unchanged | The active tab's URL is still read on invocation |
| All other categories | No | **No** — unchanged | No PII, health, financial, authentication, communications, location or interaction telemetry is read. None was moved to Yes without evidence |

The three certifications in §19.2 are unaffected: nothing is sold or transferred,
the identifier is still the single purpose, and creditworthiness remains
inapplicable.

The permission justification in §19.3 now needs a second half covering
`scripting`: it is required because a DOI resolver redirects before the user can
invoke the extension, it grants no page access on its own, and pairing it with
`activeTab` is narrower than any `host_permissions` entry — which would grant
standing access to every matching page regardless of user action. Drafted text is
in [chrome-web-store-listing.md](chrome-web-store-listing.md) §6.

§19.4 (remote code) is unchanged. The injected function ships inside the package
and is serialized out of `popup.js` by Chrome at call time; nothing is fetched and
nothing is evaluated from a string.

### 24.6 Consequence for the public Privacy Policy — OWNER/LEGAL ACTION REQUIRED

`src/pages/Privacy.tsx` §4 currently states, in a list of things the extension
does **not** do:

> read the contents of the webpage or its DOM;

**That is now inaccurate.** It was accurate for every version up to and including
001E2, and it became inaccurate on 2026-08-29.

The rest of §4 remains accurate: the extension still does not maintain a
browsing-history database, does not read website cookies or authentication
tokens, does not store the active-tab URL, does not use background content
scripts, and does not directly transmit the active-tab URL to PaperLume.

CORRECTION-01 **did not edit that file**. The public Privacy Policy is
owner-approved legal text under separate control, and amending it is an owner and
legal decision. The amendment needed is narrow — replace that bullet with an
accurate statement of the bounded metadata read, and extend the paragraph about
reading the active tab's URL to mention it.

**Classification: OWNER INPUT REQUIRED, blocking.** No Chrome Web Store
submission should proceed while the disclosed *Website content = Yes* contradicts
a posted policy saying the page is never read. Recorded as a blocking gate in
[chrome-web-store-readiness.md](chrome-web-store-readiness.md) §6 and as an item
in its manual acceptance checklist.

### 24.7 What this addendum does not change

Nothing outside the extension. No new table, column, `ON DELETE` rule, Edge
Function, external endpoint, analytics or error-reporting dependency, billing
integration, Supabase region or hosting arrangement. The retention matrix (§13),
the deletion analysis (§12), the AI data flows (§8) and the processor list (§9)
are untouched. Row 29 of the §20 fact matrix — *"Extension: active tab URL"* —
gains a sibling: **extension: page DOI metadata · Yes, on click, only where the
URL identified nothing · Chrome `activeTab` + `scripting` · identifying a paper
after a DOI redirect · Stored: No · Read into memory only · No processor ·
Not retained · Nothing to delete · VERIFIED · Owner input: no**.
