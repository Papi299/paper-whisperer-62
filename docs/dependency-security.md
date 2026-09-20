# Dependency Security

> **Status: active.** This is the authoritative current-state document for npm dependency security: what `npm audit` reports **now**, which bounded remediation work is complete, what remains deferred, and the policy future remediation follows. Historical implementation evidence (advisory tables, dependency paths, CI logs, merge topology) is **not** duplicated here — it lives in Git history, the merged PRs, and `package-lock.json`.

## Purpose and authority

- This document owns the **current dependency-security posture** and the **remediation policy**. When an audit result or a remediation boundary changes, fix this file.
- It is **not** a chronology. Per-cluster implementation detail belongs to the merged PRs listed below.
- Supabase/Postgres security (RLS, RPC grants, Auth advisors) is a separate concern owned by [decisions-and-triggers.md](decisions-and-triggers.md) and [pfa-c03-staging-and-security-test-plan.md](pfa-c03-staging-and-security-test-plan.md). Dependency remediation has never changed schema, RLS, migrations, or Supabase Production.

## Current audit state

`npm audit` measured **2026-09-20**, on a clean `npm ci` that did not mutate `package-lock.json`, against `main` `07c68c0b73362789e6b2e6b3b4a8e782dbde1be7` plus the [Vitest 4 upgrade](#vitest-residual--remediated-by-a-major-upgrade) lockfile (`package-lock.json` SHA-256 `90bd52938ba1a0edaed858fbd56cf65a6d3d96445ef5730209cacdb9d92fb142`):

| Graph | Total | Low | Moderate | High | Critical |
|---|---|---|---|---|---|
| Full (incl. dev) | **0** | 0 | 0 | 0 | 0 |
| Production only | **0** | 0 | 0 | 0 | 0 |

**Both graphs are at zero as measured on 2026-09-20.** The last outstanding finding, the dev-only [GHSA-82fw-gwwq-j7x9](#vitest-residual--remediated-by-a-major-upgrade), was cleared by upgrading `vitest` from the unmaintained 3.x line to **4.1.11**. No finding of any severity is outstanding.

**How the graphs got here.** After [Cluster 5](#react-router-cluster-5--complete) both graphs measured zero, and that was true at the time. Advisories published or revised between 2026-09-01 and 2026-09-08 then reopened them with no change to this repository: on `main` `20b57562` the full graph measured **6 (2 high / 3 moderate / 1 low)** and the production graph **1 low**. Advisory remediation 002 cleared every finding that had a compatible in-range fix and took the full graph to **2 moderate**, leaving only the Vitest family; the 2026-09-20 Vitest major upgrade then took it to **0**.

A count is a measurement, not a standing property: advisory databases move, and a newly published advisory can reopen either graph without any change to this repository. Re-run the [verification commands](#verification-commands) rather than trusting this table.

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

Across Clusters 1–3 the audit moved from **16 findings (1 critical / 9 high / 4 moderate / 2 low)** to **3 moderate**. Cluster 4 took it to **2 moderate**, and Cluster 5 took it to **zero**. The later `nanoid` advisory was outside all five clusters and was remediated separately as a standalone bounded dependency-advisory task. So were the September 2026 advisories: [Advisory remediation 002](#advisory-remediation-002--remediated) took the full graph from **6** to **2 moderate** and the production graph from **1 low** to **zero**, with a `package-lock.json`-only dependency delta.

## Current resolved security baseline

These resolutions must not regress. A change that moves any of them backwards reintroduces a closed advisory.

| Cluster | Packages |
|---|---|
| 1 | `vite` 7.3.6 · `vitest` 3.2.7 — **superseded by 4.1.11** ([Vitest 4 upgrade](#vitest-residual--remediated-by-a-major-upgrade)) · `postcss` 8.5.26 |
| 2 | `lodash` 4.18.1 · `ws` 8.21.3 · `yaml` 2.9.0 · `picomatch` 4.0.5 (nested v2 line 2.3.2) · `brace-expansion` 1.1.18 (nested v2 line 2.1.4) |
| 3 | `js-yaml` 4.3.1 — **superseded by 4.3.2** (remediation 002) · `flatted` 3.4.4 · `form-data` 4.0.6 · `@tootallnate/once` 2.0.1 · `esbuild` 0.28.1 |
| 5 | `react-router` **7.18.2** (declared `^7.18.2`) · `cookie` 1.1.1 · `set-cookie-parser` 2.7.2 |
| Remediation 002 | `browserslist` **4.29.0** · `js-yaml` **4.3.2** · `@humanfs/node` **0.16.8** · `postcss-selector-parser` **6.1.4** (hoisted line; the nested exact-pinned 6.0.10 is outside the affected range) |
| Vitest 4 upgrade | `vitest` **4.1.11** (declared `^4.1.11`) · `@vitest/mocker` **4.1.11** · the `@vitest/*` 4.1.11 siblings · `chai` **6.2.2** |

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

**Status: REMEDIATED** (`VITEST-SECURITY-MAJOR-UPGRADE-001`, 2026-09-20). The advisory is absent from **both** the full and the production audit graph, and the vulnerable package is **no longer installed**: `vitest` and `@vitest/mocker` both resolve to **4.1.11**, outside the affected range. It was dev/test scope throughout and never appeared in the production graph.

**Why it needed a major.** Upstream states that the 2.1.x and 3.x lines "are not maintained and are not planned to receive the fix", so no in-range 3.x remediation existed. **4.1.11** was chosen over the 5.x line because it is the first patched *stable* release and the smallest security-sufficient transition — one major boundary instead of two. (At the time of the upgrade the advisory's 5.x patched version was `5.0.0-rc.2`, a release candidate.) `^3.2.4` → `^4.1.11` is the only `package.json` change.

| Field | Value |
|---|---|
| Advisory | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) (CVE-2026-84373) — "Vitest: Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock" (CWE-22) |
| Severity | Moderate (CVSS 3.1 5.9, `AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N`) |
| Affected | `vitest` and `@vitest/mocker` `>=2.1.0 <4.1.11`, plus the 5.0.0 pre-releases before `5.0.0-rc.2` |
| Patched | **4.1.11** (v4 line) and **5.0.0**. Upstream states that older majors (2.1.x, 3.x) "are not maintained and are not planned to receive the fix" |
| Installed **now** | `vitest` **4.1.11** (root `devDependencies`, declared `^4.1.11`; 4.1.11 is the `V4` dist-tag) · `@vitest/mocker` **4.1.11** — **both outside the affected range** |
| Installed **before** (historical) | `vitest` **3.2.7** (declared `^3.2.4`; 3.2.7 was the newest 3.x) · `@vitest/mocker` **3.2.7** (exact-pinned by `vitest`) |
| Audit representation **before** | Two moderate entries: `@vitest/mocker`, and `vitest` through it. `npm audit fix --force` proposed `vitest@5.0.1`, a breaking move across two majors, and was not used |

### Applicability — what was and was not established (2026-09-17, historical)

> **Historical.** The analysis below describes the **3.2.7** install that is no longer present. It is retained because it records how the exposure was bounded while the residual was open, and because its method is the template for a future residual. It is **not** the reason the advisory is now absent — that reason is simply that the vulnerable package is no longer installed. Every statement in this subsection is in the past tense of the 3.x install.

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

**Both** `npm audit` and `npm audit --omit=dev` currently exit zero, as measured on 2026-09-20. A **nonzero** exit from either now means a new advisory has appeared — there is no longer an expected residual to discount. Investigate any entry rather than treating a nonzero exit as normal. *(Historically the full audit was expected to exit nonzero because of the Vitest residual; that stopped being true when `vitest` moved to 4.1.11.)*

## Re-evaluation triggers

Revisit this document when any of the following occurs:

- **any** advisory appears in **either** graph. This is the primary trigger, and a new high or critical fires it urgently. (Before 2026-09-20 this trigger excluded the known Vitest residual; with that remediated, there is no excluded finding.)
- the installed Vitest line falls out of support again, or a new advisory is published against the 4.x line. The 2026-09-20 upgrade removed the vulnerable package, so the former applicability caveats no longer gate anything — but adopting browser mode or `@vitest/browser`, `mockerPlugin`/`interceptorPlugin`, a Vitest UI/API server or a `host` on the Vitest config would still widen the runner's exposure surface and is worth a re-measure on its own;
- a **new React Router advisory** is published, particularly one whose affected range reaches **7.18.2** — that would move the floor again and require re-measuring the v7 line (and re-examining whether v8, still out of scope today, has become necessary);
- Paperlume's Router usage changes in a way that alters the exposure profile — a navigation target stops being a hardcoded literal, `<Link>`/`<NavLink>` starts being rendered, a data router is adopted, or SSR/hydration is introduced;
- a dependency upgrade requires application source changes, a workflow change, or a `package.json` change;
- any baseline version in [Current resolved security baseline](#current-resolved-security-baseline) regresses;
- the toolchain moves to a new major (Vite, Vitest, or Node engine), which can re-open transitive ranges.

## Deployment note

Dependency changes ship like any other frontend change: merging to `main` triggers the automatic Vercel Production deployment. They involve **no** Supabase deployment step — Supabase migrations and Edge Functions are deployed separately and manually per [deployment.md](deployment.md), and none of the five clusters touched them.
