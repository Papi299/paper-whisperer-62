// @ts-nocheck
/**
 * Fail-closed lifecycle for local Supabase Playwright E2E.
 *
 * Subcommands:
 *   run            Start local stack → reset+replay migrations → seed →
 *                  run a Playwright subset against the isolated local backend →
 *                  remove auth state → stop the stack (finally).
 *   verify-guards  Run the pure guard unit tests and the bounded Layer 1
 *                  negative control (a Production/remote target must fail
 *                  during Playwright config, before Vite starts and before any
 *                  credential is entered), plus a static Layer 2 ordering check.
 *   db-tests       Start local stack → reset+replay migrations → capture a
 *                  pgTAP + expanded catalog baseline → run a transaction-only
 *                  catalog-fingerprint sensitivity probe (prove same-name
 *                  definition changes are detected, then that it rolled back) →
 *                  run an expected-failure negative control (inject a
 *                  transaction-only papers-RLS regression the detector must
 *                  catch, then prove it rolled back) → run every pgTAP suite
 *                  under supabase/tests/database (isolated, extension state
 *                  restored) → run the framework-free 18-case verification →
 *                  prove true concurrent AI-quota consumption at the cap, the
 *                  author-identity merge-cycle refusal, and the attachment
 *                  upload-finalization linearization, each with bounded,
 *                  fail-closed coordinator/worker processes whose deadlines all
 *                  start at barrier release → verify no
 *                  row/catalog residue → stop the stack and delete its volumes →
 *                  authoritatively inspect that no current-project container
 *                  remains. Cleanup is MANDATORY and never honors
 *                  E2E_KEEP_LOCAL_STACK; the post-teardown inspection is
 *                  fail-closed and scoped to this project's ref.
 *   stop           Stop and delete the local stack's ephemeral state.
 *
 * The `run` default is ephemeral: its stack is always stopped and its volumes
 * deleted unless E2E_KEEP_LOCAL_STACK=1 is set (a local debugging escape hatch).
 * `db-tests` ignores that escape hatch entirely — it always tears down.
 *
 * Safety:
 *   - Only ever targets a validated loopback Supabase API URL.
 *   - Never prints keys, passwords, tokens, JWTs, or the raw `supabase status`
 *     output (which contains keys). Credentials are passed to Playwright in
 *     memory only — never written to a dotenv file.
 *   - Invokes the local Playwright/Vitest binaries via `npx --no-install` so no
 *     package is fetched from the network.
 *
 * Plain Node ESM (no compile step). Depends only on Node built-ins and the
 * already-installed dev tooling.
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { seedLocalStack } from "./e2e-local-seed.mjs";
import {
  assertDisposableAccountRemoved,
  cleanupDisposableAccount,
  provisionDisposableAccount,
} from "./e2e-local-delete-fixture.mjs";
import {
  assertModelAccountResetAndRemove,
  provisionEntitledModelAccount,
  removeModelAccount,
} from "./e2e-local-model-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PRODUCTION_SUPABASE_REF = "lioxtgiputfniqbktcsz";
const AUTH_STATE_FILE = resolve(ROOT, "e2e/.auth/user.json");

/**
 * The authorized SAFE spec set — the default subset for `run`. Most entries are
 * read-only; the ones that write are annotated below and each removes its own
 * fixtures again, so none of them leaves the deterministic seed altered. The
 * account-deletion spec at the end of the list is the one deliberately
 * destructive entry, and it owns a disposable per-run account rather than a
 * deterministic fixture.
 */
const DEFAULT_SPECS = [
  // AI-PROJECT-TAG-SUGGESTIONS-001B Edit Paper acceptance flows. Mutating, but
  // only within fixtures it owns: two disposable Projects and two disposable
  // Tags, all deleted in afterAll — which cascades the `paper_projects` /
  // `paper_tags` rows away, restoring the one seeded paper it assigns to. The
  // only paper field it edits is Study Type, reverted to its seeded empty value
  // before the save, so it is order-independent. The
  // `suggest-paper-organization` request is fulfilled by Playwright with
  // deterministic contract data: no Edge Function is served, no Gemini request
  // is made, and no AI quota is spent.
  "e2e/ai-organization-suggestions.spec.ts",
  "e2e/auth.spec.ts",
  // CHROME-EXTENSION-IMPORT-001C1 handoff-route coverage. Mutating, but only
  // within fixtures it owns: three synthetic papers (nine-digit PMIDs and a
  // reserved 10.5555 DOI, so none can collide with the seed), two disposable
  // Projects and one disposable Tag, all removed again — papers first, so the
  // junction rows cascade away before the taxonomy deletes. Order-independent:
  // the sweep tolerates finding nothing and runs before creating anything.
  // The `fetch-paper-metadata` request is fulfilled by Playwright, so no Edge
  // Function is served and no PubMed/Crossref egress occurs.
  "e2e/extension-import.spec.ts",
  // Reads the product name on the unauthenticated Auth card, the authenticated
  // sidebar, and the document title; mutates nothing.
  "e2e/branding.spec.ts",
  // PAPERLUME-PRIVACY-001B public-route coverage. Strictly read-only: it never
  // signs in, never reaches Supabase at all in its signed-out cases, and writes
  // nothing. Most of its tests build their own session-free context, so they do
  // not consume or disturb the seeded primary fixture.
  "e2e/privacy-policy.spec.ts",
  // PFA-C09 responsive/accessibility regression coverage. Read-only: resizes
  // the viewport, opens and closes dialogs, sorts, resizes a column and scrolls
  // the table. It never activates the badge "exclude" action (the one real
  // mutation on that surface) and writes nothing to the database.
  "e2e/responsive-accessibility.spec.ts",
  // MOBILE-DASHBOARD-DENSITY-001 mobile information-density coverage. Read-only:
  // measures layout geometry, opens and closes the Filters / More / Analytics
  // sheets, and sets a year filter that is cleared again in the same test. It
  // never exports, never merges duplicates and writes nothing to the database.
  "e2e/mobile-dashboard-density.spec.ts",
  // ADD-PAPERS-MOBILE-SELECTORS-001 mobile selector focus/scroll coverage.
  // Creates two disposable projects and one disposable tag through the real
  // management modals — the seed ships none, and the Add Papers assign section
  // does not render without them — and deletes all three again in afterAll.
  // Beyond that it is read-only: filter and analytics-target selections are
  // in-memory, no import is ever run, and nothing else is written.
  "e2e/mobile-selectors.spec.ts",
  // REAL-DEVICE-TOUCH-UX-REMEDIATION-001 touch/tablet focus, hit-target and
  // analytics-overflow coverage. Creates the same kind of disposable fixtures
  // as the spec above — two projects, one tag — plus one disposable saved
  // search, and deletes all of them again in afterAll. Beyond that it is
  // read-only: it measures geometry, opens and closes dialogs and popovers,
  // and toggles in-memory filter/assignment selections. No import is ever run.
  "e2e/touch-tablet-ux.spec.ts",
  "e2e/bulk-actions.spec.ts",
  "e2e/eager-load.spec.ts",
  "e2e/filters.spec.ts",
  "e2e/paper-import.spec.ts",
  // D4 external-metadata import-order regression. Imports three disposable
  // local papers through the real Add Papers UI and the real bulk-insert RPC,
  // then deletes them again before the test ends, restoring the seeded count.
  // Metadata comes from a deterministic stand-in fulfilled at the
  // `fetch-paper-metadata` HTTP boundary — no live PubMed/Crossref egress, and
  // no served local Edge Function is required.
  "e2e/import-order.spec.ts",
  "e2e/pools.spec.ts",
  // Opens Settings and reads the storage gauge; mutates nothing.
  "e2e/settings-storage.spec.ts",
  // Opens Settings and downloads the account export; reads only, mutates nothing.
  "e2e/account-export.spec.ts",
  // AUTHOR-IDENTITY-RESOLUTION-001C acceptance flows. Mutating, but only within
  // the identity tables it also cleans up: each test resets every identity,
  // link, alias and merge edge before it runs and the suite resets again at the
  // end, so it is order-independent. The one paper it edits (identity fixture E)
  // exists for that purpose alone and is restored before the test finishes.
  // No import, no live ORCID lookup, no Edge Function.
  "e2e/author-identity.spec.ts",
  // PUBMED-IN-APP-SEARCH-001 in-app PubMed discovery. Mutating, but only within
  // fixtures it owns: it imports papers whose titles all start with "PMS-E2E"
  // through the real Add Papers UI and the real bulk-insert RPC, and it removes
  // every one of them in afterEach — plus one disposable project and tag created
  // and deleted inside the single test that assigns. It is therefore
  // order-independent and restores the deterministic seed within its own run.
  // Both external boundaries are deterministic: Playwright fulfils the
  // `search-pubmed` and `fetch-paper-metadata` requests, so there is no live
  // NCBI egress and no served local Edge Function is required.
  "e2e/pubmed-search.spec.ts",
  // SCROLLAREA-HORIZONTAL-REACHABILITY-AUDIT-001 geometry regressions. Mutating
  // only in that each test adds one long fixture keyword to the keyword pool
  // through the real modal and removes it again in afterEach, so it restores the
  // seed within its own run and is order-independent. No papers, projects or
  // tags are touched; no import and no Edge Function.
  "e2e/scrollarea-reachability.spec.ts",
  // AI-MODEL-SELECTION-001C Settings model-selection coverage. Mutating, but
  // only within a disposable per-run account it owns outright: the entitled
  // cases save and then clear a real `user_ai_preferences` row for that account
  // alone, and the lifecycle proves afterwards that the row is gone. The
  // deterministic primary fixture is used read-only, for the NON-entitled case,
  // and never acquires a preference. No Edge Function is served and no provider
  // request is made — this spec tests preference persistence and UI only.
  "e2e/ai-model-settings.spec.ts",
  // DESTRUCTIVE — always last. Deletes a disposable per-run account (never the
  // deterministic primary/secondary fixtures) through the real UI and the real
  // local delete-account Edge Function. The lifecycle proves afterwards that the
  // Auth user, its rows and its Storage objects are gone.
  "e2e/account-deletion.spec.ts",
];

function log(msg) {
  process.stdout.write(`[e2e-local] ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[e2e-local] ERROR: ${msg}\n`);
}

/** Spawn a command with inherited stdio; resolves with the exit code. */
function runInherit(cmd, args, env = process.env) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: "inherit" });
    child.on("close", (code) => resolvePromise(code ?? 1));
    child.on("error", () => resolvePromise(1));
  });
}

/** Spawn a command capturing stdout/stderr; resolves with {code,out,err}. */
function runCapture(cmd, args, env = process.env) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: ROOT, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, out, err }));
    child.on("error", (e) => resolvePromise({ code: 1, out, err: err + String(e) }));
  });
}

function assertRepoRoot() {
  const pkgPath = resolve(ROOT, "package.json");
  if (!existsSync(pkgPath)) throw new Error("package.json not found at repo root.");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  if (pkg.name !== "paper-whisperer") {
    throw new Error(`Unexpected package: ${pkg.name}. Refusing to run outside the repo root.`);
  }
  for (const rel of ["supabase/config.toml", "playwright.config.ts"]) {
    if (!existsSync(resolve(ROOT, rel))) throw new Error(`Missing ${rel}; not the repo root.`);
  }
}

async function assertToolingAvailable() {
  const docker = await runCapture("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (docker.code !== 0) throw new Error("Docker is not available / not running.");
  const cli = await runCapture("supabase", ["--version"]);
  if (cli.code !== 0) throw new Error("Supabase CLI is not available.");
  log(`docker server ${docker.out.trim()} · supabase CLI ${cli.out.trim()}`);
}

/** Confirm version-sensitive flags exist before relying on them. */
async function assertSupportedFlags() {
  const reset = await runCapture("supabase", ["db", "reset", "--help"]);
  if (reset.code !== 0 || !/--local\b/.test(reset.out) || !/--no-seed\b/.test(reset.out)) {
    throw new Error("`supabase db reset` does not support the required --local/--no-seed flags.");
  }
  const stop = await runCapture("supabase", ["stop", "--help"]);
  if (stop.code !== 0 || !/--no-backup\b/.test(stop.out)) {
    throw new Error("`supabase stop` does not support the required --no-backup flag.");
  }
  const status = await runCapture("supabase", ["status", "--help"]);
  if (status.code !== 0 || !/-o\b|--output\b/.test(status.out)) {
    throw new Error("`supabase status` does not support structured (-o json) output.");
  }
}

function isLoopbackHost(host) {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
    h === "[::1]" ||
    h === "::1"
  );
}

/** Validate a candidate local API URL before any privileged client is built. */
function assertLocalApiUrl(apiUrl) {
  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error("Local status returned an unparseable API URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Local API URL must be http(s), got ${url.protocol}.`);
  }
  if (url.href.toLowerCase().includes(PRODUCTION_SUPABASE_REF)) {
    throw new Error("Local API URL contains the Production project ref; refusing.");
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(`Local API URL host "${url.hostname}" is not loopback; refusing.`);
  }
  return url;
}

/** Case-insensitively pick the first present key from a parsed status object. */
function pick(obj, names) {
  for (const key of Object.keys(obj)) {
    for (const name of names) {
      if (key.toLowerCase() === name.toLowerCase()) return obj[key];
    }
  }
  return undefined;
}

/** Read structured local status; never logs the raw output (contains keys). */
async function readLocalStatus() {
  const res = await runCapture("supabase", ["status", "-o", "json"]);
  if (res.code !== 0) {
    throw new Error("`supabase status -o json` failed; is the local stack running?");
  }
  let parsed;
  try {
    parsed = JSON.parse(res.out);
  } catch {
    throw new Error("Could not parse `supabase status -o json` output.");
  }
  const apiUrl = pick(parsed, ["API_URL", "api_url"]);
  const anonKey = pick(parsed, ["ANON_KEY", "anon_key", "PUBLISHABLE_KEY", "publishable_key"]);
  const serviceRoleKey = pick(parsed, [
    "SERVICE_ROLE_KEY",
    "service_role_key",
    "SECRET_KEY",
    "secret_key",
  ]);
  if (!apiUrl || !anonKey || !serviceRoleKey) {
    throw new Error("Local status is missing API_URL / ANON_KEY / SERVICE_ROLE_KEY.");
  }
  const url = assertLocalApiUrl(apiUrl);
  return { apiUrl: url.origin, anonKey, serviceRoleKey };
}

async function startStack() {
  log("starting local Supabase stack…");
  // `supabase start` prints a key-bearing status banner (anon / service-role /
  // JWT / database / S3 secrets) to stdout/stderr. CAPTURE and DISCARD that
  // output so no credential ever reaches the terminal, a CI log, a file, or a
  // thrown error — only the numeric exit status is used. The captured buffers
  // are intentionally never logged nor included in the failure message.
  const { code } = await runCapture("supabase", ["start"]);
  if (code !== 0) {
    throw new Error(
      `\`supabase start\` failed with exit ${code}. Raw CLI output was ` +
        `suppressed because it may contain local credentials.`,
    );
  }
  log("local Supabase stack started.");
}

async function resetLocalDb() {
  log("resetting local database and replaying tracked migrations…");
  const code = await runInherit("supabase", ["db", "reset", "--local", "--no-seed"]);
  if (code !== 0) throw new Error("`supabase db reset --local` failed (migration replay).");
}

/**
 * Stop and delete the local stack. Authoritative: a nonzero `supabase stop` is
 * NOT swallowed — it throws so the caller fails the lifecycle. `allowKeep` (used
 * only by the automatic run teardown) honors the E2E_KEEP_LOCAL_STACK debug
 * escape hatch; the explicit `stop` command passes allowKeep=false so the debug
 * variable can never disable it.
 */
async function stopStack({ allowKeep = false } = {}) {
  if (allowKeep && process.env.E2E_KEEP_LOCAL_STACK === "1") {
    log("E2E_KEEP_LOCAL_STACK=1 — leaving the local stack running (debug mode).");
    return;
  }
  log("stopping local stack and deleting ephemeral volumes…");
  const code = await runInherit("supabase", ["stop", "--no-backup"]);
  if (code !== 0) {
    throw new Error(`\`supabase stop --no-backup\` failed with exit ${code}.`);
  }
}

function removeAuthState() {
  try {
    rmSync(AUTH_STATE_FILE, { force: true });
    log("removed generated Playwright auth state.");
  } catch {
    /* best-effort */
  }
}

// ── Idempotent lifecycle teardown shared by finally + SIGINT + SIGTERM ──
let cleanupPromise = null;
let signalHandlersInstalled = false;

/**
 * Run the lifecycle teardown at most once. `finally`, SIGINT, and SIGTERM all
 * await the SAME promise, so destructive teardown can never run twice or
 * concurrently. Rejects if the underlying stop fails; callers decide the exit
 * code. Never logs a key, password, token, or raw status output.
 */
function cleanupLifecycleOnce() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      removeAuthState();
      await stopStack({ allowKeep: true });
    })();
  }
  return cleanupPromise;
}

// Mandatory db-tests teardown. Unlike the run lifecycle it NEVER honors
// E2E_KEEP_LOCAL_STACK — the stack and its volumes are always deleted. Shared by
// finally + SIGINT + SIGTERM via a single promise so it runs at most once.
let dbCleanupPromise = null;
function cleanupDbTestsOnce() {
  if (!dbCleanupPromise) {
    dbCleanupPromise = (async () => {
      await stopStack({ allowKeep: false });
    })();
  }
  return dbCleanupPromise;
}

/**
 * Install bounded SIGINT/SIGTERM handlers for a lifecycle that may own a local
 * stack. On a signal we attempt cleanup exactly once (the shared promise) and
 * exit with the conventional signal-derived status — 130 (SIGINT) / 143
 * (SIGTERM) — staying nonzero even if cleanup itself fails. Installed only by
 * `run`; never by verify-guards or the explicit stop.
 */
