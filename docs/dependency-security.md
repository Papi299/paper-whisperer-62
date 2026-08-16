# Dependency Security

> **Status: active.** This is the authoritative current-state document for npm dependency security: what `npm audit` reports **now**, which bounded remediation work is complete, what remains deferred, and the policy future remediation follows. Historical implementation evidence (advisory tables, dependency paths, CI logs, merge topology) is **not** duplicated here — it lives in Git history, the merged PRs, and `package-lock.json`.

## Purpose and authority

- This document owns the **current dependency-security posture** and the **remediation policy**. When an audit result or a remediation boundary changes, fix this file.
- It is **not** a chronology. Per-cluster implementation detail belongs to the merged PRs listed below.
- Supabase/Postgres security (RLS, RPC grants, Auth advisors) is a separate concern owned by [decisions-and-triggers.md](decisions-and-triggers.md) and [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md). Dependency remediation has never changed schema, RLS, migrations, or Supabase Production.

## Current audit state

`npm audit` measured on a clean `npm ci` (which did not mutate `package-lock.json`):

| Graph | Total | Low | Moderate | High | Critical |
|---|---|---|---|---|---|
| Full (incl. dev) | **0** | 0 | 0 | 0 | 0 |
| Production only | **0** | 0 | 0 | 0 | 0 |

