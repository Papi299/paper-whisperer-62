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
- **`projects.updated_at`:** exists locally (column + trigger); absent in production. No code reads or writes it; the hand-written domain type declares it (a latent inaccuracy).
- **Junction RPC bodies:** the four assignment RPCs (`set_paper_projects`, `set_paper_tags`, `bulk_set_paper_projects`, `bulk_set_paper_tags`) differ textually because their bodies follow the junction shape.

### Cosmetic / semantically equivalent

- Duplicate `updated_at` trigger on `papers` locally (`trg_papers_updated_at` + `update_papers_updated_at`) vs. one in production — same resulting value.
- `created_at` defaults: `now()` locally vs. `timezone('utc', now())` remotely on several tables (identical instants for `timestamptz`).
- `tags.color` default `'#e2e8f0'` exists only remotely; the app always supplies a color.
- `search_vector` is a stored generated column on **both** sides; the generation expression uses immutable wrapper functions locally vs. inline `to_tsvector` calls remotely — semantically equal.
- The schema-diff engine also reports the standard Supabase default table grants (an artifact of the shadow database; overlaps the pre-existing anon-grant-hygiene backlog item, not new drift).

### Confirmed in parity (no drift)

RLS enablement, FORCE RLS, and **every policy**; all SECURITY DEFINER search/quota/dedup/bulk-insert RPCs; the five commercial tables (`user_entitlements`, `subscriptions`, `subscription_events`, `usage_counters`, `usage_credits`); `user_storage_usage` and both storage-quota triggers; `paper_attachments`; `filter_presets`; `profiles`. **The security and commercial-enforcement layer is not drifted.**

## 4. Canonical decisions (owner-approved)

- **C20 — `papers.statistical_methods`.** Canonical database type: **`jsonb`**. Canonical stored-value invariant: SQL `NULL`, or a JSON string containing the application-facing text. Transitional production values must be normalized in a later migration: JSON `null` → SQL `NULL`; JSON array → comma-joined JSON string. Objects, numbers, and booleans are unsupported. The domain representation stays `string | null`. After normalization, a database constraint must prevent reintroduction of mixed JSON categories.
- **C21 — legacy columns.** After repeating the aggregate emptiness checks immediately before deployment, **drop** `papers.urls`, `synonym_pool.primary_term`, `synonym_pool.variants`. They hold no meaningful data and nothing depends on them; retaining them perpetuates drift.
- **C22 — junction model.** Canonical: **composite primary keys** — `paper_tags (paper_id, tag_id)`, `paper_projects (paper_id, project_id)`. No surrogate UUIDs; no unused `created_at`. Retain/add reverse-lookup indexes where justified. Generated and domain types updated accordingly. RLS ownership behavior and the four atomic assignment RPCs are preserved.
- **C23 — ownership and pool integrity** *(amended 2026-07-19)*. After migration-time preflight proves zero conflicting rows, enforce **NOT NULL** on: `user_id` for the eight drifted owner-scoped tables, `synonym_pool.canonical_term`, `synonym_pool.synonyms`, `study_type_pool.hierarchy_rank`, `study_type_pool.specificity_weight`. **Amendment (owner-approved 2026-07-19):** `RECON-INTEGRITY-001` additionally converges `synonym_pool.synonyms` to its canonical `DEFAULT '{}'::text[]`, which production lacks (see the drift inventory above). This is a no-data metadata convergence — it changes no stored value — and it aligns the generated Insert optionality of `synonyms` between environments under C25. **No other default is in C23 scope.** The migration must fail safely if preconditions are not met; it must never silently delete or invent data.
- **C24 — deployment and ledger rule.** **Every new reconciliation migration is applied both to a clean local replay and to the linked remote project** via the runbook in [deployment.md](deployment.md) — even when it is structurally a no-op against production. A merged-but-unapplied migration would immediately destroy ledger parity; reconciliation requires schema parity **and** ledger parity.
- **C25 — TypeScript and CI ordering.** Generated Supabase types are **not** regenerated or committed until every type-affecting schema difference (table shape, database type, column existence, nullability, RPC signatures, insert/update optionality) is reconciled and exact parity is verified. Order: schema reconciliation → parity verification → generated types → remaining TypeScript repairs + truthful `npm run typecheck` → GitHub Actions `Validate` workflow → branch protection.

### Rejected interpretations (recorded to prevent recurrence)

1. ~~"A migration that only changes local replay does not need remote deployment."~~ **Wrong.** Every new migration must be applied remotely so its version is recorded by a successful remote application, even when the DDL is idempotent or a no-op against production (C24).
2. ~~"Type generation can resume after the first structural reconciliation while nullability and legacy-column drift remain."~~ **Wrong.** Generated types stay divergent while any type-affecting difference remains; generation resumes only after full type-affecting parity (C25).

## 5. Reconciliation roadmap

Rules for **every** migration task below: the migration must replay from a clean local database; it must be safe against the current production starting state; it must be applied remotely after merge (C24); it must preserve ledger parity; remote data changes require explicit preflight and post-deploy verification; **no historical migration file is edited.**

1. **RECON-JUNCTIONS-001** — composite primary keys, reverse indexes, the four junction RPCs, and domain-type alignment; applied locally and remotely.
2. **RECON-STATISTICAL-METHODS-001** — reconcile the column type to `jsonb`; normalize JSON `null`s and arrays per C20; enforce the supported JSON-category invariant via constraint; update the application boundary mapping and tests where required.
3. **RECON-INTEGRITY-001** — NOT NULL enforcement per amended C23 with migration-time zero-null guards, plus restoration of the canonical `synonym_pool.synonyms` empty-array default.
4. **RECON-LEGACY-COLUMNS-001** — repeat aggregate emptiness checks, then drop the three legacy columns per C21.
5. **RECON-METADATA-PARITY-001** — `projects.updated_at`, duplicate-trigger cleanup, defaults, and any remaining type-affecting metadata; ends with exact dump/diff/type parity verification.
6. **Resume TYPESCRIPT-BASELINE-001** — regenerate deterministic schema types; repair the remaining non-schema TypeScript diagnostics; add truthful npm typecheck scripts.
7. **Resume CI-BASELINE-001** — lint, real typecheck, Vitest, production build in a required `Validate` workflow; then branch protection.

## 6. Completion criteria

Schema reconciliation is complete only when all of the following hold:

- all committed migrations replay cleanly on a fresh local database;
- local and linked migration ledgers match;
- schema-only dumps of local and linked show no material drift;
- generated local and linked public-schema types are semantically identical;
- any approved benign textual differences (e.g., the `search_vector` wrapper-vs-inline expression) are documented here;
- no unexplained diff remains.