function installSignalCleanup(cleanupFn = cleanupLifecycleOnce) {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const onSignal = (signal, code) => {
    process.once(signal, () => {
      log(`received ${signal} — attempting one-time local-stack cleanup…`);
      cleanupFn()
        .then(() => process.exit(code))
        .catch((err) => {
          fail(`cleanup after ${signal} failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(code);
        });
    });
  };
  onSignal("SIGINT", 130);
  onSignal("SIGTERM", 143);
}

async function cmdRun(specArgs) {
  assertRepoRoot();
  await assertToolingAvailable();
  await assertSupportedFlags();
  installSignalCleanup();

  const specs = specArgs.length > 0 ? specArgs : DEFAULT_SPECS;
  let primaryError = null;
  // Set once the disposable PFA-C04 account exists; cleared once it is proven
  // deleted, so the failure path only ever cleans up an account that survived.
  let disposable = null;
  // Set once the disposable ENTITLED model account exists; cleared once its
  // final state is proven and it is removed.
  let modelAccount = null;
  try {
    await startStack();
    await resetLocalDb();

    const { apiUrl, anonKey, serviceRoleKey } = await readLocalStatus();
    log(`validated local API origin: ${apiUrl}`);

    const creds = await seedLocalStack({ apiUrl, anonKey, serviceRoleKey, log });

    // PFA-C04 destructive fixture: a disposable account this run owns outright.
    // Provisioned only when the destructive spec is actually scheduled, so a
    // targeted read-only spec run creates no extra identity. The elevated key
    // stays in THIS process and is never added to the Playwright environment.
    const runsDeletionSpec = specs.some((spec) => spec.includes("account-deletion"));
    disposable = runsDeletionSpec
      ? await provisionDisposableAccount({ apiUrl, anonKey, serviceRoleKey, log })
      : null;

    // AI-MODEL-SELECTION-001C entitled fixture. The seeded users are Free with
    // the capability flag false — exactly what the spec's non-entitled cases
    // need — so entitlement is granted to a SEPARATE disposable account through
    // a server-side entitlement write, never by changing the seed. Provisioned
    // only when the model spec is actually scheduled.
    const runsModelSpec = specs.some((spec) => spec.includes("ai-model-settings"));
    modelAccount = runsModelSpec
      ? await provisionEntitledModelAccount({ apiUrl, anonKey, serviceRoleKey, log })
      : null;

    // Explicit, in-memory backend contract for the guarded Playwright run.
    const childEnv = {
      ...process.env,
      E2E_BACKEND_MODE: "local",
      E2E_EXPECTED_SUPABASE_URL: apiUrl,
      VITE_SUPABASE_URL: apiUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
      TEST_USER_EMAIL: creds.primary.email,
      TEST_USER_PASSWORD: creds.primary.password,
      ...(disposable
        ? {
            E2E_DELETE_USER_EMAIL: disposable.email,
            E2E_DELETE_USER_PASSWORD: disposable.password,
          }
        : {}),
      ...(modelAccount
        ? {
            E2E_MODEL_USER_EMAIL: modelAccount.email,
            E2E_MODEL_USER_PASSWORD: modelAccount.password,
          }
        : {}),
    };

    log(`running Playwright specs: ${specs.join(", ")}`);
    const code = await runInherit("npx", ["--no-install", "playwright", "test", ...specs], childEnv);
    if (code !== 0) throw new Error(`Playwright run failed (exit ${code}).`);
    log("Playwright run succeeded against the isolated local backend.");

    // Authoritative destructive proof. The spec asserts what the browser can
    // see; this asserts what only an elevated local client can: the Auth user,
    // every owned row, and every Storage object in the account's namespace are
    // gone. A survivor fails the lifecycle even though Playwright was green.
    if (disposable) {
      await assertDisposableAccountRemoved({ apiUrl, serviceRoleKey, account: disposable, log });
      disposable = null; // proven gone; nothing left to clean up
      log("account-deletion E2E verified: disposable account fully removed.");
    }

    // The browser can only observe the rendered control, so the reset is
    // re-checked against the database here. Unlike the deletion proof above,
    // this is NOT an elevated read: `service_role` is revoked on
    // `user_ai_preferences` by 001A, so the fixture signs in as the disposable
    // account and reads its own row under the SELECT-own policy. The elevated
    // key is used only to delete the account afterwards.
    if (modelAccount) {
      await assertModelAccountResetAndRemove({
        apiUrl,
        anonKey,
        serviceRoleKey,
        account: modelAccount,
        log,
      });
      modelAccount = null; // proven reset and removed
      log("ai-model-settings E2E verified: preference cleared and fixture account removed.");
    }
  } catch (err) {
    primaryError = err;
    // A failed run may have left the disposable account behind. Remove it
    // best-effort so a debugging session with E2E_KEEP_LOCAL_STACK=1 does not
    // accumulate residue; the deterministic fixtures are never touched.
    if (disposable || modelAccount) {
      const target = await readLocalStatus().catch(() => null);
      if (target && disposable) {
        await cleanupDisposableAccount({
          apiUrl: target.apiUrl,
          serviceRoleKey: target.serviceRoleKey,
          account: disposable,
          log,
        });
      }
      if (target && modelAccount) {
        await removeModelAccount({
          apiUrl: target.apiUrl,
          serviceRoleKey: target.serviceRoleKey,
          account: modelAccount,
          log,
        });
      }
    }
  }

  // Authoritative teardown: a failed teardown fails the command. When the
  // lifecycle already failed, BOTH failures are preserved (the original
  // reset/seed/Playwright failure is never replaced by an opaque teardown-only
  // message). cleanupLifecycleOnce() shares its promise with the signal handlers
  // so it can neither run twice nor concurrently.
  let cleanupError = null;
  try {
    await cleanupLifecycleOnce();
  } catch (err) {
    cleanupError = err;
  }

  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Local E2E lifecycle failed AND teardown failed:",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

async function cmdStop() {
  assertRepoRoot();
  // Explicit stop always stops (allowKeep=false), so E2E_KEEP_LOCAL_STACK cannot
  // disable it. A nonzero `supabase stop` throws → the command exits nonzero.
  await stopStack({ allowKeep: false });
}

/**
 * verify-guards: pure guard tests + a bounded Layer 1 black-box negative
 * control + a static Layer 2 ordering check. No stack is started.
 */
async function cmdVerifyGuards() {
  assertRepoRoot();

  // 1. Pure guard unit tests.
  log("running pure guard unit tests…");
  const unit = await runInherit("npx", [
    "--no-install",
    "vitest",
    "run",
    "e2e/support/backend-guard.test.ts",
  ]);
  if (unit !== 0) throw new Error("Guard unit tests failed.");

  // 2. Layer 1 black-box negative control: local mode declared but a Production
  //    Vite URL + inert fake credentials. Playwright config must fail (nonzero)
  //    during configuration — before Vite starts and before any credential.
  const FAKE_KEY = "sb_publishable_FAKE_e2e_negative_control_key";
  const FAKE_PASSWORD = "FAKE_e2e_negative_control_password";
  log("running Layer 1 negative control (Production target must fail closed)…");
  const negEnv = {
    ...process.env,
    E2E_BACKEND_MODE: "local",
    E2E_EXPECTED_SUPABASE_URL: "http://127.0.0.1:54321",
    VITE_SUPABASE_URL: `https://${PRODUCTION_SUPABASE_REF}.supabase.co`,
    VITE_SUPABASE_PUBLISHABLE_KEY: FAKE_KEY,
    TEST_USER_EMAIL: "e2e-negative@paperlume.test",
    TEST_USER_PASSWORD: FAKE_PASSWORD,
  };
  const neg = await runCapture("npx", ["--no-install", "playwright", "test", "--list"], negEnv);
  const combined = `${neg.out}\n${neg.err}`;

  if (neg.code === 0) {
    throw new Error("Layer 1 negative control PASSED playwright config — guard did not fail closed!");
  }
  if (combined.includes(FAKE_KEY) || combined.includes(FAKE_PASSWORD)) {
    throw new Error("Layer 1 negative control leaked a fake key/password in output.");
  }
  if (!/BackendGuardError|E2E backend guard|Production project ref|not a loopback|mismatch/i.test(combined)) {
    throw new Error("Layer 1 negative control failed for an unexpected reason (no guard signal).");
  }
  // Prove Vite never started: no dev-server banner in the captured output.
  if (/Local:\s+http|VITE v\d|ready in \d+\s*ms/i.test(combined)) {
    throw new Error("Layer 1 negative control appears to have started Vite before failing.");
  }
  log(`Layer 1 negative control failed closed as expected (exit ${neg.code}); no secret leaked; Vite not started.`);

  // 3. Static Layer 2 ordering check: the browser guard must run before EVERY
  //    credential ACCESS and credential ENTRY in global-setup. It locates the
  //    first guard CALL site (not the import), both env credential reads, the
  //    credential fill, and the sign-in submission, and fails if the guard is
  //    not strictly before all of them — or if any position is missing (a
  //    missing credential-access match is treated as a failure, never success).
  log("checking Layer 2 ordering in e2e/global-setup.ts…");
  const setupSrc = readFileSync(resolve(ROOT, "e2e/global-setup.ts"), "utf-8");
  const positions = {
    "Layer 2 guard call": setupSrc.search(/assert(?:LocalSupabaseUrl|OriginsMatch)\s*\(/),
    "process.env.TEST_USER_EMAIL access": setupSrc.indexOf("process.env.TEST_USER_EMAIL"),
    "process.env.TEST_USER_PASSWORD access": setupSrc.indexOf("process.env.TEST_USER_PASSWORD"),
    "credential .fill()": setupSrc.search(/\.fill\(/),
    "sign-in submission": setupSrc.search(/getByRole\(\s*["']button["'],\s*\{\s*name:\s*\/sign in/i),
  };
  for (const [name, idx] of Object.entries(positions)) {
    if (idx === -1) {
      throw new Error(`Layer 2 ordering check could not locate ${name} in e2e/global-setup.ts.`);
    }
  }
  const guardIdx = positions["Layer 2 guard call"];
  for (const [name, idx] of Object.entries(positions)) {
    if (name === "Layer 2 guard call") continue;
    if (guardIdx > idx) {
      throw new Error(`Layer 2 guard runs AFTER ${name} in e2e/global-setup.ts.`);
    }
  }
  log("Layer 2 ordering OK: browser backend guard precedes both credential reads, the fill, and sign-in.");

  log("verify-guards: all controls passed.");
}

// ── db-tests: local pgTAP + framework-free + true-concurrency lifecycle ───────

const DB_TESTS_DIR = "supabase/tests/database";
const LEGACY_VERIFICATION = "supabase/tests/owner_access_and_quota_verification.sql";
// Deterministic, disposable local-only concurrency fixture.
const PROBE_USER = "cc000000-0000-0000-0000-0000000000cc";
const PROBE_CAP = 2; // monthly AI cap; counter is preloaded to cap-1.
const BARRIER_KEY = 918273645; // session advisory-lock key for the start barrier.

// AUTHOR-IDENTITY-RESOLUTION-001C merge-cycle race probe. Its own user, its own
// identities and its own barrier key so it cannot interact with the quota probe.
const MERGE_PROBE_USER = "cc000000-0000-0000-0000-0000000000cd";
const MERGE_ID_A = "cc000000-0000-0000-0000-0000000000e1";
const MERGE_ID_B = "cc000000-0000-0000-0000-0000000000e2";
const MERGE_BARRIER_KEY = 918273646;

// Bounded, fail-closed timeouts for the concurrency probe (Section I). Every
// coordinator/worker process must acquire, release, and terminate within these
// windows or the probe fails and the stack is still torn down.
const PROBE_COORD_ACQUIRE_MS = 15000; // coordinator must report the EXCLUSIVE lock.
const PROBE_BARRIER_MS = 30000;       // both workers must reach the shared barrier.
const PROBE_WORKER_MS = 30000;        // each worker must finish after release.
const PROBE_COORD_EXIT_MS = 15000;    // coordinator must exit after unlocking.
const PROBE_KILL_WAIT_MS = 10000;     // bounded wait for a killed child to die.

// Deterministic local-only fixtures for the expected-failure negative control.
const NC_USER_A = "a0000000-0000-0000-0000-0000000000fa";
const NC_USER_B = "b0000000-0000-0000-0000-0000000000fb";
const NC_PAPER = "d0000000-0000-0000-0000-0000000000fc";
const NC_MARKER = "C03B1_NEGATIVE_CONTROL_LEAK_DETECTED"; // exact detector marker.

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll an (optionally async) condition until true or timeout. */
async function waitUntil(cond, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await delay(150);
  }
  throw new Error(message);
}

/** The local project ref, read from supabase/config.toml. */
function readProjectId() {
  const cfg = readFileSync(resolve(ROOT, "supabase/config.toml"), "utf-8");
  const m = cfg.match(/^\s*project_id\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("Could not read project_id from supabase/config.toml.");
  return m[1];
}

/** Confirm the installed CLI's `supabase test db` supports --local and paths. */
async function assertDbTestFlags() {
  const help = await runCapture("supabase", ["test", "db", "--help"]);
  if (help.code !== 0 || !/--local\b/.test(help.out) || !/<path\.\.\.>|path\.\.\./.test(help.out)) {
    throw new Error("`supabase test db` does not support the required --local flag and test paths.");
  }
}

/**
 * Resolve and validate the local Postgres container. Uses the config project ref
 * to build the expected `supabase_db_<ref>` name and confirms it is a running,
 * local supabase container — never a remote/linked connection.
 */
async function resolveLocalDbContainer() {
  const name = `supabase_db_${readProjectId()}`;
  if (!name.startsWith("supabase_db_")) {
    throw new Error(`Refusing non-local database container name "${name}".`);
  }
  const ps = await runCapture("docker", ["ps", "--format", "{{.Names}}"]);
  if (ps.code !== 0) throw new Error("`docker ps` failed while resolving the local DB container.");
  const running = ps.out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!running.includes(name)) {
    throw new Error(`Local Postgres container "${name}" is not running.`);
  }
  return name;
}

/**
 * Run SQL inside the local Postgres container as the postgres superuser over the
 * container's local socket (no password, no connection URL — nothing credential-
 * bearing ever appears in output). Unaligned, tuples-only, ON_ERROR_STOP=1.
 */
function dockerPsql(container, sql) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      "docker",
      ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
       "-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t"],
      { cwd: ROOT },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, out, err }));
    child.on("error", (e) => resolvePromise({ code: 1, out, err: err + String(e) }));
    child.stdin.write(sql);
    child.stdin.end();
  });
}

/** A single scalar from the local DB (throws on error). */
async function dbScalar(container, sql) {
  const r = await dockerPsql(container, sql);
  if (r.code !== 0) throw new Error(`local query failed: ${r.err.trim() || "(no stderr)"}`);
  return r.out.trim();
}

/**
 * Spawn a long-lived psql session inside the local container, keeping the child
 * handle so callers can drive it, bound its lifetime, and require a clean exit.
 * Returns { child, done, readOut, readErr }. `done` resolves with
 * {code, signal, out, err}; stderr is captured but never printed. Used by the
 * concurrency probe so every coordinator/worker process is tracked and
 * fail-closed (Section I).
 */
function spawnDockerPsql(container) {
  const child = spawn(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
     "-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t"],
    { cwd: ROOT },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (err += d.toString()));
  const done = new Promise((resolvePromise) => {
    child.on("close", (code, signal) =>
      resolvePromise({ code: code ?? 1, signal: signal ?? null, out, err }));
    child.on("error", (e) =>
      resolvePromise({ code: 1, signal: null, out, err: err + String(e) }));
  });
  return { child, done, readOut: () => out, readErr: () => err };
}

/** Reject if `promise` does not settle within `ms` (bounded, fail-closed). */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not complete within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Force-terminate a psql child and await its exit within a bounded window. */
async function killPsql(handle) {
  if (!handle) return;
  try { handle.child.stdin.end(); } catch { /* noop */ }
  try { handle.child.kill("SIGKILL"); } catch { /* noop */ }
  try { await withTimeout(handle.done, PROBE_KILL_WAIT_MS, "child termination"); }
  catch { /* bounded; teardown still proceeds */ }
}

/** pgTAP extension state as "schema version" or "absent". */
async function pgtapState(container) {
  return dbScalar(
    container,
    "SELECT coalesce((SELECT extnamespace::regnamespace::text || ' ' || extversion " +
      "FROM pg_extension WHERE extname='pgtap'), 'absent');",
  );
}

/**
 * Deterministic, security-relevant catalog fingerprint (Section G) as a single
 * scalar expression (no trailing semicolon) so it can be run directly or nested
 * as a scalar subquery. Per-category md5 over stably-ordered rows for:
 *   - func: every persistent public function — schema, name, identity args, full
 *     pg_get_functiondef (detects a same-signature body change), result type,
 *     language, owner, kind, SECURITY DEFINER, volatility, strictness,
 *     leakproofness, parallel-safety, proconfig, ACL;
 *   - pol:  public policies — schema, table, name, command, permissive/restrictive
 *     mode, roles, USING, WITH CHECK;
 *   - rls:  public table RLS flags — schema, relation, relrowsecurity,
 *     relforcerowsecurity;
 *   - trg:  non-internal triggers on public tables — schema, table, name, full
 *     pg_get_triggerdef (timing/event/condition/args/function), enabled state;
 *   - rel:  persistent relations in public+extensions incl. indexes — schema,
 *     name, kind, owner, ACL, persistence, partition status;
 *   - col:  table columns in ordinal order — type, nullability, identity/generated
 *     state, collation, default expression;
 *   - con:  constraints via pg_get_constraintdef;
 *   - idx:  indexes via pg_get_indexdef (detects a same-name index change).
 * Excludes temp relations, internal schemas, unstable OIDs/relfilenodes, row
 * counts, and statistics. Only md5 hashes leave the DB — safe to log.
 */
const CATALOG_FP_SQL =
  "WITH " +
  "funcs AS (SELECT md5(coalesce(string_agg(line, E'\\n' ORDER BY line), '')) h FROM (" +
  "  SELECT n.nspname || '|' || p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' || " +
  "         CASE WHEN p.prokind IN ('f','p') THEN pg_get_functiondef(p.oid) ELSE '' END || '|' || " +
  "         coalesce(pg_get_function_result(p.oid), '') || '|' || l.lanname || '|' || " +
  "         p.proowner::regrole::text || '|' || p.prokind::text || '|' || p.prosecdef::text || '|' || " +
  "         p.provolatile::text || '|' || p.proisstrict::text || '|' || p.proleakproof::text || '|' || " +
  "         p.proparallel::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || " +
  "         coalesce(p.proacl::text, '') AS line " +
  "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
  "  JOIN pg_language l ON l.oid = p.prolang WHERE n.nspname = 'public') s), " +
  "pols AS (SELECT md5(coalesce(string_agg(line, E'\\n' ORDER BY line), '')) h FROM (" +
  "  SELECT schemaname || '|' || tablename || '|' || policyname || '|' || cmd || '|' || " +
  "         permissive || '|' || coalesce(array_to_string(roles, ','), '') || '|' || " +
  "         coalesce(qual, '') || '|' || coalesce(with_check, '') AS line " +
  "  FROM pg_policies WHERE schemaname = 'public') s), " +
  "rls AS (SELECT md5(coalesce(string_agg(line, E'\\n' ORDER BY line), '')) h FROM (" +
  "  SELECT n.nspname || '|' || c.relname || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text AS line " +
  "  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')) s), " +
  "trg AS (SELECT md5(coalesce(string_agg(line, E'\\n' ORDER BY line), '')) h FROM (" +
  "  SELECT n.nspname || '|' || c.relname || '|' || t.tgname || '|' || " +
  "         pg_get_triggerdef(t.oid, true) || '|' || t.tgenabled::text AS line " +
  "  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid " +
  "  JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "  WHERE n.nspname = 'public' AND NOT t.tgisinternal) s), " +
  "rels AS (SELECT md5(coalesce(string_agg(line, E'\\n' ORDER BY line), '')) h FROM (" +
  "  SELECT n.nspname || '|' || c.relname || '|' || c.relkind::text || '|' || " +
  "         c.relowner::regrole::text || '|' || coalesce(c.relacl::text, '') || '|' || " +
  "         c.relpersistence::text || '|' || c.relispartition::text AS line " +
  "  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "  WHERE n.nspname IN ('public','extensions') AND c.relkind IN ('r','v','m','S','p','i','I') " +
  "    AND c.relpersistence <> 't') s), " +
  "cols AS (SELECT md5(coalesce(string_agg(line, E'\\n' ORDER BY line), '')) h FROM (" +
  "  SELECT n.nspname || '|' || c.relname || '|' || lpad(a.attnum::text, 4, '0') || '|' || a.attname || '|' || " +
  "         format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || " +
  "         a.attidentity::text || '|' || a.attgenerated::text || '|' || coalesce(col.collname, '') || '|' || " +
  "         coalesce(pg_get_expr(ad.adbin, ad.adrelid), '') AS line " +
  "  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid " +
  "  JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum " +
  "  LEFT JOIN pg_collation col ON col.oid = a.attcollation " +
  "  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND a.attnum > 0 AND NOT a.attisdropped) s), " +
  "cons AS (SELECT md5(coalesce(string_agg(line, E'\\n' ORDER BY line), '')) h FROM (" +
  "  SELECT n.nspname || '|' || c.relname || '|' || con.conname || '|' || pg_get_constraintdef(con.oid) AS line " +
  "  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid " +
  "  JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') s), " +
  "idx AS (SELECT md5(coalesce(string_agg(line, E'\\n' ORDER BY line), '')) h FROM (" +
  "  SELECT n.nspname || '|' || c.relname || '|' || pg_get_indexdef(i.indexrelid) AS line " +
  "  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid " +
  "  JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "  WHERE n.nspname IN ('public','extensions') AND c.relpersistence <> 't') s) " +
  "SELECT 'func:' || funcs.h || '|pol:' || pols.h || '|rls:' || rls.h || '|trg:' || trg.h || " +
  "       '|rel:' || rels.h || '|col:' || cols.h || '|con:' || cons.h || '|idx:' || idx.h " +
  "FROM funcs, pols, rls, trg, rels, cols, cons, idx";

async function captureCatalog(container) {
  return dbScalar(container, CATALOG_FP_SQL + ";");
}

/** Parse a `cat:hash|cat:hash|…` fingerprint into a { cat: hash } map. */
function parseCatalog(fp) {
  const m = {};
  for (const part of fp.split("|")) {
    const i = part.indexOf(":");
    if (i > 0) m[part.slice(0, i)] = part.slice(i + 1);
  }
  return m;
}

/**
 * Catalog-fingerprint sensitivity probe (Section H). In ONE transaction on a
 * fresh connection, create deterministically-named probe objects, capture
 * fingerprint A, then REPLACE each under the SAME primary name with a different
 * definition (function body 1→2; trigger BEFORE INSERT → AFTER UPDATE; index
 * (val) → (val,id)), capture fingerprint B, and ROLLBACK. The probe passes only
 * if A≠B AND each mutated category (func, trg, idx) individually changed —
 * proving the fingerprint would catch a same-name definition change. Nothing is
 * committed; the generated SQL is never printed. The caller then re-captures the
 * real baseline on a fresh connection to prove the probe left no trace.
 */
async function runCatalogSensitivityProbe(container) {
  log("running catalog-fingerprint sensitivity probe…");
  const fp = "(" + CATALOG_FP_SQL + ")";
  const sql =
    "BEGIN;\n" +
    "CREATE TABLE public._c03b1_probe_t (id int PRIMARY KEY, val text);\n" +
    "CREATE FUNCTION public._c03b1_probe_f() RETURNS int LANGUAGE sql AS 'SELECT 1';\n" +
    "CREATE FUNCTION public._c03b1_probe_trgfn() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';\n" +
    "CREATE TRIGGER _c03b1_probe_trg BEFORE INSERT ON public._c03b1_probe_t FOR EACH ROW EXECUTE FUNCTION public._c03b1_probe_trgfn();\n" +
    "CREATE INDEX _c03b1_probe_idx ON public._c03b1_probe_t (val);\n" +
    "SELECT 'FP_A=' || " + fp + ";\n" +
    "CREATE OR REPLACE FUNCTION public._c03b1_probe_f() RETURNS int LANGUAGE sql AS 'SELECT 2';\n" +
    "DROP TRIGGER _c03b1_probe_trg ON public._c03b1_probe_t;\n" +
    "CREATE TRIGGER _c03b1_probe_trg AFTER UPDATE ON public._c03b1_probe_t FOR EACH ROW EXECUTE FUNCTION public._c03b1_probe_trgfn();\n" +
    "DROP INDEX public._c03b1_probe_idx;\n" +
    "CREATE INDEX _c03b1_probe_idx ON public._c03b1_probe_t (val, id);\n" +
    "SELECT 'FP_B=' || " + fp + ";\n" +
    "ROLLBACK;\n";
  const r = await dockerPsql(container, sql);
  if (r.code !== 0) {
    throw new Error(`catalog sensitivity probe failed to run: ${r.err.trim() || "(no stderr)"}`);
  }
  const lines = r.out.split("\n").map((s) => s.trim());
  const a = (lines.find((l) => l.startsWith("FP_A=")) || "").slice(5);
  const b = (lines.find((l) => l.startsWith("FP_B=")) || "").slice(5);
  if (!a || !b) throw new Error("catalog sensitivity probe produced no fingerprints.");
  if (a === b) {
    throw new Error("catalog fingerprint is insensitive: unchanged across same-name definition changes.");
  }
  const pa = parseCatalog(a);
  const pb = parseCatalog(b);
  for (const cat of ["func", "trg", "idx"]) {
    if (!pa[cat] || pa[cat] === pb[cat]) {
      throw new Error(`catalog fingerprint did not detect the same-name ${cat} definition change.`);
    }
  }
  log("catalog fingerprint detected same-name definition changes.");
}

/**
 * Expected-failure database negative control (Section E). In ONE transaction on a
 * fresh connection: create local-only users A and B, one paper owned by A,
 * transactionally DISABLE row-level security on papers (the injected regression),
 * become authenticated caller B, then run the same detector the green suite runs —
 * "caller B sees zero of A's rows". Because RLS is disabled, B sees A's row, so the
 * detector RAISES with a fixed marker and psql exits nonzero. The transaction is
 * never committed and is rolled back on abort/close. The outer harness treats the
 * control as SUCCESSFUL only when the inner process exits nonzero AND the exact
 * marker is present; an inner exit of zero (isolation appeared to hold despite the
 * injected leak) fails the C03B1 runner. The generated SQL is never printed.
 */
async function runNegativeControl(container) {
  log("running expected-failure database negative control (papers cross-user RLS)…");
  const sql =
    "BEGIN;\n" +
    `INSERT INTO auth.users (id, email) VALUES ('${NC_USER_A}','nc-a@paperlume.test'),('${NC_USER_B}','nc-b@paperlume.test');\n` +
    `INSERT INTO public.papers (id, user_id, title, insert_order) VALUES ('${NC_PAPER}','${NC_USER_A}','NC Paper A',1);\n` +
    // Injected, transaction-only regression: weaken papers isolation.
    "ALTER TABLE public.papers DISABLE ROW LEVEL SECURITY;\n" +
    // Become authenticated caller B (no BYPASSRLS), then run the detector.
    `SELECT set_config('request.jwt.claims','{\"sub\":\"${NC_USER_B}\",\"role\":\"authenticated\"}', true);\n` +
    "SET LOCAL ROLE authenticated;\n" +
    "DO $$ DECLARE n int; BEGIN\n" +
    `  SELECT count(*) INTO n FROM public.papers WHERE user_id = '${NC_USER_A}';\n` +
    `  IF n > 0 THEN RAISE EXCEPTION '${NC_MARKER}: authenticated caller B observed % papers owned by A', n; END IF;\n` +
    "END $$;\n" +
    "ROLLBACK;\n";
  const r = await dockerPsql(container, sql);
  const combined = `${r.out}\n${r.err}`;
  if (r.code === 0) {
    throw new Error(
      "negative control did not fail: the injected papers-RLS regression was not detected " +
        "(inner psql exited 0). The C03B1 detector is not fail-closed.",
    );
  }
  if (!combined.includes(NC_MARKER)) {
    throw new Error("negative control failed for the wrong reason: expected detector marker was absent.");
  }
  log("database negative control detected the intentional papers-RLS regression.");
}

/**
 * Prove, on a fresh connection, that the negative control left no trace
 * (Section E step 4): the catalog fingerprint equals the pre-control baseline
 * (so papers RLS and every policy/function are restored) and no negative-control
 * fixture row remains.
 */
async function assertNegativeControlRestored(container, catalogBefore) {
  const catalogAfter = await captureCatalog(container);
  if (catalogAfter !== catalogBefore) {
    throw new Error("negative control did not fully roll back: catalog fingerprint changed.");
  }
  const rls = await dbScalar(container,
    "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.papers'::regclass;");
  if (rls !== "t") throw new Error("negative control left papers RLS disabled.");
  const leftover = parseInt(await dbScalar(container,
    `SELECT count(*) FROM auth.users WHERE id IN ('${NC_USER_A}','${NC_USER_B}');`), 10);
  if (leftover !== 0) throw new Error("negative control left fixture users behind.");
  log("database negative-control rollback verified.");
}

