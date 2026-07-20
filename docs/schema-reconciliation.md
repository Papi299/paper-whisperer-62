# Schema Reconciliation — Drift Inventory, Canonical Decisions, and Roadmap

> **Authority.** This document is the single source of truth for the production-versus-migrations schema drift found by the 2026-07-18 read-only audit, the owner-approved canonical end state (C20–C25), and the ordered implementation sequence. Implementation PRs must reference and follow it.

## 1. Purpose and scope

The production database predates the first committed migration: the repository was scaffolded by Lovable against an already-populated project, and the February 2026 migrations reconstruct tables that already existed remotely with different shapes. As a result:

- The migration **ledger matches exactly** — all 60 committed versions are recorded as applied both locally and remotely.
- A **clean local replay of those 60 migrations nevertheless produces a schema that materially differs from production**, because `CREATE TABLE` statements in the early migrations never executed against the live database.
- **Ledger parity is therefore necessary but not sufficient.** Schema reconciliation is complete only when structural parity is also established (see §6).

This document records durable conclusions only. Raw audit evidence (schema dumps, diffs, generated-type snapshots, aggregate query results) was produced transiently during the audit and is not stored in the repository. **No raw production data and no secrets may ever be added to this document or the repository.**

## 2. Evidence baseline

- **Audit date:** 2026-07-18 (task SCHEMA-RECONCILIATION-001A, read-only).
- **Repository baseline:** `main @ f8f01f39c2c40bdafe99f17560c491d487ae0342`.
- **Supabase CLI:** 2.108.0; local stack via Docker.
- **Local replay:** all 60 migrations applied cleanly to a fresh local database; no repair, no skip.
- **Local type generation:** run twice, byte-identical (deterministic).
- **Remote evidence (all read-only):** schema-only linked dump, linked schema diff (stdout only), linked type generation, linked migration list, and aggregate-only `SELECT` data checks (row counts, null counts, `jsonb_typeof` categories). **No remote mutation of any kind occurred during the audit.**

## 3. Drift inventory

### Integrity-significant

- **Owner-column nullability:** `user_id` is nullable in production on eight owner-scoped tables (`papers`, `projects`, `tags`, `keyword_pool`, `keyword_exclusion_pool`, `study_type_pool`, `study_type_exclusion_pool`, `synonym_pool`) but NOT NULL in the migration-defined schema. All eight tables currently contain **zero** NULL `user_id` rows. Risk is latent: a future NULL-owner row would be invisible to every RLS policy.
- **Pool-field nullability:** `synonym_pool.canonical_term` and `synonym_pool.synonyms` (nullable remotely, zero nulls in data); `study_type_pool.hierarchy_rank` and `study_type_pool.specificity_weight` (nullable remotely, zero nulls in data).
- **`synonym_pool.synonyms` default:** production has **no default** on `synonym_pool.synonyms`, while clean replay defines `DEFAULT '{}'::text[]` (since `20260203133100`). Discovered 2026-07-19 during the `RECON-INTEGRITY-001` read-only preflight — not recorded by the original audit. Type-affecting under C25 (generated Insert optionality). Resolved inside `RECON-INTEGRITY-001` per the amended C23 below.

### Compatibility drift