**The audit is at zero in both graphs.** The last residual family — React Router — was cleared by [Cluster 5](#react-router-cluster-5--complete), which crossed to the v7 line. No advisory of any severity is outstanding.

Zero is a measurement, not a standing property: advisory databases move, and a newly published advisory can reopen either graph without any change to this repository. Re-run the [verification commands](#verification-commands) rather than trusting this table.

The previously recorded `nanoid` high remains **remediated** by a lockfile-only in-range resolution — see [NanoID finding](#nanoid-finding--remediated).

## Completed remediation boundaries

All five bounded clusters are complete. In Clusters 1–4 the **dependency implementation delta was confined to `package-lock.json`** — no `package.json`, application-source, workflow, test, migration, schema, or Supabase change. Cluster 5 is the one exception by design: crossing a major-version boundary required a `package.json` dependency swap and six import specifiers. Each was a dependency-security remediation rather than a product-feature change, and none carried an intended behavior change; the resolved implementations of the upgraded packages did change, so runtime behavior is verified by the test suites, not assumed from the diff scope.

| Cluster | Scope | Result | Evidence |
|---|---|---|---|
| 1 | Vite / Vitest / PostCSS toolchain | Complete | PR #183, merge `47e2b2c5e084a5daa38f1ee1481063142b0f438b` |
| 2 | `lodash` / `ws` / `yaml` / `picomatch` / `brace-expansion` | Complete | PR #187, merge `1d3aad5dcf325429489dd460634a8f9d01e03894` |
| 3 | `js-yaml` / `flatted` / `form-data` / `@tootallnate/once` / `esbuild` | Complete | PR #188, merge `8ca9ee7da34faa16804e3e8f8f0b52df83a3ac7c` |
| 4 | React Router family, **within v6 only** | Complete — partial by design | PR #190 |
| 5 | React Router **v6 → v7 direct-package migration** | Complete | Audit/design PR #224 · implementation PR #225 |

Across Clusters 1–3 the audit moved from **16 findings (1 critical / 9 high / 4 moderate / 2 low)** to **3 moderate**. Cluster 4 took it to **2 moderate**, and Cluster 5 took it to **zero**. The later `nanoid` advisory was outside all five clusters and was remediated separately as a standalone bounded dependency-advisory task.

## Current resolved security baseline

These resolutions must not regress. A change that moves any of them backwards reintroduces a closed advisory.

| Cluster | Packages |
|---|---|
| 1 | `vite` 7.3.6 · `vitest` 3.2.7 · `postcss` 8.5.26 |
| 2 | `lodash` 4.18.1 · `ws` 8.21.3 · `yaml` 2.9.0 · `picomatch` 4.0.5 (nested v2 line 2.3.2) · `brace-expansion` 1.1.18 (nested v2 line 2.1.4) |
| 3 | `js-yaml` 4.3.1 · `flatted` 3.4.4 · `form-data` 4.0.6 · `@tootallnate/once` 2.0.1 · `esbuild` 0.28.1 |
| 5 | `react-router` **7.18.2** (declared `^7.18.2`) · `cookie` 1.1.1 · `set-cookie-parser` 2.7.2 |

Cluster 3 additionally required `hasown` 2.0.4, because `form-data@4.0.6` declares `hasown@^2.0.4`. It is a patch-level bump that satisfies every existing consumer range and is the one Cluster 3 resolution also reachable in the production graph.

Cluster 5 **superseded** the Cluster 4 baseline: `react-router-dom` and `@remix-run/router` are no longer installed at all, so the terminal v6 resolutions they pinned no longer exist in the graph. `cookie` and `set-cookie-parser` are `react-router@7`'s own direct dependencies, not incidental churn.

Outside the clusters, **`nanoid` 3.3.18** is also a security-relevant resolution that must not regress — see [NanoID finding](#nanoid-finding--remediated).

## NanoID finding — REMEDIATED

**Status: REMEDIATED.** It postdates Clusters 1–4 and was handled as a standalone bounded dependency-advisory task rather than as a cluster. The advisory is absent from **both** the full and the production audit graph.

| Field | Value |
|---|---|
| Advisory | [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) — "custom generators can loop indefinitely when size is zero" (CWE-835) |
| Package | `nanoid` |
| Severity | **High** |
| Affected range | `<3.3.18` |
| Previously installed | `3.3.17` (vulnerable) |
| Now resolved to | **`3.3.18`** — on the existing 3.x line, **not** a major-version move |
| Graphs | No longer reported in either the full or the production graph |

### Introducing path

`nanoid` is not a declared dependency and is not imported anywhere in `src/`, `e2e/`, `scripts/`, or `supabase/functions/`. It is reached only through the CSS build toolchain:

```text
postcss 8.5.26  →  nanoid ^3.3.17  →  nanoid 3.3.18
```

In the **production** graph the chain that pulls it in is:

```text
tailwindcss-animate (root "dependencies")  →  tailwindcss (peer)  →  postcss  →  nanoid
```

That production-graph presence is a **packaging artifact**, not evidence of shipped runtime code: `tailwindcss-animate` is a build-time Tailwind plugin consumed by `tailwind.config.ts`, but it is declared under `dependencies` rather than `devDependencies`, and it declares `tailwindcss` as a peer. In the full graph `postcss` is additionally reached as a root `devDependency` and via `vite`, `autoprefixer`, and `tailwindcss`.

### Applicability

- **Established:** no first-party code calls `nanoid`. The advisory's precondition is a *custom generator* invoked with `size` 0 (`customAlphabet`/`customRandom`), which requires calling the library. Paperlume never does.
- **Established:** every path to it runs through PostCSS/Tailwind, which execute in Node at build time to process CSS.
- **Never established:** whether any tooling in the chain itself invokes a custom generator with a zero size. That question was **not** resolved, and did not need to be — low apparent exploitability is not a reason to withhold a safe, in-range patch.

The applicability notes above are therefore **not** the justification for the remediation; the availability of a compatible patched release is.

### Applied remediation

`postcss@8.5.26` declares `nanoid: ^3.3.17`, and the patched `3.3.18` **satisfies that existing range** — it is also the newest published 3.x release, so it is the newest safe version the range permits, not merely the patched floor.

The fix was applied with a name-scoped, lockfile-only update (`npm update nanoid --package-lock-only`), per the [Remediation policy](#remediation-policy):

- the dependency delta was confined to the single `nanoid` resolution in `package-lock.json` — `version`, `resolved`, and `integrity` only;
- **no other package resolution changed**;
- `package.json` was **not** modified (verified byte-identical by SHA-256), no `overrides` entry was added, `nanoid` was not made a direct dependency, and no parent package was upgraded;
- no application-source, test, config, or workflow change was required;
- `npm ci` reproduces the tree from the committed lockfile without mutating it;
- both the full and `--omit=dev` audits no longer report GHSA-2v37-7h3g-55p8.

## React Router Cluster 5 — COMPLETE

The Router family is installed as a single direct dependency on the v7 line:

```text
react-router 7.18.2   (declared "^7.18.2")
```

`react-router-dom` and `@remix-run/router` are **no longer installed**. The v6 architecture — `react-router-dom` as the only declared package, pinning `react-router` and `@remix-run/router` to exact versions — no longer exists.

### What was migrated

A **direct-package migration**, the path the official v6→v7 upgrade guide prescribes: "In v7 we no longer need `react-router-dom` as the packages have been simplified… Note you only need `react-router` in your `package.json`."

- `package.json`: `react-router-dom@^6.30.1` replaced by `react-router@^7.18.2`.
- `package-lock.json`: `react-router` 6.30.4 → 7.18.2; `react-router-dom` and `@remix-run/router` removed; `cookie` and `set-cookie-parser` added as `react-router@7`'s own dependencies. No other package resolution changed.
- Six source files changed **import provenance only** — `src/App.tsx` and `src/pages/{Index,Auth,Dashboard,ResetPassword,NotFound}.tsx`, each swapping `react-router-dom` for `react-router` on a single import line.

Every import targets bare `react-router`. **None** uses `react-router/dom`, whose surface is `RouterProvider`, `HydratedRouter` and RSC APIs that Paperlume does not use.

**No behavior change was intended and none was made.** The route tree, route order, the catch-all `*`, every `navigate()` target, all auth and redirect logic, and all rendering are byte-identical to the v6 tree. **React and ReactDOM remain 18.3.1** — v7 requires only `node@20+` / `react@18+` / `react-dom@18+`. No future flag was enabled: `v7_relativeSplatPath` needs a multi-segment splat (the only splat is the bare `*`), and `v7_startTransition` only matters for `React.lazy` used inside a component, which does not occur. The remaining v7 flags are data-router-only.

### Advisories cleared

All four Router advisories that bore on the decision are absent from both graphs after the migration:

| Advisory | CVE | Affected | Cleared by |
|---|---|---|---|
| [GHSA-wrjc-x8rr-h8h6](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6) | CVE-2026-53669 | `react-router` `>=6.0.0 <7.18.0` | 7.18.2 > patched floor 7.18.0 |
| [GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg) | CVE-2026-53666 | `react-router` `>=6.4.0 <7.18.0` | 7.18.2 > patched floor 7.18.0 |
| [GHSA-jjmj-jmhj-qwj2](https://github.com/advisories/GHSA-jjmj-jmhj-qwj2) | CVE-2026-53668 | `react-router-dom` `>=6.30.2 <=6.30.4` — **no v6 patch ever published** | removing `react-router-dom` entirely |
| [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) | — | `react-router` `>=7.12.0 <7.18.2` | 7.18.2 is the patched release |

**7.18.2 was required, not merely preferred.** The first three are patched at 7.18.0, but GHSA-qwww-vcr4-c8h2 affects the v7 line up to but excluding 7.18.2 — so 7.18.0 or 7.18.1 would have traded three moderates for a fourth finding. That advisory does not apply to v6 and was therefore invisible to `npm audit` before the migration; it was found only by querying the advisory database for the *candidate* line.

**Severity attribution for GHSA-qwww-vcr4-c8h2:** GitHub's central Advisory Database currently rates it **High**, while the upstream `remix-run/react-router` repository advisory labels it **Moderate**. Both identify `>=7.12.0 <7.18.2` as affected and **7.18.2 as the patched v7 release**, so the discrepancy is one of labelling and did not affect target selection. Preserve both attributions rather than collapsing them.

### Why not v8

v8 remains **out of scope as a platform upgrade**. No finding required it: every advisory above is patched on v7, and 8.3.0 is simply where GHSA-qwww-vcr4-c8h2 lands on the v8 line, in parallel with 7.18.2. Per the official v7→v8 guide and npm metadata, v8 requires **`react@19.2.7+` / `react-dom@19.2.7+` and `node@22.22+`**, and `react-router-dom` is not published on that line at all. Adopting it would be a React major migration and needs a **separate owner decision**.

### Usage profile

Paperlume uses React Router in **declarative mode only**: a single `BrowserRouter` + `Routes`/`Route` tree in `src/App.tsx`, with `useNavigate` in four pages and one `useLocation`. There is no data router (`createBrowserRouter`/`RouterProvider`), no loaders or actions, and no SSR or hydration anywhere in the client-only Vite SPA. All six `navigate()` call sites pass hardcoded literals (`/`, `/auth`, `/dashboard`), and no `<Link>`/`<NavLink>`/`<Navigate>` is rendered anywhere.

This profile is what kept the migration to import provenance, and it is the thing to re-check if a future change adopts a data router, introduces SSR, or makes a navigation target depend on user input.

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

`npm audit` currently exits zero. A **nonzero** exit now means a new advisory has appeared — investigate it rather than treating it as normal.

## Re-evaluation triggers

Revisit this document when any of the following occurs:

- **any** advisory appears in either graph. With the audit at zero this is the primary trigger, and a new high or critical fires it urgently;
- a **new React Router advisory** is published, particularly one whose affected range reaches **7.18.2** — that would move the floor again and require re-measuring the v7 line (and re-examining whether v8, still out of scope today, has become necessary);
- Paperlume's Router usage changes in a way that alters the exposure profile — a navigation target stops being a hardcoded literal, `<Link>`/`<NavLink>` starts being rendered, a data router is adopted, or SSR/hydration is introduced;
- a dependency upgrade requires application source changes, a workflow change, or a `package.json` change;
- any baseline version in [Current resolved security baseline](#current-resolved-security-baseline) regresses;
- the toolchain moves to a new major (Vite, Vitest, or Node engine), which can re-open transitive ranges.

## Deployment note

Dependency changes ship like any other frontend change: merging to `main` triggers the automatic Vercel Production deployment. They involve **no** Supabase deployment step — Supabase migrations and Edge Functions are deployed separately and manually per [deployment.md](deployment.md), and none of the five clusters touched them.