/** Run every pgTAP file under supabase/tests/database on the local database. */
async function runPgTapDirectory() {
  log(`running pgTAP suites under ${DB_TESTS_DIR} (local)…`);
  const code = await runInherit("supabase", ["test", "db", DB_TESTS_DIR, "--local"]);
  if (code !== 0) throw new Error("pgTAP suite run failed.");
}

/** Run the immutable framework-free 18-case verification via psql. */
async function runLegacyVerification(container) {
  log("running framework-free owner/access/quota verification (18 cases)…");
  const sql = readFileSync(resolve(ROOT, LEGACY_VERIFICATION), "utf-8");
  const r = await dockerPsql(container, sql);
  const combined = `${r.out}\n${r.err}`;
  if (r.code !== 0 || !/ALL 18 VERIFICATION CASES PASSED/.test(combined)) {
    throw new Error("framework-free 18-case verification failed.");
  }
  log("framework-free verification passed (18/18).");
}

// classid/objid split of the 64-bit barrier key for pg_locks lookups.
const BARRIER_OBJID = BARRIER_KEY & 0xffffffff;
const BARRIER_CLASSID = Math.floor(BARRIER_KEY / 2 ** 32);
const MERGE_BARRIER_OBJID = MERGE_BARRIER_KEY & 0xffffffff;
const MERGE_BARRIER_CLASSID = Math.floor(MERGE_BARRIER_KEY / 2 ** 32);

/** Count ungranted advisory-lock waiters on the barrier key. */
async function countBarrierWaiters(container) {
  const n = await dbScalar(
    container,
    `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${BARRIER_CLASSID} ` +
      `AND objid=${BARRIER_OBJID} AND NOT granted;`,
  );
  return parseInt(n || "0", 10);
}

/** Count all advisory locks (granted or not) on the barrier key. */
async function countBarrierLocks(container) {
  const n = await dbScalar(
    container,
    `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${BARRIER_CLASSID} ` +
      `AND objid=${BARRIER_OBJID};`,
  );
  return parseInt(n || "0", 10);
}

/** One concurrent worker's SQL: block on the shared barrier, then consume once. */
function workerSql() {
  return (
    `SELECT set_config('request.jwt.claims','{"sub":"${PROBE_USER}","role":"authenticated"}', false);\n` +
    "SET ROLE authenticated;\n" +
    `SELECT pg_advisory_lock_shared(${BARRIER_KEY});\n` +
    `SELECT 'OUTCOME=' || allowed::text || '|' || reason FROM public.consume_ai_quota('${PROBE_USER}');\n`
  );
}

/** Parse the "allowed|reason" outcome from a worker that has already exited 0. */
function parseProbeOutcome(res) {
  const line = `${res.out}`.split("\n").map((s) => s.trim())
    .filter((l) => l.startsWith("OUTCOME=")).pop();
  return line ? line.slice("OUTCOME=".length) : "";
}

/**
 * True-concurrency AI-quota probe (Section I: bounded + fail-closed). A committed
 * fixture user sits one unit below a cap of PROBE_CAP. A coordinator session holds
 * an EXCLUSIVE advisory lock; two worker sessions block requesting the SHARED
 * lock; once both are confirmed waiting, the coordinator releases so both call
 * consume_ai_quota concurrently. Every coordinator/worker process is tracked,
 * bounded by an explicit timeout, and must exit 0 without signal termination —
 * output from a nonzero/killed process is never accepted. Exactly one call must be
 * allowed and one quota_exceeded; after all three sessions terminate, a fresh
 * connection must show the cap reached, one counter row, and no barrier locks/
 * waiters BEFORE the fixture is removed; fixture absence is then re-proven. On any
 * timeout/error the remaining processes are killed (bounded) and the error is
 * re-thrown so the caller still runs the mandatory teardown.
 */
async function runConcurrencyProbe(container) {
  log("running true-concurrency AI-quota probe…");
  const periodStart = "date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC'";

  // Committed fixture (visible to independent sessions): Pro, monthly cap, used=cap-1.
  const setup = await dockerPsql(
    container,
    `INSERT INTO auth.users (id, email) VALUES ('${PROBE_USER}','concurrency@paperlume.test') ON CONFLICT DO NOTHING;\n` +
      `UPDATE public.user_entitlements SET plan='pro', plan_status='active', ai_monthly_quota=${PROBE_CAP}, ai_lifetime_quota=0 WHERE user_id='${PROBE_USER}';\n` +
      `INSERT INTO public.usage_counters (user_id, feature, period_type, period_start, period_end, used) ` +
      `VALUES ('${PROBE_USER}','ai_analysis','monthly', ${periodStart}, ${periodStart} + INTERVAL '1 month', ${PROBE_CAP - 1}) ` +
      `ON CONFLICT (user_id, feature, period_type, period_start) DO UPDATE SET used=${PROBE_CAP - 1};\n`,
  );
  if (setup.code !== 0) throw new Error(`concurrency fixture setup failed: ${setup.err.trim()}`);

  let coord = null;
  let w1 = null;
  let w2 = null;
  let r1;
  let r2;
  try {
    // Coordinator acquires the EXCLUSIVE barrier in a tracked session.
    coord = spawnDockerPsql(container);
    coord.child.stdin.write(`SELECT pg_advisory_lock(${BARRIER_KEY}); SELECT 'COORD_LOCKED';\n`);
    await waitUntil(() => /COORD_LOCKED/.test(coord.readOut()), PROBE_COORD_ACQUIRE_MS,
      "coordinator failed to acquire the barrier lock.");

    // Both workers request the SHARED lock and block behind the coordinator.
    w1 = spawnDockerPsql(container);
    w2 = spawnDockerPsql(container);
    w1.child.stdin.write(workerSql()); w1.child.stdin.end();
    w2.child.stdin.write(workerSql()); w2.child.stdin.end();
    await waitUntil(async () => (await countBarrierWaiters(container)) >= 2, PROBE_BARRIER_MS,
      "both concurrency workers did not reach the barrier.");

    // Release: both shared requests are granted together → concurrent consume.
    const releaseAt = Date.now();
    coord.child.stdin.write(
      `SELECT 'UNLOCK=' || pg_advisory_unlock(${BARRIER_KEY})::text; SELECT 'COORD_UNLOCKED';\n`);
    coord.child.stdin.end();

    // Bounded completion — ALL three deadlines start NOW, at barrier release, so
    // no process is granted extra time merely because another was awaited first
    // (Section E). Each wrapped promise records its own elapsed ms from release.
    const timed = (p) => p.then((v) => ({ v, ms: Date.now() - releaseAt }));
    const [crT, r1T, r2T] = await Promise.all([
      timed(withTimeout(coord.done, PROBE_COORD_EXIT_MS, "coordinator exit")),
      timed(withTimeout(w1.done, PROBE_WORKER_MS, "worker 1 exit")),
      timed(withTimeout(w2.done, PROBE_WORKER_MS, "worker 2 exit")),
    ]);
    const cr = crT.v;
    r1 = r1T.v;
    r2 = r2T.v;

    // Sanitized elapsed evidence (no SQL / stderr / PIDs / connection details).
    log(`concurrency exits from barrier release (ms): coordinator=${crT.ms} (<= ${PROBE_COORD_EXIT_MS}); ` +
      `worker1=${r1T.ms} (<= ${PROBE_WORKER_MS}); worker2=${r2T.ms} (<= ${PROBE_WORKER_MS}).`);
    if (crT.ms > PROBE_COORD_EXIT_MS || r1T.ms > PROBE_WORKER_MS || r2T.ms > PROBE_WORKER_MS) {
      throw new Error("concurrency probe: a process exited outside its deadline from barrier release.");
    }

    // Fail closed: require clean acquisition, release, and exit for every process.
    if (cr.code !== 0 || cr.signal !== null || !/UNLOCK=t/.test(cr.out) || !/COORD_UNLOCKED/.test(cr.out)) {
      throw new Error(`coordinator did not acquire+release the barrier and exit cleanly (code=${cr.code}, signal=${cr.signal ?? "none"}).`);
    }
    for (const [nm, r] of [["worker 1", r1], ["worker 2", r2]]) {
      if (r.code !== 0 || r.signal !== null) {
        throw new Error(`concurrency ${nm} did not exit cleanly (code=${r.code}, signal=${r.signal ?? "none"}); output not accepted.`);
      }
    }

    const outcomes = [parseProbeOutcome(r1), parseProbeOutcome(r2)].sort();
    const allowed = outcomes.filter((o) => o === "true|ok").length;
    const exceeded = outcomes.filter((o) => o === "false|quota_exceeded").length;
    if (allowed !== 1 || exceeded !== 1) {
      throw new Error(`concurrency probe expected exactly one allowed + one quota_exceeded, got: ${outcomes.join(", ")}`);
    }
  } catch (err) {
    await killPsql(w1);
    await killPsql(w2);
    await killPsql(coord);
    throw err;
  }

  // All three sessions have terminated. Prove lock + quota invariants on fresh
  // connections BEFORE removing the committed fixture.
  const barrierLocks = await countBarrierLocks(container);
  const barrierWaiters = await countBarrierWaiters(container);
  if (barrierLocks !== 0) throw new Error(`concurrency probe: ${barrierLocks} advisory lock(s) remain on the barrier key.`);
  if (barrierWaiters !== 0) throw new Error(`concurrency probe: ${barrierWaiters} ungranted barrier waiter(s) remain.`);
  const finalUsed = parseInt(await dbScalar(container,
    `SELECT used FROM public.usage_counters WHERE user_id='${PROBE_USER}' AND feature='ai_analysis' AND period_type='monthly';`), 10);
  const rowCount = parseInt(await dbScalar(container,
    `SELECT count(*) FROM public.usage_counters WHERE user_id='${PROBE_USER}' AND feature='ai_analysis' AND period_type='monthly';`), 10);
  if (finalUsed !== PROBE_CAP) throw new Error(`concurrency probe: final usage ${finalUsed} != cap ${PROBE_CAP}.`);
  if (rowCount !== 1) throw new Error(`concurrency probe: expected exactly one counter row, found ${rowCount}.`);
  log(`concurrency probe OK: one allowed + one quota_exceeded; usage=${finalUsed} (cap ${PROBE_CAP}); one counter row; no barrier locks remain.`);

  // Only now remove every committed fixture; release any lingering advisory lock.
  const cleanup = await dockerPsql(container,
    `SELECT pg_advisory_unlock_all();\n` +
    `DELETE FROM public.usage_counters WHERE user_id='${PROBE_USER}';\n` +
    `DELETE FROM public.user_storage_usage WHERE user_id='${PROBE_USER}';\n` +
    `DELETE FROM public.internal_user_access WHERE user_id='${PROBE_USER}';\n` +
    `DELETE FROM public.user_entitlements WHERE user_id='${PROBE_USER}';\n` +
    `DELETE FROM auth.users WHERE id='${PROBE_USER}';\n`);
  if (cleanup.code !== 0) throw new Error(`concurrency fixture cleanup failed: ${cleanup.err.trim()}`);
  // Prove full fixture absence on a fresh connection.
  const residual = (await dbScalar(container,
    `SELECT (SELECT count(*) FROM auth.users WHERE id='${PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.user_entitlements WHERE user_id='${PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.usage_counters WHERE user_id='${PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.user_storage_usage WHERE user_id='${PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.internal_user_access WHERE user_id='${PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${BARRIER_CLASSID} AND objid=${BARRIER_OBJID});`))
    .split("|").map((s) => parseInt(s, 10));
  if (residual.some((c) => c !== 0)) {
    throw new Error(`concurrency fixture not fully removed (user|entitlement|counter|storage|access|advisory = ${residual.join("|")}).`);
  }
}

/** Count ungranted waiters on the merge probe's own barrier key. */
async function countMergeBarrierWaiters(container) {
  const n = await dbScalar(
    container,
    `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${MERGE_BARRIER_CLASSID} ` +
      `AND objid=${MERGE_BARRIER_OBJID} AND NOT granted;`,
  );
  return parseInt(n || "0", 10);
}

/** One merge worker: block on the barrier, then attempt `source -> target`. */
function mergeWorkerSql(source, target) {
  return (
    // The helper is created as postgres so it can exist in pg_temp, then called
    // as `authenticated` — the RPC runs under the caller's role and reads
    // `auth.uid()` from the claims, exactly as a real request does. Its exception
    // handler turns a rejection into a value, so a refused merge is an outcome to
    // assert on rather than a nonzero exit indistinguishable from a crash.
    `CREATE FUNCTION pg_temp.try_merge(a uuid, b uuid) RETURNS text LANGUAGE plpgsql AS $fn$\n` +
    `BEGIN\n` +
    `  PERFORM public.merge_author_identities(a, b);\n` +
    `  RETURN 'merged';\n` +
    `EXCEPTION WHEN others THEN\n` +
    // The message matters: only a CYCLE rejection proves the lock did its job.
    // Any other refusal would mean the two calls never actually raced.
    `  RETURN CASE WHEN SQLERRM ILIKE '%cycle%' THEN 'rejected-cycle' ELSE 'rejected-other' END;\n` +
    `END\n` +
    `$fn$;\n` +
    `SELECT set_config('request.jwt.claims','{"sub":"${MERGE_PROBE_USER}","role":"authenticated"}', false);\n` +
    "SET ROLE authenticated;\n" +
    `SELECT pg_advisory_lock_shared(${MERGE_BARRIER_KEY});\n` +
    `SELECT 'OUTCOME=' || pg_temp.try_merge('${source}'::uuid, '${target}'::uuid);\n`
  );
}

/**
 * True-concurrency merge-cycle probe (AUTHOR-IDENTITY-RESOLUTION-001C).
 *
 * Every other identity invariant is enforced by a constraint — the unique
 * `(paper_id, author_index)` decides a link race, and the primary key on
 * `source_identity_id` makes a second outgoing edge unstorable. The merge CYCLE
 * rule is the exception: it is enforced by root resolution reading rows a
 * concurrent transaction has not committed yet.
 *
 * Without the per-user `pg_advisory_xact_lock` in `merge_author_identities`, two
 * tabs merging A into B and B into A would each resolve a root against a graph
 * that did not yet contain the other's edge, both would pass their own cycle
 * check, and both would commit — leaving `A -> B -> A`, a cluster in which no
 * identity has a root and every read that walks the graph is wrong.
 *
 * So: two committed identities, a coordinator holding an EXCLUSIVE barrier, two
 * workers blocked on the SHARED barrier attempting the opposing merges, released
 * together. Exactly one must succeed, and the surviving graph must hold exactly
 * one edge and resolve to a real root. Same fail-closed discipline as the quota
 * probe: every process is tracked, bounded, and must exit cleanly, and the
 * fixture is proven absent afterwards.
 */
async function runMergeCycleProbe(container) {
  log("running true-concurrency author-identity merge-cycle probe…");

  const setup = await dockerPsql(
    container,
    `INSERT INTO auth.users (id, email) VALUES ('${MERGE_PROBE_USER}','merge-race@paperlume.test') ON CONFLICT DO NOTHING;\n` +
      `INSERT INTO public.author_identities (id, user_id, preferred_name) VALUES\n` +
      `  ('${MERGE_ID_A}','${MERGE_PROBE_USER}','Race A'),\n` +
      `  ('${MERGE_ID_B}','${MERGE_PROBE_USER}','Race B')\n` +
      `ON CONFLICT (id) DO NOTHING;\n`,
  );
  if (setup.code !== 0) throw new Error(`merge-cycle fixture setup failed: ${setup.err.trim()}`);

  let coord = null;
  let w1 = null;
  let w2 = null;
  try {
    coord = spawnDockerPsql(container);
    coord.child.stdin.write(`SELECT pg_advisory_lock(${MERGE_BARRIER_KEY}); SELECT 'COORD_LOCKED';\n`);
    await waitUntil(() => /COORD_LOCKED/.test(coord.readOut()), PROBE_COORD_ACQUIRE_MS,
      "merge-cycle coordinator failed to acquire the barrier lock.");

    // Opposing directions: the only pair that can close a two-node cycle.
    w1 = spawnDockerPsql(container);
    w2 = spawnDockerPsql(container);
    w1.child.stdin.write(mergeWorkerSql(MERGE_ID_A, MERGE_ID_B)); w1.child.stdin.end();
    w2.child.stdin.write(mergeWorkerSql(MERGE_ID_B, MERGE_ID_A)); w2.child.stdin.end();
    await waitUntil(async () => (await countMergeBarrierWaiters(container)) >= 2, PROBE_BARRIER_MS,
      "both merge-cycle workers did not reach the barrier.");

    const releaseAt = Date.now();
    coord.child.stdin.write(
      `SELECT 'UNLOCK=' || pg_advisory_unlock(${MERGE_BARRIER_KEY})::text; SELECT 'COORD_UNLOCKED';\n`);
    coord.child.stdin.end();

    const timed = (p) => p.then((v) => ({ v, ms: Date.now() - releaseAt }));
    const [crT, r1T, r2T] = await Promise.all([
      timed(withTimeout(coord.done, PROBE_COORD_EXIT_MS, "merge-cycle coordinator exit")),
      timed(withTimeout(w1.done, PROBE_WORKER_MS, "merge-cycle worker 1 exit")),
      timed(withTimeout(w2.done, PROBE_WORKER_MS, "merge-cycle worker 2 exit")),
    ]);
    const cr = crT.v;
    const r1 = r1T.v;
    const r2 = r2T.v;

    log(`merge-cycle exits from barrier release (ms): coordinator=${crT.ms} (<= ${PROBE_COORD_EXIT_MS}); ` +
      `worker1=${r1T.ms} (<= ${PROBE_WORKER_MS}); worker2=${r2T.ms} (<= ${PROBE_WORKER_MS}).`);
    if (crT.ms > PROBE_COORD_EXIT_MS || r1T.ms > PROBE_WORKER_MS || r2T.ms > PROBE_WORKER_MS) {
      throw new Error("merge-cycle probe: a process exited outside its deadline from barrier release.");
    }
    if (cr.code !== 0 || cr.signal !== null || !/UNLOCK=t/.test(cr.out) || !/COORD_UNLOCKED/.test(cr.out)) {
      throw new Error(`merge-cycle coordinator did not acquire+release the barrier and exit cleanly (code=${cr.code}, signal=${cr.signal ?? "none"}).`);
    }
    for (const [nm, r] of [["worker 1", r1], ["worker 2", r2]]) {
      if (r.code !== 0 || r.signal !== null) {
        throw new Error(`merge-cycle ${nm} did not exit cleanly (code=${r.code}, signal=${r.signal ?? "none"}); output not accepted.`);
      }
    }

    const outcomes = [parseProbeOutcome(r1), parseProbeOutcome(r2)].sort();
    const merged = outcomes.filter((o) => o === "merged").length;
    const rejected = outcomes.filter((o) => o === "rejected-cycle").length;
    if (merged !== 1 || rejected !== 1) {
      // Two "merged" is the failure this probe exists for: it means both
      // transactions resolved a root against a graph missing the other's edge.
      throw new Error(`merge-cycle probe expected exactly one merged + one rejected-cycle, got: ${outcomes.join(", ")}`);
    }
  } catch (err) {
    await killPsql(w1);
    await killPsql(w2);
    await killPsql(coord);
    throw err;
  }

  // The surviving graph, read on a fresh connection: one edge, and a root that
  // resolves — a cycle would make the walk raise instead of returning.
  const edges = parseInt(await dbScalar(container,
    `SELECT count(*) FROM public.author_identity_merges WHERE user_id='${MERGE_PROBE_USER}';`), 10);
  if (edges !== 1) throw new Error(`merge-cycle probe: expected exactly one surviving edge, found ${edges}.`);
  const roots = await dbScalar(container,
    `SELECT public.author_identity_effective_root('${MERGE_PROBE_USER}','${MERGE_ID_A}') || '|' || ` +
    `public.author_identity_effective_root('${MERGE_PROBE_USER}','${MERGE_ID_B}');`);
  const [rootA, rootB] = roots.split("|");
  if (rootA !== rootB) {
    throw new Error(`merge-cycle probe: the two identities resolve to different roots (${roots}).`);
  }
  const waiters = await countMergeBarrierWaiters(container);
  if (waiters !== 0) throw new Error(`merge-cycle probe: ${waiters} ungranted barrier waiter(s) remain.`);
  log("merge-cycle probe OK: one merge committed, one refused as a cycle; a single acyclic edge survives.");

  const cleanup = await dockerPsql(container,
    `SELECT pg_advisory_unlock_all();\n` +
    `DELETE FROM auth.users WHERE id='${MERGE_PROBE_USER}';\n`);
  if (cleanup.code !== 0) throw new Error(`merge-cycle fixture cleanup failed: ${cleanup.err.trim()}`);
  const residual = (await dbScalar(container,
    `SELECT (SELECT count(*) FROM auth.users WHERE id='${MERGE_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.author_identities WHERE user_id='${MERGE_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.author_identity_merges WHERE user_id='${MERGE_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${MERGE_BARRIER_CLASSID} AND objid=${MERGE_BARRIER_OBJID});`))
    .split("|").map((s) => parseInt(s, 10));
  if (residual.some((c) => c !== 0)) {
    throw new Error(`merge-cycle fixture not fully removed (user|identities|merges|advisory = ${residual.join("|")}).`);
  }
}

// ── ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001-CORRECTION-01 ────────────────────
// Upload-finalization linearization probe. Its own user, paper, barrier key and
// quota so it cannot interact with the two probes above.
const FIN_PROBE_USER = "cc000000-0000-0000-0000-0000000000ce";
const FIN_PROBE_PAPER = "cc000000-0000-0000-0000-0000000000cf";
const FIN_BARRIER_KEY = 918273647;
const FIN_BARRIER_OBJID = FIN_BARRIER_KEY & 0xffffffff;
const FIN_BARRIER_CLASSID = Math.floor(FIN_BARRIER_KEY / 2 ** 32);
// The advisory-lock class finalize_attachment_upload itself takes, from
// migration 20260904120000. Waiting on it is how this probe observes that a
// second finalization is genuinely blocked rather than merely slow.
const FIN_LOCK_CLASSID = 20260904;
const FIN_QUOTA = 4096;        // storage quota granted to the probe user.
const FIN_OK_BYTES = 1024;     // fits.
const FIN_TOO_BIG = 1000000;   // cannot fit — a deterministic metadata rejection.
const FIN_HOLD_MS = 20000;     // a held transaction must be released within this.

/** A path in the probe user's own namespace, under the probe paper. */
function finPath(name) {
  return `${FIN_PROBE_USER}/${FIN_PROBE_PAPER}/${name}`;
}

/** Count ungranted waiters on this probe's own start barrier. */
async function countFinBarrierWaiters(container) {
  const n = await dbScalar(
    container,
    `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${FIN_BARRIER_CLASSID} ` +
      `AND objid=${FIN_BARRIER_OBJID} AND NOT granted;`,
  );
  return parseInt(n || "0", 10);
}

/** Count sessions blocked on the RPC's own (user, path) advisory lock class. */
async function countFinalizeLockWaiters(container) {
  const n = await dbScalar(
    container,
    `SELECT count(*) FROM pg_locks WHERE locktype='advisory' ` +
      `AND classid=${FIN_LOCK_CLASSID} AND NOT granted;`,
  );
  return parseInt(n || "0", 10);
}

/** Become the probe user for the rest of this session, exactly as a request does. */
function finAuthPrelude(local) {
  return (
    `SELECT set_config('request.jwt.claims','{"sub":"${FIN_PROBE_USER}","role":"authenticated"}', ${local});\n` +
    `SET${local ? " LOCAL" : ""} ROLE authenticated;\n`
  );
}

