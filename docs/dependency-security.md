# Dependency Security

> **Status: active.** This is the authoritative current-state document for npm dependency security: what `npm audit` reports **now**, which bounded remediation work is complete, what remains deferred, and the policy future remediation follows. Historical implementation evidence (advisory tables, dependency paths, CI logs, merge topology) is **not** duplicated here — it lives in Git history, the merged PRs, and `package-lock.json`.

## Purpose and authority

- This document owns the **current dependency-security posture** and the **remediation policy**. When an audit result or a remediation boundary changes, fix this file.
- It is **not** a chronology. Per-cluster implementation detail belongs to the merged PRs listed below.
- Supabase/Postgres security (RLS, RPC grants, Auth advisors) is a separate concern owned by [decisions-and-triggers.md](decisions-and-triggers.md) and [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md). Dependency remediation has never changed schema, RLS, migrations, or Supabase Production.
- GitHub code-scanning (CodeQL) alerts concern first-party code, not dependencies, and this document does not count them. On 2026-11-23, 18 were open on `main`. A separate CodeQL triage track will classify them (**status: planning only**).

## Current audit state

**Dated snapshot, 2026-11-23.** `npm audit` after a clean `npm ci` that did not mutate `package-lock.json`:

| Graph | `main` `dee28f4d` (before the Vite remediation) | With the [Vite remediation](#vite-development-server-rce--remediated) (`package-lock.json` SHA-256 `8ab396ef…`) |
|---|---|---|
| Full (incl. dev) | **17** — 4 high / 13 moderate | **16** — 3 high / 13 moderate |
| Production only | **7** — 3 high / 4 moderate | **7** — 3 high / 4 moderate |

`npm audit` counts package entries, including the parents through which a vulnerable package is reached. The advisories behind these counts are listed under [Open findings](#open-findings-2026-11-23). **Neither graph is clean:** advisories published or revised after the 2026-09-20 measurement reopened both graphs with no change to this repository.

GitHub's Dependabot reported **15 open alerts** on `main` `dee28f4d` on 2026-11-23. Alerts 9–13 are the five indexed Vite advisories that the Vite remediation also moves past. GitHub closes alerts only after a change reaches `main`, so confirm their state there. The critical Vite advisory itself reached neither Dependabot nor `npm audit`: on 2026-11-23 it was published in the Vite repository but not in GitHub's Advisory Database.

**After the Vite remediation merged (2026-11-23).** On `main` `626f794f`, Dependabot showed **11 open alerts**. Alerts 9–13 closed as fixed. The same rescan opened alert **20**, for `minimatch` [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) (moderate). That advisory had been in GitHub's database since 2026-10-30 and `npm audit` already counted it. Dependabot had simply not evaluated this lockfile until the merge changed it. `npm audit` on `main` `626f794f` matched the Vite-remediation column above. The 18 CodeQL alerts were unchanged.

**With the [React Router patch set](#react-router-patch-set--7186) (2026-11-23).** Its lockfile (`package-lock.json` SHA-256 `3d0accdd…`) measures the same as `main` `626f794f`: **16** full (3 high / 13 moderate) and **7** production (3 high / 4 moderate), with the same packages and the same advisories. The eight advisories the patch set addresses are published only in the packages' own repositories, not in GitHub's Advisory Database, so they move neither `npm audit` nor Dependabot. It merged the same day as `ae201aff`. On `main` `ae201aff`, `npm audit` again measured 16 full and 7 production, Dependabot showed the same 11 open alerts, and CodeQL showed 18.

**With the [CSS and build-toolchain patch set](#css-and-build-toolchain-patch-set) (2026-11-23).** This change's lockfile (`package-lock.json` SHA-256 `d8ab7215…`) measures **10** full (1 high / 9 moderate) and **1** production (1 high, `zod`). It removes six entries from each report:
- `brace-expansion`, `glob`, `postcss-selector-parser`, `source-map-js` and `sucrase` from both;
- `@tailwindcss/typography` from the full report;
- `minimatch` from the production report, because its remaining copy is dev-only.

Dependabot closes an alert only after a change reaches `main`. This change should close alerts 1, 3, 5, 6, 8, 17 and 18, and leave alerts 14, 15, 16 and 20 open. That is a projection: after the merge, re-read the alert list, because the same rescan can also open alerts, as it did with alert 20.

**After the CSS and build-toolchain patch set merged (2026-11-23).** It merged as `802d96b8`. On that commit, `npm audit` measured 10 full and 1 production, as projected above, and Dependabot showed **4 open alerts**: 14, 15, 16 and 20. Alerts 1, 3, 5, 6, 8, 17 and 18 had closed as fixed, and no alert had opened. CodeQL still showed 18.

**With the [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set) (2026-11-23).** This change's lockfile (`package-lock.json` SHA-256 `e01b6944…`) measures **1** full and **1** production finding, both `zod` (high). It removes nine entries from the full report: `minimatch`, the six `typescript-eslint` entries that reach it, `@vitest/mocker` and `vitest`. The production report is unchanged. This change should close alerts 14, 15 and 20 and leave alert 16 open. That is again a projection, to be re-read after the merge.

A count is a measurement, not a standing property: advisory databases move, and a newly published advisory can reopen either graph without any change to this repository. Re-run the [verification commands](#verification-commands) rather than trusting this table.

The previously recorded `nanoid` high remains **remediated** by a lockfile-only in-range resolution — see [NanoID finding](#nanoid-finding--remediated).

### Historical measurement (2026-09-20)

`npm audit` measured **2026-09-20**, on a clean `npm ci` that did not mutate `package-lock.json`, against `main` `07c68c0b73362789e6b2e6b3b4a8e782dbde1be7` plus the [Vitest 4 upgrade](#vitest-residual--remediated-by-a-major-upgrade) lockfile (`package-lock.json` SHA-256 `90bd52938ba1a0edaed858fbd56cf65a6d3d96445ef5730209cacdb9d92fb142`):

| Graph | Total | Low | Moderate | High | Critical |
|---|---|---|---|---|---|
| Full (incl. dev) | **0** | 0 | 0 | 0 | 0 |
| Production only | **0** | 0 | 0 | 0 | 0 |

**Both graphs measured zero on 2026-09-20.** The last finding outstanding at that time, the dev-only [GHSA-82fw-gwwq-j7x9](#vitest-residual--remediated-by-a-major-upgrade), was cleared by upgrading `vitest` from the unmaintained 3.x line to **4.1.11**. No finding of any severity was outstanding at that measurement.

**How the graphs got there.** After [Cluster 5](#react-router-cluster-5--complete) both graphs measured zero, and that was true at the time. Advisories published or revised between 2026-09-01 and 2026-09-08 then reopened them with no change to this repository: on `main` `20b57562` the full graph measured **6 (2 high / 3 moderate / 1 low)** and the production graph **1 low**. Advisory remediation 002 cleared every finding that had a compatible in-range fix and took the full graph to **2 moderate**, leaving only the Vitest family; the 2026-09-20 Vitest major upgrade then took it to **0**.

## Completed remediation boundaries

All five bounded clusters are complete. In Clusters 1–4 the **dependency implementation delta was confined to `package-lock.json`** — no `package.json`, application-source, workflow, test, migration, schema, or Supabase change. Cluster 5 is the one exception by design: crossing a major-version boundary required a `package.json` dependency swap and six import specifiers. Each was a dependency-security remediation rather than a product-feature change, and none carried an intended behavior change; the resolved implementations of the upgraded packages did change, so runtime behavior is verified by the test suites, not assumed from the diff scope.

| Cluster | Scope | Result | Evidence |
|---|---|---|---|
| 1 | Vite / Vitest / PostCSS toolchain | Complete | PR #183, merge `47e2b2c5e084a5daa38f1ee1481063142b0f438b` |
| 2 | `lodash` / `ws` / `yaml` / `picomatch` / `brace-expansion` | Complete | PR #187, merge `1d3aad5dcf325429489dd460634a8f9d01e03894` |
| 3 | `js-yaml` / `flatted` / `form-data` / `@tootallnate/once` / `esbuild` | Complete | PR #188, merge `8ca9ee7da34faa16804e3e8f8f0b52df83a3ac7c` |
| 4 | React Router family, **within v6 only** | Complete — partial by design | PR #190 |
| 5 | React Router **v6 → v7 direct-package migration** | Complete | Audit/design PR #224 · implementation PR #225 |

Across Clusters 1–3 the audit moved from **16 findings (1 critical / 9 high / 4 moderate / 2 low)** to **3 moderate**. Cluster 4 took it to **2 moderate**, and Cluster 5 took it to **zero**. The later `nanoid` advisory was outside all five clusters and was remediated separately as a standalone bounded dependency-advisory task. So were the September 2026 advisories: [Advisory remediation 002](#advisory-remediation-002--remediated) took the full graph from **6** to **2 moderate** and the production graph from **1 low** to **zero**, with a `package-lock.json`-only dependency delta. The [Vite development-server remediation](#vite-development-server-rce--remediated) (2026-11-23) is likewise a standalone bounded task with a `package-lock.json`-only delta. The [React Router patch set](#react-router-patch-set--7186) is the next one: a `package-lock.json`-only dependency delta plus one regression test, merged on 2026-11-23 as `ae201aff`. The [CSS and build-toolchain patch set](#css-and-build-toolchain-patch-set) follows it. Its dependency delta is `package-lock.json` plus one `devDependencies` line removed from `package.json`, and it merged on 2026-11-23 as `802d96b8`. The [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set) is next. Its dependency delta is `package-lock.json` plus two raised `devDependencies` declarations in `package.json`. It is not complete until its pull request merges.

## Current resolved security baseline

These resolutions must not regress. A change that moves any of them backwards reintroduces a closed advisory.

| Cluster | Packages |
|---|---|
| 1 | `vite` 7.3.6 — **superseded by 7.3.8** ([Vite development-server RCE](#vite-development-server-rce--remediated)) · `vitest` 3.2.7 — **superseded by 4.1.11** ([Vitest 4 upgrade](#vitest-residual--remediated-by-a-major-upgrade)) · `postcss` 8.5.26 |
| 2 | `lodash` 4.18.1 · `ws` 8.21.3 — **superseded by 8.23.0** in the [React Router patch set](#react-router-patch-set--7186) · `yaml` 2.9.0 · `picomatch` 4.0.5 (nested v2 line 2.3.2) · `brace-expansion` 1.1.18 (nested v2 line 2.1.4) — **superseded by 1.1.22** (nested v2 line **2.1.8**) in the [CSS and build-toolchain patch set](#css-and-build-toolchain-patch-set) |
| 3 | `js-yaml` 4.3.1 — **superseded by 4.3.2** (remediation 002) · `flatted` 3.4.4 · `form-data` 4.0.6 · `@tootallnate/once` 2.0.1 · `esbuild` 0.28.1 |
| 5 | `react-router` **7.18.2** (declared `^7.18.2`) — **superseded by 7.18.6** · `cookie` 1.1.1 · `set-cookie-parser` 2.7.2 — **superseded by 2.7.3**, both in the [React Router patch set](#react-router-patch-set--7186) |
| Remediation 002 | `browserslist` **4.29.0** · `js-yaml` **4.3.2** · `@humanfs/node` **0.16.8** · `postcss-selector-parser` **6.1.4** (hoisted line; the nested exact-pinned 6.0.10 is outside the affected range) — **superseded by 6.1.6** in the [CSS and build-toolchain patch set](#css-and-build-toolchain-patch-set), which also removes the nested 6.0.10 |
| Vitest 4 upgrade | `vitest` **4.1.11** (declared `^4.1.11`) · `@vitest/mocker` **4.1.11** · the `@vitest/*` 4.1.11 siblings · `chai` **6.2.2** — **superseded by 4.1.12** (declared `^4.1.12`), with `chai` **6.3.0**, in the [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set) |
| Vite dev-server RCE | `vite` **7.3.8** (declared `^7.3.1`) |
| React Router patch set (merged as `ae201aff`) | `react-router` **7.18.6** (declared `^7.18.2`) · `set-cookie-parser` **2.7.3** · `ws` **8.23.0** |
| CSS and build-toolchain patch set (merged as `802d96b8`) | `source-map-js` **1.2.4** · `brace-expansion` **1.1.22** (nested v2 line **2.1.8** — replaced by the nested v5 line **5.1.0** in the [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set)) · `postcss-selector-parser` **6.1.6** · `sucrase` **3.35.1** · `glob` and `@tailwindcss/typography` no longer installed |
| Test and lint toolchain patch set (this change; on `main` only once its pull request merges) | `typescript-eslint` and the ten `@typescript-eslint/*` packages **8.73.0** (declared `^8.73.0`) · nested `minimatch` **11.0.9**, with `brace-expansion` **5.1.0** below it · `vitest`, `@vitest/mocker` and the other `@vitest/*` packages **4.1.12** (declared `^4.1.12`) · `chai` **6.3.0** |

Cluster 3 additionally required `hasown` 2.0.4, because `form-data@4.0.6` declares `hasown@^2.0.4`. It is a patch-level bump that satisfies every existing consumer range and is the one Cluster 3 resolution also reachable in the production graph.

Cluster 5 **superseded** the Cluster 4 baseline: `react-router-dom` and `@remix-run/router` are no longer installed at all, so the terminal v6 resolutions they pinned no longer exist in the graph. `cookie` and `set-cookie-parser` are `react-router@7`'s own direct dependencies, not incidental churn.

Outside the clusters, **`nanoid` 3.3.18** is also a security-relevant resolution that must not regress — see [NanoID finding](#nanoid-finding--remediated).

## Vite development-server RCE — REMEDIATED

**Status: REMEDIATED** by `PAPERLUME-SECURITY-VITE-DEVSERVER-RCE-001` (2026-11-23): `package-lock.json` resolves `vite` **7.3.8**. The advisory was found by `PAPERLUME-SECURITY-DEPENDENCY-AUDIT-001`, which compared every installed version with the advisories each package's own repository has published, not only with GitHub's Advisory Database.

| Field | Value |
|---|---|
| Advisory | [GHSA-p4f5-76q4-ffq7](https://github.com/vitejs/vite/security/advisories/GHSA-p4f5-76q4-ffq7) — "Remote code execution using `__vite-browser-external` virtual module" (CWE-116) |
| Severity | **Critical**, CVSS 4.0 **9.1** (`AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N`); no CVE was assigned when this was recorded |
| Published | 2026-11-10, in the `vitejs/vite` repository. On 2026-11-23 it was **not** in GitHub's Advisory Database, so it produced no Dependabot alert and no `npm audit` finding |
| Affected (7.x line) | `>=7.0.0 <=7.3.7`. Other lines: 4.0.0 through 6.4.5, and 8.x before 8.1.7, 8.2.5 or 8.3.7 |
| Patched (7.x line) | **7.3.8** |
| Installed before | `vite` **7.3.6** (declared `^7.3.1`), inside the affected range |
| Installed now | `vite` **7.3.8**, outside it |

### Exposure: the development server, not Production

- The advisory needs a Vite **development server** that an attacker can reach over the network. An HTTP request to that server could then read files outside `server.fs.allow` and run code on the machine serving it.
- `vite.config.ts` sets `server.host: "::"` and `server.port: 8080`, so `npm run dev` listens on every interface. That meets the precondition whenever the development server runs and the network can reach it: local development, the local E2E lifecycle (Playwright starts `npm run dev`), and the E2E jobs on CI runners.
- **Production does not run the development server.** Vercel serves the static output of `vite build`, and no development-server endpoint is deployed. The exposure was on machines that run `npm run dev`; a developer workstation also holds developer credentials.
- Nothing here assumes the advisory was exploited, and no exploitation was investigated or demonstrated. The remediation is version-based, and the published proof of concept was not run.

### Why 7.3.8 and not 7.3.7

Dependabot's PR #353 proposes 7.3.7. That release fixes the five indexed Vite advisories below, but it is still inside this advisory's affected range (`<=7.3.7`).

### Remediation applied

- `npm update vite --package-lock-only`. The dependency delta is the single `node_modules/vite` entry in `package-lock.json`: `version`, `resolved` and `integrity` only. 7.3.8 declares the same `dependencies`, `optionalDependencies`, peer dependencies and `engines` as 7.3.6, so no other entry moved.
- `package.json` was **not** modified, because `"vite": "^7.3.1"` already permits 7.3.8. No `overrides` entry was added, and `npm audit fix` was not run.
- 7.3.8 bundles `launch-editor` and `launch-editor-middleware` **2.14.2** in place of 2.14.1.
- **No built file changed.** Built side by side from clean installs with CI's placeholder environment, `main` `dee28f4d` and this lockfile produce byte-identical `dist/` (9 files) and `dist-extension/` (8 files). Lint, the three typechecks and the Vitest suite give the same results on both.
- 7.3.8 is also past the five indexed advisories behind Dependabot alerts 9–13, all fixed in 7.3.7: [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) (high), [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv), [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw) and [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22) (moderate), and [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw) (low). `npm audit` no longer reports them.

### Residual: Vite's bundled `postcss-selector-parser`

Vite 7.3.x bundles its own copy of `postcss-selector-parser` **7.1.0** inside `vite/dist`, and 7.3.8 still does. That copy lies inside the affected ranges of GHSA-rj75-hqrm-r3gf, GHSA-w9m9-85wc-3x92 and the upstream-only GHSA-67xj-gfww-g738.
- Scanners cannot see it, because it has no `package-lock.json` entry.
- Vite runs it only for CSS Modules, and the repository has no `*.module.css` files.

Reassess when a Vite 7.x release bundles `postcss-selector-parser` 7.1.8 or later, or if CSS Modules are adopted.

## React Router patch set — 7.18.6

**Status: REMEDIATED on `main`** (`PAPERLUME-SECURITY-REACT-ROUTER-PATCH-001`). PR #368 merged on 2026-11-23 as `ae201aff`. Since that day's automatic deployment, Production `dpl_HjkGBrVw` has served `react-router` 7.18.6. Before the merge, `main` `626f794f` and Production `dpl_H5t62SH3` resolved and served `react-router` 7.18.2, `set-cookie-parser` 2.7.2 and `ws` 8.21.3. The rest of this section was written while the pull request was open.

Eight advisories cover those versions. Each package's own repository has published its advisories, but on 2026-11-23 none of them was in GitHub's Advisory Database. None therefore produced a Dependabot alert or an `npm audit` finding.

| Advisory | Package | Severity (upstream) | Affected | Fixed in | Affected modes | Applies to PaperLume |
|---|---|---|---|---|---|---|
| [GHSA-x8j4-g9rr-8j87](https://github.com/remix-run/react-router/security/advisories/GHSA-x8j4-g9rr-8j87): DoS in route matching | `react-router` | High | `>=6.0.0 <7.18.3` | 7.18.3 | Declarative, Data, Framework, RSC | **Yes.** Route matching runs in the browser |
| [GHSA-qhgm-jj2j-75wj](https://github.com/remix-run/react-router/security/advisories/GHSA-qhgm-jj2j-75wj): prototype pollution in data deserialization | `react-router` | High | `>=7.0.0 <7.18.5` | 7.18.5 | Framework | No |
| [GHSA-2rq8-3rm6-2w8f](https://github.com/remix-run/react-router/security/advisories/GHSA-2rq8-3rm6-2w8f): DoS in server-side route discovery | `react-router` | High | `>=7.0.0 <7.18.5` | 7.18.5 | Framework (SSR with lazy route discovery), RSC | No |
| [GHSA-8wpx-2pj4-ggvx](https://github.com/remix-run/react-router/security/advisories/GHSA-8wpx-2pj4-ggvx): CSRF bypass in server-side actions | `react-router` | Moderate | `>=7.12.0 <7.18.3` | 7.18.3 | Framework, RSC | No |
| [GHSA-7m2v-44vx-v55w](https://github.com/remix-run/react-router/security/advisories/GHSA-7m2v-44vx-v55w): open redirect in loader and action responses | `react-router` | Moderate | `>=6.4.0 <7.18.3` | 7.18.3 | Data, Framework, RSC | No |
| [GHSA-mjj8-rxh9-q8f5](https://github.com/remix-run/react-router/security/advisories/GHSA-mjj8-rxh9-q8f5): XSS in RSC redirects | `react-router` | Moderate | `>=7.11.0 <7.18.4` | 7.18.4 | RSC | No |
| [GHSA-mxfr-qhmh-pcx4](https://github.com/nfriedly/set-cookie-parser/security/advisories/GHSA-mxfr-qhmh-pcx4): prototype pollution through `name=`/`value=` attributes | `set-cookie-parser` | High | `<=2.7.2`, `3.0.0–3.1.4` | 2.7.3, 3.2.0 | n/a | No. Not in any shipped code (below) |
| [GHSA-37g9-w4hg-h9qr](https://github.com/websockets/ws/security/advisories/GHSA-37g9-w4hg-h9qr): memory exhaustion through automatic pong replies | `ws` | High | `>=8.0.0 <8.23.0`, and older lines | 8.23.0 | n/a | No. Never loaded by the app (below) |

### Where each package runs

- **`react-router`** ships in the web bundle. PaperLume uses declarative mode only: one `BrowserRouter` with `Routes` and `Route` in `src/App.tsx`. It has no data router, loaders, actions, SSR, framework mode or RSC, so only GHSA-x8j4 applies.
  - Its impact is CPU use in the visitor's own tab. A crafted URL, such as a long run of slashes followed by another character, made route matching quadratic.
  - A bounded local reproduction used `matchRoutes` with PaperLume's route table. With 7.18.2 it took 7.6 ms, 93.6 ms and 1,492 ms at 2,000, 8,000 and 32,000 characters; with 7.18.6 it took 0.8 ms, 0.6 ms and 2.3 ms. Every ordinary path resolved to the same route on both versions.
  - No denial-of-service input was sent to Production or to a Preview.
- **`set-cookie-parser`** is a dependency of `react-router` itself. The only code that uses it is `prependCookies`, the server-side step that merges parent routes' `Set-Cookie` headers. No application or test code reaches that path. Neither the web bundle nor the extension contains it, before or after this change. The update keeps a vulnerable version out of the installed graph; it changes nothing that runs.
- **`ws`**, the `package-lock.json` copy, never reaches a browser.
  - `@supabase/realtime-js` 2.93.3 declares it but never imports it. It uses the platform's native `WebSocket`, and names `ws` only in an error message for Node versions before 22.
  - The only module that loads this copy is jsdom's `WebSocket` implementation, in Vitest, which opens client connections only.
  - The advisory needs a peer that floods pings while not reading. No server in this repository runs on this copy, and the Edge Functions run on Deno without this lockfile.
  - Vite's development server runs its **own bundled** `ws`, which this change cannot move; see [Residual: Vite's bundled `ws`](#residual-vites-bundled-ws).

### Why 7.18.6

7.18.5 fixes all six `react-router` advisories. 7.18.6 (2026-11-18) is the newest 7.x release, published under the `version-7` dist-tag. The [remediation policy](#remediation-policy) prefers the newest safe version the range permits over the bare patched floor.
- 7.18.6 also hardens URL validation for links, form actions, `href()`, `generatePath()` and redirects.
- GHSA-mp5r-736v-j8x9, also fixed in 7.18.6, concerns `@react-router/node`, `@react-router/serve` and `@react-router/dev`. None of them is installed.
- v8 stays out of scope, as recorded under [Why not v8](#why-not-v8).
- `set-cookie-parser` 2.7.3 is the 2.x backport (the `backports` dist-tag). 3.x and 4.x fall outside `react-router`'s `^2.6.0` range.
- `ws` 8.23.0 is the `latest` dist-tag.

### Remediation applied

- `npm update react-router set-cookie-parser ws --package-lock-only`. The dependency delta is three `package-lock.json` entries (`react-router`, `set-cookie-parser` and `ws`), and only their `version`, `resolved` and `integrity` fields. Each new release declares the same dependencies, peers and engines as the one it replaces, so no other entry moved. There are 561 entries before and after, with none added or removed.
- `package.json` was **not** modified.
  - `"react-router": "^7.18.2"` already permits 7.18.6.
  - The transitive ranges permit the other two: `^2.6.0` from `react-router`, and `^8.18.2` from `@supabase/realtime-js` and `^8.11.0` from jsdom.
  - No `overrides` entry was added, and `npm audit fix` was not run.
- `npm ci` leaves the lockfile unchanged, and `npm ls --all` exits 0. Each package resolves to a single copy, and every other resolution in the [baseline](#current-resolved-security-baseline) is unchanged.
- The patch adds one regression test, `src/__tests__/App.routes.test.tsx`; see [Browser behaviour](#browser-behaviour).

### Browser behaviour

Between 7.18.2 and 7.18.6, the browser-visible changes are:
- Route matching strips trailing slashes with a linear scan instead of two backtracking regular expressions. This is the GHSA-x8j4 fix, and the resolved route is unchanged.
- Since 7.18.3, `useNavigate()` and `<Navigate>` throw "External navigation is not allowed" for a target that resolves to another origin.
- Since 7.18.6, `<Link>` throws during render for an absolute URL that is not written out explicitly.
- `resolvePath` treats a leading backslash as absolute.

None of PaperLume's navigation targets can trigger those throws, and no route guard, redirect, authentication or session code changed.
- Every `<Link>` target is a literal internal path: `/`, `/dashboard` or `/privacy`.
- Every `navigate()` target is either a literal (`/`, `/auth`, `/dashboard`, `/privacy`) or a path the application builds itself:
  - `/auth?returnTo=…`, from `buildAuthPathWithReturnTo`;
  - the post-sign-in path from `parseSafeReturnTo`. It accepts only a rebuilt `/extension-import?…` path and otherwise falls back to `/`.

Before this change, no test exercised the route table. `src/__tests__/App.routes.test.tsx` now pins it under the real `BrowserRouter`:
- direct loads of every route, with and without a trailing slash;
- unknown and malformed paths rendering `NotFound` in place;
- `<Link>` navigation replayed with Back and Forward.

The test passes 13 of 13 against both 7.18.2 and 7.18.6, so it records existing behaviour.

### Build effect

Both sides were built from clean installs with CI's placeholder environment: base `main` `626f794f`, head the lockfile commit `3641b746`.
- **Web (`dist/`).** 7 of 9 files are byte-identical, including the stylesheet. The entry chunk grows from 1,951,890 B to 1,953,050 B: +1,160 B, and gzip 552.47 → 552.87 kB. `index.html` differs only in the entry chunk's name.
- **Extension (`dist-extension/`).** All 8 files are byte-identical. The extension does not bundle `react-router`.
- **The change is all `react-router` code.**
  - The unminified entry chunks differ in 12 hunks, all inside `react-router`.
  - Once the minifier's identifier renaming is normalized, the only differing region maps to `react-router`'s dist module, which grows by 1,148 B. The other 12 B are renaming.
- **Nothing else moved.**
  - Neither side bundles `set-cookie-parser`, `cookie` or `ws`.
  - The Supabase URL and key placeholders, the inlined environment keys and the route strings are identical, as are the counts of `.rpc(` and `.from("` calls.

### Residual: Vite's bundled `ws`

Vite 7.3.8 bundles its own copy of `ws` **8.18.3** inside `vite/dist`, and uses it for the development server's hot-reload WebSocket. Scanners cannot see it, because it has no `package-lock.json` entry, and this change does not move it.
- **Advisories.** That copy lies inside three `ws` advisories:
  - GHSA-37g9-w4hg-h9qr above, fixed in 8.23.0;
  - [GHSA-96hv-2xvq-fx4p](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p), memory exhaustion from tiny fragments, fixed in 8.21.0;
  - [GHSA-58qx-3vcg-4xpx](https://github.com/websockets/ws/security/advisories/GHSA-58qx-3vcg-4xpx), uninitialized memory disclosed when a typed array is passed as the `close()` reason, fixed in 8.20.1. Whether Vite's server code ever does that was not assessed.
- **Exposure.** The two memory-exhaustion advisories need a peer that can reach the development server. `server.host: "::"` makes `npm run dev` reachable from the network, as described under [Exposure](#exposure-the-development-server-not-production). The impact is a crashed development server. Production does not run it.
- **No fix on 7.3.x.** On 2026-11-23, 7.3.8 was the newest Vite 7.3.x release.

Reassess when a Vite 7.x release bundles `ws` 8.23.0 or later, or as part of a Vite major upgrade.

### What remains

This change leaves every other [open finding](#open-findings-2026-11-23) as it was. `npm audit` still measures 16 full and 7 production, Dependabot still shows 11 open alerts on `main`, and CodeQL still shows 18. Vite's bundled `ws` and `postcss-selector-parser` copies also remain, as described in their residual notes. Classifying the CodeQL alerts remains a separate track (**status: planning only**).

## CSS and build-toolchain patch set

**Status: REMEDIATED on `main`** (`PAPERLUME-SECURITY-CSS-BUILD-CLUSTER-001`). PR #369 merged on 2026-11-23 as `802d96b8`, and that day's automatic Production deployment, `dpl_EULvMp3j`, was built from it. Before the merge, `main` `ae201aff` resolved the "before" versions below, and Production `dpl_HjkGBrVw` was built with them. None of these packages ships: the built web and extension files are byte-identical with and without this change (see [Build and CSS equivalence](#build-and-css-equivalence)). The rest of this section was written while the pull request was open.

| Package | Before → after | Reached through | Advisories | Dependabot |
|---|---|---|---|---|
| `source-map-js` | 1.2.1 → **1.2.4** | `postcss` | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) (high, CVE-2026-93749): event-loop denial of service through indexed source-map section offsets, fixed in 1.2.2 | alert 8 |
| `brace-expansion` | 1.1.18 → **1.1.22**; nested 2.1.4 → **2.1.8** | `eslint` → `minimatch` 3.1.5 (1.x line); `typescript-eslint` → `@typescript-eslint/typescript-estree` → `minimatch` 9.0.9 (2.x line). A second 2.1.4 copy, under `glob`, is removed | [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) (high, CVE-2026-102276) and [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) (high, CVE-2026-102278): stack exhaustion; [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) (moderate, CVE-2026-102277): quadratic expansion; upstream-only [GHSA-6jwq-xf8q-xcwh](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-6jwq-xf8q-xcwh) (high): unbounded parsing and expansion work, fixed in 1.1.22 / 2.1.8 | alerts 1, 3, 5, 6 |
| `postcss-selector-parser` | 6.1.4 → **6.1.6**; nested 6.0.10 removed | `tailwindcss` and `postcss-nested`; 6.0.10 only through `@tailwindcss/typography` | [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) (moderate, CVE-2026-104844): quadratic flat-selector parsing, fixed in 6.1.5; upstream-only [GHSA-67xj-gfww-g738](https://github.com/postcss/postcss-selector-parser/security/advisories/GHSA-67xj-gfww-g738) (moderate): four more quadratic paths, fixed in 6.1.6 | alert 17 |
| `sucrase` | 3.35.0 → **3.35.1** | `tailwindcss`, which uses it to load `tailwind.config.ts` | none of its own; 3.35.1 replaces `glob` with `tinyglobby` | — |
| `glob` | 10.5.0 → **removed** | `tailwindcss` → `sucrase` 3.35.0 | [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) (moderate, CVE-2026-118773): AbortSignal cancellation bypass, fixed only in 14.0.2, outside `sucrase` 3.35.0's `^10.3.10` | alert 18 |
| `minimatch` | 9.0.9, two copies → **one copy** | the `glob` copy is removed; the `typescript-estree` copy remains | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) (moderate, CVE-2026-118764), fixed in 11.0.1; upstream-only [GHSA-c859-jr93-m5j4](https://github.com/isaacs/minimatch/security/advisories/GHSA-c859-jr93-m5j4) (moderate), fixed in 11.0.8 | alert 20 **stays open** |
| `@tailwindcss/typography` | 0.5.16 → **removed** | root `devDependencies` | none of its own; it exact-pins `postcss-selector-parser` 6.0.10 | — |

### Build-time exposure only

- Every package above runs in Node: during `vite build`, the development server, ESLint or TypeScript-ESLint. None is in the web bundle or the extension.
- `npm audit --omit=dev` counts several of them as production dependencies, and Dependabot gives alerts 1, 3, 5, 8, 17, 18 and 20 the "runtime" scope. That is the packaging artifact described under [NanoID](#introducing-path): `tailwindcss-animate` sits in root `dependencies` and declares `tailwindcss` as a peer.
- Their inputs come from the repository itself: its CSS, the source maps PostCSS handles, and the glob patterns in its ESLint and TypeScript-ESLint configuration. The production build writes no source map. Both `postcss-selector-parser` advisories state that build-time use on trusted CSS is not affected.
- As with [NanoID](#applicability), low exploitability is not the deciding factor. Compatible patched releases exist, so the [remediation policy](#remediation-policy) applies them.

### Version choices

- **`source-map-js` 1.2.4.**
  - 1.2.2 is the patched floor. 1.2.4 is the newest release (`latest`), and it is what `npm update` picks inside PostCSS's `^1.2.1`. The policy prefers the newest in-range version and forbids hand-editing lockfile fields.
  - 1.2.3 removes `new Function`. 1.2.4 fixes index-map lookups, including a stack overflow on maps with about 200,000 or more sources.
  - Both releases came from the package's sole maintainer, on 2026-11-18 and 2026-11-19. They declare no dependencies and no install scripts, and carry no provenance attestation.
  - Dependabot's PR #351 proposes the same version.
- **`brace-expansion` 1.1.22 and 2.1.8.** They carry the `1.x` and `2.x` maintenance dist-tags and were published on 2026-11-11. On those lines they are the only releases outside GHSA-6jwq. Their dependencies are unchanged.
- **`postcss-selector-parser` 6.1.6** (`legacy-v6`, 2026-11-08).
  - Since 6.1.5, the 6.x line receives security fixes only. It is kept for Tailwind 3, whose `^6.1.2` excludes 7.x.
  - 6.1.6 replaces its `cssesc` dependency with an internal linear copy, whose output upstream states is unchanged. `cssesc` leaves the tree.
- **`sucrase` 3.35.1** (`latest`, 2025-11-19). It depends on `tinyglobby` `^0.2.11` instead of `glob`. The tree already had `tinyglobby` 0.2.15 for Vite and Vitest, so nothing new is installed.

### The nested 6.0.10 copy, measured

The [remediation 002](#advisory-remediation-002--remediated) note that 6.0.10 lay outside the affected range was about GHSA-w9m9-85wc-3x92 (`>=6.1.0 <6.1.3`). It still holds for that advisory. GHSA-rj75's `<6.1.5` and GHSA-67xj's `>=4.0.0-rc.0 <6.1.6` both include 6.0.10, and timings confirm it is affected in practice.

Each input is one of the advisories' published shapes, scaled down. Each was parsed locally, under Node 26, by the package's registry tarball:

| Input | 6.0.10 | 6.1.4 | 6.1.6 |
|---|---|---|---|
| 40,000 flat classes, `.a.a…` (GHSA-rj75) | 384 ms | 359 ms | 22 ms |
| 20,000 digits, then 20,000 classes (GHSA-67xj) | 1,265 ms | 1,273 ms | 11 ms |
| 40,000 comment-only spaces (GHSA-67xj) | 1,520 ms | 1,773 ms | 16 ms |
| 4,000 parenthesis groups (GHSA-67xj) | 1,347 ms | 1,347 ms | 3 ms |
| 8,000 backslashes before a namespace bar (GHSA-67xj) | 1,026 ms | 926 ms | 1 ms |

On 6.0.10 and 6.1.4, doubling an input roughly quadrupled its time. No input was sent to Production or to a Preview.

### Removing `@tailwindcss/typography`

- It has been in `devDependencies` since the 2025-01-01 template commit `b331aa1`. No revision of `tailwind.config.ts` registers it, nothing imports it, and no component uses a `prose` class.
- Every release through 0.5.20, the newest, exact-pins `postcss-selector-parser` 6.0.10. Upgrading it cannot clear the advisories; removing it does.
- `lodash.castarray` and `lodash.isplainobject` leave with it. `lodash.merge` stays, for ESLint.
- **Negative control.** Registering the plugin in a copy of `main` grows the stylesheet from 79,637 B to 91,978 B and adds 81 `.prose` selectors. No component asks for them: Tailwind's content scan matches the English word "prose" in 13 comment and test lines under `src/`. The real stylesheet has no `.prose` rule, before or after this change.

### Lockfile delta

From `main` `ae201aff`:

```bash
npm uninstall @tailwindcss/typography --package-lock-only
npm update source-map-js brace-expansion postcss-selector-parser sucrase --package-lock-only
```

- `package.json` loses one line: the `@tailwindcss/typography` entry. No `overrides` entry was added, and `npm audit fix` was not run.
- `package-lock.json` goes from 561 to 525 entries. Nothing is added, and no version goes down.
  - **36 entries removed:**
    - `glob` 10.5.0 and its 30-entry subtree, including its `minimatch` 9.0.9 and `brace-expansion` 2.1.4 copies;
    - `@tailwindcss/typography`, with its nested `postcss-selector-parser` 6.0.10, `lodash.castarray` and `lodash.isplainobject`;
    - `cssesc`.
  - **5 version updates:** the four packages above, with `brace-expansion` on two lines.
  - **13 flag-only changes, with versions unchanged.**
    - Ten packages that only the removed `glob` subtree had made reachable from production become `dev`.
    - `tinyglobby`, `fdir` and `picomatch` 4.0.5 lose `dev`, because `sucrase` now reaches them.
  - The root entry's `devDependencies` change, matching `package.json`.
- The result is reproducible.
  - Running the update as one combined command gives a byte-identical lockfile.
  - A later `npm install --package-lock-only` changes nothing.
  - `npm ci` leaves the lockfile unchanged, and `npm ls --all` exits 0.
- Every `resolved` URL is on `registry.npmjs.org`, with sha512 integrity. `npm audit signatures` verified the registry signatures of all 466 installed packages, plus 67 provenance attestations.
- `tailwind.config.ts`, `postcss.config.js` and every other configuration file are unchanged.

### Build and CSS equivalence

Both sides were built from clean installs with CI's placeholder environment: `main` `ae201aff`, and this change's lockfile commit. They produced **byte-identical** output.
- **`dist/`:** the same 9 files, 2,077,049 B in total.
  - The stylesheet is `index-DF6xUHEF.css`: 79,637 B, SHA-256 `27bf46dd…`, with 1,127 rule blocks and 1,124 distinct class tokens.
  - It is byte-identical to the file Production serves.
- **`dist-extension/`:** the same 8 files, 22,279 B in total, including `popup.css`.
- **Builds and checks:** the build logs differ only in timings. Vite and its plugins, Tailwind, PostCSS, autoprefixer, browserslist and caniuse-lite resolve to the same versions. The lint, typecheck and Vitest results match `main`'s.

### Dependabot overlap

None of these pull requests was modified. At their current heads, all four had successful `validate`, `db-tests`, `e2e-local`, `e2e-evidence` and `extension` checks, and a neutral CodeQL result.

| PR | Head · base | Proposes | Relation to this change |
|---|---|---|---|
| #351 | `e200dc6f` · `626f794f`, behind `main` | `source-map-js` 1.2.4 | The same entry. Compared with current `main`, its lockfile also shows the three React Router entries going backwards, but only because its base predates `ae201aff` |
| #364 | `8b87184b` · `ae201aff` | `sucrase` 3.35.1, removing `glob` | All 45 entries it moves are identical here: the 31 removals, the 13 flag changes and `sucrase` |
| #366 | `710d7f9d` · `ae201aff` | `typescript-eslint` `^8.73.0` in `package.json`, `minimatch` 11.0.9, and the same `sucrase` change | Only the `sucrase` part is reproduced. The `typescript-eslint` family upgrade is out of scope |
| #367 | `e4c2f3d4` · `ae201aff` | `brace-expansion` 1.1.22 and 2.1.8, three entries | Two entries are identical here. The third, under `glob`, is removed |

After this change reaches `main`, expect Dependabot to rebase or close these pull requests on its own.

### What this leaves open

- **`minimatch` 9.0.9**, under `@typescript-eslint/typescript-estree` 8.38.0, which declares `^9.0.4`.
  - It stays inside GHSA-g3hv-75wg-m249 (alert 20) and the upstream-only GHSA-c859-jr93-m5j4.
  - `typescript-estree` 8.72.2 still declares `^10.2.2`. 8.73.0 is the first release to declare `^11.0.1`.
  - The `minimatch` 11.0.9 that range resolves today is also past two 11.x-only upstream advisories, GHSA-cf2h-pxjq-68xw and GHSA-hqmv-qgp3-jx75.
  - Fixing it needs the `typescript-eslint` family upgrade that Dependabot's PR #366 proposes. That belongs to the test-and-lint step in the [planned order](#open-findings-2026-11-23).
- **`@vitest/mocker`** (alerts 14 and 15) and **`zod`** (alert 16) are unchanged.
- **`npm audit` with this change:**
  - full: 10 (1 high / 9 moderate): `zod`; `minimatch` and the six `typescript-eslint` entries that reach it; `@vitest/mocker` and `vitest`;
  - production: 1, `zod`.
- **Upstream sweep with this change:** 5 matches, down from 23 on `main`. Three are real: `minimatch` (GHSA-c859) and the two indexed `@vitest/mocker` advisories. The other two are false positives:
  - `@eslint/plugin-kit`, GHSA-7q7g-4xm8-89cq. The upstream range is `*`; the database's is `<0.2.3`, and 0.3.4 is installed.
  - `esbuild`, GHSA-gv7w-rqvm-qjhr. The upstream range is an open-ended `>=0.17.0`, though it names 0.28.1 as patched. 0.28.1 is installed, and GitHub withdrew its database copy on 2026-06-17.
- **Bundled copies that no scanner sees**, unchanged by this change:
  - Vite 7.3.8 bundles `postcss-selector-parser` 7.1.0 and `ws` 8.18.3; see [Vite's bundled `postcss-selector-parser`](#residual-vites-bundled-postcss-selector-parser) and [Vite's bundled `ws`](#residual-vites-bundled-ws).
  - Vitest 4.1.11 bundles `ws`, and Vitest's release lockfile resolves it to 8.19.0. That is inside GHSA-37g9-w4hg-h9qr, GHSA-96hv-2xvq-fx4p and GHSA-58qx-3vcg-4xpx. Vitest serves its token-checked API WebSocket with it, which needs Vitest's UI, API or browser mode; none of these is configured here.
  - Rollup 4.59.0 bundles `picomatch`. Rollup's release lockfile resolves it to 4.0.3, and the bundled code lacks the extglob recursion limit added in 4.0.4. That puts it inside [GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj) (high, extglob ReDoS) and [GHSA-3v7f-55p6-f55p](https://github.com/advisories/GHSA-3v7f-55p6-f55p) (moderate). Rollup uses it only for include, exclude and watch patterns taken from build configuration.
- **CodeQL:** 18 open alerts, unchanged. They are a separate track.

## Test and lint toolchain patch set

**Status: remediated in this change's `package-lock.json`** (`PAPERLUME-SECURITY-TEST-LINT-CLUSTER-001`, Draft pull request opened 2026-11-23). The fix reaches `main` only when that pull request merges. On 2026-11-23, `main` `802d96b8` still resolved the "before" versions below, and Production `dpl_EULvMp3j` was built with them. None of these packages ships: the built web and extension files are byte-identical with and without this change (see [Build output comparison](#build-output-comparison)).

| Package | Before → after | Reached through | Advisories | Dependabot |
|---|---|---|---|---|
| `minimatch` | nested 9.0.9 → **11.0.9** | `typescript-eslint` → `@typescript-eslint/typescript-estree`. The root 3.1.5 copy, which ESLint uses, does not move | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) (moderate, CVE-2026-118764): denial of service through globparts amplification, `>=7.0.0 <11.0.1`; upstream-only [GHSA-c859-jr93-m5j4](https://github.com/isaacs/minimatch/security/advisories/GHSA-c859-jr93-m5j4) (moderate): `minimatch.escape()` output that matches more or less than its input, `>=7.4.0 <=11.0.7`, fixed in 11.0.8 | alert 20 |
| `@vitest/mocker` | 4.1.11 → **4.1.12** | `vitest` | [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) (moderate, CVE-2026-112949): code injection through unauthenticated manual-mock registration, `>=2.1.0-beta.7 <4.1.12`; [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp) (moderate, CVE-2026-112950): a Windows backslash traversal that bypasses the redirect allowlist added in 4.1.11, `>=4.1.11 <4.1.12` | alerts 14, 15 |
| `typescript-eslint` and the ten `@typescript-eslint/*` packages | 8.38.0 → **8.73.0** (declared `^8.73.0`) | root `devDependencies` | none of their own. 8.73.0 is the first `typescript-estree` release to declare `minimatch` `^11.0.1`; 8.72.2 still declares `^10.2.2` | — |
| `vitest` and the six other `@vitest/*` packages | 4.1.11 → **4.1.12** (declared `^4.1.12`) | root `devDependencies` | none of their own. `npm audit` lists `vitest` only as the parent of `@vitest/mocker` | — |

### Where the two families run

- Both are development tools. ESLint loads `typescript-eslint` during `npm run lint`, and `npm test` runs Vitest. Neither reaches the web bundle or the extension.
- **`minimatch` under `typescript-estree`.** `typescript-estree` uses it in one place: matching file paths against the project service's `allowDefaultProject` patterns. `eslint.config.js` enables neither `projectService` nor `project`, so lint never compiles a pattern with it, and any pattern it could compile would come from the repository's own configuration.
- **`@vitest/mocker`.** Both advisories sit in `interceptorPlugin`, the handler that accepts `vitest:interceptor:register` messages on a Vite development server's WebSocket. The public `mockerPlugin()` and `interceptorPlugin()` exports attach it.
  - No first-party file imports `@vitest/mocker`, `mockerPlugin` or `interceptorPlugin`. `@vitest/browser` and `@vitest/ui` are not installed, and `vitest.config.ts` sets no `browser`, `api` or `server` option.
  - Vitest's own Node runner imports only `hoistMocksPlugin` and `automockPlugin` from `@vitest/mocker/node`, in 4.1.11 and 4.1.12 alike.
  - The other function 4.1.12 hardens, `createManualModuleSource`, is reached in Vitest only through its native-module mocker. Vitest loads that mocker only when `experimental.viteModuleRunner` is `false`, and `vitest.config.ts` sets no `experimental` option.
  - GHSA-xp26 also needs Windows. CI runs on `ubuntu-24.04`, and the local development machine runs macOS.
  - The application's development server (`npm run dev`, `host: "::"`) loads only `@vitejs/plugin-react-swc`, not the interceptor plugin.
- Neither advisory's code path is therefore reachable in this repository's test setup. As with [NanoID](#applicability), the remediation does not rest on that. Compatible patched releases exist, so the [remediation policy](#remediation-policy) applies them.

### Why these versions

- **`typescript-eslint` 8.73.0** (2026-11-16).
  - It is the first release whose `typescript-estree` accepts `minimatch` 11.
  - Its peers are `eslint` `^8.57.0 || ^9.0.0 || ^10.0.0` and `typescript` `>=4.8.4 <6.1.0`. ESLint 9.32.0 and TypeScript 5.8.3 are installed, and neither changes. Its `engines` field is `^18.18.0 || ^20.9.0 || >=21.1.0`.
  - `typescript-estree` 8.73.0 adds an optional peer, `@typescript/native`, for the TypeScript 7 native preview. Because it is optional, nothing is installed for it.
  - 8.74.0 was published on 2026-11-23, the day of this change, and was not adopted. Its changelog lists rule features and fixes, none of them security fixes. A release less than a day old has also had no time to settle. `^8.73.0` admits it, so a later update can take it.
- **`minimatch` 11.0.9** (`latest`, 2026-11-16) is what `^11.0.1` resolves to. It is outside all seven advisories the `minimatch` repository has published, including the 11.x-only upstream advisories GHSA-cf2h-pxjq-68xw (`11.0.0`–`11.0.6`) and GHSA-hqmv-qgp3-jx75 (`11.0.3`–`11.0.7`). Its `engines` field is `20 || >=22`; CI runs Node 22 and Vercel runs Node 24.
- **`vitest` 4.1.12** (the `V4` dist-tag, 2026-10-15) is the newest 4.x release. 5.x would be a major upgrade, which is out of scope.
  - Its release notes list one change, the mocker hardening.
  - Its own published code differs from 4.1.11 only in the version string and two chunk file names.
  - `@vitest/mocker` 4.1.12 changes only the two code paths the advisories name. It serializes the module URL and export names with `JSON.stringify`, and it turns backslashes in a redirect path into forward slashes before the allowlist check.
- **`brace-expansion` 5.1.0** is new on this path, because `minimatch` 11.0.9 declares `^5.0.12`.
  - 5.0.12 is inside the upstream-only [GHSA-6jwq-xf8q-xcwh](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-6jwq-xf8q-xcwh), fixed in 5.0.13.
  - npm resolves the `latest` release, 5.1.0, published on 2026-11-23 at 15:56 UTC. Its `gitHead` is the upstream `v5.1.0` tag.
  - Compared with 5.0.13, its only code change is a `default` export alias for `expand`.

### Resolution and lockfile delta

From `main` `802d96b8`:

```bash
npm install --save-dev --package-lock-only typescript-eslint@8.73.0 vitest@4.1.12
```

- `package.json` changes two `devDependencies` declarations: `typescript-eslint` goes from `^8.38.0` to `^8.73.0`, and `vitest` from `^4.1.11` to `^4.1.12`. Raising the floors keeps a later resolution from dropping below the patched versions. No `overrides` entry was added, and `npm audit fix` was not run.
- `package-lock.json` goes from 525 to 527 entries. Every moved entry is dev-only, and no version goes down.
  - **28 version updates:**
    - `typescript-eslint` and its ten `@typescript-eslint/*` packages, 8.38.0 → 8.73.0, and the eight Vitest packages, 4.1.11 → 4.1.12;
    - the nested `minimatch` 9.0.9 → 11.0.9, and below it `brace-expansion` 2.1.8 → 5.1.0;
    - four packages whose old versions miss a new floor:
      - `semver` 7.7.2 → 7.8.6, for `^7.7.3`; `typescript-estree` is the only package that uses this copy;
      - `ts-api-utils` 2.1.0 → 2.5.0, for `^2.5.0`;
      - `@eslint-community/eslint-utils` 4.7.0 → 4.10.1, for `^4.9.1`;
      - `@eslint-community/regexpp` 4.12.1 → 4.12.3, for `^4.12.2`. ESLint's own ranges, `^4.2.0` and `^4.12.1`, accept both new versions;
    - three moves that no new floor requires: `chai` 6.2.2 → 6.3.0, `tinyrainbow` 3.1.1 → 3.2.0, and `ignore` 7.0.5 → 7.0.16, nested under `@typescript-eslint/eslint-plugin`.
      - Each one's only dependents are packages this change upgrades, and npm re-resolves such a dependency to the newest release in range.
      - `npm update`, `--prefer-dedupe` and both Dependabot pull requests produce the same three moves. Avoiding them would take a hand-edited lockfile or an `overrides` entry, which the policy forbids.
      - Each stays within its major version.
  - **3 additions:**
    - `eslint-visitor-keys` 5.0.1, nested under `@typescript-eslint/visitor-keys`, which now declares `^5.0.0`. ESLint 9 keeps the hoisted 4.2.1;
    - `minimatch` 11's two dependencies, `balanced-match` 4.0.4 (nested) and `@isaacs/nonrecursive-glob-match` 1.1.0.
  - **1 removal:** `graphemer` 1.4.0, which `@typescript-eslint/eslint-plugin` no longer uses.
  - There are no flag-only changes. The root entry's `devDependencies` change, matching `package.json`.
- **The result is reproducible.**
  - Running the two updates one at a time (twice) or as the single command above gives the same lockfile, SHA-256 `e01b6944…`.
  - A later `npm install --package-lock-only` changes nothing.
  - `npm ci` leaves the lockfile unchanged, and `npm ls --all` exits 0. The only new unmet optional dependency it lists is the `@typescript/native` peer.
- **Registry and provenance.**
  - Every `resolved` URL is on `registry.npmjs.org`, and every sha512 integrity matches the registry's. No moved or added entry has an install script.
  - `npm audit signatures` verifies the registry signatures of all 468 installed packages, and 80 provenance attestations. On `main` the figures are 466 and 67.
  - Four of the 31 moved or added entries carry no provenance attestation: `brace-expansion` 5.1.0, `balanced-match` 4.0.4, `ignore` 7.0.16 and `@isaacs/nonrecursive-glob-match` 1.1.0. The npm account that published each one is that package's maintainer.
  - `@isaacs/nonrecursive-glob-match` is new to the tree. It comes from `minimatch`'s author and declares no repository. Its `gitHead` matches the `v1.1.0` tag of `isaacs/nonrecursive-glob-match`, which has published no advisory. Its tarball has no install script, and its code makes no network, child-process, `eval` or `new Function` call.
- **What is left of each family.**
  - `minimatch` 3.1.5, used by ESLint, `@eslint/config-array` and `@eslint/eslintrc`, is outside every `minimatch` advisory; the 3.x line was fixed in 3.1.3 and 3.1.4. No 9.x copy remains.
  - `brace-expansion` resolves to 1.1.22 under `minimatch` 3.1.5 and to 5.1.0 under 11.0.9. Both are past GHSA-6jwq.

### Lint, typecheck and test comparison

Both sides were measured locally after a clean `npm ci`, on Node 26.5.1 and npm 11.17.0.
- **Lint.**
  - `npm run lint` reports 0 errors and 18 warnings on both sides, over the same 711 files. Every diagnostic matches on file, line, column, rule and message, and the whole output is identical apart from timing.
  - The 18 are the existing baseline: 9 `react-refresh/only-export-components`, 8 `react-hooks/exhaustive-deps` and 1 unused `eslint-disable` directive.
  - `eslint.config.js` is unchanged. The `tseslint.config()` helper it calls has been marked deprecated since 8.42.0, but only as a type annotation, and lint printed no warning.
- **Typecheck.** All three projects pass on both sides, with identical output.
- **Vitest.**
  - `npm test` passes 269 files and 8,895 tests on both sides. The same tests, identified by file and full name, are discovered and pass, and none is skipped.
  - The suite has no snapshot assertion, and no snapshot file was written. There is no coverage configuration.
  - It calls `vi.mock` 232 times in 78 files, and each call passes a factory. It also uses `vi.hoisted`, `vi.spyOn`, `vi.stubGlobal`, fake timers in 7 files and Testing Library in 87 files. 59 files run in the `node` environment and the rest in jsdom.
- **Extension lane.** `npm run test:extension:browser` passes 30 of 30 on both sides, with the same tests.
- **Other lanes.** The DB Tests lane installs this lockfile but runs neither Vitest nor ESLint. Each E2E job runs 58 Vitest guard tests in `test:e2e:local:verify-guards` before Playwright starts.

### Build output comparison

Both sides were built twice from clean `git archive` trees, with CI's placeholder environment and a clean `npm ci`. The base is `main` `802d96b8`, and the head is this change's lockfile commit `093212bd`.
- Each side's two builds are byte-identical, and so are the two sides: all 17 files have the same SHA-256.
- **`dist/`:** 9 files, 2,077,049 B. The stylesheet is `index-DF6xUHEF.css` (79,637 B, SHA-256 `27bf46dd…`), and the entry chunk is `index-CAniE2W6.js` (1,953,050 B).
- **`dist-extension/`:** 8 files, 22,279 B.
- The build logs differ only in timings. No package in the build chain moved: Vite and its React plugin, Rollup, esbuild, PostCSS, Tailwind, autoprefixer, browserslist and caniuse-lite all resolve as before.

### Reconciling the Dependabot pull requests

Neither pull request was modified.

| PR | Head · base | Proposes | Relation to this change |
|---|---|---|---|
| #370 | `e6db17a7` · `802d96b8` | `typescript-eslint` `^8.73.0` in `package.json`, and `minimatch` 11.0.9 | The same `package.json` line and the same 22 entries: 18 version updates, 3 additions and 1 removal. Its commit message says `minimatch` moves "from 3.1.5"; in fact the root 3.1.5 copy does not move, and the nested 9.0.9 copy does |
| #354 | `2e142798` · `626f794f`, behind `main` | `vitest` `^4.1.12` in `package.json` | The same `package.json` line and the same 10 entries: the eight Vitest packages, `chai` and `tinyrainbow` |

- The two pull requests touch disjoint entries, and neither depends on the other. `git merge-tree` combines their heads without conflict. The resulting tree, `2c57a307`, is this change's commit tree, so the fresh resolution from `main` reproduces both pull requests together, byte for byte.
- At their current heads, both had successful `validate`, `db-tests`, `e2e-local`, `e2e-evidence` and `extension` checks, and a skipped CodeQL check. #354's checks ran against its older base.
- Dependabot may close or rebase both after this change reaches `main`. Verify that separately.

### What remains after this change

- **`zod`** (alert 16) is the only finding left in either `npm audit` graph. There is no 3.x fix, so it needs the separate Zod 4 migration.
- **`npm audit` with this change:** full 1 and production 1, both `zod` (high). `npm audit` on this lockfile reports no indexed advisory that Dependabot lacks.
- **Upstream sweep with this change:** 1 match, down from 4 on `main`.
  - The three real matches on `main` are gone: `minimatch` GHSA-c859 and the two `@vitest/mocker` advisories.
  - The remaining match is the `@eslint/plugin-kit` false positive recorded for the CSS patch set: the upstream range is `*`, the database's is `<0.2.3`, and 0.3.4 is installed.
  - The CSS patch set's count also included `esbuild` GHSA-gv7w-rqvm-qjhr. That advisory is filed against esbuild's Deno module, and the sweep now counts only npm-ecosystem entries.
- **Bundled copies that no scanner sees** are unchanged. Vite 7.3.8 bundles `postcss-selector-parser` 7.1.0 and `ws` 8.18.3. Rollup 4.59.0 bundles `picomatch` 4.0.3. Vitest's bundled `ws` is also unchanged, because Vitest 4.1.12's published code differs from 4.1.11's only in its version string and chunk names.
- **CodeQL:** 18 open alerts, unchanged. They are a separate track.

## Open findings (2026-11-23)

Measured with the Vite 7.3.8 lockfile. "Upstream-only" means the advisory is published in the package's own repository but, on 2026-11-23, not in GitHub's Advisory Database. Neither Dependabot nor `npm audit` reports those.

| Package | Installed | Dependabot alerts | Advisories | Where it runs |
|---|---|---|---|---|
| `brace-expansion` | 1.1.18 · nested 2.1.4 (two copies) | 1, 3, 5, 6 | GHSA-6j4f-fj2g-mc7p and GHSA-qhr7-859c-m2p7 (high); GHSA-q2hr-2g5m-vwhr (moderate); upstream-only GHSA-6jwq-xf8q-xcwh (high), fixed in 1.1.22 / 2.1.8. 1.1.22 / 2.1.8 in the [CSS and build-toolchain patch set](#css-and-build-toolchain-patch-set) | lint and build tooling, through `minimatch` |
| `source-map-js` | 1.2.1 | 8 | GHSA-68fv-2mgg-jv7q (high). 1.2.4 in the CSS and build-toolchain patch set | PostCSS, at build time |
| `@vitest/mocker` | 4.1.11 | 14, 15 | GHSA-xp26-3454-mjgp and GHSA-qxg6-89mg-rqv8 (moderate). 4.1.12 in the [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set) | Vitest; no browser mode, UI or API server is configured |
| `zod` | 3.25.76 | 16 | GHSA-mrhx-c7xc-m3w5 (high); no 3.x fix, patched in 4.6.6 | **web bundle** |
| `postcss-selector-parser` | 6.1.4 · nested 6.0.10 | 17 | GHSA-rj75-hqrm-r3gf (moderate); upstream-only GHSA-67xj-gfww-g738 (moderate), fixed in 6.1.6. 6.1.6, with 6.0.10 removed, in the CSS and build-toolchain patch set | Tailwind, at build time. 6.0.10 is pinned by `@tailwindcss/typography`, which no config or source file uses |
| `glob` | 10.5.0 | 18 | GHSA-3g3m-2fjr-6pw4 (moderate). Removed with `sucrase` 3.35.1 in the CSS and build-toolchain patch set | installed under `sucrase`; only `sucrase`'s CLI loads it |
| `minimatch` | 9.0.9 (two copies) | 20 | GHSA-g3hv-75wg-m249 (moderate). `npm audit` reports it, and Dependabot opened alert 20 for it when the Vite lockfile reached `main` (see [Current audit state](#current-audit-state)). Also upstream-only GHSA-c859-jr93-m5j4 (moderate). The CSS and build-toolchain patch set removes the `glob` copy; the `typescript-estree` copy remains (see [What this leaves open](#what-this-leaves-open)). 11.0.9 in the [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set) | lint and build tooling |
| `react-router` | 7.18.2 | — | upstream-only GHSA-x8j4-g9rr-8j87, GHSA-qhgm-jj2j-75wj and GHSA-2rq8-3rm6-2w8f (high); GHSA-7m2v-44vx-v55w, GHSA-8wpx-2pj4-ggvx and GHSA-mjj8-rxh9-q8f5 (moderate); all six fixed by 7.18.5. 7.18.6 on `main` since `ae201aff` ([React Router patch set](#react-router-patch-set--7186)) | **web bundle**. Only GHSA-x8j4 (CPU use in route matching) applies to the declarative SPA; the others need data, framework or RSC modes |
| `set-cookie-parser` | 2.7.2 | — | upstream-only GHSA-mxfr-qhmh-pcx4 (high), fixed in 2.7.3. 2.7.3 on `main` since `ae201aff` | a `react-router` dependency; not in any shipped bundle |
| `ws` | 8.21.3 | — | upstream-only GHSA-37g9-w4hg-h9qr (high), fixed in 8.23.0. 8.23.0 on `main` since `ae201aff` | Node only, and in practice only jsdom's `WebSocket` in Vitest. `@supabase/realtime-js` 2.93.3 declares it but never imports it |

The React Router patch set merged as `ae201aff`, so the last three rows are resolved on `main`. The [CSS and build-toolchain patch set](#css-and-build-toolchain-patch-set) merged as `802d96b8`, so the `brace-expansion`, `source-map-js`, `postcss-selector-parser` and `glob` rows are resolved on `main` too. The `@vitest/mocker` and `minimatch` rows stay open on `main` until the [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set) merges. The `zod` row stays open after that.

**Planned order (status: planning only).** Each step will be its own bounded PR, re-measured before it starts:
1. the React Router patch set (merged 2026-11-23 as `ae201aff`; see [React Router patch set](#react-router-patch-set--7186));
2. the CSS and build toolchain: `brace-expansion`, `source-map-js`, `postcss-selector-parser`, `sucrase`, and removing the unused `@tailwindcss/typography` (merged 2026-11-23 as `802d96b8`; see [CSS and build-toolchain patch set](#css-and-build-toolchain-patch-set));
3. the test and lint toolchain: `vitest` and `typescript-eslint`, which carries the last `minimatch` copy (Draft pull request opened 2026-11-23; see [Test and lint toolchain patch set](#test-and-lint-toolchain-patch-set));
4. a separate Zod 4 migration, which needs application changes.

The 18 open CodeQL alerts are outside this document; see [Purpose and authority](#purpose-and-authority).

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

## Advisory remediation 002 — REMEDIATED

**Status: REMEDIATED** (`DEPENDENCY-ADVISORY-REMEDIATION-002`, 2026-09-17). Like the `nanoid` fix, this was a standalone bounded task, not a cluster. It cleared every advisory from the September 2026 re-measurement that had a fix inside an existing semver range. All five advisories below are now absent from **both** the full and the production audit graph. The one advisory it left open was the [Vitest residual](#vitest-residual--remediated-by-a-major-upgrade), which a separate major upgrade has since remediated (2026-09-20).

| Package | Advisory | Severity | Affected → patched floor | Installed → resolved | Existing range that permits it | Graph |
|---|---|---|---|---|---|---|
| `browserslist` | [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) (CVE-2026-73089) — unbounded memory growth via distinct query results · [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) (CVE-2026-73088) — crash / prototype write via untrusted custom stats | **High** (npm package aggregate; advisory attribution differs — see note) | `<=4.28.6` → 4.28.7 | 4.25.1 → **4.29.0** | `autoprefixer@10.4.21`: `^4.24.4` (`update-browserslist-db` peer: `>= 4.21.0`) | dev only |
| `js-yaml` | [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) (CVE-2026-84375) — `maxTotalMergeKeys` does not limit CPU for empty merge sources | **High** | `>=4.0.0 <4.3.2` → 4.3.2 | 4.3.1 → **4.3.2** | `@eslint/eslintrc@3.3.1`: `^4.1.0` | dev only |
| `@humanfs/node` | [GHSA-p498-v437-472g](https://github.com/advisories/GHSA-p498-v437-472g) (no CVE) — recursive copy follows symlinked files outside the source tree | Moderate | `<0.16.8` → 0.16.8 | 0.16.6 → **0.16.8** | `eslint@9.32.0`: `^0.16.6` (i.e. `>=0.16.6 <0.17.0`) | dev only |
| `postcss-selector-parser` | [GHSA-w9m9-85wc-3x92](https://github.com/advisories/GHSA-w9m9-85wc-3x92) (CVE-2026-9358) — DoS through uncontrolled AST recursion | Low | `>=6.1.0 <6.1.3` → 6.1.3 (also `>=7.1.0 <7.1.3`) | 6.1.2 → **6.1.4** | `tailwindcss@3.4.17`: `^6.1.2` · `postcss-nested@6.2.0`: `^6.1.1` | **production graph** |

**Severity attribution for `browserslist`:** the table's **High** is the severity `npm audit` assigns to the `browserslist` package entry as a whole. The two advisories behind it are not rated the same way by every source:

- [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) is **High** in the upstream `browserslist/browserslist` repository advisory and **High** in GitHub's central Advisory Database.
- [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) is labelled **Moderate** by the upstream repository advisory, while GitHub's central reviewed Advisory Database rates it **High**. `npm audit`'s per-advisory entry carries the central rating.
- The remediation threshold is unaffected: both advisories affect `<=4.28.6` and are patched from `4.28.7`, and `browserslist` now resolves to `4.29.0`.

As with [GHSA-qwww-vcr4-c8h2](#advisories-cleared), both attributions are preserved rather than collapsed (as observed 2026-09-17).

Each resolution is the **newest version its existing range permits**, not the bare patched floor: 4.29.0 is the newest 4.x `browserslist` (`latest`), 4.3.2 the newest 4.x `js-yaml` (`v4-legacy`; the range excludes 5.x), 0.16.8 the newest `@humanfs/node` below 0.17.0, and 6.1.4 the newest 6.x `postcss-selector-parser` (`legacy-v6`; the range excludes 7.x). None of the four crossed a major version.

`postcss-selector-parser` is the only one in the production graph, and it has the same **packaging-artifact** path as `nanoid`: `tailwindcss-animate` (root `dependencies`) → `tailwindcss` (peer) → `postcss-selector-parser`. It is build-time CSS tooling, not shipped runtime code. A second, nested copy, **6.0.10**, is exact-pinned by `@tailwindcss/typography@0.5.16` (`"6.0.10"`). It lies outside both affected ranges, npm does not report it, and it was left unchanged.

### Applied remediation

One name-scoped, lockfile-only update per package, each diffed and re-audited before the next:

```bash
npm update browserslist --package-lock-only
npm update js-yaml --package-lock-only
npm update @humanfs/node --package-lock-only
npm update postcss-selector-parser --package-lock-only
```

`js-yaml` and `postcss-selector-parser` moved with **no collateral** (`version`, `resolved` and `integrity` only). The two other updates moved exactly eight further lockfile entries. Each move is required by the new target's own published `dependencies`, and each lands on the newest version the new range permits:

| Collateral entry | Change | Why it moved | Range now satisfied |
|---|---|---|---|
| `caniuse-lite` | 1.0.30001727 → 1.0.30001810 | `browserslist@4.29.0` raised its floor from `^1.0.30001726` | `^1.0.30001810` (and `autoprefixer`'s `^1.0.30001702`) |
| `electron-to-chromium` | 1.5.192 → 1.5.430 | floor raised from `^1.5.173` | `^1.5.427` |
| `node-releases` | 2.0.19 → 2.0.56 | floor raised from `^2.0.19`; the entry also records that release's own `engines` (`node >=18`) | `^2.0.55` |
| `update-browserslist-db` | 1.1.3 → 1.3.3 | floor raised from `^1.1.3`; its own dependencies are unchanged | `^1.3.3` |
| `baseline-browser-mapping` | *added* 2.11.24 | new dependency of `browserslist@4.29.0` | `^2.11.23` |
| `@humanfs/core` | 0.19.1 → 0.19.2 | `@humanfs/node@0.16.8` raised its floor from `^0.19.1` | `^0.19.2` |
| `@humanfs/types` | *added* 0.15.0 | new dependency of `@humanfs/node@0.16.8` and `@humanfs/core@0.19.2` | `^0.15.0` |
| `@humanfs/node/node_modules/@humanwhocodes/retry` | *removed* 0.3.1 | `@humanfs/node@0.16.8` moved its range from `^0.3.0` to `^0.4.0`, which the already-hoisted, unchanged 0.4.3 (also used by `eslint`) satisfies, so the nested duplicate is gone | `^0.4.0` |

All eight are dev-only. No new or moved entry is flagged `hasInstallScript` in the lockfile. `browserslist@4.29.0` was published on 2026-09-15. It, `update-browserslist-db@1.3.3` and `baseline-browser-mapping@2.11.24` carry npm provenance attestations.

Per the [Remediation policy](#remediation-policy):

- the dependency delta is confined to `package-lock.json`. `package.json` was **not** modified (verified byte-identical by SHA-256), no `overrides` entry was added, and no package became a direct dependency;
- no application-source, test, config or workflow change was required;
- **shipped output changed in exactly one CSS rule.** Built side by side, `main` `20b57562` and this lockfile give byte-identical `dist-extension/` output and byte-identical web JavaScript content (only its hashed file name moves, and `index.html` changes only to reference the renamed assets). In the web CSS, the refreshed `caniuse-lite` data drops the `-webkit-backdrop-filter` fallback from the Tailwind `.transition` utility's `transition-property`. The repository has no browserslist config, and autoprefixer's `defaults` query no longer includes iOS Safari 16.6–17.7. The one element using a backdrop utility (`backdrop-blur` in `BulkActionsToolbar`) keeps Tailwind's own `-webkit-backdrop-filter` declaration and does not use `.transition`;
- no blanket `npm update` and no `npm audit fix` (forced or otherwise) was run;
- after `node_modules` was removed, `npm ci` reproduced the tree from the committed lockfile without mutating it, and `npm ls --all` reports no invalid, missing or extraneous node;
- the full audit went from **6 (2 high / 3 moderate / 1 low)** to **2 moderate**, and the production audit from **1 low** to **zero**.

## Vitest residual — REMEDIATED by a major upgrade

**Status: REMEDIATED** (`VITEST-SECURITY-MAJOR-UPGRADE-001`, 2026-09-20). The advisory is absent from **both** the full and the production audit graph. **The vulnerable 3.2.7 versions are no longer installed; `vitest` and `@vitest/mocker` remain installed, at patched 4.1.11** — outside the affected range. The remediation moved the resolved versions off the affected range; it did not remove either package from the dependency graph. It was dev/test scope throughout and never appeared in the production graph.

**Why it needed a major.** Upstream states that the 2.1.x and 3.x lines "are not maintained and are not planned to receive the fix", so no in-range 3.x remediation existed. **4.1.11** was chosen over the 5.x line because it is the first patched *stable* release and the smallest security-sufficient transition — one major boundary instead of two. (At the time of the upgrade the advisory's 5.x patched version was `5.0.0-rc.2`, a release candidate.) `^3.2.4` → `^4.1.11` is the only `package.json` change.

| Field | Value |
|---|---|
| Advisory | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) (CVE-2026-84373) — "Vitest: Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock" (CWE-22) |
| Severity | Moderate (CVSS 3.1 5.9, `AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N`) |
| Affected | `vitest` and `@vitest/mocker` `>=2.1.0 <4.1.11`, plus the 5.0.0 pre-releases before `5.0.0-rc.2` |
| Patched | **4.1.11** (v4 line) and **`5.0.0-rc.2`** (v5 prerelease line; later v5 releases are also patched). Upstream states that older majors (2.1.x, 3.x) "are not maintained and are not planned to receive the fix" |
| Installed **now** | `vitest` **4.1.11** (root `devDependencies`, declared `^4.1.11`; 4.1.11 is the `V4` dist-tag) · `@vitest/mocker` **4.1.11** — **both outside the affected range** |
| Installed **before** (historical) | `vitest` **3.2.7** (declared `^3.2.4`; 3.2.7 was the newest 3.x) · `@vitest/mocker` **3.2.7** (exact-pinned by `vitest`) |
| Audit representation **before** | Two moderate entries: `@vitest/mocker`, and `vitest` through it. `npm audit fix --force` proposed `vitest@5.0.1`, a breaking move across two majors, and was not used |

### Applicability — what was and was not established (2026-09-17, historical)

> **Historical — read every statement below as of 2026-09-17, against the then-installed 3.2.7.** Some of its bullets are written in the present tense of that measurement ("the vulnerable code **is** installed"); that tense refers to the 3.2.7 install, which is no longer the installed version. The analysis is retained because it records how the exposure was bounded while the residual was open, and because its method is the template for a future residual. It is **not** the reason the advisory is now absent — that reason is that `vitest` and `@vitest/mocker` now resolve to patched **4.1.11** instead of the affected 3.2.7, not that either package left the graph.

Per the advisory, the file-read sink is the `interceptorPlugin` `load` hook in `@vitest/mocker`. For a registered redirect mock it returns `readFile(mock.redirect)` with no `server.fs` boundary check. That registration is **unauthenticated** only through the public `mockerPlugin` / standalone `interceptorPlugin` exports, which listen for `vitest:interceptor:register` on Vite's HMR WebSocket. Vitest browser mode registers mocks over a token-authenticated RPC instead.

- **Established: the vulnerable code is installed.** `@vitest/mocker@3.2.7`'s `dist/node.js` contains both the `readFile(mock.redirect, …)` sink and the `server.ws.on("vitest:interceptor:register", …)` registration.
- **Established: no use of the plugin exports.** No first-party source, config, script or workflow imports `@vitest/mocker`, `mockerPlugin` or `interceptorPlugin`, and no other installed package references them. On its own node/jsdom path, Vitest 3.2.7 wires in only `hoistMocksPlugin` and `automockPlugin`.
- **Established: no browser mode, UI or API server.** `@vitest/browser` and `@vitest/ui` are not installed. `vitest.config.ts` sets no `browser`, `api` or `server` option. `npm test` is `vitest run` and `npm run test:watch` is `vitest`, and no `--browser`, `--ui` or `--api` flag appears anywhere.
- **Established: Vitest opens no network listener here.** Without an API port, Vitest 3.2.7 builds its Vite server in middleware mode with `hmr: false` and never calls `listen()`. A live probe of `vitest --watch` found no inet socket of any kind anywhere in its process tree. A positive control with `--api.port 51299` produced a `[::1]:51299` LISTEN socket, which shows the probe does detect listeners.
- **Established: the suite registers no redirect mocks.** A TypeScript AST scan found 139 `vi.mock` calls across 52 files. Every call passes an inline factory. There is no factory-less `vi.mock`, no `{ spy: true }` option, no `vi.doMock`, and no `__mocks__` directory.
- **Recorded, but not a path to this advisory:** the application dev-server config `vite.config.ts` sets `host: "::"` (port 8080), so `npm run dev` is reachable beyond loopback. That server loads only `@vitejs/plugin-react-swc`, not the interceptor plugin, so the unauthenticated registration handler is never attached to its HMR socket. Vitest itself reads `vitest.config.ts`, which takes precedence and sets no host.
- **Not established:** that the advisory can never apply. Adopting browser mode, `@vitest/browser`, the mocker plugin exports, a Vitest UI or API server, or redirect mocks would change this conclusion, and the sink stays in the installed package until the upgrade.

These findings **bounded the exposure** while the residual was open. They were never a claim that the advisory was inapplicable, and they were not why it stayed open — it stayed open because no compatible patched release existed on 3.x. That gap is now closed by the upgrade rather than by the analysis.

### Why remediation 002 did not upgrade it (historical)

- There is no in-range fix: every patched release crosses a major (`^3.2.4` → ≥ 4.1.11 or 5.x), so any fix changes `package.json`.
- Under the [Remediation policy](#remediation-policy), a major upgrade is separate bounded work. A test-runner major can require configuration and test changes and must be verified against the whole suite on its own terms. It also should not ride along with a lockfile-only fix.
- No `overrides` entry was added, and a patched 4.x `@vitest/mocker` was not forced under the 3.x `vitest`, because that would silence the finding rather than fix it.

That separately authorized Vitest-major task is the one that closed this: `VITEST-SECURITY-MAJOR-UPGRADE-001` (2026-09-20).

### The upgrade, as performed (2026-09-20)

- **Compatibility, re-verified at the time:** `vitest@4.1.11` declares a `vite` peer of `^6.0.0 || ^7.0.0 || ^8.0.0` (installed: **7.3.6**, unchanged by the upgrade) and `node` engines of `^20.0.0 || ^22.0.0 || >=24.0.0` (CI runs **22.x** on all four workflows).
- **Dependency delta:** `package.json` changed one line. The lockfile moved **26** packages, every one inside the Vitest subtree and every one `dev`: 13 version changes (`vitest` and the seven `@vitest/*` siblings to 4.1.11, plus `chai` 6.2.2, `es-module-lexer` 2.3.2, `std-env` 4.2.0, `tinyexec` 1.3.1, `tinyrainbow` 3.1.1), 3 additions (`@standard-schema/spec`, `convert-source-map`, `obug`), and 10 removals — including `vite-node`, which Vitest 4 replaces with Vite's Module Runner, and `tinypool`/`tinyspy`, which v4 restructured. No application dependency moved and `vite` stayed at 7.3.6.
- **Test migration required: none.** All 169 test files and 5,567 tests passed unchanged. The repository used none of the v4 breaking-change surfaces — no pool/worker options, no `poolMatchGlobs`/`environmentMatchGlobs`, no `deps.inline`/`deps.external`, no snapshots at all, no browser mode, no coverage config, no custom reporters, no `vite-node`/`vitest/execute` usage, and no object-form third argument to `test()`.
- **One typecheck fix was required**, in `tsconfig.extension.json`. Vitest 4 removed an accidental `@types/node` inclusion: Vitest 3's `dist/index.d.ts` imported from `node:vm`, which pulled `@types/node` into any program referencing `vitest/globals`. Three suites under `extension/src/__tests__/` import `node:fs`/`node:path`/`node:url` to read committed source, so they had always depended on that leaked type and began failing `typecheck:extension` under v4. The fix adds `"node"` to that project's `types` array, making an existing dependency explicit; `@types/node` was already a devDependency. It is a type-visibility change only — the extension's real no-Node/no-network boundary is asserted against committed source text by `extension/src/__tests__/sourceBoundary.test.ts` and is unchanged.
- **No production source, Edge function, migration or runtime configuration changed.**

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

**Re-checked 2026-11-23 (React Router patch set).** The profile above describes Cluster 5. Since then it has changed in two ways, both still within declarative mode:
- **`<Link>` is now rendered in four places**, always with a literal internal target:
  - `/privacy`, from the account menu and from the auth page footer;
  - `/`, from the Privacy page header;
  - `/dashboard`, twice on the extension-import page.
- **There are now eight `navigate()` call sites, in six components.**
  - Most targets are literals: `/`, `/auth`, `/dashboard` and `/privacy`.
  - Two are paths the application builds itself: `/auth?returnTo=…` for the extension handoff, and the post-sign-in target from `parseSafeReturnTo`.
  - `parseSafeReturnTo` rebuilds an `/extension-import?…` path from validated fields, and otherwise falls back to `/`. Anyone can put a value in the `returnTo` query parameter, so the path is rebuilt rather than echoed.

There is still no data router, no loader or action, no `<Navigate>`, and no SSR or hydration. [Browser behaviour](#browser-behaviour) covers how 7.18.6's navigation-target validation meets these call sites.

## Remediation policy

The approach established across Clusters 1–3, to be followed by future dependency work:

- **Re-measure before mutating.** Run a clean `npm ci` and capture `npm audit --json` (full and `--omit=dev`) on the exact starting commit; advisory databases move.
- **Map advisory → dependency path** (`npm ls`, `npm explain`) before choosing a fix. Know the introducing parent and its declared semver range.
- **Prefer the smallest compatible change**: a lockfile-only resolution inside the parent's existing range. Prefer the newest safe version that range already permits over pinning the bare patched floor.
- **Bound the blast radius.** Use name-scoped `npm update <pkg>`; never a blanket `npm update`. Enumerate and justify every collateral resolution change; unrelated churn is reduced, not accepted.
- **Never `npm audit fix --force`.** Never hand-edit generated lockfile version/resolved/integrity fields, and never add an `overrides` entry merely to silence a finding.
- **Major-version upgrades are separate bounded work**, especially when they require application source changes.
- **Verify reproducibility**: `npm ci` must succeed against the committed lockfile without mutating it.
- **Keep CI green**: the required `Validate` and `DB Tests` gates, plus the non-required `E2E (local)` and `Extension` workflows, must pass on the exact head. `DB Tests` has been a required check since 2026-08-16 (decision D5 in [decisions-and-triggers.md](decisions-and-triggers.md)). Dependency PRs carry no migration and perform no Supabase mutation.

## Verification commands

```bash
npm ci                       # clean install; must not mutate package-lock.json
npm audit                    # full graph (nonzero exit is expected while findings remain)
npm audit --omit=dev         # production graph
npm ls <package> --all       # every installed occurrence
npm explain <package>        # introduction path and parent semver range
gh api "repos/<owner>/<repo>/security-advisories?state=published"   # advisories a package's own repository has published
```

On 2026-11-23 both `npm audit` and `npm audit --omit=dev` exit **nonzero** because of the [open findings](#open-findings-2026-11-23). Compare each entry with that list; anything not on it is new and needs investigating. `npm audit` reads only GitHub's Advisory Database. It cannot report an advisory that a package's own repository has published before GitHub lists it, as happened with the Vite RCE. *(Both commands exited zero as measured on 2026-09-20. Before that measurement, the full audit was expected to exit nonzero because of the Vitest residual.)*

## Re-evaluation triggers

Revisit this document when any of the following occurs. By 2026-11-23 the first trigger, the Vitest trigger, the React Router trigger and the Router-usage trigger had all fired. Apart from the Vite remediation, the merged [React Router](#react-router-patch-set--7186) and [CSS and build-toolchain](#css-and-build-toolchain-patch-set) patch sets and the proposed [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set), the [open findings](#open-findings-2026-11-23) are planned for remediation one bounded PR at a time (**status: planning only**).

- **any** advisory appears in **either** graph. This is the primary trigger, and a new high or critical fires it urgently. (Before 2026-09-20 this trigger excluded the known Vitest residual; with that remediated, there is no excluded finding.)
- the installed Vitest line falls out of support again, or a new advisory is published against the 4.x line. The 2026-09-20 upgrade moved `vitest` and `@vitest/mocker` off the affected versions onto patched 4.1.11 (both packages are still installed), so the former applicability caveats no longer gate anything. Adopting browser mode or `@vitest/browser`, `mockerPlugin`/`interceptorPlugin`, a Vitest UI/API server or a `host` on the Vitest config would still widen the runner's exposure surface, and is worth a re-measure on its own;
- a **new React Router advisory** is published, particularly one whose affected range reaches the installed version, **7.18.6** since the [React Router patch set](#react-router-patch-set--7186). That would move the floor again and require re-measuring the v7 line (and re-examining whether v8, still out of scope today, has become necessary);
- Paperlume's Router usage changes in a way that alters the exposure profile — a navigation target stops being a hardcoded literal, `<Link>`/`<NavLink>` starts being rendered, a data router is adopted, or SSR/hydration is introduced;
- a dependency upgrade requires application source changes, a workflow change, or a `package.json` change;
- a change adds `@tailwindcss/typography` back. Every release through 0.5.20 exact-pins `postcss-selector-parser` 6.0.10, which is inside GHSA-rj75-hqrm-r3gf and GHSA-67xj-gfww-g738 (see [Removing `@tailwindcss/typography`](#removing-tailwindcsstypography));
- any baseline version in [Current resolved security baseline](#current-resolved-security-baseline) regresses;
- the toolchain moves to a new major (Vite, Vitest, or Node engine), which can re-open transitive ranges;
- a package's own repository publishes an advisory that covers an installed version before GitHub's Advisory Database lists it.

## Deployment note

Dependency changes ship like any other frontend change: merging to `main` triggers the automatic Vercel Production deployment. They involve **no** Supabase deployment step — Supabase migrations and Edge Functions are deployed separately and manually per [deployment.md](deployment.md), and none of the five clusters touched them.
