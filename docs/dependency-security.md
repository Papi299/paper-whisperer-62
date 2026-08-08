# Dependency Security

> **Status: active.** This is the authoritative current-state document for npm dependency security: what `npm audit` reports **now**, which bounded remediation work is complete, what remains deferred, and the policy future remediation follows. Historical implementation evidence (advisory tables, dependency paths, CI logs, merge topology) is **not** duplicated here — it lives in Git history, the merged PRs, and `package-lock.json`.

## Purpose and authority

- This document owns the **current dependency-security posture** and the **remediation policy**. When an audit result or a remediation boundary changes, fix this file.
- It is **not** a chronology. Per-cluster implementation detail belongs to the merged PRs listed below.
- Supabase/Postgres security (RLS, RPC grants, Auth advisors) is a separate concern owned by [decisions-and-triggers.md](decisions-and-triggers.md) and [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md). Dependency remediation has never changed schema, RLS, migrations, or Supabase Production.

## Current audit state

`npm audit` on the current `main`:

| Graph | Total | Low | Moderate | High | Critical |
|---|---|---|---|---|---|
| Full (incl. dev) | 3 | 0 | **3** | 0 | 0 |
| Production only | 3 | 0 | **3** | 0 | 0 |

All three findings are the **same React Router advisories** described below. The audit is **not** at zero, and reaching zero is not currently a goal — see [Remaining React Router findings](#remaining-react-router-findings).

## Completed remediation boundaries

Three bounded clusters are complete. Each was **lockfile-only** (`package-lock.json` was the sole changed file — no `package.json`, no source, no workflow, no migration), so none of them changed application behavior.

| Cluster | Scope | Result | Evidence |
|---|---|---|---|
| 1 | Vite / Vitest / PostCSS toolchain | Complete | PR #183, merge `47e2b2c5e084a5daa38f1ee1481063142b0f438b` |
| 2 | `lodash` / `ws` / `yaml` / `picomatch` / `brace-expansion` | Complete | PR #187, merge `1d3aad5dcf325429489dd460634a8f9d01e03894` |
| 3 | `js-yaml` / `flatted` / `form-data` / `@tootallnate/once` / `esbuild` | Complete | PR #188, merge `8ca9ee7da34faa16804e3e8f8f0b52df83a3ac7c` |

Across the three clusters the audit moved from **16 findings (1 critical / 9 high / 4 moderate / 2 low)** to the **3 moderate** above.

**Clusters 1–3 being complete does not mean dependency remediation is complete.** The React Router work below is deliberately unstarted.

## Current resolved security baseline

These resolutions must not regress. A change that moves any of them backwards reintroduces a closed advisory.

| Cluster | Packages |
|---|---|
| 1 | `vite` 7.3.6 · `vitest` 3.2.7 · `postcss` 8.5.26 |
| 2 | `lodash` 4.18.1 · `ws` 8.21.3 · `yaml` 2.9.0 · `picomatch` 4.0.5 (nested v2 line 2.3.2) · `brace-expansion` 1.1.18 (nested v2 line 2.1.4) |
| 3 | `js-yaml` 4.3.1 · `flatted` 3.4.4 · `form-data` 4.0.6 · `@tootallnate/once` 2.0.1 · `esbuild` 0.28.1 |

Cluster 3 additionally required `hasown` 2.0.4, because `form-data@4.0.6` declares `hasown@^2.0.4`. It is a patch-level bump that satisfies every existing consumer range and is the one Cluster 3 resolution also reachable in the production graph.

## Remaining React Router findings

The three remaining moderate findings are the React Router family, currently installed at:

```text
react-router      6.30.3
react-router-dom  6.30.3
@remix-run/router 1.23.2
```

**These packages are still vulnerable and are intentionally not patched.** They were separated from Clusters 1–3 because the advisories are not fixable within the installed v6 range — remediation requires a major-version move to React Router v7, which is an application-code migration (route definitions, data APIs, guards), not a lockfile change. That work is tracked as future **Cluster 4 / Cluster 5** and is **NOT STARTED**; no upgrade strategy has been audited or approved yet.

Because these findings appear in the production graph, they are the only dependency advisories that currently affect shipped code.

## Remediation policy

The approach established across Clusters 1–3, to be followed by future dependency work:

- **Re-measure before mutating.** Run a clean `npm ci` and capture `npm audit --json` (full and `--omit=dev`) on the exact starting commit; advisory databases move.
- **Map advisory → dependency path** (`npm ls`, `npm explain`) before choosing a fix. Know the introducing parent and its declared semver range.
- **Prefer the smallest compatible change**: a lockfile-only resolution inside the parent's existing range. Prefer the newest safe version that range already permits over pinning the bare patched floor.
- **Bound the blast radius.** Use name-scoped `npm update <pkg>`; never a blanket `npm update`. Enumerate and justify every collateral resolution change; unrelated churn is reduced, not accepted.
- **Never `npm audit fix --force`.** Never hand-edit generated lockfile version/resolved/integrity fields, and never add an `overrides` entry merely to silence a finding.
- **Major-version upgrades are separate bounded work**, especially when they require application source changes.
- **Verify reproducibility**: `npm ci` must succeed against the committed lockfile without mutating it.
- **Keep CI green**: the required `Validate` gate plus the non-required `E2E (local)` and `DB Tests` workflows must pass on the exact head. Dependency PRs carry no migration and perform no Supabase mutation.

## Verification commands

```bash
npm ci                       # clean install; must not mutate package-lock.json
npm audit                    # full graph (nonzero exit is expected while findings remain)
npm audit --omit=dev         # production graph
npm ls <package> --all       # every installed occurrence
npm explain <package>        # introduction path and parent semver range
```

A nonzero `npm audit` exit code is the expected steady state while the React Router findings remain, and does not indicate a broken checkout.

## Re-evaluation triggers

Revisit this document when any of the following occurs:

- a **new high or critical** advisory appears in either graph;
- a **new advisory reaches the production graph** (today only React Router does);
- React Router v7 migration is owner-selected, or an advisory fix becomes available **within** the installed v6 range;
- a dependency upgrade requires application source changes, a workflow change, or a `package.json` change;
- any baseline version in [Current resolved security baseline](#current-resolved-security-baseline) regresses;
- the toolchain moves to a new major (Vite, Vitest, or Node engine), which can re-open transitive ranges.

## Deployment note

Dependency changes ship like any other frontend change: merging to `main` triggers the automatic Vercel Production deployment. They involve **no** Supabase deployment step — Supabase migrations and Edge Functions are deployed separately and manually per [deployment.md](deployment.md), and none of Clusters 1–3 touched them.