/** `SELECT status FROM finalize_attachment_upload(...)`, tagged for parsing. */
function finalizeSql(path, bytes, tag = "OUTCOME") {
  return (
    `SELECT '${tag}=' || status FROM public.finalize_attachment_upload(` +
    `'${FIN_PROBE_PAPER}'::uuid, '${path}', 'probe.pdf', 'application/pdf', ${bytes});\n`
  );
}

/** One barrier worker: block on the shared barrier, then finalize the same path. */
function finWorkerSql(path, bytes) {
  return (
    finAuthPrelude(false) +
    `SELECT pg_advisory_lock_shared(${FIN_BARRIER_KEY});\n` +
    finalizeSql(path, bytes)
  );
}

/** Set the probe user's storage quota (committed, so other sessions see it). */
async function setFinQuota(container, bytes) {
  const r = await dockerPsql(
    container,
    `UPDATE public.user_entitlements SET storage_quota_bytes=${bytes} WHERE user_id='${FIN_PROBE_USER}';`,
  );
  if (r.code !== 0) throw new Error(`finalization probe: quota fixture update failed: ${r.err.trim()}`);
}

/** `metadata rows for this path | cleanup rows for this path | bytes charged`. */
async function finState(container, path) {
  const raw = await dbScalar(
    container,
    `SELECT (SELECT count(*) FROM public.paper_attachments WHERE user_id='${FIN_PROBE_USER}' AND file_path='${path}') || '|' || ` +
      `(SELECT count(*) FROM public.attachment_cleanup_queue WHERE user_id='${FIN_PROBE_USER}' AND file_path='${path}') || '|' || ` +
      `(SELECT COALESCE(used_bytes,0) FROM public.user_storage_usage WHERE user_id='${FIN_PROBE_USER}');`,
  );
  const [metadata, cleanup, used] = raw.split("|").map((s) => parseInt(s, 10));
  return { metadata, cleanup, used };
}

/** Assert a {metadata, cleanup, used} triple, naming the case that failed. */
function assertFinState(label, actual, expected) {
  for (const key of ["metadata", "cleanup", "used"]) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `finalization probe ${label}: expected ${key}=${expected[key]}, got ${actual[key]} ` +
          `(metadata|cleanup|used = ${actual.metadata}|${actual.cleanup}|${actual.used}).`,
      );
    }
  }
}

/**
 * Run one finalization in a session that STAYS OPEN, so its writes exist but are
 * not yet visible. Returns the live handle plus its reported status; the caller
 * must commit it (or the probe's error path kills it).
 */
async function beginHeldFinalization(container, path, bytes, label) {
  const held = spawnDockerPsql(container);
  held.child.stdin.write(
    "BEGIN;\n" + finAuthPrelude(true) + finalizeSql(path, bytes, "HELD") + "SELECT 'HELD_READY';\n",
  );
  await waitUntil(() => /HELD_READY/.test(held.readOut()), PROBE_WORKER_MS,
    `finalization probe ${label}: the held transaction never reached its finalization.`);
  const line = held.readOut().split("\n").map((s) => s.trim())
    .filter((l) => l.startsWith("HELD=")).pop();
  return { held, status: line ? line.slice("HELD=".length) : "" };
}

/**
 * True-concurrency upload-finalization probe
 * (ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001-CORRECTION-01).
 *
 * The defect this exists for is not a missing constraint; it is an ORDERING.
 * The superseded design inserted attachment metadata from the browser and, when
 * the browser saw an error, asked a second RPC whether a committed metadata row
 * named the path. A metadata transaction that was still IN FLIGHT answered that
 * question with "no", so a lost HTTP response could queue cleanup for a row that
 * committed a moment later — and the drain would then delete a valid,
 * quota-charged attachment's binary.
 *
 * A single-connection pgTAP suite cannot see that: every statement in it is
 * already serialized. So this probe uses real concurrent sessions, and Case C
 * additionally runs the OLD existence check against an in-flight transaction as
 * a negative control — it must observe the stale "no" that the old design acted
 * on, while the corrected RPC blocks and then converges.
 *
 * Same fail-closed discipline as the two probes above: every process tracked,
 * every wait bounded by an explicit deadline, no arbitrary sleep used as proof,
 * clean exits required, and the fixture proven absent afterwards.
 */
async function runAttachmentFinalizationProbe(container) {
  log("running true-concurrency attachment upload-finalization probe…");

  const setup = await dockerPsql(
    container,
    `INSERT INTO auth.users (id, email) VALUES ('${FIN_PROBE_USER}','finalize-race@paperlume.test') ON CONFLICT DO NOTHING;\n` +
      `UPDATE public.user_entitlements SET storage_quota_bytes=${FIN_QUOTA} WHERE user_id='${FIN_PROBE_USER}';\n` +
      `INSERT INTO public.papers (id, user_id, title, keywords, insert_order) ` +
      `VALUES ('${FIN_PROBE_PAPER}','${FIN_PROBE_USER}','Finalization race','[]'::jsonb,1) ON CONFLICT (id) DO NOTHING;\n`,
  );
  if (setup.code !== 0) throw new Error(`finalization fixture setup failed: ${setup.err.trim()}`);

  const pathA = finPath("case-a.pdf");
  const pathB = finPath("case-b.pdf");
  const pathC = finPath("case-c.pdf");
  const pathD = finPath("case-d.pdf");

  let coord = null;
  let w1 = null;
  let w2 = null;
  let heldC = null;
  let heldD = null;
  try {
    // ── Case Z — the isolation level the linearization argument depends on ──
    // The serialization proof has two halves: the advisory lock orders the
    // transactions, and READ COMMITTED guarantees the waiter's next read takes a
    // snapshot NEWER than the commit it just waited for. The second half is not
    // a lock property, so the function refuses to run where it does not hold.
    const isolation = await dockerPsql(
      container,
      "BEGIN ISOLATION LEVEL REPEATABLE READ;\n" + finAuthPrelude(true) +
        finalizeSql(pathA, FIN_OK_BYTES) + "ROLLBACK;\n",
    );
    if (isolation.code === 0 || !/READ COMMITTED/i.test(isolation.err)) {
      throw new Error("finalization probe Case Z: finalization did not refuse a non-READ-COMMITTED transaction.");
    }
    log("finalization probe Case Z OK: REPEATABLE READ is refused, not silently raced.");

    // ── Case A — two concurrent finalizations of the SAME object ────────────
    coord = spawnDockerPsql(container);
    coord.child.stdin.write(`SELECT pg_advisory_lock(${FIN_BARRIER_KEY}); SELECT 'COORD_LOCKED';\n`);
    await waitUntil(() => /COORD_LOCKED/.test(coord.readOut()), PROBE_COORD_ACQUIRE_MS,
      "finalization coordinator failed to acquire the barrier lock.");

    w1 = spawnDockerPsql(container);
    w2 = spawnDockerPsql(container);
    w1.child.stdin.write(finWorkerSql(pathA, FIN_OK_BYTES)); w1.child.stdin.end();
    w2.child.stdin.write(finWorkerSql(pathA, FIN_OK_BYTES)); w2.child.stdin.end();
    await waitUntil(async () => (await countFinBarrierWaiters(container)) >= 2, PROBE_BARRIER_MS,
      "both finalization workers did not reach the barrier.");

    const releaseAt = Date.now();
    coord.child.stdin.write(
      `SELECT 'UNLOCK=' || pg_advisory_unlock(${FIN_BARRIER_KEY})::text; SELECT 'COORD_UNLOCKED';\n`);
    coord.child.stdin.end();

    const timed = (p) => p.then((v) => ({ v, ms: Date.now() - releaseAt }));
    const [crT, r1T, r2T] = await Promise.all([
      timed(withTimeout(coord.done, PROBE_COORD_EXIT_MS, "finalization coordinator exit")),
      timed(withTimeout(w1.done, PROBE_WORKER_MS, "finalization worker 1 exit")),
      timed(withTimeout(w2.done, PROBE_WORKER_MS, "finalization worker 2 exit")),
    ]);
    const cr = crT.v;
    const r1 = r1T.v;
    const r2 = r2T.v;

    log(`finalization exits from barrier release (ms): coordinator=${crT.ms} (<= ${PROBE_COORD_EXIT_MS}); ` +
      `worker1=${r1T.ms} (<= ${PROBE_WORKER_MS}); worker2=${r2T.ms} (<= ${PROBE_WORKER_MS}).`);
    if (crT.ms > PROBE_COORD_EXIT_MS || r1T.ms > PROBE_WORKER_MS || r2T.ms > PROBE_WORKER_MS) {
      throw new Error("finalization probe: a process exited outside its deadline from barrier release.");
    }
    if (cr.code !== 0 || cr.signal !== null || !/UNLOCK=t/.test(cr.out) || !/COORD_UNLOCKED/.test(cr.out)) {
      throw new Error(`finalization coordinator did not acquire+release the barrier and exit cleanly (code=${cr.code}, signal=${cr.signal ?? "none"}).`);
    }
    for (const [nm, r] of [["worker 1", r1], ["worker 2", r2]]) {
      if (r.code !== 0 || r.signal !== null) {
        throw new Error(`finalization ${nm} did not exit cleanly (code=${r.code}, signal=${r.signal ?? "none"}); output not accepted.`);
      }
    }

    // One creates the row; the other must find it. Two metadata_committed would
    // mean the lock did not order them; any cleanup_queued would mean one of
    // them concluded the object was garbage while the other was saving it.
    const outcomesA = [parseProbeOutcome(r1), parseProbeOutcome(r2)].sort();
    if (outcomesA.join(",") !== "metadata_committed,metadata_present") {
      throw new Error(`finalization probe Case A expected one metadata_committed + one metadata_present, got: ${outcomesA.join(", ")}`);
    }
    assertFinState("Case A", await finState(container, pathA),
      { metadata: 1, cleanup: 0, used: FIN_OK_BYTES });
    log(`finalization probe Case A OK: one committed + one converged; one metadata row, no cleanup row, ${FIN_OK_BYTES} bytes charged once.`);

    // ── Case B — a rejected metadata insert must still commit its intent ────
    // Deterministic rejection, not an injected fault: the requested size cannot
    // fit the remaining quota, so the BEFORE INSERT trigger raises inside the
    // function's subtransaction. The row and the quota it consumed roll back;
    // the enclosing transaction survives and commits the cleanup row.
    const rejected = await dockerPsql(container, finAuthPrelude(false) + finalizeSql(pathB, FIN_TOO_BIG));
    if (rejected.code !== 0 || !/OUTCOME=cleanup_queued/.test(rejected.out)) {
      throw new Error("finalization probe Case B: a quota-rejected finalization did not report cleanup_queued.");
    }
    assertFinState("Case B", await finState(container, pathB),
      { metadata: 0, cleanup: 1, used: FIN_OK_BYTES });

    // The same path, retried once the quota would now allow it. The intent is a
    // tombstone: a path already declared garbage must never become metadata,
    // because the drain is entitled to delete its object at any moment.
    await setFinQuota(container, FIN_QUOTA * 1000);
    const retried = await dockerPsql(container, finAuthPrelude(false) + finalizeSql(pathB, FIN_OK_BYTES));
    if (retried.code !== 0 || !/OUTCOME=cleanup_queued/.test(retried.out)) {
      throw new Error("finalization probe Case B: the retry did not report the existing cleanup state.");
    }
    assertFinState("Case B retry", await finState(container, pathB),
      { metadata: 0, cleanup: 1, used: FIN_OK_BYTES });
    log("finalization probe Case B OK: rejection committed one cleanup row, charged no quota, and the retry refused to create metadata over it.");

    // ── Case C — the exact interleaving the old design got wrong ────────────
    // A finalization commits metadata but its transaction is still open, which
    // is precisely the state a lost HTTP response leaves behind.
    const c = await beginHeldFinalization(container, pathC, FIN_OK_BYTES, "Case C");
    heldC = c.held;
    if (c.status !== "metadata_committed") {
      throw new Error(`finalization probe Case C: the held transaction reported "${c.status}", expected metadata_committed.`);
    }

    // Negative control — the OLD compensation check, run right now. It must
    // observe the stale "no metadata" that made the old design queue cleanup for
    // a valid attachment. If this ever starts returning true, this case has
    // stopped reproducing the race and proves nothing.
    const stale = await dbScalar(container,
      `SELECT EXISTS (SELECT 1 FROM public.paper_attachments WHERE file_path='${pathC}')::text;`);
    if (stale !== "false") {
      throw new Error("finalization probe Case C: the in-flight metadata row was already visible; the race is not reproduced.");
    }

    // The corrected RPC, from an independent session, while that transaction is
    // still open. It must BLOCK on the function's own advisory lock rather than
    // read the same stale state and reach the opposite conclusion.
    const late = spawnDockerPsql(container);
    late.child.stdin.write(finAuthPrelude(false) + finalizeSql(pathC, FIN_OK_BYTES) + "SELECT 'LATE_DONE';\n");
    late.child.stdin.end();
    await waitUntil(async () => (await countFinalizeLockWaiters(container)) >= 1, PROBE_BARRIER_MS,
      "finalization probe Case C: the second finalization never blocked on the serialization lock.");
    if (/LATE_DONE/.test(late.readOut())) {
      throw new Error("finalization probe Case C: the second finalization completed while the first was still in flight.");
    }

    heldC.child.stdin.write("COMMIT;\nSELECT 'HELD_COMMITTED';\n"); heldC.child.stdin.end();
    const [heldRes, lateRes] = await Promise.all([
      withTimeout(heldC.done, FIN_HOLD_MS, "finalization probe Case C held-transaction exit"),
      withTimeout(late.done, FIN_HOLD_MS, "finalization probe Case C waiter exit"),
    ]);
    heldC = null;
    if (heldRes.code !== 0 || heldRes.signal !== null || !/HELD_COMMITTED/.test(heldRes.out)) {
      throw new Error(`finalization probe Case C: the held transaction did not commit cleanly (code=${heldRes.code}, signal=${heldRes.signal ?? "none"}).`);
    }
    if (lateRes.code !== 0 || lateRes.signal !== null) {
      throw new Error(`finalization probe Case C: the waiter did not exit cleanly (code=${lateRes.code}, signal=${lateRes.signal ?? "none"}).`);
    }
    if (parseProbeOutcome(lateRes) !== "metadata_present") {
      throw new Error(`finalization probe Case C: the waiter reported "${parseProbeOutcome(lateRes)}", expected metadata_present.`);
    }
    assertFinState("Case C", await finState(container, pathC),
      { metadata: 1, cleanup: 0, used: FIN_OK_BYTES * 2 });
    log("finalization probe Case C OK: the old existence check saw the stale absence; the corrected RPC waited and returned metadata_present, queueing nothing.");

    // ── Case D — the mirror ordering, cleanup committed first ───────────────
    await setFinQuota(container, FIN_QUOTA);
    const d = await beginHeldFinalization(container, pathD, FIN_TOO_BIG, "Case D");
    heldD = d.held;
    if (d.status !== "cleanup_queued") {
      throw new Error(`finalization probe Case D: the held transaction reported "${d.status}", expected cleanup_queued.`);
    }

    const lateD = spawnDockerPsql(container);
    await setFinQuota(container, FIN_QUOTA * 1000);
    lateD.child.stdin.write(finAuthPrelude(false) + finalizeSql(pathD, FIN_OK_BYTES) + "SELECT 'LATE_DONE';\n");
    lateD.child.stdin.end();
    await waitUntil(async () => (await countFinalizeLockWaiters(container)) >= 1, PROBE_BARRIER_MS,
      "finalization probe Case D: the second finalization never blocked on the serialization lock.");

    heldD.child.stdin.write("COMMIT;\nSELECT 'HELD_COMMITTED';\n"); heldD.child.stdin.end();
    const [heldResD, lateResD] = await Promise.all([
      withTimeout(heldD.done, FIN_HOLD_MS, "finalization probe Case D held-transaction exit"),
      withTimeout(lateD.done, FIN_HOLD_MS, "finalization probe Case D waiter exit"),
    ]);
    heldD = null;
    if (heldResD.code !== 0 || heldResD.signal !== null || !/HELD_COMMITTED/.test(heldResD.out)) {
      throw new Error(`finalization probe Case D: the held transaction did not commit cleanly (code=${heldResD.code}, signal=${heldResD.signal ?? "none"}).`);
    }
    if (lateResD.code !== 0 || lateResD.signal !== null) {
      throw new Error(`finalization probe Case D: the waiter did not exit cleanly (code=${lateResD.code}, signal=${lateResD.signal ?? "none"}).`);
    }
    // The waiter had enough quota to succeed and must still refuse: the ordering,
    // not the quota, is what decides.
    if (parseProbeOutcome(lateResD) !== "cleanup_queued") {
      throw new Error(`finalization probe Case D: the waiter reported "${parseProbeOutcome(lateResD)}", expected cleanup_queued.`);
    }
    assertFinState("Case D", await finState(container, pathD),
      { metadata: 0, cleanup: 1, used: FIN_OK_BYTES * 2 });
    log("finalization probe Case D OK: a committed cleanup intent could not be overwritten by a finalization that began before it.");

    // ── Case E — the decision must outlive the work it authorised ───────────
    // Case B left pathB with a cleanup row AND a tombstone. The drain's last
    // act is to DELETE the queue row, which is what the client is granted and
    // what the browser does. Once it has, the queue holds nothing about this
    // path — and if that were the only record, a duplicated finalization would
    // find no metadata and no intent and create metadata for a binary the drain
    // has already removed.
    const acked = await dockerPsql(
      container,
      finAuthPrelude(false) +
        `DELETE FROM public.attachment_cleanup_queue WHERE file_path='${pathB}';\n`,
    );
    if (acked.code !== 0) {
      throw new Error(`finalization probe Case E: acknowledging the queue row failed: ${acked.err.trim()}`);
    }
    const ackedState = await finState(container, pathB);
    if (ackedState.cleanup !== 0) {
      throw new Error("finalization probe Case E: the queue row was not acknowledged; the case proves nothing.");
    }

    // Two concurrent replays, released together, with quota to spare — so only
    // the durable decision can be what stops them.
    coord = spawnDockerPsql(container);
    coord.child.stdin.write(`SELECT pg_advisory_lock(${FIN_BARRIER_KEY}); SELECT 'COORD_LOCKED';\n`);
    await waitUntil(() => /COORD_LOCKED/.test(coord.readOut()), PROBE_COORD_ACQUIRE_MS,
      "finalization probe Case E: coordinator failed to acquire the barrier lock.");
    w1 = spawnDockerPsql(container);
    w2 = spawnDockerPsql(container);
    w1.child.stdin.write(finWorkerSql(pathB, FIN_OK_BYTES)); w1.child.stdin.end();
    w2.child.stdin.write(finWorkerSql(pathB, FIN_OK_BYTES)); w2.child.stdin.end();
    await waitUntil(async () => (await countFinBarrierWaiters(container)) >= 2, PROBE_BARRIER_MS,
      "finalization probe Case E: both replays did not reach the barrier.");
    coord.child.stdin.write(
      `SELECT 'UNLOCK=' || pg_advisory_unlock(${FIN_BARRIER_KEY})::text; SELECT 'COORD_UNLOCKED';\n`);
    coord.child.stdin.end();
    const [crE, r1E, r2E] = await Promise.all([
      withTimeout(coord.done, PROBE_COORD_EXIT_MS, "finalization probe Case E coordinator exit"),
      withTimeout(w1.done, PROBE_WORKER_MS, "finalization probe Case E worker 1 exit"),
      withTimeout(w2.done, PROBE_WORKER_MS, "finalization probe Case E worker 2 exit"),
    ]);
    coord = null;
    w1 = null;
    w2 = null;
    if (crE.code !== 0 || crE.signal !== null || !/COORD_UNLOCKED/.test(crE.out)) {
      throw new Error(`finalization probe Case E: coordinator did not exit cleanly (code=${crE.code}).`);
    }
    for (const [nm, r] of [["replay 1", r1E], ["replay 2", r2E]]) {
      if (r.code !== 0 || r.signal !== null) {
        throw new Error(`finalization probe Case E: ${nm} did not exit cleanly (code=${r.code}).`);
      }
    }
    const outcomesE = [parseProbeOutcome(r1E), parseProbeOutcome(r2E)];
    if (outcomesE.some((o) => o !== "cleanup_queued")) {
      throw new Error(`finalization probe Case E expected both replays to report cleanup_queued, got: ${outcomesE.join(", ")}`);
    }
    const afterE = await finState(container, pathB);
    if (afterE.metadata !== 0) {
      throw new Error(`finalization probe Case E: a replay created metadata for a removed object (metadata=${afterE.metadata}).`);
    }
    if (afterE.used !== FIN_OK_BYTES * 2) {
      throw new Error(`finalization probe Case E: quota moved (used=${afterE.used}).`);
    }
    log("finalization probe Case E OK: after the cleanup was acknowledged, two concurrent replays still reported cleanup and created no metadata.");
  } catch (err) {
    await killPsql(w1);
    await killPsql(w2);
    await killPsql(coord);
    await killPsql(heldC);
    await killPsql(heldD);
    throw err;
  }

  // No session may still hold or await either lock class on a fresh connection.
  const finWaiters = await countFinBarrierWaiters(container);
  const rpcLocks = parseInt(await dbScalar(container,
    `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${FIN_LOCK_CLASSID};`), 10);
  if (finWaiters !== 0) throw new Error(`finalization probe: ${finWaiters} ungranted barrier waiter(s) remain.`);
  if (rpcLocks !== 0) throw new Error(`finalization probe: ${rpcLocks} finalization advisory lock(s) remain.`);

  const cleanup = await dockerPsql(container,
    `SELECT pg_advisory_unlock_all();\n` +
    `DELETE FROM public.attachment_cleanup_queue WHERE user_id='${FIN_PROBE_USER}';\n` +
    `DELETE FROM public.attachment_cleanup_tombstone WHERE user_id='${FIN_PROBE_USER}';\n` +
    `DELETE FROM auth.users WHERE id='${FIN_PROBE_USER}';\n`);
  if (cleanup.code !== 0) throw new Error(`finalization fixture cleanup failed: ${cleanup.err.trim()}`);
  const residual = (await dbScalar(container,
    `SELECT (SELECT count(*) FROM auth.users WHERE id='${FIN_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.papers WHERE user_id='${FIN_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.paper_attachments WHERE user_id='${FIN_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.attachment_cleanup_queue WHERE user_id='${FIN_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.attachment_cleanup_tombstone WHERE user_id='${FIN_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.user_storage_usage WHERE user_id='${FIN_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND (classid=${FIN_LOCK_CLASSID} ` +
    `OR (classid=${FIN_BARRIER_CLASSID} AND objid=${FIN_BARRIER_OBJID})));`))
    .split("|").map((s) => parseInt(s, 10));
  if (residual.some((c) => c !== 0)) {
    throw new Error(`finalization fixture not fully removed (user|papers|attachments|cleanup|tombstone|storage|advisory = ${residual.join("|")}).`);
  }
}

// ── ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001-CORRECTION-02 ────────────────────
// Paper deletion vs upload finalization. Its own user, papers and barrier key.
const PD_PROBE_USER = "cc000000-0000-0000-0000-0000000000cf";
const PD_PAPER_A = "cc000000-0000-0000-0000-0000000000f1";
const PD_PAPER_B = "cc000000-0000-0000-0000-0000000000f2";
// The advisory-lock class both writers take on a paper, from migration
// 20260904120000. Waiting on it is how this probe observes real blocking.
const PD_LOCK_CLASSID = 20260905;

/** A path under one of this probe's papers. */
function pdPath(paper, name) {
  return `${PD_PROBE_USER}/${paper}/${name}`;
}

