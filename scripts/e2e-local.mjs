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
 *   stop           Stop and delete the local stack's ephemeral state.
 *
 * The default is ephemeral: the stack is always stopped and its volumes deleted
 * unless E2E_KEEP_LOCAL_STACK=1 is set (a local debugging escape hatch).
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PRODUCTION_SUPABASE_REF = "lioxtgiputfniqbktcsz";
const AUTH_STATE_FILE = resolve(ROOT, "e2e/.auth/user.json");

/** The six authorized read-only specs — the safe default subset for `run`. */
const DEFAULT_SPECS = [
  "e2e/auth.spec.ts",
  "e2e/bulk-actions.spec.ts",
  "e2e/eager-load.spec.ts",
  "e2e/filters.spec.ts",
  "e2e/paper-import.spec.ts",
  "e2e/pools.spec.ts",
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

/**
 * Install bounded SIGINT/SIGTERM handlers for a lifecycle that may own a local
 * stack. On a signal we attempt cleanup exactly once (the shared promise) and
 * exit with the conventional signal-derived status — 130 (SIGINT) / 143
 * (SIGTERM) — staying nonzero even if cleanup itself fails. Installed only by
 * `run`; never by verify-guards or the explicit stop.
 */
function installSignalCleanup() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const onSignal = (signal, code) => {
    process.once(signal, () => {
      log(`received ${signal} — attempting one-time local-stack cleanup…`);
      cleanupLifecycleOnce()
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
  try {
    await startStack();
    await resetLocalDb();

    const { apiUrl, anonKey, serviceRoleKey } = await readLocalStatus();
    log(`validated local API origin: ${apiUrl}`);

    const creds = await seedLocalStack({ apiUrl, anonKey, serviceRoleKey, log });

    // Explicit, in-memory backend contract for the guarded Playwright run.
    const childEnv = {
      ...process.env,
      E2E_BACKEND_MODE: "local",
      E2E_EXPECTED_SUPABASE_URL: apiUrl,
      VITE_SUPABASE_URL: apiUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
      TEST_USER_EMAIL: creds.primary.email,
      TEST_USER_PASSWORD: creds.primary.password,
    };

    log(`running Playwright specs: ${specs.join(", ")}`);
    const code = await runInherit("npx", ["--no-install", "playwright", "test", ...specs], childEnv);
    if (code !== 0) throw new Error(`Playwright run failed (exit ${code}).`);
    log("Playwright run succeeded against the isolated local backend.");
  } catch (err) {
    primaryError = err;
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

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  switch (subcommand) {
    case "run":
      await cmdRun(rest);
      break;
    case "verify-guards":
      await cmdVerifyGuards();
      break;
    case "stop":
      await cmdStop();
      break;
    default:
      fail(`Unknown subcommand "${subcommand ?? ""}". Use: run | verify-guards | stop`);
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