- **`papers.statistical_methods`:** `text` locally vs. **`jsonb DEFAULT '[]'`** in production. Production values are mixed: SQL NULLs, JSON `null`s, JSON strings, and JSON arrays. The UI already handles string-or-array defensively; the analyze flow writes strings.
- **Junction-table model:** production `paper_projects` / `paper_tags` use **composite primary keys** (`(paper_id, project_id)` / `(paper_id, tag_id)`) with no `id` or `created_at`; the migration-defined schema uses surrogate UUID `id` + UNIQUE pair + extra indexes. All consumers (application and the four assignment RPCs) use only the pair columns.
- **Production-only legacy columns:** `papers.urls` (all rows empty `[]`), `synonym_pool.primary_term` (all NULL), `synonym_pool.variants` (all empty `[]`). No application, RPC, policy, migration, or Edge Function references any of them.
- **`projects.updated_at`:** exists locally (column + trigger); absent in production. No code reads or writes it; the hand-written domain type declares it (a latent inaccuracy). *(Resolved by RECON-METADATA-PARITY-001 / C26 — dropped locally; `Project` domain type corrected.)*
- **Seven redundant single-column btree indexes** (`idx_papers_doi`, `idx_papers_pmid`, `idx_papers_user_id`, `idx_papers_year`, `idx_projects_user_id`, `idx_synonym_pool_user_id`, `idx_tags_user_id`): present locally, **absent in production**. Confirmed 2026-07-19 during the `RECON-METADATA-PARITY-001` re-audit — not in the original inventory. Each is superseded by a production covering composite/unique index leading with `user_id` (or, for `doi`/`pmid`/`year`, by user-scoped access with no bare-column query contract). Performance-affecting only, not type-affecting. *(Resolved by RECON-METADATA-PARITY-001 / C26 — dropped locally to match production.)*
- **`study_type_pool.created_at` nullability:** NULLABLE locally, **NOT NULL in production** (both environments zero NULLs; no write sets `created_at`). Confirmed 2026-07-19 during the `RECON-METADATA-PARITY-001` re-audit — not in the original inventory. Type-affecting (Row optionality). *(Resolved by RECON-METADATA-PARITY-001 / C26 — local enforced NOT NULL to match production.)*
- **Junction RPC bodies:** the four assignment RPCs (`set_paper_projects`, `set_paper_tags`, `bulk_set_paper_projects`, `bulk_set_paper_tags`) differ textually because their bodies follow the junction shape.

### Cosmetic / semantically equivalent