/** Count sessions blocked on the per-paper serialization lock. */
async function countPaperLockWaiters(container) {
  const n = await dbScalar(
    container,
    `SELECT count(*) FROM pg_locks WHERE locktype='advisory' ` +
      `AND classid=${PD_LOCK_CLASSID} AND NOT granted;`,
  );
  return parseInt(n || "0", 10);
}

/** Become the probe user, exactly as a request does. */
function pdAuth(local) {
  return (
    `SELECT set_config('request.jwt.claims','{"sub":"${PD_PROBE_USER}","role":"authenticated"}', ${local});\n` +
    `SET${local ? " LOCAL" : ""} ROLE authenticated;\n`
  );
}

function pdFinalizeSql(paper, path, tag) {
  return (
    `SELECT '${tag}=' || status FROM public.finalize_attachment_upload(` +
    `'${paper}'::uuid, '${path}', 'probe.pdf', 'application/pdf', 16);\n`
  );
}

function pdDeleteSql(paper, tag) {
  return (
    `SELECT '${tag}=' || deleted_count::text || '/' || queued_count::text ` +
    `FROM public.delete_papers_with_attachment_cleanup(ARRAY['${paper}']::uuid[]);\n`
  );
}

/** Metadata rows | queue rows | tombstones, for one exact path. */
async function pdState(container, path) {
  const raw = await dbScalar(
    container,
    `SELECT (SELECT count(*) FROM public.paper_attachments WHERE file_path='${path}') || '|' || ` +
      `(SELECT count(*) FROM public.attachment_cleanup_queue WHERE file_path='${path}') || '|' || ` +
      `(SELECT count(*) FROM public.attachment_cleanup_tombstone WHERE file_path='${path}');`,
  );
  const [metadata, queued, tombstoned] = raw.split("|").map((s) => parseInt(s, 10));
  return { metadata, queued, tombstoned };
}

/**
 * True-concurrency paper-deletion / upload-finalization probe
 * (ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001-CORRECTION-02).
 *
 * Paper deletion queues the attachment paths it is about to destroy and then
 * deletes the papers. Between those two steps an upload can finalize: the
 * snapshot was taken without the new attachment, the cascade then takes it away,
 * and its Storage object is left with nothing recorded anywhere — the exact
 * orphan the feature exists to prevent, arriving through the one door the
 * feature had left open. The foreign key does not help: it makes the cascade
 * happen, it does not make the snapshot current.
 *
 * Both writers therefore take the same per-paper advisory lock — deletion before
 * its snapshot, finalization before its first read — so only two orderings
 * exist, and this asserts both of them with real concurrent sessions.
 *
 * Same fail-closed discipline as the probes above: every process tracked and
 * bounded, blocking proven through pg_locks rather than assumed from a sleep,
 * clean exits required, fixture proven absent afterwards.
 */
async function runPaperDeleteFinalizationProbe(container) {
  log("running true-concurrency paper-delete / finalization probe…");

  const setup = await dockerPsql(
    container,
    `INSERT INTO auth.users (id, email) VALUES ('${PD_PROBE_USER}','paper-delete-race@paperlume.test') ON CONFLICT DO NOTHING;\n` +
      `UPDATE public.user_entitlements SET storage_quota_bytes=1000000 WHERE user_id='${PD_PROBE_USER}';\n` +
      `INSERT INTO public.papers (id, user_id, title, keywords, insert_order) VALUES\n` +
      `  ('${PD_PAPER_A}','${PD_PROBE_USER}','Delete race A','[]'::jsonb,1),\n` +
      `  ('${PD_PAPER_B}','${PD_PROBE_USER}','Delete race B','[]'::jsonb,2)\n` +
      `ON CONFLICT (id) DO NOTHING;\n`,
  );
  if (setup.code !== 0) throw new Error(`paper-delete fixture setup failed: ${setup.err.trim()}`);

  const pathP1 = pdPath(PD_PAPER_A, "late-upload.pdf");
  const pathP2 = pdPath(PD_PAPER_B, "doomed-upload.pdf");

  let held = null;
  let waiter = null;
  try {
    // ── Case P1 — finalization wins the lock ────────────────────────────────
    // A finalization has committed metadata but has not committed its
    // transaction: precisely the window in which the old snapshot was taken.
    held = spawnDockerPsql(container);
    held.child.stdin.write(
      "BEGIN;\n" + pdAuth(true) + pdFinalizeSql(PD_PAPER_A, pathP1, "HELD") + "SELECT 'HELD_READY';\n",
    );
    await waitUntil(() => /HELD_READY/.test(held.readOut()), PROBE_WORKER_MS,
      "paper-delete probe P1: the held finalization never completed its work.");
    if (!/HELD=metadata_committed/.test(held.readOut())) {
      throw new Error("paper-delete probe P1: the held finalization did not commit metadata.");
    }

    waiter = spawnDockerPsql(container);
    waiter.child.stdin.write(pdAuth(false) + pdDeleteSql(PD_PAPER_A, "OUTCOME") + "SELECT 'WAITER_DONE';\n");
    waiter.child.stdin.end();
    await waitUntil(async () => (await countPaperLockWaiters(container)) >= 1, PROBE_BARRIER_MS,
      "paper-delete probe P1: the deletion never blocked on the per-paper lock.");
    if (/WAITER_DONE/.test(waiter.readOut())) {
      throw new Error("paper-delete probe P1: the deletion completed while the finalization was still in flight.");
    }

    held.child.stdin.write("COMMIT;\nSELECT 'HELD_COMMITTED';\n"); held.child.stdin.end();
    const [heldRes, waitRes] = await Promise.all([
      withTimeout(held.done, FIN_HOLD_MS, "paper-delete probe P1 held-transaction exit"),
      withTimeout(waiter.done, FIN_HOLD_MS, "paper-delete probe P1 waiter exit"),
    ]);
    held = null;
    waiter = null;
    if (heldRes.code !== 0 || heldRes.signal !== null || !/HELD_COMMITTED/.test(heldRes.out)) {
      throw new Error(`paper-delete probe P1: the held transaction did not commit cleanly (code=${heldRes.code}).`);
    }
    if (waitRes.code !== 0 || waitRes.signal !== null) {
      throw new Error(`paper-delete probe P1: the deletion did not exit cleanly (code=${waitRes.code}).`);
    }
    // The deletion's own report must show it SAW the late attachment.
    if (parseProbeOutcome(waitRes) !== "1/1") {
      throw new Error(`paper-delete probe P1: deletion reported "${parseProbeOutcome(waitRes)}", expected 1 paper and 1 queued path.`);
    }
    const p1 = await pdState(container, pathP1);
    if (p1.metadata !== 0 || p1.queued !== 1) {
      throw new Error(`paper-delete probe P1: expected the path queued and its metadata cascaded away, got metadata|queued|tombstoned = ${p1.metadata}|${p1.queued}|${p1.tombstoned}.`);
    }
    log("paper-delete probe P1 OK: deletion waited, then queued the attachment that finalized during its window.");

    // ── Case P2 — deletion wins the lock ────────────────────────────────────
    // The mirror. A deletion holds the lock with its papers already removed but
    // uncommitted; a finalization for a path under one of them must not be able
    // to commit metadata behind it.
    held = spawnDockerPsql(container);
    held.child.stdin.write(
      "BEGIN;\n" + pdAuth(true) + pdDeleteSql(PD_PAPER_B, "HELD") + "SELECT 'HELD_READY';\n",
    );
    await waitUntil(() => /HELD_READY/.test(held.readOut()), PROBE_WORKER_MS,
      "paper-delete probe P2: the held deletion never completed its work.");

    waiter = spawnDockerPsql(container);
    waiter.child.stdin.write(pdAuth(false) + pdFinalizeSql(PD_PAPER_B, pathP2, "OUTCOME") + "SELECT 'WAITER_DONE';\n");
    waiter.child.stdin.end();
    await waitUntil(async () => (await countPaperLockWaiters(container)) >= 1, PROBE_BARRIER_MS,
      "paper-delete probe P2: the finalization never blocked on the per-paper lock.");
    if (/WAITER_DONE/.test(waiter.readOut())) {
      throw new Error("paper-delete probe P2: the finalization completed while the deletion was still in flight.");
    }

    held.child.stdin.write("COMMIT;\nSELECT 'HELD_COMMITTED';\n"); held.child.stdin.end();
    const [heldRes2, waitRes2] = await Promise.all([
      withTimeout(held.done, FIN_HOLD_MS, "paper-delete probe P2 held-transaction exit"),
      withTimeout(waiter.done, FIN_HOLD_MS, "paper-delete probe P2 waiter exit"),
    ]);
    held = null;
    waiter = null;
    if (heldRes2.code !== 0 || heldRes2.signal !== null || !/HELD_COMMITTED/.test(heldRes2.out)) {
      throw new Error(`paper-delete probe P2: the held transaction did not commit cleanly (code=${heldRes2.code}).`);
    }
    if (waitRes2.code !== 0 || waitRes2.signal !== null) {
      throw new Error(`paper-delete probe P2: the finalization did not exit cleanly (code=${waitRes2.code}).`);
    }
    // It must NOT have created metadata under a paper that is gone, and it must
    // NOT have raised either — raising would abort without recording anything,
    // leaving the uploaded object as an orphan nothing knows about.
    if (parseProbeOutcome(waitRes2) !== "cleanup_queued") {
      throw new Error(`paper-delete probe P2: finalization reported "${parseProbeOutcome(waitRes2)}", expected cleanup_queued.`);
    }
    const p2 = await pdState(container, pathP2);
    if (p2.metadata !== 0 || p2.queued !== 1 || p2.tombstoned !== 1) {
      throw new Error(`paper-delete probe P2: expected no metadata and a durable cleanup decision, got metadata|queued|tombstoned = ${p2.metadata}|${p2.queued}|${p2.tombstoned}.`);
    }
    log("paper-delete probe P2 OK: the late finalization could not create metadata under a deleted paper, and its object was queued rather than orphaned.");
  } catch (err) {
    await killPsql(waiter);
    await killPsql(held);
    throw err;
  }

  const waiters = await countPaperLockWaiters(container);
  if (waiters !== 0) throw new Error(`paper-delete probe: ${waiters} ungranted paper-lock waiter(s) remain.`);

  const cleanup = await dockerPsql(container,
    `SELECT pg_advisory_unlock_all();\n` +
    `DELETE FROM public.attachment_cleanup_queue WHERE user_id='${PD_PROBE_USER}';\n` +
    `DELETE FROM public.attachment_cleanup_tombstone WHERE user_id='${PD_PROBE_USER}';\n` +
    `DELETE FROM auth.users WHERE id='${PD_PROBE_USER}';\n`);
  if (cleanup.code !== 0) throw new Error(`paper-delete fixture cleanup failed: ${cleanup.err.trim()}`);
  const residual = (await dbScalar(container,
    `SELECT (SELECT count(*) FROM auth.users WHERE id='${PD_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.papers WHERE user_id='${PD_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.paper_attachments WHERE user_id='${PD_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.attachment_cleanup_queue WHERE user_id='${PD_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.attachment_cleanup_tombstone WHERE user_id='${PD_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${PD_LOCK_CLASSID});`))
    .split("|").map((s) => parseInt(s, 10));
  if (residual.some((c) => c !== 0)) {
    throw new Error(`paper-delete fixture not fully removed (user|papers|attachments|queue|tombstone|advisory = ${residual.join("|")}).`);
  }
}

const CUT_PROBE_USER = "cc000000-0000-0000-0000-0000000000d0";
const CUT_PAPER = "cc000000-0000-0000-0000-0000000000d1";

const CUTOVER_MIGRATION =
  "supabase/migrations/20260904120000_add_recoverable_attachment_cleanup_queue.sql";

/**
 * The migration's OWN table-privilege statements, read out of the migration file
 * rather than restated here.
 *
 * This used to be a hand-written copy, and that is exactly how the Production
 * rollout defect survived CI: the copy said what the migration was MEANT to do,
 * so every probe that restored "the hardened posture" restored the intended one
 * and never noticed the migration itself was reaching a different one. Deriving
 * it means the probes below exercise the real statements, and a change to the
 * migration that this harness has not accounted for fails here rather than
 * passing quietly.
 *
 * Comments are stripped and statements split on `;`, then filtered to the
 * top-level GRANT/REVOKE statements naming the two tables. The count is pinned:
 * a parse that silently returned nothing would turn every `finally` restore into
 * a no-op and leave the local database permanently more permissive than a replay.
 */
function readCutoverGrantSql() {
  const src = readFileSync(resolve(ROOT, CUTOVER_MIGRATION), "utf8");
  const bare = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const stmts = bare
    .split(";")
    .map((stmt) => stmt.trim().replace(/\s+/g, " "))
    .filter(
      (stmt) =>
        /^(GRANT|REVOKE)\b/i.test(stmt) &&
        /\bON TABLE public\.(papers|paper_attachments)\b/i.test(stmt),
    );
  const EXPECTED = 6;
  if (stmts.length !== EXPECTED) {
    throw new Error(
      `cutover harness: expected ${EXPECTED} table GRANT/REVOKE statements in ` +
        `${CUTOVER_MIGRATION}, found ${stmts.length}. The migration's privilege ` +
        `surface changed — update this harness deliberately rather than loosening the check.`,
    );
  }
  for (const needle of ["public.papers", "public.paper_attachments"]) {
    if (!stmts.some((stmt) => stmt.includes(needle))) {
      throw new Error(`cutover harness: no GRANT/REVOKE parsed for ${needle}.`);
    }
  }
  return stmts.map((stmt) => `${stmt};`).join("\n") + "\n";
}

// The exact privilege set migration 20260904120000 revokes, and the exact grant
// it leaves standing. The probe restores this posture in its `finally`, so a
// failure anywhere cannot leave the local database more permissive than a real
// replay — and assertNoResidue's catalog fingerprint covers relacl, so it would
// notice if it did.
const CUT_REVOKE_SQL = readCutoverGrantSql();
const CUT_LEGACY_GRANT_SQL =
  "GRANT INSERT, UPDATE, DELETE ON TABLE public.paper_attachments TO authenticated;\n" +
  "GRANT DELETE ON TABLE public.papers TO authenticated;\n";
// Hosted Production's legacy ACL: the OLD Supabase platform default granted ALL
// on every new public table to all three API roles. A clean `db reset` never
// produces this, which is why the drift it causes was invisible to CI.
const CUT_PROD_LEGACY_ACL_SQL =
  "GRANT ALL ON TABLE public.papers TO anon, authenticated, service_role;\n" +
  "GRANT ALL ON TABLE public.paper_attachments TO anon, authenticated, service_role;\n";
// The cutover's own three statements, in the migration's order. None of the
// three modes is a preference, and neither is the order:
//
//   * `auth.users` SHARE ROW EXCLUSIVE is exactly what the queue and tombstone
//     foreign keys require, so taking it up front costs nothing and — the point
//     — leaves no later lock UPGRADE. Taken FIRST because a migration holding
//     the two downstream barriers and then requesting it deadlocks against an
//     account deletion holding `auth.users` and cascading toward them;
//   * `papers` SHARE, not stronger: a stronger mode would block the foreign-key
//     check of an in-flight `paper_attachments` INSERT;
//   * locking the child first would put an in-flight `DELETE FROM papers` —
//     which holds the parent and needs the child for its cascade — on the other
//     side of a cycle nobody can fix, because that transaction is a browser's
//     raw statement.
const CUT_BARRIER_SQL =
  "LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE;\n" +
  "LOCK TABLE public.papers IN SHARE MODE;\n" +
  "LOCK TABLE public.paper_attachments IN ACCESS EXCLUSIVE MODE;\n";

/** A path inside this probe's namespace. */
function cutPath(name) {
  return `${CUT_PROBE_USER}/${CUT_PAPER}/${name}`;
}

/** Become the probe user, exactly as a Data API request does. */
function cutAuth(local) {
  return (
    `SELECT set_config('request.jwt.claims','{"sub":"${CUT_PROBE_USER}","role":"authenticated"}', ${local});\n` +
    `SET${local ? " LOCAL" : ""} ROLE authenticated;\n`
  );
}

/** A direct, legacy-shaped metadata INSERT — what the old bundle issues. */
function cutLegacyInsertSql(name, tag) {
  return (
    `INSERT INTO public.paper_attachments (paper_id, user_id, file_path, file_name, file_type, size_bytes)\n` +
    `  VALUES ('${CUT_PAPER}','${CUT_PROBE_USER}','${cutPath(name)}','${name}','application/pdf',16);\n` +
    `SELECT '${tag}=inserted';\n`
  );
}

/** Sessions queued on a `papers` table lock, by mode. */
async function countPapersLockWaiters(container, mode) {
  const n = await dbScalar(
    container,
    `SELECT count(*) FROM pg_locks WHERE locktype='relation' ` +
      `AND relation='public.papers'::regclass AND mode='${mode}' AND NOT granted;`,
  );
  return parseInt(n || "0", 10);
}

/** Sessions queued on a `paper_attachments` table lock, by mode. */
async function countTableLockWaiters(container, mode) {
  const n = await dbScalar(
    container,
    `SELECT count(*) FROM pg_locks WHERE locktype='relation' ` +
      `AND relation='public.paper_attachments'::regclass AND mode='${mode}' AND NOT granted;`,
  );
  return parseInt(n || "0", 10);
}

/** Sessions queued on an `auth.users` table lock, by mode. */
async function countAuthLockWaiters(container, mode) {
  const n = await dbScalar(
    container,
    `SELECT count(*) FROM pg_locks WHERE locktype='relation' ` +
      `AND relation='auth.users'::regclass AND mode='${mode}' AND NOT granted;`,
  );
  return parseInt(n || "0", 10);
}

/** Sessions HOLDING a granted table lock on `rel`, by mode. */
async function countGrantedLocks(container, rel, mode) {
  const n = await dbScalar(
    container,
    `SELECT count(*) FROM pg_locks WHERE locktype='relation' ` +
      `AND relation='${rel}'::regclass AND mode='${mode}' AND granted;`,
  );
  return parseInt(n || "0", 10);
}

/** Run one statement as the probe user; report whether it was refused for privilege. */
async function cutDeniedAs(container, sql) {
  const r = await dockerPsql(container, cutAuth(false) + sql);
  return { denied: r.code !== 0 && /permission denied/i.test(r.err), detail: (r.err || r.out).trim().slice(0, 160) };
}

const PCUT_PAPER = "cc000000-0000-0000-0000-0000000000d2";

/** A direct, legacy-shaped parent deletion — what the old bundle issues. */
function pcutLegacyDeleteSql(tag) {
  return (
    `DELETE FROM public.papers WHERE id='${PCUT_PAPER}' AND user_id='${CUT_PROBE_USER}';\n` +
    `SELECT '${tag}=deleted';\n`
  );
}

/**
 * Parent-table cutover probe
 * (ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001-CORRECTION-04, Cases P-CUT-1/P-CUT-2).
 *
 * Attachment metadata has a second door: `paper_attachments.paper_id` cascades
 * from `papers`, so deleting the parent removes the child without any statement
 * naming it. Section 6d of the migration revokes DELETE and TRUNCATE on `papers`
 * to close it, and that revoke needs a barrier for exactly the reason the child's
 * did — with a sharper failure mode, because the Storage fence makes the stale
 * client's own cleanup FAIL where it used to succeed:
 *
 *   1. an old tab issues `DELETE FROM papers`; still uncommitted;
 *   2. the migration commits — the fence is live;
 *   3. the tab asks Storage to remove the binaries it read beforehand;
 *   4. the cascade has not committed, so live metadata still names them and the
 *      fence REFUSES;
 *   5. the deletion commits, taking the metadata with it.
 *
 *   → a binary no queue row describes, where without the migration step 4 would
 *     have succeeded and left nothing behind.
 *
 * This proves the barrier drains the parent writer (P-CUT-1) and that one
 * arriving behind it cannot overtake it and is refused when it runs (P-CUT-2),
 * with real sessions and `pg_locks` rather than a sleep.
 *
 * It runs INSIDE runMigrationCutoverProbe's try/finally, so the hardened posture
 * is restored on any path.
 */
