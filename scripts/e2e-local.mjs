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
 *                  credential is entered), plus a static Layer 2 ordering check,
 *                  and check the Evidence Records fixture selection against
 *                  Playwright's own test listing (EVIDENCE-RECORDS-001C2A).
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
 *                  author-identity merge-cycle refusal, the attachment
 *                  upload-finalization linearization, and the AI model/
 *                  reasoning preference serialization, each with bounded,
 *                  fail-closed coordinator/worker processes whose deadlines all
 *                  start at barrier release → force both orders of each
 *                  study-record NO ACTION edge with a held transaction and a
 *                  blocked waiter (EVIDENCE-RECORDS-001A1) → race the
 *                  study-record lifecycle RPCs the same way, plus
 *                  barrier-released free rounds (EVIDENCE-RECORDS-001A2) →
 *                  verify no
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
import {
  assertStudyRecordOutcomeAndRemove,
  provisionStudyRecordAccounts,
  removeStudyRecordAccounts,
} from "./e2e-local-evidence-fixture.mjs";
import {
  assertStudyReviewOutcomeAndRemove,
  provisionStudyReviewAccounts,
  removeStudyReviewAccounts,
} from "./e2e-local-review-fixture.mjs";
import {
  assertStudyHistoryOutcomeAndRemove,
  provisionStudyHistoryAccounts,
  removeStudyHistoryAccounts,
} from "./e2e-local-history-fixture.mjs";
import {
  assertSourceCompareOutcomeAndRemove,
  provisionSourceCompareAccounts,
  removeSourceCompareAccounts,
} from "./e2e-local-source-compare-fixture.mjs";
import {
  assertRebaseOutcomeAndRemove,
  provisionRebaseAccounts,
  removeRebaseAccounts,
} from "./e2e-local-rebase-fixture.mjs";
import { resolveSpecSelection } from "./e2e-local-spec-selection.mjs";

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
  // only within fixtures it owns: two disposable Projects and three disposable
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
  // EVIDENCE-MATRIX-001B read-only comparison. Mutating only within fixtures it
  // owns: it sweeps and then inserts five synthetic `CMP-E2E` papers through the
  // app's own client in beforeAll, deletes one of them on purpose to show an
  // unavailable paper, and removes every `CMP-E2E` paper through
  // `delete_papers_with_attachment_cleanup` in afterAll — order-independent.
  // Seeded papers are only selected (through year filters), never written. The
  // comparison itself is one Data API SELECT under RLS; no Edge Function, AI
  // provider, RPC or Storage call is made.
  "e2e/paper-comparison.spec.ts",
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
  // CONSENSUS-SEARCH-MVP-001A owner-only Consensus discovery. Mutating, but
  // only within fixtures it owns: it imports papers whose titles all start with
  // "CNS-E2E" through the real Add Papers UI and the real bulk-insert RPC and
  // removes every one of them in afterEach, plus one disposable project and tag
  // created in beforeAll and deleted in afterAll — so it is order-independent.
  // Every external boundary is deterministic: Playwright fulfils
  // `search-consensus` and `fetch-paper-metadata`, and presents the owner role
  // by fulfilling `get_current_user_access` in the owner tests only (the
  // ordinary-user test lets the real local database answer). There is no live
  // Consensus, NCBI or Crossref egress and no served local Edge Function.
  "e2e/consensus-search.spec.ts",
  // SCROLLAREA-HORIZONTAL-REACHABILITY-AUDIT-001 geometry regressions. Mutating
  // only in that each test adds one long fixture keyword to the keyword pool
  // through the real modal and removes it again in afterEach, so it restores the
  // seed within its own run and is order-independent. No papers, projects or
  // tags are touched; no import and no Edge Function.
  "e2e/scrollarea-reachability.spec.ts",
  // UI-TOAST-LIFECYCLE-CONSISTENCY-001 notification lifecycle. Mutating, but
  // only within fixtures it owns: it imports two synthetic papers (nine-digit
  // PMIDs no other spec uses) through the real Add Papers UI and deletes both
  // through the real row control, and it adds one synonym group and removes it
  // again. The sweeps tolerate finding nothing, so it is order-independent and
  // restores the seed within its own run. Playwright fulfils
  // `fetch-paper-metadata` and `rpc/bulk_update_keywords`, so there is no
  // provider egress, no served Edge Function, and the keyword re-evaluation
  // never rewrites the seeded papers' keywords.
  "e2e/toast-lifecycle.spec.ts",
  // AI-MODEL-SELECTION-001C Settings model-selection coverage, extended by
  // AI-MANUAL-REASONING-001 to the manual reasoning control. Mutating, but only
  // within a disposable per-run account it owns outright: the entitled cases
  // save a model AND a reasoning level, exercise the reset paths, and then
  // clear the real `user_ai_preferences` row for that account alone, and the
  // lifecycle proves afterwards that the row is gone. The deterministic primary
  // fixture is used for the NON-entitled cases and never acquires a preference:
  // its one RPC call is refused (`not_entitled`) and writes nothing. No Edge
  // Function is served and no provider request is made — this spec tests
  // preference persistence and UI only.
  "e2e/ai-model-settings.spec.ts",
  // The Evidence Records specs — EVIDENCE-RECORDS-001C1's `e2e/study-records.spec.ts`,
  // 001C2A's `e2e/study-records-review.spec.ts`, 001C2B's
  // `e2e/study-records-history.spec.ts`, 001C2C-A's
  // `e2e/study-records-source-compare.spec.ts` and 001C2C-B's
  // `e2e/study-records-rebase.spec.ts` — are deliberately NOT in this set
  // (CI-E2E-EVIDENCE-LANE-001). The `e2e-evidence` job in
  // .github/workflows/e2e-local.yml runs them on their own runner and stack, so
  // the Evidence Records suite can grow without spending this lane's 30-minute
  // cap. Each mutates only the disposable accounts of its own fixture, which
  // `cmdRun` provisions when Playwright will run that exact file
  // (scripts/e2e-local-spec-selection.mjs); the seed is never touched.
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
  // Which files Playwright will actually run decides which Evidence Records
  // fixtures exist (EVIDENCE-RECORDS-001C2A): resolved with Playwright's own
  // matcher and inert placeholder credentials, before any stack starts — an
  // Evidence Records spec without a fixture of its own fails closed here.
  const selection = await resolveSpecSelection({ specArgs: specs, run: runCapture });
  log(
    `Playwright will run ${selection.files.length} test files; Evidence Records fixtures: ${
      selection.fixtures.size > 0 ? [...selection.fixtures].sort().join(", ") : "none"
    }`,
  );
  let primaryError = null;
  // Set once the disposable PFA-C04 account exists; cleared once it is proven
  // deleted, so the failure path only ever cleans up an account that survived.
  let disposable = null;
  // Set once the disposable ENTITLED model account exists; cleared once its
  // final state is proven and it is removed.
  let modelAccount = null;
  // Set once the EVIDENCE-RECORDS-001C1 study-record accounts exist; cleared
  // once the post-run proof has passed and they are removed.
  let studyAccounts = null;
  // The same for EVIDENCE-RECORDS-001C2A's study-review accounts.
  let reviewAccounts = null;
  // And for EVIDENCE-RECORDS-001C2B's study-history accounts.
  let historyAccounts = null;
  // And for EVIDENCE-RECORDS-001C2C-A's source-comparison accounts.
  let sourceAccounts = null;
  // And for EVIDENCE-RECORDS-001C2C-B's rebase accounts.
  let rebaseAccounts = null;
  // Fixture rows are written and verified as the local database owner, never
  // through the secret key (C57): see openLocalOwnerSql.
  let ownerSql = null;
  try {
    await startStack();
    await resetLocalDb();

    const { apiUrl, anonKey, serviceRoleKey } = await readLocalStatus();
    log(`validated local API origin: ${apiUrl}`);

    ownerSql = await openLocalOwnerSql();

    const creds = await seedLocalStack({ apiUrl, anonKey, serviceRoleKey, ownerSql, log });

    // PFA-C04 destructive fixture: a disposable account this run owns outright.
    // Provisioned only when the destructive spec is actually scheduled, so a
    // targeted read-only spec run creates no extra identity. The elevated key
    // stays in THIS process and is never added to the Playwright environment.
    const runsDeletionSpec = specs.some((spec) => spec.includes("account-deletion"));
    disposable = runsDeletionSpec
      ? await provisionDisposableAccount({ apiUrl, anonKey, serviceRoleKey, ownerSql, log })
      : null;

    // AI-MODEL-SELECTION-001C entitled fixture. The seeded users are Free with
    // the capability flag false — exactly what the spec's non-entitled cases
    // need — so entitlement is granted to a SEPARATE disposable account through
    // a server-side entitlement write, never by changing the seed. Provisioned
    // only when the model spec is actually scheduled.
    const runsModelSpec = specs.some((spec) => spec.includes("ai-model-settings"));
    modelAccount = runsModelSpec
      ? await provisionEntitledModelAccount({ apiUrl, anonKey, serviceRoleKey, ownerSql, log })
      : null;

    // EVIDENCE-RECORDS-001C1 study-record accounts: the pilot owner role is a
    // server-side row in the LOCAL `internal_user_access`, granted to disposable
    // users only — never to a seed identity, never in Production. Provisioned
    // only when Playwright will run `study-records.spec.ts` itself.
    studyAccounts = selection.fixtures.has("study-records")
      ? await provisionStudyRecordAccounts({ apiUrl, anonKey, serviceRoleKey, ownerSql, log })
      : null;

    // EVIDENCE-RECORDS-001C2A study-review accounts: the same pilot role, on
    // accounts of their own, provisioned only when Playwright will run
    // `study-records-review.spec.ts`.
    reviewAccounts = selection.fixtures.has("study-records-review")
      ? await provisionStudyReviewAccounts({ apiUrl, anonKey, serviceRoleKey, ownerSql, log })
      : null;

    // EVIDENCE-RECORDS-001C2B study-history accounts: the same pilot role, on
    // accounts of their own, provisioned only when Playwright will run
    // `study-records-history.spec.ts`. Their history is written by the real
    // RPCs, never inserted.
    historyAccounts = selection.fixtures.has("study-records-history")
      ? await provisionStudyHistoryAccounts({ apiUrl, anonKey, serviceRoleKey, ownerSql, log })
      : null;

    // EVIDENCE-RECORDS-001C2C-A source-comparison accounts: the same pilot
    // role, on accounts of their own, provisioned only when Playwright will
    // run `study-records-source-compare.spec.ts`. Their copies are made by the
    // installed RPCs and their library edits are the owner's own, never inserted.
    sourceAccounts = selection.fixtures.has("study-records-source-compare")
      ? await provisionSourceCompareAccounts({ apiUrl, anonKey, serviceRoleKey, ownerSql, log })
      : null;

    // EVIDENCE-RECORDS-001C2C-B rebase accounts: the same pilot role, on
    // accounts of their own, provisioned only when Playwright will run
    // `study-records-rebase.spec.ts`. Their copies, reviews and earlier rebases
    // are made by the installed RPCs, never inserted.
    rebaseAccounts = selection.fixtures.has("study-records-rebase")
      ? await provisionRebaseAccounts({ apiUrl, anonKey, serviceRoleKey, ownerSql, log })
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
      ...(studyAccounts
        ? {
            E2E_STUDY_OWNER_EMAIL: studyAccounts.owner.email,
            E2E_STUDY_OWNER_PASSWORD: studyAccounts.owner.password,
            E2E_STUDY_FORMER_EMAIL: studyAccounts.former.email,
            E2E_STUDY_FORMER_PASSWORD: studyAccounts.former.password,
          }
        : {}),
      ...(reviewAccounts
        ? {
            E2E_STUDY_REVIEW_OWNER_EMAIL: reviewAccounts.owner.email,
            E2E_STUDY_REVIEW_OWNER_PASSWORD: reviewAccounts.owner.password,
            E2E_STUDY_REVIEW_FORMER_EMAIL: reviewAccounts.former.email,
            E2E_STUDY_REVIEW_FORMER_PASSWORD: reviewAccounts.former.password,
          }
        : {}),
      ...(historyAccounts
        ? {
            E2E_STUDY_HISTORY_OWNER_EMAIL: historyAccounts.owner.email,
            E2E_STUDY_HISTORY_OWNER_PASSWORD: historyAccounts.owner.password,
            E2E_STUDY_HISTORY_FORMER_EMAIL: historyAccounts.former.email,
            E2E_STUDY_HISTORY_FORMER_PASSWORD: historyAccounts.former.password,
          }
        : {}),
      ...(sourceAccounts
        ? {
            E2E_STUDY_SOURCE_OWNER_EMAIL: sourceAccounts.owner.email,
            E2E_STUDY_SOURCE_OWNER_PASSWORD: sourceAccounts.owner.password,
            E2E_STUDY_SOURCE_FORMER_EMAIL: sourceAccounts.former.email,
            E2E_STUDY_SOURCE_FORMER_PASSWORD: sourceAccounts.former.password,
          }
        : {}),
      ...(rebaseAccounts
        ? {
            E2E_STUDY_REBASE_OWNER_EMAIL: rebaseAccounts.owner.email,
            E2E_STUDY_REBASE_OWNER_PASSWORD: rebaseAccounts.owner.password,
            E2E_STUDY_REBASE_FORMER_EMAIL: rebaseAccounts.former.email,
            E2E_STUDY_REBASE_FORMER_PASSWORD: rebaseAccounts.former.password,
          }
        : {}),
    };

    log(`running Playwright specs: ${specs.join(", ")}`);
    const code = await runInherit("npx", ["--no-install", "playwright", "test", ...specs], childEnv);
    if (code !== 0) throw new Error(`Playwright run failed (exit ${code}).`);
    log("Playwright run succeeded against the isolated local backend.");

    // Authoritative destructive proof. The spec asserts what the browser can
    // see; this asserts what only the elevated local connections can: the Auth
    // user, every owned row, and every Storage object in the account's
    // namespace are gone. A survivor fails the lifecycle even though Playwright
    // was green.
    if (disposable) {
      await assertDisposableAccountRemoved({ apiUrl, serviceRoleKey, ownerSql, account: disposable, log });
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

    // What only the database can see: the refused delete and merge changed no
    // assignment, attachment or cleanup job; the deleted records are gone and
    // their papers stay. Then both accounts are removed.
    if (studyAccounts) {
      await assertStudyRecordOutcomeAndRemove({ apiUrl, serviceRoleKey, ownerSql, accounts: studyAccounts, log });
      studyAccounts = null; // proven and removed
      log("study-records E2E verified: refusals left the papers intact and fixture accounts removed.");
    }

    // What only the database can see of Review: each value's review status,
    // note, versions and review events, the refused reviews recording nothing,
    // and the former owner's record unchanged. Then both accounts are removed,
    // and their removal is verified.
    if (reviewAccounts) {
      await assertStudyReviewOutcomeAndRemove({ apiUrl, serviceRoleKey, ownerSql, accounts: reviewAccounts, log });
      reviewAccounts = null; // proven, removed, and the removal verified
      log("study-records-review E2E verified: reviews recorded exactly as made, refusals recorded nothing, fixture accounts removed.");
    }

    // What only the database can see of History: every committed operation of
    // the history study, version by version, with its own change events — the
    // fixture's and exactly the spec's, so the viewer wrote nothing — the record
    // created in the browser, and the former owner's record unchanged. Then both
    // accounts are removed, and their removal is verified.
    if (historyAccounts) {
      await assertStudyHistoryOutcomeAndRemove({ apiUrl, serviceRoleKey, ownerSql, accounts: historyAccounts, log });
      historyAccounts = null; // proven, removed, and the removal verified
      log("study-records-history E2E verified: every operation recorded once, in order, with its own events; the viewer wrote nothing; fixture accounts removed.");
    }

    // What only the database can see of the comparison: both users' study
    // records exactly as provisioned — no copy, quote, value, review, version
    // or event written — and the library as provisioned but for the spec's own
    // edit. Then both accounts are removed, and their removal is verified.
    if (sourceAccounts) {
      await assertSourceCompareOutcomeAndRemove({ apiUrl, serviceRoleKey, ownerSql, accounts: sourceAccounts, log });
      sourceAccounts = null; // proven, removed, and the removal verified
      log("study-records-source-compare E2E verified: comparing wrote nothing; fixture accounts removed.");
    }

    // What only the database can see of the rebase: each one the spec made —
    // its version, copies (the earlier ones unchanged), quote offsets, reviews
    // and one request's events — and every other record exactly as
    // provisioned. Then both accounts are removed, and their removal is verified.
    if (rebaseAccounts) {
      await assertRebaseOutcomeAndRemove({ apiUrl, serviceRoleKey, ownerSql, accounts: rebaseAccounts, log });
      rebaseAccounts = null; // proven, removed, and the removal verified
      log("study-records-rebase E2E verified: each rebase written once, as the server records it; nothing else written; fixture accounts removed.");
    }
  } catch (err) {
    primaryError = err;
    // A failed run may have left the disposable account behind. Remove it
    // best-effort so a debugging session with E2E_KEEP_LOCAL_STACK=1 does not
    // accumulate residue; the deterministic fixtures are never touched.
    if (disposable || modelAccount || studyAccounts || reviewAccounts || historyAccounts || sourceAccounts || rebaseAccounts) {
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
      if (target && studyAccounts) {
        await removeStudyRecordAccounts({
          apiUrl: target.apiUrl,
          serviceRoleKey: target.serviceRoleKey,
          accounts: studyAccounts,
          log,
        });
      }
      if (target && reviewAccounts && ownerSql) {
        // Verified removal: a survivor is reported (the run has failed already; the first error is kept).
        await removeStudyReviewAccounts({
          apiUrl: target.apiUrl,
          serviceRoleKey: target.serviceRoleKey,
          ownerSql,
          accounts: reviewAccounts,
          log,
        }).catch((cleanupErr) => fail(`study-review fixture cleanup: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`));
      }
      if (target && historyAccounts && ownerSql) {
        // Verified removal, as for the review accounts: a survivor is reported, and the first error is kept.
        await removeStudyHistoryAccounts({
          apiUrl: target.apiUrl,
          serviceRoleKey: target.serviceRoleKey,
          ownerSql,
          accounts: historyAccounts,
          log,
        }).catch((cleanupErr) => fail(`study-history fixture cleanup: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`));
      }
      if (target && sourceAccounts && ownerSql) {
        // Verified removal, as for the history accounts: a survivor is reported, and the first error is kept.
        await removeSourceCompareAccounts({
          apiUrl: target.apiUrl,
          serviceRoleKey: target.serviceRoleKey,
          ownerSql,
          accounts: sourceAccounts,
          log,
        }).catch((cleanupErr) => fail(`source-compare fixture cleanup: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`));
      }
      if (target && rebaseAccounts && ownerSql) {
        // Verified removal, as for the source-comparison accounts: a survivor is reported, and the first error is kept.
        await removeRebaseAccounts({
          apiUrl: target.apiUrl,
          serviceRoleKey: target.serviceRoleKey,
          ownerSql,
          accounts: rebaseAccounts,
          log,
        }).catch((cleanupErr) => fail(`rebase fixture cleanup: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`));
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

  // 1. Pure guard unit tests, and the Evidence Records fixture selection's (C2A).
  log("running pure guard unit tests…");
  const unit = await runInherit("npx", [
    "--no-install",
    "vitest",
    "run",
    "e2e/support/backend-guard.test.ts",
    "e2e/support/spec-selection.test.ts",
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

  // 4. Evidence Records fixture selection against Playwright's own listing
  //    (EVIDENCE-RECORDS-001C2A): a run's fixtures follow the files it will
  //    execute — by exact file and case-insensitively, never by a substring of
  //    the arguments. Inert placeholder credentials only; nothing is printed.
  log("checking Evidence Records fixture selection against Playwright's listing…");
  const selections = [
    [["e2e/study-records.spec.ts"], ["study-records"]],
    [["e2e/study-records-review.spec.ts"], ["study-records-review"]],
    [["e2e/study-records-history.spec.ts"], ["study-records-history"]],
    [["e2e/study-records-source-compare.spec.ts"], ["study-records-source-compare"]],
    [["e2e/study-records-rebase.spec.ts"], ["study-records-rebase"]],
    [["E2E/STUDY-RECORDS"], ["study-records", "study-records-history", "study-records-rebase", "study-records-review", "study-records-source-compare"]],
    [["e2e/auth.spec.ts"], []],
  ];
  for (const [specArgs, expected] of selections) {
    const { fixtures } = await resolveSpecSelection({ specArgs, run: runCapture });
    const got = [...fixtures].sort();
    if (got.join(",") !== expected.join(",")) {
      throw new Error(`Fixture selection for ${JSON.stringify(specArgs)} is [${got.join(", ")}]; expected [${expected.join(", ")}].`);
    }
  }
  log("fixture selection OK: each Evidence Records spec gets its own fixture, and only when Playwright will run it.");

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

  // The hosted-Production ACL parity lane replays from a migration baseline.
  const reset = await runCapture("supabase", ["db", "reset", "--help"]);
  if (reset.code !== 0 || !/--version\b/.test(reset.out)) {
    throw new Error("`supabase db reset` does not support --version; the hosted ACL parity lane cannot replay from a baseline.");
  }
  const up = await runCapture("supabase", ["migration", "up", "--help"]);
  if (up.code !== 0 || !/--local\b/.test(up.out)) {
    throw new Error("`supabase migration up` does not support --local; the hosted ACL parity lane cannot apply the migration under test.");
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
 * The E2E fixtures' database connection: the local database owner, over the
 * local container's socket (SERVICE-ROLE-LEAST-PRIVILEGE-HARDENING-001, C57).
 *
 * `service_role` — the secret key's role — holds no privilege on any
 * application table — locally, and in Production once C57 is applied — so seeding papers,
 * setting an entitlement flag and proving an account's rows are gone are done
 * as `postgres` instead: infrastructure administration, the boundary operator
 * SQL uses in Production. The secret key stays in use only for Auth
 * administration and Storage, which is what Production's delete-account uses
 * it for.
 *
 * It is the same `docker exec … psql` path every db-tests probe uses. There is
 * no connection URL, host or password: the target is the one container
 * `resolveLocalDbContainer()` validated, so it cannot reach a remote database,
 * and the identity check below refuses anything but `postgres` on the local
 * socket. Every script runs with `standard_conforming_strings` on, which the
 * fixtures' `sqlLiteral` relies on.
 */
async function openLocalOwnerSql() {
  const container = await resolveLocalDbContainer();
  const run = async (sql) => {
    const r = await dockerPsql(container, `SET standard_conforming_strings = on;\n${sql}`);
    if (r.code !== 0) {
      throw new Error(`local fixture SQL failed: ${(r.err || "").trim().slice(0, 400) || "(no stderr)"}`);
    }
    return r.out.trim();
  };
  const identity = await run("SELECT current_user || '|' || coalesce(inet_server_addr()::text, 'local-socket');");
  if (identity !== "postgres|local-socket") {
    throw new Error(`local fixture connection is "${identity}", not postgres on the local socket; refusing.`);
  }
  return run;
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
    // Since C56 a function postgres creates — pg_temp included — is owner-only
    // until granted, so the caller's EXECUTE is stated explicitly.
    `GRANT EXECUTE ON FUNCTION pg_temp.try_merge(uuid, uuid) TO authenticated;\n` +
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

// ── EVIDENCE-RECORDS-001A1 ───────────────────────────────────────────────────
// The three ON DELETE NO ACTION edges of the study-record schema under real
// concurrency. Its own user, papers and study; no barrier lock — each case is
// one held transaction and one waiter, observed through pg_blocking_pids.
const EV_PROBE_USER = "cc0000ee-0000-0000-0000-0000000000a0";
const EV_STUDY = "cc0000ee-0000-0000-0000-0000000000b0";
const EV_PAPER_LINKED = "cc0000ee-0000-0000-0000-0000000000c1"; // C1, C2: unlink vs reference
const EV_PAPER_RACED = "cc0000ee-0000-0000-0000-0000000000c2"; // C3, C4: paper delete vs link
const EV_COPY = "cc0000ee-0000-0000-0000-0000000000d0";
const EV_VALUE = "cc0000ee-0000-0000-0000-0000000000e0";
const EV_QUOTE = "cc0000ee-0000-0000-0000-0000000000f0";

function evClaimsSql() {
  return `PERFORM set_config('request.jwt.claims','{"sub":"${EV_PROBE_USER}","role":"authenticated"}', true);`;
}

/**
 * A waiter session: print its pid, run `body` (PL/pgSQL statements) in a
 * subtransaction, and print exactly one `OUTCOME=<sqlstate>:<constraint>` line
 * whether the body succeeded or raised — so the expected 23503 is data, not a
 * psql failure.
 */
function evWaiterSql(body) {
  return (
    "SELECT 'PID=' || pg_backend_pid();\n" +
    "CREATE TEMP TABLE ev_outcome (v text);\n" +
    "DO $w$\nDECLARE v_state text; v_con text;\nBEGIN\n  BEGIN\n" +
    body +
    "\n    RESET ROLE;\n    v_state := '00000'; v_con := '';\n" +
    "  EXCEPTION WHEN others THEN\n" +
    "    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_con = CONSTRAINT_NAME;\n" +
    "  END;\n  INSERT INTO ev_outcome VALUES (v_state || ':' || coalesce(v_con, ''));\nEND\n$w$;\n" +
    "SELECT 'OUTCOME=' || v FROM ev_outcome;\n"
  );
}

/** Rows that decide each case's end state, read on a fresh connection. */
async function evState(container) {
  return dbScalar(
    container,
    `SELECT format('refs=%s link_c1=%s copy=%s paper_c2=%s link_c2=%s queue=%s', ` +
      `(SELECT count(*) FROM public.evidence_field_anchors WHERE user_id='${EV_PROBE_USER}'), ` +
      `(SELECT count(*) FROM public.evidence_study_reports WHERE user_id='${EV_PROBE_USER}' AND paper_id='${EV_PAPER_LINKED}'), ` +
      `(SELECT count(*) FROM public.evidence_source_snapshots WHERE user_id='${EV_PROBE_USER}'), ` +
      `(SELECT count(*) FROM public.papers WHERE id='${EV_PAPER_RACED}'), ` +
      `(SELECT count(*) FROM public.evidence_study_reports WHERE user_id='${EV_PROBE_USER}' AND paper_id='${EV_PAPER_RACED}'), ` +
      `(SELECT count(*) FROM public.attachment_cleanup_queue WHERE user_id='${EV_PROBE_USER}'));`,
  );
}

/**
 * One forced order: `holderSql` runs in an open transaction and stays open;
 * the waiter must then be observed blocked BY THAT HOLDER (pg_blocking_pids),
 * must not finish while the holder is open, and after the holder commits must
 * report exactly `expected`. Every process is tracked and bounded.
 */
async function runEvidenceRaceCase(container, label, holderSql, waiterBody, expected) {
  let held = null;
  let waiter = null;
  try {
    held = spawnDockerPsql(container);
    held.child.stdin.write("BEGIN;\n" + holderSql + "SELECT 'PID=' || pg_backend_pid();\nSELECT 'HELD_READY';\n");
    await waitUntil(() => /HELD_READY/.test(held.readOut()), PROBE_WORKER_MS,
      `evidence race ${label}: the held transaction never completed its work.`);
    const holderPid = plPid(held.readOut());

    waiter = spawnDockerPsql(container);
    waiter.child.stdin.write(evWaiterSql(waiterBody));
    waiter.child.stdin.end();
    await waitUntil(() => plPid(waiter.readOut()) !== null, PROBE_WORKER_MS,
      `evidence race ${label}: the waiter never reported its pid.`);
    const waiterPid = plPid(waiter.readOut());
    await waitUntil(
      async () => (await dbScalar(container, `SELECT ${holderPid} = ANY (pg_blocking_pids(${waiterPid}));`)) === "t",
      PROBE_BARRIER_MS,
      `evidence race ${label}: the waiter was never blocked by the held transaction.`,
    );
    if (/OUTCOME=/.test(waiter.readOut())) {
      throw new Error(`evidence race ${label}: the waiter finished while the holder was still open.`);
    }

    held.child.stdin.write("COMMIT;\nSELECT 'HELD_COMMITTED';\n");
    held.child.stdin.end();
    const [heldRes, waitRes] = await Promise.all([
      withTimeout(held.done, FIN_HOLD_MS, `evidence race ${label} held-transaction exit`),
      withTimeout(waiter.done, FIN_HOLD_MS, `evidence race ${label} waiter exit`),
    ]);
    held = null;
    waiter = null;
    if (heldRes.code !== 0 || heldRes.signal !== null || !/HELD_COMMITTED/.test(heldRes.out)) {
      throw new Error(`evidence race ${label}: the held transaction did not commit cleanly (code=${heldRes.code}).`);
    }
    if (waitRes.code !== 0 || waitRes.signal !== null) {
      throw new Error(`evidence race ${label}: the waiter did not exit cleanly (code=${waitRes.code}).`);
    }
    const outcome = parseProbeOutcome(waitRes);
    if (outcome !== expected) {
      throw new Error(`evidence race ${label}: the waiter reported "${outcome}", expected "${expected}".`);
    }
  } catch (err) {
    await killPsql(waiter);
    await killPsql(held);
    throw err;
  }
}

/**
 * True-concurrency probe of the study-record NO ACTION edges
 * (EVIDENCE-RECORDS-001A1; FK-PROOF-001 C1-C4, repeated against the real
 * schema). For each edge, both orders are forced: whichever transaction holds
 * the row first, the other waits on it and then fails closed with 23503 —
 * never a deadlock, never a dangling reference, never a deleted paper with a
 * live link.
 *
 *   C1 a quote is being added   -> an unlink waits, then is refused
 *   C2 an unlink is in flight   -> a new reference waits, then is refused
 *   C3 a link is being added    -> the client paper-delete RPC waits, then is refused
 *   C4 the paper-delete RPC is in flight -> a new link waits, then is refused
 */
async function runEvidenceForeignKeyRaceProbe(container) {
  log("running true-concurrency evidence foreign-key race probe (C1-C4)…");

  const text = "Race probe abstract.";
  const setup = await dockerPsql(
    container,
    `INSERT INTO auth.users (id, email) VALUES ('${EV_PROBE_USER}','evidence-race@paperlume.test');\n` +
      `INSERT INTO public.papers (id, user_id, title, keywords, insert_order) VALUES\n` +
      `  ('${EV_PAPER_LINKED}','${EV_PROBE_USER}','Evidence race linked','[]'::jsonb,1),\n` +
      `  ('${EV_PAPER_RACED}','${EV_PROBE_USER}','Evidence race raced','[]'::jsonb,2);\n` +
      `INSERT INTO public.evidence_studies (id, user_id, label, design_profile) VALUES ('${EV_STUDY}','${EV_PROBE_USER}','Race study','rct_parallel');\n` +
      `INSERT INTO public.evidence_study_reports (user_id, study_id, paper_id, link_status, link_basis) VALUES ('${EV_PROBE_USER}','${EV_STUDY}','${EV_PAPER_LINKED}','user_confirmed','created_from_paper');\n` +
      `INSERT INTO public.evidence_source_snapshots (id, user_id, study_id, paper_id, seq, source_kind, exact_text, exact_sha256, normalized_sha256, normalization_version, char_count) ` +
      `VALUES ('${EV_COPY}','${EV_PROBE_USER}','${EV_STUDY}','${EV_PAPER_LINKED}',1,'library_abstract','${text}',sha256(convert_to('${text}','UTF8')),sha256(convert_to('${text}','UTF8')),'v1',char_length('${text}'));\n` +
      `INSERT INTO public.evidence_field_values (id, user_id, study_id, field_key, value_state, value_text) VALUES ('${EV_VALUE}','${EV_PROBE_USER}','${EV_STUDY}','condition','reported','Race condition');\n`,
  );
  if (setup.code !== 0) throw new Error(`evidence race fixture setup failed: ${setup.err.trim()}`);

  // C1 — the quote holds KEY SHARE on the link (its FK check); the unlink waits.
  await runEvidenceRaceCase(container, "C1",
    `INSERT INTO public.evidence_field_anchors (id, user_id, study_id, value_id, paper_id, snapshot_id, purpose, source_kind, position, quote_text, match_start, match_end, match_occurrence, match_count, normalization_version, matched_at) ` +
      `VALUES ('${EV_QUOTE}','${EV_PROBE_USER}','${EV_STUDY}','${EV_VALUE}','${EV_PAPER_LINKED}','${EV_COPY}','supports','abstract',0,'Race probe',0,10,1,1,'v1',now());\n`,
    `    DELETE FROM public.evidence_study_reports WHERE user_id='${EV_PROBE_USER}' AND study_id='${EV_STUDY}' AND paper_id='${EV_PAPER_LINKED}';`,
    "23503:evidence_field_anchors_link_fkey");
  let state = await evState(container);
  if (!state.startsWith("refs=1 link_c1=1 copy=1 ")) {
    throw new Error(`evidence race C1: expected the quote committed and the link intact, got ${state}.`);
  }
  log("evidence race C1 OK: the unlink waited for the quote, then was refused (link and quote intact).");

  // C2 — the unlink is in flight (the quote removed first); a new reference waits.
  await runEvidenceRaceCase(container, "C2",
    `DELETE FROM public.evidence_field_anchors WHERE id='${EV_QUOTE}';\n` +
      `DELETE FROM public.evidence_study_reports WHERE user_id='${EV_PROBE_USER}' AND study_id='${EV_STUDY}' AND paper_id='${EV_PAPER_LINKED}';\n`,
    `    INSERT INTO public.evidence_field_anchors (user_id, study_id, value_id, paper_id, purpose, source_kind, position, locator_kind, locator_text) ` +
      `VALUES ('${EV_PROBE_USER}','${EV_STUDY}','${EV_VALUE}','${EV_PAPER_LINKED}','supports','full_text',0,'page','4');`,
    "23503:evidence_field_anchors_link_fkey");
  state = await evState(container);
  if (!state.startsWith("refs=0 link_c1=0 copy=0 ")) {
    throw new Error(`evidence race C2: expected the link and its copy gone and no reference, got ${state}.`);
  }
  log("evidence race C2 OK: the reference waited for the unlink, then was refused (no dangling reference).");

  // C3 — the link holds KEY SHARE on the paper; the client delete RPC waits.
  await runEvidenceRaceCase(container, "C3",
    `INSERT INTO public.evidence_study_reports (user_id, study_id, paper_id, link_status, link_basis) VALUES ('${EV_PROBE_USER}','${EV_STUDY}','${EV_PAPER_RACED}','user_confirmed','user_linked');\n`,
    `    ${evClaimsSql()}\n    SET LOCAL ROLE authenticated;\n` +
      `    PERFORM * FROM public.delete_papers_with_attachment_cleanup(ARRAY['${EV_PAPER_RACED}']::uuid[]);`,
    "23503:evidence_study_reports_paper_fkey");
  state = await evState(container);
  if (!state.endsWith("paper_c2=1 link_c2=1 queue=0")) {
    throw new Error(`evidence race C3: expected the paper and its link kept and no cleanup intent, got ${state}.`);
  }
  log("evidence race C3 OK: the paper delete waited for the link, then was refused (paper and link kept).");

  // Unlink again so C4's delete can start from an unlinked paper.
  const unlink = await dockerPsql(container,
    `DELETE FROM public.evidence_study_reports WHERE user_id='${EV_PROBE_USER}' AND paper_id='${EV_PAPER_RACED}';\n`);
  if (unlink.code !== 0) throw new Error(`evidence race: could not reset between C3 and C4: ${unlink.err.trim()}`);

  // C4 — the delete RPC is in flight; a new link waits on the deleted paper row.
  await runEvidenceRaceCase(container, "C4",
    `SELECT set_config('request.jwt.claims','{"sub":"${EV_PROBE_USER}","role":"authenticated"}', true);\n` +
      `SET LOCAL ROLE authenticated;\n` +
      `SELECT * FROM public.delete_papers_with_attachment_cleanup(ARRAY['${EV_PAPER_RACED}']::uuid[]);\n` +
      `RESET ROLE;\n`,
    `    INSERT INTO public.evidence_study_reports (user_id, study_id, paper_id, link_status, link_basis) VALUES ('${EV_PROBE_USER}','${EV_STUDY}','${EV_PAPER_RACED}','user_confirmed','user_linked');`,
    "23503:evidence_study_reports_paper_fkey");
  state = await evState(container);
  if (!state.endsWith("paper_c2=0 link_c2=0 queue=0")) {
    throw new Error(`evidence race C4: expected the paper gone and no link to it, got ${state}.`);
  }
  log("evidence race C4 OK: the link waited for the paper delete, then was refused (no link to a deleted paper).");

  // Remove the fixture through the account cascade, and prove it is gone.
  const cleanup = await dockerPsql(container, `DELETE FROM auth.users WHERE id='${EV_PROBE_USER}';\n`);
  if (cleanup.code !== 0) throw new Error(`evidence race fixture cleanup failed: ${cleanup.err.trim()}`);
  const residual = await dbScalar(container,
    `SELECT (SELECT count(*) FROM auth.users WHERE id='${EV_PROBE_USER}') + ` +
    `(SELECT count(*) FROM public.papers WHERE user_id='${EV_PROBE_USER}') + ` +
    `(SELECT count(*) FROM public.evidence_studies WHERE user_id='${EV_PROBE_USER}') + ` +
    `(SELECT count(*) FROM public.evidence_study_reports WHERE user_id='${EV_PROBE_USER}') + ` +
    `(SELECT count(*) FROM public.evidence_source_snapshots WHERE user_id='${EV_PROBE_USER}') + ` +
    `(SELECT count(*) FROM public.evidence_field_values WHERE user_id='${EV_PROBE_USER}') + ` +
    `(SELECT count(*) FROM public.evidence_field_anchors WHERE user_id='${EV_PROBE_USER}');`);
  if (residual !== "0") throw new Error(`evidence race fixture not fully removed (${residual} row(s) remain).`);
}

// ── EVIDENCE-RECORDS-001A2 ───────────────────────────────────────────────────
// The study-record lifecycle RPCs under real concurrency, called exactly as a
// client calls them: as `authenticated`, with an owner's JWT claims. Request
// idempotency (FK-PROOF-001 I-1), optimistic concurrency, deletion and paper
// protection. Its own owner, papers, request ids and barrier key.
const EL_OWNER = "cc0000ef-0000-0000-0000-0000000000a0";
const EL_PAPER_A = "cc0000ef-0000-0000-0000-0000000000c1"; // the studies under race
const EL_PAPER_B = "cc0000ef-0000-0000-0000-0000000000c2"; // a create holds it; the paper delete waits
const EL_PAPER_C = "cc0000ef-0000-0000-0000-0000000000c3"; // the paper delete holds it; a create waits
const EL_BARRIER_KEY = 918273649;
const EL_BARRIER_OBJID = EL_BARRIER_KEY & 0xffffffff;
const EL_BARRIER_CLASSID = Math.floor(EL_BARRIER_KEY / 2 ** 32);
const EL_FREE_ROUNDS = 5; // barrier-released rounds per free race, after the forced orders.

/** One deterministic request id per probe step. */
function elRq(n) {
  return `cc0000f0-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
}

/** The RPC calls, as SQL expressions. Labels are plain ASCII without quotes. */
const elCall = {
  create: (paper, label, req) =>
    `public.evidence_create_study_from_paper('${paper}'::uuid, '${label}', 'rct_parallel', 'user_confirmed', '${req}'::uuid)`,
  update: (study, version, label, req) =>
    `public.evidence_update_study('${study}'::uuid, ${version}, '${label}', 'rct_parallel', NULL, '${req}'::uuid)`,
  remove: (study, version, req) => `public.evidence_delete_study('${study}'::uuid, ${version}, '${req}'::uuid)`,
  deletePaper: (paper) =>
    `(SELECT deleted_count || '/' || queued_count FROM public.delete_papers_with_attachment_cleanup(ARRAY['${paper}']::uuid[]))`,
};

function elClaimsSql(owner = EL_OWNER) {
  return `set_config('request.jwt.claims', '{"sub":"${owner}","role":"authenticated"}', true)`;
}

/**
 * A session that makes one call as the owner and prints exactly one
 * `${tag}=OK <result>` or `${tag}=ERR <SQLSTATE> <message>` line, whether the
 * call succeeded or raised — so an expected refusal is data, not a psql
 * failure. A refused call rolls back in its own subtransaction.
 */
function elSessionSql(tag, callExpr, { isolation = null, owner = EL_OWNER } = {}) {
  return (
    "SELECT 'PID=' || pg_backend_pid();\n" +
    "CREATE TEMP TABLE el_outcome (v text);\n" +
    (isolation ? `BEGIN ISOLATION LEVEL ${isolation};\n` : "") +
    "DO $w$\nDECLARE v_out text; v_state text; v_msg text;\nBEGIN\n  BEGIN\n" +
    `    PERFORM ${elClaimsSql(owner)};\n` +
    "    SET LOCAL ROLE authenticated;\n" +
    `    v_out := 'OK ' || (${callExpr})::text;\n` +
    "    RESET ROLE;\n" +
    "  EXCEPTION WHEN others THEN\n" +
    "    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;\n" +
    "    v_out := 'ERR ' || v_state || ' ' || v_msg;\n" +
    "  END;\n  INSERT INTO el_outcome VALUES (v_out);\nEND\n$w$;\n" +
    (isolation ? "COMMIT;\n" : "") +
    `SELECT '${tag}=' || v FROM el_outcome;\n`
  );
}

/** The held transaction: one call as the owner, then stay open. */
function elHolderSql(callExpr, owner = EL_OWNER) {
  return (
    "BEGIN;\n" +
    `SELECT ${elClaimsSql(owner)};\n` +
    "SET LOCAL ROLE authenticated;\n" +
    `SELECT 'HELD=' || (${callExpr})::text;\n` +
    "RESET ROLE;\n" +
    "SELECT 'PID=' || pg_backend_pid();\n" +
    "SELECT 'HELD_READY';\n"
  );
}

/** The study id an answer names, or null. */
function elStudyOf(line) {
  const m = /"study_id": "([0-9a-f-]{36})"/.exec(`${line}`);
  return m ? m[1] : null;
}

/** The status an answer reports, or the whole line. */
function elStatusOf(line) {
  const m = /"status": "([a-z_]+)"/.exec(`${line}`);
  return m ? m[1] : `${line}`;
}

async function elCount(container, sql) {
  return dbScalar(container, `SELECT count(*) FROM ${sql};`);
}

/** `row_version:label` of one study, or GONE. Read on a fresh connection. */
function elVersion(container, study) {
  return dbScalar(container,
    `SELECT coalesce((SELECT row_version::text || ':' || label FROM public.evidence_studies WHERE id='${study}'), 'GONE');`);
}

function elHeaders(container, req) {
  return elCount(container,
    `public.evidence_events WHERE user_id='${EL_OWNER}' AND request_id='${req}' AND ordinal=0`);
}

function elLabelled(container, label) {
  return elCount(container, `public.evidence_studies WHERE user_id='${EL_OWNER}' AND label='${label}'`);
}

/** Every evidence row of one study, across the eight tables. */
function elStudyRows(container, study) {
  return dbScalar(container,
    `SELECT (SELECT count(*) FROM public.evidence_studies WHERE id='${study}') + ` +
      ["evidence_study_reports", "evidence_source_snapshots", "evidence_arms", "evidence_outcomes",
        "evidence_field_values", "evidence_field_anchors", "evidence_events"]
        .map((t) => `(SELECT count(*) FROM public.${t} WHERE study_id='${study}')`).join(" + ") + ";");
}

/**
 * One forced order. `holderCall` runs in an open transaction and stays open;
 * the waiter must then be observed blocked BY THAT HOLDER, on a lock of one of
 * `lockTypes` (advisory for the request and per-user locks, transactionid for
 * a row), must not finish while the holder is open, and after the holder
 * commits must report a line matching `expected`. Every process is tracked and
 * bounded. Returns both sessions' result lines and the lock waited on.
 */
async function runElForcedOrder(container, label, holderCall, waiterCall, lockTypes, expected,
  { holderSql = null, waiterSql = null, name = "evidence lifecycle race" } = {}) {
  let held = null;
  let waiter = null;
  try {
    held = spawnDockerPsql(container);
    held.child.stdin.write(holderSql ?? elHolderSql(holderCall));
    await waitUntil(() => /HELD_READY/.test(held.readOut()), PROBE_WORKER_MS,
      `${name} ${label}: the held transaction never completed its call.`);
    const holderPid = plPid(held.readOut());
    const heldLine = plOutcome(held.readOut(), "HELD");

    waiter = spawnDockerPsql(container);
    waiter.child.stdin.write(waiterSql ?? elSessionSql("WAITER", waiterCall));
    waiter.child.stdin.end();
    await waitUntil(() => plPid(waiter.readOut()) !== null, PROBE_WORKER_MS,
      `${name} ${label}: the waiter never reported its pid.`);
    const waiterPid = plPid(waiter.readOut());
    await waitUntil(
      async () => (await dbScalar(container, `SELECT ${holderPid} = ANY (pg_blocking_pids(${waiterPid}));`)) === "t",
      PROBE_BARRIER_MS,
      `${name} ${label}: the waiter was never blocked by the held transaction.`,
    );
    const waitingOn = await dbScalar(container,
      `SELECT coalesce(string_agg(DISTINCT locktype, ','), '') FROM pg_locks WHERE pid = ${waiterPid} AND NOT granted;`);
    if (!lockTypes.includes(waitingOn)) {
      throw new Error(`${name} ${label}: the waiter waits on "${waitingOn}", expected ${lockTypes.join(" or ")}.`);
    }
    if (/WAITER=/.test(waiter.readOut())) {
      throw new Error(`${name} ${label}: the waiter finished while the holder was still open.`);
    }

    held.child.stdin.write("COMMIT;\nSELECT 'HELD_COMMITTED';\n");
    held.child.stdin.end();
    const [heldRes, waitRes] = await Promise.all([
      withTimeout(held.done, FIN_HOLD_MS, `${name} ${label} held-transaction exit`),
      withTimeout(waiter.done, FIN_HOLD_MS, `${name} ${label} waiter exit`),
    ]);
    held = null;
    waiter = null;
    if (heldRes.code !== 0 || heldRes.signal !== null || !/HELD_COMMITTED/.test(heldRes.out)) {
      throw new Error(`${name} ${label}: the held transaction did not commit cleanly (code=${heldRes.code}).`);
    }
    if (waitRes.code !== 0 || waitRes.signal !== null) {
      throw new Error(`${name} ${label}: the waiter did not exit cleanly (code=${waitRes.code}).`);
    }
    const waited = plOutcome(waitRes.out, "WAITER");
    if (!expected.test(waited)) {
      throw new Error(`${name} ${label}: the waiter reported "${waited}", expected ${expected}.`);
    }
    return { held: heldLine, waited, waitingOn };
  } catch (err) {
    await killPsql(waiter);
    await killPsql(held);
    throw err;
  }
}

async function countElBarrierWaiters(container) {
  return parseInt(await dbScalar(container,
    `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${EL_BARRIER_CLASSID} ` +
      `AND objid=${EL_BARRIER_OBJID} AND NOT granted;`), 10);
}

/**
 * One free round: both calls wait on a shared barrier and start together when
 * the coordinator releases it. No order is forced; the caller judges the pair.
 */
async function runElFreeRound(container, label, callX, callY,
  { xSql = null, ySql = null, name = "evidence lifecycle race" } = {}) {
  let coord = null;
  let wx = null;
  let wy = null;
  try {
    coord = spawnDockerPsql(container);
    coord.child.stdin.write(`SELECT pg_advisory_lock(${EL_BARRIER_KEY}); SELECT 'COORD_LOCKED';\n`);
    await waitUntil(() => /COORD_LOCKED/.test(coord.readOut()), PROBE_COORD_ACQUIRE_MS,
      `${name} ${label}: the coordinator never acquired the barrier.`);
    wx = spawnDockerPsql(container);
    wy = spawnDockerPsql(container);
    wx.child.stdin.write(`SELECT pg_advisory_lock_shared(${EL_BARRIER_KEY});\n` + (xSql ?? elSessionSql("X", callX)));
    wx.child.stdin.end();
    wy.child.stdin.write(`SELECT pg_advisory_lock_shared(${EL_BARRIER_KEY});\n` + (ySql ?? elSessionSql("Y", callY)));
    wy.child.stdin.end();
    await waitUntil(async () => (await countElBarrierWaiters(container)) >= 2, PROBE_BARRIER_MS,
      `${name} ${label}: both workers did not reach the barrier.`);
    coord.child.stdin.write(`SELECT 'UNLOCK=' || pg_advisory_unlock(${EL_BARRIER_KEY})::text; SELECT 'COORD_UNLOCKED';\n`);
    coord.child.stdin.end();
    const [cr, rx, ry] = await Promise.all([
      withTimeout(coord.done, PROBE_COORD_EXIT_MS, `${name} ${label} coordinator exit`),
      withTimeout(wx.done, PROBE_WORKER_MS, `${name} ${label} worker X exit`),
      withTimeout(wy.done, PROBE_WORKER_MS, `${name} ${label} worker Y exit`),
    ]);
    coord = null;
    wx = null;
    wy = null;
    if (cr.code !== 0 || cr.signal !== null || !/UNLOCK=t/.test(cr.out) || !/COORD_UNLOCKED/.test(cr.out)) {
      throw new Error(`${name} ${label}: the coordinator did not release the barrier cleanly (code=${cr.code}).`);
    }
    for (const [nm, r] of [["X", rx], ["Y", ry]]) {
      if (r.code !== 0 || r.signal !== null) {
        throw new Error(`${name} ${label}: worker ${nm} did not exit cleanly (code=${r.code}).`);
      }
    }
    return { x: plOutcome(rx.out, "X"), y: plOutcome(ry.out, "Y") };
  } catch (err) {
    await killPsql(wx);
    await killPsql(wy);
    await killPsql(coord);
    throw err;
  }
}

/**
 * True-concurrency probe of the study-record lifecycle RPCs
 * (EVIDENCE-RECORDS-001A2; FK-PROOF-001 I-1). Forced orders, each a held
 * transaction and a waiter observed blocked on the expected lock:
 *
 *   L1 identical creates (one request id, one body) -> the second replays the first
 *   L2 identical updates                            -> the second replays the first
 *   L3 two updates at one version, two request ids  -> the second gets a version conflict
 *   L4 an update holds the study, a delete waits    -> the delete gets a version conflict
 *   L5 a delete holds the study, an update waits    -> the update finds no study
 *   L6 one request id, two bodies                   -> the second is refused as reused
 *   L7 a create holds the paper, the paper delete RPC waits -> refused by the new link
 *   L8 the paper delete RPC holds the paper, a create waits -> the paper is not found
 *   L9 one user's creates with two request ids      -> serialized (the exact study limit)
 *
 * then a REPEATABLE READ caller refused, an aborted attempt retried afresh and
 * then replayed across sessions, and EL_FREE_ROUNDS barrier-released rounds
 * each of identical creates and of conflicting updates, every round required
 * to match one serial outcome.
 */
async function runEvidenceLifecycleRaceProbe(container) {
  log("running true-concurrency evidence lifecycle race probe (L1-L9, free rounds)…");

  const setup = await dockerPsql(
    container,
    `INSERT INTO auth.users (id, email) VALUES ('${EL_OWNER}','evidence-lifecycle-race@paperlume.test');\n` +
      `INSERT INTO public.internal_user_access (user_id, role) VALUES ('${EL_OWNER}','owner');\n` +
      `INSERT INTO public.papers (id, user_id, title, abstract, keywords, insert_order) VALUES\n` +
      `  ('${EL_PAPER_A}','${EL_OWNER}','Lifecycle race A','Lifecycle race abstract.','[]'::jsonb,1),\n` +
      `  ('${EL_PAPER_B}','${EL_OWNER}','Lifecycle race B','Protected paper abstract.','[]'::jsonb,2),\n` +
      `  ('${EL_PAPER_C}','${EL_OWNER}','Lifecycle race C','Vanishing paper abstract.','[]'::jsonb,3);\n`,
  );
  if (setup.code !== 0) throw new Error(`evidence lifecycle race fixture setup failed: ${setup.err.trim()}`);

  // L1 — identical creates: one study, one header, and the second answer replays the first.
  let r = await runElForcedOrder(container, "L1",
    elCall.create(EL_PAPER_A, "Race study", elRq(1)), elCall.create(EL_PAPER_A, "Race study", elRq(1)),
    ["advisory"], /^OK \{"status": "replayed"/);
  const study = elStudyOf(r.held);
  if (!study || elStatusOf(r.held) !== "applied" || elStudyOf(r.waited) !== study) {
    throw new Error(`evidence lifecycle race L1: the create answered ${r.held}, the replay ${r.waited}.`);
  }
  if ((await elHeaders(container, elRq(1))) !== "1" || (await elLabelled(container, "Race study")) !== "1") {
    throw new Error("evidence lifecycle race L1: identical creates did not leave exactly one study and one header.");
  }
  log(`evidence lifecycle race L1 OK: the second create waited on the ${r.waitingOn} lock, then replayed the first (one study, one header).`);

  // L2 — identical updates: applied once, replayed once.
  r = await runElForcedOrder(container, "L2",
    elCall.update(study, 1, "Race study 2", elRq(2)), elCall.update(study, 1, "Race study 2", elRq(2)),
    ["advisory"], /^OK \{"status": "replayed", "study_id": "[0-9a-f-]{36}", "study_version": 2\}$/);
  if ((await elVersion(container, study)) !== "2:Race study 2" || (await elHeaders(container, elRq(2))) !== "1") {
    throw new Error("evidence lifecycle race L2: identical updates were not applied exactly once.");
  }
  log(`evidence lifecycle race L2 OK: the second update waited on the ${r.waitingOn} lock, then replayed version 2 (applied once).`);

  // L3 — two request ids prepared against one version: the first wins.
  r = await runElForcedOrder(container, "L3",
    elCall.update(study, 2, "Writer one", elRq(3)), elCall.update(study, 2, "Writer two", elRq(4)),
    ["transactionid"], /^ERR P0001 evidence_version_conflict$/);
  if ((await elVersion(container, study)) !== "3:Writer one" || (await elHeaders(container, elRq(4))) !== "0") {
    throw new Error("evidence lifecycle race L3: the losing update changed the study or left a header.");
  }
  log(`evidence lifecycle race L3 OK: the second writer waited on the study row (${r.waitingOn}), then got a version conflict; nothing of it was written.`);

  // L4 — an update holds the study; a delete at the old version waits, then conflicts.
  r = await runElForcedOrder(container, "L4",
    elCall.update(study, 3, "Before delete", elRq(5)), elCall.remove(study, 3, elRq(6)),
    ["transactionid"], /^ERR P0001 evidence_version_conflict$/);
  if ((await elVersion(container, study)) !== "4:Before delete") {
    throw new Error("evidence lifecycle race L4: the delete that lost the race removed or changed the study.");
  }
  log("evidence lifecycle race L4 OK: a delete racing an update waited, then got a version conflict; the study kept version 4.");

  // L5 — a delete holds the study; an update waits, then finds nothing.
  r = await runElForcedOrder(container, "L5",
    elCall.remove(study, 4, elRq(7)), elCall.update(study, 4, "Too late", elRq(8)),
    ["transactionid"], /^ERR P0002 evidence_not_found$/);
  if (r.held !== '{"status": "deleted"}' || (await elVersion(container, study)) !== "GONE"
      || (await elStudyRows(container, study)) !== "0") {
    throw new Error(`evidence lifecycle race L5: the delete answered ${r.held} or left rows of the study.`);
  }
  log("evidence lifecycle race L5 OK: an update racing a delete waited, then found no study; nothing of the study remains.");

  // L6 — one request id, two bodies: never applied twice.
  r = await runElForcedOrder(container, "L6",
    elCall.create(EL_PAPER_A, "Payload one", elRq(9)), elCall.create(EL_PAPER_A, "Payload two", elRq(9)),
    ["advisory"], /^ERR P0001 evidence_request_id_reused$/);
  if ((await elLabelled(container, "Payload one")) !== "1" || (await elLabelled(container, "Payload two")) !== "0") {
    throw new Error("evidence lifecycle race L6: a reused request id applied its second body.");
  }
  log("evidence lifecycle race L6 OK: a request id reused with another body waited, then was refused; only the first body exists.");

  // L7 — a create holds the paper (KEY SHARE); the client paper delete waits, then meets the new link.
  r = await runElForcedOrder(container, "L7",
    elCall.create(EL_PAPER_B, "Protects B", elRq(10)), elCall.deletePaper(EL_PAPER_B),
    ["transactionid"], /^ERR 23503 .*evidence_study_reports_paper_fkey/);
  if ((await elCount(container, `public.papers WHERE id='${EL_PAPER_B}'`)) !== "1"
      || (await elCount(container, `public.evidence_study_reports WHERE paper_id='${EL_PAPER_B}'`)) !== "1"
      || (await elCount(container, `public.attachment_cleanup_queue WHERE user_id='${EL_OWNER}'`)) !== "0") {
    throw new Error("evidence lifecycle race L7: the refused paper delete left something partial.");
  }
  log("evidence lifecycle race L7 OK: the paper delete waited on the create, then was refused by the new link; paper and link kept.");

  // L8 — the paper delete holds the paper; a create waits, then finds no paper.
  r = await runElForcedOrder(container, "L8",
    elCall.deletePaper(EL_PAPER_C), elCall.create(EL_PAPER_C, "Too late", elRq(11)),
    ["transactionid"], /^ERR P0002 evidence_paper_not_found$/);
  if (r.held !== "1/0" || (await elCount(container, `public.papers WHERE id='${EL_PAPER_C}'`)) !== "0"
      || (await elLabelled(container, "Too late")) !== "0") {
    throw new Error("evidence lifecycle race L8: the create racing a paper delete wrote something.");
  }
  log("evidence lifecycle race L8 OK: a create racing the paper delete waited, then found no paper; nothing was written.");

  // L9 — one user's creates run one at a time, so the 2,000-study limit is exact.
  r = await runElForcedOrder(container, "L9",
    elCall.create(EL_PAPER_A, "Serial one", elRq(12)), elCall.create(EL_PAPER_A, "Serial two", elRq(13)),
    ["advisory"], /^OK \{"status": "applied"/);
  const serialOne = elStudyOf(r.held);
  if ((await elLabelled(container, "Serial one")) !== "1" || (await elLabelled(container, "Serial two")) !== "1") {
    throw new Error("evidence lifecycle race L9: two creates by one user did not both apply once.");
  }
  log(`evidence lifecycle race L9 OK: a second create by the same user waited on the per-user ${r.waitingOn} lock, then applied.`);

  // L10 — REPEATABLE READ is refused, not silently raced.
  for (const [nm, call] of [["create", elCall.create(EL_PAPER_A, "Repeatable read", elRq(14))],
                            ["delete", elCall.remove(serialOne, 1, elRq(15))]]) {
    const rr = await dockerPsql(container, elSessionSql("RR", call, { isolation: "REPEATABLE READ" }));
    const said = plOutcome(rr.out, "RR");
    if (rr.code !== 0 || said !== "ERR P0001 evidence_requires_read_committed") {
      throw new Error(`evidence lifecycle race L10 (${nm}): a REPEATABLE READ caller got "${said}" (code=${rr.code}).`);
    }
  }
  if ((await elLabelled(container, "Repeatable read")) !== "0" || (await elVersion(container, serialOne)) !== "1:Serial one") {
    throw new Error("evidence lifecycle race L10: a refused REPEATABLE READ call changed something.");
  }
  log("evidence lifecycle race L10 OK: create and delete refuse REPEATABLE READ (evidence_requires_read_committed) and change nothing.");

  // L11 — an attempt rolled back before commit leaves nothing; its retry is applied
  // afresh, and a retry of THAT from another session (a lost response) replays it.
  const aborted = await dockerPsql(container,
    "BEGIN;\n" + `SELECT ${elClaimsSql()};\n` + "SET LOCAL ROLE authenticated;\n" +
      `SELECT 'ABORTED=' || (${elCall.create(EL_PAPER_A, "Abort me", elRq(16))})::text;\n` + "ROLLBACK;\n");
  if (aborted.code !== 0 || elStatusOf(plOutcome(aborted.out, "ABORTED")) !== "applied"
      || (await elHeaders(container, elRq(16))) !== "0" || (await elLabelled(container, "Abort me")) !== "0") {
    throw new Error("evidence lifecycle race L11: the rolled-back attempt left a trace.");
  }
  const retried = plOutcome((await dockerPsql(container,
    elSessionSql("RETRY", elCall.create(EL_PAPER_A, "Abort me", elRq(16))))).out, "RETRY");
  const replayed = plOutcome((await dockerPsql(container,
    elSessionSql("REPLAY", elCall.create(EL_PAPER_A, "Abort me", elRq(16))))).out, "REPLAY");
  if (elStatusOf(retried) !== "applied" || elStatusOf(replayed) !== "replayed"
      || elStudyOf(retried) === null || elStudyOf(replayed) !== elStudyOf(retried)) {
    throw new Error(`evidence lifecycle race L11: the retry answered ${retried} and its replay ${replayed}.`);
  }
  log("evidence lifecycle race L11 OK: a rolled-back attempt left nothing; its retry applied afresh; a later retry from a new session replayed it.");

  // Free rounds — identical creates. Each must be one applied + one replayed of one study.
  for (let i = 1; i <= EL_FREE_ROUNDS; i++) {
    const req = elRq(0x100 + i);
    const label = `Free create ${i}`;
    const { x, y } = await runElFreeRound(container, `free create ${i}`,
      elCall.create(EL_PAPER_A, label, req), elCall.create(EL_PAPER_A, label, req));
    const statuses = [elStatusOf(x), elStatusOf(y)].sort().join(",");
    if (statuses !== "applied,replayed" || elStudyOf(x) === null || elStudyOf(x) !== elStudyOf(y)
        || (await elHeaders(container, req)) !== "1" || (await elLabelled(container, label)) !== "1") {
      throw new Error(`evidence lifecycle race (free create ${i}): got "${x}" and "${y}".`);
    }
  }
  log(`evidence lifecycle race free creates OK: ${EL_FREE_ROUNDS}/${EL_FREE_ROUNDS} barrier-released rounds each produced one study, one applied and one replayed answer.`);

  // Free rounds — two writers at one version. Each must be one applied + one conflict.
  const target = elStudyOf(plOutcome((await dockerPsql(container,
    elSessionSql("TARGET", elCall.create(EL_PAPER_A, "Free target", elRq(0x200))))).out, "TARGET"));
  if (!target) throw new Error("evidence lifecycle race: could not create the free-update target.");
  for (let i = 1; i <= EL_FREE_ROUNDS; i++) {
    const { x, y } = await runElFreeRound(container, `free update ${i}`,
      elCall.update(target, i, `Writer X ${i}`, elRq(0x200 + 2 * i)),
      elCall.update(target, i, `Writer Y ${i}`, elRq(0x201 + 2 * i)));
    const winner = elStatusOf(x) === "applied" ? "X" : elStatusOf(y) === "applied" ? "Y" : null;
    const loser = winner === "X" ? y : x;
    const now = await elVersion(container, target);
    if (winner === null || loser !== "ERR P0001 evidence_version_conflict" || now !== `${i + 1}:Writer ${winner} ${i}`) {
      throw new Error(`evidence lifecycle race (free update ${i}): got "${x}" and "${y}", study now ${now}.`);
    }
  }
  log(`evidence lifecycle race free updates OK: ${EL_FREE_ROUNDS}/${EL_FREE_ROUNDS} barrier-released rounds each applied exactly one writer and refused the other.`);

  // Remove the fixture through the account cascade, and prove it is gone.
  const cleanup = await dockerPsql(container, `DELETE FROM auth.users WHERE id='${EL_OWNER}';\n`);
  if (cleanup.code !== 0) throw new Error(`evidence lifecycle race fixture cleanup failed: ${cleanup.err.trim()}`);
  const residual = await dbScalar(container,
    `SELECT (SELECT count(*) FROM auth.users WHERE id='${EL_OWNER}') + ` +
      `(SELECT count(*) FROM public.papers WHERE user_id='${EL_OWNER}') + ` +
      `(SELECT count(*) FROM public.internal_user_access WHERE user_id='${EL_OWNER}') + ` +
      ["evidence_studies", "evidence_study_reports", "evidence_source_snapshots", "evidence_arms",
        "evidence_outcomes", "evidence_field_values", "evidence_field_anchors", "evidence_events"]
        .map((t) => `(SELECT count(*) FROM public.${t} WHERE user_id='${EL_OWNER}')`).join(" + ") + " + " +
      `(SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${EL_BARRIER_CLASSID} AND objid=${EL_BARRIER_OBJID});`);
  if (residual !== "0") throw new Error(`evidence lifecycle race fixture not fully removed (${residual} row(s) or lock(s) remain).`);
}

// ── EVIDENCE-RECORDS-001A3 ───────────────────────────────────────────────────
// The field, review and rebase RPCs (20261017155445) under real concurrency,
// called exactly as a client calls them: as `authenticated`, with an owner's
// JWT claims. Its own owner, papers and request ids. It reuses the lifecycle
// probe's forced-order and free-round runners and their barrier; the two
// probes run one after the other, never at once.
const EF_OWNER = "cc0000fa-0000-0000-0000-0000000000a0";
const EF_PAPER_A = "cc0000fa-0000-0000-0000-0000000000c1"; // the study's first link: values, reviews, rebases
const EF_PAPER_B = "cc0000fa-0000-0000-0000-0000000000c2"; // a second link: link operations against saves
const EF_FREE_ROUNDS = 5; // barrier-released rounds per free race, after the forced orders.
const EF_NAME = "evidence field race";

/** One deterministic request id per probe step. */
function efRq(n) {
  return `cc0000fb-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
}

/** A JSON value as a SQL jsonb literal. Every payload here is plain ASCII. */
function efJson(value) {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

/** The RPC calls, as SQL expressions. */
const efCall = {
  create: (paper, label, req) =>
    `public.evidence_create_study_from_paper('${paper}'::uuid, '${label}', 'rct_parallel', 'user_confirmed', '${req}'::uuid)`,
  save: (study, version, changes, req) =>
    `public.evidence_save_changes('${study}'::uuid, ${version}, ${efJson(changes)}, '${req}'::uuid)`,
  review: (study, version, value, valueVersion, action, note, req) =>
    `public.evidence_review_fields('${study}'::uuid, ${version}, '${value}'::uuid, ${valueVersion}, '${action}', ` +
    `${note === null ? "NULL" : `'${note}'`}, '${req}'::uuid)`,
  rebase: (study, paper, version, sha, req) =>
    `public.evidence_rebase_source('${study}'::uuid, '${paper}'::uuid, ${version}, '${sha}', '${req}'::uuid)`,
  setLink: (study, paper, action, version, req) =>
    `public.evidence_set_link('${study}'::uuid, '${paper}'::uuid, '${action}', ${version}, '${req}'::uuid)`,
};

/** The wire format of the changes the probe sends (docs/evidence-records-field-operations.md §3). */
const efChange = {
  text: (field, text, expected, references = []) => ({
    op: "set_value", target: { scope: "study" }, field_key: field, expected_value_version: expected,
    value_state: "reported", state_reason: null, content: { shape: "text", text }, note: null, references,
  }),
  unavailable: (field, expected, paper) => ({
    op: "set_value", target: { scope: "study" }, field_key: field, expected_value_version: expected,
    value_state: "source_unavailable", state_reason: null, content: null, note: null,
    references: [{ purpose: "unavailable", source_kind: "full_text", paper_id: paper }],
  }),
  addArm: (ref, position) => ({ op: "add_arm", ref, arm_role: "intervention", display_label: `Arm ${position}`, position }),
  quote: (paper, snapshot, quote) => ({
    purpose: "supports", source_kind: "abstract", paper_id: paper, snapshot_id: snapshot, quote_text: quote,
    occurrence: null, expected_match_count: null,
  }),
  keep: (anchor) => ({ anchor_id: anchor }),
};

/**
 * The owner's abstract edit, as the client makes it — an UPDATE of their own
 * paper under RLS — printing `${tag}=OK edited=<rows>`.
 */
function efEditSql(tag, paper, text) {
  return `WITH u AS (UPDATE public.papers SET abstract = '${text}' WHERE id = '${paper}' RETURNING 1) ` +
    `SELECT '${tag}=OK edited=' || count(*) FROM u;\n`;
}

/** A session that makes the abstract edit and commits it. */
function efEditSessionSql(tag, paper, text) {
  return "SELECT 'PID=' || pg_backend_pid();\n" + "BEGIN;\n" + `SELECT ${elClaimsSql(EF_OWNER)};\n` +
    "SET LOCAL ROLE authenticated;\n" + efEditSql(tag, paper, text) + "RESET ROLE;\nCOMMIT;\n";
}

/** The held transaction for an abstract edit: the edit, then stay open. */
function efEditHolderSql(paper, text) {
  return "BEGIN;\n" + `SELECT ${elClaimsSql(EF_OWNER)};\n` + "SET LOCAL ROLE authenticated;\n" +
    efEditSql("HELD", paper, text) + "RESET ROLE;\n" + "SELECT 'PID=' || pg_backend_pid();\n" + "SELECT 'HELD_READY';\n";
}

/** A numeric field of an answer, or null. */
function efNumberOf(line, key) {
  const m = new RegExp(`"${key}": (\\d+)`).exec(`${line}`);
  return m ? Number(m[1]) : null;
}

/**
 * True-concurrency probe of the PR-A3 RPCs (EVIDENCE-RECORDS-001A3;
 * FK-PROOF-001 I-1). Forced orders, each a held transaction and a waiter
 * observed blocked by it on the expected lock:
 *
 *   F1  identical saves (one request id, one body)       -> the second replays the first
 *   F2  one request id, two bodies                        -> the second is refused as reused
 *   F3  two saves at one study version, two request ids   -> the second gets a version conflict
 *   F4  a save holds; a Confirm of the version it replaced waits -> a value version conflict
 *   F5  a Confirm holds; a save of that value waits       -> applied after it, and the review is reset
 *   F6  a rebase holds; a Confirm of the old version waits -> a value version conflict
 *   F7  a Confirm holds; a rebase waits                   -> applied after it: Needs re-review again
 *   F8  a rebase holds the paper; the owner's abstract edit waits -> the copy is the text displayed
 *   F9  an abstract edit holds the paper; a rebase waits  -> evidence_source_changed_again
 *   F10 a link removal holds; a save citing that link waits -> evidence_link_not_found
 *   F11 a save citing a link holds; its removal waits     -> evidence_link_in_use
 *   F12 a save adds the 20th group; another adds a 21st   -> evidence_arm_limit
 *   F13 a save reaches 5,000 events; another would pass it -> evidence_history_limit
 *   F15 a rebase takes a link's 20th copy; one of the same text waits -> unchanged,
 *       and the next text is refused (evidence_snapshot_limit)
 *
 *   F14 an attempt rolled back, retried afresh, then replayed from another
 *       session (a lost response); a review retried after a lost answer
 *
 * and EF_FREE_ROUNDS barrier-released rounds each of identical saves,
 * conflicting saves, Confirm against a save, and a rebase against an abstract
 * edit — every round required to match one serial outcome. F1-F11 and F14 run
 * in that order on one study, then the free rounds, then F15, F12 and F13,
 * which leave the study at its limits.
 */
async function runEvidenceFieldRaceProbe(container) {
  log("running true-concurrency evidence field race probe (F1-F15, free rounds)…");
  const q = (sql) => dbScalar(container, sql);
  const A = (n) => `Adults with asthma were randomized. Group A received drug X. Group B received placebo. Revision ${n}.`;
  const owner = async (sql, what) => {
    const r = await dockerPsql(container, sql);
    if (r.code !== 0) throw new Error(`${EF_NAME}: ${what} failed: ${r.err.trim()}`);
  };
  await owner(
    `INSERT INTO auth.users (id, email) VALUES ('${EF_OWNER}','evidence-field-race@paperlume.test');\n` +
      `INSERT INTO public.internal_user_access (user_id, role) VALUES ('${EF_OWNER}','owner');\n` +
      `INSERT INTO public.papers (id, user_id, title, abstract, keywords, insert_order) VALUES\n` +
      `  ('${EF_PAPER_A}','${EF_OWNER}','Field race A','${A(0)}','[]'::jsonb,1),\n` +
      `  ('${EF_PAPER_B}','${EF_OWNER}','Field race B','Second report abstract.','[]'::jsonb,2);\n`,
    "fixture setup");

  const once = async (tag, call) =>
    plOutcome((await dockerPsql(container, elSessionSql(tag, call, { owner: EF_OWNER }))).out, tag);
  const held = (call) => elHolderSql(call, EF_OWNER);
  const waits = (call) => elSessionSql("WAITER", call, { owner: EF_OWNER });
  const forced = (label, holderSql, waiterSql, lockTypes, expected) =>
    runElForcedOrder(container, label, null, null, lockTypes, expected, { holderSql, waiterSql, name: EF_NAME });

  const created = await once("CREATE", efCall.create(EF_PAPER_A, "Field race study", efRq(1)));
  const study = elStudyOf(created);
  if (!study || elStatusOf(created) !== "applied") throw new Error(`${EF_NAME}: the study was not created (${created}).`);
  // A second report, linked by the owner (there is no client RPC that adds a link yet).
  const plantLinkB = () => owner(
    `INSERT INTO public.evidence_study_reports (user_id, study_id, paper_id, link_status, link_basis) ` +
      `VALUES ('${EF_OWNER}','${study}','${EF_PAPER_B}','user_confirmed','user_linked');\n`,
    "linking the second report");
  await plantLinkB();

  const version = async () => Number(await q(`SELECT row_version FROM public.evidence_studies WHERE id='${study}';`));
  const value = async (field) => {
    const row = await q(
      "SELECT coalesce((SELECT v.id || '|' || v.value_version || '|' || v.review_status || '|' || " +
        "coalesce(v.review_reason, '-') || '|' || coalesce(v.value_text, '-') FROM public.evidence_field_values v " +
        `WHERE v.study_id='${study}' AND v.field_key='${field}' AND v.arm_id IS NULL AND v.outcome_id IS NULL), 'NONE');`);
    if (row === "NONE") return null;
    const [id, vv, status, reason, text] = row.split("|");
    return { id, vv: Number(vv), status, reason, text };
  };
  const current = async (paper) => {
    const [id, seq] = (await q(`SELECT id || '|' || seq FROM public.evidence_source_snapshots ` +
      `WHERE study_id='${study}' AND paper_id='${paper}' ORDER BY seq DESC LIMIT 1;`)).split("|");
    return { id, seq: Number(seq) };
  };
  const copies = async (paper) => Number(await q(`SELECT count(*) FROM public.evidence_source_snapshots WHERE study_id='${study}' AND paper_id='${paper}';`));
  const anchorCopy = (anchor) => q(`SELECT snapshot_id FROM public.evidence_field_anchors WHERE id='${anchor}';`);
  const sha = (paper) => q(`SELECT encode(sha256(convert_to(abstract, 'UTF8')), 'hex') FROM public.papers WHERE id='${paper}';`);
  const headers = (req) => q(`SELECT count(*) FROM public.evidence_events WHERE user_id='${EF_OWNER}' AND request_id='${req}' AND ordinal=0;`);
  const events = async () => Number(await q(`SELECT count(*) FROM public.evidence_events WHERE study_id='${study}';`));
  const setAbstract = (text) => owner(`UPDATE public.papers SET abstract='${text}' WHERE id='${EF_PAPER_A}';\n`, "an abstract edit");
  const fail = (label, detail) => { throw new Error(`${EF_NAME} ${label}: ${detail}`); };

  // F1 — identical saves: applied once, replayed once.
  let v = await version();
  let r = await forced("F1",
    held(efCall.save(study, v, [efChange.text("condition", "Asthma", null)], efRq(2))),
    waits(efCall.save(study, v, [efChange.text("condition", "Asthma", null)], efRq(2))),
    ["advisory"], /^OK \{.*"status": "replayed"/);
  if (elStatusOf(r.held) !== "applied" || r.waited.replace('"replayed"', '"applied"') !== `OK ${r.held}`
      || (await headers(efRq(2))) !== "1" || (await version()) !== v + 1) {
    fail("F1", `the save answered ${r.held}, the replay ${r.waited}.`);
  }
  log(`${EF_NAME} F1 OK: the second save waited on the ${r.waitingOn} lock, then replayed the first (applied once, one header).`);

  // F2 — one request id, two bodies: the second body is never applied.
  v = await version();
  r = await forced("F2",
    held(efCall.save(study, v, [efChange.text("demographics", "Mean age 54", null)], efRq(3))),
    waits(efCall.save(study, v, [efChange.text("demographics", "Mean age 45", null)], efRq(3))),
    ["advisory"], /^ERR P0001 evidence_request_id_reused$/);
  if ((await value("demographics"))?.text !== "Mean age 54" || (await headers(efRq(3))) !== "1") {
    fail("F2", "a reused request id applied its second body.");
  }
  log(`${EF_NAME} F2 OK: a request id reused with another body waited, then was refused; only the first body exists.`);

  // F3 — two request ids prepared against one study version: the first wins.
  v = await version();
  r = await forced("F3",
    held(efCall.save(study, v, [efChange.text("eligibility_criteria", "Writer one", null)], efRq(4))),
    waits(efCall.save(study, v, [efChange.text("eligibility_criteria", "Writer two", null)], efRq(5))),
    ["transactionid"], /^ERR P0001 evidence_version_conflict$/);
  if ((await value("eligibility_criteria"))?.text !== "Writer one" || (await headers(efRq(5))) !== "0") {
    fail("F3", "the losing save changed the value or left a header.");
  }
  log(`${EF_NAME} F3 OK: the second save waited on the study row (${r.waitingOn}), then got a version conflict; nothing of it was written.`);

  // The value the review races use: Reported, quoted on the current copy, so Confirm is allowed.
  v = await version();
  let copyA = await current(EF_PAPER_A);
  const seeded = await once("SEED", efCall.save(study, v,
    [efChange.text("setting", "Two clinics", null, [efChange.quote(EF_PAPER_A, copyA.id, "were randomized")])], efRq(6)));
  if (elStatusOf(seeded) !== "applied") fail("setup", `the reviewed value was not saved (${seeded}).`);
  let val = await value("setting");
  const anchor = await q(`SELECT id FROM public.evidence_field_anchors WHERE value_id='${val.id}';`);

  // F4 — a save holds; a Confirm bound to the version it replaced waits, then conflicts.
  v = await version();
  r = await forced("F4",
    held(efCall.save(study, v, [efChange.text("setting", "Two clinics, urban", val.vv, [efChange.keep(anchor)])], efRq(7))),
    waits(efCall.review(study, v + 1, val.id, val.vv, "confirm", null, efRq(8))),
    ["transactionid"], /^ERR P0001 evidence_version_conflict$/);
  let after = await value("setting");
  if (after.vv !== val.vv + 1 || after.status !== "unreviewed" || (await headers(efRq(8))) !== "0") {
    fail("F4", `the value is ${JSON.stringify(after)} after a Confirm of a replaced version.`);
  }
  log(`${EF_NAME} F4 OK: a Confirm of the version a save replaced waited on the study row, then got a version conflict; the value stays Not reviewed.`);

  // F5 — a Confirm holds; a save of that value at the confirmed version waits, then applies and resets the review.
  v = await version();
  val = after;
  r = await forced("F5",
    held(efCall.review(study, v, val.id, val.vv, "confirm", null, efRq(9))),
    waits(efCall.save(study, v + 1, [efChange.text("setting", "Two clinics, rural", val.vv, [efChange.keep(anchor)])], efRq(10))),
    ["transactionid"], /^OK \{.*"status": "applied"/);
  after = await value("setting");
  if (elStatusOf(r.held) !== "applied" || after.status !== "unreviewed" || after.vv !== val.vv + 1 || after.text !== "Two clinics, rural") {
    fail("F5", `the Confirm answered ${r.held}; the value is ${JSON.stringify(after)}.`);
  }
  log(`${EF_NAME} F5 OK: a save racing a Confirm waited, then applied at the next version and returned the value to Not reviewed.`);

  // F6 — a rebase holds; a Confirm of the version before it waits, then conflicts.
  v = await version();
  val = after;
  const confirmed = await once("CONFIRM", efCall.review(study, v, val.id, val.vv, "confirm", null, efRq(11)));
  if (elStatusOf(confirmed) !== "applied") fail("F6", `the value could not be confirmed first (${confirmed}).`);
  await setAbstract(A(1));
  v = await version();
  r = await forced("F6",
    held(efCall.rebase(study, EF_PAPER_A, v, await sha(EF_PAPER_A), efRq(12))),
    waits(efCall.review(study, v + 1, val.id, val.vv, "confirm", null, efRq(13))),
    ["transactionid"], /^ERR P0001 evidence_version_conflict$/);
  after = await value("setting");
  copyA = await current(EF_PAPER_A);
  if (efNumberOf(r.held, "rematched") !== 1 || efNumberOf(r.held, "needs_rereview") !== 1
      || after.status !== "needs_rereview" || after.reason !== "source_changed" || (await anchorCopy(anchor)) !== copyA.id) {
    fail("F6", `the rebase answered ${r.held}; the value is ${JSON.stringify(after)}.`);
  }
  log(`${EF_NAME} F6 OK: the rebase re-pointed the quote and set Needs re-review; a Confirm of the old version waited, then got a version conflict.`);

  // F7 — a Confirm holds; a rebase waits, then applies: the fresh Confirm needs re-review again (001A §E5).
  await setAbstract(A(2));
  v = await version();
  val = after;
  r = await forced("F7",
    held(efCall.review(study, v, val.id, val.vv, "confirm", null, efRq(14))),
    waits(efCall.rebase(study, EF_PAPER_A, v + 1, await sha(EF_PAPER_A), efRq(15))),
    ["transactionid"], /^OK \{.*"status": "applied"/);
  after = await value("setting");
  if (elStatusOf(r.held) !== "applied" || efNumberOf(r.waited, "needs_rereview") !== 1 || after.status !== "needs_rereview") {
    fail("F7", `the Confirm answered ${r.held}, the rebase ${r.waited}; the value is ${JSON.stringify(after)}.`);
  }
  log(`${EF_NAME} F7 OK: a rebase racing a Confirm waited, then applied; the value needs re-review even though its quote was found again.`);

  // F8 — a rebase holds the paper FOR SHARE; the owner's abstract edit waits for it.
  await setAbstract(A(3));
  v = await version();
  const shown = await sha(EF_PAPER_A);
  r = await forced("F8",
    held(efCall.rebase(study, EF_PAPER_A, v, shown, efRq(16))),
    efEditSessionSql("WAITER", EF_PAPER_A, A(4)),
    ["transactionid"], /^OK edited=1$/);
  copyA = await current(EF_PAPER_A);
  const copied = await q(`SELECT encode(sha256(convert_to(exact_text, 'UTF8')), 'hex') FROM public.evidence_source_snapshots WHERE id='${copyA.id}';`);
  if (elStatusOf(r.held) !== "applied" || copied !== shown || (await sha(EF_PAPER_A)) === shown) {
    fail("F8", `the rebase answered ${r.held}; the copy is not the text displayed, or the edit was lost.`);
  }
  const stale = await once("STALE", efCall.rebase(study, EF_PAPER_A, v + 1, shown, efRq(17)));
  if (stale !== "ERR P0001 evidence_source_changed_again") fail("F8", `a rebase of the text displayed before the edit answered ${stale}.`);
  log(`${EF_NAME} F8 OK: the abstract edit waited for the rebase; the copy is exactly the text displayed, and a rebase of that text now answers source_changed_again.`);

  // F9 — an abstract edit holds the paper; a rebase of the text displayed before it waits, then is refused.
  v = await version();
  const before = await copies(EF_PAPER_A);
  const displayed = await sha(EF_PAPER_A);
  r = await forced("F9",
    efEditHolderSql(EF_PAPER_A, A(5)),
    waits(efCall.rebase(study, EF_PAPER_A, v, displayed, efRq(18))),
    ["transactionid"], /^ERR P0001 evidence_source_changed_again$/);
  if (r.held !== "OK edited=1" || (await copies(EF_PAPER_A)) !== before || (await version()) !== v) {
    fail("F9", "a rebase that lost the race to an abstract edit saved a copy or moved the study.");
  }
  log(`${EF_NAME} F9 OK: a rebase racing an abstract edit waited on the paper row, then answered source_changed_again; nothing was saved.`);

  // F10 — removing a link holds the study; a save citing that link waits, then finds no link.
  v = await version();
  r = await forced("F10",
    held(efCall.setLink(study, EF_PAPER_B, "remove", v, efRq(19))),
    waits(efCall.save(study, v + 1, [efChange.unavailable("population_description", null, EF_PAPER_B)], efRq(20))),
    ["transactionid"], /^ERR P0002 evidence_link_not_found$/);
  if (elStatusOf(r.held) !== "applied" || (await value("population_description")) !== null) {
    fail("F10", `the removal answered ${r.held}, or the save left a value citing a removed link.`);
  }
  log(`${EF_NAME} F10 OK: a save citing a link being removed waited, then answered link_not_found; no reference to a removed link exists.`);

  // F11 — a save citing a link holds; removing that link waits, then is refused.
  await plantLinkB();
  v = await version();
  r = await forced("F11",
    held(efCall.save(study, v, [efChange.unavailable("population_description", null, EF_PAPER_B)], efRq(21))),
    waits(efCall.setLink(study, EF_PAPER_B, "remove", v + 1, efRq(22))),
    ["transactionid"], /^ERR P0001 evidence_link_in_use$/);
  const linked = await q(`SELECT count(*) FROM public.evidence_study_reports WHERE study_id='${study}' AND paper_id='${EF_PAPER_B}';`);
  if (elStatusOf(r.held) !== "applied" || linked !== "1" || (await value("population_description"))?.status !== "unreviewed") {
    fail("F11", `the save answered ${r.held}; the link count is ${linked}.`);
  }
  log(`${EF_NAME} F11 OK: removing a link a save had just cited waited, then answered link_in_use; link and reference kept.`);

  // F14 — an attempt rolled back leaves nothing; its retry applies afresh; a retry of that
  // from another session (a lost response) replays it. The same for a review.
  v = await version();
  const retryCall = efCall.save(study, v, [efChange.text("design_as_reported", "Parallel trial", null)], efRq(23));
  const aborted = await dockerPsql(container,
    "BEGIN;\n" + `SELECT ${elClaimsSql(EF_OWNER)};\n` + "SET LOCAL ROLE authenticated;\n" +
      `SELECT 'ABORTED=' || (${retryCall})::text;\n` + "ROLLBACK;\n");
  if (aborted.code !== 0 || elStatusOf(plOutcome(aborted.out, "ABORTED")) !== "applied"
      || (await headers(efRq(23))) !== "0" || (await value("design_as_reported")) !== null || (await version()) !== v) {
    fail("F14", "the rolled-back attempt left a trace.");
  }
  const retried = await once("RETRY", retryCall);
  const replayed = await once("REPLAY", retryCall);
  if (elStatusOf(retried) !== "applied" || replayed.replace('"replayed"', '"applied"') !== retried || (await headers(efRq(23))) !== "1") {
    fail("F14", `the retry answered ${retried} and its replay ${replayed}.`);
  }
  val = await value("setting");
  v = await version();
  const flagCall = efCall.review(study, v, val.id, val.vv, "flag", "Wrong arm", efRq(24));
  const flagged = await once("FLAG", flagCall);
  const reflagged = await once("REFLAG", flagCall);
  if (elStatusOf(flagged) !== "applied" || reflagged.replace('"replayed"', '"applied"') !== flagged
      || (await headers(efRq(24))) !== "1" || (await value("setting")).status !== "disputed") {
    fail("F14", `the flag answered ${flagged} and its retry ${reflagged}.`);
  }
  log(`${EF_NAME} F14 OK: a rolled-back save left nothing; its retry applied afresh and replayed from a new session; a review retried after a lost answer replayed once.`);

  // Free rounds — identical saves. Each must be one applied + one replayed answer, one header.
  for (let i = 1; i <= EF_FREE_ROUNDS; i++) {
    const req = efRq(0x100 + i);
    v = await version();
    const call = efCall.save(study, v, [efChange.text("condition", `Asthma ${i}`, (await value("condition")).vv)], req);
    const { x, y } = await runElFreeRound(container, `free save ${i}`, null, null,
      { xSql: elSessionSql("X", call, { owner: EF_OWNER }), ySql: elSessionSql("Y", call, { owner: EF_OWNER }), name: EF_NAME });
    const statuses = [elStatusOf(x), elStatusOf(y)].sort().join(",");
    if (statuses !== "applied,replayed" || (await headers(req)) !== "1" || (await value("condition"))?.text !== `Asthma ${i}`
        || (await version()) !== v + 1) {
      fail(`(free save ${i})`, `got "${x}" and "${y}".`);
    }
  }
  log(`${EF_NAME} free saves OK: ${EF_FREE_ROUNDS}/${EF_FREE_ROUNDS} barrier-released rounds each applied once and replayed once.`);

  // Free rounds — two saves at one version. Each must apply exactly one writer.
  const wins = { X: 0, Y: 0 };
  for (let i = 1; i <= EF_FREE_ROUNDS; i++) {
    v = await version();
    const prior = await value("eligibility_criteria");
    const { x, y } = await runElFreeRound(container, `free conflict ${i}`, null, null, {
      xSql: elSessionSql("X", efCall.save(study, v, [efChange.text("eligibility_criteria", `Writer X ${i}`, prior.vv)], efRq(0x200 + 2 * i)), { owner: EF_OWNER }),
      ySql: elSessionSql("Y", efCall.save(study, v, [efChange.text("eligibility_criteria", `Writer Y ${i}`, prior.vv)], efRq(0x201 + 2 * i)), { owner: EF_OWNER }),
      name: EF_NAME,
    });
    const winner = elStatusOf(x) === "applied" ? "X" : elStatusOf(y) === "applied" ? "Y" : null;
    const loser = winner === "X" ? y : x;
    const now = await value("eligibility_criteria");
    if (winner === null || loser !== "ERR P0001 evidence_version_conflict" || now.text !== `Writer ${winner} ${i}` || now.vv !== prior.vv + 1) {
      fail(`(free conflict ${i})`, `got "${x}" and "${y}", the value is now ${JSON.stringify(now)}.`);
    }
    wins[winner] += 1;
  }
  log(`${EF_NAME} free conflicts OK: ${EF_FREE_ROUNDS}/${EF_FREE_ROUNDS} barrier-released rounds each applied exactly one save and refused the other (X won ${wins.X}, Y won ${wins.Y}).`);

  // Free rounds — Confirm against a save of the same value at one study version.
  const reviewOrders = { confirm: 0, save: 0 };
  for (let i = 1; i <= EF_FREE_ROUNDS; i++) {
    v = await version();
    const prior = await value("setting");
    const { x, y } = await runElFreeRound(container, `free review ${i}`, null, null, {
      xSql: elSessionSql("X", efCall.review(study, v, prior.id, prior.vv, "confirm", null, efRq(0x300 + 2 * i)), { owner: EF_OWNER }),
      ySql: elSessionSql("Y", efCall.save(study, v, [efChange.text("setting", `Clinic ${i}`, prior.vv, [efChange.keep(anchor)])], efRq(0x301 + 2 * i)), { owner: EF_OWNER }),
      name: EF_NAME,
    });
    const now = await value("setting");
    const confirmWon = elStatusOf(x) === "applied" && y === "ERR P0001 evidence_version_conflict"
      && now.status === "user_reviewed" && now.vv === prior.vv && now.text === prior.text;
    const saveWon = elStatusOf(y) === "applied" && x === "ERR P0001 evidence_version_conflict"
      && now.status === "unreviewed" && now.vv === prior.vv + 1 && now.text === `Clinic ${i}`;
    if (!confirmWon && !saveWon) fail(`(free review ${i})`, `got "${x}" and "${y}", the value is now ${JSON.stringify(now)}.`);
    reviewOrders[confirmWon ? "confirm" : "save"] += 1;
    if (confirmWon) {
      // Leave the value unreviewed, and editable, for the next round.
      const reset = await once("RESET", efCall.save(study, v + 1, [efChange.text("setting", `Clinic reset ${i}`, now.vv, [efChange.keep(anchor)])], efRq(0x380 + i)));
      if (elStatusOf(reset) !== "applied") fail(`(free review ${i})`, `could not reset the value (${reset}).`);
    }
  }
  log(`${EF_NAME} free reviews OK: ${EF_FREE_ROUNDS}/${EF_FREE_ROUNDS} barrier-released rounds of Confirm against a save each ended as one of the two serial orders (Confirm first ${reviewOrders.confirm}, save first ${reviewOrders.save}).`);

  // Free rounds — a rebase against an abstract edit.
  const rebaseOrders = { rebase: 0, edit: 0 };
  for (let i = 1; i <= EF_FREE_ROUNDS; i++) {
    v = await version();
    const text = await q(`SELECT abstract FROM public.papers WHERE id='${EF_PAPER_A}';`);
    const shownNow = await sha(EF_PAPER_A);
    const n = await copies(EF_PAPER_A);
    const { x, y } = await runElFreeRound(container, `free rebase ${i}`, null, null, {
      xSql: elSessionSql("X", efCall.rebase(study, EF_PAPER_A, v, shownNow, efRq(0x400 + i)), { owner: EF_OWNER }),
      ySql: efEditSessionSql("Y", EF_PAPER_A, A(100 + i)),
      name: EF_NAME,
    });
    const nowCopies = await copies(EF_PAPER_A);
    const latest = await q(`SELECT exact_text FROM public.evidence_source_snapshots WHERE study_id='${study}' AND paper_id='${EF_PAPER_A}' ORDER BY seq DESC LIMIT 1;`);
    const rebaseFirst = elStatusOf(x) === "applied" && nowCopies === n + 1 && latest === text;
    const editFirst = x === "ERR P0001 evidence_source_changed_again" && nowCopies === n;
    if (y !== "OK edited=1" || (!rebaseFirst && !editFirst)) {
      fail(`(free rebase ${i})`, `got "${x}" and "${y}", ${nowCopies - n} new copy(ies).`);
    }
    rebaseOrders[rebaseFirst ? "rebase" : "edit"] += 1;
  }
  log(`${EF_NAME} free rebases OK: ${EF_FREE_ROUNDS}/${EF_FREE_ROUNDS} barrier-released rounds of a rebase against an abstract edit each ended as one serial order, never a copy of text that was not displayed (rebase first ${rebaseOrders.rebase}, edit first ${rebaseOrders.edit}).`);

  // F15 — the last copy slot. At 19 copies a rebase takes the 20th; a rebase of the
  // same displayed text waiting on the study row is then unchanged, not a 21st copy;
  // any further text is refused at the limit.
  const top = (await current(EF_PAPER_A)).seq;
  if ((await copies(EF_PAPER_A)) !== top || top >= 19) fail("F15", `unexpected copy sequence (count ${await copies(EF_PAPER_A)}, top ${top}).`);
  await owner(
    "INSERT INTO public.evidence_source_snapshots (user_id, study_id, paper_id, seq, source_kind, exact_text, " +
      "exact_sha256, normalized_sha256, normalization_version, char_count) " +
      `SELECT '${EF_OWNER}', '${study}', '${EF_PAPER_A}', ${top} + g, 'library_abstract', c.t, sha256(convert_to(c.t, 'UTF8')), ` +
      "sha256(convert_to(public.evidence_normalize_v1(c.t), 'UTF8')), 'v1', char_length(c.t) " +
      `FROM generate_series(1, ${19 - top}) g, LATERAL (SELECT 'Planted copy ' || g || '.' AS t) c;\n`,
    "planting copies");
  await setAbstract(A(200));
  v = await version();
  const last = await sha(EF_PAPER_A);
  r = await forced("F15",
    held(efCall.rebase(study, EF_PAPER_A, v, last, efRq(29))),
    waits(efCall.rebase(study, EF_PAPER_A, v + 1, last, efRq(30))),
    ["transactionid"], /^OK \{.*"status": "unchanged"/);
  if (elStatusOf(r.held) !== "applied" || efNumberOf(r.held, "seq") !== 20 || efNumberOf(r.waited, "seq") !== 20
      || (await copies(EF_PAPER_A)) !== 20 || (await version()) !== v + 1) {
    fail("F15", `the 20th copy answered ${r.held}, the racing rebase ${r.waited}; the link has ${await copies(EF_PAPER_A)} copies.`);
  }
  await setAbstract(A(201));
  const over = await once("OVER", efCall.rebase(study, EF_PAPER_A, v + 1, await sha(EF_PAPER_A), efRq(31)));
  if (over !== "ERR P0001 evidence_snapshot_limit" || (await copies(EF_PAPER_A)) !== 20) {
    fail("F15", `a rebase past 20 copies answered ${over}.`);
  }
  log(`${EF_NAME} F15 OK: a rebase of the same text racing the one taking the 20th copy waited, then answered unchanged; the next text was refused (evidence_snapshot_limit); 20 copies.`);

  // F12 — the 20th group fits; a 21st, waiting on the study row, is refused.
  await owner(
    `INSERT INTO public.evidence_arms (user_id, study_id, arm_role, display_label, position) ` +
      `SELECT '${EF_OWNER}', '${study}', 'intervention', 'Planted arm ' || g, g FROM generate_series(0, 18) g;\n`,
    "planting 19 groups");
  v = await version();
  r = await forced("F12",
    held(efCall.save(study, v, [efChange.addArm("g20", 19)], efRq(25))),
    waits(efCall.save(study, v + 1, [efChange.addArm("g21", 20)], efRq(26))),
    ["transactionid"], /^ERR P0001 evidence_arm_limit$/);
  const arms = await q(`SELECT count(*) FROM public.evidence_arms WHERE study_id='${study}';`);
  if (elStatusOf(r.held) !== "applied" || arms !== "20") fail("F12", `the 20th group answered ${r.held}; the study has ${arms} groups.`);
  log(`${EF_NAME} F12 OK: the save adding the 21st group waited for the one adding the 20th, then was refused (evidence_arm_limit); 20 groups.`);

  // F13 — 4,998 events; a save makes 5,000; the next, waiting on the study row, is refused.
  const have = await events();
  await owner(
    `INSERT INTO public.evidence_events (user_id, study_id, study_version, ordinal, event_type, request_id, target_id, after) ` +
      `SELECT '${EF_OWNER}', '${study}', 1, 1000 + g, 'study_updated', gen_random_uuid(), '${study}', '{}'::jsonb ` +
      `FROM generate_series(1, ${4998 - have}) g;\n`,
    "planting history");
  v = await version();
  r = await forced("F13",
    held(efCall.save(study, v, [efChange.text("condition", "Asthma, final", (await value("condition")).vv)], efRq(27))),
    waits(efCall.save(study, v + 1, [efChange.text("demographics", "Mean age 55", (await value("demographics")).vv)], efRq(28))),
    ["transactionid"], /^ERR P0001 evidence_history_limit$/);
  if (elStatusOf(r.held) !== "applied" || (await events()) !== 5000) {
    fail("F13", `the save reaching the limit answered ${r.held}; the study has ${await events()} events.`);
  }
  log(`${EF_NAME} F13 OK: a save that would pass 5,000 events waited for the one reaching it, then was refused (evidence_history_limit); exactly 5,000 events.`);

  // Remove the fixture through the account cascade, and prove it is gone.
  await owner(`DELETE FROM auth.users WHERE id='${EF_OWNER}';\n`, "fixture cleanup");
  const residual = await q(
    `SELECT (SELECT count(*) FROM auth.users WHERE id='${EF_OWNER}') + ` +
      `(SELECT count(*) FROM public.papers WHERE user_id='${EF_OWNER}') + ` +
      `(SELECT count(*) FROM public.internal_user_access WHERE user_id='${EF_OWNER}') + ` +
      ["evidence_studies", "evidence_study_reports", "evidence_source_snapshots", "evidence_arms",
        "evidence_outcomes", "evidence_field_values", "evidence_field_anchors", "evidence_events"]
        .map((t) => `(SELECT count(*) FROM public.${t} WHERE user_id='${EF_OWNER}')`).join(" + ") + " + " +
      `(SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${EL_BARRIER_CLASSID} AND objid=${EL_BARRIER_OBJID});`);
  if (residual !== "0") throw new Error(`${EF_NAME} fixture not fully removed (${residual} row(s) or lock(s) remain).`);
}

// ── AI-MULTI-PROVIDER-001C-REVIEW-FIX-01 ─────────────────────────────────────
// AI model / reasoning preference serialization. Its own users, its own
// disposable catalog rows and its own barrier key, so it cannot interact with
// any probe above.
const PL_USER_A = "cc000000-0000-0000-0000-0000000000a1";
const PL_USER_B = "cc000000-0000-0000-0000-0000000000a2";
const PL_USER_C = "cc000000-0000-0000-0000-0000000000a3";
const PL_USER_D = "cc000000-0000-0000-0000-0000000000a4";
const PL_USERS = [PL_USER_A, PL_USER_B, PL_USER_C, PL_USER_D];
const PL_USER_LIST = PL_USERS.map((u) => `'${u}'`).join(",");
// The probe brings its own two disposable catalog rows rather than using the
// real ones, so its WIDE/NARROW asymmetry is fixed by the probe itself and it
// never writes a real row (a BEFORE UPDATE trigger would move its updated_at);
// afterwards it proves the real rows byte-identical. WIDE lists `minimal` and
// NARROW does not — the same asymmetry as Gemini 3.5 against 3.8.
const PL_WIDE = "google/paperlume-lock-probe-wide";
const PL_NARROW = "google/paperlume-lock-probe-narrow";
const PL_BARRIER_KEY = 918273648;
const PL_BARRIER_OBJID = PL_BARRIER_KEY & 0xffffffff;
const PL_BARRIER_CLASSID = Math.floor(PL_BARRIER_KEY / 2 ** 32);
const PL_RACE_ROUNDS = 10; // free-running rounds per scenario, after both forced orders.
const PL_CATALOG_DIGEST_SQL =
  "SELECT md5(COALESCE(string_agg(c::text, '|' ORDER BY c.id), '')) FROM public.ai_model_catalog c;";

/**
 * The preference RPCs as tagged SQL: each `sql(tag)` prints one `${tag}=…` line
 * per call. Every one runs as `authenticated` with the caller's claims, exactly
 * as a client calls it. Until AI-MANUAL-REASONING-001 granted it, the reasoning
 * setter had to run here as its owner; it now takes the same real client path
 * as the other three. Nothing here grants anything.
 */
const plCall = {
  model: (model) => ({
    label: `set_current_user_ai_model(${model === PL_WIDE ? "WIDE" : "NARROW"})`,
    sql: (tag) =>
      "SET ROLE authenticated;\n" +
      `SELECT '${tag}=' || reason || ':' || reasoning_reset::text FROM public.set_current_user_ai_model('${model}');\n` +
      "RESET ROLE;\n",
  }),
  reasoning: (level) => ({
    label: `set_current_user_ai_reasoning(${level})`,
    sql: (tag) =>
      "SET ROLE authenticated;\n" +
      `SELECT '${tag}=' || reason || ':' || (updated_at IS NOT NULL)::text ` +
      `FROM public.set_current_user_ai_reasoning('${level}');\n` +
      "RESET ROLE;\n",
  }),
  clearReasoning: () => ({
    label: "clear_current_user_ai_reasoning()",
    sql: (tag) =>
      "SET ROLE authenticated;\n" +
      `SELECT '${tag}=' || reason FROM public.clear_current_user_ai_reasoning();\n` +
      "RESET ROLE;\n",
  }),
  clearModel: () => ({
    label: "clear_current_user_ai_model()",
    sql: (tag) =>
      "SET ROLE authenticated;\n" +
      `SELECT '${tag}=' || reason FROM public.clear_current_user_ai_model();\n` +
      "RESET ROLE;\n",
  }),
  /** Several calls, committed together by whichever session runs them. */
  together: (...calls) => ({
    label: calls.map((c) => c.label).join(" + "),
    sql: (tag) => calls.map((c) => c.sql(tag)).join(""),
  }),
};

/**
 * Each scenario is two calls, x and y, on one user's row. `xy` is exactly what
 * the serial order "x commits, then y runs" produces — both call results and the
 * final row — and `yx` the reverse. Those are the ONLY acceptable outcomes.
 * `forbids` names what the pre-fix functions could produce instead. A reasoning
 * result reads `reason:wrote`, where `wrote` is whether updated_at came back.
 */
const PL_SCENARIOS = [
  {
    name: "A",
    title: "reasoning save vs incompatible model switch",
    user: PL_USER_A,
    start: { model: PL_WIDE, level: null },
    x: plCall.reasoning("minimal"),
    y: plCall.model(PL_NARROW),
    xy: { x: "ok:true", y: "ok:true", final: `${PL_NARROW}:AUTOMATIC` },
    yx: { x: "reasoning_level_not_supported:false", y: "ok:false", final: `${PL_NARROW}:AUTOMATIC` },
    forbids: "NARROW stored with `minimal`, a level NARROW does not list",
  },
  {
    name: "B",
    title: "reasoning clear vs model switch",
    user: PL_USER_B,
    start: { model: PL_WIDE, level: "high" },
    x: plCall.clearReasoning(),
    y: plCall.model(PL_NARROW),
    xy: { x: "ok", y: "ok:false", final: `${PL_NARROW}:AUTOMATIC` },
    yx: { x: "ok", y: "ok:false", final: `${PL_NARROW}:AUTOMATIC` },
    forbids: "an acknowledged clear resurrected from a stale read (NARROW with `high`)",
  },
  {
    name: "C",
    title: "reasoning save vs model clear",
    user: PL_USER_C,
    start: { model: PL_WIDE, level: null },
    x: plCall.reasoning("medium"),
    y: plCall.clearModel(),
    xy: { x: "ok:true", y: "ok", final: "NO_ROW" },
    yx: { x: "model_required:false", y: "ok", final: "NO_ROW" },
    forbids: "saved = true for a row that had already been deleted (`ok:false`)",
  },
  {
    name: "D",
    title: "first-row creation race",
    user: PL_USER_D,
    start: null,
    x: plCall.together(plCall.model(PL_NARROW), plCall.reasoning("high")),
    y: plCall.model(PL_WIDE),
    xy: { x: "ok:false,ok:true", y: "ok:false", final: `${PL_WIDE}:high` },
    yx: { x: "ok:false,ok:true", y: "ok:false", final: `${PL_NARROW}:high` },
    forbids: "a committed manual level overwritten by a stale no-row read (WIDE on Automatic)",
  },
];

/** Session prelude: become the probe user and report this backend's pid. */
function plPrelude(user) {
  return (
    `SELECT set_config('request.jwt.claims','{"sub":"${user}","role":"authenticated"}', false);\n` +
    "SELECT 'PID=' || pg_backend_pid();\n"
  );
}

/** The backend pid a session reported, or null before it has. */
function plPid(out) {
  const m = /^PID=(\d+)$/m.exec(`${out}`);
  return m ? Number(m[1]) : null;
}

/** Every `${tag}=` line a session printed, in order, comma-joined. */
function plOutcome(out, tag) {
  return `${out}`.split("\n").map((s) => s.trim())
    .filter((l) => l.startsWith(`${tag}=`)).map((l) => l.slice(tag.length + 1)).join(",");
}

/** Whether {x, y, final} is exactly one serial order's outcome. */
function plMatches(expected, got) {
  return ["x", "y", "final"].every((k) => expected[k] === got[k]);
}

/** `model:level` (AUTOMATIC for NULL), or NO_ROW — read on a fresh connection. */
function plState(container, user) {
  return dbScalar(
    container,
    `SELECT COALESCE((SELECT preferred_model_id || ':' || COALESCE(preferred_reasoning_level, 'AUTOMATIC') ` +
      `FROM public.user_ai_preferences WHERE user_id='${user}'), 'NO_ROW');`,
  );
}

/** Commit a scenario's starting row (or its absence), then prove it. */
async function plReset(container, sc) {
  const r = await dockerPsql(
    container,
    `DELETE FROM public.user_ai_preferences WHERE user_id='${sc.user}';\n` +
      (sc.start
        ? "INSERT INTO public.user_ai_preferences (user_id, preferred_model_id, preferred_reasoning_level) " +
          `VALUES ('${sc.user}','${sc.start.model}',${sc.start.level ? `'${sc.start.level}'` : "NULL"});\n`
        : ""),
  );
  if (r.code !== 0) throw new Error(`preference-lock ${sc.name}: resetting the starting row failed: ${r.err.trim()}`);
  const expected = sc.start ? `${sc.start.model}:${sc.start.level ?? "AUTOMATIC"}` : "NO_ROW";
  const actual = await plState(container, sc.user);
  if (actual !== expected) {
    throw new Error(`preference-lock ${sc.name}: the starting row is ${actual}, expected ${expected}.`);
  }
}

/** Advisory locks on this probe's barrier key; `waiting` counts only ungranted ones. */
async function countPlBarrierLocks(container, waiting) {
  const n = await dbScalar(
    container,
    `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${PL_BARRIER_CLASSID} ` +
      `AND objid=${PL_BARRIER_OBJID}${waiting ? " AND NOT granted" : ""};`,
  );
  return parseInt(n || "0", 10);
}

/** Committed fixture: two disposable catalog rows and four entitled users. */
async function plSetupFixture(container) {
  const setup = await dockerPsql(
    container,
    "INSERT INTO public.ai_model_catalog (id, provider, provider_model, display_name, enabled, selectable, " +
      "sort_order, reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level, reasoning_selectable) VALUES\n" +
      `  ('${PL_WIDE}','google','${PL_WIDE.split("/")[1]}','Lock probe (wide)',true,true,9001,` +
      "ARRAY['minimal','low','medium','high'],'minimal','medium',true),\n" +
      `  ('${PL_NARROW}','google','${PL_NARROW.split("/")[1]}','Lock probe (narrow)',true,true,9002,` +
      "ARRAY['low','medium','high'],'low','medium',true);\n" +
      "INSERT INTO auth.users (id, email) VALUES " +
      PL_USERS.map((u, i) => `('${u}','preference-lock-${i + 1}@paperlume.test')`).join(", ") +
      " ON CONFLICT DO NOTHING;\n" +
      "UPDATE public.user_entitlements SET plan='pro', plan_status='active', ai_model_selection_enabled=true " +
      `WHERE user_id IN (${PL_USER_LIST});\n`,
  );
  if (setup.code !== 0) throw new Error(`preference-lock fixture setup failed: ${setup.err.trim()}`);
  // Otherwise every scenario would stop at the entitlement check and prove nothing.
  const entitled = parseInt(await dbScalar(
    container,
    `SELECT count(*) FROM public.user_entitlements WHERE user_id IN (${PL_USER_LIST}) ` +
      "AND ai_model_selection_enabled AND plan_status = 'active';",
  ), 10);
  if (entitled !== PL_USERS.length) {
    throw new Error(`preference-lock fixture: ${entitled} of ${PL_USERS.length} probe users are entitled.`);
  }
}

/** Remove the fixture, prove it gone, and prove the real catalog byte-identical. */
async function plRemoveFixture(container, catalogBefore) {
  await waitUntil(async () => (await countPlBarrierLocks(container, false)) === 0, PROBE_KILL_WAIT_MS,
    "preference-lock probe: advisory locks remain on its barrier key.");
  const cleanup = await dockerPsql(
    container,
    `DELETE FROM public.user_ai_preferences WHERE user_id IN (${PL_USER_LIST});\n` +
      `DELETE FROM auth.users WHERE id IN (${PL_USER_LIST});\n` +
      `DELETE FROM public.ai_model_catalog WHERE id IN ('${PL_WIDE}','${PL_NARROW}');\n`,
  );
  if (cleanup.code !== 0) throw new Error(`preference-lock fixture cleanup failed: ${cleanup.err.trim()}`);
  const residual = (await dbScalar(
    container,
    `SELECT (SELECT count(*) FROM auth.users WHERE id IN (${PL_USER_LIST})) || '|' || ` +
      `(SELECT count(*) FROM public.user_entitlements WHERE user_id IN (${PL_USER_LIST})) || '|' || ` +
      `(SELECT count(*) FROM public.user_ai_preferences WHERE user_id IN (${PL_USER_LIST})) || '|' || ` +
      `(SELECT count(*) FROM public.ai_model_catalog WHERE id IN ('${PL_WIDE}','${PL_NARROW}')) || '|' || ` +
      `(SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${PL_BARRIER_CLASSID} ` +
      `AND objid=${PL_BARRIER_OBJID});`,
  )).split("|").map((s) => parseInt(s, 10));
  if (residual.some((c) => c !== 0)) {
    throw new Error(
      `preference-lock fixture not fully removed (users|entitlements|preferences|catalog rows|advisory = ${residual.join("|")}).`);
  }
  const catalogAfter = await dbScalar(container, PL_CATALOG_DIGEST_SQL);
  if (catalogAfter !== catalogBefore) {
    throw new Error("preference-lock probe: ai_model_catalog differs from its state before the probe.");
  }
  log("preference-lock fixture removed; ai_model_catalog is byte-identical to its pre-probe state.");
}

/**
 * One forced ordering. `first` runs in a transaction that stays OPEN after its
 * call returns, so it keeps every lock it took. `second` then starts and must be
 * seen blocked BY that session — pg_blocking_pids names the holder's pid —
 * before `first` commits. The results and final row must then be exactly the
 * serial order first→second.
 */
async function runPlForcedOrder(container, sc, order) {
  const [firstKey, secondKey] = order === "xy" ? ["x", "y"] : ["y", "x"];
  const first = sc[firstKey];
  const second = sc[secondKey];
  const label = `preference-lock ${sc.name} [${first.label} holds; ${second.label} waits]`;
  await plReset(container, sc);

  let held = null;
  let waiter = null;
  try {
    held = spawnDockerPsql(container);
    held.child.stdin.write(plPrelude(sc.user) + "BEGIN;\n" + first.sql("HELD") + "SELECT 'HELD_READY';\n");
    await waitUntil(() => /HELD_READY/.test(held.readOut()), PROBE_WORKER_MS,
      `${label}: the held transaction never completed its call.`);
    const heldPid = plPid(held.readOut());
    if (heldPid === null) throw new Error(`${label}: the held session never reported its pid.`);

    waiter = spawnDockerPsql(container);
    waiter.child.stdin.write(
      plPrelude(sc.user) + "BEGIN;\n" + second.sql("OUTCOME") + "COMMIT;\nSELECT 'WAITER_DONE';\n");
    waiter.child.stdin.end();
    await waitUntil(() => plPid(waiter.readOut()) !== null, PROBE_WORKER_MS,
      `${label}: the waiting session never reported its pid.`);
    const waiterPid = plPid(waiter.readOut());

    let waitEvent = "";
    await waitUntil(async () => {
      const [blocked, event] = (await dbScalar(
        container,
        `SELECT (pg_blocking_pids(${waiterPid}) = ARRAY[${heldPid}])::text || '|' || ` +
          `COALESCE((SELECT wait_event_type || '/' || wait_event FROM pg_stat_activity WHERE pid = ${waiterPid}), '');`,
      )).split("|");
      waitEvent = event;
      return blocked === "true";
    }, PROBE_BARRIER_MS, `${label}: the second call was never blocked by the held transaction.`);
    if (/OUTCOME=|WAITER_DONE/.test(waiter.readOut())) {
      throw new Error(`${label}: the second call returned while the first transaction was still open.`);
    }

    held.child.stdin.write("COMMIT;\nSELECT 'HELD_COMMITTED';\n");
    held.child.stdin.end();
    const [heldRes, waitRes] = await Promise.all([
      withTimeout(held.done, FIN_HOLD_MS, `${label} held-transaction exit`),
      withTimeout(waiter.done, FIN_HOLD_MS, `${label} waiter exit`),
    ]);
    held = null;
    waiter = null;
    if (heldRes.code !== 0 || heldRes.signal !== null || !/HELD_COMMITTED/.test(heldRes.out)) {
      throw new Error(`${label}: the held transaction did not commit cleanly (code=${heldRes.code}).`);
    }
    if (waitRes.code !== 0 || waitRes.signal !== null || !/WAITER_DONE/.test(waitRes.out)) {
      throw new Error(`${label}: the second call did not commit cleanly (code=${waitRes.code}).`);
    }

    const got = {
      [firstKey]: plOutcome(heldRes.out, "HELD"),
      [secondKey]: plOutcome(waitRes.out, "OUTCOME"),
      final: await plState(container, sc.user),
    };
    const want = sc[order];
    if (!plMatches(want, got)) {
      throw new Error(
        `${label}: got x=${got.x}, y=${got.y}, final=${got.final}, but the serial order ${firstKey}→${secondKey} ` +
          `gives x=${want.x}, y=${want.y}, final=${want.final}. Forbidden: ${sc.forbids}.`);
    }
    log(`${label} OK: blocked on ${waitEvent || "a lock"} held by the first session, then ` +
      `x=${got.x}, y=${got.y}, final=${got.final} — exactly the serial order ${firstKey}→${secondKey}.`);
  } catch (err) {
    await killPsql(waiter);
    await killPsql(held);
    throw err;
  }
}

/**
 * One free-running round: both calls wait on a shared barrier and are released
 * together, so Postgres — not the probe — chooses the interleaving. The result
 * must be one of the scenario's two serial outcomes, and both sessions must
 * commit: under ON_ERROR_STOP a deadlock (40P01) or serialization failure
 * (40001) exits nonzero and fails the round. Returns which order it matched.
 */
async function runPlRaceRound(container, sc, round) {
  const label = `preference-lock ${sc.name} race round ${round}`;
  await plReset(container, sc);
  let coord = null;
  let wx = null;
  let wy = null;
  try {
    coord = spawnDockerPsql(container);
    coord.child.stdin.write(`SELECT pg_advisory_lock(${PL_BARRIER_KEY}); SELECT 'COORD_LOCKED';\n`);
    await waitUntil(() => /COORD_LOCKED/.test(coord.readOut()), PROBE_COORD_ACQUIRE_MS,
      `${label}: the coordinator never acquired the barrier.`);
    const startWorker = (call) => {
      const w = spawnDockerPsql(container);
      w.child.stdin.write(
        plPrelude(sc.user) + `SELECT pg_advisory_lock_shared(${PL_BARRIER_KEY});\n` +
          "BEGIN;\n" + call.sql("OUTCOME") + "COMMIT;\nSELECT 'WORKER_DONE';\n");
      w.child.stdin.end();
      return w;
    };
    wx = startWorker(sc.x);
    wy = startWorker(sc.y);
    await waitUntil(async () => (await countPlBarrierLocks(container, true)) >= 2, PROBE_BARRIER_MS,
      `${label}: both calls did not reach the barrier.`);
    coord.child.stdin.write(`SELECT 'UNLOCK=' || pg_advisory_unlock(${PL_BARRIER_KEY})::text;\n`);
    coord.child.stdin.end();
    const [cr, rx, ry] = await Promise.all([
      withTimeout(coord.done, PROBE_COORD_EXIT_MS, `${label} coordinator exit`),
      withTimeout(wx.done, PROBE_WORKER_MS, `${label} x exit`),
      withTimeout(wy.done, PROBE_WORKER_MS, `${label} y exit`),
    ]);
    coord = null;
    wx = null;
    wy = null;
    if (cr.code !== 0 || cr.signal !== null || !/UNLOCK=t/.test(cr.out)) {
      throw new Error(`${label}: the coordinator did not release the barrier cleanly (code=${cr.code}).`);
    }
    for (const [key, r] of [["x", rx], ["y", ry]]) {
      if (r.code !== 0 || r.signal !== null || !/WORKER_DONE/.test(r.out)) {
        throw new Error(
          `${label}: ${sc[key].label} did not commit cleanly (code=${r.code}, signal=${r.signal ?? "none"}); ` +
            "a deadlock or serialization failure ends here.");
      }
    }
    const got = {
      x: plOutcome(rx.out, "OUTCOME"),
      y: plOutcome(ry.out, "OUTCOME"),
      final: await plState(container, sc.user),
    };
    const orders = ["xy", "yx"].filter((o) => plMatches(sc[o], got));
    if (orders.length === 0) {
      throw new Error(
        `${label}: x=${got.x}, y=${got.y}, final=${got.final} matches neither serial order. Forbidden: ${sc.forbids}.`);
    }
    return orders.length === 2 ? "either" : orders[0];
  } catch (err) {
    await killPsql(wx);
    await killPsql(wy);
    await killPsql(coord);
    throw err;
  }
}

/**
 * True-concurrency AI model / reasoning preference probe
 * (AI-MULTI-PROVIDER-001C-REVIEW-FIX-01).
 *
 * set_current_user_ai_model decides whether a saved manual reasoning level
 * survives a model switch; set_current_user_ai_reasoning decides whether a
 * level is valid for the saved model. Each reads the preference row and writes
 * it later. Under READ COMMITTED, sharing one transaction does not stop another
 * writer committing in between, so the reviewed design could store a model
 * with a level that model rejects, resurrect a level the user had just cleared,
 * or answer saved = true for a row that had just been deleted. Both setters now
 * lock the caller's row FOR UPDATE before deciding.
 *
 * A single-connection pgTAP suite cannot interleave anything, so this uses real
 * sessions. In each scenario, each call is in turn made to commit first while
 * the other is observed blocked BY it, and the results and final row must be
 * exactly that serial order's. Then PL_RACE_ROUNDS free-running rounds release
 * both calls from a barrier at once: every round must match one of the two
 * serial outcomes, and both sessions must commit.
 *
 * Same fail-closed discipline as the probes above: every process tracked and
 * bounded, blocking proven through pg_blocking_pids rather than inferred from a
 * sleep, clean exits required, and the fixture proven absent afterwards — with
 * the real catalog rows proven byte-identical. Nothing is granted: every call,
 * the reasoning setter included, runs as `authenticated`.
 */
async function runPreferenceLockProbe(container) {
  log("running true-concurrency AI model/reasoning preference probe…");
  const catalogBefore = await dbScalar(container, PL_CATALOG_DIGEST_SQL);
  await plSetupFixture(container);
  for (const sc of PL_SCENARIOS) {
    await runPlForcedOrder(container, sc, "xy");
    await runPlForcedOrder(container, sc, "yx");
    const seen = { xy: 0, yx: 0, either: 0 };
    for (let round = 1; round <= PL_RACE_ROUNDS; round++) {
      seen[await runPlRaceRound(container, sc, round)] += 1;
    }
    log(`preference-lock ${sc.name} (${sc.title}) races OK: ${PL_RACE_ROUNDS}/${PL_RACE_ROUNDS} rounds matched a ` +
      `serial order (x first ${seen.xy}, y first ${seen.yx}, indistinguishable ${seen.either}); ` +
      "no deadlock, no serialization failure.");
  }
  await plRemoveFixture(container, catalogBefore);
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

/* ═══════════════════════════════════════════════════════════════════════════
 * DATA-API-ACL-RECONCILIATION-001 — hosted-Production ACL parity lane
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS LANE EXISTS. Hosted Production and a clean `db reset` do not start
 * from the same object privileges, and never have. Production still carries the
 * broad grants its platform default handed out — `anon` holds every privilege on
 * 17 tables — while a local replay under the current CLI inherits only the
 * non-DML residue. Every ACL test in this repository ran against the second
 * shape, which is exactly why drift on the first stayed invisible until a
 * Production rollout hit it (see `runAclParityProbe`, which fixed the same blind
 * spot for two tables).
 *
 * So a green suite on a clean replay is not evidence that the reconciliation
 * migration converges Production. This lane produces that evidence:
 *
 *   1. reset to the migration BASELINE — the last migration before the
 *      reconciliation — so the reconciliation has not run yet;
 *   2. prove suite 015 FAILS here (negative control: a suite that cannot fail
 *      proves nothing);
 *   3. prove the migration REFUSES a default-privilege entry outside the two
 *      audited histories before changing anything — an unexplained
 *      `authenticated` shape (NC6a) and an unreviewed grantee (NC6b) — then
 *      prove the lane is byte-identical to its state before each control;
 *   4. seed hosted Production's ACL state and prove the seed reproduced it
 *      EXACTLY, against a committed read-only reference — a seed that silently
 *      did nothing would make every assertion below vacuous;
 *   5. prove suite 015 still FAILS on the hosted shape;
 *   6. apply the pending migration(s) with the CLI, from the real migration
 *      file — never a hand-copied transcription of its statements, so the
 *      lane cannot drift from the implementation it is testing;
 *   7. prove suite 015 PASSES, and (NC4) that the full chain leaves
 *      `service_role` at the C57 target from this hosted history too;
 *   8. prove a NEW table that forgets its ACLs is unreachable at runtime AND
 *      fails CI;
 *   8b. prove the same for a NEW function (NC7): since C56
 *      (`20260928133918_harden_default_function_execute.sql`) and C57
 *      (`20260929084252_harden_service_role_least_privilege.sql`), both applied
 *      by step 6 from Production's explicit function ACL and default shape, it
 *      reaches no client role and not service_role either, and it fails CI;
 *   9. prove a grantee nobody named, arriving AFTER the migration, fails CI
 *      through the allowlist assertions (NC6c).
 *
 * It runs in the db-tests lifecycle only, never in the E2E lane, and it adds one
 * reset + replay rather than a second Playwright run.
 */
const ACL_MIGRATION = "supabase/migrations/20260910212202_reconcile_data_api_acls.sql";
const ACL_BASELINE_VERSION = "20260904120000";
const ACL_HOSTED_SEED = "scripts/acl-parity/hosted-baseline-20260904120000.sql";
const ACL_HOSTED_REFERENCE = "scripts/acl-parity/hosted-baseline-20260904120000.reference.json";
const ACL_MATRIX_SUITE = "supabase/tests/database/015_data_api_acl_matrix.test.sql";
const ACL_NC2_TABLE = "zz_acl_nc2_forgotten";
const ACL_NC7_FUNCTION = "zz_acl_nc7_forgotten";

/**
 * The whole object-privilege and default-privilege state, plus the migration
 * ledger, as sortable lines. A refused migration must leave every one of them
 * exactly as it found them, and a control's clean-up must restore them exactly.
 */
const ACL_FULL_STATE_SQL = [
  "SELECT 'ledger|' || count(*) || '|' || max(version) FROM supabase_migrations.schema_migrations;",
  "SELECT 'rel|' || c.relname || '|' || coalesce(c.relacl::text,'NULL') FROM pg_class c " +
    "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S');",
  "SELECT 'col|' || c.relname || '.' || a.attname || '|' || a.attacl::text FROM pg_attribute a " +
    "JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
    "WHERE n.nspname='public' AND a.attacl IS NOT NULL;",
  "SELECT 'fn|' || p.oid::regprocedure::text || '|' || coalesce(p.proacl::text,'NULL') FROM pg_proc p " +
    "JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public';",
  "SELECT 'def|' || pg_get_userbyid(d.defaclrole) || '|' || coalesce(n.nspname,'<global>') || '|' || " +
    "d.defaclobjtype::text || '|' || d.defaclacl::text FROM pg_default_acl d " +
    "LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace;",
].join("\n");

/**
 * NC6 — default-privilege states the migration must REFUSE before it changes
 * anything. Each is one statement away from the supported clean-replay (H2)
 * shape, and each was ACCEPTED by the preconditions as first written, which
 * checked `anon` alone: NC6a was silently normalized by D1a, and NC6b committed
 * with the unreviewed grantee still in the default entry.
 *
 * Each `refusal` pattern matches the raised error WITH its substituted values.
 * The CLI echoes the failing statement's source after the error, and that source
 * contains every RAISE text with `%` placeholders, so a pattern on the bare
 * wording could be satisfied by the echo of a different failure.
 */
const ACL_NC6_CASES = [
  {
    id: "NC6a",
    what: "an authenticated TABLE default outside the audited histories, with anon left in H2",
    inject: "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;",
    undo: "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT ON TABLES FROM authenticated;",
    refusal: /ERROR: data-api-acl: postgres\/public client-role default privileges match neither audited starting history as a whole \(tables: anon \{[A-Z,]*\}, authenticated \{[A-Z,]*SELECT[A-Z,]*\};/,
  },
  {
    id: "NC6b",
    what: "a TABLE default for a role outside the approved default ACL (authenticator)",
    inject: "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO authenticator;",
    undo: "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT ON TABLES FROM authenticator;",
    refusal: /ERROR: data-api-acl: unexpected default-privilege grantee\(s\) on postgres\/public tables or sequences: r:authenticator /,
  },
];

/** Catalog dumps compared against the committed hosted-Production reference. */
const ACL_DUMP_SQL = {
  relacl:
    "SELECT c.relname || '|' || coalesce(c.relacl::text,'NULL') " +
    "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
    "WHERE n.nspname='public' AND c.relkind IN ('r','S') ORDER BY 1;",
  proacl:
    "SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || coalesce(p.proacl::text,'NULL') " +
    "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' ORDER BY 1;",
  default_acl:
    "SELECT pg_get_userbyid(d.defaclrole) || '|' || d.defaclobjtype::text || '|' || d.defaclacl::text " +
    "FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname='public' ORDER BY 1;",
};

/**
 * Everything `service_role` holds in `public` — relation privileges AND the
 * default privileges it inherits on future objects — as one scalar.
 *
 * NC4 used to prove the reconciliation left all of it alone. `migration up`
 * applies EVERY pending migration, though, and C57
 * (`20260929084252_harden_service_role_least_privilege.sql`) now removes it on
 * purpose, so NC4 proves the other half of the story instead: seeded with
 * hosted Production's broad grants, the full chain ends with service_role
 * holding nothing on any relation that existed at the baseline and no default
 * at all. (The reconciliation's own verification block still proves it did not
 * touch service_role; C57's lane proves its three starting shapes.)
 */
//
// AI-MULTI-PROVIDER-001D: both snapshots are scoped to the relations that
// existed at the baseline — a relation a later migration creates, with its own
// deliberately stated service_role grant (the telemetry INSERT), is that
// migration's business and is pinned by suites 015, 017 and 026 instead.
const aclServiceRoleSnapshotSql = (baselineRelations) =>
  "SELECT coalesce((SELECT string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type) " +
  "  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, " +
  "       aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind='S' THEN 's'::\"char\" ELSE 'r'::\"char\" END, c.relowner))) a " +
  " WHERE n.nspname='public' AND c.relkind IN ('r','S') AND a.grantee = 'service_role'::regrole " +
  `   AND c.relname = ANY(string_to_array('${baselineRelations}', ','))), '') ` +
  "|| ' // ' || " +
  "coalesce((SELECT string_agg(d.defaclobjtype::text || ':' || x.privilege_type, ',' ORDER BY d.defaclobjtype::text, x.privilege_type) " +
  "  FROM pg_default_acl d JOIN pg_namespace nn ON nn.oid = d.defaclnamespace, aclexplode(d.defaclacl) x " +
  " WHERE nn.nspname='public' AND pg_get_userbyid(d.defaclrole) = 'postgres' AND x.grantee = 'service_role'::regrole), '');";

/** Run one pgTAP suite alone; returns {passed, failed: [assertion names]}. */
async function runDbSuite(suitePath) {
  const res = await runCapture("supabase", ["test", "db", suitePath, "--local"]);
  const combined = `${res.out}\n${res.err}`;
  const failed = [...combined.matchAll(/# *Failed test \d+: "([^"]+)"/g)].map((m) => m[1]);
  return { passed: res.code === 0, failed, combined };
}

/** Run suite 015 alone; returns {passed, failed: [assertion names]}. */
async function runAclMatrixSuite() {
  return runDbSuite(ACL_MATRIX_SUITE);
}

/**
 * Require a suite (015 unless named) to FAIL, and to fail for the stated
 * reasons. An expected-failure control that accepts ANY failure would also
 * accept a syntax error, so each caller names the assertion prefixes it is
 * proving are detected.
 */
function assertAclSuiteFailed(label, result, mustNamePrefixes, suite = "suite 015") {
  if (result.passed) {
    throw new Error(
      `${label}: ${suite} passed where it must fail. The negative control proves nothing — ` +
        `the suite cannot detect the state it exists to detect.`,
    );
  }
  for (const prefix of mustNamePrefixes) {
    if (!result.failed.some((name) => name.startsWith(prefix))) {
      throw new Error(
        `${label}: ${suite} failed, but no "${prefix}" assertion is among the failures ` +
          `(${result.failed.length} failed) — it failed for the wrong reason.`,
      );
    }
  }
}

/** A sorted catalog dump, for exact comparison against the reference. */
async function aclDump(container, sql) {
  const r = await dockerPsql(container, sql);
  if (r.code !== 0) throw new Error(`ACL parity lane: catalog dump failed: ${r.err.trim() || "(no stderr)"}`);
  return r.out.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

async function aclFullState(container) {
  return (await aclDump(container, ACL_FULL_STATE_SQL)).join("\n");
}

/**
 * One NC6 refusal control. Requires, in order: the injection really changed the
 * state (else the control is vacuous); `supabase migration up` fails, and fails
 * with the named precondition refusal rather than for any other reason; the
 * migration is absent from the ledger; and every ACL and default privilege —
 * the injected one included — is exactly as it was, i.e. the whole file rolled
 * back as one transaction. The injection is then removed and the lane must be
 * byte-identical to its state before the control.
 */
async function runAclRefusalControl(container, aclVersion, c) {
  const clean = await aclFullState(container);
  const inject = await dockerPsql(container, c.inject);
  if (inject.code !== 0) {
    throw new Error(`ACL parity lane (${c.id}): could not inject the unsupported state: ${inject.err.trim() || "(no stderr)"}`);
  }
  try {
    const injected = await aclFullState(container);
    if (injected === clean) {
      throw new Error(`ACL parity lane (${c.id}): the injection changed nothing, so the control would prove nothing.`);
    }
    const up = await runCapture("supabase", ["migration", "up", "--local"]);
    const said = `${up.out}\n${up.err}`;
    if (up.code === 0) {
      throw new Error(`ACL parity lane (${c.id}): the migration ACCEPTED ${c.what}. It must refuse it before changing anything.`);
    }
    if (!c.refusal.test(said)) {
      throw new Error(
        `ACL parity lane (${c.id}): the migration failed, but not with the expected precondition refusal — ` +
          `it failed for the wrong reason:\n${said.trim().split("\n").slice(-6).join("\n")}`,
      );
    }
    const inLedger = await dbScalar(container,
      `SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '${aclVersion}';`);
    if (inLedger !== "0") {
      throw new Error(`ACL parity lane (${c.id}): the refused migration ${aclVersion} is in the ledger.`);
    }
    if ((await aclFullState(container)) !== injected) {
      throw new Error(
        `ACL parity lane (${c.id}): the refused migration still changed ACL or default-privilege state — ` +
          "it did not roll back as one transaction.",
      );
    }
  } finally {
    const undo = await dockerPsql(container, c.undo);
    if (undo.code !== 0) {
      throw new Error(`ACL parity lane (${c.id}): could not remove the injected state: ${undo.err.trim() || "(no stderr)"}`);
    }
  }
  if ((await aclFullState(container)) !== clean) {
    throw new Error(`ACL parity lane (${c.id}): the lane is not byte-identical to its pre-control state after clean-up.`);
  }
  log(`${c.id} OK: the migration refused ${c.what} before any change — not in the ledger, every ACL and default privilege untouched.`);
}

async function runHostedAclParityLane() {
  log("running hosted-Production ACL parity lane (DATA-API-ACL-RECONCILIATION-001)…");

  for (const rel of [ACL_MIGRATION, ACL_HOSTED_SEED, ACL_HOSTED_REFERENCE, ACL_MATRIX_SUITE]) {
    if (!existsSync(resolve(ROOT, rel))) throw new Error(`ACL parity lane: missing ${rel}.`);
  }

  // The lane is only meaningful if the reconciliation migration really is after
  // the baseline it resets to; a renamed or reordered migration must fail here
  // rather than silently turn step 5 into a no-op.
  const aclVersion = ACL_MIGRATION.split("/").pop().split("_")[0];
  if (!(aclVersion > ACL_BASELINE_VERSION)) {
    throw new Error(`ACL parity lane: ${aclVersion} is not after the baseline ${ACL_BASELINE_VERSION}.`);
  }

  // ── 1. Back to the baseline: the reconciliation has not run yet ───────────
  const resetCode = await runInherit(
    "supabase",
    ["db", "reset", "--local", "--no-seed", "--version", ACL_BASELINE_VERSION],
  );
  if (resetCode !== 0) throw new Error("ACL parity lane: `supabase db reset --version` failed.");

  const container = await resolveLocalDbContainer();
  const atBaseline = await dbScalar(container,
    "SELECT max(version) FROM supabase_migrations.schema_migrations;");
  if (atBaseline !== ACL_BASELINE_VERSION) {
    throw new Error(`ACL parity lane: expected the ledger at ${ACL_BASELINE_VERSION}, found ${atBaseline}.`);
  }

  // ── 2. NC1 — the suite must fail on the pre-migration clean replay ────────
  assertAclSuiteFailed("NC1 (clean replay, pre-migration)", await runAclMatrixSuite(),
    ["ACL-B2", "ACL-C1", "ACL-E1", "ACL-G1"]);
  log("NC1 OK: the ACL matrix suite fails against the pre-migration clean replay.");

  // ── 3. NC6a/NC6b — unsupported default-privilege starting states ─────────
  // Run on the clean-replay (H2) lane BEFORE seeding: each control restores the
  // lane byte-for-byte, and step 4's exact comparison against the Production
  // reference independently proves nothing was left behind.
  for (const c of ACL_NC6_CASES) await runAclRefusalControl(container, aclVersion, c);

  // ── 4. Seed hosted Production, and prove the seed took ────────────────────
  const seed = await dockerPsql(container, readFileSync(resolve(ROOT, ACL_HOSTED_SEED), "utf-8"));
  if (seed.code !== 0) {
    throw new Error(`ACL parity lane: the hosted-Production seed failed: ${seed.err.trim() || "(no stderr)"}`);
  }
  const reference = JSON.parse(readFileSync(resolve(ROOT, ACL_HOSTED_REFERENCE), "utf-8"));
  for (const key of ["relacl", "proacl", "default_acl"]) {
    const actual = await aclDump(container, ACL_DUMP_SQL[key]);
    const expected = [...reference[key]].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const missing = expected.filter((l) => !actual.includes(l)).slice(0, 3);
      const extra = actual.filter((l) => !expected.includes(l)).slice(0, 3);
      throw new Error(
        `ACL parity lane: after seeding, ${key} does not match hosted Production ` +
          `(${actual.length} rows vs ${expected.length}). Missing: ${missing.join(" ; ") || "none"}. ` +
          `Unexpected: ${extra.join(" ; ") || "none"}. This lane would prove nothing in that state.`,
      );
    }
  }
  log(`hosted-Production ACL seed verified against ${ACL_HOSTED_REFERENCE} (relations, routines, default privileges).`);

  // ── 5. NC3 — the suite must fail on the hosted shape too ──────────────────
  assertAclSuiteFailed("NC3 (hosted Production ACL, pre-migration)", await runAclMatrixSuite(),
    ["ACL-B2", "ACL-C1", "ACL-E1", "ACL-G1"]);
  log("NC3 OK: the ACL matrix suite fails against hosted Production's legacy ACL.");

  // ── 6. Apply the real migration file, through the real CLI path ───────────
  // The relations present at the baseline — the set NC4 is a claim about.
  const baselineRelations = await dbScalar(container,
    "SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') FROM pg_class c " +
      "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S');");
  if (!/^[a-z0-9_,]+$/.test(baselineRelations)) {
    throw new Error("ACL parity lane: could not read the baseline relation set for NC4.");
  }
  const serviceRoleBefore = await dbScalar(container, aclServiceRoleSnapshotSql(baselineRelations));
  const upCode = await runInherit("supabase", ["migration", "up", "--local"]);
  if (upCode !== 0) throw new Error("ACL parity lane: `supabase migration up --local` failed.");
  const applied = await dbScalar(container,
    `SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '${aclVersion}';`);
  if (applied !== "1") {
    throw new Error(`ACL parity lane: migration ${aclVersion} is not in the local ledger after \`migration up\`.`);
  }

  // ── 7. The convergence proof, and NC4 ─────────────────────────────────────
  const converged = await runAclMatrixSuite();
  if (!converged.passed) {
    throw new Error(
      `ACL parity lane: the migration did NOT converge hosted Production's ACL — suite 015 still fails ` +
        `(${converged.failed.slice(0, 6).join("; ")}).`,
    );
  }
  log("hosted-parity convergence OK: suite 015 passes from hosted Production's starting ACL.");

  // Before: the seed's broad grants must really be there, or "after" proves nothing.
  // dbScalar trims, so an empty half leaves only "//"; split and trim both halves.
  const [relationsBefore = "", defaultsBefore = ""] = serviceRoleBefore.split("//").map((half) => half.trim());
  if (!relationsBefore.split(",").includes("papers:TRUNCATE") || !defaultsBefore.split(",").includes("r:SELECT")) {
    throw new Error(
      `ACL parity lane (NC4): the hosted seed did not give service_role its broad grants (${serviceRoleBefore.slice(0, 200)}), ` +
        "so the end state below would prove nothing.",
    );
  }
  const serviceRoleAfter = await dbScalar(container, aclServiceRoleSnapshotSql(baselineRelations));
  const [relationsAfter = "", defaultsAfter = ""] = serviceRoleAfter.split("//").map((half) => half.trim());
  if (relationsAfter !== "" || defaultsAfter !== "") {
    throw new Error(
      `ACL parity lane (NC4): from hosted Production's history the full chain leaves service_role holding ` +
        `${serviceRoleAfter.slice(0, 300)} — C57 requires nothing on these relations and no default.`,
    );
  }
  log("NC4 OK: from hosted Production's broad starting grants, the full chain leaves service_role nothing on any baseline relation and no default (C57).");

  // ── 8. NC2 — a future table whose author forgot its ACLs ──────────────────
  // Two independent guarantees, and the lane requires BOTH: the table is
  // unreachable at runtime (fail-closed, from the default-privilege hardening),
  // and CI refuses to accept it (fail-loud, from the catalog-driven guard).
  const create = await dockerPsql(container, `CREATE TABLE public.${ACL_NC2_TABLE} (id bigserial PRIMARY KEY);`);
  if (create.code !== 0) throw new Error(`ACL parity lane: could not create the NC2 probe table: ${create.err.trim()}`);
  try {
    const reachable = await dbScalar(container,
      "SELECT coalesce(string_agg(a.grantee::regrole::text || ':' || a.privilege_type, ',' ORDER BY a.privilege_type), '') " +
        "FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r'::\"char\", c.relowner))) a " +
        `WHERE c.oid = 'public.${ACL_NC2_TABLE}'::regclass ` +
        "AND a.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole);");
    if (reachable !== "") {
      throw new Error(
        `ACL parity lane (NC2): a new table created after the default-privilege hardening still reaches a client role: ${reachable}`,
      );
    }
    assertAclSuiteFailed("NC2 (future table with no ACL statements)", await runAclMatrixSuite(), ["ACL-A1"]);
    log("NC2 OK: an unclassified new table is unreachable by every client role AND fails the suite.");
  } finally {
    const drop = await dockerPsql(container, `DROP TABLE IF EXISTS public.${ACL_NC2_TABLE};`);
    if (drop.code !== 0) throw new Error(`ACL parity lane: could not drop the NC2 probe table: ${drop.err.trim()}`);
  }

  // ── 8b. NC7 — a future FUNCTION whose author forgot its ACL (C56, C57) ────
  // The same two guarantees for the function surface, from Production's own
  // starting defaults. At runtime the function reaches neither PUBLIC (the
  // built-in default C56 revoked globally) nor anon/authenticated (the schema
  // entry C56 narrowed) nor service_role (whose hosted default C57 removed).
  // And CI refuses it: suite 015's SECURITY INVOKER inventory (ACL-H1) no longer
  // matches.
  const beforeNc7 = await aclFullState(container);
  const create7 = await dockerPsql(container,
    `CREATE FUNCTION public.${ACL_NC7_FUNCTION}() RETURNS integer LANGUAGE sql AS 'SELECT 1';`);
  if (create7.code !== 0) throw new Error(`ACL parity lane: could not create the NC7 probe function: ${create7.err.trim()}`);
  try {
    const reach = await dbScalar(container,
      "SELECT coalesce(string_agg(x, ',' ORDER BY x), '<nobody>') FROM (" +
        "SELECT 'PUBLIC' AS x FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::\"char\", p.proowner))) a " +
        `WHERE p.oid = 'public.${ACL_NC7_FUNCTION}()'::regprocedure AND a.grantee = 0 ` +
        "UNION ALL SELECT r FROM unnest(ARRAY['anon','authenticated','service_role']) r " +
        `WHERE has_function_privilege(r, 'public.${ACL_NC7_FUNCTION}()'::regprocedure, 'EXECUTE')) s;`);
    if (reach !== "<nobody>") {
      throw new Error(
        `ACL parity lane (NC7): a new function created after the hardening reaches [${reach}]; ` +
          "expected nobody (no PUBLIC, anon or authenticated since C56, no service_role since C57).",
      );
    }
    const flagged7 = await runAclMatrixSuite();
    assertAclSuiteFailed("NC7 (future function with no ACL statements)", flagged7, ["ACL-H1"]);
    const unexpected7 = flagged7.failed.filter((name) => !name.startsWith("ACL-H1"));
    if (unexpected7.length > 0) {
      throw new Error(
        `ACL parity lane (NC7): suite 015 also failed ${unexpected7.join("; ")} — the new function was ` +
          "reachable by a client role or disturbed something else, so the control proves less than it claims.",
      );
    }
    log("NC7 OK: an unclassified new function is unreachable by PUBLIC, anon, authenticated and service_role AND fails the suite.");
  } finally {
    const drop7 = await dockerPsql(container, `DROP FUNCTION IF EXISTS public.${ACL_NC7_FUNCTION}();`);
    if (drop7.code !== 0) throw new Error(`ACL parity lane: could not drop the NC7 probe function: ${drop7.err.trim()}`);
  }
  if ((await aclFullState(container)) !== beforeNc7) {
    throw new Error("ACL parity lane (NC7): the lane is not byte-identical to its pre-control state after clean-up.");
  }

  // ── 9. NC6c — a grantee nobody named, arriving AFTER the migration ────────
  // The migration refuses an unreviewed default grantee it finds (NC6b), but
  // nothing stops a LATER statement adding one. CI must catch it: the allowlist
  // assertions fail, while the named-role checks stay green — which is exactly
  // the blind spot the allowlist form closes.
  const beforeNc6c = await aclFullState(container);
  const nc6c = await dockerPsql(container,
    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO authenticator;\n" +
      "GRANT SELECT ON TABLE public.tags TO authenticator;\n");
  if (nc6c.code !== 0) {
    throw new Error(`ACL parity lane (NC6c): could not inject the third-party grants: ${nc6c.err.trim() || "(no stderr)"}`);
  }
  try {
    const flagged = await runAclMatrixSuite();
    assertAclSuiteFailed("NC6c (third-party grantee after the migration)", flagged, ["ACL-B6", "ACL-G6", "ACL-G4"]);
    const named = flagged.failed.filter((name) => /^ACL-(B1|B2|G1) /.test(name));
    if (named.length > 0) {
      throw new Error(
        `ACL parity lane (NC6c): the named-role checks failed too (${named.join("; ")}), so the injection ` +
          "was not a pure third-party grant and the control proves less than it claims.",
      );
    }
    log("NC6c OK: a third-party grantee added after the migration fails CI through the allowlist assertions; the named-role checks alone stay green.");
  } finally {
    const undo = await dockerPsql(container,
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT ON TABLES FROM authenticator;\n" +
        "REVOKE SELECT ON TABLE public.tags FROM authenticator;\n");
    if (undo.code !== 0) {
      throw new Error(`ACL parity lane (NC6c): could not remove the third-party grants: ${undo.err.trim() || "(no stderr)"}`);
    }
  }
  if ((await aclFullState(container)) !== beforeNc6c) {
    throw new Error("ACL parity lane (NC6c): the lane is not byte-identical to its pre-control state after clean-up.");
  }

  const restored = await runAclMatrixSuite();
  if (!restored.passed) {
    throw new Error("ACL parity lane: suite 015 does not pass again after the NC2, NC7 and NC6c probes were removed.");
  }
  log("hosted-Production ACL parity lane OK.");
}

// ── SERVICE-ROLE-LEAST-PRIVILEGE-HARDENING-001 (C57): starting-shape lane ────
/**
 * WHY THIS LANE EXISTS. `20260929084252_harden_service_role_least_privilege.sql`
 * meets different starting states in different places, and they differ in
 * exactly the privileges it changes — service_role's grant on the insert-order
 * sequence and postgres's `public` default entries:
 *
 *   R  a clean replay through the C56 baseline (`db reset --version
 *      20260928133918`): the pre-C57 state a replay passes through (a full
 *      `db reset` then applies C57 itself);
 *   H  hosted Production, observed read-only on 2026-09-29;
 *   P  hosted Production after Supabase applies its announced revoke of the
 *      TABLES SELECT/INSERT/UPDATE/DELETE and SEQUENCES USAGE/SELECT defaults
 *      to existing projects (supabase/supabase discussion #45329), reproduced
 *      by running those two statements verbatim on top of H.
 *
 * The migration keys its behaviour to that privilege state, never to a date,
 * and every shape must end in the same place. For each shape, from its own
 * reset to the C56 baseline:
 *
 *   1. seed the shape and prove the seed took — H line for line against a
 *      committed read-only reference, every shape by its exact defaults and
 *      sequence grant;
 *   2. prove suite 026 FAILS there (a suite that cannot fail proves nothing);
 *   3. on R, prove the migration REFUSES six unreviewed states before changing
 *      anything, each leaving the lane byte-identical (runAclRefusalControl);
 *   4. apply the real migration file through the CLI;
 *   5. prove the target defaults and sequence grant, and that suites 026 and
 *      015 PASS;
 *   6. prove the canonical privilege state — every relation, column, routine
 *      and default-privilege grant as sorted aclexplode lines, so ACL entry
 *      order never matters — is identical to every other shape's.
 *
 * It runs in the db-tests lifecycle only, after the hosted-parity lane, and
 * adds three resets.
 */
const SVC_MIGRATION = "supabase/migrations/20260929084252_harden_service_role_least_privilege.sql";
const SVC_BASELINE_VERSION = "20260928133918";
const SVC_HOSTED_SEED = "scripts/acl-parity/hosted-service-role-20260928133918.sql";
const SVC_HOSTED_REFERENCE = "scripts/acl-parity/hosted-service-role-20260928133918.reference.json";
const SVC_SUITE = "supabase/tests/database/026_service_role_least_privilege.test.sql";

/** Supabase's statements for existing projects (discussion #45329), verbatim. */
const SVC_PLATFORM_REVOKE_SQL =
  "alter default privileges for role postgres in schema public\n" +
  "  revoke select, insert, update, delete on tables from anon, authenticated, service_role;\n" +
  "alter default privileges for role postgres in schema public\n" +
  "  revoke usage, select on sequences from anon, authenticated, service_role;\n";

/** The shape-defining state, rendered exactly as the migration's section 1e renders it. */
const SVC_SHAPE_SQL =
  "SELECT coalesce((SELECT string_agg(d.defaclobjtype::text || '=' || d.defaclacl::text, ' ' ORDER BY d.defaclobjtype::text COLLATE \"C\") " +
  "FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace), '<none>') " +
  "|| ' seq:service_role=' || coalesce((SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) " +
  "FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.papers_insert_order_seq'::regclass " +
  "AND a.grantee = 'service_role'::regrole), '');";

const SVC_SHAPES = [
  {
    id: "R", what: "a clean replay", hostedSeed: false, platformRevoke: false,
    shape: "S={postgres=rwU/postgres,service_role=w/postgres} f={postgres=X/postgres} " +
      "r={postgres=arwdDxtm/postgres,service_role=Dxtm/postgres} seq:service_role=UPDATE,USAGE",
  },
  {
    id: "H", what: "hosted Production", hostedSeed: true, platformRevoke: false,
    shape: "S={postgres=rwU/postgres,service_role=rwU/postgres} f={postgres=X/postgres,service_role=X/postgres} " +
      "r={postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres} seq:service_role=SELECT,UPDATE,USAGE",
  },
  {
    id: "P", what: "hosted Production after Supabase's announced default-privilege revoke", hostedSeed: true, platformRevoke: true,
    shape: "S={postgres=rwU/postgres,service_role=w/postgres} f={postgres=X/postgres,service_role=X/postgres} " +
      "r={postgres=arwdDxtm/postgres,service_role=Dxtm/postgres} seq:service_role=SELECT,UPDATE,USAGE",
  },
];

/** Where every shape must end. */
const SVC_TARGET_SHAPE = "S={postgres=rwU/postgres} f={postgres=X/postgres} r={postgres=arwdDxtm/postgres} seq:service_role=";

/**
 * States the migration must REFUSE before it changes anything, each one
 * statement away from the clean-replay shape. Same contract as ACL_NC6_CASES:
 * each `refusal` pattern matches the raised error WITH its substituted values,
 * because the CLI echoes the failing statement's source — RAISE texts with `%`
 * placeholders included — after the error.
 */
const SVC_REFUSAL_CASES = [
  {
    id: "SR-NC2",
    what: "an unreviewed extra service_role grant on a table (ai_model_catalog SELECT)",
    inject: "GRANT SELECT ON TABLE public.ai_model_catalog TO service_role;",
    undo: "REVOKE SELECT ON TABLE public.ai_model_catalog FROM service_role;",
    refusal: /ai_model_catalog\|r\|owner=postgres\|authenticated=SELECT\|anon=\|PUBLIC=\|service_role=SELECT/,
  },
  {
    id: "SR-NC3",
    what: "a service_role column grant (profiles.email SELECT)",
    inject: "GRANT SELECT (email) ON TABLE public.profiles TO service_role;",
    undo: "REVOKE SELECT (email) ON TABLE public.profiles FROM service_role;",
    refusal: /the column-level grants in public are not the one reviewed grant: author_identities\.preferred_name:authenticated:UPDATE, profiles\.email:service_role:SELECT/,
  },
  {
    id: "SR-NC4",
    what: "a second routine executable by service_role",
    inject: "GRANT EXECUTE ON FUNCTION public.get_current_user_access() TO service_role;",
    undo: "REVOKE EXECUTE ON FUNCTION public.get_current_user_access() FROM service_role;",
    refusal: /service_role can execute public\.get_current_user_access\(\), public\.refund_ai_quota\(uuid\) in public/,
  },
  {
    id: "SR-NC5",
    what: "an unreviewed TABLES default for service_role (SELECT added to the replay entry)",
    inject: "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO service_role;",
    undo: "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT ON TABLES FROM service_role;",
    refusal: /r=\{postgres=arwdDxtm\/postgres,service_role=rDxtm\/postgres\} seq:service_role=UPDATE,USAGE\) match none of the reviewed starting shapes/,
  },
  {
    id: "SR-NC6",
    what: "a mixed shape (the hosted sequence grant with the replay defaults)",
    inject: "GRANT SELECT ON SEQUENCE public.papers_insert_order_seq TO service_role;",
    undo: "REVOKE SELECT ON SEQUENCE public.papers_insert_order_seq FROM service_role;",
    refusal: /r=\{postgres=arwdDxtm\/postgres,service_role=Dxtm\/postgres\} seq:service_role=SELECT,UPDATE,USAGE\) match none of the reviewed starting shapes/,
  },
  {
    id: "SR-NC7",
    what: "a client-matrix drift (authenticated SELECT on internal_user_access)",
    inject: "GRANT SELECT ON TABLE public.internal_user_access TO authenticated;",
    undo: "REVOKE SELECT ON TABLE public.internal_user_access FROM authenticated;",
    refusal: /internal_user_access\|r\|owner=postgres\|authenticated=SELECT\|anon=\|PUBLIC=\|service_role=DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE/,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// AI-MODEL-CATALOG-REFRESH-001D (C59, Phase D) — populated cutover replay
// ─────────────────────────────────────────────────────────────────────────────
//
// Suite 029 asserts the FINAL seven-row catalog, but it cannot assert the
// PREFERENCE MIGRATION: by the time any pgTAP suite runs, the cutover has
// already replayed against an empty database, so there was nothing to migrate.
// This lane supplies the missing half. It resets to the staged nine-row
// baseline, seeds a saved preference at EVERY level each retiring row ever
// offered, applies the real migration file through the real CLI, and checks
// each mapping exactly — plus the refusal controls, which likewise need a
// pre-cutover database to inject drift into.
const CUT_MIGRATION = "supabase/migrations/20261001092335_cutover_ai_model_catalog_refresh.sql";
const CUT_BASELINE_VERSION = "20260930203613";
const CUT_SUITE = "supabase/tests/database/029_ai_model_catalog_refresh_cutover.test.sql";
const CUT_UID = (n) => `ca700000-0000-0000-0000-0000000000${n}`;
const CUT_VERSION = CUT_MIGRATION.split("/").pop().split("_")[0];

/**
 * The owner-approved mapping, stated as data: old pair in, new pair out.
 *
 * `off` and `none` become Automatic (NULL) because they are exactly the two
 * values the successor models reject; every other level is preserved verbatim.
 * Rows 15 and 16 are unrelated Gemini preferences that must come out
 * byte-identical, and user 17 has no preference row at all.
 */
const CUT_PREF_MATRIX = [
  ["01", "anthropic/claude-sonnet-5", null,      "anthropic/claude-sonnet-5-5", null],
  ["02", "anthropic/claude-sonnet-5", "off",     "anthropic/claude-sonnet-5-5", null],
  ["03", "anthropic/claude-sonnet-5", "low",     "anthropic/claude-sonnet-5-5", "low"],
  ["04", "anthropic/claude-sonnet-5", "medium",  "anthropic/claude-sonnet-5-5", "medium"],
  ["05", "anthropic/claude-sonnet-5", "high",    "anthropic/claude-sonnet-5-5", "high"],
  ["06", "anthropic/claude-sonnet-5", "xhigh",   "anthropic/claude-sonnet-5-5", "xhigh"],
  ["07", "anthropic/claude-sonnet-5", "max",     "anthropic/claude-sonnet-5-5", "max"],
  ["08", "openai/gpt-5.6-terra",      null,      "openai/gpt-6.1-sol",          null],
  ["09", "openai/gpt-5.6-terra",      "none",    "openai/gpt-6.1-sol",          null],
  ["10", "openai/gpt-5.6-terra",      "low",     "openai/gpt-6.1-sol",          "low"],
  ["11", "openai/gpt-5.6-terra",      "medium",  "openai/gpt-6.1-sol",          "medium"],
  ["12", "openai/gpt-5.6-terra",      "high",    "openai/gpt-6.1-sol",          "high"],
  ["13", "openai/gpt-5.6-terra",      "xhigh",   "openai/gpt-6.1-sol",          "xhigh"],
  ["14", "openai/gpt-5.6-terra",      "max",     "openai/gpt-6.1-sol",          "max"],
  ["15", "google/gemini-3.5-flash",   "minimal", "google/gemini-3.5-flash",     "minimal"],
  ["16", "google/gemini-3.8-flash",   null,      "google/gemini-3.8-flash",     null],
];
/** The user with no preference row: a cutover must not invent one. */
const CUT_NO_PREF = "17";

const CUT_OLD_SONNET_ROW =
  `('anthropic/claude-sonnet-5','anthropic','claude-sonnet-5','Claude Sonnet 5',` +
  `true,true,50,ARRAY['off','low','medium','high','xhigh','max'],'off','medium',true)`;
const CUT_OLD_TERRA_ROW =
  `('openai/gpt-5.6-terra','openai','gpt-5.6-terra','GPT-5.6 Terra',` +
  `true,true,60,ARRAY['none','low','medium','high','xhigh','max'],'none','medium',true)`;
const CUT_CATALOG_COLS =
  "(id, provider, provider_model, display_name, enabled, selectable, sort_order, " +
  "reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level, reasoning_selectable)";

/**
 * Every refusal control §24 requires. Each injects ONE unreviewed state into
 * the staged baseline, and the migration must refuse it — naming the
 * precondition it refused on — before changing anything.
 */
const CUT_REFUSAL_CASES = [
  {
    id: "CUT-NC1", what: "a drifted staged Claude Sonnet 5.5 row",
    inject: `UPDATE public.ai_model_catalog SET display_name = 'Claude Sonnet 5.5 (drifted)' WHERE id = 'anthropic/claude-sonnet-5-5';`,
    undo: `UPDATE public.ai_model_catalog SET display_name = 'Claude Sonnet 5.5' WHERE id = 'anthropic/claude-sonnet-5-5';`,
    refusal: /three replacement rows are not in their exact staged state/,
  },
  {
    id: "CUT-NC2", what: "a drifted staged Claude Opus 5.5 reasoning list",
    inject: `UPDATE public.ai_model_catalog SET reasoning_levels = ARRAY['low','medium','high','xhigh'] WHERE id = 'anthropic/claude-opus-5-5';`,
    undo: `UPDATE public.ai_model_catalog SET reasoning_levels = ARRAY['low','medium','high','xhigh','max'] WHERE id = 'anthropic/claude-opus-5-5';`,
    refusal: /three replacement rows are not in their exact staged state/,
  },
  {
    id: "CUT-NC3", what: "a staged GPT-6.1 Sol row already made selectable",
    inject: `UPDATE public.ai_model_catalog SET selectable = true WHERE id = 'openai/gpt-6.1-sol';`,
    undo: `UPDATE public.ai_model_catalog SET selectable = false WHERE id = 'openai/gpt-6.1-sol';`,
    refusal: /three replacement rows are not in their exact staged state/,
  },
  {
    id: "CUT-NC4", what: "a missing old Claude Sonnet 5 row",
    inject: `DELETE FROM public.ai_model_catalog WHERE id = 'anthropic/claude-sonnet-5';`,
    undo: `INSERT INTO public.ai_model_catalog ${CUT_CATALOG_COLS} VALUES ${CUT_OLD_SONNET_ROW};`,
    // The nine-row count is checked first, so a MISSING row refuses there.
    refusal: /catalog holds 8 row\(s\)/,
  },
  {
    id: "CUT-NC5", what: "an old GPT-5.6 Terra row already closed to users",
    inject: `UPDATE public.ai_model_catalog SET selectable = false WHERE id = 'openai/gpt-5.6-terra';`,
    undo: `UPDATE public.ai_model_catalog SET selectable = true WHERE id = 'openai/gpt-5.6-terra';`,
    refusal: /two retiring rows are not in their exact reviewed live state/,
  },
  {
    id: "CUT-NC6", what: "a saved level the retiring row never offered",
    // The table's CHECK allows the whole canonical vocabulary, so `minimal` on
    // a Claude Sonnet 5 preference is storable but unmappable.
    inject:
      `INSERT INTO auth.users (id, email) VALUES ('${CUT_UID("99")}','cut-nc6@paperlume.test') ON CONFLICT DO NOTHING;\n` +
      `INSERT INTO public.user_ai_preferences (user_id, preferred_model_id, preferred_reasoning_level)\n` +
      `VALUES ('${CUT_UID("99")}','anthropic/claude-sonnet-5','minimal')\n` +
      `ON CONFLICT (user_id) DO UPDATE SET preferred_model_id = EXCLUDED.preferred_model_id,\n` +
      `  preferred_reasoning_level = EXCLUDED.preferred_reasoning_level;`,
    undo: `DELETE FROM auth.users WHERE id = '${CUT_UID("99")}';`,
    refusal: /Claude Sonnet 5 preference\(s\) carry a level that row never offered/,
  },
  {
    id: "CUT-NC7", what: "an unexpected tenth catalog row",
    inject:
      `INSERT INTO public.ai_model_catalog ${CUT_CATALOG_COLS} VALUES\n` +
      `('google/gemini-9.9-flash','google','gemini-9.9-flash','Gemini 9.9 Flash',\n` +
      ` true,true,95,ARRAY['low','medium','high'],'low','medium',true);`,
    undo: `DELETE FROM public.ai_model_catalog WHERE id = 'google/gemini-9.9-flash';`,
    refusal: /catalog holds 10 row\(s\)/,
  },
];

/** The whole catalog as one comparable string: id, flags, sort and metadata. */
const CUT_CATALOG_STATE_SQL =
  "SELECT COALESCE(string_agg(id || '|' || provider || '|' || provider_model || '|' || display_name || '|' || " +
  "enabled::text || '|' || selectable::text || '|' || reasoning_selectable::text || '|' || sort_order::text || '|' || " +
  "array_to_string(reasoning_levels, ',') || '|' || auto_analyze_reasoning_level || '|' || " +
  "auto_suggest_reasoning_level, E'\\n' ORDER BY sort_order, id), '(empty)') FROM public.ai_model_catalog;";

/** Every saved preference as one comparable string, including updated_at. */
const CUT_PREF_STATE_SQL =
  "SELECT COALESCE(string_agg(user_id::text || '=' || preferred_model_id || ':' || " +
  "COALESCE(preferred_reasoning_level, 'AUTOMATIC') || '@' || updated_at::text, E'\\n' ORDER BY user_id), '(none)') " +
  "FROM public.user_ai_preferences;";

/** Reset to the staged baseline and confirm the cutover is still pending. */
async function cutResetToBaseline(tag) {
  const code = await runInherit(
    "supabase",
    ["db", "reset", "--local", "--no-seed", "--version", CUT_BASELINE_VERSION],
  );
  if (code !== 0) throw new Error(`${tag}: \`supabase db reset --version ${CUT_BASELINE_VERSION}\` failed.`);
  const container = await resolveLocalDbContainer();
  const at = await dbScalar(container, "SELECT max(version) FROM supabase_migrations.schema_migrations;");
  if (at !== CUT_BASELINE_VERSION) {
    throw new Error(`${tag}: expected the ledger at ${CUT_BASELINE_VERSION}, found ${at}.`);
  }
  const pending = await dbScalar(container,
    `SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '${CUT_VERSION}';`);
  if (pending !== "0") throw new Error(`${tag}: the cutover ${CUT_VERSION} is already in the ledger.`);
  const nine = await dbScalar(container, "SELECT count(*)::text FROM public.ai_model_catalog;");
  if (nine !== "9") throw new Error(`${tag}: the staged baseline holds ${nine} catalog rows, expected 9.`);
  return container;
}

/** One refusal control: inject, require a named refusal, prove nothing moved. */
async function runCutoverRefusalControl(container, c) {
  const clean = await dbScalar(container, CUT_CATALOG_STATE_SQL);
  const cleanPrefs = await dbScalar(container, CUT_PREF_STATE_SQL);
  const inject = await dockerPsql(container, c.inject);
  if (inject.code !== 0) {
    throw new Error(`catalog cutover lane (${c.id}): could not inject ${c.what}: ${inject.err.trim() || "(no stderr)"}`);
  }
  try {
    const injected = await dbScalar(container, CUT_CATALOG_STATE_SQL);
    const injectedPrefs = await dbScalar(container, CUT_PREF_STATE_SQL);
    // A control that changed nothing would "pass" while proving nothing. Some
    // cases drift the catalog and one drifts a preference, so the guard is that
    // SOMETHING moved — not that a particular table did.
    if (injected === clean && injectedPrefs === cleanPrefs) {
      throw new Error(`catalog cutover lane (${c.id}): the injection changed neither the catalog nor any preference, so the control would prove nothing.`);
    }
    const up = await runCapture("supabase", ["migration", "up", "--local"]);
    const said = `${up.out}\n${up.err}`;
    if (up.code === 0) {
      throw new Error(`catalog cutover lane (${c.id}): the migration ACCEPTED ${c.what}. It must refuse it before changing anything.`);
    }
    if (!c.refusal.test(said)) {
      throw new Error(
        `catalog cutover lane (${c.id}): the migration failed, but not with the expected precondition refusal — ` +
          `it failed for the wrong reason:\n${said.trim().split("\n").slice(-6).join("\n")}`,
      );
    }
    const inLedger = await dbScalar(container,
      `SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '${CUT_VERSION}';`);
    if (inLedger !== "0") {
      throw new Error(`catalog cutover lane (${c.id}): the refused migration ${CUT_VERSION} is in the ledger.`);
    }
    if ((await dbScalar(container, CUT_CATALOG_STATE_SQL)) !== injected) {
      throw new Error(`catalog cutover lane (${c.id}): the refused migration still changed the catalog — it did not roll back as one transaction.`);
    }
    if ((await dbScalar(container, CUT_PREF_STATE_SQL)) !== injectedPrefs) {
      throw new Error(`catalog cutover lane (${c.id}): the refused migration still rewrote a preference — it did not roll back as one transaction.`);
    }
  } finally {
    const undo = await dockerPsql(container, c.undo);
    if (undo.code !== 0) {
      throw new Error(`catalog cutover lane (${c.id}): could not remove the injected state: ${undo.err.trim() || "(no stderr)"}`);
    }
  }
  if ((await dbScalar(container, CUT_CATALOG_STATE_SQL)) !== clean) {
    throw new Error(`catalog cutover lane (${c.id}): the catalog is not byte-identical to its pre-control state after clean-up.`);
  }
  if ((await dbScalar(container, CUT_PREF_STATE_SQL)) !== cleanPrefs) {
    throw new Error(`catalog cutover lane (${c.id}): a preference row survived the control's clean-up.`);
  }
  log(`${c.id} OK: the migration refused ${c.what} before any change — not in the ledger, catalog and preferences untouched.`);
}

/**
 * The lane. Resets to a migration baseline and replays forward, so it runs
 * after everything that needs the fully-migrated schema.
 */
async function runCatalogCutoverLane() {
  log("running AI model catalog cutover lane (AI-MODEL-CATALOG-REFRESH-001D)…");

  for (const rel of [CUT_MIGRATION, CUT_SUITE]) {
    if (!existsSync(resolve(ROOT, rel))) throw new Error(`catalog cutover lane: missing ${rel}.`);
  }
  if (!(CUT_VERSION > CUT_BASELINE_VERSION)) {
    throw new Error(`catalog cutover lane: ${CUT_VERSION} is not after the baseline ${CUT_BASELINE_VERSION}.`);
  }

  // ── 1. Populated replay: every level each retiring row ever offered ───────
  let container = await cutResetToBaseline("catalog cutover lane (populated)");

  const users = [...CUT_PREF_MATRIX.map(([n]) => n), CUT_NO_PREF];
  let seed = users
    .map((n) => `INSERT INTO auth.users (id, email) VALUES ('${CUT_UID(n)}','cut-${n}@paperlume.test') ON CONFLICT DO NOTHING;`)
    .join("\n");
  seed += "\n" + CUT_PREF_MATRIX
    .map(([n, model, level]) =>
      `INSERT INTO public.user_ai_preferences (user_id, preferred_model_id, preferred_reasoning_level) ` +
      `VALUES ('${CUT_UID(n)}','${model}',${level === null ? "NULL" : `'${level}'`});`)
    .join("\n");
  const seeded = await dockerPsql(container, seed);
  if (seeded.code !== 0) throw new Error(`catalog cutover lane: seeding the preference matrix failed: ${seeded.err.trim() || "(no stderr)"}`);

  const seededCount = await dbScalar(container, "SELECT count(*)::text FROM public.user_ai_preferences;");
  if (seededCount !== String(CUT_PREF_MATRIX.length)) {
    throw new Error(`catalog cutover lane: seeded ${seededCount} preferences, expected ${CUT_PREF_MATRIX.length}.`);
  }
  // The two rows that must come out byte-identical, updated_at included.
  const untouchedBefore = await dbScalar(container,
    "SELECT COALESCE(string_agg(user_id::text || '=' || preferred_model_id || ':' || " +
    "COALESCE(preferred_reasoning_level,'AUTOMATIC') || '@' || updated_at::text, E'\\n' ORDER BY user_id), '(none)') " +
    `FROM public.user_ai_preferences WHERE user_id IN ('${CUT_UID("15")}','${CUT_UID("16")}');`);
  log(`catalog cutover lane: seeded ${seededCount} preferences across ${users.length} accounts (one with none).`);

  // ── 2. Apply the real migration file, through the real CLI path ───────────
  const upCode = await runInherit("supabase", ["migration", "up", "--local"]);
  if (upCode !== 0) throw new Error("catalog cutover lane: `supabase migration up --local` failed on the populated database.");
  const applied = await dbScalar(container,
    `SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '${CUT_VERSION}';`);
  if (applied !== "1") throw new Error(`catalog cutover lane: ${CUT_VERSION} is not in the ledger after \`migration up\`.`);

  // ── 3. Every mapping, exactly ─────────────────────────────────────────────
  const want = CUT_PREF_MATRIX
    .map(([n, , , model, level]) => `${CUT_UID(n)}=${model}:${level === null ? "AUTOMATIC" : level}`)
    .sort()
    .join("\n");
  const got = await dbScalar(container,
    "SELECT COALESCE(string_agg(user_id::text || '=' || preferred_model_id || ':' || " +
    "COALESCE(preferred_reasoning_level,'AUTOMATIC'), E'\\n' ORDER BY user_id), '(none)') FROM public.user_ai_preferences;");
  if (got !== want) {
    const a = want.split("\n");
    const b = got.split("\n");
    throw new Error(
      "catalog cutover lane: the migrated preferences are not the approved mapping.\n" +
        `  missing: ${a.filter((l) => !b.includes(l)).join(" ; ") || "none"}\n` +
        `  extra:   ${b.filter((l) => !a.includes(l)).join(" ; ") || "none"}`,
    );
  }
  log(`catalog cutover lane: all ${CUT_PREF_MATRIX.length} preference mappings exact (off -> Automatic, none -> Automatic, every other level preserved).`);

  // Unrelated Gemini preferences are byte-identical, `updated_at` included, so
  // the BEFORE UPDATE timestamp trigger fired only on the migrated rows.
  const untouchedAfter = await dbScalar(container,
    "SELECT COALESCE(string_agg(user_id::text || '=' || preferred_model_id || ':' || " +
    "COALESCE(preferred_reasoning_level,'AUTOMATIC') || '@' || updated_at::text, E'\\n' ORDER BY user_id), '(none)') " +
    `FROM public.user_ai_preferences WHERE user_id IN ('${CUT_UID("15")}','${CUT_UID("16")}');`);
  if (untouchedAfter !== untouchedBefore) {
    throw new Error(
      "catalog cutover lane: an unrelated Gemini preference was rewritten (updated_at included):\n" +
        `  before: ${untouchedBefore}\n  after:  ${untouchedAfter}`,
    );
  }
  log("catalog cutover lane: unrelated Gemini preferences byte-identical, updated_at included.");

  // Nobody gained a row, and the user who had none still has none.
  const afterCount = await dbScalar(container, "SELECT count(*)::text FROM public.user_ai_preferences;");
  if (afterCount !== String(CUT_PREF_MATRIX.length)) {
    throw new Error(`catalog cutover lane: preference count moved ${CUT_PREF_MATRIX.length} -> ${afterCount}.`);
  }
  const noPref = await dbScalar(container,
    `SELECT count(*)::text FROM public.user_ai_preferences WHERE user_id = '${CUT_UID(CUT_NO_PREF)}';`);
  if (noPref !== "0") throw new Error("catalog cutover lane: the cutover invented a preference for an account that had none.");

  // ── 4. The resulting catalog, and the suite that owns it ─────────────────
  const shape = await dbScalar(container,
    "SELECT count(*)::text || '|' || " +
    "(SELECT count(*)::text FROM public.ai_model_catalog WHERE enabled AND selectable AND reasoning_selectable) || '|' || " +
    "(SELECT count(*)::text FROM public.ai_model_catalog WHERE id IN ('anthropic/claude-sonnet-5','openai/gpt-5.6-terra')) " +
    "FROM public.ai_model_catalog;");
  if (shape !== "7|7|0") {
    throw new Error(`catalog cutover lane: after the cutover the catalog is ${shape}, expected 7|7|0 (rows|fully-open|retired-survivors).`);
  }
  const suite = await runDbSuite(CUT_SUITE);
  if (!suite.passed) {
    throw new Error(
      `catalog cutover lane: ${CUT_SUITE} fails against the populated cutover ` +
        `(${suite.failed.slice(0, 6).join("; ") || "no assertion named"}).`,
    );
  }
  log("catalog cutover lane: suite 029 passes against the POPULATED cutover, not only an empty replay.");

  // ── 5. Refusal controls, each on a fresh staged baseline ─────────────────
  for (const c of CUT_REFUSAL_CASES) {
    container = await cutResetToBaseline(`catalog cutover lane (${c.id})`);
    await runCutoverRefusalControl(container, c);
  }

  // ── 6. Leave the database fully migrated for anything that follows ───────
  const finalReset = await runInherit("supabase", ["db", "reset", "--local", "--no-seed"]);
  if (finalReset !== 0) throw new Error("catalog cutover lane: the final full reset failed.");
  const finalContainer = await resolveLocalDbContainer();
  const finalShape = await dbScalar(finalContainer, "SELECT count(*)::text FROM public.ai_model_catalog;");
  if (finalShape !== "7") throw new Error(`catalog cutover lane: the clean replay ends with ${finalShape} catalog rows, expected 7.`);
  log(`catalog cutover lane OK: ${CUT_PREF_MATRIX.length} mappings exact, ${CUT_REFUSAL_CASES.length} refusal controls, clean replay ends at seven rows.`);
}


/** Every grant in public and every default-privilege entry, as order-free canonical lines. */
const SVC_CANONICAL_STATE_SQL = [
  "SELECT 'ledger|' || count(*) || '|' || max(version) FROM supabase_migrations.schema_migrations;",
  "SELECT 'rel|' || c.relname || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END " +
    "|| '|' || a.privilege_type || '|' || a.is_grantable::text || '|' || pg_get_userbyid(a.grantor) " +
    "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, " +
    "aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::\"char\" ELSE 'r'::\"char\" END, c.relowner))) a " +
    "WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S');",
  "SELECT 'col|' || c.relname || '.' || att.attname || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END " +
    "|| '|' || a.privilege_type FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid " +
    "JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(att.attacl) a " +
    "WHERE n.nspname = 'public' AND att.attacl IS NOT NULL;",
  "SELECT 'fn|' || p.oid::regprocedure::text || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END " +
    "|| '|' || a.privilege_type || '|' || a.is_grantable::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, " +
    "aclexplode(coalesce(p.proacl, acldefault('f'::\"char\", p.proowner))) a WHERE n.nspname = 'public';",
  "SELECT 'def|' || pg_get_userbyid(d.defaclrole) || '|' || coalesce(n.nspname, '<global>') || '|' || d.defaclobjtype::text " +
    "|| '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || '|' || a.privilege_type " +
    "|| '|' || a.is_grantable::text FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a;",
].join("\n");

async function runServiceRoleParityLane() {
  log("running service_role starting-shape lane (SERVICE-ROLE-LEAST-PRIVILEGE-HARDENING-001)…");

  for (const rel of [SVC_MIGRATION, SVC_HOSTED_SEED, SVC_HOSTED_REFERENCE, SVC_SUITE, ACL_MATRIX_SUITE]) {
    if (!existsSync(resolve(ROOT, rel))) throw new Error(`service_role lane: missing ${rel}.`);
  }
  const svcVersion = SVC_MIGRATION.split("/").pop().split("_")[0];
  if (!(svcVersion > SVC_BASELINE_VERSION)) {
    throw new Error(`service_role lane: ${svcVersion} is not after the baseline ${SVC_BASELINE_VERSION}.`);
  }
  const reference = JSON.parse(readFileSync(resolve(ROOT, SVC_HOSTED_REFERENCE), "utf-8"));

  let converged = null;
  for (const shape of SVC_SHAPES) {
    const tag = `service_role lane (${shape.id})`;

    // ── 1. Back to the C56 baseline, then seed the shape and prove it took ──
    const resetCode = await runInherit(
      "supabase",
      ["db", "reset", "--local", "--no-seed", "--version", SVC_BASELINE_VERSION],
    );
    if (resetCode !== 0) throw new Error(`${tag}: \`supabase db reset --version\` failed.`);
    const container = await resolveLocalDbContainer();
    const atBaseline = await dbScalar(container, "SELECT max(version) FROM supabase_migrations.schema_migrations;");
    if (atBaseline !== SVC_BASELINE_VERSION) {
      throw new Error(`${tag}: expected the ledger at ${SVC_BASELINE_VERSION}, found ${atBaseline}.`);
    }
    if (shape.hostedSeed) {
      const seed = await dockerPsql(container, readFileSync(resolve(ROOT, SVC_HOSTED_SEED), "utf-8"));
      if (seed.code !== 0) throw new Error(`${tag}: the hosted-Production seed failed: ${seed.err.trim() || "(no stderr)"}`);
      for (const key of ["relacl", "proacl", "default_acl"]) {
        const actual = await aclDump(container, ACL_DUMP_SQL[key]);
        const expected = [...reference[key]].sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          const missing = expected.filter((l) => !actual.includes(l)).slice(0, 3);
          const extra = actual.filter((l) => !expected.includes(l)).slice(0, 3);
          throw new Error(
            `${tag}: after seeding, ${key} does not match hosted Production (${actual.length} rows vs ${expected.length}). ` +
              `Missing: ${missing.join(" ; ") || "none"}. Unexpected: ${extra.join(" ; ") || "none"}.`,
          );
        }
      }
      log(`${tag}: hosted-Production seed verified against ${SVC_HOSTED_REFERENCE} (relations, routines, default privileges).`);
    }
    if (shape.platformRevoke) {
      const revoke = await dockerPsql(container, SVC_PLATFORM_REVOKE_SQL);
      if (revoke.code !== 0) throw new Error(`${tag}: Supabase's documented revoke failed: ${revoke.err.trim() || "(no stderr)"}`);
    }
    const found = await dbScalar(container, SVC_SHAPE_SQL);
    if (found !== shape.shape) {
      throw new Error(`${tag}: the starting state is not ${shape.what}:\n  found:    ${found}\n  expected: ${shape.shape}`);
    }
    log(`${tag}: starting shape reproduced — ${shape.what}.`);

    // ── 2. Suite 026 must fail here ─────────────────────────────────────────
    // Trailing spaces: "A1 " must not be satisfied by A10-A12 failing.
    assertAclSuiteFailed(`${tag} SR-NC1 (pre-migration)`, await runDbSuite(SVC_SUITE),
      ["A1 ", "A2 ", "A7 ", "B1 ", "C1 "], "suite 026");
    log(`${tag} SR-NC1 OK: suite 026 fails before the migration.`);

    // ── 3. Refusals, on the clean-replay shape ──────────────────────────────
    if (shape.id === "R") {
      for (const c of SVC_REFUSAL_CASES) await runAclRefusalControl(container, svcVersion, c);
    }

    // ── 4. Apply the real migration file, through the real CLI path ─────────
    const upCode = await runInherit("supabase", ["migration", "up", "--local"]);
    if (upCode !== 0) throw new Error(`${tag}: \`supabase migration up --local\` failed.`);
    const applied = await dbScalar(container,
      `SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '${svcVersion}';`);
    if (applied !== "1") throw new Error(`${tag}: migration ${svcVersion} is not in the local ledger after \`migration up\`.`);

    // ── 5. The target, and both suites ──────────────────────────────────────
    const after = await dbScalar(container, SVC_SHAPE_SQL);
    if (after !== SVC_TARGET_SHAPE) {
      throw new Error(`${tag}: after the migration the defaults and sequence grant are ${after}, expected ${SVC_TARGET_SHAPE}.`);
    }
    for (const suite of [SVC_SUITE, ACL_MATRIX_SUITE]) {
      const result = await runDbSuite(suite);
      if (!result.passed) {
        throw new Error(`${tag}: ${suite} fails after the migration (${result.failed.slice(0, 6).join("; ") || "no assertion named"}).`);
      }
    }

    // ── 6. Every shape converges on one privilege state ──────────────────────
    const state = (await aclDump(container, SVC_CANONICAL_STATE_SQL)).join("\n");
    if (converged === null) {
      converged = { from: shape.id, state };
    } else if (state !== converged.state) {
      const a = converged.state.split("\n");
      const b = state.split("\n");
      const onlyThere = a.filter((l) => !b.includes(l)).slice(0, 4);
      const onlyHere = b.filter((l) => !a.includes(l)).slice(0, 4);
      throw new Error(
        `${tag}: the end state differs from shape ${converged.from}'s. ` +
          `Only in ${converged.from}: ${onlyThere.join(" ; ") || "none"}. Only in ${shape.id}: ${onlyHere.join(" ; ") || "none"}.`,
      );
    }
    log(`${tag} OK: converged${converged.from === shape.id ? "" : ` on shape ${converged.from}'s exact privilege state`}; suites 026 and 015 pass.`);
  }
  log("service_role starting-shape lane OK: R, H and P converge on one privilege state.");
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
    // AI-MULTI-PROVIDER-001D: every telemetry fixture lives inside a rolled-back
    // suite transaction, so a surviving event means one escaped.
    "(SELECT count(*) FROM public.ai_provider_usage_events) || '|' || " +
    // EVIDENCE-RECORDS-001A1: every study-record fixture lives inside a
    // rolled-back suite transaction or is removed by its probe.
    "((SELECT count(*) FROM public.evidence_studies) + (SELECT count(*) FROM public.evidence_study_reports) + " +
    "(SELECT count(*) FROM public.evidence_source_snapshots) + (SELECT count(*) FROM public.evidence_arms) + " +
    "(SELECT count(*) FROM public.evidence_outcomes) + (SELECT count(*) FROM public.evidence_field_values) + " +
    "(SELECT count(*) FROM public.evidence_field_anchors) + (SELECT count(*) FROM public.evidence_events)) || '|' || " +
    "(SELECT count(*) FROM pg_locks WHERE locktype='advisory');")).split("|").map((s) => parseInt(s, 10));
  if (counts.some((c) => c !== 0)) {
    throw new Error(`residue detected (users|papers|projects|tags|presets|attachments|entitlements|counters|storage|access|cleanup|tombstone|usage_events|evidence|advisory = ${counts.join("|")}).`);
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
    await runEvidenceForeignKeyRaceProbe(container);
    await runEvidenceLifecycleRaceProbe(container);
    await runEvidenceFieldRaceProbe(container);
    await runPreferenceLockProbe(container);
    await runAclParityProbe(container);
    await runMigrationCutoverProbe(container);
    await assertNoResidue(container, pgtapBefore, catalogBefore);

    // DATA-API-ACL-RECONCILIATION-001. Runs LAST because it resets the database
    // to a migration baseline and replays forward: everything above needs the
    // fully-migrated schema, and its own residue proof must not see this lane's
    // deliberate reset.
    await runHostedAclParityLane();

    // SERVICE-ROLE-LEAST-PRIVILEGE-HARDENING-001 (C57). Resets to its own
    // baseline three times, so it runs after everything that needs the
    // fully-migrated schema.
    await runServiceRoleParityLane();

    // AI-MODEL-CATALOG-REFRESH-001D (C59). Resets to the staged nine-row
    // baseline and replays forward nine times (once populated, seven refusal
    // controls, then a clean full replay), so it runs after everything that
    // needs the fully-migrated schema.
    await runCatalogCutoverLane();

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
