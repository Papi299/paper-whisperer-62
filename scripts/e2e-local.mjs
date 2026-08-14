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
 *                  prove true concurrent AI-quota consumption at the cap with
 *                  bounded, fail-closed coordinator/worker processes whose
 *                  deadlines all start at barrier release → verify no
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PRODUCTION_SUPABASE_REF = "lioxtgiputfniqbktcsz";
const AUTH_STATE_FILE = resolve(ROOT, "e2e/.auth/user.json");

/** The authorized read-only specs — the safe default subset for `run`. */
const DEFAULT_SPECS = [
  "e2e/auth.spec.ts",
  // Reads the product name on the unauthenticated Auth card, the authenticated
  // sidebar, and the document title; mutates nothing.
  "e2e/branding.spec.ts",
  // PFA-C09 responsive/accessibility regression coverage. Read-only: resizes
  // the viewport, opens and closes dialogs, sorts, resizes a column and scrolls
  // the table. It never activates the badge "exclude" action (the one real
  // mutation on that surface) and writes nothing to the database.
  "e2e/responsive-accessibility.spec.ts",
  "e2e/bulk-actions.spec.ts",
  "e2e/eager-load.spec.ts",
  "e2e/filters.spec.ts",
  "e2e/paper-import.spec.ts",
  "e2e/pools.spec.ts",
  // Opens Settings and reads the storage gauge; mutates nothing.
  "e2e/settings-storage.spec.ts",
  // Opens Settings and downloads the account export; reads only, mutates nothing.
  "e2e/account-export.spec.ts",
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
  } catch (err) {
    primaryError = err;
    // A failed run may have left the disposable account behind. Remove it
    // best-effort so a debugging session with E2E_KEEP_LOCAL_STACK=1 does not
    // accumulate residue; the deterministic fixtures are never touched.
    if (disposable) {
      const target = await readLocalStatus().catch(() => null);
      if (target) {
        await cleanupDisposableAccount({
          apiUrl: target.apiUrl,
          serviceRoleKey: target.serviceRoleKey,
          account: disposable,
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

/**
 * Residue + catalog check on a fresh connection (Sections H): after the
 * transaction-isolated pgTAP suites, the negative control, the framework-free
 * file, and the concurrency probe (+ its cleanup), no test user, application row,
 * entitlement/quota/storage/access row, or advisory lock may remain; pgTAP state
 * must be unchanged; and the catalog fingerprint (functions, policies, RLS flags,
 * triggers, relations) must exactly equal the pre-test baseline — proving no
 * persistent function/policy/trigger/relation/RLS-flag/extension/helper changed.
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
    "(SELECT count(*) FROM pg_locks WHERE locktype='advisory');")).split("|").map((s) => parseInt(s, 10));
  if (counts.some((c) => c !== 0)) {
    throw new Error(`residue detected (users|papers|projects|tags|presets|attachments|entitlements|counters|storage|access|advisory = ${counts.join("|")}).`);
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