async function runParentCutoverCases(container) {
  // A fresh attachment-bearing paper, so the deletion under test really does
  // cascade metadata rather than deleting an empty row.
  const setup = await dockerPsql(
    container,
    `INSERT INTO public.papers (id, user_id, title, keywords, insert_order) VALUES\n` +
      `  ('${PCUT_PAPER}','${CUT_PROBE_USER}','Parent cutover race','[]'::jsonb,2)\n` +
      `ON CONFLICT (id) DO NOTHING;\n` +
      // The ownership and quota triggers on paper_attachments derive the owner
      // from auth.uid(), so the claim has to be set even for an owner-side
      // fixture insert. Session-scoped (false) because psql runs in autocommit
      // and a transaction-local setting would not survive to the next statement.
      `SELECT set_config('request.jwt.claims','{"sub":"${CUT_PROBE_USER}","role":"authenticated"}', false);\n` +
      `INSERT INTO public.paper_attachments (paper_id, user_id, file_path, file_name, file_type, size_bytes)\n` +
      `  VALUES ('${PCUT_PAPER}','${CUT_PROBE_USER}','${CUT_PROBE_USER}/${PCUT_PAPER}/parent.pdf',\n` +
      `          'parent.pdf','application/pdf',16)\n` +
      `ON CONFLICT DO NOTHING;\n`,
  );
  if (setup.code !== 0) throw new Error(`parent cutover fixture failed: ${setup.err.trim()}`);

  let held = null;
  let cutover = null;
  let newcomer = null;
  try {
    // ── P-CUT-1: a direct paper DELETE already in flight ────────────────────
    held = spawnDockerPsql(container);
    held.child.stdin.write("BEGIN;\n" + cutAuth(true) + pcutLegacyDeleteSql("PA") + "SELECT 'PA_READY';\n");
    await waitUntil(() => /PA_READY/.test(held.readOut()), PROBE_WORKER_MS,
      "parent cutover P-CUT-1: the pre-cutover paper DELETE never reached the database.");
    if (!/PA=deleted/.test(held.readOut())) {
      throw new Error("parent cutover P-CUT-1: the pre-cutover paper DELETE did not succeed under the restored grant.");
    }

    cutover = spawnDockerPsql(container);
    cutover.child.stdin.write(
      "BEGIN;\n" + CUT_BARRIER_SQL + "SELECT 'PB_BARRIER';\n" +
        CUT_REVOKE_SQL + "COMMIT;\nSELECT 'PB_COMMITTED';\n",
    );
    cutover.child.stdin.end();
    // It must queue on the PARENT, which is the lock it takes first.
    await waitUntil(async () => (await countPapersLockWaiters(container, "ShareLock")) >= 1,
      PROBE_BARRIER_MS, "parent cutover P-CUT-1: the barrier never queued behind the in-flight paper deletion.");
    if (/PB_BARRIER/.test(cutover.readOut())) {
      throw new Error("parent cutover P-CUT-1: the barrier passed a transaction that had already deleted a paper.");
    }

    // ── P-CUT-2: a direct paper DELETE that arrives behind the barrier ──────
    newcomer = spawnDockerPsql(container);
    newcomer.child.stdin.write(cutAuth(false) + pcutLegacyDeleteSql("PC") + "SELECT 'PC_DONE';\n");
    newcomer.child.stdin.end();
    await waitUntil(async () => (await countPapersLockWaiters(container, "RowExclusiveLock")) >= 1,
      PROBE_BARRIER_MS, "parent cutover P-CUT-2: the newcomer did not queue behind the barrier.");
    if (/PC=deleted/.test(newcomer.readOut())) {
      throw new Error("parent cutover P-CUT-2: a paper deletion overtook the pending barrier.");
    }

    held.child.stdin.write("COMMIT;\nSELECT 'PA_COMMITTED';\n");
    held.child.stdin.end();
    const [aRes, bRes, cRes] = await Promise.all([
      withTimeout(held.done, FIN_HOLD_MS, "parent cutover: pre-cutover deleter exit"),
      withTimeout(cutover.done, FIN_HOLD_MS, "parent cutover: cutover exit"),
      withTimeout(newcomer.done, FIN_HOLD_MS, "parent cutover: newcomer exit"),
    ]);
    held = null;
    cutover = null;
    newcomer = null;

    if (aRes.code !== 0 || aRes.signal !== null || !/PA_COMMITTED/.test(aRes.out)) {
      throw new Error(`parent cutover P-CUT-1: the pre-cutover deleter did not commit cleanly (code=${aRes.code}).`);
    }
    if (bRes.code !== 0 || bRes.signal !== null || !/PB_BARRIER/.test(bRes.out) || !/PB_COMMITTED/.test(bRes.out)) {
      throw new Error(`parent cutover P-CUT-1: the cutover did not complete cleanly (code=${bRes.code}) — a deadlock here would show as a nonzero exit.`);
    }
    // P-CUT-2: refused, not merely blocked, and refused for lack of privilege —
    // which is only true if it re-planned against the post-cutover ACL.
    if (/PC=deleted/.test(cRes.out)) {
      throw new Error("parent cutover P-CUT-2: a paper DELETE authorized before the cutover committed after it.");
    }
    if (!/permission denied/i.test(cRes.err + cRes.out)) {
      throw new Error(`parent cutover P-CUT-2: the queued deletion failed for the wrong reason: ${(cRes.err || cRes.out).trim().slice(0, 200)}`);
    }
    log("cutover probe P-CUT-1/2 OK: the barrier waited for the in-flight paper deletion, and the one queued behind it was refused by the new privileges.");

    // ── P-CUT-3/4: post-cutover parent DML is closed ───────────────────────
    const parentPaper = "cc000000-0000-0000-0000-0000000000d3";
    const seed = await dockerPsql(container,
      `INSERT INTO public.papers (id, user_id, title, keywords, insert_order) VALUES\n` +
      `  ('${parentPaper}','${CUT_PROBE_USER}','Post cutover','[]'::jsonb,3)\n` +
      `ON CONFLICT (id) DO NOTHING;\n`);
    if (seed.code !== 0) throw new Error(`parent cutover: post-cutover fixture failed: ${seed.err.trim()}`);
    for (const [label, sql] of [
      ["P-CUT-3 DELETE", `DELETE FROM public.papers WHERE id='${parentPaper}';\n`],
      ["P-CUT-4 TRUNCATE", `TRUNCATE public.papers CASCADE;\n`],
    ]) {
      const r = await cutDeniedAs(container, sql);
      if (!r.denied) throw new Error(`parent cutover ${label}: a direct authenticated statement was NOT refused (${r.detail}).`);
    }
    // …while ordinary paper authoring is untouched. Revoking the lifecycle's
    // door must not have taken the product's front door with it.
    const authoring = await dockerPsql(container, cutAuth(false) +
      `UPDATE public.papers SET title='edited' WHERE id='${parentPaper}';\n` +
      `SELECT 'PSELECT=' || count(*)::text FROM public.papers WHERE id='${parentPaper}';\n`);
    if (authoring.code !== 0 || !/PSELECT=1/.test(authoring.out)) {
      throw new Error(`parent cutover: SELECT/UPDATE on papers did not survive the revoke: ${(authoring.err || authoring.out).trim().slice(0, 200)}`);
    }
    // P-CUT-5: the authoritative path still deletes and still records first.
    const rpc = await dockerPsql(container, cutAuth(false) +
      `SELECT 'PPAPERS=' || deleted_count::text || '/' || queued_count::text\n` +
      `  FROM public.delete_papers_with_attachment_cleanup(ARRAY['${parentPaper}']::uuid[]);\n`);
    if (rpc.code !== 0 || !rpc.out.includes("PPAPERS=1/0")) {
      throw new Error(`parent cutover P-CUT-5: the lifecycle RPC could not delete a paper after the revoke (${(rpc.err || rpc.out).trim().slice(0, 200)}).`);
    }
    log("cutover probe P-CUT-3/4/5 OK: direct paper DELETE and TRUNCATE refused, SELECT/INSERT/UPDATE preserved, lifecycle deletion still works.");
  } catch (err) {
    await killPsql(newcomer);
    await killPsql(cutover);
    await killPsql(held);
    throw err;
  }
}

const ACUT_USER_A = "cc000000-0000-0000-0000-0000000000d4";
const ACUT_USER_B = "cc000000-0000-0000-0000-0000000000d5";
const ACUT_USER_C = "cc000000-0000-0000-0000-0000000000d6";
const ACUT_PAPER_A = "cc000000-0000-0000-0000-0000000000d7";
const ACUT_PAPER_C = "cc000000-0000-0000-0000-0000000000d8";

/**
 * A disposable Auth user whose rows really do reach the paper and attachment
 * cascades — so a `DELETE FROM auth.users` on it has to traverse both of the
 * tables the cutover barriers cover, rather than deleting an isolated row.
 */
function acutFixtureSql(user, paper) {
  return (
    `INSERT INTO auth.users (id, email) VALUES ('${user}','${user}@paperlume.test')\n` +
    `ON CONFLICT DO NOTHING;\n` +
    `UPDATE public.user_entitlements SET storage_quota_bytes=1000000 WHERE user_id='${user}';\n` +
    `INSERT INTO public.papers (id, user_id, title, keywords, insert_order) VALUES\n` +
    `  ('${paper}','${user}','Auth cutover race','[]'::jsonb,1)\n` +
    `ON CONFLICT (id) DO NOTHING;\n` +
    // The ownership and quota triggers derive the owner from auth.uid(), so the
    // claim has to be set even for an owner-side fixture insert. Session-scoped,
    // because psql runs in autocommit.
    `SELECT set_config('request.jwt.claims','{"sub":"${user}","role":"authenticated"}', false);\n` +
    `INSERT INTO public.paper_attachments (paper_id, user_id, file_path, file_name, file_type, size_bytes)\n` +
    `  VALUES ('${paper}','${user}','${user}/${paper}/auth.pdf','auth.pdf','application/pdf',16)\n` +
    `ON CONFLICT DO NOTHING;\n` +
    `SELECT set_config('request.jwt.claims', NULL, false);\n`
  );
}

/** Everything a disposable Auth user owns, across the four cascading tables. */
async function acutFootprint(container, user) {
  return (await dbScalar(container,
    `SELECT (SELECT count(*) FROM auth.users WHERE id='${user}') || '|' || ` +
    `(SELECT count(*) FROM public.papers WHERE user_id='${user}') || '|' || ` +
    `(SELECT count(*) FROM public.paper_attachments WHERE user_id='${user}') || '|' || ` +
    `(SELECT count(*) FROM public.attachment_cleanup_queue WHERE user_id='${user}') || '|' || ` +
    `(SELECT count(*) FROM public.attachment_cleanup_tombstone WHERE user_id='${user}');`))
    .split("|").map((n) => parseInt(n, 10));
}

/**
 * Auth/account-deletion cutover probe
 * (ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001-CORRECTION-05, Cases A-CUT-1…4).
 *
 * The queue and tombstone tables created by this migration both carry
 * `user_id ... REFERENCES auth.users(id) ON DELETE CASCADE`, and in PostgreSQL
 * adding a foreign key takes SHARE ROW EXCLUSIVE on the REFERENCED table. So the
 * migration always needed a lock on `auth.users` — it simply used to take it
 * late and implicitly, hundreds of lines after it had already taken the `papers`
 * and `paper_attachments` barriers. That is a lock-order inversion, and against
 * an ordinary account deletion it is a real deadlock, not a theoretical one:
 *
 *     ERROR:  deadlock detected
 *     DETAIL:  Process A waits for ShareRowExclusiveLock on auth.users;
 *              Process B waits for RowExclusiveLock on paper_attachments.
 *
 * `auth.users` is now the migration's FIRST lock, so the migration waits
 * UPSTREAM while holding nothing, instead of waiting upstream while holding the
 * downstream tables an Auth cascade needs. This proves that with real sessions
 * and `pg_locks`, never a sleep:
 *
 *   A-CUT-1  an account deletion already in progress finishes; the migration
 *            queues on `auth.users` and has NOT taken `papers`;
 *   A-CUT-2  an account deletion arriving behind the pending barrier cannot
 *            overtake it — and is DELAYED, not refused: unlike a stale client's
 *            paper delete, account deletion is not a privilege being revoked;
 *   A-CUT-3  account deletion still works normally once the cutover exists;
 *   A-CUT-4  no lock, process or fixture residue.
 *
 * It runs INSIDE runMigrationCutoverProbe's try/finally, so the hardened posture
 * is restored on every path.
 */
async function runAuthCutoverCases(container) {
  const setup = await dockerPsql(container,
    acutFixtureSql(ACUT_USER_A, ACUT_PAPER_A) + acutFixtureSql(ACUT_USER_C, ACUT_PAPER_C) +
    `INSERT INTO auth.users (id, email) VALUES ('${ACUT_USER_B}','${ACUT_USER_B}@paperlume.test')\n` +
    `ON CONFLICT DO NOTHING;\n`);
  if (setup.code !== 0) throw new Error(`auth cutover fixture failed: ${setup.err.trim()}`);
  for (const [user, label] of [[ACUT_USER_A, "A-CUT-1"], [ACUT_USER_C, "A-CUT-3"]]) {
    const f = await acutFootprint(container, user);
    if (f[0] !== 1 || f[1] !== 1 || f[2] !== 1) {
      throw new Error(`auth cutover ${label}: the disposable user does not reach both cascades (user|papers|attachments|queue|tombstone = ${f.join("|")}).`);
    }
  }

  let deleter = null;   // A — an account deletion already in progress.
  let cutover = null;   // B — the migration's barrier + revoke.
  let newcomer = null;  // C — an account deletion that arrives behind the barrier.
  try {
    // ── A-CUT-1: an account deletion already in progress ────────────────────
    // A real `DELETE FROM auth.users` runs its cascades inside the one statement
    // that takes the Auth writer lock, so there is no natural pause between the
    // two. The explicit ROW EXCLUSIVE is a deterministic auxiliary blocker that
    // holds the session at EXACTLY the lock state that statement reaches — and
    // the cascading DELETE below is then the real one, really traversing
    // `papers` and `paper_attachments`.
    deleter = spawnDockerPsql(container);
    deleter.child.stdin.write(
      "BEGIN;\nLOCK TABLE auth.users IN ROW EXCLUSIVE MODE;\nSELECT 'AA_HOLDS_AUTH';\n");
    await waitUntil(() => /AA_HOLDS_AUTH/.test(deleter.readOut()), PROBE_WORKER_MS,
      "auth cutover A-CUT-1: the account deletion never took the Auth writer lock.");

    cutover = spawnDockerPsql(container);
    cutover.child.stdin.write(
      "BEGIN;\n" + CUT_BARRIER_SQL + "SELECT 'AB_BARRIER';\n" +
        CUT_REVOKE_SQL + "COMMIT;\nSELECT 'AB_COMMITTED';\n");
    cutover.child.stdin.end();

    // It must queue UPSTREAM, on the first lock in the order.
    await waitUntil(async () => (await countAuthLockWaiters(container, "ShareRowExclusiveLock")) >= 1,
      PROBE_BARRIER_MS, "auth cutover A-CUT-1: the barrier never queued on auth.users.");
    if (/AB_BARRIER/.test(cutover.readOut())) {
      throw new Error("auth cutover A-CUT-1: the barrier passed an open Auth writer.");
    }
    // …and it must be holding NOTHING downstream while it waits. This is the
    // whole correction: with the old order the migration would already own the
    // `papers` SHARE and the `paper_attachments` ACCESS EXCLUSIVE here, which is
    // precisely what the account deletion's cascade needs next.
    const downstream = (await countGrantedLocks(container, "public.papers", "ShareLock"))
      + (await countGrantedLocks(container, "public.paper_attachments", "AccessExclusiveLock"));
    if (downstream !== 0) {
      throw new Error(`auth cutover A-CUT-1: the barrier is holding ${downstream} downstream lock(s) while waiting upstream — that is the deadlock shape this case exists to exclude.`);
    }

    // ── A-CUT-2: an Auth writer arriving behind the pending barrier ─────────
    // ROW EXCLUSIVE is self-compatible, so C is NOT blocked by A. If it runs, it
    // ran by overtaking the pending SHARE ROW EXCLUSIVE — which would mean the
    // barrier can be starved indefinitely.
    newcomer = spawnDockerPsql(container);
    newcomer.child.stdin.write(
      `DELETE FROM auth.users WHERE id='${ACUT_USER_B}';\nSELECT 'AC_DELETED';\n`);
    newcomer.child.stdin.end();
    await waitUntil(async () => (await countAuthLockWaiters(container, "RowExclusiveLock")) >= 1,
      PROBE_BARRIER_MS, "auth cutover A-CUT-2: the newcomer did not queue behind the barrier.");
    if (/AC_DELETED/.test(newcomer.readOut())) {
      throw new Error("auth cutover A-CUT-2: an Auth writer overtook the pending barrier.");
    }

    // ── Release A: the real cascading deletion, then commit ─────────────────
    deleter.child.stdin.write(
      `DELETE FROM auth.users WHERE id='${ACUT_USER_A}';\nSELECT 'AA_DELETED';\n` +
      "COMMIT;\nSELECT 'AA_COMMITTED';\n");
    deleter.child.stdin.end();
    const [aRes, bRes, cRes] = await Promise.all([
      withTimeout(deleter.done, FIN_HOLD_MS, "auth cutover: account deletion exit"),
      withTimeout(cutover.done, FIN_HOLD_MS, "auth cutover: cutover exit"),
      withTimeout(newcomer.done, FIN_HOLD_MS, "auth cutover: newcomer exit"),
    ]);
    deleter = null;
    cutover = null;
    newcomer = null;

    // No deadlock anywhere — the failure this correction exists to remove would
    // surface as exactly this string, in whichever session Postgres chose.
    const all = aRes.out + aRes.err + bRes.out + bRes.err + cRes.out + cRes.err;
    if (/deadlock detected/i.test(all)) {
      throw new Error(`auth cutover: DEADLOCK between the migration and account deletion — ${all.match(/DETAIL:[^\n]*/)?.[0] || ""}`);
    }
    if (aRes.code !== 0 || aRes.signal !== null || !/AA_DELETED/.test(aRes.out) || !/AA_COMMITTED/.test(aRes.out)) {
      throw new Error(`auth cutover A-CUT-1: the in-flight account deletion did not complete cleanly (code=${aRes.code}).`);
    }
    if (bRes.code !== 0 || bRes.signal !== null || !/AB_BARRIER/.test(bRes.out) || !/AB_COMMITTED/.test(bRes.out)) {
      throw new Error(`auth cutover A-CUT-1: the cutover did not complete cleanly (code=${bRes.code}).`);
    }
    // A-CUT-2: delayed, then SUCCESSFUL. Account deletion is not a revoked
    // privilege, so unlike P-CUT-2 the right outcome here is that it works.
    if (cRes.code !== 0 || cRes.signal !== null || !/AC_DELETED/.test(cRes.out)) {
      throw new Error(`auth cutover A-CUT-2: the queued account deletion did not succeed after the cutover (code=${cRes.code}): ${(cRes.err || cRes.out).trim().slice(0, 200)}`);
    }

    // Both deletions really removed everything they cascaded to.
    for (const [user, label] of [[ACUT_USER_A, "A-CUT-1"], [ACUT_USER_B, "A-CUT-2"]]) {
      const f = await acutFootprint(container, user);
      if (f.some((c) => c !== 0)) {
        throw new Error(`auth cutover ${label}: the account deletion left rows behind (user|papers|attachments|queue|tombstone = ${f.join("|")}).`);
      }
    }
    log("cutover probe A-CUT-1/2 OK: the barrier waited UPSTREAM on auth.users holding no downstream lock, the in-flight account deletion cascaded and committed, no deadlock, and the Auth writer queued behind the barrier was delayed and then succeeded.");

    // ── A-CUT-3: account deletion is normal once the cutover exists ─────────
    // The posture is now the post-migration one (the cutover above committed the
    // revoke), so this is account deletion against the shipped world.
    const posture = await dbScalar(container,
      `SELECT has_table_privilege('authenticated','public.paper_attachments','INSERT')::text || '|' || ` +
      `has_table_privilege('authenticated','public.papers','DELETE')::text;`);
    if (posture !== "false|false") {
      throw new Error(`auth cutover A-CUT-3: expected the post-cutover posture before this case, got ${posture}.`);
    }
    const after = await dockerPsql(container,
      `DELETE FROM auth.users WHERE id='${ACUT_USER_C}';\nSELECT 'AD_DELETED';\n`);
    if (after.code !== 0 || !/AD_DELETED/.test(after.out)) {
      throw new Error(`auth cutover A-CUT-3: account deletion failed after the cutover: ${(after.err || after.out).trim().slice(0, 200)}`);
    }
    const f = await acutFootprint(container, ACUT_USER_C);
    if (f.some((c) => c !== 0)) {
      throw new Error(`auth cutover A-CUT-3: post-cutover account deletion left rows behind (user|papers|attachments|queue|tombstone = ${f.join("|")}).`);
    }
    log("cutover probe A-CUT-3 OK: account deletion still removes the Auth user and every cascading row after the cutover — the Storage sweep it performs is unchanged and lives in the Edge function, untouched here.");

    // ── A-CUT-4: no lock residue on any of the three tables ────────────────
    const residue =
      (await countAuthLockWaiters(container, "ShareRowExclusiveLock"))
      + (await countAuthLockWaiters(container, "RowExclusiveLock"))
      + (await countPapersLockWaiters(container, "ShareLock"))
      + (await countPapersLockWaiters(container, "RowExclusiveLock"))
      + (await countTableLockWaiters(container, "AccessExclusiveLock"))
      + (await countTableLockWaiters(container, "RowExclusiveLock"));
    if (residue !== 0) {
      throw new Error(`auth cutover A-CUT-4: ${residue} ungranted relation-lock waiter(s) remain on auth.users/papers/paper_attachments.`);
    }
    log("cutover probe A-CUT-4 OK: no relation-lock waiters remain on auth.users, papers or paper_attachments.");
  } catch (err) {
    await killPsql(newcomer);
    await killPsql(cutover);
    await killPsql(deleter);
    throw err;
  } finally {
    // Deterministic cleanup: whatever the outcome, none of the three disposable
    // users may survive this probe.
    await dockerPsql(container,
      `DELETE FROM auth.users WHERE id IN ('${ACUT_USER_A}','${ACUT_USER_B}','${ACUT_USER_C}');\n`);
  }
}

const MCUT_USER = "cc000000-0000-0000-0000-0000000000e0";
const MCUT_KEEP = "cc000000-0000-0000-0000-0000000000e1";
const MCUT_DISCARD = "cc000000-0000-0000-0000-0000000000e2";

// The lock sequence of `merge_exact_duplicates` AS DEPLOYED IN PRODUCTION TODAY,
// statement for statement, verified against the live Production catalog (which
// contains no LOCK TABLE of any kind): read `papers` (ACCESS SHARE), write
// `paper_attachments` (ROW EXCLUSIVE), and only THEN `DELETE FROM papers`
// (ROW EXCLUSIVE). Child before parent. Reproduced with raw statements rather
// than by installing the old function body, so the negative control cannot
// perturb the catalog the residue check fingerprints.
function mcutLegacyChildSql() {
  return (
    `SELECT count(*) FROM public.papers WHERE id IN ('${MCUT_KEEP}','${MCUT_DISCARD}');\n` +
    `UPDATE public.paper_attachments SET paper_id='${MCUT_KEEP}' WHERE paper_id='${MCUT_DISCARD}';\n` +
    `SELECT 'MA_HOLDS_CHILD';\n`
  );
}
function mcutLegacyParentSql() {
  return `DELETE FROM public.papers WHERE id='${MCUT_DISCARD}';\nSELECT 'MA_DELETED';\n`;
}

// Phase 2's gate, mirrored from
// `20260904120000_add_recoverable_attachment_cleanup_queue.sql` section 0. The
// migration's own copy is authoritative — a clean replay is what proves it
// parses and passes; this copy is what proves it FIRES.
const MCUT_PHASE_GATE_SQL =
  "DO $g$\nDECLARE v_src TEXT; v_pids TEXT; v_count INTEGER;\nBEGIN\n" +
  "  SELECT pg_get_functiondef('public.merge_exact_duplicates(uuid,uuid[])'::regprocedure) INTO v_src;\n" +
  "  IF position('LOCK TABLE public.papers IN ROW EXCLUSIVE MODE' IN v_src) = 0\n" +
  "     OR position('LOCK TABLE public.papers IN ROW EXCLUSIVE MODE' IN v_src)\n" +
  "        > position('UPDATE paper_attachments' IN v_src) THEN\n" +
  "    RAISE EXCEPTION 'attachment_cleanup: PHASE 1 MISSING.';\n" +
  "  END IF;\n" +
  "  SELECT count(*) INTO v_count FROM auth.users;\n" +
  "  IF v_count > 0 THEN\n" +
  "    SELECT count(*), string_agg(DISTINCT a.pid::text, ', ' ORDER BY a.pid::text) INTO v_count, v_pids\n" +
  "      FROM pg_stat_activity a\n" +
  "     WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()\n" +
  "       AND a.backend_type = 'client backend' AND a.xact_start IS NOT NULL\n" +
  "       AND a.xact_start < (SELECT b.xact_start FROM pg_stat_activity b WHERE b.pid = pg_backend_pid());\n" +
  "    IF v_count > 0 THEN\n" +
  "      RAISE EXCEPTION 'attachment_cleanup: DRAIN NOT PROVEN. % older client transaction(s) (pid %).', v_count, v_pids;\n" +
  "    END IF;\n" +
  "  END IF;\nEND\n$g$;\n";

/** The merge fixture: a keep paper, a discard paper, and an attachment on the discard. */
function mcutFixtureSql() {
  return (
    `INSERT INTO auth.users (id, email) VALUES ('${MCUT_USER}','merge-cutover@paperlume.test')\n` +
    `ON CONFLICT DO NOTHING;\n` +
    `UPDATE public.user_entitlements SET storage_quota_bytes=1000000 WHERE user_id='${MCUT_USER}';\n` +
    `INSERT INTO public.papers (id, user_id, title, keywords, insert_order) VALUES\n` +
    `  ('${MCUT_KEEP}','${MCUT_USER}','Merge keep','[]'::jsonb,1),\n` +
    `  ('${MCUT_DISCARD}','${MCUT_USER}','Merge discard','[]'::jsonb,2)\n` +
    `ON CONFLICT (id) DO NOTHING;\n` +
    `SELECT set_config('request.jwt.claims','{"sub":"${MCUT_USER}","role":"authenticated"}', false);\n` +
    `INSERT INTO public.paper_attachments (paper_id, user_id, file_path, file_name, file_type, size_bytes)\n` +
    `  VALUES ('${MCUT_DISCARD}','${MCUT_USER}','${MCUT_USER}/${MCUT_DISCARD}/merge.pdf',\n` +
    `          'merge.pdf','application/pdf',16)\n` +
    `ON CONFLICT DO NOTHING;\n` +
    `SELECT set_config('request.jwt.claims', NULL, false);\n`
  );
}

