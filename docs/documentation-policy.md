# Documentation Policy

> **Status: active.** Documentation ships in the same PR as the change it describes, is **proportional** to that change, and is maintained **in place**. This policy replaces the earlier append-oriented policy that routed every meaningful PR into multiple documents.

---

## 1. Document authority

Each document below is the single authority for its area. When a change makes one of them inaccurate, fix **that** document. Do not restate the same fact in several documents — link instead.

| Document | Authority |
|---|---|
| [README.md](../README.md) | Concise public/developer entry point: what the project is, stack, local setup, test/deploy pointers |
| [start-here.md](start-here.md) | Bounded current-state handoff for fresh sessions (see §2) |
| [decisions-and-triggers.md](decisions-and-triggers.md) | Durable architecture/product/security decisions (C-numbers, S1/S2) and their re-evaluation triggers |
| [owner-decisions.md](owner-decisions.md) | Owner actions, blockers, approvals, and the implementation unlock order |
| [deployment.md](deployment.md) | Deployment and operational procedures (env vars, migration/Edge Function deploys, domains, smoke checks) |
| [architecture-read-path.md](architecture-read-path.md) (and future topic docs) | Subsystem architecture detail |
| [commercial-architecture.md](commercial-architecture.md), [quotas-and-pricing.md](quotas-and-pricing.md), [store-launch-checklist.md](store-launch-checklist.md) | Pricing, entitlement, billing, and launch planning |
| [migration-history.md](migration-history.md) | Historical chronology of schema/database/security/operational changes. **History, not a second current-state handoff** |
| Git history, merged PRs, `supabase/migrations/` | Authoritative historical implementation evidence — never duplicated into active docs to "preserve" it |

---

## 2. `start-here.md` is a bounded current-state document

- **Target size: 150–250 lines. Hard maximum: 300 lines.**
- It is updated **in place**. Obsolete statements are replaced or deleted, not amended with narrative.
- **No automatic PR-by-PR appends.** A PR touches `start-here.md` only when it changes something the handoff asserts (architecture, capabilities, deployment model, decisions, risks, blockers, next action).
- There is **no requirement to preserve every historical sentence**. Removed content is not moved to another document to avoid deletion; Git history preserves it.
- Prefer links to authoritative documents over copied detail.
- An optional **"Recent material changes"** section may list at most **3–5** genuinely material items; remove the oldest when adding.
- **No exact test counts** in `start-here.md` or `README.md` — counts go stale immediately; run the suites for current numbers.

---

## 3. Proportional documentation

- A meaningful change must update **whichever authoritative document becomes inaccurate** — and only those.
- A meaningful change does **not** automatically require updates to every documentation file. Do not mechanically touch `README.md`, `start-here.md`, and `migration-history.md` when only one source of truth is affected.
- Documentation changes must be proportional to the implementation. A one-line fix does not need a narrative entry anywhere.
- Do not create documentation churn merely to report that unrelated areas were unchanged ("what did not change" sections are prohibited in active docs).
- Historical implementation detail belongs in Git, PRs, and migrations — not in the current-state handoff.
- **When in doubt about facts, still update docs:** if new implementation contradicts existing documentation, fix the affected doc in the same PR. Label planned-but-unimplemented work explicitly ("Status: planning only"); never write prose that reads as if unshipped work ships.

### `migration-history.md`

Update it **only** for material chronological changes that belong in a migration, database, security, deployment, or operational history — typically one concise entry per material schema/RPC/RLS/Edge-Function change. Docs-only refactors do not require an entry. Do not transfer removed `start-here.md` narrative into it.

---

## 4. Validation by change type

### Docs-only changes

Normally require:

- diff-scope verification (only intended files changed);
- `git diff --check`;
- relative-link validation;
- heading/anchor validation (no other file links to a removed heading);
- factual consistency review against the authoritative sources;
- Markdown rendering review.

Docs-only changes do **not** automatically require Playwright, Vitest, TypeScript compilation, an application build, or a Supabase migration replay. Those heavier checks are required only when executable files changed, a repository-required CI check mandates them, documentation tooling executes code, or the change exposes an unexpected executable impact.

### Code changes

Follow the pre-merge baseline in [start-here.md](start-here.md) (lint, typecheck, Vitest, build; Playwright when UI behavior changes) and the deploy checklists in [deployment.md](deployment.md).

---

## 5. Required final-report section for every Claude Code task

Every Claude Code task report must end with a section titled exactly:

`Documentation updates`

containing one of:

- **a list of every documentation file changed**, each with a one-line reason; or
- **an explicit statement that no documentation update was required, with reasons.**

A task report without this section is incomplete and should be rejected on review.

---

## 6. PR checklist (non-trivial PRs)

- [ ] **Code changed?** (which area)
- [ ] **Schema / RLS / RPC / Edge Function changed?** (migration name; deploy command in the PR description if a deploy is required)
- [ ] **User-facing behavior changed?**
- [ ] **Decision made?** (recorded in `decisions-and-triggers.md` / `owner-decisions.md`?)
- [ ] **Tests added or updated?** (which layer)
- [ ] **Docs updated?** (which authoritative document — see §1; or why none)
