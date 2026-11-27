# Dependency Security

> **Status: active.** This is the authoritative current-state document for npm dependency security: what `npm audit` reports **now**, which bounded remediation work is complete, what remains deferred, and the policy future remediation follows. Historical implementation evidence (advisory tables, dependency paths, CI logs, merge topology) is **not** duplicated here — it lives in Git history, the merged PRs, and `package-lock.json`.

## Purpose and authority

- This document owns the **current dependency-security posture** and the **remediation policy**. When an audit result or a remediation boundary changes, fix this file.
- It is **not** a chronology. Per-cluster implementation detail belongs to the merged PRs listed below.
- Supabase/Postgres security (RLS, RPC grants, Auth advisors) is a separate concern owned by [decisions-and-triggers.md](decisions-and-triggers.md) and [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md). Dependency remediation has never changed schema, RLS, migrations, or Supabase Production.
- GitHub code-scanning (CodeQL) alerts concern first-party code, not dependencies, and this document does not count them. On 2026-11-23, 18 were open on `main`. A read-only triage classified all 18 that day; its outcome is recorded under [CodeQL triage outcome](#codeql-triage-outcome-2026-11-23). On `main` `cec11199` on 2026-11-24, 18 were still open, and on `main` `a110b4ce` later that day still 18. The [BibTeX codec](#bibtex-codec-and-record-integrity-codeql-q1) work for repair group Q1 merged that evening as `ded56c63`. CodeQL's analysis of that commit closed alerts 7 and 9–15 and left 10 open, and 10 were still open on 2026-11-25. The first-party [CSV formula injection](#csv-formula-injection-cwe-1236) finding is recorded here too, although no CodeQL rule reports it. So is [BibTeX citation-key uniqueness](#bibtex-citation-key-uniqueness), whose fix merged on 2026-11-25 as `a9c40ea6`. CodeQL's analysis of that commit reported the same 10 open alerts, and 10 were still open on 2026-11-27. So is [RIS record integrity](#ris-record-integrity), whose fix is proposed in a Draft pull request.

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

**After the test and lint toolchain patch set merged (2026-11-23).** PR #371 merged at 18:43:58 UTC as `94ef1b2c`, and Production `dpl_8tc4Jr8v` was built from it. On that commit, `npm audit` measured 1 full and 1 production finding, both `zod`, as projected above. Dependabot reported alerts 14, 15 and 20 fixed at 18:45:15 UTC and opened none, which left **1 open alert**: 16 (`zod`). CodeQL still showed 18.

**With the [Zod 4 migration](#zod-4-migration) (2026-11-23).** Its lockfile (`package-lock.json` SHA-256 `48869379…`) measured **0** full and **0** production findings. Dependabot closes an alert only after a change reaches `main`, so alert 16 stayed open until the migration merged. Closing it would leave no open Dependabot alert, but that was a projection, to be re-read after the merge.

**After the Zod 4 migration merged (2026-11-24).** PR #372 merged at 04:43:34 UTC as `cec11199`, and Production `dpl_413PdQNt` was built from it; it was READY at 04:44:02 UTC. On that commit, `npm audit` measured 0 full and 0 production findings, as projected above. Dependabot reported alert 16 fixed at 04:44:17 UTC and opened none, which left **0 open alerts**. CodeQL still showed 18. Re-measured at 07:45 UTC the same day, all of these were unchanged.

**After the CSV export hardening merged (2026-11-24).** PR #373, a first-party change with no dependency delta, merged at 09:40:45 UTC as `a110b4ce` (see [CSV formula injection](#csv-formula-injection-cwe-1236)). Re-measured on that commit at 10:10 UTC: `npm audit` 0 full and 0 production findings after a clean `npm ci`, **0 open Dependabot alerts**, 18 open CodeQL alerts and 0 secret-scanning alerts.

**After the BibTeX codec merged (2026-11-24).** PR #374, a first-party change with no dependency delta, merged at 22:43:26 UTC as `ded56c63` (see [BibTeX codec and record integrity](#bibtex-codec-and-record-integrity-codeql-q1)). Re-measured on 2026-11-25 between 06:10 and 06:35 UTC: `npm audit` on that commit found 0 full and 0 production findings after a clean `npm ci`, with `package-lock.json` SHA-256 `48869379…`, unchanged since the Zod 4 migration. GitHub showed **0 open Dependabot alerts**, 10 open CodeQL alerts and 0 secret-scanning alerts. The CodeQL count fell from 18 because that merge fixed alerts 7 and 9–15.

**After the citation-key uniqueness fix merged (2026-11-25).** PR #375, a first-party change with no dependency delta, merged at 21:02:19 UTC as `a9c40ea6` (see [BibTeX citation-key uniqueness](#bibtex-citation-key-uniqueness)). The post-merge qualification that evening reported `npm audit` 0 full and 0 production findings after a fresh `npm ci`, **0 open Dependabot alerts**, 10 open CodeQL alerts and 0 secret-scanning alerts. Re-measured on that commit on 2026-11-27 between 04:52 and 04:57 UTC: `npm audit` found 0 full and 0 production findings after a clean `npm ci`, with `package-lock.json` SHA-256 `48869379…`, unchanged since the Zod 4 migration. GitHub showed 0 open Dependabot alerts, 10 open CodeQL alerts (1–6, 8 and 16–18) and 0 secret-scanning alerts.

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

Across Clusters 1–3 the audit moved from **16 findings (1 critical / 9 high / 4 moderate / 2 low)** to **3 moderate**. Cluster 4 took it to **2 moderate**, and Cluster 5 took it to **zero**. The later `nanoid` advisory was outside all five clusters and was remediated separately as a standalone bounded dependency-advisory task. So were the September 2026 advisories: [Advisory remediation 002](#advisory-remediation-002--remediated) took the full graph from **6** to **2 moderate** and the production graph from **1 low** to **zero**, with a `package-lock.json`-only dependency delta. The [Vite development-server remediation](#vite-development-server-rce--remediated) (2026-11-23) is likewise a standalone bounded task with a `package-lock.json`-only delta. The [React Router patch set](#react-router-patch-set--7186) is the next one: a `package-lock.json`-only dependency delta plus one regression test, merged on 2026-11-23 as `ae201aff`. The [CSS and build-toolchain patch set](#css-and-build-toolchain-patch-set) follows it. Its dependency delta is `package-lock.json` plus one `devDependencies` line removed from `package.json`, and it merged on 2026-11-23 as `802d96b8`. The [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set) is next. Its dependency delta is `package-lock.json` plus two raised `devDependencies` declarations in `package.json`, and it merged on 2026-11-23 as `94ef1b2c`. The [Zod 4 migration](#zod-4-migration) is the last. It raises one `dependencies` declaration and, unlike the others, changes application source: two files, with tests. It merged on 2026-11-24 as `cec11199`.

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
| Test and lint toolchain patch set (merged as `94ef1b2c`) | `typescript-eslint` and the ten `@typescript-eslint/*` packages **8.73.0** (declared `^8.73.0`) · nested `minimatch` **11.0.9**, with `brace-expansion` **5.1.0** below it · `vitest`, `@vitest/mocker` and the other `@vitest/*` packages **4.1.12** (declared `^4.1.12`) · `chai` **6.3.0** |
| Zod 4 migration (merged as `cec11199`) | `zod` **4.6.7** (declared `^4.6.7`). Every Zod array schema that parses data from outside the bundle carries a `.max()` bound (see [Zod 4 migration](#zod-4-migration)) |

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

**Status: REMEDIATED on `main`** (`PAPERLUME-SECURITY-TEST-LINT-CLUSTER-001`). PR #371 merged on 2026-11-23 as `94ef1b2c`, and that day's automatic Production deployment, `dpl_8tc4Jr8v`, was built from it. Before the merge, `main` `802d96b8` resolved the "before" versions below, and Production `dpl_EULvMp3j` was built with them. None of these packages ships: the built web and extension files are byte-identical with and without this change (see [Build output comparison](#build-output-comparison)). The rest of this section was written while the pull request was open.

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
- Dependabot could close or rebase both once this change reached `main`. After the merge it closed #370 itself, at 18:46:15 UTC on 2026-11-23. #354 was still open at 22:00 UTC that day.

### What remains after this change

- **`zod`** (alert 16) is the only finding left in either `npm audit` graph. There is no 3.x fix, so it needs the separate [Zod 4 migration](#zod-4-migration).
- **`npm audit` with this change:** full 1 and production 1, both `zod` (high). `npm audit` on this lockfile reports no indexed advisory that Dependabot lacks.
- **Upstream sweep with this change:** 1 match, down from 4 on `main`.
  - The three real matches on `main` are gone: `minimatch` GHSA-c859 and the two `@vitest/mocker` advisories.
  - The remaining match is the `@eslint/plugin-kit` false positive recorded for the CSS patch set: the upstream range is `*`, the database's is `<0.2.3`, and 0.3.4 is installed.
  - The CSS patch set's count also included `esbuild` GHSA-gv7w-rqvm-qjhr. That advisory is filed against esbuild's Deno module, and the sweep now counts only npm-ecosystem entries.
- **Bundled copies that no scanner sees** are unchanged. Vite 7.3.8 bundles `postcss-selector-parser` 7.1.0 and `ws` 8.18.3. Rollup 4.59.0 bundles `picomatch` 4.0.3. Vitest's bundled `ws` is also unchanged, because Vitest 4.1.12's published code differs from 4.1.11's only in its version string and chunk names.
- **CodeQL:** 18 open alerts, unchanged. They are a separate track.

## Zod 4 migration

**Status: remediated** (`PAPERLUME-SECURITY-ZOD-4-MIGRATION-001`). PR #372 was opened as a draft on 2026-11-23 and merged on 2026-11-24 at 04:43:34 UTC as `cec11199`. Production `dpl_413PdQNt`, built from that commit, was READY at 04:44:02 UTC. Before the merge, at 22:00 UTC on 2026-11-23, `main` `94ef1b2c` still resolved `zod` 3.25.76, and Production `dpl_8tc4Jr8v` was built with it. Unlike the patch sets above, Zod ships in the web bundle, and the major upgrade needed application changes.

| Field | Value |
|---|---|
| Advisory | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (CVE-2023-54404): "Zod can exhaust memory while validating oversized constrained collections" (CWE-770) |
| Severity | **High**: CVSS 3.1 7.5, CVSS 4.0 8.2. Reviewed on 2026-10-23 and not withdrawn |
| Affected → patched | `<4.6.6` → **4.6.6**. There is no 3.x fix |
| Mechanism | Parsing an array builds one issue per failing element. Before 4.6.6, even a `.max()` bound was checked only after every element had been walked |
| Other Zod advisories | GHSA-m95q-7qp3-xv42 (`<=3.22.2`) is already outside 3.25.76. The `colinhacks/zod` repository has published no advisory of its own |
| Installed before → after | `zod` **3.25.76** (declared `^3.25.76`) → **4.6.7** (declared `^4.6.7`) |

### Where Zod runs

- Two first-party files import it, both in the web bundle:
  - `src/pages/Auth.tsx` validates the sign-in and sign-up email and password, and the forgot-password email, before any Supabase Auth call;
  - `src/hooks/useFilterPresets.ts` parses saved filter presets. Each is a `filter_presets.payload` JSONB row that only its owner can write (RLS `auth.uid() = user_id`), and nothing server-side bounds its size.
- No Edge Function, extension file, script or E2E helper imports Zod. `@hookform/resolvers` 3.10.0 is declared but never imported, and no installed package declares Zod as a dependency or peer.
- The exposure was the presets' three unbounded arrays: `selectedKeywords`, `selectedProjectIds` and `selectedTagIds`. Only the user can write their own rows, so the impact was limited to their own tab. As with [NanoID](#applicability), the remediation does not rest on that.

### Why 4.6.7

- 4.6.6 is the first release outside the advisory. 4.6.7 (`latest`, published 2026-10-12) is the same code: the two published tarballs differ only in four version constants.
- 4.6.7's SLSA provenance names `b500a2ee`, a commit on the upstream `main`. 4.6.6's names `284243fb`, a commit from before upstream rewrote `main`. The rewrite removed six malicious commits pushed with a compromised credential on 2026-09-21. Upstream states that none was ever published to npm, and `284243fb` has the same tree as its rewritten copy `9c219833`.
- Zod 4 needs TypeScript 5.5 or later (5.8.3 is installed), and declares no `engines` and no dependencies.
- Zod's documentation also asks for `strict` mode. `tsconfig.app.json` sets `"strict": false`, as it did under Zod 3, and all three typechecks pass.

### What the upgrade fixes, and what it does not

4.6.6 checks `.max()`, `.length()` and `.size()` before walking elements, so it protects only **bounded** schemas. Measured locally, for one array of 100,000 elements (a sparse proxy whose elements are all invalid):

| Schema | Elements read | Issues | Time |
|---|---|---|---|
| `zod` 3.25.76, `.max(1000)` | 100,000 | 100,001 | 59 ms |
| `zod` 4.6.5, `.max(1000)` | 100,000 | 100,001 | 65 ms |
| `zod` 4.6.7, `.max(1000)` | 0 | 1 | 0.2 ms |
| `zod` 4.6.7, no bound | 100,000 | 100,000 | 79 ms |

The upgrade alone would have left the preset arrays unbounded, so this change also bounds them.

### Application changes

- **`Auth.tsx`, field errors.** Zod 4 removed `ZodError.errors`, an alias of `.issues`. Under Zod 4 the old read throws a `TypeError` inside the submit handler, so no message renders. That caused the typecheck failure and the two failing auth E2E tests on Dependabot's PR #352. The page now reads `.issues`.
- **`Auth.tsx`, password length.** Zod 4.5.0 changed string `.min()`, `.max()` and `.length()` to count Unicode code points instead of UTF-16 units. With `.min(6)`, a password such as "😀😀😀" (six units, three code points) would newly be refused at sign-in. The rule is now an explicit `value.length >= 6` check with the same message. That is what Zod 3 checked, and what `ResetPassword` checks.
- **`useFilterPresets.ts`, bounded arrays.**
  - `PRESET_MAX_SELECTIONS = 1000` bounds all three selection arrays, in the v1, v2 and v3 schemas alike.
  - Why 1000: keywords filter with AND semantics (`filter_papers_by_keywords` requires every selected keyword), so a selection longer than one paper's term list can never match. Project and tag IDs can name only the user's own projects and tags, and the dashboard adds them one click at a time.
  - `findOversizedPresetSelection` reads only those arrays' `length`, before any schema runs. An oversized array is rejected in constant time, without reading or copying an element.
  - A stored row over the cap takes the existing invalid-row path: it is dropped from the menu with a console warning. It is never truncated, and the read path never writes.
  - `savePreset` and `updatePreset` refuse an over-cap payload before the network, with a toast, so the app cannot write a preset it would then refuse to load.
  - The payload version stays 3. There is no migration, schema or RLS change.

### Behaviour comparison

- **Differential.** The base (`zod` 3.25.76 with `main`'s source) and the head (`zod` 4.6.7 with this change's source) both ran the repository's own validation code, sliced from Git, on synthetic input:
  - **Auth:** 60,051 emails (51 hand-picked, the rest generated) × 11 passwords, plus the forgot-password check. Of 720,612 comparisons, none differs. Before the password-rule fix, the only differences were on the three-emoji password.
  - **Presets:** 60,012 payloads across v1, v2, v3, unknown versions and malformed fields. 1,666 differ, every one because a selection array exceeds 1,000 entries. Nothing else differs, and no input was mutated.
- **Migration guide.** None of its changes alters these schemas' results:
  - unknown object keys are still stripped;
  - `z.enum` and `z.literal` accept and reject the same values;
  - the `message` argument is deprecated but still applied;
  - `z.string().email()` is deprecated in favour of `z.email()` but kept, and its results matched on every input above;
  - issue objects have a new format, which reaches only the dropped-preset console warning.

### Tests

- `src/pages/__tests__/Auth.validation.test.tsx` (20 tests) renders the page with a mocked Supabase client. It covers sign-in, sign-up and forgot-password validation, exact messages and their field associations, the password boundary and astral passwords, valid input reaching the unchanged Supabase calls, and the `returnTo` redirect. It also checks that a validation failure never calls Supabase Auth, never navigates and never throws.
- `src/hooks/__tests__/useFilterPresets.bounds.test.tsx` (47 tests) covers:
  - the cap at exactly 1,000 and at 1,001 in every version and field;
  - the guard reading no element of a 10-million-length array and running before any schema;
  - the schemas' own `.max()`;
  - unchanged rejection of malformed payloads, input left unmutated, and no database access while parsing;
  - stale-ID handling at the cap;
  - the save and update guards;
  - a list read that upgrades v1 and v2 rows, drops an oversized row and writes nothing.
- **Negative controls.** Each was run against a modified copy, then reverted:

  | Change to the code | Tests that fail |
  |---|---|
  | Remove the pre-parse guard | 2 |
  | Remove the schemas' `.max()` | 1 |
  | Remove the save and update guards | 4 |
  | Restore `.errors` | 9 |
  | Restore `.min(6)` | 2 |
  | Move the cap to 1001 | 1 |

### Lockfile delta and build effect

- **One command:** `npm install zod@4.6.7`, from `main` `94ef1b2c`.
  - `package.json` changes one line.
  - `package-lock.json` changes the root declaration and the `node_modules/zod` entry (`version`, `resolved` and `integrity`). There are 527 entries before and after.
  - Regenerating from the base lockfile with `--package-lock-only` gives a byte-identical file (SHA-256 `48869379…`).
- **Install checks.**
  - `npm ci` leaves the lockfile unchanged, and `npm ls --all` exits 0 with a single `zod` copy.
  - `npm audit signatures` verifies all 468 registry signatures and 80 provenance attestations, including `zod`'s.
- **Web (`dist/`).** 7 of 9 files are byte-identical, including the stylesheet (`27bf46dd…`), and `index.html` differs only in the entry chunk's name.
  - The entry chunk grows from 1,953,199 B to 1,983,385 B: +30,186 B, and gzip 552.95 → 564.76 kB.
  - Building this change's source with `zod` 3.25.76 splits the growth: +715 B is the new application code, and +29,471 B is Zod 4.
- **Extension (`dist-extension/`).** All 8 files are byte-identical. The extension does not use Zod.
- **Nothing else moved.**
  - The Supabase URL and publishable key and the inlined environment keys are identical.
  - So are the counts of `.rpc(` and `.from("` calls and every Supabase Auth call site.
  - The only new URL strings are the `json-schema.org` `$schema` values in Zod 4's JSON Schema export, which the app never calls and nothing fetches.

### Dependabot's PR #352

- It proposes `zod` 4.6.6, with the same two-file dependency shape. Its head is `f8f146b0`, on base `626f794f`, behind `main`.
- `validate` failed on the `Auth.tsx` typecheck error, and `e2e-local` on the two auth validation tests. `db-tests`, `e2e-evidence` and `extension` passed.
- It was not modified. Dependabot was expected to close it once the migration reached `main`. At 08:15 UTC on 2026-11-24, about three and a half hours after the merge, it was still open.

### What remains

- **Production data.** No Production row was read. A preset stored with more than 1,000 entries in one selection array would stop appearing in the menu after this change, with its row unchanged. The UI cannot produce one without over 1,000 separate selections. A read-only aggregate would settle it: the largest `jsonb_array_length` of each selection array in `filter_presets.payload`.
- **`bun.lockb`.** The 2025-01-01 template's Bun lockfile is still tracked. It names `zod` 3.25.76 and packages long since removed from `package.json`. No workflow, script or Vercel build reads it, and Dependabot does not scan it. Removing it is separate hygiene work.
- **`@hookform/resolvers` 3.10.0** is declared but never imported. Its Zod resolver predates Zod 4, so using it would need an upgrade first.
- **Password length rule.** Before and after this change, the client's six-character rule counts UTF-16 units, while upstream Supabase Auth counts code points for its server-side minimum (`utf8.RuneCountInString`). Aligning the two is a product decision.
- **Upstream sweep with this change:** 1 match, the same as on `main`: the `@eslint/plugin-kit` false positive recorded above. It covered 507 package names across 319 repositories. The only gap is `substack/node-concat-map`, whose repository no longer exists.
- **CodeQL:** 18 open alerts, unchanged by this change; see [CodeQL triage outcome](#codeql-triage-outcome-2026-11-23).

## Open findings (2026-11-23)

Measured with the Vite 7.3.8 lockfile. "Upstream-only" means the advisory is published in the package's own repository but, on 2026-11-23, not in GitHub's Advisory Database. Neither Dependabot nor `npm audit` reports those.

| Package | Installed | Dependabot alerts | Advisories | Where it runs |
|---|---|---|---|---|
| `brace-expansion` | 1.1.18 · nested 2.1.4 (two copies) | 1, 3, 5, 6 | GHSA-6j4f-fj2g-mc7p and GHSA-qhr7-859c-m2p7 (high); GHSA-q2hr-2g5m-vwhr (moderate); upstream-only GHSA-6jwq-xf8q-xcwh (high), fixed in 1.1.22 / 2.1.8. 1.1.22 / 2.1.8 in the [CSS and build-toolchain patch set](#css-and-build-toolchain-patch-set) | lint and build tooling, through `minimatch` |
| `source-map-js` | 1.2.1 | 8 | GHSA-68fv-2mgg-jv7q (high). 1.2.4 in the CSS and build-toolchain patch set | PostCSS, at build time |
| `@vitest/mocker` | 4.1.11 | 14, 15 | GHSA-xp26-3454-mjgp and GHSA-qxg6-89mg-rqv8 (moderate). 4.1.12 in the [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set) | Vitest; no browser mode, UI or API server is configured |
| `zod` | 3.25.76 | 16 | GHSA-mrhx-c7xc-m3w5 (high); no 3.x fix, patched in 4.6.6. 4.6.7 in the [Zod 4 migration](#zod-4-migration) | **web bundle**: auth form validation and saved filter presets |
| `postcss-selector-parser` | 6.1.4 · nested 6.0.10 | 17 | GHSA-rj75-hqrm-r3gf (moderate); upstream-only GHSA-67xj-gfww-g738 (moderate), fixed in 6.1.6. 6.1.6, with 6.0.10 removed, in the CSS and build-toolchain patch set | Tailwind, at build time. 6.0.10 is pinned by `@tailwindcss/typography`, which no config or source file uses |
| `glob` | 10.5.0 | 18 | GHSA-3g3m-2fjr-6pw4 (moderate). Removed with `sucrase` 3.35.1 in the CSS and build-toolchain patch set | installed under `sucrase`; only `sucrase`'s CLI loads it |
| `minimatch` | 9.0.9 (two copies) | 20 | GHSA-g3hv-75wg-m249 (moderate). `npm audit` reports it, and Dependabot opened alert 20 for it when the Vite lockfile reached `main` (see [Current audit state](#current-audit-state)). Also upstream-only GHSA-c859-jr93-m5j4 (moderate). The CSS and build-toolchain patch set removes the `glob` copy; the `typescript-estree` copy remains (see [What this leaves open](#what-this-leaves-open)). 11.0.9 in the [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set) | lint and build tooling |
| `react-router` | 7.18.2 | — | upstream-only GHSA-x8j4-g9rr-8j87, GHSA-qhgm-jj2j-75wj and GHSA-2rq8-3rm6-2w8f (high); GHSA-7m2v-44vx-v55w, GHSA-8wpx-2pj4-ggvx and GHSA-mjj8-rxh9-q8f5 (moderate); all six fixed by 7.18.5. 7.18.6 on `main` since `ae201aff` ([React Router patch set](#react-router-patch-set--7186)) | **web bundle**. Only GHSA-x8j4 (CPU use in route matching) applies to the declarative SPA; the others need data, framework or RSC modes |
| `set-cookie-parser` | 2.7.2 | — | upstream-only GHSA-mxfr-qhmh-pcx4 (high), fixed in 2.7.3. 2.7.3 on `main` since `ae201aff` | a `react-router` dependency; not in any shipped bundle |
| `ws` | 8.21.3 | — | upstream-only GHSA-37g9-w4hg-h9qr (high), fixed in 8.23.0. 8.23.0 on `main` since `ae201aff` | Node only, and in practice only jsdom's `WebSocket` in Vitest. `@supabase/realtime-js` 2.93.3 declares it but never imports it |

The React Router patch set merged as `ae201aff`, so the last three rows are resolved on `main`. The [CSS and build-toolchain patch set](#css-and-build-toolchain-patch-set) merged as `802d96b8`, so the `brace-expansion`, `source-map-js`, `postcss-selector-parser` and `glob` rows are resolved on `main` too. The [test and lint toolchain patch set](#test-and-lint-toolchain-patch-set) merged as `94ef1b2c`, so the `@vitest/mocker` and `minimatch` rows are resolved on `main` as well. The [Zod 4 migration](#zod-4-migration) merged as `cec11199` on 2026-11-24, so the `zod` row is resolved on `main` as well, and no row in this table is open there.

**Planned order.** Each step is its own bounded PR, re-measured before it starts:
1. the React Router patch set (merged 2026-11-23 as `ae201aff`; see [React Router patch set](#react-router-patch-set--7186));
2. the CSS and build toolchain: `brace-expansion`, `source-map-js`, `postcss-selector-parser`, `sucrase`, and removing the unused `@tailwindcss/typography` (merged 2026-11-23 as `802d96b8`; see [CSS and build-toolchain patch set](#css-and-build-toolchain-patch-set));
3. the test and lint toolchain: `vitest` and `typescript-eslint`, which carries the last `minimatch` copy (merged 2026-11-23 as `94ef1b2c`; see [Test and lint toolchain patch set](#test-and-lint-toolchain-patch-set));
4. a separate Zod 4 migration, which needs application changes (merged 2026-11-24 as `cec11199`; see [Zod 4 migration](#zod-4-migration)).

The 18 open CodeQL alerts are outside this document's counts; see [Purpose and authority](#purpose-and-authority) and the [CodeQL triage outcome](#codeql-triage-outcome-2026-11-23).

## CodeQL triage outcome (2026-11-23)

`PAPERLUME-SECURITY-CODEQL-TRIAGE-001` was a read-only triage of every open CodeQL alert on `main` `94ef1b2c`, with the verdict `PAPERLUME_SECURITY_CODEQL_TRIAGE_READY`. It changed nothing. No alert was dismissed or fixed during the triage, and all 18 remain open. CodeQL numbers its alerts separately from Dependabot.

- **Result.** All 18 alerts are in JavaScript and TypeScript, and all are P3:
  - 9 are genuine code-quality defects: CodeQL alerts 1–8 and 16;
  - 9 are false positives for the claim their rule makes: CodeQL alerts 9–15, 17 and 18. Next to alerts 9–15 sits a real BibTeX brace-escaping bug.
- **No exploitable path was demonstrated among the 18 alerts.** The flagged code's output reaches no HTML interpreter: the app renders it as React text, and the extension uses `textContent`. That is a finding about these 18 alerts, not a statement that the application has no exploitable vulnerability.
- **Coverage limits.**
  - GitHub's default setup runs the `default` query suite, not `security-extended`, with the `remote` threat model and no build.
  - All 18 results come from single-file pattern queries. No data-flow query reported anything.
  - The Edge Functions import from `esm.sh`, which CodeQL cannot resolve, so the absence of data-flow results there is weak evidence.
  - The deployed Edge Function bundle was not compared with `main`, and no CodeQL CLI was run locally.
- **Proposed follow-up repair groups.** Each would be its own bounded PR. Only Q1 has been done:
  - **Q1**, BibTeX import and export (CodeQL alerts 7 and 9–15). Its fix merged on 2026-11-24 as `ded56c63`, and CodeQL's analysis of that commit closed all eight alerts; see [BibTeX codec and record integrity](#bibtex-codec-and-record-integrity-codeql-q1);
  - **Q2**, Edge metadata extraction (alerts 2–5 and 8). It needs an Edge Function deploy;
  - **Q3**, client HTML-entity decoding, plus an app-wide guard against HTML sinks (alert 6);
  - **Q4**, test-oracle hygiene (alerts 1, 16, 17 and 18).
- **Separate finding: CSV formula injection.** `escapeCSV` in `src/lib/exportUtils.ts` quoted cells but did not neutralize a leading `=`, `+`, `-` or `@`. CodeQL does not report it, and that is not a reason to dismiss it. A dedicated audit has since classified it as Class B, P2; see [CSV formula injection](#csv-formula-injection-cwe-1236).

## CSV formula injection (CWE-1236)

**Status: remediated** (`PAPERLUME-SECURITY-CSV-EXPORT-HARDENING-001`). The read-only audit `PAPERLUME-SECURITY-CSV-FORMULA-INJECTION-AUDIT-001` classified the finding on 2026-11-24, with the verdict `PAPERLUME_SECURITY_CSV_FORMULA_INJECTION_AUDIT_READY`. PR #373, which changes the CSV serializer, was opened as a draft that day and merged at 09:40:45 UTC as `a110b4ce`. The merge's tree is the reviewed head's tree (`da7bcfdb`). Production `dpl_EoZNtanyGR9NNThTU6w1tYFZcJvG`, built from that commit, was READY at 09:41:10 UTC. This is a first-party finding, not a dependency one.

| Field | Value |
|---|---|
| Weakness | CWE-1236, improper neutralization of formula elements in a CSV file |
| Classification | **Class B**: a confirmed weakness whose exploitation by a third party is conditional. **P2** |
| Where | `escapeCSV` and `exportToCSV` in `src/lib/exportUtils.ts`, reached from the library's "Export as CSV" |
| Tested environment | Microsoft Excel 16.115 for Mac on macOS 27.2.1, locale en_IL, with the file opened as a double-click would open it |

### What the audit found

- **Formula evaluation is confirmed** in the tested Excel. A cell starting with `=`, `+`, `-` or `@` was evaluated in 11 of the 14 columns: Title, Authors, Journal, DOI, Study Types, Keywords, MeSH Terms, Substances, Tags, Projects and Abstract. Year, PMID and URL are held to their existing validation. Authors and Keywords evaluated when the joined list itself formed a formula.
- **Only harmless arithmetic was tested**, such as `=1+1`. No external request, DDE, macro or data exfiltration was attempted, and no harm beyond evaluation was demonstrated.
- **A record-boundary defect is confirmed.** A bare CR was written unquoted. Excel and Python's `csv` module both end the row there, so the text after it becomes a row of its own, whose first cell can be a formula. This app's own importer does not split there.
- **Exploitation by a third party is conditional.** A value would have to reach another user's library through a file that user imports, such as a shared reference file or a journal's citation download, or through a metadata record its publisher controls. The user would then have to export to CSV and open the file in a spreadsheet. The importers, the database (checked from source) and the export all kept such values unchanged. The importer's trim and HTML-entity decoding can even turn ` =1+1` or `&#61;1+1` into `=1+1`.
- **Saving in Excel destroyed the formula text.** After Excel saved the file as CSV, the cell held the computed value instead of the original text.

### The fix

- **It changes only the serialization boundary.** Stored metadata, the importers, the database and the UI are unchanged, and no dependency changed.
- A cell whose first character, after any leading whitespace or control characters, is `=`, `+`, `-` or `@`, or the full-width form of one (U+FF1D, U+FF0B, U+FF0D, U+FF20), is written as a quoted field with one added leading TAB: `=1+1` becomes `"<TAB>=1+1"`. This is the form OWASP suggests.
- A field containing a comma, a quote, `;`, CR or LF is quoted. Quoting the bare CR repairs the record-boundary defect. Quoting `;` keeps a field whole where `;` separates cells, but the file still uses commas, so this does not add support for `;`-separator locales.
- Year is written as its digits when it is a safe integer, as before. Any other runtime value in that column is serialized as text by the same rule as other text, so it cannot reach the file as a formula.
- The header, the comma delimiter, LF line endings and the encoding (UTF-8 without a byte order mark) are unchanged.

### Trade-offs

- **A program reading the file sees the TAB.** Only formula-leading cells gain one, and no character is removed. A consumer that strips leading whitespace undoes the protection for whatever it writes next.
- **Re-import is unchanged.** This app's CSV importer already trims every value, so a re-imported export gives the same papers as before. Over three export–import cycles, `parseCSV` and normalization gave results identical to the old export's for the audit's 36 titles, a sweep of every column and fully populated records. No TAB builds up, and leading apostrophes are kept.
- **Numeric text in a text column stays text.** A Title such as `-0.42` is now a text cell in Excel rather than a number, which matches what is stored.

### Verified, and not verified

- **Verified** in Excel 16.115 for Mac, with the file opened in the background. No cell of the patched export evaluated as a formula, each paper stayed one row, and every cell matched the file apart from Excel's own handling of numbers and of the encoding. The protection held after an Excel save as CSV and reopen. The old export evaluated 18 cells across the same three files.
- **Not verified:** Windows Excel, LibreOffice Calc, Apple Numbers, Google Sheets, Power Query, Excel's text import wizard, and other locales, including those that separate cells with `;`. The TAB prefix is not a universal guarantee, and OWASP's guidance is that no single approach is safe for every consumer.
- **Leading C1 controls.** A value that starts with a C1 control character (U+0080–U+009F) followed by a trigger is not neutralized. In the tested Excel it stayed text, and this app's own trim does not remove C1 controls, so re-import does not promote it to a formula. Another spreadsheet that strips them was not tested.
- **The deployed export was not exercised.** No signed-in Production export or import was run, because none was authorized. That the fix is deployed rests on the deployment record: Production `dpl_EoZNtany…` was built from `a110b4ce`, whose tree is the tested head's.
- **Re-evaluate** when the CSV columns or serializer change, when another tabular export such as XLSX is added, or when a spreadsheet that users rely on is shown to evaluate the neutralized form.

### Residual findings

Each is separate work. Only the BibTeX item has been done:

- **No byte order mark.** Excel for Mac decodes a UTF-8 CSV without one as MacRoman, so `°C` shows as `¬∞C`. Adding one is deferred, because it changes the file for scripts that do not strip it.
- **RIS record boundaries.** RIS export writes each field after its tag without handling an embedded newline. An abstract containing a newline followed by RIS tag lines therefore ends the record early: one paper exported came back as two on re-import. A fix is proposed in a Draft pull request; see [RIS record integrity](#ris-record-integrity).
- **BibTeX.** The codec findings, including DOI and URL fields written without escaping, are repair group Q1 of the [CodeQL triage outcome](#codeql-triage-outcome-2026-11-23). Its fix merged on 2026-11-24 as `ded56c63`; see [BibTeX codec and record integrity](#bibtex-codec-and-record-integrity-codeql-q1).
- **CodeQL.** The CSV change moved no alert: 18 were open on `main` `a110b4ce`, as before it.
- **Bundled dependency copies:** see [Vite's bundled `postcss-selector-parser`](#residual-vites-bundled-postcss-selector-parser) and [Vite's bundled `ws`](#residual-vites-bundled-ws).
- **Saved filter presets.** Whether any stored preset exceeds the 1,000-entry bound is still unmeasured; see the "What remains" list of the [Zod 4 migration](#zod-4-migration).

## BibTeX codec and record integrity (CodeQL Q1)

**Status: remediated.** `PAPERLUME-CODEQL-BIBTEX-CODEC-001` implements repair group Q1 of the [CodeQL triage outcome](#codeql-triage-outcome-2026-11-23), on base `main` `a110b4ce`. An independent review then found that its first version changed DOIs and URLs written by other tools. The revision, `PAPERLUME-CODEQL-BIBTEX-CODEC-001A`, corrected that in the same Draft; see [DOI and URL fields](#doi-and-url-fields). A further revision, `PAPERLUME-CODEQL-BIBTEX-CODEC-001B`, added [the export notice](#the-export-notice) and a [browser qualification](#browser-qualification), and left the exported bytes unchanged. PR #374 merged at 22:43:26 UTC on 2026-11-24 as `ded56c63`, whose tree is the reviewed head's (`f1a90ba4`). Production `dpl_Np9zQiCAVqqA2w4nttr2b3vFezJ5`, built from that commit, was READY at 22:43:49 UTC. This is a first-party finding, and no dependency changes.

| CodeQL alerts | Rule | Location on `a110b4ce` | Triage classification |
|---|---|---|---|
| 9–15 | `js/incomplete-sanitization`: "This does not escape backslash characters in the input." | `src/lib/exportUtils.ts` lines 208–216, one alert per `.replace` in `escapeBibTeX` | False positive for the rule's claim, because the chain's first step does escape the backslash. A real escaping bug sits next to them |
| 7 | `js/double-escaping`: "This replacement may produce '\\' characters that are double-unescaped here." | `src/lib/importParsers.ts` line 87, in `decodeLatex` | Genuine defect |

CodeQL assigns its "high" security severity per rule. The triage rated the group P3. Imported text reaches no HTML interpreter, and no exploitable path was demonstrated. The defects below concern the integrity of the exported file and of the imported data. They do not add up to eight separate exploits.

### What was wrong

Reproduced on `a110b4ce` with the real exporter and importer, exporting two papers:

- **The encoder re-escaped its own output.** This is the bug next to alerts 9–15. `escapeBibTeX` was a chain of replacements, and its `{` and `}` steps also escaped the braces of its own `\textbackslash{}` token. `C:\data` was therefore written `C:\textbackslash\{\}data`, which LaTeX prints as `C:\{}data`. The importer compensated, so the app's own round trip hid the bug.
- **One brace could break the file.** A literal brace was written `\{` or `\}`, but BibTeX counts every brace: the field scanner in `bibtex.web` has no backslash case. So:
  - a title `a } b` came back with every other field of its record lost;
  - a title `a { b` lost both records;
  - a title containing `x}}, author = {Injected Person}` came back with that text as an author;
  - an abstract containing `}` was cut there, and the keywords and study type after it were lost.

  A DOI or a link with an unpaired brace, such as `10.1000/x}` or `https://example.com/search?q=}`, was written raw with the same effects. The WHATWG URL serializer keeps `{` and `}` raw in a query or a fragment.
- **The year and citation key.** A year that is not a number at runtime went raw into both. The value `2020}, title = {Injected Title` broke the entry, and nothing was read back.
- **The decoder read its own output again (alert 7).** `decodeLatex` was a sequence of replacements, so text one step had produced was decoded again. A literal `\textasciitilde{}` came back as `~`, and `\textasciicircum{}` as `^`.
- **An accent could take a group's brace.** `{Caf\'e} Society` came back as `{Café Society`.
- **Outer-brace stripping** removed a leading and a trailing brace even when they belonged to different groups: `{A} and {B}` became `A} and {B`.

### The fix

A shared module, `src/lib/bibtexCodec.ts`, holds both directions, so the tokens the exporter writes are the tokens the importer reads. The tokenizer and field parser are unchanged. They count every brace, as `bibtex.web` does, and that is correct. The defect was an encoder that treated `\}` as if it were not a brace.

- **Text fields** (title, author, journal, abstract, keywords and note) are encoded in one pass. A single `replace` takes one character class and a callback, so every match is a character of the stored value, and no token is matched again.
  - `\` → `\textbackslash{}`, where the old chain wrote `\textbackslash\{\}`. The other tokens are as before: `&` → `\&` (likewise `%`, `$`, `#` and `_`), `~` → `\textasciitilde{}` and `^` → `\textasciicircum{}`.
  - A brace whose partner is in the same value is still written `\{` or `\}`, so balanced braces such as `{HIV}` come out byte for byte as before. A brace with no partner is written `\textbraceleft{}` or `\textbraceright{}`. These are LaTeX text symbols, available by default since the February 2020 release, and biber's recode table maps them to `{` and `}`. Zotero's BibTeX exporter draws the same line between paired and unpaired braces, using `\vphantom` for the unpaired ones.
  - Authors and keywords are encoded one element at a time, so a brace pair never spans two names. BibTeX splits a name list only at an " and " outside braces.
- **`doi` and `url` stay raw, in both directions.** biblatex reads `doi` as a verbatim field and `url` as a URI field (manual 3.22a, §2.2.1 and §2.2.2). The characters in those fields are the identifier for every tool that reads them, so nothing is escaped or decoded there.
  - The importer reads them as `main` does: brace pairs that enclose the whole value are removed, the value is trimmed, and nothing is decoded. Text such as `\textbraceleft{}` in another tool's DOI is part of the DOI.
  - The exporter writes every DOI and URL raw whose braces balance and that is not wrapped in one pair. These come out byte for byte as before, including `10.1000/456#789`, `https://doi.org/10.1000/456%23789` and a DOI that contains `\textbraceleft{}`. Nothing is percent-encoded or LaTeX-escaped.
  - A value that cannot be written raw goes to a PaperLume field instead, and the standard field is left out. See [DOI and URL fields](#doi-and-url-fields).
- **Decoding** scans the original input left to right and decodes each recognized token once. Each character is either part of one token or copied once, so a decoded `\` cannot combine with the text after it.
  - The accent table and its supported forms are unchanged: `{\'e}`, `{\'{e}}`, `\'e` and `\'{e}` for every accent and letter in the table, `\c{c}`, `\v{s}`, and `\ss`, `\aa`, `\ae`, `\AE`, `\o` and `\O`.
  - An accent's letter braces must now come as a pair, so an accent no longer takes an enclosing group's brace.
  - The legacy `\textbackslash\{\}` is still read as one backslash.
- **Outer braces** are stripped only when the opening brace's partner is the last character. Braces are paired as TeX reads them, so `\{` and `\}` never close the group.
- **Year and citation key.** A number, the column's type, is written as before. Any other runtime value is encoded as text in the `year` field, and the citation key uses the existing `nd`.

| Field | Kind | Written as |
|---|---|---|
| Entry type and field names | Structure | Constants, unchanged |
| Citation key | Structure | Unchanged for a numeric year. Any other year gives `nd` |
| `title` | Text | Text encoding inside `{{…}}` |
| `author` | List of text | Each name text-encoded, joined with " and " |
| `year` | Number | Digits. Any other runtime value is text-encoded |
| `journal`, `abstract` | Text | Text encoding |
| `keywords` | List of text | Each keyword text-encoded, joined with ", " |
| `note` | Text | `Study type: ` followed by the text encoding |
| `doi` | Identifier | Raw. Left out when the DOI cannot be written raw |
| `paperlume-doi-v1` | Identifier | Only for a DOI that cannot be written raw, in the version 1 encoding |
| `pmid` | Identifier | Only a valid PMID, as digits, unchanged |
| `url` | URL | Raw, chosen by `exportUrlFor` with unchanged precedence. Left out when the URL cannot be written raw |
| `paperlume-url-v1` | URL | Only for a URL that cannot be written raw, in the version 1 encoding |

PMID authority on import is unchanged. It comes from an explicit `pmid` field first, then from a structurally recognized PubMed record URL in `url`, then from one in `note`.

### DOI and URL fields

**What the review found.** The first version of this fix (Draft commit `58be86c1`) decoded the three tokens `\textbackslash{}`, `\textbraceleft{}` and `\textbraceright{}` in every `doi` and `url` field, whoever wrote the file. A DOI or URL from another tool that contains that text was therefore imported as a different identifier. These results come from the real parsers on synthetic fixtures. None of the DOIs is registered.

| Field as another tool wrote it | `main` `a110b4ce` reads | Draft `0fd89d8c` read | Now reads |
|---|---|---|---|
| `doi = {10.1000/a\textbraceleft{}b}` | `10.1000/a\textbraceleft{}b` | `10.1000/a{b` | `10.1000/a\textbraceleft{}b` |
| `doi = {10.1000/a\textbraceright{}b}` | `10.1000/a\textbraceright{}b` | `10.1000/a}b` | `10.1000/a\textbraceright{}b` |
| `doi = {10.1000/a\textbackslash{}b}` | `10.1000/a\textbackslash{}b` | `10.1000/a\b` | `10.1000/a\textbackslash{}b` |
| `url = {https://example.org/a?q=\textbraceleft{}}` | link `https://example.org/a?q=\textbraceleft{}` | link `https://example.org/a?q={` | link `https://example.org/a?q=\textbraceleft{}` |

The importer could not tell such a field from one the exporter had encoded, because both looked the same. The Draft also wrote an unbalanced DOI such as `10.1000/x}` as `doi = {10.1000/x\textbraceright{}}`. That file is valid BibTeX, and the Draft read the DOI back. Any tool that reads `doi` verbatim, including `main`'s importer, reads `10.1000/x\textbraceright{}` instead, which is a different DOI.

Such text cannot be ruled out as part of a DOI. The DOI Handbook (September 2025, "Syntax of the DOI name", p. 37) lets a DOI name use any Unicode graphic character, punctuation included. A registration agency may choose a narrower set ("Avoiding and resolving ambiguities", pp. 40–41), but the standard does not require one.

**Options compared** for a value that cannot be written raw:

| Option | Standard field | Other tools | PaperLume round trip | Decision |
|---|---|---|---|---|
| A. Encode the standard field and add a marker saying so | Holds the encoded text | Read a different DOI or URL | Exact | Rejected: the standard field still misleads every other reader |
| B. Move the value to a PaperLume field | Left out | See no DOI or URL for that record | Exact | **Chosen** |
| C. Percent-encode the braces of a URL | Holds changed bytes | Usually get a working link | The stored link changes | Rejected, see below |
| D. Leave the value out and tell the user | Left out | See no DOI or URL | Lost | Rejected: it needs a product decision and a UI change |

Option C would apply only to URLs, and only to some of them. The exporter's link has already been through the WHATWG URL serializer, which percent-encodes braces in a path and in user information. A raw brace can remain only in a query, a fragment or a host, where the WHATWG URL Standard keeps it raw. RFC 3986 allows `{` and `}` in a URI only percent-encoded (§2.1–2.3), but it treats a percent-encoded octet as equivalent only for unreserved characters (§6.2.2.2). Encoding a brace in a query therefore changes the bytes a server receives, and encoding one in a fragment changes what a page script reads. Neither is provably the same destination, and the importer would then store the changed link.

**The contract.**

- **Standard fields.** `doi` and `url` are written raw and read raw, never decoded. A value is written there when its braces balance, every brace counting, and no single pair encloses all of it after trimming. Then the importer reads back exactly the trimmed value.
- **PaperLume fields.** Any other value is written to `paperlume-doi-v1` or `paperlume-url-v1`, in the place the standard field would take, and the standard field is not written. In the value, `\`, `{` and `}` are written as `\textbackslash{}`, `\textbraceleft{}` and `\textbraceright{}`, and nothing else changes.
- **Grammar, version 1.** Enclosing brace pairs are removed and the value is trimmed, as for the standard field. What remains must be a sequence of characters other than `\`, `{` and `}`, and those three tokens. Anything else makes the field malformed, including another LaTeX command, a lone backslash, a raw brace or a token without its `{}`. A malformed field is ignored as a whole, never read in part. Each token is decoded once.
- **Names.** Only these two exact names are read. BibTeX compares field names without regard to case, and `bibtex.web` allows hyphens and digits in them. A field with another version or another name is ignored.
- **Precedence.** A standard field with a value always wins. The PaperLume field is read only when the standard field is missing or empty, so it can never replace a DOI or URL that another tool reads.
- **No trust.** The field name is not provenance or authentication, since any file can contain it. A value read from a PaperLume field goes through the same checks as the standard field's:
  - a URL gives a PMID only through structural PubMed recognition;
  - an explicit `pmid` field still outranks it;
  - it is stored as a link only if it is an http(s) URL.

  A malformed field gives no DOI, no link and no PMID.
- **Bounded.** Decoding is one linear pass. A 1 MB field of tokens decodes in about 23 ms, and a malformed one of the same size is rejected in about the same time.

**Which values move.** Only a stored DOI or link whose braces do not balance, or that one pair encloses completely, goes to a PaperLume field. The DOI resolver URL is percent-encoded, so it is always written raw. A PubMed link contains only digits. A journal link can keep a raw brace only in its query, fragment or host. In the 3,000-record synthetic corpus below, 467 of the 5,754 DOIs and links moved, because the corpus deliberately includes such values. Production data was not examined.

**Brace pairs in verbatim fields.** A backslash is an ordinary character in `doi` and `url`, so enclosing pairs are found the way BibTeX pairs braces, with every brace counting. The first version paired them the TeX way there as well. That changed 5,572 of 100,007 random brace-balanced values relative to `main`: for example, `{10.1000/x\}` kept its braces instead of becoming `10.1000/x\`. In these fields the only remaining difference from `main` is the approved one: separate groups such as `{a}{b}` are no longer taken for one enclosing pair. Text fields keep the TeX pairing.

**Other tools.** Standard BibTeX styles ignore a field they do not declare. `bibtex.web` stores only the fields a style declares, and btxdoc says BibTeX ignores any field that is not required or optional. biber's manual states that in tool mode, fields outside the data model are neither read nor output. So a tool that drops unknown fields shows no DOI or URL for a record whose value moved. A tool that keeps them shows the PaperLume field with its tokens. If a tool drops the field and the file comes back, PaperLume reads no DOI for that record. A DOI resolver link in `url`, which is always written raw, survives. biblatex URI-escapes a `url` field that has no `%` when it prints it; that happens in biblatex, and the field itself still carries the stored link.

**Older and Draft-only files.** Older Paperlume exports wrote `doi` and `url` raw, and they are read as before. The first version's encoded standard fields were never released, so they are not supported: such a field is now read as its literal text. No unconditional decoding remains in these fields.

### The export notice

Revision `PAPERLUME-CODEQL-BIBTEX-CODEC-001B` tells the user when a BibTeX export moves a DOI or URL to a PaperLume field. Before it, such an export finished without saying so, and another reference manager could show no DOI or link for those papers.

- **What the exporter reports.** `exportToBibTeX` returns a `BibTeXExportSummary` with four counts:
  - the papers in the file;
  - the papers with a DOI or URL in a PaperLume field, each counted once;
  - the `paperlume-doi-v1` fields written;
  - the `paperlume-url-v1` fields written.

  Each count comes from the field name `writeIdentifierField` chose for a line in the file. A stored journal link that `exportUrlFor` passed over for a PubMed or DOI link is not in the file, so it is not counted. No separate check exists that could disagree with the download. The summary is returned only after the download has been handed to the browser.
- **When it appears.** Only for a BibTeX export in which at least one paper has a PaperLume field. It replaces "Export started", so the export still shows one notification. Every other BibTeX export, and every CSV and RIS export, shows "Export started" and "Downloading N papers as FORMAT." exactly as before. A failed download shows only "Export failed".
- **What it says.** The title is "BibTeX exported with compatibility notice". For one paper, the text reads:

  > 1 paper has a DOI or URL preserved in a PaperLume-specific field. Other reference managers may not recognize it. PaperLume can recover it when the file is reimported.

  For more papers it gives the count, in the plural. It does not say that the download failed, that data was lost, that every reference manager rejects the field, or that any other tool was tested.
- **How long it stays.** A notification's lifetime depends only on its variant (`TOAST_DURATION_MS`). The default is 5 s. `destructive` gets 8 s, and the policy reserves it for errors and warnings a user needs to read in full.
  - The notice is about 30 words, so it uses the 8 s tier, as "File import complete with warnings" does for a finished import with a caveat.
  - That tier is styled as an error, with the destructive colours and Sonner's error icon. Only the title says the export succeeded.
  - A neutral tier with a longer lifetime would need a change to the global toast policy, which this work does not make.
- **Accessibility.** The notice appears in the app's one notification region, which is `aria-live="polite"`, and has the labelled "Close toast" button. Its timer pauses while it is hovered and while the tab is hidden. Sonner's keyboard shortcut, Alt+T, pauses it too; see [Browser qualification](#browser-qualification) for what Escape does afterwards.

### Compatibility

- **Ordinary records are unchanged.** A record whose text values have no backslash and no unpaired brace, and whose DOI and URL can be written raw, is written byte for byte as before. A test pins one such record to the old exporter's output. In the synthetic corpus, all 5,287 `doi` and `url` lines the exporter writes are byte-identical to `main`'s, and 467 other values moved to a PaperLume field.
- **DOI and URL fields from other tools** are read as `main` reads them. Over 114,650 random `doi` fields and 114,650 random `url` fields parsed by the real importers, the only difference was 2,967 `doi` values made of separate groups, the approved change above. The first version differed from `main` on 71,174 and 68,099 of them.
- **Text fields from other tools.** Over 200,000 random inputs, the new decoder differed from the old on 91, all in three intended classes:
  - an accent no longer takes a following brace;
  - an accent with an unclosed brace, such as `\'{e`, is no longer decoded;
  - decoded text is not read again, so `\o{\'x}` gives `øx`, not `\ox`.

  Separately, neighbouring groups such as `{A} and {B}` are no longer stripped.
- **Older Paperlume exports.** An older export whose braces balance is read exactly. That held for 132,753 such values from the same random corpus, encoded the old way, and for the literal `\textasciitilde{}` that the old importer read as `~`.
- **Older exports with an unpaired brace** were never valid BibTeX. They are read as before, by BibTeX's rules, and the lost fields are not reconstructed. Treating `\}` as an escaped brace to recover them would misread valid files in which `\}` closes a field, such as one whose value ends in a backslash.
- **An inherent ambiguity.** To LaTeX, `\textbackslash\{\}` in another tool's file means a backslash followed by two braces. It is still read as a single backslash, because every older Paperlume export uses it for one.
- **Stored data is not repaired.** No migration or data change is part of this work.

### Evidence

- **Tests.** Three new files hold 240 tests. Revision 001A added 52 of them, and revision 001B added 21, described below.
  - `src/lib/__tests__/bibtexCodec.test.ts` (155) checks the codec against expectations written from LaTeX's and BibTeX's rules, including every accent in the table in all four forms, and against an independent transcription of BibTeX's brace rule. For DOIs and URLs it checks:
    - raw values, including token-like text, and third-party values that must not be decoded;
    - values that move to a PaperLume field, each with its payload written out by hand;
    - the field choice and the round trip over 3,000 random values;
    - precedence and versions, and malformed payloads.
  - `src/lib/__tests__/exportBibTeX.integrity.test.ts` (72) checks real exports with an independent reader of BibTeX entry structure, whose field names follow `bibtex.web`'s identifier rule. It covers:
    - entry counts and field names, injection fixtures, and DOI and URL recovery;
    - unmarked files from other tools with token-like DOIs and URLs;
    - conflicting and malformed PaperLume fields;
    - PaperLume URLs checked exactly as `url` is, and several exceptional identifiers before a sentinel record;
    - scientific text, repeated cycles, older exports, hand-written files in other tools' styles and malformed input.
  - The first version's tests that wrote the encoded value into `doi` or `url`, or decoded tokens there, were rewritten for the corrected contract. No other assertion changed.
  - Of the 64 integration tests revision 001A left, 29 fail on `main`. On the first version, 16 of them fail: the token-like third-party values, the encoded standard fields and the PaperLume URL checks. The codec suite's 65 DOI and URL tests need functions the first version does not have.
- **Negative controls.** 31 weakened copies of the code each fail the suites, and unmodified copies pass all 625 tests of the five BibTeX-related files.
  - 20 of the copies repeat the first version's controls in the approved areas, aimed at the revised code.
  - 11 are new, for the identifier contract. Each one:
    - restores the first version's decoding of `doi` and `url`;
    - decodes them only when the text parses as a payload;
    - ignores the PaperLume field;
    - writes the encoded value into the standard field;
    - lets a PaperLume field override a standard one;
    - writes an unbalanced value unencoded into the PaperLume field, which breaks the record and the one after it;
    - reads a malformed payload in part;
    - accepts any version;
    - trusts a PaperLume URL without the link check;
    - pairs verbatim braces the TeX way;
    - or drops the enclosing-pair check.

  The existing BibTeX suites alone catch 6 of the 31, the same 6 as before, and none of the 11 new ones.
- **Other formats.** For 3,000 synthetic records, CSV and RIS output is byte-identical to `main`'s and to the first version's: 427,066 and 770,428 bytes. This corpus adds token-like identifiers to the first round's, which gave 418,241 and 751,711 bytes.
- **Round trip.** The same 3,000 records come back from a BibTeX export exactly as they did from the first version, field for field. All 2,742 DOIs among them are exact. The 54 records skipped both times have a title of white space only.
- **The export notice (revision 001B).** 21 more tests:
  - `src/lib/__tests__/exportBibTeX.integrity.test.ts`, now 72, adds 8 for the summary. They cover an ordinary export, one moved DOI, one moved URL, a paper whose DOI and URL both moved, a mix of papers, and a stored link the file does not hold. A seeded mix of 1,000 papers checks every count against the PaperLume fields the structural reader finds in the file. One test covers one download per export and no summary for a failed one.
  - `src/hooks/__tests__/useExportPapers.test.ts`, new, 13 tests. It drives the real hook with the real `exportUtils`, so every notice follows from the file the serializer wrote. Only the queries, the toast and the browser download are stubbed. It covers the usual notice for ordinary BibTeX, CSV and RIS exports, the notice in the singular and the plural, one paper counted once, a stored link passed over, a failed download, and one download with one notice.
  - 14 weakened copies of `exportUtils.ts` and `useExportPapers.ts` each fail these tests:
    - no DOI count, or no URL count;
    - a paper counted twice;
    - a URL count taken from the stored link;
    - a second download, from the exporter or from a preflight export in the hook;
    - a failed download swallowed by the exporter or by the hook;
    - a DOI count from a separate brace check;
    - no notice, or a notice for every BibTeX export;
    - no singular;
    - the default 5 s tier;
    - a reworded usual notice.

    Unmodified copies pass all 85 tests. The 317 tests of the round-trip, codec and CSV security suites catch none of the 14.
- **BibTeX bytes unchanged by the notice.** On the 3,000-record corpus and 15 targeted records, revision 001B writes exactly the bytes `d919c1f5` writes: 985,549 B and 3,781 B, and each of the 3,015 records exported alone. The comparison fixes the clock: `generateCiteKey` falls back to a key ending in `Date.now()` once 26 suffix letters are used, which happened 48 times in this corpus. That fallback is the same on `main`, so two exports of such a library differ even without this change. The summary matches a line-by-line reading of the file. For the corpus it reports 3,000 papers, 467 affected, 436 DOI fields and 31 URL fields.
- **Build.** No dependency changed, and `package.json` and `package-lock.json` are byte-identical to the base.
  - The web build's 9 files: 7 are byte-identical, the CSS included, and `index.html` differs only in the entry chunk's name. That holds against `main` and against the first version.
  - Against `main`, the entry chunk grows by 1,770 B (+788 B with `gzip -9`), in 99 normalized token hunks. Against the first version it grows by 331 B (+248 B), in 36 hunks. Every hunk falls in the BibTeX exporter, the importer or the codec.
  - The URL origins, the inlined environment keys, and the database, RPC, Edge Function, auth and storage calls are unchanged.
  - The extension output and its packaged archive are byte-identical.
  - Revision 001B adds 796 B to the entry chunk against `d919c1f5` (+320 B with `gzip -9`), in 27 token hunks. Only the export summary and the notice changed: no other string, URL origin, environment key or call differs. Against `main` the chunk now grows by 2,566 B (+1,108 B). The rest of the web build, the extension output and its archive are byte-identical to both.
- **Not verified.** No BibTeX program, biber, pandoc or reference manager is installed here, and installing one was out of scope. The grammar facts come from reading sources, not from running tools: `bibtex.web` 0.99e, btxdoc, the biblatex 3.22a manual and its source, the biber manual, the LaTeX reference manual's list of text symbols, biber's recode table, Zotero's BibTeX translator, the DOI Handbook (September 2025), RFC 3986 and the WHATWG URL Standard. Nobody observed how another tool displays `\textbraceleft{}` and `\textbraceright{}`, or what it does with a PaperLume field. If that matters before release, the checks would be:
  - biber in tool mode with `--validate-datamodel`, to see that it reports and drops `paperlume-doi-v1`;
  - an import of the same file into Zotero and into JabRef, to see whether each keeps the field.

### Browser qualification

No CI lane imports or exports BibTeX; the default lane's `mobile-dashboard-density.spec.ts` only checks that the mobile sheet offers "Export as BibTeX". `e2e/file-import-order.spec.ts`, the only end-to-end test that imports a `.bib` file, is not in `DEFAULT_SPECS` in `scripts/e2e-local.mjs`, and neither CI job passes it. The [PFA-C03 plan](pfa-c03-staging-and-security-test-plan.md) put it in "Wave 2" as a mutating, count-sensitive spec that needs an isolated lane, and that wave was never added. It is one of six spec files that no lane runs; the others are `attachments`, `filter-presets`, `mutations`, `notes` and `search-attribution`. The first report of this work said it had passed in CI, which was wrong. This change does not alter the workflows or the default spec list.

For revision 001B, the workflow was qualified once, locally, through the repository's own lifecycle:

```
npm run test:e2e:local:verify-guards
npm run test:e2e:local -- e2e/bibtex-qualification.spec.ts e2e/file-import-order.spec.ts
```

- **Backend.** A disposable local Supabase stack at `http://127.0.0.1:55321`, which the lifecycle validated as loopback, carried the deterministic seed and its synthetic accounts (`e2e-primary@paperlume.test` with 125 papers).
  - `verify-guards` passed: 58 guard tests, the Production target failing closed, and the browser guard running before any credential is read.
  - Another local application held the default API port, so the run used a scratch clone of the code commit `dcad61fa`, whose own `supabase/config.toml` moved the ports to the 553xx range. No repository file changed.
- **The spec.** `bibtex-qualification.spec.ts` was written for this check and is not committed. It uses synthetic records only, stubs nothing and calls no metadata service. Every request the page made went to the loopback host, and the console logged no error.

| Scenario | What ran | Result |
|---|---|---|
| A. Ordinary import | A two-entry `.bib` file through Add Papers, file import | 2 added. The stored DOI and link were read back from the Edit dialog and the journal link, and again after a reload |
| B. Ordinary export | Export as BibTeX, with the search narrowed to those two papers | `citations.bib` with two entries, standard `doi` and `url` lines and no PaperLume field. "Export started" with "Downloading 2 papers as BIBTEX.", no notice. It closed by itself after 5.9 s |
| C. Exceptional export | An ordinary RIS import created a DOI with an unbalanced `}`, a link with an unbalanced `{` and a sentinel, then two exports | 3 added, stored as given. One paper: `paperlume-doi-v1` and no `doi` line, with the singular notice. All three: `paperlume-doi-v1`, `paperlume-url-v1` and the sentinel's standard fields, with the plural notice, which closed by itself after 8.8 s |
| D. Reimport | The three-paper file through the same file import | With the originals present: 1 added, 2 skipped, because both recovered DOIs matched the stored ones. Without them: 3 added, the DOI and the link read back as stored, and a new export's identifier fields byte-identical to the first file's |
| Cleanup | Every fixture paper deleted from its row | 125 papers again |

- **The notice in the browser.** It appeared in the notification region (`aria-live="polite"`) with its "Close toast" button, as the destructive tier (`data-type="error"`).
  - Hovering held it open for 10 s.
  - Alt+T put the focus in the toaster and also held it for 10 s.
  - Escape then moved the focus back to the page but did not restart the timer: the notice was still open 9 s later. That is how Sonner 1.7.4 handles every notification here.
  - Its close button closed it from the keyboard.
- **`file-import-order.spec.ts`** passed all 5 of its tests in the same run.
- **Four runs.** The first three failed on the new spec's own expectations, not on the application:
  1. It expected different citation keys. A stored "Last, First" author gives keys such as `Dana2024_Bibqord`; see [Limitations not changed here](#limitations-not-changed-here).
  2. It searched again right after an import. The dashboard search caches a query's matching papers for 30 s, and an import does not clear that cache, so repeating a search made in the last 30 s hid the papers just imported. That is not about BibTeX and is not changed here. The spec now reloads the page first.
  3. It expected Escape to restart the notice's timer, as described above.

  The fourth run passed all 11 tests in 2.6 minutes, and the lifecycle exited 0.
- **Teardown.** After each run the lifecycle removed the generated sign-in state, stopped the stack and deleted its volumes. No container or volume of the local project remained.

### CodeQL

The change removes the code the eight alerts point at: the replacement chain in `escapeBibTeX` and the replacement sequence in `decodeLatex`. The revision adds no code of either alert's kind: its encoding is one `replace` with a callback, and its decoder reads each token once. Only an analysis of `main` after a merge can close the alerts.

**Result after the merge.** CodeQL's analysis of `ded56c63`, created at 22:45:23 UTC on 2026-11-24, reported 10 results, down from 18. Alerts 7 and 9–15 are closed as fixed at that time, and no new alert opened. Re-read on 2026-11-25: 10 open, 8 fixed and none dismissed. The open alerts are 1–6, 8 and 16–18, groups Q2–Q4 of the [CodeQL triage outcome](#codeql-triage-outcome-2026-11-23), so this work does not resolve every CodeQL finding.

### Limitations not changed here

These existed before this work, and each is separate:

- `toBibTeXAuthor` reorders a name that is already in "Last, First" form, so `Smith, John` is written `John, Smith,`.
- Once a citation key's base (first author, year and first significant title word) has been used 27 times, the next keys end in `Date.now()`. Two exports of such a library are then not byte-identical, and keys made in the same millisecond repeat. In the 3,000-record synthetic corpus, 13 keys appeared more than once, on `main` as on this branch. A separate fix merged on 2026-11-25 as `a9c40ea6`; see [BibTeX citation-key uniqueness](#bibtex-citation-key-uniqueness).
- The importer splits authors at every " and " and keywords at every comma, braces or not. A MeSH term such as `Neoplasms, Experimental` comes back as two keywords.
- Only the first line of a study type is read back from `note`, and only a four-digit year from `year`.
- The tokenizer does not read parenthesis-delimited entries (`@article(…)`), `@string` macros or `#` concatenation. A bare value that contains a brace ends field parsing for its entry. A long run of `@` without a `{` takes quadratic time.
- Some LaTeX that other tools write is not decoded: Zotero's `{\textbackslash}` and `\{\vphantom{\}}`, `\i`, `\AA`, `\^{}` and math mode. An unknown command that begins with `c` or `v` loses its first letters, so `\cite` becomes `ite`.
- A literal `"` is written raw. That is harmless to BibTeX in a brace-delimited field, but German `babel` shorthands give `"a` a meaning.

### What remains

Each item is separate work, and none of it is part of this change:

- **RIS record boundaries**; see [RIS record integrity](#ris-record-integrity), whose fix is proposed in a Draft pull request.
- **CodeQL groups Q2–Q4**; see the [CodeQL triage outcome](#codeql-triage-outcome-2026-11-23).
- **CSV byte order mark** interoperability; see the [CSV residual findings](#residual-findings).
- **Bundled dependency copies:** see [Vite's bundled `postcss-selector-parser`](#residual-vites-bundled-postcss-selector-parser) and [Vite's bundled `ws`](#residual-vites-bundled-ws).
- **Saved filter presets.** Whether any stored preset exceeds the 1,000-entry bound is unmeasured; see the [Zod 4 migration](#zod-4-migration).
- **CI runtime.** The `e2e-local` lane runs close to its job timeout.
- **Superseded Dependabot pull requests.** PRs 351–354 are still open.
- **The notice's styling.** The compatibility notice uses the toast policy's warning tier, so it lasts 8 s and is styled as an error. A neutral style with a long enough lifetime would need a new tier in `TOAST_DURATION_MS` and the toaster, which is a change to the global notification policy and was not made here.
- **E2E spec coverage (`PAPERLUME-CI-E2E-SPEC-COVERAGE-AUDIT-001`).** Six tracked spec files run in no lane, including `file-import-order.spec.ts`, the only one that imports a `.bib` file. The audit would:
  - list every tracked E2E spec and the lane, if any, that runs it;
  - say why each excluded spec is excluded;
  - find specs that are obsolete or covered elsewhere;
  - say which ones need changes to run against disposable local infrastructure;
  - weigh the added lane time against the `e2e-local` job timeout, and fixture isolation;
  - name an owner for each spec's coverage.

  Not done here, and no workflow or spec list changed.
- **External-tool behaviour.** How biber, Zotero and JabRef treat a PaperLume field was not observed; see [Evidence](#evidence).

## BibTeX citation-key uniqueness

**Status: remediated.** `PAPERLUME-BIBTEX-CITEKEY-UNIQUENESS-001` and its revision 001A are based on `main` `ded56c63` and rated P2, for bibliographic data integrity. It is a first-party defect that no CodeQL rule reports, and no dependency changes. PR #375 merged at 21:02:19 UTC on 2026-11-25 as `a9c40ea6`, whose tree is the reviewed head's (`d4b6eee3`). Production `dpl_9HTMFXbpjaJCcFNUuXMYiRxq9361`, built from that commit, was READY at 21:02:50.729 UTC; see [After the merge](#after-the-merge). The sections below describe the defect as `main` and Production had it before that merge, and the fix as reviewed.

### The defect

Every BibTeX entry starts with a citation key. `generateCiteKey` in `src/lib/exportUtils.ts` builds a base key from the first author's last name, the year and the first significant title word, such as `Smith2024_Alpha`. It gives the base key if no earlier entry in the file has it, and otherwise the first free one of the base key followed by `a` to `z`. When all 27 were taken, it gave `${baseKey}_${Date.now()}` without checking that key against the others. That fallback dates from the first BibTeX exporter, `f9e60fe` (2026-03-05).

- **Repeated keys.** Papers that reach the fallback in the same millisecond get the same key, and an export is fast enough for most of them to: 1,000 papers took about 16 ms in the measurements below.
- **Clock-dependent files.** Two exports of the same papers differ.
- **When it happens.** It takes 28 papers with the same first-author surname, year and first significant title word. Fewer are enough when other papers' keys already took some of the 26 letters. Papers titled "Alphaa" to "Alphaz" take every letter of `Smith2024_Alpha`, and the second paper titled "Alpha…" then reaches the fallback.
- **Effect.** A repeated key is a duplicate entry. When such a key is cited, `bibtex.web` 0.99e reports the second entry as a repeated entry and skips it, even when the two keys differ only in letter case.

Reproduced on `main` `ded56c63` with the real exporter. The keys were read from the exported bytes with a separate structural reader:

| Export | Entries | Distinct keys | Keys written more than once | Surplus entries |
|---|---|---|---|---|
| 30 papers sharing one base key, clock frozen | 30 | 28 | 1: `Smith2024_Alpha_1795560229306`, 3 times | 2 |
| 3,000 papers in 100 such groups of 30, clock frozen | 3,000 | 2,800 | 100 | 200 |
| The same 3,000 papers, real clock, 5 exports | 3,000 | 2,802 to 2,804 | 100 in each | 196 to 198 |
| 3,000 papers sharing one base key, real clock, 1 export | 3,000 | 70 | 43, one of them 113 times | 2,930 |

The five real-clock exports gave five different files, and the same 30 papers exported at two frozen clock readings gave two different files.

**Keys that differ only in letter case.** Independent review of the first fix (`28cfc22e`) found a second defect, which `main` has too: keys were compared as exact strings. Titles that start "Alpha" and "alpha", or first authors "John Smith" and "john smith", give `Smith2024_Alpha` and `Smith2024_alpha`, or `smith2024_Alpha`. These are different strings, but BibTeX treats them as one database key (see [Key syntax and letter case](#key-syntax-and-letter-case)). When such a key is cited, or under `\nocite{*}`, BibTeX reports the second entry as a repeated entry and skips the rest of it. A citation meant for the second paper then finds the first.

Reproduced on 2026-11-25 on `main` `ded56c63` and on `28cfc22e` with the real exporter and the clock frozen. The keys were read from the exported bytes with the structural reader of the integrity tests:

| Export | Entries | Distinct keys, `main` / `28cfc22e` | Distinct up to letter case, `main` / `28cfc22e` | Entries BibTeX reads as repeats, `main` / `28cfc22e` |
|---|---|---|---|---|
| Titles "Alpha" and "alpha", one author | 2 | 2 / 2 | 1 / 1 | 1 / 1 |
| First authors "John Smith" and "john smith" | 2 | 2 / 2 | 1 / 1 | 1 / 1 |
| "John Smith", "Alpha" and "JOHN SMITH", "ALPHA" | 2 | 2 / 2 | 1 / 1 | 1 / 1 |
| Titles "Alpha", "Alpha", "alpha", "alpha": letter suffixes too | 4 | 4 / 4 | 2 / 2 | 2 / 2 |
| 30 papers titled "Alpha", then 30 "alpha" | 60 | 56 / 60 | 28 / 30 | 32 / 30 |
| 3,000 papers, six spellings of one base key | 3,000 | 168 / 3,000 | 28 / 500 | 2,972 / 2,500 |

### The fix

The base key, its derivation and the letters `a` to `z` are unchanged. What follows `z`, and how two keys are compared, change:

- **Numbered keys.** After the letters come `_1`, `_2`, `_3` and so on: the lowest number whose key the file does not hold yet. Nothing reads the clock, draws a random number or hashes a record, so the same papers in the same order get the same keys in every export.
- **One authority, compared up to letter case.** A set of every key already written to the file decides whether a key is free. A key is free only if no key in the file is the same up to letter case. Every candidate is checked against the set: a base key, a letter-suffixed key or a numbered key, whichever paper's key it would repeat and whatever its capitals. The set holds each key in lower case, and one helper, `claimCiteKey`, both looks a candidate up and records it in that form, so a lookup and a record cannot disagree. A base key that another paper's suffixed key already took, or the reverse, gets the next free candidate, as before, now also when the two differ only in capitals.
- **Capitals are kept.** Lower case is only the form in which keys are compared. A key is written with the capitals it was built with, and a suffix is added to the candidate as built. Papers whose keys would be `Smith2024_Alpha`, `Smith2024_alpha` and `SMITH2024_ALPHA`, in that order, get `Smith2024_Alpha`, `Smith2024_alphaa` and `SMITH2024_ALPHAb`: three keys that differ up to letter case, each with its own capitals. A key that collides with nothing is written exactly as before.
- **A cursor per base key, up to letter case.** It records where that base key's numbered search resumes: the number given out last. Every lower number is already in the file. The search starts there, finds that number taken and moves on. Base keys that differ only in capitals share one cursor, because their numbered keys are the same up to letter case, so a paper with another spelling resumes the group's search instead of starting again at `_1`. A large group therefore costs about two lookups per numbered key, whatever its spellings, instead of a scan of every number it used before. The cursor never decides that a number is free: the set does.
- **Scope.** Keys are unique within one exported file. Nothing is stored and the database is untouched. A key is not an identity across exports: adding, removing or reordering papers changes which paper gets which suffix, as before. The importer does not keep keys and is unchanged.

**Why lower case, and only for comparing.** Every key is ASCII (see "Key syntax and letter case"), so lowercasing it folds exactly the letters BibTeX folds, `A` to `Z`. Writing every key in lower case instead would also make keys unique up to letter case. But it would change every key that has a capital, in every export, including the many that collide with nothing and that documents may already cite.

**Why `_1`, `_2`, `_3`.** The numbered key keeps the old fallback's shape: the base key, an underscore and digits, so `Smith2024_Alpha_1795560229306` becomes `Smith2024_Alpha_1`. It also cannot equal any other key the exporter writes. The author part keeps only ASCII letters, the year part is a number as JavaScript prints it or `nd`, and the title word keeps only ASCII letters and digits. So a base key or a letter-suffixed key has exactly one underscore, and a numbered key has two; a title "Alpha_1" gives `Smith2024_Alpha1`. The set still checks every numbered key, so uniqueness does not rest on that argument alone. Two alternatives were not taken:

- More letters (`aa`, `ab` and so on) would be a new convention, and such keys can equal other titles' base keys: a title "Alphaaa" gives `Smith2024_Alphaaa`.
- One counter shared by every base key would make one group's numbers depend on every other group, so adding a paper to one group would renumber another.

**What changes in a file.** Compared with `main`: the keys that `main` would have ended with a timestamp, and the keys that would repeat an earlier key up to letter case. Compared with the first fix (`28cfc22e`), nothing changes in a file in which no two base keys differ only in capitals. In a file in which some do, a key changes when it would repeat an earlier key up to letter case. Later keys of the same group can then move on to the next suffix, because an earlier paper now holds the one they had. Every other key, and every field value, is unchanged.

### Key syntax and letter case

- **Syntax.** A numbered key adds only an underscore and digits to its base key. `bibtex.web` ends a brace-delimited entry's key at a comma, a right brace or white space, and the exporter's keys contain none of these. Every key in the tests and the corpus below uses only ASCII letters, digits and `_`, plus, as on `main`, `-` for a negative year and `.` or `+` when a runtime year is a number such as `2020.5` or `1e21`. The `year` column holds integers, so those last numbers are not reachable through the typed API.
- **A year that is not a number at runtime** still gives `nd` in the key, and its `year` field is still encoded as text, as PR #374 made it, at every position in a group.
- **Database keys.** Section 268 of `bibtex.web` 0.99e makes two entries with the same database key illegal, and keys that differ only in letter case count as the same key. Section 267 looks each database key up in lower case, and section 268 reports a repeat as `Repeated entry` and skips the rest of it. This was read in the source fetched from CTAN and in its typeset edition, dated March 2, 2026 (`tug.ctan.org/info/knuth-pdf/bibtex/bibtex.pdf`). BibTeX's `lower_case` procedure folds only `A` to `Z`. The check applies to a key that is cited, and to every entry under `\nocite{*}`.
- **Citation commands are a separate rule.** For `\citation` arguments, letter case matters (sections 132 and 135). Two cite keys that differ only in case are an error, but a cite key need not match the case of the database key it finds. This fix concerns only the database keys of one exported file: no two of them may be the same up to letter case.
- **The comparison here.** Keys are compared in lower case, which for ASCII keys is BibTeX's own fold. A file whose keys are unique up to letter case is also unique as written, so a tool that compares keys exactly finds no repeats in it either. How biber, Zotero, JabRef or other tools compare keys was not checked, and no claim is made beyond these two comparisons.

### Verification

- **Tests.** `src/lib/__tests__/exportBibTeX.integrity.test.ts` grows from 72 to 92 tests. The 20 new tests read every key from the exported bytes with the suite's structural reader, because the importer does not keep keys. They compare those keys with keys written out from the rule above. They cover:
  - one paper, byte for byte as `main` writes it; two papers; 27 papers, which use the base key and `a` to `z`; 28, which adds `_1`; then 29, 30 and 40;
  - 3,000 papers with one base key: 3,000 distinct keys, the last `Smith2024_Alpha_2973`, every paper in its own entry with its own fields, and all 3,000 read back;
  - a frozen clock, four clock readings and the real clock, which give byte-identical files, and repeated exports of the same papers;
  - three groups, one after another and interleaved, each numbered from `_1`;
  - base keys that other papers' suffixed keys took, and the reverse, and all 26 letters taken by other papers;
  - a title "Alpha_1";
  - a seeded comparison over 2,880 papers with the rule applied one candidate at a time, in which numbered keys and collisions between groups both occur;
  - one record exported 30 times, papers with no author, no year or no usable title word, and an empty export;
  - a runtime year that is not a number across a group of 28, and unusual runtime numbers in the year;
  - a group in which DOIs and URLs move to PaperLume fields. Its summary counts are as before, and its file is the papers' single exports with only the keys replaced.

  15 of the 20 fail on `main`. The other 5 pin what `main` already does: one, two and 27 papers, the empty export, and the linear-work bound below.

  Revision 001A adds 22 tests, so the file has 114. Each reads the keys from the exported bytes and checks that they are unique both as written and up to letter case: `new Set(keys).size` and `new Set(keys.map((key) => key.toLowerCase())).size` both equal the number of entries, and every key is printable ASCII. The keys are compared with keys written out from the rule. The 22 cover:
  - titles, first authors, or both, that differ only in capitals, in either order, including `Smith2024_Alpha`, `Smith2024_alphaa`, `SMITH2024_ALPHAb`;
  - keys that collide with nothing, which are written exactly as an export of their paper alone writes them, capitals included. Among them are keys that would be alike without their punctuation, such as `Smith-44_Beta` and `Smith44_Beta`;
  - a case-only collision with a letter-suffixed key. Also a natural base key that another spelling's suffixed key took, the reverse, and all 26 letters taken by other spellings;
  - more than 27 papers of mixed capitals in one group, one numbering continued across spellings, and three interleaved groups of mixed capitals, each numbered on its own;
  - 3,000 papers sharing one base key in twelve spellings: 3,000 keys, every paper in its own entry with its own fields, and all 3,000 read back;
  - the work: as many lookups for a group whatever capitals its base keys have, and linear growth when every paper has its own spelling;
  - repeated exports, and four fixed clock readings and the real clock, all giving byte-identical files;
  - a paper that collides only up to capitals: its key changes, and no other key does;
  - every field value, hostile text included: each entry is its paper's single export with only the key replaced. DOIs and URLs in PaperLume fields are counted as before, and runtime years that are not numbers stay inside their entries;
  - every key looked up in lower case, and found free, just before it is recorded;
  - a seeded comparison over 2,880 papers with the rule applied one candidate at a time, comparing keys as `bibtex.web`'s `lower_case` folds them. Numbered keys and keys taken only up to letter case both occur in it.

  19 of the 22 fail on `28cfc22e`, and 20 on `main`. The ones that pass pin what those already do:
  - keys that collide with nothing;
  - on `28cfc22e`, groups of one spelling;
  - the linear bound when every paper has its own spelling, which `main` and `28cfc22e` meet by writing those keys unchanged.
- **Negative controls.** Weakened copies of `exportUtils.ts` were run through a scratch alias, without changing the repository. The first fix used 23. Revision 001A ports those 23 to the revised code and adds 11 for letter case. Each of the 34 copies was run against the 114 tests of the integrity suite and the other five export and import suites. Each copy fails new tests. An unmodified copy passes all 22 + 20 citation-key tests and the other 729 tests of those six suites.

  The first fix's 23 controls, as measured for that fix:

  | Controls | Weakened copy | New tests failing, of 20 |
  |---|---|---|
  | A | The `Date.now()` fallback restored, as on `main` | 15 |
  | B1–B3 | No uniqueness check for the base key, the letters or the numbers | 17, 16, 11 |
  | C1–C3 | A base, letter or numbered key given out without being recorded | 17, 16, 11 |
  | D1 | The cursor never stored, so every numbered search starts again at `_1` | 1, the linear-work bound: the keys are the same, the work quadratic |
  | D2–D4 | The cursor skips numbers, is shared by every base key, or starts at 0 | 11, 2, 15 |
  | E1–E5 | Letters from `b`, `-` for `_`, no letters, a lower-cased base key, numbered keys without `_` | 17, 18, 17, 18, 15 |
  | F1–F4 | Numbers that depend on `Date.now()`, start at the timestamp, or depend on `performance.now()` or `new Date()` | 8, 15, 9, 9 |
  | G1–G3 | A base key or a letter checked only within its own group; numbered keys from separate groups that coincide | 2, 2, 15 |

  Each F control fails the test that exports at four fixed clock readings, whose `Date.now()` and `performance.now()` values are odd and even, so that failure does not depend on the real clock. Their totals vary from run to run, because other tests use the real clock. The other 729 tests of the six export-related suites catch only E2 and E4, through the pinned bytes of ordinary records. They catch none of the other 21.

  Revision 001A's 34 controls, against the 22 letter-case tests and the 20 earlier ones. The letters in the second column are the controls the revision's brief asked for:

  | Control | For | Weakened copy | Failing, of 22 | Failing, of 20 |
  |---|---|---|---|---|
  | CA | A | Keys compared exactly again, the rule of `28cfc22e` | 19 | 0 |
  | CB | B | Lookups in lower case, records as written | 19 | 17 |
  | CC | C | Records in lower case, lookups as written | 19 | 17 |
  | CD | D | Letter-suffixed candidates compared and recorded exactly | 16 | 2 |
  | CE | E | Numbered candidates compared and recorded exactly | 11 | 0 |
  | CF, CF2 | F | Every key, or every suffixed key, written in lower case | 19, 17 | 18, 16 |
  | CG | G | The numbered search kept per spelling: same keys, more work | 2, the two work tests | 0 |
  | CH | H | A numbered key taken from the cursor without a lookup: same keys | 1, the lookup-before-record test | 0 |
  | CJ1, CJ2 | J | Keys alike without punctuation treated as alike; every key of a group given the first paper's capitals | 3, 16 | 3, 0 |
  | A (ported) | I | The `Date.now()` fallback restored | 13 | 15 |
  | B1–B3 (ported) | H | No check for the base key, the letters or the numbers | 19, 16, 12 | 17, 16, 11 |
  | C1–C3 (ported) | | A base, letter or numbered key given out without being recorded | 19, 16, 12 | 17, 16, 11 |
  | D1 (ported) | | The cursor never stored: same keys, quadratic work | 1, the linear-work bound | 1 |
  | D2–D4 (ported) | | The cursor skips numbers, is shared by every base key, or starts at 0 | 10, 2, 11 | 11, 2, 15 |
  | E1–E5 (ported) | J | Letters from `b`, `-` for `_`, no letters, a lower-cased base key, numbered keys without `_` | 17, 19, 17, 19, 11 | 17, 18, 17, 18, 15 |
  | F1–F4 (ported) | I | Numbers that depend on `Date.now()`, start at the timestamp, or depend on `performance.now()` or `new Date()` | 8, 12, 6, 7 | 6, 15, 9, 9 |
  | G1–G3 (ported) | H | A base key or a letter checked only within its own group; numbered keys from separate groups that coincide | 3, 3, 12 | 2, 2, 15 |

  CG and CH write the same keys as the revision, so only the work tests and the lookup-before-record test can see them. Every clock control fails the fixed-clock-readings test of both blocks. The other 729 tests catch only E2, E4 and CF, through the pinned bytes of ordinary records.
- **Performance.** Whole exports in jsdom on the development machine, the median of 9 runs, with every `Set` lookup counted. The machine's load average was 9 to 19, so differences of a few milliseconds are noise.

  | Workload | Papers | Lookups, `main` | Lookups, patched | Lookups, D1 | ms, `main` | ms, patched | ms, D1 |
  |---|---|---|---|---|---|---|---|
  | No shared base key | 3,000 | 40,891 | 40,891 | 40,891 | 44.2 | 42.1 | 42.7 |
  | One base key | 1,000 | 38,540 | 40,485 | 512,391 | 15.9 | 16.6 | 71.6 |
  | One base key | 3,000 | 118,540 | 124,485 | 4,539,391 | 50.3 | 47.6 | 558.8 |
  | One base key | 10,000 | 398,540 | 418,485 | 50,133,891 | 166.2 | 175.6 | 8,055.4 |
  | 10 base keys of 300 | 3,000 | 115,381 | 120,831 | 489,391 | 45.3 | 47.8 | 113.4 |
  | 100 base keys of 30 | 3,000 | 83,791 | 84,291 | 84,391 | 40.7 | 45.3 | 48.8 |

  The patched exporter makes about two more lookups per numbered key than `main`, which called `Date.now()` there instead. Without the cursor (D1), lookups grow with the square of a group's size. The suite checks this with operation counts, not timings: a group of 3,000 must take fewer than four times the lookups of a group of 1,000. Linear work takes three times as many, and D1 about nine.

  Revision 001A was measured again on 2026-11-25, the same way, with a load average of 7 to 15. The table compares `main`, `28cfc22e`, the revision and control CG, whose numbered search is kept per spelling:

  | Workload | Papers | Lookups, `main` | `28cfc22e` | Revision | CG | ms, `main` | `28cfc22e` | Revision |
  |---|---|---|---|---|---|---|---|---|
  | No shared base key | 3,000 | 40,891 | 40,891 | 40,891 | 40,891 | 43.9 | 40.4 | 41.5 |
  | One base key, one spelling | 3,000 | 118,540 | 124,485 | 124,485 | 124,485 | 46.2 | 46.4 | 48.6 |
  | One base key, one spelling | 10,000 | 398,540 | 418,485 | 418,485 | 418,485 | 165.1 | 180.3 | 183.4 |
  | One base key, two spellings in turn | 3,000 | 118,189 | 124,079 | 124,485 | 127,456 | 45.6 | 46.7 | 49.1 |
  | One base key, twelve spellings | 3,000 | 114,679 | 120,019 | 124,485 | 157,111 | 45.8 | 45.9 | 47.8 |
  | One base key, twelve spellings | 10,000 | 394,679 | 414,019 | 418,485 | 528,111 | 172.6 | 178.4 | 178.9 |
  | One base key, every paper its own spelling | 1,000 | 12,891 | 12,891 | 40,485 | 512,391 | 11.1 | 11.7 | 16.3 |
  | One base key, every paper its own spelling | 3,000 | 40,891 | 40,891 | 124,485 | 4,539,391 | 35.4 | 35.3 | 47.2 |
  | One base key, every paper its own spelling | 10,000 | 138,891 | 138,891 | 418,485 | 50,133,891 | 145.9 | 142.7 | 179.7 |
  | Four groups of 2,500, mixed spellings, interleaved | 10,000 | 280,955 | 283,315 | 417,267 | 1,223,163 | 165.4 | 163.8 | 177.3 |

  - **No change in ordinary work.** For an export without collisions, and for a group of one spelling, the revision makes exactly the lookups of `28cfc22e`.
  - **Capitals cost nothing.** A group of 3,000 takes 124,485 lookups in the revision whatever its spellings, and 10,000 takes 418,485.
  - **One spelling per paper.** Where every paper has its own spelling, `main` and `28cfc22e` did less work only because they wrote those keys unchanged: 3,000 keys that BibTeX reads as one. The revision gives them distinct keys for the cost of a one-spelling group.
  - **Linear growth.** From 1,000 to 3,000 to 10,000 such papers, the revision's lookups grow 3.08 and 10.3 times. CG's grow 8.9 and 98 times, to 50.1 million.

  The timings are informational; no limit is asserted on them. The suite checks two counts: as many lookups whatever capitals a group's base keys have, and fewer than four times the lookups from 1,000 to 3,000 papers that each have their own spelling.
- **Field values, summaries and other formats.** A 3,000-record synthetic corpus was exported by `main` and by the patched exporter, with the clock frozen. The corpus mixes hostile text, token-like and unbalanced DOIs and links, PMIDs, runtime years that are not numbers, non-ASCII and empty author lists, and large groups whose base keys collide with each other's suffixed keys.
  - **BibTeX.** All 3,000 entries have the same type and fields, field for field. 262 keys changed, and they are exactly the 262 keys that ended in the frozen clock, each now numbered under the same base key. The patched file is `main`'s file with only those keys replaced, byte for byte: 1,251,593 B against 1,254,604 B. `main`'s file had 15 keys written more than once, for 247 surplus entries, and the patched file has none. The export summary is identical: 3,000 papers, 1,066 affected, 1,032 DOI fields and 57 URL fields.
  - **Each record alone.** All 3,000 single-record exports are byte-identical.
  - **CSV and RIS.** Byte-identical: 556,671 B and 838,851 B. So are the empty exports. `escapeCSV`, `serializeCSVCell`, `exportToCSV` and `exportToRIS` are unchanged, and no byte order mark is added.
- **Compatibility of revision 001A with the first fix.** Three 3,000-record corpora were exported by `main`, `28cfc22e` and the revision, with the clock frozen.
  - **How keys were checked.** They were read with a structural reader. Each record's base key was taken from its export alone, where it always gets its base key. Two separate reference implementations of the rule gave the expected keys: one compares keys as written, the other up to letter case. `28cfc22e`'s keys equal the first and the revision's the second, in every corpus.
  - **No two base keys that differ only in capitals.** This is the corpus above without the title "alpha". The revision's BibTeX file is byte-identical to `28cfc22e`'s: 1,251,769 B.
  - **The corpus above, which mixes "Alpha" and "alpha".** `28cfc22e`'s 3,000 keys are distinct as written but only 2,838 up to letter case. The revision's are 3,000 both ways. 344 keys changed:
    - 162 repeated an earlier key up to letter case in `28cfc22e`'s file;
    - 182 moved on because an earlier paper now holds their old key up to letter case;
    - all 344 belong to the 6 groups whose base keys come in more than one spelling (351 papers).
  - **A corpus of many spellings.** Its frequent title words come in up to four spellings, such as "Alpha", "alpha", "ALPHA" and "aLPHA". Its frequent first authors come in three spellings of one name and two of another. `28cfc22e`'s keys are 2,040 distinct up to letter case, and the revision's 3,000. 1,295 keys changed: 960 repeats and 335 that moved on, all in the 54 groups with more than one spelling (1,372 papers).
  - **Everything else is unchanged.** In all three corpora, every entry has the same type and fields as in `main`'s and `28cfc22e`'s files. The revision's file is `28cfc22e`'s with only the keys replaced, byte for byte. The export summary, every single-record export, the CSV, the RIS and the empty exports are identical across `main`, `28cfc22e` and the revision.
- **Build.** No dependency changed: `package.json` and `package-lock.json` are byte-identical to `main`'s. The code commit `15b986cf` and `main` `ded56c63` were each built in a clean worktree, with the same installed packages:
  - Of the web build's 9 files, 7 are byte-identical, the CSS included, and `index.html` differs only in the entry chunk's name.
  - The entry chunk grows by 63 B (+33 B with `gzip -9`). It differs in one region of about 1,760 characters, which holds `generateCiteKey` and `exportToBibTeX`: the numbered search replaces `Date.now()`, the new `Map` is passed in, and local names in those two functions change. The other 1,983,410 characters are identical. So the URL origins, the inlined environment keys, and the database, RPC, Edge Function, auth and storage calls are unchanged.
  - The extension output's 8 files, and its packaged archive (`0feb935d…`), are byte-identical.

  Revision 001A's code commit `43d4667a` was built the same way, beside `main` `ded56c63` and `28cfc22e`:
  - 7 of the web build's 9 files, the CSS included, are byte-identical in all three builds, and `index.html` differs only in the entry chunk's name.
  - **Entry chunk size.** It is 1,985,988 B: 142 B more than `main`'s and 79 B more than `28cfc22e`'s. With `gzip -9` it is 21 B and 54 B smaller.
  - **Why a byte comparison no longer localizes the change.** The two new top-level functions shift the short names the minifier gives other top-level functions throughout the chunk.
  - **Token comparison.** The chunks were compared token by token, with local names masked and keywords, punctuation, property names, numbers, regular expressions, strings and template text kept. The revision's chunk then differs from `28cfc22e`'s in one region, 350 tokens against 383, which holds `generateCiteKey` and the two new helpers. Its 29,512 string and template literals are identical.
  - **Un-minified builds.** Built without minification, the entry chunk's diff against `28cfc22e` is 4 hunks and 30 lines, and against `main` 6 hunks and 32 lines. All of them are in `generateCiteKey`, the two helpers, and the `Map` that `exportToBibTeX` passes in. So the URL origins, the inlined environment keys, and the database, RPC, Edge Function, auth and storage calls are unchanged.
  - The extension output's 8 files and its packaged archive (`0feb935d…`) are byte-identical in all three.
  - **How these sizes were measured.** The 1,985,988 B above comes from a build in a clean worktree, which has no `.env`. The same commit built in the main checkout, whose untracked `.env` adds the inlined `VITE_*` values, measures 1,986,248 B. Either way the chunk is 142 B larger than `main` `ded56c63` built the same way. These are local builds, not the files Production serves.

### After the merge

Recorded on 2026-11-27 for the merge of 2026-11-25. Items marked "reported" come from the post-merge qualification run that evening and were not repeated.

- **Merge.** `a9c40ea67434686ee944bc1b64660a4d84188624`, at 21:02:19 UTC, with parents `ded56c63` and `10d16192` (the reviewed head). Its tree, `d4b6eee3f63c18154dff0cf4e4d1e1fb283a50b4`, is the head's. It changed the three reviewed files, +1,277 and −22 lines.
- **Production.** `dpl_9HTMFXbpjaJCcFNUuXMYiRxq9361`, a Git deployment of `main` at `a9c40ea6`, was created at 21:02:23.150 UTC and READY at 21:02:50.729 UTC. On 2026-11-27 it was still READY, and all four Production aliases pointed at it.
- **Served bundle** (reported). The entry chunk changed from `index-BY6WpFwt.js` to `index-j2ns-noc.js`. It grew 146 B as served and 142 B once the `VITE_VERCEL_*` values that Vercel inlines were set equal, the same delta as the local builds above; with `gzip -9` it is 24 B smaller. With those values set equal, the served chunk matched the local build of the head in the qualification's token comparison.
- **Served allocator** (reported). The citation-key code of the served chunk passed 10 structural checks and 25 behavioral checks, the latter run in an isolated JavaScript realm. No Production export was made, so this qualifies the served code, not an export from a signed-in library. A signed-out smoke test passed 17 of 17 checks.
- **CI on `main`.** The push runs of `a9c40ea6` all passed on their first attempt: Validate `45700603978` (Vitest 275 files, 9,355 tests; lint 0 errors, 18 warnings), DB Tests `45700604466`, Extension `45700604200` and CodeQL `45700603279`. E2E is not run on push. The scheduled E2E run `45805927931` on 2026-11-26 passed: `e2e-local` 292 passed and 1 flaky, `touch-tablet-ux.spec.ts:664`, the known flake; `e2e-evidence` passed.
- **Security.** CodeQL's analysis of `a9c40ea6`, created at 21:04:27 UTC, reported 10 results: alerts 1–6, 8 and 16–18, the same as before the merge. Dependabot showed 0 open alerts and secret scanning 0, and `npm audit` found 0 full and 0 production findings; see [Current audit state](#current-audit-state).
- **Unchanged limits.** Nothing below under "Not verified" changed with the merge: no BibTeX program or reference manager was run, and no CI lane imports or exports BibTeX, so no E2E test covers these keys.

### Not verified

- **External tools.** No BibTeX program, biber or reference manager is installed here, and none was installed for this fix. The key grammar, and BibTeX's comparison of database keys up to letter case, come from reading `bibtex.web` 0.99e and its typeset edition, not from running it. No claim is made about how biber or any reference manager treats these keys.
- **Production.** No Production export or import was run, and no Production data was read, so the share of real libraries that reach the fallback is unknown.
- **End to end.** No CI lane imports or exports BibTeX (see [Browser qualification](#browser-qualification)). The tests of exported bytes above are the qualification for this change, and no browser run was made.

### What remains

Each item is separate work, and none of it is part of this change:

- **RIS record boundaries**; see [RIS record integrity](#ris-record-integrity), whose fix is proposed in a Draft pull request.
- **CodeQL groups Q2–Q4**; see the [CodeQL triage outcome](#codeql-triage-outcome-2026-11-23).
- **The search cache after an import** (`PAPERLUME-POST-IMPORT-SEARCH-CACHE-001`): a search repeated within 30 s of an import hides the papers just imported; see [Browser qualification](#browser-qualification).
- **Saved filter presets.** Whether any stored preset exceeds the 1,000-entry bound is unmeasured; see the [Zod 4 migration](#zod-4-migration).
- **Bundled dependency copies:** see [Vite's bundled `postcss-selector-parser`](#residual-vites-bundled-postcss-selector-parser) and [Vite's bundled `ws`](#residual-vites-bundled-ws).
- **CSV byte order mark** interoperability; see the [CSV residual findings](#residual-findings).
- **E2E spec coverage** (`PAPERLUME-CI-E2E-SPEC-COVERAGE-AUDIT-001`); see [BibTeX codec and record integrity](#bibtex-codec-and-record-integrity-codeql-q1).
- **E2E runtime.** The `e2e-local` lane runs close to its job timeout, and `touch-tablet-ux.spec.ts:664` has flaked in recent runs.
- **Notification semantics and lifecycle.** The compatibility notice uses the error-styled warning tier, there is no per-message lifetime, and Escape after Alt+T does not restart a notice's timer; see [The export notice](#the-export-notice) and [Browser qualification](#browser-qualification).
- **Superseded Dependabot pull requests.** PRs 351–354 are still open.

## RIS record integrity

**Status: fix proposed in a Draft pull request, not merged.** `PAPERLUME-RIS-RECORD-BOUNDARY-INTEGRITY-001` is based on `main` `a9c40ea6` and rated P3, for bibliographic data integrity. It repairs the RIS residual finding of the [CSV formula injection](#csv-formula-injection-cwe-1236) audit, which was found by reading the code, not by CodeQL. No CodeQL rule reports it, and no dependency changes. An independent review of the first version found that reading continuation lines let a continued link become a different link or PMID. Revision `PAPERLUME-RIS-RECORD-BOUNDARY-INTEGRITY-001A`, in the same pull request, therefore reads links, the year and the attachment link from their tag lines again; see [Identifier authority (revision 001A)](#identifier-authority-revision-001a). Until the fix merges and deploys, `main` and Production still export and import RIS as described under [What was wrong in RIS](#what-was-wrong-in-ris).

| Field | Value |
|---|---|
| Weakness | CWE-93, improper neutralization of CRLF sequences: the line break separates RIS fields and records, and stored values were written without neutralizing it |
| Classification | **P3**, bibliographic data integrity |
| Where | `exportToRIS` in `src/lib/exportUtils.ts` (export) and `parseRISEntries` in `src/lib/importParsers.ts` (import) |

**Why P3.** A stored value could add fields or whole records to an exported file. Whoever imports that file, PaperLume included, then receives them. That includes a `UR` line that gives a paper a PMID, a `DO` line, authors and links. A third party could write such a value into a library through a shared file or a metadata record it controls. But that adds nothing to what a RIS file written by that third party can already do when it is imported. No code runs, and imported text reaches no HTML interpreter. So the rating stays at P3, and no additional security consequence was found.

### What was wrong in RIS

Reproduced on `main` `a9c40ea6` with the real `exportToRIS` and `parseRIS`, reading the exported bytes. All values were synthetic.

**Export.** `exportToRIS` wrote each value straight after its tag. A line break in a value therefore started a new line, and the text after it was read as a line of its own:

| Stored value (one paper unless stated) | Read back by `parseRIS` on `main` |
|---|---|
| A structured abstract over five lines, one of them empty | 1 paper; the abstract cut to its first line |
| An abstract with lines `KW  - …`, `AU  - Fabricated, Author`, `DO  - 10.9999/fabricated`, `UR  - https://pubmed.ncbi.nlm.nih.gov/99999999/`, `PY  - 1901` | 1 paper with an added author, keyword and DOI, and the PMID 99999999 taken from the `UR` line; the abstract cut |
| A DOI-only paper whose abstract has a PubMed `UR` line | the paper gains the PMID 31415926 |
| A title with a second line `PY  - 1999`, stored year 2020 | year 1999, the title cut |
| `ER  - `, an empty line, `TY  - JOUR` and a `T1` line, in an abstract | 2 papers: the abstract cut, and an injected record holding the paper's keywords, study type, tag and project |
| The same text in each of 13 fields: title, author, a year that is not a number, journal, DOI, attachment link, abstract, keyword, MeSH term, substance, study type, tag and project, with a sentinel paper after it | 3 papers for 2 in each case; the sentinel itself intact |
| `TY  - JOUR` and a `T1` line in an abstract, between two sentinels | 3 papers, but the affected one replaced by the injected record: its title, author, DOI and abstract lost |
| `ER  - ` then `TY  - JOUR` in an abstract | the injected record has no title, so it is skipped with "RIS entry 2: missing title, skipped", and the paper's keywords are lost with it |
| A title holding a lone CR, U+2028 or U+2029 | the paper is lost: its `T1` line did not match the tag pattern, so the record was skipped as untitled |
| An abstract holding a lone CR, U+2028 or U+2029 | the abstract is lost |
| A line break as LF or CR LF in a title | the title cut at it |

`UR`, `L2` and `AN` could not carry a line break: they are built from parsed URLs and validated PMID digits, which hold none. Every other field could. A value holding U+0085 NEXT LINE was read back correctly. The four structural readers described under [RIS format evidence](#ris-format-evidence) also found 2 records for the abstract with an injected record and 3 for each of the 13-field cases, so the corruption is in the file, not only in PaperLume's reading of it.

**Import.** `parseRISEntries` ignored every line that did not match its tag pattern, so a value continued on further lines was cut to its first line: the historical specification's own sample, a Zotero-style export of a multi-line abstract, and an EndNote-style indented abstract all lost their continuation lines. A wrapped author or keyword lost its second line. A record missing its `ER` before the next `TY` was dropped without a warning. These behaviours were confirmed as documented tolerances and are kept: a final record without `ER` is read; an `ER` outside a record and text outside records are ignored; an empty record and a record without a title are skipped with "missing title, skipped"; a file whose tag lines have one space before the hyphen, or whose only line ending is CR, gives "No valid RIS entries found in file."

### RIS format evidence

Read from the sources below; no reference manager is installed here, and none was installed or run.

- **The historical specification.** "RIS Format Documentation", Thomson Reuters ResearchSoft, its pages last updated May 2009, in `direct export.zip` (file dated 2011-09-20), as the Internet Archive holds it from `refman.com/support/risformat_intro.asp`, the page Zotero's format list links to.
  - A tag is a capital letter, a capital or digit, two spaces, a hyphen and a space.
  - Each tag and its contents go on a separate line, preceded by CR LF.
  - `TY` is the first tag of a reference and `ER` the last.
  - Fields may hold the characters from space (32) to 255, so no control character.
  - A field longer than 70 characters may continue on the next line after a CR LF; the sample abstract continues on unindented lines.
  - Authors and keywords repeat, one per tag; per the specification, other fields occur once.
  - `UR` may hold several URLs on one line, separated by semicolons.
- **Zotero.** Its "Data formats" page says the specification was last updated in 2001 and that Zotero exports "fairly strict RIS". Its RIS translator (`RIS.js` in `zotero/translators`, last updated 2026-01-05):
  - accepts one or two spaces before the hyphen;
  - adds a line that is not a tag line to the field above it, trimmed: with a line break for `AB`, `N1`, `N2` and `RN` by a line-length heuristic, with a line break for `KW`, `L1`, `L2` and `L3`, which it later splits into separate keywords and links, and with a space otherwise;
  - ends an unfinished record at a `TY` and keeps it; ignores an `ER` outside a record; replaces U+2028 and U+2029 with a space;
  - writes CR LF line endings, but writes a multi-line value's line breaks as they are, so its own files rely on unindented continuation lines.
  - Its string reader (`zotero/translate`) splits lines at LF, dropping a CR before it, and at a lone CR only when no LF follows.
- **EndNote 2025.** Its "Continuation Lines" page, under `docs.endnote.com/docs/endnote/2025/v1/windows/en/content/19filters/` (the same address without `/v1/` returns 404), says EndNote ignores lines that do not begin with a tag unless they continue a tagged field. Its default, Smart Indent Identification, imports continuation lines indented to align with the first line's data. "Ignore Indents" instead makes every untagged line a continuation. Its "Record Layout" page says the default record detection starts a new record where a tag repeats out of sequence after a blank or extraneous line, and that "Blank line separates records" is an option.
- **Citavi** (manual 7, "Importing a RIS file"): a two-letter field code, two spaces, a hyphen and one space. It says nothing about continuation lines.
- **JabRef** (`RisImporter.java`, `main` `794547e5`):
  - reads lines with Java's `BufferedReader`, so LF, CR or CR LF ends a line;
  - splits records at `ER  -` wherever it appears in the text, even inside a value on one line;
  - adds a line of at least six characters whose third to sixth characters are not "  - " to the line above it.
- **rispy** (`rispy/parser.py`, `main` `b7aae3b2`):
  - a tag line has "  -" as its third to fifth characters;
  - any other line continues the last tag: joined with a space to a single field, but a new element of a list field (`A1`–`A4`, `AU`, `KW`, `N1`, `UR`);
  - `UR` is split at semicolons;
  - a `TY` before `ER` merges the two records, and a final record without `ER` is dropped.

To compare structure, four small readers were written in a scratch directory: one from the specification and ports of the Zotero, rispy and JabRef line and record logic. No third-party code was run. Their results describe those ports, not the tools.

### Fields

| Tag | Exported from | Kind | Repeated | Line break legitimate | Existing validation | Written as | Read on import (revision 001A) |
|---|---|---|---|---|---|---|---|
| `TY` | fixed `JOUR` | marker | no | — | — | fixed text | starts a record |
| `T1` | `title` | prose | no | no | none | one value, continuation lines | whole value |
| `AU` | each of `authors` | list element | yes | no | none; an opaque mention on import | one line, line breaks as spaces | whole value, one element |
| `PY` | `year` | number | no | no | a number is written as JavaScript prints it; nothing checks a value that is not one | one value, continuation lines | tag line alone |
| `JO` | `journal` | prose | no | no | none | one value, continuation lines | whole value |
| `AN` | `pmid` | identifier | no | no | only a valid PMID, digits | as before; holds no line break | not read |
| `DO` | `doi` | identifier | no | no: no DOI name holds one | none: the DOI name as stored | one value, continuation lines | whole value if its tag line holds a DOI name, else the tag line alone |
| `UR` | PMID, PubMed link, DOI or journal link, in that order | link | no | no | a parsed http(s) URL or a canonical one | as before; holds no line break | tag line alone |
| `L2` | `journal_url` | link | no | no | a parsed http(s) URL | as before; holds no line break | tag line alone |
| `L1` | `drive_url` | attachment link | no | no | none: free text, as stored | one value, continuation lines | tag line alone |
| `AB` | `abstract` | prose | no | **yes** | none | one value, continuation lines | whole value |
| `KW` | each of `keywords`, `mesh_terms`, `substances` | list element | yes | no | none | one line, line breaks as spaces | whole value, one element |
| `N1` | `study_type` | label | no | no | none | one value, continuation lines | whole value |
| `C1` | each tag's name | custom list element | yes | no | none; not read on import | one line, line breaks as spaces | not read |
| `C2` | each project's name | custom list element | yes | no | none; not read on import | one line, line breaks as spaces | not read |
| `ER` | fixed | marker | — | — | — | fixed text | ends the record |

The alternate tags the importer also reads follow their primary tag: `TI` and `T2` as `T1`, `A1` as `AU`, `JF` and `JA` as `JO`, `N2` as `AB`, and `Y1` and `DA` as `PY`.

Values reach these fields from imports (BibTeX, RIS, NBIB, EndNote and CSV files), from PubMed and Crossref metadata, from the add and edit dialogs and from a user's own direct writes. No database constraint keeps a line break out of any of them. A BibTeX or CSV import can store one, and HTML-entity decoding turns `&#10;` into one.

### The fix

Four ways of writing a multi-line value were compared:

- **A, flatten every line break.** Safe for every record, but it loses the paragraphs of an abstract, which the app shows with their line breaks, and it would turn a DOI or link that holds a line break into a different value.
- **B, continuation lines everywhere.** It keeps every value. But a continued author or keyword becomes several values in rispy and, for keywords, in Zotero.
- **C, by field.** Continuation lines for fields that hold one value, and one line for each list element. **This was chosen.** It keeps prose and identifiers whole for PaperLume, and no reader examined splits a list element.
- **D, an app-specific encoding.** It is needed only where a legitimate value cannot be written safely, and no legitimate value here is such a case. So no PaperLume-specific tag, escape or notice is added.

**The contract written by `exportToRIS`:**

- **Every paper is one record:** `TY  - JOUR`, its fields in the same order as before, `ER  - `. Records are separated by one empty line, and lines end in LF. There is no CR and no byte order mark anywhere, and the file name and media type are unchanged.
- **A line break inside a value is CR LF, CR or LF.** RIS ends lines at CR LF or LF, and some readers also end them at a lone CR.
- **A field that holds one value** (`T1`, `PY`, `JO`, `AN`, `DO`, `UR`, `L2`, `L1`, `AB`, `N1`) writes the first line of its value after the tag. Each further line goes on a continuation line: six spaces, the width of the tag column, then the line's text, which may be empty or begin with spaces. A line that starts with six spaces cannot start a field for any reader examined, so continuation text such as `ER  - ` stays in its field.
- **A list element** (`AU`, `KW`, `C1`, `C2`) stays on its one tagged line, with each line break in it written as one space. The stored value is unchanged.
- **Other characters are unchanged**, U+2028, U+2029 and U+0085 included: they are not RIS line endings.
- **A value with no line break** is written exactly as before.

**The contract read by `parseRISEntries`:**

- **Lines** end at LF, with a CR just before it dropped, as before.
- **A tag line** is matched by its shape, as before, so an unfamiliar tag still begins a field of its own. Its value may now hold U+2028 or U+2029: such a line used to fail to match and was dropped.
- **Inside a record, any other line continues the field above it** on a new line of that field's value. Up to six leading spaces are the line's indentation and the rest is text, even text that looks like a tag. An empty line is an empty line of the value. Each value is trimmed as a whole, so a one-line value is read exactly as before. Each field also keeps the value of its tag line alone, trimmed, as it was read.
- **Which fields take their continuation lines** (revision 001A). The text fields read the whole value. `UR`, `L2`, `L1`, `PY`, `Y1` and `DA` read their tag line alone, as before continuation lines were read. `DO` reads the whole value only when its tag line holds a DOI name, and otherwise its tag line alone. The table under [Fields](#fields) lists every tag; [Identifier authority (revision 001A)](#identifier-authority-revision-001a) says why.
- **Not continuations:** a line shaped like a tag but malformed, such as `AU - Name` with one space or a tag in lower case, and a line that holds a lone CR. Both are ignored, as before.
- **Lines outside a record** are ignored and are never added to the record before them.
- **A `TY` inside an unfinished record** still starts a new record in its place, and a final record without `ER` is still read. Whether such an unfinished record should be kept is a recovery decision this change does not make: Zotero keeps it, while rispy and JabRef merge it into the next record.

**What comes back.** PaperLume's own export reads back every text value as stored, except for three normalizations, so it is not character for character where they apply:
- CR LF and CR inside a value become LF;
- a line break inside a list element becomes a space;
- white space around a whole value is trimmed, as before.

The value's own leading spaces, trailing spaces, tabs and empty lines inside it are kept. A stored DOI that holds a line break comes back with it, under the same normalizations, when its first line is a DOI name, and as its first line otherwise. A stored attachment link or year that holds a line break comes back as its first line, as on `main`. `UR` and `L2` are written from parsed URLs, which hold no line break. After one export and import, further cycles give identical files.

**Identifiers.** `DO` holds the DOI name as stored, never a resolver URL. `UR` keeps its order of precedence, and the resolver URL is encoded once: `10.1000/456#789` gives `DO  - 10.1000/456#789` and `UR  - https://doi.org/10.1000/456%23789`, as before. `L2` stays beside a higher-ranked `UR`. `AN` is written only for a valid PMID and is still not trusted on import; a PMID still comes only from a PubMed record URL in a `UR` tag line, so text in an abstract that reads like `AN` or `UR` sets nothing. Each `UR` and `L2` is read from its tag line alone, so a continuation line can neither add to a link nor supply one. Authors keep their order and one mention each, recorded as `AU` with kind `unknown`, as before.

### Identifier authority (revision 001A)

**What the review found.** The first version of this fix read continuation lines into every field. `risEntryToRawPaper` then handed a continued `UR`, with its lines joined by LF, to `extractPmidFromPubMedUrl`, `isPubMedRecordUrl` and `toImportableExternalUrl` in `src/lib/pubmedIdentifiers.ts`. Those use the WHATWG URL parser, which removes every ASCII tab, LF and CR from its input. `new URL("https://pubmed.ncbi.nlm.nih.gov/123\n456/").href` is `https://pubmed.ncbi.nlm.nih.gov/123456/`. So `UR  - https://pubmed.ncbi.nlm.nih.gov/123` continued by `456/` was read as the record 123456, which neither line names. `main` ignores continuation lines and reads the record 123. The independent review found this; it was not found by CodeQL.

**Reproduced.** 82 synthetic third-party fixtures, each between two sentinel records, were read by the real `parseRIS` of `main` `a9c40ea6`, of the first Draft head `9c76e2bd` and of the revision. No request was made to PubMed or any resolver. The review's own fixture gave PMID 123 on `main`, 123456 on the first Draft and 123 with the revision. The first Draft changed a PMID, PubMed link, journal link, attachment link, saved DOI or year relative to `main` in 51 of the 82. Every sentinel came through whole with all three. Examples:

| Fixture: tag line, then continuation line | `main` | First Draft | Revision |
|---|---|---|---|
| `UR  - https://pubmed.ncbi.nlm.nih.gov/123`, then `456/`: six-space, four-space, tab-led or unindented, LF or CR LF | PMID 123 | PMID 123456 | PMID 123 |
| The same, continued after eight spaces or by `ZZ  - 456/` | PMID 123 | no PMID; a journal link `…/123%20%20456/` or `…/123ZZ%20%20-%20456/` | PMID 123 |
| `UR  - https://pubmed.ncbi.nlm.nih.gov/`, then `999/` | journal link `https://pubmed.ncbi.nlm.nih.gov/` | PMID 999 | as `main` |
| `UR  - https:`, then `//pubmed.ncbi.nlm.nih.gov/999/` | nothing | PMID 999 | nothing |
| An empty `UR`, continued by a PubMed URL, then `UR  - …/123/` | PMID 123 | PMID 999 | PMID 123 |
| `UR  - https://journal.example`, then `.elsewhere.example/x` | journal link `https://journal.example/` | `https://journal.example.elsewhere.example/x` | as `main` |
| `L2  - https://journal.example/a`, then `b` | `…/a` | `…/ab` | `…/a` |
| An empty `L2`, continued by a URL | no journal link | that URL | no journal link |
| `L1  - https://drive.example`, then `.elsewhere.example/x` | the link opens `https://drive.example/` | it opens `https://drive.example.elsewhere.example/x` | as `main` |
| An empty `PY` continued by `2020`, then `Y1  - 1999` | year 1999 | 2020 | 1999 |
| An empty `DO`, or `DO  - doi:` or `DO  - https://doi.org/` alone, continued by `10.1000/xyz` | no DOI, or the prefix alone | saved as `10.1000/xyz` | as `main` |
| `DO  - 10.1000/abc`, then `def` | `10.1000/abc` | `10.1000/abc` LF `def` | as the first Draft |

Two fixtures differ from `main` with the revision for a reason that is not continuation. A `UR` tag line that ends in U+2028 now gives its PMID, and one that holds U+2028 inside its path gives a journal link with `%E2%80%A8` in it. `main` dropped both lines, because its tag pattern did not match U+2028. That is the first version's tag-line change, not a continuation; the URL parser percent-encodes U+2028, so it joins nothing.

**The policy.** As approved for this revision, an identifier is interpreted from the tag line it was written on, as before:
- **`UR` and `L2`** are read from their tag lines alone, with the existing helpers, validation and normalization unchanged. So no URL is assembled from two lines, an incomplete tag line is not completed, the first PubMed record on a tag line still supplies the PMID, and `L2` still wins over a generic `UR`.
- **`L1`** is read the same way. It is stored unvalidated, as before, but the application renders it through `toSafeExternalHref` in `QuickAddDriveLink`, which uses the same URL parser. So a continued `L1` opened a joined link, a different host included. No attachment validation is added.
- **`PY`, `Y1` and `DA`** are read from their tag lines, so a continuation line cannot supply a year or change which tag it comes from. On the first Draft, the "9999" of a DOI on a continuation line of a stored year that is not a number became the year.
- **`DO`** keeps the first version's handling of a multi-line DOI, but only after a tag line that holds a DOI name. `extractDoiFromMetadataValue` in `src/lib/doiIdentifiers.ts` decides that, unchanged; it accepts `10.1000/x`, `doi:10.1000/x` and `https://doi.org/10.1000/x`. Otherwise `DO` is its tag line alone, as on `main`. A one-line `DO` is not checked at all, since its value is its tag line.
- **`AN`** is still not read, so it is not a PMID however it is continued.
- **Text fields** keep the first version's handling unchanged: titles, authors, the journal, the abstract, keywords and notes.

Each field keeps its tag-line value from the moment it is parsed (`RISField.tagLineValue`), not by splitting a trimmed value later. That way an empty tag line followed by text stays distinct from a tag line holding that text. The exporter, `src/lib/exportUtils.ts`, is not changed, and its output is byte-identical to the first Draft's. Any future support for a URL wrapped over physical lines would need an explicitly defined interoperability contract; no reader examined defines one.

**DOI assessment.** The consumers of an imported DOI were traced from the source:
- `normalizePaperData` removes one leading `https://doi.org/`, `http://dx.doi.org/` or `doi:`, trims the value and lowercases it. A line break inside the value is kept.
- The `safe_bulk_insert_papers` RPC resolves a duplicate, per user, by `pmid` equality and by `lower(doi)` equality. Those are the semantics of the unique indexes `idx_papers_user_pmid_unique` and `idx_papers_user_doi_unique`, per `20260903180000_add_deterministic_import_duplicate_resolution.sql`. Neither removes white space.
- `canonicalDoiUrl` encodes an inner LF as `%0A`, and `doiEquivalenceKey` folds ASCII case only.

So a DOI that keeps an inner line break is a deduplication identity of its own. Because no DOI name holds a control character, it can equal no other paper's DOI name. On `main`, the same stored value came back as its first line, a different DOI that looks valid and can match another paper. That was not a regression. But on the first Draft, a continuation after an empty, `doi:`-only or `https://doi.org/`-only tag line became, once the prefix was removed and the value trimmed, a DOI that no tag line stated. That is a new deduplication identity from continuation text alone, and the DOI-name check above is the field-specific correction. With it, every DOI saved from a continued `DO` either equals `main`'s or keeps a line break. That held for all 82 fixtures and both corpora below.

The DOI limits:
- CR LF and CR become LF, and white space around the value is trimmed, so a multi-line DOI is not kept character for character where those apply.
- A stored DOI whose first line is not a DOI name, such as `10.1000/` followed by `abc`, comes back as that first line, as on `main`. That line is not a DOI name either.
- A DOI holding a line break is not claimed to be a registered identifier: its resolver link, with `%0A`, names no registered DOI.
- Ordinary DOIs are unchanged: `DO  - 10.1000/456#789` and `UR  - https://doi.org/10.1000/456%23789`.

**Tests.** `exportRIS.integrity.test.ts` grows from 93 to 150 tests: 56 in a new block K2, and one more cycle test in U. Expected values are written by hand. K2 reads each fixture between two sentinel records and covers:
- concatenated PubMed paths, after six, four, eight or no spaces, a tab, tag-like text and the legacy path;
- incomplete PubMed URLs, empty `UR` and `L2` tag lines, and generic `UR` paths, hosts and queries;
- explicit `L2` and its precedence, several `UR` lines, and an invalid `UR` before a valid one;
- PubMed and journal precedence, LF and CR LF, and tag-line URL normalization;
- an abstract beside a continued `UR`, an ordinary DOI and PMID, and `AN`;
- the DOI-name check, including the saved DOI through `normalizePaperData`;
- `L1` with the link it opens through `toSafeExternalHref`, and the year.

The first Draft fails 48 of the 150, and `main` fails 72. Three assertions of the first version's suite were revised on purpose, and its header states the new import contract:
- **`K. DOI (DO)`** under "a field that holds one value…": the stored record-syntax value, whose first line "Opening line." holds no DOI name, now reads back as that line. The test is renamed "reads back as its tag line alone, with nothing injected".
- **`L. attachment link (L1)`**, the same, and renamed the same way.
- **"every field at once"**: the DOI and the attachment link are now "Opening line.", and the year is now `null`. On the first Draft it was 9999, from the DOI text on a continuation line.

**Negative controls.** 15 new weakened copies of `importParsers.ts` were run through a scratch alias, without changing the repository. Each ran against the revised suite and the same seven export and import suites (645 tests). The unmodified revision passes all of them:

| Control | Weakened copy | New suite failing, of 150 | Existing failing, of 645 |
|---|---|---|---|
| — | `main`'s two modules / `main`'s parser only / the first Draft | 72 / 46 / 48 | 0 / 0 / 0 |
| A | A continued `UR` passed whole to the URL helpers again | 24 | 0 |
| B | A continued `L2` passed whole again | 6 | 0 |
| C | The tag line recovered by splitting the trimmed whole value | 10 | 0 |
| D | An empty tag line taking its continuation (`UR`, `L2`, `L1`, years, `DO`) | 10 | 0 |
| F | A valid PubMed record URL joined with its continuation | 13 | 0 |
| G | `AN` trusted as a PMID | 2 | 4 |
| H | Only the first `UR` read | 5 | 2 |
| I | A generic `UR` preferred to `L2` | 1 | 1 |
| J | An abstract read from its tag line alone | 30 | 0 |
| L | The record after a continued field dropped | 76 | 0 |
| Year | The year read from the whole value | 7 | 0 |
| Attachment | `L1` read from the whole value | 10 | 0 |
| DOI 1 | `DO` always the whole value (the first Draft) | 9 | 0 |
| DOI 2 | `DO` always the tag line (`main`) | 9 | 0 |
| DOI 3 | `DO` continued after any non-empty tag line | 8 | 0 |

The brief's controls E, removing all continuation handling, and K, letting a continuation start a field or record, are the earlier controls E, G and M2. The 30 controls of the first version were re-applied to the revised source. Only P4 and P6 needed a new anchor, because the `finish` mapping now spans three lines. Each still fails tests of the revised suite, between 1 and 52 of the 150. The existing suites still catch only I, J, K1, N1 and N2 among those. Among the new ones they catch G, H and I. They catch none of the continuation controls.

**Differential.** With the clock frozen, a 3,000-paper stored corpus was exported by all three exporters. It is a revision of the first version's corpus, adding multi-line DOIs and years:
- **CSV and BibTeX.** 434,697 B and 920,580 B, byte-identical across `main`, the first Draft and the revision. The BibTeX summary is identical too: 3,000 papers, 389 affected, 389 DOI fields, no URL fields.
- **RIS.** The revision's file is byte-identical to the first Draft's, at 771,288 B.
- **Re-imported** with the first Draft's parser and the revision's, both give 2,949 papers and 51 "missing title" warnings.
  - Every DOI, attachment link and year matches hand-stated expectations: 0 mismatches.
  - The text fields, PMIDs, PubMed links and journal links equal the first Draft's.
  - The DOI differs from the first Draft's for 483 papers, the year for 388 and the attachment link for 928, each as the contract states.

A 2,000-record third-party corpus covered single-line records, structured abstracts and multi-line titles and journals. It also covered wrapped authors and keywords, valid and malformed multi-line DOIs, and PubMed, generic, `L2` and `L1` links, plain and continued. Multiple `UR` lines, malformed lines and unknown tags complete it. It was read in LF (746,679 B) and CR LF (783,552 B):
- Each parser gives 2,000 papers and no warnings.
- The 500 single-line records are identical across all three.
- For all 2,000, the PMID, PubMed link, journal link, attachment link and year equal `main`'s.
- The saved DOI equals `main`'s or keeps a line break (279).
- The text fields equal the first Draft's: 1,263 records read more text than on `main`.
- The first Draft had changed an identifier, link or year in 1,435 of them.

**Timing.** These are medians of 9 interleaved runs in jsdom, load average about 8.6. They are informational, and nothing asserts a time:

| Input | `main` | First Draft | Revision |
|---|---|---|---|
| Third-party corpus ×1 / ×2 / ×4 (0.75 / 1.49 / 2.99 MB) | 19.6 / 43.7 / 77.2 ms | 21.9 / 44.9 / 89.2 ms | 24.3 / 51.0 / 98.6 ms |
| The stored corpus's RIS export (0.77 MB) | 15.9 ms | 19.1 ms | 30.1 ms |

Work stays linear. The added cost is the DOI-name check, which runs only for a `DO` field with continuation lines. The stored corpus is adversarial in that respect: about two in five of its DOIs hold a line break.

**Suites and build.** The full Vitest suite has 276 files and 9,505 tests, against 9,448 on the first Draft. Lint reports 0 errors and the same 18 warnings, none in a changed file, and the three typechecks pass. `npm ci` leaves `package.json` and `package-lock.json` unchanged, and `npm audit` finds 0 vulnerabilities, full and production. `main` `a9c40ea6`, the first Draft `9c76e2bd` and the revision's code commit `df99a188` were each built in a clean worktree, with the same installed packages and no `.env`:
- **Files.** Of the web build's 9 files, 7 are byte-identical across all three, the CSS included, and `index.html` differs only in the entry chunk's name.
- **Entry chunk size.** 1,985,988 B on `main`, 1,986,378 B on the first Draft and 1,986,650 B with the revision. That is 272 B more than the first Draft and 662 B more than `main`. With `gzip -9` they are 564,568, 564,776 and 564,844 B.
- **Un-minified builds.** These show the change; a byte comparison of the minified chunks cannot localize it, because the minifier's short names shift.
  - Against the first Draft, the entry chunk differs in 6 hunks, 16 lines added and 6 removed, all in `parseRISEntries` and `risEntryToRawPaper`.
  - Against `main`, it differs in 18 hunks, 57 lines added and 28 removed, all in the RIS exporter, its constants and those two functions.
  - `extractDoiFromMetadataValue` was already in the bundle.
- **Unchanged surface.** Across the three builds, the un-minified JavaScript names the same 33 URL origins. It inlines the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. It makes the same number of `.rpc(`, `.from(`, `.functions.invoke(`, `.storage.from(`, `.auth.` and `fetch(` calls.
- **Extension.** The output's 8 files and its packaged archive (`0feb935d…`, 15,788 B) are byte-identical, and its browser lane passes 30 tests.

### Evidence

- **Tests.** `src/lib/__tests__/exportRIS.integrity.test.ts` is new, with 93 tests. They read every export twice: once with a structural reader written for the suite, which rejects any line that is neither a field nor a continuation, a `TY` or `ER` inside a record and an empty line inside a record, and once with `parseRIS`. Expected values are written out by hand. They cover:
  - an ordinary record and several records, byte for byte as on `main`, with the file name and media type;
  - each single-value field and each list field holding record syntax, with a sentinel paper after it; all fields at once;
  - a year that is not a number, DOI and link boundaries, PMID authority, and `UR` and `L2` precedence;
  - LF, CR LF, CR and mixed line breaks; U+2028, U+2029 and U+0085;
  - tag-like text, empty lines and white space inside prose, and scientific text;
  - unknown tags; third-party files in the specification's, Zotero's and EndNote's shapes; files exported by `main`;
  - malformed input;
  - repeated cycles, an empty export, an abstract of 2,002 lines, and 3,000 papers with multi-line values in every field;
  - CSV and BibTeX bytes for a paper with line breaks in every field.

  63 of the 93 fail on `main`. The other 30 pin what `main` already does: ordinary bytes, empty exports, malformed-input tolerances, and fields that cannot hold a line break.
- **Negative controls.** 30 weakened copies of the two modules were run through a scratch alias, without changing the repository, against the new suite and the seven existing export and import suites (645 tests). An unmodified copy passes all of them. Every copy fails tests of the new suite, except where noted:

  | Control | Weakened copy | New tests failing, of 93 | Existing tests failing, of 645 |
  |---|---|---|---|
  | — | `main`'s two modules / `main`'s exporter only / `main`'s parser only | 63 / 50 / 39 | 0 / 0 / 0 |
  | A | Values written raw after their tags, as on `main` | 50 | 0 |
  | B | Only `AB` protected | 31 | 0 |
  | C | A lone CR not taken as a line break on export | 16 | 0 |
  | D | A lone LF not taken as a line break on export | 46 | 0 |
  | E | Continuation lines ignored on import, as on `main` | 37 | 0 |
  | F | Lines after `ER` added to the record before them | 1 | 0 |
  | G | Tag-like text on a continuation line read as a tag | 23 | 0 |
  | H1 | Continuation lines left out of the export | 35 | 0 |
  | H2 | A value's lines joined with spaces (option A) | 34 | 0 |
  | I | The DOI written as its resolver URL | 47 | 10 |
  | J | `AN` trusted as a PMID | 1 | 4 |
  | K1 | `L2` left out beside a `UR` | 4 | 1 |
  | K2 | `UR` preferring the journal link to the DOI | 1 | 0 |
  | L1 | All authors in one `AU` line | 7 | 0 |
  | L2 | An author split into two `AU` lines at its line break | 8 | 0 |
  | L3 | List elements on continuation lines (option B everywhere) | 16 | 0 |
  | M1 | A paper with an empty title left out | 1 | 0 |
  | M2 | An indented `ER` or `TY` ending the record on import | 15 | 0 |
  | N1 | CSV no longer quoting `;` | 1 | 3 |
  | N2 | The BibTeX title without its inner braces | 1 | 3 |
  | O1 | A continuation indent of five spaces | 33 | 0 |
  | O2 | Unindented continuation lines | 34 | 0 |
  | O3 | An empty line of a value written as an empty line | 13 | 0 |
  | P1 | All leading white space taken as indentation on import | 10 | 0 |
  | P2 | A malformed tag line taken as a continuation | 1 | 0 |
  | P3 | The old tag pattern, which drops a line holding U+2028 | 2 | 0 |
  | P4 | Each line trimmed on import | 16 | 0 |
  | P5 | A line holding a lone CR taken as a continuation | 1 | 0 |
  | P6 | Continuation lines joined with a space on import | 36 | 0 |
  | P7 | Only indented lines taken as continuations | 3 | 0 |

  The existing suites catch only I, J, K1, N1 and N2, and none of the controls that break records or line structure.

- **A 3,000-record differential.** Synthetic papers mixing line breaks in every field, record syntax, U+2028 and U+0085, hostile identifiers and links, years that are not numbers and ordinary values were exported by `main` and by the fix, with the clock frozen.
  - **CSV.** 422,578 B, byte-identical.
  - **BibTeX.** 909,570 B, byte-identical, with the same export summary: 3,000 papers, 555 affected, 555 DOI fields and no URL field in a PaperLume field.
  - **Empty exports.** Byte-identical in all three formats.
  - **RIS.** 702,148 B on `main` and 737,646 B with the fix. Of the 3,000 single-record exports, the 2,778 that changed are exactly the records with a CR or LF in an exported value; the other 222 are byte-identical.
  - **Re-import of the fix's file.** 2,949 papers and 51 "missing title, skipped" warnings, for the 51 papers with an empty title, as before. Every title, author list, journal, DOI, abstract, attachment link, keyword list and study type equals the stored value under the contract above. `main`'s file read as 2,528 papers with 1,491 warnings.
  - **The four structural readers.** On the fix's file, the specification reader and the Zotero and rispy ports find 3,000 records. The JabRef port finds 4,774, because `ER  -` occurs 2,013 times inside values, and JabRef splits at it even inside a line. On `main`'s file they found 4,019, 4,076, 4,019 and 4,867.
- **Performance.** Medians of 7 runs in jsdom on the development machine, load average about 7. The timings are informational, and the suite asserts no time limit. Work grows linearly in every workload, on `main` and with the fix:

  | Workload | Size ×1 | Export ms, `main` / fix (×1, ×2, ×4) | Parse ms, `main` / fix (×1, ×2, ×4) |
  |---|---|---|---|
  | One abstract of 10,000 lines, a seventh of them `ER  - ` | 0.75 MB | 15.7 / 13.5, 28.9 / 29.0, 60.2 / 76.6 | 1.0 / 1.6, 1.2 / 2.6, 2.2 / 4.9 |
  | 1,000 papers with line breaks in six fields | 0.34 MB | 6.7 / 7.9, 15.5 / 17.7, 28.5 / 38.5 | 2.5 / 6.1, 4.2 / 12.2, 10.0 / 23.5 |
  | 3,000 ordinary papers (identical bytes) | 0.76 MB | 17.5 / 19.1, 36.0 / 45.0, 88.3 / 97.3 | 14.1 / 17.2, 29.2 / 34.8, 57.9 / 75.2 |
  | An abstract of 20,000 `ER  - ` lines | 0.26 MB | 2.3 / 5.7, 4.8 / 10.7, 9.7 / 25.7 | 1.5 / 2.2, 2.9 / 4.4, 5.7 / 8.4 |
  | 100,000 malformed or outside lines (parse only) | 1.3 MB | — | 3.8 / 5.5, 10.0 / 11.3, 27.6 / 23.4 |

  `main` parses some workloads faster because it drops the lines the fix reads. Each value's lines are collected and joined once, and the parser makes one pass with no backtracking-prone pattern.
- **Suites.** The full Vitest suite has 276 files and 9,448 tests, against 275 and 9,355 on `main`. Lint reports 0 errors and the same 18 warnings, and the three typechecks pass.
- **Build.** No dependency changed: `package.json` and `package-lock.json` are byte-identical to `main`'s, and nothing under `supabase/` or `.github/` changed. `main` `a9c40ea6` and the code commit `5775decf` were each built in a clean worktree, with the same installed packages and no `.env`:
  - Of the web build's 9 files, 7 are byte-identical, the CSS included, and `index.html` differs only in the entry chunk's name.
  - **Entry chunk size.** It grows by 390 B, from 1,985,988 B to 1,986,378 B, and by 208 B with `gzip -9`.
  - **Why a byte comparison does not localize the change.** The new top-level functions shift the short names the minifier gives other top-level functions, so the two chunks agree for only 9 characters at each end.
  - **Token comparison.** Local names were masked, and keywords, punctuation, property names, numbers, regular expressions, strings and template text kept. The chunks then differ in 86 hunks in two places. One is about 370 tokens, where the RIS exporter follows the CSV exporter, and the other about 155 tokens, in `parseRISEntries`; the other 734,000 tokens are identical. The string and template literals differ only in the RIS tags, the six-space indentation and the line-break strings.
  - **Un-minified builds.** Built without minification, the entry chunk differs in 13 hunks and 67 lines. All of them are in `exportToRIS`, its two new functions and constants, and `parseRISEntries`. So the URL origins, the inlined environment keys, and the database, RPC, Edge Function, auth and storage calls are unchanged.
  - The extension output's 8 files and its packaged archive (`0feb935d…`) are byte-identical.

### Not verified

- **External tools.** No reference manager or RIS library is installed here, and none was installed. What Zotero, EndNote, JabRef, rispy and Citavi do comes from their documentation and source, and the structural readers above are ports, not the tools. In particular:
  - it was not observed that EndNote's RIS import uses Smart Indent Identification;
  - nor how EndNote treats a continuation line of six spaces alone, which some programs take as a blank line.
- **Browser.** No browser run was made: the change is in two pure functions, and the download and the import dialog are unchanged. No CI lane exports or imports a RIS file. The E2E specs only check that the RIS menu item is shown, so the Vitest suites above are the qualification.
- **Production.** No Production export or import was run, and no Production data was read, so how many stored values hold a line break is unknown.
- **Revision 001A** was qualified with the Vitest suites, the scratch reproduction and the differential above. No database run inserted a multi-line DOI: the deduplication semantics of `safe_bulk_insert_papers` above come from its migration source. No external reader was run on a wrapped link.

### Limitations not changed here

- **JabRef** splits a record at `ER  -` anywhere, even inside a one-line value such as a title "WATER  - a study", on `main` as with the fix. PaperLume does not alter text to avoid it.
- **Other readers join a continuation line in their own way.**
  - Zotero keeps line breaks in an abstract or note by its heuristic and joins other fields with a space.
  - rispy joins a single field with a space and makes a continued `N1` a second note.
  - JabRef keeps the six spaces between the joined lines.
  - Zotero would split a continued `L1` into two links. A stored attachment link with a line break is not a usable link in any case, and PaperLume reads it back as its first line.
- **A DOI that holds a line break** is not a DOI name. PaperLume reads it back with its line break when its first line is a DOI name, and as its first line otherwise, but another reader that joins its lines sees a different value. For this revision it was decided to keep that behaviour. Leaving such a value out of `DO`, or moving it to a PaperLume-specific field with a notice as BibTeX does, would be a separate decision.
- **A link, an attachment link or a year wrapped over two lines** by another program is read as its first line. PaperLume does not put a URL together from physical lines; that would need its own interoperability contract.
- **A tab inside a tag line's URL** is still removed by the URL parser, so `…/12`, a tab, then `3/` is the record 123, as on `main`. Only continuation lines are kept out of links.
- **A note that continues.** `N1  - Study type:` continued by the type now gives that type as the study type, which feeds the study-type evaluation, where `main` read `Study type:`. Notes are text fields, read whole.
- **U+2028, U+2029 and U+0085** are written unchanged. A program that ends lines at them, such as Python's `str.splitlines`, sees a line break there. Zotero replaces U+2028 and U+2029 with a space.
- **A third-party file is read with its own line breaks.** An abstract that another program wrapped at 70 or 80 characters keeps those line breaks, and the abstract view shows them. An unindented line in such a file that is a real tag line, such as `ER  - was not reached`, still ends its field or record; no reader can tell it from a tag.
- **Files exported before this change** with a multi-line value but no tag-like line are now read whole. A file whose value already ended its record cannot be repaired and reads as it did.
- **Unchanged parser behaviour, kept as accepted limitations.** A `TY` before `ER` still drops the unfinished record; tag lines with one space before the hyphen are still ignored; a file whose only line ending is CR is still not read; an unindented tag-like line in prose still begins a field. None of these is claimed repaired.

### What remains

Each item is separate work, and none of it is part of this change:

- **CodeQL groups Q2–Q4**; see the [CodeQL triage outcome](#codeql-triage-outcome-2026-11-23).
- **The search cache after an import** (`PAPERLUME-POST-IMPORT-SEARCH-CACHE-001`); see [Browser qualification](#browser-qualification).
- **CSV byte order mark** interoperability; see the [CSV residual findings](#residual-findings).
- **E2E spec coverage** (`PAPERLUME-CI-E2E-SPEC-COVERAGE-AUDIT-001`). No lane exports or imports RIS, BibTeX or CSV files.
- **External reference-manager qualification** of RIS and BibTeX exports.
- **Recovery of a record without `ER`** before the next `TY`, kept as a limitation for this change.
- **Links wrapped over physical lines**, which would need an explicitly defined interoperability contract.
- **Superseded Dependabot pull requests.** PRs 351–354 are still open.

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

On `main` `94ef1b2c` (2026-11-23) both `npm audit` and `npm audit --omit=dev` exited **nonzero**, for the `zod` finding alone (see [open findings](#open-findings-2026-11-23)). On `main` `cec11199` (2026-11-24), with the [Zod 4 migration](#zod-4-migration) merged, both exit **zero**. Compare any entry with that list; anything not on it is new and needs investigating. `npm audit` reads only GitHub's Advisory Database. It cannot report an advisory that a package's own repository has published before GitHub lists it, as happened with the Vite RCE. *(Both commands exited zero as measured on 2026-09-20. Before that measurement, the full audit was expected to exit nonzero because of the Vitest residual.)*

## Re-evaluation triggers

Revisit this document when any of the following occurs. By 2026-11-23 the first trigger, the Vitest trigger, the React Router trigger and the Router-usage trigger had all fired. The Vite remediation and the [React Router](#react-router-patch-set--7186), [CSS and build-toolchain](#css-and-build-toolchain-patch-set) and [test and lint toolchain](#test-and-lint-toolchain-patch-set) patch sets have all merged. The last [open finding](#open-findings-2026-11-23), `zod`, was remediated by the [Zod 4 migration](#zod-4-migration), merged on 2026-11-24 as `cec11199`. As measured that day, no finding is open in either graph.

- **any** advisory appears in **either** graph. This is the primary trigger, and a new high or critical fires it urgently. (Before 2026-09-20 this trigger excluded the known Vitest residual; with that remediated, there is no excluded finding.)
- the installed Vitest line falls out of support again, or a new advisory is published against the 4.x line. The 2026-09-20 upgrade moved `vitest` and `@vitest/mocker` off the affected versions onto patched 4.1.11 (both packages are still installed), so the former applicability caveats no longer gate anything. Adopting browser mode or `@vitest/browser`, `mockerPlugin`/`interceptorPlugin`, a Vitest UI/API server or a `host` on the Vitest config would still widen the runner's exposure surface, and is worth a re-measure on its own;
- a **new React Router advisory** is published, particularly one whose affected range reaches the installed version, **7.18.6** since the [React Router patch set](#react-router-patch-set--7186). That would move the floor again and require re-measuring the v7 line (and re-examining whether v8, still out of scope today, has become necessary);
- Paperlume's Router usage changes in a way that alters the exposure profile — a navigation target stops being a hardcoded literal, `<Link>`/`<NavLink>` starts being rendered, a data router is adopted, or SSR/hydration is introduced;
- a dependency upgrade requires application source changes, a workflow change, or a `package.json` change;
- a change adds `@tailwindcss/typography` back. Every release through 0.5.20 exact-pins `postcss-selector-parser` 6.0.10, which is inside GHSA-rj75-hqrm-r3gf and GHSA-67xj-gfww-g738 (see [Removing `@tailwindcss/typography`](#removing-tailwindcsstypography));
- any baseline version in [Current resolved security baseline](#current-resolved-security-baseline) regresses;
- a Zod schema starts parsing an array that comes from outside the bundle without a `.max()` bound, or `zod` resolves below 4.6.6 again. Zod's size checks protect only bounded schemas (see [Zod 4 migration](#zod-4-migration));
- the toolchain moves to a new major (Vite, Vitest, or Node engine), which can re-open transitive ranges;
- a package's own repository publishes an advisory that covers an installed version before GitHub's Advisory Database lists it.

## Deployment note

Dependency changes ship like any other frontend change: merging to `main` triggers the automatic Vercel Production deployment. They involve **no** Supabase deployment step — Supabase migrations and Edge Functions are deployed separately and manually per [deployment.md](deployment.md), and none of the five clusters touched them.