/** Where the attachment lives, and what cleanup state exists for this user. */
async function mcutState(container) {
  return (await dbScalar(container,
    `SELECT (SELECT count(*) FROM public.papers WHERE id='${MCUT_KEEP}') || '|' || ` +
    `(SELECT count(*) FROM public.papers WHERE id='${MCUT_DISCARD}') || '|' || ` +
    `(SELECT count(*) FROM public.paper_attachments WHERE user_id='${MCUT_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.paper_attachments WHERE paper_id='${MCUT_KEEP}') || '|' || ` +
    `(SELECT count(*) FROM public.attachment_cleanup_queue WHERE user_id='${MCUT_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.attachment_cleanup_tombstone WHERE user_id='${MCUT_USER}');`))
    .split("|").map((n) => parseInt(n, 10));
}

/**
 * Legacy-merge cutover probe
 * (ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001-CORRECTION-06, Cases M-CUT-1…4).
 *
 * CORRECTION-04 derived the cutover order against the writers this schema will
 * have. It has one more that it HAS: `merge_exact_duplicates` as deployed in
 * Production takes no table lock at all, reaches `papers` under ACCESS SHARE and
 * ROW SHARE, writes `paper_attachments`, and only then issues
 * `DELETE FROM papers`. Child before parent — the opposite of a stale bundle's
 * direct paper deletion. Two historical writers with opposite orders on the same
 * two tables means no single transaction holding both locks is safe against
 * both: parent-first cycles with the merge, child-first cycles with the paper
 * delete. And function replacement is no escape — `CREATE OR REPLACE FUNCTION`
 * does not wait for in-flight executions (measured: it returned in 32 ms while
 * the old call was parked mid-body, and that call still completed with the OLD
 * body).
 *
 * Hence two separately committed phases and an observed drain. This proves the
 * whole argument with real sessions and `pg_locks`:
 *
 *   M-CUT-1  the superseded one-transaction topology really does deadlock —
 *            a negative control that FAILS the suite if it cannot reproduce it;
 *   M-CUT-2  under the corrected architecture the same interleaving is REFUSED
 *            by the phase gate before a single lock is taken, and the legacy
 *            merge then completes with correct data;
 *   M-CUT-3  a merge that begins after the boundary uses the parent-first body
 *            and coexists with the barrier;
 *   M-CUT-4  no lock, process or fixture residue.
 */
async function runMergeCutoverCases(container) {
  const setup = await dockerPsql(container, mcutFixtureSql());
  if (setup.code !== 0) throw new Error(`merge cutover fixture failed: ${setup.err.trim()}`);
  const before = await mcutState(container);
  if (before[0] !== 1 || before[1] !== 1 || before[2] !== 1) {
    throw new Error(`merge cutover: fixture is not the expected keep/discard/attachment shape (${before.join("|")}).`);
  }

  let legacy = null;
  let cutover = null;
  try {
    // ── M-CUT-1: negative control — the superseded topology ────────────────
    legacy = spawnDockerPsql(container);
    legacy.child.stdin.write("BEGIN;\n" + mcutLegacyChildSql());
    await waitUntil(() => /MA_HOLDS_CHILD/.test(legacy.readOut()), PROBE_WORKER_MS,
      "merge cutover M-CUT-1: the legacy merge never re-parented the attachment.");
    const childHeld = await dbScalar(container,
      `SELECT count(*) FROM pg_locks WHERE locktype='relation' ` +
      `AND relation='public.paper_attachments'::regclass AND mode='RowExclusiveLock' AND granted;`);
    if (parseInt(childHeld || "0", 10) < 1) {
      throw new Error("merge cutover M-CUT-1: the legacy merge does not hold the child write lock — the control cannot reproduce anything.");
    }

    // The CORRECTION-05 barrier, with NO phase gate — i.e. the architecture as
    // it stood before this correction.
    cutover = spawnDockerPsql(container);
    cutover.child.stdin.end(
      "BEGIN;\n" + CUT_BARRIER_SQL + "SELECT 'MB_BARRIER';\nCOMMIT;\nSELECT 'MB_COMMITTED';\n");
    await waitUntil(async () => (await countTableLockWaiters(container, "AccessExclusiveLock")) >= 1,
      PROBE_BARRIER_MS, "merge cutover M-CUT-1: the barrier never queued on paper_attachments.");

    // Now the legacy body's next statement: the parent delete it has always done.
    legacy.child.stdin.write(mcutLegacyParentSql());
    const [mbRes] = await Promise.all([
      withTimeout(cutover.done, FIN_HOLD_MS, "merge cutover M-CUT-1: cutover exit"),
    ]);
    cutover = null;
    const control = mbRes.out + mbRes.err;
    if (!/deadlock detected/i.test(control)) {
      throw new Error(
        "merge cutover M-CUT-1: the negative control did NOT reproduce the deadlock, so it proves nothing. " +
        "Either the legacy ordering or the barrier changed; re-derive before trusting any case below. " +
        `Cutover session said: ${control.trim().slice(0, 300)}`);
    }
    const detail = (control.match(/DETAIL:[\s\S]*?(?=\nHINT|\nERROR|$)/i) || [""])[0].replace(/\s+/g, " ").trim();
    log(`cutover probe M-CUT-1 OK (negative control REPRODUCED the superseded deadlock): ${detail.slice(0, 220)}`);

    // The legacy merge itself survived — Postgres chose the migration as victim.
    legacy.child.stdin.end("COMMIT;\nSELECT 'MA_COMMITTED';\n");
    const maRes = await withTimeout(legacy.done, FIN_HOLD_MS, "merge cutover M-CUT-1: legacy merge exit");
    legacy = null;
    if (maRes.code !== 0 || !/MA_COMMITTED/.test(maRes.out)) {
      throw new Error(`merge cutover M-CUT-1: the legacy merge did not commit (code=${maRes.code}).`);
    }

    // ── M-CUT-2: the corrected architecture, same interleaving ─────────────
    // Re-create the discard paper so the same race can be run again.
    const reseed = await dockerPsql(container,
      `INSERT INTO public.papers (id, user_id, title, keywords, insert_order) VALUES\n` +
      `  ('${MCUT_DISCARD}','${MCUT_USER}','Merge discard','[]'::jsonb,2)\n` +
      `ON CONFLICT (id) DO NOTHING;\n` +
      `UPDATE public.paper_attachments SET paper_id='${MCUT_DISCARD}' WHERE user_id='${MCUT_USER}';\n`);
    if (reseed.code !== 0) throw new Error(`merge cutover: could not reseed for M-CUT-2: ${reseed.err.trim()}`);

    legacy = spawnDockerPsql(container);
    legacy.child.stdin.write("BEGIN;\n" + mcutLegacyChildSql());
    await waitUntil(() => /MA_HOLDS_CHILD/.test(legacy.readOut()), PROBE_WORKER_MS,
      "merge cutover M-CUT-2: the legacy merge never re-parented the attachment.");

    // Phase 2 as it now stands: the gate runs BEFORE any lock.
    const gated = await dockerPsql(container,
      "BEGIN;\n" + MCUT_PHASE_GATE_SQL + CUT_BARRIER_SQL + "COMMIT;\n");
    if (gated.code === 0) {
      throw new Error("merge cutover M-CUT-2: the cutover was NOT refused while a legacy merge was in flight — the phase gate did not fire.");
    }
    if (!/DRAIN NOT PROVEN/i.test(gated.err + gated.out)) {
      throw new Error(`merge cutover M-CUT-2: the cutover failed for the wrong reason: ${(gated.err || gated.out).trim().slice(0, 250)}`);
    }
    if (/deadlock detected/i.test(gated.err + gated.out)) {
      throw new Error("merge cutover M-CUT-2: the cutover DEADLOCKED instead of refusing — the gate must run before the barrier.");
    }

    // The legacy merge is unaffected and completes correctly.
    legacy.child.stdin.write(mcutLegacyParentSql());
    legacy.child.stdin.end("COMMIT;\nSELECT 'MA2_COMMITTED';\n");
    const ma2 = await withTimeout(legacy.done, FIN_HOLD_MS, "merge cutover M-CUT-2: legacy merge exit");
    legacy = null;
    if (ma2.code !== 0 || !/MA2_COMMITTED/.test(ma2.out) || !/MA_DELETED/.test(ma2.out)) {
      throw new Error(`merge cutover M-CUT-2: the legacy merge did not complete cleanly (code=${ma2.code}).`);
    }
    // No half-merge: the kept paper survives, the discard is gone, and the
    // attachment moved with it rather than cascading away.
    const after = await mcutState(container);
    const [keep, discard, attachTotal, attachOnKeep, queued, tombstoned] = after;
    if (keep !== 1 || discard !== 0) {
      throw new Error(`merge cutover M-CUT-2: half-merge — expected the keep paper present and the discard gone, got keep=${keep} discard=${discard}.`);
    }
    if (attachTotal !== 1 || attachOnKeep !== 1) {
      throw new Error(`merge cutover M-CUT-2: attachment metadata was lost or left behind (total=${attachTotal}, on-keep=${attachOnKeep}) — a cascade took it.`);
    }
    if (queued !== 0 || tombstoned !== 0) {
      throw new Error(`merge cutover M-CUT-2: cleanup state was manufactured for a merge that stranded nothing (queue=${queued}, tombstone=${tombstoned}).`);
    }
    log("cutover probe M-CUT-2 OK: with a legacy merge in flight the cutover was REFUSED by the phase gate before taking a lock — no deadlock — and the merge then completed with the attachment on the kept paper, no half-merge and no cleanup row invented.");

    // ── M-CUT-3: a merge that begins after the boundary ────────────────────
    // The installed body is phase 1's, which takes the parent lock first. It
    // therefore conforms to the barrier's order and cannot cycle with it.
    const conforms = await dbScalar(container,
      `SELECT (position('LOCK TABLE public.papers IN ROW EXCLUSIVE MODE' IN v) > 0 ` +
      `AND position('LOCK TABLE public.papers IN ROW EXCLUSIVE MODE' IN v) ` +
      `  < position('UPDATE paper_attachments' IN v))::text ` +
      `FROM (SELECT pg_get_functiondef('public.merge_exact_duplicates(uuid,uuid[])'::regprocedure) v) t;`);
    if (conforms !== "true") {
      throw new Error("merge cutover M-CUT-3: the installed merge does not lock papers before re-parenting attachments — phase 1 is not in effect.");
    }
    const reseed3 = await dockerPsql(container,
      `INSERT INTO public.papers (id, user_id, title, keywords, insert_order) VALUES\n` +
      `  ('${MCUT_DISCARD}','${MCUT_USER}','Merge discard','[]'::jsonb,2)\n` +
      `ON CONFLICT (id) DO NOTHING;\n` +
      `UPDATE public.paper_attachments SET paper_id='${MCUT_DISCARD}' WHERE user_id='${MCUT_USER}';\n`);
    if (reseed3.code !== 0) throw new Error(`merge cutover: could not reseed for M-CUT-3: ${reseed3.err.trim()}`);

    const realMerge = await dockerPsql(container,
      `SELECT set_config('request.jwt.claims','{"sub":"${MCUT_USER}","role":"authenticated"}', false);\n` +
      `SELECT public.merge_exact_duplicates('${MCUT_KEEP}'::uuid, ARRAY['${MCUT_DISCARD}']::uuid[]);\n` +
      `SELECT 'MERGED';\n` +
      `SELECT set_config('request.jwt.claims', NULL, false);\n`);
    if (realMerge.code !== 0 || !/MERGED/.test(realMerge.out)) {
      throw new Error(`merge cutover M-CUT-3: the corrected merge RPC failed: ${(realMerge.err || realMerge.out).trim().slice(0, 250)}`);
    }
    const after3 = await mcutState(container);
    if (after3[0] !== 1 || after3[1] !== 0 || after3[2] !== 1 || after3[3] !== 1 || after3[4] !== 0 || after3[5] !== 0) {
      throw new Error(`merge cutover M-CUT-3: post-boundary merge produced the wrong state (keep|discard|attach|on-keep|queue|tombstone = ${after3.join("|")}).`);
    }
    log("cutover probe M-CUT-3 OK: a merge begun after the boundary used the parent-first body, re-parented the attachment and stranded nothing.");

    // ── M-CUT-4: residue ──────────────────────────────────────────────────
    const residue =
      (await countAuthLockWaiters(container, "ShareRowExclusiveLock"))
      + (await countPapersLockWaiters(container, "ShareLock"))
      + (await countPapersLockWaiters(container, "RowExclusiveLock"))
      + (await countTableLockWaiters(container, "AccessExclusiveLock"))
      + (await countTableLockWaiters(container, "RowExclusiveLock"));
    if (residue !== 0) {
      throw new Error(`merge cutover M-CUT-4: ${residue} ungranted relation-lock waiter(s) remain.`);
    }
    log("cutover probe M-CUT-4 OK: no relation-lock waiters remain after the merge-cutover cases.");
  } catch (err) {
    await killPsql(cutover);
    await killPsql(legacy);
    throw err;
  } finally {
    await dockerPsql(container, `DELETE FROM auth.users WHERE id='${MCUT_USER}';\n`);
  }
}

/**
 * Production-legacy ACL parity probe (ACL-1…ACL-3).
 *
 * WHY THIS EXISTS. The first Phase-2 Production rollout was refused by the
 * migration's own section 7 with `anon must not hold SELECT on
 * paper_attachments`, and nothing in this repository could have predicted it.
 * Hosted Production was provisioned under Supabase's OLD platform default, which
 * auto-granted ALL (`arwdDxtm`) on every new public table to
 * anon/authenticated/service_role; a `db reset` today gets the NEW default,
 * which grants the API roles only `Dxtm` (TRUNCATE, REFERENCES, TRIGGER,
 * MAINTAIN) and none of the four DML privileges. So `anon` begins a local replay
 * holding none of SELECT/INSERT/UPDATE/DELETE and Production holds all four, and
 * a migration that revokes privileges BY NAME converges the replay while leaving
 * whatever it failed to name standing on Production. Every probe and pgTAP test
 * in this repository ran only against the replay, so the divergence had no way
 * to show up until the rollout hit it.
 *
 * WHAT IT DOES. In ONE transaction that is always rolled back:
 *
 *   ACL-1  seed hosted Production's legacy ACL on both tables, and PROVE the
 *          seed took. Without this the probe would "pass" by never having
 *          reproduced the condition at all — the failure mode this correction
 *          exists to stop repeating.
 *   ACL-2  apply the migration's own privilege statements, read from the
 *          migration file (readCutoverGrantSql) rather than restated here.
 *   ACL-3  assert the reviewed final matrix — `anon` reaches neither table for
 *          any of the five client privileges, `authenticated` keeps exactly the
 *          capabilities the product needs and no writes it must not have,
 *          `service_role` is untouched, and PUBLIC holds nothing.
 *
 * Against the pre-correction migration this fails at ACL-3 with `anon` still
 * holding SELECT on `paper_attachments` and SELECT/INSERT/UPDATE on `papers` —
 * the second of which section 7 did not assert, so that half would have
 * COMMITTED wrong rather than refusing.
 *
 * Nothing is committed: GRANT/REVOKE are transactional, so the ROLLBACK restores
 * the exact starting ACL. assertNoResidue's catalog fingerprint covers relacl
 * and would catch it if that were ever untrue.
 */
async function runAclParityProbe(container) {
  log("running Production-legacy ACL parity probe…");

  const res = await dockerPsql(
    container,
    "BEGIN;\n" +
      // ── ACL-1: reproduce hosted Production, and prove we did ──
      CUT_PROD_LEGACY_ACL_SQL +
      "DO $seed$ BEGIN\n" +
      "  IF NOT (has_table_privilege('anon','public.paper_attachments','SELECT')\n" +
      "      AND has_table_privilege('anon','public.papers','SELECT')\n" +
      "      AND has_table_privilege('anon','public.papers','DELETE')) THEN\n" +
      "    RAISE EXCEPTION 'ACL-1: the legacy Production ACL seed did not take — this probe would prove nothing';\n" +
      "  END IF;\n" +
      "END $seed$;\n" +
      "SELECT 'ACL1=seeded';\n" +
      // ── ACL-2: the migration's real statements ──
      CUT_REVOKE_SQL +
      // ── ACL-3: the reviewed final matrix ──
      "DO $matrix$\n" +
      "DECLARE p TEXT; bad TEXT := '';\n" +
      "BEGIN\n" +
      "  FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP\n" +
      "    IF has_table_privilege('anon','public.paper_attachments',p) THEN bad := bad || ' anon+' || p || '@paper_attachments'; END IF;\n" +
      "    IF has_table_privilege('anon','public.papers',p) THEN bad := bad || ' anon+' || p || '@papers'; END IF;\n" +
      "  END LOOP;\n" +
      "  FOREACH p IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'] LOOP\n" +
      "    IF has_table_privilege('authenticated','public.paper_attachments',p) THEN bad := bad || ' authenticated+' || p || '@paper_attachments'; END IF;\n" +
      "  END LOOP;\n" +
      "  FOREACH p IN ARRAY ARRAY['DELETE','TRUNCATE'] LOOP\n" +
      "    IF has_table_privilege('authenticated','public.papers',p) THEN bad := bad || ' authenticated+' || p || '@papers'; END IF;\n" +
      "  END LOOP;\n" +
      "  IF NOT has_table_privilege('authenticated','public.paper_attachments','SELECT') THEN bad := bad || ' authenticated-SELECT@paper_attachments'; END IF;\n" +
      "  FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE'] LOOP\n" +
      "    IF NOT has_table_privilege('authenticated','public.papers',p) THEN bad := bad || ' authenticated-' || p || '@papers'; END IF;\n" +
      "  END LOOP;\n" +
      "  FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP\n" +
      "    IF NOT has_table_privilege('service_role','public.paper_attachments',p) THEN bad := bad || ' service_role-' || p || '@paper_attachments'; END IF;\n" +
      "    IF NOT has_table_privilege('service_role','public.papers',p) THEN bad := bad || ' service_role-' || p || '@papers'; END IF;\n" +
      "  END LOOP;\n" +
      "  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a\n" +
      "              WHERE c.oid IN ('public.papers'::regclass,'public.paper_attachments'::regclass)\n" +
      "                AND a.grantee = 0) THEN bad := bad || ' PUBLIC-holds-something'; END IF;\n" +
      "  IF bad <> '' THEN\n" +
      "    RAISE EXCEPTION 'ACL-3: the cutover did not converge the legacy Production ACL —%', bad;\n" +
      "  END IF;\n" +
      "END $matrix$;\n" +
      "SELECT 'ACL3=converged';\n" +
      "ROLLBACK;\n",
  );
  if (res.code !== 0) {
    throw new Error(`ACL parity probe failed: ${(res.err || res.out).trim().slice(0, 400)}`);
  }
  for (const [needle, what] of [
    ["ACL1=seeded", "the legacy Production ACL seed did not run"],
    ["ACL3=converged", "the migration's privilege statements did not converge the legacy Production ACL"],
  ]) {
    if (!res.out.includes(needle)) {
      throw new Error(`ACL parity probe: ${what} (expected ${needle}).`);
    }
  }

  // The transaction rolled back, so the starting ACL must be back exactly. Read
  // it on a fresh statement rather than trusting the ROLLBACK.
  const restored = await dbScalar(
    container,
    "SELECT (SELECT count(*)::text FROM pg_class c, aclexplode(c.relacl) a " +
      "WHERE c.oid IN ('public.papers'::regclass,'public.paper_attachments'::regclass) " +
      "AND a.grantee = 'anon'::regrole) || '|' || " +
      "has_table_privilege('authenticated','public.paper_attachments','SELECT')::text || '|' || " +
      "has_table_privilege('authenticated','public.papers','INSERT')::text;",
  );
  if (restored !== "0|true|true") {
    throw new Error(
      `ACL parity probe: the rollback did not restore the starting ACL ` +
        `(anon grants|attach select|papers insert = ${restored}).`,
    );
  }
  log("ACL parity probe OK: the cutover converges hosted Production's legacy ACL, and rolled back clean.");
}

/**
 * Migration-cutover probe
 * (ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001-CORRECTION-03, Case CUT-1).
 *
 * Revoking a privilege does not wait for anybody. `REVOKE` locks catalog rows,
 * not the table, so on its own it commits straight past a browser's in-flight
 * `INSERT INTO paper_attachments` — a statement permission-checked before the
 * revoke and committed after it. That alone defeats the Storage fence added in
 * CORRECTION-02, which asks whether live metadata names an object and gets "no"
 * from a row that has not committed yet:
 *
 *   INSERT in flight → migration commits → the old tab's lost-response
 *   compensation deletes the binary → the INSERT commits → a metadata row with
 *   quota charged and no file.
 *
 * Section 0 of the migration closes that with an explicit ACCESS EXCLUSIVE lock
 * on `paper_attachments` — the LAST of its three barriers (`auth.users`, then
 * `papers`, then this one), held to commit. This proves the three properties the
 * argument rests on, with real concurrent sessions and lock inspection rather
 * than a sleep:
 *
 *   1. the barrier WAITS for a pre-existing direct writer (session A);
 *   2. a writer arriving after the barrier request cannot overtake it, and when
 *      it finally runs it is planned against the NEW privileges (session C) —
 *      which is what makes "no pre-cutover writer survives" mean anything;
 *   3. once the cutover commits, direct metadata DML is closed and the three
 *      lifecycle RPCs still work.
 *
 * The local database already carries the hardened posture, so a pre-cutover
 * writer cannot exist here without briefly restoring the grant it used to hold.
 * The probe therefore re-grants, races the REAL statements against the REAL
 * table, and restores the hardened posture in `finally` — rather than letting a
 * scratch table stand in for the one whose privileges are the whole subject.
 */
