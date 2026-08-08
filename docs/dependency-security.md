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
| Full (incl. dev) | 2 | 0 | **2** | 0 | 0 |
| Production only | 2 | 0 | **2** | 0 | 0 |

Both current npm-audit findings are in the **React Router package family** (`react-router` and `react-router-dom`). The audit is **not yet at zero**, and **cannot be brought to zero on the React Router v6 line** — remaining clearance requires the major-version work below, see [Remaining React Router findings](#remaining-react-router-findings).

## Completed remediation boundaries

Four bounded clusters are complete. In each, the **dependency implementation delta was confined to `package-lock.json`** — no `package.json`, application-source, workflow, test, migration, schema, or Supabase change. (Clusters 1–3 shipped as lockfile-only pull requests; Cluster 4's pull request additionally updates this current-state documentation, which is a documentation change rather than part of the dependency delta.) Each was a dependency-security remediation rather than a product-feature change, and none carried an intended behavior change; the resolved implementations of the upgraded packages did change, so runtime behavior is verified by the CI suites, not assumed from the diff scope.

| Cluster | Scope | Result | Evidence |
|---|---|---|---|
| 1 | Vite / Vitest / PostCSS toolchain | Complete | PR #183, merge `47e2b2c5e084a5daa38f1ee1481063142b0f438b` |
| 2 | `lodash` / `ws` / `yaml` / `picomatch` / `brace-expansion` | Complete | PR #187, merge `1d3aad5dcf325429489dd460634a8f9d01e03894` |
| 3 | `js-yaml` / `flatted` / `form-data` / `@tootallnate/once` / `esbuild` | Complete | PR #188, merge `8ca9ee7da34faa16804e3e8f8f0b52df83a3ac7c` |
| 4 | React Router family, **within v6 only** | Complete — partial by design | PR #190 |

Across Clusters 1–3 the audit moved from **16 findings (1 critical / 9 high / 4 moderate / 2 low)** to **3 moderate**. Cluster 4 then took it to the **2 moderate** above.

**Clusters 1–4 being complete does not mean dependency remediation is complete.** Cluster 4 was explicitly bounded to the v6 line and cleared only what v6 can clear; the residual findings below require the unstarted Cluster 5.

## Current resolved security baseline

These resolutions must not regress. A change that moves any of them backwards reintroduces a closed advisory.

| Cluster | Packages |
|---|---|
| 1 | `vite` 7.3.6 · `vitest` 3.2.7 · `postcss` 8.5.26 |
| 2 | `lodash` 4.18.1 · `ws` 8.21.3 · `yaml` 2.9.0 · `picomatch` 4.0.5 (nested v2 line 2.3.2) · `brace-expansion` 1.1.18 (nested v2 line 2.1.4) |
| 3 | `js-yaml` 4.3.1 · `flatted` 3.4.4 · `form-data` 4.0.6 · `@tootallnate/once` 2.0.1 · `esbuild` 0.28.1 |
| 4 | `react-router-dom` 6.30.4 · `react-router` 6.30.4 · `@remix-run/router` 1.23.3 |

Cluster 3 additionally required `hasown` 2.0.4, because `form-data@4.0.6` declares `hasown@^2.0.4`. It is a patch-level bump that satisfies every existing consumer range and is the one Cluster 3 resolution also reachable in the production graph.

The Cluster 4 versions are the **terminal releases of the v6 line** (`react-router-dom` dist-tag `version-6` = 6.30.4). They cannot move further without crossing to v7.

## Remaining React Router findings

The Router family is installed at the terminal v6 releases:

```text
react-router-dom  6.30.4
react-router      6.30.4
@remix-run/router 1.23.3
```

`react-router-dom` is the only declared dependency (`^6.30.1`); it pins `react-router` and `@remix-run/router` to **exact** versions, so the two transitive packages can only ever move via the parent.

**Cluster 4 cleared everything the v6 line can clear.** [GHSA-2j2x-hqr9-3h42](https://github.com/advisories/GHSA-2j2x-hqr9-3h42) (protocol-relative-URL open redirect) is closed across the whole family, and `@remix-run/router` has left the vulnerable set entirely.

Three advisories remain, and **none has a patched release on the v6 line**:

| Advisory | Package | Affected range | First patched release |
|---|---|---|---|
| [GHSA-wrjc-x8rr-h8h6](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6) | `react-router` | `>=6.0.0 <7.18.0` | 7.18.0 — **7.x only** |
| [GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg) | `react-router` | `>=6.4.0 <7.18.0` | 7.18.0 — **7.x only** |
| [GHSA-jjmj-jmhj-qwj2](https://github.com/advisories/GHSA-jjmj-jmhj-qwj2) | `react-router-dom` | `>=6.30.2 <=6.30.4` | **none on v6** — the range includes 6.30.4, the terminal v6 release |

### Applicability to Paperlume

Paperlume uses React Router in **declarative mode only**: a single `BrowserRouter` + `Routes`/`Route` tree in `src/App.tsx`, with `useNavigate` and one `useLocation`. There is **no** data router (`createBrowserRouter`/`RouterProvider`), no loaders or actions, and no SSR or hydration anywhere in the client-only Vite SPA.

On that evidence, all three residual advisories are assessed **not currently reachable** — which is a statement about today's usage, not a claim that the packages are safe:

- **GHSA-wrjc-x8rr-h8h6** (open redirect via backslash in `<Link>`/`useNavigate`) requires an attacker-supplied path reaching a navigation target. All six `navigate()` call sites pass hardcoded literals (`/`, `/auth`, `/dashboard`), and the `src/components/NavLink.tsx` wrapper currently has **no consumers**, so no `<Link>`/`<NavLink>` is rendered at all.
- **GHSA-337j-9hxr-rhxg** (constructor injection via `deserializeErrors()` during SSR hydration) needs the SSR hydration path. Paperlume has no `hydrateRoot`, `StaticRouter`, `createStaticHandler`, or `__staticRouterHydrationData`.
- **GHSA-jjmj-jmhj-qwj2** (open redirect leading to XSS) is conditioned on the application already having an open-redirect surface. No navigation target in Paperlume is derived from URL parameters or user input. The published advisory text is thin on mechanism, so this classification rests on the absence of the precondition rather than on a reading of the patch.

This is the weakest of the three conclusions and should be re-checked whenever a navigation target stops being a hardcoded literal.

### Cluster 5 — NOT STARTED

Because every residual advisory is first fixed on the 7.x line (or has no v6 fix at all), **reaching audit zero is impossible without crossing the major-version boundary**. Cluster 5 is therefore what would be required **to eliminate the remaining npm-audit findings under the current advisory data** — that is the precise sense in which it is necessary. It is **not** thereby the next product-development task: it is **NOT STARTED**, **not owner-approved**, and **no React Router major migration is authorized**. No target version is committed to here — the advisory database and available release lines must both be re-measured when that work is selected. A major-version move is an application-code migration, not a lockfile change.

These are the only remaining npm-audit findings in the **production dependency graph**. Presence in the production graph is not by itself proof of an exploitable path, and the applicability assessment above is **not** a declaration that the vulnerable packages are safe — it is a reason to schedule Cluster 5 deliberately rather than urgently, not a reason to skip it.

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
- Cluster 5 is owner-selected, or a residual Router advisory gains a **backported v6 fix** (which would re-open bounded v6 remediation), or a new Router advisory appears;
- Paperlume's Router usage changes in a way that affects the applicability assessment — a navigation target stops being a hardcoded literal, `<Link>`/`<NavLink>` starts being rendered, a data router is adopted, or SSR/hydration is introduced;
- a dependency upgrade requires application source changes, a workflow change, or a `package.json` change;
- any baseline version in [Current resolved security baseline](#current-resolved-security-baseline) regresses;
- the toolchain moves to a new major (Vite, Vitest, or Node engine), which can re-open transitive ranges.

## Deployment note

Dependency changes ship like any other frontend change: merging to `main` triggers the automatic Vercel Production deployment. They involve **no** Supabase deployment step — Supabase migrations and Edge Functions are deployed separately and manually per [deployment.md](deployment.md), and none of Clusters 1–4 touched them.
