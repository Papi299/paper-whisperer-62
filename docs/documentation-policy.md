# Documentation Policy

> **Status: active. From this PR forward, every meaningful change to Paper Whisperer must update documentation alongside the change.**

---

## 1. Purpose

Paper Whisperer is moving from a single-developer hobby project to a commercial product. The repository's documentation has been a strength so far — `README.md`, [docs/start-here.md](start-here.md), [docs/migration-history.md](migration-history.md), [docs/decisions-and-triggers.md](decisions-and-triggers.md), and [docs/architecture-read-path.md](architecture-read-path.md) all reflect what actually shipped. As commercialization, billing, mobile packaging, store submission, legal, and AI quota work all begin in parallel, the **rate of decisions outpaces what any single developer can hold in memory**. Stale or missing docs become a real failure mode — for the owner, for future Claude Code sessions, and for any reviewer.

This policy locks in the rule that **docs ship in the same PR as the change** and that every Claude Code report explicitly accounts for documentation.

---

## 2. The documentation update rule

> **Every meaningful change must update documentation, or the change author must explicitly state why no documentation update is needed.**

A change is **meaningful** when any of the following is true:

- A new feature or user-visible behavior was added.
- An existing user-visible behavior changed.
- A bug fix changed observable behavior, error messages, or UX flow.
- The database schema changed (new table, column, index, RPC, RLS policy, trigger, generated column).
- An Edge Function changed (request/response shape, error contract, side effects, deploy steps).
- An architecture decision was made or revisited.
- A commercial / product / pricing / quota / store decision was made.
- A function, hook, or module was added or removed.
- A test convention or build / deploy convention changed.

A change is **trivial enough to skip docs** only when **all** of the following are true:

- No user-visible behavior change.
- No developer-visible API change.
- No schema, RLS, RPC, Edge Function, or deploy-step change.
- No architectural / commercial decision.
- The change is mechanical (typo fix, import sort, single-line lint cleanup, dependency patch with no behavior change).

When in doubt, **update docs**. A 30-second doc edit is always cheaper than a future contributor or future Claude Code session reasoning from stale information.

---

## 3. Which file to update by change type

Use this table to decide where the doc update lands. **Multiple destinations are common** — a feature ship that includes a migration touches all of: the README status block, `start-here.md`, and `migration-history.md`.

| Change type | Update at minimum |
|---|---|
| High-level shipping status, "what's done now" | `README.md` |
| Fresh-chat handoff context, latest-state summary | `docs/start-here.md` |
| New migration / schema change / RLS policy / RPC / Edge Function deploy | `docs/migration-history.md` |
| Architecture decision, performance trade-off, re-evaluation trigger | `docs/decisions-and-triggers.md` |
| Read-path architecture detail | `docs/architecture-read-path.md` |
| Commercial / product / pricing / plan / billing-architecture decision | `docs/commercial-architecture.md` and/or `docs/quotas-and-pricing.md` |
| App Store / Play Store / mobile packaging / launch ops | `docs/store-launch-checklist.md` |
| New complex subsystem (e.g., a new Edge Function family, a new background job system) | New feature-specific doc under `docs/<topic>.md`, plus a link from `docs/start-here.md` |
| Test convention change | `README.md` Testing section + the relevant feature doc |
| Deploy / ops convention change | `README.md` Edge Functions section + `docs/store-launch-checklist.md` Production operations section |

If a change spans multiple destinations, **update all of them in the same PR**. Do not split docs into a follow-up PR — the follow-up rarely lands.

---

## 4. Required final-report section for every Claude Code task

Every Claude Code task report from this point forward must end with a section titled exactly **"Documentation updates"** containing one of:

- **A list of every doc file changed**, each with a one-line note on why it changed.

  Example:
  > **Documentation updates**
  > - `docs/migration-history.md` — added entry for migration `2026XXXX_add_foo.sql`.
  > - `docs/decisions-and-triggers.md` — added §6 capturing the choice of LATERAL JOIN vs. CTE.
  > - `README.md` — bumped Vitest count from 257 to 261; added the new feature to the status list.

- **An explicit "no docs change needed" statement with reasons.**

  Example:
  > **Documentation updates**
  > No documentation changes needed because the only change is a one-line lint fix in a test file (`e2e/notes.spec.ts`); no user behavior, no developer API, no schema, no architecture decision changed.

A task report without this section is incomplete and should be rejected on review.

---

## 5. Preventing stale docs

- **If new implementation contradicts existing documentation, update the docs in the same PR.** Discovering that the code says one thing and the docs another is the most expensive form of docs debt.
- **Label planned-but-not-implemented work clearly.** Use phrases like "Status: planning only", "Status: provisional", "Status: not implemented yet". Never write a doc paragraph that reads as if a feature ships when it does not.
- **Do not mark future work as shipped.** If a PR adds a feature gate but the feature is not yet wired to the UI, the docs must say so — not imply completion.
- **Cross-link aggressively.** Every commercial doc above links to the others; every migration entry links to the relevant code path. A reader landing on any single page should be able to find the rest.
- **Old docs are not historical artifacts unless explicitly labelled.** Either the doc reflects current truth or it is removed. If a feature is sunset, update or delete the doc and add a sunset note in `decisions-and-triggers.md`.

---

## 6. PR checklist

Every non-trivial PR description should include answers to the following:

- [ ] **Code changed?** (which files / area)
- [ ] **Schema changed?** (new migration? RLS / RPC / trigger / generated column?)
- [ ] **Edge Function changed?** (which function? deploy required? `supabase functions deploy …` command in the PR description?)
- [ ] **User-facing behavior changed?** (what would a user notice?)
- [ ] **Architecture decision made?** (recorded in `decisions-and-triggers.md`?)
- [ ] **Commercial / product / pricing / plan decision made?** (recorded in `commercial-architecture.md` or `quotas-and-pricing.md`?)
- [ ] **Tests added or updated?** (Vitest unit / Playwright E2E / both / N/A — and updated counts)
- [ ] **Docs updated?** (which docs — see §3)

When using Claude Code, this checklist is mirrored in the required **Documentation updates** section of the task report (see §4).

---

## 7. Cross-references

- [README.md](../README.md) — top-level status; canonical source for current shipping state.
- [docs/start-here.md](start-here.md) — fresh-chat handoff for new assistants and contributors.
- [docs/migration-history.md](migration-history.md) — schema / RPC / Edge Function chronology.
- [docs/decisions-and-triggers.md](decisions-and-triggers.md) — architecture decisions and re-evaluation triggers.
- [docs/architecture-read-path.md](architecture-read-path.md) — read-path internals.
- [docs/commercial-architecture.md](commercial-architecture.md) — entitlement / billing-neutral architecture (planning).
- [docs/quotas-and-pricing.md](quotas-and-pricing.md) — provisional plan structure (planning).
- [docs/store-launch-checklist.md](store-launch-checklist.md) — App Store / Play Store readiness (planning).
