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
3. **Four categories of external service receive data today**: Supabase (all storage/auth); **the routed AI provider** — **Google, Anthropic or OpenAI**, whichever belongs to the effective model the server resolves for that operation, which is Google by default and on every fallback (title/abstract, or title/abstract/keywords/study-type plus Project and Tag *names*; §8); NCBI E-utilities (identifiers and search queries); and Crossref (DOI or title). *(This item previously named Google Gemini as the sole AI recipient, which held until the paid providers were activated — §30.)* Two more receive no user content: Google Cloud Monitoring (aggregate provider metrics, owner/manager only) and Vercel (static hosting).
4. **A fifth processor is live but configured outside this repository**: **Resend**, as Supabase Auth's custom SMTP, which handles transactional auth email and therefore the user's email address.
5. **There is no application analytics, telemetry, error-reporting, advertising or fingerprinting of any kind.** See §10. *(Amended 2026-09-13, and again 2026-09-17 — PaperLume now keeps an internal, server-written AI provider-usage record in its own Supabase project, live in Production since the 2026-09-17 Phase 6 deploy: content-free, unreadable by browsers, and sent to no external recipient. It is operational accounting, not application analytics or a third-party telemetry service; before that deploy this statement held for Production without qualification. See §29.)*
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

- `analyze-paper` accepts exactly `{ title, abstract }` from the request body and sends only those two strings to the routed AI provider ([`analyze-paper/index.ts:161`](../supabase/functions/analyze-paper/index.ts#L161)). The structural answer is provider-independent: the payload is built once, provider-neutrally, so it is the same for all three families.
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

> **Addressed, and now live in Production — see [§27](#27-addendum--2026-09-04--attachment-orphan-cleanup-hardening-001) for the change and [§28](#28-addendum--2026-09-10--attachment-orphan-cleanup-hardening-001-production-rollout-and-acceptance) for the rollout and its acceptance.** `20260904120000` makes the cleanup intent durable in Postgres before the metadata naming the object is removed. The paragraph above describes the system as it behaved **before** that migration; it is kept because it is what the deployed system did for the whole period this audit covers. The two claims it refuses stay refused: there is still no scheduled worker, so cleanup is not immediate and not guaranteed for a user who never returns.

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

## 8. AI provider data flow

> **CURRENT STATE — read this first.** The paragraphs after the next two are a **chronology** (`AI-MULTI-PROVIDER-001A` → `001B` → `001C`), written phase by phase. Several of them say "Google remains the only AI recipient" in the present tense; **that was true at the phase each describes and is no longer true.** This box and the two paragraphs that follow it are the current description; §30 carries the paid-provider privacy review, and its own status note records activation.
>
> - **Research content can reach one of three AI providers: Google, Anthropic or OpenAI.** Which one is decided **server-side, per operation**: the recipient is the provider belonging to the **effective routed model** that [`_shared/aiModelSelection.ts`](../supabase/functions/_shared/aiModelSelection.ts) returns for that request. A saved preference is the *input* to that decision, never the decision itself.
> - **A user's selection does matter — it is just not sufficient on its own.** For an entitled caller whose saved preference passes every server-side check, the effective routed model **is** the one they pinned, so pinning `anthropic/claude-sonnet-5` or `openai/gpt-5.6-terra` does send their Analyze and Suggest content to that provider instead of Google.
> - **The default recipient is still Google, and every failure path lands there.** With no saved preference — and whenever entitlement cannot be re-proven or the routing metadata cannot be safely established (access-lookup failure, malformed access row, preference-read failure, malformed preference, catalog-read failure, or a missing, disabled, malformed or unregistered-provider catalog row) — the resolver **fails closed on the model-selection capability** and returns PaperLume's server-side system default (`GEMINI_MODEL`, C34). The AI feature itself still runs; only the routing reverts. **So a saved Claude or GPT preference can legitimately be answered by Google**, and no disclosure may promise otherwise.
> - **What is sent did not change.** The payload is built provider-neutrally, with no per-provider branch that could add a field: title + abstract for Analyze, the allow-listed draft fields + Project/Tag names on ephemeral refs for Suggest (re-verified against source in §30.2 / §30.3). **No user id, email, paper id, plan or quota state reaches any provider.**
> - **The browser contacts no AI provider, for any provider family.** Every provider call is server-side from a Supabase Edge Function, and no provider credential ever reaches the browser.
> - **One credential per provider**, each read only by its own adapter; there is deliberately no generic shared key.
> - **Retention and training terms differ by provider** and are **not** established from this repository. The first-party reading is §30.4; §8.4 states what still cannot be answered from code.

Two AI features exist. Both run **server-side from a Supabase Edge Function** and dispatch through a reviewed per-provider adapter chosen by the runtime registry ([`_shared/aiProviderRegistry.ts`](../supabase/functions/_shared/aiProviderRegistry.ts)):

| Provider family | Endpoint | Credential (Edge secret) |
|---|---|---|
| **Google** | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `GEMINI_API_KEY` (`x-goog-api-key`) |
| **Anthropic** | `https://api.anthropic.com/v1/messages` | `ANTHROPIC_API_KEY` (`x-api-key`) |
| **OpenAI** | `https://api.openai.com/v1/responses` | `OPENAI_API_KEY` (`Authorization: Bearer`) |

Each adapter reads **only its own** credential name ([`_shared/aiProviderCredentials.ts`](../supabase/functions/_shared/aiProviderCredentials.ts)); a missing or blank value fails closed for that provider rather than falling back to another provider's secret. **The browser never contacts any AI provider**, and no provider credential is ever sent to it.

Model: the **system default** is resolved from the optional `GEMINI_MODEL` secret through [`_shared/geminiModel.ts`](../supabase/functions/_shared/geminiModel.ts), with the fallback `gemini-flash-latest`; both functions resolve it through the same module, so they cannot disagree about the default. Since `AI-MODEL-SELECTION-001B` (C33) both also share [`_shared/aiModelSelection.ts`](../supabase/functions/_shared/aiModelSelection.ts), which may route an individual request to a *different* model when — and only when — the caller's `can_select_ai_model` entitlement is re-proven on that request and their saved `user_ai_preferences` row resolves to an `enabled` row in the server-controlled `ai_model_catalog` whose provider has a registered runtime adapter. *(As written, this clause said "an `enabled` `google` row", which was accurate while `google` was the only registered adapter. Since `AI-MULTI-PROVIDER-001C` the registry holds three, so the row may name `google`, `anthropic` or `openai` — which is exactly how research content reaches a non-Google recipient.)* Every other case, including any failure to read that metadata, falls back to the system default. **No model string is ever accepted from the browser**: neither request contract has a model field, and the resolver reads no request input at all. `AI-MODEL-SELECTION-001D` (C35) adds Gemini 3.7 Flash and Gemini 3.8 Flash to that catalog and changes nothing in this paragraph: same provider, same Gemini API family, same single `GEMINI_API_KEY`, same request body and structured-output contract, same parsing, and the same two content values sent to Google at a different model path. It is a catalog row, so it introduced no new recipient, no new data category and no new transfer, and no new legal conclusion was drawn. *(That reasoning is specific to C35, which added two more **Google** models. It does not generalise: `AI-MULTI-PROVIDER-001E` later added rows for two **other** providers, and those rows did add recipients — which is why they required the separate review in §30.)* For a Google-to-Google catalog addition like C35, only the `{model}` component of the Gemini URL changes — the request body, the single `GEMINI_API_KEY` and its `x-goog-api-key` header, the parsing and the quota behaviour are identical either way, and **nothing additional about the user is sent to Google** (the routing decision is made entirely inside Supabase; Google receives only the same two content values as before, at a different model path). Generation config for both: `responseMimeType: "application/json"` and no explicit sampling override — the earlier `temperature: 0.1` was removed by `AI-PROVIDER-REQUEST-CONTRACT-001A`.

**Historical — state at `AI-MULTI-PROVIDER-001A` (C39), 2026-09-12.** This paragraph is a point-in-time record; its Google-only conclusions were true then and are **superseded** by the current-state box above. 001A changed **nothing in this section's disclosure findings**, and is recorded here only so a reader of the code does not mistake a new module for a new recipient. It moved the Gemini URL, request envelope, `x-goog-api-key` header and response-envelope reading out of the two Edge Functions and into a single reviewed Google adapter behind a provider-neutral contract, and it was verified — by running the pre- and post-refactor implementations of both operations side by side — to send the byte-identical request to the same endpoint with the same headers. **At that phase: Google was the only AI recipient, `GEMINI_API_KEY` the only provider credential, and the data sent was unchanged.** No Anthropic or OpenAI adapter, model, credential, endpoint or catalog row existed: the runtime registry held the single `google` adapter, and a catalog row naming any other provider was refused before a request could be built, so PaperLume did not send data to Anthropic or OpenAI and could not be configured to by a database row alone. **All three of those facts have since changed** — see the current-state box above. The durable part, which still holds, is the *mechanism*: a catalog row alone has never been sufficient to reach a provider, because the runtime registry is a separate authorization and each provider needs its own credential. The refactor also narrowed one log path rather than widening it: a 2xx body that cannot be parsed is now logged as a bounded code instead of a JSON parse error that could quote a fragment of the provider's response.

**Historical — state at `AI-MULTI-PROVIDER-001B` (C40).** Another point-in-time record, superseded by the current-state box above. 001B changed **nothing in this section's disclosure findings, and added no recipient.** It is recorded here because it makes one clause of the paragraph above no longer literally true: repository code now contains a reviewed Anthropic adapter ([`_shared/anthropicAiProvider.ts`](../supabase/functions/_shared/anthropicAiProvider.ts), Claude Messages API) and a reviewed OpenAI adapter ([`_shared/openAiProvider.ts`](../supabase/functions/_shared/openAiProvider.ts), OpenAI Responses API), and each names its provider's endpoint. Three things need to be kept apart:

- **Repository capability:** adapter code for both providers exists and is tested only with injected fakes.
- **Runtime capability:** none *at 001B*. Neither adapter was registered, no shipping Edge Function imported either module, no credential was set, and no catalog row named either provider. *(**Fully superseded.** C41 registered both adapters; the 2026-09-17 Phase 6 deploy put both modules in the deployed generation bundles; `AI-MULTI-PROVIDER-001E` seeded a catalog row for each and Phase 8 (`20260918210017`) made both `selectable`. The intermediate note that once stood here — "both remain unreachable because no credential is installed and neither row is `selectable`" — described the staging window only and is no longer true; see §30 and its status note.)*
- **Production data flow:** unchanged **at 001B**, when Production ran the pre-001A Google-only artifacts — Google was then the only AI recipient, and no request was sent to Anthropic or OpenAI during 001B. **Superseded:** per the deployment record, both paid providers were canaried on 2026-09-18 and opened to entitled users on 2026-09-19 (§30 status note).

**Data shape for the paid adapters — written as prospective at 001B; the described shape is now the ACTIVE one.** The prediction held exactly: each adapter receives the same provider-neutral prompt strings already sent to Google, and nothing more. For `analyze-paper` that is the title and abstract (§8.1). For `suggest-paper-organization` it is the allowlisted draft fields and the bounded Projects/Tags taxonomy described in its subsection below. Neither adapter sends a user id, email, paper id or any user-identifying metadata. The OpenAI adapter sends `store: false` on every request, because the Responses API otherwise stores responses by default. Enabling either provider added a new recipient and a new transfer, which needed its own privacy review — that review is §30, it was completed on 2026-09-17, and activation followed it rather than this note. *(As written at 001B this sentence was forward-looking and deliberately pre-approved nothing.)*

**Historical status, durable analysis — `AI-MULTI-PROVIDER-001C` (C41).** 001C registered the Anthropic and OpenAI adapters and added PaperLume's reasoning policy, and **at that phase added no active recipient and no new data category**: no `anthropic/*` or `openai/*` catalog row existed and neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` was installed, so no request could reach either provider. **That status is superseded** — both rows were seeded and both credentials installed under `AI-MULTI-PROVIDER-001E`, and the two models are selectable by entitled users (§30 status note). **The rest of this paragraph is not superseded:** it describes what reasoning adds to a provider request, and that analysis holds for all three families today. The 001A–001D generation runtime went live on **2026-09-17** (Phase 6); until then Production's `analyze-paper` and `suggest-paper-organization` ran the pre-001A, Google-only artifacts. The 001C frontend has been live since 2026-09-13, but it sends nothing to any AI provider; it reads catalog metadata and exports the reasoning column. With the 001C runtime live, the change for Google is **one request parameter**: `generationConfig.thinkingConfig.thinkingLevel`, carrying a bounded product word (`minimal`, `low`, `medium` or `high`). The operation inputs are exactly as described above: title and abstract for Analyze, and the existing allow-listed draft/taxonomy payload for Suggest. **No user id, email, internal model id, preference row, plan or quota state is added to any provider request.** The user's saved reasoning choice becomes a protocol PARAMETER, never user metadata sent to a provider. Hidden provider reasoning output is never returned to the browser, logged or persisted: the Anthropic and OpenAI extractors still select only user-facing text and ignore `thinking`, `redacted_thinking` and `reasoning` content. The prospective shape above gains two things, and both are protocol parameters rather than data about the user: each paid provider's explicit reasoning field (Anthropic `thinking` plus `output_config.effort`, OpenAI `reasoning.effort`), and the operation's output ceiling (4,096 or 8,192 tokens). OpenAI's `store: false` is unchanged.

### 8.1 `analyze-paper`

| Question | Answer | Class |
|---|---|---|
| Trigger | The user explicitly presses an analyse action on a paper (single or batch) — [`usePaperAnalysisActions.ts`](../src/hooks/usePaperAnalysisActions.ts), [`EditPaperDialog.tsx:338`](../src/components/papers/EditPaperDialog.tsx#L338). Never automatic, never on import | VERIFIED |
| Data sent to the routed provider | Exactly two values, in one text part: `Title: {title}` and `Abstract: {abstract}`, plus a fixed system instruction. Provider-neutral: identical whichever of the three families the model resolves to (§30.2) | VERIFIED |
| Data **not** sent | User id, email, paper id, PMID, DOI, journal, authors, notes, Projects, Tags, keywords, attachments, any other paper, any token | VERIFIED |
| Response | `{ tldr, studyType, statisticalMethods }` | VERIFIED |
| Response stored? | **Yes.** The client merges and persists it into `papers.tldr`, and into `study_type` / `statistical_methods` per the merge rule | VERIFIED |
| Quota | One unit consumed via `consume_ai_quota` *before* the provider call; best-effort `refund_ai_quota` on any provider or parse failure | VERIFIED |
| Logging | Step markers, HTTP status codes, a provider-error class, and bounded error messages. **The raw provider response body is never logged**, and no title, abstract or user id is logged | VERIFIED |

### 8.2 `suggest-paper-organization`

| Question | Answer | Class |
|---|---|---|
| Trigger | The user presses the suggestion control for one paper ([`PaperOrganizationSuggestions.tsx`](../src/components/papers/PaperOrganizationSuggestions.tsx)) | VERIFIED |
| Data sent to the routed provider | A JSON document built by **allow-list**: the paper's `title`, and `abstract`, `keywords`, `studyType` where present; **every** Project of that user as `{ref, name, description?, alreadySelected}` and **every** Tag as `{ref, name, alreadySelected}`. Provider-neutral: identical whichever of the three families the model resolves to (§30.3) | VERIFIED |
| Data **not** sent | Database ids (Projects/Tags are given ephemeral request-local refs `P1…Pn` / `T1…Tn` and the type has no `id` field), user id, email, plan/quota state, internal role, authors, affiliations, ORCID, notes, PMID, DOI, any URL, attachments, other papers, tokens | VERIFIED |
| Response | Suggested existing Projects/Tags by ref plus proposed new names, each with a short rationale | VERIFIED |
| Response stored? | **No.** The endpoint mutates nothing — its injected DB interface exposes only `select` and `rpc`, with no `insert`/`update`/`upsert`/`delete` to call. Suggestions are returned to the client and only applied if the user accepts them through the ordinary mutation paths | VERIFIED |
| Quota | One unit via `consume_ai_quota` after all validation; refunded best-effort on provider failure or unusable output | VERIFIED |
| Logging | Structured counts only — outcome, number of Projects/Tags in, number of suggestions out. **No name, title, abstract, ref or user id is logged** | VERIFIED |

**Privacy-material fact for the policy:** `suggest-paper-organization` sends the user's **entire Project and Tag taxonomy** — every name, and every Project description — to the routed AI provider on each invocation — Google by default and on any fallback, or Anthropic/OpenAI when an entitled user's saved preference for one of those models is honoured in full by the server-side resolver (§8). Those are user-authored labels that can be descriptive ("Ph.D. chapter 3 — paediatric sepsis"). This is the single widest AI disclosure in the product and must be stated plainly.

### 8.3 `get-gemini-provider-quota`

Owner/manager only, gated by `get_current_user_access()`. It queries **Google Cloud Monitoring** (`monitoring.googleapis.com`, minted via `oauth2.googleapis.com` with a service-account JWT and the `monitoring.read` scope) for aggregate Gemini usage metrics of the shared Google Cloud project. **No user data of any kind is sent, and no per-user metric is requested.** The `deployment.md` record states no frontend surface calls this function today; the audit confirms no caller exists in `src/` — the only matches are an unrelated capability flag on the access hook. Credentials are never returned or logged.

### 8.4 Provider policy questions — do not answer from code

The following **cannot** be established from this repository and must be verified first-party against **each provider's** current published terms for the specific API and account tier in use before any statement is made in a policy. This now applies to all three providers that can receive research content — Google, Anthropic and OpenAI — not to Google alone:

- whether the provider's API inputs/outputs are retained, and for how long;
- whether they may be used to train or improve models;
- whether human review may occur;
- which legal entity is the processor, and in which regions processing occurs;
- whether a data processing addendum applies and has been accepted.

**Class: EXTERNAL POLICY VERIFICATION REQUIRED.** The same applies to NCBI, Crossref, Supabase, Vercel and Resend.

**A first-party reading for the two paid providers already exists and is not repeated here:** §30.4 records Anthropic's and OpenAI's published processing terms as read on 2026-09-17, together with the specific overclaims §30.8 refuses to make. It is a **dated** reading, not a standing guarantee — re-verify before publishing anything from it. **No equivalent first-party reading of Google's terms has been recorded in this audit**, so the questions above remain fully open for Google.

---

## 9. External services and third parties

### 9.1 Services that currently receive or return data

| Service | Purpose | Data sent | Data received | Client or server | Evidence |
|---|---|---|---|---|---|
| **Supabase** (Postgres, Auth, Storage, Edge Functions) | The entire backend | Everything in §4–§6; auth credentials | Everything the app displays | Both — browser talks to Supabase directly with the anon key under RLS; Edge Functions run in Supabase's runtime | [`src/integrations/supabase/client.ts`](../src/integrations/supabase/client.ts), all migrations |
| **Google Gemini** (`generativelanguage.googleapis.com`) | AI analysis and organisation suggestions — the **system default** recipient, and the recipient whenever no model is pinned or any fallback occurs | §8.1 / §8.2 | Generated text | **Server (Edge Function) only** | [`analyze-paper/index.ts`](../supabase/functions/analyze-paper/index.ts), [`suggest-paper-organization/handler.ts`](../supabase/functions/suggest-paper-organization/handler.ts) |
| **Anthropic** (`api.anthropic.com`) | The same two AI features, **only** when the effective routed model for that request is `anthropic/claude-sonnet-5` — i.e. an entitled user's saved preference for it was honoured in full by the server-side resolver. A preference that fails any check routes to Google instead (§8) | §8.1 / §8.2 — byte-for-byte the same allow-listed payload as Google (§30.2 / §30.3) | Generated text | **Server (Edge Function) only** | [`_shared/anthropicAiProvider.ts`](../supabase/functions/_shared/anthropicAiProvider.ts) |
| **OpenAI** (`api.openai.com`) | The same two AI features, **only** when the effective routed model for that request is `openai/gpt-5.6-terra` — same server-side condition as the Anthropic row (§8) | §8.1 / §8.2 — the same allow-listed payload; the adapter sends `store: false` | Generated text | **Server (Edge Function) only** | [`_shared/openAiProvider.ts`](../supabase/functions/_shared/openAiProvider.ts) |
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
| **Supabase Edge Function logs** | Structured operational lines written by the functions. Audited line by line: `search-pubmed` logs `q_len=<length>` and **never the query text** ([`handler.ts:317-336`](../supabase/functions/search-pubmed/handler.ts#L317-L336)); `suggest-paper-organization` logs outcomes and counts only; `analyze-paper` logs step markers, HTTP statuses, a provider-error class and a bounded failure reason; `delete-account` logs a removed-object **count** and a failure code. **`fetch-paper-metadata` logs the PMID being parsed** (`pubmed-parse pmid=… bytes=… fetch_ms=…`) — a public catalogue number, but one that reveals which paper a request concerned | VERIFIED |
| **Supabase platform logs** | Postgres, Auth, Storage and API-gateway logs kept by Supabase. Retention and content are Supabase's, not this repository's | EXTERNAL POLICY VERIFICATION REQUIRED |
| **Vercel access logs** | Standard hosting request logs (IP, user agent, path, timing) | EXTERNAL POLICY VERIFICATION REQUIRED |

**No user id, email, token, key, title, abstract, note, Project name or Tag name is written to any application log.**

> **CORRECTION — EDGE-LOG-PRIVACY-HARDENING-001 (2026-09-18).** The sentence above was originally justified by checking all 50 `console.*` call sites across `supabase/functions/**` for **which variables were passed**. That method could not see the real exposure, and the claim was therefore stronger than the evidence: two functions interpolated a caught throwable's `.message`, and a message is not content-free.
>
> - **V8 `JSON.parse` quotes its input.** `analyze-paper` threw `gemini_parse_failed: <parseErr.message>` when a generated answer would not parse, and logged that message — so a ~20-character fragment of the paper's own generated content could reach the log. Reproduced, not theorised: parsing `{"tldr": Sleep deprivation…}` yields `Unexpected token 'S', "{"tldr": Sleep depr"... is not valid JSON`.
> - **`fetch` errors can embed the request URL.** `fetch-paper-metadata`'s `fetchWithRetry` retained the runtime's own error and rethrew it after the retry budget; each caller then logged `error.message`. A PubMed URL carries the PMID, the DOI or title being searched, and the user's `api_key`; a Crossref URL carries the DOI or title.
> - The outer `catch` of each function logged `error.message` too, which is the catch a malformed `req.json()` body reaches — so a caller could put a fragment of their own request (identifiers, or an abstract) into the log by sending broken JSON.
>
> **What changed.** No arbitrary throwable text can now reach a log from either function. Every caught value is reduced to an allow-listed error **name** by `_shared/boundedLogging.ts`, and failure lines are built from server-generated bounded facts only (operation, upstream, HTTP status, attempt number, error class, and one of a closed set of reason literals). The transport reports its own bounded failure and throws a fixed message instead of the provider's error. `err.message`, `String(err)`, `stack` and `cause` are read by nothing. Regression tests feed real V8 parse failures and URL-bearing transport errors through the shipped code and assert none of that material appears.
>
> **Status: VERIFIED — merged and LIVE in Production since 2026-09-18.** The hardening PR merged as `a3c7d910`, and both affected functions were deployed from that exact commit: `analyze-paper` as **v30** and `fetch-paper-metadata` as **v22**, each read back byte-identical to the merged source. So in the reviewed application log paths of those two functions, an arbitrary throwable message can no longer be logged: every caught value is reduced to an allow-listed error name, the JSON parse exception is discarded rather than bound, the reduction survives a hostile value whose `name` is a throwing getter or `Proxy` trap, and the upstream transport throws a fixed `upstream_fetch_failed` instead of a raw fetch error that could carry the request URL, its query and the user's `api_key`.
>
> **The precise scope, stated so this is not read as more than it is:**
>
> - It closes the specific application-log finding above, in `analyze-paper` and `fetch-paper-metadata` only. `suggest-paper-organization` was **not** redeployed and did not need this module: it never interpolated a throwable message into a log.
> - It says nothing new about the other two rows of this table. **Supabase platform-log** retention and content, and **Vercel access-log** retention, remain outside this repository and are still EXTERNAL POLICY VERIFICATION REQUIRED — deploying application code cannot and did not verify them.
> - `fetch-paper-metadata` still deliberately logs the PMID it is parsing (`pubmed-parse pmid=… bytes=… fetch_ms=…`), exactly as the row above records. That is unchanged by the hardening, which was about throwable text, not about this bounded identifier.
> - It is a statement about what the code can log, not a claim that any particular historical log line is now absent; logs written before the deployment are unaffected.

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

The extension is **not published** to the Chrome Web Store and no listing exists (`docs/deployment.md`, `README.md` §167). `npm run package:extension` produces a local, gitignored release candidate ZIP and explicitly uploads, publishes and tags nothing. *(Updated 2026-08-30 — see §26 and §26.8: a **draft** Store item now exists, the `0.1.0` package has been uploaded to it, and the listing, privacy, test-instruction and distribution fields have since been **populated and saved**. The extension is **still not published and still not submitted**. The packaging command's behaviour is unchanged: it still uploads nothing; the upload and the form entry were separate, owner-authorized manual actions.)*

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

**Addendum (2026-09-02, AI-MODEL-SELECTION-001A / C33).** The repository adds one further cascading user table, `user_ai_preferences` (a saved AI-model choice — one row per user, no free text, no credential). Its `ON DELETE CASCADE` and its removal alongside the account are pinned by the same suite `008`, together with the fact that the global `ai_model_catalog` row it referenced **survives** the deletion, since the catalog is product metadata rather than account data. **A Settings control now exists** (`AI-MODEL-SELECTION-001C`), so a preference is a row a user can genuinely create and remove. It changes nothing about the deletion contract: the row is written only by `set_current_user_ai_model` and removed by `clear_current_user_ai_model` or by the `auth.users` cascade, it carries no free text and no credential, and `delete-account` still enumerates no tables. The list above records what is deployed.

**Addendum (2026-09-19, AI-MANUAL-REASONING-001 / C45) — activation adds no data category, and no Privacy Policy change is required.** **Status: APPLIED — migration `20260919075655` reached Production on 2026-09-19, so manual reasoning is live for entitled users and this addendum now describes a shipped state rather than a prospective one.** Activating manual reasoning lets an entitled user **write** a value to `user_ai_preferences.preferred_reasoning_level`, a column that has existed since 2026-09-12 and has always been declared, exported and cascade-deleted. Nothing else moves:

- **No new column, table or file.** The column, its `ON DELETE CASCADE`, its place in `data/user_ai_preferences.json` and account export v3 are unchanged.
- **No new personal data.** The stored value is one bounded product word from a closed eight-literal vocabulary (`minimal | off | none | low | medium | high | xhigh | max`), or `null` for Automatic. It is a setting the user chose about model effort — not content, not free text, not an identifier, and it cannot carry one.
- **No change to what leaves PaperLume.** The same allow-listed payload reaches the same providers for the same two operations; only the reasoning parameter's value can differ, and that parameter was already being sent on every request since the Phase 6 deploy (Automatic is an explicit level, never an omission). No new provider, endpoint, credential or retention term is involved.
- **No change to telemetry.** `ai_provider_usage_events` already records `reasoning_source` and `resolved_reasoning_level`; a manual choice is recorded as the existing `manual` source rather than a new field. The table's schema, RLS posture and content-free rule are untouched.
- **Conclusion: no public Privacy Policy amendment is required, and `src/pages/Privacy.tsx` is deliberately unchanged.** The published wording already covers AI processing, the AI usage records disclosure and the export; none of it becomes false when a user picks a reasoning level. Had any published sentence needed to change, that would have been an owner-approval gate before publication, not a drafting step.

**Addendum (2026-09-12, AI-MULTI-PROVIDER-001C / C41).** `data/user_ai_preferences.json` gains `preferred_reasoning_level`: the user's manual reasoning choice as a bounded product word, or JSON `null` for Automatic. It is user-owned portable data. It contains no provider parameter name, no credential and no catalog metadata, and it names nothing about how any provider spells the level. Because it reshapes an existing archive file, the export version is bumped **2 → 3**, so a reader can tell an export that predates reasoning from one whose user is on Automatic. The global `ai_model_catalog`, including its new reasoning capability columns, stays excluded.

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

**Addendum (2026-09-02, AI-MODEL-SELECTION-001A / C33).** The archive gains one singleton category, `data/user_ai_preferences.json`, carrying the user's saved AI-model choice: `user_id`, `preferred_model_id`, `created_at`, `updated_at`. It is exported from the moment the schema and its write RPC exist — `set_current_user_ai_model` is granted to `authenticated`, so a real row can exist without any Settings control, and a portability archive that omitted it would silently drop a choice the user made. **No preference exports as JSON `null`**, which is the meaningful "system default" state rather than an omission. The exported id is **not** resolved against `ai_model_catalog`: that table is global Paperlume product metadata, identical for every account, and stays permanently out of the archive. No credential, provider mechanism, entitlement or commercial field travels with the preference. The reader degrades to `null` for exactly one condition — a missing-object error naming `user_ai_preferences`, i.e. an environment that predates the migration — and every other failure still aborts the whole export. `ACCOUNT_EXPORT_VERSION` stays **2**: a new category file is additive and no existing file changed shape.

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
| AI prompt content at the routed provider (Google, Anthropic or OpenAI), queries at NCBI/Crossref, email at Resend | **Not determinable from this repository** — EXTERNAL POLICY VERIFICATION REQUIRED. Retention terms **differ by provider**; §30.4 is a dated first-party reading for Anthropic and OpenAI, and none of the three is known to offer PaperLume zero retention |
| Supabase and Vercel platform logs and backups | **Not determinable from this repository** — EXTERNAL POLICY VERIFICATION REQUIRED |

**Do not state a number of days for anything.** If the policy needs a defined retention period, that is a product decision plus an implementation, not a documentation exercise.

---

## 14. Security measures actually evidenced

Only claims supportable by implementation. Each is safe to state; nothing below is an absolute.

| Measure | Evidence | Class |
|---|---|---|
| Transport encryption | All endpoints are HTTPS: Supabase, Vercel (`app.paperlume.app`), Gemini, NCBI, Crossref. No `http://` endpoint is contacted in application code | VERIFIED |
| Row Level Security | **Enabled on every public application table present at audit time: 24/24 regular tables** in schema `public` (read-only `pg_class` verification; 0 with RLS disabled, 22 of the 24 additionally `FORCE`). That is the same 24-table set this audit inventories in §4 and §5. Owner-scoped policies key on `auth.uid()` | VERIFIED |
| Server-only tables | `subscriptions`, `subscription_events`, `usage_counters`, `internal_user_access` have **no client policy at all**; since `20260910212202` (2026-09-11) **all four** additionally have direct privileges revoked from `PUBLIC`, `anon` and `authenticated` — previously that was true of `internal_user_access` alone | VERIFIED |
| Private Storage with owner-scoped authorization | Bucket `public = false`; four path-prefix RLS policies; reads only via 1-hour signed URLs | VERIFIED |
| Authenticated Edge Functions | All six require an `Authorization` header and validate it with an authoritative `auth.getUser()` **network** call. None accepts a user id from a request body | VERIFIED |
| Ownership re-checks in RPCs | `20260518010000_rpc_auth_uid_ownership_check.sql` and `20260802025704_harden_rpc_and_relational_ownership.sql` add `auth.uid()` ownership guards; `20260810152125` hardens function `search_path` | VERIFIED |
| No elevated key in the browser | Verified: `grep -rn SERVICE_ROLE src/` matches only test assertion strings. The only elevated key use is inside `delete-account`, from the runtime-injected secret, never returned or logged | VERIFIED |

**Addendum (2026-09-10, updated on closure 2026-09-11 — DATA-API-ACL-RECONCILIATION-001 / C38).** The rows above describe Production's live state. Migration `20260910212202_reconcile_data_api_acls.sql` — **applied to Production on 2026-09-11** — extended the `internal_user_access` treatment named in the "Server-only tables" row to every client role on every table, and the historical ACL drift found during this audit is now **remediated in the live project**: `PUBLIC` and `anon` hold **no** relation or sequence privilege anywhere in `public` (all 28 ordinary tables and the one sequence), `authenticated` is narrowed to an exact per-table matrix with `USAGE`-only on `papers_insert_order_seq`, the other three server-only tables (`subscriptions`, `subscription_events`, `usage_counters`) lost the client-role privileges they had carried from the platform default, and the `postgres`/`public` defaults for **future** tables and sequences no longer grant `PUBLIC`, `anon` or `authenticated` anything. Two surfaces are deliberately unchanged and remain separate, unremediated questions: **function `EXECUTE` and function default `EXECUTE`** (the SECURITY INVOKER helpers still carry PUBLIC EXECUTE from PostgreSQL's global default), and **`service_role`**, whose exact posture was preserved by design rather than narrowed. This is a database object-privilege hardening change, **not** a response to demonstrated exposure: every policy on those tables requires `auth.uid() = user_id`, no anonymous row access was shown, and the Data API exposes no path to the non-DML privileges (`TRUNCATE`, `TRIGGER`, `MAINTAIN`) that RLS does not cover. **Nothing about collected user data, processors, retention, data-sharing behaviour or user-facing privacy semantics changed** — this is a privilege boundary, not a data-flow change.
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
| **Anthropic** | `api.anthropic.com` — a global endpoint, reached only when the effective routed model for the request is the Claude model (§8). **No region is specified in the request** | PARTIALLY VERIFIED |
| **OpenAI** | `api.openai.com` — a global endpoint, reached only when the effective routed model for the request is the GPT model (§8). **No region is specified in the request** | PARTIALLY VERIFIED |
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

> **SUPERSEDED IN PART.** Two things below no longer describe current state, and both are left as written rather than edited, because they were true when audited:
>
> - **2026-08-29** — one data-type answer moved: **Website content** is **Yes**, not No. Every other row still holds. The corrected mapping, and why only that row moved, is in §24.
> - **§19.5's privacy-policy blocker row** describes the state *before* PAPERLUME-PRIVACY-001B. `/privacy` exists and is public. See §25 for what that blocker became.

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
| **A published, publicly reachable privacy policy URL** | Required by Google whenever an extension handles user data, and "Web history = Yes" makes it unambiguous. **Does not exist** (§18) — *the state at this audit; PAPERLUME-PRIVACY-001B has since published `/privacy`, and what remained of this blocker is tracked in §25* |
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
| 6 | Paper bibliographic metadata (title, abstract, authors, journal, year, PMID, DOI, URLs, MeSH, substances, publication types) | Yes | **NCBI/Crossref**, or user-typed | The library | Yes | `papers` | Supabase; sent to **the routed AI provider** — Google, Anthropic or OpenAI (title+abstract) — when the user runs AI | Until deletion | Cascade | VERIFIED | No |
| 7 | Paper notes | Yes | User-authored | User's own annotations | Yes | `papers.notes` | Supabase only — **never sent to any AI provider** | Until deletion | Cascade | VERIFIED | No |
| 8 | AI outputs (`tldr`, AI-derived study type / statistical methods) | Yes | **Generated by the routed AI provider** (Google by default; Anthropic or OpenAI if selected) | Summary and classification | Yes | `papers` | The routed provider (generation), Supabase (storage) | Until deletion | Cascade | VERIFIED | AI disclosure wording |
| 9 | Projects (name, description, colour) | Yes | User-authored | Organisation | Yes | `projects` | Supabase; **names + descriptions sent to the routed AI provider** by suggestions | Until deletion | Cascade | VERIFIED | Disclose explicitly |
| 10 | Tags (name, colour) | Yes | User-authored | Organisation | Yes | `tags` | Supabase; **names sent to the routed AI provider** by suggestions | Until deletion | Cascade | VERIFIED | Disclose explicitly |
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
| 34 | AI prompt/response at the routed provider | Sent | §8 | AI features | At Google, Anthropic or OpenAI — whichever the **effective routed model** names (§8); Google on every fallback | That provider | That provider | **Unknown from source**; differs by provider (§30.4 is a dated first-party reading for the two paid providers only) | Cannot be deleted by PaperLume | EXTERNAL POLICY VERIFICATION REQUIRED | **Yes** |
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
20. **Orphaned attachment binaries can survive a failed best-effort cleanup** until account deletion (§6.3). *NARROWED, not closed. The fix is live in Production: `ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001` landed in the repository 2026-09-04 (§27), both migrations are now applied to Production, and the lifecycle passed a bounded wet acceptance on 2026-09-10 (§28). Cleanup is now **recoverable** — durable intent, retried immediately and again at the next authenticated session — but still **not immediate and not guaranteed**: there is no scheduled worker, so a queue row waits for a user who never returns, an object whose finalization never reached the database is deliberately left in place, and pre-feature orphans remain. Account deletion stays the final sweep, and this item therefore stays open in its residual form.*
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

**Fail-closed on ambiguity.** A page publishing two *non-equivalent* valid DOIs
produces `unsupported` — never a choice between them. `doi` is a per-user
deduplication key, so offering the wrong paper is a data-integrity problem rather
than a display one.

Equivalence is DOI Handbook §4.3.4, not string equality: ASCII `A`–`Z` compares
identical to `a`–`z`, so `10.1000/AB` and `10.1000/ab` are one DOI and one
detection. The fold is ASCII-only and deliberately not `toLowerCase()` — the
Handbook's own counterexample, `10.26321/Á.GUTIÉRREZ…` against
`10.26321/á.gutiérrez…`, is two *different* DOI names, so a page carrying both is
still refused. The comparison key never leaves the resolver: what is displayed,
handed off and stored is one of the DOI names the page actually published, so
this changes nothing about the values that reach the application.

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

> **The owner input asked for above was given on 2026-08-30.** The diagnosis in
> this section stands exactly as written — it is what was wrong and why — and
> **CORRECTION-01 still did not edit the legal copy**, which remains the correct
> record of that change's scope. What follows it is a separate piece of work with
> its own authority: the owner approved amended §4 wording, and
> `PRIVACY-POLICY-EXTENSION-METADATA-001B` implements it. **That work was not yet
> merged or deployed when this annotation was written on 2026-08-30**, so the
> policy served at `/privacy` was still the pre-amendment text and this gate was
> still open. §25 records the resolution and what was left to verify.
>
> **Superseded later the same day — see §25.6.** The pull request merged as
> `8144504508df333e850c0ed38ec1352c9579ca24` and the amended policy was verified
> live in public Production signed out. **This gate is CLOSED.** Nothing above is
> withdrawn: it is the record of what was wrong, and of the intermediate state
> between approval and publication. Do not read it as the present state.

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

---

## 25. Addendum — 2026-08-30 — PRIVACY-POLICY-EXTENSION-METADATA-001B

> **A second dated delta, on the same terms as §24.** §11 and §19 remain the
> audited snapshot; §24 remains the record of what CORRECTION-01 changed and of
> the policy mismatch it opened. Neither is rewritten here. This section records
> one thing only: the owner/legal decision §24.6 asked for, and what it does and
> does not close.

| Item | Value |
|---|---|
| Change | `PRIVACY-POLICY-EXTENSION-METADATA-001B` (plus `…-REVIEW-01`, the disclosure-precision correction in §25.1.1) |
| Owner approval date | 2026-08-30 |
| Base commit | `b2d4943b3c77893e682f94767f347bec9e50b79d` |
| Scope | Public legal copy (`src/pages/Privacy.tsx`), its test contract, and three documentation corrections. **No extension, application, Edge Function, migration, schema, RLS, provider, Store or Production change of any kind** |
| Extension behaviour | **Unchanged.** Re-verified against the shipping source before the copy was edited — see the correspondence table below |

### 25.1 What the owner approved

Amended §4 of the public Privacy Policy, plus an effective date of **August 30,
2026** (the previous date was August 29, 2026). The wording is frozen
owner-approved copy: this task implemented it verbatim and is not authorised to
reword it. The material additions over the pre-amendment text are:

- the metadata fallback is **disclosed**, including that it runs only where the
  URL identified no paper;
- the **four supported DOI metadata names** are named in the public copy —
  `citation_doi`, `dc.identifier`, `dc.identifier.doi`, `prism.doi`;
- the check is disclosed as **main-frame only**, not inspecting embedded frames;
- processing is disclosed as **local and transient**, and explicitly **not
  persisted**;
- the retired bullet *"read the contents of the webpage or its DOM"* is replaced
  by a **bounded** negative list (article/body text, page title, abstracts,
  author names, links, form contents, iframe contents, and metadata content
  values other than the four supported names);
- the no-transmission bullet is **scoped rather than categorical** — see §25.1.1;
- an affirmative **Limited Use** statement closes the section, making the public
  Privacy Policy the disclosure location for it.

#### 25.1.1 Why the no-transmission bullet carries an exception

Exact-head review of the first draft found one remaining ambiguity, and the owner
approved a corrective sentence for it on the same day. The bullet had read
*"directly transmit the active-tab URL or webpage content to PaperLume."* — which
is too categorical, because a detected DOI **can be derived from the `content`
value of one of the four approved metadata elements**, and that DOI does travel
when the user presses Continue. Read strictly, the bullet contradicted the
paragraph immediately beneath it. The approved bullet now ends:

> …, except for the detected identifier value described below when you choose to
> continue.

The distinction the amended §4 now draws, stated precisely:

- DOI metadata is read **locally only**, and only through the bounded approved
  fallback — four keys, `document.head`, main frame, and only where the URL
  identified no paper;
- a detected DOI may therefore be **derived from a supported metadata `content`
  value**;
- after the user **explicitly chooses Continue**, that detected DOI travels to
  PaperLume as the `value` of the `kind`/`value` handoff;
- this does **not** mean PaperLume receives the active-tab URL, article or body
  text, the page title, the abstract, author names, links, form contents, iframe
  contents, arbitrary metadata values, or any other webpage content. The handoff
  grammar has no third parameter to carry them, and the identifier is the only
  thing the exception licenses.

Nothing about the extension changed for this correction: it is a disclosure
precision fix in the public copy, and the shipping behaviour is exactly as
§25.2 records it.

The approved copy is **more precise than an earlier draft proposal** on one
point, and deliberately so: `activeTab` access is described as revoked *"when the
tab navigates to a different website origin or when the tab is closed"*, not on
any navigation. Chrome's own documentation is explicit that the grant survives
same-origin navigation — *"if the user invokes the extension on
https://example.com and then navigates to https://example.com/foo, the extension
will continue to have access to the page"* — so the approved sentence is the
accurate one.

### 25.2 Factual correspondence, re-verified at the base commit

Every material sentence of the approved copy was checked against the shipping
source **before** the legal text was edited. Nothing required a code change, and
none was made.

| Approved statement | Evidence |
|---|---|
| Explicit toolbar activation only | `popup.ts` classifies on popup open; manifest has no `background` and no `content_scripts` |
| Temporary `activeTab` access, revoked on cross-origin navigation or tab close | First-party [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) documentation |
| URL checked first | [`classifyActiveTab.ts`](../extension/src/classifyActiveTab.ts) — `pubmed`, `doi` and `restricted` all return before any injection |
| No page inspection when the URL identifies a paper | `classifyActiveTab.test.ts` asserts `executeScript` was **not** called for those outcomes |
| Exactly four metadata names | `const keys = ["citation_doi", "dc.identifier", "dc.identifier.doi", "prism.doi"]` |
| Page header only | `document.head.querySelectorAll("meta")` |
| Main frame only, no embedded frames | `allFrames` is not passed, so Chrome's documented default applies |
| No title or other page-content fallback | No title variant exists on `PaperDetection`; decoy DOIs in title, body and links are asserted ignored |
| No cookies or authentication tokens | No `cookies` permission; no `document.cookie`; the extension holds no session |
| Not persisted | No `storage` permission; `sourceBoundary.test.ts` and a real-browser check after a metadata read |
| No automatic transmission | `sourceBoundary.test.ts` asserts every network primitive absent from every source file |
| Continue carries only identifier type + value | [`paperLumeHandoff.ts`](../extension/src/paperLumeHandoff.ts) builds `kind` + `value` only; the handoff grammar has no third parameter |
| Permissions exactly `activeTab` + `scripting`, no host permissions | [`manifest.json`](../extension/manifest.json) — `host_permissions` absent |

### 25.3 Store disclosure mapping — unchanged

**Website content = Yes** and **Web history = Yes** both stand exactly as §24.5
records them. The amendment exists to make the *public policy* consistent with
those answers, never to argue either of them down. Local-only processing is not
an exemption: Google's [User Data
FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
states that *"Extensions are required to disclose how they handle user data, even
when data is processed or stored locally on a user's device and is not
transmitted to external servers."*

### 25.4 What this closes, and what it does not

**Closed by owner decision:** the §24.6 question of *what the policy should say*.
The wording exists, is approved, and is implemented.

**NOT closed — as at the time this subsection was written (2026-08-30, before
the merge). All three were closed later the same day; see §25.6.**

- **Merge.** `PRIVACY-POLICY-EXTENSION-METADATA-001B` is a pull request. Until it
  merges, `main` still carries the inaccurate §4.
- **Deployment.** Merging is not publishing. The policy a Store reviewer reads is
  whatever Production serves.
- **Production verification.** The signed-out, clean-browser check of
  `https://app.paperlume.app/privacy` must be performed **after** merge and
  deployment, and must confirm the amended §4 and the August 30, 2026 effective
  date. A Vercel Preview is not Production and does not close this gate.

Until all three happen, the pre-Chrome-Web-Store privacy gate stays **open**.

> **Superseded 2026-08-30 by §25.6.** All three did happen: the PR merged as
> `8144504508df333e850c0ed38ec1352c9579ca24`, GitHub's Vercel status for that
> commit reported success, and the signed-out Production check passed. **The
> privacy mismatch gate is CLOSED.** The three requirements above are retained
> because they are the correct standard, and because they record the state
> between owner approval and publication — not because any of them is still
> outstanding.

### 25.5 What this addendum does not change

Nothing outside the public legal copy and its documentation. No extension
behaviour, permission, metadata key, DOI normalization, handoff, popup, package
inventory or Store asset. No table, column, `ON DELETE` rule, Edge Function,
external endpoint, analytics dependency, billing integration, Supabase region or
hosting arrangement. §11 (audited snapshot), §12, §13, §19.1–19.4, §20's matrix
and §24's delta are all left as written; the historical statements in §19.5 and
§24.6 are annotated in place rather than rewritten, so what was true when, and
what changed it, both remain readable.

### 25.6 Closure after merge and Production verification

**Added 2026-08-30 (CWS-PRIVACY-GATE-DOC-CLOSURE-001), after the material above
was written.** §24.6 and §25.4 are left intact: they record, correctly, what the
mismatch was and the intermediate state in which owner approval existed but the
published policy had not yet changed. This subsection records what happened next
and supersedes their "gate open" conclusion.

**Merge.**

| Fact | Value |
|---|---|
| Pull request | **#258** — *PRIVACY-POLICY-EXTENSION-METADATA-001B — align public policy with DOI metadata access* |
| State | **MERGED**, 2026-08-30 |
| Merge commit | `8144504508df333e850c0ed38ec1352c9579ca24` |
| Merge type | Regular two-parent merge (`b2d4943b3c77893e682f94767f347bec9e50b79d` + `a69adef5413393b61d6dcbe8f33121ca463063c5`) |
| Approved-head tree | `817827f61e5f82b31d636f81a2ee9b91674f814b` |
| Merge tree | `817827f61e5f82b31d636f81a2ee9b91674f814b` — **identical**, so the merge introduced no content beyond the approved head |

**Deployment evidence, stated at exactly the strength it was obtained.**
Push-triggered **Validate**, **DB Tests** and **Extension (package + real
browser)** all succeeded for the merge commit; no E2E(local) push run was
expected or created. GitHub's **Vercel** commit status for that exact SHA reports
**success — *"Deployment has completed"***.

> **Native Vercel READY/alias evidence was unavailable and is NOT claimed.** No
> deployment id, no `READY` state read from Vercel itself, and no alias
> assignment record was obtained. The deployment evidence here is GitHub's commit
> status plus the independent public-Production check below — which is what
> actually matters, since a Store reviewer reads the served page, not a
> deployment record.

**Production verification — public, signed out.** `https://app.paperlume.app/privacy`
returned **HTTP 200 with zero redirects** and required **no PaperLume account**.
The served page showed:

- effective date **August 30, 2026**;
- section **4. PaperLume Chrome extension**, matching the approved 18-block copy;
- the corrected transmission bullet — *"…directly transmit the active-tab URL or
  webpage content to PaperLume, except for the detected identifier value
  described below when you choose to continue."*;
- the identifier paragraph unchanged — *"If you choose to continue, the extension
  opens the PaperLume web application and provides only the detected identifier
  type and value, such as a PMID or DOI."*;
- all four DOI metadata names: `citation_doi`, `dc.identifier`,
  `dc.identifier.doi`, `prism.doi`;
- the affirmative Limited Use sentence — *"PaperLume uses information accessed by
  the Chrome extension only in accordance with the Chrome Web Store User Data
  Policy, including its Limited Use requirements."*

The retired claim *"read the contents of the webpage or its DOM"* was **absent**
from the rendered Production policy.

**Conclusion.** The disclosed **Website content = Yes** and **Web history = Yes**
(§25.3) no longer contradict the posted policy. The pre-Chrome-Web-Store privacy
mismatch gate opened by §24.6 is **CLOSED**, and does not reopen on its own.

**What this does not close.** The *standing* per-submission requirement is a
different gate and remains in force: `https://app.paperlume.app/privacy` must be
re-verified reachable and factually consistent, in Production and signed out,
**immediately before every actual Chrome Web Store submission**. Nothing here
touches the still-unresolved Dashboard-only questions (whether a promotional
video is required; whether a separate store-icon upload field exists), and **no
Chrome Web Store item, upload, listing, submission or publication exists** —
external Store mutation remains `CHROME-EXTENSION-IMPORT-001E3`, which is not
authorized.

> **Superseded in part on 2026-08-30 — see §26.** A draft Store item and an
> uploaded package now exist, and both Dashboard-only questions are resolved. The
> paragraph above is preserved as written; the standing per-submission
> `/privacy` gate it describes is **unchanged and still in force**.

---

## 26. Addendum — 2026-08-30 — `CHROME-EXTENSION-IMPORT-001E3A` / `001E3B`

**Scope.** A Chrome Web Store draft item now exists and the approved package has
been uploaded; the live Dashboard forms were then inspected read-only. This
addendum records what that changed for the *disclosure* analysis. **It changes no
verified data-flow fact in §11, §19, §24 or §25** — the extension's behaviour is
byte-for-byte what those sections audited, and no source file was touched.

### 26.1 Current Store state

| Fact | Value |
|---|---|
| Draft item ID | `cfanjbamcemoeglgkpbidnclkomaocmo` |
| Uploaded version | `0.1.0` — accepted; Store shows `main.crx` |
| Permissions shown by the Store | `activeTab`, `scripting` |
| Item status | **Draft. Not published.** *"This item is not published yet"* |
| Listing / Privacy / Distribution fields | **None deliberately populated or saved** *(true at `001E3B`; superseded 2026-08-30 — all four pages are now populated and saved, see §26.8)* |

**Package provenance is local, not Store-attested.** The uploaded artefact was
`release/paperlume-extension-0.1.0-rc.zip`, **15788 bytes**, SHA-256
`0feb935d914af2141c41aa129bf211cf08492a5d4ccb5e169bab8afb9f9c4634`. **The
Dashboard does not expose that hash**, so nothing here claims Google verified it.
**Class: PARTIALLY VERIFIED** — the local pre-upload validation is fully
inspectable here; what Google did with the bytes afterwards is not.

### 26.2 Disclosure mapping — unchanged

The live form's nine categories match §24.5 exactly, and **every answer stands**:

| Live category | Answer |
|---|---|
| Personally identifiable information | No |
| Health information | No |
| Financial and payment information | No |
| Authentication information | No |
| Personal communications | No |
| Location | No |
| **Web history** | **Yes** |
| User activity | No |
| **Website content** | **Yes** |

**The rationale is unchanged and must not be softened.** Local, transient access
is still access: the category asks what is *accessed*, not what is *retained* or
*transmitted*. Web history = Yes because the active tab's URL is read; Website
content = Yes because four `<meta>` `content` values are read on the fallback
path. That the extension keeps nothing, sends no request of its own, and never
transmits the source URL are all true (§24.4) and none of them changes either
answer.

### 26.3 Remote code — the live form was wrong, and the correct answer is No

The **untouched** live Privacy form was observed displaying **`Yes, I am using
remote code`** with a required `Justification*` exposed.

**That is factually wrong for PaperLume.** The live help text defines remote code
as JavaScript or Wasm not included in the package, including external file
references and `eval`-style string evaluation. §11 and §24 verified, from source
and from the built bundle, that the package contains **no remote JavaScript, no
remote Wasm, no external script import, no `eval`, and no `new Function`**, and
that the function passed to `chrome.scripting.executeScript({func})` is **bundled
inside `popup.js`** and serialized out of the package by Chrome at call time.

**Locked answer: `No, I am not using remote code`.** No justification should be
written, because the `No` path should not require one. This must be **explicitly
changed before Privacy practices is saved**, and re-read afterwards.

### 26.4 Transmission wording — the precision this section already requires

§24.4 and [chrome-web-store-readiness.md](chrome-web-store-readiness.md) §6
already state the exception correctly, and it is restated here because it is the
single easiest claim in this repository to over-simplify:

- the **active-tab / source URL is never transmitted**;
- **arbitrary page content is never transmitted** — no article text, abstract,
  title, authors, journal, headings, links, `data-` attributes, JSON-LD, inline
  scripts, DOM or cookies;
- **only the detected identifier `value` may leave the extension**, and only
  after the user presses **Continue**;
- **that identifier may itself have been derived from a supported DOI metadata
  `content` value** on the fallback path.

So the flat sentence *"page content is never transmitted"* is **false as
stated** and must not be written. The accurate form is *"no page content is
transmitted apart from the detected DOI itself"*. The owner-approved public
Privacy Policy §4 already uses the exception formulation; **it is not modified by
this task**, and nothing here asks for legal copy to change.

### 26.5 Certifications and the Limited Use disclosure

The live Privacy page carries exactly **three** certifications and states *"You
must certify all three disclosures to comply with our Developer Program
Policies"*. All three are true for PaperLume and the intended answer is **certify
all three** (transcribed verbatim in
[chrome-web-store-listing.md](chrome-web-store-listing.md) §7).

**No separate Limited Use checkbox or Limited Use text field was observed.** The
affirmative Limited Use sentence therefore remains where §25.1 put it — in the
public Privacy Policy §4 — and **no second copy should be created**.

### 26.6 New gate — a reviewer account, and why this section cares

The Dashboard has a separate **`Test instructions`** page for reviewer
credentials. The extension is fully inspectable **signed out**, but the
end-to-end path the listing describes requires PaperLume authentication.

This is a **privacy-relevant** gate, not merely an operational one: it means
real credentials for a real Production account will be handed to a third party.
The requirements follow directly — a **dedicated, low-privilege** account, **no
owner/admin rights**, **no sensitive real-user data**, and only the minimal
seeded state needed to exercise the import path. **Credentials must never be
committed to Git, written into a PR description or report, or sent through
chat.** No such account exists yet, and this task does not create one.

> **Addendum, 2026-08-30 — the account now exists, and the privacy-relevant
> requirements were met.** The sentence above ("No such account exists yet") was
> correct when written and is superseded here. A dedicated reviewer account was
> provisioned in PaperLume Production and verified against exactly the posture
> this section demanded: **no owner, manager or admin privilege**, no
> `internal_user_access` row, no AI quota exemption, no premium-taxonomy or
> labs/team privilege, no billing or subscription state — an ordinary **Free**
> entitlement and nothing more. **It contains no seeded real-user research or
> library content: zero papers, projects, tags, attachments and filter presets.**
> It does, necessarily, contain the ordinary account/authentication and
> provisioning records required for a functioning reviewer identity — its Auth
> identity and confirmed email, its credentials, a `profiles` row, the Free
> entitlement and a lifetime usage counter. **That is the accurate claim, and it
> is narrower than "the account holds nothing":** what matters for this section
> is that no real user's research or library content was copied into it, not that
> the identity is somehow record-free. The audited row-by-row evidence is in
> [chrome-web-store-readiness.md](chrome-web-store-readiness.md) §8 item 30.
>
> **The "minimal seeded state" requirement resolved to no additional fixture
> content.** The authenticated import page treats Project and Tag selection as
> optional and completes the canonical import with zero selections, so no fixture
> had to be seeded — which is the better privacy answer, not merely a cheaper
> one: the smallest additional Production dataset needed to exercise the review
> path is zero reviewer research/library fixture rows, on top of the ordinary
> account records the identity requires in any case.
>
> **The credentials are owner-held outside Git and chat, and ~~have not been
> given to Google~~ were entered into the Dashboard's confidential
> `Test instructions` fields on 2026-08-30 under `001E3C`** — see §26.8. The
> never-in-Git/PR/report/chat rule above is unchanged and still binding. This
> addendum records account state only; **no data-flow fact in §11, §19, §24 or
> §25 moves.**

### 26.7 What this addendum does not change

- **No source, extension, schema, migration, Edge Function or policy-copy
  change.** Documentation only.
- **No verified data-flow fact moves.** §11, §19, §24 and §25 stand as written.
- **The standing per-submission `/privacy` verification remains in force** and is
  not discharged by anything here. Last passed **2026-08-30**; re-run it signed
  out, in Production, immediately before any actual submission.
- **No Store form was populated or saved**, nothing was submitted, and nothing is
  published. *(True of `001E3A`/`001E3B`. The forms were populated later the same
  day by `001E3C` — §26.8. Nothing was submitted or published then either, and
  nothing is now.)*

### 26.8 Addendum — 2026-08-30 — `001E3C` entry, `001E3D` read-only audit

**Scope.** The Store draft's four owner-facing pages were **populated and saved**
by `001E3C`, and re-read read-only by `001E3D`. **No verified data-flow fact
moves.** §11, §19, §24, §25 and §26.2 stand exactly as written — no source file
was touched, and the extension's behaviour is byte-for-byte what they audited.

**What the disclosure answers became, live.** The drafted answers in §24.5 /
§26.2 were entered **unchanged and unsoftened**: **Web history = Yes**,
**Website content = Yes**, and the other seven categories **No**. All three
certifications are certified, and the privacy-policy URL saved as
`https://app.paperlume.app/privacy`. Single-purpose and both permission
justifications were entered from the approved short forms and verified
byte-identical after save.

**One live-form correction is privacy-relevant and worth recording.** The
untouched Privacy form had displayed **`Yes, I am using remote code`** (§26.4).
That is factually wrong for this package, and it was corrected: the saved answer
is **`No, I am not using remote code`**, with **no remote-code justification
stored**. It persisted across save and reload.

**Reviewer credentials are now with Google.** They are populated in the
confidential `Test instructions` fields, entered by the owner directly into the
live form. Verification was deliberately limited to **field non-emptiness and
character length** — no value was read, echoed, logged, screenshotted or stored,
and none appears in this repository. **The never-in-Git/PR/report/chat rule is
unchanged and still binding.**

**Publisher contact email.** Publishing additionally required a publisher contact
email to be provided and **verified**; the owner completed both manually, and
`001E3D` confirmed the verified state. **The address is not recorded here.** It
is worth noting for this document's purposes that Google **publicly displays**
that address in connection with the item — an owner disclosure decision, not a
data-flow fact about the extension.

**Submission state is unchanged.** The item is **Draft**, **not submitted** and
**not published**. The live blocker panel lists **zero** items, which means only
that the Dashboard exposes no known pre-submission completeness blocker — **not**
that Google has approved anything, and **not** authorization to submit. The
standing signed-out `/privacy` check above still runs immediately before any
actual submission; it passed again on **2026-08-30** under `001E3D`.

---

## 27. Addendum — 2026-09-04 — `ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001`

**Scope.** This addendum reconciles §6.3 ("Deletion lifecycle for attachments") and §22.4 item 20 with the change that `20260904120000` makes. It adds two user-scoped tables and one condition to an existing Storage RLS policy. **No new processor, no new external recipient, no new network egress and no new server component is introduced**, and no attachment binary is inspected: cleanup uses Supabase Postgres, Supabase Storage and the already-authenticated browser, and nothing else. §8 (AI providers), §9 (NCBI/Crossref), §11/§24/§25/§26 (extension) and §12's account-deletion analysis are untouched. `supabase/functions/**` is byte-identical.

### 27.1 The finding this addendum answers is preserved, not erased

§6.3's closing paragraph and §22.4 item 20 recorded a real defect and **remain the accurate description of the deployed Production system until the migration is applied.** They are not rewritten. Restated for the record, as it was:

- paper deletion read the attachment paths, deleted the papers, and then made one best-effort `storage.remove()`;
- a failure there was caught, logged as non-critical and swallowed;
- after the delete, those paths existed nowhere but a local variable in one browser tab, so nothing in the system knew a binary still needed removal;
- the orphan survived — inaccessible to anyone but its owner, since the Storage RLS path prefix still matched only them — until the user eventually deleted their account, at which point the `delete-account` sweep found it;
- upload had the same weakness in miniature, plus one of its own: the browser INSERTed the attachment metadata itself and, on any error it observed, removed the just-written object with one `remove()` whose failure left no record. "The insert failed" is only ever what a browser OBSERVED, and a request whose response is lost can have committed — so that compensation could delete the binary of a metadata row that was about to become visible.

### 27.2 What changes once the migration is applied

| Before | After (migration applied) |
|---|---|
| Cleanup intent lived only in a browser variable after the delete | Intent is written to `public.attachment_cleanup_queue` in the **same Postgres transaction** that removes the metadata naming the object |
| A failed `storage.remove()` was logged and swallowed | A failure leaves the queue row in place and the user is told cleanup is pending |
| One attempt, then the knowledge was gone | Immediate retry after the action, plus one bounded retry at the next authenticated session start |
| Orphan discoverable only by the account-deletion sweep | Orphan is represented as a durable, owner-scoped row until it is removed |
| Upload metadata was written by the browser, and an ambiguous response could make it delete a valid file | Metadata is written only by `finalize_attachment_upload`, serialized per `(user, path)`, so exactly one of "metadata exists" and "cleanup is authorized" can be true for a path; an ambiguous response is reconciled by repeating the idempotent call, never by deleting |
| A file whose fate was unknown could be removed on a guess | When the database cannot be reached at all, the object is **left in place** and no cleanup is claimed |
| The intent vanished when the cleanup was acknowledged, so a repeated finalization could recreate metadata for a removed binary | `attachment_cleanup_tombstone` keeps the decision permanently, and the `paper_attachments` insert guard reads it |
| A paper deletion could cascade away an attachment finalized after its path snapshot | Both writers take the same per-paper lock, so the snapshot is either taken after the upload committed or the upload cannot commit until the deletion ends |
| Any owner could ask Storage to delete any of their own objects | Storage refuses to delete an object a live `paper_attachments` row still names — which is also what stops a browser tab still running the pre-migration bundle from executing either historical destructive ordering |
| Any signed-in client could delete its own `papers` rows directly, cascading the attachment metadata away with no record of the Storage paths | `DELETE` and `TRUNCATE` on `papers` are revoked from `authenticated`, whose `SELECT`, `INSERT` and `UPDATE` are untouched. `anon` and `PUBLIC` are revoked **by role** and retain none of the five — hosted Production carries a legacy platform ACL that granted `anon` all of them, which a privilege-by-privilege revoke would have left in place. Paper deletion goes through `delete_papers_with_attachment_cleanup`, which records every Storage path in the same transaction the cascade runs in |
| Any signed-in client could INSERT, UPDATE or DELETE its own `paper_attachments` rows directly | `authenticated` holds `SELECT` only — `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` are revoked — and `anon` and `PUBLIC` hold nothing at all, so attachment metadata is created and destroyed only by the three lifecycle RPCs, the cascade they initiate, and account deletion. The migration takes a three-table cutover barrier — `SHARE ROW EXCLUSIVE` on `auth.users`, `SHARE` on `public.papers`, then `ACCESS EXCLUSIVE` on this table — before making that change, so no write authorized under the old privileges can commit under the new posture |

Second new user-scoped table, for the §5 inventory: **`attachment_cleanup_tombstone`** — `user_id`, `file_path` (the same Storage object key form), `created_at`. It records that ONE uploaded object was finalized as garbage, and is kept after the cleanup queue row for it has been acknowledged and deleted; without it a duplicated upload finalization would create attachment metadata for a binary the drain has already removed. It holds no bibliographic content, no file contents, no file name beyond what is already inside the object key, no PMID/DOI and no free text.

**Access:** no client role holds *any* privilege on it and it has **no policy of any kind** — not even SELECT. It is written and read only by `SECURITY DEFINER` functions. A row a user could delete would be a row a user could delete in order to resurrect a removed object.

**Retention:** unlike the queue, this row is **permanent** for the life of the account. That is the point: it is what keeps a removed binary removed. It is bounded by failure, not by traffic — a row exists only for an upload whose metadata the database refused — and `user_id` is `ON DELETE CASCADE` from `auth.users`, pinned by `supabase/tests/database/008_account_deletion_cascade.test.sql`.

**Account export:** excluded, on exactly the same ground as the queue and `user_storage_usage` (see `ACCOUNT_EXPORT_EXCLUDED_TABLES`). It is server-only bookkeeping about upload attempts that failed, described by an internal Storage key, concerning files the archive correctly does not contain. **Exclusion from the archive is not exclusion from deletion or privacy accounting** — it is user-scoped state, it is inventoried here, and it cascades with the account.

New user-scoped table, for the §5 inventory: **`attachment_cleanup_queue`** — `id`, `user_id`, `file_path` (a Storage object key of the form `{userId}/{paperId}/{uniqueName}`), `reason` (one of three fixed operational values), `created_at`. It holds **no** bibliographic content, no file contents, no file name beyond what is already inside the object key, no PMID/DOI and no free text. Clients hold `SELECT`-own and `DELETE`-own and **no INSERT or UPDATE**; `anon`, `PUBLIC` and `service_role` hold nothing. `user_id` is `ON DELETE CASCADE` from `auth.users`, pinned by `supabase/tests/database/008_account_deletion_cascade.test.sql`.

**Retention:** a row exists only between the logical deletion and the successful physical removal of that object — normally seconds. It persists longer only when Storage cleanup has failed, which is the entire point, and it is removed by the account cascade regardless.

**Account export:** the queue is **excluded** from the portability archive (`ACCOUNT_EXPORT_EXCLUDED_TABLES`), on the same ground as `user_storage_usage`: it is server-maintained operational bookkeeping about attachments the user has already deleted, written only by `SECURITY DEFINER` RPCs as a consequence of a deletion, and never authored by the user. **Exclusion from the archive is not exclusion from deletion or privacy accounting** — it is user-scoped database state, it appears in this inventory, and it cascades with the account.

### 27.3 What must NOT be claimed

This work adds **no scheduled worker, no cron, no autonomous server component and no server-side queue consumer**, deliberately (see [decisions-and-triggers.md](decisions-and-triggers.md) **C37**). The queue consumer is the **authenticated application session itself** — once immediately after the user's action, and once again at the next authenticated session start — which is exactly why cleanup is recoverable rather than guaranteed. Therefore:

- ❌ "every attachment binary is deleted immediately" — **false**, and it was false before this change too. A binary awaiting cleanup can remain for as long as Storage refuses.
- ❌ "cleanup is guaranteed even if the user never returns" — **false**. Nothing on the server executes a queue row. If the user never signs in again, the row simply waits.
- ❌ "an uploaded binary is always either saved or removed" — **false**. If the database cannot be reached to finalize an upload, the object stays in Storage with no metadata row and no queue row, because deleting a file whose fate is unknown is the worse error. That object is found by the account-deletion Storage sweep, like any other historical orphan.
- ❌ "one pass always clears the queue" — **false**. A drain consumes at most 20 windows of 200 rows from the head of the queue; if that bound is reached without seeing the end it reports pending work of an unknown size rather than claiming completion, and the next authenticated session takes the following windows.
- ❌ "a failed upload leaves no trace once its file is removed" — **false**, and deliberately so. One row per such upload persists in `attachment_cleanup_tombstone` for the life of the account: a Storage object key, nothing else. It is the record that keeps the removed file removed.
- ❌ "after the migration every browser gains durable cleanup" — **false**, and this is the honest limit of the rollout. A tab that loaded the pre-migration bundle cannot call functionality it does not know exists: it writes no queue row and no tombstone. What it gains is that it can no longer create a *valid* metadata row whose binary it then deletes, and can no longer delete a paper around the lifecycle either — its upload is refused with `42501`, its Storage-first attachment deletion is refused by the fence, and its raw `DELETE FROM papers` is refused with `42501` before it ever reaches its Storage call, so it cannot strip files off papers it did not delete. What it does not gain is retry: if its refused upload's own immediate `remove()` also fails, that binary stays as an untracked orphan in the owner's private namespace until the account-deletion Storage sweep finds it. The window is bounded by how long stale tabs live after the frontend deploy, and by the private per-user namespace; it is a rollout edge, not a reason to add an autonomous worker.
- ✅ "cleanup intent is recorded durably before the metadata that names the object is removed, is retried immediately and again at the next sign-in, and account deletion remains the final sweep" — **true once the migration is applied, for clients running the deployed bundle**.

Account deletion is unchanged and remains the last resort: it still enumerates **Storage itself**, recursively and paginated, and must never be rewritten to trust the queue or the tombstone as an inventory. It runs with the elevated service role, which bypasses row-level security, so the Storage delete fence added here does not constrain it — and must not, because it exists precisely to find objects no metadata row describes. The queue can never be assumed complete; historical and pre-feature orphans exist; and an object with neither a metadata row nor a queue row must still be found. §12's analysis stands exactly as written.

### 27.4 Rollout status

> **Superseded on 2026-09-10 — see [§28](#28-addendum--2026-09-10--attachment-orphan-cleanup-hardening-001-production-rollout-and-acceptance).** The paragraph below is preserved as written: at the date of this addendum it was accurate, and the rollout requirement it states is exactly what was then carried out. Read it as history, not as current status.

**The migration is NOT applied to Production as of this addendum.** Production's latest applied migration is `20260903180000`. Until `20260904120000` is applied, the deployed frontend uses the pre-migration behaviour described in §27.1 — including the browser-side upload metadata INSERT and its lost-response weakness, which is a schema-level fix and cannot be made from the client — with one honest improvement that needs no migration: a `storage.remove()` that returns `{ error }` is now recognised as a cleanup failure and reported, instead of being silently treated as success. §22.4 item 20 therefore stays open until the Production migration lands, and this document must be revised again at that point to record it.

One consequence of the privilege change is worth stating in advance of that: applying the migration makes the currently deployed Production bundle's *legacy* attachment paths stop working, because they write `paper_attachments` directly — and its **paper deletion** stop working too, because it deletes `papers` directly. That is why the frontend must be deployed first — see [deployment.md](deployment.md) §6.4 and the four-combination table in §6.4a. Applying the database half first is non-destructive but leaves users on already-loaded tabs unable to add or delete attachments until they reload.

---

## 28. Addendum — 2026-09-10 — `ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001` Production rollout and acceptance

**Scope.** This is the revision §27.4 required. It records that the change described in §27 is now applied to Production and that its user-visible behaviour was accepted there. **It introduces no new data, no new table, no new processor, no new external recipient and no new network egress** — §27's inventory of `attachment_cleanup_queue` and `attachment_cleanup_tombstone` is unchanged, and §5, §8, §9, §11, §12, §24, §25, §26 are untouched. `supabase/functions/**` is still byte-identical. §27 is preserved exactly as written.

### 28.1 Rollout

Both migrations are applied to Production, in the two authorized phases with the operator checkpoint between them: `20260904110000_prepare_merge_lock_order.sql`, a verified drain of the legacy merge body, then `20260904120000_add_recoverable_attachment_cleanup_queue.sql` behind its three-table cutover barrier. The corrected frontend had already been deployed, which is the ordering [deployment.md](deployment.md) §6.4 requires. The application happened after PR #273 merged on 2026-09-05 and was verified live before the 2026-09-10 acceptance; **the exact date is not recorded anywhere readable** — `supabase_migrations.schema_migrations` stores no applied-at timestamp, so no document should state one it cannot cite. The Production ledger now holds **80** rows with `20260904120000` latest, and every structure §27.2 describes is live: both tables, the lifecycle RPCs, `trg_paper_attachments_block_cleanup_intent`, both supporting indexes, and the `attachment_object_has_live_metadata` condition on `attachments_owner_delete`. `authenticated` holds `SELECT` only on `paper_attachments` and no longer holds `DELETE`/`TRUNCATE` on `papers`; `anon` holds none of the five on either table.

### 28.2 Acceptance, and what it was allowed to touch

A bounded wet acceptance ran on **2026-09-10** against the real Production application and the real Production Supabase project, as a **dedicated Production acceptance account that the owner had provisioned manually before the run**. The account was verified empty first, and the authenticated acceptance browser then operated **only** as that user: two disposable papers and five small PNG uploads, every one carrying a unique run marker, all created and removed through the ordinary authenticated product paths. **No other account was mutated, no pre-existing user data was mutated, and no SQL DML, service-role, admin-Storage or Auth-admin operation was used. The run created and deleted zero Auth accounts** — the acceptance account predates it and remains present. Administrative verification of Production *was* performed and was **strictly read-only**, limited to aggregate and residue checks: row, object and account counts, catalog and privilege facts, and searches for the run marker. Every result was a count or a catalog fact; no unrelated user's row content was returned.

That emptiness check, and the same check after the run, both read zero on every axis — zero papers, zero attachments, zero queue rows, zero tombstones, zero Storage objects under its prefix — and no acceptance marker remains anywhere in Production. Production-wide, attachment metadata rows and attachment Storage objects both returned to **10**, and the cleanup queue and the tombstone table are both **empty**. **A zero-valued `user_storage_usage` row for that account persists**: it is ordinary quota accounting created by the first upload (§27.2 and the quota triggers of `20260521030000`), it is already inventoried in §5, and it is not an orphan.

### 28.3 What Production confirmed, in privacy terms

- **Cleanup intent is durable, and the failure it exists for was exercised.** With Storage deletion forced to fail, the logical deletion still committed and the Storage key survived as one owner-scoped queue row — `attachment_delete` for an attachment deletion, `paper_delete` for a paper deletion — with the binary still present. Nothing was deleted on a guess.
- **The retry is the user's own authenticated session, exactly as claimed.** The next session drained the queue itself, in the order this document describes: read the queue, delete the object, then acknowledge the row. No server-side component acted: there is still no worker, no cron and no autonomous server-side queue consumer. The consumer is the authenticated application session itself, which is exactly why cleanup stays **recoverable rather than continuous or guaranteed** — a queue row is only worked when the owner signs in again, and waits indefinitely if they never do.
- **A logical deletion is not undone by a physical failure.** A deleted paper stayed deleted while only its file cleanup was retried.
- **A lost finalization response does not destroy a saved file, and leaves no permanent record.** A finalization that really committed in Production but whose response never reached the browser was reconciled by repeating the idempotent call: exactly **one** metadata row, the binary intact, no queue row and **no tombstone**.
- **The destructive doors a stale client could reach are closed by the database, not by the current bundle.** As the signed-in owner, a direct `storage.remove()` of a live attachment deleted nothing, and direct `UPDATE`/`DELETE` on `paper_attachments` and a raw `DELETE` on `papers` were each refused with `42501`.

### 28.4 What this addendum still does NOT claim

Everything §27.3 refuses is still refused, and applying the migration changed none of it. In particular: cleanup is still **not immediate and not guaranteed**, because nothing on the server executes a queue row; an upload whose fate the database never learned is still left in place rather than deleted; and account deletion remains the final sweep and must never be rewritten to trust the queue or the tombstone as an inventory.

Two further limits belong to the acceptance itself:

- ❌ "the permanent tombstone-rejection path was proven in Production" — **false, and deliberately so.** No `upload_compensation` tombstone was manufactured in Production. That branch remains proven by the migration's own verification block, the pgTAP suite and deterministic local E2E, and creating permanent synthetic state in Production to demonstrate it was explicitly out of scope.
- ❌ "Production is now free of orphaned attachment binaries" — **false.** The acceptance proved the new lifecycle's behaviour on objects it created itself. It performed **no** historical orphan hunt, and pre-feature orphans — objects no metadata row and no queue row ever described — are unaffected by this work and are still found only by the account-deletion Storage sweep.

---

## 29. Addendum — 2026-09-13 — `AI-MULTI-PROVIDER-001D` provider-usage telemetry

**Scope.** Records a new **repository capability** and keeps it apart from **deployed Production behaviour**. §8, §9, §10, §12 and §13 are preserved as written; this section amends them only where stated. Decision C42 in [decisions-and-triggers.md](decisions-and-triggers.md) is the architectural authority. **Updated 2026-09-17** to record two Production facts: the telemetry schema is applied, and the public Privacy Policy disclosure is published. At that update the generation runtime that writes telemetry was not yet deployed, so Production recorded no AI usage event. **Updated again 2026-09-17, after Phase 6:** both generation functions are deployed, and Production now writes one content-free event per AI request that reaches a provider (a failed write is logged and not retried, §29.7).

### 29.1 Repository, Production database and Production generation runtime

| | Repository `main` | Production database and public policy | Production generation runtime |
|---|---|---|---|
| Table `ai_provider_usage_events` | Defined by migration `20260913120000` | **Exists**, applied 2026-09-13. RLS enabled and forced, no policy, no privilege for `PUBLIC`/`anon`/`authenticated`, `service_role` `INSERT` only | — |
| Telemetry writes | `analyze-paper` and `suggest-paper-organization` write one event per provider call | **0 rows** before Phase 6 (03:17:59Z check); **3 events**, all from the bounded Phase 6 acceptance, at the post-Phase-6 check | **Live since 2026-09-17** — `analyze-paper` v27 and `suggest-paper-organization` v11 write one event per provider call |
| Elevated key in the generation functions | Used for that one INSERT | — | **Used for that one INSERT only** (insert-only client, built after a provider call) |
| Public Privacy Policy | Amended by PR #283 (merge `24591dfd`) | **Live, effective September 17, 2026:** AI usage records (§2), their purpose (§5), account-lifetime retention (§13), export exclusion and access on request (§15) | — |

**Class: VERIFIED.**
- **Sources:** the repository source; a read-only Production check on 2026-09-17 inside `SET TRANSACTION READ ONLY`; and a signed-out read of the live `https://app.paperlume.app/privacy`.
- **What the pre-Phase-6 Production check found (03:17:59Z):** ledger 83 rows with `20260913120000` present exactly once, the table empty, ACL `{postgres=arwdDxtm/postgres,service_role=a/postgres}`, Edge v26/v10.
- **What the post-Phase-6 read-only checks found (2026-09-17):** Edge `analyze-paper` v27 and `suggest-paper-organization` v11; exactly three events, all from the dedicated acceptance account's bounded canary; ledger, table ACL, RLS and the Google-only catalog unchanged. The Edge log lines for the canary contained no content, user or paper identifier, email, token or key.
- **The earlier snapshot this table replaces:** when this addendum was first written (2026-09-13, before the migration was applied), Production held 82 ledger rows, no telemetry-like relation in any schema, and the unamended policy.

### 29.2 What an event stores

Per user, per AI request that reached a provider — any of the three registered families, since the row records whichever provider was routed to: when it finished; the user's opaque id (server-derived from `auth.getUser()`, never from the request); the operation (`analyze` or `suggest`); the provider and **public** model name; how the model and reasoning level were chosen and which level was sent; the bounded provider outcome and, for an HTTP failure, its status code; the real number of provider attempts; whether the user received a result; the token counts the provider reported (input, cached input, cache-write input, output, reasoning output, provider total); and a list-price cost estimate with the price-record id and rates used.

### 29.3 What an event can never store

No title, abstract, keywords, study type, statistical methods, notes or other paper metadata; no Project or Tag names or ids; no paper id; no prompt; no generated TLDR, suggestion or other model output; no provider response or error body; no email, bearer token, Supabase session, provider or PubMed API key; no URL; no attachment data. This is enforced by the row type in [`_shared/aiUsageTelemetry.ts`](../supabase/functions/_shared/aiUsageTelemetry.ts) and by CHECK constraints that restrict every string column to bounded enums or identifier shapes, and it is asserted by the Vitest privacy tests and pgTAP suite `017`. **Class: VERIFIED.**

### 29.4 Recipients, access and logs

- **No new external recipient.** The data stays in PaperLume's existing Supabase project. Nothing is sent to an analytics, observability or error-tracking service, and no provider receives anything new: usage is read from the response the provider already returns.
- **No browser access.** `PUBLIC`, `anon` and `authenticated` hold no privilege on the table and it has no RLS policy, so a user cannot read their own events or anyone else's through the Data API. `service_role` holds `INSERT` only. Reading the data is an owner/operator activity.
- **Logs.** The new Edge log lines name the operation, provider, public model, outcome, attempt count and statuses. They contain no user id, no content and no database error message — only a bounded SQLSTATE code on a failed write. This extends §10.1's "no user id … is written to any application log" rather than weakening it.

### 29.5 Retention, deletion and export

- **Retention:** no period is defined and no purge exists. An event lives for the life of the account (§13 applies: "retained for the life of the account; deleted with it"). The published Privacy Policy states this in its §13.
- **Account deletion:** `user_id` cascades from `auth.users`, so a hard deletion removes every event — no pseudonymous usage trace remains. Pinned by suite `008`. Keeping telemetry beyond deletion would be an owner/privacy decision, and none has been made.
- **Export:** events are **not** in the account-export archive. They are server-written operational accounting that the client cannot read (excluded on the same ground as `usage_counters`). **Owner decision, published in the Privacy Policy (§15, effective September 17, 2026):** the records are not included in the account-data export, and, subject to applicable law, a user may contact PaperLume to request access to information about them contained in those records. Access is by request, not through the in-app export.

### 29.6 Required before this is live in Production — status (2026-09-17)

1. **Owner review of the public Privacy Policy — COMPLETE.** The 001D implementation deliberately left [`src/pages/Privacy.tsx`](../src/pages/Privacy.tsx) untouched, because it is owner-approved legal text. The facts §29.2–§29.5 describe were then disclosed in a separate, owner-approved amendment (PR #283, merge `24591dfd`), published with effective date **September 17, 2026** and verified live signed out.
2. **Migration `20260913120000` — COMPLETE:** applied to Production on 2026-09-13 ([deployment.md](deployment.md) §6.7).
3. **Deployment of the generation runtime that writes telemetry — COMPLETE (2026-09-17):** both generation functions were deployed together (Phase 6), and a bounded Production telemetry canary produced exactly three content-free events ([deployment.md](deployment.md) §6.6a, §6.7). Phase 6 activated internal usage telemetry for the existing Google AI operations; it added **no new AI recipient** — at that date no Anthropic or OpenAI catalog row or credential existed. *(That clause is scoped to Phase 6. Both paid providers were activated afterwards, under `AI-MULTI-PROVIDER-001E` — see §30's status note. What remains true is the point being made here: **the telemetry work itself added no AI recipient**; the later activation did, and it was reviewed separately.)*

### 29.7 What this addendum does NOT claim

- ❌ "Phase 6 added an AI recipient" — **false**, and still false. It activated internal usage telemetry for the existing Google operations, and the records stay in PaperLume's Supabase project. *(The original clause continued "… and no request can be routed to Anthropic or OpenAI", which was true on 2026-09-17 but is **not** a current statement: paid-provider routing was activated afterwards by `AI-MULTI-PROVIDER-001E`, §30. The denial above is about what **Phase 6** did, not about what is reachable today.)*
- ❌ "every AI request is guaranteed a record" — **false.** A telemetry write that fails is logged (`usage_telemetry recorded=0`) and not retried, and it never fails or alters the user's response.
- ❌ "the cost estimate is what PaperLume is charged" — **false.** It is a list-price estimate; the Google project is on the Gemini Free Tier (C29).
- ❌ "telemetry covers requests that never reached a provider" — **false.** Refusals before a provider call record nothing.


---

## 30. Addendum — paid-provider activation review (AI-MULTI-PROVIDER-001E, 2026-09-17)

> **SUPERSEDED ON THE STATUS LINE ONLY — updated 2026-09-19.** The review below was written on 2026-09-17 as repository preparation, and its analysis, findings and caveats stand unchanged. What has changed is the deployment state it describes:
>
> - Both credentials were installed and the Phase-7 canaries ran on 2026-09-18: Analyze and Suggest against Claude Sonnet 5 and GPT-5.6 Terra, on a dedicated acceptance account's synthetic paper. **Real requests have therefore been sent to Anthropic and OpenAI.**
> - `20260918210017` was applied on **2026-09-19**, so both rows are now `enabled AND selectable` and the two models are offered to **entitled** users. Selection is still entitlement-gated; a non-entitled account resolves to the Google system default.
> - **The research-content data flow is unchanged from what §30.2 and §30.3 verified**: the same allow-listed payload boundary, the same operations, the same content. What changed is that a user may now direct that already-disclosed flow to a different recipient.
> - **No new public Privacy Policy amendment was required for Phase 8.** The September 18 wording is provider-conditional by design (§30.7) and remains accurate; `src/pages/Privacy.tsx` is unchanged.
> - **Manual reasoning is live in Production since 2026-09-19**: `AI-MANUAL-REASONING-001` (C45) applied `20260919075655`, setting `reasoning_selectable = true` on all six catalog rows and granting `set_current_user_ai_reasoning` to `authenticated` only. An entitled user who has pinned a model may now choose a level, and doing so writes the **already-existing** `user_ai_preferences.preferred_reasoning_level` column — already declared, already exported in account export v3, already cascade-deleted. It introduced **no new public data category**, no new research-content field reaching any provider, and therefore **no new public Privacy Policy amendment** — see the addendum below.
>
> Nothing below is weakened by this note. The caveats on **Supabase platform logging**, **Vercel access logging**, **Anthropic/OpenAI retention terms**, **attachment handling** and the **narrow scope of the Edge-log hardening** (§10.1) all stand exactly as written, and none of them became repository-verified because activation happened.

**Status at the time of writing (2026-09-17): REPOSITORY PREPARATION. No paid provider was reachable, and no request had been sent to Anthropic or OpenAI.**

This section is the privacy review that must precede real paid-provider traffic. It was written against the **current source**, not against the prospective description in §8, and it re-verifies the payload boundary rather than assuming it.

### 30.1 What changes, and what does not

`AI-MULTI-PROVIDER-001E` adds one migration staging two `ai_model_catalog` rows — `anthropic/claude-sonnet-5` and `openai/gpt-5.6-terra` — as `enabled = true, selectable = false`, plus list-price records for both models. It adds **no new data category, no new field, and no change to any request builder.**

Three states, kept apart:

- **Repository capability:** both adapters exist, are registered, are priced, and now have a staging migration.
- **Runtime capability *at the time of writing*:** both adapters are in the **deployed** generation bundles (Phase 6, 2026-09-17). They were unreachable for two independent reasons: no `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` existed on any server, and neither staged row was `selectable`, so `set_current_user_ai_model` refused it for every caller. **Both reasons have since been removed** — credentials installed 2026-09-18, `selectable` set by `20260918210017` on 2026-09-19 (status note above).
- **Production data flow *at the time of writing*:** unchanged, with Google the only AI recipient; the staging migration was not auto-applied and Production's catalog held four Google rows. **Superseded** — per the deployment record the catalog now holds six rows, and the recipient is the provider of the **effective model the server resolves for each request** (§8): an entitled user's honoured preference, or Google on any fallback.

### 30.2 Verified payload boundary — Analyze

Verified in [`analyze-paper/prompt.ts`](../supabase/functions/analyze-paper/prompt.ts). The operation builds a **provider-neutral** `AiGenerationRequest`, so the payload is identical whichever provider is selected — there is no per-provider branch that could add a field.

`userContent` is exactly `` `Title: ${title || "Unknown"}\n\nAbstract: ${abstract}` ``, plus the fixed `ANALYZE_SYSTEM_INSTRUCTION`.

| | Value |
|---|---|
| **Provider receives** | the paper's title; the paper's abstract; a fixed system instruction |
| **Provider does NOT receive** | email; Supabase user id; paper id; PMID or DOI (unless the user embedded one in the title or abstract); authors; journal; notes; attachments; Projects; Tags; keywords; plan or quota metadata; any other paper; any token |

### 30.3 Verified payload boundary — Suggest

Verified in [`suggest-paper-organization/prompt.ts`](../supabase/functions/suggest-paper-organization/prompt.ts). The payload is an allow-list built field by field, then `JSON.stringify`-ed — nothing is spread from a database row.

| | Value |
|---|---|
| **Provider receives** | paper title; abstract (omitted when empty); keywords (omitted when empty); study type (omitted when empty); **all** Project names; Project descriptions where present; **all** Tag names; each Project/Tag's `alreadySelected` flag, carried on an **ephemeral ref** (`P1`, `T1`, …) |
| **Provider does NOT receive** | database ids; email; Supabase user id; plan; quota state; attachments; notes; unrelated papers |

The ref indirection is the mechanism, not a convention: real Project and Tag UUIDs stay in a server-side `refMap` and are never serialized. A provider sees `P1`, not a row id.

### 30.4 Per-provider processing terms (first-party, read 2026-09-17)

| | Anthropic (Claude API) | OpenAI (API) |
|---|---|---|
| Product | Commercial API, **not** a consumer product | OpenAI **API**, **not** consumer ChatGPT |
| Training on customer content | **Not used by default.** Anthropic states it will not, by default, use inputs or outputs from its commercial products (Claude for Work, Anthropic API, …) to train its models, and does so only on explicit feedback/opt-in. PaperLume submits no feedback | **Not used to train by default**; requires an explicit org opt-in. PaperLume publishes only this provider-level default — it makes **no account-specific opt-in claim**, because no direct evidence of the organization setting has been verified |
| Statelessness | One stateless Messages request; no `metadata`, no `user_id` | One stateless Responses request; adapter sets **`store: false`**; no `metadata`, `safety_identifier`, `user`, `conversation` or `previous_response_id` |
| Retention | API inputs/outputs automatically deleted within **30 days** — **not an absolute ceiling.** Published exceptions: a customer-controlled longer-retention feature (e.g. Files API); a separately agreed arrangement; Usage Policy enforcement, under which flagged content may be kept **up to 2 years** (trust-and-safety classification scores longer); retention required by law; and, where the contract permits, anonymized org data kept longer for research/statistical purposes | Abuse-monitoring logs **may contain customer content** (prompts, responses, derived metadata), normally retained **up to 30 days**, and longer where **required by law OR reasonably necessary to protect OpenAI's services or any third party from harm** |
| Zero retention | **Not claimed, and not denied.** The 30-day practice has exceptions and is **not** a guarantee. No zero-retention arrangement has been verified for this rollout — and the absence of an `ANTHROPIC_API_KEY` is evidence about credentials, not about what agreements exist — so the policy asserts neither direction | **Not claimed, and not denied.** OpenAI documents **two** approved controls that exclude customer content from abuse logs — **Modified Abuse Monitoring** and **Zero Data Retention** — both requiring prior approval, eligibility and additional requirements. Neither has been verified for this rollout, so the policy claims neither and tells the reader to assume ordinary abuse-monitoring retention applies |
| Prompt caching | PaperLume sends no `cache_control`; caching is opt-in | GPT-5.6 and later cache implicitly; PaperLume requests none |

`store: false` is **not** a blanket zero-retention promise, and the published Privacy Policy says so explicitly. It governs response-object persistence, not abuse monitoring. The sharpest way to see the difference: **ZDR itself forces `store` to `false` server-side** on `/v1/responses` and `/v1/chat/completions` regardless of what the request asks for — so sending `store: false` is a strict subset of what ZDR does, never equivalent to it. Conflating the two would be the most likely material misstatement in this area, which is why tests pin it.

### 30.5 Findings

- ✅ **No new data category.** Both paid providers receive exactly the fields Google already receives.
- ✅ **No user-identifying metadata** reaches any provider on any path.
- ✅ **No attachment** is sent to any AI provider, and the policy does not imply otherwise.
- ✅ **The provider is a function of the selected model**, which the policy now states plainly. *(Precision added later, not a change to this finding: the provider follows the **effective routed model** the server resolves — a saved selection that fails any server-side check routes to the Google system default instead. See the §8 current-state box.)*
- ⚠️ **New recipients.** Anthropic and OpenAI become recipients of research content the moment a paid model is actually routed. That is a new transfer, disclosed in the amended Privacy Policy §6, and it is why the amendment must be published **before** the first paid request.
- ⚠️ **Retention differs by provider**, and none of the three offers zero retention to PaperLume today.

### 30.6 Required before paid traffic is live — the gate as written on 2026-09-17, and what the record says happened

> **This list is satisfied, per the deployment record.** It is kept because it states the *order* activation had to follow, which is the durable part. The statuses below are the recorded outcome, not a live check performed while writing this reconciliation.

1. **Owner approval of the exact Privacy Policy wording** — the Draft PR is the review surface. ~~**PENDING.**~~ **Recorded complete:** the amendment was owner-approved and published with effective date September 18, 2026.
2. **Publication of the amendment** with a correct effective date (§30.7). **Recorded complete**, and §30.7's stale-date gate did not fire.
3. Apply the staging migration; install both credentials; deploy from the accepted merge; run bounded canaries. **Recorded complete:** `20260917201856` applied and both credentials installed 2026-09-18; Phase-7 canaries passed on both providers; `20260918210017` applied 2026-09-19.

Phase 8 needed **no further policy amendment** — the published wording is provider-conditional by design (§30.7).

### 30.7 Effective-date handling

The policy's displayed effective date is **September 18, 2026**, advanced from the original September 17 drafting date during the 001A privacy correction. It is pinned by `EFFECTIVE_DATE` in `src/pages/__tests__/Privacy.test.tsx`.

The September 17 date attached to the **earlier** 001D telemetry amendment (PR #283) is historical and unchanged; only this pending amendment's date moved.

**If this amendment is not published on September 18, 2026, the displayed date is false on publication** and must be advanced again, in both the page and the test, before merge. The merge gate must treat the date as stale rather than assume it. *(Outcome, per the deployment record: the amendment was published on September 18, 2026, so no further advance was needed and `src/pages/Privacy.tsx` is unchanged by any later step. The rule above is retained because it applies to every future amendment.)*

### 30.8 What this addendum does NOT claim

- ⚠️ "Anthropic or OpenAI is a live recipient" — **this refusal has been OVERTAKEN and must not be quoted as current.** It was correct on 2026-09-17 (no credential, no selectable row, no request). Per the deployment record, both credentials were installed and canaried on 2026-09-18 and both rows made `selectable` on 2026-09-19, so **Anthropic and OpenAI are recipients of research content whenever the effective routed model for a request is one of theirs** — which is what an entitled user's honoured saved preference produces, and is exactly the transfer §30.5 flagged as requiring prior disclosure. It is not automatic on selection: a preference the resolver cannot honour routes to Google instead (§8). See the status note at the head of §30 and the current-state box in §8. **Every other refusal in this list still stands**; they concern provider retention and training claims, which activation did not establish.
- ❌ "PaperLume has zero data retention with either provider" — **not claimed.** The policy asserts no such arrangement with Anthropic, and neither OpenAI MAM nor ZDR. It also does **not** assert the opposite: no account-level evidence about either provider's arrangements was verified, so the policy states only that it makes no such claim and that ordinary retention should be assumed.
- ❌ "Anthropic deletes everything after 30 days" — **false.** 30 days is the ordinary practice; Usage Policy enforcement can retain flagged content for up to 2 years, and legal, customer-controlled, separately-agreed and contract-permitted anonymized retention are all documented exceptions.
- ❌ "ZDR is the only way to keep content out of OpenAI's abuse logs" — **false.** Modified Abuse Monitoring does the same for the logs; ZDR adds forced `store: false`.
- ❌ "PaperLume's OpenAI organization has not opted in to data sharing" — **not established.** The policy states OpenAI's default only. No account-level evidence was verified, so no account-specific claim is published.
- ❌ "`store: false` means OpenAI retains nothing" — **false.** Abuse-monitoring retention may still apply.
- ❌ "the paid providers share Google's Free-tier terms" — **false.** The Free-tier data-use and geographic warnings describe Google only.
- ❌ "this review approves activation" — **false.** It is a prerequisite for it.

## 31. Addendum — 2026-09-24 — `SEC-AI-QUOTA-REFUND-AUTHORITY-001` server-only AI-quota refund

> **Status (updated 2026-09-25): LIVE in Production.** Migration `20260924193915` was applied and both generation functions were redeployed on 2026-09-25 ([deployment.md](deployment.md) §6.8), so §31.1's Production columns now match the repository column. The 2026-09-24 pre-rollout values are kept there, labelled *Before*.

**Scope.** Records a change to who may write the AI usage counters. It was written on 2026-09-24 as a **repository** change, kept apart from **deployed Production behaviour**, which the 2026-09-25 rollout has since brought into line. §4 (the "AI usage counters" row), §8 (the two "Quota" rows) and §14 (the elevated-key row, which already predates §29's telemetry writer) are preserved as written; this section amends them only where stated. Decision C47 in [decisions-and-triggers.md](decisions-and-triggers.md) is the architectural authority.

### 31.1 Repository and Production

| | Repository (this change) | Production database | Production generation runtime |
|---|---|---|---|
| `refund_ai_quota` EXECUTE | Owner + `service_role` only (migration `20260924193915`) | Owner + `service_role` only — `20260924193915` applied 2026-09-25; `authenticated`, `anon` and PUBLIC cannot execute it. *Before: owner + `authenticated`, verified 2026-09-24.* | — |
| Who calls the refund | `analyze-paper` and `suggest-paper-organization`, through a dedicated server-only client with no caller Authorization header | — | Both refund through the dedicated server-only client (`analyze-paper` v33, `suggest-paper-organization` v16, deployed 2026-09-25). *Before: the caller-scoped client, in v32 and v15.* |
| Elevated key in the generation functions | Two narrow uses: the telemetry INSERT (§29) and the refund RPC | — | The same two narrow uses, each through its own client: the telemetry INSERT (§29) and the refund RPC. *Before: the telemetry INSERT only.* |
| `consume_ai_quota` | Unchanged: caller-authenticated, `authenticated` only | Unchanged | Unchanged |

**Class: VERIFIED** for the repository column (source, migration and tests) and for the Production columns. The current values come from read-only queries inside `SET TRANSACTION READ ONLY` and Edge version and bundle-hash read-backs on 2026-09-25; the independent Production verification also read back both deployed bundles. The *Before* values were verified on 2026-09-24 the same way, plus a byte comparison of the then-deployed Edge sources with `main` `f06107b6`.

### 31.2 What changes for personal data — nothing new is collected

- **Same data, same table, same retention.** `usage_counters` still holds only a feature name, a period and an integer count per user; it is still cascade-deleted with the account and still excluded from the account export. No new field, row type, table, log line with an identifier, or recipient is introduced.
- **Narrower write authority.** Before this change a signed-in browser could decrement its own counter at will through `refund_ai_quota`; afterwards only PaperLume's server can, and only for the user id the server itself authenticated. That makes the counters a more faithful record of actual AI use, not a less private one.
- **The elevated key stays server-side.** The new refund client is built inside the Edge runtime from the platform-injected secret, is typed to one RPC, carries no caller token, and never returns or logs the key or the user id. The browser bundle is unchanged (`src/` still has no elevated-key reference).
- **No Privacy Policy change is needed.** The published policy already describes AI usage counting for quota enforcement; who within PaperLume's own backend may adjust that count is not a disclosure category. This addendum makes no statement about the policy's wording beyond that.

### 31.3 What this addendum does NOT claim

- ❌ "The rollout was proven by a live refund" — **not claimed.** No AI-provider request and no quota consume or refund canary was run; enforcement is established by the live ACL and function body and by the deployed bundles.
- ❌ "Every refund is now guaranteed" — **not claimed.** The refund stays best-effort: a failure is logged and the original response is unchanged.
- ❌ "Any account abused the old refund path" — **not established.** The defect was reproduced only on a disposable local replay; no Production counter was inspected per user or modified by this work.

## 32. Addendum — 2026-09-25 — `DB-JUNCTION-DML-GRANT-HARDENING-001` assignment junctions become SELECT-only

> **Status (updated 2026-09-26): LIVE in Production.** Migration `20260925134526_harden_junction_dml_grants.sql` was applied on 2026-09-25 in a migration-only rollout ([deployment.md](deployment.md) §6.9), so §32.1's repository and Production columns now agree. The pre-rollout Production value is kept there, labelled *Before*. Decision C48 in [decisions-and-triggers.md](decisions-and-triggers.md) is the architectural authority.

**Scope.** A privilege reduction on two relationship tables, `paper_projects` and `paper_tags`, which record only which of a user's own papers is filed under which of their own Projects and Tags (two UUIDs per row). The browser loses the ability to insert or delete those rows directly; it keeps the ability to read its own. Assignment continues through the existing SECURITY DEFINER RPCs. §4's rows for these tables are unchanged by this addendum except where stated here.

### 32.1 Repository and Production

| | Repository (this change) | Production |
|---|---|---|
| `paper_projects` / `paper_tags`, `authenticated` | `SELECT` only | `SELECT` only — `20260925134526` applied 2026-09-25. *Before: `SELECT, INSERT, DELETE`, verified read-only 2026-09-25.* |
| `projects` / `tags`, `authenticated` | `SELECT, INSERT, UPDATE, DELETE` — unchanged | Same — unchanged by the rollout |
| How a paper is assigned to a Project/Tag | RPC-mediated: `set_paper_*`, `bulk_set_paper_*`, `bulk_add_paper_*`, `merge_exact_duplicates` | Same — the browser already used only these |

### 32.2 What changes for personal data — nothing

- **No new data category, field or table**, and no new row is written by the migration (its verification block proves that from the transaction's own statistics).
- **No new recipient and no new processor.** The change is inside PaperLume's own database grants; nothing is sent anywhere new.
- **No retention change.** Junction rows are still removed by cascade when their paper, Project, Tag or account is deleted, exactly as before (§12.3); a referential cascade runs as the table owner and never depended on the browser's DELETE grant.
- **No export change.** The full account export and CSV/BibTeX export still read the junctions with `SELECT`, which is kept.
- **No Privacy Policy change is needed.** Who within PaperLume may write an assignment row is not a disclosure category, and the product behaviour users see is unchanged.
- **Projects and Tags can still be created** — by hand or through AI "Create & select", which writes the Project/Tag itself and leaves the assignment to Save. Only the browser's *direct* junction-write authority is removed.

### 32.3 What this addendum does NOT claim

- ❌ "This fixes a cross-account write" — **not claimed.** The direct junction write path C48 removed had been guarded by both-owner RLS since 2026-08-02. An earlier schema **did** permit cross-owner junction insertion (a user could link their own paper to another user's Project or Tag); that defect was separately remediated by `20260802025704` (PFA-C03B1, [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md) §9.6). C48 is a later least-privilege follow-up, not that remediation. It claims no new incident, and no historical abuse: whether the pre-2026-08-02 defect was ever exercised by a real account is not established.
- ❌ "The live product was canaried after the change" — **not claimed.** The rollout is established by the live ACL/catalog state and the tracked migration; no live user-data or AI canary was performed (no AI suggestion, no Project/Tag creation, no paper assignment).

## 33. Addendum — 2026-09-26 — `DB-INVOKER-EXECUTE-HARDENING-001A` caller-scoped read RPCs become SECURITY INVOKER

> **Status (updated 2026-09-26): LIVE in Production.** Migration `20260926152414_harden_read_rpcs_security_invoker.sql` was applied on 2026-09-26 in a migration-only rollout ([deployment.md](deployment.md) §6.10), so in Production the five functions below now run as SECURITY INVOKER, verified read-only after the apply. This addendum was first written while the migration was prepared but not yet applied; its privacy conclusions were unaffected by the rollout. Decision C49 in [decisions-and-triggers.md](decisions-and-triggers.md) is the architectural authority.

**Scope.** An **authority reduction only**, inside PaperLume's own database. Five read functions stop running with their owner's (RLS-bypassing) authority and run as the signed-in caller, so the caller's own table grants and row-level security bound what they can read: `search_papers`, `search_papers_short`, `filter_papers_by_keywords`, `get_keyword_options` and `get_duplicate_papers`. They read the caller's own papers (and, for keyword filtering, the caller's own synonym groups) and return the same results as before. §4's rows for `papers` and `synonym_pool` are unchanged by this addendum.

### 33.1 Repository and Production

| | Repository (this change) | Production |
|---|---|---|
| Security mode of the five read RPCs | SECURITY INVOKER | SECURITY INVOKER — `20260926152414` applied 2026-09-26. *Before: SECURITY DEFINER, verified read-only 2026-09-26.* |
| Who may call them | `authenticated` only (unchanged) | Same |
| What they return to a signed-in user | Only that user's own rows (RLS + the unchanged identity guards) | Same. *Before the rollout: only that user's own rows, bounded by the identity guards alone.* |

### 33.2 What changes for personal data — nothing

- **No data-category change.** No new field, table or kind of personal data; the migration writes no row (its verification block proves it from the transaction's own statistics).
- **No recipient change.** Nothing is sent anywhere new, and no new party can read anything. The change only narrows the authority these functions run with.
- **No retention change.** Nothing is kept longer or shorter. Deletion and account-deletion cascades are untouched.
- **No processor change.** No new sub-processor, and no change to what any existing processor receives. No Edge Function or AI-provider path is involved.
- **No Privacy Policy amendment.** The security mode of an internal database function is not a disclosure category, and what users see is unchanged.

### 33.3 What this addendum does NOT claim

- ❌ "This fixes a cross-account read" — **not claimed.** Since `20260518010000` each of these functions has refused, or scoped away, any request for another user's data through its own `auth.uid()` logic, and that logic is kept. C49 adds row-level security as the primary layer beneath it; it answers no known incident.
- ❌ "The live product was canaried after the change" — **not claimed.** When this addendum was written the change was not yet live. It was subsequently rolled out on 2026-09-26 and verified read-only against the live catalog ([deployment.md](deployment.md) §6.10), but no search, filter or duplicate-detection canary was run on live user data.