async function runMigrationCutoverProbe(container) {
  log("running migration-cutover probe (direct attachment DML)…");

  const setup = await dockerPsql(
    container,
    `INSERT INTO auth.users (id, email) VALUES ('${CUT_PROBE_USER}','cutover-race@paperlume.test') ON CONFLICT DO NOTHING;\n` +
      `UPDATE public.user_entitlements SET storage_quota_bytes=1000000 WHERE user_id='${CUT_PROBE_USER}';\n` +
      `INSERT INTO public.papers (id, user_id, title, keywords, insert_order) VALUES\n` +
      `  ('${CUT_PAPER}','${CUT_PROBE_USER}','Cutover race','[]'::jsonb,1)\n` +
      `ON CONFLICT (id) DO NOTHING;\n`,
  );
  if (setup.code !== 0) throw new Error(`cutover fixture setup failed: ${setup.err.trim()}`);

  let held = null;      // A — the pre-cutover writer, transaction open.
  let cutover = null;   // B — the migration's barrier + revoke.
  let newcomer = null;  // C — a writer that starts after the barrier is requested.
  try {
    // ── Pre-cutover world ───────────────────────────────────────────────────
    // Exactly the grant 20260731162729 left in place — what an already-loaded
    // bundle was written against.
    const regrant = await dockerPsql(container, CUT_LEGACY_GRANT_SQL);
    if (regrant.code !== 0) throw new Error(`cutover probe: could not restore the pre-cutover grant: ${regrant.err.trim()}`);
    if ((await dbScalar(container,
      `SELECT has_table_privilege('authenticated','public.paper_attachments','INSERT')::text || '|' || ` +
      `has_table_privilege('authenticated','public.papers','DELETE')::text;`)) !== "true|true") {
      throw new Error("cutover probe: the pre-cutover grants did not take effect.");
    }

    // ── A: a direct authenticated INSERT, reached Postgres, not committed ───
    held = spawnDockerPsql(container);
    held.child.stdin.write("BEGIN;\n" + cutAuth(true) + cutLegacyInsertSql("legacy.pdf", "A") + "SELECT 'A_READY';\n");
    await waitUntil(() => /A_READY/.test(held.readOut()), PROBE_WORKER_MS,
      "cutover probe: the pre-cutover INSERT never reached the database.");
    if (!/A=inserted/.test(held.readOut())) {
      throw new Error("cutover probe: the pre-cutover INSERT did not succeed under the restored grant.");
    }

    // ── B: the cutover, statement for statement as the migration performs it ─
    cutover = spawnDockerPsql(container);
    cutover.child.stdin.write(
      "BEGIN;\n" + CUT_BARRIER_SQL + "SELECT 'B_BARRIER';\n" +
        CUT_REVOKE_SQL + "COMMIT;\nSELECT 'B_COMMITTED';\n",
    );
    cutover.child.stdin.end();
    await waitUntil(async () => (await countTableLockWaiters(container, "AccessExclusiveLock")) >= 1,
      PROBE_BARRIER_MS, "cutover probe: the barrier never queued behind the in-flight writer.");
    if (/B_BARRIER/.test(cutover.readOut())) {
      throw new Error("cutover probe: the barrier passed a transaction that had already written the table.");
    }

    // ── C: a writer that begins AFTER the barrier was requested ─────────────
    newcomer = spawnDockerPsql(container);
    newcomer.child.stdin.write(cutAuth(false) + cutLegacyInsertSql("newcomer.pdf", "C") + "SELECT 'C_DONE';\n");
    newcomer.child.stdin.end();
    await waitUntil(async () => (await countTableLockWaiters(container, "RowExclusiveLock")) >= 1,
      PROBE_BARRIER_MS, "cutover probe: the newcomer did not queue behind the barrier.");
    if (/C=inserted/.test(newcomer.readOut())) {
      throw new Error("cutover probe: a writer overtook the pending barrier.");
    }

    // ── Release A; B takes the lock, revokes, commits; C then runs ──────────
    held.child.stdin.write("COMMIT;\nSELECT 'A_COMMITTED';\n");
    held.child.stdin.end();
    const [aRes, bRes, cRes] = await Promise.all([
      withTimeout(held.done, FIN_HOLD_MS, "cutover probe: pre-cutover writer exit"),
      withTimeout(cutover.done, FIN_HOLD_MS, "cutover probe: cutover exit"),
      withTimeout(newcomer.done, FIN_HOLD_MS, "cutover probe: newcomer exit"),
    ]);
    held = null;
    cutover = null;
    newcomer = null;

    if (aRes.code !== 0 || aRes.signal !== null || !/A_COMMITTED/.test(aRes.out)) {
      throw new Error(`cutover probe: the pre-cutover writer did not commit cleanly (code=${aRes.code}).`);
    }
    if (bRes.code !== 0 || bRes.signal !== null || !/B_BARRIER/.test(bRes.out) || !/B_COMMITTED/.test(bRes.out)) {
      throw new Error(`cutover probe: the cutover did not complete cleanly (code=${bRes.code}).`);
    }
    // C must have been REFUSED, not merely blocked — and refused for lack of
    // privilege, which is only true if it re-planned against the new ACL.
    if (/C=inserted/.test(cRes.out)) {
      throw new Error("cutover probe: a direct INSERT authorized before the cutover committed after it.");
    }
    if (!/permission denied/i.test(cRes.err + cRes.out)) {
      throw new Error(`cutover probe: the queued writer failed for the wrong reason: ${(cRes.err || cRes.out).trim().slice(0, 200)}`);
    }

    // ── The resulting state, read back ──────────────────────────────────────
    // A's row is present: it was authorized AND committed entirely before the
    // cutover, which is exactly what "the barrier waited" means. C's is not.
    const rows = (await dbScalar(container,
      `SELECT (SELECT count(*) FROM public.paper_attachments WHERE file_path='${cutPath("legacy.pdf")}') || '|' || ` +
      `(SELECT count(*) FROM public.paper_attachments WHERE file_path='${cutPath("newcomer.pdf")}');`))
      .split("|").map((n) => parseInt(n, 10));
    if (rows[0] !== 1 || rows[1] !== 0) {
      throw new Error(`cutover probe: expected the pre-cutover row present and the queued one absent, got ${rows.join("|")}.`);
    }
    log("cutover probe CUT-1 OK: the barrier waited for the in-flight writer, and the writer queued behind it was refused by the new privileges.");

    // ── CUT-2/3/4: direct DML is closed, on the caller's own rows ───────────
    const attempts = [
      ["CUT-2 INSERT",
       `INSERT INTO public.paper_attachments (paper_id, user_id, file_path, file_name, file_type, size_bytes)\n` +
       `  VALUES ('${CUT_PAPER}','${CUT_PROBE_USER}','${cutPath("post.pdf")}','post.pdf','application/pdf',16);\n`],
      ["CUT-3 UPDATE",
       `UPDATE public.paper_attachments SET file_name='renamed.pdf' WHERE user_id='${CUT_PROBE_USER}';\n`],
      ["CUT-4 DELETE",
       `DELETE FROM public.paper_attachments WHERE user_id='${CUT_PROBE_USER}';\n`],
      ["CUT-4 TRUNCATE", `TRUNCATE public.paper_attachments;\n`],
    ];
    for (const [label, sql] of attempts) {
      const r = await cutDeniedAs(container, sql);
      if (!r.denied) throw new Error(`cutover probe ${label}: a direct authenticated write was NOT refused (${r.detail}).`);
    }
    const stillReadable = await dockerPsql(container,
      cutAuth(false) + `SELECT 'CUTSELECT=' || count(*)::text FROM public.paper_attachments;\n`);
    if (stillReadable.code !== 0 || !/CUTSELECT=1/.test(stillReadable.out)) {
      throw new Error("cutover probe: SELECT did not survive the revoke — the attachment list would be empty.");
    }
    log("cutover probe CUT-2/3/4 OK: direct INSERT, UPDATE, DELETE and TRUNCATE all refused; SELECT preserved.");

    // ── CUT-5: the RPCs that hold the privilege on the client's behalf ──────
    const rpc = await dockerPsql(container,
      cutAuth(false) +
      `SELECT 'FINALIZE=' || status FROM public.finalize_attachment_upload(\n` +
      `  '${CUT_PAPER}'::uuid, '${cutPath("viaRpc.pdf")}', 'viaRpc.pdf', 'application/pdf', 16);\n` +
      `SELECT public.delete_attachment_with_cleanup(\n` +
      `  (SELECT id FROM public.paper_attachments WHERE file_path='${cutPath("viaRpc.pdf")}'));\n` +
      `SELECT 'DELETED=' || count(*)::text FROM public.paper_attachments\n` +
      `  WHERE file_path='${cutPath("viaRpc.pdf")}';\n` +
      `SELECT 'QUEUED=' || count(*)::text FROM public.attachment_cleanup_queue\n` +
      `  WHERE file_path='${cutPath("viaRpc.pdf")}';\n` +
      // The paper still holds session A's pre-cutover row, so a correct bulk
      // delete reports one paper and one remaining path — proof the cascade and
      // the intent snapshot both still run without any client table grant.
      `SELECT 'PAPERS=' || deleted_count::text || '/' || queued_count::text\n` +
      `  FROM public.delete_papers_with_attachment_cleanup(ARRAY['${CUT_PAPER}']::uuid[]);\n`);
    if (rpc.code !== 0) throw new Error(`cutover probe: the lifecycle RPCs failed after the revoke: ${rpc.err.trim()}`);
    for (const [needle, what] of [
      ["FINALIZE=metadata_committed", "finalize_attachment_upload could not insert metadata"],
      ["DELETED=0", "delete_attachment_with_cleanup did not remove metadata"],
      ["QUEUED=1", "delete_attachment_with_cleanup removed metadata without recording Storage cleanup intent"],
      ["PAPERS=1/1", "delete_papers_with_attachment_cleanup did not delete the paper and queue its remaining path"],
    ]) {
      if (!rpc.out.includes(needle)) {
        throw new Error(`cutover probe CUT-5: ${what} (expected ${needle}, got ${rpc.out.trim().slice(0, 200)}).`);
      }
    }
    log("cutover probe CUT-5 OK: finalize, attachment delete and paper delete all still work as the client, with no client table grants.");

    // ── The parent half of the same boundary ───────────────────────────────
    // Re-open the pre-cutover world once more (the block above closed it) and
    // race the parent table the same way. Inside this try/finally, so the
    // hardened posture is restored on every path.
    const reopen = await dockerPsql(container, CUT_LEGACY_GRANT_SQL);
    if (reopen.code !== 0) throw new Error(`cutover probe: could not restore the pre-cutover grants for the parent cases: ${reopen.err.trim()}`);
    await runParentCutoverCases(container);

    // ── The upstream half of the same boundary ─────────────────────────────
    // Both barriers above are downstream of `auth.users`, and the migration must
    // reach that table BEFORE either of them or it deadlocks against an ordinary
    // account deletion. Re-open the pre-cutover world once more and race the
    // Auth table too.
    const reopenAuth = await dockerPsql(container, CUT_LEGACY_GRANT_SQL);
    if (reopenAuth.code !== 0) throw new Error(`cutover probe: could not restore the pre-cutover grants for the auth cases: ${reopenAuth.err.trim()}`);
    await runAuthCutoverCases(container);

    // ── The writer this schema HAS, as opposed to the ones it will have ───
    // Every case above races the cutover against writers as they exist after
    // the migration. The legacy `merge_exact_duplicates` still deployed in
    // Production runs child-before-parent, which is the one order the barrier
    // cannot tolerate — and no reordering fixes it, because a stale paper
    // delete runs parent-before-child. Hence two phases and a drain.
    await runMergeCutoverCases(container);
  } finally {
    await killPsql(newcomer);
    await killPsql(cutover);
    await killPsql(held);
    // Restore the migration's posture unconditionally. A failure here is fatal:
    // leaving the local database more permissive than a replay would make every
    // later assertion in this lane meaningless.
    const restore = await dockerPsql(container, CUT_REVOKE_SQL);
    if (restore.code !== 0) {
      throw new Error(`cutover probe: could not restore the hardened grant posture: ${restore.err.trim()}`);
    }
  }

  const posture = await dbScalar(container,
    `SELECT has_table_privilege('authenticated','public.paper_attachments','INSERT')::text || '|' || ` +
    `has_table_privilege('authenticated','public.paper_attachments','UPDATE')::text || '|' || ` +
    `has_table_privilege('authenticated','public.paper_attachments','DELETE')::text || '|' || ` +
    `has_table_privilege('authenticated','public.paper_attachments','TRUNCATE')::text || '|' || ` +
    `has_table_privilege('authenticated','public.paper_attachments','SELECT')::text || '|' || ` +
    `has_table_privilege('authenticated','public.papers','DELETE')::text || '|' || ` +
    `has_table_privilege('authenticated','public.papers','TRUNCATE')::text || '|' || ` +
    `has_table_privilege('authenticated','public.papers','SELECT')::text || '|' || ` +
    `has_table_privilege('authenticated','public.papers','INSERT')::text || '|' || ` +
    `has_table_privilege('authenticated','public.papers','UPDATE')::text;`);
  if (posture !== "false|false|false|false|true|false|false|true|true|true") {
    throw new Error(
      `cutover probe: the restored posture is wrong ` +
      `(attach insert|update|delete|truncate|select, papers delete|truncate|select|insert|update = ${posture}).`);
  }

  const waiters = (await countTableLockWaiters(container, "AccessExclusiveLock"))
    + (await countPapersLockWaiters(container, "ShareLock"))
    + (await countPapersLockWaiters(container, "RowExclusiveLock"))
    + (await countAuthLockWaiters(container, "ShareRowExclusiveLock"))
    + (await countAuthLockWaiters(container, "RowExclusiveLock"));
  if (waiters !== 0) throw new Error(`cutover probe: ${waiters} ungranted table-lock waiter(s) remain.`);

  const cleanup = await dockerPsql(container,
    `DELETE FROM public.attachment_cleanup_queue WHERE user_id='${CUT_PROBE_USER}';\n` +
    `DELETE FROM public.attachment_cleanup_tombstone WHERE user_id='${CUT_PROBE_USER}';\n` +
    `DELETE FROM auth.users WHERE id='${CUT_PROBE_USER}';\n`);
  if (cleanup.code !== 0) throw new Error(`cutover fixture cleanup failed: ${cleanup.err.trim()}`);
  const residual = (await dbScalar(container,
    `SELECT (SELECT count(*) FROM auth.users WHERE id='${CUT_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.papers WHERE user_id='${CUT_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.paper_attachments WHERE user_id='${CUT_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.attachment_cleanup_queue WHERE user_id='${CUT_PROBE_USER}') || '|' || ` +
    `(SELECT count(*) FROM public.attachment_cleanup_tombstone WHERE user_id='${CUT_PROBE_USER}');`))
    .split("|").map((n) => parseInt(n, 10));
  if (residual.some((c) => c !== 0)) {
    throw new Error(`cutover fixture not fully removed (user|papers|attachments|queue|tombstone = ${residual.join("|")}).`);
  }
}

/**
 * Residue + catalog check on a fresh connection (Sections H): after the
 * transaction-isolated pgTAP suites, the negative control, the framework-free
 * file, and the concurrency probe (+ its cleanup), no test user, application row,
 * entitlement/quota/storage/access/cleanup-queue row, or advisory lock may
 * remain; pgTAP state must be unchanged; and the catalog fingerprint (functions,
 * policies, RLS flags, triggers, relations) must exactly equal the pre-test
 * baseline — proving no persistent
 * function/policy/trigger/relation/RLS-flag/extension/helper changed.
 */
async function assertNoResidue(container, pgtapBefore, catalogBefore) {
  const counts = (await dbScalar(container,
    "SELECT (SELECT count(*) FROM auth.users) || '|' || " +
    "(SELECT count(*) FROM public.papers) || '|' || " +
    "(SELECT count(*) FROM public.projects) || '|' || " +
    "(SELECT count(*) FROM public.tags) || '|' || " +
    "(SELECT count(*) FROM public.filter_presets) || '|' || " +
    "(SELECT count(*) FROM public.paper_attachments) || '|' || " +
    "(SELECT count(*) FROM public.user_entitlements) || '|' || " +
    "(SELECT count(*) FROM public.usage_counters) || '|' || " +
    "(SELECT count(*) FROM public.user_storage_usage) || '|' || " +
    "(SELECT count(*) FROM public.internal_user_access) || '|' || " +
    // ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001: a cleanup job left behind would
    // be a real leak, because a queue row is a standing instruction to delete a
    // Storage object.
    "(SELECT count(*) FROM public.attachment_cleanup_queue) || '|' || " +
    // The permanent half of the same record. It outlives the queue row by
    // design, so a leftover here is just as much a leak.
    "(SELECT count(*) FROM public.attachment_cleanup_tombstone) || '|' || " +
    "(SELECT count(*) FROM pg_locks WHERE locktype='advisory');")).split("|").map((s) => parseInt(s, 10));
  if (counts.some((c) => c !== 0)) {
    throw new Error(`residue detected (users|papers|projects|tags|presets|attachments|entitlements|counters|storage|access|cleanup|tombstone|advisory = ${counts.join("|")}).`);
  }
  const pgtapAfter = await pgtapState(container);
  if (pgtapAfter !== pgtapBefore) {
    throw new Error(`pgTAP extension state changed: before="${pgtapBefore}" after="${pgtapAfter}".`);
  }
  const catalogAfter = await captureCatalog(container);
  if (catalogAfter !== catalogBefore) {
    throw new Error(`catalog fingerprint changed: before="${catalogBefore}" after="${catalogAfter}".`);
  }
  log(`residue check OK: no test rows/locks remain; pgTAP state unchanged (${pgtapAfter}); catalog fingerprint unchanged.`);
  log("no persistent function, policy, trigger, relation, RLS-flag, extension, helper, fixture, or advisory lock changed.");
}

/**
 * Post-teardown inspection command. A local-only, non-credential test hook
 * (E2E_DBTESTS_FORCE_INSPECT_FAIL=1) forces the inspection to fail with a
 * nonzero exit (an invalid docker flag) so the nonzero-exit fail-closed path can
 * be proven; it is inactive during normal execution, affects only this
 * verification step (never the actual teardown), and cannot redirect anything to
 * a remote target. (A second hook, E2E_DBTESTS_FORCE_INSPECT_GARBAGE, injects a
 * malformed record AFTER a normal zero-exit `docker ps` — see below.)
 */
function dockerInspectArgs() {
  return process.env.E2E_DBTESTS_FORCE_INSPECT_FAIL === "1"
    ? ["ps", "--__force_inspect_failure__"] // invalid flag → nonzero exit (test hook only)
    : ["ps", "--format", "{{.Names}}"];
}

/**
 * Strict parser for `docker ps --format {{.Names}}` output (Section E). Returns
 * the list of container names, or throws on any malformed record — it does NOT
 * trim, so leading/trailing whitespace can never be laundered into a valid name.
 * Accepts empty output (no containers) and a single trailing newline; rejects
 * NUL/carriage-return, embedded blank records, names with spaces/tabs/other
 * control or disallowed characters, and duplicates. Docker container names match
 * /^[A-Za-z0-9][A-Za-z0-9_.-]*$/. Error messages never contain the raw output.
 */
function parseDockerContainerNames(raw) {
  if (typeof raw !== "string") {
    throw new Error("post-teardown `docker ps` output is not a string.");
  }
  if (/[\0\r]/.test(raw)) {
    throw new Error("post-teardown `docker ps` produced malformed output.");
  }
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new Error("post-teardown `docker ps` produced malformed blank lines.");
  }
  const validDockerName = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
  for (const line of lines) {
    if (!validDockerName.test(line)) {
      throw new Error("post-teardown `docker ps` produced an invalid container-name record.");
    }
  }
  if (new Set(lines).size !== lines.length) {
    throw new Error("post-teardown `docker ps` produced duplicate container-name records.");
  }
  return lines;
}

/**
 * Authoritative post-teardown inspection (Sections E/F). After a successful
 * mandatory teardown, prove NO current-project container (`supabase_*_<ref>`)
 * remains. FAIL-CLOSED: project-ref resolution failure, a docker spawn failure,
 * a nonzero `docker ps`, malformed/unparseable output, or a residual
 * current-project container all throw (the caller records cleanupError).
 * Container-name classification runs only AFTER strict parsing succeeds.
 * Unrelated (valid) Supabase projects are left untouched, and valid non-Supabase
 * names are ignored. The malformed raw output is never echoed.
 */
async function assertCurrentProjectTornDown() {
  const ref = readProjectId(); // throws if config unreadable → fails the lifecycle
  const ps = await runCapture("docker", dockerInspectArgs());
  if (ps.code !== 0) {
    throw new Error(`post-teardown \`docker ps\` failed (exit ${ps.code}); cannot confirm current-project teardown.`);
  }
  // Local-only malformed-output hook: only AFTER the real command's zero-exit
  // check, substitute one fixed malformed record so the strict parser's
  // rejection path is provable. Inactive normally; never touches Docker state.
  const raw = process.env.E2E_DBTESTS_FORCE_INSPECT_GARBAGE === "1"
    ? "malformed docker record with spaces\n"
    : ps.out;
  let running;
  try {
    running = parseDockerContainerNames(raw);
  } catch {
    // Fixed classification; never reproduce the malformed raw record in logs.
    throw new Error("post-teardown Docker output rejected as malformed.");
  }
  const mine = running.filter((n) => n.startsWith("supabase_") && n.endsWith(`_${ref}`));
  const others = running.filter((n) => n.startsWith("supabase_") && !n.endsWith(`_${ref}`));
  if (mine.length > 0) {
    throw new Error(`current-project local stack still running after teardown: ${mine.join(", ")}`);
  }
  log(`confirmed (authoritative): no current-project (${ref}) local Supabase stack remains.`);
  if (others.length > 0) {
    log(`note: ${others.length} unrelated Supabase container(s) left untouched (not this project).`);
  }
}

async function cmdDbTests() {
  assertRepoRoot();
  await assertToolingAvailable();
  await assertSupportedFlags();
  await assertDbTestFlags();
  installSignalCleanup(cleanupDbTestsOnce);

  let primaryError = null;
  try {
    await startStack();
    await resetLocalDb();

    // Validate the local API origin (loopback, no Production ref) before any
    // privileged work; never log the raw status (it carries keys).
    const { apiUrl } = await readLocalStatus();
    log(`validated local API origin: ${apiUrl}`);

    const container = await resolveLocalDbContainer();
    log(`resolved local Postgres container: ${container}`);

    // Baselines: extension state + catalog fingerprint captured on a clean DB.
    const pgtapBefore = await pgtapState(container);
    log(`pre-test pgTAP state: ${pgtapBefore}`);
    const catalogBefore = await captureCatalog(container);
    log(`pre-test catalog fingerprint: ${catalogBefore}`);

    // Catalog-fingerprint sensitivity probe (transaction-only), then prove it
    // left no trace on a fresh connection (Section H / lifecycle steps 8–9).
    await runCatalogSensitivityProbe(container);
    const catalogAfterProbe = await captureCatalog(container);
    if (catalogAfterProbe !== catalogBefore) {
      throw new Error("catalog sensitivity probe did not fully roll back: baseline fingerprint changed.");
    }
    log("catalog fingerprint sensitivity rollback verified.");

    // Expected-failure negative control BEFORE the green suite, then prove the
    // injected regression fully rolled back (Section E).
    await runNegativeControl(container);
    await assertNegativeControlRestored(container, catalogBefore);

    await runPgTapDirectory();
    // Extension isolation is asserted precisely in assertNoResidue below.

    await runLegacyVerification(container);
    await runConcurrencyProbe(container);
    await runMergeCycleProbe(container);
    await runAttachmentFinalizationProbe(container);
    await runPaperDeleteFinalizationProbe(container);
    await runAclParityProbe(container);
    await runMigrationCutoverProbe(container);
    await assertNoResidue(container, pgtapBefore, catalogBefore);

    log("all local database-security tests passed.");
  } catch (err) {
    primaryError = err;
  }

  let cleanupError = null;
  try {
    await cleanupDbTestsOnce();
  } catch (err) {
    cleanupError = err;
  }

  // Authoritative post-teardown inspection (Sections F/J). Any inspection
  // failure — project-ref resolution, docker spawn, nonzero `docker ps`,
  // unparseable output, or a residual current-project container — fails the
  // lifecycle; there is no empty catch. Runs only when teardown itself
  // succeeded; a prior cleanupError is preserved. Both a primary lifecycle
  // failure and an inspection failure surface together via AggregateError below.
  if (!cleanupError) {
    try {
      await assertCurrentProjectTornDown();
    } catch (err) {
      cleanupError = err;
    }
  }

  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "Local db-tests lifecycle failed AND teardown failed:");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  switch (subcommand) {
    case "run":
      await cmdRun(rest);
      break;
    case "verify-guards":
      await cmdVerifyGuards();
      break;
    case "db-tests":
      await cmdDbTests();
      break;
    case "stop":
      await cmdStop();
      break;
    default:
      fail(`Unknown subcommand "${subcommand ?? ""}". Use: run | verify-guards | db-tests | stop`);
      process.exit(2);
  }
}

main().catch((e) => {
  // Preserve evidence of every failure. For an AggregateError (lifecycle +
  // teardown both failed) print the summary and each underlying error, so the
  // original reset/seed/Playwright failure is never hidden behind the teardown
  // one. None of these messages contains a key, password, token, or raw status.
  if (e instanceof AggregateError) {
    fail(e.message);
    for (const sub of e.errors) {
      fail(`  · ${sub instanceof Error ? sub.message : String(sub)}`);
    }
  } else {
    fail(e instanceof Error ? e.message : String(e));
  }
  process.exit(1);
});