- Duplicate `updated_at` trigger on `papers` locally (`trg_papers_updated_at` + `update_papers_updated_at`) vs. one in production — same resulting value. *(Resolved by RECON-METADATA-PARITY-001 / C26 — the redundant `update_papers_updated_at` dropped locally; `trg_papers_updated_at` retained as canonical.)*
- `created_at` defaults: `now()` locally vs. `timezone('utc', now())` remotely on eight tables (`keyword_exclusion_pool`, `keyword_pool`, `papers`, `projects`, `study_type_exclusion_pool`, `study_type_pool`, `synonym_pool`, `tags`); identical instants for `timestamptz` under the UTC session TZ. *(Resolved by RECON-METADATA-PARITY-001 / C26 — canonical `now()`; production converges on C24 apply. This is the only item that changes production values, and it changes no stored row.)*
- `tags.color` default: `'#8b5cf6'` locally vs. `'#e2e8f0'` in production. The original audit recorded this imprecisely ("default exists only remotely; the app always supplies a color"); the 2026-07-19 re-audit corrected it — clean replay has `'#8b5cf6'`, and `createTag` inserts `{user_id, name}` only, so the DB default **is** used. *(Resolved by RECON-METADATA-PARITY-001 / C26 — canonical `'#e2e8f0'` = production's value; no stored row changes.)*
- `search_vector` is a stored generated column on **both** sides; the generation expression uses immutable wrapper functions locally vs. inline `to_tsvector` calls remotely — **proven semantically equal** (2026-07-19: a 10-row NULL/empty/punctuation/case/unicode/stopword/number/nested-jsonb corpus yields byte-identical `tsvector`). *(RECON-METADATA-PARITY-001 / C26 — approved benign textual difference under §6; deliberately NOT changed, avoiding a table rewrite.)*
- The schema-diff engine also reports the standard Supabase default table grants (an artifact of the shadow database; overlaps the pre-existing anon-grant-hygiene backlog item, not new drift). *(RECON-METADATA-PARITY-001 / C26 — effective privileges re-compared local vs. linked and found consistent with the RLS-forced model; classified an artifact, no grant changed.)*

### Confirmed in parity (no drift)

RLS enablement, FORCE RLS, and **every policy**; all SECURITY DEFINER search/quota/dedup/bulk-insert RPCs; the five commercial tables (`user_entitlements`, `subscriptions`, `subscription_events`, `usage_counters`, `usage_credits`); `user_storage_usage` and both storage-quota triggers; `paper_attachments`; `filter_presets`; `profiles`. **The security and commercial-enforcement layer is not drifted.**

## 4. Canonical decisions (owner-approved)

- **C20 — `papers.statistical_methods`.** Canonical database type: **`jsonb`**. Canonical stored-value invariant: SQL `NULL`, or a JSON string containing the application-facing text. Transitional production values must be normalized in a later migration: JSON `null` → SQL `NULL`; JSON array → comma-joined JSON string. Objects, numbers, and booleans are unsupported. The domain representation stays `string | null`. After normalization, a database constraint must prevent reintroduction of mixed JSON categories.
- **C21 — legacy columns.** After repeating the aggregate emptiness checks immediately before deployment, **drop** `papers.urls`, `synonym_pool.primary_term`, `synonym_pool.variants`. They hold no meaningful data and nothing depends on them; retaining them perpetuates drift.
- **C22 — junction model.** Canonical: **composite primary keys** — `paper_tags (paper_id, tag_id)`, `paper_projects (paper_id, project_id)`. No surrogate UUIDs; no unused `created_at`. Retain/add reverse-lookup indexes where justified. Generated and domain types updated accordingly. RLS ownership behavior and the four atomic assignment RPCs are preserved.
- **C23 — ownership and pool integrity** *(amended 2026-07-19)*. After migration-time preflight proves zero conflicting rows, enforce **NOT NULL** on: `user_id` for the eight drifted owner-scoped tables, `synonym_pool.canonical_term`, `synonym_pool.synonyms`, `study_type_pool.hierarchy_rank`, `study_type_pool.specificity_weight`. **Amendment (owner-approved 2026-07-19):** `RECON-INTEGRITY-001` additionally converges `synonym_pool.synonyms` to its canonical `DEFAULT '{}'::text[]`, which production lacks (see the drift inventory above). This is a no-data metadata convergence — it changes no stored value — and it aligns the generated Insert optionality of `synonyms` between environments under C25. **No other default is in C23 scope.** The migration must fail safely if preconditions are not met; it must never silently delete or invent data.
- **C24 — deployment and ledger rule.** **Every new reconciliation migration is applied both to a clean local replay and to the linked remote project** via the runbook in [deployment.md](deployment.md) — even when it is structurally a no-op against production. A merged-but-unapplied migration would immediately destroy ledger parity; reconciliation requires schema parity **and** ledger parity.
- **C25 — TypeScript and CI ordering.** Generated Supabase types are **not** regenerated or committed until every type-affecting schema difference (table shape, database type, column existence, nullability, RPC signatures, insert/update optionality) is reconciled and exact parity is verified. Order: schema reconciliation → parity verification → generated types → remaining TypeScript repairs + truthful `npm run typecheck` → GitHub Actions `Validate` workflow → branch protection.
- **C26 — remaining metadata and index parity** *(owner-approved via the RECON-METADATA-PARITY-001 task rules §7; implemented 2026-07-19)*. The final reconciliation migration converges both a clean local replay (S1) and current production (S2) to one canonical end state, validated twice (pre-lock and under ACCESS EXCLUSIVE) with full preservation proofs and rolled back on any failure:
  - **`projects.updated_at`** — canonical **absent** (column + `update_projects_updated_at` trigger). No consumer reads/writes it; the hand-written `Project` domain type is corrected. Production is already canonical (structural no-op there).
  - **Duplicate `papers` updated-at trigger** — canonical is exactly one trigger, **`trg_papers_updated_at`** (`EXECUTE FUNCTION set_updated_at()`, production's proven behavior); the redundant `update_papers_updated_at` is dropped. Both trigger functions set `NEW.updated_at = now()`.
  - **`created_at` defaults** — canonical **`now()`** on the eight drifted tables (`now()` produces `timestamptz` directly; `timezone('utc', now())` adds an unnecessary tz round-trip). Production converges on C24 apply; no stored row changes; identical instants under the UTC session TZ.
  - **`study_type_pool.created_at`** — canonical **NOT NULL** (both environments zero NULLs; no write supplies NULL), enforced with a zero-NULL preflight rechecked under lock and no backfill.
  - **`tags.color` default** — canonical **`'#e2e8f0'`** (production's value; `createTag` relies on the DB default). No stored row changes.
  - **Seven redundant single-column indexes** — canonical **absent**; each is superseded by a production covering composite/unique index (or unsupported by any bare-column query contract). Constraint-backed and covering indexes are never dropped.
  - **`papers.search_vector`** — approved **benign textual difference** (semantically-equal generation expressions, proven by corpus); NOT changed, avoiding a table rewrite.
  - **SEC-4 default table grants** — **artifact** (effective privileges consistent with the RLS-forced model); no grant changed. `anon`/`authenticated` access is never widened to silence a diff.

### Rejected interpretations (recorded to prevent recurrence)

1. ~~"A migration that only changes local replay does not need remote deployment."~~ **Wrong.** Every new migration must be applied remotely so its version is recorded by a successful remote application, even when the DDL is idempotent or a no-op against production (C24).
2. ~~"Type generation can resume after the first structural reconciliation while nullability and legacy-column drift remain."~~ **Wrong.** Generated types stay divergent while any type-affecting difference remains; generation resumes only after full type-affecting parity (C25).

## 5. Reconciliation roadmap

Rules for **every** migration task below: the migration must replay from a clean local database; it must be safe against the current production starting state; it must be applied remotely after merge (C24); it must preserve ledger parity; remote data changes require explicit preflight and post-deploy verification; **no historical migration file is edited.**

1. **RECON-JUNCTIONS-001** — composite primary keys, reverse indexes, the four junction RPCs, and domain-type alignment; applied locally and remotely. **✓ Complete (PR #152, applied & verified).**
2. **RECON-STATISTICAL-METHODS-001** — reconcile the column type to `jsonb`; normalize JSON `null`s and arrays per C20; enforce the supported JSON-category invariant via constraint; update the application boundary mapping and tests where required. **✓ Complete (PR #153, applied & verified).**
3. **RECON-INTEGRITY-001** — NOT NULL enforcement per amended C23 with migration-time zero-null guards, plus restoration of the canonical `synonym_pool.synonyms` empty-array default. **✓ Complete (PR #154, applied & verified).**
4. **RECON-LEGACY-COLUMNS-001** — repeat aggregate emptiness checks, then drop the three legacy columns per C21. **✓ Complete (PR #155, applied & verified; aligned ledger 64, last `20260719060025`).**
5. **RECON-METADATA-PARITY-001** — `projects.updated_at`, duplicate-trigger cleanup, `created_at`/`tags.color` defaults, `study_type_pool.created_at` NOT NULL, seven redundant indexes, and the approved `search_vector`/SEC-4 exclusions per C26; ends with exact diff/type parity verification. **✓ Complete — PR #156 merged (merge `4f26c85d`), migration `20260719162013_reconcile_metadata_parity.sql` applied remotely as an S2 convergence, 65-row ledger aligned, schema and generated-type parity verified.**
6. **TYPESCRIPT-BASELINE-001** — regenerate the authoritative Supabase types from the reconciled linked schema, prove local/linked type parity, repair the application TypeScript diagnostic baseline (former ~48 → 0) without weakening type safety, and add truthful npm typecheck scripts. **◐ In progress — PR open (branch `baseline/typescript`), not merged; `npm run typecheck` passes with 0 diagnostics (application + Node).**
7. **Resume CI-BASELINE-001** — lint, real typecheck, Vitest, production build in a required `Validate` workflow; then branch protection.

## 6. Completion criteria

Schema reconciliation is **complete** — all criteria below are now satisfied (verified 2026-07-19/20 across RECON-METADATA-PARITY-001 deployment and TYPESCRIPT-BASELINE-001):

- ✓ all committed migrations replay cleanly on a fresh local database (65 migrations);
- ✓ local and linked migration ledgers match (65 aligned, 0 local-only, 0 remote-only, last `20260719162013`);
- ✓ schema-only comparison of local and linked shows no material drift;
- ✓ generated local and linked public-schema types are semantically identical, and the committed `src/integrations/supabase/types.ts` matches the linked output;
- ✓ the two approved residual differences remain documented and retained: the `search_vector` wrapper-vs-inline generation expression (proven semantically equal) and the Supabase default-grant shadow-database artifact (SEC-4);
- ✓ no unexplained diff remains.
